#!/usr/bin/env node

// Resolves a Power Platform environment URL or ID through Azure CLI and Dataverse APIs.
// Usage: node scripts/resolve-environment.js <environment-url-or-id>
// Output: JSON with environmentUrl, environmentId, tenantId, and displayName when available.

const environmentResolution = require('./lib/environment-resolution');
const { readTelemetryCluster } = require('./lib/app-identity');
const { flushPriorEvents } = require('./lib/mobile-telemetry-dispatcher');

async function main() {
  const target = process.argv[2];
  if (!target) {
    process.stderr.write('Usage: node scripts/resolve-environment.js <environment-url-or-id>\nPass the environment ID from power.config.json, or pass the Dataverse environment URL directly.\n');
    process.exit(1);
  }

  const projectRoot = process.cwd();
  const result = await environmentResolution.resolveEnvironment(target, projectRoot, Boolean(readTelemetryCluster(projectRoot)));
  await flushPriorEvents(projectRoot, result);
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
}

module.exports = environmentResolution;