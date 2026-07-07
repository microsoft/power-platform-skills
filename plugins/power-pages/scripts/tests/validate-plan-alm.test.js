const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRIPT = path.resolve(__dirname, '../../skills/plan-alm/scripts/validate-plan-alm.js');

/**
 * Runs validate-plan-alm.js with the given cwd passed as stdin JSON.
 * Returns { status, stderr }.
 */
function runValidator(cwd) {
  const result = spawnSync(process.execPath, [SCRIPT], {
    input: JSON.stringify({ cwd }),
    encoding: 'utf8',
    timeout: 5000,
  });
  return { status: result.status, stderr: result.stderr };
}

/**
 * Creates a temp project directory with powerpages.config.json so findProjectRoot resolves it.
 */
function makeTempProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-alm-test-'));
  fs.writeFileSync(path.join(dir, 'powerpages.config.json'), JSON.stringify({ siteName: 'test' }));
  return dir;
}

test('validate-plan-alm: approves when cwd has no powerpages.config.json (no project root)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-alm-no-root-'));
  try {
    const { status } = runValidator(dir);
    assert.equal(status, 0, 'Expected exit 0 when no project root found');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('validate-plan-alm: approves when docs/alm-plan.html does not exist', () => {
  const dir = makeTempProject();
  try {
    const { status } = runValidator(dir);
    assert.equal(status, 0, 'Expected exit 0 when alm-plan.html is absent');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('validate-plan-alm: blocks when docs/alm-plan.html is too small (< 500 bytes)', () => {
  const dir = makeTempProject();
  try {
    const docsDir = path.join(dir, 'docs');
    fs.mkdirSync(docsDir);
    fs.writeFileSync(path.join(docsDir, 'alm-plan.html'), '<html>tiny</html>');

    const { status, stderr } = runValidator(dir);
    assert.equal(status, 2, 'Expected exit 2 for too-small HTML file');
    assert.match(stderr, /too small/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('validate-plan-alm: blocks when docs/alm-plan.html lacks plan-status marker', () => {
  const dir = makeTempProject();
  try {
    const docsDir = path.join(dir, 'docs');
    fs.mkdirSync(docsDir);
    // Write > 500 bytes but no plan-status marker
    const content = '<!DOCTYPE html><html><head></head><body>' + 'x'.repeat(500) + '</body></html>';
    fs.writeFileSync(path.join(docsDir, 'alm-plan.html'), content);

    const { status, stderr } = runValidator(dir);
    assert.equal(status, 2, 'Expected exit 2 when plan-status marker is absent');
    assert.match(stderr, /plan-status/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('validate-plan-alm: approves valid docs/alm-plan.html with plan-status marker', () => {
  const dir = makeTempProject();
  try {
    const docsDir = path.join(dir, 'docs');
    fs.mkdirSync(docsDir);
    const content =
      '<!DOCTYPE html><html><head></head><body>' +
      '<span class="plan-status">Approved</span>' +
      'x'.repeat(500) +
      '</body></html>';
    fs.writeFileSync(path.join(docsDir, 'alm-plan.html'), content);

    const { status } = runValidator(dir);
    assert.equal(status, 0, 'Expected exit 0 for valid alm-plan.html');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('validate-plan-alm: approves gracefully when stdin is missing or malformed', () => {
  const result = spawnSync(process.execPath, [SCRIPT], {
    input: 'not-json',
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.equal(result.status, 0, 'Expected exit 0 on malformed stdin');
});

// --- consistency guard: PLAN_STATUS vs APPROVED_BY in docs/.alm-plan-data.json ---
//
// The badge + approver in the HTML are derived from plan-data, so the JSON is the
// source of truth. These cover the two half-written states the old hand-Edit Phase 4
// could leave behind (and that set-plan-status.js now prevents at the source).

// A valid rendered plan (> 500 bytes, has the plan-status marker) so the guard is
// reached, plus an optional .alm-plan-data.json with the given status fields.
function makeProjectWithPlan(planData) {
  const dir = makeTempProject();
  const docsDir = path.join(dir, 'docs');
  fs.mkdirSync(docsDir);
  fs.writeFileSync(
    path.join(docsDir, 'alm-plan.html'),
    '<!DOCTYPE html><html><body><span class="plan-status">X</span>' + 'x'.repeat(500) + '</body></html>',
  );
  if (planData !== undefined) {
    fs.writeFileSync(path.join(docsDir, '.alm-plan-data.json'), JSON.stringify(planData, null, 2));
  }
  return dir;
}

test('validate-plan-alm: blocks when APPROVED_BY is set but PLAN_STATUS is Draft (stuck state)', () => {
  const dir = makeProjectWithPlan({ PLAN_STATUS: 'Draft', APPROVED_BY: 'Jane Doe' });
  try {
    const { status, stderr } = runValidator(dir);
    assert.equal(status, 2, 'Expected exit 2 for approver-set-but-Draft');
    assert.match(stderr, /inconsistent/i);
    assert.match(stderr, /Jane Doe/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('validate-plan-alm: blocks when PLAN_STATUS is Approved but APPROVED_BY is empty', () => {
  const dir = makeProjectWithPlan({ PLAN_STATUS: 'Approved', APPROVED_BY: '' });
  try {
    const { status, stderr } = runValidator(dir);
    assert.equal(status, 2, 'Expected exit 2 for Approved-without-approver');
    assert.match(stderr, /APPROVED_BY is empty/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('validate-plan-alm: still blocks the stuck state when APPROVED_BY is a non-string (hand-edited)', () => {
  // Regression: a hand-edited plan-data could set APPROVED_BY to a truthy non-string
  // (a number/object). Before the String() coercion, `.trim()` threw, runValidation
  // swallowed the error and silently APPROVED — bypassing the guard. The coercion
  // keeps the Draft+approver stuck state caught (exit 2) instead of leaking through.
  const dir = makeProjectWithPlan({ PLAN_STATUS: 'Draft', APPROVED_BY: 123 });
  try {
    const { status, stderr } = runValidator(dir);
    assert.equal(status, 2, 'non-string approver must not bypass the guard via a thrown .trim()');
    assert.match(stderr, /inconsistent/i);
    assert.match(stderr, /123/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('validate-plan-alm: approves consistent Approved (status + approver) and Draft (no approver)', () => {
  for (const planData of [
    { PLAN_STATUS: 'Approved', APPROVED_BY: 'Jane' },
    { PLAN_STATUS: 'Draft', APPROVED_BY: '' },
  ]) {
    const dir = makeProjectWithPlan(planData);
    try {
      assert.equal(runValidator(dir).status, 0, `Expected exit 0 for ${planData.PLAN_STATUS}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('validate-plan-alm: approves a live plan (In Execution / Completed) regardless of approver', () => {
  for (const PLAN_STATUS of ['In Execution', 'Completed']) {
    const dir = makeProjectWithPlan({ PLAN_STATUS, APPROVED_BY: 'Jane' });
    try {
      assert.equal(runValidator(dir).status, 0, `Expected exit 0 for ${PLAN_STATUS}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('validate-plan-alm: approves (gracefully) when plan-data is malformed JSON', () => {
  const dir = makeProjectWithPlan();
  try {
    fs.writeFileSync(path.join(dir, 'docs', '.alm-plan-data.json'), 'not json {{{');
    assert.equal(runValidator(dir).status, 0, 'malformed plan-data is the renderer\'s concern, not this guard');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
