# 详细设计：MCP 与 HTTP 桥

## 流程概要

1. Cursor/VS Code 按 `mcp.json` 启动 **Node** 运行 `mcp-server/dist/index.js`。
2. MCP 工具调用时，子进程对 `MINDMAP_BRIDGE_URL/mcp-bridge/v1/call` 发起 `POST`。
3. 扩展内 `startMindmapMcpBridge(port, token)` 校验 `token`，分发 `method` 到 `handleBridgeCall`。
4. `get_editor_state`：无面板时返回 `active: false`；有面板则拉取选中等信息。
5. `batch_get` / `batch_design`：先执行面板侧 MCP 持久化/提示逻辑，再调用 `aiGetTree` / `aiApplyOps`。

## 失败与回滚

- `batch_design`：`transaction` 默认 **true**（与桥接实现一致）——任一步失败可触发整批回滚（由 Webview/面板实现）。
- `strict` 默认 **true**：错误附带 `failedIndex`、`failedOp`、`partialResults`（经 `webviewData` 传递）。

## Cursor 配置自动化

`mcpCursorConfig.ts`：合并写入工作区或用户 `mcp.json`，`args` 指向扩展安装目录下 `mcp-server/dist/index.js`；策略由 `mindmap.mcpBridge.cursorConfig` 控制。

## 与 MCP 工具参数的已知约定

- `get_editor_state` 的 MCP schema 要求 **`include_schema` 必填**（布尔）；桥接使用 `include_schema` 键。
- `batch_design.operations` 必须是 **字符串**，内容为 JSON 数组。
