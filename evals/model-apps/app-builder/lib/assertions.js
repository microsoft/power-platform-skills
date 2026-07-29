'use strict';
// Maps each assertion text in evals.json to a check function receiving { facts, spec, eval } and
// returning { status: 'pass'|'fail'|'skip', reason? }. Mirrors evals/model-apps/genpage/lib/assertions-*.js.
// Register every text in common_stage_assertions here; any unregistered text gets a SKIP.
const PASS = { status: 'pass' };
const fail = (reason) => ({ status: 'fail', reason });
const skip = (reason) => ({ status: 'skip', reason });
const sortedLc = (a) => (a || []).map((s) => String(s).toLowerCase()).sort();
const sorted = (a) => (a || []).map(String).sort();
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

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
  const planned = (facts.plan.byPhase && facts.plan.byPhase.security) || 0;
  return declared === planned ? PASS : fail(`declared ${declared} persona(s) but planned ${planned} security role item(s)`);
});

ASSERTIONS.set('security: each app-access persona role injects app-module read; opted-out personas do not', ({ facts }) => {
  const missing = (facts.security || []).filter((r) => r.appAccess && !r.appModuleRead);
  if (missing.length) return fail(`app-access personas missing app-module read: ${missing.map((r) => r.persona).join(', ')}`);
  const leaked = (facts.security || []).filter((r) => !r.appAccess && r.appModuleRead);
  if (leaked.length) return fail(`opted-out personas wrongly granted app-module read: ${leaked.map((r) => r.persona).join(', ')}`);
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
  if (facts.verify.skipped) return skip(`verifySpec needs a reader method not synthesized here (Plan 3): ${facts.verify.skipped}`);
  return facts.verify.ok
    ? PASS
    : fail(`verify missing: ${facts.verify.missing.map((m) => `${m.kind} ${m.name}`).join(', ')}`);
});

// generate-pages stage -------------------------------------------------------

ASSERTIONS.set('generate-pages: no PAGEREF_ navigation target is left unresolved', ({ facts }) => {
  if (facts.page === null) return skip('pageref-resolver.js not landed (Plan 3)');
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

ASSERTIONS.set('round-trip: generative pages preserve their keys', ({ facts, spec }) => {
  if (facts.roundTrip.error) return fail(`hydrate threw: ${facts.roundTrip.error}`);
  const expKeys = sorted((spec.pages || []).map((p) => p.key || p.name));
  if (!expKeys.length) return skip('spec declares no pages');
  return eq(expKeys, facts.roundTrip.pageKeys) ? PASS : fail(`page keys: expected [${expKeys}] got [${facts.roundTrip.pageKeys}]`);
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

module.exports = { ASSERTIONS };