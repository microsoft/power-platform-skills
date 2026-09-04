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

test('operators and actions are constrained to the slice the SDK supports', () => {
  // Outside the slice the SDK does something WORSE than throwing: an unknown operator resolves to
  // Equals, so the point of validating here is to stop a wrong rule rather than to name a field.
  assert.ok(errorsFor([{ ...RULE, conditions: [{ field: 'new_status', operator: 'NotARealOperator', value: 'x' }] }])
    .some((e) => /condition operator must be one of/.test(e)));
  // `ShowErrorMessage` is modelled by the SDK but deliberately not exposed yet — it needs mapping in
  // businessRuleDef that cannot be live-verified on an environment without the bound member.
  assert.ok(errorsFor([{ ...RULE, actions: [{ type: 'ShowErrorMessage', field: 'new_notes', message: 'x' }] }])
    .some((e) => /action type must be one of/.test(e)));
  for (const operator of ['Equals', 'DoesNotEqual', 'BeginsWith', 'IsGreaterThan']) {
    assert.deepStrictEqual(errorsFor([{ ...RULE, conditions: [{ field: 'new_status', operator, value: '1' }] }]), []);
  }
});

test('presence operators are ACCEPTED now that the compiler emits a null parameter list', () => {
  // These were blocked while the compiler emitted an EMPTY parameter array for a valueless operator
  // (`[New Object() { }]`) where every server-authored rule writes `<x:Null x:Key="Parameters" />`.
  // An empty Object[] is not null, and the UiData generator answered HTTP 500 on it (#481).
  //
  // Fixed upstream and re-verified LIVE on a real org with the vendored bundle: all four operators
  // push successfully in one run, where previously the two presence operators failed 500 while
  // `Equals` succeeded alongside them.
  for (const operator of ['ContainsData', 'DoesNotContainData']) {
    const errs = errorsFor([{ ...RULE, conditions: [{ field: 'new_notes', operator }] }]);
    assert.deepStrictEqual(errs, [], `${operator} must now validate: ${JSON.stringify(errs)}`);
  }
});

test('comparison operators must carry a value', () => {
  assert.ok(errorsFor([{ ...RULE, conditions: [{ field: 'new_status', operator: 'Equals' }] }])
    .some((e) => /needs a value/.test(e)));
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

test('a presence operator still MAPS correctly (the mapper is fine; the platform is not)', () => {
  // Kept because the block is a platform limitation, not a mapping bug — when #481 is fixed the
  // operator can be re-enabled in validation without touching businessRuleDef. Emitting
  // `value: undefined` would still add the key, and the compiler treats present-but-empty
  // differently from absent.
  const def = businessRuleDef({ ...RULE, conditions: [{ field: 'new_notes', operator: 'ContainsData' }] });
  assert.deepStrictEqual(Object.keys(def.rootCondition.clauses[0]).sort(), ['field', 'id', 'operator', 'valueType']);
});

// --- 3. real bundle ---------------------------------------------------------------------------

test('REAL BUNDLE: the mapped rule reaches the wire as WfomJson naming the authored columns', async () => {
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

  const bound = calls.find((c) => /CreateProcessWithWfomJson/i.test(String(c.url)));
  assert.ok(bound, 'the bound member is the ONLY write path; urls: ' + JSON.stringify(calls.map((c) => c.url)));
  // There is no longer a classic `workflows` row to fall back to — the SDK deleted that compiler.
  assert.strictEqual(calls.some((c) => /\/workflows$/.test(String(c.url))), false,
    'no classic XAML row is written any more');
  assert.deepStrictEqual(Object.keys(bound.body).sort(), ['Entity', 'WfomJson']);

  // The assertion that matters: a well-formed but EMPTY rule would satisfy everything above.
  const wfom = String(bound.body.WfomJson);
  assert.match(wfom, /new_status/, 'the condition column reaches the workflow object model');
  assert.match(wfom, /new_notes/, 'the action column reaches the workflow object model');
  assert.match(wfom, /new_ticket/, 'the rule is bound to the authored table');
});

test('REAL BUNDLE: a valueless operator emits an EMPTY operand list and the IsNull/NotNull opcode', async () => {
  // A presence operator has nothing to compare against, so the SDK must emit NO right-hand operand
  // and the dedicated opcode — not `Equals` against an empty string, which is a different question
  // and would silently answer false for a populated column.
  //
  // Measured opcodes (WorkflowConditionOperator in the bundle): NotNull "1", IsNull "0".
  const { createMakerSdk } = require(BUNDLE);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'br-null-'));
  dirs.push(dir);

  for (const [operator, expectedOpcode] of [['ContainsData', '1'], ['DoesNotContainData', '0']]) {
    const calls = [];
    const sdk = createMakerSdk({
      workspacePath: fs.mkdtempSync(path.join(dir, 'w')), instanceUrl: 'https://contoso.crm.dynamics.com',
      httpClient: {
        get: async () => ({ status: 200, headers: {}, body: { value: [] } }),
        post: async (url, body) => {
          calls.push({ url, body });
          return { status: 204, headers: { 'odata-entityid': 'https://x/workflows(55555555-5555-5555-5555-555555555555)' }, body: {} };
        },
        patch: async () => ({ status: 204, headers: {}, body: {} }),
        put: async () => ({ status: 204, headers: {}, body: {} }),
        delete: async () => ({ status: 204, headers: {}, body: {} }),
      },
    });
    sdk.initWorkspace();

    const def = businessRuleDef({
      name: 'Presence Rule', entity: 'new_ticket',
      conditions: [{ field: 'new_notes', operator }],
      actions: [{ type: 'SetVisibility', field: 'new_owner', visible: false }],
    });
    const art = sdk.createArtifact('businessRule', def);
    await sdk.updateElement('businessRule', art.id, '/rootCondition', def.rootCondition);
    await sdk.pushArtifact('businessRule', art.id);

    const bound = calls.find((c) => /CreateProcessWithWfomJson/i.test(String(c.url)));
    assert.ok(bound, `${operator}: the bound member must be called`);
    const wfom = JSON.parse(bound.body.WfomJson);
    const expr = wfom.steps.list[0].steps.list[0].conditionExpression;
    assert.strictEqual(expr.conditionOperatoroperator, expectedOpcode,
      `${operator} must emit opcode ${expectedOpcode}, got ${expr.conditionOperatoroperator}`);
    assert.deepStrictEqual(expr.right, [], `${operator} must carry NO right-hand operand`);
    assert.strictEqual(expr.left.attributeName, 'new_notes');
  }
});

// --- peer-review findings: verified and fixed ---------------------------------------------------

test('REAL BUNDLE: dataType does NOT reach the wire — the SDK types every literal as String', async () => {
  // `dataType` used to be pinned against the XAML compiler's literal-type map. This uptake DELETED
  // that compiler, and the JSON path that replaced it does not consult the type at all: measured
  // across all 13 tokens the spec accepts (plus a made-up one), on BOTH the condition path and the
  // SetFieldValue action path, the SDK emits WorkflowAttributeType String ("14") every time.
  //
  //   `let r = valueType==='Lookup' ? ... : valueType==='Clear' ? (valueWorkflowType ?? String)
  //                                      : WorkflowAttributeType.String`
  //
  // So the field is currently DECORATIVE. It is still accepted and still validated — narrowly, so a
  // typo is caught and so the surface stays forward-compatible if the SDK starts honouring it — but
  // nothing downstream may claim it changes the deployed rule. This test exists to make that claim
  // impossible to make by accident: if the SDK begins emitting a real type, this fails and whoever
  // sees it must re-read the surface rather than discover the change in production.
  const { createMakerSdk } = require(BUNDLE);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'br-dt-'));
  dirs.push(dir);

  const STRING_TOKEN = '14'; // WorkflowAttributeType.String, read from the bundle's own enum.
  const { BUSINESS_RULE_DATA_TYPES } = require('../lib/app-spec.js');
  // Every token the spec accepts, plus one that is not a type at all — if the SDK ever starts
  // consulting the field, a made-up value is the case most likely to behave differently.
  const TOKENS = [...BUSINESS_RULE_DATA_TYPES, 'NotAWorkflowType'];

  const push = async (def) => {
    const calls = [];
    const sdk = createMakerSdk({
      workspacePath: fs.mkdtempSync(path.join(dir, 'w')), instanceUrl: 'https://contoso.crm.dynamics.com',
      httpClient: {
        get: async () => ({ status: 200, headers: {}, body: { value: [] } }),
        post: async (url, body) => {
          calls.push({ url, body });
          return { status: 204, headers: { 'odata-entityid': 'https://x/workflows(55555555-5555-5555-5555-555555555555)' }, body: {} };
        },
        patch: async () => ({ status: 204, headers: {}, body: {} }),
        put: async () => ({ status: 204, headers: {}, body: {} }),
        delete: async () => ({ status: 204, headers: {}, body: {} }),
      },
    });
    sdk.initWorkspace();
    const art = sdk.createArtifact('businessRule', def);
    await sdk.updateElement('businessRule', art.id, '/rootCondition', def.rootCondition);
    await sdk.pushArtifact('businessRule', art.id);
    return JSON.parse(calls.find((c) => /CreateProcessWithWfomJson/i.test(String(c.url))).body.WfomJson);
  };

  for (const dataType of TOKENS) {
    // 1. the CONDITION path
    const condWfom = await push(businessRuleDef({
      ...RULE, conditions: [{ field: 'new_status', operator: 'Equals', value: '1', dataType }],
    }));
    const expr = condWfom.steps.list[0].steps.list[0].conditionExpression;
    assert.strictEqual(expr.type, STRING_TOKEN, `condition dataType '${dataType}' unexpectedly reached the wire as ${expr.type}`);
    assert.strictEqual(expr.right[0].type, STRING_TOKEN, `condition dataType '${dataType}' unexpectedly typed the literal as ${expr.right[0].type}`);

    // 2. the SetFieldValue ACTION path, which reads a DIFFERENT field on a different code path — the
    //    SDK does pass `valueWorkflowType` into the action serializer, so this is the one that could
    //    plausibly differ, and asserting only the condition path would not have shown it.
    const actWfom = await push(businessRuleDef({
      ...RULE,
      conditions: [{ field: 'new_notes', operator: 'ContainsData' }],
      actions: [{ type: 'SetFieldValue', field: 'new_owner', value: 'x', dataType }],
    }));
    const types = [...JSON.stringify(actWfom.steps.list[0].steps.list[0].steps.list[0]).matchAll(/"type":"(\d+)"/g)].map((m) => m[1]);
    assert.ok(types.length > 0, `action dataType '${dataType}': no type token found on the wire`);
    assert.deepStrictEqual([...new Set(types)], [STRING_TOKEN],
      `action dataType '${dataType}' unexpectedly reached the wire as ${JSON.stringify([...new Set(types)])}`);
  }

  // The spec-level list stays a CLOSED set even though the SDK ignores it, so a typo is still a
  // spec-gate error rather than a silently-accepted no-op.
  assert.ok(Array.isArray(BUSINESS_RULE_DATA_TYPES) && BUSINESS_RULE_DATA_TYPES.length > 0);
  assert.ok(!BUSINESS_RULE_DATA_TYPES.includes('DateTime'),
    'DateTime stays out: it was never exercised, and the SDK ignoring the field today is not a reason to promise a type we have not tested');
});

test('a DateTime dataType is rejected at the spec gate, not mid-build', () => {
  const res = validateAppSpec(specWith([{
    name: 'R', entity: 'new_ticket',
    conditions: [{ field: 'new_owner', operator: 'Equals', value: 'x', dataType: 'DateTime' }],
    actions: [{ type: 'SetVisibility', field: 'new_notes', visible: false }],
  }]));
  assert.ok(res.errors.some((e) => /dataType/i.test(e) && /DateTime/.test(e)), `expected a dataType error, got ${JSON.stringify(res.errors)}`);
});

// --- verify reconciles business rules (previously: no checks at all) ----------------------------

const { verifySpec } = require('../lib/verify-spec.js');

function ruleSpec(status) {
  const s = specWith([{
    name: 'Lock when closed', entity: 'new_ticket',
    conditions: [{ field: 'new_owner', operator: 'Equals', value: 'x', dataType: 'String' }],
    actions: [{ type: 'SetVisibility', field: 'new_notes', visible: false }],
    ...(status ? { status } : {}),
  }]);
  return s;
}
const baseReader = (workflows) => ({
  findTable: async () => ({ logicalName: 'new_ticket' }),
  findColumns: async () => [{ logicalName: 'new_status' }, { logicalName: 'new_notes' }, { logicalName: 'new_owner' }],
  queryRecords: async (entity) => (entity === 'workflow' ? workflows : []),
  sitemapXml: async () => '',
});
const ruleCheck = (r) => r.checks.find((c) => c.kind === 'business-rule');

test('verify PASSES an Active rule the spec wants Active', async () => {
  const r = await verifySpec(ruleSpec(), baseReader([{ workflowid: 'w1', statecode: 1 }]));
  assert.strictEqual(ruleCheck(r).present, true);
});

test('verify FAILS a rule that never deployed', async () => {
  const c = ruleCheck(await verifySpec(ruleSpec(), baseReader([])));
  assert.strictEqual(c.present, false);
  assert.match(c.detail, /not deployed/);
});

test('verify FAILS a rule deployed as Draft — "exists" is not "runs"', async () => {
  const c = ruleCheck(await verifySpec(ruleSpec(), baseReader([{ workflowid: 'w1', statecode: 0 }])));
  assert.strictEqual(c.present, false);
  assert.match(c.detail, /DRAFT/);
});

test('verify FAILS duplicates — the #482 residue the build cannot always remove', async () => {
  const c = ruleCheck(await verifySpec(ruleSpec(), baseReader([{ workflowid: 'w1', statecode: 1 }, { workflowid: 'w2', statecode: 1 }])));
  assert.strictEqual(c.present, false);
  assert.match(c.detail, /2 rules share this name/);
});

test('verify FAILS an ACTIVE rule the spec asks to be Draft', async () => {
  const c = ruleCheck(await verifySpec(ruleSpec('Draft'), baseReader([{ workflowid: 'w1', statecode: 1 }])));
  assert.strictEqual(c.present, false);
  assert.match(c.detail, /running/);
});

test('verify fails CLOSED when the workflow read itself errors', async () => {
  // "Could not look" must never read as "present and correct".
  const read = Object.assign(baseReader([]), {
    queryRecords: async (entity) => { if (entity === 'workflow') throw new Error('HTTP 401'); return []; },
  });
  const c = ruleCheck(await verifySpec(ruleSpec(), read));
  assert.strictEqual(c.present, false);
  assert.match(c.detail, /could not be read/);
});

// --- rebuild repairs legacy duplicates (peer-review finding) ------------------------------------
//
// Before the SDK fix, a build could leave two rows for one rule. The reuse branch queried `top: 1`
// and returned immediately, so the de-duplication sweep — which lived only on the CREATE path —
// never ran on a rebuild. Both rules kept firing forever, and because `top: 1` is unordered, the row
// adopted as "the" rule could be the faulted orphan rather than the good one.
const { runSdkBuild: runBuild } = require('../lib/sdk-build.js');

function ruleOnlySpec() {
  const s = specWith([{
    name: 'Lock when closed', entity: 'new_ticket',
    conditions: [{ field: 'new_owner', operator: 'Equals', value: 'x', dataType: 'String' }],
    actions: [{ type: 'SetVisibility', field: 'new_notes', visible: false }],
  }]);
  return s;
}

// Minimal provision double: only the workflow surface the business-rules phase touches.
function provisionWithRules(rows) {
  const calls = [];
  return {
    calls,
    provision: {
      queryRecords: async (entity, opts) => {
        if (entity === 'workflow') { calls.push(['queryRecords', entity, opts]); return rows; }
        return entity === 'solution' ? [] : [{ publisherid: 'pub-1' }];
      },
      updateRecord: async (e, id, patch) => { calls.push(['updateRecord', e, id, patch]); },
      deleteRecord: async (e, id) => { calls.push(['deleteRecord', e, id]); },
      createArtifact: () => ({ id: 'br-new' }),
      updateElement: async () => undefined,
      pushArtifact: async () => ({ id: 'br-new', saved: true, publish: { kind: 'notRequested' } }),
      addSolutionComponent: async () => undefined,
    },
  };
}

// --- the designer's own completeness validator, run BEFORE the push -----------------------------
//
// The trap it closes is pinned in sdk-uptake-contract.test.js: a condition tree in the wrong shape is
// MERGED onto the node, ignored by the serializer, and written as a rule with no clauses and no
// actions — 204, activated, and it never fires. Nothing on the push path detects that, and nothing
// afterwards can either. This SDK exposes the validator the designer gates Save on; the build runs it.

test('a rule the designer calls incomplete HALTS before anything is written', async () => {
  const { sdk } = require('./helpers/mock-sdk.js').makeSimpleMockSdk();
  const { provision } = provisionWithRules([]);
  const pushes = [];
  // `provisionWithRules` does not record pushes, and an assertion against a call list that can never
  // contain the value is vacuous — so record it here rather than assert on nothing.
  provision.pushArtifact = async (...a) => { pushes.push(a); return { id: 'br-new', saved: true, publish: { kind: 'notRequested' } }; };
  provision.validateBusinessRule = () => ([
    { pointer: '/rootCondition (root)', rule: 'business-rule-NO_ACTION', message: 'A business rule must include at least one action step.' },
  ]);

  const err = await runBuild(ruleOnlySpec(), {
    sdk, provisionSdk: provision, apply: true, phases: ['business-rules'], warn: () => {},
  }).then(() => null, (e) => e);

  assert.ok(err, 'an incomplete rule must not be pushed');
  assert.match(err.message, /never fires/, `the halt must say what the rule would do; got: ${err && err.message}`);
  assert.match(err.message, /NO_ACTION/, "the designer's own finding is the actionable part");
  assert.deepStrictEqual(pushes, [], 'the refusal must come BEFORE the write, not after it');
});

test('the validator is best-effort: an older bundle without it, or one that throws, still builds', async () => {
  // A DIAGNOSTIC must never be the thing that breaks a build. The bundle is re-vendored routinely and
  // the plugin supports the generation before this method existed, so absence is a normal state —
  // and a validator that itself faults tells us nothing about the rule.
  const { sdk } = require('./helpers/mock-sdk.js').makeSimpleMockSdk();
  for (const [label, mutate] of [
    ['absent', (p) => { delete p.validateBusinessRule; }],
    ['throws', (p) => { p.validateBusinessRule = () => { throw new Error('validator exploded'); }; }],
    ['returns a non-array', (p) => { p.validateBusinessRule = () => undefined; }],
  ]) {
    const { provision } = provisionWithRules([]);
    mutate(provision);
    const res = await runBuild(ruleOnlySpec(), {
      sdk, provisionSdk: provision, apply: true, phases: ['business-rules'], warn: () => {},
    });
    assert.strictEqual(res.ok, true, `validator ${label} must not fail the build`);
    const only = ruleOnlySpec().businessRules[0];
    assert.strictEqual(res.created.businessRules[`${only.entity.toLowerCase()}|${only.name}`], 'br-new',
      `validator ${label}: the rule must still be authored`);
    assert.deepStrictEqual(res.skipped.businessRules, [], `validator ${label}: and not recorded as skipped`);
  }
});

test('REAL BUNDLE: the validator accepts EVERY shape this spec surface can author', () => {
  // The one way wiring the validator could regress a working build is if it rejected something the
  // App Spec already allows. So the assertion is over the spec surface's OWN declared sets rather
  // than a hand-picked sample — a future operator or action type added to app-spec.js is covered the
  // day it is added, without anyone remembering to extend this test.
  const { BUSINESS_RULE_OPERATORS, BUSINESS_RULE_VALUELESS_OPERATORS, BUSINESS_RULE_ACTION_TYPES, BUSINESS_RULE_SCOPES } = require('../lib/app-spec.js');
  const { createMakerSdk } = require(BUNDLE);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brval-'));
  dirs.push(dir);
  const noop = async () => ({ status: 200, headers: {}, body: { value: [] } });
  const sdk = createMakerSdk({
    workspacePath: dir, instanceUrl: 'https://contoso.crm.dynamics.com',
    httpClient: { get: noop, post: noop, patch: noop, put: noop, delete: noop },
  });
  sdk.initWorkspace();

  // The payload each action type carries — mirrors BUSINESS_RULE_ACTIONS in app-spec.js.
  const ACTION_PAYLOAD = { SetVisibility: { visible: false }, LockUnlock: { lock: true }, SetBusinessRequired: { required: true }, SetFieldValue: { value: 'x', dataType: 'String' } };
  const shapes = [];
  for (const op of BUSINESS_RULE_OPERATORS) {
    const valueless = BUSINESS_RULE_VALUELESS_OPERATORS.has(op);
    shapes.push([`operator ${op}`, { entity: 'new_ticket', name: `Op ${op}`, conditions: [Object.assign({ field: 'new_owner', operator: op }, valueless ? {} : { value: 'x', dataType: 'String' })], actions: [{ type: 'SetVisibility', field: 'new_notes', visible: false }] }]);
  }
  for (const type of BUSINESS_RULE_ACTION_TYPES) {
    assert.ok(ACTION_PAYLOAD[type], `this test must be taught the payload for a new action type '${type}'`);
    shapes.push([`action ${type}`, { entity: 'new_ticket', name: `Act ${type}`, conditions: [{ field: 'new_owner', operator: 'Equals', value: 'x', dataType: 'String' }], actions: [Object.assign({ type, field: 'new_notes' }, ACTION_PAYLOAD[type])] }]);
  }
  for (const scope of BUSINESS_RULE_SCOPES) {
    shapes.push([`scope ${scope}`, { entity: 'new_ticket', name: `Sc ${scope}`, scope, conditions: [{ field: 'new_owner', operator: 'Equals', value: 'x', dataType: 'String' }], actions: [{ type: 'SetVisibility', field: 'new_notes', visible: false }] }]);
  }
  shapes.push(['multi-condition + multi-action', { entity: 'new_ticket', name: 'Multi', conditions: [{ field: 'new_owner', operator: 'Equals', value: 'x', dataType: 'String' }, { field: 'new_notes', operator: 'ContainsData' }], actions: [{ type: 'SetVisibility', field: 'new_notes', visible: false }, { type: 'LockUnlock', field: 'new_owner', lock: true }] }]);

  const rejected = [];
  for (const [label, rule] of shapes) {
    const def = businessRuleDef(rule);
    const art = sdk.createArtifact('businessRule', def);
    const issues = sdk.validateBusinessRule(Object.assign({}, art, { rootCondition: def.rootCondition }));
    if (issues && issues.length) rejected.push(`${label}: ${JSON.stringify(issues)}`);
  }
  assert.deepStrictEqual(rejected, [],
    `the build HALTS on findings, so a rejected authorable shape is a build the spec gate said was fine:\n${rejected.join('\n')}`);
  assert.ok(shapes.length >= 20, `the matrix must be broad enough to mean something; got ${shapes.length}`);

  // Negative control: without this the assertion above is satisfied by a validator that finds
  // nothing at all, and the gate would be inert while looking healthy.
  const empty = sdk.createArtifact('businessRule', { name: 'Empty', entityLogicalName: 'new_ticket', scope: 'Entity', status: 'Draft' });
  const control = sdk.validateBusinessRule(empty);
  assert.ok(control && control.length > 0, 'the validator must actually report on a rule with no clauses and no actions');
  assert.match(JSON.stringify(control), /NO_ACTION/, 'and name the missing action step');
});

test('a rebuild REMOVES duplicates an earlier build left behind', async () => {
  const { sdk } = require('./helpers/mock-sdk.js').makeSimpleMockSdk();
  const { provision, calls } = provisionWithRules([
    { workflowid: 'keep-oldest', statecode: 1, createdon: '2026-01-01T00:00:00Z' },
    { workflowid: 'dupe-1', statecode: 1, createdon: '2026-01-01T00:00:05Z' },
  ]);
  const warnings = [];
  await runBuild(ruleOnlySpec(), {
    sdk, provisionSdk: provision, apply: true,
    phases: ['business-rules'], warn: (m) => warnings.push(m),
  });

  // The extra row is deactivated then deleted; the FIRST (oldest) row is kept.
  const deletes = calls.filter((c) => c[0] === 'deleteRecord').map((c) => c[2]);
  assert.deepStrictEqual(deletes, ['dupe-1'], `expected only the duplicate to be deleted, got ${JSON.stringify(deletes)}`);
  assert.ok(warnings.some((w) => /duplicate left by an earlier build/.test(w)), `expected a warning; got ${JSON.stringify(warnings)}`);
});

test('the reuse query is ORDERED and asks for more than one row', async () => {
  // `top: 1` unordered is what made the survivor arbitrary and hid the duplicates entirely.
  const { sdk } = require('./helpers/mock-sdk.js').makeSimpleMockSdk();
  const { provision, calls } = provisionWithRules([{ workflowid: 'only', statecode: 1, createdon: '2026-01-01T00:00:00Z' }]);
  await runBuild(ruleOnlySpec(), { sdk, provisionSdk: provision, apply: true, phases: ['business-rules'] });
  const q = calls.find((c) => c[0] === 'queryRecords');
  assert.ok(q, 'the reuse query must run');
  assert.ok(q[2].top > 1, `the reuse query must be able to SEE duplicates; top was ${q[2].top}`);
  assert.match(String(q[2].orderBy), /createdon asc/, 'oldest-first makes the surviving row deterministic');
});

test('a single existing rule is left completely alone', async () => {
  // The repair must not become a delete-happy sweep: one row is the healthy case.
  const { sdk } = require('./helpers/mock-sdk.js').makeSimpleMockSdk();
  const { provision, calls } = provisionWithRules([{ workflowid: 'only', statecode: 1, createdon: '2026-01-01T00:00:00Z' }]);
  const warnings = [];
  await runBuild(ruleOnlySpec(), { sdk, provisionSdk: provision, apply: true, phases: ['business-rules'], warn: (m) => warnings.push(m) });
  assert.strictEqual(calls.filter((c) => c[0] === 'deleteRecord').length, 0);
  assert.strictEqual(warnings.length, 0);
});

// --- the activated copy is NOT a duplicate (live-measured) --------------------------------------
//
// Activating a business rule makes Dataverse create a SECOND workflows row:
//   type=1, parentworkflowid=(none)  -> the definition
//   type=2, parentworkflowid=<def>   -> the platform's activated copy
// Measured directly: a Draft create yields 1 row; a plain PATCH to statecode 1 yields 2. A PATCH
// cannot create anything, so the platform made it, and the pair is normal for any activated process.
//
// Every business-rule query must therefore filter `type eq 1`. Without it the build tried to delete
// the activated copy (405), warned about a "duplicate" that did not exist, and verify would have
// failed EVERY active rule. The vendored SDK's own orphan probe filters the same way.
const { businessRuleFilter } = require('../lib/sdk-build.js');

test('businessRuleFilter selects the definition only', () => {
  const f = businessRuleFilter("O'Brien rule", 'CFO_WorkOrder');
  assert.match(f, /category eq 2/);
  assert.match(f, /type eq 1/, 'without `type eq 1` the activated copy is counted as a duplicate');
  assert.match(f, /primaryentity eq 'cfo_workorder'/, 'entity is lower-cased for the logical name');
  assert.match(f, /name eq 'O''Brien rule'/, "a quote in the name must be OData-escaped, not left to break the filter");
});

test('every business-rule query constrains workflow type intentionally', () => {
  // A guard on the SOURCE, because the call sites are in different modules and it is the omission
  // — not a wrong value — that caused the defect. Build/verify must select definitions only; teardown
  // is the deliberate exception after #493, because it owns the activated copy before table deletion.
  const fs = require('node:fs');
  const path = require('node:path');
  for (const file of ['sdk-build.js', 'verify-spec.js']) {
    const src = fs.readFileSync(path.resolve(__dirname, '..', 'lib', file), 'utf8');
    const raw = src.match(/category eq 2(?! and type eq 1)/g) || [];
    // The only permitted mention of `category eq 2` without `type eq 1` is inside businessRuleFilter
    // itself, which immediately follows it with the type clause — hence the negative lookahead above
    // matching nothing.
    assert.deepStrictEqual(raw, [], `${file} has a business-rule query that does not constrain type: ${raw.join(' | ')}`);
  }
  const teardown = fs.readFileSync(path.resolve(__dirname, '..', 'lib', 'sdk-teardown.js'), 'utf8');
  assert.match(teardown, /type eq 1 or type eq 2/, 'teardown must include the activated-copy row it is responsible for deleting');
});

test('a rule with an activated copy present is NOT reported as duplicated', async () => {
  // The reader is filtered server-side in production; this pins that verify treats a single
  // definition row as healthy rather than counting anything extra it might receive.
  const spec = specWith([{
    name: 'Lock when closed', entity: 'new_ticket',
    conditions: [{ field: 'new_owner', operator: 'Equals', value: 'x', dataType: 'String' }],
    actions: [{ type: 'SetVisibility', field: 'new_notes', visible: false }],
  }]);
  const read = {
    findTable: async () => ({ logicalName: 'new_ticket' }),
    findColumns: async () => [{ logicalName: 'new_status' }, { logicalName: 'new_notes' }, { logicalName: 'new_owner' }],
    queryRecords: async (entity, opts) => {
      if (entity !== 'workflow') return [];
      assert.match(String(opts.filter), /type eq 1/, 'verify must ask the server for definitions only');
      return [{ workflowid: 'def-1', statecode: 1 }];
    },
    sitemapXml: async () => '',
  };
  const r = await verifySpec(spec, read);
  const c = r.checks.find((x) => x.kind === 'business-rule');
  assert.strictEqual(c.present, true, `an active rule with its activated copy must PASS; detail: ${c.detail}`);
});

// --- #488 follow-ups -----------------------------------------------------------------------------

test('a multi-condition rule is now ACCEPTED — the single-clause limit was the deleted compiler', () => {
  // This gate existed because `businessRuleXaml.ts` threw
  // "this increment supports a single clause (got N); multi-clause AND/OR is a follow-up", and
  // `bodyXml` only ever read clauses[0]. That compiler has been deleted upstream: the JSON path
  // folds N clauses with LogicalAnd, MEASURED through the real bundle (see the wire test below).
  //
  // Kept as a test rather than deleted, because re-introducing the gate would silently reject specs
  // that now deploy correctly.
  const errs = errorsFor([{
    ...RULE,
    conditions: [
      { field: 'new_status', operator: 'Equals', value: 'Closed', dataType: 'Picklist' },
      { field: 'new_owner', operator: 'Equals', value: 'x', dataType: 'String' },
    ],
  }]);
  assert.deepStrictEqual(errs, [], `a two-clause rule must validate, got ${JSON.stringify(errs)}`);
});

test('one condition still validates', () => {
  assert.deepStrictEqual(errorsFor([RULE]), []);
});

test('an object-valued businessRules is a validation error, not a TypeError', () => {
  // spec-shape normalises collections so a malformed spec fails at the gate with a message naming
  // the field. `businessRules`/`conditions`/`actions` were missing from that map, so an object where
  // an array belongs reached a raw `for...of` and threw.
  const { validateAppSpec: validate } = require('../lib/app-spec.js');
  const spec = specWith([]);
  spec.businessRules = { name: 'not an array' };
  const res = validate(spec); // must not throw
  assert.ok(Array.isArray(res.errors));
  assert.ok(res.errors.length > 0, 'a malformed businessRules must be reported');
});

test('object-valued conditions/actions are reported, not thrown', () => {
  const { validateAppSpec: validate } = require('../lib/app-spec.js');
  for (const field of ['conditions', 'actions']) {
    const spec = specWith([{ ...RULE, [field]: { bad: true } }]);
    const res = validate(spec); // must not throw
    assert.ok(Array.isArray(res.errors) && res.errors.length > 0, `${field} must be reported`);
  }
});

// --- an environment that cannot host business rules at all --------------------------------------
//
// The vendored SDK writes rules ONLY through the bound `CreateProcessWithWfomJson` member; the
// client-side XAML fallback it used to compile was deleted upstream because it covered 4 of the 7
// action types and one clause, so it silently narrowed a rule into something that did not say what
// the author wrote.
//
// The consequence is environment-visible. MEASURED live on a real environment: `$metadata` does not
// declare the member and every POST to it answers 404, and the SDK's own message reports 18 of 20
// environments in the same state. So this is the COMMON case, not an edge case.
//
// The build degrades the way `app.newLook` already does for its tenant-gated setting: skip, say so
// once and specifically, and let the rest of the app build. Halting would abandon a run that has
// already created everything else.
function provisionThatCannotAuthorRules(rows = []) {
  const calls = [];
  const err = Object.assign(new Error(
    "This environment does not expose 'Microsoft.Dynamics.CRM.CreateProcessWithWfomJson', so business rules cannot be authored here."),
  { code: 'BUSINESS_RULE_API_UNAVAILABLE' });
  return {
    calls,
    provision: {
      queryRecords: async (entity, opts) => {
        if (entity === 'workflow') { calls.push(['queryRecords', entity, opts]); return rows; }
        return entity === 'solution' ? [] : [{ publisherid: 'pub-1' }];
      },
      updateRecord: async (e, id, patch) => { calls.push(['updateRecord', e, id, patch]); },
      deleteRecord: async (e, id) => { calls.push(['deleteRecord', e, id]); },
      createArtifact: () => ({ id: 'br-new' }),
      updateElement: async () => undefined,
      pushArtifact: async () => { calls.push(['pushArtifact']); throw err; },
      addSolutionComponent: async () => { calls.push(['addSolutionComponent']); },
    },
  };
}

test('an environment without the bound member SKIPS the rule instead of halting the build', async () => {
  const { sdk } = require('./helpers/mock-sdk.js').makeSimpleMockSdk();
  const { provision, calls } = provisionThatCannotAuthorRules();
  const warnings = [];
  const events = [];

  // The whole point: this resolves. Before the fix it rejected with a BuildHalt, and every phase
  // after business-rules never ran.
  const res = await runBuild(ruleOnlySpec(), {
    sdk, provisionSdk: provision, apply: true,
    phases: ['business-rules'], warn: (m) => warnings.push(m), emit: (e) => events.push(e),
  });
  assert.strictEqual(res.ok, true, 'the build must complete');

  // Nothing was written in the rule's place.
  assert.strictEqual(calls.some((c) => c[0] === 'addSolutionComponent'), false,
    'a rule that was never created must not be added to the solution');

  // The operator is told exactly what happened and what to do, ONCE.
  assert.strictEqual(warnings.length, 1, `expected exactly one warning, got ${JSON.stringify(warnings)}`);
  assert.match(warnings[0], /business rules were NOT created/);
  assert.match(warnings[0], /CreateProcessWithWfomJson/, 'name the member so it can be searched for');
  assert.match(warnings[0], /Everything else in the app was built normally/);

  // The skip is visible in the event stream, and labelled for what it IS — not "(exists)".
  const skip = events.find((e) => e.phase === 'business-rules' && e.status === 'skip');
  assert.ok(skip, `expected a skip event; got ${JSON.stringify(events.map((e) => [e.phase, e.status, e.label]))}`);
  assert.match(skip.label, /unsupported in this environment/);
  assert.doesNotMatch(skip.label, /exists/, 'labelling this "(exists)" states the opposite of the truth');

  // And it is recorded on the result, so --verify and the summary can report it rather than
  // implying the rules are there. Keyed off the spec so a rename of the fixture cannot make this
  // assertion vacuous.
  const only = ruleOnlySpec().businessRules[0];
  assert.deepStrictEqual(res.skipped.businessRules, [`${only.entity.toLowerCase()}|${only.name}`]);
  assert.strictEqual(Object.keys(res.created.businessRules).length, 0);
});

test('the unsupported-environment warning is emitted ONCE, not once per rule', async () => {
  // On such an environment EVERY rule skips, so a per-rule paragraph would bury the rest of the
  // build output under copies of the same text.
  const { sdk } = require('./helpers/mock-sdk.js').makeSimpleMockSdk();
  const { provision } = provisionThatCannotAuthorRules();
  const warnings = [];
  const spec = ruleOnlySpec();
  spec.businessRules = [
    { ...RULE, name: 'Rule A' },
    { ...RULE, name: 'Rule B' },
    { ...RULE, name: 'Rule C' },
  ];
  const res = await runBuild(spec, {
    sdk, provisionSdk: provision, apply: true, phases: ['business-rules'], warn: (m) => warnings.push(m),
  });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(warnings.length, 1, `expected one warning for three rules, got ${warnings.length}`);
  assert.strictEqual(res.skipped.businessRules.length, 3, 'but every skipped rule is still recorded');
});

test('any OTHER business-rule failure still HALTS — the skip is not a blanket catch', async () => {
  // The dangerous over-correction: swallowing every push failure would turn a real breakage (403,
  // 429, a malformed rule) into a silently ruleless app that reports success.
  const { sdk } = require('./helpers/mock-sdk.js').makeSimpleMockSdk();
  for (const code of ['CONNECTION_ERROR', 'VALIDATION_ERROR', undefined]) {
    const { provision } = provisionThatCannotAuthorRules();
    provision.pushArtifact = async () => { throw Object.assign(new Error('boom'), code ? { code } : {}); };
    await assert.rejects(
      () => runBuild(ruleOnlySpec(), { sdk, provisionSdk: provision, apply: true, phases: ['business-rules'], warn: () => {} }),
      `code ${String(code)} must still halt the build`);
  }
});

// --- the SDK moved this signal from a THROW to a RETURN (SDK uptake) -----------------------------
//
// The bundle used to throw `BUSINESS_RULE_API_UNAVAILABLE` out of `pushArtifact`. It now treats the
// preview rollout as a reported no-op and RESOLVES with `{ saved: false, error }` instead — measured
// against the vendored bundle, a 404 on the bound member resolves while 400/401/403/429/500 still
// throw.
//
// That is invisible to a mock that keeps throwing, which is exactly why the whole plugin suite
// stayed green through the uptake while the real bundle would have HALTED every build on an
// environment without the member — i.e. most of them. `requireSuccessfulPush` turns any by-value
// failure into a BuildHalt, so the error the skip predicate sees is the halt, not the SdkError.
//
// These two tests pin the RESULT-shaped contract so it cannot regress back.
function byValuePushFailure(code, message) {
  const { provision, calls } = provisionThatCannotAuthorRules();
  provision.pushArtifact = async () => {
    calls.push(['pushArtifact']);
    // The exact shape the bundle returns: a PushResult carrying the SdkError, not a throw.
    return { type: 'businessRule', id: 'br-new', saved: false, shipped: false, publish: { kind: 'notRequested' }, error: Object.assign(new Error(message), { code }) };
  };
  return { provision, calls };
}

test('an unavailable bound member reported BY VALUE still skips, and does not halt the build', async () => {
  const { sdk } = require('./helpers/mock-sdk.js').makeSimpleMockSdk();
  const { provision, calls } = byValuePushFailure('BUSINESS_RULE_API_UNAVAILABLE',
    "Business-rule authoring (preview) is not enabled on this environment yet: it does not expose 'Microsoft.Dynamics.CRM.CreateProcessWithWfomJson'.");
  const warnings = [];
  const events = [];
  const res = await runBuild(ruleOnlySpec(), {
    sdk, provisionSdk: provision, apply: true,
    phases: ['business-rules'], warn: (m) => warnings.push(m), emit: (e) => events.push(e),
  });

  assert.strictEqual(res.ok, true, 'the build must complete, exactly as it does for the thrown form');
  const only = ruleOnlySpec().businessRules[0];
  assert.deepStrictEqual(res.skipped.businessRules, [`${only.entity.toLowerCase()}|${only.name}`]);
  assert.strictEqual(Object.keys(res.created.businessRules).length, 0);
  assert.strictEqual(calls.some((c) => c[0] === 'addSolutionComponent'), false,
    'a rule that was never created must not be added to the solution');

  assert.strictEqual(warnings.length, 1, `expected exactly one warning, got ${JSON.stringify(warnings)}`);
  assert.match(warnings[0], /business rules were NOT created/);
  const skip = events.find((e) => e.phase === 'business-rules' && e.status === 'skip');
  assert.ok(skip, `expected a skip event; got ${JSON.stringify(events.map((e) => [e.phase, e.status, e.label]))}`);
  assert.match(skip.label, /unsupported in this environment/);
});

test('BUSINESS_RULE_LEFT_DEACTIVATED is NOT swallowed by the preview skip — it halts and says why', async () => {
  // The SDK raises this DISTINCT code when a write failed AND it could not put the rule back into
  // the Activated state it found it in, so a live rule is sitting Draft on the server. Collapsing it
  // into the preview no-op would tell the operator "not enabled here" while their rule is disabled —
  // the SDK's own comment says it must not collapse, so the plugin must not collapse it either.
  const { sdk } = require('./helpers/mock-sdk.js').makeSimpleMockSdk();
  const { provision } = byValuePushFailure('BUSINESS_RULE_LEFT_DEACTIVATED',
    "The business-rule write failed AND the rule could not be re-activated, so 'br-9' is left DEACTIVATED (Draft) on the server.");
  const err = await runBuild(ruleOnlySpec(), {
    sdk, provisionSdk: provision, apply: true, phases: ['business-rules'], warn: () => {},
  }).then(() => null, (e) => e);

  assert.ok(err, 'a rule left deactivated must not be reported as a benign skip');
  assert.match(err.message, /DEACTIVATED/,
    `the halt must carry the SDK's own diagnosis; got: ${err && err.message}`);
  assert.doesNotMatch(err.message, /changed in Maker since it was fetched/,
    'reporting this as a concurrent Maker edit sends the operator to re-download over an unrelated cause');
});

test('a LEFT_DEACTIVATED that WRAPS the preview failure still halts — broad matching must not swallow it', async () => {
  // This is the shape the exclusion actually defends, and it exists BECAUSE the predicate matches on
  // the whole cause chain rather than the top-level code.
  //
  // The two conditions are causally linked in the SDK: the rule is deactivated, the write fails, and
  // the re-activation fails — so the write failure is the natural `cause` of the LEFT_DEACTIVATED
  // error, and the SDK already embeds its text in the message. If that write failure is the preview
  // gate, a chain walk sees BOTH codes. Taking the first match it recognises would report "this
  // environment cannot host business rules" for a rule that is sitting DISABLED on a server that
  // plainly can — the operator is told to stop worrying about the exact thing they must go fix.
  const { sdk } = require('./helpers/mock-sdk.js').makeSimpleMockSdk();
  const preview = Object.assign(new Error("does not expose 'Microsoft.Dynamics.CRM.CreateProcessWithWfomJson'"), { code: 'BUSINESS_RULE_API_UNAVAILABLE' });
  const { provision } = byValuePushFailure('BUSINESS_RULE_LEFT_DEACTIVATED',
    "The business-rule write failed AND the rule could not be re-activated, so 'br-9' is left DEACTIVATED (Draft) on the server.");
  const inner = provision.pushArtifact;
  provision.pushArtifact = async (...args) => {
    const res = await inner(...args);
    res.error.cause = preview;   // the linkage the SDK's own message already describes
    return res;
  };

  const events = [];
  const err = await runBuild(ruleOnlySpec(), {
    sdk, provisionSdk: provision, apply: true, phases: ['business-rules'], warn: () => {}, emit: (e) => events.push(e),
  }).then(() => null, (e) => e);

  assert.ok(err, 'the deactivated rule outranks the preview code anywhere else in the chain');
  assert.match(err.message, /DEACTIVATED/);
  const skip = events.find((e) => e.phase === 'business-rules' && e.status === 'skip');
  assert.strictEqual(skip, undefined,
    `this must not be recorded as a skip; got ${JSON.stringify(skip && skip.label)}`);
});

// --- the operator table, and why it must mirror the SDK exactly ---------------------------------

test('REAL BUNDLE: every spec operator EXISTS in the SDK table, and none silently becomes Equals', () => {
  // The sharp edge. The serializer resolves an operator with
  //   `Uf[operator] ?? WorkflowConditionOperator.Equal`
  // so an operator the SDK does not know is not rejected — it becomes EQUALS. A spec written with
  // `GreaterThan` (which is NOT the table's spelling; it is `IsGreaterThan`) would deploy, activate,
  // and quietly test equality instead.
  //
  // Pinned against the bundle's own table so a re-vendor that renames or drops an operator fails
  // here rather than in production.
  const bundle = fs.readFileSync(BUNDLE, 'utf8');
  const m = bundle.match(/\b[A-Za-z_$][\w$]*=\{Equals:[^}]*\}/);
  assert.ok(m, 'the operator table must be present in the vendored bundle');
  const sdkOperators = [...m[0].matchAll(/(\w+):z\.WorkflowConditionOperator\./g)].map((x) => x[1]);
  assert.ok(sdkOperators.length >= 16, `expected the full table, got ${sdkOperators.length}: ${sdkOperators}`);

  const { BUSINESS_RULE_OPERATORS } = require('../lib/app-spec.js');
  const notInSdk = BUSINESS_RULE_OPERATORS.filter((o) => !sdkOperators.includes(o));
  assert.deepStrictEqual(notInSdk, [],
    `these spec operators are NOT in the SDK table, so they would silently deploy as Equals: ${notInSdk}`);

  // And the reverse, so an operator the SDK gains is noticed rather than quietly unavailable.
  const notInSpec = sdkOperators.filter((o) => !BUSINESS_RULE_OPERATORS.includes(o));
  assert.deepStrictEqual(notInSpec, [],
    `the SDK supports these operators the spec does not expose: ${notInSpec}`);
});

test('a near-miss operator spelling is rejected AND corrected', () => {
  // `GreaterThan` is the natural thing to write and is the exact input that would deploy as Equals.
  const errs = errorsFor([{ ...RULE, conditions: [{ field: 'new_status', operator: 'GreaterThan', value: '1' }] }]);
  assert.ok(errs.some((e) => /GreaterThan/.test(e)), `expected rejection: ${JSON.stringify(errs)}`);
  assert.ok(errs.some((e) => /did you mean 'IsGreaterThan'/.test(e)),
    `the message must name the legal spelling; got ${JSON.stringify(errs)}`);
});

test('the newly-unlocked operators all validate', () => {
  // These were blocked only because the deleted XAML compiler could not express them.
  for (const operator of ['IsGreaterThan', 'IsLessThanEqualTo', 'Contains', 'BeginsWith', 'DoesNotEndWith', 'On']) {
    const errs = errorsFor([{ ...RULE, conditions: [{ field: 'new_status', operator, value: '1' }] }]);
    assert.deepStrictEqual(errs, [], `${operator} must validate: ${JSON.stringify(errs)}`);
  }
});

// --- multi-clause AND ---------------------------------------------------------------------------

test('a multi-condition rule now validates', () => {
  // Previously rejected with "only ONE condition is supported", which was never a platform limit —
  // the deleted XAML compiler read `clauses[0]` and ignored the rest.
  const errs = errorsFor([{
    ...RULE,
    conditions: [
      { field: 'new_status', operator: 'Equals', value: '1' },
      { field: 'new_owner', operator: 'ContainsData' },
    ],
  }]);
  assert.deepStrictEqual(errs, [], JSON.stringify(errs));
});

test('REAL BUNDLE: BOTH conditions of a multi-clause rule reach the wire, joined by LogicalAnd', async () => {
  // The failure that matters is silent: a serializer that kept only the first clause would deploy a
  // rule that fires under half the intended circumstances, and every structural check would pass.
  //
  // WorkflowConditionOperator.LogicalAnd is "2" in the bundle's own enum.
  const { createMakerSdk } = require(BUNDLE);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'br-multi-'));
  dirs.push(dir);
  const calls = [];
  const sdk = createMakerSdk({
    workspacePath: dir, instanceUrl: 'https://contoso.crm.dynamics.com',
    httpClient: {
      get: async () => ({ status: 200, headers: {}, body: { value: [] } }),
      post: async (url, body) => { calls.push({ url, body }); return { status: 204, headers: { 'odata-entityid': 'https://x/workflows(55555555-5555-5555-5555-555555555555)' }, body: {} }; },
      patch: async () => ({ status: 204, headers: {}, body: {} }),
      put: async () => ({ status: 204, headers: {}, body: {} }),
      delete: async () => ({ status: 204, headers: {}, body: {} }),
    },
  });
  sdk.initWorkspace();

  const def = businessRuleDef({
    ...RULE,
    conditions: [
      { field: 'new_status', operator: 'Equals', value: '1' },
      { field: 'new_owner', operator: 'ContainsData' },
    ],
  });
  assert.strictEqual(def.rootCondition.clauses.length, 2, 'the mapper must carry both clauses');

  const art = sdk.createArtifact('businessRule', def);
  await sdk.updateElement('businessRule', art.id, '/rootCondition', def.rootCondition);
  await sdk.pushArtifact('businessRule', art.id);

  const bound = calls.find((c) => /CreateProcessWithWfomJson/i.test(String(c.url)));
  const expr = JSON.parse(bound.body.WfomJson).steps.list[0].steps.list[0].conditionExpression;
  assert.strictEqual(expr.conditionOperatoroperator, '2', 'two clauses must be folded with LogicalAnd');

  // Both operands, and both authored columns, must survive the fold.
  const flat = JSON.stringify(expr);
  assert.match(flat, /new_status/, 'the FIRST condition column must reach the wire');
  assert.match(flat, /new_owner/, 'the SECOND condition column must reach the wire — dropping it is the silent failure');
});

// --- verify must not punish an environment that cannot host business rules -----------------------
//
// Found in review, and the point is not tidiness. `verify.ok` gates THREE things: the process exit
// code, whether `.last-applied.json` is written, and whether the `--changed-only` snapshot is
// persisted. A spec with implemented pages makes verify MANDATORY. So on the 18-of-20 environments
// that cannot host business rules, a permanently-false `ok` would permanently withhold the
// changed-only baseline and force a full build on every subsequent run, forever — while the build
// itself reported success. Those gates are built for TRANSIENT failures; this one never clears.

test('verify SKIPS a rule the build reported as unsupported on this environment', async () => {
  const r = await verifySpec(ruleSpec(), baseReader([]), {
    environmentSkipped: { businessRules: ['new_ticket|Lock when closed'] },
  });
  // Asserted on the business-rule outcome specifically rather than on `r.ok`: this fixture's reader
  // also reports an unrelated missing subarea, so `ok` would be false either way and an `ok` check
  // would pass for the wrong reason.
  assert.strictEqual(ruleCheck(r), undefined,
    'the rule must not be counted as a check at all — passing it would claim it exists');
  assert.strictEqual(r.missing.some((m) => m.kind === 'business-rule'), false,
    'and it must not count toward `missing`, which is what drives verify.ok');
  assert.deepStrictEqual(r.environmentSkipped, ['business-rule:new_ticket.Lock when closed'],
    'it is REPORTED, so a green verify never silently means "everything the spec asked for is deployed"');
});

test('verify still FAILS a missing rule when the build did NOT skip it', async () => {
  // The dangerous over-correction: treating every absent rule as environment-gated would turn a real
  // deployment failure into a pass.
  const r = await verifySpec(ruleSpec(), baseReader([]), { environmentSkipped: { businessRules: [] } });
  assert.strictEqual(ruleCheck(r).present, false);
  assert.ok(r.missing.some((m) => m.kind === 'business-rule'));
  assert.strictEqual(r.environmentSkipped, undefined, 'absent when nothing was skipped, so existing callers are unaffected');
});

test('verify run STANDALONE (no build result) checks every rule', async () => {
  // `verify-model-app.js` has no build result to consult. Absent one, "not deployed" is the honest
  // verdict — the alternative would be a verify that quietly stops checking business rules.
  const r = await verifySpec(ruleSpec(), baseReader([]));
  assert.strictEqual(ruleCheck(r).present, false);
  assert.ok(r.missing.some((m) => m.kind === 'business-rule'));
});

test('the skip key matches the shape the BUILD records', async () => {
  // The two sides must agree on `entity|name` or the wiring is silently inert: verify would keep
  // failing and nobody would notice the option is being ignored.
  const { sdk } = require('./helpers/mock-sdk.js').makeSimpleMockSdk();
  const { provision } = provisionThatCannotAuthorRules();
  const built = await runBuild(ruleOnlySpec(), {
    sdk, provisionSdk: provision, apply: true, phases: ['business-rules'], warn: () => {},
  });
  const r = await verifySpec(ruleSpec(), baseReader([]), { environmentSkipped: built.skipped });
  assert.strictEqual(ruleCheck(r), undefined,
    `the build recorded ${JSON.stringify(built.skipped.businessRules)}, which verify must recognise`);
});

test('a PHASE-LIMITED verify does not demand a rule whose phase never ran', async () => {
  // The `--changed-only` FAST path applies `phases: ['pages']`. The business-rules loop is gated on
  // `has('business-rules')`, so it never executes and `skipped.businessRules` comes back EMPTY —
  // which made the skip list useless on exactly the runs that need it most.
  //
  // The consequence was not "verify is noisy". A fast apply is only chosen when every change is a
  // page, which requires implemented .tsx pages, which makes verify MANDATORY. So on a gated
  // environment every fast apply failed verify, refused to re-bless the snapshot, and exited
  // non-zero — an alternating full / failing-fast cycle forever, with the log line blaming PAGES for
  // a business-rule gate. The page upload itself had succeeded.
  const r = await verifySpec(ruleSpec(), baseReader([]), { phases: ['pages'] });
  assert.strictEqual(ruleCheck(r), undefined, 'a phase that did not run must not be demanded');
  assert.strictEqual(r.missing.some((m) => m.kind === 'business-rule'), false);
  assert.deepStrictEqual(r.phaseSkipped, ['business-rule:new_ticket.Lock when closed'],
    'still reported, so it is visible rather than silently dropped');
});

test('the two skip REASONS are reported separately — they warrant opposite messages', async () => {
  // Merging them was wrong in a way the live run could not surface, because it happened to read
  // correctly on a gated environment. On a HEALTHY one, every `--changed-only` fast apply runs
  // `phases: ['pages']`, so every business rule would be reported as "not applicable on this
  // environment" — telling an operator whose environment works perfectly well that it does not.
  // Wrong 100% of the time on the normal fast-apply path.
  const gated = await verifySpec(ruleSpec(), baseReader([]), {
    environmentSkipped: { businessRules: ['new_ticket|Lock when closed'] },
  });
  assert.deepStrictEqual(gated.environmentSkipped, ['business-rule:new_ticket.Lock when closed']);
  assert.strictEqual(gated.phaseSkipped, undefined, 'a gated environment is NOT a phase that did not run');

  const phased = await verifySpec(ruleSpec(), baseReader([]), { phases: ['pages'] });
  assert.deepStrictEqual(phased.phaseSkipped, ['business-rule:new_ticket.Lock when closed']);
  assert.strictEqual(phased.environmentSkipped, undefined, 'a skipped phase says NOTHING about the environment');
});

test('a FULL-phase verify still demands the rule', async () => {
  // The over-correction to avoid: treating every phase list as permission to stop checking. A full
  // build lists every phase, so nothing is relaxed there.
  const { PHASES } = require('../lib/stages.js');
  const r = await verifySpec(ruleSpec(), baseReader([]), { phases: PHASES });
  assert.strictEqual(ruleCheck(r).present, false);
  assert.ok(r.missing.some((m) => m.kind === 'business-rule'));
});

test('verify with NO phases supplied checks everything — standalone must not be relaxed', async () => {
  const r = await verifySpec(ruleSpec(), baseReader([]));
  assert.strictEqual(ruleCheck(r).present, false);
});

test('a phase list that INCLUDES business-rules still demands the rule', async () => {
  // The gate is "did this phase run", not "was a phase list supplied".
  const r = await verifySpec(ruleSpec(), baseReader([]), { phases: ['business-rules'] });
  assert.strictEqual(ruleCheck(r).present, false);
  assert.ok(r.missing.some((m) => m.kind === 'business-rule'));
});
