# mindmap-desktop-electron

- **产物**：Electron 打包输出（由 `desktop/package.json` 的 `build:win` / `build:linux` / `build:mac` 定义；具体目录以 electron-builder 配置为准）。
- **类型**：桌面应用。
- **源码根**：`mindmap_vscode/desktop/`（`main.js`、`preload.js`、`renderer/`）。
- **入口脚本**：仓库根相对 `mindmap_vscode/run.py`（先 `npm run compile` 扩展侧以生成共享产物）。
