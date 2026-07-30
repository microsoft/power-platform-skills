#!/usr/bin/env node
'use strict';

const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

function parseArgs(argv = process.argv.slice(2)) {
  const args = { host: '127.0.0.1' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root') args.root = argv[++i];
    else if (argv[i] === '--urlFile') args.urlFile = argv[++i];
    else if (argv[i] === '--host') args.host = argv[++i];
    else if (argv[i] === '--port') args.port = Number(argv[++i]);
    else if (argv[i] === '--child') args.child = true;
  }
  return args;
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.html') return 'text/html; charset=utf-8';
  if (ext === '.json') return 'application/json; charset=utf-8';
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.svg') return 'image/svg+xml';
  return 'application/octet-stream';
}

function safeResolve(root, urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent((urlPath || '/').split('?')[0]);
  } catch {
    return null;
  }
  const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  if (path.isAbsolute(relative) || relative.split(/[\\/]+/).includes('..')) return null;
  const fullPath = path.resolve(root, relative);
  const rootPath = path.resolve(root);
  return fullPath === rootPath || fullPath.startsWith(rootPath + path.sep) ? fullPath : null;
}

function startServer({ root, host, port, urlFile }) {
  const server = http.createServer((req, res) => {
    const filePath = safeResolve(root, req.url);
    if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': contentType(filePath),
      'Cache-Control': 'no-store',
    });
    fs.createReadStream(filePath).pipe(res);
  });
  server.listen(port, host, () => {
    const address = server.address();
    const url = `http://${host}:${address.port}/`;
    if (urlFile) fs.writeFileSync(urlFile, url, 'utf8');
  });
}

async function pickPort(host) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, host, () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function main(argv = process.argv.slice(2), deps = {}) {
  const args = parseArgs(argv);
  if (!args.root) return { ok: false, error: 'Usage: serve-static-dir.js --root <dir> [--urlFile <path>]' };
  if (args.child) {
    startServer(args);
    return null;
  }
  const port = args.port || await pickPort(args.host);
  const child = (deps.spawn || spawn)(process.execPath, [__filename, '--child', '--root', args.root, '--host', args.host, '--port', String(port), ...(args.urlFile ? ['--urlFile', args.urlFile] : [])], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  const url = `http://${args.host}:${port}/`;
  if (args.urlFile) fs.writeFileSync(args.urlFile, url, 'utf8');
  return { ok: true, url, pid: child.pid };
}

if (require.main === module) {
  main().then((result) => {
    if (result) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }).catch((err) => {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  });
}

module.exports = { parseArgs, safeResolve, contentType, main };
