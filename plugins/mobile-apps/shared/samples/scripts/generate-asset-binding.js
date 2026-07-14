#!/usr/bin/env node
/**
 * generate-asset-binding.js
 *
 * Reads assets.json and writes src/generated/assets.ts exporting typed
 * require() handles for bundled PNG/JPG/GIF assets that exist on disk.
 */
const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const ASSETS_JSON = path.join(ROOT, 'assets.json');
const ASSETS_DIR = path.join(ROOT, 'assets/images');
const OUT = path.join(ROOT, 'src/generated/assets.ts');
const MAX_ASSET_ENTRIES = 10000;

if (!fs.existsSync(ASSETS_JSON)) {
  console.error('[assets] assets.json not found - skipping');
  process.exit(0);
}

const json = JSON.parse(fs.readFileSync(ASSETS_JSON, 'utf8'));
if (!Array.isArray(json.images) || json.images.length > MAX_ASSET_ENTRIES) {
  console.error(`[assets] assets.json images must be an array with at most ${MAX_ASSET_ENTRIES} entries`);
  process.exit(1);
}
const onDisk = new Set(fs.existsSync(ASSETS_DIR)
  ? fs.readdirSync(ASSETS_DIR).filter((file) => {
      const full = path.join(ASSETS_DIR, file);
      return fs.lstatSync(full).isFile() && !fs.lstatSync(full).isSymbolicLink();
    })
  : []);
const entries = [];
const missing = [];
const usedNames = new Set();

for (const image of json.images) {
  const file = path.posix.basename(String(image.fileName || '').replace(/\\/g, '/'));
  const stem = file.replace(/\..*$/, '').toUpperCase();
  const portable = file.length <= 240 && !/[<>:"/\\|?*\u0000-\u001f\u007f]/.test(file)
    && !/[. ]$/.test(file) && !/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem);
  let name = String(image.name || '').normalize('NFKC').replace(/[^A-Za-z0-9_]/g, '_').replace(/^_+|_+$/g, '');
  if (!file || !name || !portable) continue;
  if (!onDisk.has(file)) {
    missing.push({ name, file });
    continue;
  }
  const ext = path.extname(file).toLowerCase();
  if (!['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext)) {
    missing.push({ name, file });
    continue;
  }
  const base = name;
  let suffix = 2;
  while (usedNames.has(name)) name = `${base}_${suffix++}`;
  usedNames.add(name);
  entries.push({ name, file });
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
const body = `// AUTO-GENERATED - do not edit. Run \`node scripts/generate-asset-binding.js\`.
// Maps source-app asset names to bundled require() handles.

export type AssetName = ${entries.length ? entries.map((entry) => JSON.stringify(entry.name)).join(' | ') : 'never'};

export const assets: Record<AssetName, number> = {
${entries.map((entry) => `  ${JSON.stringify(entry.name)}: require(${JSON.stringify(`../../assets/images/${entry.file}`)}),`).join('\n')}
};
`;
fs.writeFileSync(OUT, body, 'utf8');
console.log(`[assets] wrote ${OUT} with ${entries.length} entries (skipped ${missing.length} missing / non-png-jpg-gif)`);
if (missing.length) {
  console.log('[assets] missing or unsupported on disk (sample):');
  for (const item of missing.slice(0, 10)) console.log(`  - ${item.name} (${item.file})`);
}
