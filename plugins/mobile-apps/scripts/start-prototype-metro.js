#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');

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

async function startPrototypeMetro(projectRoot, options = {}) {
  const root = fs.realpathSync(path.resolve(projectRoot));
  const port = await selectMetroPort(options.preferredPort || 8081, options.maximumPort || (options.preferredPort || 8081) + 20);
  const command = ['npm', '--prefix', root, 'run', 'dev', '--', '--port', String(port), '--non-interactive'];
  if (options.planOnly) return { port, command, cwd: root, status: 'planned' };
  const child = spawn(command[0], command.slice(1), {
    cwd: root,
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, CI: '1', EXPO_NO_INTERACTIVE: '1' },
  });
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  child.unref();
  return { port, command, cwd: root, pid: child.pid, status: 'started' };
}

async function main(argv) {
  const args = { preferredPort: 8081 };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--project-root') args.projectRoot = argv[++index];
    else if (argv[index] === '--preferred-port') args.preferredPort = Number(argv[++index]);
    else if (argv[index] === '--plan-only') args.planOnly = true;
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

module.exports = { patchTextPreservingEol, portAvailable, selectMetroPort, startPrototypeMetro };