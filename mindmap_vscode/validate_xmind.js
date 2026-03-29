const AdmZip = require('adm-zip');

const filePath =
  'E:/ai_dev/cursor_prj/tools/mindmap_vscode/_samples/new-mindmap-vscode-test.xmind';

function findFirstTopicLikeNode(cur, depth = 0, seen = new Set()) {
  if (!cur || typeof cur !== 'object' || depth > 15 || seen.has(cur)) return null;
  seen.add(cur);

  const title = cur.title || cur.Title || cur.topicTitle || cur.name;
  const maybeTopics = cur.topics || cur.Topics || cur.children || cur.Children || cur.topic;
  const topicsArr = Array.isArray(maybeTopics) ? maybeTopics : null;

  if (typeof title === 'string' && topicsArr) return cur;

  if (Array.isArray(cur)) {
    for (const item of cur) {
      const r = findFirstTopicLikeNode(item, depth + 1, seen);
      if (r) return r;
    }
  } else {
    for (const k of Object.keys(cur)) {
      const r = findFirstTopicLikeNode(cur[k], depth + 1, seen);
      if (r) return r;
    }
  }
  return null;
}

const zip = new AdmZip(filePath);
const entries = zip.getEntries();
const found = entries.find((e) => {
  const name = e.entryName.replace(/\\/g, '/');
  return name === 'content.json' || name.endsWith('/content.json');
});

if (!found) {
  console.error('Cannot find content.json');
  process.exit(1);
}

const contentStr = zip.readFile(found.entryName).toString('utf8');
const obj = JSON.parse(contentStr);

const rootTopic = findFirstTopicLikeNode(obj);
if (!rootTopic) {
  console.error('Cannot find topic-like root node in content.json');
  process.exit(2);
}

console.log('OK: root title =', rootTopic.title || rootTopic.Title || rootTopic.name);

