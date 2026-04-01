# 产品设计：Mindmap（VS Code / Cursor 扩展 + 可选桌面端）

## 愿景

在 **VS Code** 与 **Cursor** 内提供 **WYSIWYG 脑图编辑**：打开 `.jm` / `.mmd` / `.xmind` 即可可视化编辑，保存写回原文件；并支持通过 **MCP（stdio）+ 本机 HTTP 桥** 让 AI 客户端读写当前打开的脑图。

可选 **Electron 桌面模式**（`mindmap_vscode/desktop/`）用于独立运行，能力与扩展侧对齐（以当前实现为准）。

## 目标用户

- 在 IDE 中维护需求/架构/笔记脑图的开发者。
- 使用 Cursor 等 MCP 宿主、希望通过工具批量操作脑图的用户。

## 成功标准（可验证）

- 支持格式：`.jm`（jsMind JSON）、`.mmd`（约定 Mermaid mindmap 子集）、`.xmind`（读取/保存，结构级操作按实现策略受限）。
- `.mmd` / `.jm` 通过 **CustomTextEditor** 与 `TextDocument` 集成，具备标准脏标记与保存流。
- MCP 三工具形态对齐 Pencil 习惯：`get_editor_state`、`batch_get`、`batch_design`。
- 桥接仅监听 **127.0.0.1**，需 **token** 鉴权。

## UI 与交互概述（非几何权威）

- **壳层类型**：**IDE 内单窗口多标签 SDI**（每个脑图对应工作台中的一个编辑器标签）；画布 UI 运行在 **Webview 页面内**，与 VS Code / Cursor **顶层菜单栏、原生侧栏**相互独立。
- **单页 SDI（页面内）**：在一个 Webview「文档」里，采用 **单文档界面（SDI）** 布局——**中央一块主画布客户区**承载当前脑图，**不是**经典 MDI 的「父框架 + 多子文档窗」形态。
- **左侧 Dock（基础功能）**：独立 **Dock** 容器（`dockLeft`），**缘条**与 **显示区** 分列：显示区承载 **新建 / 打开 / 保存 / 另存为** 等基础入口，缘条承载折叠/展开柄；可折叠为窄图标列（见 README 与 `panel.ts`）。
- **右侧 Dock 栈（多功能）**：多个 **Dock** 并列（如 **格式、图标、脑图主题**），各自 **显示区** 与 **缘条**，**缘条** 置于窗口最右侧；可折叠/展开（见 `mindmap_vscode/README.md` 与 `panel.ts`）。
- **壳层分工**：**IDE 宿主**负责工作台标签标题/圆点、部分命令注册的快捷键、以及（在特定场景下）IDE **状态栏**上的「脑图未保存」等条目；**页面内客户区**负责 Webview 内 **顶部菜单栏**（含 Language / Theme）、左/右 Dock、**中间 jsMind 画布**、页内 **底部状态栏**（含日志入口）。详见 `mindmap_vscode/README.md` 与 `.cursor/rules/window-gui-documentation.mdc`。
- 「xmind 风格」下结构级菜单入口可隐藏，仍可通过快捷键/右键/粘贴等改结构（以 `mindmap_vscode/README.md` 与实现为准）。

> UI 几何若后续以 `ui.svg` 为权威，物理层 UML 不得替代该 SVG；当前仓库以扩展 README 与 Webview 实现为描述来源。
