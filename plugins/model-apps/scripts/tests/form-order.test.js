'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  isMainForm,
  isOwnCustomTable,
  declaredMainForms,
  listedMainForms,
  selectDefaultForm,
  ordersByHand,
  plannedMainFormSequence,
  displayConditionsOrder,
  compareServedOrder,
} = require('../lib/form-order.js');

const WORK_ITEM = 'contoso_workitem';
const OTHER_TABLE = 'contoso_project';

function main(name, over = {}) {
  return { entity: WORK_ITEM, name, formType: 'Main', ...over };
}

function quick(name, formType = 'QuickCreate', over = {}) {
  return { entity: WORK_ITEM, name, formType, ...over };
}

function spec(over = {}) {
  return {
    solution: { publisherPrefix: 'contoso' },
    entities: [{ schemaName: WORK_ITEM }, { schemaName: OTHER_TABLE }],
    forms: [
      main('Work Item'),
      main('My Work — Work Item'),
      main('Work Item — Summary'),
      quick('Work Item Quick'),
      { entity: OTHER_TABLE, name: 'Project Main', formType: 'Main' },
    ],
    ...over,
  };
}

test('isMainForm treats omitted formType as Main and rejects non-Main or malformed inputs', () => {
  assert.strictEqual(isMainForm({ name: 'No Type' }), true);
  assert.strictEqual(isMainForm({ formType: 'Main' }), true);
  assert.strictEqual(isMainForm({ formType: 'QuickCreate' }), false);
  assert.strictEqual(isMainForm({ formType: 'QuickView' }), false);
  assert.strictEqual(isMainForm(null), false);
  assert.strictEqual(isMainForm(undefined), false);
  assert.strictEqual(isMainForm('Main'), false);
});

test('isOwnCustomTable recognizes declared owned custom tables case-insensitively', () => {
  assert.strictEqual(isOwnCustomTable(spec(), 'CONTOSO_WORKITEM'), true);
  assert.strictEqual(isOwnCustomTable({
    solution: { publisherPrefix: 'ConToSo' },
    entities: [{ schemaName: 'contoso_WorkItem' }],
  }, 'CONTOSO_WORKITEM'), true);
  assert.strictEqual(isOwnCustomTable(null, WORK_ITEM), false);
  assert.strictEqual(isOwnCustomTable(spec({ entities: [{ schemaName: WORK_ITEM, existing: true }] }), WORK_ITEM), false);
  assert.strictEqual(isOwnCustomTable(spec({ entities: [{ schemaName: 'other_workitem' }] }), 'other_workitem'), false);
  assert.strictEqual(isOwnCustomTable({ solution: {}, entities: [{ schemaName: WORK_ITEM }] }, WORK_ITEM), false);
  assert.strictEqual(isOwnCustomTable(spec(), 'contoso_missing'), false);
});

test('declaredMainForms returns only one entity Main forms in spec order', () => {
  const s = spec({
    forms: [
      main('Work Item'),
      { entity: WORK_ITEM.toUpperCase(), name: 'My Work — Work Item', formType: 'Main' },
      quick('Quick Only'),
      { entity: OTHER_TABLE, name: 'Project Main', formType: 'Main' },
      main('Work Item — Summary'),
    ],
  });

  assert.deepStrictEqual(declaredMainForms(s, 'CONTOSO_WORKITEM').map((f) => f.name), [
    'Work Item',
    'My Work — Work Item',
    'Work Item — Summary',
  ]);
  assert.deepStrictEqual(declaredMainForms(null, WORK_ITEM), []);
  assert.deepStrictEqual(declaredMainForms(s, null), []);
  assert.deepStrictEqual(declaredMainForms(s, undefined), []);
});

test('listedMainForms returns null when mainFormOrder is absent or not an array', () => {
  assert.strictEqual(listedMainForms(spec(), WORK_ITEM), null);
  assert.strictEqual(listedMainForms(spec({ entities: [{ schemaName: WORK_ITEM, mainFormOrder: 'Work Item' }] }), WORK_ITEM), null);
  assert.strictEqual(listedMainForms(spec(), 'contoso_missing'), null);
});

test('listedMainForms resolves exact Main-form names in list order and drops unresolved entries', () => {
  const s = spec({
    entities: [{ schemaName: WORK_ITEM, mainFormOrder: [
      'My Work — Work Item',
      'work item',
      'Work Item',
      'Work Item',
      'Work Item Quick',
      'Missing',
    ] }],
  });

  assert.deepStrictEqual(listedMainForms(s, WORK_ITEM).map((f) => f.name), [
    'My Work — Work Item',
    'Work Item',
  ]);
});

// The spec gate rejects a name that differs only by case ("not a Main form of this table"), so the
// helper must not quietly resolve it either — otherwise a build and its gate would disagree about which
// form an entry names. Here the wrong-case entry stands alone, ahead of an exact one.
test('listedMainForms does not resolve a name that matches a form only case-insensitively', () => {
  const s = spec({ entities: [{ schemaName: WORK_ITEM, mainFormOrder: ['work item', 'My Work — Work Item'] }] });
  assert.deepStrictEqual(listedMainForms(s, WORK_ITEM).map((f) => f.name), ['My Work — Work Item']);
});

test('selectDefaultForm honors explicit defaults, mainFormOrder, owned fallback, and object identity', () => {
  const explicitExisting = spec({
    entities: [{ schemaName: WORK_ITEM, existing: true }],
    forms: [main('Work Item'), main('My Work — Work Item', { isDefault: true })],
  });
  assert.deepStrictEqual(selectDefaultForm(explicitExisting, WORK_ITEM), {
    form: explicitExisting.forms[1],
    explicit: true,
  });

  const listedExisting = spec({
    entities: [{ schemaName: WORK_ITEM, existing: true, mainFormOrder: ['My Work — Work Item'] }],
    forms: [main('Work Item'), main('My Work — Work Item')],
  });
  assert.deepStrictEqual(selectDefaultForm(listedExisting, WORK_ITEM), {
    form: listedExisting.forms[1],
    explicit: true,
  });

  const ownedFallback = spec({ forms: [main('Work Item'), main('My Work — Work Item')] });
  assert.deepStrictEqual(selectDefaultForm(ownedFallback, WORK_ITEM), {
    form: ownedFallback.forms[0],
    explicit: false,
  });

  assert.strictEqual(selectDefaultForm(spec({
    entities: [{ schemaName: WORK_ITEM, existing: true }],
    forms: [main('Work Item'), main('My Work — Work Item')],
  }), WORK_ITEM), null);
  assert.strictEqual(selectDefaultForm(spec({ forms: [quick('Quick Only')] }), WORK_ITEM), null);

  const unresolvedList = spec({
    entities: [{ schemaName: WORK_ITEM, mainFormOrder: ['Missing'] }],
    forms: [main('Work Item'), main('My Work — Work Item')],
  });
  assert.deepStrictEqual(selectDefaultForm(unresolvedList, WORK_ITEM), {
    form: unresolvedList.forms[0],
    explicit: false,
  });
});

test('ordersByHand only counts securityRoles.order on Main forms of the requested entity', () => {
  assert.strictEqual(ordersByHand(spec({ forms: [main('Work Item', { securityRoles: { order: 0 } })] }), WORK_ITEM), true);
  assert.strictEqual(ordersByHand(spec({ forms: [main('Work Item', { securityRoles: {} })] }), WORK_ITEM), false);
  assert.strictEqual(ordersByHand(spec({ forms: [main('Work Item', { securityRoles: null }), main('Other', { securityRoles: 'roles' })] }), WORK_ITEM), false);
  assert.strictEqual(ordersByHand(spec({ forms: [quick('Quick Only', 'QuickCreate', { securityRoles: { order: 0 } })] }), WORK_ITEM), false);
  assert.strictEqual(ordersByHand(spec({ forms: [{ entity: OTHER_TABLE, name: 'Project Main', formType: 'Main', securityRoles: { order: 0 } }] }), WORK_ITEM), false);
});

test('plannedMainFormSequence declines to order hand-ordered forms and existing tables with no choice', () => {
  assert.strictEqual(plannedMainFormSequence(spec({ forms: [main('Work Item', { securityRoles: { order: 0 } })] }), WORK_ITEM), null);
  assert.strictEqual(plannedMainFormSequence(spec({
    entities: [{ schemaName: WORK_ITEM, existing: true }],
    forms: [main('Work Item'), main('My Work — Work Item')],
  }), WORK_ITEM), null);
});

test('plannedMainFormSequence puts the owned fallback or explicit default first and keeps spec-order ties', () => {
  const owned = spec({ forms: [main('Work Item'), main('My Work — Work Item'), main('Work Item — Summary')] });
  assert.deepStrictEqual(plannedMainFormSequence(owned, WORK_ITEM).map((f) => f.name), [
    'Work Item',
    'My Work — Work Item',
    'Work Item — Summary',
  ]);

  const explicit = spec({ forms: [main('Work Item'), main('My Work — Work Item'), main('Work Item — Summary', { isDefault: true })] });
  assert.deepStrictEqual(plannedMainFormSequence(explicit, WORK_ITEM, new Map()).map((f) => f.name), [
    'Work Item — Summary',
    'Work Item',
    'My Work — Work Item',
  ]);
});

test('plannedMainFormSequence preserves current order only for non-head forms', () => {
  const s = spec({ forms: [main('Work Item'), main('My Work — Work Item', { isDefault: true }), main('Work Item — Summary'), main('Later')] });
  const current = new Map([
    [s.forms[0], 10],
    [s.forms[1], 99],
    [s.forms[2], 1],
  ]);

  assert.deepStrictEqual(plannedMainFormSequence(s, WORK_ITEM, current).map((f) => f.name), [
    'My Work — Work Item',
    'Work Item — Summary',
    'Work Item',
    'Later',
  ]);
});

test('plannedMainFormSequence breaks equal stored orders by spec order', () => {
  const s = spec({ forms: [main('Work Item'), main('My Work — Work Item'), main('Work Item — Summary')] });
  const current = new Map([[s.forms[1], 7], [s.forms[2], 7]]);

  assert.deepStrictEqual(plannedMainFormSequence(s, WORK_ITEM, current).map((f) => f.name), [
    'Work Item',
    'My Work — Work Item',
    'Work Item — Summary',
  ]);
});

test('plannedMainFormSequence applies full and partial mainFormOrder without undeclared live forms', () => {
  const full = spec({
    entities: [{ schemaName: WORK_ITEM, mainFormOrder: ['Work Item — Summary', 'Work Item', 'My Work — Work Item'] }],
    forms: [main('Work Item'), main('My Work — Work Item'), main('Work Item — Summary')],
  });
  assert.deepStrictEqual(plannedMainFormSequence(full, WORK_ITEM).map((f) => f.name), [
    'Work Item — Summary',
    'Work Item',
    'My Work — Work Item',
  ]);

  const partial = spec({
    entities: [{ schemaName: WORK_ITEM, mainFormOrder: ['Work Item — Summary'] }],
    forms: [main('Work Item'), main('My Work — Work Item'), main('Work Item — Summary')],
  });
  const current = new Map([[partial.forms[0], 5], [partial.forms[1], 2], [{ name: 'Live Only' }, 0]]);
  assert.deepStrictEqual(plannedMainFormSequence(partial, WORK_ITEM, current).map((f) => f.name), [
    'Work Item — Summary',
    'My Work — Work Item',
    'Work Item',
  ]);
});

test('plannedMainFormSequence applies explicit defaults on existing tables', () => {
  const s = spec({
    entities: [{ schemaName: WORK_ITEM, existing: true }],
    forms: [main('Work Item'), main('My Work — Work Item', { isDefault: true })],
  });

  assert.deepStrictEqual(plannedMainFormSequence(s, WORK_ITEM).map((f) => f.name), [
    'My Work — Work Item',
    'Work Item',
  ]);
});

test('displayConditionsOrder parses live DisplayConditions shapes and safe absence cases', () => {
  assert.deepStrictEqual(displayConditionsOrder('<DisplayConditions Order="0" FallbackForm="true"><Everyone /></DisplayConditions>'), { present: true, order: 0 });
  assert.deepStrictEqual(displayConditionsOrder('<DisplayConditions FallbackForm="true" Order="3"><Everyone /></DisplayConditions>'), { present: true, order: 3 });
  assert.deepStrictEqual(displayConditionsOrder('<DisplayConditions Order="2" FallbackForm="false"><Role Id="{GUID}" /></DisplayConditions>'), { present: true, order: 2 });
  assert.deepStrictEqual(displayConditionsOrder('<DisplayConditions Order="4" />'), { present: true, order: 4 });
  assert.deepStrictEqual(displayConditionsOrder("<DisplayConditions Order='7'></DisplayConditions>"), { present: true, order: 7 });
  assert.deepStrictEqual(displayConditionsOrder('<DisplayConditions FallbackForm="true" />'), { present: true, order: undefined });
  assert.deepStrictEqual(displayConditionsOrder('<DisplayConditions Order="a" />'), { present: true, order: undefined });
  assert.deepStrictEqual(displayConditionsOrder('<DisplayConditions Order="1.5" />'), { present: true, order: undefined });
  assert.deepStrictEqual(displayConditionsOrder('<DisplayConditions Order="" />'), { present: true, order: undefined });
  assert.deepStrictEqual(displayConditionsOrder('<DisplayConditions Order="-2" />'), { present: true, order: -2 });
  assert.deepStrictEqual(displayConditionsOrder('<DisplayConditionsX Order="1" />'), { present: false, order: undefined });
  assert.deepStrictEqual(displayConditionsOrder('<DisplayConditions xOrder="5" FallbackOrder="6" />'), { present: true, order: undefined });
  assert.deepStrictEqual(displayConditionsOrder(null), { present: false, order: undefined });
  assert.deepStrictEqual(displayConditionsOrder(undefined), { present: false, order: undefined });
  assert.deepStrictEqual(displayConditionsOrder(42), { present: false, order: undefined });
  assert.deepStrictEqual(displayConditionsOrder('<DisplayConditions Order = "8" />'), { present: true, order: 8 });
});

test('compareServedOrder accepts matching order, normalized ids, and duplicate served ids', () => {
  const planned = [
    { name: 'Work Item', id: '{AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA}' },
    { name: 'My Work — Work Item', id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' },
  ];

  assert.deepStrictEqual(compareServedOrder(planned, [
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    '{BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB}',
    '{BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB}',
  ]), { ok: true, missing: [] });
});

test('compareServedOrder reports relative-order, ahead, first-not-served, missing, and empty-planned outcomes', () => {
  const planned = [
    { name: 'Work Item', id: 'form-a' },
    { name: 'My Work — Work Item', id: 'form-b' },
    { name: 'Work Item — Summary', id: 'form-c' },
  ];

  assert.deepStrictEqual(compareServedOrder(planned, ['form-b', 'form-a']), {
    ok: false,
    reason: 'order',
    before: 'My Work — Work Item',
    after: 'Work Item',
    missing: ['Work Item — Summary'],
  });
  assert.deepStrictEqual(compareServedOrder(planned, ['{LIVE-FIRST}', 'FORM-A', 'form-b']), {
    ok: false,
    reason: 'ahead',
    aheadId: 'live-first',
    missing: ['Work Item — Summary'],
  });
  assert.deepStrictEqual(compareServedOrder(planned, ['form-b']), {
    ok: null,
    reason: 'first-not-served',
    missing: ['Work Item', 'Work Item — Summary'],
  });
  assert.deepStrictEqual(compareServedOrder([], ['form-a']), {
    ok: null,
    reason: 'first-not-served',
    missing: [],
  });
});

test('compareServedOrder treats omitted served lists and nullish ids consistently', () => {
  assert.deepStrictEqual(compareServedOrder([{ name: 'Work Item', id: 'form-a' }]), {
    ok: null,
    reason: 'first-not-served',
    missing: ['Work Item'],
  });
  assert.deepStrictEqual(compareServedOrder([{ name: 'No Id', id: null }], [undefined]), {
    ok: true,
    missing: [],
  });
});
