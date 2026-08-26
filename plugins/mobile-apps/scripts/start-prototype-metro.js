#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { validateRouteManifest } = require('./route-manifest');

const METRO_EVIDENCE_PATH = '.tmp/prototype-metro-evidence.json';

function patchTextPreservingEol(source, search, replacement) {
  if (!source.includes(search)) throw new Error(`patch anchor is missing: ${search}`);
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  return source.replace(search, String(replacement).replace(/\r?\n/g, eol));
}

function portAvailable(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.listen({ port, host }, () => server.close(() => resolve(true)));
  });
}

async function selectMetroPort(preferred = 8081, maximum = preferred + 20) {
  for (let port = preferred; port <= maximum; port += 1) if (await portAvailable(port)) return port;
  throw new Error(`no available Metro port between ${preferred} and ${maximum}`);
}

function probeMetroStatus(port, host = '127.0.0.1', request = http.get) {
  return new Promise((resolve) => {
    const client = request({ host, port, path: '/status', timeout: 750 }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve(response.statusCode === 200 && /packager-status:running|metro/i.test(body)));
    });
    client.once('timeout', () => { client.destroy(); resolve(false); });
    client.once('error', () => resolve(false));
  });
}

async function waitForMetroReady(port, options = {}) {
  const startedAt = Date.now();
  const timeoutMs = options.timeoutMs || 30000;
  const intervalMs = options.intervalMs || 250;
  while (Date.now() - startedAt < timeoutMs) {
    if (await probeMetroStatus(port, options.host, options.request)) return { ready: true, durationMs: Date.now() - startedAt };
    if (options.child && options.child.exitCode !== null) return { ready: false, durationMs: Date.now() - startedAt, reason: `process exited ${options.child.exitCode}` };
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return { ready: false, durationMs: Date.now() - startedAt, reason: `health probe timed out after ${timeoutMs}ms` };
}

function writeAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
    fs.renameSync(temporary, filePath);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function validateCompleteAppReadiness(projectRoot, options = {}) {
  const root = fs.realpathSync(path.resolve(projectRoot));
  const pack = JSON.parse(fs.readFileSync(path.resolve(root, options.packPath || '.tmp/screen-build-pack.json'), 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(path.resolve(root, options.routeManifestPath || '.tmp/route-manifest.json'), 'utf8'));
  const errors = validateRouteManifest(manifest, pack);
  if (errors.length) throw new Error(`route manifest is invalid: ${errors.join('; ')}`);
  const screenIds = (pack.screens || []).map((screen) => screen.id);
  if (!screenIds.length) throw new Error('screen build pack has no screens');
  for (const screenId of screenIds) {
    const screen = (pack.screens || []).find((candidate) => candidate.id === screenId);
    const route = manifest.routes.find((candidate) => candidate.id === screenId);
    if (!screen || !route) throw new Error(`complete app screen is missing: ${screenId}`);
    if (!['type-safe', 'available-in-metro', 'reviewed'].includes(route.buildStatus)) throw new Error(`complete app screen ${screenId} is not type-safe`);
    const sourcePath = path.resolve(root, screen.file);
    if (!sourcePath.startsWith(`${root}${path.sep}`) || !fs.existsSync(sourcePath)) throw new Error(`native canary source is missing: ${screen.file}`);
    const source = fs.readFileSync(sourcePath, 'utf8');
    const emptyDefaultScreen = /export\s+default\s+function\s+[A-Za-z_$][\w$]*\s*\([^)]*\)\s*\{\s*return\s+null\s*;\s*\}/s.test(source);
    if (/TODO:\s*screen-builder fills JSX here/.test(source) || emptyDefaultScreen) throw new Error(`complete app screen ${screenId} is still a skeleton`);
  }
  return { packRevision: pack.revision, screenIds };
}

async function startPrototypeMetro(projectRoot, options = {}) {
  const root = fs.realpathSync(path.resolve(projectRoot));
  const completeApp = options.requireCompleteApp ? validateCompleteAppReadiness(root, options) : null;
  const port = await selectMetroPort(options.preferredPort || 8081, options.maximumPort || (options.preferredPort || 8081) + 20);
  const command = ['npm', '--prefix', root, 'run', 'dev', '--', '--port', String(port), '--non-interactive'];
  if (options.planOnly) return { port, command, cwd: root, status: 'planned', completeApp };
  const logPath = path.join(root, '.tmp', 'prototype-metro.log');
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const log = fs.openSync(logPath, 'a');
  const child = (options.spawnProcess || spawn)(command[0], command.slice(1), {
    cwd: root,
    detached: true,
    stdio: ['ignore', log, log],
    env: { ...process.env, CI: '1', EXPO_NO_INTERACTIVE: '1' },
  });
  try {
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
  } finally {
    fs.closeSync(log);
  }
  const readiness = await waitForMetroReady(port, { ...options, child });
  if (!readiness.ready) {
    child.kill('SIGTERM');
    throw new Error(`Metro did not become ready: ${readiness.reason}. Manual command: ${command.join(' ')}`);
  }
  child.unref();
  const result = {
    schemaVersion: 1,
    kind: 'prototype-metro-evidence',
    port,
    url: `http://127.0.0.1:${port}`,
    command,
    cwd: root,
    pid: child.pid,
    status: 'metro-ready',
    previewStatus: 'Metro ready',
    readyAt: new Date().toISOString(),
    startupDurationMs: readiness.durationMs,
    completeApp,
    logPath: path.relative(root, logPath).replace(/\\/g, '/'),
  };
  writeAtomic(path.join(root, METRO_EVIDENCE_PATH), result);
  return result;
}

async function main(argv) {
  const args = { preferredPort: 8081 };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--project-root') args.projectRoot = argv[++index];
    else if (argv[index] === '--preferred-port') args.preferredPort = Number(argv[++index]);
    else if (argv[index] === '--plan-only') args.planOnly = true;
    else if (argv[index] === '--require-complete-app') args.requireCompleteApp = true;
    else if (argv[index] === '--patch-file') args.patchFile = argv[++index];
    else if (argv[index] === '--search') args.search = argv[++index];
    else if (argv[index] === '--replacement') args.replacement = argv[++index];
  }
  if (!args.projectRoot) {
    process.stderr.write('Usage: node start-prototype-metro.js --project-root <dir> [--preferred-port 8081] [--plan-only]\n');
    return 2;
  }
  try {
    const root = fs.realpathSync(path.resolve(args.projectRoot));
    if (args.patchFile) {
      if (typeof args.search !== 'string' || typeof args.replacement !== 'string') throw new Error('--patch-file requires --search and --replacement');
      const filePath = path.resolve(root, args.patchFile);
      if (!filePath.startsWith(`${root}${path.sep}`)) throw new Error('patch file must remain inside the project root');
      const fileStat = fs.lstatSync(filePath);
      const realParent = fs.realpathSync(path.dirname(filePath));
      if (fileStat.isSymbolicLink() || !fileStat.isFile() || (realParent !== root && !realParent.startsWith(`${root}${path.sep}`))) throw new Error('patch file must be a regular project-owned path');
      const source = fs.readFileSync(filePath, 'utf8');
      fs.writeFileSync(filePath, patchTextPreservingEol(source, args.search, args.replacement));
    }
    const result = await startPrototypeMetro(root, args);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`start-prototype-metro: ${error.message}\n`);
    return 2;
  }
}

if (require.main === module) main(process.argv.slice(2)).then((code) => { process.exitCode = code; });

module.exports = { METRO_EVIDENCE_PATH, patchTextPreservingEol, portAvailable, probeMetroStatus, selectMetroPort, startPrototypeMetro, validateCompleteAppReadiness, waitForMetroReady };