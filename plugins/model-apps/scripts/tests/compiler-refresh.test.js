'use strict';
// The explicit compiler refresh (lib/compiler-refresh.js): one reviewed comment line appended to a page's source, written by the ordinary update, so the SDK
// compiles the page again with its current iteration profile. Through the REAL vendored SDK bundle over the stateful fake of the page tables
// (helpers/fake-genpage-server.js). The legacy page is seeded the way such a page was made: its compiled row is the vendored compiler's output under the
// 'legacy' profile (no `downlevelIteration`, see iteration-emit.test.js), for a source that iterates a Map and a Set.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { makeGenpageSdk } = require('../lib/genpage-sdk.js');
const { prepareCompilerRefresh, readCompilerRefreshReceipt, COMPILER_REFRESH_MARKER } = require('../lib/compiler-refresh.js');
const { loadVendoredTypeScript } = require('../lib/typescript-compiler.js');
const { sha256 } = require('../lib/hash.js');
const { FakeGenPageServer, INSTANCE, ACCOUNT_TABLE } = require('./helpers/fake-genpage-server.js');

const PAGE = 'c0000000-0000-4000-8000-0000000000c1';
const SIBLING = 'c0000000-0000-4000-8000-0000000000c2';
const SOURCE = [
  "import * as React from 'react';",
  'const counts = new Map([["a", 1], ["b", 2]]);',
  'export default function Page() {',
  '  const rows = [];',
  '  for (const [key, value] of counts) rows.push(<li key={key}>{key}: {value}</li>);',
  '  const unique = [...new Set(["x", "y", "x"])];',
  '  return <ul>{rows}{unique.join(",")}</ul>;',
  '}',
  '',
].join('\n');

let typescript;
const ts = () => (typescript ||= loadVendoredTypeScript());
const legacyCompile = (source) => ts().transpileModule(source, { compilerOptions: { target: ts().ScriptTarget.ES5, module: ts().ModuleKind.ES2020, jsx: ts().JsxEmit.React } }).outputText;

async function inWorld(fn) {
  const server = new FakeGenPageServer();
  server.serveTable(ACCOUNT_TABLE);
  server.seedPage(PAGE, { name: 'Legacy', source: SOURCE, compiled: legacyCompile(SOURCE) });
  server.seedPage(SIBLING, { name: 'Sibling', source: SOURCE, compiled: legacyCompile(SOURCE) });
  const made = [];
  const genpage = makeGenpageSdk(INSTANCE, { httpClient: server.http(), mkdtempSync: (prefix) => { const dir = fs.mkdtempSync(prefix); made.push(dir); return dir; } });
  try {
    return await fn({ server, genpage });
  } finally {
    await genpage.dispose();
    for (const dir of made) assert.ok(!fs.existsSync(dir));
  }
}
const compiledOf = (server, id) => server.rowText(id, 'src/pages/page.compiled');

test('REAL BUNDLE: an unchanged update keeps the legacy output (the control), and the prepared refresh changes only one comment line — read once, nothing written', async () => {
  await inWorld(async ({ server, genpage }) => {
    const legacy = compiledOf(server, PAGE);
    assert.doesNotMatch(legacy, /__values|__read/, 'the seeded output is the legacy emit');
    const control = await genpage.update(PAGE, { source: SOURCE });
    assert.strictEqual(control.unchanged, true);
    assert.strictEqual(compiledOf(server, PAGE), legacy, 'an unchanged source is not compiled again: this is what the refresh is for');
    const writesBefore = server.writes().length;

    const proposal = await prepareCompilerRefresh({ pageId: PAGE.toUpperCase(), localSource: SOURCE }, { genpage });
    assert.strictEqual(proposal.action, 'refresh');
    assert.strictEqual(proposal.proposedSource, `${SOURCE}${COMPILER_REFRESH_MARKER}\n`);
    assert.strictEqual(proposal.baseSha256, sha256(SOURCE));
    assert.strictEqual(proposal.proposedSha256, sha256(proposal.proposedSource));
    assert.match(proposal.diff, /^\+\/\/ model-apps compiler refresh: iterator-v1$/m);
    assert.strictEqual(proposal.diff.split('\n').filter((line) => /^[+-][^+-]/.test(line)).length, 1, 'one line is added and none removed');
    assert.ok(Object.isFrozen(proposal));
    assert.strictEqual(server.writes().length, writesBefore, 'preparing writes nothing');
    assert.strictEqual(compiledOf(server, PAGE), legacy);
  });
});

test('REAL BUNDLE: the reviewed refresh, written by the ordinary update, is compiled with the iterator helpers; a second update writes and publishes nothing; the sibling is untouched', async () => {
  await inWorld(async ({ server, genpage }) => {
    const siblingBefore = { source: server.rowText(SIBLING, 'src/pages/page.tsx'), compiled: compiledOf(server, SIBLING), messages: server.messagesOf(SIBLING).length };
    const proposal = await prepareCompilerRefresh({ pageId: PAGE, localSource: SOURCE }, { genpage });
    const written = await genpage.update(PAGE, { source: proposal.proposedSource, prompt: 'Compiler refresh', runtimeEvidence: true });
    assert.notStrictEqual(written.publish.kind, 'skipped');
    const compiled = compiledOf(server, PAGE);
    assert.match(compiled, /__values/, 'the loop walks the Map\'s iterator');
    assert.match(compiled, /__read|__spreadArray/, 'the spread reads the Set\'s iterator');
    assert.strictEqual(server.rowText(PAGE, 'src/pages/page.tsx'), proposal.proposedSource);
    assert.strictEqual(written.runtimeSha256, sha256(compiled), 'the ordinary runtime evidence records the new compiled output');

    const published = server.published.length;
    const writes = server.writes().length;
    const again = await genpage.update(PAGE, { source: proposal.proposedSource, publishedFingerprint: written.fingerprint });
    assert.deepStrictEqual([again.unchanged, again.publish.kind], [true, 'skipped']);
    assert.deepStrictEqual([server.writes().length, server.published.length], [writes, published], 'no write, no publish');

    // With the receipt of that write, the marked source needs nothing more.
    const receipt = { sourceSha256: sha256(proposal.proposedSource), compiledSha256: written.runtimeSha256 };
    const settled = await prepareCompilerRefresh({ pageId: PAGE, localSource: proposal.proposedSource, receipt }, { genpage });
    assert.deepStrictEqual([settled.action, settled.compiledSha256], ['none', written.runtimeSha256]);

    assert.deepStrictEqual({ source: server.rowText(SIBLING, 'src/pages/page.tsx'), compiled: compiledOf(server, SIBLING), messages: server.messagesOf(SIBLING).length }, siblingBefore);
  });
});

test('REAL BUNDLE: a refresh is refused, with nothing written, for a raw-files page, a local source that is not the deployed one, a moved base, a source that does not parse, and a marker no receipt proves', async () => {
  await inWorld(async ({ server, genpage }) => {
    const raw = 'd0000000-0000-4000-8000-000000000001';
    server.seedProject(raw, 'Hand made');
    server.seedFile(raw, 'f0000000-0000-4000-8000-00000000f001', 'notes/readme.txt', 200000000, 'not a page');
    const refused = (input, code) => assert.rejects(prepareCompilerRefresh(input, { genpage }), (e) => e.code === code && e.outcome === 'nothing');

    await refused({ pageId: raw, localSource: 'x' }, 'COMPILER_REFRESH_SOURCE_UNREADABLE');
    await refused({ pageId: 'e0000000-0000-4000-8000-00000000000e', localSource: SOURCE }, 'COMPILER_REFRESH_SOURCE_UNREADABLE');
    await refused({ pageId: PAGE, localSource: '' }, 'COMPILER_REFRESH_SOURCE_UNREADABLE');
    await refused({ pageId: 'not-a-page', localSource: SOURCE }, 'COMPILER_REFRESH_SOURCE_UNREADABLE');
    await refused({ pageId: PAGE, localSource: `${SOURCE}// edited locally\n` }, 'COMPILER_REFRESH_BASE_MISMATCH');
    await refused({ pageId: PAGE, localSource: SOURCE, expectedBaseSha256: sha256('another') }, 'COMPILER_REFRESH_BASE_MISMATCH');

    const broken = 'export default function Page() { return <div>; }\n';
    const marked = `${SOURCE}${COMPILER_REFRESH_MARKER}\n`;
    // The SDK does not store a source that does not parse, so a page that holds one is stood in for: the refresh's own parse refuses it.
    await assert.rejects(prepareCompilerRefresh({ pageId: PAGE, localSource: broken }, { genpage: { read: async () => ({ source: broken }) } }), (e) => e.code === 'COMPILER_REFRESH_PARSE_FAILED' && e.outcome === 'nothing');
    await genpage.update(PAGE, { source: marked });
    await refused({ pageId: PAGE, localSource: marked }, 'COMPILER_REFRESH_MARKER_UNPROVEN');
    await refused({ pageId: PAGE, localSource: marked, receipt: { sourceSha256: sha256(SOURCE), compiledSha256: 'a'.repeat(64) } }, 'COMPILER_REFRESH_MARKER_UNPROVEN');
    const writes = server.writes().length;
    await refused({ pageId: PAGE, localSource: marked, receipt: { sourceSha256: sha256(marked) } }, 'COMPILER_REFRESH_MARKER_UNPROVEN');
    assert.strictEqual(server.writes().length, writes);
  });
});

test('the marker counts only as a line of its own, a CRLF source keeps CRLF, and an injected compiler provider is the one used to parse', async () => {
  assert.strictEqual(readCompilerRefreshReceipt({ source: `const s = "${COMPILER_REFRESH_MARKER}";\n` }).state, 'absent');
  assert.strictEqual(readCompilerRefreshReceipt({ source: `x\n  ${COMPILER_REFRESH_MARKER}  \n` }).state, 'unknown');
  const crlf = SOURCE.replace(/\n/g, '\r\n').replace(/\r\n$/, '');
  let parsed = 0;
  const provider = new Proxy(ts(), { get: (target, key) => (key === 'createSourceFile' ? (...args) => { parsed += 1; return target.createSourceFile(...args); } : target[key]) });
  const genpage = { read: async () => ({ source: crlf }) };
  const out = await prepareCompilerRefresh({ pageId: PAGE, localSource: crlf }, { genpage, typescript: () => provider });
  assert.strictEqual(out.proposedSource, `${crlf}\r\n${COMPILER_REFRESH_MARKER}\r\n`);
  assert.strictEqual(parsed, 2, 'before and after');
});
