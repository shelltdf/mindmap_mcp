# 用户说明书

## 环境

- **VS Code** 或 **Cursor**，版本需满足扩展 `engines.vscode`（见 `mindmap_vscode/package.json`）。
- 使用 MCP 时：本机需可用 **Node** 以启动 `mcp-server`；IDE 需加载本扩展且桥接已启用。

## 基本使用

1. 安装扩展（市场或 VSIX，见开发者手册）。
2. 打开 `.mmd` / `.jm` / `.xmind`，或使用命令 **`Mindmap: Open Mindmap Editor`**。
3. 保存：`Ctrl/Cmd+S`；空白脑图首次保存会走另存为。
4. 新建文件：命令 **`Mindmap: New Mindmap File…`** 或状态栏「脑图」按钮（可在设置中关闭）。

## MCP（Cursor 等）

1. 在扩展中执行 **`Mindmap: Show MCP Bridge Info`** 复制 `MINDMAP_BRIDGE_URL` 与 `MINDMAP_BRIDGE_TOKEN`。
2. 执行 **`Mindmap: Configure Cursor MCP (Workspace)`** 或 **(User)** 写入 `mcp.json`。
3. 重载窗口；在 MCP 列表中确认 `user-mindmap`（名称以实际配置为准）。
4. 读写脑图前请先打开脑图编辑器面板。

更完整的菜单、快捷键、未保存行为与排障见 **`mindmap_vscode/README.md`**（实现侧用户文档，与本节互补）。
