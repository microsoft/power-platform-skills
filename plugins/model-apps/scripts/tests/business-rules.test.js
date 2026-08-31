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

test('presence operators are rejected — they compile to XAML the platform 500s on', () => {
  // LIVE-MEASURED: `ContainsData` / `DoesNotContainData` answer "Error generating UiData" (HTTP 500)
  // on every column type and in both directions, while Equals/DoesNotEqual succeed in the same run.
  // The error must name the platform failure, not pretend the operator is unrecognised — an author
  // reaching for ContainsData has written something reasonable that we simply cannot deploy.
  for (const operator of ['ContainsData', 'DoesNotContainData']) {
    const errs = errorsFor([{ ...RULE, conditions: [{ field: 'new_notes', operator }] }]);
    assert.ok(errs.some((e) => /is not usable/.test(e) && /Error generating UiData/.test(e) && /issues\/481/.test(e)),
      `${operator} must be rejected with the platform reason: ${JSON.stringify(errs)}`);
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

// --- peer-review findings: verified and fixed ---------------------------------------------------

test('dataType mirrors the compiler literal-type map exactly (no DateTime)', () => {
  // The bundle's literal table is the authority. `DateTime` used to be accepted here and does NOT
  // exist there, so such a spec validated and then threw from INSIDE the push — the worst place,
  // because the bound member may already have committed a workflow row (#482), leaving an orphan
  // behind a "failed" build.
  const bundle = require('node:fs').readFileSync(BUNDLE, 'utf8');
  const i = bundle.indexOf('Picklist:{propertyType:"OptionSetValue"');
  assert.ok(i > 0, 'the literal-type map must be present in the vendored bundle');
  const seg = bundle.slice(i, i + 1200);
  const sdkTypes = [...seg.matchAll(/(\w+):\{propertyType/g)].map((m) => m[1]);
  assert.ok(!sdkTypes.includes('DateTime'), 'guard assumes the compiler has no DateTime literal');
  const { BUSINESS_RULE_DATA_TYPES } = require('../lib/app-spec.js');
  assert.deepStrictEqual([...BUSINESS_RULE_DATA_TYPES].sort(), [...sdkTypes].sort());
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

test('every business-rule query in build, verify and teardown filters on type', () => {
  // A guard on the SOURCE, because the three call sites are in different modules and it is the
  // omission — not a wrong value — that caused the defect. Any new query that forgets the shared
  // helper fails here.
  const fs = require('node:fs');
  const path = require('node:path');
  for (const file of ['sdk-build.js', 'verify-spec.js', 'sdk-teardown.js']) {
    const src = fs.readFileSync(path.resolve(__dirname, '..', 'lib', file), 'utf8');
    const raw = src.match(/category eq 2(?! and type eq 1)/g) || [];
    // The only permitted mention of `category eq 2` without `type eq 1` is inside businessRuleFilter
    // itself, which immediately follows it with the type clause — hence the negative lookahead above
    // matching nothing.
    assert.deepStrictEqual(raw, [], `${file} has a business-rule query that does not constrain type: ${raw.join(' | ')}`);
  }
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
