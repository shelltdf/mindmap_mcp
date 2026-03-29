import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';
import {
  MindmapTree,
  MindmapExt,
  parseMindmapText,
  parseMindmapXmindFile,
  serializeMindmapTree,
  writeMindmapXmindTitlesOnly
} from './mindmap/model';
import { MINDMAP_CUSTOM_TEXT_EDITOR_VIEW_TYPE } from './mindmapEditorViewType';

type FileExt = MindmapExt;

/** 已关闭或无法代为保存的脑图未保存记录（退出/退出前检查用） */
export type MindmapUnsavedQuitRec = { title: string; filePath: string | null };

export class MindmapPanel {
  public static currentPanel: MindmapPanel | undefined;

  private static readonly _instances = new Set<MindmapPanel>();

  /** 供 workspaceState 后备提示等使用 */
  private static _extensionContext: vscode.ExtensionContext | undefined;

  /**
   * 用户关闭 Mindmap 标签时若仍有未保存编辑，在此追加（同步），并写入 mindmap.closedUnsavedMindmaps。
   * 用于：先关脑图再关 IDE 时仍能提示（不依赖仍打开的 Webview 实例）。
   */
  private static _closedWithUnsaved: MindmapUnsavedQuitRec[] = [];

  public static setExtensionContext(context: vscode.ExtensionContext): void {
    MindmapPanel._extensionContext = context;
    MindmapPanel._shutdownDeactivatePromise = undefined;
    const stored = context.workspaceState.get<MindmapUnsavedQuitRec[]>('mindmap.closedUnsavedMindmaps') ?? [];
    MindmapPanel._closedWithUnsaved = MindmapPanel._dedupeQuitRecs(stored);
    void MindmapPanel._syncGlobalDirtyContext();
  }

  private static _dedupeQuitRecs(recs: MindmapUnsavedQuitRec[]): MindmapUnsavedQuitRec[] {
    const seen = new Set<string>();
    const out: MindmapUnsavedQuitRec[] = [];
    for (const r of recs) {
      if (!r || typeof r.title !== 'string' || r.title.length === 0) {
        continue;
      }
      const k = `${r.filePath ?? ''}\u0000${r.title}`;
      if (seen.has(k)) {
        continue;
      }
      seen.add(k);
      out.push({ title: r.title, filePath: r.filePath ?? null });
    }
    return out;
  }

  /** 合并内存、已关闭列表与 legacy 的 open-dirty 快照（去重） */
  private static _allStaleQuitRecords(): MindmapUnsavedQuitRec[] {
    const ctx = MindmapPanel._extensionContext;
    const a = MindmapPanel._closedWithUnsaved;
    const b = ctx?.workspaceState.get<MindmapUnsavedQuitRec[]>('mindmap.closedUnsavedMindmaps') ?? [];
    const c = ctx?.workspaceState.get<MindmapUnsavedQuitRec[]>('mindmap.dirtyMindmapAtLastSync') ?? [];
    return MindmapPanel._dedupeQuitRecs([...a, ...b, ...c]);
  }

  private static async _flushClosedUnsavedToWorkspace(): Promise<void> {
    const ctx = MindmapPanel._extensionContext;
    if (!ctx) {
      return;
    }
    await ctx.workspaceState.update('mindmap.closedUnsavedMindmaps', MindmapPanel._closedWithUnsaved);
  }

  private static async _clearStaleQuitState(): Promise<void> {
    MindmapPanel._closedWithUnsaved = [];
    const ctx = MindmapPanel._extensionContext;
    if (!ctx) {
      return;
    }
    await ctx.workspaceState.update('mindmap.closedUnsavedMindmaps', []);
    await ctx.workspaceState.update('mindmap.dirtyMindmapAtLastSync', []);
  }

  /** 与 CustomTextEditor 绑定的文本缓冲区是否为脑图格式 */
  private static _isMindmapTextDocumentBuffer(doc: vscode.TextDocument): boolean {
    const key = (doc.fileName || doc.uri.fsPath || '').toLowerCase();
    return key.endsWith('.mmd') || key.endsWith('.jm');
  }

  /**
   * 仍有脏标记、但已无 MindmapPanel 绑定的脑图文档（关 Cursor 时常先 dispose 面板，再跑 deactivate）。
   */
  private static _orphanDirtyMindmapTextDocuments(): vscode.TextDocument[] {
    const out: vscode.TextDocument[] = [];
    for (const doc of vscode.workspace.textDocuments) {
      if (!doc.isDirty || !MindmapPanel._isMindmapTextDocumentBuffer(doc)) {
        continue;
      }
      let bound = false;
      for (const p of MindmapPanel._instances) {
        if (p._textDocument && p._textDocument.uri.toString() === doc.uri.toString()) {
          bound = true;
          break;
        }
      }
      if (!bound) {
        out.push(doc);
      }
    }
    return out;
  }

  private static _quitRecFromTextDocument(doc: vscode.TextDocument): MindmapUnsavedQuitRec {
    const fp = doc.uri.scheme === 'file' ? doc.uri.fsPath : null;
    const label =
      fp !== null
        ? vscode.workspace.asRelativePath(doc.uri)
        : path.basename(doc.uri.fsPath || doc.fileName || doc.uri.path) || doc.uri.toString();
    return { title: `Mindmap Editor - ${label}`, filePath: fp };
  }

  /** 孤儿文档「不保存」：磁盘文件回读；未命名则还原为空白树文本 */
  private static async _revertMindmapTextDocumentContent(doc: vscode.TextDocument): Promise<void> {
    if (!doc.isDirty) {
      return;
    }
    const cur = doc.getText();
    const range = new vscode.Range(new vscode.Position(0, 0), doc.positionAt(cur.length));
    if (doc.uri.scheme === 'file') {
      const bytes = await vscode.workspace.fs.readFile(doc.uri);
      const disk = new TextDecoder().decode(bytes);
      const edit = new vscode.WorkspaceEdit();
      edit.replace(doc.uri, range, disk);
      await vscode.workspace.applyEdit(edit);
      return;
    }
    if (doc.uri.scheme === 'untitled') {
      const lower = doc.fileName.toLowerCase();
      const ext: FileExt = lower.endsWith('.jm') ? 'jm' : 'mmd';
      const tree: MindmapTree = {
        root: { id: 'root', topic: 'New Mindmap', children: [] }
      };
      const text = serializeMindmapTree(tree, ext);
      const edit = new vscode.WorkspaceEdit();
      edit.replace(doc.uri, range, text);
      await vscode.workspace.applyEdit(edit);
    }
  }

  /** 防止 onWillShutdown 与 deactivate 并发各弹一次对话框 */
  private static _shutdownDeactivatePromise: Promise<void> | undefined;

  public static hasAnyDirtyMindmap(): boolean {
    for (const p of MindmapPanel._instances) {
      if (MindmapPanel._panelNeedsSaveOrPersistPrompt(p)) {
        return true;
      }
    }
    if (MindmapPanel._orphanDirtyMindmapTextDocuments().length > 0) {
      return true;
    }
    return MindmapPanel._allStaleQuitRecords().length > 0;
  }

  /**
   * 当前活动编辑器标签是否为 mindmap Webview（不依赖 iframe 内焦点）。
   * 用于 Ctrl+W / Ctrl+F4 等在「标签选中但焦点在侧栏」时仍能拦截关闭。
   */
  public static syncMindmapActiveTabContext(): void {
    const tab = vscode.window.tabGroups.activeTabGroup?.activeTab;
    const isMindmap =
      (!!tab?.input &&
        tab.input instanceof vscode.TabInputWebview &&
        tab.input.viewType === 'mindmapEditor') ||
      (!!tab?.input &&
        tab.input instanceof vscode.TabInputCustom &&
        tab.input.viewType === MINDMAP_CUSTOM_TEXT_EDITOR_VIEW_TYPE);
    void vscode.commands.executeCommand('setContext', 'mindmapActiveTabIsMindmap', isMindmap);
  }

  private readonly _panel: vscode.WebviewPanel;
  private readonly _disposables: vscode.Disposable[] = [];
  private _filePath: string | undefined;
  private _ext: FileExt | undefined;
  private _dockFocused = false;
  private _uiLanguage: 'zh' | 'en' = 'en';
  private readonly _extensionUri: vscode.Uri;
  private _titleBase = '';
  private _dirty = false;
  private _reqSeq = 0;
  private readonly _pendingHostRequests = new Map<
    string,
    { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();
  /** MCP 中央提示框：用户点击「确定」后 resolve */
  private readonly _pendingMcpNoticeAck = new Map<string, () => void>();

  /** 磁盘上该路径文件的上次已知 mtime（ms），用于检测被其他工具修改 */
  private _lastKnownDiskMtime: number | undefined;
  private _backingFileWatcher: vscode.Disposable | undefined;
  private _externalChangeDebounceTimer: NodeJS.Timeout | undefined;
  private _suppressExternalChangeCheckUntil = 0;
  private _externalChangePromptLock = false;

  /** Custom Text Editor：与 TextDocument 同步，工作台显示与 .txt 相同的脏状态与保存提示 */
  private _textDocument: vscode.TextDocument | undefined;
  /** 本扩展 applyEdit 写入文档时，忽略 onDidChangeTextDocument 回灌 */
  private _muteDocSync = false;
  private _documentExternalTimer: NodeJS.Timeout | undefined;
  private _pendingWebviewToDocTimer: NodeJS.Timeout | undefined;
  /**
   * CustomTextEditor：画布已改但尚未完成「webview → TextDocument」同步（防抖进行中或同步进行中）。
   * 否则仅看 document.isDirty 在关 IDE 瞬间会为 false，导致无保存提示。
   */
  private _pendingDocSyncFromWebview = false;

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
    this._panel = panel;
    this._extensionUri = extensionUri;
    this._uiLanguage = vscode.env.language.toLowerCase().startsWith('zh') ? 'zh' : 'en';
    this._panel.webview.onDidReceiveMessage(
      (msg) => this._handleMessage(msg),
      undefined,
      this._disposables
    );
    this._panel.onDidDispose(
      () => this.dispose(),
      null,
      this._disposables
    );
    this._panel.onDidChangeViewState(
      (e) => {
        if (e.webviewPanel.active) {
          MindmapPanel.currentPanel = this;
        }
        MindmapPanel.syncMindmapActiveTabContext();
        if (e.webviewPanel.visible) {
          void this._checkDiskWhenPanelVisibleThrottled();
        }
      },
      null,
      this._disposables
    );
  }

  private dispose() {
    if (this._documentExternalTimer) {
      clearTimeout(this._documentExternalTimer);
      this._documentExternalTimer = undefined;
    }
    if (this._pendingWebviewToDocTimer) {
      clearTimeout(this._pendingWebviewToDocTimer);
      this._pendingWebviewToDocTimer = undefined;
    }
    const pendingCustomDocSync =
      !!this._textDocument &&
      (this._pendingDocSyncFromWebview || this._pendingWebviewToDocTimer !== undefined);
    const needQuitRecord =
      this._textDocument?.isDirty === true ||
      (!this._textDocument && this._dirty) ||
      pendingCustomDocSync;
    if (needQuitRecord && MindmapPanel._extensionContext) {
      const rec: MindmapUnsavedQuitRec = {
        title: this.panelTitle,
        filePath: this.backingFilePath ?? null
      };
      MindmapPanel._closedWithUnsaved = MindmapPanel._dedupeQuitRecs([...MindmapPanel._closedWithUnsaved, rec]);
      void MindmapPanel._flushClosedUnsavedToWorkspace();
    }
    MindmapPanel._instances.delete(this);
    if (MindmapPanel.currentPanel === this) {
      const rest = [...MindmapPanel._instances];
      MindmapPanel.currentPanel = rest.length ? rest[rest.length - 1] : undefined;
    }
    for (const [, ack] of this._pendingMcpNoticeAck) {
      try {
        ack();
      } catch {
        // ignore
      }
    }
    this._pendingMcpNoticeAck.clear();
    if (this._externalChangeDebounceTimer) {
      clearTimeout(this._externalChangeDebounceTimer);
      this._externalChangeDebounceTimer = undefined;
    }
    this._disposeBackingFileWatcher();
    for (const [, pending] of this._pendingHostRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Mindmap panel disposed'));
    }
    this._pendingHostRequests.clear();
    MindmapPanel._syncGlobalDirtyContext();
    while (this._disposables.length) {
      const d = this._disposables.pop();
      try {
        d?.dispose();
      } catch {
        // ignore
      }
    }
  }

  /**
   * 打开或聚焦脑图面板。已存在同一路径的面板时只 `reveal`（`reused: true`），否则新建标签页。
   * 无路径（空白脑图）时总是新建，便于多开。
   */
  public static createOrShow(
    context: vscode.ExtensionContext,
    filePath?: string
  ): { panel: MindmapPanel; reused: boolean } {
    const column = vscode.window.activeTextEditor?.viewColumn;

    if (filePath) {
      const existing = MindmapPanel._findPanelForPath(filePath);
      if (existing) {
        existing._panel.reveal(column);
        MindmapPanel.currentPanel = existing;
        MindmapPanel.syncMindmapActiveTabContext();
        return { panel: existing, reused: true };
      }
    }

    const title = filePath ? vscode.workspace.asRelativePath(filePath) : 'Untitled Mindmap';
    const mediaRoot = vscode.Uri.joinPath(context.extensionUri, 'media');
    const panel = vscode.window.createWebviewPanel(
      'mindmapEditor',
      `Mindmap Editor - ${title}`,
      // Avoid opening in a right-side vertical split when there's no active editor.
      column ?? vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [mediaRoot]
      }
    );

    const instance = new MindmapPanel(panel, context.extensionUri);
    instance._filePath = filePath;
    MindmapPanel._instances.add(instance);
    MindmapPanel.currentPanel = instance;
    instance._syncTitleBase();
    instance._dirty = false;
    instance._applyTitle();
    MindmapPanel.syncMindmapActiveTabContext();
    return { panel: instance, reused: false };
  }

  /**
   * Custom Text Editor（.mmd / .jm）：与 {@link vscode.TextDocument} 绑定。
   * 脏状态、标签圆点、Ctrl+S 保存与 .txt 同源（工作台 TextDocument 流水线）。
   */
  public static async resolveCustomTextEditor(
    context: vscode.ExtensionContext,
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {
    const lower = document.fileName.toLowerCase();
    const ext: FileExt = lower.endsWith('.jm') ? 'jm' : 'mmd';
    const mediaRoot = vscode.Uri.joinPath(context.extensionUri, 'media');
    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [mediaRoot]
    };

    const instance = new MindmapPanel(webviewPanel, context.extensionUri);
    instance._textDocument = document;
    instance._filePath = document.uri.fsPath;
    instance._ext = ext;
    MindmapPanel._instances.add(instance);
    MindmapPanel.currentPanel = instance;
    instance._syncTitleBase();
    instance._dirty = false;
    instance._applyTitle();

    await instance._loadInitialDocumentFromDiskText();

    const subDoc = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document !== document) return;
      if (instance._muteDocSync) return;
      instance._schedulePushTreeFromDocument();
    });
    instance._disposables.push(subDoc);

    const subSave = vscode.workspace.onDidSaveTextDocument((doc) => {
      if (doc.uri.toString() !== document.uri.toString()) return;
      void instance._panel.webview.postMessage({ type: 'mindmap:savedOk' });
    });
    instance._disposables.push(subSave);
  }

  private static _pathsEqual(a: string, b: string): boolean {
    const na = path.normalize(a);
    const nb = path.normalize(b);
    if (process.platform === 'win32') {
      return na.toLowerCase() === nb.toLowerCase();
    }
    return na === nb;
  }

  private static _findPanelForPath(filePath: string): MindmapPanel | undefined {
    for (const p of MindmapPanel._instances) {
      if (p._filePath && MindmapPanel._pathsEqual(p._filePath, filePath)) {
        return p;
      }
    }
    return undefined;
  }

  public async setTree(tree: MindmapTree, ext: FileExt) {
    // 首次打开 / 注入默认树时面板尚未有用户内容，不应因「未落盘」弹保存（仅脏数据需确认）
    if (!(await this._confirmDiscardIfDirty({ includeNotPersistedAsRisk: false }))) {
      return;
    }
    await this._loadTreeIntoWebview(tree, ext);
  }

  private async _loadTreeIntoWebview(tree: MindmapTree, ext: FileExt) {
    await this._prepareWebviewHtmlReload();
    this._ext = ext;
    this._syncTitleBase();
    this._dirty = false;
    this._applyTitle();

    // 初始树必须随 HTML 注入：若在设置 html 后立即 postMessage(setTree)，
    // 往往在页面末尾才注册 window message 监听器，消息会丢失导致空白画布。
    const html = this._getHtmlForWebview(this._panel.webview, { tree, ext });
    if (this._shouldDumpWebviewHtml()) {
      try {
        const debugDir = path.join(this._extensionUri.fsPath, 'out');
        fs.mkdirSync(debugDir, { recursive: true });
        fs.writeFileSync(path.join(debugDir, 'last_webview_debug.html'), html, 'utf8');
      } catch {
        // Best-effort diagnostics only.
      }
    }
    this._panel.webview.html = html;
    void this._syncBackingFileWatcherAfterLoad();
  }

  private _shouldDumpWebviewHtml(): boolean {
    return vscode.workspace.getConfiguration('mindmap').get<boolean>('webview.dumpHtml', false);
  }

  private async _loadInitialDocumentFromDiskText(): Promise<void> {
    const text = this._textDocument!.getText();
    let tree: MindmapTree;
    if (!text.trim()) {
      tree = {
        root: { id: 'root', topic: 'New Mindmap', children: [] }
      };
    } else {
      try {
        tree = parseMindmapText(text, this._ext!);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await vscode.window.showErrorMessage(`脑图解析失败：${msg}`);
        tree = {
          root: { id: 'root', topic: 'New Mindmap', children: [] }
        };
      }
    }
    await this._loadTreeIntoWebview(tree, this._ext!);
  }

  private _schedulePushTreeFromDocument(): void {
    if (this._documentExternalTimer) clearTimeout(this._documentExternalTimer);
    this._documentExternalTimer = setTimeout(() => {
      this._documentExternalTimer = undefined;
      void this._pushTreeFromDocumentText();
    }, 120);
  }

  private async _pushTreeFromDocumentText(): Promise<void> {
    if (!this._textDocument || !this._ext) return;
    try {
      const docText = this._textDocument.getText();
      if (!docText.trim()) return;
      const tree = parseMindmapText(docText, this._ext);
      this._panel.webview.postMessage({
        type: 'mindmap:setTree',
        tree,
        ext: this._ext,
        uiLanguage: this._uiLanguage
      });
    } catch {
      // 撤销等过程中可能出现短暂不合法文本
    }
  }

  private _scheduleSyncDocumentFromWebview(): void {
    if (this._pendingWebviewToDocTimer) clearTimeout(this._pendingWebviewToDocTimer);
    this._pendingWebviewToDocTimer = setTimeout(() => {
      this._pendingWebviewToDocTimer = undefined;
      void this._syncDocumentFromWebview();
    }, 220);
  }

  private async _syncDocumentFromWebview(): Promise<void> {
    if (!this._textDocument || !this._ext) {
      this._pendingDocSyncFromWebview = false;
      return;
    }
    let clearPending = true;
    try {
      const tree = await this.aiGetTree();
      const text = serializeMindmapTree(tree, this._ext);
      const doc = this._textDocument;
      const cur = doc.getText();
      if (text === cur) {
        return;
      }
      this._muteDocSync = true;
      const edit = new vscode.WorkspaceEdit();
      const end = doc.positionAt(cur.length);
      edit.replace(doc.uri, new vscode.Range(new vscode.Position(0, 0), end), text);
      await vscode.workspace.applyEdit(edit);
      this._muteDocSync = false;
      this._dirty = false;
      this._applyTitle();
    } catch (e) {
      clearPending = false;
      this._muteDocSync = false;
      const msg = e instanceof Error ? e.message : String(e);
      await vscode.window.showErrorMessage(`同步到文档失败：${msg}`);
    } finally {
      if (clearPending) {
        this._pendingDocSyncFromWebview = false;
      }
    }
  }

  /** 将 TextDocument 内容恢复为磁盘版本（关闭标签「不保存」等） */
  private async _revertTextDocumentFromDisk(): Promise<void> {
    if (!this._textDocument?.isDirty) {
      return;
    }
    const uri = this._textDocument.uri;
    const bytes = await vscode.workspace.fs.readFile(uri);
    const disk = new TextDecoder().decode(bytes);
    const doc = this._textDocument;
    const cur = doc.getText();
    this._muteDocSync = true;
    const edit = new vscode.WorkspaceEdit();
    edit.replace(doc.uri, new vscode.Range(new vscode.Position(0, 0), doc.positionAt(cur.length)), disk);
    await vscode.workspace.applyEdit(edit);
    this._muteDocSync = false;
    this._dirty = false;
    this._applyTitle();
    void this._panel.webview.postMessage({ type: 'mindmap:savedOk' });
    await this._pushTreeFromDocumentText();
  }

  private _disposeBackingFileWatcher(): void {
    this._backingFileWatcher?.dispose();
    this._backingFileWatcher = undefined;
  }

  private _installBackingFileWatcherIfNeeded(): void {
    this._disposeBackingFileWatcher();
    if (!this._filePath) {
      return;
    }
    const dir = path.dirname(this._filePath);
    const base = path.basename(this._filePath);
    try {
      const folderUri = vscode.Uri.file(dir);
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folderUri, base));
      const d1 = watcher.onDidChange(() => this._scheduleExternalDiskChangeCheck());
      const d2 = watcher.onDidCreate(() => this._scheduleExternalDiskChangeCheck());
      this._backingFileWatcher = vscode.Disposable.from(watcher, d1, d2);
    } catch {
      // RelativePattern / watcher 在极少数路径下可能失败，仍依赖可见性轮询
    }
  }

  private _scheduleExternalDiskChangeCheck(): void {
    if (Date.now() < this._suppressExternalChangeCheckUntil) {
      return;
    }
    if (this._externalChangeDebounceTimer) {
      clearTimeout(this._externalChangeDebounceTimer);
    }
    this._externalChangeDebounceTimer = setTimeout(() => {
      this._externalChangeDebounceTimer = undefined;
      void this._checkExternalDiskChangedAndPrompt();
    }, 450);
  }

  private _lastVisibleDiskCheckAt = 0;

  private async _checkDiskWhenPanelVisibleThrottled(): Promise<void> {
    if (!this._filePath || !this._ext) {
      return;
    }
    const now = Date.now();
    if (now - this._lastVisibleDiskCheckAt < 1200) {
      return;
    }
    this._lastVisibleDiskCheckAt = now;
    this._scheduleExternalDiskChangeCheck();
  }

  private async _refreshKnownDiskMtimeFromDisk(): Promise<void> {
    if (!this._filePath) {
      this._lastKnownDiskMtime = undefined;
      return;
    }
    try {
      const st = await vscode.workspace.fs.stat(vscode.Uri.file(this._filePath));
      this._lastKnownDiskMtime = st.mtime;
    } catch {
      this._lastKnownDiskMtime = undefined;
    }
  }

  private async _syncBackingFileWatcherAfterLoad(): Promise<void> {
    await this._refreshKnownDiskMtimeFromDisk();
    this._installBackingFileWatcherIfNeeded();
  }

  private _beginSuppressExternalChangeCheck(): void {
    this._suppressExternalChangeCheckUntil = Date.now() + 2500;
  }

  private async _checkExternalDiskChangedAndPrompt(): Promise<void> {
    if (this._externalChangePromptLock || !this._filePath || !this._ext) {
      return;
    }
    if (Date.now() < this._suppressExternalChangeCheckUntil) {
      return;
    }
    let st: vscode.FileStat;
    try {
      st = await vscode.workspace.fs.stat(vscode.Uri.file(this._filePath));
    } catch {
      return;
    }
    if (this._lastKnownDiskMtime === undefined) {
      this._lastKnownDiskMtime = st.mtime;
      return;
    }
    if (st.mtime <= this._lastKnownDiskMtime) {
      return;
    }

    this._externalChangePromptLock = true;
    try {
      this.focus();
      const zh = this._uiLanguage === 'zh';
      const msg = this._dirty
        ? zh
          ? '磁盘上的脑图文件已被其他程序修改，但当前编辑器中有未保存的更改。若从磁盘重新加载，未保存的修改将丢失。'
          : 'The mindmap file changed on disk, but you have unsaved edits. Reloading will discard local changes.'
        : zh
          ? '磁盘上的脑图文件已被其他程序修改，是否从磁盘重新加载？'
          : 'The mindmap file was modified on disk. Reload from disk?';
      const reloadLabel = zh ? '重新加载' : 'Reload';
      const keepLabel = zh ? '保留编辑器' : 'Keep editor';
      const picked = await vscode.window.showWarningMessage(msg, { modal: true }, reloadLabel, keepLabel);
      if (picked === reloadLabel) {
        await this._reloadTreeFromDisk();
      }
      await this._refreshKnownDiskMtimeFromDisk();
    } finally {
      this._externalChangePromptLock = false;
    }
  }

  private async _reloadTreeFromDisk(): Promise<void> {
    if (!this._filePath || !this._ext) {
      return;
    }
    try {
      let tree: MindmapTree;
      if (this._ext === 'xmind') {
        tree = parseMindmapXmindFile(this._filePath);
      } else {
        const text = (await vscode.workspace.fs.readFile(vscode.Uri.file(this._filePath))).toString();
        tree = parseMindmapText(text, this._ext);
      }
      this._beginSuppressExternalChangeCheck();
      await this._loadTreeIntoWebview(tree, this._ext);
    } catch (e) {
      const msgStr = e instanceof Error ? e.message : String(e);
      void vscode.window.showErrorMessage(
        this._uiLanguage === 'zh' ? `重新加载失败：${msgStr}` : `Reload failed: ${msgStr}`
      );
    }
  }

  private async _afterHostWroteBackingFile(): Promise<void> {
    await this._refreshKnownDiskMtimeFromDisk();
    this._installBackingFileWatcherIfNeeded();
  }

  // Ensure the webview panel becomes the foreground UI after external layout changes.
  public focus() {
    try {
      this._panel.reveal();
    } catch {
      // ignore
    }
  }

  public get backingFilePath(): string | undefined {
    return this._filePath;
  }

  public get mindmapFormat(): FileExt | undefined {
    return this._ext;
  }

  /** 不含标签装饰（●）的标题，供桥接与退出记录使用 */
  public get panelTitle(): string {
    return this._titleBase;
  }

  public async aiGetTree() {
    return this._requestWebview('mindmap:hostGetTree', {});
  }

  public async aiAddNode(parentId: string, topic: string) {
    return this._requestWebview('mindmap:hostAddNode', { parentId, topic });
  }

  public async aiUpdateNodeTitle(nodeId: string, topic: string) {
    return this._requestWebview('mindmap:hostUpdateNodeTitle', { nodeId, topic });
  }

  public async aiDeleteNode(nodeId: string) {
    return this._requestWebview('mindmap:hostDeleteNode', { nodeId });
  }

  public async aiGetSelection() {
    return this._requestWebview('mindmap:hostGetSelection', {});
  }

  public async aiApplyOps(ops: unknown[], dryRun = false, transaction = false, strict = false) {
    return this._requestWebview('mindmap:hostApplyOps', { ops, dryRun, transaction, strict });
  }

  /** 无落盘路径，或画布相对磁盘有未保存修改（与 MCP 桥接配合使用） */
  public shouldWarnMcpPersistState(): boolean {
    return !this._filePath || this._dirty;
  }

  private _mcpPersistWarningText(): string {
    const noFile = !this._filePath;
    const dirty = this._dirty;
    if (this._uiLanguage === 'zh') {
      if (noFile && dirty) {
        return '当前为未命名脑图，且画布上有未保存到磁盘的修改。\n\nMCP 将读取/修改编辑器中的实时内容（尚未写入文件）。建议先使用「保存」或「另存为」落盘后再让自动化操作，以免与磁盘上的旧文件不一致。';
      }
      if (noFile) {
        return '当前脑图尚未保存到任何文件路径。\n\nMCP 将针对编辑器中的内容操作；若关闭窗口或出错，可能难以与磁盘文件对齐。建议先「另存为」指定文件。';
      }
      return '当前有未保存到磁盘的修改（标题栏上的 · 表示未保存）。\n\nMCP 会使用画布上的最新数据，但磁盘上的文件仍是旧版本。建议在执行 MCP 前按 Ctrl+S 保存。';
    }
    if (noFile && dirty) {
      return 'This mindmap is untitled and has unsaved edits.\n\nMCP will read/modify the live editor buffer (not yet on disk). Save or Save As first to keep disk and automation in sync.';
    }
    if (noFile) {
      return 'This mindmap has no file path on disk yet.\n\nMCP will target the editor buffer only. Use Save As to persist before relying on files on disk.';
    }
    return 'You have unsaved changes (the dot in the tab title means dirty).\n\nMCP uses the latest canvas data; the file on disk is older. Press Ctrl+S / Cmd+S to save before MCP runs.';
  }

  /**
   * MCP 桥接：已绑定磁盘路径且画布有未保存修改时自动写盘（无成功弹窗），失败则抛错由桥接返回错误。
   * 无路径的未命名脑图不调用 Save 对话框，留给 {@link showMcpPersistNoticeIfNeeded}。
   */
  public async autoSaveForMcpBridgeIfNeeded(): Promise<void> {
    if (!this._dirty || !this._filePath) {
      return;
    }
    let tree: MindmapTree;
    try {
      tree = await this.aiGetTree();
    } catch (e) {
      const msgStr = e instanceof Error ? e.message : String(e);
      throw new Error(
        this._uiLanguage === 'zh'
          ? `MCP 自动保存前无法读取脑图：${msgStr}`
          : `Cannot read mindmap before MCP auto-save: ${msgStr}`
      );
    }
    const ok = await this._persistMindmapTree(tree, { silent: true, requireBackingPath: true });
    if (!ok) {
      throw new Error(
        this._uiLanguage === 'zh'
          ? 'MCP 自动保存失败（写盘未成功）。'
          : 'MCP auto-save failed (could not write file).'
      );
    }
    this._notifySaved();
  }

  /**
   * 若未落盘或未保存，在脑图编辑器中央弹出提示并等待用户确认后再继续（供 HTTP MCP 桥接调用）。
   */
  public async showMcpPersistNoticeIfNeeded(): Promise<void> {
    if (!this.shouldWarnMcpPersistState()) {
      return;
    }
    this.focus();
    const message = this._mcpPersistWarningText();
    const title = this._uiLanguage === 'zh' ? 'MCP 提示' : 'MCP notice';
    const requestId = `mcp_notice_${++this._reqSeq}`;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this._pendingMcpNoticeAck.delete(requestId);
        resolve();
      }, 120_000);
      this._pendingMcpNoticeAck.set(requestId, () => {
        clearTimeout(timer);
        this._pendingMcpNoticeAck.delete(requestId);
        resolve();
      });
      void this._panel.webview.postMessage({
        type: 'mindmap:showMcpPersistNotice',
        requestId,
        title,
        message
      });
    });
  }

  private _requestWebview(type: string, payload: Record<string, unknown>) {
    const requestId = `host_${++this._reqSeq}`;
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pendingHostRequests.delete(requestId);
        reject(new Error(`Webview request timed out: ${type}`));
      }, 10000);
      this._pendingHostRequests.set(requestId, { resolve, reject, timer });
      this._panel.webview.postMessage({ type, requestId, ...payload });
    });
  }

  private async _handleMessage(msg: any) {
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'mindmap:ready') {
      this._postSaveTrafficLightToWebview();
      return;
    }

    if (msg.type === 'mindmap:forceCleanAck') {
      return;
    }

    if (msg.type === 'mindmap:noticeAck') {
      const rid = String(msg.requestId || '');
      const fn = rid ? this._pendingMcpNoticeAck.get(rid) : undefined;
      if (fn) {
        this._pendingMcpNoticeAck.delete(rid);
        fn();
      }
      return;
    }

    if (msg.type === 'mindmap:hostResponse') {
      const requestId = String(msg.requestId || '');
      if (!requestId) return;
      const pending = this._pendingHostRequests.get(requestId);
      if (!pending) return;
      this._pendingHostRequests.delete(requestId);
      clearTimeout(pending.timer);
      if (msg.ok === false) {
        const err = new Error(String(msg.error || 'Unknown webview error'));
        const failData = msg.data;
        if (failData !== null && failData !== undefined && typeof failData === 'object') {
          (err as Error & { webviewData?: unknown }).webviewData = failData;
        }
        pending.reject(err);
      } else {
        pending.resolve(msg.data);
      }
      return;
    }

    if (msg.type === 'mindmap:setUiLanguage') {
      this._uiLanguage = msg.language === 'zh' ? 'zh' : 'en';
      return;
    }

    if (msg.type === 'mindmap:edited') {
      if (this._textDocument) {
        this._pendingDocSyncFromWebview = true;
        this._scheduleSyncDocumentFromWebview();
        return;
      }
      if (!this._dirty) {
        this._dirty = true;
        this._applyTitle();
      }
      return;
    }

    if (msg.type === 'mindmap:requestToggleDock') {
      await this._safeExec('mindmapVscode.toggleDock');
      return;
    }

    if (msg.type === 'mindmap:requestNew') {
      const tree: MindmapTree = {
        root: {
          id: 'root',
          topic: 'New Mindmap',
          children: []
        }
      };

      this._filePath = undefined;
      await this.setTree(tree, 'mmd');
      return;
    }

    if (msg.type === 'mindmap:requestOpen') {
      const openPick = await vscode.window.showOpenDialog({
        canSelectMany: false,
        filters: {
          Mindmap: ['mmd', 'jm', 'xmind']
        }
      });
      if (!openPick || openPick.length === 0) return;

      const filePath = openPick[0].fsPath;
      const rawExt = filePath.split('.').pop()?.toLowerCase() ?? '';

      let ext: MindmapExt;
      if (rawExt === 'mmd') ext = 'mmd';
      else if (rawExt === 'jm') ext = 'jm';
      else if (rawExt === 'xmind') ext = 'xmind';
      else {
        vscode.window.showErrorMessage(`不支持的脑图格式：.${rawExt}。建议使用 .mmd、.jm 或 .xmind。`);
        return;
      }

      try {
        let tree: MindmapTree;
        if (ext === 'xmind') {
          tree = parseMindmapXmindFile(filePath);
        } else {
          const text = (await vscode.workspace.fs.readFile(vscode.Uri.file(filePath))).toString();
          tree = parseMindmapText(text, ext);
        }

        if (!(await this._confirmDiscardIfDirty({ includeNotPersistedAsRisk: false }))) {
          return;
        }
        this._filePath = filePath;
        await this._loadTreeIntoWebview(tree, ext);
      } catch (e) {
        const msgStr = e instanceof Error ? e.message : String(e);
        vscode.window.showErrorMessage(`解析失败：${msgStr}`);
      }
      return;
    }

    if (msg.type === 'mindmap:requestSaveAs') {
      const tree = msg.tree as MindmapTree;
      if (!tree) return;

      const savePick = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file('mindmap.mmd'),
        filters: {
          Mindmap: ['mmd', 'jm']
        }
      });
      if (!savePick) return;

      const pickedExt = (savePick.fsPath.split('.').pop() || '').toLowerCase();
      if (pickedExt !== 'mmd' && pickedExt !== 'jm') {
        vscode.window.showErrorMessage(`不支持的新建扩展名：.${pickedExt}`);
        return;
      }

      this._ext = pickedExt === 'mmd' ? 'mmd' : 'jm';
      this._filePath = savePick.fsPath;

      try {
        const text = this._serialize(tree, this._ext);
        const bytes = new TextEncoder().encode(text);
        const uri = vscode.Uri.file(this._filePath);
        this._beginSuppressExternalChangeCheck();
        await vscode.workspace.fs.writeFile(uri, bytes);
        await vscode.window.showInformationMessage(`另存为成功：${this._filePath}`);
        this._syncTitleBase();
        this._notifySaved();
        await this._afterHostWroteBackingFile();
      } catch (e) {
        const msgStr = e instanceof Error ? e.message : String(e);
        await vscode.window.showErrorMessage(`另存为失败：${msgStr}`);
      }
      return;
    }

    if (msg.type === 'mindmap:requestSave') {
      const tree = msg.tree as MindmapTree;
      if (!tree) {
        await vscode.window.showErrorMessage('保存失败：未获取到脑图数据。');
        return;
      }

      const ok = await this._persistMindmapTree(tree);
      if (ok) {
        this._notifySaved();
      }
      return;
    }

    if (msg.type === 'mindmap:toggleDock') {
      this._dockFocused = !this._dockFocused;
      if (this._dockFocused) {
        await this._safeExec('workbench.action.closeSidebar');
        await this._safeExec('workbench.action.closePanel');
        await this._safeExec('workbench.action.activityBarLocation.hide');
        await this._safeExec('workbench.action.statusBarLocation.hide');
      } else {
        await this._safeExec('workbench.action.toggleSidebarVisibility');
        await this._safeExec('workbench.action.togglePanel');
        await this._safeExec('workbench.action.toggleActivityBarVisibility');
        await this._safeExec('workbench.action.toggleStatusbarVisibility');
      }
      return;
    }
  }

  private async _safeExec(command: string) {
    try {
      await vscode.commands.executeCommand(command);
    } catch {
      // Intentionally ignore: VS Code 命令在不同版本可能存在差异。
    }
  }

  private _serialize(tree: MindmapTree, ext: FileExt) {
    return serializeMindmapTree(tree, ext);
  }

  private _syncTitleBase(): void {
    const t = this._filePath ? vscode.workspace.asRelativePath(this._filePath) : 'Untitled Mindmap';
    this._titleBase = `Mindmap Editor - ${t}`;
  }

  private _applyTitle(): void {
    if (this._textDocument) {
      this._panel.title = this._titleBase;
    } else {
      this._panel.title = this._dirty ? `${this._titleBase} ·` : this._titleBase;
    }
    MindmapPanel._syncGlobalDirtyContext();
    MindmapPanel._syncQuitDirtyWorkspaceRecord();
  }

  /** 尚无磁盘路径：仅 Webview 面板，或定制编辑器绑定未命名文档 */
  private _isNotPersistedToDisk(): boolean {
    if (this._textDocument) {
      return this._textDocument.uri.scheme === 'untitled';
    }
    return !this._filePath;
  }

  /** 关闭标签 / 退出前是否应弹出保存相关提示（脏数据，或从未落盘） */
  private static _panelNeedsSaveOrPersistPrompt(p: MindmapPanel): boolean {
    const pendingCustomDocSync =
      !!p._textDocument &&
      (p._pendingDocSyncFromWebview || p._pendingWebviewToDocTimer !== undefined);
    return (
      p._dirty ||
      p._textDocument?.isDirty === true ||
      p._isNotPersistedToDisk() ||
      pendingCustomDocSync
    );
  }

  /** 关闭 IDE 时若实例已被释放，用上次同步的列表做后备提示（无法代为保存）。 */
  private static _syncQuitDirtyWorkspaceRecord(): void {
    const ctx = MindmapPanel._extensionContext;
    if (!ctx) {
      return;
    }
    const recs = [...MindmapPanel._instances]
      .filter((p) => MindmapPanel._panelNeedsSaveOrPersistPrompt(p))
      .map((p) => ({ title: p.panelTitle, filePath: p.backingFilePath ?? null }));
    void ctx.workspaceState.update('mindmap.dirtyMindmapAtLastSync', recs);
  }

  /** 当前编辑器相对磁盘/缓冲区：黄=脏，红=未落盘且干净，绿=已保存（发到 webview 底部状态栏右侧圆点） */
  private _computeThisPanelSaveLight(): 'red' | 'yellow' | 'green' {
    const doc = this._textDocument;
    const dirty = this._dirty || doc?.isDirty === true;
    if (dirty) {
      return 'yellow';
    }
    const noDisk =
      (!doc && !this._filePath) || (doc !== undefined && doc.uri.scheme === 'untitled');
    if (noDisk) {
      return 'red';
    }
    return 'green';
  }

  private _postSaveTrafficLightToWebview(): void {
    try {
      void this._panel.webview.postMessage({
        type: 'mindmap:saveTrafficLight',
        light: this._computeThisPanelSaveLight()
      });
    } catch {
      // ignore
    }
  }

  private static _syncWebviewSaveIndicators(): void {
    for (const p of MindmapPanel._instances) {
      p._postSaveTrafficLightToWebview();
    }
  }

  /**
   * 关闭窗口前将 CustomTextEditor 防抖队列中的画布改动立即写入 TextDocument，
   * 使 `isDirty` 与 `onShutdownDeactivate` / 工作台原生未保存提示一致。
   */
  public static async flushAllPendingWebviewEditsToDocument(): Promise<void> {
    await Promise.all([...MindmapPanel._instances].map((p) => p._flushPendingWebviewEditsToDocumentNow()));
  }

  private async _flushPendingWebviewEditsToDocumentNow(): Promise<void> {
    if (!this._textDocument) {
      return;
    }
    const hadTimer = !!this._pendingWebviewToDocTimer;
    if (this._pendingWebviewToDocTimer) {
      clearTimeout(this._pendingWebviewToDocTimer);
      this._pendingWebviewToDocTimer = undefined;
    }
    if (!this._pendingDocSyncFromWebview && !hadTimer) {
      return;
    }
    await this._syncDocumentFromWebview();
  }

  /**
   * 在宿主即将卸载扩展前，把未保存快照 await 写入 workspaceState，减轻关 IDE 时异步未落盘导致「无提示」的问题。
   */
  public static async persistAllDirtyStateBeforeShutdown(): Promise<void> {
    const ctx = MindmapPanel._extensionContext;
    if (!ctx) {
      return;
    }
    for (const p of MindmapPanel._instances) {
      if (MindmapPanel._panelNeedsSaveOrPersistPrompt(p)) {
        const rec: MindmapUnsavedQuitRec = {
          title: p.panelTitle,
          filePath: p.backingFilePath ?? null
        };
        MindmapPanel._closedWithUnsaved = MindmapPanel._dedupeQuitRecs([...MindmapPanel._closedWithUnsaved, rec]);
      }
    }
    for (const doc of MindmapPanel._orphanDirtyMindmapTextDocuments()) {
      const rec = MindmapPanel._quitRecFromTextDocument(doc);
      MindmapPanel._closedWithUnsaved = MindmapPanel._dedupeQuitRecs([...MindmapPanel._closedWithUnsaved, rec]);
    }
    const openRecs = MindmapPanel._dedupeQuitRecs([
      ...[...MindmapPanel._instances]
        .filter((p) => MindmapPanel._panelNeedsSaveOrPersistPrompt(p))
        .map((p) => ({ title: p.panelTitle, filePath: p.backingFilePath ?? null })),
      ...MindmapPanel._orphanDirtyMindmapTextDocuments().map((d) => MindmapPanel._quitRecFromTextDocument(d))
    ]);
    await ctx.workspaceState.update('mindmap.dirtyMindmapAtLastSync', openRecs);
    await ctx.workspaceState.update('mindmap.closedUnsavedMindmaps', MindmapPanel._closedWithUnsaved);
  }

  /** 供快捷键拦截退出（Ctrl+Q / Cmd+Q）等使用 */
  private static _syncGlobalDirtyContext(): void {
    let anyDirty = false;
    for (const p of MindmapPanel._instances) {
      if (MindmapPanel._panelNeedsSaveOrPersistPrompt(p)) {
        anyDirty = true;
        break;
      }
    }
    if (!anyDirty) {
      anyDirty = MindmapPanel._orphanDirtyMindmapTextDocuments().length > 0;
    }
    if (!anyDirty) {
      anyDirty = MindmapPanel._allStaleQuitRecords().length > 0;
    }
    void vscode.commands.executeCommand('setContext', 'mindmapEditorHasUnsavedChanges', anyDirty);
    MindmapPanel._syncWebviewSaveIndicators();
  }

  /**
   * 扩展宿主即将退出时（关闭 IDE / 重载窗口）：提示保存或放弃；无法像普通编辑器那样取消整个窗口关闭。
   * 与 onWillShutdown 并发时只执行一次（共享 Promise）。
   */
  public static async onShutdownDeactivate(): Promise<void> {
    if (MindmapPanel._shutdownDeactivatePromise) {
      return MindmapPanel._shutdownDeactivatePromise;
    }
    MindmapPanel._shutdownDeactivatePromise = MindmapPanel._runShutdownDeactivateBody();
    return MindmapPanel._shutdownDeactivatePromise;
  }

  private static async _runShutdownDeactivateBody(): Promise<void> {
    const ctx = MindmapPanel._extensionContext;
    const dirtyPanels = [...MindmapPanel._instances].filter((p) => MindmapPanel._panelNeedsSaveOrPersistPrompt(p));
    const orphanDocs = MindmapPanel._orphanDirtyMindmapTextDocuments();
    const totalTargets = dirtyPanels.length + orphanDocs.length;

    if (totalTargets === 0) {
      const stale = MindmapPanel._allStaleQuitRecords();
      if (stale.length === 0) {
        return;
      }
      const zh = vscode.env.language.toLowerCase().startsWith('zh');
      const lines = stale.map((s) => (s.filePath ? `${s.title} → ${s.filePath}` : s.title)).join('\n');
      await vscode.window.showWarningMessage(
        zh
          ? `关闭应用前检测到脑图曾有未保存修改，但编辑区已先关闭，无法自动写盘。请确认是否已保存：\n${lines}`
          : `Unsaved mindmap changes were detected before exit, but editors were already closed; cannot save automatically:\n${lines}`,
        { modal: true },
        zh ? '知道了' : 'OK'
      );
      await MindmapPanel._clearStaleQuitState();
      return;
    }
    const zh = vscode.env.language.toLowerCase().startsWith('zh');
    const saveAll = zh ? '全部保存' : 'Save All';
    const discard = zh ? '不保存' : "Don't Save";
    const msg =
      totalTargets === 1
        ? zh
          ? '有 1 个脑图尚未保存到磁盘或含有未保存更改。关闭应用前是否保存？'
          : '1 mindmap is not saved to disk or has unsaved changes. Save before closing the application?'
        : zh
          ? `有 ${totalTargets} 个脑图尚未保存到磁盘或含有未保存更改。关闭应用前是否保存？`
          : `${totalTargets} mindmaps are not saved to disk or have unsaved changes. Save before closing the application?`;

    const picked = await vscode.window.showWarningMessage(msg, { modal: true }, saveAll, discard);
    if (picked === saveAll) {
      for (const p of dirtyPanels) {
        try {
          if (p._textDocument) {
            const savedUri = await vscode.workspace.save(p._textDocument.uri);
            if (!savedUri) {
              await vscode.window.showErrorMessage(
                zh
                  ? '保存已取消或失败；未写入的脑图修改可能随 IDE 退出而丢失。'
                  : 'Save was cancelled or failed; unsaved mindmap edits may be lost when the IDE exits.'
              );
              return;
            }
            p._notifySaved();
          } else {
            const tree = await p.aiGetTree();
            const ok = await p._persistMindmapTree(tree);
            if (!ok) {
              await vscode.window.showErrorMessage(
                zh
                  ? '保存已取消或失败；未写入的脑图修改可能随 IDE 退出而丢失。'
                  : 'Save was cancelled or failed; unsaved mindmap edits may be lost when the IDE exits.'
              );
              return;
            }
            p._notifySaved();
          }
        } catch (e) {
          const msgStr = e instanceof Error ? e.message : String(e);
          await vscode.window.showErrorMessage(msgStr);
          return;
        }
      }
      for (const doc of orphanDocs) {
        try {
          const savedUri = await vscode.workspace.save(doc.uri);
          if (!savedUri) {
            await vscode.window.showErrorMessage(
              zh
                ? '保存已取消或失败；未写入的脑图修改可能随 IDE 退出而丢失。'
                : 'Save was cancelled or failed; unsaved mindmap edits may be lost when the IDE exits.'
            );
            return;
          }
        } catch (e) {
          const msgStr = e instanceof Error ? e.message : String(e);
          await vscode.window.showErrorMessage(msgStr);
          return;
        }
      }
      void ctx?.workspaceState.update('mindmap.dirtyMindmapAtLastSync', []);
      return;
    }
    for (const p of dirtyPanels) {
      if (p._textDocument?.isDirty) {
        await p._revertTextDocumentFromDisk();
      } else {
        p._dirty = false;
        p._applyTitle();
        void p._panel.webview.postMessage({ type: 'mindmap:savedOk' });
      }
    }
    for (const doc of orphanDocs) {
      await MindmapPanel._revertMindmapTextDocumentContent(doc);
    }
    void ctx?.workspaceState.update('mindmap.dirtyMindmapAtLastSync', []);
  }

  /**
   * 用户通过 Ctrl+Q / Cmd+Q 退出：可取消退出；返回 true 表示应继续执行 workbench.action.quit。
   */
  public static async confirmQuitWhenDirty(): Promise<boolean> {
    const dirtyPanels = [...MindmapPanel._instances].filter((p) => MindmapPanel._panelNeedsSaveOrPersistPrompt(p));
    const orphanDocs = MindmapPanel._orphanDirtyMindmapTextDocuments();
    const totalInteractive = dirtyPanels.length + orphanDocs.length;
    const stale = MindmapPanel._allStaleQuitRecords();

    if (totalInteractive === 0 && stale.length === 0) {
      return true;
    }

    const zh = vscode.env.language.toLowerCase().startsWith('zh');
    const saveAll = zh ? '全部保存' : 'Save All';
    const discard = zh ? '不保存' : "Don't Save";
    const cancel = zh ? '取消' : 'Cancel';
    const quitAnyway = zh ? '仍要退出' : 'Quit Anyway';

    if (totalInteractive > 0) {
      const msg =
        totalInteractive === 1
          ? zh
            ? '有 1 个脑图尚未保存到磁盘或含有未保存更改，仍要退出吗？'
            : '1 mindmap is not saved to disk or has unsaved changes. Quit anyway?'
          : zh
            ? `有 ${totalInteractive} 个脑图尚未保存到磁盘或含有未保存更改，仍要退出吗？`
            : `${totalInteractive} mindmaps are not saved to disk or have unsaved changes. Quit anyway?`;

      const picked = await vscode.window.showWarningMessage(msg, { modal: true }, saveAll, discard, cancel);
      if (picked === undefined || picked === cancel) {
        return false;
      }
      if (picked === saveAll) {
        for (const p of dirtyPanels) {
          try {
            if (p._textDocument) {
              const savedUri = await vscode.workspace.save(p._textDocument.uri);
              if (!savedUri) {
                return false;
              }
              p._notifySaved();
            } else {
              const tree = await p.aiGetTree();
              const ok = await p._persistMindmapTree(tree);
              if (!ok) {
                return false;
              }
              p._notifySaved();
            }
          } catch {
            return false;
          }
        }
        for (const doc of orphanDocs) {
          try {
            const savedUri = await vscode.workspace.save(doc.uri);
            if (!savedUri) {
              return false;
            }
          } catch {
            return false;
          }
        }
        void MindmapPanel._extensionContext?.workspaceState.update('mindmap.dirtyMindmapAtLastSync', []);
        return true;
      }
      for (const p of dirtyPanels) {
        if (p._textDocument?.isDirty) {
          await p._revertTextDocumentFromDisk();
        } else {
          p._dirty = false;
          p._applyTitle();
          void p._panel.webview.postMessage({ type: 'mindmap:savedOk' });
        }
      }
      for (const doc of orphanDocs) {
        await MindmapPanel._revertMindmapTextDocumentContent(doc);
      }
      void MindmapPanel._extensionContext?.workspaceState.update('mindmap.dirtyMindmapAtLastSync', []);
      return true;
    }

    const lines = stale.map((s) => (s.filePath ? `${s.title} → ${s.filePath}` : s.title)).join('\n');
    const msgStale = zh
      ? `检测到以下脑图未保存且已关闭编辑器，无法自动写盘。仍要退出吗？\n${lines}`
      : `Unsaved mindmap changes were detected but editors are already closed. Quit anyway?\n${lines}`;
    const pickedStale = await vscode.window.showWarningMessage(msgStale, { modal: true }, quitAnyway, cancel);
    if (pickedStale === undefined || pickedStale === cancel) {
      return false;
    }
    await MindmapPanel._clearStaleQuitState();
    return true;
  }

  private _notifySaved(): void {
    this._dirty = false;
    this._applyTitle();
    void this._panel.webview.postMessage({ type: 'mindmap:savedOk' });
  }

  private async _prepareWebviewHtmlReload(): Promise<void> {
    await new Promise<void>((resolve) => {
      let done = false;
      const sub = this._panel.webview.onDidReceiveMessage((m: unknown) => {
        const o = m as { type?: string };
        if (o && o.type === 'mindmap:forceCleanAck') {
          finish();
        }
      });
      const finish = () => {
        if (done) {
          return;
        }
        done = true;
        sub.dispose();
        resolve();
      };
      void this._panel.webview.postMessage({ type: 'mindmap:forceClean' });
      setTimeout(finish, 200);
    });
  }

  /** @returns true if file was written successfully */
  private async _persistMindmapTree(
    tree: MindmapTree,
    opts?: { silent?: boolean; requireBackingPath?: boolean }
  ): Promise<boolean> {
    const silent = !!opts?.silent;
    const requireBackingPath = !!opts?.requireBackingPath;

    if (!this._ext) {
      this._ext = 'mmd';
    }

    if (!this._filePath) {
      if (requireBackingPath) {
        return false;
      }
      const savePick = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file('mindmap.mmd'),
        filters: {
          Mindmap: ['mmd', 'jm']
        }
      });
      if (!savePick) {
        return false;
      }

      const pickedExt = (savePick.fsPath.split('.').pop() || '').toLowerCase();
      if (pickedExt === 'mmd') {
        this._ext = 'mmd';
      } else if (pickedExt === 'jm') {
        this._ext = 'jm';
      } else {
        vscode.window.showErrorMessage(`不支持的新建扩展名：.${pickedExt}`);
        return false;
      }

      this._filePath = savePick.fsPath;
    }

    if (this._ext === 'xmind') {
      if (!this._filePath) {
        return false;
      }
      try {
        this._beginSuppressExternalChangeCheck();
        writeMindmapXmindTitlesOnly(this._filePath, tree);
        if (!silent) {
          await vscode.window.showInformationMessage('xmind 保存完成（标题编辑模式）。');
        }
        await this._afterHostWroteBackingFile();
        return true;
      } catch (e) {
        const msgStr = e instanceof Error ? e.message : String(e);
        vscode.window.showErrorMessage(`xmind 保存失败：${msgStr}`);
        return false;
      }
    }

    if (!this._filePath) {
      return false;
    }
    try {
      const text = this._serialize(tree, this._ext);
      const bytes = new TextEncoder().encode(text);
      const uri = vscode.Uri.file(this._filePath);
      this._beginSuppressExternalChangeCheck();
      await vscode.workspace.fs.writeFile(uri, bytes);
      if (!silent) {
        await vscode.window.showInformationMessage(`保存成功：${this._filePath}`);
      }
      await this._afterHostWroteBackingFile();
      return true;
    } catch (e) {
      const msgStr = e instanceof Error ? e.message : String(e);
      await vscode.window.showErrorMessage(`保存失败：${msgStr}`);
      return false;
    }
  }

  /**
   * @param includeNotPersistedAsRisk 为 false 时仅在有脏标记时提示（用于 setTree / 打开文件替换当前画布，避免空白未落盘也弹窗）
   */
  private async _confirmDiscardIfDirty(opts?: { includeNotPersistedAsRisk?: boolean }): Promise<boolean> {
    const includeNp = opts?.includeNotPersistedAsRisk !== false;
    const needsPrompt = includeNp
      ? MindmapPanel._panelNeedsSaveOrPersistPrompt(this)
      : this._dirty || (this._textDocument?.isDirty ?? false);
    if (!needsPrompt) {
      return true;
    }
    const docDirty = this._textDocument?.isDirty ?? false;
    const zh = this._uiLanguage === 'zh';
    const saveLabel = zh ? '保存' : 'Save';
    const discardLabel = zh ? '不保存' : "Don't Save";
    const cancelLabel = zh ? '取消' : 'Cancel';
    const onlyNeverPersisted =
      includeNp && !this._dirty && !docDirty && this._isNotPersistedToDisk();
    const message = onlyNeverPersisted
      ? zh
        ? '当前脑图尚未保存到文件。要保存吗？'
        : 'This mindmap is not saved to a file yet. Do you want to save?'
      : zh
        ? '当前脑图有未保存的更改，要继续吗？'
        : 'You have unsaved changes. Continue?';
    const picked = await vscode.window.showWarningMessage(
      message,
      { modal: true },
      saveLabel,
      discardLabel,
      cancelLabel
    );
    if (picked === undefined) {
      return false;
    }
    if (picked === cancelLabel) {
      return false;
    }
    if (picked === saveLabel) {
      try {
        if (this._textDocument) {
          const savedUri = await vscode.workspace.save(this._textDocument.uri);
          return savedUri !== undefined;
        }
        const tree = await this.aiGetTree();
        return await this._persistMindmapTree(tree);
      } catch (e) {
        const msgStr = e instanceof Error ? e.message : String(e);
        await vscode.window.showErrorMessage(msgStr);
        return false;
      }
    }
    if (this._textDocument?.isDirty) {
      await this._revertTextDocumentFromDisk();
    } else {
      this._dirty = false;
      this._applyTitle();
      void this._panel.webview.postMessage({ type: 'mindmap:savedOk' });
    }
    return true;
  }

  /**
   * 解析「当前活动标签」对应的 Mindmap 实例（多开同列时按可见性 / currentPanel 兜底）。
   */
  private static resolvePanelForMindmapActiveTab(): MindmapPanel | undefined {
    for (const p of MindmapPanel._instances) {
      if (p._panel.active) {
        return p;
      }
    }
    const tab = vscode.window.tabGroups.activeTabGroup?.activeTab;
    if (!tab?.input) {
      return undefined;
    }
    if (tab.input instanceof vscode.TabInputCustom && tab.input.viewType === MINDMAP_CUSTOM_TEXT_EDITOR_VIEW_TYPE) {
      const fp = tab.input.uri.fsPath;
      for (const p of MindmapPanel._instances) {
        if (p._filePath && MindmapPanel._pathsEqual(p._filePath, fp)) {
          return p;
        }
      }
      return undefined;
    }
    if (!(tab.input instanceof vscode.TabInputWebview)) {
      return undefined;
    }
    if (tab.input.viewType !== 'mindmapEditor') {
      return undefined;
    }
    const col = tab.group.viewColumn;
    const inCol = [...MindmapPanel._instances].filter((p) => p._panel.viewColumn === col);
    if (inCol.length === 1) {
      return inCol[0];
    }
    for (const p of inCol) {
      if (p._panel.visible) {
        return p;
      }
    }
    const cur = MindmapPanel.currentPanel;
    if (cur && inCol.includes(cur)) {
      return cur;
    }
    return inCol[0];
  }

  /**
   * 宿主快捷键关闭标签（Ctrl+F4 / Ctrl+W 等）不会触发 webview 内 beforeunload；
   * 由扩展注册同名快捷键并在关闭前走与新建/打开相同的脏检查。
   */
  public static async closeActiveWithSavePrompt(): Promise<void> {
    const tab = vscode.window.tabGroups.activeTabGroup?.activeTab;
    const mindmapTabActive =
      (!!tab?.input &&
        tab.input instanceof vscode.TabInputWebview &&
        tab.input.viewType === 'mindmapEditor') ||
      (!!tab?.input &&
        tab.input instanceof vscode.TabInputCustom &&
        tab.input.viewType === MINDMAP_CUSTOM_TEXT_EDITOR_VIEW_TYPE);

    let target = MindmapPanel.resolvePanelForMindmapActiveTab();
    if (!target && mindmapTabActive) {
      target = MindmapPanel.currentPanel;
    }

    if (!mindmapTabActive || !target) {
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
      return;
    }
    if (!(await target._confirmDiscardIfDirty())) {
      return;
    }
    target._panel.dispose();
  }

  private _getHtmlForWebview(webview: vscode.Webview, boot: { tree: MindmapTree; ext: FileExt }) {
    const nonce = getNonce();
    const cspSource = webview.cspSource;
    // Boot 放在 <template> 内（不从脚本执行）；`<` 写成 \u003c 防 `</script>`；避免 <script type="application/json"> 在部分 Webview 被误当 JS
    const bootJsonForHtml = JSON.stringify({
      tree: boot.tree,
      ext: boot.ext,
      uiLanguage: this._uiLanguage
    }).replace(/</g, '\\u003c');

    // Offline: load jsMind assets from extension bundle.
    const jsmindScriptUrl = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'jsmind', 'jsmind.js')).toString();
    const jsmindCssUrl = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'jsmind', 'jsmind.css')).toString();

    return /* html */ `<!DOCTYPE html>
<html lang="zh">
  <head>
    <meta charset="UTF-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; img-src ${cspSource} https: data:; style-src 'unsafe-inline' ${cspSource}; script-src 'nonce-${nonce}' ${cspSource}; connect-src ${cspSource} https:; font-src ${cspSource} https: data:; "
    />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" type="text/css" href="${jsmindCssUrl}" />
    <style>
      body {
        margin: 0;
        padding: 0;
        height: 100vh;
        overflow: hidden;
        font-family: -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;
        display: flex;
        flex-direction: column;
      }
      .mainRow {
        flex: 1 1 auto;
        display: flex;
        flex-direction: row;
        overflow: hidden;
      }

      /* Top menu bar (File/Edit/View/...) implemented with <details>. */
      .menubar {
        flex: 0 0 auto;
        display: flex;
        align-items: center;
        gap: 14px;
        padding: 6px 10px;
        border-bottom: 1px solid #e5e7eb;
        background: white;
        overflow: visible;
        position: relative;
        z-index: 30;
        color: #000;
      }
      .menubar details {
        position: relative;
      }
      .menubar summary {
        list-style: none;
        cursor: pointer;
        user-select: none;
        padding: 0;
        font-weight: 600;
        color: #000;
      }
      .menubar summary::-webkit-details-marker { display: none; }
      .menuItems {
        position: absolute;
        top: 100%;
        left: 0;
        z-index: 10;
        min-width: 190px;
        background: white;
        border: 1px solid #e5e7eb;
        border-radius: 10px;
        padding: 8px;
        box-shadow: 0 2px 8px rgba(0,0,0,0.08);
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .menubar details:not([open]) .menuItems { display: none; }
      .menuItems button {
        width: 100%;
        text-align: left;
        background: transparent;
        border: 0;
        padding: 6px 8px;
        border-radius: 8px;
        cursor: pointer;
        color: #000;
        font-weight: 500;
      }
      .menuItems button:hover { background: #f3f4f6; }
      .menuItems button:disabled {
        color: #9ca3af;
        cursor: not-allowed;
      }
      /* Left vertical toolbar */
      .vtoolbar {
        width: 260px;
        min-width: 260px;
        padding: 10px 10px;
        border-right: 1px solid #e5e7eb;
        background: #dce1e8;
        display: flex;
        flex-direction: column;
        gap: 8px;
        overflow: auto;
      }
      .vtoolbar button {
        padding: 6px 10px;
        border-radius: 8px;
        border: 1px solid #d1d5db;
        background: white;
        cursor: pointer;
        width: 100%;
        text-align: center;
        font-size: 16px;
        line-height: 1;
        min-height: 36px;
      }
      .vtoolbar button:hover { background: #f9fafb; }

      .toolbarToggle {
        width: 100%;
        padding: 6px 10px;
        border-radius: 8px;
        border: 1px solid #d1d5db;
        background: #f3f4f6;
        cursor: pointer;
        font-weight: 700;
      }

      /* Collapsed toolbar (icon-only). */
      .vtoolbar.collapsed {
        width: 56px;
        min-width: 56px;
        padding: 10px 6px;
        align-items: center;
      }
      .vtoolbar.collapsed button {
        width: 40px;
        height: 40px;
        padding: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        text-align: center;
        overflow: hidden;
        white-space: nowrap;
      }

      /* Keep a 16:9-ish canvas on the right side. */
      .canvas_wrap {
        flex: 1 1 auto;
        min-width: 0;
        height: 100%;
        width: 100%;
        overflow: hidden !important;
        display: flex;
        align-items: stretch;
        justify-content: stretch;
        background-color: #e5e7eb;
        position: relative;
      }
      .gridLayer {
        position: absolute;
        inset: 0;
        z-index: 0;
        pointer-events: none;
        background-color: #e5e7eb;
        background-image:
          linear-gradient(rgba(90, 100, 120, 0.10) 1px, transparent 1px),
          linear-gradient(90deg, rgba(90, 100, 120, 0.10) 1px, transparent 1px);
        background-size: 20px 20px;
      }
      .debugBounds {
        position: absolute;
        pointer-events: none;
        z-index: 6;
        box-sizing: border-box;
      }
      .debugBounds.hidden { display: none; }
      .fallbackTree {
        position: absolute;
        inset: 8px;
        z-index: 9;
        overflow: auto;
        background: rgba(255, 255, 255, 0.92);
        border: 1px solid #d1d5db;
        border-radius: 8px;
        padding: 8px 10px;
        font-size: 13px;
        line-height: 1.5;
        color: #111827;
      }
      .fallbackTree.hidden { display: none; }
      .rootMirror {
        position: absolute;
        left: 50%;
        top: 50%;
        transform: translate(-50%, -50%);
        z-index: 10;
        background: #ffffff;
        color: #111827;
        border: 1px solid #9ca3af;
        border-radius: 8px;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
        padding: 8px 12px;
        font-size: 14px;
        font-weight: 600;
        max-width: min(70vw, 520px);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .rootMirror.hidden { display: none; }
      .fallbackTree ul {
        margin: 0;
        padding-left: 18px;
      }
      .fallbackTree li {
        margin: 2px 0;
      }
      .debugViewportFrame {
        inset: 0;
        border: 2px dashed rgba(220, 38, 38, 0.9);
      }
      .debugInnerFrame {
        border: 2px dashed rgba(37, 99, 235, 0.9);
      }
      .debugBoundsLabel {
        position: absolute;
        left: 6px;
        top: 6px;
        font-size: 11px;
        line-height: 1.25;
        padding: 2px 6px;
        border-radius: 6px;
        background: rgba(17, 24, 39, 0.72);
        color: #fff;
        white-space: nowrap;
      }
      #jsmind_container {
        width: 100%;
        height: 100%;
        min-height: 100%;
        background: transparent;
        position: absolute;
        inset: 0;
        z-index: 1;
        overflow: visible !important;
      }
      /* Keep jsMind internal layers transparent, otherwise large white blocks may appear after relayout. */
      #jsmind_container .jsmind-inner {
        background: transparent !important;
        overflow: visible !important;
      }
      #jsmind_container jmnodes,
      #jsmind_container svg.jsmind,
      #jsmind_container canvas.jsmind {
        background: transparent !important;
      }
      /* jsMind uses inline display:none to hide collapsed subtrees; never !important display on jmnode. */
      #jsmind_container::-webkit-scrollbar { display: none; }
      #jsmind_container { scrollbar-width: none; -ms-overflow-style: none; }

      /* Right attributes panel (Format/Icon tabs). */
      .attrPanel {
        width: 220px;
        min-width: 220px;
        padding: 10px 10px;
        border-left: 1px solid #e5e7eb;
        background: #dce1e8;
        display: flex;
        flex-direction: column;
        gap: 10px;
        overflow: hidden;
      }

      .attrTabs {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .attrTab {
        flex: 0 0 auto;
        width: 100%;
        padding: 6px 10px;
        border-radius: 8px;
        border: 1px solid #d1d5db;
        background: white;
        cursor: pointer;
        font-weight: 600;
      }
      .attrTab.active {
        background: #f3f4f6;
      }

      .attrPanelToggle {
        width: 100%;
        padding: 6px 10px;
        border-radius: 8px;
        border: 1px solid #d1d5db;
        background: #f3f4f6;
        cursor: pointer;
        font-weight: 700;
      }

      .attrPanel.collapsed {
        width: 56px;
        min-width: 56px;
        padding: 10px 6px;
      }
      .attrPanel.collapsed .attrContent { display: none; }
      .attrPanel.collapsed .attrTab { padding: 6px 0; }
      .attrPanel.collapsed .attrPanelToggle { width: 40px; }

      .attrContent {
        flex: 1 1 auto;
        overflow: auto;
        border-radius: 10px;
        border: 1px solid #e5e7eb;
        padding: 10px;
      }
      .attrContentSection { display: none; }
      .attrContentSection.active { display: block; }
      .attrItem { font-size: 13px; color: #374151; margin-bottom: 10px; }

      /* Bottom status bar */
      .statusbar {
        flex: 0 0 auto;
        padding: 6px 10px;
        border-top: 1px solid #e5e7eb;
        background: #f9fafb;
        font-size: 12px;
        color: #6b7280;
        height: 28px;
        box-sizing: border-box;
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .statusbarLeft {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        min-width: 0;
        flex: 1 1 auto;
      }
      .statusbarRight {
        margin-left: auto;
        display: inline-flex;
        align-items: center;
        gap: 10px;
        flex-shrink: 0;
      }
      .statusbarSaveLight {
        width: 10px;
        height: 10px;
        border-radius: 50%;
        flex: 0 0 auto;
        box-sizing: border-box;
        box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.12) inset;
      }
      .statusbarSaveLight.green {
        background: #22c55e;
      }
      .statusbarSaveLight.yellow {
        background: #eab308;
      }
      .statusbarSaveLight.red {
        background: #ef4444;
      }
      .statusbarZoom {
        color: #374151;
        font-weight: 600;
        user-select: none;
        cursor: default;
      }
      .statusbarZoom:hover {
        text-decoration: underline;
      }
      .statusIcon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 14px;
        height: 14px;
        font-size: 12px;
        line-height: 1;
        color: #dc2626;
        visibility: hidden;
      }
      .statusbar.error {
        color: #991b1b;
      }
      .statusbar.error .statusIcon {
        visibility: visible;
      }

      /* Right-click context menus */
      .ctxMenu {
        position: fixed;
        z-index: 80;
        min-width: 0;
        width: max-content;
        max-width: min(86vw, 360px);
        background: #ffffff;
        border: 1px solid #cfd4dc;
        border-radius: 8px;
        box-shadow: 0 6px 16px rgba(0,0,0,0.18);
        padding: 6px;
      }
      .ctxMenu.hidden { display: none; }
      .ctxMenuTitle {
        font-size: 12px;
        color: #6b7280;
        padding: 4px 8px 6px 8px;
      }
      .ctxMenu button {
        display: block;
        width: auto;
        text-align: left;
        border: 0;
        background: transparent;
        border-radius: 6px;
        padding: 7px 8px;
        cursor: pointer;
        color: #111827;
        white-space: nowrap;
      }
      .ctxMenu button:hover { background: #f3f4f6; }

      /* Left-button lasso selection */
      .selectionBox {
        position: fixed;
        z-index: 70;
        border: 1px dashed #2563eb;
        background: rgba(37, 99, 235, 0.12);
        pointer-events: none;
      }
      .lasso-selected {
        /* Keep marker only; actual color follows jmnode.selected (theme-aware). */
      }

      /* Center modal for invalid operations */
      .dialogOverlay {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.22);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 95;
      }
      .dialogOverlay.hidden { display: none; }
      .dialogCard {
        width: min(460px, calc(100vw - 32px));
        background: #ffffff;
        border: 1px solid #d1d5db;
        border-radius: 10px;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.2);
        overflow: hidden;
      }
      .dialogTitle {
        padding: 10px 14px;
        border-bottom: 1px solid #e5e7eb;
        font-weight: 700;
        color: #111827;
        background: #f9fafb;
      }
      .dialogBody {
        padding: 14px;
        color: #1f2937;
        white-space: pre-wrap;
        line-height: 1.45;
      }
      .dialogActions {
        padding: 10px 14px;
        display: flex;
        justify-content: flex-end;
        border-top: 1px solid #e5e7eb;
      }
      .dialogActions button {
        min-width: 82px;
        border: 1px solid #cbd5e1;
        border-radius: 8px;
        padding: 6px 12px;
        cursor: pointer;
        background: #f3f4f6;
      }
    </style>
  </head>
  <body>
    <div class="menubar">
      <details>
        <summary id="sumFile">File</summary>
        <div class="menuItems">
          <button id="menuNew">New</button>
          <button id="menuOpen">Open</button>
          <button id="menuSave">Save</button>
          <button id="menuSaveAs">Save As</button>
        </div>
      </details>
      <details>
        <summary id="sumEdit">Edit</summary>
        <div class="menuItems">
          <button id="menuCopy">Copy</button>
          <button id="menuCut">Cut</button>
          <button id="menuPaste">Paste</button>
          <button id="menuPromote">Promote</button>
          <button id="menuDemote">Demote</button>
          <button id="menuApplyTitle">Apply Title</button>
        </div>
      </details>
      <details>
        <summary id="sumView">View</summary>
        <div class="menuItems">
          <button id="menuExpand">Expand</button>
          <button id="menuCollapse">Collapse</button>
          <button id="menuToggle">Toggle</button>
          <button id="menuExpandAll">Expand All</button>
        </div>
      </details>
      <details>
        <summary id="sumInsert">Insert</summary>
        <div class="menuItems">
          <button id="menuInsertDisabled" disabled>Add / Delete / Move</button>
        </div>
      </details>
      <details>
        <summary id="sumModify">Modify</summary>
        <div class="menuItems">
          <button id="menuModifyPlaceholder" disabled>(none)</button>
        </div>
      </details>
      <details>
        <summary id="sumTheme">Theme</summary>
        <div class="menuItems">
          <button class="themeItem" data-theme="default">Default</button>
          <button class="themeItem" data-theme="primary">Primary</button>
          <button class="themeItem" data-theme="warning">Warning</button>
          <button class="themeItem" data-theme="danger">Danger</button>
          <button class="themeItem" data-theme="success">Success</button>
          <button class="themeItem" data-theme="info">Info</button>
          <button class="themeItem" data-theme="greensea">Greensea</button>
          <button class="themeItem" data-theme="nephrite">Nephrite</button>
          <button class="themeItem" data-theme="belizehole">Belizehole</button>
          <button class="themeItem" data-theme="wisteria">Wisteria</button>
          <button class="themeItem" data-theme="asphalt">Asphalt</button>
          <button class="themeItem" data-theme="orange">Orange</button>
          <button class="themeItem" data-theme="pumpkin">Pumpkin</button>
          <button class="themeItem" data-theme="pomegranate">Pomegranate</button>
          <button class="themeItem" data-theme="clouds">Clouds</button>
          <button class="themeItem" data-theme="asbestos">Asbestos</button>
        </div>
      </details>
      <details>
        <summary id="sumTools">Tools</summary>
        <div class="menuItems">
          <button id="menuToolsNone" disabled>(none)</button>
        </div>
      </details>
      <details>
        <summary id="sumWindow">Window</summary>
        <div class="menuItems">
          <button id="menuToggleDock">Mindmap: Toggle Dock Maximized</button>
        </div>
      </details>
      <details>
        <summary id="sumHelp">Help</summary>
        <div class="menuItems">
          <button id="menuHelpStatusTip" disabled>状态栏提示</button>
          <button id="menuToggleDebugBounds">Toggle Debug Bounds</button>
        </div>
      </details>
      <details>
        <summary id="sumLanguage">Language</summary>
        <div class="menuItems">
          <button id="menuLangZh">中文</button>
          <button id="menuLangEn">English</button>
        </div>
      </details>
    </div>

    <div class="mainRow">
      <div class="vtoolbar" id="vtoolbar">
        <button id="btnToggleToolbar" class="toolbarToggle" type="button" title="Collapse/Expand Toolbar"><<</button>
        <button id="btnNew">＋</button>
        <button id="btnOpen">📂</button>
        <button id="btnSave">💾</button>
        <button id="btnSaveAs">🖫</button>
      </div>
      <div class="canvas_wrap" id="canvasWrap" tabindex="0">
        <div class="gridLayer" id="gridLayer"></div>
        <div class="fallbackTree hidden" id="fallbackTree"></div>
        <div class="rootMirror hidden" id="rootMirror"></div>
        <div class="debugBounds debugViewportFrame hidden" id="debugViewportFrame">
          <span class="debugBoundsLabel" id="debugViewportLabel">Visible region</span>
        </div>
        <div class="debugBounds debugInnerFrame hidden" id="debugInnerFrame">
          <span class="debugBoundsLabel" id="debugInnerLabel">Inner region</span>
        </div>
        <div id="jsmind_container"></div>
      </div>
      <div class="attrPanel" id="attrPanel">
        <button id="btnToggleAttrPanel" class="attrPanelToggle" type="button" title="Collapse/Expand Attributes Panel">>></button>
        <div class="attrTabs">
          <button class="attrTab active" id="tabFormat" data-tab="format" title="Format">⚙</button>
          <button class="attrTab" id="tabIcon" data-tab="icon" title="Icon">🖼</button>
        </div>
        <div class="attrContent">
          <div class="attrContentSection active" id="tabContent-format">
            <div class="attrItem"><b>Selected node</b> : Apply Title</div>
            <div class="attrItem">Expand / Collapse / Toggle</div>
            <div class="attrItem">Expand All / Theme / Save (global)</div>
          </div>
          <div class="attrContentSection" id="tabContent-icon">
            <div class="attrItem">Icon editing is not implemented yet.</div>
          </div>
        </div>
      </div>
    </div>
    <div class="statusbar" id="statusbar">
      <div class="statusbarLeft">
        <span id="statusIcon" class="statusIcon">⛔</span>
        <span id="statusbarText">就绪</span>
      </div>
      <div class="statusbarRight">
        <span id="statusbarZoom" class="statusbarZoom" title="双击还原缩放">100%</span>
        <span id="statusbarSaveLight" class="statusbarSaveLight green" role="img" aria-label="save state"></span>
      </div>
    </div>
    <div class="dialogOverlay hidden" id="errorDialog">
      <div class="dialogCard" role="dialog" aria-modal="true" aria-labelledby="errorDialogTitle">
        <div class="dialogTitle" id="errorDialogTitle">操作提示</div>
        <div class="dialogBody" id="errorDialogMessage">-</div>
        <div class="dialogActions">
          <button id="errorDialogConfirm" type="button">确认</button>
        </div>
      </div>
    </div>

    <div class="ctxMenu hidden" id="objCtxMenu">
      <div class="ctxMenuTitle" id="objCtxTitle">对象右键菜单</div>
      <button id="ctxCopyNode">复制</button>
      <button id="ctxCutNode">剪切</button>
      <button id="ctxPasteNode">粘贴</button>
      <button id="ctxPromoteNode">提升</button>
      <button id="ctxDemoteNode">下降</button>
      <button id="ctxAddChild">添加子节点</button>
      <button id="ctxAddSibling">添加兄弟节点</button>
      <button id="ctxDeleteNode">删除当前节点</button>
    </div>
    <div class="ctxMenu hidden" id="canvasCtxMenu">
      <div class="ctxMenuTitle" id="canvasCtxTitle">画布右键菜单</div>
      <button id="ctxPasteCanvas">粘贴到根节点</button>
      <button id="ctxCenterRoot">根节点居正显示</button>
      <button id="ctxFitAll">全部显示</button>
      <button id="ctxResetZoom">还原缩放比例</button>
    </div>

    <script nonce="${nonce}" src="${jsmindScriptUrl}"></script>
    <script nonce="${nonce}">
      const __MINDMAP_BOOT__ = ${bootJsonForHtml};
      (function () {
        const vscode = acquireVsCodeApi();

        window.addEventListener('error', function (ev) {
          try {
            var msg =
              ev.error && ev.error.message
                ? ev.error.message
                : String(ev.message || 'Script error');
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
        /** @type {any} */
        let selectedNode = null;
        let rootId = null;
        let currentLang = 'en';
        let currentTheme = 'primary';
        const supportedThemes = [
          'default', 'primary', 'warning', 'danger', 'success', 'info',
          'greensea', 'nephrite', 'belizehole', 'wisteria', 'asphalt',
          'orange', 'pumpkin', 'pomegranate', 'clouds', 'asbestos'
        ];

        const statusbarEl = document.getElementById('statusbar');
        const statusbarTextEl = document.getElementById('statusbarText');
        const statusbarZoomEl = document.getElementById('statusbarZoom');
        const statusbarSaveLightEl = document.getElementById('statusbarSaveLight');
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
            ctxDeleteNode: 'Delete Current Node',
            ctxCopyNode: 'Copy',
            ctxCutNode: 'Cut',
            ctxPasteNode: 'Paste',
            ctxPasteCanvas: 'Paste Under Root',
            ctxPromoteNode: 'Promote',
            ctxDemoteNode: 'Demote',
            ctxCenterRoot: 'Center Root Node',
            ctxFitAll: 'Fit All',
            ctxResetZoom: 'Reset Zoom',
            menuHelpStatusTip: 'Status Tip',
            sumFile: 'File',
            sumEdit: 'Edit',
            sumView: 'View',
            sumInsert: 'Insert',
            sumModify: 'Modify',
            sumTheme: 'Theme',
            sumTools: 'Tools',
            sumWindow: 'Window',
            sumHelp: 'Help',
            sumLanguage: 'Language',
            menuNew: 'New',
            menuOpen: 'Open',
            menuSave: 'Save',
            menuSaveAs: 'Save As',
            menuApplyTitle: 'Apply Title',
            menuCopy: 'Copy',
            menuCut: 'Cut',
            menuPaste: 'Paste',
            menuPromote: 'Promote',
            menuDemote: 'Demote',
            menuExpand: 'Expand',
            menuCollapse: 'Collapse',
            menuToggle: 'Toggle',
            menuExpandAll: 'Expand All',
            menuModifyPlaceholder: '(none)',
            menuInsertDisabled: 'Add / Delete / Move',
            menuToolsNone: '(none)',
            menuToggleDock: 'Mindmap: Toggle Dock Maximized',
            menuToggleDebugBounds: 'Toggle Debug Bounds',
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
            ctxDeleteNode: '删除当前节点',
            ctxCopyNode: '复制',
            ctxCutNode: '剪切',
            ctxPasteNode: '粘贴',
            ctxPasteCanvas: '粘贴到根节点',
            ctxPromoteNode: '提升',
            ctxDemoteNode: '下降',
            ctxCenterRoot: '根节点居正显示',
            ctxFitAll: '全部显示',
            ctxResetZoom: '还原缩放比例',
            menuHelpStatusTip: '状态栏提示',
            sumFile: '文件',
            sumEdit: '编辑',
            sumView: '视图',
            sumInsert: '插入',
            sumModify: '修改',
            sumTheme: '主题',
            sumTools: '工具',
            sumWindow: '窗口',
            sumHelp: '帮助',
            sumLanguage: '语言',
            menuNew: '新建',
            menuOpen: '打开',
            menuSave: '保存',
            menuSaveAs: '另存为',
            menuApplyTitle: '应用标题',
            menuCopy: '复制',
            menuCut: '剪切',
            menuPaste: '粘贴',
            menuPromote: '提升',
            menuDemote: '下降',
            menuExpand: '展开',
            menuCollapse: '折叠',
            menuToggle: '切换展开/折叠',
            menuExpandAll: '全部展开',
            menuModifyPlaceholder: '（无）',
            menuInsertDisabled: '添加 / 删除 / 移动',
            menuToolsNone: '（无）',
            menuToggleDock: '脑图：最大化/还原停靠区',
            menuToggleDebugBounds: '切换调试边界框',
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
          byId('sumTheme', t('sumTheme'));
          byId('sumTools', t('sumTools'));
          byId('sumWindow', t('sumWindow'));
          byId('sumHelp', t('sumHelp'));
          byId('sumLanguage', t('sumLanguage'));
          byId('menuNew', t('menuNew'));
          byId('menuOpen', t('menuOpen'));
          byId('menuSave', t('menuSave'));
          byId('menuSaveAs', t('menuSaveAs'));
          byId('menuApplyTitle', t('menuApplyTitle'));
          byId('menuCopy', t('menuCopy'));
          byId('menuCut', t('menuCut'));
          byId('menuPaste', t('menuPaste'));
          byId('menuPromote', t('menuPromote'));
          byId('menuDemote', t('menuDemote'));
          byId('menuExpand', t('menuExpand'));
          byId('menuCollapse', t('menuCollapse'));
          byId('menuToggle', t('menuToggle'));
          byId('menuExpandAll', t('menuExpandAll'));
          byId('menuModifyPlaceholder', t('menuModifyPlaceholder'));
          byId('menuToggleDock', t('menuToggleDock'));
          byId('menuToggleDebugBounds', t('menuToggleDebugBounds'));
          byId('menuInsertDisabled', t('menuInsertDisabled'));
          byId('menuToolsNone', t('menuToolsNone'));
          byId('menuHelpStatusTip', t('menuHelpStatusTip'));
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
          refreshDebugBounds();
          applySaveTrafficLight(saveTrafficLightState);
        }

        function setStatus(text, isError) {
          if (statusbarTextEl) statusbarTextEl.textContent = text;
          if (statusbarEl) statusbarEl.classList.toggle('error', !!isError);
        }

        function showErrorDialog(message) {
          pendingMcpNoticeRequestId = null;
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

        function escapeHtml(s) {
          return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
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
          fallbackTreeEl.innerHTML =
            '<div style="font-weight:700;margin-bottom:6px;">' +
            (currentLang === 'zh' ? '脑图渲染降级视图' : 'Mindmap Fallback View') +
            '</div><ul>' +
            makeFallbackTreeHtml(root) +
            '</ul>';
          fallbackTreeEl.classList.remove('hidden');
        }
        function hideFallbackTree() {
          if (!fallbackTreeEl) return;
          fallbackTreeEl.classList.add('hidden');
          fallbackTreeEl.innerHTML = '';
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
          const titleEl = document.getElementById('errorDialogTitle');
          if (titleEl) titleEl.textContent = titleText || 'MCP';
          if (errorDialogConfirmBtn) errorDialogConfirmBtn.textContent = t('dialogConfirm');
          if (errorDialogMsgEl) errorDialogMsgEl.textContent = message || '';
          if (errorDialogEl) errorDialogEl.classList.remove('hidden');
          if (errorDialogConfirmBtn) errorDialogConfirmBtn.focus();
        }

        // Toolbar / attribute panel collapse state.
        const vtoolbarEl = document.getElementById('vtoolbar');
        const btnToggleToolbar = document.getElementById('btnToggleToolbar');
        const attrPanelEl = document.getElementById('attrPanel');
        const btnToggleAttrPanel = document.getElementById('btnToggleAttrPanel');

        let toolbarCollapsed = false;
        let attrCollapsed = false;

        const toolbarLabelMap = {
          btnNew: ['New', '＋', 'Ctrl/Cmd+N'],
          btnOpen: ['Open', '📂', 'Ctrl/Cmd+O'],
          btnSave: ['Save', '💾', 'Ctrl/Cmd+S'],
          btnSaveAs: ['Save As', '🖫', 'Ctrl/Cmd+Shift+S']
        };

        function applyToolbarMode(collapsed) {
          toolbarCollapsed = collapsed;
          if (!vtoolbarEl) return;
          vtoolbarEl.classList.toggle('collapsed', collapsed);

          if (btnToggleToolbar) btnToggleToolbar.textContent = collapsed ? '>>' : '<<';

          for (const id of Object.keys(toolbarLabelMap)) {
            const btn = document.getElementById(id);
            if (!btn) continue;
            const full = toolbarLabelMap[id][0];
            const icon = toolbarLabelMap[id][1];
            const shortcut = toolbarLabelMap[id][2];
            btn.title = shortcut ? (full + ' (' + shortcut + ')') : full;
            btn.textContent = collapsed ? icon : (icon + ' ' + full);
          }
        }

        function applyAttrMode(collapsed) {
          attrCollapsed = collapsed;
          if (!attrPanelEl) return;
          attrPanelEl.classList.toggle('collapsed', collapsed);

          if (btnToggleAttrPanel) btnToggleAttrPanel.textContent = collapsed ? '<<' : '>>';

          const tabFormat = document.getElementById('tabFormat');
          const tabIcon = document.getElementById('tabIcon');
          if (tabFormat) {
            tabFormat.title = 'Format';
            tabFormat.textContent = '⚙';
          }
          if (tabIcon) {
            tabIcon.title = 'Icon';
            tabIcon.textContent = '🖼';
          }
        }

        if (btnToggleToolbar) {
          btnToggleToolbar.addEventListener('click', function () {
            applyToolbarMode(!toolbarCollapsed);
          });
        }

        if (btnToggleAttrPanel) {
          btnToggleAttrPanel.addEventListener('click', function () {
            applyAttrMode(!attrCollapsed);
          });
        }

        // Initial state: collapsed (as documented in README).
        applyToolbarMode(true);
        applyAttrMode(true);
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

        function makeMindData(tree) {
          // jsMind expects a root node with children.
          function toJmNode(node) {
            return {
              id: node.id,
              topic: node.topic,
              children: (node.children || []).map(toJmNode)
            };
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
            suppressDirty = true;
            if (typeof jsMind === 'undefined') {
              throw new Error('jsMind runtime not loaded');
            }
            // Always reset view state on every (re)load to avoid inheriting stale pan/zoom.
            zoomScale = 1;
            panX = 0;
            panY = 0;
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

            jm.add_event_listener('select_node', function (e) {
              selectedNode = e && e.node ? e.node : null;
              if (canvasWrapEl) {
                canvasWrapEl.focus();
              }
            setSingleSelectStatus(selectedNode);
            });

            jm.add_event_listener('move_node', function () {
              markContentDirty();
              selectedNode = null;
              setStatus(t('ready'));
            });

            jm.add_event_listener('edit_node', function () {
              markContentDirty();
              selectedNode = null;
              setStatus(t('ready'));
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

        // Right panel tabs: simple local UI toggling.
        const tabFormatBtn = document.getElementById('tabFormat');
        const tabIconBtn = document.getElementById('tabIcon');
        function setActiveTab(tabName) {
          const formatSection = document.getElementById('tabContent-format');
          const iconSection = document.getElementById('tabContent-icon');
          if (tabName === 'format') {
            if (tabFormatBtn) tabFormatBtn.classList.add('active');
            if (tabIconBtn) tabIconBtn.classList.remove('active');
            if (formatSection) formatSection.classList.add('active');
            if (iconSection) iconSection.classList.remove('active');
          } else {
            if (tabIconBtn) tabIconBtn.classList.add('active');
            if (tabFormatBtn) tabFormatBtn.classList.remove('active');
            if (iconSection) iconSection.classList.add('active');
            if (formatSection) formatSection.classList.remove('active');
          }
        }
        if (tabFormatBtn) {
          tabFormatBtn.addEventListener('click', function () {
            setActiveTab('format');
          });
        }
        if (tabIconBtn) {
          tabIconBtn.addEventListener('click', function () {
            setActiveTab('icon');
          });
        }

        function getTreeFromMind() {
          function normalize(node) {
            if (!node) {
              return { id: 'root', topic: 'Root', children: [] };
            }
            return {
              id: node.id || ('n_' + Math.random().toString(16).slice(2)),
              topic: String(node.topic != null ? node.topic : ''),
              children: (node.children || []).map(normalize)
            };
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
          return MIND_CLIP_MARKER + '\\n' + JSON.stringify({ root: root });
        }

        function parseMindClipboardText(text) {
          const raw = (text || '').toString();
          if (!raw.startsWith(MIND_CLIP_MARKER)) {
            return null;
          }
          try {
            const json = JSON.parse(raw.slice(MIND_CLIP_MARKER.length).trim());
            if (json && json.root && json.root.topic !== undefined) {
              return json.root;
            }
          } catch (_) {}
          return null;
        }

        function pasteMindDataUnder(parentModelNode, data) {
          if (!jm || !parentModelNode || !data || data.topic === undefined) {
            return false;
          }
          const newId = 'n_' + Math.random().toString(16).slice(2);
          const dir = jmDirectionFromSerialized(data.direction);
          const added = jm.add_node(parentModelNode, newId, String(data.topic || ''), data.data || null, dir);
          if (!added) {
            return false;
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
          return true;
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
          if (!pasteMindDataUnder(parentModelNode, rootData)) {
            notifyInvalidAction(t('alertPasteFailed'));
            return true;
          }
          markContentDirty();
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
          setStatus(message, true);
          showErrorDialog(message);
        }

        // View transform: middle-button pan + wheel zoom.
        const canvasWrapEl = document.getElementById('canvasWrap');
        const gridLayerEl = document.getElementById('gridLayer');
        const debugViewportFrameEl = document.getElementById('debugViewportFrame');
        const debugViewportLabelEl = document.getElementById('debugViewportLabel');
        const debugInnerFrameEl = document.getElementById('debugInnerFrame');
        const debugInnerLabelEl = document.getElementById('debugInnerLabel');
        const jsmindContainerEl = document.getElementById('jsmind_container');
        let debugBoundsEnabled = false;
        let zoomScale = 1;
        let panX = 0;
        let panY = 0;
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

        function refreshDebugBounds() {
          if (!debugBoundsEnabled || !canvasWrapEl) return;
          const wrapRect = canvasWrapEl.getBoundingClientRect();
          if (debugViewportLabelEl) {
            debugViewportLabelEl.textContent =
              (currentLang === 'zh' ? '可见区域' : 'Visible') +
              ': ' + Math.round(wrapRect.width) + 'x' + Math.round(wrapRect.height);
          }

          if (!debugInnerFrameEl || !jsmindContainerEl) return;
          const innerEl = jsmindContainerEl.querySelector('.jsmind-inner');
          if (!innerEl) return;
          const innerRect = innerEl.getBoundingClientRect();
          const left = innerRect.left - wrapRect.left;
          const top = innerRect.top - wrapRect.top;
          debugInnerFrameEl.style.left = left + 'px';
          debugInnerFrameEl.style.top = top + 'px';
          debugInnerFrameEl.style.width = innerRect.width + 'px';
          debugInnerFrameEl.style.height = innerRect.height + 'px';
          if (debugInnerLabelEl) {
            debugInnerLabelEl.textContent =
              (currentLang === 'zh' ? '内层区域' : 'Inner') +
              ': ' + Math.round(innerRect.width) + 'x' + Math.round(innerRect.height) +
              ' @(' + Math.round(left) + ',' + Math.round(top) + ')';
          }
        }

        function setDebugBoundsEnabled(enabled) {
          debugBoundsEnabled = !!enabled;
          if (debugViewportFrameEl) debugViewportFrameEl.classList.toggle('hidden', !debugBoundsEnabled);
          if (debugInnerFrameEl) debugInnerFrameEl.classList.toggle('hidden', !debugBoundsEnabled);
          if (debugBoundsEnabled) {
            refreshDebugBounds();
            setStatus(currentLang === 'zh' ? '已开启调试边界框' : 'Debug bounds enabled');
          } else {
            setStatus(currentLang === 'zh' ? '已关闭调试边界框' : 'Debug bounds disabled');
          }
        }

        function applyViewTransform() {
          if (!jsmindContainerEl) return;
          jsmindContainerEl.style.transformOrigin = '0 0';
          jsmindContainerEl.style.transform = 'translate(' + panX + 'px, ' + panY + 'px) scale(' + zoomScale + ')';
          if (statusbarZoomEl) statusbarZoomEl.textContent = Math.round(zoomScale * 100) + '%';

          if (gridLayerEl) {
            // Infinite grid: keep a fixed full-screen layer and update tile size/offset from pan+zoom.
            const base = Math.min(120, Math.max(6, 20 * zoomScale));
            const offX = ((panX % base) + base) % base;
            const offY = ((panY % base) + base) % base;
            gridLayerEl.style.backgroundSize = base + 'px ' + base + 'px';
            gridLayerEl.style.backgroundPosition = offX + 'px ' + offY + 'px';
          }
          refreshDebugBounds();
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

        function addChild() {
          if (!jm) return;
          const node = getActiveSelectedNode();
          if (!node) {
            notifyInvalidAction(t('alertNoSelectAddChild'));
            return;
          }
          const topic = 'New Node';
          const newId = 'n_' + Math.random().toString(16).slice(2);
          jm.add_node(node, newId, topic, null);
          markContentDirty();
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
          const newId = 'n_' + Math.random().toString(16).slice(2);
          jm.add_node(parentNode, newId, 'New Node', null);
          markContentDirty();
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
        }

        function applyTitle() {
          if (!jm || !selectedNode) return;
          const promptVal = selectedNode && selectedNode.topic ? selectedNode.topic : '';
          const next = window.prompt('Topic title', String(promptVal != null ? promptVal : ''));
          if (next === null) return;
          const topic = next.toString().trim();
          if (!topic) return;
          jm.update_node(selectedNode.id, topic);
          markContentDirty();
        }

        function editSelectedByPrompt() {
          if (!jm || !selectedNode) return;
          const current = selectedNode && selectedNode.topic ? selectedNode.topic : '';
          const next = window.prompt('Edit topic', String(current));
          if (next === null) return;
          const topic = next.toString().trim();
          if (!topic) return;
          jm.update_node(selectedNode.id, topic);
          markContentDirty();
        }

        function doSave() {
          if (!jm) return;
          try {
            setStatus(currentLang === 'zh' ? '正在保存...' : 'Saving...');
            const tree = getTreeFromMind();
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
            const newId = String(op.nodeId || ('n_' + Math.random().toString(16).slice(2)));
            if (!dryRun) {
              jm.add_node(parent, newId, topic, null);
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
            vscode.postMessage({ type: 'mindmap:requestSaveAs', tree: getTreeFromMind() });
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
              return;
            }
            selectedNode = n;
            if (lassoSelectedNodes.length > 1) {
              setMultiSelectStatus();
            } else {
              setSingleSelectStatus(n);
            }
          });
        });

        // Double-click selected node to edit text.
        elOn(jsmindContainerEl, 'dblclick', function () {
          editSelectedByPrompt();
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
        // Enter => sibling, Tab => child; Ctrl/Cmd+C / X 复制剪切子树；V 粘贴见 paste 事件。
        window.addEventListener('keydown', function (e) {
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

          if (e.key === 'Enter') {
            const node = getActiveSelectedNode();
            if (!node) return;
            addSibling();
            e.preventDefault();
            e.stopPropagation();
            return;
          }
          if (e.key === 'Tab') {
            const node = getActiveSelectedNode();
            if (!node) return;
            addChild();
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
                vscode.postMessage({ type: 'mindmap:requestSaveAs', tree: getTreeFromMind() });
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
          const newId = 'n_' + Math.random().toString(16).slice(2);
          jm.add_node(node, newId, topic, null);
          markContentDirty();
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
          refreshDebugBounds();
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

        elOn(statusbarZoomEl, 'dblclick', function () {
          resetZoom();
        });

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
            vscode.postMessage({ type: 'mindmap:requestSaveAs', tree: getTreeFromMind() });
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
        bindByIdClick('menuApplyTitle', applyTitle);
        bindByIdClick('menuExpand', expandSelected);
        bindByIdClick('menuCollapse', collapseSelected);
        bindByIdClick('menuToggle', toggleSelected);
        bindByIdClick('menuExpandAll', expandAll);
        function applyTheme(name) {
          const themeName = (name || '').toString().trim().toLowerCase();
          if (!themeName) return;
          if (!supportedThemes.includes(themeName)) {
            notifyInvalidAction(t('invalidTheme') + themeName);
            return;
          }
          currentTheme = themeName;
          if (jm && jm.set_theme) jm.set_theme(currentTheme);
          setStatus((currentLang === 'zh' ? '主题：' : 'Theme: ') + currentTheme);
        }
        const themeItems = document.querySelectorAll('.themeItem[data-theme]');
        for (const btn of themeItems) {
          btn.addEventListener('click', function () {
            const themeName = btn.getAttribute('data-theme') || '';
            applyTheme(themeName);
          });
        }
        bindByIdClick('menuLangZh', function () {
          applyLanguage('zh');
          vscode.postMessage({ type: 'mindmap:setUiLanguage', language: 'zh' });
        });
        bindByIdClick('menuLangEn', function () {
          applyLanguage('en');
          vscode.postMessage({ type: 'mindmap:setUiLanguage', language: 'en' });
        });
        bindByIdClick('menuToggleDock', function () {
          vscode.postMessage({ type: 'mindmap:requestToggleDock' });
        });
        bindByIdClick('menuToggleDebugBounds', function () {
          setDebugBoundsEnabled(!debugBoundsEnabled);
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
    </script>
  </body>
</html>`;
  }
}

function getNonce() {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) text += possible.charAt(Math.floor(Math.random() * possible.length));
  return text;
}

