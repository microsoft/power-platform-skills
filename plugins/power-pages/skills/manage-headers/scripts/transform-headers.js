#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { loadSiteSettings } = require('../../../scripts/lib/powerpages-config');

const CSP_HEADER_NAMES = new Set([
  'HTTP/Content-Security-Policy',
  'HTTP/Content-Security-Policy-Report-Only',
]);

const EMPTY_RESULT = { status: 'ok', findings: [], details: {} };

const HELP = `transform-headers.js — Emit HTTP/* site-setting inventory as section data.

Usage:
  node transform-headers.js --projectRoot <path> [--annotations <path>]

Flags:
  --projectRoot  Power Pages project root (containing .powerpages-site/)
  --annotations  Path to agent-provided annotations JSON (optional)
  --help         Show this help message

Annotations shape (all keys optional):
  {
    "headers": {
      "HTTP/<HeaderName>": { "description": "Plain-language summary", "fix": "Optional fix" }
    }
  }

Exit codes:
  0  Success (unified JSON on stdout — { status, findings, details })
  1  Invocation error (missing --projectRoot)

Examples:
  node transform-headers.js --projectRoot <project-root>
  node transform-headers.js --projectRoot <project-root> --annotations <annotations-file>
`;

function getArg(name, argv) {
  const idx = argv.indexOf('--' + name);
  return idx !== -1 && idx + 1 < argv.length ? argv[idx + 1] : null;
}

function readJson(filePath, label) {
  if (!fs.existsSync(filePath)) {
    process.stderr.write(`${label} not found: ${filePath}\n`);
    process.exit(1);
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    process.stderr.write(`Failed to parse ${label} (${filePath}): ${err.message}\n`);
    process.exit(1);
  }
}

// CSP values are long single-line strings; render one directive per line.
function formatValue(name, value) {
  if (!CSP_HEADER_NAMES.has(name)) return value;
  const stripped = value.trim().replace(/^"|"$/g, '');
  const directives = stripped
    .split(';')
    .map((d) => d.trim())
    .filter(Boolean);
  if (directives.length <= 1) return stripped;
  return directives.map((d) => `  ${d};`).join('\n');
}

function buildFinding(rec, idx, annotation) {
  // YAML scalars aren't always strings (booleans, numbers, nulls all pass through here).
  const value = rec.value != null ? String(rec.value) : '';
  const detailParts = [];
  if (annotation.description) detailParts.push(annotation.description);
  detailParts.push(
    'Current value:\n' + (value ? formatValue(rec.name, value) : '  (empty)')
  );
  return {
    id: `headers-${idx + 1}`,
    title: rec.name,
    details: detailParts.join('\n\n'),
    ...(annotation.fix ? { fix: annotation.fix } : {}),
  };
}

function transform(records, annotations) {
  const httpRecords = records
    .filter((r) => r.name?.startsWith('HTTP/'))
    .sort((a, b) => a.name.localeCompare(b.name));

  const headerAnnotations = annotations.headers || {};
  const findings = httpRecords.map((rec, i) =>
    buildFinding(rec, i, headerAnnotations[rec.name] || {})
  );

  return { status: 'ok', findings, details: {} };
}

function main(argv = process.argv) {
  if (argv.includes('--help')) {
    process.stdout.write(HELP);
    return 0;
  }

  const projectRoot = getArg('projectRoot', argv);
  const annotationsFile = getArg('annotations', argv);
  if (!projectRoot) {
    process.stderr.write(
      'Usage: node transform-headers.js --projectRoot <path> [--annotations <path>]\n'
    );
    return 1;
  }

  const siteSettingsDir = path.join(projectRoot, '.powerpages-site', 'site-settings');
  if (!fs.existsSync(siteSettingsDir)) {
    process.stdout.write(
      JSON.stringify({ ...EMPTY_RESULT, status: 'missing-settings' }) + '\n'
    );
    return 0;
  }

  const records = loadSiteSettings(siteSettingsDir);
  const annotations = annotationsFile ? readJson(annotationsFile, 'annotations file') : {};
  process.stdout.write(JSON.stringify(transform(records, annotations)) + '\n');
  return 0;
}

module.exports = { transform };

if (require.main === module) {
  process.exit(main());
}
