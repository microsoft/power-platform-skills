'use strict';
// genpage-upload.js — the one entry point both skills use to deploy a generative page — against a stand-in for the page backend
// (helpers/fake-genpage.js). What the backend does with a page is held in genpage-sdk*.test.js; what these hold is the script's own
// contract: what it refuses before it writes, what it proves about an update's target, what it hands the backend, what it records for the
// next update, and what it reports. The last tests drive the REAL SDK bundle through the script.
//
// The contract began with #589. A prompt is arbitrary user text — quotes, line breaks, `%VAR%`, `&`, `|`, non-ASCII — and it used to reach
// the deploy as part of a command line composed in Markdown, where it failed live:
//   Error: Not a valid command.
//   Parse failed on: Inspection
//   Was it quote wrapped? No, be sure to wrap values that contain spaces.
// The dangerous "fix" is to EDIT the approved prompt until it parses, which deploys text the user never approved. So the prompt is read
// from a FILE and handed to the backend as a value: no command line is composed at all.
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const uploadMod = require('../genpage-upload.js');
const { notPlainFile } = uploadMod;
const realBase = require('../lib/genpage-base.js');
const { pageHash, writeMarker, readMarker, markerPath, deployedCopyPath } = realBase;
// How a path appears in a command a message suggests: bare when plain, single-quoted otherwise (a Windows temp path has backslashes).
const { commandArg } = require('../lib/cli-failure.js');
const { makeGenpageSdk } = require('../lib/genpage-sdk.js');
const { fakeGenpage } = require('./helpers/fake-genpage.js');
const { FakeSdk } = require('./helpers/fake-genpage-sdk.js');
const { FakeGenPageServer, INSTANCE, ACCOUNT_TABLE, appTransport, APP_ID: REAL_APP, APP_EXISTING_PAGE_ID } = require('./helpers/fake-genpage-server.js');

const dirs = [];
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gp589-'));
  dirs.push(d);
  return d;
}

const ENV = 'https://contoso.crm.dynamics.com';
const PAGE = '9f1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d'; // the page the environment already holds, placed in APP
const APP = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const OTHER_APP = 'cccccccc-3333-4333-8333-cccccccccccc';
const NEW_ID = 'f3ea07fc-bd57-4d73-af69-b2b64d3ccd85'; // the id the stand-in mints for a page this script creates
const TEXT = 'export const n = 1;\n';

// Every hazard the live failure and the issue name, in one string:
//   multi-line, ASCII-quoted multiword name, Unicode, and shell metacharacters.
const HOSTILE_PROMPT = [
  'Create and LIVE DEPLOY one isolated generative page named "Facilities Inspection Live Overview"',
  'with a résumé of 100% & <b>bold</b> | piped ^ caret %PATH% $(whoami) `backtick`',
  '',
  "and a trailing line with an apostrophe's quote",
].join('\n');

// What a DOWNLOADED page prompt actually looks like — a conversation transcript whose line breaks
// are the content. Passed inline these are collapsed to spaces and the transcript is destroyed.
const TRANSCRIPT = 'Conversation with 3 prompts:\r\n1. Build a list of inspections\r\n2. Add a search box\r\n3. Sort by "Company Name" desc';

// A code file in a folder of its own, as the skill writes one.
function codeFile(text = TEXT) {
  const file = path.join(tmp(), 'page.tsx');
  fs.writeFileSync(file, text);
  return file;
}
// The base marker an earlier download or upload left next to the file; `appId: null` records the page with no app.
function seedBase(file, { pageId = PAGE, appId = APP, deployed = TEXT, local = TEXT, source = 'download' } = {}) {
  writeMarker(file, {
    version: 1, pageId, ...(appId ? { appId } : {}), source,
    deployedSha256: pageHash(deployed),
    localSha256: pageHash(local),
  });
}
// An environment holding one page, placed in APP: what an update has to find — the page, and the app's navigation naming it.
function environment(options = {}) {
  return fakeGenpage({
    pages: [{ pageId: PAGE, name: 'Current Page', source: TEXT, dataSources: ['contoso_ticket'], model: 'gpt-4.1' }],
    appPages: { [APP]: [{ pageId: PAGE, name: 'Current Page' }] },
    newId: () => NEW_ID,
    ...options,
  });
}

// Runs the script's main() against `backend` — the stand-in itself, or a factory that is handed the environment url — and answers what it
// emitted, with how many times the backend had been disposed at that moment: the emitter ends the process, so a cleanup after it never runs.
function run(argv, backend, extra = {}) {
  const make = typeof backend === 'function' ? backend : () => backend;
  let made;
  return new Promise((resolve, reject) => {
    uploadMod.main(argv, {
      makeGenpageSdk: (env, deps) => { made = make(env, deps); return made; },
      emit: (ok, payload) => resolve({ ok, payload, disposedAtEmit: made && made.disposed }),
      ...extra,
    }).catch(reject);
  });
}
const P = ['--prompt', 'p'];
const NAMED = ['--name', 'N', '--prompt', 'p', '--agent-message', 'm'];
const createArgs = (file, extra = NAMED) => ['--env', ENV, '--app-id', APP, '--code-file', file, ...extra];
const updateArgs = (file, extra = P) => ['--env', ENV, '--app-id', APP, '--code-file', file, '--page-id', PAGE, ...extra];
// An update that goes through: the file is the base the page was downloaded as, and the app's navigation names the page.
async function updating(extra = P, options = {}, text = TEXT) {
  const file = codeFile(text);
  seedBase(file);
  const genpage = environment(options);
  return { file, genpage, r: await run(updateArgs(file, extra), genpage) };
}
// The one call of `method` the backend got, as its arguments: a create's are [args], an update's [id, args].
function only(genpage, method) {
  const calls = genpage.of(method);
  assert.strictEqual(calls.length, 1, `${method} was called ${calls.length} times`);
  return calls[0].args;
}
// A backend factory that fails the test on any use, and counts how often one was asked for.
function untouchable() {
  const made = { n: 0 };
  return { made, factory: () => { made.n += 1; return new Proxy({}, { get: (_, name) => () => { throw new Error(`the page backend must not be used: ${String(name)}`); } }); } };
}

// ── A page needs no app; an update does, and so does a placement ────────────────────────────────────────────────────────────────
// With the SDK a page is a row of its own: it exists without an app. A NEW app cannot be created empty — the service refuses a navigation with no
// group that holds an entry — so the new-app flow is: create the first page with NO app, create the app WITH that page, then upload later pages
// with --app-id and --add-to-sitemap. An update, though, must prove the page is in the app it names, and a placement is an edit of that app.

test('an update without --app-id is refused before a backend is made', async () => {
  const none = untouchable();
  const r = await run(['--env', ENV, '--code-file', codeFile(), '--page-id', PAGE, ...P], none.factory);
  assert.strictEqual(r.ok, false);
  assert.match(r.payload.error, /--app-id is required with --page-id: an update must name the app the page is placed in/);
  assert.strictEqual(none.made.n, 0);
});

test('--add-to-sitemap without --app-id is refused: the placement is an edit of the app it names', async () => {
  const none = untouchable();
  const r = await run(['--env', ENV, '--code-file', codeFile(), '--name', 'N', '--add-to-sitemap'], none.factory);
  assert.strictEqual(r.ok, false);
  assert.match(r.payload.error, /--add-to-sitemap needs --app-id: the page is added to that app's navigation\. Pass --app-id, or drop --add-to-sitemap to create the page with no app/);
  assert.strictEqual(none.made.n, 0);
  // With --page-id as well, it is the update's own rule that speaks.
  const both = await run(['--env', ENV, '--code-file', codeFile(), '--page-id', PAGE, '--add-to-sitemap'], none.factory);
  assert.match(both.payload.error, /--app-id is required with --page-id/);
  assert.strictEqual(none.made.n, 0);
});

test('a create without --app-id creates the page and touches no app: no navigation listing, no placement, no app in the report or in the marker', async () => {
  const file = codeFile();
  const genpage = environment();
  const r = await run(['--env', ENV, '--code-file', file, '--name', 'First page', '--prompt', 'p', '--agent-message', 'm', '--data-sources', 'account,contact', '--model', 'gpt-x'], genpage);
  assert.strictEqual(r.ok, true, JSON.stringify(r.payload));
  assert.deepStrictEqual(r.payload, { ok: true, pageId: NEW_ID, updated: false });
  // Only the page itself: it is created, then read back to record its base. Nothing is listed, and no app is read or edited.
  assert.deepStrictEqual(genpage.calls.map((c) => c.method), ['create', 'read']);
  const [args] = only(genpage, 'create');
  assert.deepStrictEqual([args.name, args.dataSources, args.model, args.source], ['First page', 'account,contact', 'gpt-x', TEXT]);
  const marker = readMarker(file);
  assert.deepStrictEqual([marker.pageId, marker.source, 'appId' in marker], [NEW_ID, 'upload', false], 'a page no app holds is recorded with the page alone');
  assert.strictEqual('appId' in JSON.parse(fs.readFileSync(markerPath(file), 'utf8')), false, 'the key is absent from the file, not empty');
});

test('the marker an app-less create records lets the FIRST update with --app-id go through once that app\'s navigation names the page — and records the app', async () => {
  const file = codeFile();
  const appPages = {};
  const genpage = environment({ pages: [], appPages });
  const created = await run(['--env', ENV, '--code-file', file, '--name', 'First page', ...P, '--agent-message', 'm'], genpage);
  assert.strictEqual(created.ok, true, JSON.stringify(created.payload));
  const recorded = fs.readFileSync(markerPath(file), 'utf8');
  fs.writeFileSync(file, `${TEXT}// edited\n`);
  const update = (app) => run(['--env', ENV, '--app-id', app, '--code-file', file, '--page-id', NEW_ID, ...P], genpage);

  // The app that is to hold the page does not name it yet: the update is refused on the app's navigation, before any write, and the marker is as it was.
  const early = await update(OTHER_APP);
  assert.strictEqual(early.ok, false);
  assert.match(early.payload.error, new RegExp(`app ${OTHER_APP} has no generative pages, or could not be found — cannot verify that page ${NEW_ID} belongs to it`));
  assert.strictEqual(genpage.of('update').length, 0);
  assert.strictEqual(fs.readFileSync(markerPath(file), 'utf8'), recorded);

  // Once the app's navigation names the page, the same marker — which names no app — is the page's base: the update goes ahead and records the app.
  appPages[OTHER_APP] = [{ pageId: NEW_ID, name: 'First page' }];
  const first = await update(OTHER_APP);
  assert.strictEqual(first.ok, true, JSON.stringify(first.payload));
  assert.deepStrictEqual([first.payload.updated, first.payload.appId], [true, OTHER_APP]);
  const [id, sent] = only(genpage, 'update');
  assert.deepStrictEqual([id, sent.source, sent.appId], [NEW_ID, `${TEXT}// edited\n`, OTHER_APP]);
  const marker = readMarker(file);
  assert.deepStrictEqual([marker.pageId, marker.appId, marker.source], [NEW_ID, OTHER_APP, 'upload']);

  // From then on the marker is the page's base IN THAT APP: another app's update is refused, as it always was.
  appPages[APP] = [{ pageId: NEW_ID, name: 'First page' }];
  const elsewhere = await update(APP);
  assert.strictEqual(elsewhere.ok, false);
  assert.strictEqual(elsewhere.payload.code, 'no-base');
  assert.match(elsewhere.payload.error, new RegExp(`is for page ${NEW_ID} in app ${OTHER_APP}, not page ${NEW_ID} in app ${APP}`));
  assert.strictEqual(genpage.of('update').length, 1);
});

test('an app-less marker is the page\'s base and no more: another page\'s marker, or a deployed page that has changed, still refuses the update', async () => {
  // A marker that names no app but another page.
  const file = codeFile();
  seedBase(file, { pageId: NEW_ID, appId: null });
  const genpage = environment();
  const other = await run(updateArgs(file), genpage);
  assert.strictEqual(other.ok, false);
  assert.strictEqual(other.payload.code, 'no-base');
  assert.match(other.payload.error, new RegExp(`is for page ${NEW_ID}, not page ${PAGE} in app ${APP}`));
  // The right page, but the deployed page was edited since the base was recorded.
  const drifted = codeFile();
  seedBase(drifted, { appId: null });
  const edited = environment({ pages: [{ pageId: PAGE, name: 'Current Page', source: 'export const n = 2;\n' }] });
  const refused = await run(updateArgs(drifted), edited);
  assert.strictEqual(refused.ok, false);
  assert.strictEqual(refused.payload.code, 'deployed-changed');
  assert.deepStrictEqual([genpage.of('update').length, edited.of('update').length], [0, 0]);
});

// ── Updates: the target must exist, and be in the app ────────────────────────────────────────────────────────────────────────────

// LIVE-REPRODUCED with the CLI an earlier release deployed through: an unknown `--page-id` was treated as a CREATE and answered with the NEW page's id, so a UUID
// proven absent beforehand became a brand-new, UNPLACED page reported as `updated: true`. The page is read first, an update of a page that is not there is refused,
// and the backend's update never creates one.
test('an update of a page that does not exist is refused instead of creating one', async () => {
  const genpage = fakeGenpage({ appPages: { [APP]: [{ pageId: PAGE, name: 'Current Page' }] } });
  const r = await run(updateArgs(codeFile()), genpage);
  assert.strictEqual(r.ok, false);
  assert.match(r.payload.error, /does not exist in this environment/);
  assert.deepStrictEqual([genpage.of('update').length, genpage.of('create').length], [0, 0], 'nothing may be written against an absent target');
});

// Fail CLOSED: a page that cannot be read is not a page proven present, and not permission to write. --overwrite-deployed lets the update go on without the deployed
// page's text — and the backend then refuses a page that is not there, so no way of calling this script turns an update into a create.
test('an update whose page cannot be read is refused rather than assumed present, and --overwrite-deployed never turns it into a create', async () => {
  const genpage = environment({ readErrors: { [PAGE]: new Error('Request failed: read ECONNRESET') } });
  const r = await run(updateArgs(codeFile()), genpage);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.payload.code, 'deployed-unreadable');
  assert.match(r.payload.error, new RegExp(`cannot read the deployed page ${PAGE} \\(Request failed: read ECONNRESET\\) — refusing to update`));
  assert.strictEqual(genpage.of('update').length, 0);

  // A page that is NOT there, whose read failed for another reason: the backend's update refuses it. Nothing is created.
  const absent = fakeGenpage({ readErrors: { [PAGE]: new Error('socket hang up') }, appPages: { [APP]: [{ pageId: PAGE }] } });
  const forced = await run(updateArgs(codeFile(), [...P, '--overwrite-deployed']), absent);
  assert.strictEqual(forced.ok, false);
  assert.match(forced.payload.error, /does not exist in this environment/);
  assert.deepStrictEqual([absent.of('update').length, absent.of('create').length], [1, 0], 'the update was asked for, and refused: it is never a create');
});

// CONTROL — an update whose target DOES exist still proceeds, and a CREATE is never gated on a read of anything. Without these the rules above could be
// satisfied by refusing everything.
test('an update of an existing page, and any create, still proceed', async () => {
  const upd = await updating();
  assert.strictEqual(upd.r.ok, true, `an existing target must update: ${JSON.stringify(upd.r.payload)}`);
  assert.strictEqual(upd.r.payload.updated, true);
  assert.strictEqual(upd.genpage.of('update').length, 1);

  const genpage = environment();
  const create = await run(createArgs(codeFile()), genpage);
  assert.strictEqual(create.ok, true, JSON.stringify(create.payload));
  assert.strictEqual(create.payload.updated, false);
  assert.deepStrictEqual(genpage.of('read').map((c) => c.args[0]), [NEW_ID], 'a create reads only the page it made, to record its base');
  assert.strictEqual(genpage.of('enumeratePages').length, 0, 'and lists no app');
});

test('an update accepts the page id in either case: the page is found, and the app\'s navigation names it in the other', async () => {
  const file = codeFile();
  seedBase(file);
  const genpage = environment({ appPages: { [APP]: [{ pageId: PAGE.toUpperCase(), name: 'Current Page' }] } });
  const r = await run(['--env', ENV, '--app-id', APP, '--code-file', file, '--page-id', PAGE.toUpperCase(), ...P], genpage);
  assert.strictEqual(r.ok, true, JSON.stringify(r.payload));
  assert.strictEqual(only(genpage, 'update')[0], PAGE.toUpperCase(), 'the backend is handed the id as it was given, and finds the page whatever its case');
});

test('an update refuses a page that exists but is not in the supplied app navigation, before it writes anything', async () => {
  const genpage = environment({ appPages: { [APP]: [{ pageId: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', name: 'Other Page' }] } });
  const r = await run(updateArgs(codeFile()), genpage);
  assert.strictEqual(r.ok, false);
  assert.match(r.payload.error, new RegExp(`page ${PAGE} is not in app ${APP}'s navigation`));
  assert.match(r.payload.error, /would attach its tables to that app/);
  assert.strictEqual(genpage.of('update').length, 0, 'the membership refusal comes before the write');
});

test('an update refuses an app that lists no generative pages, before it writes anything', async () => {
  const genpage = environment({ appPages: { [APP]: [] } });
  const r = await run(updateArgs(codeFile()), genpage);
  assert.strictEqual(r.ok, false);
  assert.match(r.payload.error, new RegExp(`app ${APP} has no generative pages, or could not be found`));
  assert.strictEqual(genpage.of('update').length, 0);
});

test('an update refuses when the app\'s navigation cannot be read', async () => {
  const genpage = environment({ appPages: () => ({ ok: false, error: 'the app could not be read' }) });
  const r = await run(updateArgs(codeFile()), genpage);
  assert.strictEqual(r.ok, false);
  assert.match(r.payload.error, new RegExp(`cannot verify that page ${PAGE} belongs to app ${APP} \\(the app could not be read\\)`));
  assert.strictEqual(genpage.of('update').length, 0);
});

// The page read and the app's navigation are two independent reads of about a second each, so an update starts them together. The overlap must not change what the
// guard DECIDES: the verdicts are still reached existence-first, so each failure is reported as it was when the reads ran one after the other.
test('an update starts the page read and the navigation listing together', async () => {
  const started = [];
  const release = new Map();
  const held = (name, value) => new Promise((resolve) => {
    started.push(name);
    release.set(name, () => resolve(value));
  });
  const genpage = environment();
  const read = genpage.read;
  let firstRead = true;
  genpage.read = (id) => (firstRead ? (firstRead = false, held('page', undefined).then(() => read(id))) : read(id));
  genpage.enumeratePages = () => held('navigation', { ok: true, pages: [{ pageId: PAGE, name: 'Current Page' }] });
  const file = codeFile();
  seedBase(file);
  const done = run(updateArgs(file), genpage);
  // Neither has answered yet, so a guard that awaited them in turn would still be on the first.
  const deadline = Date.now() + 2000;
  while (started.length < 2 && Date.now() < deadline) await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual([...started].sort(), ['navigation', 'page'], 'both reads must be in flight before either answers');
  // The navigation answers FIRST: which read finishes first must not matter.
  release.get('navigation')();
  release.get('page')();
  const r = await done;
  assert.strictEqual(r.ok, true, JSON.stringify(r.payload));
  assert.strictEqual(r.payload.updated, true);
});

test('when the page is absent and the navigation cannot be read either, the absent page is the one reported', async () => {
  const genpage = fakeGenpage({ appPages: () => ({ ok: false, error: 'NAVIGATION-DOWN' }) });
  const r = await run(updateArgs(codeFile()), genpage);
  assert.strictEqual(r.ok, false);
  assert.match(r.payload.error, /does not exist in this environment/);
  assert.doesNotMatch(r.payload.error, /NAVIGATION-DOWN/);
});

// Starting the navigation listing early must not let ITS failure pre-empt the existence verdict. A listing that throws surfaces only once the guard reaches
// its verdict, as it did when it ran second — and a page read that throws is an unreadable page, never an uncaught error.
test('a navigation listing that throws surfaces only when the guard reaches its verdict', async () => {
  const throwing = { appPages: () => { throw new Error('NAVIGATION-THREW'); } };
  const absent = await run(updateArgs(codeFile()), fakeGenpage(throwing));
  assert.strictEqual(absent.ok, false);
  assert.match(absent.payload.error, /does not exist in this environment/);
  const file = codeFile();
  seedBase(file);
  await assert.rejects(run(updateArgs(file), environment(throwing)), /NAVIGATION-THREW/);
  const unreadable = await run(updateArgs(codeFile()), environment({ readErrors: { [PAGE]: new Error('READ-THREW') } }));
  assert.strictEqual(unreadable.payload.code, 'deployed-unreadable');
  assert.match(unreadable.payload.error, /READ-THREW/);
});

// ── The text the maker wrote reaches the backend as it was written ──────────────────────────────────────────────────────────────

// An explicitly EMPTY agent message deployed fabricated provenance ('Authored by app-builder'), while an empty PROMPT was already refused — the same fabrication,
// unguarded on the other field.
test('an explicitly empty agent-message file is refused rather than silently defaulted', async () => {
  const d = tmp();
  const af = path.join(d, 'agent.txt');
  fs.writeFileSync(af, '', 'utf8');
  const genpage = environment();
  const r = await run(createArgs(codeFile(), ['--name', 'N', '--prompt', 'p', '--agent-message-file', af]), genpage);
  assert.strictEqual(r.ok, false, 'an empty agent message must not become fabricated provenance');
  assert.match(r.payload.error, /resolved to empty/);
  assert.strictEqual(genpage.calls.length, 0);
});

test('a hostile multi-line prompt reaches the backend byte-identical when passed by file', async () => {
  const d = tmp();
  const pf = path.join(d, 'prompt.txt');
  const af = path.join(d, 'agent.txt');
  fs.writeFileSync(pf, HOSTILE_PROMPT, 'utf8');
  fs.writeFileSync(af, 'Initial deploy of the inspection page', 'utf8');
  const genpage = environment();
  const r = await run(createArgs(codeFile(), ['--prompt-file', pf, '--agent-message-file', af, '--name', 'Facilities Inspection Live Overview']), genpage);
  assert.strictEqual(r.ok, true, `upload should succeed; got ${JSON.stringify(r.payload)}`);
  const [args] = only(genpage, 'create');
  assert.strictEqual(args.prompt, HOSTILE_PROMPT, 'the prompt must arrive VERBATIM — quotes, newlines, Unicode and metacharacters intact');
  assert.strictEqual(args.agentMessage, 'Initial deploy of the inspection page');
  assert.strictEqual(args.name, 'Facilities Inspection Live Overview');
  assert.strictEqual(r.payload.pageId, NEW_ID);
});

// The page's display name travelled on the command line (`--name "<name>"`): PowerShell expanded `$(…)` in it before the script ran — a name could run a command —
// and `Revenue $100` arrived as `Revenue `. By file it keeps every character; the line break an editor adds at its end is not part of it.
test('a display name passed by file reaches the backend intact, and a blank or doubled one is refused', async () => {
  const d = tmp();
  const pf = path.join(d, 'prompt.txt');
  const af = path.join(d, 'agent.txt');
  const nf = path.join(d, 'page-name.txt');
  fs.writeFileSync(pf, 'Build the revenue page', 'utf8');
  fs.writeFileSync(af, 'Initial deploy', 'utf8');
  const NAME = 'Revenue $100 \u2014 \u201cQ3\u201d $(whoami) `x` 100% & it\'s more';
  fs.writeFileSync(nf, `\uFEFF${NAME}\r\n`, 'utf8');
  const base = (file) => createArgs(file, ['--prompt-file', pf, '--agent-message-file', af]);
  const genpage = environment();
  const r = await run([...base(codeFile()), '--name-file', nf], genpage);
  assert.strictEqual(r.ok, true, JSON.stringify(r.payload));
  assert.strictEqual(only(genpage, 'create')[0].name, NAME, 'every character, and no BOM or trailing line break');
  const both = environment();
  const doubled = await run([...base(codeFile()), '--name', 'x', '--name-file', nf], both);
  assert.strictEqual(doubled.ok, false);
  assert.match(doubled.payload.error, /only one of --name or --name-file/);
  assert.strictEqual(both.calls.length, 0);
  fs.writeFileSync(nf, '\r\n', 'utf8');
  const empty = environment();
  const blank = await run([...base(codeFile()), '--name-file', nf], empty);
  assert.strictEqual(blank.ok, false);
  assert.match(blank.payload.error, /the page name resolved to empty/);
  assert.strictEqual(empty.calls.length, 0, 'no generated name deployed in place of the one supplied');
});

// The skill writes these files into the working directory just before the upload, and a write through a link left at one of those names — a symbolic link or junction,
// or a hard link — rewrote the file it points to, outside the working directory included. An input that is not a plain file stops the upload, and says the other
// file may have changed.
test('a prompt, agent-message, name, connectors or actions file that is a link or a folder stops the upload', async (t) => {
  const d = tmp();
  const outside = tmp();
  const plain = (name, text) => { const p = path.join(d, name); fs.writeFileSync(p, text, 'utf8'); return p; };
  const pf = plain('prompt.txt', 'Build the revenue page');
  const af = plain('agent-message.txt', 'Initial deploy');
  const nf = plain('page-name.txt', 'Revenue');
  const cf = plain('connectors.json', '[]');
  const xf = plain('actions.json', '[]');
  const victim = path.join(outside, 'victim.txt');
  fs.writeFileSync(victim, 'not the skill\'s file', 'utf8');
  const argv = (over = {}) => {
    const files = { 'prompt-file': pf, 'agent-message-file': af, 'name-file': nf, connectors: cf, actions: xf, ...over };
    return createArgs(codeFile(), Object.entries(files).flatMap(([k, v]) => [`--${k}`, v]));
  };
  // CONTROL: every input a plain file — the upload runs.
  const ok = environment();
  assert.strictEqual((await run(argv(), ok)).ok, true);
  assert.strictEqual(ok.of('create').length, 1);
  for (const flag of ['prompt-file', 'agent-message-file', 'name-file', 'connectors', 'actions']) {
    const hard = path.join(d, `hard-${flag}`);
    fs.linkSync(victim, hard);
    const genpage = environment();
    const r = await run(argv({ [flag]: hard }), genpage);
    assert.strictEqual(r.ok, false, flag);
    assert.match(r.payload.error, new RegExp(`^--${flag} .*hard-${flag} is a hard link \\(2 names for one file\\)`), flag);
    assert.match(r.payload.error, /changed its other names too/, flag);
    assert.strictEqual(genpage.calls.length, 0, `${flag}: nothing deployed`);
    fs.unlinkSync(hard);
  }
  const folder = path.join(d, 'folder.txt');
  fs.mkdirSync(folder);
  const inFolder = environment();
  const r = await run(argv({ 'name-file': folder }), inFolder);
  assert.strictEqual(r.ok, false);
  assert.match(r.payload.error, /^--name-file .*folder\.txt is not a plain file \(a folder or a special file\)/);
  assert.strictEqual(inFolder.calls.length, 0);
  const sym = path.join(d, 'sym-prompt.txt');
  try { fs.symlinkSync(victim, sym, 'file'); } catch (e) { t.skip(`cannot create a file symlink here: ${e.message}`); return; }
  const viaLink = environment();
  const s = await run(argv({ 'prompt-file': sym }), viaLink);
  assert.strictEqual(s.ok, false);
  assert.match(s.payload.error, /^--prompt-file .*sym-prompt\.txt is a symbolic link or junction, not a file written in place — writing it may have changed the file it points to/);
  assert.strictEqual(viaLink.calls.length, 0);
});

// Fail closed: an input that cannot be inspected is not one proven to be a plain file. A missing one is left to the read, which says it could not be read.
test('an input file that cannot be inspected is refused; a missing one is left to the read', (t) => {
  const d = tmp();
  assert.strictEqual(notPlainFile(path.join(d, 'absent.txt')), null);
  t.mock.method(fs, 'lstatSync', () => { throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' }); });
  assert.match(notPlainFile(path.join(d, 'prompt.txt')), /prompt\.txt could not be inspected \(EPERM\)/);
});

test('a downloaded conversation transcript survives an update by file', async () => {
  const d = tmp();
  const pf = path.join(d, 'prompt.txt');
  fs.writeFileSync(pf, TRANSCRIPT, 'utf8');
  const { genpage, r } = await updating(['--prompt-file', pf, '--agent-message', 'Re-upload after edit']);
  assert.strictEqual(r.ok, true, JSON.stringify(r.payload));
  // \r\n is normalized by neither side, and nothing is trimmed — not even a trailing newline — so every line break, which is what makes a transcript a transcript,
  // is preserved.
  const [id, args] = only(genpage, 'update');
  assert.strictEqual(args.prompt, TRANSCRIPT, 'the transcript must not be flattened');
  assert.strictEqual(id, PAGE);
  assert.strictEqual(r.payload.updated, true, 'an upload carrying --page-id is an update');
});

// Prompt provenance: two different texts, one deploy. Silently preferring either means building the page from text the caller did not intend, which is the failure
// this whole issue is about.
test('passing both an inline prompt and a prompt file is refused rather than silently resolved', async () => {
  const pf = path.join(tmp(), 'prompt.txt');
  fs.writeFileSync(pf, 'from the file', 'utf8');
  const genpage = environment();
  const r = await run(createArgs(codeFile(), ['--prompt', 'inline text', '--prompt-file', pf]), genpage);
  assert.strictEqual(r.ok, false);
  assert.match(r.payload.error, /only one of --prompt or --prompt-file/);
  assert.strictEqual(genpage.calls.length, 0, 'nothing may be deployed when the prompt is ambiguous');
});

// LIVE-VERIFICATION FINDING, not a hypothetical. The download an earlier release used wrote the recovered `prompt.txt` with a UTF-8 BOM (measured: first bytes `ef bb bf`), and
// the documented edit flow re-feeds exactly that file through `--prompt-file`; so a folder downloaded then still carries it. Node's 'utf8' decode does NOT strip a BOM, so the
// prompt handed to the backend began with an invisible U+FEFF — silently altering the first character of a prompt the user approved.
test('a BOM at the start of a prompt file is stripped, not sent as part of the prompt', async () => {
  const pf = path.join(tmp(), 'prompt.txt');
  const body = 'Create a read-only overview page named "Live Check Overview".';
  fs.writeFileSync(pf, '\uFEFF' + body, 'utf8');
  // The fixture really is BOM-prefixed on disk, so this cannot pass by writing a plain file.
  assert.deepStrictEqual([...fs.readFileSync(pf).slice(0, 3)], [0xef, 0xbb, 0xbf]);
  const genpage = environment();
  const r = await run(createArgs(codeFile(), ['--prompt-file', pf, '--agent-message', 'm']), genpage);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(only(genpage, 'create')[0].prompt, body, 'no BOM, and the rest untouched');
});

// A BOM in the MIDDLE is content, not an encoding marker, so it must survive — stripping every U+FEFF would be a different bug in the same place.
test('a U+FEFF inside the prompt body is preserved', async () => {
  const pf = path.join(tmp(), 'prompt.txt');
  const body = 'Line one\nmid\uFEFFdle\nLine three';
  fs.writeFileSync(pf, body, 'utf8');
  const genpage = environment();
  await run(createArgs(codeFile(), ['--prompt-file', pf]), genpage);
  assert.strictEqual(only(genpage, 'create')[0].prompt, body, 'only a LEADING BOM is an encoding marker');
});

// --prompt-file delivers the file byte-for-byte: a trailing newline used to be stripped on this path while the direct /app-builder path kept it, so the SAME text
// deployed differently depending on which path carried it.
test('a prompt file reaches the backend byte-for-byte, including a trailing newline; only a leading BOM goes', async () => {
  const pf = path.join(tmp(), 'prompt.txt');
  const BODY = 'Conversation with 2 prompts:\n1. Build a list\n2. Add a search box\n';
  fs.writeFileSync(pf, BODY, 'utf8');
  const genpage = environment();
  assert.strictEqual((await run(createArgs(codeFile(), ['--name', 'P', '--prompt-file', pf, '--agent-message', 'm']), genpage)).ok, true);
  assert.strictEqual(only(genpage, 'create')[0].prompt, BODY, 'no trailing-newline normalization');
  fs.writeFileSync(pf, Buffer.from('\uFEFFkeep this\n', 'utf8'));
  const second = environment();
  await run(createArgs(codeFile(), ['--name', 'P', '--prompt-file', pf, '--agent-message', 'm']), second);
  assert.strictEqual(only(second, 'create')[0].prompt, 'keep this\n', 'the BOM goes, the trailing newline stays');
});

// An update cannot add a sitemap entry, and one that quietly discards the flag leaves the caller believing a placement happened.
test('--add-to-sitemap combined with --page-id is refused, not silently dropped', async () => {
  const genpage = environment();
  const r = await run(updateArgs(codeFile(), [...P, '--add-to-sitemap']), genpage);
  assert.strictEqual(r.ok, false);
  assert.match(r.payload.error, /cannot be combined with --page-id/);
  assert.strictEqual(genpage.calls.length, 0, 'nothing may be deployed on a contradictory request');
});

// The backend substitutes `Generative page <name>` for a blank prompt. That is fine when no prompt was supplied, but a caller who passed --prompt-file asked for THAT text, and
// deploying a generated placeholder instead is exactly the provenance break this path exists to prevent. A blank, newline-only or BOM-only file is the realistic way it happens.
test('a prompt file that resolves to empty is refused rather than silently defaulted', async () => {
  const d = tmp();
  for (const [label, body] of [['blank', ''], ['newline-only', '\n'], ['BOM-only', '\uFEFF'], ['whitespace', '   \n  ']]) {
    const pf = path.join(d, `p-${label}.txt`);
    fs.writeFileSync(pf, body, 'utf8');
    const genpage = environment();
    const r = await run(createArgs(codeFile(), ['--name', 'NamedPage', '--prompt-file', pf]), genpage);
    assert.strictEqual(r.ok, false, `${label} must be refused`);
    assert.match(r.payload.error, /resolved to empty/);
    assert.strictEqual(genpage.calls.length, 0, `${label}: nothing may be deployed`);
  }
  // CONTROL: a file with real content still deploys, so this is not a blanket refusal.
  const good = path.join(d, 'good.txt');
  fs.writeFileSync(good, 'A real approved prompt', 'utf8');
  const genpage = environment();
  const r = await run(createArgs(codeFile(), ['--prompt-file', good]), genpage);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(only(genpage, 'create')[0].prompt, 'A real approved prompt');
});

test('an unreadable prompt file fails closed instead of deploying a default prompt', async () => {
  const genpage = environment();
  const r = await run(createArgs(codeFile(), ['--prompt-file', path.join(tmp(), 'missing.txt')]), genpage);
  assert.strictEqual(r.ok, false);
  assert.match(r.payload.error, /could not be read/);
  assert.strictEqual(genpage.calls.length, 0);
});

// A page name is stored exactly as it is given. The CLI an earlier release deployed through stored every ASCII `"` as `\"` and so refused such a name; the SDK has no
// such constraint, so the name goes through as the maker wrote it, on a create and on an update, inline and by file.
test('a page name with an ASCII double quote reaches the backend exactly — create and update, inline and by file', async () => {
  const nf = path.join(tmp(), 'page-name.txt');
  fs.writeFileSync(nf, 'Say "hi" now\n', 'utf8');
  for (const [label, extra, kind] of [
    ['create, by file', ['--name-file', nf, ...P, '--agent-message', 'm'], 'create'],
    ['create, inline', ['--name', 'Say "hi" now', ...P, '--agent-message', 'm'], 'create'],
    ['update, by file', ['--name-file', nf, ...P], 'update'],
  ]) {
    const genpage = environment();
    const file = codeFile();
    if (kind === 'update') seedBase(file);
    const r = await run(kind === 'update' ? updateArgs(file, extra) : createArgs(file, extra), genpage);
    assert.strictEqual(r.ok, true, `${label}: ${JSON.stringify(r.payload)}`);
    const args = kind === 'update' ? only(genpage, 'update')[1] : only(genpage, 'create')[0];
    assert.strictEqual(args.name, 'Say "hi" now', label);
  }
});

// ── Every option reaches the backend, by value ──────────────────────────────────────────────────────────────────────────────────────

test('main forwards every option to the backend, by value: the checked bytes, the text files, the bindings, the environment and the placement', async () => {
  const d = tmp();
  const pf = path.join(d, 'prompt.txt');
  fs.writeFileSync(pf, 'the approved prompt', 'utf8');
  const connectors = [{ id: 'shared_office365', operation: 'SendEmailV2' }];
  const actions = [{ name: 'Approve', flow: 'f1' }];
  const cf = path.join(d, 'CONN.json');
  const xf = path.join(d, 'ACT.json');
  // An editor on Windows adds a BOM to a JSON file; it is not part of the JSON.
  fs.writeFileSync(cf, `\uFEFF${JSON.stringify(connectors)}`, 'utf8');
  fs.writeFileSync(xf, JSON.stringify(actions), 'utf8');
  const file = codeFile(TEXT);
  const genpage = environment();
  let envSeen;
  const r = await run(['--env', ENV, '--app-id', APP, '--code-file', file, '--name', 'NamedPage', '--data-sources', 'account,contact',
    '--model', 'MODEL-9', '--connectors', cf, '--actions', xf, '--prompt-file', pf, '--agent-message', 'msg', '--add-to-sitemap'],
  (env) => { envSeen = env; return genpage; });
  assert.strictEqual(r.ok, true, `expected success, got ${JSON.stringify(r.payload)}`);
  assert.strictEqual(envSeen, ENV, 'the backend is made for the environment that was named');

  // EXACT values, distinct enough that a dropped option or a swap cannot pass.
  const [args] = only(genpage, 'create');
  assert.deepStrictEqual(args, {
    source: TEXT, name: 'NamedPage', prompt: 'the approved prompt', agentMessage: 'msg', dataSources: 'account,contact', model: 'MODEL-9',
    connectorBindings: connectors, actionBindings: actions,
  });
  assert.deepStrictEqual(only(genpage, 'placeInApp'), [APP, { pages: [{ pageId: NEW_ID, title: 'NamedPage' }], dataSources: 'account,contact', languageCode: 1033 }]);
  assert.deepStrictEqual(r.payload, { ok: true, pageId: NEW_ID, appId: APP, updated: false, addedToSitemap: true });
  const marker = readMarker(file);
  assert.deepStrictEqual([marker.pageId, marker.appId, marker.source], [NEW_ID, APP, 'upload']);
});

test('an /app-builder-shaped upload sends none of the standalone options and places no page', async () => {
  const genpage = environment();
  const r = await run(createArgs(codeFile(), [...NAMED, '--data-sources', 'account']), genpage);
  assert.strictEqual(r.ok, true, JSON.stringify(r.payload));
  const [args] = only(genpage, 'create');
  assert.strictEqual(args.model, undefined);
  for (const key of ['connectorBindings', 'actionBindings']) assert.strictEqual(key in args, false, `${key} must not appear unless asked`);
  // It names an app but no placement, so it pins the views of its tables and places nothing.
  assert.deepStrictEqual(only(genpage, 'placeInApp'), [APP, { pages: [], dataSources: 'account' }]);
  assert.strictEqual(r.payload.addedToSitemap, undefined);
});

test('a bindings file that is not a JSON array is refused before anything is deployed; an empty array is sent — it is how a list is cleared', async () => {
  const d = tmp();
  for (const [label, body, says] of [
    ['an object', '{"a":1}', /--connectors must hold a JSON array \(the bindings the page uses\), not object/],
    ['null', 'null', /not null/],
    ['a string', '"x"', /not string/],
    ['text', 'nope', /--connectors could not be read as JSON/],
  ]) {
    const f = path.join(d, `c-${label.replace(/ /g, '-')}.json`);
    fs.writeFileSync(f, body);
    const genpage = environment();
    const r = await run(createArgs(codeFile(), [...NAMED, '--connectors', f]), genpage);
    assert.strictEqual(r.ok, false, label);
    assert.match(r.payload.error, says, label);
    assert.strictEqual(genpage.calls.length, 0, `${label}: nothing deployed`);
  }
  const missing = environment();
  const gone = await run(createArgs(codeFile(), [...NAMED, '--actions', path.join(d, 'absent.json')]), missing);
  assert.strictEqual(gone.ok, false);
  assert.match(gone.payload.error, /--actions could not be read as JSON/);
  const empty = path.join(d, 'empty.json');
  fs.writeFileSync(empty, '[]');
  const genpage = environment();
  assert.strictEqual((await run(createArgs(codeFile(), [...NAMED, '--actions', empty]), genpage)).ok, true);
  assert.deepStrictEqual(only(genpage, 'create')[0].actionBindings, []);
});

// ── An update changes only what it is told to ───────────────────────────────────────────────────────────────────────────────────────
// The CLI an earlier release deployed through rewrote every field from the flags it was given, so an update that left out --data-sources unbound the page, one that left out
// --model blanked it and one that left out --name renamed the page to its navigation title — and the script read each value back to re-send it. The backend writes only what
// differs from the page (genpage-sdk.test.js holds that it keeps the rest); these hold that the script asks for nothing it was not told.

test('an update that says nothing about the name, model, data sources or bindings sends none of them', async () => {
  const { file, genpage, r } = await updating();
  assert.strictEqual(r.ok, true, `the update must succeed; got ${JSON.stringify(r.payload)}`);
  const [id, args] = only(genpage, 'update');
  assert.strictEqual(id, PAGE);
  for (const key of ['name', 'model', 'dataSources']) assert.strictEqual(args[key], undefined, `${key} is the page's own`);
  for (const key of ['connectorBindings', 'actionBindings']) assert.strictEqual(key in args, false, key);
  assert.deepStrictEqual([args.source, args.prompt, args.caller, args.appId, args.sourceFile], [TEXT, 'p', 'upload', APP, file]);
  // The page's own values were never read back to be sent again: the only reads are of the page itself — for the guards, and to record its base.
  assert.deepStrictEqual(genpage.of('read').map((c) => c.args[0]), [PAGE, PAGE]);
});

test('an explicit --data-sources, --model, --name or bindings file wins: it is what is sent', async () => {
  const cf = path.join(tmp(), 'connectors.json');
  fs.writeFileSync(cf, '[{"id":"c1"}]');
  const { genpage, r } = await updating([...P, '--data-sources', 'contoso_other', '--model', 'gpt-5', '--name', 'New Title', '--connectors', cf]);
  assert.strictEqual(r.ok, true, JSON.stringify(r.payload));
  const [, args] = only(genpage, 'update');
  assert.deepStrictEqual([args.dataSources, args.model, args.name, args.connectorBindings], ['contoso_other', 'gpt-5', 'New Title', [{ id: 'c1' }]]);
});

test('--clear-data-sources unbinds — an empty list is sent — and =false does not authorise it', async () => {
  const cleared = await updating([...P, '--clear-data-sources']);
  assert.strictEqual(cleared.r.ok, true, JSON.stringify(cleared.r.payload));
  assert.deepStrictEqual(only(cleared.genpage, 'update')[1].dataSources, []);
  // `parseArgs` yields the STRING "false" for `--clear-data-sources=false`, which is truthy: reading it as permission would unbind the page the guard protects.
  const refused = await updating([...P, '--clear-data-sources=false']);
  assert.strictEqual(refused.r.ok, true);
  assert.strictEqual(only(refused.genpage, 'update')[1].dataSources, undefined, 'an explicit "false" must not be read as permission to unbind');
});

test('--clear-data-sources combined with --data-sources is refused, not silently resolved', async () => {
  const file = codeFile();
  seedBase(file);
  const genpage = environment();
  const r = await run(updateArgs(file, [...P, '--clear-data-sources', '--data-sources', 'contoso_other']), genpage);
  assert.strictEqual(r.ok, false, 'one unbinds and the other binds — guessing is not an option');
  assert.match(r.payload.error, /cannot be combined/);
  assert.strictEqual(genpage.calls.length, 0);
});

// ── Placing the page in an app ──────────────────────────────────────────────────────────────────────────────────────────────────────
// Placing a page is an edit of the app: the page becomes a sub-area of its navigation, and the default view of each table the page reads joins the app's components so the
// maker's "/" picker lists it. The earlier release's upload did both, with the page; the SDK's page write does neither, so the script asks the backend.

test('the tables whose default views are pinned are the ones named, else the page\'s own, else none — and an upload with nothing to place or pin does not touch the app', async () => {
  const own = await updating();
  assert.deepStrictEqual(only(own.genpage, 'placeInApp'), [APP, { pages: [], dataSources: ['contoso_ticket'] }], 'an update that names none: the page\'s own');
  const named = await updating([...P, '--data-sources', 'contoso_other']);
  assert.deepStrictEqual(only(named.genpage, 'placeInApp'), [APP, { pages: [], dataSources: 'contoso_other' }]);
  const cleared = await updating([...P, '--clear-data-sources']);
  assert.strictEqual(cleared.genpage.of('placeInApp').length, 0, 'unbound: nothing to pin');
  const bare = await updating(P, { pages: [{ pageId: PAGE, name: 'Current Page', source: TEXT, dataSources: [] }] });
  assert.strictEqual(bare.genpage.of('placeInApp').length, 0, 'a page that reads no table: nothing to pin');
  const created = environment();
  assert.strictEqual((await run(createArgs(codeFile()), created)).ok, true);
  assert.strictEqual(created.of('placeInApp').length, 0, 'a create that names an app but no table and no placement leaves the app alone');
});

// A create that asked for a placement and could not get it leaves the page deployed but absent from the app's navigation — an unreachable page, which is an incomplete
// deployment and not a success. Failing to pin a view is different: the page works without it, so it is a warning.
test('a page written but left out of the app is a failure that carries its id; a view that could not be pinned is only a warning', async () => {
  const file = codeFile();
  const failing = environment({ placement: () => { throw new Error('app aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa could not be read'); } });
  const r = await run(createArgs(file, [...NAMED, '--add-to-sitemap']), failing);
  assert.strictEqual(r.ok, false, 'an unplaced page is not a successful deployment');
  assert.strictEqual(r.payload.pageId, NEW_ID, 'the id must still be reported so the operator can place it');
  assert.strictEqual(r.payload.appId, APP);
  assert.match(r.payload.error, new RegExp(`page ${NEW_ID} was created and published, but NOT added to app ${APP}'s navigation: app .* could not be read`));
  assert.match(r.payload.error, new RegExp(`Add the page to the app navigation with node scripts/genpage\\.js add-to-app --env \\S+ --app-id ${APP} --page-id ${NEW_ID}(?:, or run the same command again with --page-id |\\.$)`), 'the verb that places a page, ready to run, not Maker');
  assert.doesNotMatch(r.payload.error, /in Maker/);
  assert.strictEqual(readMarker(file).pageId, NEW_ID, 'the page exists, so its base is recorded all the same');

  const pinning = environment({ placement: () => { throw new Error('the layer could not be read'); } });
  const w = await run(createArgs(codeFile(), [...NAMED, '--data-sources', 'account']), pinning);
  assert.strictEqual(w.ok, true, JSON.stringify(w.payload));
  assert.match(w.payload.warnings.join('\n'), new RegExp(`its tables' default views could not be added to app ${APP}'s components.*the layer could not be read`));
});

test('what the backend says about a placement is passed on: the report says the page was added, and its warnings follow', async () => {
  const genpage = environment({
    placement: () => ({ added: [NEW_ID], alreadyPlaced: [], pinnedViews: [], warnings: ['table contoso_x has no default public view to pin into the app'], appEdited: true }),
  });
  const r = await run(createArgs(codeFile(), [...NAMED, '--add-to-sitemap']), genpage);
  assert.strictEqual(r.ok, true, JSON.stringify(r.payload));
  assert.deepStrictEqual([r.payload.addedToSitemap, r.payload.warnings], [true, ['table contoso_x has no default public view to pin into the app']]);
  // A page the navigation already names is not "added": the report does not claim it was.
  const placed = environment({ placement: () => ({ added: [], alreadyPlaced: [NEW_ID], pinnedViews: [], warnings: [], appEdited: false }) });
  const again = await run(createArgs(codeFile(), [...NAMED, '--add-to-sitemap']), placed);
  assert.strictEqual(again.ok, true);
  assert.strictEqual(again.payload.addedToSitemap, undefined);
});

// ── What is reported ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('a page whose publish failed is written and recorded, and reported as a failure that carries its id and the way on', async () => {
  const failed = { publish: { kind: 'failed', detail: 'the publish timed out' } };
  // An UPDATE: the way on is the update again — the page is in the app, so every guard an update makes can be made.
  const file = codeFile();
  seedBase(file);
  const updating = environment({ onUpdate: () => failed });
  const upd = await run(updateArgs(file), updating);
  assert.strictEqual(upd.ok, false);
  assert.strictEqual(upd.payload.pageId, PAGE);
  assert.match(upd.payload.error, new RegExp(`page ${PAGE} was updated and saved, but publishing it failed \\(the publish timed out\\) — the runtime still serves the previously published copy`));
  assert.match(upd.payload.error, new RegExp(`Run the upload again as an update \\(--page-id ${PAGE}\\) to publish it`));
  assert.strictEqual(updating.of('placeInApp').length, 0, 'a page that is not published is not placed, and its tables are not pinned');
  assert.strictEqual(readMarker(file).source, 'upload', 'its base is recorded');
  assert.strictEqual(readMarker(file).unfinished, undefined, 'an update leaves nothing unfinished: its page was already in the app');

  // A CREATE: the page is in no app's navigation, so "an update" is not the way on — the same command with --page-id is, and the marker says why it may.
  const created = codeFile();
  const creating = environment({ onCreate: () => failed });
  const r = await run(createArgs(created, [...NAMED, '--add-to-sitemap']), creating);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.payload.pageId, NEW_ID);
  assert.match(r.payload.error, new RegExp(`page ${NEW_ID} was created, but publishing it failed \\(the publish timed out\\) — it is not live yet`));
  assert.match(r.payload.error, new RegExp(`run the same command again with --page-id ${NEW_ID} added and nothing else changed`));
  assert.doesNotMatch(r.payload.error, /Run the upload again as an update/, 'an update is the advice that cannot be followed');
  assert.strictEqual(creating.of('placeInApp').length, 0, 'a page that is not published is not placed');
  const marker = readMarker(created);
  assert.deepStrictEqual([marker.pageId, marker.source, marker.unfinished], [NEW_ID, 'upload', 'place'], 'its base is recorded, and says the page was not finished — it was asked to be placed');
});

// The advice is run, as the caller would run it: the command that failed, with --page-id and the id it named added. Matching its wording proves nothing about whether it works.
const adviceFor = (r) => {
  const found = /run the same command again with --page-id (\S+) added and nothing else changed/.exec(r.payload.error);
  assert.ok(found, `the failure names the way on: ${r.payload.error}`);
  return ['--page-id', found[1]];
};

// A create whose publish failed is finished by running it again with --page-id, which the base marker lets through — and when the marker itself could not be written there is nothing to let it through, so
// what is left is a page that exists and is not live. The two ways out are verbs of scripts/genpage.js now, the second after asking the user and with the confirmation the script requires.
test('a create whose publish failed AND whose base marker could not be written has no way on by itself — it says to publish the page in Maker, or delete it with the verb that does, after asking', async () => {
  const file = codeFile();
  const genpage = environment({ onCreate: () => ({ publish: { kind: 'failed', detail: 'the publish timed out' } }) });
  const r = await run(createArgs(file, NAMED), genpage, { base: { ...realBase, writeMarker() { throw new Error('disk full'); } } });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.payload.pageId, NEW_ID);
  assert.match(r.payload.error, new RegExp(`could not be written, so publish page ${NEW_ID} in Maker, or delete it \\(after asking the user — it is permanent: node scripts/genpage\\.js delete --env \\S+ --page-id ${NEW_ID} --allow-destructive\\) and create it again\\.$`));
});

test('RUNNING the advice for a create that published nothing — with no app — publishes exactly that page, and the marker no longer says it is unfinished', async () => {
  const file = codeFile();
  const genpage = environment({ onCreate: () => ({ publish: { kind: 'failed', detail: 'the publish timed out' } }) });
  const args = ['--env', ENV, '--code-file', file, ...NAMED];
  const first = await run(args, genpage);
  assert.strictEqual(first.ok, false);
  assert.strictEqual(readMarker(file).unfinished, 'publish');
  // Without the marker's word that this tool created the page, an update needs --app-id: the advice does not name one, and does not need one.
  const second = await run([...args, ...adviceFor(first)], genpage);
  assert.strictEqual(second.ok, true, JSON.stringify(second.payload));
  assert.deepStrictEqual([second.payload.pageId, second.payload.updated, second.payload.unchanged], [NEW_ID, true, true], 'the page holds the content, so it is published, not written again');
  assert.strictEqual(only(genpage, 'update')[0], NEW_ID);
  assert.strictEqual(genpage.of('create').length, 1, 'and no second page was created');
  assert.strictEqual(genpage.of('enumeratePages').length, 0, 'no app navigation was read: there is no app');
  const marker = readMarker(file);
  assert.deepStrictEqual([marker.pageId, marker.unfinished, 'appId' in marker], [NEW_ID, undefined, false], 'finished: the marker is the one an ordinary create leaves');
  assert.strictEqual('unfinished' in JSON.parse(fs.readFileSync(markerPath(file), 'utf8')), false, 'the key is gone from the file, not false');
});

test('RUNNING the advice for an app-bound create that published nothing — placed with --add-to-sitemap — publishes the page and places it in the app', async () => {
  const file = codeFile();
  const appPages = {};
  let publishFails = true;
  const genpage = environment({
    pages: [],
    appPages,
    onCreate: () => (publishFails ? { publish: { kind: 'failed', detail: 'the publish timed out' } } : {}),
    placement: (appId, options) => {
      for (const p of options.pages) (appPages[appId] = appPages[appId] || []).push({ pageId: p.pageId, name: p.title });
      return { added: options.pages.map((p) => String(p.pageId)), alreadyPlaced: [], pinnedViews: [], warnings: [], appEdited: options.pages.length > 0 };
    },
  });
  const args = createArgs(file, [...NAMED, '--add-to-sitemap']);
  const first = await run(args, genpage);
  assert.strictEqual(first.ok, false);
  assert.strictEqual(genpage.of('placeInApp').length, 0, 'not placed: the page is not published');
  assert.deepStrictEqual(appPages, {}, 'and the app\'s navigation does not name it, so an update\'s membership proof could never be made');
  // The ordinary update — what the advice used to say — is refused: this is not an update the page's membership can be proven for, and it is the page's placement that is unfinished.
  const ordinary = await run(['--env', ENV, '--app-id', APP, '--code-file', file, '--page-id', NEW_ID, ...P], genpage);
  assert.strictEqual(ordinary.ok, false);
  assert.match(ordinary.payload.error, new RegExp(`was created to be placed in app ${APP}, and it is not finished until it is placed: run the same command again with --page-id ${NEW_ID} added and --add-to-sitemap kept`));
  assert.strictEqual(genpage.of('update').length, 0, 'nothing was written by it');
  const marker = readMarker(file);
  assert.strictEqual(marker.unfinished, 'place');

  publishFails = false;
  const second = await run([...args, ...adviceFor(first)], genpage);
  assert.strictEqual(second.ok, true, JSON.stringify(second.payload));
  assert.deepStrictEqual([second.payload.pageId, second.payload.addedToSitemap, second.payload.appId], [NEW_ID, true, APP]);
  assert.deepStrictEqual(appPages[APP].map((p) => p.pageId), [NEW_ID], 'the page is in the app\'s navigation now');
  assert.strictEqual(genpage.of('create').length, 1);
  assert.strictEqual(readMarker(file).unfinished, undefined, 'finished');
  assert.strictEqual(readMarker(file).appId, APP);
});

test('the completion is for THAT page and no other — the ordinary update guard is not weakened by it', async () => {
  const file = codeFile();
  const appPages = {};
  const genpage = environment({ appPages, onCreate: () => ({ publish: { kind: 'failed', detail: 'timed out' } }) });
  const created = await run(createArgs(file, [...NAMED, '--add-to-sitemap']), genpage);
  assert.strictEqual(created.ok, false);
  assert.strictEqual(readMarker(file).unfinished, 'place');
  const before = fs.readFileSync(markerPath(file), 'utf8');

  // Another page's id, the same marker: refused as an update always is — the page is in no navigation, and the marker is not for it.
  const other = await run(['--env', ENV, '--app-id', APP, '--code-file', file, '--page-id', PAGE, ...P, '--add-to-sitemap'], genpage);
  assert.strictEqual(other.ok, false);
  assert.match(other.payload.error, /--add-to-sitemap cannot be combined with --page-id/, 'the refusal an update has always had');
  const otherUpdate = await run(['--env', ENV, '--app-id', APP, '--code-file', file, '--page-id', PAGE, ...P], genpage);
  assert.strictEqual(otherUpdate.ok, false);
  assert.strictEqual(genpage.of('update').length, 0, 'nothing was written to either page');
  assert.strictEqual(fs.readFileSync(markerPath(file), 'utf8'), before, 'and the marker is as it was');

  // The marker alone does not let an update through for the page it names when it was not created unfinished: a marker that says nothing about it is an ordinary one.
  const finished = codeFile();
  seedBase(finished, { pageId: NEW_ID, appId: APP });
  const ordinary = await run(['--env', ENV, '--app-id', APP, '--code-file', finished, '--page-id', NEW_ID, ...P, '--add-to-sitemap'], environment());
  assert.strictEqual(ordinary.ok, false);
  assert.match(ordinary.payload.error, /--add-to-sitemap cannot be combined with --page-id/);
  const noApp = await run(['--env', ENV, '--code-file', finished, '--page-id', NEW_ID, ...P], untouchable().factory);
  assert.match(noApp.payload.error, /--app-id is required with --page-id/);

  // A marker for the page, unfinished, still refuses what an update refuses about the PAGE: a deployed page that changed since is not overwritten.
  const drifted = codeFile();
  writeMarker(drifted, { version: 1, pageId: PAGE, source: 'upload', deployedSha256: pageHash(TEXT), localSha256: pageHash(TEXT), unfinished: 'publish' });
  const edited = environment({ pages: [{ pageId: PAGE, name: 'Current Page', source: 'export const n = 2;\n' }] });
  const refused = await run(['--env', ENV, '--code-file', drifted, '--page-id', PAGE, ...P], edited);
  assert.strictEqual(refused.ok, false);
  assert.strictEqual(refused.payload.code, 'deployed-changed', 'a changed page is still refused');
  assert.strictEqual(edited.of('update').length, 0);
  // …and one that is not there is still absent.
  const gone = await run(['--env', ENV, '--code-file', drifted, '--page-id', PAGE, ...P], fakeGenpage({}));
  assert.match(gone.payload.error, /does not exist in this environment/);

  // A page created with no app is completed into an app only by being PLACED there: an app named without --add-to-sitemap would attach its tables to an app that does not hold it.
  const appless = codeFile();
  const g = environment({ onCreate: () => ({ publish: { kind: 'failed', detail: 'timed out' } }) });
  await run(['--env', ENV, '--code-file', appless, ...NAMED], g);
  const attach = await run(['--env', ENV, '--app-id', APP, '--code-file', appless, '--page-id', NEW_ID, ...P], untouchable().factory);
  assert.strictEqual(attach.ok, false);
  assert.match(attach.payload.error, /was created with no app, so completing it into app .* needs --add-to-sitemap/);
});

test('an app-bound create that asked for no placement and whose publish failed is completed by the same command with --page-id — published, its views pinned, and never placed', async () => {
  const file = codeFile();
  const appPages = {};
  const genpage = environment({ pages: [], appPages, onCreate: () => ({ publish: { kind: 'failed', detail: 'timed out' } }) });
  const args = createArgs(file, [...NAMED, '--data-sources', 'account']);
  const first = await run(args, genpage);
  assert.strictEqual(first.ok, false);
  assert.strictEqual(readMarker(file).unfinished, 'publish', 'no placement was asked for, so only the publish is left');
  assert.match(first.payload.error, /publishes it without the check of the app's navigation/);
  assert.doesNotMatch(first.payload.error, /places it in the app/);

  const second = await run([...args, ...adviceFor(first)], genpage);
  assert.strictEqual(second.ok, true, JSON.stringify(second.payload));
  assert.strictEqual(genpage.of('enumeratePages').length, 0, 'the app\'s navigation is not asked: the marker is the proof for this page');
  assert.deepStrictEqual(only(genpage, 'placeInApp'), [APP, { pages: [], dataSources: 'account' }], 'the tables\' default views are pinned, and no page is placed');
  assert.strictEqual(second.payload.addedToSitemap, undefined);
  assert.strictEqual(readMarker(file).unfinished, undefined, 'finished, so no later update skips the proof');
  // …which is the point: the page is not in the app's navigation, so an ordinary update of it is refused again, as it is for any page that is not.
  const later = await run(updateArgs(file).map((a) => (a === PAGE ? NEW_ID : a)), genpage);
  assert.strictEqual(later.ok, false);
  assert.match(later.payload.error, /has no generative pages, or could not be found/);
});

test('a create that could not be placed leaves the page unfinished too — and the same command again, with --page-id, places it', async () => {
  const file = codeFile();
  const appPages = {};
  let placementFails = true;
  const genpage = environment({
    pages: [],
    appPages,
    placement: (appId, options) => {
      if (placementFails) throw new Error('the app could not be saved');
      for (const p of options.pages) (appPages[appId] = appPages[appId] || []).push({ pageId: p.pageId, name: p.title });
      return { added: options.pages.map((p) => String(p.pageId)), alreadyPlaced: [], pinnedViews: [], warnings: [], appEdited: true };
    },
  });
  const args = createArgs(file, [...NAMED, '--add-to-sitemap']);
  const first = await run(args, genpage);
  assert.strictEqual(first.ok, false);
  assert.match(first.payload.error, new RegExp(`page ${NEW_ID} was created and published, but NOT added to app ${APP}'s navigation: the app could not be saved`));
  assert.match(first.payload.error, new RegExp(`Add the page to the app navigation with node scripts/genpage\\.js add-to-app --env \\S+ --app-id ${APP} --page-id ${NEW_ID}, or run the same command again with --page-id `));
  assert.doesNotMatch(first.payload.error, /in Maker/);
  assert.strictEqual(readMarker(file).unfinished, 'place');

  placementFails = false;
  const second = await run([...args, ...adviceFor(first)], genpage);
  assert.strictEqual(second.ok, true, JSON.stringify(second.payload));
  assert.strictEqual(second.payload.addedToSitemap, true);
  assert.deepStrictEqual(appPages[APP].map((p) => p.pageId), [NEW_ID]);
  assert.strictEqual(genpage.of('create').length, 1);
  assert.strictEqual(readMarker(file).unfinished, undefined);
});

// A placement can be SAVED and not published: the app's navigation holds the page, and the publish of the app failed. The run that completes it finds the page in the saved
// navigation, so a placement that only looks for what is missing has nothing to do — and used to answer "placed" while the app that runs did not show the page, and the marker
// stopped saying the page was unfinished. Completing a placement is publishing the app and seeing the page in what runs.
test('completing a placement asks the backend to FINISH it — and the marker stops saying the page is unfinished only once the backend finishes it, which it does not while the published navigation lacks the page', async () => {
  const file = codeFile();
  const appPages = {};
  let answer = 'saved, not published';
  const genpage = environment({
    pages: [],
    appPages,
    placement: (appId, options) => {
      const saved = (appPages[appId] = appPages[appId] || []);
      for (const p of options.pages) if (!saved.some((s) => s.pageId === p.pageId)) saved.push({ pageId: p.pageId, name: p.title });
      if (answer === 'saved, not published') throw Object.assign(new Error(`the navigation of app ${appId} was saved, but publishing the app failed (503)`), { code: 'GENPAGE_APP_PUBLISH_FAILED', saved: true });
      if (answer === 'published, not showing') throw Object.assign(new Error(`app ${appId} was published, but its published navigation does not show page ${NEW_ID} yet (it is not listed)`), { code: 'GENPAGE_APP_PUBLISH_UNPROVEN', saved: true });
      return { added: [], alreadyPlaced: options.pages.map((p) => String(p.pageId)), pinnedViews: [], warnings: [], appEdited: false, provedPublished: true };
    },
  });
  const args = createArgs(file, [...NAMED, '--add-to-sitemap']);
  const first = await run(args, genpage);
  assert.strictEqual(first.ok, false);
  assert.deepStrictEqual(appPages[APP].map((p) => p.pageId), [NEW_ID], 'the navigation was saved with the page');
  assert.strictEqual(readMarker(file).unfinished, 'place');
  assert.strictEqual(genpage.of('placeInApp')[0].args[1].finish, undefined, 'a first placement is an ordinary one');

  // The advice, run: the saved navigation names the page, so there is nothing to write — and the backend is asked to finish the placement all the same.
  answer = 'published, not showing';
  const unproved = await run([...args, ...adviceFor(first)], genpage);
  assert.strictEqual(unproved.ok, false, 'a backend that did not see the page in the published navigation has not finished the placement');
  // The placement IS saved, so the report says so and says what is left — the app's publish — and never that the page was "NOT added" or that it has to be added in Maker.
  assert.match(unproved.payload.error, new RegExp(`page ${NEW_ID} was saved and published, and it is placed in app ${APP}'s saved navigation, but the app's publish is not finished: app ${APP} was published, but its published navigation does not show page ${NEW_ID} yet`));
  assert.doesNotMatch(unproved.payload.error, /NOT added/);
  assert.doesNotMatch(unproved.payload.error, /Add the page to the app navigation in Maker/);
  assert.match(unproved.payload.error, new RegExp(`run the same command again with --page-id ${NEW_ID} added`));
  assert.strictEqual(unproved.payload.pageId, NEW_ID);
  assert.strictEqual(readMarker(file).unfinished, 'place', 'so the page is still unfinished: it can be completed again');

  answer = 'finished';
  const third = await run([...args, ...adviceFor(first)], genpage);
  assert.strictEqual(third.ok, true, JSON.stringify(third.payload));
  assert.strictEqual(readMarker(file).unfinished, undefined, 'finished once the app was published with the page');
  assert.deepStrictEqual(genpage.of('placeInApp').map((c) => c.args[1].finish), [undefined, true, true], 'the two completions asked for a finish; the first placement did not');
  assert.strictEqual(genpage.of('create').length, 1, 'and no second page was created');
});

// ── The title of the page's entry is written in the environment's base language ──────────────────────────────────────────────────────────
// A title in a language the environment has not provisioned does not show, and the SDK writes its entries in 1033 when it is told nothing. `genpage.js add-to-app` reads the base
// language and says it to the placement; an upload that places a page — first, and when it completes a placement an earlier run began — is that placement too. (The German-only
// environment, against the real SDK and the published sitemap, is genpage-upload-language-real-bundle.test.js.)
test('--add-to-sitemap asks for the environment\'s base language once, before the placement — and tells the placement, in whatever language it is', async () => {
  for (const language of [1031, 1033]) {
    const genpage = environment({ language });
    const r = await run(createArgs(codeFile(), [...NAMED, '--add-to-sitemap', '--data-sources', 'account']), genpage);
    assert.strictEqual(r.ok, true, JSON.stringify(r.payload));
    assert.deepStrictEqual(only(genpage, 'placeInApp'), [APP, { pages: [{ pageId: NEW_ID, title: 'N' }], dataSources: 'account', languageCode: language }]);
    const order = genpage.calls.map((c) => c.method);
    assert.strictEqual(order.filter((method) => method === 'baseLanguage').length, 1, 'asked once');
    assert.ok(order.indexOf('create') < order.indexOf('baseLanguage') && order.indexOf('baseLanguage') < order.indexOf('placeInApp'), `the page is written, then the language read, then the placement: ${order.join(', ')}`);
  }
});

test('an upload that places no page — it only pins the views of its tables — does not ask for the language: no title is written', async () => {
  const genpage = environment({ language: 1031 });
  const r = await run(createArgs(codeFile(), [...NAMED, '--data-sources', 'account']), genpage);
  assert.strictEqual(r.ok, true, JSON.stringify(r.payload));
  assert.strictEqual(genpage.of('baseLanguage').length, 0);
  assert.deepStrictEqual(only(genpage, 'placeInApp'), [APP, { pages: [], dataSources: 'account' }]);
  // Nor does an upload that names no app at all.
  const appless = environment({ language: 1031 });
  assert.strictEqual((await run(['--env', ENV, '--code-file', codeFile(), ...NAMED], appless)).ok, true);
  assert.deepStrictEqual(appless.of('baseLanguage'), []);
});

test('a language that cannot be read leaves the placement unfinished — nothing is guessed in its place, and the only thing said of the navigation is that this run changed nothing in it', async () => {
  const file = codeFile();
  const unreadable = Object.assign(new Error(`HTTP 503 from ${ENV}/api/data/v9.0/organizations?$select=languagecode: the service is busy`), { code: 'CONNECTION_ERROR' });
  const genpage = environment({ languageError: unreadable });
  const r = await run(createArgs(file, [...NAMED, '--add-to-sitemap']), genpage);
  assert.strictEqual(r.ok, false, 'an unplaced page is not a successful deployment');
  assert.strictEqual(r.payload.pageId, NEW_ID, 'the id is reported, so the page can be completed');
  assert.strictEqual(r.payload.appId, APP);
  assert.match(r.payload.error, new RegExp(`^page ${NEW_ID} was created and published, but its placement in app ${APP}'s navigation is unfinished: the environment's base language, which the entry's title is written in, could not be read \\(HTTP 503 from .*languagecode: the service is busy\\); no other language is assumed in its place\\. This run changed nothing in the app's navigation\\. `));
  assert.match(r.payload.error, new RegExp(`To finish it, run the same command again with --page-id ${NEW_ID} added and nothing else changed, once the language can be read: .*Or run node scripts/genpage\\.js add-to-app --env \\S+ --app-id ${APP} --page-id ${NEW_ID}, which places the page, or finishes a placement that was saved, whichever is left\\.$`));
  assert.doesNotMatch(r.payload.error, /NOT added|in Maker|did not look at/, 'it says nothing of the navigation that it did not learn');
  assert.ok(!('saved' in r.payload), 'and claims no placement that was saved: on a first attempt there is no entry to have been');
  assert.strictEqual(genpage.of('placeInApp').length, 0, 'the app was not edited with a guess');
  assert.strictEqual(readMarker(file).unfinished, 'place');
  assert.strictEqual(genpage.disposed, 1);
});

// The run that COMPLETES a placement reads the language too, and can fail to: an earlier run may have put the page in the app's saved navigation (its publish is what failed), which this run did not
// look at and a failed read does not show. "NOT added … add the page in Maker" would send the user to add a page the navigation holds, so the report says what this run knows and did.
test('the run that COMPLETES a placement and cannot read the language says only what it knows — the page is saved and published, this run changed nothing in the navigation and did not look at what the earlier one saved — and the marker keeps the placement unfinished', async () => {
  const file = codeFile();
  const appPages = {};
  const genpage = environment({
    pages: [],
    appPages,
    language: 1031,
    placement: (appId, options) => {
      const saved = (appPages[appId] = appPages[appId] || []);
      for (const p of options.pages) if (!saved.some((s) => s.pageId === p.pageId)) saved.push({ pageId: p.pageId, name: p.title });
      if (options.finish !== true) throw Object.assign(new Error(`the navigation of app ${appId} was saved, but publishing the app failed (503)`), { code: 'GENPAGE_APP_PUBLISH_FAILED', saved: true });
      return { added: [], alreadyPlaced: options.pages.map((p) => String(p.pageId)), pinnedViews: [], warnings: [], appEdited: false, provedPublished: true };
    },
  });
  const args = createArgs(file, [...NAMED, '--add-to-sitemap']);
  const first = await run(args, genpage);
  assert.strictEqual(first.ok, false);
  assert.match(first.payload.error, new RegExp(`it is placed in app ${APP}'s saved navigation, but the app's publish is not finished`));
  assert.deepStrictEqual(appPages[APP].map((p) => p.pageId), [NEW_ID], 'the navigation was saved with the page');
  assert.strictEqual(readMarker(file).unfinished, 'place');

  // The advice, run, where the language cannot be read.
  const readable = genpage.baseLanguage;
  genpage.baseLanguage = async () => { throw Object.assign(new Error(`HTTP 503 from ${ENV}/api/data/v9.0/organizations?$select=languagecode: the service is busy`), { code: 'CONNECTION_ERROR' }); };
  const placements = genpage.of('placeInApp').length;
  const second = await run([...args, ...adviceFor(first)], genpage);
  assert.strictEqual(second.ok, false);
  assert.match(second.payload.error, new RegExp(`^page ${NEW_ID} was saved and published, but its placement in app ${APP}'s navigation is unfinished: the environment's base language, which the entry's title is written in, could not be read \\(HTTP 503 from .*languagecode: the service is busy\\); no other language is assumed in its place\\. This run changed nothing in the app's navigation, and did not look at what an earlier run saved or published there, so the page may already be in it\\. To finish it, run the same command again with --page-id ${NEW_ID} added and nothing else changed`));
  assert.doesNotMatch(second.payload.error, /NOT added|in Maker/);
  assert.ok(!('saved' in second.payload), 'it did not look at the navigation, so it does not claim it holds the page either');
  assert.strictEqual(second.payload.pageId, NEW_ID);
  assert.strictEqual(genpage.of('placeInApp').length, placements, 'the app was not touched: not edited, not published');
  assert.strictEqual(readMarker(file).unfinished, 'place', 'the placement is still unfinished: the same command completes it');
  assert.strictEqual(genpage.of('create').length, 1);

  // The language can be read: the same command finishes the placement the first run began.
  genpage.baseLanguage = readable;
  const third = await run([...args, ...adviceFor(first)], genpage);
  assert.strictEqual(third.ok, true, JSON.stringify(third.payload));
  assert.deepStrictEqual(genpage.of('placeInApp').slice(-1).map((c) => [c.args[1].languageCode, c.args[1].finish]), [[1031, true]]);
  assert.strictEqual(readMarker(file).unfinished, undefined, 'finished');
});

test('a create whose language cannot be read AND whose base marker could not be written has only the verb to finish by — the report does not offer a marker that is not there', async () => {
  const file = codeFile();
  const unreadable = Object.assign(new Error(`HTTP 503 from ${ENV}/api/data/v9.0/organizations?$select=languagecode: the service is busy`), { code: 'CONNECTION_ERROR' });
  const genpage = environment({ languageError: unreadable });
  const r = await run(createArgs(file, [...NAMED, '--add-to-sitemap']), genpage, { base: { ...realBase, writeMarker() { throw new Error('disk full'); } } });
  assert.strictEqual(r.ok, false);
  assert.match(r.payload.error, new RegExp(`^page ${NEW_ID} was created and published, but its placement in app ${APP}'s navigation is unfinished: the environment's base language, which the entry's title is written in, could not be read \\(.*\\); no other language is assumed in its place\\. This run changed nothing in the app's navigation\\. Once the language can be read, node scripts/genpage\\.js add-to-app --env \\S+ --app-id ${APP} --page-id ${NEW_ID} places the page, or finishes a placement that was saved, whichever is left\\.$`));
  assert.doesNotMatch(r.payload.error, /same command again|NOT added/);
});

// A page created with no app whose publish failed is completed INTO an app by placing it there — a first placement, which no earlier run began, so nothing is said of one that was not looked at.
test('completing a publish that failed INTO an app, where the language cannot be read, says nothing of an earlier placement — none was made — and the marker says the placement is what is left', async () => {
  const file = codeFile();
  const genpage = environment({ pages: [], onCreate: () => ({ publish: { kind: 'failed', detail: 'timed out' } }) });
  const first = await run(['--env', ENV, '--code-file', file, ...NAMED], genpage);
  assert.strictEqual(first.ok, false);
  assert.strictEqual(readMarker(file).unfinished, 'publish');
  genpage.baseLanguage = async () => { throw Object.assign(new Error(`HTTP 503 from ${ENV}/api/data/v9.0/organizations?$select=languagecode: the service is busy`), { code: 'CONNECTION_ERROR' }); };
  const second = await run(['--env', ENV, '--app-id', APP, '--code-file', file, ...NAMED, '--add-to-sitemap', ...adviceFor(first)], genpage);
  assert.strictEqual(second.ok, false);
  assert.match(second.payload.error, new RegExp(`^page ${NEW_ID} was saved and published, but its placement in app ${APP}'s navigation is unfinished: the environment's base language, which the entry's title is written in, could not be read \\(.*\\); no other language is assumed in its place\\. This run changed nothing in the app's navigation\\. To finish it, run the same command again with --page-id ${NEW_ID} added and nothing else changed`));
  assert.doesNotMatch(second.payload.error, /did not look at|NOT added/);
  assert.strictEqual(genpage.of('placeInApp').length, 0);
  assert.strictEqual(readMarker(file).unfinished, 'place', 'the placement is what is left now');
});

test('the run that completes a placement asks for the language and tells the placement too — the first run did not get as far as placing the page, and neither did it read the language', async () => {
  const file = codeFile();
  let publishFails = true;
  const genpage = environment({ pages: [], language: 1031, onCreate: () => (publishFails ? { publish: { kind: 'failed', detail: 'the publish timed out' } } : {}) });
  const args = createArgs(file, [...NAMED, '--add-to-sitemap']);
  const first = await run(args, genpage);
  assert.strictEqual(first.ok, false);
  assert.strictEqual(genpage.of('baseLanguage').length, 0, 'a page that is not published is not placed, so no language is asked for');
  publishFails = false;
  const second = await run([...args, ...adviceFor(first)], genpage);
  assert.strictEqual(second.ok, true, JSON.stringify(second.payload));
  assert.strictEqual(second.payload.addedToSitemap, true);
  assert.deepStrictEqual(genpage.of('placeInApp').map((c) => [c.args[1].languageCode, c.args[1].finish]), [[1031, true]]);
  assert.strictEqual(genpage.of('baseLanguage').length, 1);
});

// A completion that is not a placement — the create asked for none and only its publish failed — has no app to publish: it pins views and never asks for a finish.
test('completing a publish that failed does not ask the backend to finish a placement: no page is placed, so there is no app publish to prove', async () => {
  const file = codeFile();
  const genpage = environment({ pages: [], onCreate: () => ({ publish: { kind: 'failed', detail: 'timed out' } }) });
  const args = createArgs(file, [...NAMED, '--data-sources', 'account']);
  const first = await run(args, genpage);
  assert.strictEqual(first.ok, false);
  const second = await run([...args, ...adviceFor(first)], genpage);
  assert.strictEqual(second.ok, true, JSON.stringify(second.payload));
  assert.deepStrictEqual(genpage.of('placeInApp').map((c) => c.args[1].finish), [undefined], 'the views were pinned, the app was not asked to publish anything');
});

// A page created with no app whose publish failed is completed INTO an app by placing it there. That placement is the first one — an ordinary edit of the app, whose own publish follows
// it — not the completion of one an earlier run began, so the backend is not asked to finish anything. The marker is rewritten to `place` before the placement is made, so a placement that is
// saved and whose app publish fails is finished by the next run, which is then a completion.
test('completing a publish that failed INTO an app places the page as a first placement does — and when that placement is saved but not published, the marker says `place` and the next run finishes it', async () => {
  const file = codeFile();
  const appPages = {};
  let appPublishFails = true;
  const genpage = environment({
    pages: [],
    appPages,
    onCreate: () => ({ publish: { kind: 'failed', detail: 'timed out' } }),
    placement: (appId, options) => {
      const saved = (appPages[appId] = appPages[appId] || []);
      for (const p of options.pages) if (!saved.some((s) => s.pageId === p.pageId)) saved.push({ pageId: p.pageId, name: p.title });
      if (appPublishFails && !options.finish) throw Object.assign(new Error(`the navigation of app ${appId} was saved, but publishing the app failed (503)`), { code: 'GENPAGE_APP_PUBLISH_FAILED', saved: true });
      return { added: [], alreadyPlaced: options.pages.map((p) => String(p.pageId)), pinnedViews: [], warnings: [], appEdited: false, provedPublished: true };
    },
  });
  const first = await run(['--env', ENV, '--code-file', file, ...NAMED], genpage);
  assert.strictEqual(first.ok, false);
  assert.strictEqual(readMarker(file).unfinished, 'publish', 'created with no app: only its publish is left');

  const into = ['--env', ENV, '--app-id', APP, '--code-file', file, ...NAMED, '--add-to-sitemap', ...adviceFor(first)];
  const second = await run(into, genpage);
  assert.strictEqual(second.ok, false, 'the app could not be published');
  assert.match(second.payload.error, new RegExp(`placed in app ${APP}'s saved navigation, but the app's publish is not finished: the navigation of app ${APP} was saved, but publishing the app failed \\(503\\)`));
  assert.doesNotMatch(second.payload.error, /NOT added|Add the page to the app navigation in Maker/, 'a placement that is saved is not reported as one that is not');
  assert.deepStrictEqual(genpage.of('placeInApp').map((c) => c.args[1].finish), [undefined], 'a first placement is an ordinary one, even when it completes a page');
  assert.strictEqual(readMarker(file).unfinished, 'place', 'the placement is what is left now');

  appPublishFails = false;
  const third = await run(into, genpage);
  assert.strictEqual(third.ok, true, JSON.stringify(third.payload));
  assert.deepStrictEqual(genpage.of('placeInApp').map((c) => c.args[1].finish), [undefined, true], 'the next run completes the placement the second one began');
  assert.strictEqual(readMarker(file).unfinished, undefined, 'finished');
  assert.strictEqual(genpage.of('create').length, 1, 'and no second page was created');
});

// The same, through the real backend over the scripted SDK — the app's navigation and its two layers modelled: a publish that fails leaves the saved navigation naming the page and
// the published one not; the advice's second run must publish the app again, and the page must be in what runs before the marker is cleared.
function appWithPublishedLayer({ publishTakesEffect = true } = {}) {
  const published = { xml: '<SiteMap><Area Id="a"><Group Id="g"/></Area></SiteMap>', publishes: [] };
  const sdk = new FakeSdk({
    records: {
      appmodule: (o) => (/^appmoduleid eq /.test(o.filter) ? [{ uniquename: 'contoso_review' }] : [{ appmoduleid: APP, appmoduleidunique: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb' }]),
      appmodulecomponent: () => [{ objectid: 'dddddddd-4444-4444-8444-dddddddddddd', componenttype: 62 }],
      sitemap: () => [{ sitemapxml: published.xml }],
    },
  }).seedApp({ id: APP, name: 'Review app', siteMap: { areas: [{ id: 'a', title: 'Main', groups: [{ id: 'g', title: 'Pages', subAreas: [] }] }] } });
  let failNext = true;
  const publishArtifact = sdk.publishArtifact.bind(sdk);
  sdk.publishArtifact = async (type, id, options) => {
    if (type !== 'app') return publishArtifact(type, id, options);
    sdk.calls.push({ name: 'publishArtifact', args: [type, id, options] });
    if (failNext) { failNext = false; published.publishes.push('failed'); throw new Error('PublishXml transient failure'); }
    published.publishes.push('accepted');
    // PublishXml copies the saved navigation to the published one — unless it has not taken effect yet.
    if (publishTakesEffect) published.xml = `<SiteMap><Area Id="a"><Group Id="g">${(sdk.apps.get(id).siteMap.areas[0].groups[0].subAreas || []).map((s) => `<SubArea Id="${s.id}" GenPageId="${s.genPageId}"/>`).join('')}</Group></Area></SiteMap>`;
    return { type, id, shipped: true, publish: { kind: 'submitted' } };
  };
  return { sdk, published };
}

test('REAL BACKEND over the scripted SDK: the advice after a placement that was saved and not published publishes the app again — the page is in the published navigation, and only then is the marker cleared', async () => {
  const { sdk, published } = appWithPublishedLayer();
  const file = codeFile();
  const args = ['--env', ENV, '--app-id', APP, '--code-file', file, ...NAMED, '--add-to-sitemap'];
  const make = () => makeGenpageSdk(ENV, { sdk, newId: () => NEW_ID });
  const first = await run(args, make);
  assert.strictEqual(first.ok, false);
  assert.match(first.payload.error, /saved, but publishing the app failed \(PublishXml transient failure\)/);
  assert.strictEqual(readMarker(file).unfinished, 'place');
  assert.strictEqual(sdk.apps.get(APP).siteMap.areas[0].groups[0].subAreas.length, 1, 'the saved navigation holds the page');
  assert.ok(!published.xml.includes(NEW_ID), 'the app that runs does not');

  const second = await run([...args, ...adviceFor(first)], make);
  assert.strictEqual(second.ok, true, JSON.stringify(second.payload));
  assert.deepStrictEqual(published.publishes, ['failed', 'accepted'], 'the app was published again');
  assert.ok(published.xml.includes(NEW_ID), 'and the page is in what runs');
  assert.strictEqual(sdk.count('pushArtifact'), 1 + 1, 'the page and the app were pushed once each: the completion wrote nothing');
  assert.strictEqual(readMarker(file).unfinished, undefined, 'the marker is cleared once that is proven');
});

test('REAL BACKEND over the scripted SDK: a completion whose app publish took no effect is not finished — the marker stays, and the failure says to run it again', async () => {
  const { sdk, published } = appWithPublishedLayer({ publishTakesEffect: false });
  const file = codeFile();
  const args = ['--env', ENV, '--app-id', APP, '--code-file', file, ...NAMED, '--add-to-sitemap'];
  const make = () => makeGenpageSdk(ENV, { sdk, newId: () => NEW_ID });
  const first = await run(args, make);
  assert.strictEqual(first.ok, false);
  const second = await run([...args, ...adviceFor(first)], make);
  assert.strictEqual(second.ok, false, 'the publish was accepted and the page is not in what runs: not finished');
  assert.match(second.payload.error, /its published navigation does not show page .* yet/);
  assert.match(second.payload.error, /it is placed in app \S+'s saved navigation, but the app's publish is not finished/, 'the placement is saved, and what is left is the app\'s publish');
  assert.doesNotMatch(second.payload.error, /NOT added|Add the page to the app navigation in Maker/, 'the page is in the navigation: it is not to be added in Maker');
  assert.match(second.payload.error, /run the same command again with --page-id/);
  assert.deepStrictEqual(published.publishes, ['failed', 'accepted']);
  assert.strictEqual(readMarker(file).unfinished, 'place', 'still unfinished');
  assert.strictEqual(second.payload.pageId, NEW_ID);
});

test('an update that changes nothing says so; the backend\'s warnings are passed on', async () => {
  const same = await updating();
  assert.strictEqual(same.r.ok, true);
  assert.deepStrictEqual([same.r.payload.updated, same.r.payload.unchanged], [true, true]);
  const changed = await updating(P, {}, `${TEXT}// edited\n`);
  assert.strictEqual(changed.r.payload.unchanged, undefined);

  const genpage = environment({ onCreate: () => ({ warnings: ['the service rewrote the compiled output', 'another thing'] }) });
  const r = await run(createArgs(codeFile()), genpage);
  assert.deepStrictEqual(r.payload.warnings, ['the service rewrote the compiled output', 'another thing']);
});

test('a write the backend refuses is reported as it said, and the base marker is left as it was', async () => {
  const file = codeFile();
  seedBase(file);
  const before = fs.readFileSync(markerPath(file), 'utf8');
  const refusing = environment({ onUpdate: () => { throw Object.assign(new Error('page was NOT changed: the service refused the edit'), { outcome: 'nothing' }); } });
  const r = await run(updateArgs(file), refusing);
  // What the backend knows about the failure goes out with it: the update's page and app (named up front), whether anything was written, and the SDK's code.
  assert.deepStrictEqual([r.ok, r.payload], [false, { error: 'page was NOT changed: the service refused the edit', pageId: PAGE, appId: APP, outcome: 'nothing' }]);
  assert.strictEqual(fs.readFileSync(markerPath(file), 'utf8'), before, 'nothing was written, so nothing is recorded');
  const created = await run(createArgs(codeFile()), environment({ onCreate: () => { throw new Error('the page could not be created'); } }));
  assert.deepStrictEqual([created.ok, created.payload], [false, { error: 'the page could not be created' }], 'a create that failed before it sent anything has no page to name');
});

// The recovery identity of a write the backend could not account for (a create whose answer was lost, whose page could not be read back) is in the error: the id to look for,
// that it is UNKNOWN whether anything was written, and the SDK's own code. The CLI used to turn every backend error into its message alone, so a caller read "unknown" as
// "failed" and had no id to find the page by.
test('a create whose outcome is unknown reports the id to look for, the outcome and the code — in the failure payload', async () => {
  const unknown = environment({
    onCreate: () => { throw Object.assign(new Error('the outcome of creating it is unknown (reset)'), { outcome: 'unknown', pageId: NEW_ID, code: 'CONNECTION_ERROR' }); },
  });
  const r = await run(createArgs(codeFile()), unknown);
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(r.payload, { error: 'the outcome of creating it is unknown (reset)', pageId: NEW_ID, appId: APP, outcome: 'unknown', code: 'CONNECTION_ERROR' });
  // Without an app named, the app is not claimed.
  const noApp = await run(['--env', ENV, '--code-file', codeFile(), ...NAMED], unknown);
  assert.deepStrictEqual(noApp.payload, { error: 'the outcome of creating it is unknown (reset)', pageId: NEW_ID, outcome: 'unknown', code: 'CONNECTION_ERROR' });
  // A code that is not a string (an errno number, nothing) is not passed off as one.
  const odd = environment({ onCreate: () => { throw Object.assign(new Error('boom'), { code: 5, outcome: 'unknown', pageId: NEW_ID }); } });
  assert.strictEqual((await run(createArgs(codeFile()), odd)).payload.code, undefined);
});

test('a failure after the write cannot drop the page id it already knows — the id outlives the try that learned it', async () => {
  // The page was created and the backend answered, and then something the script did not plan for threw (here: an answer whose `warnings` cannot be read as a list).
  const file = codeFile();
  const genpage = environment({ onCreate: () => ({ warnings: 5 }) });
  const r = await run(createArgs(file), genpage);
  assert.strictEqual(r.ok, false);
  assert.match(r.payload.error, /not iterable/);
  assert.strictEqual(r.payload.pageId, NEW_ID, 'the page exists, and the report still names it');
  assert.strictEqual(r.payload.appId, APP);
  // An update that fails names its own page too, whatever it is that failed.
  const f = codeFile();
  seedBase(f);
  const failing = environment({ onUpdate: () => { throw new Error('socket hang up'); } });
  const u = await run(updateArgs(f), failing);
  assert.strictEqual(u.payload.pageId, PAGE);
  assert.strictEqual(u.payload.appId, APP);
});

// The real emitter calls process.exit, so a cleanup placed after an emit never runs — and the backend's workspace holds the page's source.
test('the backend is disposed before anything is reported — on success, on a refusal and on a failed write', async () => {
  const ok = await run(createArgs(codeFile()), environment());
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(ok.disposedAtEmit, 1, 'success');
  const refused = await run(updateArgs(codeFile()), environment());
  assert.strictEqual(refused.payload.code, 'no-base');
  assert.strictEqual(refused.disposedAtEmit, 1, 'a refusal');
  const failed = await run(createArgs(codeFile()), environment({ onCreate: () => { throw new Error('boom'); } }));
  assert.strictEqual(failed.ok, false);
  assert.strictEqual(failed.disposedAtEmit, 1, 'a failed write');
});

// dispose() answers `{ left }`: the folders it could not remove, each still holding the page's source. The upload dropped the answer, so it reported success with the source in the temp directory
// and not a word about it. It is a warning of the result now, whichever way the run ends.
test('a backend workspace that could not be removed is a warning of the result — on success and on a failed write — and nothing is said when none is left', async () => {
  const left = ['C:\\temp\\genpage-x1y2z3'];
  const words = `the page workspace could not be removed, so page source may be left on disk: ${left[0]} — delete the folder by hand`;
  const worked = await run(createArgs(codeFile()), environment({ left }));
  assert.strictEqual(worked.ok, true);
  assert.deepStrictEqual(worked.payload.warnings, [words]);
  const failed = await run(createArgs(codeFile()), environment({ left, onCreate: () => { throw new Error('boom'); } }));
  assert.strictEqual(failed.ok, false);
  assert.deepStrictEqual(failed.payload, { error: 'boom', warnings: [words] });
  const refused = await run(updateArgs(codeFile()), environment({ left }));
  assert.strictEqual(refused.payload.code, 'no-base');
  assert.deepStrictEqual(refused.payload.warnings, [words], 'a refusal after the backend was made carries it too');
  // Beside the backend's own warnings, after them.
  const noted = await run(createArgs(codeFile()), environment({ left, onCreate: () => ({ warnings: ['the service rewrote the compiled output'] }) }));
  assert.deepStrictEqual(noted.payload.warnings, ['the service rewrote the compiled output', words]);
  const clean = await run(createArgs(codeFile()), environment());
  assert.strictEqual(clean.payload.warnings, undefined);
});

// ── #673: an update must not replace a deployed page that drifted from its base ─────────────────────────────────────────────────────
// A create records the hash of the file it sent. A readback that hashes equal (a BOM and a final CRLF are not a difference) confirms it; a readback that differs is not the
// trusted base, or the next update would treat that rewrite as ours.

test('an update with a matching base marker writes, and records the observed deployed hash', async () => {
  const { file, genpage, r } = await updating();
  assert.strictEqual(r.ok, true, JSON.stringify(r.payload));
  assert.strictEqual(genpage.of('update').length, 1);
  assert.strictEqual(r.payload.overwroteDeployed, undefined);
  const marker = readMarker(file);
  assert.deepStrictEqual([marker.source, marker.deployedSha256, marker.localSha256, marker.pageId, marker.appId], ['upload', pageHash(TEXT), pageHash(TEXT), PAGE, APP]);
});

test('an update with no marker, or a marker for another page, is refused no-base and does not write', async () => {
  const file = codeFile();
  const genpage = environment();
  const absent = await run(updateArgs(file), genpage);
  assert.strictEqual(absent.ok, false);
  assert.strictEqual(absent.payload.code, 'no-base');
  assert.match(absent.payload.error, /overwrite-deployed/);
  assert.strictEqual(genpage.of('update').length, 0);

  seedBase(file, { pageId: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb' });
  const other = await run(updateArgs(file), genpage);
  assert.strictEqual(other.ok, false);
  assert.strictEqual(other.payload.code, 'no-base');
  assert.strictEqual(genpage.of('update').length, 0);
});

test('a deployed page that drifted is refused, with a copy and a line summary, and is not written', async () => {
  const file = codeFile();
  seedBase(file);
  const genpage = environment({ pages: [{ pageId: PAGE, name: 'Current Page', source: 'export const n = 2;\n' }] });
  const r = await run(updateArgs(file), genpage);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.payload.code, 'deployed-changed');
  assert.strictEqual(genpage.of('update').length, 0);
  assert.ok(r.payload.lines.added + r.payload.lines.removed > 0);
  assert.strictEqual(r.payload.deployedCopy, deployedCopyPath(file));
  assert.match(fs.readFileSync(r.payload.deployedCopy, 'utf8'), /export const n = 2/);
});

test('--overwrite-deployed writes and says so; =false does not authorize an overwrite', async () => {
  const changed = { pages: [{ pageId: PAGE, name: 'Current Page', source: 'export const n = 9;\n' }] };
  const forced = environment(changed);
  const r = await run(updateArgs(codeFile(), [...P, '--overwrite-deployed']), forced);
  assert.strictEqual(r.ok, true, JSON.stringify(r.payload));
  assert.strictEqual(r.payload.overwroteDeployed, true);
  assert.strictEqual(forced.of('update').length, 1);

  const refused = environment(changed);
  const no = await run(updateArgs(codeFile(), [...P, '--overwrite-deployed=false']), refused);
  assert.strictEqual(no.ok, false);
  assert.strictEqual(no.payload.code, 'no-base');
  assert.strictEqual(refused.of('update').length, 0);
});

test('a create trusts a readback only when it hashes equal, so a rewrite is unverified and the fix-up refuses', async () => {
  const idSame = 'aaaaaaaa-1111-4111-8111-aaaaaaaa0001';
  const idRewritten = 'bbbbbbbb-2222-4222-8222-bbbbbbbb0002';
  const fileSame = codeFile('export const A = 1;\n');
  const fileRewritten = codeFile('export const B = 1;\n');
  // What the service holds of each page: the first as an earlier release's download wrote it — a BOM and a final CRLF are not a difference — and the second with a line added.
  const stored = { [idSame]: '\uFEFFexport const A = 1;\r\n', [idRewritten]: 'export const B = 1;\n// stored\n' };
  let minted = idSame;
  const genpage = fakeGenpage({ newId: () => minted, appPages: { [APP]: [{ pageId: idSame }, { pageId: idRewritten }] } });
  const read = genpage.read;
  genpage.read = async (id) => ({ ...(await read(id)), source: stored[String(id).toLowerCase()] });
  const create = (file) => run(createArgs(file), genpage);

  const same = await create(fileSame);
  assert.strictEqual(same.ok, true, JSON.stringify(same.payload));
  assert.strictEqual(readMarker(fileSame).source, 'upload');
  assert.strictEqual(readMarker(fileSame).deployedSha256, pageHash('export const A = 1;\n'));
  assert.strictEqual(same.payload.warnings, undefined, 'BOM and a final CRLF are not a rewrite');

  minted = idRewritten;
  const rewritten = await create(fileRewritten);
  assert.strictEqual(rewritten.ok, true, JSON.stringify(rewritten.payload));
  assert.strictEqual(readMarker(fileRewritten).source, 'upload-unverified');
  assert.strictEqual(readMarker(fileRewritten).deployedSha256, pageHash('export const B = 1;\n'));
  assert.notStrictEqual(readMarker(fileRewritten).deployedSha256, pageHash(stored[idRewritten]));
  assert.match(rewritten.payload.warnings.join('\n'), /differs from what was just uploaded \(1 lines added, 0 removed\)/);
  assert.match(rewritten.payload.warnings.join('\n'), /genpage-base\.js check/);
  assert.match(rewritten.payload.warnings.join('\n'), /deployed-changed/);

  const before = genpage.of('update').length;
  const fix = (file, id) => run(['--env', ENV, '--app-id', APP, '--code-file', file, '--page-id', id, '--prompt', 'resolve PAGEREF'], genpage);
  const fixSame = await fix(fileSame, idSame);
  assert.strictEqual(fixSame.ok, true, `a verified readback must not false-positive the fix-up: ${JSON.stringify(fixSame.payload)}`);
  assert.strictEqual(genpage.of('update').length, before + 1);
  const fixRewritten = await fix(fileRewritten, idRewritten);
  assert.strictEqual(fixRewritten.ok, false);
  assert.strictEqual(fixRewritten.payload.code, 'deployed-changed');
  assert.strictEqual(genpage.of('update').length, before + 1, 'an unverified rewrite must not be written over as if it were our base');
});

test('a save that lands between the write and the readback is not trusted, and the next update is refused deployed-changed', async () => {
  const file = codeFile('export const n = 1;\n');
  const other = 'export const other = 1;\n';
  const genpage = fakeGenpage({ newId: () => NEW_ID, appPages: { [APP]: [{ pageId: NEW_ID }] } });
  const read = genpage.read;
  genpage.read = async (id) => ({ ...(await read(id)), source: other });
  const created = await run(createArgs(file), genpage);
  assert.strictEqual(created.ok, true, JSON.stringify(created.payload));
  assert.strictEqual(created.payload.pageId, NEW_ID);
  assert.ok(Array.isArray(created.payload.warnings), 'a differing readback must warn, not become the trusted hash');
  assert.match(created.payload.warnings.join('\n'), /differs from what was just uploaded \(1 lines added, 1 removed\)/);
  assert.match(created.payload.warnings.join('\n'), /another save landed right after/);
  const marker = readMarker(file);
  assert.strictEqual(marker.source, 'upload-unverified');
  assert.strictEqual(marker.deployedSha256, pageHash('export const n = 1;\n'));
  assert.notStrictEqual(marker.deployedSha256, pageHash(other));

  const next = await run(['--env', ENV, '--app-id', APP, '--code-file', file, '--page-id', NEW_ID, ...P], genpage);
  assert.strictEqual(next.ok, false);
  assert.strictEqual(next.payload.code, 'deployed-changed');
  assert.strictEqual(genpage.of('update').length, 0, 'the next update must refuse before anything is written');
});

test('a failure anywhere in base recording never turns a completed upload into a failure', async () => {
  const file = codeFile('export const recorded = 1;\n');
  const r = await run(createArgs(file), environment(), { base: { ...realBase, pageHash() { throw new Error('hash failure'); } } });
  assert.strictEqual(r.ok, true, JSON.stringify(r.payload));
  assert.ok(r.payload.pageId, 'the page this run created must still be reported');
  assert.match((r.payload.warnings || []).join('\n'), /could not record a base marker \(hash failure\)/);
});

test('a readback that fails after a successful create still returns the page id, with an unverified base', async () => {
  const file = codeFile('export const fresh = 1;\n');
  const genpage = environment();
  genpage.read = async () => { throw new Error('ECONNRESET on the readback'); };
  const r = await run(createArgs(file), genpage);
  assert.strictEqual(r.ok, true, JSON.stringify(r.payload));
  assert.strictEqual(r.payload.pageId, NEW_ID, 'a create that already succeeded must still report its page id');
  assert.match((r.payload.warnings || []).join('\n'), /could not re-read the deployed page to confirm its hash \(ECONNRESET on the readback\).*unverified/);
  assert.strictEqual(readMarker(file).source, 'upload-unverified');
  assert.strictEqual(readMarker(file).deployedSha256, pageHash('export const fresh = 1;\n'));
});

test('a marker write failure warns and deletes a stale marker; an unreadable deployed page refuses the update', async () => {
  const file = codeFile();
  seedBase(file, { source: 'download' });
  const failed = await run(updateArgs(file), environment(), { base: { ...realBase, writeMarker() { throw new Error('disk full'); } } });
  assert.strictEqual(failed.ok, true, JSON.stringify(failed.payload));
  assert.match(failed.payload.warnings.join('\n'), /could not write the base marker \(disk full\)/);
  assert.strictEqual(fs.existsSync(markerPath(file)), false, 'a failed write must not leave the previous marker');

  const unreadable = codeFile();
  seedBase(unreadable);
  const genpage = environment({ readErrors: { [PAGE]: new Error('the page could not be read') } });
  const refused = await run(updateArgs(unreadable, [...P, '--data-sources', 'contoso_ticket', '--model', 'gpt-4.1']), genpage);
  assert.strictEqual(refused.ok, false);
  assert.strictEqual(refused.payload.code, 'deployed-unreadable');
  assert.strictEqual(genpage.of('update').length, 0);
});

// ── The Griffel check, held where every page upload passes (AB#6691124) ───────────────────────────────────────────────────────────
// Griffel drops ten CSS shorthands from a `makeStyles` object at runtime, and nothing on the way to the service notices: the compile does not execute makeStyles, so the page
// deploys and renders without its border, colour or reset. The skills tell the agent to run scripts/check-griffel-styles.js first, but an instruction is not a gate — a /genpage
// create, an edit-flow update and a browser-verify fix all end in this script, so it refuses such a page itself, with the file, line, column and longhands, before it makes a
// backend, lists, reads or writes anything.
const GRIFFEL_IMPORT = "import { makeStyles, tokens } from '@fluentui/react-components';\n";
const GRIFFEL_BAD = `${GRIFFEL_IMPORT}const useStyles = makeStyles({\n  root: {\n    borderWidth: '1px',\n    padding: '4px',\n  },\n  hover: { ':hover': { borderColor: 'red', borderStyle: 'solid' } },\n});\nexport default function P() { return null; }\n`;
// What a refusal or a warning says each way out of a dropped key does to the page.
const BOTH_WAYS_OUT = 'Deleting a key changes nothing on screen, because Griffel never applied it; writing the longhands (for `all`, the properties you want) makes the style start to render, which changes how the page looks.';
// `needle`'s line and column as an editor counts them: independent of the checker, so the refusal is held to where the key really is.
const placeOf = (source, needle) => {
  const at = source.indexOf(needle);
  const before = source.slice(0, at).split('\n');
  return `${before.length}:${before[before.length - 1].length + 1}`;
};
const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test('a create of a page whose makeStyles drops Griffel shorthands is refused with each key\'s line, column, longhands and both ways out, before a backend is even made', async () => {
  const file = codeFile(GRIFFEL_BAD);
  const none = untouchable();
  const r = await run(createArgs(file, ['--name', 'Overview', ...P, '--agent-message', 'm']), none.factory);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.payload.code, 'griffel-shorthand');
  assert.strictEqual(r.payload.ok, false);
  assert.strictEqual(none.made.n, 0, 'nothing is listed, read or written: the check reads the file and nothing else');
  const error = r.payload.error;
  assert.ok(error.startsWith(`${file} writes CSS that Griffel drops at runtime, so the page would deploy without it — refusing to upload. `), error);
  for (const [needle, longhands] of [
    ['borderWidth', ['borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth']],
    ['borderColor', ['borderTopColor', 'borderRightColor', 'borderBottomColor', 'borderLeftColor']],
    ['borderStyle', ['borderTopStyle', 'borderRightStyle', 'borderBottomStyle', 'borderLeftStyle']],
  ]) {
    assert.ok(error.includes(`${file}:${placeOf(GRIFFEL_BAD, needle)}: \`${needle}\` is not supported by Griffel`), `${needle}: its place is named in the message`);
    assert.ok(error.includes(`Write the longhands instead: ${longhands.join(', ')}.`), `${needle}: and what to write`);
  }
  assert.ok(error.includes(BOTH_WAYS_OUT), 'and what each way out does: deleting a key keeps the look, the longhands start to render');
  assert.match(error, new RegExp(`Fix them in the file \\(\`node scripts/check-griffel-styles\\.js --file ${escapeRe(commandArg(file))}\` lists every one\\), then re-run the upload\\.$`));
  assert.deepStrictEqual(r.payload.problems.map((p) => [p.code, p.property, p.line, p.column]), [
    ['unsupported-shorthand', 'borderWidth', 4, 5], ['unsupported-shorthand', 'borderColor', 7, 24], ['unsupported-shorthand', 'borderStyle', 7, 44],
  ], 'the structured problems ride along, for a caller that reads JSON');
  assert.deepStrictEqual(r.payload.problems.map((p) => p.within), [['root'], ['hover', ':hover'], ['hover', ':hover']], 'with where each sits: the slot, then the selector');
  assert.strictEqual(placeOf(GRIFFEL_BAD, 'borderColor'), '7:24');
  // A single key is "it", not "them".
  const one = codeFile(`${GRIFFEL_IMPORT}const s = makeStyles({ root: { all: 'unset' } });\n`);
  const single = await run(createArgs(one), untouchable().factory);
  assert.match(single.payload.error, /`all` is not supported by Griffel[\s\S]*Fix it in the file/);
  assert.doesNotMatch(single.payload.error, /Fix them/);
});

// An UPDATE is held to what it ADDS. The page is already deployed — possibly with a key Griffel drops that an earlier release let through (its only guard was a grep for
// `borderWidth`) — and the same bytes sent again ship nothing new, while switching a key to its longhands CHANGES how the page renders. The update reads the deployed page anyway,
// for its base check, so the file is compared with it: a key the deployed page already has goes ahead with a warning that says both ways out; only a key it did not have stops
// the upload.
// An UPDATE of the page with `local` as the file and `deployed` as what is deployed (the base marker says the file was downloaded from it, so the base check passes).
async function griffelUpdate(local, deployed, { extra = [], options = {} } = {}) {
  const file = codeFile(local);
  seedBase(file, { deployed, local: deployed });
  const genpage = environment({ pages: [{ pageId: PAGE, name: 'Current Page', source: deployed }], ...options });
  return { file, genpage, r: await run(updateArgs(file, [...P, ...extra]), genpage) };
}

test('an UPDATE of a page that already has the keys — sent as it is, or edited with the keys kept — goes ahead with a warning naming each key and both ways out', async () => {
  for (const [what, local] of [
    ['the deployed page, sent again', GRIFFEL_BAD],
    ['edited, the keys kept', GRIFFEL_BAD.replace("padding: '4px'", "padding: '8px'")],
    ['the keys a line further down', GRIFFEL_BAD.replace('const useStyles', '// moved\nconst useStyles')],
  ]) {
    const { file, genpage, r } = await griffelUpdate(local, GRIFFEL_BAD);
    assert.strictEqual(r.ok, true, `${what}: ${JSON.stringify(r.payload)}`);
    assert.strictEqual(genpage.of('update').length, 1, `${what}: the page is written`);
    const [warning] = r.payload.warnings;
    assert.ok(warning.startsWith(`${file} updates a page that is already deployed, and the deployed page already had these, set the same, so the upload goes on. It writes CSS that Griffel drops at runtime, so the page renders without it as it does today: `), `${what}: ${warning}`);
    for (const needle of ['borderWidth', 'borderColor', 'borderStyle']) assert.ok(warning.includes(`${file}:${placeOf(local, needle)}: \`${needle}\` is not supported by Griffel`), `${what}: ${needle}, at its place in the file that is uploaded`);
    assert.ok(warning.includes(BOTH_WAYS_OUT), `${what}: both ways out`);
    assert.match(warning, new RegExp(`Edit the file to do either \\(\`node scripts/check-griffel-styles\\.js --file ${escapeRe(commandArg(file))}\` lists every one\\); an upload that adds anything the check reports, or sets one of these to another value, is refused\\.$`), what);
  }
});

test('an UPDATE that ADDS a key the deployed page did not have is refused, naming only the new key — and --overwrite-deployed is no way past it', async () => {
  const added = GRIFFEL_BAD.replace('});\nexport default', "  card: { borderStyle: 'dashed' },\n});\nexport default");
  for (const extra of [[], ['--overwrite-deployed']]) {
    const { file, genpage, r } = await griffelUpdate(added, GRIFFEL_BAD, { extra });
    assert.strictEqual(r.ok, false, JSON.stringify(extra));
    assert.strictEqual(r.payload.code, 'griffel-shorthand', JSON.stringify(extra));
    assert.strictEqual(genpage.of('update').length, 0, `${JSON.stringify(extra)}: nothing is written`);
    assert.deepStrictEqual(r.payload.problems.map((p) => [p.property, p.within]), [['borderStyle', ['card']]], 'only the key that is new');
    const error = r.payload.error;
    assert.ok(error.startsWith(`${file} writes CSS that Griffel drops at runtime, so the page would deploy without it — refusing to upload. `), error);
    assert.ok(error.includes(`${file}:${placeOf(added, "borderStyle: 'dashed'")}: \`borderStyle\` is not supported by Griffel`), 'the new key, where it is');
    for (const old of ['borderWidth', 'borderColor']) assert.ok(!error.includes(`${file}:${placeOf(added, old)}:`), `${old} was already deployed, so it is not what stops the upload`);
    assert.ok(error.includes(BOTH_WAYS_OUT));
    assert.match(error, /Fix it in the file \(`node scripts\/check-griffel-styles\.js --file [^`]+` lists every one\), then re-run the upload\.$/);
  }
});

test('an UPDATE is judged key by key: a key removed from one place and set to the same value in another is new there, and so is a second key where there was one — and it is the one that is named', async () => {
  const deployed = `${GRIFFEL_IMPORT}const s = makeStyles({\n  root: { borderWidth: '1px' },\n});\nexport default function P() { return null; }\n`;
  const aboutGriffel = (result) => (result.r.payload.warnings || []).filter((w) => /Griffel/.test(w));
  // The key is removed from `root` and set to the same value in `card`: the deployed page had it in `root` only, so the one in `card` is new — Griffel drops it just the same, and the page
  // would show none of what the edit meant. It stops the upload, naming only that key, as a key it never had would.
  for (const [what, local] of [
    ['set in another slot', deployed.replace("root: { borderWidth: '1px' },", "root: { padding: '1px' },\n  card: { borderWidth: '1px' },")],
    ['the slot renamed', deployed.replace('root:', 'container:')],
  ]) {
    const { file, genpage, r } = await griffelUpdate(local, deployed);
    assert.strictEqual(r.ok, false, `${what}: ${JSON.stringify(r.payload)}`);
    assert.strictEqual(r.payload.code, 'griffel-shorthand', what);
    assert.strictEqual(genpage.of('update').length, 0, `${what}: nothing is written`);
    assert.deepStrictEqual(r.payload.problems.map((p) => [p.property, p.within]), [['borderWidth', [what === 'the slot renamed' ? 'container' : 'card']]], `${what}: the key where it is set now`);
    assert.ok(r.payload.error.includes(`${file}:${placeOf(local, "borderWidth: '1px'")}: \`borderWidth\``), `${what}: named where it is`);
  }
  // A second `borderWidth`, in another slot, is new too — wherever it comes in the file.
  for (const [what, local] of [
    ['after the old one', deployed.replace("root: { borderWidth: '1px' },", "root: { borderWidth: '1px' },\n  card: { borderWidth: '2px' },")],
    ['before the old one', deployed.replace("root: { borderWidth: '1px' },", "card: { borderWidth: '2px' },\n  root: { borderWidth: '1px' },")],
  ]) {
    const { file, genpage, r } = await griffelUpdate(local, deployed);
    assert.strictEqual(r.ok, false, what);
    assert.strictEqual(genpage.of('update').length, 0, what);
    assert.deepStrictEqual(r.payload.problems.map((p) => [p.property, p.within]), [['borderWidth', ['card']]], `${what}: the new one, not the one that was already there`);
    assert.ok(r.payload.error.includes(`${file}:${placeOf(local, "borderWidth: '2px'")}: \`borderWidth\``), `${what}: named where it is`);
    assert.ok(!r.payload.error.includes(`${file}:${placeOf(local, "borderWidth: '1px'")}:`), `${what}: the old one is not named`);
  }
  // The key kept where the deployed page had it is inherited, whatever else is edited around it — with the warning an inherited key gets.
  const kept = await griffelUpdate(deployed.replace("root: { borderWidth: '1px' },", "root: { borderWidth: '1px', padding: '2px' },\n  card: { padding: '1px' },"), deployed);
  assert.strictEqual(kept.r.ok, true, JSON.stringify(kept.r.payload));
  assert.strictEqual(aboutGriffel(kept).length, 1);
  // Fixing the page — the key deleted — is an update like any other.
  const fixed = await griffelUpdate(deployed.replace("root: { borderWidth: '1px' },", "root: { padding: '1px' },"), deployed);
  assert.strictEqual(fixed.r.ok, true);
  assert.deepStrictEqual(aboutGriffel(fixed), [], 'and says nothing about Griffel');
});

// The same place is the same call and the same branch: a key moved to another hook's slot of the same name — `root` is in every hook — or into the other arm of a condition is a new key there, which
// the upload refuses as it refuses any new key; what stays where it was, and what is only reordered, is still the deployed page's.
test('an UPDATE that moves a key to another hook\'s slot of the same name, or into the other arm of a condition, is refused — and one that moves nothing, or only reorders the hooks, goes ahead', async () => {
  const hooks = (a, b, order = 'pc') => {
    const panel = `const usePanel = makeStyles({\n  root: { ${a} },\n});\n`;
    const card = `const useCard = makeStyles({\n  root: { ${b} },\n});\n`;
    return `${GRIFFEL_IMPORT}${order === 'pc' ? panel + card : card + panel}export default function P() { return null; }\n`;
  };
  const arms = (a, b) => `${GRIFFEL_IMPORT}const dark = true;\nconst useStyles = makeStyles(dark ? {\n  root: { ${a} },\n} : {\n  root: { ${b} },\n});\nexport default function P() { return null; }\n`;
  for (const [what, build, owner, branch] of [['two hooks', hooks, 'useCard', 0], ['the arms of a condition', arms, 'useStyles', 1]]) {
    const deployed = build("borderColor: 'red'", "padding: '1px'");
    const moved = build("padding: '1px'", "borderColor: 'red'");
    const { file, genpage, r } = await griffelUpdate(moved, deployed);
    assert.strictEqual(r.ok, false, `${what}: ${JSON.stringify(r.payload)}`);
    assert.strictEqual(r.payload.code, 'griffel-shorthand', what);
    assert.strictEqual(genpage.of('update').length, 0, `${what}: nothing is written`);
    assert.deepStrictEqual(r.payload.problems.map((p) => [p.property, p.owner, p.branch, p.within]), [['borderColor', owner, branch, ['root']]], `${what}: the key where it is set now`);
    assert.ok(r.payload.error.includes(`${file}:${placeOf(moved, "borderColor: 'red'")}: \`borderColor\``), `${what}: named where it is`);
    // What stayed where it was, with the other place edited, is the deployed page's, and the page goes ahead with the warning an inherited key gets.
    const kept = await griffelUpdate(build("borderColor: 'red'", "padding: '2px'"), deployed);
    assert.strictEqual(kept.r.ok, true, `${what}: ${JSON.stringify(kept.r.payload)}`);
    assert.strictEqual(kept.genpage.of('update').length, 1, what);
    assert.strictEqual((kept.r.payload.warnings || []).filter((w) => /Griffel/.test(w)).length, 1, what);
  }
  // Two hooks that swap places in the file and keep their names have each key where it was: the call is told by its name.
  const deployed = hooks("borderColor: 'red'", "borderStyle: 'solid'");
  const reordered = await griffelUpdate(hooks("borderColor: 'red'", "borderStyle: 'solid'", 'cp'), deployed);
  assert.strictEqual(reordered.r.ok, true, JSON.stringify(reordered.r.payload));
  assert.strictEqual(reordered.genpage.of('update').length, 1);
});

// The place of a key is the hook that holds it — told by the name it is bound to at the top of the page, through a type annotation or a property it is assigned to — and the arm of every condition between the call and
// the key, below the call as well as at it. Each of these moves a shorthand to a place the deployed page did not have it in, as the first kind of edit the check exists to stop; the upload refuses it, and writes nothing.
const MOVES = [
  ['a condition in a slot', "const useStyles = makeStyles({ root: dark ? { borderColor: 'red' } : { padding: '1px' } });\n", "const useStyles = makeStyles({ root: dark ? { padding: '1px' } : { borderColor: 'red' } });\n"],
  ['a condition under a selector', "const useStyles = makeStyles({ root: { ':hover': dark ? { borderColor: 'red' } : { padding: '1px' } } });\n", "const useStyles = makeStyles({ root: { ':hover': dark ? { padding: '1px' } : { borderColor: 'red' } } });\n"],
  ['a condition in a spread', "const useStyles = makeStyles({ root: { ...(dark ? { borderColor: 'red' } : { padding: '1px' }) } });\n", "const useStyles = makeStyles({ root: { ...(dark ? { padding: '1px' } : { borderColor: 'red' }) } });\n"],
  ['typed hooks that change places', "const usePanel: Hook = makeStyles({ root: { borderColor: 'red' } });\nconst useCard: Hook = makeStyles({ root: { padding: '1px' } });\n", "const useCard: Hook = makeStyles({ root: { borderColor: 'red' } });\nconst usePanel: Hook = makeStyles({ root: { padding: '1px' } });\n"],
  ['hooks assigned to properties that change places', "const hooks: any = {};\nhooks.panel = makeStyles({ root: { borderColor: 'red' } });\nhooks.card = makeStyles({ root: { padding: '1px' } });\n", "const hooks: any = {};\nhooks.card = makeStyles({ root: { borderColor: 'red' } });\nhooks.panel = makeStyles({ root: { padding: '1px' } });\n"],
  ['hooks of the same name written in two functions that change places', "function panel() { const useStyles = makeStyles({ root: { borderColor: 'red' } }); return useStyles; }\nfunction card() { const useStyles = makeStyles({ root: { padding: '1px' } }); return useStyles; }\n", "function card() { const useStyles = makeStyles({ root: { borderColor: 'red' } }); return useStyles; }\nfunction panel() { const useStyles = makeStyles({ root: { padding: '1px' } }); return useStyles; }\n"],
];
test('an UPDATE that moves a key to another arm of a condition below the call, or to another hook while the hooks change places — however the hooks are typed, assigned or scoped — is refused, and writes nothing', async () => {
  const page = (declarations) => `${GRIFFEL_IMPORT}const dark = true;\ntype Hook = () => Record<string, string>;\n${declarations}export default function P() { return null; }\n`;
  for (const [what, before, after] of MOVES) {
    const { file, genpage, r } = await griffelUpdate(page(after), page(before));
    assert.strictEqual(r.ok, false, `${what}: ${JSON.stringify(r.payload)}`);
    assert.strictEqual(r.payload.code, 'griffel-shorthand', what);
    assert.strictEqual(genpage.of('update').length, 0, `${what}: nothing is written`);
    assert.deepStrictEqual(r.payload.problems.map((p) => p.property), ['borderColor'], `${what}: the key where it is set now`);
    assert.ok(r.payload.error.includes(`${file}:${placeOf(page(after), "borderColor: 'red'")}: \`borderColor\``), `${what}: named where it is`);
  }
});

test('an UPDATE of a page with the same hooks and arms — reformatted, the hooks reordered with their keys, the other place edited — goes ahead with the warning an inherited key gets', async () => {
  const page = (declarations) => `${GRIFFEL_IMPORT}const dark = true;\ntype Hook = () => Record<string, string>;\n${declarations}export default function P() { return null; }\n`;
  for (const [what, before, edited] of [
    ['a condition in a slot, the other arm edited', MOVES[0][1], MOVES[0][1].replace("padding: '1px'", "padding: '2px'")],
    ['a condition in a slot, reformatted', MOVES[0][1], "const useStyles = makeStyles({\n  root: dark\n    ? { borderColor: \"red\" }\n    : { padding: '1px' },\n});\n"],
    ['a condition under a selector, the other arm edited', MOVES[1][1], MOVES[1][1].replace("padding: '1px'", "padding: '2px'")],
    ['a condition in a spread, reformatted', MOVES[2][1], "const useStyles = makeStyles({\n  root: {\n    ...(dark ? { borderColor: 'red' } : { padding: '1px' }),\n  },\n});\n"],
    ['typed hooks reordered with their keys', MOVES[3][1], "const useCard: Hook = makeStyles({ root: { padding: '1px' } });\nconst usePanel: Hook = makeStyles({ root: { borderColor: 'red' } });\n"],
    ['hooks assigned to properties reordered with their keys', MOVES[4][1], "const hooks: any = {};\nhooks.card = makeStyles({ root: { padding: '1px' } });\nhooks.panel = makeStyles({ root: { borderColor: 'red' } });\n"],
  ]) {
    const { genpage, r } = await griffelUpdate(page(edited), page(before));
    assert.strictEqual(r.ok, true, `${what}: ${JSON.stringify(r.payload)}`);
    assert.strictEqual(genpage.of('update').length, 1, `${what}: the page is written`);
    assert.strictEqual((r.payload.warnings || []).filter((w) => /Griffel/.test(w)).length, 1, `${what}: with the warning of an inherited key`);
  }
});

// A key the deployed page already has is not what the check holds back — but a key given ANOTHER value is a change the maker meant to see, and Griffel drops the new value just as it
// dropped the old one: the upload would ship it as a silent no-op, which is the defect this check exists to stop. The value is compared as written (nothing is evaluated), so a
// reformat is not a change.
test('an UPDATE that gives a key the deployed page already had ANOTHER value is refused — the new value would be dropped too — while a reformat of it goes ahead', async () => {
  const deployed = `${GRIFFEL_IMPORT}const useStyles = makeStyles({\n  row: { ':hover': { borderColor: 'red' } },\n});\nexport default function P() { return null; }\n`;
  for (const [what, value] of [['a token', 'tokens.colorBrandStroke1'], ['another colour', "'blue'"]]) {
    for (const extra of [[], ['--overwrite-deployed']]) {
      const local = deployed.replace("'red'", value);
      const { file, genpage, r } = await griffelUpdate(local, deployed, { extra });
      const label = `${what} ${JSON.stringify(extra)}`;
      assert.strictEqual(r.ok, false, label);
      assert.strictEqual(r.payload.code, 'griffel-shorthand', label);
      assert.strictEqual(genpage.of('update').length, 0, `${label}: nothing is written`);
      assert.deepStrictEqual(r.payload.problems.map((p) => [p.property, p.within, p.value]), [['borderColor', ['row', ':hover'], value.startsWith("'") ? '"blue"' : value]], `${label}: the key that was given a new value`);
      assert.ok(r.payload.error.includes(`${file}:${placeOf(local, 'borderColor')}: \`borderColor\` is not supported by Griffel`), `${label}: where it is`);
      assert.ok(r.payload.error.includes(BOTH_WAYS_OUT), label);
    }
  }
  // The same key, set to the same value, written another way: nothing changed, so the page goes ahead with the warning an inherited key gets.
  for (const [what, text] of [
    ['other quotes', deployed.replace("'red'", '"red"')],
    ['other spacing', deployed.replace("{ borderColor: 'red' }", '{\n      borderColor:   \'red\'  ,\n    }')],
  ]) {
    const { file, genpage, r } = await griffelUpdate(text, deployed);
    assert.strictEqual(r.ok, true, `${what}: ${JSON.stringify(r.payload)}`);
    assert.strictEqual(genpage.of('update').length, 1, what);
    assert.ok(r.payload.warnings.some((w) => w.startsWith(`${file} updates a page that is already deployed, and the deployed page already had these, set the same, so the upload goes on. `)), what);
  }
});

test('when the deployed page cannot be read (--overwrite-deployed) there is nothing to compare with, so the update goes ahead with a warning — as the build does for a page it has no record of', async () => {
  const unreadable = { readErrors: { [PAGE]: new Error('the page could not be read') } };
  const file = codeFile(GRIFFEL_BAD);
  const genpage = environment(unreadable);
  const r = await run(updateArgs(file, [...P, '--overwrite-deployed']), genpage);
  assert.strictEqual(r.ok, true, JSON.stringify(r.payload));
  assert.strictEqual(genpage.of('update').length, 1);
  assert.ok(r.payload.warnings[0].startsWith(`${file} updates a page that is already deployed, and the deployed page could not be read to tell which of these it already had, so the upload goes on. `), r.payload.warnings[0]);
  assert.ok(r.payload.warnings[0].includes(BOTH_WAYS_OUT));
  // Without the flag an unreadable deployed page is refused first, as it always was.
  const refused = await run(updateArgs(codeFile(GRIFFEL_BAD)), environment(unreadable));
  assert.strictEqual(refused.payload.code, 'deployed-unreadable');
});

test('a page that is clean — longhands, or the same names in a string, a comment, a template and an inline style — is uploaded as before', async () => {
  const clean = `${GRIFFEL_IMPORT}// borderWidth: 1 would be dropped in makeStyles, but this is a comment\nconst note = 'borderColor: red';\nconst useStyles = makeStyles({ root: { borderTopWidth: '1px', borderTopStyle: 'solid', padding: '4px', border: '1px solid red' } });\n`
    + 'export default function P() { return <div style={{ borderWidth: 1, borderColor: "red" }}>{`borderStyle: solid`}</div>; }\n';
  for (const [what, text] of [['a clean page', clean], ['a page with no makeStyles at all', 'export default function P() { return null; }\n']]) {
    const genpage = environment();
    const r = await run(createArgs(codeFile(text)), genpage);
    assert.strictEqual(r.ok, true, `${what}: ${JSON.stringify(r.payload)}`);
    assert.strictEqual(genpage.of('create').length, 1, what);
  }
  // A file the script cannot read is refused before anything runs: the upload reads the page once and checks those bytes, so there is nothing to check or send — and a
  // file that appears later must not go up unchecked.
  const missing = untouchable();
  const r = await run(createArgs(path.join(tmp(), 'absent.tsx')), missing.factory);
  assert.strictEqual(r.ok, false);
  assert.match(r.payload.error, /^--code-file could not be read: .*ENOENT/);
  assert.strictEqual(missing.made.n, 0, 'nothing is listed, read or written');
});

test('a call the checker cannot read for certain is refused too, and one that lies before the lexer\'s first guess is read as usual', async () => {
  const call = 'const useStyles = makeStyles({ root: { borderWidth: 1 } });';
  const guess = 'const o = {a: 1} / 2; const x = /re/;';
  const after = codeFile(`${GRIFFEL_IMPORT}${guess}\n${call}\nexport default function P() { return null; }\n`);
  const r = await run(createArgs(after), untouchable().factory);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.payload.code, 'griffel-shorthand');
  assert.match(r.payload.error, /the makeStyles call here cannot be checked for certain/);
  assert.deepStrictEqual(r.payload.problems.map((p) => p.code), ['unverifiable-style-call']);
  // The same page with its call moved above the guess is clean and uploads.
  const before = codeFile(`${GRIFFEL_IMPORT}const useStyles = makeStyles({ root: { borderTopWidth: 1 } });\n${guess}\nexport default function P() { return null; }\n`);
  const ok = await run(createArgs(before), environment());
  assert.strictEqual(ok.ok, true, JSON.stringify(ok.payload));
});

// A call the checker cannot read is not a key Griffel drops: a valid page with `if (s) { } /x/.test(s);` before a clean makeStyles must not be refused as "writes CSS that Griffel
// drops at runtime", which sends the author looking for CSS that is not there when only rewriting the code gets past it. The refusal says what it is, and what to change; and the
// command it suggests is a whole one — a path with a space (a Windows profile folder often has one) stays ONE argument in it.
const GRIFFEL_UNREADABLE = `${GRIFFEL_IMPORT}export function skip(s: string) { if (s) { } /x/.test(s); }\nconst useStyles = makeStyles({ root: { padding: '4px' } });\nexport default function P() { return null; }\n`;
function spacedFile(text) {
  const dir = path.join(tmp(), 'Dev User');
  fs.mkdirSync(dir);
  const file = path.join(dir, 'page.tsx');
  fs.writeFileSync(file, text);
  return file;
}

test('a call the checker cannot read is refused as one it could not read — not as CSS Griffel drops — and the command it suggests keeps a path with a space as one argument', async () => {
  const file = spacedFile(GRIFFEL_UNREADABLE);
  const r = await run(createArgs(file), untouchable().factory);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.payload.code, 'griffel-shorthand');
  const error = r.payload.error;
  assert.ok(error.startsWith(`${file} has makeStyles calls the Griffel check could not read, so it cannot tell whether the page writes CSS that Griffel drops at runtime — refusing to upload. ${file}:3:19: the makeStyles call here cannot be checked for certain`), error);
  assert.doesNotMatch(error, /writes CSS that Griffel drops at runtime, so the page would deploy without it/, 'it is not said to write any');
  assert.match(error, /put an operand in parentheses, \(\{ … \}\) \/ 2 or \(\/re\/\)\.test\(text\), or end the statement with a ";" — or move the makeStyles call above it\./, 'what to change');
  assert.ok(error.endsWith(`Change the file as that says (\`node scripts/check-griffel-styles.js --file '${file}'\` shows what it cannot read), then re-run the upload.`), error);
  assert.deepStrictEqual(r.payload.problems.map((p) => p.code), ['unverifiable-style-call']);
  // A shorthand refusal quotes it as well.
  const bad = await run(createArgs(spacedFile(GRIFFEL_BAD)), untouchable().factory);
  assert.match(bad.payload.error, /\(`node scripts\/check-griffel-styles\.js --file '[^']*Dev User[^']*page\.tsx'` lists every one\), then re-run the upload\.$/);
  // Both in one page: the keys come first, and the call is named as one the check could not read.
  const both = await run(createArgs(codeFile(`${GRIFFEL_IMPORT}const a = makeStyles({ root: { all: 'unset' } });\nexport function skip(s: string) { if (s) { } /x/.test(s); }\nconst b = makeStyles({ root: { padding: 1 } });\n`)), untouchable().factory);
  assert.match(both.payload.error, /writes CSS that Griffel drops at runtime, so the page would deploy without it — refusing to upload\. [^ ]+:2:\d+: `all` is not supported[\s\S]*It also has makeStyles calls the check could not read, so it cannot tell whether they hold more: [^ ]+:4:\d+: the makeStyles call here cannot be checked for certain[\s\S]*Fix them in the file/);
});

// The command a refusal suggests is one the user — or the agent — pastes, and the path comes from wherever the page file is: an untrusted checkout can name a file so that pasting a
// command written with it bare runs part of the name. Shell syntax stays inside single quotes; a name with a quote, which no shell can be given unchanged, is not written into the
// command at all — a placeholder is, and the path is named in a sentence before the way on.
test('a refusal\'s command never runs shell syntax from the page file\'s name: quoted, or a placeholder with the path named as data', async () => {
  const named = (name) => {
    const file = path.join(tmp(), name);
    fs.writeFileSync(file, GRIFFEL_BAD);
    return file;
  };
  const hostile = named('x;echo INJECTED;$(whoami)`id`.tsx');
  const r = await run(createArgs(hostile), untouchable().factory);
  assert.strictEqual(r.payload.code, 'griffel-shorthand');
  assert.ok(r.payload.error.endsWith(`Fix them in the file (\`node scripts/check-griffel-styles.js --file '${hostile}'\` lists every one), then re-run the upload.`), r.payload.error);
  const quoted = named("it's;echo INJECTED.tsx");
  const q = await run(createArgs(quoted), untouchable().factory);
  assert.strictEqual(q.payload.code, 'griffel-shorthand');
  assert.ok(q.payload.error.endsWith(`<file> is ${JSON.stringify(quoted)}; it is not written into the command because no way of writing it reaches the command unchanged in both PowerShell and a POSIX shell. `
    + 'Fix them in the file (`node scripts/check-griffel-styles.js --file <file>` lists every one), then re-run the upload.'), q.payload.error);
});

test('an UPDATE of an unreadable page that IS the deployed page only warns; one that changed is refused, because what it hides cannot be compared', async () => {
  const same = await griffelUpdate(GRIFFEL_UNREADABLE, GRIFFEL_UNREADABLE);
  assert.strictEqual(same.r.ok, true, JSON.stringify(same.r.payload));
  assert.strictEqual(same.genpage.of('update').length, 1);
  assert.ok(same.r.payload.warnings[0].startsWith(`${same.file} updates a page that is already deployed, and the deployed page already had these, set the same, so the upload goes on. It has makeStyles calls the Griffel check could not read, so it cannot tell whether the page writes CSS that Griffel drops at runtime: `), same.r.payload.warnings[0]);
  assert.doesNotMatch(same.r.payload.warnings[0], /Deleting a key/, 'there is no key to delete');
  // Re-saved with the other line endings and a BOM — not a difference to the service or to the base marker — it is still the deployed page.
  const resaved = await griffelUpdate(`\uFEFF${GRIFFEL_UNREADABLE.replace(/\n/g, '\r\n')}`, GRIFFEL_UNREADABLE);
  assert.strictEqual(resaved.r.ok, true, JSON.stringify(resaved.r.payload));
  // Edited: the unreadable call cannot be shown to hide nothing new.
  const edited = await griffelUpdate(`${GRIFFEL_UNREADABLE}// edited\n`, GRIFFEL_UNREADABLE);
  assert.strictEqual(edited.r.ok, false);
  assert.strictEqual(edited.r.payload.code, 'griffel-shorthand');
  assert.ok(edited.r.payload.error.startsWith(`${edited.file} has makeStyles calls the Griffel check could not read`), edited.r.payload.error);
  assert.strictEqual(edited.genpage.of('update').length, 0);
});

// A style object written elsewhere — `const styles = { root: { borderWidth: '1px' } }; makeStyles(styles)` — holds keys the check cannot see, and this one holds a key
// Griffel drops. The page is refused as one the check could not read, as an unreadable call is: a create before anything is sent, and an update that changes the page;
// an update that IS the deployed page only warns, because sending the same bytes again ships nothing new.
const GRIFFEL_INDIRECT = `${GRIFFEL_IMPORT}const styles = { root: { borderWidth: '1px' } };\nconst useStyles = makeStyles(styles);\nexport default function P() { return null; }\n`;
test('a page whose style object is written elsewhere is refused before anything is sent, as one the check could not read', async () => {
  const none = untouchable();
  const r = await run(createArgs(codeFile(GRIFFEL_INDIRECT)), none.factory);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.payload.code, 'griffel-shorthand');
  assert.deepStrictEqual(r.payload.problems.map((p) => p.code), ['unread-style-object']);
  assert.match(r.payload.error, /has makeStyles calls the Griffel check could not read, so it cannot tell whether the page writes CSS that Griffel drops at runtime — refusing to upload\. [^ ]+:3:\d+: this makeStyles call is given a style object written elsewhere/);
  assert.strictEqual(none.made.n, 0, 'nothing is listed, read or written');
  const same = await griffelUpdate(GRIFFEL_INDIRECT, GRIFFEL_INDIRECT);
  assert.strictEqual(same.r.ok, true, JSON.stringify(same.r.payload));
  assert.match(same.r.payload.warnings[0], /It has makeStyles calls the Griffel check could not read/);
  const edited = await griffelUpdate(`${GRIFFEL_INDIRECT}// edited\n`, GRIFFEL_INDIRECT);
  assert.strictEqual(edited.r.ok, false);
  assert.deepStrictEqual(edited.r.payload.problems.map((p) => p.code), ['unread-style-object']);
  assert.strictEqual(edited.genpage.of('update').length, 0, 'the edited page is not written');
});
// ── What is written is what was checked ─────────────────────────────────────────────────────────────────────────────────────────────
// The script reads the page file ONCE and decides everything on those bytes: the Griffel check, an update's comparison with the deployed page, the base marker's hash and what is
// written to the page. A save to the file in between — an update reads the deployed page first, and that takes seconds — would otherwise ship bytes nothing here checked. And
// JavaScript passed with --compiled-code-file would be deployed instead of the checked TypeScript, so that flag is refused.

test('--compiled-code-file is refused before anything runs: the JavaScript in it would be deployed without the Griffel check', async () => {
  const file = codeFile(TEXT);
  const compiled = path.join(path.dirname(file), 'page.js');
  fs.writeFileSync(compiled, 'const s = (0, rc.makeStyles)({ root: { borderWidth: "1px" } });\n');
  const none = untouchable();
  for (const extra of [[], ['--page-id', PAGE]]) {
    const r = await run(createArgs(file, [...NAMED, '--compiled-code-file', compiled, ...extra]), none.factory);
    assert.strictEqual(r.ok, false, JSON.stringify(extra));
    assert.match(r.payload.error, /^--compiled-code-file is not accepted: the Griffel check reads the TypeScript in --code-file/);
  }
  assert.strictEqual(none.made.n, 0, 'nothing is listed, read or written');
});

test('a create writes the bytes that were checked: a save to the file after the check does not ship, and the marker records what was sent', async () => {
  const file = codeFile(TEXT);
  // The file is saved again, with a key Griffel drops, after the check: as the backend is made (before anything is sent) and again while the page is written.
  const genpage = environment({ onCreate: () => { fs.writeFileSync(file, GRIFFEL_BAD); } });
  const r = await run(createArgs(file), () => { fs.writeFileSync(file, GRIFFEL_BAD); return genpage; });
  assert.strictEqual(r.ok, true, JSON.stringify(r.payload));
  const [args] = only(genpage, 'create');
  assert.strictEqual(args.source, TEXT, 'the checked bytes, not the later save');
  assert.strictEqual(genpage.pages.get(NEW_ID).source, TEXT);
  // The marker is the caller's file's, and records the hash of what was sent — so a later check sees the save as the local change it is.
  const marker = readMarker(file);
  assert.deepStrictEqual([marker.localSha256, marker.source], [pageHash(TEXT), 'upload']);
});

test('an update writes the checked bytes even when the file is saved while the page and the app\'s navigation are read', async () => {
  const file = codeFile(TEXT);
  seedBase(file);
  // The save lands during the listing: after the Griffel check, before the base check and the write.
  const genpage = environment({ appPages: () => { fs.writeFileSync(file, GRIFFEL_BAD); return { ok: true, pages: [{ pageId: PAGE, name: 'Current Page' }] }; } });
  const r = await run(updateArgs(file), genpage);
  assert.strictEqual(r.ok, true, JSON.stringify(r.payload));
  assert.strictEqual(only(genpage, 'update')[1].source, TEXT, 'the bytes the Griffel check and the comparison with the deployed page were made on');
  assert.strictEqual(readMarker(file).localSha256, pageHash(TEXT));
});

// The maker stores a page's text exactly: no BOM, and no line break the author did not write. The CLI an earlier release deployed through added a final CRLF and kept a BOM, which is
// why the base marker's hash ignores both. The script sends the file's bytes as they are, less one leading BOM — and a file that is not UTF-8 is refused, since a decode that
// replaced a byte would write a page nobody checked.
test('the page is written as the file is — one leading BOM goes, line endings are kept, nothing is added — and a file that is not UTF-8 is refused before a backend is made', async () => {
  const crlf = 'export const a = 1;\r\nexport const b = 2;\r\n';
  const genpage = environment();
  const file = path.join(tmp(), 'page.tsx');
  fs.writeFileSync(file, Buffer.from(`\uFEFF${crlf}`, 'utf8'));
  const r = await run(createArgs(file), genpage);
  assert.strictEqual(r.ok, true, JSON.stringify(r.payload));
  assert.strictEqual(only(genpage, 'create')[0].source, crlf);
  assert.strictEqual(genpage.pages.get(NEW_ID).source, crlf);

  const noFinalNewline = environment();
  const bare = path.join(tmp(), 'page.tsx');
  fs.writeFileSync(bare, 'export const a = 1;');
  await run(createArgs(bare), noFinalNewline);
  assert.strictEqual(only(noFinalNewline, 'create')[0].source, 'export const a = 1;', 'no line break appended');

  const broken = path.join(tmp(), 'page.tsx');
  fs.writeFileSync(broken, Buffer.from([0x65, 0xff, 0xfe, 0x0a]));
  const none = untouchable();
  const refused = await run(createArgs(broken), none.factory);
  assert.strictEqual(refused.ok, false);
  assert.match(refused.payload.error, /^--code-file is not usable: the page source is not valid UTF-8/);
  assert.strictEqual(none.made.n, 0);
});

// ── Through the REAL SDK ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
// The tests above stand in for the backend. These run the script against the real vendored SDK bundle over a stateful fake of the tables behind a page
// (helpers/fake-genpage-server.js), so what reaches the page is what is STORED — and no process stands between the two. The server holds no apps (genpage-sdk-app.test.js holds
// the app reads and edits against the SDK), so the backend's app reads are the one thing stood in for.
const SOURCE = "import * as React from 'react';\nexport default function Page() { return <div>Hello</div>; }\n";
function realBackend(server, { navigation = {}, made = [], deps = {} } = {}) {
  // `fromScript` is what the upload script hands its backend (its `warn` seam); `deps` is the test's own (a recorded sleep, no jitter).
  return (env, fromScript = {}) => {
    const genpage = makeGenpageSdk(env, { httpClient: server.http(), mkdtempSync: (prefix) => { const dir = fs.mkdtempSync(prefix); made.push(dir); return dir; }, ...deps, ...fromScript });
    genpage.enumeratePages = async (appId) => { const pages = navigation[appId] || []; return { ok: true, pages, empty: pages.length === 0 }; };
    genpage.placeInApp = async () => ({ added: [], alreadyPlaced: [], pinnedViews: [], warnings: [], appEdited: false });
    return genpage;
  };
}
function serverWithAccount() {
  const server = new FakeGenPageServer();
  server.serveTable(ACCOUNT_TABLE);
  return server;
}
// What the server holds of a page, read by a backend of its own.
async function storedPage(server, id) {
  const reader = makeGenpageSdk(INSTANCE, { httpClient: server.http() });
  try { return await reader.read(id); } finally { reader.dispose(); }
}

test('REAL SDK: hostile text — a prompt, an agent message, a quoted name — is stored exactly as written; no process is started, and the workspace is gone before the report', async (t) => {
  const server = serverWithAccount();
  // The backend's workspace is made in the plugin's own folder of the temp folder. On Windows a folder that this run makes there is given its access list by the programs of the system itself,
  // icacls and whoami (lib/windows-folder-acl.js), and one that another run has made is judged by them — and, for its owner, by PowerShell: the plugin's own, which never see text of the
  // page. This test is about what the text starts, so it runs in a temp folder of its own, where the folder is made by this run (icacls and whoami are let through and not counted).
  const privateTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'genpage-upload-temp-'));
  const savedTemp = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR };
  for (const name of Object.keys(savedTemp)) process.env[name] = privateTemp;
  t.after(() => {
    for (const [name, value] of Object.entries(savedTemp)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    fs.rmSync(privateTemp, { recursive: true, force: true });
  });
  const childProcess = require('node:child_process');
  const started = [];
  const aclTool = /[\\/](?:icacls|whoami)\.exe$/i;
  for (const fn of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
    const real = childProcess[fn];
    t.mock.method(childProcess, fn, (...args) => {
      if (process.platform === 'win32' && aclTool.test(String(args[0]))) return real.apply(childProcess, args);
      started.push(`${fn} ${String(args[0])}`);
      throw new Error(`${fn} must not be called`);
    });
  }
  const d = tmp();
  const pf = path.join(d, 'prompt.txt');
  const af = path.join(d, 'agent.txt');
  fs.writeFileSync(pf, HOSTILE_PROMPT, 'utf8');
  fs.writeFileSync(af, 'Initial deploy of the inspection page', 'utf8');
  const file = codeFile(SOURCE);
  const made = [];
  const r = await run(['--env', INSTANCE, '--code-file', file, '--prompt-file', pf, '--agent-message-file', af, '--name', 'Facilities "Live" Overview',
    '--data-sources', 'account', '--model', 'gpt-4.1'], realBackend(server, { made }));
  assert.strictEqual(r.ok, true, JSON.stringify(r.payload));
  assert.deepStrictEqual(started, [], 'the text travels as a value, so no command line was composed');
  const id = r.payload.pageId;
  assert.deepStrictEqual(server.messagesOf(id).map((m) => m.message), [HOSTILE_PROMPT, 'Initial deploy of the inspection page']);
  const page = await storedPage(server, id);
  assert.deepStrictEqual([page.name, page.source, page.dataSources, page.model], ['Facilities "Live" Overview', SOURCE, ['account'], 'gpt-4.1']);
  assert.deepStrictEqual(server.published, [id]);
  assert.ok(made.length > 0 && made.every((dir) => !fs.existsSync(dir)), 'the backend\'s workspace was removed before the result was reported');
  const marker = readMarker(file);
  assert.deepStrictEqual([marker.pageId, marker.source, 'appId' in marker], [id, 'upload', false]);
});

test('REAL SDK: an update that names no name, model or data sources keeps the page\'s own; --clear-data-sources empties the list and keeps the rest', async () => {
  const server = serverWithAccount();
  const seed = makeGenpageSdk(INSTANCE, { httpClient: server.http() });
  let pageId;
  try {
    ({ pageId } = await seed.create({ name: 'Quarterly review', source: SOURCE, dataSources: 'account', model: 'gpt-4.1', prompt: 'first', agentMessage: 'ok' }));
  } finally { seed.dispose(); }
  const navigation = { [APP]: [{ pageId, name: 'Quarterly review' }] };
  const file = codeFile(`${SOURCE}// edited\n`);
  seedBase(file, { pageId, deployed: SOURCE, local: SOURCE });

  const first = await run(['--env', INSTANCE, '--app-id', APP, '--code-file', file, '--page-id', pageId, '--prompt', 'tweak', '--agent-message', 'tweaked'], realBackend(server, { navigation }));
  assert.strictEqual(first.ok, true, JSON.stringify(first.payload));
  let page = await storedPage(server, pageId);
  assert.deepStrictEqual([page.name, page.model, page.dataSources, page.source], ['Quarterly review', 'gpt-4.1', ['account'], `${SOURCE}// edited\n`]);
  assert.deepStrictEqual(server.messagesOf(pageId).map((m) => m.message), ['first', 'ok', 'tweak', 'tweaked']);

  fs.writeFileSync(file, `${SOURCE}// edited again\n`);
  const cleared = await run(['--env', INSTANCE, '--app-id', APP, '--code-file', file, '--page-id', pageId, '--prompt', 'unbind', '--clear-data-sources'], realBackend(server, { navigation }));
  assert.strictEqual(cleared.ok, true, JSON.stringify(cleared.payload));
  page = await storedPage(server, pageId);
  assert.deepStrictEqual([page.name, page.model, page.dataSources, page.source], ['Quarterly review', 'gpt-4.1', [], `${SOURCE}// edited again\n`]);
});

test('REAL SDK: the new-app flow — a first page created with no app, then its first update with --app-id once the app\'s navigation names the page', async () => {
  const server = serverWithAccount();
  const navigation = {};
  const file = codeFile(SOURCE);
  const created = await run(['--env', INSTANCE, '--code-file', file, '--name', 'First page', ...P, '--agent-message', 'm'], realBackend(server, { navigation }));
  assert.strictEqual(created.ok, true, JSON.stringify(created.payload));
  const id = created.payload.pageId;
  assert.strictEqual('appId' in readMarker(file), false, 'the page is recorded with no app');

  // The app is created WITH the page; from then on its navigation names it, and the next upload names the app.
  navigation[APP] = [{ pageId: id, name: 'First page' }];
  fs.writeFileSync(file, `${SOURCE}// second\n`);
  const update = await run(['--env', INSTANCE, '--app-id', APP, '--code-file', file, '--page-id', id, ...P], realBackend(server, { navigation }));
  assert.strictEqual(update.ok, true, JSON.stringify(update.payload));
  assert.deepStrictEqual([update.payload.updated, update.payload.appId], [true, APP]);
  assert.strictEqual(readMarker(file).appId, APP, 'the app is recorded once the update has proven the page is in it');
  assert.strictEqual((await storedPage(server, id)).source, `${SOURCE}// second\n`);
});

// The failure these guard against: a publish that failed after a create said to run the upload again as an update, and neither kind of create could. These run the advice as a caller would — the
// command that failed, with what it says added — against the real SDK, and look at what the server then holds.
test('REAL SDK: the advice after a create whose publish failed — run as given, with no app — publishes that very page; nothing is created or rewritten', async () => {
  const server = serverWithAccount();
  server.failOn = (method, requestPath) => (/PublishXml/.test(requestPath) ? 500 : undefined);
  const file = codeFile(SOURCE);
  const args = ['--env', INSTANCE, '--code-file', file, '--name', 'First page', ...P, '--agent-message', 'm'];
  const first = await run(args, realBackend(server));
  assert.strictEqual(first.ok, false, JSON.stringify(first.payload));
  const id = first.payload.pageId;
  assert.deepStrictEqual(server.published, [], 'the publish failed');
  assert.strictEqual(readMarker(file).unfinished, 'publish');

  server.failOn = undefined;
  server.requests.length = 0;
  const [flag, value] = /run the same command again with (--page-id) (\S+) added/.exec(first.payload.error).slice(1);
  const second = await run([...args, flag, value], realBackend(server));
  assert.strictEqual(second.ok, true, JSON.stringify(second.payload));
  assert.deepStrictEqual([second.payload.pageId, second.payload.unchanged], [id, true]);
  assert.deepStrictEqual(server.published, [id], 'the page is published now');
  assert.deepStrictEqual([...server.state.projects.keys()], [id], 'one page, the one the first run made');
  assert.deepStrictEqual(server.writes().filter((w) => !/PublishXml/.test(w)), [], 'and nothing was written to it: it already held the content');
  assert.strictEqual(readMarker(file).unfinished, undefined);
});

test('REAL SDK: the advice after an app-bound create whose publish failed — run as given — publishes the page and hands it to the placement', async () => {
  const server = serverWithAccount();
  server.failOn = (method, requestPath) => (/PublishXml/.test(requestPath) ? 500 : undefined);
  const navigation = {};
  const placed = [];
  const backend = (env) => {
    const genpage = realBackend(server, { navigation })(env);
    genpage.placeInApp = async (appId, options) => {
      placed.push({ appId, pages: options.pages.map((p) => p.pageId) });
      for (const p of options.pages) (navigation[appId] = navigation[appId] || []).push({ pageId: p.pageId, name: p.title });
      return { added: options.pages.map((p) => p.pageId), alreadyPlaced: [], pinnedViews: [], warnings: [], appEdited: true };
    };
    return genpage;
  };
  const file = codeFile(SOURCE);
  const args = ['--env', INSTANCE, '--app-id', APP, '--code-file', file, '--name', 'First page', ...P, '--agent-message', 'm', '--add-to-sitemap'];
  const first = await run(args, backend);
  assert.strictEqual(first.ok, false, JSON.stringify(first.payload));
  const id = first.payload.pageId;
  assert.deepStrictEqual(placed, [], 'a page that was not published is not placed');
  // The ordinary update the advice used to name is refused: the page is in no navigation, and it is the placement that is unfinished.
  const ordinary = await run(['--env', INSTANCE, '--app-id', APP, '--code-file', file, '--page-id', id, ...P], backend);
  assert.strictEqual(ordinary.ok, false);
  assert.match(ordinary.payload.error, /was created to be placed in app .*, and it is not finished until it is placed/);
  assert.strictEqual(readMarker(file).unfinished, 'place');

  server.failOn = undefined;
  const advised = /run the same command again with --page-id (\S+) added/.exec(first.payload.error)[1];
  const second = await run([...args, '--page-id', advised], backend);
  assert.strictEqual(second.ok, true, JSON.stringify(second.payload));
  assert.deepStrictEqual(placed, [{ appId: APP, pages: [id] }], 'and placed, by the same run');
  assert.deepStrictEqual(server.published, [id]);
  assert.strictEqual(second.payload.addedToSitemap, true);
  assert.strictEqual(readMarker(file).unfinished, undefined);
  assert.strictEqual(readMarker(file).appId, APP);
});

// The placement that was SAVED and not published, against the real bundle's app reads and writes (the page server, with the app's two layers laid over the same transport):
// the first run's publish of the app fails after the navigation was pushed; the advice's run must publish the app again, and must not clear the marker until the page is in
// the navigation that runs. Writing the app a second time would be wrong as well — everything it holds is saved.
test('REAL SDK: the advice after a placement that was saved and not published publishes the app again — the page is in the app that runs before the marker is cleared, and the app is not written twice', async () => {
  const server = serverWithAccount();
  // The page the app's navigation already names, which the app push checks exists.
  server.seedPage(APP_EXISTING_PAGE_ID, { name: 'Existing', source: SOURCE });
  const { http, state } = appTransport(server, { publishFailures: 1 });
  const file = codeFile(SOURCE);
  const args = ['--env', INSTANCE, '--app-id', REAL_APP, '--code-file', file, '--name', 'Review page', ...P, '--agent-message', 'm', '--add-to-sitemap'];
  const make = (env) => makeGenpageSdk(env, { httpClient: http });
  const first = await run(args, make);
  assert.strictEqual(first.ok, false, JSON.stringify(first.payload));
  assert.match(first.payload.error, /publishing the app failed/);
  const id = first.payload.pageId;
  assert.ok(state.xml.includes(id), 'the saved navigation holds the page');
  assert.ok(!state.publishedXml.includes(id), 'the published navigation does not');
  assert.strictEqual(readMarker(file).unfinished, 'place');
  const writes = state.writes.length;

  const second = await run([...args, ...adviceFor(first)], make);
  assert.strictEqual(second.ok, true, JSON.stringify(second.payload));
  assert.strictEqual(state.publishAttempts, 2, 'the app was published again');
  assert.ok(state.publishedXml.includes(id), 'the page is in what runs');
  assert.strictEqual(state.writes.length, writes, 'and nothing was written to the app: its navigation was saved already');
  assert.strictEqual(readMarker(file).unfinished, undefined, 'the marker is cleared once that is proven');
  assert.strictEqual(second.payload.addedToSitemap, undefined, 'a page that was in the navigation already is not reported as added by this run');
});

// A create whose answer was lost and whose page cannot be read: the failure the CLI used to flatten into its message, losing the one thing that lets the page be found.
test('REAL SDK: a create whose answer is lost and whose page cannot be read reports the id to look for, outcome "unknown", and the SDK\'s code — beside the complete page on the server', async () => {
  const server = serverWithAccount();
  server.afterCommit = () => { throw new Error('Request failed: read ECONNRESET'); };
  // …and the reads of the page fail too.
  server.failOn = (method, requestPath, batched) => (method === 'GET' && !batched && /uxagentprojects\(/.test(requestPath) ? 503 : undefined);
  const file = codeFile(SOURCE);
  const r = await run(['--env', INSTANCE, '--code-file', file, '--name', 'Lost answer', ...P, '--agent-message', 'm'], realBackend(server));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.payload.outcome, 'unknown');
  assert.match(r.payload.pageId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.strictEqual(typeof r.payload.code, 'string');
  assert.deepStrictEqual([...server.state.projects.keys()], [r.payload.pageId], 'that is the page the server holds');
  assert.strictEqual(fs.existsSync(markerPath(file)), false, 'and no base is recorded for a page nobody has seen');
});

// A throttled page write is waited out for up to five minutes (lib/throttle-budget.js), and the upload — which is not a build, and has no run budget of its own to be handed — is given a `warn` seam that writes on stderr:
// a wait of more than a few seconds is a line there, and what the service asked is said in the words of the command and not the build's. Stdout carries the JSON result alone.
test('REAL SDK: a throttled write the service asks to wait nine seconds for is announced on stderr as a WARNING line — once, and not in the result — and the page is written once', async (t) => {
  const server = serverWithAccount();
  server.failBatch = (n) => (n === 1 ? { status: 429, headers: { 'retry-after': '9' } } : undefined);
  const slept = [];
  const written = [];
  t.mock.method(process.stderr, 'write', (chunk) => { written.push(String(chunk)); return true; });
  const r = await run(['--env', INSTANCE, '--code-file', codeFile(SOURCE), '--name', 'Throttled page', ...P, '--agent-message', 'm'],
    realBackend(server, { deps: { sleep: async (ms) => { slept.push(ms); }, random: () => 0 } }));
  assert.strictEqual(r.ok, true, JSON.stringify(r.payload));
  assert.deepStrictEqual(slept, [9000], 'the answer\'s Retry-After was waited, whole');
  assert.deepStrictEqual(written.filter((line) => /throttled the write/.test(line)), [
    'WARNING: generative page "Throttled page": the service throttled the write (HTTP 429); waiting 9 s before sending it again (9 s of the 5 minutes a run allows itself for waiting out a throttled service are spent)\n',
  ]);
  assert.deepStrictEqual([...server.state.projects.keys()], [r.payload.pageId], 'one page');
  assert.ok((r.payload.warnings || []).some((w) => /throttled the write of generative page "Throttled page" \(HTTP 429\) once/.test(w)), 'the result says it was throttled, as before');
  assert.ok(!JSON.stringify(r.payload).includes('WARNING:'), 'the progress line is not in the result');
});

test('REAL SDK: a throttle that asks for longer than the budget stops the upload at once, and says so in the words of a command — nothing is written, and nothing is waited for', async () => {
  const server = serverWithAccount();
  server.failBatch = () => ({ status: 429, headers: { 'retry-after': '600' } });
  const slept = [];
  const file = codeFile(SOURCE);
  const r = await run(['--env', INSTANCE, '--code-file', file, '--name', 'Throttled page', ...P, '--agent-message', 'm'],
    realBackend(server, { deps: { sleep: async (ms) => { slept.push(ms); }, random: () => 0 } }));
  assert.strictEqual(r.ok, false);
  assert.match(r.payload.error, /the service asked to wait 600 s before the next send, which does not fit in what is left of the 5 minutes a run allows itself for waiting out a throttled service \(0 s are spent\)\. Nothing more is sent now: run the same command again later, and it continues from here\./);
  assert.doesNotMatch(r.payload.error, /\bbuild\b/);
  assert.deepStrictEqual(slept, []);
  assert.strictEqual(server.state.projects.size, 0, 'a refused change set wrote nothing');
  assert.strictEqual(fs.existsSync(markerPath(file)), false, 'and no base is recorded for a page that was not written');
});

// The page server as the transport under the production HTTP client — the one that decides whether a wait fits — with the requests `refuse` answers refused instead.
function serverTransport(server, refuse = () => undefined) {
  const raw = server.http();
  return async ({ url, method, headers, body }) => {
    const refused = refuse(method, new URL(url).pathname);
    if (refused) return refused;
    const answer = method === 'POST' && url.endsWith('/$batch') ? await raw.postRaw(url, body, { headers })
      : method === 'GET' ? await raw.get(url, { headers })
        : method === 'DELETE' ? await raw.delete(url, { headers })
          : method === 'PATCH' && Buffer.isBuffer(body) ? await raw.patchRaw(url, body, { headers })
            : await raw[method.toLowerCase()](url, typeof body === 'string' ? JSON.parse(body) : body, { headers });
    const text = typeof answer.body === 'string' || Buffer.isBuffer(answer.body) ? answer.body : JSON.stringify(answer.body === undefined ? null : answer.body);
    return { statusCode: answer.status, headers: answer.headers || {}, body: text };
  };
}

// A publish the budget has no room to wait for comes AFTER the create has committed, so a run of the same command again would create a second page. The HTTP client's line on stderr is the fact alone — what the service asked, and that the
// request was not sent again — and the way to finish is the result's: the same command with the page that was saved named. These run it as a caller would, against the service once it answers.
test('REAL SDK: a publish the budget has no room to wait for is said on stderr with no advice — the result names the page that was saved, and its advice, run as given, finishes that page and makes no second', async (t) => {
  const { createAzHttpClient } = require('../lib/sdk-http-client.js');
  const server = serverWithAccount();
  let throttled = true;
  const slept = [];
  const written = [];
  t.mock.method(process.stderr, 'write', (chunk) => { written.push(String(chunk)); return true; });
  const refusePublish = (method, requestPath) => {
    if (!(throttled && method === 'POST' && /\/PublishXml$/.test(requestPath))) return undefined;
    throttled = false;
    return { statusCode: 429, headers: { 'retry-after': '600' }, body: '{"error":{"message":"throttled"}}' };
  };
  const backend = (env, fromScript = {}) => {
    const httpClient = createAzHttpClient(env, {
      getToken: () => 'TOK', random: () => 0, throttle: fromScript.throttle, sleep: async (ms) => { slept.push(ms); }, request: serverTransport(server, refusePublish),
    });
    return realBackend(server, { deps: { httpClient, random: () => 0 } })(env, fromScript);
  };
  const file = codeFile(SOURCE);
  const args = ['--env', INSTANCE, '--code-file', file, '--name', 'Throttled publish', ...P, '--agent-message', 'm'];
  const first = await run(args, backend);
  assert.strictEqual(first.ok, false, JSON.stringify(first.payload));
  const id = first.payload.pageId;
  assert.deepStrictEqual(slept, [], 'nothing was waited for: ten minutes do not fit in five');
  assert.deepStrictEqual(written.filter((line) => /^WARNING: /.test(line)), [
    'WARNING: the service asked to wait 600 s before this request is sent again, which does not fit in what is left of the 5 minutes a run allows itself for waiting out a throttled service (0 s are spent), so it was not sent again.\n',
  ]);
  assert.doesNotMatch(written.join(''), /same command|again later|Nothing more is sent now/, 'stderr says nothing of what to run: the create has committed');
  assert.deepStrictEqual([...server.state.projects.keys()], [id], 'the page was created');
  assert.deepStrictEqual(server.published, [], 'and not published');
  assert.strictEqual(readMarker(file).unfinished, 'publish');
  const advised = /run the same command again with --page-id (\S+) added and nothing else changed/.exec(first.payload.error);
  assert.ok(advised, first.payload.error);
  assert.strictEqual(advised[1], id, 'the advice names the page that was saved');

  const second = await run([...args, '--page-id', advised[1]], backend);
  assert.strictEqual(second.ok, true, JSON.stringify(second.payload));
  assert.deepStrictEqual([second.payload.pageId, second.payload.unchanged], [id, true]);
  assert.deepStrictEqual([...server.state.projects.keys()], [id], 'one page, the one the first run made');
  assert.deepStrictEqual(server.published, [id], 'and it is published now');
  assert.strictEqual(readMarker(file).unfinished, undefined);
});

// The upload is a run of one write, and the budget that bounds its waiting is one object: the write's resends and the backend's own HTTP client — whose reads and publish wait out a throttle too — draw from the same five minutes, so the
// script hands its backend the budget, with the seam that writes its long waits on stderr as WARNING lines.
test('REAL SDK: the upload hands its backend ONE budget, whose long waits are WARNING lines on stderr — the write and the backend\'s own HTTP client draw from it', async (t) => {
  const server = serverWithAccount();
  const handed = [];
  const written = [];
  t.mock.method(process.stderr, 'write', (chunk) => { written.push(String(chunk)); return true; });
  const backend = realBackend(server);
  const r = await run(['--env', INSTANCE, '--code-file', codeFile(SOURCE), '--name', 'Budgeted page', ...P, '--agent-message', 'm'], (env, fromScript = {}) => { handed.push(fromScript); return backend(env, fromScript); });
  assert.strictEqual(r.ok, true, JSON.stringify(r.payload));
  assert.strictEqual(handed.length, 1, 'one backend');
  const { throttle } = handed[0];
  assert.ok(throttle && ['fits', 'spend', 'announce', 'decline', 'declined', 'note'].every((name) => typeof throttle[name] === 'function'), 'with a budget');
  throttle.announce('a long wait', 60000);
  assert.deepStrictEqual(written.filter((line) => /a long wait/.test(line)), ['WARNING: a long wait\n'], 'whose announcements are the WARNING lines the script writes');
});

// The page is normalized once: a file that starts with TWO byte order marks loses the encoding marker only, in the check, the hash and the page.
test('REAL SDK: a file that starts with two byte order marks is checked, hashed and stored as the same text — one mark is the encoding, the other is content', async () => {
  const server = serverWithAccount();
  const file = path.join(tmp(), 'page.tsx');
  fs.writeFileSync(file, Buffer.from(`\uFEFF\uFEFF${SOURCE}`, 'utf8'));
  const first = await run(['--env', INSTANCE, '--code-file', file, '--name', 'Marks', ...P, '--agent-message', 'm'], realBackend(server));
  assert.strictEqual(first.ok, true, JSON.stringify(first.payload));
  const id = first.payload.pageId;
  assert.strictEqual((await storedPage(server, id)).source, `\uFEFF${SOURCE}`, 'stored with the second mark: only the encoding marker was dropped, once');
  assert.strictEqual(readMarker(file).source, 'upload', 'and read back equal to what was hashed, so the base is verified, not "unverified"');
  // An update of the same file changes nothing: what was sent and what is stored are the same text.
  const navigation = { [APP]: [{ pageId: id, name: 'Marks' }] };
  const again = await run(['--env', INSTANCE, '--app-id', APP, '--code-file', file, '--page-id', id, ...P], realBackend(server, { navigation }));
  assert.strictEqual(again.ok, true, JSON.stringify(again.payload));
  assert.strictEqual(again.payload.unchanged, true);
});

test('a file that starts with two byte order marks reaches the backend as the text with ONE removed — create and update', async () => {
  const text = `\uFEFFexport const n = 1;\n`;
  const file = path.join(tmp(), 'page.tsx');
  fs.writeFileSync(file, Buffer.from(`\uFEFF${text}`, 'utf8'));
  const genpage = environment();
  assert.strictEqual((await run(createArgs(file), genpage)).ok, true);
  assert.strictEqual(only(genpage, 'create')[0].source, text, 'a string: the one normalization already ran on the bytes');
  seedBase(file, { pageId: PAGE, deployed: text, local: text });
  const updating = environment({ pages: [{ pageId: PAGE, name: 'Current Page', source: text, dataSources: [] }] });
  const r = await run(updateArgs(file), updating);
  assert.strictEqual(r.ok, true, JSON.stringify(r.payload));
  assert.strictEqual(only(updating, 'update')[1].source, text);
  assert.strictEqual(pageHash(only(updating, 'update')[1].source), readMarker(file).localSha256, 'and the recorded hash is of that same text');
});
