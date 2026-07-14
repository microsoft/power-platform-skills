#!/usr/bin/env node

/* eslint-disable no-console */
/**
 * adapt-app-brief-for-mobile-plugin.js
 *
 * Converts an app-brief.json (from extract-msapp-brief.v2.cjs) plus per-screen
 * brief JSON files into plugin-ready, full-fidelity artifacts for this
 * repo's mobile-app plugin.
 *
 * The generated native-app-plan.md is in the format the /create-mobile-app
 * planner uses as a "resume-from-draft" baseline. Each screen has its own
 * detailed file under screens/<Name>.plan.md (and .controls.md when the
 * full detail exceeds the line cap). The screen-builder agent reads these
 * directly during /create-mobile-app's screen-build pass.
 *
 * Outputs (default out-dir = <input-dir>/mobile-plugin-input/):
 *   native-app-plan.md              ← master plan, 8 planner sections
 *   mobile-plugin-input.json        ← full machine-readable payload
 *   requirements-brief.md           ← copy/paste summary
 *   migration-checklist.md          ← execution checklist
 *   components.md                   ← reused custom component catalog
 *   state/app-state.md              ← state scope report for `var_*` and `col_*` (writers, readers, placement)
 *   control-intent-coverage.json    ← Canvas control intent + must-preserve behavior/data/layout contract
 *   screens/<Name>.plan.md          ← per-screen full spec (summary + tree)
 *   screens/<Name>.controls.md      ← (only when .plan.md would exceed cap)
 *
 * Usage:
 *   node scripts/adapt-app-brief-for-mobile-plugin.js \
 *     --input <path/to/app-brief.json> \
 *     [--out-dir <dir>] \
 *     [--screens-dir <dir>] \
 *     [--split-threshold <lines>]   # default 1500
 *
 * Decisions locked (from PR discussion):
 *   1. Full extraction: every control, every event, every non-default property.
 *   2. Dataverse is always recorded as a required backend, even when source
 *      detected 0 connectors.
 *   3. Power Fx formulas printed verbatim in ```pfx fenced blocks.
 *   4. Cosmetic controls (Label/Rectangle/Icon/HtmlViewer with no events &
 *      no Items binding) appear in the control tree as a one-liner only.
 *   5. Per-screen file split at >1500 lines: .plan.md (summary + tree +
 *      interactive controls) plus .controls.md (deep dump of every control).
 *   6. Component reuse catalog written separately.
 *   7. Round-trip check: every control in source JSON appears in the output
 *      (count match). Run-summary fails the script if any are dropped.
 *   8. Intent over control: Canvas controls are evidence of maker intent,
 *      not a binding output spec. Detected anti-patterns (HtmlViewer, pixel
 *      X/Y, stacked-Labels-as-list, PDFViewer, RichTextEditor) emit a
 *      `## Upgrade Hints` block per screen + `### Canvas Anti-Patterns
 *      Detected` in the master plan + `upgradeHints[]` on each
 *      `screenPlan.screens[]` entry in mobile-plugin-input.json. The
 *      screen-builder MUST upgrade to the recommended native primitive
 *      (see shared/references/canvas-to-native-mapping.md).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  buildArtifactNameMap,
  isWindowsReservedBasename,
  pathContains,
} = require('./lib/modernizer-paths.js');
const MAX_INPUT_JSON_BYTES = 64 * 1024 * 1024;
const DETERMINISTIC_EPOCH = '1970-01-01T00:00:00.000Z';
let GENERATION_TIMESTAMP = DETERMINISTIC_EPOCH;

// ---------- CLI ----------

function usage(msg) {
  if (msg) console.error('Error: ' + msg);
  const print = msg ? console.error : console.log;
  print(
    'Usage: node scripts/adapt-app-brief-for-mobile-plugin.js ' +
      '--input <app-brief.json> [--out-dir <dir>] [--screens-dir <dir>] ' +
      '[--split-threshold <lines>] [--full-schema]'
  );
  process.exit(msg ? 1 : 0);
}

function parseArgs(argv) {
  const args = {
    input: null,
    outDir: null,
    screensDir: null,
    splitThreshold: 1500,
    selfTest: false,
    fullSchema: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--input' || a === '-i') args.input = argv[++i];
    else if (a === '--out-dir' || a === '-o') args.outDir = argv[++i];
    else if (a === '--screens-dir' || a === '-s') args.screensDir = argv[++i];
    else if (a === '--split-threshold') args.splitThreshold = Number(argv[++i]) || 1500;
    else if (a === '--self-test') args.selfTest = true;
    else if (a === '--full-schema') args.fullSchema = true;
    else if (a === '--help' || a === '-h') usage();
    else usage('Unknown argument: ' + a);
  }
  if (args.selfTest) return args;
  if (!args.input) usage('Missing --input');
  args.input = path.resolve(args.input);
  if (!fs.existsSync(args.input)) usage('Input file not found: ' + args.input);
  if (fs.lstatSync(args.input).isSymbolicLink() || !fs.lstatSync(args.input).isFile()) usage('Input must be a regular JSON file: ' + args.input);
  args.input = fs.realpathSync(args.input);
  args.outDir = args.outDir
    ? path.resolve(args.outDir)
    : path.resolve(path.dirname(args.input), 'mobile-plugin-input');
  args.screensDir = args.screensDir
    ? path.resolve(args.screensDir)
    : path.resolve(path.dirname(args.input), 'screens');
  const outContainsInput = pathContains(args.outDir, args.input);
  const outContainsScreens = pathContains(args.outDir, args.screensDir);
  const screensContainOut = pathContains(args.screensDir, args.outDir);
  if (outContainsInput || outContainsScreens || screensContainOut) usage('Output, input, and screens directories must not overlap');
  return args;
}

// ---------- IO helpers ----------

function readJson(filePath) {
  try {
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('input must be a regular file, not a symlink/directory');
    if (stat.size > MAX_INPUT_JSON_BYTES) throw new Error(`input exceeds ${MAX_INPUT_JSON_BYTES} bytes`);
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    console.error('Failed to parse JSON: ' + filePath);
    console.error(err.message);
    process.exit(2);
  }
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function prepareOutputDir(dir) {
  const marker = path.join(dir, '.mobile-app-modernizer-output');
  const markerText = 'Generated by adapt-app-brief-for-mobile-plugin.js. Safe to replace on rerun.\n';
  if (fs.existsSync(dir)) {
    const dirStat = fs.lstatSync(dir);
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) throw new Error('Output path must be a real directory: ' + dir);
    const entries = fs.readdirSync(dir);
    const ownsOutput = fs.existsSync(marker) && !fs.lstatSync(marker).isSymbolicLink() && fs.lstatSync(marker).isFile() && fs.readFileSync(marker, 'utf8') === markerText;
    if (entries.length > 0 && !ownsOutput) {
      throw new Error('Refusing to overwrite non-generated output directory: ' + dir);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(marker, markerText, 'utf8');
}

function writeFile(filePath, content) {
  ensureDir(path.dirname(filePath));
  let output = content;
  if (/\.md$/i.test(filePath)) {
    output = String(content)
      .replace(/\r\n?/g, '\n')
      .replace(/\n*$/, '\n');
  }
  fs.writeFileSync(filePath, output, 'utf8');
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function behaviorId(group, value) {
  const identity = [
    group,
    value.screen,
    value.controlPath || value.control,
    value.event || value.property,
    value.actionIndex,
    value.intent || value.kind,
    value.sourceStatement || value.formula,
  ];
  return `b-${crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0, 16)}`;
}

function shortName(fullPath, fallback) {
  if (!fullPath) return fallback || '';
  const parts = String(fullPath).split('/');
  return parts[parts.length - 1] || fallback || '';
}

// ---------- Control classification ----------

// Controls that always get a full per-control subsection (they have logic
// or data binding regardless of whether `events` is populated).
const INTERACTIVE_KINDS = new Set([
  'BarcodeReader',
  'Button',
  'CheckBox',
  'ComboBox',
  'DatePicker',
  'DropDown',
  'Form',
  'Gallery',
  'PDFViewer',
  'TextInput',
  'Toggle',
  'TypedDataCard',
]);

// Cosmetic kinds only get a full subsection if they have an event handler.
const COSMETIC_KINDS = new Set([
  'GroupContainer',
  'Label',
  'Rectangle',
  'Icon',
  'Image',
  'HtmlViewer',
]);

// Property names worth surfacing in the "non-default properties" block.
// Layout-only / boilerplate props are suppressed.
const SUPPRESSED_PROPS = new Set([
  'Height',
  'Width',
  'X',
  'Y',
  'PaddingTop',
  'PaddingBottom',
  'PaddingLeft',
  'PaddingRight',
  'LayoutAlignItems',
  'LayoutDirection',
  'LayoutJustifyContent',
  'BorderColor',
  'BorderThickness',
  'FocusedBorderThickness',
]);

const EVENT_NAMES = [
  'OnSelect',
  'OnChange',
  'OnVisible',
  'OnHidden',
  'OnReset',
  'OnCheck',
  'OnUncheck',
  'OnSuccess',
  'OnFailure',
  'OnSave',
  'OnNew',
  'OnEdit',
  'OnView',
  'OnCancel',
  'OnAddFile',
  'OnRemoveFile',
  'OnTimerEnd',
  'OnTimerStart',
  'OnScan',
  'OnSearch',
  'OnLoad',
  'OnError',
  'OnStart',
];

function isEventPropertyName(name) {
  return EVENT_NAMES.includes(name) || /^On[A-Z]/.test(String(name || ''));
}

function eventNamesFrom(events, props) {
  return unique([
    ...EVENT_NAMES,
    ...Object.keys(events || {}).filter(isEventPropertyName),
    ...Object.keys(props || {}).filter(isEventPropertyName),
  ]);
}

function isComponentInstance(c) {
  return c && c.isComponentInstance === true;
}

function hasAnyEvent(c) {
  const events = (c && c.events) || {};
  const props = (c && c.properties) || {};
  return eventNamesFrom(events, props).some((k) => {
    if (Array.isArray(events[k]) && events[k].length > 0) return true;
    return typeof props[k] === 'string' && stripLeadingEq(props[k]).trim() !== '';
  });
}

function isInteractive(c) {
  if (!c) return false;
  if (isComponentInstance(c)) return true; // custom components count as interactive
  if (INTERACTIVE_KINDS.has(c.kind)) return true;
  if (hasAnyEvent(c)) return true;
  const items = c.properties && c.properties.Items;
  if (items && String(items).trim() !== '=' && String(items).trim() !== '') return true;
  return false;
}

function indentDepth(controlPath, screenName) {
  if (!controlPath) return 0;
  const segments = String(controlPath).split('/');
  // first segment is screen name; depth = segments past the screen
  if (segments[0] === screenName) return Math.max(segments.length - 2, 0);
  return Math.max(segments.length - 1, 0);
}

// ---------- Power Fx formula helpers ----------

function stripLeadingEq(s) {
  if (s == null) return '';
  return String(s).replace(/^=/, '');
}

function splitTopLevelStatements(text) {
  const source = String(text || '');
  const parts = [];
  let current = '';
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    current += ch;
    if (inSingle) {
      if (ch === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (ch === '"') inDouble = false;
      continue;
    }
    if (ch === "'") { inSingle = true; continue; }
    if (ch === '"') { inDouble = true; continue; }
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    if (ch === ')' || ch === ']' || ch === '}') depth = Math.max(0, depth - 1);
    if (ch === ';' && depth === 0) {
      parts.push(current.slice(0, -1).trim());
      current = '';
    }
  }
  const tail = current.trim();
  if (tail) parts.push(tail);
  return parts.filter(Boolean);
}

function sourceStatementsForFormula(formula) {
  const stripped = stripLeadingEq(formula).trim();
  if (!stripped) return [];
  const statements = splitTopLevelStatements(stripped);
  return statements.length > 0 ? statements : [stripped];
}

function normalizePfxText(value) {
  return stripLeadingEq(value).replace(/\r\n?/g, '\n');
}

function fencedBlock(value, language = '', indent = '') {
  const text = String(value ?? '').replace(/\r\n?/g, '\n');
  const longestRun = Math.max(0, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = '`'.repeat(Math.max(3, longestRun + 1));
  return [
    `${indent}${fence}${language}`,
    ...text.split('\n').map((line) => line === '' ? '' : `${indent}${line}`),
    `${indent}${fence}`,
  ];
}

function pfxBlock(value, indent = '') {
  // Semantically verbatim Power Fx inside a fenced block. Source formulas can
  // legitimately contain backticks in text literals, so choose a fence longer
  // than every source run; imported content must never terminate its data block.
  return fencedBlock(normalizePfxText(value), 'pfx', indent);
}

function markdownCode(value, forTable = false) {
  let text = String(value ?? '').replace(/[\r\n\t]+/g, ' ');
  if (forTable) text = text.replace(/\|/g, '\\|');
  const longestRun = Math.max(0, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = '`'.repeat(Math.max(1, longestRun + 1));
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${text}${pad}${fence}`;
}

function markdownTableText(value) {
  return String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\|/g, '\\|');
}

// ---------- Aggregation across the whole brief ----------

function collectConnectorNames(brief) {
  const names = [];
  for (const c of toArray(brief.dataModel && brief.dataModel.connectors)) names.push(c && c.name);
  for (const c of toArray(brief.dataModel && brief.dataModel.connectorInventory)) names.push(c && c.name);
  for (const c of toArray(brief.dataModel && brief.dataModel.connections)) names.push(c && (c.displayName || c.name));
  for (const s of toArray(brief.screens)) {
    for (const c of toArray(s && s.connectorsUsed)) names.push(c && c.name);
  }
  return unique(names).sort((a, b) => a.localeCompare(b));
}

// Reduce a table sidecar attribute list to the "used slice" for the model feed:
// columns the app reads/writes (matched by logical OR display name) + primary
// id/name + every Lookup whose target is another emitted table (preserves the
// topological-sort dependency edges in collectTables). Full schema is re-fetched
// live from Dataverse by the plugin, so dropped columns are not lost. Pass
// --full-schema to emit every column.
function sliceAttributesToUsed(attrs, columnsUsed, emittedLogicals, formFieldNames) {
  const used = new Set();
  for (const c of toArray(columnsUsed)) {
    if (c && c.name) used.add(String(c.name).trim().toLowerCase());
  }
  for (const name of toArray(formFieldNames)) {
    if (name) used.add(String(name).trim().toLowerCase());
  }
  return toArray(attrs).filter((a) => {
    if (!a) return false;
    if (a.isPrimaryId || a.isPrimaryName) return true;
    const ln = a.logicalName ? a.logicalName.toLowerCase() : '';
    const dn = a.displayName ? a.displayName.toLowerCase() : '';
    if ((ln && used.has(ln)) || (dn && used.has(dn))) return true;
    const targets =
      (a.lookup && Array.isArray(a.lookup.targets) && a.lookup.targets) ||
      (Array.isArray(a.targets) && a.targets) ||
      [];
    return targets.some((x) => emittedLogicals.has(x));
  });
}

function collectFormFieldNamesByTable(brief) {
  const byTable = new Map();
  for (const form of toArray(brief && brief.forms)) {
    if (!form || !form.table) continue;
    const names = byTable.get(form.table) || new Set();
    for (const field of toArray(form.fields)) {
      if (field && field.dataField) names.add(field.dataField);
    }
    byTable.set(form.table, names);
  }
  return byTable;
}

function collectTables(brief, tablesDir, fullSchema) {
  const rawTables = toArray(brief.dataModel && brief.dataModel.dataverseTables);
  for (const table of rawTables) {
    if (table && table.logicalName && !/^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(table.logicalName)) {
      throw new Error(`Unsafe Dataverse logical name in app brief: ${table.logicalName}`);
    }
  }
  const formFieldNamesByTable = collectFormFieldNamesByTable(brief);
  // Set of all tables the app emits sidecars for — used to keep cross-table
  // Lookup columns (needed for the topological dependency sort below) even
  // when the app never reads/writes them.
  const emittedLogicals = new Set(
    rawTables.filter((t) => t && t.logicalName).map((t) => t.logicalName)
  );

  // Step 1: load per-table sidecars (full attribute / option-set metadata).
  // The sidecar dir is written by extract-msapp-brief.v2.cjs next to app-brief.json
  // (`tables/<logicalName>.json`). Missing dir or missing file is non-fatal
  // — that table simply emits an empty `columns[]` and `status: 'new'`.
  const sidecarByLogical = new Map();
  if (tablesDir && fs.existsSync(tablesDir)) {
    const tableDirStat = fs.lstatSync(tablesDir);
    if (tableDirStat.isSymbolicLink() || !tableDirStat.isDirectory()) throw new Error(`tables sidecar path must be a real directory: ${tablesDir}`);
    for (const t of rawTables) {
      if (!t || !t.logicalName) continue;
      const file = path.join(tablesDir, `${t.logicalName}.json`);
      if (!fs.existsSync(file)) continue;
      sidecarByLogical.set(t.logicalName, readJson(file));
    }
  }

  // Step 2: build the contract-shape table records (columns / status).
  const mapped = rawTables
    .filter((t) => t && t.logicalName)
    .map((t) => {
      const sidecar = sidecarByLogical.get(t.logicalName);
      const summary = (t && t.schemaSummary) || {};
      // Each attribute carries its own option set inline at
      // `attr.optionSet.options[]`, so `toColumn` reads it directly — no
      // per-table lookup index needed.
      // Slice to the columns the app actually uses (app-wide union) + primary
      // keys + cross-table Lookups, UNLESS --full-schema. The brief ships the
      // complete schema; this is where the lean *model feed* is shaped. Full
      // schema is re-fetched live from Dataverse by the plugin at build time.
      const allAttrs = toArray(sidecar && sidecar.attributes);
      const rawFormFieldNames = [...(formFieldNamesByTable.get(t.logicalName) || [])];
      const formFieldNames = [...rawFormFieldNames];
      const nameMapping = (sidecar && sidecar.columnDisplayNameMapping) || {};
      for (const fieldName of rawFormFieldNames) {
        if (nameMapping[fieldName]) formFieldNames.push(nameMapping[fieldName]);
      }
      const slicedAttrs = fullSchema
        ? allAttrs
        : sliceAttributesToUsed(
            allAttrs,
            t.columnsUsed,
            emittedLogicals,
            formFieldNames
          );
      const columns = slicedAttrs.map((a) => toColumn(a));
      const status = sidecar && sidecar.primaryIdAttribute ? 'reuse' : 'new';
      return {
        logicalName: t.logicalName,
        displayName: t.displayName || t.logicalName,
        entitySetName:
          t.entitySetName ||
          (sidecar && sidecar.entitySetName) ||
          null,
        primaryIdAttribute:
          summary.primaryIdAttribute ||
          (sidecar && sidecar.primaryIdAttribute) ||
          null,
        primaryNameAttribute:
          summary.primaryNameAttribute ||
          (sidecar && sidecar.primaryNameAttribute) ||
          null,
        status,
        // `tier` filled in step 3 (topological sort across the full set).
        tier: null,
        ownershipType:
          summary.ownershipType || (sidecar && sidecar.ownershipType) || null,
        isCustomEntity:
          summary.isCustomEntity != null
            ? summary.isCustomEntity
            : sidecar && sidecar.isCustomEntity != null
              ? sidecar.isCustomEntity
              : null,
        isActivity:
          summary.isActivity != null
            ? summary.isActivity
            : sidecar && sidecar.isActivity != null
              ? sidecar.isActivity
              : null,
        isOfflineInMobileClient:
          summary.isOfflineInMobileClient != null
            ? summary.isOfflineInMobileClient
            : sidecar && sidecar.isOfflineInMobileClient != null
              ? sidecar.isOfflineInMobileClient
              : null,
        privileges: summary.privileges || (sidecar && sidecar.privileges) || null,
        operations: toArray(t.operations),
        screens: toArray(t.screens),
        columnsUsed: toArray(t.columnsUsed),
        // Saved views surfaced by og-script update. Shape: [{name, displayName}].
        // Carried through to the plan + JSON so screen-builder can map source
        // view-bound galleries onto generated `useViewQuery` hooks.
        views: toArray(t.views)
          .map((v) => ({
            name: (v && v.name) || null,
            displayName: (v && v.displayName) || null,
          }))
          .filter((v) => v.name || v.displayName),
        columns,
        columnDisplayNameMapping: nameMapping,
        schemaSummary: t.schemaSummary || null,
        briefPath: t.briefPath || null,
      };
    })
    .sort((a, b) => a.logicalName.localeCompare(b.logicalName));

  // Step 3: derive `tier` via Kahn-style topological sort over Lookup column
  // `targets[]`. Tier 1 = no FK dependencies on any *other* table in this
  // set. Tier 2 = depends only on tier-1 tables. Etc. Self-references and
  // cycles fall back to tier `n+1` so the plugin never sees `null` here.
  const setOfLogicals = new Set(mapped.map((t) => t.logicalName));
  const depsByLogical = new Map();
  for (const t of mapped) {
    const deps = new Set();
    for (const col of t.columns) {
      if (col.type !== 'lookup') continue;
      for (const target of toArray(col.targets)) {
        if (target && target !== t.logicalName && setOfLogicals.has(target)) {
          deps.add(target);
        }
      }
    }
    depsByLogical.set(t.logicalName, deps);
  }
  const tierByLogical = new Map();
  let currentTier = 1;
  let remaining = new Set(mapped.map((t) => t.logicalName));
  while (remaining.size > 0) {
    const ready = [...remaining].filter((name) => {
      const deps = depsByLogical.get(name) || new Set();
      return [...deps].every((d) => tierByLogical.has(d));
    });
    if (ready.length === 0) {
      // Cycle (or undeclared dep). Drop everything left into the next tier
      // so the plugin can still process them in a deterministic order.
      for (const name of remaining) tierByLogical.set(name, currentTier);
      break;
    }
    for (const name of ready) {
      tierByLogical.set(name, currentTier);
      remaining.delete(name);
    }
    currentTier += 1;
  }
  for (const t of mapped) {
    t.tier = tierByLogical.get(t.logicalName) || 1;
  }
  return mapped;
}

// Map a single Dataverse attribute (from the per-table sidecar) onto the
// `columns[]` shape consumed by the mobile-plugin contract. Centralizes the
// `attributeType` → contract-type vocabulary, lookup-target propagation, and
// option-set materialization so callers stay declarative.
function toColumn(attr) {
  const t = (attr && attr.attributeType) || 'Unknown';
  const out = {
    name: attr.logicalName,
    schemaName: attr.schemaName || null,
    displayName: attr.displayName || attr.logicalName,
    type: DATAVERSE_TYPE_TO_CONTRACT[t] || t.toLowerCase(),
    isPrimaryId: !!attr.isPrimaryId,
    isPrimaryName: !!attr.isPrimaryName,
    isLogical: !!attr.isLogical,
    isCustom: !!attr.isCustom,
    required: !!attr.isRequired,
    readOnly: !!attr.isReadOnly,
    validForCreate: attr.isValidForCreate !== false,
    validForUpdate: attr.isValidForUpdate !== false,
  };
  if (attr.requiredLevel) out.requiredLevel = attr.requiredLevel;
  if (attr.writeMode) out.writeMode = attr.writeMode;
  if (attr.formula) {
    out.hasServerFormula = true;
    out.formula = attr.formula;
  }
  if (attr.maxLength != null) out.maxLength = attr.maxLength;
  if (attr.maxSizeInKB != null) out.maxSizeInKB = attr.maxSizeInKB;
  if (attr.maxHeight != null) out.maxHeight = attr.maxHeight;
  if (attr.maxWidth != null) out.maxWidth = attr.maxWidth;
  if (attr.canStoreFullImage != null) out.canStoreFullImage = !!attr.canStoreFullImage;
  if (attr.isPrimaryImage != null) out.isPrimaryImage = !!attr.isPrimaryImage;
  if (attr.format) out.format = attr.format;
  if (attr.description) out.description = attr.description;
  // Lookups: carry the parent-table logical names so screen-builder can
  // generate `useLookupOptions(target)` calls. L1 sidecars expose the target
  // list either as `lookup.targets[]` or directly on the attribute root.
  if (out.type === 'lookup') {
    const targets =
      (attr.lookup && Array.isArray(attr.lookup.targets) && attr.lookup.targets) ||
      (Array.isArray(attr.targets) && attr.targets) ||
      null;
    if (targets) out.targets = targets.slice();
  }
  // Picklist / Multi-select picklist / Status / State: L1 attaches the live
  // option list inline at `attr.optionSet.options[{value, label}]`, so just
  // pass it through. The top-level `optionSets[]` on the sidecar is a dedupe
  // index and is not joined here.
  if (
    out.type === 'picklist' ||
    out.type === 'multipicklist' ||
    out.type === 'status' ||
    out.type === 'state'
  ) {
    const os = attr.optionSet;
    if (os && Array.isArray(os.options)) {
      out.options = os.options.map((o) => ({
        value: Number.isFinite(Number(o.value)) ? Number(o.value) : o.value,
        label: o.label,
      }));
      if (os.isGlobal) out.optionSetIsGlobal = true;
      if (os.name) out.optionSetName = os.name;
    }
  }
  return out;
}

function classifyServerSideColumn(col) {
  if (!col) return null;
  // File and Image columns use dedicated upload/update paths. They are not
  // computed columns and must remain writable through host/native pickers.
  if (col.type === 'file' || col.type === 'image') return null;
  const formula = col.formula ? String(col.formula) : '';
  const lower = formula.toLowerCase();
  const name = String(col.name || '').toLowerCase();
  if (formula) {
    if (lower.includes('rolluprulestep') || lower.includes('aggregate') || lower.includes('evaluateexpression')) return 'rollupColumn';
    return 'calculatedColumn';
  }
  if (col.readOnly || col.validForCreate === false || col.validForUpdate === false) {
    if (col.type === 'virtual' || name.endsWith('name') || name.endsWith('_base')) return 'serverComputedColumn';
    return 'serverManagedColumn';
  }
  return null;
}

function riskForServerSideAsset(assetType, tableOps) {
  const hasWrites = toArray(tableOps).some((op) => ['create', 'update', 'delete', 'patch', 'remove', 'removeIf', 'updateIf'].includes(String(op).toLowerCase()));
  if (assetType === 'rollupColumn' || assetType === 'calculatedColumn') return hasWrites ? 'high' : 'medium';
  if (assetType === 'serverManagedColumn') return hasWrites ? 'medium' : 'low';
  return 'low';
}

function buildServerSideAssets(tables) {
  const assets = [];
  const byTable = {};
  const stats = {
    total: 0,
    tables: 0,
    calculatedColumns: 0,
    rollupColumns: 0,
    serverManagedColumns: 0,
    serverComputedColumns: 0,
    writeImpactedTables: 0,
  };
  const writeTables = new Set();

  for (const table of toArray(tables)) {
    if (!table || !table.logicalName) continue;
    const tableAssets = [];
    const operations = toArray(table.operations);
    const hasWrites = operations.some((op) => ['create', 'update', 'delete', 'patch', 'remove', 'removeIf', 'updateIf'].includes(String(op).toLowerCase()));
    if (hasWrites) writeTables.add(table.logicalName);
    for (const col of toArray(table.columns)) {
      if (!col || !col.name) continue;
      const assetType = classifyServerSideColumn(col);
      if (!assetType) continue;
      const asset = {
        table: table.logicalName,
        tableDisplayName: table.displayName || table.logicalName,
        assetType,
        name: col.name,
        displayName: col.displayName || col.name,
        columnType: col.type || null,
        operation: hasWrites ? 'read/create/update' : 'read',
        source: col.formula ? 'dataverse-column-formula' : 'dataverse-column-metadata',
        mobileAction: assetType === 'rollupColumn' || assetType === 'calculatedColumn'
          ? 'preserveInDataverse; readOnlyInApp; doNotRecomputeClientSide'
          : 'excludeFromCreateUpdatePayload',
        risk: riskForServerSideAsset(assetType, operations),
        validForCreate: col.validForCreate !== false,
        validForUpdate: col.validForUpdate !== false,
        readOnly: !!col.readOnly,
      };
      if (col.formula) asset.formula = col.formula;
      tableAssets.push(asset);
      assets.push(asset);
      stats.total += 1;
      if (assetType === 'calculatedColumn') stats.calculatedColumns += 1;
      else if (assetType === 'rollupColumn') stats.rollupColumns += 1;
      else if (assetType === 'serverComputedColumn') stats.serverComputedColumns += 1;
      else stats.serverManagedColumns += 1;
    }
    if (tableAssets.length > 0) byTable[table.logicalName] = tableAssets;
  }

  stats.tables = Object.keys(byTable).length;
  stats.writeImpactedTables = [...writeTables].filter((name) => byTable[name]).length;
  const manualVerification = toArray(tables)
    .filter((table) => table && table.logicalName)
    .map((table) => {
      const operations = toArray(table.operations);
      const hasWrites = operations.some((op) => ['create', 'update', 'delete', 'patch', 'remove', 'removeIf', 'updateIf'].includes(String(op).toLowerCase()));
      return {
        table: table.logicalName,
        displayName: table.displayName || table.logicalName,
        operations,
        requiredWhen: hasWrites ? 'before-production-write-path' : 'before-production-readonly-launch',
        verify: [
          'business rules active in target environment',
          'plug-ins/custom APIs/actions deployed when source solution depends on them',
          'classic workflows/cloud flows present and active when referenced',
          'calculated/rollup columns preserved server-side, not reimplemented ad hoc in screen code',
        ],
      };
    });
  return {
    $schema: 'server-side-assets-v1',
    generatedAt: GENERATION_TIMESTAMP,
    stats,
    assets,
    byTable,
    manualVerification,
  };
}

function sanitizeTablesForPluginInput(tables) {
  return toArray(tables).map((table) => ({
    ...table,
    columns: toArray(table.columns).map((col) => {
      const copy = { ...col };
      if (copy.formula) {
        delete copy.formula;
        copy.serverFormulaSource = 'server-side-assets.json';
      }
      return copy;
    }),
  }));
}

function buildServerSideAssetsSectionLines(serverSideAssets) {
  const lines = [];
  if (!serverSideAssets || !serverSideAssets.stats || serverSideAssets.stats.total === 0) return lines;
  const stats = serverSideAssets.stats;
  lines.push('### Server-Side Dataverse Assets');
  lines.push('');
  lines.push('These are Dataverse-side behaviors/columns that the mobile app must preserve by reading from Dataverse or excluding from write payloads. Do **not** silently reimplement them in screen code. Full details live in [`server-side-assets.json`](server-side-assets.json).');
  lines.push('');
  lines.push('| Kind | Count | Mobile rule |');
  lines.push('|---|---|---|');
  if (stats.rollupColumns) lines.push(`| Rollup columns | ${stats.rollupColumns} | Read from Dataverse; preserve server-side; never client-fetch all children to recompute. |`);
  if (stats.calculatedColumns) lines.push(`| Calculated columns | ${stats.calculatedColumns} | Read from Dataverse; preserve formula server-side; never include in create/update payloads. |`);
  if (stats.serverComputedColumns) lines.push(`| Server-computed/virtual columns | ${stats.serverComputedColumns} | Display only via generated reads/formatted helpers; never write. |`);
  if (stats.serverManagedColumns) lines.push(`| Server-managed/write-restricted columns | ${stats.serverManagedColumns} | Exclude from create/update payloads; use narrow write DTOs. |`);
  lines.push('');
  const highRisk = toArray(serverSideAssets.assets).filter((asset) => asset.risk === 'high').slice(0, 12);
  if (highRisk.length > 0) {
    lines.push('### High-risk examples');
    lines.push('');
    lines.push('| Table | Column | Type | Action |');
    lines.push('|---|---|---|---|');
    for (const asset of highRisk) {
      lines.push(`| \`${asset.table}\` | \`${asset.name}\` | ${asset.assetType} | ${asset.mobileAction} |`);
    }
    lines.push('');
  }
  lines.push('### Manual verification');
  lines.push('- Before production writes, confirm business rules, plug-ins/custom APIs/actions, classic workflows, and cloud flows from the source solution are present and active in the target environment. The adapter inventories column-level server behavior; it does not reconstruct server plug-in/workflow code.');
  lines.push('- Generated screen code must treat `server-side-assets.json` as a write guard: exclude listed computed/managed columns and prefer Dataverse rollup/calculated columns for business totals.');
  lines.push('');
  return lines;
}

// Dataverse `AttributeType` → mobile-plugin contract column type vocabulary
// (defined in mobile-plugin-handoff-contract.md §5). Anything not in this
// table falls back to the lowercased Dataverse name so unknown types still
// round-trip rather than silently disappearing.
const DATAVERSE_TYPE_TO_CONTRACT = {
  String: 'string',
  Memo: 'memo',
  Integer: 'integer',
  BigInt: 'biginteger',
  Decimal: 'decimal',
  Double: 'double',
  Money: 'money',
  Boolean: 'boolean',
  DateTime: 'datetime',
  Picklist: 'picklist',
  MultiSelectPicklist: 'multipicklist',
  Status: 'status',
  State: 'state',
  Lookup: 'lookup',
  Customer: 'customer',
  Owner: 'owner',
  Image: 'image',
  File: 'file',
  Uniqueidentifier: 'uniqueidentifier',
  Virtual: 'virtual',
  EntityName: 'entityname',
  PartyList: 'partylist',
  CalendarRules: 'calendarrules',
  ManagedProperty: 'managedproperty',
};

function nativeArchetype(layoutKind) {
  const kind = String(layoutKind || '').toLowerCase();
  if (kind.includes('list') || kind.includes('search') || kind.includes('gallery')) return 'List';
  if (kind.includes('detail')) return 'Detail';
  if (kind.includes('form') || kind.includes('wizard')) return 'Form';
  if (kind.includes('calendar')) return 'Tab-root';
  return 'Tab-root';
}

function operationalPattern(archetype) {
  if (archetype === 'List') return 'filterable-list';
  if (archetype === 'Detail') return 'detail-summary';
  if (archetype === 'Form') return 'record-form';
  return 'workflow-dashboard';
}

function routeStem(name) {
  const stem = String(name || 'screen')
    .normalize('NFKC')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'screen';
  return isWindowsReservedBasename(stem) ? `screen-${stem}` : stem;
}

function buildNativeRouteMap(brief) {
  const screens = toArray(brief.screens);
  const start = brief.app?.startScreen || screens[0]?.name;
  const used = new Set(['index', 'login', 'oauth-callback', 'home']);
  const routes = new Map();
  if (start && screens.some((screen) => screen.name === start)) {
    routes.set(start, {
      route: '/(app)/home',
      file: 'app/(app)/home.tsx',
      presentation: 'default',
      source: 'replace template',
    });
  }
  for (const screen of screens) {
    if (screen.name === start) continue;
    let stem = routeStem(screen.name);
    const base = stem;
    let suffix = 2;
    while (used.has(stem)) stem = `${base}-${suffix++}`;
    used.add(stem);
    routes.set(screen.name, {
      route: `/(app)/${stem}`,
      file: `app/(app)/${stem}.tsx`,
      presentation: 'default',
      source: 'new',
    });
  }
  return routes;
}

function collectScreenRows(brief) {
  const edges = toArray(brief.navigation && brief.navigation.edges);
  const edgeByFrom = new Map();
  const contractsByFrom = new Map();
  const paramsByTarget = new Map();
  for (const e of edges) {
    const from = e && e.from;
    const to = e && e.to;
    if (!from || !to) continue;
    if (!edgeByFrom.has(from)) edgeByFrom.set(from, []);
    edgeByFrom.get(from).push(to);
    if (!contractsByFrom.has(from)) contractsByFrom.set(from, []);
    contractsByFrom.get(from).push(e);
    if (!paramsByTarget.has(to)) paramsByTarget.set(to, new Set());
    for (const key of toArray(e.contextKeys)) paramsByTarget.get(to).add(key);
  }
  const routeMap = buildNativeRouteMap(brief);
  return toArray(brief.screens).map((s) => {
    const route = routeMap.get(s.name);
    return {
      name: s.name,
      route: route.route,
      file: route.file,
      presentation: route.presentation,
      source: route.source,
      archetype: nativeArchetype(s.layoutKind),
      layoutKind: s.layoutKind || 'screen',
      purpose: s.purpose || '',
      userStory: s.userStory || '',
      dataverseTablesUsed: toArray(s.dataverseTablesUsed),
      connectorsUsed: toArray(s.connectorsUsed).map((c) => c.name).filter(Boolean),
      nativeCapabilities: toArray(s.nativeCapabilities),
      outgoingTo: unique([...toArray(s.outgoingTo), ...toArray(edgeByFrom.get(s.name))]),
      outgoingNavigation: toArray(contractsByFrom.get(s.name)).map((edge) => ({
        to: edge.to,
        route: routeMap.get(edge.to)?.route || null,
        trigger: edge.trigger || null,
        transition: edge.transition || null,
        contextKeys: toArray(edge.contextKeys),
      })),
      incomingParams: [...(paramsByTarget.get(s.name) || [])].sort(),
      controlCount: s.controlCount || 0,
    };
  });
}

function buildRisks(brief, connectors, tables) {
  const risks = [];
  const unsupported = toArray(brief.unsupported);
  if (unsupported.length > 0) {
    risks.push({
      severity: 'high',
      code: 'UNSUPPORTED_FORMULAS',
      message:
        unsupported.length + ' unsupported formula/control items need manual translation.',
    });
  }
  if (connectors.length === 0 && tables.length > 0) {
    // NOT a risk by itself: Dataverse is always required. Only flag if user
    // app likely needs an external connector and the source didn't capture one.
    risks.push({
      severity: 'low',
      code: 'NO_EXTERNAL_CONNECTORS',
      message:
        'No non-Dataverse connectors detected. Confirm the app does not need external services (mail, Office 365 Users, custom APIs, etc.).',
    });
  }
  if (tables.length > 0 && brief.app && brief.app.settings && brief.app.settings.offlineEnabled === false) {
    risks.push({
      severity: 'medium',
      code: 'OFFLINE_DISABLED_IN_SOURCE',
      message:
        'Source app reports offline disabled. Decide whether to configure an offline profile for the mobile app.',
    });
  }
  if (!brief.app || !brief.app.startScreen) {
    risks.push({
      severity: 'medium',
      code: 'MISSING_START_SCREEN',
      message: 'No start screen found in brief. Navigation bootstrap must be confirmed manually.',
    });
  }
  return risks;
}

// ---------- App-level state (var_* / col_*) ----------

const VAR_WRITE_RE = /\b(?:Set|UpdateContext)\s*\(\s*\{?\s*([A-Za-z_][A-Za-z0-9_]*)/g;
const COL_WRITE_RE = /\b(?:Collect|ClearCollect|Clear|Patch|RemoveIf|Remove|Update)\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)/g;
const VAR_READ_RE = /\b(var_[A-Za-z0-9_]+)\b/g;
const COL_READ_RE = /\b(col_[A-Za-z0-9_]+)\b/g;

function scanFormulasForState(formula, screenName, controlName, state) {
  if (!formula) return;
  const text = String(formula);
  let m;
  VAR_WRITE_RE.lastIndex = 0;
  while ((m = VAR_WRITE_RE.exec(text)) !== null) {
    const name = m[1];
    if (!name.startsWith('var_')) continue;
    if (!state.vars[name]) state.vars[name] = { writtenIn: new Set(), readIn: new Set() };
    state.vars[name].writtenIn.add(screenName + ':' + controlName);
  }
  COL_WRITE_RE.lastIndex = 0;
  while ((m = COL_WRITE_RE.exec(text)) !== null) {
    const name = m[1];
    if (!name.startsWith('col_')) continue;
    if (!state.cols[name]) state.cols[name] = { writtenIn: new Set(), readIn: new Set() };
    state.cols[name].writtenIn.add(screenName + ':' + controlName);
  }
  VAR_READ_RE.lastIndex = 0;
  while ((m = VAR_READ_RE.exec(text)) !== null) {
    const name = m[1];
    if (!state.vars[name]) state.vars[name] = { writtenIn: new Set(), readIn: new Set() };
    state.vars[name].readIn.add(screenName);
  }
  COL_READ_RE.lastIndex = 0;
  while ((m = COL_READ_RE.exec(text)) !== null) {
    const name = m[1];
    if (!state.cols[name]) state.cols[name] = { writtenIn: new Set(), readIn: new Set() };
    state.cols[name].readIn.add(screenName);
  }
}

function collectAppState(screens) {
  const state = { vars: {}, cols: {} };
  for (const sc of screens) {
    const screenName = sc.name;
    if (sc.properties && sc.properties.OnVisible) {
      scanFormulasForState(sc.properties.OnVisible, screenName, 'screen.OnVisible', state);
    }
    for (const c of toArray(sc.controls)) {
      const ctlName = shortName(c.path, c.name);
      for (const k of Object.keys(c.properties || {})) {
        scanFormulasForState(c.properties[k], screenName, ctlName + '.' + k, state);
      }
    }
  }
  return state;
}

// ---------- Behaviors (event-action intents) ----------
//
// The brief pre-classifies every `OnSelect`/`OnChange`/`OnCheck`/`OnUncheck`/
// `OnScan`/`OnSuccess` handler into a typed-intent array (see the
// `events` bag emitted by the og-script). We re-shape those into a flat
// `behaviors.json` so the screen-builder doesn't have to re-walk per-screen
// markdown to find them. Intents with `intent: "unknown"` go to
// `unmatchedFormulas[]` as the honest gap surface — never silently dropped,
// never LLM-translated.

function normalizeIntentPayload(a) {
  const i = a.intent;
  const out = {};
  if (i === 'setVar' || i === 'setContext') {
    if (a.name) out.name = a.name;
    if (a.expression) out.expression = a.expression;
    if (a.context) out.context = a.context;
    if (a.inferredSchema) out.inferredSchema = a.inferredSchema;
  } else if (i === 'patch' || i === 'update' || i === 'updateIf' || i === 'removeIf' || i === 'remove') {
    if (a.source) out.source = a.source;
    if (a.baseRecord) out.baseRecord = a.baseRecord;
    if (a.fields) out.fields = a.fields;
  } else if (i === 'collect' || i === 'clearCollect' || i === 'clear') {
    if (a.collection) out.collection = a.collection;
    if (a.from) out.from = a.from;
    if (a.inferredSchema) out.inferredSchema = a.inferredSchema;
  } else if (i === 'navigate') {
    if (a.target) out.target = a.target;
    if (a.transition) out.transition = a.transition;
    if (a.context) out.context = a.context;
  } else if (i === 'back') {
    if (a.transition) out.transition = a.transition;
  } else if (i === 'notify') {
    if (a.message) out.message = a.message;
    if (a.type) out.type = a.type;
  } else if (i === 'submitForm' || i === 'newForm' || i === 'resetForm') {
    if (a.form) out.form = a.form;
    if (a.target) out.target = a.target;
  } else if (i === 'select' || i === 'reset') {
    if (a.target) out.target = a.target;
  } else if (i === 'refresh') {
    if (a.source) out.source = a.source;
  } else if (i === 'read' || i === 'literal') {
    if (a.expression) out.expression = a.expression;
    if (a.value !== undefined) out.value = a.value;
  } else {
    // Pass-through for any future intent — drop only the bookkeeping keys.
    for (const k of Object.keys(a)) {
      if (k === 'intent' || k === 'rawArgs') continue;
      out[k] = a[k];
    }
  }
  if (Array.isArray(a.controlFlow) && a.controlFlow.length > 0) {
    out.controlFlow = a.controlFlow.map((frame) => ({ ...frame }));
  }
  return out;
}

function hintForIntent(intent) {
  switch (intent) {
    case 'setVar':
    case 'setContext':
      return 'Follow `state/app-state.md` recommended native placement: route params, local/form state, query cache, bootstrap, or app/provider state only when truly cross-screen.';
    case 'concurrent':
      return 'Run independent child actions in parallel with `Promise.all`; preserve sequential order for dependent actions.';
    case 'patch':
      return 'Call `dataverse.<table>.update()` (or `.create()` if baseRecord is `Defaults(...)`) via the generated service.';
    case 'update':
    case 'updateIf':
      return 'Map over the local collection and update matching items in place.';
    case 'removeIf':
    case 'remove':
      return 'Filter the local collection or call `.delete()` on the generated service.';
    case 'collect':
    case 'clearCollect':
    case 'clear':
      return 'Translate the source table expression with `shared/references/powerfx-table-operations.md`, then place the result via `state/app-state.md` (local state, query cache/domain hook, bootstrap, or app/provider state).';
    case 'navigate':
      return 'Use Expo Router and map Canvas Navigate(..., { context }) values to typed route params from Navigation Contracts. Do not use React Context for navigation context.';
    case 'back':
      return 'Use `router.back()` from expo-router.';
    case 'launch':
      return 'Open the URL with Linking or the approved web/browser wrapper; validate schemes before opening.';
    case 'download':
      return 'Use the approved file/share wrapper for downloads; never assume browser-only download APIs exist on native.';
    case 'print':
      return 'Use the approved PDF/report wrapper (`expo-print` via /add-native pdf-report) when available.';
    case 'notify':
      return 'Show a toast/snackbar.';
    case 'submitForm':
      return 'Call the form\'s submit handler (React Hook Form + Zod).';
    case 'newForm':
    case 'resetForm':
      return 'Reset the form state via React Hook Form `reset()`.';
    case 'select':
      return 'Focus or activate the target control (often a `.focus()` ref call).';
    case 'setFocus':
      return 'Focus the mapped input ref or route to the same handler as the target control when focus is not meaningful.';
    case 'reset':
      return 'Clear the target field/control value.';
    case 'refresh':
      return 'Invalidate the React Query cache for the matching data source.';
    case 'flow':
    case 'flowRun':
    case 'runFlow':
      return 'Call the generated flow service created by `npx power-apps add-flow`; do not use add-data-source or a generic connector service.';
    case 'read':
      return 'No side effect — condition evaluation; usually inlined at call site.';
    case 'literal':
      return 'Literal value (no-op or constant assignment).';
    case 'trace':
      return 'Log diagnostic metadata with console.debug/console.info; do not show trace text to users.';
    case 'exitApp':
      return 'Call `BackHandler.exitApp()` on native; `window.close()` on web.';
    case 'clearOfflineData':
      return 'Clear only the app-owned persisted cache identified by the source key. Do not treat a Dataverse Mobile Offline Profile as a client cache API.';
    case 'saveData':
      return 'Persist local-only data through the approved storage wrapper; do not use it for Dataverse/server collections.';
    case 'loadData':
      return 'Load local-only persisted data through the approved storage wrapper with an empty/default fallback.';
    case 'showHostInfo':
      return 'Open the native host info dialog.';
    case 'requestHide':
      return 'Send app to background via platform API.';
    default:
      return null;
  }
}

// ---- Intent rescue for upstream `intent: 'unknown'` actions -------------
//
// The upstream brief extractor classifies most OnSelect / OnChange actions
// into named intents (setVar, patch, navigate, …). The handful it can't
// recognize come through with `intent: 'unknown'` and end up in
// `unmatchedFormulas[]`. We rescue the common shapes here so the screen-
// builder gets a labelled bucket instead of raw text.
//
// Shapes handled:
//   - `<Ctrl>.<prop> = <expr>`  — illegal Power Fx (you can't assign to a
//     control property at runtime), so the source is dead/commented scratch.
//     Returned as `intent: 'dead-code-assignment'`.
//   - Bare boolean predicate (no side-effecting top-level call) — Power Fx
//     evaluates and discards. Returned as `intent: 'predicate-only'`.
//   - Empty after comment strip — `intent: 'dead-code-comment'`.
const RE_DEAD_ASSIGNMENT = /^([A-Za-z_][\w]*)\.([A-Za-z_][\w]*)\s*=\s*(.+)$/s;
// Side-effecting top-level functions per Power Fx spec — the union of every
// intent already classified by the upstream extractor. If a formula starts
// with one of these, it has a real effect and we leave it as 'unknown' for
// human review (likely an extractor gap, not dead code).
const RE_SIDE_EFFECT_CALL = /^(?:Set|UpdateContext|Patch|Update|UpdateIf|Remove|RemoveIf|Collect|ClearCollect|Clear|Navigate|Back|Notify|SubmitForm|NewForm|ResetForm|EditForm|ViewForm|Select|Reset|Refresh|Launch|Download|Print|RequestHide|Exit|ExitApp|ShowHostInfo|ClearOfflineData|SaveData|LoadData|Concurrent|Trace|SetFocus|SetProperty)\s*\(/i;

function rescueUnknownIntent(a) {
  const raw = a && a.raw ? String(a.raw) : '';
  if (!raw.trim()) return null;
  const stripped = stripPowerFxComments(raw).trim();
  if (!stripped) {
    return {
      intent: 'dead-code-comment',
      expression: raw.slice(0, 160),
      hint: 'Action is entirely comments after strip — drop during port.',
    };
  }
  const m = stripped.match(RE_DEAD_ASSIGNMENT);
  if (m) {
    return {
      intent: 'dead-code-assignment',
      target: `${m[1]}.${m[2]}`,
      expression: m[3].trim().slice(0, 160),
      hint: 'Power Fx does not allow assigning to control properties at runtime — this is dead/commented scratch code. Skip during port.',
    };
  }
  if (!RE_SIDE_EFFECT_CALL.test(stripped)) {
    return {
      intent: 'predicate-only',
      expression: stripped.slice(0, 200),
      hint: 'Bare boolean expression with no side effect — Power Fx evaluates and discards. Likely a leftover guard. Verify against source and drop if unused.',
    };
  }
  return null;
}

// ---- Property-formula classifiers ---------------------------------------
//
// Set of property names we ATTEMPT to classify. Anything not in this set is
// ignored entirely (cosmetic noise like Color, Fill, Font). Anything IN the
// set that we fail to classify lands in `unmatchedFormulas[]` so a human can
// port it manually.
const CLASSIFIABLE_PROPS = new Set([
  'Visible', 'DisplayMode', 'Required', 'Default', 'Text', 'Items', 'HintText', 'OnTimerEnd', 'Duration',
]);

const RE_LITERAL_BOOL = /^(true|false)$/i;
const RE_LITERAL_NUMBER = /^-?\d+(?:\.\d+)?$/;
const RE_LITERAL_STRING = /^"(?:[^"\\]|\\.)*"$/;
// Per Power Fx spec: ThisItem, ThisRecord, Parent, Self, App, plus user-named
// `As` aliases. We can't enumerate aliases statically, so we accept any
// PascalCase identifier as the leading binding when followed by a property
// path — that matches `Employee.'First Name'` style after `As Employee`.
const RE_FIELD_BINDING = /^(?:ThisItem|ThisRecord|Parent|Self|App|[A-Z][A-Za-z0-9_]*)(?:\.[A-Za-z_][\w]*|\.'[^']+')+$/;
const RE_ISBLANK = /^!?\s*IsBlank\s*\(\s*([^)]+?)\s*\)$/;
const RE_NOT_ISBLANK = /^!\s*IsBlank\s*\(\s*([^)]+?)\s*\)$/;
const RE_VAR_EQUALS_LITERAL = /^([A-Za-z_][\w]*)\s*=\s*("(?:[^"\\]|\\.)*"|\d+|true|false)$/i;
const RE_COUNTROWS_COMP = /^CountRows\s*\(\s*([^)]+?)\s*\)\s*([<>=!]+)\s*(\d+)$/;
const RE_DISPLAYMODE = /^DisplayMode\.(Disabled|Edit|View)$/;
const RE_DISPLAYMODE_IF = /^If\s*\(\s*(.+?)\s*,\s*DisplayMode\.(Disabled|Edit|View)\s*,\s*DisplayMode\.(Disabled|Edit|View)\s*\)$/s;
const RE_LEN_COMP = /^Len\s*\(\s*([^)]+?)\s*\)\s*([<>=!]+)\s*(\d+)$/;
const RE_ISMATCH = /^IsMatch\s*\(\s*([^,]+?)\s*,\s*(.+)\)$/;
const RE_DATA_QUERY = /^(?:Filter|Sort|SortByColumns|Search|LookUp|FirstN|LastN|ShowColumns|DropColumns|RenameColumns|AddColumns|GroupBy|Ungroup|Distinct)\s*\(/;
// Brief-driven — defaults to "never match", then set by setBriefContext() once
// per main() run. Keeps the adapter app-agnostic (no publisher-specific identifiers).
let RE_TRANSLATION_LOOKUP = /^$.^/;
// Most-common publisher prefix detected from `dataModel.dataverseTables[].logicalName`.
// Used in localization warning + attachment-swap hint. Falls back to placeholder.
let PUBLISHER_PREFIX = null;
const RE_PARENT_INHERIT = /^Parent\.(?:DisplayMode|Visible|BorderColor|Fill)$/;
// Power Fx-specific syntax — applies generically regardless of app.
const RE_STRING_INTERPOLATION = /^\$"/;
const RE_IN_OP_TOPLEVEL = /^(.+?)\s+in\s+([A-Za-z_][\w]*)$/;
const RE_EXACTIN_OP_TOPLEVEL = /^(.+?)\s+exactin\s+([A-Za-z_][\w]*)$/;
// Compound boolean — `&&`, `||`, `And`, `Or` (and word-boundary `Not`).
const RE_COMPOUND_BOOL = /(?:&&|\|\||\b(?:And|Or|Not)\b)/;
// Additional derivation patterns — split the "computed" bucket into named kinds.
const RE_IF_CALL = /^If\s*\(/;
const RE_SWITCH_CALL = /^Switch\s*\(/;
const RE_LOOKUP_CALL = /^LookUp\s*\(/;
const RE_COALESCE_CALL = /^Coalesce\s*\(/;
const RE_FIRST_CALL = /^First(?:N)?\s*\(/;
const RE_LAST_CALL = /^Last(?:N)?\s*\(/;
const RE_TEXT_FORMAT_CALL = /^Text\s*\(/;
const RE_CHOICES_CALL = /^Choices\s*\(/;
const RE_WITH_CALL = /^With\s*\(/;
const RE_CONCAT_CALL = /^(?:Concatenate|Concat)\s*\(/;
const RE_TEXT_TRANSFORM_CALL = /^(?:Upper|Lower|Proper|Trim|TrimEnds)\s*\(/;
const RE_AGGREGATE_CALL = /^(?:Sum|Average|Min|Max|StdevP|VarP|CountRows|CountIf|CountA)\s*\(/;
const RE_DATE_NOW = /^(?:Today|Now)\s*\(\s*\)/;
const RE_USER_CALL = /^User\s*\(\s*\)/;
const RE_AMPERSAND_CONCAT = /[^&]&[^&]/; // "a" & b — but not && operator
// Dataverse-formula-column functions (per MS Learn: formula-reference-formula-columns).
// Each maps to a small JS surface area; named bucket lets screen-builder do a
// mechanical port instead of guessing.
const RE_NUMERIC_MATH = /^(?:Abs|Round|RoundUp|RoundDown|Int|Trunc|Sqrt|Power|Mod|Exp|Ln|Char|Value|Decimal|Float)\s*\(/;
const RE_DATE_MATH = /^(?:DateAdd|DateDiff|Year|Month|Day|Hour|Minute|Second|Weekday|WeekNum|ISOWeekNum|UTCNow|UTCToday|DateValue|TimeValue|DateTimeValue|IsToday|IsUTCToday|Date|Time|DateTime|EDate|EOMonth|TimeZoneOffset)\s*\(/;
const RE_STRING_SLICE = /^(?:Left|Mid|Right)\s*\(/;
const RE_STRING_SUBSTITUTE = /^(?:Substitute|Replace)\s*\(/;
const RE_STRING_PREDICATE = /^(?:StartsWith|EndsWith)\s*\(/;
const RE_AS_TYPE_CAST = /^AsType\s*\(/;
const RE_ERROR_HANDLING = /^(?:IfError|IsError|Error)\s*\(/;
const RE_LENGTH_CALL = /^Len\s*\(/;
// Power Fx language constructs from MS Learn: expression-grammar, tables,
// untyped-object, formula-reference-plug-ins. Each is a top-level shape the
// screen-builder needs a specific JS port hint for.
const RE_INLINE_TABLE = /^(?:Table\s*\(|\[(?!\s*@))/; // Table(...) or [...] value-table; NOT [@disambig]
const RE_INLINE_RECORD = /^\{/;                       // { field: value, ... } record literal
const RE_PARSE_JSON_CALL = /^ParseJSON\s*\(/;
const RE_JSON_SERIALIZE_CALL = /^JSON\s*\(/;
const RE_REGEX_EXTRACT = /^(?:Match|MatchAll)\s*\(/;
const RE_TEXT_ENCODE = /^(?:EncodeUrl|EncodeHTML|PlainText)\s*\(/;
const RE_TEXT_FIND = /^Find\s*\(/;                     // Find(needle, text [, start]) → 1-indexed position
const RE_COLOR_LITERAL = /^(?:Color\.[A-Z][A-Za-z]+|RGBA\s*\(|ColorValue\s*\(|ColorFade\s*\()/;
const RE_SEQUENCE_CALL = /^Sequence\s*\(/;
const RE_SPLIT_CALL = /^Split\s*\(/;
// Per MS Learn data-types + operators: type constructors (Boolean/GUID) and
// the @ disambiguation operator `Table[@field]` / `[@global]`.
const RE_TYPE_CONSTRUCTOR = /^(?:Boolean|GUID|Blank)\s*\(/;
const RE_DISAMBIG_REF = /^(?:[A-Za-z_][\w]*\s*\[@[A-Za-z_][\w\s]*\]|\[@[A-Za-z_][\w\s]*\])(?:\.[A-Za-z_][\w]*|\.'[^']+')*$/;
// Visibility — extra kinds.
const RE_BLANK_OR_ERROR = /^!?\s*IsBlankOrError\s*\(/;
const RE_FORM_MODE_CHECK = /^(?:Self|Parent|[A-Za-z_][\w]*)\.Mode\s*=\s*FormMode\.(New|Edit|View)$/;
// Phase 7e — Visibility/DisplayMode gap-fill buckets, derived from the
// `unmatchedFormulas[]` triage of `behaviors.json`. Each regex covers a
// dominant shape so the screen-builder gets a labelled hint instead of a
// raw formula dropped into the unmatched bin.
//
// `<Ctrl>.(DisplayMode|Visible|Value)$` — inherit a sibling control's
// mode/visibility/value. Control name may be bare (`Container_foo`) or
// single-quoted (`'Container & Footer'` — Power Fx requires quoting when
// the name contains special chars like `&`).
const RE_INHERIT_CONTROL = /^(?:([A-Za-z_][\w]*)|'([^']+)')\.(DisplayMode|Visible|Value)$/;
// `<Ctrl>.DisplayMode = DisplayMode.(Edit|View|Disabled)` — sibling
// edit-mode comparison used as a Visible/DisplayMode formula.
const RE_CTRL_MODE_EQUALS = /^([A-Za-z_][\w]*(?:\.(?:[A-Za-z_][\w]*|'[^']+'))*)\.DisplayMode\s*=\s*DisplayMode\.(Edit|View|Disabled)$/;
// `First(<col>).<field-path>` — single-row read from a collection used as
// boolean. Common visibility pattern when the screen has a 1-row "screen
// manager" collection.
const RE_FIRST_ROW_BOOL = /^First\s*\(\s*([A-Za-z_][\w]*)\s*\)\.((?:[A-Za-z_][\w]*|'[^']+')(?:\.(?:[A-Za-z_][\w]*|'[^']+'))*)$/;
// `First(<col>).<field-path> <op> <rhs>` — single-row read compared against
// a literal or enum.
const RE_FIRST_ROW_COMP = /^First\s*\(\s*([A-Za-z_][\w]*)\s*\)\.((?:[A-Za-z_][\w]*|'[^']+')(?:\.(?:[A-Za-z_][\w]*|'[^']+'))*)\s*(=|<>|<=|>=|<|>)\s*(.+)$/;
// `If(<cond>, true, false)` or `If(<cond>, false, true)` — boolean alias.
const RE_IF_BOOL_LITERAL = /^If\s*\(\s*(.+)\s*,\s*(true|false)\s*,\s*(true|false)\s*\)\s*$/is;
// Bare identifier used as boolean: `var_isFooVisible`.
const RE_BARE_IDENT = /^[A-Za-z_][\w]*$/;
// Field path used as boolean: `ThisItem.'Order Status'`, `Self.IsEditing`,
// `var_selectedAppointment.POS`. Lowercase prefixes accepted (so var refs
// match) in addition to the PascalCase RE_FIELD_BINDING.
const RE_FIELD_PATH_BOOL = /^(?:ThisItem|ThisRecord|Parent|Self|App|[A-Za-z_][\w]*)(?:\.(?:[A-Za-z_][\w]*|'[^']+'))+$/;
// Field path compared to RHS: `ThisItem.'Order Status' = 'Order Status (Orders)'.Draft`.
const RE_FIELD_COMPARE = /^((?:ThisItem|ThisRecord|Parent|Self|App|[A-Za-z_][\w]*)(?:\.(?:[A-Za-z_][\w]*|'[^']+'))*)\s*(=|<>|<=|>=|<|>)\s*(.+)$/;
// Upstream extractor sometimes truncates formulas with a literal ellipsis.
// Detect so we don't dump truncated text as if it's classifiable.
const RE_TRUNCATED_FORMULA = /…\s*$/;
// Validation — extra kinds.
const RE_ISNUMERIC = /^!?\s*IsNumeric\s*\(/;
const RE_VALUE_COMP = /^Value\s*\(\s*([^)]+?)\s*\)\s*([<>=!]+)\s*(-?\d+(?:\.\d+)?)$/;

// Detect the most common publisher prefix from Dataverse logical names —
// e.g. {twd: 25, nf: 1} → `twd`. Returns null when no prefixed tables exist.
function detectPublisherPrefix(brief) {
  const tables = toArray(brief && brief.dataModel && brief.dataModel.dataverseTables);
  const counts = {};
  for (const t of tables) {
    const m = (t && t.logicalName || '').match(/^([a-z]{2,8})_/);
    if (m) counts[m[1]] = (counts[m[1]] || 0) + 1;
  }
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  return sorted.length ? sorted[0][0] : null;
}

// Detect the logical name of the localization collection by scanning the
// app's OnStart raw formula for LookUp(<ident>, ...) calls whose identifier,
// lowercased and stripped, contains the localization.translationTable display
// name's words. Returns the identifier or null.
function detectTranslationCollectionLogical(brief) {
  const loc = brief && brief.localization;
  const display = loc && loc.translationTable;
  if (!display) return null;
  const wanted = display.toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (!wanted) return null;
  // Search OnStart + every screen's controls' string properties.
  const haystacks = [brief.app && brief.app.onStartRaw || ''];
  for (const s of toArray(brief.screens)) {
    for (const c of toArray(s.controls)) {
      for (const v of Object.values(c.properties || {})) {
        if (typeof v === 'string') haystacks.push(v);
      }
    }
  }
  const candidates = {};
  for (const h of haystacks) {
    const re = /LookUp\s*\(\s*([A-Za-z_][\w]*)\s*,/g;
    let m;
    while ((m = re.exec(h)) !== null) {
      const id = m[1];
      const stripped = id.toLowerCase().replace(/[^a-z0-9]+/g, '');
      // Accept if the ident's stripped form contains the wanted slug OR vice-versa.
      if (stripped.includes(wanted) || wanted.includes(stripped.replace(/^[a-z]{2,8}/, ''))) {
        candidates[id] = (candidates[id] || 0) + 1;
      }
    }
  }
  const sorted = Object.entries(candidates).sort((a, b) => b[1] - a[1]);
  return sorted.length ? sorted[0][0] : null;
}

// Called once per main() run, before extractBehaviors and the localization
// section writer. Sets the module-level regex + prefix from the brief.
function setBriefContext(brief) {
  const parsedTimestamp = Date.parse(String(brief && (brief.generatedAt || brief.source?.msappLastSavedUtc) || ''));
  GENERATION_TIMESTAMP = Number.isFinite(parsedTimestamp) ? new Date(parsedTimestamp).toISOString() : DETERMINISTIC_EPOCH;
  PUBLISHER_PREFIX = detectPublisherPrefix(brief);
  const collectionLogical = detectTranslationCollectionLogical(brief);
  if (collectionLogical) {
    // Escape regex special chars in the identifier (underscores are safe).
    const escaped = collectionLogical.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
    RE_TRANSLATION_LOOKUP = new RegExp('^LookUp\\s*\\(\\s*' + escaped + '\\s*,');
  } else {
    RE_TRANSLATION_LOOKUP = /^$.^/; // never matches
  }
}

// Strip Power Fx comments (block /* … */ and line //…) outside of string
// literals. Power Fx strings use doubled-quote ("") for embedded quotes; we
// walk char-by-char so URLs like "https://…" inside literals survive.
function stripPowerFxComments(s) {
  let out = '';
  let i = 0;
  const n = s.length;
  let inStr = false;
  while (i < n) {
    const c = s[i];
    const c2 = s[i + 1];
    if (inStr) {
      if (c === '"' && c2 === '"') { out += '""'; i += 2; continue; } // escaped quote
      if (c === '"') { inStr = false; out += c; i += 1; continue; }
      out += c; i += 1; continue;
    }
    if (c === '"') { inStr = true; out += c; i += 1; continue; }
    if (c === '/' && c2 === '*') {
      const end = s.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    if (c === '/' && c2 === '/') {
      while (i < n && s[i] !== '\n' && s[i] !== '\r') i += 1;
      continue;
    }
    out += c; i += 1;
  }
  return out;
}

function classifyVisibility(formula, key) {
  // Strip comments before matching; exported Power Fx commonly contains both
  // block comments and trailing line comments from maker maintenance notes.
  let f = stripPowerFxComments(formula).trim();
  // Tolerate leading `=` — Power Apps formula bar sometimes preserves a
  // user-typed `=` prefix even though Power Fx itself forbids it. Also
  // strip surrounding single-quotes some extractors wrap around malformed
  // identifier-like formulas.
  if (f.length >= 2 && f.startsWith("'") && f.endsWith("'")) f = f.slice(1, -1).trim();
  if (f.startsWith('=')) f = f.slice(1).trim();
  if (f === '') return { kind: 'always-visible', explanation: 'Empty after stripping comments.' };
  if (RE_TRUNCATED_FORMULA.test(f)) {
    return { kind: 'truncated-formula', hint: 'Upstream extractor truncated this formula (trailing ellipsis). Re-check the source msapp before porting.' };
  }
  if (RE_LITERAL_BOOL.test(f)) {
    return { kind: f.toLowerCase() === 'true' ? 'always-visible' : 'always-hidden' };
  }
  if (RE_PARENT_INHERIT.test(f)) {
    return { kind: 'inherit-parent', target: 'parent' };
  }
  // Inherit a sibling control's mode/visibility/value, e.g.
  // `Button_createAppointment_2.DisplayMode` or `'Container & Footer'.Visible`.
  // Applies regardless of `key`.
  const inheritCtrl = f.match(RE_INHERIT_CONTROL);
  if (inheritCtrl) {
    return { kind: 'inherit-control', target: inheritCtrl[1] || inheritCtrl[2], property: inheritCtrl[3] };
  }
  if (key === 'DisplayMode' && RE_DISPLAYMODE.test(f)) {
    const m = f.match(RE_DISPLAYMODE);
    return { kind: 'display-mode-literal', mode: m[1] };
  }
  if (key === 'DisplayMode') {
    const m = f.match(RE_DISPLAYMODE_IF);
    if (m) return { kind: 'display-mode-if', condition: m[1].trim(), whenTrue: m[2], whenFalse: m[3] };
  }
  // `<Ctrl>.DisplayMode = DisplayMode.Edit` — sibling edit-mode comparison.
  // Applies as a `Visible` (read sibling's mode) or `DisplayMode` formula.
  const ctrlMode = f.match(RE_CTRL_MODE_EQUALS);
  if (ctrlMode) {
    return { kind: 'when-control-mode', target: ctrlMode[1], mode: ctrlMode[2] };
  }
  const nb = f.match(RE_NOT_ISBLANK);
  if (nb) return { kind: 'when-not-blank', subject: nb[1] };
  const ib = f.match(RE_ISBLANK);
  if (ib) return { kind: 'when-blank', subject: ib[1] };
  if (RE_BLANK_OR_ERROR.test(f)) {
    return { kind: f.startsWith('!') ? 'when-not-blank-or-error' : 'when-blank-or-error', subject: f.replace(/^!\s*/, '') };
  }
  const fm = f.match(RE_FORM_MODE_CHECK);
  if (fm) return { kind: 'when-form-mode', mode: fm[1] };
  const cr = f.match(RE_COUNTROWS_COMP);
  if (cr) return { kind: 'when-countrows', subject: cr[1], operator: cr[2], threshold: parseInt(cr[3], 10) };
  const ve = f.match(RE_VAR_EQUALS_LITERAL);
  if (ve) return { kind: 'when-var-equals', variable: ve[1], value: ve[2] };
  // Power Fx `in` / `exactin` — substring or membership test. Only matches at
  // top level (no balanced-paren tracking), so compound predicates fall
  // through to the boolean-compound bucket below.
  const inOp = f.match(RE_IN_OP_TOPLEVEL);
  if (inOp && !RE_COMPOUND_BOOL.test(f)) {
    return { kind: 'when-in', needle: inOp[1].trim(), haystack: inOp[2], caseSensitive: false };
  }
  const exOp = f.match(RE_EXACTIN_OP_TOPLEVEL);
  if (exOp && !RE_COMPOUND_BOOL.test(f)) {
    return { kind: 'when-in', needle: exOp[1].trim(), haystack: exOp[2], caseSensitive: true };
  }
  // Compound boolean — `A && B`, `A || B`, `Not A`, mixed with And/Or. We
  // can't safely break it apart without an AST parser, but we CAN recognize
  // the shape and emit a named kind so the screen-builder writes a single
  // `useMemo<boolean>(() => /* port: <formula> */, [deps])` instead of a
  // hardcoded `true`. Run BEFORE the simple-shape buckets below so any
  // formula with top-level `&&` / `||` / `And` / `Or` / `Not` is bucketed
  // here rather than partially matched by a comparison/identifier shape.
  if (RE_COMPOUND_BOOL.test(f)) {
    return { kind: 'boolean-compound', expression: formula, hint: 'Port to a `useMemo<boolean>(() => …, [deps])` — preserve `&&` / `||` / `!` operators and translate `And`/`Or`/`Not` to JS equivalents. Sub-expressions calling Dataverse must be hoisted into their own `useQuery` calls.' };
  }
  // `!<expr>` where expr is not IsBlank/IsBlankOrError (handled above). e.g.
  // `!var_displayValidationLines`, `!Label_xx.Visible`, `!Toggle.Value`.
  if (f.startsWith('!')) {
    return { kind: 'when-not-truthy', expression: f.slice(1).trim() };
  }
  // `If(<cond>, true, false)` and the swapped variant — boolean alias.
  const ifBool = f.match(RE_IF_BOOL_LITERAL);
  if (ifBool) {
    const inverted = ifBool[2].toLowerCase() === 'false';
    return { kind: 'when-if-boolean', condition: ifBool[1].trim(), inverted };
  }
  // Generic `If(<cond>, <a>, <b>)` — fall through with the whole formula so
  // the screen-builder gets a named bucket instead of "complex-formula".
  if (RE_IF_CALL.test(f)) {
    return { kind: 'when-if', expression: formula, hint: 'Port to a ternary or `if` block in JS. Sub-expressions calling Dataverse must be hoisted into their own `useQuery` calls.' };
  }
  // Generic `Switch(<expr>, <case>, <value>, …)`.
  if (RE_SWITCH_CALL.test(f)) {
    return { kind: 'when-switch', expression: formula, hint: 'Port to a `switch` block or a record lookup in JS. Preserve case order — first match wins.' };
  }
  // `LookUp(<col>, <pred>)` or `LookUp(<col>, <pred>).<field>` — single-row
  // collection lookup used as boolean or compared.
  if (RE_LOOKUP_CALL.test(f)) {
    return { kind: 'when-lookup', expression: formula, hint: 'Port to `useQuery` + `.find(row => …)`. Likely needs to hoist into its own hook.' };
  }
  // `First(<col>).<field>` — single-row read used as boolean.
  const firstRow = f.match(RE_FIRST_ROW_BOOL);
  if (firstRow) {
    return { kind: 'when-first-row', collection: firstRow[1], field: firstRow[2] };
  }
  // `First(<col>).<field> <op> <rhs>` — single-row read compared to a literal.
  const firstRowComp = f.match(RE_FIRST_ROW_COMP);
  if (firstRowComp) {
    return { kind: 'when-first-row-equals', collection: firstRowComp[1], field: firstRowComp[2], operator: firstRowComp[3], rhs: firstRowComp[4].trim() };
  }
  // Bare identifier used as boolean: `var_isFooVisible`.
  if (RE_BARE_IDENT.test(f)) {
    return { kind: 'when-var-truthy', variable: f };
  }
  // Field path used as boolean: `ThisItem.'Order Status'`, `Self.IsEditing`.
  if (RE_FIELD_PATH_BOOL.test(f)) {
    return { kind: 'when-field-truthy', subject: f };
  }
  // Generic comparison `<path> <op> <rhs>` — last resort for COMPARE shapes.
  // RE_VAR_EQUALS_LITERAL is checked earlier and only handles var=literal; this
  // is broader (quoted column names, enum RHS, non-literal RHS).
  const fc = f.match(RE_FIELD_COMPARE);
  if (fc) {
    return { kind: 'when-field-equals', subject: fc[1], operator: fc[2], rhs: fc[3].trim() };
  }
  // Fall back to "complex" — let it sink into unmatchedFormulas[] so caller can decide.
  return null;
}

function classifyRequired(formula) {
  const f = stripPowerFxComments(formula).trim();
  if (RE_LITERAL_BOOL.test(f)) {
    return { kind: 'required', required: f.toLowerCase() === 'true', source: 'literal' };
  }
  return { kind: 'required-conditional', condition: formula };
}

function classifyValidationFormula(formula) {
  const f = stripPowerFxComments(formula).trim();
  const im = f.match(RE_ISMATCH);
  if (im) return { kind: 'pattern-match', subject: im[1].trim(), pattern: im[2].trim() };
  const lc = f.match(RE_LEN_COMP);
  if (lc) return { kind: 'length-constraint', subject: lc[1], operator: lc[2], threshold: parseInt(lc[3], 10) };
  if (RE_ISNUMERIC.test(f)) {
    return { kind: 'numeric-constraint', subject: f.replace(/^!?\s*IsNumeric\s*\(\s*|\s*\)$/g, '') };
  }
  const vc = f.match(RE_VALUE_COMP);
  if (vc) return { kind: 'range-constraint', subject: vc[1], operator: vc[2], threshold: parseFloat(vc[3]) };
  return null;
}

function classifyDerivation(formula, key) {
  const f = stripPowerFxComments(formula).trim();
  if (f === '') return { kind: 'empty' };
  if (RE_LITERAL_BOOL.test(f) || RE_LITERAL_NUMBER.test(f) || RE_LITERAL_STRING.test(f)) {
    return { kind: 'literal', value: f };
  }
  // Inline table `[a, b, c]` or `Table({...}, {...})` — static value table,
  // commonly used for dropdown choices.
  if (RE_INLINE_TABLE.test(f)) {
    return {
      kind: 'inline-table',
      expression: formula,
      hint: 'Power Fx `[a, b, c]` is a single-column table with column `Value`; map to `const opts = [{ value: a }, { value: b }, ...]`. `Table({...}, {...})` is a multi-column inline table → map to a plain array of objects. Use directly as the `data` source for a list, picker, or `useMemo` constant.',
    };
  }
  // Inline record `{ field: value, ... }` — record literal used as Patch
  // payload, default value, or struct argument.
  if (RE_INLINE_RECORD.test(f)) {
    return {
      kind: 'inline-record',
      expression: formula,
      hint: "Power Fx `{ field: expr, ... }` → JS object literal. If used as a Patch payload, map field names to the Dataverse logical column names (singleline_email, _ownerid_value, etc.). Single-quoted field names ('Field With Space') drop the quotes in JS but require the runtime column logical name, not the display name.",
    };
  }
  // Color literal — Color.Black / RGBA(...) / ColorValue("#aabbcc") — must
  // win over RE_FIELD_BINDING (which would match `Color.Black` as a path).
  if (RE_COLOR_LITERAL.test(f)) {
    return {
      kind: 'color-literal',
      expression: formula,
      hint: 'Power Fx `Color.<Name>` → CSS color string from the design tokens (`tokens.color.<role>`). RGBA(r, g, b, a) → `rgba(r, g, b, a)` (Power Fx `a` is 0–1, NOT 0–255). ColorValue("#aabbcc") → pass through. ColorFade(c, f) → `tinycolor(c).lighten(f * 100)` or compose with the design system\'s color-mix util. Do NOT hardcode brand colors — route through `brand/tokens.ts`.',
    };
  }
  // Power Fx string interpolation: $"...{expr}..." → JS template literal.
  if (RE_STRING_INTERPOLATION.test(f)) {
    return {
      kind: 'string-interpolation',
      expression: formula,
      hint: 'Power Fx $"...{expr}..." → JS template literal `${expr}`. `{{` and `}}` escape literal braces. Nested interpolations are allowed.',
    };
  }
  // `in` / `exactin` operators — substring or membership test at top level.
  const inOp = f.match(RE_IN_OP_TOPLEVEL);
  if (inOp && !RE_COMPOUND_BOOL.test(f)) {
    return {
      kind: 'membership-test',
      expression: formula,
      caseSensitive: false,
      hint: 'Power Fx `<x> in <coll>` → case-insensitive `.some(...)` over the collection (or `.toLowerCase().includes(...)` over a string).',
    };
  }
  const exOp = f.match(RE_EXACTIN_OP_TOPLEVEL);
  if (exOp && !RE_COMPOUND_BOOL.test(f)) {
    return {
      kind: 'membership-test',
      expression: formula,
      caseSensitive: true,
      hint: 'Power Fx `<x> exactin <coll>` → case-sensitive `.some(...)` or `.includes(...)`.',
    };
  }
  // `Table[@field]` or `[@global]` — record-scope disambiguation. Matched
  // before field-binding because the brackets break the field-binding regex.
  if (RE_DISAMBIG_REF.test(f)) {
    return {
      kind: 'disambiguation-reference',
      expression: formula,
      hint: 'Power Fx `Table[@field]` accesses the outer-scope `field` shadowed by a nested record scope; `[@global]` accesses a global value (data source, collection, context variable) shadowed by a local. In JS there is no shadow: rename the inner loop variable, or reach the global directly (e.g. `globalCollection` or the closed-over `useState` value). DO NOT translate `[@…]` literally.',
    };
  }
  if (RE_FIELD_BINDING.test(f)) {
    return { kind: 'field-binding', expression: f };
  }
  if (RE_TRANSLATION_LOOKUP.test(f)) {
    return {
      kind: 'translation-lookup',
      expression: formula,
      hint: 'Replace with `t("<key>")` from the localization runtime.',
    };
  }
  if (RE_DATA_QUERY.test(f)) {
    return {
      kind: 'data-query',
      expression: formula,
      hint: key === 'Items'
        ? 'Translate using shared/references/powerfx-table-operations.md. Use React Query against generated services for remote tables; push Filter/Sort/Search/FirstN into OData when delegable.'
        : 'Translate using shared/references/powerfx-table-operations.md into useMemo() or React Query depending on whether the source is local or remote.',
    };
  }
  if (RE_FIRST_CALL.test(f)) {
    return {
      kind: 'first-of',
      expression: formula,
      hint: 'Power Fx First(...) / FirstN(...) — follow shared/references/powerfx-table-operations.md. For remote sorted data, push orderBy + top into the service call; for local data use `[0]` / `.slice(0, n)` with null fallback.',
    };
  }
  if (RE_LAST_CALL.test(f)) {
    return {
      kind: 'last-of',
      expression: formula,
      hint: 'Follow shared/references/powerfx-table-operations.md. For remote Last/LastN, reverse the order server-side when possible; otherwise only slice after an intentionally bounded local result.',
    };
  }
  if (RE_CHOICES_CALL.test(f)) {
    return {
      kind: 'choice-options',
      expression: formula,
      hint: 'Power Fx Choices(<table>.<lookup>) — returns the option set / lookup picklist for a column. For Dataverse choice columns map to the generated `<Name>Options` const. For lookups map to a `useQuery` against the related table.',
    };
  }
  if (RE_COALESCE_CALL.test(f)) {
    return {
      kind: 'coalesce',
      expression: formula,
      hint: 'Coalesce(a, b, c) → `a ?? b ?? c` (nullish coalescing). Each arg is evaluated lazily; preserve order.',
    };
  }
  if (RE_IF_CALL.test(f)) {
    return {
      kind: 'conditional',
      expression: formula,
      hint: 'Power Fx If(cond, then, else) → ternary or `useMemo` returning one of the branches. If the branches read different data sources, keep both `useQuery` calls and pick the result; do NOT conditionally call hooks.',
    };
  }
  if (RE_SWITCH_CALL.test(f)) {
    return {
      kind: 'switch',
      expression: formula,
      hint: 'Power Fx Switch(value, case1, result1, case2, result2, ..., default) → JS `switch` or an object map indexed by `value`.',
    };
  }
  if (RE_WITH_CALL.test(f)) {
    return {
      kind: 'let-binding',
      expression: formula,
      hint: 'Power Fx With({name: expr, ...}, body) → introduce locals with `const { name } = useMemo(() => ({ name: expr }), [...])` and reference them inside the body expression.',
    };
  }
  if (RE_TEXT_FORMAT_CALL.test(f)) {
    return {
      kind: 'formatted-value',
      expression: formula,
      hint: 'Power Fx Text(value, format) → `formatDate` / `formatDateTime` / `formatRelative` / `Intl.NumberFormat` depending on argument type. For date/time use `@/utils` formatters.',
    };
  }
  if (RE_CONCAT_CALL.test(f) || RE_AMPERSAND_CONCAT.test(f)) {
    return {
      kind: 'concatenation',
      expression: formula,
      hint: 'Power Fx Concatenate(...) or & operator → JS template literal `${a}${b}` or `[a, b].filter(Boolean).join(" ")`.',
    };
  }
  if (RE_TEXT_TRANSFORM_CALL.test(f)) {
    return {
      kind: 'text-transform',
      expression: formula,
      hint: 'Upper/Lower/Proper/Trim/TrimEnds → `.toUpperCase()` / `.toLowerCase()` / title-case helper / `.trim()`.',
    };
  }
  if (RE_AGGREGATE_CALL.test(f)) {
    return {
      kind: 'aggregate',
      expression: formula,
      hint: 'Sum/Average/Min/Max/Count* → `useMemo(() => arr.reduce(...), [arr])`. For remote aggregates over Dataverse, use `$apply=aggregate(...)` in OData if performance matters.',
    };
  }
  if (RE_DATE_NOW.test(f)) {
    return {
      kind: 'now-binding',
      expression: formula,
      hint: 'Today() / Now() → `new Date()` (call inside a `useMemo` with empty deps to freeze, OR re-evaluate per render if the value needs to be live).',
    };
  }
  if (RE_USER_CALL.test(f)) {
    return {
      kind: 'user-binding',
      expression: formula,
      hint: 'User() → read from the auth context (`useAuth()` / `usePowerApps()` — whichever the template exposes). For Dataverse `User().Email` map to `whoAmI().userPrincipalName` or `User().FullName` → the auth profile.',
    };
  }
  if (RE_TYPE_CONSTRUCTOR.test(f)) {
    return {
      kind: 'type-constructor',
      expression: formula,
      hint: "Power Fx type constructors: Boolean(x) coerces a string/number/Dynamic to bool (`\"true\"`/`\"false\"` case-insensitive, non-zero \u2192 true) \u2014 in JS use `x === true || x === \"true\" || (typeof x === \"number\" && x !== 0)`. GUID() (no args) \u2192 `crypto.randomUUID()`; GUID(str) \u2192 validate then pass through. Blank() \u2192 `null` (NOT `undefined`; Patch payloads need explicit null to clear a Dataverse field).",
    };
  }
  if (RE_NUMERIC_MATH.test(f)) {
    return {
      kind: 'numeric-math',
      expression: formula,
      hint: 'Power Fx numeric functions → JS `Math.*` / Number coercion: Abs→`Math.abs`, Round→`Math.round`, RoundUp→`Math.ceil`, RoundDown/Int/Trunc→`Math.floor`/`Math.trunc`, Sqrt→`Math.sqrt`, Power(a,b)→`a ** b`, Mod(a,b)→`((a % b) + b) % b` (Power Fx Mod is always positive), Exp→`Math.exp`, Ln→`Math.log`, Value/Decimal/Float→`Number(x)` / `parseFloat(x)`, Char→`String.fromCharCode`.',
    };
  }
  if (RE_DATE_MATH.test(f)) {
    return {
      kind: 'date-math',
      expression: formula,
      hint: 'Power Fx date functions → `date-fns` (already bundled): DateAdd→`addDays`/`addMonths`/etc, DateDiff→`differenceInDays`/etc, Year/Month/Day/Hour/Minute/Second→`getYear`/`getMonth`+1/`getDate`/`getHours`/`getMinutes`/`getSeconds`, Weekday→`getDay`+1, WeekNum→`getWeek`, UTCNow→`new Date()` (already UTC under the hood; use `formatISO` for output), UTCToday→`startOfDay(new Date())`. CRITICAL: Power Fx dates are LOCAL by default — pass `{ representation: "date" }` or call `.toLocaleDateString()` where the spec said the date, not the instant.',
    };
  }
  if (RE_STRING_SLICE.test(f)) {
    return {
      kind: 'string-slice',
      expression: formula,
      hint: 'Power Fx Left/Mid/Right are 1-INDEXED. JS `.slice()` is 0-INDEXED. Left(s,n)→`s.slice(0,n)`, Right(s,n)→`s.slice(-n)`, Mid(s,start,len)→`s.slice(start-1, start-1+len)`. Off-by-one is the #1 porting bug here — re-derive each conversion, do not paste.',
    };
  }
  if (RE_STRING_SUBSTITUTE.test(f)) {
    return {
      kind: 'string-substitute',
      expression: formula,
      hint: 'Substitute(s, old, new) replaces ALL occurrences → JS `s.replaceAll(old, new)` (NOT `.replace()` — that only replaces first). Substitute(s, old, new, n) replaces ONLY the n-th occurrence → custom loop. Replace(s, start, count, new) is POSITIONAL → `s.slice(0, start-1) + new + s.slice(start-1+count)` (start is 1-indexed).',
    };
  }
  if (RE_STRING_PREDICATE.test(f)) {
    return {
      kind: 'string-predicate',
      expression: formula,
      hint: 'StartsWith(s, prefix) → `s.startsWith(prefix)` (case-insensitive in Power Fx — use `s.toLowerCase().startsWith(prefix.toLowerCase())` for parity). EndsWith likewise.',
    };
  }
  if (RE_AS_TYPE_CAST.test(f)) {
    return {
      kind: 'as-type-cast',
      expression: formula,
      hint: 'AsType(ref, EntityName) narrows a polymorphic lookup (Customer/Owner/Regarding) to a specific table. In TS: emit a type guard like `(ref?._lookupLogicalName === "<entity>") ? (ref as <Entity>) : null`, then access fields on the narrowed value. Do NOT use a bare `as` cast — preserve the runtime check.',
    };
  }
  if (RE_ERROR_HANDLING.test(f)) {
    return {
      kind: 'error-handling',
      expression: formula,
      hint: 'IfError(value, fallback [, fallback2, ...]) → wrap each `value` in try/catch returning the next fallback. IsError(x) → boolean test (use React Query `isError` for hook-backed values; for sync expressions, `try { x; return false } catch { return true }`). Error({...}) → `throw new Error(...)`.',
    };
  }
  if (RE_LENGTH_CALL.test(f)) {
    return {
      kind: 'length',
      expression: formula,
      hint: 'Len(s) → `s?.length ?? 0`. Power Fx treats Blank() as 0; bare `s.length` would throw on null/undefined.',
    };
  }
  if (RE_PARSE_JSON_CALL.test(f)) {
    return {
      kind: 'parse-json',
      expression: formula,
      hint: "Power Fx ParseJSON(text) returns a Dynamic value; downstream code accesses fields with dot-notation and casts each leaf (`Text()`, `Value()`, `DateTimeValue()`). In JS: `JSON.parse(text)` inside a try/catch returning `null` on parse failure (Power Fx returns Blank()). The 2-arg form `ParseJSON(text, Type({...}))` is the typed-cast shape — emit a TS interface from the Type({...}) shape and assert after parse.",
    };
  }
  if (RE_JSON_SERIALIZE_CALL.test(f)) {
    return {
      kind: 'json-serialize',
      expression: formula,
      hint: "Power Fx JSON(value [, format]) → `JSON.stringify(value)`. The `JSONFormat.IndentFour` flag → `JSON.stringify(value, null, 4)`. `JSONFormat.IgnoreBinaryData` / `IncludeBinaryData` only matter for image/file columns — confirm the field is base64-text vs blob URL before passing to a connector.",
    };
  }
  if (RE_REGEX_EXTRACT.test(f)) {
    return {
      kind: 'regex-extract',
      expression: formula,
      hint: "Power Fx Match(text, pattern [, options]) returns the first match record with named groups; MatchAll returns a table. In JS: `text.match(new RegExp(pattern))` or `[...text.matchAll(new RegExp(pattern, 'g'))]`. Power Fx named groups `(?<name>...)` map to `.groups.<name>`. Power Fx Match pattern syntax is .NET-flavored — confirm `\\d`, `(?i)` inline flags, and lookbehind support before assuming JS regex parity.",
    };
  }
  if (RE_TEXT_ENCODE.test(f)) {
    return {
      kind: 'text-encode',
      expression: formula,
      hint: "EncodeUrl(s) → `encodeURIComponent(s)`. EncodeHTML(s) → escape `& < > \" '` (use a small util; do NOT inject raw into JSX — React already escapes interpolated text). PlainText(s) → strip HTML/XML tags (`s.replace(/<[^>]+>/g, '')` for simple cases; use `striptags` for production HTML).",
    };
  }
  if (RE_TEXT_FIND.test(f)) {
    return {
      kind: 'text-find',
      expression: formula,
      hint: "Power Fx Find(needle, text [, start]) returns the 1-INDEXED position (or Blank() if not found). JS `text.indexOf(needle)` is 0-INDEXED and returns -1 on miss. Port: `const i = text.indexOf(needle, (start ?? 1) - 1); return i === -1 ? null : i + 1;`. Case-sensitive in Power Fx.",
    };
  }
  if (RE_SEQUENCE_CALL.test(f)) {
    return {
      kind: 'sequence-table',
      expression: formula,
      hint: "Power Fx Sequence(n [, start [, step]]) returns a single-column table with column `Value`. JS: `Array.from({ length: n }, (_, i) => ({ value: (start ?? 1) + i * (step ?? 1) }))`. Commonly used in galleries to render N placeholders or with ForAll for iteration.",
    };
  }
  if (RE_SPLIT_CALL.test(f)) {
    return {
      kind: 'split-text',
      expression: formula,
      hint: "Split(text, separator) returns a single-column table of substrings. JS: `text.split(separator).map(value => ({ value }))`. Empty `text` returns an empty table in Power Fx — guard with `?? ''` before split.",
    };
  }
  // Anything else — flag as computed so the screen-builder can write a `useMemo`.
  return {
    kind: 'computed',
    expression: formula,
    hint: 'Port to a `useMemo(...)` hook. If the expression references a Dataverse field that could be a calculated column, consider pushing it to the server.',
  };
}

function extractBehaviors(loadedScreens, brief) {
  const actions = [];
  const unmatchedFormulas = [];
  const byIntent = {};
  const byEvent = {};
  const screensWithBehaviors = new Set();
  let sourceEventActionCount = 0;

  function addEventActions({ screenName, controlName, controlPath, controlTemplate, evtName, actionList, sourceFormula }) {
    const hasSourceFormula = typeof sourceFormula === 'string' && stripLeadingEq(sourceFormula).trim() !== '';
    const actionsForEvent = Array.isArray(actionList) ? actionList : [];
    if (actionsForEvent.length === 0) {
      if (hasSourceFormula) {
        const sourceStatements = sourceStatementsForFormula(sourceFormula);
        const statements = sourceStatements.length > 0 ? sourceStatements : [stripLeadingEq(sourceFormula)];
        statements.forEach((sourceStatement, idx) => {
          unmatchedFormulas.push({
            screen: screenName,
            control: controlName,
            controlPath: controlPath || null,
            controlTemplate: controlTemplate || null,
            property: evtName,
            actionIndex: idx,
            sourceFormula: stripLeadingEq(sourceFormula),
            sourceStatement,
            raw: sourceStatement,
            reason: 'event-formula-not-classified',
          });
        });
        byEvent[evtName] = (byEvent[evtName] || 0) + statements.length;
        sourceEventActionCount += statements.length;
        screensWithBehaviors.add(screenName);
      }
      return;
    }

    const sourceStatements = sourceStatementsForFormula(sourceFormula);
    screensWithBehaviors.add(screenName);
    byEvent[evtName] = (byEvent[evtName] || 0) + actionsForEvent.length;
    sourceEventActionCount += actionsForEvent.length;
    actionsForEvent.forEach((a, idx) => {
      let intent = (a && a.intent) || 'action';
      let rescued = null;
      if (intent === 'unknown') {
        rescued = rescueUnknownIntent(a);
        if (rescued) intent = rescued.intent;
      }
      const sourceStatement = a.sourceStatement
        || sourceStatements[a.sourceStatementIndex]
        || sourceStatements[idx]
        || a.raw
        || a.call
        || null;
      byIntent[intent] = (byIntent[intent] || 0) + 1;
      if (intent === 'unknown') {
        unmatchedFormulas.push({
          screen: screenName,
          control: controlName,
          controlPath: controlPath || null,
          controlTemplate: controlTemplate || null,
          property: evtName,
          actionIndex: idx,
          call: a.call || null,
          raw: a.raw || null,
          sourceFormula: hasSourceFormula ? stripLeadingEq(sourceFormula) : null,
          sourceStatement,
          sourceStatementIndex: Number.isInteger(a.sourceStatementIndex) ? a.sourceStatementIndex : null,
          controlFlow: Array.isArray(a.controlFlow) ? a.controlFlow : [],
          reason: 'unclassified-intent',
        });
        return;
      }
      const normalizedAction = {
        screen: screenName,
        control: controlName,
        controlPath: controlPath || null,
        controlTemplate: controlTemplate || null,
        event: evtName,
        actionIndex: idx,
        sourceStatementIndex: Number.isInteger(a.sourceStatementIndex) ? a.sourceStatementIndex : null,
        intent,
        ...(rescued
          ? {
              ...rescued,
              ...(Array.isArray(a.controlFlow) && a.controlFlow.length > 0
                ? { controlFlow: a.controlFlow.map((frame) => ({ ...frame })) }
                : {}),
            }
          : normalizeIntentPayload(a)),
        sourceFormula: hasSourceFormula ? stripLeadingEq(sourceFormula) : null,
        sourceStatement,
        hint: rescued ? rescued.hint : hintForIntent(intent),
      };
      normalizedAction.behaviorId = behaviorId('action', normalizedAction);
      actions.push(normalizedAction);
    });
  }

  const appEvents = [
    ['OnStart', toArray(brief && brief.app && brief.app.onStartIntents), brief && brief.app && brief.app.onStartRaw],
    ['OnError', toArray(brief && brief.app && brief.app.onErrorIntents), brief && brief.app && brief.app.onErrorRaw],
  ];
  for (const [evtName, actionList, sourceFormula] of appEvents) {
    addEventActions({
      screenName: 'App',
      controlName: '__app__',
      controlPath: 'App',
      controlTemplate: 'App',
      evtName,
      actionList,
      sourceFormula,
    });
  }

  for (const screen of loadedScreens) {
    const screenProps = screen.properties || {};
    for (const evtName of eventNamesFrom({}, screenProps)) {
      addEventActions({
        screenName: screen.name,
        controlName: '__screen__',
        controlPath: screen.name,
        controlTemplate: 'Screen',
        evtName,
        actionList: [],
        sourceFormula: screenProps[evtName],
      });
    }
    for (const c of toArray(screen.controls)) {
      const events = c.events || {};
      const props = c.properties || {};
      for (const evtName of eventNamesFrom(events, props)) {
        addEventActions({
          screenName: screen.name,
          controlName: c.name,
          controlPath: c.path || c.name,
          controlTemplate: c.template || null,
          evtName,
          actionList: events[evtName],
          sourceFormula: props[evtName],
        });
      }
    }
  }

  // Property-formula classifiers — visibility, validations, derivations.
  // Walk every control's properties bag (skip events bag — handled above) and
  // classify the formula via small bounded regexes. Anything not matched is
  // pushed into `unmatchedFormulas[]` so a human can review — NEVER silently
  // dropped, NEVER LLM-translated.
  const visibility = [];
  const validations = [];
  const derivations = [];
  for (const screen of loadedScreens) {
    for (const c of toArray(screen.controls)) {
      const props = c.properties || {};
      for (const key of Object.keys(props)) {
        if (isEventPropertyName(key)) continue;
        if (SUPPRESSED_PROPS.has(key)) continue;
        const raw = props[key];
        if (typeof raw !== 'string' || raw.trim().length === 0) continue;
        const formula = stripLeadingEq(raw).trim();
        if (formula === '') continue;

        const ctx = {
          screen: screen.name,
          control: c.name,
          controlPath: c.path || c.name,
          controlTemplate: c.template || null,
          property: key,
          formula,
        };

        if (key === 'Visible' || key === 'DisplayMode') {
          const v = classifyVisibility(formula, key);
          if (v) {
            const entry = { ...ctx, ...v };
            entry.behaviorId = behaviorId('visibility', entry);
            visibility.push(entry);
            continue;
          }
        }
        if (key === 'Required') {
          const v = classifyRequired(formula);
          if (v) {
            const entry = { ...ctx, ...v };
            entry.behaviorId = behaviorId('validation', entry);
            validations.push(entry);
            continue;
          }
        }
        if (key === 'Default' || key === 'Text' || key === 'Items') {
          const v = classifyDerivation(formula, key);
          if (v) {
            const entry = { ...ctx, ...v };
            entry.behaviorId = behaviorId('derivation', entry);
            derivations.push(entry);
            continue;
          }
        }
        // Cross-cutting validators that can appear under any property name
        const vCheck = classifyValidationFormula(formula);
        if (vCheck) {
          const entry = { ...ctx, ...vCheck };
          entry.behaviorId = behaviorId('validation', entry);
          validations.push(entry);
          continue;
        }

        // Only push to unmatchedFormulas[] if the property is one we wanted
        // to classify; ignore noise like Color, Fill, Font, etc. so the list
        // stays signal-heavy.
        if (CLASSIFIABLE_PROPS.has(key)) {
          unmatchedFormulas.push({
            ...ctx,
            reason: 'complex-formula',
          });
        }
      }
    }
  }

  return {
    $schema: 'behaviors-v1',
    stats: {
      totalActions: actions.length,
      totalUnmatched: unmatchedFormulas.length,
      sourceEventActionCount,
      accountedEventActionCount: actions.length + unmatchedFormulas.filter((f) => f.actionIndex != null && isEventPropertyName(f.property)).length,
      droppedEventActionCount: Math.max(0, sourceEventActionCount - actions.length - unmatchedFormulas.filter((f) => f.actionIndex != null && isEventPropertyName(f.property)).length),
      screensWithBehaviors: screensWithBehaviors.size,
      byIntent,
      byEvent,
      visibility: visibility.length,
      validations: validations.length,
      derivations: derivations.length,
    },
    actions,
    visibility,
    validations,
    derivations,
    unmatchedFormulas,
  };
}

// ---------- Flows (Power Automate cloud-flow inventory) ----------
//
// Combines `brief.dataModel.flows[]` (declared) with the union of per-screen
// `flowsCalled[]` arrays (consumed), then emits ready-to-run CLI commands
// for target-environment resolution. Source flow/workflow GUIDs are redacted:
// like connection IDs, they are environment-bound and must be looked up with
// `npx power-apps list-flows --json` in the selected target environment.

function extractFlows(brief, loadedScreens) {
  const declared = toArray(brief && brief.dataModel && brief.dataModel.flows);
  const calledMap = {};
  for (const s of loadedScreens) {
    for (const fc of toArray(s.flowsCalled)) {
      const key = typeof fc === 'string' ? fc : (fc && fc.name) || String(fc);
      if (!key) continue;
      if (!calledMap[key]) calledMap[key] = new Set();
      calledMap[key].add(s.name);
    }
  }

  const flows = declared.map((f) => ({
    name: (f && f.name) || '(unnamed)',
    flowId: null,
    id: null,
    workflowEntityId: null,
    sourceFlowIdPresent: !!(f && (f.flowId || f.id || f.guid)),
    sourceWorkflowEntityIdPresent: !!(f && f.workflowEntityId),
    apiId: (f && f.apiId) || null,
    displayName: (f && f.displayName) || (f && f.name) || null,
    actions: toArray(f && f.actions).length,
    declaredScreens: toArray(f && f.screens),
    calledFromScreens: [...(calledMap[(f && f.name)] || new Set())].sort(),
  }));

  const declaredNames = new Set(flows.map((f) => f.name));
  for (const name of Object.keys(calledMap)) {
    if (declaredNames.has(name)) continue;
    flows.push({
      name,
      flowId: null,
      id: null,
      workflowEntityId: null,
      sourceFlowIdPresent: false,
      sourceWorkflowEntityIdPresent: false,
      apiId: null,
      displayName: name,
      actions: 0,
      declaredScreens: [],
      calledFromScreens: [...calledMap[name]].sort(),
      notes: 'Referenced by a screen but missing from `brief.dataModel.flows` — look up the GUID via `npx power-apps list-flows --json`.',
    });
  }

  const commands = [];

  const missingIds = flows.filter((f) => !(f.flowId || f.id)).map((f) => f.name);

  let nextSteps;
  if (flows.length === 0) {
    nextSteps = 'No cloud flows in the source app — nothing to wire.';
  } else {
    nextSteps = `Look up target flow IDs for: ${missingIds.join(', ')}. Run \`npx power-apps list-flows --json\` in the selected target environment, confirm by name/solution context, then \`npx power-apps add-flow --flow-id <target-guid> --non-interactive\` for each.`;
  }

  return {
    $schema: 'flows-v1',
    stats: {
      totalFlows: flows.length,
      withId: commands.length,
      missingId: missingIds.length,
    },
    flows,
    commands,
    nextSteps,
  };
}

// ---------- Component reuse catalog ----------
//
// Source of truth is brief.components (definitions). We enrich with instance
// counts from the screen walk so the catalog also surfaces unused / not-yet-
// instantiated components (the brief preserves their definitions for a
// reason: template scaffolding, future use, or upstream-app evolution).

function inlineCode(value, max) {
  const text = truncateInline(stripLeadingEq(value), max)
    .replace(/`/g, "'")
    .replace(/\|/g, '\\|');
  return '`' + text + '`';
}

function bindingCell(bindings, maxItems) {
  const items = toArray(bindings);
  if (items.length === 0) return '—';
  const visible = items.slice(0, maxItems);
  const rendered = visible.map((b) => {
    const name = '`' + String(b.name || '(unnamed)').replace(/`/g, "'") + '`';
    if (b.expression != null && b.expression !== '') return name + '=' + inlineCode(b.expression, 48);
    if (b.actionCount) return name + ` (${b.actionCount} action${b.actionCount === 1 ? '' : 's'})`;
    return name;
  });
  if (items.length > maxItems) rendered.push(`… (+${items.length - maxItems})`);
  return rendered.join('<br>');
}

function componentInstanceBindings(control, componentInfo, screen) {
  const props = control.properties || {};
  const events = control.events || {};
  const inputNames = new Set(toArray(componentInfo.inputs).map((p) => p && p.name).filter(Boolean));
  const outputNames = new Set(toArray(componentInfo.outputs).map((p) => p && p.name).filter(Boolean));
  const eventNames = new Set(toArray(componentInfo.events).map((p) => p && p.name).filter(Boolean));
  const functionNames = new Set(toArray(componentInfo.functions).map((p) => p && p.name).filter(Boolean));
  const actionNames = new Set(toArray(componentInfo.actions).map((p) => p && p.name).filter(Boolean));

  const inputs = [];
  const outputs = [];
  const eventBindings = [];
  const functions = [];
  const actions = [];

  for (const [key, value] of Object.entries(props)) {
    if (SUPPRESSED_PROPS.has(key) && !inputNames.has(key) && !outputNames.has(key) && !eventNames.has(key)) continue;
    const binding = { name: key, expression: value };
    if (inputNames.has(key) || /^prop_/i.test(key)) inputs.push(binding);
    else if (outputNames.has(key) || /^out_|^output_/i.test(key)) outputs.push(binding);
    else if (eventNames.has(key) || isEventPropertyName(key) || /^evt_|^on[A-Z]/.test(key)) eventBindings.push(binding);
    else if (functionNames.has(key)) functions.push(binding);
    else if (actionNames.has(key)) actions.push(binding);
  }

  for (const [key, actionList] of Object.entries(events)) {
    if (!eventNames.has(key) && !isEventPropertyName(key)) continue;
    if (eventBindings.some((b) => b.name === key)) continue;
    eventBindings.push({ name: key, actionCount: toArray(actionList).length });
  }

  const outputReads = [];
  if (outputNames.size > 0) {
    const haystack = JSON.stringify({ properties: screen.properties || {}, controls: screen.controls || [] });
    for (const outputName of outputNames) {
      const re = new RegExp('\\b' + escapeRegExp(control.name) + '\\s*\\.\\s*' + escapeRegExp(outputName) + '\\b');
      if (re.test(haystack)) outputReads.push({ name: outputName });
    }
  }

  return { inputs, outputs, outputReads, events: eventBindings, functions, actions };
}

function collectComponentInstances(screens, brief) {
  const byName = new Map();

  // 1. Seed with every component DEFINITION from brief.components.
  //    Schema-completion pass added: definitionType, description,
  //    accessAppScope, allowCustomization, plus typed inputs / outputs /
  //    events / functions / actions arrays (each item has
  //    {name, kind, dataType, defaultFormula, description}).
  //    Newer briefs may also expose a top-level `componentDefinitions[]`;
  //    we read both so either source works.
  const defs = toArray(brief && brief.componentDefinitions).length > 0
    ? toArray(brief.componentDefinitions)
    : toArray(brief && brief.components);
  for (const def of defs) {
    const name = def && def.name;
    if (!name) continue;
    byName.set(name, {
      guid: def.templateGuid || null,
      screens: new Set(),
      instanceCount: 0,
      type: def.type || 'Component',
      definitionType: def.definitionType || null,
      description: def.description || null,
      accessAppScope: def.accessAppScope === true ? true : (def.accessAppScope === false ? false : null),
      allowCustomization: def.allowCustomization === true ? true : (def.allowCustomization === false ? false : null),
      isPcf: !!def.isPcf,
      controlCount: def.controlCount || 0,
      inputs: toArray(def.inputs),
      outputs: toArray(def.outputs),
      events: toArray(def.events),
      functions: toArray(def.functions),
      actions: toArray(def.actions),
      instances: [],
      definedOnly: true, // flipped to false the moment we see an instance below
    });
  }

  // 2. Walk every screen, count instances, mark not-defined-only when seen.
  for (const sc of screens) {
    for (const c of toArray(sc.controls)) {
      if (!isComponentInstance(c)) continue;
      const name = c.componentName || c.templateName || 'UnnamedComponent';
      if (!byName.has(name)) {
        // Instance on a screen with no matching definition in brief.components.
        // Rare, but surface it so the catalog stays complete.
        byName.set(name, {
          guid: c.componentDefinitionGuid || null,
          screens: new Set(),
          instanceCount: 0,
          type: 'Component',
          definitionType: null,
          description: null,
          accessAppScope: null,
          allowCustomization: null,
          isPcf: false,
          controlCount: 0,
          inputs: [],
          outputs: [],
          events: [],
          functions: [],
          actions: [],
          instances: [],
          definedOnly: false,
        });
      }
      const entry = byName.get(name);
      if (!entry.guid && c.componentDefinitionGuid) entry.guid = c.componentDefinitionGuid;
      entry.screens.add(sc.name);
      entry.instanceCount += 1;
      entry.instances.push({
        screen: sc.name,
        name: c.name,
        path: c.path || c.name,
        bindings: componentInstanceBindings(c, entry, sc),
      });
      entry.definedOnly = false;
    }
  }

  return [...byName.entries()]
    .map(([name, info]) => ({
      name,
      guid: info.guid,
      screens: [...info.screens].sort(),
      instanceCount: info.instanceCount,
      type: info.type,
      definitionType: info.definitionType,
      description: info.description,
      accessAppScope: info.accessAppScope,
      allowCustomization: info.allowCustomization,
      isPcf: info.isPcf,
      controlCount: info.controlCount,
      inputs: info.inputs,
      outputs: info.outputs,
      events: info.events,
      functions: info.functions,
      actions: info.actions,
      instances: info.instances,
      definedOnly: info.definedOnly,
    }))
    .sort((a, b) => b.instanceCount - a.instanceCount || a.name.localeCompare(b.name));
}

// ---------- Per-screen rendering ----------

function controlTreeLine(c, screenName, controlSwaps) {
  const depth = indentDepth(c.path, screenName);
  const indent = '  '.repeat(depth);
  const label = shortName(c.path, c.name);
  const kind = c.kind || '?';
  const comp = isComponentInstance(c) ? ` ⟨component: ${c.componentName || c.templateName}⟩` : '';
  const role = isInteractive(c) ? ' ◆' : '';
  let descriptor = '';
  if (c.kind === 'Label') {
    const txt = c.properties && c.properties.Text;
    if (txt) descriptor = ` — text: ${truncateInline(stripLeadingEq(txt), 80)}`;
  } else if (c.kind === 'Icon') {
    const ic = c.properties && c.properties.Icon;
    if (ic) descriptor = ` — icon: ${truncateInline(stripLeadingEq(ic), 60)}`;
  } else if (c.kind === 'Image') {
    const im = c.properties && c.properties.Image;
    if (im) descriptor = ` — image: ${truncateInline(stripLeadingEq(im), 60)}`;
  }
  // Native-swap inline marker: if this control matches one or more bundled
  // mobile replacements, tag it so the screen-builder sees the swap at the
  // exact control without scrolling back to the ## Native replacements block.
  let swapMarker = '';
  if (controlSwaps && controlSwaps.has(c.path)) {
    const tags = controlSwaps.get(c.path).map((s) => `→ ${shortSwapTag(s)}`);
    swapMarker = ' ' + tags.join(' ');
  }
  return `${indent}- ${label} (${kind})${comp}${role}${descriptor}${swapMarker}`;
}

function truncateInline(value, max) {
  if (value == null) return '';
  const s = String(value).replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

function renderEventBlock(eventName, eventValue, propertyVerbatim) {
  // eventValue is the parsed-intent array from `events`. propertyVerbatim is the
  // raw Power Fx from `properties` (may be a string). Print both: parsed first
  // (compact), verbatim second (source of truth).
  const out = [];
  out.push('');
  out.push(`- **${eventName}**`);
  const intents = Array.isArray(eventValue) ? eventValue : [];
  if (intents.length > 0) {
    out.push('  - Parsed intents:');
    for (const intent of intents) {
      out.push('    - ' + renderIntent(intent));
    }
  }
  if (propertyVerbatim) {
    out.push('  - Source formula (verbatim):');
    out.push('');
    out.push(...pfxBlock(propertyVerbatim, '    '));
  }
  return out;
}

function renderIntent(intent) {
  if (!intent || typeof intent !== 'object') return String(intent);
  const i = intent.intent || 'action';
  const bits = [markdownCode(i)];
  if (i === 'navigate' && intent.target) bits.push(`→ ${intent.target}`);
  if (i === 'patch' && (intent.source || intent.target)) bits.push(`(${intent.source || intent.target})`);
  if ((i === 'clearCollect' || i === 'collect' || i === 'clear' || i === 'removeIf') && intent.collection) bits.push(`(${intent.collection})`);
  if (i === 'setVar' && intent.name) bits.push(`${intent.name} =`);
  if (i === 'setContext' && intent.context) {
    const keys = Object.keys(intent.context);
    bits.push(`(${keys.join(', ')})`);
  }
  if (i === 'submitForm' && (intent.form || intent.target)) bits.push(`(${intent.form || intent.target})`);
  // New verbs surfaced by the og-script update: exitApp / clearOfflineData /
  // showHostInfo / requestHide. Each maps to a native-target capability the
  // screen-builder needs to wire up; we annotate inline so the plan reader
  // sees the implication without consulting a separate table.
  if (i === 'exitApp') bits.push('— quit the app (native `Exit()`; web → window.close fallback)');
  if (i === 'clearOfflineData') {
    if (intent.collection) bits.push(`(${intent.collection})`);
    bits.push('— source requested local persisted-cache clearing; do not conflate this with a Dataverse Mobile Offline Profile');
  }
  if (i === 'showHostInfo') bits.push('— open native host-info dialog (PowerAppsNativeHost)');
  if (i === 'requestHide') bits.push('— send app to background (native only)');
  if (intent.expression) bits.push(markdownCode(truncateInline(intent.expression, 100)));
  if (intent.from) bits.push(`from ${markdownCode(truncateInline(intent.from, 100))}`);
  return bits.join(' ');
}

function renderControlDetail(c, screenName) {
  // Full per-control subsection. Used for interactive controls and for ANY
  // control with events. Cosmetic controls without events get only the
  // one-liner in the tree.
  const out = [];
  const label = shortName(c.path, c.name);
  out.push('');
  out.push(`##### ${label} \`(${c.kind})\``);
  out.push('');
  out.push('| Attribute | Value |');
  out.push('|---|---|');
  out.push(`| Path | \`${c.path}\` |`);
  out.push(`| Parent | \`${c.parent || '—'}\` |`);
  out.push(`| Template | \`${c.template || '—'}\` |`);
  if (c.variant) out.push(`| Variant | \`${c.variant}\` |`);
  if (isComponentInstance(c)) out.push(`| Component | \`${c.componentName || c.templateName}\` (GUID \`${c.componentDefinitionGuid || '?'}\`) |`);
  // Schema-completion pass: surface the 5 optional control-level fields when
  // present. metadataKey is the rename-stable canonical identity key the
  // screen-builder should prefer for cross-version diffs (form field name,
  // etc.); componentLibraryUniqueName flags an external canvas-component lib
  // dependency the screen-builder must reconcile against `app.componentLibraries`.
  if (c.metadataKey) out.push(`| Metadata key | \`${c.metadataKey}\` |`);
  if (c.componentLibraryUniqueName) out.push(`| Library | \`${c.componentLibraryUniqueName}\` (external canvas-component library) |`);
  if (c.layout) out.push(`| Layout | \`${c.layout}\` |`);
  if (c.group) out.push(`| Group | \`${c.group}\` |`);
  if (c.isLocked === true) out.push('| Authoring locked | yes |');
  if (c.isPcf) out.push('| PCF | yes |');
  if (c.isDataControl) out.push('| Data control | yes |');
  if (c.isAutoGeneratedFormCard) out.push('| Auto-gen form card | yes |');

  // Non-default properties (excluding events; events go below).
  const props = c.properties || {};
  const propKeys = Object.keys(props)
    .filter((k) => !isEventPropertyName(k))
    .filter((k) => !SUPPRESSED_PROPS.has(k))
    .sort();
  if (propKeys.length > 0) {
    out.push('');
    out.push('**Properties:**');
    out.push('');
    for (const key of propKeys) {
      const raw = props[key];
      const text = normalizePfxText(raw);
      if (text.length < 80 && !text.includes('\n') && !text.includes('`')) {
        out.push(`- \`${key}\`: \`${text}\``);
      } else {
        out.push(`- \`${key}\`:`);
        out.push('');
        out.push(...pfxBlock(raw, '  '));
        out.push('');
      }
    }
  }

  // Events: print every event the brief recorded (parsed + verbatim).
  const events = c.events || {};
  const eventKeysPresent = EVENT_NAMES.filter((k) => Array.isArray(events[k]) && events[k].length > 0)
    .concat(EVENT_NAMES.filter((k) => props[k] && (!Array.isArray(events[k]) || events[k].length === 0)));
  const seen = new Set();
  for (const evtName of eventKeysPresent) {
    if (seen.has(evtName)) continue;
    seen.add(evtName);
    out.push(...renderEventBlock(evtName, events[evtName], props[evtName]));
  }

  return out;
}

// ---------- Native-swap catalog ----------
//
// Canvas Power Apps controls have natural mobile equivalents in (a) Tamagui
// primitives, (b) bundled Expo modules, and (c) the small set of pure-JS / RN
// libraries already in template/package.json. The catalog below tells the
// screen-builder, per matched Canvas pattern, exactly which bundled library to
// use, what to keep from the source brief, and what scaffolding to drop.
//
// Hard rules:
// - Each swap's `lib` MUST be a key already present in template/package.json
//   (validated at runtime by validateSwapsAgainstTemplate). If a Canvas pattern
//   has no bundled equivalent, `lib` is the empty string and the entry emits a
//   `[medium]` risk + handoff to /add-native (e.g. pen/signature, push).
// - Native-code RN libraries that are NOT bundled (react-native-pdf,
//   react-native-webview, @shopify/flash-list, @gorhom/bottom-sheet,
//   react-native-paper) MUST NEVER appear here — the rewrap binary can't load
//   new native modules.

function formulaIncludes(value, needle) {
  if (value == null) return false;
  return String(value).includes(needle);
}

function controlHasFormulaContaining(c, needle) {
  const props = (c && c.properties) || {};
  for (const k of Object.keys(props)) {
    if (formulaIncludes(props[k], needle)) return true;
  }
  return false;
}

function screenHasFormulaContaining(screen, needle) {
  const props = (screen && screen.properties) || {};
  for (const k of Object.keys(props)) {
    if (formulaIncludes(props[k], needle)) return true;
  }
  for (const c of toArray(screen && screen.controls)) {
    if (controlHasFormulaContaining(c, needle)) return true;
  }
  return false;
}

function screenCapabilityIncludes(screen, cap) {
  return toArray(screen && screen.nativeCapabilities).includes(cap);
}

const NATIVE_SWAPS = [
  {
    id: 'calendar',
    label: 'Calendar grid',
    lib: 'react-native-calendars',
    component: '<Calendar> / <Agenda> / <Timeline>',
    detectScreen: (s) => /Calendar/i.test((s && s.name) || ''),
    keep: [
      'Items / data bindings (map to `markedDates` / `items`)',
      'Filter ComboBoxes (render as chip row above the calendar)',
      'Day / event tap intents (move into `onDayPress` / `onEventPress`)',
      'Source create/edit actions (keep as explicit calendar actions)',
      'Shared app chrome that carries real workflow state',
    ],
    drop: [
      'Day-cell GroupContainer / Rectangle / Image scaffolding',
      'Per-day Button tap-target controls',
      'Per-event repeating Gallery rows',
    ],
    notes: 'Single-resource schedules usually map to `<Agenda>`. Multi-resource schedules need a reviewed timeline/list composition because no generic multi-resource view ships out of the box.',
  },
  {
    id: 'datepicker',
    label: 'Date / time picker',
    lib: '@react-native-community/datetimepicker',
    component: '<DateTimePicker>',
    detectControl: (c) => c.kind === 'DatePicker',
    keep: ['Default value formula', 'OnChange intents'],
    drop: ['Canvas DatePicker chrome / placeholder styling'],
  },
  {
    id: 'barcode',
    label: 'Barcode / QR scanner',
    lib: 'expo-camera',
    component: '<CameraView barcodeScannerSettings={...}>',
    detectControl: (c) => c.kind === 'BarcodeReader',
    detectScreen: (s) => screenCapabilityIncludes(s, 'barcode'),
    keep: ['OnScan parsed intents (decode → patch record)'],
    drop: ['Custom scan-result preview Gallery (overlay live result instead)'],
  },
  {
    id: 'camera-capture',
    label: 'Camera photo capture',
    lib: 'expo-camera',
    component: '<CameraView>',
    detectScreen: (s) => screenCapabilityIncludes(s, 'camera'),
    detectControl: (c) => controlHasFormulaContaining(c, 'Camera.Stream') || controlHasFormulaContaining(c, 'Camera.Photo'),
    keep: ['Captured photo → Patch into Dataverse Image / File column'],
    drop: ['Hand-built capture overlay'],
    notes: 'Use `/add-native camera` for the approved take-photo / barcode / scan-document flow.',
  },
  {
    id: 'image-picker',
    label: 'Pick image from library',
    lib: 'expo-image-picker',
    component: 'launchImageLibraryAsync',
    detectScreen: (s) => screenCapabilityIncludes(s, 'gallery'),
    detectControl: (c) => controlHasFormulaContaining(c, 'ImageCapture') || controlHasFormulaContaining(c, 'ChooseImage'),
    keep: ['Selected asset → Patch into Dataverse File column'],
    drop: ['Custom thumbnail grid scaffolding'],
  },
  {
    id: 'pdf-view',
    label: 'PDF display',
    lib: 'expo-web-browser',
    component: 'openBrowserAsync(url)',
    detectControl: (c) => c.kind === 'PDFViewer',
    detectScreen: (s) => screenCapabilityIncludes(s, 'pdf'),
    keep: ['Document URL formula → resolved Dataverse File URL → `openBrowserAsync`'],
    drop: ['Custom zoom / page-navigation controls'],
    notes: '`react-native-pdf` is NOT bundled. For inline rendering inside the app shell, fall back to opening externally.',
  },
  {
    id: 'pdf-generate',
    label: 'PDF generation',
    lib: 'expo-print',
    component: 'printToFileAsync',
    detectControl: (c) => controlHasFormulaContaining(c, 'Print(') || controlHasFormulaContaining(c, 'PDF('),
    keep: ['HTML template / record fields used in the PDF'],
    drop: ['Canvas `Print()` invocation pattern'],
  },
  {
    id: 'webview',
    label: 'Embedded web content / HTML viewer',
    lib: 'expo-web-browser',
    component: 'openBrowserAsync(url)',
    detectControl: (c) => c.kind === 'HtmlViewer',
    detectScreen: (s) => screenCapabilityIncludes(s, 'webview'),
    keep: ['Source URL / HTML formula'],
    drop: ['Wrapping Canvas container chrome'],
    notes: '`react-native-webview` is NOT bundled. For trusted inline HTML snippets, render as `<Text>` after stripping tags. For untrusted/full pages, open externally.',
  },
  {
    id: 'attachment',
    label: 'Attachment / file picker',
    lib: 'expo-document-picker',
    component: 'getDocumentAsync + expo-file-system',
    detectScreen: (s) => screenCapabilityIncludes(s, 'attachment'),
    detectControl: (c) => /attachment/i.test(c.kind || '') || /attachment/i.test(c.name || ''),
    keep: [
      // PUBLISHER_PREFIX is set by setBriefContext() before this list is consumed.
      'Patch target column (' + (PUBLISHER_PREFIX || '<prefix>') + '_*attachment / activitymimeattachment / Note)',
    ],
    drop: ['Hand-built attachment thumbnail Gallery'],
  },
  {
    id: 'toggle',
    label: 'Toggle',
    lib: 'tamagui',
    component: '<Switch>',
    detectControl: (c) => c.kind === 'Toggle',
    keep: ['OnCheck / OnUncheck → state writes'],
    drop: ['Custom toggle visuals'],
    notes: 'Tamagui Switch is themed by brand tokens automatically.',
  },
  {
    id: 'checkbox',
    label: 'Checkbox',
    lib: 'expo-checkbox',
    component: '<Checkbox>',
    detectControl: (c) => c.kind === 'CheckBox',
    keep: ['OnCheck / OnUncheck → state writes'],
    drop: ['Classic Canvas check chrome'],
  },
  {
    id: 'combobox',
    label: 'Long ComboBox / DropDown',
    lib: 'tamagui',
    component: '<Sheet> + <FlatList>',
    detectControl: (c) =>
      (c.kind === 'ComboBox' || c.kind === 'DropDown') &&
      controlHasFormulaContaining(c, "'"), // Items referencing a single-quoted entity name
    keep: ['Items / Filter formula (becomes data source)', 'OnChange intents'],
    drop: ['Inline dropdown chrome'],
    notes: '`@gorhom/bottom-sheet` is NOT bundled — use Tamagui `<Sheet>` for the picker surface.',
  },
  {
    id: 'gallery-long',
    label: 'Long Gallery / list',
    lib: 'react-native',
    component: '<FlatList> / <SectionList>',
    detectControl: (c) => c.kind === 'Gallery',
    keep: ['Items formula → `data` prop', 'Per-item template → `renderItem`'],
    drop: ['Deeply-nested item GroupContainer scaffolding'],
    notes: '`@shopify/flash-list` is NOT bundled — use RN built-in. Apply `keyExtractor`, `getItemLayout` (uniform rows), and `windowSize` for performance.',
  },
  {
    id: 'form',
    label: 'Form / TypedDataCard',
    lib: 'react-hook-form',
    component: 'useForm + Tamagui inputs + zod',
    detectControl: (c) => c.kind === 'Form' || c.isAutoGeneratedFormCard === true,
    keep: [
      'Field definitions and bound Dataverse columns',
      'Required / validation rules → zod schema',
      'OnSuccess / OnFailure intents',
    ],
    drop: ['DataCard scaffolding (each card → one controlled field, not a wrapper)'],
    notes: '`react-hook-form` + `zod` are both bundled. Render fields as Tamagui `<Input>`/`<Select>`/`<Switch>` + `<DateTimePicker>`.',
  },
  {
    id: 'toast',
    label: 'In-app toast / Notify()',
    lib: 'burnt',
    component: 'Toast.show',
    detectControl: (c) => controlHasFormulaContaining(c, 'Notify('),
    detectScreen: (s) => screenHasFormulaContaining(s, 'Notify('),
    keep: ['`Notify` message + severity → `Toast.show({ title, preset })`'],
    drop: ['Canvas Notification banner control'],
    notes: '`burnt` renders native iOS/Android toasts. Also acceptable: `@tamagui/toast` (also bundled).',
  },
  {
    id: 'biometric',
    label: 'Biometric prompt',
    lib: 'expo-local-authentication',
    component: 'authenticateAsync',
    detectScreen: (s) => screenCapabilityIncludes(s, 'biometrics'),
    detectControl: (c) => controlHasFormulaContaining(c, 'LocalAuth') || controlHasFormulaContaining(c, 'Biometric'),
    keep: ['Trigger event (button OnSelect)'],
    drop: ['Hand-built PIN/passcode UI'],
  },
  {
    id: 'local-persistence',
    label: 'Canvas local collection persistence',
    lib: 'expo-file-system',
    component: 'approved JSON file-system wrapper',
    detectControl: (c) => controlHasFormulaContaining(c, 'SaveData(') || controlHasFormulaContaining(c, 'LoadData('),
    keep: ['`SaveData` / `LoadData` key, serialized collection value, and missing-data fallback'],
    drop: ['Canvas implicit local-cache assumption'],
    notes: 'Use `/add-native file-system` semantics for app-owned JSON collections. `expo-secure-store` is only for a separately reviewed small sensitive scalar, not arbitrary Canvas collections or server data.',
  },
  {
    id: 'share',
    label: 'Share sheet',
    lib: 'expo-sharing',
    component: 'shareAsync',
    detectControl: (c) => controlHasFormulaContaining(c, 'Launch(') || controlHasFormulaContaining(c, 'Share('),
    keep: ['Shared file / URL / text'],
    drop: ['Custom share-target UI'],
  },
  {
    id: 'mail',
    label: 'Send mail through Power Platform',
    lib: '@microsoft/power-apps',
    component: 'generated Office 365 Outlook connector service',
    detectControl: (c) =>
      controlHasFormulaContaining(c, 'Office365.SendEmail') ||
      controlHasFormulaContaining(c, 'SendEmailV2') ||
      controlHasFormulaContaining(c, 'EmailUser'),
    keep: ['To / subject / body fields'],
    drop: [],
    notes: 'Preserve connector-first behavior and generated-service authentication/auditing. Use expo-mail-composer only when the source explicitly opens an interactive device compose flow rather than calling SendEmail/SendEmailV2.',
  },
  {
    id: 'audio',
    label: 'Audio playback',
    lib: 'expo-audio',
    component: 'useAudioPlayer',
    detectControl: (c) => c.kind === 'Audio' || controlHasFormulaContaining(c, 'Sound.'),
    keep: ['Source URL / asset'],
    drop: ['Canvas Audio control chrome'],
  },
  {
    id: 'video',
    label: 'Video playback',
    lib: 'expo-video',
    component: 'useVideoPlayer + <VideoView>',
    detectControl: (c) => c.kind === 'Video',
    keep: ['Source URL / asset'],
    drop: ['Canvas Video control chrome'],
  },
  {
    id: 'gradient',
    label: 'Linear gradient',
    lib: 'expo-linear-gradient',
    component: '<LinearGradient>',
    detectControl: (c) => controlHasFormulaContaining(c, 'Gradient('),
    keep: ['Color stops'],
    drop: ['Per-pixel rectangle stacking'],
  },
  {
    id: 'pen-signature',
    label: 'Pen / signature capture',
    lib: '',
    component: '/add-native pen-input workflow',
    detectControl: (c) => c.kind === 'PenInput',
    detectScreen: (s) => screenCapabilityIncludes(s, 'pen') || screenCapabilityIncludes(s, 'signature'),
    keep: ['Captured ink → Patch into Dataverse Image / File column'],
    drop: ['Canvas PenInput control chrome'],
    notes: 'Use `/add-native pen-input` only when `@microsoft/power-apps-native-pen-input` is present in the current template/app. If absent, this remains a review/blocking item; do not install another native library.',
    risk: {
      severity: 'medium',
      code: 'NO_BUNDLED_PEN_LIB',
      message: 'Signature / pen capture requires the allowlisted native pen package. Route through `/add-native pen-input` when present; otherwise review/block.',
    },
  },
  {
    id: 'push',
    label: 'Push notifications',
    lib: '',
    component: 'in-app toast via burnt',
    detectScreen: (s) => screenCapabilityIncludes(s, 'notification') || screenCapabilityIncludes(s, 'push'),
    detectControl: (c) => controlHasFormulaContaining(c, 'PushNotification'),
    keep: ['Trigger condition (what event fires the notification)'],
    drop: ['Background OS notification expectation'],
    notes: '`expo-notifications` is NOT supported in the Power Apps rewrap runtime. Use `burnt` to surface an in-app toast while the app is open. Cross-device push requires server-side workflow + Power Automate.',
    risk: {
      severity: 'medium',
      code: 'NO_PUSH_NOTIFICATIONS',
      message: 'Source app expects push notifications but the rewrap runtime does not load `expo-notifications`. Use Power Automate + in-app toast as the workaround.',
    },
  },
];

// ---------- Canvas anti-pattern catalog (intent over control) ----------
//
// Canvas Power Apps controls are *evidence of maker intent*, not a binding
// output spec. The screen-builder should pick the best native primitive for
// the underlying intent — see `shared/references/canvas-to-native-mapping.md`
// for the full translation hierarchy.
//
// This catalog detects known Canvas anti-patterns where the maker reached for
// a Canvas workaround (HTML control, pixel positioning, stacked-Labels-as-list
// …) because Canvas lacked a better primitive. On native React Native we *do*
// have better primitives, so the screen-builder should UPGRADE the control.
//
// Entries here complement NATIVE_SWAPS:
//   - NATIVE_SWAPS    → "what library replaces this control 1:1"
//   - CANVAS_ANTIPATTERNS → "this control is a maker workaround — UPGRADE the intent"
//
// Detector contract:
//   detectControl?(c, screen) → boolean — flags one specific control
//   detectScreen?(screen)     → boolean — flags screen-level pattern
//   collectControls?(screen)  → string[] — list of control labels matched
//                               (for the per-screen render). If absent we
//                               fall back to scanning controls with
//                               detectControl when present.
//
// Severity gradient: `low` → cosmetic / nice-to-fix; `medium` → behavioral or
// fidelity loss without the upgrade; `high` → screen won't function without
// upgrade (we have none of these today; webview is medium because it
// degrades gracefully to text-only).

const CANVAS_ANTIPATTERNS = [
  {
    id: 'html-preview',
    label: 'HTML preview / WebView',
    severity: 'medium',
    detectControl: (c) => c.kind === 'HtmlViewer' || c.kind === 'WebView',
    rationale: '`react-native-webview` is NOT bundled in the template (rewrap binary is prebuilt). Canvas HTML was a maker shortcut for mixed-formatting text / styled tables / email-template previews — all of which have better native primitives.',
    recommendedNative: 'Pick by the underlying intent: (1) **Styled summary block** → Tamagui `<Card>` with `<H3>` / `<Paragraph>` / themed `<Text>` segments. (2) **Receipt / invoice** → Tamagui card with `<XStack>` per line item + `expo-print.printToFileAsync({html})` → `expo-sharing.shareAsync(uri)` or Dataverse upload. (3) **Email-template preview** → Tamagui mock; optionally generate a local PDF for share/upload, but do not pass its `file://` URI to a browser/native HTTPS viewer. (4) **External URL** → `expo-web-browser.openBrowserAsync(url)` after HTTPS validation (opens system browser; does NOT inline).',
    reference: 'shared/references/canvas-to-native-mapping.md#3-the-html-escape-hatch-problem-most-common-upgrade-case',
  },
  {
    id: 'pdf-viewer-control',
    label: 'Inline PDF Viewer control',
    severity: 'medium',
    detectControl: (c) => c.kind === 'PDFViewer',
    rationale: '`react-native-pdf` is NOT bundled. Native PDF flow splits generate / view / save across separate bundled modules — better integration with the OS.',
    recommendedNative: '**Generate** with `expo-print.printToFileAsync({ html })`, then share the local URI with `expo-sharing.shareAsync(uri)` when available or upload it to Dataverse File storage. **View existing** PDFs only through a validated HTTPS URL: use the allowlisted Power Apps native PDF viewer when present, otherwise `expo-web-browser`. Never pass `file://`, `content://`, or `blob:` URIs to the HTTPS viewer path.',
    reference: 'shared/references/canvas-to-native-mapping.md#2-the-translation-hierarchy',
  },
  {
    id: 'rich-text-input',
    label: 'Rich-text editor input',
    severity: 'medium',
    detectControl: (c) => c.kind === 'RichTextEditor',
    rationale: 'No bundled rich-text RN library. The Dataverse column behind a `RichTextEditor` usually stores HTML; round-trip editing is impractical without a webview-based editor.',
    recommendedNative: 'For **display-only** fields: strip HTML and render as `<Paragraph>`. For **editable** fields: render Tamagui `<TextArea>` and accept plain text on save. If the field MUST stay rich-text, surface this to the user and recommend renegotiating the column to markdown or plain text — note as a [medium] risk in the screen plan.',
    reference: 'shared/references/canvas-to-native-mapping.md#2-the-translation-hierarchy',
  },
  {
    id: 'pixel-positioning',
    label: 'Pixel-positioned controls (absolute X/Y)',
    severity: 'low',
    detectScreen: (s) => {
      const controls = toArray(s.controls);
      let pixelPositioned = 0;
      for (const c of controls) {
        const props = (c && c.properties) || {};
        // X/Y set to a non-zero numeric literal counts as absolute positioning.
        // We tolerate token references (`=Parent.Width - 16`) because those
        // are responsive. ≥5 absolutely-placed controls → maker built a
        // pixel-perfect layout, doesn't translate to variable phone widths.
        const xRaw = props.X != null ? String(props.X).replace(/^=/, '').trim() : '';
        const yRaw = props.Y != null ? String(props.Y).replace(/^=/, '').trim() : '';
        const xLit = /^-?\d+(?:\.\d+)?$/.test(xRaw) && Number(xRaw) !== 0;
        const yLit = /^-?\d+(?:\.\d+)?$/.test(yRaw) && Number(yRaw) !== 0;
        if (xLit || yLit) pixelPositioned += 1;
        if (pixelPositioned >= 5) return true;
      }
      return false;
    },
    collectControls: (s) => {
      const controls = toArray(s.controls);
      const out = [];
      for (const c of controls) {
        const props = (c && c.properties) || {};
        const xRaw = props.X != null ? String(props.X).replace(/^=/, '').trim() : '';
        const yRaw = props.Y != null ? String(props.Y).replace(/^=/, '').trim() : '';
        const xLit = /^-?\d+(?:\.\d+)?$/.test(xRaw) && Number(xRaw) !== 0;
        const yLit = /^-?\d+(?:\.\d+)?$/.test(yRaw) && Number(yRaw) !== 0;
        if (xLit || yLit) out.push(shortName(c.path, c.name));
      }
      return out.slice(0, 12);
    },
    rationale: 'Canvas controls placed by absolute X/Y do not adapt to phone-width variation (small/large iPhone, Android density). Native React Native screens MUST use flex/stack composition with token spacing.',
    recommendedNative: 'Wrap groups in Tamagui `<YStack>` / `<XStack>` with token-based `gap="$3"` / `gap="$4"`. Use `flex={1}` or percentage widths; never hardcoded px X/Y/Width/Height. Anchor right-aligned actions with `<XStack justifyContent="flex-end">` or `marginLeft="auto"`, not `X=Parent.Width - 64`.',
    reference: 'shared/references/mobile-design-philosophy.md#2-spatial-rhythm-4px-grid',
  },
  {
    id: 'stacked-labels-as-list',
    label: 'Stacked Labels mimicking a list/table (≥15 Labels, no Gallery)',
    severity: 'low',
    detectScreen: (s) => {
      const controls = toArray(s.controls);
      const labelCount = controls.filter((c) => c && c.kind === 'Label').length;
      const hasGallery = controls.some((c) => c && c.kind === 'Gallery');
      return labelCount >= 15 && !hasGallery;
    },
    rationale: 'When makers stack ≥15 `Label` controls in one container without a `Gallery`, they are usually mimicking a list/table by hand because `Gallery` had constraints they hit. Native screens compose lists with `FlatList` (virtualized) or `<YStack>` of repeating row components.',
    recommendedNative: 'If the labels render the **same shape repeated across rows** → use RN `<FlatList>` with a `renderItem` returning a Tamagui `<XStack>` row. If they are **labelled key/value pairs of a single record** → use `<YStack>` of `<XStack justifyContent="space-between"><Text col="$color10">{label}</Text><Text>{value}</Text></XStack>`.',
    reference: 'shared/references/canvas-to-native-mapping.md#4-the-rule-of-thumb',
  },
];

function detectUpgradeHintsForScreen(screen) {
  // Returns Array<{ id, label, severity, canvasControls, rationale, recommendedNative, reference }>
  // for every anti-pattern matched in the screen. Empty array if none match.
  const hints = [];
  for (const ap of CANVAS_ANTIPATTERNS) {
    let matched = false;
    if (typeof ap.detectScreen === 'function') {
      try { if (ap.detectScreen(screen)) matched = true; } catch (_err) { /* noop */ }
    }
    const controlsMatched = [];
    if (typeof ap.detectControl === 'function') {
      for (const c of toArray(screen && screen.controls)) {
        try {
          if (ap.detectControl(c, screen)) {
            matched = true;
            controlsMatched.push(shortName(c.path, c.name));
          }
        } catch (_err) { /* noop */ }
      }
    }
    if (!matched) continue;
    let canvasControls = controlsMatched;
    if (canvasControls.length === 0 && typeof ap.collectControls === 'function') {
      try { canvasControls = toArray(ap.collectControls(screen)); } catch (_err) { canvasControls = []; }
    }
    hints.push({
      id: ap.id,
      label: ap.label,
      severity: ap.severity,
      canvasControls,
      rationale: ap.rationale,
      recommendedNative: ap.recommendedNative,
      reference: ap.reference,
    });
  }
  return hints;
}

function aggregateUpgradeHintsAcrossScreens(loadedScreens) {
  // Returns Array<{ id, label, severity, screens: string[], totalControls: number }>
  // — one row per anti-pattern, listing every screen where it appears.
  const byId = new Map();
  for (const screen of toArray(loadedScreens)) {
    const hints = detectUpgradeHintsForScreen(screen);
    for (const h of hints) {
      const existing = byId.get(h.id);
      if (existing) {
        if (!existing.screens.includes(screen.name)) existing.screens.push(screen.name);
        existing.totalControls += toArray(h.canvasControls).length;
      } else {
        byId.set(h.id, {
          id: h.id,
          label: h.label,
          severity: h.severity,
          rationale: h.rationale,
          recommendedNative: h.recommendedNative,
          reference: h.reference,
          screens: [screen.name],
          totalControls: toArray(h.canvasControls).length,
        });
      }
    }
  }
  // Preserve catalog order, then severity (medium first), then screen count desc.
  const order = new Map(CANVAS_ANTIPATTERNS.map((a, i) => [a.id, i]));
  return Array.from(byId.values()).sort(
    (a, b) => (order.get(a.id) || 0) - (order.get(b.id) || 0)
  );
}

function buildUpgradeHintsLines(screen) {
  const hints = detectUpgradeHintsForScreen(screen);
  if (!hints.length) return [];
  const lines = [];
  lines.push('## Upgrade Hints');
  lines.push('');
  lines.push('> **Intent over control.** The Canvas controls below are *evidence of maker intent*, not a binding output spec. The screen-builder MUST replace these with the recommended native primitive — see [`shared/references/canvas-to-native-mapping.md`](../../../../shared/references/canvas-to-native-mapping.md) §1–§4 for the principle and §7 for the decision flow. To override a hint, add an inline `// UPGRADE-OVERRIDE: <reason>` comment above the relevant TSX block.');
  lines.push('');
  lines.push('| # | Anti-pattern | Severity | Canvas controls matched | Reference |');
  lines.push('|---|---|---|---|---|');
  hints.forEach((h, i) => {
    const ctrls = toArray(h.canvasControls);
    const ctrlCell = ctrls.length === 0
      ? '_screen-level pattern_'
      : (ctrls.length > 4
        ? ctrls.slice(0, 4).map((n) => '`' + n + '`').join(', ') + `, … (+${ctrls.length - 4})`
        : ctrls.map((n) => '`' + n + '`').join(', '));
    lines.push(`| ${i + 1} | ${h.label} | \`${h.severity}\` | ${ctrlCell} | [\`${h.id}\`](../../../../${h.reference}) |`);
  });
  lines.push('');
  for (const h of hints) {
    lines.push(`### ${h.label}`);
    lines.push('');
    lines.push(`- **Severity:** \`${h.severity}\``);
    if (toArray(h.canvasControls).length > 0) {
      const ctrls = h.canvasControls.map((n) => '`' + n + '`').join(', ');
      lines.push(`- **Canvas controls matched:** ${ctrls}`);
    } else {
      lines.push('- **Detection:** screen-level pattern (no individual control id)');
    }
    lines.push(`- **Why upgrade:** ${h.rationale}`);
    lines.push(`- **Recommended native:** ${h.recommendedNative}`);
    lines.push(`- **Reference:** [\`${h.reference}\`](../../../../${h.reference})`);
    lines.push('');
  }
  return lines;
}

function loadTemplatePackageDeps() {
  // Read template/package.json once so we can validate every NATIVE_SWAPS entry
  // references a bundled dependency.
  const repoRoot = path.resolve(__dirname, '..');
  const tplPath = path.join(repoRoot, 'template', 'package.json');
  if (!fs.existsSync(tplPath)) throw new Error(`Bundled template dependency allowlist is missing: ${tplPath}`);
  try {
    const pkg = JSON.parse(fs.readFileSync(tplPath, 'utf8'));
    return new Set(Object.keys({ ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) }));
  } catch (error) {
    throw new Error(`Bundled template dependency allowlist is invalid: ${error.message}`);
  }
}

function validateSwapsAgainstTemplate(bundled) {
  const missing = [];
  for (const swap of NATIVE_SWAPS) {
    if (!swap.lib) continue;
    if (!bundled.has(swap.lib)) missing.push({ id: swap.id, lib: swap.lib });
  }
  return { ok: missing.length === 0, missing };
}

function matchSwapsForScreen(screen) {
  const screenSwaps = [];
  const controlSwaps = new Map(); // path -> Swap[]
  for (const swap of NATIVE_SWAPS) {
    let matched = false;
    if (typeof swap.detectScreen === 'function') {
      try {
        if (swap.detectScreen(screen)) matched = true;
      } catch (_err) { /* noop */ }
    }
    if (typeof swap.detectControl === 'function') {
      for (const c of toArray(screen.controls)) {
        try {
          if (swap.detectControl(c, screen)) {
            matched = true;
            const list = controlSwaps.get(c.path) || [];
            list.push(swap);
            controlSwaps.set(c.path, list);
          }
        } catch (_err) { /* noop */ }
      }
    }
    if (matched) screenSwaps.push(swap);
  }
  return { screenSwaps, controlSwaps };
}

function shortSwapTag(swap) {
  return swap.lib || swap.component;
}

function aggregateSwapsAcrossScreens(loadedScreens) {
  // Returns Array<{ swap, screens: string[] }> for swaps matched somewhere in
  // the app. Used by the master plan's `## Native Control Mapping` table.
  const byId = new Map();
  for (const screen of toArray(loadedScreens)) {
    const { screenSwaps } = matchSwapsForScreen(screen);
    for (const swap of screenSwaps) {
      const existing = byId.get(swap.id);
      if (existing) {
        if (!existing.screens.includes(screen.name)) existing.screens.push(screen.name);
      } else {
        byId.set(swap.id, { swap, screens: [screen.name] });
      }
    }
  }
  // Preserve catalog order for stable output.
  const order = NATIVE_SWAPS.map((s, i) => [s.id, i]);
  const orderMap = new Map(order);
  return Array.from(byId.values()).sort(
    (a, b) => (orderMap.get(a.swap.id) || 0) - (orderMap.get(b.swap.id) || 0)
  );
}

function normalizeKindText(value) {
  return String(value || '').toLowerCase();
}

function controlIntentRole(control) {
  const kind = normalizeKindText(control && control.kind);
  const template = normalizeKindText(control && control.template);
  const pathText = normalizeKindText(control && control.path);
  const combined = `${kind} ${template} ${pathText}`;
  if (control && control.isPcf) return 'custom-control';
  if (isComponentInstance(control)) return 'reusable-component';
  if (combined.includes('attachments')) return 'file-attachments';
  if (combined.includes('timer')) return 'timer-lifecycle';
  if (combined.includes('pdfviewer')) return 'document-preview';
  if (combined.includes('htmlviewer') || combined.includes('richtexteditor')) return 'rich-content';
  if (combined.includes('powerbi')) return 'embedded-report';
  if (combined.includes('viewinmr') || combined.includes('arviewer')) return 'mixed-reality';
  if (combined.includes('peninput')) return 'signature-input';
  if (combined.includes('microphone')) return 'audio-capture';
  if (combined.includes('import') || combined.includes('export')) return 'file-transfer';
  if (combined.includes('video') || combined.includes('audio')) return 'media-playback';
  if (combined.includes('chart') || combined.includes('legend')) return 'chart-visualization';
  if (combined.includes('datatable')) return 'tabular-records';
  if (combined.includes('gallery')) return 'repeating-records';
  if (combined.includes('form')) return 'record-form';
  if (combined.includes('datacard')) return 'form-field-card';
  if (combined.includes('fluidgrid')) return 'responsive-form-layout';
  if (combined.includes('groupcontainer') || combined.includes('container')) return 'layout-container';
  if (combined.includes('barcode')) return 'barcode-input';
  if (combined.includes('camera') || combined.includes('addmedia')) return 'media-capture';
  if (combined.includes('combobox') || combined.includes('dropdown') || combined.includes('radio')) return 'choice-input';
  if (combined.includes('listbox')) return 'choice-input';
  if (combined.includes('rating')) return 'rating-input';
  if (combined.includes('slider')) return 'range-input';
  if (combined.includes('textinput') || combined === 'text') return 'text-input';
  if (combined.includes('datepicker')) return 'date-input';
  if (combined.includes('toggle') || combined.includes('checkbox')) return 'boolean-input';
  if (combined.includes('image')) return 'image-display';
  if (combined.includes('label') || combined.includes('text')) return 'text-display';
  return isInteractive(control) ? 'interactive-control' : 'visual-structure';
}

function nativeSuggestionForRole(role) {
  const map = {
    'file-attachments': 'native attachment/file field',
    'timer-lifecycle': 'native effect/timer lifecycle',
    'repeating-records': 'native list/sectioned list chosen by screen-builder',
    'record-form': 'native form sections with typed validation',
    'form-field-card': 'native field binding inside owning form',
    'responsive-form-layout': 'native responsive section layout',
    'layout-container': 'native grouping/section layout',
    'reusable-component': 'shared React Native component',
    'custom-control': 'known native replacement or unsupported placeholder',
    'document-preview': 'native document preview/open flow or unsupported placeholder',
    'rich-content': 'native rich text/html interpretation chosen by screen-builder',
    'embedded-report': 'unsupported placeholder unless native report strategy exists',
    'mixed-reality': 'unsupported placeholder unless native MR capability exists',
    'signature-input': 'native signature/pen capture',
    'audio-capture': 'native microphone/audio capture',
    'file-transfer': 'native import/export/file flow',
    'media-playback': 'native media playback',
    'chart-visualization': 'native chart/summary visualization chosen by screen-builder',
    'tabular-records': 'native table/list chosen by screen-builder',
    'rating-input': 'native rating input',
    'range-input': 'native range/slider input',
    'barcode-input': 'native barcode input flow',
    'media-capture': 'native media picker/capture flow',
    'choice-input': 'native choice input chosen by screen-builder',
    'text-input': 'native text field',
    'date-input': 'native date input',
    'boolean-input': 'native switch/checkbox chosen by screen-builder',
    'image-display': 'native image/media display',
    'text-display': 'native text display',
  };
  return map[role] || 'screen-builder chooses native primitive';
}

function supportForControlIntent(control, role) {
  if (role === 'custom-control') return 'unsupported-or-custom-native-component';
  if (role === 'embedded-report' || role === 'mixed-reality') return 'unsupported-or-explicit-native-strategy';
  if (role === 'document-preview' || role === 'signature-input' || role === 'audio-capture' || role === 'file-transfer') return 'native-capability-contract-required';
  if (role === 'reusable-component') return 'preserve-contract-regenerate-ui';
  if (role === 'file-attachments' || role === 'timer-lifecycle') return 'behavior-contract-required';
  return 'regenerate-native';
}

function controlBusinessRisk(control, role, mustPreserve) {
  if (role === 'custom-control' || role === 'file-attachments' || role === 'timer-lifecycle') return 'high';
  if (role === 'embedded-report' || role === 'mixed-reality' || role === 'document-preview' || role === 'signature-input' || role === 'audio-capture' || role === 'file-transfer') return 'high';
  if (role === 'rich-content' || role === 'chart-visualization' || role === 'tabular-records' || role === 'media-playback') return 'medium';
  if (isComponentInstance(control) || (control && control.isDataControl)) return 'medium';
  if (mustPreserve.length >= 3) return 'medium';
  return 'low';
}

function eventNamesWithSource(control) {
  const events = (control && control.events) || {};
  const props = (control && control.properties) || {};
  return eventNamesFrom(events, props).filter((eventName) => {
    if (Array.isArray(events[eventName]) && events[eventName].length > 0) return true;
    return typeof props[eventName] === 'string' && stripLeadingEq(props[eventName]).trim() !== '';
  });
}

function controlMustPreserve(control, role, eventNames) {
  const props = (control && control.properties) || {};
  const preserve = [];
  function add(label) {
    if (label && !preserve.includes(label)) preserve.push(label);
  }

  for (const eventName of eventNames) add(`${eventName} behavior`);
  for (const key of ['Items', 'Default', 'DefaultSelectedItems', 'Selected', 'Update', 'Required', 'DisplayMode', 'Visible', 'DataSource', 'Item']) {
    if (props[key] != null && String(props[key]).trim() !== '') add(`${key} binding`);
  }

  if (role === 'file-attachments') {
    add('attachment add/remove/undo intent');
    for (const key of ['Items', 'MaxAttachments', 'MaxAttachmentSize', 'OnAddFile', 'OnRemoveFile', 'OnUndoRemoveFile']) {
      if (props[key] != null || eventNames.includes(key)) add(`${key} contract`);
    }
  }
  if (role === 'timer-lifecycle') {
    add('timer lifecycle intent');
    for (const key of ['Start', 'Reset', 'Repeat', 'AutoStart', 'Duration', 'OnTimerStart', 'OnTimerEnd']) {
      if (props[key] != null || eventNames.includes(key)) add(`${key} contract`);
    }
  }
  if (role === 'repeating-records') {
    add('record iteration intent');
    if (props.Items != null) add('filter/sort/source Items formula');
    if (eventNames.includes('OnSelect')) add('selected record identity');
  }
  if (role === 'record-form') {
    add('record edit/display intent');
    add('submit success/failure behavior when present');
  }
  if (role === 'form-field-card') {
    add('field grouping and validation intent');
  }
  if (role === 'layout-container' || role === 'responsive-form-layout') {
    add('child grouping/layout intent');
  }
  if (role === 'reusable-component') {
    add('component input/output/event contract');
  }
  if (role === 'custom-control') {
    add('custom control capability or explicit unsupported marker');
  }
  if (role === 'document-preview') add('document source/open intent');
  if (role === 'rich-content') add('rich text/html content intent');
  if (role === 'embedded-report') add('report embedding intent or explicit unsupported marker');
  if (role === 'mixed-reality') add('mixed-reality capability or explicit unsupported marker');
  if (role === 'signature-input') add('signature/ink capture value');
  if (role === 'audio-capture') add('microphone capture behavior');
  if (role === 'file-transfer') add('import/export file behavior');
  if (role === 'media-playback') add('media source/playback intent');
  if (role === 'chart-visualization') add('chart data source and grouping intent');
  if (role === 'tabular-records') add('table Items/column intent');
  return preserve;
}

function buildControlIntentCoverage(loadedScreens) {
  const rows = [];
  const byKind = new Map();
  const byRole = new Map();
  const stats = {
    screens: toArray(loadedScreens).length,
    totalControls: 0,
    behavioralControls: 0,
    layoutControls: 0,
    componentInstances: 0,
    pcfControls: 0,
    highRiskControls: 0,
  };

  for (const screen of toArray(loadedScreens)) {
    const { controlSwaps } = matchSwapsForScreen(screen);
    for (const control of toArray(screen.controls)) {
      stats.totalControls += 1;
      const eventNames = eventNamesWithSource(control);
      const role = controlIntentRole(control);
      const mustPreserve = controlMustPreserve(control, role, eventNames);
      const support = supportForControlIntent(control, role);
      const risk = controlBusinessRisk(control, role, mustPreserve);
      const nativeHints = controlSwaps.has(control.path)
        ? controlSwaps.get(control.path).map((swap) => ({
            id: swap.id,
            label: swap.label,
            suggestion: swap.component,
            library: swap.lib || null,
          }))
        : [];

      if (eventNames.length > 0 || mustPreserve.length > 0) stats.behavioralControls += 1;
      if (role === 'layout-container' || role === 'responsive-form-layout' || role === 'repeating-records' || role === 'record-form') stats.layoutControls += 1;
      if (isComponentInstance(control)) stats.componentInstances += 1;
      if (control && control.isPcf) stats.pcfControls += 1;
      if (risk === 'high') stats.highRiskControls += 1;
      byKind.set(control.kind || 'Unknown', (byKind.get(control.kind || 'Unknown') || 0) + 1);
      byRole.set(role, (byRole.get(role) || 0) + 1);

      rows.push({
        screen: screen.name,
        control: control.name || shortName(control.path, control.name),
        path: control.path || null,
        canvasType: control.kind || control.template || 'Unknown',
        template: control.template || null,
        role,
        support,
        businessRisk: risk,
        uiFreedom: 'regenerate-native',
        nativeSuggestion: nativeSuggestionForRole(role),
        nativeHints,
        mustPreserve,
        sourceEvents: eventNames,
        dataBindings: ['Items', 'Default', 'DefaultSelectedItems', 'Update', 'Required', 'DisplayMode', 'Visible', 'DataSource', 'Item']
          .filter((key) => control.properties && control.properties[key] != null),
        layoutIntent: {
          parent: control.parent || null,
          group: control.group || null,
          layout: control.layout || null,
          nestingDepth: indentDepth(control.path, screen.name),
        },
        flags: {
          isComponentInstance: isComponentInstance(control),
          isPcf: !!(control && control.isPcf),
          isDataControl: !!(control && control.isDataControl),
          isAutoGeneratedFormCard: !!(control && control.isAutoGeneratedFormCard),
        },
        notesForAI: 'Preserve mustPreserve semantics and data/event contracts; choose the best native UI for the target app.',
      });
    }
  }

  return {
    $schema: 'control-intent-coverage-v1',
    generatedAt: GENERATION_TIMESTAMP,
    rule: 'Canvas controls are evidence of intent, not target UI. Preserve business/data/event/layout semantics; regenerate native UI.',
    stats: {
      ...stats,
      byKind: Object.fromEntries([...byKind.entries()].sort((a, b) => a[0].localeCompare(b[0]))),
      byRole: Object.fromEntries([...byRole.entries()].sort((a, b) => a[0].localeCompare(b[0]))),
    },
    rows,
  };
}

const PCF_DISPOSITIONS = new Set([
  'native-replacement',
  'server-dependency',
  'explicit-unsupported',
  'blocker',
]);

function pcfIdFor(control, screenName, templateName) {
  const identity = [screenName, control.path || control.name, templateName || control.template || null];
  return `pcf-${crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0, 16)}`;
}

function pcfServerDependencies(control, connectionRequirements) {
  const dependencies = [];
  const seen = new Set();
  function add(kind, name, operation, knownRequirement = null) {
    if (!name) return;
    const key = `${kind}:${String(name).toLowerCase()}:${operation || ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    const requirement = knownRequirement || toArray(connectionRequirements).find((row) => {
      if (kind === 'flow' && row.classification !== 'flow') return false;
      if (kind !== 'flow' && row.classification === 'flow') return false;
      return String(row.connector || '').toLowerCase() === String(name).toLowerCase();
    });
    dependencies.push({
      kind,
      name,
      operation: operation || null,
      connectionRequirementId: requirement ? requirement.id : null,
    });
  }

  for (const actions of Object.values((control && control.events) || {})) {
    for (const action of toArray(actions)) {
      if (!action || typeof action !== 'object') continue;
      if (action.intent === 'connectorCall') add('connector', action.connector, action.action);
      else if (action.intent === 'flowCall') add('flow', action.flow, action.action);
      else if (action.intent === 'aiCall') add('ai', action.connector, action.action);
    }
  }
  // Canvas PCFs frequently bind connector results through Items/DataSource
  // rather than an event. Match only connectors/flows already inventoried in
  // the handoff contract; never infer a backend from arbitrary source text.
  for (const formula of Object.values((control && control.properties) || {})) {
    if (typeof formula !== 'string' || formula.trim() === '') continue;
    for (const requirement of toArray(connectionRequirements)) {
      const name = requirement && requirement.connector;
      if (!name) continue;
      const escaped = escapeRegExp(String(name));
      const reference = new RegExp(`(?:'${escaped}'|\\b${escaped})\\s*\\.\\s*([A-Za-z_][A-Za-z0-9_]*)`, 'i').exec(formula);
      if (!reference) continue;
      const kind = requirement.classification === 'flow'
        ? 'flow'
        : requirement.classification === 'ai' ? 'ai' : 'connector';
      add(kind, name, reference[1], requirement);
    }
  }
  return dependencies;
}

function pcfEssentiality(control, dependencies) {
  const properties = (control && control.properties) || {};
  const required = stripLeadingEq(properties.Required).trim().toLowerCase();
  if (required === 'true') return { level: 'essential', reason: 'Source Required property is true.' };
  if (dependencies.length > 0) return { level: 'essential', reason: 'The PCF invokes a connector, flow, or AI operation.' };
  const events = eventNamesWithSource(control);
  if (events.length > 0) return { level: 'essential', reason: `The PCF owns source behavior: ${events.join(', ')}.` };
  if (properties.DataField != null || properties.DataSource != null || properties.Items != null) {
    return { level: 'essential', reason: 'The PCF is bound to source data or a record field.' };
  }
  return { level: 'unknown', reason: 'No deterministic evidence proves the PCF is optional; user review is required.' };
}

function availablePcfNativeStrategy(control, templateName, bundledDeps) {
  const properties = (control && control.properties) || {};
  const templateWords = String(templateName || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const wordSet = new Set(templateWords);
  const compact = templateWords.join('');
  const hasWord = (...words) => words.some((word) => wordSet.has(word));
  const hasCompact = (...values) => values.some((value) => compact.includes(value));
  const strategy = (primitive, packages, extra = {}) => {
    const requiredPackages = toArray(packages);
    if (!requiredPackages.every((pkg) => bundledDeps.has(pkg))) return null;
    return {
      type: 'native-ui',
      primitive,
      packages: requiredPackages,
      capability: extra.capability || null,
      implementationOwner: extra.implementationOwner || 'screen-builder',
      preserves: extra.preserves || [],
    };
  };

  if (hasWord('navigation', 'sidebar') || hasCompact('sidenavigation', 'navigationmenu', 'sidebarmenu')) {
    return strategy('Expo Router Drawer or Tabs selected from approved navigation graph', ['expo-router'], {
      implementationOwner: 'navigation-orchestrator',
      preserves: ['destinations', 'labels/icons', 'visibility rules', 'selected destination'],
    });
  }
  if (hasWord('calendar', 'agenda', 'schedule')) {
    return strategy('Calendar/Agenda screen composition', ['react-native-calendars'], {
      preserves: ['date/event bindings', 'selection behavior', 'filters'],
    });
  }
  if (hasWord('barcode', 'qr') || hasCompact('barcodereader', 'qrcoder', 'qrscanner')) {
    return strategy('CameraView barcode scanner', ['expo-camera'], {
      capability: 'barcode-scanner',
      implementationOwner: 'add-native',
      preserves: ['scan value/type', 'OnChange/OnSelect behavior'],
    });
  }
  if (hasCompact('datepicker', 'datetimepicker') || (hasWord('date', 'datetime') && hasWord('picker'))) {
    return strategy('Native DateTimePicker', ['@react-native-community/datetimepicker'], {
      preserves: ['default value', 'minimum/maximum constraints', 'change behavior'],
    });
  }
  if (hasWord('rating', 'stars') || hasCompact('starrating')) {
    return strategy('Accessible Tamagui star rating row', ['tamagui', '@expo/vector-icons'], {
      preserves: ['selected numeric value', 'bounds', 'change behavior'],
    });
  }
  if (hasWord('slider', 'range')) {
    return strategy('Tamagui Slider', ['tamagui'], {
      preserves: ['minimum', 'maximum', 'step', 'selected value'],
    });
  }
  if (hasWord('toggle', 'switch', 'checkbox')) {
    return strategy('Tamagui Switch or expo-checkbox', ['tamagui'], {
      preserves: ['boolean value', 'check/uncheck behavior'],
    });
  }
  if (hasWord('camera', 'photo', 'capture') || hasCompact('imagepicker', 'photopicker', 'imagecapture')) {
    return strategy('Native camera/image workflow', ['expo-camera', 'expo-image-picker'], {
      capability: 'camera',
      implementationOwner: 'add-native',
      preserves: ['captured/selected media', 'record binding', 'change behavior'],
    });
  }
  if (hasWord('file', 'attachment', 'document') || hasCompact('filepicker', 'documentpicker')) {
    return strategy('Native document picker or Dataverse File field', ['expo-document-picker'], {
      capability: 'document-picker',
      implementationOwner: 'add-native',
      preserves: ['selected file metadata', 'record binding', 'change behavior'],
    });
  }
  if (hasWord('audio', 'voice', 'microphone')) {
    return strategy('Native audio workflow', ['expo-audio'], {
      capability: 'audio',
      implementationOwner: 'add-native',
      preserves: ['audio source/capture result', 'playback/change behavior'],
    });
  }
  if (hasWord('video')) {
    return strategy('Native VideoView workflow', ['expo-video'], {
      capability: 'video',
      implementationOwner: 'add-native',
      preserves: ['video source', 'playback behavior'],
    });
  }
  if (hasWord('pdf') && typeof properties.Document === 'string' && /https?:/i.test(properties.Document)) {
    return strategy('Validated HTTPS PDF opened with expo-web-browser', ['expo-web-browser'], {
      preserves: ['document URL', 'open behavior'],
    });
  }
  if (hasWord('image') || hasCompact('imageviewer', 'imagedisplay')) {
    return strategy('Native image display', ['expo-image'], {
      preserves: ['image source', 'visibility', 'selection behavior'],
    });
  }
  return null;
}

function pcfServerUiPrimitive(control) {
  const properties = (control && control.properties) || {};
  if (properties.Items != null || properties.DataSource != null) return 'Native query-backed list, picker, or search surface';
  if (properties.Text != null || properties.Default != null || properties.DataField != null) return 'Native typed input or form field';
  return 'Native action surface backed by generated service';
}

function buildPcfPlan(brief, loadedScreens, connectionRequirements, bundledDeps) {
  const extractedByPath = new Map();
  const extractedByScreenControl = new Map();
  for (const item of toArray(brief && brief.app && brief.app.pcfControls)) {
    if (item.path) extractedByPath.set(item.path, item);
    extractedByScreenControl.set(`${item.screen || ''}\u0000${item.control || ''}`, item);
  }

  const controls = [];
  for (const screen of toArray(loadedScreens)) {
    for (const control of toArray(screen && screen.controls)) {
      if (!control || !control.isPcf) continue;
      const extracted = extractedByPath.get(control.path)
        || extractedByScreenControl.get(`${screen.name}\u0000${control.name}`)
        || {};
      const rawTemplateName = extracted.templateName || control.templateName || control.template || null;
      const templateName = isGuid(rawTemplateName) ? null : rawTemplateName;
      const dependencies = pcfServerDependencies(control, connectionRequirements);
      const essentiality = pcfEssentiality(control, dependencies);
      const nativeStrategy = availablePcfNativeStrategy(control, templateName, bundledDeps);
      let proposal;
      if (dependencies.length > 0) {
        const unresolvedDependencies = dependencies.filter((dep) => !dep.connectionRequirementId);
        proposal = unresolvedDependencies.length === 0
          ? {
              disposition: 'server-dependency',
              targetStrategy: {
                type: 'generated-service',
                uiPrimitive: nativeStrategy ? nativeStrategy.primitive : pcfServerUiPrimitive(control),
                dependencies,
                nativeSupport: nativeStrategy,
              },
              reason: 'Source PCF behavior invokes backend operations that must be rebound in the target before rebuilding its UI.',
            }
          : {
              disposition: 'blocker',
              targetStrategy: null,
              reason: `PCF backend dependency is not represented by a target connection requirement: ${unresolvedDependencies.map((dep) => dep.name).join(', ')}.`,
            };
      } else if (nativeStrategy) {
        proposal = {
          disposition: 'native-replacement',
          targetStrategy: nativeStrategy,
          reason: 'A semantically matching primitive is already allowlisted by the current mobile template.',
        };
      } else {
        proposal = {
          disposition: 'blocker',
          targetStrategy: null,
          reason: 'No deterministic allowlisted native replacement or explicit backend dependency was found; PCF source/specification or a user-approved strategy is required.',
        };
      }

      const publicProperties = extracted.properties || Object.fromEntries(
        ['Default', 'Items', 'DataField', 'DataSource', 'Text', 'OnChange', 'OnSelect', 'DisplayMode', 'Visible', 'Required']
          .filter((key) => control.properties && control.properties[key] != null)
          .map((key) => [key, control.properties[key]])
      );
      controls.push({
        pcfId: pcfIdFor(control, screen.name, rawTemplateName),
        screen: screen.name,
        control: control.name || shortName(control.path, 'PCF'),
        path: control.path || null,
        templateName,
        sourceTemplateIdPresent: !!(extracted.templateId || control.templateId || isGuid(rawTemplateName)),
        isPremium: !!(extracted.isPremiumPcf || control.isPremiumPcf),
        sourceContract: {
          properties: publicProperties,
          events: eventNamesWithSource(control),
          dataBindings: ['Items', 'Default', 'DataField', 'DataSource', 'Text', 'Required', 'DisplayMode', 'Visible']
            .filter((key) => publicProperties[key] != null),
        },
        dependencies,
        essentiality,
        proposal,
        approval: {
          status: 'pending',
          disposition: null,
          essentiality: null,
          targetStrategy: null,
          unsupportedUx: null,
          reason: null,
          approvedBy: null,
          approvedAt: null,
        },
      });
    }
  }

  controls.sort((a, b) => a.screen.localeCompare(b.screen) || String(a.path || '').localeCompare(String(b.path || '')));
  const sourceSignals = {
    containsThirdPartyPcfControls: brief?.app?.settings?.containsThirdPartyPcfControls === true,
    extractedPackageCount: toArray(brief && brief.pcfComponents).length,
    extractedControlCount: toArray(brief && brief.app && brief.app.pcfControls).length,
  };
  const sourceIndicatesPcf = sourceSignals.containsThirdPartyPcfControls
    || sourceSignals.extractedPackageCount > 0
    || sourceSignals.extractedControlCount > 0;
  const discoveryComplete = !sourceIndicatesPcf || controls.length > 0;
  const discoveryBlockers = discoveryComplete ? [] : [{
    code: 'PCF_INVENTORY_INCOMPLETE',
    message: 'Source metadata reports third-party PCF content, but no per-control PCF contract could be enumerated. Re-export with supported Controls/Components sidecars or provide a verified PCF inventory/specification before generation.',
  }];
  const proposed = Object.fromEntries([...PCF_DISPOSITIONS].map((disposition) => [
    disposition,
    controls.filter((row) => row.proposal.disposition === disposition).length,
  ]));
  return {
    $schema: 'pcf-plan-v1',
    generatedAt: GENERATION_TIMESTAMP,
    rule: 'Every PCF requires explicit user approval as a native replacement, server dependency, explicit unsupported state, or blocker before screen generation.',
    allowedDispositions: [...PCF_DISPOSITIONS],
    discovery: {
      complete: discoveryComplete,
      sourceSignals,
      blockers: discoveryBlockers,
    },
    stats: {
      total: controls.length,
      discoveryComplete,
      pendingApproval: controls.length,
      approved: 0,
      blocked: 0,
      byDisposition: Object.fromEntries([...PCF_DISPOSITIONS].map((disposition) => [disposition, 0])),
      proposed,
    },
    controls,
  };
}

function buildPcfPlanSectionLines(pcfPlan) {
  const rows = toArray(pcfPlan && pcfPlan.controls);
  if (rows.length === 0 && pcfPlan?.discovery?.complete !== false) return [];
  const lines = [];
  lines.push('### PCF Disposition Plan — Gate 2b');
  lines.push('');
  if (pcfPlan?.discovery?.complete === false) {
    lines.push('> **BLOCKED — PCF inventory incomplete.** Source metadata reports PCF content, but per-control contracts were not available. Re-export with supported Controls/Components sidecars or supply a verified PCF inventory/specification before generation.');
    lines.push('');
    return lines;
  }
  lines.push('PCF binaries cannot run in the native rewrap runtime. Every row below requires explicit user approval before generation; a proposal is not approval. The terminal decision must be native replacement, server dependency, explicit unsupported UX, or blocker.');
  lines.push('');
  lines.push('| PCF ID | Screen / control | Premium | Essentiality | Proposed disposition | Target / reason | Approval |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const row of rows) {
    const target = row.proposal.targetStrategy
      ? row.proposal.targetStrategy.primitive || row.proposal.targetStrategy.uiPrimitive || row.proposal.targetStrategy.type
      : row.proposal.reason;
    lines.push(`| \`${row.pcfId}\` | ${markdownTableText(row.screen)} / ${markdownTableText(row.control)} | ${row.isPremium ? 'yes' : 'no'} | ${row.essentiality.level} | \`${row.proposal.disposition}\` | ${markdownTableText(target)} | \`${row.approval.status}\` |`);
  }
  lines.push('');
  lines.push('Full public property/event contracts and target dependency references: [`pcf-plan.json`](pcf-plan.json).');
  lines.push('');
  return lines;
}

// ---------- Native Capability Playbook ----------
//
// `buildNativeCapabilityPlaybook(loadedScreens)` joins each per-screen
// `nativeCapabilities[]` tag to the screens that own a control of that kind
// AND the immediate downstream action(s) the control triggers. Clusters of
// `(capability, intent, target)` seen on ≥ 2 screens are marked reusable so
// the screen-builder can wrap them in a shared component.
//
// This is deterministic — it reads only the brief's pre-classified action
// chains + property formulas. It NEVER calls out to an LLM, never expands
// the capability tag set beyond what the brief declares, and never adds a
// capability the brief omitted.
//
// Tags without a hint here are passed through with `unknown: true` so reviewers
// can decide whether to add a native strategy without losing source intent.

const NATIVE_CAPABILITY_HINTS = {
  barcode: {
    label: 'Barcode / QR scan',
    controlKindRe: /^(Barcode|BarcodeReader|BarcodeScanner|QrcodeReader|QrScanner)/i,
    propertyRefRe: /\b(?:Barcode(?:Reader|Scanner)?|QrcodeReader)\d*\.(?:Value|Barcodes|Text|RawValue|Type|Code)\b/,
    callRe: null,
    bundledLib: 'expo-camera (CameraView barcodeScannerSettings)',
    libNote: 'Use `/add-native camera`; block if the current app/template does not already allowlist expo-camera.',
    purpose: 'Scan a 1D/2D barcode and consume the decoded string downstream.',
  },
  attachment: {
    label: 'File / image attachment',
    controlKindRe: /^(Attachments|AddMedia|AddPicture)/i,
    propertyRefRe: /\b(?:Attachments|AddPicture|AddMedia(?:Button)?)\d*\.(?:Attachments|Image|Media|Url)\b/,
    callRe: null,
    bundledLib: 'expo-document-picker / expo-image-picker',
    libNote: 'Use `/add-native image-picker` or `/add-native document-picker` according to source intent; block if the required module is not allowlisted.',
    purpose: 'Pick a file or photo and attach it to a Dataverse record.',
  },
  notification: {
    label: 'In-app notification / toast',
    controlKindRe: null,
    propertyRefRe: null,
    callRe: /\bNotify\s*\(/i,
    matchingIntents: new Set(['notify']),
    bundledLib: 'burnt (bundled)',
    libNote: 'In-app toast only — push notifications are NOT supported by the bundled runtime.',
    purpose: 'Surface a transient status / error / info toast to the user.',
  },
  pdf: {
    label: 'PDF viewer',
    controlKindRe: /^(PDFViewer|PdfViewer|Pdf)/i,
    propertyRefRe: /\bPDFViewer\d*\.(?:Document|Url|Page|PageCount)\b/i,
    callRe: null,
    bundledLib: 'expo-web-browser fallback; optional allowlisted Power Apps native PDF viewer',
    libNote: 'Use `/add-native pdf-viewer` only for HTTPS URLs when its package is already present; otherwise open externally or use `/add-native pdf-report` for generated files.',
    purpose: 'Preserve PDF viewing/generation intent using a current allowlisted path.',
  },
  webview: {
    label: 'Embedded webview / HTML',
    controlKindRe: /^(HtmlViewer|WebView|Web)/i,
    propertyRefRe: /\b(?:HtmlViewer|WebView)\d*\.(?:HtmlText|Url|Html)\b/i,
    callRe: null,
    bundledLib: 'Tamagui composition / expo-web-browser',
    libNote: 'react-native-webview is not bundled. Compose trusted content natively; validate and open full pages externally.',
    purpose: 'Preserve the content/URL intent without importing Canvas HTML scaffolding.',
  },
  form: {
    label: 'Edit form (multi-field record edit)',
    controlKindRe: /^(Form|EditForm|DisplayForm)$/i,
    propertyRefRe: null,
    callRe: /\b(?:SubmitForm|NewForm|ResetForm|EditForm|ViewForm)\s*\(/i,
    matchingIntents: new Set(['submitForm', 'newForm', 'resetForm']),
    bundledLib: 'react-hook-form + zod (bundled)',
    libNote: 'Map every TypedDataCard child to a controlled input with a zod field schema.',
    purpose: 'Multi-field record edit/create form bound to one Dataverse row.',
  },
  list: {
    label: 'Scrollable list / gallery',
    controlKindRe: /^(Gallery|DataTable|FlexibleGroup)$/i,
    propertyRefRe: null,
    callRe: null,
    bundledLib: 'React Native FlatList / SectionList',
    libNote: 'Use the built-in virtualized lists with stable keys, pagination, and a memoized row renderer; @shopify/flash-list is not bundled.',
    purpose: 'Render a scrollable, virtualized list of Dataverse rows.',
  },
};

function snippetForAction(a) {
  // One-line Power Fx-ish summary of a pre-classified action, used in the
  // playbook tables. Stays short — the screen plan already carries verbatim.
  const i = a.intent;
  if (i === 'patch' || i === 'update' || i === 'updateIf' || i === 'remove' || i === 'removeIf') {
    const fields = toArray(a.fields).slice(0, 3).map((f) => (f && f.column) ? f.column : '?').join(', ');
    const extra = toArray(a.fields).length > 3 ? ', …' : '';
    const base = a.baseRecord ? a.baseRecord : '<row>';
    const verb = i === 'patch' ? 'Patch' : i === 'update' ? 'Update' : i === 'updateIf' ? 'UpdateIf' : i === 'remove' ? 'Remove' : 'RemoveIf';
    return `${verb}(${a.source || '<table>'}, ${base}${fields ? `, { ${fields}${extra} }` : ''})`;
  }
  if (i === 'navigate') return `Navigate(${a.target || '<screen>'}${a.transition ? ', ' + a.transition : ''})`;
  if (i === 'back') return `Back(${a.transition || ''})`;
  if (i === 'setVar') return `Set(${a.name || '?'}, …)`;
  if (i === 'setContext') return `UpdateContext({ ${a.name || '?'}: … })`;
  if (i === 'notify') {
    const msg = a.message ? '"' + (a.message.length > 40 ? a.message.slice(0, 40) + '…' : a.message) + '"' : '…';
    return `Notify(${msg}${a.type ? ', ' + a.type : ''})`;
  }
  if (i === 'submitForm') return `SubmitForm(${a.form || '<form>'})`;
  if (i === 'newForm') return `NewForm(${a.form || '<form>'})`;
  if (i === 'resetForm') return `ResetForm(${a.form || '<form>'})`;
  if (i === 'collect') return `Collect(${a.collection || '<col>'}, …)`;
  if (i === 'clearCollect') return `ClearCollect(${a.collection || '<col>'}, …)`;
  if (i === 'clear') return `Clear(${a.collection || '<col>'})`;
  if (i === 'select') return `Select(${a.target || '<ctl>'})`;
  if (i === 'reset') return `Reset(${a.target || '<ctl>'})`;
  if (i === 'refresh') return `Refresh(${a.source || '<src>'})`;
  if (i === 'literal') return a.value !== undefined ? String(a.value) : '…';
  if (i === 'read') return a.expression ? (a.expression.length > 60 ? a.expression.slice(0, 60) + '…' : a.expression) : '…';
  return i || 'unknown';
}

function suggestComponentName(capability, intent, target) {
  // PascalCase-ish advisory component name. Purely a label for the playbook
  // table — the adapter does NOT generate component code anywhere.
  const cap = capability ? capability[0].toUpperCase() + capability.slice(1) : 'Native';
  let verb;
  switch (intent) {
    case 'patch': verb = 'PatchTo'; break;
    case 'update': case 'updateIf': verb = 'UpdateIn'; break;
    case 'remove': case 'removeIf': verb = 'RemoveFrom'; break;
    case 'collect': case 'clearCollect': verb = 'CollectInto'; break;
    case 'navigate': verb = 'NavigateTo'; break;
    case 'back': verb = 'GoBack'; break;
    case 'notify': verb = 'Toast'; break;
    case 'submitForm': verb = 'SubmitInto'; break;
    case 'newForm': verb = 'NewIn'; break;
    case 'resetForm': verb = 'ResetIn'; break;
    case 'setVar': case 'setContext': verb = 'CaptureTo'; break;
    case 'refresh': verb = 'Refresh'; break;
    default: verb = intent ? intent[0].toUpperCase() + intent.slice(1) : 'Action';
  }
  if (!target) return `<${cap}${verb} />`;
  const cleaned = String(target).replace(/[^A-Za-z0-9]+/g, ' ').trim().split(/\s+/);
  const targetPascal = cleaned.map((p) => p ? p[0].toUpperCase() + p.slice(1).toLowerCase() : '').join('');
  return `<${cap}${verb}${targetPascal} />`;
}

function extractNativeIntentForScreen(screen) {
  // Returns Map<capability, { capability, ownerControls, downstreamActions,
  // formulas, unknown }>. Only inspects capabilities the brief declared on
  // this screen — never invents new tags.
  const tags = toArray(screen.nativeCapabilities);
  const out = new Map();
  if (tags.length === 0) return out;

  const controls = toArray(screen.controls);

  for (const tag of tags) {
    const hint = NATIVE_CAPABILITY_HINTS[tag];
    if (!hint) {
      out.set(tag, {
        capability: tag,
        ownerControls: [],
        downstreamActions: [],
        formulas: [],
        unknown: true,
      });
      continue;
    }

    const entry = {
      capability: tag,
      ownerControls: [],
      downstreamActions: [],
      formulas: [],
      unknown: false,
    };

    // Pass 1 — locate owner controls by kind.
    if (hint.controlKindRe) {
      for (const c of controls) {
        const kind = c.kind || c.controlType || c.template || '';
        if (hint.controlKindRe.test(kind)) {
          entry.ownerControls.push({ name: c.name, kind, path: c.path });
        }
      }
    }
    const ownerNames = new Set(entry.ownerControls.map((o) => o.name));

    // Pass 2 — walk every control's events + property formulas for evidence.
    for (const c of controls) {
      const props = c.properties || {};
      const events = c.events || {};

      // Event chains: collect downstream actions that match the capability.
      for (const [evtName, actionChain] of Object.entries(events)) {
        const actions = toArray(actionChain);
        for (let ai = 0; ai < actions.length; ai++) {
          const a = actions[ai];
          if (!a || typeof a !== 'object') continue;

          const blobParts = [];
          if (a.expression) blobParts.push(String(a.expression));
          if (a.message) blobParts.push(String(a.message));
          if (a.value !== undefined) blobParts.push(String(a.value));
          if (a.fields) {
            for (const f of toArray(a.fields)) {
              if (!f) continue;
              if (f.value !== undefined) blobParts.push(String(f.value));
              if (f.expression) blobParts.push(String(f.expression));
            }
          }
          if (a.baseRecord) blobParts.push(String(a.baseRecord));
          if (a.from) blobParts.push(String(a.from));
          const blob = blobParts.join(' \n ');

          let evidence = null;
          if (hint.matchingIntents && a.intent && hint.matchingIntents.has(a.intent)) evidence = 'intent-match';
          if (!evidence && hint.callRe && hint.callRe.test(blob)) evidence = 'function-call';
          if (!evidence && hint.propertyRefRe && hint.propertyRefRe.test(blob)) evidence = 'identifier-ref';
          if (!evidence && ownerNames.has(c.name)) evidence = 'on-owner-control';
          // form-tag special case: SubmitForm()/NewForm() may sit on a child
          // button — already covered by callRe + matchingIntents.

          if (evidence) {
            entry.downstreamActions.push({
              screen: screen.name,
              control: c.name,
              controlKind: c.kind || c.controlType || c.template || '',
              event: evtName,
              actionIndex: ai,
              intent: a.intent || 'unknown',
              target: a.source || a.collection || a.target || a.form || null,
              evidence,
              snippet: snippetForAction(a),
            });
          }
        }
      }

      // Property formulas (Visible / Default / Items / Text …): purely
      // observational, no action attached — useful for the per-screen
      // "Property references" line in the Native intent block.
      if (hint.propertyRefRe) {
        for (const [propKey, propVal] of Object.entries(props)) {
          if (typeof propVal !== 'string' || !propVal) continue;
          if (hint.propertyRefRe.test(propVal)) {
            const trimmed = propVal.length > 120 ? propVal.slice(0, 120) + '…' : propVal;
            entry.formulas.push({
              screen: screen.name,
              control: c.name,
              property: propKey,
              snippet: trimmed,
            });
          }
        }
      }
    }

    out.set(tag, entry);
  }

  return out;
}

function buildNativeCapabilityPlaybook(loadedScreens) {
  // Returns:
  //   { byCapability: { tag: { capability, screens, owners, downstream,
  //                            clusters, unknown } },
  //     byScreen:     Map<screenName, Map<tag, perScreenEntry>> }
  // Where each `cluster` is { signature, intent, target, screens[], reusable,
  // componentName, samples[] } — `signature` is the dedup key used by the
  // per-screen Native intent block to look up which shared component to
  // import.
  const byCapability = {};
  const byScreen = new Map();

  for (const screen of toArray(loadedScreens)) {
    const perScreen = extractNativeIntentForScreen(screen);
    if (perScreen.size === 0) continue;
    byScreen.set(screen.name, perScreen);
    for (const [tag, entry] of perScreen) {
      if (!byCapability[tag]) {
        byCapability[tag] = {
          capability: tag,
          screens: [],
          owners: [],
          downstream: [],
          clusters: [],
          unknown: !!entry.unknown,
        };
      }
      const cap = byCapability[tag];
      if (!cap.screens.includes(screen.name)) cap.screens.push(screen.name);
      for (const o of entry.ownerControls) {
        cap.owners.push({ screen: screen.name, control: o.name, kind: o.kind });
      }
      for (const d of entry.downstreamActions) {
        cap.downstream.push(d);
      }
    }
  }

  // Cluster downstream actions by (capability, intent, target).
  for (const tag of Object.keys(byCapability)) {
    const cap = byCapability[tag];
    const sigMap = new Map();
    for (const d of cap.downstream) {
      const targetKey = d.target == null ? '∅' : String(d.target);
      const sig = `${tag}+${d.intent}::${targetKey}`;
      let bucket = sigMap.get(sig);
      if (!bucket) {
        bucket = {
          signature: sig,
          intent: d.intent,
          target: d.target || null,
          screens: new Set(),
          samples: [],
        };
        sigMap.set(sig, bucket);
      }
      bucket.screens.add(d.screen);
      if (bucket.samples.length < 3) {
        bucket.samples.push(`${d.screen}.${d.control}: ${d.snippet}`);
      }
    }
    cap.clusters = Array.from(sigMap.values()).map((b) => ({
      signature: b.signature,
      intent: b.intent,
      target: b.target,
      screens: Array.from(b.screens).sort(),
      reusable: b.screens.size >= 2,
      componentName: suggestComponentName(tag, b.intent, b.target),
      samples: b.samples,
    })).sort((a, b) => (b.screens.length - a.screens.length) ||
      a.intent.localeCompare(b.intent) ||
      String(a.target || '').localeCompare(String(b.target || '')));
  }

  return { byCapability, byScreen };
}

function buildNativeCapabilityPlaybookLines(playbook) {
  const lines = [];
  const caps = Object.keys(playbook && playbook.byCapability || {});
  if (caps.length === 0) return lines;

  lines.push('### Native Capability Playbook');
  lines.push('');
  lines.push('> Joins each `nativeCapabilities[]` tag to the screens that own a control of that kind AND the immediate downstream action(s) the control triggers. A `(capability, intent, target)` tuple seen on ≥ 2 screens is marked **reusable** — wrap it in the suggested shared component name and import everywhere. Tuples seen on a single screen stay inline.');
  lines.push('');
  lines.push('| Capability | Screens | Distinct downstream patterns | Reusable patterns |');
  lines.push('|---|---|---|---|');
  for (const tag of caps) {
    const cap = playbook.byCapability[tag];
    const reusable = cap.clusters.filter((c) => c.reusable).length;
    const head = cap.screens.slice(0, 3).join(', ');
    const more = cap.screens.length > 3 ? `, +${cap.screens.length - 3}` : '';
    lines.push(`| \`${tag}\` | ${cap.screens.length} (${head}${more}) | ${cap.clusters.length} | ${reusable} |`);
  }
  lines.push('');

  for (const tag of caps) {
    const cap = playbook.byCapability[tag];
    const hint = NATIVE_CAPABILITY_HINTS[tag];
    lines.push(`### \`${tag}\`${hint ? ' — ' + hint.label : ''}`);
    lines.push('');
    if (hint) {
      lines.push(`- **Purpose:** ${hint.purpose}`);
      lines.push(`- **Bundled library:** ${hint.bundledLib}`);
      if (hint.libNote) lines.push(`- **Note:** ${hint.libNote}`);
    } else if (cap.unknown) {
      lines.push('- _No built-in extractor hint for this tag — adapter passes the tag through but did not search formulas for owners. Add a hint to `NATIVE_CAPABILITY_HINTS` in `scripts/adapt-app-brief-for-mobile-plugin.js` to enrich._');
    }
    lines.push(`- **Screens using it:** ${cap.screens.map((s) => '`' + s + '`').join(', ')}`);
    if (cap.owners.length) {
      const ownerLines = cap.owners.slice(0, 8).map((o) => `  - \`${o.screen}.${o.control}\` (${o.kind})`);
      lines.push('- **Owner controls:**');
      for (const l of ownerLines) lines.push(l);
      if (cap.owners.length > 8) lines.push(`  - …+${cap.owners.length - 8} more`);
    }
    lines.push('');

    if (cap.clusters.length === 0) {
      lines.push('_No downstream action evidence captured — control may be view-only or host-managed._');
      lines.push('');
      continue;
    }

    lines.push('| Intent → target | Screens | Reusable? | Suggested shared component | Sample |');
    lines.push('|---|---|---|---|---|');
    for (const cl of cap.clusters) {
      const tgt = cl.target ? markdownCode(cl.target, true) : '—';
      const head = cl.screens.slice(0, 3).join(', ');
      const more = cl.screens.length > 3 ? `, +${cl.screens.length - 3}` : '';
      const screensCell = `${head}${more}`;
      const reusableCell = cl.reusable ? `**Yes** (${cl.screens.length}×)` : 'No (1×)';
      const compCell = markdownCode(cl.componentName, true);
      const sample = cl.samples[0] || '—';
      const sampleCell = sample === '—' ? '—' : markdownCode(sample, true);
      lines.push(`| \`${cl.intent}\` → ${tgt} | ${screensCell} | ${reusableCell} | ${compCell} | ${sampleCell} |`);
    }
    lines.push('');
  }

  return lines;
}

function buildNativeIntentSectionLines(screen, playbook) {
  if (!playbook || !playbook.byScreen) return [];
  const perScreen = playbook.byScreen.get(screen.name);
  if (!perScreen || perScreen.size === 0) return [];

  const lines = [];
  lines.push('## Native intent');
  lines.push('');
  lines.push('> Per-capability evidence found on THIS screen, plus which shared component to import (when the same `(capability, intent, target)` tuple appears on ≥ 2 screens). See the master plan\'s `## Native Capability Playbook` for the full cluster table.');
  lines.push('');

  for (const [tag, entry] of perScreen) {
    const hint = NATIVE_CAPABILITY_HINTS[tag];
    lines.push(`### \`${tag}\`${hint ? ' — ' + hint.label : ''}`);
    if (entry.unknown) {
      lines.push('');
      lines.push('_Tag present in brief but no built-in extractor hint — leaving evidence collection to the screen-builder._');
      lines.push('');
      continue;
    }
    if (entry.ownerControls.length) {
      const owners = entry.ownerControls.map((o) => '`' + o.name + '` (' + o.kind + ')').join(', ');
      lines.push(`- **Owner controls:** ${owners}`);
    } else {
      lines.push('- **Owner controls:** _none of this kind on this screen — capability evidence comes from formulas / function calls only._');
    }

    if (entry.downstreamActions.length === 0) {
      lines.push('- _No downstream action evidence — control may be view-only or host-managed._');
    } else {
      lines.push('- **Downstream actions:**');
      const capEntry = playbook.byCapability[tag];
      const clusterIndex = new Map();
      if (capEntry) {
        for (const cl of capEntry.clusters) clusterIndex.set(cl.signature, cl);
      }
      const max = 8;
      for (const d of entry.downstreamActions.slice(0, max)) {
        const targetKey = d.target == null ? '∅' : String(d.target);
        const sig = `${tag}+${d.intent}::${targetKey}`;
        const cl = clusterIndex.get(sig);
        let importHint;
        if (cl && cl.reusable) {
          const others = cl.screens.filter((s) => s !== screen.name);
          const othersTxt = others.length ? others.slice(0, 3).join(', ') + (others.length > 3 ? ', +' + (others.length - 3) : '') : '—';
          importHint = ` → import \`${cl.componentName}\` (also used by: ${othersTxt})`;
        } else {
          importHint = ' → inline implementation (only screen with this pattern)';
        }
        const tgtTxt = d.target ? ` → ${markdownCode(d.target)}` : '';
        lines.push(`  - ${markdownCode(`${d.control}.${d.event}[${d.actionIndex}]`)}: ${markdownCode(d.intent)}${tgtTxt} — ${markdownCode(d.snippet)}${importHint}`);
      }
      if (entry.downstreamActions.length > max) {
        lines.push(`  - …+${entry.downstreamActions.length - max} more action(s)`);
      }
    }

    if (entry.formulas.length) {
      const propRefs = entry.formulas.slice(0, 3).map((f) => '`' + f.control + '.' + f.property + '`').join(', ');
      const more = entry.formulas.length > 3 ? `, +${entry.formulas.length - 3}` : '';
      lines.push(`- **Property references:** ${propRefs}${more}`);
    }
    lines.push('');
  }

  return lines;
}

function buildNativeReplacementsLines(screen, screenSwaps) {
  if (!screenSwaps || screenSwaps.length === 0) return [];
  const lines = [];
  lines.push('## Native replacements');
  lines.push('');
  lines.push(`> The screen-builder MUST use the bundled native libraries listed below for each matched Canvas pattern, instead of replicating Canvas controls one-for-one. Every library cited is already in [\`template/package.json\`](../../../../template/package.json) (or, for empty-lib entries, handed off to \`/add-native\`).`);
  lines.push('');
  lines.push('| Pattern | Library | Component |');
  lines.push('|---|---|---|');
  for (const swap of screenSwaps) {
    const libCell = swap.lib ? '`' + swap.lib + '`' : '_no bundled lib — see notes_';
    lines.push(`| ${swap.label} | ${libCell} | ${swap.component} |`);
  }
  lines.push('');
  for (const swap of screenSwaps) {
    lines.push(`### ${swap.label}`);
    lines.push('');
    lines.push(`- **Library:** ${swap.lib ? '`' + swap.lib + '`' : '_no bundled lib_'}`);
    lines.push(`- **Component / API:** ${swap.component}`);
    if (toArray(swap.keep).length) {
      lines.push('- **Keep from source:**');
      for (const k of swap.keep) lines.push(`  - ${k}`);
    }
    if (toArray(swap.drop).length) {
      lines.push('- **Drop:**');
      for (const d of swap.drop) lines.push(`  - ${d}`);
    }
    if (swap.notes) lines.push(`- **Notes:** ${swap.notes}`);
    if (swap.risk) lines.push(`- **Risk:** [${swap.risk.severity}] \`${swap.risk.code}\` — ${swap.risk.message}`);
    lines.push('');
  }
  return lines;
}

// ---------- Per-screen file writers ----------

function buildScreenPlanLines(screen, opts) {
  // opts: { detailMode: 'inline' | 'separate', controlsFilename }
  const lines = [];
  const controls = toArray(screen.controls);
  const interactive = controls.filter(isInteractive);
  const cosmetic = controls.filter((c) => !isInteractive(c));
  const { screenSwaps, controlSwaps } = matchSwapsForScreen(screen);

  lines.push(`# ${screen.name} — Screen Plan`);
  lines.push('');
  if (screen.userStory) {
    lines.push('> ' + screen.userStory);
    lines.push('');
  }

  lines.push('## Summary');
  lines.push('');
  lines.push(`- **Layout:** ${screen.layoutKind || 'screen'}`);
  lines.push(`- **Purpose:** ${screen.purpose || '—'}`);
  lines.push(`- **Control count:** ${controls.length} total (${interactive.length} interactive, ${cosmetic.length} cosmetic)`);
  if (screen.scaffoldControlCount) lines.push(`- **Scaffold controls:** ${screen.scaffoldControlCount}`);
  if (screen.autoGenFormCardCount) lines.push(`- **Auto-gen form cards:** ${screen.autoGenFormCardCount}`);
  lines.push('');

  // Native-swap directives — emitted between Summary and the verbatim
  // per-control dump so the screen-builder sees the directive first.
  const nativeReplace = buildNativeReplacementsLines(screen, screenSwaps);
  if (nativeReplace.length > 0) lines.push(...nativeReplace);

  // Canvas anti-pattern upgrades — emitted right after native swaps so the
  // screen-builder sees "intent over control" guidance for any maker
  // workarounds detected in the source (HtmlViewer, pixel positioning, …).
  const upgradeHintsLines = buildUpgradeHintsLines(screen);
  if (upgradeHintsLines.length > 0) lines.push(...upgradeHintsLines);

  // Native intent — per-capability evidence + reusable-component hint.
  // Drops in immediately after native swaps so the builder sees both the
  // "what to swap" and "what to share" guidance before any control detail.
  const nativeIntent = buildNativeIntentSectionLines(screen, opts && opts.playbook);
  if (nativeIntent.length > 0) lines.push(...nativeIntent);

  // Screen-level properties (mostly OnVisible).
  const sprops = screen.properties || {};
  const sPropKeys = Object.keys(sprops).filter((k) => !SUPPRESSED_PROPS.has(k));
  if (sPropKeys.length > 0) {
    lines.push('## Screen properties');
    lines.push('');
    for (const k of sPropKeys) {
      lines.push(`- \`${k}\`:`);
      lines.push('');
      lines.push(...pfxBlock(sprops[k], '  '));
      lines.push('');
    }
  }

  // Control tree (every control, one line each).
  lines.push('## Control tree');
  lines.push('');
  lines.push('> Legend: `◆` = interactive (full detail below). Cosmetic controls (no events, no data binding) show as one line only. `→ <library>` markers show the bundled native swap that replaces this control.');
  lines.push('');
  lines.push(...fencedBlock(controls.map((c) => controlTreeLine(c, screen.name, controlSwaps)).join('\n')));
  lines.push('');

  // Per-control detail. If detailMode === 'separate', write a pointer and
  // emit only an index of interactive controls here. Full detail goes to
  // <Name>.controls.md.
  if (opts.detailMode === 'separate') {
    lines.push('## Interactive controls');
    lines.push('');
    lines.push(`> Full per-control spec lives in [\`${opts.controlsFilename}\`](${opts.controlsFilename}). Index:`);
    lines.push('');
    for (const c of interactive) {
      lines.push(`- \`${shortName(c.path, c.name)}\` (${c.kind})`);
    }
    lines.push('');
  } else {
    lines.push('## Interactive controls');
    lines.push('');
    for (const c of interactive) {
      lines.push(...renderControlDetail(c, screen.name));
    }
  }

  return lines;
}

function buildControlsOnlyLines(screen) {
  const lines = [];
  lines.push(`# ${screen.name} — Full control detail`);
  lines.push('');
  lines.push('> Companion to `' + screen.name + '.plan.md`. Every control with events or data binding gets a full subsection here, including verbatim Power Fx.');
  lines.push('');
  const controls = toArray(screen.controls);
  for (const c of controls) {
    if (!isInteractive(c)) continue;
    lines.push(...renderControlDetail(c, screen.name));
  }
  return lines;
}

function loadAllScreens(brief, screensDir, missing) {
  // Read every per-screen JSON the index references. Returns the array of
  // loaded screens in index order, pushing names of any missing files onto
  // the caller's `missing` array (which is non-fatal — the master plan just
  // warns about them).
  const screenIndex = toArray(brief.screens);
  const allLoaded = [];
  const briefRoot = path.resolve(path.dirname(screensDir));
  if (!fs.existsSync(screensDir)) throw new Error(`Screen brief directory not found: ${screensDir}`);
  const screensStat = fs.lstatSync(screensDir);
  if (screensStat.isSymbolicLink() || !screensStat.isDirectory()) throw new Error(`Screen brief path must be a real directory: ${screensDir}`);
  const screensRoot = fs.realpathSync(screensDir);
  for (const meta of screenIndex) {
    const src = meta.briefPath
      ? path.resolve(briefRoot, meta.briefPath)
      : path.join(screensDir, `${buildArtifactNameMap([meta.name], 'screen').get(meta.name)}.json`);
    if (!pathContains(briefRoot, src)) {
      throw new Error(`Screen brief path escapes app-brief directory: ${meta.briefPath}`);
    }
    if (!fs.existsSync(src)) {
      missing.push(meta.name);
      continue;
    }
    if (fs.lstatSync(src).isSymbolicLink() || !fs.lstatSync(src).isFile()) {
      throw new Error(`Screen brief must be a regular file: ${meta.briefPath}`);
    }
    const realSource = fs.realpathSync(src);
    if (!pathContains(screensRoot, realSource)) throw new Error(`Screen brief path escapes screens directory: ${meta.briefPath}`);
    allLoaded.push(readJson(realSource));
  }
  return allLoaded;
}

function writePerScreenFiles(brief, outDir, splitThreshold, loadedScreens, playbook) {
  const screensOutDir = path.join(outDir, 'screens');
  ensureDir(screensOutDir);

  const written = [];
  const artifactNames = buildArtifactNameMap(loadedScreens.map((screen) => screen.name), 'screen');

  for (const screen of loadedScreens) {
    const artifactName = artifactNames.get(screen.name);
    // First pass: assume inline detail and see how many lines that produces.
    const inlineLines = buildScreenPlanLines(screen, { detailMode: 'inline', playbook });
    let planLines;
    let controlsFile = null;
    let mode = 'inline';
    if (inlineLines.length > splitThreshold) {
      mode = 'separate';
      controlsFile = `${artifactName}.controls.md`;
      planLines = buildScreenPlanLines(screen, { detailMode: 'separate', controlsFilename: controlsFile, playbook });
      const controlsLines = buildControlsOnlyLines(screen);
      writeFile(path.join(screensOutDir, controlsFile), controlsLines.join('\n') + '\n');
    } else {
      planLines = inlineLines;
    }
    const planFile = `${artifactName}.plan.md`;
    writeFile(path.join(screensOutDir, planFile), planLines.join('\n') + '\n');
    written.push({
      name: screen.name,
      planFile,
      controlsFile,
      lineCount: planLines.length,
      mode,
      controlCount: toArray(screen.controls).length,
    });
  }

  return { written };
}

// ---------- Master plan ----------

// ---------- Form factor / Bootstrap / Forms / Localization / Assets ----------
//
// Five new section builders (March 2025). All read directly from the brief
// fields that the upstream extract-msapp-brief.v2.cjs already preserves:
//   - brief.app.documentLayout / brief.app.settings.documentLayout → form factor
//   - brief.app.onStartIntents → bootstrap
//   - brief.forms → forms catalog
//   - brief.localization → localization strategy / translation table / keys
//   - brief.assets.images → bundled + URI image catalog
//
// Each returns an array of lines that the master-plan builder splices in. Two
// of them also emit a JSON sidecar (localization.json, assets.json) because
// dumping 224 keys + 136 image entries inline would drown the plan.

function buildFormFactorLine(brief) {
  const settingsLayout = (brief.app && brief.app.settings && brief.app.settings.documentLayout) || null;
  const fallbackLayout = (brief.app && brief.app.documentLayout) || null;
  const layout = settingsLayout || fallbackLayout;
  const docAppType = brief.app && brief.app.settings && brief.app.settings.documentAppType;
  if (!layout) {
    if (docAppType) return `- **Form factor:** ${docAppType} (no documentLayout captured)`;
    return '- **Form factor:** <unknown — brief did not capture documentLayout>';
  }
  const w = layout.width || '?';
  const h = layout.height || '?';
  const orient = layout.orientation || 'portrait';
  const locked = layout.lockOrientation === true ? ' (orientation locked)' : '';
  const fit = layout.scaleToFit === true ? ', scaleToFit' : '';
  const kindTag = docAppType ? ` — documentAppType: \`${docAppType}\`` : '';
  return `- **Form factor:** Phone, ${w}\u00d7${h} ${orient}${locked}${fit}${kindTag}`;
}

function parseLibraryDependencies(raw) {
  // Brief encodes libraryDependencies as an array of strings, each itself a
  // JSON-encoded array of dependency descriptors. Empty case: ["[]"].
  const out = [];
  for (const s of toArray(raw)) {
    if (typeof s !== 'string') continue;
    try {
      const parsed = JSON.parse(s);
      if (Array.isArray(parsed)) out.push(...parsed);
    } catch (_e) {
      out.push({ raw: s });
    }
  }
  return out;
}

function buildSourceSettingsLines(brief) {
  // Operational flags from Properties.json that downstream skills need to know
  // about (offline, PCF, telemetry, pagination defaults). Only emit when at
  // least one flag is present so a sparse brief doesn't drown the plan.
  const s = (brief && brief.app && brief.app.settings) || null;
  const lines = [];
  if (!s) return lines;
  const flagKeys = [
    'offlineEnabled',
    'enableInstrumentation',
    'showStatusBar',
    'containsThirdPartyPcfControls',
    'defaultConnectedDataSourceMaxGetRowsCount',
    'documentLayoutMaintainAspectRatio',
    'appCopilotSchemaName',
  ];
  const present = flagKeys.filter((k) => s[k] !== undefined && s[k] !== null);
  const libs = parseLibraryDependencies(s.libraryDependencies);
  if (present.length === 0 && libs.length === 0) return lines;
  lines.push('### Source runtime settings');
  lines.push('');
  lines.push('| Setting | Value | Implication |');
  lines.push('|---|---|---|');
  const impl = {
    offlineEnabled: 'source context only. Ask the unchanged offline question; `/setup-offline-profile` authors a Dataverse profile but does not recreate Canvas local-cache runtime behavior.',
    enableInstrumentation: 'source context only. Do not carry source instrumentation settings or keys into the target; telemetry requires a separate approved target implementation.',
    showStatusBar: 'render status bar in shell. Configure via Tamagui in `app/_layout.tsx`.',
    containsThirdPartyPcfControls: 'true → PCF present; native target cannot host PCF, need React Native replacement.',
    defaultConnectedDataSourceMaxGetRowsCount: 'page-size hint for service-call pagination (`use<Table>List({ top: N })`).',
    documentLayoutMaintainAspectRatio: 'preserve canvas aspect ratio on resize. Mobile target ignores (orientation lock wins).',
    appCopilotSchemaName: 'Copilot schema binding. Not yet supported in native target.',
  };
  for (const k of present) {
    let v = s[k];
    if (typeof v === 'boolean') v = v ? 'true' : 'false';
    lines.push(`| \`${k}\` | \`${v}\` | ${impl[k] || '—'} |`);
  }
  if (libs.length) {
    lines.push(`| \`libraryDependencies\` | ${libs.length} entries | parsed below — Canvas component libraries pulled in by the source app. |`);
  }
  lines.push('');
  if (libs.length) {
    lines.push('### Library dependencies');
    lines.push('');
    for (const dep of libs) {
      if (dep && dep.raw) {
        lines.push(`- **Unparsed:** \`${truncateInline(dep.raw, 120)}\``);
      } else if (dep && typeof dep === 'object') {
        const summary = Object.entries(dep)
          .map(([k, v]) => `${k}: \`${truncateInline(String(v), 60)}\``)
          .join(', ');
        lines.push(`- ${summary}`);
      }
    }
    lines.push('');
  }
  return lines;
}

function buildFlowsSectionLines(brief) {
  const flows = toArray(brief && brief.dataModel && brief.dataModel.flows);
  const lines = [];
  if (flows.length === 0) return lines;
  lines.push('### Flows');
  lines.push('');
  lines.push(`Source app invokes **${flows.length}** Power Automate cloud flow(s). Source GUIDs are environment-bound and redacted. Resolve each flow with \`npx power-apps list-flows --json\` in the selected target, confirm the intended match, then bind via \`npx power-apps add-flow --flow-id <target-guid>\`. After add-flow, the generated service appears under \`src/generated/services/\` and the screen-builder calls it from the same source action.`);
  lines.push('');
  lines.push('| Flow | Actions | Screens |');
  lines.push('|---|---|---|');
  for (const f of flows) {
    const name = f && f.name ? '`' + f.name + '`' : '`(unnamed)`';
    const actions = toArray(f && f.actions).length;
    const screens = toArray(f && f.screens);
    const scrCell = screens.length
      ? screens.slice(0, 5).map((n) => '`' + n + '`').join(', ') + (screens.length > 5 ? `, … (+${screens.length - 5})` : '')
      : '—';
    lines.push(`| ${name} | ${actions} | ${scrCell} |`);
  }
  lines.push('');
  return lines;
}

function buildSharePointListsSectionLines(brief) {
  const lists = toArray(brief && brief.dataModel && brief.dataModel.sharepointLists);
  const lines = [];
  if (lists.length === 0) return lines;
  lines.push('### SharePoint Lists');
  lines.push('');
  lines.push(`Source app reads/writes **${lists.length}** SharePoint list(s). Use \`/add-sharepoint\` per list to add the data source — each one becomes a generated service under \`src/generated/services/\`.`);
  lines.push('');
  lines.push('| List | Site | Notes |');
  lines.push('|---|---|---|');
  for (const l of lists) {
    const name = l && (l.displayName || l.name) ? '`' + (l.displayName || l.name) + '`' : '`(unnamed)`';
    const site = l && (l.siteUrl || l.site) ? '`' + truncateInline(l.siteUrl || l.site, 60) + '`' : '—';
    const notes = (l && l.notes) || '—';
    lines.push(`| ${name} | ${site} | ${notes} |`);
  }
  lines.push('');
  return lines;
}

function buildComponentLibrariesSectionLines(brief) {
  // Aggregate of external canvas-component library dependencies surfaced by
  // the schema-completion pass. Empty array on Dataverse-only / no-library
  // apps with no external component libraries — stay silent in that case so
  // the plan doesn't grow noise.
  const libs = toArray(brief && brief.app && brief.app.componentLibraries);
  const lines = [];
  if (libs.length === 0) return lines;
  lines.push('### External Component Libraries');
  lines.push('');
  lines.push(`Source app pulls **${libs.length}** external canvas-component library(ies). Each library must be re-ported as a React Native component package (or re-built inline) BEFORE the screen-builder runs \u2014 a screen instance of an external-lib control has no native fallback. Cross-reference per-control \`componentLibraryUniqueName\` to see exactly which screens depend on each library.`);
  lines.push('');
  lines.push('| Library unique name | Instances | Components |');
  lines.push('|---|---|---|');
  for (const lib of libs) {
    const name = '`' + ((lib && lib.uniqueName) || '(unnamed)') + '`';
    const count = (lib && lib.instanceCount) || 0;
    const comps = toArray(lib && lib.components);
    const compsCell = comps.length
      ? comps.slice(0, 5).map((c) => `\`${c.name}\` \u00d7${c.instances || 0}`).join(', ') + (comps.length > 5 ? `, \u2026 (+${comps.length - 5})` : '')
      : '\u2014';
    lines.push(`| ${name} | ${count} | ${compsCell} |`);
  }
  lines.push('');
  return lines;
}

function collectConnectorInventory(brief) {
  // Prefer the new `connectorInventory[]` shape from L1 (full ServiceInfo +
  // LCR join: apiId, connectionId, dataSources, custom/premium flags, etc).
  // Fall back to the legacy thin `connectors[]` (names only).
  const inv = toArray(brief && brief.dataModel && brief.dataModel.connectorInventory);
  // Per-screen `connectorsUsed[]` aggregation so the inventory can surface
  // which screens depend on each connector (drives `/add-connector` ordering
  // + screen-builder data-source hints).
  const screensByConnector = new Map();
  for (const s of toArray(brief && brief.screens)) {
    for (const c of toArray(s && s.connectorsUsed)) {
      const name = c && c.name;
      if (!name) continue;
      if (!screensByConnector.has(name)) screensByConnector.set(name, new Set());
      screensByConnector.get(name).add(s.name);
    }
  }
  // Custom connector entries are trusted only when L1 can identify an actual
  // custom connector API. Older briefs may contain LocalConnectionReference
  // GUID keys here; those are connection references, not connector APIs, and
  // adding them would send `/add-connector` after fake custom connectors.
  const customEntries = toArray(brief && brief.dataModel && brief.dataModel.customConnectors)
    .map((entry) => {
      if (typeof entry === 'string') return { name: entry, apiId: null, trusted: !isGuid(entry) };
      if (!entry) return null;
      const apiId = entry.apiId || entry.id || null;
      return {
        name: entry.name || entry.displayName || apiId,
        apiId,
        trusted: !!entry.isCustom || classifyConnector(apiId) === 'custom',
      };
    })
    .filter((entry) => entry && entry.name && entry.trusted);
  const out = [];
  const seen = new Set();
  if (inv.length > 0) {
    for (const c of inv) {
      const name = (c && c.name) || '(unnamed)';
      const apiId = (c && c.apiId) || null;
      const classification = classifyConnector(apiId);
      const datasets = toArray(c && c.dataSources)
        .map((d) => (d && d.name) || (typeof d === 'string' ? d : null))
        .filter(Boolean);
      const isCustom = !!(c && c.isCustom) || classification === 'custom';
      out.push({
        name,
        apiId,
        classification,
        connectionId: null,
        sourceConnectionPresent: !!(c && (c.sourceConnectionPresent || c.connectionId)),
        connectionRefDisplayName: null,
        authMode: (c && c.authMode) || null,
        isProvisioned: c && c.isProvisioned != null ? c.isProvisioned : null,
        isCustom,
        isPremium: !!(c && c.isPremium),
        // Plugin contract: any custom connector needs its Swagger fetched
        // before generated services have callable methods. Set true when
        // L1 flagged isCustom OR the apiId classifies as custom.
        requiresSchemaFetch: isCustom,
        datasets,
        dataSources: datasets, // alias kept for back-compat with existing readers
        actions: toArray(c && c.actions),
        screens: [...(screensByConnector.get(name) || [])].sort(),
        source: (c && c.source) || null,
      });
      seen.add(name);
    }
  } else {
    for (const c of toArray(brief && brief.dataModel && brief.dataModel.connectors)) {
      const name = (c && c.name) || String(c);
      if (!name || seen.has(name)) continue;
      out.push({
        name,
        apiId: null,
        classification: 'unknown',
        connectionId: null,
        connectionRefDisplayName: null,
        authMode: null,
        isProvisioned: null,
        isCustom: false,
        isPremium: false,
        requiresSchemaFetch: false,
        datasets: [],
        dataSources: [],
        actions: [],
        screens: [...(screensByConnector.get(name) || [])].sort(),
        source: 'legacy-connectors[]',
      });
      seen.add(name);
    }
  }
  // Merge trusted custom connectors so the plugin gets a complete list to
  // fetch schemas for — even when ServiceInfo/LCR didn't surface them.
  for (const custom of customEntries) {
    if (seen.has(custom.name)) continue;
    out.push({
      name: custom.name,
      apiId: custom.apiId || null,
      classification: 'custom',
      connectionId: null,
      connectionRefDisplayName: null,
      authMode: null,
      isProvisioned: null,
      isCustom: true,
      isPremium: false,
      requiresSchemaFetch: true,
      datasets: [],
      dataSources: [],
      actions: [],
      screens: [...(screensByConnector.get(custom.name) || [])].sort(),
      source: 'customConnectors[]',
    });
    seen.add(custom.name);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function sanitizeConnectorInventoryForTarget(inventory) {
  return toArray(inventory).map((connector) => {
    const classification = connector.classification || classifyConnector(connector.apiId);
    const environmentBoundApiId = classification === 'custom';
    return {
      ...connector,
      apiId: environmentBoundApiId ? null : normalizeApiId(connector.apiId),
      sourceApiIdPresent: environmentBoundApiId ? !!connector.apiId : false,
      connectionId: null,
    };
  });
}

function isGuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value || ''));
}

// Classify a connector by its `ApiId` into the mobile-plugin contract's
// vocabulary (`table` / `action` / `sql` / `sharepoint` / `flow` / `ai` /
// `dataverse` / `custom`). The plugin uses this to pick the right scaffold
// — `/add-dataverse` for tables, `/add-connector` for actions, etc.
function classifyConnector(apiId) {
  if (!apiId) return 'unknown';
  const s = String(apiId).toLowerCase();
  // Tabular sources (lists / tables / spreadsheets / blob — plugin treats
  // these as `/add-connector` with a list-style data source).
  if (s.includes('shared_sharepointonline')) return 'sharepoint';
  if (s.includes('shared_excelonlinebusiness') || s.includes('shared_excelonline')) return 'table';
  if (s.includes('shared_azureblob') || s.includes('shared_onedrive')) return 'table';
  if (s.includes('shared_sql')) return 'sql';
  // First-class Dataverse (rarely shows up in connectorInventory[] — usually
  // surfaces via dataverseTables[] instead).
  if (s.includes('shared_commondataservice') || s.includes('shared_cds')) return 'dataverse';
  // Cloud flows (filtered out of connectorInventory[] by L1 already, kept
  // here for defense-in-depth).
  if (s.includes('shared_logicflows') || s.includes('shared_flowmanagement')) return 'flow';
  // AI / Cognitive.
  if (s.includes('cognitiveservice') || s.includes('aibuilder') || s.includes('formrecognizer')) {
    return 'ai';
  }
  // Office 365 action APIs (Users, Outlook, Teams, etc).
  if (s.includes('shared_office365')) return 'action';
  // Custom connectors land here when ApiId carries a non-standard segment.
  if (s.includes('shared_') === false) return 'custom';
  return 'action';
}

function normalizeApiId(apiId) {
  if (!apiId) return null;
  const raw = String(apiId);
  const match = raw.match(/\/apis\/([^/]+)$/i);
  return match ? match[1] : raw;
}

function slugifyRequirementId(value, fallback) {
  const raw = String(value || fallback || 'connector')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return raw || 'connector';
}

function missingParameterStatus(parameterName) {
  return `needs-${String(parameterName || 'value')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()}`;
}

function buildConnectionRequirements(brief, connectorInventory) {
  const requirements = [];
  const seen = new Set();
  const sharepointLists = toArray(brief && brief.dataModel && brief.dataModel.sharepointLists);

  function addRequirement(row) {
    const idBase = row.id || row.connector || row.name || row.apiId || `requirement-${requirements.length + 1}`;
    let id = slugifyRequirementId(idBase, `requirement-${requirements.length + 1}`);
    let suffix = 2;
    while (seen.has(id)) id = `${slugifyRequirementId(idBase)}-${suffix++}`;
    seen.add(id);
    requirements.push({ ...row, id });
  }

  for (const connector of toArray(connectorInventory)) {
    if (!connector) continue;
    const classification = connector.classification || classifyConnector(connector.apiId);
    const apiId = classification === 'custom' ? null : normalizeApiId(connector.apiId);
    if (classification === 'flow') continue;
    const datasets = toArray(connector.datasets || connector.dataSources).filter(Boolean);
    const isTableLike = ['table', 'sql', 'sharepoint'].includes(classification);
    const missing = [];
    if (!apiId) missing.push('apiId');
    // Source connection IDs are intentionally redacted and are never portable
    // across environments. Every target resolves its own connection.
    missing.push('connectionId');
    if (isTableLike && datasets.length === 0) missing.push('dataset');
    const matchingSharePointLists = classification === 'sharepoint'
      ? sharepointLists.filter((list) => !datasets.length || datasets.includes(list.datasetName || list.name))
      : [];
    if (classification === 'sharepoint' && matchingSharePointLists.length === 0) missing.push('resourceName');
    const status = missing.length === 0 ? 'ready-to-add' : missingParameterStatus(missing[0]);

    addRequirement({
      connector: connector.name,
      apiId,
      classification,
      connectionId: null,
      sourceConnectionPresent: !!connector.sourceConnectionPresent,
      sourceApiIdPresent: !!connector.sourceApiIdPresent || (classification === 'custom' && !!connector.apiId),
      status,
      requiredParameters: missing,
      parameters: {
        datasets,
        sharepointLists: matchingSharePointLists.map((list) => ({
          name: list.name,
          datasetName: list.datasetName || null,
          tableName: list.tableName || null,
        })),
      },
      usedByScreens: toArray(connector.screens),
      usedOperations: toArray(connector.actions)
        .map((action) => action && (action.operationId || action.name || action))
        .filter(Boolean),
      authResources: toArray(connector.authResources),
      isPremium: !!connector.isPremium,
      isCustom: !!connector.isCustom,
      resolutionSkill: classification === 'sharepoint' ? '/add-sharepoint' : '/add-connector',
      source: connector.source || 'connectorInventory',
    });
  }

  for (const flow of toArray(brief && brief.dataModel && brief.dataModel.flows)) {
    if (!flow) continue;
    const sourceFlowIdPresent = !!(flow.flowId || flow.id || flow.guid);
    addRequirement({
      connector: flow.name || flow.displayName || 'unnamed-flow',
      apiId: normalizeApiId(flow.apiId) || 'shared_logicflows',
      classification: 'flow',
      connectionId: null,
      status: 'needs-flow-id',
      requiredParameters: ['flowId'],
      parameters: {
        flowId: null,
        workflowEntityId: null,
        sourceFlowIdPresent,
        sourceWorkflowEntityIdPresent: !!flow.workflowEntityId,
      },
      usedByScreens: toArray(flow.screens),
      usedOperations: toArray(flow.actions).map((action) => action && (action.name || action)).filter(Boolean),
      authResources: [],
      isPremium: false,
      isCustom: false,
      resolutionSkill: 'add-flow',
      source: 'flows',
    });
  }

  return requirements;
}

// ---------- Forms (§10.1) + host:ImagePicker downgrade (§8.3) ----------
//
// `collectForms(brief, loadedScreens, tables, connectorInventory)` walks the
// L1 form-mapping skeleton (`brief.forms[]` — one entry per Canvas Edit/Display
// form control) and joins three other substrates already in the brief:
//   - per-screen sidecars (`loadedScreens[].controls[]`) for the DataCard /
//     edit-child template + Required / Visible / Default formulas, plus
//     OnSelect / OnSuccess / OnFailure formulas elsewhere on the screen so
//     `submitAction` can be derived from `SubmitForm` / `Patch` / `<flow>.Run`.
//   - `tables[]` (already enriched by collectTables → P1a) for column type,
//     maxLength, required, and picklist options.
//   - `connectorInventory` so non-Dataverse forms can carry a contract-shaped
//     `boundTo` (e.g. `sharepoint:Suggestion`).
//
// Output is the §10.1 shape — boundTo / submitAction / fields[{name, label,
// type, required, maxLength, control, options?, visibleWhen?}].
//
// `applyImagePickerDowngrade(forms, brief, screenRows)` implements contract
// §8.3 + the §14 anti-pattern checklist: when a form field's `control` is
// `host:ImagePicker` / `host:FilePicker`, strip the corresponding `camera` /
// `attachment` / `image-picker` capability from that screen's per-screen
// `nativeCapabilities[]` AND from the top-level union (unless another screen
// still claims it). Records a `demotedCapabilities[]` audit trail so the
// reviewer can see exactly what got reclassified.

// Map a DataCard child edit-control template onto the §10.1 `control`
// vocabulary. Returns null if the child is not a recognizable input — the
// caller falls back to column-type inference.
function controlFromEditChildTemplate(child) {
  if (!child) return null;
  const tpl = String(child.template || '').toLowerCase();
  const kind = String(child.kind || '').toLowerCase();
  const k = tpl || kind;
  // Image / file pickers (the §8.3 case). Matches Canvas AddPicture, AddMedia,
  // AddPictureButton, Attachments.
  if (/^(addpicture|addmedia|attachments)/.test(k)) {
    if (/attachments/.test(k)) return 'host:FilePicker';
    return 'host:ImagePicker';
  }
  if (/^(camera|barcodereader|qr)/.test(k)) {
    // Camera / barcode reader inside a DataCard → treat like an image
    // contributor. Caller's DV-column type check still decides whether to
    // demote a screen-level `camera` capability.
    return 'host:ImagePicker';
  }
  if (/^(modern)?datepicker/.test(k) || /datetime/.test(k)) return 'date';
  if (/^toggle/.test(k) || /^(modern)?switch/.test(k)) return 'checkbox';
  if (/^checkbox/.test(k)) return 'checkbox';
  if (/^(combobox|dropdown|modern(combobox|dropdown))/.test(k)) return 'select';
  // Text inputs — multiline detection via Mode / Height / template name.
  if (/^(modern)?textinput|^text$|textareabox|richtexteditor/.test(k)) {
    const props = (child.properties) || {};
    const mode = stripLeadingEq(props.Mode || props.TextMode || '').toLowerCase();
    const height = Number(stripLeadingEq(props.Height || '0').replace(/[^0-9.]/g, '')) || 0;
    if (/multiline|multi/.test(mode)) return 'textarea';
    if (/^richtexteditor|textareabox/.test(k)) return 'textarea';
    if (height >= 80) return 'textarea';
    return 'input';
  }
  return null;
}

function controlEvidenceFromScaffold(card) {
  const scaffold = card && card.scaffold;
  if (!scaffold || !scaffold.valueTemplate) return null;
  return {
    template: scaffold.valueTemplate,
    kind: scaffold.valueTemplate,
    properties: {
      Default: scaffold.valueDefault,
      Items: scaffold.valueItems,
      OnChange: scaffold.valueOnChange,
    },
  };
}

// Pick a sensible `control` from a Dataverse column type when the per-card
// edit-child template was inconclusive. Mirrors the contract §10.1 vocabulary.
function controlFromColumnType(col) {
  if (!col) return 'input';
  switch (col.type) {
    case 'memo': return 'textarea';
    case 'picklist':
    case 'multipicklist':
    case 'status':
    case 'state':
    case 'lookup':
    case 'customer':
    case 'owner':
      return 'select';
    case 'boolean': return 'checkbox';
    case 'datetime': return 'date';
    case 'image': return 'host:ImagePicker';
    case 'file': return 'host:FilePicker';
    default: return 'input';
  }
}

// Look at the DataCard's child labels to derive a display string. Falls back
// through the DV column displayName, then the raw field name.
function deriveFieldLabel(card, children, column) {
  const cardProps = (card && card.properties) || {};
  const dn = stripLeadingEq(cardProps.DisplayName || '').trim();
  if (dn) {
    const lit = unquote(dn);
    if (lit) return lit;
  }
  const scaffoldLabel = stripLeadingEq((card && card.scaffold && card.scaffold.labelText) || '').trim();
  if (scaffoldLabel) {
    const lit = unquote(scaffoldLabel);
    if (lit && lit !== '*' && lit !== ':') return lit;
  }
  // Dataverse metadata is more reliable than arbitrary descendant labels;
  // generated cards often contain RequiredStar (`*`) and separator (`:`)
  // labels before their actual DataCardKey label.
  if (column && column.displayName) return column.displayName;
  // Look for a Label child carrying a literal Text formula.
  for (const c of children) {
    const k = String(c.kind || '').toLowerCase();
    const tpl = String(c.template || '').toLowerCase();
    if (k !== 'label' && !/label/.test(tpl)) continue;
    const txt = stripLeadingEq((c.properties && c.properties.Text) || '').trim();
    if (!txt) continue;
    const lit = unquote(txt);
    if (lit && lit !== '*' && lit !== ':') return lit;
  }
  return null;
}

function unquote(value) {
  if (!value) return null;
  // Power Fx string literal: single or double-quoted. Reject anything else
  // (treat as an expression → no literal label).
  const m = String(value).match(/^"((?:[^"\\]|\\.)*)"$/) || String(value).match(/^'((?:[^'\\]|\\.)*)'$/);
  return m ? m[1] : null;
}

// Boolean literal? Power Fx literal `true` / `false` (case-insensitive).
function isBooleanLiteral(value) {
  if (value == null) return null;
  const s = stripLeadingEq(String(value)).trim().toLowerCase();
  if (s === 'true') return true;
  if (s === 'false') return false;
  return null;
}

// Find the SubmitForm / Patch / <flow>.Run pattern targeting this form's data
// source anywhere on the screen, and translate it to a contract submitAction.
function deriveSubmitActionForForm(form, loadedScreen, brief) {
  // Display / View forms are read-only.
  const kind = String(form.formKind || '').toLowerCase();
  if (kind === 'displayform' || kind === 'viewform') return null;
  const formAlias = (form.formControl || '').split('/').pop();
  const ds = form.dataSource || form.table || null;
  if (!loadedScreen) return null;
  const flowNames = new Set(
    toArray(brief && brief.dataModel && brief.dataModel.flows)
      .map((f) => (f && f.name) || null)
      .filter(Boolean)
  );
  let sawSubmit = false;
  let sawPatch = false;
  let matchedFlow = null;
  for (const c of toArray(loadedScreen.controls)) {
    const props = c.properties || {};
    for (const key of Object.keys(props)) {
      const text = String(props[key] || '');
      if (!text) continue;
      if (!sawSubmit && formAlias) {
        const re = new RegExp('SubmitForm\\s*\\(\\s*' + escapeRegExp(formAlias) + '\\s*[\\),]', 'i');
        if (re.test(text)) sawSubmit = true;
      }
      if (!sawPatch && ds) {
        const re = new RegExp('Patch\\s*\\(\\s*\'?' + escapeRegExp(ds) + '\'?\\s*,', 'i');
        if (re.test(text)) sawPatch = true;
      }
      if (!matchedFlow) {
        for (const flowName of flowNames) {
          const re = new RegExp(powerFxIdentifierPattern(flowName) + '\\.Run\\s*\\(', 'i');
          if (re.test(text)) { matchedFlow = flowName; break; }
        }
      }
    }
  }
  if (sawSubmit) {
    // Disambiguate create vs update via the form's DefaultMode.
    const formCtrl = toArray(loadedScreen.controls).find((c) => c.path === form.formControl);
    const mode = stripLeadingEq(((formCtrl && formCtrl.properties) || {}).DefaultMode || '').trim();
    if (/FormMode\.New/i.test(mode)) return 'create';
    if (/FormMode\.Edit/i.test(mode)) return 'update';
    return 'update';
  }
  if (sawPatch) return 'patch';
  if (matchedFlow) return 'flow:' + matchedFlow;
  return null;
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function powerFxIdentifierPattern(name) {
  const raw = String(name || '');
  const bare = /^[A-Za-z_][A-Za-z0-9_]*$/.test(raw) ? escapeRegExp(raw) : null;
  const quoted = "'" + escapeRegExp(raw.replace(/'/g, "''")) + "'";
  return bare ? `(?:${bare}|${quoted})` : quoted;
}

function collectForms(brief, loadedScreens, tables, connectorInventory) {
  const rawForms = toArray(brief && brief.forms);
  if (rawForms.length === 0) return [];
  const tableByLogical = new Map();
  for (const t of toArray(tables)) {
    if (t && t.logicalName) tableByLogical.set(t.logicalName, t);
  }
  // Index connectors by each of their dataset / dataSource names so we can
  // turn a raw `dataSource` (e.g. `Suggestion`) into `sharepoint:Suggestion`.
  const connectorByDataset = new Map();
  for (const c of toArray(connectorInventory)) {
    for (const name of toArray(c && c.datasets)) {
      if (name) connectorByDataset.set(name, c);
    }
  }
  const backendCandidates = collectBackendCandidates(brief, tables, connectorInventory);
  // Local (in-memory) Canvas collections — used by `boundTo` to tag forms
  // that write to a ClearCollect/Collect target instead of a real backend.
  const localCollectionSet = new Set();
  for (const lc of toArray(brief && brief.dataModel && brief.dataModel.localCollections)) {
    const n = (lc && (lc.name || lc.displayName)) || null;
    if (n) localCollectionSet.add(String(n));
  }
  const screenByName = new Map();
  for (const s of toArray(loadedScreens)) {
    if (s && s.name) screenByName.set(s.name, s);
  }
  const out = [];
  for (const form of rawForms) {
    const screen = screenByName.get(form.screen) || null;
    const tableLogical = form.table || null;
    const table = tableLogical ? tableByLogical.get(tableLogical) || null : null;
    // Map of column logicalName → column record (for DV).
    const columnsByName = new Map();
    if (table) {
      for (const col of toArray(table.columns)) {
        if (!col || !col.name) continue;
        columnsByName.set(String(col.name).toLowerCase(), col);
        if (col.schemaName) columnsByName.set(String(col.schemaName).toLowerCase(), col);
        if (col.displayName) columnsByName.set(String(col.displayName).toLowerCase(), col);
      }
      for (const [alias, displayName] of Object.entries(table.columnDisplayNameMapping || {})) {
        const column = columnsByName.get(String(displayName).toLowerCase());
        if (column) columnsByName.set(String(alias).toLowerCase(), column);
      }
    }
    // Locate this form's DataCard children + each card's edit child in the
    // screen sidecar. The brief already enumerates `form.fields[].control`
    // (the DataCard path); the matching edit child is the first non-card
    // descendant.
    const allCtrls = screen ? toArray(screen.controls) : [];
    const fields = [];
    let derivedBoundToFromCards = null;
    for (const fld of toArray(form.fields)) {
      const cardPath = fld.control || null;
      const card = cardPath ? allCtrls.find((c) => c.path === cardPath) : null;
      const children = card
        ? allCtrls.filter((c) => c.path.startsWith(card.path + '/'))
        : [];
      // Edit child = first descendant that is NOT a TypedDataCard / DataCard
      // wrapper, and is something interactive (input / picker / toggle / etc).
      const editChild = children.find((c) => {
        const k = String(c.kind || '').toLowerCase();
        const tpl = String(c.template || '').toLowerCase();
        if (/typeddatacard|datacard/.test(tpl) || /^(typeddatacard|datacard)$/.test(k)) return false;
        if (/label/.test(k) || /label/.test(tpl)) return false;
        return true;
      }) || controlEvidenceFromScaffold(card);
      const cardProps = (card && card.properties) || {};
      const requiredRaw = stripLeadingEq(cardProps.Required || '').trim();
      const visibleRaw = stripLeadingEq(cardProps.Visible || '').trim();
      const defaultRaw = stripLeadingEq(cardProps.Default || '').trim();
      const dvCol = fld.dataField
        ? columnsByName.get(String(fld.dataField).toLowerCase()) || null
        : null;
      const reqLit = isBooleanLiteral(requiredRaw);
      const required = reqLit != null ? reqLit : (dvCol ? !!dvCol.required : false);
      const control = controlFromEditChildTemplate(editChild) || controlFromColumnType(dvCol);
      const label = deriveFieldLabel(card, children, dvCol) || fld.dataField || null;
      const fieldOut = {
        name: fld.dataField || null,
        label,
        type: dvCol ? dvCol.type : null,
        required,
        control,
      };
      if (dvCol && dvCol.maxLength != null) fieldOut.maxLength = dvCol.maxLength;
      if (dvCol && Array.isArray(dvCol.options)) fieldOut.options = dvCol.options.slice();
      if (dvCol && dvCol.type === 'lookup' && Array.isArray(dvCol.targets)) {
        fieldOut.lookupTargets = dvCol.targets.slice();
      }
      const visLit = isBooleanLiteral(visibleRaw);
      if (visLit === false) fieldOut.visibleWhen = visibleRaw || 'false';
      else if (visLit == null && visibleRaw && visibleRaw !== 'true') {
        fieldOut.visibleWhen = visibleRaw;
      }
      if (defaultRaw) fieldOut.defaultExpr = defaultRaw;
      // Preserve original source pointer for debugging / round-trip.
      fieldOut.sourceControl = cardPath || null;
      fields.push(fieldOut);
    }
    // Derive boundTo.
    let boundTo = null;
    let sourceBinding = null;
    if (tableLogical) boundTo = tableLogical;
    else if (form.dataSource) {
      // strip brackets / quotes that Canvas sometimes wraps around a name
      // (e.g. `[@Users]` → `Users`).
      const ds = String(form.dataSource).replace(/^\[@?|]$/g, '').replace(/^['"]|['"]$/g, '');
      const conn = connectorByDataset.get(ds) || connectorByDataset.get(form.dataSource);
      if (conn && conn.classification && conn.classification !== 'unknown') {
        boundTo = conn.classification + ':' + ds;
        sourceBinding = {
          kind: conn.classification,
          sourceName: ds,
          connector: conn.name || null,
          apiId: conn.apiId || null,
        };
      } else if (isCanvasDataSourceName(ds, loadedScreens)) {
        boundTo = 'external:' + ds;
        sourceBinding = {
          kind: 'unresolved-external',
          sourceName: ds,
          candidates: backendCandidates,
          note: 'Canvas formulas use this as a real data source, but source metadata did not expose a direct backend alias. Resolve before screen build.',
        };
      } else if (localCollectionSet.has(ds)) {
        // Canvas local (in-memory) collection. The screen-builder must
        // resolve the underlying persistence path (flow, SP list, …) — but
        // we tag the prefix so reviewers can see it isn't a real backend.
        boundTo = 'local:' + ds;
      } else {
        boundTo = ds;
      }
    }
    const submitAction = deriveSubmitActionForForm(form, screen, brief);
    out.push({
      screen: form.screen || null,
      formControl: form.formControl || null,
      formKind: form.formKind || null,
      boundTo,
      submitAction,
      fields,
      // Preserve the original brief shape so consumers needing the raw
      // dataSource (e.g., SharePoint list display name with no boundTo
      // table) still have it.
      dataSource: form.dataSource || null,
      table: form.table || null,
      tableDisplay: form.tableDisplay || null,
      sourceBinding,
    });
  }
  return out;
}

function collectBackendCandidates(brief, tables, connectorInventory) {
  const out = [];
  const seen = new Set();
  function add(candidate) {
    const key = JSON.stringify(candidate);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(candidate);
  }
  for (const t of toArray(tables)) {
    if (!t || !t.logicalName) continue;
    add({
      kind: 'dataverse',
      name: t.logicalName,
      displayName: t.displayName || t.logicalName,
      entitySetName: t.entitySetName || null,
    });
  }
  for (const sp of toArray(brief && brief.dataModel && brief.dataModel.sharepointLists)) {
    add({
      kind: 'sharepoint',
      name: sp.name || null,
      displayName: sp.displayName || sp.name || null,
      datasetName: sp.datasetName || null,
      tableName: sp.tableName || null,
      apiId: sp.apiId || null,
    });
  }
  for (const c of toArray(connectorInventory)) {
    const classification = c && (c.classification || classifyConnector(c.apiId));
    if (!c || classification === 'sharepoint' || classification === 'flow' || classification === 'action') continue;
    const dataSources = toArray(c.dataSources);
    const datasets = toArray(c.datasets);
    if (dataSources.length === 0 && datasets.length === 0) continue;
    add({
      kind: classification || 'connector',
      name: c.name || null,
      displayName: c.connectionRefDisplayName || c.name || null,
      apiId: c.apiId || null,
      datasets,
      dataSources,
    });
  }
  return out;
}

function isCanvasDataSourceName(name, loadedScreens) {
  if (!name) return false;
  const escaped = escapeRegExp(name);
  const patterns = [
    new RegExp(`\\[@${escaped}\\]`, 'i'),
    new RegExp(`\\b(DataSourceInfo|Choices)\\s*\\(\\s*(?:\\[@)?${escaped}\\b`, 'i'),
    new RegExp(`\\b(Patch|Remove|RemoveIf|Refresh|LookUp|Filter|First|FirstN|Sort|SortByColumns|Search|CountRows)\\s*\\(\\s*(?:\\[@)?${escaped}\\b`, 'i'),
  ];
  for (const screen of toArray(loadedScreens)) {
    for (const control of toArray(screen && screen.controls)) {
      const haystack = JSON.stringify({ properties: control.properties, events: control.events });
      if (patterns.some((re) => re.test(haystack))) return true;
    }
  }
  return false;
}

// Per-§8.3: capabilities to demote when a field's control becomes a host:*.
const FORM_HOST_DEMOTE_CAPS = ['camera', 'image-picker', 'gallery', 'attachment'];

function applyImagePickerDowngrade(forms, brief, screenRows) {
  const demoted = [];
  const screensTouched = new Map(); // screenName → Set<capability>
  for (const form of toArray(forms)) {
    for (const fld of toArray(form.fields)) {
      const ctrl = fld.control;
      if (ctrl !== 'host:ImagePicker' && ctrl !== 'host:FilePicker') continue;
      const screenName = form.screen;
      if (!screenName) continue;
      if (!screensTouched.has(screenName)) screensTouched.set(screenName, new Set());
      // Demote the camera-ish caps that would otherwise generate a wrapper.
      for (const cap of FORM_HOST_DEMOTE_CAPS) {
        screensTouched.get(screenName).add(cap);
      }
      demoted.push({
        screen: screenName,
        field: fld.name || null,
        boundTo: form.boundTo || null,
        control: ctrl,
        reason: 'Field-level host:* tag per contract §8.3 — screen-builder renders <ImagePicker>/<FilePicker> from @microsoft/power-apps-native-host; no native wrapper needed.',
      });
    }
  }
  if (screensTouched.size === 0) {
    return {
      capabilities: unique([
        ...toArray(brief && brief.nativeCapabilities),
        ...toArray(screenRows).flatMap((row) => toArray(row.nativeCapabilities)),
      ]),
      screenRows,
      demoted: [],
    };
  }
  // Strip the demoted caps from each screen's per-screen array (mutating
  // screenRows in place — these are local-only derived structures).
  const removedActually = new Set();
  for (const row of toArray(screenRows)) {
    const drops = screensTouched.get(row.name);
    if (!drops || drops.size === 0) continue;
    const before = toArray(row.nativeCapabilities);
    const after = before.filter((c) => {
      if (drops.has(c)) { removedActually.add(c); return false; }
      return true;
    });
    row.nativeCapabilities = after;
  }
  // Recompute top-level: keep cap iff at least one (remaining) screen claims
  // it. Preserve original order from brief.nativeCapabilities, then append
  // any caps a screen has that the top-level was missing.
  const remainingByScreen = new Set();
  for (const row of toArray(screenRows)) {
    for (const c of toArray(row.nativeCapabilities)) remainingByScreen.add(c);
  }
  const original = toArray(brief && brief.nativeCapabilities);
  const newTop = [];
  for (const c of original) {
    if (FORM_HOST_DEMOTE_CAPS.includes(c) && !remainingByScreen.has(c)) continue;
    newTop.push(c);
  }
  // Anything that ended up only in screens but wasn't in original (rare —
  // brief.nativeCapabilities is usually the union) still belongs in evidence.
  for (const c of remainingByScreen) {
    if (!newTop.includes(c)) newTop.push(c);
  }
  return {
    capabilities: newTop,
    screenRows,
    demoted,
  };
}

function buildNativeExecutionPlan(sourceCapabilities, bundledDeps) {
  // Canvas extraction deliberately captures both device APIs and UI/runtime
  // patterns. Step 9 may invoke /add-native only for the former. Screen-level
  // patterns (form/list/calendar/webview/dialog/etc.) stay as builder evidence.
  const rules = {
    camera: ['camera', 'expo-camera'],
    barcode: ['barcode-scanner', 'expo-camera'],
    'barcode-scanner': ['barcode-scanner', 'expo-camera'],
    'qr-scanner': ['qr-scanner', 'expo-camera'],
    attachment: ['document-picker', 'expo-document-picker'],
    'document-picker': ['document-picker', 'expo-document-picker'],
    'image-picker': ['image-picker', 'expo-image-picker'],
    audio: ['audio', 'expo-audio'],
    mic: ['audio', 'expo-audio'],
    video: ['video', 'expo-video'],
    location: ['location', 'expo-location'],
    geolocation: ['geolocation', '@microsoft/power-apps-native-bglocation'],
    signature: ['pen-input', '@microsoft/power-apps-native-pen-input'],
    'pen-input': ['pen-input', '@microsoft/power-apps-native-pen-input'],
    'pdf-viewer': ['pdf-viewer', '@microsoft/power-apps-native-pdf-viewer'],
    'pdf-report': ['pdf-report', 'expo-print'],
    persistence: ['file-system', 'expo-file-system'],
    'secure-store': ['secure-store', 'expo-secure-store'],
    'file-system': ['file-system', 'expo-file-system'],
    sharing: ['sharing', 'expo-sharing'],
    biometrics: ['biometrics', 'expo-local-authentication'],
    clipboard: ['clipboard', 'expo-clipboard'],
    'media-library': ['media-library', 'expo-media-library'],
    sensors: ['sensors', 'expo-sensors'],
    'screen-orientation': ['screen-orientation', 'expo-screen-orientation'],
    'device-info': ['device-info', 'expo-device'],
  };
  const entries = [];
  const handledSourceTags = new Set();
  for (const source of unique(toArray(sourceCapabilities))) {
    const rule = rules[String(source).toLowerCase()];
    if (!rule) continue;
    const [target, requiredPackage] = rule;
    if (requiredPackage && !bundledDeps.has(requiredPackage)) continue;
    entries.push({ source, target, requiredPackage });
    handledSourceTags.add(source);
  }
  return {
    capabilities: unique(entries.map((entry) => entry.target)).sort(),
    entries,
    handledSourceTags: [...handledSourceTags],
    sourceIntents: unique(toArray(sourceCapabilities)).sort(),
  };
}

// ---------- Inline self-test (Fix A regression guard) ----------
//
// Builds a synthetic mini-brief that exercises the camera→host:ImagePicker
// downgrade path (no real fixture in `runs/` has a Canvas AddPicture inside
// an Edit form bound to a DV Image column). Run via `--self-test`.

function runFormsSmokeTest() {
  const brief = {
    nativeCapabilities: ['camera', 'list', 'notification'],
    forms: [
      {
        screen: 'PantryIntake',
        formControl: 'PantryIntake/FormPantry',
        formKind: 'Form',
        dataSource: 'cr_pantryitem',
        table: 'cr_pantryitem',
        tableDisplay: 'Pantry Item',
        fields: [
          { control: 'PantryIntake/FormPantry/Name_DataCard', dataField: 'cr_name' },
          { control: 'PantryIntake/FormPantry/Photo_DataCard', dataField: 'cr_sitephoto' },
        ],
      },
    ],
    dataModel: { flows: [], dataverseTables: [{ logicalName: 'cr_pantryitem', displayName: 'Pantry Item' }] },
    screens: [{ name: 'PantryIntake', nativeCapabilities: ['camera', 'list'], layoutKind: 'form' }],
  };
  const screenRows = [
    { name: 'PantryIntake', nativeCapabilities: ['camera', 'list'], layoutKind: 'form' },
  ];
  const tables = [{
    logicalName: 'cr_pantryitem',
    displayName: 'Pantry Item',
    columns: [
      { name: 'cr_name', displayName: 'Name', type: 'string', maxLength: 100, required: true },
      { name: 'cr_sitephoto', displayName: 'Site Photo', type: 'image', required: false },
    ],
  }];
  const loadedScreens = [{
    name: 'PantryIntake',
    controls: [
      { path: 'PantryIntake/FormPantry', kind: 'Form', template: 'Form@2.4.4', properties: { DataSource: '=cr_pantryitem', DefaultMode: '=FormMode.New' } },
      { path: 'PantryIntake/FormPantry/Name_DataCard', kind: 'TypedDataCard', template: 'TypedDataCard@1.0.7', properties: { DataField: '="cr_name"', Required: '=true', Visible: '=true' } },
      { path: 'PantryIntake/FormPantry/Name_DataCard/Input1', kind: 'TextInput', template: 'TextInput@0.0.54', properties: {} },
      { path: 'PantryIntake/FormPantry/Photo_DataCard', kind: 'TypedDataCard', template: 'TypedDataCard@1.0.7', properties: { DataField: '="cr_sitephoto"', Required: '=false', Visible: '=true' } },
      { path: 'PantryIntake/FormPantry/Photo_DataCard/Add1', kind: 'AddPicture', template: 'AddPicture@2.0.0', properties: {} },
      { path: 'PantryIntake/SubmitBtn', kind: 'Button', template: 'Button@0.0.27', properties: { OnSelect: '=SubmitForm(FormPantry)' } },
    ],
  }];
  const forms = collectForms(brief, loadedScreens, tables, []);
  const fails = [];
  if (forms.length !== 1) fails.push('expected 1 form, got ' + forms.length);
  const f = forms[0];
  if (!f || f.boundTo !== 'cr_pantryitem') fails.push('boundTo expected cr_pantryitem, got ' + (f && f.boundTo));
  if (!f || f.submitAction !== 'create') fails.push('submitAction expected create, got ' + (f && f.submitAction));
  const nameField = f && f.fields.find((x) => x.name === 'cr_name');
  if (!nameField || nameField.control !== 'input') fails.push('cr_name expected control=input, got ' + (nameField && nameField.control));
  if (!nameField || nameField.maxLength !== 100) fails.push('cr_name expected maxLength=100, got ' + (nameField && nameField.maxLength));
  const photoField = f && f.fields.find((x) => x.name === 'cr_sitephoto');
  if (!photoField || photoField.control !== 'host:ImagePicker') {
    fails.push('cr_sitephoto expected control=host:ImagePicker, got ' + (photoField && photoField.control));
  }
  const dg = applyImagePickerDowngrade(forms, brief, screenRows);
  if (dg.capabilities.includes('camera')) fails.push('camera should have been demoted, capabilities=' + JSON.stringify(dg.capabilities));
  if (!dg.capabilities.includes('list')) fails.push('list should have survived, capabilities=' + JSON.stringify(dg.capabilities));
  const row = dg.screenRows[0];
  if (row.nativeCapabilities.includes('camera')) fails.push('per-screen camera should have been demoted');
  if (!dg.demoted.length) fails.push('demoted audit empty — expected 1 entry');
  if (fails.length) {
    console.error('FORMS SMOKE TEST FAILED:');
    for (const m of fails) console.error('  - ' + m);
    process.exit(5);
  }
  console.log('Forms self-test: OK (collectForms + applyImagePickerDowngrade)');
}

function buildBootstrapSectionLines(brief, startScreen) {
  const intents = toArray(brief.app && brief.app.onStartIntents);
  const lines = [];
  lines.push('### Bootstrap (App.OnStart)');
  lines.push('');
  if (intents.length === 0) {
    lines.push('_No `App.OnStart` intents captured._');
    lines.push('');
    return lines;
  }
  lines.push(`Source \`App.OnStart\` decomposed into **${intents.length}** intents. The screen-builder for the start screen (\`${startScreen}\`) MUST replicate these on app boot — either in \`app/_layout.tsx\` (for app-wide setup) or in the start screen's first \`useEffect\` (for screen-local state).`);
  lines.push('');
  // Group by intent type so the reader sees init pattern at a glance.
  const byKind = new Map();
  for (const it of intents) {
    const k = (it && it.intent) || 'unknown';
    if (!byKind.has(k)) byKind.set(k, []);
    byKind.get(k).push(it);
  }
  lines.push('| # | Intent | Target / Name | Detail |');
  lines.push('|---|---|---|---|');
  // Inline annotations for the verbs surfaced by the og-script update so the
  // Detail column carries the screen-builder hint without a separate table.
  const INTENT_NOTES = {
    exitApp: 'quit the app — native `Exit()`; web → `window.close()` fallback',
    clearOfflineData: 'review local persisted-cache clearing separately; a Dataverse Mobile Offline Profile is not an equivalent client cache API',
    showHostInfo: 'open native host-info dialog (PowerAppsNativeHost)',
    requestHide: 'send app to background (native only)',
  };
  intents.forEach((it, idx) => {
    const kind = it.intent || 'unknown';
    const targetCell = it.name || it.target || it.source || it.collection || it.form || '—';
    let detail = '—';
    if (it.expression) detail = '`' + truncateInline(it.expression, 100) + '`';
    else if (it.raw) detail = '`' + truncateInline(it.raw, 100) + '`';
    else if (it.from) detail = 'from `' + truncateInline(it.from, 100) + '`';
    else if (INTENT_NOTES[kind]) detail = INTENT_NOTES[kind];
    lines.push(`| ${idx + 1} | \`${kind}\` | \`${targetCell}\` | ${detail} |`);
  });
  lines.push('');
  // Surface any `unknown` intents with raw Power Fx so reviewers can decide
  // how to port them. These are the ones the brief generator could not parse.
  const unknowns = (byKind.get('unknown') || []).filter((i) => i.raw);
  if (unknowns.length) {
    lines.push('### Raw Power Fx (unparsed)');
    lines.push('');
    lines.push(`${unknowns.length} \`App.OnStart\` fragment(s) were not decomposed and need manual review:`);
    lines.push('');
    for (const u of unknowns) {
      lines.push(...pfxBlock(u.raw));
      lines.push('');
    }
  }
  return lines;
}

function buildFormsSectionLines(brief, structuredForms) {
  // Prefer the §10.1 structured shape (from `collectForms`) when supplied;
  // fall back to the raw `brief.forms` skeleton so callers that haven't been
  // wired up still get a Forms section (with the older columns).
  const forms = Array.isArray(structuredForms) && structuredForms.length > 0
    ? structuredForms
    : toArray(brief.forms);
  const lines = [];
  lines.push('### Forms');
  lines.push('');
  if (forms.length === 0) {
    lines.push('_No form controls in source app._');
    lines.push('');
    return lines;
  }
  lines.push(`Source had **${forms.length}** form control(s). Each entry below is the §10.1 contract shape — \`boundTo\` is the target data source (Dataverse logical name, \`sharepoint:<list>\`, or \`<connector>:<dataset>\`), \`submit\` is the inferred action (\`create\`/\`update\`/\`patch\`/\`flow:<name>\`). The screen-builder uses \`react-hook-form\` + \`zod\` (bundled) wired to the appropriate service. Fields whose \`control\` is \`host:ImagePicker\` / \`host:FilePicker\` MUST be rendered via the bundled \`@microsoft/power-apps-native-host\` pickers — DO NOT also emit a separate \`src/native/camera.ts\` wrapper for the same screen.`);
  lines.push('');
  lines.push('| # | Form | Screen | boundTo | Submit | Fields |');
  lines.push('|---|---|---|---|---|---|');
  forms.forEach((f, idx) => {
    const formName = (f.formControl || '').split('/').pop() || '(unnamed)';
    const screen = f.screen || '—';
    const boundCell = f.boundTo
      ? '`' + f.boundTo + '`'
      : (f.table ? '`' + f.table + '`' : '—');
    const submitCell = f.submitAction ? '`' + f.submitAction + '`' : '—';
    const fieldCount = Array.isArray(f.fields) ? f.fields.length : '?';
    lines.push(`| ${idx + 1} | \`${formName}\` | \`${screen}\` | ${boundCell} | ${submitCell} | ${fieldCount} |`);
  });
  lines.push('');
  // Per-form field listing — control / type / required / maxLength /
  // visibleWhen so the screen-builder gets the zod schema material directly.
  lines.push('### Per-form fields');
  lines.push('');
  for (const f of forms) {
    const formName = (f.formControl || '').split('/').pop() || '(unnamed)';
    const boundShort = f.boundTo || f.table || '—';
    lines.push(`#### \`${formName}\` — \`${f.screen || '—'}\` → \`${boundShort}\``);
    lines.push('');
    if (f.sourceBinding && f.sourceBinding.kind === 'unresolved-external') {
      const candidates = toArray(f.sourceBinding.candidates)
        .map((c) => `${c.kind || 'connector'}:${c.displayName || c.name || c.tableName || '?'}`)
        .join(', ') || 'none';
      lines.push(`> **Resolve data source:** Canvas uses \`${f.sourceBinding.sourceName}\` as a real data source, but the sidecar did not expose a direct backend alias. Candidate backing source(s): ${candidates}. Do not implement this form as local-only state until the backing source is confirmed.`);
      lines.push('');
    }
    const fields = toArray(f.fields);
    if (fields.length === 0) {
      lines.push('_No field detail captured (likely a wrapper form). Inspect the source control tree for the screen-builder._');
      lines.push('');
      continue;
    }
    lines.push('| Field | Label | Type | Control | Required | MaxLength | VisibleWhen | Options |');
    lines.push('|---|---|---|---|---|---|---|---|');
    for (const fld of fields) {
      const name = fld.name || fld.dataField || '?';
      const label = fld.label || '—';
      const type = fld.type || '—';
      const ctrl = fld.control || '—';
      const req = fld.required === true ? 'yes' : '—';
      const ml = fld.maxLength != null ? String(fld.maxLength) : '—';
      const vw = fld.visibleWhen
        ? '`' + truncateInline(fld.visibleWhen, 40) + '`'
        : '—';
      const opts = Array.isArray(fld.options) && fld.options.length
        ? `${fld.options.length} (e.g. ${fld.options.slice(0, 2).map((o) => `\`${o.label || o.value}\``).join(', ')}${fld.options.length > 2 ? ', …' : ''})`
        : '—';
      lines.push(`| \`${name}\` | ${label} | \`${type}\` | \`${ctrl}\` | ${req} | ${ml} | ${vw} | ${opts} |`);
    }
    lines.push('');
  }
  return lines;
}

function buildLocalizationSectionLines(brief, tables) {
  const loc = (brief && brief.localization) || null;
  const lines = [];
  lines.push('### Localization');
  lines.push('');
  if (!loc || (!loc.strategy && !toArray(loc.keys).length && !loc.translationTable)) {
    lines.push('_No localization strategy captured (single-locale app)._');
    lines.push('');
    return lines;
  }
  const strategy = loc.strategy || 'unknown';
  const tableDisplay = loc.translationTable || '—';
  const keys = toArray(loc.keys);
  lines.push(`- **Strategy:** \`${strategy}\``);
  lines.push(`- **Translation table (display name):** \`${tableDisplay}\``);
  lines.push(`- **Key count:** ${keys.length}`);
  lines.push('');
  // If the strategy implies a Dataverse table that isn't in the data-model
  // table list, flag it — the screen-builder will need it to render any
  // translated label.
  if (strategy === 'dataverse-translation-table' && tableDisplay) {
    const slug = tableDisplay.toLowerCase().replace(/[^a-z0-9]+/g, '');
    // Prefer the actual collection logical name detected from OnStart; fall
    // back to <publisher>_<slug>; fall back to a generic placeholder.
    const detected = detectTranslationCollectionLogical(brief);
    const prefix = PUBLISHER_PREFIX || detectPublisherPrefix(brief);
    const guessedLogical = detected || (slug && prefix ? `${prefix}_${slug}` : null);
    const haveTable = tables.some((t) =>
      t.displayName && t.displayName.toLowerCase() === tableDisplay.toLowerCase()
    ) || (guessedLogical && tables.some((t) => t.logicalName === guessedLogical));
    if (!haveTable) {
      const hint = guessedLogical || `${prefix || '<publisher>'}_<derived>`;
      lines.push(`> ⚠️ \`${tableDisplay}\` is **NOT** in the Data Model table list above. If localization is preserved, add this table during \`/add-dataverse\` (likely logical name \`${hint}\`) and wire a \`useTranslations()\` hook that reads it on app start.`);
      lines.push('');
    }
  }
  if (keys.length) {
    const sample = keys.slice(0, 12).map((k) => '`' + k + '`').join(', ');
    lines.push(`Sample keys: ${sample}${keys.length > 12 ? `, … (+${keys.length - 12})` : ''}`);
    lines.push('');
    lines.push('Full key list: [`localization.json`](localization.json).');
    lines.push('');
  }
  return lines;
}

function buildAssetsSectionLines(brief) {
  const assets = (brief && brief.assets) || null;
  const lines = [];
  lines.push('### Assets');
  lines.push('');
  if (!assets) {
    lines.push('_No asset catalog captured._');
    lines.push('');
    return lines;
  }
  const images = toArray(assets.images);
  const total = assets.totalResources != null ? assets.totalResources : images.length;
  const bundledCount = assets.bundledImageCount != null
    ? assets.bundledImageCount
    : images.filter((i) => i.isBundled).length;
  const uriCount = images.filter((i) => i.kind === 'Uri' || i.isBundled === false).length;
  const bundledBytes = assets.bundledTotalBytes != null
    ? assets.bundledTotalBytes
    : images.filter((i) => i.isBundled).reduce((sum, i) => sum + (i.sizeBytes || 0), 0);
  const kb = Math.round(bundledBytes / 1024);
  lines.push(`- **Total resources:** ${total}`);
  lines.push(`- **Bundled local files:** ${bundledCount} (~${kb} KB)`);
  lines.push(`- **URI / sample references:** ${uriCount}`);
  if (assets.logo) {
    lines.push(`- **App logo:** \`${assets.logo.fileName || assets.logo.diskPath || '?'}\` (${assets.logo.sizeBytes || '?'} bytes)`);
  }
  if (assets.iconName && assets.iconName !== 'None') {
    lines.push(`- **App icon:** \`${assets.iconName}\``);
  }
  if (assets.userLocale) lines.push(`- **Source locale:** \`${assets.userLocale}\``);
  if (assets.publishTarget) lines.push(`- **Publish target:** \`${assets.publishTarget}\``);
  lines.push('');
  // Per-screen asset usage so the screen-builder for each screen knows
  // exactly which images it has to import / copy.
  const byScreen = new Map();
  for (const img of images) {
    for (const sc of toArray(img.screens)) {
      if (!byScreen.has(sc)) byScreen.set(sc, []);
      byScreen.get(sc).push(img.name || img.fileName);
    }
  }
  if (byScreen.size > 0) {
    lines.push('### Per-screen usage');
    lines.push('');
    lines.push('| Screen | Asset count | Asset names |');
    lines.push('|---|---|---|');
    const screenNames = [...byScreen.keys()].sort();
    for (const sc of screenNames) {
      const names = byScreen.get(sc);
      const preview = names.slice(0, 8).map((n) => '`' + n + '`').join(', ');
      const suffix = names.length > 8 ? `, … (+${names.length - 8})` : '';
      lines.push(`| \`${sc}\` | ${names.length} | ${preview}${suffix} |`);
    }
    lines.push('');
  }
  lines.push('Full asset catalog (filenames, disk paths, mime types, per-screen usage): [`assets.json`](assets.json).');
  lines.push('');
  lines.push('> Copy only manifest-listed raster files from the unpacked-msapp `Assets/Images/` directory into `assets/images/`, preserving safe basenames so generated bindings resolve. SVG bytes remain an explicit follow-up unless the current app already allowlists a supported SVG renderer; do not assume `react-native-svg` is bundled. Validated HTTPS image URIs may load through the existing image component.');
  lines.push('');
  return lines;
}

function buildMasterPlan(brief, screenRows, connectors, tables, risks, screenFiles, swapAggregate, playbook, structuredForms, nativeExecution, demotedCapabilities, upgradeHintsAggregate, serverSideAssets, pcfPlan) {
  const appName = (brief.app && brief.app.name) || 'Converted Canvas App';
  const startScreen = (brief.app && brief.app.startScreen) || 'Unknown';
  const nativeCaps = toArray(nativeExecution && nativeExecution.capabilities);
  const sourceNativeIntents = toArray(nativeExecution && nativeExecution.sourceIntents);
  const handledSourceTags = new Set(toArray(nativeExecution && nativeExecution.handledSourceTags));
  const nativeTargetsForScreen = (screen) => unique(
    toArray(nativeExecution && nativeExecution.entries)
      .filter((entry) => toArray(screen.nativeCapabilities).includes(entry.source))
      .map((entry) => entry.target)
  ).sort();
  const today = GENERATION_TIMESTAMP.slice(0, 10);
  const fileByName = new Map(screenFiles.map((f) => [f.name, f]));
  const connectorInv = sanitizeConnectorInventoryForTarget(collectConnectorInventory(brief));
  const flowCount = toArray(brief.dataModel && brief.dataModel.flows).length;
  const hasDataverseTables = tables.length > 0;
  const hasConnectorOrFlowData = connectorInv.length > 0 || flowCount > 0;

  const lines = [];
  lines.push(`# ${appName} — Native App Plan`);
  lines.push('');
  lines.push('> Draft generated from a Power Platform brief by ' +
    '`scripts/adapt-app-brief-for-mobile-plugin.js`.');
  lines.push('> Review and approve this plan, then drop it into a fresh Expo template working dir and run ' +
    '`/create-mobile-app` — the planner picks it up as the resume-from-draft baseline.');
  lines.push('');
  if (hasDataverseTables && hasConnectorOrFlowData) {
    lines.push('> **Data backend:** Dataverse tables plus Power Platform connectors/flows are required. ' +
      'Dataverse screen data and writes go through generated services under `src/generated/`; connector and flow calls use their own generated services. ' +
      'Run `/add-dataverse` and the connector/flow add steps BEFORE the screen build pass.');
  } else if (hasDataverseTables) {
    lines.push('> **Data backend:** Dataverse tables are required. ' +
      'All Dataverse screen data and writes go through generated services under `src/generated/`. ' +
      'Run `/add-dataverse` BEFORE the screen build pass.');
  } else if (hasConnectorOrFlowData) {
    lines.push('> **Data backend:** No Dataverse tables were detected. ' +
      'Source data comes from Power Platform connectors and/or cloud flows; run the connector/flow add steps BEFORE the screen build pass.');
  } else {
    lines.push('> **Data backend:** No external data sources were detected. ' +
      'Screens should preserve local state and workflow behavior without inventing a backend.');
  }
  lines.push('');

  // Overview
  lines.push('## Overview');
  lines.push(`- **App name:** ${appName}`);
  // Source-app metadata surfaced by og-script update. Each is rendered only
  // when non-null so a sparse brief stays clean.
  const appDescription = brief.app && brief.app.settings && brief.app.settings.appDescription;
  if (appDescription) lines.push(`- **Source description:** ${truncateInline(String(appDescription), 200)}`);
  const hasSourceAuthor = !!(brief.app && brief.app.settings && (brief.app.settings.hasAuthorMetadata || brief.app.settings.author));
  if (hasSourceAuthor) lines.push('- **Source author metadata:** present (identity redacted)');
  lines.push('- **Target users:** <fill in>');
  lines.push('- **Target platforms:** ios, android');
  lines.push(buildFormFactorLine(brief));
  const brand = (brief.app && brief.app.brand) || {};
  lines.push(`- **Aesthetic:** <fill in — source primary ${brand.primaryColor || 'unknown'}>`);
  lines.push('- **Environment:** <fill in — resolved from `power.config.json` at scaffold time>');
  lines.push(`- **Start screen:** ${startScreen}`);
  lines.push(`- **Source format:** ${brief.source && brief.source.format || 'unknown'}`);
  lines.push('');
  // Operational flags from Properties.json (offline, PCF, telemetry, page
  // size, copilot binding). Helper returns [] when nothing is present.
  for (const l of buildSourceSettingsLines(brief)) lines.push(l);

  // App Requirements
  lines.push('## App Requirements');
  lines.push(`Rebuild the Canvas app **${appName}** as a native Power Apps mobile app (Expo / React Native / TypeScript) while preserving:`);
  if (hasDataverseTables && hasConnectorOrFlowData) {
    lines.push(`- The Dataverse data model plus connector/flow-backed integrations (${tables.length} tables, ${connectorInv.length} connectors, ${flowCount} flows).`);
  } else if (hasDataverseTables) {
    lines.push(`- The Dataverse data model (${tables.length} tables).`);
  } else if (hasConnectorOrFlowData) {
    lines.push(`- The connector/flow-backed data model (${connectorInv.length} connectors, ${flowCount} flows, 0 Dataverse tables).`);
  } else {
    lines.push('- The local collections and workflow state captured in the source (no external data sources detected).');
  }
  lines.push('- The full user journeys captured in the per-screen briefs.');
  lines.push('- Every interactive control: its events, formulas, and resulting state writes.');
  lines.push('');
  lines.push(`Source captured ${screenRows.length} screens, navigation edges, and per-control OnSelect/OnChange/OnCheck/OnUncheck/OnScan/OnSuccess intents.`);
  lines.push('');

  lines.push('### Generated Quality Gates');
  lines.push('The adapted app is not DONE until the generated project passes all of these checks:');
  lines.push('- `npm run gen:assets` regenerates `src/generated/assets.ts` from `assets.json`; missing/non-RN-ready files must be reported, not silently required.');
  lines.push('- `npm run check:i18n -- --strict` reports `unknown keys used: 0`. Screen code must use catalog keys from `localization.json`; for text that is not in the catalog, render the literal fallback instead of inventing a `t("...")` key.');
  lines.push('- `npm run check:coverage -- --min 80` passes per screen and overall. Shared implementations count at their screen call sites through exact `source-behavior` markers.');
  lines.push('- `npm run check:pcf -- --strict` passes: every explicitly approved PCF disposition is implemented with the exact PCF ID/disposition marker or approved visible unsupported UX.');
  lines.push('- `npm run check:scaffold -- --strict` passes: final screens must not expose conversion/debug scaffolding such as `CapabilityPanel`, `RelatedSources`, generic data-source lists, generic service registries (`serviceRegistry.ts`, `DATA_SOURCES`, `useDataSourceRows`), source/clone labels, or screen-config-driven next actions.');
  lines.push('- Screen implementations live directly in Expo Router files under `app/(app)/...`; do not generate `src/appScreens/*Screen.tsx` plus thin wrappers. Do not create `src/appScreens/` or `src/data/` support-code folders either — reusable mobile code belongs in domain folders such as `src/components/`, `src/hooks/`, `src/navigation/`, and `src/features/`.');
  lines.push('- `npx tsc --noEmit` is clean.');
  if (hasDataverseTables) {
    lines.push('- Source data-flow invariants are preserved with native state placement: route params carry navigation identity, app/provider state holds only cross-screen runtime state and optional full-row paint caches, Dataverse collections are loaded through domain hooks/query cache instead of Canvas-style global tables or generic service registries unless truly app-wide, screen-only UI flags stay local, ScreenShell sync surface is live-wired, and Dataverse custom columns are typed through extension models rather than broad `as never` payloads.');
  } else {
    lines.push('- Source data-flow invariants are preserved with native state placement: route params carry navigation identity, app/provider state holds only cross-screen runtime state and optional full-row paint caches, connector/list data is loaded through generated services plus domain hooks instead of Canvas-style global tables or generic service registries unless truly app-wide, screen-only UI flags stay local, and ScreenShell sync surface is live-wired.');
  }
  lines.push('');

  // Data Model
  lines.push('## Data Model');
  const reuseCount = tables.filter((t) => t.status === 'reuse').length;
  const extendCount = tables.filter((t) => t.status === 'extend').length;
  const newCount = tables.filter((t) => t.status === 'new').length;
  if (tables.length > 0) {
    lines.push(
      `Source app uses **${tables.length}** Dataverse table(s) — ` +
      `**${reuseCount} reuse** / **${extendCount} extend** / **${newCount} new** from source evidence.` +
      ` Preserve those statuses for Step 8; \`/add-dataverse\` revalidates each table against live target metadata and must not recreate a reused table.` +
      ` \`tier\` reflects topological order over Lookup dependencies (tier 1 has no FK deps; create in ascending order).`
    );
  } else {
    lines.push('No Dataverse tables in source. Skip `/add-dataverse`.');
    if (hasConnectorOrFlowData) {
      lines.push('Connector-backed data sources, SharePoint lists, and cloud flows are listed under `## Connectors`, `## SharePoint Lists`, and `## Flows`.');
    }
  }
  lines.push('');
  // Views column surfaces saved-query references from the brief (og-script
  // update). Screen-builder maps source view-bound galleries onto generated
  // `useViewQuery` hooks.
  const anyViews = tables.some((t) => t.views && t.views.length);
  if (anyViews) {
    lines.push('| Tier | Status | Logical name | Display name | Entity set | Cols | Operations | Views | Screens |');
    lines.push('|---|---|---|---|---|---|---|---|---|');
  } else {
    lines.push('| Tier | Status | Logical name | Display name | Entity set | Cols | Operations | Screens |');
    lines.push('|---|---|---|---|---|---|---|---|');
  }
  for (const t of tables) {
    const ops = t.operations.length ? t.operations.join(', ') : '—';
    const scr = t.screens.length ? t.screens.slice(0, 3).join(', ') + (t.screens.length > 3 ? `, … (+${t.screens.length - 3})` : '') : '—';
    const colCount = toArray(t.columns).length;
    const entitySet = t.entitySetName ? '`' + t.entitySetName + '`' : '—';
    const statusBadge = t.status === 'reuse' ? '✅ reuse' : t.status === 'extend' ? '🛠️ extend' : '🆕 new';
    if (anyViews) {
      const viewCell = (t.views && t.views.length)
        ? t.views.slice(0, 2).map((v) => '`' + (v.displayName || v.name) + '`').join('<br>') + (t.views.length > 2 ? `<br>+${t.views.length - 2}` : '')
        : '—';
      lines.push(`| ${t.tier} | ${statusBadge} | \`${t.logicalName}\` | ${t.displayName} | ${entitySet} | ${colCount} | ${ops} | ${viewCell} | ${scr} |`);
    } else {
      lines.push(`| ${t.tier} | ${statusBadge} | \`${t.logicalName}\` | ${t.displayName} | ${entitySet} | ${colCount} | ${ops} | ${scr} |`);
    }
  }
  lines.push('');
  lines.push('### Notes');
  lines.push('- Full column metadata (types, lookups, picklist options) lives in `mobile-plugin-input.json` → `dataModelPlan.dataverseTables[].columns[]`.');
  lines.push('- Relationships are inferred from Canvas lookups; verify with `npx power-apps add-data-source` during Step 8 of `/create-mobile-app`.');
  lines.push('- Tables with `Patch` / `RemoveIf` need write access in the connection.');
  lines.push('- Tables with only reads can be added read-only.');
  lines.push('');

  for (const l of buildServerSideAssetsSectionLines(serverSideAssets)) lines.push(l);

  // Forms (bind tables to editable fields — belongs next to Data Model)
  for (const l of buildFormsSectionLines(brief, structuredForms)) lines.push(l);

  // Native Capabilities
  lines.push('## Native Capabilities');
  if (nativeCaps.length === 0) {
    lines.push('None — this app uses only standard React Native components and Power Platform connectors.');
  } else {
    lines.push('| Capability | Screens |');
    lines.push('|---|---|');
    for (const cap of nativeCaps) {
      const sourceTags = toArray(nativeExecution.entries).filter((entry) => entry.target === cap).map((entry) => entry.source);
      const screensFor = screenRows
        .filter((s) => s.nativeCapabilities.some((source) => sourceTags.includes(source)))
        .map((s) => s.name);
      lines.push(`| ${cap} | ${screensFor.join(', ') || '—'} |`);
    }
  }
  const builderOnlyIntents = sourceNativeIntents.filter((capability) => !handledSourceTags.has(capability));
  if (builderOnlyIntents.length > 0) {
    lines.push('');
    lines.push('### Source Native and UI Intents — Builder/Review Only');
    lines.push('');
    lines.push('These source tags are preserved in per-screen evidence but MUST NOT be passed to `/add-native`. They map to screen-level composition, current allowlisted fallbacks, explicit unsupported states, or review decisions.');
    lines.push('');
    lines.push('| Source intent | Screens |');
    lines.push('|---|---|');
    for (const capability of builderOnlyIntents) {
      const screensFor = screenRows.filter((screen) => screen.nativeCapabilities.includes(capability)).map((screen) => screen.name);
      lines.push(`| ${capability} | ${screensFor.join(', ') || '—'} |`);
    }
  }
  for (const line of buildPcfPlanSectionLines(pcfPlan)) lines.push(line);
  // Surface the §8.3 demotions inline so reviewers can see exactly which
  // camera / attachment capabilities got reclassified into form host:* pickers.
  if (Array.isArray(demotedCapabilities) && demotedCapabilities.length > 0) {
    lines.push('');
    lines.push('### Demoted to form host:* pickers (anti-pattern §14)');
    lines.push('');
    lines.push('The following capabilities were dropped from the per-screen / top-level list because the same data flow is satisfied by a Dataverse-bound form field rendered through `host:ImagePicker` / `host:FilePicker` from `@microsoft/power-apps-native-host`. **Do NOT also generate `src/native/camera.ts` (or equivalent) for these screens** — the form field provides the entire capture path.');
    lines.push('');
    lines.push('| Screen | Field | boundTo | Control |');
    lines.push('|---|---|---|---|');
    for (const d of demotedCapabilities) {
      lines.push(`| \`${d.screen || '—'}\` | \`${d.field || '—'}\` | \`${d.boundTo || '—'}\` | \`${d.control || '—'}\` |`);
    }
  }
  lines.push('');

  // Native Capability Playbook — capability×intent×target clusters with
  // reusable-component suggestions. Built from the loaded per-screen JSONs.
  for (const l of buildNativeCapabilityPlaybookLines(playbook)) lines.push(l);

  // Bootstrap (App.OnStart) — init pattern the start screen must replicate
  for (const l of buildBootstrapSectionLines(brief, startScreen)) lines.push(l);

  // Localization — strategy + (sometimes) implies a missing Dataverse table
  for (const l of buildLocalizationSectionLines(brief, tables)) lines.push(l);

  // Assets — bundled image catalog with per-screen usage
  for (const l of buildAssetsSectionLines(brief)) lines.push(l);

  // Design
  lines.push('## Design Direction');
  lines.push(`- **Primary color:** ${brand.primaryColor || '<deferred — set by /design-system>'}`);
  lines.push(`- **Background color:** ${brand.backgroundColor || '<deferred>'}`);
  lines.push(`- **Text color:** ${brand.textColor || '<deferred>'}`);
  lines.push(`- **Fonts:** ${(brand.fonts && brand.fonts.join(', ')) || '<deferred>'}`);
  lines.push(`- **Theme name:** ${brand.themeName || '<deferred>'}`);
  lines.push('- **Direction:** preserve source palette; replace generic Canvas chrome with native list rows + native navigation.');
  lines.push('');

  // Connectors. Prefer the richer connectorInventory shape (og-script
  // update — friendly name + apiId + clean dataSources[]) when available;
  // falls back to the legacy bare-names list.
  lines.push('## Connectors');
  if (hasDataverseTables) {
    lines.push('- **Dataverse** — required for the tables in `## Data Model`.');
  } else {
    lines.push('- **Dataverse** — no Dataverse tables detected; skip `/add-dataverse` unless the user adds a Dataverse backend during review.');
  }
  if (connectorInv.length === 0) {
    lines.push('- No additional external connectors detected. Confirm during Gate 3 of `/create-mobile-app`.');
  } else {
    lines.push('');
    lines.push('| Connector | Class | API id | Custom | Schema fetch | Premium | Data sources | Screens |');
    lines.push('|---|---|---|---|---|---|---|---|');
    for (const c of connectorInv) {
      const apiCell = c.apiId ? '`' + c.apiId + '`' : '—';
      const dsCell = c.datasets && c.datasets.length
        ? c.datasets.slice(0, 4).map((d) => '`' + d + '`').join(', ') + (c.datasets.length > 4 ? `, … (+${c.datasets.length - 4})` : '')
        : '—';
      const scrCell = c.screens && c.screens.length
        ? c.screens.slice(0, 3).join(', ') + (c.screens.length > 3 ? `, … (+${c.screens.length - 3})` : '')
        : '—';
      const customCell = c.isCustom ? '⚠️ custom' : '—';
      const premiumCell = c.isPremium ? 'yes' : '—';
      // requiresSchemaFetch is the plugin's signal for its post-install
      // `generate-connector-schemas` script: 'pending' means the typed
      // service stub will be empty until the Swagger is fetched from the
      // tenant via `pac connector download --api-id <apiId>`.
      const schemaCell = c.requiresSchemaFetch ? '🟡 pending' : '—';
      lines.push(`| ${c.name} | \`${c.classification}\` | ${apiCell} | ${customCell} | ${schemaCell} | ${premiumCell} | ${dsCell} | ${scrCell} |`);
    }
    lines.push('');
    lines.push('Run `/add-connector` per connector with the exact target API/connection identity. Generated services appear under `src/generated/services/`; after adding a custom connector, run the template\'s `npm run generate-schemas` flow and review any unresolved schema rather than using a nonexistent special skill mode.');
  }
  lines.push('');

  // Flows + SharePoint Lists + Component Libraries — sibling integration
  // sections, each only emits when the brief has entries so single-Dataverse
  // apps stay clean.
  for (const l of buildFlowsSectionLines(brief)) lines.push(l);
  for (const l of buildSharePointListsSectionLines(brief)) lines.push(l);
  for (const l of buildComponentLibrariesSectionLines(brief)) lines.push(l);

  // Native Control Mapping — single canonical table of every bundled-library
  // swap the screen-builder must use across the whole app. Each per-screen
  // plan also carries its own ## Native replacements subset.
  lines.push('### Native Control Mapping');
  lines.push('');
  lines.push('> The mobile target uses bundled native libraries instead of replicating Canvas controls one-for-one. Every library cited below is already in [`template/package.json`](../../../../template/package.json). Hard rule: **no new native RN libraries** (the rewrap binary is prebuilt). Each per-screen plan repeats the subset that applies to that screen under `## Native replacements`.');
  lines.push('');
  if (!swapAggregate || swapAggregate.length === 0) {
    lines.push('_No bundled-library swaps matched in this app._');
    lines.push('');
  } else {
    lines.push('| Canvas pattern | Recommended primitive | Library | Bundled? | Screens matched |');
    lines.push('|---|---|---|---|---|');
    for (const entry of swapAggregate) {
      const swap = entry.swap;
      const libCell = swap.lib ? '`' + swap.lib + '`' : '_no bundled lib_';
      const bundled = swap.lib ? 'yes' : '**no — see notes**';
      const screensCell = entry.screens.length > 6
        ? entry.screens.slice(0, 6).map((n) => '`' + n + '`').join(', ') + `, … (+${entry.screens.length - 6})`
        : entry.screens.map((n) => '`' + n + '`').join(', ');
      lines.push(`| ${swap.label} | ${swap.component} | ${libCell} | ${bundled} | ${screensCell} |`);
    }
    lines.push('');
    // Surface notes/risks once at the top so reviewers don't have to open every
    // screen file to learn why a row says "no bundled lib".
    const withNotes = swapAggregate.filter((e) => e.swap.notes || e.swap.risk);
    if (withNotes.length) {
      lines.push('### Notes & risks');
      lines.push('');
      for (const entry of withNotes) {
        const swap = entry.swap;
        if (swap.notes) lines.push(`- **${swap.label}** — ${swap.notes}`);
        if (swap.risk) lines.push(`  - Risk: [${swap.risk.severity}] \`${swap.risk.code}\` — ${swap.risk.message}`);
      }
      lines.push('');
    }
  }

  // Canvas Anti-Patterns — "intent over control" upgrades. Where the maker
  // reached for a Canvas workaround (HtmlViewer, pixel positioning, stacked
  // Labels mimicking a list) the screen-builder must replace with the
  // recommended native primitive. Each per-screen plan repeats the subset
  // that applies to it under `## Upgrade Hints`.
  lines.push('### Canvas Anti-Patterns Detected');
  lines.push('');
  lines.push('> **Intent over control.** Canvas controls are *evidence of maker intent*, not a binding output spec. When the maker used a Canvas escape-hatch (HTML preview, absolute X/Y, manual list composition), the screen-builder MUST upgrade to the recommended native primitive. See [`shared/references/canvas-to-native-mapping.md`](../../../../shared/references/canvas-to-native-mapping.md) for the full translation hierarchy.');
  lines.push('');
  if (!upgradeHintsAggregate || upgradeHintsAggregate.length === 0) {
    lines.push('_No Canvas anti-patterns detected. The screen-builder may map controls 1:1 using the Native Control Mapping table above._');
    lines.push('');
  } else {
    lines.push('| Anti-pattern | Severity | Screens affected | Reference |');
    lines.push('|---|---|---|---|');
    for (const h of upgradeHintsAggregate) {
      const screensCell = h.screens.length > 6
        ? h.screens.slice(0, 6).map((n) => '`' + n + '`').join(', ') + `, … (+${h.screens.length - 6})`
        : h.screens.map((n) => '`' + n + '`').join(', ');
      lines.push(`| ${h.label} | \`${h.severity}\` | ${screensCell} | [\`${h.id}\`](../../../../${h.reference}) |`);
    }
    lines.push('');
    lines.push('### Recommended native replacements');
    lines.push('');
    for (const h of upgradeHintsAggregate) {
      lines.push(`- **${h.label}** (\`${h.severity}\`, ${h.screens.length} screen${h.screens.length === 1 ? '' : 's'}) — ${h.recommendedNative}`);
    }
    lines.push('');
  }

  // Screens
  lines.push('## Screens');
  lines.push('');
  lines.push('### Navigation Pattern');
  lines.push('**Stack** — preserve the source screen graph first. Gate 4 may explicitly promote a small set of destinations into Tabs or Drawer after reviewing the imported workflow.');
  lines.push(`- Source start screen: \`${startScreen}\` → native route \`/(app)/home\`.`);
  lines.push('');
  lines.push('### Screen Map');
  lines.push('');
  lines.push('| Screen | Route | File | Presentation | Purpose | Data | Native | Source |');
  lines.push('|---|---|---|---|---|---|---|---|');
  lines.push('| Splash | `/` | `app/index.tsx` | default | Auth-aware redirect | — | — | template (keep) |');
  lines.push('| Login | `/login` | `app/login.tsx` | default | MSAL sign-in | — | — | template (keep) |');
  lines.push('| OAuth callback | `/oauth-callback` | `app/oauth-callback.tsx` | default | Connector consent return | — | — | template (keep) |');
  screenRows.forEach((s) => {
    const data = unique([...s.dataverseTablesUsed, ...s.connectorsUsed]).join(', ') || '—';
    const native = nativeTargetsForScreen(s).join(', ') || '—';
    lines.push(`| ${markdownTableText(s.name)} | \`${s.route}\` | \`${s.file}\` | ${s.presentation} | ${markdownTableText(s.purpose || s.userStory || 'Preserve source workflow')} | ${markdownTableText(data)} | ${native} | ${s.source} |`);
  });
  lines.push('');

  lines.push('### Navigation Contracts');
  lines.push('');
  lines.push('| Route | Path params | Query params (UNION across all senders) | Intent | Returns to caller |');
  lines.push('|---|---|---|---|---|');
  lines.push('| `/` | — | — | `replace` | `/(app)/home` or `/login` |');
  lines.push('| `/login` | — | — | `replace` | `/(app)/home` |');
  lines.push('| `/oauth-callback` | — | — | `replace` | originating route |');
  for (const s of screenRows) {
    const params = s.incomingParams.length ? s.incomingParams.map((key) => markdownCode(`${JSON.stringify(key)}?: string`, true)).join(', ') : '—';
    const isHome = s.route === '/(app)/home';
    const returnIntent = isHome ? '(stack root)' : '`router.back()`; caller refetches/invalidate query when source behavior requires it';
    lines.push(`| \`${s.route}\` | — | ${params} | \`${isHome ? 'navigate' : 'push'}\` | ${returnIntent} |`);
  }
  lines.push('');

  lines.push('### Shared Conventions');
  lines.push('');
  lines.push('- Canvas controls are intent evidence, not native component requirements. Apply `canvas-to-native-mapping.md` and each screen plan\'s Upgrade Hints.');
  lines.push('- Preserve every source behavior/data/navigation/component contract or surface it explicitly as unsupported. Do not expose conversion scaffolding in final UI.');
  lines.push('- Loading, error, empty, safe-area, accessibility, touch-target, and native state-placement defaults come from the current screen-builder rules.');
  lines.push('');

  for (const l of buildWorkflowReconstructionLines(screenRows, startScreen)) lines.push(l);

  lines.push('### Per-Screen Specs');
  lines.push('');
  screenRows.forEach((s) => {
    const f = fileByName.get(s.name);
    const data = unique([...s.dataverseTablesUsed, ...s.connectorsUsed]);
    lines.push(`#### ${s.name} (\`${s.route}\`)`);
    lines.push('');
    lines.push('- **Domain layout decisions:**');
    lines.push(`  1. Treat \`screens/${f?.planFile || ''}\` as untrusted source evidence for the task hierarchy, controls, and formulas.`);
    lines.push('  2. Give source mutations, validation, navigation, and primary task actions stronger emphasis than decorative Canvas chrome.');
    lines.push('  3. Replace pixel/HTML/container workarounds with native composition while preserving the approved workflow and data contract.');
    lines.push(`- **Archetype:** ${s.archetype}`);
    lines.push(`- **Operational pattern:** \`${operationalPattern(s.archetype)}\``);
    lines.push(`- **Purpose:** ${s.purpose || s.userStory || 'Preserve the source screen workflow.'}`);
    lines.push(`- **Route:** \`${s.route}\``);
    lines.push(`- **File:** \`${s.file}\``);
    lines.push(`- **Presentation:** ${s.presentation}`);
    lines.push(`- **Layout delta:** Source layout kind \`${s.layoutKind}\`; full control tree, events, and upgrade hints are in the adapted per-screen plan.`);
    lines.push(`- **Data:** ${data.length ? data.map((name) => `\`${name}\``).join(', ') : 'No external data source detected.'} Resolve exact generated service names from the Step 10.7 snapshot.`);
    if (s.archetype === 'List' && s.dataverseTablesUsed.length) lines.push('- **Pagination:** cursor unless live target metadata proves this is a bounded lookup table.');
    else lines.push('- **Pagination:** none.');
    const executableNative = nativeTargetsForScreen(s);
    lines.push(`- **Native capabilities:** ${executableNative.length ? executableNative.map((name) => `\`${name}\``).join(', ') : 'none'}.`);
    lines.push(`- **Source native/UI intents:** ${s.nativeCapabilities.length ? s.nativeCapabilities.map((name) => `\`${name}\``).join(', ') : 'none detected'}; preserve as evidence, not automatic package work.`);
    const navigation = s.outgoingNavigation.map((edge) => {
      const params = edge.contextKeys.length ? ` with params { ${edge.contextKeys.map((key) => `${JSON.stringify(key)}: string`).join(', ')} }` : '';
      return `${markdownCode(edge.trigger || 'source action')} → \`router.push('${edge.route || edge.to}')\`${params}`;
    });
    lines.push(`- **Navigation:** ${navigation.length ? navigation.join('; ') : 'no outgoing source navigation detected'}.`);
    lines.push('- **State delta:** Use `state/app-state.md` placement recommendations; keep screen-only flags local and server collections query-backed.');
    lines.push('- **Key user actions:** Implement the normalized actions, visibility, validation, and derivation entries for this screen from `behaviors.json`.');
    lines.push('');
  });

  lines.push('### Adapted per-screen evidence');
  lines.push('');
  lines.push('Each screen has a dedicated plan file under `screens/`. Large screens are split into `<Name>.plan.md` (summary + control tree) plus `<Name>.controls.md` (verbatim Power Fx for every interactive control). The screen-builder agent reads both files for any split screen.');
  lines.push('');
  for (const s of screenRows) {
    const f = fileByName.get(s.name);
    if (!f) continue;
    const planLink = `[\`screens/${f.planFile}\`](screens/${f.planFile})`;
    const extra = f.controlsFile ? ` + [\`screens/${f.controlsFile}\`](screens/${f.controlsFile})` : '';
    lines.push(`- **${s.name}** — ${planLink}${extra} (${f.controlCount} controls, ${f.lineCount} lines, mode: ${f.mode})`);
  }
  lines.push('');

  // Per-screen detail link list above already covers each screen's plan file.
  // Per-screen ## Native replacements blocks (calendar, datepicker, toggle, …)
  // are rendered inside each screen file by `buildNativeReplacementsLines`.

  lines.push('### Shared resources');
  lines.push('');
  lines.push('- [`components.md`](components.md) — catalog of reusable custom components (Header, Footer, …).');
  lines.push('- [`state/app-state.md`](state/app-state.md) — `var_*` / `col_*` writers, readers, and recommended native placement (local state, route params, query cache, bootstrap, or app state).');
  lines.push('');

  // Risks
  if (risks.length) {
    lines.push('### Risks Carried From Source');
    for (const r of risks) {
      lines.push(`- **[${r.severity}]** \`${r.code}\` — ${r.message}`);
    }
    lines.push('');
  }

  // Provenance
  lines.push('### Plan Provenance');
  lines.push('- Generated by: `scripts/adapt-app-brief-for-mobile-plugin.js`');
  lines.push(`- Source: \`${(brief.source && brief.source.extractedPath) || 'app-brief.json'}\``);
  lines.push(`- Source format: ${brief.source && brief.source.format || 'unknown'}`);
  lines.push(`- Date: ${today}`);
  lines.push('');

  return lines.join('\n') + '\n';
}

function buildWorkflowReconstructionLines(screenRows, startScreen) {
  const rows = toArray(screenRows);
  const byName = new Map(rows.map((row) => [row.name, row]));
  const incoming = new Map();
  for (const row of rows) {
    for (const target of toArray(row.outgoingTo)) {
      incoming.set(target, (incoming.get(target) || 0) + 1);
    }
  }
  const roots = unique([
    startScreen,
    ...rows.filter((row) => !incoming.has(row.name)).map((row) => row.name),
  ]).filter((name) => byName.has(name));

  const lines = [];
  lines.push('### Workflow Reconstruction');
  lines.push('');
  lines.push('The mobile app should be built around these inferred user journeys, not around a visible screen/data-source inventory. Screen builders should turn each journey into explicit mobile CTAs, filters, rows, forms, and summaries. Do **not** expose conversion scaffolding such as "Related sources", "Capabilities", clone labels, or generic next-screen buttons in the final UI.');
  lines.push('');
  if (roots.length === 0) {
    lines.push('_No navigation roots inferred; use the Screen Map as fallback._');
    lines.push('');
    return lines;
  }

  lines.push('| Journey root | Inferred path | Builder guidance |');
  lines.push('|---|---|---|');
  for (const root of roots.slice(0, 12)) {
    const chain = [];
    const seen = new Set();
    let current = root;
    for (let i = 0; i < 7 && current && !seen.has(current); i += 1) {
      seen.add(current);
      chain.push(current);
      const row = byName.get(current);
      const next = toArray(row && row.outgoingTo).find((target) => byName.has(target) && !seen.has(target));
      current = next || '';
    }
    const guidance = chain.length > 1
      ? 'Use named actions between these screens; carry full-row state across the path.'
      : 'Make this screen self-contained; hide implementation/source inventory copy.';
    lines.push(`| \`${root}\` | ${chain.map((name) => '`' + name + '`').join(' → ')} | ${guidance} |`);
  }
  lines.push('');
  lines.push('### Workflow polish rules');
  lines.push('- Replace generic list rows with domain rows/cards using the fields the source gallery displayed.');
  lines.push('- Replace generic `NextActions` with explicit domain commands derived from the imported behaviors, such as Create, Review, Save draft, Attach, or Duplicate.');
  lines.push('- Replace `RelatedSources` and data-source chips with actual business filters, totals, or summaries.');
  lines.push('- Keep screen metadata/config internal to route/layout code; do not render it as user-facing explanation.');
  lines.push('');
  return lines;
}

// ---------- Secondary outputs ----------

function buildRequirementsBrief(brief, screenRows, connectors, tables) {
  const appName = (brief.app && brief.app.name) || 'Converted Canvas App';
  const startScreen = (brief.app && brief.app.startScreen) || 'Unknown';
  const nativeCaps = toArray(brief.nativeCapabilities);

  const lines = [];
  lines.push('# Requirements Brief For Mobile App Plugin');
  lines.push('');
  lines.push(`App name: ${appName}`);
  lines.push(`Start screen: ${startScreen}`);
  lines.push(`Auth mode: ${(brief.app && brief.app.auth) || 'unknown'}`);
  lines.push('');
  lines.push('## Functional scope');
  lines.push('- Rebuild the app as an Expo React Native mobile app via the mobile-app plugin.');
  lines.push('- Preserve every screen and every interactive control captured in `screens/*.plan.md`.');
  lines.push('- Keep Dataverse semantics and table-level CRUD behavior.');
  lines.push('');
  lines.push('## Data scope');
  lines.push(`- Dataverse tables: ${tables.length}`);
  for (const t of tables) {
    const opHint = t.operations.length ? ' ops=' + t.operations.join('|') : '';
    lines.push(`- ${t.displayName} (${t.logicalName})${opHint}`);
  }
  lines.push('');
  lines.push('## Connector scope');
  lines.push('- Dataverse (required, always).');
  if (connectors.length === 0) {
    lines.push('- No additional external connectors detected in source.');
  } else {
    for (const c of connectors) lines.push(`- ${c}`);
  }
  lines.push('');
  lines.push('## Screen scope');
  lines.push(`- Total screens: ${screenRows.length}`);
  for (const s of screenRows) {
    const outs = s.outgoingTo.length ? ' -> ' + s.outgoingTo.join(', ') : '';
    lines.push(`- ${s.name} [${s.layoutKind}]${outs}`);
  }
  lines.push('');
  lines.push('## Native capability scope');
  if (nativeCaps.length === 0) lines.push('- No explicit native capabilities inferred.');
  else for (const cap of nativeCaps) lines.push('- ' + cap);
  return lines.join('\n') + '\n';
}

function buildMigrationChecklist(brief, connectors, tables, risks, serverSideAssets, pcfPlan) {
  const lines = [];
  const flows = toArray(brief.dataModel && brief.dataModel.flows);
  lines.push('# Migration Checklist To Working Mobile App');
  lines.push('');
  let step = 1;
  lines.push(`${step++}. Prepare fresh Expo template folder and run \`npm install\`.`);
  lines.push(`${step++}. Copy \`native-app-plan.md\` and the entire \`screens/\` directory into the working dir.`);
  lines.push(`${step++}. Run \`/create-mobile-app\` — it resumes from the draft plan.`);
  if (tables.length > 0) {
    lines.push(`${step++}. **HARD GATE:** run \`/add-dataverse\` for all ${tables.length} tables BEFORE the screen build pass.`);
  } else {
    lines.push(`${step++}. Skip \`/add-dataverse\` unless review adds Dataverse tables; source has 0 Dataverse tables.`);
  }
  if (connectors.length > 0) {
    const connectorSummary = connectors.slice(0, 8).join(', ') + (connectors.length > 8 ? `, … (+${connectors.length - 8})` : '');
    lines.push(`${step++}. Add external connectors before screen build: ${connectorSummary}.`);
  } else {
    lines.push(`${step++}. No external connectors detected — confirm with user.`);
  }
  if (flows.length > 0) {
    const flowSummary = flows.map((f) => f.name || f.displayName || f.flowId || f.id || 'unnamed-flow').slice(0, 8).join(', ') + (flows.length > 8 ? `, … (+${flows.length - 8})` : '');
    lines.push(`${step++}. Add cloud flows with \`npx power-apps add-flow\`: ${flowSummary}.`);
  }
  if (pcfPlan?.discovery?.complete === false) {
    lines.push(`${step++}. **HARD BLOCK:** obtain a complete PCF control inventory/specification; source reports PCF content but per-control contracts were unavailable.`);
  } else if (pcfPlan?.stats?.total > 0) {
    lines.push(`${step++}. **HARD GATE:** explicitly approve all ${pcfPlan.stats.total} PCF dispositions in Gate 2b before native/connector/screen work.`);
  }
  if (tables.length > 0) {
    const assetCount = serverSideAssets && serverSideAssets.stats ? serverSideAssets.stats.total : 0;
    lines.push(`${step++}. Confirm Dataverse server-side logic in the target environment: business rules, calculated/rollup columns, plug-ins, custom APIs/actions, and classic workflows that the source app depends on${assetCount ? ` (${assetCount} column-level assets inventoried in \`server-side-assets.json\`)` : ''}.`);
  }
  lines.push(`${step++}. Implement navigation graph and screens from \`screens/<Name>.plan.md\` (+ \`.controls.md\` where split).`);
  lines.push(`${step++}. Resolve unsupported formula items flagged in \`## Risks\`.`);
  lines.push(`${step++}. Run typecheck, strict i18n, asset generation, behavior coverage, and route contract checks before launch.`);
  lines.push('');
  lines.push('## Validation gates');
  if (tables.length > 0) {
    lines.push('- Every Dataverse table in `## Data Model` is generated and importable.');
  }
  if (connectors.length > 0) {
    lines.push('- Every connector listed in `## Connectors` is added and has an importable generated service.');
  }
  if (flows.length > 0) {
    lines.push('- Every cloud flow listed in `flows.json` is added with `npx power-apps add-flow` and has an importable generated service.');
  }
  if (tables.length > 0) {
    lines.push('- Target Dataverse environment contains any source business rules, calculated/rollup columns, plug-ins, custom APIs/actions, and classic workflows needed for the app. Missing server-side logic is documented as a manual follow-up, not silently reimplemented in screen code.');
    lines.push('- `server-side-assets.json` is reviewed before implementing write handlers. Calculated/rollup/server-managed columns are excluded from create/update payloads and read from Dataverse instead of recomputed ad hoc in screen code.');
  }
  lines.push('- All screens listed in `## Screens` are present and route as specified.');
  lines.push('- `npm run gen:assets` succeeds and reports missing assets explicitly.');
  lines.push('- `npm run check:i18n -- --strict` reports zero unknown keys. Do not invent translation keys; use literals when the source catalog does not contain the key.');
  lines.push('- `npm run check:coverage -- --min 80` passes. Coverage must count shared call sites and native equivalents of Canvas `UpdateContext`, `Reset`, `ClearCollect`, and collection `Patch`.');
  lines.push('- `npm run check:pcf -- --strict` passes. Every approved PCF has an exact native/server implementation marker or approved visible unsupported state; pending/blocker PCFs are forbidden.');
  lines.push('- `npm run check:scaffold -- --strict` passes. The final UI must be workflow-specific, not a visible inventory of data sources, capabilities, screen config, or conversion notes.');
  lines.push('- Every row in `control-intent-coverage.json` is either implemented as native semantics, explicitly unsupported, or surfaced as a follow-up. Do not copy Canvas UI chrome; do preserve `mustPreserve` data/event/layout intent.');
  lines.push('- `npx tsc --noEmit` is clean.');
  lines.push('- No blocker-level unsupported items remain.');
  lines.push('');
  lines.push('## Source health summary');
  lines.push(`- Non-Dataverse connectors detected: ${connectors.length}`);
  lines.push(`- Cloud flows detected: ${flows.length}`);
  lines.push(`- Dataverse tables: ${tables.length}`);
  if (serverSideAssets && serverSideAssets.stats) {
    lines.push(`- Server-side Dataverse column assets: ${serverSideAssets.stats.total} (${serverSideAssets.stats.rollupColumns} rollup, ${serverSideAssets.stats.calculatedColumns} calculated, ${serverSideAssets.stats.serverComputedColumns + serverSideAssets.stats.serverManagedColumns} write-restricted/computed)`);
  }
  lines.push(`- Unsupported items: ${toArray(brief.unsupported).length}`);
  lines.push(`- Risks flagged: ${risks.length}`);
  for (const r of risks) lines.push(`- [${r.severity}] ${r.code}: ${r.message}`);
  return lines.join('\n') + '\n';
}

function buildComponentsMd(components) {
  const lines = [];
  lines.push('# Reusable Custom Components');
  lines.push('');
  lines.push('Source-app custom components (defined once, instantiated on many screens). The screen-builder should factor each of these into a single shared React Native component under `src/components/` rather than re-implementing inline per screen.');
  lines.push('');
  if (components.length === 0) {
    lines.push('No custom components detected.');
    return lines.join('\n') + '\n';
  }
  const used = components.filter((c) => c.instanceCount > 0);
  const definedOnly = components.filter((c) => c.instanceCount === 0);
  const richIo = components.filter((c) => (c.inputs && c.inputs.length) || (c.outputs && c.outputs.length) || (c.events && c.events.length) || (c.functions && c.functions.length) || (c.actions && c.actions.length));
  lines.push(`**Total:** ${components.length} components (${used.length} instantiated, ${definedOnly.length} defined-only, ${richIo.length} with typed I/O from \`CustomProperties:\`).`);
  lines.push('');
  // Summary table — adds DefinitionType + I/O counts so the screen-builder
  // can see the contract size at a glance.
  lines.push('| Component | Type | DefinitionType | Instances | Controls | In/Out/Evt/Fn/Act | Screens |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const c of used) {
    const t = c.isPcf ? 'PCF' : (c.type || 'Component');
    const dt = c.definitionType || '—';
    const io = `${(c.inputs || []).length}/${(c.outputs || []).length}/${(c.events || []).length}/${(c.functions || []).length}/${(c.actions || []).length}`;
    const scrCell = c.screens.length > 6
      ? c.screens.slice(0, 6).join(', ') + `, … (+${c.screens.length - 6})`
      : c.screens.join(', ');
    lines.push(`| \`${c.name}\` | ${t} | ${dt} | ${c.instanceCount} | ${c.controlCount || '?'} | ${io} | ${scrCell} |`);
  }
  if (definedOnly.length > 0) {
    lines.push('');
    lines.push('### Defined-only (no instances on any screen)');
    lines.push('');
    lines.push('These components are present in the source app but never instantiated. Likely template scaffolding, future-use, or stale. Surface them here so the screen-builder doesn\'t miss anything, but they require no migration unless a screen plan re-introduces them.');
    lines.push('');
    lines.push('| Component | Type | DefinitionType | Controls | In/Out/Evt/Fn/Act |');
    lines.push('|---|---|---|---|---|');
    for (const c of definedOnly) {
      const t = c.isPcf ? 'PCF' : (c.type || 'Component');
      const dt = c.definitionType || '—';
      const io = `${(c.inputs || []).length}/${(c.outputs || []).length}/${(c.events || []).length}/${(c.functions || []).length}/${(c.actions || []).length}`;
      lines.push(`| \`${c.name}\` | ${t} | ${dt} | ${c.controlCount || '?'} | ${io} |`);
    }
  }

  const withInstances = used.filter((c) => toArray(c.instances).length > 0);
  if (withInstances.length > 0) {
    lines.push('');
    lines.push('## Component instances and bindings');
    lines.push('');
    lines.push('Exact source instance bindings from screen controls. Use this section when rendering component instances in screens: inputs become props, output reads identify values the screen consumed from the component, and event bindings become callback props wired from `behaviors.json`.');
    lines.push('');
    for (const c of withInstances) {
      lines.push(`### \`${c.name}\` instances`);
      lines.push('');
      lines.push('| Screen | Instance | Bound inputs | Output reads | Event bindings |');
      lines.push('|---|---|---|---|---|');
      for (const inst of toArray(c.instances)) {
        const bindings = inst.bindings || {};
        const screenCell = '`' + String(inst.screen || '—').replace(/`/g, "'") + '`';
        const instanceCell = '`' + String(inst.name || inst.path || '—').replace(/`/g, "'") + '`';
        const inputCell = bindingCell(bindings.inputs, 7);
        const outputReads = toArray(bindings.outputReads).length > 0 ? bindings.outputReads : bindings.outputs;
        const outputCell = bindingCell(outputReads, 6);
        const eventCell = bindingCell(bindings.events, 6);
        lines.push(`| ${screenCell} | ${instanceCell} | ${inputCell} | ${outputCell} | ${eventCell} |`);
      }
      lines.push('');
    }
  }

  // Per-component contract block. Only emitted when the def carries typed
  // I/O from `CustomProperties:` so the screen-builder gets a concrete TS
  // signature to mirror (vs. legacy name-pattern detection).
  if (richIo.length > 0) {
    lines.push('');
    lines.push('## Component contracts');
    lines.push('');
    lines.push('Typed inputs/outputs/events from the source `CustomProperties:` blocks. Each block below maps 1:1 to a `Props` interface in `src/components/<Name>.tsx`. **Use these as the TS contract** instead of guessing from instance bindings.');
    lines.push('');
    for (const c of richIo) {
      lines.push(`### \`${c.name}\``);
      lines.push('');
      const meta = [];
      if (c.definitionType) meta.push(`DefinitionType: \`${c.definitionType}\``);
      if (c.description) meta.push(`Description: ${truncateInline(c.description, 140)}`);
      if (c.accessAppScope === true) meta.push('AccessAppScope: `true` — has app-scope access');
      if (c.allowCustomization === true) meta.push('AllowCustomization: `true`');
      if (meta.length) {
        lines.push(meta.map((m) => '- ' + m).join('\n'));
        lines.push('');
      }
      const renderIoTable = (label, arr) => {
        if (!arr || arr.length === 0) return;
        lines.push(`**${label} (${arr.length}):**`);
        lines.push('');
        lines.push('| Name | Type | Default | Description |');
        lines.push('|---|---|---|---|');
        for (const p of arr) {
          const ptype = p.dataType || p.returnType || '—';
          const dflt = p.defaultFormula != null && p.defaultFormula !== ''
            ? '`' + truncateInline(stripLeadingEq(String(p.defaultFormula)), 60) + '`'
            : '—';
          const desc = p.description ? truncateInline(p.description, 80) : '—';
          lines.push(`| \`${p.name || '(unnamed)'}\` | \`${ptype}\` | ${dflt} | ${desc} |`);
        }
        lines.push('');
      };
      renderIoTable('Inputs', c.inputs);
      renderIoTable('Outputs', c.outputs);
      renderIoTable('Events', c.events);
      renderIoTable('Functions', c.functions);
      renderIoTable('Actions', c.actions);
    }
  }
  lines.push('');
  lines.push('### GUIDs');
  lines.push('');
  for (const c of components) {
    if (c.guid) lines.push(`- \`${c.name}\` → \`${c.guid}\``);
  }
  return lines.join('\n') + '\n';
}

function stateUsage(info) {
  const writers = [...(info.writtenIn || new Set())].sort();
  const readers = [...(info.readIn || new Set())].sort();
  const writtenScreens = [...new Set(writers.map((entry) => String(entry).split(':')[0]).filter(Boolean))].sort();
  const hasAppWriter = writtenScreens.includes('App') || writers.some((entry) => String(entry).startsWith('App:'));
  return { writers, readers, writtenScreens, hasAppWriter };
}

function inferNativePlacement(name, info, kind) {
  const { readers, writtenScreens, hasAppWriter } = stateUsage(info);
  const lower = String(name || '').toLowerCase();
  const readCount = readers.length;
  const writeCount = writtenScreens.length;
  const singleScreenRead = readCount <= 1;
  const singleScreenWrite = writeCount <= 1;
  const selectionLike = /selected|current|active|record|row|item|customer|account|contact|order|appointment|visit|id$/.test(lower);
  const uiFlagLike = /show|hide|visible|open|closed|expanded|selectedtab|tab|filter|search|modal|dialog|popup|loading|busy|saving|error|message|toast|step|wizard/.test(lower);
  const localCollectionLike = /draft|cart|basket|selected|selection|pending|upload|attachment|photo|image|signature|scan/.test(lower);

  if (kind === 'var') {
    if (readCount === 0 || (singleScreenRead && singleScreenWrite && !hasAppWriter)) {
      return {
        placement: 'local-state',
        reason: readCount === 0
          ? 'No cross-screen readers detected; keep as local/transient state if still needed.'
          : 'Single-screen variable; use local state/form state instead of app state.',
      };
    }
    if (uiFlagLike && singleScreenRead) {
      return {
        placement: 'local-state',
        reason: 'UI flag/filter/dialog state belongs to the owning screen.',
      };
    }
    if (selectionLike && readCount <= 2) {
      return {
        placement: 'route-param + optional paint-cache',
        reason: 'Selection/navigation identity should travel by id; keep an optional app-state preview only for instant paint.',
      };
    }
    if (hasAppWriter && readCount > 1) {
      return {
        placement: 'bootstrap + app-state',
        reason: 'App.OnStart initializes a value read across screens; bootstrap the default and expose only the shared runtime value.',
      };
    }
    return {
      placement: 'app-state',
      reason: 'Multiple screens read this variable; use provider/app state.',
    };
  }

  if (readCount === 0 || (singleScreenRead && singleScreenWrite && !hasAppWriter)) {
    return {
      placement: 'local-state',
      reason: readCount === 0
        ? 'No cross-screen readers detected; keep local if still needed.'
        : 'Single-screen collection; keep in local state or a screen-scoped query result.',
    };
  }
  if (localCollectionLike && readCount <= 2) {
    return {
      placement: 'local-state or app-state',
      reason: 'Looks like transient user/workflow data; keep local unless another screen truly shares it.',
    };
  }
  return {
    placement: 'query-cache',
    reason: 'Collection is read across screens; prefer a named React Query/domain hook over a global Canvas-style array.',
  };
}

function buildAppStateMd(state) {
  const lines = [];
  lines.push('# State scope report (`var_*` and `col_*`)');
  lines.push('');
  lines.push('Inferred by scanning every Power Fx formula for writes (`Set`, `UpdateContext`, `Collect`, `ClearCollect`, `Clear`, `Patch`, `RemoveIf`, `Remove`, `Update`) and reads (any reference to a `var_*` or `col_*` identifier). This is a scope report, not a command to create global app state: use the `Recommended native placement` column to decide between route params, local state/form state, React Query/domain hooks, bootstrap, and app/provider state.');
  lines.push('');
  lines.push('## Variables (`var_*`)');
  lines.push('');
  const varNames = Object.keys(state.vars).sort();
  if (varNames.length === 0) {
    lines.push('_None detected._');
  } else {
    lines.push('| Variable | Written by | Read on screens | Recommended native placement | Reason |');
    lines.push('|---|---|---|---|---|');
    for (const name of varNames) {
      const info = state.vars[name];
      const writers = [...info.writtenIn].sort().slice(0, 6).join('<br>');
      const readers = [...info.readIn].sort().join(', ');
      const recommendation = inferNativePlacement(name, info, 'var');
      lines.push(`| \`${name}\` | ${writers || '—'} | ${readers || '—'} | ${recommendation.placement} | ${recommendation.reason} |`);
    }
  }
  lines.push('');
  lines.push('## Collections (`col_*`)');
  lines.push('');
  const colNames = Object.keys(state.cols).sort();
  if (colNames.length === 0) {
    lines.push('_None detected._');
  } else {
    lines.push('| Collection | Written by | Read on screens | Recommended native placement | Reason |');
    lines.push('|---|---|---|---|---|');
    for (const name of colNames) {
      const info = state.cols[name];
      const writers = [...info.writtenIn].sort().slice(0, 6).join('<br>');
      const readers = [...info.readIn].sort().join(', ');
      const recommendation = inferNativePlacement(name, info, 'col');
      lines.push(`| \`${name}\` | ${writers || '—'} | ${readers || '—'} | ${recommendation.placement} | ${recommendation.reason} |`);
    }
  }
  lines.push('');
  return lines.join('\n') + '\n';
}

function buildPluginInput(brief, inputPath, screenRows, connectors, tables, risks, screenFiles, structuredForms, nativeExecution, demotedCapabilities, loadedScreens, serverSideAssets, controlIntentCoverage, pcfPlan) {
  // Per-screen upgrade-hints index — keyed by screen name so the screenRows
  // map below can attach hints without re-walking the brief.
  const upgradeHintsByScreen = new Map();
  for (const sc of toArray(loadedScreens)) {
    const hints = detectUpgradeHintsForScreen(sc);
    if (hints.length > 0) upgradeHintsByScreen.set(sc.name, hints);
  }
  const unsupported = toArray(brief.unsupported).map((u) => ({
    screen: u.screen || null,
    control: u.control || null,
    reason: u.reason || 'unsupported',
    raw: u.raw || null,
  }));
  // Form factor: prefer brief.app.settings.documentLayout (richer \u2014 has
  // lockOrientation, scaleToFit) and fall back to brief.app.documentLayout.
  const settingsLayout = (brief.app && brief.app.settings && brief.app.settings.documentLayout) || null;
  const fallbackLayout = (brief.app && brief.app.documentLayout) || null;
  const formFactor = settingsLayout || fallbackLayout || null;
  const unresolvedDataSources = toArray(structuredForms)
    .filter((form) => form && form.sourceBinding && form.sourceBinding.kind === 'unresolved-external')
    .map((form) => ({
      name: form.sourceBinding.sourceName || form.dataSource || null,
      screen: form.screen || null,
      formControl: form.formControl || null,
      boundTo: form.boundTo || null,
      candidates: toArray(form.sourceBinding.candidates),
      note: form.sourceBinding.note || null,
    }));
  const connectorInventory = sanitizeConnectorInventoryForTarget(collectConnectorInventory(brief));
  const connectionRequirements = buildConnectionRequirements(brief, connectorInventory);
  const nativeTargetsForScreen = (screen) => unique(
    toArray(nativeExecution && nativeExecution.entries)
      .filter((entry) => toArray(screen.nativeCapabilities).includes(entry.source))
      .map((entry) => entry.target)
  ).sort();
  return {
    $schema: 'https://raw.githubusercontent.com/microsoft/power-platform-skills/main/plugins/mobile-apps/scripts/schemas/mobile-plugin-input.v3.schema.json',
    schemaVersion: '3',
    source: {
      appBriefPath: inputPath,
      generatedAt: GENERATION_TIMESTAMP,
      appBriefGeneratedAt: brief.generatedAt || null,
    },
    app: {
      name: (brief.app && brief.app.name) || null,
      startScreen: (brief.app && brief.app.startScreen) || null,
      auth: (brief.app && brief.app.auth) || null,
      formFactor,
      // Forward the operational flags + source metadata from Properties.json
      // so downstream skills (offline, PCF, design-system) can read them
      // without re-parsing the raw brief.
      settings: {
        documentAppType: (brief.app && brief.app.settings && brief.app.settings.documentAppType) || null,
        offlineEnabled: brief.app && brief.app.settings ? brief.app.settings.offlineEnabled : null,
        enableInstrumentation: brief.app && brief.app.settings ? brief.app.settings.enableInstrumentation : null,
        showStatusBar: brief.app && brief.app.settings ? brief.app.settings.showStatusBar : null,
        containsThirdPartyPcfControls: brief.app && brief.app.settings ? brief.app.settings.containsThirdPartyPcfControls : null,
        defaultConnectedDataSourceMaxGetRowsCount: brief.app && brief.app.settings ? brief.app.settings.defaultConnectedDataSourceMaxGetRowsCount : null,
        documentLayoutMaintainAspectRatio: brief.app && brief.app.settings ? brief.app.settings.documentLayoutMaintainAspectRatio : null,
        appCopilotSchemaName: (brief.app && brief.app.settings && brief.app.settings.appCopilotSchemaName) || null,
        appDescription: (brief.app && brief.app.settings && brief.app.settings.appDescription) || null,
        hasAuthorMetadata: !!(brief.app && brief.app.settings && (brief.app.settings.hasAuthorMetadata || brief.app.settings.author)),
        libraryDependencies: parseLibraryDependencies(brief.app && brief.app.settings && brief.app.settings.libraryDependencies),
      },
      // External canvas-component library aggregate (schema-completion pass).
      // Empty array on apps that don't pull any external libs.
      componentLibraries: toArray(brief.app && brief.app.componentLibraries),
    },
    bootstrap: {
      onStartIntents: toArray(brief.app && brief.app.onStartIntents),
      onErrorIntents: toArray(brief.app && brief.app.onErrorIntents),
      globalFormulas: toArray(brief.app && brief.app.globalFormulas),
    },
    forms: Array.isArray(structuredForms) ? structuredForms : toArray(brief.forms),
    controlIntentCoverage: controlIntentCoverage && controlIntentCoverage.stats
      ? {
          file: 'control-intent-coverage.json',
          schema: controlIntentCoverage.$schema,
          rule: controlIntentCoverage.rule,
          stats: controlIntentCoverage.stats,
        }
      : null,
    pcfPlan: {
      file: 'pcf-plan.json',
      schema: pcfPlan.$schema,
      rule: pcfPlan.rule,
      stats: pcfPlan.stats,
    },
    localization: (brief && brief.localization) || null,
    assets: (brief && brief.assets) || null,
    qualityGates: {
      generatedAt: GENERATION_TIMESTAMP,
      commands: [
        'npm run gen:assets',
        'npm run check:i18n -- --strict',
        'npm run check:coverage -- --min 80',
        'npm run check:pcf -- --strict',
        'npm run check:scaffold -- --strict',
        'npx tsc --noEmit',
      ],
      behaviorCoverage: {
        minCoveragePercent: 80,
        countSharedScreenBases: true,
        nativeEquivalentIntents: ['setContext', 'reset', 'clearCollect', 'patch', 'updateIf'],
      },
      localization: {
        allowOnlyCatalogKeys: true,
        unknownKeyPolicy: 'render literal fallback; do not invent t() keys',
      },
      dataFlow: {
        fullRowSelectionRefs: true,
        appStateParityForSourceVarsAndCollections: true,
        typedDataverseCustomColumnExtensions: true,
        liveScreenShellSyncSurface: true,
      },
      workflowScaffolding: {
        noVisibleConversionScaffolding: true,
        directExpoRouterScreenImplementations: true,
        forbiddenFinalPatterns: ['CapabilityPanel', 'RelatedSources', 'NextActions', 'generic DataListPanel', 'clone/source technical copy'],
        requiredFinalShape: 'workflow-specific screens derived from Power Fx intent, not screen-config/debug panels',
      },
    },
    dataModelPlan: {
      dataverseRequired: tables.length > 0,
      dataverseTables: sanitizeTablesForPluginInput(tables),
      serverSideAssets: serverSideAssets && serverSideAssets.stats
        ? {
            file: 'server-side-assets.json',
            schema: serverSideAssets.$schema,
            stats: serverSideAssets.stats,
            rule: 'Computed/server-managed columns are read from Dataverse or excluded from write payloads; plug-ins/business rules/workflows require manual target verification.',
          }
        : null,
      connectorNames: connectors,
      // Richer connector shape (og-script update) — preserves apiId + the
      // clean dataSources[] list per connector so /add-connector and the
      // screen-builder don't have to re-walk the raw brief.
      connectorInventory,
      connectionRequirements,
      flows: toArray(brief.dataModel && brief.dataModel.flows).map((f) => ({
        name: (f && f.name) || null,
        actionCount: toArray(f && f.actions).length,
        screens: toArray(f && f.screens),
        // Source flow/workflow GUIDs are environment-bound. Preserve presence
        // only; Step 10 resolves a target ID with list-flows before add-flow.
        flowId: null,
        id: null,
        workflowEntityId: null,
        sourceFlowIdPresent: !!(f && (f.flowId || f.id || f.guid)),
        sourceWorkflowEntityIdPresent: !!(f && f.workflowEntityId),
        apiId: (f && f.apiId) || null,
        displayName: (f && f.displayName) || (f && f.name) || null,
      })),
      sharepointLists: toArray(brief.dataModel && brief.dataModel.sharepointLists),
      connectorsRequired: connectors.length > 0,
      flowsRequired: toArray(brief.dataModel && brief.dataModel.flows).length > 0,
      unresolvedDataSources,
    },
    screenPlan: {
      screens: screenRows.map((s) => {
        const f = screenFiles.find((x) => x.name === s.name);
        const hints = upgradeHintsByScreen.get(s.name) || [];
        return {
          ...s,
          sourceNativeIntents: toArray(s.nativeCapabilities),
          nativeCapabilities: nativeTargetsForScreen(s),
          planFile: f ? `screens/${f.planFile}` : null,
          controlsFile: f && f.controlsFile ? `screens/${f.controlsFile}` : null,
          lineCount: f ? f.lineCount : null,
          mode: f ? f.mode : null,
          // Canvas anti-pattern upgrades detected on this screen. See
          // shared/references/canvas-to-native-mapping.md for the principle
          // and `## Upgrade Hints` in the per-screen plan for the prose.
          upgradeHints: hints,
        };
      }),
      navigationEdges: toArray(brief.navigation && brief.navigation.edges),
    },
    nativePlan: {
      capabilities: toArray(nativeExecution && nativeExecution.capabilities),
      sourceIntents: toArray(nativeExecution && nativeExecution.sourceIntents),
      handledSourceTags: toArray(nativeExecution && nativeExecution.handledSourceTags),
      inferredPermissions: toArray(brief.app && brief.app.permissions),
      // Per-§14 anti-pattern audit: capabilities reclassified into
      // host:ImagePicker / host:FilePicker form fields so the screen-builder
      // does NOT also emit a duplicate `src/native/camera.ts` wrapper. Each
      // entry pins the demotion to a specific {screen, field, boundTo}.
      demotedCapabilities: Array.isArray(demotedCapabilities) ? demotedCapabilities : [],
    },
    riskReport: risks,
    unsupported,
  };
}

// ---------- Round-trip check ----------

function roundTripCheck(loadedScreens, screenFiles, outDir) {
  let totalSource = 0;
  let totalRendered = 0;
  const failures = [];
  for (const sc of loadedScreens) {
    const controls = toArray(sc.controls);
    totalSource += controls.length;
    const f = screenFiles.find((x) => x.name === sc.name);
    if (!f) {
      failures.push(`${sc.name}: no plan file written`);
      continue;
    }
    const planPath = path.join(outDir, 'screens', f.planFile);
    const txt = fs.readFileSync(planPath, 'utf8');
    let rendered = 0;
    for (const c of controls) {
      const label = shortName(c.path, c.name);
      // Look for the tree line OR the per-control subsection header
      if (txt.includes(`- ${label} (${c.kind})`) || txt.includes(`##### ${label}`)) {
        rendered += 1;
      } else if (f.controlsFile) {
        const ctlPath = path.join(outDir, 'screens', f.controlsFile);
        const ctlTxt = fs.readFileSync(ctlPath, 'utf8');
        if (ctlTxt.includes(`##### ${label}`)) rendered += 1;
      }
    }
    totalRendered += rendered;
    if (rendered < controls.length) {
      failures.push(`${sc.name}: ${rendered}/${controls.length} controls rendered`);
    }
  }
  return { totalSource, totalRendered, failures };
}

// ---------- main ----------

// Detect a Canvas component library (`.msapp` with no runnable screens, only
// reusable controls). The plugin's `/create-mobile-app` planner can't build a
// screen graph for these — Gate 4 would reject an empty `screens[]` and the
// user gets stuck in an extract-replan loop. Short-circuit to a stub plan +
// `migrationCheck` hint that prevents a component library from entering the
// runnable-app generator and points at the existing app-edit workflow.
function isComponentLibraryApp(brief, loadedScreens) {
  const app = (brief && brief.app) || {};
  const settings = app.settings || {};
  // Canonical signal: Properties.json `DocumentAppType` is set to the literal
  // string 'ComponentLibrary' for any .msapp authored as a component library.
  const dat = (settings.documentAppType || '').toLowerCase();
  if (dat === 'componentlibrary') return { reason: 'documentAppType === "ComponentLibrary"' };
  // Explicit flag if a future L1 emits it.
  if (app.componentLibrary === true) return { reason: 'app.componentLibrary === true' };
  // Defensive fallback: no screens parsed AND there's at least one reusable
  // component definition. Pure component libraries always have components but
  // never screens; a regular app with 0 screens is broken either way.
  const screenCount = Array.isArray(loadedScreens) ? loadedScreens.length : toArray(brief && brief.screens).length;
  const componentCount = toArray(brief && brief.components).length
    + toArray(brief && brief.componentDefinitions).length;
  if (screenCount === 0 && componentCount > 0) {
    return { reason: 'screens.length === 0 && components.length > 0' };
  }
  return null;
}

// Build the component-library stub plan + plugin-input. Mirrors the shape of
// `buildPluginInput` for the fields downstream readers expect to find, but
// drops everything screen-dependent so nothing tries to render a zero-screen
// app.
function buildComponentLibraryStub(brief, args) {
  const appName = (brief && brief.app && brief.app.name) || 'Component Library';
  const components = toArray(brief && brief.components).map((c) => ({
    name: c && c.name,
    type: (c && (c.type || c.definitionType)) || 'CanvasComponent',
    controlCount: (c && c.controlCount) || 0,
    inputs: toArray(c && c.inputs).length,
    outputs: toArray(c && c.outputs).length,
  })).filter((c) => c.name);
  const externalLibs = toArray(brief && brief.app && brief.app.componentLibraries);
  const connectorInv = sanitizeConnectorInventoryForTarget(collectConnectorInventory(brief));
  const stubInput = {
    migrationCheck: 'component-library-only — port selected contracts into an existing app via /edit-app; do not run /create-mobile-app',
    sourceApp: {
      name: appName,
      format: (brief && brief.source && brief.source.format) || null,
      documentAppType: (brief && brief.app && brief.app.settings && brief.app.settings.documentAppType) || null,
    },
    componentLibrary: {
      components,
      externalLibraries: externalLibs,
      componentCount: components.length,
    },
    dataModelPlan: {
      // Components can still bind to Dataverse/connectors via input props.
      // Surface what extraction saw so an existing host app can wire the same
      // connector contracts during an approved `/edit-app` change.
      connectorInventory: connectorInv,
    },
    nativePlan: {
      capabilities: [],
      demotedCapabilities: [],
    },
  };
  const lines = [];
  lines.push(`# ${appName}`);
  lines.push('');
  lines.push('> **⚠️ This is a Canvas component library, not a runnable app.**');
  lines.push('>');
  lines.push('> The mobile plugin\'s `/create-mobile-app` planner builds a screen graph + navigation — it has nothing to plan for a component library. Select the required component contracts and port them into an existing native app through an approved **`/edit-app`** change instead.');
  lines.push('');
  lines.push('## Migration check');
  lines.push('');
  lines.push('| Field | Value |');
  lines.push('|---|---|');
  lines.push(`| Source app | \`${appName}\` |`);
  lines.push(`| Source format | \`${(brief && brief.source && brief.source.format) || 'unknown'}\` |`);
  lines.push(`| documentAppType | \`${(brief && brief.app && brief.app.settings && brief.app.settings.documentAppType) || 'unknown'}\` |`);
  lines.push(`| Components found | ${components.length} |`);
  lines.push(`| External component libraries referenced | ${externalLibs.length} |`);
  lines.push('| Recommended next step | `/edit-app` against an existing target app, using selected component contracts as evidence |');
  lines.push('');
  if (components.length) {
    lines.push('## Components');
    lines.push('');
    lines.push('| Component | Type | Controls | Inputs | Outputs |');
    lines.push('|---|---|---|---|---|');
    for (const c of components) {
      lines.push(`| \`${c.name}\` | ${c.type} | ${c.controlCount} | ${c.inputs} | ${c.outputs} |`);
    }
    lines.push('');
  }
  if (externalLibs.length) {
    lines.push('## External component libraries referenced');
    lines.push('');
    for (const lib of externalLibs) {
      const nm = (lib && (lib.uniqueName || lib.name)) || JSON.stringify(lib);
      lines.push(`- \`${nm}\``);
    }
    lines.push('');
  }
  if (connectorInv.length) {
    lines.push('## Connectors referenced (informational)');
    lines.push('');
    lines.push('Components in this library bind to the following connectors via input props. When you port a selected contract through `/edit-app`, the host app must have these connectors wired first (run `/add-connector` if missing).');
    lines.push('');
    for (const c of connectorInv) {
      const customMark = c.isCustom ? ' ⚠️ custom' : '';
      const schemaMark = c.requiresSchemaFetch ? ' 🟡 schema fetch pending' : '';
      lines.push(`- \`${c.name}\` (\`${c.classification}\`)${customMark}${schemaMark}`);
    }
    lines.push('');
  }
  lines.push('## Next steps');
  lines.push('');
  lines.push('1. Pick one component from the table above.');
  lines.push('2. Run `/edit-app` inside an existing native app and request the selected component behavior, supplying this contract as source evidence.');
  lines.push('3. Repeat per component you need to port.');
  lines.push('');
  lines.push('> Do **not** run `/create-mobile-app` against this `mobile-plugin-input.json` — Gate 4 (screen graph approval) will reject the empty `screens[]` and you\'ll be sent back here. The `migrationCheck` field above is the planner\'s contract-level signal to stop and route.');
  return { stubInput, stubPlanMd: lines.join('\n') + '\n' };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  // CI-friendly entry point: validates the forms / host-picker pipeline on
  // synthetic input without touching disk. Exits 0 on pass, 1 on failure.
  if (args.selfTest) {
    runFormsSmokeTest();
    process.exit(0);
  }
  const brief = readJson(args.input);

  // Detect publisher prefix + translation collection logical name from the
  // brief itself — keeps the adapter app-agnostic (no hardcoded publisher identifiers).
  setBriefContext(brief);

  // §14 anti-pattern: planner has nothing to plan for a Canvas component
  // library. Detect BEFORE the heavy collectTables/loadAllScreens lifting so
  // we don't pretend to produce a screen graph. Emit `migrationCheck` + a
  // stub plan that routes the user to the existing app-edit workflow.
  const componentLibraryFinding = isComponentLibraryApp(brief, null);
  if (componentLibraryFinding) {
    prepareOutputDir(args.outDir);
    const { stubInput, stubPlanMd } = buildComponentLibraryStub(brief, args);
    writeFile(path.join(args.outDir, 'mobile-plugin-input.json'), JSON.stringify(stubInput, null, 2) + '\n');
    writeFile(path.join(args.outDir, 'native-app-plan.md'), stubPlanMd);
    console.log('Component-library short-circuit (' + componentLibraryFinding.reason + ').');
    console.log('Wrote stub outputs:');
    console.log('- ' + path.join(args.outDir, 'mobile-plugin-input.json') + ' (migrationCheck set)');
    console.log('- ' + path.join(args.outDir, 'native-app-plan.md') + ' (stub)');
    const componentCount = toArray(brief && brief.components).length;
    console.log('Summary: 0 runnable screens, ' + componentCount + ' reusable components.');
    console.log('');
    console.log('Next: do NOT run /create-mobile-app on this. Use /edit-app to port selected component contracts into an existing native app.');
    return;
  }

  // Validate that every native-swap entry references a dependency actually
  // bundled in template/package.json. Non-fatal — missing deps degrade to a
  // [medium] risk on screens that match the swap.
  const bundledDeps = loadTemplatePackageDeps();
  const swapValidation = validateSwapsAgainstTemplate(bundledDeps);
  if (!swapValidation.ok) {
    for (const m of swapValidation.missing) {
      console.warn(`WARNING: NATIVE_SWAPS entry '${m.id}' references '${m.lib}' but it is NOT in template/package.json — keep this as a review item and use its documented allowlisted fallback, or block. Do not install an unbundled native dependency.`);
    }
  }

  const connectors = collectConnectorNames(brief);
  // Per-table Dataverse sidecars live next to app-brief.json under `tables/`.
  // Pass the absolute path so `collectTables` can hydrate full column metadata
  // (types, lookups, picklist options) and derive `status` + `tier`.
  const tablesDir = path.resolve(path.dirname(args.input), 'tables');
  const tables = collectTables(brief, tablesDir, args.fullSchema);
  const screenRows = collectScreenRows(brief);
  const risks = buildRisks(brief, connectors, tables);

  prepareOutputDir(args.outDir);
  const missingScreenFiles = [];
  const loadedScreens = loadAllScreens(brief, args.screensDir, missingScreenFiles);

  // Aggregate native-swap matches across every loaded screen so the master plan
  // can render a single "Native Control Mapping" table near the top.
  const swapAggregate = aggregateSwapsAcrossScreens(loadedScreens);
  const upgradeHintsAggregate = aggregateUpgradeHintsAcrossScreens(loadedScreens);

  // Build the native-capability playbook BEFORE writing per-screen files so
  // each screen plan's `## Native intent` block can cite the cluster-wide
  // reusable component name.
  const playbook = buildNativeCapabilityPlaybook(loadedScreens);

  const { written: screenFiles } = writePerScreenFiles(
    brief,
    args.outDir,
    args.splitThreshold,
    loadedScreens,
    playbook
  );

  const components = collectComponentInstances(loadedScreens, brief);
  const appState = collectAppState(loadedScreens);
  const behaviors = extractBehaviors(loadedScreens, brief);
  const flows = extractFlows(brief, loadedScreens);
  const controlIntentCoverage = buildControlIntentCoverage(loadedScreens);

  // §10.1 / §8.3 / §14 pipeline: hydrate forms[] into the structured shape,
  // then run the image-picker downgrade so {camera, attachment, image-picker,
  // gallery} stop double-counting when the same screen also has a Dataverse-
  // bound Image/File form field. `applyImagePickerDowngrade` mutates
  // `screenRows[].nativeCapabilities` in place so the per-screen rows that
  // feed into `buildMasterPlan` and `nativePlan.capabilities` are consistent.
  const connectorInv = collectConnectorInventory(brief);
  const targetConnectorInv = sanitizeConnectorInventoryForTarget(connectorInv);
  const connectionRequirements = buildConnectionRequirements(brief, targetConnectorInv);
  const structuredForms = collectForms(brief, loadedScreens, tables, connectorInv);
  const downgrade = applyImagePickerDowngrade(structuredForms, brief, screenRows);
  const nativeExecution = buildNativeExecutionPlan(downgrade.capabilities, bundledDeps);
  const serverSideAssets = buildServerSideAssets(tables);
  const pcfPlan = buildPcfPlan(brief, loadedScreens, connectionRequirements, bundledDeps);

  const masterPlan = buildMasterPlan(
    brief,
    screenRows,
    connectors,
    tables,
    risks,
    screenFiles,
    swapAggregate,
    playbook,
    structuredForms,
    nativeExecution,
    downgrade.demoted,
    upgradeHintsAggregate,
    serverSideAssets,
    pcfPlan
  );
  const requirementsMd = buildRequirementsBrief(brief, screenRows, connectors, tables);
  const checklistMd = buildMigrationChecklist(brief, connectors, tables, risks, serverSideAssets, pcfPlan);
  const componentsMd = buildComponentsMd(components);
  const stateMd = buildAppStateMd(appState);
  const pluginInput = buildPluginInput(
    brief,
    path.relative(args.outDir, args.input).replace(/\\/g, '/') || 'app-brief.json',
    screenRows,
    connectors,
    tables,
    risks,
    screenFiles,
    structuredForms,
    nativeExecution,
    downgrade.demoted,
    loadedScreens,
    serverSideAssets,
    controlIntentCoverage,
    pcfPlan
  );

  writeFile(path.join(args.outDir, 'native-app-plan.md'), masterPlan);
  writeFile(path.join(args.outDir, 'requirements-brief.md'), requirementsMd);
  writeFile(path.join(args.outDir, 'migration-checklist.md'), checklistMd);
  writeFile(path.join(args.outDir, 'components.md'), componentsMd);
  writeFile(path.join(args.outDir, 'state', 'app-state.md'), stateMd);
  writeFile(path.join(args.outDir, 'server-side-assets.json'), JSON.stringify(serverSideAssets, null, 2) + '\n');
  writeFile(path.join(args.outDir, 'control-intent-coverage.json'), JSON.stringify(controlIntentCoverage, null, 2) + '\n');
  writeFile(path.join(args.outDir, 'pcf-plan.json'), JSON.stringify(pcfPlan, null, 2) + '\n');
  writeFile(path.join(args.outDir, 'mobile-plugin-input.json'), JSON.stringify(pluginInput, null, 2) + '\n');
  writeFile(path.join(args.outDir, 'behaviors.json'), JSON.stringify(behaviors, null, 2) + '\n');
  writeFile(path.join(args.outDir, 'flows.json'), JSON.stringify(flows, null, 2) + '\n');

  // Sidecars: localization key list + asset catalog (kept out of the master
  // plan so 224 keys + 136 images don't drown it).
  if (brief.localization) {
    writeFile(path.join(args.outDir, 'localization.json'), JSON.stringify(brief.localization, null, 2) + '\n');
  }
  if (brief.assets) {
    writeFile(path.join(args.outDir, 'assets.json'), JSON.stringify(brief.assets, null, 2) + '\n');
  }

  // Round-trip check
  const rt = roundTripCheck(loadedScreens, screenFiles, args.outDir);

  // Report
  console.log('Wrote adapter outputs:');
  console.log('- ' + path.join(args.outDir, 'native-app-plan.md') + ' (master plan)');
  console.log('- ' + path.join(args.outDir, 'mobile-plugin-input.json'));
  console.log('- ' + path.join(args.outDir, 'requirements-brief.md'));
  console.log('- ' + path.join(args.outDir, 'migration-checklist.md'));
  console.log('- ' + path.join(args.outDir, 'components.md') + ' (' + components.length + ' components)');
  console.log('- ' + path.join(args.outDir, 'state/app-state.md') +
    ' (' + Object.keys(appState.vars).length + ' vars, ' + Object.keys(appState.cols).length + ' cols)');
  console.log('- ' + path.join(args.outDir, 'server-side-assets.json') +
    ' (' + serverSideAssets.stats.total + ' assets, ' + serverSideAssets.stats.writeImpactedTables + ' write-impacted tables)');
  console.log('- ' + path.join(args.outDir, 'control-intent-coverage.json') +
    ' (' + controlIntentCoverage.stats.totalControls + ' controls, ' +
    controlIntentCoverage.stats.behavioralControls + ' behavioral, ' +
    controlIntentCoverage.stats.highRiskControls + ' high-risk)');
  console.log('- ' + path.join(args.outDir, 'pcf-plan.json') +
    ' (' + pcfPlan.stats.total + ' PCFs, ' + pcfPlan.stats.proposed.blocker +
    ' proposed blockers, explicit approval required)');
  console.log('- ' + path.join(args.outDir, 'behaviors.json') +
    ' (' + behaviors.stats.totalActions + ' actions, ' + behaviors.stats.visibility +
    ' visibility, ' + behaviors.stats.validations + ' validations, ' +
    behaviors.stats.derivations + ' derivations across ' + behaviors.stats.screensWithBehaviors +
    ' screens, ' + behaviors.stats.totalUnmatched + ' unmatched)');
  console.log('- ' + path.join(args.outDir, 'flows.json') +
    ' (' + flows.stats.totalFlows + ' flows, ' + flows.stats.withId + ' ready-to-wire, ' +
    flows.stats.missingId + ' missing flow-id)');
  console.log('- forms: ' + structuredForms.length +
    ' structured (demoted caps: ' + downgrade.demoted.length + ')');
  if (brief.localization) {
    const keyCount = toArray(brief.localization.keys).length;
    console.log('- ' + path.join(args.outDir, 'localization.json') + ' (' + keyCount + ' keys, strategy: ' + (brief.localization.strategy || 'unknown') + ')');
  }
  if (brief.assets) {
    const imgCount = toArray(brief.assets.images).length;
    console.log('- ' + path.join(args.outDir, 'assets.json') + ' (' + imgCount + ' images, ' + (brief.assets.bundledImageCount || 0) + ' bundled)');
  }
  console.log('- ' + path.join(args.outDir, 'screens/') + ' (' + screenFiles.length + ' screen plan files)');
  const split = screenFiles.filter((f) => f.mode === 'separate');
  if (split.length) {
    console.log('  split screens (>' + args.splitThreshold + ' lines): ' +
      split.map((s) => s.name).join(', '));
  }
  if (missingScreenFiles.length) {
    console.warn('WARNING: per-screen briefs missing for: ' + missingScreenFiles.join(', '));
  }
  console.log('');
  console.log('Round-trip check: ' + rt.totalRendered + '/' + rt.totalSource + ' controls rendered across all screens.');
  if (rt.failures.length) {
    console.error('Round-trip FAILURES:');
    for (const f of rt.failures) console.error('  - ' + f);
    process.exitCode = 3;
  }
  console.log('Summary: ' + screenRows.length + ' screens, ' + tables.length + ' tables, ' + connectors.length + ' connectors, ' + risks.length + ' risks');
  console.log('');
  console.log('Next: review native-app-plan.md, then run /create-mobile-app --working-dir <fresh-template> --adapted-from ' + args.outDir);
}

if (require.main === module) main();

module.exports = {
  main,
  sliceAttributesToUsed,
  collectFormFieldNamesByTable,
  collectTables,
  collectConnectorInventory,
  sanitizeConnectorInventoryForTarget,
  buildConnectionRequirements,
  buildNativeRouteMap,
  toColumn,
  classifyServerSideColumn,
  controlFromEditChildTemplate,
  controlEvidenceFromScaffold,
  deriveFieldLabel,
  collectForms,
  buildNativeExecutionPlan,
  buildPcfPlan,
  buildControlIntentCoverage,
  extractBehaviors,
  extractFlows,
  collectAppState,
  runFormsSmokeTest,
};
