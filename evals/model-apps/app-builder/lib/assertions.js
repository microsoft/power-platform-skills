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

module.exports = { ASSERTIONS };
