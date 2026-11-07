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
const { commandRow, json, ORIGIN, APP_ID } = require('./helpers/command-state-org.js');
const { T, MD, ROW, HIDE, APPLY, specFor, harness, buildWithJournal } = require('./helpers/command-state-build-harness.js');

const ROW2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
// A legacy commands[] button and the script it runs.
const LEGACY = (extra = {}) => ({ commands: [{ entity: T, label: 'Go', library: 'new_go.js', function: 'Ns.go', ...extra }], webResources: [{ name: 'new_go.js', type: 'js', content: 'var Ns = {};' }] });

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
    ['cut', () => { throw Object.assign(new Error('socket hang up: planted-service-message W/"498763"'), { code: 'ECONNRESET' }); }],
  ]) {
    const h = harness({ overrides: (req) => (req.method === 'PATCH' ? answer() : undefined) });
    const spec = specFor();
    const { approvals } = await h.approve(spec);
    const { error } = await h.build(spec, { ...APPLY, commandStateApprovals: approvals });
    assert.strictEqual(h.patches().length, 1, `${what}: sent once`);
    assert.strictEqual(error && error.code, 'command-state-write-unknown', what);
    assert.strictEqual(error.retry && error.retry.kind !== undefined ? error.retry.kind : error.retry, require('../lib/retry-policy.js').RETRY.NEVER, `${what}: never retried`);
    // A write with no answer says why by its system code alone, never by the error's own text.
    if (what === 'cut') {
      assert.match(error.message, /\[no usable answer \(ECONNRESET\); check the connection and run it again\]/, error.message);
      assert.ok(!error.message.includes('planted-service-message') && !error.message.includes('498763'), error.message);
    }
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
  assert.match(error.message, /checked again at the end of the build, after its app work; nothing is rolled back \(command state [^)]*: written by this build: the write was accepted and read back holding the declared flags; then the row could not be read and judged at the end of the build \(command-state-context-unverified\)\)/);
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
  assert.match(error.message, /nothing is rolled back \(.*\): .*then a read at the end of the build found hidden false, disabled false, not the declared flags/);
  assert.match(error.message, /: command state [^:]+: written by this build: the write was accepted and read back holding the declared flags; then a read at the end of the build found hidden false, disabled false, not the declared flags — this build did not overwrite that change/);
  assert.match(error.message, /this build did not overwrite that change/);
  assert.strictEqual(h.patches().length, 1);
  assert.strictEqual(error.commandStates.rows[0].outcome, 'acknowledged');
});

test('the final proof reads every declared row: two rows changed after the publication are both read, noted and named, with the first one\'s code', async () => {
  const finalReads = (error) => error.commandStates.rows.map((r) => [r.rowId, r.facts.filter((f) => f.phase === 'final').map((f) => f.result)]);
  for (const [what, change, overrides, reads, code] of [
    ['both changed', (rows) => { rows[0].hidden = false; rows[1].isdisabled = false; }, () => undefined, ['differed', 'differed'], 'command-state-not-confirmed'],
    // The first row changed and the second could not be read: the code is still the first failure's.
    ['one changed, one unreadable', (rows) => { rows[0].hidden = false; }, (req) => (req.method === 'GET' && req.path.startsWith(`/appactions(${ROW2})`) ? json(503, {}) : undefined), ['differed', 'unreadable'], 'command-state-not-confirmed'],
    // The first row could not be read and the second changed: the code is the unreadable row's, as it was when the proof stopped there.
    ['one unreadable, one changed', (rows) => { rows[1].isdisabled = false; }, (req) => (req.method === 'GET' && req.path.startsWith(`/appactions(${ROW})`) ? json(503, {}) : undefined), ['unreadable', 'differed'], 'command-state-row-unreadable'],
  ]) {
    const rows = [commandRow(ROW, T, MD), commandRow(ROW2, T, MD, { location: 1 })];
    let armed = false;
    const h = harness({ rows, overrides: (req) => (armed ? overrides(req) : undefined), onPublish: () => { armed = true; change(rows); } });
    const spec = specFor([HIDE, { entity: T, location: 'HomeTab', scope: 'table', rowId: ROW2, disabled: true }]);
    const { approvals } = await h.approve(spec);
    const { error } = await h.build(spec, { ...APPLY, commandStateApprovals: approvals });
    assert.strictEqual(error && error.code, code, `${what}: ${error && error.message}`);
    assert.strictEqual(error.retry, require('../lib/retry-policy.js').RETRY.NEVER, what);
    assert.deepStrictEqual(finalReads(error), [[ROW, [reads[0]]], [ROW2, [reads[1]]]], `${what}: every row was read once at the end`);
    assert.strictEqual(h.patches().length, 2, `${what}: nothing more was written`);
    assert.deepStrictEqual(error.commandStates.rows.map((r) => r.outcome), ['acknowledged', 'acknowledged'], what);
    // The halt names both rows after the preface, the first failure first.
    const after = error.message.slice(error.message.indexOf('): ') + 3);
    assert.ok(after.indexOf(ROW) >= 0 && after.indexOf(ROW2) > after.indexOf(ROW), `${what}: ${after}`);
    if (reads[0] === 'differed') assert.match(after, /^command state [^:]+: written by this build: [^;]*; then a read at the end of the build found hidden false, disabled false, not the declared flags — this build did not overwrite that change/, what);
  }
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
  assert.match(error.message, /: command state [^:]+: not written by this build \(it already held the declared flags\); then a read at the end of the build found hidden false, disabled false, not the declared flags — /);
  assert.doesNotMatch(error.message, /accept|acknowledg|sav(e|ed|ing)\b|this build's write/i, 'no write of this build is claimed');
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
  assert.match(error.message, /this build's write got no usable answer \(HTTP 503\), so its outcome is unknown; a later read found the declared flags, which is not proof this build saved them; then a read at the end of the build found hidden false/);
  assert.doesNotMatch(error.message.replaceAll('not proof this build saved them', ''), /accept|acknowledg|sav(e|ed|ing)\b|(?<!not )written by this build/i, 'the unanswered write is not claimed as this build\'s');
});

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
// The design keeps ETags, digests, handlers and raw responses out of the feature's halts and journals. A refused read of the app is said by
// its status and Dataverse error code; the service's own message, which here carries a row version, is in neither the halt nor the journal.
test('a refused context read is said by its HTTP status and Dataverse code: the service\'s text and a version stay out of the halt and the journal', async () => {
  const SERVICE = 'planted-service-message W/"498763"';
  const refusal = () => json(403, { error: { code: '0x80040220', message: SERVICE } });
  for (const [what, arm, sent] of [
    // At the start of the build, before anything is sent.
    ['preflight', (h) => { h.armed = true; }, 0],
    // At the end of the build, after the row was written, acknowledged and read back and its table published.
    ['final', (h) => { h.armOnPublish = true; }, 1],
  ]) {
    const options = { rows: [commandRow(ROW, T, MD)] };
    const h = harness({
      ...options,
      onPublish: () => { if (h.armOnPublish) h.armed = true; },
      overrides: (req) => (h.armed && req.method === 'GET' && req.path.startsWith('/appmodules?') ? refusal() : undefined),
    });
    const spec = specFor();
    const { approvals } = await h.approve(spec);
    arm(h);
    const out = await buildWithJournal(h, spec, approvals);
    assert.strictEqual(out.caught && out.caught.code, 'command-state-context-unverified', `${what}: ${out.caught && out.caught.message}`);
    assert.strictEqual(h.patches().length, sent, `${what}: PATCHes sent`);
    if (sent) assert.match(out.caught.message, /written by this build: the write was accepted and read back holding the declared flags/, what);
    assert.match(out.caught.message, /app 'contoso_Support': HTTP 403, Dataverse error 0x80040220; check that the signed-in account can read it/, what);
    for (const [where, text] of [['the halt', out.caught.message], ['build-log.jsonl', out.log], ['build-status.json', out.status], ['the console', out.said]]) {
      assert.ok(!text.includes('planted-service-message') && !text.includes('498763'), `${what}: ${where} holds no service text or version`);
    }
    assert.match(out.log, /command-state-context-unverified/, `${what}: the journal keeps the code`);
  }
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
// One history, one story: for each way a row ends unconfirmed in the commands phase, the halt the build stops with, the outcome it records
// and the line the CLI prints (build-model-app.js, through ROW_MESSAGES) say the same thing — whether this build wrote, what the earlier
// read showed, and what the last read found. The row changes at an exact read of it (armed after the dry run):
// read 1 is the preflight, 2 the commands-phase recheck, 3 the read right before its own write, then 4 the read after that write, and the
// read after every row's step is 4 for a row with nothing to write and 5 for one written.
test('the halt, the recorded outcome and the printed line agree on what happened to a row that ends unconfirmed', async () => {
  const { buildModelApp } = require('../build-model-app.js');
  const { makeTempDir } = require('./helpers/temp-dirs.js');
  const UNCHANGED = 'not written by this build (it already held the declared flags)';
  const ACKNOWLEDGED = 'written by this build: the write was accepted and read back holding the declared flags';
  const OBSERVED = 'this build\'s write got no usable answer (HTTP 503), so its outcome is unknown; a later read found the declared flags, which is not proof this build saved them';
  const DRIFT = 'then a read after every row\'s step found hidden false, disabled false, not the declared flags';
  const LOST = 'this build\'s write got no usable answer (HTTP 503), so its outcome is unknown; then a read after its write found hidden false, disabled false, not the declared flags';
  const cases = [
    { what: 'unchanged, then changed', hidden: true, loseAt: 4, patches: 0, code: 'command-state-not-confirmed', outcome: 'drifted', before: 'unchanged', history: `${UNCHANGED}; ${DRIFT}` },
    { what: 'written and read back, then changed', hidden: false, loseAt: 5, patches: 1, code: 'command-state-not-confirmed', outcome: 'drifted', before: 'acknowledged', history: `${ACKNOWLEDGED}; ${DRIFT}` },
    { what: 'unanswered, matched by someone else, then changed', hidden: false, loseAt: 5, competing: true, patches: 1, code: 'command-state-not-confirmed', outcome: 'drifted', before: 'observed-matching-after-unknown-send', history: `${OBSERVED}; ${DRIFT}` },
    { what: 'unanswered, and never seen holding the flags', hidden: false, lost: true, patches: 1, code: 'command-state-write-unknown', outcome: 'unknown', history: LOST },
  ];
  for (const c of cases) {
    const rows = [commandRow(ROW, T, MD, { hidden: c.hidden })];
    let armed = false;
    let reads = 0;
    const seen = [];
    const overrides = (req) => {
      if (!armed) return undefined;
      if (req.method === 'PATCH' && (c.competing || c.lost)) {
        // Answered 503 and never stored; for `competing`, someone else sets the same flag at a new version first.
        if (c.competing) { rows[0].hidden = true; rows[0]['@odata.etag'] = 'W/"1500"'; }
        return json(503, { error: { code: '0x80072321', message: 'unavailable' } });
      }
      if (req.method === 'GET' && req.path.startsWith(`/appactions(${ROW})`)) {
        if (++reads === c.loseAt) { rows[0].hidden = false; rows[0]['@odata.etag'] = 'W/"1600"'; }
        seen.push(rows[0].hidden);
      }
      return undefined;
    };
    const h = harness({ rows, overrides });
    const spec = specFor();
    const { approvals } = await h.approve(spec);
    armed = true;
    const lines = [];
    let halt;
    try {
      const { sdk } = h.mockSdk();
      await buildModelApp(spec, { apply: true, publish: true, env: ORIGIN, workspaceDir: makeTempDir('cs-agree-'), commandStateApprovals: approvals }, {
        sdk, log: (m) => lines.push(String(m)), warn: (m) => lines.push(String(m)), sleep: async () => {},
        runBuild: (s, o) => runSdkBuild(s, { ...o, commandStateTransport: h.transport }),
      });
    } catch (error) {
      halt = error;
    }
    assert.strictEqual(halt && halt.code, c.code, `${c.what}: ${halt && halt.message}`);
    assert.strictEqual(h.patches().length, c.patches, `${c.what}: PATCHes sent`);
    const row = halt.commandStates.rows[0];
    assert.deepStrictEqual([row.outcome, row.before], [c.outcome, c.before], `${c.what}: the recorded outcome keeps the history`);
    const line = lines.find((l) => l.startsWith(`  command state ${T}/MainTab/${ROW}: `));
    assert.ok(line, `${c.what}: the CLI printed the row`);
    assert.ok(line.startsWith(`  command state ${T}/MainTab/${ROW}: ${c.outcome}${c.before ? ` after ${c.before}` : ''}`), `${c.what}: ${line}`);
    assert.ok(line.endsWith(` — ${c.history}`), `${c.what}: the line says the history: ${line}`);
    // The halt says the same history, from the same facts, then its remedy.
    assert.ok(halt.message.includes(`: ${c.history} — `) || halt.message.includes(`: ${c.history}; the row is still at the version`), `${c.what}: ${halt.message}`);
    if (c.before) {
      assert.ok(seen.includes(true), `${c.what}: an exact read did hold the declared flags`);
    } else {
      assert.ok(!seen.includes(true), `${c.what}: no read held the declared flags`);
    }
    for (const text of [halt.message, line]) {
      if (c.before !== 'acknowledged') assert.doesNotMatch(text.replace('not proof this build saved them', ''), /accept|acknowledg|sav(e|ed|ing)\b|(?<!not )written by this build/i, `${c.what}: ${text}`);
      if (c.before === 'unchanged') assert.doesNotMatch(text, /this build's write|this build sent|the write of/i, `${c.what}: no write invented: ${text}`);
      if (c.before) assert.doesNotMatch(text, /no read (after it )?showed/, `${c.what}: the matching read is not denied: ${text}`);
    }
  }
});
// One apply through the build's own entry (buildModelApp), counting its attempts. `retry` fails the app's create once with a 503 after the
// row step, so the build runs a second attempt; `atRetry` runs at that moment (before the second attempt reads anything).
async function throughBuild({ hidden = false, overrides, retry = false, atRetry, onPublish } = {}) {
  const { buildModelApp } = require('../build-model-app.js');
  const { makeTempDir } = require('./helpers/temp-dirs.js');
  const rows = [commandRow(ROW, T, MD, { hidden })];
  let armed = false;
  const h = harness({ rows, overrides: (req) => (armed && overrides ? overrides(req, rows) : undefined), onPublish: (tables) => { if (onPublish) onPublish(rows, tables); } });
  const spec = specFor();
  const { approvals } = await h.approve(spec);
  armed = true;
  const { sdk } = h.mockSdk();
  if (retry) {
    const create = sdk.createArtifact;
    let failed = false;
    sdk.createArtifact = (...args) => {
      if (args[0] === 'app' && !failed) {
        failed = true;
        if (atRetry) atRetry(rows);
        throw Object.assign(new Error('injected service failure'), { statusCode: 503 });
      }
      return create(...args);
    };
  }
  const lines = [];
  let attempts = 0;
  let result;
  let halt;
  try {
    result = await buildModelApp(spec, { apply: true, publish: true, env: ORIGIN, workspaceDir: makeTempDir('cs-facts-'), commandStateApprovals: approvals }, {
      sdk, log: (m) => lines.push(String(m)), warn: (m) => lines.push(String(m)), sleep: async () => {},
      runBuild: (s, o) => { attempts += 1; return runSdkBuild(s, { ...o, commandStateTransport: h.transport }); },
    });
  } catch (error) {
    halt = error;
  }
  const states = (halt || result).commandStates;
  const line = lines.find((l) => l.startsWith(`  command state ${T}/MainTab/${ROW}: `));
  return { h, halt, result, row: states.rows[0], states, line, lines, attempts, rows };
}
const NO_CLAIM = /accept|acknowledg|\bsav(e|es|ed|ing)\b|(?<!not )written by this build/i;
const unproven = (text) => text.replaceAll('not proof this build saved them', '');

test('a read after every row\'s step that cannot be judged is said as unreadable: never as flags the row does not hold', async () => {
  let reads = 0;
  // Reads in the apply: preflight, recheck, own step, read back after the write, then the read after every row's step (the fifth).
  const out = await throughBuild({
    overrides: (req) => {
      if (req.method === 'GET' && req.path.startsWith(`/appactions(${ROW})`) && ++reads === 5) return json(403, { error: { code: '0x80040220', message: 'denied' } });
      return undefined;
    },
  });
  assert.strictEqual(out.halt && out.halt.code, 'command-state-not-confirmed', out.halt && out.halt.message);
  assert.strictEqual(out.h.patches().length, 1);
  assert.match(out.halt.message, /; then the row could not be read and judged after every row's step \(command-state-[a-z-]+\)/);
  const publication = out.halt.commandStatePublicationError;
  assert.ok(publication, 'the table is reported unpublished');
  assert.match(publication.message, /could not be read at its last read/);
  for (const text of [out.halt.message, out.line, publication.message]) {
    assert.doesNotMatch(text, /did not hold|does not hold|other flags|found hidden/, text);
  }
});

test('a retry of the build keeps the write its earlier attempt sent: never "not written by this build", never sent again', async () => {
  const cases = [
    { what: 'the row still holds the flags', ok: true, outcome: 'acknowledged' },
    {
      what: 'the row changes before the final proof', code: 'command-state-not-confirmed', outcome: 'acknowledged',
      // The table is published in each attempt; the change comes with the second attempt's publication, after its reads.
      onPublish: ((n) => (rows) => { if (++n === 2) { rows[0].hidden = false; rows[0]['@odata.etag'] = 'W/"2002"'; } })(0),
      said: /then a read at the end of the build found hidden false, disabled false, not the declared flags \(attempt 2\)/,
    },
    {
      what: 'the row changes before the second attempt reads it', code: 'command-state-approval-stale',
      atRetry: (rows) => { rows[0].hidden = false; rows[0]['@odata.etag'] = 'W/"2003"'; },
      said: /an earlier attempt of this build already sent a write: command state new_ticket\/MainTab\/[0-9a-f-]+: written by this build: the write was accepted and read back holding the declared flags \(attempt 1\)/,
    },
  ];
  for (const c of cases) {
    const out = await throughBuild({ retry: true, atRetry: c.atRetry, onPublish: c.onPublish });
    assert.strictEqual(out.attempts, 2, c.what);
    assert.strictEqual(out.h.patches().length, 1, `${c.what}: one PATCH, in the first attempt`);
    if (c.ok) assert.ifError(out.halt);
    else assert.strictEqual(out.halt && out.halt.code, c.code, `${c.what}: ${out.halt && out.halt.message}`);
    if (c.outcome) assert.strictEqual(out.row.outcome === 'drifted' ? out.row.before : out.row.outcome, c.outcome, c.what);
    assert.ok(out.line, `${c.what}: the CLI printed the row`);
    for (const text of [out.line, ...(out.halt ? [out.halt.message] : [])]) {
      assert.doesNotMatch(text, /not written by this build/, `${c.what}: ${text}`);
      assert.match(text, /written by this build: the write was accepted and read back holding the declared flags \(attempt 1\)/, `${c.what}: ${text}`);
    }
    if (c.said) assert.match(out.halt.message, c.said, c.what);
    // A row's facts carry what was read and sent, never a version, a token or the service's text.
    const facts = JSON.stringify(out.row.facts);
    assert.ok(out.row.facts.length > 0, c.what);
    assert.doesNotMatch(facts, /W\/"|etag|version|token|approval|message/i, c.what);
  }
});