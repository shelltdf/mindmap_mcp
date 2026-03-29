# 详细设计：持久化与格式

## 责任划分

- **模型层**（`src/mindmap/model.ts` 等）：`parseMindmapText`、`serializeMindmapTree`、`parseMindmapXmindFile` 等与格式相关的纯逻辑/IO 抽象。
- **编辑器层**：将模型变更写回 `TextDocument` 或面板保存路径；触发磁盘写入与用户对话框。

## Mermaid 子集

实现遵循「简单缩进式」`mindmap`：根与层级标题的约定见扩展 README；与标准 Mermaid 全集的兼容性以代码与测试为准。

## 外部修改

对已绑定路径监听文件系统事件；面板可见时节流复检；`mtime` 与扩展基准比较后弹窗选择重载或保留（见实现）。

## 与运维文档的交叉引用

用户侧「如何保存/另存为」见 `03-ops/user-manual.md`；开发者侧构建与打包见 `03-ops/developer-manual.md`。
