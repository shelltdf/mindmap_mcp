# 开发维护说明书

## 仓库布局

- **工程文档（本规则约束）**：`ai-software-engineering/`
- **实现子项目**：`mindmap_vscode/`（扩展 + MCP 包 + 桌面）

## 构建与安装（扩展）

在 `mindmap_vscode/` 目录：

- **构建 VSIX**：`python build.py`（内部调用 `npm` / `vsce` 等，见脚本全文）。
- **安装**：`python install.py`

或直接 `npm run compile`、`npm run vscode:prepublish`（会编译并 `mcp:pack`）。

## 桌面模式

在 `mindmap_vscode/`：

- 开发运行：`python run.py`
- 打包：`python run.py --build-desktop --target win|linux|mac`

## 网页调试（本地 HTTP）

在 `mindmap_vscode/`：

- 启动：`python run_web.py`（根路径 `/` 即脑图调试页；默认不修改 `package.json`；需要 bump 时加 `--bump-version`。热更新依赖编译与 watch。详见 `mindmap_vscode/README.md`）
- 用于不经过 VSIX、在浏览器或 Simple Browser 中调试 Webview 同源模板；与扩展宿主能力（`acquireVsCodeApi`）不一致处以 README 说明为准。

## 依赖

- Node.js / npm；扩展依赖见 `package.json`；MCP 子包见 `mcp-server/package.json`。

## 第三方许可证

- 仓库根目录 [`THIRD_PARTY_LICENSES.md`](../../THIRD_PARTY_LICENSES.md)：**运行时/交付物**相关依赖与资产摘要；变更 `dependencies` 或随包资源时请同步更新该文件。

## 版本与变更日志

- 扩展版本字段：`mindmap_vscode/package.json` → `version`
- `build.py` 可维护 `doc/CHANGELOG.md`（若存在）

## 工程脚本缺口（相对 multi-implementation 规则）

当前实现目录提供 **`build.py` / `run.py` / `run_web.py` / `install.py`**，**未**提供根目录约定的独立 `test.py` / `publish.py`。若需对齐团队规范，可后续以薄封装脚本调用 `npm test`（如有）与 `vsce publish`。

## 诊断

- 扩展命令 **`Mindmap: Diagnose MCP Setup`**：输出路径、`mcp.json`、入口文件是否存在等。
