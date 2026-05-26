#!/usr/bin/env node
/**
 * diff-snapshots.js
 *
 * Compares an SDM snapshot and an EDM snapshot (produced by snapshot-site.js)
 * and classifies the differences per category. Output is purely informational
 * — the skill never auto-rolls-back based on this diff. The user reviews and
 * decides.
 *
 * USAGE
 *   node diff-snapshots.js \
 *     --sdm <output-dir>/sdm-snapshot.json \
 *     --edm <output-dir>/edm-snapshot.json \
 *     --output-dir <output-dir>
 *
 * OUTPUT
 *   <output-dir>/migration-data-diff.json + console table
 *
 * Per-category classification:
 *   pass — same identity set, same statecode normalization, same content hash
 *          (if applicable)
 *   warn — identity set matches, but some records changed statecode or content
 *   fail — at least one record present in SDM is missing from EDM, or extra
 *          records appeared in EDM, or counts differ
 */

const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[k] = true;
      else { out[k] = next; i += 1; }
    }
  }
  return out;
}

// Identity key fields per category. The diff pairs SDM and EDM records by
// constructing a string from these fields. Choose Dataverse-side fields
// (adx_name, partialUrl, language) — never the PAC-derived `slug`, which is
// only a folder name and could theoretically drift between PAC versions.
const KEY_FIELDS = {
  webPages: ['kind', 'name', 'partialUrl', 'language'],
  contentSnippets: ['name', 'language'],
  webLinkSets: ['name', 'language'],
  webTemplates: ['name'],
  webFiles: ['name', 'partialUrl'],
  pageTemplates: ['name'],
  tablePermissions: ['name', 'permissionName'],
  basicForms: ['name'],
  advancedForms: ['name'],
  lists: ['name'],
  polls: ['name'],
  pollPlacements: ['name'],
  cloudFlowConsumers: ['name'],
  columnPermissionProfiles: ['name'],
  siteSettings: ['name'],
  webRoles: ['name'],
  siteMarkers: ['name'],
  websiteAccesses: ['name'],
  publishingStates: ['name'],
  webpageRules: ['name'],
  websiteBindings: ['name'],
  websiteLanguages: ['name'],
  ads: ['name'],
  adPlacements: ['name'],
  tags: ['name'],
  urlHistory: ['name'],
};

// Categories where the diff should also compare a value field (in addition to
// identity), because the value carries operational meaning. siteSettings is
// the classic case: same setting key, but the value changed, is interesting.
const VALUE_FIELDS = {
  siteSettings: 'value',
};

function makeKey(rec, fields) {
  return fields.map((f) => String(rec[f] ?? '')).join('|');
}

// Treat null and 0 as equivalent: PAC only writes statecode for inactive
// records, so an active record can show up as either null (omitted) or 0
// depending on the data model version's serialization.
function normalizeStateCode(v) {
  if (v == null) return 0;
  return v;
}

function diffCategory(category, sdmInventory, edmInventory) {
  const keyFields = KEY_FIELDS[category] || ['name'];
  const valueField = VALUE_FIELDS[category];

  const sdmMap = new Map();
  for (const rec of sdmInventory) sdmMap.set(makeKey(rec, keyFields), rec);
  const edmMap = new Map();
  for (const rec of edmInventory) edmMap.set(makeKey(rec, keyFields), rec);

  const missingInEdm = [];   // present in SDM, not in EDM
  const extraInEdm = [];     // present in EDM, not in SDM
  const stateChanged = [];   // present in both, but statecode differs
  const contentChanged = []; // present in both, but contentHash differs (only if both had hashes)
  const valueChanged = [];   // present in both, but value field differs (siteSettings)

  for (const [key, sdmRec] of sdmMap) {
    const edmRec = edmMap.get(key);
    if (!edmRec) {
      missingInEdm.push(sdmRec);
      continue;
    }
    if (normalizeStateCode(sdmRec.stateCode) !== normalizeStateCode(edmRec.stateCode)) {
      stateChanged.push({ key, sdmStateCode: sdmRec.stateCode, edmStateCode: edmRec.stateCode, record: sdmRec });
    }
    if (sdmRec.contentHash != null && edmRec.contentHash != null && sdmRec.contentHash !== edmRec.contentHash) {
      contentChanged.push({ key, sdmHash: sdmRec.contentHash, edmHash: edmRec.contentHash, record: sdmRec });
    }
    if (valueField) {
      const sdmVal = sdmRec[valueField];
      const edmVal = edmRec[valueField];
      if (String(sdmVal ?? '') !== String(edmVal ?? '')) {
        valueChanged.push({ key, field: valueField, sdmValue: sdmVal, edmValue: edmVal });
      }
    }
  }
  for (const [key, edmRec] of edmMap) {
    if (!sdmMap.has(key)) extraInEdm.push(edmRec);
  }

  const sdmCount = sdmInventory.length;
  const edmCount = edmInventory.length;
  let status = 'pass';
  if (missingInEdm.length > 0 || extraInEdm.length > 0 || sdmCount !== edmCount) {
    status = 'fail';
  } else if (stateChanged.length > 0 || contentChanged.length > 0 || valueChanged.length > 0) {
    status = 'warn';
  }

  return {
    status,
    sdmCount,
    edmCount,
    missingInEdm,
    extraInEdm,
    stateChanged,
    contentChanged,
    valueChanged,
  };
}

function summarize(diff) {
  let totalSdm = 0, totalEdm = 0, totalMissing = 0, totalExtra = 0, totalStateChanged = 0, totalContentChanged = 0, totalValueChanged = 0;
  for (const c of Object.values(diff.categories)) {
    totalSdm += c.sdmCount;
    totalEdm += c.edmCount;
    totalMissing += c.missingInEdm.length;
    totalExtra += c.extraInEdm.length;
    totalStateChanged += c.stateChanged.length;
    totalContentChanged += c.contentChanged.length;
    totalValueChanged += c.valueChanged.length;
  }
  return { totalSdm, totalEdm, totalMissing, totalExtra, totalStateChanged, totalContentChanged, totalValueChanged };
}

function describeRecord(rec, keyFields) {
  const parts = keyFields.map((f) => rec[f] != null ? `${f}=${rec[f]}` : null).filter(Boolean);
  return parts.join(', ') || JSON.stringify(rec);
}

function statusGlyph(status) {
  if (status === 'pass') return '✓';
  if (status === 'warn') return '⚠';
  return '✗';
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const sdmPath = args['sdm'];
  const edmPath = args['edm'];
  const outputDir = args['output-dir'];
  if (!sdmPath || !edmPath || !outputDir) {
    console.error('Usage: diff-snapshots.js --sdm <file> --edm <file> --output-dir <dir>');
    process.exit(1);
  }
  if (!fs.existsSync(sdmPath)) { console.error(`Not found: ${sdmPath}`); process.exit(1); }
  if (!fs.existsSync(edmPath)) { console.error(`Not found: ${edmPath}`); process.exit(1); }

  const sdm = JSON.parse(fs.readFileSync(sdmPath, 'utf8'));
  const edm = JSON.parse(fs.readFileSync(edmPath, 'utf8'));

  if (sdm.label !== 'sdm') console.warn(`Warning: --sdm file has label '${sdm.label}', expected 'sdm'`);
  if (edm.label !== 'edm') console.warn(`Warning: --edm file has label '${edm.label}', expected 'edm'`);

  const allCategories = new Set([...Object.keys(sdm.inventory || {}), ...Object.keys(edm.inventory || {})]);

  const diff = {
    schemaVersion: 1,
    sdmSnapshotPath: path.resolve(sdmPath),
    edmSnapshotPath: path.resolve(edmPath),
    sdmCapturedAt: sdm.capturedAt,
    edmCapturedAt: edm.capturedAt,
    comparedAt: new Date().toISOString(),
    overallStatus: 'pass',
    categories: {},
    summary: null,
  };

  for (const cat of [...allCategories].sort()) {
    const sdmInv = sdm.inventory?.[cat] || [];
    const edmInv = edm.inventory?.[cat] || [];
    diff.categories[cat] = diffCategory(cat, sdmInv, edmInv);
    if (diff.categories[cat].status === 'fail') diff.overallStatus = 'fail';
    else if (diff.categories[cat].status === 'warn' && diff.overallStatus !== 'fail') diff.overallStatus = 'warn';
  }

  diff.summary = summarize(diff);

  fs.mkdirSync(outputDir, { recursive: true });
  const outPath = path.join(outputDir, 'migration-data-diff.json');
  fs.writeFileSync(outPath, JSON.stringify(diff, null, 2) + '\n', 'utf8');

  // Console summary
  console.log(`✓ Wrote ${outPath}\n`);
  console.log(`  Overall status: ${statusGlyph(diff.overallStatus)} ${diff.overallStatus.toUpperCase()}\n`);
  console.log(`  Category                    SDM    EDM    Status   Notes`);
  console.log(`  ──────────────────────────  ─────  ─────  ───────  ─────────────────────────────`);
  for (const [cat, c] of Object.entries(diff.categories)) {
    if (c.sdmCount === 0 && c.edmCount === 0) continue;
    const notes = [];
    if (c.missingInEdm.length) notes.push(`${c.missingInEdm.length} missing in EDM`);
    if (c.extraInEdm.length) notes.push(`${c.extraInEdm.length} extra in EDM`);
    if (c.stateChanged.length) notes.push(`${c.stateChanged.length} state changed`);
    if (c.contentChanged.length) notes.push(`${c.contentChanged.length} content changed`);
    if (c.valueChanged.length) notes.push(`${c.valueChanged.length} value changed`);
    console.log(
      `  ${cat.padEnd(26)}  ${String(c.sdmCount).padStart(5)}  ${String(c.edmCount).padStart(5)}  ${statusGlyph(c.status)} ${c.status.padEnd(5)}  ${notes.join(', ')}`,
    );
  }
  console.log('');
  const s = diff.summary;
  console.log(`  Totals: SDM=${s.totalSdm}, EDM=${s.totalEdm}, missing=${s.totalMissing}, extra=${s.totalExtra}, stateChanged=${s.totalStateChanged}, valueChanged=${s.totalValueChanged}`);

  // First-N example mismatches per category for quick eyeballing
  let printedExamples = false;
  for (const [cat, c] of Object.entries(diff.categories)) {
    const fields = KEY_FIELDS[cat] || ['name'];
    if (c.missingInEdm.length > 0) {
      if (!printedExamples) { console.log(''); printedExamples = true; }
      console.log(`  Missing from EDM in '${cat}' (showing up to 5):`);
      for (const r of c.missingInEdm.slice(0, 5)) console.log(`    - ${describeRecord(r, fields)}`);
    }
    if (c.extraInEdm.length > 0) {
      if (!printedExamples) { console.log(''); printedExamples = true; }
      console.log(`  Extra in EDM in '${cat}' (showing up to 5):`);
      for (const r of c.extraInEdm.slice(0, 5)) console.log(`    + ${describeRecord(r, fields)}`);
    }
  }

  // Exit code: 0 for pass/warn, 1 for fail. SKILL.md treats warn as user-decision.
  process.exit(diff.overallStatus === 'fail' ? 1 : 0);
}

main();
