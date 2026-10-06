'use strict';
// build-model-app.js `persistAppliedBaseline`: when a build records its spec as the environment's
// deployed baseline (`.maker-workspace/last-applied.json`).
//
// The baseline is what the next build lines the live sitemap up against (AB#6726727): a nav entry the
// designer changed since the baseline is kept, one the spec changed is written. So recording it after
// a run that did NOT deploy the whole spec — a dry run, a partial `--phases` run, or an apply whose
// verify found a silent partial — would make the next build treat undeployed spec values as deployed,
// and revert designer changes it should have kept.
const test = require('node:test');
const assert = require('node:assert');

const { persistAppliedBaseline } = require('../build-model-app.js');
const { PHASES } = require('../lib/stages.js');

const spec = { app: { name: 'A', uniqueName: 'new_a' } };
const ctx = (opts) => ({ spec, opts, workspaceDir: '/ws', appDirAbs: '/app', baselineIdentity: { environment: 'https://contoso.crm.dynamics.com', appUniqueName: 'new_a' } });
function recorder({ fail } = {}) {
  const calls = [];
  const write = (...args) => { calls.push(args); if (fail) throw new Error('disk full'); };
  return { calls, write };
}

test('a verified full apply records the spec, its environment and app, the ids it created, and the previous baseline', () => {
  const { calls, write } = recorder();
  const created = { dashboards: { Ops: 'd1' }, pages: { home: 'p1' } };
  const previous = { app: { name: 'old' } };
  const r = { ok: true, verify: { ok: true }, created };
  assert.strictEqual(persistAppliedBaseline(r, ctx({ apply: true, baselineSpec: previous }), write), true);
  assert.deepStrictEqual(calls, [['/ws', spec, { appDir: '/app', environment: 'https://contoso.crm.dynamics.com', appUniqueName: 'new_a', created, previous }]]);
});

test('an apply without verify is recorded; one whose verify failed is not (a silent partial is not the deployed state)', () => {
  for (const [verify, want] of [[undefined, true], [{ ok: true }, true], [{ ok: false }, false]]) {
    const { calls, write } = recorder();
    assert.strictEqual(persistAppliedBaseline({ ok: true, verify }, ctx({ apply: true }), write), want, JSON.stringify(verify));
    assert.strictEqual(calls.length, want ? 1 : 0);
  }
});

test('nothing is recorded for a failed build, a dry run, or a run that was not an apply', () => {
  for (const [r, opts] of [
    [{ ok: false }, { apply: true }],
    [{ ok: true, dryRun: true }, { apply: true }],
    [{ ok: true }, { apply: false }],
    [{ ok: true }, {}],
    [null, { apply: true }],
  ]) {
    const { calls, write } = recorder();
    assert.strictEqual(persistAppliedBaseline(r, ctx(opts), write), false, JSON.stringify([r, opts]));
    assert.deepStrictEqual(calls, []);
  }
});

test('a partial --phases apply is not the whole desired state and is not recorded — unless it is a changed-only apply', () => {
  const partial = { apply: true, phases: PHASES.slice(0, 2) };
  const { calls, write } = recorder();
  assert.strictEqual(persistAppliedBaseline({ ok: true }, ctx(partial), write), false);
  assert.strictEqual(persistAppliedBaseline({ ok: true }, ctx({ apply: true, phases: [...PHASES] }), write), true, 'every phase listed is a full apply');
  for (const decision of ['fast', 'full']) {
    assert.strictEqual(persistAppliedBaseline({ ok: true, changedOnly: { decision } }, ctx(partial), write), true, decision);
  }
  assert.strictEqual(persistAppliedBaseline({ ok: true, changedOnly: { decision: 'refused' } }, ctx(partial), write), false);
  assert.strictEqual(calls.length, 3);
});

test('a baseline that cannot be written never fails the build', () => {
  const { calls, write } = recorder({ fail: true });
  assert.strictEqual(persistAppliedBaseline({ ok: true }, ctx({ apply: true }), write), false);
  assert.strictEqual(calls.length, 1);
});
