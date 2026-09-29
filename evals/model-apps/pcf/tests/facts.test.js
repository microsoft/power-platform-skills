'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { computeFacts } = require('../lib/facts.js');
const { assertInsideFixtures } = require('../capture-pcf-fixture.js');

const ROOT = path.join(__dirname, '..');
const fixture = (name) => path.join(ROOT, 'fixtures', name);
const MAX_FIXTURE_FILE_BYTES = 64 * 1024;

function codes(items, key = 'code') {
  return (items || []).map((item) => item[key]).sort();
}

test('facts: clean intent fixture validates, lints cleanly, and renders plan sections', async () => {
  const facts = await computeFacts({ family: 'intent', fixture: fixture('001-intent-field-clean') });
  assert.equal(facts.family, 'intent');
  assert.equal(facts.valid, true, JSON.stringify(facts.validationErrors));
  assert.deepEqual(codes(facts.findings), []);
  assert.deepEqual(facts.hosts, ['model', 'pages']);
  assert.equal(facts.template, 'field-standard');
  assert.ok(facts.planSections.includes('Bindings'));
  assert.ok(facts.planSections.includes('What will be verified'));
});

test('facts: generated source fixture reports source and feature gate findings', async () => {
  const facts = await computeFacts({ family: 'generated', fixture: fixture('026-generated-xrm-webapi'), hosts: ['model'] });
  assert.equal(facts.family, 'generated');
  assert.equal(facts.ok, false);
  assert.ok(codes(facts.errors).includes('PCF_CODE_XRM'));
  assert.ok(codes(facts.errors).includes('PCF_FEATURE_UNDECLARED'));
  assert.ok(!codes(facts.errors).includes('PCF_PAGES_VIRTUAL'));
});

test('fixtures stay small and package-lock stubs do not feed dependency scanning', () => {
  const oversized = [];
  const badLocks = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      const stat = fs.statSync(full);
      if (stat.size > MAX_FIXTURE_FILE_BYTES) {
        oversized.push(`${path.relative(ROOT, full)} (${stat.size} bytes)`);
      }
      if (entry.name === 'package-lock.json') {
        const lock = JSON.parse(fs.readFileSync(full, 'utf8'));
        if (!lock.packages || typeof lock.packages !== 'object' || Array.isArray(lock.packages) || Object.keys(lock.packages).length !== 0) {
          badLocks.push(path.relative(ROOT, full));
        }
      }
    }
  };

  walk(path.join(ROOT, 'fixtures'));

  assert.deepEqual(oversized, [], 'fixture files over 64 KB bloat the eval corpus');
  assert.deepEqual(badLocks, [], 'fixture package-lock.json files must use empty packages stubs');
});

test('capture containment refuses outside targets before creating their parents', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pcf-capture-outside-'));
  try {
    const fixturesRoot = path.join(root, 'fixtures');
    fs.mkdirSync(fixturesRoot);
    const outsideParent = path.join(root, 'outside', 'parent');
    const outsideTarget = path.join(outsideParent, 'fixture');

    assert.throws(() => assertInsideFixtures(outsideTarget, { fixturesRoot }), /Refusing to write outside/);
    assert.equal(fs.existsSync(outsideParent), false, 'outside parent must not be created before refusal');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('capture containment refuses parent traversal targets', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pcf-capture-traversal-'));
  try {
    const fixturesRoot = path.join(root, 'fixtures');
    fs.mkdirSync(fixturesRoot);

    assert.throws(() => assertInsideFixtures(path.join(fixturesRoot, '..', 'escape'), { fixturesRoot }), /Refusing to write outside/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('capture containment allows fixture-internal targets', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pcf-capture-inside-'));
  try {
    const fixturesRoot = path.join(root, 'fixtures');
    fs.mkdirSync(fixturesRoot);
    const target = path.join(fixturesRoot, '099-captured');

    assert.doesNotThrow(() => assertInsideFixtures(target, { fixturesRoot }));
    assert.equal(fs.existsSync(fixturesRoot), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
