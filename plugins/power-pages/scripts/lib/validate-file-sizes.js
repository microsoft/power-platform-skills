#!/usr/bin/env node

// Validates that no individual file in the pending Changes set exceeds the
// 17 MB per-file cap that ADO enforces during CommitToGit.
//
// Per Microsoft Learn (git-integration FAQ): files are base64-encoded on the
// wire, so the practical raw-file limit is ~12.75 MB (17 × 0.75) — but the
// authoritative check is on the encoded size (estimatedBytes after × 4/3).
//
// API reference: references/git-integration-api-patterns.md §9
//
// This is a PURE validator — no HTTP. It consumes the items[] array from
// list-pending-changes.js. The commit-to-git skill runs:
//   pending = await listPendingChanges(...);
//   issues = validateFileSizes(pending.items);
//   if (issues.blocking.length > 0) → block commit; surface to user
//
// Algorithm: cap is 17 MB on the base64-encoded payload. For a raw file of
// N bytes, base64 size = ceil(N / 3) × 4 = ~1.333 × N. So:
//   - raw ≤ ~12.75 MB → safe
//   - raw ≤ ~17 MB but encoded > 17 MB → BLOCK (this is the "surprising" case
//     users hit because the Pages UI shows raw size, not encoded)
//
// Output (JSON to stdout):
//   {
//     totalFiles: <int>,
//     totalRawBytes: <int>,
//     totalEncodedBytes: <int>,
//     blocking:  [ { componentId, componentName, componentType, filePath, rawBytes, encodedBytes, capBytes, overByBytes }, ... ],
//     warnings:  [ { componentId, componentName, rawBytes, encodedBytes, percentOfCap }, ... ],
//     ok: bool,
//   }
//
// `warnings[]` lists files > 80% of the cap that didn't yet block — the
// commit-to-git skill surfaces these as soft warnings so the user can
// proactively trim before they actually fail.
//
// Usage:
//   node validate-file-sizes.js --items-file <path-to-items.json>
//   node validate-file-sizes.js --pending-file <path-to-list-pending-changes-output.json>
//   echo '<json>' | node validate-file-sizes.js --stdin

'use strict';

const fs = require('node:fs');

// 17 MB base64-encoded; ~12.75 MB raw. Source: Microsoft Learn git-integration FAQ.
const CAP_BYTES = 17 * 1024 * 1024;
const WARN_THRESHOLD = 0.80; // soft-warn at 80% of cap

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
 * Estimate the base64-encoded byte length of a raw byte count.
 * Base64 emits 4 chars per 3 bytes, padded to a multiple of 4.
 */
function base64Length(rawBytes) {
  if (typeof rawBytes !== 'number' || rawBytes < 0) return 0;
  return Math.ceil(rawBytes / 3) * 4;
}

/**
 * Validate a list of pending-change items against the 17 MB cap.
 *
 * @param {Array<object>} items     items[] from list-pending-changes.js
 * @param {object}        [options]
 * @param {number}        [options.capBytes]       Override cap (testing).
 * @param {number}        [options.warnThreshold]  Override warn threshold (0..1).
 * @returns {{
 *   totalFiles: number,
 *   totalRawBytes: number,
 *   totalEncodedBytes: number,
 *   blocking: Array<object>,
 *   warnings: Array<object>,
 *   ok: boolean,
 * }}
 */
function validateFileSizes(items, { capBytes = CAP_BYTES, warnThreshold = WARN_THRESHOLD } = {}) {
  if (!Array.isArray(items)) {
    throw new Error('validateFileSizes: items must be an array');
  }
  const blocking = [];
  const warnings = [];
  let totalRawBytes = 0;
  let totalEncodedBytes = 0;

  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    // estimatedBytes is the raw payload size; null/undefined means we couldn't
    // measure it server-side. Skip those (validator is conservative: no data
    // means no judgment).
    const raw = typeof it.estimatedBytes === 'number' ? it.estimatedBytes : null;
    if (raw === null) continue;
    const encoded = base64Length(raw);
    totalRawBytes += raw;
    totalEncodedBytes += encoded;

    if (encoded > capBytes) {
      blocking.push({
        ref: 'IL-SIZE-001',
        componentId: it.componentId ?? null,
        componentName: it.componentName ?? null,
        componentType: it.componentType ?? null,
        filePath: it.filePath ?? null,
        rawBytes: raw,
        encodedBytes: encoded,
        capBytes,
        overByBytes: encoded - capBytes,
      });
    } else if (encoded > capBytes * warnThreshold) {
      warnings.push({
        ref: 'IL-SIZE-002',
        componentId: it.componentId ?? null,
        componentName: it.componentName ?? null,
        componentType: it.componentType ?? null,
        filePath: it.filePath ?? null,
        rawBytes: raw,
        encodedBytes: encoded,
        percentOfCap: Number(((encoded / capBytes) * 100).toFixed(2)),
      });
    }
  }

  return {
    totalFiles: items.length,
    totalRawBytes,
    totalEncodedBytes,
    blocking,
    warnings,
    ok: blocking.length === 0,
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
  if (args.itemsFile) {
    items = JSON.parse(fs.readFileSync(args.itemsFile, 'utf8'));
  } else if (args.pendingFile) {
    const parsed = JSON.parse(fs.readFileSync(args.pendingFile, 'utf8'));
    items = parsed.items || [];
  } else if (args.stdin) {
    const parsed = JSON.parse(await readStdin());
    items = Array.isArray(parsed) ? parsed : (parsed.items || []);
  } else {
    process.stderr.write('validate-file-sizes: provide --items-file, --pending-file, or --stdin\n');
    process.exit(1);
  }
  const r = validateFileSizes(items);
  process.stdout.write(JSON.stringify(r, null, 2) + '\n');
}

if (require.main === module) {
  main().catch((e) => {
    process.stderr.write('validate-file-sizes: ' + e.message + '\n');
    process.exit(1);
  });
}

module.exports = { validateFileSizes, base64Length, CAP_BYTES, WARN_THRESHOLD };
