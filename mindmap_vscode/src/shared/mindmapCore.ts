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

/** 新建 / 重置用：根 id 固定为 `root`，其余节点在载入时由 normalize 分配 `n_1`… */
export function createBlankCoreMindmapTree(): CoreMindmapTree {
  return {
    root: {
      id: 'root',
      topic: 'New Mindmap',
      children: []
    }
  };
}

/**
 * 将树内 id 规范为：根唯一 `root`，其余按前序遍历依次为 `n_1`、`n_2`、…（与画布规则一致）。
 */
export function normalizeCoreMindmapTreeIds(tree: CoreMindmapTree): void {
  let seq = 1;
  function walk(node: CoreMindmapTreeNode, isRoot: boolean): void {
    if (isRoot) {
      node.id = 'root';
    } else {
      node.id = 'n_' + seq;
      seq++;
    }
    const children = node.children || [];
    for (let i = 0; i < children.length; i++) {
      walk(children[i], false);
    }
  }
  walk(tree.root, true);
}

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
  const noBom = text.replace(/^\uFEFF/, '');
  const mermaid = extractMermaidBlock(noBom);
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

  /**
   * 深度按「相对根行的缩进」计算，根在栈中为 depth 0。
   * 缩进步长不硬编码为 2：从后续行里取「大于根缩进的最小正差值」作为一级缩进（兼容 2/4 空格或混存的手改 .mmd），
   * 避免层级被算错导致父子关系与连线错乱。
   */
  const baseIndent = leadingSpaces(rootCandidate);
  let minDelta = Infinity;
  for (let j = startIdx + 1; j < lines.length; j++) {
    const li = leadingSpaces(lines[j]);
    if (li > baseIndent) {
      const delta = li - baseIndent;
      if (delta > 0 && delta < minDelta) minDelta = delta;
    }
  }
  const indentStep = minDelta === Infinity ? 2 : Math.max(1, minDelta);
  const depthOfLine = (raw: string) => {
    const li = leadingSpaces(raw);
    if (li <= baseIndent) return 1;
    const d = Math.floor((li - baseIndent) / indentStep);
    return d < 1 ? 1 : d;
  };

  const root: CoreMindmapTreeNode = {
    id: idGen(),
    topic: parseLineToTopic(rootCandidate),
    children: []
  };
  stack.push({ node: root, depth: 0 });

  for (let i = startIdx + 1; i < lines.length; i++) {
    const raw = lines[i];
    const depth = depthOfLine(raw);
    const node: CoreMindmapTreeNode = {
      id: idGen(),
      topic: parseLineToTopic(raw),
      children: []
    };
    while (stack.length > 0 && stack[stack.length - 1].depth >= depth) {
      stack.pop();
    }
    if (stack.length === 0) {
      stack.push({ node: root, depth: 0 });
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
      const out: CoreMindmapTree = { root: toNode(obj.root) };
      normalizeCoreMindmapTreeIds(out);
      return out;
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
    const out2: CoreMindmapTree = { root: toNode(data) };
    normalizeCoreMindmapTreeIds(out2);
    return out2;
  }
  const mer = parseMermaidMindmap(text);
  normalizeCoreMindmapTreeIds(mer);
  return mer;
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
