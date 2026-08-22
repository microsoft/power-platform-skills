'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const directions = require('../lib/directions');

test('loads only authored auto-resolvable directions', () => {
  assert.deepEqual(directions.RESOLVABLE, ['polished-inspection', 'saas', 'product']);
  for (const name of directions.RESOLVABLE) {
    const direction = directions.get(name);
    assert.equal(direction.bundle.direction, name);
    assert.ok(direction.referenceApps.length >= 2);
  }
  assert.throws(() => directions.get('inspection'), /not auto-resolvable/);
  assert.throws(() => directions.get('airline'), /not auto-resolvable/);
});

test('resolves brand, named brand, and domain keywords in tier order', () => {
  assert.equal(directions.resolvePalette({ brandDoc: 'Direction: Product' }).tier, 1);
  assert.equal(directions.resolvePalette({ brandName: 'Microsoft 365' }).direction, 'saas');
  const inventory = directions.resolvePalette({ domain: 'company inventory and IT assets' });
  assert.equal(inventory.direction, 'polished-inspection');
  assert.equal(inventory.tier, 3);
});

test('returns a choice request instead of silently defaulting', () => {
  for (const domain of [
    'travel accessories',
    'use what you have',
    'patient visit scheduling',
    'visitor badge access',
    'solar site survey',
    'airline crew rostering',
  ]) {
    const resolution = directions.resolvePalette({ domain });
    assert.equal(resolution.needsChoice, true, domain);
    assert.equal(resolution.reason, 'no keyword matched');
    assert.deepEqual(resolution.candidates.map((candidate) => candidate.direction), directions.RESOLVABLE);
  }
});

test('all text tokens and accent text pass AA on every authored palette', () => {
  for (const name of directions.RESOLVABLE) {
    const palette = directions.paletteFor(name);
    for (const token of directions.TEXT_TOKENS) {
      for (const ground of directions.GROUNDS) {
        assert.ok(
          directions.contrastRatio(palette[token], palette[ground]) >= 4.5,
          `${name}: ${token}/${ground}`,
        );
      }
    }
    assert.ok(directions.contrastRatio(palette.accentOn, palette.accentBase) >= 4.5);
    assert.ok(palette.contrastMinimum.ratio >= 4.5);
  }
});