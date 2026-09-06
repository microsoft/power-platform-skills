#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { validateExecutableManifest } = require('./execute-dataverse-operation-manifest');
const {
  readArtifact: readPlanningTimingArtifact,
  updatePlanningTiming,
} = require('./planning-timings');
const { atomicWriteJson } = require('./lib/dataverse-planning-telemetry');
const {
  configuredDataSources,
  dataSourceEntries,
  verifyDataverseServices,
} = require('./verify-dataverse-services');

function normalizeName(value) {
  return String(value || '').trim().toLowerCase();
}

function requiredServiceTables(manifest) {
  const required = manifest?.service?.requiredTables;
  if (!Array.isArray(required)) throw new Error('manifest service.requiredTables must be an array');
  const names = required.map((item, index) => {
    const logicalName = normalizeName(item?.logicalName);
    if (!/^[a-z][a-z0-9_]*$/.test(logicalName)) {
      throw new Error(`manifest service.requiredTables[${index}].logicalName is invalid`);
    }
    return logicalName;
  });
  if (new Set(names).size !== names.length) {
    throw new Error('manifest service.requiredTables contains duplicate logical names');
  }
  return names;
}

function verifyGeneratedServices(projectRoot, logicalNames, fileSystem = fs) {
  return verifyDataverseServices(projectRoot, logicalNames, fileSystem);
}

function writeTiming(timingPath, action, count, options = {}) {
  if (!timingPath) return;
  const artifact = readPlanningTimingArtifact(timingPath);
  updatePlanningTiming(artifact, {
    stage: 'dataverseServiceGeneration',
    action,
    counts: { services: count },
    reason: options.reason,
    nowIso: options.nowIso,
    nowMs: options.nowMs,
  });
  atomicWriteJson(timingPath, artifact);
}

function defaultRunCommand(command, args, options) {
  return spawnSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function generateDataverseServices(options) {
  const {
    projectRoot,
    manifest,
    environmentUrl,
    tenantId,
    solution,
    timingPath = null,
    runCommand = defaultRunCommand,
    fileSystem = fs,
    nowMs = () => Date.now(),
    nowIso = () => new Date().toISOString(),
    onProgress = () => {},
  } = options;
  const validation = validateExecutableManifest(manifest, {
    environmentUrl,
    tenantId,
    solution,
  });
  if (!validation.valid) {
    throw new Error(`Invalid Dataverse operation manifest: ${validation.errors.join('; ')}`);
  }
  const logicalNames = requiredServiceTables(manifest);
  writeTiming(timingPath, 'start', logicalNames.length, { nowMs, nowIso });
  const startedAt = nowMs();
  try {
    for (const logicalName of logicalNames) {
      const args = [
        'power-apps',
        'add-data-source',
        '--api-id',
        'dataverse',
        '--org-url',
        environmentUrl,
        '--resource-name',
        logicalName,
      ];
      const result = runCommand('npx', args, { cwd: projectRoot });
      if (result?.error || result?.status !== 0) {
        const detail = String(result?.stderr || result?.stdout || result?.error?.message || 'unknown error').trim();
        throw new Error(`service generation failed for ${logicalName}: ${detail}`);
      }
      onProgress({ logicalName });
    }
    const services = verifyGeneratedServices(projectRoot, logicalNames, fileSystem);
    writeTiming(timingPath, 'finish', logicalNames.length, { nowMs, nowIso });
    return {
      ok: true,
      count: logicalNames.length,
      durationMs: Math.max(0, nowMs() - startedAt),
      services,
    };
  } catch (error) {
    writeTiming(timingPath, 'fail', logicalNames.length, {
      reason: 'dataverse-service-generation-failed',
      nowMs,
      nowIso,
    });
    throw error;
  }
}

function resolveInside(root, requested) {
  const resolved = path.resolve(root, requested);
  const relative = path.relative(root, resolved);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`path is outside project root: ${requested}`);
  }
  return resolved;
}

function parseArgs(argv) {
  const args = {};
  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--project-root') args.projectRoot = argv[++index];
    else if (token === '--manifest') args.manifest = argv[++index];
    else if (token === '--env-url') args.environmentUrl = argv[++index];
    else if (token === '--tenant-id') args.tenantId = argv[++index];
    else if (token === '--solution') args.solution = argv[++index];
    else if (token === '--timings') args.timings = argv[++index];
    else throw new Error(`Unknown argument: ${token}`);
  }
  for (const field of ['projectRoot', 'manifest', 'environmentUrl', 'solution']) {
    if (!args[field]) throw new Error(`--${field.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} is required`);
  }
  return args;
}

function main(argv = process.argv) {
  try {
    const args = parseArgs(argv);
    const projectRoot = path.resolve(args.projectRoot);
    const manifestPath = resolveInside(projectRoot, args.manifest);
    const result = generateDataverseServices({
      projectRoot,
      manifest: JSON.parse(fs.readFileSync(manifestPath, 'utf8')),
      environmentUrl: args.environmentUrl,
      tenantId: args.tenantId || null,
      solution: args.solution,
      timingPath: args.timings ? resolveInside(projectRoot, args.timings) : null,
      onProgress: ({ logicalName }) => process.stderr.write(`generated ${logicalName} service\n`),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`generate-dataverse-services: ${error.message}\n`);
    return 2;
  }
}

if (require.main === module) process.exitCode = main();

module.exports = {
  configuredDataSources,
  dataSourceEntries,
  generateDataverseServices,
  main,
  requiredServiceTables,
  verifyGeneratedServices,
};