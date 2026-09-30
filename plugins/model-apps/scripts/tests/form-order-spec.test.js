'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { validateAppSpec } = require('../lib/app-spec.js');

const WORK_ITEM = 'contoso_workitem';
const PROJECT = 'contoso_project';
const MAIN_NAMES = ['Work Item', 'My Work — Work Item', 'Work Item — Summary'];

function main(entity, name, over = {}) {
  return { entity, name, formType: 'Main', layout: 'auto', ...over };
}

function baseSpec() {
  return {
    solution: { uniqueName: 'ContosoWorkItems', publisherPrefix: 'contoso' },
    app: { name: 'Work Items' },
    entities: [
      {
        schemaName: WORK_ITEM,
        displayName: 'Work Item',
        pluralName: 'Work Items',
        primaryAttribute: { schemaName: 'contoso_name', displayName: 'Name' },
        columns: [],
        mainFormOrder: [...MAIN_NAMES],
      },
      {
        schemaName: PROJECT,
        displayName: 'Project',
        pluralName: 'Projects',
        primaryAttribute: { schemaName: 'contoso_projectname', displayName: 'Name' },
        columns: [],
      },
    ],
    forms: [
      ...MAIN_NAMES.map((name) => main(WORK_ITEM, name)),
      { entity: WORK_ITEM, name: 'Quick Work Item', formType: 'QuickCreate', layout: 'auto' },
      { entity: WORK_ITEM, name: 'Work Item Quick View', formType: 'QuickView', layout: 'auto' },
      main(PROJECT, 'Project Main'),
    ],
    views: [],
    charts: [],
    appShell: { areas: [] },
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function validate(spec) {
  return validateAppSpec(spec, { profile: 'plan' });
}

function workItemEntity(spec) {
  return spec.entities.find((e) => e.schemaName === WORK_ITEM);
}

function workItemForm(spec, name) {
  return spec.forms.find((f) => f.entity === WORK_ITEM && f.name === name);
}

function withoutMainFormOrder() {
  const s = baseSpec();
  delete workItemEntity(s).mainFormOrder;
  return s;
}

function errorFor(mutator, pattern) {
  const s = baseSpec();
  mutator(s);
  const r = validate(s);
  const errors = r.errors || [];
  assert.strictEqual(r.ok, false, JSON.stringify(r));
  assert.match(errors.join(' | '), pattern);
  assert.ok(errors.some((e) => e.includes(`entity '${WORK_ITEM}'`) && pattern.test(e)), JSON.stringify(errors));
}

test('baseline helper produces a valid spec for focused mainFormOrder mutations', () => {
  const r = validate(baseSpec());

  assert.deepStrictEqual(r.errors, []);
  assert.deepStrictEqual(r.warnings, []);
  assert.strictEqual(r.ok, true);
});

test('mainFormOrder is an allowed entity key and may list every Main form', () => {
  const r = validate(baseSpec());

  assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
  assert.ok(!(r.errors || []).some((e) => /unknown key 'mainFormOrder'/.test(e)));
  assert.ok(!(r.errors || []).some((e) => /mainFormOrder/.test(e)));
});

test('mainFormOrder accepts partial and single-entry orders', () => {
  for (const order of [
    ['My Work — Work Item', 'Work Item'],
    ['Work Item — Summary'],
  ]) {
    const s = baseSpec();
    workItemEntity(s).mainFormOrder = order;
    const r = validate(s);
    assert.strictEqual(r.ok, true, `${JSON.stringify(order)}: ${JSON.stringify(r.errors)}`);
    assert.ok(!(r.errors || []).some((e) => /mainFormOrder/.test(e)), JSON.stringify(r.errors));
  }
});

test('mainFormOrder rejects non-array, empty, non-string, and blank values with table context', () => {
  for (const bad of ['Work Item', { first: 'Work Item' }, [], ['Work Item', 42], ['Work Item', '   ']]) {
    errorFor(
      (s) => { workItemEntity(s).mainFormOrder = bad; },
      /mainFormOrder must be a non-empty array of Main form names from forms\[\]/
    );
  }
});

test('mainFormOrder rejects duplicate names case-insensitively', () => {
  errorFor(
    (s) => { workItemEntity(s).mainFormOrder = ['Work Item', 'work item']; },
    /mainFormOrder lists 'work item' more than once/
  );
});

test('mainFormOrder rejects unknown names while listing the table Main forms', () => {
  errorFor(
    (s) => { workItemEntity(s).mainFormOrder = ['Missing Form']; },
    /mainFormOrder names 'Missing Form', which is not a Main form of this table in forms\[\] \(its Main forms: 'Work Item', 'My Work — Work Item', 'Work Item — Summary'\)/
  );
});

test('mainFormOrder rejects QuickCreate and QuickView names because they are not in the Main Form Set', () => {
  errorFor(
    (s) => { workItemEntity(s).mainFormOrder = ['Quick Work Item']; },
    /mainFormOrder names 'Quick Work Item', a QuickCreate form — only Main forms are in the Main Form Set/
  );
  errorFor(
    (s) => { workItemEntity(s).mainFormOrder = ['Work Item Quick View']; },
    /mainFormOrder names 'Work Item Quick View', a QuickView form — only Main forms are in the Main Form Set/
  );
});

test('mainFormOrder rejects a Main form name that belongs to another table', () => {
  errorFor(
    (s) => { workItemEntity(s).mainFormOrder = ['Project Main']; },
    /mainFormOrder names 'Project Main', which is not a Main form of this table in forms\[\]/
  );
});

test('mainFormOrder rejects ambiguous same-table Main form names', () => {
  errorFor(
    (s) => {
      s.forms.push(main(WORK_ITEM, 'Work Item'));
      workItemEntity(s).mainFormOrder = ['Work Item'];
    },
    /mainFormOrder names 'Work Item', but 2 Main forms of this table share that name/
  );
});

test('mainFormOrder must agree with an explicit default form', () => {
  errorFor(
    (s) => {
      workItemForm(s, 'Work Item — Summary').isDefault = true;
      workItemEntity(s).mainFormOrder = ['Work Item', 'My Work — Work Item', 'Work Item — Summary'];
    },
    /form 'Work Item — Summary' sets isDefault, so it must come first in mainFormOrder/
  );
});

test('mainFormOrder cannot be combined with securityRoles.order on a Main form', () => {
  errorFor(
    (s) => {
      workItemForm(s, 'My Work — Work Item').securityRoles = { everyone: true, order: 0 };
    },
    /mainFormOrder and forms\[\]\.securityRoles\.order .* both set this table's form order/
  );
});

test('securityRoles.order warns when the selected default has no explicit order', () => {
  const s = withoutMainFormOrder();
  workItemForm(s, 'Work Item').isDefault = true;
  workItemForm(s, 'My Work — Work Item').securityRoles = { everyone: true, order: 0 };

  const r = validate(s);

  assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
  assert.match((r.warnings || []).join(' | '), /entity 'contoso_workitem': forms\[\]\.securityRoles\.order sets this table's form order/);
  assert.match((r.warnings || []).join(' | '), /'Work Item' opens first only if its securityRoles\.order is lower/);
});

test('securityRoles.order warning names a rival with a lower order', () => {
  const s = withoutMainFormOrder();
  workItemForm(s, 'Work Item').isDefault = true;
  workItemForm(s, 'Work Item').securityRoles = { everyone: true, order: 2 };
  workItemForm(s, 'My Work — Work Item').securityRoles = { everyone: true, order: 1 };

  const r = validate(s);

  assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
  assert.match((r.warnings || []).join(' | '), /'My Work — Work Item': 1/);
});

test('securityRoles.order does not warn when the selected default has the strictly lowest order', () => {
  const s = withoutMainFormOrder();
  workItemForm(s, 'Work Item').isDefault = true;
  workItemForm(s, 'Work Item').securityRoles = { everyone: true, order: 0 };
  workItemForm(s, 'My Work — Work Item').securityRoles = { everyone: true, order: 1 };

  const r = validate(s);

  assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
  assert.deepStrictEqual((r.warnings || []).filter((w) => /securityRoles\.order sets this table's form order/.test(w)), []);
});

test('securityRoles.order warns when the default ties another Main form order', () => {
  const s = withoutMainFormOrder();
  workItemForm(s, 'Work Item').isDefault = true;
  workItemForm(s, 'Work Item').securityRoles = { everyone: true, order: 1 };
  workItemForm(s, 'My Work — Work Item').securityRoles = { everyone: true, order: 1 };

  const r = validate(s);

  assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
  assert.match((r.warnings || []).join(' | '), /'My Work — Work Item': 1/);
});

test('securityRoles.order warns for the owned-table first-Main fallback but not an existing table with no selected default', () => {
  const own = withoutMainFormOrder();
  workItemForm(own, 'My Work — Work Item').securityRoles = { everyone: true, order: 0 };
  assert.match((validate(own).warnings || []).join(' | '), /'Work Item' opens first only if its securityRoles\.order is lower/);

  const existing = withoutMainFormOrder();
  workItemEntity(existing).existing = true;
  workItemForm(existing, 'My Work — Work Item').securityRoles = { everyone: true, order: 0 };
  const r = validate(existing);
  assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
  assert.deepStrictEqual((r.warnings || []).filter((w) => /securityRoles\.order sets this table's form order/.test(w)), []);
});

test('securityRoles.order emits no warning when mainFormOrder is present because the error covers the conflict', () => {
  const s = baseSpec();
  workItemForm(s, 'My Work — Work Item').securityRoles = { everyone: true, order: 0 };

  const r = validate(s);

  assert.strictEqual(r.ok, false);
  assert.match((r.errors || []).join(' | '), /both set this table's form order/);
  assert.deepStrictEqual((r.warnings || []).filter((w) => /securityRoles\.order sets this table's form order/.test(w)), []);
});

test('helper cloning keeps test mutations isolated', () => {
  const a = clone(baseSpec());
  const b = clone(baseSpec());
  workItemEntity(a).mainFormOrder = ['Work Item'];

  assert.deepStrictEqual(workItemEntity(b).mainFormOrder, MAIN_NAMES);
});
