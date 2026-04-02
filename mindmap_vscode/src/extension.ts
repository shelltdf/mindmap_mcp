import * as crypto from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';
import { startMindmapMcpBridge } from './bridge';
import {
  configureMindmapMcpForUserHome,
  configureMindmapMcpForWorkspace,
  diagnoseMindmapMcpSetup,
  maybeAutoConfigureCursorMcp
} from './mcpCursorConfig';
import { MindmapCustomTextEditorProvider } from './mindmapCustomTextEditor';
import { MINDMAP_CUSTOM_TEXT_EDITOR_VIEW_TYPE } from './mindmapEditorViewType';
import { MindmapPanel } from './panel';
import {
  MindmapExt,
  createBlankMindmapTree,
  parseMindmapText,
  parseMindmapXmindFile,
  serializeMindmapTree
} from './mindmap/model';

/** 部分宿主（如新版 VS Code）提供，早于 dispose/deactivate 展示关窗保存提示 */
type VscodeWorkspaceWithShutdown = typeof vscode.workspace & {
  onWillShutdown?: (
    listener: (e: { join: (thenable: Thenable<unknown>) => void }) => void
  ) => vscode.Disposable;
};

const MINDMAP_FILE_EXT = new Set(['.jm', '.mmd', '.xmind']);

function isUriLike(x: unknown): x is vscode.Uri {
  return (
    typeof x === 'object' &&
    x !== null &&
    typeof (x as vscode.Uri).fsPath === 'string' &&
    typeof (x as vscode.Uri).scheme === 'string'
  );
}

/** Explorer / Tree 右键传入的参数可能是 Uri，或带 resourceUri 的条目。 */
function uriFromExplorerArgs(...args: unknown[]): vscode.Uri | undefined {
  for (const a of args) {
    if (isUriLike(a)) return a;
    if (typeof a === 'object' && a !== null && 'resourceUri' in a) {
      const u = (a as { resourceUri?: unknown }).resourceUri;
      if (isUriLike(u)) return u;
    }
  }
  return undefined;
}

async function getBridgeToken(context: vscode.ExtensionContext, fromSettings: string): Promise<string> {
  const trimmed = fromSettings.trim();
  if (trimmed) return trimmed;
  const saved = context.globalState.get<string>('mindmapMcpBridge.token');
  if (saved) return saved;
  const gen = crypto.randomBytes(24).toString('hex');
  await context.globalState.update('mindmapMcpBridge.token', gen);
  return gen;
}

export async function activate(context: vscode.ExtensionContext) {
  // 勿在此处把 mindmapEditorHasUnsavedChanges 强行设为 false：会与 setExtensionContext 内
  // _syncGlobalDirtyContext 异步竞态，导致未保存状态错乱，进而影响 Webview/快捷键。
  MindmapPanel.setExtensionContext(context);
  void vscode.commands.executeCommand('setContext', 'mindmapActiveTabIsMindmap', false);

  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      MINDMAP_CUSTOM_TEXT_EDITOR_VIEW_TYPE,
      new MindmapCustomTextEditorProvider(context),
      {
        webviewOptions: {
          retainContextWhenHidden: true
        },
        supportsMultipleEditorsPerDocument: false
      }
    )
  );

  /** 保存前先合并画布→TextDocument，避免防抖未完成时落盘旧内容，保存后又被同步改脏 */
  context.subscriptions.push(
    vscode.workspace.onWillSaveTextDocument((e) => {
      if (!MindmapPanel.documentIsMindmapBuffer(e.document)) {
        return;
      }
      e.waitUntil(MindmapPanel.flushPendingWebviewEditsForDocument(e.document.uri));
    })
  );

  let dockFocused = false;
  let bridgeDisposable: vscode.Disposable | undefined;

  async function refreshMcpBridge() {
    bridgeDisposable?.dispose();
    bridgeDisposable = undefined;
    const cfg = vscode.workspace.getConfiguration('mindmap');
    if (!cfg.get<boolean>('mcpBridge.enable', true)) {
      return;
    }
    const port = cfg.get<number>('mcpBridge.port', 58741);
    const token = await getBridgeToken(context, cfg.get<string>('mcpBridge.token', '') || '');
    bridgeDisposable = startMindmapMcpBridge(port, token);
  }

  await refreshMcpBridge();
  context.subscriptions.push(
    new vscode.Disposable(() => {
      bridgeDisposable?.dispose();
      bridgeDisposable = undefined;
    })
  );
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('mindmap.mcpBridge')) {
        void refreshMcpBridge();
      }
    })
  );

  MindmapPanel.syncMindmapActiveTabContext();
  const workspaceShutdown = vscode.workspace as VscodeWorkspaceWithShutdown;
  if (typeof workspaceShutdown.onWillShutdown === 'function') {
    context.subscriptions.push(
      workspaceShutdown.onWillShutdown((e) => {
        e.join(
          (async () => {
            await MindmapPanel.flushAllPendingWebviewEditsToDocument();
            await MindmapPanel.persistAllDirtyStateBeforeShutdown();
            await MindmapPanel.onShutdownDeactivate();
          })()
        );
      })
    );
  }
  context.subscriptions.push(
    vscode.window.tabGroups.onDidChangeTabs(() => {
      MindmapPanel.syncMindmapActiveTabContext();
    })
  );
  context.subscriptions.push(
    vscode.window.tabGroups.onDidChangeTabGroups(() => {
      MindmapPanel.syncMindmapActiveTabContext();
    })
  );

  async function safeExec(command: string) {
    try {
      await vscode.commands.executeCommand(command);
    } catch {
      // Ignore: VS Code / Cursor may differ across versions.
    }
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('mindmapVscode.toggleWorkbenchFullScreen', async () => {
      await safeExec('workbench.action.toggleFullScreen');
    })
  );

  const toggleDockDisposable = vscode.commands.registerCommand('mindmapVscode.toggleDock', async () => {
    dockFocused = !dockFocused;
    if (dockFocused) {
      await safeExec('workbench.action.closeSidebar');
      await safeExec('workbench.action.closePanel');
      await safeExec('workbench.action.toggleAuxiliaryBar');
      await safeExec('workbench.action.toggleStatusbarVisibility');
    } else {
      await safeExec('workbench.action.toggleSidebarVisibility');
      await safeExec('workbench.action.togglePanel');
      await safeExec('workbench.action.toggleAuxiliaryBar');
      await safeExec('workbench.action.toggleStatusbarVisibility');
    }

    // After layout toggles, explicitly refocus the webview/editor area.
    await safeExec('workbench.action.focusActiveEditorGroup');
    MindmapPanel.currentPanel?.focus();
  });
  context.subscriptions.push(toggleDockDisposable);

  context.subscriptions.push(
    vscode.commands.registerCommand('mindmapVscode.closeMindmapEditor', async () => {
      await MindmapPanel.closeActiveWithSavePrompt();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('mindmapVscode.focusMindmapEditor', () => {
      MindmapPanel.currentPanel?.focus();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('mindmapVscode.quitWithUnsavedCheck', async () => {
      if (!(await MindmapPanel.confirmQuitWhenDirty())) {
        return;
      }
      await vscode.commands.executeCommand('workbench.action.quit');
    })
  );

  const disposable = vscode.commands.registerCommand(
    'mindmapVscode.openMindmapEditor',
    async (resource?: vscode.Uri) => {
      try {
        let filePath: string | undefined = resource?.fsPath;
        const doc = vscode.window.activeTextEditor?.document;
        if (!filePath) filePath = doc?.uri.fsPath;

        // If no file is opened, open a blank mindmap editor directly.
        if (!filePath) {
          const { panel } = MindmapPanel.createOrShow(context, undefined);
          await panel.setTree(createBlankMindmapTree(), 'mmd');
          return;
        }

        const rawExt = filePath.split('.').pop()?.toLowerCase() ?? '';
        let ext: MindmapExt;
        if (rawExt === 'mmd') ext = 'mmd';
        else if (rawExt === 'xmind') ext = 'xmind';
        else if (rawExt === 'jm') ext = 'jm';
        else {
          vscode.window.showErrorMessage(
            `不支持的脑图格式：.${rawExt}。建议使用 .mmd、.jm 或 .xmind。`
          );
          return;
        }

        if (ext === 'mmd' || ext === 'jm') {
          await vscode.commands.executeCommand(
            'vscode.openWith',
            vscode.Uri.file(filePath),
            MINDMAP_CUSTOM_TEXT_EDITOR_VIEW_TYPE
          );
          return;
        }

        let tree;
        try {
          tree = parseMindmapXmindFile(filePath);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          vscode.window.showErrorMessage(`解析失败：${msg}`);
          return;
        }

        const { panel, reused } = MindmapPanel.createOrShow(context, filePath);
        if (!reused) {
          await panel.setTree(tree, ext);
        } else {
          panel.focus();
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await vscode.window.showErrorMessage(`Mindmap: Open Mindmap Editor 失败：${msg}`);
      }
    }
  );

  context.subscriptions.push(disposable);

  async function createNewMindmapFile(): Promise<void> {
    const zh = vscode.env.language.toLowerCase().startsWith('zh');
    const wf = vscode.workspace.workspaceFolders;
    const defaultUri =
      wf && wf.length > 0 ? vscode.Uri.joinPath(wf[0].uri, 'mindmap.mmd') : undefined;

    const savePick = await vscode.window.showSaveDialog({
      defaultUri,
      saveLabel: zh ? '创建' : 'Create',
      filters: {
        'Mermaid mindmap (*.mmd)': ['mmd'],
        'jsMind JSON (*.jm)': ['jm']
      }
    });
    if (!savePick) {
      return;
    }

    const fp = savePick.fsPath;
    const rawExt = path.extname(fp).toLowerCase().replace(/^\./, '');
    let ext: MindmapExt;
    if (rawExt === 'mmd') {
      ext = 'mmd';
    } else if (rawExt === 'jm') {
      ext = 'jm';
    } else {
      await vscode.window.showErrorMessage(
        zh
          ? `请使用 .mmd 或 .jm 扩展名保存。当前：${rawExt ? '.' + rawExt : '（无扩展名）'}`
          : `Please save with a .mmd or .jm extension. Got: ${rawExt ? '.' + rawExt : '(none)'}`
      );
      return;
    }

    const uri = vscode.Uri.file(fp);
    let exists = false;
    try {
      await vscode.workspace.fs.stat(uri);
      exists = true;
    } catch {
      exists = false;
    }
    if (exists) {
      const overwriteLabel = zh ? '覆盖' : 'Overwrite';
      const cancelLabel = zh ? '取消' : 'Cancel';
      const ok = await vscode.window.showWarningMessage(
        zh
          ? `文件已存在，是否覆盖？\n${path.basename(fp)}`
          : `File already exists. Overwrite?\n${path.basename(fp)}`,
        { modal: true },
        overwriteLabel,
        cancelLabel
      );
      if (ok !== overwriteLabel) {
        return;
      }
    }

    try {
      const text = serializeMindmapTree(createBlankMindmapTree(), ext);
      const bytes = new TextEncoder().encode(text);
      await vscode.workspace.fs.writeFile(uri, bytes);
      await vscode.commands.executeCommand('vscode.openWith', uri, MINDMAP_CUSTOM_TEXT_EDITOR_VIEW_TYPE);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await vscode.window.showErrorMessage(zh ? `创建脑图文件失败：${msg}` : `Failed to create mindmap file: ${msg}`);
    }
  }

  const newMindmapFileDisposable = vscode.commands.registerCommand(
    'mindmapVscode.newMindmapFile',
    createNewMindmapFile
  );
  context.subscriptions.push(newMindmapFileDisposable);

  // Pencil（highagency.pencildev）为 Left + priority 100；本项用 99 紧挨在其右侧（priority 越大越靠左）
  const newMindmapStatusItem = vscode.window.createStatusBarItem(
    'mindmapVscode.statusBarNewFile',
    vscode.StatusBarAlignment.Left,
    99
  );
  newMindmapStatusItem.name = 'Mindmap';
  newMindmapStatusItem.command = 'mindmapVscode.newMindmapFile';

  /** 状态栏样式对齐 Pencil：prominent 底 + #DCBB00 金/黄字，暗色状态栏上可读 */
  function applyMindmapStatusBarAppearance(): void {
    const zh = vscode.env.language.toLowerCase().startsWith('zh');
    newMindmapStatusItem.text = zh ? '🧠 脑图' : '🧠 Mindmap';
    newMindmapStatusItem.tooltip = zh
      ? '新建脑图文件：选择路径、文件名与扩展名（.mmd / .jm）'
      : 'New mindmap file: choose path, filename, and extension (.mmd / .jm)';
    newMindmapStatusItem.backgroundColor = new vscode.ThemeColor('statusBarItem.prominentBackground');
    newMindmapStatusItem.color = '#DCBB00';
  }

  function refreshNewMindmapStatusVisibility(): void {
    const show = vscode.workspace.getConfiguration('mindmap').get<boolean>('statusBar.newMindmapButton', true);
    applyMindmapStatusBarAppearance();
    if (show) {
      newMindmapStatusItem.show();
    } else {
      newMindmapStatusItem.hide();
    }
  }

  refreshNewMindmapStatusVisibility();
  context.subscriptions.push(newMindmapStatusItem);
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('mindmap.statusBar')) {
        refreshNewMindmapStatusVisibility();
      }
    })
  );

  const openWithMindmapDisposable = vscode.commands.registerCommand(
    'mindmapVscode.openWithMindmap',
    async (...args: unknown[]) => {
      let resource = uriFromExplorerArgs(...args);
      if (!resource) {
        const doc = vscode.window.activeTextEditor?.document;
        const s = doc?.uri.scheme;
        if (doc && (s === 'file' || s === 'vscode-remote')) {
          resource = doc.uri;
        }
      }
      const fp = resource?.fsPath;
      if (!fp) {
        await vscode.window.showWarningMessage('未解析到文件路径：请在资源管理器中右键文件，或先打开该文件再使用命令。');
        return;
      }
      const ext = path.extname(fp).toLowerCase();
      if (!MINDMAP_FILE_EXT.has(ext)) {
        await vscode.window.showInformationMessage('Mindmap: Open with Mindmap Editor 仅支持 .jm / .mmd / .xmind 文件。');
        return;
      }
      await vscode.commands.executeCommand('mindmapVscode.openMindmapEditor', resource);
    }
  );
  context.subscriptions.push(openWithMindmapDisposable);

  const aiGetTreeDisposable = vscode.commands.registerCommand(
    'mindmapVscode.aiGetTree',
    async () => {
      const panel = MindmapPanel.currentPanel;
      if (!panel) throw new Error('Mindmap panel is not open.');
      return panel.aiGetTree();
    }
  );
  context.subscriptions.push(aiGetTreeDisposable);

  const aiAddNodeDisposable = vscode.commands.registerCommand(
    'mindmapVscode.aiAddNode',
    async (args?: { parentId?: string; topic?: string }) => {
      const panel = MindmapPanel.currentPanel;
      if (!panel) throw new Error('Mindmap panel is not open.');
      const parentId = String(args?.parentId || '').trim();
      const topic = String(args?.topic || '').trim();
      if (!parentId) throw new Error('parentId is required');
      if (!topic) throw new Error('topic is required');
      return panel.aiAddNode(parentId, topic);
    }
  );
  context.subscriptions.push(aiAddNodeDisposable);

  const aiUpdateNodeTitleDisposable = vscode.commands.registerCommand(
    'mindmapVscode.aiUpdateNodeTitle',
    async (args?: { nodeId?: string; topic?: string }) => {
      const panel = MindmapPanel.currentPanel;
      if (!panel) throw new Error('Mindmap panel is not open.');
      const nodeId = String(args?.nodeId || '').trim();
      const topic = String(args?.topic || '').trim();
      if (!nodeId) throw new Error('nodeId is required');
      if (!topic) throw new Error('topic is required');
      return panel.aiUpdateNodeTitle(nodeId, topic);
    }
  );
  context.subscriptions.push(aiUpdateNodeTitleDisposable);

  const aiDeleteNodeDisposable = vscode.commands.registerCommand(
    'mindmapVscode.aiDeleteNode',
    async (args?: { nodeId?: string }) => {
      const panel = MindmapPanel.currentPanel;
      if (!panel) throw new Error('Mindmap panel is not open.');
      const nodeId = String(args?.nodeId || '').trim();
      if (!nodeId) throw new Error('nodeId is required');
      return panel.aiDeleteNode(nodeId);
    }
  );
  context.subscriptions.push(aiDeleteNodeDisposable);

  const aiGetSelectionDisposable = vscode.commands.registerCommand(
    'mindmapVscode.aiGetSelection',
    async () => {
      const panel = MindmapPanel.currentPanel;
      if (!panel) throw new Error('Mindmap panel is not open.');
      return panel.aiGetSelection();
    }
  );
  context.subscriptions.push(aiGetSelectionDisposable);

  const aiApplyOpsDisposable = vscode.commands.registerCommand(
    'mindmapVscode.aiApplyOps',
    async (args?: { ops?: unknown[]; dryRun?: boolean; transaction?: boolean; strict?: boolean }) => {
      const panel = MindmapPanel.currentPanel;
      if (!panel) throw new Error('Mindmap panel is not open.');
      const ops = Array.isArray(args?.ops) ? args?.ops : [];
      const dryRun = !!args?.dryRun;
      const transaction = !!args?.transaction;
      const strict = !!args?.strict;
      return panel.aiApplyOps(ops, dryRun, transaction, strict);
    }
  );
  context.subscriptions.push(aiApplyOpsDisposable);

  const showMcpBridgeDisposable = vscode.commands.registerCommand('mindmapVscode.showMcpBridgeInfo', async () => {
    const cfg = vscode.workspace.getConfiguration('mindmap');
    const port = cfg.get<number>('mcpBridge.port', 58741);
    const fromSettings = (cfg.get<string>('mcpBridge.token', '') || '').trim();
    const token = await getBridgeToken(context, fromSettings);
    const url = `http://127.0.0.1:${port}`;
    const envBlock = `MINDMAP_BRIDGE_URL=${url}\nMINDMAP_BRIDGE_TOKEN=${token}`;
    await vscode.env.clipboard.writeText(envBlock);
    await vscode.window.showInformationMessage(
      `Mindmap MCP 桥接：${url} — 环境变量示例已复制到剪贴板（可粘贴到 Cursor MCP 配置 env）。`
    );
  });
  context.subscriptions.push(showMcpBridgeDisposable);

  const getTokenNow = () =>
    getBridgeToken(context, vscode.workspace.getConfiguration('mindmap').get<string>('mcpBridge.token', '') || '');

  const configureMcpWs = vscode.commands.registerCommand('mindmapVscode.configureCursorMcpWorkspace', async () => {
    await configureMindmapMcpForWorkspace(context, getTokenNow);
  });
  context.subscriptions.push(configureMcpWs);

  const configureMcpUser = vscode.commands.registerCommand('mindmapVscode.configureCursorMcpUser', async () => {
    await configureMindmapMcpForUserHome(context, getTokenNow);
  });
  context.subscriptions.push(configureMcpUser);

  const diagMcp = vscode.commands.registerCommand('mindmapVscode.diagnoseMcpSetup', async () => {
    const text = diagnoseMindmapMcpSetup(context);
    const doc = await vscode.workspace.openTextDocument({
      content: text,
      language: 'plaintext'
    });
    await vscode.window.showTextDocument(doc, { preview: true });
  });
  context.subscriptions.push(diagMcp);

  void maybeAutoConfigureCursorMcp(context, getTokenNow);

  void context.workspaceState.update('mindmap.companionUri', undefined);
}

export async function deactivate() {
  await MindmapPanel.flushAllPendingWebviewEditsToDocument();
  await MindmapPanel.persistAllDirtyStateBeforeShutdown();
  await MindmapPanel.onShutdownDeactivate();
}

