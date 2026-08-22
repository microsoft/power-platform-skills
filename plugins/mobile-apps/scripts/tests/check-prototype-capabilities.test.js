'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const capabilityCheck = require('../check-prototype-capabilities');

const packageJson = {
  dependencies: {
    'expo-camera': '55.0.18',
    'expo-print': '55.0.14',
    'expo-location': '55.1.9',
    'expo-file-system': '55.0.19',
    'expo-sharing': '55.0.18',
  },
};

test('classifies available, partial, and unavailable brief capabilities without blocking', () => {
  const report = capabilityCheck.assess(
    'Scan barcodes, print raw ZPL labels over Bluetooth, and send push notifications.',
    packageJson,
  );
  const byKey = new Map(report.rows.map((row) => [row.key, row]));
  assert.equal(byKey.get('barcode').status, 'AVAILABLE');
  assert.match(byKey.get('barcode').resolution, /expo-camera 55\.0\.18/);
  assert.equal(byKey.get('raw-printer').status, 'PARTIAL');
  assert.match(byKey.get('raw-printer').resolution, /raw ZPL\/Bluetooth/);
  assert.equal(byKey.get('bluetooth').status, 'UNAVAILABLE');
  assert.equal(byKey.get('push').status, 'UNAVAILABLE');
});

test('persists only partial and unavailable rows under Native Capabilities', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prototype-capabilities-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const planPath = path.join(root, 'native-app-plan.md');
  fs.writeFileSync(planPath, '# Plan\n\n## Native Capabilities\n\n| Capability | Decision |\n|---|---|\n| Barcode | use |\n\n## Connectors\n\nNone.\n');
  const report = capabilityCheck.assess('Scan barcodes and print raw ZPL labels.', packageJson);

  assert.equal(capabilityCheck.persist(planPath, report), 1);
  assert.equal(capabilityCheck.persist(planPath, report), 1, 'persistence is idempotent');
  const plan = fs.readFileSync(planPath, 'utf8');
  assert.equal((plan.match(/PROTOTYPE CAPABILITY WARNINGS START/g) || []).length, 1);
  assert.match(plan, /Raw barcode\/label printing \| PARTIAL/);
  assert.doesNotMatch(plan, /Barcode\/QR scanning \| AVAILABLE/);
  assert.ok(plan.indexOf('### Capability Warnings') < plan.indexOf('## Connectors'));
});

test('run writes a durable artifact and remains successful for unsupported requests', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prototype-capabilities-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'brief.md'), 'Read NFC tags.\n');
  fs.writeFileSync(path.join(root, 'package.json'), `${JSON.stringify(packageJson)}\n`);
  const result = capabilityCheck.run(root);
  assert.equal(result.report.rows[0].status, 'UNAVAILABLE');
  assert.equal(fs.existsSync(path.join(root, '.tmp/prototype-capability-check.json')), true);
});