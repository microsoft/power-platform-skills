'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  readManifest,
  validationFingerprint,
  writeManifest,
} = require('../validate-mobile-files');

test('validation fingerprints change only when phase, dependencies, or file bytes change', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-validation-fingerprint-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const first = path.join(root, 'app', 'home.tsx');
  const second = path.join(root, 'src', 'components.tsx');
  fs.mkdirSync(path.dirname(first), { recursive: true });
  fs.mkdirSync(path.dirname(second), { recursive: true });
  fs.writeFileSync(first, 'export default function Home() { return null; }\n');
  fs.writeFileSync(second, 'export const value = 1;\n');

  const dependencies = [{ name: 'example-package', version: '1.2.3' }];
  const baseline = validationFingerprint(new Set([first, second]), root, dependencies, 'final');
  assert.equal(validationFingerprint(new Set([second, first]), root, dependencies, 'final'), baseline);
  assert.notEqual(validationFingerprint(new Set([first, second]), root, dependencies, 'canary'), baseline);
  assert.notEqual(validationFingerprint(new Set([first, second]), root, [{ name: 'example-package', version: '1.2.4' }], 'final'), baseline);
  fs.appendFileSync(second, 'export const changed = true;\n');
  assert.notEqual(validationFingerprint(new Set([first, second]), root, dependencies, 'final'), baseline);
});

test('validation manifest is atomic and malformed input safely resets', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-validation-manifest-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const manifestPath = path.join(root, '.tmp', 'mobile-validation-manifest.json');
  const manifest = { schemaVersion: 1, phases: { final: { status: 'passed', fingerprint: 'abc' } } };
  writeManifest(manifestPath, manifest);
  assert.deepEqual(readManifest(manifestPath), manifest);
  fs.writeFileSync(manifestPath, '{');
  assert.deepEqual(readManifest(manifestPath), { schemaVersion: 1, phases: {} });
});