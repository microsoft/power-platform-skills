'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runSdkBuild } = require('../lib/sdk-build.js');
const { isTransientHalt } = require('../build-model-app.js');
const { makeSimpleMockSdk } = require('./helpers/mock-sdk.js');

const OLDEST = '11111111-1111-4111-8111-111111111111';
const PREEXISTING = '22222222-2222-4222-8222-222222222222';
const CREATED = '33333333-3333-4333-8333-333333333333';
const EXTRA = '44444444-4444-4444-8444-444444444444';
const TEMPLATE = '55555555-5555-4555-8555-555555555555';
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
        if (url.includes('/aiskillconfigs?')) return response({ value: [] });
        // The SDK reads the row-summary template before it writes anything and refuses an org that has none
        // (ROW_SUMMARY_TEMPLATE_NOT_FOUND), so the org of this test has it: the model is published, which is what is rolled back.
        if (url.includes('/msdyn_aitemplates?')) return response({ value: [{ msdyn_aitemplateid: TEMPLATE }] });
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

// An org without the AI template a row summary is built from is an environment gate like the licence refusal: the SDK reads the
// template before its first write and refuses with ROW_SUMMARY_TEMPLATE_NOT_FOUND ("Nothing was written"), so the summary is skipped with
// one warning and the build goes on — and, as nothing was written, there is no model to look for or report.
test('an org with no row-summary AI template skips the summary with one warning and looks for no model', async () => {
  const { sdk } = makeSimpleMockSdk();
  const queries = [];
  const deletes = [];
  const warnings = [];
  const events = [];
  sdk.configureRowSummary = async () => {
    throw Object.assign(new Error("Cannot configure the row summary of 'contoso_ticket': this org has no AI template 'GptPowerPrompt' (msdyn_aitemplates), which a row-summary model is built from. Nothing was written."), { code: 'ROW_SUMMARY_TEMPLATE_NOT_FOUND' });
  };
  sdk.queryRecords = async (entity) => { queries.push(entity); return []; };
  sdk.deleteRecord = async (entity, id) => { deletes.push({ entity, id }); };
  const s = spec();
  s.entities.push({ ...s.entities[0], schemaName: 'contoso_request' });
  s.ai.summaries.tables.contoso_request = { enabled: true };

  const r = await runSdkBuild(s, { sdk, apply: true, phases: ['ai-features'], warn: (w) => warnings.push(w), emit: (e) => events.push(e) });

  assert.equal(r.ok, true, 'the build goes on');
  assert.deepEqual(r.skipped.aiSummaries, ['contoso_ticket', 'contoso_request']);
  assert.deepEqual(events.filter((e) => e.status === 'skip' && /^row summary for /.test(e.label)).map((e) => e.label),
    ['row summary for contoso_ticket (no row-summary AI template in this environment)', 'row summary for contoso_request (no row-summary AI template in this environment)']);
  assert.equal(warnings.length, 1, `one warning for two tables, got ${JSON.stringify(warnings)}`);
  assert.match(warnings[0], /AI row summaries were NOT created: this environment has no 'GptPowerPrompt' AI template/);
  assert.match(warnings[0], /nothing was written for them/);
  assert.deepEqual(queries.filter((entity) => entity === 'msdyn_aimodel'), [], 'nothing was written, so no same-name model is looked for');
  assert.deepEqual(deletes, []);
});

test('the real SDK refuses a row summary on an org with no AI template before any write, and the build skips it', async (t) => {
  const { createMakerSdk, createNodeWorkspaceStorage } = require('../vendor/cds-maker-sdk.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'contoso-summary-template-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const writes = [];
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
      post: async (url) => { writes.push(`POST ${url}`); return response({}); },
      patch: async (url) => { writes.push(`PATCH ${url}`); return response({}); },
      put: async (url) => { writes.push(`PUT ${url}`); return response({}); },
      delete: async (url) => { writes.push(`DELETE ${url}`); return { status: 204, headers: {}, body: {} }; },
    },
  });
  await real.initWorkspace();
  const { sdk, state } = summarySdk('ModelNotSupported');
  sdk.configureRowSummary = real.configureRowSummary.bind(real);

  const r = await runSdkBuild(spec(), { sdk, apply: true, phases: ['ai-features'], warn: (w) => state.warnings.push(w) });

  assert.equal(r.ok, true);
  assert.deepEqual(r.skipped.aiSummaries, ['contoso_ticket']);
  assert.deepEqual(writes, [], 'the SDK read the template first and wrote nothing');
  assert.deepEqual(state.queries, [], 'no model inventory read: nothing was written for it to report');
  assert.ok(state.warnings.some((w) => /no 'GptPowerPrompt' AI template/.test(w)));
});

// An org whose template list comes back without a template. The SDK reads the FIRST row of
//   GET /msdyn_aitemplates?$select=msdyn_aitemplateid&$filter=msdyn_uniquename eq 'GptPowerPrompt'&$top=1   ->   { "value": [ { "msdyn_aitemplateid": "<guid>" } ] }
// and raises ROW_SUMMARY_TEMPLATE_NOT_FOUND for an EMPTY list and for nothing else. An answer it cannot read — no list, a first row that is no row, an id that is no GUID —
// is a ConnectionError, so it stops the build like any read that failed and is never taken for an org without the template. (Before cds-maker-sdk 9a0c9f03 it raised the
// code for `[ {} ]` and `[ null ]` too, and the build asked for the list a second time itself, to tell them apart.) The build skips on the code alone and makes no read
// of the template of its own.
const TEMPLATE_LIST = "/msdyn_aitemplates?$select=msdyn_aitemplateid&$filter=msdyn_uniquename eq 'GptPowerPrompt'&$top=1";
const listOf = (value) => ({ status: 200, headers: {}, body: { value } });

// The real SDK over a transport that answers the template list from `answers` (one answer per request, the last one repeating) and records every request, writes included.
// An answer that is an Error is what the transport throws: the request got no answer at all, as when a connection is reset. The mock SDK the build drives gets the real
// `configureRowSummary` (the errors it throws are kept, `sdkErrors`) and a `queryRecords` over the same transport that records the table each read names (`reads`): the
// table set of the template table is answered, so that a read of that table by the build itself would show up in `requests` instead of failing the transport.
async function orgWithTemplateAnswers(t, answers, { skills = listOf([]) } = {}) {
  const { createMakerSdk, createNodeWorkspaceStorage } = require('../vendor/cds-maker-sdk.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'contoso-summary-template-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const requests = [];
  const sdkErrors = [];
  const reads = [];
  let templateReads = 0;
  const seen = (method, url) => requests.push(`${method} ${decodeURIComponent(url.replace(/^https:\/\/contoso\.crm\.dynamics\.com\/api\/data\/v9\.\d+/, ''))}`);
  const write = (method) => async (url) => { seen(method, url); return { status: 200, headers: {}, body: {} }; };
  const real = createMakerSdk({
    workspaceStorage: createNodeWorkspaceStorage(dir),
    instanceUrl: 'https://contoso.crm.dynamics.com',
    httpClient: {
      get: async (url) => {
        seen('GET', url);
        if (url.includes('/aiskillconfigs?')) return skills;
        if (url.includes('/msdyn_aitemplates?')) {
          const answer = answers[Math.min(templateReads++, answers.length - 1)];
          if (answer instanceof Error) throw answer;
          return answer;
        }
        if (url.includes("/EntityDefinitions(LogicalName='msdyn_aitemplate')")) return { status: 200, headers: {}, body: { EntitySetName: 'msdyn_aitemplates' } };
        if (/\/EntityDefinitions\(LogicalName='contoso_\w+'\)/.test(url)) return { status: 200, headers: {}, body: { MetadataId: OLDEST } };
        throw new Error(`unexpected offline GET ${url}`);
      },
      post: write('POST'), patch: write('PATCH'), put: write('PUT'), delete: write('DELETE'),
    },
  });
  await real.initWorkspace();
  const { sdk } = makeSimpleMockSdk();
  sdk.configureRowSummary = async (...args) => {
    try { return await real.configureRowSummary(...args); } catch (err) { sdkErrors.push(err); throw err; }
  };
  sdk.queryRecords = async (entity, query) => { reads.push(entity); return real.queryRecords(entity, query); };
  return {
    sdk,
    sdkErrors,
    requests,
    reads,
    templateReads: () => requests.filter((request) => request.startsWith('GET /msdyn_aitemplates?')),
    writes: () => requests.filter((request) => !request.startsWith('GET ')),
  };
}

const bothTables = () => {
  const s = spec();
  s.entities.push({ ...s.entities[0], schemaName: 'contoso_request' });
  s.ai.summaries.tables.contoso_request = { enabled: true };
  return s;
};

test('an org whose template list is empty skips every summary with one warning and writes nothing, and the build reads no template list of its own, however many tables ask', async (t) => {
  const org = await orgWithTemplateAnswers(t, [listOf([])]);
  const warnings = [];
  const events = [];
  const r = await runSdkBuild(bothTables(), { sdk: org.sdk, apply: true, phases: ['ai-features'], warn: (w) => warnings.push(w), emit: (e) => events.push(e) });
  assert.equal(r.ok, true);
  assert.deepEqual(r.skipped.aiSummaries, ['contoso_ticket', 'contoso_request']);
  assert.deepEqual(events.filter((e) => e.status === 'skip' && /^row summary for /.test(e.label)).map((e) => e.label),
    ['row summary for contoso_ticket (no row-summary AI template in this environment)', 'row summary for contoso_request (no row-summary AI template in this environment)']);
  assert.equal(warnings.length, 1, `one warning for two tables, got ${JSON.stringify(warnings)}`);
  assert.match(warnings[0], /no 'GptPowerPrompt' AI template/);
  assert.deepEqual(org.writes(), []);
  // The SDK reads the list once for each table, and that is every read of it: the build asks nothing more, and reads no table of its own — nothing was written, so there is no model inventory to report either.
  assert.deepEqual(org.templateReads(), Array(2).fill(`GET ${TEMPLATE_LIST}`));
  assert.deepEqual(org.reads, []);
  assert.deepEqual(org.requests.filter((request) => request.includes("LogicalName='msdyn_aitemplate'")), []);
});

// What the SDK cannot read as a list of templates stops the build with the SDK's own error: a ConnectionError, the halt's cause, which says what it could not read. Nothing is skipped, so nothing says it was, and no
// run again helps (the halt's policy is `never`, and so is the check the build's own retry makes): the answer was received, and read as what it is.
const MALFORMED_TEMPLATE_ANSWERS = [
  ['a first row with no id', listOf([{}]), /the row-summary template lookup returned a malformed row — expected a GUID 'msdyn_aitemplateid' but got /],
  ['a first row that is not a row', listOf([null]), /the row-summary template lookup returned a malformed row — expected an object but got /],
  ['a first row whose id is null', listOf([{ msdyn_aitemplateid: null }]), /expected a GUID 'msdyn_aitemplateid' but got /],
  ['a first row whose id is no GUID', listOf([{ msdyn_aitemplateid: 'GptPowerPrompt' }]), /expected a GUID 'msdyn_aitemplateid' but got a string that is not a GUID/],
  ['an answer with no list', { status: 200, headers: {}, body: {} }, /the row-summary template lookup returned a malformed answer — expected an OData 'value' array but got /],
];
for (const [what, answer, words] of MALFORMED_TEMPLATE_ANSWERS) {
  test(`${what} in the template list is not an org without the template: the build stops with the SDK's error and skips nothing`, async (t) => {
    const org = await orgWithTemplateAnswers(t, [answer]);
    const warnings = [];
    const events = [];
    await assert.rejects(runSdkBuild(spec(), { sdk: org.sdk, apply: true, phases: ['ai-features'], warn: (w) => warnings.push(w), emit: (e) => events.push(e) }), (err) => {
      assert.equal(err.name, 'BuildHalt');
      assert.equal(err.code, 'CONNECTION_ERROR');
      assert.equal(err.cause, org.sdkErrors[0], "the SDK's own error is the halt's cause");
      assert.match(err.message, /^ai-features failed: /);
      assert.match(err.message, words);
      assert.equal(err.retry, 'never');
      assert.equal(isTransientHalt(err, { spec: spec() }), false);
      return true;
    });
    assert.deepEqual(warnings, [], 'nothing was skipped, so nothing says it was');
    assert.deepEqual(events.filter((e) => e.status === 'skip'), []);
    assert.deepEqual(org.writes(), []);
    assert.equal(org.templateReads().length, 1, 'the SDK read the list once, and the build asked nothing more');
    assert.deepEqual(org.reads, []);
  });
}

// The SDK's lookup of an existing row-summary skill is as strict: a first row that is no row is an answer it cannot read, never "no row summary yet" — which used to go on to publish a model and bind a
// skill. The build stops with the SDK's own error, and nothing is written (the template is not even read: the skill lookup comes first).
for (const [what, answer, words] of [
  ['a first row that is no row', listOf([null]), /the existing row-summary skill lookup returned a malformed row — expected an object but got /],
  ['an answer with no list', { status: 200, headers: {}, body: {} }, /the existing row-summary skill lookup returned a malformed answer — expected an OData 'value' array but got /],
]) {
  test(`${what} in the skill lookup is not "no row summary yet": the build stops with the SDK's error and writes nothing`, async (t) => {
    const org = await orgWithTemplateAnswers(t, [listOf([{ msdyn_aitemplateid: TEMPLATE }])], { skills: answer });
    const warnings = [];
    await assert.rejects(runSdkBuild(spec(), { sdk: org.sdk, apply: true, phases: ['ai-features'], warn: (w) => warnings.push(w) }), (err) => {
      assert.equal(err.name, 'BuildHalt');
      assert.equal(err.code, 'CONNECTION_ERROR');
      assert.equal(err.cause, org.sdkErrors[0], "the SDK's own error is the halt's cause");
      assert.match(err.message, words);
      assert.equal(err.retry, 'never');
      return true;
    });
    assert.deepEqual(warnings, []);
    assert.deepEqual(org.writes(), [], 'no model was published and no skill was bound');
    assert.deepEqual(org.templateReads(), []);
  });
}

// A failure of the SDK's own read of the template list. The build runs this attempt again, by itself, for a failure the SERVICE calls transient — a throttle (429), a service that is down or overloaded
// (503), a connection that was reset — and reads that from the errors along the halt's causes (lib/retry-policy.js, judgeFailure). The SDK's read is the one read of the list, and its error is the halt's
// own cause: a ConnectionError that carries the status, or the reset, so the chain says what the service said. The read is scripted to fail once and then to answer, so that a second attempt can finish.
const refusedWith = (status, message) => ({ status, headers: {}, body: { error: { message } } });
const connectionReset = () => Object.assign(new Error('Request failed: read ECONNRESET'), { code: 'ECONNRESET' });

for (const [what, make, status] of [['a throttle', () => refusedWith(429, 'Contoso throttled'), 429], ['an unavailable service', () => refusedWith(503, 'Contoso unavailable'), 503], ['a reset connection', connectionReset, 0]]) {
  test(`${what} on the SDK's own read of the template list is a transient halt, which a second attempt can finish`, async (t) => {
    const org = await orgWithTemplateAnswers(t, [make(), listOf([])]);
    const options = (warnings) => ({ sdk: org.sdk, apply: true, phases: ['ai-features'], warn: (w) => warnings.push(w) });
    const warnings = [];
    await assert.rejects(runSdkBuild(spec(), options(warnings)), (err) => {
      assert.equal(err.name, 'BuildHalt');
      assert.equal(isTransientHalt(err, { spec: spec() }), true, 'the build runs this attempt again');
      assert.equal(err.retry, 'service');
      assert.equal(err.cause, org.sdkErrors[0], "the SDK's own error is the halt's cause");
      assert.equal(err.cause.code, 'CONNECTION_ERROR');
      if (status) assert.equal(err.cause.statusCode, status);
      return true;
    });
    assert.deepEqual(warnings, [], 'nothing was skipped, so nothing says it was');
    assert.deepEqual(org.writes(), []);
    assert.deepEqual(org.reads, [], 'and the build read nothing of its own');
    // The attempt after it asks again, and this time the org answers: the list is empty, so the summary is skipped, as it is for any org without the template.
    const again = [];
    const r = await runSdkBuild(spec(), options(again));
    assert.equal(r.ok, true);
    assert.deepEqual(r.skipped.aiSummaries, ['contoso_ticket']);
    assert.equal(again.length, 1);
    assert.match(again[0], /no 'GptPowerPrompt' AI template/);
    assert.equal(org.templateReads().length, 2, 'one read for each attempt');
  });
}

// A refusal is not the service saying that a run again can help.
test("a refusal of the SDK's own read of the template list (403) is final: the build stops with the SDK's error and skips nothing", async (t) => {
  const org = await orgWithTemplateAnswers(t, [refusedWith(403, 'Contoso permission denied')]);
  const warnings = [];
  await assert.rejects(runSdkBuild(spec(), { sdk: org.sdk, apply: true, phases: ['ai-features'], warn: (w) => warnings.push(w) }), (err) => {
    assert.equal(err.name, 'BuildHalt');
    assert.equal(err.cause, org.sdkErrors[0]);
    assert.equal(err.cause.statusCode, 403);
    assert.match(err.message, /Contoso permission denied/);
    assert.equal(err.retry, 'never');
    assert.equal(isTransientHalt(err, { spec: spec() }), false);
    return true;
  });
  assert.deepEqual(warnings, []);
  assert.deepEqual(org.writes(), []);
});

// The skip is the SDK's word for an empty list, and only that word: the code is matched exactly, in the error's own `code`.
test('only the exact template code skips the summaries for a missing template: a refusal of another kind is skipped or stops the build as it always did', async () => {
  for (const code of ['DuplicateRecordKey', 'ModelNotSupported']) {
    const { sdk, state } = summarySdk(code);
    const entities = [];
    const inventory = sdk.queryRecords;
    sdk.queryRecords = async (entity, query) => { entities.push(entity); return inventory(entity, query); };
    const r = await runSdkBuild(spec(), { sdk, apply: true, phases: ['ai-features'], warn: (w) => state.warnings.push(w) });
    assert.equal(r.ok, true, code);
    assert.deepEqual(entities, ['msdyn_aimodel'], `${code}: only the model inventory that the skip reports`);
  }
  const lookalikes = [
    ['a longer code', () => Object.assign(new Error('not available'), { code: 'ROW_SUMMARY_TEMPLATE_NOT_FOUND_EXTRA' })],
    ['a mention in the message', () => Object.assign(new Error('ROW_SUMMARY_TEMPLATE_NOT_FOUND'), { code: 'CONNECTION_ERROR' })],
    ['a code in the cause', () => Object.assign(new Error('permission denied'), { code: 'CONNECTION_ERROR', cause: { code: 'ROW_SUMMARY_TEMPLATE_NOT_FOUND' } })],
  ];
  for (const [what, make] of lookalikes) {
    const { sdk } = makeSimpleMockSdk();
    const entities = [];
    sdk.configureRowSummary = async () => { throw make(); };
    sdk.queryRecords = async (entity) => { entities.push(entity); return []; };
    await assert.rejects(runSdkBuild(spec(), { sdk, apply: true, phases: ['ai-features'], warn: () => {} }), (err) => err.name === 'BuildHalt', what);
    assert.deepEqual(entities, [], `${what}: the build stops, and reads nothing of its own`);
  }
});
