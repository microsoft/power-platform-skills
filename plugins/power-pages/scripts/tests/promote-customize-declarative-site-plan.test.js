const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const scriptPath = path.join(__dirname, '..', 'promote-customize-declarative-site-plan.js');

function writeReview(root, name, summary) {
  const reviewRoot = path.join(root, name);
  fs.mkdirSync(reviewRoot, { recursive: true });
  const data = path.join(reviewRoot, 'plan.json');
  const html = path.join(reviewRoot, 'plan.html');
  fs.writeFileSync(data, JSON.stringify({ schemaVersion: 1, summary }), 'utf8');
  fs.writeFileSync(html, `<html><body>${summary}</body></html>`, 'utf8');
  fs.writeFileSync(path.join(reviewRoot, 'power-pages-icon.png'), `icon-${summary}`, 'utf8');
  return { data, html };
}

function promote(projectRoot, review) {
  return spawnSync(
    process.execPath,
    [
      scriptPath,
      '--projectRoot',
      projectRoot,
      '--data',
      review.data,
      '--html',
      review.html,
    ],
    { encoding: 'utf8' }
  );
}

test('promotes the first approved plan to canonical current paths', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'customization-promote-'));
  const review = writeReview(root, 'review-one', 'First approved plan');
  const result = promote(root, review);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const planRoot = path.join(root, 'docs', 'customize-declarative-site');
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(planRoot, 'current-plan.json'), 'utf8')),
    { schemaVersion: 1, summary: 'First approved plan' }
  );
  assert.match(fs.readFileSync(path.join(planRoot, 'current-plan.html'), 'utf8'), /First approved/);
  assert.equal(
    fs.readFileSync(path.join(planRoot, 'power-pages-icon.png'), 'utf8'),
    'icon-First approved plan'
  );
  assert.equal(fs.existsSync(path.join(planRoot, 'history')), false);
});

test('archives the previous approved plan before replacing current paths', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'customization-promote-'));
  const first = writeReview(root, 'review-one', 'First approved plan');
  const second = writeReview(root, 'review-two', 'Second approved plan');

  assert.equal(promote(root, first).status, 0);
  const result = promote(root, second);
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const planRoot = path.join(root, 'docs', 'customize-declarative-site');
  const historyEntries = fs.readdirSync(path.join(planRoot, 'history'));
  assert.equal(historyEntries.length, 1);
  const archived = path.join(planRoot, 'history', historyEntries[0]);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(archived, 'plan.json'), 'utf8')),
    { schemaVersion: 1, summary: 'First approved plan' }
  );
  assert.match(fs.readFileSync(path.join(archived, 'plan.html'), 'utf8'), /First approved/);
  assert.equal(
    fs.readFileSync(path.join(archived, 'power-pages-icon.png'), 'utf8'),
    'icon-First approved plan'
  );
  assert.match(fs.readFileSync(path.join(planRoot, 'current-plan.html'), 'utf8'), /Second approved/);
});

test('refuses to replace an incomplete canonical plan pair', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'customization-promote-'));
  const review = writeReview(root, 'review-one', 'Approved plan');
  const planRoot = path.join(root, 'docs', 'customize-declarative-site');
  fs.mkdirSync(planRoot, { recursive: true });
  fs.writeFileSync(path.join(planRoot, 'current-plan.json'), '{}', 'utf8');

  const result = promote(root, review);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Canonical plan is incomplete/);
  assert.equal(fs.existsSync(path.join(planRoot, 'current-plan.html')), false);
});
