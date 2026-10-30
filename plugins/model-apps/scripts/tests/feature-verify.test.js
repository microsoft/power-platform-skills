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

const ORIGIN = 'https://contoso.crm.dynamics.com';
const TABLE_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const APP = 'aaaaaaaa-0000-4000-8000-00000000000a';
const OTHER_APP = 'bbbbbbbb-0000-4000-8000-00000000000b';
const id = (n) => `5a5a5a5a-0000-4000-8000-${String(n).padStart(12, '0')}`;

// One stored appaction row, as the Web API answers it (lookups as GUID strings or null, flags as booleans):
//   { appactionid, name: 'Run!<32 hex>', type: 0 button | 1 flyout | 2 split | 3 group, location: 0 form | 1 homeGrid
//     | 2 subGrid | 3 associatedGrid, buttonlabeltext, _parentappactionid_value, _appmoduleid_value, isdisabled, hidden }
function row(n, { label = `Control ${n}`, type = 0, location = 1, parent = null, app = null, disabled = false, hidden = false, sequence = n } = {}) {
  return {
    appactionid: id(n),
    name: `${label.replace(/\W/g, '')}!${id(n).replace(/-/g, '')}`,
    uniquename: '',
    type,
    location,
    context: 1,
    contextvalue: 'contoso_ticket',
    buttonlabeltext: type === 3 ? null : label,
    grouptitle: type === 3 ? '' : null,
    sequence,
    _contextentity_value: TABLE_ID,
    _parentappactionid_value: parent ? id(parent) : null,
    _appmoduleid_value: app,
    isdisabled: disabled,
    hidden,
    ismanaged: false,
    statecode: 0,
    statuscode: 1,
  };
}

// A GET-only stand-in for the environment: the table's MetadataId and its appaction rows, optionally over two pages
// with the second one failing (an incomplete read). Any other verb is recorded and refused.
function barClient(rows, { pageSize = 0, failSecondPage = false } = {}) {
  const requests = [];
  const ok = (body) => ({ status: 200, headers: {}, body });
  const client = {
    requests,
    get: async (url) => {
      const u = String(url);
      requests.push(`GET ${u.replace(ORIGIN, '')}`);
      if (/EntityDefinitions\(LogicalName='contoso_ticket'\)/.test(u)) return ok({ MetadataId: TABLE_ID });
      if (/EntityDefinitions/.test(u)) return { status: 404, headers: {}, body: { error: { code: '0x80060888', message: 'Could not find entity' } } };
      if (/\/appactions/.test(u)) {
        if (/skiptoken=2/.test(u)) {
          if (failSecondPage) return { status: 503, headers: {}, body: { error: { code: '0x80040216', message: 'unavailable' } } };
          return ok({ value: rows.slice(pageSize) });
        }
        if (pageSize && rows.length > pageSize) return ok({ value: rows.slice(0, pageSize), '@odata.nextLink': `${ORIGIN}/api/data/v9.2/appactions?$skiptoken=2` });
        return ok({ value: rows });
      }
      return ok({ value: [] });
    },
  };
  for (const m of ['post', 'patch', 'delete', 'put']) client[m] = async (url) => { requests.push(`${m.toUpperCase()} ${url}`); throw new Error('a write was attempted'); };
  return client;
}

function sdkOver(httpClient) {
  return createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(makeTempDir('feature-verify-')), instanceUrl: ORIGIN, httpClient });
}

const BAR = [
  row(1, { label: 'Approve' }), // a top-level button on the main grid, every app
  row(2, { label: 'Run' }), // two served buttons with the same caption
  row(3, { label: 'Run' }),
  row(4, { label: 'Archive', disabled: true }), // stored disabled
  row(5, { label: 'More', type: 1 }), // flyout -> group -> button: a served menu
  row(6, { type: 3, parent: 5 }),
  row(7, { label: 'Export', parent: 6 }),
  row(8, { label: 'Tools', type: 1, disabled: true }), // a disabled flyout: its children are served nowhere
  row(9, { type: 3, parent: 8 }),
  row(10, { label: 'Recalculate', parent: 9 }),
  row(11, { label: 'Print', location: 0 }), // on the form, not the grid
  row(12, { label: 'Assign', app: OTHER_APP }), // another app's
  row(13, { label: 'Secret', hidden: true }),
  row(14, { label: 'Foreign button' }), // a row nobody declared
];

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
