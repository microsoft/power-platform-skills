#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const protocol = require('./lib/authoring-protocol');
const { protocolHash, readDescriptor } = require('./lib/mobile-authoring-context');
const { digest, canonicalJson, readFile, readJson } = require('./lib/mobile-authoring-files');
const { publicError } = require('./lib/mobile-authoring-errors');

const PLUGIN_ROOT = path.resolve(__dirname, '..');

function capabilities() {
  const present = (relative) => fs.existsSync(path.join(PLUGIN_ROOT, relative));
  const questions = [
    'scripts/mobile-authoring.js', 'scripts/lib/mobile-authoring-context.js',
    'scripts/lib/mobile-authoring-transport.js', 'scripts/lib/mobile-authoring-decisions.js',
    'scripts/lib/mobile-authoring-errors.js',
    'shared/references/mobile-authoring.md', 'scripts/lib/authoring-source.js',
  ].every(present);
  const registrationFiles = [
    'scripts/lib/mobile-authoring-registration.js', 'scripts/configure-prototype-authoring.js',
    'scripts/lib/prototype-authoring.js', 'scripts/lib/prototype-screen-authoring.js',
    'scripts/lib/authoring-runtime.js',
    'scripts/templates/mobile-authoring/index.tsx', 'scripts/templates/mobile-authoring/controller.ts',
    'scripts/templates/mobile-authoring/README.md',
  ];
  const candidates = questions && ['scripts/lib/mobile-authoring-candidate.js', ...registrationFiles].every(present);
  const contextualEditing = questions && candidates && [
    'scripts/authoring-edit.js', 'scripts/lib/authoring-edit.js', 'scripts/lib/authoring-edit-context.js',
    'scripts/lib/authoring-edit-integration.js', 'scripts/lib/authoring-edit-registration.js',
    'scripts/lib/native-capability-catalog.js',
    'scripts/native-capabilities.json', 'scripts/lib/authoring-rules.js',
    'scripts/lib/prototype-rules.js',
    'scripts/lib/prototype-domain.js', 'scripts/lib/prototype-files.js', 'scripts/lib/prototype-repository-core.js',
    'skills/edit-app/references/player-authoring.md',
  ].every(present);
  const teaching = contextualEditing && present('scripts/generate-prototype-rules.js');
  const catalogueSupportFiles = [
    'scripts/lib/prototype-files.js', 'scripts/lib/product-experience-contracts.js',
    'scripts/lib/json-schema-lite.js',
  ];
  const nativeCatalogFiles = [
    'scripts/list-native-capabilities.js', 'scripts/lib/native-capability-catalog.js',
    'scripts/native-capabilities.json', 'template/package.json', ...catalogueSupportFiles,
  ];
  const connectorCatalogFiles = [
    'scripts/list-prototype-connections.js', 'scripts/lib/prototype-connections.js',
    'scripts/lib/validation-helpers.js', 'scripts/resolve-environment.js', ...catalogueSupportFiles,
    'skills/list-connections/SKILL.md', 'skills/list-connections/references/existing-selection.md',
  ];
  const integrationFiles = [
    'scripts/lib/prototype-generator.js',
    'scripts/verify-prototype-native.js', 'scripts/lib/prototype-startup.js',
    'scripts/lib/prototype-connector-startup.js',
    'skills/add-native/SKILL.md', 'skills/add-native/references/prototype-mode.md',
    'skills/add-native/add-camera/SKILL.md', 'skills/add-native/add-pdf-report/SKILL.md',
    'skills/add-native/add-pdf-viewer/SKILL.md', 'skills/add-native/add-pen-input/SKILL.md',
    'skills/add-native/add-geolocation/SKILL.md',
    'scripts/verify-prototype-connection.js', 'scripts/stage-prototype-connector.js',
    'skills/add-connector/SKILL.md', 'skills/add-sharepoint/SKILL.md',
  ];
  const dataverseConversionFiles = [
    'skills/prototype-to-real-app/SKILL.md', 'scripts/prototype-conversion.js',
    'scripts/generate-prototype-dataverse.js', 'scripts/player-dataverse.js',
    'scripts/lib/player-dataverse.js',
  ];
  // Browsing does not load or grant the optional candidate, SDK metadata or
  // Add workflow. Those adapters retain their own execution checks.
  const nativeCatalog = nativeCatalogFiles.every(present);
  const connectorCatalog = connectorCatalogFiles.every(present);
  const dataverseConversion = questions && candidates && dataverseConversionFiles.every(present);
  const operations = [];
  if (candidates && present('skills/create-mobile-prototype/SKILL.md') && present('scripts/generate-prototype.js')) operations.push('prototype');
  if (contextualEditing) operations.push('edit');
  if (teaching) operations.push('teach');
  if (dataverseConversion) operations.push('connect');
  const manifest = protocol.assertCapabilities({
    protocolVersion: protocol.PROTOCOL_VERSION, protocolId: protocol.PROTOCOL_ID, protocolHash: protocolHash(),
    operations, questions, candidates, progressivePreview: candidates,
    contextualEditing, teaching, dataverseConversion, nativeCatalog, connectorCatalog,
  });
  return {
    ...manifest,
    questionKinds: questions ? ['plan', 'clarification', 'apply', 'schema'] : [],
    answerTypes: questions ? ['text', 'select', 'boolean'] : [],
    decisionTransport: questions ? 'scoped-runner-ed25519' : null,
    connectorMetadataTransport: contextualEditing ? 'scoped-sdk-get-v1' : null,
    publicationOwner: candidates ? 'bridge' : null,
    buildIdentity: digest(canonicalJson([...new Set([
      'scripts/mobile-authoring.js', 'scripts/lib/mobile-authoring-context.js',
      'scripts/lib/mobile-authoring-files.js',
      'scripts/lib/mobile-authoring-errors.js',
      'scripts/lib/mobile-authoring-decisions.js', 'scripts/lib/mobile-authoring-transport.js',
      'scripts/lib/mobile-authoring-candidate.js', 'scripts/authoring-edit.js',
      'scripts/lib/authoring-edit.js', 'scripts/lib/authoring-edit-context.js',
      'scripts/lib/authoring-edit-integration.js', 'scripts/lib/authoring-edit-registration.js',
      'scripts/lib/native-capability-catalog.js',
      'scripts/native-capabilities.json',
      'scripts/generate-prototype-rules.js', 'scripts/lib/prototype-rules.js',
      'scripts/lib/authoring-rules.js', 'scripts/lib/authoring-source.js',
      ...registrationFiles, ...nativeCatalogFiles, ...connectorCatalogFiles, ...integrationFiles, ...dataverseConversionFiles,
    ])].filter(present).map((file) => ({ file, sha256: digest(readFile(path.join(PLUGIN_ROOT, file), 1024 * 1024)) })))),
  };
}

function parseArgs(argv) {
  const args = { command: argv[2], bind: [], readyScreenIds: [] };
  const values = {
    '--project-root': 'projectRoot', '--input': 'input', '--receipt': 'receipt',
    '--record-gate': 'recordGate', '--wait-ms': 'waitMs', '--message': 'message',
  };
  for (let index = 3; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === '--final') {
      if (args.final) throw new Error('Duplicate --final');
      args.final = true;
    } else if (key === '--bind' || key === '--ready-screen') {
      if (!argv[index + 1] || argv[index + 1].startsWith('--')) throw new Error('Missing authoring option value');
      args[key === '--bind' ? 'bind' : 'readyScreenIds'].push(argv[++index]);
    } else if (values[key]) {
      if (args[values[key]] !== undefined) throw new Error('Duplicate authoring option');
      if (!argv[index + 1] || argv[index + 1].startsWith('--')) throw new Error('Missing authoring option value');
      args[values[key]] = argv[++index];
    } else throw new Error('Unsupported authoring command option');
  }
  if (args.waitMs !== undefined) args.waitMs = Number(args.waitMs);
  if (args.recordGate !== undefined) args.recordGate = Number(args.recordGate);
  return args;
}

function publicIdentity(descriptor) {
  return {
    protocolVersion: descriptor.protocolVersion, protocolHash: descriptor.protocolHash,
    appInstanceId: descriptor.appInstanceId, jobId: descriptor.jobId, attemptId: descriptor.attemptId,
    operation: descriptor.operation, baseRevision: descriptor.baseRevision,
    ...(descriptor.integration ? { integration: descriptor.integration } : {}),
  };
}

async function run(args, options = {}) {
  const allowedOptions = {
    capabilities: [],
    verify: ['projectRoot'],
    binding: ['projectRoot', 'bind', 'recordGate'],
    'request-question': ['projectRoot', 'input', 'bind', 'recordGate', 'waitMs'],
    'verify-receipt': ['projectRoot', 'receipt', 'recordGate'],
    event: ['projectRoot', 'input'],
    candidate: ['projectRoot', 'readyScreenIds', 'final'],
    complete: ['projectRoot'],
    failed: ['projectRoot', 'message'],
  }[args.command];
  if (!allowedOptions || Object.entries(args).some(([key, value]) => key !== 'command'
    && value !== undefined && !(Array.isArray(value) && !value.length) && !allowedOptions.includes(key))) {
    throw new Error('Unsupported command or options for this authoring operation');
  }
  if (args.recordGate !== undefined && ![1, 2, 3, 4].includes(args.recordGate)) throw new Error('--record-gate must be 1, 2, 3, or 4');
  if (args.command === 'capabilities') return capabilities();
  const loaded = readDescriptor({ ...options, projectRoot: args.projectRoot });
  if (!loaded) {
    if (args.command === 'verify') return { mode: 'standalone', questionTransport: 'AskUserQuestion' };
    throw new Error('No Player job is active; retain the ordinary foreground workflow');
  }
  const client = require('./lib/mobile-authoring-transport').createClient({ ...options, projectRoot: args.projectRoot });
  const root = client.descriptor.workspaceDir;
  if (args.command === 'verify') {
    await client.verify();
    return { mode: 'player', verified: true, ...publicIdentity(client.descriptor), context: client.descriptor.context || null };
  }
  if (args.command === 'binding') {
    await client.verify();
    return require('./lib/mobile-authoring-decisions').questionBinding(root, args);
  }
  if (args.command === 'request-question') {
    if (!args.input) throw new Error('request-question requires --input with a project-relative JSON file');
    const result = await client.requestQuestion(readJson(root, args.input), args);
    let gateRecorded = false;
    if (args.recordGate !== undefined && result.receipt.action === 'approve') {
      const saved = await client.verifySavedDecision(result.receiptPath, { gateId: `gate${args.recordGate}` });
      if (saved.binding.type !== 'gate' || saved.binding.gate !== args.recordGate) throw new Error('Receipt does not bind the owning plan gate');
      require('./lib/mobile-plan-approval').approveGate(root, args.recordGate, { now: saved.receipt.issuedAt });
      gateRecorded = true;
    }
    return { status: 'answered', action: result.receipt.action, answer: result.receipt.answer, receipt: result.receiptPath, gateRecorded };
  }
  if (args.command === 'verify-receipt') {
    if (!args.receipt) throw new Error('verify-receipt requires --receipt');
    const saved = await client.verifySavedDecision(args.receipt, {
      ...(args.recordGate === undefined ? {} : { gateId: `gate${args.recordGate}` }),
    });
    return { verified: true, gateId: saved.question.gateId, sourceRevision: saved.question.sourceRevision, action: saved.receipt.action };
  }
  if (args.command === 'event') {
    if (!args.input) throw new Error('event requires --input');
    await client.event(readJson(root, args.input));
    return { status: 'reported' };
  }
  if (args.command === 'candidate') return require('./lib/mobile-authoring-candidate').prepareCandidate(client, { readyScreenIds: args.readyScreenIds, final: args.final });
  if (args.command === 'complete') {
    await client.complete();
    return { status: 'operation-complete', applied: false };
  }
  if (args.command === 'failed') {
    if (!args.message) throw new Error('failed requires a bounded, nonsecret --message');
    await client.failed(args.message);
    return { status: 'operation-failed' };
  }
  throw new Error('Expected capabilities, verify, binding, request-question, verify-receipt, event, candidate, complete, or failed');
}

async function main(argv = process.argv) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  try {
    const result = await run(parseArgs(argv), { signal: controller.signal });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    // Avoid serializing OS errors, response bodies, stacks, descriptors, or argv:
    // these can contain an issuer path or a callback credential.
    process.stderr.write(`mobile-authoring: ${publicError(error, process.env.MOBILE_AUTHORING_RUNNER_TOKEN)}\n`);
    return 2;
  } finally {
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
  }
}

if (require.main === module) main().then((code) => { process.exitCode = code; });

module.exports = { capabilities, parseArgs, publicIdentity, run, main };
