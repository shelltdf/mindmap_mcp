# 详细设计：编辑器与宿主

## 打开路径

- **`.mmd` / `.jm`**：`vscode.openWith` → `mindmap.customTextEditor`（`MindmapCustomTextEditorProvider`）。
- **`.xmind` / 无文件**：`MindmapPanel.createOrShow` Webview 面板；空白树默认主题文案随实现。

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
