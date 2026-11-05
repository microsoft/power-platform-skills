'use strict';
// The canonical lookup normalizer (lib/polymorphic-lookup-contract.js reads it from references/rules.md and checks a page's copy),
// the published block run against fixture 26's synthetic customer values, and the typed-path context of the column check
// (lib/column-contract.js). What a page does with a lookup is not graded (EVAL_GUIDE.md). The page below is assembled from the
// canonical normalizer and the CORRECT forms of the rules' lookup pitfalls; the rows, tables and paths are synthetic, shaped like
// get-lookup-metadata.js's answer.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { normalizerProblems } = require('../lib/polymorphic-lookup-contract.js');
const { columnProblems } = require('../lib/column-contract.js');

const RULES = fs.readFileSync(path.join(__dirname, '..', '..', '..', '..', 'plugins', 'model-apps', 'references', 'rules.md'), 'utf8').replace(/\r\n/g, '\n');
const HEADING = '### Lookup references (Customer, Owner, Regarding and every other lookup)';
const SECTION = RULES.slice(RULES.indexOf(`\n${HEADING}\n`));
const NORMALIZER = [...SECTION.matchAll(/```typescript\n([\s\S]*?)\n```/g)].map((match) => match[1]).find((block) => block.includes('function normalizeLookupReference('));

const LOOKUPS = [{
  table: 'opportunity', column: 'customerid', readProperty: '_customerid_value', targets: ['account', 'contact'],
  paths: [
    { target: 'account', navigationProperty: 'customerid_account', referencedKey: 'accountid' },
    { target: 'contact', navigationProperty: 'customerid_contact', referencedKey: 'contactid' },
  ],
}];

const BODY = `
type Row = Record<string, unknown>;
type Picked = { table: 'account' | 'contact'; id: string };

function PageBody(props: GeneratedComponentProps) {
  const { dataApi } = props;

  async function loadAccountOpportunities(row: Row) {
    const normalized = normalizeLookupReference(row, '_customerid_value', ['account', 'contact']);
    if (normalized.state !== 'resolved') return;
    const reference = normalized.reference;
    if (reference.table !== 'account') return;
    const filter = \`customerid_account/accountid eq \${reference.id}\`;
    return dataApi.queryTable('opportunity', { select: ['name', '_customerid_value'], filter });
  }

  async function loadAll() {
    return dataApi.queryTable('opportunity', { select: ['name', '_customerid_value'], filter: '_customerid_value ne null' });
  }

  async function searchAccounts(searchText: string) {
    const escaped = searchText.replace(/'/g, "''");
    const filter = \`customerid_account/accountid ne null and contains(customerid_account/name,'\${escaped}')\`;
    return dataApi.queryTable('opportunity', { select: ['name'], filter });
  }

  async function openCustomer(row: Row) {
    const normalized = normalizeLookupReference(row, '_customerid_value', ['account', 'contact']);
    if (normalized.state !== 'resolved') return;
    const reference = normalized.reference;
    await Xrm.Navigation.navigateTo({ pageType: 'entityrecord', entityName: reference.table, entityId: reference.id });
  }

  async function readCustomer(row: Row) {
    const normalized = normalizeLookupReference(row, '_customerid_value', ['account', 'contact']);
    if (normalized.state !== 'resolved') return;
    const reference = normalized.reference;
    if (reference.table !== 'account') return;
    return dataApi.retrieveRow('account', { id: reference.id, select: ['name'] });
  }

  async function changeCustomer(opportunityId: string, selected: Picked) {
    const link: \`/account(\${string})\` | \`/contact(\${string})\` = selected.table === 'account'
      ? \`/account(\${selected.id})\`
      : \`/contact(\${selected.id})\`;
    await dataApi.updateRow('opportunity', opportunityId, { _customerid_value: link });
  }

  async function clearCustomer(opportunityId: string) {
    await dataApi.updateRow('opportunity', opportunityId, { _customerid_value: null });
  }

  const label = (row: Row) => String(row['_customerid_value@OData.Community.Display.V1.FormattedValue'] ?? '');
  return <div>{label({})}</div>;
}
`;
const PAGE = `import * as React from 'react';\n\n${NORMALIZER}\n${BODY}`;

function swap(source, from, to) {
  assert.ok(source.includes(from), `the page holds: ${from}`);
  return source.split(from).join(to);
}

test('the canonical normalizer passes', () => {
  assert.ok(NORMALIZER, 'rules.md publishes the normalizer');
  assert.deepEqual(normalizerProblems(PAGE), []);
});

test('an altered, missing or duplicated normalizer is not the canonical one', () => {
  for (const [label, source] of [
    ['the first target as a fallback', swap(PAGE, '(allowedTargets.length === 1 ? allowedTargets[0] : undefined)', 'allowedTargets[0]')],
    ['no conflict check', swap(PAGE, "  if (annotation !== undefined && prefix !== undefined && annotation !== prefix) return { state: 'invalid' };\n", '')],
    ['a looser GUID pattern', swap(PAGE, 'const LOOKUP_GUID = /^[0-9a-fA-F]{8}', 'const LOOKUP_GUID = /[0-9a-fA-F]{8}')],
    ['no normalizer', swap(PAGE, NORMALIZER, '')],
    ['a second one', `${PAGE}\nfunction normalizeLookupReference(row: unknown) { return { state: 'invalid' }; }\n`],
  ]) {
    assert.ok(normalizerProblems(source).length > 0, label);
  }
  // Comments and indentation are not substantive.
  const reindented = swap(PAGE, "  const record = row as Record<string, unknown>;", "    // the row is an object here\n    const record = row as Record<string, unknown>;");
  assert.deepEqual(normalizerProblems(reindented), []);
});

// --- the column check's typed-path context ---------------------------------------------------------------------------------------

const RUNTIME_TYPES = `
export interface TableRegistrations extends BaseTableRegistrations {
    "opportunity": opportunity,
    "account": account,
}
export type opportunity = TableRow<{
    readonly opportunityid: string,
    name: string,
    _customerid_value: \`/account(\${string})\` | \`/contact(\${string})\`,
}>
export type account = TableRow<{
    readonly accountid: string,
    name: string,
}>
`;
const PATH_CONTEXT = { lookupPaths: LOOKUPS[0].paths.map((entry) => ({ table: 'opportunity', ...entry })), targetColumns: { account: ['name'] } };
const filtered = (filter) => [{ name: 'page.tsx', content: `export default function P({ dataApi }) { dataApi.queryTable('opportunity', { select: ['name'], filter: ${JSON.stringify(filter)} }); return null; }` }];

test('with lookup context a typed path is checked whole; without it the column check reads the text exactly as before', () => {
  assert.deepEqual(columnProblems(filtered('customerid_account/accountid ne null'), RUNTIME_TYPES, PATH_CONTEXT), []);
  assert.deepEqual(columnProblems(filtered("contains(customerid_account/name,'x')"), RUNTIME_TYPES, PATH_CONTEXT), []);
  assert.deepEqual(columnProblems(filtered('customerid_contact/contactid ne null'), RUNTIME_TYPES, PATH_CONTEXT), [], 'a target RuntimeTypes does not register is held to its key and verified columns');
  assert.match(columnProblems(filtered('ownerid_team/teamid ne null'), RUNTIME_TYPES, PATH_CONTEXT)[0], /ownerid_team\/teamid, which is not a verified navigation path of opportunity/);
  assert.match(columnProblems(filtered('customerid_account/revenue gt 0'), RUNTIME_TYPES, PATH_CONTEXT)[0], /customerid_account\/revenue, which is not a verified column of account/);
  assert.match(columnProblems(filtered('customerid_contact/fullname ne null'), RUNTIME_TYPES, PATH_CONTEXT)[0], /not a verified column of contact/);
  // Legacy: no context, no exemption for a slash — its parts are read as columns of the queried table, as before.
  assert.deepEqual(columnProblems(filtered('customerid_account/accountid ne null'), RUNTIME_TYPES), [
    "page.tsx: queryTable('opportunity') filter names accountid, which RuntimeTypes.ts does not declare on opportunity",
  ]);
  assert.deepEqual(columnProblems(filtered("name eq 'x'"), RUNTIME_TYPES), [], 'neighbour: a plain column');
  assert.deepEqual(columnProblems(filtered("name eq 'x'"), RUNTIME_TYPES, PATH_CONTEXT), [], 'neighbour: a plain column with context');
});

// ---------- eval 26's synthetic customer values, run through the published normalizer ----------
// The fixture's lookup-rows.json holds synthetic Customer values (account and contact, bare and qualified, null, contradictory and
// foreign evidence, a plural entity set, equal labels, one GUID in two tables), each with the state the normalizer must give it.
// The trusted helper is the rules.md block itself, transpiled with the TypeScript the plugin vendors and called directly — the
// fixture's page module is never executed to find out what it means.
const { loadVendoredTypeScript } = require('../../../../plugins/model-apps/scripts/lib/typescript-compiler.js');
const FIXTURE_26 = path.join(__dirname, '..', 'fixtures', '26-customer-lookup');

function publishedNormalizer() {
  const typescript = loadVendoredTypeScript();
  const { outputText } = typescript.transpileModule(`${NORMALIZER}\nexport { normalizeLookupReference };\n`, {
    fileName: 'normalizer.ts',
    compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2020 },
  });
  const module = { exports: {} };
  new Function('module', 'exports', 'require', outputText)(module, module.exports, () => { throw new Error('the helper imports nothing'); });
  return module.exports.normalizeLookupReference;
}

test('eval 26: every synthetic customer value gets the state lookup-rows.json records, and the resolved ones stay apart by table and id', () => {
  const normalize = publishedNormalizer();
  const { lookup, rows } = JSON.parse(fs.readFileSync(path.join(FIXTURE_26, 'lookup-rows.json'), 'utf8'));
  const metadata = JSON.parse(fs.readFileSync(path.join(FIXTURE_26, 'lookup-metadata.json'), 'utf8'));
  const recorded = metadata.tables.find((table) => table.logicalName === lookup.table).lookups.find((entry) => entry.column === lookup.column);
  assert.deepEqual(recorded.targets, lookup.targets, 'the rows are normalized with the complete target set the metadata read');
  const states = new Set();
  for (const entry of rows) {
    assert.deepEqual(normalize(entry.row, lookup.readProperty, lookup.targets), entry.expected, entry.case);
    states.add(entry.expected.state);
  }
  assert.deepEqual([...states].sort(), ['invalid', 'needs-target', 'resolved', 'unset'], 'every state is exercised');
  // Equal labels, and one GUID in two tables, are different customers: the picker keys them by table and id.
  const resolved = rows.map((entry) => normalize(entry.row, lookup.readProperty, lookup.targets)).filter((result) => result.state === 'resolved');
  const keys = new Set(resolved.map(({ reference }) => `${reference.table}:${reference.id}`));
  const label = (entry) => entry.row['_customerid_value@OData.Community.Display.V1.FormattedValue'];
  const contoso = rows.filter((entry) => label(entry) === 'Contoso').map((entry) => normalize(entry.row, lookup.readProperty, lookup.targets));
  assert.deepEqual(contoso.map(({ reference }) => reference.table), ['account', 'contact']);
  assert.equal(contoso[0].reference.id, contoso[1].reference.id, 'one GUID in both tables');
  assert.ok(keys.has(`account:${contoso[0].reference.id}`) && keys.has(`contact:${contoso[1].reference.id}`));
});
