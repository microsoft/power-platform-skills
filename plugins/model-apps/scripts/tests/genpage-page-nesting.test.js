'use strict';
// A page whose elements nest too deeply to compile is refused with a code, and nothing is written (lib/page-nesting.js).
// V8's default stack runs out in TypeScript's recursive parse at roughly a thousand nested elements (fewer on the first compile of a process, whose frames are
// larger), and the compiler then throws a bare `RangeError: Maximum call stack size exceeded` out of `transpileModule`. These tests drive the REAL SDK bundle and
// the vendored compiler over the fake of the tables behind a page (helpers/fake-genpage-server.js), so what is proven is what a push does, on whichever runtime runs them.
// This file checks where lib/temp-workspace.js makes a workspace, so it works in a temp folder of its own (helpers/own-temp-folder.js), required first.
require('./helpers/own-temp-folder.js');
const { test } = require('node:test');
const assert = require('node:assert');
const { makeGenpageSdk, writeOutcome, PRE_WRITE_REFUSALS } = require('../lib/genpage-sdk.js');
const { guardPageNesting, isStackOverflow, PAGE_NESTING_TOO_DEEP, PAGE_NESTING_MESSAGE } = require('../lib/page-nesting.js');
const { SdkError, createMakerSdk, createNodeWorkspaceStorage } = require('../lib/maker-sdk.js');
const { pageStructure, pageStructureProblems } = require('../lib/page-structure.js');
const { guessedPageViews, parseViews } = require('../lib/typescript-views.js');
const { validatePageOutput } = require('../genpage-worker-output.js');
const { validatePage } = require('../promote-intent-pages.js');
const { makeTempDir } = require('./helpers/temp-dirs.js');
const fs = require('node:fs');
const path = require('node:path');
const { FakeGenPageServer, INSTANCE, ACCOUNT_TABLE } = require('./helpers/fake-genpage-server.js');

// A page whose root element holds `depth` nested elements. 5,000 overflows the stack on a cold or a warm compile alike, on Node 20 and 22; 100 is well inside it.
const nested = (depth) => `import * as React from 'react';\nexport default function Page() { return ${'<div>'.repeat(depth)}x${'</div>'.repeat(depth)}; }\n`;
const TOO_DEEP = nested(5000);
const DEEP_BUT_FINE = nested(100);
// A generic call signature is a guess for the lexer (an element or type parameters?), so such a page goes to TypeScript's parser — which, on 5,000 nested elements, runs out of stack.
const GENERIC_SIGNATURE = 'interface Api { <U>(x: U): U; }\n';
const GUESSED_TOO_DEEP = GENERIC_SIGNATURE + TOO_DEEP;
// The same guess, on a page that really is cut off: the parser reports a diagnostic, and today's messages stand.
const GUESSED_CUT_OFF = `${GENERIC_SIGNATURE}export default function Page() { return <div>`;
const stackOverflow = () => new RangeError('Maximum call stack size exceeded');

function makeServer() {
  const server = new FakeGenPageServer();
  server.serveTable(ACCOUNT_TABLE);
  return server;
}
async function withBackend(server, fn) {
  const genpage = makeGenpageSdk(INSTANCE, { httpClient: server.http() });
  try {
    return await fn(genpage);
  } finally {
    await genpage.dispose();
  }
}
const changeWrites = (server) => server.writes().filter((w) => !/PublishXml/.test(w));

test('a push of a page nested too deeply to compile is refused with PAGE_NESTING_TOO_DEEP, naming the page, and writes nothing — on create and on update', async () => {
  const server = makeServer();
  await withBackend(server, async (genpage) => {
    await assert.rejects(
      genpage.create({ name: 'Overview', source: TOO_DEEP, dataSources: 'account', prompt: 'p' }),
      (e) => {
        assert.strictEqual(e.code, PAGE_NESTING_TOO_DEEP);
        assert.strictEqual(e.outcome, 'nothing', 'the compile comes before any write: nothing was sent');
        assert.strictEqual(e.transient, false, 'a run again would meet the same page');
        assert.ok(!(e instanceof RangeError) && !/Maximum call stack/.test(e.message), 'no bare RangeError reaches the caller');
        assert.match(e.message, /^generative page "Overview" was not created \(nothing was written\): the elements of the page nest too deeply to compile .* split the page into components/);
        return true;
      },
    );
    assert.deepStrictEqual(changeWrites(server), [], 'not one request was written');
    assert.strictEqual(server.state.projects.size, 0, 'no page, no half page');

    const { pageId } = await genpage.create({ name: 'Overview', source: DEEP_BUT_FINE, dataSources: 'account', prompt: 'p', agentMessage: 'ok' });
    const before = server.writes().length;
    await assert.rejects(
      genpage.update(pageId, { source: TOO_DEEP, prompt: 'p2', agentMessage: 'a2' }),
      (e) => e.code === PAGE_NESTING_TOO_DEEP && e.outcome === 'nothing' && e.pageId === pageId
        && /^the update of generative page "Overview" \(.+\) failed and wrote nothing: the elements of the page nest too deeply to compile/.test(e.message)
        && !/Maximum call stack/.test(e.message),
    );
    assert.strictEqual(server.writes().length, before, 'the refused update wrote nothing');
    assert.strictEqual((await genpage.read(pageId)).source, DEEP_BUT_FINE, 'the page still holds what it held');
  });
});

test('a deep page that compiles is pushed exactly as before, and a compile that fails for another reason is still the SDK\'s own refusal', async () => {
  const server = makeServer();
  await withBackend(server, async (genpage) => {
    const out = await genpage.create({ name: 'Deep', source: DEEP_BUT_FINE, dataSources: 'account', prompt: 'p' });
    assert.strictEqual(out.publish.kind, 'verified');
    assert.strictEqual((await genpage.read(out.pageId)).source, DEEP_BUT_FINE);
    await assert.rejects(
      genpage.create({ name: 'Bad', source: 'export default function Page() { return <div>; }', dataSources: 'account', prompt: 'p' }),
      (e) => e.code === 'VALIDATION_ERROR' && e.outcome === 'nothing',
    );
  });
});

test('the guard turns only a stack overflow out of the compiler\'s own entry points into the refusal; every other error, result and member is the compiler\'s own', () => {
  const calls = [];
  const SyntaxKind = { A: 1 };
  // Exports as the bundled compiler has them: getters without a setter, so an assignment to the guarded object must not be what installs the wrapper.
  const ts = Object.defineProperties({}, {
    version: { get: () => '5.8.3', enumerable: true },
    SyntaxKind: { get: () => SyntaxKind, enumerable: true },
    transpileModule: { get: () => (...args) => { calls.push(args); return { outputText: 'compiled' }; }, enumerable: true },
    createSourceFile: { get: () => () => { throw stackOverflow(); }, enumerable: true },
    createProgram: { get: () => () => { throw new RangeError('Invalid array length'); }, enumerable: true },
    forEachChild: { get: () => () => { throw stackOverflow(); }, enumerable: true },
  });
  const made = [];
  const guarded = guardPageNesting(ts, (code, message) => { made.push(code); return new SdkError(code, message); });
  assert.deepStrictEqual(guarded.transpileModule('src', { a: 1 }), { outputText: 'compiled' });
  assert.deepStrictEqual(calls, [['src', { a: 1 }]], 'the arguments are the compiler\'s');
  assert.throws(() => guarded.createSourceFile('x'), (e) => e instanceof SdkError && e.code === PAGE_NESTING_TOO_DEEP);
  assert.throws(() => guarded.createProgram({}), (e) => e instanceof RangeError && e.message === 'Invalid array length', 'another RangeError is not a nesting problem');
  assert.throws(() => guarded.forEachChild({}, () => {}), (e) => e instanceof RangeError && /Maximum call stack/.test(e.message), 'an entry point that is not guarded is not touched');
  assert.strictEqual(guarded.version, '5.8.3');
  assert.strictEqual(guarded.SyntaxKind, SyntaxKind, 'a member that is not an entry point is the compiler\'s own object');
  assert.deepStrictEqual(made, [PAGE_NESTING_TOO_DEEP]);
});

test('only V8\'s stack overflow counts, and an overflow that did not come out of the compiler is an unknown outcome as before', () => {
  assert.strictEqual(isStackOverflow(stackOverflow()), true);
  for (const other of [new RangeError('Invalid array length'), new Error('Maximum call stack size exceeded'), new TypeError('Maximum call stack size exceeded'), null, undefined, 'Maximum call stack size exceeded']) {
    assert.strictEqual(isStackOverflow(other), false, String(other && other.message || other));
  }
  assert.strictEqual(writeOutcome(stackOverflow()), 'unknown', 'a RangeError from anywhere else proves nothing about a write');
  assert.strictEqual(writeOutcome(new SdkError(PAGE_NESTING_TOO_DEEP, 'x')), 'nothing');
  assert.ok(PRE_WRITE_REFUSALS.has(PAGE_NESTING_TOO_DEEP));
  assert.strictEqual(writeOutcome(Object.assign(new Error('looks typed'), { code: PAGE_NESTING_TOO_DEEP })), 'unknown', 'only an SdkError counts: the code alone is not the proof');
});

test('a parse that runs out of stack is told apart from every other parse failure, and only on the page it ran out on', () => {
  // buildViews reads the enum members before it calls the parser, so the fake carries them.
  const throwing = (error) => ({ ScriptTarget: { Latest: 99 }, ScriptKind: { TSX: 4 }, createSourceFile: () => { throw error; } });
  assert.deepStrictEqual(parseViews('x', { ts: throwing(stackOverflow()) }), { views: null, tooDeep: true });
  for (const other of [new Error('boom'), new RangeError('Invalid array length'), new TypeError('Maximum call stack size exceeded')]) {
    assert.deepStrictEqual(parseViews('x', { ts: throwing(other) }), { views: null, tooDeep: false }, String(other));
  }
  assert.strictEqual(guessedPageViews(GUESSED_TOO_DEEP).tooDeep, true, 'the real parse of the real page');
  assert.strictEqual(guessedPageViews(GUESSED_TOO_DEEP).views, null);
  assert.strictEqual(guessedPageViews(GUESSED_CUT_OFF).tooDeep, false, 'a page the parser reports a diagnostic on is not a nesting problem');
  assert.strictEqual(guessedPageViews(TOO_DEEP).tooDeep, false, 'the lexer did not guess, so no parse was asked for, and none ran out');
  assert.strictEqual(guessedPageViews(DEEP_BUT_FINE).tooDeep, false);
});

function writePage(dir, name, text) {
  fs.writeFileSync(path.join(dir, name), text);
  return path.join(dir, name);
}

test('/genpage\'s output gate and the promotion gate refuse a valid page that the parser cannot read for want of stack with the compile\'s code and the page\'s name, not as a cut-off page', () => {
  const dir = makeTempDir('nest-gates-');
  const file = writePage(dir, 'Nested page.tsx', GUESSED_TOO_DEEP);
  const worker = validatePageOutput({ filePath: file });
  assert.strictEqual(worker.ok, false);
  assert.strictEqual(worker.code, PAGE_NESTING_TOO_DEEP);
  assert.strictEqual(worker.problems.length, 1, JSON.stringify(worker.problems));
  assert.match(worker.problems[0], /^page file "Nested page\.tsx": the elements of the page nest too deeply to compile .* split the page into components/);
  assert.ok(!/truncated|default export|mid-statement/.test(worker.problems.join('\n')), 'no symptom of the lexer\'s wrong reading');

  // The promotion gate reads the same page and, being asked about navigation as well, says nothing of it: what it would find is read from the same wrong view.
  const promoted = validatePage({ key: 'overview', name: 'Overview', source: { kind: 'tsx', codeFile: 'Nested page.tsx' }, navigatesTo: ['other'] }, dir);
  assert.strictEqual(promoted.code, PAGE_NESTING_TOO_DEEP);
  assert.strictEqual(promoted.key, 'overview');
  assert.strictEqual(promoted.file, 'Nested page.tsx');
  assert.strictEqual(promoted.problems.length, 1, JSON.stringify(promoted.problems));
  assert.match(promoted.problems[0], /^page "Overview" \(Nested page\.tsx\): the elements of the page nest too deeply to compile .* split the page into components/);
  assert.deepStrictEqual(pageStructure(GUESSED_TOO_DEEP), { problems: [PAGE_NESTING_MESSAGE], code: PAGE_NESTING_TOO_DEEP });
});

test('the gates keep today\'s answers for every page that is not one the parser ran out of stack on', () => {
  const dir = makeTempDir('nest-gates-');
  // The same deep page without a guess is read whole by the lexer: complete, nothing refused, no code.
  assert.deepStrictEqual(pageStructure(TOO_DEEP), { problems: [], code: null });
  const plain = validatePageOutput({ filePath: writePage(dir, 'plain.tsx', TOO_DEEP) });
  assert.deepStrictEqual({ ok: plain.ok, code: plain.code, problems: plain.problems }, { ok: true, code: undefined, problems: [] });
  assert.deepStrictEqual(validatePage({ key: 'plain', name: 'Plain', source: { kind: 'tsx', codeFile: 'plain.tsx' } }, dir), { key: 'plain', file: 'plain.tsx', problems: [] });

  // A guessed page that really is cut off: the parser reports a diagnostic (no stack overflow), and the lexer's messages stand, with no code.
  const cut = pageStructure(GUESSED_CUT_OFF);
  assert.strictEqual(cut.code, null);
  assert.ok(cut.problems.length > 0 && cut.problems.some((p) => /truncated|default export/.test(p)), JSON.stringify(cut.problems));
  assert.deepStrictEqual(pageStructureProblems(GUESSED_CUT_OFF), cut.problems);
  const refused = validatePageOutput({ filePath: writePage(dir, 'cut.tsx', GUESSED_CUT_OFF) });
  assert.strictEqual(refused.ok, false);
  assert.strictEqual(refused.code, undefined);
  assert.deepStrictEqual(refused.problems, cut.problems, 'no page name is added to a problem that is not the nesting one');
  assert.strictEqual(pageStructure('').code, null);
  assert.deepStrictEqual(pageStructureProblems(''), ['file is empty']);
  // A small page with a generic signature that parses is read as the parser reads it, as before.
  assert.deepStrictEqual(pageStructure(`${GENERIC_SIGNATURE}${DEEP_BUT_FINE}`), { problems: [], code: null });
});

test('a push through the factory\'s own SDK, with no page backend over it, is refused with the same code and nothing is written; the page\'s name is the backend\'s to add', async () => {
  const server = makeServer();
  const folder = makeTempDir('nest-direct-');
  const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(folder), instanceUrl: INSTANCE, httpClient: server.http() });
  await sdk.initWorkspace();
  const page = await sdk.createArtifact('genPage', { name: 'Direct', source: TOO_DEEP, dataSources: ['account'], newTurn: { prompt: 'p' } });
  await assert.rejects(sdk.pushArtifact('genPage', page.id), (e) => e instanceof SdkError && e.code === PAGE_NESTING_TOO_DEEP && !(e instanceof RangeError) && !/Maximum call stack/.test(e.message));
  assert.deepStrictEqual(changeWrites(server), [], 'the compile comes before every write');
  assert.strictEqual(server.state.projects.size, 0);
});

