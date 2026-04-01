# 映射：mindmap-vscode-extension → 源码

| 模型/能力 | 路径 |
|-----------|------|
| 扩展激活、命令注册、AI 命令 | `mindmap_vscode/src/extension.ts` |
| MCP HTTP 桥、schema 文本 | `mindmap_vscode/src/bridge.ts` |
| Webview 面板、MCP 持久化提示 | `mindmap_vscode/src/panel.ts` |
| 左侧基础 Dock（`#dockLeft`：`dock-edge` / `dock-display`） | `mindmap_vscode/src/panel.ts`（模板 HTML + 内联样式） |
| 右侧多功能 Dock（`#dockRight`：`dock-display` / `dock-edge`） | `mindmap_vscode/src/panel.ts`（模板 HTML + 内联样式） |
| CustomTextEditor | `mindmap_vscode/src/mindmapCustomTextEditor.ts` |
| 视图类型常量 | `mindmap_vscode/src/mindmapEditorViewType.ts` |
| Cursor `mcp.json` 合并 | `mindmap_vscode/src/mcpCursorConfig.ts` |
| 树模型与格式、空白树工厂 `createBlankMindmapTree` | `mindmap_vscode/src/mindmap/model.ts` |
| 共享核心（解析/序列化、空白树 `createBlankCoreMindmapTree`） | `mindmap_vscode/src/shared/mindmapCore.ts` |
| jsMind 运行时（含布局补丁：左侧子节点 `reverse`） | `mindmap_vscode/media/jsmind/jsmind.js` |
| 贡献点与元数据 | `mindmap_vscode/package.json` |
| 网页调试 HTTP、`/` → `out/web_dev.html` | `mindmap_vscode/run_web.py`、`mindmap_vscode/scripts/gen_web_dev_html.js` |
