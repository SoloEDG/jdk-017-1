// e2e 辅助：基于应用自身的 zip/manifest 库构造各种工程文件变体
import { createZip, ZipReader } from "../../src/features/project/lib/zip";

export interface Entry {
  name: string;
  data: Uint8Array;
}

export function readEntries(bytes: Uint8Array): Entry[] {
  const reader = new ZipReader(bytes);
  return reader
    .names()
    .map((name) => ({ name, data: new Uint8Array(reader.read(name)) }));
}

/** 未知版本：改写清单 version 后重新打包（保持 CRC 正确） */
export function makeUnknownVersion(bytes: Uint8Array, version: number): Uint8Array {
  const entries = readEntries(bytes);
  const manifest = JSON.parse(
    new TextDecoder().decode(entries.find((e) => e.name === "orbit-project.json")!.data),
  ) as Record<string, unknown>;
  manifest.version = version;
  return createZip(
    entries.map((e) =>
      e.name === "orbit-project.json"
        ? { name: e.name, data: new TextEncoder().encode(JSON.stringify(manifest, null, 2)) }
        : e,
    ),
  );
}

/** 缺图：移除 assets/ 下的素材条目 */
export function makeMissingAsset(bytes: Uint8Array): Uint8Array {
  const entries = readEntries(bytes);
  return createZip(entries.filter((e) => !e.name.startsWith("assets/")));
}

/** 素材损坏：原地翻转素材数据的一个字节（CRC 与指纹都会失败） */
export function makeTamperedAsset(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes);
  const reader = new ZipReader(out);
  const entry = reader.entries.find((e) => e.name.startsWith("assets/"));
  if (!entry) throw new Error("工程里没有素材条目");
  const view = new DataView(out.buffer, out.byteOffset, out.length);
  const nameLen = view.getUint16(entry.localOffset + 26, true);
  const extraLen = view.getUint16(entry.localOffset + 28, true);
  const dataStart = entry.localOffset + 30 + nameLen + extraLen;
  out[dataStart + Math.floor(entry.size / 2)] ^= 0xff;
  return out;
}

/** 解压炸弹：中央目录声明超大解压体积（数据不变） */
export function makeBomb(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes);
  const view = new DataView(out.buffer, out.byteOffset, out.length);
  const eocd = out.length - 22;
  const cdOffset = view.getUint32(eocd + 16, true);
  const huge = 600 * 1024 * 1024;
  view.setUint32(cdOffset + 20, huge, true); // compressed size
  view.setUint32(cdOffset + 24, huge, true); // uncompressed size
  return out;
}
