#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { validate: validateExperienceVisualEvidence } = require('./validate-experience-visual-evidence');
const { isCleanNativeCapture, validateNativeCaptureCleanliness } = require('./lib/native-capture-evidence');

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
    else if (arg === '--experience-project-root') args.experienceProjectRoot = argv[++index];
    else if (arg === '--plan') args.plan = argv[++index];
    else if (arg === '--manifest') args.manifest = argv[++index];
    else if (arg === '--fidelity') args.fidelity = argv[++index];
    else if (arg === '--json') args.json = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
  }
  return args;
}

function fidelityFromPlan(markdown) {
  const match = /(?:^|\n)\s*-\s+(?:\*\*)?(?:Reference fidelity|Fidelity)(?:\*\*)?\s*:\s*([^\n]+)/i.exec(String(markdown || ''));
  return normalize(match ? match[1].replace(/[*\`]/g, '') : 'none');
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

function isHome(capture) {
  const screen = normalize(capture && (capture.screen || capture.route || capture.name));
  return screen === 'home' || /(?:^|\/)home(?:$|[?#])/.test(screen);
}

function isLargeText(capture) {
  const value = normalize(capture && (capture.dynamicType || capture.textSize || capture.fontScale));
  return value === 'large' || value === 'larger' || Number(capture && capture.fontScale) >= 1.3;
}

function hasCaptureEvidence(capture, manifestPath) {
  if (!capture || typeof capture !== 'object') return false;
  const captureId = String(capture.captureId || capture.id || capture.artifactId || '').trim();
  if (captureId) return true;
  const rawPath = capture.path || capture.file || capture.screenshot;
  if (typeof rawPath !== 'string' || !rawPath.trim()) return false;
  const resolved = path.isAbsolute(rawPath)
    ? rawPath
    : path.resolve(path.dirname(manifestPath || process.cwd()), rawPath);
  return fs.existsSync(resolved);
}

function passingHomeCapture(captures, platform, largeText, manifestPath) {
  return captures.find((capture) => (
    isHome(capture)
    && normalize(capture.platform) === platform
    && (largeText ? isLargeText(capture) : !isLargeText(capture))
    && isPass(rowResult(capture))
    && isCleanNativeCapture(capture)
    && hasCaptureEvidence(capture, manifestPath)
  ));
}

function validateVisualQaEvidence(manifest, fidelity, manifestPath) {
  const issues = [];
  if (!STRICT_FIDELITIES.has(normalize(fidelity))) return issues;
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return [{ rule: 'invalid-manifest', message: 'Visual QA evidence must be a JSON object.' }];
  }
  if (manifest.schemaVersion !== 1) {
    issues.push({ rule: 'invalid-schema-version', message: 'Visual QA evidence requires schemaVersion: 1.' });
  }
  if (normalize(manifest.referenceFidelity) !== normalize(fidelity)) {
    issues.push({ rule: 'reference-fidelity-drift', message: 'Manifest referenceFidelity must match the requested fidelity.' });
  }

  const captures = Array.isArray(manifest.captureMatrix) ? manifest.captureMatrix : [];
  if (!captures.length) {
    issues.push({ rule: 'missing-capture-matrix', message: 'High/strict reference fidelity requires native captureMatrix evidence.' });
  }
  captures.forEach((capture, index) => {
    for (const message of validateNativeCaptureCleanliness(capture, `captureMatrix[${index}]`)) {
      issues.push({ rule: 'unclean-native-capture', message });
    }
  });
  for (const platform of ['ios', 'android']) {
    if (!passingHomeCapture(captures, platform, false, manifestPath)) {
      issues.push({
        rule: 'missing-platform-home-capture',
        message: 'Missing passing default-text Home capture with a screenshot path or capture ID for ' + platform + '.',
        platform,
      });
    }
  }
  if (!captures.some((capture) => (
    isHome(capture)
    && isLargeText(capture)
    && isPass(rowResult(capture))
    && hasCaptureEvidence(capture, manifestPath)
  ))) {
    issues.push({
      rule: 'missing-dynamic-type-home-capture',
      message: 'Missing passing large-text Home capture with a screenshot path or capture ID.',
    });
  }

  const checks = Array.isArray(manifest.referenceChecks) ? manifest.referenceChecks : [];
  if (!checks.length) {
    issues.push({ rule: 'missing-reference-checks', message: 'Record passing checks for hierarchy, motifs, and forbidden drift.' });
  }
  for (const check of checks) {
    if (!isPass(rowResult(check))) {
      issues.push({
        rule: 'failed-reference-check',
        message: 'Reference check did not pass: ' + String(check.requirement || check.id || 'unnamed') + '.',
      });
    }
  }

  for (const finding of Array.isArray(manifest.findings) ? manifest.findings : []) {
    if (isFailure(rowResult(finding))) {
      issues.push({
        rule: 'unresolved-finding',
        message: 'Visual QA has an unresolved finding: ' + String(finding.title || finding.id || 'unnamed') + '.',
      });
    }
  }
  if (Array.isArray(manifest.missingCoverage) && manifest.missingCoverage.length) {
    issues.push({
      rule: 'missing-coverage',
      message: 'Visual QA reports missing coverage: ' + manifest.missingCoverage.join(', ') + '.',
    });
  }
  return issues;
}

function validateExperienceQaEvidence(manifest, projectRoot) {
  if (!projectRoot) return [];
  return validateExperienceVisualEvidence(path.resolve(projectRoot), manifest);
}

function usage() {
  return 'Usage: node validate-visual-qa-evidence.js --project-root <path> --manifest <path> --fidelity <directional|high|strict-structural> [--plan <path>] [--experience-project-root <path>] [--json]';
}

function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(usage() + '\n');
    return 0;
  }
  const projectRoot = path.resolve(args.projectRoot || process.cwd());
  const manifestPath = args.manifest && path.resolve(projectRoot, args.manifest);
  const planPath = path.resolve(projectRoot, args.plan || 'native-app-plan.md');
  if (!manifestPath || !fs.existsSync(manifestPath)) {
    process.stderr.write('BLOCKED: visual QA manifest not found: ' + String(manifestPath || '<missing>') + '\n');
    return 2;
  }
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    process.stderr.write('BLOCKED: invalid visual QA manifest: ' + error.message + '\n');
    return 2;
  }
  let fidelity = normalize(args.fidelity);
  if (!fidelity && fs.existsSync(planPath)) {
    fidelity = fidelityFromPlan(fs.readFileSync(planPath, 'utf8'));
  }
  if (!fidelity) {
    process.stderr.write('BLOCKED: pass --fidelity when the plan does not declare reference fidelity.\n');
    return 2;
  }
  const issues = validateVisualQaEvidence(manifest, fidelity, manifestPath);
  if (args.experienceProjectRoot) {
    issues.push(...validateExperienceQaEvidence(manifest, args.experienceProjectRoot));
  }
  const result = {
    validator: 'validate-visual-qa-evidence',
    manifest: manifestPath,
    fidelity,
    experienceProjectRoot: args.experienceProjectRoot ? path.resolve(args.experienceProjectRoot) : null,
    issues,
  };
  if (args.json) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  if (issues.length) {
    if (!args.json) {
      process.stderr.write('BLOCKED: visual QA evidence has ' + issues.length + ' issue(s):\n');
      for (const issue of issues) {
        process.stderr.write('- [' + issue.rule + '] ' + issue.message + '\n');
      }
    }
    return 2;
  }
  if (!args.json) process.stdout.write('Visual QA evidence passed: ' + manifestPath + '\n');
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { fidelityFromPlan, validateExperienceQaEvidence, validateVisualQaEvidence };
