#!/usr/bin/env node

// Verifies that Git integration is licensed / installed on the current
// Power Platform environment as a Phase 2 preflight for the `git-configure`
// skill.
//
// Git integration availability is licensed at the tenant level and rolls
// out per-region. On envs where it is NOT available, ConnectToGit returns
// 404 / RouteNotFound and the entire skill cannot proceed. Detecting this
// up-front saves the user from a 5-minute cascade of failures.
//
// Signal: Probe `GET <envUrl>/api/data/v9.2/sourcecontrolconfigurations?$top=1`.
// POC-verified 2026-06-13 against sri-alm-dev-1 (Basic) and prod-sri-pp-alm
// (Standard / Managed Env). Both envs have working Git integration and
// returned HTTP 200 with 1 row. The originally-hypothesized signal
// (`msdyn_AppDeploymentAnchor` solution presence) is the **Pipelines**
// license proxy — NOT the Git-integration proxy — and was found absent on
// both envs despite Git integration being actively used. The
// `sourcecontrolcomponent` and `sourcecontrolcomponentpayload` entities
// return 404 on these tenants but DO have working Git integration (per
// `references/inner-loop-empirical-findings.md` §2) — so we MUST NOT use
// those entities as the probe, only `sourcecontrolconfigurations`.
//
// Output (JSON to stdout):
//   {
//     ok:                       true | false,    // false on probe failure
//     envUrl:                   "<url>",
//     gitIntegrationAvailable:  true | false,
//     statusCode:               <int>,
//     hint:                     "<advisory string>" | null,
//     checkMethod:              "sourcecontrolconfigurations" | "unknown",
//   }
//   On error: { ok: false, error: "<message>", hint: "<degradation hint>" }
//
// Usage:
//   node verify-license.js [--envUrl <url>] [--token <dataverse-token>]

'use strict';

const { getAuthToken, getEnvironmentUrl, makeRequest } = require('./validation-helpers');

// Per POC findings: the only reliable Git-integration availability signal
// is whether `sourcecontrolconfigurations` returns HTTP 200 vs 404. Do NOT
// probe sourcecontrolcomponent / sourcecontrolcomponentpayload — those
// return 404 on tenants where Git integration IS installed (per-tenant
// entity-shape variation, see inner-loop-empirical-findings §2).
const PROBE_ENTITY = 'sourcecontrolconfigurations';

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = { envUrl: null, token: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--envUrl' && args[i + 1]) out.envUrl = args[++i];
    else if (args[i] === '--token' && args[i + 1]) out.token = args[++i];
  }
  return out;
}

/**
 * Build the advisory hint surfaced by the SKILL.md Phase 2 gate.
 *
 * @param {boolean} available
 * @param {number}  statusCode
 * @returns {string|null}
 */
function buildHint(available, statusCode) {
  if (available) return null;
  if (statusCode === 404) {
    return (
      'Git integration is NOT available on this environment ' +
      '(sourcecontrolconfigurations entity returned HTTP 404). The most common ' +
      'cause is a regional rollout gap or a tenant-level feature toggle. ' +
      'Contact your tenant admin to enable Git integration before re-running git-configure.'
    );
  }
  return (
    `Could not verify Git-integration availability ` +
    `(${PROBE_ENTITY} returned HTTP ${statusCode}). Proceeding without ` +
    `license preflight — re-run with verbose logging if ConnectToGit fails ` +
    `later in the skill.`
  );
}

/**
 * Probe Dataverse for the sourcecontrolconfigurations entity. Returns the
 * statusCode so the caller can distinguish 404 (not licensed) from 401 / 5xx
 * (transient / auth) and degrade gracefully.
 *
 * @param {string} tok    Dataverse-scoped bearer token.
 * @param {string} envUrl
 * @returns {Promise<{ statusCode: number, available: boolean }>}
 */
async function probeDataverse(tok, envUrl) {
  const base = envUrl.replace(/\/+$/, '');
  const apiUrl = `${base}/api/data/v9.2/${PROBE_ENTITY}?$top=1`;
  const res = await makeRequest({
    url: apiUrl,
    method: 'GET',
    headers: {
      Authorization: `Bearer ${tok}`,
      'OData-MaxVersion': '4.0',
      'OData-Version': '4.0',
      Accept: 'application/json',
    },
  });
  return {
    statusCode: res.statusCode,
    available: res.statusCode === 200,
  };
}

/**
 * @param {object} [options]
 * @param {string} [options.envUrl]
 * @param {string} [options.token]   Dataverse-scoped token.
 * @returns {Promise<object>}
 */
async function verifyLicense({ envUrl, token } = {}) {
  const url = envUrl || getEnvironmentUrl();
  if (!url) {
    return {
      ok: false,
      envUrl: null,
      gitIntegrationAvailable: false,
      statusCode: 0,
      hint:
        'Could not determine environment URL — sign in via `pac auth create` ' +
        'or pass --envUrl. Proceeding without Git-integration preflight.',
      checkMethod: 'unknown',
      error: 'Missing environment URL.',
    };
  }

  const tok = token || getAuthToken(url);
  if (!tok) {
    return {
      ok: false,
      envUrl: url,
      gitIntegrationAvailable: false,
      statusCode: 0,
      hint:
        'Could not acquire a Dataverse-scoped token — sign in via `az login` and re-run.',
      checkMethod: 'unknown',
      error: 'Missing Dataverse token.',
    };
  }

  let probe;
  try {
    probe = await probeDataverse(tok, url);
  } catch (e) {
    return {
      ok: false,
      envUrl: url,
      gitIntegrationAvailable: false,
      statusCode: 0,
      hint: buildHint(false, 0),
      checkMethod: 'sourcecontrolconfigurations',
      error: `Dataverse probe threw: ${e.message}`,
    };
  }

  return {
    ok: probe.available || probe.statusCode === 404,
    envUrl: url,
    gitIntegrationAvailable: probe.available,
    statusCode: probe.statusCode,
    hint: buildHint(probe.available, probe.statusCode),
    checkMethod: 'sourcecontrolconfigurations',
  };
}

if (require.main === module) {
  const args = parseArgs(process.argv);
  verifyLicense(args)
    .then((r) => { process.stdout.write(JSON.stringify(r, null, 2) + '\n'); })
    .catch((e) => {
      process.stderr.write('verify-license: ' + e.message + '\n');
      process.exit(1);
    });
}

module.exports = { verifyLicense, PROBE_ENTITY, buildHint };
