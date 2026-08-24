#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { domainModelRevision, validatePrototypeDomainModel } = require('./lib/prototype-domain-model');
const { screenInputFingerprint, validateScreenArtifact } = require('./validate-screen-artifact');
const { validateScreenBuildPack } = require('./validate-screen-build-pack');
const { validateScreenTaskDirectory } = require('./validate-screen-task-pack');

const SCOPES = new Set(['domain', 'tasks', 'screen', 'screens', 'typecheck', 'all']);

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`${label} is invalid JSON: ${error.message}`);
  }
}

function safeProjectFile(projectRoot, relativePath) {
  if (typeof relativePath !== 'string' || path.isAbsolute(relativePath)) return null;
  const root = path.resolve(projectRoot);
  const target = path.resolve(root, relativePath);
  if (!target.startsWith(`${root}${path.sep}`)) return null;
  let cursor = root;
  for (const part of path.relative(root, target).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) return null;
  }
  return target;
}

function check(id, errors, details = {}) {
  return { id, valid: errors.length === 0, errors, ...details };
}

function lifecycleContext(projectRoot) {
  const statePath = path.join(projectRoot, '.mobile-app', 'state.json');
  if (fs.existsSync(statePath)) return readJson(statePath, 'Lifecycle state');
  const powerPath = path.join(projectRoot, 'power.config.json');
  const environmentPath = path.join(projectRoot, '.resolved-environment.json');
  const manifestPath = path.join(projectRoot, '.datamodel-manifest.json');
  const mappingPath = path.join(projectRoot, '.tmp', 'dataverse-repository-mapping.json');
  if (![powerPath, environmentPath, manifestPath, mappingPath].every((filePath) => fs.existsSync(filePath))) return { dataMode: 'prototype', environment: null, transition: null };
  const power = readJson(powerPath, 'Power Apps config');
  const resolved = readJson(environmentPath, 'Resolved environment');
  const environmentId = String(power.environmentId || '');
  if (!environmentId || /^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(environmentId) || environmentId.toLowerCase() !== String(resolved.environmentId || '').toLowerCase()) {
    return { dataMode: 'prototype', environment: null, transition: null };
  }
  return {
    dataMode: 'dataverse',
    environment: {
      id: environmentId,
      url: resolved.environmentUrl || null,
      displayName: resolved.displayName || null,
    },
    transition: null,
  };
}

function validateDomainScope(projectRoot) {
  const domainPath = path.join(projectRoot, '.tmp', 'prototype-domain-model.json');
  if (!fs.existsSync(domainPath)) return check('domain', ['.tmp/prototype-domain-model.json is missing']);
  const model = readJson(domainPath, 'Prototype domain model');
  const validation = validatePrototypeDomainModel(model);
  const errors = [...validation.errors];
  const manifestPath = path.join(projectRoot, '.mobile-app', 'prototype-domain-manifest.json');
  if (!fs.existsSync(manifestPath)) errors.push('.mobile-app/prototype-domain-manifest.json is missing');
  else {
    const manifest = readJson(manifestPath, 'Prototype domain manifest');
    if (manifest.domainModelRevision !== domainModelRevision(model)) errors.push('prototype domain manifest revision is stale');
    for (const relativePath of manifest.files || []) {
      const filePath = safeProjectFile(projectRoot, relativePath);
      if (!filePath) errors.push(`prototype domain manifest contains unsafe path ${relativePath}`);
      else if (!fs.existsSync(filePath)) errors.push(`prototype domain file is missing: ${relativePath}`);
      else if (/\.[jt]sx?$/.test(relativePath)) {
        const source = fs.readFileSync(filePath, 'utf8');
        const adapterBoundary = ['src/data/repositories/dataverseRepositories.ts', 'src/data/repositories/connectorRepositories.ts'].includes(relativePath);
        if (/from\s+['"]@?\/?(?:src\/)?generated\//.test(source) && !adapterBoundary) errors.push(`${relativePath} imports the generated service layer outside an approved repository adapter boundary`);
      }
    }
  }
  const providerPath = path.join(projectRoot, 'src', 'data', 'PrototypeDataProvider.tsx');
  if (fs.existsSync(providerPath) && /QueryClientProvider/.test(fs.readFileSync(providerPath, 'utf8'))) errors.push('PrototypeDataProvider must use the Query Client owned by PowerAppsProvider');
  if (fs.existsSync(path.join(projectRoot, 'src', 'generated', '.prototype-manifest.json'))) errors.push('legacy generated prototype manifest remains; run migrate-legacy-prototype.js');
  const dataMode = lifecycleContext(projectRoot).dataMode;
  if (['transitioning', 'dataverse'].includes(dataMode)) {
    const reportPath = path.join(projectRoot, '.tmp', 'dataverse-reconciliation-report.json');
    const mappingPath = path.join(projectRoot, '.tmp', 'dataverse-repository-mapping.json');
    const dataverseManifestPath = path.join(projectRoot, '.datamodel-manifest.json');
    if (!fs.existsSync(reportPath) || readJson(reportPath, 'Dataverse reconciliation report').status !== 'ready') errors.push('Dataverse reconciliation report is missing or blocked');
    if (!fs.existsSync(mappingPath)) errors.push('Dataverse repository mapping is missing');
    else {
      const mapping = readJson(mappingPath, 'Dataverse repository mapping');
      if (mapping.domainModelRevision !== domainModelRevision(model)) errors.push('Dataverse repository mapping domain revision is stale');
      if (!fs.existsSync(dataverseManifestPath) || mapping.dataverseManifestSha256 !== sha256(fs.readFileSync(dataverseManifestPath))) errors.push('Dataverse repository mapping manifest revision is stale');
    }
    const adapterPath = path.join(projectRoot, 'src', 'data', 'repositories', 'dataverseRepositories.ts');
    if (!fs.existsSync(adapterPath) || !/Generated by prototype-to-real-app\/gen-dataverse-repositories\.js/.test(fs.readFileSync(adapterPath, 'utf8'))) errors.push('Dataverse repository adapter has not been generated from the reconciled mapping');
    const executionPath = path.join(projectRoot, '.tmp', 'mobile-plan-execution-contract.json');
    const connectors = fs.existsSync(executionPath) ? readJson(executionPath, 'Mobile plan execution contract').connectorOperations || [] : [];
    if (connectors.length) {
      const connectorAdapterPath = path.join(projectRoot, 'src', 'data', 'repositories', 'connectorRepositories.ts');
      if (!fs.existsSync(connectorAdapterPath) || !fs.readFileSync(connectorAdapterPath, 'utf8').startsWith('// Generated by connector repository adapter')) errors.push('Real connector repository adapter is missing for approved connector operations');
    }
  }
  return check('domain', errors, { revision: domainModelRevision(model) });
}

function loadPack(projectRoot) {
  const packPath = path.join(projectRoot, '.tmp', 'screen-build-pack.json');
  if (!fs.existsSync(packPath)) throw new Error('.tmp/screen-build-pack.json is missing');
  return readJson(packPath, 'Screen build pack');
}

function validateTasksScope(projectRoot) {
  const pack = loadPack(projectRoot);
  const packValidation = validateScreenBuildPack(projectRoot, pack);
  const errors = packValidation.issues.map((issue) => `[${issue.rule}] ${issue.message}`);
  if (!errors.length) errors.push(...validateScreenTaskDirectory(projectRoot, pack).map((issue) => `[${issue.rule}] ${issue.message}`));
  return check('tasks', errors, { revision: pack.revision });
}

function validateOneScreen(projectRoot, pack, screenId) {
  const screen = pack.screens.find((candidate) => candidate.id === screenId);
  if (!screen) return check(`screen:${screenId}`, [`screen ${screenId} is not present in the build pack`]);
  const fingerprint = screenInputFingerprint(projectRoot, pack, screenId);
  if (fingerprint.error) return check(`screen:${screenId}`, [fingerprint.error]);
  const source = fs.readFileSync(path.join(projectRoot, screen.file), 'utf8');
  const artifact = {
    schemaVersion: 1,
    kind: 'mobile-screen-artifact',
    packRevision: pack.revision,
    screenId,
    route: screen.route,
    file: screen.file,
    inputFileSha256: fingerprint.inputFileSha256,
    source,
    warnings: [],
  };
  return check(`screen:${screenId}`, validateScreenArtifact(projectRoot, pack, artifact, screenId).errors);
}

function validateScreensScope(projectRoot, screenId = null) {
  const pack = loadPack(projectRoot);
  const packValidation = validateScreenBuildPack(projectRoot, pack);
  if (packValidation.issues.length) return [check('screen-build-pack', packValidation.issues.map((issue) => `[${issue.rule}] ${issue.message}`))];
  if (screenId) return [validateOneScreen(projectRoot, pack, screenId)];
  return pack.screens.map((screen) => validateOneScreen(projectRoot, pack, screen.id));
}

function validateTypecheckScope(projectRoot) {
  const result = spawnSync('npm', ['--prefix', projectRoot, 'run', 'type-check'], { encoding: 'utf8', timeout: 180000 });
  const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
  const errors = result.status === 0 ? [] : [output.slice(-8000) || result.error?.message || `type-check exited ${result.status}`];
  return check('typecheck', errors);
}

function validateByScope(projectRoot, scope, screenId = null) {
  if (!SCOPES.has(scope)) throw new Error(`unsupported validation scope ${scope}`);
  if (scope === 'screen' && !screenId) throw new Error('--screen is required for screen scope');
  if (scope === 'domain') return [validateDomainScope(projectRoot)];
  if (scope === 'tasks') return [validateTasksScope(projectRoot)];
  if (scope === 'screen') return validateScreensScope(projectRoot, screenId);
  if (scope === 'screens') return validateScreensScope(projectRoot);
  if (scope === 'typecheck') return [validateTypecheckScope(projectRoot)];
  const domain = validateDomainScope(projectRoot);
  if (!domain.valid) return [domain];
  const tasks = validateTasksScope(projectRoot);
  if (!tasks.valid) return [domain, tasks];
  return [domain, tasks, ...validateScreensScope(projectRoot), validateTypecheckScope(projectRoot)];
}

function recordLifecycleValidation(projectRoot, scope, screenId, checks) {
  if (!checks.every((item) => item.valid)) throw new Error('cannot record a failed validation result');
  const statePath = path.join(projectRoot, '.mobile-app', 'state.json');
  const inferred = lifecycleContext(projectRoot);
  const state = fs.existsSync(statePath) ? readJson(statePath, 'Lifecycle state') : {
    schemaVersion: 2,
    dataMode: inferred.dataMode,
    environment: inferred.environment,
    transition: inferred.transition,
  };
  const domainPath = path.join(projectRoot, '.tmp', 'prototype-domain-model.json');
  if (!fs.existsSync(domainPath)) throw new Error('cannot record lifecycle validation without .tmp/prototype-domain-model.json');
  const domainBytes = fs.readFileSync(domainPath);
  const model = JSON.parse(domainBytes.toString('utf8'));
  const mappingPath = path.join(projectRoot, '.tmp', 'dataverse-repository-mapping.json');
  const prototypeMapping = (model.operations || []).map((operation) => ({
    operation: operation.key,
    entity: operation.entity,
    repository: operation.repository,
    method: operation.method,
    hook: operation.hook,
  }));
  const packPath = path.join(projectRoot, '.tmp', 'screen-build-pack.json');
  const packRevision = fs.existsSync(packPath) ? readJson(packPath, 'Screen build pack').revision || null : null;
  Object.assign(state, {
    schemaVersion: 2,
    lastDomainModelHash: sha256(domainBytes),
    lastRepositoryMappingHash: fs.existsSync(mappingPath) ? sha256(fs.readFileSync(mappingPath)) : sha256(stableStringify(prototypeMapping)),
    lastFixtureRevision: sha256(stableStringify({ fixtures: model.fixtures || {}, fixtureScenarios: model.fixtureScenarios || [] })),
    lastValidation: {
      scope,
      screenId: screenId || null,
      status: 'passed',
      checkedAt: new Date().toISOString(),
      buildPackRevision: packRevision,
    },
  });
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const temporaryPath = `${statePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { flag: 'wx' });
    fs.renameSync(temporaryPath, statePath);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
  return state;
}

function parseArgs(argv) {
  const args = { scope: 'all' };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--project-root') args.projectRoot = argv[++index];
    else if (argv[index] === '--scope') args.scope = argv[++index];
    else if (argv[index] === '--screen') args.screenId = argv[++index];
    else if (argv[index] === '--record') args.record = true;
  }
  return args;
}

function main(argv) {
  const args = parseArgs(argv);
  if (!args.projectRoot) {
    process.stderr.write('Usage: node validate-mobile-app.js --project-root <dir> [--scope domain|tasks|screen|screens|typecheck|all] [--screen <id>] [--record]\n');
    return 2;
  }
  try {
    const checks = validateByScope(path.resolve(args.projectRoot), args.scope, args.screenId);
    const result = { validator: 'validate-mobile-app', scope: args.scope, screenId: args.screenId || null, valid: checks.every((item) => item.valid), checks };
    if (result.valid && args.record) recordLifecycleValidation(path.resolve(args.projectRoot), args.scope, args.screenId, checks);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.valid ? 0 : 2;
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ validator: 'validate-mobile-app', scope: args.scope, screenId: args.screenId || null, valid: false, checks: [{ id: 'dispatcher', valid: false, errors: [error.message] }] }, null, 2)}\n`);
    return 2;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { recordLifecycleValidation, validateByScope, validateDomainScope, validateOneScreen, validateTasksScope };