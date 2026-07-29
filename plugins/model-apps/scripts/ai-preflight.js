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
 * @param {{ formFill, nlSearch, nlChart, summaries, m365 }} readiness
 * @returns {{ features: Array<{feature, enabled, setting}>, adminActions: string[] }}
 */
function runPreflight(readiness) {
  const features = [];
  const adminActions = [];

  for (const [key, meta] of Object.entries(FEATURE_META)) {
    const f = readiness[key];
    if (!f) continue;
    features.push({ feature: key, enabled: f.enabled, setting: f.setting });
    if (!f.enabled) {
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

  const { createMakerSdk } = require('./vendor/cds-maker-sdk.cjs');
  const httpClient = createAzHttpClient(env);
  // getAiReadiness is a read-only org/app query, but the vendored SDK expects an initialized
  // workspace (throws WorkspaceNotInitializedError otherwise) — mirror the other entrypoints:
  // create a throwaway workspace, initWorkspace(), and remove it in finally.
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-preflight-'));
  const sdk = createMakerSdk({ workspacePath: workspaceDir, instanceUrl: env, httpClient });

  let report;
  try {
    sdk.initWorkspace();
    const readinessOpts = app ? { appUniqueName: app } : {};
    const readiness = await sdk.getAiReadiness(readinessOpts);
    report = runPreflight(readiness);

    process.stderr.write('\nAI Feature Readiness\n');
    process.stderr.write('====================\n');
    for (const f of report.features) {
      process.stderr.write(`  ${f.enabled ? '✓' : '✗'} ${FEATURE_META[f.feature]?.label || f.feature} (${f.setting})\n`);
    }
    if (report.adminActions.length) {
      process.stderr.write('\nAdmin actions required:\n');
      for (const a of report.adminActions) {
        process.stderr.write(`  • ${a}\n`);
      }
    } else {
      process.stderr.write('\nAll AI features are enabled.\n');
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
