// 纯逻辑测试启动器：用 esbuild 把 TS 测试与源码打包为 ESM 后在 Node 中运行。
// .vue 文件被打桩为空模块——测试只覆盖不依赖 DOM 的部分。
import { build } from "esbuild";
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outfile = join(root, "node_modules", ".cache", "orbit-project-spec.mjs");

const vueStub = {
  name: "vue-stub",
  setup(b) {
    b.onResolve({ filter: /\.vue$/ }, (args) => ({
      path: args.path,
      namespace: "vue-stub",
    }));
    b.onLoad({ filter: /.*/, namespace: "vue-stub" }, () => ({
      contents: "export default {}",
    }));
  },
};

await build({
  entryPoints: [join(root, "tests", "spec.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile,
  plugins: [vueStub],
  logLevel: "warning",
});

await import(pathToFileURL(outfile).href);
