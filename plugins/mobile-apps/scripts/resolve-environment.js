#!/usr/bin/env node

// Resolves a Power Platform environment URL or ID through Azure CLI and Dataverse APIs.
// Usage: node scripts/resolve-environment.js <environment-url-or-id> [--no-cache]
// Output: JSON with environmentUrl, environmentId, tenantId, and displayName when available.

const environmentResolution = require('./lib/environment-resolution');
const { readTelemetryCluster } = require('./lib/app-identity');
const { flushPriorEvents } = require('./lib/mobile-telemetry-dispatcher');

function parseArgs(argv) {
  const options = { noCache: false, target: null };
  for (const argument of argv) {
    if (argument === '--no-cache') options.noCache = true;
    else if (!options.target) options.target = argument;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

function writeCacheIfProject(result, options = {}) {
  return environmentResolution.writeCacheIfProject(result, process.cwd(), options);
}

async function resolveEnvironment(target, options = {}) {
  if (!target) {
    throw new Error('Pass the environment ID from power.config.json, or pass the Dataverse environment URL directly.');
  }
  const projectRoot = process.cwd();
  return environmentResolution.resolveEnvironment(
    target, projectRoot, Boolean(readTelemetryCluster(projectRoot)), options,
  );
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (!options.target) {
    process.stderr.write('Usage: node scripts/resolve-environment.js <environment-url-or-id> [--no-cache]\nPass the environment ID from power.config.json, or pass the Dataverse environment URL directly.\n');
    process.exitCode = 1;
    return;
  }
  const result = await resolveEnvironment(options.target, options);
  // Planning must not persist cluster routing or replay telemetry before approval.
  if (!options.noCache) await flushPriorEvents(process.cwd(), result);
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${environmentResolution.redactDiagnostic(error.message)}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  ...environmentResolution,
  parseArgs,
  resolveEnvironment,
  writeCacheIfProject,
};
