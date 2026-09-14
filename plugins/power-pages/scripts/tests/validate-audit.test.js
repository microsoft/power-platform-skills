#!/usr/bin/env node
/**
 * Tests for audit-permissions/scripts/validate-audit.js
 *
 * The validator's only job is to catch a report whose placeholders were never
 * populated. It used to hardcode `__FINDINGS_DATA__` / `__INVENTORY_DATA__`, so
 * when the template moved to the JSON-context tokens `__JSON_FINDINGS_DATA__` /
 * `__JSON_INVENTORY_DATA__` the check silently stopped matching anything and an
 * unpopulated report validated clean. These tests pin the placeholder grammar
 * rather than specific key names so the same drift cannot recur.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

const VALIDATOR = path.join(
  __dirname,
  '../../skills/audit-permissions/scripts/validate-audit.js'
);
const RENDERER = path.join(__dirname, '..', 'render-audit-report.js');
const TEMPLATE = path.join(
  __dirname,
  '../../skills/audit-permissions/assets/audit-report.html'
);

// Mirrors PLACEHOLDER_RE in scripts/lib/render-template.js.
const PLACEHOLDER_RE = /__(?:(?:HTML|ATTR|JSON|RAW)_)?[A-Z][A-Z0-9_]*__/g;

function makeProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'validate-audit-'));
  fs.writeFileSync(path.join(dir, 'powerpages.config.json'), '{}', 'utf8');
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
  return dir;
}

function writeReport(dir, html) {
  fs.writeFileSync(path.join(dir, 'docs', 'permissions-audit.html'), html, 'utf8');
}

function runValidator(cwd) {
  const result = spawnSync(process.execPath, [VALIDATOR], {
    input: JSON.stringify({ cwd }),
    encoding: 'utf8',
    timeout: 5000,
  });
  return { code: result.status, stderr: result.stderr || '' };
}

test('validate-audit: exits 0 when no report was generated', () => {
  assert.equal(runValidator(makeProject()).code, 0);
});

test('validate-audit: exits 0 for a report rendered by render-audit-report.js', () => {
  const dir = makeProject();
  const dataPath = path.join(dir, 'audit-data.json');
  fs.writeFileSync(
    dataPath,
    JSON.stringify({
      SITE_NAME: 'Contoso',
      AUDIT_DESC: 'Security audit of table permissions',
      SUMMARY: 'No critical findings.',
      FINDINGS_DATA: [],
      INVENTORY_DATA: [],
    }),
    'utf8'
  );
  const render = spawnSync(
    process.execPath,
    [RENDERER, '--output', path.join(dir, 'docs', 'permissions-audit.html'), '--data', dataPath],
    { encoding: 'utf8', timeout: 5000 }
  );
  assert.equal(render.status, 0, render.stderr);

  const result = runValidator(dir);
  assert.equal(result.code, 0, result.stderr);
});

test('validate-audit: blocks the JSON-context tokens the template actually uses', () => {
  const dir = makeProject();
  writeReport(dir, 'const FINDINGS = __JSON_FINDINGS_DATA__;\nconst INVENTORY = __JSON_INVENTORY_DATA__;');
  const result = runValidator(dir);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /__JSON_FINDINGS_DATA__/);
  assert.match(result.stderr, /__JSON_INVENTORY_DATA__/);
});

test('validate-audit: still blocks the legacy bare tokens', () => {
  const dir = makeProject();
  writeReport(dir, 'const FINDINGS = __FINDINGS_DATA__;');
  assert.equal(runValidator(dir).code, 2);
});

test('validate-audit: blocks unreplaced text placeholders, not just the data ones', () => {
  const dir = makeProject();
  writeReport(dir, '<title>Permissions Audit — __SITE_NAME__</title>');
  assert.equal(runValidator(dir).code, 2);
});

// The check is only safe to make grammar-wide if a correctly rendered report can never
// contain a matching token. That holds while every placeholder in the template maps to a
// key the renderer supplies, so assert that rather than assuming it.
test('validate-audit: every template placeholder maps to a renderer-supplied key', () => {
  const template = fs.readFileSync(TEMPLATE, 'utf8');
  const supplied = ['SITE_NAME', 'AUDIT_DESC', 'SUMMARY', 'FINDINGS_DATA', 'INVENTORY_DATA', 'CSP_NONCE'];
  const unsupported = [...new Set(template.match(PLACEHOLDER_RE) || [])].filter((token) => {
    const key = token.replace(/^__(?:(?:HTML|ATTR|JSON|RAW)_)?/, '').replace(/__$/, '');
    return !supplied.includes(key);
  });
  assert.deepEqual(unsupported, [], `Template placeholders with no renderer key: ${unsupported.join(', ')}`);
});
