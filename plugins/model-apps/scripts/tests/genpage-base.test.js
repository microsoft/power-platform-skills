'use strict';
// #673 — a page kept in source control and a page edited in the maker portal must not silently
// overwrite each other. The marker is the base the upload compares against. pac download writes a
// BOM and a final CRLF (measured); those must not look like a divergence, and a planted link at
// the marker name must not be trusted or followed.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  normalizePageText,
  pageHash,
  markerPath,
  readMarker,
  writeMarker,
  deleteMarker,
  compareWithMarker,
  lineDelta,
  deployedCopyPath,
} = require('../lib/genpage-base.js');

const dirs = [];
test.after(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});
function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gpbase-'));
  dirs.push(d);
  return d;
}
function tryLink(target, link, type) {
  try {
    fs.symlinkSync(target, link, type);
    return null;
  } catch (e) {
    if (e && e.code === 'EPERM') return e;
    throw e;
  }
}

const PAGE = 'export default function Page() {\n  return <div>Hello</div>;\n}\n';
const PAGE_ID = '9F1B2C3D-4E5F-4A6B-8C9D-0E1F2A3B4C5D';
const APP_ID = 'AAAAAAAA-1111-4111-8111-AAAAAAAAAAAA';

test('normalize strips a leading BOM, CRLF and CR, and trailing blank lines, and keeps internal whitespace', () => {
  assert.strictEqual(normalizePageText('\uFEFFhello\r\nworld\r\n'), 'hello\nworld');
  assert.strictEqual(normalizePageText('hello\rworld'), 'hello\nworld');
  assert.strictEqual(normalizePageText('hello\nworld\n\n  \n'), 'hello\nworld');
  assert.strictEqual(normalizePageText('hello\nworld  \n'), 'hello\nworld  ');
  assert.strictEqual(normalizePageText('hello\n  \nworld'), 'hello\n  \nworld');
  assert.strictEqual(normalizePageText('hel\uFEFFlo'), 'hel\uFEFFlo');
  assert.strictEqual(normalizePageText('\uFEFF'), '');
  assert.strictEqual(normalizePageText(''), '');
});

test('pageHash is stable across pac download noise and changes when content changes', () => {
  const downloaded = `\uFEFF${PAGE.replace(/\n/g, '\r\n')}\r\n`;
  assert.strictEqual(pageHash(downloaded), pageHash(PAGE));
  assert.strictEqual(pageHash(PAGE + '\n\n'), pageHash(PAGE));
  assert.notStrictEqual(pageHash(PAGE.replace('Hello', 'Hi')), pageHash(PAGE));
  assert.match(pageHash(PAGE), /^[0-9a-f]{64}$/);
});

test('markerPath and deployedCopyPath are siblings of the code file', () => {
  const file = path.join('work', 'page.tsx');
  assert.strictEqual(markerPath(file), path.join('work', '.page.tsx.genpage-base.json'));
  assert.strictEqual(deployedCopyPath(file), path.join('work', 'page.tsx.deployed.tsx'));
});

test('a marker round-trips, lowercases ids, and a corrupt, foreign, or non-plain marker reads as absent', (t) => {
  const d = tmp();
  const code = path.join(d, 'page.tsx');
  fs.writeFileSync(code, PAGE);
  const marker = {
    version: 1,
    pageId: PAGE_ID,
    appId: APP_ID,
    deployedSha256: pageHash(PAGE),
    localSha256: pageHash('local'),
    recordedAt: '2026-10-01T00:00:00.000Z',
    source: 'download',
  };
  writeMarker(code, marker);
  const read = readMarker(code);
  assert.strictEqual(read.pageId, PAGE_ID.toLowerCase());
  assert.strictEqual(read.appId, APP_ID.toLowerCase());
  assert.strictEqual(read.deployedSha256, marker.deployedSha256);
  assert.strictEqual(read.localSha256, marker.localSha256);
  assert.strictEqual(read.source, 'download');
  assert.strictEqual(read.version, 1);
  assert.strictEqual(fs.existsSync(markerPath(code)), true);

  fs.writeFileSync(markerPath(code), '{', 'utf8');
  assert.strictEqual(readMarker(code), null);
  fs.writeFileSync(markerPath(code), JSON.stringify({ ...marker, version: 2 }), 'utf8');
  assert.strictEqual(readMarker(code), null);
  fs.writeFileSync(markerPath(code), JSON.stringify({ version: 1 }), 'utf8');
  assert.strictEqual(readMarker(code), null);
  fs.rmSync(markerPath(code));
  assert.strictEqual(readMarker(code), null);

  fs.mkdirSync(markerPath(code));
  assert.strictEqual(readMarker(code), null, 'a directory at the marker name is not a base');
  fs.rmSync(markerPath(code), { recursive: true });

  const outside = path.join(d, 'outside.json');
  fs.writeFileSync(outside, JSON.stringify(marker));
  const link = markerPath(code);
  const denied = tryLink(outside, link, 'file');
  if (denied) {
    t.diagnostic('file symlinks need an extra privilege on this host (EPERM); skipped that sub-case');
  } else {
    assert.strictEqual(readMarker(code), null, 'a symlinked marker is not trusted');
    fs.unlinkSync(link);
  }

  writeMarker(code, marker);
  const hard = path.join(d, 'hard.json');
  fs.linkSync(markerPath(code), hard);
  assert.strictEqual(readMarker(code), null, 'a hard-linked marker is not a file this tool owns');
  fs.unlinkSync(hard);
  assert.ok(readMarker(code), 'removing the other name leaves a plain marker readable');
});

test('writeMarker refuses a link or a non-regular target and does not follow it', (t) => {
  const d = tmp();
  const code = path.join(d, 'page.tsx');
  fs.writeFileSync(code, PAGE);
  const marker = {
    version: 1,
    pageId: PAGE_ID,
    appId: APP_ID,
    deployedSha256: pageHash(PAGE),
    localSha256: pageHash(PAGE),
    source: 'upload',
  };
  const outside = path.join(d, 'outside.json');
  fs.writeFileSync(outside, 'secret');
  const denied = tryLink(outside, markerPath(code), 'file');
  if (denied) {
    t.diagnostic('file symlinks need an extra privilege on this host (EPERM); skipped that sub-case');
  } else {
    assert.throws(() => writeMarker(code, marker), /symbolic link or junction/);
    assert.strictEqual(fs.readFileSync(outside, 'utf8'), 'secret');
    fs.unlinkSync(markerPath(code));
  }
  fs.mkdirSync(markerPath(code));
  assert.throws(() => writeMarker(code, marker), /not a regular file|junction|symbolic link/);
  fs.rmSync(markerPath(code), { recursive: true });
  assert.throws(() => writeMarker(code, { ...marker, source: 'nope' }), /source/);
  assert.strictEqual(fs.existsSync(markerPath(code)), false);
});

test('deleteMarker removes a plain marker, ignores a missing one, and refuses a link', (t) => {
  const d = tmp();
  const code = path.join(d, 'page.tsx');
  fs.writeFileSync(code, PAGE);
  deleteMarker(code);
  writeMarker(code, {
    version: 1, pageId: 'p', appId: 'a',
    deployedSha256: pageHash('x'), localSha256: pageHash('y'), source: 'upload-unverified',
  });
  deleteMarker(code);
  assert.strictEqual(fs.existsSync(markerPath(code)), false);

  const outside = path.join(d, 'keep.txt');
  fs.writeFileSync(outside, 'keep');
  const denied = tryLink(outside, markerPath(code), 'file');
  if (denied) {
    t.diagnostic('file symlinks need an extra privilege on this host (EPERM); skipped that sub-case');
    return;
  }
  assert.throws(() => deleteMarker(code), /symbolic link or junction/);
  assert.strictEqual(fs.readFileSync(outside, 'utf8'), 'keep');
});

test('compareWithMarker distinguishes absent, other-page, and hash drift', () => {
  const deployed = pageHash('deployed');
  const local = pageHash('local');
  const marker = {
    version: 1,
    pageId: PAGE_ID.toLowerCase(),
    appId: APP_ID.toLowerCase(),
    deployedSha256: deployed,
    localSha256: local,
    source: 'download',
  };
  const cases = [
    [null, { pageId: PAGE_ID, appId: APP_ID, deployedText: 'deployed', localText: 'local' },
      { marker: 'absent', deployed: 'unknown', local: 'no-base' }],
    [marker, { pageId: 'other', appId: APP_ID, deployedText: 'deployed', localText: 'local' },
      { marker: 'other-page', deployed: 'unknown', local: 'no-base' }],
    [marker, { pageId: PAGE_ID, appId: 'other-app', deployedText: 'deployed', localText: 'local' },
      { marker: 'other-page', deployed: 'unknown', local: 'no-base' }],
    [marker, { pageId: PAGE_ID, appId: APP_ID, deployedText: 'deployed', localText: 'local' },
      { marker: 'present', deployed: 'unchanged', local: 'unchanged' }],
    [marker, { pageId: PAGE_ID, appId: APP_ID, deployedText: 'deployed\r\n', localText: '\uFEFFlocal' },
      { marker: 'present', deployed: 'unchanged', local: 'unchanged' }],
    [marker, { pageId: PAGE_ID, appId: APP_ID, deployedText: 'other', localText: 'local' },
      { marker: 'present', deployed: 'changed', local: 'unchanged' }],
    [marker, { pageId: PAGE_ID, appId: APP_ID, deployedText: 'deployed', localText: 'edited' },
      { marker: 'present', deployed: 'unchanged', local: 'changed' }],
    [marker, { pageId: PAGE_ID, appId: APP_ID, localText: 'local' },
      { marker: 'present', deployed: 'unknown', local: 'unchanged' }],
    [marker, { pageId: PAGE_ID, appId: APP_ID, deployedText: 'deployed' },
      { marker: 'present', deployed: 'unchanged', local: 'no-base' }],
  ];
  for (const [m, input, expected] of cases) {
    assert.deepStrictEqual(compareWithMarker(m, input), expected, JSON.stringify(input));
  }
});

test('a marker may carry no app — the page was created before any app held it — while a value that IS present must be a usable id', () => {
  const d = tmp();
  const code = path.join(d, 'page.tsx');
  fs.writeFileSync(code, PAGE);
  const base = { version: 1, pageId: PAGE_ID, deployedSha256: pageHash(PAGE), localSha256: pageHash(PAGE), source: 'upload' };
  const body = writeMarker(code, base);
  assert.ok(!('appId' in body), 'no key at all, rather than an empty one a reader would have to tell from a bad value');
  assert.ok(!('appId' in JSON.parse(fs.readFileSync(markerPath(code), 'utf8'))));
  const read = readMarker(code);
  assert.strictEqual(read.pageId, PAGE_ID.toLowerCase());
  assert.ok(!('appId' in read));
  assert.strictEqual(read.source, 'upload');

  assert.ok(!('appId' in writeMarker(code, { ...base, appId: '' })), 'an empty app is no app');
  assert.ok(!('appId' in writeMarker(code, { ...base, appId: null })));
  assert.strictEqual(writeMarker(code, { ...base, appId: APP_ID }).appId, APP_ID.toLowerCase());

  // The reader: absent or null is a page no app held; anything else must be a usable id, or the marker is no base.
  for (const [value, usable] of [[undefined, true], [null, true], ['', false], ['   ', false], [42, false], [{}, false], [APP_ID, true]]) {
    const raw = { ...base, recordedAt: '2026-10-01T00:00:00.000Z' };
    if (value !== undefined) raw.appId = value;
    fs.writeFileSync(markerPath(code), JSON.stringify(raw), 'utf8');
    assert.strictEqual(readMarker(code) !== null, usable, `appId ${JSON.stringify(value)}`);
  }
  assert.throws(() => writeMarker(code, { ...base, pageId: '  ' }), /pageId is required/);
});

test('compareWithMarker: a marker with no app is for the page alone — any app may ask — while a marker recorded with an app still refuses another app, and any marker refuses another page', () => {
  const deployed = pageHash('deployed');
  const local = pageHash('local');
  const noApp = { version: 1, pageId: PAGE_ID.toLowerCase(), deployedSha256: deployed, localSha256: local, source: 'upload' };
  const withApp = { ...noApp, appId: APP_ID.toLowerCase() };
  const input = (over) => ({ pageId: PAGE_ID, appId: APP_ID, deployedText: 'deployed', localText: 'local', ...over });
  const present = { marker: 'present', deployed: 'unchanged', local: 'unchanged' };
  assert.deepStrictEqual(compareWithMarker(noApp, input()), present, 'the app the page was placed in');
  assert.deepStrictEqual(compareWithMarker(noApp, input({ appId: 'any-other-app' })), present);
  assert.deepStrictEqual(compareWithMarker(noApp, input({ appId: undefined })), present);
  assert.deepStrictEqual(compareWithMarker(noApp, input({ pageId: 'other' })), { marker: 'other-page', deployed: 'unknown', local: 'no-base' });
  assert.deepStrictEqual(compareWithMarker(withApp, input()), present);
  assert.deepStrictEqual(compareWithMarker(withApp, input({ appId: 'any-other-app' })), { marker: 'other-page', deployed: 'unknown', local: 'no-base' });
  assert.deepStrictEqual(compareWithMarker(noApp, input({ deployedText: 'changed meanwhile' })), { marker: 'present', deployed: 'changed', local: 'unchanged' }, 'a marker with no app still catches a deployed page that changed');
});

test('lineDelta counts multiset line differences and ignores pac download noise', () => {
  assert.deepStrictEqual(lineDelta('a\nb\nb\n', 'a\nb\nc\n'), { added: 1, removed: 1 });
  assert.deepStrictEqual(lineDelta('a\na\n', 'a\n'), { added: 0, removed: 1 });
  assert.deepStrictEqual(lineDelta('\uFEFFa\r\nb\r\n', 'a\nb'), { added: 0, removed: 0 });
  assert.deepStrictEqual(lineDelta('', 'a\nb'), { added: 2, removed: 0 });
});

function loadCli() {
  return require('../genpage-base.js');
}

function runCli(argv, deps) {
  const { main } = loadCli();
  return new Promise((resolve, reject) => {
    Promise.resolve(main(argv, {
      ...deps,
      emit: (ok, payload) => resolve({ ok, payload }),
    })).catch(reject);
  });
}

test('record writes a marker from the file, and --deployed-sha256 binds the observed deployed hash', async () => {
  const d = tmp();
  const file = path.join(d, 'page.tsx');
  fs.writeFileSync(file, PAGE);
  const plain = await runCli(['record', '--app-id', APP_ID, '--page-id', PAGE_ID, '--file', file]);
  assert.strictEqual(plain.ok, true, JSON.stringify(plain.payload));
  assert.strictEqual(plain.payload.deployedSha256, pageHash(PAGE));
  assert.strictEqual(plain.payload.localSha256, pageHash(PAGE));
  assert.strictEqual(plain.payload.source, 'download');
  assert.strictEqual(readMarker(file).pageId, PAGE_ID.toLowerCase());

  const observed = pageHash('deployed-by-pac');
  const bound = await runCli(['record', '--app-id', APP_ID, '--page-id', PAGE_ID, '--file', file, '--deployed-sha256', observed]);
  assert.strictEqual(bound.ok, true, JSON.stringify(bound.payload));
  const marker = readMarker(file);
  assert.strictEqual(marker.deployedSha256, observed, 'the chosen local base is bound to the hash check observed');
  assert.strictEqual(marker.localSha256, pageHash(PAGE));
  assert.notStrictEqual(marker.deployedSha256, marker.localSha256);

  const bad = await runCli(['record', '--app-id', APP_ID, '--page-id', PAGE_ID, '--file', file, '--deployed-sha256', 'not-a-hash']);
  assert.strictEqual(bad.ok, false);
  assert.match(bad.payload.error, /deployed-sha256/);
  assert.strictEqual(readMarker(file).deployedSha256, observed, 'a rejected hash must not replace the marker');
});

// A stand-in for the page backend (lib/genpage-sdk.js): what `check` needs of it is `read(pageId)` and `dispose()`.
function fakeBackend(answer) {
  const backend = {
    reads: [],
    disposed: 0,
    read: async (pageId) => {
      backend.reads.push(pageId);
      if (answer instanceof Error) throw answer;
      return { source: answer };
    },
    dispose: () => { backend.disposed += 1; },
  };
  return backend;
}

test('check returns the observed hash, writes a deployed copy only when the files differ, and disposes the backend before emitting', async () => {
  const d = tmp();
  const file = path.join(d, 'local.tsx');
  fs.writeFileSync(file, 'export const n = 1;\n');
  const differing = fakeBackend('export const n = 2;\n');
  let seenEnv;
  const r = await runCli(
    ['check', '--env', 'https://contoso.crm.dynamics.com/', '--app-id', APP_ID, '--page-id', PAGE_ID, '--file', file],
    { makeGenpageSdk: (env) => { seenEnv = env; return differing; } },
  );
  assert.strictEqual(r.ok, true, JSON.stringify(r.payload));
  assert.strictEqual(seenEnv, 'https://contoso.crm.dynamics.com/');
  assert.deepStrictEqual(differing.reads, [PAGE_ID], 'the deployed page is read by its id');
  assert.strictEqual(r.payload.deployedSha256, pageHash('export const n = 2;\n'));
  assert.strictEqual(r.payload.contentSame, false);
  assert.strictEqual(r.payload.marker, 'absent');
  assert.ok(r.payload.lines.added >= 1 || r.payload.lines.removed >= 1);
  assert.strictEqual(fs.readFileSync(r.payload.deployedCopy, 'utf8'), 'export const n = 2;\n', 'the copy is the page as it is stored, for the user to diff');
  assert.strictEqual(differing.disposed, 1);

  // A file that IS the deployed page (a BOM and a final CRLF are not a difference): no copy is written, and the backend is gone
  // by the time the result is emitted — the real emitter ends the process, so a cleanup placed after it would never run.
  fs.writeFileSync(file, '\uFEFFexport const n = 2;\r\n\r\n');
  const identical = fakeBackend('export const n = 2;\n');
  let disposedAtEmit = 'not-called';
  const { main } = loadCli();
  const direct = await main(
    ['check', '--env', 'https://contoso.crm.dynamics.com/', '--app-id', APP_ID, '--page-id', PAGE_ID, '--file', file],
    {
      makeGenpageSdk: () => identical,
      emit: (ok, payload) => {
        disposedAtEmit = identical.disposed;
        return { ok, payload };
      },
    },
  );
  assert.strictEqual(disposedAtEmit, 1, 'emit must see the backend already disposed — emitResult calls process.exit');
  assert.strictEqual(direct.ok, true);
  assert.strictEqual(direct.payload.contentSame, true, JSON.stringify(direct.payload));
  assert.strictEqual(direct.payload.deployedCopy, undefined);
});

test('check: a page that cannot be read — missing, unreadable, or held as raw files with no source — is deployed-unreadable, with the reason, and the backend is still disposed', async () => {
  const d = tmp();
  const file = path.join(d, 'local.tsx');
  fs.writeFileSync(file, 'export const n = 1;\n');
  for (const failure of [
    Object.assign(new Error(`page ${PAGE_ID} does not exist in this environment`), { code: 'GENPAGE_NOT_FOUND' }),
    Object.assign(new Error(`page ${PAGE_ID} ("Hand made") has no source this tool can read`), { code: 'GENPAGE_NO_SOURCE' }),
    new Error('Transport failure reaching the environment'),
  ]) {
    const backend = fakeBackend(failure);
    const r = await runCli(
      ['check', '--env', 'https://contoso.crm.dynamics.com/', '--app-id', APP_ID, '--page-id', PAGE_ID, '--file', file],
      { makeGenpageSdk: () => backend },
    );
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.payload.code, 'deployed-unreadable');
    assert.ok(r.payload.error.includes(failure.message), r.payload.error);
    assert.strictEqual(r.payload.deployedSha256, null);
    assert.strictEqual(r.payload.contentSame, false, 'an unreadable page is never reported as the same');
    assert.strictEqual(backend.disposed, 1);
  }
  const refused = await runCli(['check', '--env', 'https://contoso.crm.dynamics.com/', '--app-id', APP_ID, '--page-id', PAGE_ID, '--file', path.join(d, 'missing.tsx')],
    { makeGenpageSdk: () => { throw new Error('the backend is not made when the local file cannot be read'); } });
  assert.strictEqual(refused.ok, false);
  assert.match(refused.payload.error, /could not read/);
});

test('check: the marker an app-less create wrote is found by the app the page was placed in, and says nothing about the page\'s content until it is compared', async () => {
  const d = tmp();
  const file = path.join(d, 'local.tsx');
  fs.writeFileSync(file, PAGE);
  writeMarker(file, { version: 1, pageId: PAGE_ID, deployedSha256: pageHash(PAGE), localSha256: pageHash(PAGE), source: 'upload' });
  const r = await runCli(
    ['check', '--env', 'https://contoso.crm.dynamics.com/', '--app-id', APP_ID, '--page-id', PAGE_ID, '--file', file],
    { makeGenpageSdk: () => fakeBackend(PAGE) },
  );
  assert.strictEqual(r.ok, true, JSON.stringify(r.payload));
  assert.strictEqual(r.payload.marker, 'present');
  assert.strictEqual(r.payload.deployed, 'unchanged');
  assert.strictEqual(r.payload.contentSame, true);
});
