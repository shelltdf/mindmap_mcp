'use strict';

/**
 * 桌面 MCP HTTP 桥：请求解析与业务逻辑在编译产物 `dist/shared/mcpBridgeCore.js`（源 `src/shared/mcpBridgeCore.ts`）。
 * @param {number} port
 * @param {string} token
 * @param {() => object} getHost — 返回 McpBridgeHost（与 `src/shared/mcpBridgeCore.ts` 一致）
 * @param {(err: Error) => void} [onStartupError]
 * @param {(err: Error) => void} [onListenError]
 * @param {string} [resourcesRoot] — `mindmap_vscode` 根目录（开发：`path.join(__dirname, '..')`；打包：`ROOT_DIR` → resources/mindmap-app）
 */
const http = require('http');
const path = require('path');

function reportBridgeError(err, onListenError) {
  if (typeof onListenError === 'function') {
    onListenError(err);
  } else {
    console.error('[mindmap-mcp-bridge]', err);
  }
}

function createBridgeRef(port, state, server) {
  return {
    port,
    get listening() {
      return state.listening;
    },
    get startupError() {
      return state.startupError || null;
    },
    close: () => {
      state.listening = false;
      try {
        if (server) server.close();
      } catch {
        // ignore
      }
    }
  };
}

function startMindmapMcpBridgeHttp(port, token, getHost, onStartupError, onListenError, resourcesRoot) {
  const root = resourcesRoot || path.join(__dirname, '..');
  const corePath = path.join(root, 'dist', 'shared', 'mcpBridgeCore.js');
  const state = { listening: false, startupError: null };
  let core;
  try {
    // eslint-disable-next-line import/no-dynamic-require
    core = require(corePath);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    state.startupError = new Error(
      `Cannot load shared MCP bridge core: ${corePath}. Build the extension first (for example: npm run compile in mindmap_vscode). ${detail}`
    );
    reportBridgeError(state.startupError, onStartupError);
    return createBridgeRef(port, state, null);
  }
  const server = http.createServer(core.attachMcpBridgeRequestListener(token, getHost));

  server.on('error', (err) => {
    state.listening = false;
    reportBridgeError(err, onListenError);
  });

  server.listen(port, '127.0.0.1', () => {
    state.listening = true;
  });

  return createBridgeRef(port, state, server);
}

module.exports = {
  startMindmapMcpBridgeHttp
};
