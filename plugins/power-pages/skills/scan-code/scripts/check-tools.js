#!/usr/bin/env node

const { execSync } = require('child_process');

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

function probe(cmd, parseVersion) {
  try {
    // 60s timeout — first invocation can be slow (cold start, antivirus scan, etc.)
    const out = execSync(cmd, { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] });
    return { available: true, version: parseVersion(out), error: null };
  } catch (err) {
    return { available: false, version: null, error: (err.stderr || err.message || '').toString().trim() };
  }
}

const result = {
  opengrep: probe('opengrep --version', (out) => (out.match(/[\d.]+/) || [null])[0]),
  trivy: probe('trivy --version', (out) => {
    const m = out.match(/Version:\s*([\d.]+)/i) || out.match(/[\d.]+/);
    return m ? m[1] || m[0] : null;
  }),
};

process.stdout.write(JSON.stringify(result, null, 2) + '\n');
process.exit(result.opengrep.available && result.trivy.available ? 0 : 1);
