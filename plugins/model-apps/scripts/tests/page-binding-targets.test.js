'use strict';
// What a rebuild checks of the environment it writes a page's bindings into (lib/page-binding-targets.js).
//
// A binding names what it goes through — a connection reference by its logical name, a Custom API by its unique name — and the page calls it by that name at run time. The spec can state the name and the connector
// it was made for (`connectorId`), and cannot make the reference: so before a rebuild writes a binding it reads the environment's references and Custom APIs for the names the spec states. A reference that
// exists for ANOTHER connector is refused — the page would call that connector under this name, and the name cannot tell them apart — and a name that is not there, or a Custom API of another kind, is said by name.
const { test } = require('node:test');
const assert = require('node:assert');
const { connectorKey, pagesStatingBindings, readBindingTargets, judgeBindingTargets, definedOperations } = require('../lib/page-binding-targets.js');

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
  assert.deepStrictEqual(calls[0].options.select, ['connectionreferencelogicalname', 'connectorid', 'connectionid', '_customconnectorid_value']);
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
  assert.deepStrictEqual(await readBindingTargets(none.provision, [{ key: 'a', name: 'A' }]), { references: null, apis: null, definitions: null, problems: {} });
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

// ── a reference with no connection, and the operations a custom connector defines ──────────────────────────────────────────────
// A reference of the right connector is still no use to a page when it has no connection — what a solution import leaves when no settings file gives one — so that is said by name. And the operations a binding
// calls are the connector's: a connector that is not a custom one has one definition for every environment of its cloud (the one the binding's operations were read from), but a CUSTOM connector's definition is a row of
// the environment it is in — the `connector` table's `openapidefinition`, which the reference points at through `customconnectorid` — and the copy there can be another version than the page was made with.
const WIDGETS = { logicalName: 'contoso_widgets', connectorId: api('shared_contoso-5fwidgets-5f6a8c'), dataset: '', operations: ['ListWidgets', 'GetWidget'] };
const WIDGETS_CONNECTOR = 'c0000000-0000-4000-8000-0000000000a1';
// A custom connector's definition as the `connector` row holds it: a Swagger 2.0 document, as text.
const swaggerOf = (operationIds, extra = {}) => JSON.stringify({
  swagger: '2.0', info: { title: 'Widgets', version: '1.0' }, host: 'widgets.contoso.example',
  paths: Object.fromEntries(operationIds.map((id, i) => [`/widgets/op${i}`, { parameters: [{ name: 'id', in: 'query', type: 'string' }], [i % 2 ? 'post' : 'get']: { operationId: id, responses: { 200: { description: 'OK' } } } }])),
  ...extra,
});
const connected = (row, connectionid = 'shared-connection-0001') => ({ ...row, connectionid });

test('definedOperations reads the operation ids of a Swagger definition — every HTTP method of every path, and nothing else — and null for a text it cannot read as one', () => {
  assert.deepStrictEqual([...definedOperations(swaggerOf(['ListWidgets', 'GetWidget']))], ['ListWidgets', 'GetWidget']);
  const methods = JSON.stringify({ swagger: '2.0', paths: { '/w': { parameters: [], get: { operationId: 'A' }, put: { operationId: 'B' }, post: { operationId: 'C' }, delete: { operationId: 'D' }, options: { operationId: 'E' }, head: { operationId: 'F' }, patch: { operationId: 'G' }, 'x-ms-notification-content': { operationId: 'NotAnOperation' } } } });
  assert.deepStrictEqual([...definedOperations(methods)], ['A', 'B', 'C', 'D', 'E', 'F', 'G'], 'a path item\'s parameters and its extensions are not operations');
  assert.deepStrictEqual([...definedOperations(`\uFEFF${swaggerOf(['X'])}`)], ['X'], 'a byte-order mark is not part of the document');
  assert.deepStrictEqual([...definedOperations(JSON.stringify({ swagger: '2.0', paths: {} }))], [], 'a definition with no operation defines none');
  for (const unreadable of [undefined, null, '', 'not json', '[]', '{}', JSON.stringify({ paths: [] }), JSON.stringify({ paths: { '/w': { $ref: '#/x' } } })]) {
    assert.strictEqual(definedOperations(unreadable), null, JSON.stringify(unreadable));
  }
});

test('readBindingTargets keeps whether a reference has a connection and which custom connector it is for — only when the row says — and reads the definition of a custom connector a binding calls operations of, once', async () => {
  const pages = [
    { key: 'a', name: 'A', connectorBindings: [WIDGETS, WEATHER, SHAREPOINT] },
    { key: 'b', name: 'B', connectorBindings: [{ ...WIDGETS, operations: ['GetWidget'] }] },
  ];
  const { provision, calls } = readerOf({
    connectionreference: [
      connected({ ...reference('contoso_widgets', 'shared_contoso-5fwidgets-5f6a8c'), _customconnectorid_value: WIDGETS_CONNECTOR.toUpperCase() }),
      connected(reference('contoso_msnweather', 'shared_msnweather'), null),
      { ...reference('contoso_sharepoint', 'shared_sharepointonline'), _customconnectorid_value: 'c0000000-0000-4000-8000-0000000000b2' },
    ],
    connector: [{ connectorid: WIDGETS_CONNECTOR, openapidefinition: swaggerOf(['ListWidgets']) }],
  });
  const targets = await readBindingTargets(provision, pages);
  assert.deepStrictEqual(calls.map((c) => c.entity), ['connectionreference', 'connector'], 'the definition of the one custom connector a binding calls operations of: SharePoint\'s binding calls none');
  assert.deepStrictEqual(calls[1].options.select, ['connectorid', 'openapidefinition']);
  assert.strictEqual(calls[1].options.filter, `connectorid eq ${WIDGETS_CONNECTOR}`, 'by its id, once for both pages');
  assert.deepStrictEqual([...targets.references], [
    ['contoso_widgets', { connectorId: api('shared_contoso-5fwidgets-5f6a8c'), connected: true, customConnectorId: WIDGETS_CONNECTOR }],
    ['contoso_msnweather', { connectorId: api('shared_msnweather'), connected: false }],
    ['contoso_sharepoint', { connectorId: api('shared_sharepointonline'), customConnectorId: 'c0000000-0000-4000-8000-0000000000b2' }],
  ], 'a row that does not carry `connectionid` says nothing of a connection');
  assert.deepStrictEqual([...targets.definitions].map(([id, defined]) => [id, [...defined]]), [[WIDGETS_CONNECTOR, ['ListWidgets']]]);
  assert.deepStrictEqual(targets.problems, {});

  // A definition that is not there, or not one this can read, or a read of them that fails, is a problem of that connector's — never "it defines nothing".
  for (const [rows, failOn, expected] of [
    [[], undefined, /no connector row of that id was found/],
    [[{ connectorid: WIDGETS_CONNECTOR, openapidefinition: 'not json' }], undefined, /its definition is not a Swagger document this build can read/],
    [[], ['connector'], /connector: HTTP 403/],
  ]) {
    const reader = readerOf({ connectionreference: [connected({ ...reference('contoso_widgets', 'shared_contoso-5fwidgets-5f6a8c'), _customconnectorid_value: WIDGETS_CONNECTOR })], connector: rows }, { failOn });
    const read = await readBindingTargets(reader.provision, [pages[0]]);
    const defined = read.definitions.get(WIDGETS_CONNECTOR);
    assert.ok(!(defined instanceof Set), JSON.stringify(rows));
    assert.match(defined.problem, expected);
    assert.ok(read.references instanceof Map, 'the references are still judged');
  }

  // A binding that calls no operation, or a reference for no custom connector, needs no definition: nothing more is read.
  const plain = readerOf({ connectionreference: [connected({ ...reference('contoso_widgets', 'shared_contoso-5fwidgets-5f6a8c'), _customconnectorid_value: WIDGETS_CONNECTOR }), connected(reference('contoso_msnweather', 'shared_msnweather'))] });
  const read = await readBindingTargets(plain.provision, [{ key: 'a', name: 'A', connectorBindings: [{ ...WIDGETS, operations: [] }, WEATHER] }]);
  assert.deepStrictEqual(plain.calls.map((c) => c.entity), ['connectionreference']);
  assert.strictEqual(read.definitions, null);
});

const targetsWith = (references, definitions = []) => ({
  references: new Map(references),
  apis: null,
  definitions: new Map(definitions),
  problems: {},
});

test('judgeBindingTargets says by name a reference of the right connector that has no connection — the page\'s calls through it fail until it has one — and says nothing of one whose row did not say', () => {
  const pages = [{ key: 'weather', name: 'Weather', connectorBindings: [WEATHER, SHAREPOINT] }];
  const one = judgeBindingTargets(pages, targetsWith([['contoso_msnweather', { connectorId: api('shared_msnweather'), connected: false }], ['contoso_sharepoint', { connectorId: api('shared_sharepointonline'), connected: true }]]));
  assert.deepStrictEqual(one.findings.map((f) => [f.severity, f.kind, f.page.key, f.names]), [['warn', 'connection-missing', 'weather', ['contoso_msnweather']]]);
  assert.strictEqual(one.findings[0].text, 'page "Weather": connection reference contoso_msnweather is in this environment but has no connection, so the page\'s calls through it fail until it has one. Give it a connection (import the solution that holds it with a settings file that does: solution-settings.js, or set it in Power Apps, in the solution\'s connection references) and the page works without a rebuild');
  const both = judgeBindingTargets(pages, targetsWith([['contoso_msnweather', { connectorId: api('shared_msnweather'), connected: false }], ['contoso_sharepoint', { connectorId: api('shared_sharepointonline'), connected: false }]]));
  assert.match(both.findings[0].text, /^page "Weather": connection references contoso_msnweather, contoso_sharepoint are in this environment but have no connection, so the page's calls through them fail until they have one\. Give them a connection/);
  const unknown = judgeBindingTargets(pages, targetsWith([['contoso_msnweather', { connectorId: api('shared_msnweather') }], ['contoso_sharepoint', { connectorId: api('shared_sharepointonline') }]]));
  assert.deepStrictEqual(unknown, { findings: [], unchecked: [] });
  // A reference for another connector is refused, and nothing else is said of it.
  const conflict = judgeBindingTargets(pages, targetsWith([['contoso_msnweather', { connectorId: api('shared_office365users'), connected: false }], ['contoso_sharepoint', { connectorId: api('shared_sharepointonline'), connected: true }]]));
  assert.deepStrictEqual(conflict.findings.map((f) => f.kind), ['connector-conflict']);
});

test('judgeBindingTargets says by name an operation a binding calls that the custom connector of its reference does not define here — a warning, the page is written — and nothing for one it defines', () => {
  const widgetsReference = { connectorId: WIDGETS.connectorId, connected: true, customConnectorId: WIDGETS_CONNECTOR };
  const pages = [{ key: 'widgets', name: 'Widgets', connectorBindings: [WIDGETS, { ...WIDGETS }] }];
  const verdict = judgeBindingTargets(pages, targetsWith([['contoso_widgets', widgetsReference]], [[WIDGETS_CONNECTOR, new Set(['ListWidgets'])]]));
  assert.deepStrictEqual(verdict.findings.map((f) => [f.severity, f.kind, f.binding, f.operations]), [['warn', 'operation-missing', 'contoso_widgets', ['GetWidget']]], 'said once for the binding, however often the page lists it');
  assert.strictEqual(verdict.findings[0].text, 'page "Widgets": connector binding "contoso_widgets" calls operation GetWidget, which the custom connector that connection reference is for in this environment does not define, so the page\'s call to it fails there until it does (import the solution that holds the connector as the page was made with it)');
  const several = judgeBindingTargets(pages, targetsWith([['contoso_widgets', widgetsReference]], [[WIDGETS_CONNECTOR, new Set(['Other'])]]));
  assert.match(several.findings[0].text, /calls operations ListWidgets, GetWidget, which the custom connector that connection reference is for in this environment does not define, so the page's calls to them fail there until it does/);
  const defined = judgeBindingTargets(pages, targetsWith([['contoso_widgets', widgetsReference]], [[WIDGETS_CONNECTOR, new Set(['ListWidgets', 'GetWidget', 'DeleteWidget'])]]));
  assert.deepStrictEqual(defined, { findings: [], unchecked: [] });
  // Matched exactly, as the connector matches an operation id: another case is another operation.
  const cased = judgeBindingTargets(pages, targetsWith([['contoso_widgets', widgetsReference]], [[WIDGETS_CONNECTOR, new Set(['listwidgets', 'GetWidget'])]]));
  assert.deepStrictEqual(cased.findings.map((f) => f.operations), [['ListWidgets']]);
  // A connector that is not a custom one has its operations in every environment of its cloud: a reference for the same connector is never asked for a definition, and nothing is said.
  const managed = judgeBindingTargets([{ key: 'weather', name: 'Weather', connectorBindings: [WEATHER] }], targetsWith([['contoso_msnweather', { connectorId: WEATHER.connectorId, connected: true }]]));
  assert.deepStrictEqual(managed, { findings: [], unchecked: [] });
});

test('judgeBindingTargets says which operations it could not check, and why — a definition it could not read is never one that defines nothing', () => {
  const widgetsReference = { connectorId: WIDGETS.connectorId, connected: true, customConnectorId: WIDGETS_CONNECTOR };
  const pages = [{ key: 'widgets', name: 'Widgets', connectorBindings: [WIDGETS] }];
  const verdict = judgeBindingTargets(pages, targetsWith([['contoso_widgets', widgetsReference]], [[WIDGETS_CONNECTOR, { problem: 'connector: HTTP 403' }]]));
  assert.deepStrictEqual(verdict.findings, []);
  assert.deepStrictEqual(verdict.unchecked.map((u) => u.text), ['could not read the definition of the custom connector that connection reference contoso_widgets is for in this environment (connector: HTTP 403), so the operations connector binding "contoso_widgets" of page "Widgets" calls were not checked against it']);
  const notRead = judgeBindingTargets(pages, { references: new Map([['contoso_widgets', widgetsReference]]), apis: null, problems: {} });
  assert.match(notRead.unchecked[0].text, /\(its definition was not read\)/);
});
