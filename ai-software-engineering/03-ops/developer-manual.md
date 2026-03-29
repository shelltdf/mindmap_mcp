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

## 依赖

- Node.js / npm；扩展依赖见 `package.json`；MCP 子包见 `mcp-server/package.json`。

## 版本与变更日志

- 扩展版本字段：`mindmap_vscode/package.json` → `version`
- `build.py` 可维护 `doc/CHANGELOG.md`（若存在）

## 工程脚本缺口（相对 multi-implementation 规则）

当前实现目录提供 **`build.py` / `run.py` / `install.py`**，**未**提供根目录约定的独立 `test.py` / `publish.py`。若需对齐团队规范，可后续以薄封装脚本调用 `npm test`（如有）与 `vsce publish`。

## 诊断

- 扩展命令 **`Mindmap: Diagnose MCP Setup`**：输出路径、`mcp.json`、入口文件是否存在等。
