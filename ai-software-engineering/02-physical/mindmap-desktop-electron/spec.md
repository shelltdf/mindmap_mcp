# 规格：mindmap-desktop-electron

## 能力范围（与实现对齐）

- 支持 `.mmd` / `.jm` 打开、编辑、保存、另存为（见扩展 README「桌面模式」章节）。
- **新建空白脑图**：根节点 id 每次为新（`r_` 前缀 + 随机），子节点为空；与扩展侧 `createBlankMindmapTree` 策略一致（实现见 `desktop/main.js` 的 `defaultTree`、`desktop/renderer/renderer.js` 的 `newTree`）。
- 依赖扩展根目录 TypeScript 编译产物供共享逻辑使用（`run.py` 在启动/打包前执行 `npm run compile`）。

## 构建目标

- `python run.py`：开发启动（`npm run start` in `desktop/`）。
- `python run.py --build-desktop --target win|linux|mac`：平台打包。

## MCP HTTP 桥（与扩展同源协议）

- 业务与请求解析与扩展共用 **`src/shared/mcpBridgeCore.ts`**（编译为 `dist/shared/mcpBridgeCore.js`）；扩展在 `src/bridge.ts` 绑定 VS Code 面板，桌面在 `desktop/mcpBridge.js` 绑定 Electron 窗口。
- 主进程启动本机 HTTP 服务：`POST /mcp-bridge/v1/call`（默认 `127.0.0.1:58741`，可用 `MINDMAP_BRIDGE_PORT` / `MINDMAP_DESKTOP_BRIDGE_PORT` 覆盖）；请求体含 `token`、`method`、`arguments`，与 `mcp-server` 客户端约定一致。
- Token 持久化路径：`app.getPath('userData')` 下 `mindmap-desktop-mcp-token.txt`（首次生成）；顶区右键菜单可复制 `MINDMAP_BRIDGE_URL` / `MINDMAP_BRIDGE_TOKEN` 及 `node mcp-server/dist/index.js` 示例。
- `get_editor_state` 返回的 `editor` 字段为 **`mindmap-desktop`**，与扩展宿主的 **`mindmap-vscode`** 区分。
- 与扩展**勿同时占用**同一桥端口；二者二选一常驻即可。

## 边界

- 桌面与扩展为**并列宿主**，非互相替代；文档推荐以桌面为 MCP/独立编辑首选时，扩展路径仍保留构建与 VSIX 安装。
