const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { loadConfig, classifyTier, DEFAULTS, deepMerge } = require('../lib/alm-thresholds');

test('DEFAULTS reserve growth headroom under platform hard caps', () => {
  // Split-decision thresholds are intentionally tighter than the platform
  // hard caps (95 MB / 6000 components). Recommending a split here leaves
  // room for solutions to grow before the platform refuses an import.
  // Bumped down on 2026-05-08 (IronItOut release-readiness pass) to give
  // ~20 MB / ~2000-component headroom in each split child.
  assert.equal(DEFAULTS.maxSolutionSizeMB, 75);
  assert.equal(DEFAULTS.warnComponentCount, 2500);
  assert.equal(DEFAULTS.maxComponentCount, 4000);
  // Hard-flag stays at platform cap — anything past this is unrecoverable.
  assert.equal(DEFAULTS.hardFlagComponentCount, 10000);
});

test('classifyTier returns green/yellow/red based on bounds', () => {
  assert.equal(classifyTier(10, 20, 50), 'green');
  assert.equal(classifyTier(30, 20, 50), 'yellow');
  assert.equal(classifyTier(80, 20, 50), 'red');
  assert.equal(classifyTier(20, 20, 50), 'yellow'); // boundary — green is strict <
  assert.equal(classifyTier(50, 20, 50), 'red');    // boundary — yellow is strict <
  assert.equal(classifyTier(null, 20, 50), 'unknown');
});

test('loadConfig returns defaults when no .alm-config.json exists', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alm-thresh-'));
  try {
    const cfg = loadConfig(tmp);
    assert.equal(cfg.thresholds.maxSolutionSizeMB, DEFAULTS.maxSolutionSizeMB);
    assert.equal(cfg.strategyPreference, 'auto');
    assert.equal(cfg.assetAdvisory.preferredStorage, 'azure-blob');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('loadConfig merges .alm-config.json over defaults', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alm-thresh-'));
  try {
    fs.writeFileSync(
      path.join(tmp, '.alm-config.json'),
      JSON.stringify({
        thresholds: { maxSolutionSizeMB: 120 },
        assetAdvisory: { preferredStorage: 'cdn' },
      }),
    );
    const cfg = loadConfig(tmp);
    assert.equal(cfg.thresholds.maxSolutionSizeMB, 120);
    assert.equal(cfg.thresholds.maxComponentCount, DEFAULTS.maxComponentCount); // untouched
    assert.equal(cfg.assetAdvisory.preferredStorage, 'cdn');
    assert.equal(cfg.assetAdvisory.enabled, true); // preserved default
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('loadConfig silently returns defaults on malformed JSON', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alm-thresh-'));
  try {
    fs.writeFileSync(path.join(tmp, '.alm-config.json'), '{not valid json');
    const cfg = loadConfig(tmp);
    assert.equal(cfg.thresholds.maxSolutionSizeMB, DEFAULTS.maxSolutionSizeMB);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('deepMerge preserves nested defaults while overlaying values', () => {
  const base = { a: 1, b: { x: 10, y: 20 } };
  const merged = deepMerge(base, { b: { x: 99 } });
  assert.equal(merged.a, 1);
  assert.equal(merged.b.x, 99);
  assert.equal(merged.b.y, 20);
});
