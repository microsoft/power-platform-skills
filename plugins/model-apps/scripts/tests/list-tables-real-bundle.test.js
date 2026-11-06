'use strict';
// REAL BUNDLE: scripts/list-tables.js through the plugin's real az-token HttpClient and the real vendored SDK, over a fake Dataverse that answers
// the one read the SDK's `findTables()` makes, in the shape the platform answers it:
//   GET /EntityDefinitions?$select=LogicalName,SchemaName,EntitySetName,DisplayName,IsCustomEntity
//     -> { value: [ { LogicalName, SchemaName, EntitySetName, IsCustomEntity, DisplayName: { UserLocalizedLabel: { Label } | null } } ] }
// A stub of findTables can only agree with the script about findTables; this is what tells the plugin that a re-vendored bundle matches another
// field, reads another endpoint, or caches the list (so that a second term would silently read nothing).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createAzHttpClient } = require('../lib/sdk-http-client.js');
const { createFakeAppsOrg, json } = require('./helpers/fake-apps-org.js');
const { readTables, searchTerms } = require('../list-tables.js');

const ORIGIN = 'https://contoso.crm.dynamics.com';
const READ = 'GET /EntityDefinitions?$select=LogicalName,SchemaName,EntitySetName,DisplayName,IsCustomEntity';

const client = (org) => createAzHttpClient(ORIGIN, { getToken: () => 'test-token', request: org.request, sleep: async () => {} });
const t = (logicalName, schemaName, displayName, isCustom = false, entitySetName) => ({ logicalName, schemaName, displayName, isCustom, entitySetName });

const FIXTURE = [
  t('account', 'Account', 'Account', false, 'accounts'),
  t('accountleads', 'AccountLeads', 'AccountLeads', false, 'accountleadses'),
  t('contact', 'Contact', 'Contact', false, 'contacts'),
  t('cr_widget', 'cr_Widget', 'Widget', true, 'gadgets'),
  t('cr_ticket', 'cr_Ticket', 'Support Ticket', true, 'cr_tickets'),
  t('incident', 'Incident', 'Case', false, 'incidents'),
  t('msdyn_accountkpiitem', 'msdyn_accountkpiitem', 'Account KPI Item', true, 'msdyn_accountkpiitems'),
  t('msdyn_msdyn_warranty_account', 'msdyn_msdyn_warranty_account', '', true, 'msdyn_msdyn_warranty_accounts'),
  t('new_note', 'new_Note', 'Caf\u00e9 notes', true, 'new_notes'),
  t('task', 'Task', 'Task', false, 'tasks'),
];

test('REAL BUNDLE: every table is one read of the definitions, listed as pac\u2019s four columns with the platform\u2019s own flags', async () => {
  const org = createFakeAppsOrg({ tables: FIXTURE });
  const result = await readTables(ORIGIN, {}, client(org));
  assert.deepStrictEqual(org.requests.map((r) => `${r.method} ${r.path}`), [READ]);
  assert.deepStrictEqual(org.writes(), []);
  assert.deepStrictEqual(org.unexpected, []);
  assert.deepStrictEqual(Object.keys(result), ['ok', 'count', 'tables']);
  assert.strictEqual(result.count, FIXTURE.length);
  assert.deepStrictEqual(result.tables.map((x) => x.logicalName), FIXTURE.map((x) => x.logicalName), 'in the order the platform answered');
  assert.deepStrictEqual(result.tables.find((x) => x.logicalName === 'cr_ticket'), { logicalName: 'cr_ticket', displayName: 'Support Ticket', schemaName: 'cr_Ticket', isCustom: true });
  assert.deepStrictEqual(result.tables.find((x) => x.logicalName === 'account'), { logicalName: 'account', displayName: 'Account', schemaName: 'Account', isCustom: false });
  assert.strictEqual(result.tables.find((x) => x.logicalName === 'msdyn_msdyn_warranty_account').displayName, '', 'a table with no label');
  assert.strictEqual(result.tables.find((x) => x.logicalName === 'new_note').displayName, 'Caf\u00e9 notes');
});

test('REAL BUNDLE: a term matches the logical, schema or display name as a substring in any letter case — pac\u2019s --search — and never the entity set name', async () => {
  const org = createFakeAppsOrg({ tables: FIXTURE });
  const cases = {
    account: ['account', 'accountleads', 'msdyn_accountkpiitem', 'msdyn_msdyn_warranty_account'],
    ACCOUNT: ['account', 'accountleads', 'msdyn_accountkpiitem', 'msdyn_msdyn_warranty_account'],
    Widget: ['cr_widget'],
    'support ticket': ['cr_ticket'],
    CR_TIC: ['cr_ticket'],
    'KPI Item': ['msdyn_accountkpiitem'],
    'caf\u00e9': ['new_note'],
    gadget: [],
    'no such table': [],
  };
  for (const [term, expected] of Object.entries(cases)) {
    const result = await readTables(ORIGIN, { terms: [term] }, client(org));
    assert.deepStrictEqual(result.tables.map((x) => x.logicalName), expected, term);
  }
});

test('REAL BUNDLE: each term is a read of its own — the SDK keeps no list between them — and the answers are joined, a table once', async () => {
  const org = createFakeAppsOrg({ tables: FIXTURE });
  const result = await readTables(ORIGIN, { terms: searchTerms('incident, task ,kpi,account,incident') }, client(org));
  assert.deepStrictEqual(org.requests.map((r) => `${r.method} ${r.path}`), [READ, READ, READ, READ], 'four terms, four reads');
  assert.deepStrictEqual(result.tables.map((x) => x.logicalName), ['incident', 'task', 'msdyn_accountkpiitem', 'account', 'accountleads', 'msdyn_msdyn_warranty_account']);
  assert.deepStrictEqual(result.search, ['incident', 'task', 'kpi', 'account']);
});

// The planner's rule, written out independently of the SDK: a table is found by a term when the term is a substring of its logical name, its
// schema name or its display name, in any letter case. Over a larger, generated list, for a battery of terms and for their unions.
test('REAL BUNDLE: over 600 generated tables, the answer to every term and to a list of terms is the planner\u2019s substring rule, in the platform\u2019s order', async () => {
  const prefixes = ['', 'cr_', 'new_', 'msdyn_', 'msdynmkt_', 'contoso_'];
  const stems = ['account', 'contact', 'ticket', 'invoice', 'project', 'task', 'order', 'lead', 'case', 'note'];
  const tables = [];
  let n = 0;
  for (const prefix of prefixes) {
    for (const stem of stems) {
      for (const suffix of ['', 'item', 'type', 'log', 'set', 'map', 'rule', 'state', 'plan', 'view']) {
        n += 1;
        const logicalName = `${prefix}${stem}${suffix}`;
        tables.push(t(logicalName, `${prefix}${stem[0].toUpperCase()}${stem.slice(1)}${suffix}`, n % 7 === 0 ? '' : `${stem[0].toUpperCase()}${stem.slice(1)} ${suffix || 'main'}`, prefix !== '', `${logicalName}s`));
      }
    }
  }
  assert.strictEqual(tables.length, 600);
  const org = createFakeAppsOrg({ tables });
  const matches = (table, term) => [table.logicalName, table.schemaName, table.displayName].some((name) => name.toLowerCase().includes(term.toLowerCase()));
  for (const terms of [['account'], ['TICKET'], ['cr_'], ['msdynmkt_order'], ['x'], ['item', 'plan'], ['lead', 'LEAD ', 'note', 'new_'], ['zzz']]) {
    const expected = [];
    for (const term of terms) for (const table of tables) if (matches(table, term) && !expected.includes(table.logicalName)) expected.push(table.logicalName);
    const result = await readTables(ORIGIN, { terms: searchTerms(terms.join(',')) }, client(org));
    assert.deepStrictEqual(result.tables.map((x) => x.logicalName), expected, terms.join(','));
  }
  const all = await readTables(ORIGIN, {}, client(org));
  assert.strictEqual(all.count, 600);
});

test('REAL BUNDLE: --exact keeps the tables a term names, whatever its letter case, and reports the terms no table has — from ONE read of the list, in the order of the terms', async () => {
  const org = createFakeAppsOrg({ tables: FIXTURE });
  const result = await readTables(ORIGIN, { terms: ['CONTACT', 'cr_candidate', 'account', 'cr_jobrequisition', 'Account'], exact: true }, client(org));
  assert.deepStrictEqual(result.tables.map((x) => x.logicalName), ['contact', 'account'], 'in the order of the terms, once each');
  assert.deepStrictEqual(result.missing, ['cr_candidate', 'cr_jobrequisition']);
  assert.deepStrictEqual(Object.keys(result), ['ok', 'search', 'exact', 'count', 'tables', 'missing']);
  assert.strictEqual(result.count, 2);
  assert.deepStrictEqual(org.requests.map((r) => `${r.method} ${r.path}`), [READ], 'one read of the whole list, whatever the number of terms');
});

test('REAL BUNDLE: a search for more terms than the bound still reads once per term, and answers as the sequential search would', async () => {
  const org = createFakeAppsOrg({ tables: FIXTURE });
  const terms = ['task', 'incident', 'contact', 'kpi', 'ticket', 'widget', 'note', 'account'];
  const result = await readTables(ORIGIN, { terms }, client(org));
  assert.strictEqual(org.requests.length, terms.length, 'one read per term');
  assert.ok(org.requests.every((r) => `${r.method} ${r.path}` === READ));
  const expected = [];
  for (const term of terms) for (const x of FIXTURE) if ([x.logicalName, x.schemaName, x.displayName].some((n) => n.toLowerCase().includes(term))) if (!expected.includes(x.logicalName)) expected.push(x.logicalName);
  assert.deepStrictEqual(result.tables.map((x) => x.logicalName), expected);
});

test('REAL BUNDLE: --exact with no terms is no exact search at all: every table, and no exact or missing in the answer', async () => {
  const org = createFakeAppsOrg({ tables: FIXTURE });
  const result = await readTables(ORIGIN, { exact: true }, client(org));
  assert.deepStrictEqual(Object.keys(result), ['ok', 'count', 'tables']);
  assert.strictEqual(result.count, FIXTURE.length);
});

// --- --type: the SDK's own customOnly option -------------------------------------------------------------------------------

const logicalNames = (result) => result.tables.map((x) => x.logicalName);
const CUSTOM = FIXTURE.filter((x) => x.isCustom).map((x) => x.logicalName);
const STANDARD = FIXTURE.filter((x) => !x.isCustom).map((x) => x.logicalName);

test('REAL BUNDLE: --type custom lists the tables the platform flags IsCustomEntity — the SDK\u2019s customOnly, over the one read it always makes — and standard the rest', async () => {
  const org = createFakeAppsOrg({ tables: FIXTURE });
  const custom = await readTables(ORIGIN, { type: 'custom' }, client(org));
  assert.deepStrictEqual(logicalNames(custom), CUSTOM);
  assert.strictEqual(custom.type, 'custom');
  assert.ok(custom.tables.every((x) => x.isCustom === true));
  assert.deepStrictEqual(org.requests.map((r) => `${r.method} ${r.path}`), [READ], 'the same single read of the definitions: the platform is not asked to filter');
  const standard = await readTables(ORIGIN, { type: 'standard' }, client(org));
  assert.deepStrictEqual(logicalNames(standard), STANDARD);
  assert.ok(standard.tables.every((x) => x.isCustom === false));
  const all = await readTables(ORIGIN, { type: 'all' }, client(org));
  assert.deepStrictEqual(logicalNames(all), FIXTURE.map((x) => x.logicalName));
  assert.deepStrictEqual(Object.keys(all), ['ok', 'type', 'count', 'tables']);
  assert.deepStrictEqual([...logicalNames(custom), ...logicalNames(standard)].sort(), logicalNames(all).sort(), 'the two kinds are the whole list, with nothing in both');
});

// If a re-vendored SDK changed what customOnly keeps — or dropped the option — the script would print another list than the SDK's own. This pins them equal.
test('REAL BUNDLE: --type custom is exactly what sdk.findTables(term, { customOnly: true }) answers, for the whole list and for each term', async () => {
  const { createMakerSdk, createNodeWorkspaceStorage } = require('../lib/maker-sdk.js');
  const org = createFakeAppsOrg({ tables: FIXTURE });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tables-type-'));
  try {
    const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(dir), instanceUrl: ORIGIN, httpClient: client(org) });
    for (const term of [undefined, 'account', 'TICKET', 'caf\u00e9', 'task', 'zzz']) {
      const own = (await sdk.findTables(term, { customOnly: true })).map((x) => x.logicalName);
      const ours = await readTables(ORIGIN, { terms: term === undefined ? [] : [term], type: 'custom' }, client(org));
      assert.deepStrictEqual(logicalNames(ours), own, String(term));
    }
    assert.ok((await sdk.findTables(undefined, { customOnly: true })).length > 0, 'the premise: the option keeps something');
    assert.ok((await sdk.findTables(undefined, { customOnly: true })).length < FIXTURE.length, 'and leaves something out');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('REAL BUNDLE: --type with terms reads once per term and keeps only that type of each; with --exact it reads once, and a table of the other type is missing', async () => {
  const org = createFakeAppsOrg({ tables: FIXTURE });
  const custom = await readTables(ORIGIN, { terms: ['account', 'ticket', 'incident'], type: 'custom' }, client(org));
  assert.deepStrictEqual(logicalNames(custom), ['msdyn_accountkpiitem', 'msdyn_msdyn_warranty_account', 'cr_ticket']);
  assert.deepStrictEqual(org.requests.map((r) => `${r.method} ${r.path}`), [READ, READ, READ], 'one read per term');
  const standard = await readTables(ORIGIN, { terms: ['account', 'ticket', 'incident'], type: 'standard' }, client(org));
  assert.deepStrictEqual(logicalNames(standard), ['account', 'accountleads', 'incident']);

  const before = org.requests.length;
  const exact = await readTables(ORIGIN, { terms: ['cr_ticket', 'incident', 'CONTACT', 'task'], exact: true, type: 'custom' }, client(org));
  assert.deepStrictEqual(logicalNames(exact), ['cr_ticket']);
  assert.deepStrictEqual(exact.missing, ['incident', 'CONTACT', 'task'], 'standard tables are not custom, so they are not found');
  assert.strictEqual(org.requests.length - before, 1, 'one read');
  assert.deepStrictEqual(Object.keys(exact), ['ok', 'search', 'exact', 'type', 'count', 'tables', 'missing']);
});

test('REAL BUNDLE: a type that is none of the three is refused by readTables itself, before any request', async () => {
  const org = createFakeAppsOrg({ tables: FIXTURE });
  await assert.rejects(readTables(ORIGIN, { type: 'managed' }, client(org)), /type must be custom, standard or all \(got 'managed'\)/);
  assert.deepStrictEqual(org.requests, []);
});

test('REAL BUNDLE: a refused read fails with the SDK\u2019s own CONNECTION_ERROR and message, and no token reaches the output', async () => {
  const org = createFakeAppsOrg({ tables: FIXTURE, answer: () => json(403, { error: { code: '0x80040220', message: 'The user is not a member of the organization.' } }) });
  await assert.rejects(readTables(ORIGIN, { terms: ['account'] }, client(org)), (err) => {
    assert.strictEqual(err.code, 'CONNECTION_ERROR');
    assert.strictEqual(err.statusCode, 403);
    assert.match(err.message, /^HTTP 403 from .*\/EntityDefinitions.*The user is not a member of the organization\./);
    assert.ok(!err.message.includes('test-token'));
    return true;
  });
  const noToken = createAzHttpClient(ORIGIN, { getToken: () => null, request: createFakeAppsOrg({ tables: FIXTURE }).request, sleep: async () => {} });
  await assert.rejects(readTables(ORIGIN, {}, noToken), (err) => err.code === 'CONNECTION_ERROR' && /az login|Azure CLI/.test(err.message));
});

test('REAL BUNDLE: the script leaves no throwaway directory behind, on a read or on a refused one', async () => {
  const made = [];
  const mkdtemp = fs.mkdtempSync;
  fs.mkdtempSync = (prefix, ...rest) => { const dir = mkdtemp(prefix, ...rest); made.push(dir); return dir; };
  try {
    await readTables(ORIGIN, {}, client(createFakeAppsOrg({ tables: FIXTURE })));
    await assert.rejects(readTables(ORIGIN, {}, client(createFakeAppsOrg({ answer: () => json(500, { error: { message: 'no' } }) }))));
  } finally {
    fs.mkdtempSync = mkdtemp;
  }
  assert.strictEqual(made.length, 2);
  for (const dir of made) assert.strictEqual(fs.existsSync(dir), false, dir);
});

// --- end to end: the real script in a real process ---------------------------------------------------------------------

const PRELOAD = path.resolve(__dirname, 'helpers', 'fake-apps-org-preload.js');
const SCRIPT = path.resolve(__dirname, '..', 'list-tables.js');
const runScript = (argv, orgOptions = {}, env = process.env) => spawnSync(process.execPath, ['--require', PRELOAD, SCRIPT, ...argv], {
  env: { ...env, FAKE_APPS_ORG: JSON.stringify(orgOptions) },
  encoding: 'utf8',
  timeout: 120000,
});
const lines = (r) => r.stdout.split(/\r?\n/).filter(Boolean);

test('END TO END: a search prints one pure-ASCII JSON line the planner can read, and exits 0', () => {
  const r = runScript(['--env', ORIGIN, '--search', 'note, cr_ticket,cr_candidate', '--exact'], { tables: FIXTURE });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stderr, '');
  assert.strictEqual(lines(r).length, 1, 'one line');
  assert.match(r.stdout, /^[\x00-\x7e\r\n]*$/, 'pure ASCII');
  const result = JSON.parse(lines(r)[0]);
  assert.deepStrictEqual(result.tables.map((x) => x.logicalName), ['cr_ticket']);
  assert.deepStrictEqual(result.missing, ['note', 'cr_candidate'], '`note` is part of new_note, not a table\u2019s name');
  const display = JSON.parse(lines(runScript(['--env', ORIGIN, '--search', 'caf'], { tables: FIXTURE }))[0]);
  assert.strictEqual(display.tables[0].displayName, 'Caf\u00e9 notes', 'the escape reads back as the name');
  assert.ok(runScript(['--env', ORIGIN, '--search', 'caf'], { tables: FIXTURE }).stdout.includes('Caf\\u00e9 notes'));
});

test('END TO END: no --search lists every table, and a usage error prints nothing on stdout and exits 1', () => {
  const all = runScript(['--env', ORIGIN], { tables: FIXTURE });
  assert.strictEqual(all.status, 0, all.stderr);
  assert.strictEqual(JSON.parse(lines(all)[0]).count, FIXTURE.length);
  const bad = runScript(['--env', ORIGIN, '--exact']);
  assert.strictEqual(bad.status, 1);
  assert.strictEqual(bad.stdout, '');
  assert.match(bad.stderr, /--exact needs --search[\s\S]*Usage:/);
});

test('END TO END: --type custom prints one line of the custom tables only — shorter than the whole list, which is what it is for — and a type that is none of the three is a usage error', () => {
  const all = runScript(['--env', ORIGIN], { tables: FIXTURE });
  const custom = runScript(['--env', ORIGIN, '--type', 'custom'], { tables: FIXTURE });
  assert.strictEqual(custom.status, 0, custom.stderr);
  assert.strictEqual(lines(custom).length, 1, 'one line');
  const result = JSON.parse(lines(custom)[0]);
  assert.strictEqual(result.type, 'custom');
  assert.deepStrictEqual(result.tables.map((x) => x.logicalName), CUSTOM);
  assert.ok(custom.stdout.length < all.stdout.length, 'the answer is shorter');
  const standard = JSON.parse(lines(runScript(['--env', ORIGIN, '--type=standard', '--search', 'a,t'], { tables: FIXTURE }))[0]);
  assert.ok(standard.tables.length > 0 && standard.tables.every((x) => x.isCustom === false));
  const bad = runScript(['--env', ORIGIN, '--type', 'managed']);
  assert.strictEqual(bad.status, 1);
  assert.strictEqual(bad.stdout, '');
  assert.match(bad.stderr, /--type must be custom, standard or all \(got 'managed'\)[\s\S]*Usage:.*\[--type custom\|standard\|all\]/);
});

test('END TO END, a platform that refuses the read: one { ok: false } line with the SDK\u2019s code, the message on stderr, exit 1', () => {
  const r = runScript(['--env', ORIGIN, '--search', 'account'], { refuse: { status: 403, message: 'The user is not a member of the organization.' } });
  assert.strictEqual(r.status, 1);
  assert.strictEqual(lines(r).length, 1);
  const result = JSON.parse(lines(r)[0]);
  assert.deepStrictEqual([result.ok, result.code], [false, 'CONNECTION_ERROR']);
  assert.ok(!('tables' in result), 'no answer, not even an empty one');
  assert.ok(r.stderr.includes('The user is not a member of the organization.'));
});

test('END TO END, with the Azure CLI not on PATH: exit 1 and an { ok: false } line — no table list, and no empty one in its place', () => {
  const { resolveExecutable } = require('../lib/process-runner.js');
  const emptyPath = fs.mkdtempSync(path.join(os.tmpdir(), 'no-az-'));
  try {
    const env = { ...process.env };
    // Windows names the variable `Path`, and a second spelling beside it would leave the child one of the two.
    for (const key of Object.keys(env)) if (key.toUpperCase() === 'PATH') delete env[key];
    env.PATH = emptyPath;
    assert.strictEqual(resolveExecutable('az', { env }), null, 'the premise: no `az` is found under this PATH');
    const r = spawnSync(process.execPath, [SCRIPT, '--env', ORIGIN, '--search', 'account'], { env, encoding: 'utf8', timeout: 120000 });
    assert.strictEqual(r.status, 1, r.stderr);
    const result = JSON.parse(r.stdout.trim());
    assert.deepStrictEqual([result.ok, result.code], [false, 'CONNECTION_ERROR']);
    assert.match(result.error, /Azure CLI/);
    assert.ok(!('tables' in result));
  } finally {
    fs.rmSync(emptyPath, { recursive: true, force: true });
  }
});
