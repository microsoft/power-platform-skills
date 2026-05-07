#!/usr/bin/env node

const path = require('path');
const fs = require('fs');
const { spawnSync, execSync } = require('child_process');

if (process.argv.includes('--help')) {
  process.stdout.write(`run-opengrep.js — Runs opengrep against a project and outputs normalized findings.

Usage:
  node run-opengrep.js --projectRoot <path> [--rulesets <comma-separated>] [--include <glob>]

Flags:
  --projectRoot   Directory to scan (required)
  --rulesets      Comma-separated list of rulesets (default: p/default,p/owasp-top-ten)
                  Each value is passed as a separate --config flag to opengrep.
                  Accepts registry packs (p/owasp-top-ten) and local paths (/path/to/rules.yml).
  --include       Optional glob narrowing the file set
  --help          Show this help message

Exit codes:
  0  Success (JSON on stdout, even if findings is empty)
  1  Invocation error (bad args or opengrep failed unexpectedly)

Example:
  node run-opengrep.js --projectRoot /path/to/site
  node run-opengrep.js --projectRoot /path/to/site --rulesets p/default,p/owasp-top-ten,p/cwe-top-25
  node run-opengrep.js --projectRoot /path/to/site --rulesets p/default,/custom/rules.yml
`);
  process.exit(0);
}

function getArg(name, fallback = null) {
  const idx = process.argv.indexOf('--' + name);
  return idx !== -1 && idx + 1 < process.argv.length ? process.argv[idx + 1] : fallback;
}

const projectRoot = getArg('projectRoot');
// Basic depth by default: Default + OWASP Top 10
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

let version = null;
try {
  // 60s timeout — first invocation can be slow (cold start, antivirus scan, etc.)
  version = execSync('opengrep --version', { encoding: 'utf8', timeout: 60000 }).trim().match(/[\d.]+/)?.[0] || null;
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

let parsed;
try {
  parsed = JSON.parse(proc.stdout || '{}');
} catch (err) {
  process.stderr.write(`Failed to parse opengrep JSON: ${err.message}\n`);
  process.exit(1);
}

const findings = (parsed.results || []).map((r, i) => {
  const sev = (r.extra?.severity || 'INFO').toUpperCase();
  const file = path.relative(projectRoot, r.path || '').replace(/\\/g, '/');
  const line = r.start?.line || 0;
  return {
    id: `opengrep-${i + 1}`,
    severity: sev,
    title: (r.extra?.message || r.check_id || 'opengrep finding').split('\n')[0].slice(0, 200),
    location: line ? `${file}:${line}` : file,
    tag: r.check_id || null,
    details: (r.extra?.metadata?.references || []).slice(0, 3).join(' · ') || (r.extra?.metadata?.cwe || []).join(', ') || null,
  };
});

process.stdout.write(JSON.stringify({
  status: 'ok',
  tool: 'opengrep',
  version,
  rulesets,
  scanned: parsed.paths?.scanned?.length ?? null,
  findings,
}) + '\n');
