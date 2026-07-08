#!/usr/bin/env node
'use strict';
// ai-preflight: read-only AI readiness report for a Power Platform environment.
// Calls sdk.getAiReadiness and prints a per-feature on/off summary plus admin actions
// for any disabled features. Exit 0 always (informational).
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
  const env = flags.env;
  const app = flags.app || null;

  if (!env) {
    process.stderr.write('Usage: node ai-preflight.js --env <orgUrl> [--app <uniqueName>]\n');
    process.exit(1);
  }

  const { createMakerSdk } = require('./vendor/cds-maker-sdk.cjs');
  const httpClient = createAzHttpClient(env);
  // getAiReadiness is a read-only org/app query, but the vendored SDK expects an initialized
  // workspace (throws WorkspaceNotInitializedError otherwise) — mirror the other entrypoints:
  // create a throwaway workspace, initWorkspace(), and remove it in finally.
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-preflight-'));
  const sdk = createMakerSdk({ workspacePath: workspaceDir, instanceUrl: env, httpClient });
  sdk.initWorkspace();

  try {
    const readinessOpts = app ? { appUniqueName: app } : {};
    const readiness = await sdk.getAiReadiness(readinessOpts);
    const report = runPreflight(readiness);

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

    emitResult(true, { ok: true, ...report });
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
}

module.exports = { runPreflight };

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`Error: ${err.message}\n`);
    process.exit(1);
  });
}
