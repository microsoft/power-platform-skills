#!/usr/bin/env node

// Lists all BAP environments in the calling user's tenant, then per-env probes
// each candidate for Pipelines-solution presence. Used by Phase 2.5 of
// ensure-pipelines-host (the tenant-wide enumeration that disambiguates "no host
// bound to source env" vs "host exists but unbound").
//
// Pre-filter (avoids probing every env in large tenants):
//   - skip envs without Dataverse (linkedEnvironmentMetadata.instanceApiUrl == null)
//   - skip envs not in --skus (default: Production; PE always included regardless)
//   - sort remaining by lastModifiedTime desc
//   - cap at --maxEnvsToProbe (default 50)
//
// Per-env probe (single Dataverse query — covers presence + version in one call):
//   GET {instanceApiUrl}/api/data/v9.0/solutions?$filter=uniquename eq 'msdyn_AppDeploymentAnchor'&$select=version&$top=1
//
// Classification:
//   - environmentSku === 'Platform' AND Pipelines found → existingPlatformHost (one expected)
//   - other sku AND Pipelines found                     → existingCustomHosts[]
//   - has Dataverse, no Pipelines, accessible           → eligibleForAppInstall[]
//   - 401/403 from probe                                → inaccessibleEnvs[]
//   - timeout / 5xx                                     → inaccessibleEnvs[]
//
// Token acquisition: per-env Dataverse tokens via Azure CLI. The script invokes
// `az account get-access-token --resource <origin>` for each env in parallel
// (bounded by --maxConcurrency) — cheap when the user is already signed in.
//
// Usage:
//   node list-tenant-envs.js --bapToken <token>
//                             [--skus Production,Sandbox]
//                             [--maxEnvsToProbe 50]
//                             [--maxConcurrency 10]
//                             [--probeTimeoutMs 5000]
//                             [--apiVersion 2020-06-01]
//                             [--bapBase https://api.bap.microsoft.com]
//
// Output (JSON to stdout): see module docstring at the bottom.

'use strict';

const { execSync } = require('child_process');
const helpers = require('./validation-helpers');
const { verifyHostReadiness } = require('./verify-host-readiness');
const { listEnvsViaPac } = require('./pac-bap-shim');

const DEFAULT_API_VERSION = '2020-06-01';
const DEFAULT_BAP_BASE = 'https://api.bap.microsoft.com';
const DEFAULT_SKUS = ['Production'];
const DEFAULT_MAX_ENVS = 30;
const DEFAULT_CONCURRENCY = 10;
const DEFAULT_PROBE_TIMEOUT_MS = 5000;

// Name-hint patterns. Envs whose displayName or domainName contain these tokens
// are ranked first — Pipelines hosts are commonly named with these conventions.
const NAME_HINT_PATTERN = /\b(pipeline|deploy|host|alm|cicd|govern)/i;

// Permissions strength — envs where the caller is an env admin probe earlier.
// Most Microsoft tenants give every user `ReadEnvironment` on every env, so that
// signal is uninformative; admin-class permissions are the discriminator.
const ADMIN_PERMS = new Set(['ListDatabaseEntities', 'CreateDatabaseEntities', 'ManageDatabaseUsers', 'AdminReadEnvironment', 'CreateBot', 'CreatePowerApp']);

function parseArgs(argv) {
  const args = argv.slice(2);
  let bapToken = null;
  let skus = null;
  let maxEnvsToProbe = DEFAULT_MAX_ENVS;
  let maxConcurrency = DEFAULT_CONCURRENCY;
  let probeTimeoutMs = DEFAULT_PROBE_TIMEOUT_MS;
  let apiVersion = DEFAULT_API_VERSION;
  let bapBase = DEFAULT_BAP_BASE;
  let firstHitWins = false;

  let includeName = null;
  let source = 'auto'; // auto | bap | pac

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--bapToken' && args[i + 1]) bapToken = args[++i];
    else if (args[i] === '--skus' && args[i + 1]) skus = args[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (args[i] === '--maxEnvsToProbe' && args[i + 1]) maxEnvsToProbe = Number(args[++i]) || DEFAULT_MAX_ENVS;
    else if (args[i] === '--maxConcurrency' && args[i + 1]) maxConcurrency = Number(args[++i]) || DEFAULT_CONCURRENCY;
    else if (args[i] === '--probeTimeoutMs' && args[i + 1]) probeTimeoutMs = Number(args[++i]) || DEFAULT_PROBE_TIMEOUT_MS;
    else if (args[i] === '--apiVersion' && args[i + 1]) apiVersion = args[++i];
    else if (args[i] === '--bapBase' && args[i + 1]) bapBase = args[++i];
    else if (args[i] === '--firstHitWins') firstHitWins = true;
    else if (args[i] === '--includeName' && args[i + 1]) includeName = args[++i];
    else if (args[i] === '--source' && args[i + 1]) source = args[++i];
  }

  if (!skus) skus = DEFAULT_SKUS;
  return { bapToken, skus, maxEnvsToProbe, maxConcurrency, probeTimeoutMs, apiVersion, bapBase, firstHitWins, includeName, source };
}

async function listBapEnvs(bapToken, apiVersion, bapBase) {
  if (!bapToken) throw new Error('BAP token required for source=bap');
  const cleanBase = bapBase.replace(/\/+$/, '');
  const url = `${cleanBase}/providers/Microsoft.BusinessAppPlatform/environments?api-version=${encodeURIComponent(apiVersion)}&$expand=${encodeURIComponent('properties.linkedEnvironmentMetadata,properties.permissions')}`;

  const res = await helpers.makeRequest({
    url,
    method: 'GET',
    headers: { Authorization: `Bearer ${bapToken}`, Accept: 'application/json' },
    timeout: 30000,
  });

  if (res.error) {
    const err = new Error(`BAP env-list failed: ${res.error}`);
    err.statusCode = null;
    throw err;
  }
  if (res.statusCode !== 200) {
    const err = new Error(`BAP env-list returned ${res.statusCode}: ${res.body.slice(0, 300)}`);
    err.statusCode = res.statusCode;
    throw err;
  }

  let data;
  try { data = JSON.parse(res.body); } catch (e) {
    throw new Error(`Failed to parse BAP env-list response: ${e.message}`);
  }
  return Array.isArray(data.value) ? data.value : [];
}

// Picks the right env-list source: BAP HTTP, PAC CLI shim, or auto-detect.
// Returns { envs, sourceUsed, fallbackReason? }.
async function listEnvsBySource({ source, bapToken, apiVersion, bapBase, listImpl, pacExecImpl }) {
  // listImpl is the test-injection point (from BAP path). When provided, we
  // honor it as a "BAP-source mock" since most existing tests use it that way.
  if (listImpl) {
    return { envs: await listImpl({ bapToken, apiVersion, bapBase }), sourceUsed: 'bap-mock' };
  }

  if (source === 'pac') {
    const envs = await listEnvsViaPac({ execImpl: pacExecImpl });
    return { envs, sourceUsed: 'pac' };
  }

  if (source === 'bap') {
    const envs = await listBapEnvs(bapToken, apiVersion, bapBase);
    return { envs, sourceUsed: 'bap' };
  }

  // auto: try BAP first if a token is available, else PAC
  if (!bapToken) {
    const envs = await listEnvsViaPac({ execImpl: pacExecImpl });
    return { envs, sourceUsed: 'pac', fallbackReason: 'no-bap-token-provided' };
  }
  try {
    const envs = await listBapEnvs(bapToken, apiVersion, bapBase);
    return { envs, sourceUsed: 'bap' };
  } catch (e) {
    // 401/403/auth errors → fallback to PAC. Other errors (network, parse) bubble up.
    const sc = e.statusCode;
    if (sc === 401 || sc === 403) {
      try {
        const envs = await listEnvsViaPac({ execImpl: pacExecImpl });
        return { envs, sourceUsed: 'pac', fallbackReason: `bap-rejected-${sc}` };
      } catch (pacErr) {
        // Both failed — surface BAP error which is more diagnostic
        throw e;
      }
    }
    throw e;
  }
}

function getDataverseToken(originUrl, getTokenImpl) {
  // Pluggable for tests. Default impl shells out to `az`.
  if (typeof getTokenImpl === 'function') return getTokenImpl(originUrl);
  try {
    const out = execSync(`az account get-access-token --resource "${originUrl}" --query accessToken -o tsv`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return out.trim();
  } catch (e) {
    throw new Error(`az token acquisition failed for ${originUrl}: ${e.message || e.stderr?.toString() || 'unknown'}`);
  }
}

// Extracts the origin (scheme + host) from a full URL.
function originOf(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

// Computes a heuristic rank score per env. Higher = probe earlier.
// The score combines three signals (each ~0–1, summed):
//   - nameHint: displayName/domainName matches "pipeline|deploy|host|alm|cicd|govern" → +1.0
//   - hasAdminPerms: caller has any admin-class permission on the env → +0.5
//   - recency: lastModifiedTime sort tiebreaker → up to +0.25 across the list
// Recency is normalized to a small fraction so it's a tiebreaker only.
function computeRankScore(env, recencyRank, totalRanked) {
  const text = `${env.displayName || ''} ${env.domainName || ''}`;
  const nameHit = NAME_HINT_PATTERN.test(text) ? 1.0 : 0;
  const hasAdminPerms = (env._permKeys || []).some((k) => ADMIN_PERMS.has(k)) ? 0.5 : 0;
  const recency = totalRanked > 1 ? (1 - recencyRank / Math.max(1, totalRanked - 1)) * 0.25 : 0;
  return nameHit + hasAdminPerms + recency;
}

// Pre-filter and rank envs from the BAP list.
// Returns { candidates, totalEnvsInTenant, envsAfterFilter }.
function preFilter(envs, allowedSkus, includeNameSubstring = null) {
  const skuSet = new Set(allowedSkus);
  // PE always included regardless of --skus filter.
  skuSet.add('Platform');

  const includeNameLower = includeNameSubstring ? String(includeNameSubstring).toLowerCase() : null;

  const filtered = [];
  for (const env of envs) {
    const props = env.properties || {};
    const linked = props.linkedEnvironmentMetadata || {};
    if (!linked.instanceApiUrl) continue; // No Dataverse → cannot host Pipelines.
    if (!skuSet.has(props.environmentSku)) continue;

    // Hard name filter — only envs whose displayName / domainName contain the
    // user-supplied substring are considered. Useful in large tenants when the
    // user knows part of their host's name. Case-insensitive.
    if (includeNameLower) {
      const hay = `${props.displayName || ''} ${linked.domainName || ''}`.toLowerCase();
      if (!hay.includes(includeNameLower)) continue;
    }

    const permKeys = props.permissions ? Object.keys(props.permissions) : [];
    filtered.push({
      envId: env.name || null,
      displayName: props.displayName || null,
      environmentSku: props.environmentSku || null,
      instanceUrl: linked.instanceUrl || null,
      instanceApiUrl: linked.instanceApiUrl,
      isManaged: !!linked.isManaged,
      domainName: linked.domainName || null,
      lastModifiedTime: props.lastModifiedTime || null,
      tenantId: props.tenantId || null,
      _permKeys: permKeys,
    });
  }

  // Compute recency rank first.
  const byRecency = [...filtered].sort((a, b) => {
    const ta = Date.parse(a.lastModifiedTime || '1970-01-01') || 0;
    const tb = Date.parse(b.lastModifiedTime || '1970-01-01') || 0;
    return tb - ta;
  });
  const recencyRank = new Map(byRecency.map((e, i) => [e.envId, i]));

  // Sort by composite score desc. Stable on env ID for determinism.
  filtered.sort((a, b) => {
    const sa = computeRankScore(a, recencyRank.get(a.envId) || 0, filtered.length);
    const sb = computeRankScore(b, recencyRank.get(b.envId) || 0, filtered.length);
    if (sb !== sa) return sb - sa;
    return (a.envId || '').localeCompare(b.envId || '');
  });

  // Strip internal helper field before returning.
  const candidates = filtered.map(({ _permKeys, ...rest }) => rest);
  return { candidates, totalEnvsInTenant: envs.length, envsAfterFilter: candidates.length };
}

async function probeOne(env, { probeTimeoutMs, getTokenImpl, verifyImpl }) {
  const origin = originOf(env.instanceApiUrl);
  if (!origin) {
    return { envId: env.envId, classification: 'inaccessible', reason: 'invalid-instance-api-url' };
  }

  let token;
  try { token = getDataverseToken(origin, getTokenImpl); }
  catch (e) {
    return { envId: env.envId, classification: 'inaccessible', reason: 'token-acquisition-failed', detail: e.message };
  }

  const verify = verifyImpl || verifyHostReadiness;
  const result = await verify({
    hostEnvUrl: env.instanceApiUrl,
    hostToken: token,
    skipWhoAmI: true, // for bulk probing, the solutions query alone is the signal
  });

  // Sanity: verify-host-readiness exits 0 always; we get a result object.
  // Map to classification.
  if (!result.checks?.solutions?.ok) {
    const code = result.checks?.solutions?.statusCode;
    if (code === 401 || code === 403) {
      return { envId: env.envId, classification: 'inaccessible', reason: 'forbidden', statusCode: code };
    }
    if (code === 404) {
      // No Dataverse / wrong URL — not a candidate, but not an error.
      return { envId: env.envId, classification: 'not-eligible', reason: '404-on-solutions' };
    }
    return { envId: env.envId, classification: 'inaccessible', reason: result.checks?.solutions?.error || 'probe-failed' };
  }

  if (result.checks.solutions.found) {
    if (env.environmentSku === 'Platform') {
      return { envId: env.envId, classification: 'platform-host', pipelinesSolutionVersion: result.pipelinesSolutionVersion };
    }
    return { envId: env.envId, classification: 'custom-host', pipelinesSolutionVersion: result.pipelinesSolutionVersion };
  }

  // Has Dataverse, no Pipelines installed.
  return { envId: env.envId, classification: 'eligible-for-app-install' };
}

// Concurrency pool with optional early-cancel. The cancel signal ({stopped: true})
// lets workers exit cleanly when --firstHitWins fires.
async function runWithCancel(items, fn, concurrency) {
  const results = new Array(items.length);
  const ctl = { stopped: false };
  let cursor = 0;
  async function worker() {
    while (!ctl.stopped) {
      const i = cursor++;
      if (i >= items.length) return;
      try { results[i] = await fn(items[i], i, ctl); }
      catch (e) { results[i] = { _error: e.message }; }
    }
  }
  const n = Math.min(Math.max(concurrency, 1), items.length);
  if (n === 0) return { results, stopped: false };
  await Promise.all(Array.from({ length: n }, () => worker()));
  return { results, stopped: ctl.stopped };
}

async function listTenantEnvs(opts = {}) {
  const {
    bapToken,
    skus = DEFAULT_SKUS,
    maxEnvsToProbe = DEFAULT_MAX_ENVS,
    maxConcurrency = DEFAULT_CONCURRENCY,
    probeTimeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
    apiVersion = DEFAULT_API_VERSION,
    bapBase = DEFAULT_BAP_BASE,
    firstHitWins = false,
    includeName = null,
    source = 'auto',
    // Test injection points:
    listImpl = null,    // ({ bapToken, apiVersion, bapBase }) => Promise<envs>  (BAP-source mock)
    getTokenImpl = null,
    verifyImpl = null,
    pacExecImpl = null, // PAC-source mock (replaces execFile)
  } = opts;

  if (source === 'bap' && !bapToken && !listImpl) {
    throw new Error('--bapToken is required when --source bap');
  }

  const startedAt = Date.now();

  const { envs, sourceUsed, fallbackReason } = await listEnvsBySource({
    source,
    bapToken,
    apiVersion,
    bapBase,
    listImpl,
    pacExecImpl,
  });

  const { candidates, totalEnvsInTenant, envsAfterFilter } = preFilter(envs, skus, includeName);

  const toProbe = candidates.slice(0, maxEnvsToProbe);
  const hitProbeCap = candidates.length > maxEnvsToProbe;

  const { results: probeResults, stopped: earlyExit } = await runWithCancel(
    toProbe,
    async (env, i, ctl) => {
      const r = await probeOne(env, { probeTimeoutMs, getTokenImpl, verifyImpl });
      if (firstHitWins && (r.classification === 'custom-host' || r.classification === 'platform-host')) {
        ctl.stopped = true;
      }
      return r;
    },
    maxConcurrency,
  );

  const out = {
    existingCustomHosts: [],
    existingPlatformHost: null,
    eligibleForAppInstall: [],
    inaccessibleEnvs: [],
    inaccessibilityBreakdown: { 'token-acquisition-failed': 0, 'forbidden': 0, '404-on-solutions': 0, 'unknown': 0 },
    totalEnvsInTenant,
    envsAfterFilter,
    envsProbed: toProbe.length,
    earlyExitOnFirstHit: earlyExit,
    hitProbeCap,
    probeDurationMs: Date.now() - startedAt,
    skusFilter: skus,
    firstHitWins,
    includeNameFilter: includeName || null,
    sourceUsed,
    fallbackReason: fallbackReason || null,
  };

  for (let i = 0; i < toProbe.length; i++) {
    const env = toProbe[i];
    const r = probeResults[i] || {};
    const base = {
      envId: env.envId,
      displayName: env.displayName,
      environmentSku: env.environmentSku,
      instanceUrl: env.instanceUrl,
      instanceApiUrl: env.instanceApiUrl,
      isManaged: env.isManaged,
      domainName: env.domainName,
    };

    if (r.classification === 'platform-host') {
      out.existingPlatformHost = { ...base, pipelinesSolutionVersion: r.pipelinesSolutionVersion };
    } else if (r.classification === 'custom-host') {
      out.existingCustomHosts.push({ ...base, pipelinesSolutionVersion: r.pipelinesSolutionVersion });
    } else if (r.classification === 'eligible-for-app-install') {
      out.eligibleForAppInstall.push(base);
    } else if (r.classification === 'not-eligible') {
      // Not counted as inaccessible — env exists but isn't a host candidate.
    } else {
      out.inaccessibleEnvs.push({ ...base, reason: r.reason || 'unknown', detail: r.detail });
      const k = r.reason && out.inaccessibilityBreakdown[r.reason] !== undefined ? r.reason : 'unknown';
      out.inaccessibilityBreakdown[k]++;
    }
  }

  // Squash empty breakdown keys for compactness.
  for (const k of Object.keys(out.inaccessibilityBreakdown)) {
    if (out.inaccessibilityBreakdown[k] === 0) delete out.inaccessibilityBreakdown[k];
  }

  return out;
}

if (require.main === module) {
  const opts = parseArgs(process.argv);
  listTenantEnvs(opts)
    .then((result) => {
      const foundAny = result.existingCustomHosts.length > 0 || !!result.existingPlatformHost;
      if (!foundAny && result.hitProbeCap) {
        process.stderr.write(
          `[hint] Probed ${result.envsProbed} of ${result.envsAfterFilter} envs after filtering (cap reached). No host found among them. ` +
          `Pass --maxEnvsToProbe ${result.envsAfterFilter} to scan all, or --includeName "<substring>" to narrow by name.\n`,
        );
      }
      console.log(JSON.stringify(result));
      process.exit(0);
    })
    .catch((err) => {
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    });
}

module.exports = { listTenantEnvs, preFilter, originOf };
