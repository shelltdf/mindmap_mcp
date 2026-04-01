export type MindmapExt = 'mmd' | 'xmind' | 'jm';
import {
  createBlankCoreMindmapTree,
  parseCoreMindmapText,
  serializeCoreMindmapTree
} from '../shared/mindmapCore';

export interface MindmapTreeNode {
  id: string;
  topic: string;
  /** 节点扩展数据（.jm 可持久化；含画布格式/图标等） */
  data?: Record<string, unknown>;
  children: MindmapTreeNode[];
}

export interface MindmapTree {
  root: MindmapTreeNode;
}

/** 新建脑图：仅根节点、无子节点，根 id 每次重新生成。 */
export function createBlankMindmapTree(): MindmapTree {
  return createBlankCoreMindmapTree();
}

function normalizeExt(ext: string): MindmapExt {
  const e = ext.toLowerCase().replace(/^\./, '');
  if (e === 'mmd') return 'mmd';
  if (e === 'xmind') return 'xmind';
  if (e === 'jm') return 'jm';
  throw new Error(`Unsupported mindmap extension: ${ext}`);
}

function nextIdFactory() {
  let n = 0;
  return () => `n_${n++}`;
}

function extractMermaidBlock(text: string): string {
  const m = text.match(/```mermaid\s*([\s\S]*?)```/i);
  if (m && m[1]) return m[1].trimEnd();
  // fallback: treat whole text as mermaid content
  return text.trimEnd();
}

function parseMermaidMindmap(text: string): MindmapTree {
  const mermaid = extractMermaidBlock(text);
  const lines = mermaid
    .split(/\r?\n/)
    .map((l) => l.replace(/\t/g, '  ').trimEnd())
    .filter((l) => l.trim().length > 0);

  if (lines.length === 0) throw new Error('Mindmap text is empty');
  const first = lines[0].trim();
  if (!first.startsWith('mindmap')) {
    // allow missing "mindmap" line: still try
  }

  // root line is expected to have form: root((title))
  const rootLine = lines.find((l, idx) => idx > 0 && l.includes('root(('));
  if (!rootLine) {
    // fallback: assume the second non-empty line is root
  }

  const idGen = nextIdFactory();
  // Stack entry: { node, depth }
  const stack: { node: MindmapTreeNode; depth: number }[] = [];

  function parseLineToTopic(line: string): string {
    const trimmed = line.trim();
    // root((title)) -> title
    const rootMatch = trimmed.match(/^root\(\(\s*(.*?)\s*\)\)\s*$/);
    if (rootMatch) return rootMatch[1];
    // fallback: take whole text as topic (strip leading symbols if any)
    return trimmed.replace(/^-+\s*/, '');
  }

  // Determine root line index: if "mindmap" exists, root begins after it.
  let startIdx = 0;
  if (first.startsWith('mindmap')) startIdx = 1;

  const rootCandidate = lines[startIdx];
  if (!rootCandidate) throw new Error('Cannot find root line');

  // Compute depth by indentation: assume 2 spaces per level.
  const leadingSpaces = (s: string) => s.match(/^ */)?.[0].length ?? 0;
  const rootDepth = Math.floor(leadingSpaces(rootCandidate) / 2);
  const rootTopic = parseLineToTopic(rootCandidate);
  const root: MindmapTreeNode = { id: idGen(), topic: rootTopic, children: [] };
  stack.push({ node: root, depth: rootDepth });

  for (let i = startIdx + 1; i < lines.length; i++) {
    const raw = lines[i];
    const depth = Math.floor(leadingSpaces(raw) / 2);
    const topic = parseLineToTopic(raw);
    const node: MindmapTreeNode = { id: idGen(), topic, children: [] };

    while (stack.length > 0 && stack[stack.length - 1].depth >= depth) {
      stack.pop();
    }
    if (stack.length === 0) {
      // If indentation is weird, treat as root child.
      stack.push({ node: root, depth: rootDepth });
    }
    stack[stack.length - 1].node.children.push(node);
    stack.push({ node, depth });
  }

  return { root };
}

export function parseMindmapText(text: string, ext: string): MindmapTree {
  const e = normalizeExt(ext);
  if (e === 'xmind') {
    throw new Error('For .xmind files, parseMindmapXmindFile(filePath) must be used.');
  }
  return parseCoreMindmapText(text, e);
}

function escapeMermaidTopic(s: string): string {
  // Basic escaping: Mermaid mindmap title is inside root((...)) or as plain line.
  // We'll avoid breaking parentheses as a best-effort.
  return String(s).replace(/\)\)/g, ') )');
}

export function serializeMindmapTree(tree: MindmapTree, ext: MindmapExt): string {
  if (ext === 'xmind') {
    throw new Error('For .xmind files, writeMindmapXmindTitlesOnly(filePath, tree) must be used.');
  }
  return serializeCoreMindmapTree(tree, ext);
}

// -----------------------------
// .xmind support (titles-only)
// -----------------------------

type AnyTopic = Record<string, any>;
type XmlTopicNode = { title: string; children: XmlTopicNode[] };

function safeParseJson(s: string) {
  try {
    return JSON.parse(s);
  } catch (err: any) {
    const msg = err && err.message ? err.message : String(err);
    throw new Error(`Invalid JSON in content.json: ${msg}`);
  }
}

function decodeXmlEntities(s: string): string {
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function encodeXmlEntities(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function findContentJsonEntry(zip: any) {
  const entries = zip.getEntries();

  // 1) Fast path: name-based match (case-insensitive)
  for (const e of entries) {
    const rawName = e.entryName as string;
    const norm = rawName.replace(/\\/g, '/').toLowerCase();
    if (norm === 'content.json' || norm.endsWith('/content.json')) {
      return { entryName: e.entryName, entries };
    }
  }

  // 2) Heuristic path: scan all json entries and find the one that "looks like" xmind content.
  // We avoid reading huge payloads.
  const jsonEntries = entries
    .filter((e: any) => typeof e.entryName === 'string' && e.entryName.toLowerCase().endsWith('.json'))
    .slice(0, 200);

  const guessCandidates: string[] = [];
  for (const e of jsonEntries) {
    const entryName = e.entryName as string;
    const size = typeof e.header?.size === 'number' ? e.header.size : undefined;
    if (typeof size === 'number' && size > 5 * 1024 * 1024) continue; // skip > 5MB

    try {
      const raw = zip.readFile(entryName);
      const contentStr = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
      const obj = JSON.parse(contentStr);

      // quick shape checks
      const hasTitle =
        typeof obj?.title === 'string' ||
        typeof obj?.Title === 'string' ||
        typeof obj?.topicTitle === 'string' ||
        typeof obj?.name === 'string' ||
        typeof obj?.root?.title === 'string' ||
        typeof obj?.root?.Title === 'string';
      const hasTopics =
        Array.isArray(obj?.topics) ||
        Array.isArray(obj?.Topics) ||
        Array.isArray(obj?.children) ||
        Array.isArray(obj?.Children) ||
        Array.isArray(obj?.root?.topics) ||
        Array.isArray(obj?.root?.children);

      if (hasTitle && hasTopics) {
        return { entryName, entries };
      }

      // deeper heuristic: if we can find a topic-like node anywhere, it's likely the topic tree.
      const topicNode = findFirstTopicLikeNode(obj);
      if (topicNode) {
        return { entryName, entries };
      }

      guessCandidates.push(entryName);
    } catch {
      // ignore parse errors
    }
  }

  const sample = entries
    .slice(0, 40)
    .map((e: any) => String(e.entryName).replace(/\\/g, '/'))
    .join(', ');

  const jsonSample = jsonEntries
    .slice(0, 30)
    .map((e: any) => String(e.entryName).replace(/\\/g, '/'))
    .join(', ');

  throw new Error(
    `Cannot find content.json inside .xmind zip (name-based and heuristic scan both failed). ` +
      `First entries: [${sample}]. ` +
      `json entries sample: [${jsonSample}]`
  );
}

function findContentXmlEntry(zip: any) {
  const entries = zip.getEntries();
  for (const e of entries) {
    const rawName = e.entryName as string;
    const norm = rawName.replace(/\\/g, '/').toLowerCase();
    if (norm === 'content.xml' || norm.endsWith('/content.xml')) {
      return { entryName: e.entryName };
    }
  }
  return null;
}

function findFirstTopicLikeNode(obj: AnyTopic, maxDepth = 15): AnyTopic | null {
  const seen = new Set<any>();

  function walk(cur: any, depth: number): AnyTopic | null {
    if (!cur || depth > maxDepth) return null;
    if (typeof cur !== 'object') return null;
    if (seen.has(cur)) return null;
    seen.add(cur);

    const title = cur.title ?? cur.Title ?? cur.topicTitle ?? cur.name;
    const maybeTopics = cur.topics ?? cur.Topics ?? cur.children ?? cur.Children ?? cur.topic;
    const topicsArr = Array.isArray(maybeTopics) ? maybeTopics : null;

    if (typeof title === 'string' && topicsArr) {
      return cur;
    }

    if (Array.isArray(cur)) {
      for (const item of cur) {
        const r = walk(item, depth + 1);
        if (r) return r;
      }
    } else {
      for (const k of Object.keys(cur)) {
        const r = walk(cur[k], depth + 1);
        if (r) return r;
      }
    }

    return null;
  }

  return walk(obj, 0);
}

function topicToOutlineTree(topicObj: AnyTopic): { title: string; children: any[] } {
  const title =
    topicObj.title ?? topicObj.Title ?? topicObj.topicTitle ?? topicObj.name ?? 'Untitled';

  const topicsArr = topicObj.topics ?? topicObj.Topics ?? topicObj.children ?? topicObj.Children ?? null;
  const children = Array.isArray(topicsArr) ? topicsArr : [];

  return {
    title: String(title),
    children: children.map((c: any) => topicToOutlineTree(c))
  };
}

function parseXmindContentXmlToOutline(xml: string): { title: string; children: any[] } {
  const tagRe = /<[^>]+>/g;
  const topicStack: XmlTopicNode[] = [];
  let rootTopic: XmlTopicNode | null = null;

  let captureTitleNode: XmlTopicNode | null = null;
  let titleBuffer = '';
  let lastPos = 0;

  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(xml)) !== null) {
    const tag = m[0];
    const textBetween = xml.slice(lastPos, m.index);
    if (captureTitleNode && textBetween) titleBuffer += textBetween;
    lastPos = tagRe.lastIndex;

    if (tag.startsWith('<!--') || tag.startsWith('<?') || tag.startsWith('<!')) {
      continue;
    }

    const isClosing = /^<\s*\//.test(tag);
    const isSelfClosing = /\/\s*>$/.test(tag);
    const nameMatch = tag.match(/^<\s*\/?\s*([^\s/>]+)/);
    if (!nameMatch) continue;
    const fullName = nameMatch[1];
    const local = fullName.includes(':')
      ? fullName.slice(fullName.lastIndexOf(':') + 1).toLowerCase()
      : fullName.toLowerCase();

    if (!isClosing && local === 'topic') {
      const node: XmlTopicNode = { title: 'Untitled', children: [] };
      if (topicStack.length > 0) topicStack[topicStack.length - 1].children.push(node);
      else rootTopic = node;
      if (!isSelfClosing) topicStack.push(node);
      continue;
    }

    if (isClosing && local === 'topic') {
      if (topicStack.length > 0) topicStack.pop();
      continue;
    }

    if (!isClosing && local === 'title') {
      captureTitleNode = topicStack.length > 0 ? topicStack[topicStack.length - 1] : null;
      titleBuffer = '';
      if (isSelfClosing && captureTitleNode) {
        captureTitleNode.title = '';
        captureTitleNode = null;
      }
      continue;
    }

    if (isClosing && local === 'title') {
      if (captureTitleNode) {
        captureTitleNode.title = decodeXmlEntities(titleBuffer.trim());
      }
      captureTitleNode = null;
      titleBuffer = '';
      continue;
    }
  }

  if (!rootTopic) throw new Error('Cannot find topic root in xmind content.xml');

  const toOutline = (n: XmlTopicNode): { title: string; children: any[] } => ({
    title: n.title || 'Untitled',
    children: n.children.map(toOutline)
  });
  return toOutline(rootTopic);
}

function collectOutlineNodesPreOrder(root: MindmapTreeNode): MindmapTreeNode[] {
  const list: MindmapTreeNode[] = [];
  const walk = (n: MindmapTreeNode) => {
    list.push(n);
    for (const ch of n.children) walk(ch);
  };
  walk(root);
  return list;
}

function countTopicStartTagsInContentXml(xml: string): number {
  const matches = xml.match(/<\s*(?:[\w.-]+:)?topic\b[^>]*>/g);
  return matches ? matches.length : 0;
}

function applyOutlineTitlesToContentXml(xml: string, outlineTree: MindmapTree): string {
  const outlineNodes = collectOutlineNodesPreOrder(outlineTree.root);
  const topicCount = countTopicStartTagsInContentXml(xml);
  if (outlineNodes.length !== topicCount) {
    throw new Error(
      `Outline has ${outlineNodes.length} nodes but xmind(xml) has ${topicCount} topic nodes. ` +
        'For .xmind files, this editor currently supports title editing only (no add/delete/move).'
    );
  }
  const tagRe = /<[^>]+>/g;
  let out = '';
  let lastPos = 0;
  let topicDepth = 0;
  let insideTopicTitle = false;
  let idx = 0;

  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(xml)) !== null) {
    const tag = m[0];
    const textBetween = xml.slice(lastPos, m.index);
    if (!insideTopicTitle) {
      out += textBetween;
    }
    lastPos = tagRe.lastIndex;

    if (tag.startsWith('<!--') || tag.startsWith('<?') || tag.startsWith('<!')) {
      out += tag;
      continue;
    }

    const isClosing = /^<\s*\//.test(tag);
    const isSelfClosing = /\/\s*>$/.test(tag);
    const nameMatch = tag.match(/^<\s*\/?\s*([^\s/>]+)/);
    if (!nameMatch) {
      out += tag;
      continue;
    }
    const fullName = nameMatch[1];
    const local = fullName.includes(':')
      ? fullName.slice(fullName.lastIndexOf(':') + 1).toLowerCase()
      : fullName.toLowerCase();

    if (!isClosing && local === 'topic') {
      out += tag;
      if (!isSelfClosing) topicDepth += 1;
      continue;
    }
    if (isClosing && local === 'topic') {
      out += tag;
      topicDepth = Math.max(0, topicDepth - 1);
      continue;
    }

    if (!isClosing && local === 'title') {
      out += tag;
      if (topicDepth > 0) {
        insideTopicTitle = true;
        if (isSelfClosing) {
          insideTopicTitle = false;
        }
      }
      continue;
    }

    if (isClosing && local === 'title') {
      if (insideTopicTitle) {
        const node = outlineNodes[idx++];
        out += encodeXmlEntities(node ? node.topic : '') + tag;
        insideTopicTitle = false;
      } else {
        out += tag;
      }
      continue;
    }

    out += tag;
  }

  if (!insideTopicTitle) {
    out += xml.slice(lastPos);
  }

  if (idx !== outlineNodes.length) {
    throw new Error(
      `xmind(xml) topic-title count ${idx} does not match outline nodes ${outlineNodes.length}. ` +
        'For .xmind files, this editor currently supports title editing only.'
    );
  }
  return out;
}

function collectTopicNodesPreOrder(topicObj: AnyTopic) {
  const list: AnyTopic[] = [];

  function walk(node: AnyTopic) {
    list.push(node);
    const topicsArr = node.topics ?? node.Topics ?? node.children ?? node.Children ?? null;
    const children = Array.isArray(topicsArr) ? topicsArr : [];
    for (const c of children) walk(c);
  }

  walk(topicObj);
  return list;
}

function applyOutlineTitlesInPlace(contentObj: AnyTopic, outlineTree: MindmapTree) {
  const topicNode = findFirstTopicLikeNode(contentObj);
  if (!topicNode) throw new Error('Cannot find topic-like root in content.json');

  const topicNodes = collectTopicNodesPreOrder(topicNode);

  const outlineNodes: MindmapTreeNode[] = [];
  function walkOutline(node: MindmapTreeNode) {
    outlineNodes.push(node);
    for (const ch of node.children) walkOutline(ch);
  }
  walkOutline(outlineTree.root);

  if (outlineNodes.length !== topicNodes.length) {
    throw new Error(
      `Outline has ${outlineNodes.length} nodes but xmind has ${topicNodes.length} topic nodes. ` +
        'For .xmind files, this editor currently supports title editing only (no add/delete/move).'
    );
  }

  for (let i = 0; i < outlineNodes.length; i++) {
    const n = topicNodes[i];
    const t = outlineNodes[i].topic;
    if (typeof n.title === 'string') n.title = t;
    else if (typeof n.Title === 'string') n.Title = t;
    else if (typeof n.topicTitle === 'string') n.topicTitle = t;
    else n.title = t;
  }
}

function readXmindContentFromFile(filePath: string) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const AdmZip = require('adm-zip');
  const zip = new AdmZip(filePath);
  let foundJson: { entryName: string; entries?: any[] } | null = null;
  let jsonErr: unknown = null;
  try {
    foundJson = findContentJsonEntry(zip);
  } catch (e) {
    jsonErr = e;
  }
  const foundXml = findContentXmlEntry(zip);
  const found = foundJson || foundXml;
  if (!found) {
    if (jsonErr instanceof Error) {
      throw new Error(
        `Cannot find supported xmind content entry. JSON scan failed with: ${jsonErr.message}; ` +
          'XML fallback (content.xml) also not found.'
      );
    }
    throw new Error('Cannot find content.json/content.xml inside .xmind zip');
  }

  const entryName = found.entryName;
  const contentRaw = zip.readFile(entryName);
  const contentStr = Buffer.isBuffer(contentRaw)
    ? contentRaw.toString('utf8')
    : String(contentRaw);

  const format = entryName.toLowerCase().endsWith('.xml') ? 'xml' : 'json';
  return { zip, entryName, contentStr, format };
}

function writeXmindContentJsonToFile(inputFilePath: string, outputFilePath: string, entryName: string, newContentStr: string) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const AdmZip = require('adm-zip');

  const zip = new AdmZip(inputFilePath);
  const entries = zip.getEntries();

  const outZip = new AdmZip();
  for (const e of entries) {
    if (e.isDirectory) continue;
    const name = e.entryName;
    if (name === entryName) {
      outZip.addFile(name, Buffer.from(newContentStr, 'utf8'));
      continue;
    }
    const data = zip.readFile(name);
    outZip.addFile(name, data);
  }
  outZip.writeZip(outputFilePath);
}

export function parseMindmapXmindFile(filePath: string): MindmapTree {
  const { contentStr, format } = readXmindContentFromFile(filePath);
  let outline: { title: string; children: any[] };
  if (format === 'xml') {
    outline = parseXmindContentXmlToOutline(contentStr);
  } else {
    const contentObj = safeParseJson(contentStr);
    const rootTopic = findFirstTopicLikeNode(contentObj);
    if (!rootTopic) throw new Error('Cannot find topic-like root in xmind content.json');
    outline = topicToOutlineTree(rootTopic);
  }
  const idGen = nextIdFactory();

  const toNode = (n: any): MindmapTreeNode => ({
    id: idGen(),
    topic: String(n.title ?? n.topic ?? n.name ?? ''),
    children: Array.isArray(n.children) ? n.children.map(toNode) : []
  });

  return { root: toNode(outline) };
}

export function writeMindmapXmindTitlesOnly(filePath: string, tree: MindmapTree) {
  const { entryName, contentStr, format } = readXmindContentFromFile(filePath);
  let newContentStr: string;
  if (format === 'xml') {
    newContentStr = applyOutlineTitlesToContentXml(contentStr, tree);
  } else {
    const contentObj = safeParseJson(contentStr);
    applyOutlineTitlesInPlace(contentObj, tree);
    newContentStr = JSON.stringify(contentObj, null, 2);
  }

  // In-place write: output directly to the original file path
  writeXmindContentJsonToFile(filePath, filePath, entryName, newContentStr);
}

