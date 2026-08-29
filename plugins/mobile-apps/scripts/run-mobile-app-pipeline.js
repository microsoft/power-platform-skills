#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  recordPlanningDuration,
  summarizePlanningTimings,
  readArtifact: readTimingArtifact,
} = require('./planning-timings');
const {
  promotePlanningGeneration,
} = require('./refresh-dataverse-planning-evidence');
const {
  materializeFromFiles,
} = require('./materialize-dataverse-manifest');

const PIPELINE_SCHEMA_VERSION = 1;
const MODES = new Set(['planning', 'scaffold', 'execute']);
const ENVIRONMENT_ID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

function stableClone(value) {
  if (Array.isArray(value)) return value.map(stableClone);
  if (!value || typeof value !== 'object') return value;
  return Object.keys(value).sort().reduce((result, key) => {
    result[key] = stableClone(value[key]);
    return result;
  }, {});
}

function stableJson(value) {
  return `${JSON.stringify(stableClone(value), null, 2)}\n`;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function withIntegrity(value) {
  return { ...value, integritySha256: sha256(stableJson(value)) };
}

function atomicWriteJson(file, value, fileSystem = fs) {
  const resolved = path.resolve(file);
  fileSystem.mkdirSync(path.dirname(resolved), { recursive: true });
  const temporary = `${resolved}.tmp-${process.pid}-${Date.now()}`;
  try {
    fileSystem.writeFileSync(temporary, stableJson(value), 'utf8');
    fileSystem.renameSync(temporary, resolved);
  } finally {
    if (fileSystem.existsSync(temporary)) fileSystem.rmSync(temporary, { force: true });
  }
}

function readJson(file, fileSystem = fs) {
  return JSON.parse(fileSystem.readFileSync(path.resolve(file), 'utf8'));
}

function verifyIntegrity(value, label) {
  if (!value?.integritySha256) return;
  const content = { ...value };
  delete content.integritySha256;
  if (value.integritySha256 !== sha256(stableJson(content))) {
    throw new Error(`${label} integrity does not match`);
  }
}

function verifyPipelineOutput(value, label) {
  if (!/^[a-f0-9]{64}$/i.test(String(value?.integritySha256 || ''))) {
    throw new Error(`${label} integritySha256 is required`);
  }
  verifyIntegrity(value, label);
  if (value?.schemaVersion !== PIPELINE_SCHEMA_VERSION) {
    throw new Error(
      `${label} schemaVersion ${value?.schemaVersion ?? '<missing>'} is unsupported; `
      + `expected ${PIPELINE_SCHEMA_VERSION}`,
    );
  }
}

function isInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function requireProjectPath(workingDir, file, label) {
  const resolved = path.resolve(workingDir, file);
  if (!isInside(workingDir, resolved)) {
    throw new Error(`${label} must stay inside the working directory`);
  }
  return resolved;
}

function defaultRunCommand(command, args, { cwd }) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 20 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    status: Number.isInteger(result.status) ? result.status : 1,
    stdout: result.stdout || '',
    stderr: result.stderr || result.error?.message || '',
  };
}

function boundedFailureText(value) {
  return String(value || '').trim().slice(0, 2000);
}

function safeDiagnostic(value) {
  return boundedFailureText(value)
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/([?&](?:token|access_token|client_secret|code)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\b/g, '[redacted-jwt]');
}

function parseJsonOutput(result, stage) {
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(
      `${stage} returned malformed JSON; stdout=${safeDiagnostic(result.stdout).slice(0, 500)}`
      + `; stderr=${safeDiagnostic(result.stderr).slice(0, 500)}`,
    );
  }
}

function runRequired(runCommand, command, args, options, stage) {
  const startedAt = Date.now();
  const result = runCommand(command, args, options);
  const durationMs = Math.max(0, Date.now() - startedAt);
  if (result.status !== 0) {
    throw new Error(
      `${stage} failed (${result.status}): `
      + safeDiagnostic(result.stderr || result.stdout || 'no output'),
    );
  }
  return { ...result, durationMs };
}

function parseArgs(argv) {
  const args = { mode: argv[2] || null };
  for (let index = 3; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new Error(`Unknown argument: ${token}`);
    const name = token.slice(2);
    if ([
      'json',
      'check',
      'connector-only',
      'prepare-template',
      'skip-service-generation',
      'skip-typecheck',
      'progressive-detail',
      'combined-base-read',
    ].includes(name)) {
      args[name] = true;
      continue;
    }
    if (index + 1 >= argv.length || argv[index + 1].startsWith('--')) {
      throw new Error(`Missing value for --${name}`);
    }
    args[name] = argv[++index];
  }
  return args;
}

function commonPaths(args) {
  if (!args['working-dir']) throw new Error('--working-dir is required');
  const workingDir = path.resolve(args['working-dir']);
  const artifactsDir = requireProjectPath(
    workingDir,
    args['artifacts-dir'] || '.tmp',
    'artifacts directory',
  );
  const outputPath = requireProjectPath(
    workingDir,
    args.output || path.join(artifactsDir, `${args.mode}-pipeline-output.json`),
    'pipeline output',
  );
  return { workingDir, artifactsDir, outputPath };
}

function processExists(pid, processApi = process) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    processApi.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function acquireExecutionLock(lockPath, dependencies = {}) {
  const fileSystem = dependencies.fileSystem || fs;
  const processApi = dependencies.processApi || process;
  const nowIso = dependencies.nowIso || (() => new Date().toISOString());
  const resolved = path.resolve(lockPath);
  fileSystem.mkdirSync(path.dirname(resolved), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const token = crypto.randomUUID();
    try {
      const descriptor = fileSystem.openSync(resolved, 'wx');
      try {
        fileSystem.writeFileSync(descriptor, stableJson({
          schemaVersion: 1,
          pid: processApi.pid,
          startedAt: nowIso(),
          token,
        }), 'utf8');
      } finally {
        fileSystem.closeSync(descriptor);
      }
      return () => {
        try {
          const current = readJson(resolved, fileSystem);
          if (current.token === token) fileSystem.rmSync(resolved, { force: true });
        } catch {
          // A missing or replaced lock no longer belongs to this invocation.
        }
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      let existing = null;
      try {
        existing = readJson(resolved, fileSystem);
      } catch {
        // Malformed lock artifacts are stale and can be replaced atomically.
      }
      if (processExists(Number(existing?.pid), processApi)) {
        throw new Error(
          `Dataverse execution already in progress for this app (pid ${existing.pid})`,
        );
      }
      fileSystem.rmSync(resolved, { force: true });
    }
  }
  throw new Error('could not acquire the Dataverse execution lock');
}

function scriptPath(name) {
  return path.join(__dirname, name);
}

function readEnvironmentId(workingDir, fileSystem = fs) {
  const powerConfig = path.join(workingDir, 'power.config.json');
  if (!fileSystem.existsSync(powerConfig)) return null;
  const value = readJson(powerConfig, fileSystem).environmentId;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function environmentTarget(args, workingDir, planningOutput = null, fileSystem = fs) {
  return args['environment-id']
    || args['env-url']
    || planningOutput?.context?.environmentId
    || readEnvironmentId(workingDir, fileSystem);
}

function resolveEnvironmentContext({ args, workingDir, runCommand }) {
  const target = environmentTarget(args, workingDir);
  if (!target) throw new Error('environment ID or URL is required');
  const result = runRequired(
    runCommand,
    process.execPath,
    [scriptPath('resolve-environment.js'), target, '--no-cache'],
    { cwd: workingDir },
    'environment resolution',
  );
  const context = parseJsonOutput(result, 'environment resolution');
  if (!context.environmentUrl || !context.tenantId) {
    throw new Error('environment resolution did not return URL and tenant ID');
  }
  return { context, durationMs: result.durationMs };
}

function detectPublisher({ context, solution, workingDir, runCommand }) {
  const result = runRequired(
    runCommand,
    process.execPath,
    [
      scriptPath('detect-publisher-prefix.js'),
      context.environmentUrl,
      solution,
      '--tenant-id',
      context.tenantId,
    ],
    { cwd: workingDir },
    'publisher prefix detection',
  );
  const detected = parseJsonOutput(result, 'publisher prefix detection');
  if (!detected.prefix) {
    throw new Error(`publisher prefix detection failed: ${detected.reason || 'missing prefix'}`);
  }
  return { prefix: detected.prefix, durationMs: result.durationMs };
}

function outputTimingSummary(timingsPath, fileSystem = fs) {
  return fileSystem.existsSync(timingsPath)
    ? summarizePlanningTimings(readTimingArtifact(timingsPath, fileSystem))
    : null;
}

function writePipelineOutput(outputPath, value, fileSystem = fs) {
  const output = withIntegrity(value);
  atomicWriteJson(outputPath, output, fileSystem);
  return output;
}

async function runPlanningPipeline(args, dependencies = {}) {
  const fileSystem = dependencies.fileSystem || fs;
  const runCommand = dependencies.runCommand || defaultRunCommand;
  const promoteGeneration = dependencies.promotePlanningGeneration
    || promotePlanningGeneration;
  const recordDuration = dependencies.recordPlanningDuration || recordPlanningDuration;
  const { workingDir, artifactsDir, outputPath } = commonPaths(args);
  fileSystem.mkdirSync(artifactsDir, { recursive: true });
  const timingsPath = path.join(artifactsDir, 'mobile-planning-timings.json');
  const startedAt = new Date().toISOString();
  const resolved = resolveEnvironmentContext({ args, workingDir, runCommand });
  recordDuration(timingsPath, 'environmentResolution', resolved.durationMs);
  const solution = args.solution || 'Default';

  if (args['connector-only']) {
    return writePipelineOutput(outputPath, {
      schemaVersion: PIPELINE_SCHEMA_VERSION,
      mode: 'planning',
      status: 'PLANNING_CONTEXT_READY',
      startedAt,
      completedAt: new Date().toISOString(),
      planningMode: 'connector-only',
      context: { ...resolved.context, solutionUniqueName: solution },
      artifacts: { timingsPath },
      timingSummary: outputTimingSummary(timingsPath, fileSystem),
    }, fileSystem);
  }

  const publisher = detectPublisher({
    context: resolved.context,
    solution,
    workingDir,
    runCommand,
  });
  recordDuration(timingsPath, 'publisherPrefixDetection', publisher.durationMs);
  const snapshotPath = path.join(artifactsDir, 'dataverse-foreground-planning-snapshot.json');
  const telemetryPath = path.join(artifactsDir, 'dataverse-planning-telemetry.json');
  const inventoryCachePath = path.join(artifactsDir, 'dataverse-inventory-cache.json');
  const snapshotArgs = [
    scriptPath('create-dataverse-snapshot.js'),
    '--env-url', resolved.context.environmentUrl,
    '--tenant-id', resolved.context.tenantId,
    '--solution', solution,
    '--output', snapshotPath,
    '--read-concurrency', args['read-concurrency'] || '1',
    '--inventory-cache', inventoryCachePath,
    '--telemetry-output', telemetryPath,
    '--planning-timings-output', timingsPath,
  ];
  if (args['concepts-file']) {
    const conceptsFile = requireProjectPath(workingDir, args['concepts-file'], 'concepts file');
    requireExisting(fileSystem, conceptsFile, 'concepts file');
    snapshotArgs.push('--concepts-file', conceptsFile);
  }
  if (args['base-snapshot']) {
    const baseSnapshot = requireProjectPath(
      workingDir,
      args['base-snapshot'],
      'base snapshot',
    );
    requireExisting(fileSystem, baseSnapshot, 'base snapshot');
    snapshotArgs.push('--base-snapshot', baseSnapshot);
  }
  if (args.tables) snapshotArgs.push('--tables', args.tables);
  if (args['proposed-tables']) snapshotArgs.push('--proposed-tables', args['proposed-tables']);
  if (args['progressive-detail']) snapshotArgs.push('--progressive-detail');
  if (args['combined-base-read']) snapshotArgs.push('--combined-base-read');
  runRequired(
    runCommand,
    process.execPath,
    snapshotArgs,
    { cwd: workingDir },
    'planning snapshot',
  );

  const generationsDir = path.join(artifactsDir, 'dataverse-planning-generations');
  const pointerPath = path.join(artifactsDir, 'dataverse-planning-current.json');
  const promotionStartedAt = Date.now();
  const generation = promoteGeneration({
    snapshotFile: snapshotPath,
    generationsDir,
    pointerFile: pointerPath,
    fileSystem,
  });
  recordDuration(
    timingsPath,
    'artifactValidation',
    Math.max(0, Date.now() - promotionStartedAt),
  );
  return writePipelineOutput(outputPath, {
    schemaVersion: PIPELINE_SCHEMA_VERSION,
    mode: 'planning',
    status: 'PLANNING_EVIDENCE_READY',
    startedAt,
    completedAt: new Date().toISOString(),
    planningMode: 'required',
    context: {
      ...resolved.context,
      publisherPrefix: publisher.prefix,
      solutionUniqueName: solution,
    },
    artifacts: {
      snapshotPath: generation.snapshotPath,
      evidencePath: generation.evidencePath,
      generationManifestPath: generation.manifestPath,
      pointerPath,
      timingsPath,
      telemetryPath,
      inventoryCachePath,
    },
    hashes: {
      snapshotSha256: generation.sourceSnapshotSha256,
      evidenceSha256: generation.evidenceSha256,
    },
    timingSummary: outputTimingSummary(timingsPath, fileSystem),
  }, fileSystem);
}

async function runScaffoldPipeline(args, dependencies = {}) {
  const fileSystem = dependencies.fileSystem || fs;
  const runCommand = dependencies.runCommand || defaultRunCommand;
  const { workingDir, artifactsDir, outputPath } = commonPaths(args);
  fileSystem.mkdirSync(artifactsDir, { recursive: true });
  if (!args['display-name']) throw new Error('--display-name is required');
  const planningOutput = planningContext(args, workingDir, fileSystem);
  const target = environmentTarget(args, workingDir, planningOutput, fileSystem);
  if (!target) throw new Error('--environment-id is required for scaffold');
  if (!ENVIRONMENT_ID_PATTERN.test(target)) {
    throw new Error('scaffold requires a Power Platform environment GUID');
  }
  const plannedEnvironmentId = planningOutput?.context?.environmentId;
  if (plannedEnvironmentId
    && plannedEnvironmentId.toLowerCase() !== target.toLowerCase()) {
    throw new Error('scaffold environment does not match planning output');
  }
  const stages = [];
  if (args['prepare-template']) {
    if (!args.slug) throw new Error('--slug is required with --prepare-template');
    const prepared = runRequired(
      runCommand,
      process.execPath,
      [
        scriptPath('prepare-mobile-template.js'),
        '--working-dir', workingDir,
        '--display-name', args['display-name'],
        '--slug', args.slug,
        '--allow-plan-artifact',
      ],
      { cwd: workingDir },
      'template preparation',
    );
    stages.push({ name: 'templatePreparation', status: 'DONE', durationMs: prepared.durationMs });
  }

  const configuredEnvironmentId = readEnvironmentId(workingDir, fileSystem);
  if (configuredEnvironmentId
    && configuredEnvironmentId.toLowerCase() !== String(target).toLowerCase()) {
    throw new Error(
      `existing power.config.json targets ${configuredEnvironmentId}, expected ${target}`,
    );
  }
  if (!configuredEnvironmentId) {
    const initialized = runRequired(
      runCommand,
      'npx',
      [
        'power-apps', 'init', '-t', 'MobileApp',
        '--display-name', args['display-name'],
        '--environment-id', target,
        '--non-interactive',
      ],
      { cwd: workingDir },
      'Power Apps initialization',
    );
    stages.push({ name: 'powerAppsInit', status: 'DONE', durationMs: initialized.durationMs });
    const initializedEnvironmentId = readEnvironmentId(workingDir, fileSystem);
    if (!initializedEnvironmentId
      || initializedEnvironmentId.toLowerCase() !== String(target).toLowerCase()) {
      throw new Error('Power Apps initialization did not persist the approved environment');
    }
  } else {
    stages.push({ name: 'powerAppsInit', status: 'SKIPPED_ALREADY_CONFIGURED', durationMs: 0 });
  }
  if (!fileSystem.existsSync(path.join(workingDir, 'node_modules', 'expo'))) {
    throw new Error('template dependencies are not installed: node_modules/expo is missing');
  }
  if (!args['skip-typecheck']) {
    const checked = runRequired(
      runCommand,
      'npx',
      ['tsc', '--noEmit'],
      { cwd: workingDir },
      'scaffold typecheck',
    );
    stages.push({ name: 'scaffoldTypecheck', status: 'DONE', durationMs: checked.durationMs });
  }
  return writePipelineOutput(outputPath, {
    schemaVersion: PIPELINE_SCHEMA_VERSION,
    mode: 'scaffold',
    status: 'SCAFFOLD_READY',
    completedAt: new Date().toISOString(),
    context: { environmentId: target },
    stages,
  }, fileSystem);
}

function addOptionalFlag(commandArgs, flag, value) {
  if (value !== null && value !== undefined && value !== '') {
    commandArgs.push(flag, String(value));
  }
}

function planningContext(args, workingDir, fileSystem) {
  if (!args['planning-output']) return null;
  const planningOutputPath = requireProjectPath(
    workingDir,
    args['planning-output'],
    'planning output',
  );
  const output = readJson(planningOutputPath, fileSystem);
  verifyPipelineOutput(output, 'planning output');
  if (!['PLANNING_EVIDENCE_READY', 'PLANNING_CONTEXT_READY'].includes(output.status)) {
    throw new Error(`planning output status ${output.status || '<missing>'} is not executable`);
  }
  return output;
}

function requireExisting(fileSystem, file, label) {
  if (!fileSystem.existsSync(file)) throw new Error(`${label} is missing: ${file}`);
}

async function runExecutionPipelineUnlocked(args, dependencies = {}) {
  const fileSystem = dependencies.fileSystem || fs;
  const runCommand = dependencies.runCommand || defaultRunCommand;
  const recordDuration = dependencies.recordPlanningDuration || recordPlanningDuration;
  const materializeManifest = dependencies.materializeFromFiles || materializeFromFiles;
  const { workingDir, artifactsDir, outputPath } = commonPaths(args);
  fileSystem.mkdirSync(artifactsDir, { recursive: true });
  const stages = [];
  const planningOutput = planningContext(args, workingDir, fileSystem);
  const target = environmentTarget(args, workingDir, planningOutput, fileSystem);
  if (!target) throw new Error('execution requires an environment ID or planning output');
  const resolvedResult = runRequired(
    runCommand,
    process.execPath,
    [scriptPath('resolve-environment.js'), target, '--no-cache'],
    { cwd: workingDir },
    'execution environment resolution',
  );
  const context = parseJsonOutput(resolvedResult, 'execution environment resolution');
  if (!context.environmentUrl || !context.tenantId) {
    throw new Error('execution environment resolution did not return URL and tenant ID');
  }
  stages.push({
    name: 'environmentResolution',
    status: 'DONE',
    durationMs: resolvedResult.durationMs,
  });
  if (planningOutput) {
    const expected = planningOutput.context || {};
    if (expected.environmentId && context.environmentId
      && expected.environmentId.toLowerCase() !== context.environmentId.toLowerCase()) {
      throw new Error('execution environment ID does not match planning output');
    }
    if (expected.environmentUrl
      && expected.environmentUrl.replace(/\/+$/, '').toLowerCase()
        !== context.environmentUrl.replace(/\/+$/, '').toLowerCase()) {
      throw new Error('execution environment URL does not match planning output');
    }
    if (expected.tenantId
      && expected.tenantId.toLowerCase() !== context.tenantId.toLowerCase()) {
      throw new Error('execution tenant does not match planning output');
    }
  }
  const effectiveEnvironmentId = context.environmentId
    || planningOutput?.context?.environmentId
    || args['environment-id']
    || null;
  if (!effectiveEnvironmentId) {
    throw new Error('execution requires a resolved environment ID');
  }
  const configuredEnvironmentId = readEnvironmentId(workingDir, fileSystem);
  if (configuredEnvironmentId
    && configuredEnvironmentId.toLowerCase() !== effectiveEnvironmentId.toLowerCase()) {
    throw new Error(
      `power.config.json targets ${configuredEnvironmentId}, expected ${effectiveEnvironmentId}`,
    );
  }
  if (!args.check && !args['skip-service-generation'] && !configuredEnvironmentId) {
    throw new Error('service generation requires power.config.json in the working directory');
  }
  const solution = args.solution
    || planningOutput?.context?.solutionUniqueName
    || 'Default';
  let publisherPrefix = args['publisher-prefix']
    || planningOutput?.context?.publisherPrefix
    || null;
  if (!publisherPrefix) {
    const publisher = detectPublisher({ context, solution, workingDir, runCommand });
    publisherPrefix = publisher.prefix;
    stages.push({
      name: 'publisherPrefixDetection',
      status: 'DONE',
      durationMs: publisher.durationMs,
    });
  }
  const timingsPath = path.join(artifactsDir, 'mobile-planning-timings.json');
  recordDuration(timingsPath, 'environmentResolution', resolvedResult.durationMs);
  const publisherStage = stages.find((stage) => stage.name === 'publisherPrefixDetection');
  if (publisherStage) {
    recordDuration(timingsPath, 'publisherPrefixDetection', publisherStage.durationMs);
  }
  const sourceContractPath = requireProjectPath(
    workingDir,
    args.contract || path.join(artifactsDir, 'dataverse-schema-contract.json'),
    'schema contract',
  );
  const boundContractPath = requireProjectPath(
    workingDir,
    args['bound-contract-output'] || sourceContractPath,
    'bound schema contract',
  );
  const approvalReceiptPath = requireProjectPath(
    workingDir,
    args['approval-receipt'] || path.join(artifactsDir, 'mobile-plan-status.json'),
    'approval receipt',
  );
  const planPath = requireProjectPath(
    workingDir,
    args.plan || 'native-app-plan.md',
    'approved plan',
  );
  for (const [file, label] of [
    [sourceContractPath, 'schema contract'],
    [approvalReceiptPath, 'approval receipt'],
    [planPath, 'approved plan'],
  ]) requireExisting(fileSystem, file, label);

  const scopePath = path.join(artifactsDir, 'dataverse-reconciliation-scope.json');
  const reconciliationPath = path.join(artifactsDir, 'dataverse-execution-reconciliation.json');
  const manifestPath = path.join(artifactsDir, 'dataverse-operation-manifest.json');
  const checkpointPath = path.join(artifactsDir, 'dataverse-publish-pending.json');
  const journalPath = path.join(artifactsDir, 'dataverse-metadata-execution-journal.json');
  const outcomePath = path.join(artifactsDir, 'dataverse-execution-outcome.json');
  const verificationReconciliationPath = path.join(
    artifactsDir,
    'dataverse-post-publish-reconciliation.json',
  );
  const verificationPath = path.join(artifactsDir, 'dataverse-post-publish-verification.json');
  const materializedManifestPath = requireProjectPath(
    workingDir,
    args['materialized-manifest-output'] || '.datamodel-manifest.json',
    'materialized Dataverse manifest',
  );
  const cachePath = path.join(artifactsDir, 'dataverse-inventory-cache.json');

  let manifestBuildValidationMs = 0;
  const bindResult = runRequired(
    runCommand,
    process.execPath,
    [
      scriptPath('build-dataverse-operation-manifest.js'),
      '--bind-plan', sourceContractPath,
      '--approval-receipt', approvalReceiptPath,
      '--plan', planPath,
      '--output', boundContractPath,
    ],
    { cwd: workingDir },
    'contract binding',
  );
  manifestBuildValidationMs += bindResult.durationMs;
  stages.push({ name: 'contractBinding', status: 'DONE', durationMs: bindResult.durationMs });
  const scopeResult = runRequired(
    runCommand,
    process.execPath,
    [
      scriptPath('build-dataverse-operation-manifest.js'),
      '--reconciliation-scope', boundContractPath,
      '--output', scopePath,
    ],
    { cwd: workingDir },
    'reconciliation scope',
  );
  manifestBuildValidationMs += scopeResult.durationMs;
  stages.push({ name: 'reconciliationScope', status: 'DONE', durationMs: scopeResult.durationMs });
  const scope = readJson(scopePath, fileSystem);
  if (!Array.isArray(scope.exactTables) || scope.exactTables.length === 0) {
    throw new Error('approved contract produced no exact Dataverse reconciliation scope');
  }

  const reconciliationResult = runRequired(
    runCommand,
    process.execPath,
    [
      scriptPath('create-dataverse-snapshot.js'),
      '--env-url', context.environmentUrl,
      '--tenant-id', context.tenantId,
      '--solution', solution,
      '--tables', scope.exactTables.join(','),
      '--proposed-tables', (scope.proposedTables || []).join(','),
      '--reconcile-exact',
      '--read-concurrency', args['read-concurrency'] || '1',
      '--output', reconciliationPath,
    ],
    { cwd: workingDir },
    'fresh execution reconciliation',
  );
  recordDuration(timingsPath, 'executionReconciliation', reconciliationResult.durationMs);
  stages.push({
    name: 'executionReconciliation',
    status: 'DONE',
    durationMs: reconciliationResult.durationMs,
  });

  const buildArgs = [
    scriptPath('build-dataverse-operation-manifest.js'),
    '--contract', boundContractPath,
    '--approval-receipt', approvalReceiptPath,
    '--reconciliation', reconciliationPath,
    '--plan', planPath,
    '--output', manifestPath,
    '--environment-id', effectiveEnvironmentId,
    '--env-url', context.environmentUrl,
    '--tenant-id', context.tenantId,
    '--publisher-prefix', publisherPrefix,
    '--solution', solution,
    '--publish-checkpoint', checkpointPath,
  ];
  const buildResult = runRequired(
    runCommand,
    process.execPath,
    buildArgs,
    { cwd: workingDir },
    'operation manifest build',
  );
  manifestBuildValidationMs += buildResult.durationMs;
  stages.push({ name: 'manifestBuild', status: 'DONE', durationMs: buildResult.durationMs });
  const validateArgs = [
    scriptPath('build-dataverse-operation-manifest.js'),
    '--validate', manifestPath,
    '--contract', boundContractPath,
    '--approval-receipt', approvalReceiptPath,
    '--reconciliation', reconciliationPath,
    '--plan', planPath,
    '--environment-id', effectiveEnvironmentId,
    '--env-url', context.environmentUrl,
    '--tenant-id', context.tenantId,
    '--publisher-prefix', publisherPrefix,
    '--solution', solution,
    '--publish-checkpoint', checkpointPath,
    '--require-executable',
  ];
  const validationResult = runRequired(
    runCommand,
    process.execPath,
    validateArgs,
    { cwd: workingDir },
    'operation manifest validation',
  );
  manifestBuildValidationMs += validationResult.durationMs;
  stages.push({
    name: 'manifestValidation',
    status: 'DONE',
    durationMs: validationResult.durationMs,
  });
  recordDuration(timingsPath, 'manifestBuildValidation', manifestBuildValidationMs);
  let manifest = readJson(manifestPath, fileSystem);
  if (!manifest.executable
    || !manifest.summary
    || !Number.isInteger(manifest.summary.metadataOperationCount)
    || !Array.isArray(manifest.service?.requiredTables)) {
    throw new Error('validated operation manifest has an invalid executable summary');
  }

  const baseOutput = () => ({
    schemaVersion: PIPELINE_SCHEMA_VERSION,
    mode: 'execute',
    context: {
      ...context,
      environmentId: effectiveEnvironmentId,
      publisherPrefix,
      solutionUniqueName: solution,
    },
    artifacts: {
      boundContractPath,
      scopePath,
      reconciliationPath,
      manifestPath,
      checkpointPath,
      journalPath,
      outcomePath,
      verificationReconciliationPath,
      verificationPath,
      materializedManifestPath,
      timingsPath,
    },
    manifestSummary: manifest.summary,
    stages,
  });
  if (args.check) {
    return writePipelineOutput(outputPath, {
      ...baseOutput(),
      status: 'EXECUTION_READY',
      wouldMutateMetadata: manifest.summary.metadataWriteCount > 0,
      plannedMetadataOperationCount: manifest.summary.metadataOperationCount,
      plannedMetadataWriteCount: manifest.summary.metadataWriteCount,
      plannedServiceTables: manifest.service.requiredTables.map(
        (table) => table.logicalName,
      ),
      completedAt: new Date().toISOString(),
      timingSummary: outputTimingSummary(timingsPath, fileSystem),
    }, fileSystem);
  }

  const executeAttempt = (attempt) => {
    const executionStartedAt = Date.now();
    const result = runCommand(process.execPath, [
      scriptPath('execute-dataverse-plan.js'),
      '--manifest', manifestPath,
      '--contract', boundContractPath,
      '--approval-receipt', approvalReceiptPath,
      '--reconciliation', reconciliationPath,
      '--plan', planPath,
      '--journal', journalPath,
      '--publish-checkpoint', checkpointPath,
      '--inventory-cache', cachePath,
      '--outcome', outcomePath,
      '--timings-output', timingsPath,
      '--environment-id', effectiveEnvironmentId,
      '--env-url', context.environmentUrl,
      '--tenant-id', context.tenantId,
      '--publisher-prefix', publisherPrefix,
      '--solution', solution,
      '--json',
    ], { cwd: workingDir });
    const outcome = fileSystem.existsSync(outcomePath)
      ? readJson(outcomePath, fileSystem)
      : null;
    stages.push({
      name: 'metadataExecution',
      attempt,
      status: result.status === 0 ? 'DONE' : 'FAILED',
      durationMs: Math.max(0, Date.now() - executionStartedAt),
    });
    return { result, outcome };
  };

  const maxUncertainRecoveries = args['max-uncertain-recoveries'] === undefined
    ? 1
    : Number(args['max-uncertain-recoveries']);
  if (!Number.isInteger(maxUncertainRecoveries)
    || maxUncertainRecoveries < 0
    || maxUncertainRecoveries > 3) {
    throw new Error('--max-uncertain-recoveries must be an integer from 0 to 3');
  }

  let execution = executeAttempt(1);
  let uncertainRecoveryCount = 0;
  while (execution.outcome?.status === 'UNCERTAIN_RECONCILIATION_REQUIRED'
    && uncertainRecoveryCount < maxUncertainRecoveries) {
    uncertainRecoveryCount += 1;
    const recoveryStartedAt = Date.now();
    const freshReconciliation = runRequired(
      runCommand,
      process.execPath,
      [
        scriptPath('create-dataverse-snapshot.js'),
        '--env-url', context.environmentUrl,
        '--tenant-id', context.tenantId,
        '--solution', solution,
        '--tables', scope.exactTables.join(','),
        '--proposed-tables', (scope.proposedTables || []).join(','),
        '--reconcile-exact',
        '--read-concurrency', args['read-concurrency'] || '1',
        '--output', reconciliationPath,
      ],
      { cwd: workingDir },
      `uncertain recovery reconciliation ${uncertainRecoveryCount}`,
    );
    const rebuilt = runRequired(
      runCommand,
      process.execPath,
      buildArgs,
      { cwd: workingDir },
      `uncertain recovery manifest build ${uncertainRecoveryCount}`,
    );
    const revalidated = runRequired(
      runCommand,
      process.execPath,
      validateArgs,
      { cwd: workingDir },
      `uncertain recovery manifest validation ${uncertainRecoveryCount}`,
    );
    manifest = readJson(manifestPath, fileSystem);
    if (!manifest.executable
      || !manifest.summary
      || !Number.isInteger(manifest.summary.metadataOperationCount)
      || !Array.isArray(manifest.service?.requiredTables)) {
      throw new Error('uncertain recovery produced an invalid executable manifest');
    }
    execution = executeAttempt(uncertainRecoveryCount + 1);
    const recoveryDurationMs = Math.max(0, Date.now() - recoveryStartedAt);
    recordDuration(timingsPath, 'uncertainRecovery', recoveryDurationMs);
    stages.push({
      name: 'uncertainRecovery',
      attempt: uncertainRecoveryCount,
      status: execution.outcome?.status === 'DONE' ? 'DONE' : 'FAILED',
      durationMs: recoveryDurationMs,
      reconciliationMs: freshReconciliation.durationMs,
      manifestBuildMs: rebuilt.durationMs,
      manifestValidationMs: revalidated.durationMs,
    });
  }

  const executionResult = execution.result;
  const executionOutcome = execution.outcome;
  if (executionResult.status !== 0 || executionOutcome?.status !== 'DONE') {
    const status = executionOutcome?.status || 'BLOCKED';
    const output = writePipelineOutput(outputPath, {
      ...baseOutput(),
      status,
      reasonCode: executionOutcome?.reasonCode || 'EXECUTION_COMMAND_FAILED',
      executionOutcome,
      completedAt: new Date().toISOString(),
      timingSummary: outputTimingSummary(timingsPath, fileSystem),
    }, fileSystem);
    return output;
  }

  const verificationStartedAt = Date.now();
  const verificationResult = runCommand(process.execPath, [
      scriptPath('verify-dataverse-post-publish.js'),
      '--manifest', manifestPath,
      '--execution-outcome', outcomePath,
      '--reconciliation-output', verificationReconciliationPath,
      '--output', verificationPath,
      '--timings-output', timingsPath,
      '--env-url', context.environmentUrl,
      '--tenant-id', context.tenantId,
      '--json',
    ], { cwd: workingDir });
  const verificationDurationMs = Math.max(0, Date.now() - verificationStartedAt);
  const verification = fileSystem.existsSync(verificationPath)
    ? readJson(verificationPath, fileSystem)
    : null;
  stages.push({
    name: 'postPublishVerification',
    status: verificationResult.status === 0 ? 'DONE' : 'FAILED',
    durationMs: verificationDurationMs,
  });
  if (verification?.status === 'BLOCKED') {
    return writePipelineOutput(outputPath, {
      ...baseOutput(),
      status: 'BLOCKED',
      reasonCode: 'POST_PUBLISH_VERIFICATION_FAILED',
      executionOutcome,
      verification,
      completedAt: new Date().toISOString(),
      timingSummary: outputTimingSummary(timingsPath, fileSystem),
    }, fileSystem);
  }
  if (verificationResult.status !== 0 || !verification) {
    throw new Error(
      `post-publish verification failed (${verificationResult.status}): `
      + safeDiagnostic(verificationResult.stderr || verificationResult.stdout || 'no output'),
    );
  }

  const generatedServices = [];
  if (!args['skip-service-generation']) {
    for (const table of manifest.service?.requiredTables || []) {
      const generated = runRequired(
        runCommand,
        'npx',
        [
          'power-apps', 'add-data-source',
          '--api-id', 'dataverse',
          '--org-url', context.environmentUrl,
          '--resource-name', table.logicalName,
        ],
        { cwd: workingDir },
        `service generation for ${table.logicalName}`,
      );
      stages.push({
        name: 'serviceGeneration',
        target: table.logicalName,
        status: 'DONE',
        durationMs: generated.durationMs,
      });
      generatedServices.push(table.logicalName);
    }
    const schemas = runRequired(
      runCommand,
      'npm',
      ['run', 'generate-schemas'],
      { cwd: workingDir },
      'connector schema generation',
    );
    stages.push({
      name: 'connectorSchemaGeneration',
      status: 'DONE',
      durationMs: schemas.durationMs,
    });
    if (!args['skip-typecheck']) {
      const typecheck = runRequired(
        runCommand,
        'npx',
        ['tsc', '--noEmit'],
        { cwd: workingDir },
        'Dataverse generated-service typecheck',
      );
      stages.push({
        name: 'generatedServiceTypecheck',
        status: 'DONE',
        durationMs: typecheck.durationMs,
      });
    }
  }
  const materializationStartedAt = Date.now();
  const materializedManifest = materializeManifest({
    manifestPath,
    contractPath: boundContractPath,
    reconciliationPath: verificationReconciliationPath,
    outputPath: materializedManifestPath,
    context: {
      environmentId: effectiveEnvironmentId,
      environmentUrl: context.environmentUrl,
      solutionUniqueName: solution,
      publisherPrefix,
    },
    fileSystem,
  });
  stages.push({
    name: 'materializedManifest',
    status: 'DONE',
    durationMs: Math.max(0, Date.now() - materializationStartedAt),
  });
  return writePipelineOutput(outputPath, {
    ...baseOutput(),
    status: verification.status === 'DONE_WITH_PENDING_ACTIVATIONS'
      ? 'DONE_WITH_PENDING_ACTIVATIONS'
      : 'DONE',
    executionOutcome,
    verification,
    generatedServices,
    materializedTableCount: materializedManifest.tables.length,
    serviceGenerationSkipped: Boolean(args['skip-service-generation']),
    completedAt: new Date().toISOString(),
    timingSummary: outputTimingSummary(timingsPath, fileSystem),
  }, fileSystem);
}

async function runExecutionPipeline(args, dependencies = {}) {
  const fileSystem = dependencies.fileSystem || fs;
  const { artifactsDir } = commonPaths(args);
  const release = acquireExecutionLock(
    path.join(artifactsDir, 'dataverse-execution.lock'),
    {
      fileSystem,
      processApi: dependencies.processApi || process,
      nowIso: dependencies.nowIso,
    },
  );
  try {
    return await runExecutionPipelineUnlocked(args, dependencies);
  } finally {
    release();
  }
}

async function runPipeline(args, dependencies = {}) {
  if (!MODES.has(args.mode)) {
    throw new Error('mode must be planning, scaffold, or execute');
  }
  if (args.mode === 'planning') return runPlanningPipeline(args, dependencies);
  if (args.mode === 'scaffold') return runScaffoldPipeline(args, dependencies);
  return runExecutionPipeline(args, dependencies);
}

async function main(argv = process.argv) {
  let args;
  try {
    args = parseArgs(argv);
    const result = await runPipeline(args);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (['DONE', 'DONE_WITH_PENDING_ACTIVATIONS', 'EXECUTION_READY',
      'PLANNING_EVIDENCE_READY', 'PLANNING_CONTEXT_READY', 'SCAFFOLD_READY']
      .includes(result.status)) return 0;
    if (result.status === 'COLLISION_ADAPTATION_REQUIRED') return 3;
    if (result.status === 'UNCERTAIN_RECONCILIATION_REQUIRED') return 4;
    return 2;
  } catch (error) {
    const message = safeDiagnostic(error.message);
    if (args?.['working-dir']) {
      try {
        const { outputPath } = commonPaths(args);
        writePipelineOutput(outputPath, {
          schemaVersion: PIPELINE_SCHEMA_VERSION,
          mode: args.mode,
          status: 'BLOCKED',
          reasonCode: 'PIPELINE_STAGE_FAILED',
          error: message,
          completedAt: new Date().toISOString(),
        });
      } catch {
        // The primary validation error is more useful than a secondary output failure.
      }
    }
    process.stderr.write(`run-mobile-app-pipeline: ${message}\n`);
    return 2;
  }
}

if (require.main === module) {
  main().then((exitCode) => { process.exitCode = exitCode; });
}

module.exports = {
  PIPELINE_SCHEMA_VERSION,
  acquireExecutionLock,
  atomicWriteJson,
  defaultRunCommand,
  main,
  parseArgs,
  runExecutionPipeline,
  runPipeline,
  runPlanningPipeline,
  runScaffoldPipeline,
  stableJson,
  safeDiagnostic,
  verifyIntegrity,
  verifyPipelineOutput,
  withIntegrity,
};