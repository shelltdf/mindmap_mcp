'use strict';

/**
 * 生成可在本地 HTTP 根目录下打开的脑图 Web 调试页（与 desktop/main.js 同源模板，资源改为 http URL，并注入 acquireVsCodeApi 桩）。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT_DIR = path.resolve(__dirname, '..');
const PANEL_TS = path.join(ROOT_DIR, 'src', 'panel.ts');
const OUT_HTML = path.join(ROOT_DIR, 'out', 'web_dev.html');

function extractPanelTemplate() {
  const src = fs.readFileSync(PANEL_TS, 'utf8');
  const startMarker = 'return /* html */ `<!DOCTYPE html>';
  const start = src.indexOf(startMarker);
  if (start < 0) {
    throw new Error('Cannot find html template in panel.ts');
  }
  const contentStart = start + 'return /* html */ `'.length;
  const endMarker = '</html>`;';
  const endIdx = src.indexOf(endMarker, contentStart);
  if (endIdx < 0) {
    throw new Error('Cannot find html template end in panel.ts');
  }
  return src.slice(contentStart, endIdx + '</html>'.length);
}

function defaultTree() {
  return { root: { id: 'root', topic: 'New Mindmap', children: [] } };
}

function makeWebDevHtml(host, port) {
  const base = `http://${host}:${port}`;
  const jsmindCssUrl = `${base}/media/jsmind/jsmind.css`;
  const jsmindScriptUrl = `${base}/media/jsmind/jsmind.js`;
  const nonce = crypto.randomBytes(8).toString('hex');
  const cspSource = `${base} data:`;
  const bootJsonForHtml = JSON.stringify({
    tree: defaultTree(),
    ext: 'mmd',
    uiLanguage: 'zh'
  }).replace(/</g, '\\u003c');

  let tpl = extractPanelTemplate();
  tpl = tpl
    .replace(/\$\{cspSource\}/g, cspSource)
    .replace(/\$\{nonce\}/g, nonce)
    .replace(/\$\{jsmindCssUrl\}/g, jsmindCssUrl)
    .replace(/\$\{jsmindScriptUrl\}/g, jsmindScriptUrl)
    .replace(/\$\{bootJsonForHtml\}/g, bootJsonForHtml);

  const bridge = `
    <script nonce="${nonce}">
(function () {
  if (typeof window.acquireVsCodeApi !== 'function') {
    window.acquireVsCodeApi = function () {
      return {
        postMessage: function (msg) {
          try {
            console.debug('[web-dev] vscode.postMessage', msg);
          } catch (_) {}
        },
        setState: function () {},
        getState: function () {
          return null;
        }
      };
    };
  }
})();
    </script>
`;

  const marker = `<script nonce="${nonce}" src="${jsmindScriptUrl}"></script>`;
  const pos = tpl.indexOf(marker);
  if (pos < 0) {
    throw new Error('Cannot find jsMind script tag for web-dev bridge injection');
  }
  return tpl.slice(0, pos + marker.length) + bridge + tpl.slice(pos + marker.length);
}

function main() {
  const host = process.argv[2] || '127.0.0.1';
  const port = parseInt(process.argv[3] || '8765', 10);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    console.error('error: invalid port');
    process.exit(1);
  }
  const html = makeWebDevHtml(host, port);
  fs.mkdirSync(path.dirname(OUT_HTML), { recursive: true });
  fs.writeFileSync(OUT_HTML, html, 'utf8');
  console.log(`wrote ${OUT_HTML}`);
}

main();
