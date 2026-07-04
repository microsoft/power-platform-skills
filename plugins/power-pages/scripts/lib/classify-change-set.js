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
// HEURISTIC (overridable). A change is BUNDLE CHURN when its PATH/NAME matches a
// compiled-asset pattern (hashed filenames, known build-output folders,
// source-map/minified extensions, chunk names) — **regardless of the generic
// `componentType`**. This is the Bug 11 fix: `list-pending-changes` returns
// `componentType: "Site Component"` for nearly everything, so the old gate that
// required a `Web File` componentType meant hashed bundle web files were NEVER flagged
// as churn. We now detect by path/name and keep **fail toward config**: only a clear
// build-output/bundle pattern is churn; anything ambiguous stays config so real config
// is never hidden. Code-site SOURCE files (`/powerpagescodesites/<site>/src/...`,
// `*.sourcefile`) are explicitly protected as config — they are the developer's source,
// never churn, even if they sit under a folder like `src/assets/`.
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

const { isSourceFileComponent } = require('./component-type-map');

// Component-type names (componenttypename) that are web FILES — historically the
// only family that could be compiled-bundle churn. Kept for back-compat (isWebFile).
const WEB_FILE_TYPE_NAMES = Object.freeze(new Set([
  'Web File',
  'WebFile',
  'mspp_webfile',
]));

// Component types that are ELIGIBLE for churn detection. Bug 11: `list-pending-changes`
// returns the GENERIC `"Site Component"` for nearly everything, so we must treat that
// (and the web-file types, and any unknown/absent type) as eligible and decide by
// PATH/NAME. A SPECIFIC config type ("Web Template", "Web Page", "Site Setting",
// "Entity", …) is trusted and is NEVER churn — this is the fail-toward-config guard
// that keeps real config visible even if its path looks hash-y.
const CHURN_ELIGIBLE_TYPE_NAMES = Object.freeze(new Set([
  'Web File',
  'WebFile',
  'mspp_webfile',
  'Site Component',
  'SiteComponent',
]));

function isChurnEligibleType(item) {
  const t = item && (item.componentType || item.componenttypename || item.componenttype);
  if (t == null || t === '') return true; // unknown/absent type → decide by path
  return CHURN_ELIGIBLE_TYPE_NAMES.has(String(t));
}

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

// Strip a trailing serialized component suffix (`.webfile` / `.sourcefile`) so a
// serialized leaf like `index-<hash>.js.webfile` is probed as `index-<hash>.js` and
// the existing hashed-bundle patterns (which anchor on `.js`/`.css` …) still match.
function stripSerializedSuffix(name) {
  return String(name == null ? '' : name).replace(/\.(webfile|sourcefile)$/i, '');
}

// Collect the path/name probes for an item (filePath, componentPath, componentName),
// with the serialized suffix stripped so the churn patterns can anchor correctly.
function churnProbes(item) {
  if (!item) return [];
  const out = [];
  for (const v of [item.filePath, item.componentPath, item.componentName]) {
    if (typeof v === 'string' && v) {
      out.push(v);
      const stripped = stripSerializedSuffix(v);
      if (stripped !== v) out.push(stripped);
    }
  }
  return out;
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
    // Code-site SOURCE files are the developer's source — always config, never churn,
    // even if a path token (e.g. src/assets/) would otherwise match a build-folder
    // pattern. This protects real config from being hidden (fail toward config).
    if (isSourceFileComponent({
      componentName: item && item.componentName,
      componentPath: (item && (item.filePath || item.componentPath)) || '',
    })) {
      configChanges.push(item);
      continue;
    }
    // Bug 11: detect churn by PATH/NAME for churn-ELIGIBLE types — the generic
    // "Site Component" (what list-pending-changes returns for everything), the
    // web-file types, and unknown/absent types. SPECIFIC config types are trusted as
    // config and skip the probe entirely (fail toward config). Any eligible item whose
    // path/name matches a churn pattern → bundle churn.
    if (isChurnEligibleType(item) && churnProbes(item).some((p) => matchesChurn(p, patterns))) {
      bundleChurn.push(item);
      continue;
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
  isChurnEligibleType,
  DEFAULT_CHURN_PATTERNS,
  WEB_FILE_TYPE_NAMES,
  CHURN_ELIGIBLE_TYPE_NAMES,
  PATTERNS_NOTE,
};
