'use strict';
// commandStates[] through the build's own entry point (lib/sdk-build.js runSdkBuild): the plan a dry run prints, the refusals that come before the
// build writes anything, the one conditional flag-only PATCH an approved apply sends, the outcomes of that PATCH, and the table publication the
// apply must see before it reports success. The SDK is the light mock (helpers/mock-sdk.js) with a raw client for the before-app table publish;
// the command rows are the fake org of helpers/command-state-org.js, reached through the real raw client (createAzHttpClient) and the feature's
// own transport, so the retry and send-once behaviour under test is the shipped one.

const test = require('node:test');
const assert = require('node:assert');
const { inOwnFolder } = require('./helpers/own-app-folder.js');
const runSdkBuild = inOwnFolder(require('../lib/sdk-build.js').runSdkBuild);
const { makeSimpleMockSdk } = require('./helpers/mock-sdk.js');
const { createAzHttpClient } = require('../lib/sdk-http-client.js');
const { createCommandStateTransport, commandStateSendOnce } = require('../lib/command-state-transport.js');
const { createCommandStateOrg, commandRow, json, ORIGIN, APP_ID } = require('./helpers/command-state-org.js');
const { validateAppSpec } = require('../lib/app-spec.js');

const T = 'new_ticket';
const MD = '44444444-4444-4444-8444-444444444444';
const ROW = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ROW2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const API = `${ORIGIN}/api/data/v9.2`;
const HIDE = { entity: T, location: 'MainTab', scope: 'table', rowId: ROW, hidden: true };
// A legacy commands[] button and the script it runs.
const LEGACY = (extra = {}) => ({ commands: [{ entity: T, label: 'Go', library: 'new_go.js', function: 'Ns.go', ...extra }], webResources: [{ name: 'new_go.js', type: 'js', content: 'var Ns = {};' }] });

function specFor(states = [HIDE], extra = {}) {
  const spec = {
    minimumPluginVersion: '2.24.0',
    solution: { uniqueName: 'ContosoSD', displayName: 'Contoso SD', publisherPrefix: 'new' },
    app: { name: 'Support', uniqueName: 'contoso_Support' },
    entities: [{ schemaName: T, displayName: 'Ticket', primaryAttribute: { schemaName: 'new_subject', displayName: 'Subject' } }],
    appShell: { areas: [{ label: 'Main', groups: [{ label: 'Records', subAreas: [{ entity: T, title: 'Tickets' }] }] }] },
    ...(states ? { commandStates: states } : {}),
    ...extra,
  };
  assert.deepStrictEqual(validateAppSpec(spec).errors, [], 'the fixture is a valid spec');
  return spec;
}

// The tables a PublishXml body names: { "ParameterXml": "<importexportxml><entities><entity>new_ticket</entity></entities></importexportxml>" }
const tablesOf = (body) => [...String((body && body.ParameterXml) || '').matchAll(/<entity>([^<]+)<\/entity>/g)].map((m) => m[1]);

function harness({ rows = [commandRow(ROW, T, MD)], publishStatus = 204, onPublish, ...orgOptions } = {}) {
  const org = createCommandStateOrg({ writable: true, tables: { [T]: { metadataId: MD } }, rows, ...orgOptions });
  const client = createAzHttpClient(ORIGIN, { getToken: () => 'test-token', request: org.request, sleep: async () => {}, sendOnce: commandStateSendOnce });
  const transport = createCommandStateTransport({ client, apiUrl: (p) => `${API}${p}` });
  const published = [];
  const mockSdk = () => {
    const { sdk, calls } = makeSimpleMockSdk();
    sdk.dataverse = {
      apiUrl: (p) => `${API}${p}`,
      post: async (url, body) => { published.push(tablesOf(body)); if (onPublish) onPublish(tablesOf(body)); return { status: publishStatus, body: null }; },
    };
    return { sdk, calls };
  };
  const build = async (spec, opts = {}) => {
    const { sdk, calls } = mockSdk();
    const warnings = [];
    const run = { sdk, env: ORIGIN, commandStateTransport: transport, emit: () => {}, warn: (w) => warnings.push(String(w)), ...opts };
    try {
      return { res: await runSdkBuild(spec, run), calls, warnings };
    } catch (error) {
      return { error, calls, warnings };
    }
  };
  // The approvals a dry run prints, exactly as an author would pass them back.
  const approve = async (spec) => {
    const { res, error } = await build(spec, { apply: false });
    assert.ifError(error);
    const plan = res.commandStatePlan;
    return { plan, approvals: { rows: new Set(plan.rows.map((r) => r.approval).filter(Boolean)), tables: new Set(plan.tables.map((t) => t.token)) } };
  };
  const patches = () => org.requests.filter((r) => r.method === 'PATCH');
  return { org, build, approve, published, patches, transport, mockSdk };
}

const APPLY = { apply: true, publish: true };

test('a dry run reads each declared row and prints the exact approvals; it writes and publishes nothing', async () => {
  const h = harness();
  const { plan } = await h.approve(specFor());
  assert.strictEqual(plan.status, 'planned');
  assert.strictEqual(plan.rows.length, 1);
  assert.deepStrictEqual(plan.rows[0].change, { hidden: true });
  assert.match(plan.rows[0].approval, new RegExp(`^overwrite:command-state:${T}/MainTab/${ROW}/[0-9a-f]{64}$`));
  assert.match(plan.rows[0].description, /table scope: every app that shows this table/);
  assert.deepStrictEqual(plan.tables.map((t) => t.entity), [T]);
  assert.match(plan.tables[0].token, new RegExp(`^publish:command-state-table:${T}/[0-9a-f]{64}$`));
  assert.deepStrictEqual(h.org.writes(), []);
  assert.deepStrictEqual(h.published, []);
  assert.deepStrictEqual(h.org.unexpected, []);
});

test('an approved apply sends one conditional, flag-only PATCH, publishes the table before the app and reports both', async () => {
  const h = harness();
  const spec = specFor();
  const { approvals } = await h.approve(spec);
  const { res, error } = await h.build(spec, { ...APPLY, commandStateApprovals: approvals });
  assert.ifError(error);
  assert.strictEqual(res.ok, true);
  const sent = h.patches();
  assert.strictEqual(sent.length, 1, 'one exact flag-only conditional PATCH was captured');
  assert.strictEqual(sent[0].path, `/appactions(${ROW})`);
  assert.strictEqual(sent[0].headers['If-Match'], 'W/"1001"');
  assert.deepStrictEqual(sent[0].body, { hidden: true });
  assert.ok(!Object.keys(sent[0].headers).some((k) => /solutionuniquename/i.test(k)), 'a reused row is never put into a solution');
  assert.ok(h.published.some((names) => names.includes(T)), `the table is named in a before-app publish: ${JSON.stringify(h.published)}`);
  assert.deepStrictEqual(res.commandStates.rows.map((r) => [r.rowId, r.outcome, r.changed]), [[ROW, 'acknowledged', ['hidden']]]);
  assert.deepStrictEqual(res.commandStates.publication.map((p) => [p.entity, p.outcome]), [[T, 'confirmed']]);
  assert.deepStrictEqual(h.org.unexpected, []);
});

test('false is an instruction and is sent; a flag the entry leaves out is never sent; visibilitytype is never written', async () => {
  const h = harness({ rows: [commandRow(ROW, T, MD, { hidden: true, isdisabled: true })] });
  const spec = specFor([{ entity: T, location: 'MainTab', scope: 'table', rowId: ROW, hidden: false }]);
  const { approvals } = await h.approve(spec);
  const { error } = await h.build(spec, { ...APPLY, commandStateApprovals: approvals });
  assert.ifError(error);
  assert.deepStrictEqual(h.patches().map((r) => r.body), [{ hidden: false }]);
});

test('a row that already holds the declared flags is not written, and its table is still published and confirmed', async () => {
  const h = harness({ rows: [commandRow(ROW, T, MD, { hidden: true })] });
  const spec = specFor();
  const { plan, approvals } = await h.approve(spec);
  assert.deepStrictEqual(plan.rows[0].change, {});
  const { res, error } = await h.build(spec, { ...APPLY, commandStateApprovals: approvals });
  assert.ifError(error);
  assert.deepStrictEqual(h.patches(), []);
  assert.ok(h.published.some((names) => names.includes(T)));
  assert.deepStrictEqual(res.commandStates.publication.map((p) => p.outcome), ['confirmed']);
});

test('an apply without every approval stops before the build writes anything at all', async () => {
  for (const which of ['none', 'rows only', 'tables only']) {
    const h = harness();
    const spec = specFor();
    const { approvals } = await h.approve(spec);
    const given = which === 'none' ? {} : which === 'rows only' ? { rows: approvals.rows } : { tables: approvals.tables };
    const { error, calls } = await h.build(spec, { ...APPLY, commandStateApprovals: given });
    assert.ok(error, which);
    assert.match(error.code, /^command-state-(publication-)?approval-required$/, which);
    assert.deepStrictEqual(h.org.writes(), [], `${which}: no row write`);
    assert.deepStrictEqual(h.published, [], `${which}: no publish`);
    assert.deepStrictEqual(calls.filter(([name]) => /^(create|update|add|push|publish|set|seed|enrich|configure|delete)/.test(name)), [], `${which}: no build write (solution, table, app)`);
  }
});

test('a row that changed after it was approved is not written: the approval is stale', async () => {
  const rows = [commandRow(ROW, T, MD)];
  const h = harness({ rows });
  const spec = specFor();
  const { approvals } = await h.approve(spec);
  rows[0]['@odata.etag'] = 'W/"1002"';
  const { error } = await h.build(spec, { ...APPLY, commandStateApprovals: approvals });
  assert.strictEqual(error && error.code, 'command-state-approval-stale');
  assert.deepStrictEqual(h.org.writes(), []);
});

test('a row changed between the read and the write is refused 412, never sent again and never overwritten', async () => {
  const rows = [commandRow(ROW, T, MD)];
  const h = harness({
    rows,
    overrides: (req) => { if (req.method === 'PATCH') { rows[0]['@odata.etag'] = 'W/"2000"'; rows[0].buttonlabeltext = 'Someone else'; } return undefined; },
  });
  const spec = specFor();
  const { approvals } = await h.approve(spec);
  const { error } = await h.build(spec, { ...APPLY, commandStateApprovals: approvals });
  assert.strictEqual(error && error.code, 'command-state-version-conflict');
  assert.strictEqual(h.patches().length, 1);
  assert.strictEqual(rows[0].hidden, false, 'the newer row is kept');
  assert.deepStrictEqual(error.commandStates.rows.map((r) => [r.outcome, r.code]), [['refused', 'command-state-version-conflict']]);
});

test('a write whose answer is lost or throttled is sent exactly once and reported as unknown', async () => {
  for (const [what, answer] of [
    ['503', () => json(503, { error: { code: '0x80072321', message: 'unavailable' } })],
    ['429', () => json(429, { error: { code: '0x80072322', message: 'throttled' } }, { 'retry-after': '1' })],
    ['cut', () => { throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }); }],
  ]) {
    const h = harness({ overrides: (req) => (req.method === 'PATCH' ? answer() : undefined) });
    const spec = specFor();
    const { approvals } = await h.approve(spec);
    const { error } = await h.build(spec, { ...APPLY, commandStateApprovals: approvals });
    assert.strictEqual(h.patches().length, 1, `${what}: sent once`);
    assert.strictEqual(error && error.code, 'command-state-write-unknown', what);
    assert.strictEqual(error.retry && error.retry.kind !== undefined ? error.retry.kind : error.retry, require('../lib/retry-policy.js').RETRY.NEVER, `${what}: never retried`);
  }
});

test('a write that landed although its answer was lost is reported from the row read back, and still not sent again', async () => {
  const h = harness({ afterPatch: () => json(503, { error: { code: '0x80072321', message: 'unavailable' } }) });
  const spec = specFor();
  const { approvals } = await h.approve(spec);
  const { res, error } = await h.build(spec, { ...APPLY, commandStateApprovals: approvals });
  assert.strictEqual(h.patches().length, 1);
  const rows = (res || error).commandStates.rows;
  assert.deepStrictEqual(rows.map((r) => r.outcome), ['observed-matching-after-unknown-send']);
});

test('a table publish that is refused leaves the write saved but unconfirmed, and the apply fails saying so', async () => {
  const h = harness({ publishStatus: 500 });
  const spec = specFor();
  const { approvals } = await h.approve(spec);
  const { error } = await h.build(spec, { ...APPLY, commandStateApprovals: approvals });
  assert.ok(error, 'the apply does not report success');
  assert.strictEqual(error.code, 'command-state-publish-unconfirmed');
  assert.strictEqual(h.patches().length, 1);
  assert.deepStrictEqual(error.commandStates.publication.map((p) => [p.entity, p.outcome]), [[T, 'unconfirmed']]);
  assert.deepStrictEqual(error.commandStatePublicationError.tables, [T]);
});

test('an app-scoped row is refused before any write, even one scoped to this app', async () => {
  const h = harness({ rows: [commandRow(ROW, T, MD, { _appmoduleid_value: APP_ID })] });
  const spec = specFor();
  const { error } = await h.build(spec, { ...APPLY, commandStateApprovals: { rows: new Set(), tables: new Set() } });
  assert.strictEqual(error && error.code, 'command-state-app-scope-unverified');
  assert.deepStrictEqual(h.org.writes(), []);
});

test('commands[] that would create a new bar on a table whose row commandStates edits is refused before the create', async () => {
  const h = harness();
  const spec = specFor([HIDE], LEGACY());
  const { approvals } = await h.approve(spec);
  const { error, calls } = await h.build(spec, { ...APPLY, commandStateApprovals: approvals });
  assert.strictEqual(error && error.code, 'command-state-legacy-create-conflict');
  assert.deepStrictEqual(calls.filter(([name, kind]) => name === 'createArtifact' && kind === 'command'), []);
  assert.deepStrictEqual(h.org.writes(), []);
});

test('only a full build with --publish applies command states: anything else is refused before it writes, and exactly --stage data leaves them alone', async () => {
  const { STAGES } = require('../lib/stages.js');
  for (const [what, opts, code] of [
    ['no --publish', { apply: true, publish: false }, 'command-state-publish-required'],
    ['a partial apply', { apply: true, publish: true, phases: ['commands'] }, 'command-state-phase-unsupported'],
  ]) {
    const h = harness();
    const { error, calls } = await h.build(specFor(), opts);
    assert.strictEqual(error && error.code, code, what);
    assert.deepStrictEqual(h.org.requests, [], `${what}: nothing read or written`);
    assert.deepStrictEqual(calls.filter(([name]) => /^(create|update|add|push|publish|set|seed)/.test(name)), [], what);
  }
  const keyed = harness();
  const { error } = await keyed.build(specFor([HIDE], LEGACY({ key: 'go' })), APPLY);
  assert.strictEqual(error && error.code, 'command-state-keyed-unsupported');
  {
    const h = harness();
    const { error: dataError, warnings } = await h.build(specFor(), { apply: true, publish: true, phases: STAGES.data });
    assert.ifError(dataError);
    assert.deepStrictEqual(h.org.requests, [], '--stage data reads no command row');
    assert.ok(warnings.some((w) => /commandStates/.test(w)), 'and says the states were not applied');
  }
});

test('a spec without commandStates builds as before: no command row is read and no result is added', async () => {
  const h = harness();
  const { res, error } = await h.build(specFor(null), APPLY);
  assert.ifError(error);
  assert.strictEqual(res.ok, true);
  assert.deepStrictEqual(h.org.requests, []);
  assert.strictEqual(res.commandStates, undefined);
  const dry = await h.build(specFor(null), { apply: false });
  assert.strictEqual(dry.res.commandStatePlan, undefined);
  const empty = harness();
  const out = await empty.build(specFor([]), APPLY);
  assert.ifError(out.error);
  assert.strictEqual(out.res.ok, true, 'an empty list is the feature switched off, as absent is');
  assert.deepStrictEqual(empty.org.requests, []);
  assert.strictEqual(out.res.commandStates, undefined);
});

test('the engine checks commandStates itself: a direct caller with an app-scoped or malformed declaration is stopped before any request', async () => {
  for (const [what, commandStates, code] of [
    ['app scope', [{ ...HIDE, scope: 'app' }], 'command-state-app-scope-unverified'],
    ['null', null, 'command-state-spec-invalid'],
    ['an object, not a list', { ...HIDE }, 'command-state-spec-invalid'],
    ['a commands[] field', [{ ...HIDE, label: 'Go' }], 'command-state-spec-invalid'],
    ['app scope and a malformed flag', [{ ...HIDE, scope: 'app', hidden: 'yes' }], 'command-state-spec-invalid'],
  ]) {
    for (const mode of ['apply', 'dry run']) {
      const h = harness();
      // Exact approvals for the valid declaration: the bad one must not ride on them.
      const { approvals } = await h.approve(specFor());
      const mark = h.org.requests.length;
      const { error, calls } = await h.build({ ...specFor(), commandStates }, mode === 'apply' ? { ...APPLY, commandStateApprovals: approvals } : { apply: false });
      assert.strictEqual(error && error.code, code, `${what} (${mode})`);
      assert.match(error.message, /commandStates/, `${what} (${mode}): the halt names the field`);
      assert.deepStrictEqual(h.org.requests.slice(mark), [], `${what} (${mode}): no command row is read or written`);
      assert.deepStrictEqual(calls, [], `${what} (${mode}): the SDK is not called`);
      assert.deepStrictEqual(h.published, [], `${what} (${mode}): nothing is published`);
    }
  }
});

test('two rows on one table: each is written once, and one publish of the table confirms both', async () => {
  const h = harness({ rows: [commandRow(ROW, T, MD), commandRow(ROW2, T, MD, { location: 1 })] });
  const spec = specFor([HIDE, { entity: T, location: 'HomeTab', scope: 'table', rowId: ROW2, disabled: true }]);
  const { plan, approvals } = await h.approve(spec);
  assert.strictEqual(plan.rows.length, 2);
  assert.strictEqual(plan.tables.length, 1, 'one table approval covers both rows');
  const { res, error } = await h.build(spec, { ...APPLY, commandStateApprovals: approvals });
  assert.ifError(error);
  assert.deepStrictEqual(h.patches().map((r) => [r.path, r.body]), [[`/appactions(${ROW})`, { hidden: true }], [`/appactions(${ROW2})`, { isdisabled: true }]]);
  assert.deepStrictEqual(res.commandStates.publication.map((p) => p.outcome), ['confirmed']);
});

test('every row is read again before the first write: one changed after the preflight stops the apply with no row written', async () => {
  const rows = [commandRow(ROW, T, MD), commandRow(ROW2, T, MD, { location: 1 })];
  let armed = false;
  let reads = 0;
  // The apply reads ROW2 at its preflight, then again in the commands phase; it changes in between.
  const overrides = (req) => {
    if (armed && req.method === 'GET' && req.path.startsWith(`/appactions(${ROW2})`) && ++reads === 2) rows[1]['@odata.etag'] = 'W/"3000"';
    return undefined;
  };
  const h = harness({ rows, overrides });
  const spec = specFor([HIDE, { entity: T, location: 'HomeTab', scope: 'table', rowId: ROW2, disabled: true }]);
  const { approvals } = await h.approve(spec);
  armed = true;
  const { error } = await h.build(spec, { ...APPLY, commandStateApprovals: approvals });
  assert.strictEqual(error && error.code, 'command-state-approval-stale');
  assert.ok(reads >= 2, `the row was read at the preflight and again before any write (${reads})`);
  assert.deepStrictEqual(h.patches(), [], 'no row was written, not even the one that did not change');
});

test('the final proof resolves the app afresh after the build\'s app work: a table no longer in the app fails the apply, and the written row stays reported as written', async () => {
  const tables = { [T]: { metadataId: MD } };
  // The before-app publication is the last shared step before the final proof; the table leaves the app there, after the commands phase.
  const h = harness({ tables, onPublish: () => { tables[T].inApp = false; } });
  const spec = specFor();
  const { approvals } = await h.approve(spec);
  const { error } = await h.build(spec, { ...APPLY, commandStateApprovals: approvals });
  assert.strictEqual(error && error.code, 'command-state-context-unverified', error && error.message);
  assert.match(error.message, /checked again at the end of the build, after its app work; nothing is rolled back \(command state [^)]*: written by this build: the write was accepted and read back holding the declared flags\)/);
  assert.strictEqual(h.patches().length, 1, 'the row was written once and is never written again or undone');
  assert.deepStrictEqual(error.commandStates.rows.map((r) => [r.rowId, r.outcome]), [[ROW, 'acknowledged']], 'the row outcome is what was observed');
  assert.deepStrictEqual(error.commandStates.publication.map((p) => [p.entity, p.outcome]), [[T, 'confirmed']], 'and the publication that ran stands');
  assert.strictEqual(error.commandStatePublicationError, undefined);
});

test('the final proof also fails a row that no longer holds the declared flags after the publication', async () => {
  const rows = [commandRow(ROW, T, MD)];
  const h = harness({ rows, onPublish: () => { rows[0].hidden = false; } });
  const spec = specFor();
  const { approvals } = await h.approve(spec);
  const { error } = await h.build(spec, { ...APPLY, commandStateApprovals: approvals });
  assert.strictEqual(error && error.code, 'command-state-not-confirmed', error && error.message);
  assert.match(error.message, /nothing is rolled back \(.*\): .*it now holds hidden false/);
  assert.match(error.message, /it now holds hidden false, disabled false: the flags no longer match, so the row changed during the build, after this build's step for it \(written by this build: the write was accepted and read back holding the declared flags\)/);
  assert.match(error.message, /this build did not overwrite that change/);
  assert.strictEqual(h.patches().length, 1);
  assert.strictEqual(error.commandStates.rows[0].outcome, 'acknowledged');
});

test('a row this build left unchanged that drifts before the final proof fails without a write being claimed', async () => {
  const rows = [commandRow(ROW, T, MD, { hidden: true })];
  const h = harness({ rows, onPublish: () => { rows[0].hidden = false; rows[0]['@odata.etag'] = 'W/"2000"'; } });
  const spec = specFor();
  const { approvals } = await h.approve(spec);
  const { error } = await h.build(spec, { ...APPLY, commandStateApprovals: approvals });
  assert.strictEqual(error && error.code, 'command-state-not-confirmed', error && error.message);
  assert.strictEqual(h.patches().length, 0, 'the row held the flags through the commands phase');
  assert.strictEqual(error.commandStates.rows[0].outcome, 'unchanged');
  assert.deepStrictEqual(error.commandStates.rows[0].changed, []);
  assert.strictEqual(error.commandStates.publication[0].outcome, 'confirmed');
  assert.match(error.message, /it now holds hidden false, disabled false: the flags no longer match, so the row changed during the build, after this build's step for it \(not written by this build \(it already held the declared flags\)\)/);
  assert.doesNotMatch(error.message, /accepted|saved/, 'no write of this build is claimed');
});

test('an unanswered write whose row a competing edit made match, then changed again, fails the final proof without claiming the write', async () => {
  const rows = [commandRow(ROW, T, MD)];
  // The PATCH is answered 503 and never stored; someone else sets the same flag (a new version) before the read that follows it.
  const overrides = (req) => {
    if (req.method !== 'PATCH') return undefined;
    rows[0].hidden = true;
    rows[0]['@odata.etag'] = 'W/"1500"';
    return json(503, { error: { code: '0x80072321', message: 'unavailable' } });
  };
  const h = harness({ rows, overrides, onPublish: () => { rows[0].hidden = false; rows[0]['@odata.etag'] = 'W/"1600"'; } });
  const spec = specFor();
  const { approvals } = await h.approve(spec);
  const { error } = await h.build(spec, { ...APPLY, commandStateApprovals: approvals });
  assert.strictEqual(error && error.code, 'command-state-not-confirmed', error && error.message);
  assert.strictEqual(h.patches().length, 1, 'sent once, never again');
  assert.strictEqual(error.commandStates.rows[0].outcome, 'observed-matching-after-unknown-send', 'the outcome recorded at the write stays');
  assert.strictEqual(error.commandStates.publication[0].outcome, 'confirmed');
  assert.strictEqual(error.commandStatePublicationError, undefined);
  assert.match(error.message, /this build's write got no answer, so its outcome is unknown; a later read found the declared flags, which is not proof this build saved them/);
  assert.doesNotMatch(error.message, /accepted|written by this build/, 'the unanswered write is not claimed as this build\'s');
});
// The build's own entry (build-model-app.js buildModelApp) with its durable journal, for what a halt leaves on disk and says on the console.
async function buildWithJournal(h, spec, approvals) {
  const fs = require('node:fs');
  const path = require('node:path');
  const { buildModelApp } = require('../build-model-app.js');
  const { openJournal } = require('../lib/build-journal.js');
  const { makeTempDir } = require('./helpers/temp-dirs.js');
  const engine = require('../lib/sdk-build.js').runSdkBuild;
  const workspaceDir = makeTempDir('cs-journal-');
  const journal = openJournal(path.join(workspaceDir, 'logs'));
  const said = [];
  const { sdk } = h.mockSdk();
  let caught;
  try {
    await buildModelApp(spec, { apply: true, publish: true, env: ORIGIN, workspaceDir, commandStateApprovals: approvals }, {
      sdk, journal, log: () => {}, warn: (m) => said.push(String(m)), sleep: async () => {},
      runBuild: (s, o) => engine(s, { ...o, commandStateTransport: h.transport }),
    });
  } catch (error) {
    caught = error;
  }
  return { caught, said: said.join('\n'), log: fs.readFileSync(journal.path, 'utf8'), status: fs.readFileSync(journal.statusPath, 'utf8') };
}

test('an approval halt keeps the exact tokens out of the build journal and says them on the console: missing and stale', async () => {
  const cases = [
    ['missing', () => ({ rows: [commandRow(ROW, T, MD)] }), () => {}, (approvals) => ({ rows: new Set(), tables: new Set() }), 'command-state-approval-required'],
    ['stale at the preflight', () => ({ rows: [commandRow(ROW, T, MD)] }), (rows) => { rows[0]['@odata.etag'] = 'W/"1002"'; }, (approvals) => approvals, 'command-state-approval-stale'],
  ];
  for (const [what, setup, change, given, code] of cases) {
    const options = setup();
    const h = harness(options);
    const spec = specFor();
    const { approvals } = await h.approve(spec);
    change(options.rows);
    const fresh = await h.approve(spec);
    const tokens = [...fresh.approvals.rows, ...fresh.approvals.tables, ...approvals.rows];
    const out = await buildWithJournal(h, spec, given(approvals));
    assert.strictEqual(out.caught && out.caught.code, code, what);
    assert.deepStrictEqual(h.org.writes(), [], `${what}: nothing written`);
    for (const token of tokens) {
      const digest = token.slice(token.lastIndexOf('/') + 1);
      assert.ok(!out.log.includes(digest), `${what}: no token digest in build-log.jsonl`);
      assert.ok(!out.status.includes(digest), `${what}: no token digest in build-status.json`);
      assert.ok(!out.caught.message.includes(digest), `${what}: nor in the halt's message`);
    }
    assert.match(out.log, new RegExp(code), `${what}: the journal still records the halt and its code`);
    assert.match(out.caught.message, /printed with this halt, and by a dry run/, `${what}: the message says where the tokens are`);
    for (const token of [...fresh.approvals.rows, ...fresh.approvals.tables].filter((tk) => !given(approvals).rows.has(tk) && !given(approvals).tables.has(tk))) {
      assert.ok(out.said.includes(`--authorize ${token}`), `${what}: the console shows ${token}`);
      assert.ok(out.caught.approvalDisplay.includes(`--authorize ${token}`), `${what}: a direct caller reads it on the halt`);
    }
    assert.deepStrictEqual(Object.keys(out.caught).filter((k) => /approval/i.test(k)), [], `${what}: the display is not enumerable`);
  }
});

test('a row that changes between the commands-phase read and its write halts stale with the new token on the console only', async () => {
  const rows = [commandRow(ROW, T, MD)];
  let armed = false;
  let reads = 0;
  // Read at the preflight, again before any write, then once more right before its own write: it changes at that last read.
  const overrides = (req) => {
    if (armed && req.method === 'GET' && req.path.startsWith(`/appactions(${ROW})`) && ++reads === 3) rows[0]['@odata.etag'] = 'W/"1003"';
    return undefined;
  };
  const h = harness({ rows, overrides });
  const spec = specFor();
  const { approvals } = await h.approve(spec);
  armed = true;
  const out = await buildWithJournal(h, spec, approvals);
  assert.strictEqual(out.caught && out.caught.code, 'command-state-approval-stale', out.caught && out.caught.message);
  assert.match(out.caught.message, /the row changed since it was approved; it was not written/);
  assert.deepStrictEqual(h.org.writes(), []);
  const token = out.caught.approvalDisplay.match(/--authorize (\S+)/)[1];
  const digest = token.slice(token.lastIndexOf('/') + 1);
  assert.ok(!out.log.includes(digest) && !out.status.includes(digest) && !out.caught.message.includes(digest), 'the new token is not stored');
  assert.ok(out.said.includes(`--authorize ${token}`), 'and is said on the console');
});
test('with the feature off the journal and the console carry nothing of command states', async () => {
  const h = harness();
  const out = await buildWithJournal(h, specFor(null), undefined);
  assert.ifError(out.caught);
  assert.deepStrictEqual(h.org.requests, []);
  for (const [where, text] of [['build-log.jsonl', out.log], ['build-status.json', out.status], ['the console', out.said]]) {
    assert.doesNotMatch(text, /commandState|command-state|--authorize/, `${where} is unchanged by the feature`);
  }
});