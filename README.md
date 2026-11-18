# ORBIT

安装：`npm install`

本地启动：`npm run dev`

检查：`npm run typecheck`，`npm run build`，`npm test`。

Docker 启动：`docker compose up --build`，打开 http://localhost:8517 。

## 工程文件（.orbit）

「00 / 工程文件」面板可以把当前作品保存为可携带的 `.orbit`
工程文件：原始素材、取景、边缘设置和预览缩略图一并打包，在离线浏览器里
重新打开后继续创作。

- **内容寻址**：素材按 SHA-256 指纹存储，重复引用只保存一份；清单记录格式
  版本与素材规范化版本，未知版本拒绝打开。
- **暂存打开**：打开时先在暂存区验证尺寸、引用和资源完整性，用户确认后
  一次切换整个工作区；缺图、超大解压体积（> 512 MB）或未知版本时保留
  原作品。
- **损坏修复**：损坏/缺失的素材可由用户主动重新绑定，指纹一致视为找回，
  指纹不同会明示替换记录，绝不静默换图。
- **导出一致**：重新打开后导出的图片与保存时的构图、透明边缘一致
  （e2e 验证导出字节完全相同）。
- **素材存储策略**：自动（默认）—— ≤ 16 MB 的 JPG/PNG/WebP 保留原始编码
  （体积小）；否则存工作分辨率无损像素（位精确复现）。可手动覆盖。
  详细对比见 [docs/project-format.md](docs/project-format.md)。

## 测试

- `npm test`：纯逻辑单元测试（ZIP 读写与炸弹防护、SHA-256、清单校验、
  内容寻址去重、暂存校验、重新绑定），无需浏览器。
- `npm run test:e2e`：真实 Chromium 端到端验证（保存 → 断网 → 打开 →
  重新导出一致性、异常工程拒绝、重新绑定流程）。需要先安装浏览器：
  `npx playwright-core install chromium-headless-shell`；若系统缺少运行库，
  可通过 `LD_LIBRARY_PATH` 指向包含 libnss3/libnspr4 等依赖的目录。
