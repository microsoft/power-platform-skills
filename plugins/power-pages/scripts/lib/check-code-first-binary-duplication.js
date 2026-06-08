#!/usr/bin/env node

// Soft-warns when a code-first component (PCF control, plug-in assembly,
// custom workflow assembly) appears in pending Changes WITH both its binary
// payload AND its source tree present — a duality that is a known foot-gun:
//
//   - Git is the source of truth for source files
//   - Dataverse is the source of truth for the assembled binary
//   - When both are committed together, the maker portal "Pull" round-trips
//     the BINARY and silently overwrites the recipient env's source view —
//     leaving downstream tenants with no way to rebuild from source.
//
// The recommended pattern (per Microsoft Learn architecture guidance) is to
// commit ONLY the source (let `pac pcf push` rebuild the binary on each env)
// OR commit ONLY the binary (treat the component as opaque). Both together
// signals a process mistake.
//
// API reference: references/inner-loop-error-catalog.md IL-006 (binary+source)
//
// PURE validator — no HTTP. Consumes items[] from list-pending-changes.js.
//
// Output (JSON to stdout):
//   {
//     totalCodeFirstComponents: <int>,
//     warnings: [
//       {
//         kind: 'pcf' | 'pluginassembly' | 'customworkflowactivity',
//         componentName,           // the binary's name (or null)
//         binaryItem: { componentId, componentType, filePath },
//         sourceItems: [ { componentId, componentType, filePath }, ... ],
//         reason: "<human-readable>",
//       }, ...
//     ],
//     ok: bool,                    // always true (informational)
//   }
//
// PURE validator: heuristic-based since the API gives us componentType and
// filePath. We pair items by (a) componentName overlap OR (b) filePath living
// under a known source tree (e.g. `PCFControls/<name>/...`) that matches an
// adjacent `<name>.zip` or `<name>.dll` binary.
//
// TODO: HAR-verify — the exact componentType emitted for PCF "source" rows
// vs "binary" rows. Some Dataverse environments emit one componentType for
// the assembly and a separate one for source files; others emit a single
// `customcontrol` row with a filePath ending in `.zip`.
//
// Usage:
//   node check-code-first-binary-duplication.js --items-file <path>
//   node check-code-first-binary-duplication.js --pending-file <path>
//   echo '<json>' | node check-code-first-binary-duplication.js --stdin

'use strict';

const fs = require('node:fs');

// File extensions / patterns we treat as code-first BINARIES
const BINARY_PATTERNS = [
  { regex: /\.dll$/i,                kind: 'pluginassembly' },
  { regex: /\.pcfproj.*\.zip$/i,     kind: 'pcf' },
  { regex: /CustomControls\/[^/]+\.zip$/i, kind: 'pcf' },
];

// File extensions / paths we treat as code-first SOURCE
const SOURCE_PATTERNS = [
  { regex: /PCFControls\//i,         kind: 'pcf' },
  { regex: /\/ControlManifest\.Input\.xml$/i, kind: 'pcf' },
  { regex: /\.tsx?$/i,               kind: 'pcf' },
  { regex: /\.csproj$/i,             kind: 'pluginassembly' },
  { regex: /PluginPackage\//i,       kind: 'pluginassembly' },
  { regex: /\.cs$/i,                 kind: 'pluginassembly' },
];

// componentType strings that flag a binary item even without a filePath hint
const BINARY_COMPONENT_TYPES = new Set([
  'pluginassembly',
  'msdyn_pluginassembly',
  'customcontrol',     // PCF binaries are stored under customcontrol entity
  'customworkflowactivity',
]);

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

function classifyItem(it) {
  if (!it || typeof it !== 'object') return { isBinary: false, isSource: false, kind: null };
  const type = it.componentType ? String(it.componentType).toLowerCase() : '';
  const filePath = it.filePath || '';

  // Binary by componentType
  if (BINARY_COMPONENT_TYPES.has(type)) {
    let kind = type === 'pluginassembly' || type === 'msdyn_pluginassembly'
      ? 'pluginassembly'
      : type === 'customworkflowactivity'
        ? 'customworkflowactivity'
        : 'pcf';
    return { isBinary: true, isSource: false, kind };
  }
  // Binary by filename
  for (const p of BINARY_PATTERNS) {
    if (p.regex.test(filePath)) return { isBinary: true, isSource: false, kind: p.kind };
  }
  // Source by filename
  for (const p of SOURCE_PATTERNS) {
    if (p.regex.test(filePath)) return { isBinary: false, isSource: true, kind: p.kind };
  }
  return { isBinary: false, isSource: false, kind: null };
}

/**
 * Find binary/source duplications.
 * @param {Array<object>} items
 * @returns {{ totalCodeFirstComponents: number, warnings: Array<object>, ok: boolean }}
 */
function checkCodeFirstBinaryDuplication(items) {
  if (!Array.isArray(items)) {
    throw new Error('checkCodeFirstBinaryDuplication: items must be an array');
  }
  const binaries = [];
  const sources = [];

  for (const it of items) {
    const cls = classifyItem(it);
    if (cls.isBinary) binaries.push({ item: it, kind: cls.kind });
    else if (cls.isSource) sources.push({ item: it, kind: cls.kind });
  }

  // Pair: for each binary, find source items in items[] of the same kind that
  // share a name token (componentName or directory base).
  const warnings = [];
  for (const b of binaries) {
    const bName = (b.item.componentName || '').toLowerCase();
    const bPathBase = baseName(b.item.filePath || '');
    const matchedSources = sources.filter((s) => {
      if (s.kind !== b.kind) return false;
      const sName = (s.item.componentName || '').toLowerCase();
      const sPath = s.item.filePath || '';
      // Match by component name token, or by filePath sharing a directory token
      if (bName && sName && (bName === sName || bName.includes(sName) || sName.includes(bName))) return true;
      if (bPathBase && sPath.toLowerCase().includes(bPathBase.toLowerCase())) return true;
      return false;
    });
    if (matchedSources.length === 0) continue;
    warnings.push({
      kind: b.kind,
      componentName: b.item.componentName || null,
      binaryItem: {
        componentId: b.item.componentId ?? null,
        componentType: b.item.componentType ?? null,
        filePath: b.item.filePath ?? null,
      },
      sourceItems: matchedSources.map((s) => ({
        componentId: s.item.componentId ?? null,
        componentType: s.item.componentType ?? null,
        filePath: s.item.filePath ?? null,
      })),
      reason: `Both the assembled ${b.kind} binary AND ${matchedSources.length} matching source file(s) are in this commit. ` +
              `Recommendation: commit source only (rebuild binary on each env via pac/cli) OR commit binary only — not both.`,
    });
  }

  return {
    totalCodeFirstComponents: binaries.length + sources.length,
    warnings,
    ok: true,
  };
}

function baseName(filePath) {
  if (!filePath) return '';
  // Strip directory and extension; what remains is the "stem"
  const idx = filePath.lastIndexOf('/');
  const tail = idx >= 0 ? filePath.slice(idx + 1) : filePath;
  const dotIdx = tail.lastIndexOf('.');
  return dotIdx > 0 ? tail.slice(0, dotIdx) : tail;
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
    process.stderr.write('check-code-first-binary-duplication: provide --items-file, --pending-file, or --stdin\n');
    process.exit(1);
  }
  const r = checkCodeFirstBinaryDuplication(items);
  process.stdout.write(JSON.stringify(r, null, 2) + '\n');
}

if (require.main === module) {
  main().catch((e) => {
    process.stderr.write('check-code-first-binary-duplication: ' + e.message + '\n');
    process.exit(1);
  });
}

module.exports = {
  checkCodeFirstBinaryDuplication, classifyItem, baseName,
  BINARY_PATTERNS, SOURCE_PATTERNS, BINARY_COMPONENT_TYPES,
};
