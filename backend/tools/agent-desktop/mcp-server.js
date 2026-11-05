const readline = require('readline');
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

function resolveDesktopRunner() {
  const candidates = [
    path.join(__dirname, 'desktop-runner.exe'),
    path.join(__dirname, '..', 'bin', 'desktop-runner.exe'),
    'E:\\nodejs\\node_modules\\agent-desktop\\bin\\desktop-runner.exe'
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function resolveNativeExe() {
  const arch = process.arch === 'arm64' ? 'win32-arm64' : 'win32-x64';
  const binaryName = `agent-desktop-${arch}.exe`;
  const candidates = [
    path.join(__dirname, 'agent-desktop.exe'),
    path.join(__dirname, binaryName),
    path.join(__dirname, '..', 'bin', binaryName),
    path.join('E:\\nodejs\\node_modules\\agent-desktop\\bin', binaryName)
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  try {
    const globalPkg = require.resolve('agent-desktop/package.json');
    const fromPkg = path.join(path.dirname(globalPkg), 'bin', binaryName);
    if (fs.existsSync(fromPkg)) return fromPkg;
  } catch {}
  return candidates[0];
}

const nativeExe = resolveNativeExe();
const desktopRunner = resolveDesktopRunner();

let activeSessionId = null;

function ensureActiveSessionWithCursor(spawnBin, targetExe) {
  if (activeSessionId) return activeSessionId;
  try {
    const sRes = spawnSync(spawnBin, [targetExe, 'session', 'start', '--cursor'], {
      encoding: 'utf8',
      windowsHide: false,
      timeout: 6000
    });
    if (sRes.stdout) {
      const parsed = JSON.parse(sRes.stdout);
      if (parsed?.data?.session_id) {
        activeSessionId = parsed.data.session_id;
        process.env.AGENT_DESKTOP_SESSION = activeSessionId;
        // 只改呈现：放大虚拟光标。不传 --no-ripple / --no-highlight，点击波纹和控件轮廓保持开启。
        const overlayRes = spawnSync(spawnBin, [
          targetExe, 'cursor-overlay', 'enable',
          '--session', activeSessionId,
          '--accent', '#00E5FF',
          '--size', '2.0',
          '--label', 'Maf Computer Use'
        ], {
          encoding: 'utf8',
          windowsHide: false,
          timeout: 8000
        });
        let rendered = parsed?.data?.rendered === true;
        if (overlayRes.stdout) {
          try {
            const overlay = JSON.parse(overlayRes.stdout);
            if (overlay?.data && Object.prototype.hasOwnProperty.call(overlay.data, 'rendered')) {
              rendered = overlay.data.rendered === true;
            }
            const style = overlay?.data?.cursor_overlay?.style || overlay?.data?.style;
            if (style && (style.ripple === false || style.highlight === false)) {
              console.error('[AGENT-DESKTOP-MCP] Overlay style missing ripple or highlight: ' + JSON.stringify(style));
            }
          } catch (parseErr) {
            console.error('[AGENT-DESKTOP-MCP] Overlay enable response was not JSON: ' + parseErr.message);
          }
        }
        if (!rendered) {
          console.error('[AGENT-DESKTOP-MCP] Cursor overlay was not drawn. The CLI must run as agent-desktop.exe. stderr: ' + (overlayRes.stderr || sRes.stderr || '').trim());
        }
        console.error('[AGENT-DESKTOP-MCP] Visual cursor overlay enabled in session: ' + activeSessionId + ' rendered=' + rendered);
      }
    }
  } catch (err) {
    console.error('[AGENT-DESKTOP-MCP] Failed to start cursor overlay session: ' + err.message);
    return null;
  }
  return activeSessionId;
}

function endActiveSession() {
  if (!activeSessionId) return;
  try {
    const spawnBin = fs.existsSync(desktopRunner) ? desktopRunner : nativeExe;
    spawnSync(spawnBin, [nativeExe, 'session', 'end', '--session', activeSessionId], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 4000
    });
  } catch {}
}

for (const ev of ['SIGINT', 'SIGTERM', 'beforeExit']) {
  process.once(ev, endActiveSession);
}

// 56 commands from agent-desktop
const COMMANDS = [
  { name: 'snapshot', desc: 'Capture accessibility tree as structured JSON with @ref IDs', params: { app: { type: 'string', description: 'Application name' }, root: { type: 'string', description: 'Root @ref element' }, compact: { type: 'boolean', description: 'Compact output' }, interactive_only: { type: 'boolean', description: 'Only interactive nodes (-i)' } } },
  { name: 'find', desc: 'Search elements by role, name, value, or text content', params: { role: { type: 'string' }, text: { type: 'string' }, app: { type: 'string' }, root: { type: 'string' } } },
  { name: 'screenshot', desc: 'Take a PNG screenshot of an application window', params: { app: { type: 'string' }, out: { type: 'string' } } },
  { name: 'get', desc: 'Read an element property (text, value, title, bounds, role, states)', params: { ref: { type: 'string', description: 'Target @ref' } } },
  { name: 'is', desc: 'Check element state (visible, enabled, checked, focused, expanded, selected)', params: { ref: { type: 'string', description: 'Target @ref' }, state: { type: 'string' } } },
  { name: 'click', desc: 'Click element via accessibility press action', params: { ref: { type: 'string', description: 'Target @ref' } } },
  { name: 'double_click', cli: 'double-click', desc: 'Physically double-click element; requires --headed', params: { ref: { type: 'string' } } },
  { name: 'triple_click', cli: 'triple-click', desc: 'Triple-click element', params: { ref: { type: 'string' } } },
  { name: 'right_click', cli: 'right-click', desc: 'Open a context menu semantically', params: { ref: { type: 'string' } } },
  { name: 'type', desc: 'Insert text into a text target', params: { ref: { type: 'string', description: 'Target @ref' }, text: { type: 'string', description: 'Text to type' } } },
  { name: 'set_value', cli: 'set-value', desc: 'Set element value directly via accessibility attribute', params: { ref: { type: 'string' }, value: { type: 'string' } } },
  { name: 'clear', desc: 'Clear element value to empty string', params: { ref: { type: 'string' } } },
  { name: 'focus', desc: 'Set keyboard focus on element', params: { ref: { type: 'string' } } },
  { name: 'select', desc: 'Select an option in a list or dropdown', params: { ref: { type: 'string' }, option: { type: 'string' } } },
  { name: 'toggle', desc: 'Toggle a checkbox or switch', params: { ref: { type: 'string' } } },
  { name: 'check', desc: 'Set checkbox or switch to checked state (idempotent)', params: { ref: { type: 'string' } } },
  { name: 'uncheck', desc: 'Set checkbox or switch to unchecked state (idempotent)', params: { ref: { type: 'string' } } },
  { name: 'expand', desc: 'Expand a disclosure triangle or tree item', params: { ref: { type: 'string' } } },
  { name: 'collapse', desc: 'Collapse a disclosure triangle or tree item', params: { ref: { type: 'string' } } },
  { name: 'scroll', desc: 'Scroll element (--direction up/down/left/right, --amount N)', params: { ref: { type: 'string' }, direction: { type: 'string' }, amount: { type: 'number' } } },
  { name: 'scroll_to', cli: 'scroll-to', desc: 'Scroll element into visible area', params: { ref: { type: 'string' } } },
  { name: 'press', desc: 'Send a key combo: return, escape, cmd+c, shift+tab ...', params: { key: { type: 'string', description: 'Key combo e.g. return, enter, ctrl+s' } } },
  { name: 'key_down', cli: 'key-down', desc: 'Hold a key or modifier down', params: { key: { type: 'string' } } },
  { name: 'key_up', cli: 'key-up', desc: 'Release a held key or modifier', params: { key: { type: 'string' } } },
  { name: 'hover', desc: 'Move cursor to element center or coordinates (requires --headed)', params: { ref: { type: 'string' } } },
  { name: 'drag', desc: 'Drag from one element or point to another (requires --headed)', params: { from: { type: 'string' }, to: { type: 'string' } } },
  { name: 'mouse_move', cli: 'mouse-move', desc: 'Move cursor to absolute screen coordinates (requires --headed)', params: { x: { type: 'number' }, y: { type: 'number' } } },
  { name: 'mouse_click', cli: 'mouse-click', desc: 'Click at absolute screen coordinates (requires --headed)', params: { x: { type: 'number' }, y: { type: 'number' } } },
  { name: 'mouse_down', cli: 'mouse-down', desc: 'Press mouse button at coordinates', params: { button: { type: 'string' } } },
  { name: 'mouse_up', cli: 'mouse-up', desc: 'Release mouse button at coordinates', params: { button: { type: 'string' } } },
  { name: 'mouse_wheel', cli: 'mouse-wheel', desc: 'Scroll the mouse wheel at absolute coordinates', params: { delta_y: { type: 'number' } } },
  { name: 'launch', desc: 'Launch application and return once its process is running', params: { app: { type: 'string', description: 'Application name, path or command' }, activate: { type: 'boolean', description: 'Wait for window activation' } } },
  { name: 'close_app', cli: 'close-app', desc: 'Quit an application gracefully (--force to terminate)', params: { app: { type: 'string' }, force: { type: 'boolean' } } },
  { name: 'list_windows', cli: 'list-windows', desc: 'List all visible windows (--app to filter by application)', params: { app: { type: 'string' } } },
  { name: 'list_displays', cli: 'list-displays', desc: 'List connected displays with bounds and scale factor', params: {} },
  { name: 'list_apps', cli: 'list-apps', desc: 'List all running GUI applications (--app to filter)', params: { app: { type: 'string' } } },
  { name: 'focus_window', cli: 'focus-window', desc: 'Bring a window to front and confirm OS focus', params: { app: { type: 'string' }, title: { type: 'string' } } },
  { name: 'resize_window', cli: 'resize-window', desc: 'Resize application window', params: { app: { type: 'string' }, width: { type: 'number' }, height: { type: 'number' } } },
  { name: 'move_window', cli: 'move-window', desc: 'Move application window to new position', params: { app: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' } } },
  { name: 'minimize', desc: 'Minimize application window', params: { app: { type: 'string' } } },
  { name: 'maximize', desc: 'Maximize or zoom application window', params: { app: { type: 'string' } } },
  { name: 'restore', desc: 'Restore minimized or maximized window', params: { app: { type: 'string' } } },
  { name: 'list_surfaces', cli: 'list-surfaces', desc: 'List accessibility surfaces for an app (window, menu, sheet ...)', params: { app: { type: 'string' } } },
  { name: 'open_system_surface', cli: 'open-system-surface', desc: 'Open a shell surface (start-menu, taskbar, dock ...)', params: { surface: { type: 'string' } } },
  { name: 'list_notifications', cli: 'list-notifications', desc: 'List notifications from Notification Center', params: {} },
  { name: 'dismiss_notification', cli: 'dismiss-notification', desc: 'Dismiss a notification by index', params: { index: { type: 'number' } } },
  { name: 'dismiss_all_notifications', cli: 'dismiss-all-notifications', desc: 'Dismiss all notifications (--app to filter)', params: { app: { type: 'string' } } },
  { name: 'notification_action', cli: 'notification-action', desc: 'Click an action button on a notification', params: { index: { type: 'number' }, action: { type: 'string' } } },
  { name: 'clipboard_get', cli: 'clipboard-get', desc: 'Read plain-text or typed clipboard contents', params: {} },
  { name: 'clipboard_set', cli: 'clipboard-set', desc: 'Write text to the clipboard', params: { text: { type: 'string' } } },
  { name: 'clipboard_clear', cli: 'clipboard-clear', desc: 'Clear the clipboard', params: {} },
  { name: 'wait', desc: 'Wait for time (ms), element presence, text, or window appearance', params: { time: { type: 'number', description: 'Milliseconds to wait' }, element: { type: 'string', description: '@ref to wait for' }, timeout: { type: 'number' } } },
  { name: 'status', desc: 'Show adapter health, platform info, and permission state', params: {} },
  { name: 'permissions', desc: 'Check nested permission states', params: {} },
  { name: 'version', desc: 'Show version, target architecture, and OS', params: {} },
  { name: 'batch', desc: 'Execute a bounded, sequential, non-atomic JSON command batch', params: { commands: { type: 'string' } } }
];

function runMcpServer() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false
  });

  const send = (msg) => {
    process.stdout.write(JSON.stringify(msg) + '\n');
  };

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let req;
    try {
      req = JSON.parse(trimmed);
    } catch {
      return;
    }

    const { id, method, params } = req;

    if (method === 'initialize') {
      send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: params?.protocolVersion || '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'agent-desktop', version: '1.1.0' }
        }
      });
      return;
    }

    if (method === 'notifications/initialized') {
      return;
    }

    if (method === 'ping') {
      send({ jsonrpc: '2.0', id, result: {} });
      return;
    }

    if (method === 'tools/list') {
      const tools = COMMANDS.map((c) => {
        const toolName = `desktop_${c.name}`;
        const properties = {};
        const required = [];
        for (const [k, v] of Object.entries(c.params || {})) {
          properties[k] = { type: v.type, description: v.description || k };
        }
        return {
          name: toolName,
          description: c.desc,
          inputSchema: {
            type: 'object',
            properties,
            required
          }
        };
      });

      send({
        jsonrpc: '2.0',
        id,
        result: { tools }
      });
      return;
    }

    if (method === 'tools/call') {
      const toolName = params?.name || '';
      const args = params?.arguments || {};
      console.error('[AGENT-DESKTOP-MCP] tools/call: ' + toolName, JSON.stringify(args));

      const spawnBin = fs.existsSync(desktopRunner) ? desktopRunner : nativeExe;
      const sessionId = ensureActiveSessionWithCursor(spawnBin, nativeExe);

      const stripped = toolName.startsWith('desktop_') ? toolName.slice(8) : toolName;
      const cmdDef = COMMANDS.find((c) => c.name === stripped);

      if (!cmdDef) {
        send({
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Unknown tool: ${toolName}` }
        });
        return;
      }

      const cliCmd = cmdDef.cli || cmdDef.name;
      const cliArgs = [cliCmd];

      // Build CLI args
      if (args.ref) {
        cliArgs.push(String(args.ref));
      }
      if (args.app) {
        if (cliCmd === 'launch' || cliCmd === 'close-app') {
          cliArgs.push(String(args.app));
        } else {
          cliArgs.push('--app', String(args.app));
        }
      }
      if (args.text !== undefined) {
        if (cliCmd === 'type' || cliCmd === 'find') {
          cliArgs.push(String(args.text));
          if (cliCmd === 'type' && !cliArgs.includes('--headed')) {
            cliArgs.push('--headed');
          }
        } else {
          cliArgs.push('--text', String(args.text));
        }
      }
      if (args.value !== undefined) {
        if (cliCmd === 'set-value') {
          cliArgs.push(String(args.value));
        } else {
          cliArgs.push('--value', String(args.value));
        }
      }
      if (args.key) {
        cliArgs.push(String(args.key));
      }
      if (args.root) {
        cliArgs.push('--root', String(args.root));
      }
      if (args.compact) {
        cliArgs.push('--compact');
      }
      if (args.interactive_only) {
        cliArgs.push('-i');
      }
      if (args.activate) {
        cliArgs.push('--activate');
      }
      if (args.force) {
        cliArgs.push('--force');
      }
      if (args.time) {
        cliArgs.push(String(args.time));
      }

      for (const [k, v] of Object.entries(args)) {
        if (['ref', 'app', 'text', 'value', 'key', 'root', 'compact', 'interactive_only', 'activate', 'force', 'time'].includes(k)) continue;
        if (typeof v === 'boolean') {
          if (v) cliArgs.push(`--${k.replace(/_/g, '-')}`);
        } else if (v !== undefined && v !== null) {
          cliArgs.push(`--${k.replace(/_/g, '-')}`, String(v));
        }
      }

      if (sessionId && !cliArgs.includes('--session')) {
        cliArgs.push('--session', sessionId);
      }

      try {
        if (cliCmd === 'launch' && !cliArgs.includes('--timeout')) {
          cliArgs.push('--timeout', '4000');
        }
        const spawnArgs = fs.existsSync(desktopRunner) ? [nativeExe, ...cliArgs] : cliArgs;
        const res = spawnSync(spawnBin, spawnArgs, {
          encoding: 'utf8',
          windowsHide: false,
          timeout: 45000
        });

        const stdout = res.stdout ? res.stdout.trim() : '';
        const stderr = res.stderr ? res.stderr.trim() : '';
        const output = stdout || stderr || (res.status === 0 ? '{"ok":true}' : `{"ok":false,"code":${res.status}}`);
        console.error('[AGENT-DESKTOP-MCP] result: ' + toolName, output.slice(0, 150));

        send({
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: output }],
            isError: res.status !== 0
          }
        });
      } catch (err) {
        send({
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: `Execution failed: ${err.message}` }],
            isError: true
          }
        });
      }
      return;
    }

    send({
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Method not found: ${method}` }
    });
  });
}

module.exports = { runMcpServer };

if (require.main === module || !module.parent) {
  runMcpServer();
}

