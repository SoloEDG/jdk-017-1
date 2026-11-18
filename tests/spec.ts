import assert from "node:assert/strict";
import { crc32 } from "../src/features/project/lib/crc32";
import { sha256Hex, sha256Pure, toHex, contentHash } from "../src/features/project/lib/sha256";
import { createZip, ZipReader, ZIP_LIMITS } from "../src/features/project/lib/zip";
import { ProjectError } from "../src/features/project/lib/errors";
import {
  createManifest,
  parseManifest,
  PROJECT_VERSION,
  NORMALIZE_VERSION,
} from "../src/features/project/lib/manifest";
import { ContentStore, assetEntryName, hashToHex } from "../src/features/project/lib/store";
import {
  stageArchive,
  substituteAssetRef,
  type StagedArchive,
} from "../src/features/project/lib/unpack";

const enc = new TextEncoder();
const dec = new TextDecoder();

type TestFn = () => void | Promise<void>;
const tests: { name: string; fn: TestFn }[] = [];
const test = (name: string, fn: TestFn) => tests.push({ name, fn });

const utf8 = (s: string) => enc.encode(s);

async function expectProjectError(
  code: string,
  fn: () => unknown | Promise<unknown>,
) {
  try {
    await fn();
  } catch (e) {
    assert.ok(e instanceof ProjectError, `期望 ProjectError，实际：${e}`);
    assert.equal(e.code, code, `期望错误码 ${code}，实际 ${e.code}：${e.message}`);
    return;
  }
  assert.fail(`期望抛出 ${code}，但没有抛出`);
}

/** 构造一个最小有效清单对象（可直接 JSON 序列化） */
function manifestJson(overrides: Record<string, unknown> = {}) {
  const hash =
    "sha256:" + "a".repeat(64);
  return {
    container: "orbit-project",
    version: PROJECT_VERSION,
    id: "p-1",
    name: "测试工程",
    createdAt: "2026-11-18T00:00:00.000Z",
    modifiedAt: "2026-11-18T00:00:00.000Z",
    app: { name: "ORBIT", version: "1.0.0" },
    projection: { mode: "planet", zoom: 1.5, yaw: 30, pitch: -10, roll: 45 },
    edge: {
      seam: 0.05,
      feather: 0.2,
      background: "#112233",
      transparent: true,
    },
    activeAsset: hash,
    assets: [
      {
        role: "source",
        hash,
        name: "photo.jpg",
        kind: "encoded",
        mime: "image/jpeg",
        width: 6000,
        height: 3000,
        bytes: 1234,
        normalizeVersion: NORMALIZE_VERSION,
      },
    ],
    preview: null,
    ...overrides,
  };
}

// ---------- crc32 ----------
test("crc32 标准向量", () => {
  assert.equal(crc32(utf8("123456789")), 0xcbf43926);
  assert.equal(crc32(new Uint8Array(0)), 0);
});

// ---------- sha256 ----------
test("sha256 纯实现与标准向量一致", () => {
  assert.equal(
    toHex(sha256Pure(utf8("abc"))),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  assert.equal(
    toHex(sha256Pure(new Uint8Array(0))),
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
  // 跨 64 字节块边界
  const long = new Uint8Array(1000).map((_, i) => i % 251);
  assert.equal(toHex(sha256Pure(long)).length, 64);
});

test("sha256 WebCrypto 与纯实现结果相同", async () => {
  const data = new Uint8Array(5000).map((_, i) => (i * 7) % 256);
  assert.equal(await sha256Hex(data), toHex(sha256Pure(data)));
});

// ---------- zip ----------
test("zip 写入/读取往返一致（含中文名）", () => {
  const files = [
    { name: "orbit-project.json", data: utf8('{"a":1}') },
    { name: "assets/" + "ab".repeat(32) + ".jpg", data: new Uint8Array([1, 2, 3, 4]) },
    { name: "preview.png", data: new Uint8Array(100).map((_, i) => i) },
  ];
  const zip = createZip(files);
  const reader = new ZipReader(zip);
  assert.equal(reader.entries.length, 3);
  for (const f of files) assert.deepEqual([...reader.read(f.name)], [...f.data]);
});

test("zip 输出确定性：相同输入字节级相同", () => {
  const files = [
    { name: "a.bin", data: utf8("hello") },
    { name: "b.bin", data: utf8("world") },
  ];
  assert.deepEqual(createZip(files), createZip(files));
});

test("zip 数据被篡改时 read 抛出 bad-crc", () => {
  const zip = createZip([{ name: "a.bin", data: utf8("hello world") }]);
  const reader = new ZipReader(zip);
  const meta = reader.entries[0];
  // 篡改本地数据区第一个字节
  zip[meta.localOffset + 30 + 5] ^= 0xff;
  return expectProjectError("bad-crc", () => reader.read("a.bin"));
});

test("zip 声明超大解压体积时在目录阶段拒绝", () => {
  const zip = createZip([{ name: "a.bin", data: utf8("tiny") }]);
  const view = new DataView(zip.buffer);
  // 找到中央目录（从 EOCD 反推）
  const eocd = zip.length - 22;
  const cdOffset = view.getUint32(eocd + 16, true);
  const huge = 300 * 1024 * 1024;
  // 中央目录条目：compressed/uncompressed size
  view.setUint32(cdOffset + 20, huge, true);
  view.setUint32(cdOffset + 24, huge, true);
  return expectProjectError("archive-too-large", () => new ZipReader(zip));
});

test("zip 条目名含 .. 时拒绝", () => {
  const zip = createZip([{ name: "ab.txt", data: utf8("x") }]);
  // 把 "ab.txt" 改成 "../x.t"（等长 6 字节，同时出现在本地头与中央目录）
  const target = utf8("../x.t");
  let patched = 0;
  for (let i = 0; i + 6 <= zip.length; i++) {
    if (dec.decode(zip.subarray(i, i + 6)) === "ab.txt") {
      zip.set(target, i);
      patched++;
    }
  }
  assert.equal(patched, 2, "应同时修补本地头与中央目录");
  return expectProjectError("unsafe-entry", () => new ZipReader(zip));
});

test("createZip 拒绝重名与不安全路径", () => {
  assert.throws(
    () => createZip([{ name: "a", data: utf8("1") }, { name: "a", data: utf8("2") }]),
    /重复/,
  );
  assert.throws(() => createZip([{ name: "../evil", data: utf8("1") }]));
  assert.throws(() => createZip([{ name: "/abs", data: utf8("1") }]));
});

test("zip 非 zip 数据报 not-a-zip", () => {
  return expectProjectError("not-a-zip", () => new ZipReader(utf8("not a zip file at all")));
});

// ---------- store ----------
test("内容寻址存储：重复引用只保存一份", async () => {
  const store = new ContentStore();
  const data = utf8("相同的内容");
  const h1 = await store.add(data);
  const h2 = await store.add(new Uint8Array(data));
  const h3 = await store.add(utf8("不同的内容"));
  assert.equal(h1, h2);
  assert.notEqual(h1, h3);
  assert.equal(store.size, 2);
  assert.match(h1, /^sha256:[0-9a-f]{64}$/);
});

// ---------- manifest ----------
test("清单往返：取景与边缘设置精确保留", () => {
  const json = manifestJson();
  const m = parseManifest(JSON.parse(JSON.stringify(json)));
  assert.deepEqual(m.projection, json.projection);
  assert.deepEqual(m.edge, json.edge);
  assert.equal(m.version, PROJECT_VERSION);
});

test("createManifest 与 parseManifest 组合往返", () => {
  const json = manifestJson();
  const m = createManifest({
    id: json.id,
    name: json.name,
    createdAt: json.createdAt,
    modifiedAt: json.modifiedAt,
    projection: json.projection as never,
    edge: json.edge as never,
    assets: json.assets as never,
    activeAsset: json.activeAsset,
    preview: null,
  });
  const back = parseManifest(JSON.parse(JSON.stringify(m)));
  assert.deepEqual(back.projection, json.projection);
  assert.deepEqual(back.edge, json.edge);
});

test("未知版本被拒绝（保留原作品路径）", () => {
  return expectProjectError("unsupported-version", () =>
    parseManifest(manifestJson({ version: 2 })),
  );
});

test("未知素材规范化版本被拒绝", () => {
  const json = manifestJson();
  (json.assets[0] as Record<string, unknown>).normalizeVersion = 7;
  return expectProjectError("unsupported-version", () => parseManifest(json));
});

test("数值超界按工作室规则钳制而非拒绝", () => {
  const json = manifestJson();
  (json.projection as Record<string, unknown>).zoom = 999;
  (json.projection as Record<string, unknown>).pitch = -200;
  (json.edge as Record<string, unknown>).feather = 9;
  const m = parseManifest(json);
  assert.equal(m.projection.zoom, 3);
  assert.equal(m.projection.pitch, -85);
  assert.equal(m.edge.feather, 0.4);
});

test("非法结构报 bad-manifest", async () => {
  await expectProjectError("bad-manifest", () => parseManifest(null));
  await expectProjectError("bad-manifest", () =>
    parseManifest(manifestJson({ container: "other" })),
  );
  await expectProjectError("bad-manifest", () =>
    parseManifest(manifestJson({ projection: { mode: "spiral" } })),
  );
  await expectProjectError("bad-manifest", () =>
    parseManifest(manifestJson({ activeAsset: "sha256:" + "b".repeat(64) })),
  );
  const badBg = manifestJson();
  (badBg.edge as Record<string, unknown>).background = "red";
  await expectProjectError("bad-manifest", () => parseManifest(badBg));
});

// ---------- stageArchive ----------
async function buildProjectBytes(options: {
  assetData?: Uint8Array;
  tamperAsset?: boolean;
  omitAsset?: boolean;
  tamperPreview?: boolean;
  manifestOverrides?: Record<string, unknown>;
}) {
  const store = new ContentStore();
  const assetData = options.assetData ?? utf8("fake-jpeg-bytes");
  const assetHash = await store.add(assetData);
  const previewData = utf8("fake-png-bytes");
  const previewHash = await store.add(previewData);
  const json = manifestJson({
    activeAsset: assetHash,
    assets: [
      {
        role: "source",
        hash: assetHash,
        name: "photo.jpg",
        kind: "encoded",
        mime: "image/jpeg",
        width: 6000,
        height: 3000,
        bytes: assetData.length,
        normalizeVersion: NORMALIZE_VERSION,
      },
    ],
    preview: { hash: previewHash, width: 512, height: 512 },
    ...options.manifestOverrides,
  });
  const files = [
    { name: "orbit-project.json", data: utf8(JSON.stringify(json)) },
  ];
  if (!options.omitAsset) {
    files.push({
      name: assetEntryName(assetHash, "image/jpeg"),
      data: options.tamperAsset ? utf8("tampered-bytes!!") : assetData,
    });
  }
  files.push({
    name: "preview.png",
    data: options.tamperPreview ? utf8("tampered-preview") : previewData,
  });
  return { bytes: createZip(files), assetHash, previewHash };
}

test("暂存校验：完整工程通过", async () => {
  const { bytes, assetHash } = await buildProjectBytes({});
  const staged = await stageArchive(bytes);
  assert.equal(staged.problems.length, 0);
  assert.equal(staged.warnings.length, 0);
  assert.ok(staged.assetBytes.has(assetHash));
  assert.ok(staged.previewBytes);
  assert.equal(staged.manifest.name, "测试工程");
});

test("暂存校验：缺素材报 asset-missing 问题而不抛出", async () => {
  const { bytes, assetHash } = await buildProjectBytes({ omitAsset: true });
  const staged = await stageArchive(bytes);
  assert.equal(staged.problems.length, 1);
  assert.equal(staged.problems[0].code, "asset-missing");
  assert.equal(staged.problems[0].hash, assetHash);
});

test("暂存校验：素材被篡改报 asset-corrupt", async () => {
  const { bytes } = await buildProjectBytes({ tamperAsset: true });
  const staged = await stageArchive(bytes);
  assert.equal(staged.problems.length, 1);
  assert.equal(staged.problems[0].code, "asset-corrupt");
});

test("暂存校验：素材字节原位损坏（CRC 失败）转为可重新绑定的问题", async () => {
  const { bytes } = await buildProjectBytes({});
  // 找到素材条目数据区，原地翻转一个字节（保持长度，触发 CRC 失败）
  const reader = new ZipReader(bytes);
  const assetEntry = reader.entries.find((e) => e.name.startsWith("assets/"))!;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  const nameLen = view.getUint16(assetEntry.localOffset + 26, true);
  const extraLen = view.getUint16(assetEntry.localOffset + 28, true);
  bytes[assetEntry.localOffset + 30 + nameLen + extraLen] ^= 0xff;
  const staged = await stageArchive(bytes);
  assert.equal(staged.problems.length, 1);
  assert.equal(staged.problems[0].code, "asset-corrupt");
  assert.match(staged.problems[0].detail, /校验和失败/);
});

test("暂存校验：预览损坏只降级为警告", async () => {
  const { bytes } = await buildProjectBytes({ tamperPreview: true });
  const staged = await stageArchive(bytes);
  assert.equal(staged.problems.length, 0);
  assert.equal(staged.previewBytes, null);
  assert.equal(staged.warnings.length, 1);
});

test("暂存校验：未知版本直接抛出，不进入暂存", async () => {
  const { bytes } = await buildProjectBytes({
    manifestOverrides: { version: 99 },
  });
  await expectProjectError("unsupported-version", () => stageArchive(bytes));
});

test("重新绑定：替换引用并留下可见记录", async () => {
  const { bytes, assetHash } = await buildProjectBytes({ omitAsset: true });
  const staged: StagedArchive = await stageArchive(bytes);
  assert.equal(staged.problems.length, 1);
  const newData = utf8("user-chosen-replacement");
  const newHash = await contentHash(newData);
  substituteAssetRef(staged, assetHash, {
    role: "source",
    hash: newHash,
    name: "replacement.jpg",
    kind: "encoded",
    mime: "image/jpeg",
    width: 4000,
    height: 2000,
    bytes: newData.length,
    normalizeVersion: NORMALIZE_VERSION,
  });
  assert.equal(staged.manifest.activeAsset, newHash);
  assert.ok(staged.manifest.assets.every((a) => a.hash === newHash));
  assert.equal(staged.substitutions.length, 1);
  assert.equal(staged.substitutions[0].fromHash, assetHash);
});

test("内容寻址条目名与哈希一致", () => {
  const hash = "sha256:" + "cd".repeat(32);
  assert.equal(assetEntryName(hash, "image/jpeg"), `assets/${hashToHex(hash)}.jpg`);
  assert.equal(assetEntryName(hash, "image/png"), `assets/${hashToHex(hash)}.png`);
});

test("ZIP 限制常量符合设计", () => {
  assert.equal(ZIP_LIMITS.maxTotalBytes, 512 * 1024 * 1024);
  assert.equal(ZIP_LIMITS.maxEntries, 256);
});

// ---------- runner ----------
let failed = 0;
for (const t of tests) {
  try {
    await t.fn();
    console.log(`  ✓ ${t.name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${t.name}`);
    console.error(`    ${e instanceof Error ? e.message : e}`);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} 通过`);
if (failed > 0) process.exit(1);
