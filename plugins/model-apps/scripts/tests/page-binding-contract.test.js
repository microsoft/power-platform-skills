'use strict';
// What an App Spec states of a generative page's connector and Custom API bindings, and what a rebuild does with it (lib/page-bindings.js).
//
// A binding a page holds can carry more than the runtime reads: a connection id of the environment it was made in, a credential someone put in a connectors.json (genpage-upload.js takes any JSON array),
// a property a later runtime adds — as a value, as a key, inside a URL. The spec is committed, reviewed and shared, so it states a list only WHOLE: every key one of the properties references/connectors.md and
// references/custom-api.md document, every value of a conservative shape known to be safe (page-bindings.js has the threat model). Anything else leaves the list out of the spec, said by its place and a vetted
// name, never the value or an unrecognized key. A rebuild into the environment a page came from leaves on the page what a spec does not state: mergeBindings is that rule, and what planEdits (genpage-sdk.js)
// reads a list as "already holds" with.
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

test('statableBinding states a documented entry whole — a REST and a tabular connector binding, a SQL dataset and table, a custom connector, a Custom API with its parameter kinds — in the entry\'s order, as copies', () => {
  const SQL = { logicalName: 'contoso_sql', connectorId: 'shared_sql', dataset: 'contoso.database.windows.net,Sales', tables: ['[dbo].[Orders]'], tableDisplayNames: ['Orders'] };
  const CUSTOM = { logicalName: 'contoso_widgets', connectorId: '/providers/Microsoft.PowerApps/apis/shared_contoso-5fwidgets-5f6a8c', dataset: '', operations: ['ListWidgets', 'Get-Widget.v2'] };
  const SUMMARY = { name: 'contoso_GetSummary', isFunction: true, displayName: 'Get summary (v2) — Sales & Ops', parameterKinds: { ItemId: 'Guid', _Note: 'String' } };
  const SITE = { ...SHAREPOINT, dataset: 'https://contoso.sharepoint.com/sites/Team%20Site/Shared%20Documents', tableDisplayNames: ['Équipes', 'Pets'] };
  for (const [kind, entry] of [['connectorBindings', WEATHER], ['connectorBindings', SHAREPOINT], ['connectorBindings', SQL], ['connectorBindings', CUSTOM], ['connectorBindings', SITE], ['actionBindings', APPROVE], ['actionBindings', SUMMARY]]) {
    const { stated, leftOut } = statableBinding(kind, deepFreeze(JSON.parse(JSON.stringify(entry))));
    assert.deepStrictEqual(leftOut, [], JSON.stringify(entry));
    assert.deepStrictEqual(stated, entry);
    assert.deepStrictEqual(Object.keys(stated), Object.keys(entry), 'in the entry\'s own order');
  }
  const held = { ...APPROVE, parameterKinds: { Comment: 'String' } };
  const { stated } = statableBinding('actionBindings', held);
  assert.notStrictEqual(stated.parameterKinds, held.parameterKinds, 'a copy: a later edit of the spec does not reach the page\'s entry');
});

// The values a credential takes when it hides in a property a spec DOES state. Each must leave its value out: a value is stated only with a shape that is positively known to be safe, and a URL only when its
// PARSED form has no user-info, no query and no fragment. Synthetic markers only.
const MARK = 'SYNTHETIC_CREDENTIAL_R3';
const TOKEN = `ghp_${'R'.repeat(36)}`;
const UNSAFE_VALUES = [
  ['connectorBindings', 'dataset', `https://${MARK}@contoso.example/data`, 'a token alone in the user-info of a URL'],
  ['connectorBindings', 'dataset', `https://maker:${MARK}@contoso.example/data`, 'a password in the user-info'],
  ['connectorBindings', 'dataset', `https://contoso.example/data?api%5Fkey=${MARK}`, 'a percent-encoded key in a query'],
  ['connectorBindings', 'dataset', `https://contoso.example/data?x=${MARK}`, 'any query'],
  ['connectorBindings', 'dataset', 'https://contoso.example/data?', 'an empty query, which a parser drops'],
  ['connectorBindings', 'dataset', `https://contoso.example/data#access_token=${MARK}`, 'a fragment'],
  ['connectorBindings', 'dataset', `https://contoso.example/sites/a%40${MARK}`, 'an encoded @ in the path'],
  ['connectorBindings', 'dataset', `https://contoso.example/sites/0123456789abcdef0123456789abcdef${MARK}`, 'a digest-shaped path segment'],
  ['connectorBindings', 'dataset', `ftp://contoso.example/${MARK}`, 'a scheme that is not http(s)'],
  ['connectorBindings', 'dataset', JSON.stringify({ accessToken: MARK }), 'JSON text'],
  ['connectorBindings', 'dataset', `Server=sql.contoso.example;Password=${MARK}`, 'a connection string'],
  ['connectorBindings', 'logicalName', `Bearer ${MARK}`, 'an authorization value as the identity'],
  ['connectorBindings', 'logicalName', TOKEN, 'a token-format identity'],
  ['connectorBindings', 'connectorId', `/providers/Microsoft.PowerApps/apis/shared_x?sig=${MARK}`, 'a connector id with a query'],
  ['connectorBindings', 'tables', [`${MARK}=1`], 'a table with a key=value'],
  ['connectorBindings', 'tableDisplayNames', [`https://${MARK}@contoso.example`], 'a label that is a URL'],
  ['connectorBindings', 'operations', [`eyJhbGciOiJIUzI1NiJ9.${MARK}`], 'a JSON Web Token as an operation'],
  ['actionBindings', 'displayName', `https://${MARK}@contoso.example/api`, "a Custom API's display name that is a URL"],
  ['actionBindings', 'displayName', `Bearer ${MARK}`, 'an authorization value as a label'],
  ['actionBindings', 'displayName', `key=${MARK}`, 'a label with a key=value'],
  ['actionBindings', 'boundEntityLogicalName', `contoso_item ${MARK}`, 'a table name with a space'],
  ['actionBindings', 'parameterKinds', { [TOKEN]: 'String' }, 'a token as a parameter name'],
  ['actionBindings', 'parameterKinds', { [`x${MARK}`.toLowerCase()]: MARK }, 'a parameter kind that is not one'],
];

test('a value is stated only with a conservative shape known to be safe — a credential in a URL\'s user-info, query or fragment, encoded, as a token, a JWT or JSON text is left out, and never quoted', () => {
  for (const [kind, property, value, what] of UNSAFE_VALUES) {
    const base = kind === 'connectorBindings' ? SHAREPOINT : APPROVE;
    const { stated, leftOut } = statableBinding(kind, { ...base, [property]: value });
    assert.ok(!(property in stated), `${what}: not stated`);
    assert.deepStrictEqual(leftOut.map((l) => l.property), [property], what);
    assert.ok(!JSON.stringify(leftOut).includes(MARK) && !JSON.stringify(leftOut).includes(TOKEN), `${what}: the value is never in what is said`);
    assert.ok(!bindingProblemText(kind, 0, leftOut[0]).includes(MARK), what);
  }
});

test('a key is stated only when it is a documented property — any other is "an unrecognized property", and the key itself is never said: a token can be the NAME of a property', () => {
  const entry = { ...WEATHER, [TOKEN]: true, connectionId: 'x', credentials: { accessToken: MARK }, constructor: 1 };
  const { stated, leftOut } = statableBinding('connectorBindings', entry);
  assert.deepStrictEqual(stated, WEATHER);
  assert.deepStrictEqual(leftOut, Array(4).fill({ property: UNUSUAL_NAME, why: 'not-stated' }));
  const said = JSON.stringify(leftOut) + bindingProblemText('connectorBindings', 0, leftOut[0]);
  for (const secret of [TOKEN, 'connectionId', 'credentials', MARK]) assert.ok(!said.includes(secret), secret);
  assert.strictEqual(bindingProblemText('connectorBindings', 2, leftOut[0]), 'connectorBindings[2] holds an unrecognized property, which an App Spec does not state (a binding states only logicalName, connectorId, dataset, tables, tableDisplayNames, operations)');
  assert.strictEqual(bindingProblemText('actionBindings', 0, { property: 'displayName', why: 'label' }), 'actionBindings[0].displayName must be a plain label (letters, digits, spaces and simple punctuation; no URL)');
});

test('statableBindings states a list WHOLE or not at all — the first entry that holds anything else is said by its place and a vetted name, and nothing of the list is projected', () => {
  const whole = statableBindings('connectorBindings', [WEATHER, SHAREPOINT]);
  assert.deepStrictEqual(whole, { stated: [WEATHER, SHAREPOINT], problem: null });
  // An entry whose identity alone is unsafe: projecting the rest would write an entry with no identity, and a rebuild would replace the page's entry with it.
  const identity = statableBindings('connectorBindings', [WEATHER, { ...SHAREPOINT, logicalName: `Bearer ${MARK}` }]);
  assert.deepStrictEqual(identity, { stated: null, problem: { entry: 1, property: 'logicalName', why: 'identifier' } });
  const unknown = statableBindings('actionBindings', [{ ...APPROVE, [TOKEN]: 1 }]);
  assert.deepStrictEqual(unknown, { stated: null, problem: { entry: 0, property: UNUSUAL_NAME, why: 'not-stated' } });
  assert.deepStrictEqual(statableBindings('actionBindings', []), { stated: [], problem: null });
  assert.ok(!JSON.stringify([identity, unknown]).includes(MARK) && !JSON.stringify(unknown).includes(TOKEN));
});

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
