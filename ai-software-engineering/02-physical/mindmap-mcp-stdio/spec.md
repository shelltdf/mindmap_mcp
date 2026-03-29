# 规格：mindmap-mcp-stdio

## 运行时环境变量

| 变量 | 说明 |
|------|------|
| `MINDMAP_BRIDGE_URL` | 默认 `http://127.0.0.1:58741`；实现会去掉末尾 `/` |
| `MINDMAP_BRIDGE_TOKEN` | **必填**（非空）；否则工具调用前抛错 |

## 工具契约（与 SDK 声明一致）

- **`get_editor_state`**  
  - 参数：`include_schema` boolean（required in schema）  
  - 行为：POST `method=get_editor_state`，`arguments` 透传。

- **`batch_get`**  
  - 可选：`filePath`、`nodeIds`、`readDepth`、`patterns`  
  - `filePath` 描述为忽略，仍可按实现透传。

- **`batch_design`**  
  - 必填：`operations`（string）  
  - 可选：`filePath`、`dryRun`、`transaction`、`strict`

## 桥接调用格式

`POST {BRIDGE_URL}/mcp-bridge/v1/call`  
Body：`{ "token", "method", "arguments" }`  
成功：解析 JSON，`ok: true` 时返回 `result` 序列化为工具文本内容。

## 服务元数据

- MCP Server `name`：`mindmap-vscode`（`mcp-server/src/index.ts` 内版本 `0.1.0` 为服务器自报版本，可与扩展版本独立）。
