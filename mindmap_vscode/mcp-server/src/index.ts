#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool
} from '@modelcontextprotocol/sdk/types.js';

const BRIDGE_URL = (process.env.MINDMAP_BRIDGE_URL || 'http://127.0.0.1:58741').replace(/\/$/, '');
const BRIDGE_TOKEN = process.env.MINDMAP_BRIDGE_TOKEN || '';

async function bridgeCall(method: string, args: Record<string, unknown>): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${BRIDGE_URL}/mcp-bridge/v1/call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: BRIDGE_TOKEN, method, arguments: args })
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(
      `无法连接 Mindmap 桥接 (${BRIDGE_URL})：${msg}。请确认已启动 Mindmap Desktop（或 VS Code/Cursor 中的本扩展）且 HTTP 桥接已启用。`
    );
  }
  const text = await res.text();
  let json: { ok?: boolean; result?: unknown; error?: string; webviewData?: unknown };
  try {
    json = JSON.parse(text) as typeof json;
  } catch {
    throw new Error(`bridge non-JSON response (${res.status}): ${text.slice(0, 200)}`);
  }
  if (!json.ok) {
    const extra = json.webviewData !== undefined ? ` webviewData=${JSON.stringify(json.webviewData)}` : '';
    throw new Error((json.error || 'bridge error') + extra);
  }
  return json.result;
}

const tools: Tool[] = [
  {
    name: 'get_editor_state',
    description:
      'Get the active Mindmap VS Code editor state (like Pencil get_editor_state): whether a mindmap panel is open, backing file path, selection, and optional schema for batch operations.',
    inputSchema: {
      type: 'object',
      properties: {
        include_schema: {
          type: 'boolean',
          description:
            'Include the mindmap operations schema. Set true before first read/write in a conversation (same habit as Pencil).'
        }
      },
      required: ['include_schema']
    }
  },
  {
    name: 'batch_get',
    description:
      'Read the current mindmap tree from the VS Code Mindmap Editor (Pencil-style batch read). The live bridge uses the open panel; filePath is optional and ignored. Use readDepth and nodeIds to limit size.',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description: 'Optional. Ignored for live bridge; the open Mindmap panel is always used.'
        },
        nodeIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'If set, prune tree to these node ids (keeps ancestor paths).'
        },
        readDepth: {
          type: 'number',
          description: 'Max depth from each retained root (default 64). Deeper children shown as placeholder nodes.'
        },
        patterns: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              topic: {
                type: 'string',
                description: 'Regex (or plain substring if invalid regex) matched against node topic.'
              }
            }
          },
          description: 'If set, return a synthetic root whose children are subtrees whose topic matches any pattern.'
        }
      }
    }
  },
  {
    name: 'batch_design',
    description:
      'Execute mindmap operations in one batch (Pencil-style batch_design). Parameter operations is a JSON **string** of an array of op objects: action getTree|getSelection|select|add|update|delete with fields as in the schema from get_editor_state. Default transaction=true and strict=true (rollback + failure details). Aim for at most ~25 ops per call.',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description: 'Optional. Ignored for live bridge.'
        },
        operations: {
          type: 'string',
          description:
            'JSON array string, e.g. [{"action":"add","parentId":"root","topic":"New"}]'
        },
        dryRun: { type: 'boolean', description: 'If true, no persistent changes (not for chained add preview).' },
        transaction: {
          type: 'boolean',
          description: 'Default true. Roll back all ops if any step fails.'
        },
        strict: {
          type: 'boolean',
          description: 'Default true. On failure include failedIndex, failedOp, partialResults in error text (webviewData).'
        }
      },
      required: ['operations']
    }
  }
];

const server = new Server({ name: 'mindmap-vscode', version: '0.1.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = request.params.name;
  const args = (request.params.arguments as Record<string, unknown>) || {};

  if (!BRIDGE_TOKEN.trim()) {
    throw new Error(
      'MINDMAP_BRIDGE_TOKEN is empty. In VS Code run command "Mindmap: Show MCP Bridge Info" and set env in Cursor MCP config.'
    );
  }

  if (name === 'get_editor_state') {
    const result = await bridgeCall('get_editor_state', {
      include_schema: !!args.include_schema
    });
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }

  if (name === 'batch_get') {
    const payload: Record<string, unknown> = {};
    if (args.filePath !== undefined) payload.filePath = args.filePath;
    if (args.nodeIds !== undefined) payload.nodeIds = args.nodeIds;
    if (args.readDepth !== undefined) payload.readDepth = args.readDepth;
    if (args.patterns !== undefined) payload.patterns = args.patterns;
    const result = await bridgeCall('batch_get', payload);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }

  if (name === 'batch_design') {
    const payload: Record<string, unknown> = {
      operations: String(args.operations ?? '')
    };
    if (args.filePath !== undefined) payload.filePath = args.filePath;
    if (args.dryRun !== undefined) payload.dryRun = args.dryRun;
    if (args.transaction !== undefined) payload.transaction = args.transaction;
    if (args.strict !== undefined) payload.strict = args.strict;
    const result = await bridgeCall('batch_design', payload);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }

  throw new Error(`unknown tool: ${name}`);
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
