# 物理阶段索引（02-physical）

实现源码根：`mindmap_vscode/`（仓库内、**不在**本目录下）。

| target-id | 产物类型 | 说明 |
|-----------|----------|------|
| [mindmap-vscode-extension](./mindmap-vscode-extension/) | VSIX / 扩展包 | VS Code/Cursor 扩展主入口、`dist/extension.js`、Webview 资源、内嵌桥 |
| [mindmap-mcp-stdio](./mindmap-mcp-stdio/) | Node 可执行脚本 | `mcp-server/dist/index.js`，stdio MCP |
| [mindmap-desktop-electron](./mindmap-desktop-electron/) | Electron 应用 | `desktop/` 打包产物（平台相关） |
