'use strict';
// scripts/apps.js end to end through its main(): flags, the origin check, the reads, every refusal before the first write, the writes in
// their order, the failures after the first write, and the throwaway workspace — with the SDK and the HTTP client stubbed. The real bundle
// and the real HTTP client, over a fake Dataverse, are driven in apps-real-bundle.test.js.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { loadCli } = require('./helpers/cli-harness.js');
const realAuth = require('../lib/dataverse-auth.js');
const { withThrowawaySdk } = require('../lib/throwaway-sdk.js');

const SCRIPT = path.resolve(__dirname, '..', 'apps.js');
const ENV = 'https://contoso.crm.dynamics.com';
const PAGE_A = '0f8fad5b-d9cb-469f-a165-70867728950e';
const PAGE_B = '1f8fad5b-d9cb-469f-a165-70867728950e';
const APP_ID = '22222222-2222-4222-8222-222222222222';
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DEFAULT_ICON = '953b9fac-1e5e-e611-80d6-00155ded156f';

const solution = (overrides = {}) => ({ solutionid: '11111111-1111-4111-8111-111111111111', uniquename: 'ContosoCore', friendlyname: 'Contoso Core', ismanaged: false, ...overrides });
// What the platform holds: the solutions, the pages (id -> stored name), the apps (one row per layer) and sitemaps, and the base language
// (`null`: the organization answers no row). An app row is published when its `published` says so, by default when its componentstate is 0.
// `push` and `publishResult` are what the SDK answers to the app's push and publish.
const world = (overrides = {}) => ({
  solutions: [solution()],
  pages: { [PAGE_A]: 'Overview', [PAGE_B]: 'Details' },
  apps: [],
  sitemaps: [],
  language: 1033,
  push: { type: 'app', id: APP_ID, saved: true, shipped: false, publish: { kind: 'notRequested' } },
  publishResult: { type: 'app', id: APP_ID, shipped: false, publish: { kind: 'submitted' } },
  ...overrides,
});
const appRow = (overrides = {}) => ({ appmoduleid: '77777777-7777-4777-8777-777777777777', name: 'Contoso Sales', uniquename: 'contoso_sales', description: null, componentstate: 0, ...overrides });
const isPublished = (app) => (app.published === undefined ? app.componentstate === 0 : Boolean(app.published));

// Runs main() with `argv`. `hooks` may replace what the SDK answers to a write (a function of the call, which may throw): createArtifact,
// pushArtifact, addSolutionComponent, publishArtifact; `hooks.afterPush(added, { type, id, def })` runs after the push, whichever way it went, and may
// change the rows the platform now holds (`added.apps`, `added.sitemaps`): a push that threw leaves nothing, as the SDK rolls it back, unless a test
// says what the rollback left; `hooks.makeSdk(cfg, index)` runs as each SDK is made, and may throw; `hooks.read(path)` runs before each read of
// the SDK's Dataverse client and may throw, which is how a read fails. `deps` replaces what the throwaway-SDK helper builds the SDK from
// (`makerSdk`). The helper itself — the folder, its removal, one client for every instance — is the real one (lib/throwaway-sdk.js); only the SDK and
// the client it makes are stubs. The stubbed emitResult ends the run the way the real one does (process.exit).
async function run(argv, w = world(), hooks = {}, deps = {}) {
  const events = [];
  const emitted = [];
  const emitOptions = [];
  const instances = [];
  const held = [];
  // The rows this run's writes added to the platform, and the apps and site maps it holds now. `w.apps` is read when it is asked for, not before.
  const added = { apps: [], sitemaps: [] };
  const appsNow = () => [...w.apps, ...added.apps];
  const sitemapsNow = () => [...w.sitemaps, ...added.sitemaps];
  let createdDef;
  const answer = (value) => ({ status: 200, headers: {}, body: { value } });
  const named = (rows, p) => {
    const name = /uniquename eq '([^']*)'/.exec(p);
    return name ? rows.filter((a) => a.uniquename.toLowerCase() === name[1].toLowerCase()) : rows;
  };
  const makeSdk = (cfg) => {
    const index = instances.length;
    events.push({ type: 'sdk', index, cfg });
    if (hooks.makeSdk) hooks.makeSdk(cfg, index);
    const read = (what, detail) => events.push({ type: 'read', what, detail, sdk: index });
    const write = (what, detail) => events.push({ type: 'write', what, detail, sdk: index });
    const sdk = {
      dataverse: {
        get: async (p) => {
          read(p);
          if (hooks.read) hooks.read(p);
          if (/^\/appmodules\/Microsoft\.Dynamics\.CRM\.RetrieveUnpublishedMultiple\(\)/.test(p)) return answer(named(appsNow(), p));
          // The published layer: a draft is not in it. `w.publishedRows` replaces the answer, for a row the platform would never send.
          if (/^\/appmodules\?/.test(p)) return answer(w.publishedRows || named(appsNow(), p).filter(isPublished).map((a) => ({ appmoduleid: a.appmoduleid })));
          if (/^\/uxagentprojects\/Microsoft\.Dynamics\.CRM\.RetrieveUnpublishedMultiple\(\)/.test(p)) {
            const wanted = [...p.matchAll(/uxagentprojectid eq ([0-9a-f-]{36})/gi)].map((m) => m[1].toLowerCase());
            return answer(wanted.filter((id) => id in w.pages).map((id) => ({ uxagentprojectid: id, name: w.pages[id], componentstate: 0 })));
          }
          if (/^\/sitemaps\/Microsoft\.Dynamics\.CRM\.RetrieveUnpublishedMultiple\(\)/.test(p)) {
            const name = /sitemapnameunique eq '([^']*)'/.exec(p);
            return answer(sitemapsNow().filter((s) => name && s.sitemapnameunique.toLowerCase() === name[1].toLowerCase()));
          }
          throw new Error(`unexpected read ${p}`);
        },
      },
      queryRecords: async (entity, opts) => {
        read(`queryRecords ${entity}`, opts);
        if (entity === 'solution') {
          const name = /uniquename eq '([^']*)'/.exec(opts.filter);
          return w.solutions.filter((s) => name && s.uniquename.toLowerCase() === name[1].toLowerCase());
        }
        if (entity === 'organization') return w.language === null ? [] : [{ languagecode: w.language }];
        throw new Error(`unexpected queryRecords ${entity}`);
      },
      resolveArtifact: async (type, identity) => {
        read(`resolveArtifact ${type}`, identity);
        return appsNow().filter((a) => a.uniquename.toLowerCase() === identity.uniqueName.toLowerCase()).map((a) => ({ id: a.appmoduleid, name: a.name, appModuleIdUnique: a.appmoduleid }));
      },
      initWorkspace: async () => { write('initWorkspace'); },
      createArtifact: async (type, def) => {
        write('createArtifact', { type, def });
        createdDef = def;
        return hooks.createArtifact ? await hooks.createArtifact({ type, def }) : { id: APP_ID, ...def };
      },
      pushArtifact: async (type, id) => {
        write('pushArtifact', { type, id });
        let result;
        let thrown;
        try {
          result = hooks.pushArtifact ? hooks.pushArtifact({ type, id }) : w.push;
        } catch (err) {
          thrown = err;
        }
        // What the platform holds after a push the SDK saved: the app's draft row and its sitemap, under the unique name the script chose.
        if (!thrown && result && result.saved !== false) {
          added.apps.push({ appmoduleid: (result && result.id) || id, name: createdDef.name, uniquename: createdDef.uniqueName, description: createdDef.description || null, componentstate: 1 });
          added.sitemaps.push({ sitemapid: createdDef.sitemapId, sitemapnameunique: createdDef.uniqueName });
        }
        if (hooks.afterPush) hooks.afterPush(added, { type, id, def: createdDef });
        if (thrown) throw thrown;
        return result;
      },
      addSolutionComponent: async (options) => {
        write('addSolutionComponent', options);
        if (hooks.addSolutionComponent) await hooks.addSolutionComponent(options);
        // What the platform now holds: only a call that did not throw gets this far.
        held.push({ componentId: options.componentId, componentType: options.componentType, solution: options.solutionUniqueName });
      },
      publishArtifact: async (type, id) => {
        write('publishArtifact', { type, id });
        const result = hooks.publishArtifact ? hooks.publishArtifact({ type, id, added }) : w.publishResult;
        const kind = result && result.publish && result.publish.kind;
        if (kind === 'submitted' || kind === 'verified') {
          for (const app of added.apps) if (app.appmoduleid === id) Object.assign(app, { componentstate: 0, published: true });
        }
        return result;
      },
    };
    instances.push(sdk);
    return sdk;
  };
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
    './lib/throwaway-sdk.js': {
      withThrowawaySdk: (options, runWith) => withThrowawaySdk({
        ...options,
        deps: {
          makerSdk: { createNodeWorkspaceStorage: (dir) => ({ dir }), createMakerSdk: makeSdk },
          createAzHttpClient: (env) => { events.push({ type: 'client', env }); return { marker: 'az-client', env }; },
          ...deps,
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
  const writes = events.filter((e) => e.type === 'write');
  const created = writes.find((e) => e.what === 'createArtifact');
  return {
    events,
    emitted,
    emitOptions,
    exitCode,
    instances,
    held,
    added,
    writes,
    writeNames: writes.map((e) => e.what),
    stderr: cli.stderrText(),
    stdout: cli.stdoutText(),
    workspaceDirs: events.filter((e) => e.type === 'sdk').map((e) => e.cfg.workspaceStorage.dir),
    payload: emitted.length ? emitted[0].payload : undefined,
    def: created && created.detail.def,
  };
}

const CREATE = ['create', '--env', ENV, '--name', 'Account Metrics', '--solution', 'ContosoCore', '--page-id', PAGE_A];
const without = (argv, flag) => { const i = argv.indexOf(flag); return i === -1 ? argv : [...argv.slice(0, i), ...argv.slice(i + 2)]; };

// --- the command line ------------------------------------------------------------------------------------------

test('no command, or one that is not list or create, is a usage error: nothing is read, nothing is printed on stdout', async () => {
  for (const [argv, message] of [[[], /a command is required: list or create/], [['delete', '--env', ENV], /unknown command 'delete'/], [['toString', '--env', ENV], /unknown command 'toString'/]]) {
    const r = await run(argv);
    assert.strictEqual(r.exitCode, 1, argv.join(' '));
    assert.strictEqual(r.stdout, '');
    assert.match(r.stderr, message);
    assert.match(r.stderr, /Usage:\n {2}node scripts\/apps\.js list --env <envUrl>/);
    assert.deepStrictEqual(r.events, [], 'no client, no SDK');
    assert.deepStrictEqual(r.emitted, []);
  }
});

test('an unknown flag, or a flag that needs a value and has none, is refused naming the flag, before anything runs', async () => {
  const cases = [
    [['list', '--envv', ENV], /unknown flag\(s\): --envv \(did you mean --env\?\)/],
    [['list', '--env'], /--env requires a value/],
    [['list', '--env', ENV, '--search'], /--search requires a value/],
    [[...CREATE, '--page-id'], /--page-id requires a value/],
    [[...CREATE, '--description', ''], /--description requires a value/],
    [['create', '--env', ENV, '--name', '--solution', 'S', '--page-id', PAGE_A], /--name requires a value/],
    [['create', '--env', ENV, '--name', 'A', '--solution', '--page-id', PAGE_A], /--solution requires a value/],
    [[...CREATE, '--unique-name'], /--unique-name requires a value/],
    [['create', '--env', '--name', 'A', '--solution', 'S', '--page-id', PAGE_A], /--env requires a value/],
    [[...CREATE, '--unique-nam', 'x'], /unknown flag\(s\): --unique-nam \(did you mean --unique-name\?\)/],
    [['create', '--env', ENV, '--name', 'A', '--solution', 'S', '--page-id', PAGE_A, '--page-id', '--publish'], /--page-id requires a value/],
    [['create', '--env', ENV, '--name', 'A', '--solution', 'S', '--page-id', '--page-id', PAGE_A], /--page-id requires a value/],
    [['create', '--env', ENV, '--name', 'A', '--solution', 'S', `--page-id=${PAGE_A}`, '--page-id='], /--page-id requires a value/],
    [['list', '--env', ENV, 'extra'], /unexpected argument 'extra'/],
  ];
  for (const [argv, message] of cases) {
    const r = await run(argv);
    assert.strictEqual(r.exitCode, 1, argv.join(' '));
    assert.strictEqual(r.stdout, '', `${argv.join(' ')}: nothing on stdout`);
    assert.match(r.stderr, message, argv.join(' '));
    assert.deepStrictEqual(r.events, [], `${argv.join(' ')}: no client, no SDK`);
  }
});

test('--publish is a bare flag: a value is refused, since parseArgs would take the next word for it and publish nothing', async () => {
  for (const argv of [[...CREATE, '--publish', 'yes'], [...CREATE, '--publish=false'], [...CREATE, '--publish', 'true']]) {
    const r = await run(argv);
    assert.strictEqual(r.exitCode, 1, argv.join(' '));
    assert.match(r.stderr, /--publish takes no value \(got '(yes|false|true)'\)/);
    assert.deepStrictEqual(r.events, []);
  }
});

test('--env must be a Dataverse https origin, and --name and --solution are required: refused before any token or SDK exists', async () => {
  for (const env of ['https://example.com', 'http://contoso.crm.dynamics.com', 'https://contoso.crm.dynamics.com/api/data/v9.2', 'contoso.crm.dynamics.com']) {
    const r = await run(['list', '--env', env]);
    assert.strictEqual(r.exitCode, 1, env);
    assert.strictEqual(r.stdout, '');
    assert.match(r.stderr, /is not a Dataverse environment URL/, env);
    assert.deepStrictEqual(r.events, [], `${env}: no client, no SDK`);
  }
  assert.match((await run(['list'])).stderr, /--env is required/);
  assert.match((await run(without(CREATE, '--name'))).stderr, /--name is required/);
  assert.match((await run(without(CREATE, '--solution'))).stderr, /--solution is required/);
  const noPages = await run(without(CREATE, '--page-id'));
  assert.strictEqual(noPages.exitCode, 1);
  assert.deepStrictEqual(noPages.events, [], 'a missing --page-id is a refusal, decided before the environment is asked');
});

test('pageIdArguments reads every occurrence — repeated, with an equals sign, or comma-separated — which parseArgs would keep only the last of', () => {
  const { pageIdArguments } = require('../apps.js');
  assert.deepStrictEqual(pageIdArguments(['create', '--page-id', 'a', '--name', 'x', '--page-id', 'b']), { ids: ['a', 'b'] });
  assert.deepStrictEqual(pageIdArguments(['--page-id=a', '--page-id', 'b,c', '--page-id= d , e ']), { ids: ['a', 'b', 'c', 'd', 'e'] });
  assert.deepStrictEqual(pageIdArguments(['create']), { ids: [] });
  assert.deepStrictEqual(pageIdArguments(['--page-id', 'a,,b,']), { ids: ['a', 'b'] }, 'an empty piece of a list is no id');
  for (const argv of [['--page-id'], ['--page-id', '--name', 'x'], ['--page-id=', '--page-id', 'a'], ['--page-id', ' ']]) {
    assert.deepStrictEqual(pageIdArguments(argv), { problem: '--page-id requires a value' }, argv.join(' '));
  }
});

test('the script is a CLI only when run directly, and exports what the real-bundle tests drive', () => {
  const mod = require('../apps.js');
  assert.deepStrictEqual(Object.keys(mod).sort(), ['createApp', 'deriveUniqueName', 'listApps', 'pageIdArguments']);
});

// --- list --------------------------------------------------------------------------------------------------------------

test('list reads the apps through the az-token client for the normalized origin — the saved layer, then the published one — writes nothing, and prints the apps sorted by name', async () => {
  const w = world({
    apps: [
      appRow({ appmoduleid: '00000000-0000-4000-8000-000000000003', name: 'zeta app', uniquename: 'zeta_app', componentstate: 1, description: 'Last one' }),
      appRow({ appmoduleid: '00000000-0000-4000-8000-000000000001', name: 'Alpha', uniquename: 'alpha', componentstate: 0 }),
      appRow({ appmoduleid: '00000000-0000-4000-8000-000000000002', name: 'beta', uniquename: 'cr_beta', componentstate: 0 }),
    ],
  });
  const r = await run(['list', '--env', 'https://Contoso.CRM.dynamics.com/'], w);
  assert.strictEqual(r.exitCode, 0, r.stderr);
  assert.deepStrictEqual(r.events.map((e) => e.type), ['client', 'sdk', 'read', 'read'], 'one client, one SDK, two reads');
  assert.strictEqual(r.events[0].env, ENV, 'the client is built for the origin, lower-cased and without the slash');
  assert.strictEqual(r.events[1].cfg.instanceUrl, ENV);
  assert.strictEqual(r.events[1].cfg.httpClient.marker, 'az-client');
  // The saved layer first, then the published one: an app published between the two reads is then published and has changes, never neither.
  assert.deepStrictEqual(r.events.filter((e) => e.type === 'read').map((e) => e.what), [
    '/appmodules/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()?$select=appmoduleid,name,uniquename,description,componentstate',
    '/appmodules?$select=appmoduleid',
  ]);
  assert.deepStrictEqual(r.writes, []);
  assert.deepStrictEqual(r.payload, {
    ok: true,
    count: 3,
    apps: [
      { id: '00000000-0000-4000-8000-000000000001', name: 'Alpha', uniqueName: 'alpha', description: '', published: true, unpublishedChanges: false },
      { id: '00000000-0000-4000-8000-000000000002', name: 'beta', uniqueName: 'cr_beta', description: '', published: true, unpublishedChanges: false },
      { id: '00000000-0000-4000-8000-000000000003', name: 'zeta app', uniqueName: 'zeta_app', description: 'Last one', published: false, unpublishedChanges: true },
    ],
  });
  assert.deepStrictEqual(r.emitOptions, [{ ascii: true }], 'pure ASCII on stdout');
  assert.strictEqual(r.stderr, '');
});

// What a real environment answered for each kind of app (RetrieveUnpublishedMultiple's rows, and whether the published layer holds a row): `published`
// and `unpublishedChanges` are two facts and each combination occurs. `pac model list` marked an app "(Saved - Not Published)" when its published row had no
// `publishedon`, which fits neither fact: a managed app a solution import brought in, which is live, had the mark, and a published app with a saved edit had none.
test('published and unpublishedChanges are two facts, and all four kinds of app measured on a real environment get their own pair', async () => {
  const draft = '00000000-0000-4000-8000-0000000000d1';
  const edited = '00000000-0000-4000-8000-0000000000d2';
  const plain = '00000000-0000-4000-8000-0000000000d3';
  const imported = '00000000-0000-4000-8000-0000000000d4';
  const w = world({
    apps: [
      appRow({ appmoduleid: draft, name: 'a draft', uniquename: 'a_draft', componentstate: 1 }),
      appRow({ appmoduleid: edited, name: 'b edited', uniquename: 'b_edited', componentstate: 1, published: true }),
      appRow({ appmoduleid: plain, name: 'c plain', uniquename: 'c_plain', componentstate: 0 }),
      appRow({ appmoduleid: imported, name: 'd imported', uniquename: 'msdyn_d_imported', componentstate: 0, published: true }),
    ],
  });
  const r = await run(['list', '--env', ENV], w);
  assert.deepStrictEqual(r.payload.apps.map((a) => [a.id, a.published, a.unpublishedChanges]), [
    [draft, false, true],
    [edited, true, true],
    [plain, true, false],
    [imported, true, false],
  ]);
  assert.ok(r.payload.apps.every((a) => !/Saved - Not Published/.test(a.name)), 'the mark is never part of a name');
});

test('list --search keeps the apps whose name or unique name holds the text, in any letter case', async () => {
  const w = world({ apps: [appRow({ name: 'Sales Hub', uniquename: 'msdyn_hub' }), appRow({ appmoduleid: '88888888-8888-4888-8888-888888888888', name: 'Field Ops', uniquename: 'cr_SALESops' }), appRow({ appmoduleid: '99999999-9999-4999-8999-999999999999', name: 'Support', uniquename: 'support' })] });
  const r = await run(['list', '--env', ENV, '--search', 'sales'], w);
  assert.deepStrictEqual(r.payload.apps.map((a) => a.name), ['Field Ops', 'Sales Hub']);
  assert.strictEqual(r.payload.count, 2);
  assert.strictEqual(r.payload.search, 'sales');
  const none = await run(['list', '--env', ENV, '--search', 'nothing here'], w);
  assert.deepStrictEqual(none.payload, { ok: true, search: 'nothing here', count: 0, apps: [] });
  assert.strictEqual(none.exitCode, 0, 'no match is an answer, not a failure');
});

test('apps are sorted by name whatever the letter case, and apps of one name by id', async () => {
  const w = world({
    apps: [
      appRow({ appmoduleid: '00000000-0000-4000-8000-000000000003', name: 'Banana', uniquename: 'banana' }),
      appRow({ appmoduleid: '00000000-0000-4000-8000-000000000002', name: 'apple', uniquename: 'apple_2' }),
      appRow({ appmoduleid: '00000000-0000-4000-8000-000000000001', name: 'apple', uniquename: 'apple_1' }),
    ],
  });
  const r = await run(['list', '--env', ENV], w);
  assert.deepStrictEqual(r.payload.apps.map((a) => a.uniqueName), ['apple_1', 'apple_2', 'banana']);
});

test('an app with a pending edit can answer two layers: the authored one (componentstate 1) is the app, it has unpublished changes, and it is still published', async () => {
  const id = '00000000-0000-4000-8000-0000000000aa';
  const w = world({ apps: [appRow({ appmoduleid: id, name: 'Contoso Sales', componentstate: 0 }), appRow({ appmoduleid: id.toUpperCase(), name: 'Contoso Sales (renamed)', componentstate: 1 })] });
  const r = await run(['list', '--env', ENV], w);
  assert.deepStrictEqual(r.payload.apps, [{ id, name: 'Contoso Sales (renamed)', uniqueName: 'contoso_sales', description: '', published: true, unpublishedChanges: true }]);
});

test('the authored layer is the app whichever of its two rows comes first — not the first, not the last', async () => {
  const id = '00000000-0000-4000-8000-0000000000bb';
  const authoredFirst = world({ apps: [appRow({ appmoduleid: id, name: 'Contoso Sales (renamed)', componentstate: 1 }), appRow({ appmoduleid: id, name: 'Contoso Sales', componentstate: 0 })] });
  const r = await run(['list', '--env', ENV], authoredFirst);
  assert.deepStrictEqual(r.payload.apps, [{ id, name: 'Contoso Sales (renamed)', uniqueName: 'contoso_sales', description: '', published: true, unpublishedChanges: true }]);
  // With the published row on both sides of the authored one, and with no authored one at all, the first row is the app.
  const between = world({ apps: [appRow({ appmoduleid: id, name: 'First', componentstate: 0 }), appRow({ appmoduleid: id, name: 'Authored', componentstate: 1 }), appRow({ appmoduleid: id, name: 'Last', componentstate: 0 })] });
  assert.strictEqual((await run(['list', '--env', ENV], between)).payload.apps[0].name, 'Authored');
  const none = world({ apps: [appRow({ appmoduleid: id, name: 'First', componentstate: 0 }), appRow({ appmoduleid: id, name: 'Last', componentstate: 0 })] });
  const unplaced = (await run(['list', '--env', ENV], none)).payload.apps[0];
  assert.deepStrictEqual([unplaced.name, unplaced.unpublishedChanges], ['First', false]);
});

test('a state the platform did not name leaves unpublishedChanges null, never guessed — a row with no state, a null one and an unknown one — and published is still the published layer\u2019s answer', async () => {
  const none = '88888888-8888-4888-8888-888888888888';
  const nullState = '99999999-9999-4999-8999-999999999999';
  const w = world({
    apps: [
      appRow({ componentstate: 2, published: true }),
      appRow({ appmoduleid: none, name: 'No state', uniquename: 'no_state', componentstate: undefined }),
      appRow({ appmoduleid: nullState, name: 'Null state', uniquename: 'null_state', componentstate: null, published: true }),
    ],
  });
  const r = await run(['list', '--env', ENV], w);
  assert.deepStrictEqual(r.payload.apps.map((a) => [a.name, a.published, a.unpublishedChanges]), [
    ['Contoso Sales', true, null],
    ['No state', false, null],
    ['Null state', true, null],
  ]);
});

test('list fails closed on a row with no id, and on a read the SDK refuses, with the SDK\u2019s own code and message', async () => {
  const noId = await run(['list', '--env', ENV], world({ apps: [{ name: 'No id' }] }));
  assert.strictEqual(noId.exitCode, 1);
  assert.strictEqual(noId.payload.ok, false);
  assert.match(noId.payload.error, /an app with no id, so the list cannot be trusted/);
  // The script's own failure, not the SDK's: it has no SDK code to carry.
  assert.deepStrictEqual(Object.keys(noId.payload).sort(), ['error', 'ok']);

  const refused = Object.assign(new Error('HTTP 403 from https://contoso.crm.dynamics.com/api/data/v9.0/appmodules: not a member'), { code: 'CONNECTION_ERROR', statusCode: 403 });
  const w = world();
  const r = await run(['list', '--env', ENV], { ...w, get apps() { throw refused; } });
  assert.strictEqual(r.exitCode, 1);
  assert.deepStrictEqual(r.payload, { ok: false, code: 'CONNECTION_ERROR', error: refused.message });
});

test('a published layer that cannot be read, or that answers a row with no id, fails the whole list — never apps that read as unpublished for want of it', async () => {
  const refused = Object.assign(new Error('the published apps: HTTP 403 from …/appmodules: not a member'), { code: 'CONNECTION_ERROR', statusCode: 403 });
  const w = world({ apps: [appRow()] });
  const unreadable = await run(['list', '--env', ENV], w, { read: (p) => { if (/^\/appmodules\?/.test(p)) throw refused; } });
  assert.strictEqual(unreadable.exitCode, 1);
  assert.deepStrictEqual(unreadable.payload, { ok: false, code: 'CONNECTION_ERROR', error: refused.message });
  const noId = await run(['list', '--env', ENV], world({ apps: [appRow()], publishedRows: [{ name: 'x' }] }));
  assert.strictEqual(noId.exitCode, 1);
  assert.match(noId.payload.error, /a published app with no id, so the list cannot be trusted/);
  assert.ok(!('code' in noId.payload), 'the script\u2019s own failure carries no SDK code');
});

// The two layers are matched by id, and an id is the same id in any letter case: the platform answers GUIDs in lower case from both endpoints, so nothing
// else holds the comparison in place.
test('the two layers of an app are matched by id whichever of them answers capitals', async () => {
  const id = '00000000-0000-4000-8000-0000000000ab';
  const publishedInCapitals = world({
    apps: [appRow({ appmoduleid: id, name: 'Edited', uniquename: 'edited', componentstate: 1, published: true })],
    publishedRows: [{ appmoduleid: id.toUpperCase() }],
  });
  const shown = (r) => r.payload.apps.map((a) => [a.id, a.published, a.unpublishedChanges]);
  assert.deepStrictEqual(shown(await run(['list', '--env', ENV], publishedInCapitals)), [[id, true, true]]);
  const savedInCapitals = world({
    apps: [appRow({ appmoduleid: id.toUpperCase(), name: 'Edited', uniquename: 'edited', componentstate: 1 })],
    publishedRows: [{ appmoduleid: id }],
  });
  assert.deepStrictEqual(shown(await run(['list', '--env', ENV], savedInCapitals)), [[id, true, true]], 'and the app is listed under its lower-case id');
});

// The saved layer is read first and the published one second (readApps), so an app deleted between the two reads is in the first answer, as published
// (componentstate 0), and absent from the second: neither published nor holding a saved change, which no app is. It is left out. The apps that are
// possible in the same window are listed: a draft, an app whose state the platform did not name, and an app that is published.
test('an app deleted between the list\u2019s two reads is left out, so no app is printed as neither published nor changed — and a draft, or an app of unknown state, is not', async () => {
  const gone = '00000000-0000-4000-8000-0000000000e1';
  const draft = '00000000-0000-4000-8000-0000000000e2';
  const unnamed = '00000000-0000-4000-8000-0000000000e3';
  const live = '00000000-0000-4000-8000-0000000000e4';
  const w = world({
    apps: [
      appRow({ appmoduleid: gone, name: 'a gone', uniquename: 'a_gone', componentstate: 0 }),
      appRow({ appmoduleid: draft, name: 'b draft', uniquename: 'b_draft', componentstate: 1 }),
      appRow({ appmoduleid: unnamed, name: 'c unnamed', uniquename: 'c_unnamed', componentstate: undefined }),
      appRow({ appmoduleid: live, name: 'd live', uniquename: 'd_live', componentstate: 0 }),
    ],
    publishedRows: [{ appmoduleid: live }],
  });
  const r = await run(['list', '--env', ENV], w);
  assert.deepStrictEqual(r.payload.apps.map((a) => [a.name, a.published, a.unpublishedChanges]), [['b draft', false, true], ['c unnamed', false, null], ['d live', true, false]]);
  assert.strictEqual(r.payload.count, 3, 'the count is of the apps listed');
  assert.ok(!r.payload.apps.some((a) => !a.published && a.unpublishedChanges === false), 'no app has neither fact');
  const searched = await run(['list', '--env', ENV, '--search', 'gone'], w);
  assert.deepStrictEqual(searched.payload, { ok: true, search: 'gone', count: 0, apps: [] });
});

test('the throwaway workspace is removed after a list, after one that failed, and after a create', async () => {
  const ok = await run(['list', '--env', ENV]);
  assert.strictEqual(ok.workspaceDirs.length, 1);
  assert.strictEqual(fs.existsSync(ok.workspaceDirs[0]), false, 'removed after a list');
  const bad = await run(['list', '--env', ENV], world({ apps: [{ name: 'No id' }] }));
  assert.strictEqual(fs.existsSync(bad.workspaceDirs[0]), false, 'removed after a failed list');
  const created = await run([...CREATE, '--publish']);
  assert.strictEqual(created.workspaceDirs.length, 2, 'a create makes two SDKs over one folder');
  assert.strictEqual(new Set(created.workspaceDirs).size, 1);
  assert.strictEqual(fs.existsSync(created.workspaceDirs[0]), false, 'removed after a create');
  const refused = await run([...CREATE, '--solution', 'Missing']);
  assert.strictEqual(fs.existsSync(refused.workspaceDirs[0]), false, 'removed after a refusal');
});

// --- create: the writes ------------------------------------------------------------------------------------------

test('create reads, then writes in order — the app and its sitemap, the app and the sitemap into the solution — and publishes only with --publish', async () => {
  const r = await run(CREATE, world({ language: 3082 }));
  assert.strictEqual(r.exitCode, 0, r.stderr);
  // Every read comes before the first write, and the reads are the ones the checks need.
  const firstWrite = r.events.findIndex((e) => e.type === 'write');
  assert.ok(r.events.slice(0, firstWrite).every((e) => e.type !== 'write'));
  assert.deepStrictEqual(r.events.filter((e) => e.type === 'read').map((e) => e.what.replace(/\?.*$/, '')), [
    'queryRecords solution',
    '/uxagentprojects/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()',
    'resolveArtifact app',
    '/sitemaps/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()',
    'queryRecords organization',
  ]);
  assert.deepStrictEqual(r.writeNames, ['initWorkspace', 'createArtifact', 'pushArtifact', 'addSolutionComponent', 'addSolutionComponent']);
  assert.ok(!r.writeNames.includes('publishArtifact'), 'no publish without --publish');

  // Two SDKs over one workspace: the first reads, in no particular language; the second writes, in the environment's base language.
  assert.strictEqual(r.instances.length, 2);
  const [reader, writer] = r.events.filter((e) => e.type === 'sdk').map((e) => e.cfg);
  assert.strictEqual(reader.languageCode, undefined);
  assert.strictEqual(writer.languageCode, 3082);
  assert.strictEqual(reader.workspaceStorage.dir, writer.workspaceStorage.dir);
  assert.strictEqual(r.events.filter((e) => e.type === 'client').length, 1, 'one az-token client serves both');
  assert.strictEqual(writer.httpClient, reader.httpClient);

  const { def } = r;
  assert.strictEqual(def.name, 'Account Metrics');
  assert.match(def.uniqueName, /^account_metrics_[0-9a-f]{8}$/);
  assert.strictEqual(def.description, '');
  assert.strictEqual(def.iconWebResourceId, DEFAULT_ICON, 'the system default icon');
  assert.match(def.sitemapId, GUID);
  assert.strictEqual(def.published, false, 'created as a draft: the publish is the flag\u2019s');
  assert.deepStrictEqual(def.siteMap, {
    areas: [{ id: 'area_0', title: 'Main', groups: [{ id: 'group_0_0', title: 'Pages', subAreas: [{ id: 'sub_0_0_0', title: 'Overview', type: 'GenPage', genPageId: PAGE_A }] }] }],
  });

  const adds = r.writes.filter((e) => e.what === 'addSolutionComponent').map((e) => e.detail);
  assert.deepStrictEqual(adds, [
    { componentId: APP_ID, componentType: 80, solutionUniqueName: 'ContosoCore' },
    { componentId: def.sitemapId, componentType: 62, solutionUniqueName: 'ContosoCore' },
  ]);
  assert.deepStrictEqual(r.payload, {
    ok: true,
    appId: APP_ID,
    uniqueName: def.uniqueName,
    name: 'Account Metrics',
    published: false,
    unpublishedChanges: true,
    solution: 'ContosoCore',
    addedToSolution: true,
    inSolution: ['app', 'sitemap'],
    sitemapId: def.sitemapId,
    languageCode: 3082,
    navigation: { area: 'Main', group: 'Pages', pages: [{ pageId: PAGE_A, title: 'Overview' }] },
  });
  assert.deepStrictEqual(r.emitOptions, [{ ascii: true }]);
  assert.strictEqual(r.stderr, '');
});

test('create --publish publishes the app last, once, by the id the push answered with, and reports it published with nothing left unpublished', async () => {
  const r = await run([...CREATE, '--publish']);
  assert.strictEqual(r.exitCode, 0, r.stderr);
  assert.deepStrictEqual(r.writeNames, ['initWorkspace', 'createArtifact', 'pushArtifact', 'addSolutionComponent', 'addSolutionComponent', 'publishArtifact']);
  assert.deepStrictEqual(r.writes[5].detail, { type: 'app', id: APP_ID });
  assert.strictEqual(r.def.published, false, 'still created as a draft: the explicit publish is what ships it');
  assert.deepStrictEqual([r.payload.published, r.payload.unpublishedChanges], [true, false], 'a publish takes the saved row into the published layer');
});

// The SDK moves the workspace key to the server's id when the two differ, so the id the push answers with is the app's — as the build addresses it. Today the
// two are equal, because the key is minted by the client.
test('the app is addressed by the id the push answered with — in the solution, in the publish and in the output — not by the one the workspace minted', async () => {
  const SERVER_ID = '33333333-3333-4333-8333-333333333333';
  const r = await run([...CREATE, '--publish'], world({ push: { type: 'app', id: SERVER_ID, saved: true, shipped: false, publish: { kind: 'notRequested' } } }));
  assert.strictEqual(r.exitCode, 0, r.stderr);
  assert.strictEqual(r.payload.appId, SERVER_ID);
  assert.deepStrictEqual(r.writes.filter((e) => e.what === 'addSolutionComponent')[0].detail.componentId, SERVER_ID);
  assert.deepStrictEqual(r.writes.find((e) => e.what === 'publishArtifact').detail, { type: 'app', id: SERVER_ID });
  // A push that names no id leaves the one the workspace minted.
  const quiet = await run([...CREATE, '--publish'], world({ push: { type: 'app', saved: true, publish: { kind: 'notRequested' } } }));
  assert.strictEqual(quiet.payload.appId, APP_ID);
});

test('every page is a sub-area, in the order given, titled with its stored name; repeated, comma-separated and mixed-case ids all work', async () => {
  const r = await run(['create', '--env', ENV, '--name', 'Two Pages', '--solution', 'ContosoCore', '--page-id', PAGE_B.toUpperCase(), '--page-id', PAGE_A]);
  assert.deepStrictEqual(r.def.siteMap.areas[0].groups[0].subAreas, [
    { id: 'sub_0_0_0', title: 'Details', type: 'GenPage', genPageId: PAGE_B },
    { id: 'sub_0_0_1', title: 'Overview', type: 'GenPage', genPageId: PAGE_A },
  ]);
  assert.deepStrictEqual(r.payload.navigation.pages, [{ pageId: PAGE_B, title: 'Details' }, { pageId: PAGE_A, title: 'Overview' }]);
  const listed = await run(['create', '--env', ENV, '--name', 'Two Pages', '--solution', 'ContosoCore', '--page-id', `${PAGE_A},${PAGE_B}`]);
  assert.deepStrictEqual(listed.payload.navigation.pages.map((p) => p.pageId), [PAGE_A, PAGE_B]);
  const read = listed.events.find((e) => e.type === 'read' && /uxagentprojects/.test(e.what));
  assert.match(read.what, new RegExp(`\\$filter=uxagentprojectid eq ${PAGE_A} or uxagentprojectid eq ${PAGE_B}$`), 'one read names every page');
});

test('a page whose stored name is empty is titled with its id; one with quotes and markup keeps them as stored', async () => {
  const w = world({ pages: { [PAGE_A]: '', [PAGE_B]: 'Say "Hi" & <more>' } });
  const r = await run(['create', '--env', ENV, '--name', 'Odd', '--solution', 'ContosoCore', '--page-id', `${PAGE_A},${PAGE_B}`], w);
  assert.deepStrictEqual(r.def.siteMap.areas[0].groups[0].subAreas.map((s) => s.title), [PAGE_A, 'Say "Hi" & <more>']);
});

test('--unique-name and --description are used as given, and --name is trimmed', async () => {
  const r = await run(['create', '--env', ENV, '--name', '  Account Metrics ', '--solution', 'ContosoCore', '--page-id', PAGE_A, '--unique-name', 'Contoso_Metrics_2', '--description', 'KPIs for the team']);
  assert.strictEqual(r.def.name, 'Account Metrics');
  assert.strictEqual(r.def.uniqueName, 'Contoso_Metrics_2');
  assert.strictEqual(r.def.description, 'KPIs for the team');
  assert.strictEqual(r.payload.uniqueName, 'Contoso_Metrics_2');
  assert.deepStrictEqual(r.events.find((e) => e.what === 'resolveArtifact app').detail, { uniqueName: 'Contoso_Metrics_2' }, 'the name the app is created with is the one checked');
});

test('--solution and --unique-name are trimmed as --name is: the platform is asked for what was meant', async () => {
  const r = await run(['create', '--env', ENV, '--name', 'A', '--solution', '  contosocore ', '--page-id', PAGE_A, '--unique-name', '  my_app ']);
  assert.strictEqual(r.exitCode, 0, r.stderr);
  assert.strictEqual(r.events.find((e) => e.what === 'queryRecords solution').detail.filter, "uniquename eq 'contosocore'");
  assert.strictEqual(r.def.uniqueName, 'my_app');
});

test('the limits are inclusive: a name and a unique name of 100 characters and a description of 2000 are accepted', async () => {
  const r = await run(['create', '--env', ENV, '--name', 'N'.repeat(100), '--solution', 'ContosoCore', '--page-id', PAGE_A, '--description', 'd'.repeat(2000), '--unique-name', 'u'.repeat(100)]);
  assert.strictEqual(r.exitCode, 0, r.stderr);
  assert.deepStrictEqual([r.def.name.length, r.def.description.length, r.def.uniqueName.length], [100, 2000, 100]);
});

test('a solution name with quotes in it is escaped in the filter, so it can only ever name the one solution', async () => {
  const r = await run(['create', '--env', ENV, '--name', 'A', '--solution', "x' or uniquename eq 'ContosoCore", '--page-id', PAGE_A]);
  assert.strictEqual(r.payload.code, 'SOLUTION_NOT_FOUND');
  assert.strictEqual(r.events.find((e) => e.what === 'queryRecords solution').detail.filter, "uniquename eq 'x'' or uniquename eq ''ContosoCore'");
  assert.deepStrictEqual(r.writes, []);
});

test('page ids are looked up 50 to a read, so a long navigation is not a long URL, and every page is found in the order given', async () => {
  const ids = Array.from({ length: 120 }, (_, i) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`);
  const pages = Object.fromEntries(ids.map((id, i) => [id, `Page ${i + 1}`]));
  const r = await run(['create', '--env', ENV, '--name', 'Big', '--solution', 'ContosoCore', '--page-id', ids.join(',')], world({ pages }));
  assert.strictEqual(r.exitCode, 0, r.stderr);
  const reads = r.events.filter((e) => e.type === 'read' && /uxagentprojects/.test(e.what));
  assert.deepStrictEqual(reads.map((e) => (e.what.match(/uxagentprojectid eq/g) || []).length), [50, 50, 20]);
  assert.deepStrictEqual(r.payload.navigation.pages.map((p) => p.pageId), ids);
  const missing = await run(['create', '--env', ENV, '--name', 'Big', '--solution', 'ContosoCore', '--page-id', ids.join(',')], world({ pages: Object.fromEntries(Object.entries(pages).filter(([id]) => id !== ids[119])) }));
  assert.strictEqual(missing.payload.code, 'PAGE_NOT_FOUND', 'a page in the last, short chunk is still looked for');
  assert.ok(missing.payload.error.includes(ids[119]));
});

test('the base language is a whole language code from 1 to 65535: anything else is unreadable, and nothing is written', async () => {
  for (const language of [0, -1, 65536, 1033.5, 'English', NaN, undefined]) {
    const r = await run(CREATE, world({ language }));
    assert.strictEqual(r.payload.code, 'LANGUAGE_UNREADABLE', String(language));
    assert.deepStrictEqual(r.writes, [], String(language));
  }
  for (const language of [1, 65535]) {
    const r = await run(CREATE, world({ language }));
    assert.strictEqual(r.exitCode, 0, String(language));
    assert.strictEqual(r.payload.languageCode, language);
  }
});

test('an SDK the script cannot make is a failure with nothing written: the one that writes, and the SDK module itself', async () => {
  const noWriter = await run(CREATE, world(), { makeSdk: (cfg) => { if (cfg.languageCode !== undefined) throw Object.assign(new Error('the language is not supported'), { code: 'VALIDATION_ERROR' }); } });
  assert.strictEqual(noWriter.exitCode, 1);
  assert.deepStrictEqual(noWriter.payload, { ok: false, code: 'VALIDATION_ERROR', error: 'the language is not supported', written: false });
  assert.deepStrictEqual(noWriter.writes, []);
  assert.strictEqual(fs.existsSync(noWriter.workspaceDirs[0]), false, 'the workspace is removed all the same');

  // A module that throws when it is used: what main() catches, as the last resort, to print the same shape.
  const broken = { get createMakerSdk() { throw new Error('the SDK module is broken'); }, createNodeWorkspaceStorage: () => ({}) };
  const create = await run(CREATE, world(), {}, { makerSdk: broken });
  assert.strictEqual(create.exitCode, 1);
  assert.deepStrictEqual(create.payload, { ok: false, error: 'the SDK module is broken', written: false });
  const list = await run(['list', '--env', ENV], world(), {}, { makerSdk: broken });
  assert.strictEqual(list.exitCode, 1);
  assert.deepStrictEqual(list.payload, { ok: false, error: 'the SDK module is broken' });
});

test('the solution is written as the platform spells it, whatever case --solution was given in', async () => {
  const r = await run(['create', '--env', ENV, '--name', 'A', '--solution', 'contosocore', '--page-id', PAGE_A]);
  assert.ok(r.writes.filter((e) => e.what === 'addSolutionComponent').every((e) => e.detail.solutionUniqueName === 'ContosoCore'));
  assert.strictEqual(r.payload.solution, 'ContosoCore');
});

test('a system solution (Default, Active, Basic) holds every component already: no AddSolutionComponent is made, and the output says that is why — a success does not read like a failure', async () => {
  for (const unique of ['Default', 'active', 'Basic']) {
    const w = world({ solutions: [solution({ uniquename: unique })] });
    const r = await run(['create', '--env', ENV, '--name', 'A', '--solution', unique, '--page-id', PAGE_A, '--publish'], w);
    assert.strictEqual(r.exitCode, 0, unique);
    assert.deepStrictEqual(r.writeNames, ['initWorkspace', 'createArtifact', 'pushArtifact', 'publishArtifact'], unique);
    assert.strictEqual(r.payload.published, true, unique);
    // Nothing was added, so `addedToSolution` is false and `inSolution` is empty; `systemSolution` is what says that is no fault.
    assert.deepStrictEqual([r.payload.addedToSolution, r.payload.inSolution, r.payload.systemSolution], [false, [], true], unique);
    assert.strictEqual(r.payload.solution, unique, 'the solution as the platform spells it');
  }
  // A solution of the author's own is added to, and is not a system solution.
  const own = await run(CREATE);
  assert.deepStrictEqual([own.payload.addedToSolution, own.payload.inSolution], [true, ['app', 'sitemap']]);
  assert.ok(!('systemSolution' in own.payload), 'the flag is there only when it is true');
});

test('a failure after the push into a system solution says the same: nothing was added to it, because it holds every component already', async () => {
  const w = world({ solutions: [solution({ uniquename: 'Default' })], publishResult: { type: 'app', id: APP_ID, shipped: false, publish: { kind: 'failed', error: new Error('another publish is running') } } });
  const r = await run(['create', '--env', ENV, '--name', 'A', '--solution', 'Default', '--page-id', PAGE_A, '--publish'], w);
  assert.strictEqual(r.exitCode, 1);
  assert.deepStrictEqual([r.payload.stage, r.payload.addedToSolution, r.payload.inSolution, r.payload.systemSolution], ['publish', false, [], true]);
});

test('the SDK\u2019s notes on a push that succeeded are in the output and on stderr, not lost', async () => {
  const w = world({ push: { type: 'app', id: APP_ID, saved: true, publish: { kind: 'notRequested' }, warnings: ['App roles: could not associate the System Administrator role with the app.'] } });
  const r = await run(CREATE, w);
  assert.strictEqual(r.exitCode, 0);
  assert.deepStrictEqual(r.payload.warnings, ['App roles: could not associate the System Administrator role with the app.']);
  assert.match(r.stderr, /⚠ App roles: could not associate the System Administrator role with the app\./);
});

// --- create: the refusals, each before the first write ----------------------------------------------------------

// Each refusal prints { ok: false, code, error, written: false } and exits 1, with no SDK write of any kind. `reads` is how many SDKs it
// got as far as making: an input refusal is decided before any exists.
const REFUSALS = [
  { why: 'no --page-id', argv: without(CREATE, '--page-id'), code: 'PAGE_ID_REQUIRED', message: /needs at least one --page-id.*empty.*Create the first page without an app, then create the app with its id/s, sdks: 0 },
  { why: 'a page id that is not a GUID', argv: [...without(CREATE, '--page-id'), '--page-id', 'not-a-guid'], code: 'PAGE_ID_INVALID', message: /--page-id 'not-a-guid' is not a page id/, sdks: 0 },
  { why: 'a page id with text before a GUID', argv: [...without(CREATE, '--page-id'), '--page-id', `x${PAGE_A}`], code: 'PAGE_ID_INVALID', message: /is not a page id/, sdks: 0 },
  { why: 'a page id with text after a GUID', argv: [...without(CREATE, '--page-id'), '--page-id', `${PAGE_A}0`], code: 'PAGE_ID_INVALID', message: /is not a page id/, sdks: 0 },
  { why: 'a page id in braces', argv: [...without(CREATE, '--page-id'), '--page-id', `{${PAGE_A}}`], code: 'PAGE_ID_INVALID', message: /is not a page id/, sdks: 0 },
  { why: 'the same page twice (in another letter case)', argv: [...CREATE, '--page-id', PAGE_A.toUpperCase()], code: 'PAGE_ID_DUPLICATE', message: /was given more than once/, sdks: 0 },
  { why: 'a unique name with a space', argv: [...CREATE, '--unique-name', 'has space'], code: 'UNIQUE_NAME_INVALID', message: /not an app unique name/, sdks: 0 },
  { why: 'a unique name with a hyphen', argv: [...CREATE, '--unique-name', 'a-b'], code: 'UNIQUE_NAME_INVALID', message: /letters, digits and underscores/, sdks: 0 },
  { why: 'a unique name of 101 characters', argv: [...CREATE, '--unique-name', 'a'.repeat(101)], code: 'UNIQUE_NAME_INVALID', message: /1 to 100/, sdks: 0 },
  { why: 'a name of 101 characters', argv: ['create', '--env', ENV, '--name', 'N'.repeat(101), '--solution', 'ContosoCore', '--page-id', PAGE_A], code: 'NAME_TOO_LONG', message: /--name is 101 characters/, sdks: 0 },
  { why: 'a description of 2001 characters', argv: [...CREATE, '--description', 'd'.repeat(2001)], code: 'DESCRIPTION_TOO_LONG', message: /--description is 2001 characters/, sdks: 0 },
  { why: 'a solution that does not exist', argv: ['create', '--env', ENV, '--name', 'A', '--solution', 'Nope', '--page-id', PAGE_A], code: 'SOLUTION_NOT_FOUND', message: /no solution with the unique name 'Nope'.*not its display name/is, sdks: 1 },
  { why: 'a managed solution', world: world({ solutions: [solution({ ismanaged: true })] }), argv: CREATE, code: 'SOLUTION_MANAGED', message: /'ContosoCore' is managed.*takes no new components/s, sdks: 1 },
  { why: 'a page that is not in the environment (one of two)', argv: [...without(CREATE, '--page-id'), '--page-id', `${PAGE_A},3f8fad5b-d9cb-469f-a165-70867728950e`], code: 'PAGE_NOT_FOUND', message: /generative page in this environment: 3f8fad5b-d9cb-469f-a165-70867728950e\./, sdks: 1 },
  { why: 'an app that already has the unique name', world: world({ apps: [appRow({ uniquename: 'contoso_sales', name: 'Contoso Sales' })] }), argv: [...CREATE, '--unique-name', 'CONTOSO_SALES'], code: 'UNIQUE_NAME_TAKEN', message: /An app already has the unique name 'CONTOSO_SALES' \(Contoso Sales, /, sdks: 1 },
  { why: 'a site map that already has the unique name', world: world({ sitemaps: [{ sitemapid: '55555555-5555-4555-8555-555555555555', sitemapnameunique: 'contoso_sales' }] }), argv: [...CREATE, '--unique-name', 'contoso_sales'], code: 'UNIQUE_NAME_TAKEN', message: /A site map already has the name 'contoso_sales' \(one an app was deleted without\)/, sdks: 1 },
  { why: 'a base language the organization does not answer', world: world({ language: null }), argv: CREATE, code: 'LANGUAGE_UNREADABLE', message: /base language could not be read.*nothing was written/is, sdks: 1 },
];

for (const c of REFUSALS) {
  test(`refused before anything is written: ${c.why}`, async () => {
    const r = await run(c.argv, c.world || world());
    assert.strictEqual(r.exitCode, 1);
    assert.deepStrictEqual(r.writes, [], 'not one write: no workspace, no app, no solution component, no publish');
    assert.strictEqual(r.instances.length, c.sdks, `made ${c.sdks} SDK(s): none that could write`);
    assert.strictEqual(r.payload.ok, false);
    assert.strictEqual(r.payload.code, c.code);
    assert.strictEqual(r.payload.written, false);
    assert.match(r.payload.error, c.message);
    assert.deepStrictEqual(Object.keys(r.payload).sort(), ['code', 'error', 'ok', 'written']);
    assert.deepStrictEqual(r.emitOptions, [{ ascii: true }]);
  });
}

test('a page id the environment lacks is refused naming every missing id, and the page that exists is not blamed', async () => {
  const missing = ['3f8fad5b-d9cb-469f-a165-70867728950e', '4f8fad5b-d9cb-469f-a165-70867728950e'];
  const r = await run(['create', '--env', ENV, '--name', 'A', '--solution', 'ContosoCore', '--page-id', [PAGE_A, ...missing].join(',')]);
  assert.strictEqual(r.payload.code, 'PAGE_NOT_FOUND');
  assert.ok(r.payload.error.includes(missing.join(', ')));
  assert.ok(!r.payload.error.includes(PAGE_A));
});

test('the environment is asked in a fixed order — solution, pages, unique name, language — so the first thing wrong is the one reported', async () => {
  // Nothing exists: the solution, the pages and the language are all wrong at once; the solution is what is named.
  const r = await run(['create', '--env', ENV, '--name', 'A', '--solution', 'Nope', '--page-id', '3f8fad5b-d9cb-469f-a165-70867728950e'], world({ language: null }));
  assert.strictEqual(r.payload.code, 'SOLUTION_NOT_FOUND');
  assert.deepStrictEqual(r.events.filter((e) => e.type === 'read').map((e) => e.what), ['queryRecords solution'], 'and nothing after it is read');
  const pages = await run(['create', '--env', ENV, '--name', 'A', '--solution', 'ContosoCore', '--page-id', '3f8fad5b-d9cb-469f-a165-70867728950e'], world({ language: null, apps: [appRow({ uniquename: 'x' })] }));
  assert.strictEqual(pages.payload.code, 'PAGE_NOT_FOUND', 'pages before the unique name and the language');
});

test('a read the SDK refuses stops the run before any write, with the SDK\u2019s own code and message', async () => {
  const refused = Object.assign(new Error('HTTP 403 from https://contoso.crm.dynamics.com/api/data/v9.0/solutions: not a member of the organization'), { code: 'CONNECTION_ERROR', statusCode: 403 });
  const w = world();
  w.solutions = { filter() { throw refused; } };
  const r = await run(CREATE, w);
  assert.strictEqual(r.exitCode, 1);
  assert.deepStrictEqual(r.payload, { ok: false, code: 'CONNECTION_ERROR', error: refused.message, written: false });
  assert.deepStrictEqual(r.writes, []);
});

// --- create: a failure after the first write ---------------------------------------------------------------------

// A create that fails after the push began reads the platform back before it answers, by the unique name the script chose — the saved layer, the
// published layer, the site map — so `written`, `appId`, `left`, `published` and `unpublishedChanges` say what is THERE, not how far the run got.
// `sitemapId` is always the one the script chose before its first write.
const unpublishedByName = (name) => `/appmodules/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()?$select=appmoduleid,name,uniquename,description,componentstate&$filter=uniquename eq '${name}'`;
const publishedByName = (name) => `/appmodules?$select=appmoduleid&$filter=uniquename eq '${name}'`;
const sitemapsByName = (name) => `/sitemaps/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()?$select=sitemapid,sitemapnameunique&$filter=sitemapnameunique eq '${name}'`;
// The reads made after the last write: the read-back.
const readBackOf = (r) => {
  const lastWrite = r.events.map((e) => e.type).lastIndexOf('write');
  return r.events.slice(lastWrite + 1).filter((e) => e.type === 'read').map((e) => e.what);
};
// What the platform holds when the app and its sitemap are both there, as a draft; and when nothing is.
const draftLeft = (r, extra = {}) => ({ ok: false, written: true, appId: APP_ID, uniqueName: r.payload.uniqueName, sitemapId: r.def.sitemapId, left: { app: true, sitemap: true }, published: false, unpublishedChanges: true, ...extra });
const nothingLeft = (r, extra = {}) => ({ ok: false, written: false, uniqueName: r.payload.uniqueName, sitemapId: r.def.sitemapId, left: { app: false, sitemap: false }, ...extra });

test('a push the SDK reports as not saved is a failure, with the SDK\u2019s code and message, and the read-back says nothing is left — and still names the sitemap it chose', async () => {
  const w = world({ push: { type: 'app', id: APP_ID, saved: false, error: Object.assign(new Error('the sitemap names a page that does not exist'), { code: 'SITEMAP_TARGET_NOT_FOUND' }) } });
  const r = await run(CREATE, w);
  assert.strictEqual(r.exitCode, 1);
  assert.deepStrictEqual(r.payload, nothingLeft(r, { code: 'SITEMAP_TARGET_NOT_FOUND', error: 'the sitemap names a page that does not exist', stage: 'create', addedToSolution: false, inSolution: [] }));
  assert.match(r.payload.sitemapId, GUID, 'the id the script minted before its first write');
  assert.strictEqual(r.payload.sitemapId, r.def.sitemapId);
  assert.deepStrictEqual(r.writeNames, ['initWorkspace', 'createArtifact', 'pushArtifact'], 'nothing follows a push that was not saved: no solution, no publish');
  assert.deepStrictEqual(r.held, [], 'and nothing is in the solution');
  // One read-back, by the unique name, in both layers and from the site maps.
  assert.deepStrictEqual(readBackOf(r), [unpublishedByName(r.payload.uniqueName), publishedByName(r.payload.uniqueName), sitemapsByName(r.payload.uniqueName)]);
});

test('a push that throws, after the SDK took the partial app away, is a failure at the create stage that says nothing was written — where the app\u2019s id is not offered as an app', async () => {
  const r = await run([...CREATE, '--publish'], world(), { pushArtifact: () => { throw Object.assign(new Error('HTTP 400 from …/sitemaps: SiteMap needs to have a non-empty Area with a non-empty Group'), { code: 'CONNECTION_ERROR' }); } });
  assert.deepStrictEqual(r.payload, nothingLeft(r, { code: 'CONNECTION_ERROR', error: 'HTTP 400 from …/sitemaps: SiteMap needs to have a non-empty Area with a non-empty Group', stage: 'create', addedToSolution: false, inSolution: [] }));
  assert.ok(!('appId' in r.payload), 'there is no app, so no appId');
  assert.deepStrictEqual(r.writeNames, ['initWorkspace', 'createArtifact', 'pushArtifact']);
});

test('a push that throws and leaves the app and its sitemap (the rollback was refused) says so: written, the app that exists, the sitemap, and that nothing is published', async () => {
  const r = await run(CREATE, world(), {
    pushArtifact: () => { throw Object.assign(new Error('the sitemap write failed. The partial app this create wrote was KEPT'), { code: 'CONNECTION_ERROR' }); },
    afterPush: (added, { def }) => {
      added.apps.push({ appmoduleid: APP_ID, name: def.name, uniquename: def.uniqueName, componentstate: 1 });
      added.sitemaps.push({ sitemapid: def.sitemapId, sitemapnameunique: def.uniqueName });
    },
  });
  assert.strictEqual(r.exitCode, 1);
  assert.deepStrictEqual(r.payload, draftLeft(r, { code: 'CONNECTION_ERROR', error: 'the sitemap write failed. The partial app this create wrote was KEPT', stage: 'create', addedToSolution: false, inSolution: [] }));
  assert.strictEqual(r.payload.appId, APP_ID, 'the app this create wrote: the id the SDK minted and sent as the row\u2019s key');
});

// What makes a row THIS create's is its id — the app's, which the SDK minted before its first write and sent as the new row's key, and the site map's, which the
// script chose — and not the unique name, which is only what a retry collides on. A create under the same --unique-name that reaches the platform first makes
// this one's write fail as a duplicate, and the rows found under the name are that other create's: not left behind by this one, and never to be reported as that.
const FOREIGN_APP = '99999999-9999-4999-8999-999999999999';
const FOREIGN_SITEMAP = '88888888-8888-4888-8888-888888888888';
const holdsTheName = (added, def, { app = true, sitemap = true } = {}) => {
  if (app) added.apps.push({ appmoduleid: FOREIGN_APP, name: 'Another maker\u2019s app', uniquename: def.uniqueName, componentstate: 0 });
  if (sitemap) added.sitemaps.push({ sitemapid: FOREIGN_SITEMAP, sitemapnameunique: def.uniqueName });
};

test('a create refused because another create holds its unique name wrote nothing: the app and site map found under the name are not its leftovers, and are named apart', async () => {
  const r = await run(CREATE, world(), {
    pushArtifact: () => { throw Object.assign(new Error('HTTP 400 from …/appmodules: A record with the same unique name already exists.'), { code: 'CONNECTION_ERROR' }); },
    afterPush: (added, { def }) => holdsTheName(added, def),
  });
  assert.strictEqual(r.exitCode, 1);
  assert.deepStrictEqual(r.payload, nothingLeft(r, {
    code: 'CONNECTION_ERROR',
    error: 'HTTP 400 from …/appmodules: A record with the same unique name already exists.',
    stage: 'create',
    addedToSolution: false,
    inSolution: [],
    nameTakenBy: { appId: FOREIGN_APP, sitemapId: FOREIGN_SITEMAP },
  }));
  assert.ok(!('appId' in r.payload) && !('published' in r.payload), 'the other app is not this create\u2019s, so it is not named as its app nor described');
  assert.notStrictEqual(r.payload.sitemapId, FOREIGN_SITEMAP, 'and the sitemap id is the one the script chose, not the one found under the name');
});

test('this create\u2019s app is left and another site map holds the name: the app is written, the site map is not this one\u2019s and is named apart', async () => {
  const r = await run(CREATE, world(), {
    pushArtifact: () => { throw new Error('the site map was refused as a duplicate, and the app could not be removed'); },
    afterPush: (added, { def }) => {
      added.apps.push({ appmoduleid: APP_ID, name: def.name, uniquename: def.uniqueName, componentstate: 1 });
      holdsTheName(added, def, { app: false });
    },
  });
  assert.deepStrictEqual(r.payload, draftLeft(r, {
    error: 'the site map was refused as a duplicate, and the app could not be removed',
    stage: 'create',
    addedToSolution: false,
    inSolution: [],
    left: { app: true, sitemap: false },
    nameTakenBy: { sitemapId: FOREIGN_SITEMAP },
  }));
});

test('a row is this create\u2019s whichever way the platform spells its id: capitals are the same id', async () => {
  const r = await run(CREATE, world(), {
    pushArtifact: () => { throw new Error('the pin failed'); },
    afterPush: (added, { def }) => {
      added.apps.push({ appmoduleid: APP_ID.toUpperCase(), name: def.name, uniquename: def.uniqueName, componentstate: 1 });
      added.sitemaps.push({ sitemapid: def.sitemapId.toUpperCase(), sitemapnameunique: def.uniqueName });
    },
  });
  assert.deepStrictEqual(r.payload, draftLeft(r, { error: 'the pin failed', stage: 'create', addedToSolution: false, inSolution: [] }));
  assert.ok(!('nameTakenBy' in r.payload), 'the same id in other letters is not another row');
});

test('an app of this create that reads as neither published nor changed was deleted between the read-back\u2019s two reads: it is not left, and no pair that no app has is printed', async () => {
  const r = await run(CREATE, world(), {
    pushArtifact: () => { throw new Error('the pin failed'); },
    afterPush: (added, { def }) => { added.apps.push({ appmoduleid: APP_ID, name: def.name, uniquename: def.uniqueName, componentstate: 0, published: false }); },
  });
  assert.deepStrictEqual(r.payload, nothingLeft(r, { error: 'the pin failed', stage: 'create', addedToSolution: false, inSolution: [] }));
  assert.ok(!('appId' in r.payload) && !('published' in r.payload) && !('unpublishedChanges' in r.payload));
});

test('a site map the platform answers with no id cannot be told from this create\u2019s, so the read-back is unknown and says why — it does not guess', async () => {
  const r = await run(CREATE, world(), {
    pushArtifact: () => { throw new Error('the pin failed'); },
    afterPush: (added, { def }) => { added.sitemaps.push({ sitemapnameunique: def.uniqueName }); },
  });
  assert.strictEqual(r.payload.written, null);
  assert.match(r.payload.readBackError, /a site map with no id, so what is left cannot be told/);
  assert.deepStrictEqual(r.payload.left, { app: false, sitemap: null }, 'the app was read and is not there; the site map could not be placed');
  assert.deepStrictEqual(r.payload.lookFor, { uniqueName: r.payload.uniqueName, appId: APP_ID, sitemapId: r.def.sitemapId });
});

test('only the sitemap left behind (the app is gone) is written:true with no appId, and left says which row it is', async () => {
  const r = await run(CREATE, world(), {
    pushArtifact: () => { throw new Error('the app could not be removed'); },
    afterPush: (added, { def }) => { added.sitemaps.push({ sitemapid: def.sitemapId, sitemapnameunique: def.uniqueName }); },
  });
  assert.deepStrictEqual(r.payload, {
    ok: false,
    error: 'the app could not be removed',
    written: true,
    stage: 'create',
    uniqueName: r.payload.uniqueName,
    sitemapId: r.def.sitemapId,
    left: { app: false, sitemap: true },
    addedToSolution: false,
    inSolution: [],
  });
});

test('only the app left behind (its sitemap was never written) is written:true with the app\u2019s id, and left says which row it is', async () => {
  const r = await run(CREATE, world(), {
    pushArtifact: () => { throw new Error('the sitemap could not be written, and the app could not be removed'); },
    afterPush: (added, { def }) => { added.apps.push({ appmoduleid: APP_ID, name: def.name, uniquename: def.uniqueName, componentstate: 1 }); },
  });
  assert.deepStrictEqual(r.payload, draftLeft(r, { error: 'the sitemap could not be written, and the app could not be removed', stage: 'create', addedToSolution: false, inSolution: [], left: { app: true, sitemap: false } }));
});

test('an app left behind is described by what the platform says of it — published, with unpublished changes — not by how far the run got', async () => {
  // The SDK's own create published the app (as a create without the draft opt-in does) and then failed on the sitemap's pin: a published app, and its saved row too.
  const r = await run(CREATE, world(), {
    pushArtifact: () => { throw new Error('the pin failed'); },
    afterPush: (added, { def }) => {
      added.apps.push({ appmoduleid: APP_ID, name: def.name, uniquename: def.uniqueName, componentstate: 1, published: true });
      added.sitemaps.push({ sitemapid: def.sitemapId, sitemapnameunique: def.uniqueName });
    },
  });
  assert.deepStrictEqual([r.payload.written, r.payload.published, r.payload.unpublishedChanges], [true, true, true]);
});

test('a read-back that cannot be made does not fail the failure: the outcome is unknown unless an earlier read answered, and what to look for is named — each of the three reads', async () => {
  const refused = Object.assign(new Error('the model-driven apps: HTTP 503 from …/appmodules'), { code: 'CONNECTION_ERROR', statusCode: 503 });
  // The reads are made in turn and the first that fails ends them. The saved layer is the first, so when it fails nothing is learned; when a later one fails the
  // app has been read — it is not there — and the site map has not, so the outcome is still unknown, with the half that is known said.
  for (const [which, unreadable, reads, left] of [
    ['the saved layer', /^\/appmodules\/Microsoft/, 1, undefined],
    ['the published layer', /^\/appmodules\?/, 2, { app: false, sitemap: null }],
    ['the site maps', /^\/sitemaps\//, 3, { app: false, sitemap: null }],
  ]) {
    let armed = false;
    const w = world({ push: { type: 'app', id: APP_ID, saved: false, error: Object.assign(new Error('the push was refused'), { code: 'VALIDATION_ERROR' }) } });
    const r = await run(CREATE, w, { afterPush: () => { armed = true; }, read: (p) => { if (armed && unreadable.test(p)) throw refused; } });
    assert.strictEqual(r.exitCode, 1, which);
    // The create's own error is what the caller gets; the read-back's is beside it.
    assert.deepStrictEqual(r.payload, {
      ok: false,
      code: 'VALIDATION_ERROR',
      error: 'the push was refused',
      written: null,
      stage: 'create',
      uniqueName: r.payload.uniqueName,
      sitemapId: r.def.sitemapId,
      ...(left ? { left } : {}),
      lookFor: { uniqueName: r.payload.uniqueName, appId: APP_ID, sitemapId: r.def.sitemapId },
      readBackError: refused.message,
      addedToSolution: false,
      inSolution: [],
    }, which);
    assert.ok(!('appId' in r.payload) && !('published' in r.payload), `${which}: nothing is claimed that was not read`);
    assert.strictEqual(readBackOf(r).length, reads, `${which}: the first read that fails ends the read-back`);
  }
});

// A read-back that cannot be made is not a run that knows nothing. A push the SDK reported as saved committed the app and its site map, so a failure after it
// (the solution, the publish) leaves both whether or not they can be read back; and an app read before a later read failed is an app.
test('a push the SDK reported as saved wrote both rows, so a read-back that cannot be made still says written — at the solution stage and at the publish stage', async () => {
  const refused = Object.assign(new Error('the model-driven apps: HTTP 503 from …/appmodules'), { code: 'CONNECTION_ERROR', statusCode: 503 });
  const failedPublish = world({ publishResult: { type: 'app', id: APP_ID, shipped: false, publish: { kind: 'failed', error: new Error('another publish is running') } } });
  for (const [stage, w, argv, error, joined] of [
    ['solution', world(), CREATE, 'the app could not be added', []],
    ['publish', failedPublish, [...CREATE, '--publish'], 'another publish is running', ['app', 'sitemap']],
  ]) {
    let armed = false;
    const r = await run(argv, w, {
      afterPush: () => { armed = true; },
      addSolutionComponent: () => { if (stage === 'solution') throw new Error(error); },
      read: () => { if (armed) throw refused; },
    });
    assert.strictEqual(r.exitCode, 1, stage);
    assert.deepStrictEqual(r.payload, {
      ok: false,
      error,
      written: true,
      stage,
      appId: APP_ID,
      uniqueName: r.payload.uniqueName,
      sitemapId: r.def.sitemapId,
      left: { app: true, sitemap: true },
      lookFor: { uniqueName: r.payload.uniqueName, appId: APP_ID, sitemapId: r.def.sitemapId },
      readBackError: refused.message,
      addedToSolution: joined.length === 2,
      inSolution: joined,
    }, stage);
    assert.ok(!('published' in r.payload), `${stage}: the platform could not be asked, so nothing is said of whether the app is published`);
    assert.strictEqual(readBackOf(r).length, 1, `${stage}: the first read failed and ended the read-back`);
  }
});

test('an app read before a later read failed is written: the read-back keeps what it learned and says what it could not read', async () => {
  const refused = Object.assign(new Error('the model-driven apps: HTTP 503 from …/appmodules'), { code: 'CONNECTION_ERROR', statusCode: 503 });
  for (const [which, unreadable, facts] of [['the published layer', /^\/appmodules\?/, false], ['the site maps', /^\/sitemaps\//, true]]) {
    let armed = false;
    const r = await run(CREATE, world(), {
      pushArtifact: () => { throw new Error('the pin failed, and the rollback was refused'); },
      afterPush: (added, { def }) => {
        armed = true;
        added.apps.push({ appmoduleid: APP_ID, name: def.name, uniquename: def.uniqueName, componentstate: 1 });
        added.sitemaps.push({ sitemapid: def.sitemapId, sitemapnameunique: def.uniqueName });
      },
      read: (p) => { if (armed && unreadable.test(p)) throw refused; },
    });
    assert.deepStrictEqual(r.payload, {
      ok: false,
      error: 'the pin failed, and the rollback was refused',
      written: true,
      stage: 'create',
      appId: APP_ID,
      uniqueName: r.payload.uniqueName,
      sitemapId: r.def.sitemapId,
      left: { app: true, sitemap: null },
      // The published fact needs the published layer: it is there when the site maps failed, which come after it, and not when the published layer did.
      ...(facts ? { published: false, unpublishedChanges: true } : {}),
      lookFor: { uniqueName: r.payload.uniqueName, appId: APP_ID, sitemapId: r.def.sitemapId },
      readBackError: refused.message,
      addedToSolution: false,
      inSolution: [],
    }, which);
  }
});

test('a failure before the push — in the workspace, or in the SDK\u2019s own validation of the app — says nothing was written, and reads nothing back', async () => {
  const r = await run(CREATE, world(), { createArtifact: () => { throw Object.assign(new Error('the app is not valid'), { code: 'VALIDATION_ERROR' }); } });
  assert.deepStrictEqual(r.payload, { ok: false, code: 'VALIDATION_ERROR', error: 'the app is not valid', written: false });
  assert.deepStrictEqual(r.writeNames, ['initWorkspace', 'createArtifact']);
  assert.deepStrictEqual(readBackOf(r), [], 'no push was made, so there is nothing to read back');
});

test('a failure between the two solution adds says which component is in the solution — the app is, the sitemap is not — and the platform agrees', async () => {
  let adds = 0;
  const r = await run([...CREATE, '--publish'], world(), { addSolutionComponent: () => { adds += 1; if (adds === 2) throw new Error('the sitemap could not be added'); } });
  assert.strictEqual(r.exitCode, 1);
  assert.deepStrictEqual(r.payload, draftLeft(r, { error: 'the sitemap could not be added', stage: 'solution', addedToSolution: false, inSolution: ['app'] }));
  // What the platform holds: the app joined the solution, its sitemap did not. `addedToSolution` is true only when both did.
  assert.deepStrictEqual(r.held, [{ componentId: APP_ID, componentType: 80, solution: 'ContosoCore' }]);
  assert.ok(!r.writeNames.includes('publishArtifact'), 'a publish is never attempted over a half-joined solution');
  assert.strictEqual(r.writeNames.filter((n) => n === 'addSolutionComponent').length, 2);
});

test('a failure of the app\u2019s own add leaves nothing in the solution, and says so', async () => {
  const r = await run([...CREATE, '--publish'], world(), { addSolutionComponent: () => { throw new Error('the app could not be added'); } });
  assert.deepStrictEqual(r.payload, draftLeft(r, { error: 'the app could not be added', stage: 'solution', addedToSolution: false, inSolution: [] }));
  assert.deepStrictEqual(r.held, []);
  assert.strictEqual(r.writeNames.filter((n) => n === 'addSolutionComponent').length, 1, 'the sitemap is not tried after the app failed');
});

test('a publish the SDK reports as failed is a failure at the publish stage, the app and its sitemap already in the solution, and still a draft', async () => {
  const w = world({ publishResult: { type: 'app', id: APP_ID, shipped: false, publish: { kind: 'failed', error: Object.assign(new Error('another publish is running'), { code: 'CONNECTION_ERROR' }) } } });
  const r = await run([...CREATE, '--publish'], w);
  assert.strictEqual(r.exitCode, 1);
  assert.deepStrictEqual(r.payload, draftLeft(r, { code: 'CONNECTION_ERROR', error: 'another publish is running', stage: 'publish', addedToSolution: true, inSolution: ['app', 'sitemap'] }));
  assert.deepStrictEqual(r.held.map((component) => component.componentType), [80, 62]);
});

test('a publish the SDK reports as failed that the platform in fact took is published — the read-back, not the SDK\u2019s word, says what is there', async () => {
  const r = await run([...CREATE, '--publish'], world(), {
    publishArtifact: ({ id, added }) => {
      // The publish went through and its answer was lost: the SDK reports a failure, the platform now has a published app and nothing saved on top of it.
      for (const app of added.apps) if (app.appmoduleid === id) Object.assign(app, { componentstate: 0, published: true });
      return { publish: { kind: 'failed', error: new Error('the publish was submitted but could not be confirmed') } };
    },
  });
  assert.deepStrictEqual(r.payload, draftLeft(r, { error: 'the publish was submitted but could not be confirmed', stage: 'publish', addedToSolution: true, inSolution: ['app', 'sitemap'], published: true, unpublishedChanges: false }));
});

test('the SDK\u2019s notes on the push are kept when the run fails after it — in the output and on stderr — at the solution stage, the publish stage and for a push not saved', async () => {
  const note = 'App roles: could not associate the \'System Administrator\' role with the app; it will not be visible or playable until a role is granted access to it.';
  const pushed = (extra = {}) => ({ type: 'app', id: APP_ID, saved: true, shipped: false, publish: { kind: 'notRequested' }, warnings: [note], ...extra });
  const cases = [
    ['solution', 'the sitemap could not be added', world({ push: pushed() }), { addSolutionComponent: (options) => { if (options.componentType === 62) throw new Error('the sitemap could not be added'); } }],
    ['publish', 'another publish is running', world({ push: pushed(), publishResult: { publish: { kind: 'failed', error: new Error('another publish is running') } } }), {}],
    ['create', 'the push was refused', world({ push: pushed({ saved: false, error: new Error('the push was refused') }) }), {}],
  ];
  for (const [stage, message, w, hooks] of cases) {
    const r = await run([...CREATE, '--publish'], w, hooks);
    assert.strictEqual(r.exitCode, 1, stage);
    assert.deepStrictEqual([r.payload.stage, r.payload.error], [stage, message]);
    assert.deepStrictEqual(r.payload.warnings, [note], `${stage}: in the output`);
    assert.strictEqual(r.stderr, `\u26a0 ${note}\n`, `${stage}: and on stderr`);
  }
  const quiet = await run([...CREATE, '--publish'], world(), { addSolutionComponent: () => { throw new Error('no'); } });
  assert.ok(!('warnings' in quiet.payload), 'a push with no notes leaves no warnings key');
  assert.strictEqual(quiet.stderr, '');
});

test('a publish that answers nothing, or throws, is a failure too — never a published app', async () => {
  const silent = await run([...CREATE, '--publish'], world({ publishResult: undefined }));
  assert.strictEqual(silent.payload.ok, false);
  assert.match(silent.payload.error, /the publish was not accepted \(no answer\)/);
  const other = await run([...CREATE, '--publish'], world({ publishResult: { publish: { kind: 'notApplicable' } } }));
  assert.match(other.payload.error, /the publish was not accepted \(notApplicable\)/);
  const thrown = await run([...CREATE, '--publish'], world(), { publishArtifact: () => { throw new Error('boom'); } });
  assert.deepStrictEqual([thrown.payload.stage, thrown.payload.error, thrown.payload.published], ['publish', 'boom', false]);
  const verified = await run([...CREATE, '--publish'], world({ publishResult: { publish: { kind: 'verified' } } }));
  assert.strictEqual(verified.payload.ok, true, 'a verified publish is a publish');
});

// --- the unique name ----------------------------------------------------------------------------------------------

test('deriveUniqueName is the display name, lower-cased, runs of anything but a-z and 0-9 as one underscore, then _ and 8 hex digits', () => {
  const { deriveUniqueName } = require('../apps.js');
  const hex = () => '1a2b3c4d';
  assert.strictEqual(deriveUniqueName('Account Metrics', hex), 'account_metrics_1a2b3c4d');
  assert.strictEqual(deriveUniqueName('  GenPages -- Action  E2E!! ', hex), 'genpages_action_e2e_1a2b3c4d');
  assert.strictEqual(deriveUniqueName('Q3 Plan 2026', hex), 'q3_plan_2026_1a2b3c4d');
  assert.strictEqual(deriveUniqueName('\u65e5\u672c\u8a9e', hex), 'app_1a2b3c4d', 'a name with nothing in a-z/0-9 is app_<hex>');
  assert.strictEqual(deriveUniqueName('!!!', hex), 'app_1a2b3c4d');
  const long = deriveUniqueName('x'.repeat(200), hex);
  assert.strictEqual(long.length, 100);
  assert.match(long, /^x{91}_1a2b3c4d$/);
  assert.match(deriveUniqueName('Account Metrics'), /^account_metrics_[0-9a-f]{8}$/);
  assert.notStrictEqual(deriveUniqueName('Account Metrics'), deriveUniqueName('Account Metrics'), 'two apps of one name differ');
  for (const name of ['Account Metrics', 'a_b', '9 lives', 'x'.repeat(300)]) assert.match(deriveUniqueName(name), /^[a-z0-9_]{1,100}$/);
});

test('a name cut at the limit does not end in an underscore before the hex digits', () => {
  const { deriveUniqueName } = require('../apps.js');
  const name = `${'a'.repeat(90)} b`;
  const unique = deriveUniqueName(name, () => '1a2b3c4d');
  assert.strictEqual(unique, `${'a'.repeat(90)}_1a2b3c4d`, 'the 91 characters of room end after the 90 a\u2019s and the underscore that follows them is dropped, not doubled');
});
