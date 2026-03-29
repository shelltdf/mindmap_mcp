# 接口设计（程序间）

> 不含 GUI 人机细节；GUI 见 `product-design.md` 与扩展 README。

## 1. MCP 工具（stdio 服务 → 扩展内桥）

宿主配置通过 Cursor/VS Code 的 MCP 定义启动 `mcp-server/dist/index.js`，并注入：

- `MINDMAP_BRIDGE_URL`：默认 `http://127.0.0.1:58741`（无尾斜杠，实现会 strip）
- `MINDMAP_BRIDGE_TOKEN`：与扩展内桥一致；为空时 MCP 进程应报错并提示从扩展复制

### 工具列表

| 工具名 | 作用 |
|--------|------|
| `get_editor_state` | 面板是否打开、标题、路径、格式、选中；`include_schema` 为必填布尔（schema 内嵌于桥） |
| `batch_get` | 读树；可选 `nodeIds`、`readDepth`、`patterns`；`filePath` 可选且**忽略** |
| `batch_design` | 批量写；`operations` 为 **JSON 字符串**（op 数组）；可选 `dryRun`、`transaction`（默认 true）、`strict`（默认 true） |

## 2. HTTP 桥（扩展内）

- **监听**：`127.0.0.1`，端口配置项 `mindmap.mcpBridge.port`（默认 `58741`）。
- **路径**：`POST /mcp-bridge/v1/call`
- **请求体 JSON**：`{ "token": string, "method": string, "arguments": object }`
- **响应**：JSON；业务失败时仍可能 HTTP 200，`ok: false` + `error` + 可选 `webviewData`
- **请求体大小上限**：约 2 MiB（实现常量）

### method 取值

- `get_editor_state`
- `batch_get`
- `batch_design`

## 3. VS Code 命令（自动化 / AI）

面向 `MindmapPanel.currentPanel` 的一组命令，包括但不限于：

- `mindmapVscode.aiGetTree` / `aiGetSelection` / `aiAddNode` / `aiUpdateNodeTitle` / `aiDeleteNode`
- `mindmapVscode.aiApplyOps`：`ops` 数组，`dryRun` / `transaction` / `strict`

`aiApplyOps` 的 `action` 集合与桥接 schema 一致：`getTree`、`getSelection`、`select`、`add`、`update`、`delete`、`move`。

## 4. 配置项（扩展 `package.json` contributes）

关键键前缀：`mindmap.mcpBridge.*`、`mindmap.webview.dumpHtml`、`mindmap.statusBar.newMindmapButton`。

具体默认值与枚举以 `mindmap_vscode/package.json` 为准。
