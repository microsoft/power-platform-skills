'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const m = require('../lib/pcf-matrix.js');

const ROOT = path.join(__dirname, '..', '..');

test('the committed matrix validates', () => {
  assert.deepEqual(m.validateMatrix(m.loadMatrix()), []);
});

test('compareVersions / inRange', () => {
  assert.equal(m.compareVersions('9.46.2', '9.68.0'), -1);
  assert.equal(m.compareVersions('1.51', '1.51.0'), 0);
  assert.equal(m.compareVersions('9.46.2-beta', '9.46.2'), -1);
  assert.equal(m.inRange('9.46.2', { min: '9.4.0', max: '9.46.2' }), true);
  assert.equal(m.inRange('9.68.0', { min: '9.4.0', max: '9.46.2' }), false);
});

test('platform library findings: range, known-bad, 8+9, pages', () => {
  const mx = m.loadMatrix();
  const codes = (d, h) => m.platformLibraryFindings(mx, d, h).map((f) => f.code).sort();

  assert.deepEqual(
    codes([{ name: 'React', version: '16.14.0' }, { name: 'Fluent', version: '9.46.2' }], ['model']),
    [],
  );
  assert.ok(codes([{ name: 'Fluent', version: '9.68.0' }], ['model']).includes('PCF_PLATFORM_LIB_KNOWN_BAD'));
  assert.ok(
    codes([{ name: 'Fluent', version: '8.29.0' }, { name: 'Fluent', version: '9.46.2' }], ['model']).includes(
      'PCF_FLUENT_8_AND_9',
    ),
  );
  assert.ok(codes([{ name: 'React', version: '16.14.0' }], ['model', 'pages']).includes('PCF_PAGES_PLATFORM_LIBRARY'));
  assert.ok(codes([{ name: 'Vue', version: '3.0.0' }], ['model']).includes('PCF_PLATFORM_LIB_UNKNOWN'));
});

test('dependency sets expose the committed lock package versions', () => {
  const mx = m.loadMatrix();
  for (const set of ['standard', 'virtual']) {
    const deps = m.dependencySet(mx, set);
    assert.equal(deps.lockDir, path.join(ROOT, 'pcf', 'lock', set));
    assert.ok(Object.hasOwn(deps.devDependencies, 'pcf-scripts'), `${set}: pcf-scripts missing`);
  }
});

test('host policies expose model and pages rules', () => {
  const mx = m.loadMatrix();
  assert.equal(m.hostPolicy(mx, 'model').platformLibraries, true);
  assert.equal(m.hostPolicy(mx, 'pages').platformLibraries, false);
  assert.ok(m.hostPolicy(mx, 'pages').unsupportedPropertyTypes.includes('File'));
});

test('renderHostsTable emits the sync block and pages prerequisites', () => {
  const table = m.renderHostsTable(m.loadMatrix());
  assert.match(table, /<!-- pcf-matrix:begin -->/);
  assert.match(table, /Power Pages/);
  assert.match(table, /useFieldsFromView/);
  assert.match(table, /<!-- pcf-matrix:end -->/);
});

test('lock package.json files pin exact versions only', () => {
  for (const set of ['standard', 'virtual']) {
    const pj = JSON.parse(fs.readFileSync(path.join(ROOT, 'pcf', 'lock', set, 'package.json'), 'utf8'));
    for (const [name, v] of Object.entries({ ...(pj.dependencies || {}), ...(pj.devDependencies || {}) })) {
      assert.match(v, /^\d+\.\d+\.\d+$/, `${set}: ${name}@${v} must be exact`);
    }
    assert.ok(fs.existsSync(path.join(ROOT, 'pcf', 'lock', set, 'package-lock.json')), `${set} lockfile missing`);
  }
});

test('no file outside the matrix hard-codes a pcf-scripts version', () => {
  const offenders = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (['node_modules', 'vendor', '_vendor-build', 'lock', '.maker-workspace'].includes(e.name)) continue;
      const f = path.join(d, e.name);
      if (e.isDirectory()) {
        walk(f);
      } else if (
        /\.(js|json|tmpl|md)$/.test(e.name)
        && /"pcf-scripts"\s*:\s*"[\^~]?\d/.test(fs.readFileSync(f, 'utf8'))
      ) {
        offenders.push(path.relative(ROOT, f));
      }
    }
  };

  walk(ROOT);
  assert.deepEqual(offenders, []);
});
