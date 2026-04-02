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
- **滚轮 / 步进缩放**：以视口中心为锚（`zoomByStep`）。
- **还原缩放（`resetZoom`）**：仅将比例拉回 100%，以**当前视口中心**为锚调整 `pan`（与步进缩放同一几何），**不**整图平移去对齐根节点；对齐根节点由 **`centerRoot`**（UI「根节点」）承担。

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

- **SDI**：`panel.ts` 注入的 HTML 在 **单个** Webview 文档内排布：顶栏菜单、`mainRow`（左 Dock + 中央画布 + 右 Dock）、底栏状态栏；**一个标签页对应一份**当前脑图会话，中央画布为唯一主编辑客户区（非 MDI 子窗）。
- **Toolbar**：页内 **`#htoolbar`**（在 **Dock Area 外**），菜单栏之下、主行之上；分隔条、窄宽度时 **溢出按钮 + 悬浮菜单**（与 `window-gui-documentation.mdc` Toolbar 专节一致）。
- **右 Dock Area**（`#dockRightStack`，`dock-area`）：多个 **Dock**；每 Dock 内 **`dock-view` / `dock-fold-strip`**（实现类名仍为 `dock-display` / `dock-edge`）兄弟排列，DOM 顺序 **客户区 → Dock View → 折叠按钮区域（贴右缘）**；标题栏 **折叠 / 最大化 / 关闭**，**窗口** 菜单可重新打开被关闭的 Dock。
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
