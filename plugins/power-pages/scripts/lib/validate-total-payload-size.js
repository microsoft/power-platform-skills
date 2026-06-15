#!/usr/bin/env node

// V-13 pure validator: WARN when the total encoded size of all pending
// Changes exceeds a configurable threshold (default 100 MB). CommitToGit
// on 1000+ components or hundreds of MB of payload takes 5-15 min and
// can trip per-action throttles; a pre-flight heads-up lets the user
// defer the push to off-peak hours.
//
// PURE validator — consumes the pending-changes snapshot via the standard
// --items-file / --pending-file / --stdin flag set; no HTTP.
//
// Output (JSON to stdout): standard envelope.
//   {
//     ok: true,                        // never blocks
//     totalChecked: <int>,             // items considered
//     blocking: [],
//     warnings: [ { severity:'warn', key:'total-payload-size-warning', ... } ],
//     info: [
//       {
//         severity:'info',
//         key:'total-payload-summary',
//         details: { totalRawBytes, totalEncodedBytes, itemsWithoutSize, threshold }
//       }
//     ],
//   }
//
// Usage:
//   node validate-total-payload-size.js --items-file <path>
//   node validate-total-payload-size.js --pending-file <path>
//   echo '<json>' | node validate-total-payload-size.js --stdin
//   [--threshold-mb <n>]              // default 100

'use strict';

const fs = require('node:fs');
const { base64Length } = require('./validate-file-sizes');

const DEFAULT_THRESHOLD_MB = 100;

function parseArgs(argv) {
  const a = argv.slice(2);
  const out = { itemsFile: null, pendingFile: null, stdin: false, thresholdMb: DEFAULT_THRESHOLD_MB };
  for (let i = 0; i < a.length; i++) {
    if      (a[i] === '--items-file'   && a[i+1]) out.itemsFile = a[++i];
    else if (a[i] === '--pending-file' && a[i+1]) out.pendingFile = a[++i];
    else if (a[i] === '--stdin')                  out.stdin = true;
    else if (a[i] === '--threshold-mb' && a[i+1]) out.thresholdMb = parseInt(a[++i], 10);
  }
  return out;
}

function validateTotalPayloadSize(items, { thresholdMb = DEFAULT_THRESHOLD_MB } = {}) {
  if (!Array.isArray(items)) {
    throw new Error('validateTotalPayloadSize: items must be an array');
  }
  let totalRawBytes = 0;
  let totalEncodedBytes = 0;
  let itemsWithoutSize = 0;

  for (const it of items) {
    if (!it) continue;
    const raw = typeof it.estimatedBytes === 'number' ? it.estimatedBytes : null;
    if (raw === null) { itemsWithoutSize++; continue; }
    totalRawBytes    += raw;
    totalEncodedBytes += base64Length(raw);
  }

  const thresholdBytes = thresholdMb * 1024 * 1024;
  const warnings = [];
  const info = [{
    severity: 'info',
    key: 'total-payload-summary',
    message: `Total encoded payload: ${(totalEncodedBytes / (1024 * 1024)).toFixed(2)} MB across ${items.length} item(s).`,
    ref: 'IL-SIZE-003',
    details: {
      totalItems: items.length,
      itemsWithoutSize,
      totalRawBytes,
      totalEncodedBytes,
      thresholdMb,
      thresholdBytes,
    },
    remediation: null,
  }];

  if (totalEncodedBytes > thresholdBytes) {
    warnings.push({
      severity: 'warn',
      key: 'total-payload-size-warning',
      message: `Total encoded payload (${(totalEncodedBytes / (1024 * 1024)).toFixed(1)} MB) exceeds threshold of ${thresholdMb} MB; commit may take 5–15 min and trip throttles.`,
      ref: 'IL-SIZE-004',
      details: {
        totalEncodedMb: Number((totalEncodedBytes / (1024 * 1024)).toFixed(2)),
        thresholdMb,
        totalItems: items.length,
      },
      remediation: 'Consider deferring the commit to off-peak hours, or splitting it into smaller batches.',
    });
  }

  return {
    ok: true,
    totalChecked: items.length,
    blocking: [],
    warnings,
    info,
  };
}

async function readStdin() {
  return new Promise((resolve, reject) => {
    let s = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { s += c; });
    process.stdin.on('end',  () => resolve(s));
    process.stdin.on('error', reject);
  });
}

async function main() {
  const args = parseArgs(process.argv);
  let items = [];
  if      (args.itemsFile)   items = JSON.parse(fs.readFileSync(args.itemsFile,   'utf8'));
  else if (args.pendingFile) items = JSON.parse(fs.readFileSync(args.pendingFile, 'utf8')).items || [];
  else if (args.stdin) {
    const parsed = JSON.parse(await readStdin());
    items = Array.isArray(parsed) ? parsed : (parsed.items || []);
  } else {
    process.stderr.write('validate-total-payload-size: provide --items-file, --pending-file, or --stdin\n');
    process.exit(1);
  }
  const r = validateTotalPayloadSize(items, { thresholdMb: args.thresholdMb });
  process.stdout.write(JSON.stringify(r, null, 2) + '\n');
}

if (require.main === module) {
  main().catch((e) => {
    process.stderr.write('validate-total-payload-size: ' + e.message + '\n');
    process.exit(1);
  });
}

module.exports = {
  validateTotalPayloadSize,
  DEFAULT_THRESHOLD_MB,
};
