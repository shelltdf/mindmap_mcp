import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';
import {
  MindmapTree,
  MindmapExt,
  createBlankMindmapTree,
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
      const tree = createBlankMindmapTree();
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
  /**
   * Webview 内脚本已跑完并上报 `mindmap:ready` 后为 true；之后换树只 postMessage，避免整页重设 `webview.html` 造成白屏闪烁。
   * 文档：`ai-software-engineering/02-physical/mindmap-vscode-extension/spec.md`（脑图数据与 Webview 初始化 / 换树策略）。
   */
  private _webviewJsReady = false;
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
    this._ext = ext;
    this._syncTitleBase();
    this._dirty = false;
    this._applyTitle();

    // 首次加载：必须把树塞进 HTML，否则脚本末尾才注册 message 监听器时 postMessage 会丢。
    // 之后（已 mindmap:ready）：只 postMessage 换树，避免整页替换 webview.html 导致明显白屏/闪烁。
    if (this._webviewJsReady) {
      void this._panel.webview.postMessage({
        type: 'mindmap:setTree',
        tree,
        ext,
        uiLanguage: this._uiLanguage
      });
      void this._syncBackingFileWatcherAfterLoad();
      return;
    }

    await this._prepareWebviewHtmlReload();
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
      tree = createBlankMindmapTree();
    } else {
      try {
        tree = parseMindmapText(text, this._ext!);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await vscode.window.showErrorMessage(`脑图解析失败：${msg}`);
        tree = createBlankMindmapTree();
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
      this._webviewJsReady = true;
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

    if (msg.type === 'mindmap:requestToggleFullScreen') {
      await this._safeExec('workbench.action.toggleFullScreen');
      return;
    }

    if (msg.type === 'mindmap:requestNew') {
      this._filePath = undefined;
      await this.setTree(createBlankMindmapTree(), 'mmd');
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
    const mindmapCoreUrl = webview
      .asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'mindmap-core.js'))
      .toString();
    const jsmindScriptUrl = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'jsmind', 'jsmind.js')).toString();
    const jsmindCssUrl = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'jsmind', 'jsmind.css')).toString();
    /** 标题栏图标：与 package.json 的 `"icon": "media/icon.png"` 同源（扩展根目录下 mindmap_vscode/media/icon.png）。 */
    const appTitleIconPngUrl = webview
      .asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'icon.png'))
      .toString();

    return /* html */ `<!DOCTYPE html>
<html lang="zh">
  <head>
    <meta charset="UTF-8" />
    <!-- 与 --mm-bg-app 一致；具体明暗由下方脚本尽早设置 data-mm-ui -->
    <style>
      html {
        background-color: #f1f5f9;
      }
      html[data-mm-ui='dark'] {
        background-color: #0f172a;
      }
    </style>
    <script nonce="${nonce}">
      (function () {
        try {
          var m = localStorage.getItem('mindmapUiThemeMode') || 'system';
          var dark = false;
          if (m === 'dark') dark = true;
          else if (m === 'light') dark = false;
          else dark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
          document.documentElement.setAttribute('data-mm-ui', dark ? 'dark' : 'light');
        } catch (e) {}
      })();
    </script>
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; img-src ${cspSource} https: data:; style-src 'unsafe-inline' ${cspSource}; script-src 'nonce-${nonce}' ${cspSource}; connect-src ${cspSource} https:; font-src ${cspSource} https: data:; "
    />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" type="text/css" href="${jsmindCssUrl}" />
    <style>
      :root {
        --mm-font-sans: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
        --mm-font-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        --mm-text: #0f172a;
        --mm-text-secondary: #334155;
        --mm-text-muted: #64748b;
        --mm-border: #e2e8f0;
        --mm-border-strong: #cbd5e1;
        --mm-bg-app: #f1f5f9;
        --mm-bg-surface: #ffffff;
        --mm-bg-subtle: #f8fafc;
        --mm-bg-toolbar: #e8edf4;
        --mm-bg-dock: #dfe6f0;
        --mm-bg-dock-edge: #cfd6e0;
        --mm-bg-canvas: #e2e8f0;
        --mm-space-1: 4px;
        --mm-space-2: 8px;
        --mm-space-3: 12px;
        --mm-space-4: 16px;
        --mm-space-5: 20px;
        --mm-radius-sm: 6px;
        --mm-radius-md: 8px;
        --mm-radius-lg: 10px;
        --mm-font-caption: 0.6875rem;
        --mm-font-small: 0.75rem;
        --mm-font-ui: 0.8125rem;
        /* 主菜单条：与 Windows 经典菜单栏对齐（Segoe UI + 12px） */
        --mm-font-menu-windows: 'Segoe UI', 'Segoe UI Variable', 'Segoe UI Symbol', SegoeUI, system-ui, sans-serif;
        --mm-font-menu-size: 12px;
        --mm-font-body: 0.875rem;
        --mm-font-title: 1.0625rem;
        --mm-line-tight: 1.25;
        --mm-line-normal: 1.45;
        --mm-shadow-inset: inset 0 1px 0 rgba(255, 255, 255, 0.65);
        --mm-shadow-sm: 0 1px 2px rgba(15, 23, 42, 0.06);
        --mm-shadow-md: 0 4px 14px rgba(15, 23, 42, 0.07);
        --mm-shadow-dialog: 0 12px 36px rgba(15, 23, 42, 0.12);
      }
      html[data-mm-ui='dark'] {
        color-scheme: dark;
        --mm-text: #e2e8f0;
        --mm-text-secondary: #cbd5e1;
        --mm-text-muted: #94a3b8;
        --mm-border: #334155;
        --mm-border-strong: #475569;
        --mm-bg-app: #0f172a;
        --mm-bg-surface: #1e293b;
        --mm-bg-subtle: #334155;
        --mm-bg-toolbar: #1e293b;
        --mm-bg-dock: #1e293b;
        --mm-bg-dock-edge: #334155;
        --mm-bg-canvas: #0f172a;
        --mm-shadow-inset: inset 0 1px 0 rgba(255, 255, 255, 0.04);
        --mm-shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.25);
        --mm-shadow-md: 0 4px 14px rgba(0, 0, 0, 0.35);
        --mm-shadow-dialog: 0 12px 36px rgba(0, 0, 0, 0.45);
      }
      html[data-mm-ui='dark'] .appTitleBar {
        background: linear-gradient(180deg, var(--mm-bg-subtle) 0%, #1e293b 55%, var(--mm-bg-toolbar) 100%);
      }
      html[data-mm-ui='dark'] .appTitleIconWrap {
        background: linear-gradient(145deg, #334155 0%, #1e293b 100%);
        box-shadow:
          0 1px 2px rgba(0, 0, 0, 0.35),
          0 4px 12px rgba(37, 99, 235, 0.12);
      }
      html[data-mm-ui='dark'] .appTitleName {
        background: linear-gradient(105deg, #93c5fd 0%, #60a5fa 45%, #a5b4fc 100%);
        -webkit-background-clip: text;
        background-clip: text;
        -webkit-text-fill-color: transparent;
      }
      @supports not (background-clip: text) {
        html[data-mm-ui='dark'] .appTitleName {
          color: #93c5fd;
          background: none;
          -webkit-text-fill-color: unset;
        }
      }
      html[data-mm-ui='dark'] .dock-titlebar {
        background: linear-gradient(180deg, #334155 0%, #1e293b 100%);
      }
      html[data-mm-ui='dark'] .canvas-zoom-action-btn {
        border-color: rgba(255, 255, 255, 0.12);
        background: rgba(30, 41, 59, 0.88);
        box-shadow: 0 1px 2px rgba(0, 0, 0, 0.2);
      }
      html[data-mm-ui='dark'] .canvas-zoom-action-btn:hover {
        background: rgba(51, 65, 85, 0.95);
      }
      html[data-mm-ui='dark'] .canvas-zoom-badge {
        background: rgba(30, 41, 59, 0.75);
        border-color: rgba(255, 255, 255, 0.1);
      }
      html[data-mm-ui='dark'] .canvas-zoom-badge:hover {
        background: rgba(51, 65, 85, 0.88);
      }
      html[data-mm-ui='dark'] .canvas-zoom-btn {
        background: rgba(255, 255, 255, 0.08);
      }
      html[data-mm-ui='dark'] .canvas-zoom-btn:hover {
        background: rgba(255, 255, 255, 0.14);
      }
      html[data-mm-ui='dark'] .statusbar.error {
        color: #fca5a5;
      }
      body {
        margin: 0;
        padding: 0;
        height: 100vh;
        overflow: hidden;
        font-family: var(--mm-font-sans);
        font-size: var(--mm-font-body);
        line-height: var(--mm-line-normal);
        color: var(--mm-text);
        -webkit-font-smoothing: antialiased;
        display: flex;
        flex-direction: column;
        background: var(--mm-bg-app);
      }
      /* 顶栏：扩展图标 + 产品名（与菜单栏分离，便于识别应用） */
      .appTitleBar {
        flex: 0 0 auto;
        display: flex;
        flex-direction: row;
        align-items: center;
        justify-content: space-between;
        gap: var(--mm-space-3);
        padding: var(--mm-space-3) var(--mm-space-4);
        background: linear-gradient(180deg, var(--mm-bg-subtle) 0%, #eef2f7 55%, var(--mm-bg-toolbar) 100%);
        border-bottom: 1px solid var(--mm-border-strong);
        box-shadow: var(--mm-shadow-inset);
        z-index: 31;
      }
      .appTitleBrand {
        display: flex;
        align-items: center;
        gap: var(--mm-space-3);
        min-width: 0;
        flex: 1 1 auto;
      }
      .appTitleIconWrap {
        flex: 0 0 auto;
        width: 40px;
        height: 40px;
        border-radius: var(--mm-radius-lg);
        overflow: hidden;
        box-shadow:
          0 1px 2px rgba(15, 23, 42, 0.08),
          0 4px 12px rgba(37, 99, 235, 0.15);
        background: linear-gradient(145deg, #fff 0%, #f1f5f9 100%);
      }
      .appTitleIconWrap img {
        display: block;
        width: 100%;
        height: 100%;
        object-fit: contain;
        object-position: center;
        box-sizing: border-box;
        padding: 1px;
      }
      .appTitleIconWrap .appTitleIconFallback {
        display: none;
        width: 100%;
        height: 100%;
      }
      .appTitleIconWrap.fallback-png-missing .appTitleIconImg { display: none; }
      .appTitleIconWrap.fallback-png-missing .appTitleIconFallback { display: block; }
      .appTitleTextCol {
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        justify-content: center;
        gap: var(--mm-space-1);
        min-width: 0;
      }
      .appTitleName {
        font-size: var(--mm-font-title);
        font-weight: 750;
        letter-spacing: -0.03em;
        line-height: var(--mm-line-tight);
        color: var(--mm-text);
        background: linear-gradient(105deg, #0f172a 0%, #1d4ed8 45%, #6366f1 100%);
        -webkit-background-clip: text;
        background-clip: text;
        -webkit-text-fill-color: transparent;
      }
      @supports not (background-clip: text) {
        .appTitleName {
          color: #1e3a8a;
          background: none;
          -webkit-text-fill-color: unset;
        }
      }
      .appTitleSub {
        font-size: var(--mm-font-caption);
        font-weight: 600;
        letter-spacing: 0.05em;
        text-transform: uppercase;
        color: var(--mm-text-muted);
      }
      .appTitleBarActions {
        flex: 0 0 auto;
        display: flex;
        align-items: center;
        gap: var(--mm-space-2);
        margin-left: var(--mm-space-2);
      }
      .appTitleBarFullScreenBtn {
        box-sizing: border-box;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 36px;
        height: 36px;
        padding: 0;
        border-radius: var(--mm-radius-md);
        border: 1px solid var(--mm-border-strong);
        background: var(--mm-bg-surface);
        color: var(--mm-text-secondary);
        cursor: pointer;
        box-shadow: var(--mm-shadow-sm);
      }
      .appTitleBarFullScreenBtn:hover {
        background: var(--mm-bg-subtle);
        color: var(--mm-text);
      }
      .appTitleBarFullScreenBtn svg {
        display: block;
        flex: 0 0 auto;
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
        gap: var(--mm-space-3);
        padding: 3px var(--mm-space-3);
        border-bottom: 1px solid var(--mm-border);
        background: var(--mm-bg-surface);
        overflow: visible;
        position: relative;
        z-index: 30;
        color: var(--mm-text);
        font-family: var(--mm-font-menu-windows);
        font-size: var(--mm-font-menu-size);
        font-weight: 400;
        -webkit-font-smoothing: antialiased;
      }
      .menubar details {
        position: relative;
      }
      .menubar summary {
        list-style: none;
        cursor: pointer;
        user-select: none;
        padding: 3px var(--mm-space-2);
        margin: calc(-1 * 3px) calc(-1 * var(--mm-space-2));
        border-radius: var(--mm-radius-sm);
        font-family: var(--mm-font-menu-windows);
        font-size: var(--mm-font-menu-size);
        font-weight: 400;
        color: var(--mm-text);
      }
      .menubar summary:hover {
        background: var(--mm-bg-subtle);
        color: var(--mm-text);
      }
      .menubar summary::-webkit-details-marker { display: none; }
      .menuItems {
        position: absolute;
        top: 100%;
        left: 0;
        z-index: 10;
        min-width: 200px;
        background: var(--mm-bg-surface);
        border: 1px solid var(--mm-border);
        border-radius: var(--mm-radius-lg);
        padding: var(--mm-space-2);
        box-shadow: var(--mm-shadow-md);
        display: flex;
        flex-direction: column;
        gap: var(--mm-space-1);
      }
      .menubar details:not([open]) .menuItems { display: none; }
      .menuItems button {
        width: 100%;
        text-align: left;
        background: transparent;
        border: 0;
        padding: 5px var(--mm-space-3);
        border-radius: var(--mm-radius-md);
        cursor: pointer;
        color: var(--mm-text);
        font-family: var(--mm-font-menu-windows);
        font-size: var(--mm-font-menu-size);
        font-weight: 400;
      }
      .menuItems button:hover { background: var(--mm-bg-subtle); }
      .menuItems button:disabled {
        color: var(--mm-text-muted);
        cursor: not-allowed;
      }
      /* 主菜单下方的横向工具栏（基础文件操作） */
      .htoolbar {
        flex: 0 0 auto;
        display: flex;
        flex-direction: row;
        flex-wrap: wrap;
        align-items: center;
        gap: var(--mm-space-2);
        padding: var(--mm-space-2) var(--mm-space-3);
        border-bottom: 1px solid var(--mm-border);
        background: var(--mm-bg-toolbar);
      }
      .htoolbar button {
        box-sizing: border-box;
        padding: 0;
        min-width: 36px;
        width: 36px;
        height: 36px;
        border-radius: var(--mm-radius-md);
        border: 1px solid var(--mm-border-strong);
        background: var(--mm-bg-surface);
        cursor: pointer;
        font-size: 1.125rem;
        font-weight: 600;
        line-height: 1;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        box-shadow: var(--mm-shadow-sm);
      }
      .htoolbar button:hover {
        background: var(--mm-bg-subtle);
        border-color: var(--mm-border-strong);
      }

      .dock-edge {
        flex: 0 0 28px;
        width: 28px;
        min-width: 28px;
        display: flex;
        flex-direction: column;
        align-items: center;
        /* 不设左右 padding，避免缘条内有效宽度过小导致 emoji 溢出 */
        padding: var(--mm-space-2) 0;
        box-sizing: border-box;
        border-right: none;
        border-left: 1px solid var(--mm-border-strong);
        background: var(--mm-bg-dock-edge);
      }
      .dock-edge-btn {
        box-sizing: border-box;
        width: 100%;
        max-width: 100%;
        min-width: 0;
        min-height: 34px;
        padding: 4px 2px;
        border-radius: var(--mm-radius-md);
        border: 1px solid var(--mm-border-strong);
        background: var(--mm-bg-subtle);
        cursor: pointer;
        font-weight: 700;
        font-size: 0.8125rem;
        line-height: 1;
        flex: 0 0 auto;
        overflow: hidden;
        display: inline-flex;
        align-items: center;
        justify-content: center;
      }

      /* Keep a 16:9-ish canvas on the right side. */
      .canvas_wrap {
        flex: 1 1 auto;
        min-width: 0;
        min-height: 0;
        height: 100%;
        width: 100%;
        overflow: hidden !important;
        display: flex;
        align-items: stretch;
        justify-content: stretch;
        background-color: var(--mm-bg-canvas);
        position: relative;
      }
      /* Shortcut strip: hover shows popover; last child of canvas_wrap, z-index over jsMind */
      .canvas-shortcut-hints {
        position: absolute;
        left: var(--mm-space-3);
        top: var(--mm-space-3);
        z-index: 25;
        isolation: isolate;
        pointer-events: auto;
        margin: 0;
        padding: 0;
      }
      .canvas-shortcut-hints-trigger {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 7px 12px;
        box-sizing: border-box;
        border-radius: var(--mm-radius-sm);
        font-size: 11px;
        letter-spacing: 0.01em;
        font-weight: 600;
        color: #ffffff;
        text-shadow: 0 1px 2px rgba(0, 0, 0, 0.55);
        background: rgba(15, 23, 42, 0.55);
        border: 1px solid rgba(255, 255, 255, 0.18);
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.12);
        cursor: default;
        user-select: none;
        max-width: min(420px, 92vw);
      }
      .canvas-shortcut-hints:hover .canvas-shortcut-hints-trigger,
      .canvas-shortcut-hints:focus-within .canvas-shortcut-hints-trigger {
        background: rgba(15, 23, 42, 0.72);
      }
      .canvas-shortcut-hints-trigger:focus-visible {
        outline: 2px solid rgba(255, 255, 255, 0.65);
        outline-offset: 1px;
      }
      .canvas-shortcut-hints-popover {
        display: none;
        position: absolute;
        left: 0;
        top: 100%;
        margin: 0;
        min-width: min(300px, calc(100vw - 48px));
        max-width: min(420px, calc(100vw - 48px));
        max-height: min(70vh, 520px);
        overflow-x: hidden;
        overflow-y: auto;
        padding: 10px 12px 12px;
        box-sizing: border-box;
        font-size: 11px;
        line-height: 1.55;
        letter-spacing: 0.01em;
        white-space: pre-line;
        color: #ffffff;
        text-shadow: 0 1px 2px rgba(0, 0, 0, 0.55);
        background: rgba(15, 23, 42, 0.94);
        border: 1px solid rgba(255, 255, 255, 0.22);
        border-radius: var(--mm-radius-sm);
        box-shadow: 0 10px 28px rgba(0, 0, 0, 0.38);
        pointer-events: auto;
        user-select: text;
      }
      .canvas-shortcut-hints:hover .canvas-shortcut-hints-popover,
      .canvas-shortcut-hints:focus-within .canvas-shortcut-hints-popover {
        display: block;
      }
      html[data-mm-ui='dark'] .canvas-shortcut-hints-trigger {
        background: rgba(15, 23, 42, 0.62);
        border-color: rgba(255, 255, 255, 0.14);
      }
      html[data-mm-ui='dark'] .canvas-shortcut-hints:hover .canvas-shortcut-hints-trigger,
      html[data-mm-ui='dark'] .canvas-shortcut-hints:focus-within .canvas-shortcut-hints-trigger {
        background: rgba(15, 23, 42, 0.78);
      }
      .gridLayer {
        position: absolute;
        inset: 0;
        z-index: 0;
        pointer-events: none;
        background-color: var(--mm-bg-canvas);
        background-image:
          linear-gradient(rgba(90, 100, 120, 0.10) 1px, transparent 1px),
          linear-gradient(90deg, rgba(90, 100, 120, 0.10) 1px, transparent 1px);
        background-size: 20px 20px;
      }
      .fallbackTree {
        position: absolute;
        inset: var(--mm-space-3);
        z-index: 9;
        overflow: auto;
        background: rgba(255, 255, 255, 0.94);
        border: 1px solid var(--mm-border-strong);
        border-radius: var(--mm-radius-md);
        padding: var(--mm-space-3);
        font-size: var(--mm-font-ui);
        line-height: var(--mm-line-normal);
        color: var(--mm-text);
      }
      .fallbackTree.hidden { display: none; }
      .rootMirror {
        position: absolute;
        left: 50%;
        top: 50%;
        transform: translate(-50%, -50%);
        z-index: 10;
        background: var(--mm-bg-surface);
        color: var(--mm-text);
        border: 1px solid var(--mm-border-strong);
        border-radius: var(--mm-radius-md);
        box-shadow: var(--mm-shadow-md);
        padding: var(--mm-space-2) var(--mm-space-3);
        font-size: var(--mm-font-body);
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

      /* 与壳层字体阶梯协调：脑图节点默认字号与行高 */
      #jsmind_container jmnode,
      #jsmind_container .jmnode {
        font-size: var(--mm-font-body);
        line-height: var(--mm-line-normal);
      }

      /* 右侧 Dock 容器：纵向叠放多个 Dock；折叠时缘条在右侧上下排列 */
      .dock-right-stack {
        flex: 0 0 auto;
        display: flex;
        flex-direction: column;
        align-items: stretch;
        justify-content: flex-start;
        align-self: stretch;
        min-height: 0;
        height: 100%;
        max-height: 100%;
        overflow-x: hidden;
        overflow-y: auto;
        background: var(--mm-bg-dock);
        border-left: 1px solid var(--mm-border);
      }
      /* 每个 Dock：[ 画布侧显示区 | 缘条 ]；展开时分摊纵向剩余高度 */
      .dock-right {
        flex: 0 0 auto;
        display: flex;
        flex-direction: row;
        align-items: stretch;
        min-height: 0;
        min-width: 0;
        background: var(--mm-bg-dock);
      }
      /* 折叠后整行只占缘条宽度，并靠栈的右侧（窗口右缘），避免缘条漂在列中间 */
      .dock-right-stack .dock-right.collapsed {
        flex: 0 0 auto;
        align-self: flex-end;
        width: fit-content;
        max-width: 100%;
        align-items: flex-start;
      }
      /* 未最大化：展开高度随内容，不强行占满整列（避免短内容也撑满半屏） */
      .dock-right-stack .dock-right:not(.collapsed):not(.dock-maximized) {
        flex: 0 0 auto;
        min-height: 0;
      }
      .dock-titlebar {
        flex: 0 0 auto;
        display: flex;
        flex-direction: row;
        align-items: center;
        justify-content: space-between;
        gap: var(--mm-space-2);
        padding: var(--mm-space-2) var(--mm-space-3);
        background: linear-gradient(180deg, #e8ecf4 0%, #dce3ee 100%);
        border-bottom: 1px solid var(--mm-border-strong);
        border-radius: 0;
        font-size: var(--mm-font-ui);
        font-weight: 700;
        color: var(--mm-text-secondary);
        min-height: 34px;
        box-sizing: border-box;
      }
      .dock-title {
        flex: 1 1 auto;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .dock-title-actions {
        flex: 0 0 auto;
        display: inline-flex;
        flex-direction: row;
        align-items: center;
        gap: 4px;
      }
      .dock-title-btn {
        width: 28px;
        height: 26px;
        padding: 0;
        line-height: 1;
        border-radius: var(--mm-radius-sm);
        border: 1px solid var(--mm-border-strong);
        background: var(--mm-bg-subtle);
        cursor: pointer;
        font-size: var(--mm-font-ui);
        font-weight: 700;
        color: var(--mm-text-secondary);
        display: inline-flex;
        align-items: center;
        justify-content: center;
      }
      .dock-title-btn:hover {
        background: var(--mm-bg-surface);
      }
      .dock-right .dock-display {
        flex: 0 0 auto;
        width: 208px;
        min-width: 208px;
        padding: 0;
        border-left: 1px solid var(--mm-border);
        display: flex;
        flex-direction: column;
        gap: 0;
        overflow: hidden;
        box-sizing: border-box;
        transition: width 0.12s ease, min-width 0.12s ease, padding 0.12s ease, opacity 0.12s ease;
      }
      /* 最大化时：显示区在横轴上仍固定宽度，纵向上 stretch 占满该 Dock 行高（父级已 flex:1 分到高度） */
      .dock-right.dock-maximized:not(.collapsed) .dock-display {
        flex: 0 0 auto;
        align-self: stretch;
        min-height: 0;
      }
      .dock-right .dock-display > .attrContent {
        margin: var(--mm-space-2) var(--mm-space-3) var(--mm-space-3) var(--mm-space-3);
      }
      .dock-right-stack .dock-right.dock-maximized:not(.collapsed) {
        flex: 1 1 auto !important;
        min-height: 0;
      }
      .dock-right-stack .dock-right.dock-peer-squash:not(.collapsed) {
        flex: 0 0 auto !important;
        min-height: 0;
        max-height: 42%;
      }
      .dock-right.collapsed .dock-display {
        width: 0 !important;
        min-width: 0 !important;
        max-width: 0 !important;
        height: 0 !important;
        min-height: 0 !important;
        padding: 0 !important;
        margin: 0 !important;
        overflow: hidden !important;
        opacity: 0;
        pointer-events: none;
        border: none !important;
        align-self: flex-start;
        flex: 0 0 0;
      }
      /* 折叠后缘条只占按钮高度，内容顶对齐；横向上按钮贴缘条右侧 */
      .dock-right.collapsed .dock-edge {
        justify-content: flex-start;
        align-items: flex-end;
        padding-top: 4px;
        padding-bottom: 4px;
        align-self: stretch;
        height: auto;
        min-height: 0;
      }

      .attrContent {
        flex: 1 1 auto;
        min-height: 0;
        overflow: auto;
        border-radius: var(--mm-radius-lg);
        border: 1px solid var(--mm-border);
        padding: var(--mm-space-3);
        background: var(--mm-bg-surface);
      }
      .attrItem { font-size: var(--mm-font-ui); color: var(--mm-text-secondary); margin-bottom: var(--mm-space-3); }
      .dock-form-hint {
        font-size: var(--mm-font-small);
        color: var(--mm-text-muted);
        margin-bottom: var(--mm-space-3);
        line-height: var(--mm-line-normal);
      }
      .dock-form-row {
        display: flex;
        flex-direction: column;
        gap: var(--mm-space-1);
        margin-bottom: var(--mm-space-3);
      }
      .dock-form-label {
        font-size: var(--mm-font-small);
        font-weight: 600;
        color: var(--mm-text-secondary);
      }
      .dock-form-row select,
      .dock-form-row input[type='number'] {
        width: 100%;
        max-width: 100%;
        box-sizing: border-box;
        padding: var(--mm-space-1) var(--mm-space-2);
        border-radius: var(--mm-radius-sm);
        border: 1px solid var(--mm-border-strong);
        font-size: var(--mm-font-ui);
      }
      .dock-form-row input[type='color'] {
        width: 100%;
        height: 30px;
        padding: 0;
        border: 1px solid var(--mm-border-strong);
        border-radius: var(--mm-radius-sm);
        cursor: pointer;
      }
      .dock-form-row input[type='text'].dock-readonly-input {
        width: 100%;
        max-width: 100%;
        box-sizing: border-box;
        padding: var(--mm-space-1) var(--mm-space-2);
        border-radius: var(--mm-radius-sm);
        border: 1px solid var(--mm-border-strong);
        font-size: var(--mm-font-ui);
        font-family: var(--mm-font-mono);
        background: var(--mm-bg-subtle);
        color: var(--mm-text-secondary);
        cursor: default;
      }
      .dock-form-row textarea.dock-topic-input {
        width: 100%;
        max-width: 100%;
        box-sizing: border-box;
        min-height: 72px;
        padding: var(--mm-space-1) var(--mm-space-2);
        border-radius: var(--mm-radius-sm);
        border: 1px solid var(--mm-border-strong);
        font-size: var(--mm-font-ui);
        font-family: inherit;
        line-height: var(--mm-line-normal);
        resize: vertical;
      }
      .dock-form-actions {
        display: flex;
        flex-wrap: wrap;
        gap: var(--mm-space-2);
        margin-top: var(--mm-space-1);
      }
      .dock-apply-btn {
        flex: 1 1 auto;
        min-width: 72px;
        padding: var(--mm-space-2) var(--mm-space-3);
        font-size: var(--mm-font-ui);
        font-weight: 600;
        border-radius: var(--mm-radius-md);
        border: 1px solid var(--mm-border-strong);
        background: var(--mm-bg-subtle);
        cursor: pointer;
        color: var(--mm-text-secondary);
      }
      .dock-apply-btn:hover {
        background: var(--mm-bg-toolbar);
      }
      .dock-apply-btn.dock-secondary {
        background: var(--mm-bg-surface);
      }
      .dock-form.dock-disabled {
        opacity: 0.55;
        pointer-events: none;
      }
      .dock-icon-grid {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: var(--mm-space-2);
      }
      .dock-icon-btn {
        min-height: 38px;
        padding: var(--mm-space-1) var(--mm-space-1);
        border-radius: var(--mm-radius-md);
        border: 1px solid var(--mm-border-strong);
        background: var(--mm-bg-subtle);
        cursor: pointer;
        font-size: 1.125rem;
        line-height: 1.2;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: var(--mm-space-1);
      }
      .dock-icon-btn:hover {
        background: var(--mm-bg-toolbar);
      }
      .dock-icon-btn.mm-selected {
        border-color: #2563eb;
        background: #dbeafe;
        box-shadow: 0 0 0 1px #2563eb inset;
      }
      .dock-icon-btn .dock-icon-label {
        font-size: var(--mm-font-caption);
        font-weight: 600;
        color: var(--mm-text-muted);
        max-width: 100%;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .dock-jsmind-theme-grid {
        display: grid;
        grid-template-columns: repeat(2, 1fr);
        gap: var(--mm-space-2);
      }
      .dock-jsmind-theme-btn {
        display: flex;
        flex-direction: column;
        align-items: stretch;
        gap: 4px;
        min-height: 0;
        padding: 6px;
        border-radius: var(--mm-radius-md);
        border: 1px solid var(--mm-border-strong);
        background: var(--mm-bg-subtle);
        cursor: pointer;
        text-align: center;
      }
      .dock-jsmind-theme-btn:hover {
        background: var(--mm-bg-toolbar);
      }
      .dock-jsmind-theme-preview-wrap {
        display: flex;
        justify-content: center;
        align-items: center;
        min-height: 34px;
        pointer-events: none;
      }
      /* jsmind.css 里 jmnodes/jmnode 为 position:absolute，在 Dock 预览中会脱离按钮布局；此处恢复为流内布局 */
      .dock-jsmind-theme-preview-wrap jmnodes {
        position: relative !important;
        z-index: auto;
        inset: auto !important;
        display: inline-block;
      }
      .dock-jsmind-theme-jmnodes {
        display: inline-block;
      }
      /* 缩略「节点」外观与 jsMind 主题一致（继承 jsmind.css 中 jmnodes.theme-* jmnode 配色） */
      .dock-jsmind-theme-preview-wrap jmnode.dock-jsmind-theme-preview-node {
        position: relative !important;
        left: auto !important;
        top: auto !important;
        font-size: 12px !important;
        line-height: 1.15 !important;
        padding: 5px 10px !important;
        margin: 0 !important;
        display: inline-block;
        min-width: 2.75em;
        text-align: center;
        box-sizing: border-box;
      }
      .dock-jsmind-theme-label {
        font-size: var(--mm-font-caption);
        font-weight: 600;
        line-height: 1.2;
        color: var(--mm-text-muted);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .dock-jsmind-theme-btn.mm-selected {
        border-color: #2563eb;
        background: #dbeafe;
        box-shadow: 0 0 0 1px #2563eb inset;
      }
      .dock-jsmind-theme-btn.mm-selected .dock-jsmind-theme-label {
        color: var(--mm-text);
      }
      html[data-mm-ui='dark'] .dock-jsmind-theme-btn.mm-selected {
        background: rgba(37, 99, 235, 0.28);
      }
      html[data-mm-ui='dark'] .dock-jsmind-theme-btn.mm-selected .dock-jsmind-theme-label {
        color: #e2e8f0;
      }
      .menuItems button.mm-menu-ui-theme-active {
        background: var(--mm-bg-subtle);
        box-shadow: inset 0 0 0 2px #2563eb;
      }
      jmnode.mm-icon-none::before,
      .jmnode.mm-icon-none::before {
        content: none !important;
      }
      jmnode.mm-icon-star::before,
      .jmnode.mm-icon-star::before {
        content: '⭐';
        margin-right: 4px;
      }
      jmnode.mm-icon-flag::before,
      .jmnode.mm-icon-flag::before {
        content: '🚩';
        margin-right: 4px;
      }
      jmnode.mm-icon-bulb::before,
      .jmnode.mm-icon-bulb::before {
        content: '💡';
        margin-right: 4px;
      }
      jmnode.mm-icon-book::before,
      .jmnode.mm-icon-book::before {
        content: '📖';
        margin-right: 4px;
      }
      jmnode.mm-icon-check::before,
      .jmnode.mm-icon-check::before {
        content: '✅';
        margin-right: 4px;
      }
      jmnode.mm-icon-warn::before,
      .jmnode.mm-icon-warn::before {
        content: '⚠️';
        margin-right: 4px;
      }
      jmnode.mm-icon-heart::before,
      .jmnode.mm-icon-heart::before {
        content: '❤️';
        margin-right: 4px;
      }
      jmnode.mm-icon-rocket::before,
      .jmnode.mm-icon-rocket::before {
        content: '🚀';
        margin-right: 4px;
      }
      jmnode.mm-icon-pin::before,
      .jmnode.mm-icon-pin::before {
        content: '📌';
        margin-right: 4px;
      }

      /* 插入菜单：嵌入类型（节点 data.mmEmbed），左侧色条 + 前缀图标 */
      jmnode.mm-embed-image,
      .jmnode.mm-embed-image {
        box-shadow: inset 3px 0 0 #3b82f6;
      }
      jmnode.mm-embed-image::before,
      .jmnode.mm-embed-image::before {
        content: '🖼';
        margin-right: 4px;
      }
      jmnode.mm-embed-text,
      .jmnode.mm-embed-text {
        box-shadow: inset 3px 0 0 #64748b;
      }
      jmnode.mm-embed-text::before,
      .jmnode.mm-embed-text::before {
        content: '📝';
        margin-right: 4px;
      }
      jmnode.mm-embed-whiteboard,
      .jmnode.mm-embed-whiteboard {
        box-shadow: inset 3px 0 0 #8b5cf6;
      }
      jmnode.mm-embed-whiteboard::before,
      .jmnode.mm-embed-whiteboard::before {
        content: '🖍';
        margin-right: 4px;
      }
      jmnode.mm-embed-video,
      .jmnode.mm-embed-video {
        box-shadow: inset 3px 0 0 #dc2626;
      }
      jmnode.mm-embed-video::before,
      .jmnode.mm-embed-video::before {
        content: '🎬';
        margin-right: 4px;
      }
      jmnode.mm-embed-audio,
      .jmnode.mm-embed-audio {
        box-shadow: inset 3px 0 0 #059669;
      }
      jmnode.mm-embed-audio::before,
      .jmnode.mm-embed-audio::before {
        content: '🎵';
        margin-right: 4px;
      }
      jmnode.mm-embed-gltf,
      .jmnode.mm-embed-gltf {
        box-shadow: inset 3px 0 0 #d97706;
      }
      jmnode.mm-embed-gltf::before,
      .jmnode.mm-embed-gltf::before {
        content: '🧊';
        margin-right: 4px;
      }
      jmnode.mm-embed-table,
      .jmnode.mm-embed-table {
        box-shadow: inset 3px 0 0 #0d9488;
      }
      jmnode.mm-embed-table::before,
      .jmnode.mm-embed-table::before {
        content: '⊞';
        margin-right: 4px;
      }

      /* Bottom status bar */
      .statusbar {
        flex: 0 0 auto;
        padding: 2px var(--mm-space-3);
        border-top: 1px solid var(--mm-border);
        background: var(--mm-bg-subtle);
        font-size: var(--mm-font-small);
        line-height: 1.35;
        color: var(--mm-text-muted);
        min-height: 20px;
        height: auto;
        box-sizing: border-box;
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .statusbarLeft {
        display: inline-flex;
        align-items: center;
        gap: var(--mm-space-2);
        min-width: 0;
        flex: 1 1 auto;
      }
      .statusbarRight {
        margin-left: auto;
        display: inline-flex;
        align-items: center;
        gap: var(--mm-space-3);
        flex-shrink: 0;
      }
      .statusbarSaveLight {
        width: 8px;
        height: 8px;
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
      /* 画布左下角：上排 适应 / 根节点 / 还原，下排 − / 百分比 / +；整体约 88% 缩放，兼顾可读与占地 */
      .canvas-zoom-stack {
        position: absolute;
        left: var(--mm-space-3);
        bottom: var(--mm-space-3);
        /* 高于 fallbackTree(9) / rootMirror(10)，避免遮挡导致无法点击 */
        z-index: 12;
        display: flex;
        flex-direction: column;
        align-items: stretch;
        gap: var(--mm-space-2);
        pointer-events: auto;
        user-select: none;
        transform: scale(0.88);
        transform-origin: left bottom;
      }
      .canvas-zoom-actions {
        display: flex;
        flex-direction: row;
        align-items: stretch;
        gap: var(--mm-space-2);
        width: 100%;
        min-width: 0;
        box-sizing: border-box;
      }
      .canvas-zoom-action-btn {
        flex: 1 1 0;
        min-width: 0;
        padding: 6px var(--mm-space-2);
        margin: 0;
        border: 1px solid rgba(15, 23, 42, 0.08);
        border-radius: var(--mm-radius-sm);
        background: rgba(255, 255, 255, 0.42);
        color: var(--mm-text);
        font-size: var(--mm-font-ui);
        font-weight: 600;
        line-height: var(--mm-line-tight);
        cursor: pointer;
        box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        box-sizing: border-box;
      }
      .canvas-zoom-action-btn:hover {
        background: rgba(255, 255, 255, 0.55);
      }
      .canvas-zoom-action-btn:active {
        background: rgba(0, 0, 0, 0.05);
      }
      .canvas-zoom-badge {
        display: flex;
        flex-direction: row;
        align-items: center;
        justify-content: center;
        gap: var(--mm-space-1);
        padding: 5px var(--mm-space-2);
        border-radius: var(--mm-radius-md);
        font-size: var(--mm-font-body);
        font-weight: 600;
        line-height: var(--mm-line-tight);
        color: var(--mm-text);
        background: rgba(255, 255, 255, 0.38);
        border: 1px solid rgba(15, 23, 42, 0.07);
        box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
        user-select: none;
        pointer-events: auto;
        width: 100%;
        box-sizing: border-box;
      }
      .canvas-zoom-badge:hover {
        background: rgba(255, 255, 255, 0.48);
      }
      .canvas-zoom-btn {
        flex: 0 0 auto;
        width: 30px;
        height: 30px;
        padding: 0;
        margin: 0;
        border: none;
        border-radius: var(--mm-radius-sm);
        background: rgba(15, 23, 42, 0.05);
        color: var(--mm-text);
        font-size: 1.125rem;
        font-weight: 700;
        line-height: 1;
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        justify-content: center;
      }
      .canvas-zoom-btn:hover {
        background: rgba(0, 0, 0, 0.08);
      }
      .canvas-zoom-btn:active {
        background: rgba(0, 0, 0, 0.12);
      }
      .canvas-zoom-value {
        flex: 0 0 auto;
        min-width: 48px;
        text-align: center;
        padding: 3px 6px;
        cursor: default;
        border-radius: 4px;
      }
      .canvas-zoom-value:hover {
        background: rgba(0, 0, 0, 0.04);
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
      .statusbarClickable {
        cursor: pointer;
      }
      .logDialogCard {
        width: min(720px, calc(100vw - 32px));
        max-height: min(86vh, 640px);
        background: var(--mm-bg-surface);
        border: 1px solid var(--mm-border-strong);
        border-radius: var(--mm-radius-lg);
        box-shadow: var(--mm-shadow-dialog);
        overflow: hidden;
        display: flex;
        flex-direction: column;
      }
      .logDialogBody {
        padding: 0 var(--mm-space-3) var(--mm-space-3) var(--mm-space-3);
        flex: 1 1 auto;
        min-height: 0;
      }
      .logPre {
        margin: 0;
        padding: var(--mm-space-3);
        font-family: var(--mm-font-mono);
        font-size: var(--mm-font-small);
        line-height: 1.45;
        white-space: pre-wrap;
        word-break: break-word;
        color: var(--mm-text);
        background: var(--mm-bg-subtle);
        border: 1px solid var(--mm-border);
        border-radius: var(--mm-radius-md);
        min-height: 120px;
        max-height: min(58vh, 480px);
        overflow: auto;
      }
      .logDialogActions {
        justify-content: flex-end;
        gap: var(--mm-space-2);
      }
      .logDialogActions button {
        min-width: 88px;
      }

      /* Right-click context menus */
      .ctxMenu {
        position: fixed;
        z-index: 80;
        min-width: 0;
        width: max-content;
        max-width: min(86vw, 360px);
        background: var(--mm-bg-surface);
        border: 1px solid var(--mm-border);
        border-radius: var(--mm-radius-md);
        box-shadow: var(--mm-shadow-md);
        padding: var(--mm-space-2);
      }
      .ctxMenu.hidden { display: none; }
      .ctxMenuTitle {
        font-size: var(--mm-font-small);
        color: var(--mm-text-muted);
        padding: var(--mm-space-1) var(--mm-space-2) var(--mm-space-2) var(--mm-space-2);
      }
      .ctxMenu button {
        display: block;
        width: auto;
        text-align: left;
        border: 0;
        background: transparent;
        border-radius: var(--mm-radius-sm);
        padding: var(--mm-space-2) var(--mm-space-3);
        cursor: pointer;
        color: var(--mm-text);
        font-size: var(--mm-font-ui);
        white-space: nowrap;
      }
      .ctxMenu button:hover { background: var(--mm-bg-subtle); }

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
        background: var(--mm-bg-surface);
        border: 1px solid var(--mm-border-strong);
        border-radius: var(--mm-radius-lg);
        box-shadow: var(--mm-shadow-dialog);
        overflow: hidden;
      }
      .dialogTitle {
        padding: var(--mm-space-3) var(--mm-space-4);
        border-bottom: 1px solid var(--mm-border);
        font-size: var(--mm-font-body);
        font-weight: 700;
        color: var(--mm-text);
        background: var(--mm-bg-subtle);
      }
      .dialogBody {
        padding: var(--mm-space-4);
        color: var(--mm-text-secondary);
        font-size: var(--mm-font-ui);
        white-space: pre-wrap;
        line-height: var(--mm-line-normal);
      }
      .dialogActions {
        padding: var(--mm-space-3) var(--mm-space-4);
        display: flex;
        justify-content: flex-end;
        gap: var(--mm-space-2);
        border-top: 1px solid var(--mm-border);
      }
      .dialogActions button {
        min-width: 82px;
        border: 1px solid var(--mm-border-strong);
        border-radius: var(--mm-radius-md);
        padding: var(--mm-space-2) var(--mm-space-3);
        cursor: pointer;
        font-size: var(--mm-font-ui);
        background: var(--mm-bg-subtle);
        color: var(--mm-text-secondary);
      }
      .dialogActions button:hover {
        background: var(--mm-bg-toolbar);
      }
    </style>
  </head>
  <body>
    <header class="appTitleBar" id="appTitleBar" role="banner">
      <div class="appTitleBrand">
        <div class="appTitleIconWrap" id="appTitleIconWrap" aria-hidden="true">
          <img
            class="appTitleIconImg"
            id="appTitleIconImg"
            src="${appTitleIconPngUrl}"
            width="40"
            height="40"
            alt=""
            decoding="async"
          />
          <svg class="appTitleIconFallback" viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <defs>
              <linearGradient id="g1" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" style="stop-color:#2563eb"/>
                <stop offset="100%" style="stop-color:#7c3aed"/>
              </linearGradient>
            </defs>
            <rect width="40" height="40" rx="10" fill="url(#g1)"/>
            <circle cx="20" cy="12" r="4" fill="#fff" opacity="0.95"/>
            <circle cx="10" cy="26" r="3.2" fill="#fff" opacity="0.9"/>
            <circle cx="20" cy="28" r="3.2" fill="#fff" opacity="0.9"/>
            <circle cx="30" cy="26" r="3.2" fill="#fff" opacity="0.9"/>
            <path d="M20 16v4M20 20l-8 4M20 20l8 4" stroke="#fff" stroke-width="1.8" stroke-linecap="round" opacity="0.85" fill="none"/>
          </svg>
        </div>
        <div class="appTitleTextCol">
          <span class="appTitleName" id="appTitleName">Mindmap</span>
          <span class="appTitleSub" id="appTitleSub">MindmapEditor</span>
        </div>
      </div>
      <div class="appTitleBarActions">
        <button
          type="button"
          id="btnTitleFullScreen"
          class="appTitleBarFullScreenBtn"
          title="Full screen"
          aria-label="Full screen"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
            <path
              fill="currentColor"
              d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"
            />
          </svg>
        </button>
      </div>
    </header>
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
          <button type="button" id="menuInsertImage">Insert image</button>
          <button type="button" id="menuInsertText">Insert text</button>
          <button type="button" id="menuInsertWhiteboard">Insert whiteboard</button>
          <button type="button" id="menuInsertVideo">Insert video</button>
          <button type="button" id="menuInsertAudio">Insert audio</button>
          <button type="button" id="menuInsertGltf">Insert glTF</button>
          <button type="button" id="menuInsertTable">Insert table</button>
        </div>
      </details>
      <details>
        <summary id="sumModify">Modify</summary>
        <div class="menuItems">
          <button id="menuPromote">Promote</button>
          <button id="menuDemote">Demote</button>
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
        <summary id="sumLanguage">Language</summary>
        <div class="menuItems">
          <button id="menuLangZh">中文</button>
          <button id="menuLangEn">English</button>
        </div>
      </details>
      <details>
        <summary id="sumUiTheme">Theme</summary>
        <div class="menuItems">
          <button type="button" id="menuUiThemeSystem">Follow system</button>
          <button type="button" id="menuUiThemeLight">Light</button>
          <button type="button" id="menuUiThemeDark">Dark</button>
        </div>
      </details>
      <details>
        <summary id="sumHelp">Help</summary>
        <div class="menuItems">
          <button id="menuOpenLog">View Log</button>
          <button id="menuSupportedFormats">Supported formats…</button>
        </div>
      </details>
    </div>

    <div class="htoolbar" id="htoolbar" role="toolbar" aria-label="Toolbar">
      <button type="button" id="btnNew">＋</button>
      <button type="button" id="btnOpen">📂</button>
      <button type="button" id="btnSave">💾</button>
      <button type="button" id="btnSaveAs">🖫</button>
    </div>

    <div class="mainRow">
      <div class="canvas_wrap" id="canvasWrap" tabindex="0">
        <div class="gridLayer" id="gridLayer"></div>
        <div class="fallbackTree hidden" id="fallbackTree"></div>
        <div class="rootMirror hidden" id="rootMirror"></div>
        <div id="jsmind_container"></div>
        <div id="canvasZoomStack" class="canvas-zoom-stack" role="group">
          <div class="canvas-zoom-actions">
            <button type="button" id="canvasZoomFit" class="canvas-zoom-action-btn" tabindex="0">Fit</button>
            <button type="button" id="canvasZoomCenterRoot" class="canvas-zoom-action-btn" tabindex="0">Root</button>
            <button type="button" id="canvasZoomReset" class="canvas-zoom-action-btn" tabindex="0">还原</button>
          </div>
          <div id="canvasZoomBadge" class="canvas-zoom-badge" role="group">
            <button type="button" id="canvasZoomOut" class="canvas-zoom-btn" tabindex="0">−</button>
            <span id="canvasZoomValue" class="canvas-zoom-value">100%</span>
            <button type="button" id="canvasZoomIn" class="canvas-zoom-btn" tabindex="0">+</button>
          </div>
        </div>
        <div class="canvas-shortcut-hints" id="canvasShortcutHints">
          <div
            class="canvas-shortcut-hints-trigger"
            id="canvasShortcutHintsTrigger"
            tabindex="0"
            role="button"
            aria-haspopup="true"
            aria-expanded="false"
            aria-controls="canvasShortcutHintsBody"
          >
            <span id="canvasShortcutHintsTitleText">Shortcuts</span>
          </div>
          <div
            class="canvas-shortcut-hints-popover"
            id="canvasShortcutHintsBody"
            role="region"
            aria-labelledby="canvasShortcutHintsTrigger"
            aria-hidden="true"
          ></div>
        </div>
      </div>
      <div class="dock-right-stack" id="dockRightStack">
        <aside class="dock dock-right" id="dockFormat" aria-label="Format dock">
          <div class="dock-display">
            <div class="dock-titlebar">
              <span class="dock-title" id="dockFormatTitle">Format</span>
              <div class="dock-title-actions">
                <button type="button" class="dock-title-btn" id="btnDockFormatCollapse" title="Collapse">−</button>
                <button type="button" class="dock-title-btn" id="btnDockFormatMaximize" title="Maximize">□</button>
              </div>
            </div>
            <div class="attrContent" id="dockFormatBody">
              <div class="dock-form" id="dockFormatForm">
                <div class="dock-form-hint" id="dockFormatHint">—</div>
                <label class="dock-form-row"
                  ><span class="dock-form-label" id="dockLblNodeId">Node ID</span>
                  <input type="text" id="dockInputNodeId" class="dock-readonly-input" readonly tabindex="-1" value=""
                /></label>
                <label class="dock-form-row"
                  ><span class="dock-form-label" id="dockLblTopic">Content</span>
                  <textarea id="dockInputTopic" class="dock-topic-input" rows="4" spellcheck="false"></textarea>
                </label>
                <label class="dock-form-row"
                  ><span class="dock-form-label" id="dockLblFont">Font</span>
                  <select id="dockInputFont"></select
                ></label>
                <label class="dock-form-row"
                  ><span class="dock-form-label" id="dockLblSize">Size</span>
                  <input type="number" id="dockInputFontSize" min="8" max="72" step="1" />
                </label>
                <label class="dock-form-row"
                  ><span class="dock-form-label" id="dockLblColor">Text color</span>
                  <input type="color" id="dockInputColor" value="#333333" />
                </label>
                <label class="dock-form-row"
                  ><span class="dock-form-label" id="dockLblBg">Background</span>
                  <input type="color" id="dockInputBg" value="#ffffff" />
                </label>
                <div class="dock-form-actions">
                  <button type="button" id="dockBtnResetFormat" class="dock-apply-btn dock-secondary">
                    Reset
                  </button>
                </div>
              </div>
            </div>
          </div>
          <div class="dock-edge">
            <button type="button" id="btnToggleDockFormat" class="dock-edge-btn" title="Format">⚙</button>
          </div>
        </aside>
        <aside class="dock dock-right" id="dockIcon" aria-label="Icon dock">
          <div class="dock-display">
            <div class="dock-titlebar">
              <span class="dock-title" id="dockIconTitle">Icon</span>
              <div class="dock-title-actions">
                <button type="button" class="dock-title-btn" id="btnDockIconCollapse" title="Collapse">−</button>
                <button type="button" class="dock-title-btn" id="btnDockIconMaximize" title="Maximize">□</button>
              </div>
            </div>
            <div class="attrContent" id="dockIconBody">
              <div class="dock-form-hint" id="dockIconHint">—</div>
              <div class="dock-icon-grid" id="dockIconGrid"></div>
            </div>
          </div>
          <div class="dock-edge">
            <button type="button" id="btnToggleDockIcon" class="dock-edge-btn" title="Icon">🖼</button>
          </div>
        </aside>
        <aside class="dock dock-right" id="dockJsmindTheme" aria-label="Mind map theme dock">
          <div class="dock-display">
            <div class="dock-titlebar">
              <span class="dock-title" id="dockJsmindThemeTitle">Mind map theme</span>
              <div class="dock-title-actions">
                <button type="button" class="dock-title-btn" id="btnDockJsmindThemeCollapse" title="Collapse">−</button>
                <button type="button" class="dock-title-btn" id="btnDockJsmindThemeMaximize" title="Maximize">□</button>
              </div>
            </div>
            <div class="attrContent" id="dockJsmindThemeBody">
              <div class="dock-jsmind-theme-grid" id="dockJsmindThemeGrid"></div>
            </div>
          </div>
          <div class="dock-edge">
            <button type="button" id="btnToggleDockJsmindTheme" class="dock-edge-btn" title="Mind map theme">🎨</button>
          </div>
        </aside>
      </div>
    </div>
    <div class="statusbar statusbarClickable" id="statusbar">
      <div class="statusbarLeft">
        <span id="statusIcon" class="statusIcon">⛔</span>
        <span id="statusbarText">就绪</span>
      </div>
      <div class="statusbarRight">
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

    <div class="dialogOverlay hidden" id="logDialog" style="z-index: 96;">
      <div class="logDialogCard" role="dialog" aria-modal="true" aria-labelledby="logDialogTitle">
        <div class="dialogTitle" id="logDialogTitle">Log</div>
        <div class="logDialogBody">
          <pre id="logFullText" class="logPre"></pre>
        </div>
        <div class="dialogActions logDialogActions">
          <button id="logCopyBtn" type="button">Copy all</button>
          <button id="logCloseBtn" type="button">Close</button>
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
      <button id="ctxDeleteNode">删除</button>
    </div>
    <div class="ctxMenu hidden" id="canvasCtxMenu">
      <div class="ctxMenuTitle" id="canvasCtxTitle">画布右键菜单</div>
      <button id="ctxPasteCanvas">粘贴到根节点</button>
      <button id="ctxCenterRoot">根节点居正显示</button>
      <button id="ctxFitAll">全部显示</button>
      <button id="ctxResetZoom">还原缩放比例</button>
    </div>

    <script nonce="${nonce}" src="${mindmapCoreUrl}"></script>
    <script nonce="${nonce}" src="${jsmindScriptUrl}"></script>
    <script nonce="${nonce}">
      const __MINDMAP_BOOT__ = ${bootJsonForHtml};
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
                  });
                  return;
                }
                if (type === ET.edit && data) {
                  const evt = data.evt;
                  if (evt === 'update_node' && data.node && jm.get_node) {
                    const n = jm.get_node(data.node);
                    if (n) {
                      requestAnimationFrame(function () {
                        applyMindNodeVisual(n);
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
                    });
                  }
                  if (evt === 'move_node') {
                    markContentDirty();
                    selectedNode = null;
                    setStatus(t('ready'));
                    requestAnimationFrame(function () {
                      applyAllMindNodeVisuals();
                    });
                  }
                }
              } catch (_) {}
            });

            initDockFormatAndIcon();
            requestAnimationFrame(function () {
              applyAllMindNodeVisuals();
              refreshDockFromSelection();
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
          const node = getActiveSelectedNode();
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
            const raw = d.mmIcon;
            const sel =
              raw === undefined || raw === null ? '' : String(raw);
            const btns = grid.querySelectorAll('.dock-icon-btn');
            for (let i = 0; i < btns.length; i++) {
              const b = btns[i];
              const id = b.getAttribute('data-mm-icon') || '';
              b.classList.toggle('mm-selected', id === sel);
            }
          }
        }

        function commitTopicFromDock() {
          if (dockFormatRefreshing) return;
          const node = getActiveSelectedNode();
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
          const node = getActiveSelectedNode();
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
          const node = getActiveSelectedNode();
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
          const node = getActiveSelectedNode();
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

        function editNodeTopicByPrompt(nodeIdStr) {
          if (!jm || nodeIdStr == null) return;
          const id = String(nodeIdStr).trim();
          if (!id) return;
          const node = findNodeById(id);
          if (!node) return;
          clearLassoMarks();
          selectNodeById(id);
          const current = node.topic != null ? String(node.topic) : '';
          const promptTitle = currentLang === 'zh' ? '编辑节点内容' : 'Edit topic';
          const next = window.prompt(promptTitle, current);
          if (next === null) return;
          const topic = next.toString().trim();
          if (!topic) return;
          jm.update_node(node.id, topic);
          markContentDirty();
          refreshDockFromSelection();
        }

        function editSelectedByPrompt() {
          if (!jm || !selectedNode) return;
          editNodeTopicByPrompt(String(selectedNode.id));
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

        // Double-click node => edit text; double-click blank canvas => add child under selection (or root).
        elOn(jsmindContainerEl, 'dblclick', function (e) {
          if (!jm || !jsmindContainerEl) return;
          const onNode = e.target ? getNodeElFromTarget(e.target) : null;
          if (onNode) {
            const holder = onNode.closest ? onNode.closest('[nodeid]') : onNode;
            const nid = holder && holder.getAttribute ? holder.getAttribute('nodeid') : null;
            if (nid) {
              editNodeTopicByPrompt(String(nid));
            }
            try {
              e.preventDefault();
              e.stopPropagation();
            } catch (_) {}
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

