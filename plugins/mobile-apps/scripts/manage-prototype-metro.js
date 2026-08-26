#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const SCHEMA_VERSION = 1;

function sessionPath(projectRoot) {
  return path.join(path.resolve(projectRoot), '.mobile-app', 'metro-session.json');
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function readSession(projectRoot) {
  const filePath = sessionPath(projectRoot);
  if (!fs.existsSync(filePath)) return null;
  try {
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return value?.schemaVersion === SCHEMA_VERSION ? value : null;
  } catch {
    return null;
  }
}

function writeSession(projectRoot, value) {
  const filePath = sessionPath(projectRoot);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
    fs.renameSync(temporaryPath, filePath);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
  return filePath;
}

function canSuggestReuse(session, projectRoot) {
  return session?.status === 'ready'
    && session.projectRoot === path.resolve(projectRoot)
    && Number.isInteger(session.port)
    && session.port > 0
    && session.port <= 65535
    && typeof session.command === 'string'
    && Boolean(session.terminalId || session.pid);
}

function availablePort(port, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', (error) => {
      if (error.code === 'EADDRINUSE' || error.code === 'EACCES') resolve(false);
      else reject(error);
    });
    server.listen(port, host, () => server.close(() => resolve(true)));
  });
}

async function findAvailablePort(startPort = 8081, attempts = 100) {
  for (let offset = 0; offset < attempts; offset += 1) {
    const port = startPort + offset;
    if (port > 65535) break;
    if (await availablePort(port)) return port;
  }
  throw new Error(`No available Metro port found from ${startPort} after ${attempts} attempts.`);
}

async function prepareSession(projectRoot, options = {}) {
  const root = path.resolve(projectRoot);
  const previous = readSession(root);
  if (!options.ignoreExisting && canSuggestReuse(previous, root)) {
    return {
      action: 'verify-reuse',
      reason: 'Foreground must confirm the recorded terminal still shows a healthy Metro banner.',
      session: previous,
      sessionPath: sessionPath(root),
    };
  }
  const port = await findAvailablePort(options.startPort || 8081);
  const command = `npx expo start --port ${port}`;
  return {
    action: 'start',
    port,
    command,
    manualCommand: `cd ${shellQuote(root)} && ${command}`,
    sessionPath: sessionPath(root),
  };
}

function recordReady(projectRoot, options) {
  const root = path.resolve(projectRoot);
  const port = Number(options.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Ready Metro session requires a valid port.');
  if (!options.terminalId && !options.pid) throw new Error('Ready Metro session requires a terminal ID or process ID.');
  const command = options.command || `npx expo start --port ${port}`;
  const value = {
    schemaVersion: SCHEMA_VERSION,
    status: 'ready',
    projectRoot: root,
    port,
    command,
    manualCommand: `cd ${shellQuote(root)} && ${command}`,
    terminalId: options.terminalId || null,
    pid: options.pid ? Number(options.pid) : null,
    url: options.url || null,
    readyAt: options.now || new Date().toISOString(),
    healthEvidence: 'foreground-terminal-banner',
  };
  writeSession(root, value);
  return value;
}

function recordFailure(projectRoot, options) {
  const root = path.resolve(projectRoot);
  const port = Number(options.port);
  const command = options.command || (Number.isInteger(port) ? `npx expo start --port ${port}` : 'npx expo start');
  const value = {
    schemaVersion: SCHEMA_VERSION,
    status: 'failed',
    projectRoot: root,
    port: Number.isInteger(port) ? port : null,
    command,
    manualCommand: `cd ${shellQuote(root)} && ${command}`,
    reason: options.reason || 'Metro did not report a ready banner.',
    failedAt: options.now || new Date().toISOString(),
  };
  writeSession(root, value);
  return value;
}

function parseArgs(argv) {
  const args = { action: 'prepare' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--project-root') args.projectRoot = argv[++index];
    else if (arg === '--action') args.action = argv[++index];
    else if (arg === '--start-port') args.startPort = Number(argv[++index]);
    else if (arg === '--port') args.port = Number(argv[++index]);
    else if (arg === '--terminal-id') args.terminalId = argv[++index];
    else if (arg === '--pid') args.pid = Number(argv[++index]);
    else if (arg === '--url') args.url = argv[++index];
    else if (arg === '--command') args.command = argv[++index];
    else if (arg === '--reason') args.reason = argv[++index];
    else if (arg === '--ignore-existing') args.ignoreExisting = true;
  }
  return args;
}

async function main(argv) {
  const args = parseArgs(argv);
  if (!args.projectRoot || !['prepare', 'ready', 'failed'].includes(args.action)) {
    process.stderr.write('Usage: node manage-prototype-metro.js --project-root <dir> [--action prepare|ready|failed] [--ignore-existing] [--start-port <port>] [--port <port>] [--terminal-id <id>] [--pid <pid>] [--url <url>] [--command <command>] [--reason <text>]\n');
    return 2;
  }
  try {
    const result = args.action === 'prepare'
      ? await prepareSession(args.projectRoot, args)
      : args.action === 'ready'
        ? recordReady(args.projectRoot, args)
        : recordFailure(args.projectRoot, args);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`manage-prototype-metro: ${error.message}\n`);
    return 2;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then((exitCode) => { process.exitCode = exitCode; });
}

module.exports = {
  canSuggestReuse,
  findAvailablePort,
  prepareSession,
  readSession,
  recordFailure,
  recordReady,
  sessionPath,
  shellQuote,
  writeSession,
};