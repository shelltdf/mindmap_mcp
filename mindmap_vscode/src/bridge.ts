import * as http from 'http';
import * as vscode from 'vscode';
import { MindmapPanel } from './panel';

/** Shown when include_schema is true (Pencil-style “load schema first”). */
export const MINDMAP_MCP_SCHEMA = `Mindmap VS Code — batch_design / operations JSON array

Each element is an object with field action (string, case-insensitive):

- getTree — read tree (no extra fields)
- getSelection — current selection
- select — nodeId (string)
- add — parentId, topic, optional nodeId (stable id for chained adds)
- update — nodeId, topic
- delete — nodeId (root not allowed)
- move — nodeId, newParentId, optional before (_first_ / _last_, default _last_)

Pass operations as a JSON **string** containing the array, e.g.:
[{"action":"add","parentId":"root","topic":"Child"}]

Chained add: do not use dryRun for whole batch; parent nodes must exist before children.

Recommended flags on batch (bridge defaults): transaction=true, strict=true — all-or-nothing rollback and failedIndex/failedOp/partialResults on error.

filePath in MCP tools is optional; the live bridge always uses the open Mindmap panel in VS Code.`;

const MAX_BODY = 2 * 1024 * 1024;

export type BridgeMethod = 'get_editor_state' | 'batch_get' | 'batch_design';

interface BridgeCallBody {
  token?: string;
  method?: string;
  arguments?: Record<string, unknown>;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(payload);
}

function truncateTreeDepth(node: MindmapTreeNode, maxDepth: number, depth: number): MindmapTreeNode {
  if (maxDepth <= 0) {
    return { id: node.id, topic: node.topic, children: [] };
  }
  if (depth >= maxDepth) {
    const has = node.children && node.children.length > 0;
    return {
      id: node.id,
      topic: node.topic,
      children: has ? [{ id: '_…_', topic: '…', children: [] }] : []
    };
  }
  return {
    id: node.id,
    topic: node.topic,
    children: (node.children || []).map((c) => truncateTreeDepth(c, maxDepth, depth + 1))
  };
}

interface MindmapTreeNode {
  id: string;
  topic: string;
  children: MindmapTreeNode[];
}

function pruneToNodeIds(node: MindmapTreeNode, keep: Set<string>): MindmapTreeNode | null {
  const selfKeep = keep.has(String(node.id));
  const nextChildren: MindmapTreeNode[] = [];
  for (const c of node.children || []) {
    const p = pruneToNodeIds(c, keep);
    if (p) nextChildren.push(p);
  }
  if (selfKeep || nextChildren.length > 0) {
    return { id: node.id, topic: node.topic, children: nextChildren };
  }
  return null;
}

function matchTopicPatterns(node: MindmapTreeNode, patterns: { topic?: string }[]): boolean {
  for (const p of patterns) {
    const raw = String(p.topic || '').trim();
    if (!raw) continue;
    try {
      const re = new RegExp(raw);
      if (re.test(String(node.topic || ''))) return true;
    } catch {
      if (String(node.topic || '').includes(raw)) return true;
    }
  }
  return false;
}

function collectMatchingSubtrees(
  node: MindmapTreeNode,
  patterns: { topic?: string }[],
  ancestors: MindmapTreeNode[]
): MindmapTreeNode[] {
  const chain = [...ancestors, node];
  const out: MindmapTreeNode[] = [];
  if (matchTopicPatterns(node, patterns)) {
    out.push(node);
  }
  for (const c of node.children || []) {
    out.push(...collectMatchingSubtrees(c, patterns, chain));
  }
  return out;
}

async function handleBridgeCall(
  method: BridgeMethod,
  args: Record<string, unknown>
): Promise<{ ok: true; result: unknown } | { ok: false; error: string; webviewData?: unknown }> {
  const panel = MindmapPanel.currentPanel;

  if (method === 'get_editor_state') {
    const includeSchema = !!args.include_schema;
    if (!panel) {
      return {
        ok: true,
        result: {
          active: false,
          editor: null,
          ...(includeSchema ? { schema: MINDMAP_MCP_SCHEMA } : {})
        }
      };
    }
    let selection: any = null;
    try {
      selection = await panel.aiGetSelection();
    } catch {
      selection = null;
    }
    return {
      ok: true,
      result: {
        active: true,
        editor: 'mindmap-vscode',
        title: panel.panelTitle,
        filePath: panel.backingFilePath ?? null,
        format: panel.mindmapFormat ?? null,
        selection,
        ...(includeSchema ? { schema: MINDMAP_MCP_SCHEMA } : {})
      }
    };
  }

  if (!panel) {
    return { ok: false, error: 'Mindmap panel is not open. Run Mindmap: Open Mindmap Editor first.' };
  }

  if (method === 'batch_get' || method === 'batch_design') {
    try {
      await panel.autoSaveForMcpBridgeIfNeeded();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, error: msg };
    }
    await panel.showMcpPersistNoticeIfNeeded();
  }

  if (method === 'batch_get') {
    const readDepth =
      typeof args.readDepth === 'number' && Number.isFinite(args.readDepth) ? Math.max(1, args.readDepth) : 64;
    const nodeIdsRaw = args.nodeIds;
    const patterns = Array.isArray(args.patterns) ? (args.patterns as { topic?: string }[]) : [];

    let tree: MindmapTreeNode;
    try {
      tree = await panel.aiGetTree();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const webviewData = e instanceof Error && (e as Error & { webviewData?: unknown }).webviewData;
      return { ok: false, error: msg, webviewData };
    }

    let working: MindmapTreeNode = tree;
    if (Array.isArray(nodeIdsRaw) && nodeIdsRaw.length > 0) {
      const keep = new Set(nodeIdsRaw.map((x) => String(x)));
      const pruned = pruneToNodeIds(working, keep);
      if (!pruned) {
        return { ok: true, result: { tree: null, note: 'no nodes matched nodeIds', filePath: panel.backingFilePath } };
      }
      working = pruned;
    }
    if (patterns.length > 0) {
      const hits = collectMatchingSubtrees(working, patterns, []);
      working = {
        id: '_matches_',
        topic: 'pattern matches',
        children: hits
      };
    }

    const truncated = truncateTreeDepth(working, readDepth, 0);
    let selection: any = null;
    try {
      selection = await panel.aiGetSelection();
    } catch {
      selection = null;
    }

    return {
      ok: true,
      result: {
        filePath: panel.backingFilePath ?? null,
        format: panel.mindmapFormat ?? null,
        selection,
        tree: truncated,
        meta: { readDepth, hadNodeIdsFilter: Array.isArray(nodeIdsRaw) && nodeIdsRaw.length > 0, hadPatterns: patterns.length > 0 }
      }
    };
  }

  if (method === 'batch_design') {
    const opStr = String(args.operations ?? '').trim();
    if (!opStr) {
      return { ok: false, error: 'operations is required (JSON string of ops array)' };
    }
    let ops: unknown[];
    try {
      const parsed = JSON.parse(opStr) as unknown;
      if (!Array.isArray(parsed)) {
        return { ok: false, error: 'operations must parse to a JSON array' };
      }
      ops = parsed;
    } catch {
      return { ok: false, error: 'operations must be valid JSON' };
    }
    const dryRun = !!args.dryRun;
    const transaction = args.transaction !== false;
    const strict = args.strict !== false;
    try {
      const result = await panel.aiApplyOps(ops, dryRun, transaction, strict);
      return { ok: true, result };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const webviewData = e instanceof Error && (e as Error & { webviewData?: unknown }).webviewData;
      return { ok: false, error: msg, webviewData };
    }
  }

  return { ok: false, error: 'unknown method' };
}

export function startMindmapMcpBridge(port: number, token: string): vscode.Disposable {
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/mcp-bridge/v1/call') {
      sendJson(res, 404, { ok: false, error: 'not found' });
      return;
    }
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        req.destroy();
        sendJson(res, 413, { ok: false, error: 'body too large' });
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      void (async () => {
        try {
          const raw = Buffer.concat(chunks).toString('utf8');
          let body: BridgeCallBody;
          try {
            body = JSON.parse(raw) as BridgeCallBody;
          } catch {
            sendJson(res, 400, { ok: false, error: 'invalid JSON body' });
            return;
          }
          if (!body.token || body.token !== token) {
            sendJson(res, 401, { ok: false, error: 'unauthorized' });
            return;
          }
          const method = String(body.method || '').trim() as BridgeMethod;
          if (method !== 'get_editor_state' && method !== 'batch_get' && method !== 'batch_design') {
            sendJson(res, 400, { ok: false, error: 'invalid method' });
            return;
          }
          const args = body.arguments && typeof body.arguments === 'object' ? body.arguments : {};
          const out = await handleBridgeCall(method, args);
          if (out.ok) {
            sendJson(res, 200, out);
          } else {
            sendJson(res, 200, out);
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          sendJson(res, 500, { ok: false, error: msg });
        }
      })();
    });
  });

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
