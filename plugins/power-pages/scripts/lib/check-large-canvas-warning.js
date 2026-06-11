#!/usr/bin/env node

// Soft-warns when a Canvas app in the pending Changes set is approaching the
// per-file 17 MB cap. Canvas apps are stored as a single .msapp file in Git
// and grow non-linearly as makers add screens, controls, and media — so a
// Canvas app at 12 MB today is often at 18 MB next month and BLOCKS commit.
//
// This is INFORMATIONAL: it does NOT block commit. The validate-file-sizes
// validator does the actual blocking at 17 MB encoded. This validator
// surfaces a proactive nudge ("your Canvas app is at 60% of the cap —
// consider splitting") BEFORE the user hits the wall.
//
// V-12 change: thresholds switched from encoded-fraction (0.70 / 0.90 of
// encoded CAP_BYTES) to **raw-byte** thresholds (8 MB warn / 11 MB
// critical). Empirically a 9 MB Canvas .msapp commonly grows to 18 MB
// within a month, so an encoded-fraction model warned too late. Raw-byte
// thresholds also match what users see in Explorer / their PR diff stats.
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
// Severity bands (raw bytes):
//   warn       — 8 MB ≤ rawBytes < 11 MB
//   critical   — 11 MB ≤ rawBytes < RAW_CAP_BYTES (~12.75 MB)
//
// Files whose encoded size already exceeds CAP_BYTES (i.e. rawBytes ≥
// RAW_CAP_BYTES) are NOT included here — those are surfaced by
// validate-file-sizes.js as blocking errors.
//
// Usage:
//   node check-large-canvas-warning.js --items-file <path>
//   node check-large-canvas-warning.js --pending-file <path>
//   echo '<json>' | node check-large-canvas-warning.js --stdin

'use strict';

const fs = require('node:fs');
const { base64Length, CAP_BYTES } = require('./validate-file-sizes');

// V-12: raw-byte thresholds. ~60% / ~85% of RAW_CAP_BYTES.
const WARN_BYTES     = 8  * 1024 * 1024; // 8 MB raw
const CRITICAL_BYTES = 11 * 1024 * 1024; // 11 MB raw

// Effective raw-byte cap = encoded-cap / base64 expansion factor.
// base64Length(n) ≈ ceil(n/3)*4, so raw-cap ≈ CAP_BYTES * 3 / 4. Approx
// 12.75 MB for CAP_BYTES = 17 MB. Anything ≥ this is blocked by
// validate-file-sizes (because its encoded size exceeds CAP_BYTES).
const RAW_CAP_BYTES = Math.floor(CAP_BYTES * 3 / 4);

// Kept as exports for back-compat with older callers / tests. Derived from
// the new raw thresholds so they stay in sync if WARN_BYTES / CRITICAL_BYTES
// move.
const WARN_THRESHOLD     = WARN_BYTES     / RAW_CAP_BYTES;
const CRITICAL_THRESHOLD = CRITICAL_BYTES / RAW_CAP_BYTES;

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
 * @param {number} [options.capBytes]                 // encoded cap (legacy)
 * @param {number} [options.warnBytes]                // raw warn threshold (V-12)
 * @param {number} [options.criticalBytes]            // raw critical threshold (V-12)
 * @param {number} [options.rawCapBytes]              // raw cap (anything ≥ this is excluded; validate-file-sizes blocks)
 */
function checkLargeCanvasWarning(items, {
  capBytes      = CAP_BYTES,
  warnBytes     = WARN_BYTES,
  criticalBytes = CRITICAL_BYTES,
  rawCapBytes   = RAW_CAP_BYTES,
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
    if (raw < warnBytes) continue;                     // below warn band
    if (raw >= rawCapBytes) continue;                  // encoded over cap → validate-file-sizes owns it

    const pct = raw / rawCapBytes;
    warnings.push({
      componentId: it.componentId ?? null,
      componentName: it.componentName ?? null,
      componentType: it.componentType ?? null,
      filePath: it.filePath ?? null,
      rawBytes: raw,
      encodedBytes: encoded,
      percentOfCap: Number((pct * 100).toFixed(2)),
      severity: raw >= criticalBytes ? 'critical' : 'warn',
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
  WARN_BYTES, CRITICAL_BYTES, RAW_CAP_BYTES,
};
