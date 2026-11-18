import type { Edge, Projection } from "../../../shared/types";
import { updateProjection } from "../../projection";
import { setSeam, setFeather, setBackground } from "../../edge";
import { ProjectError } from "./errors";
import { HASH_PATTERN } from "./sha256";
import { ZIP_LIMITS } from "./zip";

export const PROJECT_CONTAINER = "orbit-project";
export const PROJECT_VERSION = 1;
export const NORMALIZE_VERSION = 1;
export const APP_VERSION = "1.0.0";
export const MANIFEST_NAME = "orbit-project.json";
export const PREVIEW_NAME = "preview.png";
export const PROJECT_EXTENSION = ".orbit";

export const PREVIEW_SIZE = 512;
/** 原始编码策略的体积上限：超过则自动策略改用规范化像素 */
export const ENCODED_MAX_BYTES = 16 * 1024 * 1024;
/** 规范化像素（工作分辨率）的尺寸上限，防御 PNG 解压炸弹 */
export const MAX_IMAGE_SIDE = 8192;
export const MAX_IMAGE_PIXELS = 16 * 1024 * 1024;
/** 原始编码照片的原始尺寸上限（打开时会按规范化管线缩小到工作分辨率） */
export const MAX_SOURCE_SIDE = 16384;
export const MAX_SOURCE_PIXELS = 64 * 1024 * 1024;

export type PayloadKind = "encoded" | "pixels";

export interface AssetRef {
  role: "source";
  hash: string;
  name: string;
  kind: PayloadKind;
  mime: string;
  width: number;
  height: number;
  bytes: number;
  normalizeVersion?: number;
}

export interface PreviewRef {
  hash: string;
  width: number;
  height: number;
}

export interface ProjectManifest {
  container: typeof PROJECT_CONTAINER;
  version: number;
  id: string;
  name: string;
  createdAt: string;
  modifiedAt: string;
  app: { name: string; version: string };
  projection: Projection;
  edge: Edge;
  activeAsset: string;
  assets: AssetRef[];
  preview: PreviewRef | null;
}

export function createManifest(input: {
  id: string;
  name: string;
  createdAt: string;
  modifiedAt: string;
  projection: Projection;
  edge: Edge;
  assets: AssetRef[];
  activeAsset: string;
  preview: PreviewRef | null;
}): ProjectManifest {
  return {
    container: PROJECT_CONTAINER,
    version: PROJECT_VERSION,
    id: input.id,
    name: input.name,
    createdAt: input.createdAt,
    modifiedAt: input.modifiedAt,
    app: { name: "ORBIT", version: APP_VERSION },
    projection: { ...input.projection },
    edge: { ...input.edge },
    activeAsset: input.activeAsset,
    assets: input.assets.map((a) => ({ ...a })),
    preview: input.preview ? { ...input.preview } : null,
  };
}

function fail(detail: string): never {
  throw new ProjectError("bad-manifest", `工程描述无效：${detail}`);
}

function asRecord(v: unknown, what: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v))
    fail(`${what} 缺失或类型错误`);
  return v as Record<string, unknown>;
}

function asFiniteNumber(v: unknown, what: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) fail(`${what} 不是有效数值`);
  return v as number;
}

function asInt(v: unknown, what: string, lo: number, hi: number): number {
  const n = asFiniteNumber(v, what);
  if (!Number.isInteger(n) || n < lo || n > hi) fail(`${what} 超出允许范围`);
  return n;
}

function asString(v: unknown, what: string, maxLen: number): string {
  if (typeof v !== "string" || v.length === 0 || v.length > maxLen)
    fail(`${what} 缺失或过长`);
  return v as string;
}

function parseProjection(v: unknown): Projection {
  const r = asRecord(v, "取景参数");
  const mode = r.mode;
  if (mode !== "planet" && mode !== "tunnel") fail("投影模式未知");
  const p: Projection = {
    mode,
    zoom: asFiniteNumber(r.zoom, "缩放"),
    yaw: asFiniteNumber(r.yaw, "水平旋转"),
    pitch: asFiniteNumber(r.pitch, "俯仰角度"),
    roll: asFiniteNumber(r.roll, "画面旋转"),
  };
  // 数值超界时按工作室既有规则钳制，而不是拒绝打开
  updateProjection(p, "zoom", p.zoom);
  updateProjection(p, "yaw", p.yaw);
  updateProjection(p, "pitch", p.pitch);
  updateProjection(p, "roll", p.roll);
  return p;
}

function parseEdge(v: unknown): Edge {
  const r = asRecord(v, "边缘设置");
  if (typeof r.transparent !== "boolean") fail("透明开关缺失");
  const edge: Edge = {
    seam: asFiniteNumber(r.seam, "接缝融合"),
    feather: asFiniteNumber(r.feather, "边缘羽化"),
    background: asString(r.background, "画面底色", 32),
    transparent: r.transparent,
  };
  setSeam(edge, edge.seam);
  setFeather(edge, edge.feather);
  if (!/^#[0-9a-f]{6}$/i.test(edge.background)) fail("画面底色格式错误");
  setBackground(edge, edge.background.toLowerCase());
  return edge;
}

function parseAssetRef(v: unknown): AssetRef {
  const r = asRecord(v, "素材记录");
  if (r.role !== "source") fail("素材角色未知");
  const hash = asString(r.hash, "素材指纹", 128);
  if (!HASH_PATTERN.test(hash)) fail("素材指纹格式错误");
  const kind = r.kind;
  if (kind !== "encoded" && kind !== "pixels") fail("素材存储方式未知");
  // encoded 记录的是原始照片尺寸（打开时会被规范化缩小），
  // pixels 记录的是工作像素尺寸，两者适用不同的上限
  const maxSide = kind === "encoded" ? MAX_SOURCE_SIDE : MAX_IMAGE_SIDE;
  const maxPixels = kind === "encoded" ? MAX_SOURCE_PIXELS : MAX_IMAGE_PIXELS;
  const ref: AssetRef = {
    role: "source",
    hash,
    name: asString(r.name, "素材名称", 200),
    kind,
    mime: asString(r.mime, "素材类型", 100),
    width: asInt(r.width, "素材宽度", 1, maxSide),
    height: asInt(r.height, "素材高度", 1, maxSide),
    bytes: asInt(r.bytes, "素材体积", 1, ZIP_LIMITS.maxEntryBytes),
  };
  if (ref.width * ref.height > maxPixels) fail("素材像素总量超过上限");
  if (kind === "encoded") {
    if (r.normalizeVersion !== NORMALIZE_VERSION)
      throw new ProjectError(
        "unsupported-version",
        `素材规范化版本 ${String(r.normalizeVersion)} 不受支持（当前为 ${NORMALIZE_VERSION}）`,
      );
    ref.normalizeVersion = NORMALIZE_VERSION;
  }
  return ref;
}

/** 严格解析工程清单：结构错误抛 bad-manifest，版本未知抛 unsupported-version */
export function parseManifest(json: unknown): ProjectManifest {
  const r = asRecord(json, "工程清单");
  if (r.container !== PROJECT_CONTAINER) fail("不是 ORBIT 工程文件");
  if (r.version !== PROJECT_VERSION)
    throw new ProjectError(
      "unsupported-version",
      `工程版本 ${String(r.version)} 不受支持（当前应用支持版本 ${PROJECT_VERSION}）`,
    );
  const app = asRecord(r.app, "应用信息");
  const assetsRaw = r.assets;
  if (!Array.isArray(assetsRaw) || assetsRaw.length < 1 || assetsRaw.length > 32)
    fail("素材列表缺失或数量异常");
  const assets = assetsRaw.map(parseAssetRef);
  const activeAsset = asString(r.activeAsset, "当前素材引用", 128);
  if (!assets.some((a) => a.hash === activeAsset))
    fail("当前素材引用不存在于素材列表");

  let preview: PreviewRef | null = null;
  if (r.preview !== null && r.preview !== undefined) {
    const p = asRecord(r.preview, "预览图记录");
    const hash = asString(p.hash, "预览图指纹", 128);
    if (!HASH_PATTERN.test(hash)) fail("预览图指纹格式错误");
    preview = {
      hash,
      width: asInt(p.width, "预览图宽度", 1, 4096),
      height: asInt(p.height, "预览图高度", 1, 4096),
    };
  }

  return {
    container: PROJECT_CONTAINER,
    version: PROJECT_VERSION,
    id: asString(r.id, "工程编号", 64),
    name: asString(r.name, "工程名称", 120),
    createdAt: asString(r.createdAt, "创建时间", 40),
    modifiedAt: asString(r.modifiedAt, "修改时间", 40),
    app: {
      name: asString(app.name, "应用名称", 40),
      version: asString(app.version, "应用版本", 40),
    },
    projection: parseProjection(r.projection),
    edge: parseEdge(r.edge),
    activeAsset,
    assets,
    preview,
  };
}
