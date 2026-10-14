'use strict';
// scripts/list-tables.js end to end through its main(): flags, the origin check, the SDK reads (one findTables per term), the union of the
// terms, --exact and what it reports missing, the printed JSON, and the throwaway workspace — with the SDK and the HTTP client stubbed (the
// real bundle is driven in list-tables-real-bundle.test.js).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { loadCli } = require('./helpers/cli-harness.js');
const realAuth = require('../lib/dataverse-auth.js');
const { withThrowawaySdk } = require('../lib/throwaway-sdk.js');

const SCRIPT = path.resolve(__dirname, '..', 'list-tables.js');
const ENV = 'https://contoso.crm.dynamics.com';

const table = (logicalName, schemaName, displayName, isCustom = false) => ({ logicalName, schemaName, displayName, entitySetName: `${logicalName}s`, isCustom });
const TABLES = [
  table('account', 'Account', 'Account'),
  table('accountleads', 'AccountLeads', 'AccountLeads'),
  table('contact', 'Contact', 'Contact'),
  table('cr_ticket', 'cr_Ticket', 'Support Ticket', true),
  table('incident', 'Incident', 'Case'),
  table('msdyn_accountkpiitem', 'msdyn_accountkpiitem', 'Account KPI Item', true),
  table('msdyn_msdyn_warranty_account', 'msdyn_msdyn_warranty_account', '', true),
  table('new_note', 'new_Note', 'Caf\u00e9 notes', true),
];
// What the SDK's findTables does: the tables whose logical name, schema name or display name contains the term, in any letter case; with
// `{ customOnly: true }` only the custom ones, before the term is matched.
const findTables = (term, options) => TABLES
  .filter((t) => !(options && options.customOnly) || t.isCustom)
  .filter((t) => [t.logicalName, t.schemaName, t.displayName].some((name) => name.toLowerCase().includes(String(term ?? '').toLowerCase())));

// Runs main() with `argv`; `find` answers findTables (a function of the term and the options, which may throw). The stubbed emitResult ends the run as the real one does.
async function run(argv, find = async (term, options) => findTables(term, options)) {
  const events = [];
  const emitted = [];
  const emitOptions = [];
  const requires = {
    './lib/dataverse-auth.js': {
      ...realAuth,
      emitResult: (ok, payload, options) => {
        emitted.push({ ok, payload });
        emitOptions.push(options);
        const exit = new Error(`process.exit(${ok ? 0 : 1})`);
        exit.exitCode = ok ? 0 : 1;
        throw exit;
      },
    },
    // The throwaway-workspace lifecycle is the real one (lib/throwaway-sdk.js); only the SDK and the client it makes are stubs.
    './lib/throwaway-sdk.js': {
      withThrowawaySdk: (options, runWith) => withThrowawaySdk({
        ...options,
        deps: {
          createAzHttpClient: (env) => { events.push({ type: 'client', env }); return { marker: 'az-client', env }; },
          makerSdk: {
            createNodeWorkspaceStorage: (dir) => ({ dir }),
            createMakerSdk: (cfg) => {
              events.push({ type: 'sdk', cfg });
              // Only the one method the script may call: anything else (initWorkspace, a workspace read) is a TypeError.
              return { findTables: async (term, findOptions) => { events.push({ type: 'findTables', term, options: findOptions }); return find(term, findOptions); } };
            },
          },
        },
      }, runWith),
    },
  };
  const cli = loadCli(SCRIPT, { requires, argv });
  let exitCode = 0;
  try {
    await cli.main();
  } catch (err) {
    if (typeof err.exitCode !== 'number') throw err;
    exitCode = err.exitCode;
  }
  const sdk = events.find((e) => e.type === 'sdk');
  return {
    events,
    emitted,
    emitOptions,
    exitCode,
    stderr: cli.stderrText(),
    stdout: cli.stdoutText(),
    payload: emitted.length ? emitted[0].payload : undefined,
    workspaceDir: sdk && sdk.cfg.workspaceStorage.dir,
    terms: events.filter((e) => e.type === 'findTables').map((e) => e.term),
    options: events.filter((e) => e.type === 'findTables').map((e) => e.options),
  };
}
const names = (r) => r.payload.tables.map((t) => t.logicalName);

// --- the command line ------------------------------------------------------------------------------------------

test('a usage error prints nothing on stdout, names the flag and the usage on stderr, and reads nothing', async () => {
  const cases = [
    [[], /--env is required/],
    [['--envv', ENV], /unknown flag\(s\): --envv \(did you mean --env\?\)/],
    [['--env'], /--env requires a value/],
    [['--env', ENV, '--search'], /--search requires a value/],
    [['--env', ENV, '--search', 'a', '--exact', 'account'], /--exact takes no value \(got 'account'\)/],
    [['--env', ENV, '--exact=true', '--search', 'a'], /--exact takes no value \(got 'true'\)/],
    [['--env', ENV, '--exact'], /--exact needs --search/],
    [['--env', ENV, '--search', ' , ,'], /--search ' , ,' names no table/],
    [['--env', ENV, '--type'], /--type requires a value — custom, standard or all/],
    [['--env', ENV, '--type='], /--type requires a value — custom, standard or all/],
    [['--env', ENV, '--type', 'everything'], /--type must be custom, standard or all \(got 'everything'\)/],
    [['--env', ENV, '--type', 'custom,standard'], /--type must be custom, standard or all \(got 'custom,standard'\)/],
    [['--env', ENV, 'extra'], /unexpected argument 'extra'/],
  ];
  for (const [argv, message] of cases) {
    const r = await run(argv);
    assert.strictEqual(r.exitCode, 1, argv.join(' '));
    assert.strictEqual(r.stdout, '', `${argv.join(' ')}: nothing on stdout`);
    assert.match(r.stderr, message, argv.join(' '));
    assert.match(r.stderr, /Usage: node scripts\/list-tables\.js --env <envUrl> \[--search "<term>\[,<term>\.\.\.\]"\] \[--exact\]/);
    assert.deepStrictEqual(r.events, [], `${argv.join(' ')}: no client, no SDK`);
    assert.deepStrictEqual(r.emitted, []);
  }
});

test('an --env that is not a Dataverse https origin is refused before any token or SDK exists', async () => {
  for (const env of ['https://example.com', 'http://contoso.crm.dynamics.com', 'https://contoso.crm.dynamics.com/api/data/v9.2', 'contoso.crm.dynamics.com']) {
    const r = await run(['--env', env]);
    assert.strictEqual(r.exitCode, 1, env);
    assert.strictEqual(r.stdout, '', env);
    assert.match(r.stderr, /is not a Dataverse environment URL/, env);
    assert.deepStrictEqual(r.events, [], `${env}: no client, no SDK`);
  }
});

test('searchTerms splits on commas, trims, drops empty pieces, and keeps a term given twice (in any letter case) once, in order', () => {
  const { searchTerms } = require('../list-tables.js');
  assert.deepStrictEqual(searchTerms('incident,contact'), ['incident', 'contact']);
  assert.deepStrictEqual(searchTerms(' Account , ACCOUNT, ,contact,account '), ['Account', 'contact']);
  assert.deepStrictEqual(searchTerms('Support Ticket,cr_ticket'), ['Support Ticket', 'cr_ticket'], 'a term can hold a space');
  assert.deepStrictEqual(searchTerms(',,'), []);
  assert.deepStrictEqual(searchTerms('a'), ['a']);
});

test('the script is a CLI only when run directly, and exports the read and the term splitter for the real-bundle test', () => {
  const mod = require('../list-tables.js');
  assert.deepStrictEqual(Object.keys(mod).sort(), ['readTables', 'searchTerms']);
});

// --- reading -----------------------------------------------------------------------------------------------------

test('no --search lists every table in one read of the SDK, as pac\u2019s four columns, and prints no search, exact or missing', async () => {
  const r = await run(['--env', 'https://Contoso.CRM.dynamics.com/']);
  assert.strictEqual(r.exitCode, 0, r.stderr);
  assert.deepStrictEqual(r.events.map((e) => e.type), ['client', 'sdk', 'findTables'], 'one client, one SDK, one read');
  assert.strictEqual(r.events[0].env, ENV, 'the client is built for the origin, lower-cased and without the slash');
  assert.strictEqual(r.events[1].cfg.instanceUrl, ENV);
  assert.strictEqual(r.events[1].cfg.httpClient.marker, 'az-client');
  assert.deepStrictEqual(r.terms, [undefined], 'asked for every table, not for the empty term');
  assert.deepStrictEqual(Object.keys(r.payload), ['ok', 'count', 'tables']);
  assert.strictEqual(r.payload.count, TABLES.length);
  assert.deepStrictEqual(r.payload.tables[0], { logicalName: 'account', displayName: 'Account', schemaName: 'Account', isCustom: false });
  assert.deepStrictEqual(Object.keys(r.payload.tables[0]), ['logicalName', 'displayName', 'schemaName', 'isCustom'], 'pac\u2019s columns, no entity set name');
  assert.strictEqual(r.payload.tables.find((t) => t.logicalName === 'msdyn_msdyn_warranty_account').displayName, '', 'a table with no display name has an empty one');
  assert.strictEqual(r.payload.tables.find((t) => t.logicalName === 'cr_ticket').isCustom, true);
  assert.deepStrictEqual(r.emitOptions, [{ ascii: true }], 'pure ASCII on stdout');
  assert.strictEqual(r.stderr, '');
});

test('a term is searched as findTables searches: a substring of the logical, schema or display name, so `account` also finds accountleads', async () => {
  const r = await run(['--env', ENV, '--search', 'account']);
  assert.deepStrictEqual(names(r), ['account', 'accountleads', 'msdyn_accountkpiitem', 'msdyn_msdyn_warranty_account']);
  assert.deepStrictEqual(r.payload.search, ['account']);
  assert.strictEqual(r.payload.exact, undefined);
  assert.strictEqual(r.payload.missing, undefined);
  const display = await run(['--env', ENV, '--search', 'support ticket']);
  assert.deepStrictEqual(names(display), ['cr_ticket'], 'by display name, any letter case');
});

test('several terms are each searched once, a few at a time, and the answers joined: a table once, in the order of the terms', async () => {
  const r = await run(['--env', ENV, '--search', 'incident, contact ,CONTACT, kpi,account']);
  assert.deepStrictEqual(r.terms, ['incident', 'contact', 'kpi', 'account'], 'the terms, trimmed and de-duplicated, one read each');
  assert.deepStrictEqual(names(r), ['incident', 'contact', 'msdyn_accountkpiitem', 'account', 'accountleads', 'msdyn_msdyn_warranty_account'],
    'kpi\u2019s table is listed under kpi and is not listed again under account');
  assert.strictEqual(r.payload.count, 6);
  assert.deepStrictEqual(r.payload.search, ['incident', 'contact', 'kpi', 'account']);
});

test('terms are read at most four at a time — and four really are — and the answers are joined in the order of the terms, whichever read finishes first', async () => {
  const terms = ['account', 'contact', 'incident', 'kpi', 'ticket', 'note', 'warranty', 'lead', 'task', 'case'];
  let inFlight = 0;
  let maxInFlight = 0;
  const finished = [];
  const find = async (term) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    // The earlier a term is in the list, the longer its read takes, so the answers of the first four come back in reverse.
    await new Promise((resolve) => setTimeout(resolve, 5 * (terms.length - terms.indexOf(term))));
    inFlight -= 1;
    finished.push(term);
    return findTables(term);
  };
  const r = await run(['--env', ENV, '--search', terms.join(',')], find);
  assert.strictEqual(r.exitCode, 0, r.stderr);
  assert.strictEqual(maxInFlight, 4, 'the bound, reached and not passed');
  assert.deepStrictEqual([...r.terms].sort(), [...terms].sort(), 'every term is read, once');
  const expected = [];
  for (const term of terms) for (const t of findTables(term)) if (!expected.includes(t.logicalName)) expected.push(t.logicalName);
  assert.deepStrictEqual(names(r), expected, 'in the order of the terms');
  assert.notDeepStrictEqual(finished.slice(0, 4), terms.slice(0, 4), 'premise: the first four reads did not finish in the order of the terms');
});

test('--exact reads the whole list once, whatever the number of terms, and never searches by term: the SDK\u2019s substring rule is not used for it', async () => {
  const everyTable = async (term) => { if (term !== undefined) throw new Error(`searched by term '${term}'`); return TABLES; };
  const r = await run(['--env', ENV, '--search', 'cr_ticket,ACCOUNT,incident,cr_candidate', '--exact'], everyTable);
  assert.strictEqual(r.exitCode, 0, r.stderr);
  assert.deepStrictEqual(r.terms, [undefined], 'one read, for every table');
  assert.deepStrictEqual(names(r), ['cr_ticket', 'account', 'incident'], 'in the order of the terms, not the platform\u2019s');
  assert.deepStrictEqual(r.payload.missing, ['cr_candidate']);
  assert.deepStrictEqual(r.payload.search, ['cr_ticket', 'ACCOUNT', 'incident', 'cr_candidate']);
});

test('--exact keeps only the tables whose logical name is a term, in any letter case, and names the terms no table has', async () => {
  const r = await run(['--env', ENV, '--search', 'account,Contact,CR_TICKET,cr_candidate', '--exact']);
  assert.strictEqual(r.exitCode, 0);
  assert.deepStrictEqual(names(r), ['account', 'contact', 'cr_ticket'], '`account` does not bring accountleads');
  assert.deepStrictEqual(r.payload.missing, ['cr_candidate']);
  assert.strictEqual(r.payload.exact, true);
  assert.strictEqual(r.payload.count, 3);
  assert.deepStrictEqual(Object.keys(r.payload), ['ok', 'search', 'exact', 'count', 'tables', 'missing']);
  const none = await run(['--env', ENV, '--search', 'nothing', '--exact']);
  assert.deepStrictEqual([none.payload.count, none.payload.tables, none.payload.missing, none.exitCode], [0, [], ['nothing'], 0], 'no match is an answer, not a failure');
  const partial = await run(['--env', ENV, '--search', 'ticket', '--exact']);
  assert.deepStrictEqual([names(partial), partial.payload.missing], [[], ['ticket']], 'part of a name is not the name: the planner\u2019s "exact equality"');
});

test('without --exact nothing is reported missing, even for a term that matched nothing', async () => {
  const r = await run(['--env', ENV, '--search', 'nothing']);
  assert.deepStrictEqual([r.payload.count, r.payload.tables, r.payload.missing, r.payload.exact], [0, [], undefined, undefined]);
});

// --- --type ------------------------------------------------------------------------------------------------------------

test('--type custom is the SDK\u2019s own option, findTables(term, { customOnly: true }): the script asks for the custom tables and does not filter a full list itself', async () => {
  const r = await run(['--env', ENV, '--type', 'custom']);
  assert.strictEqual(r.exitCode, 0, r.stderr);
  assert.deepStrictEqual(r.terms, [undefined], 'one read, for every table');
  assert.deepStrictEqual(r.options, [{ customOnly: true }], 'with the SDK\u2019s option');
  assert.deepStrictEqual(names(r), ['cr_ticket', 'msdyn_accountkpiitem', 'msdyn_msdyn_warranty_account', 'new_note']);
  assert.ok(r.payload.tables.every((t) => t.isCustom));
  assert.strictEqual(r.payload.type, 'custom');
  assert.deepStrictEqual(Object.keys(r.payload), ['ok', 'type', 'count', 'tables']);
  // What the SDK answers is what is printed: a table the SDK answers for `customOnly` is listed, so the script adds no rule of its own.
  const asked = await run(['--env', ENV, '--type', 'custom'], async () => [table('whatever', 'Whatever', 'Whatever', false)]);
  assert.deepStrictEqual(names(asked), ['whatever']);
});

test('--type standard has no SDK option, so the SDK is asked for every table and the ones it does not flag as custom are kept', async () => {
  const r = await run(['--env', ENV, '--type', 'standard']);
  assert.deepStrictEqual(r.terms, [undefined]);
  assert.deepStrictEqual(r.options, [undefined], 'no option: the SDK has none for this');
  assert.deepStrictEqual(names(r), ['account', 'accountleads', 'contact', 'incident']);
  assert.ok(r.payload.tables.every((t) => t.isCustom === false));
  assert.strictEqual(r.payload.type, 'standard');
});

test('--type all, and no --type, list every table; the type is in the answer only when it was asked for, in any letter case', async () => {
  const none = await run(['--env', ENV]);
  assert.ok(!('type' in none.payload));
  assert.deepStrictEqual(none.options, [undefined]);
  for (const given of ['all', 'ALL', ' All ']) {
    const r = await run(['--env', ENV, '--type', given]);
    assert.deepStrictEqual(names(r), names(none), given);
    assert.deepStrictEqual(r.options, [undefined], `${given}: no filter at all`);
    assert.strictEqual(r.payload.type, 'all', given);
  }
  for (const given of ['CUSTOM', ' Custom ']) {
    const r = await run(['--env', ENV, '--type', given]);
    assert.strictEqual(r.payload.type, 'custom', given);
    assert.deepStrictEqual(r.options, [{ customOnly: true }], given);
  }
  assert.strictEqual((await run(['--env', ENV, '--type=Standard'])).payload.type, 'standard', 'the equals form too');
});

test('--type applies to every term of a search, and the answers are joined as without it', async () => {
  const custom = await run(['--env', ENV, '--search', 'account,ticket,incident', '--type', 'custom']);
  assert.deepStrictEqual(custom.terms, ['account', 'ticket', 'incident']);
  assert.deepStrictEqual(custom.options, [{ customOnly: true }, { customOnly: true }, { customOnly: true }], 'each read is the SDK\u2019s custom-only read');
  assert.deepStrictEqual(names(custom), ['msdyn_accountkpiitem', 'msdyn_msdyn_warranty_account', 'cr_ticket'], '`account` brings no standard table; `incident` is standard and brings none');
  assert.deepStrictEqual(Object.keys(custom.payload), ['ok', 'search', 'type', 'count', 'tables']);
  const standard = await run(['--env', ENV, '--search', 'account,ticket,incident', '--type', 'standard']);
  assert.deepStrictEqual(names(standard), ['account', 'accountleads', 'incident']);
  assert.deepStrictEqual(standard.options, [undefined, undefined, undefined]);
});

test('--exact with --type reads the list once, of that type, and a term naming a table of the other type is missing', async () => {
  const custom = await run(['--env', ENV, '--search', 'account,cr_ticket,incident', '--exact', '--type', 'custom']);
  assert.deepStrictEqual(custom.terms, [undefined], 'one read');
  assert.deepStrictEqual(custom.options, [{ customOnly: true }]);
  assert.deepStrictEqual(names(custom), ['cr_ticket']);
  assert.deepStrictEqual(custom.payload.missing, ['account', 'incident'], 'both are tables, of the other kind');
  assert.deepStrictEqual(Object.keys(custom.payload), ['ok', 'search', 'exact', 'type', 'count', 'tables', 'missing']);
  const standard = await run(['--env', ENV, '--search', 'account,cr_ticket,incident', '--exact', '--type', 'standard']);
  assert.deepStrictEqual(names(standard), ['account', 'incident']);
  assert.deepStrictEqual(standard.payload.missing, ['cr_ticket']);
  const all = await run(['--env', ENV, '--search', 'account,cr_ticket,incident', '--exact', '--type', 'all']);
  assert.deepStrictEqual([names(all), all.payload.missing], [['account', 'cr_ticket', 'incident'], []]);
});

test('--type with a read the SDK refuses fails as any read does', async () => {
  const refused = Object.assign(new Error('HTTP 403 from …/EntityDefinitions'), { code: 'CONNECTION_ERROR' });
  const r = await run(['--env', ENV, '--type', 'custom'], async () => { throw refused; });
  assert.strictEqual(r.exitCode, 1);
  assert.deepStrictEqual(r.emitted, [{ ok: false, payload: { ok: false, error: refused.message, code: 'CONNECTION_ERROR' } }]);
});

test('readTables refuses a type that is none of the three when it is called directly: a caller\u2019s mistake is not read as "all"', async () => {
  const { readTables } = require('../list-tables.js');
  await assert.rejects(readTables(ENV, { type: 'Custom' }), /type must be custom, standard or all \(got 'Custom'\)/);
  await assert.rejects(readTables(ENV, { type: '' }), /type must be custom, standard or all/);
});

test('a name beyond ASCII is passed to emitResult as it is: the ASCII escaping is its job, and asked for', async () => {
  const r = await run(['--env', ENV, '--search', 'note']);
  assert.strictEqual(r.payload.tables[0].displayName, 'Caf\u00e9 notes');
  assert.deepStrictEqual(r.emitOptions, [{ ascii: true }]);
});

test('a table the SDK answers without a display name or a custom flag is listed with an empty display name and isCustom false — the columns are always there', async () => {
  const same = [{ logicalName: 'plain', displayName: '', schemaName: 'Plain', isCustom: false }];
  const bare = await run(['--env', ENV], async () => [{ logicalName: 'plain', schemaName: 'Plain' }]);
  assert.deepStrictEqual(bare.payload.tables, same);
  const nulls = await run(['--env', ENV], async () => [{ logicalName: 'plain', schemaName: 'Plain', displayName: null, isCustom: null }]);
  assert.deepStrictEqual(nulls.payload.tables, same);
});

test('--exact compares logical names without regard to letter case, on the table\u2019s side too', async () => {
  const r = await run(['--env', ENV, '--search', 'Account', '--exact'], async () => [{ logicalName: 'ACCOUNT', schemaName: 'Account', displayName: 'Account', isCustom: false }]);
  assert.deepStrictEqual(names(r), ['ACCOUNT']);
  assert.deepStrictEqual(r.payload.missing, []);
});

test('a failed read exits 1 with the SDK\u2019s own code and message — and no table list, however many terms had been read', async () => {
  const refused = Object.assign(new Error('HTTP 403 from https://contoso.crm.dynamics.com/api/data/v9.0/EntityDefinitions: not a member of the organization'), { code: 'CONNECTION_ERROR', statusCode: 403 });
  const second = await run(['--env', ENV, '--search', 'account,contact'], async (term) => { if (term === 'contact') throw refused; return findTables(term); });
  assert.strictEqual(second.exitCode, 1);
  assert.deepStrictEqual(second.emitted, [{ ok: false, payload: { ok: false, error: refused.message, code: 'CONNECTION_ERROR' } }], 'the first term\u2019s answer is not printed as if it were the whole');
  const plain = await run(['--env', ENV], async () => { throw new Error('boom'); });
  assert.deepStrictEqual(plain.emitted, [{ ok: false, payload: { ok: false, error: 'boom' } }], 'a failure with no SDK code carries no code field');
  assert.deepStrictEqual(plain.emitOptions, [{ ascii: true }]);
});

test('after a failed read nothing new is started: of ten terms, the four reads that were already running are all there is', async () => {
  const terms = ['account', 'contact', 'incident', 'kpi', 'ticket', 'note', 'warranty', 'lead', 'task', 'case'];
  const started = [];
  const r = await run(['--env', ENV, '--search', terms.join(',')], async (term) => {
    started.push(term);
    if (term === 'account') throw Object.assign(new Error('refused'), { code: 'CONNECTION_ERROR' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    return findTables(term);
  });
  assert.strictEqual(r.exitCode, 1);
  assert.deepStrictEqual(r.emitted, [{ ok: false, payload: { ok: false, error: 'refused', code: 'CONNECTION_ERROR' } }]);
  // The run ends at the first failure; the three reads still running finish on their own, and each would start another term if the failure did not stop them.
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.deepStrictEqual(started, ['account', 'contact', 'incident', 'kpi']);
});

test('the throwaway workspace is removed after a read, and after a failed one', async () => {
  const ok = await run(['--env', ENV, '--search', 'account']);
  assert.ok(ok.workspaceDir, 'the SDK was given a workspace directory');
  assert.strictEqual(fs.existsSync(ok.workspaceDir), false, 'removed after a read');
  const bad = await run(['--env', ENV], async () => { throw new Error('boom'); });
  assert.strictEqual(fs.existsSync(bad.workspaceDir), false, 'removed after a failed read');
});
