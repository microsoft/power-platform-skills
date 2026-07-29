#!/usr/bin/env node
'use strict';
// Layer 4 — scripted live smoke eval: build a canonical throwaway app, assert key server-side
// outcomes (default-view enrichment + sitemap icons + app exists), then tear down. The deterministic
// pieces (buildSmokeSpec / runSmokeAssertions) are unit-tested; the live run is gated on --env.
//
// Usage (LIVE — writes + deletes a throwaway app; run only against a scratch env):
//   node scripts/smoke-eval.js --env <orgUrl> [--prefix smk]
// It shells out to the tested build-model-app.js / dataverse-request.js / teardown-model-app.js.

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// A minimal 1x1 transparent PNG (base64) for the nav-icon web resource.
const PNG_1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

// A canonical smoke spec exercising the shipped features: an entity with columns (so default views
// enrich), an image web resource, and a subarea with a raster icon + a Fluent vectorIcon.
function buildSmokeSpec(prefix = 'smk') {
  const ent = `new_${prefix}order`;
  const icon = `new_${prefix}icon.png`;
  return {
    solution: { uniqueName: `${prefix}SmokeSln`, displayName: `${prefix} smoke`, publisherPrefix: 'new' },
    app: { name: `${prefix} Smoke App`, description: 'smoke eval' },
    entities: [
      {
        schemaName: ent,
        displayName: 'Smoke Order',
        primaryAttribute: { schemaName: 'new_name', displayName: 'Name' },
        columns: [
          { schemaName: 'new_status', displayName: 'Status', type: 'Choice', options: ['Open', 'Closed'] },
          { schemaName: 'new_amount', displayName: 'Amount', type: 'Money' },
        ],
      },
    ],
    webResources: [{ name: icon, displayName: 'Smoke Icon', type: 'png', contentBase64: PNG_1x1 }],
    views: [],
    charts: [],
    forms: [],
    commands: [],
    dashboards: [],
    appShell: { areas: [{ label: 'Main', icon, groups: [{ label: 'Records', subAreas: [{ entity: ent, title: 'Orders', icon, vectorIcon: 'Grid' }] }] }] },
  };
}

// Run the server-side assertions against a deployed app. `read` is { queryRecords(set, opts) ->
// rows, sitemapXml(appId) -> xml }. Returns [{ name, ok, detail }].
async function runSmokeAssertions(spec, appId, read) {
  const ent = spec.entities[0].schemaName.toLowerCase();
  const iconName = spec.webResources[0].name.toLowerCase();
  const results = [];

  const views = (await read.queryRecords('savedquery', { select: ['name', 'layoutxml'], filter: `returnedtypecode eq '${ent}' and querytype eq 0` })) || [];
  const enriched = views.some((v) => /new_status/.test(v.layoutxml || ''));
  results.push({ name: 'default view enriched (has new_status column)', ok: enriched, detail: `${views.length} querytype-0 views` });

  const xml = (await read.sitemapXml(appId)) || '';
  results.push({ name: `sitemap subarea carries Icon="${iconName}"`, ok: xml.toLowerCase().includes(`icon="${iconName}"`), detail: '' });
  results.push({ name: 'sitemap subarea carries VectorIcon="Grid"', ok: /VectorIcon="Grid"/.test(xml), detail: '' });

  results.push({ name: 'app module was created', ok: !!appId, detail: appId || '(none)' });
  return results;
}

// --- live orchestration -----------------------------------------------------------------

function pluginScript(name) {
  return path.join(__dirname, name);
}

function runNode(scriptArgs) {
  return spawnSync(process.execPath, scriptArgs, { encoding: 'utf8' });
}

function dvGet(env, apiPath) {
  const r = runNode([pluginScript('dataverse-request.js'), env, 'GET', apiPath]);
  try { return JSON.parse(r.stdout).data; } catch { return null; }
}

async function main(env, prefix) {
  const spec = buildSmokeSpec(prefix);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-eval-'));
  const specPath = path.join(dir, 'app-spec.json');
  fs.writeFileSync(specPath, JSON.stringify(spec, null, 2));
  const ws = path.join(dir, '.maker-workspace');
  let exitCode = 1;
  let results = null;
  let buildFailed = false;
  let teardownFailed = false;

  try {
    process.stdout.write(`\n▶ smoke build (${spec.app.name}) — writes to ${env}\n`);
    const build = runNode([pluginScript('build-model-app.js'), '--env', env, '--spec', '@' + specPath, '--workspace', ws, '--apply']);
    process.stderr.write(build.stderr || '');
    if (build.status !== 0) {
      buildFailed = true;
      exitCode = build.status || 1;
      if (build.stdout) process.stdout.write(build.stdout);
      process.stderr.write(`\n✗ smoke build failed with exit code ${exitCode}; skipping assertions and running teardown for any partial artifacts.\n`);
    } else {
      let appId = null;
      try { appId = JSON.parse(build.stdout).created.app; } catch { /* assertions report missing appId */ }

      const ent = spec.entities[0].schemaName.toLowerCase();
      const read = {
        queryRecords: async (set, opts) => {
          const sel = (opts.select || []).map(encodeURIComponent).join(',');
          const flt = encodeURIComponent(opts.filter || '');
          const setName = set === 'savedquery' ? 'savedqueries' : set;
          const d = dvGet(env, `${setName}?$select=${sel}&$filter=${flt}`);
          return (d && d.value) || [];
        },
        sitemapXml: async (id) => {
          if (!id) return '';
          const app = dvGet(env, `appmodules(${id})?$select=appmoduleidunique`);
          const unique = app && app.appmoduleidunique;
          if (!unique) return '';
          const comp = dvGet(env, `appmodulecomponents?$filter=_appmoduleidunique_value eq ${unique} and componenttype eq 62&$select=objectid`);
          const smId = comp && comp.value && comp.value[0] && comp.value[0].objectid;
          if (!smId) return '';
          const sm = dvGet(env, `sitemaps(${smId})?$select=sitemapxml`);
          return (sm && sm.sitemapxml) || '';
        },
      };

      process.stdout.write('\n▶ smoke assertions\n');
      results = await runSmokeAssertions(spec, appId, read);
      for (const r of results) process.stdout.write(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  (${r.detail})` : ''}\n`);

      const failed = results.filter((r) => !r.ok);
      exitCode = failed.length ? 1 : 0;
    }
  } finally {
    // Even a failed build can leave a partially-created solution/app; always run the spec-scoped
    // teardown before deleting the local temp workspace so live smoke probes do not linger.
    process.stdout.write('\n▶ teardown\n');
    const teardown = runNode([pluginScript('teardown-model-app.js'), '--env', env, '--spec', '@' + specPath, '--workspace', ws, '--apply', '--allow-destructive']);
    process.stdout.write(teardown.stdout || '');
    process.stderr.write(teardown.stderr || '');
    if (teardown.status !== 0) {
      // A passing assertion set is not a clean smoke run if teardown failed: the live org now needs
      // recovery. Preserve the local spec/workspace so the operator can rerun teardown with the exact
      // artifact identities instead of deleting the only recovery breadcrumbs.
      exitCode = teardown.status || 1;
      teardownFailed = true;
      process.stderr.write(`\n✗ smoke teardown failed with exit code ${exitCode}; preserving local workspace for recovery: ${dir}\n`);
    } else {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  if (buildFailed) {
    process.stdout.write('\n=== smoke eval: FAIL (build failed; assertions skipped) ===\n');
  } else if (teardownFailed) {
    process.stdout.write(`\n=== smoke eval: FAIL (teardown failed; workspace preserved at ${dir}) ===\n`);
  } else {
    const failed = results.filter((r) => !r.ok);
    process.stdout.write(`\n=== smoke eval: ${failed.length ? 'FAIL' : 'PASS'} (${results.length - failed.length}/${results.length}) ===\n`);
  }
  return exitCode;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const valueAfter = (name) => {
    const i = args.indexOf(name);
    if (i === -1) return undefined;
    const value = args[i + 1];
    return value && !value.startsWith('--') ? value : undefined;
  };
  const env = valueAfter('--env');
  const prefix = args.indexOf('--prefix') > -1 ? valueAfter('--prefix') : 'smk';
  if (!env || !prefix) {
    process.stderr.write('Usage: node scripts/smoke-eval.js --env <orgUrl> [--prefix smk]  (LIVE — builds + deletes a throwaway app)\n');
    process.exit(2);
  }
  main(env, prefix).then((code) => process.exit(code));
}

module.exports = { buildSmokeSpec, runSmokeAssertions };
