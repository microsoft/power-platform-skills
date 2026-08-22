'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const registry = require('../registry');

const fixtureDir = path.join(__dirname, '__fixtures__');

test('every render check ships a captured fixture that triggers it', () => {
  const entries = registry.load().filter((entry) => entry.tier === 2);
  for (const entry of entries) {
    const fixturePath = path.join(fixtureDir, `${entry.module}.bad.json`);
    assert.equal(fs.existsSync(fixturePath), true, `${entry.id} has no captured .bad.json fixture`);
    const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
    assert.equal(fixture.capturedFrom, entry.fixture, `${entry.id} fixture provenance drifted`);
    if (fixture.context?.projectDir === '$TEMPLATE') fixture.context.projectDir = path.join(registry.PLUGIN_ROOT, 'template');
    const check = require(path.join(__dirname, `${entry.module}.js`));
    const result = entry.scope === 'app'
      ? check.runApp(fixture.rendered, fixture.context || {})
      : check.run(fixture.snapshot, fixture.context || {});
    if (fixture.expect === 'report') {
      assert.equal(entry.blocking, false, entry.id);
      assert.equal(result.report?.wouldMeetFloor, false, `${entry.id} fixture did not miss its floor`);
    } else {
      assert.equal(result.pass, false, `${entry.id} passed its captured known-bad fixture`);
    }
  }
});