'use strict';
// lib/prepare-genpage.js — preparing a page without deploying it — and the compiler a caller hands in, threaded through every parse a page write makes:
// the structure gate (lib/page-structure.js, through lib/typescript-views.js, which keeps its views apart per compiler), the preparation's own parse check, and
// the SDK the page backend makes (lib/genpage-sdk.js). Run against the REAL vendored SDK bundle for the write, so a caller's compiler is proven to be the one
// the SDK compiles with, and the preparation's content hash to be the one the write answers.
require('./helpers/own-temp-folder.js');
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { prepareGenpage } = require('../lib/prepare-genpage.js');
const { pageStructure } = require('../lib/page-structure.js');
const { loadVendoredTypeScript } = require('../lib/typescript-compiler.js');
const { makeGenpageSdk } = require('../lib/genpage-sdk.js');
const { FakeGenPageServer, INSTANCE, ACCOUNT_TABLE } = require('./helpers/fake-genpage-server.js');

const ts = loadVendoredTypeScript();
const PAGE = "import * as React from 'react';\nexport default function Page() { return <div>Hello</div>; }\n";
// The lexer guesses on a generic call signature in an interface (it reads an element running to the end of the file), and only a parser settles the page as complete.
const GUESSED = "import * as React from 'react';\ninterface Api { <U>(x: U): U; }\nexport default function Page() { return <div>Hi</div>; }\n";
// Refused on purpose (AGENTS.md, "Refused on purpose — fail-closed readings"): TypeScript parses it, the gate does not read it, and no compiler changes that.
const REFUSED_ON_PURPOSE = 'export default <T extends object>(p: T): ({ [K in (keyof T)]: boolean }) => null as never;\n';

// The vendored compiler behind a counter: a caller's compiler in all but identity. Each spy is a new object, so the views kept for one are not another's.
function spyCompiler() {
  const calls = { createSourceFile: 0, transpileModule: 0 };
  const spy = Object.create(ts);
  for (const name of Object.keys(calls)) {
    Object.defineProperty(spy, name, { value: (...args) => { calls[name] += 1; return ts[name](...args); }, enumerable: true });
  }
  return { spy, calls };
}

test('prepare: the same page prepares to the same answer with a caller\'s compiler as with the vendored one, and the caller\'s is the one that parses it', () => {
  const input = { source: GUESSED, name: 'Overview', config: { dataSources: 'Account', model: 'gpt-4.1' }, bindings: { connectorBindings: [] }, navigation: [{ page: 'overview' }], runtimeTypes: 'declare namespace RuntimeTypes { interface account { name: string } }\n' };
  const vendored = prepareGenpage(input);
  const { spy, calls } = spyCompiler();
  const injected = prepareGenpage(input, { typescript: spy });
  assert.strictEqual(vendored.compiler.source, 'vendored');
  assert.strictEqual(injected.compiler.source, 'injected');
  assert.deepStrictEqual({ ...injected, compiler: null }, { ...vendored, compiler: null }, 'same hashes, same diagnostics');
  assert.strictEqual(injected.ok, true, JSON.stringify(injected.diagnostics));
  // The structure gate settled the lexer's guess with it, and the parse check and the RuntimeTypes check ran on it: three parses.
  assert.strictEqual(calls.createSourceFile, 3);
  // In the SDK's shape too: a function that answers the compiler.
  const fn = spyCompiler();
  assert.deepStrictEqual(prepareGenpage(input, { typescript: () => fn.spy }).hashes, vendored.hashes);
  assert.ok(fn.calls.createSourceFile > 0);
  assert.strictEqual(calls.transpileModule, 0, 'preparing compiles nothing');
});

test('prepare: the answer is frozen, names exact hashes, and writes nothing', () => {
  const out = prepareGenpage({ source: Buffer.from(`\uFEFF${PAGE}`, 'utf8'), config: { dataSources: ['account'] } });
  assert.ok(Object.isFrozen(out) && Object.isFrozen(out.hashes) && Object.isFrozen(out.diagnostics) && out.diagnostics.every(Object.isFrozen));
  assert.strictEqual(out.writes, 0);
  // The source hash is of the text the write sends: the bytes' one byte order mark is dropped, exactly as create and update drop it.
  assert.strictEqual(out.hashes.source, require('node:crypto').createHash('sha256').update(PAGE, 'utf8').digest('hex'));
  assert.strictEqual(out.hashes.bindings, null, 'no bindings given, none hashed');
  // A table named, no types supplied: never fetched, never invented — the page is ready, and the answer says what it did not check.
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.runtimeTypes.state, 'not-supplied');
  assert.deepStrictEqual(out.diagnostics.map((d) => [d.severity, d.code]), [['warning', 'PREPARE_RUNTIME_TYPES_NOT_SUPPLIED']]);
  // A key order is no content: the same settings in another order hash the same; a different model does not.
  const a = prepareGenpage({ source: PAGE, config: { model: 'm', dataSources: 'account' }, navigation: { b: 1, a: [1, 2] } });
  const b = prepareGenpage({ source: PAGE, config: { dataSources: 'account', model: 'm' }, navigation: { a: [1, 2], b: 1 } });
  assert.deepStrictEqual(a.hashes, b.hashes);
  assert.notStrictEqual(prepareGenpage({ source: PAGE, config: { dataSources: 'account', model: 'n' } }).hashes.config, a.hashes.config);
});

test('prepare: what the write would refuse, it reports with the write\'s code, and a page it reports is not ready', () => {
  const codes = (input) => prepareGenpage(input).diagnostics.filter((d) => d.severity === 'error').map((d) => d.code);
  const cut = PAGE.slice(0, PAGE.indexOf('<div>') + 3);
  assert.deepStrictEqual([...new Set(codes({ source: cut }))].sort(), ['PAGE_PARSE_FAILED', 'PAGE_STRUCTURE_INVALID']);
  const parse = prepareGenpage({ source: cut }).diagnostics.find((d) => d.code === 'PAGE_PARSE_FAILED');
  assert.ok(parse.line >= 1 && parse.column >= 1);
  assert.deepStrictEqual(codes({ source: Buffer.from([0x66, 0xff]) }), ['GENPAGE_SOURCE_NOT_UTF8']);
  assert.deepStrictEqual(codes({ source: PAGE, bindings: { actionBindings: { not: 'a list' } } }), ['GENPAGE_BINDING_INVALID']);
  assert.deepStrictEqual(codes({ source: PAGE, runtimeTypes: 'declare namespace RuntimeTypes {' }), ['PREPARE_RUNTIME_TYPES_INVALID']);
  assert.deepStrictEqual(codes({ source: PAGE, navigation: [() => 1] }), ['PREPARE_INPUT_INVALID']);
  assert.deepStrictEqual(codes({ source: PAGE, config: { dataSources: 'account', approved: true } }), ['PREPARE_INPUT_INVALID']);
  assert.strictEqual(prepareGenpage({ source: cut }).ok, false);
  assert.strictEqual(prepareGenpage({ source: cut }).hashes.content !== null, true, 'a page that is not ready is still named: the answer says which content was refused');
  // Input it does not read is refused outright: it would be content nobody checked, under an answer that seems to cover it.
  assert.throws(() => prepareGenpage({ source: PAGE, publish: true }), { code: 'PREPARE_INPUT_INVALID', outcome: 'nothing' });
  assert.throws(() => prepareGenpage(null), { code: 'PREPARE_INPUT_INVALID' });
  // A compiler that is none is refused before anything is read.
  for (const bad of [{}, { createSourceFile() {} }, () => null, () => { throw new Error('no compiler here'); }, 'typescript']) {
    assert.throws(() => prepareGenpage({ source: PAGE }, { typescript: bad }), { code: 'TYPESCRIPT_PROVIDER_INVALID', outcome: 'nothing' });
  }
});

test('the structure gate settles a lexer guess with the caller\'s compiler, keeps that parse for that compiler alone, and refuses on purpose what it always refused', () => {
  const { spy, calls } = spyCompiler();
  assert.deepStrictEqual(pageStructure(GUESSED, { ts: spy }), { problems: [], code: null });
  assert.strictEqual(calls.createSourceFile, 1, 'the guess was settled by the caller\'s compiler');
  pageStructure(GUESSED, { ts: spy });
  assert.strictEqual(calls.createSourceFile, 1, 'the same text, the same compiler: not parsed again');
  const other = spyCompiler();
  pageStructure(GUESSED, { ts: other.spy });
  assert.strictEqual(other.calls.createSourceFile, 1, 'another compiler parses for itself: no view is answered for a parse it never made');
  // A page the lexer reads for certain asks no compiler.
  const plain = spyCompiler();
  assert.deepStrictEqual(pageStructure(PAGE, { ts: plain.spy }), { problems: [], code: null });
  assert.strictEqual(plain.calls.createSourceFile, 0);
  // Fail-closed readings stay fail-closed whichever compiler is at hand: TypeScript parses this page, and the gate refuses it, with the vendored compiler and a caller's.
  const refused = pageStructure(REFUSED_ON_PURPOSE);
  assert.strictEqual(refused.problems.length, 1);
  assert.deepStrictEqual(pageStructure(REFUSED_ON_PURPOSE, { ts: spyCompiler().spy }), refused);
  assert.strictEqual(prepareGenpage({ source: REFUSED_ON_PURPOSE }, { typescript: spyCompiler().spy }).ok, false);
});

test('prepare with a caller\'s compiler needs no file system: nothing it loads or runs asks for one, and the vendored compiler is never loaded', () => {
  // A child process, so the modules load fresh. The vendored compiler is loaded FIRST (it reads its own files) and handed in; then every require is watched.
  const lib = path.join(__dirname, '..', 'lib');
  const script = `
    const Module = require('node:module');
    const path = require('node:path');
    const ts = require(${JSON.stringify(path.join(lib, 'typescript-compiler.js'))}).loadVendoredTypeScript();
    const asked = [];
    const load = Module._load;
    Module._load = function (request, parent, isMain) { asked.push(request); return load.apply(this, arguments); };
    const { prepareGenpage } = require(${JSON.stringify(path.join(lib, 'prepare-genpage.js'))});
    const page = ${JSON.stringify(GUESSED)};
    const injected = prepareGenpage({ source: page, config: { dataSources: 'account' } }, { typescript: ts });
    const withInjected = asked.splice(0);
    const vendored = prepareGenpage({ source: page, config: { dataSources: 'account' } });
    process.stdout.write(JSON.stringify({ withInjected, withVendored: asked, ok: injected.ok, same: JSON.stringify(injected.hashes) === JSON.stringify(vendored.hashes) }));
  `;
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const run = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', env });
  assert.strictEqual(run.status, 0, run.stderr);
  const out = JSON.parse(run.stdout);
  const fileSystem = (request) => /^(node:)?fs(\/promises)?$/.test(request) || /typescript-compiler\.js$/.test(request);
  assert.deepStrictEqual(out.withInjected.filter(fileSystem), [], `asked for: ${out.withInjected.join(', ')}`);
  assert.ok(out.withInjected.includes('./typescript-views.js'), 'the watch saw the preparation load its parser');
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.same, true);
  // The control: with no compiler handed in, the vendored one is required where it is first needed — the watch would have seen it.
  assert.ok(out.withVendored.some((request) => /typescript-compiler\.js$/.test(request)), out.withVendored.join(', '));
});

test('REAL BUNDLE: the page backend compiles with the caller\'s compiler, to the same page the vendored one makes, and the content hash is the preparation\'s', async () => {
  const run = async (deps) => {
    const server = new FakeGenPageServer();
    server.serveTable(ACCOUNT_TABLE);
    const made = [];
    const genpage = makeGenpageSdk(INSTANCE, { httpClient: server.http(), mkdtempSync: (prefix) => { const dir = fs.mkdtempSync(prefix); made.push(dir); return dir; }, ...deps });
    try {
      const out = await genpage.create({ name: 'Overview', source: PAGE, dataSources: 'account', prompt: 'Make it', agentMessage: 'Made it' });
      const compiled = server.filesOf(out.pageId).find((f) => f.filename.endsWith('page.compiled'));
      return { out, compiled: compiled && server.fileText(compiled.id) };
    } finally {
      await genpage.dispose();
    }
  };
  const vendored = await run({});
  const { spy, calls } = spyCompiler();
  const injected = await run({ typescript: () => spy });
  assert.ok(calls.transpileModule >= 1, 'the SDK compiled with the caller\'s compiler');
  assert.ok(vendored.compiled && vendored.compiled.length > 0);
  assert.strictEqual(injected.compiled, vendored.compiled, 'the same compiled page');
  const prepared = prepareGenpage({ source: PAGE, name: 'Overview', config: { dataSources: 'account' } }, { typescript: spy });
  assert.strictEqual(prepared.hashes.content, injected.out.fingerprint);
  assert.strictEqual(prepared.hashes.content, vendored.out.fingerprint);
  // A caller's compiler that is none fails the write before anything is sent.
  const server = new FakeGenPageServer();
  const genpage = makeGenpageSdk(INSTANCE, { httpClient: server.http(), typescript: () => ({}) });
  try {
    await assert.rejects(genpage.create({ name: 'Bad', source: PAGE }));
    assert.deepStrictEqual(server.writes(), []);
  } finally {
    await genpage.dispose();
  }
});
