'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const pluginRoot = path.resolve(__dirname, '..', '..');
const panelRoot = path.join(pluginRoot, 'skills', 'create-mobile-prototype', 'panel');
const core = require(path.join(panelRoot, 'core.cjs'));
const { install } = require(path.join(panelRoot, 'install.js'));

function project(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prototype-panel-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.tmp'), { recursive: true });
  fs.mkdirSync(path.join(root, '.mobile-build'), { recursive: true });
  fs.writeFileSync(path.join(root, 'brief.md'), '# Brief\n\nBadge access for corporate facilities.\n');
  fs.writeFileSync(path.join(root, '.tmp/dataverse-schema-contract.json'), JSON.stringify({ tables: [{ logicalName: 'cr_badgerequest', displayName: 'Badge request', columns: [{ logicalName: 'cr_name', schemaName: 'cr_name', displayName: 'Name', type: 'string' }, { logicalName: 'cr_expiryon', schemaName: 'cr_expiryon', displayName: 'Expiry', type: 'datetime' }] }] }, null, 2));
  fs.writeFileSync(path.join(root, 'native-app-plan.md'), `# Plan

## Native Capabilities

- expo-camera ready
- expo-haptics requested, not shipped — dropped

## Connectors

None

## Screens

### Screen Map

| Screen | Route | File | Purpose | Data | Pattern | Archetype |
|---|---|---|---|---|---|---|
| Badge requests | \`/(app)/requests\` | \`app/(app)/requests.tsx\` | Show expiring requests | Badge request | severity-filtered-queue | List |
| Profile | \`/(app)/profile\` | \`app/(app)/profile.tsx\` | App context | local | identity-block | Tab-root |

### Navigation Contracts

| Route | Intent |
|---|---|
| \`/(app)/requests\` | navigate |
| \`/(app)/profile\` | navigate |

### Per-Screen Specs

#### Screen 1 - Badge requests (\`/(app)/requests\`)

- **File:** \`app/(app)/requests.tsx\`
- **Data:** display cr_expiryon in the row subtitle

#### Screen 2 - Profile (\`/(app)/profile\`)

- **File:** \`app/(app)/profile.tsx\`
`);
  fs.writeFileSync(path.join(root, '.mobile-build/events.ndjson'), [
    { t: 1, kind: 'screen', id: 'badge-requests', label: 'Badge requests', state: 'building' },
    { t: 2, kind: 'finding', screen: 'badge-requests', check: 'density', actual: '3', expected: '8', state: 'OPEN' },
  ].map(JSON.stringify).join('\n') + '\n');
  return root;
}

function response(done) {
  return { body: '', headers: {}, statusCode: 0, setHeader(name, value) { this.headers[name] = value; }, write(value) { this.body += value; }, end(value = '') { this.body += value; done?.(); } };
}

test('panel exposes seven sections and surfaces dropped capability first', (t) => {
  const root = project(t);
  const state = install(root);
  for (const key of ['brief', 'model', 'native', 'connectors', 'screens', 'progress', 'issues']) assert.ok(Object.hasOwn(state, key), key);
  assert.equal(state.native[0].state, 'dropped');
  const html = fs.readFileSync(path.join(root, '.mobile-build/panel.html'), 'utf8');
  for (const label of ['What I understood', 'Data model', 'Native capabilities', 'Connectors', 'Screen map', 'Progress', 'Issues']) assert.match(html, new RegExp(label));
  for (const edit of ['Rename', 'Retype', 'Drop', 'Add field', 'Remove']) assert.match(html, new RegExp(`>${edit}<`));
  assert.doesNotMatch(html, /<iframe|app preview/i);
});

test('field drop is refused with dependent screens named', (t) => {
  const root = project(t);
  const result = core.modelEdit(root, { op: 'drop', entity: 'cr_badgerequest', field: 'cr_expiryon' });
  assert.equal(result.ok, false);
  assert.deepEqual(result.blocks.map((block) => block.screen), ['Badge requests']);
  assert.match(result.blocks[0].reason, /cr_expiryon/);
});

test('field rename updates schema and every screen contract use', (t) => {
  const root = project(t);
  const result = core.modelEdit(root, { op: 'rename', entity: 'cr_badgerequest', field: 'cr_expiryon', value: 'cr_validuntil' });
  assert.equal(result.ok, true, result.error);
  const contract = JSON.parse(fs.readFileSync(path.join(root, '.tmp/dataverse-schema-contract.json'), 'utf8'));
  assert.equal(contract.tables[0].columns.some((column) => column.logicalName === 'cr_validuntil'), true);
  const plan = fs.readFileSync(path.join(root, 'native-app-plan.md'), 'utf8');
  assert.doesNotMatch(plan, /cr_expiryon/);
  assert.match(plan, /cr_validuntil/);
});

test('screen removal updates plan and middleware serves panel/state endpoints', async (t) => {
  const root = project(t);
  install(root);
  assert.equal(core.screenEdit(root, { op: 'remove', id: 'profile' }).ok, true);
  assert.equal(core.loadState(root).screens.some((screen) => screen.id === 'profile'), false);
  const handle = require(path.join(root, '.mobile-build/panel-middleware.cjs'));
  const panelReq = new EventEmitter(); panelReq.method = 'GET'; panelReq.url = '/panel';
  const panelRes = response(); assert.equal(handle(panelReq, panelRes), true); assert.match(panelRes.body, /App plan/);
  const stateReq = new EventEmitter(); stateReq.method = 'GET'; stateReq.url = '/panel/state';
  const stateRes = response(); assert.equal(handle(stateReq, stateRes), true); assert.equal(JSON.parse(stateRes.body).screens.length, 1);
  const postResult = new Promise((resolve) => {
    const postReq = new EventEmitter(); postReq.method = 'POST'; postReq.url = '/panel/model';
    const postRes = response(() => resolve(JSON.parse(postRes.body)));
    assert.equal(handle(postReq, postRes), true);
    postReq.emit('data', JSON.stringify({ op: 'rename', entity: 'cr_badgerequest', field: 'cr_name', value: 'cr_title' }));
    postReq.emit('end');
  });
  assert.equal((await postResult).ok, true);
});