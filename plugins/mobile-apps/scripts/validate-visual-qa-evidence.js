#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const STRICT_FIDELITIES = new Set(['high', 'strict-structural']);
const PASS_VALUES = new Set(['pass', 'passed']);
const FAILURE_VALUES = new Set(['fail', 'failed', 'blocked', 'needs-attention', 'needs attention']);

function normalize(value) {
  return String(value || '').trim().toLowerCase();
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--project-root') args.projectRoot = argv[++index];
    else if (arg === '--plan') args.plan = argv[++index];
    else if (arg === '--manifest') args.manifest = argv[++index];
    else if (arg === '--json') args.json = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
  }
  return args;
}

function productExperience(markdown) {
  const lines = String(markdown || '').split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === '## Product Experience');
  if (start < 0) return '';
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^##\s+/.test(lines[index])) {
      end = index;
      break;
    }
  }
  return lines.slice(start + 1, end).join('\n');
}

function referenceFidelity(plan) {
  const match = /(?:^|\n)\s*-\s+(?:\*\*)?Reference fidelity(?:\*\*)?\s*([^\n]+)/i.exec(productExperience(plan));
  return normalize(match ? match[1].replace(/[*`]/g, '') : 'none');
}

function isPass(value) {
  return PASS_VALUES.has(normalize(value));
}

function isFailure(value) {
  return FAILURE_VALUES.has(normalize(value));
}

function rowResult(row) {
  return row && (row.result || row.status || row.outcome);
}

function homeCapture(captures, platform, dynamicType) {
  return captures.some((capture) => {
    const screen = normalize(capture.screen || capture.route || capture.name);
    const capturePlatform = normalize(capture.platform);
    const size = normalize(capture.dynamicType || capture.textSize || capture.fontScale);
    const isHome = screen === 'home' || /(?:^|\/)home(?:$|[?#])/.test(screen);
    const isLarge = size === 'large' || size === 'larger' || Number(capture.fontScale) >= 1.3;
    return isHome && capturePlatform === platform && (dynamicType ? isLarge : !isLarge) && isPass(rowResult(capture));
  });
}

function validateVisualQaEvidence(manifest, fidelity) {
  const issues = [];
  if (!STRICT_FIDELITIES.has(normalize(fidelity))) return issues;
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return [{ rule: 'invalid-manifest', message: 'Visual QA evidence must be a JSON object.' }];
  }
  if (manifest.schemaVersion !== 1) issues.push({ rule: 'invalid-schema-version', message: 'Visual QA evidence requires schemaVersion: 1.' });
  if (normalize(manifest.referenceFidelity) !== normalize(fidelity)) {
    issues.push({ rule: 'reference-fidelity-drift', message: `Manifest referenceFidelity must match plan (${fidelity}).` });
  }
  const captures = Array.isArray(manifest.captureMatrix) ? manifest.captureMatrix : [];
  if (!captures.length) issues.push({ rule: 'missing-capture-matrix', message: 'High/strict reference fidelity requires captureMatrix evidence.' });
  for (const platform of ['ios', 'android']) {
    if (!homeCapture(captures, platform, false)) {
      issues.push({ rule: 'missing-platform-home-capture', message: `Missing passing default-text Home capture for ${platform}.`, platform });
    }
  }
  if (!captures.some((capture) => {
    const screen = normalize(capture.screen || capture.route || capture.name);
    const size = normalize(capture.dynamicType || capture.textSize || capture.fontScale);
    const isHome = screen === 'home' || /(?:^|\/)home(?:$|[?#])/.test(screen);
    return isHome && (size === 'large' || size === 'larger' || Number(capture.fontScale) >= 1.3) && isPass(rowResult(capture));
  })) {
    issues.push({ rule: 'missing-dynamic-type-home-capture', message: 'Missing passing large-text Home capture.' });
  }
  const referenceChecks = Array.isArray(manifest.referenceChecks) ? manifest.referenceChecks : [];
  if (!referenceChecks.length) issues.push({ rule: 'missing-reference-checks', message: 'Record a passing reference check for each hierarchy, motif, and forbidden-drift item.' });
  for (const check of referenceChecks) {
    if (!isPass(rowResult(check))) {
      issues.push({ rule: 'failed-reference-check', message: `Reference check did not pass: ${check.requirement || check.id || 'unnamed'}.` });
    }
  }
  for (const finding of Array.isArray(manifest.findings) ? manifest.findings : []) {
    if (isFailure(rowResult(finding))) {
      issues.push({ rule: 'unresolved-finding', message: `Visual QA has an unresolved finding: ${finding.title || finding.id || 'unnamed'}.` });
    }
  }
  if (Array.isArray(manifest.missingCoverage) && manifest.missingCoverage.length) {
    issues.push({ rule: 'missing-coverage', message: `Visual QA reports missing coverage: ${manifest.missingCoverage.join(', ')}.` });
  }
  return issues;
}

function usage() {
  return 'Usage: node validate-visual-qa-evidence.js --project-root <path> --manifest <path> [--plan <path>] [--json]';
}

function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  const projectRoot = path.resolve(args.projectRoot || process.cwd());
  const planPath = path.resolve(projectRoot, args.plan || 'native-app-plan.md');
  const manifestPath = args.manifest && path.resolve(projectRoot, args.manifest);
  if (!manifestPath || !fs.existsSync(manifestPath)) {
    process.stderr.write(`BLOCKED: visual QA manifest not found: ${manifestPath || '<missing>'}\n`);
    return 2;
  }
  if (!fs.existsSync(planPath)) {
    process.stderr.write(`BLOCKED: plan not found: ${planPath}\n`);
    return 2;
  }
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    process.stderr.write(`BLOCKED: invalid visual QA manifest: ${error.message}\n`);
    return 2;
  }
  const fidelity = referenceFidelity(fs.readFileSync(planPath, 'utf8'));
  const issues = validateVisualQaEvidence(manifest, fidelity);
  const result = { validator: 'validate-visual-qa-evidence', plan: planPath, manifest: manifestPath, fidelity, issues };
  if (args.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (issues.length) {
    if (!args.json) {
      process.stderr.write(`BLOCKED: visual QA evidence has ${issues.length} issue(s):\n`);
      for (const issue of issues) process.stderr.write(`- [${issue.rule}] ${issue.message}\n`);
    }
    return 2;
  }
  if (!args.json) process.stdout.write(`Visual QA evidence passed: ${manifestPath}\n`);
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { referenceFidelity, validateVisualQaEvidence };
