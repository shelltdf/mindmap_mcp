# mindmap-vscode

一个基于 Webview + `jsMind` 的 WYSIWYG 脑图编辑器扩展，适用于 **VS Code** 与 **Cursor**（扩展显示名：**Mindmap (MindmapEditor)**，当前版本见 `package.json` 的 `version`）。

## 支持的输入/输出文件格式

- `*.jm`：jsMind `node_tree` JSON 格式
- `*.mmd`：Mermaid `mindmap` 风格（本实现按约定格式解析与序列化）
- `*.xmind`：读取/保存支持“标题编辑”（结构级增删/移动已隐藏）

保存时会把修改后的脑图写回同一个文件（空白未命名脑图需先 **Save As** 指定路径）。

## 使用方式

1. 在 VS Code / Cursor 中打开一个 `.mmd` / `.jm` / `.xmind` 文件，或用下方入口打开。
2. **命令面板**（`Ctrl+Shift+P` / `Cmd+Shift+P`）：搜索 **`Mindmap`**，可见例如：
   - **`Mindmap: Open Mindmap Editor`** — 打开脑图编辑器（若当前有活动文本文件则尝试按该文件路径打开；否则为空白脑图）。
   - **`Mindmap: Open with Mindmap Editor`** — 与资源管理器右键等价；若从编辑器内触发，会尽量使用当前文件。
   - 以及 MCP 配置、桥接信息、诊断等命令（见下文 MCP 小节）。
3. **右键菜单**（`package.json` 中 `when: true`，避免部分环境对上下文键解析不一致导致菜单消失）：
   - **资源管理器** / **打开的编辑器** 中的文件
   - **编辑器内**（需文本区聚焦）
   - **编辑器标签栏**右键  
   非 `.jm` / `.mmd` / `.xmind` 时会提示不支持；支持的后缀行为与 **`Mindmap: Open Mindmap Editor`** 一致。
4. 在 Webview 脑图窗口中用顶部菜单栏、左侧工具栏等操作（布局以当前 IDE 为准）。
5. 快捷键：`Ctrl + Space`（Windows/Linux）在「最大化编辑区 / 还原 dock」之间切换（侧栏 / 状态栏 / 底部 panel 由命令联动隐藏与恢复）。
6. 编辑器内文件快捷键：`Ctrl/Cmd + N` 新建、`Ctrl/Cmd + O` 打开、`Ctrl/Cmd + S` 保存、`Ctrl/Cmd + Shift + S` 另存为。

## 发布模式（双模式）

当前仓库支持两种发布/运行方式，可并行保留：

- **VS Code / Cursor 扩展模式（原模式）**
  - 构建：`python build.py`
  - 安装：`python install.py`
  - 产物：`out/*.vsix`
- **独立桌面模式（Electron）**
  - 开发运行（默认）：`python run.py`
  - 桌面打包（Windows 默认）：`python run.py --build-desktop --target win`
  - 其他平台目标：`--target linux` / `--target mac`（建议在对应系统构建）
- **网页调试模式（本地 HTTP，与扩展 Webview 同源模板）**
  - 启动：`python run_web.py`（默认 `--host 127.0.0.1`、`--port 8765`）
  - 脚本会：`npm install`（按需）、`npm run compile`、复制 `jsmind` 到 `media/jsmind/`、执行 `scripts/gen_web_dev_html.js` 生成 `out/web_dev.html`，再在扩展根目录启动内置 HTTP 服务；**访问根路径 `http://<host>:<port>/` 即脑图主页面**（不显示目录索引；`/out/web_dev.html` 仍可直接访问）。
  - 默认 `--browser ide`：将页面 URL 复制到剪贴板，并在终端提示在 VS Code / Cursor 中用 **命令面板 →「Simple Browser: Show」** 粘贴打开（内置网页视图，便于与扩展内 Webview 对照调试）。
  - 其他：`--browser system` 用系统默认浏览器；`--browser edge-app`（Windows）尝试 Edge 应用窗口；`--browser none` 仅打印 URL。按 **Ctrl+C** 停止 HTTP 服务。

说明：
- 扩展模式与桌面模式互不替代，功能目标保持一致。
- `build.py/install.py` 仍只负责 VSIX 扩展链路；`run.py` 负责桌面模式；`run_web.py` 仅用于本地网页调试，不产出安装包。
- 桌面模式当前支持 `.mmd` / `.jm` 文件的打开、编辑、保存、另存为。
- 网页调试模式下画布由 `out/web_dev.html` 加载，已注入 `acquireVsCodeApi` 桩，文件保存等需 IDE 的能力在浏览器中不可用或仅打日志，以调试 UI 与脚本逻辑为主。

### 多标签（多实例）

- **不同磁盘路径**的脑图会**新开**一个 Mindmap Editor 标签，不会覆盖当前标签。
- **同一路径**若已有打开的标签，会**聚焦到该标签**且**不会**重新从磁盘加载（避免冲掉未保存编辑）。
- **无路径的空白脑图**每次从命令打开会**新开**一页，可多开多个未命名会话。

### 未保存与关闭

- **不再**使用「配套文本文档」模拟脏文件：该方式易产生误导（保存缓冲区不会写入脑图），且会占用 `untitled` 标签。未保存提示改由扩展自身逻辑处理（见下）。
- **`.mmd` / `.jm`**：使用 VS Code 官方 **`CustomTextEditorProvider`**，底层就是普通 **`TextDocument`**（与 `.txt` 同源：工作台维护 `isDirty`、标签上的圆点、Ctrl+S 保存、关闭时系统保存提示）。编辑时扩展把画布序列化进文档缓冲区。
- **无路径脑图 / `.xmind`**：仍用独立 **Webview 面板**（无 `TextDocument`），未保存时在标题加 **`·`**，并在 **状态栏** 显示 **`脑图未保存`**（可点击聚焦）。
- **Ctrl+F4**、**Ctrl+W**（macOS：**Cmd+W**）关闭当前脑图标签时，若 **当前活动编辑器标签为 Mindmap**（`mindmapActiveTabIsMindmap`，不依赖 Webview 内焦点）**且**存在未保存（`mindmapEditorHasUnsavedChanges`），扩展会拦截并弹出 **保存 / 不保存 / 取消**；无未保存时走系统默认关闭。若环境仍优先匹配内置快捷键，可在键盘快捷方式里为上述组合键提高 `mindmapVscode.closeMindmapEditor` 的优先级。
- **关闭整个 IDE / 重载窗口**时，扩展在 `deactivate` 中若仍有 **未释放的** 脏脑图实例，会弹出 **全部保存 / 不保存**。若已先关闭 Mindmap 标签但**未保存**，扩展会把记录写入工作区 **`mindmap.closedUnsavedMindmaps`**（并与旧版 **`mindmap.dirtyMindmapAtLastSync`** 快照合并去重），退出时再弹出提示（无法再代为写盘）。**Ctrl+Q**（macOS：**Cmd+Q**）仅在 **当前为脑图标签且存在未保存**（与关闭标签快捷键条件一致）时走扩展的退出前检查；若仅有「已关标签未保存」记录而无脑图在前台，则走系统默认退出，由 **`deactivate`** 再提示。**Alt+F4** 等仍可能绕过；若退出阶段系统不展示模态框，属宿主限制。
- 用鼠标点标签 **×** 等方式关闭时，通常**不会**走上述快捷键；Webview 内 **`beforeunload`** 在 Electron/IDE 下也常不触发，故**无法**像普通文档一样可靠拦截。另在 **新建 / 打开 / 用新内容替换整页** 前，若当前为脏状态，会弹出 **保存 / 不保存 / 取消**。
- 保存成功后会清除脏标记，并通知 Webview 同步内部状态。

### 磁盘文件被外部程序修改

- 对已绑定路径的文件使用 **`FileSystemWatcher`** 监听变更，并在面板**变为可见**时做节流复检。
- 检测到磁盘 **`mtime` 新于** 扩展内记录的基准（且非本扩展刚写入后的短抑制窗口）时，弹出 **模态** 提示：**重新加载**（从磁盘重读并刷新画布）或 **保留编辑器**（不读盘，但将基准更新为当前磁盘时间，避免同一轮变更反复打扰）。
- **未命名**（无路径）脑图不参与上述检测。

## UI 设计

当前界面采用“xmind 风格”控制逻辑：结构增删/移动按钮在所有支持格式下都已隐藏（但保留快捷键交互，如 `Enter/Tab/粘贴文本` 建节点）。
默认状态（明确）：左侧工具栏与右侧属性区在打开编辑器时即为最小化（缩小）模式，需手动展开后才显示完整内容。
中间编辑区域（`jsMind canvas`）默认背景颜色为深灰色。

UI 示意图（左侧垂直工具栏 + 中间 jsMind canvas + 右侧属性区域）：
注：示意图中的 `New/Open/Save/SvAs` 为排版用缩写；正式界面工具栏在展开状态显示“图标 + 全名”，缩小状态仅显示图标。

```text
+--------------------------------------------------------------------------------------------------------------+
|File(v)  Edit(v)  View(v)  Insert(v)  Modify(v)  Theme(v)  Tools(v)  Window(v)  Help(v)  Language(v)          |
+--------------------------------------------------------------------------------------------------------------+
| >> |                                                                              |                      >>  |
|New |                                                                              |                  Format  |
|Open|                                                                              |                    Icon  |
|Save|                                                                              |                          |
|SvAs|                                                                              |                          |
|    |                                                                              |                          |
|    |                                                                              |                          |
|    |                                                                              |                          |
|    |                                jsMind canvas                                 |                          |
|    |                                                                              |                          |
|    |                                                                              |                          |
|    |                                                                              |                          |
|    |                                                                              |                          |
|    |                                                                              |                          |
|    |                                                                              |                          |
|    |                                                                              |                          |
|    |                                                                              |                          |
+--------------------------------------------------------------------------------------------------------------+
|Status: Ready                                                                                                 |
+--------------------------------------------------------------------------------------------------------------+
```

## Webview 菜单栏（示意；当前由 Webview 菜单栏实现）：

File

| 菜单项 | 功能 |
|---|---|
| `New` | 创建新的空白脑图 |
| `Open` | 打开现有脑图文件 |
| `Save` | 保存回原文件；从空白画布开始时会走 `Save As` |
| `Save As` | 另存为（强制弹出保存对话框） |

Edit

| 菜单项 | 功能 |
|---|---|
| `Copy` | 复制选中节点及整棵子树到剪贴板（`##MINDMAP_SUBTREE##` + JSON） |
| `Cut` | 剪切选中节点（根不可剪切），同上写入剪贴板 |
| `Paste` | 从剪贴板粘贴子树到当前选中下（无选中则挂到根）；非脑图格式时同快捷键粘贴规则 |
| `Promote` | 提升：与父节点同级（挂到祖父下，排在父节点之后） |
| `Demote` | 下降：挂到前一兄弟节点下（末位子节点） |
| `Apply Title` | 修改选中节点标题 |

View

| 菜单项 | 功能 |
|---|---|
| `Expand` | 展开选中节点 |
| `Collapse` | 折叠选中节点 |
| `Toggle` | 切换选中节点展开/折叠 |
| `Expand All` | 展开全部节点 |

Insert

| 菜单项 | 功能 |
|---|---|
| `Add / Delete / Move` | 当前“xmind 风格”下已隐藏（只保留标题编辑与视图操作） |

Modify

| 菜单项 | 功能 |
|---|---|
| `（无）` | 当前暂无 Modify 菜单项（占位） |

Theme

| 菜单项 | 功能 |
|---|---|
| `Default/Primary/...` | 切换 jsMind 主题（点击即应用） |

Tools

| 菜单项 | 功能 |
|---|---|
| `（无）` | 当前暂无 Tools 菜单项 |

Window

| 菜单项 | 功能 |
|---|---|
| `Mindmap: Toggle Dock Maximized` | 最大化/还原 dock（快捷键 `Ctrl + Space`） |

Help

| 菜单项 | 功能 |
|---|---|
| `状态栏提示` | 选中节点后会更新状态文案（就绪/选中/编辑等） |
| `Toggle Debug Bounds` | 显示/隐藏调试边界框（可见区域与内层区域） |

Language

| 菜单项 | 功能 |
|---|---|
| `中文 / English` | 切换 Webview UI 语言 |

菜单交互行为（Windows 风格）：
- 点击菜单项后自动收起菜单
- 鼠标移出菜单栏区域后自动收起菜单
- 当一个菜单已展开时，鼠标移动到其他菜单标题会自动切换展开菜单

## 工具栏功能描述
默认（明确）：最小化（缩小图标）模式；点击折叠/展开按钮可切换到完整模式。
展开模式显示“图标 + 全名”；最小化模式仅显示图标。鼠标悬浮 tooltip 显示“全名 + 快捷键”（如 `Open (Ctrl/Cmd+O)`）。
| 工具栏按钮 | 功能 |
|---|---|
| `New` | 创建新的空白脑图（`Ctrl/Cmd + N`） |
| `Open` | 打开现有脑图文件（`Ctrl/Cmd + O`） |
| `Save` | 保存回原文件；从空白画布开始会走 `Save As`（`Ctrl/Cmd + S`） |
| `Save As` | 另存为（强制弹出保存对话框，`Ctrl/Cmd + Shift + S`） |

## jsMind canvas 编辑区域操作需求：
- 在 xmind 风格交互中，结构级增删/移动入口已隐藏或禁用；你仍可通过标题编辑与展开/折叠等操作，尽可能保持与 xmind 一致的交互体验
- 中键拖拽：平移画布
- 滚轮缩放：缩放画布
- 双击节点：弹出编辑输入并修改节点标题
- `Enter`：在选中节点同级创建兄弟节点（根节点除外）
- `Tab`：在选中节点下创建子节点
- `Ctrl/Cmd + C`：复制选中节点及**子树**（剪贴板格式同上）
- `Ctrl/Cmd + X`：剪切选中节点（根不可）
- `Ctrl/Cmd + N`：新建脑图
- `Ctrl/Cmd + O`：打开脑图
- `Ctrl/Cmd + S`：保存
- `Ctrl/Cmd + Shift + S`：另存为
- 粘贴：剪贴板为脑图子树时在选中节点下（无选中则为根）整棵粘贴；否则在**有选中**时用纯文本首行创建单个子节点
- **节点右键菜单**：除视图外含复制 / 剪切 / 粘贴、**提升 / 下降**、添加子/兄弟、删除；**画布右键**含「粘贴到根节点」等

## 属性区功能说明：
- 属性区以“当前选中节点/选中对象”为作用对象，并按 tab 分组展示对应的编辑需求
- 默认（明确）：最小化（缩小）模式；点击折叠/展开按钮可切换到完整模式。

**格式（Format）Tab**
| 项目 | 功能 | 作用对象 | 当前实现/交互 |
|---|---|---|---|
| `占位说明` | 当前用于展示属性区布局占位 | 当前选中对象 | 该 Tab 暂无可编辑属性控件（后续扩展） |

**图标（Icon）Tab**
| 项目 | 功能 | 作用对象 | 当前实现/交互 |
|---|---|---|---|
| 节点图标设置 | 为节点选择/编辑图标样式（例如主题图标） | 当前选中节点 | 该 UI/数据字段在当前版本未实现（仅保留文档占位） |

## 状态栏功能说明：
- 用于显示当前编辑状态与选中信息（例如“选中：xxx”、就绪/提示等）
- 当选中节点变化、进入/退出编辑动作、或 Webview 初始化完成时，会同步更新状态栏文案
- 文件操作会显示进行中提示：`新建/打开/保存/另存为`
- 若主画布渲染失败并自动切到文本树兜底，会显示：`主画布渲染失败，已切换降级视图。`

## Webview 渲染兜底

- 初始化后会做一次短延迟重试（居中/适配视图），用于规避宿主中偶发的异步布局时序问题。
- 若检测到节点未进入可视区域，会自动切换到“脑图渲染降级视图”（文本树），保证内容可见与可继续保存。
- 如需排障，可临时开启设置 `mindmap.webview.dumpHtml`，把当前注入的 Webview HTML 写到扩展目录 `out/last_webview_debug.html`（默认关闭，建议仅排障时开启）。

## MCP（Pencil 同款三工具形态）

Cursor / 其它支持 MCP 的客户端可加载 **stdio MCP 服务** `mcp-server`，工具名与用法对齐 Pencil 习惯：

| 工具 | 作用 |
|---|---|
| `get_editor_state` | 是否已打开脑图面板、标题、关联文件路径、当前选中、`include_schema: true` 时附带操作说明（对应 Pencil 先拉 schema） |
| `batch_get` | 读取当前面板中的树；可选 `nodeIds`、`readDepth`、`patterns`（按标题正则/子串过滤） |
| `batch_design` | 批量写：`operations` 为 **JSON 字符串**，内容为 `aiApplyOps` 的 op 数组；默认 `transaction`/`strict` 为 true（失败整批回滚 + 结构化失败信息） |

**架构（与 Pencil 一致的两进程思路）**：扩展在 **127.0.0.1** 上启 HTTP 桥（仅本机），MCP 进程通过 `fetch` 把工具调用转到 VS Code / Cursor 里当前 Webview 脑图。

**未落盘 / 未保存 时的 MCP 行为**：

- 对 HTTP 桥的 **`batch_get`** 与 **`batch_design`**：**若已绑定磁盘路径**且画布有未保存修改（标题栏 **`·`**），会**先自动静默保存**到该文件（无成功弹窗；失败则本次 MCP 请求直接报错）。**若无文件路径**（未命名脑图），仍会在画布中央弹出 **「MCP 提示」**，用户确认后再继续（`get_editor_state` 不弹）。
- 多开多个脑图标签时，桥接与 AI 命令面向 **当前获得焦点的** 那个面板（内部以 `MindmapPanel.currentPanel` 为准）。

**推荐：安装后不用手写 `E:/...` 路径**（与从市场/VSIX 安装扩展的体验一致）：

1. 使用 **`build.py` / `vsce package` 打出的 VSIX**（`vscode:prepublish` 会把 `mcp-server` 打进扩展包），或本地开发时在 `tools/mindmap_vscode` 执行过 `npm run mcp:pack`。
2. 在 VS Code / Cursor 中任选其一：
   - **`Mindmap: Configure Cursor MCP (Workspace .cursor/mcp.json)`** — 合并写入当前工作区 `.cursor/mcp.json`，其中 `args` 为 **扩展安装目录下的** `mcp-server/dist/index.js`（随版本变化，由扩展自动填好）。
   - **`Mindmap: Configure Cursor MCP (User ~/.cursor/mcp.json)`** — 合并到用户目录（所有项目共用）。
3. **自动行为（接近「装好就能用」）**：设置 **`mindmap.mcpBridge.cursorConfig`**  
   - `prompt`（默认）：工作区里还没有 `user-mindmap` 时弹一次窗，选「写入」即完成上一步。  
   - `workspace`：检测到没有 `user-mindmap` 时**直接**写入工作区 `.cursor/mcp.json`，不再询问。  
   - `off`：不自动写，只靠命令面板里的两条 Configure 命令。
4. 写入的配置里会带上当前 **`MINDMAP_BRIDGE_URL` / `MINDMAP_BRIDGE_TOKEN`**（与桥接一致）。若不想把 token 放进仓库，请把 `.cursor/mcp.json` 加入 **`.gitignore`**，或改用 **用户级** `~/.cursor/mcp.json`，或在设置里固定 `mindmap.mcpBridge.token` 后重新执行一次 Configure。
5. 重载 Cursor / VS Code 窗口，使 MCP 列表刷新。
6. 使用读写工具前请先 **`Mindmap: Open Mindmap Editor`**；`get_editor_state` 在面板未打开时仍会返回 `active: false` 与可选 schema。

手动维护时仍可用 **`Mindmap: Show MCP Bridge Info`** 复制 env（例如非 Cursor 客户端）。

设置项：`mindmap.mcpBridge.enable`、`mindmap.mcpBridge.port`、`mindmap.mcpBridge.token`、`mindmap.mcpBridge.cursorConfig`、`mindmap.webview.dumpHtml`。

### Tools / MCP 里看不到 user-mindmap？

扩展**不会**像内置服务那样自动出现在列表里；必须让 Cursor 读到 **`mcp.json` 里的 `mcpServers.user-mindmap`**。常见原因：

1. **还没写入配置**：安装扩展 ≠ 已写 `mcp.json`。请执行 **`Mindmap: Configure Cursor MCP (Workspace)`** 或 **(User)**，或对弹窗选「写入」。
2. **应用的是「打开文件夹」**：要用 **文件 → 打开文件夹** 打开项目根（包含 `.cursor/mcp.json` 的那个目录）。只打开单个文件时，工作区级 MCP 往往**不会**按你预期加载。
3. **未重载**：改完 `mcp.json` 后需要 **Developer: Reload Window** 或 **完全退出 Cursor 再开**。
4. **VSIX 里缺 MCP 入口**：若诊断里「入口文件存在」为否，说明当前装的扩展包里没有编进 `mcp-server`（需用带 `vscode:prepublish` 的正式打包安装）。
5. **`node` 不可用**：MCP 使用 `command: node`；若 Cursor 启动环境里没有 Node，服务器会启动失败（在 MCP 设置里可看错误/日志）。

可执行 **`Mindmap: Diagnose MCP Setup`**，在临时文档里查看：扩展路径、脚本是否存在、工作区/用户 `mcp.json` 是否包含 `user-mindmap`。

### 报错 `Cannot find module ... mindmap-vscode-0.0.xx\mcp-server\dist\index.js`

`mcp.json` 里 **`args` 写的是安装时的扩展目录**（带版本号）。**升级或重装扩展后** 旧目录会被换掉，路径就失效。

**处理**：在 VS Code/Cursor 里再执行一次 **`Mindmap: Configure Cursor MCP (Workspace)`** 或 **`(User)`**，会按**当前**扩展目录重写 `user-mindmap`；然后 **重载 Cursor 窗口**。也可手动把路径里的版本号改成当前已安装版本（例如 `av-ai-dev.mindmap-vscode-0.0.73`，以本机 `~/.cursor/extensions` 或 VS Code 扩展目录下实际文件夹名为准），并确认该目录下存在 `mcp-server/dist/index.js`。

## AI 命令接口（实验）

当前扩展已提供一组可被 AI/自动化脚本调用的命令（需先打开 **至少一个** 脑图编辑器面板；**多开时**以 **当前前台/聚焦** 的面板为准）：

**未保存到磁盘的脑图**（内容只在 Webview 里、尚未 Save / Save As）无法从工作区当普通文件读写；要批量加节点请调用 `mindmapVscode.aiApplyOps`，或先保存成 `.jm` / `.mmd` 再改文件。链式多条 `add`（后一步的 `parentId` 依赖前一步新建的节点）不要用 `dryRun: true` 整批预演，否则父节点不存在会报错。若当前根节点 `id` 不是 `root`，请先 `aiGetTree` 获取实际节点 ID 再构造 `ops` 参数。

| 命令 | 说明 | 参数 |
|---|---|---|
| `mindmapVscode.aiGetTree` | 读取当前脑图树 | 无 |
| `mindmapVscode.aiAddNode` | 在指定父节点下新增节点 | `{ parentId, topic }` |
| `mindmapVscode.aiUpdateNodeTitle` | 更新节点标题 | `{ nodeId, topic }` |
| `mindmapVscode.aiDeleteNode` | 删除节点（根节点不可删） | `{ nodeId }` |
| `mindmapVscode.aiGetSelection` | 获取当前选中节点 | 无 |
| `mindmapVscode.aiApplyOps` | 批量操作（支持 dry-run / transaction / strict） | `{ ops, dryRun?, transaction?, strict? }` |

`aiApplyOps` 支持的 `action`：
- `getTree`
- `getSelection`
- `select`（需 `nodeId`）
- `add`（需 `parentId`, `topic`，可选 `nodeId`）
- `update`（需 `nodeId`, `topic`）
- `delete`（需 `nodeId`）
- `move`（需 `nodeId`、`newParentId`；可选 `before`：`_first_` / `_last_`，默认 `_last_`）

当 `strict: true` 且某一步失败时，Webview 会把详情放在失败响应的 `data` 里；扩展侧在 `reject` 时将其挂到抛出错误的 `error.webviewData` 上（`try/catch` 可读），字段包括：`failedIndex`（从 0 起）、`failedOp`（失败的那条 op 原文）、`partialResults`（已成功步骤的返回值列表，与 `ops` 前 `failedIndex` 条一一对应）。与 `transaction: true` 联用时，仍会先回滚整批，再附带上述字段，便于 AI 只修正失败步后重试。

示例（批量预演，不实际修改）：

```json
{
  "command": "mindmapVscode.aiApplyOps",
  "args": {
    "dryRun": true,
    "ops": [
      { "action": "getSelection" },
      { "action": "add", "parentId": "root", "topic": "新分支-示例" },
      { "action": "update", "nodeId": "root", "topic": "Root Updated (Preview)" }
    ]
  }
}
```

示例（执行修改）：

```json
{
  "command": "mindmapVscode.aiApplyOps",
  "args": {
    "dryRun": false,
    "ops": [
      { "action": "add", "parentId": "root", "topic": "需求拆解" },
      { "action": "add", "parentId": "root", "topic": "风险清单" }
    ]
  }
}
```

示例（事务模式：任一步失败自动回滚）：

```json
{
  "command": "mindmapVscode.aiApplyOps",
  "args": {
    "dryRun": false,
    "transaction": true,
    "ops": [
      { "action": "add", "parentId": "root", "topic": "发布计划" },
      { "action": "update", "nodeId": "root", "topic": "项目总览" }
    ]
  }
}
```

示例（事务 + strict：失败时带回滚与失败步信息）：

```json
{
  "command": "mindmapVscode.aiApplyOps",
  "args": {
    "dryRun": false,
    "transaction": true,
    "strict": true,
    "ops": [
      { "action": "add", "parentId": "root", "topic": "A" },
      { "action": "update", "nodeId": "不存在的id", "topic": "B" }
    ]
  }
}
```

常见错误与处理建议：

| 错误信息（示例） | 常见原因 | 建议处理 |
|---|---|---|
| `Mindmap panel is not open.` | 脑图面板未打开 | 先执行 `Mindmap: Open Mindmap Editor` |
| `node not found: xxx` | 传入的 `nodeId/parentId` 不存在 | 先调用 `aiGetTree` 获取最新节点 ID |
| `cannot delete root node` | 试图删除根节点 | 改为删除根节点的子节点 |
| `topic is required` / `parentId is required` | 参数缺失或空字符串 | 补全必填参数再调用 |
| `Webview request timed out` | 面板未就绪或被销毁 | 重开脑图面板后重试 |
| `... rollback failed ...` | 事务回滚阶段异常 | 重新读取 `aiGetTree` 后再执行一次修复操作 |
| 非事务下某步失败 | 前几步已生效 | 设 `strict: true` 查看 `partialResults`，用 `aiGetTree` 核对后再补操作；或改用 `transaction: true` 保证全有或全无 |

## 说明/限制

- Mermaid 解析/生成遵循“简单缩进式”mindmap：`mindmap -> root((title)) -> 每层 +2 空格标题`
- Webview 已把 `jsMind` 的脚本与样式内置进扩展包，因此可以完全离线使用（不依赖 `unpkg` 等 CDN）。
- 当前界面对所有支持格式统一采用“xmind 风格”：仅支持标题编辑与视图展开/折叠（结构增删/移动已隐藏；仍可通过快捷键/右键/粘贴等改结构）。
- 从“空白画布”开始编辑（尚未选择文件）时，点 `Save` 会走 `Save As`；`Save As` 仅支持输出为 `.mmd` 或 `.jm`（默认扩展名是 `.mmd`）。
- **Webview 面板**不能像普通文本文档那样在宿主侧统一“取消关闭”：**Ctrl+F4 / Ctrl+W（macOS：Cmd+W）** 在 **当前标签为脑图且存在未保存** 时由扩展拦截；**鼠标点标签 ×** 通常仍无法拦截；关闭 IDE 时见上文 **`deactivate` / `dirtyMindmapAtLastSync`** 说明。
- **`package.json` 未再声明 `menus.commandPalette` 白名单**：`contributes.commands` 中的命令默认可在命令面板中搜索到（若某环境仍看不到，请确认扩展已安装并重载窗口）。

