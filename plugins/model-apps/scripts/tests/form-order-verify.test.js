'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { verifySpec } = require('../lib/verify-spec.js');

const ENTITY = 'new_workitem';
const EXISTING_ENTITY = 'account';
const WORK = 'Work Item';
const MY_WORK = 'My Work — Work Item';
const SUMMARY = 'Work Item — Summary';
const LEGACY = 'Legacy';
const IDS = {
  [WORK]: '11111111-1111-1111-1111-111111111111',
  [MY_WORK]: '22222222-2222-2222-2222-222222222222',
  [SUMMARY]: '33333333-3333-3333-3333-333333333333',
  [LEGACY]: '44444444-4444-4444-4444-444444444444',
};

function specFor({
  entity = ENTITY,
  existing = false,
  forms = [
    { entity, name: WORK, formType: 'Main' },
    { entity, name: MY_WORK, formType: 'Main' },
    { entity, name: SUMMARY, formType: 'Main' },
  ],
  entityProps = {},
} = {}) {
  return {
    solution: { publisherPrefix: 'new' },
    app: { name: 'Work Items', uniqueName: 'new_workitems' },
    entities: [{ schemaName: entity, columns: [], ...(existing ? { existing: true } : {}), ...entityProps }],
    views: [],
    charts: [],
    appShell: { areas: [] },
    forms,
  };
}

function formxml(order) {
  if (order === undefined) return '<form><tabs /></form>';
  return `<form><DisplayConditions Order="${order}" FallbackForm="true"><Everyone /></DisplayConditions><tabs /></form>`;
}

function readFor({
  entity = ENTITY,
  ids = IDS,
  orders = { [WORK]: 0, [MY_WORK]: 1, [SUMMARY]: 2 },
  served,
  missingNames = [],
  topologyThrows = {},
  includeFormTopology = true,
  includeServedMainForms = true,
  includeFormDefaultState = true,
  defaultNames = [WORK],
} = {}) {
  const missing = new Set(missingNames);
  const byId = new Map(Object.entries(ids).map(([name, id]) => [id.toLowerCase(), name]));
  return {
    findTable: async (logical) => ({ logicalName: logical }),
    findColumns: async () => [],
    sitemapXml: async () => '',
    queryRecords: async (set, opts) => {
      if (set !== 'systemform') return [];
      const filter = String(opts && opts.filter || '');
      const idMatch = /formid eq ([0-9a-fA-F-]{36})/.exec(filter);
      if (idMatch) {
        const id = idMatch[1].toLowerCase();
        const name = byId.get(id);
        return name && !missing.has(name) ? [{ formid: idMatch[1], name, objecttypecode: entity, type: 2 }] : [];
      }
      const entityMatch = /objecttypecode eq '([^']+)'/.exec(filter);
      if (entityMatch && entityMatch[1].toLowerCase() !== entity.toLowerCase()) return [];
      const nameMatch = /name eq '([^']+)'/.exec(filter);
      if (!nameMatch) return [];
      const name = nameMatch[1].replace(/''/g, "'");
      if (!ids[name] || missing.has(name)) return [];
      return [{ formid: ids[name], name, objecttypecode: entity, type: 2 }];
    },
    ...(includeFormDefaultState ? {
      formDefaultState: async (_entity, formId) => ({ isDefault: defaultNames.some((n) => ids[n] && ids[n].toLowerCase() === String(formId).toLowerCase()) }),
    } : {}),
    ...(includeFormTopology ? {
      formTopology: async (_entity, formId) => {
        const name = byId.get(String(formId).toLowerCase());
        if (topologyThrows[name]) throw new Error(topologyThrows[name]);
        return formxml(orders[name]);
      },
    } : {}),
    ...(includeServedMainForms ? {
      servedMainForms: async () => {
        if (served instanceof Error) throw served;
        return (served || [WORK, MY_WORK, SUMMARY]).map((entry) => typeof entry === 'string'
          ? { id: ids[entry], name: entry }
          : entry);
      },
    } : {}),
  };
}

const checksOf = (result, kind) => result.checks.filter((c) => c.kind === kind);
const checkOf = (result, kind) => result.checks.find((c) => c.kind === kind);

test('own custom table passes stored and served Main Form Set order when Work Item opens first', async () => {
  const result = await verifySpec(specFor(), readFor());

  assert.strictEqual(result.ok, true, JSON.stringify(result.missing));
  assert.deepStrictEqual(checksOf(result, 'form-order').map((c) => [c.present, c.name]), [[true, `${ENTITY}: ${WORK} > ${MY_WORK} > ${SUMMARY}`]]);
  assert.deepStrictEqual(checksOf(result, 'form-order-served').map((c) => [c.present, c.name]), [[true, `${ENTITY} opens with '${WORK}'`]]);
});

test('stored order failure names both forms and skips the served-order proof', async () => {
  const result = await verifySpec(specFor(), readFor({ orders: { [WORK]: 1, [MY_WORK]: 0, [SUMMARY]: 2 } }));

  assert.strictEqual(result.ok, false);
  const stored = checkOf(result, 'form-order');
  assert.strictEqual(stored.present, false);
  assert.match(stored.detail, /'My Work — Work Item' \(order 0\) is not after 'Work Item' \(order 1\)/);
  assert.strictEqual(checksOf(result, 'form-order-served').length, 0, 'served order is not meaningful when stored order already failed');
});

test('a declared Main form without DisplayConditions fails as having no form order', async () => {
  const result = await verifySpec(specFor(), readFor({ orders: { [WORK]: undefined, [MY_WORK]: 1, [SUMMARY]: 2 } }));

  const stored = checkOf(result, 'form-order');
  assert.strictEqual(stored.present, false);
  assert.match(stored.detail, /'Work Item' has no form order/);
});

test('equal stored Orders fail because the platform decides ties', async () => {
  const result = await verifySpec(specFor(), readFor({ orders: { [WORK]: 0, [MY_WORK]: 0, [SUMMARY]: 2 } }));

  const stored = checkOf(result, 'form-order');
  assert.strictEqual(stored.present, false);
  assert.match(stored.detail, /'My Work — Work Item' \(order 0\) is not after 'Work Item' \(order 0\)/);
});

test('a formxml read error fails the stored order proof and names the form', async () => {
  const result = await verifySpec(specFor(), readFor({ topologyThrows: { [MY_WORK]: 'formxml denied' } }));

  const stored = checkOf(result, 'form-order');
  assert.strictEqual(stored.present, false);
  assert.match(stored.detail, /could not read the deployed form order \('My Work — Work Item': formxml denied\)/);
});

test('an undeclared form served first fails with the Maker remedy', async () => {
  const result = await verifySpec(specFor(), readFor({ served: [LEGACY, WORK, MY_WORK, SUMMARY] }));

  const served = checkOf(result, 'form-order-served');
  assert.strictEqual(served.present, false);
  assert.match(served.detail, /users without a remembered form open 'Legacy' first/);
  assert.match(served.detail, /Move it down in Maker \(Form settings > Form order\), or declare it/);
});

test('declared forms served in the wrong relative order fail and name the inversion', async () => {
  const result = await verifySpec(specFor(), readFor({ served: [WORK, SUMMARY, MY_WORK] }));

  const served = checkOf(result, 'form-order-served');
  assert.strictEqual(served.present, false);
  assert.match(served.detail, /'Work Item — Summary' is served before 'My Work — Work Item'/);
});

test('when the verifying user cannot open the first planned form, served order is environment-skipped', async () => {
  const result = await verifySpec(specFor(), readFor({ served: [MY_WORK, SUMMARY] }));

  assert.strictEqual(checksOf(result, 'form-order-served').length, 0);
  assert.ok(result.environmentSkipped.some((entry) => entry.startsWith(`form-order-served:${ENTITY}`) && entry.includes(WORK)), JSON.stringify(result.environmentSkipped));
});

test('servedMainForms read failures fail the served-order check with the error text', async () => {
  const result = await verifySpec(specFor(), readFor({ served: new Error('RetrieveFilteredForms 503') }));

  const served = checkOf(result, 'form-order-served');
  assert.strictEqual(served.present, false);
  assert.match(served.detail, /RetrieveFilteredForms 503/);
});

test('a reader without servedMainForms still proves stored order without crashing', async () => {
  const result = await verifySpec(specFor(), readFor({ includeServedMainForms: false }));

  assert.strictEqual(result.ok, true, JSON.stringify(result.missing));
  assert.strictEqual(checksOf(result, 'form-order').length, 1);
  assert.strictEqual(checksOf(result, 'form-order-served').length, 0);
});

test('a reader without formTopology adds no form-order checks at all', async () => {
  const result = await verifySpec(specFor(), readFor({ includeFormTopology: false, includeServedMainForms: false }));

  assert.strictEqual(checksOf(result, 'form-order').length, 0);
  assert.strictEqual(checksOf(result, 'form-order-served').length, 0);
});

test('existing table without explicit default or mainFormOrder has no default or order ownership checks', async () => {
  const result = await verifySpec(specFor({ entity: EXISTING_ENTITY, existing: true }), readFor({ entity: EXISTING_ENTITY }));

  assert.strictEqual(result.ok, true, JSON.stringify(result.missing));
  assert.strictEqual(checksOf(result, 'form-default').length, 0);
  assert.strictEqual(checksOf(result, 'form-order').length, 0);
  assert.strictEqual(checksOf(result, 'form-order-served').length, 0);
});

test('existing table with explicit isDefault checks default promotion and form order', async () => {
  const forms = [
    { entity: EXISTING_ENTITY, name: WORK, formType: 'Main', isDefault: true },
    { entity: EXISTING_ENTITY, name: MY_WORK, formType: 'Main' },
    { entity: EXISTING_ENTITY, name: SUMMARY, formType: 'Main' },
  ];

  const result = await verifySpec(
    specFor({ entity: EXISTING_ENTITY, existing: true, forms }),
    readFor({ entity: EXISTING_ENTITY, defaultNames: [WORK] }),
  );

  assert.strictEqual(result.ok, true, JSON.stringify(result.missing));
  assert.ok(checksOf(result, 'form-default').some((c) => c.name === `${EXISTING_ENTITY}.${WORK}` && c.present));
  assert.strictEqual(checksOf(result, 'form-order').length, 1);
});

test('mainFormOrder drives the expected full and partial order before current stored order fills the rest', async (t) => {
  await t.test('full list is authoritative', async () => {
    const result = await verifySpec(
      specFor({ entityProps: { mainFormOrder: [SUMMARY, WORK, MY_WORK] } }),
      readFor({ orders: { [SUMMARY]: 0, [WORK]: 1, [MY_WORK]: 2 }, served: [SUMMARY, WORK, MY_WORK], defaultNames: [SUMMARY] }),
    );

    assert.strictEqual(result.ok, true, JSON.stringify(result.missing));
    assert.strictEqual(checkOf(result, 'form-order').name, `${ENTITY}: ${SUMMARY} > ${WORK} > ${MY_WORK}`);
  });

  await t.test('partial list comes first and unspecified forms keep stored relative order', async () => {
    const result = await verifySpec(
      specFor({ entityProps: { mainFormOrder: [SUMMARY] } }),
      readFor({ orders: { [SUMMARY]: 0, [MY_WORK]: 1, [WORK]: 2 }, served: [SUMMARY, MY_WORK, WORK], defaultNames: [SUMMARY] }),
    );

    assert.strictEqual(result.ok, true, JSON.stringify(result.missing));
    assert.strictEqual(checkOf(result, 'form-order').name, `${ENTITY}: ${SUMMARY} > ${MY_WORK} > ${WORK}`);
  });
});

test('a table ordered by hand through securityRoles.order has no automatic order checks', async () => {
  const forms = [
    { entity: ENTITY, name: WORK, formType: 'Main', securityRoles: { order: 0 } },
    { entity: ENTITY, name: MY_WORK, formType: 'Main' },
    { entity: ENTITY, name: SUMMARY, formType: 'Main' },
  ];

  const result = await verifySpec(specFor({ forms }), readFor());

  assert.strictEqual(checksOf(result, 'form-order').length, 0);
  assert.strictEqual(checksOf(result, 'form-order-served').length, 0);
});

test('a declared Main form that does not resolve is reported missing and suppresses order checks for that table', async () => {
  const result = await verifySpec(specFor(), readFor({ missingNames: [SUMMARY] }));

  const missingForm = result.checks.find((c) => c.kind === 'form' && c.name === SUMMARY);
  assert.ok(missingForm);
  assert.strictEqual(missingForm.present, false);
  assert.strictEqual(checksOf(result, 'form-order').length, 0);
  assert.strictEqual(checksOf(result, 'form-order-served').length, 0);
});

test('result.ok follows order-check results: failing order makes it false and passing order leaves it true', async () => {
  const pass = await verifySpec(specFor(), readFor());
  const fail = await verifySpec(specFor(), readFor({ orders: { [WORK]: 1, [MY_WORK]: 0, [SUMMARY]: 2 } }));

  assert.strictEqual(pass.ok, true, JSON.stringify(pass.missing));
  assert.strictEqual(fail.ok, false);
  assert.ok(fail.missing.some((m) => m.kind === 'form-order'));
});
