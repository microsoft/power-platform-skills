'use strict';
// What a rebuild checks of the environment it writes a page's bindings into (lib/page-binding-targets.js).
//
// A binding names what it goes through — a connection reference by its logical name, a Custom API by its unique name — and the page calls it by that name at run time. The spec can state the name and the connector
// it was made for (`connectorId`), and cannot make the reference: so before a rebuild writes a binding it reads the environment's references and Custom APIs for the names the spec states. A reference that
// exists for ANOTHER connector is refused — the page would call that connector under this name, and the name cannot tell them apart — and a name that is not there, or a Custom API of another kind, is said by name.
const { test } = require('node:test');
const assert = require('node:assert');
const { connectorKey, pagesStatingBindings, readBindingTargets, judgeBindingTargets } = require('../lib/page-binding-targets.js');

const WEATHER = { logicalName: 'contoso_msnweather', connectorId: '/providers/Microsoft.PowerApps/apis/shared_msnweather', dataset: '', operations: ['CurrentWeather'] };
const SHAREPOINT = { logicalName: 'contoso_sharepoint', connectorId: '/providers/Microsoft.PowerApps/apis/shared_sharepointonline', dataset: 'https://contoso.sharepoint.com/sites/x', tables: ['11111111-2222-3333-4444-555555555555'] };
const APPROVE = { name: 'contoso_ApproveOrder', isFunction: false, boundEntityLogicalName: 'contoso_item' };
const SUMMARY = { name: 'contoso_GetSummary', isFunction: true };
const api = (apiFor) => `/providers/Microsoft.PowerApps/apis/${apiFor}`;
const reference = (logicalName, connector) => ({ connectionreferencelogicalname: logicalName, connectorid: connector === undefined ? undefined : api(connector) });
const customApi = (uniquename, extra = {}) => ({ uniquename, isfunction: false, bindingtype: 0, ...extra });

test('connectorKey is the name of the connector, whatever form its id is written in', () => {
  for (const id of ['/providers/Microsoft.PowerApps/apis/shared_msnweather', 'shared_msnweather', 'SHARED_MsnWeather', ' /providers/Microsoft.PowerApps/apis/shared_msnweather/ ', '/providers/Microsoft.PowerApps/apis/SHARED_MSNWEATHER']) {
    assert.strictEqual(connectorKey(id), 'shared_msnweather', JSON.stringify(id));
  }
  assert.strictEqual(connectorKey('/providers/Microsoft.PowerApps/apis/shared_contoso-5fwidgets-5f6a8c'), 'shared_contoso-5fwidgets-5f6a8c', 'a custom connector\'s id differs in every environment');
  for (const id of [undefined, null, '', '   ', '/', 42, {}, []]) assert.strictEqual(connectorKey(id), null, JSON.stringify(id));
});

// ── which pages, which names ─────────────────────────────────────────────────────────────────────────────────────────────────

const pageOf = (key, extra = {}) => ({ key, name: key.toUpperCase(), source: { kind: 'tsx', codeFile: `${key}.tsx` }, ...extra });

test('pagesStatingBindings is the pages a build writes that state a binding — and only the lists they state', () => {
  const spec = { pages: [
    pageOf('weather', { connectorBindings: [WEATHER, SHAREPOINT], actionBindings: [] }),
    pageOf('plain'),
    pageOf('empty', { connectorBindings: [], actionBindings: [] }),
    pageOf('orders', { actionBindings: [APPROVE] }),
    { key: 'noSource', name: 'NOSOURCE', connectorBindings: [WEATHER] },
    { key: 'legacy', name: 'LEGACY', codeFile: 'legacy.tsx', connectorBindings: [WEATHER] },
  ] };
  assert.deepStrictEqual(pagesStatingBindings(spec), [
    { key: 'weather', name: 'WEATHER', connectorBindings: [WEATHER, SHAREPOINT], actionBindings: [] },
    { key: 'orders', name: 'ORDERS', actionBindings: [APPROVE] },
    { key: 'legacy', name: 'LEGACY', connectorBindings: [WEATHER] },
  ]);
  assert.deepStrictEqual(pagesStatingBindings({ pages: [] }), []);
  assert.deepStrictEqual(pagesStatingBindings({}), []);
});

test('pagesStatingBindings: a changed-only run writes the pages it selected, and the navigation targets it may have to make — and no other', () => {
  const spec = { pages: [
    pageOf('a', { connectorBindings: [WEATHER] }),
    pageOf('b', { connectorBindings: [SHAREPOINT], navigatesTo: [{ targetKey: 'c' }] }),
    pageOf('c', { actionBindings: [APPROVE] }),
    pageOf('d', { actionBindings: [SUMMARY] }),
  ] };
  const keys = (changedOnly) => pagesStatingBindings(spec, { changedOnly }).map((p) => p.key);
  assert.deepStrictEqual(keys(undefined), ['a', 'b', 'c', 'd'], 'a full build writes every page');
  assert.deepStrictEqual(keys({ selectedKeys: ['a'] }), ['a', 'c'], 'the selected page, and c, which b navigates to');
  assert.deepStrictEqual(keys({ selectedKeys: [] }), ['c']);
  assert.deepStrictEqual(keys({ resolvedAppId: 'x' }), ['a', 'b', 'c', 'd'], 'a changed-only run that selects nothing by key is not narrowed');
});

// ── reading the environment ──────────────────────────────────────────────────────────────────────────────────────────────────

function readerOf(rows, { failOn } = {}) {
  const calls = [];
  const provision = {
    queryRecords: async (entity, options) => {
      calls.push({ entity, options });
      if (failOn && failOn.includes(entity)) throw new Error(`${entity}: HTTP 403`);
      return rows[entity] || [];
    },
  };
  return { provision, calls };
}

test('readBindingTargets reads the references and the Custom APIs for the names the pages state — once each, by name — and nothing when no page states one', async () => {
  const pages = [
    { key: 'a', name: 'A', connectorBindings: [WEATHER, SHAREPOINT], actionBindings: [APPROVE] },
    { key: 'b', name: 'B', connectorBindings: [{ ...WEATHER, logicalName: 'CONTOSO_MSNWEATHER' }, { dataset: 'x' }], actionBindings: [SUMMARY, APPROVE] },
  ];
  const { provision, calls } = readerOf({
    connectionreference: [reference('contoso_msnweather', 'shared_msnweather'), reference('contoso_other', 'shared_other')],
    customapi: [customApi('contoso_ApproveOrder', { boundentitylogicalname: 'contoso_item', bindingtype: 1 }), customApi('contoso_GetSummary', { isfunction: true })],
  });
  const targets = await readBindingTargets(provision, pages);
  assert.deepStrictEqual(calls.map((c) => c.entity), ['connectionreference', 'customapi']);
  assert.deepStrictEqual(calls[0].options.select, ['connectionreferencelogicalname', 'connectorid']);
  assert.strictEqual(calls[0].options.paginate, true);
  assert.strictEqual(calls[0].options.filter, "connectionreferencelogicalname eq 'contoso_msnweather' or connectionreferencelogicalname eq 'contoso_sharepoint'", 'each name once');
  assert.deepStrictEqual(calls[1].options.select, ['uniquename', 'isfunction', 'bindingtype', 'boundentitylogicalname']);
  assert.strictEqual(calls[1].options.filter, "uniquename eq 'contoso_ApproveOrder' or uniquename eq 'contoso_GetSummary'", 'as the spec spells them: the service compares them without regard to case, and a name is matched here in lower case');
  // Only the names asked for are kept, whatever the service answered, by lower-cased name.
  assert.deepStrictEqual([...targets.references], [['contoso_msnweather', { connectorId: api('shared_msnweather') }]]);
  assert.deepStrictEqual([...targets.apis], [
    ['contoso_approveorder', { isFunction: false, boundEntity: 'contoso_item' }],
    ['contoso_getsummary', { isFunction: true }],
  ]);
  assert.deepStrictEqual(targets.problems, {});

  const none = readerOf({});
  assert.deepStrictEqual(await readBindingTargets(none.provision, [{ key: 'a', name: 'A' }]), { references: null, apis: null, problems: {} });
  assert.deepStrictEqual(none.calls, [], 'no page states a binding: nothing is read');
  const onlyReferences = readerOf({});
  await readBindingTargets(onlyReferences.provision, [{ key: 'a', name: 'A', connectorBindings: [WEATHER] }]);
  assert.deepStrictEqual(onlyReferences.calls.map((c) => c.entity), ['connectionreference'], 'and a Custom API is read only when a page binds one');
});

test('readBindingTargets quotes a name into the filter as OData text, reads many names in chunks, and says what it could not read instead of throwing', async () => {
  const odd = readerOf({});
  await readBindingTargets(odd.provision, [{ key: 'a', name: 'A', connectorBindings: [{ logicalName: "o'brien_x" }] }]);
  assert.strictEqual(odd.calls[0].options.filter, "connectionreferencelogicalname eq 'o''brien_x'");

  const many = readerOf({});
  const bindings = Array.from({ length: 51 }, (_, i) => ({ logicalName: `contoso_ref${String(i).padStart(2, '0')}` }));
  await readBindingTargets(many.provision, [{ key: 'a', name: 'A', connectorBindings: bindings }]);
  assert.deepStrictEqual(many.calls.map((c) => c.options.filter.split(' or ').length), [25, 25, 1], 'a request is bounded: the filter of a long list is not');

  const denied = readerOf({}, { failOn: ['connectionreference'] });
  const targets = await readBindingTargets(denied.provision, [{ key: 'a', name: 'A', connectorBindings: [WEATHER], actionBindings: [APPROVE] }]);
  assert.strictEqual(targets.references, null);
  assert.deepStrictEqual(targets.problems, { references: 'connectionreference: HTTP 403' });
  assert.ok(targets.apis instanceof Map, 'the other read is still made');
  const cannot = await readBindingTargets({}, [{ key: 'a', name: 'A', connectorBindings: [WEATHER] }]);
  assert.strictEqual(cannot.references, null);
  assert.match(cannot.problems.references, /cannot be read here/, 'a reader that cannot read is a read that failed');
});

// ── judging what was read ────────────────────────────────────────────────────────────────────────────────────────────────────

const pagesA = [{ key: 'weather', name: 'Weather', connectorBindings: [WEATHER, SHAREPOINT], actionBindings: [APPROVE, SUMMARY] }];
const targetsOf = ({ references = [], apis = [], problems = {} } = {}) => ({
  references: new Map(references.map(([name, connector]) => [name, { connectorId: connector === undefined ? undefined : api(connector) }])),
  apis: new Map(apis.map(([name, value]) => [name, value])),
  problems,
});

test('judgeBindingTargets: a reference of the same name for the SAME connector, in any form of its id, is fine — and a Custom API of the same kind and table', () => {
  const verdict = judgeBindingTargets(pagesA, targetsOf({
    references: [['contoso_msnweather', 'SHARED_MSNWEATHER'], ['contoso_sharepoint', 'shared_sharepointonline']],
    apis: [['contoso_approveorder', { isFunction: false, boundEntity: 'CONTOSO_ITEM' }], ['contoso_getsummary', { isFunction: true }]],
  }));
  assert.deepStrictEqual(verdict, { findings: [], unchecked: [] });
});

test('judgeBindingTargets refuses a reference that exists for ANOTHER connector, naming the page, the binding and both connectors', () => {
  const verdict = judgeBindingTargets(pagesA, targetsOf({
    references: [['contoso_msnweather', 'shared_office365users'], ['contoso_sharepoint', 'shared_sharepointonline']],
    apis: [['contoso_approveorder', { isFunction: false, boundEntity: 'contoso_item' }], ['contoso_getsummary', { isFunction: true }]],
  }));
  assert.strictEqual(verdict.findings.length, 1);
  const [conflict] = verdict.findings;
  assert.deepStrictEqual({ ...conflict, text: undefined }, { severity: 'refuse', kind: 'connector-conflict', page: { key: 'weather', name: 'Weather' }, binding: 'contoso_msnweather', expected: 'shared_msnweather', found: 'shared_office365users', text: undefined });
  assert.strictEqual(conflict.text, 'page "Weather": connector binding "contoso_msnweather" is for connector shared_msnweather, but the connection reference of that name in this environment is for connector shared_office365users');
});

test('judgeBindingTargets cannot prove a conflict from a connector that is not stated on both sides — it says nothing then, and a reference with no connector is not a conflict', () => {
  const pages = [{ key: 'a', name: 'A', connectorBindings: [{ logicalName: 'contoso_one' }, { logicalName: 'contoso_two', connectorId: api('shared_two') }, { logicalName: 'contoso_three', connectorId: '' }] }];
  const verdict = judgeBindingTargets(pages, targetsOf({ references: [['contoso_one', 'shared_x'], ['contoso_two', undefined], ['contoso_three', 'shared_y']] }));
  assert.deepStrictEqual(verdict, { findings: [], unchecked: [] });
});

test('judgeBindingTargets says by name which references and Custom APIs the environment does not have — one line per page, in the page\'s order', () => {
  const pages = [
    { key: 'weather', name: 'Weather', connectorBindings: [WEATHER, SHAREPOINT, { ...WEATHER }], actionBindings: [APPROVE] },
    { key: 'other', name: 'Other', actionBindings: [SUMMARY] },
  ];
  const verdict = judgeBindingTargets(pages, targetsOf({ references: [['contoso_sharepoint', 'shared_sharepointonline']] }));
  assert.deepStrictEqual(verdict.findings.map((f) => [f.severity, f.kind, f.page.key, f.names]), [
    ['warn', 'reference-missing', 'weather', ['contoso_msnweather']],
    ['warn', 'api-missing', 'weather', ['contoso_ApproveOrder']],
    ['warn', 'api-missing', 'other', ['contoso_GetSummary']],
  ]);
  assert.strictEqual(verdict.findings[0].text, 'page "Weather": connection reference contoso_msnweather is not in this environment, so the page is written with a binding it cannot resolve yet. A page finds its connector by the reference\'s logical name: create the reference here (create-connection-reference.js, or import the solution that holds it) and the page works without a rebuild');
  assert.strictEqual(verdict.findings[1].text, 'page "Weather": Custom API contoso_ApproveOrder is not in this environment (list-custom-apis.js lists what it has), so a call through the binding is refused until it is deployed here');
  const several = judgeBindingTargets([{ key: 'a', name: 'A', connectorBindings: [WEATHER, SHAREPOINT], actionBindings: [APPROVE, SUMMARY] }], targetsOf());
  assert.match(several.findings[0].text, /^page "A": connection references contoso_msnweather, contoso_sharepoint are not in this environment, so the page is written with bindings it cannot resolve yet\./);
  assert.match(several.findings[1].text, /^page "A": Custom APIs contoso_ApproveOrder, contoso_GetSummary are not in this environment/);
});

test('judgeBindingTargets warns of a Custom API that is the other kind, or bound to another table — the runtime refuses such a call, so it is a warning and never a refusal', () => {
  const verdict = judgeBindingTargets(pagesA, targetsOf({
    references: [['contoso_msnweather', 'shared_msnweather'], ['contoso_sharepoint', 'shared_sharepointonline']],
    apis: [['contoso_approveorder', { isFunction: true, boundEntity: 'contoso_item' }], ['contoso_getsummary', { isFunction: true, boundEntity: 'contoso_other' }]],
  }));
  assert.deepStrictEqual(verdict.findings.map((f) => [f.severity, f.kind, f.binding]), [['warn', 'api-mismatch', 'contoso_ApproveOrder'], ['warn', 'api-mismatch', 'contoso_GetSummary']]);
  assert.strictEqual(verdict.findings[0].text, 'page "Weather": Custom API binding "contoso_ApproveOrder" says it is an Action, but the Custom API of that name in this environment is a Function — the runtime refuses the call (wrong_operation_kind)');
  assert.strictEqual(verdict.findings[1].text, 'page "Weather": Custom API binding "contoso_GetSummary" is for a Global operation, but the Custom API of that name in this environment is bound to table contoso_other — the runtime refuses the call (invalid_bound_to)');
  const unbound = judgeBindingTargets([{ key: 'a', name: 'A', actionBindings: [APPROVE] }], targetsOf({ apis: [['contoso_approveorder', { isFunction: false }]] }));
  assert.strictEqual(unbound.findings[0].text, 'page "A": Custom API binding "contoso_ApproveOrder" is bound to table contoso_item, but the Custom API of that name in this environment is Global — the runtime refuses the call (invalid_bound_to)');
  const differentTable = judgeBindingTargets([{ key: 'a', name: 'A', actionBindings: [APPROVE] }], targetsOf({ apis: [['contoso_approveorder', { isFunction: false, boundEntity: 'contoso_other' }]] }));
  assert.strictEqual(differentTable.findings[0].text, 'page "A": Custom API binding "contoso_ApproveOrder" is bound to table contoso_item, but the Custom API of that name in this environment is bound to table contoso_other — the runtime refuses the call (invalid_bound_to)');
  // An Action the binding does not say is a Function is an Action: the documented default.
  const defaulted = judgeBindingTargets([{ key: 'a', name: 'A', actionBindings: [{ name: 'contoso_Plain' }] }], targetsOf({ apis: [['contoso_plain', { isFunction: false }]] }));
  assert.deepStrictEqual(defaulted.findings, []);
});

test('judgeBindingTargets says what it could not check — and does not call a name missing when the read that would have found it failed', () => {
  const verdict = judgeBindingTargets(pagesA, { references: null, apis: null, problems: { references: 'HTTP 403', apis: 'HTTP 500' } });
  assert.deepStrictEqual(verdict.findings, []);
  assert.deepStrictEqual(verdict.unchecked.map((u) => u.text), [
    'could not read this environment\'s connection references (HTTP 403), so the connector bindings of page "Weather" were not checked against them',
    'could not read this environment\'s Custom APIs (HTTP 500), so the Custom API bindings of page "Weather" were not checked against them',
  ]);
  const both = judgeBindingTargets([...pagesA, { key: 'b', name: 'B', connectorBindings: [WEATHER] }], { references: null, apis: new Map(), problems: { references: 'x' } });
  assert.match(both.unchecked[0].text, /so the connector bindings of pages "Weather", "B" were not checked against them$/);
  assert.deepStrictEqual(both.findings.map((f) => f.kind), ['api-missing'], 'the Custom APIs that were read are still judged');
});

test('a name is quoted the way a spec writes it, and a long or odd one is shortened — a message never carries more of a name than it needs', () => {
  const long = `contoso_${'x'.repeat(200)}`;
  const verdict = judgeBindingTargets([{ key: 'a', name: 'A', connectorBindings: [{ logicalName: long }] }], targetsOf());
  assert.ok(verdict.findings[0].text.length < 500, String(verdict.findings[0].text.length));
  assert.ok(!verdict.findings[0].text.includes(long));
});
