'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  referenceFiles,
  resolveDesignInstructionManifest,
  validateOwnership,
  writeAtomic,
} = require('../resolve-design-instruction-manifest');

const pluginRoot = path.resolve(__dirname, '..', '..');
const skillRoot = path.join(pluginRoot, 'skills', 'design-system');

function ownership() {
  return JSON.parse(fs.readFileSync(path.join(skillRoot, 'reference-ownership.json'), 'utf8'));
}

test('every design reference has exactly one optional owner', () => {
  const value = ownership();
  assert.deepEqual(validateOwnership(value), []);
  assert.deepEqual(
    value.references.map((entry) => entry.path).sort(),
    referenceFiles(path.join(skillRoot, 'references')).sort(),
  );
  assert.equal(new Set(value.references.map((entry) => entry.path)).size, 24);
});

test('automatic native mode loads only its closed allowlist with zero design model calls', () => {
  const manifest = resolveDesignInstructionManifest('automatic-native');
  assert.deepEqual(manifest.loadedFiles, [
    'skills/design-system/SKILL.md',
    'skills/design-system/automatic-native.md',
  ]);
  assert.deepEqual(manifest.referenceFiles, []);
  assert.equal(manifest.optionalReferencesLoaded, 0);
  assert.equal(manifest.modelCalls, 0);
  assert.equal(manifest.loadedBytes, Object.values(manifest.fileBytes).reduce((total, bytes) => total + bytes, 0));
  assert.ok(manifest.loadedBytes < fs.statSync(path.join(skillRoot, 'optional-modes.md')).size);
});

test('optional modes load the preserved workflow and only their owned references', () => {
  const screenshot = resolveDesignInstructionManifest('screenshot-intake');
  assert.ok(screenshot.loadedFiles.includes('skills/design-system/optional-modes.md'));
  assert.deepEqual(screenshot.referenceFiles, ['references/reference-intake.md']);
  assert.equal(screenshot.modelCalls, 1);
  const gallery = resolveDesignInstructionManifest('gallery');
  assert.deepEqual(gallery.referenceFiles, ['references/preview-template.md']);
});

test('automatic instruction receipt is byte-stable', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'design-instruction-manifest-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const manifest = resolveDesignInstructionManifest('automatic-native');
  const firstPath = writeAtomic(root, manifest);
  const first = fs.readFileSync(firstPath, 'utf8');
  writeAtomic(root, resolveDesignInstructionManifest('automatic-native'));
  assert.equal(fs.readFileSync(firstPath, 'utf8'), first);
});
