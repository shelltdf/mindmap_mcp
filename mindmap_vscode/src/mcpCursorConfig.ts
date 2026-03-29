import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as vscode from 'vscode';

function mcpScriptPath(context: vscode.ExtensionContext): string {
  const p = path.join(context.extensionPath, 'mcp-server', 'dist', 'index.js');
  return p.replace(/\\/g, '/');
}

function readJsonIfExists(filePath: string): Record<string, unknown> {
  try {
    if (!fs.existsSync(filePath)) return {};
    const text = fs.readFileSync(filePath, 'utf8');
    const j = JSON.parse(text) as unknown;
    return j && typeof j === 'object' && !Array.isArray(j) ? (j as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function writeJsonPretty(filePath: string, data: Record<string, unknown>) {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

export async function buildMindmapMcpServerBlock(
  context: vscode.ExtensionContext,
  getToken: () => Promise<string>
): Promise<{ command: string; args: string[]; env: Record<string, string> }> {
  const cfg = vscode.workspace.getConfiguration('mindmap');
  const port = cfg.get<number>('mcpBridge.port', 58741);
  const token = await getToken();
  const script = mcpScriptPath(context);
  if (!fs.existsSync(script)) {
    throw new Error(
      `未找到 MCP 入口：${script}。请使用已打包的扩展（含 mcp-server），或在本仓库执行 build / mcp-server 编译。`
    );
  }
  return {
    command: 'node',
    args: [script],
    env: {
      MINDMAP_BRIDGE_URL: `http://127.0.0.1:${port}`,
      MINDMAP_BRIDGE_TOKEN: token
    }
  };
}

export async function mergeCursorMcpJsonFile(
  context: vscode.ExtensionContext,
  filePath: string,
  getToken: () => Promise<string>
): Promise<void> {
  const block = await buildMindmapMcpServerBlock(context, getToken);
  const base = readJsonIfExists(filePath);
  const servers =
    base.mcpServers && typeof base.mcpServers === 'object' && !Array.isArray(base.mcpServers)
      ? { ...(base.mcpServers as Record<string, unknown>) }
      : {};
  servers['user-mindmap'] = block;
  base.mcpServers = servers;
  await writeJsonPretty(filePath, base);
}

export async function configureMindmapMcpForWorkspace(
  context: vscode.ExtensionContext,
  getToken: () => Promise<string>
): Promise<void> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) {
    vscode.window.showErrorMessage('Mindmap MCP：请先打开包含工作区文件夹的窗口。');
    return;
  }
  const root = folders[0].uri.fsPath;
  const mcpPath = path.join(root, '.cursor', 'mcp.json');
  await mergeCursorMcpJsonFile(context, mcpPath, getToken);
  const rel = path.relative(root, mcpPath);
  vscode.window.showInformationMessage(
    `已写入 Mindmap MCP：${rel}（使用扩展内置路径，无需手写盘符）。重载 Cursor 窗口后生效。`
  );
}

export async function configureMindmapMcpForUserHome(
  context: vscode.ExtensionContext,
  getToken: () => Promise<string>
): Promise<void> {
  const mcpPath = path.join(os.homedir(), '.cursor', 'mcp.json');
  await mergeCursorMcpJsonFile(context, mcpPath, getToken);
  vscode.window.showInformationMessage(
    '已合并到用户目录 ~/.cursor/mcp.json。重载 Cursor 窗口后生效。'
  );
}

export async function maybeAutoConfigureCursorMcp(
  context: vscode.ExtensionContext,
  getToken: () => Promise<string>
): Promise<void> {
  const mode = vscode.workspace
    .getConfiguration('mindmap')
    .get<string>('mcpBridge.cursorConfig', 'prompt');
  if (mode === 'off') return;

  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) return;

  const mcpPath = path.join(folders[0].uri.fsPath, '.cursor', 'mcp.json');
  try {
    if (fs.existsSync(mcpPath)) {
      const j = readJsonIfExists(mcpPath);
      const s = j.mcpServers as Record<string, unknown> | undefined;
      if (s && typeof s === 'object' && s['user-mindmap']) return;
    }
  } catch {
    // continue
  }

  if (mode === 'workspace') {
    await configureMindmapMcpForWorkspace(context, getToken);
    return;
  }

  if (context.workspaceState.get('mindmap.cursorMcpPromptDismissed')) return;

  const pick = await vscode.window.showInformationMessage(
    'Mindmap：是否在本工作区自动写入 Cursor MCP（.cursor/mcp.json）？将使用当前扩展安装目录下的 MCP，无需手写绝对路径。',
    '写入',
    '稍后',
    '不再询问'
  );
  if (pick === '写入') {
    await configureMindmapMcpForWorkspace(context, getToken);
  }
  if (pick === '不再询问') {
    await context.workspaceState.update('mindmap.cursorMcpPromptDismissed', true);
  }
}

/** 用于排查「Tools / MCP 里看不到 user-mindmap」 */
export function diagnoseMindmapMcpSetup(context: vscode.ExtensionContext): string {
  const lines: string[] = [];
  const script = mcpScriptPath(context);
  lines.push('=== Mindmap MCP 诊断 ===');
  lines.push(`扩展目录: ${context.extensionPath}`);
  lines.push(`MCP 入口: ${script}`);
  lines.push(`入口文件存在: ${fs.existsSync(script) ? '是' : '否（需安装含 mcp-server 的 VSIX 或执行 npm run mcp:pack）'}`);
  const cfg = vscode.workspace.getConfiguration('mindmap');
  lines.push(`桥接端口: ${cfg.get<number>('mcpBridge.port', 58741)}`);
  lines.push(`桥接启用: ${cfg.get<boolean>('mcpBridge.enable', true) ? '是' : '否'}`);
  lines.push('');

  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) {
    lines.push('工作区: 未打开文件夹（仅打开单个文件时，项目级 .cursor/mcp.json 不会作为该「项目」加载）。');
    lines.push('请用「文件 → 打开文件夹」打开包含 .cursor 的项目根目录。');
  } else {
    const w = path.join(folders[0].uri.fsPath, '.cursor', 'mcp.json');
    lines.push(`工作区 .cursor/mcp.json: ${w}`);
    lines.push(`文件存在: ${fs.existsSync(w) ? '是' : '否'}`);
    if (fs.existsSync(w)) {
      const j = readJsonIfExists(w);
      const s = j.mcpServers as Record<string, unknown> | undefined;
      lines.push(`已配置 user-mindmap: ${s && typeof s === 'object' && s['user-mindmap'] ? '是' : '否'}`);
    }
  }
  lines.push('');

  const u = path.join(os.homedir(), '.cursor', 'mcp.json');
  lines.push(`用户 ~/.cursor/mcp.json: ${u}`);
  lines.push(`文件存在: ${fs.existsSync(u) ? '是' : '否'}`);
  if (fs.existsSync(u)) {
    const j = readJsonIfExists(u);
    const s = j.mcpServers as Record<string, unknown> | undefined;
    lines.push(`已配置 user-mindmap: ${s && typeof s === 'object' && s['user-mindmap'] ? '是' : '否'}`);
  }
  lines.push('');
  lines.push('下一步：');
  lines.push('1) 若未配置：命令面板执行「Mindmap: Configure Cursor MCP (Workspace)」或「(User)」。');
  lines.push('2) 保存 mcp.json 后：完全退出 Cursor 再打开，或 Ctrl+Shift+P → Developer: Reload Window。');
  lines.push('3) 在 Cursor Settings → MCP 中查看该服务器是否报错（进程启动失败会显示在日志里）。');
  lines.push('4) 确认本机终端执行 `node --version` 正常（MCP 使用 command: node）。');
  return lines.join('\n');
}
