import * as vscode from 'vscode';
import { MindmapPanel } from './panel';
import { MINDMAP_CUSTOM_TEXT_EDITOR_VIEW_TYPE } from './mindmapEditorViewType';

/**
 * 用官方 Custom Text Editor 打开 .mmd / .jm：内容与 TextDocument 同步，获得与 .txt 相同的脏状态与保存流程。
 */
export class MindmapCustomTextEditorProvider implements vscode.CustomTextEditorProvider {
  public static readonly viewType = MINDMAP_CUSTOM_TEXT_EDITOR_VIEW_TYPE;

  constructor(private readonly _context: vscode.ExtensionContext) {}

  public async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    token: vscode.CancellationToken
  ): Promise<void> {
    await MindmapPanel.resolveCustomTextEditor(this._context, document, webviewPanel, token);
  }
}
