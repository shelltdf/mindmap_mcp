export interface CoreMindmapTreeNode {
  id: string;
  topic: string;
  /** 随 .jm 持久化；含 mmFont/mmFontSize/mmColor/mmBg/mmIcon 等（由脑图画布使用） */
  data?: Record<string, unknown>;
  children: CoreMindmapTreeNode[];
}

export interface CoreMindmapTree {
  root: CoreMindmapTreeNode;
}

export type CoreMindmapExt = 'mmd' | 'jm';

function nextIdFactory() {
  let n = 0;
  return () => `n_${n++}`;
}

function extractMermaidBlock(text: string): string {
  const m = text.match(/```mermaid\s*([\s\S]*?)```/i);
  if (m && m[1]) return m[1].trimEnd();
  return text.trimEnd();
}

function parseMermaidMindmap(text: string): CoreMindmapTree {
  const mermaid = extractMermaidBlock(text);
  const lines = mermaid
    .split(/\r?\n/)
    .map((l) => l.replace(/\t/g, '  ').trimEnd())
    .filter((l) => l.trim().length > 0);

  if (lines.length === 0) throw new Error('Mindmap text is empty');

  const idGen = nextIdFactory();
  const stack: { node: CoreMindmapTreeNode; depth: number }[] = [];

  function parseLineToTopic(line: string): string {
    const trimmed = line.trim();
    const rootMatch = trimmed.match(/^root\(\(\s*(.*?)\s*\)\)\s*$/);
    if (rootMatch) return rootMatch[1];
    return trimmed.replace(/^-+\s*/, '');
  }

  const leadingSpaces = (s: string) => s.match(/^ */)?.[0].length ?? 0;
  let startIdx = 0;
  if (lines[0].trim().startsWith('mindmap')) startIdx = 1;
  const rootCandidate = lines[startIdx];
  if (!rootCandidate) throw new Error('Cannot find root line');

  const rootDepth = Math.floor(leadingSpaces(rootCandidate) / 2);
  const root: CoreMindmapTreeNode = {
    id: idGen(),
    topic: parseLineToTopic(rootCandidate),
    children: []
  };
  stack.push({ node: root, depth: rootDepth });

  for (let i = startIdx + 1; i < lines.length; i++) {
    const raw = lines[i];
    const depth = Math.floor(leadingSpaces(raw) / 2);
    const node: CoreMindmapTreeNode = {
      id: idGen(),
      topic: parseLineToTopic(raw),
      children: []
    };
    while (stack.length > 0 && stack[stack.length - 1].depth >= depth) {
      stack.pop();
    }
    if (stack.length === 0) {
      stack.push({ node: root, depth: rootDepth });
    }
    stack[stack.length - 1].node.children.push(node);
    stack.push({ node, depth });
  }

  return { root };
}

function escapeMermaidTopic(s: string): string {
  return String(s).replace(/\)\)/g, ') )');
}

export function parseCoreMindmapText(text: string, ext: CoreMindmapExt): CoreMindmapTree {
  if (ext === 'jm') {
    const obj = JSON.parse(text);
    if (obj && obj.root && obj.root.topic !== undefined) {
      const toNode = (n: any): CoreMindmapTreeNode => {
        const o: CoreMindmapTreeNode = {
          id: typeof n.id === 'string' ? n.id : `n_${Math.random().toString(16).slice(2)}`,
          topic: String(n.topic ?? ''),
          children: Array.isArray(n.children) ? n.children.map(toNode) : []
        };
        if (n.data && typeof n.data === 'object') {
          o.data = { ...(n.data as Record<string, unknown>) };
        }
        return o;
      };
      return { root: toNode(obj.root) };
    }
    const data = obj?.data;
    if (!data) throw new Error('Unsupported .jm JSON: missing "data" field');
    const toNode = (n: any): CoreMindmapTreeNode => {
      const o: CoreMindmapTreeNode = {
        id: typeof n?.id === 'string' ? n.id : `n_${Math.random().toString(16).slice(2)}`,
        topic: String(n?.topic ?? ''),
        children: Array.isArray(n?.children) ? n.children.map(toNode) : []
      };
      if (n?.data && typeof n.data === 'object') {
        o.data = { ...(n.data as Record<string, unknown>) };
      }
      return o;
    };
    return { root: toNode(data) };
  }
  return parseMermaidMindmap(text);
}

export function serializeCoreMindmapTree(tree: CoreMindmapTree, ext: CoreMindmapExt): string {
  if (ext === 'jm') {
    const toJmNode = (node: CoreMindmapTreeNode): any => {
      const o: any = {
        id: node.id,
        topic: node.topic,
        children: (node.children || []).map(toJmNode)
      };
      if (node.data && typeof node.data === 'object' && Object.keys(node.data).length > 0) {
        o.data = JSON.parse(JSON.stringify(node.data));
      }
      return o;
    };
    return (
      JSON.stringify(
        {
          meta: { name: 'mindmap', author: 'mcp', version: '1.0' },
          format: 'node_tree',
          data: toJmNode(tree.root)
        },
        null,
        2
      ) + '\n'
    );
  }

  const lines: string[] = [];
  lines.push('mindmap');
  lines.push(`  root((${escapeMermaidTopic(tree.root.topic)}))`);
  const emitChildren = (node: CoreMindmapTreeNode, depth: number) => {
    for (const ch of node.children) {
      const indent = '  '.repeat(depth + 2);
      lines.push(`${indent}${escapeMermaidTopic(ch.topic)}`);
      emitChildren(ch, depth + 1);
    }
  };
  emitChildren(tree.root, 0);
  return lines.join('\n') + '\n';
}
