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

- 中间 **jsMind canvas**，菜单栏 / 工具栏 / 属性区；默认侧栏为缩小态。
- 「xmind 风格」下结构级菜单入口可隐藏，仍可通过快捷键/右键/粘贴等改结构（以 `mindmap_vscode/README.md` 与实现为准）。

> UI 几何若后续以 `ui.svg` 为权威，物理层 UML 不得替代该 SVG；当前仓库以扩展 README 与 Webview 实现为描述来源。
