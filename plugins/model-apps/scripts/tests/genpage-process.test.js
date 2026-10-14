'use strict';
// scripts/genpage.js as a PROCESS — the contract an agent or a shell sees: the exit code, ONE line of pure ASCII JSON on stdout, the words on stderr, what the run
// wrote and what it sent. The process is the real script, the real page backend, the real vendored bundle and the real `emitResult`; only the HTTP client is the
// stateful fake of the page tables (helpers/fake-genpage-preload.js), so no token is read and no network is used.
const { test, after } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { APP_ID, APP_EXISTING_PAGE_ID, APP_VIEW_ID } = require('./helpers/fake-genpage-server.js');

const SCRIPT = path.resolve(__dirname, '..', 'genpage.js');
const PRELOAD = path.resolve(__dirname, 'helpers', 'fake-genpage-preload.js');
const ENV = 'https://contoso.crm.dynamics.com';
const P1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const P2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CRLF_SOURCE = 'export default function Page() { return <div>Grüße</div>; }\r\n';
const PAGES = [
  { id: P1, name: 'Überblick — Übersicht', source: CRLF_SOURCE, config: { dataSources: ['account'], model: '' }, prompt: 'Make an overview' },
  { id: P2, name: 'alpha', config: { dataSources: ['account'], model: '' }, prompt: 'Two' },
  { id: APP_EXISTING_PAGE_ID, name: 'Existing', config: { dataSources: ['account'], model: '' }, prompt: 'In the app' },
];

const roots = [];
const scratch = (label) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `genpage-process-${label}-`));
  roots.push(dir);
  return dir;
};
after(() => { for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true }); });

// The command line as a child process. `world` is the fake's FAKE_GENPAGE (see the preload). `log` is what the preload wrote as the process exited.
function run(argv, world = {}, { preload = true, env = {} } = {}) {
  const logDir = scratch('log');
  const log = path.join(logDir, 'log.json');
  const result = spawnSync(process.execPath, [...(preload ? ['--require', PRELOAD] : []), SCRIPT, ...argv], {
    env: { ...process.env, POWER_PLATFORM_SKILLS_TELEMETRY_MODEL_APPS_OPTOUT: '1', FAKE_GENPAGE: JSON.stringify(world), FAKE_GENPAGE_LOG: log, ...env },
    encoding: 'utf8',
    timeout: 120000,
  });
  assert.strictEqual(result.error, undefined, `the process ran: ${result.error && result.error.message}`);
  assert.notStrictEqual(result.status, null, 'the process ended by itself');
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, log: fs.existsSync(log) ? JSON.parse(fs.readFileSync(log, 'utf8')) : null };
}

// stdout is exactly one line, and it is pure ASCII; the JSON it holds.
function result(r) {
  assert.ok(r.stdout.endsWith('\n'), 'the line ends with a newline');
  const lines = r.stdout.trimEnd().split('\n');
  assert.strictEqual(lines.length, 1, `one line on stdout, got: ${r.stdout}`);
  assert.ok(/^[\x20-\x7e]*$/.test(lines[0]), 'the line is pure ASCII: every other character is a \\uXXXX escape');
  return JSON.parse(lines[0]);
}
// Whatever the run made on disk in its own throwaway workspace is gone before it reports: reporting ends the process.
const workspacesGone = (r, { expectMade = true } = {}) => {
  assert.ok(r.log, 'the run wrote its log');
  if (expectMade) assert.ok(r.log.workspaces.length >= 1, 'the page backend made a workspace (so that "gone" says something)');
  for (const workspace of r.log.workspaces) assert.strictEqual(workspace.exists, false, `${workspace.dir} was removed before the process ended`);
};
const names = (xml, id) => xml.toLowerCase().includes(`genpageid="${id}"`);

test('PROCESS list: exit 0, ONE line of pure ASCII JSON — a character beyond ASCII is an escape that reads back — nothing on stderr, nothing written, the workspace gone', () => {
  const r = run(['list', '--env', ENV], { pages: PAGES });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stderr, '');
  const payload = result(r);
  assert.deepStrictEqual(payload, {
    ok: true, scope: 'environment', count: 3,
    pages: [{ pageId: P2, name: 'alpha' }, { pageId: APP_EXISTING_PAGE_ID, name: 'Existing' }, { pageId: P1, name: 'Überblick — Übersicht' }],
  });
  assert.ok(r.stdout.includes('\\u00dcberblick \\u2014 \\u00dcbersicht'), 'the name is written as escapes');
  assert.deepStrictEqual(r.log.writes, []);
  workspacesGone(r);
});

test('PROCESS list --app-id: the published navigation, or with --include-unpublished the saved one — each page with its own name', () => {
  const world = { pages: PAGES, app: { published: [P2], savedOnly: [P1] } };
  const published = result(run(['list', '--env', ENV, '--app-id', APP_ID], world));
  assert.deepStrictEqual([published.scope, published.layer, published.pages.map((p) => [p.pageId, p.name])], ['app', 'published', [[APP_EXISTING_PAGE_ID, 'Existing'], [P2, 'alpha']]]);
  const saved = run(['list', '--env', ENV, '--app-id', APP_ID, '--include-unpublished'], world);
  assert.strictEqual(saved.status, 0, saved.stderr);
  const payload = result(saved);
  assert.deepStrictEqual([payload.layer, payload.pages.map((p) => p.pageId)], ['saved', [APP_EXISTING_PAGE_ID, P2, P1]]);
});

test('PROCESS download: the files of a page are on disk with the bytes the page holds — its CRLF and its text kept, no byte order mark — and the process says where', () => {
  const out = path.join(scratch('download'), 'pages');
  const r = run(['download', '--env', ENV, '--page-id', `${P1},${P2}`, '--output-directory', out], { pages: PAGES });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stderr, '');
  const payload = result(r);
  const root = fs.realpathSync(out);
  assert.deepStrictEqual(payload.pages.map((p) => [p.pageId, p.directory, p.files]), [
    [P1, path.join(root, P1), ['page.tsx', 'config.json', 'prompt.txt']],
    [P2, path.join(root, P2), ['page.tsx', 'config.json', 'prompt.txt']],
  ]);
  assert.strictEqual(payload.outputDirectory, root);
  assert.deepStrictEqual(fs.readFileSync(path.join(root, P1, 'page.tsx')), Buffer.from(CRLF_SOURCE, 'utf8'), 'page.tsx is the stored text: its CRLF, no BOM');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(root, P1, 'config.json'), 'utf8')), { dataSources: ['account'], model: '' });
  assert.strictEqual(fs.readFileSync(path.join(root, P1, 'prompt.txt'), 'utf8'), 'Make an overview');
  assert.deepStrictEqual(fs.readdirSync(path.join(root, P1)).sort(), ['config.json', 'page.tsx', 'prompt.txt']);
  assert.deepStrictEqual(r.log.writes, [], 'a download reads');
  workspacesGone(r);
});

test('PROCESS download: a page that cannot be read leaves the folder as it was — exit 1, the failure as one ASCII line with its code, the words on stderr', () => {
  const out = path.join(scratch('downloadfail'), 'pages');
  const r = run(['download', '--env', ENV, '--page-id', `${P1},cccccccc-cccc-4ccc-8ccc-cccccccccccc`, '--output-directory', out], { pages: PAGES });
  assert.strictEqual(r.status, 1);
  const payload = result(r);
  assert.deepStrictEqual([payload.ok, payload.code], [false, 'GENPAGE_NOT_FOUND']);
  assert.match(payload.error, /^nothing was downloaded: page cccccccc-cccc-4ccc-8ccc-cccccccccccc: /);
  assert.ok(r.stderr.includes('nothing was downloaded'), 'the message is on stderr too');
  assert.ok(!fs.existsSync(out));
  workspacesGone(r);
});

test('PROCESS types: the SDK\'s module is written as it came — a blank first line, LF, no byte order mark — and the byte count is the file\'s', () => {
  const file = path.join(scratch('types'), 'generated', 'RuntimeTypes.ts');
  const r = run(['types', '--env', ENV, '--data-sources', 'Account', '--output-file', file], { pages: PAGES });
  assert.strictEqual(r.status, 0, r.stderr);
  const payload = result(r);
  const bytes = fs.readFileSync(file);
  assert.strictEqual(payload.bytes, bytes.length);
  assert.deepStrictEqual([payload.dataSources, payload.detail, payload.outputFile], [['account'], 'none', fs.realpathSync(file)]);
  const text = bytes.toString('utf8');
  assert.ok(text.startsWith('\n// ---------------- Type Definitions which can be imported from ./RuntimeTypes'));
  assert.ok(text.includes('export type account = TableRow<{') && text.includes('export interface GeneratedComponentProps'));
  assert.ok(!text.includes('\r') && bytes[0] !== 0xEF, 'LF, and no byte order mark');
  assert.deepStrictEqual(r.log.writes, []);
  workspacesGone(r);
});

test('PROCESS add-to-app: the page joins the app\'s navigation, its table\'s default view is pinned, the app is published and the page is proved in what runs', () => {
  const r = run(['add-to-app', '--env', ENV, '--app-id', APP_ID, '--page-id', P2], { pages: PAGES, app: true });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stderr, '');
  assert.deepStrictEqual(result(r), {
    ok: true, appId: APP_ID, pageId: P2, added: true, alreadyPlaced: false, title: 'alpha', appEdited: true, published: true, pinnedViews: [APP_VIEW_ID], dataSources: ['account'], languageCode: 1033,
  });
  assert.ok(names(r.log.app.xml, P2) && names(r.log.app.publishedXml, P2), 'the page is in both layers of the app');
  assert.ok(names(r.log.app.xml, APP_EXISTING_PAGE_ID), 'and the entry that was there stays');
  assert.deepStrictEqual(r.log.app.views, [APP_VIEW_ID]);
  assert.strictEqual(r.log.app.publishAttempts, 1);
  workspacesGone(r);
});

test('PROCESS add-to-app: the entry\'s title is written in the environment\'s base language — a title in a language the environment has not provisioned does not show', () => {
  const r = run(['add-to-app', '--env', ENV, '--app-id', APP_ID, '--page-id', P2, '--title', 'Zweite Seite'], { pages: PAGES, app: true, languages: { base: 1031, provisioned: [1031, 1033], available: [1031, 1033] } });
  assert.strictEqual(r.status, 0, r.stderr);
  const payload = result(r);
  assert.deepStrictEqual([payload.languageCode, payload.title], [1031, 'Zweite Seite']);
  assert.ok(/<Title LCID="1031" Title="Zweite Seite"\s*\/>/.test(r.log.app.xml), `the new entry's title is in LCID 1031: ${r.log.app.xml}`);
});

test('PROCESS add-to-app: a page both layers of the app already name is left alone — nothing written, nothing published, and --title is said to be ignored', () => {
  const r = run(['add-to-app', '--env', ENV, '--app-id', APP_ID, '--page-id', APP_EXISTING_PAGE_ID, '--title', 'New title'], { pages: PAGES, app: { views: [APP_VIEW_ID] } });
  assert.strictEqual(r.status, 0, r.stderr);
  const payload = result(r);
  assert.deepStrictEqual([payload.added, payload.alreadyPlaced, payload.appEdited, payload.published, payload.pinnedViews], [false, true, false, false, []]);
  assert.deepStrictEqual(payload.warnings, ['the page was already in the app\'s navigation, so --title was not applied: an entry that is there is left as it is']);
  assert.ok(r.stderr.includes('⚠ the page was already in the app\'s navigation'), 'the warning is on stderr');
  assert.strictEqual(r.log.app.publishAttempts, 0);
  assert.deepStrictEqual(r.log.writes, []);
  assert.deepStrictEqual(r.log.app.views, [APP_VIEW_ID], 'and the view it holds is the one that was there');
  workspacesGone(r);
});

test('PROCESS add-to-app: a page the navigation already names still has the default view of its table pinned when the app lacks it — an app edit that is reported, with no entry added', () => {
  const r = run(['add-to-app', '--env', ENV, '--app-id', APP_ID, '--page-id', APP_EXISTING_PAGE_ID], { pages: PAGES, app: true });
  assert.strictEqual(r.status, 0, r.stderr);
  const payload = result(r);
  assert.deepStrictEqual([payload.added, payload.alreadyPlaced, payload.appEdited, payload.published, payload.pinnedViews], [false, true, true, true, [APP_VIEW_ID]]);
  assert.deepStrictEqual(r.log.app.views, [APP_VIEW_ID]);
  assert.strictEqual(r.log.app.publishAttempts, 1);
});

test('PROCESS add-to-app: a navigation that was saved and never published is published — the placement an earlier run could not finish', () => {
  const r = run(['add-to-app', '--env', ENV, '--app-id', APP_ID, '--page-id', P2], { pages: PAGES, app: { savedOnly: [P2], views: [APP_VIEW_ID] } });
  assert.strictEqual(r.status, 0, r.stderr);
  const payload = result(r);
  assert.deepStrictEqual([payload.added, payload.alreadyPlaced, payload.appEdited, payload.published], [false, true, false, true]);
  assert.strictEqual(r.log.app.publishAttempts, 1);
  assert.ok(names(r.log.app.publishedXml, P2));
  assert.deepStrictEqual(r.log.writes, [], 'nothing was written: the placement had been saved');
});

test('PROCESS remove-from-app: the app\'s last entry is not taken out — exit 1, the refusal as one line with the ids, nothing written or published — unless it is asked for', () => {
  const refused = run(['remove-from-app', '--env', ENV, '--app-id', APP_ID, '--page-id', APP_EXISTING_PAGE_ID], { pages: PAGES, app: true });
  assert.strictEqual(refused.status, 1);
  assert.deepStrictEqual(result(refused), {
    ok: false,
    error: result(refused).error,
    code: 'GENPAGE_NAVIGATION_WOULD_BE_EMPTY',
    pageId: APP_EXISTING_PAGE_ID,
    appId: APP_ID,
    outcome: 'nothing',
  });
  assert.ok(refused.stderr.includes('would leave its navigation with no entry'));
  assert.deepStrictEqual([refused.log.writes, refused.log.app.publishAttempts], [[], 0]);
  assert.ok(names(refused.log.app.xml, APP_EXISTING_PAGE_ID));
  workspacesGone(refused);

  const allowed = run(['remove-from-app', '--env', ENV, '--app-id', APP_ID, '--page-id', APP_EXISTING_PAGE_ID, '--allow-empty-navigation'], { pages: PAGES, app: true });
  assert.strictEqual(allowed.status, 0, allowed.stderr);
  const payload = result(allowed);
  assert.deepStrictEqual([payload.ok, payload.entriesLeft, payload.provedPublished], [true, 0, true]);
  assert.ok(!allowed.log.app.xml.includes('GenPageId') && !allowed.log.app.publishedXml.includes('GenPageId'));
});

test('PROCESS remove-from-app: the page leaves both layers of the app, its neighbours and the page itself stay — and the answer says what went', () => {
  const r = run(['remove-from-app', '--env', ENV, '--app-id', APP_ID, '--page-id', P2], { pages: PAGES, app: { published: [P2] } });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(result(r), {
    ok: true, appId: APP_ID, pageId: P2, removed: [{ area: 'Main', group: 'Pages', count: 1 }], wasInNavigation: true, appEdited: true, published: true, entriesLeft: 1, provedPublished: true,
  });
  assert.ok(!names(r.log.app.xml, P2) && !names(r.log.app.publishedXml, P2));
  assert.ok(names(r.log.app.xml, APP_EXISTING_PAGE_ID) && names(r.log.app.publishedXml, APP_EXISTING_PAGE_ID));
  assert.ok(r.log.pages.some((p) => p.id === P2), 'the page is not deleted');
  workspacesGone(r);
});

test('PROCESS delete: a page an app names is refused — exit 1, the app is named, not one delete is sent — and a page no app names is deleted with its rows and its conversation', () => {
  const refused = run(['delete', '--env', ENV, '--page-id', APP_EXISTING_PAGE_ID], { pages: PAGES, app: true });
  assert.strictEqual(refused.status, 1);
  const payload = result(refused);
  assert.deepStrictEqual([payload.ok, payload.code, payload.outcome, payload.pageId], [false, 'GENPAGE_IN_APP', 'nothing', APP_EXISTING_PAGE_ID]);
  assert.deepStrictEqual(payload.apps, [{ uniqueName: 'contoso_review', savedOnly: false, appId: APP_ID, name: 'Review' }]);
  assert.ok(refused.stderr.includes('contoso_review'));
  assert.ok(!refused.log.writes.some((w) => /DELETE/.test(w)), 'no delete request was sent');
  assert.strictEqual(refused.log.pages.length, 3);
  workspacesGone(refused);

  const deleted = run(['delete', '--env', ENV, '--page-id', P2.toUpperCase()], { pages: PAGES, app: true });
  assert.strictEqual(deleted.status, 0, deleted.stderr);
  assert.deepStrictEqual(result(deleted), { ok: true, deleted: { pageId: P2, name: 'alpha', fileRows: 4, conversationMessages: 2 }, historyRemoved: true, verified: true });
  assert.deepStrictEqual(deleted.log.pages.map((p) => p.id).sort(), [P1, APP_EXISTING_PAGE_ID].sort());
  assert.strictEqual(deleted.log.messages, 4, 'the two messages of the page went with it');
  workspacesGone(deleted);
});

const USAGE_ERRORS = [
  [[], /a command is required/],
  [['frobnicate', '--env', ENV], /unknown command 'frobnicate'/],
  [['list'], /--env is required/],
  [['list', '--env', 'http://contoso.crm.dynamics.com'], /is not a Dataverse environment URL/],
  [['delete', '--env', ENV, '--page-id', 'nope'], /--page-id 'nope' is not an id/],
  [['delete', '--env', ENV, '--page-id', P1, '--yes'], /unknown flag\(s\): --yes/],
  [['download', '--env', ENV, '--page-id', P1, '--page-id', P2, '--output-directory', 'out'], /--page-id was given more than once/],
];

test('PROCESS: a mistake in the command line is exit 1 with an EMPTY stdout and the usage on stderr — and no request was made, no workspace made', () => {
  for (const [argv, message] of USAGE_ERRORS) {
    const r = run(argv, { pages: PAGES });
    assert.strictEqual(r.status, 1, argv.join(' '));
    assert.strictEqual(r.stdout, '', `${argv.join(' ')}: stdout stays empty`);
    assert.ok(r.stderr.startsWith('✗ '), argv.join(' '));
    assert.match(r.stderr, message, argv.join(' '));
    assert.match(r.stderr, /Usage: node scripts\/genpage\.js/, argv.join(' '));
    assert.deepStrictEqual(r.log.requests, [], `${argv.join(' ')}: nothing was sent`);
    assert.deepStrictEqual(r.log.workspaces, [], `${argv.join(' ')}: nothing was made`);
  }
});

test('PROCESS: a service that refuses is a failure — exit 1, one ASCII line with the SDK\'s code, the message on stderr — and the workspace is still removed', () => {
  const r = run(['list', '--env', ENV], { pages: PAGES, refuse: { status: 403 } });
  assert.strictEqual(r.status, 1);
  const payload = result(r);
  assert.deepStrictEqual([payload.ok, payload.code], [false, 'CONNECTION_ERROR']);
  assert.match(payload.error, /^could not list the environment's generative pages: /);
  assert.ok(r.stderr.includes(payload.error));
  workspacesGone(r);
});

test('PROCESS: with no way to get a token — the Azure CLI is not on PATH — the default wiring fails as one ok:false line, and reaches no service', () => {
  const empty = scratch('nopath');
  const env = { ...process.env, POWER_PLATFORM_SKILLS_TELEMETRY_MODEL_APPS_OPTOUT: '1' };
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key];
  env.PATH = empty;
  const started = Date.now();
  const result1 = spawnSync(process.execPath, [SCRIPT, 'list', '--env', ENV], { env, encoding: 'utf8', timeout: 120000 });
  assert.strictEqual(result1.status, 1, result1.stderr);
  const payload = result({ stdout: result1.stdout });
  assert.deepStrictEqual([payload.ok, payload.code], [false, 'CONNECTION_ERROR']);
  assert.match(payload.error, /Could not get an Azure CLI token for https:\/\/contoso\.crm\.dynamics\.com: Azure CLI \(`az`\) is not on PATH/);
  assert.ok(Date.now() - started < 60000, 'it fails fast: it does not wait on a service');
});
