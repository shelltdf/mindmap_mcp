# 映射：mindmap-desktop-electron → 源码

| 元素 | 路径 |
|------|------|
| 桌面启动与打包脚本 | `mindmap_vscode/run.py` |
| Electron 主进程 | `mindmap_vscode/desktop/main.js` |
| MCP HTTP 桥（共享逻辑） | `mindmap_vscode/src/shared/mcpBridgeCore.ts` → `dist/shared/mcpBridgeCore.js` |
| MCP HTTP 桥（桌面薄封装） | `mindmap_vscode/desktop/mcpBridge.js` |
| 预加载 | `mindmap_vscode/desktop/preload.js` |
| 渲染进程 | `mindmap_vscode/desktop/renderer/` |
| 桌面包配置 | `mindmap_vscode/desktop/package.json` |
