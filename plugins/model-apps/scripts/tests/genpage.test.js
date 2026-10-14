'use strict';
// scripts/genpage.js: the command line, what each verb asks of the page backend and prints, and what it does on disk (download and types). The backend is the stand-in
// of helpers/fake-genpage.js, so a test says what the SCRIPT does with each answer; the backend's own behaviour is tested in genpage-sdk-verbs.test.js and
// genpage-verbs-real-bundle.test.js, and genpage-process.test.js runs the script as a process (the exit code, the single ASCII line on stdout) over the real bundle.
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { main, parseCommand, UsageError, VERBS } = require('../genpage.js');
const { fakeGenpage } = require('./helpers/fake-genpage.js');

const ENV = 'https://contoso.crm.dynamics.com';
const APP = '22222222-0000-4000-8000-0000000000bb';
const P1 = '11111111-0000-4000-8000-000000000001';
const P2 = '11111111-0000-4000-8000-000000000002';
const P3 = '11111111-0000-4000-8000-000000000003';
const SOURCE = 'export default function Page() { return null; }\n';

const roots = [];
function scratch(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `genpage-script-${label}-`));
  roots.push(dir);
  return dir;
}
after(() => { for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true }); });

// One command line through `main`, with the backend and the three ways out replaced: what was emitted (with how often the backend had been disposed at that moment), what went to stderr, and
// the usage errors.
async function run(argv, genpage = fakeGenpage()) {
  const seen = { emitted: [], stderr: [], usage: [], envs: [] };
  await main(argv, {
    makeGenpageSdk: (env) => { seen.envs.push(env); return genpage; },
    emit: (ok, payload) => { seen.emitted.push({ ok, payload, disposedWhenEmitted: genpage.disposed }); },
    usageError: (message, verb) => { seen.usage.push({ message, verb }); },
    stderr: (text) => { seen.stderr.push(text); },
  });
  seen.genpage = genpage;
  seen.result = seen.emitted[0];
  return seen;
}
const ok = (seen) => { assert.strictEqual(seen.emitted.length, 1, 'exactly one result is emitted'); assert.strictEqual(seen.emitted[0].ok, true, JSON.stringify(seen.emitted[0].payload)); return seen.emitted[0].payload; };
const failed = (seen) => { assert.strictEqual(seen.emitted.length, 1, 'exactly one result is emitted'); assert.strictEqual(seen.emitted[0].ok, false); return seen.emitted[0].payload; };
const pageOf = (id, over = {}) => ({ pageId: id, name: 'Overview', source: SOURCE, dataSources: ['account'], prompt: 'Show an overview', ...over });

// ── the command line ───────────────────────────────────────────────────────────────────────────────────────────────

test('the six commands are the verbs this script has — and nothing else', () => {
  assert.deepStrictEqual(Object.keys(VERBS), ['list', 'download', 'types', 'add-to-app', 'remove-from-app', 'delete']);
  for (const [name, spec] of Object.entries(VERBS)) {
    assert.ok(spec.usage.startsWith(`${name} --env <envUrl>`), `${name}: usage names the command and --env`);
    for (const flag of spec.needValue) assert.ok(spec.known.includes(flag), `${name}: --${flag} is a known flag`);
    for (const flag of spec.required) assert.ok(spec.known.includes(flag), `${name}: the required --${flag} is a known flag`);
    for (const flag of spec.switches || []) assert.ok(spec.known.includes(flag) && !spec.needValue.includes(flag), `${name}: --${flag} is a switch, with no value`);
  }
});

const BAD_COMMAND_LINES = [
  [[], /a command is required: list, download, types, add-to-app, remove-from-app or delete/, undefined],
  [['frob', '--env', ENV], /unknown command 'frob': list, download, types, add-to-app, remove-from-app or delete/, undefined],
  [['list'], /--env is required/, 'list'],
  [['list', '--env'], /--env requires a value/, 'list'],
  [['list', '--env', '  '], /--env requires a value/, 'list'],
  [['list', '--env', 'http://contoso.crm.dynamics.com'], /'http:\/\/contoso\.crm\.dynamics\.com' is not a Dataverse environment URL/, 'list'],
  [['list', '--env', 'https://contoso.crm.dynamics.com/main.aspx'], /is not a Dataverse environment URL/, 'list'],
  [['list', '--env', 'https://example.com'], /is not a Dataverse environment URL/, 'list'],
  [['list', '--env', ENV, '--bogus'], /unknown flag\(s\): --bogus/, 'list'],
  [['list', '--env', ENV, '--app-ids', APP], /unknown flag\(s\): --app-ids \(did you mean --app-id\?\)/, 'list'],
  [['list', '--env', ENV, '--app-id', 'nope'], /--app-id 'nope' is not an id: expected a GUID/, 'list'],
  [['list', '--env', ENV, '--app-id', APP, '--app-id', P1], /--app-id was given more than once/, 'list'],
  [['list', '--env', ENV, '--env', ENV], /--env was given more than once/, 'list'],
  [['list', '--env', ENV, `--app-id=${APP}`, '--app-id', APP], /--app-id was given more than once/, 'list'],
  [['list', '--env', ENV, '--include-unpublished', 'yes'], /--include-unpublished takes no value \(got 'yes'\)/, 'list'],
  [['list', '--env', ENV, 'extra'], /unexpected argument 'extra'/, 'list'],
  [['download', '--env', ENV, '--output-directory', 'out'], /--page-id is required/, 'download'],
  [['download', '--env', ENV, '--page-id', P1], /--output-directory is required/, 'download'],
  [['download', '--env', ENV, '--page-id', P1, '--output-directory'], /--output-directory requires a value/, 'download'],
  [['download', '--env', ENV, '--page-id', `${P1},nope`, '--output-directory', 'out'], /--page-id 'nope' is not an id/, 'download'],
  [['download', '--env', ENV, '--page-id', `${P1},${P1.toUpperCase()}`, '--output-directory', 'out'], /--page-id names a page more than once/, 'download'],
  [['download', '--env', ENV, '--page-id', ' , ', '--output-directory', 'out'], /--page-id names no page/, 'download'],
  [['download', '--env', ENV, '--page-id', P1, '--page-id', P2, '--output-directory', 'out'], /--page-id was given more than once: for several pages give one --page-id with the ids separated by commas/, 'download'],
  [['types', '--env', ENV, '--output-file', 'T.ts'], /--data-sources is required/, 'types'],
  [['types', '--env', ENV, '--data-sources', 'account'], /--output-file is required/, 'types'],
  [['types', '--env', ENV, '--data-sources', ' , ', '--output-file', 'T.ts'], /--data-sources ' , ' names no table/, 'types'],
  [['types', '--env', ENV, '--data-sources', 'account', '--output-file', 'T.ts', '--detail', 'loud'], /--detail must be one of: none, colors, descriptions \(got 'loud'\)/, 'types'],
  [['types', '--env', ENV, '--data-sources', 'account', '--output-file', 'T.ts', '--detail'], /--detail requires a value — one of: none, colors, descriptions/, 'types'],
  [['add-to-app', '--env', ENV, '--app-id', APP], /--page-id is required/, 'add-to-app'],
  [['add-to-app', '--env', ENV, '--page-id', P1], /--app-id is required/, 'add-to-app'],
  [['add-to-app', '--env', ENV, '--app-id', APP, '--page-id', `${P1},${P2}`], /--page-id '.*' is not an id/, 'add-to-app'],
  [['add-to-app', '--env', ENV, '--app-id', APP, '--page-id', P1, '--title'], /--title requires a value/, 'add-to-app'],
  [['remove-from-app', '--env', ENV, '--app-id', APP], /--page-id is required/, 'remove-from-app'],
  [['remove-from-app', '--env', ENV, '--app-id', APP, '--page-id', P1, '--allow-empty-navigation', 'yes'], /--allow-empty-navigation takes no value/, 'remove-from-app'],
  [['delete', '--env', ENV], /--page-id is required/, 'delete'],
  [['delete', '--env', ENV, '--page-id', P1, '--app-id', APP], /unknown flag\(s\): --app-id/, 'delete'],
  [['delete', '--env', ENV, '--page-id', P1, '--yes'], /unknown flag\(s\): --yes/, 'delete'],
  [['delete', '--env', ENV, '--page-id', P1, '--force'], /unknown flag\(s\): --force/, 'delete'],
  [['delete', '--env', ENV, '--page-id', P1, '--allow-destructive', 'yes'], /--allow-destructive takes no value \(got 'yes'\)/, 'delete'],
  [['remove-from-app', '--env', ENV, '--app-id', APP, '--page-id', P1, '--allow-destructive'], /unknown flag\(s\): --allow-destructive/, 'remove-from-app'],
];

test('a mistake in the command line is a usage error — named, before any backend is made, any request sent, or any result emitted', async () => {
  for (const [argv, message, verb] of BAD_COMMAND_LINES) {
    const seen = await run(argv);
    assert.strictEqual(seen.usage.length, 1, argv.join(' '));
    assert.match(seen.usage[0].message, message, argv.join(' '));
    assert.strictEqual(seen.usage[0].verb, verb, `${argv.join(' ')}: the usage printed is that of the command, or the general one`);
    assert.deepStrictEqual([seen.emitted.length, seen.envs.length, seen.genpage.calls.length], [0, 0, 0], `${argv.join(' ')}: nothing was made, asked or emitted`);
  }
});

test('parseCommand throws a UsageError that names the command, and returns the command a good line asks for', () => {
  assert.throws(() => parseCommand(['delete', '--env', ENV]), (e) => e instanceof UsageError && e.verb === 'delete' && /--page-id is required/.test(e.message));
  assert.throws(() => parseCommand([]), (e) => e instanceof UsageError && e.verb === undefined);

  assert.deepStrictEqual(parseCommand(['list', '--env', `${ENV}/`]), { verb: 'list', env: ENV, args: { includeUnpublished: false } }, 'the origin is normalized');
  assert.deepStrictEqual(parseCommand(['list', '--env', ENV, '--app-id', APP.toUpperCase(), '--include-unpublished']), { verb: 'list', env: ENV, args: { appId: APP, includeUnpublished: true } }, 'ids are lower-cased');
  assert.deepStrictEqual(parseCommand(['download', '--env', ENV, '--page-id', `${P1.toUpperCase()}, ${P2}`, '--output-directory', 'out', '--app-id', APP]), {
    verb: 'download', env: ENV, args: { appId: APP, pageIds: [P1, P2], outputDirectory: 'out' },
  });
  assert.deepStrictEqual(parseCommand(['types', '--env', ENV, '--data-sources', 'Account, contact', '--output-file', 'T.ts']), {
    verb: 'types', env: ENV, args: { dataSources: ['account', 'contact'], outputFile: 'T.ts', detail: 'none' },
  });
  assert.strictEqual(parseCommand(['types', '--env', ENV, '--data-sources', 'account', '--output-file', 'T.ts', '--detail', 'Descriptions']).args.detail, 'descriptions');
  assert.deepStrictEqual(parseCommand(['add-to-app', '--env', ENV, '--app-id', APP, '--page-id', P1, '--title', 'My page']).args, { appId: APP, pageId: P1, title: 'My page' });
  assert.deepStrictEqual(parseCommand(['remove-from-app', '--env', ENV, '--app-id', APP, '--page-id', P1]).args, { appId: APP, pageId: P1, allowEmpty: false });
  assert.strictEqual(parseCommand(['remove-from-app', '--env', ENV, '--app-id', APP, '--page-id', P1, '--allow-empty-navigation']).args.allowEmpty, true);
  assert.deepStrictEqual(parseCommand(['delete', `--env=${ENV}`, `--page-id=${P1}`]).args, { pageId: P1, allowDestructive: false });
  assert.deepStrictEqual(parseCommand(['delete', `--env=${ENV}`, `--page-id=${P1}`, '--allow-destructive']).args, { pageId: P1, allowDestructive: true });
});

// ── what main does around a verb ────────────────────────────────────────────────────────────────────────────────────

test('the backend is made for the environment the command names — and disposed, bounded, BEFORE the result is emitted, whether the verb worked or failed', async () => {
  const worked = await run(['list', '--env', `${ENV}/`], fakeGenpage({ pages: [pageOf(P1)] }));
  ok(worked);
  assert.deepStrictEqual(worked.envs, [ENV]);
  assert.strictEqual(worked.result.disposedWhenEmitted, 1, 'emitting ends the process, so the backend\'s workspace must be gone first');
  assert.deepStrictEqual(worked.genpage.disposeArgs, [{ waitMs: 10000 }], 'and its cleanup is bounded: one that never settles must not keep the script alive');

  const refused = await run(['delete', '--env', ENV, '--page-id', P1], fakeGenpage());
  failed(refused);
  assert.strictEqual(refused.result.disposedWhenEmitted, 1);
});

test('a backend whose cleanup throws does not change what is reported', async () => {
  const genpage = fakeGenpage({ pages: [pageOf(P1)] });
  genpage.dispose = () => { throw new Error('EBUSY'); };
  const seen = await run(['list', '--env', ENV], genpage);
  assert.strictEqual(ok(seen).count, 1);
});

// dispose() answers `{ left }`: the folders it could not remove, each still holding page source. A command that dropped the answer reported success with the source in the temp directory and not a word about it.
test('a workspace the backend could not remove is a warning of the result — success or failure — on stderr as well; nothing left, nothing said', async () => {
  const left = ['C:\\temp\\genpage-x1y2z3', 'C:\\temp\\genpage-a4b5c6'];
  const words = `the page workspace could not be removed, so page source may be left on disk: ${left.join(', ')} — delete the folder by hand`;
  const worked = await run(['list', '--env', ENV], fakeGenpage({ pages: [pageOf(P1)], left }));
  assert.deepStrictEqual(ok(worked).warnings, [words]);
  assert.deepStrictEqual(worked.stderr, [`⚠ ${words}\n`]);
  const refused = await run(['delete', '--env', ENV, '--page-id', P1], fakeGenpage({ left }));
  assert.deepStrictEqual(failed(refused).warnings, [words], 'a failure carries it too');
  assert.strictEqual(refused.result.disposedWhenEmitted, 1);
  // Beside the warnings of the verb itself, after them.
  const both = await run(['remove-from-app', '--env', ENV, '--app-id', APP, '--page-id', P1], fakeGenpage({ left, removal: () => ({ removed: [], wasInNavigation: false, appEdited: false, published: false, entriesLeft: 0, warnings: ['first words'] }) }));
  assert.deepStrictEqual(ok(both).warnings, ['first words', words]);
  const clean = await run(['list', '--env', ENV], fakeGenpage({ pages: [pageOf(P1)] }));
  assert.ok(!('warnings' in ok(clean)));
  assert.deepStrictEqual(clean.stderr, []);
});

test('warnings go to stderr, one `⚠` line each, before the result — and stay in the result', async () => {
  const genpage = fakeGenpage({ pages: [pageOf(P1)], removal: () => ({ removed: [], wasInNavigation: false, appEdited: false, published: false, entriesLeft: 0, warnings: ['first words', 'second words'] }) });
  const seen = await run(['remove-from-app', '--env', ENV, '--app-id', APP, '--page-id', P1], genpage);
  assert.deepStrictEqual(seen.stderr, ['⚠ first words\n', '⚠ second words\n']);
  assert.deepStrictEqual(ok(seen).warnings, ['first words', 'second words']);
  const quiet = await run(['remove-from-app', '--env', ENV, '--app-id', APP, '--page-id', P1], fakeGenpage());
  assert.deepStrictEqual(quiet.stderr, []);
  assert.ok(!('warnings' in ok(quiet)), 'an empty list is left out');
});

test('a failure prints the message, the SDK\'s or the script\'s code, and what the failed verb knew — and only what it knew', async () => {
  const known = Object.assign(new Error('page was not deleted: in use'), { code: 'GENPAGE_IN_APP', outcome: 'nothing', pageId: P1, apps: [{ uniqueName: 'contoso_sales', savedOnly: false }], transient: false, cause: new Error('hidden') });
  const seen = await run(['delete', '--env', ENV, '--page-id', P1], fakeGenpage({ deletion: () => { throw known; } }));
  assert.deepStrictEqual(failed(seen), { ok: false, error: 'page was not deleted: in use', code: 'GENPAGE_IN_APP', pageId: P1, outcome: 'nothing', apps: [{ uniqueName: 'contoso_sales', savedOnly: false }] });

  const bare = await run(['delete', '--env', ENV, '--page-id', P1], fakeGenpage({ deletion: () => { throw new Error('plain'); } }));
  assert.deepStrictEqual(failed(bare), { ok: false, error: 'plain' }, 'no code, nothing else');
  const notAnError = await run(['delete', '--env', ENV, '--page-id', P1], fakeGenpage({ deletion: () => { throw 'boom'; } })); // eslint-disable-line no-throw-literal
  assert.deepStrictEqual(failed(notAnError), { ok: false, error: 'boom' });
  const emptyCode = await run(['delete', '--env', ENV, '--page-id', P1], fakeGenpage({ deletion: () => { throw Object.assign(new Error('x'), { code: '', saved: true, appId: APP }); } }));
  assert.deepStrictEqual(failed(emptyCode), { ok: false, error: 'x', appId: APP, saved: true });
});

// ── list ─────────────────────────────────────────────────────────────────────────────────────────────────────────

test('list: every page of the environment, drafts included, sorted by name (any letter case) and then id — the name the page was given: pac stored `"` as `\\"` in the page\'s row, and the list reads it back', async () => {
  const genpage = fakeGenpage({ pages: [pageOf(P3, { name: 'beta' }), pageOf(P2, { name: 'Alpha' }), pageOf(P1, { name: 'alpha' }), pageOf('11111111-0000-4000-8000-000000000004', { name: 'Zed \\"q\\"' })] });
  const payload = ok(await run(['list', '--env', ENV], genpage));
  assert.deepStrictEqual(payload, {
    ok: true, scope: 'environment', count: 4,
    pages: [{ pageId: P1, name: 'alpha' }, { pageId: P2, name: 'Alpha' }, { pageId: P3, name: 'beta' }, { pageId: '11111111-0000-4000-8000-000000000004', name: 'Zed "q"' }],
  });
  assert.deepStrictEqual(genpage.calls.map((c) => c.method), ['enumerateEnv'], 'the environment\'s list, and nothing about an app');
  // pac's --include-unpublished is accepted and changes nothing here: this list always has the drafts.
  const withFlag = ok(await run(['list', '--env', ENV, '--include-unpublished'], fakeGenpage({ pages: [pageOf(P1)] })));
  assert.deepStrictEqual([withFlag.scope, withFlag.count], ['environment', 1]);
  assert.deepStrictEqual(ok(await run(['list', '--env', ENV])).pages, [], 'an environment with no page lists none');
});

test('list: an environment whose pages cannot be listed is a failure with the reason and the SDK\'s code — never an empty list', async () => {
  const seen = await run(['list', '--env', ENV], fakeGenpage({ enumerateError: 'could not list the environment\'s generative pages: HTTP 403' }));
  assert.deepStrictEqual(failed(seen), { ok: false, error: 'could not list the environment\'s generative pages: HTTP 403', code: 'GENPAGE_LIST_FAILED' });
  const genpage = fakeGenpage();
  genpage.enumerateEnv = async () => ({ ok: false, ids: [], error: 'could not list: forbidden', code: 'CONNECTION_ERROR' });
  assert.strictEqual(failed(await run(['list', '--env', ENV], genpage)).code, 'CONNECTION_ERROR');
});

test('list --app-id: the pages the app\'s PUBLISHED navigation names, in navigation order, each with its own name from the environment and the title of its entry', async () => {
  const genpage = fakeGenpage({
    pages: [pageOf(P1, { name: 'Real name one' }), pageOf(P2, { name: 'Real name two' })],
    appPages: { [APP]: [{ pageId: P2.toUpperCase(), name: 'Second (nav)' }, { pageId: P1, name: 'First (nav)' }, { pageId: P3, name: 'Dangling (nav)' }, { pageId: '11111111-0000-4000-8000-000000000005' }] },
  });
  const payload = ok(await run(['list', '--env', ENV, '--app-id', APP.toUpperCase()], genpage));
  assert.deepStrictEqual(payload, {
    ok: true, scope: 'app', appId: APP, layer: 'published', count: 4,
    pages: [
      { pageId: P2.toUpperCase(), name: 'Real name two', title: 'Second (nav)' },
      { pageId: P1, name: 'Real name one', title: 'First (nav)' },
      { pageId: P3, name: null, title: 'Dangling (nav)', exists: false },
      { pageId: '11111111-0000-4000-8000-000000000005', name: null, exists: false },
    ],
  });
  assert.deepStrictEqual(genpage.of('enumeratePages').map((c) => c.args), [[APP, { includeUnpublished: false }]], 'the published layer, by the app id in lower case');
});

// pac stores every `"` of a page name as `\"` (live-measured: `Say "hi" now` became `Say \"hi\" now`, in the page's row and in a navigation title pac writes), and every other reader of a stored name reads it back: the
// build, teardown, the download of an app. A name shown as stored would not be the name those use for the same page — and "look for the page before creating it again" compares names.
test('list --app-id: a page name pac stored with `\\"` is shown as the name it was given — and the entry\'s title is what the navigation holds, as stored', async () => {
  const stored = 'Say \\"hi\\" now';
  const genpage = fakeGenpage({ pages: [pageOf(P1, { name: stored })], appPages: { [APP]: [{ pageId: P1, name: stored }] } });
  const payload = ok(await run(['list', '--env', ENV, '--app-id', APP], genpage));
  assert.deepStrictEqual(payload.pages, [{ pageId: P1, name: 'Say "hi" now', title: stored }]);
});

test('list --app-id --include-unpublished: the app\'s SAVED navigation, and the layer says so', async () => {
  const genpage = fakeGenpage({ pages: [pageOf(P1)], appPages: { [APP]: [{ pageId: P1, name: 'One' }] } });
  const payload = ok(await run(['list', '--env', ENV, '--app-id', APP, '--include-unpublished'], genpage));
  assert.deepStrictEqual([payload.layer, payload.count], ['saved', 1]);
  assert.deepStrictEqual(genpage.of('enumeratePages')[0].args, [APP, { includeUnpublished: true }]);
});

test('list --app-id: an app whose navigation cannot be read is a failure — with the way to read the saved one when the published one was asked for — and so is an environment that cannot be listed', async () => {
  const unread = fakeGenpage({ appPages: () => ({ ok: false, pages: [], error: `app ${APP} has no published form — it was never published, or does not exist` }) });
  const published = failed(await run(['list', '--env', ENV, '--app-id', APP], unread));
  assert.strictEqual(published.code, 'GENPAGE_APP_UNREADABLE');
  assert.strictEqual(published.appId, APP);
  assert.match(published.error, /has no published form.*\(--include-unpublished reads the app's saved navigation instead\)$/);
  const saved = failed(await run(['list', '--env', ENV, '--app-id', APP, '--include-unpublished'], unread));
  assert.ok(!/--include-unpublished reads/.test(saved.error), 'asked for the saved layer already: no hint to ask for it');
  const typed = fakeGenpage({ appPages: () => ({ ok: false, pages: [], error: 'could not read the navigation', code: 'CONNECTION_ERROR' }) });
  assert.strictEqual(failed(await run(['list', '--env', ENV, '--app-id', APP], typed)).code, 'CONNECTION_ERROR');

  const noEnv = fakeGenpage({ appPages: { [APP]: [{ pageId: P1, name: 'One' }] }, enumerateError: 'could not list pages' });
  const both = failed(await run(['list', '--env', ENV, '--app-id', APP], noEnv));
  assert.deepStrictEqual([both.code, both.appId], ['GENPAGE_LIST_FAILED', APP]);
});

// ── download ─────────────────────────────────────────────────────────────────────────────────────────────────────

const read = (...parts) => fs.readFileSync(path.join(...parts));
const downloadArgs = (out, ...ids) => ['download', '--env', ENV, '--page-id', ids.join(','), '--output-directory', out];

test('download: <output>/<page id>/{page.tsx, config.json, prompt.txt}, with the bytes the page holds — no byte order mark, no line ending added — and what was written is reported', async () => {
  const out = path.join(scratch('dl'), 'pages');
  const genpage = fakeGenpage({ pages: [pageOf(P1, { source: 'const x = 1;\r\n// é\n', name: 'Überblick' }), pageOf(P2, { prompt: undefined, dataSources: [] })] });
  const payload = ok(await run(downloadArgs(out, P1, P2.toUpperCase()), genpage));
  const root = fs.realpathSync(out);
  assert.deepStrictEqual(payload, {
    ok: true,
    outputDirectory: root,
    pages: [
      { pageId: P1, name: 'Überblick', directory: path.join(root, P1), files: ['page.tsx', 'config.json', 'prompt.txt'] },
      { pageId: P2, name: 'Overview', directory: path.join(root, P2), files: ['page.tsx', 'config.json'] },
    ],
  });
  assert.deepStrictEqual(read(root, P1, 'page.tsx'), Buffer.from('const x = 1;\r\n// é\n', 'utf8'), 'the source as stored: its own CRLF kept, no BOM, nothing appended');
  assert.strictEqual(read(root, P1, 'config.json').toString('utf8'), '{"dataSources":["account"]}');
  assert.strictEqual(read(root, P1, 'prompt.txt').toString('utf8'), 'Show an overview');
  assert.strictEqual(read(root, P2, 'config.json').toString('utf8'), '{"dataSources":[]}');
  assert.ok(!fs.existsSync(path.join(root, P2, 'prompt.txt')), 'a page with no prompt has no prompt.txt, which a rebuild reads as "no prompt supplied"');
  assert.deepStrictEqual(fs.readdirSync(path.join(root, P1)).sort(), ['config.json', 'page.tsx', 'prompt.txt'], 'no page.js, no temp file left behind');
  assert.deepStrictEqual(genpage.of('read').map((c) => c.args), [[P1], [P2]]);
});

test('download: the name reported is the one the page was given — pac\'s `\\"` read back — and a page with no name stays without one', async () => {
  const out = scratch('dlname');
  const payload = ok(await run(downloadArgs(out, P1, P2), fakeGenpage({ pages: [pageOf(P1, { name: 'Say \\"hi\\" now' }), pageOf(P2, { name: null })] })));
  assert.strictEqual(payload.pages[0].name, 'Say "hi" now');
  assert.strictEqual(payload.pages[1].name, null, 'a missing name is not turned into the text "null"');
});

test('download: a conversation of several prompts is the transcript a rebuild reads — pac\'s own words — and an existing file is replaced and said to be, an identical one is not', async () => {
  const out = scratch('replace');
  const conversation = [{ sender: 'user', message: 'Show an overview' }, { sender: 'agent', message: 'Done' }, { sender: 'user', message: 'Add a bar chart' }];
  const first = ok(await run(downloadArgs(out, P1), fakeGenpage({ pages: [pageOf(P1, { conversation })] })));
  assert.strictEqual(read(first.pages[0].directory, 'prompt.txt').toString('utf8'), 'Conversation with 2 prompts:\r\n1. Show an overview\r\n2. Add a bar chart');
  assert.ok(!('replaced' in first.pages[0]) && !('removed' in first.pages[0]), 'nothing was there before');

  const again = ok(await run(downloadArgs(out, P1), fakeGenpage({ pages: [pageOf(P1, { conversation })] })));
  assert.ok(!('replaced' in again.pages[0]), 'the same bytes are not a replacement');

  const changed = ok(await run(downloadArgs(out, P1), fakeGenpage({ pages: [pageOf(P1, { source: 'const y = 2;\n', conversation })] })));
  assert.deepStrictEqual(changed.pages[0].replaced, ['page.tsx']);
  assert.strictEqual(read(changed.pages[0].directory, 'page.tsx').toString('utf8'), 'const y = 2;\n');
});

test('download: a prompt.txt an earlier download left is removed when the page has no prompt — it would be read as this page\'s — and the removal is said', async () => {
  const out = scratch('stale');
  ok(await run(downloadArgs(out, P1), fakeGenpage({ pages: [pageOf(P1)] })));
  const directory = path.join(fs.realpathSync(out), P1);
  assert.ok(fs.existsSync(path.join(directory, 'prompt.txt')));
  const payload = ok(await run(downloadArgs(out, P1), fakeGenpage({ pages: [pageOf(P1, { prompt: undefined })] })));
  assert.deepStrictEqual(payload.pages[0].removed, ['prompt.txt']);
  assert.ok(!fs.existsSync(path.join(directory, 'prompt.txt')));
  const next = ok(await run(downloadArgs(out, P1), fakeGenpage({ pages: [pageOf(P1, { prompt: undefined })] })));
  assert.ok(!('removed' in next.pages[0]), 'nothing left to remove');
});

test('download: every page is read before a file is written — one that cannot be read leaves the folder as it was, and every failure is named', async () => {
  const out = path.join(scratch('readall'), 'pages');
  const genpage = fakeGenpage({ pages: [pageOf(P1)] });
  const seen = await run(downloadArgs(out, P1, P2, P3), genpage);
  const payload = failed(seen);
  assert.strictEqual(payload.code, 'GENPAGE_NOT_FOUND', 'one code for all of the failures');
  assert.match(payload.error, new RegExp(`^nothing was downloaded: page ${P2}: .*does not exist.*; page ${P3}: .*does not exist`));
  assert.deepStrictEqual(payload.failed.map((f) => [f.pageId, f.code]), [[P2, 'GENPAGE_NOT_FOUND'], [P3, 'GENPAGE_NOT_FOUND']]);
  assert.deepStrictEqual(genpage.of('read').map((c) => c.args[0]), [P1, P2, P3], 'all of them were read');
  assert.ok(!fs.existsSync(out), 'not even the output folder was made');

  const mixed = fakeGenpage({ pages: [pageOf(P1), pageOf(P2, { raw: true })] });
  const both = failed(await run(downloadArgs(out, P1, P2, P3), mixed));
  assert.strictEqual(both.code, 'GENPAGE_READ_FAILED', 'different codes: the umbrella one');
  assert.deepStrictEqual(both.failed.map((f) => f.code), ['GENPAGE_NO_SOURCE', 'GENPAGE_NOT_FOUND']);
  assert.ok(!fs.existsSync(out));
});

test('download --app-id: the pages must be in the app\'s SAVED navigation — checked before any page is read or any file written — and any that is not is named', async () => {
  const out = path.join(scratch('inapp'), 'pages');
  const genpage = fakeGenpage({ pages: [pageOf(P1), pageOf(P2)], appPages: { [APP]: [{ pageId: P1.toUpperCase(), name: 'One' }, { pageId: P3, name: 'Three' }] } });
  const refused = failed(await run([...downloadArgs(out, P1, P2), '--app-id', APP], genpage));
  assert.strictEqual(refused.code, 'GENPAGE_NOT_IN_APP');
  assert.deepStrictEqual([refused.appId, refused.pageIds], [APP, [P2]]);
  assert.match(refused.error, new RegExp(`^page ${P2} is not in the navigation of app ${APP}, so nothing was downloaded`));
  assert.deepStrictEqual(genpage.of('enumeratePages').map((c) => c.args), [[APP, { includeUnpublished: true }]]);
  assert.strictEqual(genpage.of('read').length, 0, 'no page was read');
  assert.ok(!fs.existsSync(out));

  const several = failed(await run([...downloadArgs(out, P1, P2, P3), '--app-id', APP], fakeGenpage({ pages: [pageOf(P1)], appPages: { [APP]: [{ pageId: P1, name: 'One' }] } })));
  assert.match(several.error, new RegExp(`^pages ${P2}, ${P3} are not in the navigation`));

  const allowed = ok(await run([...downloadArgs(out, P1), '--app-id', APP], genpage));
  assert.strictEqual(allowed.pages.length, 1, 'a page the navigation names is downloaded');
  const unreadable = failed(await run([...downloadArgs(out, P1), '--app-id', APP], fakeGenpage({ appPages: () => ({ ok: false, pages: [], error: 'the app cannot be read', code: 'CONNECTION_ERROR' }) })));
  assert.deepStrictEqual([unreadable.code, unreadable.appId], ['CONNECTION_ERROR', APP]);
});

test('download: a hard link at a file\'s name is refused for EVERY page before the first file is written — and what the link points at is left as it was', async () => {
  const out = scratch('link');
  const victim = path.join(scratch('victim'), 'precious.txt');
  fs.writeFileSync(victim, 'precious');
  fs.mkdirSync(path.join(out, P2), { recursive: true });
  fs.linkSync(victim, path.join(out, P2, 'page.tsx'));
  const payload = failed(await run(downloadArgs(out, P1, P2), fakeGenpage({ pages: [pageOf(P1), pageOf(P2)] })));
  assert.strictEqual(payload.code, 'UNSAFE_OUTPUT');
  assert.ok(!fs.existsSync(path.join(out, P1)), 'the first page was not written either: the refusal came before any write');
  assert.strictEqual(fs.readFileSync(victim, 'utf8'), 'precious');
});

test('download: a link at the output folder, or at a page\'s folder, is refused', async () => {
  const outside = scratch('outside');
  const parent = scratch('linkdir');
  const out = path.join(parent, 'out');
  fs.symlinkSync(outside, out, process.platform === 'win32' ? 'junction' : 'dir');
  assert.strictEqual(failed(await run(downloadArgs(out, P1), fakeGenpage({ pages: [pageOf(P1)] }))).code, 'UNSAFE_OUTPUT');
  assert.deepStrictEqual(fs.readdirSync(outside), [], 'nothing was written through the link');

  const real = scratch('realdir');
  fs.symlinkSync(outside, path.join(real, P1), process.platform === 'win32' ? 'junction' : 'dir');
  assert.strictEqual(failed(await run(downloadArgs(real, P1), fakeGenpage({ pages: [pageOf(P1)] }))).code, 'UNSAFE_OUTPUT');
  assert.deepStrictEqual(fs.readdirSync(outside), []);
});

// A link whose target is missing is still a link. The pre-flight looked at a page's folder only `if (fs.existsSync(directory))`, and existsSync FOLLOWS the link: a dangling one answered "no folder", was not
// inspected, and was refused only at the write of ITS page — after the pages before it had been written, which is what the all-or-nothing pre-flight exists to prevent.
test('download: a DANGLING link at the folder of a LATER page is refused before the first page is written too — the earlier download of the first page stays as it was', async () => {
  const real = scratch('dangling');
  fs.mkdirSync(path.join(real, P1));
  fs.writeFileSync(path.join(real, P1, 'page.tsx'), 'the earlier download\n');
  fs.symlinkSync(path.join(real, 'missing-target'), path.join(real, P2), process.platform === 'win32' ? 'junction' : 'dir');
  const payload = failed(await run(downloadArgs(real, P1, P2), fakeGenpage({ pages: [pageOf(P1), pageOf(P2)] })));
  assert.strictEqual(payload.code, 'UNSAFE_OUTPUT');
  assert.strictEqual(read(real, P1, 'page.tsx').toString('utf8'), 'the earlier download\n', 'the first page was not rewritten: the refusal came before any write');
  assert.ok(!fs.existsSync(path.join(real, 'missing-target')), 'and nothing was made where the link points');
});

test('download: a link at the folder of a LATER page is refused before the first page is written — the pages before it are not left half done', async () => {
  const outside = scratch('outsidelater');
  const real = scratch('realdirlater');
  fs.symlinkSync(outside, path.join(real, P2), process.platform === 'win32' ? 'junction' : 'dir');
  const payload = failed(await run(downloadArgs(real, P1, P2), fakeGenpage({ pages: [pageOf(P1), pageOf(P2)] })));
  assert.strictEqual(payload.code, 'UNSAFE_OUTPUT');
  assert.ok(!fs.existsSync(path.join(real, P1)), 'the first page was not written: the refusal came before any write');
  assert.deepStrictEqual(fs.readdirSync(outside), [], 'and nothing went through the link');
});

// ── types ────────────────────────────────────────────────────────────────────────────────────────────────────────

const typesArgs = (file, ...rest) => ['types', '--env', ENV, '--data-sources', 'Account, contact', '--output-file', file, ...rest];

test('types: the SDK\'s text is written exactly as it came — LF, no byte order mark, the first blank line kept — to the file, whose folder is made, and the bytes are counted', async () => {
  const file = path.join(scratch('types'), 'deeper', 'RuntimeTypes.ts');
  const text = '\n// ---- types ----\nexport type Café = 1;\n';
  const genpage = fakeGenpage({ types: text });
  const payload = ok(await run(typesArgs(file), genpage));
  assert.deepStrictEqual(payload, { ok: true, outputFile: fs.realpathSync(file), dataSources: ['account', 'contact'], detail: 'none', bytes: Buffer.byteLength(text, 'utf8') });
  assert.deepStrictEqual(fs.readFileSync(file), Buffer.from(text, 'utf8'));
  assert.deepStrictEqual(genpage.of('runtimeTypes').map((c) => c.args), [[['account', 'contact'], { detail: 'None' }]]);
  assert.strictEqual(payload.bytes, text.length + 1, 'bytes, not characters: é is two');
});

test('types: --detail is the SDK\'s level — colors or descriptions add comments — and an existing file is replaced', async () => {
  const file = path.join(scratch('detail'), 'T.ts');
  fs.writeFileSync(file, 'old');
  const genpage = fakeGenpage({ types: (tables, options) => `// ${options.detail}\n` });
  assert.strictEqual(ok(await run(typesArgs(file, '--detail', 'colors'), genpage)).detail, 'colors');
  assert.strictEqual(ok(await run(typesArgs(file, '--detail', 'DESCRIPTIONS'), genpage)).detail, 'descriptions');
  assert.deepStrictEqual(genpage.of('runtimeTypes').map((c) => c.args[1]), [{ detail: 'ColorsDefaultsConstraints' }, { detail: 'ColorsDefaultsConstraintsDescriptions' }]);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), '// ColorsDefaultsConstraintsDescriptions\n');
});

test('types: the output name is checked BEFORE the environment is asked — a directory, a hard link or a linked folder is refused whatever the types would have been', async () => {
  const dir = scratch('typesdir');
  const genpage = fakeGenpage();
  const atDirectory = failed(await run(typesArgs(dir), genpage));
  assert.ok(atDirectory.code, 'a directory at the name is refused with a code');
  assert.strictEqual(genpage.of('runtimeTypes').length, 0, 'the SDK was not asked');

  const victim = path.join(scratch('typesvictim'), 'precious.txt');
  fs.writeFileSync(victim, 'precious');
  const hard = path.join(dir, 'hard.ts');
  fs.linkSync(victim, hard);
  assert.strictEqual(failed(await run(typesArgs(hard), genpage)).code, 'UNSAFE_OUTPUT');
  assert.strictEqual(genpage.of('runtimeTypes').length, 0);
  assert.strictEqual(fs.readFileSync(victim, 'utf8'), 'precious');

  const outside = scratch('typesoutside');
  const linked = path.join(scratch('typeslink'), 'linked');
  fs.symlinkSync(outside, linked, process.platform === 'win32' ? 'junction' : 'dir');
  assert.strictEqual(failed(await run(typesArgs(path.join(linked, 'T.ts')), genpage)).code, 'UNSAFE_OUTPUT');
  assert.strictEqual(genpage.of('runtimeTypes').length, 0);
  assert.deepStrictEqual(fs.readdirSync(outside), []);
});

test('types: a DANGLING linked folder is refused before the environment is asked, like a linked one — a link whose target is missing is still a link', async () => {
  const parent = scratch('typesdangling');
  const linked = path.join(parent, 'linked');
  fs.symlinkSync(path.join(parent, 'missing-target'), linked, process.platform === 'win32' ? 'junction' : 'dir');
  const genpage = fakeGenpage();
  assert.strictEqual(failed(await run(typesArgs(path.join(linked, 'T.ts')), genpage)).code, 'UNSAFE_OUTPUT');
  assert.strictEqual(genpage.of('runtimeTypes').length, 0, 'the SDK was not asked');
  assert.ok(!fs.existsSync(path.join(parent, 'missing-target')), 'and nothing was made where the link points');
});

// An entry that cannot be inspected is a reason to look at it, not to skip it: where `lstat` of the output folder fails with anything but "not there" (here: access refused), the pre-flight must refuse it
// before the environment is asked, as it refuses any other output folder it cannot use — and not read the failure as an absent folder to be made later.
test('types: an output folder that cannot be inspected is refused before the environment is asked — it is not "not there"', async () => {
  const parent = path.join(scratch('typesnoaccess'), 'out');
  fs.mkdirSync(parent);
  const lstat = fs.lstatSync;
  fs.lstatSync = (target, ...rest) => {
    if (path.resolve(String(target)) === path.resolve(parent)) throw Object.assign(new Error(`EACCES: permission denied, lstat '${target}'`), { code: 'EACCES' });
    return lstat(target, ...rest);
  };
  const genpage = fakeGenpage();
  try {
    const payload = failed(await run(typesArgs(path.join(parent, 'T.ts')), genpage));
    assert.strictEqual(payload.code, 'UNSAFE_OUTPUT');
    assert.match(payload.error, /could not be inspected \(EACCES\)/);
  } finally {
    fs.lstatSync = lstat;
  }
  assert.strictEqual(genpage.of('runtimeTypes').length, 0, 'the SDK was not asked');
});

test('types: a table the environment does not have is its own failure — GENPAGE_TABLE_NOT_FOUND, naming the table, no file made', async () => {
  const file = path.join(scratch('typesmissing'), 'sub', 'T.ts');
  const missing = Object.assign(new Error('table \'nosuchtable\' does not exist in this environment, so no types were generated'), { code: 'GENPAGE_TABLE_NOT_FOUND', table: 'nosuchtable', transient: false });
  const payload = failed(await run(typesArgs(file), fakeGenpage({ types: () => { throw missing; } })));
  assert.deepStrictEqual(payload, { ok: false, error: missing.message, code: 'GENPAGE_TABLE_NOT_FOUND', table: 'nosuchtable' });
  assert.ok(!fs.existsSync(file) && !fs.existsSync(path.dirname(file)), 'neither the file nor its folder');
});

test('types: a failure of the SDK is the failure — its code, no file made', async () => {
  const file = path.join(scratch('typesfail'), 'sub', 'T.ts');
  const refusal = Object.assign(new Error('HTTP 404 from the metadata endpoint'), { code: 'CONNECTION_ERROR', statusCode: 404 });
  const payload = failed(await run(typesArgs(file), fakeGenpage({ types: () => { throw refusal; } })));
  assert.deepStrictEqual([payload.code, payload.error], ['CONNECTION_ERROR', 'HTTP 404 from the metadata endpoint']);
  assert.ok(!fs.existsSync(file) && !fs.existsSync(path.dirname(file)), 'neither the file nor its folder');
});

// ── add-to-app ───────────────────────────────────────────────────────────────────────────────────────────────────

const addArgs = (...rest) => ['add-to-app', '--env', ENV, '--app-id', APP, '--page-id', P1, ...rest];

test('add-to-app: the page is read first, the environment\'s base language is asked, and the page is placed — titled with its own name, in that language, with the views of its tables — and the app is published', async () => {
  const genpage = fakeGenpage({
    pages: [pageOf(P1, { name: 'Pipeline', dataSources: ['account', 'contact'] })],
    language: 1031,
    placement: () => ({ added: [P1], alreadyPlaced: [], pinnedViews: ['v-1', 'v-2'], warnings: [], appEdited: true, provedPublished: true }),
  });
  const payload = ok(await run(addArgs(), genpage));
  assert.deepStrictEqual(payload, {
    ok: true, appId: APP, pageId: P1, added: true, alreadyPlaced: false, title: 'Pipeline', appEdited: true, published: true, pinnedViews: ['v-1', 'v-2'], dataSources: ['account', 'contact'], languageCode: 1031,
  });
  assert.deepStrictEqual(genpage.calls.map((c) => c.method), ['describe', 'baseLanguage', 'placeInApp']);
  assert.deepStrictEqual(genpage.of('placeInApp')[0].args, [APP, { pages: [{ pageId: P1, title: 'Pipeline' }], dataSources: ['account', 'contact'], languageCode: 1031, finishIfUnpublished: true }]);
});

test('add-to-app: --title is the entry\'s title instead of the page\'s name', async () => {
  const genpage = fakeGenpage({ pages: [pageOf(P1, { name: 'Pipeline' })] });
  const payload = ok(await run(addArgs('--title', 'Sales pipeline'), genpage));
  assert.strictEqual(payload.title, 'Sales pipeline');
  assert.strictEqual(genpage.of('placeInApp')[0].args[1].pages[0].title, 'Sales pipeline');
});

test('add-to-app: a page pac created is titled with the name it was given — its `\\"` read back, as the build reads it — and a --title is used exactly as typed', async () => {
  const genpage = fakeGenpage({ pages: [pageOf(P1, { name: 'Say \\"hi\\" now' })] });
  const payload = ok(await run(addArgs(), genpage));
  assert.strictEqual(genpage.of('placeInApp')[0].args[1].pages[0].title, 'Say "hi" now', 'the entry the app\'s users open');
  assert.strictEqual(payload.title, 'Say "hi" now');
  const typed = fakeGenpage({ pages: [pageOf(P1, { name: 'Say \\"hi\\" now' })] });
  assert.strictEqual(ok(await run(addArgs('--title', 'A \\"typed\\" title'), typed)).title, 'A \\"typed\\" title');
  assert.strictEqual(typed.of('placeInApp')[0].args[1].pages[0].title, 'A \\"typed\\" title', 'what the user typed is never rewritten');
});

test('add-to-app: a page the navigation already names is left alone — it says so, the title is not claimed, and --title is said to be ignored', async () => {
  const placement = (extra = {}) => () => ({ added: [], alreadyPlaced: [P1], pinnedViews: [], warnings: [], appEdited: false, ...extra });
  const shown = ok(await run(addArgs(), fakeGenpage({ pages: [pageOf(P1)], placement: placement() })));
  assert.deepStrictEqual([shown.added, shown.alreadyPlaced, shown.appEdited, shown.published], [false, true, false, false]);
  assert.ok(!('title' in shown), 'no entry was added, so there is no title to report');
  assert.ok(!('warnings' in shown));

  const finished = ok(await run(addArgs(), fakeGenpage({ pages: [pageOf(P1)], placement: placement({ provedPublished: true }) })));
  assert.deepStrictEqual([finished.alreadyPlaced, finished.appEdited, finished.published], [true, false, true], 'an app published again to show a placement saved earlier is published');

  const titled = await run(addArgs('--title', 'Other title'), fakeGenpage({ pages: [pageOf(P1)], placement: placement() }));
  assert.deepStrictEqual(ok(titled).warnings, ['the page was already in the app\'s navigation, so --title was not applied: an entry that is there is left as it is']);
  assert.deepStrictEqual(titled.stderr, ['⚠ the page was already in the app\'s navigation, so --title was not applied: an entry that is there is left as it is\n']);
});

test('add-to-app: a published navigation that could not be read back is the backend\'s warning, carried — the placement is reported as published, not as proved', async () => {
  const warning = 'app was published again, but its published navigation could not be read back';
  const payload = ok(await run(addArgs(), fakeGenpage({ pages: [pageOf(P1)], placement: () => ({ added: [P1], alreadyPlaced: [], pinnedViews: [], warnings: [warning], appEdited: true, provedPublished: false }) })));
  assert.deepStrictEqual([payload.published, payload.warnings], [true, [warning]]);
});

test('add-to-app: a page held as raw files is placed with no table known — nothing is pinned for it, and the gap is said', async () => {
  const genpage = fakeGenpage({ pages: [pageOf(P1, { raw: true })] });
  const payload = ok(await run(addArgs(), genpage));
  assert.deepStrictEqual(payload.dataSources, []);
  assert.strictEqual(payload.warnings.length, 1);
  assert.match(payload.warnings[0], new RegExp(`page ${P1} is held as raw files, so the tables it reads are not known and no view was pinned for it`));
  assert.deepStrictEqual(genpage.of('placeInApp')[0].args[1].dataSources, []);
});

test('add-to-app: a page that is not there is refused before anything about the app is asked, and a language that cannot be read before the app is touched', async () => {
  const none = fakeGenpage();
  const refused = failed(await run(addArgs(), none));
  assert.strictEqual(refused.code, 'GENPAGE_NOT_FOUND');
  assert.deepStrictEqual(none.calls.map((c) => c.method), ['describe']);

  const noLanguage = fakeGenpage({ pages: [pageOf(P1)], languageError: Object.assign(new Error('could not read the languages'), { code: 'CONNECTION_ERROR' }) });
  const payload = failed(await run(addArgs(), noLanguage));
  assert.strictEqual(payload.code, 'CONNECTION_ERROR');
  assert.strictEqual(noLanguage.of('placeInApp').length, 0, 'no guess at the language: a title in a language the environment has not provisioned does not show');
});

test('add-to-app: a placement the backend refuses or could not finish is the failure — with the code, and with `saved` when the navigation was saved', async () => {
  const unfinished = Object.assign(new Error('the navigation was saved, but publishing the app failed'), { code: 'GENPAGE_APP_PUBLISH_FAILED', saved: true });
  const payload = failed(await run(addArgs(), fakeGenpage({ pages: [pageOf(P1)], placement: () => { throw unfinished; } })));
  assert.deepStrictEqual(payload, { ok: false, error: 'the navigation was saved, but publishing the app failed', code: 'GENPAGE_APP_PUBLISH_FAILED', saved: true });
});

// ── remove-from-app ──────────────────────────────────────────────────────────────────────────────────────────────

test('remove-from-app: what the backend did is what is printed, with the ids — and --allow-empty-navigation is the backend\'s allowEmpty, only when given', async () => {
  const genpage = fakeGenpage();
  const payload = ok(await run(['remove-from-app', '--env', ENV, '--app-id', APP.toUpperCase(), '--page-id', P1.toUpperCase()], genpage));
  assert.deepStrictEqual(payload, { ok: true, appId: APP, pageId: P1, removed: [{ area: 'Main', group: 'Pages', count: 1 }], wasInNavigation: true, appEdited: true, published: true, entriesLeft: 1, provedPublished: true });
  assert.deepStrictEqual(genpage.of('removeFromApp')[0].args, [APP, P1, { allowEmpty: false }]);

  const allowed = fakeGenpage();
  ok(await run(['remove-from-app', '--env', ENV, '--app-id', APP, '--page-id', P1, '--allow-empty-navigation'], allowed));
  assert.deepStrictEqual(allowed.of('removeFromApp')[0].args[2], { allowEmpty: true });
});

test('remove-from-app: a page the navigation does not name is reported as not in it — a result, not a failure', async () => {
  const removal = () => ({ removed: [], wasInNavigation: false, appEdited: false, published: false, entriesLeft: 3, warnings: [] });
  const payload = ok(await run(['remove-from-app', '--env', ENV, '--app-id', APP, '--page-id', P1], fakeGenpage({ removal })));
  assert.deepStrictEqual([payload.wasInNavigation, payload.appEdited, payload.published, payload.removed], [false, false, false, []]);
});

test('remove-from-app: the refusal to empty a navigation, and a removal that was saved and not published, are failures that say so — the code, the ids, what was written', async () => {
  const empty = Object.assign(new Error('would leave its navigation with no entry'), { code: 'GENPAGE_NAVIGATION_WOULD_BE_EMPTY', outcome: 'nothing', appId: APP, pageId: P1 });
  assert.deepStrictEqual(failed(await run(['remove-from-app', '--env', ENV, '--app-id', APP, '--page-id', P1], fakeGenpage({ removal: () => { throw empty; } }))), {
    ok: false, error: 'would leave its navigation with no entry', code: 'GENPAGE_NAVIGATION_WOULD_BE_EMPTY', appId: APP, pageId: P1, outcome: 'nothing',
  });
  const unpublished = Object.assign(new Error('publishing the app failed'), { code: 'GENPAGE_APP_PUBLISH_FAILED', saved: true, appId: APP, pageId: P1 });
  const payload = failed(await run(['remove-from-app', '--env', ENV, '--app-id', APP, '--page-id', P1], fakeGenpage({ removal: () => { throw unpublished; } })));
  assert.deepStrictEqual([payload.code, payload.saved], ['GENPAGE_APP_PUBLISH_FAILED', true]);
});

// ── delete ───────────────────────────────────────────────────────────────────────────────────────────────────────

test('delete: exactly what was deleted — the page, the rows of its folder, the messages of its conversation — and that the page was read back as gone; the name is the one the page was given', async () => {
  const genpage = fakeGenpage({ pages: [pageOf(P1, { name: 'Say \\"hi\\" now', fileRows: 5, conversation: [{ sender: 'user', message: 'a' }, { sender: 'agent', message: 'b' }] })] });
  const payload = ok(await run(['delete', '--env', ENV, '--page-id', P1.toUpperCase(), '--allow-destructive'], genpage));
  assert.deepStrictEqual(payload, { ok: true, deleted: { pageId: P1, name: 'Say "hi" now', fileRows: 5, conversationMessages: 2 }, historyRemoved: true, verified: true });
  assert.deepStrictEqual(genpage.of('delete').map((c) => c.args), [[P1, { allowDestructive: true }]]);
  assert.ok(!genpage.pages.has(P1));
});

// A delete is asked for in so many words. The backend refuses without `allowDestructive` — after the reads that decide the delete, so the refusal says what would go — and this script passes it on only when
// `--allow-destructive` was given: a refusal is a result (exit 1, one line), never a usage error, because the command line was a good one.
test('delete: without --allow-destructive the backend is asked not to delete — its refusal is the failure, with what would go, and the page is still there', async () => {
  const genpage = fakeGenpage({ pages: [pageOf(P1, { name: 'Overview', fileRows: 5, conversation: [{ sender: 'user', message: 'a' }, { sender: 'agent', message: 'b' }] })] });
  const seen = await run(['delete', '--env', ENV, '--page-id', P1], genpage);
  assert.deepStrictEqual(seen.usage, [], 'a refusal, not a usage error');
  const payload = failed(seen);
  assert.deepStrictEqual([payload.code, payload.outcome, payload.pageId, payload.fileRows, payload.conversationMessages], ['GENPAGE_DELETE_NOT_CONFIRMED', 'nothing', P1, 5, 2]);
  assert.match(payload.error, /deleting it removes the page, its 5 file rows and its 2 conversation messages\. Nothing was changed; run the same command with --allow-destructive to delete them$/);
  assert.deepStrictEqual(genpage.of('delete').map((c) => c.args), [[P1, { allowDestructive: false }]]);
  assert.ok(genpage.pages.has(P1), 'nothing was deleted');
  assert.strictEqual(seen.result.disposedWhenEmitted, 1);
});

test('delete: a history that was not fully removed is a warning on a delete that happened, and the flag says so', async () => {
  const deletion = (id) => ({ pageId: id, name: 'Overview', deleted: true, fileRows: 4, conversationMessages: 3, historyRemoved: false, verified: true, warnings: ['2 of 3 conversation messages could not be deleted'] });
  const seen = await run(['delete', '--env', ENV, '--page-id', P1], fakeGenpage({ deletion }));
  const payload = ok(seen);
  assert.deepStrictEqual([payload.historyRemoved, payload.warnings], [false, ['2 of 3 conversation messages could not be deleted']]);
  assert.deepStrictEqual(seen.stderr, ['⚠ 2 of 3 conversation messages could not be deleted\n']);
});

test('delete: a page an app names is the failure the backend describes — the apps, the page, nothing deleted — and a page that is not there is its own failure', async () => {
  const inApp = Object.assign(new Error('page was not deleted: the navigation of this app names it'), {
    code: 'GENPAGE_IN_APP', outcome: 'nothing', pageId: P1, apps: [{ uniqueName: 'contoso_sales', savedOnly: true, appId: APP, name: 'Sales' }],
  });
  assert.deepStrictEqual(failed(await run(['delete', '--env', ENV, '--page-id', P1], fakeGenpage({ deletion: () => { throw inApp; } }))), {
    ok: false, error: 'page was not deleted: the navigation of this app names it', code: 'GENPAGE_IN_APP', pageId: P1, outcome: 'nothing', apps: [{ uniqueName: 'contoso_sales', savedOnly: true, appId: APP, name: 'Sales' }],
  });
  const unreadable = Object.assign(new Error('no app that could be read names it'), { code: 'GENPAGE_APPS_UNREADABLE', outcome: 'nothing', pageId: P1, unreadableApps: ['contoso_broken'] });
  assert.deepStrictEqual(failed(await run(['delete', '--env', ENV, '--page-id', P1], fakeGenpage({ deletion: () => { throw unreadable; } }))).unreadableApps, ['contoso_broken']);
  assert.strictEqual(failed(await run(['delete', '--env', ENV, '--page-id', P1], fakeGenpage())).code, 'GENPAGE_NOT_FOUND');
});

test('delete takes --allow-destructive, a switch, and no other flag that would skip a question — the skill that runs it asks the user, and suppressing that question never authorizes a delete', async () => {
  for (const flag of ['--yes', '--force', '--confirm', '--no-confirm', '--quiet']) {
    const seen = await run(['delete', '--env', ENV, '--page-id', P1, flag], fakeGenpage({ pages: [pageOf(P1)] }));
    assert.match(seen.usage[0].message, /unknown flag/, flag);
    assert.strictEqual(seen.genpage.of('delete').length, 0, flag);
  }
  const switched = await run(['delete', '--env', ENV, '--page-id', P1, '--allow-destructive', 'yes'], fakeGenpage({ pages: [pageOf(P1)] }));
  assert.match(switched.usage[0].message, /--allow-destructive takes no value \(got 'yes'\)/);
  assert.strictEqual(switched.genpage.of('delete').length, 0);
});
