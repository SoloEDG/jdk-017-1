import { ProjectError } from "./errors";
import {
  MANIFEST_NAME,
  PREVIEW_NAME,
  parseManifest,
  type AssetRef,
  type ProjectManifest,
} from "./manifest";
import { contentHash } from "./sha256";
import { hashToHex } from "./store";
import { ZipReader } from "./zip";

/** 素材校验问题：缺图或指纹不符，可由用户重新绑定修复 */
export interface AssetProblem {
  code: "asset-missing" | "asset-corrupt";
  hash: string;
  name: string;
  detail: string;
}

/** 用户主动重新绑定产生的替换记录（绝不静默换图，全部可见） */
export interface Substitution {
  fromHash: string;
  toHash: string;
  name: string;
}

/**
 * 暂存区：打开工程时先在这里完成全部结构/引用/完整性校验，
 * 只有完全成功才会被提交到工作区；任何失败都不影响当前作品。
 */
export interface StagedArchive {
  manifest: ProjectManifest;
  /** 校验通过的素材字节，key 为内容指纹 */
  assetBytes: Map<string, Uint8Array>;
  previewBytes: Uint8Array | null;
  problems: AssetProblem[];
  warnings: string[];
  substitutions: Substitution[];
}

function uniqueAssetRefs(manifest: ProjectManifest): AssetRef[] {
  const seen = new Set<string>();
  const out: AssetRef[] = [];
  for (const ref of manifest.assets) {
    if (seen.has(ref.hash)) continue;
    seen.add(ref.hash);
    out.push(ref);
  }
  return out;
}

/**
 * 解析并校验工程包：ZIP 结构 → 清单 → 逐素材指纹校验。
 * 结构性错误（坏包、超大解压体积、未知版本）直接抛出；
 * 素材级问题（缺图、指纹不符）收集到 problems，等待用户重新绑定。
 */
export async function stageArchive(bytes: Uint8Array): Promise<StagedArchive> {
  const zip = new ZipReader(bytes);

  if (!zip.has(MANIFEST_NAME))
    throw new ProjectError("bad-manifest", "工程描述缺失，不是有效的 ORBIT 工程");
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(zip.read(MANIFEST_NAME)));
  } catch (e) {
    if (e instanceof ProjectError) throw e;
    throw new ProjectError("bad-manifest", "工程描述不是有效的 JSON");
  }
  const manifest = parseManifest(json);

  const staged: StagedArchive = {
    manifest,
    assetBytes: new Map(),
    previewBytes: null,
    problems: [],
    warnings: [],
    substitutions: [],
  };

  // 预览缩略图：损坏不阻塞打开，降级为警告（不影响作品本身）
  if (manifest.preview) {
    if (!zip.has(PREVIEW_NAME)) {
      staged.warnings.push("预览缩略图缺失，打开后不显示保存时的预览");
    } else {
      try {
        const data = zip.read(PREVIEW_NAME);
        if ((await contentHash(data)) !== manifest.preview.hash)
          staged.warnings.push("预览缩略图校验失败，已忽略");
        else staged.previewBytes = data;
      } catch (e) {
        if (e instanceof ProjectError)
          staged.warnings.push(`预览缩略图读取失败（${e.message}），已忽略`);
        else throw e;
      }
    }
  }

  // 素材：内容寻址校验，重复引用只验证一次；
  // 读取/校验失败都转为可重新绑定的问题，而不是整体拒绝
  for (const ref of uniqueAssetRefs(manifest)) {
    const entryName = zip.findAssetEntry(hashToHex(ref.hash));
    if (!entryName) {
      staged.problems.push({
        code: "asset-missing",
        hash: ref.hash,
        name: ref.name,
        detail: `缺少素材「${ref.name}」（指纹 ${shortHash(ref.hash)}…）`,
      });
      continue;
    }
    try {
      const data = zip.read(entryName);
      if (data.length !== ref.bytes) {
        staged.problems.push({
          code: "asset-corrupt",
          hash: ref.hash,
          name: ref.name,
          detail: `素材「${ref.name}」体积与记录不符，可能已损坏`,
        });
        continue;
      }
      if ((await contentHash(data)) !== ref.hash) {
        staged.problems.push({
          code: "asset-corrupt",
          hash: ref.hash,
          name: ref.name,
          detail: `素材「${ref.name}」内容指纹校验失败，可能已损坏`,
        });
        continue;
      }
      staged.assetBytes.set(ref.hash, data);
    } catch (e) {
      if (e instanceof ProjectError) {
        staged.problems.push({
          code: "asset-corrupt",
          hash: ref.hash,
          name: ref.name,
          detail: `素材「${ref.name}」读取失败（${e.message}）`,
        });
        continue;
      }
      throw e;
    }
  }
  return staged;
}

/**
 * 用用户选择的新内容替换素材引用（显式重新绑定）。
 * 更新清单中所有引用旧指纹的位置，并留下可见的替换记录。
 */
export function substituteAssetRef(
  staged: StagedArchive,
  fromHash: string,
  ref: AssetRef,
): void {
  const m = staged.manifest;
  m.assets = m.assets.map((a) => (a.hash === fromHash ? { ...ref } : a));
  if (m.activeAsset === fromHash) m.activeAsset = ref.hash;
  staged.substitutions.push({ fromHash, toHash: ref.hash, name: ref.name });
}

export const shortHash = (hash: string): string => hash.slice(7, 15);
