'use strict';
// scripts/genpage.js prepare-compiler-refresh: the command line of an explicit compiler refresh of one page (lib/compiler-refresh.js). It reads the page once, prints the
// reviewed change — one comment line appended to the local source — and writes the proposed source only to --output-file, never to the page. Every refusal is one JSON line
// with its code and `outcome: "nothing"`. The helper itself is tested over the real bundle in compiler-refresh.test.js; this is what the SCRIPT does with it.
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { main, parseCommand, VERBS } = require('../genpage.js');
const { fakeGenpage } = require('./helpers/fake-genpage.js');
const { COMPILER_REFRESH_MARKER } = require('../lib/compiler-refresh.js');
const { sha256 } = require('../lib/hash.js');

const ENV = 'https://contoso.crm.dynamics.com';
const P1 = '11111111-0000-4000-8000-000000000001';
const SOURCE = 'export default function Page() {\n  return <div>Inventory</div>;\n}\n';
const VERB = 'prepare-compiler-refresh';

const roots = [];
function scratch(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `genpage-refresh-${label}-`));
  roots.push(dir);
  return dir;
}
after(() => { for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true }); });

function localFile(text, dir = scratch('src')) {
  const file = path.join(dir, 'page.tsx');
  fs.writeFileSync(file, text, 'utf8');
  return file;
}

async function run(argv, genpage = fakeGenpage({ pages: [{ pageId: P1, name: 'Inventory', source: SOURCE, dataSources: ['account'] }] })) {
  const seen = { emitted: [], usage: [], envs: [], stderr: [] };
  await main(argv, {
    makeGenpageSdk: (env) => { seen.envs.push(env); return genpage; },
    emit: (ok, payload) => { seen.emitted.push({ ok, payload }); },
    usageError: (message, verb) => { seen.usage.push({ message, verb }); },
    stderr: (text) => { seen.stderr.push(text); },
  });
  seen.genpage = genpage;
  return seen;
}
const only = (seen) => { assert.strictEqual(seen.emitted.length, 1, 'exactly one result is emitted'); return seen.emitted[0]; };
const callsOf = (genpage) => genpage.calls.map((c) => c.method || c[0] || c.name);

test('prepare-compiler-refresh is a verb of the script, with the flags the contract gives it — none that writes the page', () => {
  assert.ok(Object.prototype.hasOwnProperty.call(VERBS, VERB), 'the verb exists');
  assert.deepStrictEqual(VERBS[VERB].known, ['env', 'page-id', 'file', 'expected-base-sha256', 'output-file']);
  assert.deepStrictEqual(VERBS[VERB].required, ['env', 'page-id', 'file']);
  assert.deepStrictEqual(VERBS[VERB].switches || [], []);
  const hash = 'A'.repeat(64);
  assert.deepStrictEqual(parseCommand([VERB, '--env', ENV, '--page-id', P1.toUpperCase(), '--file', 'page.tsx', '--expected-base-sha256', hash, '--output-file', 'out.tsx']), {
    verb: VERB, env: ENV, args: { pageId: P1, file: 'page.tsx', expectedBaseSha256: hash.toLowerCase(), outputFile: 'out.tsx' },
  });
  assert.deepStrictEqual(parseCommand([VERB, '--env', ENV, '--page-id', P1, '--file', 'page.tsx']).args, { pageId: P1, file: 'page.tsx' });
});

test('prepare-compiler-refresh: a mistake in the command line is a usage error, before any backend is made', async () => {
  const lines = [
    [[VERB, '--env', ENV, '--file', 'page.tsx'], /--page-id is required/],
    [[VERB, '--env', ENV, '--page-id', P1], /--file is required/],
    [[VERB, '--page-id', P1, '--file', 'page.tsx'], /--env is required/],
    [[VERB, '--env', ENV, '--page-id', 'nope', '--file', 'page.tsx'], /--page-id 'nope' is not an id/],
    [[VERB, '--env', ENV, '--page-id', P1, '--file', 'page.tsx', '--expected-base-sha256', 'abc'], /--expected-base-sha256 'abc' is not a SHA-256 hash: expected 64 hexadecimal characters/],
    [[VERB, '--env', ENV, '--page-id', P1, '--file', 'page.tsx', '--output-file'], /--output-file requires a value/],
    [[VERB, '--env', ENV, '--page-id', P1, '--file', 'page.tsx', '--draft'], /unknown flag\(s\): --draft/],
    [[VERB, '--env', ENV, '--page-id', P1, '--file', 'page.tsx', '--output-file', path.join('.', 'page.tsx')], /--output-file names the --file itself/],
    [[VERB, '--env', ENV, '--page-id', P1, '--file', 'page.tsx', '--receipt', 'r.json'], /unknown flag\(s\): --receipt/],
  ];
  for (const [argv, message] of lines) {
    const seen = await run(argv);
    assert.strictEqual(seen.usage.length, 1, argv.join(' '));
    assert.match(seen.usage[0].message, message, argv.join(' '));
    assert.strictEqual(seen.usage[0].verb, VERB);
    assert.deepStrictEqual([seen.emitted.length, seen.envs.length, seen.genpage.calls.length], [0, 0, 0], `${argv.join(' ')}: nothing was made, asked or emitted`);
  }
});

test('prepare-compiler-refresh: the change is printed — one marker line appended, the hashes and the diff — the page is only read, and nothing is written without --output-file', async () => {
  const file = localFile(SOURCE);
  const seen = await run([VERB, '--env', ENV, '--page-id', P1, '--file', file]);
  const { ok, payload } = only(seen);
  assert.strictEqual(ok, true, JSON.stringify(payload));
  const proposed = `${SOURCE}${COMPILER_REFRESH_MARKER}\n`;
  assert.deepStrictEqual(payload, {
    ok: true,
    pageId: P1,
    action: 'refresh',
    marker: COMPILER_REFRESH_MARKER,
    baseSha256: sha256(SOURCE),
    proposedSha256: sha256(proposed),
    diff: payload.diff,
    proposedSource: proposed,
    writes: 0,
  });
  assert.match(payload.diff, new RegExp(`\\n\\+${COMPILER_REFRESH_MARKER.replace(/[/]/g, '\\/')}$`));
  assert.deepStrictEqual(callsOf(seen.genpage).filter((name) => name !== 'dispose'), ['read'], 'the page is read once, and nothing else is asked');
  assert.strictEqual(seen.genpage.pages.get(P1).source, SOURCE, 'the page holds what it held');
  assert.strictEqual(fs.readFileSync(file, 'utf8'), SOURCE, 'the local source is not rewritten');
});

test('prepare-compiler-refresh --output-file: the proposed source is written there, and only there — the page and the local source are left as they were', async () => {
  const dir = scratch('out');
  const file = localFile(SOURCE);
  const out = path.join(dir, 'nested', 'page.proposed.tsx');
  const seen = await run([VERB, '--env', ENV, '--page-id', P1, '--file', file, '--expected-base-sha256', sha256(SOURCE), '--output-file', out]);
  const { ok, payload } = only(seen);
  assert.strictEqual(ok, true, JSON.stringify(payload));
  assert.strictEqual(payload.outputFile, fs.realpathSync.native(out));
  assert.strictEqual(fs.readFileSync(out, 'utf8'), `${SOURCE}${COMPILER_REFRESH_MARKER}\n`);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), SOURCE);
  assert.strictEqual(seen.genpage.pages.get(P1).source, SOURCE);
});

test('prepare-compiler-refresh: an output name that is a folder is refused before the environment is asked', async () => {
  const dir = scratch('outdir');
  const seen = await run([VERB, '--env', ENV, '--page-id', P1, '--file', localFile(SOURCE), '--output-file', dir]);
  const { ok, payload } = only(seen);
  assert.strictEqual(ok, false);
  assert.deepStrictEqual(callsOf(seen.genpage).filter((name) => name !== 'dispose'), [], JSON.stringify(payload));
});

// Another name of the reviewed source. A lexical compare of the two paths misses every one of these: a different case on a case-insensitive volume, a Windows 8.3 short name,
// a folder link (a junction on Windows, a symbolic link elsewhere) to the source's folder, a hard link, and a --file that is itself a link to the output. Each is refused
// before the environment is asked, and the reviewed source keeps its bytes. A name the platform cannot make here (a case-sensitive volume, short names turned off, no right to
// make a link) skips that one case, saying why.
function aliasOf(kind, file) {
  const dir = path.dirname(file);
  if (kind === 'case') {
    const upper = path.join(dir, path.basename(file).toUpperCase());
    return fs.existsSync(upper) ? { output: upper } : { skip: 'this volume is case-sensitive' };
  }
  if (kind === 'short') {
    if (process.platform !== 'win32') return { skip: '8.3 short names are a Windows file name' };
    const short = path.join(dir, 'REVIEW~1.TSX');
    const same = fs.existsSync(short) && fs.statSync(short, { bigint: true }).ino === fs.statSync(file, { bigint: true }).ino;
    return same ? { output: short } : { skip: 'this volume makes no 8.3 short names' };
  }
  if (kind === 'folder-link') {
    const link = path.join(scratch('link'), 'linked');
    try { fs.symlinkSync(dir, link, process.platform === 'win32' ? 'junction' : 'dir'); } catch (error) { return { skip: `no folder link could be made (${error.code})` }; }
    return { output: path.join(link, path.basename(file)) };
  }
  if (kind === 'hard-link') {
    const other = path.join(scratch('hard'), 'proposed.tsx');
    try { fs.linkSync(file, other); } catch (error) { return { skip: `no hard link could be made (${error.code})` }; }
    return { output: other };
  }
  // 'input-link': --file is a symbolic link whose target is the output name.
  const link = path.join(scratch('inlink'), 'reviewed-link.tsx');
  try { fs.symlinkSync(file, link, 'file'); } catch (error) { return { skip: `no file link could be made (${error.code})` }; }
  return { input: link, output: file };
}

for (const kind of ['case', 'short', 'folder-link', 'hard-link', 'input-link']) {
  test(`prepare-compiler-refresh: an --output-file that is another name of the reviewed --file (${kind}) is refused before the environment is asked, and the source keeps its bytes`, async (t) => {
    const file = localFile(SOURCE, scratch('alias'));
    const renamed = path.join(path.dirname(file), 'reviewedsource.tsx');
    fs.renameSync(file, renamed);
    const alias = aliasOf(kind, renamed);
    if (alias.skip) { t.skip(alias.skip); return; }
    const seen = await run([VERB, '--env', ENV, '--page-id', P1, '--file', alias.input || renamed, '--output-file', alias.output]);
    // A write through a short name can replace the long name too, so a source that is gone is the same failure as one overwritten.
    assert.strictEqual(fs.existsSync(renamed) ? fs.readFileSync(renamed, 'utf8') : '<gone>', SOURCE, 'the reviewed source must not be overwritten through another of its names');
    const { ok, payload } = only(seen);
    assert.strictEqual(ok, false, JSON.stringify(payload));
    assert.strictEqual(payload.code, 'UNSAFE_OUTPUT', payload.error);
    assert.match(payload.error, /same file as --file/);
    assert.strictEqual(payload.outcome, 'nothing');
    assert.strictEqual(payload.pageId, P1);
    assert.deepStrictEqual(callsOf(seen.genpage).filter((name) => name !== 'dispose'), [], 'the environment is not asked');
  });
}

test('prepare-compiler-refresh: a distinct output beside the reviewed source — even one already there from an earlier run — is written, and the source keeps its bytes', async () => {
  const file = localFile(SOURCE, scratch('beside'));
  const out = path.join(path.dirname(file), 'page.proposed.tsx');
  fs.writeFileSync(out, 'an earlier proposal\n', 'utf8');
  const seen = await run([VERB, '--env', ENV, '--page-id', P1, '--file', file, '--output-file', out]);
  const { ok, payload } = only(seen);
  assert.strictEqual(ok, true, JSON.stringify(payload));
  assert.strictEqual(fs.readFileSync(out, 'utf8'), `${SOURCE}${COMPILER_REFRESH_MARKER}\n`);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), SOURCE);
});

// One refusal per code family: each is exit 1 (ok false), its code, `outcome: "nothing"`, and no file written.
const REFUSALS = [
  ['a local file that cannot be read', { local: null }, 'COMPILER_REFRESH_SOURCE_UNREADABLE', []],
  ['a page that is not there', { pages: [] }, 'COMPILER_REFRESH_SOURCE_UNREADABLE', ['read']],
  ['a page held as raw files', { pages: [{ pageId: P1, name: 'Inventory', raw: true }] }, 'COMPILER_REFRESH_SOURCE_UNREADABLE', ['read']],
  ['a local source that is not the deployed one', { local: `${SOURCE}// my edit\n` }, 'COMPILER_REFRESH_BASE_MISMATCH', ['read']],
  ['a base that moved since the review', { expected: 'b'.repeat(64) }, 'COMPILER_REFRESH_BASE_MISMATCH', ['read']],
  ['a source that does not parse', { source: 'export default function Page() { return <div>; }\n' }, 'COMPILER_REFRESH_PARSE_FAILED', ['read']],
  ['a source that already carries the marker, with no receipt', { source: `${SOURCE}${COMPILER_REFRESH_MARKER}\n` }, 'COMPILER_REFRESH_MARKER_UNPROVEN', ['read']],
];
for (const [label, setup, code, calls] of REFUSALS) {
  test(`prepare-compiler-refresh refuses ${label}: ${code}, outcome "nothing", nothing written`, async () => {
    const source = setup.source || SOURCE;
    const pages = setup.pages || [{ pageId: P1, name: 'Inventory', source, dataSources: ['account'] }];
    const dir = scratch('refuse');
    const file = setup.local === null ? path.join(dir, 'missing.tsx') : localFile(setup.local || source, dir);
    const out = path.join(dir, 'proposed.tsx');
    const argv = [VERB, '--env', ENV, '--page-id', P1, '--file', file, '--output-file', out, ...(setup.expected ? ['--expected-base-sha256', setup.expected] : [])];
    const seen = await run(argv, fakeGenpage({ pages }));
    const { ok, payload } = only(seen);
    assert.strictEqual(ok, false, JSON.stringify(payload));
    assert.strictEqual(payload.code, code, payload.error);
    assert.strictEqual(payload.outcome, 'nothing');
    assert.strictEqual(payload.pageId, P1);
    assert.deepStrictEqual(callsOf(seen.genpage).filter((name) => name !== 'dispose'), calls);
    assert.strictEqual(fs.existsSync(out), false, 'no proposed source is written');
    if (code === 'COMPILER_REFRESH_BASE_MISMATCH') assert.match(String(payload.baseSha256), /^[0-9a-f]{64}$/, 'the deployed hash is said');
  });
}
