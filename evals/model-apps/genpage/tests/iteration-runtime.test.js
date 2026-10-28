'use strict';
// Eval 26's customer choices, run the way the page is compiled. The bundled SDK compiles every page with TypeScript's
// `transpileModule` and `{ target: ES5, module: ES2020, jsx: React, downlevelIteration: true }` — no type check. The bundles before
// model-apps 2.20.5 compiled without `downlevelIteration`, as an older maker portal and `pac` still do, and under those options a spread
// copies by `length` and index. A Map's iterator has neither, so `return [...seen.values()];` contributed nothing: the page's "Change
// customer" Dropdown opened with no options, and the compile reported nothing. The committed page converts with `Array.from`, which
// is right under both.
//
// The page's own `choices` callback and the trusted top-level helpers it calls are lifted out of the committed source with the
// vendored parser (never by line number), compiled alone with the SDK's options and run on the fixture's synthetic rows
// (lookup-rows.json). The page module itself is never executed. Values cross the vm boundary as JSON, so no assertion depends
// on another realm's prototypes.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadVendoredTypeScript } = require('../../../../plugins/model-apps/scripts/lib/typescript-compiler.js');

const FIXTURE = path.join(__dirname, '..', 'fixtures', '26-customer-lookup');
const PAGE = fs.readFileSync(path.join(FIXTURE, 'customer-lookup.tsx'), 'utf8');
const ROWS = JSON.parse(fs.readFileSync(path.join(FIXTURE, 'lookup-rows.json'), 'utf8'));
const LABEL = '_customerid_value@OData.Community.Display.V1.FormattedValue';
// The top-level declarations the callback reaches: the canonical lookup normalizer with its two patterns, and the page's
// label and choice helpers.
const HELPERS = ['LOOKUP_GUID', 'LOOKUP_QUALIFIED', 'normalizeLookupReference', 'customerLabel', 'customerChoice'];

let typescript;
const ts = () => (typescript ||= loadVendoredTypeScript());
// The vendored SDK's own compile options, exactly (plugins/model-apps/scripts/tests/iteration-emit.test.js holds them to what the bundle
// stores), and those of a compiler without iterator support: a test is never made to pass by changing either.
const sdkCompile = (source, { iteratorSupport = true } = {}) => ts().transpileModule(source, {
  compilerOptions: { target: ts().ScriptTarget.ES5, module: ts().ModuleKind.ES2020, jsx: ts().JsxEmit.React, ...(iteratorSupport ? { downlevelIteration: true } : {}) },
  reportDiagnostics: true,
});

// The helpers' text, the `choices` callback (`React.useMemo(() => { … }, [opportunities])`) and its final `return`.
function pieces(source) {
  const file = ts().createSourceFile('customer-lookup.tsx', source, ts().ScriptTarget.Latest, true, ts().ScriptKind.TSX);
  const top = new Map();
  for (const statement of file.statements) {
    if (ts().isFunctionDeclaration(statement) && statement.name) top.set(statement.name.text, statement);
    if (ts().isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) if (ts().isIdentifier(declaration.name)) top.set(declaration.name.text, statement);
    }
  }
  const found = [];
  const visit = (node) => {
    if (ts().isVariableDeclaration(node) && ts().isIdentifier(node.name) && node.name.text === 'choices'
      && node.initializer && ts().isCallExpression(node.initializer) && node.initializer.expression.getText(file) === 'React.useMemo') {
      found.push(node.initializer.arguments[0]);
    }
    ts().forEachChild(node, visit);
  };
  visit(file);
  assert.equal(found.length, 1, 'the page declares one `choices` memo');
  const callback = found[0];
  assert.ok(ts().isArrowFunction(callback) && callback.parameters.length === 0 && ts().isBlock(callback.body), 'its callback is a block-bodied arrow with no parameter');
  const last = callback.body.statements[callback.body.statements.length - 1];
  assert.ok(ts().isReturnStatement(last) && last.expression, 'the callback ends by returning its choices');
  for (const name of HELPERS) assert.ok(top.has(name), `the page declares ${name} at the top level`);
  return { file, helpers: HELPERS.map((name) => top.get(name).getText(file)), callback, returned: last.expression };
}

// The callback compiled with the SDK's options and called with `rows` — optionally with its final return expression replaced,
// which is how the control below puts the iterator spread back without touching the committed file.
function choicesOf(rows, { returnExpression, iteratorSupport = true } = {}) {
  const { file, helpers, callback, returned } = pieces(PAGE);
  let text = callback.getText(file);
  if (returnExpression !== undefined) {
    const start = returned.getStart(file) - callback.getStart(file);
    const end = returned.getEnd() - callback.getStart(file);
    text = `${text.slice(0, start)}${returnExpression}${text.slice(end)}`;
  }
  const source = `${helpers.join('\n\n')}\n\nconst choicesOf = (opportunities: any[]) => (${text})();\n`;
  const { outputText, diagnostics } = sdkCompile(source, { iteratorSupport });
  assert.deepEqual((diagnostics || []).map((d) => `TS${d.code}`), [], 'the helpers and the callback compile without a diagnostic');
  const run = vm.runInNewContext(`${outputText}\n;choicesOf;`, {}, { filename: 'customer-lookup-choices.js' });
  return { choices: JSON.parse(JSON.stringify(run(rows))), outputText };
}

// What lookup-rows.json says the picker offers: each resolved customer once, by table and id, in row order, with its label.
function recordedChoices() {
  const seen = new Set();
  const out = [];
  for (const entry of ROWS.rows) {
    if (entry.expected.state !== 'resolved') continue;
    const { table, id } = entry.expected.reference;
    if (seen.has(`${table}:${id}`)) continue;
    seen.add(`${table}:${id}`);
    out.push({ table, id, label: entry.row[LABEL] });
  }
  return out;
}

test('eval 26: the customer choices, compiled as the SDK compiles the page, are every resolved customer once and in order', () => {
  const expected = recordedChoices();
  // The rows exercise a repeated customer, equal labels, and one GUID in two tables.
  assert.equal(expected.length, 4);
  assert.deepEqual(expected.map((choice) => choice.label), ['Fabrikam', 'Rene Valdes', 'Contoso', 'Contoso']);
  assert.deepEqual(expected.slice(2).map((choice) => choice.table), ['account', 'contact']);
  assert.equal(expected[2].id, expected[3].id, 'one GUID in two tables stays two choices');
  assert.deepEqual(choicesOf(ROWS.rows.map((entry) => entry.row)).choices, expected);
  assert.deepEqual(choicesOf(ROWS.rows.map((entry) => entry.row), { iteratorSupport: false }).choices, expected, 'and as a compiler without iterator support compiles it');
});

test('eval 26: the same callback with the Map iterator spread back in offers every choice under the SDK options and none without iterator support', () => {
  const rows = ROWS.rows.map((entry) => entry.row);
  const sdk = choicesOf(rows, { returnExpression: '[...seen.values()]' });
  assert.deepEqual(sdk.choices, recordedChoices(), 'the SDK reads the iterator through Symbol.iterator');
  assert.match(sdk.outputText, /__spreadArray\(\[\], __read\(seen\.values\(\)\), false\)/);
  const legacy = choicesOf(rows, { returnExpression: '[...seen.values()]', iteratorSupport: false });
  assert.deepEqual(legacy.choices, [], 'without iterator support the spread copies by length and index, which an iterator does not have');
  assert.match(legacy.outputText, /__spreadArray\(\[\], seen\.values\(\), true\)/, 'ES5 emit without iterator support copies the iterator as an array-like');
});

test('eval 26: the committed callback converts the iterator before returning it, and keeps its dedupe loop', () => {
  const { file, callback, returned } = pieces(PAGE);
  assert.equal(returned.getText(file), 'Array.from(seen.values())');
  const body = callback.getText(file);
  assert.match(body, /const seen = new Map<string, Picked>\(\);/);
  assert.match(body, /if \(choice && !seen\.has\(`\$\{choice\.table\}:\$\{choice\.id\}`\)\) seen\.set\(`\$\{choice\.table\}:\$\{choice\.id\}`, choice\);/);
  const compiled = sdkCompile(PAGE);
  assert.deepEqual((compiled.diagnostics || []).map((d) => `TS${d.code}`), [], 'the whole page compiles without a diagnostic');
  assert.doesNotMatch(compiled.outputText, /__spreadArray\(\[\], seen\.values\(\)/, 'the compiled page no longer copies the iterator as an array-like');
  assert.match(compiled.outputText, /return Array\.from\(seen\.values\(\)\);/);
});
