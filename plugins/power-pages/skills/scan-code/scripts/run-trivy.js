#!/usr/bin/env node

const path = require('path');
const fs = require('fs');
const { spawnSync, execSync } = require('child_process');

if (process.argv.includes('--help')) {
  process.stdout.write(`run-trivy.js — Runs trivy against the project and outputs normalized findings.

Scans for vulnerabilities in dependencies, hard-coded secrets in source
files, and license compliance issues in packages.

Usage:
  node run-trivy.js --projectRoot <path> [flags]

Flags:
  --projectRoot     Directory to scan (required)
  --severity        Comma-separated severity floor (default: LOW,MEDIUM,HIGH,CRITICAL)
  --scanners        Comma-separated scanner list (default: vuln,secret,license)
  --secretConfig    Path to custom secret rules file (trivy-secret.yaml format)
  --ignoreFile      Path to .trivyignore or .trivyignore.yaml
  --trivyConfig     Path to trivy.yaml config file (license classification, etc.)
  --no-licenseFull  Disable source-level license scanning for faster runs
  --help            Show this help message

Exit codes:
  0  Success (JSON on stdout, even if findings is empty)
  1  Invocation error

Example:
  node run-trivy.js --projectRoot /path/to/site
  node run-trivy.js --projectRoot /path/to/site --severity LOW,MEDIUM,HIGH,CRITICAL
  node run-trivy.js --projectRoot /path/to/site --secretConfig /path/to/trivy-secret.yaml
  node run-trivy.js --projectRoot /path/to/site --ignoreFile /path/to/.trivyignore.yaml
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
// Auto-detect config files from project root; CLI flags override.
const trivyConfig = getArg('trivyConfig') || autoDetect('trivy.yaml');
const secretConfig = getArg('secretConfig') || autoDetect('trivy-secret.yaml');
const ignoreFile = getArg('ignoreFile') || autoDetect('.trivyignore.yaml') || autoDetect('.trivyignore');
// Default true — scan source headers and LICENSE files. Pass --no-licenseFull to disable.
const licenseFull = !hasFlag('no-licenseFull');

if (!projectRoot) {
  process.stderr.write('Usage: node run-trivy.js --projectRoot <path> [flags]\n');
  process.exit(1);
}

if (!fs.existsSync(projectRoot)) {
  process.stderr.write(`Project root not found: ${projectRoot}\n`);
  process.exit(1);
}

let version = null;
try {
  // 60s timeout — first invocation can be slow
  version = execSync('trivy --version', { encoding: 'utf8', timeout: 60000 }).match(/Version:\s*([\d.]+)/i)?.[1] || null;
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

let parsed;
try {
  parsed = JSON.parse(proc.stdout || '{}');
} catch (err) {
  process.stderr.write(`Failed to parse trivy JSON: ${err.message}\n`);
  process.exit(1);
}

const findings = [];
let counter = 1;
for (const target of parsed.Results || []) {
  const targetPath = path.relative(projectRoot, target.Target || '').replace(/\\/g, '/') || target.Target || 'unknown';

  for (const v of target.Vulnerabilities || []) {
    findings.push({
      id: `trivy-${counter++}`,
      severity: (v.Severity || 'UNKNOWN').toUpperCase(),
      category: 'vulnerability',
      title: `${v.PkgName || 'package'}@${v.InstalledVersion || '?'}`,
      tag: v.VulnerabilityID || null,
      location: targetPath,
      details: (v.Title || v.Description || '').split('\n')[0].slice(0, 240) || null,
      fix: v.FixedVersion ? `Upgrade ${v.PkgName} to ${v.FixedVersion}` : null,
    });
  }

  for (const s of target.Secrets || []) {
    findings.push({
      id: `trivy-${counter++}`,
      severity: (s.Severity || 'HIGH').toUpperCase(),
      category: 'secret',
      title: s.Title || s.RuleID || 'Hard-coded secret',
      tag: s.RuleID || null,
      location: targetPath + (s.StartLine ? `:${s.StartLine}` : ''),
      details: s.Category || null,
      fix: 'Remove the secret from source code and rotate it immediately',
    });
  }

  for (const l of target.Licenses || []) {
    findings.push({
      id: `trivy-${counter++}`,
      severity: (l.Severity || 'LOW').toUpperCase(),
      category: 'license',
      title: `${l.PkgName || 'package'}: ${l.Name || 'unknown license'}`,
      tag: l.Name || null,
      location: targetPath,
      details: l.Category ? `Category: ${l.Category}` : null,
      fix: l.Category === 'restricted' ? 'Replace this package with one using a permissive license' : null,
    });
  }
}

process.stdout.write(JSON.stringify({
  status: 'ok',
  tool: 'trivy',
  version,
  scanners,
  severity,
  findings,
}) + '\n');
