'use strict';
// REAL BUNDLE: the business-rule authoring contract.
//
// The plugin does not author business rules yet — this pins what the vendored SDK can actually do,
// so the feature can be built against a verified contract instead of a reading of the types, and so
// a re-vendor that breaks the path fails here rather than in a user's build.
//
// Why this is worth having before the feature exists: business rules were deferred on the belief
// that they could not be verified at all, because the `*ProcessWithWfomJson` bound actions were
// absent on the test orgs available at the time. That premise turned out to be wrong — on current
// orgs `$metadata` DOES declare all three (`CreateProcessWithWfomJson`, `UpdateProcessWithWfomJson`,
// `RetrieveProcessWithWfomJson`).
//
// But the API is declared and NOT FUNCTIONAL, which is a different and better-evidenced blocker.
// Measured across 6 orgs: `RetrieveProcessWithWfomJson` — a bound FUNCTION whose only parameter is
// the bound entity, so there is nothing a caller can get wrong — returns HTTP 400 (0x80040216,
// "An unexpected error occurred") on an UNTOUCHED, server-created rule in all six. Reading a rule
// the platform itself wrote fails identically to writing one, which rules out our payload.
//
// Eliminated along the way, each on its own: the table being unpublished (PublishXml returned 204,
// still 400), wrong field logical names (read back from `Attributes` and confirmed), and anything
// specific to a brand-new custom table (the same rule on OOB `account` fails too). An earlier
// hypothesis of mine — that the first 400 was caused by pushing an EMPTY rule (null rootCondition)
// — is DISPROVEN: a complete rule with condition, clause and action fails exactly the same way.
//
// So what remains proven here is the SDK half, which is genuinely useful: the authoring contract and
// the wire payload. The environmental blocker is tracked separately, and the cheapest gate for any
// future attempt is a single `RetrieveProcessWithWfomJson` returning 200 on an existing rule.
//
// Two traps worth recording, both of which cost real time:
//   * `$metadata` is XML. `dataverseRequest` sends `Accept: application/json`, so it answers 415 —
//     which reads exactly like "the actions are absent" if the status is not checked.
//   * The three actions are BOUND to `workflow`. Probing them as UNBOUND posts returns 404 and
//     proves nothing about whether they exist.
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const BUNDLE = path.resolve(__dirname, '..', 'vendor', 'cds-maker-sdk.cjs');
const dirs = [];

function sdkWithCapture() {
  const { createMakerSdk } = require(BUNDLE);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'br-'));
  dirs.push(dir);
  const writes = [];
  const httpClient = {
    get: async () => ({ status: 200, headers: {}, body: {} }),
    post: async (url, body) => {
      writes.push({ verb: 'post', url: String(url), body });
      return { status: 200, headers: {}, body: { ProcessId: '44444444-4444-4444-4444-444444444444' } };
    },
    patch: async (url, body) => { writes.push({ verb: 'patch', url: String(url), body }); return { status: 204, headers: {}, body: {} }; },
    put: async () => ({ status: 204, headers: {}, body: {} }),
    delete: async () => ({ status: 204, headers: {}, body: {} }),
  };
  const sdk = createMakerSdk({ workspacePath: dir, instanceUrl: 'https://contoso.crm.dynamics.com', httpClient });
  sdk.initWorkspace();
  return { sdk, writes };
}

// "IF account.name equals 'x' THEN hide fax" — the smallest rule that is actually meaningful.
// A rule with a null rootCondition is what the server rejected live, so the fixture is deliberately
// a complete one: condition + clause + a true-branch action.
function authorRule(sdk) {
  const art = sdk.createArtifact('businessRule', {
    name: 'Contract Rule', entityLogicalName: 'account', scope: 'Entity', status: 'Draft',
  });
  return { art, condition: {
    id: 'c1', displayName: 'If name is x', logic: 'AND',
    clauses: [{ id: 'cl1', field: 'name', fieldDisplayName: 'Name', operator: 'Equals', valueType: 'Value', value: 'x' }],
    trueBranch: [{ id: 'a1', kind: 'action', type: 'SetVisibility', displayName: 'Hide Fax', field: 'fax', value: 'false' }],
    falseBranch: [],
  } };
}

test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

test('REAL BUNDLE: a business rule is authored through the generic artifact lifecycle', async () => {
  // There is no dedicated business-rule API on MakerSdkApi — it is createArtifact -> updateElement
  // -> pushArtifact, like every other artifact. Pinning that is what tells a future implementer
  // which surface to build against.
  const { sdk } = sdkWithCapture();
  const { art, condition } = authorRule(sdk);
  assert.ok(art && art.id, 'createArtifact returns an artifact with an id');
  assert.deepStrictEqual(
    Object.keys(art).sort(),
    ['description', 'entityLogicalName', 'id', 'name', 'rootCondition', 'scope', 'status'],
    'the typed authoring surface is the documented one'
  );
  await sdk.updateElement('businessRule', art.id, '/rootCondition', condition);
  const pushed = await sdk.pushArtifact('businessRule', art.id);
  assert.strictEqual(pushed.saved, true, 'the push commits');
  // No publish was requested, so `shipped` must be false — saved is not shipped.
  assert.strictEqual(pushed.shipped, false);
  assert.strictEqual(pushed.publish.kind, 'notRequested');
});

test('REAL BUNDLE: the push targets the BOUND CreateProcessWithWfomJson action', async () => {
  // The boundness matters twice over: it is why an unbound probe 404s and proves nothing, and a
  // re-vendor that switched to an unbound or renamed endpoint would silently 404 at build time.
  const { sdk, writes } = sdkWithCapture();
  const { art, condition } = authorRule(sdk);
  await sdk.updateElement('businessRule', art.id, '/rootCondition', condition);
  await sdk.pushArtifact('businessRule', art.id);

  const call = writes.find((w) => /CreateProcessWithWfomJson/.test(w.url));
  assert.ok(call, 'a CreateProcessWithWfomJson call was issued; got ' + JSON.stringify(writes.map((w) => w.url)));
  assert.match(call.url, /workflows\(0{8}-0{4}-0{4}-0{4}-0{12}\)\/Microsoft\.Dynamics\.CRM\.CreateProcessWithWfomJson/,
    'a CREATE binds to the all-zero workflow id — that is the documented create pattern');
  assert.deepStrictEqual(Object.keys(call.body).sort(), ['Entity', 'WfomJson'],
    'the action takes exactly Entity + WfomJson');
});

test('REAL BUNDLE: the SDK compiles typed input into server WfomJson (not a passthrough)', async () => {
  // The whole value of the typed surface is that a caller writes a condition tree and the SDK emits
  // the server's workflow-object-model JSON. If it ever became a passthrough, callers would have to
  // hand-write WfomJson — a silent, very expensive contract change.
  const { sdk, writes } = sdkWithCapture();
  const { art, condition } = authorRule(sdk);
  await sdk.updateElement('businessRule', art.id, '/rootCondition', condition);
  await sdk.pushArtifact('businessRule', art.id);

  const call = writes.find((w) => /CreateProcessWithWfomJson/.test(w.url));
  const wfom = call.body.WfomJson;
  assert.strictEqual(typeof wfom, 'string', 'WfomJson is serialized as a STRING, not a nested object');
  const parsed = JSON.parse(wfom);
  // Observed server shape: a WorkflowStep root carrying the entity and a step list.
  assert.match(String(parsed.__class || ''), /WorkflowStep/, 'the root is a WorkflowStep');
  assert.strictEqual(parsed.primaryEntityName, 'account', 'the bound entity is carried into the model');
  // The authored field names must survive compilation — if they did not, the rule would be built
  // against nothing and would silently do nothing at runtime.
  assert.match(wfom, /"fax"/, 'the action target field reached the compiled model');
  assert.ok(wfom.length > 500, `a real rule compiles to a substantial model; got ${wfom.length} chars`);

  // `Entity` is NOT the logical name — it is the full workflow ROW to create. Pinning the
  // discriminating columns is what makes this a contract test rather than a smoke test: a rule
  // written with the wrong `category` is not a business rule at all, and the wrong
  // `processtriggerscope` silently changes whether it runs on the entity or one specific form.
  // Observed shape:
  //   { '@odata.type': '#Microsoft.Dynamics.CRM.workflow', name, description, workflowid,
  //     category: 2, type: 1, mode: 1, scope: 4, primaryentity: 'account',
  //     iscrmuiworkflow: true, processtriggerscope: 2, ondemand/subprocess/trigger*: false }
  const ent = call.body.Entity;
  assert.strictEqual(typeof ent, 'object', 'Entity is the workflow row, not a logical-name string');
  assert.match(String(ent['@odata.type'] || ''), /workflow/, 'typed as a workflow row');
  assert.strictEqual(ent.category, 2, 'category 2 is Business Rule — any other value is a different process type');
  assert.strictEqual(ent.primaryentity, 'account', 'bound to the authored entity');
  assert.strictEqual(ent.processtriggerscope, 2, "scope 'Entity' maps to processtriggerscope 2 (1 + a form id means one form)");
  assert.strictEqual(ent.iscrmuiworkflow, true, 'authored through the UI object model, not raw XAML');
});

test('REAL BUNDLE: an invalid condition is rejected at authoring time, not at the server', async () => {
  // Local validation is what turns "HTTP 400: An unexpected error occurred" — which is exactly what
  // the server returns for a malformed rule — into an actionable message. Verify it actually fires.
  const { sdk } = sdkWithCapture();
  const { art } = authorRule(sdk);
  await assert.rejects(
    async () => await sdk.updateElement('businessRule', art.id, '/rootCondition', {
      id: 'c1', displayName: '', logic: 'XOR', clauses: [], trueBranch: [], falseBranch: [],
    }),
    'an unsupported logic operator must be caught locally rather than sent to the server'
  );
});
