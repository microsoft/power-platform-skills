#!/usr/bin/env node
// Consolidates per-skill review JSON files into the data file consumed by render-review.js.
// Run with --help for flags.

const fs = require('fs');
const path = require('path');

if (process.argv.includes('--help')) {
  process.stdout.write(`build-review-data.js — Consolidate per-skill JSON into a single review data file.

Usage:
  node build-review-data.js --reportName <name> --inputDir <dir> --siteName <name> --goalLabel <label> --scopeLabel <label> --output <path> [--summary <text>] [--nextStepsFile <path>]

Flags:
  --reportName     Top-bar report title (e.g., "Security Review", "Code Scan", "Site Scan") (required)
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

Examples:
  node build-review-data.js --reportName "<report-name>" --inputDir <input-dir> --siteName "<site-name>" --goalLabel "<goal-label>" --scopeLabel "<scope-label>" --output <output-file>
  node build-review-data.js --reportName "<report-name>" --inputDir <input-dir> --siteName "<site-name>" --goalLabel "<goal-label>" --scopeLabel "<scope-label>" --summary "<summary-text>" --nextStepsFile <next-steps-file> --output <output-file>
`);
  process.exit(0);
}

function getArg(name, fallback = null) {
  const idx = process.argv.indexOf('--' + name);
  return idx !== -1 && idx + 1 < process.argv.length ? process.argv[idx + 1] : fallback;
}

const reportName = getArg('reportName');
const inputDir = getArg('inputDir');
const siteName = getArg('siteName');
const goalLabel = getArg('goalLabel');
const scopeLabel = getArg('scopeLabel');
const outputPath = getArg('output');
const summaryArg = getArg('summary', '');
const nextStepsFile = getArg('nextStepsFile');

for (const [name, value] of [['reportName', reportName], ['inputDir', inputDir], ['siteName', siteName], ['goalLabel', goalLabel], ['scopeLabel', scopeLabel], ['output', outputPath]]) {
  if (!value) {
    process.stderr.write(`Missing required flag: --${name}\n`);
    process.exit(1);
  }
}

if (!fs.existsSync(inputDir)) {
  process.stderr.write(`Input dir not found: ${inputDir}\n`);
  process.exit(1);
}

const SECTION_MAP = {
  'scan-code.json':         { id: 'code-scan',   label: 'Code & Packages',          icon: '▦' },
  'scan-site.json':         { id: 'site-scan',   label: 'Live Site Scan',           icon: '◐' },
  'manage-headers.json':    { id: 'headers',     label: 'Browser Headers',          icon: '◑' },
  'manage-firewall.json':   { id: 'firewall',    label: 'Web Application Firewall', icon: '◆' },
  'audit-permissions.json': { id: 'permissions', label: 'Roles & Permissions',      icon: '◇' },
  'setup-auth.json':        { id: 'auth',        label: 'Access & Identity',        icon: '◈' },
};

// Severities that may appear on findings — ordered by precedence (most severe first).
// pass is excluded from the "issue" count but still shown as its own stat.
const SEVERITIES = ['critical', 'high', 'warning', 'medium', 'info', 'low', 'pass'];

const sections = [];
const totals = Object.fromEntries(SEVERITIES.map(s => [s, 0]));

for (const fileName of fs.readdirSync(inputDir).sort()) {
  if (!fileName.endsWith('.json')) continue;
  if (fileName === path.basename(outputPath)) continue;
  const filePath = path.join(inputDir, fileName);

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    process.stderr.write(`Skipping ${fileName}: ${err.message}\n`);
    continue;
  }

  // Skip files that aren't recognized sections (intermediate tool outputs, helper files like next-steps).
  if (!SECTION_MAP[fileName]) continue;
  const meta = SECTION_MAP[fileName];

  if (raw && raw.status === 'skipped') {
    sections.push({
      id: meta.id,
      icon: meta.icon,
      label: meta.label,
      description: '',
      findings: [{
        id: `${meta.id}-skipped`,
        severity: 'info',
        title: `${meta.label} check was skipped`,
        details: raw.reason || 'No additional detail.',
      }],
      details: {},
    });
    totals.info += 1;
    continue;
  }

  const findings = Array.isArray(raw?.findings) ? raw.findings : [];
  const details = raw?.details || {};

  sections.push({
    id: meta.id,
    icon: meta.icon,
    label: meta.label,
    description: '',
    findings,
    details,
  });

  for (const f of findings) {
    if (f.severity && totals[f.severity] !== undefined) totals[f.severity] += 1;
  }
}

let nextSteps = [];
if (nextStepsFile) {
  try {
    const ns = JSON.parse(fs.readFileSync(nextStepsFile, 'utf8'));
    if (Array.isArray(ns)) nextSteps = ns.filter(x => typeof x === 'string');
  } catch (err) {
    process.stderr.write(`Could not read next-steps file: ${err.message}\n`);
  }
}

const now = new Date();
const pad = (n) => String(n).padStart(2, '0');
// Local-timezone short name (e.g. "IST", "PST"). Intl gives "GMT+5:30" on some platforms — strip to just the abbreviation when present.
const tzName = new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' }).formatToParts(now).find(p => p.type === 'timeZoneName')?.value || '';
const generatedAt = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}${tzName ? ' ' + tzName : ''}`;

const payload = {
  REPORT_NAME: reportName,
  SITE_NAME: siteName,
  GOAL_LABEL: goalLabel,
  SCOPE_LABEL: scopeLabel,
  GENERATED_AT: generatedAt,
  REVIEW_DATA: {
    summary: summaryArg || '',
    totals,
    sections,
    nextSteps,
  },
};

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, JSON.stringify(payload, null, 2));

process.stdout.write(JSON.stringify({
  status: 'ok',
  outputPath,
  totals,
  sectionsCount: sections.length,
}) + '\n');
