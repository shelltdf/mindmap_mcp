/**
 * MCP HTTP 桥共享实现：扩展 `src/bridge.ts` 与桌面 `desktop/mcpBridge.js` 共用，
 * 避免 batch_get / batch_design / get_editor_state 逻辑分叉。
 */
import * as http from 'http';

/** Pencil 风格：对话开头 `get_editor_state(include_schema: true)` 时下发。 */
export const MINDMAP_MCP_SCHEMA = `Mindmap — batch_design / operations JSON array

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

filePath in MCP tools is optional; the live bridge uses the open Mindmap editor (VS Code / Cursor extension or Mindmap Desktop).`;

export const MCP_BRIDGE_MAX_BODY = 2 * 1024 * 1024;

export type BridgeMethod = 'get_editor_state' | 'batch_get' | 'batch_design';

export interface MindmapTreeNode {
  id: string;
  topic: string;
  children: MindmapTreeNode[];
}

/** 单次 HTTP 请求内由宿主注入；扩展侧在工厂里快照 `MindmapPanel.currentPanel`。 */
export interface McpBridgeHost {
  isAvailable(): boolean;
  /** `get_editor_state` 在 active 时写入 JSON 的 editor 字段，如 mindmap-vscode / mindmap-desktop */
  getActiveEditorId(): string;
  getPanelTitle(): string;
  getBackingFilePath(): string | null;
  getMindmapFormat(): string | null;
  /** batch_get / batch_design 在不可用时的错误文案 */
  getInactiveEditorError(): string;
  aiGetTree(): Promise<MindmapTreeNode>;
  aiGetSelection(): Promise<unknown>;
  aiApplyOps(
    ops: unknown[],
    dryRun: boolean,
    transaction: boolean,
    strict: boolean
  ): Promise<unknown>;
  autoSaveForMcpBridgeIfNeeded(): Promise<void>;
  showMcpPersistNoticeIfNeeded(): Promise<void>;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
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

function collectMatchingSubtrees(node: MindmapTreeNode, patterns: { topic?: string }[]): MindmapTreeNode[] {
  const out: MindmapTreeNode[] = [];
  if (matchTopicPatterns(node, patterns)) {
    out.push(node);
  }
  for (const c of node.children || []) {
    out.push(...collectMatchingSubtrees(c, patterns));
  }
  return out;
}

export type BridgeCallResult =
  | { ok: true; result: unknown }
  | { ok: false; error: string; webviewData?: unknown };

export async function handleMcpBridgeCall(
  method: BridgeMethod,
  args: Record<string, unknown>,
  host: McpBridgeHost
): Promise<BridgeCallResult> {
  if (method === 'get_editor_state') {
    const includeSchema = !!args.include_schema;
    if (!host.isAvailable()) {
      return {
        ok: true,
        result: {
          active: false,
          editor: null,
          ...(includeSchema ? { schema: MINDMAP_MCP_SCHEMA } : {})
        }
      };
    }
    let selection: unknown = null;
    try {
      selection = await host.aiGetSelection();
    } catch {
      selection = null;
    }
    return {
      ok: true,
      result: {
        active: true,
        editor: host.getActiveEditorId(),
        title: host.getPanelTitle(),
        filePath: host.getBackingFilePath(),
        format: host.getMindmapFormat(),
        selection,
        ...(includeSchema ? { schema: MINDMAP_MCP_SCHEMA } : {})
      }
    };
  }

  if (!host.isAvailable()) {
    return { ok: false, error: host.getInactiveEditorError() };
  }

  if (method === 'batch_get' || method === 'batch_design') {
    try {
      await host.autoSaveForMcpBridgeIfNeeded();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, error: msg };
    }
    await host.showMcpPersistNoticeIfNeeded();
  }

  if (method === 'batch_get') {
    const readDepth =
      typeof args.readDepth === 'number' && Number.isFinite(args.readDepth) ? Math.max(1, args.readDepth) : 64;
    const nodeIdsRaw = args.nodeIds;
    const patterns = Array.isArray(args.patterns) ? (args.patterns as { topic?: string }[]) : [];

    let tree: MindmapTreeNode;
    try {
      tree = await host.aiGetTree();
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
        return {
          ok: true,
          result: {
            tree: null,
            note: 'no nodes matched nodeIds',
            filePath: host.getBackingFilePath()
          }
        };
      }
      working = pruned;
    }
    if (patterns.length > 0) {
      const hits = collectMatchingSubtrees(working, patterns);
      working = {
        id: '_matches_',
        topic: 'pattern matches',
        children: hits
      };
    }

    const truncated = truncateTreeDepth(working, readDepth, 0);
    let selection: unknown = null;
    try {
      selection = await host.aiGetSelection();
    } catch {
      selection = null;
    }

    return {
      ok: true,
      result: {
        filePath: host.getBackingFilePath(),
        format: host.getMindmapFormat(),
        selection,
        tree: truncated,
        meta: {
          readDepth,
          hadNodeIdsFilter: Array.isArray(nodeIdsRaw) && nodeIdsRaw.length > 0,
          hadPatterns: patterns.length > 0
        }
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
      const result = await host.aiApplyOps(ops, dryRun, transaction, strict);
      return { ok: true, result };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const webviewData = e instanceof Error && (e as Error & { webviewData?: unknown }).webviewData;
      return { ok: false, error: msg, webviewData };
    }
  }

  return { ok: false, error: 'unknown method' };
}

export function readBridgeRequestBody(req: http.IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        req.destroy();
        reject(new Error('body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export async function handleMcpBridgeHttpRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  token: string,
  getHost: () => McpBridgeHost
): Promise<void> {
  if (req.method !== 'POST' || req.url !== '/mcp-bridge/v1/call') {
    sendJson(res, 404, { ok: false, error: 'not found' });
    return;
  }
  let raw: string;
  try {
    raw = await readBridgeRequestBody(req, MCP_BRIDGE_MAX_BODY);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === 'body too large') {
      sendJson(res, 413, { ok: false, error: 'body too large' });
    } else {
      sendJson(res, 400, { ok: false, error: msg || 'failed to read body' });
    }
    return;
  }
  try {
    let body: { token?: string; method?: string; arguments?: Record<string, unknown> };
    try {
      body = JSON.parse(raw) as typeof body;
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
    const host = getHost();
    const out = await handleMcpBridgeCall(method, args, host);
    sendJson(res, 200, out);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    sendJson(res, 500, { ok: false, error: msg });
  }
}

export function attachMcpBridgeRequestListener(
  token: string,
  getHost: () => McpBridgeHost
): http.RequestListener {
  return (req, res) => {
    void handleMcpBridgeHttpRequest(req, res, token, getHost);
  };
}
