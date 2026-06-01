#!/usr/bin/env node

// PAC-CLI shim for BAP env-list / env-GET. Provides the same data shape as
// resolve-env-by-id.js and list-tenant-envs.js consume from BAP, but sourced
// from `pac admin list --json` instead.
//
// Why this exists: BAP API at api.bap.microsoft.com rejects Az-CLI-acquired
// tokens in some tenants (verified 2026-04-28: D365DemoTSCE53051106 demo
// tenant returns 401 InvalidAuthenticationToken even though token claims show
// the right user/tenant/audience). PAC CLI succeeds because it uses a
// different first-party client ID with implicit BAP grants.
//
// This shim is the read-side fallback: enables our detection scripts to work
// in tenants where Az→BAP fails, and is also a sensible default since PAC is
// the canonical Power Platform CLI everyone has installed.
//
// Mapping (PAC field → BAP field):
//   EnvironmentId        → name
//   DisplayName          → properties.displayName
//   EnvironmentUrl       → properties.linkedEnvironmentMetadata.instanceUrl
//   OrganizationId       → properties.linkedEnvironmentMetadata.resourceId
//   Type                 → properties.environmentSku  (Developer/Production/Sandbox/Default/Trial)
//   DomainName           → properties.linkedEnvironmentMetadata.domainName
//   Version              → properties.linkedEnvironmentMetadata.version
//   <derived from URL>   → properties.linkedEnvironmentMetadata.instanceApiUrl
//
// Fields not provided by PAC (returned as null): tenantId, location,
// lastModifiedTime, permissions, isManaged. Callers must tolerate null in
// those fields (none are critical for host detection).
//
// Usage:
//   const { listEnvsViaPac, resolveEnvByIdViaPac, deriveInstanceApiUrl } = require('./pac-bap-shim');
//   const envs = await listEnvsViaPac();           // BAP-shaped array
//   const env  = await resolveEnvByIdViaPac(id);   // BAP-shaped single env (or null)

'use strict';

const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

// Derives an instanceApiUrl from the EnvironmentUrl PAC reports.
// Examples:
//   https://org5fbe4359.crm5.dynamics.com/   → https://org5fbe4359.api.crm5.dynamics.com
//   https://contoso.crm.dynamics.com/        → https://contoso.api.crm.dynamics.com
//   https://contoso.crm9.dynamics.com        → https://contoso.api.crm9.dynamics.com
function deriveInstanceApiUrl(environmentUrl) {
  if (!environmentUrl) return null;
  // Strip trailing slash
  const clean = environmentUrl.replace(/\/+$/, '');
  // Insert ".api" before ".crm{N?}.dynamics.com"
  // Regex: ^(https?://[^.]+)\.(crm\d*\.dynamics\.com)$ → $1.api.$2
  const match = clean.match(/^(https?:\/\/[^.]+)\.(crm\d*\.dynamics\.com)$/i);
  if (match) {
    return `${match[1]}.api.${match[2]}`;
  }
  // Government clouds and other hosts: pass through unchanged. Caller can
  // override via direct BAP if needed.
  return clean;
}

// Maps PAC sku/type values to BAP environmentSku values. They overlap mostly
// 1:1 but PAC uses "Default" for the per-user default env where BAP uses
// "Default" too — pass through. "Platform" envs are not surfaced by
// `pac admin list` (PE is hidden from PAC), so the shim cannot help with PE
// detection. Callers needing PE must use BAP directly.
function mapPacTypeToSku(pacType) {
  // PAC values seen: Developer, Production, Sandbox, Default, Trial, Teams.
  // BAP values: same set, plus Platform (which PAC won't return).
  return pacType || null;
}

// Converts one PAC env record to a BAP-like env shape (subset).
function pacToBapEnv(pacEnv) {
  if (!pacEnv) return null;
  const url = pacEnv.EnvironmentUrl ? pacEnv.EnvironmentUrl.replace(/\/+$/, '') + '/' : null;
  return {
    name: pacEnv.EnvironmentId || null,
    type: 'Microsoft.BusinessAppPlatform/environments',
    location: null, // not provided by PAC
    properties: {
      displayName: pacEnv.DisplayName || null,
      environmentSku: mapPacTypeToSku(pacEnv.Type),
      tenantId: null,
      lastModifiedTime: null,
      permissions: null,
      linkedEnvironmentMetadata: {
        resourceId: pacEnv.OrganizationId || null,
        instanceUrl: url,
        instanceApiUrl: deriveInstanceApiUrl(pacEnv.EnvironmentUrl),
        domainName: pacEnv.DomainName || null,
        version: pacEnv.Version || null,
      },
    },
  };
}

// Runs `pac admin list --json` and parses the output. Throws on non-zero exit.
async function runPacAdminList(execImpl) {
  const exec = execImpl || execFileAsync;
  let stdout;
  try {
    const res = await exec('pac', ['admin', 'list', '--json'], {
      maxBuffer: 16 * 1024 * 1024,
      shell: false,
    });
    stdout = res.stdout;
  } catch (e) {
    throw new Error(`pac admin list failed: ${e.message}`);
  }

  // PAC may print "Connected as ..." headers + "Listing..." prose before the
  // JSON. Find the first '[' and parse from there. Also tolerates trailing
  // text. PAC's --json on `pac admin list` outputs a single array.
  const jsonStart = stdout.indexOf('[');
  if (jsonStart < 0) {
    throw new Error(`pac admin list returned no JSON array. Output: ${stdout.slice(0, 300)}`);
  }
  const jsonText = stdout.slice(jsonStart);
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (e) {
    throw new Error(`Failed to parse pac admin list JSON: ${e.message}. First 300 chars: ${jsonText.slice(0, 300)}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`pac admin list JSON is not an array: ${typeof parsed}`);
  }
  return parsed;
}

// Returns all envs the current PAC profile has visibility into, in BAP-like
// shape suitable for callers that previously read from BAP env-list.
// `execImpl` is for tests (replaces execFileAsync).
async function listEnvsViaPac({ execImpl } = {}) {
  const pacEnvs = await runPacAdminList(execImpl);
  return pacEnvs.map(pacToBapEnv);
}

// Returns one env in BAP-like shape (or null if not found). Filters the full
// list by EnvironmentId. PAC has no per-env GET command that returns the same
// shape, so this is the cheapest correct approach (single PAC invocation).
async function resolveEnvByIdViaPac({ envId, execImpl } = {}) {
  if (!envId) throw new Error('envId is required');
  const all = await listEnvsViaPac({ execImpl });
  const target = (all.find((e) => (e.name || '').toLowerCase() === String(envId).toLowerCase())) || null;
  return target;
}

// Verifies that PAC CLI is signed in to a profile we can use. Returns
// { ok: bool, error?: string, user?: string }.
async function checkPacAuth(execImpl) {
  const exec = execImpl || execFileAsync;
  try {
    const res = await exec('pac', ['env', 'who'], { maxBuffer: 1024 * 1024, shell: false });
    const out = res.stdout || '';
    // "Connected as <user>" line appears in pac env who output.
    const m = out.match(/Connected as\s+(\S+)/i);
    if (m) return { ok: true, user: m[1].trim() };
    // pac env who succeeded but no "Connected as" — still treat as ok
    return { ok: true, user: null };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

if (require.main === module) {
  // CLI: print BAP-shaped env list as JSON. Useful for ad-hoc debugging.
  listEnvsViaPac()
    .then((envs) => {
      console.log(JSON.stringify(envs, null, 2));
      process.exit(0);
    })
    .catch((err) => {
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    });
}

module.exports = {
  listEnvsViaPac,
  resolveEnvByIdViaPac,
  checkPacAuth,
  deriveInstanceApiUrl,
  mapPacTypeToSku,
  pacToBapEnv,
  runPacAdminList,
};
