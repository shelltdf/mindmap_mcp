# 详细设计：编辑器与宿主

## 打开路径

- **`.mmd` / `.jm`**：`vscode.openWith` → `mindmap.customTextEditor`（`MindmapCustomTextEditorProvider`）。
- **`.xmind` / 无文件**：`MindmapPanel.createOrShow` Webview 面板；空白树默认主题文案随实现。

## 多标签与复用

- 不同磁盘路径：新开面板实例。
- 同一路径：聚焦已有实例，不强制从磁盘重载（避免覆盖未保存编辑）。
- 无路径空白：每次命令可新开会话（见扩展 README）。

## 脏状态与关闭

- CustomTextEditor：依赖工作台 `TextDocument` 脏标记与保存。
- 纯 Webview / xmind：标题 `·`、状态栏提示；快捷键关闭路径下扩展拦截保存对话框策略见 `extension.ts` / `panel.ts` 与 README。

## Dock 最大化

`mindmapVscode.toggleDock`：联动侧栏/面板/辅助边栏/状态栏可见性，再聚焦编辑器与当前面板。
