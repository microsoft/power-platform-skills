#!/usr/bin/env node
// Runs `npm audit --json` against a project and emits unified findings JSON.
// Severities are kept verbatim from npm audit (critical, high, moderate, low, info).
// Run with --help for flags.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

if (process.argv.includes('--help')) {
  process.stdout.write(`audit.js — Runs npm audit and transforms output into findings JSON.

Usage:
  node audit.js --projectRoot <dir> [--output <path>]

Flags:
  --projectRoot   Directory containing package.json + package-lock.json (required)
  --output        Write JSON here instead of stdout (optional)
  --help          Show this help message

Exit codes:
  0  Success — findings written (status "ok", "empty", or "skipped")
  1  Invocation error or unrecoverable npm failure

The script always exits 0 when the audit ran (even when vulnerabilities exist).
A missing package-lock.json produces { "status": "skipped", "reason": "..." }.
`);
  process.exit(0);
}

function getArg(name, fallback = null) {
  const idx = process.argv.indexOf('--' + name);
  return idx !== -1 && idx + 1 < process.argv.length ? process.argv[idx + 1] : fallback;
}

// npm audit severities (kept verbatim — see template severity classes).
// pass-through map; used here only to validate the value we received.
const NPM_SEVERITIES = new Set(['critical', 'high', 'moderate', 'low', 'info']);

function formatFixHint(node) {
  if (!node.fixAvailable) return 'No automatic fix available — review advisories and upgrade manually.';
  if (node.fixAvailable === true) return `Run \`npm audit fix\` to apply available patch updates for ${node.name}.`;
  const fix = node.fixAvailable;
  const breaking = fix.isSemVerMajor ? ' (breaking change — review before applying)' : '';
  return `Upgrade \`${node.name}\` to \`${fix.name}@${fix.version}\`${breaking}. Run \`npm audit fix${fix.isSemVerMajor ? ' --force' : ''}\`.`;
}

function transformAudit(report) {
  const findings = [];
  const vulns = report && report.vulnerabilities ? report.vulnerabilities : {};
  let counter = 1;

  for (const name of Object.keys(vulns).sort()) {
    const node = vulns[name];
    if (!NPM_SEVERITIES.has(node.severity)) continue; // skip malformed entries

    // Each `via` entry is either a string (transitive dep) or an advisory object.
    const advisories = (node.via || []).filter(v => typeof v === 'object' && v !== null);
    const transitiveVia = (node.via || []).filter(v => typeof v === 'string');

    const advisoryLines = advisories.map(a => {
      const url = a.url ? ` (${a.url})` : '';
      return `- ${a.title || a.source || 'Advisory'}${url}`;
    });
    if (transitiveVia.length > 0) {
      advisoryLines.push(`- pulled in transitively via: ${transitiveVia.join(', ')}`);
    }

    const details = [
      `Affected versions: ${node.range || 'unspecified'}`,
      advisoryLines.length > 0 ? `Advisories:\n${advisoryLines.join('\n')}` : null,
      node.effects && node.effects.length > 0 ? `Affected packages: ${node.effects.join(', ')}` : null,
    ].filter(Boolean).join('\n\n');

    findings.push({
      id: `scan-code-pkg-${counter++}`,
      severity: node.severity,
      title: `${node.name} ${node.range || ''}`.trim(),
      tag: advisories[0] && advisories[0].cwe && advisories[0].cwe[0] ? advisories[0].cwe[0] : null,
      location: node.nodes && node.nodes.length > 0 ? node.nodes[0] : null,
      details: details || 'See npm audit advisory for details.',
      fix: formatFixHint(node),
    });
  }

  const meta = report && report.metadata && report.metadata.vulnerabilities ? report.metadata.vulnerabilities : {};
  const totalDeps = report && report.metadata ? (report.metadata.totalDependencies || 0) : 0;
  const detailsBlock = {
    kind: 'kv',
    label: 'Audit details',
    entries: [
      { key: 'Critical', value: String(meta.critical || 0) },
      { key: 'High', value: String(meta.high || 0) },
      { key: 'Moderate', value: String(meta.moderate || 0) },
      { key: 'Low', value: String(meta.low || 0) },
      { key: 'Info', value: String(meta.info || 0) },
      { key: 'Total dependencies scanned', value: String(totalDeps) },
    ],
  };

  return { status: 'ok', findings, details: detailsBlock };
}

function writeOutput(payload, outputPath) {
  const text = JSON.stringify(payload) + '\n';
  if (outputPath) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, text);
  }
  process.stdout.write(text);
}

function main() {
  const projectRoot = getArg('projectRoot');
  const outputPath = getArg('output');

  if (!projectRoot) {
    process.stderr.write('Missing required flag: --projectRoot\n');
    process.exit(1);
  }
  if (!fs.existsSync(path.join(projectRoot, 'package.json'))) {
    writeOutput({ status: 'skipped', reason: 'No package.json in project root.' }, outputPath);
    return;
  }
  if (!fs.existsSync(path.join(projectRoot, 'package-lock.json'))) {
    writeOutput({ status: 'skipped', reason: 'No package-lock.json found — run `npm install` to generate one, then re-run the scan.' }, outputPath);
    return;
  }

  // `npm audit --json` exits non-zero when vulnerabilities are found.
  // That is expected — we treat exit codes 0 and 1 as success and parse the JSON either way.
  const proc = spawnSync('npm', ['audit', '--json'], {
    cwd: projectRoot,
    shell: true,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });

  if (proc.error) {
    process.stderr.write(`Failed to run npm audit: ${proc.error.message}\n`);
    process.exit(1);
  }

  let report;
  try {
    report = JSON.parse(proc.stdout || '{}');
  } catch (err) {
    process.stderr.write(`Could not parse npm audit output: ${err.message}\n`);
    process.exit(1);
  }

  // npm prints structured errors as { error: { code, summary, detail } } when it cannot audit.
  if (report.error) {
    writeOutput({ status: 'skipped', reason: `npm audit error: ${report.error.summary || report.error.code || 'unknown'}` }, outputPath);
    return;
  }

  writeOutput(transformAudit(report), outputPath);
}

if (require.main === module) {
  main();
}

module.exports = { transformAudit };
