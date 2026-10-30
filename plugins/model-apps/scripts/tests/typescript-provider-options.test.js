'use strict';
// typescriptProviderOptions: one caller's compiler, resolved once, handed to the page parsers as the namespace (`ts`) and to the page backend as
// `typescript` — the two shapes those consumers read. Handing a parser the SDK's function shape, or the backend a `ts` key, silently does
// something else (a false "cut off" for a valid page; a page compiled by the vendored compiler), so both forms are pinned through the real
// consumers here, including the real SDK bundle behind makeGenpageSdk.

require('./helpers/own-temp-folder.js');
const { test } = require('node:test');
const assert = require('node:assert');
const { typescriptProviderOptions, TYPESCRIPT_PROVIDER_INVALID } = require('../lib/typescript-provider.js');
const { pageStructure } = require('../lib/page-structure.js');
const { loadVendoredTypeScript } = require('../lib/typescript-compiler.js');
const { makeGenpageSdk } = require('../lib/genpage-sdk.js');
const { FakeGenPageServer, INSTANCE, ACCOUNT_TABLE } = require('./helpers/fake-genpage-server.js');

const ts = loadVendoredTypeScript();
const PAGE = "import * as React from 'react';\nexport default function Page() { return <div>Hello</div>; }\n";
// The lexer guesses on a generic call signature in an interface; only a parser settles the page as complete.
const GUESSED = "import * as React from 'react';\ninterface Api { <U>(x: U): U; }\nexport default function Page() { return <div>Hi</div>; }\n";

function spyCompiler() {
  const calls = { createSourceFile: 0, transpileModule: 0 };
  const spy = Object.create(ts);
  for (const name of Object.keys(calls)) {
    Object.defineProperty(spy, name, { value: (...args) => { calls[name] += 1; return ts[name](...args); }, enumerable: true });
  }
  return { spy, calls };
}

const FORMS = [['the namespace', (spy) => spy], ['the SDK\'s function shape', (spy) => () => spy]];

for (const [label, shape] of FORMS) {
  test(`provider options (${label}): the parser gets the namespace, and settles a guessed page with the caller's compiler`, () => {
    const { spy, calls } = spyCompiler();
    const { parse } = typescriptProviderOptions(shape(spy));
    assert.strictEqual(parse.ts, spy, 'the parser is handed the namespace itself');
    assert.deepStrictEqual(pageStructure(GUESSED, parse), { problems: [], code: null });
    assert.strictEqual(calls.createSourceFile, 1, 'the caller\'s compiler parsed it');
  });

  test(`REAL BUNDLE provider options (${label}): the backend compiles the page with the caller's compiler`, async () => {
    const { spy, calls } = spyCompiler();
    const server = new FakeGenPageServer();
    server.serveTable(ACCOUNT_TABLE);
    const genpage = makeGenpageSdk(INSTANCE, { httpClient: server.http(), ...typescriptProviderOptions(shape(spy)).backend });
    try {
      const out = await genpage.create({ name: 'Overview', source: PAGE, dataSources: 'account', prompt: 'Make it', agentMessage: 'Made it' });
      assert.ok(out.pageId);
      assert.ok(calls.transpileModule >= 1, 'the SDK compiled with the caller\'s compiler, not the vendored one');
    } finally {
      await genpage.dispose();
    }
  });
}

test('provider options: no provider hands on nothing, so every call sends what it sent before', () => {
  assert.deepStrictEqual(typescriptProviderOptions(undefined), { parse: {}, backend: {} });
  assert.deepStrictEqual(typescriptProviderOptions(null), { parse: {}, backend: {} });
  assert.deepStrictEqual(pageStructure(GUESSED, typescriptProviderOptions(undefined).parse), pageStructure(GUESSED));
});

test('provider options: a provider that is not a compiler is refused when the options are made, before any parse or write', () => {
  let asked = 0;
  assert.throws(() => typescriptProviderOptions(() => { asked += 1; return {}; }), (e) => e.code === TYPESCRIPT_PROVIDER_INVALID && e.outcome === 'nothing');
  assert.strictEqual(asked, 1);
  assert.throws(() => typescriptProviderOptions({ createSourceFile() {} }), (e) => e.code === TYPESCRIPT_PROVIDER_INVALID);
});
