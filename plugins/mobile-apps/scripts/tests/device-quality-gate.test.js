'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const pluginRoot = path.resolve(__dirname, '..', '..');
const deviceRoot = path.join(pluginRoot, 'skills', 'create-mobile-prototype', 'harness', 'device');
const registry = require(path.join(pluginRoot, 'skills', 'create-mobile-prototype', 'harness', 'registry.js'));
const runner = require(path.join(deviceRoot, 'run.js'));
const generator = require(path.join(pluginRoot, 'scripts', 'generate-device-contract.js'));
const esbuild = require(path.join(pluginRoot, 'template', 'node_modules', 'esbuild'));

function contract() {
  return {
    launch: { appId: 'com.contoso.demo', scheme: 'demo', route: '/(app)/home' },
    fonts: [
      { role: 'heading', family: 'Brand Heading', id: 'device-font:heading', route: '/(app)/home' },
      { role: 'body', family: 'Brand Body', id: 'device-font:body', route: '/(app)/home' },
    ],
    tabs: [{ id: 'device-tab:home', label: 'Home', route: '/(app)/home' }],
    forms: [{ id: 'new-item', route: '/(app)/new-item', inputId: 'device-input:new-item', ctaId: 'device-cta:new-item' }],
  };
}

function project(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'device-contract-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.mobile-build'), { recursive: true });
  fs.mkdirSync(path.join(root, 'brand'), { recursive: true });
  fs.copyFileSync(path.join(pluginRoot, 'template', 'app.config.js'), path.join(root, 'app.config.js'));
  fs.writeFileSync(path.join(root, 'brand', 'tokens.ts'), "export const fontStack = { heading: 'Brand Heading', body: 'Brand Body' } as const;\n");
  fs.writeFileSync(path.join(root, '.mobile-build', 'screen-plan.json'), `${JSON.stringify({ schemaVersion: 1, screens: [
    { id: 'home', route: '/(app)/home', archetype: 'tab-root', pattern: 'home-dashboard', hero: 'metric-hero', components: ['ScreenHeader'], binding: 'PreviewService', states: ['populated'], derived: [] },
    { id: 'new-item', route: '/(app)/new-item', archetype: 'form', pattern: 'record-form', components: ['FormField'], binding: 'PreviewService', states: ['ready'], derived: [] },
  ] }, null, 2)}\n`);
  return root;
}

test('device contract derives fonts, tabs, forms, app id, and scheme', (t) => {
  const root = project(t);
  const value = generator.generate(root).contract;
  assert.equal(value.launch.appId, 'com.contoso.powerappsapp');
  assert.equal(value.launch.scheme, 'powerapps-standalone-app');
  assert.deepEqual(value.fonts.map((probe) => probe.family), ['Brand Heading', 'Brand Body']);
  assert.deepEqual(value.tabs.map((tab) => tab.id), ['device-tab:home']);
  assert.deepEqual(value.forms[0], { id: 'new-item', route: '/(app)/new-item', inputId: 'device-input:new-item', ctaId: 'device-cta:new-item' });
});

test('failed regeneration removes stale device contract', (t) => {
  const root = project(t);
  const output = generator.generate(root).output;
  fs.rmSync(path.join(root, '.mobile-build', 'screen-plan.json'));
  assert.throws(() => generator.generate(root), /structured screen plan is missing/);
  assert.equal(fs.existsSync(output), false);
});

test('every Tier 3 violation fixture triggers its device check', (t) => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'device-fixtures-'));
  t.after(() => fs.rmSync(output, { recursive: true, force: true }));
  for (const entry of registry.load().filter((candidate) => candidate.tier === 3)) {
    const outfile = path.join(output, `${entry.module}.cjs`);
    esbuild.buildSync({ bundle: true, entryPoints: [path.join(pluginRoot, entry.fixture)], format: 'cjs', outfile, platform: 'node' });
    const fixture = require(outfile).fixture;
    const check = require(path.join(deviceRoot, 'checks', `${entry.module}.js`));
    const result = check.run(fixture.evidence, fixture.contract);
    assert.equal(result.pass, false, `${entry.id} fixture did not trigger`);
    assert.notEqual(result.notRun, true, `${entry.id} violation was silently NOT RUN`);
  }
});

test('Maestro flows use stable IDs, keyboard-open CTA assertion, and screenshots', () => {
  const entries = new Map(registry.load().filter((entry) => entry.tier === 3).map((entry) => [entry.id, entry]));
  const value = contract();
  const fontFlow = runner.flowFor(entries.get('device.fonts.resolved'), value);
  assert.match(fontFlow, /id: "device-font:heading"/);
  assert.match(fontFlow, /path: resolved-fonts/);
  const tabFlow = runner.flowFor(entries.get('device.tabs.not-clipped'), value);
  assert.match(tabFlow, /id: "device-tab:home"/);
  const formFlow = runner.flowFor(entries.get('device.keyboard.cta-visible'), value);
  assert.ok(formFlow.indexOf('inputText') < formFlow.indexOf('id: "device-cta:new-item"'));
  assert.ok(formFlow.indexOf('id: "device-cta:new-item"') < formFlow.indexOf('hideKeyboard'));
  assert.match(formFlow, /enabled: true/);
  assert.equal(runner.deepLink(value, '/(app)/new-item'), 'demo://new-item');
});

test('standard mode permits explicit NOT RUN while full mode rejects it', () => {
  const entries = registry.load().filter((entry) => entry.tier === 3);
  const missing = Object.fromEntries(entries.map((entry) => [entry.id, { executed: false, reason: 'Maestro unavailable' }]));
  const standard = runner.evaluate(entries, contract(), missing, false);
  const full = runner.evaluate(entries, contract(), missing, true);
  assert.equal(standard.pass, true);
  assert.equal(standard.results.every((result) => result.status === 'NOT_RUN'), true);
  assert.equal(full.pass, false);
});

test('full mode passes only with complete executed evidence and screenshots', () => {
  const entries = registry.load().filter((entry) => entry.tier === 3);
  const evidence = Object.fromEntries(entries.map((entry) => [entry.id, { executed: true, exitCode: 0, screenshot: `/tmp/${entry.module}.png` }]));
  const result = runner.evaluate(entries, contract(), evidence, true);
  assert.equal(result.pass, true);
  assert.equal(result.results.every((item) => item.status === 'PASS'), true);
});

test('device selection prefers a booted simulator', () => {
  const selected = runner.selectDevice([
    { name: 'iPhone 17', udid: 'shutdown', state: 'Shutdown', isAvailable: true },
    { name: 'iPhone 17 Pro', udid: 'booted', state: 'Booted', isAvailable: true },
  ]);
  assert.equal(selected.udid, 'booted');
});

test('prototype and production workflows preserve strict full-device semantics', () => {
  const prototype = fs.readFileSync(path.join(pluginRoot, 'skills', 'create-mobile-prototype', 'SKILL.md'), 'utf8');
  const production = fs.readFileSync(path.join(pluginRoot, 'skills', 'create-mobile-app', 'SKILL.md'), 'utf8');
  for (const workflow of [prototype, production]) {
    assert.match(workflow, /generate-device-contract\.js/);
    assert.match(workflow, /harness\/device\/run\.js/);
    assert.match(workflow, /--full-device/);
    assert.match(workflow, /zero\s+`?NOT_RUN`?|every failure or `NOT RUN`/);
  }
});
