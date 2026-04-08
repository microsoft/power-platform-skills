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
