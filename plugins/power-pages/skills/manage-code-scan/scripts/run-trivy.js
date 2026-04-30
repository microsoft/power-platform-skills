#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawnSync, execSync } = require('child_process');

if (process.argv.includes('--help')) {
  process.stdout.write(`run-trivy.js — Runs trivy against the project and writes normalized findings.

Scans for vulnerabilities in dependencies, hard-coded secrets in source
files, and license compliance issues in packages.

Usage:
  node run-trivy.js --projectRoot <path> --severity <list> --output <file> [--scanners <list>]

Flags:
  --projectRoot   Directory to scan (required)
  --severity      Comma-separated severity floor (default: HIGH,CRITICAL)
                  Valid values: LOW, MEDIUM, HIGH, CRITICAL, UNKNOWN
  --scanners      Comma-separated scanner list (default: vuln,secret,license)
                  Valid values: vuln, secret, license
  --output        Path for the normalized findings JSON (required)
  --help          Show this help message

Exit codes:
  0  Success (file written, even if findings is empty)
  1  Invocation error
`);
  process.exit(0);
}

function getArg(name, fallback = null) {
  const idx = process.argv.indexOf('--' + name);
  return idx !== -1 && idx + 1 < process.argv.length ? process.argv[idx + 1] : fallback;
}

const projectRoot = getArg('projectRoot');
const severity = getArg('severity', 'HIGH,CRITICAL');
const scanners = getArg('scanners', 'vuln,secret,license');
const output = getArg('output');

if (!projectRoot || !output) {
  process.stderr.write('Usage: node run-trivy.js --projectRoot <path> --severity <list> --output <file>\n');
  process.exit(1);
}

if (!fs.existsSync(projectRoot)) {
  process.stderr.write(`Project root not found: ${projectRoot}\n`);
  process.exit(1);
}

let version = null;
try {
  version = execSync('trivy --version', { encoding: 'utf8', timeout: 10000 }).match(/Version:\s*([\d.]+)/i)?.[1] || null;
} catch {
  process.stderr.write('trivy is not installed or not on PATH.\n');
  process.exit(1);
}

const args = [
  'fs',
  '--scanners', scanners,
  '--severity', severity,
  '--format', 'json',
  '--quiet',
  '--exit-code', '0',
  projectRoot,
];

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

const result = { tool: 'trivy', version, scanners, severity, findings };

const outDir = path.dirname(output);
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(output, JSON.stringify(result, null, 2));
process.stdout.write(JSON.stringify({ status: 'ok', findings: findings.length, output }) + '\n');
