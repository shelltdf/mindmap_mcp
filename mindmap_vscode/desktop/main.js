const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { app, BrowserWindow, dialog, ipcMain, Menu } = require('electron');

const ROOT_DIR = path.resolve(__dirname, '..');
const DIST_CORE = path.join(ROOT_DIR, 'dist', 'shared', 'mindmapCore.js');
const PANEL_TS = path.join(ROOT_DIR, 'src', 'panel.ts');
const JSMIND_JS = path.join(ROOT_DIR, 'media', 'jsmind', 'jsmind.js');
const JSMIND_CSS = path.join(ROOT_DIR, 'media', 'jsmind', 'jsmind.css');
const MINDMAP_CORE_JS = path.join(ROOT_DIR, 'media', 'mindmap-core.js');
const WEBVIEW_THEME_INIT_JS = path.join(ROOT_DIR, 'media', 'webview-theme-init.js');
const WEBVIEW_APP_JS = path.join(ROOT_DIR, 'media', 'webview-app.js');
const ICON_PNG = path.join(ROOT_DIR, 'media', 'icon.png');

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
    uiLanguage: 'zh'
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
  const htmlPath = path.join(ROOT_DIR, 'out', 'desktop_runtime.html');
  fs.mkdirSync(path.dirname(htmlPath), { recursive: true });
  fs.writeFileSync(htmlPath, html, 'utf8');
  void mainWindow.loadFile(htmlPath);

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
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
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
    return;
  }

  if (msg.type === 'mindmap:requestNew') {
    currentFilePath = '';
    currentExt = 'mmd';
    sendHostMessage({ type: 'mindmap:setTree', tree: defaultTree(), ext: currentExt });
    sendHostMessage({ type: 'mindmap:savedOk' });
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
