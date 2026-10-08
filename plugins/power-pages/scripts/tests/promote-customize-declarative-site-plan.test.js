const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { renderReviewedPlan } = require('../render-customize-declarative-site-plan');
const { updateExecution } = require('../update-customize-declarative-site-execution');
const { hashText, planHash } = require('../lib/customize-declarative-site-plan');
const { externalImagePlan, successfulImageCheck } = require('./customization-plan-test-helpers');

const scriptPath = path.join(__dirname, '..', 'promote-customize-declarative-site-plan.js');
const fixturePath = path.join(
  __dirname,
  'fixtures',
  'customize-declarative-site-plan.json'
);

function writeReview(root, name, mutate = (plan) => plan) {
  const reviewRoot = path.join(root, name);
  fs.mkdirSync(reviewRoot, { recursive: true });
  const plan = mutate(JSON.parse(fs.readFileSync(fixturePath, 'utf8')));
  const data = path.join(reviewRoot, 'plan.json');
  fs.writeFileSync(data, JSON.stringify(plan, null, 2), 'utf8');
  return { data, plan };
}

function promote(projectRoot, review) {
  return spawnSync(
    process.execPath,
    [scriptPath, '--projectRoot', projectRoot, '--data', review.data,
      ...(review.imageChecks ? ['--imageChecks', review.imageChecks] : [])],
    { encoding: 'utf8' }
  );
}

test('published technical JSON, trace-free HTML, hashes and receipt survive review cleanup', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'customization-promote-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const review = writeReview(root, 'review-one');
  const rendered = await renderReviewedPlan(review.plan, path.join(root, 'review-one', 'plan.html'), {
    check: successfulImageCheck,
  });
  review.imageChecks = rendered.imageChecks;
  const reviewedHtml = fs.readFileSync(rendered.output, 'utf8');
  const result = promote(root, review);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  fs.rmSync(path.dirname(review.data), { recursive: true, force: true });
  const output = JSON.parse(result.stdout);
  const planRoot = path.join(root, 'docs', 'customize-declarative-site');
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(planRoot, 'current-plan.json'), 'utf8')),
    review.plan
  );
  const html = fs.readFileSync(path.join(planRoot, 'current-plan.html'), 'utf8');
  assert.equal(html, reviewedHtml);
  assert.match(html, /Contoso Event Portal/);
  assert.doesNotMatch(html, /Technical implementation trace|technicalDetails|technicalOperations/);
  const execution = JSON.parse(
    fs.readFileSync(path.join(planRoot, 'current-execution.json'), 'utf8')
  );
  assert.equal(execution.runId, output.runId);
  assert.equal(execution.planHash, output.planHash);
  assert.equal(execution.artifactHashes.planSha256, planHash(review.plan));
  assert.equal(execution.artifactHashes.htmlSha256, hashText(html));
  assert.deepEqual(
    execution.operations.map(({ id, status }) => ({ id, status })),
    [
      { id: 'add-speaker-images', status: 'pending' },
      { id: 'create-speakers-page', status: 'pending' },
    ]
  );
});

test('archives the complete technical plan, HTML, receipt and icon after review cleanup', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'customization-promote-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const first = writeReview(root, 'review-one');
  const second = writeReview(root, 'review-two', (plan) => {
    plan.summary = 'Second approved plan';
    return plan;
  });

  assert.equal(promote(root, first).status, 0);
  const planRoot = path.join(root, 'docs', 'customize-declarative-site');
  const firstHtml = fs.readFileSync(path.join(planRoot, 'current-plan.html'), 'utf8');
  const firstExecution = fs.readFileSync(path.join(planRoot, 'current-execution.json'), 'utf8');
  fs.rmSync(path.dirname(first.data), { recursive: true, force: true });
  const result = promote(root, second);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  fs.rmSync(path.dirname(second.data), { recursive: true, force: true });

  const historyEntries = fs.readdirSync(path.join(planRoot, 'history'));
  assert.equal(historyEntries.length, 1);
  const archived = path.join(planRoot, 'history', historyEntries[0]);
  for (const file of ['plan.json', 'plan.html', 'execution.json', 'power-pages-icon.png']) {
    assert.equal(fs.existsSync(path.join(archived, file)), true, file);
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(archived, 'plan.json'), 'utf8')), first.plan);
  assert.equal(fs.readFileSync(path.join(archived, 'plan.html'), 'utf8'), firstHtml);
  assert.equal(fs.readFileSync(path.join(archived, 'execution.json'), 'utf8'), firstExecution);
  assert.doesNotMatch(firstHtml, /Technical implementation trace|technicalDetails|technicalOperations/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(planRoot, 'current-plan.json'), 'utf8')), second.plan);
  assert.match(fs.readFileSync(path.join(planRoot, 'current-plan.html'), 'utf8'), /Second approved/);
});

test('rejects a syntactically valid but schema-invalid plan before replacing current state', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'customization-promote-'));
  const valid = writeReview(root, 'review-one');
  assert.equal(promote(root, valid).status, 0);
  const before = fs.readFileSync(
    path.join(root, 'docs', 'customize-declarative-site', 'current-plan.json'),
    'utf8'
  );

  const invalid = writeReview(root, 'review-two', () => ({ schemaVersion: 1, summary: 'Invalid' }));
  const result = promote(root, invalid);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Missing required plan keys/);
  assert.equal(
    fs.readFileSync(
      path.join(root, 'docs', 'customize-declarative-site', 'current-plan.json'),
      'utf8'
    ),
    before
  );
});

test('does not accept an independently supplied HTML document', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'customization-promote-'));
  const review = writeReview(root, 'review-one');
  const unrelatedHtml = path.join(root, 'unrelated.html');
  fs.writeFileSync(unrelatedHtml, '<html>unrelated</html>', 'utf8');

  const result = spawnSync(
    process.execPath,
    [
      scriptPath,
      '--projectRoot',
      root,
      '--data',
      review.data,
      '--html',
      unrelatedHtml,
    ],
    { encoding: 'utf8' }
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.doesNotMatch(
    fs.readFileSync(
      path.join(root, 'docs', 'customize-declarative-site', 'current-plan.html'),
      'utf8'
    ),
    /unrelated/
  );
});

test('external images require matching pre-approval checks that are reused during publication and execution', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'image-check-publication-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const review = writeReview(root, 'review', () => externalImagePlan());
  const missing = promote(root, review);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /require --imageChecks/);
  assert.equal(fs.existsSync(path.join(root, 'docs')), false);
  let calls = 0;
  const rendered = await renderReviewedPlan(review.plan, path.join(root, 'review', 'plan.html'), {
    check: async (url) => { calls++; return successfulImageCheck(url); },
  });
  review.imageChecks = rendered.imageChecks;
  const result = promote(root, review);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(fs.readFileSync(review.imageChecks, 'utf8'));
  fs.rmSync(path.dirname(review.data), { recursive: true, force: true });
  const execution = updateExecution({ projectRoot: root, action: 'status' });
  assert.deepEqual(execution.imageChecks, report);
  const resolved = updateExecution({ projectRoot: root, action: 'resolve', operationId: review.plan.operations[0].id });
  assert.deepEqual(resolved.imageChecks, report);
  assert.deepEqual(resolved.resolvedInputs, review.plan.operations[0].inputs);
  assert.equal(calls, 1);
  assert.equal(fs.existsSync(path.join(root, '.powerpages-customization')), false);
  assert.match(fs.readFileSync(path.join(root, 'docs', 'customize-declarative-site', 'current-plan.html'), 'utf8'), /Image source checks passed before review/);
});

test('stale or failed image checks leave the current approved run unchanged', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stale-image-checks-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const current = writeReview(root, 'baseline');
  assert.equal(promote(root, current).status, 0);
  const currentPath = path.join(root, 'docs', 'customize-declarative-site', 'current-plan.json');
  const before = fs.readFileSync(currentPath, 'utf8');
  const review = writeReview(root, 'review', () => externalImagePlan());
  const rendered = await renderReviewedPlan(review.plan, path.join(root, 'review', 'plan.html'), { check: successfulImageCheck });
  review.imageChecks = rendered.imageChecks;
  const report = JSON.parse(fs.readFileSync(review.imageChecks, 'utf8'));
  report.images[0].statusCode = 404;
  fs.writeFileSync(review.imageChecks, JSON.stringify(report));
  const failed = promote(root, review);
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /failed or invalid/);
  report.images[0].statusCode = 200;
  fs.writeFileSync(review.imageChecks, JSON.stringify(report));
  review.plan.operations[0].inputs.images[0] = 'https://cdn.example.com/different.png';
  review.plan.assets[0].externalUrl = review.plan.operations[0].inputs.images[0];
  fs.writeFileSync(review.data, JSON.stringify(review.plan));
  const stale = promote(root, review);
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /stale image checks/);
  assert.equal(fs.readFileSync(currentPath, 'utf8'), before);
  assert.equal(fs.existsSync(path.join(root, 'docs', 'customize-declarative-site', 'history')), false);
});
