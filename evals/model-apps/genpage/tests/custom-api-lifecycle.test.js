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
const GeneratedComponent = () => null;
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
