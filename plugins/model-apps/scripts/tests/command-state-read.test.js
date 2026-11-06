'use strict';
// lib/command-state-read.js and lib/command-state-transport.js: the strict reading of a modern command row (every column of its kind, a
// missing column never a null, a null never a false), the app/table context it is judged against, the listing of every row of a table over
// every page, and the read-only transport's allowlist. Driven through the plugin's real raw client (`createAzHttpClient`) over a fake
// Dataverse that answers in the platform's shapes (helpers/command-state-org.js), so the requests counted are the ones that reach the wire.
const test = require('node:test');
const assert = require('node:assert');
const { createAzHttpClient } = require('../lib/sdk-http-client.js');
const { createCommandStateTransport } = require('../lib/command-state-transport.js');
const { resolveCommandStateContext, readCommandStateRow, decodeCommandStateRow, listCommandStateRows, verifyCommandStates } = require('../lib/command-state-read.js');
const { REASONS, codeForReasons, canonicalRowId, ROW_SELECT } = require('../lib/command-state-contract.js');
const { createCommandStateOrg, commandRow, json, ORIGIN, APP_ID, OTHER_APP_ID, SELECT_ALL } = require('./helpers/command-state-org.js');

const API = `${ORIGIN}/api/data/v9.0`;
const TICKET = 'aaaaaaaa-0000-4000-8000-000000000001';
const ORDER = 'aaaaaaaa-0000-4000-8000-000000000002';
const NOTE = 'aaaaaaaa-0000-4000-8000-000000000003';
const TABLES = { contoso_ticket: { metadataId: TICKET }, contoso_order: { metadataId: ORDER }, contoso_note: { metadataId: NOTE, inApp: false } };
const id = (n) => `bbbbbbbb-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ticketRow = (n, extra) => commandRow(id(n), 'contoso_ticket', TICKET, extra);

function readerFor(org) {
  const client = createAzHttpClient(ORIGIN, { getToken: () => 'test-token', request: org.request, sleep: async () => {} });
  return createCommandStateTransport({ client, apiUrl: (path) => `${API}${path}` });
}
const expectTicket = { entity: 'contoso_ticket', metadataId: TICKET, appId: APP_ID, inApp: true, optimisticConcurrency: true };

// --- the decoder ------------------------------------------------------------------------------------------------

test('the columns read are exactly the ones the decoder requires', () => {
  assert.deepStrictEqual([...ROW_SELECT], SELECT_ALL);
});

test('an ordinary top-level, active, unmanaged, table-scoped button is a candidate, read as it is stored', () => {
  const decoded = decodeCommandStateRow(ticketRow(1, { hidden: true }), { ...expectTicket, rowId: id(1), location: 0, scope: 'table', requireVersion: true });
  assert.deepStrictEqual({ eligible: decoded.eligible, reasons: decoded.reasons, details: decoded.details }, { eligible: true, reasons: [], details: [] });
  assert.strictEqual(decoded.row.hidden, true);
  assert.strictEqual(decoded.row.disabled, false);
  assert.strictEqual(decoded.row.scope, 'table');
  assert.strictEqual(decoded.row.bar, 'MainTab');
  assert.strictEqual(decoded.row.version, 'W/"1001"');
});

test('only a table-scoped button is a candidate: an app-scoped one, this app\u2019s own included, is refused for its scope', () => {
  for (const [owner, scope] of [[APP_ID, 'app'], [`{${APP_ID.toUpperCase()}}`, 'app'], [OTHER_APP_ID, 'other-app']]) {
    const decoded = decodeCommandStateRow(ticketRow(1, { _appmoduleid_value: owner }), expectTicket);
    assert.deepStrictEqual([decoded.row.scope, decoded.reasons, decoded.eligible], [scope, ['app-scoped'], false], owner);
    assert.strictEqual(codeForReasons(decoded.reasons), 'command-state-app-scope-unverified', owner);
  }
  assert.strictEqual(codeForReasons(['app-scoped', 'location-mismatch', 'managed']), 'command-state-app-scope-unverified', 'scope is refused before a mismatch');
  assert.strictEqual(codeForReasons(['app-scoped', 'shape-unreadable']), 'command-state-row-unreadable', 'an unreadable row is unreadable first');
  assert.deepStrictEqual(decodeCommandStateRow(ticketRow(1), expectTicket).row.scope, 'table');
  assert.ok(decodeCommandStateRow(ticketRow(1, { _appmoduleid_value: 'app' }), expectTicket).reasons.includes('shape-unreadable'), 'a malformed lookup is unreadable');
});

test('static visibility is a PRESENT null or 0 with every formula column present and empty; anything else is not static', () => {
  // The shape the platform answered for a button a plain commands[] build wrote: visibilitytype null, every formula column null.
  const measured = {
    '@odata.etag': 'W/"5550101"', appactionid: id(1), name: 'n', uniquename: 'u', buttonlabeltext: 'Escalate', context: 1, contextvalue: 'contoso_ticket',
    _contextentity_value: TICKET, _appmoduleid_value: null, location: 0, type: 0, origin: 0, statecode: 0, statuscode: 1, ismanaged: false,
    iscustomizable: { Value: true, CanBeChanged: true, ManagedPropertyLogicalName: 'iscustomizableanddeletable' }, _parentappactionid_value: null,
    hidden: false, isdisabled: false, visibilitytype: null, visibilityformulacomponentlibrary: null, _visibilityformulacomponentlibraryid_value: null,
    visibilityformulacomponentname: null, visibilityformulafunctionname: null, onclickeventtype: 2,
  };
  const decoded = decodeCommandStateRow(measured, { ...expectTicket, rowId: id(1), location: 0, requireVersion: true });
  assert.deepStrictEqual([decoded.eligible, decoded.reasons, decoded.details, decoded.row.visibilityType], [true, [], [], null]);
  const empty = { visibilityformulacomponentlibrary: '', _visibilityformulacomponentlibraryid_value: '', visibilityformulacomponentname: '', visibilityformulafunctionname: '' };
  for (const visibilitytype of [null, 0]) {
    assert.deepStrictEqual(decodeCommandStateRow({ ...measured, visibilitytype }, expectTicket).reasons, [], `${visibilitytype}`);
    assert.deepStrictEqual(decodeCommandStateRow({ ...measured, visibilitytype, ...empty }, expectTicket).reasons, [], `${visibilitytype}, empty formula text`);
    for (const [key, value] of [['visibilityformulacomponentlibrary', 'contoso_lib'], ['_visibilityformulacomponentlibraryid_value', id(8)],
      ['visibilityformulacomponentname', 'Screen1'], ['visibilityformulafunctionname', 'IsVisible']]) {
      assert.deepStrictEqual(decodeCommandStateRow({ ...measured, visibilitytype, [key]: value }, expectTicket).reasons, ['visibility-formula'], `${visibilitytype} with ${key}`);
      const missing = { ...measured, visibilitytype };
      delete missing[key];
      assert.ok(decodeCommandStateRow(missing, expectTicket).reasons.includes('shape-unreadable'), `${visibilitytype} without ${key}`);
    }
  }
  for (const visibilitytype of [1, 2, -1, 3]) {
    assert.deepStrictEqual(decodeCommandStateRow({ ...measured, visibilitytype }, expectTicket).reasons, ['visibility-formula'], `${visibilitytype}`);
  }
  for (const visibilitytype of ['0', '', false, 0.5, {}]) {
    assert.ok(decodeCommandStateRow({ ...measured, visibilitytype }, expectTicket).reasons.includes('shape-unreadable'), JSON.stringify(visibilitytype));
  }
  const missingType = { ...measured };
  delete missingType.visibilitytype;
  const decodedMissing = decodeCommandStateRow(missingType, expectTicket);
  assert.ok(decodedMissing.reasons.includes('shape-unreadable') && decodedMissing.details.includes('visibilitytype is missing'), 'a missing visibilitytype is no null');
});

test('every excluded shape is named by its own reason, and the refusal it stands for', () => {
  const cases = [
    [{ context: 0 }, ['context-not-table'], 'command-state-target-mismatch'],
    [{ contextvalue: 'contoso_order' }, ['context-mismatch'], 'command-state-target-mismatch'],
    [{ _contextentity_value: ORDER }, ['context-mismatch'], 'command-state-target-mismatch'],
    [{ location: 3 }, ['location-unsupported'], 'command-state-target-mismatch'],
    [{ location: 6 }, ['location-unsupported'], 'command-state-target-mismatch'],
    [{ type: 1 }, ['not-standard-button'], 'command-state-target-unsupported'],
    [{ type: 3 }, ['not-standard-button'], 'command-state-target-unsupported'],
    [{ _parentappactionid_value: id(9) }, ['nested'], 'command-state-target-unsupported'],
    [{ origin: 1 }, ['not-default-origin'], 'command-state-target-unsupported'],
    [{ origin: 2 }, ['not-default-origin'], 'command-state-target-unsupported'],
    [{ statecode: 1, statuscode: 2 }, ['inactive'], 'command-state-target-unsupported'],
    [{ statecode: 0, statuscode: 2 }, ['inactive'], 'command-state-target-unsupported'],
    [{ ismanaged: true }, ['managed'], 'command-state-target-unsupported'],
    [{ iscustomizable: { Value: false, CanBeChanged: true } }, ['not-customizable'], 'command-state-target-unsupported'],
    [{ visibilitytype: 1 }, ['visibility-formula'], 'command-state-target-unsupported'],
    [{ visibilitytype: 2 }, ['visibility-formula'], 'command-state-target-unsupported'],
    [{ visibilityformulafunctionname: 'IsVisible' }, ['visibility-formula'], 'command-state-target-unsupported'],
    [{ _visibilityformulacomponentlibraryid_value: id(8) }, ['visibility-formula'], 'command-state-target-unsupported'],
    [{ onclickeventtype: 1 }, ['formula-action'], 'command-state-target-unsupported'],
    [{ '@odata.etag': undefined }, ['version-unavailable'], 'command-state-version-unavailable'],
    [{ '@odata.etag': '"1001"' }, ['version-unavailable'], 'command-state-version-unavailable'],
    [{ '@odata.etag': 'W/"*"' }, ['version-unavailable'], 'command-state-version-unavailable'],
  ];
  for (const [extra, reasons, code] of cases) {
    const row = ticketRow(1, extra);
    for (const [k, v] of Object.entries(extra)) if (v === undefined) delete row[k];
    const decoded = decodeCommandStateRow(row, { ...expectTicket, requireVersion: true });
    assert.deepStrictEqual(decoded.reasons, reasons, JSON.stringify(extra));
    assert.strictEqual(codeForReasons(decoded.reasons), code, JSON.stringify(extra));
    assert.strictEqual(decoded.eligible, false);
  }
  // A JavaScript button and a button with no action are both plain buttons.
  assert.deepStrictEqual(decodeCommandStateRow(ticketRow(1, { onclickeventtype: 0 }), expectTicket).reasons, []);
  // A row asked for by id that answers as another.
  assert.deepStrictEqual(decodeCommandStateRow(ticketRow(2), { ...expectTicket, rowId: id(1) }).reasons, ['id-mismatch']);
  // A declared bar that differs from the stored one.
  assert.deepStrictEqual(decodeCommandStateRow(ticketRow(1, { location: 1 }), { ...expectTicket, location: 0 }).reasons, ['location-mismatch']);
  // Optimistic concurrency off for the table of commands: no row is a candidate, whatever its version.
  assert.deepStrictEqual(decodeCommandStateRow(ticketRow(1), { ...expectTicket, optimisticConcurrency: false }).reasons, ['version-unavailable']);
  // A table that is not one of the app's.
  assert.deepStrictEqual(decodeCommandStateRow(ticketRow(1), { ...expectTicket, inApp: false }).reasons, ['table-not-in-app']);
  assert.strictEqual(codeForReasons(['table-not-in-app', 'managed']), 'command-state-context-unverified');
});

test('a missing column is not a null, a null is not a false, and a number spelled as text is not a number', () => {
  for (const key of ROW_SELECT) {
    const row = ticketRow(1);
    delete row[key];
    const decoded = decodeCommandStateRow(row, expectTicket);
    assert.ok(decoded.reasons.includes('shape-unreadable'), `missing ${key}`);
    assert.ok(decoded.details.includes(`${key} is missing`), `missing ${key}`);
    assert.strictEqual(decoded.eligible, false);
    assert.strictEqual(codeForReasons(decoded.reasons), 'command-state-row-unreadable', key);
  }
  for (const key of ['hidden', 'isdisabled']) {
    for (const value of [null, 0, 'false', 1]) {
      const decoded = decodeCommandStateRow(ticketRow(1, { [key]: value }), expectTicket);
      assert.deepStrictEqual(decoded.reasons, ['flags-unreadable'], `${key}=${JSON.stringify(value)}`);
      assert.strictEqual(decoded.row[key === 'hidden' ? 'hidden' : 'disabled'], null);
    }
  }
  for (const key of ['context', 'location', 'type', 'origin', 'statecode', 'statuscode', 'visibilitytype', 'onclickeventtype']) {
    // A present null is the one shape visibilitytype may have that the others may not (static visibility, tested on its own).
    for (const value of key === 'visibilitytype' ? ['0', 0.5, true] : [null, '0', 0.5, true]) {
      const decoded = decodeCommandStateRow(ticketRow(1, { [key]: value }), expectTicket);
      assert.ok(decoded.reasons.includes('shape-unreadable'), `${key}=${JSON.stringify(value)}`);
      assert.ok(decoded.details.includes(`${key} is not a whole number`), `${key}=${JSON.stringify(value)}`);
    }
  }
  for (const value of [null, 'false', { CanBeChanged: true }, { Value: 'true' }]) {
    assert.ok(decodeCommandStateRow(ticketRow(1, { iscustomizable: value }), expectTicket).reasons.includes('shape-unreadable'), JSON.stringify(value));
  }
  // CanBeChanged is not what a managed property IS.
  assert.deepStrictEqual(decodeCommandStateRow(ticketRow(1, { iscustomizable: { Value: false, CanBeChanged: true } }), expectTicket).reasons, ['not-customizable']);
  assert.ok(decodeCommandStateRow(ticketRow(1, { ismanaged: null }), expectTicket).reasons.includes('shape-unreadable'));
  assert.ok(decodeCommandStateRow(ticketRow(1, { onclickeventtype: 7 }), expectTicket).reasons.includes('shape-unreadable'));
  assert.ok(decodeCommandStateRow(ticketRow(1, { _appmoduleid_value: 'app' }), expectTicket).reasons.includes('shape-unreadable'));
  // An unlabelled button is unlabelled, not named after something else.
  const unlabelled = decodeCommandStateRow(ticketRow(1, { buttonlabeltext: null }), expectTicket);
  assert.deepStrictEqual([unlabelled.row.caption, unlabelled.reasons], [null, []]);
  // The details name columns, never a value the platform sent.
  const odd = decodeCommandStateRow(ticketRow(1, { location: 'secret-value', hidden: 'secret-value' }), expectTicket);
  assert.ok(!JSON.stringify(odd.details).includes('secret-value'));
  assert.throws(() => decodeCommandStateRow(null, expectTicket), { code: 'command-state-row-unreadable' });
});

test('the reasons are a closed vocabulary and every one maps to a refusal', () => {
  for (const reason of REASONS) assert.ok(codeForReasons([reason]), reason);
  assert.strictEqual(codeForReasons([]), null);
  assert.strictEqual(codeForReasons(['managed', 'shape-unreadable']), 'command-state-row-unreadable', 'unreadable outranks unsupported');
});

test('a row id is lower case, hyphenated, without braces and not all zeros', () => {
  assert.strictEqual(canonicalRowId(id(1)), id(1));
  for (const bad of [id(1).toUpperCase(), `{${id(1)}}`, id(1).replace(/-/g, ''), '00000000-0000-0000-0000-000000000000', '', null, 42]) {
    assert.strictEqual(canonicalRowId(bad), null, String(bad));
  }
});

// --- one row by id ------------------------------------------------------------------------------------------------

test('a row is read by its id with every column, and only the platform\u2019s "does not exist" proves it is gone', async () => {
  const org = createCommandStateOrg({ tables: TABLES, rows: [ticketRow(1)] });
  const reader = readerFor(org);
  const found = await readCommandStateRow(reader, id(1));
  assert.strictEqual(found.found, true);
  assert.strictEqual(found.body['@odata.etag'], 'W/"1001"');
  assert.deepStrictEqual(org.requests.map((r) => `${r.method} ${r.path}`), [`GET /appactions(${id(1)})?$select=${SELECT_ALL.join(',')}`]);
  assert.strictEqual(org.requests[0].url.startsWith(`${API}/appactions(`), true);
  assert.deepStrictEqual(await readCommandStateRow(reader, id(2)), { found: false });

  for (const answer of [json(404, { error: { code: '0x80060888', message: 'resource not found' } }), json(404, {}), json(403, { error: { code: '0x80040220' } }),
    json(401, { error: { code: '0x8004a106' } }), json(200, []), { statusCode: 200, headers: {}, body: '<html>sign in</html>' }]) {
    const odd = createCommandStateOrg({ overrides: (req) => (req.path.startsWith('/appactions(') ? answer : undefined) });
    await assert.rejects(readCommandStateRow(readerFor(odd), id(1)), { code: 'command-state-row-unreadable' }, JSON.stringify(answer).slice(0, 80));
  }
  await assert.rejects(readCommandStateRow(reader, id(1).toUpperCase()), { code: 'command-state-row-unreadable' });
  assert.deepStrictEqual(org.writes(), []);
});

// --- the context --------------------------------------------------------------------------------------------------

test('the context is one app by unique name, its current layer, its complete table list and the version switch, in that order', async () => {
  const org = createCommandStateOrg({ tables: TABLES });
  const context = await resolveCommandStateContext(readerFor(org), { appUniqueName: 'contoso_Support', entities: ['Contoso_Ticket', 'contoso_note'] });
  assert.strictEqual(context.appId, APP_ID);
  assert.strictEqual(context.optimisticConcurrency, true);
  assert.deepStrictEqual([...context.tables.values()], [
    { entity: 'contoso_note', metadataId: NOTE, inApp: false },
    { entity: 'contoso_ticket', metadataId: TICKET, inApp: true },
  ]);
  assert.deepStrictEqual(org.requests.map((r) => r.path.replace(/\?.*/, '')), [
    '/appmodules', '/appmodules/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()', '/appmodulecomponents',
    "/EntityDefinitions(LogicalName='contoso_ticket')", "/EntityDefinitions(LogicalName='contoso_note')", "/EntityDefinitions(LogicalName='appaction')",
  ]);
  assert.deepStrictEqual(org.writes(), []);
  assert.deepStrictEqual(org.unexpected, []);
});

test('no app, two apps, an unreadable layer or component list, an unknown table and no version switch each fail the context', async () => {
  const cases = [
    [{ apps: [] }, 'command-state-context-unverified', /no published app/],
    [{ apps: [{ appmoduleid: APP_ID, uniquename: 'contoso_Support' }, { appmoduleid: OTHER_APP_ID, uniquename: 'contoso_support' }] }, 'command-state-context-unverified', /2 published apps/],
    [{ apps: [{ appmoduleid: 'not-a-guid', uniquename: 'contoso_Support' }] }, 'command-state-context-unverified', /no readable app id/],
    [{ overrides: (req) => (req.path.startsWith('/appmodules/') ? json(200, { value: [] }) : undefined) }, 'command-state-context-unverified', /current layer/],
    [{ overrides: (req) => (req.path.startsWith('/appmodulecomponents') ? json(200, { value: [{ objectid: null, componenttype: 1 }] }) : undefined) }, 'command-state-context-unverified', /its tables: the answer holds a row that cannot be placed \(objectid\); /],
    [{ overrides: (req) => (req.path.startsWith('/appmodulecomponents') ? json(200, {}) : undefined) }, 'command-state-context-unverified', /its tables: the answer is not a list of rows \(value\); /],
    [{ overrides: (req) => (req.path.startsWith('/appmodules?') ? json(403, { error: { code: '0x80040220', message: 'denied' } }) : undefined) }, 'command-state-context-unverified', /HTTP 403/],
    [{ concurrency: 'omit' }, 'command-state-version-unavailable', /row versions/],
    [{ concurrency: null }, 'command-state-version-unavailable', /row versions/],
    [{ overrides: (req) => (req.path.includes("'appaction'") ? json(403, {}) : undefined) }, 'command-state-version-unavailable', /HTTP 403/],
  ];
  for (const [options, code, message] of cases) {
    const org = createCommandStateOrg({ tables: TABLES, ...options });
    await assert.rejects(resolveCommandStateContext(readerFor(org), { appUniqueName: 'contoso_Support', entities: ['contoso_ticket'] }), (err) => {
      assert.strictEqual(err.code, code, String(message));
      assert.match(err.message, message);
      return true;
    }, String(message));
    assert.deepStrictEqual(org.writes(), []);
  }
  const org = createCommandStateOrg({ tables: TABLES });
  await assert.rejects(resolveCommandStateContext(readerFor(org), { appUniqueName: 'contoso_Support', entities: ['contoso_missing'] }), { code: 'command-state-context-unverified' });
  await assert.rejects(resolveCommandStateContext(readerFor(org), { appUniqueName: 'contoso_Support', entities: ['bad name'] }), { code: 'command-state-context-unverified' });
  await assert.rejects(resolveCommandStateContext(readerFor(org), { appUniqueName: ' ' }), { code: 'command-state-context-unverified' });
});

// The design keeps ETags, digests and raw responses out of the feature's halts and journals: every read this module makes, refused with
// the service's own words (here carrying a row version) or cut with no answer, is said by its status, Dataverse code or system code alone.
test('a refused or unanswered read is said by its status and code, never by the service\'s text', async () => {
  const SERVICE = 'review-service-message W/"498763"';
  const refuse = (prefix) => (req) => (req.path.startsWith(prefix) ? json(403, { error: { code: '0x80040220', message: SERVICE } }) : undefined);
  const cut = (prefix) => (req) => {
    if (req.path.startsWith(prefix)) throw Object.assign(new Error(`socket hang up: ${SERVICE}`), { code: 'ECONNRESET' });
    return undefined;
  };
  const clean = (message, said, what) => {
    assert.match(message, said, what);
    assert.ok(!message.includes('review-service-message') && !message.includes('498763'), `${what}: ${message}`);
  };
  const context = (overrides) => resolveCommandStateContext(readerFor(createCommandStateOrg({ tables: TABLES, overrides })), { appUniqueName: 'contoso_Support', entities: ['contoso_ticket'] });
  for (const [what, overrides, said] of [
    ['the app', refuse('/appmodules?'), /^app 'contoso_Support': HTTP 403, Dataverse error 0x80040220; /],
    ['its current layer', refuse('/appmodules/'), /its current layer could not be read: HTTP 403, Dataverse error 0x80040220; /],
    ['its current layer, cut', cut('/appmodules/'), /its current layer could not be read: no usable answer \(ECONNRESET\); /],
    ['its tables', refuse('/appmodulecomponents'), /its tables: HTTP 403, Dataverse error 0x80040220; /],
    ['a named table', refuse('/EntityDefinitions(LogicalName=\'contoso_ticket\')'), /the tables contoso_ticket: HTTP 403, Dataverse error 0x80040220; /],
  ]) {
    await assert.rejects(context(overrides), (err) => { assert.strictEqual(err.code, 'command-state-context-unverified', what); clean(err.message, said, what); return true; }, what);
  }
  const org = createCommandStateOrg({ tables: TABLES });
  const resolved = await resolveCommandStateContext(readerFor(org), { appUniqueName: 'contoso_Support', entities: ['contoso_ticket'] });
  const listed = createCommandStateOrg({ tables: TABLES, overrides: refuse('/appactions?') });
  await assert.rejects(listCommandStateRows(readerFor(listed), resolved), (err) => {
    assert.strictEqual(err.code, 'command-state-row-unreadable');
    clean(err.message, /^the modern commands of table 'contoso_ticket': HTTP 403, Dataverse error 0x80040220; /, 'the listing');
    return true;
  });
  const row = createCommandStateOrg({ tables: TABLES, overrides: cut('/appactions(') });
  await assert.rejects(readCommandStateRow(readerFor(row), id(1)), (err) => {
    assert.strictEqual(err.code, 'command-state-row-unreadable');
    clean(err.message, /could not be read: no usable answer \(ECONNRESET\); /, 'a row read with no answer');
    return true;
  });
});

test('with no table named, every table component of the app is resolved by its metadata id, and one that cannot be fails', async () => {
  const org = createCommandStateOrg({ tables: TABLES });
  const context = await resolveCommandStateContext(readerFor(org), { appUniqueName: 'contoso_Support' });
  assert.deepStrictEqual([...context.tables.keys()], ['contoso_order', 'contoso_ticket'], 'the app\u2019s tables only');
  const broken = createCommandStateOrg({ tables: TABLES, overrides: (req) => (req.path.startsWith(`/EntityDefinitions(${ORDER})`) ? json(200, { LogicalName: 'Not A Name', MetadataId: ORDER }) : undefined) });
  await assert.rejects(resolveCommandStateContext(readerFor(broken), { appUniqueName: 'contoso_Support' }), { code: 'command-state-context-unverified' });
});

// --- the listing --------------------------------------------------------------------------------------------------

test('every page of every table is read; excluded rows are listed with their reasons; duplicates carry each other\u2019s id; the order is fixed', async () => {
  const rows = [
    ticketRow(5, { buttonlabeltext: 'Approve', location: 1 }),
    ticketRow(1, { buttonlabeltext: 'Escalate' }),
    ticketRow(2, { buttonlabeltext: 'escalate ', statecode: 1, statuscode: 2 }),
    ticketRow(3, { buttonlabeltext: null }),
    ticketRow(4, { buttonlabeltext: 'Group', type: 3 }),
    ticketRow(6, { buttonlabeltext: 'Header', location: 5 }),
    ticketRow(7, { buttonlabeltext: 'Theirs', _appmoduleid_value: OTHER_APP_ID }),
    ticketRow(8, { buttonlabeltext: 'Migrated', origin: 1 }),
    ticketRow(9, { buttonlabeltext: 'Managed', ismanaged: true }),
    commandRow(id(10), 'contoso_order', ORDER, { buttonlabeltext: 'Ship', location: 2, _appmoduleid_value: APP_ID }),
  ];
  const org = createCommandStateOrg({ tables: TABLES, rows, pageSize: 2 });
  const reader = readerFor(org);
  const context = await resolveCommandStateContext(reader, { appUniqueName: 'contoso_Support' });
  const listed = await listCommandStateRows(reader, context);
  assert.deepStrictEqual(listed.map((x) => [x.table, x.row.location, x.row.caption, x.row.rowId.slice(-2), x.reasons]), [
    ['contoso_order', 2, 'Ship', '10', ['app-scoped']],
    ['contoso_ticket', 0, 'Escalate', '01', []],
    ['contoso_ticket', 0, 'escalate ', '02', ['inactive']],
    ['contoso_ticket', 0, 'Group', '04', ['not-standard-button']],
    ['contoso_ticket', 0, 'Managed', '09', ['managed']],
    ['contoso_ticket', 0, 'Migrated', '08', ['not-default-origin']],
    ['contoso_ticket', 0, 'Theirs', '07', ['app-scoped']],
    ['contoso_ticket', 0, null, '03', []],
    ['contoso_ticket', 1, 'Approve', '05', []],
    ['contoso_ticket', 5, 'Header', '06', ['location-unsupported']],
  ]);
  assert.deepStrictEqual(listed.find((x) => x.row.rowId === id(1)).sameCaption, [id(2)]);
  assert.deepStrictEqual(listed.find((x) => x.row.rowId === id(2)).sameCaption, [id(1)]);
  assert.strictEqual(listed.find((x) => x.row.rowId === id(6)).row.bar, 'unsupported');
  const pages = org.requests.filter((r) => r.path.startsWith('/appactions?'));
  assert.strictEqual(pages.length, 1 + 5, 'one page for the order table, five pages of two for the ticket table');
  assert.ok(pages.every((r) => r.url.startsWith(`${API}/appactions?`)), 'every continuation on the same origin and API root');
  assert.deepStrictEqual(org.writes(), []);
  assert.deepStrictEqual(org.unexpected, []);

  const formOnly = await listCommandStateRows(reader, context, { location: 1 });
  assert.deepStrictEqual(formOnly.map((x) => x.row.rowId), [id(5)]);
});

test('a page that fails, an answer that is no list, a repeated or foreign continuation and a row answered twice fail the listing', async () => {
  const rows = [ticketRow(1), ticketRow(2), ticketRow(3)];
  const second = (answer) => (req) => (req.path.startsWith('/appactions?') && req.path.includes('$skiptoken=2') ? answer(req) : undefined);
  const cases = [
    ['a refused page', second(() => json(403, { error: { code: '0x80040220', message: 'denied' } })), /HTTP 403/],
    ['no value list', second(() => json(200, { rows: [] })), /the answer is not a list of rows \(value\); /],
    ['a sign-in page', second(() => ({ statusCode: 200, headers: { 'content-type': 'text/html' }, body: '<html></html>' })), /the answer is not a list of rows \(value\); /],
    ['a repeated link', (req) => (req.path.startsWith('/appactions?') ? json(200, { value: [], '@odata.nextLink': `${API}/appactions?$select=appactionid&$filter=contextvalue eq 'contoso_ticket'` }) : undefined), /the answer repeated a next-page link; /],
    ['a link to another origin', (req) => (req.path.startsWith('/appactions?') && !req.path.includes('skiptoken') ? json(200, { value: [rows[0]], '@odata.nextLink': `https://fabrikam.crm.dynamics.com/api/data/v9.0/appactions?$skiptoken=2` }) : undefined), /the next-page link pointed outside the expected API and was not followed/],
    ['a link to another resource', (req) => (req.path.startsWith('/appactions?') && !req.path.includes('skiptoken') ? json(200, { value: [rows[0]], '@odata.nextLink': `${API}/systemusers?$skiptoken=2` }) : undefined), /the next-page link pointed outside the expected API and was not followed/],
    ['a malformed link', (req) => (req.path.startsWith('/appactions?') ? json(200, { value: [rows[0]], '@odata.nextLink': 42 }) : undefined), /the answer's next-page link is not a link \(@odata.nextLink\); /],
    ['a row twice', second(() => json(200, { value: [rows[0]] })), /answered twice/],
    ['a row that is no record', second(() => json(200, { value: [null] })), /not a record/],
  ];
  for (const [what, overrides, message] of cases) {
    const org = createCommandStateOrg({ tables: TABLES, rows, overrides });
    const reader = readerFor(org);
    const context = await resolveCommandStateContext(reader, { appUniqueName: 'contoso_Support', entities: ['contoso_ticket'] });
    await assert.rejects(listCommandStateRows(reader, context), (err) => {
      assert.ok(/^command-state-(row-unreadable|transport-unavailable)$/.test(err.code), `${what}: ${err.code}`);
      assert.match(err.message, message, what);
      return true;
    });
    assert.ok(org.requests.every((r) => r.origin === ORIGIN), `${what}: nothing sent elsewhere`);
    assert.ok(org.requests.every((r) => !r.path.startsWith('/systemusers')), `${what}: nothing else read`);
    assert.deepStrictEqual(org.writes(), [], what);
  }
});

// --- the transport ------------------------------------------------------------------------------------------------

test('the transport reads only the feature\u2019s resources, under the SDK\u2019s API root, and writes only one row\u2019s flags', async () => {
  const org = createCommandStateOrg({ tables: TABLES });
  const reader = readerFor(org);
  assert.deepStrictEqual(Object.keys(reader).sort(), ['apiUrl', 'get', 'getAbsolute', 'patchRow']);
  // The one write refuses, before sending, anything but a row id, a row version and a body of only hidden/isdisabled booleans.
  for (const [rowId, ifMatch, body] of [
    ['not-a-guid', 'W/"1"', { hidden: true }], [id(1).toUpperCase(), 'W/"1"', { hidden: true }], [id(1), '*', { hidden: true }], [id(1), undefined, { hidden: true }],
    [id(1), 'W/"1"', {}], [id(1), 'W/"1"', { hidden: 'true' }], [id(1), 'W/"1"', { hidden: true, visibilitytype: 0 }], [id(1), 'W/"1"', { name: 'x' }], [id(1), 'W/"1"', [true]],
  ]) {
    await assert.rejects(reader.patchRow(rowId, ifMatch, body), { code: 'command-state-transport-unavailable' }, JSON.stringify([rowId, ifMatch, body]));
  }
  const readOnly = createCommandStateTransport({ client: { get() {} }, apiUrl: (p) => `${API}${p}` });
  assert.strictEqual(readOnly.patchRow, undefined, 'a client that cannot PATCH gives a transport that cannot write');
  for (const path of ['/systemusers?$select=fullname', '/appactions', `/appactions(${id(1)})`, "/EntityDefinitions(LogicalName='x')?$select=Privileges($select=Name)", '/$batch', 'appactions?$select=name', `${API}/appactions?$select=name`]) {
    await assert.rejects(reader.get(path), { code: 'command-state-transport-unavailable' }, path);
  }
  for (const url of [`https://fabrikam.crm.dynamics.com/api/data/v9.0/appactions?$skiptoken=1`, `${ORIGIN}/api/data/v9.1/appactions?$skiptoken=1`, `${API}/solutions?$skiptoken=1`, '/appactions?$skiptoken=1']) {
    await assert.rejects(reader.getAbsolute(url), { code: 'command-state-transport-unavailable' }, url);
  }
  assert.deepStrictEqual(org.requests, [], 'nothing refused was sent');
  assert.throws(() => createCommandStateTransport({ apiUrl: () => API }), { code: 'command-state-transport-unavailable' });
  assert.throws(() => createCommandStateTransport({ client: { get() {} } }), { code: 'command-state-transport-unavailable' });
  assert.throws(() => createCommandStateTransport({ client: { get() {} }, apiUrl: () => 'not a url' }), { code: 'command-state-transport-unavailable' });
  assert.throws(() => createCommandStateTransport({ client: { get() {} }, apiUrl: () => 'http://contoso.crm.dynamics.com/api/data/v9.0/' }), { code: 'command-state-transport-unavailable' });
});

// --- verification --------------------------------------------------------------------------------------------------

test('verify reads each declared row and checks only the flags it declares, by their spec names; it never writes', async () => {
  const org = createCommandStateOrg({ tables: TABLES, rows: [ticketRow(1, { hidden: true }), ticketRow(2, { isdisabled: true }), ticketRow(3), ticketRow(4, { _appmoduleid_value: APP_ID }), ticketRow(5, { location: 1 })] });
  const spec = {
    app: { uniqueName: 'contoso_Support' },
    commandStates: [
      { entity: 'contoso_ticket', location: 'MainTab', scope: 'table', rowId: id(1), hidden: true },
      { entity: 'contoso_ticket', location: 'MainTab', scope: 'table', rowId: id(2), disabled: true, hidden: false },
      { entity: 'contoso_ticket', location: 'MainTab', scope: 'table', rowId: id(3), disabled: true },
      { entity: 'contoso_ticket', location: 'MainTab', scope: 'table', rowId: id(4), hidden: false },
      { entity: 'contoso_ticket', location: 'MainTab', scope: 'table', rowId: id(5), hidden: false },
      { entity: 'contoso_ticket', location: 'MainTab', scope: 'table', rowId: id(6), hidden: true },
    ],
  };
  const checks = await verifyCommandStates(readerFor(org), spec);
  assert.deepStrictEqual(checks.map((c) => [c.name, c.present]), [
    [`contoso_ticket MainTab row ${id(1)}`, true], [`contoso_ticket MainTab row ${id(2)}`, true], [`contoso_ticket MainTab row ${id(3)}`, false],
    [`contoso_ticket MainTab row ${id(4)}`, false], [`contoso_ticket MainTab row ${id(5)}`, false], [`contoso_ticket MainTab row ${id(6)}`, false],
  ]);
  assert.match(checks[1].detail, /^hidden false, disabled true \(stored flags of the exact row; how the button renders is not checked\)$/);
  assert.match(checks[2].detail, /^disabled is false, declared true/);
  assert.match(checks[3].detail, /not the declared row: app-scoped/);
  assert.match(checks[4].detail, /not the declared row: location-mismatch/);
  assert.match(checks[5].detail, /^the row does not exist/);
  assert.deepStrictEqual(org.writes(), []);
  assert.deepStrictEqual(await verifyCommandStates(readerFor(org), { app: {} }), [], 'no command states: nothing to verify');
});

test('verify fails every entry, never passes or skips one, when the app context or a row cannot be read', async () => {
  const spec = { app: { uniqueName: 'contoso_Missing' }, commandStates: [{ entity: 'contoso_ticket', location: 'MainTab', scope: 'table', rowId: id(1), hidden: true }] };
  const noApp = await verifyCommandStates(readerFor(createCommandStateOrg({ tables: TABLES, rows: [ticketRow(1, { hidden: true })] })), spec);
  assert.deepStrictEqual(noApp.map((c) => c.present), [false]);
  assert.match(noApp[0].detail, /^could not be read: /);
  const odd = createCommandStateOrg({ tables: TABLES, overrides: (req) => (req.path.startsWith('/appactions(') ? json(503, {}) : undefined) });
  const unreadable = await verifyCommandStates(readerFor(odd), { ...spec, app: { uniqueName: 'contoso_Support' } });
  assert.deepStrictEqual(unreadable.map((c) => c.present), [false]);
  assert.match(unreadable[0].detail, /^could not be read: /);
});