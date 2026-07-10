#!/usr/bin/env node

const path = require('path');
const fs = require('fs');
const { spawnSync, execSync } = require('child_process');
const { findProjectRoot } = require('../../../scripts/lib/validation-helpers');

if (process.argv.includes('--help')) {
  process.stdout.write(`run-trivy.js — Runs trivy and emits the raw JSON output.

Scans for vulnerabilities in dependencies, hard-coded secrets in source
files, and license compliance issues in packages.

Usage:
  node run-trivy.js --projectRoot <path> [flags]

Flags:
  --projectRoot     Directory to scan (required). Must be a Power Pages site project root
                    (has powerpages.config.json or .powerpages-site/); anything else is refused.
  --severity        Comma-separated severity floor (default: LOW,MEDIUM,HIGH,CRITICAL)
  --scanners        Comma-separated scanner list (default: vuln,secret,license)
  --secretConfig    Path to custom secret rules file (trivy-secret.yaml format)
  --ignoreFile      Path to .trivyignore or .trivyignore.yaml
  --trivyConfig     Path to trivy.yaml config file (license classification, etc.)
  --no-licenseFull  Disable source-level license scanning for faster runs
  --help            Show this help message

Exit codes:
  0  Success (raw trivy JSON on stdout)
  1  Invocation error (missing --projectRoot, root not found, not a Power Pages site
     project, or trivy failed unexpectedly)

Examples:
  node run-trivy.js --projectRoot <project-root>
  node run-trivy.js --projectRoot <project-root> --severity <comma-separated-severities>
  node run-trivy.js --projectRoot <project-root> --secretConfig <secret-config-file>
  node run-trivy.js --projectRoot <project-root> --ignoreFile <ignore-file>
`);
  process.exit(0);
}

function getArg(name, fallback = null) {
  const idx = process.argv.indexOf('--' + name);
  return idx !== -1 && idx + 1 < process.argv.length ? process.argv[idx + 1] : fallback;
}

function hasFlag(name) {
  return process.argv.includes('--' + name);
}

const projectRoot = getArg('projectRoot');

function autoDetect(filename) {
  if (!projectRoot) return null;
  const p = path.join(projectRoot, filename);
  return fs.existsSync(p) ? p : null;
}

const severity = getArg('severity', 'LOW,MEDIUM,HIGH,CRITICAL');
const scanners = getArg('scanners', 'vuln,secret,license');
const trivyConfig = getArg('trivyConfig') || autoDetect('trivy.yaml');
const secretConfig = getArg('secretConfig') || autoDetect('trivy-secret.yaml');
const ignoreFile = getArg('ignoreFile') || autoDetect('.trivyignore.yaml') || autoDetect('.trivyignore');
const licenseFull = !hasFlag('no-licenseFull');

if (!projectRoot) {
  process.stderr.write('Usage: node run-trivy.js --projectRoot <path> [flags]\n');
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
  // 60s timeout — first invocation can be slow
  execSync('trivy --version', { encoding: 'utf8', timeout: 60000 });
} catch {
  process.stderr.write('trivy is not installed or not on PATH.\n');
  process.exit(1);
}

const args = [
  'fs',
  '--scanners', scanners,
  '--severity', severity,
  '--pkg-types', 'library',
  '--format', 'json',
  '--quiet',
  '--exit-code', '0',
];

if (secretConfig) args.push('--secret-config', secretConfig);
if (ignoreFile) args.push('--ignorefile', ignoreFile);
if (trivyConfig) args.push('--config', trivyConfig);
if (licenseFull) args.push('--license-full');

args.push(projectRoot);

// 64MB buffer — trivy output can be large for projects with many dependencies
const proc = spawnSync('trivy', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

if (proc.error) {
  process.stderr.write(`Failed to invoke trivy: ${proc.error.message}\n`);
  process.exit(1);
}
if (proc.status !== 0) {
  process.stderr.write(`trivy exited with status ${proc.status}: ${proc.stderr}\n`);
  process.exit(1);
}

process.stdout.write(proc.stdout || '{}');
