#!/usr/bin/env node

// Resolves a Power Platform environment URL or ID through Azure CLI and Dataverse APIs.
// Usage: node scripts/resolve-environment.js <environment-url-or-id> [--no-cache] [--require-tenant]
// Output: JSON with environmentUrl, environmentId, tenantId, and displayName when available.

const environmentResolution = require('./lib/environment-resolution');
const { readTelemetryCluster } = require('./lib/app-identity');
const { flushPriorEvents } = require('./lib/mobile-telemetry-dispatcher');

const USAGE = 'Usage: node scripts/resolve-environment.js <environment-url-or-id> [--no-cache] [--require-tenant]\n'
  + '       node scripts/resolve-environment.js --help\n'
  + 'Pass the environment ID from power.config.json, or pass the Dataverse environment URL directly.\n'
  + '\nOptions:\n'
  + '  --no-cache        Do not persist environment/auth caches or telemetry routing, or replay telemetry.\n'
  + '                    Existing identity metadata may still be read.\n'
  + '  --require-tenant  Fail unless both a Dataverse environment URL and tenant ID are resolved.\n'
  + '  --help, -h        Show this help without resolving an environment.\n';

function parseArgs(argv) {
  const options = { noCache: false, target: null };
  for (const argument of argv) {
    if (argument === '--no-cache') options.noCache = true;
    else if (argument === '--require-tenant') options.requireTenant = true;
    else if (argument === '--help' || argument === '-h') options.help = true;
    else if (argument.startsWith('-')) throw new Error(`Unknown option: ${argument}`);
    else if (!options.target) options.target = argument;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

function writeCacheIfProject(result, options = {}) {
  return environmentResolution.writeCacheIfProject(result, process.cwd(), options);
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(USAGE);
    return;
  }
  if (!options.target) {
    process.stderr.write(USAGE);
    process.exitCode = 1;
    return;
  }
  const projectRoot = process.cwd();
  const result = await environmentResolution.resolveEnvironment(
    options.target, projectRoot, Boolean(readTelemetryCluster(projectRoot)), options,
  );
  if (options.requireTenant && ['environmentUrl', 'tenantId'].some(
    (field) => typeof result?.[field] !== 'string' || !result[field].trim(),
  )) {
    throw new Error('Could not resolve a Dataverse environment URL and tenant ID.');
  }
  // Planning must not persist cluster routing or replay telemetry before approval.
  if (!options.noCache) await flushPriorEvents(projectRoot, result);
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
  main,
  parseArgs,
  writeCacheIfProject,
};
