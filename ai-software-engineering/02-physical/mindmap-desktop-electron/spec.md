# 规格：mindmap-desktop-electron

## 能力范围（与实现对齐）

- 支持 `.mmd` / `.jm` 打开、编辑、保存、另存为（见扩展 README「桌面模式」章节）。
- 依赖扩展根目录 TypeScript 编译产物供共享逻辑使用（`run.py` 在启动/打包前执行 `npm run compile`）。

## 构建目标

- `python run.py`：开发启动（`npm run start` in `desktop/`）。
- `python run.py --build-desktop --target win|linux|mac`：平台打包。

## 边界

- 不包含 VS Code MCP 桥（桥为扩展宿主内 HTTP 服务）；桌面模式不替代扩展模式。
