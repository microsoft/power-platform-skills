'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runSdkBuild } = require('../lib/sdk-build.js');
const { makeSimpleMockSdk } = require('./helpers/mock-sdk.js');

const OLDEST = '11111111-1111-4111-8111-111111111111';
const PREEXISTING = '22222222-2222-4222-8222-222222222222';
const CREATED = '33333333-3333-4333-8333-333333333333';
const EXTRA = '44444444-4444-4444-8444-444444444444';
const RULE = 'Contoso close rule';
const MODEL = 'contoso_ticket row summary';

function spec() {
  return {
    solution: { uniqueName: 'ContosoCleanup', publisherPrefix: 'contoso' },
    app: { name: 'Contoso Cleanup' },
    entities: [{
      schemaName: 'contoso_ticket', displayName: 'Ticket',
      primaryAttribute: { schemaName: 'contoso_name', displayName: 'Name' },
      columns: [{ schemaName: 'contoso_notes', displayName: 'Notes', type: 'Memo' }],
    }],
    businessRules: [{
      name: RULE, entity: 'contoso_ticket',
      conditions: [{ field: 'contoso_name', operator: 'ContainsData' }],
      actions: [{ type: 'LockUnlock', field: 'contoso_notes', lock: true }],
    }],
    ai: { summaries: { default: 'off', tables: { contoso_ticket: { enabled: true } } } },
  };
}

test('reusing the oldest rule keeps and reports every pre-existing same-name row', async () => {
  const { sdk } = makeSimpleMockSdk();
  const deletes = [];
  const updates = [];
  const warnings = [];
  sdk.queryRecords = async () => [
    { workflowid: OLDEST, statecode: 1, createdon: '2026-01-01T00:00:00Z' },
    { workflowid: PREEXISTING, statecode: 1, createdon: '2026-06-01T00:00:00Z' },
  ];
  sdk.deleteRecord = async (entity, id) => { deletes.push({ entity, id }); };
  sdk.updateRecord = async (entity, id) => { updates.push({ entity, id }); };
  const r = await runSdkBuild(spec(), { sdk, apply: true, allowDestructive: false, phases: ['business-rules'], warn: (w) => warnings.push(w) });
  assert.equal(r.created.businessRules[`contoso_ticket|${RULE}`], OLDEST);
  assert.deepEqual(deletes, []);
  assert.deepEqual(updates, []);
  assert.ok(warnings.some((w) => w.includes(PREEXISTING) && /kept/i.test(w)));
});

function createRuleSdk(opts = {}) {
  const { sdk } = makeSimpleMockSdk();
  const state = { pushed: false, pushes: 0, snapshots: 0, reads: 0, deletes: [], updates: [], warnings: [] };
  sdk.queryRecords = async (entity, query) => {
    assert.equal(entity, 'workflow');
    state.reads++;
    if (state.reads === 1) return [];
    if (!state.pushed) {
      state.snapshots++;
      if (opts.snapshotError) throw new Error('Contoso workflow snapshot unavailable');
      assert.equal(query.paginate, true, 'the before-create id set must include every matching row');
      assert.equal(query.top, undefined, 'a truncated snapshot cannot prove which ids are new');
      if (Object.prototype.hasOwnProperty.call(opts, 'snapshotRows')) return opts.snapshotRows;
      return [{ workflowid: PREEXISTING.toUpperCase(), statecode: 1 }];
    }
    return [
      { workflowid: CREATED, statecode: 1 },
      { workflowid: PREEXISTING, statecode: 1 },
      { workflowid: EXTRA, statecode: 1 },
    ];
  };
  sdk.createArtifact = async () => ({ id: CREATED });
  sdk.updateElement = async () => {};
  sdk.pushArtifact = async () => {
    state.pushes++;
    state.pushed = true;
    return { id: CREATED, saved: true, publish: { kind: 'notRequested' } };
  };
  sdk.updateRecord = async (entity, id) => {
    state.updates.push({ entity, id });
    if (opts.updateError) throw new Error('Contoso rule deactivation unavailable');
  };
  sdk.deleteRecord = async (entity, id) => {
    state.deletes.push({ entity, id });
    if (opts.deleteError) throw new Error('Contoso rule delete unavailable');
  };
  return { sdk, state };
}

for (const allowDestructive of [false, true]) {
  test(`post-create cleanup keeps a concurrent same-name rule not returned by the push (destructive approval: ${allowDestructive})`, async () => {
    const { sdk, state } = createRuleSdk();
    await runSdkBuild(spec(), { sdk, apply: true, allowDestructive, phases: ['business-rules'], warn: (w) => state.warnings.push(w) });
    assert.equal(state.snapshots, 1);
    assert.deepEqual(state.deletes, []);
    assert.deepEqual(state.updates, []);
    for (const id of [PREEXISTING, EXTRA]) {
      assert.ok(state.warnings.some((w) => w.includes(id) && /not attributable to this run/i.test(w)));
    }
  });
}

test('an unreadable before-create snapshot refuses the rule push', async () => {
  const { sdk, state } = createRuleSdk({ snapshotError: true });
  await assert.rejects(runSdkBuild(spec(), { sdk, apply: true, phases: ['business-rules'] }), /workflow snapshot unavailable/);
  assert.equal(state.pushes, 0);
  assert.deepEqual(state.deletes, []);
});

for (const snapshotRows of [null, {}, [{ statecode: 1 }], [{ workflowid: '' }]]) {
  test(`an incomplete before-create id snapshot refuses the rule push: ${JSON.stringify(snapshotRows)}`, async () => {
    const { sdk, state } = createRuleSdk({ snapshotRows });
    await assert.rejects(runSdkBuild(spec(), { sdk, apply: true, phases: ['business-rules'] }), /snapshot.*unreadable|snapshot.*complete/i);
    assert.equal(state.pushes, 0);
    assert.deepEqual(state.deletes, []);
  });
}

test('unreturned ids are kept without attempting deactivation or deletion', async () => {
  const { sdk, state } = createRuleSdk({ updateError: true, deleteError: true });
  const r = await runSdkBuild(spec(), { sdk, apply: true, phases: ['business-rules'], warn: (w) => state.warnings.push(w) });
  assert.equal(r.ok, true);
  assert.deepEqual(state.deletes, []);
  assert.deepEqual(state.updates, []);
  assert.ok(state.warnings.some((w) => w.includes(EXTRA) && /not attributable/i.test(w)));
});

function summarySdk(code, opts = {}) {
  const { sdk } = makeSimpleMockSdk();
  const state = { deletes: [], queries: [], warnings: [] };
  sdk.configureRowSummary = async () => {
    const e = new Error(`Contoso row summary refused: ${code}`);
    e.statusCode = 400;
    throw e;
  };
  sdk.queryRecords = async (entity, query) => {
    if (entity !== 'msdyn_aimodel') return [];
    state.queries.push(query);
    if (opts.readError) throw new Error('Contoso model inventory unavailable');
    assert.match(query.filter, /msdyn_name eq 'contoso_ticket row summary'/);
    return [{ msdyn_aimodelid: PREEXISTING, msdyn_name: MODEL }];
  };
  sdk.deleteRecord = async (entity, id) => { state.deletes.push({ entity, id }); };
  return { sdk, state };
}

for (const code of ['DuplicateRecordKey', 'ModelNotSupported']) {
  test(`${code} keeps and warns about a same-name AI model without a created-id receipt`, async () => {
    const { sdk, state } = summarySdk(code);
    const r = await runSdkBuild(spec(), { sdk, apply: true, allowDestructive: false, phases: ['ai-features'], warn: (w) => state.warnings.push(w) });
    assert.equal(r.ok, true);
    assert.deepEqual(state.deletes, []);
    assert.ok(state.warnings.some((w) => w.includes(PREEXISTING) && /kept/i.test(w)));
  });
}

test('a failed AI-model inventory read is reported and cannot cause a cleanup delete', async () => {
  const { sdk, state } = summarySdk('ModelNotSupported', { readError: true });
  const r = await runSdkBuild(spec(), { sdk, apply: true, phases: ['ai-features'], warn: (w) => state.warnings.push(w) });
  assert.equal(r.ok, true);
  assert.deepEqual(state.deletes, []);
  assert.ok(state.warnings.some((w) => /model inventory unavailable/.test(w)));
});

test('a later summary failure still reports and keeps an earlier same-name model', async () => {
  const { sdk, state } = summarySdk('ModelNotSupported');
  const s = spec();
  s.entities.push({ ...s.entities[0], schemaName: 'contoso_request' });
  s.ai.summaries.tables.contoso_request = { enabled: true };
  let attempts = 0;
  sdk.configureRowSummary = async () => {
    attempts++;
    throw new Error(attempts === 1 ? 'ModelNotSupported' : 'Contoso later summary failed');
  };
  await assert.rejects(runSdkBuild(s, { sdk, apply: true, phases: ['ai-features'], warn: (w) => state.warnings.push(w) }), /later summary failed/);
  assert.deepEqual(state.deletes, []);
  assert.ok(state.warnings.some((w) => w.includes(PREEXISTING) && /kept/i.test(w)));
});

test('the real SDK rolls back only its new model id while plugin cleanup keeps same-name rows', async (t) => {
  const { createMakerSdk, createNodeWorkspaceStorage } = require('../vendor/cds-maker-sdk.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'contoso-summary-receipt-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const wireDeletes = [];
  let newId;
  const response = (body) => ({ status: 200, headers: {}, body });
  const real = createMakerSdk({
    workspaceStorage: createNodeWorkspaceStorage(dir),
    instanceUrl: 'https://contoso.crm.dynamics.com',
    httpClient: {
      get: async (url) => {
        if (url.includes('/aiskillconfigs?') || url.includes('/msdyn_aitemplates?')) return response({ value: [] });
        if (url.includes("/EntityDefinitions(LogicalName='contoso_ticket')")) return response({ MetadataId: OLDEST });
        throw new Error(`unexpected offline GET ${url}`);
      },
      post: async (url, body) => {
        if (url.endsWith('/AIModelPublish')) { newId = body.ModelId; return response({}); }
        assert.ok(url.endsWith('/aiskillconfigs'));
        return { status: 403, headers: {}, body: { error: { code: 'ModelNotSupported', message: 'Contoso skill configuration unavailable' } } };
      },
      delete: async (url) => { wireDeletes.push(url); return { status: 204, headers: {}, body: {} }; },
    },
  });
  await real.initWorkspace();
  const { sdk, state } = summarySdk('ModelNotSupported');
  sdk.configureRowSummary = real.configureRowSummary.bind(real);
  await runSdkBuild(spec(), { sdk, apply: true, phases: ['ai-features'], warn: (w) => state.warnings.push(w) });
  assert.ok(newId && newId !== PREEXISTING);
  assert.equal(wireDeletes.length, 1);
  assert.ok(wireDeletes[0].endsWith(`/msdyn_aimodels(${newId})`));
  assert.deepEqual(state.deletes, [], 'the plugin must not follow the exact-id rollback with a name-only delete');
});
