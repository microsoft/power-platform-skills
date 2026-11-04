'use strict';
// Maps each assertion text in evals.json to a check function receiving { facts, spec, eval } and
// returning { status: 'pass'|'fail'|'skip', reason? }. Mirrors evals/model-apps/genpage/lib/assertions-*.js.
// Register every text in common_stage_assertions here; any unregistered text gets a SKIP.
const path = require('node:path');
// Same reach as facts.js: 4 levels up to the repo root. Pure, offline plugin primitives only.
const { declaredColumnLogicals } = require(path.join(__dirname, '..', '..', '..', '..', 'plugins', 'model-apps', 'scripts', 'lib', 'app-spec.js'));
const PASS = { status: 'pass' };
const fail = (reason) => ({ status: 'fail', reason });
const skip = (reason) => ({ status: 'skip', reason });
const sortedLc = (a) => (a || []).map((s) => String(s).toLowerCase()).sort();
const sorted = (a) => (a || []).map(String).sort();
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Scope permissiveness ranking for the least-privilege eval (mirrors facts.js): user < businessUnit <
// parentChild < organization. A granted scope ranked above the declared scope is an over-grant.
const SCOPE_RANK = { user: 0, businessunit: 1, parentchild: 2, organization: 3 };
const scopeRank = (s) => (SCOPE_RANK[String(s || 'user').toLowerCase()] !== undefined ? SCOPE_RANK[String(s || 'user').toLowerCase()] : 0);

const ASSERTIONS = new Map();

// author stage ---------------------------------------------------------------

ASSERTIONS.set('author: validateAppSpec(plan profile) passes with no errors', ({ facts }) =>
  facts.author.validate.ok
    ? PASS
    : fail(`validate errors: ${facts.author.validate.errors.join('; ')}`));

ASSERTIONS.set('author: spec-lint reports no errors', ({ facts }) =>
  facts.author.lint.errors.length === 0
    ? PASS
    : fail(`lint errors: ${facts.author.lint.errors.join('; ')}`));

ASSERTIONS.set('author: artifact-name warnings use per-table and form-type scope', ({ facts, eval: ev }) => {
  const f = facts.author;
  if (!Array.isArray(f.artifactNameCollisions) || !Array.isArray(f.artifactNames)) return fail('no independent artifact-name scope facts');
  if (f.artifactNameCollisions.length) {
    return fail(`same-table duplicate ${f.artifactNameCollisions.map((c) => `${c.kind} on ${c.entity}: ${c.name}`).join('; ')}`);
  }
  const duplicateWarnings = f.lint.warnings.filter((w) => /^Duplicate (?:form|view|chart) name\b/.test(w));
  if (duplicateWarnings.length) return fail(`lint falsely flags per-table scoped names: ${duplicateWarnings.join('; ')}`);
  const expected = ev.expect && ev.expect.nameScope;
  if (!Array.isArray(expected) || !expected.length) return fail('no independent repeated-name scope expectations');
  for (const group of expected) {
    const actual = f.artifactNames.filter((a) => a.kind === group.kind && a.name === group.name
      && (group.kind !== 'form' || a.formType === group.formType)).map((a) => a.entity).sort();
    if (!eq(actual, sortedLc(group.entities))) return fail(`${group.kind} ${group.name}: expected tables [${group.entities}], got [${actual}]`);
  }
  return PASS;
});

ASSERTIONS.set('author: page quote warnings remain visible without rewriting approved names', ({ facts }) => {
  const approved = facts.author.approvedPageNames;
  if (!Array.isArray(approved)) return fail('no independent approved page-name snapshot');
  if (!approved.length) return skip('spec declares no pages');
  const actual = (facts.author.pageNames || []).map((p) => p.name);
  if (!eq(actual, approved)) return fail(`approved page names were rewritten: expected ${JSON.stringify(approved)}, got ${JSON.stringify(actual)}`);
  const quoted = approved.filter((name) => typeof name === 'string' && name.includes('"'));
  const warnings = facts.author.lint.warnings.filter((w) => /^Page '/.test(w) && w.includes('ASCII double quote'));
  if (warnings.length !== quoted.length) return fail(`page quote warnings: expected ${quoted.length}, got ${warnings.length}`);
  for (const name of quoted) if (!warnings.some((w) => w.startsWith(`Page '${name}':`))) {
    return fail(`page ${JSON.stringify(name)} is missing its ASCII double quote warning`);
  }
  return PASS;
});

// plan stage -----------------------------------------------------------------

ASSERTIONS.set('plan: every planned item targets a known engine phase', ({ facts }) => {
  const known = new Set(facts.PHASES);
  const bad = facts.plan.phases.filter((p) => !known.has(p));
  return bad.length ? fail(`unknown phases in plan: ${bad.join(', ')}`) : PASS;
});

// security stage -------------------------------------------------------------
// Both assertions are trivially satisfied for a spec with no personas (empty facts.security /
// zero planned security items), so they are safe as common assertions across every fixture.

ASSERTIONS.set('security: the plan authors exactly one role per declared persona', ({ facts, spec }) => {
  const declared = (spec.personas || []).length;
  // Count role items only: the security phase also plans field security profiles (and role grants),
  // which are not persona roles. Plan labels look like `security\tsecurity role "Support Agent" (2 jobs)`.
  const planned = (facts.plan.labels || []).filter((l) => l.startsWith('security\tsecurity role "')).length;
  return declared === planned ? PASS : fail(`declared ${declared} persona(s) but planned ${planned} security role item(s)`);
});

ASSERTIONS.set('security: each app-access persona role injects app-module read; opted-out personas do not', ({ facts }) => {
  const missing = (facts.security || []).filter((r) => r.appAccess && !r.appModuleRead);
  if (missing.length) return fail(`app-access personas missing app-module read: ${missing.map((r) => r.persona).join(', ')}`);
  const leaked = (facts.security || []).filter((r) => !r.appAccess && r.appModuleRead);
  if (leaked.length) return fail(`opted-out personas wrongly granted app-module read: ${leaked.map((r) => r.persona).join(', ')}`);
  return PASS;
});

// #4 (icon reviewability): a custom table's nav icon is something the USER approves, and at plan time
// the SVG may not be drawn yet — so the spec must say what the glyph DEPICTS, in plain language.
// A Fluent token name is not a depiction: the SVG is authored fresh, so a token the user has never
// seen tells them nothing about what they are approving. Reused/system tables already ship an icon.
const FLUENT_TOKENISH = /^(?=\S+$)(?:[A-Z].*|.*[a-z0-9][A-Z].*|.*(?:Regular|Filled|Light|Color)\d*$)/;
ASSERTIONS.set('design: every custom table icon is described by what it depicts, not a token name', ({ spec }) => {
  const entities = ((spec && spec.entities) || []).filter((e) => e && typeof e === 'object' && !e.existing);
  const withIcon = entities.filter((e) => e.vectorIcon || e.icon);
  if (!withIcon.length) return skip('no custom table declares an icon');

  const undescribed = withIcon.filter((e) => !(typeof e.iconDescription === 'string' && e.iconDescription.trim()));
  if (undescribed.length) return fail(`table icon(s) with no iconDescription: ${undescribed.map((e) => e.schemaName).join(', ')}`);

  const tokenish = withIcon.filter((e) => FLUENT_TOKENISH.test(e.iconDescription.trim()));
  return tokenish.length
    ? fail(`iconDescription reads as a Fluent token, not a depiction: ${tokenish.map((e) => `${e.schemaName}="${e.iconDescription}"`).join(', ')}`)
    : PASS;
});

// #3 (design coverage): every persona job should name the surface(s) that let that persona DO it,
// and each named surface must actually exist in the spec. This grades the DESIGN, not the access
// model: testers reported the skill enumerating neither jobs-to-be-done nor the generative pages that
// satisfy them, so an app shipped whose personas had no way to do their work. A job pointing at a
// surface that does not exist is the same failure wearing a mapping.
// Surfaces are matched by page key, page name, view name or form name — the four things an author
// would naturally write. Advisory-by-omission: a spec that maps NO jobs at all skips rather than
// fails, because `surfaces[]` is optional and older fixtures predate it.
ASSERTIONS.set('design: every mapped persona job resolves to a surface that exists', ({ spec }) => {
  const personas = (spec && spec.personas) || [];
  if (!personas.length) return skip('spec declares no personas');
  const jobs = personas.flatMap((p) => (p.jobs || []).map((j) => ({ persona: p.persona, job: j })));
  const mapped = jobs.filter(({ job }) => ((job.surfaces || []).length));
  if (!mapped.length) return skip('no job declares surfaces[]');

  const known = new Set();
  for (const p of spec.pages || []) { if (p.key) known.add(String(p.key).toLowerCase()); if (p.name) known.add(String(p.name).toLowerCase()); }
  for (const v of spec.views || []) if (v.name) known.add(String(v.name).toLowerCase());
  for (const f of spec.forms || []) if (f.name) known.add(String(f.name).toLowerCase());

  const dangling = [];
  for (const { persona, job } of mapped) {
    for (const s of job.surfaces || []) {
      if (!known.has(String(s).toLowerCase())) dangling.push(`${persona} → "${job.name}" → ${s}`);
    }
  }
  return dangling.length ? fail(`job(s) mapped to a non-existent surface: ${dangling.join('; ')}`) : PASS;
});

// #1 (JTBD coverage): a persona job/additionalPrivilege that names an APP-OWNED table (the app's own
// publisher prefix) must resolve to a table the app actually provisions. Catches a persona access model
// that references a hallucinated/typo app table (e.g. `new_tickets` vs `new_ticket`) — the role would
// grant it but the persona can never use it — the offline analog of a functionality grader finding the
// app can't support the journey. External/system tables (account, msdyn_*) are exempt (a live check).
ASSERTIONS.set('security: every persona privilege on an app-owned table resolves to a provisioned entity', ({ facts }) => {
  const sec = facts.security || [];
  if (!sec.length) return skip('spec declares no personas');
  const bad = sec.filter((r) => (r.unresolvedAppTables || []).length);
  return bad.length
    ? fail(bad.map((r) => `${r.persona}: unprovisioned app table(s) ${r.unresolvedAppTables.join(', ')}`).join('; '))
    : PASS;
});

// #2 (least privilege): the role's GRANTED privilege union must not exceed the author's DECLARED union —
// no entity beyond the declared set (except the documented app-module read injected for app-open when
// appAccess), no access token the author didn't ask for, and no scope more permissive than declared.
// Locks personaRoleSpecFor as a faithful normalizer: a future change that auto-grants an extra table or
// inflates every scope to organization fails here.
ASSERTIONS.set('security: each persona role grants exactly its declared job privileges (no over-grant)', ({ facts }) => {
  const sec = facts.security || [];
  if (!sec.length) return skip('spec declares no personas');
  for (const r of sec) {
    const declared = r.declared || {};
    const granted = r.granted || {};
    // (1) No OVER-grant: every granted (entity, access) must be declared — or, for appmodule, the
    // documented read injection when appAccess — at a scope no MORE permissive than declared.
    for (const [ent, accs] of Object.entries(granted)) {
      for (const [acc, scope] of Object.entries(accs)) {
        if (ent === 'appmodule') {
          const declaredScope = declared.appmodule && declared.appmodule[acc];
          const injected = r.appAccess && acc === 'read';
          if (declaredScope === undefined && !injected) return fail(`${r.persona}: appmodule '${acc}' granted but neither declared nor app-access-injected (leak)`);
          if (declaredScope !== undefined && scopeRank(scope) > scopeRank(declaredScope)) return fail(`${r.persona}: appmodule '${acc}' scope '${scope}' exceeds declared '${declaredScope}'`);
          continue;
        }
        const declaredScope = declared[ent] && declared[ent][acc];
        if (declaredScope === undefined) return fail(`${r.persona}: role grants ${ent} '${acc}' the author never declared (over-grant)`);
        if (scopeRank(scope) > scopeRank(declaredScope)) return fail(`${r.persona}: ${ent} '${acc}' scope '${scope}' exceeds declared '${declaredScope}'`);
      }
    }
    // (2) No UNDER-grant ("exactly"): every declared (entity, access) must be granted at >= its scope,
    // so the mapper cannot silently drop or weaken a declared privilege.
    for (const [ent, accs] of Object.entries(declared)) {
      for (const [acc, scope] of Object.entries(accs)) {
        const grantedScope = granted[ent] && granted[ent][acc];
        if (grantedScope === undefined) return fail(`${r.persona}: declared ${ent} '${acc}' is not granted by the role (under-grant)`);
        if (scopeRank(grantedScope) < scopeRank(scope)) return fail(`${r.persona}: declared ${ent} '${acc}'@${scope} granted only @${grantedScope} (weakened)`);
      }
    }
  }
  return PASS;
});

// data stage -----------------------------------------------------------------

ASSERTIONS.set('data: schema-facts provision exactly the expected tables', ({ facts, eval: ev }) => {
  const expected = sortedLc(ev.expect && ev.expect.tables);
  const actual = facts.data.tables.map((t) => t.logicalName).sort();
  return eq(expected, actual) ? PASS : fail(`tables: expected [${expected}] got [${actual}]`);
});

ASSERTIONS.set('data: schema-facts provision exactly the expected relationships', ({ facts, eval: ev }) => {
  const expected = sortedLc(ev.expect && ev.expect.relationships);
  const actual = facts.data.relationships.map((r) => r.schemaName).sort();
  return eq(expected, actual) ? PASS : fail(`relationships: expected [${expected}] got [${actual}]`);
});

// ui stage -------------------------------------------------------------------

ASSERTIONS.set('ui: wire-facts build exactly the expected views and charts', ({ facts, eval: ev }) => {
  const evV = sorted(ev.expect && ev.expect.views), acV = sorted(facts.ui.views.map((v) => v.name));
  if (!eq(evV, acV)) return fail(`views: expected [${evV}] got [${acV}]`);
  const evC = sorted(ev.expect && ev.expect.charts), acC = sorted(facts.ui.charts.map((c) => c.name));
  if (!eq(evC, acC)) return fail(`charts: expected [${evC}] got [${acC}]`);
  return PASS;
});

// expect.viewFilters = [{ entity, view, attr, op, value? }]: a filter the PROMPT names for a view (written here from the prompt, never
// read off the fixture being graded). It must appear among the view's compiled conditions, which are what the build reads from the
// supported filters[] { attr, op, value } shape; the active-records condition is not part of the comparison. A misspelled key
// (`filter`, `column`, `operator`) is ignored by the build, leaves no condition, and so fails here — as a missing filter does. The prompt
// names a filter on the view's own table, so a condition scoped to a joined table (a declared view's `relatedEntity`) does not satisfy it.
ASSERTIONS.set('ui: a view filter the prompt names is built from filters[] attr/op/value', ({ facts, eval: ev }) => {
  const expected = ev.expect && ev.expect.viewFilters;
  if (!Array.isArray(expected) || !expected.length) return fail('no independent view-filter expectations');
  for (const want of expected) {
    const view = facts.ui.views.find((v) => String(v.entity).toLowerCase() === String(want.entity).toLowerCase() && v.name === want.view);
    if (!view) return fail(`view '${want.view}' on ${want.entity} is not built`);
    const hit = view.conditions.some((c) => !c.scope && c.attribute === String(want.attr).toLowerCase() && c.operator === (want.op || 'eq')
      && (want.value === undefined ? c.value === undefined : c.value === String(want.value)));
    if (!hit) return fail(`view '${want.view}': no condition ${want.attr} ${want.op || 'eq'} ${want.value === undefined ? '' : JSON.stringify(want.value)}; got ${JSON.stringify(view.conditions)}`);
  }
  return PASS;
});

// #2 (default-view lookups not truncated) + #7 (enriched default views drop createdon).
ASSERTIONS.set('ui: enriched default views keep parent lookups and drop createdon', ({ facts }) => {
  const dv = (facts.ui && facts.ui.defaultViews) || {};
  const ents = Object.keys(dv);
  if (!ents.length) return skip('no enrichable entities in this spec');
  for (const [ent, f] of Object.entries(dv)) {
    if (f.hasCreatedon) return fail(`${ent} default view still includes createdon (#7)`);
    if (!f.lookupsPresent) return fail(`${ent} default view drops a parent lookup (#2)`);
  }
  return PASS;
});

// #5: every authored sub-grid gets its own full-width (1-column) section titled by a display name.
ASSERTIONS.set('ui: each sub-grid is a full-width section titled by the child display name', ({ facts }) => {
  const sgs = (facts.ui && facts.ui.subgrids) || [];
  if (!sgs.length) return skip('no sub-grids in this spec');
  for (const sg of sgs) {
    if (sg.sectionColumns !== 1) return fail(`sub-grid on ${sg.childEntity} is not a 1-column full-width section (got ${sg.sectionColumns})`);
    if (!sg.label || sg.label === sg.childEntity) return fail(`sub-grid on ${sg.childEntity} title "${sg.label}" is the logical name, not a display name`);
  }
  return PASS;
});

// app stage ------------------------------------------------------------------

ASSERTIONS.set('app: every sitemap subarea resolves to a concrete target (no dangling entity/page/dashboard)', ({ facts }) => {
  let bad = 0;
  for (const a of facts.app.areas) for (const g of a.groups) for (const s of g.subAreas) if (!s.ref) bad += 1;
  return bad ? fail(`${bad} subarea(s) with no resolved target`) : PASS;
});

ASSERTIONS.set('app: every navigatesTo target resolves to a known page key', ({ facts }) =>
  facts.app.danglingNav.length
    ? fail(`dangling nav: ${facts.app.danglingNav.join(', ')}`)
    : PASS);

// verify stage ---------------------------------------------------------------

ASSERTIONS.set('verify: reconcile against an all-present reader returns ok with no missing', ({ facts }) => {
  if (facts.verify.error) return fail(`verifySpec threw: ${facts.verify.error}`);
  if (facts.verify.skipped) return fail(`required verifySpec was skipped: ${facts.verify.skipped}`);
  return facts.verify.ok === true && facts.verify.missing.length === 0
    ? PASS
    : fail(`verify missing: ${facts.verify.missing.map((m) => `${m.kind} ${m.name}${m.detail ? ` (${m.detail})` : ''}`).join(', ')}`);
});

ASSERTIONS.set('verify: every required check kind actually ran', ({ facts }) => {
  const v = facts.verify;
  if (!v.requiredChecks) return fail('no required verification check manifest was computed');
  for (const [kind, expected] of Object.entries(v.requiredChecks)) {
    const ran = (v.checks || []).filter((c) => c.kind === kind).length;
    if (ran < expected) return fail(`required ${kind} check(s): expected at least ${expected}, ran ${ran}`);
  }
  return PASS;
});

ASSERTIONS.set('verify: served Main form order is checked or explicitly unavailable', ({ facts }) => {
  const v = facts.verify;
  if (v.error || v.skipped) return fail(`verification failed: ${v.error || v.skipped}`);
  const unavailable = (v.optionalUnavailable || []).find((c) => c.capability === 'servedMainForms');
  if (unavailable) return skip(unavailable.reason);
  const expected = (v.requiredChecks && v.requiredChecks['form-order-served']) || 0;
  if (!expected) return skip('no spec-declared Main form order to serve');
  const checks = (v.checks || []).filter((c) => c.kind === 'form-order-served');
  if (checks.length < expected) return fail(`form-order-served: expected ${expected} check(s), ran ${checks.length}`);
  const bad = checks.filter((c) => !c.present);
  return bad.length ? fail(bad.map((c) => `${c.kind} ${c.name}: ${c.detail}`).join('; ')) : PASS;
});

ASSERTIONS.set('changed-only: page bytes use a page-only fast path data-model edits use full and identical inputs are noop', ({ facts, eval: ev }) => {
  const f = facts.changedOnly;
  if (!f || f.error) return fail(f && f.error ? f.error : 'no real changed-only classification facts');
  if (!f.baselineVerified) return fail('changed-only baseline was not verified');
  if (!f.snapshot || f.snapshot.eligible !== true) return fail(`changed-only snapshot is not eligible: ${f.snapshot && f.snapshot.reason}`);
  const expected = ev.expect && ev.expect.changedOnly;
  if (!Array.isArray(expected) || !Array.isArray(f.cases) || f.cases.length !== expected.length) {
    return fail('changed-only case roster does not match the independent expectations');
  }
  for (const wanted of expected) {
    const actual = f.cases.find((c) => c.name === wanted.name);
    if (!actual) return fail(`changed-only case ${wanted.name} is missing`);
    if (actual.verdict !== wanted.verdict) return fail(`${wanted.name} verdict: expected ${wanted.verdict}, got ${actual.verdict}`);
    if (!eq(actual.changedPhases, wanted.changedPhases)) return fail(`${wanted.name} phases: expected [${wanted.changedPhases}], got [${actual.changedPhases}]`);
    const fast = (actual.fastChanges || []).map(({ shape, phase, identity }) => ({ shape, phase, identity }));
    if (!eq(fast, wanted.fastChanges)) return fail(`${wanted.name} fast changes: expected ${JSON.stringify(wanted.fastChanges)}, got ${JSON.stringify(fast)}`);
    if (!Array.isArray(actual.fullReasons) || actual.fullReasons.length !== wanted.fullReasons.length
      || wanted.fullReasons.some((prefix, i) => !actual.fullReasons[i].startsWith(prefix))) {
      return fail(`${wanted.name} full reason: expected ${JSON.stringify(wanted.fullReasons)}, got ${JSON.stringify(actual.fullReasons)}`);
    }
    if (!Array.isArray(actual.debt) || actual.debt.length) return fail(`${wanted.name}: unexpected changed-only debt ${JSON.stringify(actual.debt)}`);
  }
  return PASS;
});

// generate-pages stage -------------------------------------------------------

ASSERTIONS.set('generate-pages: no PAGEREF_ navigation target is left unresolved', ({ facts }) => {
  if (facts.page === null) return skip('pageref-resolver.js not landed');
  return facts.page.unresolved.length
    ? fail(`unresolved PAGEREF_: ${facts.page.unresolved.join(', ')}`)
    : PASS;
});

// teardown stage -------------------------------------------------------------

ASSERTIONS.set('teardown: the solution container is deleted last', ({ facts, spec }) => {
  if (!(spec.app && spec.solution)) return skip('spec declares no app + solution');
  const kinds = facts.teardown.kinds;
  return kinds[kinds.length - 1] === 'solution'
    ? PASS
    : fail(`last teardown step is "${kinds[kinds.length - 1]}", expected "solution"`);
});

ASSERTIONS.set('teardown: every declared table has a teardown step', ({ facts, spec }) => {
  const tableSteps = facts.teardown.kinds.filter((k) => k === 'table').length;
  const declared = (spec.entities || []).length;
  return tableSteps === declared
    ? PASS
    : fail(`expected ${declared} table teardown step(s), got ${tableSteps}`);
});

ASSERTIONS.set('teardown: web resources are deleted after tables', ({ facts }) => {
  const kinds = facts.teardown.kinds;
  const lastTable = kinds.lastIndexOf('table');
  const firstWr = kinds.indexOf('webResource');
  if (lastTable === -1 || firstWr === -1) return skip('no tables or no web-resource steps in this spec');
  return firstWr > lastTable
    ? PASS
    : fail(`a web-resource step (idx ${firstWr}) precedes the last table (idx ${lastTable}) — a table's icon web resource is referenced by the table`);
});

// round-trip (download → edit → rebuild) stage -------------------------------

ASSERTIONS.set('round-trip: download hydrate recovers the same solution and tables', ({ facts, spec }) => {
  if (facts.roundTrip.error) return fail(`hydrate threw: ${facts.roundTrip.error}`);
  const expSol = spec.solution && spec.solution.uniqueName;
  if (facts.roundTrip.solution !== expSol) return fail(`solution: expected "${expSol}" got "${facts.roundTrip.solution}"`);
  const expTables = sortedLc((spec.entities || []).map((e) => e.schemaName));
  return eq(expTables, facts.roundTrip.tables) ? PASS : fail(`tables: expected [${expTables}] got [${facts.roundTrip.tables}]`);
});

ASSERTIONS.set('round-trip: the sitemap round-trips with the same subareas', ({ facts }) => {
  if (facts.roundTrip.error) return fail(`hydrate threw: ${facts.roundTrip.error}`);
  return eq(facts.roundTrip.origSubareaTargets, facts.roundTrip.hydratedSubareaTargets)
    ? PASS
    : fail(`sitemap drift: authored [${facts.roundTrip.origSubareaTargets}] hydrated [${facts.roundTrip.hydratedSubareaTargets}]`);
});

// Hydration DEFAULTS a missing `directEntry` for back-compat with apps deployed before the field
// existed. That default must never overwrite an AUTHORED value — otherwise a round-trip silently
// changes app behaviour while every other losslessness assertion stays green, which is exactly what
// this eval exists to catch.
ASSERTIONS.set('round-trip: authored directEntry survives unchanged', ({ facts }) => {
  if (facts.roundTrip.error) return fail(`hydrate threw: ${facts.roundTrip.error}`);
  const before = JSON.stringify(facts.roundTrip.origDirectEntry || {});
  const after = JSON.stringify(facts.roundTrip.hydratedDirectEntry || {});
  return before === after ? PASS : fail(`directEntry drift: authored ${before} hydrated ${after}`);
});

ASSERTIONS.set('round-trip: generative pages preserve their keys', ({ facts, spec }) => {
  if (facts.roundTrip.error) return fail(`hydrate threw: ${facts.roundTrip.error}`);
  const expKeys = sorted((spec.pages || []).map((p) => p.key || p.name));
  if (!expKeys.length) return skip('spec declares no pages');
  return eq(expKeys, facts.roundTrip.pageKeys) ? PASS : fail(`page keys: expected [${expKeys}] got [${facts.roundTrip.pageKeys}]`);
});

ASSERTIONS.set('round-trip: generative pages preserve their names and models', ({ facts, spec }) => {
  const f = facts.roundTrip;
  if (f.error) return fail(`hydrate threw: ${f.error}`);
  if (!(spec.pages || []).length) return skip('spec declares no pages');
  for (const expected of spec.pages) {
    const key = expected.key || expected.name;
    const actual = (f.pageMetadata || []).find((p) => p.key === key);
    if (!actual) return fail(`page ${key}: name/model metadata is missing`);
    if (actual.name !== expected.name) return fail(`page ${key} name: expected ${JSON.stringify(expected.name)}, got ${JSON.stringify(actual.name)}`);
    const model = expected.model === undefined ? null : expected.model;
    if (actual.model !== model) return fail(`page ${key} model: expected ${JSON.stringify(model)}, got ${JSON.stringify(actual.model)}`);
  }
  return PASS;
});

ASSERTIONS.set('round-trip: invalid downloaded models are omitted with explicit diagnostics', ({ facts, eval: ev }) => {
  const f = facts.roundTrip;
  if (f.error) return fail(`hydrate threw: ${f.error}`);
  if (f.source !== 'pac-download-fixture') return fail('no real downloaded page/config fixture was read');
  if ((f.unreadableConfigs || []).length) return fail(`unreadable page config: ${JSON.stringify(f.unreadableConfigs)}`);
  const expected = ev.expect && ev.expect.unkeptModels;
  if (!Array.isArray(expected)) return fail('no independent invalid-model expectation');
  if (!eq(expected, f.unkeptModels)) return fail(`page model loss diagnostics: expected ${JSON.stringify(expected)}, got ${JSON.stringify(f.unkeptModels)}`);
  for (const dropped of expected) {
    const page = (f.pageMetadata || []).find((p) => p.pageId === dropped.pageId);
    if (!page || page.model !== null) return fail(`page ${dropped.pageId}: invalid model must be omitted, got ${JSON.stringify(page && page.model)}`);
  }
  return PASS;
});

ASSERTIONS.set('teardown: every declared dashboard has a teardown step', ({ facts, spec }) => {
  const declared = (spec.dashboards || []).length;
  if (!declared) return skip('spec declares no dashboards');
  const steps = facts.teardown.kinds.filter((k) => k === 'dashboard').length;
  return steps === declared ? PASS : fail(`expected ${declared} dashboard teardown step(s), got ${steps}`);
});

ASSERTIONS.set('teardown: every declared command bar has a teardown step', ({ facts, spec }) => {
  // The command bar is entity-keyed — one teardown step per entity that authors commands.
  const entities = new Set((spec.commands || []).map((c) => String(c.entity).toLowerCase()));
  if (!entities.size) return skip('spec declares no commands');
  const steps = facts.teardown.kinds.filter((k) => k === 'commands').length;
  return steps === entities.size ? PASS : fail(`expected ${entities.size} command-bar teardown step(s), got ${steps}`);
});

// declarative logic: businessRules[] + businessProcessFlows[] ------------------------------------
//
// Both surfaces share one failure mode that no downstream check catches: the platform ACCEPTS a
// definition whose column bindings are wrong or missing, and the artifact then simply does nothing.
// A business rule that binds a column the app never creates deploys, activates and never fires; a
// BPF is refused outright for a field-less step, but only at push time on a live environment.
//
// So these grade the BINDINGS, against the spec's own data model, from the same pure def builders
// the engine pushes. Each skips when the fixture declares none, so they are safe as common
// assertions across every fixture.

// Resolve the column names an entity legitimately offers a rule or a flow.
//
// This delegates to the plugin's own `declaredColumnLogicals` rather than re-deriving the set here.
// The first version of this helper did re-derive it, and guessed the lookup column as
// `rel.lookupName || '<referenced>id'` — but the App Spec stores the authored name at
// `rel.lookup.schemaName`. The consequence was the worst kind for an eval: with a custom lookup name
// it REJECTED correct builder output, and it ACCEPTED the default-named column the builder had not
// emitted. An oracle that can be wrong in both directions is worse than no oracle, so it now shares
// the production definition and cannot drift from it.
const boundColumnsFor = (spec, entityLogical) => {
  // `declaredColumnLogicals` keys on the spec's EXACT `schemaName`, while the facts carry the
  // lower-cased Dataverse logical name — so resolve back to the declared spelling first.
  const ent = (spec.entities || []).find((e) => e && String(e.schemaName || '').toLowerCase() === entityLogical);
  if (!ent) return null;
  return declaredColumnLogicals(spec, ent.schemaName);
};

ASSERTIONS.set('process: every business rule binds only columns the spec creates', ({ facts, spec }) => {
  const rules = (facts.process && facts.process.rules) || [];
  if (!rules.length) return skip('spec declares no business rules');
  const bad = [];
  for (const r of rules) {
    const cols = boundColumnsFor(spec, r.entity);
    if (!cols) { bad.push(`${r.name}: unknown entity '${r.entity}'`); continue; }
    // An EMPTY binding set is the dangerous case, not merely an unknown one: it is what a
    // mis-shaped condition tree produces, and it deploys as a rule with no clauses and no actions.
    if (!r.fields.length) { bad.push(`${r.name}: compiles to NO column bindings at all`); continue; }
    const unknown = r.fields.filter((f) => !cols.has(f));
    if (unknown.length) bad.push(`${r.name}: binds unknown column(s) ${unknown.join(', ')}`);
  }
  return bad.length ? fail(bad.join('; ')) : PASS;
});

ASSERTIONS.set('process: every business rule compiles at least one condition and one action', ({ facts }) => {
  const rules = (facts.process && facts.process.rules) || [];
  if (!rules.length) return skip('spec declares no business rules');
  const bad = rules.filter((r) => !r.operators.length || !r.actionTypes.length)
    .map((r) => `${r.name}: ${r.operators.length} condition(s), ${r.actionTypes.length} action(s)`);
  return bad.length ? fail(bad.join('; ')) : PASS;
});

ASSERTIONS.set('process: every BPF step binds a field on the flow entity', ({ facts, spec }) => {
  const flows = (facts.process && facts.process.flows) || [];
  if (!flows.length) return skip('spec declares no business process flows');
  const bad = [];
  for (const f of flows) {
    const cols = boundColumnsFor(spec, f.entity);
    if (!cols) { bad.push(`${f.name}: unknown entity '${f.entity}'`); continue; }
    if (!f.stages.length) { bad.push(`${f.name}: has no stages`); continue; }
    for (const st of f.stages) {
      if (!st.steps.length) bad.push(`${f.name}/${st.name}: stage has no steps`);
      // The platform rejects a field-less step outright ("datafieldname of ControlStep cannot be
      // null or empty"), so an unbound step is a build failure, not a cosmetic gap.
      for (const s of st.steps) {
        if (!s.field) bad.push(`${f.name}/${st.name}/${s.name}: step binds no field`);
        else if (!cols.has(s.field)) bad.push(`${f.name}/${st.name}/${s.name}: unknown column '${s.field}'`);
      }
    }
  }
  return bad.length ? fail(bad.join('; ')) : PASS;
});

ASSERTIONS.set('process: every BPF stage is scoped to the flow entity (v1 is single-entity)', ({ facts }) => {
  const flows = (facts.process && facts.process.flows) || [];
  if (!flows.length) return skip('spec declares no business process flows');
  const bad = flows.flatMap((f) => f.stages.filter((st) => st.entity !== f.entity)
    .map((st) => `${f.name}/${st.name}: stage entity '${st.entity}' != flow entity '${f.entity}'`));
  return bad.length ? fail(bad.join('; ')) : PASS;
});

ASSERTIONS.set('teardown: every declared business rule and process flow has a teardown step', ({ facts, spec }) => {
  const rules = (spec.businessRules || []).length;
  const flows = (spec.businessProcessFlows || []).length;
  if (!rules && !flows) return skip('spec declares no business rules or process flows');
  const ruleSteps = facts.teardown.kinds.filter((k) => k === 'businessRules').length;
  const flowSteps = facts.teardown.kinds.filter((k) => k === 'businessProcessFlows').length;
  if (ruleSteps !== rules) return fail(`expected ${rules} business-rule teardown step(s), got ${ruleSteps}`);
  if (flowSteps !== flows) return fail(`expected ${flows} process-flow teardown step(s), got ${flowSteps}`);
  return PASS;
});

// per-eval expectations (eval 5 "process logic") — the declarative-logic surfaces, by value --------

ASSERTIONS.set('the BPF stage order is Intake, Investigate, Resolve and every step binds a declared column', ({ facts }) => {
  const flow = (facts.process.flows || [])[0];
  if (!flow) return fail('no business process flow fact');
  const order = flow.stages.map((s) => s.name);
  if (!eq(order, ['Intake', 'Investigate', 'Resolve'])) return fail(`stage order = [${order}]`);
  // Stage order is positional, not a sortable field: the SDK emits stages in array order and the
  // stage bar renders them that way, so a mapping that reordered them would silently change the
  // process an agent is walked through.
  const unbound = flow.steps.filter((s) => !s.field).map((s) => `${s.stage}/${s.name}`);
  return unbound.length ? fail(`step(s) with no field: ${unbound.join(', ')}`) : PASS;
});

ASSERTIONS.set('the BPF binds the relationship lookup new_accountref, not just the case table’s own columns', ({ facts }) => {
  // A lookup column exists only because a relationship creates it, so it is absent from the
  // entity's `columns[]`. The fixture deliberately gives it a NON-DEFAULT name: an oracle that
  // guessed `<referenced>id` would agree with `new_customerid` here and so could neither reject a
  // builder that emitted the wrong column nor accept the right one.
  const flow = (facts.process.flows || [])[0];
  if (!flow) return fail('no business process flow fact');
  const fields = flow.steps.map((s) => s.field);
  return fields.includes('new_accountref') ? PASS : fail(`bound fields = [${fields}]`);
});

ASSERTIONS.set('a rule with two conditions compiles both, ANDed, and neither is dropped', ({ facts }) => {
  const rule = (facts.process.rules || []).find((r) => r.name === 'Hide the diagnosis until investigation starts');
  if (!rule) return fail('no two-condition rule fact');
  if (rule.operators.length !== 2) return fail(`compiled ${rule.operators.length} condition(s), expected 2: [${rule.operators}]`);
  // The presence operator carries no value, so a mapper that assumed every clause has one would
  // drop it — and the rule would then fire on status alone.
  if (!rule.operators.includes('DoesNotContainData')) return fail(`presence operator lost: [${rule.operators}]`);
  return rule.fields.includes('new_owner') ? PASS : fail(`the presence clause lost its column: [${rule.fields}]`);
});

ASSERTIONS.set('every business rule and the process flow each get exactly one teardown step', ({ facts, spec }) => {
  const rules = facts.teardown.kinds.filter((k) => k === 'businessRules').length;
  const flows = facts.teardown.kinds.filter((k) => k === 'businessProcessFlows').length;
  if (rules !== (spec.businessRules || []).length) return fail(`business-rule teardown steps = ${rules}`);
  if (flows !== (spec.businessProcessFlows || []).length) return fail(`process-flow teardown steps = ${flows}`);
  return PASS;
});

// per-eval expectations (eval 4 "hardening") — explicit, value-specific checks of each fix ---------

ASSERTIONS.set('the ticket default view keeps new_customerid even though the table has 8 scalar columns (#2)', ({ facts }) => {
  const dv = (facts.ui.defaultViews || {})['new_ticket'];
  if (!dv) return fail('new_ticket has no enriched default-view fact');
  return dv.columns.includes('new_customerid') ? PASS : fail(`new_ticket default view = [${dv.columns}] (missing new_customerid)`);
});

ASSERTIONS.set('no enriched default view carries createdon (#7)', ({ facts }) => {
  const bad = Object.entries(facts.ui.defaultViews || {}).filter(([, f]) => f.hasCreatedon).map(([e]) => e);
  return bad.length ? fail(`entities whose enriched default view still has createdon: ${bad.join(', ')}`) : PASS;
});

ASSERTIONS.set('the N:N relationship name is the alphabetically-sorted new_tag_new_ticket (#3)', ({ facts }) => {
  const names = facts.data.relationships.map((r) => r.schemaName);
  return names.includes('new_tag_new_ticket') ? PASS : fail(`relationship names = [${names}] (expected new_tag_new_ticket)`);
});

ASSERTIONS.set("the customer form's ticket sub-grid is a 1-column full-width section titled 'Tickets' from the child pluralName (#5)", ({ facts }) => {
  const sg = (facts.ui.subgrids || []).find((s) => s.childEntity === 'new_ticket');
  if (!sg) return fail('no new_ticket sub-grid fact');
  if (sg.sectionColumns !== 1) return fail(`sub-grid section columns = ${sg.sectionColumns} (expected 1)`);
  return sg.label === 'Tickets' ? PASS : fail(`sub-grid title = "${sg.label}" (expected "Tickets" from pluralName)`);
});

ASSERTIONS.set('validateAppSpec accepts the relational sample data: the $parent match resolves and the Choice labels are declared (#1/#4)', ({ facts }) =>
  facts.author.validate.ok ? PASS : fail(`validate errors: ${facts.author.validate.errors.join('; ')}`));

// #8: quick-create (IsQuickCreateEnabled) enabled on a table via schema-facts (explicit flag OR an
// authored QuickCreate form — the exact engine rule). Also assert the plan carries the enable step.
ASSERTIONS.set('quick create is enabled on the new_ticket table (#8)', ({ facts }) => {
  const t = (facts.data.tables || []).find((x) => x.logicalName === 'new_ticket');
  if (!t) return fail('no new_ticket table fact');
  if (t.quickCreate !== true) return fail('new_ticket.quickCreate fact is not true');
  const planned = (facts.plan.labels || []).some((l) => /enable quick create on new_ticket/.test(l));
  return planned ? PASS : fail('the build plan has no "enable quick create on new_ticket" step');
});

// --- form layout: the shape an author wrote must be the shape that ships (#575) ----------------
// An explicit `tabs` layout was FLATTENED on build: every field landed in the deployed form's first
// section and no tab / form-column / section was created or resized, so a hand-authored two-column
// form shipped as one long single-column list. It survived because the corpus graded a form's flat
// FIELD LIST and never its SHAPE — a flattened form has exactly the right fields.

ASSERTIONS.set('ui: an explicit layout compiles to the authored tab, form-column and section topology (it is not flattened)', ({ facts }) => {
  const explicit = (facts.ui.forms || []).filter((f) => f.authoredShape);
  if (!explicit.length) return skip('no form in this fixture declares an explicit layout');
  for (const f of explicit) {
    const a = f.authoredShape, c = f.compiledShape;
    if (a.length !== c.length) return fail(`form ${f.name}: ${a.length} tab(s) authored, ${c.length} compiled`);
    for (let i = 0; i < a.length; i++) {
      const at = a[i], ct = c[i], where = `form ${f.name} tab ${JSON.stringify(at.label)}`;
      if (at.label !== ct.label) return fail(`${where}: label became ${JSON.stringify(ct.label)}`);
      if (at.expanded !== ct.expanded) return fail(`${where}: expanded ${at.expanded} became ${ct.expanded}`);
      if (at.columnCount !== ct.columnCount) return fail(`${where}: ${at.columnCount} form-column(s) authored, ${ct.columnCount} compiled — a multi-column tab was collapsed`);
      // The authored projection includes the default percentage split, independently of the
      // compiler. Omission must not excuse a missing width or a 100/100 two-column layout.
      const widths = at.expectedWidths || at.declaredWidths;
      for (let wi = 0; wi < widths.length; wi++) {
        const w = widths[wi];
        if (w !== null && w !== ct.declaredWidths[wi]) return fail(`${where} form-column ${wi}: authored width ${w}, compiled ${ct.declaredWidths[wi]}`);
      }
      if (at.sectionsByColumn.length !== ct.sectionsByColumn.length) return fail(`${where}: ${at.sectionsByColumn.length} form-column(s) of sections authored, ${ct.sectionsByColumn.length} compiled`);
      // Compared PER FORM-COLUMN. A flat list would let a section that moved from column 0 to
      // column 1 pass whenever its order and fields were unchanged — the exact topology this
      // assertion exists to prove.
      for (let ci = 0; ci < at.sectionsByColumn.length; ci++) {
        const acol = at.sectionsByColumn[ci], ccol = ct.sectionsByColumn[ci];
        if (acol.length !== ccol.length) return fail(`${where} form-column ${ci}: ${acol.length} section(s) authored, ${ccol.length} compiled`);
        for (let si = 0; si < acol.length; si++) {
          const as = acol[si], cs = ccol[si];
          if (as.label !== cs.label) return fail(`${where} form-column ${ci} section ${si}: label ${JSON.stringify(as.label)} became ${JSON.stringify(cs.label)}`);
          if (as.columns !== cs.columns) return fail(`${where} form-column ${ci} section ${JSON.stringify(as.label)}: ${as.columns} grid column(s) authored, ${cs.columns} compiled`);
          if (!eq(as.fields, cs.fields)) return fail(`${where} form-column ${ci} section ${JSON.stringify(as.label)}: authored [${as.fields}] compiled [${cs.fields}]`);
        }
      }
    }
  }
  return PASS;
});

ASSERTIONS.set('ui: explicit container names display flags and field state match authored intent', ({ facts }) => {
  const explicit = (facts.ui.forms || []).filter((f) => f.authoredShape);
  if (!explicit.length) return skip('no form in this fixture declares an explicit layout');
  for (const f of explicit) {
    for (const [ti, tab] of f.authoredShape.entries()) {
      const compiled = (f.compiledShape || [])[ti];
      if (!compiled) return fail(`form ${f.name}: tab ${tab.name} was not compiled`);
      for (const key of ['name', 'visible']) if (tab[key] !== compiled[key]) {
        return fail(`form ${f.name} tab ${tab.name}: ${key} expected ${JSON.stringify(tab[key])}, got ${JSON.stringify(compiled[key])}`);
      }
      for (const [ci, sections] of tab.sectionsByColumn.entries()) for (const [si, section] of sections.entries()) {
        const actual = ((compiled.sectionsByColumn || [])[ci] || [])[si];
        if (!actual) return fail(`form ${f.name}: section ${section.name} was not compiled`);
        for (const key of ['name', 'visible', 'showLabel']) if (section[key] !== actual[key]) {
          return fail(`form ${f.name} section ${section.name}: ${key} expected ${JSON.stringify(section[key])}, got ${JSON.stringify(actual[key])}`);
        }
      }
    }
    for (const wanted of f.authoredPlacements || []) {
      const actual = (f.placements || []).find((p) => p.field === wanted.field && p.tab === wanted.tab && p.section === wanted.section);
      if (!actual) return fail(`form ${f.name}: field ${wanted.field} is missing from ${wanted.tab}/${wanted.section}`);
      for (const key of ['hidden', 'readOnly']) if (wanted[key] !== actual[key]) {
        return fail(`form ${f.name} field ${wanted.field}: ${key} expected ${wanted[key]}, got ${actual[key]}`);
      }
    }
  }
  return PASS;
});

ASSERTIONS.set('verify: form reconciliation exercises an inserted tab and reordered existing containers', ({ facts, eval: ev }) => {
  const f = facts.formReconcile;
  if (!f || f.error) return fail(f && f.error ? f.error : 'no independent form reconciliation baseline');
  if (!f.baselineValidation.ok) return fail(`baseline validation: ${f.baselineValidation.errors.join('; ')}`);
  const wanted = ev.expect && ev.expect.formReconcile;
  if (!wanted) return fail('no expected form reconciliation transition');
  const edit = f.edits.find((e) => e.entity === wanted.entity && e.name === wanted.form);
  if (!edit || !edit.before) return fail(`no baseline form ${wanted.form}`);
  const before = edit.before.map((t) => t.name), after = edit.after.map((t) => t.name);
  if (!eq(before, wanted.beforeTabs)) return fail(`baseline tab order: expected [${wanted.beforeTabs}], got [${before}]`);
  if (!eq(after, wanted.afterTabs)) return fail(`reconciled tab order: expected [${wanted.afterTabs}], got [${after}]`);
  const inserted = after.filter((t) => !before.includes(t));
  if (!eq(inserted, wanted.insertedTabs)) return fail(`inserted tabs: expected [${wanted.insertedTabs}], got [${inserted}]`);
  const sections = (shape) => shape.find((t) => t.name === wanted.sectionTab).sectionsByColumn[0].map((s) => s.name);
  if (!eq(sections(edit.before), wanted.beforeSections)) return fail('baseline section order does not exercise the requested reorder');
  if (!eq(sections(edit.after), wanted.afterSections)) return fail('reconciled section order does not match the requested reorder');
  const order = (rows) => (rows.find((r) => r.entity === wanted.entity) || {}).forms;
  if (!eq(order(f.beforeMainFormOrder), wanted.beforeMainFormOrder)) return fail('baseline Main form order does not match the fixture contract');
  if (!eq(order(f.afterMainFormOrder), wanted.afterMainFormOrder)) return fail('reconciled Main form order does not match the fixture contract');
  return PASS;
});

ASSERTIONS.set('verify: Quick View bindings survive form reconciliation', ({ facts, eval: ev }) => {
  const f = facts.formReconcile;
  if (!f || f.error) return fail(f && f.error ? f.error : 'no deployed Quick View evidence');
  const expected = ev.expect && ev.expect.formReconcile && ev.expect.formReconcile.quickViews;
  if (!expected || f.quickViews.length !== expected) return fail(`Quick View declarations: expected ${expected}, got ${f.quickViews.length}`);
  for (const qv of f.quickViews) {
    if (!qv.formId) return fail(`Quick View ${qv.host}/${qv.form}: target form could not be resolved`);
    if (!qv.deployed.length) return fail(`Quick View ${qv.host}/${qv.form} is missing`);
    const hits = qv.deployed.filter((p) => p.lookup === qv.lookup);
    if (hits.length !== 1) return fail(`Quick View ${qv.host}/${qv.form}: expected one lookup ${qv.lookup}, got ${hits.length}`);
    if (hits[0].classId !== '5c5600e0-1d6e-4205-a272-be80da87fd42') return fail(`Quick View ${qv.host}/${qv.form}: wrong control class`);
    if (hits[0].formId !== qv.formId || hits[0].targetEntity !== qv.targetEntity) {
      return fail(`Quick View ${qv.host}/${qv.form}: expected form ${qv.formId} on ${qv.targetEntity}, got ${hits[0].formId} on ${hits[0].targetEntity}`);
    }
  }
  return PASS;
});

// colspan/rowspan are the reason a two-column section is worth authoring at all — a full-width title
// over a two-up grid. Both are dropped silently by a serializer that does not carry them, so a form
// can look correct in the field list and still render as a plain stack.
ASSERTIONS.set('ui: an authored colspan and rowspan survive into the compiled cell', ({ facts, spec }) => {
  const wanted = [];
  for (const f of spec.forms || []) {
    for (const t of f.tabs || []) {
      const sections = Array.isArray(t.columns) ? t.columns.flatMap((c) => (c && c.sections) || []) : (t.sections || []);
      for (const s of sections) {
        for (const entry of s.fields || []) {
          if (entry && typeof entry === 'object' && (entry.colspan > 1 || entry.rowspan > 1)) {
            wanted.push({ form: f.name, field: String(entry.name).toLowerCase(), colspan: entry.colspan || 1, rowspan: entry.rowspan || 1 });
          }
        }
      }
    }
  }
  if (!wanted.length) return skip('no field in this fixture authors a colspan or rowspan');
  for (const w of wanted) {
    const form = (facts.ui.forms || []).find((x) => x.name === w.form);
    if (!form) return fail(`no compiled form named ${w.form}`);
    const cell = (form.placements || []).find((p) => p.field === w.field);
    if (!cell) return fail(`form ${w.form}: field ${w.field} was not placed at all`);
    if (cell.colspan !== w.colspan) return fail(`form ${w.form} field ${w.field}: authored colspan ${w.colspan}, compiled ${cell.colspan}`);
    if (cell.rowspan !== w.rowspan) return fail(`form ${w.form} field ${w.field}: authored rowspan ${w.rowspan}, compiled ${cell.rowspan}`);
  }
  return PASS;
});

// Universal — these hold on EVERY layout, auto included. The build-time reconcile MOVES a control
// that sits in the wrong section rather than placing a second copy, so a field appearing twice is
// the signature of a placement pass that created instead of moved. Dataverse accepts a duplicated
// control and renders both, so nothing downstream would report it.
ASSERTIONS.set('ui: every compiled form places each field exactly once', ({ facts }) => {
  for (const f of facts.ui.forms || []) {
    const seen = new Map();
    for (const p of f.placements || []) seen.set(p.field, (seen.get(p.field) || 0) + 1);
    const dupes = [...seen.entries()].filter(([, n]) => n > 1).map(([k, n]) => `${k}×${n}`);
    if (dupes.length) return fail(`form ${f.name} places ${dupes.join(', ')}`);
  }
  return PASS;
});

// The converse of the duplication guard: a topology pass that creates containers and a field pass
// that fills them can also drop a field on the floor — the form still builds, just without it.
//
// For an EXPLICIT layout the comparison is against what the AUTHOR wrote, not against
// formFieldLogicals(intent). That list is derived from the same compiled object as the placements,
// so a compiler that drops a field drops it from both sides and the two agree on the wrong answer —
// a tautology that mutation testing caught. The authored shape is an independent statement of intent.
ASSERTIONS.set('ui: every compiled form places exactly the fields it intends to carry', ({ facts }) => {
  for (const f of facts.ui.forms || []) {
    const placed = sorted([...new Set((f.placements || []).map((p) => p.field))]);
    const intended = f.authoredShape
      ? sorted([...new Set(f.authoredShape.flatMap((t) => t.sectionsByColumn.flat().flatMap((s) => s.fields)))])
      : sorted([...new Set((f.fields || []).map((x) => String(x).toLowerCase()))]);
    if (!eq(placed, intended)) {
      const missing = intended.filter((x) => !placed.includes(x));
      const extra = placed.filter((x) => !intended.includes(x));
      return fail(`form ${f.name}: missing [${missing}] unplaced-extra [${extra}]`);
    }
  }
  return PASS;
});

// --- download column projection: nothing invented, no shadows (#574) ---------------------------
// Creating a lookup also materialises `<lookup>name` / `<lookup>yominame` (and `<lookup>idtype` for a
// polymorphic one). A download that emits them declares Text columns the author never wrote, and the
// next rebuild CREATES them for real — replacing a lookup with text fields. The facts feed both
// shadow shapes (logical for a single-target lookup, physically stored for a polymorphic one) through
// the real projection, so a regression in either filter shows up here.
ASSERTIONS.set("round-trip: a lookup's shadow columns are never recovered as spec columns (#574)", ({ facts }) => {
  const rows = (facts.download || []).filter((r) => r.shadowNames.length);
  if (!rows.length) return skip('no table in this fixture carries a lookup');
  for (const r of rows) {
    const leaked = r.shadowNames.filter((s) => r.recoveredColumns.includes(s));
    if (leaked.length) return fail(`${r.entity}: download recovered shadow column(s) ${leaked.join(', ')}`);
  }
  return PASS;
});

// The general form of the same rule, and the one that catches a NEW invention rather than a known
// shadow spelling: a downloaded table must not declare a column the spec never authored. Stock
// attributes are the other half — `createdon` and friends feed defaultViewColumns, so recovering one
// would rewrite a customer's default views on the next build.
ASSERTIONS.set('round-trip: a download recovers no column the spec never authored', ({ facts }) => {
  for (const r of facts.download || []) {
    const invented = r.recoveredColumns.filter((c) => !r.authoredColumns.includes(c));
    if (invented.length) return fail(`${r.entity}: download invented column(s) ${invented.join(', ')}`);
    const system = r.systemAttributes.filter((c) => r.recoveredColumns.includes(c));
    if (system.length) return fail(`${r.entity}: download recovered stock attribute(s) ${system.join(', ')}`);
  }
  return PASS;
});

// per-eval expectations (evals 11-13)  2.21.0 schema authoring, graded against independent
// `expect` blocks so a fixture that drifts from its prompt fails rather than grading itself.

// Plugin versions compare numerically per part ("2.21.0" > "2.9.9").
const versionAtLeast = (v, min) => {
  const a = String(v || '0').split('.').map(Number); const b = min.split('.').map(Number);
  for (let i = 0; i < b.length; i++) { if ((a[i] || 0) !== b[i]) return (a[i] || 0) > b[i]; }
  return true;
};

// expect.optionValues keys are a global choice name ("cnt_region") or "<table>.<column>" for an
// inline choice, each mapping a value to the label the prompt gives it ({ "1": "North" }). Each must be
// written as an explicit { value, label } option carrying that label: as the label itself, or as the
// entry for the spec's base language (languageCode, default 1033) of an LCID label map. A swap of two
// labels keeps every number, so the number alone is not enough.
ASSERTIONS.set('author: option values the maker depends on are written as { value, label } and the spec asks for 2.21.0', ({ spec, eval: ev }) => {
  const expected = ev.expect && ev.expect.optionValues;
  if (!expected || !Object.keys(expected).length) return fail('no independent option-value expectations');
  if (!versionAtLeast(spec.minimumPluginVersion, '2.21.0')) return fail(`minimumPluginVersion ${spec.minimumPluginVersion || '(none)'} is below 2.21.0`);
  for (const [key, values] of Object.entries(expected)) {
    let options;
    if (key.includes('.')) {
      const [table, column] = key.split('.');
      const ent = (spec.entities || []).find((e) => e.schemaName === table);
      const col = ent && (ent.columns || []).find((c) => c.schemaName === column);
      options = col && col.options;
    } else {
      const gc = (spec.globalChoices || []).find((g) => g.name === key);
      options = gc && gc.options;
    }
    if (!Array.isArray(options)) return fail(`${key}: no options declared`);
    const base = String(spec.languageCode || 1033);
    for (const [value, label] of Object.entries(values)) {
      const opt = options.find((o) => o && typeof o === 'object' && o.value === Number(value) && o.label);
      if (!opt) return fail(`${key}: value ${value} not written as { value, label }`);
      const got = typeof opt.label === 'object' ? opt.label[base] : opt.label;
      if (got !== label) return fail(`${key}: value ${value} is labelled ${JSON.stringify(got)}, expected ${JSON.stringify(label)}`);
    }
  }
  return PASS;
});

// expect.dateTimeBehavior maps "<table>.<column>" to the behaviour the prompt implies; "UserLocal"
// also accepts an omitted behaviour, because UserLocal is the platform default.
ASSERTIONS.set('author: calendar days use DateOnly, a same-clock time uses TimeZoneIndependent, a per-user time is UserLocal or omitted', ({ spec, eval: ev }) => {
  const expected = ev.expect && ev.expect.dateTimeBehavior;
  if (!expected || !Object.keys(expected).length) return fail('no independent date behaviour expectations');
  for (const [key, want] of Object.entries(expected)) {
    const [table, column] = key.split('.');
    const ent = (spec.entities || []).find((e) => e.schemaName === table);
    const col = ent && (ent.columns || []).find((c) => c.schemaName === column);
    if (!col) return fail(`${key}: column not declared`);
    if (col.type !== 'DateTime') return fail(`${key}: type ${col.type}, expected DateTime`);
    const got = col.dateTimeBehavior;
    const ok = want === 'UserLocal' ? (got === undefined || got === 'UserLocal') : got === want;
    if (!ok) return fail(`${key}: dateTimeBehavior ${got === undefined ? '(omitted)' : got}, expected ${want}`);
  }
  return PASS;
});

// expect.fieldSecurity = { secured: ["<table>.<column>"], assigned: [profile keys], unassigned: [profile keys],
//   grants: { <profile key>: { "<table>.<column>": [rights] } }, principals: { <profile key>: { teams: [ids], users: [ids] } } }.
// The secured set must match exactly, every secured column needs a profile permission that grants
// something, and only the profiles the prompt names someone for may carry an assignment. The profile
// set and each profile's granted rights (every permission key set to true, so an unasked-for right
// fails too) must match `grants` exactly, and each assigned profile's teams and users must be the
// ones in `principals` (GUIDs compare case-insensitively; an absent kind means none).
ASSERTIONS.set('author: confidential columns are isSecured with explicit profiles; assignees are named, never inferred, and an unassigned profile says so', ({ spec, eval: ev }) => {
  const expected = ev.expect && ev.expect.fieldSecurity;
  if (!expected) return fail('no independent field security expectations');
  const secured = (spec.entities || []).flatMap((e) => (e.columns || []).filter((c) => c.isSecured === true).map((c) => `${e.schemaName}.${c.schemaName}`));
  if (!eq(sorted(secured), sorted(expected.secured))) return fail(`secured columns [${sorted(secured).join(', ')}], expected [${sorted(expected.secured).join(', ')}]`);
  const profiles = spec.fieldSecurityProfiles || [];
  const rights = (x) => Object.keys(x || {}).filter((k) => k !== 'table' && k !== 'column' && x[k] === true).sort();
  const covered = new Set(profiles.flatMap((p) => (p.permissions || []).filter((x) => rights(x).length).map((x) => `${x.table}.${x.column}`)));
  const uncovered = secured.filter((c) => !covered.has(c));
  if (uncovered.length) return fail(`secured column(s) with no profile permission: ${uncovered.join(', ')}`);
  const hasAssignee = (p) => !!(p.assignTo && ['teams', 'users'].some((k) => Array.isArray(p.assignTo[k]) && p.assignTo[k].length));
  const assigned = profiles.filter(hasAssignee).map((p) => p.key);
  const unassigned = profiles.filter((p) => !hasAssignee(p)).map((p) => p.key);
  if (!eq(sorted(assigned), sorted(expected.assigned))) return fail(`assigned profiles [${sorted(assigned).join(', ')}], expected [${sorted(expected.assigned).join(', ')}]`);
  if (!eq(sorted(unassigned), sorted(expected.unassigned))) return fail(`unassigned profiles [${sorted(unassigned).join(', ')}], expected [${sorted(expected.unassigned).join(', ')}]`);
  const grants = expected.grants || {};
  if (!eq(sorted(profiles.map((p) => p.key)), sorted(Object.keys(grants)))) return fail(`profiles [${sorted(profiles.map((p) => p.key)).join(', ')}], expected [${sorted(Object.keys(grants)).join(', ')}]`);
  for (const p of profiles) {
    const got = {};
    for (const x of p.permissions || []) {
      const r = rights(x);
      if (r.length) got[`${x.table}.${x.column}`] = sorted([...new Set([...(got[`${x.table}.${x.column}`] || []), ...r])]);
    }
    const want = Object.fromEntries(Object.entries(grants[p.key]).map(([c, r]) => [c, sorted(r)]));
    const norm = (o) => JSON.stringify(Object.keys(o).sort().map((k) => [k, o[k]]));
    if (norm(got) !== norm(want)) return fail(`${p.key}: grants ${norm(got)}, expected ${norm(want)}`);
    const named = (expected.principals || {})[p.key] || {};
    for (const kind of ['teams', 'users']) {
      const have = sortedLc((p.assignTo || {})[kind]);
      if (!eq(have, sortedLc(named[kind]))) return fail(`${p.key}: ${kind} [${have.join(', ')}], expected [${sortedLc(named[kind]).join(', ')}]`);
    }
  }
  return PASS;
});

// per-eval expectations (evals 14-15)  app membership authoring, graded against independent
// `expect.appMembership` blocks. "exact" removes forms from an existing app, so it must follow an
// explicit "only these forms" ask; an "add a form" ask expects mainFormsOnUpdate absent or "addOnly".
const sameNames = (a, b) => eq(sorted((a || []).map((n) => String(n).toLowerCase())), sorted((b || []).map((n) => String(n).toLowerCase())));
ASSERTIONS.set('author: "only these forms" lists them in app.mainForms with mainFormsOnUpdate "exact"; "add a form" never asks for exact', ({ spec, eval: ev }) => {
  const expected = ev.expect && ev.expect.appMembership;
  if (!expected || !expected.mainForms) return fail('no independent app membership expectations');
  if (!versionAtLeast(spec.minimumPluginVersion, '2.21.0')) return fail(`minimumPluginVersion ${spec.minimumPluginVersion || '(none)'} is below 2.21.0`);
  const app = spec.app || {};
  const listed = Object.fromEntries(Object.entries(app.mainForms || {}).map(([table, names]) => [table.toLowerCase(), names]));
  for (const [table, names] of Object.entries(expected.mainForms)) {
    if (!sameNames(listed[table.toLowerCase()], names)) return fail(`app.mainForms.${table} [${(listed[table.toLowerCase()] || []).join(', ')}], expected [${names.join(', ')}]`);
  }
  const want = expected.mainFormsOnUpdate || 'addOnly';
  const got = app.mainFormsOnUpdate || 'addOnly';
  return got === want ? PASS : fail(`app.mainFormsOnUpdate ${app.mainFormsOnUpdate === undefined ? '(omitted)' : app.mainFormsOnUpdate}, expected ${want}`);
});

// expect.appMembership.offNavigation names the tables the prompt keeps out of the navigation while asking
// for one of their charts or views; the fixture must really declare such an artifact, or the eval grades nothing.
ASSERTIONS.set('author: a new app with a chart or view of a table outside its navigation pins the declared artifacts', ({ spec, eval: ev }) => {
  const expected = ev.expect && ev.expect.appMembership;
  if (!expected || !Array.isArray(expected.offNavigation) || !expected.offNavigation.length) return fail('no independent off-navigation expectations');
  if (!versionAtLeast(spec.minimumPluginVersion, '2.21.0')) return fail(`minimumPluginVersion ${spec.minimumPluginVersion || '(none)'} is below 2.21.0`);
  const navigation = new Set(((spec.appShell && spec.appShell.areas) || []).flatMap((a) => (a.groups || []).flatMap((g) => g.subAreas || []))
    .filter((s) => s.entity).map((s) => String(s.entity).toLowerCase()));
  for (const table of expected.offNavigation) {
    const t = table.toLowerCase();
    if (navigation.has(t)) return fail(`${table} is in the navigation, expected outside it`);
    const artifacts = [...(spec.charts || []), ...(spec.views || [])].filter((a) => String(a.entity || '').toLowerCase() === t);
    if (!artifacts.length) return fail(`no chart or view of ${table} is declared`);
  }
  const app = spec.app || {};
  return (app.pinDeclaredArtifacts === true) === (expected.pinDeclaredArtifacts === true) ? PASS
    : fail(`app.pinDeclaredArtifacts ${app.pinDeclaredArtifacts === undefined ? '(omitted)' : app.pinDeclaredArtifacts}, expected ${expected.pinDeclaredArtifacts === true}`);
});

// Declared reconciliation (2.21.0, references/app-spec-schema-advanced.md). A new app authors every view and chart it
// declares, so each one is reconcile: "declared". The evals graded here ask for no declared form, dashboard, business rule or
// process flow (those are opt-in at the maker's request; fixtures 21–24 cover them), so in them nothing else may carry
// reconcile; a command `key` is refused in this version. A declared chart on a new table cannot store a title, and a declared view named like the table's stock
// "Active/Inactive <plural>" view would be an adoption on the very first build.
function declaredProblems(spec) {
  const problems = [];
  for (const v of spec.views || []) {
    if (v.reconcile !== 'declared') problems.push(`view '${v.name}' is not reconcile: "declared"`);
    const ent = (spec.entities || []).find((e) => String(e.schemaName).toLowerCase() === String(v.entity).toLowerCase());
    const plural = ent && typeof ent.pluralName === 'string' ? ent.pluralName.toLowerCase() : null;
    if (plural && [`active ${plural}`, `inactive ${plural}`].includes(String(v.name).toLowerCase())) problems.push(`view '${v.name}' is the stock default view's name`);
  }
  for (const ch of spec.charts || []) {
    if (ch.reconcile !== 'declared') problems.push(`chart '${ch.name}' is not reconcile: "declared"`);
    if (ch.title !== undefined) problems.push(`chart '${ch.name}' sets a title a new chart cannot store`);
  }
  for (const [kind, list] of Object.entries(spec)) {
    if (kind === 'views' || kind === 'charts' || !Array.isArray(list)) continue;
    for (const item of list) if (item && typeof item === 'object' && item.reconcile !== undefined) problems.push(`${kind} '${item.name || item.entity || '?'}' carries reconcile`);
  }
  const walk = (node, parentKey) => {
    if (Array.isArray(node)) { for (const x of node) { if (parentKey === 'commands' && x && typeof x === 'object' && x.key !== undefined) problems.push(`command '${x.label || x.name || x.key}' carries a key`); walk(x, null); } return; }
    if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) walk(v, k);
  };
  walk(spec, null);
  return problems;
}
ASSERTIONS.set('author: every view and chart of a new app is declared, and no other kind carries reconcile or a command key', ({ spec }) => {
  if (!(spec.views || []).length && !(spec.charts || []).length) return fail('the spec declares no view or chart');
  if (!versionAtLeast(spec.minimumPluginVersion, '2.21.0')) return fail(`minimumPluginVersion ${spec.minimumPluginVersion || '(none)'} is below 2.21.0`);
  const problems = declaredProblems(spec);
  return problems.length ? fail(problems.join('; ')) : PASS;
});

// expect.quickFind maps each new table to the identifiers the prompt says users search by. Every table the spec creates
// gets reviewed search columns: its primary name first among equals, plus those identifiers. Change tracking is not part
// of search, so it stays off unless the eval asks for it.
ASSERTIONS.set('author: each new table searches on its primary name plus the identifiers the prompt names', ({ spec, eval: ev }) => {
  const expected = ev.expect && ev.expect.quickFind;
  if (!expected || typeof expected !== 'object' || !Object.keys(expected).length) return fail('no independent search-column expectations');
  for (const e of spec.entities || []) {
    const table = String(e.schemaName).toLowerCase();
    const cols = e.quickFind && Array.isArray(e.quickFind.findColumns) ? e.quickFind.findColumns.map((c) => String(c).toLowerCase()) : null;
    if (!cols) return fail(`${table} declares no quickFind.findColumns`);
    if (new Set(cols).size !== cols.length) return fail(`${table} lists a search column twice`);
    const primary = e.primaryAttribute && String(e.primaryAttribute.schemaName || '').toLowerCase();
    if (primary && !cols.includes(primary)) return fail(`${table} does not search its primary name ${primary}`);
    for (const want of expected[table] || []) if (!cols.includes(want.toLowerCase())) return fail(`${table} does not search ${want}`);
    if (e.changeTrackingEnabled === true && ev.expect.changeTracking !== true) return fail(`${table} turns change tracking on unasked`);
  }
  for (const table of Object.keys(expected)) {
    if (!(spec.entities || []).some((e) => String(e.schemaName).toLowerCase() === table.toLowerCase())) return fail(`${table} is not a table the spec creates`);
  }
  return PASS;
});

// expect.linkEntities maps "<table>/<view name>" to the related tables the prompt asks that view to show. Exactly those
// views join, each one is declared (only a declared view applies its joins), and every related column names a join of its view.
ASSERTIONS.set('author: a column from a related table joins that table on the view that shows it, and only there', ({ spec, eval: ev }) => {
  const expected = ev.expect && ev.expect.linkEntities;
  if (!expected || typeof expected !== 'object' || !Object.keys(expected).length) return fail('no independent join expectations');
  const want = new Map(Object.entries(expected).map(([k, v]) => [k.toLowerCase(), v.map((t) => t.toLowerCase()).sort()]));
  for (const v of spec.views || []) {
    const id = `${String(v.entity).toLowerCase()}/${String(v.name).toLowerCase()}`;
    const links = Array.isArray(v.linkEntities) ? v.linkEntities : [];
    const related = (v.columns || []).filter((c) => c && typeof c === 'object' && c.relatedEntity !== undefined);
    if (!want.has(id)) {
      if (links.length || related.length) return fail(`view '${v.name}' joins a related table the prompt did not ask it to show`);
      continue;
    }
    if (v.reconcile !== 'declared') return fail(`view '${v.name}' joins but is not reconcile: "declared"`);
    const joined = links.map((l) => String(l.name).toLowerCase()).sort();
    if (JSON.stringify(joined) !== JSON.stringify(want.get(id))) return fail(`view '${v.name}' joins [${joined}], expected [${want.get(id)}]`);
    const handles = new Set(links.map((l) => String(l.alias || l.name).toLowerCase()));
    if (!related.length) return fail(`view '${v.name}' shows no column of the joined table`);
    for (const c of related) if (!handles.has(String(c.relatedEntity).toLowerCase())) return fail(`view '${v.name}' column ${c.name} names no join of the view (${c.relatedEntity})`);
    want.delete(id);
  }
  return want.size ? fail(`no view ${[...want.keys()].join(', ')}`) : PASS;
});

// per-eval expectations (eval 17 "declared web resource") — reconcile: "declared" on webResources[] (2.21.0). Graded
// against the eval's own expect.declaredWebResources, so a fixture that declares another resource fails.
ASSERTIONS.set('author: a web resource the maker asked to keep in step is declared, never shared, and is the only kind besides views and charts that carries reconcile', ({ facts, spec, eval: ev }) => {
  const want = (ev.expect && ev.expect.declaredWebResources) || [];
  if (!want.length) return fail('no independent declared-web-resource expectations');
  const declared = (spec.webResources || []).filter((w) => w && w.reconcile === 'declared');
  const names = declared.map((w) => String(w.name).toLowerCase()).sort();
  if (JSON.stringify(names) !== JSON.stringify(want.map((n) => n.toLowerCase()).sort())) return fail(`declared web resources [${names}], expected [${want}]`);
  if (declared.some((w) => w.external === true)) return fail('a declared web resource is external');
  if (!versionAtLeast(spec.minimumPluginVersion, '2.21.0')) return fail(`minimumPluginVersion ${spec.minimumPluginVersion || '(none)'} is below 2.21.0`);
  // The product's own gate (validateAppSpec): a spec that declares one without the floor is warned.
  const gate = (facts.author.validate.warnings || []).filter((w) => w.includes('minimumPluginVersion'));
  if (gate.length) return fail(gate.join('; '));
  for (const [kind, list] of Object.entries(spec)) {
    if (['views', 'charts', 'webResources'].includes(kind) || !Array.isArray(list)) continue;
    for (const item of list) if (item && typeof item === 'object' && item.reconcile !== undefined) return fail(`${kind} '${item.name || item.entity || '?'}' carries reconcile, which this release does not apply`);
  }
  return PASS;
});

// Configuration items (2.21.0, references/app-spec-schema.md → Configuration items). expect.configuration names, from
// the prompt alone, the items an app needs: its environment variables (and which are secrets), connection references,
// Custom APIs, the tables its duplicate rules are on, and the solution version. The spec declares exactly those, and
// carries no value that differs per environment: no current value, no connection id, and no defaultValue on a secret —
// those belong in the deployment-settings file the build reads, which is never part of the shared spec.
ASSERTIONS.set('author: each configuration item the prompt needs is declared, and no value that differs per environment is in the spec', ({ spec, eval: ev }) => {
  const want = ev.expect && ev.expect.configuration;
  if (!want || typeof want !== 'object') return fail('no independent configuration expectations');
  if (!versionAtLeast(spec.minimumPluginVersion, '2.21.0')) return fail(`minimumPluginVersion ${spec.minimumPluginVersion || '(none)'} is below 2.21.0`);
  const version = spec.solution && spec.solution.version;
  if ((want.solutionVersion || undefined) !== version) return fail(`solution.version ${version === undefined ? '(omitted)' : version}, expected ${want.solutionVersion || '(omitted)'}`);
  const list = (field) => (Array.isArray(spec[field]) ? spec[field] : []);
  const kinds = [
    ['environmentVariables', (e) => e.schemaName],
    ['connectionReferences', (e) => e.logicalName],
    ['customApis', (e) => e.uniqueName],
    ['duplicateDetectionRules', (e) => e.entity],
  ];
  for (const [field, keyOf] of kinds) {
    const got = sortedLc(list(field).map(keyOf));
    if (!eq(got, sortedLc(want[field]))) return fail(`${field} [${got}], expected [${sortedLc(want[field])}]`);
  }
  const secrets = sortedLc(list('environmentVariables').filter((v) => v.type === 'secret').map((v) => v.schemaName));
  if (!eq(secrets, sortedLc(want.secrets))) return fail(`secret variables [${secrets}], expected [${sortedLc(want.secrets)}]`);
  for (const v of list('environmentVariables')) {
    for (const key of ['value', 'currentValue']) if (v[key] !== undefined) return fail(`environment variable ${v.schemaName} states its ${key} in the spec`);
    if (v.type === 'secret' && v.defaultValue !== undefined) return fail(`secret variable ${v.schemaName} states a defaultValue in the spec`);
  }
  for (const r of list('connectionReferences')) if (r.connectionId !== undefined) return fail(`connection reference ${r.logicalName} states a connectionId in the spec`);
  return PASS;
});

// expect.appTheme (eval 19) states the branding the prompt asks for: the base colour, the header colours, a font only when
// the prompt names one, and whether it asks for a logo. A theme is Preview and only for an explicit branding ask, so a prompt
// with no expect.appTheme expects no app.theme at all. The logo must be an image web resource the spec declares, never a URL.
const IMAGE_WEB_RESOURCE_TYPES = new Set(['png', 'jpg', 'gif', 'svg', 'ico']);
const sameColour = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
ASSERTIONS.set('author: a theme is declared only on an explicit branding ask, with the asked colours, no unasked font, and a declared image web resource as the logo, never a URL', ({ spec, eval: ev }) => {
  const expected = ev.expect && ev.expect.appTheme;
  const theme = spec.app && spec.app.theme;
  if (!expected) return theme === undefined ? PASS : fail('app.theme is declared, but the prompt asks for no branding');
  if (!theme || typeof theme !== 'object') return fail('the prompt asks for branding, but app.theme is not declared');
  if (!versionAtLeast(spec.minimumPluginVersion, '2.21.0')) return fail(`minimumPluginVersion ${spec.minimumPluginVersion || '(none)'} is below 2.21.0`);
  if (expected.basePaletteColor && !sameColour(theme.basePaletteColor, expected.basePaletteColor)) return fail(`basePaletteColor ${theme.basePaletteColor || '(omitted)'}, expected ${expected.basePaletteColor}`);
  for (const [slot, colour] of Object.entries(expected.appHeader || {})) {
    const have = theme.appHeader && theme.appHeader[slot];
    if (!sameColour(have, colour)) return fail(`appHeader.${slot} ${have || '(omitted)'}, expected ${colour}`);
  }
  if (theme.font !== undefined && !expected.font) return fail(`font '${theme.font}' is declared, but the prompt names none`);
  const logo = theme.logo && theme.logo.webResourceName;
  if (!expected.logo) return logo === undefined ? PASS : fail('a logo is declared, but the prompt asks for none');
  if (typeof logo !== 'string' || !logo) return fail('the prompt asks for a logo, but app.theme.logo names no web resource');
  if (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(logo)) return fail(`the logo '${logo}' is a URL, not a web resource`);
  const declared = (spec.webResources || []).find((wr) => wr && String(wr.name).toLowerCase() === logo.toLowerCase());
  if (!declared) return fail(`the logo '${logo}' is not a declared web resource`);
  return IMAGE_WEB_RESOURCE_TYPES.has(String(declared.type || '').toLowerCase()) ? PASS : fail(`the logo '${logo}' is a ${declared.type || 'js'} web resource, not an image`);
});

// verify reads a declared theme once, as API state (verify-spec.js says so in the check's detail), and passes only a live one.
ASSERTIONS.set('verify: a declared app theme is read back once, as API state, and passes only when live', ({ facts }) => {
  const checks = ((facts.verify && facts.verify.checks) || []).filter((c) => c.kind === 'app-theme');
  if (checks.length !== 1) return fail(`${checks.length} app-theme checks, expected 1`);
  if (checks[0].present !== true) return fail(`app.theme did not verify: ${checks[0].detail}`);
  return /API state, not render proof/.test(checks[0].detail) ? PASS : fail(`the theme check does not say it is API state: ${checks[0].detail}`);
});

// expect.createIdentity (eval 20) is set only for a new-app prompt. Stable create ids change the ids the build creates
// with, so a spec the maker downloaded or already builds must never gain the field: with no expect.createIdentity the
// spec must not carry it. When set, it needs the 2.21.0 floor (an older plugin ignores the field and creates with fresh
// ids) and at least one declared view or chart, the only creates it covers in this release.
ASSERTIONS.set('author: a new app opts into stable create ids with the 2.21.0 floor, and a downloaded or existing spec never gains them', ({ spec, eval: ev }) => {
  const expected = ev.expect && ev.expect.createIdentity;
  if (!expected) return spec.createIdentity === undefined ? PASS : fail(`createIdentity ${JSON.stringify(spec.createIdentity)} is set, but the prompt is not a new app`);
  if (spec.createIdentity !== expected) return fail(`createIdentity ${JSON.stringify(spec.createIdentity)}, expected ${JSON.stringify(expected)}`);
  if (!versionAtLeast(spec.minimumPluginVersion, '2.21.0')) return fail(`minimumPluginVersion ${spec.minimumPluginVersion || '(none)'} is below 2.21.0`);
  const declared = [...(spec.views || []), ...(spec.charts || [])].filter((x) => x && x.reconcile === 'declared');
  return declared.length ? PASS : fail('createIdentity is set, but no view or chart is declared, so no create uses it');
});

// The stop on an unsent local edit is the stable-id behaviour a maker meets first, and it is stricter than a merge. The
// runner grades the spec alone, so the explanation is graded where the agent reads it: the /app-builder skill's
// createIdentity bullet. `facts.appBuilderSkill` lets a unit test grade a drifted copy without editing the real file.
const APP_BUILDER_SKILL = path.join(__dirname, '..', '..', '..', '..', 'plugins', 'model-apps', 'skills', 'app-builder', 'SKILL.md');
ASSERTIONS.set('author: the skill tells the maker that an unsent local edit stops a stable build and running again does not merge it', ({ facts }) => {
  let skill = facts && typeof facts.appBuilderSkill === 'string' ? facts.appBuilderSkill : null;
  if (skill === null) {
    try { skill = require('node:fs').readFileSync(APP_BUILDER_SKILL, 'utf8'); } catch (e) { return fail(`the app-builder skill cannot be read: ${e.message}`); }
  }
  // Bullets in the skill start a line with "- **"; the createIdentity guidance is one such bullet.
  const bullet = skill.replace(/\r\n/g, '\n').split(/\n(?=- \*\*)/).find((b) => b.includes('createIdentity'));
  if (!bullet) return fail('the skill has no createIdentity guidance');
  const needs = [
    [/stable-v1/, 'the value to write'],
    [/\bnew\*?\*? app/i, 'that it is for a new app'],
    [/downloaded/i, 'that a downloaded spec never gains it'],
    [/create-completion-required/, 'the stop it reports'],
    [/does not merge/i, 'that running again does not merge the edit'],
  ];
  const missing = needs.filter(([re]) => !re.test(bullet)).map(([, what]) => what);
  return missing.length ? fail(`the createIdentity guidance does not say ${missing.join(', ')}`) : PASS;
});

// Optional capabilities are OFF unless the maker asks for them (or says yes when /app-builder offers one; references/authoring-flow.md,
// Level (a0) and (b)). This suite grades the spec, not the conversation, so what it pins is the spec-level opt-in, in both directions,
// on EVERY fixture: the spec carries an app theme, a configuration item, or a declared form, dashboard, business rule or process flow
// only when the prompt asks for it (no expectation = none is allowed). Whether the offer itself is made needs a transcript of a
// conversation (EVAL_GUIDE.md, "Optional capabilities").
// It grades presence and absence by capability kind and table, and nothing else: a name, a stage label, a tile order or a scope is the
// maker's to choose and each eval's own specific assertions check the shape, so none of them is compared here.
//   expect.appTheme       as the theme assertion reads it (set = a theme is asked for)
//   expect.configuration  as the configuration assertion reads it (a non-empty list, or solutionVersion, is an ask)
//   expect.declared       { forms|dashboards|businessRules|businessProcessFlows: { tables: [table...], minCount: n } }
//                         for each kind the prompt asks to keep declared. The tables that carry a `reconcile: "declared"` artifact of
//                         that kind must be exactly `tables` (a dashboard has no table, so it states none), and there must be at least
//                         `minCount` of them (default 1) where the prompt states a count. A kind it does not list allows none.
const lc = (v) => String(v === undefined ? '' : v).toLowerCase();
const DECLARED_KINDS = ['forms', 'dashboards', 'businessRules', 'businessProcessFlows'];const CONFIGURATION_LISTS = ['environmentVariables', 'connectionReferences', 'customApis', 'duplicateDetectionRules'];
const nonEmptyList = (list) => Array.isArray(list) && list.length > 0;
ASSERTIONS.set('author: an optional capability is in the spec only when the prompt asks for it, and each one it asks for is authored as expected', ({ spec, eval: ev }) => {
  const expect = (ev && ev.expect) || {};
  const theme = spec.app && spec.app.theme;
  if (theme !== undefined && !expect.appTheme) return fail('app.theme is declared, but the prompt asks for no branding');
  if (theme === undefined && expect.appTheme) return fail('the prompt asks for branding, but app.theme is not declared');
  const config = expect.configuration && typeof expect.configuration === 'object' ? expect.configuration : {};
  for (const field of CONFIGURATION_LISTS) {
    const have = nonEmptyList(spec[field]);
    const want = nonEmptyList(config[field]);
    if (have && !want) return fail(`${field} is declared, but the prompt asks for no such configuration item`);
    if (!have && want) return fail(`the prompt asks for ${field} [${config[field]}], but the spec declares none`);
  }
  const version = spec.solution && spec.solution.version;
  if (version !== undefined && !config.solutionVersion) return fail(`solution.version ${version} is declared, but the prompt asks for no version`);
  if (version === undefined && config.solutionVersion) return fail(`the prompt asks for solution.version ${config.solutionVersion}, but the spec omits it`);
  const declaredExpect = expect.declared && typeof expect.declared === 'object' ? expect.declared : {};
  for (const kind of Object.keys(declaredExpect)) if (!DECLARED_KINDS.includes(kind)) return fail(`expect.declared names the unknown kind '${kind}'`);
  let anyDeclared = false;
  for (const kind of DECLARED_KINDS) {
    const got = (Array.isArray(spec[kind]) ? spec[kind] : []).filter((x) => x && typeof x === 'object' && x.reconcile === 'declared');
    const want = declaredExpect[kind];
    if (!want) {
      if (got.length) return fail(`${kind} declared on [${got.map((x) => x.entity || '(no table)')}], but the prompt asks to keep no ${kind} declared`);
      continue;
    }
    if (got.length < (want.minCount || 1)) return fail(`${kind}: ${got.length} declared, but the prompt asks for ${want.minCount || 1}; missing (deleted, or without reconcile "declared")`);
    if (Array.isArray(want.tables)) {
      const have = [...new Set(got.map((x) => lc(x.entity)))].sort();
      const asked = [...new Set(want.tables.map(lc))].sort();
      if (!eq(have, asked)) return fail(`${kind} declared on [${have}], the prompt asks for [${asked}]; unasked: [${have.filter((t) => !asked.includes(t))}], missing: [${asked.filter((t) => !have.includes(t))}]`);
    }
    anyDeclared = true;
  }
  if (anyDeclared && !versionAtLeast(spec.minimumPluginVersion, '2.21.0')) return fail(`minimumPluginVersion ${spec.minimumPluginVersion || '(none)'} is below 2.21.0`);
  return PASS;
});

// A maker who says no to business rules and process flows gets none of ANY kind: the declared-capability check above sees only
// `reconcile: "declared"`, and a plain rule or flow is authored without it. expect.noBusinessLogic is written from the prompt.
ASSERTIONS.set('author: a maker who declines business rules and process flows gets no rule and no flow of any kind', ({ spec, eval: ev }) => {
  if (!ev.expect || ev.expect.noBusinessLogic !== true) return fail('no independent expectation that the prompt declines business rules and process flows');
  for (const kind of ['businessRules', 'businessProcessFlows']) {
    if (nonEmptyList(spec[kind])) return fail(`${kind} is declared (${spec[kind].map((x) => (x && x.name) || '?').join(', ')}), but the prompt declines them`);
  }
  return PASS;
});

module.exports = { ASSERTIONS };