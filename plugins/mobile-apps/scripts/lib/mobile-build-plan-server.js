'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const {
  ARTIFACTS,
  BUILD_PLAN_OUTPUT,
  EDIT_JOURNAL_ARTIFACT,
  deriveBuildPlanModel,
  renderBuildPlanHtml,
  resolveInsideProject,
  writeBuildPlan,
} = require('./mobile-build-plan');
const { applyDataModelEdit } = require('./mobile-build-plan-edits');

const HOST = '127.0.0.1';
const SERVER_ARTIFACT = '.tmp/mobile-build-plan-server.json';
const MAX_BODY_BYTES = 128 * 1024;
const DEFAULT_POLL_INTERVAL_MS = 750;
const WATCHED_ARTIFACTS = [
  ...Object.values(ARTIFACTS),
  EDIT_JOURNAL_ARTIFACT,
  'native-app-plan.md',
  'brand/design-system.md',
  'brand/tokens.ts',
  '_plan_preview.html',
];

const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
};

function safeTokenEqual(expected, supplied) {
  const expectedBytes = Buffer.from(String(expected || ''));
  const suppliedBytes = Buffer.from(String(supplied || ''));
  return expectedBytes.length === suppliedBytes.length
    && crypto.timingSafeEqual(expectedBytes, suppliedBytes);
}

function send(response, statusCode, body, contentType = 'application/json; charset=utf-8') {
  response.writeHead(statusCode, {
    ...SECURITY_HEADERS,
    'Content-Type': contentType,
  });
  response.end(body);
}

function sendJson(response, statusCode, value) {
  send(response, statusCode, `${JSON.stringify(value)}\n`);
}

function artifactSignature(projectRoot) {
  return WATCHED_ARTIFACTS.map((relativePath) => {
    const file = resolveInsideProject(projectRoot, relativePath);
    if (!fs.existsSync(file)) return `${relativePath}:missing`;
    const stat = fs.lstatSync(file);
    return `${relativePath}:${stat.isSymbolicLink() ? 'link' : stat.size}:${stat.mtimeMs}`;
  }).join('|');
}

function atomicWriteServerArtifact(projectRoot, value) {
  const file = resolveInsideProject(projectRoot, SERVER_ARTIFACT);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    fs.renameSync(temporary, file);
    fs.chmodSync(file, 0o600);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      if (!tooLarge) chunks.push(chunk);
    });
    request.on('end', () => {
      if (tooLarge) {
        const error = new Error('Request body exceeds 128 KiB');
        error.code = 'body-too-large';
        reject(error);
        return;
      }
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(parsed);
      } catch {
        reject(new Error('Request body must be valid JSON'));
      }
    });
    request.on('error', reject);
  });
}

function statusForError(error) {
  if (error.code === 'revision-conflict') return 409;
  if (error.code === 'body-too-large') return 413;
  if (/execution has started/.test(error.message)) return 423;
  return 422;
}

async function startBuildPlanServer(options) {
  const projectRoot = path.resolve(options.projectRoot);
  const token = options.token || crypto.randomBytes(32).toString('hex');
  const requestedPort = Number(options.port || 0);
  const pollIntervalMs = Number(options.pollIntervalMs || DEFAULT_POLL_INTERVAL_MS);
  if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) {
    throw new Error('Build Plan port must be an integer from 0 to 65535');
  }
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 25) {
    throw new Error('Build Plan poll interval must be at least 25ms');
  }
  if (!fs.existsSync(projectRoot) || !fs.statSync(projectRoot).isDirectory()) {
    throw new Error(`Project root is not a directory: ${projectRoot}`);
  }

  const clients = new Set();
  let origin;
  let expectedHost;
  let lastSignature;
  let pollTimer;
  let keepAliveTimer;
  let closed = false;

  function authorized(url, request) {
    return safeTokenEqual(token, url.searchParams.get('token'))
      || safeTokenEqual(token, request.headers['x-build-plan-token']);
  }

  function validHost(request) {
    return request.headers.host === expectedHost;
  }

  function broadcast(event, value) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(value)}\n\n`;
    for (const client of clients) client.write(payload);
  }

  const server = http.createServer(async (request, response) => {
    let url;
    try {
      url = new URL(request.url, origin);
    } catch {
      sendJson(response, 400, { ok: false, error: 'Malformed request URL' });
      return;
    }
    if (!validHost(request) || !authorized(url, request)) {
      sendJson(response, 403, { ok: false, error: 'Build Plan authorization failed' });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/') {
      const model = deriveBuildPlanModel(projectRoot);
      send(
        response,
        200,
        renderBuildPlanHtml(model, { token }),
        'text/html; charset=utf-8',
      );
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/model') {
      sendJson(response, 200, { ok: true, model: deriveBuildPlanModel(projectRoot) });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/events') {
      response.writeHead(200, {
        ...SECURITY_HEADERS,
        'Content-Type': 'text/event-stream; charset=utf-8',
        Connection: 'keep-alive',
      });
      response.write(`event: ready\ndata: ${JSON.stringify({
        revision: deriveBuildPlanModel(projectRoot).revision,
      })}\n\n`);
      clients.add(response);
      request.on('close', () => clients.delete(response));
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/data-model') {
      if (request.headers.origin !== origin) {
        sendJson(response, 403, { ok: false, error: 'Build Plan origin check failed' });
        return;
      }
      if (!String(request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
        sendJson(response, 415, { ok: false, error: 'Content-Type must be application/json' });
        return;
      }
      try {
        const command = await readJsonBody(request);
        const result = applyDataModelEdit(projectRoot, command);
        lastSignature = artifactSignature(projectRoot);
        const model = deriveBuildPlanModel(projectRoot);
        broadcast('refresh', { revision: model.revision, reason: 'data-model-edit' });
        sendJson(response, 200, { ...result, modelRevision: model.revision });
      } catch (error) {
        sendJson(response, statusForError(error), {
          ok: false,
          error: error.message,
          ...(error.currentRevision ? { currentRevision: error.currentRevision } : {}),
        });
      }
      return;
    }
    sendJson(response, 404, { ok: false, error: 'Build Plan route not found' });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(requestedPort, HOST, resolve);
  });
  const address = server.address();
  expectedHost = `${HOST}:${address.port}`;
  origin = `http://${expectedHost}`;
  const launchUrl = `${origin}/?token=${encodeURIComponent(token)}`;
  const startedAt = new Date().toISOString();

  writeBuildPlan(projectRoot);
  atomicWriteServerArtifact(projectRoot, {
    schemaVersion: 1,
    pid: process.pid,
    startedAt,
    origin,
    launchUrl,
    tokenSha256: crypto.createHash('sha256').update(token).digest('hex'),
  });
  lastSignature = artifactSignature(projectRoot);
  pollTimer = setInterval(() => {
    try {
      const signature = artifactSignature(projectRoot);
      if (signature === lastSignature) return;
      lastSignature = signature;
      const snapshot = writeBuildPlan(projectRoot);
      broadcast('refresh', { revision: snapshot.model.revision, reason: 'artifact-change' });
    } catch (error) {
      broadcast('warning', { error: `Build Plan refresh failed: ${error.message}` });
    }
  }, pollIntervalMs);
  keepAliveTimer = setInterval(() => {
    for (const client of clients) client.write(': keepalive\n\n');
  }, 15000);

  async function close() {
    if (closed) return;
    closed = true;
    clearInterval(pollTimer);
    clearInterval(keepAliveTimer);
    for (const client of clients) client.end();
    clients.clear();
    writeBuildPlan(projectRoot);
    const stateFile = resolveInsideProject(projectRoot, SERVER_ARTIFACT);
    if (fs.existsSync(stateFile)) {
      try {
        const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        if (state.pid === process.pid && state.tokenSha256
          === crypto.createHash('sha256').update(token).digest('hex')) {
          fs.rmSync(stateFile, { force: true });
        }
      } catch {
        // Leave an unfamiliar state file intact; another process may own it.
      }
    }
    await new Promise((resolve, reject) => server.close((error) => (
      error ? reject(error) : resolve()
    )));
  }

  return {
    broadcast,
    close,
    host: HOST,
    launchUrl,
    origin,
    port: address.port,
    server,
    startedAt,
    token,
  };
}

module.exports = {
  HOST,
  MAX_BODY_BYTES,
  SECURITY_HEADERS,
  SERVER_ARTIFACT,
  safeTokenEqual,
  startBuildPlanServer,
};