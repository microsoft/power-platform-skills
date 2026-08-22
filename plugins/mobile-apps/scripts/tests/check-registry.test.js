'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const pluginRoot = path.resolve(__dirname, '..', '..');
const harnessRoot = path.join(pluginRoot, 'skills', 'create-mobile-prototype', 'harness');
const registry = require(path.join(harnessRoot, 'registry.js'));
const esbuild = require(path.join(pluginRoot, 'template', 'node_modules', 'esbuild'));

test('registry covers every check exactly once with complete routing metadata', () => {
  const entries = registry.load();
  const modules = fs.readdirSync(path.join(harnessRoot, 'checks'))
    .filter((name) => name.endsWith('.js'))
    .map((name) => name.slice(0, -3))
    .sort();
  assert.deepEqual(entries.filter((entry) => entry.tier === 2).map((entry) => entry.module).sort(), modules);
  assert.equal(entries.filter((entry) => entry.tier === 2).length, 14);
  for (const entry of entries) {
    assert.ok(['A', 'B', 'C'].includes(entry.class));
    assert.ok([1, 2, 3].includes(entry.tier));
    assert.equal(entry.fixture.endsWith('.tsx'), true);
  }
  const runner = fs.readFileSync(path.join(harnessRoot, 'run.js'), 'utf8');
  assert.match(runner, /checkRegistry\.load\(\)/);
  assert.match(runner, /options\.check === 'all'/);
  assert.doesNotMatch(runner, /readdirSync\(CHECKS_DIR/);
});

test('missing class or blocking fixture fails registry validation', () => {
  const base = {
    id: 'test.check', module: 'contrast', tier: 2, class: 'A', scope: 'screen',
    rule: 'test', threshold: null, fixture: 'fixture.tsx', blocking: true,
  };
  assert.match(registry.validate([{ ...base, class: undefined }], { requireFiles: false }).join('\n'), /class must be/);
  assert.match(registry.validate([{ ...base, fixture: null }], { requireFiles: false }).join('\n'), /blocking checks require a fixture/);
});

test('every registered fixture triggers its check or non-blocking threshold', (t) => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'check-registry-fixtures-'));
  t.after(() => fs.rmSync(output, { recursive: true, force: true }));
  for (const entry of registry.load()) {
    if (entry.tier !== 2) continue;
    const outfile = path.join(output, `${entry.module}.cjs`);
    esbuild.buildSync({
      bundle: true,
      entryPoints: [path.join(pluginRoot, entry.fixture)],
      format: 'cjs',
      outfile,
      platform: 'node',
    });
    delete require.cache[outfile];
    const fixture = require(outfile).fixture;
    if (fixture.context?.projectDir === '$TEMPLATE') fixture.context.projectDir = path.join(pluginRoot, 'template');
    const check = require(path.join(harnessRoot, 'checks', `${entry.module}.js`));
    const result = entry.scope === 'app'
      ? check.runApp(fixture.rendered, fixture.context || {})
      : check.run(fixture.snapshot, fixture.context || {});
    if (fixture.expect === 'report') {
      assert.equal(entry.blocking, false, entry.id);
      assert.equal(result.report?.wouldMeetFloor, false, entry.id);
    } else {
      assert.equal(result.pass, false, `${entry.id} fixture did not trigger`);
    }
  }
});