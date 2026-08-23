'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const script = path.resolve(
  __dirname,
  '..',
  '..',
  'skills',
  'design-system',
  'scripts',
  'finalize-design-decision.js',
);

function write(root, relativePath, value) {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
}

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function run(root, action) {
  return spawnSync(process.execPath, [script, root, action], { encoding: 'utf8' });
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'design-decision-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const brief = 'Indoor equipment maintenance for technicians with scan-first lookup.\n';
  write(root, 'brief.md', brief);
  write(root, 'native-app-plan.md', '# Equipment care\n\n## Design\n\n### Planner Recommendation\n');
  write(root, '.tmp/design-recommendation.json', {
    schemaVersion: 1,
    status: 'recommendation-only',
    direction: 'polished-inspection',
    rationale: 'Indoor asset maintenance needs calm, status-first field software.',
    confidence: 'high',
    source: 'brief',
    briefSha256: hash(brief),
    theme: {
      tone: 'professional',
      primary: '#9A531F safety amber',
      support: ['#1F2933 graphite', '#F4F1EA warm off-white'],
      radius: 'rounded',
      density: 'comfortable',
      feeling: 'Durable indoor field software.',
    },
  });
  write(root, 'brand/design-system.md', '# Equipment Care Design System\n');
  write(root, 'brand/tokens.ts', 'export const tokens = { color: { primary: "#9A531F" } } as const;\n');
  write(root, 'brand/design-system.html', '<!doctype html><title>Equipment Care</title>\n');
  write(root, '.tmp/design-decision-input.json', {
    schemaVersion: 1,
    selectedDirection: 'polished-inspection',
    selectionSource: {
      kind: 'planner-recommendation',
      label: 'Planner recommendation',
    },
    confirmationStatus: 'confirmed',
  });
  return root;
}

test('finalizes and verifies a confirmed planner recommendation with file hashes', (t) => {
  const root = fixture(t);
  const finalized = run(root, 'finalize');
  assert.equal(finalized.status, 0, finalized.stderr);

  const decisionPath = path.join(root, 'brand', 'design-decision.json');
  const decision = JSON.parse(fs.readFileSync(decisionPath, 'utf8'));
  assert.equal(decision.recommendation.direction, 'polished-inspection');
  assert.match(decision.recommendation.rationale, /Indoor asset maintenance/);
  assert.equal(decision.finalSelection.sourceKind, 'planner-recommendation');
  assert.equal(decision.userConfirmation.status, 'confirmed');
  assert.match(decision.files.designSystem.sha256, /^[a-f0-9]{64}$/);
  assert.match(decision.files.tokens.sha256, /^[a-f0-9]{64}$/);
  assert.match(decision.files.gallery.sha256, /^[a-f0-9]{64}$/);
  assert.match(decision.integritySha256, /^[a-f0-9]{64}$/);

  const checked = run(root, 'check');
  assert.equal(checked.status, 0, checked.stderr);

  write(root, 'brand/tokens.ts', 'export const tokens = { color: { primary: "#000000" } } as const;\n');
  const stale = run(root, 'check');
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /tokens hash is stale/);
});

test('preserves planner rationale when user design input overrides direction', (t) => {
  const root = fixture(t);
  write(root, '.tmp/design-decision-input.json', {
    schemaVersion: 1,
    selectedDirection: 'custom-brand',
    selectionSource: {
      kind: 'brand-doc',
      label: '/Users/example/Documents/brand.md',
    },
    confirmationStatus: 'draft',
  });

  const finalized = run(root, 'finalize');
  assert.equal(finalized.status, 0, finalized.stderr);
  const decision = JSON.parse(fs.readFileSync(path.join(root, 'brand/design-decision.json'), 'utf8'));
  assert.equal(decision.recommendation.direction, 'polished-inspection');
  assert.equal(decision.finalSelection.direction, 'custom-brand');
  assert.equal(decision.finalSelection.sourceKind, 'brand-doc');
  assert.equal(decision.finalSelection.sourceLabel, 'brand.md');
  assert.equal(decision.userConfirmation.status, 'draft');
});

test('rejects recommendation drift and planner-source direction changes', (t) => {
  const root = fixture(t);
  const recommendationPath = path.join(root, '.tmp/design-recommendation.json');
  const recommendation = JSON.parse(fs.readFileSync(recommendationPath, 'utf8'));
  recommendation.briefSha256 = '0'.repeat(64);
  write(root, '.tmp/design-recommendation.json', recommendation);

  const staleBrief = run(root, 'finalize');
  assert.equal(staleBrief.status, 1);
  assert.match(staleBrief.stderr, /briefSha256 does not match/);

  recommendation.briefSha256 = hash(fs.readFileSync(path.join(root, 'brief.md')));
  write(root, '.tmp/design-recommendation.json', recommendation);
  write(root, '.tmp/design-decision-input.json', {
    schemaVersion: 1,
    selectedDirection: 'product',
    selectionSource: {
      kind: 'planner-recommendation',
      label: 'Planner recommendation',
    },
    confirmationStatus: 'confirmed',
  });
  const changedDirection = run(root, 'finalize');
  assert.equal(changedDirection.status, 1);
  assert.match(changedDirection.stderr, /must reuse the recommended direction exactly/);
});
