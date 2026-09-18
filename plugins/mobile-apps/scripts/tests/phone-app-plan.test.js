'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { readPhonePlan, compileInitialPhonePlan, compilePhoneScreens, isPhoneApp } = require('../lib/phone-app-plan');
const { validateNavigationLayout } = require('../validate-navigation-layout');

function fixture(t, count = 2) {
  const root = fs.mkdtempSync(path.join(__dirname, '.phone-plan-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (file, value) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), typeof value === 'string' ? value : JSON.stringify(value));
  };
  const read = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
  const appInstanceId = crypto.randomUUID();
  write('app.json', { expo: { extra: { telemetry: { appInstanceId } } } });
  write('native-app-plan.md', ['App Requirements', 'Data Model', 'Native Capabilities', 'Connectors', 'Screens']
    .map(heading => `## ${heading}\nReviewed app requirements.\n`).join('\n'));
  write('.tmp/prototype-domain.json', {
    schemaVersion: 1, appInstanceId, schemaVersionNumber: 1,
    entities: [{ id: 'Item', label: 'Item', fields: [{ id: 'title', label: 'Title', type: 'text', required: true }],
      operations: ['list', 'get', 'create', 'update', 'delete'] }],
    actions: [{ id: 'saveItem', label: 'Save item', entityId: 'Item', operation: 'save' }],
  });
  write('.tmp/prototype-rules.json', { schemaVersion: 1, rules: [] });
  write('.tmp/scenario-facts.json', {
    schemaVersion: 1, contractType: 'scenario-facts',
    records: [{ id: 'item-one', conceptId: 'item', fields: { title: 'First item' } }], mediaAssets: [],
  });
  const screen = index => ({
    screenId: `screen-${index}`, title: `Screen ${index}`, route: `/screen-${index}`,
    sourceFile: `app/(app)/screen-${index}.tsx`, dependencies: [], entityIds: ['Item'],
    primaryActions: ['Read items'], secondaryActions: [], dataAssumptions: ['Use the Item repository'],
  });
  const plan = {
    schemaVersion: 1, entryRoute: '/screen-0', screens: Array.from({ length: count }, (_, index) => screen(index)),
    deferredScreens: [], navigation: { pattern: 'stack', destinations: [] }, nativeCapabilities: [], deferredConnectors: [],
  };
  write('.tmp/phone-app-plan.json', plan);
  return { root, plan, write, read, screen };
}

test('initial app planning accepts exactly two or three screens and rejects larger or incomplete first slices', t => {
  for (const count of [2, 3]) {
    const f = fixture(t, count);
    assert.equal(readPhonePlan(f.root, { initial: true }).screens.length, count);
  }
  for (const count of [1, 4]) {
    const f = fixture(t, count);
    assert.throws(() => readPhonePlan(f.root, { initial: true }), /2-3-screen/);
  }
});

test('phone planning derives local contracts without app, environment, service or HTML generation', t => {
  const f = fixture(t);
  const result = compileInitialPhonePlan(f.root);
  assert.equal(result.publicationReady, false);
  assert.equal(f.read('.tmp/persistence-contract.json').mode, 'local-prototype');
  assert.equal(f.read('.tmp/compiled-screen-build-pack.json').producer, 'phone-app-plan');
  assert.equal(f.read('.tmp/scenario-facts.json').records[0].fields.title, 'First item');
  for (const file of ['power.config.json', 'src/generated', 'app/_layout.tsx', '_design_preview.html', '_plan_preview.html']) {
    assert.equal(fs.existsSync(path.join(f.root, file)), false, file);
  }
  compileInitialPhonePlan(f.root, { check: true });
  assert.equal(isPhoneApp(f.root), true);
});

test('proposed native capabilities remain unapproved until the verified-decision path activates them', t => {
  const f = fixture(t);
  f.plan.nativeCapabilities = [{ id: 'camera', displayName: 'Camera', persistenceConsequence: 'Store selected evidence locally.' }];
  f.write('.tmp/phone-app-plan.json', f.plan);
  compileInitialPhonePlan(f.root);
  assert.equal(f.read('.tmp/architecture-decisions.json').nativeCapabilities[0].approved, false);
  assert.equal(f.read('.tmp/persistence-contract.json').nativeCapabilities[0].id, 'camera');
  const factsBefore = fs.readFileSync(path.join(f.root, '.tmp/scenario-facts.json'), 'utf8');
  const persistenceBefore = f.read('.tmp/persistence-contract.json').persistenceRevision;
  compileInitialPhonePlan(f.root, { approved: true });
  assert.equal(f.read('.tmp/architecture-decisions.json').nativeCapabilities[0].approved, true);
  assert.equal(f.read('.tmp/persistence-contract.json').persistenceRevision, persistenceBefore);
  assert.equal(fs.readFileSync(path.join(f.root, '.tmp/scenario-facts.json'), 'utf8'), factsBefore);
});

test('later screen expansion preserves the local model and records and updates only screen projections', t => {
  const f = fixture(t);
  compileInitialPhonePlan(f.root);
  const retained = ['.tmp/prototype-domain.json', '.tmp/prototype-rules.json', '.tmp/scenario-facts.json', '.tmp/persistence-contract.json']
    .map(file => [file, fs.readFileSync(path.join(f.root, file), 'utf8')]);
  f.write('.tmp/prototype-profile.json', { schemaVersion: 1, profile: 'prototype' });
  f.plan.screens.push(f.screen(2), f.screen(3));
  f.write('.tmp/phone-app-plan.json', f.plan);
  compilePhoneScreens(f.root);
  assert.equal(f.read('.tmp/compiled-screen-build-pack.json').screens.length, 4);
  retained.forEach(([file, bytes]) => assert.equal(fs.readFileSync(path.join(f.root, file), 'utf8'), bytes, file));
  assert.throws(() => compileInitialPhonePlan(f.root), /Do not reinitialize/);
});

test('readiness rejects stale projections and invalid or cyclic screen assignments', t => {
  const f = fixture(t);
  compileInitialPhonePlan(f.root);
  f.plan.screens[0].primaryActions = ['Different behavior'];
  f.write('.tmp/phone-app-plan.json', f.plan);
  assert.throws(() => compilePhoneScreens(f.root, { check: true }), /stale/);
  f.plan.screens[0].dependencies = ['screen-1'];
  f.plan.screens[1].dependencies = ['screen-0'];
  f.write('.tmp/phone-app-plan.json', f.plan);
  assert.throws(() => readPhonePlan(f.root), /cycle/);
  f.plan.screens[0].dependencies = [];
  f.plan.screens[1].sourceFile = 'app/(app)/wrong.tsx';
  f.write('.tmp/phone-app-plan.json', f.plan);
  assert.throws(() => readPhonePlan(f.root), /matching/);
});

test('screen projection rejects foreign app identity and unknown model references', t => {
  const f = fixture(t);
  const domain = f.read('.tmp/prototype-domain.json');
  f.write('.tmp/prototype-domain.json', { ...domain, appInstanceId: crypto.randomUUID() });
  assert.throws(() => compileInitialPhonePlan(f.root), /app identity/);
  f.write('.tmp/prototype-domain.json', domain);
  f.plan.screens[0].entityIds = ['UnknownEntity'];
  f.write('.tmp/phone-app-plan.json', f.plan);
  assert.throws(() => compileInitialPhonePlan(f.root), /reviewed data model/);
});

test('tab entries follow the actual Expo layout boundary, including layoutless index routes', t => {
  for (const nestedLayout of [false, true]) {
    const f = fixture(t);
    f.plan.screens[1] = { ...f.plan.screens[1], route: '/saved', sourceFile: 'app/(app)/saved/index.tsx' };
    f.plan.navigation = { pattern: 'tabs-plus-stacks', destinations: [
      { screenId: 'screen-0', label: 'Items', iconName: 'list-outline' },
      { screenId: 'screen-1', label: 'Saved', iconName: 'bookmark-outline' },
    ] };
    f.write('.tmp/phone-app-plan.json', f.plan);
    compileInitialPhonePlan(f.root);
    f.write('app/(app)/screen-0.tsx', 'export default function Items() { return null; }');
    f.write('app/(app)/saved/index.tsx', 'export default function Saved() { return null; }');
    if (nestedLayout) f.write('app/(app)/saved/_layout.tsx', '<Stack><Stack.Screen name="index" /></Stack>');
    const entry = nestedLayout ? 'saved' : 'saved/index';
    const layout = `<Tabs><Tabs.Screen name="screen-0" options={{ icon: 'list-outline' }} />
      <Tabs.Screen name="${entry}" options={{ icon: 'bookmark-outline' }} /></Tabs>`;
    f.write('app/(app)/_layout.tsx', layout);
    const manifest = f.read('.tmp/navigation-manifest.json');
    const result = validateNavigationLayout(f.root, manifest);
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    f.write('app/(app)/_layout.tsx', layout.replace(`name="${entry}"`, `name="${nestedLayout ? 'saved/index' : 'saved'}"`));
    const invalid = validateNavigationLayout(f.root, manifest);
    assert.equal(invalid.ok, false);
    assert.ok(invalid.errors.some(error => error.code === 'missing-visible-destination'));
    f.write('app/(app)/_layout.tsx', layout.replace('</Tabs>', '<Tabs.Screen name="unexpected" /></Tabs>'));
    assert.ok(validateNavigationLayout(f.root, manifest).errors.some(error => error.code === 'phantom-visible-destination'));
    f.write('app/(app)/_layout.tsx', layout);
    f.write('app/(app)/saved.tsx', 'export default function Duplicate() { return null; }');
    assert.ok(validateNavigationLayout(f.root, manifest).errors.some(error => error.code === 'duplicate-expo-route'));
  }
});
