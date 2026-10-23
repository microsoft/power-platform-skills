'use strict';
// The files the plugin writes hold no access token the process obtained: the build's journal and status, a download's files, the baseline and the records beside it, and the SDK's workspace. Every writer of text that a service's
// words can reach goes through lib/output-redaction.js — `writeFileSafe` and `appendFileSafe` (lib/safe-fs.js), `writeFileAtomic` (lib/apply-snapshot-store.js) and the workspace storage the SDK factory wraps — and this file holds
// each of them, and LISTS every other write in the plugin with the reason none of them can carry a token, so a new writer fails here until someone has decided which it is.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const bundle = require('../vendor/cds-maker-sdk.cjs');
const { createMakerSdk } = require('../lib/maker-sdk.js');
const { createAzHttpClient } = require('../lib/sdk-http-client.js');
const { writeFileSafe, appendFileSafe } = require('../lib/safe-fs.js');
const { writeFileAtomic } = require('../lib/apply-snapshot-store.js');
const { noteToken } = require('../lib/output-redaction.js');
const ai = require('../lib/artifact-intent.js');
const { createHarness, seedForm, NOTES_CLASS_ID } = require('./helpers/form-store-harness.js');
const { scriptsMatching, productionScripts, scriptLabel, withoutComments } = require('./helpers/production-scripts.js');
const { TOKEN, PARTS, SECRETS, FOLDED } = require('./helpers/synthetic-token.js');
const { leaksIn } = require('./helpers/token-leaks.js');
const { makeTempDir } = require('./helpers/temp-dirs.js');

const MARK = '<token>';
// A process that has obtained a token: this is what the first read from the Azure CLI, or the first request a client sends, does.
noteToken(TOKEN);

const FOLDED_JSON = (extra = {}) => JSON.stringify({ message: `Rejected bearer ${FOLDED}`, [TOKEN]: 'as a key', nested: { list: [`bearer ${TOKEN}`] }, ...extra });

// ── The writers ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('lib/safe-fs.js writes a text with the token taken out of it — replaced, created exclusively, appended — and JSON that was written is still JSON; what holds none is written as it is, and bytes are bytes', () => {
  const dir = makeTempDir('safe-fs-tokens-');
  const replaced = writeFileSafe(path.join(dir, 'result.json'), `${FOLDED_JSON()}\n`);
  assert.deepStrictEqual(leaksIn(fs.readFileSync(replaced, 'utf8'), SECRETS), []);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(replaced, 'utf8')), { message: `Rejected bearer ${MARK}`, [MARK]: 'as a key', nested: { list: [`bearer ${MARK}`] } });
  writeFileSafe(path.join(dir, 'result.json'), `${FOLDED_JSON({ again: true })}\n`, { encoding: 'utf8' });
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'result.json'), 'utf8')).again, true, 'a file is replaced as it was');
  writeFileSafe(path.join(dir, 'settings.json'), `${FOLDED_JSON()}\n`, { exclusive: true, encoding: 'utf8' });
  assert.deepStrictEqual(leaksIn(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'), SECRETS), [], 'an exclusive write too');
  appendFileSafe(path.join(dir, 'build-log.jsonl'), `${FOLDED_JSON({ line: 1 })}\n`);
  appendFileSafe(path.join(dir, 'build-log.jsonl'), `${JSON.stringify({ line: 2, note: 'nothing secret here' })}\n`);
  const lines = fs.readFileSync(path.join(dir, 'build-log.jsonl'), 'utf8').split('\n').filter(Boolean);
  assert.deepStrictEqual(leaksIn(lines.join('\n'), SECRETS), []);
  assert.deepStrictEqual(lines.map((line) => JSON.parse(line).line), [1, 2], 'every line is JSON still');
  writeFileSafe(path.join(dir, 'plain.txt'), 'No secret here, only text.\r\nA second line.\r\n');
  assert.strictEqual(fs.readFileSync(path.join(dir, 'plain.txt'), 'utf8'), 'No secret here, only text.\r\nA second line.\r\n', 'a text that holds no token is written as it is');
  const bytes = Buffer.from([0x00, 0xff, 0x10, 0x80]);
  writeFileSafe(path.join(dir, 'bytes.bin'), bytes);
  assert.deepStrictEqual(fs.readFileSync(path.join(dir, 'bytes.bin')), bytes, 'bytes are written as they are');
});

test('lib/apply-snapshot-store.js writes the snapshot, the baseline and the records beside them with the token taken out, and JSON that was written is still JSON', () => {
  const dir = makeTempDir('snapshot-tokens-');
  writeFileAtomic(path.join(dir, 'last-applied.json'), FOLDED_JSON({ app: { uniqueName: 'contoso_app' } }));
  const written = fs.readFileSync(path.join(dir, 'last-applied.json'), 'utf8');
  assert.deepStrictEqual(leaksIn(written, SECRETS), []);
  assert.strictEqual(JSON.parse(written).app.uniqueName, 'contoso_app');
  writeFileAtomic(path.join(dir, 'clean.json'), '{"a":1}');
  assert.strictEqual(fs.readFileSync(path.join(dir, 'clean.json'), 'utf8'), '{"a":1}');
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['clean.json', 'last-applied.json'], 'no temporary file is left');
  assert.deepStrictEqual(scriptsMatching(/\bwriteFileAtomic\s*\(/), ['lib/apply-snapshot-store.js', 'lib/dashboard-creation-records.js', 'lib/deployed-baseline.js', 'lib/page-ownership-records.js', 'lib/page-publish-records.js', 'lib/web-resource-records.js'], 'the baseline and the records are written by it, and by nothing else');
  const { openUnconfirmedWebResources, unconfirmedRecordPath } = require('../lib/web-resource-records.js');
  const environment = 'https://contoso.crm.dynamics.com';
  const record = openUnconfirmedWebResources({ workspaceDir: dir, environment });
  const id = '11111111-aaaa-4aaa-8aaa-111111111111';
  assert.strictEqual(record.note('contoso_/clean.js', id), true);
  assert.strictEqual(record.note(`contoso_/${TOKEN}.js`, id), true);
  const recovery = fs.readFileSync(unconfirmedRecordPath(dir, environment), 'utf8');
  assert.deepStrictEqual(leaksIn(recovery, SECRETS), [], 'the new recovery record goes through the same redacting writer');
  assert.strictEqual(JSON.parse(recovery).webResources['contoso_/clean.js'], id, 'ordinary resource identities are unchanged');
  // A dashboard's name is the maker's text, so the record of the dashboards a build created goes through the same writer.
  const { openDashboardCreations, dashboardCreationRecordPath } = require('../lib/dashboard-creation-records.js');
  const created = openDashboardCreations({ workspaceDir: dir, environment, appUniqueName: 'contoso_app', solutionUniqueName: 'ContosoSolution' });
  assert.strictEqual(created.note('Clean Overview', id), true);
  assert.strictEqual(created.note(`Rejected bearer ${TOKEN}`, id), true);
  const dashboards = fs.readFileSync(dashboardCreationRecordPath(dir, environment, 'contoso_app', 'ContosoSolution'), 'utf8');
  assert.deepStrictEqual(leaksIn(dashboards, SECRETS), [], 'the dashboard creation record goes through the same redacting writer');
  assert.strictEqual(JSON.parse(dashboards).dashboards['Clean Overview'].id, id, 'ordinary dashboard names are unchanged');
});

// ── Bytes given to a file writer ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const STARS = (secret) => '*'.repeat(secret.length);
// A text of even length (a Uint16Array is two bytes an element) with the token in it, and what a file must hold of it.
const BYTES_TEXT = `bearer ${TOKEN} end`;
const BYTES_MASKED = `bearer ${STARS(TOKEN)} end`;
// `text` as bytes inside a larger allocation of its own: six `#` stand before it and after it, which no view below covers.
function allocationOf(text) {
  const bytes = Buffer.from(text);
  const buffer = new ArrayBuffer(bytes.length + 12);
  new Uint8Array(buffer).fill(0x23);
  new Uint8Array(buffer).set(bytes, 6);
  return { buffer, offset: 6, length: bytes.length };
}
// Every kind of view Node's file writers write as raw bytes, each covering the text in the middle of its allocation.
const VIEWS = {
  Buffer: ({ buffer, offset, length }) => Buffer.from(buffer, offset, length),
  Uint8Array: ({ buffer, offset, length }) => new Uint8Array(buffer, offset, length),
  Uint16Array: ({ buffer, offset, length }) => new Uint16Array(buffer, offset, length / 2),
  DataView: ({ buffer, offset, length }) => new DataView(buffer, offset, length),
};
// The three writers, each into a file of its own in `dir`.
const WRITERS = {
  writeFileSafe: (file, data, opts) => writeFileSafe(file, data, opts),
  'writeFileSafe exclusive': (file, data, opts) => writeFileSafe(file, data, { ...opts, exclusive: true }),
  appendFileSafe: (file, data, opts) => appendFileSafe(file, data, opts),
  writeFileAtomic: (file, data) => writeFileAtomic(file, data),
};

test('BYTES given to a file writer — a Buffer, a Uint8Array, a Uint16Array, a DataView, each a view inside a larger allocation — are written without the token: masked with as many `*`, the file as long as the view, the bytes around the view and the caller\'s memory as they were; through every writer', () => {
  const dir = makeTempDir('file-bytes-tokens-');
  const failures = [];
  for (const [kind, view] of Object.entries(VIEWS)) {
    for (const [writer, write] of Object.entries(WRITERS)) {
      const allocation = allocationOf(BYTES_TEXT);
      const before = Buffer.from(allocation.buffer).toString('latin1');
      const data = view(allocation);
      const file = path.join(dir, `${kind}-${writer.replace(/\W/g, '-')}.bin`);
      write(file, data);
      const written = fs.readFileSync(file);
      if (written.toString('latin1') !== BYTES_MASKED) failures.push(`${kind} through ${writer}: ${written.toString('latin1').slice(0, 60)}`);
      if (written.length !== data.byteLength) failures.push(`${kind} through ${writer}: ${written.length} bytes for a view of ${data.byteLength}`);
      if (Buffer.from(allocation.buffer).toString('latin1') !== before) failures.push(`${kind} through ${writer}: the caller's memory was written into`);
    }
  }
  assert.deepStrictEqual(failures, []);
  // A view from another realm (a vm context, a worker's allocation) is a view all the same.
  const { redactFileData } = require('../lib/output-redaction.js');
  const foreign = vm.runInNewContext(`new Uint8Array(${JSON.stringify([...Buffer.from(BYTES_TEXT)])})`);
  assert.strictEqual(Buffer.from(redactFileData(foreign)).toString('latin1'), BYTES_MASKED);
  const foreignClean = vm.runInNewContext('new Uint8Array([1, 2, 3])');
  assert.strictEqual(redactFileData(foreignClean), foreignClean, 'with no token: the very object');
});

test('a string a file writer DECODES — `hex`, `base64`, `base64url` — is written as its bytes without the token, the encoding left out of the masked write; one with no token is written as it was; a text in `utf8` or `latin1` is a text', () => {
  const dir = makeTempDir('file-encoded-tokens-');
  writeFileSafe(path.join(dir, 'hex.bin'), Buffer.from(`bearer ${TOKEN}`).toString('hex'), { encoding: 'hex' });
  assert.strictEqual(fs.readFileSync(path.join(dir, 'hex.bin'), 'latin1'), `bearer ${STARS(TOKEN)}`);
  appendFileSafe(path.join(dir, 'part.bin'), Buffer.from(`part ${PARTS[1]} end`).toString('base64'), { encoding: 'base64' });
  assert.strictEqual(fs.readFileSync(path.join(dir, 'part.bin'), 'latin1'), `part ${STARS(PARTS[1])} end`);
  writeFileSafe(path.join(dir, 'url.bin'), Buffer.from(`x ${TOKEN} y`).toString('base64url'), { encoding: 'BASE64URL', exclusive: true });
  assert.strictEqual(fs.readFileSync(path.join(dir, 'url.bin'), 'latin1'), `x ${STARS(TOKEN)} y`);
  // The masked bytes are handed over without the encoding, which the file system would apply to them a second time.
  const recorder = recordingFs();
  writeFileSafe(path.join(dir, 'recorded.bin'), Buffer.from(`bearer ${TOKEN}`).toString('hex'), { encoding: 'hex', fs: recorder.fs });
  const [handed] = recorder.calls.filter(([name]) => name === 'writeFileSync');
  assert.ok(Buffer.isBuffer(handed[2]) && handed.length === 3, 'bytes, and no encoding with them');
  // No token: the very string and encoding reach the file system, and the file is what an unguarded write makes.
  const clean = Buffer.from('no token in these bytes \x00\xff').toString('base64');
  writeFileSafe(path.join(dir, 'clean.bin'), clean, { encoding: 'base64' });
  fs.writeFileSync(path.join(dir, 'clean-unguarded.bin'), clean, { encoding: 'base64' });
  assert.deepStrictEqual(fs.readFileSync(path.join(dir, 'clean.bin')), fs.readFileSync(path.join(dir, 'clean-unguarded.bin')));
  writeFileSafe(path.join(dir, 'text.txt'), `bearer ${TOKEN}`, { encoding: 'latin1' });
  assert.strictEqual(fs.readFileSync(path.join(dir, 'text.txt'), 'latin1'), `bearer ${MARK}`, 'a text in another text encoding is cleaned as a text');
});

test('what does not move for bytes: bytes with no token are the very object and the same file, an empty view is written as it was, two appends are two lines, and a raw ArrayBuffer — no view — is refused by Node as it always was', () => {
  const { redactFileData } = require('../lib/output-redaction.js');
  const dir = makeTempDir('file-bytes-neighbours-');
  const plain = Buffer.from('bytes with no token');
  assert.strictEqual(redactFileData(plain), plain);
  const allocation = allocationOf('a DataView with no token in it.');
  const view = new DataView(allocation.buffer, allocation.offset, allocation.length);
  assert.strictEqual(redactFileData(view), view);
  writeFileSafe(path.join(dir, 'view.bin'), view);
  fs.writeFileSync(path.join(dir, 'view-unguarded.bin'), view);
  assert.deepStrictEqual(fs.readFileSync(path.join(dir, 'view.bin')), fs.readFileSync(path.join(dir, 'view-unguarded.bin')));
  const empty = new Uint8Array(0);
  assert.strictEqual(redactFileData(empty), empty);
  writeFileSafe(path.join(dir, 'empty.bin'), empty);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'empty.bin')).length, 0);
  appendFileSafe(path.join(dir, 'log.jsonl'), Buffer.from(`${JSON.stringify({ line: 1, error: `bearer ${TOKEN}` })}\n`));
  appendFileSafe(path.join(dir, 'log.jsonl'), Buffer.from(`${JSON.stringify({ line: 2 })}\n`));
  const lines = fs.readFileSync(path.join(dir, 'log.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.deepStrictEqual(lines, [{ line: 1, error: `bearer ${STARS(TOKEN)}` }, { line: 2 }], 'both lines, the first masked');
  const raw = new ArrayBuffer(4);
  assert.strictEqual(redactFileData(raw), raw, 'a raw ArrayBuffer is no view: passed on');
  assert.throws(() => appendFileSafe(path.join(dir, 'raw.bin'), raw), (error) => error.code === 'ERR_INVALID_ARG_TYPE');
  assert.ok(!fs.existsSync(path.join(dir, 'raw.bin')));
  // A piece shorter than 24 characters, in one call, is no token: each call is read alone, as a text is.
  const short = Buffer.from(`the start ${TOKEN.slice(0, 23)}`);
  assert.strictEqual(redactFileData(short), short);
  assert.strictEqual(redactFileData(TOKEN.slice(0, 23)), TOKEN.slice(0, 23));
  appendFileSafe(path.join(dir, 'short.txt'), short);
  appendFileSafe(path.join(dir, 'short.txt'), Buffer.from(TOKEN.slice(23, 40)));
  assert.strictEqual(fs.readFileSync(path.join(dir, 'short.txt'), 'latin1'), `the start ${TOKEN.slice(0, 40)}`, 'the residual: a token split between two appends, each piece shorter than 24');
});

// A file system that writes as the real one does and records every call that is given data: what the writers handed it.
function recordingFs() {
  const calls = [];
  const record = (name) => (...args) => { calls.push([name, ...args]); return fs[name](...args); };
  return { calls, fs: { ...fs, writeFileSync: record('writeFileSync'), appendFileSync: record('appendFileSync'), openSync: record('openSync'), linkSync: record('linkSync'), renameSync: record('renameSync') } };
}

test('data that cannot be checked is NOT written: a view whose bytes cannot be read (detached), and a string whose decoding fails, throw before anything is opened — the target as it was, no temporary file, nothing handed to the file system — and the error does not hold the data', () => {
  const { redactFileData } = require('../lib/output-redaction.js');
  const dir = makeTempDir('file-unchecked-');
  const target = path.join(dir, 'target.bin');
  fs.writeFileSync(target, 'as it was');
  const detached = () => {
    const view = new Uint8Array(Buffer.from(BYTES_TEXT));
    structuredClone(view.buffer, { transfer: [view.buffer] });
    return view;
  };
  for (const [writer, write] of Object.entries({ writeFileSafe, appendFileSafe })) {
    const recorder = recordingFs();
    assert.throws(() => write(target, detached(), { fs: recorder.fs }), (error) => error instanceof TypeError && /could not be checked/.test(error.message) && !error.message.includes(TOKEN), writer);
    assert.deepStrictEqual(recorder.calls, [], `${writer}: nothing reached the file system`);
  }
  assert.throws(() => writeFileAtomic(target, detached()), /could not be checked/);
  assert.strictEqual(fs.readFileSync(target, 'utf8'), 'as it was');
  assert.deepStrictEqual(fs.readdirSync(dir), ['target.bin'], 'no temporary file is left');
  // A decoding that fails once: the file system would take the original string and decode it itself — it is never given it.
  const encoded = Buffer.from(`bearer ${TOKEN}`).toString('hex');
  const realFrom = Buffer.from;
  for (const [writer, write] of Object.entries({ writeFileSafe, appendFileSafe })) {
    let failOnce = true;
    Buffer.from = function from(value, ...rest) {
      if (failOnce && value === encoded && rest[0] === 'hex') {
        failOnce = false;
        throw new RangeError('a decoding that fails');
      }
      return realFrom.call(this, value, ...rest);
    };
    const recorder = recordingFs();
    let thrown = null;
    try {
      write(target, encoded, { encoding: 'hex', fs: recorder.fs });
    } catch (error) {
      thrown = error;
    } finally {
      Buffer.from = realFrom;
    }
    assert.strictEqual(failOnce, false, `${writer}: the decoding was tried`);
    assert.deepStrictEqual(recorder.calls.filter((call) => call.includes(encoded)), [], `${writer}: a write was given the string unchecked`);
    assert.ok(thrown !== null && /could not be checked/.test(thrown.message) && !thrown.message.includes(encoded), `${writer}: ${thrown && thrown.message}`);
    assert.deepStrictEqual(recorder.calls, [], `${writer}: nothing reached the file system`);
  }
  assert.strictEqual(fs.readFileSync(target, 'utf8'), 'as it was');
  assert.deepStrictEqual(fs.readdirSync(dir), ['target.bin']);
  // Read with no fault, the same string is checked and masked.
  assert.strictEqual(redactFileData(encoded, { encoding: 'hex' }).toString('latin1'), `bearer ${STARS(TOKEN)}`);
});

test('an append that writes part of its chunk and fails: the part it wrote is of the chunk as cleaned, the error is the file system\'s, and nothing is appended again or removed', () => {
  const dir = makeTempDir('file-append-partial-');
  const target = path.join(dir, 'build-log.jsonl');
  fs.writeFileSync(target, '{"line":0}\n');
  const failure = Object.assign(new Error('the disk is full'), { code: 'ENOSPC' });
  const calls = [];
  const partial = { ...fs, appendFileSync(file, data, ...rest) { calls.push(['appendFileSync', file]); fs.appendFileSync(file, data.subarray(0, 40), ...rest); throw failure; }, unlinkSync(...args) { calls.push(['unlinkSync', ...args]); return fs.unlinkSync(...args); }, renameSync(...args) { calls.push(['renameSync', ...args]); return fs.renameSync(...args); } };
  assert.throws(() => appendFileSafe(target, Buffer.from(`{"line":1,"error":"${TOKEN}"}\n`), { fs: partial }), (error) => error === failure);
  assert.deepStrictEqual(calls, [['appendFileSync', target]], 'one append, no retry, no delete');
  const text = fs.readFileSync(target, 'latin1');
  assert.strictEqual(text, `{"line":0}\n${`{"line":1,"error":"${STARS(TOKEN)}"}\n`.slice(0, 40)}`, 'the part written is the masked chunk\'s');
});

test('a process that has obtained NO token writes every kind of data exactly as Node does: the very argument reaches the file system — an ordinary view, an empty one, a detached one, a string to decode', () => {
  const dir = makeTempDir('file-no-token-');
  const run = spawnSync(process.execPath, ['-e', `
    const fs = require('node:fs');
    const path = require('node:path');
    const { redactFileData } = require('./lib/output-redaction.js');
    const { writeFileSafe } = require('./lib/safe-fs.js');
    const dir = ${JSON.stringify(dir)};
    const detached = new Uint8Array([1, 2, 3]);
    structuredClone(detached.buffer, { transfer: [detached.buffer] });
    const cases = {
      view: [new DataView(Buffer.from('bearer ${TOKEN}').buffer, 0, 10)],
      empty: [new Uint8Array(0)],
      detached: [detached],
      encoded: [Buffer.from('bearer ${TOKEN}').toString('hex'), { encoding: 'hex' }],
    };
    const outcome = (write) => { try { write(); return 'written'; } catch (error) { return 'error ' + (error.code || error.name); } };
    const result = {};
    for (const [name, [data, opts]] of Object.entries(cases)) {
      const same = redactFileData(data, opts) === data;
      const guarded = outcome(() => writeFileSafe(path.join(dir, name + '.guarded'), data, opts));
      const unguarded = outcome(() => fs.writeFileSync(path.join(dir, name + '.unguarded'), data, opts));
      const bytes = (file) => (fs.existsSync(file) ? fs.readFileSync(file).toString('hex') : null);
      result[name] = { same, guarded, unguarded, equal: bytes(path.join(dir, name + '.guarded')) === bytes(path.join(dir, name + '.unguarded')) };
    }
    fs.writeSync(1, JSON.stringify(result));
  `], { cwd: path.resolve(__dirname, '..'), env: { ...process.env, POWER_PLATFORM_SKILLS_TELEMETRY_MODEL_APPS_OPTOUT: '1' }, encoding: 'utf8' });
  assert.strictEqual(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout);
  for (const [name, outcome] of Object.entries(result)) {
    assert.deepStrictEqual(outcome, { same: true, guarded: 'written', unguarded: 'written', equal: true }, name);
  }
});

// A form whose labels hold the token — as a label a maker typed could, or an answer that echoes a header — read by the SDK, which writes the form, its metadata and the manifest into the workspace: the SDK factory's storage keeps
// the token out of every one of those files, and the SDK as the bundle ships it does not.
test('REAL BUNDLE: a success answer that repeats the token — a form whose labels hold it — reaches no file of the SDK\'s workspace made by the factory; the bundle\'s own storage writes it', async () => {
  const withToken = (formxml) => formxml
    .replace('<label description="Main" languagecode="1033" />', `<label description="Rejected bearer ${TOKEN}" languagecode="1033" />`)
    .replace('<label description="Main" languagecode="1033" />', `<label description="${FOLDED.replace(/\r\n/g, ' ')}" languagecode="1033" />`);
  const filesUnder = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? filesUnder(path.join(dir, entry.name)) : [path.join(dir, entry.name)]));
  const read = async (makeSdk) => {
    const h = createHarness({ createSdk: makeSdk });
    try {
      const spec = {
        entities: [{ schemaName: 'new_ticket', displayName: 'Ticket', primaryAttribute: { schemaName: 'new_name', displayName: 'Name' }, columns: [] }],
        forms: [{ entity: 'new_ticket', name: 'Main', tabs: [{ name: 'tab_main', label: 'Main', sections: [{ name: 'sec_main', label: 'Main', columns: 1, fields: ['new_name'] }] }] }],
      };
      await seedForm(h, ai.compileFormIntent(spec, spec.forms[0], { notesClassId: NOTES_CLASS_ID }).tabs);
      h.store.row = { ...h.store.row, formxml: withToken(h.store.row.formxml) };
      const dir = makeTempDir('sdk-workspace-tokens-');
      const { sdk } = await h.freshSdk(dir);
      await sdk.fetchArtifact('form', h.formId);
      return filesUnder(dir).map((file) => [path.relative(dir, file), fs.readFileSync(file, 'utf8')]);
    } finally {
      h.cleanup();
    }
  };
  // The factory, over the production client (which sends the token, so the process has obtained it) — and the bundle's own factory over the same.
  const overProductionClient = (create) => (options) => create({ ...options, httpClient: createAzHttpClient(options.instanceUrl, { getToken: () => TOKEN, request: async ({ method, url, headers, body }) => {
    const verb = method.toLowerCase();
    const res = method === 'GET' || method === 'DELETE' ? await options.httpClient[verb](url, { headers }) : await options.httpClient[verb](url, typeof body === 'string' ? JSON.parse(body) : body, { headers });
    return { statusCode: res.status, headers: res.headers || {}, body: typeof res.body === 'string' ? res.body : JSON.stringify(res.body ?? null) };
  } }) });
  const control = await read(overProductionClient(bundle.createMakerSdk));
  assert.ok(control.some(([, text]) => leaksIn(text, SECRETS).length > 0), 'the control: the bundle\'s own storage writes the token into the workspace — so the scenario is the exposure');
  const guarded = await read(overProductionClient(createMakerSdk));
  assert.ok(guarded.length >= 3, 'the form, its metadata and the manifest are written');
  for (const [name, text] of guarded) {
    assert.deepStrictEqual(leaksIn(text, SECRETS), [], `${name} holds the token`);
    assert.doesNotThrow(() => JSON.parse(text), `${name} is still JSON`);
  }
  assert.ok(guarded.some(([, text]) => text.includes(MARK)), 'and the marker stands where the token was');
});

// ── Every other write in the plugin ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

// A call that writes or copies a file's content: `fs.writeFileSync`, `fsx.writeFileSync(fd, …)`, `fs.promises.writeFile`, `appendFileSync`, `createWriteStream`, `writeSync`, `copyFileSync`, `cpSync`.
const WRITES = /\.(?:writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream|writeSync|copyFileSync|copyFile|cpSync)\s*\(/;

// The writers that clean what they write first, and what makes each one so.
const GUARDED_WRITERS = {
  'lib/safe-fs.js': /redactFileData\(data, opts\)/,
  'lib/apply-snapshot-store.js': /fs\.writeFileSync\(fd, redactFileData\(text\)\)/,
};

// The writers that are not guarded, and why none of them can write a token: each writes what the plugin made itself, or what a person gave it, never a word of a service's, or runs in a process that obtains no token.
const OTHER_WRITERS = {
  'solution-settings.js': 'its template goes through `writeFileSafe(… leaving(text))` and both streams through its own `guardOutput`; the copy of the settings and the package it hands pac are data for another program, never altered',
  'lib/private-folder.js': 'the copy of the settings file the person gave, made private for pac: their own bytes',
  'lib/temp-workspace.js': 'the owner record of a temporary folder: a process id, a host and a time',
  'lib/telemetry/lib/emit-dispatcher.js': 'telemetry events, in a hook process that obtains no token, limited to the approved fields',
  'lib/telemetry/lib/local-log.js': 'the local mirror of those events',
  'lib/telemetry/lib/user-config.js': 'the telemetry choice a person made',
  'lib/telemetry/region/region-cache.js': 'a cached region name',
  'capture-fixture.js': 'a developer tool that copies test fixtures; it reads nothing from a service',
  'generate-page-manifest.js': 'writes the manifest of a page from its own source; it reads nothing from a service',
  'genpage-worker-output.js': 'a sidecar of the page worker\'s own file path and state; it reads nothing from a service',
  'promote-intent-pages.js': 'writes the spec the agent gave back with pages added from its intent; it calls no service',
  'regenerate-verified-icons.js': 'a developer tool that regenerates a list of icon names',
  'smoke-eval.js': 'a developer tool that writes a spec for an eval',
  'write-page-plan.js': 'writes the plan the agent gave; it calls no service',
};
// Every one of those that runs in a process that could hold a token is checked to call nothing that obtains one.
const TOKEN_CALLS = /\b(?:getAuthToken|getAuthTokenAsync|getPowerAppsToken|getPowerAppsTokenAsync|dataverseRequest|preflightAuth|createMakerSdk|createAzHttpClient|makeGenpageSdk|sdkFirst)\b/;

test('every write of file content in the plugin is a guarded writer or one of a listed few that cannot carry a token — a new writer fails here until it is one or the other', () => {
  const found = scriptsMatching(WRITES);
  assert.deepStrictEqual(found, [...Object.keys(GUARDED_WRITERS), ...Object.keys(OTHER_WRITERS)].sort(), 'a writer was added or removed: say which kind it is');
  for (const [label, evidence] of Object.entries(GUARDED_WRITERS)) {
    const file = productionScripts().find((candidate) => scriptLabel(candidate) === label);
    assert.match(withoutComments(fs.readFileSync(file, 'utf8')), evidence, `${label} cleans the text it writes`);
  }
  // The listed writers that hand data on unaltered stay so: the settings a person gave and the package handed to pac are not masked.
  for (const label of ['solution-settings.js', 'lib/private-folder.js']) {
    const file = productionScripts().find((candidate) => scriptLabel(candidate) === label);
    assert.doesNotMatch(withoutComments(fs.readFileSync(file, 'utf8')), /redactFileData/, `${label} writes its data as it is`);
  }
  for (const label of ['capture-fixture.js', 'generate-page-manifest.js', 'genpage-worker-output.js', 'promote-intent-pages.js', 'regenerate-verified-icons.js', 'smoke-eval.js', 'write-page-plan.js', 'lib/temp-workspace.js', 'lib/private-folder.js']) {
    const file = productionScripts().find((candidate) => scriptLabel(candidate) === label);
    assert.doesNotMatch(withoutComments(fs.readFileSync(file, 'utf8')), TOKEN_CALLS, `${label} calls nothing that obtains a token`);
  }
});

test('the plugin writes to its descriptors only through the streams a script prints on — the one raw write is guarded by its own, and no child inherits them in a script that obtains a token', () => {
  assert.deepStrictEqual(scriptsMatching(/\bwriteSync\(\s*[12]\b/), ['solution-settings.js'], 'its note at the end of a run goes through its own `leaving`');
  assert.deepStrictEqual(scriptsMatching(/\.pipe\(\s*process\.std(?:out|err)|process\.std(?:out|err)\.(?:_|fd\b)|\.writeSync\(\s*process\.std/), [], 'nothing is piped to a stream, and none is written below `write`');
  // A child that inherits the streams writes to them without passing through this process: these are developer tools and the test runner, which obtain no token.
  assert.deepStrictEqual(scriptsMatching(/stdio\s*:\s*(?:'inherit'|"inherit"|\[[^\]]*['"]inherit['"])/), ['launch-playwright-mcp.js', 'regenerate-verified-icons.js', 'run-tests.js']);
  for (const label of ['launch-playwright-mcp.js', 'regenerate-verified-icons.js', 'run-tests.js']) {
    const file = productionScripts().find((candidate) => scriptLabel(candidate) === label);
    assert.doesNotMatch(withoutComments(fs.readFileSync(file, 'utf8')), TOKEN_CALLS, `${label} obtains no token`);
  }
});

test('every place a token is read from the Azure CLI or sent to a service notes it: both reads of the Azure CLI and the two senders', () => {
  const notes = (label) => withoutComments(fs.readFileSync(productionScripts().find((file) => scriptLabel(file) === label), 'utf8')).match(/noteToken\(/g) || [];
  assert.strictEqual(notes('lib/dataverse-auth.js').length, 3, 'the synchronous and the asynchronous read of the Azure CLI, and the loop of dataverseRequest');
  assert.strictEqual(notes('lib/sdk-http-client.js').length, 1, 'the SDK\'s HTTP client, before each request');
  assert.deepStrictEqual(scriptsMatching(/account['"],\s*['"]get-access-token/), ['lib/dataverse-auth.js'], 'and the Azure CLI is asked for a token in one place');
});

test('emitResult cleans the text it prints, where the stream\'s write has been replaced — a host that runs a script in its own process, a test that captures it', () => {
  const { emitResult } = require('../lib/dataverse-auth.js');
  const printed = { stdout: [], stderr: [] };
  const ended = { code: null };
  const real = { exit: process.exit, stdout: process.stdout.write, stderr: process.stderr.write };
  process.exit = (code) => { ended.code = code; throw ended; };
  process.stdout.write = (chunk) => { printed.stdout.push(String(chunk)); return true; };
  process.stderr.write = (chunk) => { printed.stderr.push(String(chunk)); return true; };
  const codes = [];
  try {
    for (const [ok, payload, options] of [
      [true, { message: `Rejected bearer ${FOLDED}`, [TOKEN]: 'key', list: [TOKEN] }],
      [true, { accent: 'é', message: `bearer ${TOKEN}` }, { ascii: true }],
      [false, new Error(`push failed: Rejected bearer ${FOLDED}`)],
      [false, { ok: false, error: `Rejected bearer ${TOKEN}`, detail: FOLDED }],
      [false, { ok: false, errors: [`bearer ${TOKEN}`] }],
      [false, `plain text ${TOKEN}`],
    ]) {
      try { emitResult(ok, payload, options); } catch (thrown) { if (thrown !== ended) throw thrown; }
      codes.push(ended.code);
    }
  } finally {
    process.exit = real.exit;
    process.stdout.write = real.stdout;
    process.stderr.write = real.stderr;
  }
  assert.deepStrictEqual(codes, [0, 0, 1, 1, 1, 1]);
  assert.deepStrictEqual(leaksIn(printed.stdout.join(''), SECRETS), []);
  assert.deepStrictEqual(leaksIn(printed.stderr.join(''), SECRETS), []);
  assert.deepStrictEqual(JSON.parse(printed.stdout[0]), { message: `Rejected bearer ${MARK}`, [MARK]: 'key', list: [MARK] }, 'the result is JSON still, and says what it said');
  assert.strictEqual(printed.stdout[1], `{"accent":"\\u00e9","message":"bearer ${MARK}"}\n`);
  assert.strictEqual(printed.stderr[0], `push failed: Rejected bearer ${MARK}\n`);
  assert.ok(printed.stderr.some((line) => line === `Rejected bearer ${MARK}\n`) && printed.stderr.some((line) => line === `plain text ${MARK}\n`));
});
