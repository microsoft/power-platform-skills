#!/usr/bin/env node

// Detection-only wrapper around the ensure-pipelines-host workflow.
// Runs Phases 1.0 (cache fast-path) + 2 (resolution order: org-setting → BAP env GET
// → tenant default custom → tenant-wide enumeration) + 5 (verify if host found).
// NEVER enters Phase 3 (decision tree) or Phase 4 (provisioning). Always exits with
// actionTaken: "none". Used by plan-alm Phase 1 step 12 and other orchestrators that
// want to inspect host state without inviting user prompts.
//
// Resolution order (mirrors ProjectHostProvider.tsx):
//   1. Check .last-host-check.json cache → probe finalHostEnvUrl → reuse if reachable.
//   2. GetOrgDbOrgSetting('ProjectHostEnvironmentId') on source env.
//      - If bound → BAP env GET to resolve URL/sku.
//        - If sku === 'Platform' → check tenant default custom host (discover-pipelines-host).
//          - default !== orgSettingHostEnvId → CannotRedirect.
//          - else → AvailableUsing(PlatformHost|CustomHostByAdminDefault).
//        - else → AvailableUsingCustomHost.
//   3. If unbound → tenant-wide list-tenant-envs with --firstHitWins.
//      - 1 custom host found → AvailableUnboundCustomHost.
//      - >1 → MultipleUnboundCustomHosts.
//      - 0 + PE found → PlatformHostExistsUnbound.
//      - none → NoHost.
//   4. Verify host (verify-host-readiness) if any final URL is set.
//
// Usage:
//   node ensure-pipelines-host-detect.js
//     --envUrl <url> --token <dvToken> --userId <guid>
//     --bapToken <bapToken>
//     [--projectRoot <path>] [--cacheMaxAgeHours 24] [--no-cache]
//     [--includeName <substring>] [--maxEnvsToProbe N] [--skus Production,Sandbox]
//     [--minPipelinesVersion 9.0.0.0]
//
// Output (JSON to stdout): matches .last-host-check.json schemaVersion 2.

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const helpers = require('./validation-helpers');
const { checkEnvHostBinding } = require('./check-env-host-binding');
const { resolveEnvById } = require('./resolve-env-by-id');
const { discoverPipelinesHost } = require('./discover-pipelines-host');
const { listTenantEnvs } = require('./list-tenant-envs');
const { verifyHostReadiness } = require('./verify-host-readiness');

const DEFAULT_CACHE_MAX_AGE_HOURS = 24;

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = {
    envUrl: null,
    token: null,
    userId: null,
    bapToken: null,
    projectRoot: process.cwd(),
    cacheMaxAgeHours: DEFAULT_CACHE_MAX_AGE_HOURS,
    noCache: false,
    includeName: null,
    maxEnvsToProbe: null,
    skus: null,
    minPipelinesVersion: null,
    source: 'auto',
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const next = args[i + 1];
    if (a === '--envUrl' && next) opts.envUrl = args[++i];
    else if (a === '--token' && next) opts.token = args[++i];
    else if (a === '--userId' && next) opts.userId = args[++i];
    else if (a === '--bapToken' && next) opts.bapToken = args[++i];
    else if (a === '--projectRoot' && next) opts.projectRoot = args[++i];
    else if (a === '--cacheMaxAgeHours' && next) opts.cacheMaxAgeHours = Number(args[++i]) || DEFAULT_CACHE_MAX_AGE_HOURS;
    else if (a === '--no-cache') opts.noCache = true;
    else if (a === '--includeName' && next) opts.includeName = args[++i];
    else if (a === '--maxEnvsToProbe' && next) opts.maxEnvsToProbe = Number(args[++i]);
    else if (a === '--skus' && next) opts.skus = args[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--minPipelinesVersion' && next) opts.minPipelinesVersion = args[++i];
    else if (a === '--source' && next) opts.source = args[++i];
  }
  return opts;
}

function originOf(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

function getDataverseToken(originUrl, getTokenImpl) {
  if (typeof getTokenImpl === 'function') return getTokenImpl(originUrl);
  try {
    return execSync(`az account get-access-token --resource "${originUrl}" --query accessToken -o tsv`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (e) {
    throw new Error(`az token acquisition failed for ${originUrl}: ${e.message || e.stderr?.toString() || 'unknown'}`);
  }
}

async function tryCacheFastPath({ projectRoot, cacheMaxAgeHours, getTokenImpl }) {
  const cachePath = path.join(projectRoot, '.last-host-check.json');
  if (!fs.existsSync(cachePath)) return null;
  let cached;
  try {
    cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  } catch {
    return null;
  }
  if (!cached.checkedAt || !cached.finalHostEnvUrl || cached.ready !== true) return null;

  const ageMs = Date.now() - Date.parse(cached.checkedAt);
  if (!isFinite(ageMs) || ageMs < 0) return null;
  if (ageMs > cacheMaxAgeHours * 3600 * 1000) return null;

  // Probe with a fresh token.
  let token;
  try {
    token = getDataverseToken(originOf(cached.finalHostEnvUrl), getTokenImpl);
  } catch {
    return null;
  }

  const verify = await verifyHostReadiness({
    hostEnvUrl: cached.finalHostEnvUrl,
    hostToken: token,
    skipWhoAmI: false,
  });

  if (!verify.ready) return null;

  return {
    ...cached,
    schemaVersion: 2,
    cacheHit: true,
    cacheAgeMs: ageMs,
    pipelinesSolutionVersion: verify.pipelinesSolutionVersion || cached.pipelinesSolutionVersion,
    warnings: verify.warnings || [],
  };
}

async function detect(opts = {}) {
  const {
    envUrl,
    token,
    userId,
    bapToken,
    projectRoot = process.cwd(),
    cacheMaxAgeHours = DEFAULT_CACHE_MAX_AGE_HOURS,
    noCache = false,
    includeName = null,
    maxEnvsToProbe = null,
    skus = null,
    minPipelinesVersion = null,
    source = 'auto',
    // Test injection points:
    getTokenImpl = null,
    listImpl = null,
    verifyImpl = null,
    pacExecImpl = null,
  } = opts;

  if (!envUrl) throw new Error('--envUrl is required');
  if (!token) throw new Error('--token (dev env Dataverse token) is required');
  if (!userId) throw new Error('--userId is required');
  // BAP token is only required for source=bap. In source=pac or source=auto-with-PAC-fallback,
  // detection works without BAP — the shim uses PAC CLI for env list/get.
  if (source === 'bap' && !bapToken) throw new Error('--bapToken is required when --source bap');

  const startedAt = Date.now();
  const baseOut = {
    schemaVersion: 2,
    checkedAt: new Date().toISOString(),
    sourceEnvUrl: envUrl,
    sourceEnvId: null,
    actionTaken: 'none',
    finalHostEnvUrl: null,
    finalHostEnvId: null,
    finalHostInstanceApiUrl: null,
    isPlatformHost: false,
    tenantDefaultCustomHostEnvId: null,
    pipelinesSolutionVersion: null,
    ready: false,
    warnings: [],
    candidates: {
      existingCustomHosts: [],
      existingPlatformHost: null,
      eligibleForAppInstall: [],
      inaccessibleEnvs: [],
    },
    telemetry: { correlationId: null },
    detectionDurationMs: 0,
    cacheHit: false,
  };

  // Phase 1.0 — cache fast-path
  if (!noCache) {
    const hit = await tryCacheFastPath({ projectRoot, cacheMaxAgeHours, getTokenImpl });
    if (hit) {
      hit.detectionDurationMs = Date.now() - startedAt;
      hit.checkedAt = new Date().toISOString();
      return hit;
    }
  }

  // Phase 2.1 — org-setting probe
  const binding = await checkEnvHostBinding({ envUrl, token });

  if (binding.bound) {
    baseOut.sourceEnvId = binding.hostEnvId; // hostEnvId here is the env GUID stored in the org setting

    // Phase 2.2 — resolve via BAP (or PAC fallback)
    const env = await resolveEnvById({ bapToken, envId: binding.hostEnvId, source, pacExecImpl });
    if (!env.found) {
      // 404-ambiguous: source env's binding points at an env we can't see.
      baseOut.resolutionStatus = 'OrgSettingStale';
      baseOut.warnings.push(`ProjectHostEnvironmentId points at env ${binding.hostEnvId} which is not visible — may be deleted, disabled, or the caller lacks access.`);
      baseOut.detectionDurationMs = Date.now() - startedAt;
      return baseOut;
    }

    baseOut.finalHostEnvId = env.envId;
    baseOut.finalHostEnvUrl = env.instanceUrl;
    baseOut.finalHostInstanceApiUrl = env.instanceApiUrl;
    baseOut.isPlatformHost = env.environmentSku === 'Platform';

    // Phase 2.3 — if PE, check tenant default custom host (CannotRedirect detection)
    if (baseOut.isPlatformHost) {
      const def = await discoverPipelinesHost({ envUrl, token, userId });
      if (def.found && def.hostEnvUrl) {
        baseOut.tenantDefaultCustomHostEnvId = def.hostEnvUrl;
        // The org setting and tenant default are both env GUIDs. Compare them.
        const orgSettingValue = binding.hostEnvId.toLowerCase();
        const tenantDefaultValue = String(def.hostEnvUrl).toLowerCase();
        if (orgSettingValue !== tenantDefaultValue) {
          baseOut.resolutionStatus = 'CannotRedirect';
          baseOut.warnings.push(
            `CannotRedirect: source env's ProjectHostEnvironmentId (${binding.hostEnvId}) points at PE, but tenant DefaultCustomPipelinesHostEnvForTenant (${def.hostEnvUrl}) points elsewhere. Resolution requires Power Platform admin.`,
          );
          baseOut.detectionDurationMs = Date.now() - startedAt;
          return baseOut;
        }
        baseOut.resolutionStatus = 'AvailableUsingCustomHostByAdminDefault';
      } else {
        baseOut.resolutionStatus = 'AvailableUsingPlatformHost';
      }
    } else {
      baseOut.resolutionStatus = 'AvailableUsingCustomHost';
    }
  } else {
    // Phase 2.5 — no org binding. Tenant-wide enumeration.
    const list = await listTenantEnvs({
      bapToken,
      skus: skus || ['Production'],
      maxEnvsToProbe: maxEnvsToProbe || undefined,
      firstHitWins: true,
      includeName,
      source,
      listImpl,
      getTokenImpl,
      verifyImpl,
      pacExecImpl,
    });

    baseOut.candidates = {
      existingCustomHosts: list.existingCustomHosts,
      existingPlatformHost: list.existingPlatformHost,
      eligibleForAppInstall: list.eligibleForAppInstall,
      inaccessibleEnvs: list.inaccessibleEnvs,
    };

    if (list.existingCustomHosts.length === 1) {
      const h = list.existingCustomHosts[0];
      baseOut.resolutionStatus = 'AvailableUnboundCustomHost';
      baseOut.finalHostEnvId = h.envId;
      baseOut.finalHostEnvUrl = h.instanceUrl;
      baseOut.finalHostInstanceApiUrl = h.instanceApiUrl;
      baseOut.isPlatformHost = false;
      baseOut.pipelinesSolutionVersion = h.pipelinesSolutionVersion || null;
    } else if (list.existingCustomHosts.length > 1) {
      baseOut.resolutionStatus = 'MultipleUnboundCustomHosts';
      // No finalHostEnvUrl — orchestrator decides which to pick at execution time.
    } else if (list.existingPlatformHost) {
      const h = list.existingPlatformHost;
      baseOut.resolutionStatus = 'PlatformHostExistsUnbound';
      baseOut.finalHostEnvId = h.envId;
      baseOut.finalHostEnvUrl = h.instanceUrl;
      baseOut.finalHostInstanceApiUrl = h.instanceApiUrl;
      baseOut.isPlatformHost = true;
      baseOut.pipelinesSolutionVersion = h.pipelinesSolutionVersion || null;
    } else {
      baseOut.resolutionStatus = 'NoHost';
    }
  }

  // Phase 5 — verify host (only if finalHostEnvUrl was set)
  if (baseOut.finalHostEnvUrl) {
    let hostToken;
    try {
      hostToken = getDataverseToken(originOf(baseOut.finalHostEnvUrl), getTokenImpl);
    } catch (e) {
      baseOut.warnings.push(`Token acquisition failed for host: ${e.message}`);
      baseOut.detectionDurationMs = Date.now() - startedAt;
      return baseOut;
    }

    const verify = await verifyHostReadiness({
      hostEnvUrl: baseOut.finalHostEnvUrl,
      hostToken,
      skipWhoAmI: false,
      minPipelinesVersion,
    });

    baseOut.ready = verify.ready;
    baseOut.pipelinesSolutionVersion = verify.pipelinesSolutionVersion || baseOut.pipelinesSolutionVersion;
    baseOut.warnings = baseOut.warnings.concat(verify.warnings || []);
    if (!verify.ready) {
      baseOut.warnings.push('Verification failed — host did not pass deploymentpipelines / solutions check.');
    }
  }

  baseOut.detectionDurationMs = Date.now() - startedAt;
  return baseOut;
}

if (require.main === module) {
  const opts = parseArgs(process.argv);
  detect(opts)
    .then((result) => {
      console.log(JSON.stringify(result));
      process.exit(0);
    })
    .catch((err) => {
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    });
}

module.exports = { detect, tryCacheFastPath };
