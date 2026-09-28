#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawnSync, execSync } = require('child_process');
const { findProjectRoot } = require('../../../scripts/lib/validation-helpers');

if (process.argv.includes('--help')) {
  process.stdout.write(`run-opengrep.js — Runs opengrep and emits the raw JSON output.

Usage:
  node run-opengrep.js --projectRoot <path> [--rulesets <comma-separated>] [--include <glob>]

Flags:
  --projectRoot   Directory to scan (required). Must be a Power Pages site project root
                  (has powerpages.config.json or .powerpages-site/); anything else is refused.
  --rulesets      Comma-separated list of rulesets (default: p/default,p/owasp-top-ten)
                  Each value is passed as a separate --config flag to opengrep.
                  Accepts registry packs (p/owasp-top-ten) and local paths (/path/to/rules.yml).
  --include       Optional glob narrowing the file set
  --help          Show this help message

Exit codes:
  0  Success (raw opengrep JSON on stdout)
  1  Invocation error (missing --projectRoot, root not found, not a Power Pages site
     project, or opengrep failed unexpectedly)

Example:
  node run-opengrep.js --projectRoot <project-root>
  node run-opengrep.js --projectRoot <project-root> --rulesets <ruleset1>,<ruleset2>
  node run-opengrep.js --projectRoot <project-root> --rulesets <registry-pack>,<local-rules-path>
`);
  process.exit(0);
}

function getArg(name, fallback = null) {
  const idx = process.argv.indexOf('--' + name);
  return idx !== -1 && idx + 1 < process.argv.length ? process.argv[idx + 1] : fallback;
}

const projectRoot = getArg('projectRoot');
const rulesets = (getArg('rulesets', 'p/default,p/owasp-top-ten')).split(',').map(r => r.trim()).filter(Boolean);
const include = getArg('include');

if (!projectRoot) {
  process.stderr.write('Usage: node run-opengrep.js --projectRoot <path> [--rulesets <comma-separated>]\n');
  process.exit(1);
}

if (!fs.existsSync(projectRoot)) {
  process.stderr.write(`Project root not found: ${projectRoot}\n`);
  process.exit(1);
}

// Defensive: scan only a Power Pages site project root, never an arbitrary directory.
if (findProjectRoot(projectRoot) !== path.resolve(projectRoot)) {
  process.stderr.write(`Refusing to scan ${path.resolve(projectRoot)}: not a Power Pages site project (no powerpages.config.json or .powerpages-site/).\n`);
  process.exit(1);
}

try {
  // 60s timeout — first invocation can be slow (cold start, antivirus scan, etc.)
  execSync('opengrep --version', { encoding: 'utf8', timeout: 60000 });
} catch {
  process.stderr.write('opengrep is not installed or not on PATH.\n');
  process.exit(1);
}

const args = ['scan'];
for (const rs of rulesets) {
  args.push('--config', rs);
}
args.push('--json', '--quiet');

try {
  const helpText = execSync('opengrep scan --help', { encoding: 'utf8' });
  if (/--metrics/.test(helpText)) args.push('--metrics', 'off');
} catch { /* skip --metrics if help check fails */ }

if (include) args.push('--include', include);
args.push(projectRoot);

// 64MB buffer — opengrep output can be large for big projects
const proc = spawnSync('opengrep', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

if (proc.error) {
  process.stderr.write(`Failed to invoke opengrep: ${proc.error.message}\n`);
  process.exit(1);
}

// opengrep exits 1 when findings are present; treat 0 and 1 as success.
if (proc.status !== 0 && proc.status !== 1) {
  process.stderr.write(`opengrep exited with status ${proc.status}: ${proc.stderr}\n`);
  process.exit(1);
}

process.stdout.write(proc.stdout || '{}');
