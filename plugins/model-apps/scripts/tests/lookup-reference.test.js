'use strict';
// The canonical lookup normalizer as references/rules.md publishes it ("Lookup references"), run as published: the block is
// transpiled with the TypeScript the plugin vendors (a transpile, not a type check) and its function called on a table of rows —
// the measured shapes (a qualified Customer and user-owned Owner value with a matching annotation), the shapes another player may
// send (a bare GUID with or without the annotation), and the inputs that must not resolve (contradictory or foreign evidence,
// malformed ids, a plural entity set, a missing field). The rows below are synthetic, not captured from an environment.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadVendoredTypeScript } = require('../lib/typescript-compiler.js');

const RULES = fs.readFileSync(path.join(__dirname, '..', '..', 'references', 'rules.md'), 'utf8').replace(/\r\n/g, '\n');

// The section from its heading to the next heading of the same or a higher level.
function section(text, heading) {
  const start = text.indexOf(`\n${heading}\n`);
  assert.ok(start >= 0, `rules.md has the section "${heading}"`);
  const next = text.slice(start + heading.length + 2).search(/\n#{2,3} /);
  return next < 0 ? text.slice(start) : text.slice(start, start + heading.length + 2 + next);
}

function canonicalBlock() {
  const lookups = section(RULES, '### Lookup references (Customer, Owner, Regarding and every other lookup)');
  const blocks = [...lookups.matchAll(/```typescript\n([\s\S]*?)\n```/g)].map((match) => match[1]).filter((block) => /\bfunction normalizeLookupReference\(/.test(block));
  assert.equal(blocks.length, 1, 'the section shows the normalizer once');
  return blocks[0];
}

let normalize;
function load() {
  if (normalize) return normalize;
  const typescript = loadVendoredTypeScript();
  const { outputText } = typescript.transpileModule(`${canonicalBlock()}\nexport { normalizeLookupReference };\n`, {
    fileName: 'page.tsx',
    compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2020 },
  });
  const module = { exports: {} };
  // The helper needs nothing from outside: no require, no console, no globals beyond the language's own.
  new Function('module', 'exports', 'require', 'console', outputText)(module, module.exports, () => { throw new Error('the helper imports nothing'); }, undefined);
  normalize = module.exports.normalizeLookupReference;
  assert.equal(typeof normalize, 'function');
  return normalize;
}

const ID = '4E0B2C77-1D7A-4B1E-9C55-0123456789AB';
const id = ID.toLowerCase();
const CUSTOMER = ['account', 'contact'];
const OWNER = ['systemuser', 'team'];
const ANNOTATION = '_customerid_value@Microsoft.Dynamics.CRM.lookuplogicalname';
const row = (value, extra = {}) => ({ _customerid_value: value, ...extra });

test('the measured qualified Customer and Owner values resolve to their table and a bare, lower-case id', () => {
  const run = load();
  assert.deepEqual(run(row(`/contact(${ID})`, { [ANNOTATION]: 'contact', '_customerid_value@Microsoft.Dynamics.CRM.associatednavigationproperty': 'parentcustomerid_contact' }), '_customerid_value', CUSTOMER),
    { state: 'resolved', reference: { table: 'contact', id } });
  assert.deepEqual(run({ _ownerid_value: `/systemuser(${ID})`, '_ownerid_value@Microsoft.Dynamics.CRM.lookuplogicalname': 'systemuser', '_ownerid_value@Microsoft.Dynamics.CRM.associatednavigationproperty': 'ownerid' }, '_ownerid_value', OWNER),
    { state: 'resolved', reference: { table: 'systemuser', id } });
  assert.deepEqual(run(row(`/account(${ID})`), '_customerid_value', CUSTOMER), { state: 'resolved', reference: { table: 'account', id } }, 'the prefix alone, annotation absent');
  assert.deepEqual(run(row(`  /account(${ID})  `), '_customerid_value', CUSTOMER), { state: 'resolved', reference: { table: 'account', id } }, 'surrounding whitespace only is trimmed');
});

test('a bare GUID resolves from its annotation, or from a single-target lookup — and otherwise needs its target, with the bare id', () => {
  const run = load();
  assert.deepEqual(run(row(ID, { [ANNOTATION]: 'account' }), '_customerid_value', CUSTOMER), { state: 'resolved', reference: { table: 'account', id } });
  assert.deepEqual(run({ _primarycontactid_value: ID }, '_primarycontactid_value', ['contact']), { state: 'resolved', reference: { table: 'contact', id } });
  assert.deepEqual(run(row(ID), '_customerid_value', CUSTOMER), { state: 'needs-target', id }, 'never the first target');
  // Nothing else is evidence: not the label, not the navigation annotation, not the order of the targets.
  const hints = { '_customerid_value@OData.Community.Display.V1.FormattedValue': 'Contoso (account)', '_customerid_value@Microsoft.Dynamics.CRM.associatednavigationproperty': 'customerid_account' };
  assert.deepEqual(run(row(ID, hints), '_customerid_value', CUSTOMER), { state: 'needs-target', id });
  assert.deepEqual(run(row(ID), '_customerid_value', ['contact', 'account']), { state: 'needs-target', id });
});

test('one GUID in two tables stays two references', () => {
  const run = load();
  const account = run(row(ID, { [ANNOTATION]: 'account' }), '_customerid_value', CUSTOMER);
  const contact = run(row(ID, { [ANNOTATION]: 'contact' }), '_customerid_value', CUSTOMER);
  assert.notDeepEqual(account, contact);
  assert.equal(account.reference.id, contact.reference.id);
});

test('an explicit null is unset; a missing, undefined or non-string value is invalid, not an empty lookup', () => {
  const run = load();
  assert.deepEqual(run(row(null), '_customerid_value', CUSTOMER), { state: 'unset' });
  assert.deepEqual(run({}, '_customerid_value', CUSTOMER), { state: 'invalid' }, 'a field the read did not return');
  assert.deepEqual(run(row(undefined), '_customerid_value', CUSTOMER), { state: 'invalid' });
  for (const value of [42, true, { id: ID }, [ID]]) assert.deepEqual(run(row(value), '_customerid_value', CUSTOMER), { state: 'invalid' }, JSON.stringify(value));
  // An inherited property is not the row's own.
  assert.deepEqual(run(Object.create({ _customerid_value: ID }), '_customerid_value', CUSTOMER), { state: 'invalid' });
});

test('contradictory or foreign evidence is invalid, never resolved by a fallback', () => {
  const run = load();
  for (const [label, input] of [
    ['annotation and prefix disagree', row(`/account(${ID})`, { [ANNOTATION]: 'contact' })],
    ['a prefix outside the targets', row(`/lead(${ID})`)],
    ['an annotation outside the targets', row(ID, { [ANNOTATION]: 'lead' })],
    ['an annotation in another letter case', row(ID, { [ANNOTATION]: 'Account' })],
    ['an annotation that is not a string', row(ID, { [ANNOTATION]: 7 })],
    ['an empty annotation', row(ID, { [ANNOTATION]: '' })],
    ['a null annotation', row(ID, { [ANNOTATION]: null })],
  ]) {
    assert.deepEqual(run(input, '_customerid_value', CUSTOMER), { state: 'invalid' }, label);
  }
});

test('only a canonical GUID or /<logical-name>(<GUID>) is accepted', () => {
  const run = load();
  for (const value of [
    '', 'not-a-guid', `{${ID}}`, `${ID}x`, ID.slice(0, 35), ID.replace(/-/g, ''),
    `/accounts(${ID})`, `/Account(${ID})`, `/account(${ID})/extra`, `/account(${ID})x`, `account(${ID})`,
    `https://contoso.crm.dynamics.com/api/data/v9.2/accounts(${ID})`, `/account(%7B${ID}%7D)`, `/account('${ID}')`,
  ]) {
    assert.deepEqual(run(row(value), '_customerid_value', CUSTOMER), { state: 'invalid' }, value);
  }
});

test('a row that is not an object, or an empty target set, is invalid', () => {
  const run = load();
  for (const input of [null, undefined, 'text', 7, [row(ID)]]) assert.deepEqual(run(input, '_customerid_value', CUSTOMER), { state: 'invalid' }, String(input));
  assert.deepEqual(run(row(`/account(${ID})`), '_customerid_value', []), { state: 'invalid' });
});

test('every resolved or needs-target id is a bare GUID: the qualified input never comes back as an id', () => {
  const run = load();
  for (const value of [ID, `/account(${ID})`, `/contact(${ID.toLowerCase()})`]) {
    const result = run(row(value), '_customerid_value', CUSTOMER);
    const out = result.state === 'resolved' ? result.reference.id : result.id;
    assert.match(out, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, value);
  }
});
