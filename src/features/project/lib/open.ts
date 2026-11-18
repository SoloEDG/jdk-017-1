import type { Asset, Edge, Projection } from "../../../shared/types";
import { decodeAsset } from "../../asset/lib/decode";
import { ProjectError } from "./errors";
import { NORMALIZE_VERSION, type AssetRef, type ProjectManifest } from "./manifest";
import { pngToImageData, thumbnailFromImageData } from "./pixels";
import { contentHash } from "./sha256";
import {
  substituteAssetRef,
  type StagedArchive,
  type Substitution,
} from "./unpack";

/** 校验完成、等待用户确认后一次性提交的工作区候选 */
export interface StagedProject {
  manifest: ProjectManifest;
  name: string;
  asset: Asset;
  projection: Projection;
  edge: Edge;
  previewUrl: string | null;
  warnings: string[];
  substitutions: Substitution[];
}

async function decodeAssetRef(
  ref: AssetRef,
  bytes: Uint8Array,
): Promise<Asset> {
  if (ref.kind === "pixels") {
    const data = await pngToImageData(bytes, ref.width, ref.height);
    return {
      id: crypto.randomUUID(),
      name: ref.name,
      width: data.width,
      height: data.height,
      data,
      thumbnail: thumbnailFromImageData(data),
      hash: ref.hash,
    };
  }
  // encoded：走与首次导入完全相同的规范化管线，保证工作像素一致
  let asset: Asset;
  try {
    asset = await decodeAsset(
      new Blob([bytes as BlobPart], { type: ref.mime }),
      ref.name,
    );
  } catch (e) {
    throw new ProjectError(
      "asset-decode",
      `素材「${ref.name}」无法解码：${e instanceof Error ? e.message : "未知错误"}`,
    );
  }
  if (
    !asset.source ||
    asset.source.width !== ref.width ||
    asset.source.height !== ref.height
  )
    throw new ProjectError(
      "asset-dimensions",
      `素材「${ref.name}」解码尺寸与工程记录不符`,
    );
  asset.hash = ref.hash;
  return asset;
}

/**
 * 把校验通过的暂存区解码为完整的工作区候选。
 * 到这一步仍不触碰当前工作区；任何失败都会保留原作品。
 */
export async function decodeStaged(staged: StagedArchive): Promise<StagedProject> {
  const { manifest } = staged;
  const ref = manifest.assets.find((a) => a.hash === manifest.activeAsset);
  if (!ref)
    throw new ProjectError("bad-manifest", "当前素材引用不存在于素材列表");
  const bytes = staged.assetBytes.get(ref.hash);
  if (!bytes)
    throw new ProjectError("asset-missing", `缺少素材「${ref.name}」`);
  const asset = await decodeAssetRef(ref, bytes);
  return {
    manifest,
    name: manifest.name,
    asset,
    projection: { ...manifest.projection },
    edge: { ...manifest.edge },
    previewUrl: staged.previewBytes
      ? URL.createObjectURL(new Blob([staged.previewBytes as BlobPart]))
      : null,
    warnings: [...staged.warnings],
    substitutions: [...staged.substitutions],
  };
}

export interface RebindResult {
  /** true 表示新内容指纹与记录一致（修复）；false 表示用户显式换了图（替换） */
  identical: boolean;
  name: string;
}

/**
 * 用户主动重新绑定损坏/缺失的素材。
 * 指纹一致 = 找回原内容；指纹不同 = 显式替换，记录进 substitutions，
 * 在确认卡片上明确展示，绝不静默换图。
 */
export async function rebindAsset(
  staged: StagedArchive,
  expectedHash: string,
  file: File,
): Promise<RebindResult> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const actualHash = await contentHash(bytes);
  const oldRef = staged.manifest.assets.find((a) => a.hash === expectedHash);
  if (!oldRef)
    throw new ProjectError("bad-manifest", "找不到需要重新绑定的素材记录");

  // 先验证用户给的图片能正常解码、尺寸合法，再动暂存区
  let probe: Asset;
  try {
    probe = await decodeAsset(file, file.name);
  } catch (e) {
    throw new ProjectError(
      "asset-decode",
      `重新绑定的图片无法读取：${e instanceof Error ? e.message : "未知错误"}`,
    );
  }

  const identical = actualHash === expectedHash;
  if (!identical) {
    const ref: AssetRef = {
      role: "source",
      hash: actualHash,
      name: file.name,
      kind: "encoded",
      mime: probe.source?.mime || file.type || "application/octet-stream",
      width: probe.source?.width ?? probe.width,
      height: probe.source?.height ?? probe.height,
      bytes: bytes.length,
      normalizeVersion: NORMALIZE_VERSION,
    };
    substituteAssetRef(staged, expectedHash, ref);
  }
  staged.assetBytes.set(actualHash, bytes);
  staged.problems = staged.problems.filter((p) => p.hash !== expectedHash);
  return { identical, name: file.name };
}
