# 系统设计

## 子系统划分

1. **IDE 宿主集成**：扩展激活、命令注册、配置、状态栏、快捷键、关窗/退出与未保存协作。
2. **编辑运行时**：Webview 内 jsMind 与宿主消息通道；CustomTextEditor 与文档缓冲同步。
3. **AI/MCP 通道**：stdio MCP 子进程 ↔ 本机 HTTP 桥 ↔ 当前聚焦 `MindmapPanel` ↔ Webview `ai*` 能力。
4. **桌面运行时**：Electron 复用共享脑图逻辑，独立窗口与本地文件（详见 `02-physical/mindmap-desktop-electron/`）。

## 与概念阶段对应

- 产品范围与格式：`00-concept/product-design.md`、`database-design.md`
- 对外接口形状：`00-concept/interface-design.md`

## 与物理阶段对应

每个可交付物在 `02-physical/<target-id>/` 有 `spec.md` 与映射；本文件不重复字段级规格。

## 关键全局约束

- 桥与 MCP **不得**依赖公网；默认 **127.0.0.1**。
- **多开面板**时，桥与 AI 命令以 **当前聚焦面板** 为准（`MindmapPanel.currentPanel`）。
- `batch_get` / `batch_design` 前：若需持久化策略（有路径且脏），由面板侧 `autoSaveForMcpBridgeIfNeeded` 等逻辑处理（见详细设计）。
