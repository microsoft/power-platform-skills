'use strict';
// Component-level verification (lib/feature-verify.js): declared command controls inspected by the REAL vendored
// SDK's `inspectArtifact('command')` over stored `appaction` rows, and the dashboard creation witness over the
// stateful fake Dataverse the lifecycle tests share. Pinned here: only a row-id `present` passes; a caption is
// discovery; missing, ambiguous, misplaced and indeterminate stay distinct and none of them passes; a disabled
// control or one under a disabled menu fails; a hidden one fails; another app's or another surface's row is not this
// one; an incomplete read is unverified (never a pass, never "missing"); a dashboard that merely exists is not a
// content match; and only GETs are sent.
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeTempDir } = require('./helpers/temp-dirs.js');
const { createLifecycleOrg } = require('./helpers/fake-lifecycle-org.js');
const { createLifecycleHarness } = require('./helpers/lifecycle-harness.js');
const { createAzHttpClient } = require('../lib/sdk-http-client.js');
const { createMakerSdk, createNodeWorkspaceStorage } = require('../lib/maker-sdk.js');
const fv = require('../lib/feature-verify.js');

const { ORIGIN, APP, OTHER_APP, id, barClient, sdkOver, BAR } = require('./helpers/command-bar-org.js');

test('validation: closed keys, canonical GUIDs, known surfaces, a rowId or a label, unique keys', () => {
  const errs = fv.validateCommandTargets([
    { entity: 'contoso_ticket', appModuleId: 'nope', controls: [{ key: 'a', surface: 'grid' }, { key: 'a', surface: 'form', rowId: 'x', label: 'L', colour: 1 }] },
    { entity: '', controls: [] },
  ]);
  const text = errs.join('\n');
  assert.match(text, /appModuleId must be a canonical GUID/);
  assert.match(text, /controls\[0\]\.surface must be one of/);
  assert.match(text, /controls\[0\] needs a rowId \(verification\) or a label \(discovery\)/);
  assert.match(text, /controls\[1\]\.colour is not a recognised field/);
  assert.match(text, /commands\[1\]\.entity must be a table logical name/);
  assert.match(text, /commands\[1\]\.controls must be a non-empty array/);
  assert.match(fv.validateDashboardTargets([{ key: 'd', id: '1' }]).join(), /id must be a canonical GUID/);
});

test('real bundle: every declared control gets its own distinct answer, and only a row-id present passes', async () => {
  const client = barClient(BAR);
  const res = await fv.verifyFeatures(sdkOver(client), {
    commands: [{
      entity: 'contoso_ticket',
      appModuleId: APP,
      controls: [
        { key: 'approve', rowId: id(1), surface: 'homeGrid' },
        { key: 'run-by-id', rowId: id(3), surface: 'homeGrid', label: 'Run' },
        { key: 'run-by-caption', surface: 'homeGrid', label: 'Run' },
        { key: 'approve-by-caption', surface: 'homeGrid', label: 'Approve' },
        { key: 'archive', rowId: id(4), surface: 'homeGrid' },
        { key: 'export', rowId: id(7), surface: 'homeGrid', menuPath: ['More'] },
        { key: 'recalculate', rowId: id(10), surface: 'homeGrid', menuPath: ['Tools'] },
        { key: 'print', rowId: id(11), surface: 'homeGrid' },
        { key: 'assign', rowId: id(12), surface: 'homeGrid' },
        { key: 'secret', rowId: id(13), surface: 'homeGrid' },
        { key: 'lost', rowId: id(99), surface: 'homeGrid' },
      ],
    }],
  });
  assert.deepEqual(client.requests.filter((r) => !r.startsWith('GET')), [], 'GETs only');
  const by = Object.fromEntries(res.checks.map((c) => [c.key, `${c.status}/${c.verdict}/${c.reason}`]));
  assert.deepEqual(by, {
    approve: 'pass/present/PRESENT',
    'run-by-id': 'pass/present/PRESENT', // the row id is the identity, even beside a same-caption twin
    'run-by-caption': 'fail/ambiguous/AMBIGUOUS',
    'approve-by-caption': 'unverified/present/CAPTION_ONLY', // discovery is not verification
    archive: 'fail/misplaced/DISABLED',
    export: 'pass/present/PRESENT',
    recalculate: 'fail/misplaced/ANCESTOR_NOT_SERVED',
    print: 'fail/misplaced/MISPLACED',
    assign: 'fail/misplaced/MISPLACED',
    secret: 'fail/present/HIDDEN',
    lost: 'fail/missing/MISSING',
  });
  assert.equal(res.ok, false);
  assert.deepEqual(res.summary, { pass: 3, fail: 7, unverified: 1 });
  assert.deepEqual(res.tables, [{ entity: 'contoso_ticket', read: 'complete', rowCount: BAR.length }]);
  // The stored facts a live proof records: the row id, its Location and isdisabled.
  const approve = res.checks.find((c) => c.key === 'approve');
  assert.deepEqual([approve.rows[0].rowId, approve.rows[0].location, approve.rows[0].surface, approve.rows[0].disabled], [id(1), 1, 'homeGrid', false]);
  const archive = res.checks.find((c) => c.key === 'archive');
  assert.deepEqual([archive.elsewhere[0].rowId, archive.elsewhere[0].disabled, archive.elsewhere[0].placement], [id(4), true, 'disabled']);
  assert.doesNotMatch(JSON.stringify(res.checks), /Approve|Recalculate/, 'no captions are copied into the checks');
  assert.match(fv.describeFeatureCheck(res.checks.find((c) => c.key === 'recalculate')), /^FAIL command 'recalculate' on contoso_ticket: the menu it sits under is disabled or not served$/);
});

test('real bundle: foreign controls are tolerated — the declared ones alone decide the result', async () => {
  const res = await fv.verifyFeatures(sdkOver(barClient(BAR)), { commands: [{ entity: 'contoso_ticket', controls: [{ key: 'approve', rowId: id(1), surface: 'homeGrid' }, { key: 'export', rowId: id(7), surface: 'homeGrid', menuPath: ['More'] }] }] });
  assert.equal(res.ok, true);
  assert.deepEqual(res.summary, { pass: 2, fail: 0, unverified: 0 });
});

test('real bundle: an incomplete read (a failed second page) leaves every control of the table unverified, never missing or present', async () => {
  const client = barClient(BAR, { pageSize: 5, failSecondPage: true });
  const res = await fv.verifyFeatures(sdkOver(client), { commands: [{ entity: 'contoso_ticket', controls: [{ key: 'approve', rowId: id(1), surface: 'homeGrid' }, { key: 'lost', rowId: id(99), surface: 'homeGrid' }] }] });
  assert.ok(client.requests.some((r) => /skiptoken=2/.test(r)), 'the second page was asked for');
  assert.equal(res.ok, false);
  assert.deepEqual(res.checks.map((c) => `${c.key}:${c.status}:${c.reason}`), ['approve:unverified:INSPECTION_UNREADABLE', 'lost:unverified:INSPECTION_UNREADABLE']);
  assert.deepEqual(res.tables, [{ entity: 'contoso_ticket', read: 'unreadable' }]);
  assert.doesNotMatch(JSON.stringify(res), /contoso\.crm\.dynamics\.com/, 'no URL in a finding');
  // The same bar over two good pages is read to the end and answers.
  const paged = await fv.verifyFeatures(sdkOver(barClient(BAR, { pageSize: 5 })), { commands: [{ entity: 'contoso_ticket', controls: [{ key: 'assign', rowId: id(12), surface: 'homeGrid' }] }] });
  assert.equal(paged.checks[0].verdict, 'misplaced', 'a row on the second page is seen');
});

test('real bundle: a table whose id cannot be read is unverified, not an empty bar', async () => {
  const res = await fv.verifyFeatures(sdkOver(barClient(BAR)), { commands: [{ entity: 'contoso_other', controls: [{ key: 'x', rowId: id(1), surface: 'form' }] }] });
  assert.deepEqual(res.checks.map((c) => [c.status, c.reason]), [['unverified', 'INSPECTION_UNREADABLE']]);
});

test('a refused read is reported by its code and HTTP status: the service\'s own words (which can quote a value) are not passed on', async () => {
  const leak = 'Principal lacks read access to SENTINEL-row SECRET_VALUE_917';
  const inner = barClient(BAR);
  const refusing = { ...inner, get: async (url) => (/EntityDefinitions/.test(String(url)) ? { status: 403, headers: {}, body: { error: { code: '0x80040220', message: leak } } } : inner.get(url)) };
  const res = await fv.verifyFeatures(sdkOver(refusing), { commands: [{ entity: 'contoso_ticket', controls: [{ key: 'approve', rowId: id(1), surface: 'homeGrid' }] }] });
  assert.deepEqual(res.checks.map((c) => [c.status, c.reason]), [['unverified', 'INSPECTION_UNREADABLE']]);
  assert.equal(res.checks[0].statusCode, 403);
  assert.match(res.checks[0].detail, /HTTP 403/);
  assert.doesNotMatch(JSON.stringify(res), /SENTINEL|SECRET_VALUE/);
});

test('invalid targets are refused before any read', async () => {
  let calls = 0;
  const sdk = { inspectArtifact: async () => { calls += 1; } };
  await assert.rejects(fv.verifyFeatures(sdk, { commands: [{ entity: 'contoso_ticket', controls: [{ key: 'a', surface: 'nowhere', rowId: id(1) }] }] }), (e) => e.code === 'FEATURE_VERIFY_INVALID');
  assert.equal(calls, 0);
});

test('dashboard witness mapping: unreadable answers (COMPARISON_NOT_ESTABLISHED, LANGUAGES_UNREADABLE, a thrown refusal) are unverified, never a pass', async () => {
  const answers = {
    [id(1)]: { observation: 'unreadable', reasonCode: 'COMPARISON_NOT_ESTABLISHED' },
    [id(2)]: { observation: 'unreadable', reasonCode: 'LANGUAGES_UNREADABLE' },
    [id(3)]: { observation: 'conflicting', reasonCode: 'KIND' },
  };
  const sdk = {
    inspectArtifact: async (type, did) => {
      if (did === id(4)) throw Object.assign(new Error('expected.components[0] is not an object'), { code: 'INVALID_ARGUMENT' });
      return { type, id: did, observedAt: '2026-01-01T00:00:00Z', ...answers[did] };
    },
  };
  const res = await fv.verifyFeatures(sdk, { dashboards: [1, 2, 3, 4].map((n) => ({ key: `d${n}`, id: id(n), expected: { id: id(n) } })) });
  assert.deepEqual(res.checks.map((c) => `${c.status}:${c.reason}`), ['unverified:COMPARISON_NOT_ESTABLISHED', 'unverified:LANGUAGES_UNREADABLE', 'fail:NOT_A_DASHBOARD', 'unverified:INVALID_ARGUMENT']);
  assert.equal(res.ok, false);
});

test('real bundle: dashboard witness — matching passes, existence alone does not, a different row fails, a missing one fails, a saved-only draft matches in the saved layer', async () => {
  const org = createLifecycleOrg();
  const harness = createLifecycleHarness(org, makeTempDir('feature-verify-app-'));
  const built = await harness.measure(() => harness.build({
    schemaVersion: 2,
    solution: { uniqueName: 'ContosoTickets', displayName: 'Contoso Tickets', publisherPrefix: 'contoso' },
    app: { name: 'Tickets' },
    entities: [{ schemaName: 'contoso_ticket', displayName: 'Ticket', primaryAttribute: { schemaName: 'contoso_name', displayName: 'Name' }, columns: [] }],
    dashboards: [{ name: 'Board', tiles: [{ type: 'iframe', url: 'https://contoso.example/status', name: 'Status' }] }],
    appShell: { areas: [{ label: 'Work', groups: [{ label: 'Tickets', subAreas: [{ entity: 'contoso_ticket', title: 'Tickets' }] }] }] },
  }));
  if (built.error) throw built.error;
  assert.equal(built.value.result.ok, true);
  const client = createAzHttpClient(org.origin, { getToken: () => 'x'.repeat(48), request: org.request, sleep: async () => {} });
  const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(makeTempDir('feature-verify-ws-')), instanceUrl: org.origin, httpClient: client, solutionUniqueName: 'ContosoTickets' });
  await sdk.initWorkspace();
  const board = org.find('systemforms', (f) => Number(f.type) === 0 && f.name === 'Board')[0];
  await sdk.fetchArtifact('dashboard', board.formid);
  const expected = await sdk.getArtifact('dashboard', board.formid);
  // A draft: created and saved, never published.
  const draft = await sdk.createArtifact('dashboard', { name: 'Draft board' });
  await sdk.pushArtifact('dashboard', draft.id);
  const draftExpected = await sdk.getArtifact('dashboard', draft.id);

  const mark = org.requests.length;
  const res = await fv.verifyFeatures(sdk, { dashboards: [
    { key: 'board', id: board.formid, expected },
    { key: 'board-exists', id: board.formid },
    { key: 'board-renamed', id: board.formid, expected: { ...expected, name: 'Another name' } },
    { key: 'gone', id: '00000000-0000-0000-0000-0000000000cd', expected: { ...expected, id: '00000000-0000-0000-0000-0000000000cd' } },
    { key: 'draft', id: draft.id, expected: draftExpected },
  ] });
  assert.deepEqual(org.requests.slice(mark).filter((r) => r.method !== 'GET').map((r) => `${r.method} ${r.path}`), [], 'GETs only');
  assert.deepEqual(res.checks.map((c) => `${c.key}:${c.status}:${c.observation}:${c.reason}`), [
    'board:pass:matching:MATCHING',
    'board-exists:unverified:present:EXISTENCE_ONLY',
    'board-renamed:fail:conflicting:CONTENT_DIFFERS',
    'gone:fail:missing:MISSING',
    'draft:pass:matching:MATCHING',
  ]);
  assert.deepEqual(res.checks[2].differences, ['/name']);
  assert.match(res.basis.dashboard, /saved \(unpublished\).*publication is checked separately/, 'a saved-layer match says nothing about publication');
});
