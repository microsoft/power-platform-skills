#!/usr/bin/env node

// Splits a pending-changes set into REAL CONFIG versus COMPILED-BUNDLE CHURN —
// the headline readability feature of the `git-sync` skill.
//
// Power Pages code sites compile to hash-named JS/CSS bundle assets. Every build
// regenerates dozens of web files, so a raw "pending Changes" list is dominated
// by build-output churn rather than meaningful config a developer needs to
// review. This helper separates the two so the summary can show:
//
//   "3 config changes (Header web template, Pricing web page, Account form)
//    + 47 build-output files (bundle churn — collapsed)."
//
// HEURISTIC (overridable). A change is BUNDLE CHURN when it is a web-file
// component whose path/name matches a compiled-asset pattern (hashed filenames,
// known build-output folders, source-map/minified extensions). Everything else
// — web templates, web pages, site settings, schema, forms, lists, etc. — is
// CONFIG. The rule deliberately FAILS TOWARD CONFIG: when in doubt, an item is
// classified as config so it is never hidden from the user.
//
// Input items use the shape returned by list-pending-changes.js:
//   { componentId, componentName, componentType, changeType, action,
//     filePath, partitionId, lastModifiedOn }
//
// Output:
//   {
//     configChanges: [ ...items... ],
//     bundleChurn:   [ ...items... ],
//     summary: {
//       total, configCount, churnCount,
//       configByType: { "<type>": <n>, ... },
//       churnByType:  { "<type>": <n>, ... }
//     }
//   }
//
// Usage (CLI): node classify-change-set.js --items-file <path-to-items-json>
//   (items-json may be the full list-pending-changes output or a bare array)

'use strict';

// Component-type names (componenttypename) that are web FILES — the only family
// that can be compiled-bundle churn. Other component types are always config.
const WEB_FILE_TYPE_NAMES = Object.freeze(new Set([
  'Web File',
  'WebFile',
  'mspp_webfile',
]));

// Path / filename patterns that mark a web file as compiled-bundle churn.
// Order-independent; any match => churn. Kept conservative (fail toward config).
const DEFAULT_CHURN_PATTERNS = Object.freeze([
  /\.[0-9a-f]{8,}\.(js|css|mjs|cjs)$/i,   // hashed bundle: app.4f3a9c12.js
  /-[0-9a-f]{8,}\.(js|css|mjs|cjs)$/i,    // hashed bundle: app-4f3a9c12.css
  /\.(js|css|mjs|cjs)\.map$/i,            // source maps
  /\.min\.(js|css)$/i,                    // minified assets
  /\bchunk[-.][\w]+\.(js|css)$/i,         // chunk-vendors.83f2.js
  /\/(assets|dist|build|static|bundles?)\//i, // build-output folders
]);

const PATTERNS_NOTE = 'fail-toward-config: only web-file components matching a churn pattern are churn';

function isWebFile(item) {
  const t = item && (item.componentType || item.componenttypename || item.componenttype);
  if (typeof t !== 'string') return false;
  return WEB_FILE_TYPE_NAMES.has(t);
}

function matchesChurn(text, patterns) {
  if (typeof text !== 'string' || !text) return false;
  return patterns.some((re) => re.test(text));
}

/**
 * @param {Array<object>} items
 * @param {object} [opts]
 * @param {RegExp[]} [opts.churnPatterns]  Override the default churn patterns.
 * @returns {{ configChanges: object[], bundleChurn: object[], summary: object }}
 */
function classifyChangeSet(items, opts = {}) {
  const list = Array.isArray(items) ? items : [];
  const patterns = Array.isArray(opts.churnPatterns) && opts.churnPatterns.length
    ? opts.churnPatterns
    : DEFAULT_CHURN_PATTERNS;

  const configChanges = [];
  const bundleChurn = [];

  for (const item of list) {
    // Only web files can be churn; everything else is config (fail toward config).
    if (isWebFile(item)) {
      const probe = item.filePath || item.componentName || item.componentPath || '';
      if (matchesChurn(probe, patterns)) {
        bundleChurn.push(item);
        continue;
      }
    }
    configChanges.push(item);
  }

  const byType = (arr) => arr.reduce((acc, it) => {
    const t = (it && (it.componentType || it.componenttypename)) || 'Unknown';
    acc[t] = (acc[t] || 0) + 1;
    return acc;
  }, {});

  return {
    configChanges,
    bundleChurn,
    summary: {
      total: list.length,
      configCount: configChanges.length,
      churnCount: bundleChurn.length,
      configByType: byType(configChanges),
      churnByType: byType(bundleChurn),
    },
  };
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = { itemsFile: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--items-file' && args[i + 1]) out.itemsFile = args[++i];
  }
  return out;
}

if (require.main === module) {
  const fs = require('fs');
  const { itemsFile } = parseArgs(process.argv);
  if (!itemsFile) {
    process.stderr.write('classify-change-set: --items-file <path> is required.\n');
    process.exit(1);
  }
  let raw;
  try { raw = JSON.parse(fs.readFileSync(itemsFile, 'utf8')); }
  catch (e) { process.stderr.write('classify-change-set: cannot read items file: ' + e.message + '\n'); process.exit(1); }
  const items = Array.isArray(raw) ? raw : (Array.isArray(raw.items) ? raw.items : []);
  const result = classifyChangeSet(items);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

module.exports = {
  classifyChangeSet,
  isWebFile,
  DEFAULT_CHURN_PATTERNS,
  WEB_FILE_TYPE_NAMES,
  PATTERNS_NOTE,
};
