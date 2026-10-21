'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadFixtures } = require('../lib/fixture-loader.js');
const { PHASE_EXPECTATIONS, WORKFLOW_ASSERTIONS } = require('../lib/assertions-layer-1.js');
const { PHASE5_EXPECTATIONS } = require('../lib/assertions-layer-2.js');

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
  fixture.events = [
    { id: 'gate-discover', command: 'node feature-flags.js custom-api', result: 'enabled' },
    { id: 'download', command: 'node genpage.js download --env https://contoso.crm.dynamics.com --page-id 99999999-9999-4999-8999-999999999999 --output-directory before',
      result: { ok: true, pageId: '99999999-9999-4999-8999-999999999999' } },
    { id: 'discovery', command: 'node list-custom-apis.js https://contoso.crm.dynamics.com --entities salesorder',
      result: { ok: true, customApis: [{ ...added, bindingType: 'Global' }] } },
    { id: 'gate-generate', command: 'node feature-flags.js custom-api', result: 'enabled' },
    { id: 'write-edit', command: 'Write page.tsx', artifact: 'stages/edited.tsx' },
    { id: 'edit', command: 'node genpage-upload.js --env https://contoso.crm.dynamics.com --app-id 11111111-1111-4111-8111-111111111111 --page-id 99999999-9999-4999-8999-999999999999 --code-file page.tsx --actions actions.json',
      result: { ok: true, pageId: '99999999-9999-4999-8999-999999999999' } },
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
