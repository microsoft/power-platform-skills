'use strict';
// `surfaces[]` was documentary only, so a job could claim a screen that exists nowhere in the spec
// and every gate stayed green. These tests pin the resolution and — just as importantly — pin that
// an unresolved surface stays a WARNING, because a surface may legitimately name an out-of-the-box
// artifact this spec never authors.
const { test } = require('node:test');
const assert = require('node:assert');
const { resolveSurfaces, declaredSurfaces, unresolvedSurfaceMessage } = require('../lib/surface-resolver.js');
const { lintAppSpec } = require('../lib/spec-lint.js');
const { validateAppSpec } = require('../lib/app-spec.js');

const base = () => ({
  schemaVersion: 2,
  solution: { uniqueName: 'S', publisherPrefix: 'new' },
  app: { name: 'Field Service' },
  entities: [{
    schemaName: 'new_workorder',
    displayName: 'Work Order',
    primaryAttribute: { schemaName: 'new_name', displayName: 'Name' },
    columns: [{ schemaName: 'new_status', displayName: 'Status', type: 'Text' }],
  }],
  views: [{ entity: 'new_workorder', name: 'My Open Work Orders', columns: ['new_name'] }],
  forms: [{ entity: 'new_workorder', type: 'main', name: 'Work Order' }],
  pages: [{ key: 'overview', name: 'Overview', purpose: 'KPIs', source: { kind: 'tsx', codeFile: 'overview.tsx' } }],
  dashboards: [],
  appShell: { areas: [{ label: 'Main', groups: [{ label: 'Work', subAreas: [{ entity: 'new_workorder', title: 'Work Orders' }, { page: 'overview', title: 'Overview' }] }] }] },
  personas: [],
});

const withJob = (surfaces) => {
  const s = base();
  s.personas = [{ persona: 'Technician', jobs: [{ name: 'Complete work orders', surfaces, privileges: [{ entity: 'new_workorder', access: ['read', 'write'] }] }] }];
  return s;
};

test('declaredSurfaces flattens every (persona, job, surface) triple', () => {
  const spec = withJob(['My Open Work Orders', 'Work Order']);
  assert.deepStrictEqual(declaredSurfaces(spec), [
    { persona: 'Technician', job: 'Complete work orders', surface: 'My Open Work Orders' },
    { persona: 'Technician', job: 'Complete work orders', surface: 'Work Order' },
  ]);
});

test('a surface resolves against every artifact kind an author might name', () => {
  for (const [surface, kind] of [
    ['My Open Work Orders', 'view'],
    ['Overview', 'page'],       // page by display name
    ['overview', 'page'],       // page by stable key
    ['Work Order', 'form'],     // also matches the entity display name — see the multi-match test
    ['Work Orders', 'subarea'], // the NAV entry is a legitimate answer to "what lets them do the job"
    ['new_workorder', 'entity'],
  ]) {
    const r = resolveSurfaces(withJob([surface]));
    assert.deepStrictEqual(r.unresolved, [], `${surface} should resolve`);
    assert.ok(r.resolved[0].matches.some((m) => m.kind === kind), `${surface} should match kind ${kind}, got ${JSON.stringify(r.resolved[0].matches)}`);
  }
});

// Precedence is deliberately NOT invented: a name that legitimately identifies two artifacts reports
// both, so a human sees the ambiguity instead of the resolver silently picking one.
test('a name matching several artifacts reports every match rather than picking one', () => {
  const r = resolveSurfaces(withJob(['Work Order']));
  const kinds = r.resolved[0].matches.map((m) => m.kind).sort();
  assert.deepStrictEqual(kinds, ['entity', 'form']);
});

test('matching is case- and whitespace-insensitive', () => {
  const r = resolveSurfaces(withJob(['  mY oPeN wOrK oRdErS  ']));
  assert.deepStrictEqual(r.unresolved, []);
  assert.strictEqual(r.resolved[0].matches[0].kind, 'view');
});

// THE case this check exists for.
test('a surface naming nothing in the spec is reported as unresolved', () => {
  const r = resolveSurfaces(withJob(['Overdue Escalations']));
  assert.deepStrictEqual(r.resolved, []);
  assert.strictEqual(r.unresolved.length, 1);
  assert.strictEqual(r.unresolved[0].surface, 'Overdue Escalations');
  assert.match(unresolvedSurfaceMessage(r.unresolved[0]), /surface "Overdue Escalations" does not match/);
});

test('a job with no surfaces[] contributes nothing (spec-lint already warns about it)', () => {
  const spec = base();
  spec.personas = [{ persona: 'Tech', jobs: [{ name: 'j', privileges: [{ entity: 'new_workorder', access: ['read'] }] }] }];
  assert.deepStrictEqual(resolveSurfaces(spec), { resolved: [], unresolved: [] });
});

test('resolveSurfaces tolerates a malformed spec without throwing', () => {
  for (const bad of [null, undefined, 'x', 42, []]) {
    assert.doesNotThrow(() => resolveSurfaces(bad));
  }
  assert.deepStrictEqual(resolveSurfaces({ personas: [null, { jobs: [null, { surfaces: [null, '', 'x'] }] }] }).unresolved.length, 1);
});

// --- wiring -------------------------------------------------------------------------------------

test('spec-lint WARNS on an unresolved surface and does not block the spec', () => {
  const spec = withJob(['Overdue Escalations']);
  const r = lintAppSpec(spec);
  assert.strictEqual(r.errors.filter((e) => /Overdue Escalations/.test(e)).length, 0, 'must not be a blocking error');
  assert.strictEqual(r.warnings.filter((w) => /surface "Overdue Escalations" does not match/.test(w)).length, 1);
});

// An out-of-the-box artifact is the documented reason validation is loose; it must keep validating.
test('a spec naming an OOB surface still VALIDATES (warning only)', () => {
  const spec = withJob(['Active Accounts']);
  assert.strictEqual(validateAppSpec(spec).ok, true, 'an unresolved surface is never a hard error');
  assert.ok(lintAppSpec(spec).warnings.some((w) => /Active Accounts/.test(w)));
});

test('spec-lint stays silent when every surface resolves', () => {
  const r = lintAppSpec(withJob(['My Open Work Orders', 'Overview']));
  assert.deepStrictEqual(r.warnings.filter((w) => /does not match any view/.test(w)), []);
});

// --- verifySpec job-surface rollup ---------------------------------------------------------------
// A PURE rollup over checks already computed: it translates a technical failure ("view X missing")
// into the business impact it caused ("Technician cannot Complete work orders").
const { verifySpec } = require('../lib/verify-spec.js');

const reader = (present) => ({
  findTable: async () => ({ LogicalName: 'new_workorder' }),
  findColumns: async () => [{ logicalName: 'new_status' }],
  // The view exists only when `present`; that is the failure the rollup must attribute to the job.
  queryRecords: async (set) => (set === 'savedquery' && present ? [{ savedqueryid: 'v1' }] : []),
  sitemapXml: async () => '',
});

test('a job whose surface failed to deploy is reported as a job-surface failure', async () => {
  const spec = withJob(['My Open Work Orders']);
  const r = await verifySpec(spec, reader(false));
  const c = r.checks.find((x) => x.kind === 'job-surface');
  assert.ok(c && !c.present, JSON.stringify(r.checks.filter((x) => x.kind === 'job-surface')));
  assert.strictEqual(c.name, 'Technician → Complete work orders');
  assert.match(c.detail, /surface "My Open Work Orders" is not deployed/);
});

test('no job-surface check is emitted when every surface deployed', async () => {
  const r = await verifySpec(withJob(['My Open Work Orders']), reader(true));
  assert.deepStrictEqual(r.checks.filter((x) => x.kind === 'job-surface'), []);
});

// An unresolved surface may name an out-of-the-box artifact, so it must NOT become a deploy-time
// failure — spec-lint already warns about it at authoring time.
test('an UNRESOLVED surface does not fail verify', async () => {
  const r = await verifySpec(withJob(['Active Accounts']), reader(true));
  assert.deepStrictEqual(r.checks.filter((x) => x.kind === 'job-surface'), []);
});
