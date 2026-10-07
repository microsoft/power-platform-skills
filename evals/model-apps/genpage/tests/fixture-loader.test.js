'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadFixtures } = require('../lib/fixture-loader.js');

function temporaryFixture(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'genpage-evidence-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, '20-synthetic');
  fs.mkdirSync(dir);
  for (const [name, content] of Object.entries(files)) {
    // Keys may use either separator; split on both so Linux and macOS build the same tree
    // as Windows instead of one file named `create\name.txt`.
    const full = path.join(dir, ...name.split(/[\\/]/));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }
  return root;
}

test('fixture loader reads current synthetic contracts, associated results and exact artifact text', (t) => {
  const text = 'Revenue $100 $(Get-Date)\nSecond line\n';
  const root = temporaryFixture(t, {
    'fixture.json': JSON.stringify({ contractVersion: 2, provenance: 'synthetic', contracts: ['skills/genpage/SKILL.md Phase 6'], toolResults: 'tool-results.json', artifacts: ['create/name.txt', 'create/config.json'] }),
    'tool-results.json': JSON.stringify([{ id: 'create', command: 'node genpage-upload.js --name-file create/name.txt', result: { ok: true } }]),
    'create\\name.txt': text,
    'create\\config.json': '{"name":"Revenue $100 $(Get-Date)"}',
  });
  const fixture = loadFixtures(root)[0];
  assert.equal(fixture.contractVersion, 2);
  assert.equal(fixture.manifest.provenance, 'synthetic');
  assert.equal(fixture.events[0].id, 'create');
  assert.equal(fixture.artifacts['create/name.txt'], text);
});

test('fixture loader rejects malformed evidence, unknown contract versions and escaping paths', (t) => {
  for (const manifest of [
    { contractVersion: 99, provenance: 'synthetic' },
    { contractVersion: 2, provenance: 'captured', toolResults: 'tool-results.json' },
    { contractVersion: 2, provenance: 'synthetic', toolResults: '..\\outside.json' },
    { contractVersion: 2, provenance: 'synthetic', artifacts: ['C:\\outside.txt'] },
  ]) {
    const root = temporaryFixture(t, { 'fixture.json': JSON.stringify(manifest) });
    assert.throws(() => loadFixtures(root), /contract|synthetic|path|outside|artifact/i);
  }
  const root = temporaryFixture(t, {
    'fixture.json': JSON.stringify({ contractVersion: 2, provenance: 'synthetic', toolResults: 'tool-results.json' }),
    'tool-results.json': '[{"command":',
  });
  assert.throws(() => loadFixtures(root), /tool-results\.json|JSON/i);
});

test('all committed historical fixtures have an explicit replay contract without changing captures', () => {
  const root = path.join(__dirname, '..', 'fixtures');
  const catalog = JSON.parse(fs.readFileSync(path.join(root, 'contracts.json'), 'utf8'));
  const fixtures = loadFixtures(root);
  for (const fixture of fixtures) {
    assert.ok(Object.hasOwn(catalog, fixture.dirName) || fs.existsSync(path.join(fixture.dir, 'fixture.json')), `${fixture.dirName}: missing explicit contract label`);
    assert.ok([1, 2].includes(fixture.contractVersion), fixture.dirName);
    assert.ok(fixture.manifest.provenance, fixture.dirName);
    if (fixture.contractVersion === 1) assert.equal(fixture.manifest.provenance, 'historical');
    else {
      assert.equal(fixture.manifest.provenance, 'synthetic');
      assert.ok(fixture.manifest.description && fixture.manifest.contracts.length, fixture.dirName);
    }
  }
});

test('current entity log name is loaded with an intentional legacy fallback', (t) => {
  const root = temporaryFixture(t, {
    'genpage-entity-creation-log.md': 'Current log\n',
    'entity-creation-log.md': 'Legacy log\n',
  });
  assert.equal(loadFixtures(root)[0].entityCreationLog, 'Current log\n');
  fs.unlinkSync(path.join(root, '20-synthetic', 'genpage-entity-creation-log.md'));
  assert.equal(loadFixtures(root)[0].entityCreationLog, 'Legacy log\n');
});

test('current entity log loads without a legacy file and a missing log stays absent', (t) => {
  const root = temporaryFixture(t, { 'genpage-entity-creation-log.md': 'Current-only log\n' });
  assert.equal(loadFixtures(root)[0].entityCreationLog, 'Current-only log\n');
  fs.unlinkSync(path.join(root, '20-synthetic', 'genpage-entity-creation-log.md'));
  assert.equal(loadFixtures(root)[0].entityCreationLog, null);
});

test('an empty current entity log must not borrow a historical transaction log', (t) => {
  const root = temporaryFixture(t, {
    'genpage-entity-creation-log.md': '',
    'entity-creation-log.md': 'Transactions from a historical run\n',
  });
  assert.equal(loadFixtures(root)[0].entityCreationLog, '');
  fs.writeFileSync(path.join(root, '20-synthetic', 'genpage-entity-creation-log.md'), 'Fresh transactions\n');
  assert.equal(loadFixtures(root)[0].entityCreationLog, 'Fresh transactions\n');
});
