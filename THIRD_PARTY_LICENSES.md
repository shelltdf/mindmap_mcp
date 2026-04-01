# 第三方许可证汇总（运行时 / 交付物）

本文件按仓库规则 [`.cursor/rules/third-party-licenses.mdc`](.cursor/rules/third-party-licenses.mdc) 维护，收录**进入可运行或可分发包**的第三方依赖；**开发专用**工具链（如 `devDependencies`、TypeScript、测试框架）不逐项列入，除非同时进入最终产物。

**复现更新（扩展 + MCP 子包生产依赖）**：在已安装 Node.js 的前提下，于 `mindmap_vscode/` 执行 `npm install` 与 `npm install --prefix mcp-server`，并以各 `package.json` 的 `dependencies` 为准核对版本。

---

## VS Code / Cursor 扩展（`mindmap_vscode/package.json` → `dependencies`）

| 包名 | 声明版本 | 许可证（以包内 `package.json` 为准） |
|------|----------|----------------------------------------|
| adm-zip | 0.5.16 | MIT |
| jsmind | 0.9.1 | BSD-3-Clause |

**数字资产**：`jsmind` 随包提供的前端脚本/样式在构建/调试时复制到 `mindmap_vscode/media/jsmind/`，许可证同上。

---

## MCP stdio 子包（`mindmap_vscode/mcp-server/package.json` → `dependencies`）

| 包名 | 声明范围 | 说明 |
|------|----------|------|
| @modelcontextprotocol/sdk | ^1.12.0 | 以 `mcp-server/node_modules/@modelcontextprotocol/sdk/package.json` 中 `license` 字段为准（常见为 MIT）。 |

---

## Electron 桌面产物（`mindmap_vscode/desktop/`）

桌面安装包/便携版由 **electron-builder** 构建，运行时捆绑 **Electron**（在 `desktop/package.json` 中为 `devDependencies`，但**进入最终桌面分发物**）。完整第三方清单体量大，请以 **Electron 官方**及 **electron-builder** 随版本提供的许可证与 NOTICES 为准；构建日志输出目录见 `desktop/package.json` 的 `build.directories.output`（默认相对为 `mindmap_vscode/out/desktop`）。

---

## 免责声明

本汇总用于**事实收集与可追溯**，不构成法律意见；许可证兼容性以各包官方声明及你的使用场景为准。
