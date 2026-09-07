#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { readJson, atomicWrite } = require('./lib/prototype-files');
const { ensureAppInstanceId } = require('./lib/app-identity');

async function bindPrototypeIdentity(root, { receipt } = {}, {
  env = process.env, clientFactory = (options) => require('./lib/mobile-authoring-transport').createClient(options),
} = {}) {
  if (!env.MOBILE_AUTHORING_CONTEXT && !env.MOBILE_AUTHORING_RUNNER_TOKEN) {
    return { ok: true, appInstanceId: ensureAppInstanceId(root), transport: 'standalone' };
  }
  const client = clientFactory({ env, projectRoot: root });
  if (client.descriptor.operation !== 'prototype'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(client.descriptor.appInstanceId)) {
    throw new Error('Prototype creation requires the bridge-owned v4 app identity');
  }
  await client.verify({ refresh: true });
  const app = readJson(root, 'app.json');
  if (!app.expo || typeof app.expo !== 'object' || Array.isArray(app.expo)) throw new Error('A supported Expo template is required');
  const existing = app.expo.extra?.telemetry?.appInstanceId;
  if (existing && existing !== client.descriptor.appInstanceId) throw new Error('Existing app identity does not match the verified authoring context');
  if (existing === client.descriptor.appInstanceId) return { ok: true, appInstanceId: existing, unchanged: true, transport: 'player' };
  if (!receipt) throw new Error('Step 2c must be explicitly approved before initializing the app identity');
  const saved = await client.verifySavedDecision(receipt, { gateId: 'create-preflight', action: 'approve' });
  if (saved.question.kind !== 'plan' || saved.question.fields.length
    || !(['source', 'artifacts'].includes(saved.binding.type))
    || (saved.binding.type === 'artifacts' && ['app.json', 'package.json'].some((file) => !saved.binding.files.some((entry) => entry.path === file)))) {
    throw new Error('Step 2c requires the exact preflight source/package approval, not another gate or an ambiguous answer');
  }
  if ((app.expo.extra !== undefined && (!app.expo.extra || typeof app.expo.extra !== 'object' || Array.isArray(app.expo.extra)))
    || (app.expo.extra?.telemetry !== undefined && (!app.expo.extra.telemetry || typeof app.expo.extra.telemetry !== 'object' || Array.isArray(app.expo.extra.telemetry)))) {
    throw new Error('Template telemetry configuration is malformed; do not replace unrelated metadata');
  }
  app.expo.extra = { ...app.expo.extra, telemetry: { ...app.expo.extra?.telemetry, appInstanceId: client.descriptor.appInstanceId } };
  atomicWrite(root, 'app.json', app);
  return { ok: true, appInstanceId: client.descriptor.appInstanceId, transport: 'player' };
}

async function main(argv = process.argv.slice(2)) {
  try {
    let root;
    let receipt;
    for (let index = 0; index < argv.length; index += 1) {
      if (argv[index] === '--project-root') root = argv[++index];
      else if (argv[index] === '--receipt') receipt = argv[++index];
      else throw new Error('Unsupported prototype identity option');
    }
    if (!root) throw new Error('--project-root is required');
    process.stdout.write(`${JSON.stringify(await bindPrototypeIdentity(path.resolve(root), { receipt }))}\n`);
    return 0;
  } catch (error) {
    const token = process.env.MOBILE_AUTHORING_RUNNER_TOKEN;
    process.stderr.write(`bind-prototype-identity: ${token ? String(error.message).split(token).join('[redacted]') : error.message}\n`);
    return 1;
  }
}

if (require.main === module) main().then((status) => { process.exitCode = status; });
module.exports = { bindPrototypeIdentity, main };
