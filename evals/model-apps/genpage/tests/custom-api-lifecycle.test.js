'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadFixtures } = require('../lib/fixture-loader.js');
const { PHASE_EXPECTATIONS, WORKFLOW_ASSERTIONS } = require('../lib/assertions-layer-1.js');
const { PHASE5_EXPECTATIONS } = require('../lib/assertions-layer-2.js');
const { actionCalls, receiverIsDataApi } = require('../lib/source-evidence.js');

const RULE = 'Phase 5: Custom API discovery, gate, bare bindings, runtime calls and update preservation or explicit clear agree';
const bindings = [
  { name: 'cnt_ApproveOrder', isFunction: false, boundEntityLogicalName: 'salesorder', displayName: 'Approve Order', parameterKinds: { Comment: 'String', Amount: 'Decimal' } },
  { name: 'cnt_GetOrderSummary', isFunction: true, displayName: 'Summary', parameterKinds: { OrderId: 'Guid' } },
];
const source = `
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
async function readSummary(api: ActionApi, recordId: string) {
  if (typeof api.executeFunction !== 'function') return;
  const res = await api.executeFunction({ name: 'cnt_GetOrderSummary', parameters: { OrderId: recordId } });
  if (!res.ok) { setError(res.error?.message ?? 'Summary failed.'); return; }
  setTotal(res.outputs?.Total);
}
const GeneratedComponent = (props: Props) => {
  const { dataApi } = props;
  const pending = { current: false };
  void approveOrder(dataApi, 'record', 1, pending);
  void readSummary(dataApi, 'record');
  return null;
};
export default GeneratedComponent;
`;
const cleared = 'const GeneratedComponent = () => null;\nexport default GeneratedComponent;\n';

function apiFixture() {
  const populated = JSON.stringify({ actionBindings: bindings });
  return {
    contractVersion: 2,
    files: [{ name: 'page.tsx', content: cleared }],
    artifacts: {
      'stages/with-api.tsx': source, 'actions.json': JSON.stringify(bindings), 'empty-actions.json': '[]',
      'created/config.json': populated, 'preserved/config.json': populated, 'cleared/config.json': '{"actionBindings":[]}',
    },
    genpagePlan: `## Custom API Bindings
| Name | Kind | Bound Entity | Display Name | Parameters (name: kind) |
|------|------|--------------|--------------|-------------------------|
| cnt_ApproveOrder | Action | salesorder | Approve Order | Comment: String, Amount: Decimal |
| cnt_GetOrderSummary | Function | (Global) | Summary | OrderId: Guid |
`,
    workflowLog: 'Custom API lifecycle, latest enabled gate before each generation and upload.',
    manifest: {
      customApi: {
        outputs: { cnt_ApproveOrder: ['NewStatus'], cnt_GetOrderSummary: ['Total'] },
        stages: [
          { id: 'create', target: 'page.tsx', source: 'stages/with-api.tsx', actions: 'actions.json', afterConfig: 'created/config.json', upload: 'create' },
          { id: 'preserve', target: 'page.tsx', source: 'stages/with-api.tsx', beforeConfig: 'created/config.json', afterConfig: 'preserved/config.json', upload: 'preserve' },
          { id: 'clear', target: 'page.tsx', source: 'page.tsx', actions: 'empty-actions.json', beforeConfig: 'preserved/config.json', afterConfig: 'cleared/config.json', upload: 'clear', change: { clear: true } },
        ],
      },
    },
    events: [
      { id: 'gate-create', command: 'node feature-flags.js custom-api', result: 'enabled' },
      { id: 'discovery', command: 'node list-custom-apis.js https://contoso.crm.dynamics.com --entities salesorder', result: { ok: true, customApis: structuredClone(bindings).map((binding) => ({ ...binding, bindingType: binding.boundEntityLogicalName ? 'Entity' : 'Global' })) } },
      { id: 'gate-generate', command: 'node feature-flags.js custom-api', result: 'enabled' },
      { id: 'write-create', command: 'Write page.tsx', artifact: 'stages/with-api.tsx' },
      { id: 'create', command: 'node genpage-upload.js --code-file page.tsx --actions actions.json --add-to-sitemap', result: { ok: true, pageId: '99999999-9999-4999-8999-999999999999' } },
      { id: 'gate-preserve', command: 'node feature-flags.js custom-api', result: 'enabled' },
      { id: 'write-preserve', command: 'Write page.tsx', artifact: 'stages/with-api.tsx' },
      { id: 'preserve', command: 'node genpage-upload.js --page-id 99999999-9999-4999-8999-999999999999 --code-file page.tsx', result: { ok: true, pageId: '99999999-9999-4999-8999-999999999999' } },
      { id: 'gate-clear', command: 'node feature-flags.js custom-api', result: 'enabled' },
      { id: 'write-clear', command: 'Write page.tsx', artifact: 'page.tsx' },
      { id: 'clear', command: 'node genpage-upload.js --page-id 99999999-9999-4999-8999-999999999999 --code-file page.tsx --actions empty-actions.json', result: { ok: true, pageId: '99999999-9999-4999-8999-999999999999' } },
    ],
  };
}

const event = (fixture, id) => fixture.events.find((call) => call.id === id);

function score(fixture, layer = 1) {
  const map = layer === 1 ? PHASE_EXPECTATIONS : PHASE5_EXPECTATIONS;
  const check = map.get(RULE);
  assert.equal(typeof check, 'function', `Custom API lifecycle scorer must exist in layer ${layer}`);
  return check({ fixture, files: fixture.files, eval: { id: 24 } });
}

test('custom API gate and bindings match generated runtime calls', () => {
  const good = apiFixture();
  for (const layer of [1, 2]) assert.equal(score(good, layer).status, 'pass');
  for (const mutate of [
    (fixture) => { event(fixture, 'gate-create').result = 'disabled'; },
    (fixture) => { event(fixture, 'gate-preserve').result = 'unreadable'; },
    (fixture) => { event(fixture, 'discovery').result.ok = false; },
    (fixture) => { event(fixture, 'discovery').result.customApis[0].parameterKinds.Amount = 'Boolean'; },
    (fixture) => { fixture.artifacts['actions.json'] = JSON.stringify({ actionBindings: bindings }); },
    (fixture) => { const rows = JSON.parse(fixture.artifacts['actions.json']); rows[0].name = 'cnt_Invented'; fixture.artifacts['actions.json'] = JSON.stringify(rows); },
    (fixture) => { fixture.artifacts['stages/with-api.tsx'] = source.replace('api.executeAction({', 'api.executeFunction({'); },
    (fixture) => { fixture.artifacts['stages/with-api.tsx'] = source.replace("Comment: 'Approved'", "Commet: 'Approved'"); },
    (fixture) => { fixture.artifacts['stages/with-api.tsx'] = source.replace('Amount: amount', "Amount: 'wrong type'"); },
    (fixture) => { fixture.artifacts['stages/with-api.tsx'] = source.replace("entityName: 'salesorder'", "entityName: 'account'"); },
    (fixture) => { fixture.artifacts['stages/with-api.tsx'] = source.replace('parameters: { OrderId: recordId }', "parameters: { OrderId: recordId }, boundTo: { entityName: 'salesorder', id: recordId }"); },
    (fixture) => { fixture.artifacts['stages/with-api.tsx'] = source.replace('id: recordId', 'id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"'); },
    (fixture) => { fixture.artifacts['stages/with-api.tsx'] = source.replace('id: recordId', 'id: amount'); },
  ]) {
    const bad = apiFixture();
    mutate(bad);
    for (const layer of [1, 2]) assert.equal(score(bad, layer).status, 'fail');
  }
});

test('Custom API response handling is scoped, sanitized and never auto-retries indeterminate actions', () => {
  assert.equal(score(apiFixture()).status, 'pass');
  for (const mutate of [
    (text) => text.replace("if (typeof api.executeAction !== 'function') return;", ''),
    (text) => text.replace('pending.current = true;', ''),
    (text) => text.replace('if (pending.current || !recordId) return;', ''),
    (text) => text.replace('if (!res.ok)', 'if (false)'),
    (text) => text.replace('res.outputs', 'res.value'),
    (text) => text.replace('res.error?.message', 'res.error?.stack'),
    (text) => text.replace('res.outputs?.NewStatus', 'res.outputs?.Undeclared'),
    (text) => text.replace("setError('Refresh before retrying.'); return;", 'return approveOrder(api, recordId, amount, pending);'),
  ]) {
    const bad = apiFixture();
    bad.artifacts['stages/with-api.tsx'] = mutate(source) + '\n// res.ok; res.outputs; typeof api.executeAction; pending.current = true;\n';
    assert.equal(score(bad).status, 'fail');
  }
});

test('Custom API calls and their presence checks must use the page dataApi prop', () => {
  assert.equal(score(apiFixture()).status, 'pass');
  const other = 'const other = { executeAction: async () => ({ ok: true }), executeFunction: async () => ({ ok: true }) };\n';
  for (const [label, mutate, reason] of [
    ['call on an unrelated object', (text) => other + text.replace('await api.executeAction({', 'await other.executeAction({'), /called on other, which is not the page's dataApi prop/],
    ['call and presence check both on an unrelated object', (text) => other + text.replace('await api.executeAction({', 'await other.executeAction({').replace('typeof api.executeAction', 'typeof other.executeAction'), /called on other, which is not the page's dataApi prop/],
    ['presence check on an unrelated object', (text) => other + text.replace('typeof api.executeAction', 'typeof other.executeAction'), /not presence-checked on the same receiver/],
    ['helper filled with an unrelated object', (text) => other + text.replace('approveOrder(dataApi,', 'approveOrder(other,'), /called on api, which is not the page's dataApi prop/],
    ['helper never called with the prop', (text) => text.replace("void approveOrder(dataApi, 'record', 1, pending);", ''), /called on api, which is not the page's dataApi prop/],
  ]) {
    const bad = apiFixture();
    bad.artifacts['stages/with-api.tsx'] = mutate(source);
    const result = score(bad);
    assert.equal(result.status, 'fail', label);
    assert.match(result.reason, reason, label);
  }
});

test('Custom API bindings preserve omission and only an explicit empty array clears', () => {
  assert.equal(score(apiFixture()).status, 'pass');
  for (const mutate of [
    (fixture) => { fixture.artifacts['preserved/config.json'] = '{"actionBindings":[]}'; },
    (fixture) => { event(fixture, 'preserve').command += ' --actions empty-actions.json'; },
    (fixture) => { event(fixture, 'clear').command = event(fixture, 'clear').command.replace(' --actions empty-actions.json', ''); },
    (fixture) => { fixture.artifacts['empty-actions.json'] = '{"actionBindings":[]}'; },
    (fixture) => { fixture.artifacts['cleared/config.json'] = JSON.stringify({ actionBindings: bindings }); },
    (fixture) => { fixture.files[0].content = source; },
  ]) {
    const bad = apiFixture();
    mutate(bad);
    assert.equal(score(bad).status, 'fail');
  }
});

function lookupFixture({ isOptional = false, supplied = true } = {}) {
  const fixture = apiFixture();
  event(fixture, 'discovery').result.customApis[0].lookupParameters = {
    Ref: { isOptional, logicalEntityName: 'salesorder' },
  };
  fixture.genpagePlan += '\nLookup inputs (discovery-only): cnt_ApproveOrder.Ref '
    + `is ${isOptional ? 'optional' : 'required'}; use { entityName: 'salesorder', id: recordId } `
    + 'from the existing page record, never a declared parameter kind in actions.json.\n';
  if (supplied) {
    fixture.artifacts['stages/with-api.tsx'] = source.replace(
      "parameters: { Comment: 'Approved', Amount: amount }",
      "parameters: { Ref: { entityName: 'salesorder', id: recordId }, Comment: 'Approved', Amount: amount }"
    );
  }
  return fixture;
}

test('Custom API lookup inputs are structural while authored bindings remain primitive-only', () => {
  const fixture = lookupFixture();
  for (const layer of [1, 2]) {
    const result = score(fixture, layer);
    assert.equal(result.status, 'pass', result.reason);
  }
  assert.deepEqual(JSON.parse(fixture.artifacts['actions.json']), bindings);
  for (const file of ['created/config.json', 'preserved/config.json']) {
    assert.deepEqual(JSON.parse(fixture.artifacts[file]).actionBindings, bindings);
  }
});

test('a required discovered lookup input cannot silently disappear from the generated call', () => {
  const fixture = lookupFixture({ supplied: false });
  for (const layer of [1, 2]) {
    const result = score(fixture, layer);
    assert.equal(result.status, 'fail', 'the discovery-only lookup name is still a required call input');
    assert.match(result.reason, /lookup|Ref/i);
  }
});

test('an optional discovered lookup may be omitted or supplied in its structural shape', () => {
  for (const supplied of [false, true]) {
    const fixture = lookupFixture({ isOptional: true, supplied });
    const result = score(fixture);
    assert.equal(result.status, 'pass', result.reason);
  }
});

test('lookup inputs must use the discovered table and an existing record rather than a primitive or invented id', () => {
  for (const replacement of [
    'recordId',
    "{ entityName: 'account', id: recordId }",
    "{ entityName: 'salesorder' }",
    "{ entityName: 'salesorder', id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }",
    "{ entityName: 'salesorder', id: amount }",
    "{ entityName: 'salesorder', id: recordId, name: 'Invented' }",
    'null',
  ]) {
    const fixture = lookupFixture();
    fixture.artifacts['stages/with-api.tsx'] = fixture.artifacts['stages/with-api.tsx']
      .replace("Ref: { entityName: 'salesorder', id: recordId }", `Ref: ${replacement}`);
    const result = score(fixture);
    assert.equal(result.status, 'fail', replacement);
    assert.match(result.reason, /lookup|Ref/i);
  }
});

test('disabled or unreadable Custom API gates refuse before generation, not as a no-bindings fallback', () => {
  for (const result of ['disabled', 'unknown', null]) {
    const stopped = apiFixture();
    stopped.events = [{ ...stopped.events[0], result }];
    stopped.files = [];
    stopped.manifest.expectedOutcome = 'refused';
    stopped.manifest.refusal = { stage: 'custom-api' };
    stopped.workflowLog = 'Halted before generation: turn the feature back on or re-plan; the gate is disabled or unreadable.';
    assert.equal(score(stopped).status, 'pass', String(result));
    stopped.events.push({ command: 'Write page.tsx', artifact: 'stages/with-api.tsx' });
    assert.equal(score(stopped).status, 'fail');
  }
});

test('Custom API generation re-probes after discovery rather than borrowing the planning gate', () => {
  const good = apiFixture();
  assert.equal(score(good).status, 'pass');
  good.events = good.events.filter((call) => call.id !== 'gate-generate');
  assert.equal(score(good).status, 'fail');
});

test('a populated plan cannot continue the audit disabled-gate probe', () => {
  const captured = loadFixtures(path.join(__dirname, '..', 'fixtures')).find((fixture) => fixture.id === 17);
  const plan = captured.genpagePlan.replace('No custom API bindings.', apiFixture().genpagePlan.split('## Custom API Bindings\n')[1].trim());
  const text = [...WORKFLOW_ASSERTIONS.keys()].find((key) => key.startsWith('Phase 4.6: A populated Custom API plan'));
  const check = WORKFLOW_ASSERTIONS.get(text);
  const disabled = { ...captured, genpagePlan: plan, workflowLog: 'node feature-flags.js custom-api -> disabled\n' + captured.workflowLog };
  assert.equal(check({ fixture: disabled }).status, 'fail');
  const enabled = { ...disabled, workflowLog: 'node feature-flags.js custom-api -> enabled\n' + captured.workflowLog };
  assert.equal(check({ fixture: enabled }).status, 'pass');
});

function selectedRecordLookupFixture(memberType = 'string') {
  const fixture = lookupFixture();
  event(fixture, 'discovery').result.customApis[0].lookupParameters.Ref.logicalEntityName = 'account';
  fixture.genpagePlan = fixture.genpagePlan
    .replace("entityName: 'salesorder', id: recordId", "entityName: 'account', id: selectedAccount.accountid");
  fixture.artifacts['stages/with-api.tsx'] = fixture.artifacts['stages/with-api.tsx']
    .replace('pending: Pending)', `pending: Pending, selectedAccount: { accountid: ${memberType} })`)
    .replace("Ref: { entityName: 'salesorder', id: recordId }",
      "Ref: { entityName: 'account', id: selectedAccount.accountid }")
    .replace("approveOrder(dataApi, 'record', 1, pending)", "approveOrder(dataApi, 'record', 1, pending, props.selectedAccount)");
  return fixture;
}

test('selected-record member lookup IDs with a proven string input pass both evaluator layers', () => {
  const fixture = selectedRecordLookupFixture();
  for (const layer of [1, 2]) {
    const result = score(fixture, layer);
    assert.equal(result.status, 'pass', result.reason);
  }
});

test('selected-record member lookup IDs retain type provenance table and shape refusals', async (t) => {
  for (const [label, mutate] of [
    ['numeric member', (fixture) => {
      fixture.artifacts['stages/with-api.tsx'] = fixture.artifacts['stages/with-api.tsx']
        .replace('accountid: string', 'accountid: number');
    }],
    ['unknown member type', (fixture) => {
      fixture.artifacts['stages/with-api.tsx'] = fixture.artifacts['stages/with-api.tsx']
        .replace('selectedAccount: { accountid: string }', 'selectedAccount: SelectedAccount');
    }],
    ['unproven member name', (fixture) => {
      fixture.artifacts['stages/with-api.tsx'] = fixture.artifacts['stages/with-api.tsx']
        .replace('id: selectedAccount.accountid', 'id: selectedAccount.unprovenid');
    }],
    ['arbitrary member chain', (fixture) => {
      fixture.artifacts['stages/with-api.tsx'] = fixture.artifacts['stages/with-api.tsx']
        .replace('id: selectedAccount.accountid', 'id: selectedAccount.owner.accountid');
    }],
    ['invented literal', (fixture) => {
      fixture.artifacts['stages/with-api.tsx'] = fixture.artifacts['stages/with-api.tsx']
        .replace('id: selectedAccount.accountid', "id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'");
    }],
    ['invented local record', (fixture) => {
      fixture.artifacts['stages/with-api.tsx'] = fixture.artifacts['stages/with-api.tsx']
        .replace(', selectedAccount: { accountid: string }', '')
        .replace(', pending, props.selectedAccount)', ', pending)')
        .replace("  if (typeof api.executeAction", "  const selectedAccount: { accountid: string } = { accountid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' };\n  if (typeof api.executeAction");
    }],
    ['invented caller record', (fixture) => {
      fixture.artifacts['stages/with-api.tsx'] = fixture.artifacts['stages/with-api.tsx']
        .replace(', pending, props.selectedAccount)', ", pending, { accountid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' })");
    }],
    ['mixed record provenance across callers', (fixture) => {
      fixture.artifacts['stages/with-api.tsx'] = fixture.artifacts['stages/with-api.tsx']
        .replace("  void readSummary(dataApi, 'record');",
          "  void approveOrder(dataApi, 'record', 1, pending, { accountid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });\n  void readSummary(dataApi, 'record');");
    }],
    ['wrong table', (fixture) => {
      fixture.artifacts['stages/with-api.tsx'] = fixture.artifacts['stages/with-api.tsx']
        .replace("Ref: { entityName: 'account'", "Ref: { entityName: 'contact'");
    }],
    ['wrong structural shape', (fixture) => {
      fixture.artifacts['stages/with-api.tsx'] = fixture.artifacts['stages/with-api.tsx']
        .replace("Ref: { entityName: 'account', id: selectedAccount.accountid }",
          "Ref: { entityName: 'account', id: selectedAccount.accountid, name: 'Invented' }");
    }],
  ]) {
    await t.test(`selected-record member: ${label}`, () => {
      const fixture = selectedRecordLookupFixture();
      mutate(fixture);
      for (const layer of [1, 2]) {
        const result = score(fixture, layer);
        assert.equal(result.status, 'fail', label);
        assert.match(result.reason, /lookup|Ref/i, label);
      }
    });
  }
});

function privateBeforePublicAddFixture() {
  const fixture = apiFixture();
  const existing = { ...structuredClone(bindings[0]), name: 'cnt_ExistingPrivate', displayName: 'Existing Private' };
  const added = structuredClone(bindings[1]);
  const desired = [existing, added];
  const editedSource = source.replaceAll('cnt_ApproveOrder', existing.name);
  fixture.files = [{ name: 'page.tsx', content: editedSource }];
  fixture.artifacts = {
    'stages/edited.tsx': editedSource,
    'actions.json': JSON.stringify(desired),
    'before/config.json': JSON.stringify({ actionBindings: [existing] }),
    'after/config.json': JSON.stringify({ actionBindings: desired }),
    'before/page.json': JSON.stringify({
      pageId: '99999999-9999-4999-8999-999999999999',
      appId: '11111111-1111-4111-8111-111111111111',
      name: 'Owned API Page', navigationTitle: 'Owned API Page',
    }),
    'after/page.json': JSON.stringify({
      pageId: '99999999-9999-4999-8999-999999999999',
      appId: '11111111-1111-4111-8111-111111111111',
      name: 'Owned API Page', navigationTitle: 'Owned API Page',
    }),
  };
  fixture.genpagePlan = `## Custom API Bindings
| Name | Kind | Bound Entity | Display Name | Parameters (name: kind) |
|------|------|--------------|--------------|-------------------------|
| ${existing.name} | Action | salesorder | Existing Private | Comment: String, Amount: Decimal |
| ${added.name} | Function | (Global) | Summary | OrderId: Guid |
`;
  fixture.workflowLog = 'Edit adds a discovered public API and preserves the downloaded private binding exactly.';
  fixture.manifest.customApi = {
    outputs: { [existing.name]: ['NewStatus'], [added.name]: ['Total'] },
    stages: [{
      id: 'edit', target: 'page.tsx', source: 'stages/edited.tsx', actions: 'actions.json',
      beforeConfig: 'before/config.json', afterConfig: 'after/config.json', upload: 'edit',
      change: { add: [added] },
    }],
  };
  // Use the shared upload identity fields to tie the before blob to this update, independently
  // of whether its binding values happen to be equal to the desired array.
  fixture.manifest.uploads = [{
    event: 'edit', mode: 'update', beforeConfig: 'before/config.json', beforePage: 'before/page.json',
    afterConfig: 'after/config.json', afterPage: 'after/page.json',
  }];
  fixture.events = [
    { id: 'gate-discover', command: 'node feature-flags.js custom-api', result: 'enabled' },
    { id: 'download', command: 'node genpage.js download --env https://contoso.crm.dynamics.com --app-id 11111111-1111-4111-8111-111111111111 --page-id 99999999-9999-4999-8999-999999999999 --output-directory before',
      result: { ok: true, pages: [{ pageId: '99999999-9999-4999-8999-999999999999' }] } },
    { id: 'discovery', command: 'node list-custom-apis.js https://contoso.crm.dynamics.com --entities salesorder',
      result: { ok: true, customApis: [{ ...added, bindingType: 'Global' }] } },
    { id: 'gate-generate', command: 'node feature-flags.js custom-api', result: 'enabled' },
    { id: 'write-edit', command: 'Write page.tsx', artifact: 'stages/edited.tsx' },
    { id: 'edit', command: 'node genpage-upload.js --env https://contoso.crm.dynamics.com --app-id 11111111-1111-4111-8111-111111111111 --page-id 99999999-9999-4999-8999-999999999999 --code-file page.tsx --actions actions.json',
      result: { ok: true, pageId: '99999999-9999-4999-8999-999999999999', appId: '11111111-1111-4111-8111-111111111111' } },
  ];
  return fixture;
}

test('pre-existing private bindings are exact preservation evidence when a public API is added', () => {
  const fixture = privateBeforePublicAddFixture();
  for (const layer of [1, 2]) {
    const result = score(fixture, layer);
    assert.equal(result.status, 'pass', result.reason);
  }
});

test('pre-existing binding preservation never authorizes dropping changing or undiscovered additions', async (t) => {
  for (const [label, mutate] of [
    ['old binding dropped', (fixture) => {
      const rows = JSON.parse(fixture.artifacts['actions.json']).slice(1);
      fixture.artifacts['actions.json'] = JSON.stringify(rows);
      fixture.artifacts['after/config.json'] = JSON.stringify({ actionBindings: rows });
    }],
    ['old primitive contract changed', (fixture) => {
      const rows = JSON.parse(fixture.artifacts['actions.json']);
      rows[0].parameterKinds.Amount = 'Integer';
      fixture.artifacts['actions.json'] = JSON.stringify(rows);
      fixture.artifacts['after/config.json'] = JSON.stringify({ actionBindings: rows });
    }],
    ['old method changed together with the call', (fixture) => {
      const rows = JSON.parse(fixture.artifacts['actions.json']);
      rows[0].isFunction = true;
      fixture.artifacts['actions.json'] = JSON.stringify(rows);
      fixture.artifacts['after/config.json'] = JSON.stringify({ actionBindings: rows });
      fixture.manifest.customApi.stages[0].change.add.push(rows[0]);
      fixture.genpagePlan = fixture.genpagePlan.replace('| cnt_ExistingPrivate | Action |', '| cnt_ExistingPrivate | Function |');
      const nextSource = fixture.artifacts['stages/edited.tsx'].replaceAll('api.executeAction', 'api.executeFunction');
      fixture.artifacts['stages/edited.tsx'] = nextSource;
      fixture.files[0].content = nextSource;
    }],
    ['before-config provenance absent', (fixture) => {
      delete fixture.manifest.customApi.stages[0].beforeConfig;
    }],
    ['explicit re-addition of the private binding', (fixture) => {
      const existing = JSON.parse(fixture.artifacts['before/config.json']).actionBindings[0];
      fixture.manifest.customApi.stages[0].change.add.push(existing);
    }],
    ...[
      ['parameterKinds', ['String']],
      ['isFunction', 'false'],
      ['displayName', 7],
      ['boundEntityLogicalName', 7],
    ].map(([field, value]) => [`malformed before ${field}`, (fixture) => {
      const before = JSON.parse(fixture.artifacts['before/config.json']);
      before.actionBindings[0][field] = value;
      fixture.artifacts['before/config.json'] = JSON.stringify(before);
      const rows = JSON.parse(fixture.artifacts['actions.json']);
      rows[0][field] = value;
      fixture.artifacts['actions.json'] = JSON.stringify(rows);
      fixture.artifacts['after/config.json'] = JSON.stringify({ actionBindings: rows });
    }]),
    ['new public binding not discovered', (fixture) => {
      event(fixture, 'discovery').result.customApis = [];
    }],
    ['new private binding not discovered', (fixture) => {
      const extra = { name: 'cnt_NewPrivateSummary', isFunction: true, displayName: 'New Private', parameterKinds: { OrderId: 'Guid' } };
      fixture.manifest.customApi.stages[0].change.add.push(extra);
      fixture.manifest.customApi.outputs[extra.name] = ['Total'];
      const rows = JSON.parse(fixture.artifacts['actions.json']);
      rows.push(extra);
      fixture.artifacts['actions.json'] = JSON.stringify(rows);
      fixture.artifacts['after/config.json'] = JSON.stringify({ actionBindings: rows });
      fixture.genpagePlan += `| ${extra.name} | Function | (Global) | New Private | OrderId: Guid |\n`;
      const start = source.indexOf('async function readSummary');
      const end = source.indexOf('const GeneratedComponent');
      const helper = source.slice(start, end)
        .replaceAll('readSummary', 'readPrivateSummary')
        .replaceAll('cnt_GetOrderSummary', extra.name);
      const nextSource = fixture.artifacts['stages/edited.tsx']
        .replace('const GeneratedComponent', helper + 'const GeneratedComponent')
        .replace("  void readSummary(dataApi, 'record');", "  void readSummary(dataApi, 'record');\n  void readPrivateSummary(dataApi, 'record');");
      fixture.artifacts['stages/edited.tsx'] = nextSource;
      fixture.files[0].content = nextSource;
    }],
    ['disabled gate', (fixture) => { event(fixture, 'gate-generate').result = 'disabled'; }],
    ['changed method on the existing operation', (fixture) => {
      const nextSource = fixture.artifacts['stages/edited.tsx'].replace('await api.executeAction({', 'await api.executeFunction({');
      fixture.artifacts['stages/edited.tsx'] = nextSource;
      fixture.files[0].content = nextSource;
    }],
  ]) {
    await t.test(`pre-existing binding preservation: ${label}`, () => {
      const fixture = privateBeforePublicAddFixture();
      mutate(fixture);
      for (const layer of [1, 2]) {
        const result = score(fixture, layer);
        assert.equal(result.status, 'fail', label);
        if (label === 'old method changed together with the call') assert.match(result.reason, /discovery|before-config/i);
      }
    });
  }
});

test('pre-existing private bindings can be removed only through an explicit clear intent', () => {
  const fixture = privateBeforePublicAddFixture();
  fixture.manifest.customApi.stages[0].change = { clear: true };
  fixture.artifacts['actions.json'] = '[]';
  fixture.artifacts['after/config.json'] = '{"actionBindings":[]}';
  fixture.artifacts['stages/edited.tsx'] = cleared;
  fixture.files[0].content = cleared;
  for (const layer of [1, 2]) {
    const result = score(fixture, layer);
    assert.equal(result.status, 'pass', result.reason);
  }
});

function assertKnownApiReceivers(code) {
  const calls = actionCalls(code);
  assert.ok(calls.length > 0);
  for (const call of calls) {
    assert.equal(receiverIsDataApi(call.mask, call.scopes, call.receiver, call.start), true,
      `${call.scope.name}: record-value evidence must not change the shared dataApi receiver proof`);
  }
}

test('lookup member value writes and source replacements cannot retain input provenance', async (t) => {
  const invented = "'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'";
  const helperWrite = (text, write) => text.replace("  if (typeof api.executeAction", `  ${write}\n  if (typeof api.executeAction`);
  const callerWrite = (text, write) => text.replace('  const pending = { current: false };', `  ${write}\n  const pending = { current: false };`);
  for (const [label, mutate] of [
    ['direct helper member write', (text) => helperWrite(text, `selectedAccount.accountid = ${invented};`)],
    ['computed helper member write', (text) => helperWrite(text, `selectedAccount['accountid'] = ${invented};`)],
    ['compound helper member write', (text) => helperWrite(text, "selectedAccount.accountid += 'invented';")],
    ['helper record alias member write', (text) => helperWrite(text, `const recordAlias = selectedAccount;\n  recordAlias.accountid = ${invented};`)],
    ['explicit record mutation call', (text) => helperWrite(text, `Object.assign(selectedAccount, { accountid: ${invented} });`)],
    ['recognized helper argument member write', (text) => helperWrite(text, 'replaceAccountId(selectedAccount);')
      .replace('const GeneratedComponent', `function replaceAccountId(record: { accountid: string }) {\n  record.accountid = ${invented};\n}\nconst GeneratedComponent`)],
    ['captured helper alias after parameter rebinding', (text) => helperWrite(text, 'replaceAccountId(selectedAccount);')
      .replace('const GeneratedComponent', `function replaceAccountId(record: { accountid: string }) {\n  const capturedRecord = record;\n  record = { accountid: 'other' };\n  capturedRecord.accountid = ${invented};\n}\nconst GeneratedComponent`)],
    ['rebound helper writer alias', (text) => helperWrite(text,
      `let recordAlias = { accountid: 'other' };\n  recordAlias = selectedAccount;\n  recordAlias.accountid = ${invented};`)],
    ['caller props record replacement', (text) => callerWrite(text, `props.selectedAccount = { accountid: ${invented} };`)],
    ['caller computed props replacement', (text) => callerWrite(text, `props['selectedAccount'] = { accountid: ${invented} };`)],
    ['caller props alias replacement', (text) => callerWrite(text, `const pageAlias = props;\n  pageAlias.selectedAccount = { accountid: ${invented} };`)],
    ['caller record alias member write', (text) => callerWrite(text, `const chosenAccount = props.selectedAccount;\n  chosenAccount.accountid = ${invented};`)
      .replace(', pending, props.selectedAccount)', ', pending, chosenAccount)')],
    ['caller destructured alias member write', (text) => callerWrite(text, `const { selectedAccount: chosenAccount } = props;\n  chosenAccount.accountid = ${invented};`)
      .replace(', pending, props.selectedAccount)', ', pending, chosenAccount)')],
    ['captured caller alias after rebinding', (text) => callerWrite(text,
      `let record = props.selectedAccount;\n  const capturedRecord = record;\n  record = { accountid: 'other' };\n  capturedRecord.accountid = ${invented};`)],
  ]) {
    await t.test(`lookup member value: ${label}`, () => {
      const fixture = selectedRecordLookupFixture();
      const code = mutate(fixture.artifacts['stages/with-api.tsx']);
      fixture.artifacts['stages/with-api.tsx'] = code;
      assertKnownApiReceivers(code);
      for (const layer of [1, 2]) {
        const result = score(fixture, layer);
        assert.equal(result.status, 'fail', `${label}, layer ${layer}`);
        assert.match(result.reason, /lookup|Ref|provenance/i, label);
      }
    });
  }
});

test('lookup member value positives retain unchanged inputs readonly aliases and receivers', async (t) => {
  for (const [label, declaration, argument] of [
    ['unchanged direct input', '', 'props.selectedAccount'],
    ['record alias', 'const chosenAccount = props.selectedAccount;', 'chosenAccount'],
    ['props alias', 'const pageAlias = props;', 'pageAlias.selectedAccount'],
    ['destructured record alias', 'const { selectedAccount: chosenAccount } = props;', 'chosenAccount'],
  ]) {
    await t.test(`lookup member value positive: ${label}`, () => {
      const fixture = selectedRecordLookupFixture();
      const code = fixture.artifacts['stages/with-api.tsx']
        .replace('  const pending = { current: false };', `  ${declaration}\n  const pending = { current: false };`)
        .replace(', pending, props.selectedAccount)', `, pending, ${argument})`);
      fixture.artifacts['stages/with-api.tsx'] = code;
      assertKnownApiReceivers(code);
      for (const layer of [1, 2]) {
        const result = score(fixture, layer);
        assert.equal(result.status, 'pass', result.reason);
      }
    });
  }
});

function updateIdentityArtifact(fixture, file, changes) {
  const value = JSON.parse(fixture.artifacts[file]);
  fixture.artifacts[file] = JSON.stringify({ ...value, ...changes });
}

test('before-page provenance cannot authorize a different page or a successful create', async (t) => {
  const otherPage = '22222222-2222-4222-8222-222222222222';
  for (const associated of [false, true]) {
    for (const mode of ['different update target', 'create']) {
      await t.test(`before-page provenance target: ${mode}, upload association=${associated}`, () => {
        const fixture = privateBeforePublicAddFixture();
        if (!associated) delete fixture.manifest.uploads;
        const upload = event(fixture, 'edit');
        if (mode === 'create') {
          upload.command = upload.command.replace(/ --page-id [0-9a-f-]+/, '') + ' --add-to-sitemap';
          if (associated) fixture.manifest.uploads[0].mode = 'create';
        } else {
          upload.command = upload.command.replace(/ --page-id [0-9a-f-]+/, ` --page-id ${otherPage}`);
        }
        upload.result.pageId = otherPage;
        updateIdentityArtifact(fixture, 'after/page.json', { pageId: otherPage });
        for (const layer of [1, 2]) {
          const result = score(fixture, layer);
          assert.equal(result.status, 'fail', `${mode}, layer ${layer}`);
          assert.match(result.reason, /before|page|identity|provenance|target|preserv|evidence/i);
        }
      });
    }
  }
});

test('before-page provenance stays associated with recorded context and cannot be ambiguous', async (t) => {
  const otherApp = '22222222-2222-4222-8222-222222222222';
  for (const [label, mutate] of [
    ['different recorded environment', (fixture) => {
      event(fixture, 'edit').command = event(fixture, 'edit').command
        .replace('https://contoso.crm.dynamics.com', 'https://example.crm.dynamics.com');
    }],
    ['different recorded app', (fixture) => {
      const upload = event(fixture, 'edit');
      upload.command = upload.command.replace(/ --app-id [0-9a-f-]+/, ` --app-id ${otherApp}`);
      upload.result.appId = otherApp;
      updateIdentityArtifact(fixture, 'after/page.json', { appId: otherApp });
    }],
    ['contradictory before-page identity', (fixture) => {
      updateIdentityArtifact(fixture, 'before/page.json', { pageId: '22222222-2222-4222-8222-222222222222' });
    }],
    ['renamed snapshots contradict the recorded download', (fixture) => {
      const pageId = '22222222-2222-4222-8222-222222222222';
      const upload = event(fixture, 'edit');
      upload.command = upload.command.replace(/ --page-id [0-9a-f-]+/, ` --page-id ${pageId}`);
      upload.result.pageId = pageId;
      updateIdentityArtifact(fixture, 'before/page.json', { pageId });
      updateIdentityArtifact(fixture, 'after/page.json', { pageId });
    }],
    ['download result contradicts the requested page', (fixture) => {
      event(fixture, 'download').result.pageId = '22222222-2222-4222-8222-222222222222';
    }],
    ['declared before-page evidence missing', (fixture) => {
      delete fixture.artifacts['before/page.json'];
    }],
    ['ambiguous upload evidence association', (fixture) => {
      fixture.manifest.uploads.push(structuredClone(fixture.manifest.uploads[0]));
    }],
    ['no download or upload identity association', (fixture) => {
      fixture.events = fixture.events.filter((call) => call.id !== 'download');
      delete fixture.manifest.uploads;
    }],
  ]) {
    await t.test(`before-page provenance context: ${label}`, () => {
      const fixture = privateBeforePublicAddFixture();
      mutate(fixture);
      for (const layer of [1, 2]) {
        const result = score(fixture, layer);
        assert.equal(result.status, 'fail', `${label}, layer ${layer}`);
        assert.match(result.reason, /before|page|identity|provenance|target|context|app|environment|download|evidence/i);
      }
    });
  }
});

test('before-page provenance keeps same-page private adds and explicit clear positives', () => {
  for (const clear of [false, true]) {
    const fixture = privateBeforePublicAddFixture();
    if (clear) {
      fixture.manifest.customApi.stages[0].change = { clear: true };
      fixture.artifacts['actions.json'] = '[]';
      fixture.artifacts['after/config.json'] = '{"actionBindings":[]}';
      fixture.artifacts['stages/edited.tsx'] = cleared;
      fixture.files[0].content = cleared;
    }
    for (const layer of [1, 2]) {
      const result = score(fixture, layer);
      assert.equal(result.status, 'pass', result.reason);
    }
  }
});

function separateRecordBindingsFixture(argument = "{ accountid: 'new draft' }") {
  const fixture = selectedRecordLookupFixture();
  fixture.artifacts['stages/with-api.tsx'] = fixture.artifacts['stages/with-api.tsx']
    .replace('const GeneratedComponent', `function editDraft(record: { accountid: string }) {
  record.accountid = 'draft';
}
const GeneratedComponent`)
    .replace('  const pending = { current: false };', `  let record = props.otherAccount;
  record = props.selectedAccount;
  void record.accountid;
  editDraft(${argument});
  const pending = { current: false };`);
  return fixture;
}

test('scoped assignment origin: unrelated helper parameter remains independent', async (t) => {
  for (const layer of [1, 2]) {
    await t.test(`scoped assignment origin: unrelated helper parameter, layer ${layer}`, () => {
      const fixture = separateRecordBindingsFixture();
      assertKnownApiReceivers(fixture.artifacts['stages/with-api.tsx']);
      const result = score(fixture, layer);
      assert.equal(result.status, 'pass', result.reason);
    });
  }
});

test('scoped assignment origin: actual input mutation is refused', async (t) => {
  for (const layer of [1, 2]) {
    await t.test(`scoped assignment origin: actual input mutation, layer ${layer}`, () => {
      const fixture = separateRecordBindingsFixture('props.selectedAccount');
      assertKnownApiReceivers(fixture.artifacts['stages/with-api.tsx']);
      const result = score(fixture, layer);
      assert.equal(result.status, 'fail', result.reason);
      assert.match(result.reason, /lookup|Ref|provenance/i);
    });
  }
});

test('scoped assignment origin: unmodeled outer alias writes remain refusals', async (t) => {
  for (const layer of [1, 2]) {
    await t.test(`scoped assignment origin: unmodeled outer alias write, layer ${layer}`, () => {
      const fixture = selectedRecordLookupFixture();
      const code = fixture.artifacts['stages/with-api.tsx']
        .replace('const GeneratedComponent', 'declare let writtenRecord: { accountid: string };\nconst GeneratedComponent')
        .replace('  const pending = { current: false };', `  writtenRecord = props.selectedAccount;
  writtenRecord.accountid = 'draft';
  const pending = { current: false };`);
      fixture.artifacts['stages/with-api.tsx'] = code;
      assertKnownApiReceivers(code);
      const result = score(fixture, layer);
      assert.equal(result.status, 'fail', result.reason);
      assert.match(result.reason, /lookup|Ref|provenance/i);
    });
  }
});

test('download result pages: empty present list cannot establish provenance', async (t) => {
  for (const layer of [1, 2]) {
    await t.test(`download result pages: empty present list, layer ${layer}`, () => {
      const fixture = privateBeforePublicAddFixture();
      event(fixture, 'download').result = { ok: true, pages: [] };
      const result = score(fixture, layer);
      assert.equal(result.status, 'fail', result.reason);
      assert.match(result.reason, /download|before|provenance|identity|evidence/i);
    });
  }
});

test('download result pages: unreadable list slots cannot establish provenance', async (t) => {
  for (const layer of [1, 2]) {
    await t.test(`download result pages: unreadable list slots, layer ${layer}`, () => {
      const fixture = privateBeforePublicAddFixture();
      const pages = [{ pageId: '99999999-9999-4999-8999-999999999999' }];
      // Direct object evidence can contain holes even though a JSON capture would encode null.
      pages.length = 2;
      event(fixture, 'download').result = { ok: true, pages };
      const result = score(fixture, layer);
      assert.equal(result.status, 'fail', result.reason);
      assert.match(result.reason, /download|before|provenance|identity|evidence/i);
    });
  }
});

test('download result pages: malformed or wrong identities cannot establish provenance', async (t) => {
  const pageId = '99999999-9999-4999-8999-999999999999';
  const otherPage = '22222222-2222-4222-8222-222222222222';
  for (const [label, downloaded, requested = pageId] of [
    ['null list', { ok: true, pages: null }],
    ['object instead of list', { ok: true, pages: {} }],
    ['string instead of list', { ok: true, pages: 'unreadable' }],
    ['null list entry', { ok: true, pages: [null] }],
    ['entry without identity', { ok: true, pages: [{}] }],
    ['entry with null identity', { ok: true, pages: [{ pageId: null }] }],
    ['entry with malformed identity', { ok: true, pages: [{ pageId: 'not-a-page-id' }] }],
    ['different returned page', { ok: true, pages: [{ pageId: otherPage }] }],
    ['matching page plus malformed entry', { ok: true, pages: [{ pageId }, {}] }],
    ['matching scalar cannot hide empty list', { ok: true, pageId, pages: [] }],
    ['matching scalar cannot hide null list', { ok: true, pageId, pages: null }],
    ['matching scalar cannot hide object list', { ok: true, pageId, pages: {} }],
    ['matching scalar cannot hide wrong page', { ok: true, pageId, pages: [{ pageId: otherPage }] }],
    ['matching scalar cannot hide missing identity', { ok: true, pageId, pages: [{}] }],
    ['matching scalar cannot hide missing before page in batch',
      { ok: true, pageId, pages: [{ pageId: otherPage }] }, `${pageId},${otherPage}`],
    ['wrong scalar cannot hide behind matching list', { ok: true, pageId: otherPage, pages: [{ pageId }] }],
  ]) {
    for (const layer of [1, 2]) {
      await t.test(`download result pages: ${label}, layer ${layer}`, () => {
        const fixture = privateBeforePublicAddFixture();
        const download = event(fixture, 'download');
        download.result = structuredClone(downloaded);
        download.command = download.command.replace(`--page-id ${pageId}`, `--page-id ${requested}`);
        const result = score(fixture, layer);
        assert.equal(result.status, 'fail', `${label}, layer ${layer}: ${result.reason}`);
        assert.match(result.reason, /download|before|provenance|identity|evidence/i);
      });
    }
  }
});

test('download result pages: valid current and historical identities retain preservation', async (t) => {
  const pageId = '99999999-9999-4999-8999-999999999999';
  const otherPage = '22222222-2222-4222-8222-222222222222';
  for (const [label, downloaded, requested] of [
    ['current list', { ok: true, pages: [{ pageId }] }, pageId],
    ['agreeing current list and scalar', { ok: true, pageId, pages: [{ pageId }] }, pageId],
    ['historical scalar without list', { ok: true, pageId }, pageId],
    ['historical omitted identity fields', { ok: true }, pageId],
    ['current list for multiple requested pages', { ok: true, pages: [{ pageId }, { pageId: otherPage }] }, `${pageId},${otherPage}`],
  ]) {
    for (const layer of [1, 2]) {
      await t.test(`download result pages: ${label}, layer ${layer}`, () => {
        const fixture = privateBeforePublicAddFixture();
        const download = event(fixture, 'download');
        download.result = structuredClone(downloaded);
        download.command = download.command.replace(`--page-id ${pageId}`, `--page-id ${requested}`);
        const result = score(fixture, layer);
        assert.equal(result.status, 'pass', `${label}, layer ${layer}: ${result.reason}`);
      });
    }
  }
});
