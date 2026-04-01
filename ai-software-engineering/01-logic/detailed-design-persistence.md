# 详细设计：持久化与格式

## 责任划分

- **模型层**（`src/mindmap/model.ts` 等）：`parseMindmapText`、`serializeMindmapTree`、`parseMindmapXmindFile` 等与格式相关的纯逻辑/IO 抽象。
- **编辑器层**：将模型变更写回 `TextDocument` 或面板保存路径；触发磁盘写入与用户对话框。
- **CustomTextEditor（`.mmd`/`.jm`）**：画布→缓冲区的同步带防抖；**保存**路径上由 `onWillSaveTextDocument` 在写盘前 **flush** 挂起同步，保证 `TextDocument` 与画布一致后再参与 `isDirty`/落盘（见 `02-physical/mindmap-vscode-extension/spec.md`）。

## Mermaid 子集

实现遵循「简单缩进式」`mindmap`：根与层级标题的约定见扩展 README；与标准 Mermaid 全集的兼容性以代码与测试为准。

## 外部修改

对已绑定路径监听文件系统事件；面板可见时节流复检；`mtime` 与扩展基准比较后：**无未保存修改则自动从磁盘重载**；有未保存修改则跳过重载以免覆盖本地编辑；摘要写入 Webview **Log**，不弹模态框（见 `panel.ts` 实现）。

## 与运维文档的交叉引用

用户侧「如何保存/另存为」见 `03-ops/user-manual.md`；开发者侧构建与打包见 `03-ops/developer-manual.md`。
