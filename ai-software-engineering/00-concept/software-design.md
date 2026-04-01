# 软件设计

## 实现落点

源码与构建脚本位于仓库 **`mindmap_vscode/`**（在 `ai-software-engineering/` 之外，见目录边界规则）。

## 主要模块

1. **VS Code 扩展宿主**（`src/extension.ts`）  
   注册自定义编辑器、命令、配置、状态栏、MCP 桥生命周期、AI 命令入口。

2. **自定义文本编辑器**（`src/mindmapCustomTextEditor.ts` 等）  
   针对 `.mmd` / `.jm`：Webview + 文档缓冲区双向同步。

3. **Webview 面板**（`src/panel.ts` + `media/`）  
   空白脑图、`.xmind` 等路径：独立面板；多实例与脏状态策略见扩展 README。页面内为 **单页 SDI**：左 **Dock**（`dockLeft`）；右侧 **`dockRightStack`** 内多个 **Dock**（格式、图标、脑图主题等）；中为 jsMind 画布。首次注入后换树以 `postMessage` 为主，见物理规格 **mindmap-vscode-extension/spec.md**。

4. **数据模型与序列化**（`src/mindmap/model.ts` 等）  
   解析/序列化各格式；与 `shared` 逻辑供桌面复用（`src/shared/mindmapCore.ts`）。

5. **MCP HTTP 桥**（`src/bridge.ts`）  
   `POST /mcp-bridge/v1/call`，将 MCP 子进程请求转发到当前聚焦的 `MindmapPanel`。

6. **MCP stdio 服务**（`mcp-server/src/index.ts`）  
   使用 `@modelcontextprotocol/sdk`，通过环境变量 `MINDMAP_BRIDGE_URL` / `MINDMAP_BRIDGE_TOKEN` 调用桥接。

7. **桌面壳**（`desktop/`）  
   Electron 包装，开发入口 `python run.py`，打包 `python run.py --build-desktop`。

## 依赖要点

- 扩展：`jsmind`、`adm-zip`（xmind）等见根 `package.json`。
- 引擎：`vscode ^1.80.0`。
