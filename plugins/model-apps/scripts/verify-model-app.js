#!/usr/bin/env node
'use strict';
// verify-model-app: reconcile an App Spec against the DEPLOYED app and report any missing artifacts
// (entities/columns/views/charts/forms/sitemap subareas + icons). Read-only. Exit non-zero if
// anything declared is missing — catches silent partial builds.
//
// Usage: node verify-model-app.js --env <orgUrl> --spec @<app-folder>/app-spec.json [--workspace <dir>]

const fs = require('node:fs');
const path = require('node:path');
const { parseArgs, readJsonArg, emitResult } = require('./lib/dataverse-auth.js');
const { createAzHttpClient } = require('./lib/sdk-http-client.js');
const { verifySpec } = require('./lib/verify-spec.js');
const { appUniqueName } = require('./lib/sdk-build.js');
const { validateAppSpec, migrateAppSpec } = require('./lib/app-spec.js');
const { odataLit } = require('./lib/odata.js');

function makeProvision(env, workspaceDir) {
  const { createMakerSdk } = require('./vendor/cds-maker-sdk.cjs');
  const httpClient = createAzHttpClient(env);
  fs.mkdirSync(workspaceDir, { recursive: true });
  const sdk = createMakerSdk({ workspacePath: workspaceDir, instanceUrl: env, httpClient });
  sdk.initWorkspace();
  return sdk;
}

// Resolve the app's sitemap XML: appmodule (by unique name) -> appmodulecomponents (type 62) ->
// sitemaps. Returns '' when the app / sitemap can't be found.
async function sitemapXmlFor(sdk, appUnique) {
  const apps = await sdk.queryRecords('appmodule', { select: ['appmoduleid', 'appmoduleidunique'], filter: `uniquename eq '${odataLit(appUnique)}'`, top: 1 });
  const app = apps && apps[0];
  if (!app) return '';
  const comps = await sdk.queryRecords('appmodulecomponent', { select: ['objectid', 'componenttype'], filter: `_appmoduleidunique_value eq ${app.appmoduleidunique} and componenttype eq 62`, top: 1 });
  const smId = comps && comps[0] && comps[0].objectid;
  if (!smId) return '';
  const sms = await sdk.queryRecords('sitemap', { select: ['sitemapxml'], filter: `sitemapid eq ${smId}`, top: 1 });
  return (sms && sms[0] && sms[0].sitemapxml) || '';
}

function readerFor(sdk, appUnique) {
  return {
    findTable: async (logical) => { const l = String(logical).toLowerCase(); const t = await sdk.findTables(l); return (t || []).find((x) => String(x.logicalName).toLowerCase() === l) || null; },
    findColumns: async (logical) => sdk.findColumns(logical),
    queryRecords: (set, opts) => sdk.queryRecords(set, opts),
    sitemapXml: () => sitemapXmlFor(sdk, appUnique),
  };
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const env = flags.env;
  const specArg = flags.spec || positional[0];
  if (!env || !specArg) {
    process.stderr.write('Usage: node verify-model-app.js --env <url> --spec @<app-folder>/app-spec.json [--workspace <dir>]\n');
    process.exit(1);
  }
  const specPath = path.resolve(typeof specArg === 'string' && specArg.startsWith('@') ? specArg.slice(1) : specArg);
  const spec = migrateAppSpec(readJsonArg('@' + specPath));
  // Validate the spec up front (consistent with teardown) so malformed input yields a structured
  // error instead of a later throw when dereferencing spec.entities / schemaName.
  const v = validateAppSpec(spec, { profile: 'deploy' });
  if (!v.ok) { emitResult(false, { ok: false, errors: v.errors }); return; }
  const workspaceDir = flags.workspace || path.join(path.dirname(specPath), '.maker-workspace');
  const sdk = makeProvision(env, workspaceDir);
  const r = await verifySpec(spec, readerFor(sdk, appUniqueName(spec)));
  for (const c of r.checks) process.stderr.write(`  ${c.present ? '✓' : '✗'} ${c.kind}: ${c.name}\n`);
  process.stderr.write(`\n${r.ok ? '✓ verify PASS' : `✗ verify FAIL — ${r.missing.length} missing`} (${r.checks.length - r.missing.length}/${r.checks.length} present)\n`);
  // Include `errors` (alias of missing) so emitResult's failure note reports an accurate count.
  const missing = r.missing.map((m) => `${m.kind}:${m.name}`);
  emitResult(r.ok, { ok: r.ok, present: r.checks.length - r.missing.length, total: r.checks.length, missing, errors: missing });
}

if (require.main === module) {
  main().catch((err) => emitResult(false, err));
}

module.exports = { sitemapXmlFor, readerFor };
