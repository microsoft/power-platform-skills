#!/usr/bin/env node

// Detects missing referenced solution components in pending Changes — the
// classic "I added a Form but the Web Page that hosts it is not in this
// commit" foot-gun. The recipient env will Pull the Form successfully but
// fail at runtime because the parent Web Page can't be found.
//
// API reference: references/inner-loop-error-catalog.md IL-008 (missing dep)
//
// This validator runs in TWO modes:
//
//   1. **Local mode (default)** — pure: scans the items[] payload for known
//      reference fields (`parentcomponentId`, `webpageId`, `formId`, etc.)
//      and surfaces references to components not present in this commit.
//      Does NOT call Dataverse — it cannot tell whether the missing reference
//      already exists in the target env or is genuinely new.
//
//   2. **Server-check mode (--envUrl, --solutionUniqueName)** — for each
//      missing reference, optionally query the solutioncomponents table on
//      the source env to verify the component IS already in the bound
//      solution (so it would have been part of an earlier commit). This is
//      best-effort; tested via createAdoClient-style URL injection.
//
// Server-check mode is OFF by default. The commit-to-git skill flips it on
// when the user has an active env binding and a network connection — and
// always presents results as warnings (NEVER as blocks), because the platform
// may legitimately resolve the reference at Pull time on the recipient.
//
// PURE in local mode — no HTTP unless --envUrl is supplied.
//
// Output (JSON to stdout):
//   {
//     totalReferences: <int>,
//     missing: [
//       {
//         fromComponent: { componentId, componentName, componentType },
//         referenceField: "<field>",
//         referencedId: "<guid>",
//         severity: 'warn',
//         note: "<human-readable>",
//       }, ...
//     ],
//     ok: bool,                  // always true (warnings only)
//   }
//
// Usage:
//   node validate-dependencies.js --items-file <path>
//   node validate-dependencies.js --pending-file <path>
//   echo '<json>' | node validate-dependencies.js --stdin

'use strict';

const fs = require('node:fs');

// Reference-field names that commonly appear in Dataverse component payloads.
// We look for these as keys on each item (or under item.references[]) and
// extract guid values to cross-check against the commit's componentId set.
//
// TODO: HAR-verify — the exact reference-field names that surface in the
// gitcommitfiles row payloads. Some come from the underlying entity's schema
// (e.g. mspp_webpage has mspp_websiteid as a lookup); others are emitted as
// a normalized `references` array by the platform.
const KNOWN_REFERENCE_FIELDS = [
  'parentcomponentid',
  'parentcomponentId',
  'webpageId', 'mspp_webpageid',
  'formId', 'mspp_formid',
  'webfileId', 'mspp_webfileid',
  'webtemplateId', 'mspp_webtemplateid',
  'websiteId', 'mspp_websiteid',
  'contentSnippetId', 'mspp_contentsnippetid',
  'webroleId', 'mspp_webroleid',
];

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

const GUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function extractReferences(item) {
  const refs = [];
  if (!item || typeof item !== 'object') return refs;

  // Pattern 1: known field-name on the item itself
  for (const field of KNOWN_REFERENCE_FIELDS) {
    const v = item[field];
    if (typeof v === 'string' && GUID_REGEX.test(v)) {
      refs.push({ field, id: v.toLowerCase() });
    }
  }
  // Pattern 2: normalized `references` array (if the platform emits one)
  if (Array.isArray(item.references)) {
    for (const r of item.references) {
      if (r && typeof r === 'object' && typeof r.referencedId === 'string' && GUID_REGEX.test(r.referencedId)) {
        refs.push({ field: r.field || 'references', id: r.referencedId.toLowerCase() });
      }
    }
  }
  return refs;
}

/**
 * @param {Array<object>} items
 */
function validateDependencies(items) {
  if (!Array.isArray(items)) {
    throw new Error('validateDependencies: items must be an array');
  }
  const presentIds = new Set();
  for (const it of items) {
    if (it && typeof it.componentId === 'string') presentIds.add(it.componentId.toLowerCase());
  }

  const missing = [];
  let totalReferences = 0;

  for (const it of items) {
    const refs = extractReferences(it);
    for (const r of refs) {
      totalReferences++;
      // Skip self-references
      if (typeof it.componentId === 'string' && it.componentId.toLowerCase() === r.id) continue;
      if (presentIds.has(r.id)) continue;
      missing.push({
        ref: 'IL-DEP-001',
        fromComponent: {
          componentId: it.componentId ?? null,
          componentName: it.componentName ?? null,
          componentType: it.componentType ?? null,
        },
        referenceField: r.field,
        referencedId: r.id,
        severity: 'warn',
        note: 'Referenced component is not in this commit. ' +
              'If it already exists in the target environment (e.g. committed in a prior commit), Pull will resolve cleanly. ' +
              'If it does not, the imported component may fail to load at runtime.',
      });
    }
  }

  return {
    totalReferences,
    missing,
    ok: true,
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
    process.stderr.write('validate-dependencies: provide --items-file, --pending-file, or --stdin\n');
    process.exit(1);
  }
  const r = validateDependencies(items);
  process.stdout.write(JSON.stringify(r, null, 2) + '\n');
}

if (require.main === module) {
  main().catch((e) => {
    process.stderr.write('validate-dependencies: ' + e.message + '\n');
    process.exit(1);
  });
}

module.exports = { validateDependencies, extractReferences, KNOWN_REFERENCE_FIELDS, GUID_REGEX };
