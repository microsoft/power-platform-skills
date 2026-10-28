'use strict';
// A page's one `actionBindings` array, as the Custom API lifecycle evaluator compares it when it holds both partitions: a Custom API row and a reviewed built-in operation
// (WhoAmI). The upload replaces the page's list with the file it is given, so the evaluator compares the WHOLE union — the Custom API rows, then the built-in rows in catalogue
// order — and the built-in rows must come from an enabled `dataverse-operations` gate, the catalogue listing and the plan's `## Dataverse Operations` table. Dropping either
// partition, spreading a descriptor onto the wire, reordering, or a built-in name in the Custom API table fails; a later stage that only preserves the page's bindings does not
// consult the built-in gate. The built-in call is held to the same order as a Custom API call: a failure returns before `res.outputs` is read.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PHASE_EXPECTATIONS, WORKFLOW_ASSERTIONS } = require('../lib/assertions-layer-1.js');
const { PHASE5_EXPECTATIONS } = require('../lib/assertions-layer-2.js');
const union = require('../lib/action-binding-union.js');
const { customApiProblems } = require('../lib/custom-api-contract.js');
const { getDataverseOperationCatalogue } = require('../../../../plugins/model-apps/scripts/lib/dataverse-operations.js');

const RULE = 'Phase 5: Custom API discovery, gate, bare bindings, runtime calls and update preservation or explicit clear agree';
const PAGE = '99999999-9999-4999-8999-999999999999';
const API = { name: 'cnt_ApproveOrder', isFunction: false, boundEntityLogicalName: 'salesorder', displayName: 'Approve Order', parameterKinds: { Comment: 'String', Amount: 'Decimal' } };
const WHO_AM_I = { name: 'WhoAmI', isFunction: true, displayName: 'Current Dataverse identity', parameterKinds: {} };
const RETRIEVE_VERSION = { name: 'RetrieveVersion', isFunction: true, displayName: 'Dataverse server version', parameterKinds: {} };
const listing = () => ({ ok: true, ...structuredClone(getDataverseOperationCatalogue()) });

// The Custom API helper of the existing lifecycle fixture, and a user-triggered WhoAmI helper and button (references/dataverse-operations.md).
const SOURCE = `
type ActionResult = { ok: boolean; indeterminate?: boolean; outputs?: Record<string, unknown>; error?: { message: string; code?: string; status?: number } };
type ActionApi = { executeAction?: (request: unknown) => Promise<ActionResult>; executeFunction?: (request: { name: string }) => Promise<ActionResult> };
type Pending = { current: boolean };
type Identity = { userId: string; businessUnitId: string; organizationId: string };
type IdentityView = { identity?: Identity; message?: string };
const GUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const UNEXPECTED = 'The operation returned an unexpected response. No result was displayed.';
const UNAVAILABLE = 'The selected operation is unavailable in this environment or player. No fallback was attempted.';
const UNSUPPORTED = 'This page player cannot call built-in operations.';
const FAILED = 'The operation failed. No result was displayed.';
async function approveOrder(api: ActionApi, recordId: string, amount: number, pending: Pending) {
  if (typeof api.executeAction !== 'function') return;
  if (pending.current || !recordId) return;
  pending.current = true;
  try {
    const res = await api.executeAction({
      name: 'cnt_ApproveOrder',
      parameters: { Comment: 'Approved', Amount: amount },
      boundTo: { entityName: 'salesorder', id: recordId },
    });
    if (res.indeterminate) { setError('Refresh before retrying.'); return; }
    if (!res.ok) { setError(res.error?.message ?? 'Action failed.'); return; }
    setStatus(res.outputs?.NewStatus);
  } catch { setError('Network failed.'); }
  finally { pending.current = false; }
}
function ownString(outputs: Record<string, unknown>, field: string): string | undefined {
  const value = Object.prototype.hasOwnProperty.call(outputs, field) ? outputs[field] : undefined;
  return typeof value === 'string' ? value : undefined;
}
async function readIdentity(api: ActionApi): Promise<IdentityView> {
  if (typeof api.executeFunction !== 'function') return { message: UNSUPPORTED };
  const res = await api.executeFunction({ name: 'WhoAmI' });
  if (res.ok !== true) {
    return { message: res.error?.status === 404 ? UNAVAILABLE : res.error?.message || FAILED };
  }
  const outputs = res.outputs;
  if (!outputs || typeof outputs !== 'object' || Array.isArray(outputs)) return { message: UNEXPECTED };
  const userId = ownString(outputs, 'UserId');
  const businessUnitId = ownString(outputs, 'BusinessUnitId');
  const organizationId = ownString(outputs, 'OrganizationId');
  if (![userId, businessUnitId, organizationId].every((id) => typeof id === 'string' && GUID.test(id))) return { message: UNEXPECTED };
  return { identity: { userId: userId as string, businessUnitId: businessUnitId as string, organizationId: organizationId as string } };
}
const GeneratedComponent = (props: Props) => {
  const { dataApi } = props;
  const pending = { current: false };
  const [identity, setIdentity] = React.useState<IdentityView>({});
  const [identityPending, setIdentityPending] = React.useState(false);
  const identityRequest = React.useRef(0);
  const mounted = React.useRef(true);
  React.useEffect(() => () => { mounted.current = false; }, []);
  const showIdentity = async () => {
    if (identityPending) return;
    const requestId = ++identityRequest.current;
    setIdentity({});
    setIdentityPending(true);
    try {
      const view = await readIdentity(dataApi);
      if (mounted.current && requestId === identityRequest.current) setIdentity(view);
    } catch {
      if (mounted.current && requestId === identityRequest.current) setIdentity({ message: FAILED });
    } finally {
      if (mounted.current && requestId === identityRequest.current) setIdentityPending(false);
    }
  };
  void approveOrder(dataApi, 'record', 1, pending);
  return (
    <div>
      <Button disabled={identityPending} onClick={() => void showIdentity()}>Show my Dataverse identity</Button>
      {identity.message && <Text>{identity.message}</Text>}
      {identity.identity && (
        <div>
          <Text>Dataverse user id: {identity.identity.userId}</Text>
          <Text>Business unit id: {identity.identity.businessUnitId}</Text>
          <Text>Organization id: {identity.identity.organizationId}</Text>
          <Text>The organization id is not an Entra tenant id.</Text>
        </div>
      )}
    </div>
  );
};
export default GeneratedComponent;
`;

const PLAN = `## Custom API Bindings
| Name | Kind | Bound Entity | Display Name | Parameters (name: kind) |
|------|------|--------------|--------------|-------------------------|
| cnt_ApproveOrder | Action | salesorder | Approve Order | Comment: String, Amount: Decimal |

## Dataverse Operations
Verification: environment not-checked, runtime not-checked, privileges not-checked.
| Name | Kind | Bound Entity | Display Name | Parameters | Response fields | Invoke |
|------|------|--------------|--------------|------------|-----------------|--------|
| WhoAmI | Function | (Global) | Current Dataverse identity | (none) | BusinessUnitId, UserId, OrganizationId | button |
`;

function mixedFixture() {
  const both = [API, WHO_AM_I];
  const config = JSON.stringify({ actionBindings: both });
  return {
    contractVersion: 2,
    files: [{ name: 'page.tsx', content: SOURCE }],
    artifacts: { 'stages/with-api.tsx': SOURCE, 'actions.json': JSON.stringify(both), 'created/config.json': config, 'preserved/config.json': config },
    genpagePlan: PLAN,
    workflowLog: 'Custom API and built-in operation lifecycle; latest enabled gates before each authoring generation and upload.',
    manifest: {
      customApi: {
        outputs: { cnt_ApproveOrder: ['NewStatus'] },
        stages: [
          { id: 'create', target: 'page.tsx', source: 'stages/with-api.tsx', actions: 'actions.json', afterConfig: 'created/config.json', upload: 'create' },
          { id: 'preserve', target: 'page.tsx', source: 'stages/with-api.tsx', beforeConfig: 'created/config.json', afterConfig: 'preserved/config.json', upload: 'preserve' },
        ],
      },
    },
    events: [
      { id: 'gate-create', command: 'node feature-flags.js custom-api', result: 'enabled' },
      { id: 'discovery', command: 'node list-custom-apis.js https://contoso.crm.dynamics.com --entities salesorder', result: { ok: true, customApis: [{ ...structuredClone(API), bindingType: 'Entity' }] } },
      { id: 'builtin-gate', command: 'node feature-flags.js dataverse-operations', result: 'enabled' },
      { id: 'listing', command: 'node list-dataverse-operations.js', result: listing() },
      { id: 'gate-generate', command: 'node feature-flags.js custom-api', result: 'enabled' },
      { id: 'builtin-regate', command: 'node feature-flags.js dataverse-operations', result: 'enabled' },
      { id: 'write-create', command: 'Write page.tsx', artifact: 'stages/with-api.tsx' },
      { id: 'create', command: 'node genpage-upload.js --code-file page.tsx --actions actions.json --add-to-sitemap', result: { ok: true, pageId: PAGE } },
      // An unrelated later edit while built-in authoring is OFF: it preserves the page's bindings (no --actions) and does not halt.
      { id: 'gate-preserve', command: 'node feature-flags.js custom-api', result: 'enabled' },
      { id: 'builtin-off', command: 'node feature-flags.js dataverse-operations', result: 'disabled' },
      { id: 'write-preserve', command: 'Write page.tsx', artifact: 'stages/with-api.tsx' },
      { id: 'preserve', command: `node genpage-upload.js --page-id ${PAGE} --code-file page.tsx`, result: { ok: true, pageId: PAGE } },
    ],
  };
}

const event = (fixture, id) => fixture.events.find((call) => call.id === id);
function score(fixture, layer = 1) {
  const check = (layer === 1 ? PHASE_EXPECTATIONS : PHASE5_EXPECTATIONS).get(RULE);
  return check({ fixture, files: fixture.files, eval: { id: 24 } });
}
const setActions = (fixture, rows) => { fixture.artifacts['actions.json'] = JSON.stringify(rows); };
const setConfigs = (fixture, rows) => { for (const name of ['created/config.json', 'preserved/config.json']) fixture.artifacts[name] = JSON.stringify({ actionBindings: rows }); };

test('a mixed actions file — a Custom API row and a reviewed built-in — passes as one union in both evaluator layers', () => {
  for (const layer of [1, 2]) {
    const result = score(mixedFixture(), layer);
    assert.equal(result.status, 'pass', `layer ${layer}: ${result.reason}`);
  }
});

test('the union is compared whole: dropping either partition, spreading a descriptor or putting a built-in first fails', () => {
  for (const [label, mutate] of [
    ['the built-in partition dropped from every file', (f) => { setActions(f, [API]); setConfigs(f, [API]); }],
    ['the Custom API partition dropped from every file', (f) => { setActions(f, [WHO_AM_I]); setConfigs(f, [WHO_AM_I]); }],
    ['the built-in row only in actions.json', (f) => { setConfigs(f, [API]); }],
    ['a descriptor spread onto the wire', (f) => { const rows = [API, { ...WHO_AM_I, bindingType: 'Global', response: listing().operations[0].response }]; setActions(f, rows); setConfigs(f, rows); }],
    ['the built-in before the Custom API row', (f) => { setActions(f, [WHO_AM_I, API]); }],
    ['a built-in row with a display name of its own', (f) => { const rows = [API, { ...WHO_AM_I, displayName: 'Who am I' }]; setActions(f, rows); setConfigs(f, rows); }],
    ['a built-in the plan did not select', (f) => { const rows = [API, WHO_AM_I, RETRIEVE_VERSION]; setActions(f, rows); setConfigs(f, rows); }],
  ]) {
    for (const layer of [1, 2]) {
      const bad = mixedFixture();
      mutate(bad);
      assert.equal(score(bad, layer).status, 'fail', `layer ${layer}: ${label}`);
    }
  }
});

test('built-in rows need an enabled dataverse-operations gate, the catalogue listing and a re-probe before an authoring generation and upload — a preserve-only stage does not', () => {
  assert.equal(score(mixedFixture()).status, 'pass');
  for (const [label, mutate] of [
    ['listing after a disabled gate', (f) => { event(f, 'builtin-gate').result = 'disabled'; }],
    ['no listing', (f) => { f.events = f.events.filter((call) => call.id !== 'listing'); }],
    ['no re-probe after the listing', (f) => { f.events = f.events.filter((call) => call.id !== 'builtin-regate'); }],
    ['a disabled re-probe', (f) => { event(f, 'builtin-regate').result = 'disabled'; }],
    ['an unreadable re-probe', (f) => { event(f, 'builtin-regate').result = 'maybe'; }],
    ['a failed listing', (f) => { event(f, 'listing').result = { ok: false, error: 'The built-in operation catalogue could not be read. No built-in operations were offered.' }; }],
    ['a widened listing', (f) => { const result = listing(); result.operations.push({ ...result.operations[0], name: 'CalculateRollupField' }); event(f, 'listing').result = result; }],
    ['a listing that claims a check', (f) => { event(f, 'listing').result = { ...listing(), eligible: true }; }],
    ['an altered listed descriptor', (f) => { const result = listing(); result.operations[0].isFunction = false; event(f, 'listing').result = result; }],
  ]) {
    const bad = mixedFixture();
    mutate(bad);
    assert.equal(score(bad).status, 'fail', label);
  }
});

test('the plan section is the exact sentinel or the catalogue\'s own table — anything else halts, and a built-in never sits in the Custom API table', () => {
  const plan = (rows) => PLAN.replace('| WhoAmI | Function | (Global) | Current Dataverse identity | (none) | BusinessUnitId, UserId, OrganizationId | button |', rows);
  for (const [label, text] of [
    ['wrong case', plan('| whoami | Function | (Global) | Current Dataverse identity | (none) | BusinessUnitId, UserId, OrganizationId | button |')],
    ['an effectful Function', plan('| CalculateRollupField | Function | (Global) | Calculate | (none) | Entity | button |')],
    ['a display name of its own', plan('| WhoAmI | Function | (Global) | Who am I | (none) | BusinessUnitId, UserId, OrganizationId | button |')],
    ['an on-load trigger', plan('| WhoAmI | Function | (Global) | Current Dataverse identity | (none) | BusinessUnitId, UserId, OrganizationId | on-load |')],
    ['no verification line', PLAN.replace('Verification: environment not-checked, runtime not-checked, privileges not-checked.\n', '')],
    ['prose instead of a table', PLAN.replace(/## Dataverse Operations[\s\S]*$/, '## Dataverse Operations\nWhoAmI, please.\n')],
    // Moved, not duplicated: the Custom API table states the very row the built-in table would, and is still not where a built-in belongs.
    ['in the Custom API table', PLAN.replace(/\n## Dataverse Operations[\s\S]*$/, '\n').replace('| cnt_ApproveOrder | Action | salesorder | Approve Order | Comment: String, Amount: Decimal |', '| cnt_ApproveOrder | Action | salesorder | Approve Order | Comment: String, Amount: Decimal |\n| WhoAmI | Function | (Global) | Current Dataverse identity |  |')],
  ]) {
    const bad = mixedFixture();
    bad.genpagePlan = text;
    assert.equal(score(bad).status, 'fail', label);
  }
  assert.deepStrictEqual(union.plannedBuiltIns(PLAN), [WHO_AM_I]);
  assert.deepStrictEqual(union.plannedBuiltIns('## Dataverse Operations\nNo Dataverse operations.\n'), []);
  assert.equal(union.plannedBuiltIns('## Custom API Bindings\nNo custom API bindings.\n'), null);
});

test('a built-in call is held to the Custom API order: a failure returns before res.outputs is read, and DTO fields come only from res.outputs', () => {
  for (const [label, mutate] of [
    ['outputs read before the success check', (text) => text.replace('  if (res.ok !== true) {\n    return { message: res.error?.status === 404 ? UNAVAILABLE : res.error?.message || FAILED };\n  }\n  const outputs = res.outputs;', '  const outputs = res.outputs;\n  if (res.ok !== true) {\n    return { message: res.error?.status === 404 ? UNAVAILABLE : res.error?.message || FAILED };\n  }')],
    ['no success check at all', (text) => text.replace('if (res.ok !== true) {', 'if (false) {')],
    ['outputs from res.value', (text) => text.replace('const outputs = res.outputs;', 'const outputs = res.value;')],
    ['an undeclared output', (text) => text.replace("ownString(outputs, 'UserId')", 'ownString(outputs, String(res.outputs?.SystemUserName))')],
    ['raw fault text', (text) => text.replace('res.error?.message || FAILED', 'res.error?.stack || FAILED')],
  ]) {
    const bad = mixedFixture();
    bad.artifacts['stages/with-api.tsx'] = mutate(SOURCE);
    bad.files[0].content = bad.artifacts['stages/with-api.tsx'];
    assert.notEqual(bad.artifacts['stages/with-api.tsx'], SOURCE, `${label}: the mutation applies`);
    assert.equal(score(bad).status, 'fail', label);
  }
});

test('union helpers: partition by exact name, one union with no duplicate, and the order a new actions file keeps', () => {
  assert.deepStrictEqual(union.partitionBindings([API, WHO_AM_I, { name: 'whoami', isFunction: true }, RETRIEVE_VERSION]), {
    customApis: [API, { name: 'whoami', isFunction: true }], builtIns: [WHO_AM_I, RETRIEVE_VERSION],
  });
  assert.deepStrictEqual(union.unionBindings([API], [WHO_AM_I, RETRIEVE_VERSION]), [API, WHO_AM_I, RETRIEVE_VERSION]);
  assert.throws(() => union.unionBindings([API, WHO_AM_I], [WHO_AM_I]), /Select each built-in operation once/);
  assert.deepStrictEqual(union.unionOrderProblems([API, WHO_AM_I, RETRIEVE_VERSION], 'a'), []);
  assert.equal(union.unionOrderProblems([WHO_AM_I, API], 'a').length, 1);
  assert.equal(union.unionOrderProblems([API, RETRIEVE_VERSION, WHO_AM_I], 'a').length, 1);
  assert.deepStrictEqual(union.BUILT_IN_OUTPUTS, { WhoAmI: ['BusinessUnitId', 'UserId', 'OrganizationId'], RetrieveVersion: ['Version'] });
});

// ── The built-in gate at the authoring consumer, and a removal ─────────────────────────────────────────────────────────────────────
// The page sources of one partition alone, cut from the mixed page: the Custom API helper and its render call, or the WhoAmI helper and its button.
const APPROVE_HELPER = SOURCE.slice(SOURCE.indexOf('async function approveOrder('), SOURCE.indexOf('function ownString('));
const CUSTOM_ONLY = SOURCE.replace(SOURCE.slice(SOURCE.indexOf('function ownString('), SOURCE.indexOf('const GeneratedComponent')), '')
  .replace(/  const \[identity[\s\S]*?\n  \};\n/, '')
  .replace(/      <Button disabled=\{identityPending\}[\s\S]*?\n      \)\}\n/, '');
const BUILT_IN_ONLY = SOURCE.replace(APPROVE_HELPER, '').replace("  void approveOrder(dataApi, 'record', 1, pending);\n", '');
const SENTINEL_PLAN = PLAN.replace(/## Custom API Bindings[\s\S]*?\n\n## Dataverse Operations/, '## Custom API Bindings\nNo custom API bindings.\n\n## Dataverse Operations');
const CUSTOM_PLAN = PLAN.replace(/\n## Dataverse Operations[\s\S]*$/, '\n');

// A one-stage create with the rows, the plan and the page given. `customApi` is what an older run's recorded `custom-api` probe printed, or null
// for a run that never probed it — as no run does now; it decides nothing. Custom API discovery is recorded when `discovery` (by default, whenever a
// row is a Custom API). `builtIns` is the dataverse-operations gate, and `listing` adds the catalogue listing after it.
function createFixture({ rows, plan, source, customApi = null, builtIns, listing: listed = builtIns === 'enabled', discovery = rows.some((row) => !union.isBuiltInBinding(row)) }) {
  const fixture = mixedFixture();
  fixture.genpagePlan = plan;
  fixture.files[0].content = source;
  fixture.artifacts['stages/with-api.tsx'] = source;
  setActions(fixture, rows);
  setConfigs(fixture, rows);
  fixture.manifest.customApi.stages = fixture.manifest.customApi.stages.slice(0, 1);
  const keep = new Set(['builtin-gate', 'builtin-regate', 'write-create', 'create',
    ...(customApi === null ? [] : ['gate-create', 'gate-generate']), ...(discovery ? ['discovery'] : []), ...(listed ? ['listing'] : [])]);
  fixture.events = fixture.events.filter((call) => keep.has(call.id));
  if (customApi !== null) for (const id of ['gate-create', 'gate-generate']) event(fixture, id).result = customApi;
  for (const id of ['builtin-gate', 'builtin-regate']) event(fixture, id).result = builtIns;
  return fixture;
}

test('only the dataverse-operations gate decides authoring at the consumer: a built-in row needs it ON, and a recorded custom-api probe — enabled, disabled or none — decides nothing', () => {
  for (const customApi of ['enabled', 'disabled', null]) {
    const label = `custom-api probe ${customApi === null ? 'never run' : customApi}`;
    // Built-ins ON: a built-in-only page is authored.
    assert.equal(score(createFixture({ rows: [WHO_AM_I], plan: SENTINEL_PLAN, source: BUILT_IN_ONLY, customApi, builtIns: 'enabled' })).status, 'pass', label);
    // Built-ins OFF: a Custom-API-only page is authored, and no built-in row may be.
    assert.equal(score(createFixture({ rows: [API], plan: CUSTOM_PLAN, source: CUSTOM_ONLY, customApi, builtIns: 'disabled' })).status, 'pass', label);
    assert.equal(score(createFixture({ rows: [API, WHO_AM_I], plan: PLAN, source: SOURCE, customApi, builtIns: 'disabled', listing: true })).status, 'fail', `${label}: a built-in row authored while its gate is off`);
    assert.equal(score(createFixture({ rows: [WHO_AM_I], plan: SENTINEL_PLAN, source: BUILT_IN_ONLY, customApi, builtIns: 'disabled', listing: true })).status, 'fail', label);
  }
  // Both partitions with the built-in gate ON is the mixed page.
  assert.equal(score(mixedFixture()).status, 'pass');
});

test('a built-in-only create binds its rows with --actions whatever a recorded custom-api probe printed, and one that omits --actions fails in both layers', () => {
  for (const customApi of ['enabled', 'disabled', null]) {
    for (const layer of [1, 2]) {
      const bound = score(createFixture({ rows: [WHO_AM_I], plan: SENTINEL_PLAN, source: BUILT_IN_ONLY, customApi, builtIns: 'enabled' }), layer);
      assert.equal(bound.status, 'pass', `custom-api ${customApi}, layer ${layer}: ${bound.reason}`);
      const omitted = createFixture({ rows: [WHO_AM_I], plan: SENTINEL_PLAN, source: BUILT_IN_ONLY, customApi, builtIns: 'enabled' });
      event(omitted, 'create').command = 'node genpage-upload.js --code-file page.tsx --add-to-sitemap';
      assert.equal(score(omitted, layer).status, 'fail', `custom-api ${customApi}, layer ${layer}: a create without --actions leaves WhoAmI unbound`);
    }
  }
});

// A create whose built-in offer added nothing — the dataverse-operations gate off, or the offer listed and declined — is complete without the
// call: the planner was told `none — not added this run`, so the plan has no `## Dataverse Operations` section, the actions file no built-in row
// and the page no such call. The same page with the call left in it fails: the call would have no binding.
test('a create whose built-in offer added nothing — the gate off, or the offer declined — is graded as a complete page without the call', () => {
  for (const [label, builtIns, listing] of [['the dataverse-operations gate off', 'disabled', false], ['the offer listed and declined', 'enabled', true]]) {
    for (const layer of [1, 2]) {
      const complete = score(createFixture({ rows: [API], plan: CUSTOM_PLAN, source: CUSTOM_ONLY, customApi: 'enabled', builtIns, listing }), layer);
      assert.equal(complete.status, 'pass', `${label}, layer ${layer}: ${complete.reason}`);
      const leftIn = score(createFixture({ rows: [API], plan: CUSTOM_PLAN, source: SOURCE, customApi: 'enabled', builtIns, listing }), layer);
      assert.equal(leftIn.status, 'fail', `${label}, layer ${layer}: a WhoAmI call with no binding`);
    }
  }
});

test('a removal drops only the named entries and needs no built-in gate: WhoAmI out keeps the Custom API, and the reverse', () => {
  const removal = (removed, kept, source) => {
    const fixture = mixedFixture();
    fixture.artifacts['removed-actions.json'] = JSON.stringify(kept);
    fixture.artifacts['removed/config.json'] = JSON.stringify({ actionBindings: kept });
    fixture.artifacts['stages/removed.tsx'] = source;
    fixture.files[0].content = source;
    fixture.manifest.customApi.stages.push({ id: 'remove', target: 'page.tsx', source: 'stages/removed.tsx', actions: 'removed-actions.json', beforeConfig: 'preserved/config.json', afterConfig: 'removed/config.json', upload: 'remove', change: { remove: removed } });
    fixture.events.push(
      { id: 'gate-remove', command: 'node feature-flags.js custom-api', result: 'enabled' },
      { id: 'write-remove', command: 'Write page.tsx', artifact: 'stages/removed.tsx' },
      { id: 'remove', command: `node genpage-upload.js --page-id ${PAGE} --code-file page.tsx --actions removed-actions.json`, result: { ok: true, pageId: PAGE } },
    );
    return fixture;
  };
  // The built-in gate was last probed OFF (the preserve stage): a removal does not consult it.
  assert.equal(score(removal(['WhoAmI'], [API], CUSTOM_ONLY)).status, 'pass');
  assert.equal(score(removal(['cnt_ApproveOrder'], [WHO_AM_I], BUILT_IN_ONLY)).status, 'pass');
  const both = removal(['WhoAmI'], [], CUSTOM_ONLY);
  assert.equal(score(both).status, 'fail', 'removing WhoAmI must not drop the Custom API too');
});

// ── Removing every Custom API, and clearing every binding ───────────────────────────────────────────────────────────────────────────
// A later update of the mixed page: `change` is the maker's intent as the scenario records it, `rows` the actions file uploaded.
const NO_CALLS = "import * as React from 'react';\nconst GeneratedComponent = () => <div>No server calls.</div>;\nexport default GeneratedComponent;\n";
function withUpdate(fixture, id, change, rows, source) {
  fixture.artifacts[`${id}-actions.json`] = JSON.stringify(rows);
  fixture.artifacts[`${id}/config.json`] = JSON.stringify({ actionBindings: rows });
  fixture.artifacts[`stages/${id}.tsx`] = source;
  fixture.files[0].content = source;
  fixture.manifest.customApi.stages.push({ id, target: 'page.tsx', source: `stages/${id}.tsx`, actions: `${id}-actions.json`, beforeConfig: 'preserved/config.json', afterConfig: `${id}/config.json`, upload: id, change });
  fixture.events.push(
    { id: `gate-${id}`, command: 'node feature-flags.js custom-api', result: 'enabled' },
    { id: `write-${id}`, command: 'Write page.tsx', artifact: `stages/${id}.tsx` },
    { id, command: `node genpage-upload.js --page-id ${PAGE} --code-file page.tsx --actions ${id}-actions.json`, result: { ok: true, pageId: PAGE } },
  );
  return fixture;
}

test('removing every Custom API of a mixed page keeps WhoAmI — an empty actions file in its place fails in both layers', () => {
  for (const layer of [1, 2]) {
    const kept = score(withUpdate(mixedFixture(), 'remove-apis', { remove: ['cnt_ApproveOrder'] }, [WHO_AM_I], BUILT_IN_ONLY), layer);
    assert.equal(kept.status, 'pass', `layer ${layer}: ${kept.reason}`);
    const emptied = score(withUpdate(mixedFixture(), 'remove-apis', { remove: ['cnt_ApproveOrder'] }, [], BUILT_IN_ONLY), layer);
    assert.equal(emptied.status, 'fail', `layer ${layer}: [] deletes WhoAmI`);
  }
});

// The clear's own record (edit-flow.md, Edit Phase 6): the maker's answer to the two-option clear question, written as its own workflow-log line
// right before the upload it covers —
//   Clear choice: Clear every action binding of page <page-id>, removing WhoAmI
// The last `Clear choice:` line before the log line that carries this upload's exact command is the one that counts, and each upload consumes
// the choice before it, as an overwrite choice is consumed (upload-contract.js): one choice covers one upload, a later choice replaces an
// earlier one, and a choice written after the upload, for another page or for another set of built-ins is no permission. A yes to adding or
// keeping WhoAmI is not a clear choice at all.
const OTHER_PAGE = '11111111-1111-4111-8111-111111111111';
const CLEAR_CHOICE = `Clear choice: Clear every action binding of page ${PAGE}, removing WhoAmI`;
const CLEAR_REFUSED = /^clear: clearing every action binding removes WhoAmI — only with the maker's clear choice recorded right before this upload/;
// The clear of the mixed page, with `lines` appended to its workflow log; `<upload>` stands for the log line of the clear's upload command and
// `retry` makes the clear upload twice — a first attempt that failed, then the stage's own upload — both logged with the same command.
function cleared(lines, { retry = false } = {}) {
  const fixture = withUpdate(mixedFixture(), 'clear', { clear: true }, [], NO_CALLS);
  const upload = fixture.events.find((call) => call.id === 'clear');
  if (retry) fixture.events.splice(fixture.events.indexOf(upload), 0, { id: 'clear-attempt', command: upload.command, result: { ok: false, error: 'The request timed out.' } });
  fixture.workflowLog = [fixture.workflowLog, ...lines.map((line) => (line === '<upload>' ? `- Command: \`${upload.command}\`` : line))].join('\n');
  return fixture;
}

test('clearing every binding of a page that binds WhoAmI needs the clear choice, recorded right before that upload, for that page and every built-in it removes', () => {
  const asked = 'AskUserQuestion: Clearing every action binding also removes WhoAmI. → Clear every action binding, removing WhoAmI';
  for (const [label, fixture] of [
    ['the choice before the upload', cleared([asked, CLEAR_CHOICE, '<upload>'])],
    ['the choice beside an overwrite choice for the same upload', cleared([CLEAR_CHOICE, 'Choice: Overwrite the deployed changes', '<upload>'])],
    ['a retried clear with the choice written again', cleared([CLEAR_CHOICE, '<upload>', CLEAR_CHOICE, '<upload>'], { retry: true })],
  ]) {
    for (const layer of [1, 2]) {
      const result = score(fixture, layer);
      assert.equal(result.status, 'pass', `${label}, layer ${layer}: ${result.reason}`);
    }
  }
  for (const [label, fixture] of [
    ['no confirmation', cleared(['<upload>'])],
    ['a yes to adding WhoAmI', cleared(['AskUserQuestion: Add a button for WhoAmI? → Yes', '<upload>'])],
    ['a yes to keeping WhoAmI', cleared(['AskUserQuestion: Keep the WhoAmI binding? → Yes', '<upload>'])],
    ['a free-text yes to clearing', cleared(['AskUserQuestion: Clear every action binding? This also removes WhoAmI. → Yes, clear them all', '<upload>'])],
    ['a clear choice withdrawn before the upload', cleared([CLEAR_CHOICE, 'Clear choice: Keep WhoAmI', '<upload>'])],
    ['a clear choice written after the upload', cleared(['<upload>', CLEAR_CHOICE])],
    ['a qualified answer', cleared([`${CLEAR_CHOICE}, but keep WhoAmI`, '<upload>'])],
    ['a choice for another page', cleared([CLEAR_CHOICE.replace(PAGE, OTHER_PAGE), '<upload>'])],
    ['a choice for another set of built-ins', cleared([`${CLEAR_CHOICE} and RetrieveVersion`, '<upload>'])],
    ['one choice for a retried clear', cleared([CLEAR_CHOICE, '<upload>', '<upload>'], { retry: true })],
  ]) {
    const problems = customApiProblems(fixture);
    assert.ok(problems.some((problem) => CLEAR_REFUSED.test(problem)), `${label}: ${JSON.stringify(problems)}`);
    for (const layer of [1, 2]) assert.equal(score(fixture, layer).status, 'fail', `${label}, layer ${layer}`);
  }
  // A page with no built-in row clears as before: the Custom APIs are the whole array, and no choice is asked.
  const apiOnly = mixedFixture();
  apiOnly.genpagePlan = CUSTOM_PLAN;
  for (const call of apiOnly.events.filter((entry) => ['builtin-gate', 'listing', 'builtin-regate'].includes(entry.id))) apiOnly.events.splice(apiOnly.events.indexOf(call), 1);
  apiOnly.artifacts['stages/with-api.tsx'] = CUSTOM_ONLY;
  setActions(apiOnly, [API]);
  setConfigs(apiOnly, [API]);
  const result = score(withUpdate(apiOnly, 'clear', { clear: true }, [], NO_CALLS));
  assert.equal(result.status, 'pass', result.reason);
});

// ── A Custom API removal, and a recorded custom-api probe ──────────────────────────────────────────────────────────────────────────
// An edit of a downloaded page that binds the Custom API and WhoAmI; `remove` is what the maker asked to remove. Custom API support has no feature
// flag, so the builder drops each named Custom API row and keeps every other row. `probe` is what an older run's recorded `custom-api` probe
// printed (none when null, as no run probes it now): it decides nothing — the run is graded the same whatever it says.
const APP = '88888888-8888-4888-8888-888888888888';
const CUSTOM_API_PROBE = /\bfeature-flags\.js\b[^\n]*\bcustom-api\b/;
function removalEdit({ probe = null, remove = ['cnt_ApproveOrder'], change = { remove }, rows, source, actions = true, log = '' }) {
  const before = [API, WHO_AM_I];
  const identity = JSON.stringify({ pageId: PAGE, appId: APP });
  const env = 'https://contoso.crm.dynamics.com';
  return {
    contractVersion: 2,
    files: [{ name: 'page.tsx', content: source }],
    artifacts: {
      'stages/page.tsx': source, 'actions.json': JSON.stringify(rows),
      'before/config.json': JSON.stringify({ actionBindings: before }), 'after/config.json': JSON.stringify({ actionBindings: rows }),
      'before/page.json': identity, 'after/page.json': identity,
    },
    genpagePlan: '## Custom API Bindings\nNo custom API bindings.\n',
    workflowLog: `An edit that removes ${remove.join(' and ')} from a page that binds a Custom API and WhoAmI.${log ? `\n${log}` : ''}`,
    manifest: {
      customApi: {
        outputs: { cnt_ApproveOrder: ['NewStatus'] },
        stages: [{ id: 'edit', target: 'page.tsx', source: 'stages/page.tsx', actions: 'actions.json', beforeConfig: 'before/config.json', afterConfig: 'after/config.json', upload: 'edit', change }],
      },
      uploads: [{ event: 'edit', mode: 'update', beforeConfig: 'before/config.json', afterConfig: 'after/config.json', beforePage: 'before/page.json', afterPage: 'after/page.json' }],
    },
    events: [
      { id: 'download', command: `node genpage.js download --env ${env} --page-id ${PAGE} --app-id ${APP} --output-directory before`, result: { ok: true, pages: [{ pageId: PAGE }] } },
      ...(probe === null ? [] : [{ id: 'custom-api-gate', command: 'node feature-flags.js custom-api', result: probe }]),
      { id: 'builtin-gate', command: 'node feature-flags.js dataverse-operations', result: 'disabled' },
      { id: 'write', command: 'Write page.tsx', artifact: 'stages/page.tsx' },
      { id: 'edit', command: `node genpage-upload.js --env ${env} --page-id ${PAGE} --app-id ${APP} --code-file page.tsx${actions ? ' --actions actions.json' : ''}`, result: { ok: true, pageId: PAGE, appId: APP } },
    ],
  };
}
const both = (fixture, status, label) => {
  for (const layer of [1, 2]) {
    const result = score(fixture, layer);
    assert.equal(result.status, status, `${label}, layer ${layer}: ${result.reason}`);
  }
};

test('removing every Custom API of a mixed page removes its row and keeps WhoAmI whatever a recorded custom-api probe printed — the row kept is no removal', () => {
  for (const probe of [null, 'enabled', 'disabled', 'maybe']) {
    const label = `custom-api probe ${probe === null ? 'never run' : probe}`;
    both(removalEdit({ probe, rows: [WHO_AM_I], source: BUILT_IN_ONLY }), 'pass', `${label}: the row removed, WhoAmI kept`);
    // WhoAmI named in the same removal goes too: every named row goes.
    both(removalEdit({ probe, remove: ['cnt_ApproveOrder', 'WhoAmI'], rows: [], source: NO_CALLS }), 'pass', `${label}: both named rows removed`);
    // What the builder once did while custom-api was OFF — keep the row, report the removal as not performed, upload nothing — leaves the
    // maker's removal undone, and its report excuses nothing.
    const kept = removalEdit({ probe, rows: [API, WHO_AM_I], source: SOURCE, actions: false, log: 'Custom API removal not performed (custom-api disabled): cnt_ApproveOrder' });
    const found = customApiProblems(kept);
    assert.ok(found.some((entry) => /^edit: actions file must be the full desired bare array/.test(entry)), `${label}, the row kept: ${JSON.stringify(found)}`);
    both(kept, 'fail', `${label}: the row kept`);
    // Turning the removal into a clear still deletes WhoAmI, which the maker did not name.
    both(removalEdit({ probe, rows: [], source: NO_CALLS }), 'fail', `${label}: turned into a clear`);
  }
});

// The `custom-api` flag was removed (Custom API support is always available), and with it every rule that graded its gate. Older runs recorded
// the probe, so a probe is neither required nor refused: a run graded with no probe, or with one that printed `disabled` or something unreadable,
// gets the grade it gets with an `enabled` probe — the discovery, binding, runtime and preservation checks decide it.
test('no rule grades a custom-api gate: a run with no probe, or with one that printed disabled or something unreadable, grades as one that printed enabled', () => {
  assert.ok(![...WORKFLOW_ASSERTIONS.keys()].some((key) => /after a disabled or unreadable feature gate/.test(key)), 'the Phase 4.6 gate rule is not registered');
  const variant = (mutate) => {
    const fixture = mixedFixture();
    mutate(fixture.events.filter((call) => CUSTOM_API_PROBE.test(call.command)), fixture);
    return fixture;
  };
  for (const [label, fixture] of [
    ['an enabled probe (the control)', mixedFixture()],
    ['no probe at all', variant((probes, fixture) => { fixture.events = fixture.events.filter((call) => !probes.includes(call)); })],
    ['every probe printed disabled', variant((probes) => { for (const call of probes) call.result = 'disabled'; })],
    ['every probe unreadable', variant((probes) => { for (const call of probes) call.result = 'maybe'; })],
    ['discovery after a disabled probe', variant((probes, fixture) => { event(fixture, 'gate-create').result = 'disabled'; })],
  ]) {
    assert.deepStrictEqual(customApiProblems(fixture), [], label);
    both(fixture, 'pass', label);
  }
  // What the gate rules once refused is graded on its own evidence now: a create with Custom API rows after a disabled probe passes when its
  // discovery, bindings and calls agree, and fails when they do not.
  const created = createFixture({ rows: [API], plan: CUSTOM_PLAN, source: CUSTOM_ONLY, customApi: 'disabled', builtIns: 'disabled' });
  both(created, 'pass', 'a create after a disabled probe');
  const undiscovered = createFixture({ rows: [API], plan: CUSTOM_PLAN, source: CUSTOM_ONLY, customApi: 'disabled', builtIns: 'disabled', discovery: false });
  both(undiscovered, 'fail', 'a create with no discovery');
});

// A maker who asked for failure telemetry may hand the page's appInsights prop to the canonical reporter (references/rules.md
// "Missing Error Handling") as its seventh argument. In a built-in operation's helper or handlers that mention is not exempt from
// the built-in privacy check: no grader proves the report carries only the host's own diagnostics, so the check fails closed and
// refuses it, as it refuses every other path from a built-in call to telemetry.
const RULES = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', '..', '..', '..', 'plugins', 'model-apps', 'references', 'rules.md'), 'utf8').replace(/\r\n/g, '\n');
const SECTION = RULES.slice(RULES.indexOf('\n### 2. Missing Error Handling\n'), RULES.indexOf('\n### 3. '));
const BLOCKS = [...SECTION.matchAll(/```tsx\n([\s\S]*?)\n```/g)].map((match) => match[1]);
const FOUNDATION = BLOCKS.find((block) => /\bfunction reportPageError\(/.test(block));
const TELEMETRY = BLOCKS.find((block) => /appInsights\?\.trackException\?\.\(/.test(block));
const lines = FOUNDATION.split('\n');
const anchor = lines.findIndex((line) => /^\s*console\.error\(/.test(line));
const WITH_TELEMETRY = [...lines.slice(0, anchor + 1), ...TELEMETRY.split('\n'), ...lines.slice(anchor + 1)].join('\n');
const BODY_AT = WITH_TELEMETRY.indexOf('function PageBody(');
const WRAPPER_AT = WITH_TELEMETRY.indexOf('const GeneratedComponent = ');

// The request helper sits INSIDE PageBody so it closes over the page's authorized appInsights prop: the seventh argument
// is then the only appInsights mention in the helper and its handler.
const AUTHORIZED = `${WITH_TELEMETRY.slice(0, BODY_AT)}type BuiltInResult = { ok: boolean; outputs?: Record<string, unknown>; error?: { message?: string; code?: string; status?: number } };
type BuiltInApi = { executeFunction?: (request: { name: string }) => Promise<BuiltInResult> };
type IdentityView = { identity?: { userId: string; businessUnitId: string; organizationId: string }; error?: PageErrorView };

const GUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function ownString(outputs: Record<string, unknown>, field: string): string | undefined {
  const value = Object.prototype.hasOwnProperty.call(outputs, field) ? outputs[field] : undefined;
  return typeof value === 'string' ? value : undefined;
}

function PageBody(props: GeneratedComponentProps & { appInsights?: PageErrorTelemetry }) {
  const { dataApi, appInsights } = props;
  const api = dataApi as unknown as BuiltInApi;
  const mounted = React.useRef(true);
  React.useEffect(() => () => { mounted.current = false; }, []);
  const [identityState, setIdentityState] = React.useState<{ pending: boolean; view: IdentityView }>({ pending: false, view: {} });
  const identityRequest = React.useRef(0);

  async function readIdentity(client: BuiltInApi): Promise<IdentityView> {
    if (typeof client.executeFunction !== 'function') {
      const view = reportPageError(PAGE_NAME, 'showIdentity', undefined, 'executeFunction is not available in this player', 'read');
      view.fallbackKey = 'error.builtinUnsupported';
      return { error: view };
    }
    try {
      const res = await client.executeFunction({ name: 'WhoAmI' });
      if (res.ok !== true) {
        const view = reportPageError(PAGE_NAME, 'showIdentity', res.error?.code, res.error?.message, 'read', undefined, appInsights);
        const unavailable = typeof res.error?.status === 'number' && res.error.status === 404;
        view.fallbackKey = unavailable ? 'error.builtinUnavailable' : 'error.builtinFailed';
        view.message = unavailable ? '' : view.message;
        return { error: view };
      }
      const outputs = res.outputs;
      if (!outputs || typeof outputs !== 'object' || Array.isArray(outputs)) {
        const view = reportPageError(PAGE_NAME, 'showIdentity', undefined, 'WhoAmI returned no output object', 'read');
        view.fallbackKey = 'error.builtinUnexpected';
        view.message = '';
        return { error: view };
      }
      const userId = ownString(outputs, 'UserId');
      const businessUnitId = ownString(outputs, 'BusinessUnitId');
      const organizationId = ownString(outputs, 'OrganizationId');
      if (![userId, businessUnitId, organizationId].every((id) => typeof id === 'string' && GUID.test(id))) {
        const view = reportPageError(PAGE_NAME, 'showIdentity', undefined, 'WhoAmI returned an unexpected identity', 'read');
        view.fallbackKey = 'error.builtinUnexpected';
        view.message = '';
        return { error: view };
      }
      return { identity: { userId: userId as string, businessUnitId: businessUnitId as string, organizationId: organizationId as string } };
    } catch (error) {
      const view = reportPageError(PAGE_NAME, 'showIdentity', undefined, error, 'read');
      view.fallbackKey = 'error.builtinFailed';
      view.message = '';
      return { error: view };
    }
  }

  const showIdentity = async () => {
    if (identityState.pending) return;
    const requestId = ++identityRequest.current;
    setIdentityState({ pending: true, view: {} });
    try {
      const view = await readIdentity(api);
      if (mounted.current && requestId === identityRequest.current) setIdentityState({ pending: false, view });
    } catch (error) {
      if (mounted.current && requestId === identityRequest.current) setIdentityState({ pending: false, view: { error: reportPageError(PAGE_NAME, 'showIdentity', undefined, error, 'read') } });
    }
  };

  return (
    <div>
      <Button disabled={identityState.pending} onClick={() => void showIdentity()}>Show my Dataverse identity</Button>
      <PageErrorBar error={identityState.view.error ?? null} />
      {identityState.view.identity && <Text>Dataverse user id: {identityState.view.identity.userId}</Text>}
    </div>
  );
}

${WITH_TELEMETRY.slice(WRAPPER_AT)}`;

function swap(source, from, to) {
  assert.ok(source.includes(from), `the page holds: ${from}`);
  return source.split(from).join(to);
}

test('a built-in failure report that hands the page\'s appInsights to the reporter is refused, however it is written', () => {
  const report = "reportPageError(PAGE_NAME, 'showIdentity', res.error?.code, res.error?.message, 'read', undefined, appInsights);";
  for (const [label, source] of [
    ['the canonical read report with the telemetry argument', AUTHORIZED],
    ['a direct emission beside the report', swap(AUTHORIZED, report, `${report}\n        appInsights?.trackException?.(new Error('x'));`)],
    ['the identity as the message', swap(AUTHORIZED, report, "reportPageError(PAGE_NAME, 'showIdentity', res.error?.code, String(res.outputs?.UserId), 'read', undefined, appInsights);")],
    ['a retry beside the telemetry', swap(AUTHORIZED, report, "reportPageError(PAGE_NAME, 'showIdentity', res.error?.code, res.error?.message, 'read', showIdentity, appInsights);")],
    ['an altered reporter', swap(AUTHORIZED, "    normalizedMessage = line.length > 300 ? line.slice(0, 299) + '\\u2026' : line;", '    normalizedMessage = line;')],
    // Record data dressed as host diagnostics: an awaited object built by the page, reported as if the host had returned it.
    ['diagnostics fabricated from an awaited page value', swap(AUTHORIZED,
      "      const view = reportPageError(PAGE_NAME, 'showIdentity', undefined, error, 'read');",
      "      const fault = await Promise.resolve({ error: { code: 'not_permitted', message: String(props.pageInput?.recordId) } });\n      const view = reportPageError(PAGE_NAME, 'showIdentity', fault.error?.code, fault.error?.message, 'read', undefined, appInsights);")],
  ]) {
    assert.ok(union.builtInRuntimeProblems(source, ['WhoAmI']).some((problem) => /logged, stored, copied or sent/.test(problem)), label);
  }
});

// Under the canonical wrapper the page renders in PageBody, not in the default export, so a call made while PageBody renders is named for
// what it is — not as PageBody being "handed" to the wrapper that renders it.
test('a built-in call made while the wrapped PageBody renders is refused as a render-time call', () => {
  const wrapped = swap(AUTHORIZED, "res.error?.message, 'read', undefined, appInsights);", "res.error?.message, 'read');");
  assert.deepEqual(union.builtInRuntimeProblems(wrapped, ['WhoAmI']), [], 'neighbour: the wrapped page without the call passes');
  const rendering = swap(wrapped, '  return (\n    <div>\n      <Button disabled={identityState.pending}', '  void readIdentity(api);\n  return (\n    <div>\n      <Button disabled={identityState.pending}');
  const found = union.builtInRuntimeProblems(rendering, ['WhoAmI']);
  assert.ok(found.some((problem) => /while the page renders/.test(problem)), JSON.stringify(found));
});
