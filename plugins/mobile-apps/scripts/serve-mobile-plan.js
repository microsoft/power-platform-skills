#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i].startsWith('--') && argv[i + 1]) args[argv[i].slice(2)] = argv[++i];
  }
  return args;
}

function validateRevision(value) {
  if (!value || value.kind !== 'mobile-er-revision') {
    throw new Error('Expected kind mobile-er-revision.');
  }
  if (!Array.isArray(value.entities) || value.entities.length === 0) {
    throw new Error('At least one entity is required.');
  }
  const entityNames = new Set();
  for (const entity of value.entities) {
    const name = String(entity && entity.name || '').trim();
    if (!name) throw new Error('Every entity requires a name.');
    if (entityNames.has(name)) throw new Error(`Duplicate entity name: ${name}`);
    entityNames.add(name);
    if (!Array.isArray(entity.fields) || entity.fields.length === 0) {
      throw new Error(`Entity ${name} requires at least one field.`);
    }
    const fieldNames = new Set();
    for (const field of entity.fields) {
      const fieldName = String(field && field.name || '').trim();
      if (!fieldName) throw new Error(`Entity ${name} contains an unnamed field.`);
      if (fieldNames.has(fieldName)) {
        throw new Error(`Entity ${name} contains duplicate field ${fieldName}.`);
      }
      fieldNames.add(fieldName);
    }
  }
  return value;
}

function fileHash(file) {
  if (!fs.existsSync(file)) return null;
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, file);
}

function createCompanion(options) {
  const projectRoot = path.resolve(options.projectRoot);
  const host = options.host || '127.0.0.1';
  const token = options.token || crypto.randomBytes(24).toString('hex');
  const planFile = path.join(projectRoot, 'mobile-app-plan.html');
  const statusFile = path.join(projectRoot, 'mobile-app-status.json');
  const sourcePlanFile = path.join(projectRoot, 'native-app-plan.md');
  const revisionFile = path.join(projectRoot, '.tmp', 'mobile-er-revision.json');
  const readyFile = path.join(projectRoot, '.tmp', 'mobile-plan-companion.json');
  const clients = new Set();
  let watchTimer;

  function readStatus() {
    if (!fs.existsSync(statusFile)) return {};
    return JSON.parse(fs.readFileSync(statusFile, 'utf8'));
  }

  function sendEvent(name, value) {
    const payload = `event: ${name}\ndata: ${JSON.stringify(value)}\n\n`;
    for (const response of clients) response.write(payload);
  }

  function authorized(requestUrl, request) {
    return requestUrl.searchParams.get('token') === token
      || request.headers['x-mobile-plan-token'] === token;
  }

  const server = http.createServer((request, response) => {
    const requestUrl = new URL(request.url, `http://${host}`);
    if (!authorized(requestUrl, request)) {
      response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Forbidden');
      return;
    }

    if (request.method === 'GET' && requestUrl.pathname === '/') {
      if (!fs.existsSync(planFile)) {
        response.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('Planning page is not ready yet.');
        return;
      }
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      });
      response.end(fs.readFileSync(planFile));
      return;
    }

    if (request.method === 'GET' && requestUrl.pathname === '/events') {
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      response.write(`event: status\ndata: ${JSON.stringify(readStatus())}\n\n`);
      clients.add(response);
      request.on('close', () => clients.delete(response));
      return;
    }

    if (request.method === 'GET' && requestUrl.pathname === '/mobile-app-status.json') {
      response.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      });
      response.end(JSON.stringify(readStatus()));
      return;
    }

    if (request.method === 'POST' && requestUrl.pathname === '/api/gate-2/revision') {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk) => {
        body += chunk;
        if (body.length > 1024 * 1024) request.destroy();
      });
      request.on('end', () => {
        try {
          const revision = validateRevision(JSON.parse(body));
          const status = readStatus();
          const saved = {
            ...revision,
            gate: 2,
            runId: status.startedAt || null,
            basePlanSha256: fileHash(sourcePlanFile),
            submittedAt: new Date().toISOString(),
          };
          atomicJson(revisionFile, saved);
          sendEvent('revision', {
            gate: 2,
            submittedAt: saved.submittedAt,
            file: '.tmp/mobile-er-revision.json',
          });
          response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          response.end(JSON.stringify({ status: 'saved', file: revisionFile }));
        } catch (error) {
          response.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
          response.end(JSON.stringify({ status: 'invalid', error: error.message }));
        }
      });
      return;
    }

    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Not found');
  });

  const watcher = fs.watch(projectRoot, (eventType, filename) => {
    if (!filename || !['mobile-app-status.json', 'mobile-app-plan.html'].includes(filename)) return;
    clearTimeout(watchTimer);
    watchTimer = setTimeout(() => {
      if (filename === 'mobile-app-status.json') {
        try {
          sendEvent('status', readStatus());
        } catch (error) {
          sendEvent('server-error', { message: error.message });
        }
      } else {
        sendEvent('plan', { updatedAt: new Date().toISOString() });
      }
    }, 80);
  });

  function close() {
    clearTimeout(watchTimer);
    watcher.close();
    for (const response of clients) response.end();
    clients.clear();
    server.close();
  }

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(Number(options.port || 0), host, () => {
      const address = server.address();
      const url = `http://${host}:${address.port}/?token=${token}`;
      atomicJson(readyFile, {
        version: 1,
        pid: process.pid,
        host,
        port: address.port,
        url,
        projectRoot,
        startedAt: new Date().toISOString(),
      });
      resolve({ server, close, url, readyFile, revisionFile });
    });
  });
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args['project-root']) {
    process.stderr.write('Usage: node serve-mobile-plan.js --project-root <path> [--host 127.0.0.1] [--port 0]\n');
    process.exit(1);
  }
  const companion = await createCompanion({
    projectRoot: args['project-root'],
    host: args.host,
    port: args.port,
  });
  process.stdout.write(`${JSON.stringify({ status: 'ready', url: companion.url, readyFile: companion.readyFile })}\n`);
  const shutdown = () => companion.close();
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exit(1);
  });
}

module.exports = { createCompanion, validateRevision };
