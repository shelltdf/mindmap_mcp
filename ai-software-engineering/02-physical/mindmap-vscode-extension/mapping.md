# 映射：mindmap-vscode-extension → 源码

| 模型/能力 | 路径 |
|-----------|------|
| 扩展激活、命令注册、AI 命令；**`onWillSaveTextDocument` → `flushPendingWebviewEditsForDocument`**（脑图 `.mmd`/`.jm` 保存前合并画布） | `mindmap_vscode/src/extension.ts` |
| MCP HTTP 桥、schema 文本 | `mindmap_vscode/src/bridge.ts` |
| Webview 面板（HTML 壳模板、`asWebviewUri`、换树/MCP/消息）、MCP 持久化提示、格式/主题 Dock、视图平移与 ResizeObserver、`mindmap:requestToggleFullScreen`；`documentIsMindmapBuffer`、`flushPendingWebviewEditsForDocument` / `flushAllPendingWebviewEditsToDocument` | `mindmap_vscode/src/panel.ts` |
| Webview 主脚本（jsMind、画布、Dock 交互、`relayoutMindAfterVisuals`、`resetZoom`/`centerRoot`/`fitAll`/`zoomByStep` 等） | `mindmap_vscode/media/webview-app.js` |
| Webview 主题早置（`data-mm-ui`） | `mindmap_vscode/media/webview-theme-init.js` |
| 本地 HTTP 调试页热更新（轮询 `web_dev_meta.json`） | `mindmap_vscode/media/web-dev-livereload.js`（仅 `out/web_dev.html` 引用） |
| 左侧基础 Dock（`#dockLeft`：`dock-edge` / `dock-display`） | `mindmap_vscode/src/panel.ts`（模板 HTML + 内联样式） |
| 右侧多功能 Dock（`#dockRight`：`dock-display` / `dock-edge`） | `mindmap_vscode/src/panel.ts`（模板 HTML + 内联样式） |
| CustomTextEditor | `mindmap_vscode/src/mindmapCustomTextEditor.ts` |
| 视图类型常量 | `mindmap_vscode/src/mindmapEditorViewType.ts` |
| Cursor `mcp.json` 合并 | `mindmap_vscode/src/mcpCursorConfig.ts` |
| 树模型与格式、空白树工厂 `createBlankMindmapTree` | `mindmap_vscode/src/mindmap/model.ts` |
| 共享核心（解析/序列化、空白树 `createBlankCoreMindmapTree`） | `mindmap_vscode/src/shared/mindmapCore.ts` |
| jsMind 运行时（含布局补丁：左侧子节点 `reverse`） | `mindmap_vscode/media/jsmind/jsmind.js` |
| 贡献点与元数据 | `mindmap_vscode/package.json` |
| 网页调试 HTTP、`/` → `out/web_dev.html`、模板抽取与占位符替换 | `mindmap_vscode/run_web.py`、`mindmap_vscode/scripts/gen_web_dev_html.js` |
| 从 `panel.ts` 抽取 Webview 主脚本（一次性维护/迁出用） | `mindmap_vscode/scripts/extract-webview-app.py`（可选） |
