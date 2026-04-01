# 规格：mindmap-vscode-extension

## 对外可见行为（摘要）

- **publisher / name / version**：以 `mindmap_vscode/package.json` 为准（示例：`av-ai-dev` / `mindmap-vscode`；版本号以该文件 `version` 字段为单一事实来源）。
- **自定义编辑器 ID**：`mindmap.customTextEditor`；匹配 `*.mmd`、`*.jm`。
- **桥接监听**：`127.0.0.1:{mindmap.mcpBridge.port}`，默认端口 `58741`；可用配置关闭 `mindmap.mcpBridge.enable`。
- **桥接端点**：仅接受 `POST /mcp-bridge/v1/call`；其它路径 404。
- **鉴权**：body JSON `token` 必须与扩展当前 token 完全一致，否则 401 `unauthorized`。
- **请求体上限**：约 2 MiB；超出返回 413。

## 重要过程

1. **激活**（`extension.ts` `activate`）：注册 CustomEditor、命令、MCP 桥、AI 命令、状态栏；`MindmapPanel.setExtensionContext`。
2. **MCP 读/写前**：`batch_get` / `batch_design` 调用 `panel.autoSaveForMcpBridgeIfNeeded()`，失败则桥返回 `ok: false`；必要时 `showMcpPersistNoticeIfNeeded()`。
3. **停用 / 关闭**：`deactivate` 与 `onWillShutdown` 路径刷新挂起编辑、持久化脏状态（见实现）。

## 错误语义（桥接）

- 面板未打开且方法非 `get_editor_state`：`ok: false`，错误文案包含 `Mindmap panel is not open`（以代码为准）。
- `batch_design`：`operations` 空/非 JSON/非数组 → `ok: false` 与对应错误信息。

## 边界

- MCP 工具里的 `filePath`：**忽略**，始终使用当前聚焦面板。
- `get_editor_state` 在无面板时**不**因 MCP 子进程缺少 token 而由桥判断——token 校验先于 method 分发；MCP 层在 token 为空时直接抛错。

## 脑图数据与 Webview 初始化（`panel.ts` + `mindmap-core.js` + jsMind）

- **空白 / 新建默认树**：由 `createBlankMindmapTree()`（`mindmap_vscode/src/mindmap/model.ts`，内部调用 `shared/mindmapCore.ts` 的 `createBlankCoreMindmapTree`）生成。根节点 **无子节点**；根 **id 每次为新**（`r_` 前缀 + 随机十六进制），与上一份会话的根节点区分，避免模型层混用。
- **每次 `init(tree, ext)`**：在创建新的 `jsMind` 实例前，清空 `#jsmind_container` DOM、重置框选/单选/滚动冻结等临时状态，避免旧画布残留。
- **根下一级子节点环绕顺序**（左右分列、非 `side` 模式）：vendor `media/jsmind/jsmind.js` 在 `_layout_offset` 中对**左侧**子节点数组在布局前 `reverse()`，使一级子节点相对根节点呈**顺时针**阅读顺序；升级上游 jsMind 时需复核是否保留该补丁。
- **快捷键触发的无效操作**（如未选节点即复制）：仅更新页内状态栏并写入 **Log**，**不**弹出 `errorDialog`；菜单/按钮触发的同类提示仍可弹窗（实现依赖 `invalidActionKeyboardContext` 标志，在画布 `keydown` 的 `try/finally` 中设置）。
- **画布内方向键（无修饰键）**：`↑`/`↓` 在兄弟节点间切换选中；`←`/`→` 选中父节点 / 第一个子节点。`Alt`+方向键仍为兄弟顺序与提升/下降，与之互斥分支处理。
- **选中节点视口**：`ensureMindNodeInCanvasView(nodeId)` 在新建节点后，以及**无修饰键方向键**切换选中、`Alt`+方向键（兄弟顺序 / 提升 / 下降）移动节点后调用。视口目标为**选中节点 + 邻域**（若存在）：**父节点**、**第一个子节点**、**上一个兄弟**、**下一个兄弟**（根无上下兄弟）；先合并各主题节点 DOM 的屏幕矩形，再**平移**；若合并框仍大于客户区则**缩小 zoom**（有下限），使整块区域落入可视区。
- **整页重载首帧**：模板在 `<head>` 内尽早注入 `html { background-color: #f1f5f9 }`（与 `--mm-bg-app` 一致），减轻浏览器或 Webview 整页刷新时的白屏闪烁。

## 开发调试（Web，非 VSIX）

- **入口脚本**：`mindmap_vscode/run_web.py`：默认**不**修改 `package.json`；可选 `--bump-version` 将 patch +1（与 `build.py` 类似）。本地起 HTTP，**根路径 `/`** 映射为 `out/web_dev.html`（由 `scripts/gen_web_dev_html.js` 自 `panel.ts` 模板生成）；不经过扩展宿主，用于 UI/脚本快速迭代。网页是否更新由源码编译与 watch/轮询驱动，与版本号无关。
- **热更新**：生成页可轮询 `out/web_dev_meta.json`，序号变化时执行 `location.reload()`，属**整页重载**，仍可能出现短暂视觉跳变；首帧背景色仅减轻白屏，无法消除脚本重绘脑图本身的时序差。
- **能力差异**：页面内注入 `acquireVsCodeApi` 桩（见生成脚本），与真实 Webview 的消息/持久化行为可能不一致，以扩展内行为为准。
