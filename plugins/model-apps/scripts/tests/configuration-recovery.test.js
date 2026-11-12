'use strict';
// GET-only recovery of interrupted configuration create units (#807): the read-only context, the observation and its outcome
// precedence, inspect, the prepare/resolve flow, deferral and the build guard. The fake service answers only GETs and records every
// request, so each flow can prove it never wrote.
const { makeTempDir } = require('./helpers/temp-dirs.js');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { sha256 } = require('../lib/hash.js');
const S = require('../lib/configuration-create-state.js');
const R = require('../lib/configuration-create-recovery.js');

const KIND_TABLE = {
  'env-definition': { root: true, parentKinds: [], publicFields: { schemaname: 'string', displayname: 'string', type: 'integer', description: 'nullable-string' }, privateFields: ['defaultValue', 'valueSchema'] },
  'env-value': { root: false, parentKinds: ['env-definition'], publicFields: { schemaname: 'string' }, privateFields: ['value'] },
  'connection-reference': { root: true, parentKinds: [], publicFields: { connectionreferencelogicalname: 'string', connectorid: 'string', displayname: 'nullable-string' }, privateFields: ['connectionId'] },
  'custom-api': { root: true, parentKinds: [], publicFields: { uniquename: 'string', bindingtype: 'integer', isfunction: 'boolean', plugintypeid: 'nullable-guid' }, privateFields: [] },
  'api-request': { root: false, parentKinds: ['custom-api'], publicFields: { uniquename: 'string', type: 'integer', isoptional: 'boolean' }, privateFields: [] },
  'api-response': { root: false, parentKinds: ['custom-api'], publicFields: { uniquename: 'string', type: 'integer' }, privateFields: [] },
  'duplicate-rule': { root: true, parentKinds: [], publicFields: { name: 'string', baseentityname: 'string', matchingentityname: 'string', iscasesensitive: 'boolean' }, privateFields: [] },
  'rule-condition': { root: false, parentKinds: ['duplicate-rule'], publicFields: { baseattributename: 'string', matchingattributename: 'string', operatorcode: 'integer' }, privateFields: [] },
};
const kt = { kindTable: KIND_TABLE };
const CONTEXT = S.createStateContext({ environmentUrl: 'https://contoso.crm.dynamics.com', solutionUniqueName: 'ContosoSolution', appUniqueName: 'contoso_app', authoringLanguageCode: 1033 });
const OTHER_CONTEXT = S.createStateContext({ environmentUrl: 'https://fabrikam.crm.dynamics.com', solutionUniqueName: 'ContosoSolution', appUniqueName: 'contoso_app', authoringLanguageCode: 1033 });
const G = () => crypto.randomUUID();
const H = (s) => sha256(String(s));
const CANARY = 'CANARY-41d9-private-current-value';

function envUnit({ key = 'contoso_Setting', rootRole = 'create' } = {}) {
  const defId = G();
  return {
    root: { kind: 'env-definition', key, id: defId }, publicIntentSha256: H(`intent ${key}`), publicPlanSha256: H(`plan ${key}`), publicationRequired: false,
    rows: [
      { kind: 'env-definition', key, id: defId, parentId: null, role: rootRole, public: { schemaname: key, displayname: 'Setting', type: 100000000, description: null }, privateFields: ['defaultValue', 'valueSchema'] },
      { kind: 'env-value', key: `${key}.value`, id: G(), parentId: defId, role: 'create', public: { schemaname: key }, privateFields: ['value'] },
    ],
  };
}
function apiUnit({ key = 'contoso_DoThing', rootRole = 'create' } = {}) {
  const apiId = G();
  return {
    root: { kind: 'custom-api', key, id: apiId }, publicIntentSha256: H(`intent ${key}`), publicPlanSha256: H(`plan ${key}`), publicationRequired: false,
    rows: [
      { kind: 'custom-api', key, id: apiId, parentId: null, role: rootRole, public: { uniquename: key, bindingtype: 0, isfunction: false, plugintypeid: null }, privateFields: [] },
      { kind: 'api-request', key: `${key}.Input`, id: G(), parentId: apiId, role: 'create', public: { uniquename: `${key}.Input`, type: 10, isoptional: false }, privateFields: [] },
    ],
  };
}
function ruleUnit({ key = 'contoso_rule', publicationRequired = true, rootRole = 'create' } = {}) {
  const ruleId = G();
  return {
    root: { kind: 'duplicate-rule', key, id: ruleId }, publicIntentSha256: H(`intent ${key}`), publicPlanSha256: H(`plan ${key}`), publicationRequired,
    rows: [
      { kind: 'duplicate-rule', key, id: ruleId, parentId: null, role: rootRole, public: { name: key, baseentityname: 'account', matchingentityname: 'account', iscasesensitive: false }, privateFields: [] },
      { kind: 'rule-condition', key: `${key}.name`, id: G(), parentId: ruleId, role: 'create', public: { baseattributename: 'name', matchingattributename: 'name', operatorcode: 0 }, privateFields: [] },
    ],
  };
}

// A fake service: rows by id, and a transport that records every request and refuses every method but GET.
function fakeService() {
  const rows = new Map();
  const membership = new Map();
  const calls = [];
  const fail = new Set();
  const transport = (method, url) => {
    calls.push({ method, url });
    if (method !== 'GET') throw new Error('the fake service accepts only GET');
    if (fail.has(url)) throw new Error('503');
  };
  const ports = {
    readRow: async (kind, id) => {
      transport('GET', `${kind}(${id})`);
      const r = rows.get(id);
      return r ? { ok: true, row: JSON.parse(JSON.stringify(r)) } : { ok: false, missing: true };
    },
    readChildren: async (kind, id) => {
      transport('GET', `${kind}(${id})/children`);
      return { ok: true, children: [...rows.values()].filter((r) => r.parentId === id).map((r) => ({ kind: r.kind, row: JSON.parse(JSON.stringify(r)) })) };
    },
    readMembership: async (kind, id) => {
      transport('GET', `membership(${id})`);
      if (membership.get(id) === 'not-required') return { ok: true, required: false };
      return { ok: true, member: membership.has(id) ? membership.get(id) : true };
    },
    projectObserved: (kind, row) => ({ id: row.id, parentId: row.parentId, public: row.public }),
  };
  const seed = (unit, { lifecycle } = {}) => {
    for (const r of unit.rows) rows.set(r.id, { kind: r.kind, id: r.id, parentId: r.parentId, public: { ...r.public }, ...(r.kind === 'duplicate-rule' ? { statuscode: lifecycle === undefined ? (unit.publication ? 2 : 0) : lifecycle } : {}) });
  };
  return { rows, membership, calls, fail, ports, seed, writes: () => calls.filter((c) => c.method !== 'GET').length };
}

const ws = () => makeTempDir('cc-recovery-');
const prepare = (dir, unit) => S.prepareCreateUnit(dir, { kindTable: KIND_TABLE, context: CONTEXT, unit });
const unitOf = (dir, unitId) => S.readConfigurationCreateState(dir, kt).units.find((u) => u.unitId === unitId);
function sealAll(handle, unit) {
  for (const r of unit.rows.filter((x) => x.role === 'create')) S.sealCreateRow(handle, r.id);
}
// A unit interrupted after its rows were sent: every create row dispatched, as a build that crashed after the requests leaves it.
function interrupted(dir, unit) {
  const h = prepare(dir, unit);
  sealAll(h, unit);
  return unitOf(dir, h.unitId);
}

async function rejectsCode(fn, code) {
  let caught;
  try { await fn(); } catch (e) { caught = e; }
  assert.ok(caught, `expected ${code}, nothing was thrown`);
  assert.equal(caught.code, code, caught.message);
  assert.equal(caught.retry, 'never');
  return caught;
}

test('the recovery context accepts exactly the four read ports', async () => {
  const svc = fakeService();
  const ctx = R.createReadOnlyRecoveryContext(svc.ports);
  assert.ok(Object.isFrozen(ctx));
  assert.ok(R.isReadOnlyRecoveryContext(ctx));
  for (const extra of ['post', 'patch', 'delete', 'request']) {
    assert.throws(() => R.createReadOnlyRecoveryContext({ ...svc.ports, [extra]: () => {} }), { code: 'configuration-create-shape-refused' });
  }
  const { readMembership, ...three } = svc.ports;
  void readMembership;
  assert.throws(() => R.createReadOnlyRecoveryContext(three), { code: 'configuration-create-shape-refused' });
  assert.throws(() => R.createReadOnlyRecoveryContext({ ...svc.ports, readRow: 'GET' }), { code: 'configuration-create-shape-refused' });
  // A look-alike object with the same four functions is not a recovery context.
  const dir = ws();
  const unit = interrupted(dir, apiUnit());
  await rejectsCode(() => R.observeRecordedUnit({ ...svc.ports }, unit, kt), 'configuration-create-shape-refused');
  assert.equal(svc.calls.length, 0);
});

test('a complete matching graph is a match, read with GETs only', async () => {
  const dir = ws();
  const svc = fakeService();
  const unit = interrupted(dir, envUnit());
  svc.seed(unit);
  const ctx = R.createReadOnlyRecoveryContext(svc.ports);
  const obs = await R.observeRecordedUnit(ctx, unit, kt);
  assert.equal(obs.outcome, 'match');
  assert.match(obs.observedPublicSha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(obs.rows.map((r) => r.status), ['match', 'match']);
  assert.equal(obs.children.status, 'complete');
  assert.ok(svc.calls.length > 0);
  assert.equal(svc.writes(), 0);
  const again = await R.observeRecordedUnit(ctx, unit, kt);
  assert.equal(again.observedPublicSha256, obs.observedPublicSha256, 'the same graph hashes the same');
});

test('each difference maps to its outcome, and the worst one wins', async () => {
  const cases = [
    ['missing create row', (svc, u) => svc.rows.delete(u.rows[1].id), 'configuration-create-row-missing'],
    ['moved row', (svc, u) => { svc.rows.get(u.rows[1].id).parentId = G(); }, 'configuration-create-identity-conflict'],
    ['edited field', (svc, u) => { svc.rows.get(u.rows[0].id).public.displayname = 'Edited'; }, 'configuration-create-content-conflict'],
    ['unexpected child', (svc, u) => svc.rows.set('x', { kind: 'env-value', id: G(), parentId: u.root.id, public: { schemaname: 'x' } }), 'configuration-create-content-conflict'],
    ['read failure', (svc, u) => svc.fail.add(`env-value(${u.rows[1].id})`), 'configuration-create-graph-unreadable'],
    ['children read failure', (svc, u) => svc.fail.add(`env-definition(${u.root.id})/children`), 'configuration-create-graph-unreadable'],
    ['private field in a projection', (svc, u) => { svc.rows.get(u.rows[1].id).public.value = CANARY; }, 'configuration-create-graph-unreadable'],
    ['membership absent', (svc, u) => svc.membership.set(u.root.id, false), 'configuration-create-membership-incomplete'],
    ['membership unreadable', (svc, u) => svc.fail.add(`membership(${u.root.id})`), 'configuration-create-membership-incomplete'],
    ['unreadable outranks a conflict', (svc, u) => { svc.rows.get(u.rows[0].id).public.displayname = 'Edited'; svc.fail.add(`env-value(${u.rows[1].id})`); }, 'configuration-create-graph-unreadable'],
    ['identity outranks content', (svc, u) => { svc.rows.get(u.rows[0].id).public.displayname = 'Edited'; svc.rows.get(u.rows[1].id).parentId = G(); }, 'configuration-create-identity-conflict'],
    ['content outranks missing', (svc, u) => { svc.rows.get(u.rows[0].id).public.displayname = 'Edited'; svc.rows.delete(u.rows[1].id); }, 'configuration-create-content-conflict'],
    ['missing outranks membership', (svc, u) => { svc.rows.delete(u.rows[1].id); svc.membership.set(u.root.id, false); }, 'configuration-create-row-missing'],
  ];
  for (const [name, mutate, code] of cases) {
    const dir = ws();
    const svc = fakeService();
    const unit = interrupted(dir, envUnit());
    svc.seed(unit);
    mutate(svc, unit);
    const obs = await R.observeRecordedUnit(R.createReadOnlyRecoveryContext(svc.ports), unit, kt);
    assert.equal(obs.outcome, code, name);
    assert.ok(!JSON.stringify(obs).includes(CANARY), `${name}: an observed value is never echoed`);
    assert.equal(svc.writes(), 0);
  }
});

test('the child list and the exact reads must agree', async () => {
  const dir = ws();
  const svc = fakeService();
  const unit = interrupted(dir, apiUnit());
  svc.seed(unit);
  const listed = { ...svc.ports, readChildren: async () => ({ ok: true, children: [] }) };
  assert.equal((await R.observeRecordedUnit(R.createReadOnlyRecoveryContext(listed), unit, kt)).outcome, 'configuration-create-graph-unreadable', 'a present child the list misses');
  const twice = { ...svc.ports, readChildren: async () => { const r = svc.rows.get(unit.rows[1].id); return { ok: true, children: [{ kind: r.kind, row: r }, { kind: r.kind, row: r }] }; } };
  assert.equal((await R.observeRecordedUnit(R.createReadOnlyRecoveryContext(twice), unit, kt)).outcome, 'configuration-create-graph-unreadable', 'a child listed twice');
  const ghost = { ...svc.ports, readRow: async (kind, id) => (id === unit.rows[1].id ? { ok: false, missing: true } : svc.ports.readRow(kind, id)) };
  assert.equal((await R.observeRecordedUnit(R.createReadOnlyRecoveryContext(ghost), unit, kt)).outcome, 'configuration-create-graph-unreadable', 'a child listed but missing by id');
  const weird = { ...svc.ports, readRow: async () => ({ ok: true }) };
  assert.equal((await R.observeRecordedUnit(R.createReadOnlyRecoveryContext(weird), unit, kt)).outcome, 'configuration-create-graph-unreadable', 'an answer of an unknown shape');
});

test('a new rule must be published, and a rule without a publication slot must stay unpublished', async () => {
  const outcomes = {};
  for (const [name, publicationRequired, statuscode] of [['published', true, 2], ['unpublished', true, 0], ['publishing', true, 1], ['unknown', true, 7], ['kept unpublished', false, 0], ['published without slot', false, 2]]) {
    const dir = ws();
    const svc = fakeService();
    const unit = interrupted(dir, ruleUnit({ publicationRequired, rootRole: publicationRequired ? 'create' : 'preserved' }));
    svc.seed(unit, { lifecycle: statuscode });
    outcomes[name] = (await R.observeRecordedUnit(R.createReadOnlyRecoveryContext(svc.ports), unit, kt)).outcome;
  }
  assert.deepEqual(outcomes, {
    published: 'match',
    unpublished: 'configuration-create-publication-pending',
    publishing: 'configuration-create-publication-pending',
    unknown: 'configuration-create-graph-unreadable',
    'kept unpublished': 'match',
    'published without slot': 'configuration-create-content-conflict',
  });
  // A port may name the lifecycle itself.
  const dir = ws();
  const svc = fakeService();
  const unit = interrupted(dir, ruleUnit());
  svc.seed(unit, { lifecycle: 0 });
  const named = { ...svc.ports, projectObserved: (kind, row) => ({ id: row.id, parentId: row.parentId, public: row.public, ...(kind === 'duplicate-rule' ? { lifecycle: 'published' } : {}) }) };
  assert.equal((await R.observeRecordedUnit(R.createReadOnlyRecoveryContext(named), unit, kt)).outcome, 'match');
});

test('inspect classifies dispatch and describes, without executing, the creates a missing row needs', async () => {
  const dir = ws();
  const svc = fakeService();
  const unit = interrupted(dir, envUnit({ rootRole: 'preserved' }));
  svc.seed(unit);
  svc.rows.delete(unit.rows[1].id);
  const ctx = R.createReadOnlyRecoveryContext(svc.ports);
  const report = await R.inspectCreateUnit(ctx, unit, kt);
  assert.equal(report.dispatch, 'possibly-dispatched');
  assert.equal(report.halt.code, 'configuration-create-row-missing');
  assert.deepEqual(report.manualCompletion, [{ kind: 'env-value', id: unit.rows[1].id, parentId: unit.root.id, key: unit.rows[1].key, public: { schemaname: 'contoso_Setting' }, privateFields: ['value'] }]);
  assert.equal(svc.writes(), 0);

  // A missing preserved row is a conflict: no recipe recreates it.
  const dir2 = ws();
  const svc2 = fakeService();
  const unit2 = interrupted(dir2, envUnit({ rootRole: 'preserved' }));
  svc2.seed(unit2);
  svc2.rows.delete(unit2.rows[0].id);
  const report2 = await R.inspectCreateUnit(R.createReadOnlyRecoveryContext(svc2.ports), unit2, kt);
  assert.ok(!report2.manualCompletion.some((m) => m.id === unit2.rows[0].id));
  assert.match(report2.halt.message, /never recreated/);

  const dir3 = ws();
  const svc3 = fakeService();
  const h3 = prepare(dir3, apiUnit());
  const report3 = await R.inspectCreateUnit(R.createReadOnlyRecoveryContext(svc3.ports), unitOf(dir3, h3.unitId), kt);
  assert.equal(report3.dispatch, 'not-dispatched');
});

// ── Prepare and resolve ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
function options(dir, unit, extra = {}) {
  return { workspaceDir: dir, kindTable: KIND_TABLE, context: CONTEXT, unitId: unit.unitId, currentPublicIntentSha256: unit.publicIntentSha256, invalidate: () => ({ ok: true }), ...extra };
}

test('accept-current: prepare binds the observation, resolve re-observes, invalidates the snapshot and removes the unit', async () => {
  const dir = ws();
  const svc = fakeService();
  const unit = interrupted(dir, apiUnit());
  svc.seed(unit);
  const ctx = R.createReadOnlyRecoveryContext(svc.ports);
  const drafts = [];
  const checkLocalDrafts = () => drafts.push('checked');
  const offer = await R.prepareConfigurationResolution(ctx, options(dir, unit, { mode: 'accept-current', checkLocalDrafts }));
  assert.equal(offer.observation.outcome, 'match');
  const invalidated = [];
  const res = await R.resolveConfigurationResolution(ctx, options(dir, unit, {
    mode: 'accept-current', token: offer.token, checkLocalDrafts,
    invalidate: (root) => { invalidated.push(root, unitOf(dir, unit.unitId) ? 'unit still saved' : 'unit gone'); return { ok: true }; },
  }));
  assert.deepEqual(drafts, ['checked', 'checked']);
  assert.deepEqual(invalidated, [path.resolve(dir), 'unit still saved'], 'the snapshot is invalidated before the unit is removed');
  assert.equal(res.removed, true);
  assert.equal(res.halt.code, 'configuration-create-reconciled');
  assert.equal(unitOf(dir, unit.unitId), undefined);
  assert.equal(svc.writes(), 0);
});

test('accept-current refuses a changed intent, a non-matching graph, a changed observation and a sensitive unit without review', async () => {
  const dir = ws();
  const svc = fakeService();
  const unit = interrupted(dir, envUnit());
  svc.seed(unit);
  const ctx = R.createReadOnlyRecoveryContext(svc.ports);
  await rejectsCode(() => R.prepareConfigurationResolution(ctx, options(dir, unit, { mode: 'accept-current', currentPublicIntentSha256: H('changed') })), 'configuration-create-intent-changed');
  svc.membership.set(unit.root.id, false);
  await rejectsCode(() => R.prepareConfigurationResolution(ctx, options(dir, unit, { mode: 'accept-current' })), 'configuration-create-membership-incomplete');
  assert.equal(unitOf(dir, unit.unitId).offer, null, 'no offer is saved for a graph that does not match');
  svc.membership.delete(unit.root.id);
  const offer = await R.prepareConfigurationResolution(ctx, options(dir, unit, { mode: 'accept-current' }));
  assert.equal(offer.privateAcknowledgmentRequired, true);
  let invalidations = 0;
  const count = () => { invalidations += 1; return { ok: true }; };
  await rejectsCode(() => R.resolveConfigurationResolution(ctx, options(dir, unit, { mode: 'accept-current', token: offer.token, invalidate: count })), 'configuration-create-private-review-required');
  svc.rows.get(unit.rows[0].id).public.description = 'edited after the approval';
  await rejectsCode(() => R.resolveConfigurationResolution(ctx, options(dir, unit, { mode: 'accept-current', token: offer.token, acceptCurrentPrivateState: true, invalidate: count })), 'configuration-create-content-conflict');
  svc.rows.get(unit.rows[0].id).public.description = null;
  svc.rows.set('extra', { kind: 'env-value', id: G(), parentId: G(), public: { schemaname: 'other' } });
  await rejectsCode(() => R.resolveConfigurationResolution(ctx, options(dir, unit, { mode: 'accept-current', token: `${offer.revision}.${'0'.repeat(64)}`, acceptCurrentPrivateState: true, invalidate: count })), 'configuration-create-approval-stale');
  assert.equal(invalidations, 0, 'nothing is invalidated before every check passed');
  const res = await R.resolveConfigurationResolution(ctx, options(dir, unit, { mode: 'accept-current', token: offer.token, acceptCurrentPrivateState: true, invalidate: count }));
  assert.equal(res.removed, true);
  assert.equal(svc.writes(), 0);
});

test('an observation that changed between prepare and resolve is approval-stale', async () => {
  const dir = ws();
  const svc = fakeService();
  const unit = interrupted(dir, apiUnit());
  svc.seed(unit);
  svc.membership.set(unit.rows[1].id, 'not-required');
  const ctx = R.createReadOnlyRecoveryContext(svc.ports);
  const offer = await R.prepareConfigurationResolution(ctx, options(dir, unit, { mode: 'accept-current' }));
  svc.membership.delete(unit.rows[1].id);
  await rejectsCode(() => R.resolveConfigurationResolution(ctx, options(dir, unit, { mode: 'accept-current', token: offer.token })), 'configuration-create-approval-stale');
  assert.ok(unitOf(dir, unit.unitId));
});

test('a context mismatch stops before any service read', async () => {
  const dir = ws();
  const svc = fakeService();
  const unit = interrupted(dir, apiUnit());
  svc.seed(unit);
  const ctx = R.createReadOnlyRecoveryContext(svc.ports);
  await rejectsCode(() => R.prepareConfigurationResolution(ctx, options(dir, unit, { mode: 'accept-current', context: OTHER_CONTEXT })), 'configuration-create-context-mismatch');
  await rejectsCode(() => R.resolveConfigurationResolution(ctx, options(dir, unit, { mode: 'accept-current', context: OTHER_CONTEXT, token: '1.x' })), 'configuration-create-context-mismatch');
  assert.equal(svc.calls.length, 0);
});

test('a failed snapshot invalidation is persistence-uncertain and keeps the unit', async () => {
  const dir = ws();
  const svc = fakeService();
  const unit = interrupted(dir, apiUnit());
  svc.seed(unit);
  const ctx = R.createReadOnlyRecoveryContext(svc.ports);
  const offer = await R.prepareConfigurationResolution(ctx, options(dir, unit, { mode: 'accept-current' }));
  await rejectsCode(() => R.resolveConfigurationResolution(ctx, options(dir, unit, { mode: 'accept-current', token: offer.token, invalidate: () => ({ ok: false }) })), 'configuration-create-persistence-uncertain');
  await rejectsCode(() => R.resolveConfigurationResolution(ctx, options(dir, unit, { mode: 'accept-current', token: offer.token, invalidate: () => { throw new Error('locked'); } })), 'configuration-create-persistence-uncertain');
  assert.ok(unitOf(dir, unit.unitId));
});

test('defer needs no service read, but the declaration must leave the root out', async () => {
  const dir = ws();
  const unit = interrupted(dir, apiUnit());
  const declared = [{ kind: 'custom-api', key: unit.root.key }];
  await rejectsCode(() => R.prepareConfigurationResolution(null, options(dir, unit, { mode: 'defer', declarations: declared })), 'configuration-create-pending');
  const offer = await R.prepareConfigurationResolution(null, options(dir, unit, { mode: 'defer', declarations: [{ kind: 'custom-api', key: 'contoso_Other' }] }));
  await rejectsCode(() => R.resolveConfigurationResolution(null, options(dir, unit, { mode: 'defer', token: offer.token, declarations: declared })), 'configuration-create-pending');
  const res = await R.resolveConfigurationResolution(null, options(dir, unit, { mode: 'defer', token: offer.token, declarations: [] }));
  assert.equal(res.deferred, true);
  assert.equal(unitOf(dir, unit.unitId).state, 'deferred');
});

test('a deferred root cannot come back by key, id, name or dependency', () => {
  const dir = ws();
  const unit = interrupted(dir, apiUnit({ key: 'contoso_DoThing' }));
  const saved = S.readConfigurationCreateState(dir, kt);
  const deferred = { ...saved, units: saved.units.map((u) => ({ ...u, state: 'deferred' })) };
  const refused = [
    [{ kind: 'custom-api', key: 'contoso_DoThing' }],
    [{ kind: 'custom-api', key: 'contoso_Renamed', id: unit.root.id.toUpperCase() }],
    [{ kind: 'custom-api', key: 'contoso_Renamed', names: ['CONTOSO_DOTHING'] }],
    [{ kind: 'custom-api', key: 'contoso_Renamed', id: unit.rows[1].id }],
    [{ kind: 'env-definition', key: 'contoso_Setting', dependsOn: [{ kind: 'custom-api', name: 'contoso_dothing' }] }],
  ];
  for (const declarations of refused) assert.throws(() => R.assertDeferredUnitsExcluded(deferred, declarations), { code: 'configuration-create-pending' }, JSON.stringify(declarations));
  R.assertDeferredUnitsExcluded(deferred, [{ kind: 'custom-api', key: 'contoso_Other' }, { kind: 'env-definition', key: 'contoso_DoThing' }]);
  R.assertDeferredUnitsExcluded(saved, [{ kind: 'custom-api', key: 'contoso_DoThing' }]);
});

test('cancel-unsent removes a wholly prepared unit, and is refused once anything was sent or a quarantine exists', async () => {
  const dir = ws();
  const h = prepare(dir, apiUnit());
  const unit = unitOf(dir, h.unitId);
  const offer = await R.prepareConfigurationResolution(null, options(dir, unit, { mode: 'cancel-unsent' }));
  const res = await R.resolveConfigurationResolution(null, options(dir, unit, { mode: 'cancel-unsent', token: offer.token }));
  assert.equal(res.removed, true);
  assert.equal(S.isLiveCreateHandle(h), true, 'the handle is fenced when it is next used');
  assert.throws(() => S.sealCreateRow(h, unit.rows[0].id), { code: 'configuration-create-state-invalid' });

  const sent = ws();
  const sentUnit = interrupted(sent, apiUnit());
  await rejectsCode(() => R.prepareConfigurationResolution(null, options(sent, sentUnit, { mode: 'cancel-unsent' })), 'configuration-create-pending');

  const q = ws();
  const hq = prepare(q, apiUnit());
  fs.writeFileSync(path.join(q, `${S.QUARANTINE_FILE_PREFIX}${G()}.json`), '{}');
  await rejectsCode(() => R.prepareConfigurationResolution(null, options(q, unitOf(q, hq.unitId), { mode: 'cancel-unsent' })), 'configuration-create-quarantined');
});

test('a local draft check stops prepare and resolve', async () => {
  const dir = ws();
  const unit = interrupted(dir, apiUnit());
  const draft = () => { throw S.configurationCreateHalt('configuration-create-approval-stale', { reason: 'a local draft changed' }); };
  await rejectsCode(() => R.prepareConfigurationResolution(null, options(dir, unit, { mode: 'defer', declarations: [], checkLocalDrafts: draft })), 'configuration-create-approval-stale');
  const offer = await R.prepareConfigurationResolution(null, options(dir, unit, { mode: 'defer', declarations: [] }));
  await rejectsCode(() => R.resolveConfigurationResolution(null, options(dir, unit, { mode: 'defer', declarations: [], token: offer.token, checkLocalDrafts: draft })), 'configuration-create-approval-stale');
  assert.equal(unitOf(dir, unit.unitId).state, 'open');
});

// ── The build guard ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const preflight = (dir, extra = {}) => R.preflightConfigurationCreates({ workspaceDir: dir, context: CONTEXT, kindTable: KIND_TABLE, declarations: [], ...extra });
function quarantined(dir) {
  fs.writeFileSync(path.join(dir, S.STATE_FILE), 'not json');
  return S.quarantineUnreadableReceipt(dir, { acknowledgeUnknownDispatch: true, invalidate: () => ({ ok: true }) }).quarantineId;
}

test('the build guard stops on open units, other contexts and blocking evidence', () => {
  assert.deepEqual({ ...preflight(path.join(ws(), 'absent')) }, { quarantineIds: [], acknowledged: false, deferredUnits: 0 });
  const dir = ws();
  const h = prepare(dir, apiUnit());
  assert.throws(() => preflight(dir), { code: 'configuration-create-pending', unitId: h.unitId });
  assert.throws(() => preflight(dir, { context: OTHER_CONTEXT }), { code: 'configuration-create-context-mismatch' });
  const rule = ws();
  const hr = prepare(rule, ruleUnit());
  const ru = unitOf(rule, hr.unitId);
  for (const r of ru.rows) { S.sealCreateRow(hr, r.id); S.markCreateRowVerified(hr, r.id); }
  S.sealNewRulePublication(hr);
  assert.throws(() => preflight(rule), { code: 'configuration-create-publication-pending' });
  const bad = ws();
  fs.writeFileSync(path.join(bad, S.STATE_FILE), 'not json');
  assert.throws(() => preflight(bad), { code: 'configuration-create-state-invalid' });
  // An emptied receipt of another context does not stop the build.
  const empty = ws();
  const he = prepare(empty, apiUnit());
  const eu = unitOf(empty, he.unitId);
  for (const r of eu.rows) { S.sealCreateRow(he, r.id); S.markCreateRowVerified(he, r.id); }
  S.completeCreateUnit(he);
  preflight(empty, { context: OTHER_CONTEXT });
});

test('the build guard lets unrelated work pass a deferred unit and stops its reintroduction', async () => {
  const dir = ws();
  const unit = interrupted(dir, apiUnit());
  const offer = await R.prepareConfigurationResolution(null, options(dir, unit, { mode: 'defer', declarations: [] }));
  await R.resolveConfigurationResolution(null, options(dir, unit, { mode: 'defer', declarations: [], token: offer.token }));
  assert.equal(preflight(dir, { declarations: [{ kind: 'custom-api', key: 'contoso_Other' }], configurationWork: true }).deferredUnits, 1);
  assert.throws(() => preflight(dir, { declarations: [{ kind: 'custom-api', key: 'contoso_Renamed', names: ['contoso_dothing'] }] }), { code: 'configuration-create-pending' });
});

test('a quarantine fences configuration work until every quarantine is acknowledged by id', () => {
  const dir = ws();
  const a = quarantined(dir);
  const b = quarantined(dir);
  assert.deepEqual([...preflight(dir).quarantineIds].sort(), [a, b].sort(), 'unrelated work proceeds');
  assert.throws(() => preflight(dir, { configurationWork: true }), { code: 'configuration-create-quarantined' });
  assert.throws(() => preflight(dir, { configurationWork: true, quarantineAcknowledgment: [a] }), { code: 'configuration-create-quarantined' });
  assert.throws(() => preflight(dir, { configurationWork: true, quarantineAcknowledgment: [a, b, G()] }), { code: 'configuration-create-approval-stale' });
  const ack = R.validateQuarantineAcknowledgment(dir, [a.toUpperCase(), b]);
  assert.ok(R.isQuarantineAcknowledgment(ack));
  assert.equal(R.isQuarantineAcknowledgment({ quarantineIds: [a, b] }), false);
  assert.equal(preflight(dir, { configurationWork: true, quarantineAcknowledgment: ack }).acknowledged, true);
  assert.equal(preflight(dir, { configurationWork: true, quarantineAcknowledgment: [a, b] }).acknowledged, true);
  // A third quarantine after the acknowledgment makes it stale.
  const c = quarantined(dir);
  assert.throws(() => preflight(dir, { configurationWork: true, quarantineAcknowledgment: ack }), { code: 'configuration-create-approval-stale' });
  // An archiving or archive-less quarantine cannot be acknowledged at all.
  fs.unlinkSync(path.join(dir, `${S.ARCHIVE_FILE_PREFIX}${c}.bin`));
  assert.throws(() => R.validateQuarantineAcknowledgment(dir, [a, b, c]), { code: 'configuration-create-state-invalid' });
  assert.throws(() => preflight(dir, { configurationWork: true, quarantineAcknowledgment: [a, b, c] }), { code: 'configuration-create-state-invalid' });
});

test('no recovery flow sends anything but GET, and no message carries an observed private value', async () => {
  const dir = ws();
  const svc = fakeService();
  const unit = interrupted(dir, envUnit());
  svc.seed(unit);
  const ctx = R.createReadOnlyRecoveryContext(svc.ports);
  const messages = [];
  svc.rows.get(unit.rows[0].id).public.displayname = CANARY;
  const report = await R.inspectCreateUnit(ctx, unit, kt);
  messages.push(JSON.stringify(report), report.halt.message);
  messages.push((await rejectsCode(() => R.prepareConfigurationResolution(ctx, options(dir, unit, { mode: 'accept-current' })), 'configuration-create-content-conflict')).message);
  svc.rows.get(unit.rows[0].id).public.displayname = 'Setting';
  svc.rows.get(unit.rows[1].id).public.value = CANARY;
  messages.push((await rejectsCode(() => R.prepareConfigurationResolution(ctx, options(dir, unit, { mode: 'accept-current' })), 'configuration-create-graph-unreadable')).message);
  delete svc.rows.get(unit.rows[1].id).public.value;
  const offer = await R.prepareConfigurationResolution(ctx, options(dir, unit, { mode: 'accept-current' }));
  const res = await R.resolveConfigurationResolution(ctx, options(dir, unit, { mode: 'accept-current', token: offer.token, acceptCurrentPrivateState: true }));
  messages.push(res.halt.message, fs.readFileSync(path.join(dir, S.STATE_FILE), 'utf8'));
  for (const m of messages) {
    assert.ok(!m.includes(CANARY));
    assert.ok(!m.includes(sha256(CANARY)));
  }
  assert.ok(svc.calls.length > 0);
  assert.equal(svc.writes(), 0);
});
