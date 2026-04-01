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
4. **保存前合并画布→文档（`.mmd` / `.jm`）**：宿主注册 **`workspace.onWillSaveTextDocument`**；当即将保存的文档为脑图缓冲区时，**先** `await MindmapPanel.flushPendingWebviewEditsForDocument(document.uri)`（清空 Webview→`TextDocument` 的约 220ms 防抖队列并立即 `_syncDocumentFromWebview`），**再**由工作台写盘。避免「防抖未完成即 Ctrl+S → 落盘旧缓冲 → 随后同步 `applyEdit` → 标签仍显示脏」的竞态。

## 磁盘被外部修改（`FileSystemWatcher` + `mtime`）

- 检测到磁盘新于 `_lastKnownDiskMtime`（且不在写入后短抑制窗口）时：**不**使用 `showWarningMessage` 模态框。
- **`TextDocument` 干净**（无未保存）：读取磁盘文本，与当前缓冲区比对后写 **Log**（路径、行数/字符、首行差异预览），再 **`_reloadTreeFromDisk`**；若文本相同则仅写 Log、刷新基准。
- **脏文档**：写 **Log**（含 diff 摘要与说明），**不**自动重载，刷新 `_lastKnownDiskMtime`，避免同一外部变更反复触发。
- **`.xmind`**：无文本 diff；干净则自动重载并写 Log，脏则跳过并写 Log。
- 宿主通过 **`mindmap:appendHostLog`** 将条目推入 Webview 与状态栏 **Log** 同源列表。

## 错误语义（桥接）

- 面板未打开且方法非 `get_editor_state`：`ok: false`，错误文案包含 `Mindmap panel is not open`（以代码为准）。
- `batch_design`：`operations` 空/非 JSON/非数组 → `ok: false` 与对应错误信息。

## 边界

- MCP 工具里的 `filePath`：**忽略**，始终使用当前聚焦面板。
- `get_editor_state` 在无面板时**不**因 MCP 子进程缺少 token 而由桥判断——token 校验先于 method 分发；MCP 层在 token 为空时直接抛错。

## 脑图数据与 Webview 初始化（`panel.ts` + `media/*.js` + `mindmap-core.js` + jsMind）

- **脚本与资源拆分**：`_getHtmlForWebview` 输出的 HTML **不包含**大块内联可执行脚本（避免部分环境 CSP / nonce 与模板不一致导致整段脚本被拦截）。约定如下：
  - **壳与样式**：仍在 `mindmap_vscode/src/panel.ts` 的模板字符串中（`return \`…\``.replace(…)）。
  - **主题早置**：`media/webview-theme-init.js`（设置 `html[data-mm-ui]`，与 `--mm-bg-app` 等一致）。
  - **主逻辑**：`media/webview-app.js`（jsMind 初始化、画布交互、Dock、与宿主 `postMessage` 等）。
  - **启动数据**：`<script type="application/json" id="mindmap-boot-json">…</script>` 注入 JSON；`webview-app.js` 入口解析为 `__MINDMAP_BOOT__`（含 `tree` / `ext` / `uiLanguage`）。
  - **扩展资源 URL 占位符**：模板中使用字面量 `___MM_SRC_WEBVIEW_THEME___`、`___MM_SRC_WEBVIEW_APP___`，在 `panel.ts` 返回前经 `.replace(/___MM_SRC_WEBVIEW_THEME___/g, webviewThemeInitUrl)` 等与 **`webview.asWebviewUri(…media/…)`** 结果替换；**不得**依赖未经过上述替换的 `${webviewAppUrl}` 字面（本地 `out/web_dev.html` 生成见下「开发调试」）。
- **外链顺序**：`mindmap-core.js` → `jsmind.js` → `mindmap-boot-json` → `webview-app.js`。
- **换树策略（减轻闪烁）**：宿主 `MindmapPanel._loadTreeIntoWebview`：**首次**（Webview 尚未上报 `mindmap:ready`）必须把树写入 **`webview.html` 注入**，否则脚本末尾才注册 `message` 时 `postMessage(mindmap:setTree)` 会丢失。**首次就绪后**置 `_webviewJsReady`，此后同一面板的「新建 / 打开 / 替换树」仅 **`postMessage({ type: 'mindmap:setTree', tree, ext, uiLanguage })`**，**不再**整页赋值 `webview.html`，避免整页重载白屏闪烁。
- **空白 / 新建默认树**：由 `createBlankMindmapTree()`（`mindmap_vscode/src/mindmap/model.ts`，内部调用 `shared/mindmapCore.ts` 的 `createBlankCoreMindmapTree`）生成。根节点 **无子节点**；根 **id 每次为新**（`r_` 前缀 + 随机十六进制），与上一份会话的根节点区分，避免模型层混用。
- **每次 `init(tree, ext)`**：在创建新的 `jsMind` 实例前，清空 `#jsmind_container` DOM、重置框选/单选/滚动冻结等临时状态，避免旧画布残留。
- **根下一级子节点环绕顺序**（左右分列、非 `side` 模式）：vendor `media/jsmind/jsmind.js` 在 `_layout_offset` 中对**左侧**子节点数组在布局前 `reverse()`，使一级子节点相对根节点呈**顺时针**阅读顺序；升级上游 jsMind 时需复核是否保留该补丁。
- **快捷键触发的无效操作**（如未选节点即复制）：仅更新页内状态栏并写入 **Log**，**不**弹出 `errorDialog`；菜单/按钮触发的同类提示仍可弹窗（实现依赖 `invalidActionKeyboardContext` 标志，在画布 `keydown` 的 `try/finally` 中设置）。
- **画布内方向键（无修饰键）**：`↑`/`↓` 在兄弟节点间切换选中；`←`/`→` 选中父节点 / 第一个子节点。`Alt`+方向键仍为兄弟顺序与提升/下降，与之互斥分支处理。
- **选中节点视口**：`ensureMindNodeInCanvasView(nodeId)` 在新建节点后，以及**无修饰键方向键**切换选中、`Alt`+方向键（兄弟顺序 / 提升 / 下降）移动节点后调用。视口目标为**选中节点 + 邻域**（若存在）：**父节点**、**第一个子节点**、**上一个兄弟**、**下一个兄弟**（根无上下兄弟）；先合并各主题节点 DOM 的屏幕矩形，再**平移**；若合并框仍大于客户区则**缩小 zoom**（有下限），使整块区域落入可视区。
- **整页重载首帧**：模板在 `<head>` 内尽早注入 `html { background-color: #f1f5f9 }`（与 `--mm-bg-app` 一致），减轻浏览器或 Webview 整页刷新时的白屏闪烁（仅 **首次**注入 HTML 时经历整页加载；见上文「换树策略」）。

## jsMind 布局与节点样式后重算（`webview-app.js` + vendor）

- **问题**：对 `jmnode` 应用格式（字体、图标类等）会改变 DOM 尺寸。仅调用 `jm.view.relayout()`（内部为 `expand_size` + `_show`）**不会**再次执行 `layout.layout()`，布局仍按**旧** `node._data.view.width/height` 计算；根宽参与一级子节点 offset，易出现**根→一级**连线与框错位，深层相对父节点链式计算时观感可能仍正常。
- **过程**：`syncMindNodeSizesFromDom()` 对当前 **可见** 节点将 `element.clientWidth` / `clientHeight` 写回 `view`；`jm.layout.layout()` 全量重算；`jm.view.relayout()` 扩展画布并重绘节点与连线。在 `applyAllMindNodeVisuals` / 相关编辑事件后通过 `requestAnimationFrame` 链调用（与实现一致）。

## 视图平移与缩放（外层 `panX`/`panY`/`zoomScale` + `applyViewTransform`）

- **画布客户区尺寸变化**：对 `#canvasWrap` 使用 **`ResizeObserver`**。若记录的上一次宽高与本次不同，则 **`panX += Δw/2`、`panY += Δh/2`**（缩放不变），使变化前后**视口中心**所对准的画布内容保持一致（全屏切换、窗口拉伸、侧栏变化等）。
- **滚轮 / `zoomByStep`**：以**当前视口中心**为锚调整 `zoomScale` 与 `pan`（与 `ResizeObserver` 补偿同一几何约定）。
- **「还原」缩放（`resetZoom`）**：左下角 **还原** 按钮、**双击缩放百分比**、画布右键 **还原缩放比例** 均调用 `resetZoom()`：将 **`zoomScale` 置为 `1`**，并以**当前视口中心**为锚按与 `zoomByStep` 相同的公式修正 `pan`，使中心下所见内容保持稳定；**不**调用 **`centerRoot()`**，即不会为对齐根节点而整图平移。若需将根节点移到视口中心，使用 **「根节点」**（`centerRoot()`）。
- **`fitAll` / `centerRoot`**：**适应**整图入窗；**根节点**将根主题元素置于客户区中心并重算 `pan`（与「还原」语义分离）。
- **锚点同步**：在 **`centerRoot`**、**`fitAll`** 等按当前客户区**重算** `pan` 的程序路径末尾调用 **`syncCanvasWrapResizeAnchor()`**，将观测锚点尺寸与当前 `getBoundingClientRect()` 对齐，避免与程序居中逻辑重复补偿。`init` 重置视图状态时 **`lastCanvasWrapObservedSize`** 归零。

## 格式 Dock、图标 Dock、脑图主题 Dock（右缘条 `panel.ts`）

- **格式（Format）**：作用对象为**当前选中节点**；无选中时表单 **`dock-disabled`**，且 **Topic / 字体 / 字号 / 文字色 / 背景色 / 重置** 等控件 **`disabled`**，字段清空（颜色占位为合法 hex）。有选中时：优先 **`node.data`** 的 `mmFont` / `mmFontSize` / `mmColor` / `mmBg`；缺失时从 **`jmnode` DOM** 读取**默认外观**（临时移除 **`selected`** 再取计算样式），避免把**选中高亮**当成主题色；`rgb`/`rgba`/`#rgb` 规范化为 **`#rrggbb`** 供 `<input type="color">`。
- **脑图主题（Mind map theme）**：缘条按钮展开网格；预览缩略图中 **`jmnodes`/`jmnode` 覆盖为流内定位**，避免 vendor `jsmind.css` 中 `position:absolute` 导致预览与标签错位。
- **全屏**：标题栏按钮或 Webview 内 **`Ctrl+Space`**（无 `meta`）→ `mindmap:requestToggleFullScreen` → 宿主 **`workbench.action.toggleFullScreen`**。扩展 `package.json` 另注册 **`ctrl+space` → `mindmapVscode.toggleDock`**（全局）；焦点在 Webview 内时一般由页面优先处理，行为以实际为准。
- **画布左上角快捷键提示**：`#canvasShortcutHints` 绝对定位于 `#canvasWrap` 左上，`pointer-events: none`；文案键 **`canvasShortcutHints`**（`i18n` en/zh，多行 `\n`），随 **`applyLanguage`** 更新。

## 开发调试（Web，非 VSIX）

- **入口脚本**：`mindmap_vscode/run_web.py`：默认**不**修改 `package.json`；可选 `--bump-version` 将 patch +1（与 `build.py` 类似）。本地起 HTTP，**根路径 `/`** 映射为 `out/web_dev.html`（由 `scripts/gen_web_dev_html.js` 自 `panel.ts` 模板生成）；不经过扩展宿主，用于 UI/脚本快速迭代。网页是否更新由源码编译与 watch/轮询驱动，与版本号无关。
- **生成规则**：`gen_web_dev_html.js` 从 `panel.ts` 抽取 **`return /* html */ \`<!DOCTYPE html>…\`` 至首个 `</html>\``** 的片段（模板在 `</html>` 后可有 `.replace(…)` 链，**不属于**抽取范围）。对 `${cspSource}`、`${nonce}`、`___MM_SRC_WEBVIEW_*___` 等做字符串替换为 `http://127.0.0.1:{port}/…`；在 `jsmind` 外链之后注入 **`acquireVsCodeApi` 桩**；在 `</html>` 前注入 **`media/web-dev-livereload.js`** 外链（热更新轮询），**避免**内联脚本以兼容严格 CSP / Cursor 浏览器预览。
- **维护义务**：修改 `panel.ts` 内 HTML 模板或占位符后，须执行 **`npm run gen:web-dev`** 或经 **`run_web.py` 启动**（会调用生成器），否则 `out/web_dev.html`（gitignore）可能过期，出现脚本 URL 未替换或 404。`out/` 不纳入版本库，依赖本地生成。
- **热更新**：浏览器轮询 `out/web_dev_meta.json`，序号变化时 `location.reload()`，属**整页重载**；实现位于 `media/web-dev-livereload.js`。
- **能力差异**：页面内注入 `acquireVsCodeApi` 桩（见生成脚本），与真实 Webview 的消息/持久化行为可能不一致，以扩展内行为为准。
