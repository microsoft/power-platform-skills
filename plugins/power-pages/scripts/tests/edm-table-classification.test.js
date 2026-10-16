const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const classification = require('../../skills/migrate-datamodel/scripts/lib/edm-table-classification');

test('nonconfiguration categories are excluded while poll placements remain comparable', () => {
  assert.deepEqual(classification.NONCONFIGURATION_TABLES.map(({ table }) => table), [
    'Ad',
    'Poll',
    'Poll Submission',
    'External Identity',
    'Portal comment',
    'Invitation',
    'Invitation Redemption',
    'Setting',
    'WebFormSession',
  ]);
  assert.equal(classification.isNonconfigurationCategory('polls'), true);
  assert.equal(classification.isNonconfigurationCategory('ads'), true);
  assert.equal(classification.isNonconfigurationCategory('pollPlacements'), false);
  assert.equal(classification.isReportExcludedCategory('polls'), true);
  assert.equal(classification.isReportExcludedCategory('pollPlacements'), false);
});

test('poll metadata describes the separate compatibility warning', () => {
  assert.deepEqual(classification.getCategoryMetadata('polls'), {
    label: 'Polls',
    reason: 'Polls are nonconfiguration data and are removed from the enhanced data model.',
  });
});

test('snapshot diff excludes polls from failure totals but compares poll placements', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'edm-diff-'));
  const sdmPath = path.join(tempDir, 'sdm.json');
  const edmPath = path.join(tempDir, 'edm.json');
  const sdm = {
    label: 'sdm',
    inventory: {
      polls: [{ name: 'Yes or No Question' }],
      pollPlacements: [{ name: 'Home' }],
      webPages: [{ name: 'Home', kind: 'parent', partialUrl: '/', language: '' }],
    },
  };
  const edm = {
    label: 'edm',
    inventory: {
      polls: [],
      pollPlacements: [{ name: 'Home' }],
      webPages: [{ name: 'Home', kind: 'parent', partialUrl: '/', language: '' }],
    },
  };
  fs.writeFileSync(sdmPath, JSON.stringify(sdm));
  fs.writeFileSync(edmPath, JSON.stringify(edm));

  const result = spawnSync(process.execPath, [
    path.join(__dirname, '../../skills/migrate-datamodel/scripts/diff-snapshots.js'),
    '--sdm', sdmPath,
    '--edm', edmPath,
    '--output-dir', tempDir,
  ], { encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const diff = JSON.parse(fs.readFileSync(path.join(tempDir, 'migration-data-diff.json'), 'utf8'));
  assert.equal(diff.overallStatus, 'pass');
  assert.equal(diff.categories.polls.status, 'excluded');
  assert.equal(diff.categories.polls.sdmCount, 1);
  assert.equal(diff.categories.pollPlacements.status, 'pass');
  assert.equal(diff.summary.totalMissing, 0);
});
