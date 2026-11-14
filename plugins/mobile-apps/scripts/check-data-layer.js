#!/usr/bin/env node

/**
 * check-data-layer.js - verify the `src/hooks/data/` boundary of a generated mobile app.
 *
 * `/create-mobile-app` builds screens against sample data before any Dataverse table, connector,
 * or native wrapper exists, then rewires only the data layer once those land (see
 * `shared/references/preview-data-layer.md`). Two things must hold for that to be safe, and both
 * are mechanical, so they are checked here rather than left to an agent's reading of the code:
 *
 *   1. Screens never reach past the boundary. A screen that imports a generated service, a native
 *      wrapper, or a fixture file directly would keep working on sample data, or break the web
 *      preview, no matter what the data layer is wired to.
 *   2. Every source and device action says what it is bound to, so the run can report exactly
 *      what is still on sample data instead of shipping fake records silently. A module in the
 *      layer with no marker at all fails in either mode: it may be serving sample data, and
 *      nothing would report it, so `--require-wired` could pass with it unwired.
 *
 * Bindings are declared with marker comments around each source or device action:
 *
 *   // DATA SOURCE START - preview
 *   // DATA SOURCE START - dataverse cr123_inspection
 *   // DATA SOURCE START - connector sharepointonline
 *   // DATA SOURCE START - local
 *   // DATA SOURCE END
 *   // DEVICE ACTION START - preview capturePhoto
 *   // DEVICE ACTION START - native camera capturePhoto
 *   // DEVICE ACTION END
 *
 * The first word after " - " is the binding kind. For a device action the last word is the action
 * name. `local` is for data that intentionally stays on the device (for example saved filters).
 *
 * Usage:
 *   node check-data-layer.js --project-root <app> [--require-wired]
 * Prints one JSON object. Exit 0 when clean, 1 on violations (with `--require-wired`, any source
 * or action still bound to `preview` is a violation), 2 on usage errors.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = path.join('src', 'hooks', 'data');
const BINDINGS = new Set(['preview', 'dataverse', 'connector', 'native', 'local']);
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx']);
// Directories whose files are allowed to import generated services and native wrappers: the data
// layer is the adapter, and the other two are the things being adapted.
const BOUNDARY_OWNERS = [DATA_DIR, path.join('src', 'generated'), path.join('src', 'native')];
const SCANNED_ROOTS = ['app', 'src'];
const SKIPPED_DIRS = new Set(['node_modules', '.expo', '.git', 'dist', 'dist-web']);

// `app/_layout.tsx` imports the runtime connector schema map the template generates. It is host
// wiring, not data access, and every app has it, so it is the one generated import allowed outside
// the data layer.
const ALLOWED_GENERATED = /(^|\/)generated\/connectorSchemas$/;

// The barcode scanner is a native *view*, not a function a device action can wrap, so the one
// screen that scans embeds `src/native/barcodeScanner.tsx` directly once it is wired (see
// preview-data-layer.md, "Device actions"). Before wiring the file does not exist, so a premature
// import still fails TypeScript and the web bundle.
const ALLOWED_NATIVE_VIEWS = /^src\/native\/barcodeScanner$/;

function toPosix(relativePath) {
  return relativePath.split(path.sep).join('/');
}

function walk(root, relativeDir, files) {
  const absolute = path.join(root, relativeDir);
  if (!fs.existsSync(absolute)) return files;
  for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
    if (SKIPPED_DIRS.has(entry.name)) continue;
    const relative = path.join(relativeDir, entry.name);
    if (entry.isDirectory()) walk(root, relative, files);
    else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) files.push(relative);
  }
  return files;
}

function isInside(relativePath, directory) {
  return relativePath === directory || relativePath.startsWith(`${directory}${path.sep}`);
}

/**
 * Module specifiers on one line. Matches the forms TypeScript sources here actually use:
 *   import { X } from '@/generated/services/X';
 *   import type { X } from "../generated/models/X";
 *   export * from './inspections';
 *   const m = require('../native/camera');
 *   await import('@/hooks/data/fixtures/inspections');
 * Multi-line imports put `from '...'` on their last line, which this still sees. Lines that are
 * comments are skipped by the caller so a documented example is not mistaken for an import.
 */
const SPECIFIER_PATTERNS = [
  /\bfrom\s+['"]([^'"]+)['"]/g,
  /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
  /^\s*import\s+['"]([^'"]+)['"]/g,
];

function specifiersOnLine(line) {
  const found = [];
  for (const pattern of SPECIFIER_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(line)) !== null) found.push(match[1]);
  }
  return found;
}

/** Resolve `@/x` aliases and relative paths to a project-relative POSIX path, or null for packages. */
function resolveSpecifier(specifier, fromFile) {
  if (specifier.startsWith('@/')) return `src/${specifier.slice(2)}`;
  if (specifier.startsWith('.')) {
    return toPosix(path.normalize(path.join(path.dirname(fromFile), specifier)));
  }
  return null;
}

function classifyImport(target) {
  if (!target) return null;
  if (/^src\/generated(\/|$)/.test(target)) {
    return ALLOWED_GENERATED.test(target) ? null : 'imports-generated';
  }
  if (/^src\/native(\/|$)/.test(target)) {
    return ALLOWED_NATIVE_VIEWS.test(target) ? null : 'imports-native';
  }
  if (/^src\/hooks\/data\/fixtures(\/|$)/.test(target)) return 'imports-fixtures';
  return null;
}

const RULE_DETAIL = {
  'imports-generated': 'reads a generated service or model directly; use a hook from @/hooks/data',
  'imports-native': 'calls a native wrapper directly; use a device action from @/hooks/data',
  'imports-fixtures': 'reads sample records directly; sample data belongs behind a data source',
};

function checkBoundary(root, files) {
  const violations = [];
  for (const file of files) {
    if (BOUNDARY_OWNERS.some((owner) => isInside(file, owner))) continue;
    const lines = fs.readFileSync(path.join(root, file), 'utf8').split(/\r?\n/);
    lines.forEach((line, index) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
      for (const specifier of specifiersOnLine(line)) {
        const rule = classifyImport(resolveSpecifier(specifier, file));
        if (rule) {
          violations.push({ file: toPosix(file), line: index + 1, rule, detail: `${specifier} ${RULE_DETAIL[rule]}` });
        }
      }
    });
  }
  return violations;
}

/**
 * Read the marker blocks in one data-layer module. The marker grammar is documented at the top of
 * this file; anything after the binding kind is free text for a reader (table, connector, name).
 */
function readMarkers(root, file) {
  const sources = [];
  const deviceActions = [];
  const violations = [];
  const lines = fs.readFileSync(path.join(root, file), 'utf8').split(/\r?\n/);
  let open = null;

  lines.forEach((line, index) => {
    const start = line.match(/\/\/\s*(DATA SOURCE|DEVICE ACTION) START\s*-\s*(\S+)(.*)$/);
    const end = line.match(/\/\/\s*(DATA SOURCE|DEVICE ACTION) END\b/);
    if (start) {
      if (open) {
        violations.push({ file: toPosix(file), line: index + 1, rule: 'unclosed-marker', detail: `${open.kind} START at line ${open.line} has no END before the next START` });
      }
      const kind = start[1];
      const binding = start[2].toLowerCase();
      const rest = start[3].trim();
      open = { kind, line: index + 1 };
      if (!BINDINGS.has(binding)) {
        violations.push({ file: toPosix(file), line: index + 1, rule: 'unknown-binding', detail: `'${binding}' is not one of ${[...BINDINGS].join(', ')}` });
      }
      const entry = { file: toPosix(file), line: index + 1, binding, target: rest };
      if (kind === 'DEVICE ACTION') {
        const words = rest.split(/\s+/).filter(Boolean);
        entry.name = words.length ? words[words.length - 1] : '';
        if (!entry.name) {
          violations.push({ file: toPosix(file), line: index + 1, rule: 'unnamed-device-action', detail: 'a DEVICE ACTION marker must end with the action name' });
        }
        deviceActions.push(entry);
      } else {
        sources.push(entry);
      }
    } else if (end) {
      if (!open || open.kind !== end[1]) {
        violations.push({ file: toPosix(file), line: index + 1, rule: 'unmatched-marker', detail: `${end[1]} END without a matching START` });
      }
      open = null;
    }
  });
  if (open) {
    violations.push({ file: toPosix(file), line: open.line, rule: 'unclosed-marker', detail: `${open.kind} START has no END` });
  }
  return { sources, deviceActions, violations };
}

function checkDataLayer(projectRoot, { requireWired = false } = {}) {
  const root = path.resolve(projectRoot);
  const dataDir = path.join(root, DATA_DIR);
  if (!fs.existsSync(dataDir)) {
    // Apps created before the data layer existed import generated services from screens. That is
    // their supported shape, so there is nothing to enforce.
    return { status: 'absent', sources: [], deviceActions: [], previewBound: [], violations: [] };
  }

  const files = SCANNED_ROOTS.flatMap((dir) => walk(root, dir, []));
  const violations = checkBoundary(root, files);
  const sources = [];
  const deviceActions = [];

  const modules = files.filter((file) => isInside(file, DATA_DIR)
    && !isInside(file, path.join(DATA_DIR, 'fixtures'))
    && !['core.ts', 'index.ts'].includes(path.basename(file)));
  for (const file of modules) {
    const markers = readMarkers(root, file);
    sources.push(...markers.sources);
    deviceActions.push(...markers.deviceActions);
    violations.push(...markers.violations);
    // Every module besides core.ts, index.ts, and fixtures holds an entity's source or the device
    // actions (preview-data-layer.md, "Layout"), so one with neither marker has a binding nobody
    // declared, and its sample data would never show up in previewBound or fail --require-wired.
    // A module whose markers are malformed is already reported for that, once.
    if (markers.sources.length === 0 && markers.deviceActions.length === 0 && markers.violations.length === 0) {
      violations.push({
        file: toPosix(file),
        line: 1,
        rule: 'unmarked-module',
        detail: 'declares no DATA SOURCE or DEVICE ACTION marker, so its binding cannot be checked',
      });
    }
  }

  const previewBound = [
    ...sources.filter((entry) => entry.binding === 'preview').map((entry) => `${entry.file}:${entry.line}`),
    ...deviceActions.filter((entry) => entry.binding === 'preview').map((entry) => `${entry.file}#${entry.name}`),
  ];

  if (requireWired) {
    for (const entry of [...sources, ...deviceActions].filter((item) => item.binding === 'preview')) {
      violations.push({
        file: entry.file,
        line: entry.line,
        rule: 'still-preview',
        detail: entry.name ? `device action ${entry.name} still returns sample results` : 'data source still serves sample records',
      });
    }
    // A module with nothing left on sample data must not import fixtures: the fake records would
    // ship in the production bundle even though no code path reads them. A module the user
    // deliberately deferred still serves sample data and needs its fixtures.
    const stillPreview = new Set([...sources, ...deviceActions]
      .filter((item) => item.binding === 'preview')
      .map((item) => item.file));
    for (const file of modules.filter((module) => !stillPreview.has(toPosix(module)))) {
      const lines = fs.readFileSync(path.join(root, file), 'utf8').split(/\r?\n/);
      lines.forEach((line, index) => {
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
        for (const specifier of specifiersOnLine(line)) {
          if (/(^|\/)fixtures(\/|$)/.test(specifier)) {
            violations.push({ file: toPosix(file), line: index + 1, rule: 'wired-module-imports-fixtures', detail: `${specifier} is still imported after wiring` });
          }
        }
      });
    }
  }

  return {
    status: violations.length ? 'violations' : 'ok',
    sources,
    deviceActions,
    previewBound,
    violations,
  };
}

function parseArgs(argv) {
  const options = { requireWired: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--project-root') options.projectRoot = argv[++index];
    else if (argument === '--require-wired') options.requireWired = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!options.projectRoot) throw new Error('--project-root is required');
  return options;
}

if (require.main === module) {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(2);
  }
  const result = checkDataLayer(options.projectRoot, options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(result.status === 'violations' ? 1 : 0);
}

module.exports = { checkDataLayer, classifyImport, resolveSpecifier, specifiersOnLine };
