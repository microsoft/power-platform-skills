'use strict';
// Declared business rules through the REAL vendored SDK: a rule is created, read back and edited over a
// stub that keeps the WfomJson the SDK writes (CreateProcessWithWfomJson / UpdateProcessWithWfomJson) and
// serves it to RetrieveProcessWithWfomJson, so the SDK's own serializer and parser are both exercised.
// Covers the seven action shapes with a numeric condition and OR logic, an in-place edit that keeps node
// identities, adoption, removal approval, drift, the literal-only rule and the opt-out.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMakerSdk, createNodeWorkspaceStorage } = require('../vendor/cds-maker-sdk.cjs');
const { fakeManaged } = require('./helpers/feature-ports.js');
const { businessRuleDef } = require('../lib/sdk-build.js');
const { ruleRootCondition, planRuleReconcile, applyRuleReconcile, createdRuleBindings } = require('../lib/rule-reconcile.js');

const RID = '44444444-4444-4444-4444-444444444444';
const dirs = [];
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

function ruleServer() {
  const store = { wfom: null, entity: null, state: { statecode: 1, statuscode: 2 }, etag: 1 };
  const log = [];
  const ok = (body, status = 200) => ({ status, headers: { etag: `W/"${store.etag}"` }, body });
  const httpClient = {
    get: async (url) => {
      log.push(['get', url]);
      if (store.failRead && /RetrieveProcessWithWfomJson/.test(url)) throw new Error('socket hang up');
      if (/RetrieveProcessWithWfomJson/.test(url)) {
        return ok({ Entity: { workflowid: RID, name: store.entity.name, description: store.entity.description || '', primaryentity: 'account', statecode: store.state.statecode, processtriggerscope: 2 }, WfomJson: store.wfom });
      }
      if (/\/workflows\(/.test(url)) return ok({ workflowid: RID, ...store.state });
      if (/\/organizations/.test(url)) return ok({ value: [{ languagecode: 1033 }] });
      if (/EntityDefinitions/.test(url)) return ok({ value: [] });
      assert.fail(`unexpected GET ${url}`);
    },
    post: async (url, body) => {
      log.push(['post', url]);
      if (store.failUpdate && /UpdateProcessWithWfomJson/.test(url)) throw new Error('socket hang up');
      if (/(Create|Update)ProcessWithWfomJson/.test(url)) {
        store.wfom = body.WfomJson;
        store.entity = { ...(store.entity || {}), ...(body.Entity || {}) };
        store.etag += 1;
        return ok({ ProcessId: RID });
      }
      assert.fail(`unexpected POST ${url}`);
    },
    patch: async (url, body) => { log.push(['patch', url]); Object.assign(store.state, body); store.etag += 1; return ok({}, 204); },
    put: async (url) => assert.fail(`unexpected PUT ${url}`),
    delete: async (url) => assert.fail(`unexpected DELETE ${url}`),
  };
  const fresh = async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rule-rt-'));
    dirs.push(dir);
    const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(dir), instanceUrl: 'https://contoso.crm.dynamics.com', httpClient });
    await sdk.initWorkspace();
    return sdk;
  };
  const writes = () => log.filter((l) => l[0] !== 'get');
  return { store, log, fresh, writes };
}

async function seed(srv, rule, root = ruleRootCondition(rule)) {
  const sdk = await srv.fresh();
  const art = await sdk.createArtifact('businessRule', { name: rule.name, entityLogicalName: 'account', scope: 'Entity', status: 'Active', ...(rule.description ? { description: rule.description } : {}) });
  await sdk.updateElement('businessRule', art.id, '/rootCondition', root);
  const pushed = await sdk.pushArtifact('businessRule', art.id);
  assert.equal(pushed.saved, true);
  srv.log.length = 0;
}

async function liveRoot(srv) {
  const sdk = await srv.fresh();
  await sdk.fetchArtifact('businessRule', RID);
  return (await sdk.getArtifact('businessRule', RID)).rootCondition;
}

async function reconcile(srv, rule, ctx = {}) {
  const sdk = await srv.fresh();
  const before = srv.writes().length;
  const plan = await planRuleReconcile({ rule, ruleId: RID, sdk }, ctx);
  const result = await applyRuleReconcile(plan, { sdk }, ctx);
  return { plan, result, writes: srv.writes().slice(before) };
}

const allShapes = () => ({
  name: 'Account checks', entity: 'account', reconcile: 'declared', conditionLogic: 'OR',
  conditions: [
    { key: 'big', field: 'numberofemployees', operator: 'IsGreaterThan', value: 500, dataType: 'Integer' },
    { key: 'named', field: 'name', operator: 'ContainsData' },
  ],
  actions: [
    { key: 'hide-fax', type: 'SetVisibility', field: 'fax', visible: false },
    { key: 'lock-site', type: 'LockUnlock', field: 'websiteurl', lock: true },
    { key: 'need-phone', type: 'SetBusinessRequired', field: 'telephone1', required: true },
    { key: 'set-code', type: 'SetFieldValue', field: 'accountnumber', value: 42, dataType: 'Integer' },
    { key: 'default-city', type: 'SetDefaultValue', field: 'address1_city', value: 'Seattle' },
    { key: 'name-error', type: 'ShowErrorMessage', field: 'name', errorMessage: 'Large accounts need a name' },
    { key: 'suggest', type: 'Recommendation', field: 'name', recommendationTitle: 'Tier', messageText: 'Mark as key account', acceptanceText: 'Apply',
      applyActions: [{ key: 'tier', field: 'description', value: 'Key account' }] },
  ],
});

test('all seven action shapes with a numeric condition and OR logic round-trip through the SDK, and the next build is a no-op', async () => {
  const srv = ruleServer();
  const rule = allShapes();
  await seed(srv, rule);
  const root = await liveRoot(srv);
  assert.equal(root.logic, 'OR');
  assert.deepEqual(root.trueBranch.map((a) => a.type), ['SetVisibility', 'LockUnlock', 'SetBusinessRequired', 'SetFieldValue', 'SetDefaultValue', 'ShowErrorMessage', 'Recommendation']);
  assert.deepEqual([root.clauses[0].value, root.clauses[0].valueWorkflowType], ['500', '5'], 'the numeric literal keeps its type on the condition');
  assert.equal(root.trueBranch[3].value, '42');
  assert.deepEqual(root.trueBranch[6].applyActions.map((p) => [p.field, p.value]), [['description', 'Key account']]);

  const managed = fakeManaged(createdRuleBindings(rule, RID));
  const again = await reconcile(srv, rule, { managed });
  assert.equal(again.plan.action, 'noChange', JSON.stringify(again.plan.refused));
  assert.deepEqual(again.writes, [], 'no update and no state change');
});

test('an edit updates the same definition in place: kept nodes keep their ids and step names, a new keyed action is appended', async () => {
  const srv = ruleServer();
  const rule = allShapes();
  await seed(srv, rule);
  const before = await liveRoot(srv);
  const managed = fakeManaged(createdRuleBindings(rule, RID));
  const edited = allShapes();
  edited.conditionLogic = 'AND';
  edited.conditions[0].value = 1000;
  edited.actions[0].visible = true;
  edited.actions[5].errorMessage = 'A name is required';
  edited.actions.push({ key: 'lock-name', type: 'LockUnlock', field: 'name', lock: true });
  const { result, writes } = await reconcile(srv, edited, { managed });
  assert.deepEqual(result.saved.map((s) => s.id), [RID], JSON.stringify(result));
  assert.equal(writes.filter((w) => /UpdateProcessWithWfomJson/.test(w[1])).length, 1);
  assert.equal(writes.filter((w) => /CreateProcessWithWfomJson/.test(w[1])).length, 0, 'never a second rule by the same name');
  const after = await liveRoot(srv);
  assert.equal(after.logic, 'AND');
  assert.equal(after.clauses[0].value, '1000');
  assert.equal(after.trueBranch[0].visible, true);
  assert.equal(after.trueBranch[5].errorMessage, 'A name is required');
  assert.deepEqual(after.trueBranch.map((a) => a.type).slice(-1), ['LockUnlock']);
  assert.deepEqual(after.trueBranch.slice(0, 7).map((a) => [a.id, a.stepName]).filter((_, i) => i !== 5), before.trueBranch.map((a) => [a.id, a.stepName]).filter((_, i) => i !== 5));
  managed.persist(result.managedBindings);
  const again = await reconcile(srv, edited, { managed });
  assert.equal(again.plan.action, 'noChange');
});

test('an existing rule the spec has not managed needs adoption approval; keys then match its nodes by field', async () => {
  const srv = ruleServer();
  const legacy = { name: 'Account checks', entity: 'account', conditions: [{ field: 'name', operator: 'Equals', value: 'x' }], actions: [{ type: 'SetVisibility', field: 'fax', visible: false }] };
  await seed(srv, legacy, businessRuleDef(legacy).rootCondition);
  const declared = { ...legacy, reconcile: 'declared', conditions: [{ key: 'c', field: 'name', operator: 'Equals', value: 'y' }], actions: [{ key: 'a', type: 'SetVisibility', field: 'fax', visible: false }] };
  // A declared spec that already matches is not a refusal, and is not bound without approval either.
  const same = await reconcile(srv, { ...declared, conditions: [{ ...declared.conditions[0], value: 'x' }] });
  assert.deepEqual([same.plan.action, same.result.refused, same.result.managedBindings, same.writes], ['noChange', [], [], []]);
  const refused = await reconcile(srv, declared);
  assert.deepEqual(refused.result.refused.map((r) => r.code), ['rule-adoption-not-authorized']);
  assert.deepEqual(refused.writes, []);
  const adopted = await reconcile(srv, declared, { authorizedAdoption: true });
  assert.equal(adopted.result.saved.length, 1, JSON.stringify(adopted.result));
  assert.equal((await liveRoot(srv)).clauses[0].value, 'y');
});

test('a node the spec does not declare is removed only with destructive approval', async () => {
  const srv = ruleServer();
  const rule = allShapes();
  await seed(srv, rule);
  const managed = fakeManaged(createdRuleBindings(rule, RID));
  const fewer = allShapes();
  fewer.actions = fewer.actions.filter((a) => a.key !== 'lock-site');
  const refused = await reconcile(srv, fewer, { managed });
  assert.deepEqual(refused.result.refused.map((r) => r.code), ['rule-node-removal-not-authorized']);
  assert.deepEqual(refused.writes, []);
  const removed = await reconcile(srv, fewer, { managed, authorizedDestructive: true });
  assert.equal(removed.result.saved.length, 1, JSON.stringify(removed.result));
  assert.equal((await liveRoot(srv)).trueBranch.some((a) => a.type === 'LockUnlock'), false);
});

test('a rule changed outside the spec is drift until the overwrite is approved; nothing is written meanwhile', async () => {
  const srv = ruleServer();
  const rule = allShapes();
  await seed(srv, rule);
  const managed = fakeManaged(createdRuleBindings(rule, RID));
  const maker = await srv.fresh();
  await maker.fetchArtifact('businessRule', RID);
  await maker.updateElement('businessRule', RID, '/rootCondition/clauses/0/value', '9');
  await maker.pushArtifact('businessRule', RID);
  srv.log.length = 0;
  const edited = allShapes();
  edited.actions[0].visible = true;
  const drift = await reconcile(srv, edited, { managed });
  assert.deepEqual(drift.result.refused.map((r) => r.code), ['rule-drift']);
  assert.deepEqual(drift.writes, []);
  const overwritten = await reconcile(srv, edited, { managed, authorizedOverwrite: true });
  assert.equal(overwritten.result.saved.length, 1);
  assert.equal((await liveRoot(srv)).clauses[0].value, '500');
});

test('a live value the spec cannot express (a field-to-field comparison) is refused, not overwritten', async () => {
  const srv = ruleServer();
  const rule = allShapes();
  const root = ruleRootCondition(rule);
  root.clauses[0] = { ...root.clauses[0], valueType: 'Field', valueField: 'numberofemployees', value: undefined };
  root.clauses[0].field = 'revenue';
  await seed(srv, rule, root);
  const spec = allShapes();
  spec.conditions[0].field = 'revenue';
  const { result, writes } = await reconcile(srv, spec, { authorizedAdoption: true });
  assert.deepEqual(result.refused.map((r) => r.code), ['rule-value-mode-unsupported']);
  assert.deepEqual(writes, []);
});

test('a declared rule without keys is refused before anything is read, and a rule without the opt-in is not read at all', async () => {
  const srv = ruleServer();
  await seed(srv, allShapes());
  const unkeyed = allShapes();
  delete unkeyed.actions[2].key;
  const bad = await reconcile(srv, unkeyed, { authorizedAdoption: true });
  assert.deepEqual(bad.result.refused.map((r) => r.code), ['rule-spec-invalid']);
  assert.equal(srv.log.length, 0);
  const legacy = allShapes();
  delete legacy.reconcile;
  const skipped = await reconcile(srv, legacy, { authorizedAdoption: true });
  assert.equal(skipped.plan.action, null);
  assert.equal(srv.log.length, 0);
});

test('a rule with an else branch or with mixed AND / OR between its conditions is a shape the spec cannot express', async () => {
  const elseSrv = ruleServer();
  const root = ruleRootCondition(allShapes());
  root.falseBranch = [{ id: 'e1', type: 'SetVisibility', field: 'fax', visible: true }];
  await seed(elseSrv, allShapes(), root);
  const withElse = await reconcile(elseSrv, allShapes(), { authorizedAdoption: true });
  assert.deepEqual(withElse.result.refused.map((r) => r.code), ['rule-shape-unsupported']);
  assert.deepEqual(withElse.writes, []);

  const mixedSrv = ruleServer();
  const rule = allShapes();
  rule.conditions.push({ key: 'third', field: 'fax', operator: 'ContainsData' });
  await seed(mixedSrv, rule);
  const maker = await mixedSrv.fresh();
  await maker.fetchArtifact('businessRule', RID);
  const live = (await maker.getArtifact('businessRule', RID)).rootCondition;
  live.clauses[2] = { ...live.clauses[2], bag: { ...(live.clauses[2].bag || {}), connector: 'AND' } };
  await maker.updateElement('businessRule', RID, '/rootCondition', live);
  await maker.pushArtifact('businessRule', RID);
  mixedSrv.log.length = 0;
  const mixed = await reconcile(mixedSrv, rule, { authorizedAdoption: true });
  assert.deepEqual(mixed.result.refused.map((r) => r.code), ['rule-shape-unsupported'], JSON.stringify(mixed.result));
  assert.deepEqual(mixed.writes, []);
});
test('an unreadable rule and a write that does not report its outcome are unknown, never recorded as managed', async () => {
  const srv = ruleServer();
  const rule = allShapes();
  await seed(srv, rule);
  const managed = fakeManaged(createdRuleBindings(rule, RID));
  const edited = allShapes();
  edited.actions[0].visible = true;
  srv.store.failRead = true;
  const unread = await reconcile(srv, edited, { managed });
  assert.deepEqual(unread.result.unknown.map((r) => r.code), ['rule-unreadable']);
  assert.deepEqual(unread.writes, []);
  srv.store.failRead = false;
  srv.store.failUpdate = true;
  const lost = await reconcile(srv, edited, { managed });
  assert.deepEqual(lost.result.unknown.map((r) => r.code), ['rule-write-unknown'], JSON.stringify(lost.result));
  assert.deepEqual([lost.result.saved, lost.result.managedBindings], [[], []]);
});
test('a spec that starts declaring the description or action labels is an edit, not drift', async () => {
  const srv = ruleServer();
  const rule = allShapes();
  await seed(srv, rule);
  const managed = fakeManaged(createdRuleBindings(rule, RID));
  const described = allShapes();
  described.description = 'Checks for large accounts';
  described.actions.forEach((a) => { if (a.type !== 'Recommendation') a.label = `Step ${a.key}`; });
  const { result } = await reconcile(srv, described, { managed });
  assert.equal(result.saved.length, 1, JSON.stringify(result));
  assert.equal((await liveRoot(srv)).trueBranch[0].displayName, 'Step hide-fax');
});
test('the bound rule is the authority: a different rule found by name is refused, a bound rule no longer found is never recreated, and nothing is read or written', async () => {
  const srv = ruleServer();
  const rule = allShapes();
  await seed(srv, rule);
  const managed = fakeManaged(createdRuleBindings(rule, '99999999-9999-9999-9999-999999999999'));
  const edited = allShapes();
  edited.actions[0].visible = true;
  const other = await reconcile(srv, edited, { managed, authorizedOverwrite: true, authorizedAdoption: true });
  assert.deepEqual([other.plan.action, other.result.refused.map((r) => r.code), other.result.managedBindings, srv.log], [null, ['rule-binding-mismatch'], [], []]);
  const sdk = await srv.fresh();
  const gone = await planRuleReconcile({ rule: edited, ruleId: null, sdk }, { managed });
  assert.deepEqual([gone.action, gone.needsCreate, gone.refused.map((r) => r.code), srv.log], [null, undefined, ['rule-bound-row-missing'], []]);
  const fresh = await planRuleReconcile({ rule: edited, ruleId: null, sdk }, {});
  assert.deepEqual([fresh.action, fresh.needsCreate, fresh.refused, srv.log], [null, true, [], []]);
});

test('declaring the label of one more action is an edit, not drift; a label changed outside the spec on an action it writes is drift', async () => {
  const srv = ruleServer();
  const rule = allShapes();
  rule.actions[0].label = 'Hide the fax';
  await seed(srv, rule);
  const managed = fakeManaged(createdRuleBindings(rule, RID));
  const more = allShapes();
  more.actions[0].label = 'Hide the fax';
  more.actions[1].label = 'Lock the site';
  const { result } = await reconcile(srv, more, { managed });
  assert.deepEqual([result.refused, result.saved.length], [[], 1], JSON.stringify(result));
  assert.deepEqual((await liveRoot(srv)).trueBranch.slice(0, 2).map((a) => a.displayName), ['Hide the fax', 'Lock the site']);
  managed.persist(result.managedBindings);
  const again = await reconcile(srv, more, { managed });
  assert.equal(again.plan.action, 'noChange');

  const maker = await srv.fresh();
  await maker.fetchArtifact('businessRule', RID);
  await maker.updateElement('businessRule', RID, '/rootCondition/trueBranch/1/displayName', 'Their label');
  await maker.pushArtifact('businessRule', RID);
  srv.log.length = 0;
  const relabel = allShapes();
  relabel.actions[0].label = 'Hide the fax';
  relabel.actions[1].label = 'Lock the website';
  const drift = await reconcile(srv, relabel, { managed });
  assert.deepEqual([drift.result.refused.map((r) => r.code), drift.writes], [['rule-drift'], []]);
});