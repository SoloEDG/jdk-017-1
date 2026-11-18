import { crc32 } from "./crc32";
import { ProjectError } from "./errors";

/**
 * 最小 ZIP 读写器：只使用 STORED（不压缩）条目。
 * 工程负载（PNG/JPEG/WebP）本身已是压缩格式，再 DEFLATE 收益接近零；
 * STORED 让中央目录里声明的体积等于真实体积，解压炸弹检查可以在
 * 读取任何数据之前精确完成，且运行时零依赖、完全离线。
 */

export const ZIP_LIMITS = {
  maxEntries: 256,
  maxEntryBytes: 256 * 1024 * 1024, // 单条目 256 MB
  maxTotalBytes: 512 * 1024 * 1024, // 全部解压后总量 512 MB
} as const;

// 固定的 DOS 时间戳（1980-01-01 00:00）：相同内容产出字节级相同的工程文件
const FIXED_TIME = 0;
const FIXED_DATE = 0x21;
const UTF8_FLAG = 0x0800;
const METHOD_STORED = 0;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8");

export interface ZipFileInput {
  name: string;
  data: Uint8Array;
}

function checkName(name: string) {
  if (!name || name.length > 200)
    throw new ProjectError("unsafe-entry", "条目名称缺失或过长");
  if (
    name.includes("..") ||
    name.startsWith("/") ||
    name.startsWith("\\") ||
    name.includes("\\") ||
    name.includes(":") ||
    name.endsWith("/")
  )
    throw new ProjectError("unsafe-entry", `条目路径不安全：${name}`);
}

export function createZip(files: ZipFileInput[]): Uint8Array {
  if (files.length > ZIP_LIMITS.maxEntries)
    throw new ProjectError("too-many-entries", "工程内文件数量超过上限");
  const seen = new Set<string>();
  for (const f of files) {
    checkName(f.name);
    if (seen.has(f.name))
      throw new ProjectError("unsafe-entry", `条目重复：${f.name}`);
    seen.add(f.name);
    if (f.data.length > ZIP_LIMITS.maxEntryBytes)
      throw new ProjectError("archive-too-large", `条目 ${f.name} 超过大小上限`);
  }

  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    const nameBytes = encoder.encode(f.name);
    const crc = crc32(f.data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true); // version needed
    local.setUint16(6, UTF8_FLAG, true);
    local.setUint16(8, METHOD_STORED, true);
    local.setUint16(10, FIXED_TIME, true);
    local.setUint16(12, FIXED_DATE, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, f.data.length, true);
    local.setUint32(22, f.data.length, true);
    local.setUint16(26, nameBytes.length, true);
    local.setUint16(28, 0, true);
    chunks.push(new Uint8Array(local.buffer), nameBytes, f.data);

    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014b50, true);
    entry.setUint16(4, 20, true); // version made by
    entry.setUint16(6, 20, true); // version needed
    entry.setUint16(8, UTF8_FLAG, true);
    entry.setUint16(10, METHOD_STORED, true);
    entry.setUint16(12, FIXED_TIME, true);
    entry.setUint16(14, FIXED_DATE, true);
    entry.setUint32(16, crc, true);
    entry.setUint32(20, f.data.length, true);
    entry.setUint32(24, f.data.length, true);
    entry.setUint16(28, nameBytes.length, true);
    // extra/comment/disk/attrs 均为 0
    entry.setUint32(42, offset, true);
    central.push(new Uint8Array(entry.buffer), nameBytes);
    offset += 30 + nameBytes.length + f.data.length;
  }

  const cdOffset = offset;
  const cdSize = central.reduce((n, c) => n + c.length, 0);
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, files.length, true);
  eocd.setUint16(10, files.length, true);
  eocd.setUint32(12, cdSize, true);
  eocd.setUint32(16, cdOffset, true);

  const out = new Uint8Array(offset + cdSize + 22);
  let at = 0;
  for (const c of [...chunks, ...central, new Uint8Array(eocd.buffer)]) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

export interface ZipEntryMeta {
  name: string;
  size: number;
  crc: number;
  localOffset: number;
}

export class ZipReader {
  private readonly bytes: Uint8Array;
  private readonly byName = new Map<string, ZipEntryMeta>();
  readonly entries: ZipEntryMeta[];

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.entries = this.parseDirectory();
    let total = 0;
    for (const e of this.entries) {
      if (this.byName.has(e.name))
        throw new ProjectError("unsafe-entry", `条目重复：${e.name}`);
      this.byName.set(e.name, e);
      total += e.size;
    }
    if (total > ZIP_LIMITS.maxTotalBytes)
      throw new ProjectError(
        "archive-too-large",
        `解压后总体积 ${Math.ceil(total / 1024 / 1024)} MB 超过 ${ZIP_LIMITS.maxTotalBytes / 1024 / 1024} MB 上限，已拒绝打开`,
      );
  }

  private parseDirectory(): ZipEntryMeta[] {
    const b = this.bytes;
    if (b.length < 22)
      throw new ProjectError("not-a-zip", "文件太小，不是有效的工程文件");
    // 从尾部扫描 EOCD 签名
    let eocd = -1;
    const min = Math.max(0, b.length - 22 - 65535);
    for (let i = b.length - 22; i >= min; i--) {
      if (
        b[i] === 0x50 &&
        b[i + 1] === 0x4b &&
        b[i + 2] === 0x05 &&
        b[i + 3] === 0x06
      ) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0)
      throw new ProjectError("not-a-zip", "找不到 ZIP 目录结构，文件已损坏");
    const view = new DataView(b.buffer, b.byteOffset, b.length);
    const commentLen = view.getUint16(eocd + 20, true);
    if (eocd + 22 + commentLen !== b.length)
      throw new ProjectError("not-a-zip", "ZIP 尾部数据不完整");
    if (view.getUint16(eocd + 4, true) !== 0 || view.getUint16(eocd + 6, true) !== 0)
      throw new ProjectError("not-a-zip", "不支持分卷压缩包");
    const count = view.getUint16(eocd + 10, true);
    const cdSize = view.getUint32(eocd + 12, true);
    const cdOffset = view.getUint32(eocd + 16, true);
    if (count > ZIP_LIMITS.maxEntries)
      throw new ProjectError("too-many-entries", `条目数量 ${count} 超过上限`);
    if (cdOffset + cdSize > eocd)
      throw new ProjectError("not-a-zip", "ZIP 中央目录越界，文件已损坏");

    const out: ZipEntryMeta[] = [];
    let p = cdOffset;
    for (let i = 0; i < count; i++) {
      if (p + 46 > b.length || view.getUint32(p, true) !== 0x02014b50)
        throw new ProjectError("not-a-zip", "ZIP 中央目录损坏");
      const method = view.getUint16(p + 10, true);
      if (method !== METHOD_STORED)
        throw new ProjectError(
          "unsupported-method",
          "包含未知压缩方式的条目（本工程格式仅使用不压缩存储）",
        );
      const crc = view.getUint32(p + 16, true);
      const compressed = view.getUint32(p + 20, true);
      const size = view.getUint32(p + 24, true);
      const nameLen = view.getUint16(p + 28, true);
      const extraLen = view.getUint16(p + 30, true);
      const commentLen2 = view.getUint16(p + 32, true);
      const localOffset = view.getUint32(p + 42, true);
      if (compressed !== size)
        throw new ProjectError("not-a-zip", "条目大小声明不一致");
      if (size > ZIP_LIMITS.maxEntryBytes)
        throw new ProjectError(
          "archive-too-large",
          `条目解压后 ${Math.ceil(size / 1024 / 1024)} MB 超过上限`,
        );
      const nameStart = p + 46;
      if (nameStart + nameLen > b.length)
        throw new ProjectError("not-a-zip", "ZIP 条目名称越界");
      const name = decoder.decode(b.subarray(nameStart, nameStart + nameLen));
      checkName(name);
      if (localOffset + 30 > b.length)
        throw new ProjectError("not-a-zip", "条目数据偏移越界");
      out.push({ name, size, crc, localOffset });
      p = nameStart + nameLen + extraLen + commentLen2;
    }
    if (p !== cdOffset + cdSize)
      throw new ProjectError("not-a-zip", "ZIP 中央目录长度不符");
    return out;
  }

  has(name: string): boolean {
    return this.byName.has(name);
  }

  names(): string[] {
    return this.entries.map((e) => e.name);
  }

  /** 按内容寻址查找 assets/<hex>.<任意扩展名> 条目 */
  findAssetEntry(hex: string): string | null {
    const prefix = `assets/${hex}.`;
    for (const e of this.entries)
      if (e.name.startsWith(prefix) && e.name.length > prefix.length)
        return e.name;
    return null;
  }

  read(name: string): Uint8Array {
    const meta = this.byName.get(name);
    if (!meta) throw new ProjectError("asset-missing", `工程内缺少文件 ${name}`);
    const b = this.bytes;
    const view = new DataView(b.buffer, b.byteOffset, b.length);
    const p = meta.localOffset;
    if (view.getUint32(p, true) !== 0x04034b50)
      throw new ProjectError("not-a-zip", `条目 ${name} 的本地文件头损坏`);
    const nameLen = view.getUint16(p + 26, true);
    const extraLen = view.getUint16(p + 28, true);
    const dataStart = p + 30 + nameLen + extraLen;
    if (dataStart + meta.size > b.length)
      throw new ProjectError("not-a-zip", `条目 ${name} 数据越界`);
    const data = b.subarray(dataStart, dataStart + meta.size);
    if (crc32(data) !== meta.crc)
      throw new ProjectError("bad-crc", `条目 ${name} 校验和失败，文件已损坏`);
    return data;
  }
}
