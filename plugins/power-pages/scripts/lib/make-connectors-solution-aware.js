#!/usr/bin/env node

// Makes custom connectors solution-aware by migrating them into an unmanaged
// Dataverse solution — the same operation the maker portal performs when a custom
// connector created outside a solution is added to one.
//
// Why: a connection reference for a custom connector cannot be exported until the
// connector itself is solution-aware; export fails with 0x80040265 ("Exporting
// connection reference … for a custom connector requires the custom connector to be
// added to a dataverse solution"). Microsoft also requires custom connectors to ship in
// their own solution, imported before any connection reference that uses them:
// https://learn.microsoft.com/en-us/connectors/custom-connectors/customconnectorssolutions#known-limitations
//
// Usage:
//   node make-connectors-solution-aware.js --environmentId <guid> --solutionId <guid>
//        --connectors <name|connectorId>[,<name|connectorId>…] --consent
//        [--cloud Public|UsGov|UsGovHigh|UsGovDod] [--token <Power Platform API token>]
//
// --consent is REQUIRED. The migration changes how the connector is stored in the
// environment (it becomes a Dataverse component owned by the solution's publisher),
// so the calling skill must ask the user first and pass --consent only on "yes".
//
// Output (JSON to stdout):
//   { "ok": true|false,
//     "results": [{ "connectorName", "status", "error", "isSolutionAware", "xrmConnectorId" }],
//     "fallback": "<maker portal steps>"   // present only when ok is false
//   }
// Exit 0 when the request ran (inspect `ok`); exit 1 on usage, consent or auth errors.

'use strict';

const helpers = require('./validation-helpers');
const connectivity = require('./connectivity-api');

const FALLBACK_GUIDANCE =
  'Make the connector solution-aware in the maker portal instead: open the connectors solution → ' +
  'Add existing → Automation → Custom connector → select the connector → Add. Then re-run this step. ' +
  'See https://learn.microsoft.com/en-us/connectors/custom-connectors/customconnectorssolutions';

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = { environmentId: null, solutionId: null, connectors: [], cloud: null, token: null, consent: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--environmentId' && args[i + 1]) out.environmentId = args[++i];
    else if (args[i] === '--solutionId' && args[i + 1]) out.solutionId = args[++i];
    else if (args[i] === '--connectors' && args[i + 1]) {
      out.connectors = args[++i].split(',').map((s) => s.trim()).filter(Boolean);
    } else if (args[i] === '--cloud' && args[i + 1]) out.cloud = args[++i];
    else if (args[i] === '--token' && args[i + 1]) out.token = args[++i];
    else if (args[i] === '--consent') out.consent = true;
  }
  return out;
}

/**
 * Runs the migration, then re-reads each connector so the result reflects what the
 * service actually stored rather than only the POST's per-connector status.
 */
async function run({ environmentId, solutionId, connectors, cloud = 'Public', token, consent, makeRequest }) {
  if (!consent) {
    throw new Error('Refusing to migrate connectors without --consent. Ask the user first.');
  }
  if (!environmentId || !solutionId || !connectors || connectors.length === 0) {
    throw new Error('--environmentId, --solutionId and --connectors are required.');
  }
  const migration = await connectivity.makeConnectorsSolutionAware({
    environmentId, solutionId, connectorNames: connectors, cloud, token, makeRequest,
  });
  const results = [];
  for (const r of migration.results) {
    let after = null;
    try {
      after = await connectivity.getConnector({ environmentId, connectorName: r.connectorName, cloud, token, makeRequest });
    } catch {
      after = null;
    }
    results.push({
      ...r,
      isSolutionAware: !!(after && after.isSolutionAware),
      xrmConnectorId: after ? after.xrmConnectorId : null,
    });
  }
  const ok = results.every((r) => r.isSolutionAware);
  const out = { ok, results };
  if (!ok) {
    out.error = migration.error || null;
    out.fallback = FALLBACK_GUIDANCE;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  const cloud = args.cloud || (helpers.getPacAuthInfo() || {}).cloud || 'Public';
  let token = args.token;
  if (!token) {
    token = helpers.getAuthToken(connectivity.tokenResourceForCloud(cloud));
    if (!token) throw new Error('Failed to acquire a Power Platform API token. Run `az login` or pass --token.');
  }
  const result = await run({ ...args, cloud, token });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  });
}

module.exports = { run, parseArgs, FALLBACK_GUIDANCE };
