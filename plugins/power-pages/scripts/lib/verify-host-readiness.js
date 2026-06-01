#!/usr/bin/env node

// Verifies a Pipelines host environment is reachable, has the Pipelines solution
// installed, and the calling user is auth'd against it. Used by Phase 1.0 (cache
// fast-path) and Phase 5 (final verification) of ensure-pipelines-host. Also used
// by list-tenant-envs.js as the per-env presence + version probe.
//
// Probe sequence:
//   1. WhoAmI on host instanceApiUrl — proves auth + triggers JIT for PE-detection case.
//   2. solutions?$filter=uniquename eq 'msdyn_AppDeploymentAnchor' — proves Pipelines
//      solution is installed AND captures version in one call. ($top=0 on
//      deploymentpipelines is rejected by Dataverse with HTTP 400.)
//
// Usage: node verify-host-readiness.js --hostEnvUrl <url> --hostToken <token>
//                                       [--skipWhoAmI] [--minPipelinesVersion <semver>]
//
// Output (JSON to stdout):
//   {
//     ready: bool,
//     pipelinesSolutionVersion: "9.x.y.z" | null,
//     checks: { whoami: { ok, userId? }, solutions: { ok, found, version? } },
//     warnings: [string]
//   }
//
// Exit 0 always — caller inspects `ready`. Exit 1 only on transport error / arg error.

'use strict';

const helpers = require('./validation-helpers');

const PIPELINES_SOLUTION_UNIQUE_NAME = 'msdyn_AppDeploymentAnchor';

function parseArgs(argv) {
  const args = argv.slice(2);
  let hostEnvUrl = null;
  let hostToken = null;
  let skipWhoAmI = false;
  let minPipelinesVersion = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--hostEnvUrl' && args[i + 1]) hostEnvUrl = args[++i];
    else if (args[i] === '--hostToken' && args[i + 1]) hostToken = args[++i];
    else if (args[i] === '--skipWhoAmI') skipWhoAmI = true;
    else if (args[i] === '--minPipelinesVersion' && args[i + 1]) minPipelinesVersion = args[++i];
  }

  return { hostEnvUrl, hostToken, skipWhoAmI, minPipelinesVersion };
}

// Compares two version strings of the form "9.1.2026034.260325188" component-by-component.
// Returns -1 if a<b, 0 if equal, 1 if a>b. Missing/non-numeric components treated as 0.
function compareVersions(a, b) {
  if (!a && !b) return 0;
  if (!a) return -1;
  if (!b) return 1;
  const parseN = (v) => String(v).split('.').map((p) => Number(p) || 0);
  const aa = parseN(a);
  const bb = parseN(b);
  const len = Math.max(aa.length, bb.length);
  for (let i = 0; i < len; i++) {
    const av = aa[i] || 0;
    const bv = bb[i] || 0;
    if (av < bv) return -1;
    if (av > bv) return 1;
  }
  return 0;
}

async function verifyHostReadiness({ hostEnvUrl, hostToken, skipWhoAmI = false, minPipelinesVersion = null } = {}) {
  if (!hostEnvUrl) throw new Error('--hostEnvUrl is required');
  if (!hostToken) throw new Error('--hostToken is required');

  const cleanUrl = hostEnvUrl.replace(/\/+$/, '');
  const warnings = [];
  const checks = { whoami: { ok: false }, solutions: { ok: false, found: false } };

  // Check 1 — WhoAmI (proves auth + JIT)
  if (!skipWhoAmI) {
    const whoamiRes = await helpers.makeRequest({
      url: `${cleanUrl}/api/data/v9.0/WhoAmI`,
      method: 'GET',
      headers: {
        Authorization: `Bearer ${hostToken}`,
        Accept: 'application/json',
        'OData-Version': '4.0',
        'OData-MaxVersion': '4.0',
      },
      timeout: 15000,
    });

    if (whoamiRes.error) {
      checks.whoami.ok = false;
      checks.whoami.error = whoamiRes.error;
    } else if (whoamiRes.statusCode === 200) {
      try {
        const data = JSON.parse(whoamiRes.body);
        checks.whoami.ok = true;
        checks.whoami.userId = data.UserId || null;
      } catch (e) {
        checks.whoami.ok = false;
        checks.whoami.error = `Failed to parse WhoAmI response: ${e.message}`;
      }
    } else {
      checks.whoami.ok = false;
      checks.whoami.statusCode = whoamiRes.statusCode;
      checks.whoami.error = `WhoAmI returned ${whoamiRes.statusCode}: ${whoamiRes.body.slice(0, 200)}`;
    }
  } else {
    checks.whoami.ok = true;
    checks.whoami.skipped = true;
  }

  // Check 2 — Pipelines solution presence + version (single combined query)
  const solUrl = `${cleanUrl}/api/data/v9.0/solutions?$filter=${encodeURIComponent(`uniquename eq '${PIPELINES_SOLUTION_UNIQUE_NAME}'`)}&$select=uniquename,version&$top=1`;
  const solRes = await helpers.makeRequest({
    url: solUrl,
    method: 'GET',
    headers: {
      Authorization: `Bearer ${hostToken}`,
      Accept: 'application/json',
      'OData-Version': '4.0',
      'OData-MaxVersion': '4.0',
    },
    timeout: 15000,
  });

  let pipelinesSolutionVersion = null;

  if (solRes.error) {
    checks.solutions.ok = false;
    checks.solutions.error = solRes.error;
  } else if (solRes.statusCode === 200) {
    try {
      const data = JSON.parse(solRes.body);
      const found = Array.isArray(data.value) && data.value.length === 1;
      checks.solutions.ok = true;
      checks.solutions.found = found;
      if (found) {
        pipelinesSolutionVersion = data.value[0].version || null;
        checks.solutions.version = pipelinesSolutionVersion;
      }
    } catch (e) {
      checks.solutions.ok = false;
      checks.solutions.error = `Failed to parse solutions response: ${e.message}`;
    }
  } else if (solRes.statusCode === 404) {
    // Env exists but no Dataverse / wrong URL.
    checks.solutions.ok = false;
    checks.solutions.statusCode = 404;
    checks.solutions.error = 'solutions endpoint returned 404 — env may not have Dataverse';
  } else {
    checks.solutions.ok = false;
    checks.solutions.statusCode = solRes.statusCode;
    checks.solutions.error = `solutions query returned ${solRes.statusCode}: ${solRes.body.slice(0, 200)}`;
  }

  if (minPipelinesVersion && pipelinesSolutionVersion) {
    if (compareVersions(pipelinesSolutionVersion, minPipelinesVersion) < 0) {
      warnings.push(
        `Pipelines solution version ${pipelinesSolutionVersion} is below recommended minimum ${minPipelinesVersion} — some features (e.g. RetrieveDeploymentPipelineInfo) may be unavailable.`,
      );
    }
  }

  const ready = checks.whoami.ok && checks.solutions.ok && checks.solutions.found === true;

  return {
    ready,
    pipelinesSolutionVersion,
    checks,
    warnings,
  };
}

if (require.main === module) {
  const { hostEnvUrl, hostToken, skipWhoAmI, minPipelinesVersion } = parseArgs(process.argv);

  verifyHostReadiness({ hostEnvUrl, hostToken, skipWhoAmI, minPipelinesVersion })
    .then((result) => {
      console.log(JSON.stringify(result));
      process.exit(0);
    })
    .catch((err) => {
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    });
}

module.exports = { verifyHostReadiness, compareVersions, PIPELINES_SOLUTION_UNIQUE_NAME };
