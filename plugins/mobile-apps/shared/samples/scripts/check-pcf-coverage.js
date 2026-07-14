#!/usr/bin/env node
'use strict';

/**
 * check-pcf-coverage.js
 *
 * Verifies that every approved Canvas PCF disposition is represented by real
 * screen code. PCF binaries cannot run in the native host, so generated code
 * must carry an exact source-pcf/source-pcf-unsupported marker at the native
 * replacement, generated-service integration, or visible unsupported state.
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = process.cwd();
const STRICT = process.argv.includes('--strict') || process.env.STRICT === '1';
const PLAN_PATH = path.join(ROOT, 'pcf-plan.json');
const INPUT_PATH = path.join(ROOT, 'mobile-plugin-input.json');

if (!fs.existsSync(PLAN_PATH)) {
  console.log('[pcf] pcf-plan.json not found - skipping');
  process.exit(0);
}

const plan = JSON.parse(fs.readFileSync(PLAN_PATH, 'utf8'));
const rows = Array.isArray(plan.controls) ? plan.controls : [];
if (plan.discovery?.complete === false) {
  console.error('[pcf] PCF discovery is incomplete; per-control approval/coverage cannot be verified');
  process.exit(1);
}
if (rows.length === 0) {
  console.log('[pcf] no PCF controls detected');
  process.exit(0);
}

const screenFiles = new Map();
if (fs.existsSync(INPUT_PATH)) {
  const input = JSON.parse(fs.readFileSync(INPUT_PATH, 'utf8'));
  for (const screen of input.screenPlan?.screens || []) {
    if (!screen?.name || typeof screen.file !== 'string') continue;
    const resolved = path.resolve(ROOT, screen.file);
    const relative = path.relative(ROOT, resolved);
    const contained = relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
    if (contained) screenFiles.set(screen.name, resolved);
  }
}

function marker(prefix, row) {
  const escaped = String(row.pcfId || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`${prefix}:\\s*${escaped}(?![a-z0-9-])`, 'i');
}

function implementationMarker(row) {
  const escapedId = String(row.pcfId || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapedDisposition = String(row.approval?.disposition || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`source-pcf:\\s*${escapedId}\\s+${escapedDisposition}(?![a-z0-9-])`, 'i');
}

function unsupportedUxAfterMarker(row, text) {
  const match = marker('source-pcf-unsupported', row).exec(text);
  if (!match) return false;
  const lineEnd = text.indexOf('\n', match.index + match[0].length);
  if (lineEnd < 0) return false;
  const window = text.slice(lineEnd + 1, lineEnd + 4001)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  const unavailable = '(?:unsupported|unavailable|not available)';
  // Require direct JSX text or a UI-facing prop value. A nearby comment,
  // arbitrary dead string, or TODO does not prove visible unavailable UX.
  const jsxText = new RegExp(`>[^<>{}]{0,500}${unavailable}[^<>{}]{0,500}<`, 'i');
  const uiProp = new RegExp(`(?:children|title|message|label|accessibilityLabel|description|subtitle)\\s*=\\s*(?:["'][^"']{0,500}${unavailable}[^"']{0,500}["']|\\{["'][^"']{0,500}${unavailable}[^"']{0,500}["']\\})`, 'i');
  return jsxText.test(window) || uiProp.test(window);
}

const findings = [];
let implemented = 0;
let unsupported = 0;
for (const row of rows) {
  const approval = row.approval || {};
  if (approval.status !== 'approved') {
    findings.push(`${row.pcfId}: approval status is ${approval.status || 'missing'}`);
    continue;
  }
  if (approval.disposition === 'blocker') {
    findings.push(`${row.pcfId}: approved disposition is blocker`);
    continue;
  }
  const file = screenFiles.get(row.screen);
  if (!file || !fs.existsSync(file)) {
    findings.push(`${row.pcfId}: native screen file is missing for ${row.screen}`);
    continue;
  }
  const text = fs.readFileSync(file, 'utf8');
  if (approval.disposition === 'explicit-unsupported') {
    if (!unsupportedUxAfterMarker(row, text)) {
      findings.push(`${row.pcfId}: explicit unsupported decision lacks marker plus visible unavailable UX`);
      continue;
    }
    unsupported += 1;
    continue;
  }
  if (!implementationMarker(row).test(text)) {
    findings.push(`${row.pcfId}: ${approval.disposition} lacks exact source-pcf ID/disposition marker in ${path.relative(ROOT, file)}`);
    continue;
  }
  implemented += 1;
}

console.log('\n=== PCF disposition coverage ===');
console.log(`PCFs: ${rows.length} | implemented: ${implemented} | explicit unsupported: ${unsupported} | findings: ${findings.length}`);
for (const finding of findings) console.log(`- ${finding}`);

if (STRICT && findings.length > 0) {
  console.error(`\n[pcf] ${findings.length} PCF disposition issue(s) - STRICT mode failure`);
  process.exit(1);
}
process.exit(0);
