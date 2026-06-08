'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const VALIDATOR = path.join(
  __dirname, '..', '..',
  'skills', 'plan-inner-loop', 'scripts', 'validate-plan-inner-loop.js',
);

function mkTempProject(setup) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-inner-loop-validator-'));
  // Make it look like a Power Pages project root (findProjectRoot looks for
  // powerpages.config.json OR .powerpages-site OR powerpages.bundle.json — the
  // simplest marker is powerpages.config.json)
  fs.writeFileSync(path.join(dir, 'powerpages.config.json'), JSON.stringify({
    $schema: 'https://aka.ms/powerpages-config',
    siteName: 'test', compiledPath: 'dist', defaultLandingPage: 'index.html',
  }));
  if (setup) setup(dir);
  return dir;
}

function runValidator(cwd) {
  return spawnSync(process.execPath, [VALIDATOR], {
    input: JSON.stringify({ cwd }),
    encoding: 'utf8',
    timeout: 5000,
  });
}

test('validate-plan-inner-loop: validator file exists and is executable', () => {
  assert.ok(fs.existsSync(VALIDATOR));
  const content = fs.readFileSync(VALIDATOR, 'utf8');
  assert.match(content, /runValidation/);
  assert.match(content, /plan-status/);
});

test('validate-plan-inner-loop: missing project root → approves silently', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-no-project-'));
  try {
    const r = runValidator(dir);
    assert.equal(r.status, 0, `stderr was: ${r.stderr}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('validate-plan-inner-loop: HTML missing → approves silently', () => {
  const dir = mkTempProject();
  try {
    const r = runValidator(dir);
    assert.equal(r.status, 0, `stderr was: ${r.stderr}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('validate-plan-inner-loop: HTML present and well-formed → approves', () => {
  const dir = mkTempProject((d) => {
    const htmlDir = path.join(d, 'docs', 'inner-loop');
    fs.mkdirSync(htmlDir, { recursive: true });
    // Has to be ≥ 500 bytes AND contain "plan-status"
    const html = '<!DOCTYPE html><html><head><title>x</title></head><body>'
      + '<span class="plan-status clean">Clean</span>'
      + 'x'.repeat(600)
      + '</body></html>';
    fs.writeFileSync(path.join(htmlDir, 'inner-loop-plan.html'), html);
  });
  try {
    const r = runValidator(dir);
    assert.equal(r.status, 0, `stderr was: ${r.stderr}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('validate-plan-inner-loop: HTML too small → blocks (exit 2)', () => {
  const dir = mkTempProject((d) => {
    const htmlDir = path.join(d, 'docs', 'inner-loop');
    fs.mkdirSync(htmlDir, { recursive: true });
    fs.writeFileSync(path.join(htmlDir, 'inner-loop-plan.html'), '<html></html>');
  });
  try {
    const r = runValidator(dir);
    assert.equal(r.status, 2);
    assert.match(r.stderr + r.stdout, /too small/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('validate-plan-inner-loop: HTML missing plan-status marker → blocks (exit 2)', () => {
  const dir = mkTempProject((d) => {
    const htmlDir = path.join(d, 'docs', 'inner-loop');
    fs.mkdirSync(htmlDir, { recursive: true });
    fs.writeFileSync(
      path.join(htmlDir, 'inner-loop-plan.html'),
      '<!DOCTYPE html><html><body>' + 'x'.repeat(600) + '</body></html>',
    );
  });
  try {
    const r = runValidator(dir);
    assert.equal(r.status, 2);
    assert.match(r.stderr + r.stdout, /plan-status/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('validate-plan-inner-loop: malformed stdin → approves silently', () => {
  const r = spawnSync(process.execPath, [VALIDATOR], {
    input: 'not-json',
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.equal(r.status, 0);
});
