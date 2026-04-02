# 映射：mindmap-vscode-extension → 源码

| 模型/能力 | 路径 |
|-----------|------|
| 扩展激活、命令注册、AI 命令；**`onWillSaveTextDocument` → `flushPendingWebviewEditsForDocument`**（脑图 `.mmd`/`.jm` 保存前合并画布） | `mindmap_vscode/src/extension.ts` |
| MCP HTTP 桥、schema 文本 | `mindmap_vscode/src/bridge.ts` |
| Webview 面板（HTML 壳模板、`#mindmapAppShell`、`asWebviewUri`、换树/MCP/消息）、MCP 持久化提示、格式/主题 Dock、视图平移与 ResizeObserver、`mindmap:requestToggleFullScreen`（宿主 → **`toggleMaximizeEditorGroup`**）；`documentIsMindmapBuffer`、`flushPendingWebviewEditsForDocument` / `flushAllPendingWebviewEditsToDocument` | `mindmap_vscode/src/panel.ts` |
| Webview 主脚本（jsMind、画布、Dock、三色灯、`#mindmapAppShell` 全屏、`relayoutMindAfterVisuals`、`resetZoom`/`resetPanToOrigin`/`centerRoot`/`fitAll`、滚轮指针锚点缩放、`zoomByStep`、`installCanvasVisibilityAndDockSplitter` 等） | `mindmap_vscode/media/webview-app.js` |
| Webview 主题早置（`data-mm-ui`） | `mindmap_vscode/media/webview-theme-init.js` |
| 本地 HTTP 调试页热更新（轮询 `web_dev_meta.json`） | `mindmap_vscode/media/web-dev-livereload.js`（仅 `out/web_dev.html` 引用） |
| 页内 Toolbar（`htoolbarGroupFile` 文件四钮一组、溢出菜单 `htoolbarOverflowMenu`） | `mindmap_vscode/src/panel.ts`（模板 + 样式）；`mindmap_vscode/media/webview-app.js`（`mmUpdateHtoolbarOverflowVisibility`、`toolbarAction*`、`toolbarGroupFile` i18n） |
| `mainRow` 分割条 `#mainRowSplitter`（拖宽 Dock、**不**持久化宽度；双击恢复默认）；画布左上 `#canvasShortcutHints`（默认折叠，**不**持久化折叠态）；画布右上 `#canvasVisibilityPanel`（默认展开，**不**持久化）；图层勾选默认全开（**不**持久化） | `mindmap_vscode/src/panel.ts`（DOM/CSS）；`mindmap_vscode/media/webview-app.js`（`installCanvasVisibilityAndDockSplitter`） |
| 右侧 Dock Area（`#dockRightStack`：`#dockAreaView`/`mm-dock-view` + 单一 `#dockFoldStrip`；各 `aside` 仅 `dock-display`；`syncDockFoldStripButtons`） | `mindmap_vscode/src/panel.ts`；`mindmap_vscode/media/webview-app.js`（`apply*DockClosed`、`Window` 菜单 `menuShowDock*`） |
| CustomTextEditor | `mindmap_vscode/src/mindmapCustomTextEditor.ts` |
| 视图类型常量 | `mindmap_vscode/src/mindmapEditorViewType.ts` |
| Cursor `mcp.json` 合并 | `mindmap_vscode/src/mcpCursorConfig.ts` |
| 树模型与格式、空白树工厂 `createBlankMindmapTree` | `mindmap_vscode/src/mindmap/model.ts` |
| 共享核心（解析/序列化、空白树 `createBlankCoreMindmapTree`） | `mindmap_vscode/src/shared/mindmapCore.ts` |
| jsMind 运行时（含布局补丁：左侧子节点 `reverse`） | `mindmap_vscode/media/jsmind/jsmind.js` |
| 贡献点与元数据 | `mindmap_vscode/package.json` |
| 安装脚本（默认 build + install） | `mindmap_vscode/install.py` |
| Electron 壳、`mindmap:hostFilePath`、套壳 HTML | `mindmap_vscode/desktop/main.js` |
| 网页调试 HTTP、`/` → `out/web_dev.html`、模板抽取与占位符替换、`boot.extensionVersion` | `mindmap_vscode/run_web.py`、`mindmap_vscode/scripts/gen_web_dev_html.js` |
| 从 `panel.ts` 抽取 Webview 主脚本（一次性维护/迁出用） | `mindmap_vscode/scripts/extract-webview-app.py`（可选） |
