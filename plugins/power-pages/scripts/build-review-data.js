#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const REQUIRED_FLAGS = [
  'reportName',
  'inputDir',
  'siteName',
  'goalLabel',
  'scopeLabel',
  'output',
];

const SECTION_MAP = {
  'scan-code.json': { id: 'code-scan', label: 'Code & Packages', icon: '▦' },
  'scan-site.json': { id: 'site-scan', label: 'Live Site Scan', icon: '◐' },
  'manage-headers.json': { id: 'headers', label: 'Browser Headers', icon: '◑' },
  'manage-firewall.json': {
    id: 'firewall',
    label: 'Web Application Firewall',
    icon: '◆',
  },
  'audit-permissions.json': { id: 'permissions', label: 'Roles & Permissions', icon: '◇' },
  'setup-auth.json': { id: 'auth', label: 'Access & Identity', icon: '◈' },
};

// Every severity a finding may carry. `pass` is shown as a stat but excluded
// from the issue count by the report template.
const SEVERITIES = ['critical', 'high', 'warning', 'medium', 'info', 'low', 'pass'];

const HELP = `build-review-data.js — Consolidate per-skill JSON into a single review data file.

Usage:
  node build-review-data.js --reportName <name> --inputDir <dir> --siteName <name> --goalLabel <label> --scopeLabel <label> --output <path> [--summary <text>] [--nextStepsFile <path>]

Flags:
  --reportName     Top-bar report title (e.g., "Security Review", "Site Scan") (required)
  --inputDir       Directory containing per-skill review JSON files (required)
  --siteName       Site display name (required)
  --goalLabel      Plain-language goal label (required)
  --scopeLabel     Plain-language scope label (required)
  --output         Output data-file path (required)
  --summary        Overall plain-language summary, 2-4 sentences (optional)
  --nextStepsFile  Path to a JSON file containing an array of next-step strings (optional)
  --help           Show this help message

Exit codes:
  0  Success (data file written; status JSON on stdout)
  1  Invocation error (missing flag or unreadable input dir)
`;

function getArg(name, fallback = null) {
  const idx = process.argv.indexOf('--' + name);
  return idx !== -1 && idx + 1 < process.argv.length ? process.argv[idx + 1] : fallback;
}

function readNextSteps(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string') : [];
  } catch (err) {
    process.stderr.write(`Could not read next-steps file: ${err.message}\n`);
    return [];
  }
}

function formatGeneratedAt(now) {
  const pad = (n) => String(n).padStart(2, '0');
  // Intl returns "GMT+5:30" on some platforms; keep only the short abbreviation when present.
  const tzName =
    new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' })
      .formatToParts(now)
      .find((p) => p.type === 'timeZoneName')?.value || '';
  const stamp =
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
    `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  return tzName ? `${stamp} ${tzName}` : stamp;
}

function skippedSection(meta, reason) {
  return {
    id: meta.id,
    icon: meta.icon,
    label: meta.label,
    description: '',
    findings: [
      {
        id: `${meta.id}-skipped`,
        title: `${meta.label} check was skipped`,
        details: reason || 'No additional detail.',
      },
    ],
    details: {},
  };
}

function buildSections(inputDir, outputBasename) {
  const sections = [];
  const totals = Object.fromEntries(SEVERITIES.map((s) => [s, 0]));

  for (const fileName of fs.readdirSync(inputDir).sort()) {
    if (!fileName.endsWith('.json')) continue;
    if (fileName === outputBasename) continue;
    const meta = SECTION_MAP[fileName];
    if (!meta) continue;

    const filePath = path.join(inputDir, fileName);
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (err) {
      process.stderr.write(`Skipping ${fileName}: ${err.message}\n`);
      continue;
    }

    if (raw?.status === 'skipped') {
      sections.push(skippedSection(meta, raw.reason));
      continue;
    }

    const findings = Array.isArray(raw?.findings) ? raw.findings : [];
    sections.push({
      id: meta.id,
      icon: meta.icon,
      label: meta.label,
      description: '',
      findings,
      details: raw?.details || {},
    });

    for (const f of findings) {
      if (f.severity && totals[f.severity] !== undefined) totals[f.severity] += 1;
    }
  }

  return { sections, totals };
}

function main() {
  if (process.argv.includes('--help')) {
    process.stdout.write(HELP);
    return;
  }

  const values = Object.fromEntries(REQUIRED_FLAGS.map((flag) => [flag, getArg(flag)]));
  for (const flag of REQUIRED_FLAGS) {
    if (!values[flag]) {
      process.stderr.write(`Missing required flag: --${flag}\n`);
      process.exit(1);
    }
  }

  const inputDir = values.inputDir;
  const outputPath = values.output;
  if (!fs.existsSync(inputDir)) {
    process.stderr.write(`Input dir not found: ${inputDir}\n`);
    process.exit(1);
  }

  const summary = getArg('summary', '');
  const nextStepsFile = getArg('nextStepsFile');
  const nextSteps = nextStepsFile ? readNextSteps(nextStepsFile) : [];

  const { sections, totals } = buildSections(inputDir, path.basename(outputPath));

  const payload = {
    REPORT_NAME: values.reportName,
    SITE_NAME: values.siteName,
    GOAL_LABEL: values.goalLabel,
    SCOPE_LABEL: values.scopeLabel,
    GENERATED_AT: formatGeneratedAt(new Date()),
    REVIEW_DATA: { summary: summary || '', totals, sections, nextSteps },
  };

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(payload, null, 2));

  process.stdout.write(
    JSON.stringify({
      status: 'ok',
      outputPath,
      totals,
      sectionsCount: sections.length,
    }) + '\n'
  );
}

if (require.main === module) {
  main();
}

module.exports = { buildSections, formatGeneratedAt, SECTION_MAP, SEVERITIES };
