import type { StudioDocument } from "../../../shared/types";
import { renderPreview } from "../../projection";
import { ProjectError } from "./errors";
import {
  ENCODED_MAX_BYTES,
  MANIFEST_NAME,
  NORMALIZE_VERSION,
  PREVIEW_NAME,
  PREVIEW_SIZE,
  PROJECT_EXTENSION,
  createManifest,
  type AssetRef,
  type PayloadKind,
  type ProjectManifest,
} from "./manifest";
import { imageDataToPng, canvasToPngBytes } from "./pixels";
import { ContentStore, assetEntryName } from "./store";
import { createZip, type ZipFileInput } from "./zip";

export type PayloadPreference = "auto" | PayloadKind;

export interface SaveResult {
  blob: Blob;
  fileName: string;
  manifest: ProjectManifest;
  kind: PayloadKind;
  totalBytes: number;
  warnings: string[];
}

const EMBEDDABLE_MIMES = new Set(["image/jpeg", "image/png", "image/webp"]);

/**
 * 存储策略取舍（详见 docs/project-format.md）：
 * - encoded 保存原始编码字节：体积小、保留原图全部信息，重开时经同一
 *   规范化管线还原工作像素（同浏览器内结果确定）；
 * - pixels 保存工作分辨率无损 PNG：体积大，但重新打开后像素位精确一致，
 *   重新导出与保存时完全吻合。
 * 自动策略：原始编码可嵌入且 ≤ 16 MB 时选 encoded，否则选 pixels。
 */
export function choosePayloadKind(
  doc: StudioDocument,
  preference: PayloadPreference,
  warnings: string[],
): PayloadKind {
  const source = doc.asset?.source;
  const embeddable =
    !!source &&
    EMBEDDABLE_MIMES.has(source.mime) &&
    source.bytes.byteLength <= ENCODED_MAX_BYTES;
  if (preference === "encoded") {
    if (!source) {
      warnings.push("当前素材没有原始编码可嵌入，已改用规范化像素存储");
      return "pixels";
    }
    if (!EMBEDDABLE_MIMES.has(source.mime) || source.bytes.byteLength > ENCODED_MAX_BYTES) {
      warnings.push("原始编码超过 16 MB 或格式不可嵌入，已改用规范化像素存储");
      return "pixels";
    }
    return "encoded";
  }
  if (preference === "pixels") return "pixels";
  return embeddable ? "encoded" : "pixels";
}

export async function buildProjectFile(
  doc: StudioDocument,
  options: {
    preference: PayloadPreference;
    id: string;
    createdAt: string;
  },
): Promise<SaveResult> {
  const asset = doc.asset;
  if (!asset) throw new ProjectError("no-asset", "请先导入一张全景素材再保存工程");

  const warnings: string[] = [];
  const kind = choosePayloadKind(doc, options.preference, warnings);
  const store = new ContentStore();
  const extByHash = new Map<string, string>();

  let assetRef: AssetRef;
  if (kind === "encoded" && asset.source) {
    const bytes = new Uint8Array(asset.source.bytes);
    const hash = await store.add(bytes);
    extByHash.set(hash, asset.source.mime);
    assetRef = {
      role: "source",
      hash,
      name: asset.name,
      kind: "encoded",
      mime: asset.source.mime,
      width: asset.source.width,
      height: asset.source.height,
      bytes: bytes.length,
      normalizeVersion: NORMALIZE_VERSION,
    };
  } else {
    const png = await imageDataToPng(asset.data);
    const hash = await store.add(png);
    extByHash.set(hash, "image/png");
    assetRef = {
      role: "source",
      hash,
      name: asset.name,
      kind: "pixels",
      mime: "image/png",
      width: asset.width,
      height: asset.height,
      bytes: png.length,
    };
  }

  // 预览缩略图：用与导出完全相同的渲染管线绘制当前构图
  const previewCanvas = document.createElement("canvas");
  renderPreview(
    previewCanvas,
    {
      asset,
      projection: { ...doc.projection },
      edge: { ...doc.edge },
    },
    PREVIEW_SIZE,
  );
  const previewBytes = await canvasToPngBytes(previewCanvas);
  const previewHash = await store.add(previewBytes);

  const manifest = createManifest({
    id: options.id,
    name: doc.name.trim() || "未命名的星球",
    createdAt: options.createdAt,
    modifiedAt: new Date().toISOString(),
    projection: doc.projection,
    edge: doc.edge,
    assets: [assetRef],
    activeAsset: assetRef.hash,
    preview: { hash: previewHash, width: PREVIEW_SIZE, height: PREVIEW_SIZE },
  });

  const files: ZipFileInput[] = [
    {
      name: MANIFEST_NAME,
      data: new TextEncoder().encode(JSON.stringify(manifest, null, 2)),
    },
  ];
  for (const [hash, data] of store.entries()) {
    if (hash === previewHash) continue;
    files.push({ name: assetEntryName(hash, extByHash.get(hash)!), data });
  }
  files.push({ name: PREVIEW_NAME, data: previewBytes });

  const zipped = createZip(files);
  const safeName =
    manifest.name.replace(/[\\/:*?"<>| ]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 60) ||
    "orbit-project";
  return {
    blob: new Blob([zipped as BlobPart], { type: "application/zip" }),
    fileName: `${safeName}${PROJECT_EXTENSION}`,
    manifest,
    kind,
    totalBytes: zipped.length,
    warnings,
  };
}
