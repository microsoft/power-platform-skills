'use strict';
// Teardown's row-summary step says what it found. The SDK's `removeRowSummary` answers nothing whether it removed a row summary or found none to remove, and the step took
// "the call did not throw" for "one was deleted": a table with no row summary was reported `✓ row summary <table> (1 deleted)`, in the line and in the closing count. The step now
// looks first — with the request the SDK itself makes — and reports what that read found, like every other step. The step stays best-effort, as it always was (a failure of
// the lookup or of the removal fails nothing), but what it could not do is said on its line instead of being counted as a deletion.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runTeardown, KIND_HANDLERS } = require('../lib/sdk-teardown.js');
const { teardownModelApp: engineTeardownModelApp } = require('../teardown-model-app.js');
const { createMakerSdk, createNodeWorkspaceStorage } = require('../lib/maker-sdk.js');
const { createAzHttpClient } = require('../lib/sdk-http-client.js');

const ENV = 'https://contoso.crm.dynamics.com';
const teardownModelApp = (spec, opts, deps) => engineTeardownModelApp(spec, { env: ENV, ...opts }, deps);

// A spec whose one table gets a row summary: the build would make one for the Memo column, so teardown plans its removal.
const SPEC = {
  solution: { uniqueName: 'AiTest', publisherPrefix: 'new' },
  app: { name: 'AiApp' },
  entities: [{ schemaName: 'new_memo', displayName: 'Memo', primaryAttribute: { schemaName: 'new_name' }, columns: [{ schemaName: 'new_body', displayName: 'Body', type: 'Memo' }] }],
  relationships: [],
  ai: { summaries: { default: 'auto' } },
};
const SKILL_ROW = { aiskillconfigid: '11111111-1111-1111-1111-111111111111' };
const LOOKUP = "/aiskillconfigs?$select=aiskillconfigid&$filter=uniquename eq 'ais_RowSummary_new_memo'&$top=1";

// An SDK double whose Dataverse holds `rows` as the skill rows the lookup finds, and which records every call. `lookup` and `remove` replace the answer of the read and the
// removal (to answer another status, or to throw).
function summarySdk({ rows = [], lookup, remove } = {}) {
  const calls = [];
  const sdk = {
    resolveArtifact: async (kind) => (kind === 'solution' ? [{ id: 'sol-1', name: 'AiTest' }] : []),
    queryRecords: async () => [],
    dataverse: {
      get: async (url) => {
        calls.push({ method: 'get', path: url });
        return lookup ? lookup() : { status: 200, body: { value: rows } };
      },
    },
    removeRowSummary: async (args) => {
      calls.push({ method: 'removeRowSummary', ...args });
      if (remove) throw remove();
    },
    deleteTable: async () => { throw Object.assign(new Error('Could not find an entity with specified id'), { statusCode: 404 }); },
    deleteSolution: async () => {},
  };
  return { sdk, calls, removals: () => calls.filter((c) => c.method === 'removeRowSummary') };
}

const stepEvents = (events) => events.filter((e) => e.phase === 'ai-summaries' && e.status !== 'start');
async function run(sdk, spec = SPEC) {
  const events = [];
  const result = await runTeardown(spec, { apply: true }, { sdk, emit: (e) => events.push(e) });
  return { result, events: stepEvents(events) };
}

test('a table with no row summary is reported as not found, and nothing is sent to remove one', async () => {
  const { sdk, removals } = summarySdk({ rows: [] });
  const { result, events } = await run(sdk);
  assert.strictEqual(result.ok, true, JSON.stringify(result.errors));
  assert.deepStrictEqual(events.map((e) => [e.status, e.skip, e.label]), [['skip', 'not-found', 'row summary new_memo (not found)']]);
  assert.deepStrictEqual(removals(), [], 'there is nothing to remove');
  assert.strictEqual(result.deleted.aiSummary, undefined, 'and nothing deleted is counted');
  assert.ok(result.skipped.includes('row summary new_memo'));
});

test('a row summary the environment holds is removed once, and reported as deleted', async () => {
  const { sdk, removals } = summarySdk({ rows: [SKILL_ROW] });
  const { result, events } = await run(sdk);
  assert.strictEqual(result.ok, true, JSON.stringify(result.errors));
  assert.deepStrictEqual(events.map((e) => [e.status, e.label]), [['ok', 'row summary new_memo (1 deleted)']]);
  assert.deepStrictEqual(removals().map((c) => c.entityLogicalName), ['new_memo']);
  assert.deepStrictEqual(result.deleted.aiSummary, ['new_memo']);
});

test('the step looks for the skill row by the SDK\u2019s own request, before it removes anything', async () => {
  const { sdk, calls } = summarySdk({ rows: [SKILL_ROW] });
  await run(sdk);
  assert.deepStrictEqual(calls.filter((c) => c.method === 'get').map((c) => c.path), [LOOKUP]);
  assert.ok(calls.findIndex((c) => c.method === 'get') < calls.findIndex((c) => c.method === 'removeRowSummary'));
});

test('an environment that has no AI skill table holds no row summary: not found, not a failure', async () => {
  const { sdk, removals } = summarySdk({ lookup: () => ({ status: 404, body: { error: { message: "Resource not found for the segment 'aiskillconfigs'." } } }) });
  const { result, events } = await run(sdk);
  assert.strictEqual(result.ok, true, JSON.stringify(result.errors));
  assert.deepStrictEqual(events.map((e) => [e.status, e.skip, e.label]), [['skip', 'not-found', 'row summary new_memo (not found)']]);
  assert.deepStrictEqual(removals(), []);
});

test('a lookup that cannot be made leaves what is there unknown: said on the step, nothing removed, nothing failed', async () => {
  for (const [what, lookup, reason] of [
    ['a refusal', () => ({ status: 403, body: { error: { message: 'no read privilege' } } }), /^row summary new_memo \(not looked up \u2014 the lookup answered HTTP 403; a row summary left behind is reported by the table's delete\)$/],
    ['an answer that is no list', () => ({ status: 200, body: { value: 'busy' } }), /^row summary new_memo \(not looked up \u2014 the lookup's answer was no list; a row summary left behind is reported by the table's delete\)$/],
    ['a request that failed', () => { throw new Error('socket hang up'); }, /^row summary new_memo \(not looked up \u2014 socket hang up; a row summary left behind is reported by the table's delete\)$/],
  ]) {
    const { sdk, removals } = summarySdk({ lookup });
    const { result, events } = await run(sdk);
    assert.strictEqual(result.ok, true, `${what}: the step is best-effort, as it was: ${JSON.stringify(result.errors)}`);
    assert.deepStrictEqual(events.map((e) => [e.status, e.skip]), [['skip', 'kept']], what);
    assert.match(events[0].label, reason, what);
    assert.deepStrictEqual(removals(), [], `${what}: the SDK\u2019s own removal would have made the same request`);
  }
});

test('a removal that fails is not a deletion: said on the step in the SDK\u2019s words, and it still fails nothing', async () => {
  const words = "The row summary of 'new_memo' was removed, but its AI model '22222222-2222-2222-2222-222222222222' was not deleted (HTTP 400: refused).";
  const { sdk, removals } = summarySdk({ rows: [SKILL_ROW], remove: () => Object.assign(new Error(words), { code: 'ROW_SUMMARY_MODEL_NOT_DELETED' }) });
  const { result, events } = await run(sdk);
  assert.strictEqual(result.ok, true, 'best-effort: the table\u2019s delete that follows reports what still depends on the row summary');
  assert.deepStrictEqual(events.map((e) => [e.status, e.label]), [['ok', `row summary new_memo (0 deleted, 1 not removed: ${words})`]]);
  assert.strictEqual(removals().length, 1);
  assert.deepStrictEqual(result.deleted.aiSummary, []);
  assert.deepStrictEqual(result.skipped.filter((s) => /^row summary new_memo/.test(s)), [`row summary new_memo (1 not removed: ${words} \u2014 skipped)`]);
});

test('the printed step and the closing counts follow what was found', async () => {
  const tally = async (options) => {
    const logs = [];
    const { sdk } = summarySdk(options);
    const result = await teardownModelApp(SPEC, { apply: true, allowDestructive: true }, { sdk, log: (m) => logs.push(m) });
    assert.strictEqual(result.ok, true, JSON.stringify(result.errors));
    const closing = /\u2014 (\d+) deleted, (\d+) not found, 0 failed \((\d+) steps\)/.exec(logs.find((l) => /teardown complete/.test(l)));
    assert.ok(closing, logs.join('\n'));
    return { logs, deleted: Number(closing[1]), notFound: Number(closing[2]), steps: Number(closing[3]) };
  };
  const none = await tally({ rows: [] });
  const one = await tally({ rows: [SKILL_ROW] });
  assert.ok(none.logs.some((l) => /^ {2}\[\d+\/\d+\] \u2298 row summary new_memo \(not found\)$/.test(l)), none.logs.join('\n'));
  assert.ok(!none.logs.some((l) => /row summary new_memo \(1 deleted\)/.test(l)));
  assert.ok(one.logs.some((l) => /^ {2}\[\d+\/\d+\] \u2713 row summary new_memo \(1 deleted\)$/.test(l)), one.logs.join('\n'));
  // The same plan, so the one step that differs moves one count into the other: a summary nothing held is not a deletion.
  assert.strictEqual(none.steps, one.steps);
  assert.strictEqual(one.deleted - none.deleted, 1);
  assert.strictEqual(none.notFound - one.notFound, 1);
});

// --- the real SDK ----------------------------------------------------------------------------------------------------------------------------------------------

// `removeRowSummary` finds the row summary by its skill row — `GET /aiskillconfigs?…$filter=uniquename eq 'ais_RowSummary_<table>'` — and the step must look for the same row, or a
// row summary the SDK would remove is reported as not there and left to block the table's delete. The unique name is a constant inside the bundle, so the one the step uses is held to what
// the real bundle asks for, over a fake Dataverse that answers by the filter.
function fakeSkillOrg({ rows = [], status = 200 } = {}) {
  const requests = [];
  const json = (statusCode, body) => ({ statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  async function request({ url, method }) {
    const where = decodeURIComponent(new URL(url).pathname + new URL(url).search);
    requests.push({ method, path: where });
    if (method === 'GET' && /\/aiskillconfigs\?/.test(where)) return json(status, status === 200 ? { value: rows } : { error: { message: "Resource not found for the segment 'aiskillconfigs'." } });
    return method === 'GET' ? json(200, { value: [] }) : { statusCode: 204, headers: {}, body: '' };
  }
  const httpClient = createAzHttpClient(ENV, { getToken: () => 'token', request, sleep: async () => {} });
  return { httpClient, requests };
}
const dirs = [];
test.after(() => { for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true }); });
async function realSdk(org) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teardown-summary-'));
  dirs.push(dir);
  const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(dir), instanceUrl: ENV, httpClient: org.httpClient });
  await sdk.initWorkspace();
  return sdk;
}
const skillFilters = (requests) => requests.map((r) => /\/aiskillconfigs\?.*\$filter=([^&]+)/.exec(r.path)).filter(Boolean).map((m) => m[1]);

test('REAL BUNDLE: the step\u2019s lookup asks for the unique name the bundle\u2019s own removal asks for', async () => {
  const bundleOrg = fakeSkillOrg();
  await (await realSdk(bundleOrg)).removeRowSummary({ entityLogicalName: 'new_memo' });
  const stepOrg = fakeSkillOrg();
  assert.deepStrictEqual(await KIND_HANDLERS.aiSummary.resolve(await realSdk(stepOrg), { entityLogicalName: 'new_memo' }), []);
  assert.deepStrictEqual(skillFilters(bundleOrg.requests), ["uniquename eq 'ais_RowSummary_new_memo'"]);
  assert.deepStrictEqual(skillFilters(stepOrg.requests), skillFilters(bundleOrg.requests));
  assert.strictEqual(stepOrg.requests.length, 1, 'one read, and nothing else is asked');
});

test('REAL BUNDLE: a skill row the environment holds is found, and one it does not hold is not', async () => {
  const found = await KIND_HANDLERS.aiSummary.resolve(await realSdk(fakeSkillOrg({ rows: [SKILL_ROW] })), { entityLogicalName: 'new_memo' });
  assert.deepStrictEqual(found, [{ id: 'new_memo', entityLogicalName: 'new_memo' }]);
  assert.deepStrictEqual(await KIND_HANDLERS.aiSummary.resolve(await realSdk(fakeSkillOrg({ rows: [] })), { entityLogicalName: 'new_memo' }), []);
});

test('REAL BUNDLE: an environment with no AI skill table is reported as not found through the whole teardown', async () => {
  const sdk = await realSdk(fakeSkillOrg({ status: 404 }));
  // No app and no solution in the plan: what the real SDK would be asked about them is not this test's.
  const { result, events } = await run(sdk, { entities: SPEC.entities, ai: SPEC.ai });
  assert.deepStrictEqual(events.map((e) => [e.status, e.label]), [['skip', 'row summary new_memo (not found)']], JSON.stringify(result.errors));
});
