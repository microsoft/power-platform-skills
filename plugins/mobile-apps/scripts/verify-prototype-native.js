'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { inside, readJson, assertRevision } = require('./lib/prototype-files');
const { sha256Hex } = require('./lib/product-experience-contracts');
const { validateDomain } = require('./lib/prototype-domain');
const { verifyPrototypeStartup } = require('./lib/prototype-startup');

function regular(root, relative) {
  const file = inside(root, relative);
  if (!fs.statSync(file).isFile()) throw new Error(`Native project requires a regular ${relative}`);
  return file;
}

function verifyNativeProject(root, { prototype = false, requireConnected = false } = {}) {
  regular(root, 'app.config.js');
  readJson(root, 'package.json');
  const profile = fs.existsSync(inside(root, '.tmp/prototype-profile.json'))
    ? readJson(root, '.tmp/prototype-profile.json') : null;
  if (!prototype) {
    if (profile?.profile === 'prototype') throw new Error('Explicit local prototype requires --prototype; do not initialize an environment');
    if (profile?.profile === 'connector') {
      const result = require('./lib/prototype-connector-startup').verifyPrototypeConnectorStartup(root);
      return { ...result, nativeSupport: 'not-verified', mutated: false };
    }
    regular(root, 'power.config.json');
    return { ok: true, profile: 'connected', nativeSupport: 'not-verified', mutated: false };
  }
  if (requireConnected) throw new Error('This capability requires an explicitly connected app; local prototypes cannot provision or simulate Dataverse');
  if (profile?.schemaVersion !== 1 || profile.profile !== 'prototype') throw new Error('--prototype requires an existing materialized prototype profile');
  if (!fs.existsSync(inside(root, 'src')) || !fs.statSync(inside(root, 'src')).isDirectory()) throw new Error('Native prototype requires src/');
  if (fs.existsSync(inside(root, 'power.config.json'))) throw new Error('Prototype has live configuration; finish or discard the approved conversion first');
  const domain = readJson(root, '.tmp/prototype-domain.json');
  validateDomain(domain);
  const identity = readJson(root, 'app.json').expo?.extra?.telemetry?.appInstanceId;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(identity || '')
    || identity !== domain.appInstanceId || identity !== profile.appInstanceId) throw new Error('Prototype identity is missing or mismatched');
  const registry = readJson(root, '.tmp/data-access-registry.json');
  if (registry.mode !== 'local-prototype' || registry.contractType !== 'data-access-registry') throw new Error('Prototype requires its real local data-access registry');
  assertRevision(registry, 'registryRevision', 'Data-access registry');
  const owned = readJson(root, '.tmp/prototype-generated.json');
  for (const file of ['src/data/runtime.ts', 'src/data/PrototypeProvider.tsx', 'src/data/repositories/local.ts']) {
    if (sha256Hex(fs.readFileSync(regular(root, file))) !== owned.files?.[file]) throw new Error(`Prototype-owned startup changed: ${file}`);
  }
  verifyPrototypeStartup(root);
  return { ok: true, profile: 'prototype', appInstanceId: identity, nativeSupport: 'not-verified', environmentAccess: false, mutated: false };
}

function main(argv = process.argv.slice(2)) {
  try {
    let root;
    const options = {};
    for (let index = 0; index < argv.length; index += 1) {
      if (argv[index] === '--project-root') root = argv[++index];
      else if (argv[index] === '--prototype') options.prototype = true;
      else if (argv[index] === '--require-connected') options.requireConnected = true;
      else throw new Error(`Unknown argument: ${argv[index]}`);
    }
    if (!root) throw new Error('--project-root is required');
    console.log(JSON.stringify(verifyNativeProject(path.resolve(root), options), null, 2));
    return 0;
  } catch (error) {
    console.error(error.message);
    return 1;
  }
}

if (require.main === module) process.exitCode = main();
module.exports = { verifyNativeProject, main };
