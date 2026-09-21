#!/usr/bin/env node
'use strict';

const fs = require('fs');
const crypto = require('crypto');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { fork } = require('child_process');

const DEFAULT_READY_TIMEOUT_MS = 5000;
const DEFAULT_IDLE_TIMEOUT_MS = 120000;
const DEFAULT_MAX_LIFETIME_MS = 3600000;
const DEFAULT_SUCCESS_GRACE_MS = 30000;
const DEFAULT_STATUS_POLL_MS = 500;

function parseArgs(argv = process.argv.slice(2)) {
  const args = { host: '127.0.0.1' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root') args.root = argv[++i];
    else if (argv[i] === '--urlFile') args.urlFile = argv[++i];
    else if (argv[i] === '--host') args.host = argv[++i];
    else if (argv[i] === '--port') args.port = Number(argv[++i]);
    else if (argv[i] === '--statusPath') args.statusPath = argv[++i];
    else if (argv[i] === '--readyTimeoutMs') args.readyTimeoutMs = Number(argv[++i]);
    else if (argv[i] === '--idleTimeoutMs') args.idleTimeoutMs = Number(argv[++i]);
    else if (argv[i] === '--maxLifetimeMs') args.maxLifetimeMs = Number(argv[++i]);
    else if (argv[i] === '--successGraceMs') args.successGraceMs = Number(argv[++i]);
    else if (argv[i] === '--statusPollMs') args.statusPollMs = Number(argv[++i]);
    else if (argv[i] === '--cleanupMarker') args.cleanupMarker = argv[++i];
    else if (argv[i] === '--cleanupToken') args.cleanupToken = argv[++i];
    else if (argv[i] === '--cleanupRoot') args.cleanupRoot = true;
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

function isServableFile(filePath, options = {}) {
  const fsImpl = options.fs || fs;
  const root = path.resolve(options.root || path.dirname(filePath));
  try {
    if (!fsImpl.existsSync(root) || !fsImpl.existsSync(filePath)) return false;
    const rootStat = fsImpl.lstatSync(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return false;
    const resolvedFile = path.resolve(filePath);
    if (resolvedFile === root || !resolvedFile.startsWith(root + path.sep)) return false;
    let current = root;
    for (const segment of path.relative(root, resolvedFile).split(path.sep)) {
      current = path.join(current, segment);
      if (fsImpl.lstatSync(current).isSymbolicLink()) return false;
    }
    const realRoot = fsImpl.realpathSync(root);
    const realFile = fsImpl.realpathSync(resolvedFile);
    if (realFile === realRoot || !realFile.startsWith(realRoot + path.sep)) return false;
    return fsImpl.lstatSync(resolvedFile).isFile();
  } catch {
    return false;
  }
}

function streamFile(filePath, res, deps = {}) {
  const fsImpl = deps.fs || fs;
  let stream;
  try {
    stream = fsImpl.createReadStream(filePath);
  } catch {
    if (!res.headersSent) res.writeHead(404);
    res.end('Not found');
    return;
  }
  stream.on('error', () => {
    if (!res.headersSent) res.writeHead(404);
    res.end();
  });
  stream.pipe(res);
}

function serverUrl(host, port) {
  // RFC 3986 requires IPv6 literals to be enclosed in brackets when used as
  // the host component of a URL. The unbracketed value remains correct for
  // server.listen(). See: https://www.rfc-editor.org/rfc/rfc3986#section-3.2.2
  const urlHost = net.isIP(host) === 6 ? `[${host}]` : host;
  return `http://${urlHost}:${port}/`;
}

function requestsServerShutdown(status) {
  return Boolean(status && status.state === 'succeeded' && status.shutdownServer === true);
}

function pathContains(parentPath, childPath) {
  const parent = path.resolve(parentPath);
  const child = path.resolve(childPath);
  return child === parent || child.startsWith(parent + path.sep);
}

function createCleanupOwnership(root, deps = {}) {
  const fsImpl = deps.fs || fs;
  const osImpl = deps.os || os;
  const randomBytes = deps.randomBytes || crypto.randomBytes;
  const resolvedRoot = path.resolve(root);
  const rootStat = fsImpl.lstatSync(resolvedRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error('Cleanup root must be a regular directory');
  }
  const canonicalRoot = fsImpl.realpathSync(resolvedRoot);
  const canonicalTemp = fsImpl.realpathSync(osImpl.tmpdir());
  if (canonicalRoot === canonicalTemp || !pathContains(canonicalTemp, canonicalRoot)) {
    throw new Error('Cleanup root must be a child of the operating-system temporary directory');
  }
  const token = randomBytes(16).toString('hex');
  const markerPath = path.join(
    path.dirname(canonicalRoot),
    `.power-pages-status-${path.basename(canonicalRoot)}-${process.pid}-${token}.json`
  );
  fsImpl.writeFileSync(
    markerPath,
    JSON.stringify({ root: canonicalRoot, token }),
    { encoding: 'utf8', flag: 'wx', mode: 0o600 }
  );
  return { root: canonicalRoot, markerPath, token };
}

function cleanupOwnedRoot({ root, cleanupMarker, cleanupToken }, deps = {}) {
  if (!cleanupMarker || !cleanupToken) return false;
  const fsImpl = deps.fs || fs;
  try {
    const markerStat = fsImpl.lstatSync(cleanupMarker);
    if (markerStat.isSymbolicLink() || !markerStat.isFile()) return false;
    const ownership = JSON.parse(fsImpl.readFileSync(cleanupMarker, 'utf8'));
    const canonicalRoot = path.resolve(root);
    if (ownership.root !== canonicalRoot || ownership.token !== cleanupToken) return false;
    if (fsImpl.existsSync(canonicalRoot)) {
      const rootStat = fsImpl.lstatSync(canonicalRoot);
      if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return false;
      if (fsImpl.realpathSync(canonicalRoot) !== canonicalRoot) return false;
      fsImpl.rmSync(canonicalRoot, { recursive: true, force: true });
    }
    fsImpl.rmSync(cleanupMarker, { force: true });
    return true;
  } catch {
    return false;
  }
}

function startServer(options, deps = {}) {
  const fsImpl = deps.fs || fs;
  const httpImpl = deps.http || http;
  const requestedRoot = path.resolve(options.root);
  const host = options.host || '127.0.0.1';
  const port = Number.isInteger(options.port) ? options.port : 0;
  const idleTimeoutMs = options.idleTimeoutMs || DEFAULT_IDLE_TIMEOUT_MS;
  const maxLifetimeMs = options.maxLifetimeMs || DEFAULT_MAX_LIFETIME_MS;
  const successGraceMs = options.successGraceMs || DEFAULT_SUCCESS_GRACE_MS;
  const statusPollMs = options.statusPollMs || DEFAULT_STATUS_POLL_MS;
  const rootStat = fsImpl.lstatSync(requestedRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    return Promise.reject(new Error('Static server root must be a regular directory'));
  }
  const root = fsImpl.realpathSync(requestedRoot);
  const requestedStatusPath = path.resolve(options.statusPath || path.join(root, 'status.json'));
  const statusPath = fsImpl.existsSync(requestedStatusPath)
    ? fsImpl.realpathSync(requestedStatusPath)
    : requestedStatusPath;
  if (!pathContains(root, statusPath)) {
    return Promise.reject(new Error('Status path must stay inside the static server root'));
  }

  let resetIdleTimer = () => {};
  const server = httpImpl.createServer((req, res) => {
    resetIdleTimer();
    const filePath = safeResolve(root, req.url);
    if (!filePath || !isServableFile(filePath, { root, fs: fsImpl })) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': contentType(filePath),
      'Cache-Control': 'no-store',
    });
    streamFile(filePath, res, { fs: fsImpl });
  });

  let closing = false;
  let idleTimer = null;
  let lifetimeTimer = null;
  let successTimer = null;
  let resolveClosed;
  const closed = new Promise((resolve) => {
    resolveClosed = resolve;
  });

  const clearLifecycle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    if (lifetimeTimer) clearTimeout(lifetimeTimer);
    if (successTimer) clearTimeout(successTimer);
    fsImpl.unwatchFile(statusPath);
  };
  const finalize = () => {
    clearLifecycle();
    cleanupOwnedRoot({
      root,
      cleanupMarker: options.cleanupMarker,
      cleanupToken: options.cleanupToken,
    }, { fs: fsImpl });
    resolveClosed();
  };
  const shutdown = () => {
    if (closing) return;
    closing = true;
    clearLifecycle();
    server.close(finalize);
  };
  resetIdleTimer = () => {
    if (!idleTimeoutMs || closing) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(shutdown, idleTimeoutMs);
  };

  return new Promise((resolve, reject) => {
    const onStartupError = (err) => {
      clearLifecycle();
      reject(err);
    };
    server.once('error', onStartupError);
    server.listen(port, host, () => {
      server.off('error', onStartupError);
      server.on('error', shutdown);
      const address = server.address();
      const url = serverUrl(host, address.port);
      resetIdleTimer();
      lifetimeTimer = setTimeout(shutdown, maxLifetimeMs);
      const inspectStatus = () => {
        if (closing || successTimer) return;
        try {
          const status = JSON.parse(fsImpl.readFileSync(statusPath, 'utf8'));
          if (requestsServerShutdown(status)) {
            successTimer = setTimeout(shutdown, successGraceMs);
          }
        } catch {
          // The status writer replaces this file during updates. A short-lived
          // missing or incomplete document is retried on the next watch poll.
        }
      };
      fsImpl.watchFile(statusPath, { interval: statusPollMs, persistent: false }, inspectStatus);
      inspectStatus();
      resolve({ server, url, shutdown, closed });
    });
  });
}

function waitForChildReady(child, timeoutMs = DEFAULT_READY_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Static server did not become ready within ${timeoutMs}ms`));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      child.removeListener('message', onMessage);
      child.removeListener('error', onError);
      child.removeListener('exit', onExit);
    };
    const onMessage = (message) => {
      if (!message || (message.type !== 'ready' && message.type !== 'error')) return;
      cleanup();
      if (message.type === 'error') {
        reject(new Error(message.error || 'Static server child failed during startup'));
      } else {
        resolve(message);
      }
    };
    const onError = (err) => {
      cleanup();
      reject(err);
    };
    const onExit = (code, signal) => {
      cleanup();
      reject(new Error(`Static server child exited before readiness (${signal || code})`));
    };
    child.on('message', onMessage);
    child.once('error', onError);
    child.once('exit', onExit);
  });
}

async function main(argv = process.argv.slice(2), deps = {}) {
  const args = parseArgs(argv);
  if (!args.root) return { ok: false, error: 'Usage: serve-static-dir.js --root <dir> [--urlFile <path>]' };
  if (args.child) {
    const started = await startServer(args, deps);
    const proc = deps.process || process;
    const stop = () => started.shutdown();
    proc.once('SIGTERM', stop);
    proc.once('SIGINT', stop);
    started.closed.finally(() => {
      proc.removeListener('SIGTERM', stop);
      proc.removeListener('SIGINT', stop);
    });
    if (typeof proc.send === 'function') {
      await new Promise((resolve) => {
        proc.send({ type: 'ready', url: started.url }, () => {
          if (typeof proc.disconnect === 'function') proc.disconnect();
          resolve();
        });
      });
    }
    return null;
  }

  let ownership = null;
  if (args.cleanupRoot) {
    ownership = createCleanupOwnership(args.root, deps);
  }
  const servedRoot = ownership ? ownership.root : path.resolve(args.root);
  const childArgs = [
    '--child',
    '--root', servedRoot,
    '--host', args.host,
    '--port', String(args.port || 0),
    '--statusPath', args.statusPath ? path.resolve(args.statusPath) : path.join(servedRoot, 'status.json'),
    '--idleTimeoutMs', String(args.idleTimeoutMs || DEFAULT_IDLE_TIMEOUT_MS),
    '--maxLifetimeMs', String(args.maxLifetimeMs || DEFAULT_MAX_LIFETIME_MS),
    '--successGraceMs', String(args.successGraceMs || DEFAULT_SUCCESS_GRACE_MS),
    '--statusPollMs', String(args.statusPollMs || DEFAULT_STATUS_POLL_MS),
  ];
  if (ownership) {
    childArgs.push('--cleanupMarker', ownership.markerPath, '--cleanupToken', ownership.token);
  }
  const child = (deps.fork || fork)(__filename, childArgs, {
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  try {
    const ready = await waitForChildReady(child, args.readyTimeoutMs || DEFAULT_READY_TIMEOUT_MS);
    if (args.urlFile) {
      const urlFile = path.resolve(args.urlFile);
      if (!pathContains(path.resolve(args.root), urlFile)) {
        throw new Error('urlFile must stay inside the static server root');
      }
      fs.writeFileSync(urlFile, ready.url, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    }
    child.unref();
    return { ok: true, url: ready.url, pid: child.pid };
  } catch (err) {
    if (typeof child.kill === 'function') child.kill();
    if (ownership) {
      cleanupOwnedRoot({
        root: ownership.root,
        cleanupMarker: ownership.markerPath,
        cleanupToken: ownership.token,
      }, deps);
    }
    throw err;
  }
}

if (require.main === module) {
  main().then((result) => {
    if (result) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }).catch((err) => {
    if (typeof process.send === 'function') {
      process.send({ type: 'error', error: err.message }, () => {
        if (typeof process.disconnect === 'function') process.disconnect();
        process.exitCode = 1;
      });
      return;
    }
    process.stderr.write(`${err.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  cleanupOwnedRoot,
  contentType,
  createCleanupOwnership,
  isServableFile,
  main,
  parseArgs,
  requestsServerShutdown,
  safeResolve,
  serverUrl,
  startServer,
  streamFile,
  waitForChildReady,
};
