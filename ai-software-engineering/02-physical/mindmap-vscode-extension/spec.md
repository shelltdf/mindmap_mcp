# 规格：mindmap-vscode-extension

## 对外可见行为（摘要）

- **publisher / name**：以 `mindmap_vscode/package.json` 为准（当前示例：`av-ai-dev` / `mindmap-vscode`，版本 `0.0.140`）。
- **自定义编辑器 ID**：`mindmap.customTextEditor`；匹配 `*.mmd`、`*.jm`。
- **桥接监听**：`127.0.0.1:{mindmap.mcpBridge.port}`，默认端口 `58741`；可用配置关闭 `mindmap.mcpBridge.enable`。
- **桥接端点**：仅接受 `POST /mcp-bridge/v1/call`；其它路径 404。
- **鉴权**：body JSON `token` 必须与扩展当前 token 完全一致，否则 401 `unauthorized`。
- **请求体上限**：约 2 MiB；超出返回 413。

## 重要过程

1. **激活**（`extension.ts` `activate`）：注册 CustomEditor、命令、MCP 桥、AI 命令、状态栏；`MindmapPanel.setExtensionContext`。
2. **MCP 读/写前**：`batch_get` / `batch_design` 调用 `panel.autoSaveForMcpBridgeIfNeeded()`，失败则桥返回 `ok: false`；必要时 `showMcpPersistNoticeIfNeeded()`。
3. **停用 / 关闭**：`deactivate` 与 `onWillShutdown` 路径刷新挂起编辑、持久化脏状态（见实现）。

## 错误语义（桥接）

- 面板未打开且方法非 `get_editor_state`：`ok: false`，错误文案包含 `Mindmap panel is not open`（以代码为准）。
- `batch_design`：`operations` 空/非 JSON/非数组 → `ok: false` 与对应错误信息。

## 边界

- MCP 工具里的 `filePath`：**忽略**，始终使用当前聚焦面板。
- `get_editor_state` 在无面板时**不**因 MCP 子进程缺少 token 而由桥判断——token 校验先于 method 分发；MCP 层在 token 为空时直接抛错。
