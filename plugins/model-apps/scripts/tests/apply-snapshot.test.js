'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const S = require('../lib/apply-snapshot.js');

const LIVE = { orgId: '00000000-0000-0000-0000-000000000abc', envUrl: 'https://org.crm.dynamics.com', appUniqueName: 'new_orders', appId: '11111111-1111-1111-1111-111111111111' };
const identity = () => ({ ...LIVE, solutionUniqueName: 'MySolution' });

// A verified, clean, eligible snapshot for the LIVE target (the only shape that may take the fast path).
function eligibleEnvelope() {
  const env = S.makeEnvelope(identity(), { generation: 'gen-1' });
  const r = S.markEligible(env);
  assert.ok(r.ok);
  return env;
}

test('fresh envelope is NOT eligible until a verified apply promotes it', () => {
  const env = S.makeEnvelope(identity(), { generation: 'g' });
  assert.strictEqual(env.eligible, false);
  assert.strictEqual(env.schema, S.SCHEMA);
  assert.strictEqual(S.isFastPathEligible(env, LIVE).eligible, false, 'a snapshot that never passed verify cannot fast-path');
});

test('markEligible on a clean snapshot -> fast path eligible against matching identity', () => {
  const env = eligibleEnvelope();
  const gate = S.isFastPathEligible(env, LIVE);
  assert.strictEqual(gate.eligible, true, gate.reason);
});

test('markEligible is FAIL-CLOSED with open debt (cannot bless a snapshot carrying debt)', () => {
  const env = S.makeEnvelope(identity(), { generation: 'g' });
  S.addDebt(env, { artifactType: 'chart', identity: 'new_order|Revenue', reason: 'chart-edit-not-convergent' });
  const r = S.markEligible(env);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(env.eligible, false, 'debt must keep eligible false');
  assert.match(r.reason, /debt/);
  assert.strictEqual(S.isFastPathEligible(env, LIVE).eligible, false);
});

test('adding debt to an ALREADY-eligible snapshot disqualifies it at the gate (invariant 3)', () => {
  const env = eligibleEnvelope();
  assert.strictEqual(S.isFastPathEligible(env, LIVE).eligible, true);
  S.addDebt(env, { artifactType: 'command', identity: 'new_order|Approve', reason: 'command-edit-not-convergent' });
  const gate = S.isFastPathEligible(env, LIVE);
  assert.strictEqual(gate.eligible, false);
  assert.match(gate.reason, /debt/);
});

test('identity mismatch on orgId / envUrl / appUniqueName / appId each blocks the fast path', () => {
  const env = eligibleEnvelope();
  assert.match(S.isFastPathEligible(env, { ...LIVE, orgId: 'ffffffff-0000-0000-0000-000000000000' }).reason, /orgId/);
  assert.match(S.isFastPathEligible(env, { ...LIVE, envUrl: 'https://other.crm.dynamics.com' }).reason, /envUrl/);
  assert.match(S.isFastPathEligible(env, { ...LIVE, appUniqueName: 'new_other' }).reason, /appUniqueName/);
  // app deleted + recreated under the same unique name -> different appId GUID -> stale ids.
  assert.match(S.isFastPathEligible(env, { ...LIVE, appId: '99999999-9999-9999-9999-999999999999' }).reason, /appId/);
});

test('identity normalization: brace/case/trailing-slash noise still matches (no false mismatch)', () => {
  const env = eligibleEnvelope();
  const noisy = {
    orgId: '{00000000-0000-0000-0000-000000000ABC}',
    envUrl: 'https://ORG.crm.dynamics.com/',
    appUniqueName: 'NEW_Orders',
    appId: '{11111111-1111-1111-1111-111111111111}',
  };
  assert.strictEqual(S.isFastPathEligible(env, noisy).eligible, true, S.isFastPathEligible(env, noisy).reason);
});

test('missing orgId/envUrl/appUniqueName on EITHER side is a mismatch (never a vacuous match)', () => {
  const env = eligibleEnvelope();
  assert.strictEqual(S.identityMatches(env, {}).ok, false);
  const bare = S.makeEnvelope({ envUrl: LIVE.envUrl, appUniqueName: LIVE.appUniqueName }, { generation: 'g' }); // no orgId
  S.markEligible(bare);
  assert.strictEqual(S.identityMatches(bare, LIVE).ok, false, 'a snapshot with no orgId cannot match a live org');
});

test('a snapshot that recorded an appId requires a NON-NULL matching live appId (deleted-app hole, C1)', () => {
  const env = eligibleEnvelope(); // records appId app-1...
  // App deleted (or discovery failed) -> live.appId is null. A snapshot that recorded an appId must NOT
  // vacuously match — else an eligible snapshot survives its app being deleted into a false noop.
  const live = { ...LIVE, appId: null };
  const idm = S.identityMatches(env, live);
  assert.strictEqual(idm.ok, false);
  assert.match(idm.reason, /app not found live/);
  assert.strictEqual(S.isFastPathEligible(env, live).eligible, false, 'no fast path against a vanished app');
});

test('tombstone: eligible->false + teardown debt, and the gate refuses even a previously-eligible snapshot', () => {
  const env = eligibleEnvelope();
  S.tombstone(env);
  assert.strictEqual(env.eligible, false);
  assert.ok(S.isTombstoned(env));
  assert.ok(env.debt.some((d) => d.reason === S.TEARDOWN_DEBT_REASON));
  const gate = S.isFastPathEligible(env, LIVE);
  assert.strictEqual(gate.eligible, false);
  assert.match(gate.reason, /tombstone/);
});

test('markIneligible forces eligible:false (the invalidate-before-write step), idempotently', () => {
  const env = eligibleEnvelope();
  S.markIneligible(env);
  assert.strictEqual(env.eligible, false);
  S.markIneligible(env); // idempotent
  assert.strictEqual(env.eligible, false);
});

test('addDebt dedups identical entries but keeps distinct ones', () => {
  const env = S.makeEnvelope(identity(), { generation: 'g' });
  S.addDebt(env, { artifactType: 'view', identity: 'new_order|Active', reason: 'column-removed' });
  S.addDebt(env, { artifactType: 'view', identity: 'new_order|Active', reason: 'column-removed' }); // dup
  S.addDebt(env, { artifactType: 'view', identity: 'new_order|Active', reason: 'width-changed' }); // distinct reason
  assert.strictEqual(env.debt.length, 2);
});

test('clearDebtMatching clears ONLY entries matching the predicate reason (placement clear ≠ event clear)', () => {
  const env = S.makeEnvelope(identity(), { generation: 'g' });
  S.addDebt(env, { artifactType: 'form', identity: 'new_order|Main', reason: 'placement-drift' });
  S.addDebt(env, { artifactType: 'form', identity: 'new_order|Main', reason: 'form-event-edit' });
  // A placement re-verify may clear ONLY the placement debt — it must NOT clear the event debt.
  S.clearDebtMatching(env, (d) => d.reason === 'placement-drift');
  assert.strictEqual(env.debt.length, 1);
  assert.strictEqual(env.debt[0].reason, 'form-event-edit');
  // With the event debt still open, the snapshot cannot become eligible.
  assert.strictEqual(S.markEligible(env).ok, false);
});

test('clearDebtMatching with a THROWING predicate keeps all debt (fail-closed)', () => {
  const env = S.makeEnvelope(identity(), { generation: 'g' });
  S.addDebt(env, { artifactType: 'view', identity: 'v', reason: 'r' });
  S.clearDebtMatching(env, () => { throw new Error('boom'); });
  assert.strictEqual(env.debt.length, 1, 'a throwing predicate must not wipe debt');
});

test('generation CAS: matches only the exact token; a concurrent re-write is detected', () => {
  const env = eligibleEnvelope(); // generation 'gen-1'
  assert.strictEqual(S.generationMatches(env, 'gen-1'), true);
  assert.strictEqual(S.generationMatches(env, 'gen-2'), false, 'a different generation means someone else re-wrote the snapshot');
  assert.strictEqual(S.generationMatches(env, undefined), false);
  const bumped = S.bumpGeneration({ ...env }, 'gen-2');
  assert.strictEqual(bumped.generation, 'gen-2');
});

test('isFastPathEligible requires a generation token (needed for the write-CAS)', () => {
  const env = eligibleEnvelope();
  env.generation = null;
  const gate = S.isFastPathEligible(env, LIVE);
  assert.strictEqual(gate.eligible, false);
  assert.match(gate.reason, /generation/);
});

test('parseEnvelope is fail-closed: bad JSON, wrong schema, and non-objects all -> null', () => {
  assert.strictEqual(S.parseEnvelope('{not json'), null);
  assert.strictEqual(S.parseEnvelope(JSON.stringify({ schema: 2, debt: [] })), null, 'a foreign schema is unusable');
  assert.strictEqual(S.parseEnvelope(JSON.stringify({ schema: S.SCHEMA })), null, 'missing debt array is malformed');
  assert.strictEqual(S.parseEnvelope(null), null);
  assert.strictEqual(S.parseEnvelope('null'), null);
});

test('serializeEnvelope round-trips through parseEnvelope', () => {
  const env = eligibleEnvelope();
  const round = S.parseEnvelope(S.serializeEnvelope(env));
  assert.ok(round);
  assert.strictEqual(round.eligible, true);
  assert.strictEqual(round.generation, 'gen-1');
  assert.strictEqual(S.isFastPathEligible(round, LIVE).eligible, true);
});

test('isFastPathEligible on null/garbage is false, never throws', () => {
  assert.strictEqual(S.isFastPathEligible(null, LIVE).eligible, false);
  assert.strictEqual(S.isFastPathEligible({ foo: 1 }, LIVE).eligible, false);
  assert.strictEqual(S.isFastPathEligible(eligibleEnvelope(), null).eligible, false, 'no live identity -> cannot match');
});

test('full lifecycle: apply(clean)->eligible, then unsupported edit->ineligible+debt, then fresh recreate clears debt->eligible again', () => {
  const env = eligibleEnvelope();
  assert.strictEqual(S.isFastPathEligible(env, LIVE).eligible, true);
  // An unsupported chart edit arrives: invalidate BEFORE writing, and record debt.
  S.markIneligible(env);
  S.addDebt(env, { artifactType: 'chart', identity: 'new_order|Rev', reason: 'chart-edit-not-convergent' });
  assert.strictEqual(S.markEligible(env).ok, false, 'still ineligible while debt is open');
  // A later full build PROVES the chart was recreated fresh (verifier matches the specific debt) -> clear it.
  S.clearDebtMatching(env, (d) => d.artifactType === 'chart' && d.identity === 'new_order|Rev' && d.reason === 'chart-edit-not-convergent');
  const r = S.markEligible(env);
  assert.strictEqual(r.ok, true, r.reason);
  assert.strictEqual(S.isFastPathEligible(env, LIVE).eligible, true);
});
