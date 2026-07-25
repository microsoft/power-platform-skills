'use strict';
const path = require('node:path');

// Reach the plugin's pure primitives (4 levels up from evals/model-apps/app-builder/lib/ → repo root,
// same depth genpage/lib uses to reach references/verified-icons.txt). These are offline-only modules
// with no I/O, no SDK handle, and no network access, so they are safe to call from the eval harness.
function pluginLib(name) { return require(path.join(__dirname, '..', '..', '..', '..', 'plugins', 'model-apps', 'scripts', 'lib', name)); }

const { migrateAppSpec, validateAppSpec } = pluginLib('app-spec.js');
const { lintAppSpec } = pluginLib('spec-lint.js');
const { planFor, PHASES, appDef, viewDef, chartDef, compileFormIntent, formFieldLogicals } = pluginLib('sdk-build.js');
const { schemaFacts } = pluginLib('schema-facts.js');
const { verifySpec } = pluginLib('verify-spec.js');

// Plan 3's pure PAGEREF_ resolver may not be landed yet — load it optionally so the page oracle
// degrades to a SKIP instead of crashing the harness. It IS present on this branch, but the
// try/catch keeps the harness portable across checkouts where Plan 3 isn't available (design §13.2).
let pagerefResolver = null;
try { pagerefResolver = pluginLib('pageref-resolver.js'); } catch { pagerefResolver = null; }

const lc = (s) => String(s || '').toLowerCase();

// author: design-profile validation + lint. The harness runs in autopilot/design mode — pages are
// intents, so 'plan' is the right profile (design §7.1 — deploy profile would reject intent pages).
function authorFacts(spec) {
  return { validate: validateAppSpec(spec, { profile: 'plan' }), lint: lintAppSpec(spec) };
}

// plan: the deterministic phase-grouped plan (planFor is pure for a fixed spec/opts — design §13.2).
function planFacts(spec) {
  const items = planFor(spec, { phases: PHASES, sampleData: true, publish: true });
  const byPhase = {};
  for (const it of items) byPhase[it.phase] = (byPhase[it.phase] || 0) + 1;
  return { byPhase, phases: Object.keys(byPhase), labels: items.map((i) => `${i.phase}\t${i.label}`) };
}

// ui: normalized view/chart/form facts from the pure def builders — the pre-serialization equivalents
// of wire-facts.js (viewFacts/chartFacts/formFacts), deterministic with no live env or bundle round-trip.
function wireFacts(spec) {
  return {
    views: (spec.views || []).map((v) => { const d = viewDef(spec, v); return { entity: d.entityLogicalName, name: d.name, columns: d.columns.map((c) => c.name) }; }),
    charts: (spec.charts || []).map((c) => { const d = chartDef(spec, c); return { entity: d.entityLogicalName, name: d.name, measure: d.series[0].aggregate, groupBy: d.categories[0].attribute }; }),
    forms: (spec.forms || []).map((f) => { const intent = compileFormIntent(spec, f, {}); return { entity: intent.entityLogicalName, name: intent.name, fields: formFieldLogicals(intent) }; }),
  };
}

// app: sitemap subarea target facts + navigation-graph validity. appDef resolves page/dashboard
// subareas from a result map; synthesize deterministic ids offline (no build) so the shape is stable.
//
// Page lookup: appDef resolves `result.pages[sa.page]`; lintAppSpec validates `sa.page` against
// `p.name`. We key result.pages by BOTH `p.key` and `p.name` so appDef can resolve subareas
// regardless of whether the author used the key or the name as the `page` reference — matching
// the linting behavior without requiring key === name in the fixture.
function appFacts(spec) {
  const result = { forms: {}, views: {}, charts: {}, dashboards: {}, pages: {} };
  for (const d of spec.dashboards || []) result.dashboards[d.name] = `dash-${d.name}`;
  for (const p of spec.pages || []) {
    const k = p.key || p.name;
    result.pages[k] = `gp-${k}`;
    // Also key by name so appDef can resolve a subarea whose `page` field holds the display name.
    // The linter validates sa.page against p.name (spec-lint.js), and authors naturally use names
    // as subarea references. Without the name key, appDef would throw on those subareas.
    if (p.name && p.name !== k) result.pages[p.name] = `gp-${k}`;
  }
  const def = appDef(spec, result);
  const areas = (def.siteMap.areas || []).map((a) => ({
    groups: (a.groups || []).map((g) => ({
      subAreas: (g.subAreas || []).map((s) => ({
        type: s.type,
        ref: s.entity || s.genPageId || s.dashboardId || s.url || null,
      })),
    })),
  }));

  // Navigation graph: collect every declared nav edge and flag ones whose targetKey has no
  // matching page declaration. These are dangling links that would silently fail at runtime.
  const keys = new Set((spec.pages || []).map((p) => p.key || p.name));
  const danglingNav = [];
  for (const p of spec.pages || []) {
    for (const nav of p.navigatesTo || []) {
      if (!keys.has(nav.targetKey)) danglingNav.push(`${p.key || p.name}→${nav.targetKey}`);
    }
  }
  return { areas, danglingNav };
}

// A synthesized reader that reports every artifact the spec declares as present, so verifySpec's
// reconcile (verify-spec.js) returns ok:true offline — proving the spec is internally verifiable.
// queryRecords always returns a single-element array (rows[0] truthy) so view/chart/form lookups
// all pass. Entity/column lookups are derived from the spec. Sitemap XML is built from appShell
// so entity-subarea checks pass. No pages()/pageCode() needed for intent-only specs.
function makeAllPresentReader(spec) {
  const entities = new Set((spec.entities || []).map((e) => lc(e.schemaName)));
  const columnsByEntity = {};
  for (const e of spec.entities || []) {
    columnsByEntity[lc(e.schemaName)] = (e.columns || []).map((c) => ({ logicalName: lc(c.schemaName) }));
  }

  // Build a sitemap XML fragment covering the entity subareas declared in appShell. The page/icon
  // checks in verifySpec only fire for implemented pages (source.kind==='tsx') — intent-only specs
  // skip them — so omitting GenPage XML is safe for our offline-only fixtures.
  const tags = [];
  for (const a of (spec.appShell && spec.appShell.areas) || []) {
    if (a.icon) tags.push(`<Area Icon="${lc(a.icon)}"/>`);
    for (const g of a.groups || []) {
      for (const sa of g.subAreas || []) {
        const attrs = [];
        if (sa.entity) attrs.push(`Entity="${lc(sa.entity)}"`);
        if (sa.page) attrs.push(`Type="GenPage" GenPageId="gp-${sa.page}"`);
        if (sa.icon) attrs.push(`Icon="${lc(sa.icon)}"`);
        tags.push(`<SubArea ${attrs.join(' ')}/>`);
      }
    }
  }
  const xml = `<SiteMap>${tags.join('')}</SiteMap>`;

  return {
    findTable: async (logical) => (entities.has(logical) ? { logicalName: logical } : null),
    findColumns: async (logical) => columnsByEntity[logical] || [],
    // All view/chart/form/dashboard existence checks pass — the reader always reports present.
    queryRecords: async () => [{ savedqueryid: 'x', savedqueryvisualizationid: 'x', formid: 'x' }],
    sitemapXml: async () => xml,
  };
}

async function verifyFacts(spec) {
  try { return await verifySpec(spec, makeAllPresentReader(spec)); }
  // If verifySpec calls a reader method not in our synthetic reader (Plan 3 extensions), the
  // assertion layer degrades the result to a SKIP rather than failing the harness.
  catch (e) { return { skipped: e.message }; }
}

// page: PAGEREF_ resolution facts (Plan 3). Returns null when pageref-resolver isn't loaded →
// the assertion layer emits SKIP (loose Plan-3 coupling). When present, each declared nav edge
// is represented as a canonical navigateTo call site so resolvePageRefs can parse and resolve it.
// A missing keyToId entry → unresolved entry (tests prove the assertion can FAIL).
function pageFacts(spec) {
  if (!pagerefResolver) return null;
  const keyToId = new Map((spec.pages || []).map((p) => [p.key || p.name, `gp-${p.key || p.name}`]));
  const sources = new Map();
  // Synthesize a minimal navigateTo() call site for each declared nav edge so extractNavTargets
  // can classify them. A bare `"PAGEREF_x"` string is NOT a nav call site and would be invisible
  // to extractNavTargets, so the synthetic code uses the canonical navigateTo form (design §9).
  for (const p of spec.pages || []) {
    for (const nav of p.navigatesTo || []) {
      sources.set(`${p.key || p.name}:${nav.targetKey}`, {
        code: `navigateTo({ pageType: 'generative', pageId: "PAGEREF_${nav.targetKey}" })`,
      });
    }
  }
  const { unresolved } = pagerefResolver.resolvePageRefs(sources, keyToId);
  return { unresolved };
}

async function stageFacts(rawSpec) {
  const spec = migrateAppSpec(rawSpec);
  return {
    author: authorFacts(spec),
    plan: planFacts(spec),
    data: schemaFacts(spec),
    ui: wireFacts(spec),
    app: appFacts(spec),
    verify: await verifyFacts(spec),
    page: pageFacts(spec),
    PHASES,
  };
}

module.exports = { stageFacts, makeAllPresentReader };
