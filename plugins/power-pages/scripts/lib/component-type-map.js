#!/usr/bin/env node

// SINGLE SOURCE OF TRUTH for Power Pages component TYPE IDENTITY used across the
// selective-merge flow: normalizing a caller-supplied type (number, numeric
// string, type name, or serialized-name suffix) to its canonical numeric
// `powerpagecomponenttype`, and classifying that type's merge strategy /
// selective-merge eligibility.
//
// WHY THIS EXISTS (A1/A4): inputs.json built with string types ("webtemplate")
// instead of numeric (8) silently fell through to `binaryUnits`, producing an
// empty merge and DROPPING the environment's edits with no warning. And
// `list-conflicts` returns the solution sub-type (10429), not the ppc type, so
// callers were inferring the real type from name suffixes by hand. Both concerns
// are the same "what type is this, really?" question — centralized here so the
// resolver, path-builder, and conflict-enricher all agree.
//
// mergeStrategy:
//   'text'    — a 3-way mergeable text field exists (web page copy, content
//               snippet value, web template source). eligibleForSelectiveMerge.
//   'scalar'  — a single short value; line-merge is meaningless → keep/accept
//               (site setting value).
//   'webfile' — bytes may be text or binary; a runtime content sniff decides the
//               actual merge path (3-way merge for text-detected files, matrix for
//               binary). The type classifier marks it a candidate (eligible);
//               the sniff (other agents) makes the final call.
//   'binary'  — bytes live OUTSIDE the content envelope and there is no text
//               field to merge → keep/accept. Reserved for future non-webfile
//               binary types.
//   'unsupported' — any other ppc type (no selective-merge handling in v1).
//
// CODE-SITE SOURCE FILES (first-class, NOT a powerpagecomponent type 1–35):
//   Power Pages code sites store each source file (`.tsx`/`.ts`/`.css`/`.json`/
//   `.html` …) as a row in the `powerpagessourcefile` table (entity set
//   `powerpagessourcefiles`). The Git-integration conflict `componentId` for these
//   rows equals the `powerpagessourcefileid` PRIMARY KEY (NOT `componentidunique`),
//   the serialized component NAME ends in `.sourcefile`, and the componentPath sits
//   under `/powerpagescodesites/<site>/src/...`. These files are plain text and are
//   fully diffable/mergeable, so they get a DEDICATED sentinel type
//   `SOURCEFILE_TYPE` ('sourcefile') classified as text-mergeable (strategy 'text',
//   eligibleForSelectiveMerge). The sentinel is intentionally a STRING so it can
//   never collide with a numeric ppc type and existing `n === 3 || n === 9`
//   numeric checks stay correct.
//
// Usage (CLI, mainly for debugging):
//   node component-type-map.js --type webtemplate
//   node component-type-map.js --name "Search Results.webtemplate"
//   node component-type-map.js --name "Home.tsx.sourcefile"

'use strict';

const { PPC_TYPE_LABELS } = require('./discover-site-components');

// First-class sentinel for code-site source files. A string (not a number) so it
// can never be mistaken for a numeric powerpagecomponenttype (1–35) and the
// numeric guards elsewhere (`n === 3`, `n === 9`) are unaffected.
const SOURCEFILE_TYPE = 'sourcefile';
const SOURCEFILE_LABEL = 'Code Site Source File';

// A code-site source file is recognized by EITHER its serialized `.sourcefile`
// suffix OR a componentPath under `/powerpagescodesites/<site>/src/...`. The path
// form is what list-conflicts exposes (the suffix lives on the component NAME).
const SOURCEFILE_PATH_RE = /(^|\/)powerpagescodesites\/[^/]+\/src\//i;

// Canonical merge strategy per ppc type. Only the types the selective-merge flow
// reasons about appear here; everything else is 'unsupported'.
const TYPE_MERGE_STRATEGY = Object.freeze({
  2: 'text',    // Web Page        → copy
  7: 'text',    // Content Snippet → value
  8: 'text',    // Web Template    → source
  9: 'scalar',  // Site Setting    → value (short scalar)
  3: 'webfile', // Web File        — text-or-binary decided by a runtime content sniff, not hard-binary
  [SOURCEFILE_TYPE]: 'text', // Code-site source file (powerpagessourcefile) — plain text, 3-way mergeable
});

// Serialized-name / file suffix → numeric type. list-conflicts' componentName is
// the serialized leaf (e.g. "Search Results.webtemplate"); the bound-repo file
// names carry the same suffixes (".webtemplate.source.html", etc.). Keep this in
// sync with map-component-to-git-path's TYPE_LAYOUT suffixes and the broader
// Dataverse Git serialization scheme.
const SUFFIX_TO_TYPE = Object.freeze({
  webpage: 2,
  webfile: 3,
  weblinkset: 4,
  weblink: 5,
  pagetemplate: 6,
  contentsnippet: 7,
  webtemplate: 8,
  sitesetting: 9,
  webrole: 11,
  sitemarker: 13,
  basicform: 15,
  list: 17,
  tablepermission: 18,
  redirect: 30,
  sourcefile: SOURCEFILE_TYPE, // code-site source file → sentinel (not a numeric ppc type)
});

// Build a normalized-name → numeric type map from the authoritative labels
// (e.g. "web page" / "webpage" → 2) plus the suffix tokens (so "webtemplate"
// resolves even though the label is "Web Template").
function normalizeKey(s) {
  return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

const NAME_TO_TYPE = (() => {
  const m = {};
  for (const [num, label] of Object.entries(PPC_TYPE_LABELS)) {
    m[normalizeKey(label)] = Number(num);
  }
  for (const [suffix, num] of Object.entries(SUFFIX_TO_TYPE)) {
    m[normalizeKey(suffix)] = num;
  }
  return Object.freeze(m);
})();

/**
 * Normalize a caller-supplied component type to its canonical numeric
 * `powerpagecomponenttype`. Accepts:
 *   - a number (8) or numeric string ("8")            → returned as-is if a known type
 *   - a type NAME ("Web Template", "webtemplate")     → mapped via labels/suffixes
 *   - a serialized-name suffix or leaf ("Foo.webtemplate", ".webtemplate")
 * Returns the numeric type, or null when it cannot be resolved.
 * @param {number|string|null|undefined} input
 * @returns {number|null}
 */
function normalizeComponentType(input) {
  if (input == null) return null;

  // Numbers / numeric strings.
  if (typeof input === 'number' && Number.isInteger(input)) {
    return PPC_TYPE_LABELS[input] ? input : null;
  }
  const str = String(input).trim();
  if (str === '') return null;
  if (/^\d+$/.test(str)) {
    const n = Number(str);
    return PPC_TYPE_LABELS[n] ? n : null;
  }

  // Exact name/suffix match on the normalized whole string.
  const whole = normalizeKey(str);
  if (NAME_TO_TYPE[whole] != null) return NAME_TO_TYPE[whole];

  // Suffix forms: "Search Results.webtemplate", "Foo.contentsnippet.value.html".
  const fromSuffix = typeFromComponentName(str);
  if (fromSuffix != null) return fromSuffix;

  return null;
}

/**
 * Infer the numeric type from a serialized component NAME / leaf path. The trailing
 * serialized suffix is AUTHORITATIVE — `"Content Snippet Cache.sitesetting"` is a
 * Site Setting (9), not a Content Snippet (7) — so match the final dot-segment
 * first. Only when there is no recognizable trailing suffix (e.g. a folder PATH like
 * `.../web-templates/Foo`) do we fall back to the longest type token appearing
 * anywhere (paths are structured, so this is safe for the path case).
 * @param {string} name e.g. "Search Results.webtemplate" or ".../web-templates/Foo"
 * @returns {number|null}
 */
function typeFromComponentName(name) {
  const s = String(name == null ? '' : name);
  // 1) Anchored: the trailing dot-segment (serialized leaf suffix) wins. This
  //    catches `Home.tsx.sourcefile` → SOURCEFILE_TYPE as well as the ppc suffixes.
  const lastSegKey = normalizeKey(s.split('.').pop());
  if (SUFFIX_TO_TYPE[lastSegKey] != null) return SUFFIX_TO_TYPE[lastSegKey];
  // 2) Code-site source file by PATH: list-conflicts exposes the componentPath
  //    (e.g. /powerpagescodesites/QuickFix/src/pages/Home.tsx) without a
  //    `.sourcefile` suffix — recognize it structurally.
  if (SOURCEFILE_PATH_RE.test(s)) return SOURCEFILE_TYPE;
  // 3) Fallback (paths / no clean suffix): longest type token appearing anywhere.
  const norm = normalizeKey(s);
  if (!norm) return null;
  let best = null;
  let bestLen = -1;
  for (const [suffix, num] of Object.entries(SUFFIX_TO_TYPE)) {
    if (norm.includes(suffix) && suffix.length > bestLen) { best = num; bestLen = suffix.length; }
  }
  return best;
}

/**
 * @param {number|string} type
 * @returns {"text"|"scalar"|"binary"|"unsupported"}
 */
function mergeStrategyForType(type) {
  const n = normalizeComponentType(type);
  if (n == null) return 'unsupported';
  return TYPE_MERGE_STRATEGY[n] || 'unsupported';
}

/**
 * A conflict is eligible for the VS Code 3-way selective merge when it has a
 * mergeable text field (strategy 'text'), is a flat-YML site setting (type 9),
 * or is a web file (type 3) whose content will be sniffed at runtime to decide
 * text-path (3-way merge) vs binary-path (matrix). scalar-only types route to
 * keep/accept when they are not also covered by one of the above cases.
 * @param {number|string} type
 * @returns {boolean}
 */
function isEligibleForSelectiveMerge(type) {
  // Text types (web template/page/snippet) AND flat-YML site settings (type 9). The
  // latter merge the WHOLE .sitesetting.yml so only the `value:` line conflicts — see
  // flat-yml-merge.js. mergeStrategyForType stays 'scalar' (the field is a scalar); the
  // eligibility is broadened here because the merge UNIT is the whole yml, not the field.
  if (mergeStrategyForType(type) === 'text') return true;
  const n = normalizeComponentType(type);
  // Type 9 (flat-yml whole-file merge) and type 3 (web file — runtime sniff decides path).
  return n === 9 || n === 3;
}

/**
 * @param {number|string} type
 * @returns {boolean} true iff the normalized type is a Web File (3).
 */
function isWebFileType(type) {
  return normalizeComponentType(type) === 3;
}

/**
 * @param {number|string} type
 * @returns {string} human label (or "Unknown (<n>)").
 */
function labelForType(type) {
  const n = normalizeComponentType(type);
  if (n === SOURCEFILE_TYPE) return SOURCEFILE_LABEL;
  return (n != null && PPC_TYPE_LABELS[n]) || `Unknown (${type})`;
}

/**
 * @param {number|string} type
 * @returns {boolean} true iff the normalized type is the code-site source-file sentinel.
 */
function isSourceFileType(type) {
  return normalizeComponentType(type) === SOURCEFILE_TYPE;
}

/**
 * Recognize a code-site source file from a conflict row's NAME and/or PATH —
 * the serialized name ends in `.sourcefile` OR the path sits under
 * `/powerpagescodesites/<site>/src/...`. Used by callers that have the raw row
 * (name + path) rather than a resolved type.
 * @param {{ componentName?: string, componentPath?: string, name?: string, path?: string }} row
 * @returns {boolean}
 */
function isSourceFileComponent(row = {}) {
  const name = row.componentName || row.name || '';
  const p = row.componentPath || row.path || '';
  if (typeFromComponentName(name) === SOURCEFILE_TYPE) return true;
  if (p && SOURCEFILE_PATH_RE.test(String(p))) return true;
  return false;
}

function parseArgs(argv) {
  const a = argv.slice(2);
  const o = { type: null, name: null };
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--type' && a[i + 1]) o.type = a[++i];
    else if (a[i] === '--name' && a[i + 1]) o.name = a[++i];
  }
  return o;
}

if (require.main === module) {
  const args = parseArgs(process.argv);
  const input = args.type != null ? args.type : args.name;
  const type = normalizeComponentType(input);
  process.stdout.write(JSON.stringify({
    input,
    type,
    label: type != null ? labelForType(type) : null,
    mergeStrategy: mergeStrategyForType(input),
    eligibleForSelectiveMerge: isEligibleForSelectiveMerge(input),
  }, null, 2) + '\n');
}

// Primary editable text/scalar field per ppc type (the merge unit). Web files (3)
// have no envelope field (bytes live in `filecontent`) → null. Mirrors
// read-component-content's MERGE_FIELDS_BY_TYPE and map-component-to-git-path's
// primaryField; centralized so inputs-builders agree on the field name.
const PRIMARY_FIELD_BY_TYPE = Object.freeze({
  2: 'copy',   // Web Page
  3: null,     // Web File (no envelope field)
  7: 'value',  // Content Snippet
  8: 'source', // Web Template
  9: 'value',  // Site Setting
  [SOURCEFILE_TYPE]: null, // Code-site source file — bytes in powerpagessourcefile.filecontent, no envelope field
});

/**
 * @param {number|string} type
 * @returns {string|null} primary merge field name, or null (binary/no field).
 */
function primaryFieldForType(type) {
  const n = normalizeComponentType(type);
  return n != null && Object.prototype.hasOwnProperty.call(PRIMARY_FIELD_BY_TYPE, n) ? PRIMARY_FIELD_BY_TYPE[n] : null;
}

/**
 * Strip a trailing serialized-type suffix from a component name, e.g.
 * "Search Results.webtemplate" → "Search Results". Leaves names without a known
 * suffix unchanged.
 * @param {string} name
 * @returns {string}
 */
function stripSerializedSuffix(name) {
  const s = String(name == null ? '' : name);
  for (const suffix of Object.keys(SUFFIX_TO_TYPE)) {
    const re = new RegExp(`\\.${suffix}$`, 'i');
    if (re.test(s)) return s.replace(re, '');
  }
  return s;
}

module.exports = {
  normalizeComponentType,
  typeFromComponentName,
  mergeStrategyForType,
  isEligibleForSelectiveMerge,
  isWebFileType,
  isSourceFileType,
  isSourceFileComponent,
  labelForType,
  primaryFieldForType,
  stripSerializedSuffix,
  TYPE_MERGE_STRATEGY,
  SUFFIX_TO_TYPE,
  PRIMARY_FIELD_BY_TYPE,
  SOURCEFILE_TYPE,
  SOURCEFILE_LABEL,
  SOURCEFILE_PATH_RE,
};
