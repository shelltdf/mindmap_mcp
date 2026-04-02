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

  /** 供扩展在保存前等场景判断是否为脑图 TextDocument（.mmd / .jm） */
  public static documentIsMindmapBuffer(doc: vscode.TextDocument): boolean {
    return MindmapPanel._isMindmapTextDocumentBuffer(doc);
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
      void this._checkExternalDiskChangedAutoReload();
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

  /** 宿主侧写入 Webview Log（状态栏 Log 窗口同源），不抢焦点。 */
  private _appendHostLogToWebview(level: 'info' | 'warn' | 'error', text: string): void {
    try {
      void this._panel.webview.postMessage({ type: 'mindmap:appendHostLog', level, text });
    } catch {
      // ignore
    }
  }

  private _summarizeExternalTextDiff(oldText: string, newText: string): string {
    const zh = this._uiLanguage === 'zh';
    if (oldText === newText) {
      return zh
        ? '磁盘文本与当前缓冲区一致（可能仅有时间戳等非内容变化）。'
        : 'Disk text matches editor buffer (timestamp-only change?).';
    }
    const oldLines = oldText.split(/\r?\n/);
    const newLines = newText.split(/\r?\n/);
    let i = 0;
    const minLen = Math.min(oldLines.length, newLines.length);
    while (i < minLen && oldLines[i] === newLines[i]) {
      i++;
    }
    let detail = zh
      ? `行数 ${oldLines.length}→${newLines.length}，字符 ${oldText.length}→${newText.length}。`
      : `Lines ${oldLines.length}→${newLines.length}, chars ${oldText.length}→${newText.length}.`;
    if (i < oldLines.length || i < newLines.length) {
      detail += zh ? `\n首处内容差异约在第 ${i + 1} 行：` : `\nFirst content difference around line ${i + 1}:`;
      detail += `\n  − ${(oldLines[i] ?? '').slice(0, 200)}`;
      detail += `\n  + ${(newLines[i] ?? '').slice(0, 200)}`;
    }
    return detail;
  }

  /**
   * 磁盘文件被外部修改：默认自动从磁盘重载到画布（无模态框），摘要写入 Log。
   * 若当前有未保存修改，不自动覆盖，仅写 Log 警告并刷新已知 mtime，避免反复提示。
   */
  private async _checkExternalDiskChangedAutoReload(): Promise<void> {
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
      const zh = this._uiLanguage === 'zh';
      const baseHead = zh
        ? `[外部修改] 检测到磁盘文件已被其他程序更新：\n${this._filePath}`
        : `[External] Mindmap file changed on disk:\n${this._filePath}`;

      if (this._ext === 'xmind') {
        if (this._dirty) {
          this._appendHostLogToWebview(
            'warn',
            baseHead +
              (zh
                ? '\n当前有未保存修改，已跳过自动重新加载。'
                : '\nUnsaved edits — skipped auto-reload.')
          );
        } else {
          this._appendHostLogToWebview(
            'info',
            baseHead + (zh ? '\n已自动从磁盘重新加载（.xmind）。' : '\nAuto-reloaded from disk (.xmind).')
          );
          await this._reloadTreeFromDisk();
        }
        await this._refreshKnownDiskMtimeFromDisk();
        return;
      }

      let newText = '';
      try {
        newText = (await vscode.workspace.fs.readFile(vscode.Uri.file(this._filePath))).toString();
      } catch (e) {
        const msgStr = e instanceof Error ? e.message : String(e);
        this._appendHostLogToWebview(
          'error',
          zh ? `读取磁盘文件失败：${msgStr}` : `Failed to read file: ${msgStr}`
        );
        await this._refreshKnownDiskMtimeFromDisk();
        return;
      }

      const oldText = this._textDocument?.getText() ?? '';
      const diffSummary = this._summarizeExternalTextDiff(oldText, newText);

      if (this._dirty) {
        this._appendHostLogToWebview('warn', `${baseHead}\n${diffSummary}`);
        this._appendHostLogToWebview(
          'warn',
          zh
            ? '当前编辑器中有未保存修改，已跳过自动从磁盘加载，避免覆盖本地编辑。可先保存或撤销后再同步。'
            : 'Unsaved edits in editor — skipped auto-reload. Save or revert, then disk changes can apply.'
        );
        await this._refreshKnownDiskMtimeFromDisk();
        return;
      }

      if (oldText === newText) {
        this._appendHostLogToWebview(
          'info',
          `${baseHead}\n${diffSummary}\n` + (zh ? '未执行重载（内容一致）。' : 'No reload (content identical).')
        );
        await this._refreshKnownDiskMtimeFromDisk();
        return;
      }

      this._appendHostLogToWebview(
        'info',
        `${baseHead}\n${diffSummary}\n` + (zh ? '已自动从磁盘重新加载。' : 'Auto-reloaded from disk.')
      );
      await this._reloadTreeFromDisk();
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

  /**
   * 在即将保存某一文档前，只刷新绑定该 URI 的面板上的防抖队列（避免 Ctrl+S 与 220ms 画布→文档同步竞态）。
   */
  public static async flushPendingWebviewEditsForDocument(uri: vscode.Uri): Promise<void> {
    const key = uri.toString();
    for (const p of MindmapPanel._instances) {
      if (p._textDocument?.uri.toString() === key) {
        await p._flushPendingWebviewEditsToDocumentNow();
        return;
      }
    }
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
    /** 可执行脚本放在 media/*.js，避免内联脚本在 Cursor 浏览器预览等环境因 CSP nonce 不一致被拦截。 */
    const webviewThemeInitUrl = webview
      .asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'webview-theme-init.js'))
      .toString();
    const webviewAppUrl = webview
      .asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'webview-app.js'))
      .toString();
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
    <script nonce="${nonce}" src="___MM_SRC_WEBVIEW_THEME___"></script>
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
      /* Dock Area 与客户区分割条（window-gui-documentation.mdc：边缘拖动） */
      .main-row-splitter {
        flex: 0 0 5px;
        width: 5px;
        min-width: 5px;
        align-self: stretch;
        cursor: col-resize;
        z-index: 20;
        box-sizing: border-box;
        background: linear-gradient(
          90deg,
          transparent 0%,
          var(--mm-border-strong) 20%,
          var(--mm-border-strong) 80%,
          transparent 100%
        );
        opacity: 0.65;
      }
      .main-row-splitter:hover {
        opacity: 1;
        background: linear-gradient(
          90deg,
          transparent 0%,
          var(--mm-accent, #2563eb) 15%,
          var(--mm-accent, #2563eb) 85%,
          transparent 100%
        );
      }
      html[data-mm-ui='dark'] .main-row-splitter:hover {
        background: linear-gradient(
          90deg,
          transparent 0%,
          #60a5fa 15%,
          #60a5fa 85%,
          transparent 100%
        );
      }
      .main-row-splitter.mm-splitter-dragging {
        opacity: 1;
      }
      /* 全折叠/关闭：不可拖、不可见，但保留与可用时相同的 flex 占位，避免画布与 Dock 区之间空隙随折叠跳动 */
      .main-row-splitter.mm-main-row-splitter-inactive {
        pointer-events: none;
        cursor: default;
        opacity: 0;
        background: none;
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
      /* 主菜单下方 Toolbar：在 Dock Area 外；含轨道 + 可选溢出「更多」按钮（window-gui-documentation.mdc） */
      .htoolbar-host {
        flex: 0 0 auto;
        display: flex;
        flex-direction: row;
        align-items: stretch;
        border-bottom: 1px solid var(--mm-border);
        background: var(--mm-bg-toolbar);
      }
      .htoolbar-track {
        flex: 1 1 auto;
        min-width: 0;
        overflow: hidden;
        display: flex;
        align-items: stretch;
      }
      .htoolbar {
        flex: 1 1 auto;
        min-width: 0;
        display: flex;
        flex-direction: row;
        flex-wrap: nowrap;
        align-items: center;
        gap: var(--mm-space-2);
        padding: var(--mm-space-2) var(--mm-space-3);
        background: transparent;
      }
      /* 组与组之间使用；同组内按钮紧密排列（如「新建/打开/保存/另存为」文件一组） */
      .htoolbar-group {
        display: flex;
        flex-direction: row;
        flex-wrap: nowrap;
        align-items: center;
        gap: var(--mm-space-2);
      }
      .htoolbar-sep {
        flex: 0 0 1px;
        align-self: stretch;
        width: 1px;
        min-height: 24px;
        margin: 6px 2px;
        background: var(--mm-border-strong);
        opacity: 0.85;
      }
      .htoolbar-overflow-btn {
        flex: 0 0 36px;
        width: 36px;
        min-width: 36px;
        align-self: center;
        margin: var(--mm-space-2) var(--mm-space-2) var(--mm-space-2) 0;
        height: 36px;
        border-radius: var(--mm-radius-md);
        border: 1px solid var(--mm-border-strong);
        background: var(--mm-bg-surface);
        cursor: pointer;
        font-size: 1.125rem;
        font-weight: 700;
        line-height: 1;
        color: var(--mm-text-secondary);
        box-shadow: var(--mm-shadow-sm);
      }
      .htoolbar-overflow-btn:hover {
        background: var(--mm-bg-subtle);
      }
      .htoolbar-overflow-btn.hidden {
        display: none !important;
      }
      .htoolbar-overflow-menu {
        position: fixed;
        z-index: 45;
        min-width: 200px;
        padding: var(--mm-space-2);
        display: flex;
        flex-direction: column;
        gap: var(--mm-space-1);
        background: var(--mm-bg-surface);
        border: 1px solid var(--mm-border);
        border-radius: var(--mm-radius-lg);
        box-shadow: var(--mm-shadow-md);
      }
      .htoolbar-overflow-menu.hidden {
        display: none !important;
      }
      .htoolbar-overflow-item {
        display: flex;
        align-items: center;
        justify-content: flex-start;
        gap: var(--mm-space-2);
        padding: var(--mm-space-2) var(--mm-space-3);
        border: 1px solid var(--mm-border-strong);
        border-radius: var(--mm-radius-md);
        background: var(--mm-bg-subtle);
        cursor: pointer;
        font-size: var(--mm-font-ui);
        color: var(--mm-text);
      }
      .htoolbar-overflow-item:hover {
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

      /* 右侧唯一折叠条带：与 mm-dock-view 兄弟，贴窗口右缘（window-gui-documentation Dock Area） */
      .dock-fold-strip {
        flex: 0 0 28px;
        width: 28px;
        min-width: 28px;
        max-width: 28px;
        align-self: flex-start;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: var(--mm-space-2);
        /* 不设左右 padding，避免缘条内有效宽度过小导致 emoji 溢出 */
        padding: var(--mm-space-2) 0;
        box-sizing: border-box;
        border-right: none;
        border-left: 1px solid var(--mm-border-strong);
        background: var(--mm-bg-dock-edge);
      }
      /* 展开态 Dock Button 高亮（由脚本挂 mm-dock-edge-expanded；关闭时 mm-dock-fold-btn-hidden） */
      .dock-fold-strip .dock-edge-btn.mm-dock-edge-expanded {
        background: color-mix(in srgb, var(--mm-accent, #2563eb) 18%, var(--mm-bg-subtle));
        border-color: var(--mm-border-strong);
      }
      html[data-mm-ui='dark'] .dock-fold-strip .dock-edge-btn.mm-dock-edge-expanded {
        background: color-mix(in srgb, #60a5fa 22%, var(--mm-bg-subtle));
      }
      .dock-fold-strip .dock-edge-btn.mm-dock-fold-btn-hidden {
        display: none !important;
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
      /*
       * 画布容器带 tabindex 且脚本会 focus()：系统默认焦环画在盒外，易被父级/overflow 裁切，
       * Win + Chromium/WebView 下常只剩靠 Dock 一侧的一条黄/金色竖线，且随焦点变化时有时无。
       * 鼠标聚焦不显示焦环；键盘 Tab 聚焦时用内缩 outline，四边完整、颜色与产品主色一致。
       */
      .canvas_wrap:focus:not(:focus-visible) {
        outline: none;
      }
      .canvas_wrap:focus-visible {
        outline: 2px solid #2563eb;
        outline-offset: -2px;
      }
      html[data-mm-ui='dark'] .canvas_wrap:focus-visible {
        outline-color: #60a5fa;
      }
      /* 2D 画布左上：快捷键说明面板（可折叠，默认折叠；window-gui-documentation.mdc） */
      .canvas-shortcut-hints {
        position: absolute;
        left: var(--mm-space-3);
        top: var(--mm-space-3);
        z-index: 25;
        isolation: isolate;
        pointer-events: auto;
        margin: 0;
        padding: 8px 10px 10px;
        min-width: 120px;
        max-width: min(420px, 92vw);
        box-sizing: border-box;
        border-radius: var(--mm-radius-sm);
        font-size: 11px;
        font-weight: 600;
        line-height: 1.35;
        color: #ffffff;
        text-shadow: 0 1px 2px rgba(0, 0, 0, 0.55);
        background: rgba(15, 23, 42, 0.55);
        border: 1px solid rgba(255, 255, 255, 0.18);
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.12);
        user-select: none;
      }
      .canvas-shortcut-hints-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 6px;
        margin: 0 0 6px 0;
      }
      .canvas-shortcut-hints-title {
        margin: 0;
        padding: 0;
        font-size: 11px;
        letter-spacing: 0.02em;
        opacity: 0.95;
        flex: 1;
        min-width: 0;
      }
      .canvas-shortcut-hints-fold {
        flex: 0 0 auto;
        margin: 0;
        padding: 0 5px;
        min-width: 22px;
        height: 20px;
        box-sizing: border-box;
        border: 1px solid rgba(255, 255, 255, 0.22);
        border-radius: var(--mm-radius-sm);
        background: rgba(255, 255, 255, 0.1);
        color: inherit;
        cursor: pointer;
        font-size: 10px;
        line-height: 1;
        text-shadow: none;
      }
      .canvas-shortcut-hints-fold:hover {
        background: rgba(255, 255, 255, 0.2);
      }
      .canvas-shortcut-hints-fold:focus-visible {
        outline: 2px solid rgba(255, 255, 255, 0.65);
        outline-offset: 1px;
      }
      .canvas-shortcut-hints.mm-collapsed {
        padding-bottom: 8px;
      }
      .canvas-shortcut-hints.mm-collapsed .canvas-shortcut-hints-header {
        margin-bottom: 0;
      }
      .canvas-shortcut-hints.mm-collapsed .canvas-shortcut-hints-body {
        display: none;
      }
      .canvas-shortcut-hints-body {
        margin: 0;
        padding: 0;
        max-height: min(70vh, 520px);
        overflow-x: hidden;
        overflow-y: auto;
        font-size: 11px;
        line-height: 1.55;
        letter-spacing: 0.01em;
        font-weight: 500;
        white-space: pre-line;
        color: #ffffff;
        text-shadow: 0 1px 2px rgba(0, 0, 0, 0.55);
        user-select: text;
        pointer-events: auto;
      }
      html[data-mm-ui='dark'] .canvas-shortcut-hints {
        background: rgba(15, 23, 42, 0.62);
        border-color: rgba(255, 255, 255, 0.14);
      }
      html[data-mm-ui='dark'] .canvas-shortcut-hints-fold {
        border-color: rgba(255, 255, 255, 0.14);
      }
      /* 2D 画布右上：要素可见性（window-gui-documentation.mdc） */
      .canvas-visibility-panel {
        position: absolute;
        right: var(--mm-space-3);
        top: var(--mm-space-3);
        z-index: 24;
        isolation: isolate;
        pointer-events: auto;
        margin: 0;
        padding: 8px 10px 10px;
        min-width: 132px;
        max-width: min(220px, 42vw);
        box-sizing: border-box;
        border-radius: var(--mm-radius-sm);
        font-size: 11px;
        font-weight: 600;
        line-height: 1.35;
        color: #ffffff;
        text-shadow: 0 1px 2px rgba(0, 0, 0, 0.55);
        background: rgba(15, 23, 42, 0.55);
        border: 1px solid rgba(255, 255, 255, 0.18);
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.12);
        user-select: none;
      }
      .canvas-visibility-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 6px;
        margin: 0 0 6px 0;
      }
      .canvas-visibility-title {
        margin: 0;
        padding: 0;
        font-size: 11px;
        letter-spacing: 0.02em;
        opacity: 0.95;
        flex: 1;
        min-width: 0;
      }
      .canvas-visibility-fold {
        flex: 0 0 auto;
        margin: 0;
        padding: 0 5px;
        min-width: 22px;
        height: 20px;
        box-sizing: border-box;
        border: 1px solid rgba(255, 255, 255, 0.22);
        border-radius: var(--mm-radius-sm);
        background: rgba(255, 255, 255, 0.1);
        color: inherit;
        cursor: pointer;
        font-size: 10px;
        line-height: 1;
        text-shadow: none;
      }
      .canvas-visibility-fold:hover {
        background: rgba(255, 255, 255, 0.2);
      }
      .canvas-visibility-panel.mm-collapsed {
        padding-bottom: 8px;
      }
      .canvas-visibility-panel.mm-collapsed .canvas-visibility-header {
        margin-bottom: 0;
      }
      .canvas-visibility-panel.mm-collapsed .canvas-visibility-body {
        display: none;
      }
      .canvas-visibility-row {
        display: flex;
        flex-direction: row;
        align-items: center;
        gap: 8px;
        margin: 0 0 4px 0;
        padding: 0;
        cursor: pointer;
        font-weight: 500;
      }
      .canvas-visibility-row:last-child {
        margin-bottom: 0;
      }
      .canvas-visibility-row input {
        flex: 0 0 auto;
        margin: 0;
        cursor: pointer;
      }
      html[data-mm-ui='dark'] .canvas-visibility-panel {
        background: rgba(15, 23, 42, 0.62);
        border-color: rgba(255, 255, 255, 0.14);
      }
      html[data-mm-ui='dark'] .canvas-visibility-fold {
        border-color: rgba(255, 255, 255, 0.14);
      }
      .gridLayer.mm-canvas-layer-off {
        display: none !important;
      }
      .canvas-shortcut-hints.mm-canvas-layer-off,
      .canvas-zoom-stack.mm-canvas-layer-off {
        display: none !important;
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
      /* 内联标题编辑：父级 .jsmind-inner 为 user-select:none，需显式允许输入框内点选光标与拖选 */
      #jsmind_container input.jsmind-editor {
        user-select: text !important;
        -webkit-user-select: text !important;
        cursor: text;
        pointer-events: auto;
      }
      jmnode.mm-node-reparent-source,
      .jmnode.mm-node-reparent-source {
        opacity: 0.55;
        cursor: grabbing;
      }
      /* jsMind uses inline display:none to hide collapsed subtrees; never !important display on jmnode. */
      #jsmind_container::-webkit-scrollbar { display: none; }
      #jsmind_container { scrollbar-width: none; -ms-overflow-style: none; }

      /* 与壳层字体阶梯协调：脑图节点默认字号与行高；pre-line 使 topic 中换行符在画布上多行显示 */
      #jsmind_container jmnode,
      #jsmind_container .jmnode {
        font-size: var(--mm-font-body);
        line-height: var(--mm-line-normal);
        white-space: pre-line;
        word-break: break-word;
      }

      /* 右侧 Dock Area：[ mm-dock-view | dock-fold-strip ] 横向兄弟，缘条贴窗右 */
      .dock-right-stack,
      .dock-area.mm-dock-area-right {
        flex: 0 0 auto;
        display: flex;
        flex-direction: row;
        align-items: stretch;
        justify-content: flex-start;
        align-self: stretch;
        min-height: 0;
        height: 100%;
        max-height: 100%;
        overflow-x: hidden;
        overflow-y: hidden;
        background: var(--mm-bg-dock);
        border-left: 1px solid var(--mm-border);
      }
      /* 三 Dock 均在 Dock View 内折叠或关闭：不显示 Dock View，右栏缩至缘条宽（内联总宽由 !important 让位，展开任一 Dock 后类移除即恢复内联） */
      .dock-right-stack.mm-dock-stack-fold-only {
        flex: 0 0 auto !important;
        width: auto !important;
        min-width: 0 !important;
        max-width: none !important;
      }
      .dock-right-stack.mm-dock-stack-fold-only .mm-dock-view {
        display: none !important;
      }
      /* 多 Dock 面板纵向叠放；须 flex-grow:1 — #dockRightStack 有脚本固定总宽时，否则多余宽度会堆在 #dockFoldStrip 右侧形成大块空白 */
      .mm-dock-view {
        flex: 1 1 auto;
        min-width: 0;
        min-height: 0;
        display: flex;
        flex-direction: column;
        align-items: stretch;
        align-self: stretch;
        overflow-x: hidden;
        overflow-y: auto;
        max-height: 100%;
        background: var(--mm-bg-dock);
      }
      /* 每个 Dock：显示区撑满 Dock View 宽度；Dock Button 在并列的 dock-fold-strip 内 */
      .dock-right {
        flex: 0 0 auto;
        display: flex;
        flex-direction: row;
        align-items: stretch;
        align-self: stretch;
        width: 100%;
        min-height: 0;
        min-width: 0;
        background: var(--mm-bg-dock);
      }
      .dock-right.dock-closed {
        display: none !important;
      }
      /* 折叠后显示区宽 0；整行仍横向 stretch，避免贴右产生 Dock View 左侧大块空白（与展开态宽度对齐） */
      .mm-dock-view .dock-right.collapsed {
        flex: 0 0 auto;
        align-self: stretch;
        width: auto;
        min-width: 0;
        max-width: 100%;
        align-items: flex-start;
      }
      /* 未最大化：展开高度随内容，不强行占满整列（避免短内容也撑满半屏） */
      .mm-dock-view .dock-right:not(.collapsed):not(.dock-maximized) {
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
      /* 横向上随 Dock View 列变宽撑满（原固定 208px 会在拖宽外侧后留白） */
      .dock-right .dock-display {
        flex: 1 1 auto;
        width: 100%;
        min-width: 0;
        max-width: 100%;
        padding: 0;
        border-left: none;
        display: flex;
        flex-direction: column;
        gap: 0;
        overflow: hidden;
        box-sizing: border-box;
        transition: width 0.12s ease, min-width 0.12s ease, padding 0.12s ease, opacity 0.12s ease;
      }
      /* 最大化时：纵向上 stretch 占满该 Dock 行高 */
      .dock-right.dock-maximized:not(.collapsed) .dock-display {
        flex: 1 1 auto;
        align-self: stretch;
        min-height: 0;
      }
      .dock-right .dock-display > .attrContent {
        margin: var(--mm-space-2) var(--mm-space-3) var(--mm-space-3) var(--mm-space-3);
      }
      .mm-dock-view .dock-right.dock-maximized:not(.collapsed) {
        flex: 1 1 auto !important;
        min-height: 0;
      }
      .mm-dock-view .dock-right.dock-peer-squash:not(.collapsed) {
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
      /* 默认随内容增高，避免图标/主题等短内容 Dock 在条带拉伸下出现大块空白 */
      .attrContent {
        flex: 0 1 auto;
        min-height: 0;
        overflow: auto;
        border-radius: var(--mm-radius-lg);
        border: 1px solid var(--mm-border);
        padding: var(--mm-space-3);
        background: var(--mm-bg-surface);
      }
      /* 最大化或被挤压时：内容区吃满剩余高度并滚动 */
      .dock-right.dock-maximized:not(.collapsed) .attrContent,
      .dock-right.dock-peer-squash:not(.collapsed) .attrContent {
        flex: 1 1 auto;
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
      .dock-form-row.dock-form-row-inline {
        flex-direction: row;
        align-items: flex-end;
        flex-wrap: nowrap;
        gap: var(--mm-space-2);
      }
      .dock-form-field {
        display: flex;
        flex-direction: column;
        gap: var(--mm-space-1);
        min-width: 0;
        flex: 1 1 0;
      }
      .dock-form-field--font {
        flex: 1 1 auto;
        min-width: 0;
      }
      .dock-form-field--size {
        flex: 0 0 68px;
        width: 68px;
        max-width: 68px;
      }
      .dock-form-label {
        font-size: var(--mm-font-small);
        font-weight: 600;
        color: var(--mm-text-secondary);
      }
      .dock-form-row select,
      .dock-form-row input[type='number'],
      .dock-form-field select,
      .dock-form-field input[type='number'] {
        width: 100%;
        max-width: 100%;
        box-sizing: border-box;
        padding: var(--mm-space-1) var(--mm-space-2);
        border-radius: var(--mm-radius-sm);
        border: 1px solid var(--mm-border-strong);
        font-size: var(--mm-font-ui);
      }
      .dock-form-row input[type='color'],
      .dock-form-field input[type='color'] {
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
          <button id="menuViewCenterRoot">Center root</button>
          <button id="menuViewFitAll">Fit all</button>
          <button id="menuViewResetZoom">Reset zoom</button>
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
          <button type="button" id="menuShowDockFormat">Show Format dock</button>
          <button type="button" id="menuShowDockIcon">Show Icon dock</button>
          <button type="button" id="menuShowDockTheme">Show Mind map theme dock</button>
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

    <div class="htoolbar-host">
      <div class="htoolbar-track" id="htoolbarTrack">
        <div class="htoolbar" id="htoolbar" role="toolbar" aria-label="Toolbar">
          <div
            class="htoolbar-group"
            id="htoolbarGroupFile"
            role="group"
            aria-label="File operations"
          >
            <button type="button" id="btnNew">＋</button>
            <button type="button" id="btnOpen">📂</button>
            <button type="button" id="btnSave">💾</button>
            <button type="button" id="btnSaveAs">🖫</button>
          </div>
        </div>
      </div>
      <button
        type="button"
        id="htoolbarOverflowBtn"
        class="htoolbar-overflow-btn hidden"
        aria-label="More toolbar actions"
        aria-haspopup="true"
        aria-expanded="false"
        aria-controls="htoolbarOverflowMenu"
      >
        ▸
      </button>
    </div>
    <div
      class="htoolbar-overflow-menu hidden"
      id="htoolbarOverflowMenu"
      role="menu"
      aria-hidden="true"
    >
      <button type="button" class="htoolbar-overflow-item" id="htoolbarOvNew">＋</button>
      <button type="button" class="htoolbar-overflow-item" id="htoolbarOvOpen">📂</button>
      <button type="button" class="htoolbar-overflow-item" id="htoolbarOvSave">💾</button>
      <button type="button" class="htoolbar-overflow-item" id="htoolbarOvSaveAs">🖫</button>
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
            <button type="button" id="canvasZoomPanOrigin" class="canvas-zoom-action-btn" tabindex="0">Origin</button>
            <button type="button" id="canvasZoomReset" class="canvas-zoom-action-btn" tabindex="0">还原</button>
          </div>
          <div id="canvasZoomBadge" class="canvas-zoom-badge" role="group">
            <button type="button" id="canvasZoomOut" class="canvas-zoom-btn" tabindex="0">−</button>
            <span id="canvasZoomValue" class="canvas-zoom-value">100%</span>
            <button type="button" id="canvasZoomIn" class="canvas-zoom-btn" tabindex="0">+</button>
          </div>
        </div>
        <div
          class="canvas-shortcut-hints mm-collapsed"
          id="canvasShortcutHints"
          role="region"
          aria-labelledby="canvasShortcutHintsTitleText"
        >
          <div class="canvas-shortcut-hints-header">
            <div class="canvas-shortcut-hints-title" id="canvasShortcutHintsTitleText">Shortcuts</div>
            <button
              type="button"
              class="canvas-shortcut-hints-fold"
              id="canvasShortcutHintsFoldBtn"
              aria-expanded="false"
              aria-controls="canvasShortcutHintsBody"
              title="Expand shortcuts panel — No global shortcut"
            >
              ▼
            </button>
          </div>
          <div
            class="canvas-shortcut-hints-body"
            id="canvasShortcutHintsBody"
            role="region"
            aria-labelledby="canvasShortcutHintsTitleText"
            aria-hidden="true"
          ></div>
        </div>
        <div
          class="canvas-visibility-panel"
          id="canvasVisibilityPanel"
          role="region"
          aria-labelledby="canvasVisibilityTitle"
        >
          <div class="canvas-visibility-header">
            <div class="canvas-visibility-title" id="canvasVisibilityTitle">Layers</div>
            <button
              type="button"
              class="canvas-visibility-fold"
              id="canvasVisibilityFoldBtn"
              aria-expanded="true"
              aria-controls="canvasVisibilityBody"
              title="Collapse panel"
            >
              ▲
            </button>
          </div>
          <div class="canvas-visibility-body" id="canvasVisibilityBody">
            <label class="canvas-visibility-row" for="canvasVisGrid">
              <input type="checkbox" id="canvasVisGrid" checked />
              <span id="canvasVisGridLbl">Grid</span>
            </label>
            <label class="canvas-visibility-row" for="canvasVisShortcuts">
              <input type="checkbox" id="canvasVisShortcuts" checked />
              <span id="canvasVisShortcutsLbl">Shortcuts</span>
            </label>
            <label class="canvas-visibility-row" for="canvasVisZoomBar">
              <input type="checkbox" id="canvasVisZoomBar" checked />
              <span id="canvasVisZoomBarLbl">Zoom bar</span>
            </label>
          </div>
        </div>
      </div>
      <div
        class="main-row-splitter"
        id="mainRowSplitter"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize dock area"
        title="Drag to resize dock"
      ></div>
      <div class="dock-right-stack dock-area mm-dock-area-right" id="dockRightStack" aria-label="Right dock area">
        <div class="mm-dock-view dock-view" id="dockAreaView" aria-label="Dock panels">
          <aside class="dock dock-right" id="dockFormat" data-mm-dock="format" aria-label="Format dock">
            <div class="dock-display dock-view">
              <div class="dock-titlebar">
                <span class="dock-title" id="dockFormatTitle">Format</span>
                <div class="dock-title-actions">
                  <button type="button" class="dock-title-btn" id="btnDockFormatCollapse" title="Collapse">−</button>
                  <button type="button" class="dock-title-btn" id="btnDockFormatMaximize" title="Maximize">□</button>
                  <button type="button" class="dock-title-btn" id="btnDockFormatClose" title="Close">×</button>
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
                  <div class="dock-form-row dock-form-row-inline">
                    <label class="dock-form-field dock-form-field--font"
                      ><span class="dock-form-label" id="dockLblFont">Font</span>
                      <select id="dockInputFont"></select
                    ></label>
                    <label class="dock-form-field dock-form-field--size"
                      ><span class="dock-form-label" id="dockLblSize">Size</span>
                      <input type="number" id="dockInputFontSize" min="8" max="72" step="1" />
                    </label>
                  </div>
                  <div class="dock-form-row dock-form-row-inline">
                    <label class="dock-form-field"
                      ><span class="dock-form-label" id="dockLblColor">Text color</span>
                      <input type="color" id="dockInputColor" value="#333333" />
                    </label>
                    <label class="dock-form-field"
                      ><span class="dock-form-label" id="dockLblBg">Background</span>
                      <input type="color" id="dockInputBg" value="#ffffff" />
                    </label>
                  </div>
                  <div class="dock-form-actions">
                    <button type="button" id="dockBtnResetFormat" class="dock-apply-btn dock-secondary">
                      Reset
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </aside>
          <aside class="dock dock-right" id="dockIcon" data-mm-dock="icon" aria-label="Icon dock">
            <div class="dock-display dock-view">
              <div class="dock-titlebar">
                <span class="dock-title" id="dockIconTitle">Icon</span>
                <div class="dock-title-actions">
                  <button type="button" class="dock-title-btn" id="btnDockIconCollapse" title="Collapse">−</button>
                  <button type="button" class="dock-title-btn" id="btnDockIconMaximize" title="Maximize">□</button>
                  <button type="button" class="dock-title-btn" id="btnDockIconClose" title="Close">×</button>
                </div>
              </div>
              <div class="attrContent" id="dockIconBody">
                <div class="dock-form-hint" id="dockIconHint">—</div>
                <div class="dock-icon-grid" id="dockIconGrid"></div>
              </div>
            </div>
          </aside>
          <aside class="dock dock-right" id="dockJsmindTheme" data-mm-dock="theme" aria-label="Mind map theme dock">
            <div class="dock-display dock-view">
              <div class="dock-titlebar">
                <span class="dock-title" id="dockJsmindThemeTitle">Mind map theme</span>
                <div class="dock-title-actions">
                  <button type="button" class="dock-title-btn" id="btnDockJsmindThemeCollapse" title="Collapse">−</button>
                  <button type="button" class="dock-title-btn" id="btnDockJsmindThemeMaximize" title="Maximize">□</button>
                  <button type="button" class="dock-title-btn" id="btnDockJsmindThemeClose" title="Close">×</button>
                </div>
              </div>
              <div class="attrContent" id="dockJsmindThemeBody">
                <div class="dock-jsmind-theme-grid" id="dockJsmindThemeGrid"></div>
              </div>
            </div>
          </aside>
        </div>
        <div class="dock-fold-strip" id="dockFoldStrip" role="toolbar" aria-label="Dock fold buttons">
          <button type="button" id="btnToggleDockFormat" class="dock-edge-btn" title="Format">⚙</button>
          <button type="button" id="btnToggleDockIcon" class="dock-edge-btn" title="Icon">🖼</button>
          <button type="button" id="btnToggleDockJsmindTheme" class="dock-edge-btn" title="Mind map theme">🎨</button>
        </div>
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
    <script nonce="${nonce}" type="application/json" id="mindmap-boot-json">${bootJsonForHtml}</script>
    <script nonce="${nonce}" src="___MM_SRC_WEBVIEW_APP___"></script>
  </body>
</html>`
      .replace(/___MM_SRC_WEBVIEW_THEME___/g, webviewThemeInitUrl)
      .replace(/___MM_SRC_WEBVIEW_APP___/g, webviewAppUrl);
  }
}

function getNonce() {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) text += possible.charAt(Math.floor(Math.random() * possible.length));
  return text;
}

