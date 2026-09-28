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
// A minimal square SVG (base64) for the vector nav-icon web resource:
//   <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M4 4h16v16H4z"/></svg>
const SVG_SQUARE = 'PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHBhdGggZD0iTTQgNGgxNnYxNkg0eiIvPjwvc3ZnPg==';

// A canonical smoke spec exercising the shipped features: an entity with columns (so default views
// enrich), raster + SVG web resources, and two subareas that pin BOTH directions of the entity
// `vectorIcon` contract (see appDef in lib/sdk-build.js):
//   1. a PLATFORM REF (`/WebResources/<name>.svg`) — emitted verbatim, so a custom nav glyph and the
//      download->build round-trip survive. This is the shape a real app carries.
//   2. a BARE Fluent TOKEN ("Grid") — deliberately DROPPED on an entity subarea, because that shape
//      breaks the modern app-designer property pane. Kept as a live NEGATIVE CONTROL so the drop is
//      proven against the org rather than trusted from a code comment; validateAppSpec warns about
//      it by design (warnings are non-blocking), which the unit tests assert is intentional.
// The bare token used to sit on the ONLY subarea while the assertion demanded VectorIcon="Grid" in
// the deployed sitemap — an outcome the builder can never produce, so the live smoke could only fail.
function buildSmokeSpec(prefix = 'smk') {
  const ent = `new_${prefix}order`;
  const icon = `new_${prefix}icon.png`;
  const vectorIcon = `new_${prefix}vec.svg`;
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
    webResources: [
      { name: icon, displayName: 'Smoke Icon', type: 'png', contentBase64: PNG_1x1 },
      { name: vectorIcon, displayName: 'Smoke Vector Icon', type: 'svg', contentBase64: SVG_SQUARE },
    ],
    views: [],
    charts: [],
    forms: [],
    commands: [],
    dashboards: [],
    appShell: {
      areas: [{
        label: 'Main',
        icon,
        groups: [{
          label: 'Records',
          subAreas: [
            { entity: ent, title: 'Orders', icon, vectorIcon: `/WebResources/${vectorIcon}` },
            { entity: ent, title: 'Orders (token)', icon, vectorIcon: 'Grid' },
          ],
        }],
      }],
    },
  };
}

// Run the server-side assertions against a deployed app. `read` is { queryRecords(set, opts) ->
// rows, sitemapXml(appId) -> xml }. Returns [{ name, ok, detail }].
//
// Expectations are stated from the CONTRACT (the spec's authored values + the documented drop rule),
// never derived from `appDef`. Deriving them would make this eval unable to contradict the very code
// it exists to check: when appDef stops emitting a value, a derived "must be present" assertion
// silently becomes "must be absent" and still passes. Keeping the expectation independent is what
// makes a live FAIL possible. The offline suite (scripts/tests/smoke-eval.test.js) carries the other
// half of the guarantee — that buildSmokeSpec and appDef still AGREE with this contract — so an
// unsatisfiable assertion is caught before anyone spends a live run on it.
async function runSmokeAssertions(spec, appId, read) {
  const ent = spec.entities[0].schemaName.toLowerCase();
  const results = [];

  const views = (await read.queryRecords('savedquery', { select: ['name', 'layoutxml'], filter: `returnedtypecode eq '${ent}' and querytype eq 0` })) || [];
  const enriched = views.some((v) => /new_status/.test(v.layoutxml || ''));
  results.push({ name: 'default view enriched (has new_status column)', ok: enriched, detail: `${views.length} querytype-0 views` });

  const xml = (await read.sitemapXml(appId)) || '';
  // Subarea 0 declares a PLATFORM-REF vectorIcon (must round-trip); subarea 1 declares a BARE Fluent
  // token (must be dropped). buildSmokeSpec fixes these roles and the unit tests pin them.
  const subAreas = (((spec.appShell || {}).areas || [])[0] || {}).groups || [];
  const [refSub, tokenSub] = (subAreas[0] || {}).subAreas || [];

  for (const [sub, label] of [[refSub, 'platform-ref'], [tokenSub, 'bare-token']]) {
    if (!sub) { results.push({ name: `smoke spec is missing its ${label} subarea`, ok: false, detail: 'buildSmokeSpec shape changed' }); continue; }
    const tag = subAreaTag(xml, sub.title);
    // A collapsed nav must FAIL rather than vacuously satisfy the icon checks below.
    results.push({ name: `sitemap contains subarea "${sub.title}"`, ok: !!tag, detail: tag ? '' : 'no matching <SubArea> in the deployed sitemap' });
    if (!tag) continue;
    results.push({ name: `subarea "${sub.title}" carries Icon="${sub.icon}"`, ok: hasSitemapAttr(tag, 'Icon', sub.icon), detail: '' });
  }

  if (refSub) {
    const tag = subAreaTag(xml, refSub.title);
    results.push({ name: `subarea "${refSub.title}" carries VectorIcon="${refSub.vectorIcon}"`, ok: !!tag && hasSitemapAttr(tag, 'VectorIcon', refSub.vectorIcon), detail: 'a platform-ref vectorIcon must round-trip onto an entity subarea' });
  }
  if (tokenSub) {
    // Document-scoped on purpose: a bare Fluent token must appear NOWHERE in the sitemap, so this
    // also catches it leaking onto a different element than the one that declared it.
    results.push({ name: `bare token VectorIcon="${tokenSub.vectorIcon}" is absent from the sitemap`, ok: !hasSitemapAttr(xml, 'VectorIcon', tokenSub.vectorIcon), detail: 'a bare token on an entity subarea breaks the app designer and must be dropped' });
  }

  results.push({ name: 'app module was created', ok: !!appId, detail: appId || '(none)' });
  return results;
}

// Escape a value for embedding in a RegExp source string.
const escapeRe = (v) => String(v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The OPEN TAG of the <SubArea> whose title is `title`, or '' when there is none. The sitemap nests
// the label as a child, e.g.:
//   <SubArea Id="sub_0_0_0" Entity="new_torder" … Icon="x.png" VectorIcon="/WebResources/y.svg">
//     <Titles><Title LCID="1033" Title="Orders" /></Titles>
//   </SubArea>
// Located by the SPEC's authored title rather than the builder's generated `Id`, so the eval does not
// take its bearings from the component under test. The lookahead stops the lazy scan at the next
// <SubArea>, so a title can never be matched against a LATER subarea's tag. Only the open tag is
// returned: attribute checks must not be satisfiable by the nested <Title Title="…"> attribute, nor
// by the parent <Area Icon="…"> (the smoke spec deliberately reuses one icon across area + subareas,
// so a document-wide scan would let <Area> alone satisfy every subarea icon assertion).
function subAreaTag(xml, title) {
  const re = new RegExp(`<SubArea\\b[^>]*>(?:(?!<SubArea\\b)[\\s\\S])*?<Title\\b[^>]*\\bTitle="${escapeRe(title)}"`, 'i');
  const m = re.exec(String(xml || ''));
  if (!m) return '';
  const open = /^<SubArea\b[^>]*>/i.exec(m[0]);
  return open ? open[0] : '';
}

// Match a sitemap attribute exactly within `fragment`. `\b` before the name keeps `Icon="x"` from
// matching inside `VectorIcon="x"` (there is no word boundary between `r` and `I`), which a plain
// substring check does not. Matching is case-insensitive because Dataverse lower-cases bare
// web-resource names; the VALUE is regex-escaped so a path's `/` and `.` stay literal.
function hasSitemapAttr(fragment, attr, value) {
  return new RegExp(`\\b${attr}="${escapeRe(value)}"`, 'i').test(String(fragment || ''));
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

module.exports = { buildSmokeSpec, runSmokeAssertions, subAreaTag, hasSitemapAttr };
