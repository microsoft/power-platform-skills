'use strict';
// `businessProcessFlows[]` — the App Spec surface over the SDK's BPF authoring.
//
// Layered the same way as business-rules.test.js, because each layer fails silently in its own way:
//   1. VALIDATION — the spec surface mirrors the slice the build can actually deploy AND verify.
//      A step bound to a column that does not exist is accepted by the platform and simply renders
//      bound to nothing, so nothing downstream would catch it.
//   2. MAPPING   — `bpfDef` produces the SDK's artifact shape. This is the dangerous layer: the
//      adapter's step normalizer copies exactly id/name/fieldName/required and DROPS every other
//      key, so the plausible spelling (`fieldLogicalName`) is silently discarded and the step
//      deploys bound to nothing.
//   3. REAL BUNDLE — the mapped def is pushed through the shipped SDK and the wire payload is
//      inspected. Only this proves the authored stages and columns reach the platform.
//   4. BUILD / TEARDOWN / VERIFY — the phase is additive-idempotent, the teardown is ordered and
//      scoped, and verify reconciles existence + cardinality + state.
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const { validateAppSpec } = require('../lib/app-spec.js');
const { bpfDef, bpfFilter, runSdkBuild, planFor, PHASES } = require('../lib/sdk-build.js');
const { verifySpec } = require('../lib/verify-spec.js');
const { planTeardown, KIND_HANDLERS } = require('../lib/sdk-teardown.js');
const { PHASES: STAGE_PHASES, STAGES } = require('../lib/stages.js');

const BUNDLE = path.resolve(__dirname, '..', 'vendor', 'cds-maker-sdk.cjs');
const dirs = [];
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

// Minimal spec that is valid on its own, so a validation failure below is always about the flow.
function specWith(flows) {
  return {
    solution: { uniqueName: 'BPF', displayName: 'BPF', publisherPrefix: 'new' },
    app: { name: 'BPF App', description: '' },
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
    businessProcessFlows: flows,
  };
}

const FLOW = {
  name: 'Ticket Handling',
  entity: 'new_ticket',
  stages: [
    { name: 'Triage', steps: [{ name: 'Subject', field: 'new_subject', required: true }] },
    { name: 'Resolve', steps: [{ name: 'Notes', field: 'new_notes' }, { name: 'Confirm with customer' }] },
  ],
};
const errorsFor = (flows) => (validateAppSpec(specWith(flows), { profile: 'plan' }).errors || []);

// --- 1. validation ------------------------------------------------------------------------------

test('a well-formed business process flow validates', () => {
  const v = validateAppSpec(specWith([FLOW]), { profile: 'plan' });
  assert.strictEqual(v.ok, true, JSON.stringify(v.errors));
});

test('a flow must name a known entity, and its steps must name that entity\'s own columns', () => {
  assert.ok(errorsFor([{ ...FLOW, entity: 'new_nope' }]).some((e) => /unknown entity/.test(e)));
  // The silent case: the platform materializes the stage and renders a step bound to nothing.
  const bad = errorsFor([{ ...FLOW, stages: [{ name: 'Triage', steps: [{ name: 'Ghost', field: 'new_ghost' }] }] }]);
  assert.ok(bad.some((e) => /'new_ghost', which is not a column on new_ticket/.test(e)), JSON.stringify(bad));
});

test('a lookup created by a relationship counts as a column of the referencing table', () => {
  // Same rule the business-rule validator applies — a lookup IS a real column, just declared under
  // relationships[]. Sharing one helper is what keeps the two from disagreeing.
  const spec = specWith([{ ...FLOW, stages: [{ name: 'Triage', steps: [{ name: 'Acct', field: 'new_accountid' }] }] }]);
  spec.entities.push({
    schemaName: 'new_account', displayName: 'Account', pluralName: 'Accounts',
    primaryAttribute: { schemaName: 'new_name', displayName: 'Name' }, columns: [],
  });
  spec.relationships = [{ type: 'OneToMany', referenced: 'new_account', referencing: 'new_ticket', lookup: { schemaName: 'new_accountid', displayName: 'Account' } }];
  const v = validateAppSpec(spec, { profile: 'plan' });
  assert.strictEqual(v.ok, true, JSON.stringify(v.errors));
});

test('a flow needs stages, stages need names and at least one step, and names must be unique', () => {
  assert.ok(errorsFor([{ ...FLOW, stages: [] }]).some((e) => /stages\[\] is required/.test(e)));
  assert.ok(errorsFor([{ ...FLOW, stages: [{ steps: [{ name: 'S' }] }] }]).some((e) => /every stage needs a name/.test(e)));
  assert.ok(errorsFor([{ ...FLOW, stages: [{ name: 'A', steps: [{ name: 'S' }] }, { name: 'A', steps: [{ name: 'T' }] }] }])
    .some((e) => /duplicate stage name 'A'/.test(e)));
  assert.ok(errorsFor([{ ...FLOW, stages: [{ name: 'A', steps: [{ name: 'S', field: 'new_notes' }, { name: 'S', field: 'new_owner' }] }] }])
    .some((e) => /duplicate step name 'S'/.test(e)));
});

test('a stage with no steps is rejected — the SDK would substitute a phantom "New Step"', () => {
  // createDefault injects a placeholder step when a stage has none, so an empty stage deploys a step
  // the author never wrote — and the SDK's own stage-needs-step rule never fires, because the
  // placeholder is injected before it looks.
  for (const stages of [[{ name: 'Only', steps: [] }], [{ name: 'Only' }]]) {
    assert.ok(errorsFor([{ ...FLOW, stages }]).some((e) => /has no steps/.test(e) && /New Step/.test(e)), JSON.stringify(stages));
  }
});

test('two flows whose names derive the same Dataverse unique name are rejected', () => {
  // The SDK derives `uniquename` as new_<name lower-cased, non-alphanumerics stripped> — it IGNORES
  // the table. Activation then creates a backing TABLE with that name, so the second flow cannot
  // deploy at all. An (entity, name) key would let all three of these through.
  assert.ok(errorsFor([FLOW, { ...FLOW }]).some((e) => /derive the Dataverse unique name 'new_tickethandling'/.test(e)));
  // Same name, DIFFERENT table — still a collision, because the derivation ignores the entity.
  const spec = specWith([FLOW, { ...FLOW, entity: 'new_other' }]);
  spec.entities.push({
    schemaName: 'new_other', displayName: 'Other', pluralName: 'Others',
    primaryAttribute: { schemaName: 'new_othername', displayName: 'Name' }, columns: [],
  });
  spec.businessProcessFlows[1].stages = [{ name: 'Triage', steps: [{ name: 'Name', field: 'new_othername' }] }];
  const errs = validateAppSpec(spec, { profile: 'plan' }).errors || [];
  assert.ok(errs.some((e) => /derive the Dataverse unique name/.test(e)), JSON.stringify(errs));
  // Case and punctuation are stripped, so these collide too.
  assert.ok(errorsFor([FLOW, { ...FLOW, name: 'ticket-handling' }]).some((e) => /derive the Dataverse unique name/.test(e)));
  // Renaming clears it — the message suggests exactly this shape.
  spec.businessProcessFlows[1].name = 'Ticket Handling (Cases)';
  assert.strictEqual(validateAppSpec(spec, { profile: 'plan' }).ok, true, JSON.stringify(validateAppSpec(spec, { profile: 'plan' }).errors));
});

test('bpfUniqueName mirrors the SDK derivation exactly', () => {
  const { bpfUniqueName } = require('../lib/app-spec.js');
  assert.strictEqual(bpfUniqueName('Ticket Handling'), 'new_tickethandling');
  assert.strictEqual(bpfUniqueName('ticket-handling'), 'new_tickethandling');
  assert.strictEqual(bpfUniqueName('Ticket   Handling!'), 'new_tickethandling');
  // The SDK falls back to a literal when the name normalizes to nothing, so two such flows collide.
  assert.strictEqual(bpfUniqueName('!!!'), 'new_businessprocessflow');
  assert.strictEqual(bpfUniqueName(''), 'new_businessprocessflow');
});

test('REAL BUNDLE: the derived uniquename really does ignore the table and the punctuation', async () => {
  // bpfUniqueName is a MIRROR of SDK behaviour, so it has to be checked against the bundle — a mirror
  // that drifts would silently stop catching the collision it exists to catch.
  const { bpfUniqueName } = require('../lib/app-spec.js');
  for (const [name, entity] of [['Ticket Handling', 'new_ticket'], ['ticket-handling', 'new_case'], ['!!!', 'new_ticket']]) {
    const { sdk, writes } = realSdk();
    const art = sdk.createArtifact('bpf', bpfDef({ name, entity, status: 'Draft', stages: [{ name: 'S', steps: [{ name: 'P' }] }] }));
    await sdk.pushArtifact('bpf', art.id);
    const post = writes.find((w) => w.verb === 'POST' && /\/workflows$/.test(w.url));
    assert.strictEqual(post.body.uniquename, bpfUniqueName(name), `${name} on ${entity}`);
  }
});

test('a required step that binds no field is rejected — the stage could never be completed', () => {
  assert.ok(errorsFor([{ ...FLOW, stages: [{ name: 'A', steps: [{ name: 'Nothing', required: true }] }] }])
    .some((e) => /required but binds no field/.test(e)));
  // But an UNBOUND step is legitimate: a checklist item the user ticks.
  assert.deepStrictEqual(errorsFor([{ ...FLOW, stages: [{ name: 'A', steps: [{ name: 'Call the customer' }] }] }]), []);
});

test('status and order are constrained', () => {
  assert.ok(errorsFor([{ ...FLOW, status: 'Published' }]).some((e) => /status must be Active\|Draft/.test(e)));
  assert.ok(errorsFor([{ ...FLOW, order: 0 }]).some((e) => /order must be a positive integer/.test(e)));
  assert.ok(errorsFor([{ ...FLOW, order: 1.5 }]).some((e) => /order must be a positive integer/.test(e)));
  assert.deepStrictEqual(errorsFor([{ ...FLOW, status: 'Draft', order: 3 }]), []);
});

test('a cross-entity stage is rejected rather than silently retargeted', () => {
  // The SDK models a per-stage entity, so this would deploy as a DIFFERENT process (one spanning
  // records) instead of failing — the author would not find out from the build.
  assert.ok(errorsFor([{ ...FLOW, stages: [{ name: 'A', entity: 'new_other', steps: [{ name: 'S' }] }] }])
    .some((e) => /cross-entity flows are not supported/.test(e)));
  // Restating the flow's own entity is harmless.
  assert.deepStrictEqual(errorsFor([{ ...FLOW, stages: [{ name: 'A', entity: 'new_ticket', steps: [{ name: 'S', field: 'new_notes' }] }] }]), []);
});

test('a knob the build cannot verify is REJECTED, not ignored — at flow, stage AND step level', () => {
  // Silently dropping a key the author wrote is how a spec "deploys" something it does not: they
  // would see the stages appear and reasonably assume the rest applied.
  for (const key of ['securityRoles', 'branch', 'actions', 'globalActions']) {
    const errs = errorsFor([{ ...FLOW, [key]: key === 'securityRoles' ? ['Salesperson'] : [{}] }]);
    assert.ok(errs.some((e) => new RegExp(`unsupported key '${key}'`).test(e)), `${key}: ${JSON.stringify(errs)}`);
  }
  // STAGE level is where an author would naturally write branching/actions — the SDK models them
  // there, and bpfDef maps only name/entity/steps, so an unguarded key vanishes without a word.
  for (const key of ['branch', 'actions', 'nextStageId', 'category', 'relationshipName']) {
    const errs = errorsFor([{ ...FLOW, stages: [{ name: 'A', [key]: key === 'category' ? 3 : [{}], steps: [{ name: 'S' }] }] }]);
    assert.ok(errs.some((e) => new RegExp(`stage 'A' has unsupported key '${key}'`).test(e)), `stage.${key}: ${JSON.stringify(errs)}`);
  }
  // STEP level: `fieldLogicalName` is the plausible spelling (it is what the SDK calls the key on
  // other artifacts), and the step normalizer drops it — deploying a step bound to nothing.
  const stepErrs = errorsFor([{ ...FLOW, stages: [{ name: 'A', steps: [{ name: 'S', fieldLogicalName: 'new_notes' }] }] }]);
  assert.ok(stepErrs.some((e) => /step 'S' has unsupported key 'fieldLogicalName'/.test(e)), JSON.stringify(stepErrs));
  assert.ok(stepErrs.some((e) => /the column key is 'field'/.test(e)), 'the message must name the right key');
});

// --- 2. mapping ---------------------------------------------------------------------------------

test('bpfDef maps onto the SDK artifact shape — and uses `fieldName`, not `fieldLogicalName`', () => {
  const def = bpfDef({ ...FLOW, description: 'How tickets are handled', order: 7 });
  assert.strictEqual(def.name, 'Ticket Handling');
  assert.strictEqual(def.entityLogicalName, 'new_ticket');
  assert.strictEqual(def.status, 'Active', 'a flow is invisible until activated, so Active is the default');
  assert.strictEqual(def.description, 'How tickets are handled');
  assert.strictEqual(def.order, 7);

  // THE trap this test exists for. The adapter's step normalizer copies id/name/fieldName/required
  // and drops everything else, so `fieldLogicalName` would vanish without any error and the step
  // would deploy bound to nothing.
  assert.deepStrictEqual(def.stages, [
    { name: 'Triage', entityLogicalName: 'new_ticket', steps: [{ name: 'Subject', fieldName: 'new_subject', required: true }] },
    { name: 'Resolve', entityLogicalName: 'new_ticket', steps: [{ name: 'Notes', fieldName: 'new_notes' }, { name: 'Confirm with customer' }] },
  ]);
});

test('bpfDef omits absent optionals rather than emitting undefined', () => {
  // `{ required: undefined }` is not the same as no key: the adapter checks `!== undefined`.
  const def = bpfDef(FLOW);
  assert.ok(!('description' in def), 'no description key when none was authored');
  assert.ok(!('order' in def), 'no order key when none was authored');
  assert.deepStrictEqual(Object.keys(def.stages[1].steps[1]), ['name'], 'an unbound step carries only its name');
});

test('bpfDef lower-cases the entity everywhere it appears', () => {
  const def = bpfDef({ ...FLOW, entity: 'New_Ticket', stages: [{ name: 'A', steps: [{ name: 'S', field: 'New_Notes' }] }] });
  assert.strictEqual(def.entityLogicalName, 'new_ticket');
  assert.strictEqual(def.stages[0].entityLogicalName, 'new_ticket');
  assert.strictEqual(def.stages[0].steps[0].fieldName, 'new_notes');
});

test('bpfFilter selects the BPF definition only — not the activated copy, not a task flow', () => {
  const f = bpfFilter('Ticket Handling', 'new_ticket');
  assert.match(f, /category eq 4/, 'category 4 = BusinessProcessFlow');
  assert.match(f, /type eq 1/, 'definition rows only; the platform owns the type-2 activated copy');
  assert.match(f, /businessprocesstype eq 0/, 'BusinessFlow only — a task flow is also category 4');
  assert.match(f, /name eq 'Ticket Handling'/);
  assert.match(f, /primaryentity eq 'new_ticket'/);
  // Scoping to the entity as well as the name is what stops a same-named flow on another table
  // being adopted as this one.
  assert.strictEqual(bpfFilter("O'Brien", 'NEW_Ticket').includes("name eq 'O''Brien'"), true, 'OData literals are escaped');
  assert.match(bpfFilter('x', 'NEW_Ticket'), /primaryentity eq 'new_ticket'/, 'the entity is lower-cased');
});

test('every BPF query in build, verify and teardown goes through bpfFilter', () => {
  // The business-rule equivalent of this test exists because an unfiltered query made teardown fail
  // on every activated rule. Enforce the same discipline here by construction rather than by review.
  for (const file of ['sdk-build.js', 'verify-spec.js', 'sdk-teardown.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', file), 'utf8');
    const category4 = [...src.matchAll(/category eq 4/g)].length;
    const inFilter = [...src.matchAll(/bpfFilter\(/g)].length;
    if (file === 'sdk-build.js') {
      assert.strictEqual(category4, 1, 'sdk-build.js defines the filter exactly once');
    } else {
      assert.strictEqual(category4, 0, `${file} must not hand-roll a category-4 filter`);
      assert.ok(inFilter > 0, `${file} must use bpfFilter`);
    }
  }
});

// --- 3. real bundle -----------------------------------------------------------------------------

function realSdk() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bpf-'));
  dirs.push(dir);
  const writes = [];
  const { createMakerSdk } = require(BUNDLE);
  const sdk = createMakerSdk({
    workspacePath: dir, instanceUrl: 'https://contoso.crm.dynamics.com',
    httpClient: {
      get: async () => ({ status: 200, headers: {}, body: { value: [] } }),
      post: async (url, body) => { writes.push({ verb: 'POST', url: String(url), body }); return { status: 200, headers: {}, body: { workflowid: '44444444-4444-4444-4444-444444444444' } }; },
      patch: async (url, body) => { writes.push({ verb: 'PATCH', url: String(url), body }); return { status: 204, headers: {}, body: {} }; },
      put: async () => ({ status: 204, headers: {}, body: {} }),
      delete: async () => ({ status: 204, headers: {}, body: {} }),
    },
  });
  sdk.initWorkspace();
  return { sdk, writes };
}

test('REAL BUNDLE: a BPF is authored through the generic artifact lifecycle', async () => {
  // There is no dedicated BPF method on the SDK surface — it is createArtifact -> pushArtifact, and
  // the whole stage/step tree rides on the create payload (unlike a business rule's condition tree,
  // which needs an updateElement). Pinning that tells a future implementer which surface to build on.
  const { sdk } = realSdk();
  const art = sdk.createArtifact('bpf', bpfDef(FLOW));
  assert.ok(art && art.id, 'createArtifact returns an artifact with an id');
  assert.deepStrictEqual(Object.keys(art).sort(), ['entityLogicalName', 'id', 'name', 'stages', 'status']);
  // The adapter stamps ids on stages and steps; the plugin deliberately does not mint them.
  assert.strictEqual(art.stages.length, 2);
  assert.ok(art.stages.every((s) => s.id), 'every stage is id-stamped by the adapter');
  assert.ok(art.stages.every((s) => (s.steps || []).every((p) => p.id)), 'every step is id-stamped by the adapter');
  const pushed = await sdk.pushArtifact('bpf', art.id);
  assert.strictEqual(pushed.saved, true, 'the push commits');
});

test('REAL BUNDLE: the wire payload is a category-4 BusinessFlow definition carrying the stages', async () => {
  const { sdk, writes } = realSdk();
  const art = sdk.createArtifact('bpf', bpfDef({ ...FLOW, status: 'Draft', description: 'd' }));
  await sdk.pushArtifact('bpf', art.id);

  const post = writes.find((w) => w.verb === 'POST' && /\/workflows$/.test(w.url));
  assert.ok(post, `a workflows create must be issued; got ${JSON.stringify(writes.map((w) => w.verb + ' ' + w.url))}`);
  // The discriminating columns. A flow written with the wrong category/businessprocesstype is not a
  // BPF at all — and would then be invisible to every query in build, verify and teardown.
  assert.strictEqual(post.body.category, 4, 'category 4 = BusinessProcessFlow');
  assert.strictEqual(post.body.type, 1, 'type 1 = definition');
  assert.strictEqual(post.body.businessprocesstype, 0, 'businessprocesstype 0 = BusinessFlow (not a task flow)');
  assert.strictEqual(post.body.scope, 4, 'scope 4 = Organization');
  assert.strictEqual(post.body.primaryentity, 'new_ticket');
  assert.strictEqual(post.body.name, 'Ticket Handling');

  // The authored stages and the bound columns must survive compilation into the XAML — if they did
  // not, the flow would deploy as an empty process and nothing would report it.
  const xaml = post.body.xaml;
  assert.ok(typeof xaml === 'string' && xaml.length > 1000, `expected substantial XAML, got ${xaml && xaml.length}`);
  assert.match(xaml, /StageStep\d+: Triage/);
  assert.match(xaml, /StageStep\d+: Resolve/);
  assert.ok(xaml.includes('new_subject'), 'the bound column reached the compiled process');
  assert.ok(xaml.includes('new_notes'), 'the second bound column reached the compiled process');
});

test('REAL BUNDLE: an Active flow is activated in the same push (statecode 1 / statuscode 2)', async () => {
  // Activation is a SECOND, non-atomic request. It is what makes the process appear on the form, so
  // a re-vendor that stopped issuing it would deploy flows nobody can see.
  const { sdk, writes } = realSdk();
  const art = sdk.createArtifact('bpf', bpfDef({ ...FLOW, status: 'Active' }));
  await sdk.pushArtifact('bpf', art.id);
  const patch = writes.find((w) => w.verb === 'PATCH' && /workflows\(/.test(w.url));
  assert.ok(patch, `an activation PATCH must follow the create; got ${JSON.stringify(writes.map((w) => w.verb + ' ' + w.url))}`);
  assert.deepStrictEqual(patch.body, { statecode: 1, statuscode: 2 });
});

test('REAL BUNDLE: a Draft flow is NOT activated', async () => {
  const { sdk, writes } = realSdk();
  const art = sdk.createArtifact('bpf', bpfDef({ ...FLOW, status: 'Draft' }));
  await sdk.pushArtifact('bpf', art.id);
  assert.strictEqual(writes.some((w) => w.verb === 'PATCH'), false, 'Draft must not be activated');
});

test('REAL BUNDLE: XML carrying character data still parses (the headless text-node regression)', async () => {
  // Every BPF push crashed with `TypeError: Cannot read properties of null (reading 'length')` in the
  // vendored (headless) bundle, and ONLY there: the SDK's grammar walk descended into TEXT nodes, and
  // @xmldom/xmldom exposes a text node's `childNodes` as null where jsdom returns an empty NodeList.
  // The BPF XAML template always contains text (`<mva:VisualBasic.Settings>`, stage/step ids,
  // `False`), so this was input-independent — while the SDK's own jsdom suite stayed green.
  //
  // This asserts the SHIPPED bundle is fixed. A re-vendor that reintroduces it fails here rather
  // than in a user's build.
  const { sdk } = realSdk();
  const art = sdk.createArtifact('bpf', bpfDef(FLOW));
  await assert.doesNotReject(() => sdk.pushArtifact('bpf', art.id));
});

// --- 4. build phase -----------------------------------------------------------------------------

test('the phase is registered in PHASES and in the ui stage', () => {
  assert.ok(PHASES.includes('business-process-flows'));
  assert.deepStrictEqual(STAGE_PHASES, PHASES, 'stages.js is the single source of truth for the engine');
  assert.ok(STAGES.ui.includes('business-process-flows'));
  // Right after business-rules: both are authored against the entity's columns and nothing later.
  assert.strictEqual(PHASES[PHASES.indexOf('business-rules') + 1], 'business-process-flows');
});

test('planFor lists each flow with its stage count', () => {
  const items = planFor(specWith([FLOW]), { phases: ['business-process-flows'] });
  const labels = items.filter((i) => i.phase === 'business-process-flows').map((i) => i.label);
  assert.deepStrictEqual(labels, ['business process flow "Ticket Handling" on new_ticket (2 stages)']);
  // Singular/plural, because a plan is read by a human before they approve it.
  const one = planFor(specWith([{ ...FLOW, stages: [FLOW.stages[0]] }]), { phases: ['business-process-flows'] });
  assert.match(one.find((i) => i.phase === 'business-process-flows').label, /\(1 stage\)$/);
});

// Minimal provision double: only the surface the business-process-flows phase touches.
function provisionWithFlows(rows) {
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
      createArtifact: (kind, def) => { calls.push(['createArtifact', kind, def]); return { id: 'bpf-new' }; },
      updateElement: async () => undefined,
      pushArtifact: async (kind, id) => { calls.push(['pushArtifact', kind, id]); return { id: 'bpf-new', saved: true, publish: { kind: 'notRequested' } }; },
      addSolutionComponent: async (a) => { calls.push(['addSolutionComponent', a]); },
    },
  };
}
const buildFlow = async (rows, opts = {}) => {
  const { sdk } = require('./helpers/mock-sdk.js').makeSimpleMockSdk();
  const { provision, calls } = provisionWithFlows(rows);
  const warnings = [];
  const spec = specWith([{ ...FLOW, ...(opts.status ? { status: opts.status } : {}) }]);
  await runSdkBuild(spec, { sdk, provisionSdk: provision, apply: true, phases: ['business-process-flows'], warn: (m) => warnings.push(m) });
  return { calls, warnings };
};

test('a new flow is created, pushed, and added to the solution as a workflow component', async () => {
  const { calls } = await buildFlow([]);
  const created = calls.find((c) => c[0] === 'createArtifact');
  assert.ok(created, 'the flow is created');
  assert.strictEqual(created[1], 'bpf');
  assert.strictEqual(created[2].entityLogicalName, 'new_ticket');
  assert.ok(calls.some((c) => c[0] === 'pushArtifact' && c[1] === 'bpf'));
  const solComponent = calls.find((c) => c[0] === 'addSolutionComponent');
  assert.ok(solComponent, 'the flow must join the solution or it will not travel on export/import');
  assert.strictEqual(solComponent[1].componentId, 'bpf-new');
  assert.strictEqual(solComponent[1].componentType, 29, 'componentType 29 = workflow');
});

test('an existing flow is REUSED, not duplicated (the rebuild path)', async () => {
  const { calls } = await buildFlow([{ workflowid: 'existing', statecode: 1, createdon: '2026-01-01T00:00:00Z' }]);
  assert.strictEqual(calls.some((c) => c[0] === 'createArtifact'), false, 'a rebuild must not stack a second process on the table');
  assert.strictEqual(calls.some((c) => c[0] === 'updateRecord'), false, 'an already-correct flow is left alone');
});

test('the reuse query is ORDERED and asks for more than one row', async () => {
  // `top: 1` unordered adopts an arbitrary row and hides duplicates entirely — the business-rule bug.
  const { calls } = await buildFlow([{ workflowid: 'only', statecode: 1, createdon: '2026-01-01T00:00:00Z' }]);
  const q = calls.find((c) => c[0] === 'queryRecords');
  assert.ok(q[2].top > 1, `the reuse query must be able to SEE duplicates; top was ${q[2].top}`);
  assert.match(String(q[2].orderBy), /createdon asc/, 'oldest-first makes the surviving row deterministic');
  assert.match(String(q[2].filter), /category eq 4 and type eq 1 and businessprocesstype eq 0/);
});

test('a flow deployed in the WRONG state is converged, in both directions', async () => {
  // "Exists, so skip" would report success over a process nobody can see (Draft), or one still
  // running after the spec asked for Draft.
  const draftOnServer = await buildFlow([{ workflowid: 'w1', statecode: 0, createdon: '2026-01-01T00:00:00Z' }], { status: 'Active' });
  assert.deepStrictEqual(draftOnServer.calls.find((c) => c[0] === 'updateRecord').slice(1), ['workflow', 'w1', { statecode: 1, statuscode: 2 }]);

  const activeOnServer = await buildFlow([{ workflowid: 'w1', statecode: 1, createdon: '2026-01-01T00:00:00Z' }], { status: 'Draft' });
  assert.deepStrictEqual(activeOnServer.calls.find((c) => c[0] === 'updateRecord').slice(1), ['workflow', 'w1', { statecode: 0, statuscode: 1 }]);
});

test('pre-existing duplicates are WARNED about, not silently adopted', async () => {
  const { warnings } = await buildFlow([
    { workflowid: 'oldest', statecode: 1, createdon: '2026-01-01T00:00:00Z' },
    { workflowid: 'dupe', statecode: 1, createdon: '2026-01-01T00:00:05Z' },
  ]);
  assert.ok(warnings.some((w) => /2 definitions exist with this name/.test(w)), JSON.stringify(warnings));
});

test('a flow that cannot be activated warns instead of halting the build', async () => {
  // One wedged process must not block an otherwise-good app; `--verify` reports the real state.
  const { sdk } = require('./helpers/mock-sdk.js').makeSimpleMockSdk();
  const { provision } = provisionWithFlows([{ workflowid: 'w1', statecode: 0, createdon: '2026-01-01T00:00:00Z' }]);
  provision.updateRecord = async () => { throw new Error('Invalid operation'); };
  const warnings = [];
  const res = await runSdkBuild(specWith([FLOW]), { sdk, provisionSdk: provision, apply: true, phases: ['business-process-flows'], warn: (m) => warnings.push(m) });
  assert.strictEqual(res.ok, true, 'the build survives');
  assert.ok(warnings.some((w) => /could not be activated/.test(w)), JSON.stringify(warnings));
});

test('a spec with no flows makes no workflow calls at all', async () => {
  const { sdk } = require('./helpers/mock-sdk.js').makeSimpleMockSdk();
  const { provision, calls } = provisionWithFlows([]);
  const spec = specWith([]);
  delete spec.businessProcessFlows;
  await runSdkBuild(spec, { sdk, provisionSdk: provision, apply: true, phases: ['business-process-flows'] });
  assert.strictEqual(calls.length, 0);
});

// --- 5. teardown --------------------------------------------------------------------------------

test('teardown removes each flow BEFORE the table it is bound to', async () => {
  const steps = planTeardown(specWith([FLOW]));
  const kinds = steps.map((s) => s.kind);
  const flowAt = kinds.indexOf('businessProcessFlows');
  assert.ok(flowAt > -1, `a flow step must be planned; got ${JSON.stringify(kinds)}`);
  const tableAt = kinds.indexOf('tables');
  if (tableAt > -1) assert.ok(flowAt < tableAt, 'an activated flow is a workflow row bound to the entity — it cannot be left for the table delete to cascade');
  assert.deepStrictEqual(steps[flowAt].target, { entity: 'new_ticket', name: 'Ticket Handling' });
});

test('teardown resolves a flow through bpfFilter and deactivates before deleting', async () => {
  const handler = KIND_HANDLERS.businessProcessFlows;
  const queries = [];
  const ops = [];
  const sdk = {
    queryRecords: async (e, o) => { queries.push([e, o]); return [{ workflowid: 'w1', statecode: 1 }]; },
    updateRecord: async (e, id, patch) => { ops.push(['update', id, patch]); },
    deleteRecord: async (e, id) => { ops.push(['delete', id]); },
  };
  const items = await handler.resolve(sdk, { entity: 'new_ticket', name: 'Ticket Handling' });
  assert.match(String(queries[0][1].filter), /category eq 4 and type eq 1 and businessprocesstype eq 0/);
  assert.deepStrictEqual(items, [{ id: 'w1', name: 'Ticket Handling', statecode: 1 }]);

  await handler.del(sdk, items[0]);
  // Dataverse refuses to delete an ACTIVATED process, and the error names neither the flow nor why.
  assert.deepStrictEqual(ops, [['update', 'w1', { statecode: 0, statuscode: 1 }], ['delete', 'w1']]);
  assert.strictEqual(handler.tolerateNotFound, true, 'an already-gone flow is "deleted"');
});

test('teardown does not deactivate a flow that is already Draft', async () => {
  const ops = [];
  const sdk = {
    queryRecords: async () => [{ workflowid: 'w1', statecode: 0 }],
    updateRecord: async (e, id) => { ops.push(['update', id]); },
    deleteRecord: async (e, id) => { ops.push(['delete', id]); },
  };
  const handler = KIND_HANDLERS.businessProcessFlows;
  await handler.del(sdk, (await handler.resolve(sdk, { entity: 'new_ticket', name: 'X' }))[0]);
  assert.deepStrictEqual(ops, [['delete', 'w1']]);
});

// --- 6. verify ----------------------------------------------------------------------------------

const flowReader = (workflows) => ({
  findTable: async () => ({ logicalName: 'new_ticket' }),
  findColumns: async () => [{ logicalName: 'new_subject' }, { logicalName: 'new_notes' }, { logicalName: 'new_owner' }, { logicalName: 'new_status' }],
  queryRecords: async (entity) => (entity === 'workflow' ? workflows : []),
  sitemapXml: async () => '',
});
const flowCheck = (r) => r.checks.find((c) => c.kind === 'business-process-flow');
const flowSpec = (status) => specWith([{ ...FLOW, ...(status ? { status } : {}) }]);

test('verify PASSES an Active flow the spec wants Active', async () => {
  const c = flowCheck(await verifySpec(flowSpec(), flowReader([{ workflowid: 'w1', statecode: 1 }])));
  assert.strictEqual(c.present, true);
});

test('verify FAILS a flow that never deployed', async () => {
  const c = flowCheck(await verifySpec(flowSpec(), flowReader([])));
  assert.strictEqual(c.present, false);
  assert.match(c.detail, /not deployed/);
});

test('verify FAILS a flow deployed as Draft — "exists" is not "appears on the form"', async () => {
  const c = flowCheck(await verifySpec(flowSpec(), flowReader([{ workflowid: 'w1', statecode: 0 }])));
  assert.strictEqual(c.present, false);
  assert.match(c.detail, /DRAFT/);
});

test('verify FAILS duplicates — users would be offered the same process twice', async () => {
  const c = flowCheck(await verifySpec(flowSpec(), flowReader([{ workflowid: 'w1', statecode: 1 }, { workflowid: 'w2', statecode: 1 }])));
  assert.strictEqual(c.present, false);
  assert.match(c.detail, /2 process flows share this name/);
});

test('verify FAILS an ACTIVE flow the spec asks to be Draft', async () => {
  const c = flowCheck(await verifySpec(flowSpec('Draft'), flowReader([{ workflowid: 'w1', statecode: 1 }])));
  assert.strictEqual(c.present, false);
  assert.match(c.detail, /running/);
});

test('verify fails CLOSED when the workflow read itself errors', async () => {
  // "Could not look" must never read as "present and correct".
  const read = Object.assign(flowReader([]), {
    queryRecords: async (entity) => { if (entity === 'workflow') throw new Error('HTTP 401'); return []; },
  });
  const c = flowCheck(await verifySpec(flowSpec(), read));
  assert.strictEqual(c.present, false);
  assert.match(c.detail, /could not be read/);
});

// --- 7. the spec diff SEES a flow change --------------------------------------------------------
//
// `PHASE_SLICES` is an explicit map, so a phase missing from it makes its slice invisible: the diff
// reports "nothing changed" and `--changed-only` classifies a real edit as a NO-OP and does nothing.
// business-rules was in exactly that state, which is why these assertions cover both phases.

const { diffPhases } = require('../lib/phase-diff.js');
const { classifyChanges } = require('../lib/classify-changes.js');

test('a flow-only edit is a real change, not a no-op', () => {
  const prior = specWith([FLOW]);
  const current = specWith([{ ...FLOW, stages: [...FLOW.stages, { name: 'Close', steps: [{ name: 'Sign off' }] }] }]);
  assert.deepStrictEqual(diffPhases(current, prior), ['business-process-flows']);
});

test('a business-RULE-only edit is a real change too (the same map governs both)', () => {
  const rule = { name: 'R', entity: 'new_ticket', conditions: [{ field: 'new_owner', operator: 'Equals', value: 'x' }], actions: [{ type: 'SetVisibility', field: 'new_notes', visible: false }] };
  const prior = { ...specWith([]), businessRules: [rule] };
  const current = { ...specWith([]), businessRules: [{ ...rule, actions: [{ type: 'SetVisibility', field: 'new_notes', visible: true }] }] };
  assert.deepStrictEqual(diffPhases(current, prior), ['business-rules']);
});

test('an EDITED flow forces a full build and records debt — the engine skips edits to an existing flow', () => {
  const prior = specWith([FLOW]);
  const current = specWith([{ ...FLOW, stages: [{ name: 'Renamed', steps: [{ name: 'Subject', field: 'new_subject' }] }, FLOW.stages[1]] }]);
  const r = classifyChanges(current, prior);
  assert.strictEqual(r.verdict, 'full');
  assert.ok(r.fullReasons.some((x) => /business-process-flows.*edited/.test(x)), JSON.stringify(r.fullReasons));
  assert.deepStrictEqual(r.debt, [{ artifactType: 'businessProcessFlow', identity: 'new_ticket|Ticket Handling', reason: 'businessProcessFlow-edit-not-convergent' }]);
});

test('an ADDED flow forces a full build with NO debt — a full build creates it correctly', () => {
  const prior = specWith([]);
  const current = specWith([FLOW]);
  const r = classifyChanges(current, prior);
  assert.strictEqual(r.verdict, 'full');
  assert.deepStrictEqual(r.debt, []);
});
