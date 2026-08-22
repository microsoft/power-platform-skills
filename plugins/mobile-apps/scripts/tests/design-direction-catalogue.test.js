'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const catalogue = require('../lib/design-direction-catalogue');
const resolver = require('../resolve-design-direction');

test('catalogue registers every direction file exactly once', () => {
  const entries = catalogue.load();
  const registered = entries.map((entry) => entry.source).sort();
  const files = fs.readdirSync(catalogue.DIRECTIONS_DIR).filter((name) => /^direction-.+\.md$/.test(name)).sort();
  assert.deepEqual(registered, files);
  assert.deepEqual(entries.map((entry) => entry.slug).sort(), [
    'airline', 'carrier-consumer', 'inspection', 'polished-inspection', 'product', 'saas',
  ]);
});

test('passenger airline retail routes to carrier-consumer', () => {
  const selected = catalogue.route('An onboard retail app for flight passengers buying travel accessories, beauty products, and watches.');
  assert.equal(selected.slug, 'carrier-consumer');
});

test('crew and ground operations route to airline', () => {
  const selected = catalogue.route('Cabin crew coordinate aircraft turnaround, ground operations, safety checks, and departure readiness.');
  assert.equal(selected.slug, 'airline');
});

test('passenger commerce outranks mixed cabin-staff operations language', () => {
  const selected = catalogue.route('Flight passengers and cabin retail managers browse a product catalogue and purchase onboard merchandise.');
  assert.equal(selected.slug, 'carrier-consumer');
});

test('explicit registered direction wins and unknown direction fails', () => {
  assert.equal(catalogue.route('ground operations', { explicit: 'product' }).slug, 'product');
  assert.throws(() => catalogue.route('anything', { explicit: 'missing' }), /unknown direction/);
});

test('project resolver reads brief and returns an existing source', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'direction-project-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'brief.md'), 'Passenger duty-free shopping for an airline flight.\n');
  const selected = resolver.resolveProject(root);
  assert.equal(selected.direction, 'carrier-consumer');
  assert.equal(fs.existsSync(selected.source), true);
});
