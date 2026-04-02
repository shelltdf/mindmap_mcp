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
- **滚轮缩放**：以**鼠标指针在 `#canvasWrap` 内的坐标**为锚（与 `window-gui-documentation.mdc` 2D 画布一致）。**加减按钮**（`zoomByStep`）与 **还原缩放**以**视口中心**为锚。
- **还原缩放（`resetZoom`）**：仅将比例拉回 100%，以**当前视口中心**为锚调整 `pan`，**不**为对齐根节点而平移整图。
- **原点（`resetPanToOrigin`）**：左下第二钮——**不改变** `zoomScale`，按当前缩放将 **图元包围盒中心** 对齐视口中心（`getMindmapContentBoundsPx` + `applyPanToCenterContentBounds`，与 `fitAll` 居中段同一公式）；无节点时退化为 `panX=panY=0`。**根节点居正**仍为 **`centerRoot`**（对齐根心，非包围盒中心），入口：画布右键 / **视图** 菜单。
- **主行分割条**：`#mainRowSplitter` 拖动调整 `#dockRightStack` 宽度（**不**写入 `localStorage`，新开/重载为默认宽）；**双击**清除本次内联宽度。**`resize`** 时若存在内联 `width` 仅做钳位。三 Dock **均在 Dock View 内折叠或关闭**时：`#dockRightStack` 加 **`mm-dock-stack-fold-only`**，**`#dockAreaView` 隐藏**，右栏仅 **缘条**；分割条 **`mm-main-row-splitter-inactive`**（与 `updateMainRowSplitterInteractable` 同步）。
- **左上快捷键面板**：`#canvasShortcutHints` 可折叠/展开（默认折叠，**不**持久化）；`#canvasShortcutHintsBody` 为完整列表区，**非**悬停悬浮层唯一入口。
- **右上可见性**：`#canvasVisibilityPanel` 可折叠/展开（默认展开，**不**持久化）；内部勾选控制网格层、快捷键条、缩放条显示（默认全开，**不**持久化）。

## 节点标题内联编辑

- **Esc**：`webview-app.js` 在 **`input.jsmind-editor`** 上拦截 **`Escape`**，写回 **`editing_node.topic`** 后 **`jm.end_edit()`**，依赖 jsMind **`edit_node_end`** 在文本未变时不 **`update_node`**（取消而非提交）。

## 右 Dock：格式 / 图标 / 脑图主题

- **格式**：绑定当前选中节点；无选中则禁用并清空。展示值优先 `node.data`，否则从 DOM 读**非选中态**计算样式（避免高亮色）；颜色归一为 hex。
- **全屏**：页面内 **Ctrl+Space**（及标题栏按钮）经宿主执行 **工作台全屏**；与 `package.json` 全局 **Ctrl+Space → toggleDock** 并存，焦点在 Webview 时通常由页面消费。

## 快捷键与无效操作反馈

- 画布 **快捷键**路径下，`notifyInvalidAction` 仅更新状态栏并写 **Log**，不弹模态「操作提示」；**菜单 / 工具栏**路径仍可弹窗。实现用 `invalidActionKeyboardContext`（`keydown` 监听 `try/finally`）区分。

## 方向键与选中导航（画布内）

- **无修饰键**且焦点在画布区域：`↑`/`↓` 在同级兄弟间切换选中（根无兄弟）；`←` 选中父节点；`→` 选中第一个子节点。
- **`Alt` + 方向键**仍为调整兄弟顺序与提升/下降，与上述导航区分。

## Webview 脚本与布局（与物理规格一致）

- **拆分**：可执行逻辑主要在 `media/webview-app.js`；`panel.ts` 生成带外链与 boot JSON 的 HTML；资源 URL 经占位符替换为 `asWebviewUri`（见 `02-physical/mindmap-vscode-extension/spec.md`）。
- **样式后布局**：节点格式变更后需 `layout.layout()` + `view.relayout()`，避免根→一级几何与连线脱节（同 spec）。

## Webview 单页布局（SDI 与 Dock）

- **SDI**：`panel.ts` 注入的 HTML 在 **单个** Webview 文档内排布：顶栏菜单、`mainRow`（**中央画布 `#canvasWrap` | 分割条 `#mainRowSplitter` | 右 `#dockRightStack`**）、底栏状态栏；**一个标签页对应一份**当前脑图会话，中央画布为唯一主编辑客户区（非 MDI 子窗）。
- **Toolbar**：页内 **`#htoolbar`**（在 **Dock Area 外**），菜单栏之下、主行之上；**新建/打开/保存/另存为** 置于 **`#htoolbarGroupFile`** 单组，组内无分隔；窄宽度时 **溢出按钮 + 悬浮菜单**（与 `window-gui-documentation.mdc` Toolbar 专节一致）。
- **右 Dock Area**（`#dockRightStack`，`dock-area`）：**`mm-dock-view`（`#dockAreaView`）** 与 **单一 `dock-fold-strip`（`#dockFoldStrip`）** 为兄弟，顺序 **显示区叠放多个 Dock | 折叠条带（贴窗右）**。各 **`aside.dock-right`** 内仅 **`dock-display dock-view`**；**Dock Button** 全部在 **`dock-fold-strip`**；标题栏 **折叠 / 最大化 / 关闭**；**窗口** 菜单可重新打开被关闭的 Dock；条带按钮状态由 **`mm-dock-edge-expanded` / `mm-dock-fold-btn-hidden`** 与脚本 `syncDockFoldStripButtons` 同步。
- 左右 Dock 的折叠与 `mindmapVscode.toggleDock`（最大化编辑区）联动策略见扩展 README 与 `panel.ts`。

## 多标签与复用

- 不同磁盘路径：新开面板实例。
- 同一路径：聚焦已有实例，不强制从磁盘重载（避免覆盖未保存编辑）。
- 无路径空白：每次命令可新开会话（见扩展 README）。

## 脏状态与关闭

- CustomTextEditor：依赖工作台 `TextDocument` 脏标记与保存；画布改动经 `mindmap:edited` **防抖**写入文档，扩展在 **`onWillSaveTextDocument`** 中对当前 `.mmd`/`.jm` **先 flush** 再写盘，与 `deactivate`/`onWillShutdown` 中的全量 flush 一致，避免保存竞态导致「已保存仍脏」。
- 纯 Webview / xmind：标题 `·`、状态栏提示；快捷键关闭路径下扩展拦截保存对话框策略见 `extension.ts` / `panel.ts` 与 README。

## Dock 最大化

`mindmapVscode.toggleDock`：联动侧栏/面板/辅助边栏/状态栏可见性，再聚焦编辑器与当前面板。
