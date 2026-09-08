'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const HOST_PROCESS = /^(?:node|nodejs|copilot|claude|codex|opencode|hermes|openclaw|code(?: helper(?: \(plugin\))?)?)(?:\.exe)?$/i;
let cachedScope;

function readProcessScope(opts = {}) {
  if (cachedScope !== undefined && !opts.exec) return cachedScope;
  const exec = opts.exec || execFileSync;
  const platform = opts.platform || process.platform;
  let scope = '';
  try {
    const commandOptions = {
      // PowerShell/CIM cold starts can exceed two seconds on busy Windows hosts.
      // Keep the lookup bounded below the telemetry hook's ten-second deadline.
      encoding: 'utf8', timeout: platform === 'win32' ? 5000 : 2000, maxBuffer: 2 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      env: { ...process.env, LC_ALL: 'C' },
    };
    let rows;
    if (platform === 'win32') {
      // Request only identity fields from CIM, not unused command lines or paths.
      const output = exec('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        'Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate,Name | Select-Object ProcessId,ParentProcessId,CreationDate,Name | ConvertTo-Json -Compress',
      ], commandOptions);
      rows = [].concat(JSON.parse(output)).map((row) => ({
        pid: Number(row.ProcessId), parent: Number(row.ParentProcessId),
        started: row.CreationDate, name: row.Name,
      }));
    } else {
      // ps emits e.g. "123 1 Tue Sep  8 05:00:00 2026 /path/to/copilot".
      // Read executable names, never command arguments, environment, or tokens.
      const output = exec('ps', ['-A', '-o', 'pid=,ppid=,lstart=,comm='], commandOptions);
      rows = String(output).split('\n').flatMap((line) => {
        const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/);
        return match ? [{
          pid: Number(match[1]), parent: Number(match[2]), started: match[3], name: match[4],
        }] : [];
      });
    }
    const processes = new Map(rows.map((row) => [row.pid, row]));
    const visited = new Set();
    let parentPid = opts.parentPid || process.ppid;
    while (parentPid > 1 && visited.size < 32 && !visited.has(parentPid)) {
      visited.add(parentPid);
      const parent = processes.get(parentPid);
      if (!parent) break;
      const name = platform === 'win32' ? path.win32.basename(parent.name) : path.basename(parent.name);
      if (parent.started && HOST_PROCESS.test(name)) {
        // A PID alone can be reused after the host exits. Its creation time is
        // part of the local key so unrelated runs cannot inherit old sessions.
        scope = `${parent.pid}:${parent.started}`;
        break;
      }
      parentPid = parent.parent;
    }
  } catch {
    // Unsupported hosts or unavailable process metadata keep the old fallback.
  }
  if (!opts.exec) cachedScope = scope;
  return scope;
}

function resolveProcessSessionId(hostSessionId, opts = {}) {
  let temporaryPath;
  try {
    if (!opts.cwd || !opts.configDir) return hostSessionId;
    const scope = (opts.readProcessScope || readProcessScope)();
    if (!scope) return hostSessionId;
    const projectRoot = fs.realpathSync(opts.cwd);
    const key = crypto.createHash('sha256').update(JSON.stringify([projectRoot, scope])).digest('hex');
    const directory = path.join(opts.configDir, 'telemetry', 'mobile-app', 'host-sessions');
    const contextPath = path.join(directory, `${key}.json`);
    if (hostSessionId) {
      // This is a host-context handoff, not an event queue. The only stored
      // value is the host session id; project/process metadata stays in a hash.
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      temporaryPath = `${contextPath}.${crypto.randomUUID()}.tmp`;
      fs.writeFileSync(temporaryPath, JSON.stringify({ sessionId: hostSessionId }), {
        encoding: 'utf8', flag: 'wx', mode: 0o600,
      });
      fs.renameSync(temporaryPath, contextPath);
      return hostSessionId;
    }
    const saved = JSON.parse(fs.readFileSync(contextPath, 'utf8'));
    return typeof saved.sessionId === 'string' ? saved.sessionId : '';
  } catch {
    return hostSessionId;
  } finally {
    if (temporaryPath) {
      try { fs.rmSync(temporaryPath, { force: true }); } catch { /* best effort */ }
    }
  }
}

module.exports = { readProcessScope, resolveProcessSessionId };