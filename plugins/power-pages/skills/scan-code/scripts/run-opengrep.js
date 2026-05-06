#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawnSync, execSync } = require('child_process');

if (process.argv.includes('--help')) {
  process.stdout.write(`run-opengrep.js — Runs opengrep against a project and writes normalized findings.

Usage:
  node run-opengrep.js --projectRoot <path> --ruleset <r> --output <file> [--include <glob>]

Flags:
  --projectRoot   Directory to scan (required)
  --ruleset       Opengrep ruleset name or local rules file (default: p/owasp-top-ten)
  --output        Path for the normalized findings JSON (required)
  --include       Optional glob narrowing the file set
  --help          Show this help message

Exit codes:
  0  Success (output JSON written, even if findings is empty)
  1  Invocation error (bad args or opengrep failed unexpectedly)
`);
  process.exit(0);
}

function getArg(name, fallback = null) {
  const idx = process.argv.indexOf('--' + name);
  return idx !== -1 && idx + 1 < process.argv.length ? process.argv[idx + 1] : fallback;
}

const projectRoot = getArg('projectRoot');
const ruleset = getArg('ruleset', 'p/owasp-top-ten');
const output = getArg('output');
const include = getArg('include');

if (!projectRoot || !output) {
  process.stderr.write('Usage: node run-opengrep.js --projectRoot <path> --ruleset <r> --output <file>\n');
  process.exit(1);
}

if (!fs.existsSync(projectRoot)) {
  process.stderr.write(`Project root not found: ${projectRoot}\n`);
  process.exit(1);
}

let version = null;
try {
  version = execSync('opengrep --version', { encoding: 'utf8', timeout: 10000 }).trim().match(/[\d.]+/)?.[0] || null;
} catch {
  process.stderr.write('opengrep is not installed or not on PATH.\n');
  process.exit(1);
}

const args = ['scan', '--config', ruleset, '--json', '--quiet'];
try {
  const helpText = execSync('opengrep scan --help', { encoding: 'utf8' });
  if (/--metrics/.test(helpText)) args.push('--metrics', 'off');
} catch { /* ignore — skip --metrics if help check fails */ }

if (include) args.push('--include', include);
args.push(projectRoot);

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

const result = {
  tool: 'opengrep',
  version,
  ruleset,
  scanned: parsed.paths?.scanned?.length ?? null,
  findings,
};

const outDir = path.dirname(output);
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(output, JSON.stringify(result, null, 2));
process.stdout.write(JSON.stringify({ status: 'ok', findings: findings.length, output }) + '\n');
