#!/usr/bin/env node

// Soft-warns when a Canvas app in the pending Changes set is approaching the
// per-file 17 MB cap. Canvas apps are stored as a single .msapp file in Git
// and grow non-linearly as makers add screens, controls, and media — so a
// Canvas app at 12 MB today is often at 18 MB next month and BLOCKS commit.
//
// This is INFORMATIONAL: it does NOT block commit. The validate-file-sizes
// validator does the actual blocking at 17 MB. This validator surfaces a
// proactive nudge ("your Canvas app is at 80% of the cap — consider splitting")
// BEFORE the user hits the wall.
//
// API reference: references/inner-loop-error-catalog.md IL-003 (Canvas grew
// past cap) and references/git-integration-api-patterns.md §9.
//
// PURE validator — no HTTP. Consumes items[] from list-pending-changes.js.
//
// Output (JSON to stdout):
//   {
//     totalCanvasApps: <int>,
//     warnings: [
//       {
//         componentId, componentName, componentType, filePath,
//         rawBytes, encodedBytes, percentOfCap, severity: 'warn'|'critical'
//       }, ...
//     ],
//     ok: bool,                  // always true (warnings only)
//   }
//
// Severity bands:
//   warn       — encoded between 70% and 90% of cap
//   critical   — encoded between 90% and 100% of cap (next commit may fail)
//
// Files at >100% of cap are NOT included here — those are surfaced by
// validate-file-sizes.js as blocking errors.
//
// Usage:
//   node check-large-canvas-warning.js --items-file <path>
//   node check-large-canvas-warning.js --pending-file <path>
//   echo '<json>' | node check-large-canvas-warning.js --stdin

'use strict';

const fs = require('node:fs');
const { base64Length, CAP_BYTES } = require('./validate-file-sizes');

const WARN_THRESHOLD = 0.70;
const CRITICAL_THRESHOLD = 0.90;

// componentType strings the platform uses for Canvas apps. Multiple variants
// because PowerApps has shipped under different umbrella names over the years.
// TODO: HAR-verify the exact value for ./gitcommitfiles rows.
const CANVAS_APP_TYPES = new Set([
  'canvasapp',           // most likely modern value
  'mscanvasapp',
  'canvas_app',
  'msdyn_canvasapp',
  'PowerAppsCanvasApp',  // legacy CDS naming
]);

// Filenames that strongly signal a Canvas .msapp payload regardless of the
// componentType the API echoes back.
const CANVAS_FILE_REGEX = /\.msapp$/i;

function isCanvasApp(item) {
  if (!item || typeof item !== 'object') return false;
  const type = item.componentType ? String(item.componentType).toLowerCase() : '';
  if (CANVAS_APP_TYPES.has(type)) return true;
  if (type === 'canvasapp') return true;
  if (item.filePath && CANVAS_FILE_REGEX.test(item.filePath)) return true;
  return false;
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = { itemsFile: null, pendingFile: null, stdin: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--items-file' && args[i + 1]) out.itemsFile = args[++i];
    else if (args[i] === '--pending-file' && args[i + 1]) out.pendingFile = args[++i];
    else if (args[i] === '--stdin') out.stdin = true;
  }
  return out;
}

/**
 * @param {Array<object>} items
 * @param {object} [options]
 * @param {number} [options.capBytes]
 * @param {number} [options.warnThreshold]
 * @param {number} [options.criticalThreshold]
 */
function checkLargeCanvasWarning(items, {
  capBytes = CAP_BYTES,
  warnThreshold = WARN_THRESHOLD,
  criticalThreshold = CRITICAL_THRESHOLD,
} = {}) {
  if (!Array.isArray(items)) {
    throw new Error('checkLargeCanvasWarning: items must be an array');
  }
  let totalCanvasApps = 0;
  const warnings = [];

  for (const it of items) {
    if (!isCanvasApp(it)) continue;
    totalCanvasApps++;
    const raw = typeof it.estimatedBytes === 'number' ? it.estimatedBytes : null;
    if (raw === null) continue;
    const encoded = base64Length(raw);
    const pct = encoded / capBytes;
    if (pct < warnThreshold) continue;
    if (pct >= 1) continue; // these are blocking — let validate-file-sizes own them

    warnings.push({
      componentId: it.componentId ?? null,
      componentName: it.componentName ?? null,
      componentType: it.componentType ?? null,
      filePath: it.filePath ?? null,
      rawBytes: raw,
      encodedBytes: encoded,
      percentOfCap: Number((pct * 100).toFixed(2)),
      severity: pct >= criticalThreshold ? 'critical' : 'warn',
    });
  }

  return {
    totalCanvasApps,
    warnings,
    ok: true, // informational only
  };
}

async function readStdin() {
  return new Promise((resolve, reject) => {
    let s = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { s += c; });
    process.stdin.on('end', () => resolve(s));
    process.stdin.on('error', reject);
  });
}

async function main() {
  const args = parseArgs(process.argv);
  let items = [];
  if (args.itemsFile) items = JSON.parse(fs.readFileSync(args.itemsFile, 'utf8'));
  else if (args.pendingFile) items = JSON.parse(fs.readFileSync(args.pendingFile, 'utf8')).items || [];
  else if (args.stdin) {
    const parsed = JSON.parse(await readStdin());
    items = Array.isArray(parsed) ? parsed : (parsed.items || []);
  } else {
    process.stderr.write('check-large-canvas-warning: provide --items-file, --pending-file, or --stdin\n');
    process.exit(1);
  }
  const r = checkLargeCanvasWarning(items);
  process.stdout.write(JSON.stringify(r, null, 2) + '\n');
}

if (require.main === module) {
  main().catch((e) => {
    process.stderr.write('check-large-canvas-warning: ' + e.message + '\n');
    process.exit(1);
  });
}

module.exports = {
  checkLargeCanvasWarning, isCanvasApp,
  CANVAS_APP_TYPES, CANVAS_FILE_REGEX,
  WARN_THRESHOLD, CRITICAL_THRESHOLD,
};
