const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { app, BrowserWindow, dialog, ipcMain, Menu, clipboard } = require('electron');
const { startMindmapMcpBridgeHttp } = require('./mcpBridge.js');

// 开发：main.js 在 desktop/，资源在上一级 mindmap_vscode/。
// 打包：electron-builder 不把 ../ 文件打进 app.asar；资源经 extraResources 放在 resources/mindmap-app/。
const ROOT_DIR = app.isPackaged
  ? path.join(process.resourcesPath, 'mindmap-app')
  : path.resolve(__dirname, '..');
const DIST_CORE = path.join(ROOT_DIR, 'dist', 'shared', 'mindmapCore.js');
const PANEL_TS = path.join(ROOT_DIR, 'src', 'panel.ts');
const JSMIND_JS = path.join(ROOT_DIR, 'media', 'jsmind', 'jsmind.js');
const JSMIND_CSS = path.join(ROOT_DIR, 'media', 'jsmind', 'jsmind.css');
const MINDMAP_CORE_JS = path.join(ROOT_DIR, 'media', 'mindmap-core.js');
const WEBVIEW_THEME_INIT_JS = path.join(ROOT_DIR, 'media', 'webview-theme-init.js');
const WEBVIEW_APP_JS = path.join(ROOT_DIR, 'media', 'webview-app.js');
const ICON_PNG = path.join(ROOT_DIR, 'media', 'icon.png');

function readPackageVersion() {
  try {
    const p = app.isPackaged
      ? path.join(ROOT_DIR, 'mindmap-extension-package.json')
      : path.join(ROOT_DIR, 'package.json');
    if (fs.existsSync(p)) {
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      const v = String(j.version || '').trim();
      if (v) return v;
    }
  } catch (_) {}
  try {
    return String(app.getVersion() || '').trim();
  } catch (_) {
    return '';
  }
}

const APP_PACKAGE_VERSION = readPackageVersion();

function getCore() {
  try {
    // eslint-disable-next-line import/no-dynamic-require, global-require
    return require(DIST_CORE);
  } catch (e) {
    throw new Error(`Missing compiled shared core: ${DIST_CORE}. Run "npm run compile" first.`);
  }
}

function detectExt(filePath) {
  const ext = path.extname(filePath).toLowerCase().replace('.', '');
  if (ext === 'mmd' || ext === 'jm') return ext;
  throw new Error(`Unsupported file type: .${ext}. Only .mmd and .jm are supported in desktop mode.`);
}

function serializeByExt(tree, ext) {
  const core = getCore();
  return core.serializeCoreMindmapTree(tree, ext);
}

function parseByExt(text, ext) {
  const core = getCore();
  return core.parseCoreMindmapText(text, ext);
}

let mainWindow = null;
let currentFilePath = '';
let currentExt = 'mmd';

let hostReqSeq = 0;
/** @type {Map<string, { resolve: (v: unknown) => void, reject: (e: Error) => void, timer: NodeJS.Timeout }>} */
const pendingHostBridge = new Map();
/** @type {Map<string, () => void>} */
const pendingMcpNotice = new Map();
let mcpBridgeRef = null;

const BRIDGE_TOKEN_FILE = () => path.join(app.getPath('userData'), 'mindmap-desktop-mcp-token.txt');

function loadOrCreateBridgeToken() {
  try {
    const p = BRIDGE_TOKEN_FILE();
    if (fs.existsSync(p)) {
      const t = fs.readFileSync(p, 'utf8').trim();
      if (t) return t;
    }
  } catch (_) {}
  const gen = crypto.randomBytes(24).toString('hex');
  try {
    fs.writeFileSync(BRIDGE_TOKEN_FILE(), gen, 'utf8');
  } catch (_) {}
  return gen;
}

function getBridgeListenPort() {
  const n = Number(process.env.MINDMAP_DESKTOP_BRIDGE_PORT || process.env.MINDMAP_BRIDGE_PORT);
  return Number.isFinite(n) && n > 0 && n < 65536 ? Math.floor(n) : 58741;
}

function getMcpServerScriptPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'mindmap-app', 'mcp-server', 'dist', 'index.js');
  }
  return path.join(ROOT_DIR, 'mcp-server', 'dist', 'index.js');
}

function getContentDirtyFromWebview() {
  if (!mainWindow || mainWindow.isDestroyed()) return Promise.resolve(false);
  return mainWindow.webContents
    .executeJavaScript('Boolean(window.mmGetContentDirty && window.mmGetContentDirty())')
    .catch(() => false);
}

function focusMainWindowForMcpNotice() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
  } catch (_) {}
  try {
    mainWindow.show();
  } catch (_) {}
  try {
    mainWindow.focus();
  } catch (_) {}
}

function getBridgeUnavailableReason() {
  if (mcpBridgeRef && mcpBridgeRef.startupError) {
    const msg =
      mcpBridgeRef.startupError instanceof Error
        ? mcpBridgeRef.startupError.message
        : String(mcpBridgeRef.startupError);
    return msg.replace(/\s+/g, ' ').trim();
  }
  return '';
}

function requestWebview(type, extra = {}) {
  return new Promise((resolve, reject) => {
    const requestId = `host_${++hostReqSeq}`;
    const timer = setTimeout(() => {
      pendingHostBridge.delete(requestId);
      reject(new Error(`Webview request timed out: ${type}`));
    }, 10000);
    pendingHostBridge.set(requestId, { resolve, reject, timer });
    const msg = { type, requestId, ...extra };
    let payloadJson;
    try {
      payloadJson = JSON.stringify(msg);
    } catch (e) {
      clearTimeout(timer);
      pendingHostBridge.delete(requestId);
      reject(e instanceof Error ? e : new Error(String(e)));
      return;
    }
    const js = `window.dispatchEvent(new MessageEvent('message', { data: ${payloadJson} }));`;
    if (!mainWindow || mainWindow.isDestroyed()) {
      clearTimeout(timer);
      pendingHostBridge.delete(requestId);
      reject(new Error('Webview not available'));
      return;
    }
    void mainWindow.webContents.executeJavaScript(js).catch((err) => {
      clearTimeout(timer);
      pendingHostBridge.delete(requestId);
      reject(err instanceof Error ? err : new Error(String(err)));
    });
  });
}

async function autoSaveForMcpBridgeIfNeeded() {
  if (!currentFilePath) return;
  const dirty = await getContentDirtyFromWebview();
  if (!dirty) return;
  const tree = await requestWebview('mindmap:hostGetTree', {});
  const content = serializeByExt(tree, currentExt);
  fs.writeFileSync(currentFilePath, content, 'utf8');
  sendHostMessage({ type: 'mindmap:savedOk' });
}

async function showMcpPersistNoticeIfNeeded() {
  const noFile = !currentFilePath;
  const dirty = await getContentDirtyFromWebview();
  if (!noFile && !dirty) return;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  focusMainWindowForMcpNotice();
  const requestId = `mcp_notice_${++hostReqSeq}`;
  const title = 'MCP 提示';
  let message;
  if (noFile && dirty) {
    message =
      '当前为未命名脑图，且画布上有未保存到磁盘的修改。\n\nMCP 将读取/修改编辑器中的实时内容（尚未写入文件）。建议先使用「保存」或「另存为」落盘后再让自动化操作。';
  } else if (noFile) {
    message = '当前脑图尚未保存到任何文件路径。\n\nMCP 将针对编辑器中的内容操作。建议先「另存为」指定文件。';
  } else {
    message =
      '当前有未保存到磁盘的修改。\n\nMCP 会使用画布上的最新数据，但磁盘上的文件仍是旧版本。建议在执行 MCP 前保存。';
  }
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingMcpNotice.delete(requestId);
      resolve();
    }, 120000);
    pendingMcpNotice.set(requestId, () => {
      clearTimeout(timer);
      pendingMcpNotice.delete(requestId);
      resolve();
    });
    sendHostMessage({ type: 'mindmap:showMcpPersistNotice', requestId, title, message });
  });
}

function buildBridgeHost() {
  return {
    isAvailable: () => !!(mainWindow && !mainWindow.isDestroyed()),
    getActiveEditorId: () => 'mindmap-desktop',
    getInactiveEditorError: () =>
      'Mindmap Desktop window is not available. Open the app (or use the VS Code extension with an editor tab open).',
    getPanelTitle: () => {
      if (!mainWindow || mainWindow.isDestroyed()) return '';
      try {
        return mainWindow.getTitle() || 'MindmapDesktop';
      } catch {
        return 'MindmapDesktop';
      }
    },
    getBackingFilePath: () => (currentFilePath ? currentFilePath : null),
    getMindmapFormat: () => (currentExt ? currentExt : null),
    aiGetTree: () => requestWebview('mindmap:hostGetTree', {}),
    aiGetSelection: () => requestWebview('mindmap:hostGetSelection', {}),
    aiApplyOps: (ops, dryRun, transaction, strict) =>
      requestWebview('mindmap:hostApplyOps', { ops, dryRun, transaction, strict }),
    autoSaveForMcpBridgeIfNeeded,
    showMcpPersistNoticeIfNeeded
  };
}

function startDesktopMcpBridge() {
  const port = getBridgeListenPort();
  const token = loadOrCreateBridgeToken();
  mcpBridgeRef = startMindmapMcpBridgeHttp(
    port,
    token,
    buildBridgeHost,
    (err) => {
      void dialog.showErrorBox(
        'Mindmap MCP 桥接',
        `启动失败：${err.message}\n请先构建桌面所需共享产物后再重启应用。`
      );
    },
    (err) => {
      void dialog.showErrorBox(
        'Mindmap MCP 桥接',
        `监听失败（端口 ${port}）：${err.message}\n可设置环境变量 MINDMAP_BRIDGE_PORT 或 MINDMAP_DESKTOP_BRIDGE_PORT 为其他端口。`
      );
    },
    ROOT_DIR
  );
  if (mcpBridgeRef && mcpBridgeRef.startupError) {
    console.error(`[mindmap-desktop] MCP HTTP bridge disabled: ${mcpBridgeRef.startupError.message}`);
    return;
  }
  console.log(`[mindmap-desktop] MCP HTTP bridge: http://127.0.0.1:${port}/mcp-bridge/v1/call`);
}

async function copyMcpBridgeInfoToClipboard() {
  const listening = !!(mcpBridgeRef && mcpBridgeRef.listening);
  const port = mcpBridgeRef ? mcpBridgeRef.port : getBridgeListenPort();
  const token = loadOrCreateBridgeToken();
  const url = `http://127.0.0.1:${port}`;
  const script = getMcpServerScriptPath();
  const envBlock = `MINDMAP_BRIDGE_URL=${url}\nMINDMAP_BRIDGE_TOKEN=${token}`;
  const jsonHint = JSON.stringify(
    {
      command: 'node',
      args: [script],
      env: {
        MINDMAP_BRIDGE_URL: url,
        MINDMAP_BRIDGE_TOKEN: token
      }
    },
    null,
    2
  );
  const unavailableReason = getBridgeUnavailableReason();
  const warn = unavailableReason
    ? `# 警告：HTTP MCP 桥未成功启动。原因：${unavailableReason}\n\n`
    : '# 警告：HTTP MCP 桥当前未成功监听（例如端口被占用）。以下 URL/端口可能无效；请排除冲突后重启本应用再复制。\n\n';
  const body = `${envBlock}\n\n示例（Claude Desktop / mcp.json）：\n${jsonHint}`;
  clipboard.writeText(listening ? body : warn + body);
  if (!listening && mainWindow && !mainWindow.isDestroyed()) {
    const warningMessage = unavailableReason
      ? `HTTP MCP 桥未成功启动。\n\n原因：${unavailableReason}\n\n剪贴板内容已附带说明；修复后请重启应用再复制。`
      : 'HTTP MCP 桥可能未在监听（常见于端口冲突）。剪贴板内容已附带说明；请查看此前错误提示或更换 MINDMAP_BRIDGE_PORT / MINDMAP_DESKTOP_BRIDGE_PORT 后重启应用。';
    await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: 'MCP 桥未就绪',
      message: warningMessage,
      buttons: ['确定']
    });
  }
}

function defaultTree() {
  return {
    root: { id: 'root', topic: 'New Mindmap', children: [] }
  };
}

function webviewLikeUri(filePath) {
  return new URL(`file:///${filePath.replace(/\\/g, '/')}`).toString();
}

function extractPanelTemplate() {
  const src = fs.readFileSync(PANEL_TS, 'utf8');
  const startMarker = 'return /* html */ `<!DOCTYPE html>';
  const start = src.indexOf(startMarker);
  if (start < 0) throw new Error('Cannot find html template in panel.ts');
  const contentStart = start + 'return /* html */ `'.length;
  // panel.ts closes the template with `</html>` then optional `.replace(...)` — not `</html>`;`
  const endMarker = '</html>`';
  const endIdx = src.indexOf(endMarker, contentStart);
  if (endIdx < 0) throw new Error('Cannot find html template end in panel.ts');
  return src.slice(contentStart, endIdx + '</html>'.length);
}

function makeStandaloneHtml(bootTree, ext) {
  const nonce = crypto.randomBytes(8).toString('hex');
  const cspSource = 'file: data:';
  const bootJsonForHtml = JSON.stringify({
    tree: bootTree,
    ext: ext,
    uiLanguage: 'zh',
    extensionVersion: APP_PACKAGE_VERSION
  }).replace(/</g, '\\u003c');
  let tpl = extractPanelTemplate();
  tpl = tpl
    .replace(/\$\{cspSource\}/g, cspSource)
    .replace(/\$\{nonce\}/g, nonce)
    .replace(/\$\{mindmapCoreUrl\}/g, webviewLikeUri(MINDMAP_CORE_JS))
    .replace(/\$\{jsmindCssUrl\}/g, webviewLikeUri(JSMIND_CSS))
    .replace(/\$\{jsmindScriptUrl\}/g, webviewLikeUri(JSMIND_JS))
    .replace(/\$\{appTitleIconPngUrl\}/g, webviewLikeUri(ICON_PNG))
    .replace(/\$\{bootJsonForHtml\}/g, bootJsonForHtml)
    .replace(/___MM_SRC_WEBVIEW_THEME___/g, webviewLikeUri(WEBVIEW_THEME_INIT_JS))
    .replace(/___MM_SRC_WEBVIEW_APP___/g, webviewLikeUri(WEBVIEW_APP_JS));
  return tpl;
}

function sendHostMessage(msg) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const payload = JSON.stringify(msg);
  const js = `window.dispatchEvent(new MessageEvent('message', { data: ${payload} }));`;
  void mainWindow.webContents.executeJavaScript(js).catch(() => {});
}

/** 与 VS Code 扩展一致：页面内三色灯需知当前是否已关联磁盘路径 */
function pushHostFilePathToRenderer() {
  sendHostMessage({ type: 'mindmap:hostFilePath', path: currentFilePath || '' });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  // The app already has an in-page menu bar; keep native Electron menu hidden by default.
  mainWindow.setAutoHideMenuBar(true);
  mainWindow.setMenuBarVisibility(false);
  const html = makeStandaloneHtml(defaultTree(), 'mmd');
  // app.asar 内不可写；打包后把运行时 HTML 写到 userData。
  const htmlPath = app.isPackaged
    ? path.join(app.getPath('userData'), 'desktop_runtime.html')
    : path.join(ROOT_DIR, 'out', 'desktop_runtime.html');
  fs.mkdirSync(path.dirname(htmlPath), { recursive: true });
  fs.writeFileSync(htmlPath, html, 'utf8');
  void mainWindow.loadFile(htmlPath);
  mainWindow.webContents.once('did-finish-load', () => {
    pushHostFilePathToRenderer();
  });

  // Toggle native menu bar only when explicitly needed.
  // - Windows/Linux: Alt still reveals it temporarily (auto-hide behavior).
  // - Cross-platform fallback: Ctrl/Cmd+Shift+M toggles persistent visibility.
  mainWindow.webContents.on('before-input-event', (_event, input) => {
    const isToggleKey =
      input &&
      input.type === 'keyDown' &&
      input.shift &&
      input.control &&
      (input.key === 'M' || input.key === 'm');
    if (!isToggleKey) return;
    const next = !mainWindow.isMenuBarVisible();
    mainWindow.setAutoHideMenuBar(!next);
    mainWindow.setMenuBarVisibility(next);
  });

  /** 避免页面 beforeunload 拦截导致关闭无响应；脏文档时由主进程确认后再关 */
  let closeConfirmed = false;
  mainWindow.on('close', (e) => {
    if (closeConfirmed) return;
    e.preventDefault();
    void (async () => {
      let dirty = false;
      try {
        dirty = await mainWindow.webContents.executeJavaScript(
          'Boolean(window.mmGetContentDirty && window.mmGetContentDirty())'
        );
      } catch (_) {}
      if (!dirty) {
        closeConfirmed = true;
        mainWindow.close();
        return;
      }
      const { response } = await dialog.showMessageBox(mainWindow, {
        type: 'warning',
        buttons: ['取消', '仍要关闭'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
        title: 'Mindmap',
        message:
          '当前脑图有未保存的修改。关闭窗口将丢弃这些修改。\n\n请先使用「文件 → 保存」若需保留。'
      });
      if (response !== 1) return;
      closeConfirmed = true;
      mainWindow.close();
    })();
  });

  // Right-click on the top area to toggle native menu visibility.
  mainWindow.webContents.on('context-menu', (_event, params) => {
    // Approximate native titlebar area by Y range near the top edge.
    if (!params || typeof params.y !== 'number' || params.y > 36) return;
    const visible = mainWindow.isMenuBarVisible();
    const menu = Menu.buildFromTemplate([
      {
        label: visible ? '隐藏原生菜单栏' : '显示原生菜单栏',
        click: () => {
          const next = !mainWindow.isMenuBarVisible();
          mainWindow.setAutoHideMenuBar(!next);
          mainWindow.setMenuBarVisibility(next);
        }
      },
      { type: 'separator' },
      {
        label: '复制 MCP 连接信息（到剪贴板）',
        click: () => {
          void copyMcpBridgeInfoToClipboard();
        }
      }
    ]);
    menu.popup({ window: mainWindow });
  });

  // Force quit on window close in desktop mode (Windows/Linux),
  // avoiding lingering background process when launched from scripts.
  mainWindow.on('closed', () => {
    mainWindow = null;
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });
}

app.whenReady().then(() => {
  createWindow();
  startDesktopMcpBridge();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('will-quit', () => {
  if (mcpBridgeRef) {
    mcpBridgeRef.close();
    mcpBridgeRef = null;
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('mindmap:open', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: 'Mindmap', extensions: ['mmd', 'jm'] }]
  });
  if (res.canceled || !res.filePaths.length) return { canceled: true };
  const filePath = res.filePaths[0];
  const ext = detectExt(filePath);
  const text = fs.readFileSync(filePath, 'utf8');
  const tree = parseByExt(text, ext);
  return { canceled: false, filePath, ext, tree };
});

ipcMain.handle('mindmap:saveAs', async (_evt, payload) => {
  const tree = payload?.tree;
  const suggestedPath = payload?.suggestedPath || '';
  const extHint = payload?.ext === 'jm' ? 'jm' : 'mmd';
  const res = await dialog.showSaveDialog(mainWindow, {
    defaultPath: suggestedPath || `mindmap.${extHint}`,
    filters: [
      { name: 'Mermaid', extensions: ['mmd'] },
      { name: 'jsMind', extensions: ['jm'] }
    ]
  });
  if (res.canceled || !res.filePath) return { canceled: true };
  const filePath = res.filePath;
  const ext = detectExt(filePath);
  const content = serializeByExt(tree, ext);
  fs.writeFileSync(filePath, content, 'utf8');
  return { canceled: false, filePath, ext };
});

ipcMain.handle('mindmap:save', async (_evt, payload) => {
  const tree = payload?.tree;
  const filePath = payload?.filePath;
  if (!filePath) return { ok: false, reason: 'missing-file-path' };
  const ext = detectExt(filePath);
  const content = serializeByExt(tree, ext);
  fs.writeFileSync(filePath, content, 'utf8');
  return { ok: true, filePath, ext };
});

ipcMain.on('vscode:postMessage', async (_evt, msg) => {
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'mindmap:hostResponse') {
    const requestId = String(msg.requestId || '');
    const pending = pendingHostBridge.get(requestId);
    if (!pending) return;
    pendingHostBridge.delete(requestId);
    clearTimeout(pending.timer);
    if (msg.ok === false) {
      const err = new Error(String(msg.error || 'Unknown webview error'));
      if (msg.data !== null && msg.data !== undefined && typeof msg.data === 'object') {
        err.webviewData = msg.data;
      }
      pending.reject(err);
    } else {
      pending.resolve(msg.data);
    }
    return;
  }

  if (msg.type === 'mindmap:noticeAck') {
    const rid = String(msg.requestId || '');
    const fn = pendingMcpNotice.get(rid);
    if (fn) {
      pendingMcpNotice.delete(rid);
      fn();
    }
    return;
  }

  if (msg.type === 'mindmap:requestOpen') {
    const res = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: [{ name: 'Mindmap', extensions: ['mmd', 'jm'] }]
    });
    if (res.canceled || !res.filePaths.length) return;
    const filePath = res.filePaths[0];
    const ext = detectExt(filePath);
    const text = fs.readFileSync(filePath, 'utf8');
    const tree = parseByExt(text, ext);
    currentFilePath = filePath;
    currentExt = ext;
    sendHostMessage({ type: 'mindmap:setTree', tree, ext });
    sendHostMessage({ type: 'mindmap:savedOk' });
    pushHostFilePathToRenderer();
    return;
  }

  if (msg.type === 'mindmap:requestNew') {
    currentFilePath = '';
    currentExt = 'mmd';
    sendHostMessage({ type: 'mindmap:setTree', tree: defaultTree(), ext: currentExt });
    sendHostMessage({ type: 'mindmap:savedOk' });
    pushHostFilePathToRenderer();
    return;
  }

  if (msg.type === 'mindmap:requestSave') {
    const tree = msg.tree;
    if (!currentFilePath) {
      const res = await dialog.showSaveDialog(mainWindow, {
        defaultPath: `mindmap.${currentExt}`,
        filters: [
          { name: 'Mermaid', extensions: ['mmd'] },
          { name: 'jsMind', extensions: ['jm'] }
        ]
      });
      if (res.canceled || !res.filePath) return;
      currentFilePath = res.filePath;
      currentExt = detectExt(currentFilePath);
    }
    const text = serializeByExt(tree, currentExt);
    fs.writeFileSync(currentFilePath, text, 'utf8');
    sendHostMessage({ type: 'mindmap:savedOk' });
    pushHostFilePathToRenderer();
    return;
  }

  if (msg.type === 'mindmap:requestSaveAs') {
    const tree = msg.tree;
    const res = await dialog.showSaveDialog(mainWindow, {
      defaultPath: currentFilePath || `mindmap.${currentExt}`,
      filters: [
        { name: 'Mermaid', extensions: ['mmd'] },
        { name: 'jsMind', extensions: ['jm'] }
      ]
    });
    if (res.canceled || !res.filePath) return;
    currentFilePath = res.filePath;
    currentExt = detectExt(currentFilePath);
    const text = serializeByExt(tree, currentExt);
    fs.writeFileSync(currentFilePath, text, 'utf8');
    sendHostMessage({ type: 'mindmap:savedOk' });
    pushHostFilePathToRenderer();
    return;
  }

  if (msg.type === 'mindmap:requestToggleFullScreen') {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setFullScreen(!mainWindow.isFullScreen());
    }
    return;
  }

  if (msg.type === 'mindmap:requestToggleDock') {
    // Desktop mode has no VSCode dock concept; ignore.
    return;
  }
});
