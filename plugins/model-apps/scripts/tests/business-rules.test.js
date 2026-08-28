'use strict';
// `businessRules[]` — the App Spec surface over the SDK's business-rule compiler.
//
// Three layers, because a failure in any one of them is silent in a different way:
//   1. VALIDATION — the spec surface mirrors the SDK's supported slice exactly. Anything outside it
//      throws a ValidationError deep inside the push, so catching it here names the field instead.
//   2. MAPPING — `businessRuleDef` produces the SDK's node shape. This is the dangerous one: the
//      obvious shape (operator/lhs/rhs/thenActions) is silently MERGED and ignored, producing a rule
//      that deploys, activates, and never fires. See sdk-uptake-contract.test.js.
//   3. REAL BUNDLE — the mapped def is pushed through the shipped SDK and the compiled XAML is
//      inspected. Only this proves the author's columns actually reach the platform.
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const { validateAppSpec } = require('../lib/app-spec.js');
const { businessRuleDef } = require('../lib/sdk-build.js');

const BUNDLE = path.resolve(__dirname, '..', 'vendor', 'cds-maker-sdk.cjs');
const dirs = [];
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

// Minimal spec that is valid on its own, so a validation failure below is always about the rule.
function specWith(rules) {
  return {
    solution: { uniqueName: 'BR', displayName: 'BR', publisherPrefix: 'new' },
    app: { name: 'BR App', description: '' },
    entities: [{
      schemaName: 'new_ticket', displayName: 'Ticket', pluralName: 'Tickets',
      primaryAttribute: { schemaName: 'new_subject', displayName: 'Subject' },
      columns: [
        { schemaName: 'new_status', displayName: 'Status', type: 'Choice', options: ['New', 'Closed'] },
        { schemaName: 'new_notes', displayName: 'Notes', type: 'Memo' },
        { schemaName: 'new_owner', displayName: 'Owner', type: 'Text' },
      ],
    }],
    appShell: { areas: [{ label: 'Main', groups: [{ label: 'Records', subAreas: [{ entity: 'new_ticket', title: 'Tickets' }] }] }] },
    businessRules: rules,
  };
}
const RULE = {
  entity: 'new_ticket', name: 'Hide notes when closed',
  conditions: [{ field: 'new_status', operator: 'Equals', value: '100000001', dataType: 'Picklist' }],
  actions: [{ type: 'SetVisibility', field: 'new_notes', visible: false }],
};
const errorsFor = (rules) => (validateAppSpec(specWith(rules), { profile: 'plan' }).errors || []);

// --- 1. validation ----------------------------------------------------------------------------

test('a well-formed business rule validates', () => {
  const v = validateAppSpec(specWith([RULE]), { profile: 'plan' });
  assert.strictEqual(v.ok, true, JSON.stringify(v.errors));
});

test('a rule must name a known entity and its own columns', () => {
  assert.ok(errorsFor([{ ...RULE, entity: 'new_nope' }]).some((e) => /unknown entity/.test(e)));
  // A column that does not exist on the table is the silent case that matters: the platform accepts
  // such a rule and it simply never fires, so nothing downstream would catch it.
  assert.ok(errorsFor([{ ...RULE, conditions: [{ field: 'new_ghost', operator: 'Equals', value: '1' }] }])
    .some((e) => /'new_ghost', which is not a column on new_ticket/.test(e)));
  assert.ok(errorsFor([{ ...RULE, actions: [{ type: 'SetVisibility', field: 'new_ghost', visible: false }] }])
    .some((e) => /not a column on new_ticket/.test(e)));
});

test('operators and actions are constrained to the slice the SDK can compile', () => {
  // Outside the slice the SDK throws mid-push; the point of validating here is to name the field.
  assert.ok(errorsFor([{ ...RULE, conditions: [{ field: 'new_status', operator: 'BeginsWith', value: 'x' }] }])
    .some((e) => /condition operator must be one of/.test(e)));
  assert.ok(errorsFor([{ ...RULE, actions: [{ type: 'ShowErrorMessage', field: 'new_notes', message: 'x' }] }])
    .some((e) => /action type must be one of/.test(e)));
  for (const operator of ['Equals', 'DoesNotEqual']) {
    assert.deepStrictEqual(errorsFor([{ ...RULE, conditions: [{ field: 'new_status', operator, value: '1' }] }]), []);
  }
});

test('presence operators must not carry a value, and comparison operators must', () => {
  // Two different authoring mistakes, both of which compile to something the author did not mean.
  assert.ok(errorsFor([{ ...RULE, conditions: [{ field: 'new_notes', operator: 'ContainsData', value: 'x' }] }])
    .some((e) => /tests presence, so it must not carry a value/.test(e)));
  assert.ok(errorsFor([{ ...RULE, conditions: [{ field: 'new_status', operator: 'Equals' }] }])
    .some((e) => /needs a value/.test(e)));
  for (const operator of ['ContainsData', 'DoesNotContainData']) {
    assert.deepStrictEqual(errorsFor([{ ...RULE, conditions: [{ field: 'new_notes', operator }] }]), []);
  }
});

test('a boolean action payload must be a real boolean', () => {
  // "false" is truthy, so coercing would invert the author's intent silently — the same trap
  // `app.newLook` validation closes.
  for (const bad of ['false', 'true', 0, 1]) {
    assert.ok(errorsFor([{ ...RULE, actions: [{ type: 'SetVisibility', field: 'new_notes', visible: bad }] }])
      .some((e) => /must be a boolean/.test(e)), `visible=${JSON.stringify(bad)} must be rejected`);
  }
  assert.deepStrictEqual(errorsFor([{ ...RULE, actions: [{ type: 'LockUnlock', field: 'new_notes', lock: true }] }]), []);
  assert.ok(errorsFor([{ ...RULE, actions: [{ type: 'LockUnlock', field: 'new_notes' }] }])
    .some((e) => /needs 'lock'/.test(e)));
});

test('a rule with no conditions or no actions is rejected', () => {
  // Both compile to a rule that deploys and does nothing — the failure mode this whole surface exists
  // to make impossible.
  assert.ok(errorsFor([{ ...RULE, conditions: [] }]).some((e) => /conditions\[\] is required/.test(e)));
  assert.ok(errorsFor([{ ...RULE, actions: [] }]).some((e) => /actions\[\] is required/.test(e)));
});

// --- 2. mapping -------------------------------------------------------------------------------

test('businessRuleDef maps onto the SDK node shape (clauses + trueBranch), not the obvious one', () => {
  const def = businessRuleDef({
    ...RULE,
    actions: [
      { type: 'SetVisibility', field: 'new_notes', visible: false },
      { type: 'LockUnlock', field: 'new_owner', lock: true },
      { type: 'SetBusinessRequired', field: 'new_owner', required: true },
      { type: 'SetFieldValue', field: 'new_owner', value: 'unassigned' },
    ],
  });
  assert.strictEqual(def.entityLogicalName, 'new_ticket');
  assert.strictEqual(def.scope, 'Entity');
  assert.strictEqual(def.status, 'Active', 'a rule is inert until activated, so Active is the default');

  const rc = def.rootCondition;
  assert.strictEqual(rc.logic, 'AND');
  // The keys that matter. `thenActions`/`lhs`/`rhs` would be merged and ignored.
  assert.deepStrictEqual(Object.keys(rc).sort(), ['clauses', 'displayName', 'falseBranch', 'id', 'logic', 'trueBranch']);
  assert.deepStrictEqual(rc.clauses, [{
    id: 'c1', field: 'new_status', operator: 'Equals', valueType: 'Value', value: '100000001', valueWorkflowType: 'Picklist',
  }]);
  assert.deepStrictEqual(rc.trueBranch.map((a) => [a.type, a.field, a.visible ?? a.lock ?? a.required ?? a.value]), [
    ['SetVisibility', 'new_notes', false],
    ['LockUnlock', 'new_owner', true],
    ['SetBusinessRequired', 'new_owner', true],
    ['SetFieldValue', 'new_owner', 'unassigned'],
  ]);
  assert.ok(rc.trueBranch.every((a) => a.id && a.displayName), 'every action carries an id and a label');
});

test('a presence operator maps with no value at all', () => {
  // Emitting `value: undefined` would still add the key; the compiler treats a present-but-empty
  // value differently from an absent one.
  const def = businessRuleDef({ ...RULE, conditions: [{ field: 'new_notes', operator: 'ContainsData' }] });
  assert.deepStrictEqual(Object.keys(def.rootCondition.clauses[0]).sort(), ['field', 'id', 'operator', 'valueType']);
});

// --- 3. real bundle ---------------------------------------------------------------------------

test('REAL BUNDLE: the mapped rule compiles to XAML naming the authored columns', async () => {
  const { createMakerSdk } = require(BUNDLE);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'br-spec-'));
  dirs.push(dir);
  const calls = [];
  const sdk = createMakerSdk({
    workspacePath: dir, instanceUrl: 'https://contoso.crm.dynamics.com',
    httpClient: {
      get: async () => ({ status: 200, headers: {}, body: { value: [] } }),
      post: async (url, body) => {
        calls.push({ url, body });
        // Force the classic path so the compiled XAML is observable on the wire.
        if (/WithWfomJson/i.test(url)) return { status: 400, headers: {}, body: { error: { code: '0x80040216' } } };
        return { status: 204, headers: { 'odata-entityid': 'https://x/workflows(55555555-5555-5555-5555-555555555555)' }, body: {} };
      },
      patch: async () => ({ status: 204, headers: {}, body: {} }),
      put: async () => ({ status: 204, headers: {}, body: {} }),
      delete: async () => ({ status: 204, headers: {}, body: {} }),
    },
  });
  sdk.initWorkspace();

  const def = businessRuleDef(RULE);
  const art = sdk.createArtifact('businessRule', def);
  await sdk.updateElement('businessRule', art.id, '/rootCondition', def.rootCondition);
  const pushed = await sdk.pushArtifact('businessRule', art.id);
  assert.strictEqual(pushed.saved, true);

  const classic = calls.find((c) => /\/workflows$/.test(String(c.url)));
  assert.ok(classic, 'the classic row is written; urls: ' + JSON.stringify(calls.map((c) => c.url)));
  assert.strictEqual(classic.body.primaryentity, 'new_ticket');
  assert.strictEqual(classic.body.category, 2);
  // The assertion that matters: a well-formed but EMPTY rule would satisfy everything above.
  assert.match(classic.body.xaml, /new_status/, 'the condition column reaches the compiled XAML');
  assert.match(classic.body.xaml, /new_notes/, 'the action column reaches the compiled XAML');
});
