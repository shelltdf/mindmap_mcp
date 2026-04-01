var el = document.getElementById('mindmap-boot-json');
var __MINDMAP_BOOT__ = {};
if (el && el.textContent) {
  try {
    __MINDMAP_BOOT__ = JSON.parse(el.textContent);
  } catch (e0) {}
}

      (function () {
        // acquireVsCodeApi 仅 VS Code/Cursor Webview 提供；无宿主时用占位 API，并由 __mindmapBrowserDispatch 在网页中实现新建/打开/保存。
        if (typeof acquireVsCodeApi !== 'function') {
          window.__MINDMAP_BROWSER_FILE_OPS__ = true;
        }
        var _vscodeApi = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : null;
        function forwardToHost(msg) {
          if (_vscodeApi && _vscodeApi.postMessage) {
            try {
              _vscodeApi.postMessage(msg);
            } catch (_) {}
          } else {
            try {
              console.debug('[mindmap] postMessage (no VS Code host)', msg);
            } catch (_) {}
          }
        }
        var vscode = {
          postMessage: function (msg) {
            try {
              if (
                window.__MINDMAP_BROWSER_FILE_OPS__ &&
                typeof window.__mindmapBrowserDispatch === 'function' &&
                window.__mindmapBrowserDispatch(msg)
              ) {
                return;
              }
            } catch (e) {
              try {
                var em = e && e.message ? e.message : String(e);
                appendLog('error', 'postMessage dispatch: ' + em);
              } catch (_) {}
            }
            forwardToHost(msg);
          },
          setState: function (s) {
            return _vscodeApi && _vscodeApi.setState ? _vscodeApi.setState(s) : undefined;
          },
          getState: function () {
            return _vscodeApi && _vscodeApi.getState ? _vscodeApi.getState() : null;
          }
        };

        window.addEventListener('error', function (ev) {
          try {
            var msg =
              ev.error && ev.error.message
                ? ev.error.message
                : String(ev.message || 'Script error');
            appendLog('error', 'window.error: ' + msg);
            var el = document.getElementById('errorDialogMessage');
            var ov = document.getElementById('errorDialog');
            var title = document.getElementById('errorDialogTitle');
            if (title) {
              title.textContent = 'Script error';
            }
            if (el) {
              el.textContent = msg;
            }
            if (ov) {
              ov.classList.remove('hidden');
            }
          } catch (_) {}
        });
        window.addEventListener('unhandledrejection', function (ev) {
          try {
            var msg =
              ev.reason && ev.reason.message
                ? ev.reason.message
                : String(ev.reason || 'Unhandled rejection');
            appendLog('error', 'unhandledrejection: ' + msg);
            var el = document.getElementById('errorDialogMessage');
            var ov = document.getElementById('errorDialog');
            var title = document.getElementById('errorDialogTitle');
            if (title) {
              title.textContent = 'Script error';
            }
            if (el) {
              el.textContent = msg;
            }
            if (ov) {
              ov.classList.remove('hidden');
            }
          } catch (_) {}
        });

        function bindByIdClick(id, handler) {
          var el = document.getElementById(id);
          if (el) {
            el.addEventListener('click', handler);
          }
        }
        function elOn(el, type, handler, captureOrOptions) {
          if (!el) {
            return;
          }
          if (captureOrOptions === undefined) {
            el.addEventListener(type, handler);
          } else {
            el.addEventListener(type, handler, captureOrOptions);
          }
        }

        let contentDirty = false;
        let suppressDirty = false;

        function markContentDirty() {
          if (suppressDirty) return;
          contentDirty = true;
          try {
            vscode.postMessage({ type: 'mindmap:edited' });
          } catch (_) {}
        }

        function setContentClean() {
          contentDirty = false;
        }

        window.addEventListener('beforeunload', function (e) {
          if (contentDirty) {
            e.preventDefault();
            e.returnValue = '';
          }
        });

        /** @type {any} */
        let jm = null;

        /** 分配下一个未占用的 n_数字 id（从 n_1 起递增找空位），根 id 固定为 root 不参与。 */
        function allocateNextNodeId() {
          const used = new Set();
          if (jm && jm.mind && jm.mind.nodes) {
            const map = jm.mind.nodes;
            for (const key in map) {
              if (!Object.prototype.hasOwnProperty.call(map, key)) continue;
              const m = /^n_(\d+)$/.exec(String(key));
              if (m) used.add(parseInt(m[1], 10));
            }
          }
          let k = 1;
          while (used.has(k)) {
            k++;
          }
          return 'n_' + k;
        }

        /** 最近一次 init / setTree 的树数据；jsMind 未就绪时保存/另存为仍可用（如降级视图）。 */
        let lastKnownMindmapTree = null;
        /** @type {any} */
        let selectedNode = null;
        let dockFormatIconInited = false;
        /** 为 true 时表示正在从选中节点回填 Dock，忽略输入回调避免循环提交 */
        let dockFormatRefreshing = false;
        let rootId = null;
        let currentLang = 'en';
        let currentTheme = 'primary';
        const supportedThemes = [
          'default', 'primary', 'warning', 'danger', 'success', 'info',
          'greensea', 'nephrite', 'belizehole', 'wisteria', 'asphalt',
          'orange', 'pumpkin', 'pomegranate', 'clouds', 'asbestos'
        ];
        try {
          const savedJt = localStorage.getItem('mindmapJsmindTheme');
          if (savedJt && supportedThemes.indexOf(String(savedJt).toLowerCase()) >= 0) {
            currentTheme = String(savedJt).toLowerCase();
          }
        } catch (e) {}

        /** @type {'system'|'light'|'dark'} */
        let uiThemeMode = 'system';
        let uiThemeMediaQuery = null;

        function getEffectiveUiTheme() {
          if (uiThemeMode === 'light') return 'light';
          if (uiThemeMode === 'dark') return 'dark';
          try {
            if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
              return 'dark';
            }
          } catch (e) {}
          return 'light';
        }

        function applyUiThemeMode(mode) {
          const m = mode === 'light' || mode === 'dark' ? mode : 'system';
          uiThemeMode = m;
          try {
            localStorage.setItem('mindmapUiThemeMode', m);
          } catch (e) {}
          const eff = getEffectiveUiTheme();
          document.documentElement.setAttribute('data-mm-ui', eff);
          updateUiThemeMenuHighlight();
        }

        function onUiThemeSystemPreferenceChange() {
          if (uiThemeMode === 'system') {
            applyUiThemeMode('system');
          }
        }

        function bindUiThemeSystemListener() {
          try {
            if (uiThemeMediaQuery && uiThemeMediaQuery.removeEventListener) {
              uiThemeMediaQuery.removeEventListener('change', onUiThemeSystemPreferenceChange);
            }
            uiThemeMediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
            if (uiThemeMediaQuery && uiThemeMediaQuery.addEventListener) {
              uiThemeMediaQuery.addEventListener('change', onUiThemeSystemPreferenceChange);
            }
          } catch (e) {}
        }

        function updateUiThemeMenuHighlight() {
          const ids = ['menuUiThemeSystem', 'menuUiThemeLight', 'menuUiThemeDark'];
          for (let i = 0; i < ids.length; i++) {
            const el = document.getElementById(ids[i]);
            if (!el) continue;
            el.classList.remove('mm-menu-ui-theme-active');
          }
          const activeId =
            uiThemeMode === 'light'
              ? 'menuUiThemeLight'
              : uiThemeMode === 'dark'
                ? 'menuUiThemeDark'
                : 'menuUiThemeSystem';
          const ael = document.getElementById(activeId);
          if (ael) ael.classList.add('mm-menu-ui-theme-active');
        }

        try {
          const um = localStorage.getItem('mindmapUiThemeMode');
          if (um === 'light' || um === 'dark' || um === 'system') {
            uiThemeMode = um;
          }
        } catch (e) {}
        applyUiThemeMode(uiThemeMode);
        bindUiThemeSystemListener();

        const statusbarEl = document.getElementById('statusbar');
        const statusbarTextEl = document.getElementById('statusbarText');
        const canvasZoomStackEl = document.getElementById('canvasZoomStack');
        const canvasZoomBadgeEl = document.getElementById('canvasZoomBadge');
        const canvasZoomValueEl = document.getElementById('canvasZoomValue');
        const statusbarSaveLightEl = document.getElementById('statusbarSaveLight');
        const logDialogEl = document.getElementById('logDialog');
        const logFullTextEl = document.getElementById('logFullText');
        /** 与窗口 GUI 规则一致：统一日志流，上限约 4000 行（超出丢弃最旧）。 */
        const LOG_MAX_LINES = 4000;
        const logLines = [];
        /** 为 true 时表示当前由快捷键触发：无效操作只写状态栏 + Log，不弹 errorDialog */
        let invalidActionKeyboardContext = false;

        function logTimestamp() {
          return new Date().toISOString().replace('T', ' ').slice(0, 19);
        }

        function appendLog(level, text) {
          const lv = (level || 'info').toLowerCase();
          const line =
            '[' +
            logTimestamp() +
            '] [' +
            lv.toUpperCase() +
            '] ' +
            String(text == null ? '' : text);
          logLines.push(line);
          while (logLines.length > LOG_MAX_LINES) {
            logLines.shift();
          }
        }

        function refreshLogPre() {
          if (logFullTextEl) {
            logFullTextEl.textContent = logLines.join(String.fromCharCode(10));
          }
        }

        function scrollLogPreToBottom() {
          if (!logFullTextEl) return;
          logFullTextEl.scrollTop = logFullTextEl.scrollHeight;
        }

        function showLogDialog() {
          refreshLogPre();
          if (logDialogEl) {
            logDialogEl.classList.remove('hidden');
          }
          requestAnimationFrame(function () {
            scrollLogPreToBottom();
            requestAnimationFrame(scrollLogPreToBottom);
          });
          const closeBtn = document.getElementById('logCloseBtn');
          if (closeBtn) {
            closeBtn.focus();
          }
        }

        function hideLogDialog() {
          if (logDialogEl) {
            logDialogEl.classList.add('hidden');
          }
        }

        function copyLogToClipboard() {
          const text = logLines.join(String.fromCharCode(10));
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).catch(function () {});
          }
        }
        const fallbackTreeEl = document.getElementById('fallbackTree');
        const rootMirrorEl = document.getElementById('rootMirror');
        let saveTrafficLightState = 'green';

        function applySaveTrafficLight(light) {
          const L = light === 'yellow' || light === 'red' ? light : 'green';
          saveTrafficLightState = L;
          if (!statusbarSaveLightEl) return;
          statusbarSaveLightEl.classList.remove('green', 'yellow', 'red');
          statusbarSaveLightEl.classList.add(L);
          var tipKey = L === 'yellow' ? 'saveLightYellow' : L === 'red' ? 'saveLightRed' : 'saveLightGreen';
          statusbarSaveLightEl.title = t(tipKey);
          statusbarSaveLightEl.setAttribute('aria-label', t(tipKey));
        }
        const errorDialogEl = document.getElementById('errorDialog');
        const errorDialogMsgEl = document.getElementById('errorDialogMessage');
        const errorDialogConfirmBtn = document.getElementById('errorDialogConfirm');
        let pendingMcpNoticeRequestId = null;

        const i18n = {
          en: {
            ready: 'Ready',
            selected: 'Selected: ',
            dialogTitle: 'Notice',
            dialogConfirm: 'OK',
            objCtxTitle: 'Object Context Menu',
            canvasCtxTitle: 'Canvas Context Menu',
            ctxAddChild: 'Add Child Node',
            ctxAddSibling: 'Add Sibling Node',
            ctxDeleteNode: 'Delete',
            ctxCopyNode: 'Copy',
            ctxCutNode: 'Cut',
            ctxPasteNode: 'Paste',
            ctxPasteCanvas: 'Paste Under Root',
            ctxPromoteNode: 'Promote',
            ctxDemoteNode: 'Demote',
            ctxCenterRoot: 'Center Root Node',
            ctxFitAll: 'Fit All',
            ctxResetZoom: 'Reset Zoom',
            menuOpenLog: 'View Log',
            menuSupportedFormats: 'Supported formats…',
            helpSupportedFormatsTitle: 'Supported file formats',
            helpSupportedFormatsBody:
              'This editor supports the following types:\n\n' +
              '• .jm — jsMind mind map (node_tree JSON). Full read/write.\n\n' +
              '• .mmd — Indent-based mind map in the Mermaid mindmap style (grammar is implementation-specific). As a Custom Text Editor, the file is a normal text document (dirty indicator, Ctrl+S).\n\n' +
              '• .xmind — XMind workbook. Open/save supported; some structure commands may be hidden in the “xmind style” UI (see current build).\n\n' +
              'Use File → Open / Save As and choose the extension; the format follows the file suffix.',
            logDialogTitle: 'Log',
            logCopyAll: 'Copy all',
            logClose: 'Close',
            statusbarLogHint: 'Click to view full log (plain text, copy supported)',
            zoomDblClickReset: 'Double-click to reset to 100% and center (root in view)',
            zoomOut: 'Zoom out',
            zoomIn: 'Zoom in',
            zoomBadgeFit: 'Fit',
            zoomBadgeCenterRoot: 'Root',
            zoomBadgeReset: 'Reset',
            zoomStackAria: 'Fit view, center root, reset zoom, and scale controls',
            zoomControlsAria: 'Zoom controls',
            canvasShortcutHintsTitle: 'Shortcuts',
            canvasShortcutHintsHoverTitle: 'Hover to show the full shortcut list',
            canvasShortcutHints:
              '— After selecting a node —\n' +
              '↑↓ — siblings\n' +
              '← — parent\n' +
              '→ — first child\n' +
              'Enter — sibling\n' +
              'Tab — child\n' +
              'Del / ⌫ — delete\n' +
              'Alt+↑↓ — reorder\n' +
              'Alt+←→ — promote / demote\n' +
              'Double-click node — edit topic\n' +
              '\n' +
              '— No selection required —\n' +
              'Wheel — zoom\n' +
              'MMB drag — pan\n' +
              'Ctrl+Space — full screen',
            dockFormatEdge: 'Format dock — click to expand/collapse',
            dockIconEdge: 'Icon dock — click to expand/collapse',
            dockJsmindThemeEdge: 'Mind map theme dock — click to expand/collapse',
            dockPanelFormat: 'Format',
            dockPanelIcon: 'Icon',
            dockPanelJsmindTheme: 'Mind map theme',
            dockBtnCollapse: 'Collapse',
            dockBtnMaximize: 'Maximize',
            dockBtnRestore: 'Restore',
            dockLblNodeId: 'Node ID',
            dockLblTopic: 'Content',
            dockLblFont: 'Font',
            dockLblSize: 'Size',
            dockLblColor: 'Text color',
            dockLblBg: 'Background',
            dockBtnResetFormat: 'Reset',
            dockHintNoSelection: 'Select a node to edit format.',
            dockHintIconNoSelection: 'Select a node to set icon.',
            dockFontDefault: 'Default',
            dockIconNone: 'None',
            dockIconStar: 'Star',
            dockIconFlag: 'Flag',
            dockIconBulb: 'Bulb',
            dockIconBook: 'Book',
            dockIconCheck: 'Check',
            dockIconWarn: 'Warn',
            dockIconHeart: 'Heart',
            dockIconRocket: 'Rocket',
            dockIconPin: 'Pin',
            htoolbarLabel: 'Toolbar',
            appTitlePrimary: 'Mindmap',
            appTitleSecondary: 'MindmapEditor',
            appTitleBannerAria: 'Mindmap Editor',
            titleBarFullScreen: 'Full screen — toggle desktop window (VS Code)',
            defaultChildTopic: 'Subtopic',
            sumFile: 'File',
            sumEdit: 'Edit',
            sumView: 'View',
            sumInsert: 'Insert',
            sumModify: 'Modify',
            sumUiTheme: 'Theme',
            menuUiThemeSystem: 'Follow system',
            menuUiThemeLight: 'Light',
            menuUiThemeDark: 'Dark',
            sumTools: 'Tools',
            sumWindow: 'Window',
            sumHelp: 'Help',
            sumLanguage: 'Language',
            menuNew: 'New',
            menuOpen: 'Open',
            menuSave: 'Save',
            menuSaveAs: 'Save As',
            menuCopy: 'Copy',
            menuCut: 'Cut',
            menuPaste: 'Paste',
            menuPromote: 'Promote',
            menuDemote: 'Demote',
            menuExpand: 'Expand',
            menuCollapse: 'Collapse',
            menuToggle: 'Toggle',
            menuExpandAll: 'Expand All',
            menuInsertImage: 'Insert image',
            menuInsertText: 'Insert text',
            menuInsertWhiteboard: 'Insert whiteboard',
            menuInsertVideo: 'Insert video',
            menuInsertAudio: 'Insert audio',
            menuInsertGltf: 'Insert glTF model',
            menuInsertTable: 'Insert table',
            embedPromptUrl: 'Resource URL (https:// or path):',
            embedPromptText: 'Text content:',
            embedPromptTable: 'Table size: rows×cols (e.g. 3x4):',
            embedNoUrl: '(empty)',
            embedTopicPrefix_image: '[Image]',
            embedTopicPrefix_text: '[Text]',
            embedTopicPrefix_whiteboard: '[Whiteboard]',
            embedTopicPrefix_video: '[Video]',
            embedTopicPrefix_audio: '[Audio]',
            embedTopicPrefix_gltf: '[glTF]',
            embedTopicPrefix_table: '[Table]',
            menuToolsNone: '(none)',
            menuToggleDock: 'Mindmap: Toggle Dock Maximized',
            alertNoSelectAddChild: 'Select a node first, then add child node.',
            alertNoSelectAddSibling: 'Select a node first, then add sibling node.',
            alertRootNoSibling: 'Root node cannot have sibling nodes.',
            alertNoParentSibling: 'Current node has no parent; cannot add sibling node.',
            alertNoSelectDelete: 'Select a node first, then delete.',
            alertRootNoDelete: 'Root node cannot be deleted.',
            alertNoSelectCopy: 'Select a node first, then copy.',
            alertNoSelectCut: 'Select a node first, then cut.',
            alertRootNoCut: 'Root node cannot be cut.',
            alertPasteNoData: 'Clipboard has no mindmap subtree. Copy a node in this editor first.',
            alertPasteFailed: 'Paste failed.',
            alertNoSelectPromote: 'Select a node first, then promote.',
            alertCannotPromote: 'Cannot promote this node (already under root).',
            alertRootNoPromote: 'Cannot promote the root.',
            alertNoSelectDemote: 'Select a node first, then demote.',
            alertCannotDemote: 'Cannot demote: there is no previous sibling to attach under.',
            alertRootNoDemote: 'Cannot demote the root.',
            alertPromoteDemoteFailed: 'Move failed (invalid target).',
            alertNoSelectExpand: 'Select a node first, then expand.',
            alertNoSelectCollapse: 'Select a node first, then collapse.',
            alertNoSelectToggle: 'Select a node first, then toggle.',
            invalidTheme: 'Unsupported theme: ',
            saveLightGreen: 'Saved (no unsaved changes)',
            saveLightYellow: 'Unsaved changes',
            saveLightRed: 'Not saved to disk yet'
          },
          zh: {
            ready: '就绪',
            selected: '选中：',
            dialogTitle: '操作提示',
            dialogConfirm: '确认',
            objCtxTitle: '对象右键菜单',
            canvasCtxTitle: '画布右键菜单',
            ctxAddChild: '添加子节点',
            ctxAddSibling: '添加兄弟节点',
            ctxDeleteNode: '删除',
            ctxCopyNode: '复制',
            ctxCutNode: '剪切',
            ctxPasteNode: '粘贴',
            ctxPasteCanvas: '粘贴到根节点',
            ctxPromoteNode: '提升',
            ctxDemoteNode: '下降',
            ctxCenterRoot: '根节点居正显示',
            ctxFitAll: '全部显示',
            ctxResetZoom: '还原缩放比例',
            menuOpenLog: '查看日志',
            menuSupportedFormats: '文件格式说明…',
            helpSupportedFormatsTitle: '支持的文件格式',
            helpSupportedFormatsBody:
              '本编辑器支持下列类型：\n\n' +
              '• .jm — jsMind 脑图（node_tree JSON），完整读写。\n\n' +
              '• .mmd — 缩进式 Mermaid mindmap 风格文本（语法以本实现约定为准）。作为自定义文本编辑器打开时与普通文档一致（脏标记、Ctrl+S 保存）。\n\n' +
              '• .xmind — XMind 工作簿，支持打开与保存；界面可为「xmind 风格」，部分结构命令以实现为准。\n\n' +
              '通过「文件 → 打开 / 另存为」选择扩展名；格式由文件后缀决定。',
            logDialogTitle: '日志',
            logCopyAll: '复制全部',
            logClose: '关闭',
            statusbarLogHint: '点击查看完整日志（纯文本，可复制）',
            zoomDblClickReset: '双击中间数字：还原为 100% 并以视图中心对齐根节点',
            zoomOut: '缩小',
            zoomIn: '放大',
            zoomBadgeFit: '适应',
            zoomBadgeCenterRoot: '根节点',
            zoomBadgeReset: '还原',
            zoomStackAria: '适应画布、根节点居正、还原缩放与比例缩放',
            zoomControlsAria: '缩放控件',
            canvasShortcutHintsTitle: '快捷键',
            canvasShortcutHintsHoverTitle: '鼠标悬停显示完整快捷键列表',
            canvasShortcutHints:
              '— 选中对象后 —\n' +
              '↑↓ — 兄弟\n' +
              '← — 父节点\n' +
              '→ — 首子节点\n' +
              'Enter — 兄弟\n' +
              'Tab — 子节点\n' +
              'Del / 退格 — 删除\n' +
              'Alt+↑↓ — 顺序\n' +
              'Alt+←→ — 提升 / 下降\n' +
              '双击节点 — 编辑内容\n' +
              '\n' +
              '— 无需选中 —\n' +
              '滚轮 — 缩放\n' +
              '中键拖拽 — 平移\n' +
              'Ctrl+空格 — 全屏',
            dockFormatEdge: '格式 Dock — 点击展开/折叠',
            dockIconEdge: '图标 Dock — 点击展开/折叠',
            dockJsmindThemeEdge: '脑图主题 Dock — 点击展开/折叠',
            dockPanelFormat: '格式',
            dockPanelIcon: '图标',
            dockPanelJsmindTheme: '脑图主题',
            dockBtnCollapse: '折叠',
            dockBtnMaximize: '最大化',
            dockBtnRestore: '还原',
            dockLblNodeId: '节点 ID',
            dockLblTopic: '内容',
            dockLblFont: '字体',
            dockLblSize: '字号',
            dockLblColor: '文字颜色',
            dockLblBg: '背景色',
            dockBtnResetFormat: '重置',
            dockHintNoSelection: '请先选中节点再设置格式。',
            dockHintIconNoSelection: '请先选中节点再设置图标。',
            dockFontDefault: '默认',
            dockIconNone: '无图标',
            dockIconStar: '星标',
            dockIconFlag: '旗帜',
            dockIconBulb: '灯泡',
            dockIconBook: '书本',
            dockIconCheck: '勾选',
            dockIconWarn: '警告',
            dockIconHeart: '心形',
            dockIconRocket: '火箭',
            dockIconPin: '图钉',
            htoolbarLabel: '工具栏',
            appTitlePrimary: '脑图',
            appTitleSecondary: 'Mindmap 编辑器',
            appTitleBannerAria: '脑图编辑器',
            titleBarFullScreen: '全屏 — 切换桌面窗口全屏（与 VS Code 一致）',
            defaultChildTopic: '子主题',
            sumFile: '文件',
            sumEdit: '编辑',
            sumView: '视图',
            sumInsert: '插入',
            sumModify: '修改',
            sumUiTheme: '主题',
            menuUiThemeSystem: '跟随系统',
            menuUiThemeLight: '浅色',
            menuUiThemeDark: '深色',
            sumTools: '工具',
            sumWindow: '窗口',
            sumHelp: '帮助',
            sumLanguage: '语言',
            menuNew: '新建',
            menuOpen: '打开',
            menuSave: '保存',
            menuSaveAs: '另存为',
            menuCopy: '复制',
            menuCut: '剪切',
            menuPaste: '粘贴',
            menuPromote: '提升',
            menuDemote: '下降',
            menuExpand: '展开',
            menuCollapse: '折叠',
            menuToggle: '切换展开/折叠',
            menuExpandAll: '全部展开',
            menuInsertImage: '插入图片',
            menuInsertText: '插入文字',
            menuInsertWhiteboard: '插入白板',
            menuInsertVideo: '插入视频',
            menuInsertAudio: '插入音频',
            menuInsertGltf: '插入 glTF 模型',
            menuInsertTable: '插入表格',
            embedPromptUrl: '资源地址（https:// 或本地路径）：',
            embedPromptText: '文字内容：',
            embedPromptTable: '表格行列，如 3x4：',
            embedNoUrl: '（空）',
            embedTopicPrefix_image: '[图片]',
            embedTopicPrefix_text: '[文字]',
            embedTopicPrefix_whiteboard: '[白板]',
            embedTopicPrefix_video: '[视频]',
            embedTopicPrefix_audio: '[音频]',
            embedTopicPrefix_gltf: '[glTF 模型]',
            embedTopicPrefix_table: '[表格]',
            menuToolsNone: '（无）',
            menuToggleDock: '脑图：最大化/还原停靠区',
            alertNoSelectAddChild: '请先选中一个节点，再添加子节点。',
            alertNoSelectAddSibling: '请先选中一个节点，再添加兄弟节点。',
            alertRootNoSibling: '根节点不能添加兄弟节点。',
            alertNoParentSibling: '当前节点没有父节点，无法添加兄弟节点。',
            alertNoSelectDelete: '请先选中一个节点，再执行删除。',
            alertRootNoDelete: '不能删除根节点。',
            alertNoSelectCopy: '请先选中一个节点，再复制。',
            alertNoSelectCut: '请先选中一个节点，再剪切。',
            alertRootNoCut: '不能剪切根节点。',
            alertPasteNoData: '剪贴板中没有可粘贴的脑图节点，请先在编辑器内复制节点。',
            alertPasteFailed: '粘贴失败。',
            alertNoSelectPromote: '请先选中一个节点，再执行提升。',
            alertCannotPromote: '无法提升：该节点已在根下。',
            alertRootNoPromote: '不能提升根节点。',
            alertNoSelectDemote: '请先选中一个节点，再执行下降。',
            alertCannotDemote: '无法下降：上方没有可作为父节点的前一兄弟节点。',
            alertRootNoDemote: '不能下降根节点。',
            alertPromoteDemoteFailed: '移动失败（目标无效）。',
            alertNoSelectExpand: '请先选中一个节点，再执行展开。',
            alertNoSelectCollapse: '请先选中一个节点，再执行折叠。',
            alertNoSelectToggle: '请先选中一个节点，再执行切换展开/折叠。',
            invalidTheme: '不支持的主题：',
            saveLightGreen: '已保存（无未保存修改）',
            saveLightYellow: '有未保存修改',
            saveLightRed: '尚未保存到磁盘'
          }
        };

        function t(key) {
          const dict = i18n[currentLang] || i18n.en;
          return dict[key] || key;
        }

        /** [英文占位, 图标, 快捷键提示] — 工具栏仅显示图标，文案在 title / aria-label */
        const toolbarLabelMap = {
          btnNew: ['New', '＋', 'Ctrl/Cmd+N'],
          btnOpen: ['Open', '📂', 'Ctrl/Cmd+O'],
          btnSave: ['Save', '💾', 'Ctrl/Cmd+S'],
          btnSaveAs: ['Save As', '🖫', 'Ctrl/Cmd+Shift+S']
        };

        function applyHtoolbarLabels() {
          const items = [
            ['btnNew', 'menuNew'],
            ['btnOpen', 'menuOpen'],
            ['btnSave', 'menuSave'],
            ['btnSaveAs', 'menuSaveAs']
          ];
          for (let i = 0; i < items.length; i++) {
            const id = items[i][0];
            const menuKey = items[i][1];
            const btn = document.getElementById(id);
            if (!btn) continue;
            const meta = toolbarLabelMap[id];
            if (!meta) continue;
            const icon = meta[1];
            const shortcut = meta[2];
            btn.textContent = icon;
            const tip = shortcut ? t(menuKey) + ' (' + shortcut + ')' : t(menuKey);
            btn.title = tip;
            btn.setAttribute('aria-label', tip);
          }
        }

        let formatDockCollapsed = false;
        let iconDockCollapsed = false;
        let themeDockCollapsed = false;
        let formatDockMaximized = false;
        let iconDockMaximized = false;
        let themeDockMaximized = false;

        function applyDockMaximizeUi() {
          const df = document.getElementById('dockFormat');
          const di = document.getElementById('dockIcon');
          const dt = document.getElementById('dockJsmindTheme');
          if (!df || !di || !dt) return;
          const fc = formatDockCollapsed;
          const ic = iconDockCollapsed;
          const tc = themeDockCollapsed;
          df.classList.toggle('dock-maximized', formatDockMaximized && !fc);
          di.classList.toggle('dock-maximized', iconDockMaximized && !ic);
          dt.classList.toggle('dock-maximized', themeDockMaximized && !tc);
          df.classList.toggle(
            'dock-peer-squash',
            (iconDockMaximized && !ic && !fc) || (themeDockMaximized && !tc && !fc)
          );
          di.classList.toggle(
            'dock-peer-squash',
            (formatDockMaximized && !fc && !ic) || (themeDockMaximized && !tc && !ic)
          );
          dt.classList.toggle(
            'dock-peer-squash',
            (formatDockMaximized && !fc && !tc) || (iconDockMaximized && !ic && !tc)
          );
        }

        function updateDockMaximizeButtons() {
          const mf = document.getElementById('btnDockFormatMaximize');
          const mi = document.getElementById('btnDockIconMaximize');
          const mt = document.getElementById('btnDockJsmindThemeMaximize');
          const bfc = document.getElementById('btnDockFormatCollapse');
          const bic = document.getElementById('btnDockIconCollapse');
          const btc = document.getElementById('btnDockJsmindThemeCollapse');
          if (bfc) {
            bfc.title = t('dockBtnCollapse');
            bfc.setAttribute('aria-label', t('dockBtnCollapse'));
          }
          if (bic) {
            bic.title = t('dockBtnCollapse');
            bic.setAttribute('aria-label', t('dockBtnCollapse'));
          }
          if (btc) {
            btc.title = t('dockBtnCollapse');
            btc.setAttribute('aria-label', t('dockBtnCollapse'));
          }
          if (mf) {
            const r = formatDockMaximized;
            mf.title = r ? t('dockBtnRestore') : t('dockBtnMaximize');
            mf.setAttribute('aria-label', mf.title);
            mf.textContent = r ? '❐' : '□';
          }
          if (mi) {
            const r = iconDockMaximized;
            mi.title = r ? t('dockBtnRestore') : t('dockBtnMaximize');
            mi.setAttribute('aria-label', mi.title);
            mi.textContent = r ? '❐' : '□';
          }
          if (mt) {
            const r = themeDockMaximized;
            mt.title = r ? t('dockBtnRestore') : t('dockBtnMaximize');
            mt.setAttribute('aria-label', mt.title);
            mt.textContent = r ? '❐' : '□';
          }
        }

        function applyFormatDockCollapsed(collapsed) {
          formatDockCollapsed = collapsed;
          const el = document.getElementById('dockFormat');
          if (el) el.classList.toggle('collapsed', collapsed);
          if (collapsed) formatDockMaximized = false;
          applyDockMaximizeUi();
          updateDockMaximizeButtons();
        }

        function applyIconDockCollapsed(collapsed) {
          iconDockCollapsed = collapsed;
          const el = document.getElementById('dockIcon');
          if (el) el.classList.toggle('collapsed', collapsed);
          if (collapsed) iconDockMaximized = false;
          applyDockMaximizeUi();
          updateDockMaximizeButtons();
        }

        function applyThemeDockCollapsed(collapsed) {
          themeDockCollapsed = collapsed;
          const el = document.getElementById('dockJsmindTheme');
          if (el) el.classList.toggle('collapsed', collapsed);
          if (collapsed) themeDockMaximized = false;
          applyDockMaximizeUi();
          updateDockMaximizeButtons();
        }

        function resetCanvasShortcutHintsAria() {
          const trig = document.getElementById('canvasShortcutHintsTrigger');
          const body = document.getElementById('canvasShortcutHintsBody');
          if (trig) trig.setAttribute('aria-expanded', 'false');
          if (body) body.setAttribute('aria-hidden', 'true');
        }

        function applyLanguage(lang) {
          currentLang = lang === 'zh' ? 'zh' : 'en';
          const byId = (id, text) => {
            const el = document.getElementById(id);
            if (el) el.textContent = text;
          };
          byId('sumFile', t('sumFile'));
          byId('sumEdit', t('sumEdit'));
          byId('sumView', t('sumView'));
          byId('sumInsert', t('sumInsert'));
          byId('sumModify', t('sumModify'));
          byId('sumUiTheme', t('sumUiTheme'));
          byId('menuUiThemeSystem', t('menuUiThemeSystem'));
          byId('menuUiThemeLight', t('menuUiThemeLight'));
          byId('menuUiThemeDark', t('menuUiThemeDark'));
          byId('sumTools', t('sumTools'));
          byId('sumWindow', t('sumWindow'));
          byId('sumHelp', t('sumHelp'));
          byId('sumLanguage', t('sumLanguage'));
          byId('menuNew', t('menuNew'));
          byId('menuOpen', t('menuOpen'));
          byId('menuSave', t('menuSave'));
          byId('menuSaveAs', t('menuSaveAs'));
          byId('menuCopy', t('menuCopy'));
          byId('menuCut', t('menuCut'));
          byId('menuPaste', t('menuPaste'));
          byId('menuPromote', t('menuPromote'));
          byId('menuDemote', t('menuDemote'));
          byId('menuExpand', t('menuExpand'));
          byId('menuCollapse', t('menuCollapse'));
          byId('menuToggle', t('menuToggle'));
          byId('menuExpandAll', t('menuExpandAll'));
          byId('menuToggleDock', t('menuToggleDock'));
          byId('menuInsertImage', t('menuInsertImage'));
          byId('menuInsertText', t('menuInsertText'));
          byId('menuInsertWhiteboard', t('menuInsertWhiteboard'));
          byId('menuInsertVideo', t('menuInsertVideo'));
          byId('menuInsertAudio', t('menuInsertAudio'));
          byId('menuInsertGltf', t('menuInsertGltf'));
          byId('menuInsertTable', t('menuInsertTable'));
          byId('menuToolsNone', t('menuToolsNone'));
          byId('menuOpenLog', t('menuOpenLog'));
          byId('menuSupportedFormats', t('menuSupportedFormats'));
          byId('logDialogTitle', t('logDialogTitle'));
          const logCopyBtn = document.getElementById('logCopyBtn');
          const logCloseBtn = document.getElementById('logCloseBtn');
          if (logCopyBtn) logCopyBtn.textContent = t('logCopyAll');
          if (logCloseBtn) logCloseBtn.textContent = t('logClose');
          const sbTitleEl = document.getElementById('statusbar');
          if (sbTitleEl) sbTitleEl.title = t('statusbarLogHint');
          if (canvasZoomValueEl) canvasZoomValueEl.title = t('zoomDblClickReset');
          const zFit = document.getElementById('canvasZoomFit');
          const zRoot = document.getElementById('canvasZoomCenterRoot');
          const zReset = document.getElementById('canvasZoomReset');
          if (zFit) {
            zFit.textContent = t('zoomBadgeFit');
            zFit.title = t('ctxFitAll');
            zFit.setAttribute('aria-label', t('ctxFitAll'));
          }
          if (zRoot) {
            zRoot.textContent = t('zoomBadgeCenterRoot');
            zRoot.title = t('ctxCenterRoot');
            zRoot.setAttribute('aria-label', t('ctxCenterRoot'));
          }
          if (zReset) {
            zReset.textContent = t('zoomBadgeReset');
            zReset.title = t('ctxResetZoom');
            zReset.setAttribute('aria-label', t('ctxResetZoom'));
          }
          const zOut = document.getElementById('canvasZoomOut');
          const zIn = document.getElementById('canvasZoomIn');
          if (zOut) {
            zOut.title = t('zoomOut');
            zOut.setAttribute('aria-label', t('zoomOut'));
          }
          if (zIn) {
            zIn.title = t('zoomIn');
            zIn.setAttribute('aria-label', t('zoomIn'));
          }
          if (canvasZoomStackEl) {
            canvasZoomStackEl.setAttribute('aria-label', t('zoomStackAria'));
          }
          if (canvasZoomBadgeEl) {
            canvasZoomBadgeEl.setAttribute('aria-label', t('zoomControlsAria'));
          }
          byId('canvasShortcutHintsTitleText', t('canvasShortcutHintsTitle'));
          const trigShortcut = document.getElementById('canvasShortcutHintsTrigger');
          if (trigShortcut) trigShortcut.title = t('canvasShortcutHintsHoverTitle');
          const canvasShortcutHintsBodyEl = document.getElementById('canvasShortcutHintsBody');
          if (canvasShortcutHintsBodyEl) {
            canvasShortcutHintsBodyEl.textContent = t('canvasShortcutHints');
          }
          resetCanvasShortcutHintsAria();
          byId('objCtxTitle', t('objCtxTitle'));
          byId('canvasCtxTitle', t('canvasCtxTitle'));
          byId('ctxAddChild', t('ctxAddChild'));
          byId('ctxAddSibling', t('ctxAddSibling'));
          byId('ctxDeleteNode', t('ctxDeleteNode'));
          byId('ctxCopyNode', t('ctxCopyNode'));
          byId('ctxCutNode', t('ctxCutNode'));
          byId('ctxPasteNode', t('ctxPasteNode'));
          byId('ctxPasteCanvas', t('ctxPasteCanvas'));
          byId('ctxPromoteNode', t('ctxPromoteNode'));
          byId('ctxDemoteNode', t('ctxDemoteNode'));
          byId('ctxCenterRoot', t('ctxCenterRoot'));
          byId('ctxFitAll', t('ctxFitAll'));
          byId('ctxResetZoom', t('ctxResetZoom'));
          byId('errorDialogTitle', t('dialogTitle'));
          byId('errorDialogConfirm', t('dialogConfirm'));
          const htb = document.getElementById('htoolbar');
          if (htb) htb.setAttribute('aria-label', t('htoolbarLabel'));
          byId('appTitleName', t('appTitlePrimary'));
          byId('appTitleSub', t('appTitleSecondary'));
          const appTitleBarEl = document.getElementById('appTitleBar');
          if (appTitleBarEl) appTitleBarEl.setAttribute('aria-label', t('appTitleBannerAria'));
          const btnTitleFs = document.getElementById('btnTitleFullScreen');
          if (btnTitleFs) {
            btnTitleFs.title = t('titleBarFullScreen');
            btnTitleFs.setAttribute('aria-label', t('titleBarFullScreen'));
          }
          const appTitleIconImgEl = document.getElementById('appTitleIconImg');
          const appTitleIconWrapEl = document.getElementById('appTitleIconWrap');
          if (appTitleIconImgEl && appTitleIconWrapEl && !appTitleIconImgEl.dataset.fallbackBound) {
            appTitleIconImgEl.dataset.fallbackBound = '1';
            appTitleIconImgEl.addEventListener('error', function () {
              appTitleIconWrapEl.classList.add('fallback-png-missing');
            });
          }
          const bdf = document.getElementById('btnToggleDockFormat');
          const bdi = document.getElementById('btnToggleDockIcon');
          const bdt = document.getElementById('btnToggleDockJsmindTheme');
          if (bdf) bdf.title = t('dockFormatEdge');
          if (bdi) bdi.title = t('dockIconEdge');
          if (bdt) bdt.title = t('dockJsmindThemeEdge');
          byId('dockFormatTitle', t('dockPanelFormat'));
          byId('dockIconTitle', t('dockPanelIcon'));
          byId('dockJsmindThemeTitle', t('dockPanelJsmindTheme'));
          byId('dockLblNodeId', t('dockLblNodeId'));
          byId('dockLblTopic', t('dockLblTopic'));
          byId('dockLblFont', t('dockLblFont'));
          byId('dockLblSize', t('dockLblSize'));
          byId('dockLblColor', t('dockLblColor'));
          byId('dockLblBg', t('dockLblBg'));
          const dockReset = document.getElementById('dockBtnResetFormat');
          if (dockReset) dockReset.textContent = t('dockBtnResetFormat');
          populateDockFontSelect();
          buildDockIconGrid();
          buildDockJsmindThemeGrid();
          refreshDockFromSelection();
          applyHtoolbarLabels();
          updateDockMaximizeButtons();
          applySaveTrafficLight(saveTrafficLightState);
        }

        function setStatus(text, isError) {
          if (statusbarTextEl) statusbarTextEl.textContent = text;
          if (statusbarEl) statusbarEl.classList.toggle('error', !!isError);
          appendLog(isError ? 'error' : 'info', text);
        }

        function showErrorDialog(message) {
          pendingMcpNoticeRequestId = null;
          try {
            appendLog(
              'error',
              (currentLang === 'zh' ? '操作提示: ' : 'Notice: ') + String(message == null ? '' : message)
            );
          } catch (_) {}
          const titleEl = document.getElementById('errorDialogTitle');
          if (titleEl) titleEl.textContent = t('dialogTitle');
          if (errorDialogMsgEl) errorDialogMsgEl.textContent = message;
          if (errorDialogEl) errorDialogEl.classList.remove('hidden');
          if (errorDialogConfirmBtn) errorDialogConfirmBtn.focus();
        }

        function hideErrorDialog() {
          pendingMcpNoticeRequestId = null;
          const titleEl = document.getElementById('errorDialogTitle');
          if (titleEl) titleEl.textContent = t('dialogTitle');
          if (errorDialogEl) errorDialogEl.classList.add('hidden');
        }

        function showSupportedFormatsDialog() {
          const titleEl = document.getElementById('errorDialogTitle');
          if (titleEl) titleEl.textContent = t('helpSupportedFormatsTitle');
          if (errorDialogConfirmBtn) errorDialogConfirmBtn.textContent = t('dialogConfirm');
          if (errorDialogMsgEl) errorDialogMsgEl.textContent = t('helpSupportedFormatsBody');
          if (errorDialogEl) errorDialogEl.classList.remove('hidden');
          if (errorDialogConfirmBtn) errorDialogConfirmBtn.focus();
        }

        function escapeHtml(s) {
          return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
        }
        /** 不用 innerHTML 批量清空，避免与 blur/编辑并发时 Chromium 抛错（node no longer a child）。 */
        function clearDomChildren(el) {
          if (!el) return;
          while (el.firstChild) {
            try {
              el.removeChild(el.firstChild);
            } catch (_) {
              break;
            }
          }
        }
        /** innerHTML 赋值失败时回退为清空再逐节点插入（同上类竞态）。 */
        function safeSetInnerHTML(el, html) {
          if (!el) return;
          try {
            el.innerHTML = html;
          } catch (_) {
            clearDomChildren(el);
            if (!html) return;
            try {
              var wrap = document.createElement('div');
              wrap.innerHTML = html;
              while (wrap.firstChild) {
                el.appendChild(wrap.firstChild);
              }
            } catch (_) {}
          }
        }
        function makeFallbackTreeHtml(node) {
          if (!node) return '<li>(empty)</li>';
          const title = escapeHtml(node.topic != null ? node.topic : '');
          const children = Array.isArray(node.children) ? node.children : [];
          if (!children.length) {
            return '<li>' + title + '</li>';
          }
          return '<li>' + title + '<ul>' + children.map(makeFallbackTreeHtml).join('') + '</ul></li>';
        }
        function showFallbackTree(tree) {
          if (!fallbackTreeEl) return;
          const root = tree && tree.root ? tree.root : null;
          safeSetInnerHTML(
            fallbackTreeEl,
            '<div style="font-weight:700;margin-bottom:6px;">' +
              (currentLang === 'zh' ? '脑图渲染降级视图' : 'Mindmap Fallback View') +
              '</div><ul>' +
              makeFallbackTreeHtml(root) +
              '</ul>'
          );
          fallbackTreeEl.classList.remove('hidden');
        }
        function hideFallbackTree() {
          if (!fallbackTreeEl) return;
          fallbackTreeEl.classList.add('hidden');
          clearDomChildren(fallbackTreeEl);
        }
        function showRootMirror(tree) {
          if (!rootMirrorEl) return;
          const topic =
            tree && tree.root && tree.root.topic != null
              ? String(tree.root.topic)
              : (currentLang === 'zh' ? '根节点' : 'Root');
          rootMirrorEl.textContent = topic;
          rootMirrorEl.classList.remove('hidden');
        }
        function hideRootMirror() {
          if (!rootMirrorEl) return;
          rootMirrorEl.classList.add('hidden');
          rootMirrorEl.textContent = '';
        }

        function showMcpPersistNoticeDialog(titleText, message, requestId) {
          pendingMcpNoticeRequestId = requestId || null;
          appendLog('warn', (titleText || 'MCP') + ': ' + String(message || ''));
          const titleEl = document.getElementById('errorDialogTitle');
          if (titleEl) titleEl.textContent = titleText || 'MCP';
          if (errorDialogConfirmBtn) errorDialogConfirmBtn.textContent = t('dialogConfirm');
          if (errorDialogMsgEl) errorDialogMsgEl.textContent = message || '';
          if (errorDialogEl) errorDialogEl.classList.remove('hidden');
          if (errorDialogConfirmBtn) errorDialogConfirmBtn.focus();
        }

        // 主菜单下工具栏 + 右侧多个独立 Dock（格式 / 图标）
        const btnToggleDockFormat = document.getElementById('btnToggleDockFormat');
        const btnToggleDockIcon = document.getElementById('btnToggleDockIcon');
        const btnDockFormatCollapse = document.getElementById('btnDockFormatCollapse');
        const btnDockFormatMaximize = document.getElementById('btnDockFormatMaximize');
        const btnDockIconCollapse = document.getElementById('btnDockIconCollapse');
        const btnDockIconMaximize = document.getElementById('btnDockIconMaximize');
        const btnToggleDockJsmindTheme = document.getElementById('btnToggleDockJsmindTheme');
        const btnDockJsmindThemeCollapse = document.getElementById('btnDockJsmindThemeCollapse');
        const btnDockJsmindThemeMaximize = document.getElementById('btnDockJsmindThemeMaximize');

        if (btnToggleDockFormat) {
          btnToggleDockFormat.addEventListener('click', function () {
            applyFormatDockCollapsed(!formatDockCollapsed);
          });
        }
        if (btnToggleDockIcon) {
          btnToggleDockIcon.addEventListener('click', function () {
            applyIconDockCollapsed(!iconDockCollapsed);
          });
        }
        if (btnToggleDockJsmindTheme) {
          btnToggleDockJsmindTheme.addEventListener('click', function () {
            applyThemeDockCollapsed(!themeDockCollapsed);
          });
        }
        if (btnDockFormatCollapse) {
          btnDockFormatCollapse.addEventListener('click', function () {
            applyFormatDockCollapsed(true);
          });
        }
        if (btnDockIconCollapse) {
          btnDockIconCollapse.addEventListener('click', function () {
            applyIconDockCollapsed(true);
          });
        }
        if (btnDockJsmindThemeCollapse) {
          btnDockJsmindThemeCollapse.addEventListener('click', function () {
            applyThemeDockCollapsed(true);
          });
        }
        if (btnDockFormatMaximize) {
          btnDockFormatMaximize.addEventListener('click', function () {
            if (formatDockMaximized) {
              formatDockMaximized = false;
            } else {
              formatDockMaximized = true;
              iconDockMaximized = false;
              themeDockMaximized = false;
            }
            applyDockMaximizeUi();
            updateDockMaximizeButtons();
          });
        }
        if (btnDockIconMaximize) {
          btnDockIconMaximize.addEventListener('click', function () {
            if (iconDockMaximized) {
              iconDockMaximized = false;
            } else {
              iconDockMaximized = true;
              formatDockMaximized = false;
              themeDockMaximized = false;
            }
            applyDockMaximizeUi();
            updateDockMaximizeButtons();
          });
        }
        if (btnDockJsmindThemeMaximize) {
          btnDockJsmindThemeMaximize.addEventListener('click', function () {
            if (themeDockMaximized) {
              themeDockMaximized = false;
            } else {
              themeDockMaximized = true;
              formatDockMaximized = false;
              iconDockMaximized = false;
            }
            applyDockMaximizeUi();
            updateDockMaximizeButtons();
          });
        }

        applyHtoolbarLabels();
        applyFormatDockCollapsed(true);
        applyIconDockCollapsed(true);
        applyThemeDockCollapsed(true);
        if (errorDialogConfirmBtn) {
          errorDialogConfirmBtn.addEventListener('click', function () {
            if (pendingMcpNoticeRequestId) {
              const rid = pendingMcpNoticeRequestId;
              pendingMcpNoticeRequestId = null;
              vscode.postMessage({ type: 'mindmap:noticeAck', requestId: rid });
            }
            hideErrorDialog();
          });
        }

        function createBlankBootTree() {
          return {
            root: {
              id: 'root',
              topic: 'New Mindmap',
              children: []
            }
          };
        }

        function makeMindData(tree) {
          // jsMind expects a root node with children.
          function toJmNode(node) {
            const o = {
              id: node.id,
              topic: node.topic,
              children: (node.children || []).map(toJmNode)
            };
            if (node.data && typeof node.data === 'object' && Object.keys(node.data).length > 0) {
              try {
                o.data = JSON.parse(JSON.stringify(node.data));
              } catch (_) {}
            }
            return o;
          }
          return {
            meta: { name: 'mindmap', author: 'mcp', version: '1.0' },
            format: 'node_tree',
            data: toJmNode(tree.root)
          };
        }

        /**
         * jsMind 原 get_view_offset：水平居中 bounds、竖直加 size.h/2，避免对称布局里大量节点 y 为负时仍落在 SVG 可视区内。
         * 仅写 (-root.x,-root.y) 会丢掉上述平移，连线路径出现负 y 被 SVG 裁切（常见：上一半线消失）。
         * 这里保留与原版相同的居中量，再减去根的 get_node_point，等价于整图刚性平移，根锚点相对子树固定、展开折叠时不在内容里漂移。
         */
        function installMindmapRootAtContentOrigin() {
          if (!jm || !jm.view || !jm.layout) return;
          const view = jm.view;
          view.get_view_offset = function () {
            try {
              const root = this.jm.mind && this.jm.mind.root;
              if (!root) {
                return { x: 0, y: 0 };
              }
              const b = this.layout.bounds;
              const n = this.layout.get_node_point(root);
              const x0 = (this.size.w - b.e - b.w) / 2;
              const y0 = this.size.h / 2;
              return { x: x0 - n.x, y: y0 - n.y };
            } catch (_) {
              return { x: 0, y: 0 };
            }
          };
        }

        function resetMindInnerPanelScroll() {
          try {
            const p = jm && jm.view && jm.view.e_panel;
            if (!p) return;
            p.style.overflow = 'hidden';
            p.scrollLeft = 0;
            p.scrollTop = 0;
          } catch (_) {}
        }

        const INITIAL_LAYOUT_RETRY_DELAYS = [0, 40, 80];
        const FINAL_RENDER_CHECK_DELAY = 180;

        function hasRectOverlap(a, b) {
          return !(a.right < b.left || a.left > b.right || a.bottom < b.top || a.top > b.bottom);
        }

        // Render recovery pipeline:
        // 1) run short delayed attempts to align viewport with root (outer pan/zoom only; root stays at content origin)
        // 2) verify whether any node enters the viewport
        // 3) retry one more render pass, then fallback to text tree if still invisible
        function applyInitialViewportLayout() {
          INITIAL_LAYOUT_RETRY_DELAYS.forEach(function (delay) {
            setTimeout(function () {
              centerRoot();
            }, delay);
          });
        }

        function ensureRenderedOrFallback(tree, mindData) {
          setTimeout(function () {
            if (isRootNodePaintedInViewport()) {
              hideFallbackTree();
              hideRootMirror();
              setStatus(t('ready'));
              return;
            }
            // Last-resort fallback: re-show the same tree once more and force fit.
            try {
              installMindmapRootAtContentOrigin();
              jm.show(mindData, true);
              resetMindInnerPanelScroll();
              ensureVirtualCanvasSize();
              applyViewTransform();
              fitAll();
              if (!isRootNodePaintedInViewport()) {
                showFallbackTree(tree);
                showRootMirror(tree);
                setStatus(
                  currentLang === 'zh'
                    ? '主画布渲染失败，已切换降级视图。'
                    : 'Main canvas render failed; switched to fallback view.',
                  true
                );
              } else {
                hideFallbackTree();
                hideRootMirror();
                setStatus(t('ready'));
              }
            } catch (retryErr) {
              const em = retryErr && retryErr.message ? retryErr.message : String(retryErr);
              setStatus((currentLang === 'zh' ? '渲染重试失败：' : 'Render retry failed: ') + em, true);
            }
          }, FINAL_RENDER_CHECK_DELAY);
        }

        function init(tree, ext) {
          try {
            pendingMindPanelScrollFreeze = null;
            for (const n of lassoSelectedNodes) {
              try {
                n.classList.remove('lasso-selected');
                n.classList.remove('selected');
              } catch (_) {}
            }
            lassoSelectedNodes = [];
            selectedNode = null;
            try {
              if (jm && typeof jm.select_clear === 'function') {
                jm.select_clear();
              }
            } catch (_) {}
            jm = null;
            try {
              var jmShell = document.getElementById('jsmind_container');
              if (jmShell) clearDomChildren(jmShell);
            } catch (_) {}
          } catch (_) {}

          lastKnownMindmapTree = tree && tree.root ? tree : null;
          try {
            if (window.__MINDMAP_BROWSER_FILE_OPS__) {
              window.__mindmapBrowserDocExt = ext === 'jm' ? 'jm' : 'mmd';
            }
          } catch (_) {}
          try {
            suppressDirty = true;
            if (typeof jsMind === 'undefined') {
              throw new Error('jsMind runtime not loaded');
            }
            // Always reset view state on every (re)load to avoid inheriting stale pan/zoom.
            zoomScale = 1;
            panX = 0;
            panY = 0;
            lastCanvasWrapObservedSize = { w: 0, h: 0 };
            try {
              if (
                tree &&
                tree.root &&
                window.MindmapCore &&
                typeof window.MindmapCore.normalizeCoreMindmapTreeIds === 'function'
              ) {
                window.MindmapCore.normalizeCoreMindmapTreeIds(tree);
              }
            } catch (_) {}
            const mindData = makeMindData(tree);
            rootId = tree && tree.root ? tree.root.id : null;
            // 统一采用“xmind 风格”的菜单逻辑：仅标题编辑 + 视图操作。
            const viewOnlyMode = true;
            setStatus(t('ready'));

            // 仅支持标题编辑；隐藏结构修改按钮。
            const structuralBtnIds = ['btnAdd', 'btnDelete', 'btnMoveFirst', 'btnMoveLast'];
            for (const id of structuralBtnIds) {
              const btn = document.getElementById(id);
              if (!btn) continue;
              btn.disabled = viewOnlyMode;
              btn.style.display = viewOnlyMode ? 'none' : '';
            }

            const options = {
              // Keep UI in xmind-style, but allow programmatic structure changes
              // (context menu / keyboard shortcuts).
              editable: true,
              theme: currentTheme,
              mode: 'full',
              container: 'jsmind_container'
            };
            jm = new jsMind(options);
            installMindmapRootAtContentOrigin();
            jm.show(mindData, true);
            resetMindInnerPanelScroll();
            hideFallbackTree();
            hideRootMirror();
            ensureVirtualCanvasSize();
            applyViewTransform();
            // jsMind render/layout may settle asynchronously in webview.
            // Retry centering a few ticks later to avoid initial "empty canvas" view.
            applyInitialViewportLayout();
            ensureRenderedOrFallback(tree, mindData);
            if (canvasWrapEl) {
              canvasWrapEl.focus();
            }

            // jsMind：add_event_listener 只接收 (type, data) 单一回调；event_type 见 jsMind.event_type
            jm.add_event_listener(function (type, data) {
              try {
                const ET =
                  typeof jsMind !== 'undefined' && jsMind.event_type
                    ? jsMind.event_type
                    : { show: 1, resize: 2, edit: 3, select: 4 };
                if (type === ET.select && data && data.evt === 'select_node') {
                  const nid = data.node;
                  selectedNode = nid && jm.get_node ? jm.get_node(nid) : null;
                  if (canvasWrapEl) {
                    canvasWrapEl.focus();
                  }
                  setSingleSelectStatus(selectedNode);
                  refreshDockFromSelection();
                  requestAnimationFrame(function () {
                    refreshDockFromSelection();
                  });
                  return;
                }
                if (type === ET.show) {
                  requestAnimationFrame(function () {
                    applyAllMindNodeVisuals();
                    refreshDockFromSelection();
                    requestAnimationFrame(function () {
                      relayoutMindAfterVisuals();
                    });
                  });
                  return;
                }
                if (type === ET.edit && data) {
                  const evt = data.evt;
                  if (evt === 'update_node' && data.node && jm.get_node) {
                    markContentDirty();
                    const n = jm.get_node(data.node);
                    if (n) {
                      requestAnimationFrame(function () {
                        applyMindNodeVisual(n);
                        refreshDockFromSelection();
                        requestAnimationFrame(function () {
                          relayoutMindAfterVisuals();
                        });
                      });
                    }
                  } else if (
                    evt === 'add_node' ||
                    evt === 'add_nodes' ||
                    evt === 'remove_node' ||
                    evt === 'insert_node_before' ||
                    evt === 'insert_node_after'
                  ) {
                    requestAnimationFrame(function () {
                      applyAllMindNodeVisuals();
                      requestAnimationFrame(function () {
                        relayoutMindAfterVisuals();
                      });
                    });
                  }
                  if (evt === 'move_node') {
                    markContentDirty();
                    selectedNode = null;
                    setStatus(t('ready'));
                    requestAnimationFrame(function () {
                      applyAllMindNodeVisuals();
                      requestAnimationFrame(function () {
                        relayoutMindAfterVisuals();
                      });
                    });
                  }
                }
              } catch (_) {}
            });

            initDockFormatAndIcon();
            requestAnimationFrame(function () {
              applyAllMindNodeVisuals();
              refreshDockFromSelection();
              requestAnimationFrame(function () {
                relayoutMindAfterVisuals();
              });
            });

            suppressDirty = false;
            setContentClean();
            vscode.postMessage({ type: 'mindmap:ready' });
          } catch (initErr) {
            const em = initErr && initErr.message ? initErr.message : String(initErr);
            setStatus('Init failed: ' + em, true);
            showRootMirror(tree);
            showFallbackTree(tree);
          }
        }

        function getTreeFromMind() {
          function normalize(node) {
            if (!node) {
              return { id: 'root', topic: 'Root', children: [] };
            }
            const o = {
              id: node.id || allocateNextNodeId(),
              topic: String(node.topic != null ? node.topic : ''),
              children: (node.children || []).map(normalize)
            };
            if (node.data && typeof node.data === 'object') {
              try {
                o.data = JSON.parse(JSON.stringify(node.data));
              } catch (_) {}
            }
            return o;
          }

          // Compatibility-first:
          // 1) use runtime model root if available (works on jsMind variants without get_json)
          // 2) fallback to get_data('node_tree')
          // 3) fallback to legacy get_json()
          if (jm && typeof jm.get_root === 'function') {
            const root = jm.get_root();
            if (root) return { root: normalize(root) };
          }

          if (jm && typeof jm.get_data === 'function') {
            const data = jm.get_data('node_tree');
            if (data && data.data) return { root: normalize(data.data) };
          }

          if (jm && typeof jm.get_json === 'function') {
            const json = jm.get_json();
            if (json && json.data) return { root: normalize(json.data) };
          }

          throw new Error('Unable to export mindmap tree from current jsMind instance.');
        }

        /** 保存、另存为、快捷键存盘：优先从 jsMind 导出，否则使用最近一次注入的树。 */
        function getTreeForFileOps() {
          if (jm) {
            return getTreeFromMind();
          }
          if (lastKnownMindmapTree && lastKnownMindmapTree.root) {
            return lastKnownMindmapTree;
          }
          throw new Error(
            currentLang === 'zh'
              ? '画布未就绪，无法导出脑图数据。'
              : 'Canvas not ready; cannot export mindmap data.'
          );
        }

        function getActiveSelectedNode() {
          if (selectedNode) return selectedNode;
          if (jm && jm.get_selected_node) {
            const n = jm.get_selected_node();
            if (n) {
              selectedNode = n;
              return n;
            }
          }
          return null;
        }

        /**
         * 格式 / 图标 Dock 的「当前节点」：仅在有**唯一**画布选中目标时有效。
         * 多选（框选/Ctrl 多选 ≥2）时不应用单一节点属性，图标高亮全部清除。
         */
        function getDockTargetNode() {
          if (lassoSelectedNodes && lassoSelectedNodes.length > 1) {
            return null;
          }
          return getActiveSelectedNode();
        }

        const MM_EMBED_CLASS_PREFIX = 'mm-embed-';
        const MM_EMBED_KINDS = ['image', 'text', 'whiteboard', 'video', 'audio', 'gltf', 'table'];

        function stripMmEmbedClasses(el) {
          if (!el || !el.classList) return;
          const toRemove = [];
          for (let i = 0; i < el.classList.length; i++) {
            const c = el.classList[i];
            if (c && c.indexOf(MM_EMBED_CLASS_PREFIX) === 0) {
              toRemove.push(c);
            }
          }
          for (let j = 0; j < toRemove.length; j++) {
            el.classList.remove(toRemove[j]);
          }
        }

        const MM_ICON_CLASS_PREFIX = 'mm-icon-';
        const MM_ICON_IDS = [
          'none',
          'star',
          'flag',
          'bulb',
          'book',
          'check',
          'warn',
          'heart',
          'rocket',
          'pin'
        ];

        function stripMmIconClasses(el) {
          if (!el || !el.classList) return;
          const toRemove = [];
          for (let i = 0; i < el.classList.length; i++) {
            const c = el.classList[i];
            if (c && c.indexOf(MM_ICON_CLASS_PREFIX) === 0) {
              toRemove.push(c);
            }
          }
          for (let j = 0; j < toRemove.length; j++) {
            el.classList.remove(toRemove[j]);
          }
        }

        function applyMindNodeVisual(node) {
          if (!node || !node._data || !node._data.view || !node._data.view.element) {
            return;
          }
          const el = node._data.view.element;
          const d = node.data && typeof node.data === 'object' ? node.data : {};
          stripMmEmbedClasses(el);
          stripMmIconClasses(el);
          const emb = d.mmEmbed;
          if (emb && emb.type) {
            const tk = String(emb.type).replace(/[^a-z0-9_-]/gi, '');
            if (tk && MM_EMBED_KINDS.indexOf(tk) >= 0) {
              el.classList.add(MM_EMBED_CLASS_PREFIX + tk);
            }
          }
          const iconRaw = d.mmIcon;
          if (!(emb && emb.type)) {
            if (iconRaw === 'none') {
              el.classList.add(MM_ICON_CLASS_PREFIX + 'none');
            } else if (iconRaw && MM_ICON_IDS.indexOf(String(iconRaw)) >= 1) {
              el.classList.add(MM_ICON_CLASS_PREFIX + String(iconRaw));
            }
          }
          if (d.mmFont) {
            el.style.fontFamily = String(d.mmFont);
          } else {
            el.style.removeProperty('font-family');
          }
          if (d.mmFontSize != null && d.mmFontSize !== '') {
            const sz = parseInt(String(d.mmFontSize), 10);
            if (!isNaN(sz) && sz > 0) {
              el.style.fontSize = sz + 'px';
            } else {
              el.style.removeProperty('font-size');
            }
          } else {
            el.style.removeProperty('font-size');
          }
          if (d.mmColor) {
            el.style.color = String(d.mmColor);
          } else {
            el.style.removeProperty('color');
          }
          if (d.mmBg) {
            el.style.backgroundColor = String(d.mmBg);
          } else {
            el.style.removeProperty('background-color');
          }
        }

        function applyAllMindNodeVisuals() {
          if (!jm || !jm.mind || !jm.mind.nodes) return;
          const map = jm.mind.nodes;
          for (const k in map) {
            if (!Object.prototype.hasOwnProperty.call(map, k)) continue;
            applyMindNodeVisual(map[k]);
          }
        }

        /**
         * 从 DOM 回写 jsMind 内部记录的节点宽高（与 init_nodes_size / update_node 一致）。
         * 仅 view.relayout() 不会执行 layout.layout()，根节点尺寸仍按旧值算一级子节点 offset，故一级分支易错位。
         */
        function syncMindNodeSizesFromDom() {
          if (!jm || !jm.mind || !jm.mind.nodes) return;
          const map = jm.mind.nodes;
          for (const k in map) {
            if (!Object.prototype.hasOwnProperty.call(map, k)) continue;
            const node = map[k];
            const v = node._data && node._data.view;
            const el = v && v.element;
            if (!el) continue;
            try {
              if (jm.layout && typeof jm.layout.is_visible === 'function' && !jm.layout.is_visible(node)) {
                continue;
              }
              v.width = el.clientWidth;
              v.height = el.clientHeight;
            } catch (_) {}
          }
        }

        /** 视觉样式改变盒尺寸后：先同步 DOM 尺寸，再 layout.layout()，最后 expand + 重绘连线。 */
        function relayoutMindAfterVisuals() {
          if (!jm || !jm.view || !jm.layout) return;
          try {
            syncMindNodeSizesFromDom();
            jm.layout.layout();
            if (typeof jm.view.relayout === 'function') {
              jm.view.relayout();
            } else {
              jm.view.expand_size();
              var vw = jm.view;
              var showFn = vw['_show'];
              if (typeof showFn === 'function') {
                showFn.call(vw);
              }
            }
          } catch (_) {}
        }

        function populateDockFontSelect() {
          const sel = document.getElementById('dockInputFont');
          if (!sel) return;
          const cur = sel.value;
          const fonts = [
            { value: '', label: t('dockFontDefault') },
            { value: 'system-ui, -apple-system, Segoe UI, sans-serif', label: 'System UI' },
            { value: 'Arial, Helvetica, sans-serif', label: 'Arial' },
            { value: 'Verdana, Geneva, sans-serif', label: 'Verdana' },
            { value: 'Georgia, serif', label: 'Georgia' },
            { value: '"Times New Roman", Times, serif', label: 'Times New Roman' },
            { value: '"Courier New", Courier, monospace', label: 'Courier New' },
            { value: '"Microsoft YaHei", "微软雅黑", sans-serif', label: 'Microsoft YaHei' },
            { value: 'SimSun, "宋体", serif', label: 'SimSun' },
            { value: '"Segoe UI", Roboto, sans-serif', label: 'Segoe UI / Roboto' }
          ];
          clearDomChildren(sel);
          for (let i = 0; i < fonts.length; i++) {
            const opt = document.createElement('option');
            opt.value = fonts[i].value;
            opt.textContent = fonts[i].label;
            sel.appendChild(opt);
          }
          if (cur) sel.value = cur;
        }

        function buildDockIconGrid() {
          const grid = document.getElementById('dockIconGrid');
          if (!grid) return;
          clearDomChildren(grid);
          const defs = [
            { id: 'none', emoji: '∅', labelKey: 'dockIconNone' },
            { id: 'star', emoji: '⭐', labelKey: 'dockIconStar' },
            { id: 'flag', emoji: '🚩', labelKey: 'dockIconFlag' },
            { id: 'bulb', emoji: '💡', labelKey: 'dockIconBulb' },
            { id: 'book', emoji: '📖', labelKey: 'dockIconBook' },
            { id: 'check', emoji: '✅', labelKey: 'dockIconCheck' },
            { id: 'warn', emoji: '⚠️', labelKey: 'dockIconWarn' },
            { id: 'heart', emoji: '❤️', labelKey: 'dockIconHeart' },
            { id: 'rocket', emoji: '🚀', labelKey: 'dockIconRocket' },
            { id: 'pin', emoji: '📌', labelKey: 'dockIconPin' }
          ];
          for (let di = 0; di < defs.length; di++) {
            const def = defs[di];
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'dock-icon-btn';
            btn.setAttribute('data-mm-icon', def.id);
            safeSetInnerHTML(
              btn,
              '<span>' +
                escapeHtml(def.emoji) +
                '</span><span class="dock-icon-label">' +
                escapeHtml(t(def.labelKey)) +
                '</span>'
            );
            (function (iconId) {
              btn.addEventListener('click', function () {
                applyIconToSelection(iconId);
              });
            })(def.id);
            grid.appendChild(btn);
          }
        }

        function jsmindThemeLabel(name) {
          const s = String(name || '');
          if (!s.length) return s;
          return s.charAt(0).toUpperCase() + s.slice(1);
        }

        function refreshJsmindThemeDockHighlight() {
          const grid = document.getElementById('dockJsmindThemeGrid');
          if (!grid) return;
          const btns = grid.querySelectorAll('.dock-jsmind-theme-btn[data-mm-jsmind-theme]');
          for (let i = 0; i < btns.length; i++) {
            const b = btns[i];
            const tn = b.getAttribute('data-mm-jsmind-theme') || '';
            b.classList.toggle('mm-selected', tn === currentTheme);
          }
        }

        function buildDockJsmindThemeGrid() {
          const grid = document.getElementById('dockJsmindThemeGrid');
          if (!grid) return;
          clearDomChildren(grid);
          for (let ti = 0; ti < supportedThemes.length; ti++) {
            const themeName = supportedThemes[ti];
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'dock-jsmind-theme-btn';
            btn.setAttribute('data-mm-jsmind-theme', themeName);
            const labelText = jsmindThemeLabel(themeName);
            btn.setAttribute('title', labelText);
            btn.setAttribute('aria-label', labelText);

            const wrap = document.createElement('span');
            wrap.className = 'dock-jsmind-theme-preview-wrap';
            const jmnodesEl = document.createElement('jmnodes');
            jmnodesEl.className = 'dock-jsmind-theme-jmnodes';
            if (themeName && themeName !== 'default') {
              jmnodesEl.classList.add('theme-' + themeName);
            }
            const jmnodeEl = document.createElement('jmnode');
            jmnodeEl.className = 'dock-jsmind-theme-preview-node';
            jmnodeEl.textContent = 'Aa';
            jmnodesEl.appendChild(jmnodeEl);
            wrap.appendChild(jmnodesEl);

            const lab = document.createElement('span');
            lab.className = 'dock-jsmind-theme-label';
            lab.textContent = labelText;

            btn.appendChild(wrap);
            btn.appendChild(lab);

            (function (tn) {
              btn.addEventListener('click', function () {
                applyTheme(tn);
              });
            })(themeName);
            grid.appendChild(btn);
          }
          refreshJsmindThemeDockHighlight();
        }

        /** 将 rgb/rgba/#rgb/#rrggbb 转为 #rrggbb，供 color 输入框使用；全透明 rgba 返回空串 */
        function parseCssColorToHex(input) {
          if (input == null || typeof input !== 'string') return '';
          const s = String(input).trim();
          if (/^#[0-9a-fA-F]{6}$/.test(s)) return s.toLowerCase();
          if (/^#[0-9a-fA-F]{3}$/.test(s)) {
            const r = s[1];
            const g = s[2];
            const b = s[3];
            return ('#' + r + r + g + g + b + b).toLowerCase();
          }
          const m = s.match(
            /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)/
          );
          if (m) {
            const alpha = m[4] !== undefined && m[4] !== '' ? parseFloat(m[4]) : 1;
            if (!isNaN(alpha) && alpha < 0.02) return '';
            const r = parseInt(m[1], 10);
            const g = parseInt(m[2], 10);
            const b = parseInt(m[3], 10);
            return (
              '#' +
              [r, g, b]
                .map(function (x) {
                  const v = Math.max(0, Math.min(255, x));
                  const h = v.toString(16);
                  return h.length === 1 ? '0' + h : h;
                })
                .join('')
            );
          }
          return '';
        }

        function getMindNodeViewElement(node) {
          return node && node._data && node._data.view && node._data.view.element
            ? node._data.view.element
            : null;
        }

        /**
         * 读取画布 jmnode 的「默认」外观（主题 + 内联），不包含选中高亮：jsMind 对选中节点加
         * .selected，会覆盖 color/background；同步到格式 Dock 时应临时去掉该类再取计算样式。
         */
        function readMindNodeDefaultAppearanceFromDom(el) {
          if (!el) return null;
          const hadSelected = el.classList && el.classList.contains('selected');
          if (hadSelected) el.classList.remove('selected');
          try {
            const cs = window.getComputedStyle(el);
            return {
              fontSize: cs.fontSize,
              color: el.style && el.style.color ? el.style.color : cs.color,
              backgroundColor:
                el.style && el.style.backgroundColor ? el.style.backgroundColor : cs.backgroundColor
            };
          } finally {
            if (hadSelected) el.classList.add('selected');
          }
        }

        /**
         * 格式 Dock 显示值：优先 node.data（mmFontSize/mmColor/mmBg）；否则从画布节点读取
         * 「非高亮」下的主题默认/内联样式。
         */
        function snapshotDockFormatFromNode(node) {
          const d = node && node.data && typeof node.data === 'object' ? node.data : {};
          const el = getMindNodeViewElement(node);
          const domDefault = el ? readMindNodeDefaultAppearanceFromDom(el) : null;
          let fontSizeStr = '';
          if (d.mmFontSize != null && String(d.mmFontSize).trim() !== '') {
            fontSizeStr = String(d.mmFontSize).trim();
          } else if (domDefault && domDefault.fontSize && domDefault.fontSize.indexOf('px') > 0) {
            const n = parseFloat(domDefault.fontSize);
            if (!isNaN(n) && n > 0) fontSizeStr = String(Math.round(n));
          }
          let colorHex = '#333333';
          if (d.mmColor != null && String(d.mmColor).trim() !== '') {
            const h = parseCssColorToHex(String(d.mmColor).trim());
            if (h) colorHex = h;
            else if (domDefault && domDefault.color) {
              const h2 = parseCssColorToHex(domDefault.color);
              if (h2) colorHex = h2;
            }
          } else if (domDefault && domDefault.color) {
            const h = parseCssColorToHex(domDefault.color);
            if (h) colorHex = h;
          }
          let bgHex = '#ffffff';
          if (d.mmBg != null && String(d.mmBg).trim() !== '') {
            const h = parseCssColorToHex(String(d.mmBg).trim());
            if (h) bgHex = h;
            else if (domDefault && domDefault.backgroundColor) {
              const h2 = parseCssColorToHex(domDefault.backgroundColor);
              if (h2) bgHex = h2;
            }
          } else if (domDefault && domDefault.backgroundColor) {
            const h = parseCssColorToHex(domDefault.backgroundColor);
            if (h) bgHex = h;
          }
          return { fontSizeStr: fontSizeStr, colorHex: colorHex, bgHex: bgHex };
        }

        function setDockFormatFieldsDisabled(disabled) {
          const ids = [
            'dockInputTopic',
            'dockInputFont',
            'dockInputFontSize',
            'dockInputColor',
            'dockInputBg',
            'dockBtnResetFormat'
          ];
          for (let i = 0; i < ids.length; i++) {
            const el = document.getElementById(ids[i]);
            if (el) el.disabled = !!disabled;
          }
        }

        function refreshDockFromSelection() {
          const node = getDockTargetNode();
          const form = document.getElementById('dockFormatForm');
          const hint = document.getElementById('dockFormatHint');
          const ih = document.getElementById('dockIconHint');
          if (form) {
            form.classList.toggle('dock-disabled', !node);
          }
          setDockFormatFieldsDisabled(!node);
          if (hint) {
            hint.textContent = t('dockHintNoSelection');
            hint.style.display = node ? 'none' : '';
          }
          if (ih) {
            ih.textContent = node ? String(node.topic || node.id || '') : t('dockHintIconNoSelection');
          }
          const d = node && node.data && typeof node.data === 'object' ? node.data : {};
          dockFormatRefreshing = true;
          try {
            const idEl = document.getElementById('dockInputNodeId');
            const topicEl = document.getElementById('dockInputTopic');
            if (idEl) {
              idEl.value = node ? String(node.id || '') : '';
            }
            if (topicEl) {
              topicEl.value = node ? String(node.topic != null ? node.topic : '') : '';
            }
            const fontEl = document.getElementById('dockInputFont');
            if (fontEl) {
              if (!node) {
                fontEl.value = '';
              } else {
                const fv = d.mmFont != null ? String(d.mmFont) : '';
                fontEl.value = fv;
                if (fv && fontEl.value !== fv) {
                  const opt = document.createElement('option');
                  opt.value = fv;
                  opt.textContent = fv.length > 40 ? fv.slice(0, 38) + '…' : fv;
                  fontEl.appendChild(opt);
                  fontEl.value = fv;
                }
              }
            }
            const snap = node ? snapshotDockFormatFromNode(node) : null;
            const sizeEl = document.getElementById('dockInputFontSize');
            if (sizeEl) {
              sizeEl.value = snap ? snap.fontSizeStr : '';
            }
            const cEl = document.getElementById('dockInputColor');
            if (cEl) {
              cEl.value = snap ? snap.colorHex : '#ffffff';
            }
            const bgEl = document.getElementById('dockInputBg');
            if (bgEl) {
              bgEl.value = snap ? snap.bgHex : '#ffffff';
            }
          } finally {
            dockFormatRefreshing = false;
          }
          const grid = document.getElementById('dockIconGrid');
          if (grid) {
            grid.style.pointerEvents = node ? '' : 'none';
            let dockIconSel = '';
            if (node) {
              const raw = d.mmIcon;
              const t = raw === undefined || raw === null ? '' : String(raw).trim();
              if (!t || t === 'none' || MM_ICON_IDS.indexOf(t) < 1) {
                dockIconSel = 'none';
              } else {
                dockIconSel = t;
              }
            }
            const btns = grid.querySelectorAll('.dock-icon-btn');
            for (let i = 0; i < btns.length; i++) {
              const b = btns[i];
              const id = b.getAttribute('data-mm-icon') || '';
              b.classList.toggle('mm-selected', !!node && id === dockIconSel);
            }
          }
        }

        function commitTopicFromDock() {
          if (dockFormatRefreshing) return;
          const node = getDockTargetNode();
          if (!node || !jm) return;
          const topicEl = document.getElementById('dockInputTopic');
          if (!topicEl) return;
          const topic = String(topicEl.value != null ? topicEl.value : '');
          try {
            jm.update_node(node.id, topic);
          } catch (_) {
            return;
          }
          markContentDirty();
          const ih = document.getElementById('dockIconHint');
          if (ih && node) {
            ih.textContent = String(node.topic != null ? node.topic : node.id || '');
          }
        }

        function commitFormatDock() {
          if (dockFormatRefreshing) return;
          const node = getDockTargetNode();
          if (!node || !jm) return;
          if (!node.data || typeof node.data !== 'object') {
            node.data = {};
          }
          const fontEl = document.getElementById('dockInputFont');
          const sizeEl = document.getElementById('dockInputFontSize');
          const cEl = document.getElementById('dockInputColor');
          const bgEl = document.getElementById('dockInputBg');
          const fv = fontEl && fontEl.value ? String(fontEl.value) : '';
          if (fv) node.data.mmFont = fv;
          else delete node.data.mmFont;
          const sv = sizeEl && String(sizeEl.value).trim();
          if (sv) {
            const n = parseInt(sv, 10);
            if (!isNaN(n) && n > 0) node.data.mmFontSize = n;
            else delete node.data.mmFontSize;
          } else {
            delete node.data.mmFontSize;
          }
          if (cEl && cEl.value) {
            node.data.mmColor = String(cEl.value);
          } else {
            delete node.data.mmColor;
          }
          if (bgEl && bgEl.value) {
            node.data.mmBg = String(bgEl.value);
          } else {
            delete node.data.mmBg;
          }
          try {
            if (jm.view && typeof jm.view.update_node === 'function') {
              jm.view.update_node(node);
            }
          } catch (_) {}
          requestAnimationFrame(function () {
            applyMindNodeVisual(node);
          });
          markContentDirty();
        }

        function resetFormatDock() {
          const node = getDockTargetNode();
          if (!node || !node.data) return;
          delete node.data.mmFont;
          delete node.data.mmFontSize;
          delete node.data.mmColor;
          delete node.data.mmBg;
          const keys = Object.keys(node.data);
          if (keys.length === 0) {
            node.data = {};
          }
          try {
            if (jm.view && typeof jm.view.update_node === 'function') {
              jm.view.update_node(node);
            }
          } catch (_) {}
          requestAnimationFrame(function () {
            applyMindNodeVisual(node);
          });
          markContentDirty();
          refreshDockFromSelection();
        }

        function applyIconToSelection(iconId) {
          const node = getDockTargetNode();
          if (!node || !jm) return;
          if (!node.data || typeof node.data !== 'object') {
            node.data = {};
          }
          if (iconId === 'none') {
            node.data.mmIcon = 'none';
          } else if (MM_ICON_IDS.indexOf(iconId) >= 1) {
            node.data.mmIcon = iconId;
          } else {
            delete node.data.mmIcon;
          }
          try {
            if (jm.view && typeof jm.view.update_node === 'function') {
              jm.view.update_node(node);
            }
          } catch (_) {}
          requestAnimationFrame(function () {
            applyMindNodeVisual(node);
          });
          markContentDirty();
          refreshDockFromSelection();
        }

        function initDockFormatAndIcon() {
          if (dockFormatIconInited) return;
          dockFormatIconInited = true;
          populateDockFontSelect();
          buildDockIconGrid();
          const topicEl = document.getElementById('dockInputTopic');
          if (topicEl) {
            topicEl.addEventListener('input', function () {
              commitTopicFromDock();
            });
            topicEl.addEventListener('paste', function (e) {
              const text = e.clipboardData ? e.clipboardData.getData('text/plain') || '' : '';
              if (!parseMindClipboardText(text)) {
                return;
              }
              e.preventDefault();
              e.stopPropagation();
              const parent = getActiveSelectedNode() || (jm && jm.get_root ? jm.get_root() : null);
              if (!parent) {
                return;
              }
              if (!tryPasteMindFromText(text, parent)) {
                notifyInvalidAction(t('alertPasteFailed'));
              }
            });
          }
          const fontEl = document.getElementById('dockInputFont');
          if (fontEl) {
            fontEl.addEventListener('change', function () {
              commitFormatDock();
            });
          }
          const sizeEl = document.getElementById('dockInputFontSize');
          if (sizeEl) {
            sizeEl.addEventListener('input', function () {
              commitFormatDock();
            });
            sizeEl.addEventListener('change', function () {
              commitFormatDock();
            });
          }
          const cEl = document.getElementById('dockInputColor');
          if (cEl) {
            cEl.addEventListener('input', function () {
              commitFormatDock();
            });
            cEl.addEventListener('change', function () {
              commitFormatDock();
            });
          }
          const bgEl = document.getElementById('dockInputBg');
          if (bgEl) {
            bgEl.addEventListener('input', function () {
              commitFormatDock();
            });
            bgEl.addEventListener('change', function () {
              commitFormatDock();
            });
          }
          const resetBtn = document.getElementById('dockBtnResetFormat');
          if (resetBtn) {
            resetBtn.addEventListener('click', function () {
              resetFormatDock();
            });
          }
        }

        /** 旧版剪贴板前缀（仍可从历史剪贴板解析）；新复制为纯 JSON，便于阅读且不会把标记误粘进节点文本 */
        const MIND_CLIP_MARKER = '##MINDMAP_SUBTREE##';

        function jmDirectionFromSerialized(dir) {
          if (typeof jsMind === 'undefined' || !jsMind.direction) {
            return undefined;
          }
          if (dir === 'left') {
            return jsMind.direction.left;
          }
          if (dir === 'right') {
            return jsMind.direction.right;
          }
          return undefined;
        }

        function serializeMindSubtreeNode(node) {
          if (!node) {
            return null;
          }
          const o = { topic: String(node.topic || '') };
          if (node.expanded === false) {
            o.expanded = false;
          }
          if (node.data && typeof node.data === 'object') {
            const keys = Object.keys(node.data);
            if (keys.length) {
              try {
                o.data = JSON.parse(JSON.stringify(node.data));
              } catch (_) {}
            }
          }
          if (node.parent && node.parent.isroot && typeof jsMind !== 'undefined' && jsMind.direction) {
            if (node.direction === jsMind.direction.left) {
              o.direction = 'left';
            } else if (node.direction === jsMind.direction.right) {
              o.direction = 'right';
            }
          }
          const ch = node.children || [];
          if (ch.length) {
            o.children = ch.map(serializeMindSubtreeNode).filter(Boolean);
          }
          return o;
        }

        function buildMindClipboardPayload(node) {
          const root = serializeMindSubtreeNode(node);
          return JSON.stringify({ root: root }, null, 2);
        }

        function parseMindClipboardPayloadObject(obj) {
          if (!obj || typeof obj !== 'object') {
            return null;
          }
          if (obj.root != null && typeof obj.root === 'object' && obj.root.topic !== undefined) {
            return obj.root;
          }
          if (obj.topic !== undefined) {
            return obj;
          }
          return null;
        }

        function parseMindClipboardText(text) {
          const trimmed = (text || '').toString().trim();
          if (!trimmed) {
            return null;
          }
          if (trimmed.startsWith(MIND_CLIP_MARKER)) {
            let rest = trimmed.slice(MIND_CLIP_MARKER.length);
            if (rest.charAt(0) === '\n') {
              rest = rest.slice(1);
            } else if (rest.startsWith('\\n')) {
              rest = rest.slice(2);
            }
            rest = rest.trim();
            try {
              const json = JSON.parse(rest);
              return parseMindClipboardPayloadObject(json);
            } catch (_) {
              return null;
            }
          }
          try {
            const json = JSON.parse(trimmed);
            return parseMindClipboardPayloadObject(json);
          } catch (_) {
            return null;
          }
        }

        /** @returns {string|null} 本层新建节点 id；失败为 null */
        function pasteMindDataUnder(parentModelNode, data) {
          if (!jm || !parentModelNode || !data || data.topic === undefined) {
            return null;
          }
          const newId = allocateNextNodeId();
          const dir = jmDirectionFromSerialized(data.direction);
          const added = jm.add_node(parentModelNode, newId, String(data.topic || ''), data.data || null, dir);
          if (!added) {
            return null;
          }
          if (data.expanded === false && typeof jm.collapse_node === 'function') {
            try {
              jm.collapse_node(added);
            } catch (_) {}
          }
          const kids = data.children || [];
          for (let i = 0; i < kids.length; i++) {
            pasteMindDataUnder(added, kids[i]);
          }
          return newId;
        }

        function writeMindClipboardFromNode(node) {
          const payload = buildMindClipboardPayload(node);
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(payload).catch(function () {});
          }
        }

        function copyMindNodeSelection() {
          if (!jm) {
            return;
          }
          const node = getActiveSelectedNode();
          if (!node) {
            notifyInvalidAction(t('alertNoSelectCopy'));
            return;
          }
          writeMindClipboardFromNode(node);
          setStatus(currentLang === 'zh' ? '已复制节点（含子树）' : 'Copied node subtree');
        }

        function cutMindNodeSelection() {
          if (!jm) {
            return;
          }
          const node = getActiveSelectedNode();
          if (!node) {
            notifyInvalidAction(t('alertNoSelectCut'));
            return;
          }
          if (rootId && String(node.id) === String(rootId)) {
            notifyInvalidAction(t('alertRootNoCut'));
            return;
          }
          writeMindClipboardFromNode(node);
          jm.remove_node(node);
          markContentDirty();
          selectedNode = null;
          setStatus(currentLang === 'zh' ? '已剪切节点' : 'Cut node');
        }

        function tryPasteMindFromText(text, parentModelNode) {
          const rootData = parseMindClipboardText(text);
          if (!rootData) {
            return false;
          }
          if (!jm || !parentModelNode) {
            return false;
          }
          const pastedTopId = pasteMindDataUnder(parentModelNode, rootData);
          if (!pastedTopId) {
            notifyInvalidAction(t('alertPasteFailed'));
            return true;
          }
          markContentDirty();
          selectNodeById(pastedTopId);
          ensureMindNodeInCanvasView(pastedTopId);
          setStatus(currentLang === 'zh' ? '已粘贴' : 'Pasted');
          return true;
        }

        function pasteMindFromReadText(parentModelNode) {
          if (!jm || !parentModelNode) {
            return;
          }
          if (navigator.clipboard && navigator.clipboard.readText) {
            navigator.clipboard
              .readText()
              .then(function (txt) {
                if (!tryPasteMindFromText(txt, parentModelNode)) {
                  notifyInvalidAction(t('alertPasteNoData'));
                }
              })
              .catch(function () {
                notifyInvalidAction(t('alertPasteNoData'));
              });
          } else {
            notifyInvalidAction(t('alertPasteNoData'));
          }
        }

        function notifyInvalidAction(message) {
          if (invalidActionKeyboardContext) {
            setStatus(String(message == null ? '' : message), true);
            return;
          }
          if (statusbarTextEl) statusbarTextEl.textContent = message;
          if (statusbarEl) statusbarEl.classList.add('error');
          showErrorDialog(message);
        }

        // View transform: middle-button pan + wheel zoom.
        const canvasWrapEl = document.getElementById('canvasWrap');
        const gridLayerEl = document.getElementById('gridLayer');
        const jsmindContainerEl = document.getElementById('jsmind_container');
        let zoomScale = 1;
        let panX = 0;
        let panY = 0;
        /** 与 ResizeObserver 配合：记录画布客户区尺寸，仅在「仅尺寸变化」时补偿平移以保持视口中心下的内容不动（全屏/窗口缩放等）。 */
        let lastCanvasWrapObservedSize = { w: 0, h: 0 };
        let isMiddleDragging = false;
        let dragStartX = 0;
        let dragStartY = 0;
        let middleDragPointerId = null;
        let isLassoSelecting = false;
        let lassoStartX = 0;
        let lassoStartY = 0;
        let selectionBoxEl = null;
        /** 框选开始时 setPointerCapture，避免在 webview 外松开鼠标收不到 mouseup */
        let lassoPointerId = null;
        let lassoSelectedNodes = [];
        /** 点击展开钮：暂存 inner 滚动 + 视口锚点，用于折叠后还原滚动并补偿外层平移。 */
        let pendingMindPanelScrollFreeze = null;

        function clearLassoMarks() {
          for (const n of lassoSelectedNodes) {
            try {
              n.classList.remove('lasso-selected');
              n.classList.remove('selected');
            } catch (_) {}
          }
          lassoSelectedNodes = [];
          // Restore current true single selection, if any.
          try {
            const cur = jm && jm.get_selected_node ? jm.get_selected_node() : null;
            const el = cur && cur._data && cur._data.view && cur._data.view.element;
            if (el && el.classList) el.classList.add('selected');
          } catch (_) {}
        }

        /** 清除 jsMind 单节点选中（与空白处左键/框选 0 命中一致） */
        function clearMindmapSingleSelection() {
          if (!jm) return;
          try {
            if (typeof jm.select_clear === 'function') {
              jm.select_clear();
            } else if (typeof jm.select_node === 'function') {
              jm.select_node(null);
            }
          } catch (_) {}
          selectedNode = null;
          refreshDockFromSelection();
        }

        /**
         * 仅主题节点对应的 DOM（jmnode），与 querySelector('[nodeid]') 不同：展开钮 jmexpander 也有 nodeid，
         * 会导致同一逻辑节点两个矩形、框选重复计数或漏判。优先用 jsMind 模型里的 view.element。
         */
        function getMindmapTopicElements() {
          var out = [];
          if (jm && jm.mind && jm.mind.nodes) {
            var map = jm.mind.nodes;
            for (var k in map) {
              if (!Object.prototype.hasOwnProperty.call(map, k)) {
                continue;
              }
              var mn = map[k];
              var el = mn && mn._data && mn._data.view && mn._data.view.element;
              if (el && typeof el.getBoundingClientRect === 'function') {
                out.push(el);
              }
            }
            if (out.length) {
              return out;
            }
          }
          if (!jsmindContainerEl) {
            return [];
          }
          return Array.from(jsmindContainerEl.querySelectorAll('jmnode'));
        }
        function getVisibleDomTopicElements() {
          if (!jsmindContainerEl) return [];
          const candidates = Array.from(jsmindContainerEl.querySelectorAll('jmnode, .jmnode'));
          const out = [];
          for (const el of candidates) {
            if (!el || !el.isConnected) continue;
            const r = el.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) out.push(el);
          }
          return out;
        }
        function getViewportVisibleTopicElements() {
          if (!canvasWrapEl) return [];
          const wrap = canvasWrapEl.getBoundingClientRect();
          const all = getVisibleDomTopicElements();
          const out = [];
          for (const el of all) {
            const r = el.getBoundingClientRect();
            if (hasRectOverlap(r, wrap)) out.push(el);
          }
          return out;
        }
        function getRootTopicElement() {
          if (!jm || !jsmindContainerEl) return null;
          const rootNode = jm.get_root ? jm.get_root() : null;
          const rootId = rootNode && rootNode.id ? String(rootNode.id) : '';
          if (!rootId) return null;
          return (
            jsmindContainerEl.querySelector('.jmnode[nodeid="' + rootId + '"]') ||
            jsmindContainerEl.querySelector('jmnode[nodeid="' + rootId + '"]') ||
            jsmindContainerEl.querySelector('[nodeid="' + rootId + '"]') ||
            null
          );
        }
        function isRootNodePaintedInViewport() {
          if (!canvasWrapEl) return false;
          const rootEl = getRootTopicElement();
          if (!rootEl || !rootEl.isConnected) return false;
          const rect = rootEl.getBoundingClientRect();
          if (!(rect.width > 0 && rect.height > 0)) return false;
          const wrap = canvasWrapEl.getBoundingClientRect();
          if (!hasRectOverlap(rect, wrap)) return false;
          const cx = Math.max(wrap.left + 1, Math.min(wrap.right - 1, rect.left + rect.width / 2));
          const cy = Math.max(wrap.top + 1, Math.min(wrap.bottom - 1, rect.top + rect.height / 2));
          const topEl = document.elementFromPoint(cx, cy);
          if (!topEl) return false;
          return topEl === rootEl || (rootEl.contains && rootEl.contains(topEl));
        }

        function getNodeElFromTarget(target) {
          if (!target || !target.closest) return null;
          return (
            target.closest('.jmnode') ||
            target.closest('jmnode') ||
            target.closest('[nodeid]') ||
            null
          );
        }

        function addNodeToMultiSelect(nodeEl) {
          if (!nodeEl) return;
          if (!lassoSelectedNodes.includes(nodeEl)) lassoSelectedNodes.push(nodeEl);
          nodeEl.classList.add('lasso-selected');
          nodeEl.classList.add('selected');
        }

        function removeNodeFromMultiSelect(nodeEl) {
          if (!nodeEl) return;
          lassoSelectedNodes = lassoSelectedNodes.filter((n) => n !== nodeEl);
          nodeEl.classList.remove('lasso-selected');
          nodeEl.classList.remove('selected');
        }

        function setSingleSelectStatus(node) {
          if (!node) {
            setStatus(t('ready'));
            return;
          }
          const nodeId = String(node.id || '');
          if (!nodeId) {
            setStatus(t('ready'));
            return;
          }
          setStatus('id=' + nodeId);
        }

        function setMultiSelectStatus() {
          if (lassoSelectedNodes.length > 0) {
            const ids = [];
            for (const el of lassoSelectedNodes) {
              if (!el || !el.getAttribute) continue;
              const id = String(el.getAttribute('nodeid') || '').trim();
              if (id) ids.push(id);
            }
            const idText = ids.length ? ids.join(',') : '-';
            setStatus(
              (currentLang === 'zh' ? '多选：' : 'Multi-select: ') +
                lassoSelectedNodes.length +
                (currentLang === 'zh' ? ' 个节点' : ' nodes') +
                ' | ids=' +
                idText
            );
          } else {
            setStatus(t('ready'));
          }
        }

        function applyViewTransform() {
          if (!jsmindContainerEl) return;
          jsmindContainerEl.style.transformOrigin = '0 0';
          jsmindContainerEl.style.transform = 'translate(' + panX + 'px, ' + panY + 'px) scale(' + zoomScale + ')';
          if (canvasZoomValueEl) canvasZoomValueEl.textContent = Math.round(zoomScale * 100) + '%';

          if (gridLayerEl) {
            // Infinite grid: keep a fixed full-screen layer and update tile size/offset from pan+zoom.
            const base = Math.min(120, Math.max(6, 20 * zoomScale));
            const offX = ((panX % base) + base) % base;
            const offY = ((panY % base) + base) % base;
            gridLayerEl.style.backgroundSize = base + 'px ' + base + 'px';
            gridLayerEl.style.backgroundPosition = offX + 'px ' + offY + 'px';
          }
        }

        function syncCanvasWrapResizeAnchor() {
          if (!canvasWrapEl) return;
          const r = canvasWrapEl.getBoundingClientRect();
          lastCanvasWrapObservedSize.w = r.width;
          lastCanvasWrapObservedSize.h = r.height;
        }

        /**
         * 画布客户区宽高变化时，保持「变化前视口中心」所对准的画布内容仍落在「变化后视口中心」
         * （等价于 pan += ΔW/2, ΔH/2，与 zoomByStep 以中心为锚点的约定一致）。
         */
        function installCanvasWrapResizeKeepCenter() {
          if (!canvasWrapEl || typeof ResizeObserver === 'undefined') return;
          const ro = new ResizeObserver(function () {
            if (!canvasWrapEl) return;
            const r = canvasWrapEl.getBoundingClientRect();
            const w = r.width;
            const h = r.height;
            const lw = lastCanvasWrapObservedSize.w;
            const lh = lastCanvasWrapObservedSize.h;
            if (lw > 0 && lh > 0 && (w !== lw || h !== lh)) {
              panX += (w - lw) / 2;
              panY += (h - lh) / 2;
              applyViewTransform();
            }
            lastCanvasWrapObservedSize.w = w;
            lastCanvasWrapObservedSize.h = h;
          });
          ro.observe(canvasWrapEl);
        }
        installCanvasWrapResizeKeepCenter();

        /** 以画布客户区中心为锚点步进缩放（步长与滚轮一致 ±0.1）。 */
        function zoomByStep(delta) {
          if (!canvasWrapEl) return;
          const oldScale = zoomScale;
          const newScale = Math.min(3, Math.max(0.3, zoomScale + delta));
          if (newScale === oldScale) return;
          const rect = canvasWrapEl.getBoundingClientRect();
          const px = rect.width / 2;
          const py = rect.height / 2;
          panX = px - ((px - panX) / oldScale) * newScale;
          panY = py - ((py - panY) / oldScale) * newScale;
          zoomScale = newScale;
          applyViewTransform();
        }

        function getMindPanelScroll() {
          const p = jm && jm.view && jm.view.e_panel;
          if (!p) return null;
          return { sl: p.scrollLeft, st: p.scrollTop };
        }

        function setMindPanelScroll(saved) {
          if (!saved) return;
          const p = jm && jm.view && jm.view.e_panel;
          if (!p) return;
          p.scrollLeft = saved.sl;
          p.scrollTop = saved.st;
        }

        function withFrozenMindPanelScroll(fn) {
          const saved = getMindPanelScroll();
          if (!saved) {
            fn();
            return;
          }
          fn();
          setMindPanelScroll(saved);
        }

        /** 展开/折叠重排后，把指定节点在视口中的中心拉回折叠前的屏幕位置（动外层 pan，不是动节点模型）。 */
        function compensateMindViewport(cx0, cy0, nodeIdStr, allowAsyncFallback) {
          if (cx0 == null || cy0 == null || !nodeIdStr) return false;
          const node = findNodeById(nodeIdStr);
          const el = node && node._data && node._data.view && node._data.view.element;
          if (el && el.isConnected) {
            const r1 = el.getBoundingClientRect();
            const cx1 = r1.left + r1.width / 2;
            const cy1 = r1.top + r1.height / 2;
            panX += cx0 - cx1;
            panY += cy0 - cy1;
            applyViewTransform();
            return true;
          }
          if (allowAsyncFallback !== false) {
            requestAnimationFrame(function () {
              compensateMindViewport(cx0, cy0, nodeIdStr, false);
            });
          }
          return false;
        }

        function withMindExpandCollapseStable(node, fn) {
          let cx0 = null;
          let cy0 = null;
          let nid = null;
          const el = node && node._data && node._data.view && node._data.view.element;
          if (el && el.isConnected) {
            const r0 = el.getBoundingClientRect();
            cx0 = r0.left + r0.width / 2;
            cy0 = r0.top + r0.height / 2;
            nid = node.id != null ? String(node.id) : null;
          }
          withFrozenMindPanelScroll(fn);
          if (cx0 != null && cy0 != null && nid) {
            compensateMindViewport(cx0, cy0, nid, true);
          }
        }

        function ensureVirtualCanvasSize() {
          if (!jsmindContainerEl) return;
          // Avoid giant layout surfaces; keep container viewport-sized.
          jsmindContainerEl.style.width = '100%';
          jsmindContainerEl.style.height = '100%';
          jsmindContainerEl.style.minHeight = '100%';
        }

        elOn(canvasWrapEl, 'mousedown', function (e) {
          // Ctrl/Cmd + left click on node => toggle multi-select.
          if (e.button === 0 && (e.ctrlKey || e.metaKey)) {
            const nodeEl = getNodeElFromTarget(e.target);
            if (nodeEl) {
              const nodeId = nodeEl.getAttribute ? nodeEl.getAttribute('nodeid') : null;
              if (nodeId && jm && jm.select_node) {
                try {
                  jm.select_node(nodeId);
                  selectedNode = jm.get_selected_node ? jm.get_selected_node() : selectedNode;
                } catch (_) {}
              }
              if (lassoSelectedNodes.includes(nodeEl)) {
                removeNodeFromMultiSelect(nodeEl);
              } else {
                addNodeToMultiSelect(nodeEl);
              }
              setMultiSelectStatus();
              refreshDockFromSelection();
              e.preventDefault();
              return;
            }
          }

          if (e.button === 1) {
            isMiddleDragging = true;
            dragStartX = e.clientX;
            dragStartY = e.clientY;
            canvasWrapEl.style.cursor = 'grabbing';
            middleDragPointerId = null;
            e.preventDefault();
            return;
          }

          // 框选改由 pointerdown 处理（保证 pointerId + setPointerCapture，在 webview 外松开仍能收到 pointerup）
        });

        elOn(
          canvasWrapEl,
          'pointerdown',
          function (e) {
            if (e.button !== 0) return;
            const t = e.target;
            /* 左下角缩放条：须在框选逻辑之前排除，否则捕获阶段 preventDefault 会吃掉按钮 click */
            if (t && t.closest && t.closest('#canvasZoomStack')) return;
            const onNode =
              t &&
              t.closest &&
              (
                t.closest('.jmnode') ||
                t.closest('[nodeid]') ||
                t.closest('.root') ||
                t.closest('jmnode')
              );
            if (onNode) return;

            isLassoSelecting = true;
            lassoStartX = e.clientX;
            lassoStartY = e.clientY;
            if (!(e.ctrlKey || e.metaKey)) clearLassoMarks();

            selectionBoxEl = document.createElement('div');
            selectionBoxEl.className = 'selectionBox';
            selectionBoxEl.style.left = lassoStartX + 'px';
            selectionBoxEl.style.top = lassoStartY + 'px';
            selectionBoxEl.style.width = '0px';
            selectionBoxEl.style.height = '0px';
            document.body.appendChild(selectionBoxEl);
            lassoPointerId = null;
            try {
              var capEl = canvasWrapEl || document.body;
              var pid = e.pointerId;
              if (capEl && capEl.setPointerCapture && pid != null) {
                capEl.setPointerCapture(pid);
                lassoPointerId = pid;
              }
            } catch (_) {}
            e.preventDefault();
          },
          true
        );

        function finishLassoSelection() {
          if (!isLassoSelecting) return;
          isLassoSelecting = false;
          try {
            var relEl = canvasWrapEl || document.body;
            if (relEl && lassoPointerId != null && typeof relEl.releasePointerCapture === 'function') {
              relEl.releasePointerCapture(lassoPointerId);
            }
          } catch (_) {}
          lassoPointerId = null;

          if (!selectionBoxEl || !jsmindContainerEl) {
            if (selectionBoxEl) {
              try {
                selectionBoxEl.remove();
              } catch (_) {}
              selectionBoxEl = null;
            }
            return;
          }

          const selRect = selectionBoxEl.getBoundingClientRect();
          try {
            selectionBoxEl.remove();
          } catch (_) {}
          selectionBoxEl = null;

          clearLassoMarks();
          const nodes = getMindmapTopicElements();
          const hits = [];
          for (const n of nodes) {
            const r = n.getBoundingClientRect();
            const overlap =
              !(r.right < selRect.left || r.left > selRect.right || r.bottom < selRect.top || r.top > selRect.bottom);
            if (!overlap) continue;
            n.classList.add('lasso-selected');
            n.classList.add('selected');
            hits.push(n);
          }

          lassoSelectedNodes = hits;
          if (hits.length === 1) {
            const nid = hits[0].getAttribute('nodeid');
            if (nid && jm && jm.select_node) {
              jm.select_node(nid);
              selectedNode = jm.get_selected_node ? jm.get_selected_node() : findNodeById(nid);
            }
            setSingleSelectStatus(selectedNode);
          } else if (hits.length > 1) {
            clearMindmapSingleSelection();
            setMultiSelectStatus();
          } else {
            clearMindmapSingleSelection();
            setStatus(t('ready'));
          }
          refreshDockFromSelection();
        }

        window.addEventListener('mousemove', function (e) {
          if (!isMiddleDragging) return;
          const dx = e.clientX - dragStartX;
          const dy = e.clientY - dragStartY;
          dragStartX = e.clientX;
          dragStartY = e.clientY;
          panX += dx;
          panY += dy;
          applyViewTransform();
        });

        window.addEventListener('pointermove', function (e) {
          if (!isMiddleDragging) return;
          const dx = e.clientX - dragStartX;
          const dy = e.clientY - dragStartY;
          dragStartX = e.clientX;
          dragStartY = e.clientY;
          panX += dx;
          panY += dy;
          applyViewTransform();
        });

        elOn(
          canvasWrapEl,
          'pointerdown',
          function (e) {
            if (e.button !== 1) return;
            isMiddleDragging = true;
            dragStartX = e.clientX;
            dragStartY = e.clientY;
            canvasWrapEl.style.cursor = 'grabbing';
            middleDragPointerId = null;
            try {
              const capEl = canvasWrapEl || document.body;
              const pid = e.pointerId;
              if (capEl && capEl.setPointerCapture && pid != null) {
                capEl.setPointerCapture(pid);
                middleDragPointerId = pid;
              }
            } catch (_) {}
            e.preventDefault();
          },
          true
        );

        function updateLassoBoxFromEvent(e) {
          if (!isLassoSelecting || !selectionBoxEl) return;
          const x = Math.min(lassoStartX, e.clientX);
          const y = Math.min(lassoStartY, e.clientY);
          const w = Math.abs(e.clientX - lassoStartX);
          const h = Math.abs(e.clientY - lassoStartY);
          selectionBoxEl.style.left = x + 'px';
          selectionBoxEl.style.top = y + 'px';
          selectionBoxEl.style.width = w + 'px';
          selectionBoxEl.style.height = h + 'px';
        }
        window.addEventListener('mousemove', updateLassoBoxFromEvent);
        window.addEventListener('pointermove', updateLassoBoxFromEvent);

        window.addEventListener('mouseup', function () {
          if (!isMiddleDragging) return;
          isMiddleDragging = false;
          try {
            const relEl = canvasWrapEl || document.body;
            if (
              relEl &&
              middleDragPointerId != null &&
              typeof relEl.releasePointerCapture === 'function'
            ) {
              relEl.releasePointerCapture(middleDragPointerId);
            }
          } catch (_) {}
          middleDragPointerId = null;
          if (canvasWrapEl) canvasWrapEl.style.cursor = '';
        });

        document.addEventListener(
          'pointerup',
          function () {
            if (!isMiddleDragging) return;
            isMiddleDragging = false;
            middleDragPointerId = null;
            if (canvasWrapEl) canvasWrapEl.style.cursor = '';
          },
          true
        );
        document.addEventListener(
          'pointercancel',
          function () {
            if (!isMiddleDragging) return;
            isMiddleDragging = false;
            middleDragPointerId = null;
            if (canvasWrapEl) canvasWrapEl.style.cursor = '';
          },
          true
        );
        window.addEventListener('blur', function () {
          if (!isMiddleDragging) return;
          isMiddleDragging = false;
          middleDragPointerId = null;
          if (canvasWrapEl) canvasWrapEl.style.cursor = '';
        });
        (canvasWrapEl || document.body).addEventListener('lostpointercapture', function () {
          if (!isMiddleDragging) return;
          isMiddleDragging = false;
          middleDragPointerId = null;
          if (canvasWrapEl) canvasWrapEl.style.cursor = '';
        });

        window.addEventListener('mouseup', finishLassoSelection);
        document.addEventListener('pointerup', finishLassoSelection, true);
        document.addEventListener('pointercancel', finishLassoSelection, true);
        window.addEventListener('blur', function () {
          if (isLassoSelecting) finishLassoSelection();
        });
        (canvasWrapEl || document.body).addEventListener('lostpointercapture', function () {
          if (isLassoSelecting) finishLassoSelection();
        });

        elOn(canvasWrapEl, 'wheel', function (e) {
          if (!e.ctrlKey && !e.metaKey) {
            // Zoom around current mouse pointer position.
            const rect = canvasWrapEl.getBoundingClientRect();
            const px = e.clientX - rect.left;
            const py = e.clientY - rect.top;

            const oldScale = zoomScale;
            const delta = e.deltaY < 0 ? 0.1 : -0.1;
            const newScale = Math.min(3, Math.max(0.3, zoomScale + delta));
            if (newScale === oldScale) return;

            panX = px - ((px - panX) / oldScale) * newScale;
            panY = py - ((py - panY) / oldScale) * newScale;
            zoomScale = newScale;
            applyViewTransform();
            e.preventDefault();
          }
        }, { passive: false });

        function selectNodeById(id) {
          if (!jm || id == null) return;
          try {
            jm.select_node(id);
            selectedNode = jm.get_selected_node ? jm.get_selected_node() : null;
            if (selectedNode) {
              setSingleSelectStatus(selectedNode);
            }
          } catch (_) {}
        }

        function clearLassoIfMultiSelect() {
          if (lassoSelectedNodes && lassoSelectedNodes.length > 1) {
            clearLassoMarks();
          }
        }

        /** 方向键 ↑/↓：在同级兄弟之间切换选中。根节点无兄弟，不移动。 */
        function navigateSelectSibling(delta) {
          if (!jm) return;
          clearLassoIfMultiSelect();
          let node = getActiveSelectedNode();
          if (!node) {
            const r = jm.get_root && jm.get_root();
            if (r) {
              selectNodeById(r.id);
              ensureMindNodeInCanvasView(String(r.id));
            }
            return;
          }
          if (rootId && String(node.id) === String(rootId)) {
            return;
          }
          const other =
            delta < 0
              ? jm.find_node_before
                ? jm.find_node_before(node)
                : null
              : jm.find_node_after
                ? jm.find_node_after(node)
                : null;
          if (other) {
            selectNodeById(other.id);
            ensureMindNodeInCanvasView(String(other.id));
          }
        }

        /** 方向键 ←：选中父节点。 */
        function navigateSelectParent() {
          if (!jm) return;
          clearLassoIfMultiSelect();
          const node = getActiveSelectedNode();
          if (!node) {
            const r = jm.get_root && jm.get_root();
            if (r) {
              selectNodeById(r.id);
              ensureMindNodeInCanvasView(String(r.id));
            }
            return;
          }
          const p = node.parent;
          if (!p) {
            return;
          }
          selectNodeById(p.id);
          ensureMindNodeInCanvasView(String(p.id));
        }

        /** 方向键 →：选中第一个子节点；无子节点则不变化。 */
        function navigateSelectFirstChild() {
          if (!jm) return;
          clearLassoIfMultiSelect();
          let node = getActiveSelectedNode();
          if (!node) {
            node = jm.get_root ? jm.get_root() : null;
          }
          if (!node) {
            return;
          }
          const kids = node.children;
          if (!kids || !kids.length) {
            return;
          }
          const first = kids[0];
          if (first && first.id != null) {
            selectNodeById(first.id);
            ensureMindNodeInCanvasView(String(first.id));
          }
        }

        function addChild() {
          if (!jm) return;
          const node = getActiveSelectedNode();
          if (!node) {
            notifyInvalidAction(t('alertNoSelectAddChild'));
            return;
          }
          const topic = 'New Node';
          const newId = allocateNextNodeId();
          jm.add_node(node, newId, topic, null);
          markContentDirty();
          selectNodeById(newId);
          ensureMindNodeInCanvasView(newId);
        }

        function addSibling() {
          if (!jm) return;
          const node = getActiveSelectedNode();
          if (!node) {
            notifyInvalidAction(t('alertNoSelectAddSibling'));
            return;
          }
          if (rootId && node.id === rootId) {
            notifyInvalidAction(t('alertRootNoSibling'));
            return;
          }
          const parentNode = node.parent;
          if (!parentNode) {
            notifyInvalidAction(t('alertNoParentSibling'));
            return;
          }
          const newId = allocateNextNodeId();
          jm.add_node(parentNode, newId, 'New Node', null);
          markContentDirty();
          selectNodeById(newId);
          ensureMindNodeInCanvasView(newId);
        }

        /** Alt+↑/↓：在同一父节点下调整兄弟顺序。 */
        function moveSiblingUp() {
          if (!jm) return;
          const node = getActiveSelectedNode();
          if (!node) return;
          if (rootId && String(node.id) === String(rootId)) return;
          const parent = node.parent;
          if (!parent) return;
          const prev = jm.find_node_before ? jm.find_node_before(node) : null;
          if (!prev) return;
          try {
            jm.move_node(node, prev.id, parent.id);
            markContentDirty();
            selectNodeById(node.id);
            ensureMindNodeInCanvasView(String(node.id));
          } catch (_) {
            notifyInvalidAction(t('alertPromoteDemoteFailed'));
          }
        }

        function moveSiblingDown() {
          if (!jm) return;
          const node = getActiveSelectedNode();
          if (!node) return;
          if (rootId && String(node.id) === String(rootId)) return;
          const parent = node.parent;
          if (!parent) return;
          const next = jm.find_node_after ? jm.find_node_after(node) : null;
          if (!next) return;
          const nextAfter = jm.find_node_after ? jm.find_node_after(next) : null;
          const beforeSpec = nextAfter ? nextAfter.id : '_last_';
          try {
            jm.move_node(node, beforeSpec, parent.id);
            markContentDirty();
            selectNodeById(node.id);
            ensureMindNodeInCanvasView(String(node.id));
          } catch (_) {
            notifyInvalidAction(t('alertPromoteDemoteFailed'));
          }
        }

        /**
         * 插入菜单：在选中节点（无选中则用根）下添加子节点，data.mmEmbed 记录类型与资源元数据。
         * 画布上以 mm-embed-* 样式区分；完整渲染（图片/视频/HTML 表格等）可后续接扩展或 Webview 消息。
         */
        function insertEmbedChild(kind) {
          if (!jm) return;
          const parent = getActiveSelectedNode() || (jm.get_root ? jm.get_root() : null);
          if (!parent) {
            notifyInvalidAction(t('alertNoSelectAddChild'));
            return;
          }
          const prefixKey = 'embedTopicPrefix_' + kind;
          const prefix = t(prefixKey) || '[' + kind + ']';
          const newId = allocateNextNodeId();
          const embed = { type: kind, v: 1 };
          let topic = prefix;

          if (kind === 'image' || kind === 'video' || kind === 'audio' || kind === 'gltf') {
            const u = window.prompt(t('embedPromptUrl'), 'https://');
            if (u === null) return;
            embed.src = String(u).trim();
            topic = prefix + ' ' + (embed.src || t('embedNoUrl'));
          } else if (kind === 'text') {
            const tx = window.prompt(t('embedPromptText'), '');
            if (tx === null) return;
            embed.text = String(tx);
            const short =
              embed.text.length > 36 ? embed.text.slice(0, 34) + '…' : embed.text;
            topic = prefix + ' ' + (short || t('embedNoUrl'));
          } else if (kind === 'whiteboard') {
            embed.boardId = 'wb_' + Math.random().toString(16).slice(2);
            topic = prefix;
          } else if (kind === 'table') {
            const spec = window.prompt(t('embedPromptTable'), '3x4');
            if (spec === null) return;
            let rows = 3;
            let cols = 4;
            const m = String(spec).trim().match(/^(\d+)\s*[xX×]\s*(\d+)$/);
            if (m) {
              rows = Math.min(99, Math.max(1, parseInt(m[1], 10)));
              cols = Math.min(99, Math.max(1, parseInt(m[2], 10)));
            }
            embed.rows = rows;
            embed.cols = cols;
            topic = prefix + ' (' + rows + '×' + cols + ')';
          } else {
            return;
          }

          try {
            jm.add_node(parent, newId, topic, { mmEmbed: embed });
          } catch (_) {
            notifyInvalidAction(t('alertPromoteDemoteFailed'));
            return;
          }
          markContentDirty();
          selectNodeById(newId);
          ensureMindNodeInCanvasView(newId);
          requestAnimationFrame(function () {
            const n = findNodeById(newId);
            if (n) applyMindNodeVisual(n);
          });
        }

        function deleteNode() {
          if (!jm) return;
          const node = getActiveSelectedNode();
          if (!node) {
            notifyInvalidAction(t('alertNoSelectDelete'));
            return;
          }
          if (rootId && node.id === rootId) {
            notifyInvalidAction(t('alertRootNoDelete'));
            return;
          }
          jm.remove_node(node);
          markContentDirty();
          selectedNode = null;
        }

        /** 提升：变为父节点的兄弟（挂到祖父下，紧跟在父节点之后）。 */
        function promoteNode() {
          if (!jm) {
            return;
          }
          const node = getActiveSelectedNode();
          if (!node) {
            notifyInvalidAction(t('alertNoSelectPromote'));
            return;
          }
          if (rootId && String(node.id) === String(rootId)) {
            notifyInvalidAction(t('alertRootNoPromote'));
            return;
          }
          const parent = node.parent;
          if (!parent || parent.isroot) {
            notifyInvalidAction(t('alertCannotPromote'));
            return;
          }
          const gp = parent.parent;
          if (!gp) {
            notifyInvalidAction(t('alertCannotPromote'));
            return;
          }
          const nextAfterParent = jm.find_node_after ? jm.find_node_after(parent) : null;
          let beforeSpec = '_last_';
          if (
            nextAfterParent &&
            nextAfterParent.parent &&
            String(nextAfterParent.parent.id) === String(gp.id)
          ) {
            beforeSpec = nextAfterParent.id;
          }
          try {
            jm.move_node(node, beforeSpec, gp.id);
            markContentDirty();
            try {
              jm.select_node(node.id);
              selectedNode = jm.get_selected_node ? jm.get_selected_node() : node;
            } catch (_) {}
            ensureMindNodeInCanvasView(String(node.id));
          } catch (_) {
            notifyInvalidAction(t('alertPromoteDemoteFailed'));
          }
        }

        /** 下降：挂到前一个兄弟节点下（作为其子节点末位）。 */
        function demoteNode() {
          if (!jm) {
            return;
          }
          const node = getActiveSelectedNode();
          if (!node) {
            notifyInvalidAction(t('alertNoSelectDemote'));
            return;
          }
          if (rootId && String(node.id) === String(rootId)) {
            notifyInvalidAction(t('alertRootNoDemote'));
            return;
          }
          const prev = jm.find_node_before ? jm.find_node_before(node) : null;
          if (!prev) {
            notifyInvalidAction(t('alertCannotDemote'));
            return;
          }
          try {
            jm.move_node(node, '_last_', prev.id);
            markContentDirty();
            try {
              jm.select_node(node.id);
              selectedNode = jm.get_selected_node ? jm.get_selected_node() : node;
            } catch (_) {}
            ensureMindNodeInCanvasView(String(node.id));
          } catch (_) {
            notifyInvalidAction(t('alertPromoteDemoteFailed'));
          }
        }

        function moveToFirst() {
          if (!jm || !selectedNode) return;
          if (rootId && selectedNode.id === rootId) return;
          jm.move_node(selectedNode, '_first_');
          markContentDirty();
          selectedNode = null;
        }

        function moveToLast() {
          if (!jm || !selectedNode) return;
          if (rootId && selectedNode.id === rootId) return;
          jm.move_node(selectedNode, '_last_');
          markContentDirty();
          selectedNode = null;
        }

        function expandSelected() {
          if (!jm) return;
          const node = getActiveSelectedNode();
          if (!node) {
            notifyInvalidAction(t('alertNoSelectExpand'));
            return;
          }
          withMindExpandCollapseStable(node, function () {
            jm.expand_node(node);
          });
        }

        function collapseSelected() {
          if (!jm) return;
          const node = getActiveSelectedNode();
          if (!node) {
            notifyInvalidAction(t('alertNoSelectCollapse'));
            return;
          }
          withMindExpandCollapseStable(node, function () {
            jm.collapse_node(node);
          });
        }

        function toggleSelected() {
          if (!jm) return;
          const node = getActiveSelectedNode();
          if (!node) {
            notifyInvalidAction(t('alertNoSelectToggle'));
            return;
          }
          withMindExpandCollapseStable(node, function () {
            jm.toggle_node(node);
          });
        }

        function expandAll() {
          if (!jm) return;
          const node = getActiveSelectedNode() || (jm.get_root ? jm.get_root() : null);
          withMindExpandCollapseStable(node, function () {
            jm.expand_all();
          });
        }

        function resetZoom() {
          zoomScale = 1;
          panX = 0;
          panY = 0;
          applyViewTransform();
          centerRoot();
        }

        function centerRoot() {
          if (!jm || !canvasWrapEl || !jsmindContainerEl) return;
          const rootNode = jm.get_root ? jm.get_root() : null;
          if (!rootNode || !rootNode.id) {
            fitAll();
            return;
          }
          const rootEl =
            jsmindContainerEl.querySelector('[nodeid=\"' + rootNode.id + '\"]') ||
            jsmindContainerEl.querySelector('.jmnode[nodeid=\"' + rootNode.id + '\"]') ||
            jsmindContainerEl.querySelector('jmnode[nodeid=\"' + rootNode.id + '\"]') ||
            jsmindContainerEl.querySelector('[root=\"true\"]') ||
            jsmindContainerEl.querySelector('.root') ||
            jsmindContainerEl.querySelector('.jmnode, jmnode, [nodeid]');
          if (!rootEl) {
            fitAll();
            return;
          }

          const wrapRect = canvasWrapEl.getBoundingClientRect();
          const rootX = rootEl.offsetLeft + rootEl.offsetWidth / 2;
          const rootY = rootEl.offsetTop + rootEl.offsetHeight / 2;
          panX = wrapRect.width / 2 - rootX * zoomScale;
          panY = wrapRect.height / 2 - rootY * zoomScale;
          applyViewTransform();
          syncCanvasWrapResizeAnchor();
        }

        function fitAll() {
          if (!canvasWrapEl || !jsmindContainerEl) return;
          const nodes = getMindmapTopicElements();
          if (!nodes.length) return;

          let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
          for (const n of nodes) {
            minX = Math.min(minX, n.offsetLeft);
            minY = Math.min(minY, n.offsetTop);
            maxX = Math.max(maxX, n.offsetLeft + n.offsetWidth);
            maxY = Math.max(maxY, n.offsetTop + n.offsetHeight);
          }

          const boundsW = Math.max(1, maxX - minX);
          const boundsH = Math.max(1, maxY - minY);
          const margin = 40;
          const wrapRect = canvasWrapEl.getBoundingClientRect();
          const sx = (wrapRect.width - margin) / boundsW;
          const sy = (wrapRect.height - margin) / boundsH;
          zoomScale = Math.min(3, Math.max(0.3, Math.min(sx, sy)));

          panX = wrapRect.width / 2 - (minX + boundsW / 2) * zoomScale;
          panY = wrapRect.height / 2 - (minY + boundsH / 2) * zoomScale;
          applyViewTransform();
          syncCanvasWrapResizeAnchor();
        }

        function getMindNodeTopicElement(mnode) {
          return mnode && mnode._data && mnode._data.view && mnode._data.view.element
            ? mnode._data.view.element
            : null;
        }

        /**
         * 选中节点及其邻域（若存在）：父、第一个子、上一个兄弟、下一个兄弟 — 用于视口计算。
         */
        function collectNeighborhoodTopicElements(nodeIdStr) {
          const els = [];
          if (!jm || !nodeIdStr) {
            return els;
          }
          const node = findNodeById(nodeIdStr);
          if (!node) {
            return els;
          }
          const seen = new Set();
          function pushEl(mn) {
            const el = getMindNodeTopicElement(mn);
            if (el && !seen.has(el)) {
              seen.add(el);
              els.push(el);
            }
          }
          pushEl(node);
          if (node.parent) {
            pushEl(node.parent);
          }
          const kids = node.children;
          if (kids && kids.length > 0) {
            pushEl(kids[0]);
          }
          if (!(rootId && String(node.id) === String(rootId))) {
            const prev = jm.find_node_before ? jm.find_node_before(node) : null;
            const next = jm.find_node_after ? jm.find_node_after(node) : null;
            if (prev) {
              pushEl(prev);
            }
            if (next) {
              pushEl(next);
            }
          }
          return els;
        }

        function unionScreenRects(elements) {
          let minL = Infinity;
          let minT = Infinity;
          let maxR = -Infinity;
          let maxB = -Infinity;
          for (let i = 0; i < elements.length; i++) {
            const el = elements[i];
            if (!el || !el.getBoundingClientRect) {
              continue;
            }
            const r = el.getBoundingClientRect();
            if (r.width <= 0 && r.height <= 0) {
              continue;
            }
            minL = Math.min(minL, r.left);
            minT = Math.min(minT, r.top);
            maxR = Math.max(maxR, r.right);
            maxB = Math.max(maxB, r.bottom);
          }
          if (minL === Infinity) {
            return null;
          }
          return {
            left: minL,
            top: minT,
            right: maxR,
            bottom: maxB,
            width: maxR - minL,
            height: maxB - minT
          };
        }

        /**
         * 将选中节点及其邻域（父/一子/上下兄弟，若存在）纳入画布可视区：优先平移，不足时缩小 zoom。
         * add_node / 方向键等之后布局可能尚未稳定，使用双 rAF；缩放后必要时再跑一帧平移。
         */
        function ensureMindNodeInCanvasView(nodeIdStr) {
          if (!nodeIdStr || !canvasWrapEl) {
            return;
          }
          function runEnsure(depth) {
            if (depth > 12) {
              return;
            }
            const elements = collectNeighborhoodTopicElements(nodeIdStr);
            const union = unionScreenRects(elements);
            if (!union) {
              return;
            }
            const wrap = canvasWrapEl.getBoundingClientRect();
            const margin = 28;
            const availW = Math.max(8, wrap.width - 2 * margin);
            const availH = Math.max(8, wrap.height - 2 * margin);
            const uw = union.width;
            const uh = union.height;

            if (uw > availW || uh > availH) {
              const factor = Math.min(availW / uw, availH / uh, 1) * 0.98;
              if (factor < 0.999 && zoomScale > 0.3 + 1e-6) {
                const oldScale = zoomScale;
                const newScale = Math.max(0.3, zoomScale * factor);
                const px = wrap.width / 2;
                const py = wrap.height / 2;
                panX = px - ((px - panX) / oldScale) * newScale;
                panY = py - ((py - panY) / oldScale) * newScale;
                zoomScale = newScale;
                applyViewTransform();
                requestAnimationFrame(function () {
                  runEnsure(depth + 1);
                });
                return;
              }
            }

            const els2 = collectNeighborhoodTopicElements(nodeIdStr);
            const u2 = unionScreenRects(els2);
            if (!u2) {
              return;
            }
            const maxW = availW;
            const maxH = availH;
            let dx = 0;
            let dy = 0;
            if (u2.width <= maxW) {
              if (u2.left < wrap.left + margin) {
                dx = (wrap.left + margin) - u2.left;
              }
              if (u2.right > wrap.right - margin) {
                dx += (wrap.right - margin) - u2.right;
              }
            } else {
              dx = (wrap.left + wrap.right) / 2 - (u2.left + u2.right) / 2;
            }
            if (u2.height <= maxH) {
              if (u2.top < wrap.top + margin) {
                dy = (wrap.top + margin) - u2.top;
              }
              if (u2.bottom > wrap.bottom - margin) {
                dy += (wrap.bottom - margin) - u2.bottom;
              }
            } else {
              dy = (wrap.top + wrap.bottom) / 2 - (u2.top + u2.bottom) / 2;
            }
            if (dx !== 0 || dy !== 0) {
              panX += dx;
              panY += dy;
              applyViewTransform();
            }
          }
          requestAnimationFrame(function () {
            requestAnimationFrame(function () {
              runEnsure(0);
            });
          });
        }

        function doSave() {
          try {
            setStatus(currentLang === 'zh' ? '正在保存...' : 'Saving...');
            const tree = getTreeForFileOps();
            vscode.postMessage({ type: 'mindmap:requestSave', tree });
          } catch (e) {
            const msg = e && e.message ? e.message : String(e);
            notifyInvalidAction((currentLang === 'zh' ? '保存失败：' : 'Save failed: ') + msg);
          }
        }

        function postHostResponse(requestId, ok, data, error) {
          vscode.postMessage({
            type: 'mindmap:hostResponse',
            requestId,
            ok,
            data: data === undefined ? null : data,
            error: error || null
          });
        }

        function findNodeById(nodeId) {
          if (!jm || !nodeId) return null;
          if (typeof jm.get_node === 'function') {
            const n = jm.get_node(nodeId);
            if (n) return n;
          }
          if (typeof jm.get_root === 'function') {
            const root = jm.get_root();
            const walk = (n) => {
              if (!n) return null;
              if (String(n.id) === String(nodeId)) return n;
              const children = Array.isArray(n.children) ? n.children : [];
              for (const ch of children) {
                const r = walk(ch);
                if (r) return r;
              }
              return null;
            };
            return walk(root);
          }
          return null;
        }

        function getSelectionData() {
          const node = getActiveSelectedNode();
          const single = node
            ? {
                id: String(node.id || ''),
                topic: String(node.topic || '')
              }
            : null;

          const seen = new Set();
          const multiItems = [];
          for (const el of lassoSelectedNodes || []) {
            if (!el || !el.getAttribute) continue;
            const nodeId = String(el.getAttribute('nodeid') || '').trim();
            if (!nodeId || seen.has(nodeId)) continue;
            seen.add(nodeId);
            const model = findNodeById(nodeId);
            multiItems.push({
              id: nodeId,
              topic: String((model && model.topic) || '')
            });
          }

          if (!single && multiItems.length === 0) return null;

          const primary = single || multiItems[0] || null;
          return {
            id: primary ? primary.id : '',
            topic: primary ? primary.topic : '',
            selection: single,
            multiSelection:
              multiItems.length > 0
                ? {
                    count: multiItems.length,
                    ids: multiItems.map((x) => x.id),
                    items: multiItems
                  }
                : null
          };
        }

        function executeHostOp(op, dryRun) {
          if (!op || typeof op !== 'object') throw new Error('invalid op');
          const action = String(op.action || '').trim().toLowerCase();
          if (!action) throw new Error('op.action is required');

          if (action === 'gettree') {
            return { action, tree: getTreeFromMind() };
          }

          if (action === 'getselection') {
            return { action, selection: getSelectionData() };
          }

          if (action === 'select') {
            const nodeId = String(op.nodeId || '').trim();
            if (!nodeId) throw new Error('select.nodeId is required');
            const node = findNodeById(nodeId);
            if (!node) throw new Error('node not found: ' + nodeId);
            if (!dryRun) {
              if (jm && jm.select_node) jm.select_node(node.id);
              selectedNode = jm && jm.get_selected_node ? jm.get_selected_node() : node;
            }
            return { action, nodeId: String(node.id), dryRun: !!dryRun };
          }

          if (action === 'add') {
            const parentId = String(op.parentId || '').trim();
            const topic = String(op.topic || '').trim();
            if (!parentId) throw new Error('add.parentId is required');
            if (!topic) throw new Error('add.topic is required');
            const parent = findNodeById(parentId);
            if (!parent) throw new Error('parent node not found: ' + parentId);
            let newId;
            const wantRaw = op.nodeId != null && String(op.nodeId).trim() !== '' ? String(op.nodeId).trim() : '';
            if (wantRaw) {
              if (wantRaw === 'root') {
                throw new Error('add.nodeId cannot be root');
              }
              if (!/^n_\d+$/.test(wantRaw)) {
                throw new Error('add.nodeId must match n_<positive integer>');
              }
              if (jm.mind && jm.mind.nodes && jm.mind.nodes[wantRaw]) {
                throw new Error('add.nodeId already exists: ' + wantRaw);
              }
              newId = wantRaw;
            } else {
              newId = allocateNextNodeId();
            }
            if (!dryRun) {
              jm.add_node(parent, newId, topic, null);
              selectNodeById(newId);
              ensureMindNodeInCanvasView(newId);
            }
            return { action, id: newId, parentId, topic, dryRun: !!dryRun };
          }

          if (action === 'update') {
            const nodeId = String(op.nodeId || '').trim();
            const topic = String(op.topic || '').trim();
            if (!nodeId) throw new Error('update.nodeId is required');
            if (!topic) throw new Error('update.topic is required');
            const node = findNodeById(nodeId);
            if (!node) throw new Error('node not found: ' + nodeId);
            if (!dryRun) {
              jm.update_node(node.id, topic);
            }
            return { action, nodeId: String(node.id), topic, dryRun: !!dryRun };
          }

          if (action === 'delete') {
            const nodeId = String(op.nodeId || '').trim();
            if (!nodeId) throw new Error('delete.nodeId is required');
            const node = findNodeById(nodeId);
            if (!node) throw new Error('node not found: ' + nodeId);
            if (rootId && String(node.id) === String(rootId)) {
              throw new Error('cannot delete root node');
            }
            const removedId = String(node.id);
            if (!dryRun) {
              jm.remove_node(node);
            }
            return { action, nodeId: removedId, dryRun: !!dryRun };
          }

          if (action === 'move') {
            const nodeId = String(op.nodeId || '').trim();
            const newParentId = String(op.newParentId || '').trim();
            const before = String(op.before || '_last_').trim();
            if (!nodeId) {
              throw new Error('move.nodeId is required');
            }
            if (!newParentId) {
              throw new Error('move.newParentId is required');
            }
            const node = findNodeById(nodeId);
            const parent = findNodeById(newParentId);
            if (!node) {
              throw new Error('node not found: ' + nodeId);
            }
            if (!parent) {
              throw new Error('parent not found: ' + newParentId);
            }
            if (rootId && String(node.id) === String(rootId)) {
              throw new Error('cannot move root node');
            }
            if (!dryRun) {
              jm.move_node(node, before, newParentId);
            }
            return { action, nodeId: String(node.id), newParentId, before, dryRun: !!dryRun };
          }

          throw new Error('unsupported action: ' + action);
        }

        bindByIdClick('btnNew', function () {
          setStatus(currentLang === 'zh' ? '正在新建脑图...' : 'Creating new mindmap...');
          vscode.postMessage({ type: 'mindmap:requestNew' });
        });
        bindByIdClick('btnOpen', function () {
          setStatus(currentLang === 'zh' ? '正在打开脑图...' : 'Opening mindmap...');
          vscode.postMessage({ type: 'mindmap:requestOpen' });
        });
        bindByIdClick('btnSave', doSave);
        bindByIdClick('btnSaveAs', function () {
          try {
            setStatus(currentLang === 'zh' ? '正在另存为...' : 'Saving as...');
            vscode.postMessage({ type: 'mindmap:requestSaveAs', tree: getTreeForFileOps() });
          } catch (e) {
            const msg = e && e.message ? e.message : String(e);
            notifyInvalidAction((currentLang === 'zh' ? '另存为失败：' : 'Save As failed: ') + msg);
          }
        });

        // Ensure canvas can receive keyboard focus.
        elOn(canvasWrapEl, 'mousedown', function () {
          if (canvasWrapEl) {
            canvasWrapEl.focus();
          }
        });
        elOn(canvasWrapEl, 'click', function (e) {
          if (canvasWrapEl) {
            canvasWrapEl.focus();
          }
          if (e && (e.ctrlKey || e.metaKey)) return;
          requestAnimationFrame(function () {
            const n = jm && jm.get_selected_node ? jm.get_selected_node() : null;
            if (lassoSelectedNodes.length > 1 && n) {
              clearLassoMarks();
              selectedNode = n;
              setSingleSelectStatus(n);
              refreshDockFromSelection();
              return;
            }
            selectedNode = n;
            if (lassoSelectedNodes.length > 1) {
              setMultiSelectStatus();
            } else {
              setSingleSelectStatus(n);
            }
            refreshDockFromSelection();
          });
        });

        // Double-click node => jsMind default inline edit (begin_edit). Double-click blank canvas => add child.
        elOn(jsmindContainerEl, 'dblclick', function (e) {
          if (!jm || !jsmindContainerEl) return;
          const onNode = e.target ? getNodeElFromTarget(e.target) : null;
          if (onNode) {
            return;
          }
          const parent = getActiveSelectedNode() || (jm.get_root ? jm.get_root() : null);
          if (!parent) return;
          const newId = allocateNextNodeId();
          const topic = t('defaultChildTopic');
          jm.add_node(parent, newId, topic, null);
          markContentDirty();
          selectNodeById(newId);
          ensureMindNodeInCanvasView(newId);
          try {
            e.preventDefault();
            e.stopPropagation();
          } catch (_) {}
        });

        elOn(
          jsmindContainerEl,
          'pointerdown',
          function (e) {
            if (e.button !== 0 || !jm) return;
            const t = e.target;
            if (!t || !t.closest) return;
            const ex = t.closest('jmexpander');
            if (!ex) return;
            const pack = {};
            const s = getMindPanelScroll();
            if (s) {
              pack.sl = s.sl;
              pack.st = s.st;
            }
            const nid = ex.getAttribute ? ex.getAttribute('nodeid') : null;
            const model = nid ? findNodeById(nid) : null;
            const nodeEl = model && model._data && model._data.view && model._data.view.element;
            if (nodeEl && nodeEl.getBoundingClientRect) {
              const r = nodeEl.getBoundingClientRect();
              pack.anchorCx = r.left + r.width / 2;
              pack.anchorCy = r.top + r.height / 2;
              pack.anchorNodeId = nid;
            }
            if (s || pack.anchorNodeId) pendingMindPanelScrollFreeze = pack;
          },
          true
        );
        elOn(jsmindContainerEl, 'click', function (e) {
          if (!pendingMindPanelScrollFreeze || !jm) return;
          const t = e.target;
          if (!t || !t.closest || !t.closest('jmexpander')) return;
          const pack = pendingMindPanelScrollFreeze;
          pendingMindPanelScrollFreeze = null;
          if (pack.sl != null && pack.st != null) {
            setMindPanelScroll({ sl: pack.sl, st: pack.st });
          }
          if (pack.anchorCx != null && pack.anchorNodeId) {
            compensateMindViewport(pack.anchorCx, pack.anchorCy, String(pack.anchorNodeId), true);
          }
        });
        window.addEventListener(
          'click',
          function (e) {
            if (!pendingMindPanelScrollFreeze) return;
            const t = e.target;
            if (t && t.closest && t.closest('jmexpander')) return;
            pendingMindPanelScrollFreeze = null;
          },
          true
        );

        // Keyboard interaction (Windows-like):
        // ↑/↓（画布内）=> 在兄弟节点间切换选中；←/=> 父节点 / 第一个子节点；
        // Enter => 新建兄弟节点并选中新节点；Tab（在画布内）=> 新建子节点并选中新节点；
        // Delete / Backspace => 删除当前选中节点；
        // Alt+↑/↓ => 调整兄弟顺序；Alt+←/→ => 提升 / 下降；
        // Ctrl/Cmd+C / X 复制剪切子树；V 粘贴见 paste 事件。
        window.addEventListener('keydown', function (e) {
          // 主窗口任意位置：Ctrl+空格 => 全屏切换（与标题栏全屏按钮一致，优先于输入区拦截）。
          if (
            e.ctrlKey &&
            !e.metaKey &&
            !e.altKey &&
            (e.key === ' ' || e.code === 'Space')
          ) {
            e.preventDefault();
            e.stopPropagation();
            vscode.postMessage({ type: 'mindmap:requestToggleFullScreen' });
            return;
          }
          const target = e.target;
          const isTyping =
            target &&
            (
              target.tagName === 'INPUT' ||
              target.tagName === 'TEXTAREA' ||
              target.tagName === 'SELECT' ||
              target.isContentEditable
            );
          if (isTyping) return;

          invalidActionKeyboardContext = true;
          try {
          const inCanvasNav =
            canvasWrapEl &&
            e.target instanceof Node &&
            canvasWrapEl.contains(e.target);
          if (
            !e.altKey &&
            !e.ctrlKey &&
            !e.metaKey &&
            !e.shiftKey &&
            inCanvasNav &&
            jm
          ) {
            if (e.key === 'ArrowUp') {
              navigateSelectSibling(-1);
              e.preventDefault();
              e.stopPropagation();
              return;
            }
            if (e.key === 'ArrowDown') {
              navigateSelectSibling(1);
              e.preventDefault();
              e.stopPropagation();
              return;
            }
            if (e.key === 'ArrowLeft') {
              navigateSelectParent();
              e.preventDefault();
              e.stopPropagation();
              return;
            }
            if (e.key === 'ArrowRight') {
              navigateSelectFirstChild();
              e.preventDefault();
              e.stopPropagation();
              return;
            }
          }

          // Alt+↑/↓：兄弟顺序；Alt+←/→：提升 / 下降（父子关系）。
          if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
            if (e.key === 'ArrowUp') {
              moveSiblingUp();
              e.preventDefault();
              e.stopPropagation();
              return;
            }
            if (e.key === 'ArrowDown') {
              moveSiblingDown();
              e.preventDefault();
              e.stopPropagation();
              return;
            }
            if (e.key === 'ArrowLeft') {
              promoteNode();
              e.preventDefault();
              e.stopPropagation();
              return;
            }
            if (e.key === 'ArrowRight') {
              demoteNode();
              e.preventDefault();
              e.stopPropagation();
              return;
            }
          }

          if (e.key === 'Enter') {
            const node = getActiveSelectedNode();
            if (!node) return;
            addSibling();
            e.preventDefault();
            e.stopPropagation();
            return;
          }
          if (e.key === 'Tab') {
            const inCanvas =
              canvasWrapEl &&
              e.target instanceof Node &&
              canvasWrapEl.contains(e.target);
            if (inCanvas) {
              const node = getActiveSelectedNode();
              if (node) {
                addChild();
              }
              e.preventDefault();
              e.stopPropagation();
              return;
            }
          }

          if (e.key === 'Delete' || e.key === 'Backspace') {
            deleteNode();
            e.preventDefault();
            e.stopPropagation();
            return;
          }

          if ((e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A')) {
            if (!jsmindContainerEl) return;
            clearLassoMarks();
            const nodes = getMindmapTopicElements();
            for (const n of nodes) addNodeToMultiSelect(n);
            setMultiSelectStatus();
            e.preventDefault();
            e.stopPropagation();
            return;
          }

          if ((e.ctrlKey || e.metaKey) && (e.key === 'n' || e.key === 'N')) {
            setStatus(currentLang === 'zh' ? '正在新建脑图...' : 'Creating new mindmap...');
            vscode.postMessage({ type: 'mindmap:requestNew' });
            e.preventDefault();
            e.stopPropagation();
            return;
          }

          if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
            if (e.shiftKey) {
              try {
                setStatus(currentLang === 'zh' ? '正在另存为...' : 'Saving as...');
                vscode.postMessage({ type: 'mindmap:requestSaveAs', tree: getTreeForFileOps() });
              } catch (err) {
                const msg = err && err.message ? err.message : String(err);
                notifyInvalidAction((currentLang === 'zh' ? '另存为失败：' : 'Save As failed: ') + msg);
              }
            } else {
              doSave();
            }
            e.preventDefault();
            e.stopPropagation();
            return;
          }

          if ((e.ctrlKey || e.metaKey) && (e.key === 'o' || e.key === 'O')) {
            setStatus(currentLang === 'zh' ? '正在打开脑图...' : 'Opening mindmap...');
            vscode.postMessage({ type: 'mindmap:requestOpen' });
            e.preventDefault();
            e.stopPropagation();
            return;
          }

          if ((e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'C')) {
            if (e.shiftKey) {
              return;
            }
            copyMindNodeSelection();
            e.preventDefault();
            e.stopPropagation();
          }

          if ((e.ctrlKey || e.metaKey) && (e.key === 'x' || e.key === 'X')) {
            if (e.shiftKey) {
              return;
            }
            cutMindNodeSelection();
            e.preventDefault();
            e.stopPropagation();
          }
          } finally {
            invalidActionKeyboardContext = false;
          }
        }, true);

        document.addEventListener('paste', function (e) {
          if (!jm) {
            return;
          }
          const text = e.clipboardData ? (e.clipboardData.getData('text/plain') || '') : '';
          const parent =
            getActiveSelectedNode() || (jm.get_root ? jm.get_root() : null);
          if (!parent) {
            return;
          }
          if (tryPasteMindFromText(text, parent)) {
            e.preventDefault();
            return;
          }
          const node = getActiveSelectedNode();
          if (!node) {
            return;
          }
          const topic = text.toString().trim();
          if (!topic) {
            return;
          }
          const newId = allocateNextNodeId();
          jm.add_node(node, newId, topic, null);
          markContentDirty();
          selectNodeById(newId);
          ensureMindNodeInCanvasView(newId);
          e.preventDefault();
        });

        // Right-click context menus.
        const objCtxMenuEl = document.getElementById('objCtxMenu');
        const canvasCtxMenuEl = document.getElementById('canvasCtxMenu');

        function hideContextMenus() {
          if (objCtxMenuEl) objCtxMenuEl.classList.add('hidden');
          if (canvasCtxMenuEl) canvasCtxMenuEl.classList.add('hidden');
        }

        function showContextMenu(menuEl, x, y) {
          hideContextMenus();
          if (!menuEl) return;
          const vw = window.innerWidth;
          const vh = window.innerHeight;
          menuEl.classList.remove('hidden');
          const rect = menuEl.getBoundingClientRect();
          const left = Math.max(4, Math.min(x, vw - rect.width - 4));
          const top = Math.max(4, Math.min(y, vh - rect.height - 4));
          menuEl.style.left = left + 'px';
          menuEl.style.top = top + 'px';
        }

        elOn(canvasWrapEl, 'contextmenu', function (e) {
          e.preventDefault();
          const targetEl = e.target;
          const onNodeEl =
            targetEl &&
            targetEl.closest &&
            (
              targetEl.closest('.jmnode') ||
              targetEl.closest('[nodeid]') ||
              targetEl.closest('.root') ||
              targetEl.closest('jmnode')
            );

          if (onNodeEl) {
            // Right-click on an already-selected object should not change current selection.
            const nodeId =
              (onNodeEl.getAttribute && onNodeEl.getAttribute('nodeid')) ||
              (onNodeEl.closest && onNodeEl.closest('[nodeid]') && onNodeEl.closest('[nodeid]').getAttribute('nodeid'));
            const nodeIdStr = nodeId != null ? String(nodeId) : '';
            let alreadySelected = false;
            if (nodeIdStr) {
              const cur = jm && jm.get_selected_node ? jm.get_selected_node() : selectedNode;
              const curId = cur && cur.id != null ? String(cur.id) : '';
              if (curId && curId === nodeIdStr) {
                alreadySelected = true;
              } else if (lassoSelectedNodes.length > 0) {
                for (const n of lassoSelectedNodes) {
                  const id = n && n.getAttribute ? String(n.getAttribute('nodeid') || '') : '';
                  if (id && id === nodeIdStr) {
                    alreadySelected = true;
                    break;
                  }
                }
              }
            }
            if (nodeIdStr && jm && jm.select_node && !alreadySelected) {
              try {
                clearLassoMarks();
                jm.select_node(nodeIdStr);
                selectedNode = jm.get_selected_node ? jm.get_selected_node() : selectedNode;
                setSingleSelectStatus(selectedNode);
              } catch (_) {}
            }
            showContextMenu(objCtxMenuEl, e.clientX, e.clientY);
          } else {
            clearLassoMarks();
            clearMindmapSingleSelection();
            setStatus(t('ready'));
            showContextMenu(canvasCtxMenuEl, e.clientX, e.clientY);
          }
        });

        document.addEventListener('click', function () {
          hideContextMenus();
        });
        window.addEventListener('blur', function () {
          hideContextMenus();
        });
        window.addEventListener('resize', function () {
          hideContextMenus();
        });

        bindByIdClick('ctxCopyNode', function () {
          copyMindNodeSelection();
          hideContextMenus();
        });
        bindByIdClick('ctxCutNode', function () {
          cutMindNodeSelection();
          hideContextMenus();
        });
        bindByIdClick('ctxPasteNode', function () {
          hideContextMenus();
          const parent =
            getActiveSelectedNode() || (jm && jm.get_root ? jm.get_root() : null);
          pasteMindFromReadText(parent);
        });
        bindByIdClick('ctxPromoteNode', function () {
          promoteNode();
          hideContextMenus();
        });
        bindByIdClick('ctxDemoteNode', function () {
          demoteNode();
          hideContextMenus();
        });
        bindByIdClick('ctxPasteCanvas', function () {
          hideContextMenus();
          if (!jm || !jm.get_root) {
            return;
          }
          pasteMindFromReadText(jm.get_root());
        });
        bindByIdClick('ctxAddChild', function () {
          addChild();
          hideContextMenus();
        });
        bindByIdClick('ctxAddSibling', function () {
          addSibling();
          hideContextMenus();
        });
        bindByIdClick('ctxDeleteNode', function () {
          deleteNode();
          hideContextMenus();
        });
        bindByIdClick('ctxCenterRoot', function () {
          centerRoot();
          hideContextMenus();
        });
        bindByIdClick('ctxFitAll', function () {
          fitAll();
          hideContextMenus();
        });
        bindByIdClick('ctxResetZoom', function () {
          resetZoom();
          hideContextMenus();
        });

        elOn(canvasZoomValueEl, 'dblclick', function (e) {
          e.stopPropagation();
          resetZoom();
        });
        elOn(document.getElementById('canvasZoomFit'), 'click', function (e) {
          e.stopPropagation();
          fitAll();
        });
        elOn(document.getElementById('canvasZoomCenterRoot'), 'click', function (e) {
          e.stopPropagation();
          centerRoot();
        });
        elOn(document.getElementById('canvasZoomReset'), 'click', function (e) {
          e.stopPropagation();
          resetZoom();
        });
        elOn(document.getElementById('canvasZoomOut'), 'click', function (e) {
          e.stopPropagation();
          zoomByStep(-0.1);
        });
        elOn(document.getElementById('canvasZoomIn'), 'click', function (e) {
          e.stopPropagation();
          zoomByStep(0.1);
        });

        if (statusbarEl) {
          statusbarEl.addEventListener('click', function (e) {
            const t = e.target;
            if (t && t.closest && t.closest('#statusbarSaveLight')) {
              return;
            }
            showLogDialog();
          });
        }
        bindByIdClick('logCopyBtn', function () {
          copyLogToClipboard();
        });
        bindByIdClick('logCloseBtn', function () {
          hideLogDialog();
        });
        bindByIdClick('menuOpenLog', function () {
          showLogDialog();
        });
        bindByIdClick('menuSupportedFormats', function () {
          showSupportedFormatsDialog();
        });
        (function bindShortcutHintsHoverAria() {
          const wrap = document.getElementById('canvasShortcutHints');
          const trig = document.getElementById('canvasShortcutHintsTrigger');
          const body = document.getElementById('canvasShortcutHintsBody');
          if (!wrap || !trig || !body) return;
          function setOpen(open) {
            trig.setAttribute('aria-expanded', open ? 'true' : 'false');
            body.setAttribute('aria-hidden', open ? 'false' : 'true');
          }
          wrap.addEventListener('mouseenter', function () {
            setOpen(true);
          });
          wrap.addEventListener('mouseleave', function () {
            setOpen(false);
          });
          wrap.addEventListener('focusin', function () {
            setOpen(true);
          });
          wrap.addEventListener('focusout', function (e) {
            const rt = e.relatedTarget;
            if (!(rt instanceof Node) || !wrap.contains(rt)) {
              setOpen(false);
            }
          });
        })();
        if (logDialogEl) {
          logDialogEl.addEventListener('click', function (e) {
            if (e.target === logDialogEl) {
              hideLogDialog();
            }
          });
        }
        document.addEventListener(
          'keydown',
          function (e) {
            if (e.key !== 'Escape') {
              return;
            }
            if (logDialogEl && !logDialogEl.classList.contains('hidden')) {
              hideLogDialog();
              e.preventDefault();
            }
          },
          true
        );

        const menubarEl = document.querySelector('.menubar');
        const menuDetails = menubarEl ? Array.from(menubarEl.querySelectorAll('details')) : [];
        function closeAllMenus(exceptEl) {
          for (const d of menuDetails) {
            if (exceptEl && d === exceptEl) {
              continue;
            }
            d.open = false;
          }
        }

        // Top menu bar actions.
        bindByIdClick('menuNew', function () {
          setStatus(currentLang === 'zh' ? '正在新建脑图...' : 'Creating new mindmap...');
          vscode.postMessage({ type: 'mindmap:requestNew' });
        });
        bindByIdClick('menuOpen', function () {
          setStatus(currentLang === 'zh' ? '正在打开脑图...' : 'Opening mindmap...');
          vscode.postMessage({ type: 'mindmap:requestOpen' });
        });
        bindByIdClick('menuSave', function (e) {
          e.preventDefault();
          e.stopPropagation();
          doSave();
        });
        bindByIdClick('menuSaveAs', function (e) {
          e.preventDefault();
          e.stopPropagation();
          try {
            setStatus(currentLang === 'zh' ? '正在另存为...' : 'Saving as...');
            vscode.postMessage({ type: 'mindmap:requestSaveAs', tree: getTreeForFileOps() });
          } catch (err) {
            const msg = err && err.message ? err.message : String(err);
            notifyInvalidAction((currentLang === 'zh' ? '另存为失败：' : 'Save As failed: ') + msg);
          }
        });
        bindByIdClick('menuCopy', function () {
          copyMindNodeSelection();
        });
        bindByIdClick('menuCut', function () {
          cutMindNodeSelection();
        });
        bindByIdClick('menuPaste', function () {
          const parent =
            getActiveSelectedNode() || (jm && jm.get_root ? jm.get_root() : null);
          pasteMindFromReadText(parent);
        });
        bindByIdClick('menuPromote', function () {
          promoteNode();
        });
        bindByIdClick('menuDemote', function () {
          demoteNode();
        });
        bindByIdClick('menuExpand', expandSelected);
        bindByIdClick('menuCollapse', collapseSelected);
        bindByIdClick('menuToggle', toggleSelected);
        bindByIdClick('menuExpandAll', expandAll);
        bindByIdClick('menuInsertImage', function () {
          insertEmbedChild('image');
        });
        bindByIdClick('menuInsertText', function () {
          insertEmbedChild('text');
        });
        bindByIdClick('menuInsertWhiteboard', function () {
          insertEmbedChild('whiteboard');
        });
        bindByIdClick('menuInsertVideo', function () {
          insertEmbedChild('video');
        });
        bindByIdClick('menuInsertAudio', function () {
          insertEmbedChild('audio');
        });
        bindByIdClick('menuInsertGltf', function () {
          insertEmbedChild('gltf');
        });
        bindByIdClick('menuInsertTable', function () {
          insertEmbedChild('table');
        });
        function applyTheme(name) {
          const themeName = (name || '').toString().trim().toLowerCase();
          if (!themeName) return;
          if (!supportedThemes.includes(themeName)) {
            notifyInvalidAction(t('invalidTheme') + themeName);
            return;
          }
          currentTheme = themeName;
          if (jm && jm.set_theme) jm.set_theme(currentTheme);
          try {
            localStorage.setItem('mindmapJsmindTheme', currentTheme);
          } catch (e) {}
          refreshJsmindThemeDockHighlight();
          setStatus((currentLang === 'zh' ? '脑图主题：' : 'Mind map theme: ') + currentTheme);
        }
        bindByIdClick('menuLangZh', function () {
          applyLanguage('zh');
          vscode.postMessage({ type: 'mindmap:setUiLanguage', language: 'zh' });
        });
        bindByIdClick('menuLangEn', function () {
          applyLanguage('en');
          vscode.postMessage({ type: 'mindmap:setUiLanguage', language: 'en' });
        });
        bindByIdClick('menuUiThemeSystem', function () {
          applyUiThemeMode('system');
        });
        bindByIdClick('menuUiThemeLight', function () {
          applyUiThemeMode('light');
        });
        bindByIdClick('menuUiThemeDark', function () {
          applyUiThemeMode('dark');
        });
        bindByIdClick('menuToggleDock', function () {
          vscode.postMessage({ type: 'mindmap:requestToggleDock' });
        });
        bindByIdClick('btnTitleFullScreen', function () {
          vscode.postMessage({ type: 'mindmap:requestToggleFullScreen' });
        });

        // Windows-like menubar behavior:
        // - Close after choosing a menu item.
        // - Close when mouse leaves menubar.
        // - When one menu is open, hover another summary to switch.

        // Clicking any enabled menu item closes all menus.
        const allMenuBtns = menubarEl ? menubarEl.querySelectorAll('.menuItems button:not([disabled])') : [];
        for (const btn of allMenuBtns) {
          btn.addEventListener('click', function () {
            closeAllMenus();
          });
        }

        if (menubarEl) {
          menubarEl.addEventListener('mouseleave', function (ev) {
            const next = ev.relatedTarget;
            if (next instanceof Node && menubarEl.contains(next)) {
              return;
            }
            closeAllMenus();
          });
        }

        // Click outside menubar => close menus.
        document.addEventListener('click', function (ev) {
          if (!menubarEl) return;
          const target = ev.target;
          if (target instanceof Node && !menubarEl.contains(target)) {
            closeAllMenus();
          }
        });

        // Open one menu at a time and allow hover-switch when one is open.
        for (const d of menuDetails) {
          d.addEventListener('toggle', function () {
            if (d.open) closeAllMenus(d);
          });
          const summary = d.querySelector('summary');
          if (summary) {
            summary.addEventListener('mouseenter', function () {
              const hasOpen = menuDetails.some((x) => x.open);
              if (hasOpen && !d.open) {
                closeAllMenus(d);
                d.open = true;
              }
            });
          }
        }

        window.addEventListener('message', function (event) {
          const msg = event.data;
          if (!msg) return;
          if (msg.type === 'mindmap:saveTrafficLight') {
            applySaveTrafficLight(msg.light);
            return;
          }
          if (msg.type === 'mindmap:savedOk') {
            setContentClean();
            return;
          }
          if (msg.type === 'mindmap:forceClean') {
            setContentClean();
            vscode.postMessage({ type: 'mindmap:forceCleanAck' });
            return;
          }
          if (msg.type === 'mindmap:showMcpPersistNotice') {
            showMcpPersistNoticeDialog(msg.title, msg.message, msg.requestId);
            return;
          }
          if (msg.type === 'mindmap:setTree') {
            applyLanguage(msg.uiLanguage === 'zh' ? 'zh' : 'en');
            init(msg.tree, msg.ext);
            return;
          }
          if (msg.type === 'mindmap:hostGetTree') {
            try {
              const result = executeHostOp({ action: 'getTree' }, false);
              postHostResponse(msg.requestId, true, result.tree, null);
            } catch (e) {
              const err = e && e.message ? e.message : String(e);
              postHostResponse(msg.requestId, false, null, err);
            }
            return;
          }
          if (msg.type === 'mindmap:hostAddNode') {
            try {
              const result = executeHostOp({
                action: 'add',
                parentId: msg.parentId,
                topic: msg.topic,
                nodeId: msg.nodeId
              }, false);
              markContentDirty();
              postHostResponse(msg.requestId, true, result, null);
            } catch (e) {
              const err = e && e.message ? e.message : String(e);
              postHostResponse(msg.requestId, false, null, err);
            }
            return;
          }
          if (msg.type === 'mindmap:hostUpdateNodeTitle') {
            try {
              const result = executeHostOp({
                action: 'update',
                nodeId: msg.nodeId,
                topic: msg.topic
              }, false);
              markContentDirty();
              postHostResponse(msg.requestId, true, result, null);
            } catch (e) {
              const err = e && e.message ? e.message : String(e);
              postHostResponse(msg.requestId, false, null, err);
            }
            return;
          }
          if (msg.type === 'mindmap:hostDeleteNode') {
            try {
              const result = executeHostOp({
                action: 'delete',
                nodeId: msg.nodeId
              }, false);
              markContentDirty();
              postHostResponse(msg.requestId, true, result, null);
            } catch (e) {
              const err = e && e.message ? e.message : String(e);
              postHostResponse(msg.requestId, false, null, err);
            }
            return;
          }
          if (msg.type === 'mindmap:hostGetSelection') {
            try {
              const result = executeHostOp({ action: 'getSelection' }, false);
              postHostResponse(msg.requestId, true, result.selection, null);
            } catch (e) {
              const err = e && e.message ? e.message : String(e);
              postHostResponse(msg.requestId, false, null, err);
            }
            return;
          }
          if (msg.type === 'mindmap:hostApplyOps') {
            const ops = Array.isArray(msg.ops) ? msg.ops : [];
            const dryRun = !!msg.dryRun;
            const transaction = !!msg.transaction;
            const strict = !!msg.strict;
            const needRollback = transaction && !dryRun;
            const beforeTree = needRollback ? getTreeFromMind() : null;
            function strictDetail(failedIndex, partialResults) {
              if (!strict) return {};
              return {
                failedIndex: failedIndex,
                failedOp: ops[failedIndex],
                partialResults: partialResults.slice()
              };
            }
            try {
              const results = [];
              let batchMutated = false;
              for (let i = 0; i < ops.length; i++) {
                try {
                  const op = ops[i];
                  results.push(executeHostOp(op, dryRun));
                  if (!dryRun) {
                    const a = String(op.action || '').trim().toLowerCase();
                    if (a === 'add' || a === 'update' || a === 'delete' || a === 'move') {
                      batchMutated = true;
                      if (!transaction) {
                        markContentDirty();
                      }
                    }
                  }
                } catch (stepErr) {
                  const err = stepErr && stepErr.message ? stepErr.message : String(stepErr);
                  const detail = strictDetail(i, results);
                  if (needRollback && beforeTree) {
                    try {
                      const restoredMindData = makeMindData(beforeTree);
                      installMindmapRootAtContentOrigin();
                      jm.show(restoredMindData, true);
                      resetMindInnerPanelScroll();
                      ensureVirtualCanvasSize();
                      applyViewTransform();
                      centerRoot();
                      selectedNode = null;
                      postHostResponse(
                        msg.requestId,
                        false,
                        Object.assign(
                          { dryRun, transaction, strict, rolledBack: true },
                          detail
                        ),
                        err
                      );
                    } catch (rbErr) {
                      const rbMsg = rbErr && rbErr.message ? rbErr.message : String(rbErr);
                      postHostResponse(
                        msg.requestId,
                        false,
                        Object.assign(
                          { dryRun, transaction, strict, rolledBack: false },
                          detail
                        ),
                        err + '; rollback failed: ' + rbMsg
                      );
                    }
                  } else {
                    postHostResponse(
                      msg.requestId,
                      false,
                      Object.assign({ dryRun, transaction, strict }, detail),
                      err
                    );
                  }
                  return;
                }
              }
              if (!dryRun && transaction && batchMutated) {
                markContentDirty();
              }
              postHostResponse(
                msg.requestId,
                true,
                { dryRun, transaction, strict, results },
                null
              );
            } catch (e) {
              const err = e && e.message ? e.message : String(e);
              if (needRollback && beforeTree) {
                try {
                  const restoredMindData = makeMindData(beforeTree);
                  installMindmapRootAtContentOrigin();
                  jm.show(restoredMindData, true);
                  resetMindInnerPanelScroll();
                  ensureVirtualCanvasSize();
                  applyViewTransform();
                  centerRoot();
                  selectedNode = null;
                  postHostResponse(
                    msg.requestId,
                    false,
                    { dryRun, transaction, strict, rolledBack: true },
                    err
                  );
                } catch (rbErr) {
                  const rbMsg = rbErr && rbErr.message ? rbErr.message : String(rbErr);
                  postHostResponse(
                    msg.requestId,
                    false,
                    { dryRun, transaction, strict, rolledBack: false },
                    err + '; rollback failed: ' + rbMsg
                  );
                }
              } else {
                postHostResponse(msg.requestId, false, { dryRun, transaction, strict }, err);
              }
            }
            return;
          }
        });

        function installBrowserMindmapHost() {
          if (!window.__MINDMAP_BROWSER_FILE_OPS__) {
            return;
          }
          var saveHandle = null;
          var suggestedSaveName = 'mindmap.mmd';

          function coreOk() {
            return (
              window.MindmapCore &&
              typeof window.MindmapCore.parseCoreMindmapText === 'function' &&
              typeof window.MindmapCore.serializeCoreMindmapTree === 'function'
            );
          }

          function browserConfirmDiscardSync() {
            if (!contentDirty) {
              return true;
            }
            return window.confirm(
              currentLang === 'zh'
                ? '当前有未保存的更改，确定要继续吗？'
                : 'You have unsaved changes. Continue?'
            );
          }

          async function browserSaveTree(tree, forcePicker) {
            var C = window.MindmapCore;
            if (!C || !tree || !tree.root) {
              notifyInvalidAction(
                currentLang === 'zh' ? '无法保存：数据无效。' : 'Cannot save: invalid data.'
              );
              return;
            }
            var ext = window.__mindmapBrowserDocExt === 'jm' ? 'jm' : 'mmd';
            if (!forcePicker && saveHandle && saveHandle.createWritable) {
              try {
                var text0 = C.serializeCoreMindmapTree(tree, ext);
                var w = await saveHandle.createWritable();
                await w.write(text0);
                await w.close();
                setContentClean();
                setStatus(currentLang === 'zh' ? '已保存' : 'Saved');
                return;
              } catch (_) {
                saveHandle = null;
              }
            }
            if (typeof window.showSaveFilePicker === 'function') {
              try {
                var pick = await window.showSaveFilePicker({
                  suggestedName: suggestedSaveName || 'mindmap.' + ext,
                  types: [
                    {
                      description: 'Mindmap',
                      accept: {
                        'text/plain': ['.mmd'],
                        'application/json': ['.jm']
                      }
                    }
                  ]
                });
                saveHandle = pick;
                var pickedName = pick.name || '';
                ext = pickedName.toLowerCase().endsWith('.jm') ? 'jm' : 'mmd';
                try {
                  window.__mindmapBrowserDocExt = ext;
                } catch (_) {}
                suggestedSaveName = pickedName || 'mindmap.' + ext;
                var text1 = C.serializeCoreMindmapTree(tree, ext);
                var writable = await pick.createWritable();
                await writable.write(text1);
                await writable.close();
                setContentClean();
                setStatus(currentLang === 'zh' ? '已保存' : 'Saved');
                return;
              } catch (e) {
                if (e && e.name === 'AbortError') {
                  return;
                }
                saveHandle = null;
              }
            }
            var ext2 = window.__mindmapBrowserDocExt === 'jm' ? 'jm' : 'mmd';
            var textDl = C.serializeCoreMindmapTree(tree, ext2);
            var blob = new Blob([textDl], { type: 'text/plain;charset=utf-8' });
            var a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = suggestedSaveName || 'mindmap.' + ext2;
            a.click();
            URL.revokeObjectURL(a.href);
            setContentClean();
            setStatus(currentLang === 'zh' ? '已触发下载' : 'Download started');
          }

          function dispatch(msg) {
            if (!msg || typeof msg.type !== 'string') {
              return false;
            }
            var ty = msg.type;
            if (ty === 'mindmap:setUiLanguage') {
              applyLanguage(msg.language === 'zh' ? 'zh' : 'en');
              return true;
            }
            if (
              ty === 'mindmap:requestNew' ||
              ty === 'mindmap:requestOpen' ||
              ty === 'mindmap:requestSave' ||
              ty === 'mindmap:requestSaveAs'
            ) {
              if (!coreOk()) {
                notifyInvalidAction(
                  currentLang === 'zh'
                    ? '未加载 mindmap-core.js，无法使用文件功能。'
                    : 'mindmap-core.js is not loaded; file actions are unavailable.'
                );
                return true;
              }
            }
            if (ty === 'mindmap:requestNew') {
              if (!browserConfirmDiscardSync()) {
                return true;
              }
              saveHandle = null;
              suggestedSaveName = 'mindmap.mmd';
              try {
                window.__mindmapBrowserDocExt = 'mmd';
              } catch (_) {}
              suppressDirty = true;
              try {
                init(createBlankBootTree(), 'mmd');
                setContentClean();
                setStatus(currentLang === 'zh' ? '已新建' : 'New mindmap');
              } finally {
                suppressDirty = false;
              }
              return true;
            }
            if (ty === 'mindmap:requestOpen') {
              if (!browserConfirmDiscardSync()) {
                return true;
              }
              var input = document.createElement('input');
              input.type = 'file';
              input.accept = '.mmd,.jm,.xmind';
              input.onchange = function () {
                var f = input.files && input.files[0];
                if (!f) {
                  return;
                }
                var extFile = (f.name.split('.').pop() || '').toLowerCase();
                if (extFile === 'xmind') {
                  notifyInvalidAction(
                    currentLang === 'zh'
                      ? '浏览器预览暂不支持打开 .xmind，请使用 VS Code 扩展。'
                      : 'Opening .xmind is not supported in browser preview; use the VS Code extension.'
                  );
                  return;
                }
                var reader = new FileReader();
                reader.onload = function () {
                  var text = String(reader.result || '');
                  var parseExt = extFile === 'jm' ? 'jm' : 'mmd';
                  try {
                    var treeOpen = window.MindmapCore.parseCoreMindmapText(text, parseExt);
                    saveHandle = null;
                    suggestedSaveName = f.name || 'mindmap.mmd';
                    suppressDirty = true;
                    init(treeOpen, parseExt);
                    suppressDirty = false;
                    setContentClean();
                    setStatus(currentLang === 'zh' ? '已打开' : 'Opened');
                  } catch (ex) {
                    var em = ex && ex.message ? ex.message : String(ex);
                    notifyInvalidAction((currentLang === 'zh' ? '打开失败：' : 'Open failed: ') + em);
                  }
                };
                reader.readAsText(f);
              };
              input.click();
              return true;
            }
            if (ty === 'mindmap:requestSave') {
              void browserSaveTree(msg.tree, false);
              return true;
            }
            if (ty === 'mindmap:requestSaveAs') {
              void browserSaveTree(msg.tree, true);
              return true;
            }
            if (ty === 'mindmap:requestToggleFullScreen') {
              try {
                var de = document.documentElement;
                if (document.fullscreenElement) {
                  void document.exitFullscreen();
                } else if (de && de.requestFullscreen) {
                  void de.requestFullscreen();
                }
              } catch (fsErr) {
                notifyInvalidAction(
                  currentLang === 'zh'
                    ? '无法进入全屏（浏览器限制或未允许）。'
                    : 'Cannot toggle fullscreen (blocked or not allowed).'
                );
              }
              return true;
            }
            return false;
          }

          window.__mindmapBrowserDispatch = dispatch;
        }

        installBrowserMindmapHost();

        if (
          typeof __MINDMAP_BOOT__ === 'object' &&
          __MINDMAP_BOOT__ !== null &&
          __MINDMAP_BOOT__.tree
        ) {
          try {
            applyLanguage(__MINDMAP_BOOT__.uiLanguage === 'zh' ? 'zh' : 'en');
            init(__MINDMAP_BOOT__.tree, __MINDMAP_BOOT__.ext);
          } catch (bootErr) {
            var bm = bootErr && bootErr.message ? bootErr.message : String(bootErr);
            try {
              notifyInvalidAction('Webview init failed: ' + bm);
            } catch (_) {
              try {
                window.alert('Mindmap webview init failed: ' + bm);
              } catch (__) {}
            }
          }
        }
      })();
