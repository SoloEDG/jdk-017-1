export interface Projection {
  mode: "planet" | "tunnel";
  zoom: number;
  yaw: number;
  pitch: number;
  roll: number;
}
export interface Edge {
  seam: number;
  feather: number;
  background: string;
  transparent: boolean;
}
export interface AssetSource {
  bytes: ArrayBuffer;
  mime: string;
  width: number;
  height: number;
}
export interface Asset {
  id: string;
  name: string;
  width: number;
  height: number;
  data: ImageData;
  thumbnail: string;
  /** 原始编码字节（JPEG/PNG/WebP），用于工程文件的 encoded 存储策略 */
  source?: AssetSource;
  /** 内容指纹 "sha256:…"，保存/打开工程时绑定 */
  hash?: string;
}
export interface StudioDocument {
  name: string;
  asset: Asset | null;
  projection: Projection;
  edge: Edge;
}
export interface ExportSettings {
  size: number;
  format: "png" | "jpeg";
  quality: number;
}
export interface RenderSnapshot {
  asset: Asset;
  projection: Projection;
  edge: Edge;
}
