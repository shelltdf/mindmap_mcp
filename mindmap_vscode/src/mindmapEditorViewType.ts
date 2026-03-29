/** 独立 Webview 面板（无 TextDocument，无系统脏点） */
export const MINDMAP_WEBVIEW_VIEW_TYPE = 'mindmapEditor';

/**
 * Custom Text Editor：与 {@link vscode.TextDocument} 绑定，工作台对 .txt 同款的 isDirty / 标签圆点 / 保存提示。
 * 见 VS Code 文档：CustomTextEditorProvider。
 */
export const MINDMAP_CUSTOM_TEXT_EDITOR_VIEW_TYPE = 'mindmap.customTextEditor';
