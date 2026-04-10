import * as http from 'http';
import * as vscode from 'vscode';
import {
  attachMcpBridgeRequestListener,
  MINDMAP_MCP_SCHEMA,
  type McpBridgeHost,
  type MindmapTreeNode
} from './shared/mcpBridgeCore';
import { MindmapPanel } from './panel';

export { MINDMAP_MCP_SCHEMA };

function vscodeMcpBridgeHost(): McpBridgeHost {
  const panel = MindmapPanel.currentPanel;
  return {
    isAvailable: () => !!panel,
    getActiveEditorId: () => 'mindmap-vscode',
    getPanelTitle: () => panel?.panelTitle ?? '',
    getBackingFilePath: () => panel?.backingFilePath ?? null,
    getMindmapFormat: () => panel?.mindmapFormat ?? null,
    getInactiveEditorError: () =>
      'Mindmap panel is not open. Run Mindmap: Open Mindmap Editor first.',
    aiGetTree: async () => {
      if (!panel) throw new Error('Mindmap panel is not open');
      return (await panel.aiGetTree()) as MindmapTreeNode;
    },
    aiGetSelection: async () => {
      if (!panel) throw new Error('Mindmap panel is not open');
      return panel.aiGetSelection();
    },
    aiApplyOps: async (ops, dryRun, transaction, strict) => {
      if (!panel) throw new Error('Mindmap panel is not open');
      return panel.aiApplyOps(ops, dryRun, transaction, strict);
    },
    autoSaveForMcpBridgeIfNeeded: async () => {
      if (!panel) return;
      await panel.autoSaveForMcpBridgeIfNeeded();
    },
    showMcpPersistNoticeIfNeeded: async () => {
      if (!panel) return;
      await panel.showMcpPersistNoticeIfNeeded();
    }
  };
}

export function startMindmapMcpBridge(port: number, token: string): vscode.Disposable {
  const listener = attachMcpBridgeRequestListener(token, () => vscodeMcpBridgeHost());
  const server = http.createServer(listener);
  server.on('error', (err: NodeJS.ErrnoException) => {
    void vscode.window.showErrorMessage(
      `Mindmap MCP 桥接监听失败（端口 ${port}）：${err.message}。可在设置中修改 mindmap.mcpBridge.port。`
    );
  });
  server.listen(port, '127.0.0.1');
  return new vscode.Disposable(() => {
    try {
      server.close();
    } catch {
      // ignore
    }
  });
}
