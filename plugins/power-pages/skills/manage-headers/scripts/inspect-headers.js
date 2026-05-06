#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const KNOWN_SETTINGS = [
  { match: /^HTTP\/Content-Security-Policy/i, category: 'csp' },
  { match: /^HTTP\/X-Frame-Options/i, category: 'frame' },
  { match: /^HTTP\/Access-Control-/i, category: 'cors' },
  { match: /^HTTP\/SameSite\//i, category: 'cookie' },
  { match: /^HTTP\/X-Content-Type-Options/i, category: 'advanced' },
  { match: /^HTTP\//, category: 'advanced' },
];

const EXPECTED = [
  'HTTP/Content-Security-Policy',
  'HTTP/X-Frame-Options',
  'HTTP/X-Content-Type-Options',
];

function getArg(name) {
  const i = process.argv.indexOf('--' + name);
  return i !== -1 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}

function showHelp() {
  process.stdout.write(`inspect-headers.js — Inventory security-header site settings.

Usage:
  node inspect-headers.js --projectRoot <path> --output <file>

Flags:
  --projectRoot   Project root containing .powerpages-site/
  --output        Path for the inventory JSON
  --help          Show this help message

Exit codes:
  0  Success
  1  Invocation error (missing flags, missing site-settings folder)

Output JSON shape (written to --output):
  {
    "settings": [
      { "name": "HTTP/Content-Security-Policy", "value": "...", "filePath": "...", "category": "csp" }
    ],
    "missing": ["HTTP/X-Content-Type-Options"]
  }
`);
}

function categorize(name) {
  for (const rule of KNOWN_SETTINGS) {
    if (rule.match.test(name)) return rule.category;
  }
  return 'other';
}

function parseSetting(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

if (process.argv.includes('--help')) {
  showHelp();
  process.exit(0);
}

const projectRoot = getArg('projectRoot');
const output = getArg('output');

if (!projectRoot || !output) {
  process.stderr.write('Usage: node inspect-headers.js --projectRoot <path> --output <file>\n');
  process.exit(1);
}

const settingsDir = path.join(projectRoot, '.powerpages-site', 'site-settings');
if (!fs.existsSync(settingsDir)) {
  process.stderr.write(`Site settings folder not found: ${settingsDir}\n`);
  process.exit(1);
}

const files = fs.readdirSync(settingsDir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
const settings = [];
for (const f of files) {
  try {
    const filePath = path.join(settingsDir, f);
    const data = parseSetting(filePath);
    if (!data.name) continue;
    const category = categorize(data.name);
    if (category === 'other') continue;
    settings.push({
      name: data.name,
      value: data.value !== undefined ? data.value : null,
      filePath: filePath.replace(/\\/g, '/'),
      category,
    });
  } catch (err) {
    process.stderr.write(`Skipping ${f}: ${err.message}\n`);
  }
}

const presentNames = new Set(settings.map((s) => s.name));
const missing = EXPECTED.filter((n) => !presentNames.has(n));

const result = { settings, missing };
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, JSON.stringify(result, null, 2));
process.stdout.write(JSON.stringify({ status: 'ok', count: settings.length, missing: missing.length, output }) + '\n');
