/**
 * 与 src/shared/mindmapCore.ts 保持语义一致（浏览器与 Webview 共用，修改时请同步 TS）。
 */
(function (global) {
  'use strict';

  function nextIdFactory() {
    var n = 0;
    return function () {
      return 'n_' + n++;
    };
  }

  function normalizeCoreMindmapTreeIds(tree) {
    var seq = 1;
    function walk(node, isRoot) {
      if (isRoot) {
        node.id = 'root';
      } else {
        node.id = 'n_' + seq;
        seq++;
      }
      var children = node.children || [];
      for (var i = 0; i < children.length; i++) {
        walk(children[i], false);
      }
    }
    walk(tree.root, true);
  }

  function extractMermaidBlock(text) {
    var m = text.match(/```mermaid\s*([\s\S]*?)```/i);
    if (m && m[1]) return m[1].trimEnd();
    return text.trimEnd();
  }

  function parseMermaidMindmap(text) {
    var mermaid = extractMermaidBlock(text);
    var lines = mermaid
      .split(/\r?\n/)
      .map(function (l) {
        return l.replace(/\t/g, '  ').trimEnd();
      })
      .filter(function (l) {
        return l.trim().length > 0;
      });
    if (lines.length === 0) throw new Error('Mindmap text is empty');
    var idGen = nextIdFactory();
    var stack = [];

    function parseLineToTopic(line) {
      var trimmed = line.trim();
      var rootMatch = trimmed.match(/^root\(\(\s*(.*?)\s*\)\)\s*$/);
      if (rootMatch) return rootMatch[1];
      return trimmed.replace(/^-+\s*/, '');
    }

    function leadingSpaces(s) {
      var m = s.match(/^ */);
      return m ? m[0].length : 0;
    }

    var startIdx = 0;
    if (lines[0].trim().startsWith('mindmap')) startIdx = 1;
    var rootCandidate = lines[startIdx];
    if (!rootCandidate) throw new Error('Cannot find root line');

    var rootDepth = Math.floor(leadingSpaces(rootCandidate) / 2);
    var root = { id: idGen(), topic: parseLineToTopic(rootCandidate), children: [] };
    stack.push({ node: root, depth: rootDepth });

    for (var i = startIdx + 1; i < lines.length; i++) {
      var raw = lines[i];
      var depth = Math.floor(leadingSpaces(raw) / 2);
      var node = { id: idGen(), topic: parseLineToTopic(raw), children: [] };
      while (stack.length > 0 && stack[stack.length - 1].depth >= depth) {
        stack.pop();
      }
      if (stack.length === 0) {
        stack.push({ node: root, depth: rootDepth });
      }
      stack[stack.length - 1].node.children.push(node);
      stack.push({ node: node, depth: depth });
    }
    return { root: root };
  }

  function escapeMermaidTopic(s) {
    return String(s).replace(/\)\)/g, ') )');
  }

  function parseCoreMindmapText(text, ext) {
    if (ext === 'jm') {
      var obj = JSON.parse(text);
      if (obj && obj.root && obj.root.topic !== undefined) {
        function toNode(n) {
          var o = {
            id: typeof n.id === 'string' ? n.id : 'n_' + Math.random().toString(16).slice(2),
            topic: String(n.topic != null ? n.topic : ''),
            children: Array.isArray(n.children) ? n.children.map(toNode) : []
          };
          if (n.data && typeof n.data === 'object') {
            try {
              o.data = JSON.parse(JSON.stringify(n.data));
            } catch (_) {}
          }
          return o;
        }
        var out = { root: toNode(obj.root) };
        normalizeCoreMindmapTreeIds(out);
        return out;
      }
      var data = obj && obj.data;
      if (!data) throw new Error('Unsupported .jm JSON: missing "data" field');
      function toNodeData(n) {
        var o = {
          id: n && typeof n.id === 'string' ? n.id : 'n_' + Math.random().toString(16).slice(2),
          topic: String(n && n.topic != null ? n.topic : ''),
          children: Array.isArray(n && n.children) ? n.children.map(toNodeData) : []
        };
        if (n && n.data && typeof n.data === 'object') {
          try {
            o.data = JSON.parse(JSON.stringify(n.data));
          } catch (_) {}
        }
        return o;
      }
      var out2 = { root: toNodeData(data) };
      normalizeCoreMindmapTreeIds(out2);
      return out2;
    }
    var mer = parseMermaidMindmap(text);
    normalizeCoreMindmapTreeIds(mer);
    return mer;
  }

  function serializeCoreMindmapTree(tree, ext) {
    if (ext === 'jm') {
      function toJmNode(node) {
        var o = {
          id: node.id,
          topic: node.topic,
          children: (node.children || []).map(toJmNode)
        };
        if (node.data && typeof node.data === 'object' && Object.keys(node.data).length) {
          try {
            o.data = JSON.parse(JSON.stringify(node.data));
          } catch (_) {}
        }
        return o;
      }
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
    var lines = [];
    lines.push('mindmap');
    lines.push('  root((' + escapeMermaidTopic(tree.root.topic) + '))');
    function emitChildren(node, depth) {
      for (var i = 0; i < node.children.length; i++) {
        var ch = node.children[i];
        var indent = '  '.repeat(depth + 2);
        lines.push(indent + escapeMermaidTopic(ch.topic));
        emitChildren(ch, depth + 1);
      }
    }
    emitChildren(tree.root, 0);
    return lines.join('\n') + '\n';
  }

  global.MindmapCore = {
    parseCoreMindmapText: parseCoreMindmapText,
    serializeCoreMindmapTree: serializeCoreMindmapTree,
    normalizeCoreMindmapTreeIds: normalizeCoreMindmapTreeIds
  };
})(typeof self !== 'undefined' ? self : this);
