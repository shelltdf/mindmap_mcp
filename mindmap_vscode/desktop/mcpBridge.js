'use strict';

/**
 * 桌面 MCP HTTP 桥：请求解析与业务逻辑在编译产物 `dist/shared/mcpBridgeCore.js`（源 `src/shared/mcpBridgeCore.ts`）。
 * @param {number} port
 * @param {string} token
 * @param {() => object} getHost — 返回 McpBridgeHost（与 `src/shared/mcpBridgeCore.ts` 一致）
 * @param {(err: Error) => void} [onListenError]
 * @param {string} [resourcesRoot] — `mindmap_vscode` 根目录（开发：`path.join(__dirname, '..')`；打包：`ROOT_DIR` → resources/mindmap-app）
 */
const http = require('http');
const path = require('path');

function startMindmapMcpBridgeHttp(port, token, getHost, onListenError, resourcesRoot) {
  const root = resourcesRoot || path.join(__dirname, '..');
  // eslint-disable-next-line import/no-dynamic-require
  const core = require(path.join(root, 'dist', 'shared', 'mcpBridgeCore.js'));
  const state = { listening: false };
  const server = http.createServer(core.attachMcpBridgeRequestListener(token, getHost));

  server.on('error', (err) => {
    state.listening = false;
    if (typeof onListenError === 'function') {
      onListenError(err);
    } else {
      console.error('[mindmap-mcp-bridge]', err);
    }
  });

  server.listen(port, '127.0.0.1', () => {
    state.listening = true;
  });

  return {
    port,
    get listening() {
      return state.listening;
    },
    close: () => {
      state.listening = false;
      try {
        server.close();
      } catch {
        // ignore
      }
    }
  };
}

module.exports = {
  startMindmapMcpBridgeHttp
};
