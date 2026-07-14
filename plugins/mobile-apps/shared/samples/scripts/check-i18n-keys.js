#!/usr/bin/env node
/**
 * check-i18n-keys.js
 *
 * Cross-checks every t('...') call in src/ and app/ against localization.json.
 * In adapted Canvas ports, unknown keys usually mean the builder invented a
 * translation key instead of preserving a literal fallback.
 */
const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const STRICT = process.env.STRICT === '1' || process.argv.includes('--strict');
const LOC_PATH = path.join(ROOT, 'localization.json');

if (!fs.existsSync(LOC_PATH)) {
  console.error('[i18n] localization.json not found - skipping');
  process.exit(0);
}

const catalog = JSON.parse(fs.readFileSync(LOC_PATH, 'utf8'));
const known = new Set(catalog.keys || []);

function walk(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (['node_modules', '.expo', 'android', 'ios', 'build', 'dist', 'generated'].includes(entry.name)) continue;
      out.push(...walk(path.join(dir, entry.name)));
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

const files = [...walk(path.join(ROOT, 'src')), ...walk(path.join(ROOT, 'app'))];
const re = /\bt\(\s*['"]([^'"]+)['"]/g;
const unknownByFile = new Map();
const allUsed = new Set();

for (const file of files) {
  const text = fs.readFileSync(file, 'utf8');
  let match;
  while ((match = re.exec(text))) {
    const key = match[1];
    allUsed.add(key);
    if (!known.has(key)) {
      if (!unknownByFile.has(file)) unknownByFile.set(file, new Set());
      unknownByFile.get(file).add(key);
    }
  }
}

let unknownTotal = 0;
for (const keys of unknownByFile.values()) unknownTotal += keys.size;

console.log('\n=== i18n coverage ===');
console.log(`catalog keys:        ${known.size}`);
console.log(`keys used in app/:   ${allUsed.size}`);
console.log(`keys overlap (good): ${[...allUsed].filter((key) => known.has(key)).length}`);
console.log(`unknown keys used:   ${unknownTotal}`);
console.log(`catalog keys unused: ${[...known].filter((key) => !allUsed.has(key)).length}`);

if (unknownByFile.size > 0) {
  console.log('\n=== unknown keys per file ===');
  for (const [file, keys] of unknownByFile) {
    console.log(`  ${path.relative(ROOT, file)}`);
    for (const key of [...keys].sort()) console.log(`    - ${key}`);
  }
}

if (STRICT && unknownTotal > 0) {
  console.error(`\n[i18n] ${unknownTotal} unknown key(s) - STRICT mode failure`);
  process.exit(1);
}
process.exit(0);
