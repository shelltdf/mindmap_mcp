# mindmap-vscode-extension

- **产物**：VSIX（`out/*.vsix`，由 `build.py` / `vsce` 链路产出）；开发时 `dist/extension.js`。
- **类型**：VS Code 扩展（`package.json` `main`）。
- **源码根**（相对 `mindmap_vscode/`）：`src/`、`media/`、`package.json`、`tsconfig.json`。
- **与工程目标名**：NPM `compile` → `tsc`；`vscode:prepublish` → `compile` + `mcp:pack`。
