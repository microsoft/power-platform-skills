#!/usr/bin/env node

// Verifies the BYOK / CMK (Customer-Managed Key) encryption state of the
// current Power Platform environment as a Phase 2 preflight for the
// `git-configure` skill.
//
// BYOK / CMK is INFORMATIONAL preflight, not a hard gate. When BYOK is
// enabled, copying solution components to ADO (which happens on every
// CommitToGit) may be subject to additional security review by the
// customer's org. The skill surfaces a one-line advisory and lets the user
// proceed.
//
// Signal: `body.properties.protectionStatus.keyManagedBy` from the BAP env
// GET endpoint. POC-verified 2026-06-13 across:
//   • sri-alm-dev-1 (Basic, US, envSku=Production)        → "Microsoft"
//   • prod-sri-pp-alm (Standard / Managed Env, US)         → "Microsoft"
// The originally-hypothesized `body.properties.encryption` field is NEVER
// returned on the BAP env GET across api-versions 2024-05-01, 2021-04-01,
// or with explicit `$expand=properties/encryption` / `$expand=properties/encryption,properties/lockboxConfiguration`.
// `protectionStatus.keyManagedBy` is the canonical signal — values:
//   "Microsoft" → Microsoft-managed keys (default)
//   "Customer"  → Customer-managed keys (BYOK / CMK enabled)
//
// Output (JSON to stdout):
//   {
//     ok:            true | false,             // false on probe failure
//     environmentId: "<guid>" | null,
//     displayName:   "<env display name>" | null,
//     keyManagedBy:  "Microsoft" | "Customer" | "Unknown",
//     byokEnabled:   true | false,             // true iff keyManagedBy === "Customer"
//     hint:          "<advisory string>" | null,
//     checkMethod:   "bap" | "unknown",
//   }
//   On error: { ok: false, error: "<message>", hint: "<degradation hint>" }
//
// Usage:
//   node verify-byok-cmk.js [--envUrl <url>] [--bapToken <token>]
//                           [--environmentId <guid>]
//
// NOTE: The BAP API requires a token scoped to `https://service.powerapps.com/`
// — NOT the Dataverse URL. Pass --bapToken when already in hand; otherwise
// the helper acquires one via the shared `getAuthToken` helper.

'use strict';

const { getAuthToken, getEnvironmentUrl, getPacAuthInfo, makeRequest } = require('./validation-helpers');

const BAP_RESOURCE = 'https://service.powerapps.com/';
// HAR-confirmed via verify-managed-env.js — api.bap.microsoft.com (not api.powerplatform.com).
const BAP_BASE = 'https://api.bap.microsoft.com/providers/Microsoft.BusinessAppPlatform/scopes/admin';
// 2023-06-01 matches verify-managed-env.js for cross-helper consistency. The
// `protectionStatus.keyManagedBy` field is returned at api-version >= 2021-04-01
// (POC-verified 2026-06-13).
const BAP_API_VERSION = '2023-06-01';

const VALID_KEY_MANAGED_BY = Object.freeze(['Microsoft', 'Customer']);

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = { envUrl: null, bapToken: null, environmentId: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--envUrl' && args[i + 1]) out.envUrl = args[++i];
    else if (args[i] === '--bapToken' && args[i + 1]) out.bapToken = args[++i];
    else if (args[i] === '--environmentId' && args[i + 1]) out.environmentId = args[++i];
  }
  return out;
}

/**
 * Build the advisory hint surfaced by the SKILL.md Phase 2 gate.
 *
 * @param {string} keyManagedBy
 * @returns {string|null}
 */
function buildHint(keyManagedBy) {
  if (keyManagedBy === 'Customer') {
    return (
      'Customer-managed encryption (BYOK / CMK) is ENABLED on this environment. ' +
      'Every CommitToGit copies solution components to your Azure DevOps repo — verify ' +
      'with your security / compliance team that this is allowed by org policy before binding.'
    );
  }
  if (keyManagedBy === 'Microsoft') {
    return null;  // No advisory needed for the default state.
  }
  return (
    'Could not determine BYOK / CMK encryption state for this environment ' +
    '(BAP response did not include properties.protectionStatus.keyManagedBy). ' +
    'Proceeding without BYOK preflight — verify with your tenant admin if your ' +
    'org enforces customer-managed encryption.'
  );
}

/**
 * Query BAP for the env's protection status and project it to our schema.
 *
 * @param {string} bapToken
 * @param {string} environmentId
 * @param {string} [bapBase=BAP_BASE]  Test seam — overrides the BAP root URL.
 * @returns {Promise<{ keyManagedBy: string, displayName: string | null } | null>}
 */
async function probeBap(bapToken, environmentId, bapBase = BAP_BASE) {
  const apiUrl = `${bapBase}/environments/${environmentId}?api-version=${BAP_API_VERSION}`;
  const res = await makeRequest({
    url: apiUrl,
    method: 'GET',
    headers: {
      Authorization: `Bearer ${bapToken}`,
      Accept: 'application/json',
    },
  });
  if (res.statusCode !== 200) return null;
  let body;
  try { body = JSON.parse(res.body); } catch { return null; }

  const raw = body?.properties?.protectionStatus?.keyManagedBy;
  // Normalise: any value not in the documented set is treated as "Unknown"
  // (warn-not-block), preserving the raw string under `.raw` for diagnosis.
  const keyManagedBy = VALID_KEY_MANAGED_BY.includes(raw) ? raw : 'Unknown';
  return {
    keyManagedBy,
    displayName: body?.properties?.displayName || null,
    raw: raw === undefined ? null : raw,
  };
}

/**
 * @param {object} [options]
 * @param {string} [options.envUrl]         Dataverse env URL (used only to pick the env's BAP id when --environmentId is omitted).
 * @param {string} [options.bapToken]       BAP-scoped token (https://service.powerapps.com/).
 * @param {string} [options.environmentId]  BAP environment GUID.
 * @param {string} [options.bapBase]        Test seam — overrides the BAP root URL.
 * @returns {Promise<object>}
 */
async function verifyByokCmk({ envUrl, bapToken, environmentId, bapBase } = {}) {
  const envId = environmentId || (getPacAuthInfo() && getPacAuthInfo().environmentId) || null;
  if (!envId) {
    const hint =
      'Could not determine environment ID — sign in via `pac auth create` or pass --environmentId. ' +
      buildHint('Unknown');
    return {
      ok: false,
      environmentId: null,
      displayName: null,
      keyManagedBy: 'Unknown',
      byokEnabled: false,
      hint,
      checkMethod: 'unknown',
      error: 'Missing environment ID.',
    };
  }

  const tok = bapToken || getAuthToken(BAP_RESOURCE);
  if (!tok) {
    return {
      ok: false,
      environmentId: envId,
      displayName: null,
      keyManagedBy: 'Unknown',
      byokEnabled: false,
      hint: buildHint('Unknown'),
      checkMethod: 'unknown',
      error: 'Could not acquire a BAP-scoped token — sign in via `az login` and re-run.',
    };
  }

  let probe;
  try {
    probe = await probeBap(tok, envId, bapBase);
  } catch (e) {
    return {
      ok: false,
      environmentId: envId,
      displayName: null,
      keyManagedBy: 'Unknown',
      byokEnabled: false,
      hint: buildHint('Unknown'),
      checkMethod: 'unknown',
      error: `BAP probe threw: ${e.message}`,
    };
  }

  if (!probe) {
    return {
      ok: false,
      environmentId: envId,
      displayName: null,
      keyManagedBy: 'Unknown',
      byokEnabled: false,
      hint: buildHint('Unknown'),
      checkMethod: 'bap',
      error: 'BAP env GET returned non-200 or unparseable body.',
    };
  }

  // Squelch the touch-but-don't-export envUrl param (kept for parity with
  // sibling verify-* helpers; future versions may use it for a fallback path).
  void envUrl;

  return {
    ok: true,
    environmentId: envId,
    displayName: probe.displayName,
    keyManagedBy: probe.keyManagedBy,
    byokEnabled: probe.keyManagedBy === 'Customer',
    hint: buildHint(probe.keyManagedBy),
    checkMethod: 'bap',
  };
}

if (require.main === module) {
  const args = parseArgs(process.argv);
  const url = args.envUrl || getEnvironmentUrl();
  verifyByokCmk({ envUrl: url, bapToken: args.bapToken, environmentId: args.environmentId })
    .then((r) => { process.stdout.write(JSON.stringify(r, null, 2) + '\n'); })
    .catch((e) => {
      process.stderr.write('verify-byok-cmk: ' + e.message + '\n');
      process.exit(1);
    });
}

module.exports = { verifyByokCmk, BAP_RESOURCE, BAP_API_VERSION, buildHint, probeBap };
