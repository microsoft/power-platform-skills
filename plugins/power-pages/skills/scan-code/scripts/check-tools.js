#!/usr/bin/env node

const { execFileSync } = require('child_process');

if (process.argv.includes('--help')) {
  process.stdout.write(`check-tools.js — Detects whether opengrep and trivy are installed.

Usage:
  node check-tools.js

No flags required.

Exit codes:
  0  Both tools available
  1  At least one tool missing (see error field per tool)

Output (stdout, JSON):
  {
    "opengrep": { "available": true, "version": "1.50.0", "error": null },
    "trivy":    { "available": false, "version": null, "error": "command not found" }
  }
`);
  process.exit(0);
}

function probe(runVersion, parseVersion) {
  try {
    const out = runVersion();
    return { available: true, version: parseVersion(out), error: null };
  } catch (err) {
    return { available: false, version: null, error: (err.stderr || err.message || '').toString().trim() };
  }
}

// Keep executable names at the child_process call sites. Passing an executable
// into probe() would make future CLI/env-derived values indistinguishable from
// this fixed two-tool allowlist to the repository security validator.
const runOpenGrepVersion = () => execFileSync('opengrep', ['--version'], {
  encoding: 'utf8',
  timeout: 60000,
  stdio: ['ignore', 'pipe', 'pipe'],
  shell: false,
});
const runTrivyVersion = () => execFileSync('trivy', ['--version'], {
  encoding: 'utf8',
  timeout: 60000,
  stdio: ['ignore', 'pipe', 'pipe'],
  shell: false,
});

const result = {
  opengrep: probe(runOpenGrepVersion, (out) => (out.match(/[\d.]+/) || [null])[0]),
  trivy: probe(runTrivyVersion, (out) => {
    const m = out.match(/Version:\s*([\d.]+)/i) || out.match(/[\d.]+/);
    return m ? m[1] || m[0] : null;
  }),
};

process.stdout.write(JSON.stringify(result, null, 2) + '\n');
process.exit(result.opengrep.available && result.trivy.available ? 0 : 1);
