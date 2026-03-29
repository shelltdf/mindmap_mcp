# 数据库 / 存储设计（广义）

本产品的「存储」主要是 **磁盘文件**，无强制中央数据库。

## 文件格式

| 扩展名 | 说明 | 编辑器集成方式（概要） |
|--------|------|------------------------|
| `.jm` | jsMind `node_tree` JSON | CustomTextEditor + TextDocument |
| `.mmd` | 约定缩进式 Mermaid mindmap 子集 | 同上 |
| `.xmind` | ZIP 包内 XML | Webview 面板读写（非 TextDocument 路径） |

## 一致性注意

- 序列化规则、根节点约定、错误语义以 **`02-physical/` 各目标 `spec.md`** 与源码为准。
- 外部程序修改文件：扩展侧通过 `FileSystemWatcher` 与可见性节流复检（见 `panel` / 扩展逻辑）。

## 工作区状态

- 扩展使用 `globalState` / `workspaceState` 保存 MCP token、关窗未保存提示等键（详见实现与运维文档）。
