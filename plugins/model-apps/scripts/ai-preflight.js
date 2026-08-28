#!/usr/bin/env node
'use strict';
// ai-preflight: read-only AI readiness report for a Power Platform environment.
// Calls sdk.getAiReadiness and prints a per-feature on/off summary plus admin actions
// for any disabled features. Never fails on a disabled feature (informational); exits
// non-zero only on a usage error (missing --env) or an unexpected failure.
//
// Usage: node ai-preflight.js --env <orgUrl> [--app <uniqueName>]

const { parseArgs, emitResult } = require('./lib/dataverse-auth.js');
const { createAzHttpClient } = require('./lib/sdk-http-client.js');
const { AI_APP_SETTING, resolveAppModuleId, effectiveSettingValue, settingIsOn } = require('./lib/ai-app-settings.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Human-readable label + admin-action hint for each feature key returned by getAiReadiness.
const FEATURE_META = {
  formFill: {
    label: 'Form fill',
    action: (f) => `Enable "Form fill" (setting: ${f.setting}) in Power Platform Admin Center → Environments → Settings → Product → Features.`,
  },
  nlSearch: {
    label: 'Natural language search',
    action: (f) => `Enable "Natural language search" (setting: ${f.setting}) in Power Platform Admin Center → Environments → Settings → Product → Features.`,
  },
  nlChart: {
    label: 'Natural language charts',
    action: (f) => `Enable "Natural language charts" (setting: ${f.setting}) in Power Platform Admin Center → Environments → Settings → Product → Features.`,
  },
  summaries: {
    label: 'AI row summaries',
    action: (f) => `Enable "AI row summaries" via the "AI insight cards" setting (${f.setting}) in Power Platform Admin Center → Environments → Settings → Product → Features.`,
  },
  m365: {
    label: 'M365 Copilot integration',
    action: (f) => `Enable "M365 Copilot integration" (setting: ${f.setting}) in Power Platform Admin Center → Environments → Settings → Product → Features.`,
  },
};

/**
 * Pure: given the getAiReadiness result, produce a structured preflight report.
 *
 * `effective` (optional) maps a feature key to `{ value, scope, on }` for that feature's PER-APP
 * setting, as resolved by `effectiveSettingValue`. It exists because the readiness gate and the
 * feature's actual setting are different rows: a gate can read false while the feature is switched
 * on at environment scope and therefore running in every app. Without this, the report tells an
 * operator to go and enable something that is already on.
 *
 * A feature that is IN EFFECT gets no admin action, because there is nothing for an admin to do.
 *
 * @param {{ formFill, nlSearch, nlChart, summaries, m365 }} readiness
 * @param {Record<string, {value?: string, scope?: string, on?: boolean, error?: string}>} [effective]
 * @returns {{ features: Array<{feature, enabled, setting, inEffect?, effectiveValue?, effectiveScope?}>, adminActions: string[] }}
 */
function runPreflight(readiness, effective = {}) {
  const features = [];
  const adminActions = [];

  for (const [key, meta] of Object.entries(FEATURE_META)) {
    const f = readiness[key];
    if (!f) continue;
    const eff = effective[key] || {};
    // Only a POSITIVE reading counts. `eff.error` (could not look, or the setting is not
    // provisioned here) must never be read as "in effect" — that would suppress a real admin action.
    const inEffect = eff.on === true;
    features.push({
      feature: key,
      enabled: f.enabled,
      setting: f.setting,
      ...(eff.value !== undefined ? { effectiveValue: eff.value, effectiveScope: eff.scope } : {}),
      ...(inEffect ? { inEffect: true } : {}),
    });
    if (!f.enabled && !inEffect) {
      adminActions.push(meta.action(f));
    }
  }

  return { features, adminActions };
}

async function main() {
  const { flags } = parseArgs(process.argv.slice(2));
  const env = typeof flags.env === 'string' ? flags.env : undefined;
  const app = typeof flags.app === 'string' ? flags.app : null;

  if (!env || flags.app === true) {
    process.stderr.write('Usage: node scripts/ai-preflight.js --env <orgUrl> [--app <uniqueName>]\n');
    process.exit(1);
  }

  // getAiReadiness is a read-only org/app query, but the vendored SDK expects an initialized
  // workspace (throws WorkspaceNotInitializedError otherwise) — mirror the other entrypoints:
  // create a throwaway workspace, initWorkspace(), and remove it in finally.
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-preflight-'));

  let report;
  try {
    const { createMakerSdk } = require('./vendor/cds-maker-sdk.cjs');
    const httpClient = createAzHttpClient(env);
    const sdk = createMakerSdk({ workspacePath: workspaceDir, instanceUrl: env, httpClient });
    // Keep SDK construction inside the protected region too: a constructor failure happens after the
    // temp directory exists, so the finally must own both construction and init to avoid leaks.
    sdk.initWorkspace();
    const readinessOpts = app ? { appUniqueName: app } : {};
    const readiness = await sdk.getAiReadiness(readinessOpts);

    // Resolve each feature's ACTUAL setting alongside the gate. The gate only decides whether a
    // build would write an app-scope override; the feature can already be switched on at
    // environment scope (or on by default), in which case reporting it as disabled — and telling an
    // admin to go enable it — is simply wrong. Best-effort: any lookup failure leaves the feature
    // reported from the gate alone, which is the previous behaviour.
    const read = { queryRecords: (entity, opts) => sdk.queryRecords(entity, opts) };
    const appModuleId = app ? (await resolveAppModuleId(read, app)).appModuleId || null : null;
    const effective = {};
    for (const key of Object.keys(FEATURE_META)) {
      const setting = AI_APP_SETTING[key];
      if (!setting) continue; // `summaries` is not a per-app on/off setting
      const res = await effectiveSettingValue(read, appModuleId, setting);
      effective[key] = res.error ? { error: res.error } : { value: res.value, scope: res.scope, on: settingIsOn(res.value) };
    }
    report = runPreflight(readiness, effective);

    process.stderr.write('\nAI Feature Readiness\n');
    process.stderr.write('====================\n');
    for (const f of report.features) {
      const label = FEATURE_META[f.feature]?.label || f.feature;
      if (f.inEffect && !f.enabled) {
        // The distinction that matters: running, but not because of anything this app declares.
        process.stderr.write(`  ✓ ${label} (${f.setting}) — in effect via the ${f.effectiveScope} setting (value "${f.effectiveValue}"), though the readiness gate reads off\n`);
      } else {
        process.stderr.write(`  ${f.enabled ? '✓' : '✗'} ${label} (${f.setting})\n`);
      }
    }
    if (report.adminActions.length) {
      process.stderr.write('\nAdmin actions required:\n');
      for (const a of report.adminActions) {
        process.stderr.write(`  • ${a}\n`);
      }
    } else {
      process.stderr.write('\nAll AI features are available (enabled, or already in effect).\n');
    }
  } finally {
    // emitResult() calls process.exit(), so clean up the throwaway workspace BEFORE emitting.
    try {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    } catch {
      // This is an informational read-only probe; on Windows the SDK can briefly retain a handle,
      // and cleanup must not turn an otherwise successful readiness report into a script failure.
    }
  }

  emitResult(true, { ok: true, ...report });
}

module.exports = { runPreflight };

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`Error: ${err.message}\n`);
    process.exit(1);
  });
}
