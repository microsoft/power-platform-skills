'use strict';
// What an App Spec states of a generative page's connector and Custom API bindings, and what a rebuild does with it (lib/page-bindings.js).
//
// A binding a page holds can carry more than the runtime reads: a connection id of the environment it was made in, a credential someone put in a connectors.json (genpage-upload.js takes any JSON array),
// a property a later runtime adds. The spec is committed, reviewed and shared, so it states a binding by an ALLOWLIST of the properties references/connectors.md and references/custom-api.md document, each
// with the kind of value it holds — never a value that can carry a secret by shape (an object, a nested list) — and the rest is left out and named. A rebuild into the environment a page came from then has
// to leave on the page what the spec could not state: mergeBindings is that rule, and what planEdits (genpage-sdk.js) reads a list as "already holds" with.
const { test } = require('node:test');
const assert = require('node:assert');
const {
  PAGE_BINDINGS,
  BINDING_PROPERTIES,
  PARAMETER_KINDS,
  UNUSUAL_NAME,
  statableBinding,
  statableBindings,
  bindingProblemText,
  mergeBindings,
} = require('../lib/page-bindings.js');
const { PARAMETER_KIND_BY_TYPE } = require('../list-custom-apis.js');

const WEATHER = { logicalName: 'contoso_msnweather', connectorId: '/providers/Microsoft.PowerApps/apis/shared_msnweather', dataset: '', operations: ['CurrentWeather'] };
const SHAREPOINT = { logicalName: 'contoso_sharepoint', connectorId: '/providers/Microsoft.PowerApps/apis/shared_sharepointonline', dataset: 'https://contoso.sharepoint.com/sites/x', tables: ['11111111-2222-3333-4444-555555555555'], tableDisplayNames: ['Pets'] };
const APPROVE = { name: 'contoso_ApproveOrder', isFunction: false, boundEntityLogicalName: 'contoso_item', displayName: 'Approve order', parameterKinds: { Comment: 'String' } };

// A page's own entries: the spec's plus what a spec does not state.
const HELD_WEATHER = { ...WEATHER, connectionId: 'env-local-connection-placeholder', futureProperty: { kept: true } };
const HELD_SHAREPOINT = { ...SHAREPOINT, apiKey: 'SYNTHETIC_TEST_SECRET' };

const deepFreeze = (value) => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value)) deepFreeze(inner);
  }
  return value;
};

// ── the allowlist ────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('the properties a spec states of a binding are the ones the references document, and the Custom API parameter kinds are the ones the discovery script writes', () => {
  assert.deepStrictEqual(PAGE_BINDINGS, { connectorBindings: 'logicalName', actionBindings: 'name' });
  assert.deepStrictEqual(BINDING_PROPERTIES, {
    connectorBindings: ['logicalName', 'connectorId', 'dataset', 'tables', 'tableDisplayNames', 'operations'],
    actionBindings: ['name', 'isFunction', 'boundEntityLogicalName', 'displayName', 'parameterKinds'],
  });
  // The identity of an entry is one of its properties: a spec that cannot state it cannot state the binding.
  for (const [kind, identity] of Object.entries(PAGE_BINDINGS)) assert.ok(BINDING_PROPERTIES[kind].includes(identity), kind);
  assert.deepStrictEqual([...PARAMETER_KINDS].sort(), Object.values(PARAMETER_KIND_BY_TYPE).sort(), 'list-custom-apis.js writes exactly these kinds into parameterKinds');
});

test('statableBinding keeps the properties a spec states, in the entry\'s own order and as copies, and leaves out every other property by its name', () => {
  const entry = { connectionId: 'x', dataset: 'd', logicalName: 'contoso_a', credentials: { accessToken: 't' }, connectorId: '/providers/Microsoft.PowerApps/apis/shared_a', tables: ['t1'], operations: ['Op'], zzz: 1 };
  const { stated, leftOut } = statableBinding('connectorBindings', entry);
  assert.deepStrictEqual(Object.keys(stated), ['dataset', 'logicalName', 'connectorId', 'tables', 'operations'], 'the page\'s own order');
  assert.deepStrictEqual(stated, { dataset: 'd', logicalName: 'contoso_a', connectorId: '/providers/Microsoft.PowerApps/apis/shared_a', tables: ['t1'], operations: ['Op'] });
  assert.deepStrictEqual(leftOut, [{ property: 'connectionId', why: 'not-stated' }, { property: 'credentials', why: 'not-stated' }, { property: 'zzz', why: 'not-stated' }], 'by name, in code-unit order');
  stated.tables.push('t2');
  assert.deepStrictEqual(entry.tables, ['t1'], 'a copy: changing what is stated does not change the page\'s entry');
  // The same property is not one for the other kind of binding.
  assert.deepStrictEqual(statableBinding('actionBindings', { name: 'contoso_a', logicalName: 'contoso_a' }), { stated: { name: 'contoso_a' }, leftOut: [{ property: 'logicalName', why: 'not-stated' }] });
  assert.deepStrictEqual(statableBinding('connectorBindings', {}), { stated: {}, leftOut: [] });
});

test('each property is stated only with the kind of value it holds: a text, a list of texts, a flag, a map of Dataverse parameter kinds', () => {
  const left = (kind, property, value) => statableBinding(kind, { [property]: value }).leftOut.map((l) => `${l.property}:${l.why}`);
  for (const property of ['logicalName', 'connectorId', 'dataset']) {
    assert.deepStrictEqual(left('connectorBindings', property, 'ok'), []);
    assert.deepStrictEqual(left('connectorBindings', property, ''), [], 'an empty text is a text: the SharePoint-less weather binding has dataset ""');
    for (const value of [1, true, null, ['a'], { a: 'b' }]) assert.deepStrictEqual(left('connectorBindings', property, value), [`${property}:not-text`], `${property} = ${JSON.stringify(value)}`);
  }
  for (const property of ['tables', 'tableDisplayNames', 'operations']) {
    assert.deepStrictEqual(left('connectorBindings', property, []), []);
    assert.deepStrictEqual(left('connectorBindings', property, ['a', 'b']), []);
    for (const value of ['a', 1, null, { a: 'b' }, ['a', 1], ['a', { id: 'x', clientSecret: 's' }], [['a']], ['a', null]]) assert.deepStrictEqual(left('connectorBindings', property, value), [`${property}:not-text-list`], `${property} = ${JSON.stringify(value)}`);
  }
  for (const property of ['name', 'boundEntityLogicalName', 'displayName']) {
    assert.deepStrictEqual(left('actionBindings', property, 'ok'), []);
    for (const value of [1, false, ['a'], { en: 'x' }]) assert.deepStrictEqual(left('actionBindings', property, value), [`${property}:not-text`], `${property} = ${JSON.stringify(value)}`);
  }
  assert.deepStrictEqual(left('actionBindings', 'isFunction', true), []);
  assert.deepStrictEqual(left('actionBindings', 'isFunction', false), []);
  for (const value of ['true', 0, null, [], {}]) assert.deepStrictEqual(left('actionBindings', 'isFunction', value), ['isFunction:not-boolean'], JSON.stringify(value));

  assert.deepStrictEqual(left('actionBindings', 'parameterKinds', {}), []);
  assert.deepStrictEqual(left('actionBindings', 'parameterKinds', Object.fromEntries(PARAMETER_KINDS.map((kind, i) => [`Param${i}`, kind]))), [], 'every kind the discovery script writes');
  for (const value of [{ Comment: 'Text' }, { Comment: 1 }, { Comment: null }, { Comment: { kind: 'String' } }, { 'not a name': 'String' }, { '': 'String' }, ['String'], 'String', null, 7, { [`${'p'.repeat(129)}`]: 'String' }]) {
    assert.deepStrictEqual(left('actionBindings', 'parameterKinds', value), ['parameterKinds:not-parameter-kinds'], JSON.stringify(value));
  }
});

test('a text that holds a credential is not stated, whatever its property — and an ordinary dataset, table name or label is', () => {
  const credentialShaped = [
    'https://admin:hunter2@contoso.sharepoint.com/sites/x',
    'ftp://user:pw@host/path',
    'https://contoso.blob.core.windows.net/c?sv=2022-11-02&sig=abc123',
    'GetItems?token=abc',
    'Server=sql.contoso.net;Database=Sales;Password=hunter2',
    'Server=sql.contoso.net; Database=Sales; PWD = hunter2',
    'accountKey=abc',
    'AccessToken=abc',
    'client_secret=abc',
    'api-key=abc',
    'SharedAccessSignature=abc',
    'Bearer abcdefgh12345',
    'bearer abcdefgh.ijklmnop',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc',
  ];
  for (const text of credentialShaped) {
    for (const [kind, property] of [['connectorBindings', 'dataset'], ['connectorBindings', 'logicalName'], ['actionBindings', 'displayName']]) {
      assert.deepStrictEqual(statableBinding(kind, { [property]: text }).leftOut, [{ property, why: 'credential-shaped' }], `${property}: ${text}`);
    }
    assert.deepStrictEqual(statableBinding('connectorBindings', { operations: ['Fine', text] }).leftOut, [{ property: 'operations', why: 'credential-shaped' }], `in a list: ${text}`);
  }
  const ordinary = [
    'https://contoso.sharepoint.com/sites/x',
    'https://contoso.sharepoint.com/sites/Team Docs/Lists/Pets',
    'sql.contoso.net,Sales',
    '5709dd6f-c73e-4079-ad23-2334e45e0e13',
    'Approve order',
    'Orders: open & closed',
    'Tokens and keys',
    'Q&A, answered',
    '/providers/Microsoft.PowerApps/apis/shared_msnweather',
    'Get_rows_by_ID',
  ];
  for (const text of ordinary) assert.deepStrictEqual(statableBinding('connectorBindings', { dataset: text, tableDisplayNames: [text] }).leftOut, [], text);
});

test('a text with a control character, or longer than a spec states, is left out; so is a list of too many', () => {
  assert.deepStrictEqual(statableBinding('connectorBindings', { dataset: 'a\nb' }).leftOut, [{ property: 'dataset', why: 'not-text' }]);
  assert.deepStrictEqual(statableBinding('connectorBindings', { dataset: 'a'.repeat(2048) }).leftOut, []);
  assert.deepStrictEqual(statableBinding('connectorBindings', { dataset: 'a'.repeat(2049) }).leftOut, [{ property: 'dataset', why: 'too-long' }]);
  assert.deepStrictEqual(statableBinding('connectorBindings', { tables: Array.from({ length: 1000 }, (_, i) => `t${i}`) }).leftOut, []);
  assert.deepStrictEqual(statableBinding('connectorBindings', { tables: Array.from({ length: 1001 }, (_, i) => `t${i}`) }).leftOut, [{ property: 'tables', why: 'too-long' }]);
});

test('a property is named in a report only when its name is a plain identifier — a name can carry a value too', () => {
  const entry = { 'Authorization: Bearer abc': 1, 'sk-live-abc': 2, 'has space': 3, '': 4, [`x${'y'.repeat(60)}`]: 5, connectionId: 6, _private: 7 };
  const left = statableBinding('connectorBindings', entry).leftOut.map((l) => l.property);
  assert.deepStrictEqual(left.filter((p) => p === UNUSUAL_NAME).length, 6, 'six names that are not plain identifiers');
  assert.ok(left.includes('connectionId'));
  assert.strictEqual(UNUSUAL_NAME, '(a property with an unusual name)');
  assert.ok(!left.some((p) => /Bearer|sk-live|space/.test(p)));
});

// ── a list ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('statableBindings projects a list entry by entry, says which entry left what out, names the entry by what a spec states of it, and finds an entry that states nothing', () => {
  const list = [HELD_WEATHER, { credentials: { accessToken: 't' } }, HELD_SHAREPOINT, WEATHER];
  const { stated, leftOut, blank } = statableBindings('connectorBindings', list);
  assert.deepStrictEqual(stated, [WEATHER, {}, SHAREPOINT, WEATHER]);
  assert.deepStrictEqual(blank, [1], 'the second entry holds nothing a spec states');
  assert.deepStrictEqual(leftOut, [
    { entry: 0, binding: 'contoso_msnweather', properties: [{ property: 'connectionId', why: 'not-stated' }, { property: 'futureProperty', why: 'not-stated' }] },
    { entry: 1, properties: [{ property: 'credentials', why: 'not-stated' }] },
    { entry: 2, binding: 'contoso_sharepoint', properties: [{ property: 'apiKey', why: 'not-stated' }] },
  ]);
  assert.deepStrictEqual(statableBindings('actionBindings', []), { stated: [], leftOut: [], blank: [] });
});

test('an entry is named only by an identity a spec can state: one that is not a text, or holds a credential, is not echoed', () => {
  const { leftOut } = statableBindings('connectorBindings', [{ logicalName: 'Bearer abcdefgh12345', connectionId: 'x' }, { logicalName: { a: 1 }, connectionId: 'x' }]);
  assert.deepStrictEqual(leftOut.map((l) => 'binding' in l), [false, false]);
});

// ── what a validator says ────────────────────────────────────────────────────────────────────────────────────────────────────

test('bindingProblemText says what is wrong with a property in words that quote its name and never its value', () => {
  assert.strictEqual(bindingProblemText('connectorBindings', 0, { property: 'connectionId', why: 'not-stated' }),
    'connectorBindings[0].connectionId is not a property an App Spec states (a binding states only logicalName, connectorId, dataset, tables, tableDisplayNames, operations) — remove it');
  assert.strictEqual(bindingProblemText('actionBindings', 2, { property: 'headers', why: 'not-stated' }),
    'actionBindings[2].headers is not a property an App Spec states (a binding states only name, isFunction, boundEntityLogicalName, displayName, parameterKinds) — remove it');
  assert.strictEqual(bindingProblemText('connectorBindings', 1, { property: UNUSUAL_NAME, why: 'not-stated' }),
    'connectorBindings[1] has a property with an unusual name, which an App Spec does not state — remove it');
  assert.strictEqual(bindingProblemText('connectorBindings', 0, { property: 'operations', why: 'not-text-list' }), 'connectorBindings[0].operations must be a list of texts');
  assert.strictEqual(bindingProblemText('connectorBindings', 0, { property: 'dataset', why: 'not-text' }), 'connectorBindings[0].dataset must be a text');
  assert.strictEqual(bindingProblemText('actionBindings', 0, { property: 'isFunction', why: 'not-boolean' }), 'actionBindings[0].isFunction must be true or false');
  assert.strictEqual(bindingProblemText('actionBindings', 0, { property: 'parameterKinds', why: 'not-parameter-kinds' }), 'actionBindings[0].parameterKinds must map parameter names to Dataverse parameter kinds');
  assert.strictEqual(bindingProblemText('connectorBindings', 0, { property: 'dataset', why: 'credential-shaped' }), 'connectorBindings[0].dataset looks like it holds a credential, which an App Spec never states');
  assert.strictEqual(bindingProblemText('connectorBindings', 0, { property: 'dataset', why: 'too-long' }), 'connectorBindings[0].dataset is longer than an App Spec states');
});

// ── a rebuild leaves on the page what the spec could not state ───────────────────────────────────────────────────────────────

test('mergeBindings: the entries a spec states as the page holds them merge into exactly the page\'s own — so nothing is written, and nothing a spec could not state is lost', () => {
  const held = [HELD_WEATHER, HELD_SHAREPOINT];
  assert.deepStrictEqual(mergeBindings('connectorBindings', [WEATHER, SHAREPOINT], held), held);
  // An entry the page holds with a property of a kind a spec cannot state keeps it: the spec left it out, and a rebuild leaves it be.
  const odd = [{ logicalName: 'contoso_a', operations: 'oops', connectionId: 'x' }];
  assert.deepStrictEqual(mergeBindings('connectorBindings', [{ logicalName: 'contoso_a' }], odd), odd);
});

test('mergeBindings: an edit is applied to the entry it is about — the stated properties win, a stated property that is gone is gone, and what a spec could not state stays', () => {
  const held = [HELD_WEATHER, HELD_SHAREPOINT];
  const edited = mergeBindings('connectorBindings', [{ ...WEATHER, operations: ['Forecast'] }, SHAREPOINT], held);
  assert.deepStrictEqual(edited, [{ ...HELD_WEATHER, operations: ['Forecast'] }, HELD_SHAREPOINT]);
  const { operations, ...withoutOperations } = WEATHER;
  assert.deepStrictEqual(mergeBindings('connectorBindings', [withoutOperations, SHAREPOINT], held), [{ logicalName: HELD_WEATHER.logicalName, connectorId: HELD_WEATHER.connectorId, dataset: '', connectionId: HELD_WEATHER.connectionId, futureProperty: { kept: true } }, HELD_SHAREPOINT]);
  // A stated property replaces one the spec could not state, as a spec that states a valid list does where the page holds a text.
  assert.deepStrictEqual(mergeBindings('connectorBindings', [{ logicalName: 'contoso_a', operations: ['x'] }], [{ logicalName: 'contoso_a', operations: 'oops', connectionId: 'c' }]), [{ logicalName: 'contoso_a', operations: ['x'], connectionId: 'c' }]);
});

test('mergeBindings: entries are matched by the name they go by — so an entry that is removed, added or moved takes its own extras, or none', () => {
  const held = [HELD_WEATHER, HELD_SHAREPOINT];
  assert.deepStrictEqual(mergeBindings('connectorBindings', [SHAREPOINT], held), [HELD_SHAREPOINT], 'removed: the other entry is gone');
  assert.deepStrictEqual(mergeBindings('connectorBindings', [SHAREPOINT, WEATHER], held), [HELD_SHAREPOINT, HELD_WEATHER], 'moved: the order is the spec\'s');
  const fresh = { logicalName: 'contoso_new', connectorId: '/providers/Microsoft.PowerApps/apis/shared_new' };
  assert.deepStrictEqual(mergeBindings('connectorBindings', [WEATHER, fresh], [HELD_WEATHER]), [HELD_WEATHER, fresh], 'added: stated as it is');
  assert.deepStrictEqual(mergeBindings('connectorBindings', [{ ...WEATHER, logicalName: 'contoso_renamed' }], held), [{ ...WEATHER, logicalName: 'contoso_renamed' }], 'renamed: a new entry, and the old one\'s extras are not carried to it');
  // Two entries of one name are matched in order.
  const twins = [{ logicalName: 'contoso_a', connectionId: '1' }, { logicalName: 'contoso_a', connectionId: '2' }];
  assert.deepStrictEqual(mergeBindings('connectorBindings', [{ logicalName: 'contoso_a' }, { logicalName: 'contoso_a' }], twins), twins);
  // An entry with no name on either side is matched by its place.
  assert.deepStrictEqual(mergeBindings('connectorBindings', [{ connectorId: 'x' }], [{ connectorId: 'x', credentials: 1 }]), [{ connectorId: 'x', credentials: 1 }]);
  assert.deepStrictEqual(mergeBindings('actionBindings', [APPROVE], [{ ...APPROVE, headers: 1 }]), [{ ...APPROVE, headers: 1 }]);
});

test('mergeBindings answers the list as stated when there is nothing to merge into, and never changes what it is given', () => {
  const stated = deepFreeze([WEATHER]);
  for (const held of [undefined, null, 'oops', {}, 7]) assert.strictEqual(mergeBindings('connectorBindings', stated, held), stated, `held ${JSON.stringify(held)}`);
  assert.deepStrictEqual(mergeBindings('connectorBindings', stated, deepFreeze([HELD_WEATHER])), [HELD_WEATHER]);
  assert.deepStrictEqual(mergeBindings('connectorBindings', stated, []), [WEATHER]);
  assert.strictEqual(mergeBindings('connectorBindings', 'x', [HELD_WEATHER]), 'x', 'what is not a list is not this function\'s to judge');
  assert.deepStrictEqual(mergeBindings('connectorBindings', [null, WEATHER], [HELD_WEATHER]), [null, HELD_WEATHER], 'nor is an entry that is no object');
});
