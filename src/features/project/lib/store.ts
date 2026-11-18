import { contentHash } from "./sha256";

/**
 * 内容寻址存储：素材按 sha256 指纹登记，相同内容重复引用只保留一份字节。
 * 保存工程时收集负载，最终由调用方映射为 ZIP 条目名。
 */
export class ContentStore {
  private readonly byHash = new Map<string, Uint8Array>();

  /** 登记一份字节，返回内容指纹 "sha256:…"；相同内容不会重复存储 */
  async add(data: Uint8Array): Promise<string> {
    const hash = await contentHash(data);
    if (!this.byHash.has(hash)) this.byHash.set(hash, data);
    return hash;
  }

  has(hash: string): boolean {
    return this.byHash.has(hash);
  }

  get(hash: string): Uint8Array | undefined {
    return this.byHash.get(hash);
  }

  get size(): number {
    return this.byHash.size;
  }

  entries(): [string, Uint8Array][] {
    return [...this.byHash.entries()];
  }
}

export const hashToHex = (hash: string): string => hash.slice("sha256:".length);

export function mimeToExt(mime: string): string {
  switch (mime) {
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    default:
      return "bin";
  }
}

export const assetEntryName = (hash: string, mime: string): string =>
  `assets/${hashToHex(hash)}.${mimeToExt(mime)}`;
