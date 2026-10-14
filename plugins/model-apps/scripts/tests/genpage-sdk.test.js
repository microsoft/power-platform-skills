'use strict';
// Logic tests of lib/genpage-sdk.js — the plugin's one page backend — against an in-memory stand-in for the SDK
// (helpers/fake-genpage-sdk.js) that answers exactly as scripted, so every answer the SDK can give is exercised: the pure helpers, CREATE
// (the minted id, one push, the three ways an unknown outcome is settled) and UPDATE (only what differs, and the #722 guarantee that an update
// which MAY have landed is never sent again blindly). The reads and the app placement are in genpage-sdk-app.test.js, and the same module
// against the REAL vendored bundle in genpage-sdk-real-bundle.test.js.
const { test } = require('node:test');
const assert = require('node:assert');
const {
  makeGenpageSdk, sourceText, dataSourcesOf, unescapePacName, suppliedButBlank, promptTranscript, configJson, pageFolderFiles,
  genPagesOfSiteMap, writeOutcome, PRE_WRITE_REFUSALS, contentFingerprint,
} = require('../lib/genpage-sdk.js');
const { FakeSdk, sdkError, connectionError } = require('./helpers/fake-genpage-sdk.js');

const ENV = 'https://contoso.crm.dynamics.com';
const ID = '11111111-0000-4000-8000-0000000000aa';
const APP = '22222222-0000-4000-8000-0000000000bb';
// The minted id is handed back in upper case on purpose: a page id is lower-cased before it is used.
const backend = (sdk, deps = {}) => makeGenpageSdk(ENV, { sdk, newId: () => ID.toUpperCase(), ...deps });
const reset = () => connectionError(0, 'Transport failure: read ECONNRESET');
// What a page the maker made looks like to the SDK: its own prompt and one reply.
const deployed = (over = {}) => ({
  id: ID, name: 'Overview', source: 'export default function Old() { return null; }', dataSources: ['account'], model: 'gpt-4.1',
  connectorBindings: [{ connector: 'x' }], actionBindings: [{ action: 'y' }],
  firstPrompt: 'first prompt', conversation: [{ sender: 'user', message: 'first prompt' }, { sender: 'agent', message: 'first reply' }],
  ...over,
});
const seeded = (over) => new FakeSdk().seedPage(deployed(over));
// An update's edits as [call, pointer, value]. The turn's identity is minted per update, so it is checked on its own (the identity tests below), not in every comparison.
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const withoutTurnId = (value) => (value && value.newTurn ? { ...value, newTurn: (({ id, ...rest }) => rest)(value.newTurn) } : value);
const edits = (sdk) => sdk.calls.filter((c) => c.name === 'updateElement' || c.name === 'addElement').map((c) => [c.name, c.args[2], withoutTurnId(c.args[3])]);

// ── the pure helpers ─────────────────────────────────────────────────────────────────────────────────────────────

test('sourceText: bytes lose ONE leading BOM; text is already canonical and is returned exactly — a second normalization is the bug it exists to prevent', () => {
  assert.strictEqual(sourceText(Buffer.from('\uFEFFexport default 1;\r\n', 'utf8')), 'export default 1;\r\n');
  assert.strictEqual(sourceText(Buffer.from('\uFEFF\uFEFFa', 'utf8')), '\uFEFFa', 'only one BOM is an encoding marker; a second is content');
  assert.strictEqual(sourceText(Buffer.from('a\r\nb\n', 'utf8')), 'a\r\nb\n', 'no CRLF is appended and none is normalised (pac appended one)');
  // Text is what the caller already normalized: the Griffel gate, the PAGEREF resolution and the hash were all made on it, so it is what is sent.
  assert.strictEqual(sourceText('\uFEFFa'), '\uFEFFa', 'a string is never stripped again');
  assert.strictEqual(sourceText('\uFEFF\uFEFFa'), '\uFEFF\uFEFFa');
  assert.strictEqual(sourceText(sourceText(Buffer.from('\uFEFF\uFEFFa', 'utf8'))), '\uFEFFa', 'normalizing the bytes once and then handing the text on keeps the second BOM');
  assert.strictEqual(sourceText('é✓ ü'), 'é✓ ü');
  assert.strictEqual(sourceText(''), '');
});

test('sourceText: bytes that are not valid UTF-8 are REFUSED, never decoded with replacement characters', () => {
  assert.throws(() => sourceText(Buffer.from([0x61, 0xff, 0x62])),
    (e) => e.code === 'GENPAGE_SOURCE_NOT_UTF8' && e.transient === false && /not valid UTF-8/.test(e.message));
  assert.throws(() => sourceText(Buffer.from([0xc3])), (e) => e.code === 'GENPAGE_SOURCE_NOT_UTF8', 'a truncated sequence');
  assert.throws(() => sourceText('a\uD800b'), (e) => e.code === 'GENPAGE_SOURCE_NOT_UTF8', 'a lone surrogate cannot be encoded without replacing it');
  assert.throws(() => sourceText(42), (e) => e.code === 'GENPAGE_SOURCE_INVALID');
  assert.throws(() => sourceText(undefined), (e) => e.code === 'GENPAGE_SOURCE_INVALID');
});

test('dataSourcesOf: trimmed, lower-cased logical names; a blank CSV is "not given"; an explicit empty array is the instruction to clear', () => {
  assert.deepStrictEqual(dataSourcesOf('Account, contact ,'), ['account', 'contact']);
  assert.deepStrictEqual(dataSourcesOf([' Account ', 'CONTACT']), ['account', 'contact']);
  assert.strictEqual(dataSourcesOf(undefined), undefined);
  assert.strictEqual(dataSourcesOf(null), undefined);
  assert.strictEqual(dataSourcesOf('   '), undefined);
  assert.deepStrictEqual(dataSourcesOf([]), []);
});

test('unescapePacName reads the name pac was given back out of the `\\"` it stored; suppliedButBlank tells "not supplied" from "supplied blank"', () => {
  assert.strictEqual(unescapePacName('Say \\"hi\\" now'), 'Say "hi" now');
  assert.strictEqual(unescapePacName('plain'), 'plain');
  assert.strictEqual(unescapePacName('back\\slash'), 'back\\slash', 'only an escaped quote is undone');
  assert.strictEqual(suppliedButBlank(undefined), false);
  assert.strictEqual(suppliedButBlank(null), false);
  assert.strictEqual(suppliedButBlank(''), true);
  assert.strictEqual(suppliedButBlank(' \r\n\t'), true);
  assert.strictEqual(suppliedButBlank('x'), false);
});

test('writeOutcome: what a failed SDK send says it did — nothing, or unknown — and only PROVEN pre-write refusals say nothing', () => {
  assert.strictEqual(writeOutcome(connectionError(0, 'reset')), 'unknown', 'a transport failure may have committed');
  assert.strictEqual(writeOutcome(connectionError(503, 'unavailable')), 'unknown', 'a 5xx from an intermediary may have committed');
  assert.strictEqual(writeOutcome(connectionError(504, 'gateway')), 'unknown');
  assert.strictEqual(writeOutcome(connectionError(200, 'cannot be confirmed')), 'unknown', 'an answer the SDK could not account for');
  assert.strictEqual(writeOutcome(connectionError(400, 'bad request')), 'nothing', 'a 4xx rejected the request, and a change set is atomic');
  assert.strictEqual(writeOutcome(connectionError(409, 'conflict')), 'nothing');
  assert.strictEqual(writeOutcome(new Error('socket hang up')), 'unknown', 'a failure that is no SDK error says nothing');
  assert.strictEqual(writeOutcome(undefined), 'unknown');
  // Every typed refusal the SDK raises before it sends a write request. The list IS the contract — each code was checked against where the vendored SDK
  // raises it, which is before any request is sent — so a change to it is a decision, and this is where it is made.
  assert.deepStrictEqual([...PRE_WRITE_REFUSALS].sort(), [
    'ARTIFACT_LANGUAGE_MISMATCH', 'ARTIFACT_NOT_FOUND', 'ARTIFACT_PROJECTION_STALE',
    'GENPAGE_COMPILER_INVALID', 'GENPAGE_COMPILER_UNAVAILABLE', 'GENPAGE_COMPILER_VERSION', 'GENPAGE_CONTENT_NOT_TEXT', 'GENPAGE_CONTENT_WRITE_UNSUPPORTED',
    'GENPAGE_RETAINED_ROW_MISSING', 'GENPAGE_RETAIN_ON_CREATE', 'GENPAGE_RUNTIME_TYPES_INVALID', 'GENPAGE_TURN_CONFLICT', 'GENPAGE_TURN_NOT_ATOMIC', 'GENPAGE_WRITE_UNKNOWN',
    'VALIDATION_ERROR',
  ]);
  for (const code of PRE_WRITE_REFUSALS) assert.strictEqual(writeOutcome(sdkError(code, 'refused')), 'nothing', code);
  // A typed error that is not one of them is no proof: it may come from the SDK's step after the commit.
  for (const code of ['WORKSPACE_NOT_INITIALIZED', 'PATH_TRAVERSAL', 'INCOMPATIBLE_WORKSPACE', 'STALE_ARTIFACT', 'GENPAGE_PUBLISHED_READ_MOVED', 'SOMETHING_NEW']) {
    assert.strictEqual(writeOutcome(sdkError(code, 'not proof')), 'unknown', code);
  }
});

// A filesystem error has a string `code` too. The SDK raises one when it persists its workspace AFTER the server committed the change set,
// so a write that failed with ENOSPC may have landed whole — "has a string code" must never read as "wrote nothing".
test('writeOutcome: a filesystem error (a string code of its own) is UNKNOWN, and so is a plain error wearing an SDK refusal\'s code', () => {
  for (const code of ['ENOSPC', 'EACCES', 'EPERM', 'EBUSY', 'EMFILE', 'ENOENT', 'EIO']) {
    const error = Object.assign(new Error(`${code}: the workspace could not be written`), { code, errno: -1, syscall: 'write' });
    assert.strictEqual(writeOutcome(error), 'unknown', code);
  }
  assert.strictEqual(writeOutcome(Object.assign(new Error('looks typed'), { code: 'VALIDATION_ERROR' })), 'unknown', 'only an SdkError counts: the code alone is not the proof');
  assert.strictEqual(writeOutcome(Object.assign(new Error('looks like a 4xx'), { code: 'CONNECTION_ERROR', statusCode: 400 })), 'unknown');
});

test('genPagesOfSiteMap: the pages an app\'s navigation names, once each, in order, with the navigation TITLE', () => {
  const siteMap = { areas: [
    { id: 'a1', groups: [{ id: 'g1', subAreas: [{ type: 'Entity', entity: 'account', title: 'Accounts' }, { type: 'GenPage', genPageId: 'P1', title: 'One' }] }] },
    { id: 'a2', groups: [{ id: 'g2', subAreas: [{ type: 'GenPage', genPageId: 'p1', title: 'One again' }, { type: 'GenPage', genPageId: 'P2', title: 'Two' }, { type: 'GenPage', title: 'headless' }] }] },
  ] };
  assert.deepStrictEqual(genPagesOfSiteMap(siteMap), [{ pageId: 'P1', name: 'One' }, { pageId: 'P2', name: 'Two' }]);
  assert.deepStrictEqual(genPagesOfSiteMap(undefined), []);
  assert.deepStrictEqual(genPagesOfSiteMap({ areas: [{ groups: [{}] }, {}] }), []);
});

test('promptTranscript / configJson / pageFolderFiles: the files of a downloaded page folder, in the layout a rebuild reads back', () => {
  const user = (message) => ({ sender: 'user', message });
  assert.strictEqual(promptTranscript({ conversation: [user('Show an overview'), { sender: 'agent', message: 'Done' }] }), 'Show an overview', 'one prompt is bare');
  assert.strictEqual(promptTranscript({ conversation: [user('Show an overview'), { sender: 'agent', message: 'Done' }, user('Add a chart')] }),
    'Conversation with 2 prompts:\r\n1. Show an overview\r\n2. Add a chart');
  assert.strictEqual(promptTranscript({ conversation: [], firstPrompt: 'Only the first' }), 'Only the first');
  assert.strictEqual(promptTranscript({ conversation: [] }), undefined, 'a page with no prompt has no prompt.txt — absent, not empty');
  assert.strictEqual(promptTranscript(undefined), undefined);

  const page = { source: 'export default 1;', dataSources: ['account'], model: '', actionBindings: [{ a: 1 }], conversation: [user('p')], bag: { configKeys: ['dataSources', 'model', 'actionBindings'] } };
  assert.strictEqual(configJson(page), '{"dataSources":["account"],"model":"","actionBindings":[{"a":1}]}', 'the keys in the order the page had them');
  assert.strictEqual(configJson({ dataSources: undefined }), '{"dataSources":[]}', 'a page created by the SDK in this run: the SDK\'s own order, absent keys left out');
  assert.strictEqual(configJson({ dataSources: ['a'], bag: { configKeys: ['dataSources', 'extra'], config: { extra: 5 } } }), '{"dataSources":["a"],"extra":5}', 'a key the SDK does not model keeps its value');
  assert.deepStrictEqual(pageFolderFiles(page), {
    'page.tsx': 'export default 1;',
    'config.json': '{"dataSources":["account"],"model":"","actionBindings":[{"a":1}]}',
    'prompt.txt': 'p',
  });
  assert.deepStrictEqual(Object.keys(pageFolderFiles({ source: 's', conversation: [] })), ['page.tsx', 'config.json']);
});

// ── CREATE ───────────────────────────────────────────────────────────────────────────────────────────────────────

test('create: mints the id, writes ONE change set, publishes with verification, and answers the id, the name and the publish state', async () => {
  const sdk = new FakeSdk();
  const out = await backend(sdk).create({ name: 'Overview', source: 'export default 1;', dataSources: 'Account, contact', model: 'gpt-4.1', prompt: 'Build it', agentMessage: 'Done' });
  assert.strictEqual(out.pageId, ID, 'the minted id is lower-cased');
  assert.strictEqual(out.name, 'Overview');
  assert.deepStrictEqual(out.publish, { kind: 'verified', detail: '' });
  assert.deepStrictEqual(out.warnings, []);
  assert.deepStrictEqual(sdk.of('createArtifact')[0].args, ['genPage', {
    id: ID, name: 'Overview', source: 'export default 1;', dataSources: ['account', 'contact'], model: 'gpt-4.1',
    newTurn: { prompt: 'Build it', agentMessage: 'Done' },
  }]);
  assert.strictEqual(sdk.count('pushArtifact'), 1, 'one atomic change set');
  assert.deepStrictEqual(sdk.of('publishArtifact')[0].args, ['genPage', ID, { verify: true }]);
  assert.strictEqual(sdk.pages.get(ID).source, 'export default 1;');
  assert.strictEqual(sdk.count('fetchArtifact'), 0, 'a create that was answered reads nothing');
});

test('create: the name, prompt and agent message default to the words this plugin has always recorded; a supplied empty reply records none', async () => {
  const sdk = new FakeSdk();
  await backend(sdk).create({ source: 'x' });
  const [, def] = sdk.of('createArtifact')[0].args;
  assert.strictEqual(def.name, 'Generative page');
  assert.deepStrictEqual(def.newTurn, { prompt: 'Generative page Generative page', agentMessage: 'Authored by app-builder' });
  assert.deepStrictEqual(def.dataSources, []);
  assert.ok(!('model' in def), 'no model is sent when none was given');

  const silent = new FakeSdk();
  await backend(silent).create({ name: 'Named', source: 'x', prompt: '  ', agentMessage: '' });
  assert.deepStrictEqual(silent.of('createArtifact')[0].args[1].newTurn, { prompt: 'Generative page Named' }, 'a blank prompt is defaulted; an empty reply is a turn with no reply');
});

test('create: the bytes sent are the bytes given — a BOM is dropped, nothing is appended — and bytes that are not UTF-8 are refused before the SDK is touched', async () => {
  const sdk = new FakeSdk();
  await backend(sdk).create({ name: 'P', source: Buffer.from('\uFEFFexport default 1;\r\n', 'utf8') });
  assert.strictEqual(sdk.of('createArtifact')[0].args[1].source, 'export default 1;\r\n');

  const refused = new FakeSdk();
  await assert.rejects(backend(refused).create({ name: 'P', source: Buffer.from([0x61, 0xff]) }), (e) => e.code === 'GENPAGE_SOURCE_NOT_UTF8');
  assert.strictEqual(refused.calls.length, 0, 'nothing was sent or read');
});

test('create: connector and action bindings are bare JSON arrays, as config.json holds them; anything else is refused before the SDK is touched', async () => {
  const sdk = new FakeSdk();
  await backend(sdk).create({ name: 'P', source: 'x', connectorBindings: [{ c: 1 }], actionBindings: [] });
  const [, def] = sdk.of('createArtifact')[0].args;
  assert.deepStrictEqual(def.connectorBindings, [{ c: 1 }]);
  assert.deepStrictEqual(def.actionBindings, [], 'an empty list is still a list the page carries');

  const refused = new FakeSdk();
  await assert.rejects(backend(refused).create({ name: 'P', source: 'x', actionBindings: { a: 1 } }), (e) => e.code === 'GENPAGE_BINDING_INVALID');
  assert.strictEqual(refused.calls.length, 0);
});

test('create: an answer that is LOST is settled by READING the minted id — the page is there, so it is published and never sent again', async () => {
  const sdk = new FakeSdk().script('push', { lose: reset() });
  const out = await backend(sdk).create({ name: 'P', source: 'src' });
  assert.strictEqual(out.pageId, ID);
  assert.strictEqual(sdk.count('pushArtifact'), 1, 'it landed, so there is nothing to send again');
  assert.deepStrictEqual(sdk.of('fetchArtifact').map((c) => [c.args[1], c.args[2]]), [[ID, { overwrite: true }]], 'the read is of the minted id, from the server');
  assert.strictEqual(sdk.count('publishArtifact'), 1);
  assert.match(out.warnings.join('\n'), /answer to creating page "P" was lost.*showed that it had been written/s);
});

test('create: a send that NEVER ARRIVED leaves no page, so it is sent ONCE more — under the SAME id, from the same working copy', async () => {
  const sdk = new FakeSdk().script('push', { drop: reset() }, 'commit');
  const out = await backend(sdk).create({ name: 'P', source: 'src' });
  assert.strictEqual(out.pageId, ID);
  assert.strictEqual(sdk.count('pushArtifact'), 2);
  assert.strictEqual(sdk.count('createArtifact'), 1, 'the working copy is kept, so the same id and the same turn go again');
  assert.deepStrictEqual(sdk.of('pushArtifact').map((c) => c.args[1]), [ID, ID]);
  assert.strictEqual(sdk.pages.size, 1, 'exactly one page exists');
  assert.strictEqual(sdk.count('publishArtifact'), 1);
});

test('create: two sends that both left no usable answer end in an error that says the outcome is UNKNOWN — never a third send', async () => {
  const sdk = new FakeSdk().script('push', { drop: reset() }, { drop: reset() }, 'commit');
  await assert.rejects(backend(sdk).create({ name: 'P', source: 'src' }), (e) => {
    assert.strictEqual(e.outcome, 'unknown');
    assert.strictEqual(e.pageId, ID, 'the id is there to look for');
    assert.strictEqual(e.transient, false, 'the build must not re-run a create whose outcome is unknown');
    assert.match(e.message, /sent twice/);
    assert.match(e.message, new RegExp(ID));
    return true;
  });
  assert.strictEqual(sdk.count('pushArtifact'), 2, 'a third send is never offered');
  assert.strictEqual(sdk.count('publishArtifact'), 0);
});

test('create: a replay the SDK REPORTS as ARTIFACT_ALREADY_EXISTS means the first send landed after all — it is read and used, not retried', async () => {
  // The first send's answer is lost and the read after it finds nothing yet; by the time the resend arrives the first has landed.
  const late = (s, id) => {
    s.commit('genPage', id);
    return { type: 'genPage', id, saved: false, error: sdkError('ARTIFACT_ALREADY_EXISTS', 'the page already exists') };
  };
  const sdk = new FakeSdk().script('push', { drop: reset() }, late);
  const out = await backend(sdk).create({ name: 'P', source: 'src' });
  assert.strictEqual(out.pageId, ID);
  assert.strictEqual(sdk.count('pushArtifact'), 2);
  assert.strictEqual(sdk.pages.size, 1);
  assert.strictEqual(sdk.count('publishArtifact'), 1);
  assert.match(out.warnings.join('\n'), /was lost/);
});

test('create: a collision that finds NO page when read is reported as unknown, not as success', async () => {
  const exists = { report: { saved: false, error: sdkError('ARTIFACT_ALREADY_EXISTS', 'exists') } };
  const sdk = new FakeSdk().script('push', exists);
  await assert.rejects(backend(sdk).create({ name: 'P', source: 'src' }), (e) => e.outcome === 'unknown' && e.pageId === ID && /already exists, but no page .* can be read/.test(e.message));
  assert.strictEqual(sdk.count('pushArtifact'), 1, 'a collision is not answered with another send when the page cannot be read');
  assert.strictEqual(sdk.count('publishArtifact'), 0);
});

test('create: a page found under the minted id with ANOTHER source was changed after it landed — reported, not published', async () => {
  const sdk = new FakeSdk()
    .script('push', { lose: reset() })
    .script('fetch', (s, type, id) => { s.pages.get(id).source = 'edited by someone else'; });
  await assert.rejects(backend(sdk).create({ name: 'P', source: 'src' }), (e) => e.code === 'GENPAGE_CREATE_DIVERGED' && e.outcome === 'unknown' && e.pageId === ID && e.transient === false);
  assert.strictEqual(sdk.count('publishArtifact'), 0);
  assert.strictEqual(sdk.count('pushArtifact'), 1);
});

test('create: an unknown outcome whose read FAILS too is reported with the id to look for, and is not sent again', async () => {
  const sdk = new FakeSdk().script('push', { lose: reset() }).script('fetch', new Error('the read timed out'));
  await assert.rejects(backend(sdk).create({ name: 'P', source: 'src' }), (e) => {
    assert.strictEqual(e.outcome, 'unknown');
    assert.strictEqual(e.pageId, ID);
    assert.strictEqual(e.transient, false);
    assert.match(e.message, /the read timed out/);
    assert.match(e.message, /Look for page 11111111/);
    return true;
  });
  assert.strictEqual(sdk.count('pushArtifact'), 1);
});

test('create: an SDK refusal BEFORE the write (the page does not compile) is reported with the SDK\'s code and message, writes nothing and is not retried', async () => {
  const sdk = new FakeSdk();
  sdk.createError = sdkError('VALIDATION_ERROR', 'Generative page source does not compile: 1:5 Unexpected token');
  await assert.rejects(backend(sdk).create({ name: 'Broken', source: 'export default (' }), (e) => {
    assert.strictEqual(e.code, 'VALIDATION_ERROR', 'the SDK\'s own code');
    assert.strictEqual(e.outcome, 'nothing');
    assert.strictEqual(e.transient, false, 'the build\'s transient-halt re-run reads this and must never resend');
    assert.match(e.message, /"Broken" was not created \(nothing was written\)/);
    assert.match(e.message, /does not compile: 1:5 Unexpected token/);
    return true;
  });
  assert.strictEqual(sdk.count('pushArtifact'), 0);
  assert.strictEqual(sdk.count('fetchArtifact'), 0, 'a failure whose outcome is known reads nothing');
});

test('create: a 4xx from the server is a KNOWN failure — reported, nothing was written, not read and not retried', async () => {
  const sdk = new FakeSdk().script('push', { drop: connectionError(400, 'Bad request: the table does not exist') }, 'commit');
  await assert.rejects(backend(sdk).create({ name: 'P', source: 'src' }), (e) => e.outcome === 'nothing' && e.transient === false && /the table does not exist/.test(e.message));
  assert.strictEqual(sdk.count('pushArtifact'), 1);
  assert.strictEqual(sdk.count('fetchArtifact'), 0);
});

test('create: every way the outcome can be unknown (reset, 5xx from an intermediary, an answer the SDK cannot account for, a non-SDK error) is settled by reading', async () => {
  for (const failure of [connectionError(0, 'reset'), connectionError(503, 'unavailable'), connectionError(502, 'bad gateway'), connectionError(200, 'cannot be confirmed: 1 result for 3 operations'), new Error('socket hang up')]) {
    const sdk = new FakeSdk().script('push', { lose: failure });
    const out = await backend(sdk).create({ name: 'P', source: 'src' });
    assert.strictEqual(out.pageId, ID, String(failure.message));
    assert.strictEqual(sdk.count('fetchArtifact'), 1, `${failure.message}: the page was read`);
    assert.strictEqual(sdk.count('pushArtifact'), 1, `${failure.message}: it landed, so it was not sent again`);
  }
});

test('create: a publish that FAILS after the write is RETURNED, with the page id — the caller must still record that the page exists', async () => {
  const sdk = new FakeSdk().script('publish', new Error('PublishXml answered 500'));
  const out = await backend(sdk).create({ name: 'P', source: 'src' });
  assert.strictEqual(out.pageId, ID);
  assert.strictEqual(out.publish.kind, 'failed');
  assert.match(out.publish.detail, /PublishXml answered 500/);

  const refused = new FakeSdk().script('publish', { publish: { kind: 'failed', error: new Error('the publish was refused') } });
  const answered = await backend(refused).create({ name: 'P', source: 'src' });
  assert.strictEqual(answered.publish.kind, 'failed');
  assert.match(answered.publish.detail, /the publish was refused/);
});

test('a prompt and an agent message are values, not command text: quotes, line breaks, %VAR%, &, |, $(…) and non-ASCII reach the turn verbatim — create and update', async () => {
  const prompt = 'Conversation with 2 prompts:\r\n1. "Quote" & `tick` | $(whoami) %PATH% 東京 \'single\'\r\n2. line\n\n';
  const reply = '  indented reply — “curly”\nwith a final newline\n';
  const created = new FakeSdk();
  await backend(created).create({ name: 'P', source: 'x', prompt, agentMessage: reply });
  assert.deepStrictEqual(created.of('createArtifact')[0].args[1].newTurn, { prompt, agentMessage: reply }, 'not trimmed, not escaped');
  const updated = seeded();
  await backend(updated).update(ID, { source: 'new', prompt, agentMessage: reply });
  const turnCall = updated.of('addElement').pop().args[3];
  assert.deepStrictEqual(withoutTurnId(turnCall), { newTurn: { prompt, agentMessage: reply } });
  assert.match(turnCall.newTurn.id, GUID, 'and the turn carries the identity of its messages');
  assert.deepStrictEqual(updated.pages.get(ID).conversation.slice(-2).map((m) => m.message), [prompt, reply]);
});

test('create: a publish that cannot be PROVEN is a warning, not an error', async () => {
  const sdk = new FakeSdk().script('publish', { publish: { kind: 'unverifiable', reason: 'the published projection does not show the page yet' } });
  const out = await backend(sdk).create({ name: 'P', source: 'src' });
  assert.strictEqual(out.publish.kind, 'unverifiable');
  assert.match(out.warnings.join('\n'), /saved and published, but the published copy could not be read back.*does not show the page yet/s);
});

// ── CREATE: what a failed send proves — and what it does not ──────────────────────────────────────────────────────────

// The SDK persists its workspace once the change set has committed, and a disk that fills up then raises ENOSPC from pushArtifact for a page the server already holds
// whole. An error with a string `code` was read as an SDK refusal ("nothing was written") and reported with no page id.
test('create: a filesystem error AFTER the change set committed (ENOSPC) is settled by reading the id — the page is there, so it is published, never "nothing was written"', async () => {
  const full = Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC', errno: -28, syscall: 'write' });
  const sdk = new FakeSdk().script('push', { lose: full });
  const out = await backend(sdk).create({ name: 'P', source: 'src' });
  assert.strictEqual(out.pageId, ID);
  assert.strictEqual(sdk.count('pushArtifact'), 1, 'it landed, so it is not sent again');
  assert.deepStrictEqual(sdk.of('fetchArtifact').map((c) => c.args[1]), [ID], 'the minted id was read');
  assert.strictEqual(sdk.count('publishArtifact'), 1);
  assert.match(out.warnings.join('\n'), /ENOSPC/);
});

test('create: a filesystem error whose read also fails is UNKNOWN and keeps the page id — it used to be "nothing written" with no id', async () => {
  for (const code of ['ENOSPC', 'EACCES', 'EPERM', 'EIO']) {
    const error = Object.assign(new Error(`${code}: the workspace could not be written`), { code });
    const sdk = new FakeSdk().script('push', { lose: error }).script('fetch', new Error('the read timed out'));
    await assert.rejects(backend(sdk).create({ name: 'P', source: 'src' }), (e) => {
      assert.strictEqual(e.outcome, 'unknown', code);
      assert.strictEqual(e.pageId, ID, `${code}: the page id is kept, so it can be looked for`);
      assert.strictEqual(e.code, code, 'and the error it came from');
      assert.strictEqual(e.transient, false);
      return true;
    });
    assert.strictEqual(sdk.count('pushArtifact'), 1);
  }
});

test('create: a plain error that merely carries an SDK refusal\'s code is not one — the page is read, not reported as unwritten', async () => {
  const imposter = Object.assign(new Error('looks like a refusal'), { code: 'VALIDATION_ERROR' });
  const sdk = new FakeSdk().script('push', { lose: imposter });
  const out = await backend(sdk).create({ name: 'P', source: 'src' });
  assert.strictEqual(out.pageId, ID, 'it was written, and was found by reading it');
  assert.strictEqual(sdk.count('fetchArtifact'), 1);
});

// A send that got no usable answer is still in flight as far as anything here can tell. A resend that is then REFUSED (a 4xx) is a known failure of the
// resend only — it says nothing about the first, which can reach the service after the read that found no page.
test('create: a refused RESEND does not erase an unknown first send — the page is not there yet, so the outcome is UNKNOWN and carries the id', async () => {
  const sdk = new FakeSdk().script('push', { drop: reset() }, { drop: connectionError(429, 'Too many requests') });
  await assert.rejects(backend(sdk).create({ name: 'P', source: 'src' }), (e) => {
    assert.strictEqual(e.outcome, 'unknown', 'not "nothing was written": the first send may still land');
    assert.strictEqual(e.pageId, ID);
    assert.strictEqual(e.transient, false);
    assert.match(e.message, /outcome of creating it is unknown/);
    assert.match(e.message, /429/, 'the refusal is named');
    assert.match(e.message, /ECONNRESET/, 'and so is the send it says nothing about');
    assert.match(e.message, new RegExp(`Look for page ${ID}`));
    return true;
  });
  assert.strictEqual(sdk.count('pushArtifact'), 2, 'never a third send');
  assert.strictEqual(sdk.count('fetchArtifact'), 2, 'the page was read again after the refusal: that read is what could still have settled it');
  assert.strictEqual(sdk.count('publishArtifact'), 0);
});

test('create: a refused RESEND while the first send lands late — the page is found by the read that follows the refusal, adopted and published', async () => {
  // The first request commits while the resend is being refused: the server holds the whole page, and the resend's own answer is a 429.
  const landsMeanwhile = (s, id) => {
    s.commit('genPage', id);
    throw connectionError(429, 'Too many requests');
  };
  const sdk = new FakeSdk().script('push', { drop: reset() }, landsMeanwhile);
  const out = await backend(sdk).create({ name: 'P', source: 'src' });
  assert.strictEqual(out.pageId, ID);
  assert.strictEqual(sdk.pages.size, 1, 'one page');
  assert.strictEqual(sdk.count('pushArtifact'), 2);
  assert.strictEqual(sdk.count('publishArtifact'), 1);
  assert.match(out.warnings.join('\n'), /was lost.*a later send was refused: .*429.*had been written/s);
});

test('create: a refusal of the FIRST send is the one case where the refusal settles it — nothing was sent before it, so nothing was written, and no id is claimed', async () => {
  const sdk = new FakeSdk().script('push', { drop: connectionError(429, 'Too many requests') });
  await assert.rejects(backend(sdk).create({ name: 'P', source: 'src' }), (e) => {
    assert.strictEqual(e.outcome, 'nothing');
    assert.strictEqual(e.pageId, undefined, 'there is no page to look for');
    return true;
  });
  assert.strictEqual(sdk.count('fetchArtifact'), 0);
});

test('create: an id the caller supplies is the one the page is created under, and beforeSend hears it before anything is sent — a resume can reuse the id it recorded', async () => {
  const sdk = new FakeSdk();
  const heard = [];
  const genpage = backend(sdk);
  const out = await genpage.create({
    name: 'P', source: 'src', pageId: APP.toUpperCase(),
    beforeSend: async (pageId) => { heard.push({ pageId, pushesSoFar: sdk.count('pushArtifact') }); },
  });
  assert.strictEqual(out.pageId, APP, 'lower-cased, and not the one the minting seam would have given');
  assert.deepStrictEqual(heard, [{ pageId: APP, pushesSoFar: 0 }], 'announced once, with the id the page is created under, before the first push');
  assert.strictEqual(sdk.of('createArtifact')[0].args[1].id, APP);
  assert.ok(sdk.pages.has(APP));

  // Minted by the backend when the caller names none — and announced all the same.
  const minted = new FakeSdk();
  const announced = [];
  await backend(minted).create({ name: 'P', source: 'src', beforeSend: async (pageId) => { announced.push(pageId); } });
  assert.deepStrictEqual(announced, [ID]);
});

test('create: an id that is not a GUID, and a beforeSend that throws, both stop before anything is sent — nothing was written', async () => {
  const bad = new FakeSdk();
  await assert.rejects(backend(bad).create({ name: 'P', source: 'src', pageId: 'not-a-guid' }), (e) => e.code === 'GENPAGE_ID_INVALID' && e.outcome === 'nothing');
  assert.strictEqual(bad.calls.length, 0);

  const sdk = new FakeSdk();
  await assert.rejects(backend(sdk).create({ name: 'P', source: 'src', beforeSend: async () => { throw Object.assign(new Error('the pending record could not be saved'), { code: 'EACCES' }); } }), (e) => {
    assert.strictEqual(e.outcome, 'nothing');
    assert.strictEqual(e.pageId, undefined);
    assert.strictEqual(e.transient, false);
    assert.match(e.message, /was not created \(nothing was written\).*pending record could not be saved/);
    return true;
  });
  assert.strictEqual(sdk.count('pushArtifact'), 0, 'not one request was sent');
});

// ── CREATE: a resumed create, and a page found under its id ───────────────────────────────────────────────────────────────────────────────
// A create given an id is a RESUMED one: an earlier build sent a create under that id and never learned what became of it, so that request is open from the start — it can reach the service
// after anything this call reads or is told — and nothing this call's own send answers settles it. And a page found under the id is recognised by what was sent under it, never assumed.
const { sha256 } = require('../lib/hash.js');
const SENT = (name, source) => ({ name, sourceSha256: sha256(source) });

test('create: beforeSend hears what is about to be sent under the id — the name, and the SHA-256 of the source — before anything is sent', async () => {
  const sdk = new FakeSdk();
  const heard = [];
  await backend(sdk).create({ name: 'Overview', source: 'export default 1;', beforeSend: async (id, sent) => { heard.push({ id, sent, pushes: sdk.count('pushArtifact') }); } });
  assert.deepStrictEqual(heard, [{ id: ID, sent: { name: 'Overview', sourceSha256: sha256('export default 1;') }, pushes: 0 }]);
  const defaulted = new FakeSdk();
  const named = [];
  await backend(defaulted).create({ name: '  ', source: 'x', beforeSend: async (id, sent) => { named.push(sent.name); } });
  assert.deepStrictEqual(named, ['Generative page'], 'the name that is sent, not the one that was asked for');
});

test('create (resumed): a refusal BEFORE this call sent anything is not "nothing was written" — an earlier build\'s request can still land — and it carries the id; a new create says nothing was written', async () => {
  const refusal = sdkError('VALIDATION_ERROR', 'Generative page source does not compile: 1:5 Unexpected token');
  const resumed = new FakeSdk();
  resumed.createError = refusal;
  await assert.rejects(backend(resumed).create({ name: 'Broken', source: 'export default (', pageId: APP }), (e) => {
    assert.strictEqual(e.outcome, 'unknown');
    assert.strictEqual(e.pageId, APP);
    assert.strictEqual(e.code, 'VALIDATION_ERROR', 'the SDK\'s own code is kept');
    assert.strictEqual(e.transient, false);
    assert.doesNotMatch(e.message, /nothing was written/);
    assert.match(e.message, new RegExp(`"Broken" was not sent this time \\(.*does not compile.*\\), but a create an earlier build sent under id ${APP} was never accounted for and can still land, so whether page ${APP} exists is not known`));
    assert.match(e.message, new RegExp(`Look for page ${APP}`));
    return true;
  });
  assert.strictEqual(resumed.count('pushArtifact'), 0);

  // The same for a beforeSend that refuses (the record of what is sent could not be saved).
  const unsaved = new FakeSdk();
  await assert.rejects(backend(unsaved).create({ name: 'P', source: 'src', pageId: APP, beforeSend: async () => { throw new Error('the pending record could not be saved'); } }), (e) => e.outcome === 'unknown' && e.pageId === APP && /pending record could not be saved/.test(e.message) && !/nothing was written/.test(e.message));
  assert.strictEqual(unsaved.count('pushArtifact'), 0);

  // A new create has no earlier build behind it: the same refusal is known to have written nothing.
  const fresh = new FakeSdk();
  fresh.createError = refusal;
  await assert.rejects(backend(fresh).create({ name: 'Broken', source: 'export default (' }), (e) => e.outcome === 'nothing' && e.pageId === undefined && /nothing was written/.test(e.message));
});

test('create (resumed): a refusal of its first send — a 429 — settles nothing: the page is read, and absent it is UNKNOWN with the id; present and sent by a create under the id it is adopted and published', async () => {
  const refused = () => connectionError(429, 'Too many requests');
  const absent = new FakeSdk().script('push', { drop: refused() });
  await assert.rejects(backend(absent).create({ name: 'P', source: 'src', pageId: ID }), (e) => {
    assert.strictEqual(e.outcome, 'unknown', 'not "nothing was written": nothing says the earlier request cannot land');
    assert.strictEqual(e.pageId, ID);
    assert.strictEqual(e.transient, false);
    assert.doesNotMatch(e.message, /nothing was written|wrote nothing/);
    assert.match(e.message, /429/, 'the refusal is named');
    assert.match(e.message, /a create an earlier build sent under id .*, whose outcome was never learned/, 'and so is the request it says nothing about');
    assert.match(e.message, /it can still reach the service/);
    return true;
  });
  assert.strictEqual(absent.count('pushArtifact'), 1, 'it was not sent again');
  assert.strictEqual(absent.count('fetchArtifact'), 1, 'the page was read after the refusal');
  assert.strictEqual(absent.count('publishArtifact'), 0);

  // While the send is refused, the earlier request lands.
  const landsMeanwhile = (s, id) => { s.commit('genPage', id); throw refused(); };
  const landed = new FakeSdk().script('push', landsMeanwhile);
  const out = await backend(landed).create({ name: 'P', source: 'src', pageId: ID, sentBefore: [SENT('P', 'src')] });
  assert.strictEqual(out.pageId, ID);
  assert.strictEqual(landed.pages.size, 1);
  assert.strictEqual(landed.count('publishArtifact'), 1);
  assert.match(out.warnings.join('\n'), /was lost.*a later send was refused: .*429.*had been written/s);

  // A resumed create whose own send is saved needs no read, as a new one does not.
  const saved = new FakeSdk();
  const direct = await backend(saved).create({ name: 'P', source: 'src', pageId: ID });
  assert.strictEqual(direct.pageId, ID);
  assert.strictEqual(saved.count('fetchArtifact'), 0);
  assert.deepStrictEqual(direct.warnings, []);
});

test('create: a page found under the id that holds a name no create under it sent, or a source none sent, is not ours — never adopted, updated or published — and the error says what differs', async () => {
  const found = (change) => new FakeSdk().script('push', { lose: reset() }).script('fetch', (s, type, id) => { change(s.pages.get(id)); });
  const refuse = async (sdk, args, says) => {
    await assert.rejects(backend(sdk).create({ name: 'P', source: 'src', ...args }), (e) => {
      assert.strictEqual(e.code, 'GENPAGE_CREATE_DIVERGED');
      assert.strictEqual(e.outcome, 'unknown');
      assert.strictEqual(e.pageId, ID);
      assert.strictEqual(e.transient, false);
      assert.match(e.message, new RegExp(`generative page "P" \\(${ID}\\) exists, but it is not a page any create under this id sent: ${says}`));
      assert.match(e.message, /It was not adopted, not sent again and not published/);
      return true;
    });
    assert.strictEqual(sdk.count('publishArtifact'), 0, 'not published');
    assert.strictEqual(sdk.count('updateElement') + sdk.count('addElement'), 0, 'not updated');
    assert.strictEqual(sdk.count('pushArtifact'), 1, 'not sent again');
  };
  await refuse(found((page) => { page.name = 'Another app page'; }), {}, 'it is named "Another app page", and the create sent "P"\\.');
  await refuse(found((page) => { page.source = 'edited by someone else'; }), {}, 'its source is not the one that was sent\\.');
  await refuse(found((page) => { page.name = 'Another'; page.source = 'theirs'; }), {}, 'it is named "Another", and the create sent "P", and its source is not the one that was sent\\.');
  // Earlier creates under the id widen what is recognised — and what the error lists.
  await refuse(found((page) => { page.name = 'Third'; }), { pageId: ID, sentBefore: [SENT('Q', 'old source')] }, 'it is named "Third", and the creates sent "P" or "Q"\\.');
  await refuse(found((page) => { page.name = 'Q'; }), { pageId: ID, sentBefore: [SENT('Q', 'old source')] }, 'its name and its source were sent by different creates\\.');
});

test('create: a page found under the id that holds what an EARLIER create under it sent — another model, another name — is ours: it is brought to this create\'s content by the ordinary update, and published after that, not before', async () => {
  const earlier = (over) => ({ id: ID, name: 'P', source: 'src', dataSources: [], model: 'model-before', firstPrompt: 'First request', conversation: [{ sender: 'user', message: 'First request' }, { sender: 'agent', message: 'First reply' }], ...over });

  // Another model.
  const sdk = new FakeSdk().seedPage(earlier());
  const out = await backend(sdk).create({ name: 'P', source: 'src', model: 'model-after', prompt: 'Revised request', agentMessage: 'Revised reply', pageId: ID, sentBefore: [SENT('P', 'src')] });
  assert.strictEqual(out.pageId, ID);
  assert.strictEqual(sdk.pages.get(ID).model, 'model-after', 'the page holds what this create asks for');
  assert.deepStrictEqual(sdk.pages.get(ID).conversation.map((m) => m.message), ['First request', 'First reply', 'Revised request', 'Revised reply'], 'the update recorded this create\'s turn');
  assert.deepStrictEqual(sdk.of('publishArtifact').map((c) => c.args), [['genPage', ID, { verify: true }]], 'published once, after the update');
  const calls = sdk.calls.map((c) => c.name);
  assert.ok(calls.lastIndexOf('pushArtifact') < calls.indexOf('publishArtifact'), 'the push that brought it to this create\'s content came before the publish');
  assert.match(out.warnings.join('\n'), new RegExp(`differing from this create in model — so it was not sent again, and was updated to what this create asks for instead of being published as it was`));
  assert.deepStrictEqual(out.publish, { kind: 'verified', detail: '' });

  // Another name, found by the name an earlier create under the id sent.
  const renamed = new FakeSdk().seedPage(earlier({ name: 'Old name', model: undefined }));
  const renamedOut = await backend(renamed).create({ name: 'New name', source: 'src', pageId: ID, sentBefore: [SENT('Old name', 'src')] });
  assert.strictEqual(renamed.pages.get(ID).name, 'New name');
  assert.match(renamedOut.warnings.join('\n'), /differing from this create in name/);

  // The same page with no record of an earlier create under the id is NOT recognised: the name alone belongs to nobody we can name.
  const unrecorded = new FakeSdk().seedPage(earlier({ name: 'Old name', model: undefined }));
  await assert.rejects(backend(unrecorded).create({ name: 'New name', source: 'src', pageId: ID }), (e) => e.code === 'GENPAGE_CREATE_DIVERGED');
  assert.strictEqual(unrecorded.count('updateElement') + unrecorded.count('publishArtifact'), 0);
});

test('create: an update that cannot bring the page found under the id to this create\'s content leaves it unpublished and says so — UNKNOWN, with the id, whatever the update\'s own outcome was', async () => {
  const sdk = new FakeSdk()
    .seedPage({ id: ID, name: 'P', source: 'src', dataSources: [], model: 'model-before', conversation: [{ sender: 'user', message: 'First' }] })
    .script('update', sdkError('VALIDATION_ERROR', 'the model is not available'));
  await assert.rejects(backend(sdk).create({ name: 'P', source: 'src', model: 'model-after', pageId: ID, sentBefore: [SENT('P', 'src')] }), (e) => {
    assert.strictEqual(e.outcome, 'unknown', 'the update said "nothing was written" — about itself; the page IS there');
    assert.strictEqual(e.pageId, ID);
    assert.strictEqual(e.code, 'VALIDATION_ERROR');
    assert.strictEqual(e.transient, false);
    assert.match(e.message, /was written by a create under this id, but it holds the model of an earlier one, and bringing it to what this create asks for failed: .*the model is not available/s);
    assert.match(e.message, /It was not published as it is/);
    return true;
  });
  assert.strictEqual(sdk.count('publishArtifact'), 0);
});

test('create: a page that holds what this create asks for, with only the first prompt of an earlier create, is adopted as it is — with a warning that the prompt is not this create\'s', async () => {
  const sdk = new FakeSdk().seedPage({ id: ID, name: 'P', source: 'src', dataSources: [], firstPrompt: 'Earlier prompt', conversation: [{ sender: 'user', message: 'Earlier prompt' }, { sender: 'agent', message: 'Earlier reply' }] });
  const out = await backend(sdk).create({ name: 'P', source: 'src', prompt: 'This prompt', pageId: ID, sentBefore: [SENT('P', 'src')] });
  assert.strictEqual(sdk.count('updateElement') + sdk.count('addElement'), 0, 'nothing differs that an update would write — and an update records a prompt only when it changes the page');
  assert.strictEqual(sdk.count('publishArtifact'), 1);
  assert.match(out.warnings.join('\n'), /holds what this create asks for, but its first recorded prompt is that of an earlier create under this id: an update records a prompt only when it changes the page, so this create's prompt is not recorded/);
  // The page this create made itself carries no such warning.
  const own = new FakeSdk().script('push', { lose: reset() });
  const ownOut = await backend(own).create({ name: 'P', source: 'src', prompt: 'This prompt' });
  assert.doesNotMatch(ownOut.warnings.join('\n'), /first recorded prompt/);
});

// ── UPDATE ───────────────────────────────────────────────────────────────────────────────────────────────────────

test('update: writes only what differs, records the new turn, pushes once and publishes with verification', async () => {
  const sdk = seeded();
  const out = await backend(sdk).update(ID, { source: 'export default function New() { return null; }', prompt: 'Change it', agentMessage: 'Changed' });
  assert.strictEqual(out.pageId, ID);
  assert.ok(!out.unchanged);
  assert.deepStrictEqual(edits(sdk), [
    ['updateElement', '/source', 'export default function New() { return null; }'],
    ['addElement', '', { newTurn: { prompt: 'Change it', agentMessage: 'Changed' } }],
  ], 'the source, and the turn — nothing else, though the page has a name, a model, data sources and bindings');
  assert.strictEqual(sdk.count('pushArtifact'), 1);
  assert.deepStrictEqual(sdk.of('publishArtifact')[0].args, ['genPage', ID, { verify: true }]);
  const page = sdk.pages.get(ID);
  assert.strictEqual(page.source, 'export default function New() { return null; }');
  assert.strictEqual(page.firstPrompt, 'first prompt', 'the FIRST prompt is kept');
  assert.deepStrictEqual(page.conversation.map((m) => m.message), ['first prompt', 'first reply', 'Change it', 'Changed'], 'the new prompt is a turn of the conversation');
});

test('update: every field that differs is written — a value the page has by an update, one it does not have yet by an add', async () => {
  const sdk = seeded({ model: undefined, connectorBindings: undefined, actionBindings: undefined });
  await backend(sdk).update(ID, {
    source: 'new', name: 'Renamed', dataSources: 'Contact', model: 'gpt-5', connectorBindings: [{ c: 1 }], actionBindings: [], prompt: 'p', agentMessage: 'r',
  });
  assert.deepStrictEqual(edits(sdk), [
    ['updateElement', '/source', 'new'],
    ['updateElement', '/name', 'Renamed'],
    ['updateElement', '/dataSources', ['contact']],
    ['addElement', '', { model: 'gpt-5' }],
    ['addElement', '', { connectorBindings: [{ c: 1 }] }],
    ['addElement', '', { actionBindings: [] }],
    ['addElement', '', { newTurn: { prompt: 'p', agentMessage: 'r' } }],
  ]);
  const page = sdk.pages.get(ID);
  assert.strictEqual(page.name, 'Renamed');
  assert.deepStrictEqual(page.dataSources, ['contact']);
  assert.strictEqual(page.model, 'gpt-5');
});

test('update: a field the caller leaves out is the page\'s own — an omitted name, model, data-source list or binding list is not an instruction to clear it', async () => {
  const sdk = seeded();
  await backend(sdk).update(ID, { source: 'new' });
  assert.deepStrictEqual(edits(sdk).map((e) => e[1]), ['/source', ''], 'the source and the turn only');
  const page = sdk.pages.get(ID);
  assert.strictEqual(page.name, 'Overview');
  assert.strictEqual(page.model, 'gpt-4.1');
  assert.deepStrictEqual(page.dataSources, ['account']);
  assert.deepStrictEqual(page.connectorBindings, [{ connector: 'x' }]);
  assert.deepStrictEqual(page.actionBindings, [{ action: 'y' }]);
});

test('update: an empty list is the explicit instruction to clear — data sources and either binding list', async () => {
  const sdk = seeded();
  await backend(sdk).update(ID, { source: 'new', dataSources: [], connectorBindings: [], actionBindings: [] });
  const page = sdk.pages.get(ID);
  assert.deepStrictEqual(page.dataSources, []);
  assert.deepStrictEqual(page.connectorBindings, []);
  assert.deepStrictEqual(page.actionBindings, []);
  assert.strictEqual(page.model, 'gpt-4.1');
  assert.deepStrictEqual(edits(sdk).filter((e) => e[0] === 'updateElement').map((e) => e[1]), ['/source', '/dataSources', '/connectorBindings', '/actionBindings']);
});

test('update: content the page already holds is NOT written and records no turn — but the page is still published and proven', async () => {
  const sdk = seeded({ source: 'same' });
  const out = await backend(sdk).update(ID, { source: 'same', name: 'Overview', dataSources: ['account'], model: 'gpt-4.1', prompt: 'again', agentMessage: 'again' });
  assert.strictEqual(out.unchanged, true);
  assert.strictEqual(sdk.count('updateElement') + sdk.count('addElement'), 0);
  assert.strictEqual(sdk.count('pushArtifact'), 0, 'nothing to write');
  assert.strictEqual(sdk.pages.get(ID).conversation.length, 2, 'no turn is recorded for an identical re-send');
  assert.deepStrictEqual(sdk.of('publishArtifact')[0].args, ['genPage', ID, { verify: true }], 'a page saved by a run whose publish failed converges here');
  assert.strictEqual(out.publish.kind, 'verified');
});

// A caller that kept what it published — the build, in its workspace — tells an update so (`publishedFingerprint`, the `fingerprint` an earlier result gave it), and the update does not publish a
// page it has just READ as already holding that content. It is the only reason not to publish, and it is conditional on the read: a page that differs is written and published whatever the
// caller recorded, and a fingerprint that is missing, is another content's or is not a fingerprint leaves the publish as it always was (the test above).
test('update: a page that already holds the content, given the fingerprint of that content as published, is neither written nor published — the result says "skipped" and carries the fingerprint', async () => {
  const sdk = seeded({ source: 'same' });
  const asked = { source: 'same', name: 'Overview', dataSources: ['account'], model: 'gpt-4.1', prompt: 'again', agentMessage: 'again' };
  const first = await backend(sdk).update(ID, asked);
  assert.strictEqual(first.publish.kind, 'verified');
  assert.match(first.fingerprint, /^[0-9a-f]{64}$/);
  assert.strictEqual(sdk.count('publishArtifact'), 1);

  const again = await backend(sdk).update(ID, { ...asked, publishedFingerprint: first.fingerprint });
  assert.deepStrictEqual([again.unchanged, again.publish.kind, again.fingerprint, again.warnings], [true, 'skipped', first.fingerprint, []]);
  assert.strictEqual(sdk.count('publishArtifact'), 1, 'no publish was sent');
  assert.strictEqual(sdk.count('pushArtifact') + sdk.count('updateElement') + sdk.count('addElement'), 0, 'and nothing was written');
});

test('update: a fingerprint of OTHER content, or one that is not a fingerprint, is "not known to be published" — the page is published', async () => {
  const sdk = seeded({ source: 'same' });
  const asked = { source: 'same', name: 'Overview', dataSources: ['account'], model: 'gpt-4.1' };
  const { fingerprint } = await backend(sdk).update(ID, asked);
  let publishes = sdk.count('publishArtifact');
  const other = contentFingerprint({ ...asked, name: 'Renamed' });
  for (const recorded of [other, '0'.repeat(64), 'not a hash', '', 42, null, undefined]) {
    const out = await backend(sdk).update(ID, { ...asked, publishedFingerprint: recorded });
    publishes += 1;
    assert.strictEqual(out.publish.kind, 'verified', `${JSON.stringify(recorded)} is not the content's fingerprint`);
    assert.strictEqual(sdk.count('publishArtifact'), publishes);
    assert.strictEqual(out.fingerprint, fingerprint);
  }
});

test('update: a page that DIFFERS from the content is written and published whatever the caller recorded — the record is only ever read together with the page', async () => {
  const sdk = seeded({ source: 'old' });
  const asked = { source: 'new', name: 'Overview', dataSources: ['account'], model: 'gpt-4.1', prompt: 'p', agentMessage: 'r' };
  const out = await backend(sdk).update(ID, { ...asked, publishedFingerprint: contentFingerprint({ source: 'new', name: 'Overview', dataSources: ['account'], model: 'gpt-4.1' }) });
  assert.strictEqual(sdk.pages.get(ID).source, 'new', 'written');
  assert.strictEqual(sdk.count('publishArtifact'), 1, 'and published');
  assert.strictEqual(out.publish.kind, 'verified');
  assert.strictEqual(out.unchanged, undefined);
});

test('contentFingerprint: the content a page is asked to hold — source, name, data sources, model, bindings — and nothing else; create and update give the same one for the same content', async () => {
  const base = { source: 'export default 1;', name: 'Overview', dataSources: ['account'], model: 'gpt-4.1' };
  const same = contentFingerprint(base);
  assert.match(same, /^[0-9a-f]{64}$/);
  assert.strictEqual(contentFingerprint({ ...base }), same, 'a pure function of the content');
  assert.strictEqual(contentFingerprint({ ...base, model: undefined }), contentFingerprint({ source: base.source, name: base.name, dataSources: base.dataSources }), 'a field left out is the page\'s own and is no part of it');
  for (const [field, value] of [['source', 'export default 2;'], ['name', 'Renamed'], ['dataSources', ['account', 'contact']], ['model', 'gpt-5'], ['connectorBindings', [{ connector: 'x' }]], ['actionBindings', [{ action: 'y' }]]]) {
    assert.notStrictEqual(contentFingerprint({ ...base, [field]: value }), same, `another ${field} is other content`);
  }
  assert.notStrictEqual(contentFingerprint({ ...base, dataSources: [] }), contentFingerprint({ source: base.source, name: base.name, model: base.model }), 'an empty list is an instruction to clear, not "left out"');

  // The same content through `create` and through `update`: the data sources are given as a CSV to one and a list to the other, as the callers do.
  const sdk = new FakeSdk();
  const created = await backend(sdk).create({ name: 'Overview', source: 'export default 1;', dataSources: 'Account', model: 'gpt-4.1', prompt: 'p', agentMessage: 'r' });
  assert.strictEqual(created.fingerprint, same);
  const updated = await backend(sdk).update(ID, { source: 'export default 1;', name: 'Overview', dataSources: ['account'], model: 'gpt-4.1' });
  assert.strictEqual(updated.fingerprint, same);
  assert.strictEqual(updated.unchanged, true);
});

test('update: a name stored the way pac stored it (`\\"`) differs from the same name sent as it is, so the update repairs it', async () => {
  const sdk = seeded({ name: 'Say \\"hi\\" now' });
  await backend(sdk).update(ID, { source: 'old-same', name: 'Say "hi" now' });
  assert.ok(edits(sdk).some((e) => e[0] === 'updateElement' && e[1] === '/name' && e[2] === 'Say "hi" now'));
  assert.strictEqual(sdk.pages.get(ID).name, 'Say "hi" now');
});

test('update: a page that is not there, one that cannot be read, and a raw-file page are refused with nothing written', async () => {
  const absent = new FakeSdk();
  await assert.rejects(backend(absent).update(ID, { source: 'x' }), (e) => e.code === 'GENPAGE_NOT_FOUND' && e.outcome === 'nothing' && e.transient === false && e.pageId === ID);

  const unreadable = seeded().script('fetch', new Error('the read timed out'));
  await assert.rejects(backend(unreadable).update(ID, { source: 'x' }), (e) => e.code === 'GENPAGE_UNREADABLE' && e.outcome === 'nothing' && /the read timed out/.test(e.message));
  assert.strictEqual(unreadable.count('pushArtifact'), 0);

  const raw = seeded({ source: undefined });
  await assert.rejects(backend(raw).update(ID, { source: 'x' }), (e) => e.code === 'GENPAGE_NO_SOURCE' && e.outcome === 'nothing' && /held as raw files/.test(e.message));
  assert.strictEqual(raw.count('pushArtifact'), 0);

  await assert.rejects(backend(new FakeSdk()).update('not-a-guid', { source: 'x' }), (e) => e.code === 'GENPAGE_ID_INVALID');
});

test('update: an edit the SDK refuses BEFORE anything is written (a page that does not compile) says so, and is not retried', async () => {
  const sdk = seeded().script('update', sdkError('VALIDATION_ERROR', 'Generative page source does not compile: 2:1 Unexpected token'));
  await assert.rejects(backend(sdk).update(ID, { source: 'export default (' }), (e) => {
    assert.strictEqual(e.code, 'VALIDATION_ERROR');
    assert.strictEqual(e.outcome, 'nothing');
    assert.strictEqual(e.pageId, ID, 'the page is named: the caller knew it before the write, and a failure must not lose it');
    assert.strictEqual(e.transient, false);
    assert.match(e.message, /refused before anything was written/);
    return true;
  });
  assert.strictEqual(sdk.count('pushArtifact'), 0);
  assert.strictEqual(sdk.pages.get(ID).source, deployed().source, 'the page is as it was');
});

test('update: a 4xx on the push is a KNOWN failure — nothing was written, nothing is read or sent again', async () => {
  const sdk = seeded().script('push', { drop: connectionError(403, 'Principal user is missing prvWrite privilege') });
  await assert.rejects(backend(sdk).update(ID, { source: 'new' }), (e) => e.outcome === 'nothing' && e.transient === false && /prvWrite/.test(e.message));
  assert.strictEqual(sdk.count('pushArtifact'), 1);
  assert.strictEqual(sdk.count('fetchArtifact'), 1, 'only the baseline read');
});

test('update: a VERSION_CONFLICT the SDK reports on the first send means the page moved since it was read — refused, nothing written, not read again, not resent', async () => {
  const sdk = seeded().script('push', { report: { saved: false, error: sdkError('VERSION_CONFLICT', 'Version conflict (412)') } });
  await assert.rejects(backend(sdk).update(ID, { source: 'new' }), (e) => {
    assert.strictEqual(e.code, 'VERSION_CONFLICT');
    assert.strictEqual(e.outcome, 'nothing');
    assert.strictEqual(e.transient, false);
    assert.match(e.message, /changed by someone else after it was read, and nothing was written/);
    return true;
  });
  assert.strictEqual(sdk.count('pushArtifact'), 1);
  assert.strictEqual(sdk.count('fetchArtifact'), 1);
});

test('update: a lost answer where the page now holds what was sent AND the turn — it landed: not sent again, published', async () => {
  const sdk = seeded().script('push', { lose: reset() });
  const out = await backend(sdk).update(ID, { source: 'new', prompt: 'Change it', agentMessage: 'Changed' });
  assert.strictEqual(sdk.count('pushArtifact'), 1, 'sent once');
  assert.strictEqual(sdk.count('publishArtifact'), 1);
  assert.match(out.warnings.join('\n'), /was lost.*the update, and its turn, had been written — so it was not sent again/s);
  assert.deepStrictEqual(sdk.pages.get(ID).conversation.map((m) => m.message), ['first prompt', 'first reply', 'Change it', 'Changed'], 'the turn is recorded once');
});

test('update: a lost answer where the page is AS BEFORE — nothing landed: sent ONCE more, from what the page holds now', async () => {
  const sdk = seeded().script('push', { drop: reset() }, 'commit');
  const out = await backend(sdk).update(ID, { source: 'new', prompt: 'Change it', agentMessage: 'Changed' });
  assert.strictEqual(sdk.count('pushArtifact'), 2);
  assert.strictEqual(sdk.count('fetchArtifact'), 2, 'the baseline, then the settling read');
  assert.strictEqual(sdk.pages.get(ID).source, 'new');
  assert.deepStrictEqual(sdk.pages.get(ID).conversation.map((m) => m.message), ['first prompt', 'first reply', 'Change it', 'Changed'], 'the turn is recorded once, not twice');
  assert.strictEqual(sdk.count('publishArtifact'), 1);
  assert.deepStrictEqual(out.warnings, []);
});

test('update: a lost answer where the page holds NEITHER what was sent nor what it held — refused, NOT sent again, with where to look', async () => {
  const sdk = seeded()
    .script('push', { drop: reset() })
    .script('fetch', undefined, (s, type, id) => { s.pages.get(id).source = 'saved by someone else in the meantime'; });
  await assert.rejects(backend(sdk).update(ID, { source: 'new' }), (e) => {
    assert.strictEqual(e.outcome, 'unknown');
    assert.strictEqual(e.transient, false, 'the build must not re-run an update that may have landed');
    assert.strictEqual(e.pageId, ID);
    assert.match(e.message, /MAY HAVE LANDED or been overtaken/);
    assert.match(e.message, /a second send would overwrite whatever was saved since/);
    return true;
  });
  assert.strictEqual(sdk.count('pushArtifact'), 1, 'never sent again blindly');
  assert.strictEqual(sdk.count('publishArtifact'), 0);
});

test('update: two sends with nothing landed and no usable answer stop there — never a third — and are UNKNOWN, not "nothing written": a send whose answer was lost can still land', async () => {
  const sdk = seeded().script('push', { drop: reset() }, { drop: reset() }, 'commit');
  await assert.rejects(backend(sdk).update(ID, { source: 'new' }), (e) => {
    assert.strictEqual(e.outcome, 'unknown', 'the page reading as it was is a snapshot: either send may still arrive');
    assert.strictEqual(e.pageId, ID);
    assert.strictEqual(e.transient, false);
    assert.match(e.message, /sent twice/);
    assert.match(e.message, /NOT sent a third time/);
    assert.match(e.message, /can still land/);
    return true;
  });
  assert.strictEqual(sdk.count('pushArtifact'), 2);
  assert.strictEqual(sdk.pages.get(ID).source, deployed().source);
});

// ── UPDATE: one turn identity, and a refused resend that settles nothing ──────────────────────────────────────────────

const TURN_ID = '77777777-0000-4000-8000-0000000000cc';
const turnCalls = (sdk) => sdk.of('addElement').filter((c) => c.args[3] && c.args[3].newTurn).map((c) => c.args[3].newTurn);

// The SDK keeps the id of a turn in its copy of the page, and the read that settles an unknown outcome REPLACES that copy with the server's. The resend then
// recorded a turn with new message ids, so when the first send was still in flight and landed beside it, the conversation held the prompt and the reply twice.
test('update: the turn keeps ONE identity across the settling read — the resend records the same turn, so a late duplicate collides on its message ids', async () => {
  const sdk = seeded().script('push', { drop: reset() }, 'commit');
  await backend(sdk, { newTurnId: () => TURN_ID.toUpperCase() }).update(ID, { source: 'new', prompt: 'Change it', agentMessage: 'Changed' });
  assert.strictEqual(sdk.count('pushArtifact'), 2, 'sent again, because the page was as it was');
  const turns = turnCalls(sdk);
  assert.strictEqual(turns.length, 2, 'the turn was added to the working copy for each send — the read in between replaced the copy that held the first');
  assert.deepStrictEqual(turns.map((t) => t.id), [TURN_ID, TURN_ID], 'under one identity, lower-cased');
  assert.deepStrictEqual(turns.map((t) => [t.prompt, t.agentMessage]), [['Change it', 'Changed'], ['Change it', 'Changed']]);

  // Without a seam the identity is minted — a GUID, the shape the SDK derives the message ids from — once per update, and a second update has its own.
  const minted = seeded().script('push', { drop: reset() }, 'commit');
  await backend(minted).update(ID, { source: 'new' });
  const [first, again] = turnCalls(minted);
  assert.match(first.id, GUID);
  assert.strictEqual(again.id, first.id);
  const other = seeded();
  await backend(other).update(ID, { source: 'newer' });
  assert.notStrictEqual(turnCalls(other)[0].id, first.id, 'a different update is a different turn');
});

test('update: a refused RESEND does not erase an unknown first send — the page still reads as it was, so the outcome is UNKNOWN (it used to be "nothing")', async () => {
  const sdk = seeded().script('push', { drop: reset() }, { drop: connectionError(429, 'Too many requests') });
  await assert.rejects(backend(sdk).update(ID, { source: 'new', caller: 'build' }), (e) => {
    assert.strictEqual(e.outcome, 'unknown', 'a first send whose answer was lost can still land after this read');
    assert.strictEqual(e.pageId, ID);
    assert.strictEqual(e.transient, false);
    assert.match(e.message, /429/);
    assert.match(e.message, /can still land/);
    assert.match(e.message, /NOT sent a third time/);
    return true;
  });
  assert.strictEqual(sdk.count('pushArtifact'), 2);
  assert.strictEqual(sdk.count('fetchArtifact'), 3, 'the baseline, the read that settled the first send, and the read after the refusal');
  assert.strictEqual(sdk.pages.get(ID).source, deployed().source);
});

test('update: a refused RESEND while the first send lands late — the read that follows the refusal finds the update and its turn: landed, once, published', async () => {
  const landsMeanwhile = (s, id) => {
    s.commit('genPage', id);
    throw connectionError(429, 'Too many requests');
  };
  const sdk = seeded().script('push', { drop: reset() }, landsMeanwhile);
  const out = await backend(sdk).update(ID, { source: 'new', prompt: 'Change it', agentMessage: 'Changed' });
  assert.strictEqual(sdk.count('pushArtifact'), 2);
  assert.strictEqual(sdk.count('publishArtifact'), 1);
  assert.deepStrictEqual(sdk.pages.get(ID).conversation.map((m) => m.message), ['first prompt', 'first reply', 'Change it', 'Changed'], 'the turn is recorded once');
  assert.match(out.warnings.join('\n'), /was lost.*had been written — so it was not sent again/s);
});

// A version conflict is the one refusal an update's FIRST send can settle: nothing was sent before it, and the SDK compared the page's version tokens before it wrote anything. On
// a resend it settles nothing: the tokens it names may be the first send's own, which landed — and a send whose answer was lost is still open.
test('update: a VERSION_CONFLICT the SDK reports on the RESEND does not erase an unknown first send — the page is read: unknown with its id, or landed once when the first send is found', async () => {
  const conflict = () => ({ saved: false, error: sdkError('VERSION_CONFLICT', 'Version conflict (412)') });
  const open = seeded().script('push', { drop: reset() }, { report: conflict() });
  await assert.rejects(backend(open).update(ID, { source: 'new', caller: 'build' }), (e) => {
    assert.strictEqual(e.outcome, 'unknown', 'a first send whose answer was lost can still land after this read');
    assert.strictEqual(e.pageId, ID);
    assert.strictEqual(e.transient, false);
    assert.match(e.message, /can still land/);
    return true;
  });
  assert.strictEqual(open.count('pushArtifact'), 2);
  assert.strictEqual(open.count('fetchArtifact'), 3, 'the baseline, the read that settled the first send, and the read after the refusal');

  // The first send lands while the resend is being refused: its tokens are the ones the conflict names, and the read that follows finds the update and its turn.
  const landsMeanwhile = (s, id) => { s.commit('genPage', id); return { type: 'genPage', id, ...conflict() }; };
  const landed = seeded().script('push', { drop: reset() }, landsMeanwhile);
  const out = await backend(landed).update(ID, { source: 'new', prompt: 'Change it', agentMessage: 'Changed' });
  assert.deepStrictEqual(landed.pages.get(ID).conversation.map((m) => m.message), ['first prompt', 'first reply', 'Change it', 'Changed'], 'the turn is recorded once');
  assert.strictEqual(landed.count('publishArtifact'), 1);
  assert.match(out.warnings.join('\n'), /was lost.*had been written — so it was not sent again/s);
});

test('update: a resend the SDK refuses BEFORE sending it still leaves the first send open — unknown, not "nothing was written"', async () => {
  const refusal = sdkError('VALIDATION_ERROR', 'Generative page source does not compile');
  const sdk = seeded().script('push', { drop: reset() }).script('update', undefined, undefined, refusal);
  await assert.rejects(backend(sdk).update(ID, { source: 'new' }), (e) => {
    assert.strictEqual(e.outcome, 'unknown');
    assert.strictEqual(e.pageId, ID);
    assert.match(e.message, /MAY HAVE LANDED/);
    assert.match(e.message, /sending it once more was refused before anything was sent/);
    return true;
  });
  assert.strictEqual(sdk.count('pushArtifact'), 1, 'the resend was never made');
});

test('update: a filesystem error AFTER the change set committed (ENOSPC) is read, not reported as unwritten — the update landed, with its turn, and is published', async () => {
  const full = Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
  const sdk = seeded().script('push', { lose: full });
  const out = await backend(sdk).update(ID, { source: 'new', prompt: 'Change it', agentMessage: 'Changed' });
  assert.strictEqual(sdk.count('pushArtifact'), 1);
  assert.strictEqual(sdk.count('publishArtifact'), 1);
  assert.match(out.warnings.join('\n'), /ENOSPC.*had been written/s);

  const unreadable = seeded().script('push', { lose: full }).script('fetch', undefined, new Error('the read timed out'));
  await assert.rejects(backend(unreadable).update(ID, { source: 'new' }), (e) => e.outcome === 'unknown' && e.pageId === ID && /MAY HAVE LANDED/.test(e.message));
});

test('update: a lost answer whose read FAILS, or finds the page deleted, is refused with nothing sent again', async () => {
  const failed = seeded().script('push', { lose: reset() }).script('fetch', undefined, new Error('the read timed out'));
  await assert.rejects(backend(failed).update(ID, { source: 'new' }), (e) => e.outcome === 'unknown' && /MAY HAVE LANDED/.test(e.message) && /the read timed out/.test(e.message));
  assert.strictEqual(failed.count('pushArtifact'), 1);

  const gone = seeded().script('push', { lose: reset() }).script('fetch', undefined, (s, type, id) => { s.pages.delete(id); });
  await assert.rejects(backend(gone).update(ID, { source: 'new' }), (e) => e.outcome === 'unknown' && /it was deleted/.test(e.message));
  assert.strictEqual(gone.count('pushArtifact'), 1);
});

test('update: after an unknown outcome the standalone upload is told to run genpage-base.js check (with the file as ONE safe argument); the build is told to run again', async () => {
  const standalone = seeded().script('push', { drop: reset() }, { drop: reset() });
  await assert.rejects(backend(standalone).update(ID, { source: 'new', appId: APP, sourceFile: 'pages/overview.tsx', caller: 'upload' }), (e) => {
    assert.match(e.message, new RegExp(`node scripts/genpage-base\\.js check --env ${ENV.replace(/\./g, '\\.')} --app-id ${APP} --page-id ${ID} --file pages/overview\\.tsx`));
    assert.match(e.message, /"contentSame": true means the update landed/);
    return true;
  });

  // A file name no shell can be given literally is a placeholder, named as data — never pasted into a command.
  const hostile = seeded().script('push', { drop: reset() }, { drop: reset() });
  await assert.rejects(backend(hostile).update(ID, { source: 'new', appId: APP, sourceFile: 'a"b.tsx' }), (e) => {
    assert.match(e.message, /--file <file>/);
    assert.ok(!/--file a"b/.test(e.message));
    assert.match(e.message, /<file> is "a\\"b\.tsx"/);
    return true;
  });

  const build = seeded().script('push', { drop: reset() }, { drop: reset() });
  await assert.rejects(backend(build).update(ID, { source: 'new', caller: 'build' }), (e) => {
    assert.match(e.message, /Run the build again/);
    assert.ok(!/genpage-base\.js check/.test(e.message), 'the build keeps no base marker');
    return true;
  });
});

test('update: a publish that fails after a successful write is RETURNED with the page id, not thrown', async () => {
  const sdk = seeded().script('publish', new Error('PublishXml answered 500'));
  const out = await backend(sdk).update(ID, { source: 'new' });
  assert.strictEqual(out.pageId, ID);
  assert.strictEqual(out.publish.kind, 'failed');
  assert.strictEqual(sdk.pages.get(ID).source, 'new', 'the write stands');
});

test('every page write the backend can fail is marked transient:false, on the error itself', async () => {
  const failures = [];
  const createRefused = new FakeSdk(); createRefused.createError = sdkError('VALIDATION_ERROR', 'no');
  failures.push(backend(createRefused).create({ name: 'P', source: 'x' }));
  failures.push(backend(new FakeSdk().script('push', { drop: reset() }, { drop: reset() })).create({ name: 'P', source: 'x' }));
  failures.push(backend(new FakeSdk()).update(ID, { source: 'x' }));
  failures.push(backend(seeded().script('push', { drop: reset() }, { drop: reset() })).update(ID, { source: 'new' }));
  failures.push(backend(seeded().script('push', { drop: connectionError(400, 'no') })).update(ID, { source: 'new' }));
  for (const result of await Promise.allSettled(failures)) {
    assert.strictEqual(result.status, 'rejected');
    assert.strictEqual(result.reason.transient, false, `${result.reason.message}`);
  }
});

// The build has a retry of its own for a halt it judges transient (isTransientHalt, build-model-app.js), and a retry of a page write is a second send: a create
// would mint a second page beside one that landed, an update could record its turn twice. The text of these errors quotes the page's name — user text, so a page
// called "SQL Timeouts" reads as a SQL timeout — and the SDK's own words ("try again later", a 503). `transient: false` is what that check reads, on the error and
// on the halt that wraps it; the words alone DO read as transient (the control), so it is the marker that is tested.
test('no error a page write raises is one the build retries — whatever the page is called, whatever the service said', async () => {
  const { isTransientHalt } = require('../build-model-app.js');
  const { BuildHalt } = require('../lib/entity-provision.js');
  const TRY_AGAIN = connectionError(503, 'The service is unavailable. Please try again later.');
  let controls = 0;
  for (const pageName of ['SQL Timeouts', 'Concurrent Deletes', 'Overview']) {
    const scenarios = [
      ['create: sent twice, no usable answer', () => backend(new FakeSdk().script('push', { drop: TRY_AGAIN }, { drop: TRY_AGAIN })).create({ name: pageName, source: 'x' })],
      ['create: unknown outcome, the read fails', () => backend(new FakeSdk().script('push', { lose: TRY_AGAIN }).script('fetch', TRY_AGAIN)).create({ name: pageName, source: 'x' })],
      ['create: a 4xx', () => backend(new FakeSdk().script('push', { drop: connectionError(429, 'Too many requests, try again later') })).create({ name: pageName, source: 'x' })],
      ['create: refused before writing', async () => { const sdk = new FakeSdk(); sdk.createError = sdkError('VALIDATION_ERROR', 'SQL timeout while resolving the data source'); return backend(sdk).create({ name: pageName, source: 'x' }); }],
      ['update: overtaken', () => backend(seeded({ name: pageName }).script('push', { drop: TRY_AGAIN }).script('fetch', undefined, (s, t, id) => { s.pages.get(id).source = 'theirs'; })).update(ID, { source: 'new' })],
      ['update: sent twice, no usable answer', () => backend(seeded({ name: pageName }).script('push', { drop: TRY_AGAIN }, { drop: TRY_AGAIN })).update(ID, { source: 'new' })],
      ['update: read fails after an unknown outcome', () => backend(seeded({ name: pageName }).script('push', { lose: TRY_AGAIN }).script('fetch', undefined, TRY_AGAIN)).update(ID, { source: 'new' })],
      ['update: the push is refused', () => backend(seeded({ name: pageName }).script('push', { drop: connectionError(403, 'Forbidden — try again later') })).update(ID, { source: 'new' })],
    ];
    for (const [what, run] of scenarios) {
      const label = `${what}, page "${pageName}"`;
      const error = await run().then(() => null, (e) => e);
      assert.ok(error, label);
      assert.strictEqual(error.transient, false, `${label}: marked`);
      assert.strictEqual(isTransientHalt(error), false, `${label}: bare`);
      assert.strictEqual(isTransientHalt(new BuildHalt(`pages failed: ${error.message}`, { phase: 'pages', code: 'sdk-error', cause: error })), false, `${label}: as the runner wraps it`);
      if (isTransientHalt(new Error(error.message))) controls += 1;
    }
  }
  assert.ok(controls >= 10, `the marker is what stops the retry: without it ${controls} of these would read as transient`);
});
