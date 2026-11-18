// ORBIT 工程文件端到端验证（真实 Chromium，全程可断网）。
// 运行前：npm run build；并确保 chromium 可用（见 README「工程文件」一节）。
// 场景：保存工程 → 断网 → 打开工程 → 重新导出位精确一致；
//       未知版本 / 解压炸弹 / 缺图 / 素材损坏 → 保留原作品，可重新绑定修复。
import { build } from "esbuild";
import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";
import { createServer } from "node:http";
import { readFile, mkdtemp, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const distDir = join(root, "dist");
const tmp = await mkdtemp(join(tmpdir(), "orbit-e2e-"));

// ---------- 1. 打包变体构造器（纯 TS，复用应用自身的 zip 库） ----------
const vueStub = {
  name: "vue-stub",
  setup(b) {
    b.onResolve({ filter: /\.vue$/ }, (a) => ({ path: a.path, namespace: "v" }));
    b.onLoad({ filter: /.*/, namespace: "v" }, () => ({ contents: "export default {}" }));
  },
};
const variantsOut = join(root, "node_modules", ".cache", "orbit-e2e-variants.mjs");
await build({
  entryPoints: [join(root, "tests", "e2e", "variants.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: variantsOut,
  plugins: [vueStub],
  logLevel: "warning",
});
const variants = await import(pathToFileURL(variantsOut).href);

// ---------- 2. 静态服务器（仅 127.0.0.1） ----------
if (!existsSync(join(distDir, "index.html")))
  throw new Error("dist/ 不存在，请先运行 npm run build");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname === "/" ? "/index.html" : url.pathname;
    const file = join(distDir, decodeURIComponent(path));
    if (!file.startsWith(distDir)) throw new Error("traversal");
    const data = await readFile(file);
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const baseURL = `http://127.0.0.1:${server.address().port}`;

// ---------- 3. 浏览器 ----------
const sha256File = async (p) =>
  createHash("sha256").update(await readFile(p)).digest("hex");

let passed = 0;
const step = (name) => console.log(`  ✓ ${(++passed, name)}`);

const browser = await chromium.launch();
try {
  const context = await browser.newContext({ acceptDownloads: true });
  const blockedExternal = [];
  await context.route("**/*", (route) => {
    const u = route.request().url();
    if (u.startsWith(baseURL)) return route.continue();
    blockedExternal.push(u);
    return route.abort();
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));

  const readState = () =>
    page.evaluate(() => {
      const d = globalThis.__orbitStudio;
      return {
        name: d.name,
        projection: { ...d.projection },
        edge: { ...d.edge },
        asset: d.asset
          ? { name: d.asset.name, width: d.asset.width, height: d.asset.height, hash: d.asset.hash }
          : null,
      };
    });
  const setState = (state) =>
    page.evaluate((s) => {
      const d = globalThis.__orbitStudio;
      d.name = s.name;
      Object.assign(d.projection, s.projection);
      Object.assign(d.edge, s.edge);
    }, state);
  const download = async (clickSelector, saveAs) => {
    const [dl] = await Promise.all([
      page.waitForEvent("download", { timeout: 120000 }),
      page.click(clickSelector),
    ]);
    await dl.saveAs(saveAs);
    return saveAs;
  };
  const openProject = async (file) => {
    await page.setInputFiles('.project-panel input[accept^=".orbit"]', file);
  };

  await page.goto(baseURL, { waitUntil: "load" });
  await page.waitForFunction(() => globalThis.__orbitStudio?.asset, null, { timeout: 30000 });
  step("应用加载，内置示例素材就绪");

  // —— 设定一组有辨识度的状态（含透明边缘） ——
  const savedState = {
    name: "断网复现测试",
    projection: { mode: "tunnel", zoom: 1.37, yaw: 123, pitch: -22, roll: 45 },
    edge: { seam: 0.05, feather: 0.12, background: "#224466", transparent: true },
  };
  await setState(savedState);
  await page.waitForTimeout(400);

  // —— 基线导出（保存时的构图） ——
  const exportA = join(tmp, "export-a.png");
  await download('.export-panel button:has-text("导出我的星球")', exportA);
  step("基线导出完成（隧道构图 · 透明边缘）");

  // —— 保存工程（自动策略：示例 JPEG ≤ 16MB → 原始编码） ——
  const projectEncoded = join(tmp, "encoded.orbit");
  await download('.project-panel button:has-text("保存工程文件")', projectEncoded);
  step("工程已保存（自动策略 → 原始编码照片）");

  // —— 再以规范像素策略保存一份 ——
  await page.click('.project-panel .segmented button:has-text("规范像素")');
  const projectPixels = join(tmp, "pixels.orbit");
  await download('.project-panel button:has-text("保存工程文件")', projectPixels);
  const encodedSize = (await readFile(projectEncoded)).length;
  const pixelsSize = (await readFile(projectPixels)).length;
  assert.ok(pixelsSize > encodedSize, "规范像素工程应大于原始编码工程");
  step(
    `两种策略体积对比：原始编码 ${(encodedSize / 1024 / 1024).toFixed(2)} MB < 规范像素 ${(pixelsSize / 1024 / 1024).toFixed(2)} MB`,
  );

  // —— 断网！之后所有操作不得依赖网络 ——
  await context.setOffline(true);
  step("已切换为离线模式（context.setOffline(true)）");

  // —— 打乱当前工作区 ——
  const disturbedState = {
    name: "被打乱的工程",
    projection: { mode: "planet", zoom: 0.5, yaw: 300, pitch: 60, roll: 200 },
    edge: { seam: 0.1, feather: 0.3, background: "#ffffff", transparent: false },
  };
  await setState(disturbedState);
  await page.waitForTimeout(300);

  // —— 离线打开 encoded 工程，确认后工作区整体切换 ——
  await openProject(projectEncoded);
  await page.waitForSelector('button:has-text("校验通过，打开工程")', { timeout: 30000 });
  assert.ok(await page.$(".preview-card img"), "确认卡片应显示保存时的预览缩略图");
  await page.click('button:has-text("校验通过，打开工程")');
  await page.waitForTimeout(300);
  assert.deepEqual(await readState(), { ...savedState, asset: (await readState()).asset });
  const stateAfterOpen = await readState();
  assert.equal(stateAfterOpen.name, savedState.name);
  assert.deepEqual(stateAfterOpen.projection, savedState.projection);
  assert.deepEqual(stateAfterOpen.edge, savedState.edge);
  assert.ok(stateAfterOpen.asset?.hash?.startsWith("sha256:"));
  step("离线打开工程：名称/取景/边缘/素材指纹全部还原");

  // —— 重新导出：与保存时位精确一致 ——
  const exportB = join(tmp, "export-b.png");
  await download('.export-panel button:has-text("导出我的星球")', exportB);
  assert.equal(await sha256File(exportB), await sha256File(exportA), "重新导出与保存时不一致");
  step("重新导出与保存时位精确一致（encoded 策略）");

  // —— pixels 策略同样一致 ——
  await setState(disturbedState);
  await openProject(projectPixels);
  await page.waitForSelector('button:has-text("校验通过，打开工程")', { timeout: 30000 });
  await page.click('button:has-text("校验通过，打开工程")');
  await page.waitForTimeout(300);
  const exportC = join(tmp, "export-c.png");
  await download('.export-panel button:has-text("导出我的星球")', exportC);
  assert.equal(await sha256File(exportC), await sha256File(exportA), "pixels 重新导出与保存时不一致");
  step("重新导出与保存时位精确一致（pixels 策略）");

  // —— 未知版本：拒绝并保留原作品 ——
  const versionFile = join(tmp, "version.orbit");
  await writeFile(versionFile, variants.makeUnknownVersion(await readFile(projectEncoded), 2));
  await setState({ ...disturbedState, name: "版本测试标记" });
  await openProject(versionFile);
  await page.waitForSelector(".project-panel .error", { timeout: 30000 });
  const versionError = await page.textContent(".project-panel .error");
  assert.match(versionError ?? "", /版本/);
  assert.equal((await readState()).name, "版本测试标记");
  await page.click('button:has-text("放弃打开")');
  step("未知版本被拒绝，当前作品保留");

  // —— 解压炸弹：拒绝并保留原作品 ——
  const bombFile = join(tmp, "bomb.orbit");
  await writeFile(bombFile, variants.makeBomb(await readFile(projectEncoded)));
  await openProject(bombFile);
  await page.waitForSelector(".project-panel .error", { timeout: 30000 });
  const bombError = await page.textContent(".project-panel .error");
  assert.match(bombError ?? "", /上限/);
  assert.equal((await readState()).name, "版本测试标记");
  await page.click('button:has-text("放弃打开")');
  step("超大解压体积被拒绝，当前作品保留");

  // —— 缺图：用户主动重新绑定（原图修复） ——
  const missingFile = join(tmp, "missing.orbit");
  await writeFile(missingFile, variants.makeMissingAsset(await readFile(projectEncoded)));
  await openProject(missingFile);
  await page.waitForSelector('button:has-text("重新绑定")', { timeout: 30000 });
  assert.equal((await readState()).name, "版本测试标记", "校验失败时不得改动工作区");
  const [chooser1] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.click('button:has-text("重新绑定")'),
  ]);
  await chooser1.setFiles(join(root, "public", "panorama.jpg"));
  await page.waitForSelector('button:has-text("校验通过，打开工程")', { timeout: 30000 });
  const note1 = await page.textContent(".project-panel");
  assert.match(note1 ?? "", /指纹与记录一致/);
  await page.click('button:has-text("校验通过，打开工程")');
  await page.waitForTimeout(300);
  assert.equal((await readState()).name, savedState.name);
  step("缺图工程经用户重新绑定（指纹一致）后成功打开");

  // —— 素材损坏：重新绑定 ——
  const tamperedFile = join(tmp, "tampered.orbit");
  await writeFile(tamperedFile, variants.makeTamperedAsset(await readFile(projectEncoded)));
  await setState({ ...disturbedState, name: "损坏测试标记" });
  await openProject(tamperedFile);
  await page.waitForSelector('button:has-text("重新绑定")', { timeout: 30000 });
  assert.equal((await readState()).name, "损坏测试标记");
  const [chooser2] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.click('button:has-text("重新绑定")'),
  ]);
  await chooser2.setFiles(join(root, "public", "panorama.jpg"));
  await page.waitForSelector('button:has-text("校验通过，打开工程")', { timeout: 30000 });
  await page.click('button:has-text("校验通过，打开工程")');
  await page.waitForTimeout(300);
  assert.equal((await readState()).name, savedState.name);
  step("损坏素材经重新绑定后恢复，未发生静默换图");

  // —— 用不同的图片重新绑定：显式替换，替换记录可见 ——
  await openProject(tamperedFile);
  await page.waitForSelector('button:has-text("重新绑定")', { timeout: 30000 });
  const [chooser3] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.click('button:has-text("重新绑定")'),
  ]);
  await chooser3.setFiles(exportA); // 另一张图片（此前导出的 PNG）
  await page.waitForSelector('button:has-text("校验通过，打开工程")', { timeout: 30000 });
  const panelText = await page.textContent(".project-panel");
  assert.match(panelText ?? "", /指纹与记录不同/);
  assert.match(panelText ?? "", /已由你重新绑定/);
  assert.match(panelText ?? "", /→/);
  await page.click('button:has-text("校验通过，打开工程")');
  await page.waitForTimeout(300);
  const substituted = await readState();
  assert.equal(substituted.asset?.name, "export-a.png");
  step("换图必须经用户显式确认，替换记录（旧指纹 → 新指纹）可见");

  // —— 离线全程无任何外部请求、无页面异常 ——
  assert.deepEqual(blockedExternal, [], `存在外部请求：${blockedExternal.join(", ")}`);
  assert.deepEqual(pageErrors, [], `页面异常：${pageErrors.join("; ")}`);
  step("全程无外部网络请求、无页面异常（断网复现成立）");

  console.log(`\ne2e 全部通过（${passed} 步）`);
} finally {
  await browser.close();
  server.close();
}
