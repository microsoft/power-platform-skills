const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

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
    [scriptPath, '--projectRoot', projectRoot, '--data', review.data],
    { encoding: 'utf8' }
  );
}

test('publishes validated JSON, rendered HTML, hashes, and an execution receipt', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'customization-promote-'));
  const review = writeReview(root, 'review-one');
  const result = promote(root, review);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const output = JSON.parse(result.stdout);
  const planRoot = path.join(root, 'docs', 'customize-declarative-site');
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(planRoot, 'current-plan.json'), 'utf8')),
    review.plan
  );
  assert.match(
    fs.readFileSync(path.join(planRoot, 'current-plan.html'), 'utf8'),
    /Contoso Event Portal/
  );
  const execution = JSON.parse(
    fs.readFileSync(path.join(planRoot, 'current-execution.json'), 'utf8')
  );
  assert.equal(execution.runId, output.runId);
  assert.equal(execution.planHash, output.planHash);
  assert.match(execution.artifactHashes.planSha256, /^[a-f0-9]{64}$/);
  assert.match(execution.artifactHashes.htmlSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(
    execution.operations.map(({ id, status }) => ({ id, status })),
    [
      { id: 'add-speaker-images', status: 'pending' },
      { id: 'create-speakers-page', status: 'pending' },
    ]
  );
});

test('archives the previous plan, rendered HTML, execution receipt, and icon', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'customization-promote-'));
  const first = writeReview(root, 'review-one');
  const second = writeReview(root, 'review-two', (plan) => {
    plan.summary = 'Second approved plan';
    return plan;
  });

  assert.equal(promote(root, first).status, 0);
  const result = promote(root, second);
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const planRoot = path.join(root, 'docs', 'customize-declarative-site');
  const historyEntries = fs.readdirSync(path.join(planRoot, 'history'));
  assert.equal(historyEntries.length, 1);
  const archived = path.join(planRoot, 'history', historyEntries[0]);
  for (const file of ['plan.json', 'plan.html', 'execution.json', 'power-pages-icon.png']) {
    assert.equal(fs.existsSync(path.join(archived, file)), true, file);
  }
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
