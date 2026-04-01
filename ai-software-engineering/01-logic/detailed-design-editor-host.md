# 详细设计：编辑器与宿主

## 打开路径

- **`.mmd` / `.jm`**：`vscode.openWith` → `mindmap.customTextEditor`（`MindmapCustomTextEditorProvider`）。
- **`.xmind` / 无文件**：`MindmapPanel.createOrShow` Webview 面板；空白树默认主题文案随实现。

## 空白 / 新建与根节点

- **默认空白树**由 `createBlankMindmapTree()` / `createBlankCoreMindmapTree()` 生成：仅根节点、无子节点；根 **id 每次新建**（`r_…`），与固定字符串 `root` 脱钩，避免会话间混用同一根 id。
- **Webview `init`**：在实例化 jsMind 前清空画布容器 DOM 并重置框选与选中，保证换树后为干净画布。
- **换树与闪烁**：扩展侧在 Webview **首次** `mindmap:ready` 之前必须将树注入 **HTML**；就绪后同一面板再换树（新建、打开等）仅 **`postMessage(mindmap:setTree)`**，避免反复 **`webview.html = …`** 导致整页白屏闪烁。

## 视图：平移缩放与客户区尺寸

- 外层对 `#jsmind_container` 使用 `translate(panX, panY) scale(zoom)`（`applyViewTransform`）。
- **客户区-only 尺寸变化**（非缩放）：`ResizeObserver` 监听 `#canvasWrap`，按 **Δw/2、Δh/2** 修正 `pan`，保持**视口中心**下所见内容稳定；`centerRoot` / `fitAll` 等重算 pan 后同步「锚点」尺寸，避免双计。

## 右 Dock：格式 / 图标 / 脑图主题

- **格式**：绑定当前选中节点；无选中则禁用并清空。展示值优先 `node.data`，否则从 DOM 读**非选中态**计算样式（避免高亮色）；颜色归一为 hex。
- **全屏**：页面内 **Ctrl+Space**（及标题栏按钮）经宿主执行 **工作台全屏**；与 `package.json` 全局 **Ctrl+Space → toggleDock** 并存，焦点在 Webview 时通常由页面消费。

## 快捷键与无效操作反馈

- 画布 **快捷键**路径下，`notifyInvalidAction` 仅更新状态栏并写 **Log**，不弹模态「操作提示」；**菜单 / 工具栏**路径仍可弹窗。实现用 `invalidActionKeyboardContext`（`keydown` 监听 `try/finally`）区分。

## 方向键与选中导航（画布内）

- **无修饰键**且焦点在画布区域：`↑`/`↓` 在同级兄弟间切换选中（根无兄弟）；`←` 选中父节点；`→` 选中第一个子节点。
- **`Alt` + 方向键**仍为调整兄弟顺序与提升/下降，与上述导航区分。

## Webview 单页布局（SDI 与 Dock）

- **SDI**：`panel.ts` 注入的 HTML 在 **单个** Webview 文档内排布：顶栏菜单、`mainRow`（左 Dock + 中央画布 + 右 Dock）、底栏状态栏；**一个标签页对应一份**当前脑图会话，中央画布为唯一主编辑客户区（非 MDI 子窗）。
- **左 Dock**（`#dockLeft`）：**缘条** `dock-edge`（折叠柄）与 **显示区** `dock-display`（新建/打开/保存/另存为等）为兄弟节点；与文件/会话入口强相关。
- **右 Dock**（`#dockRight`）：**显示区** + **缘条**（缘条贴窗口最右）；**多功能**——属性与扩展能力（Format / Icon 等 Tab，可继续加 Tab 或分区），与左侧语义分离。
- 左右 Dock 的折叠与 `mindmapVscode.toggleDock`（最大化编辑区）联动策略见扩展 README 与 `panel.ts`。

## 多标签与复用

- 不同磁盘路径：新开面板实例。
- 同一路径：聚焦已有实例，不强制从磁盘重载（避免覆盖未保存编辑）。
- 无路径空白：每次命令可新开会话（见扩展 README）。

## 脏状态与关闭

- CustomTextEditor：依赖工作台 `TextDocument` 脏标记与保存。
- 纯 Webview / xmind：标题 `·`、状态栏提示；快捷键关闭路径下扩展拦截保存对话框策略见 `extension.ts` / `panel.ts` 与 README。

## Dock 最大化

`mindmapVscode.toggleDock`：联动侧栏/面板/辅助边栏/状态栏可见性，再聚焦编辑器与当前面板。
