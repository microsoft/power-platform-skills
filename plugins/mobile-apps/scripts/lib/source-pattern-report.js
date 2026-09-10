'use strict';

const fs = require('node:fs');
const path = require('node:path');

const EXCLUDED_DIRECTORIES = new Map([
  ['node_modules', 'dependency-directory'],
  ['.git', 'version-control-directory'],
  ['.expo', 'generated-build-directory'],
  ['dist', 'generated-build-directory'],
  ['build', 'generated-build-directory'],
  ['brand', 'brand-definition-directory'],
  ['test', 'test-source'],
  ['tests', 'test-source'],
  ['__tests__', 'test-source'],
  ['__mocks__', 'test-source'],
]);

function directoryExclusion(filePath, isDirectory) {
  const parts = path.resolve(filePath).replace(/\\/g, '/').split('/');
  if (!isDirectory) parts.pop();
  for (let index = 0; index < parts.length; index += 1) {
    if (EXCLUDED_DIRECTORIES.has(parts[index])) return EXCLUDED_DIRECTORIES.get(parts[index]);
    if (parts[index] === 'src' && parts[index + 1] === 'generated') return 'generated-source';
    if (parts[index] === 'shared' && parts[index + 1] === 'samples') return 'plugin-sample-source';
  }
  return null;
}

function sourceFileExclusion(filePath, scope) {
  const excluded = directoryExclusion(filePath, false);
  if (excluded) return excluded;
  const normalized = path.resolve(filePath).replace(/\\/g, '/');
  if (!/\.tsx$/i.test(normalized)) return 'unsupported-extension';
  if (/\/_layout\.tsx$/i.test(normalized)) return 'route-layout';
  if (/\.(?:test|spec)\.tsx$/i.test(normalized)) return 'test-source';
  if (scope === 'screens' && !/\/app\/|\/src\/components\//.test(normalized)) return 'outside-screen-scope';
  return null;
}

function usage(validator) {
  return [
    `Usage: node ${validator}.js --report [--strict] [--] [file-or-directory ...]`,
    'Targets default to the current directory. Only eligible .tsx source files are scanned.',
    '--strict is the workflow gate: exit 0 = no source-pattern findings, 1 = findings,',
    '2 = incomplete scan (missing/unreadable targets, no readable nonempty sources, or usage errors).',
    '--report without --strict retains exit 0 for findings; inspect status, passed, issues,',
    'errors, coverage and limitations. Incomplete scans still exit 2. Use --strict in workflows.',
    'Coverage paths resolve from coverage.pathBase. Excluded directories are not enumerated.',
    'Neither a clean report nor exit 0 proves rendered visual quality or WCAG conformance.',
    'No arguments selects the legacy stdin validator protocol, not a directory scan.',
  ].join('\n');
}

function parseArgs(args) {
  const result = { strict: false, report: false, targets: [], errors: [] };
  let positionalOnly = false;
  for (const arg of args) {
    if (arg.trim() === '') result.errors.push('Targets must not be empty.');
    else if (positionalOnly) result.targets.push(arg);
    else if (arg === '--') positionalOnly = true;
    else if (arg === '--report') result.report = true;
    else if (arg === '--strict') result.strict = true;
    else if (arg === '--help' || arg === '-h') result.help = true;
    else if (arg.startsWith('-')) result.errors.push(`Unknown option: ${arg}`);
    else result.targets.push(arg);
  }
  if (!result.report) result.errors.push('CLI scans require --report; use --report --strict for a workflow gate.');
  return result;
}

function runSourceReport({ validator, scope, analyze, limitations = [], args = process.argv.slice(2) }) {
  const parsed = parseArgs(args);
  if (parsed.help) {
    process.stdout.write(`${usage(validator)}\n`);
    return 0;
  }

  const cwd = process.cwd();
  const displayPath = (filePath) => (path.relative(cwd, filePath) || '.').split(path.sep).join('/');
  const roots = (parsed.targets.length ? parsed.targets : [cwd]).map((target) => path.resolve(target));
  const issues = [];
  const errors = parsed.errors.map((message) => ({ path: null, operation: 'arguments', code: 'USAGE', message }));
  const coverage = {
    pathBase: cwd,
    requestedTargets: roots.map(displayPath),
    defaultTargetUsed: parsed.targets.length === 0,
    scope: scope === 'screens' ? 'app/**/*.tsx and src/components/**/*.tsx' : '**/*.tsx',
    scannedFiles: [],
    skipped: [],
  };
  const seen = new Set();
  const skip = (target, kind, reason, extra = {}) => {
    coverage.skipped.push({ path: displayPath(target), kind, reason, ...extra });
  };

  // Catch only filesystem operations. Analyzer/programming errors must not become
  // empty findings or a successful report.
  function readFs(target, operation, action) {
    try {
      return { ok: true, value: action() };
    } catch (error) {
      if (typeof error.code !== 'string' || typeof error.syscall !== 'string') throw error;
      errors.push({ path: displayPath(target), operation, code: error.code, message: error.message });
      return { ok: false };
    }
  }

  // lstat on the leaf alone would still follow an explicit target such as
  // linked-directory/app/home.tsx. Check its ancestors before entering the tree.
  function hasLinkedAncestor(target) {
    let ancestor = path.dirname(target);
    while (ancestor !== path.dirname(ancestor)) {
      const result = readFs(ancestor, 'lstat', () => fs.lstatSync(ancestor));
      if (!result.ok) return true;
      if (result.value.isSymbolicLink()) {
        skip(target, 'path', 'symbolic-link-ancestor', { ancestor: displayPath(ancestor) });
        return true;
      }
      ancestor = path.dirname(ancestor);
    }
    return false;
  }

  if (errors.length === 0) {
    for (const root of roots) {
      if (hasLinkedAncestor(root)) continue;
      // An explicit stack avoids call-stack overflow on deep directory trees.
      const pending = [root];
      while (pending.length > 0) {
        const target = pending.pop();
        if (seen.has(target)) {
          skip(target, 'path', 'already-visited');
          continue;
        }
        seen.add(target);
        const statResult = readFs(target, 'lstat', () => fs.lstatSync(target));
        if (!statResult.ok) continue;
        const stat = statResult.value;
        if (stat.isSymbolicLink()) {
          skip(target, 'symbolic-link', 'symbolic-link-not-followed');
        } else if (stat.isDirectory()) {
          const reason = directoryExclusion(target, true);
          if (reason) {
            skip(target, 'directory', reason, { descendants: 'not-enumerated' });
            continue;
          }
          const entries = readFs(target, 'readdir', () => fs.readdirSync(target));
          if (entries.ok) {
            for (const entry of entries.value.sort().reverse()) pending.push(path.join(target, entry));
          }
        } else if (stat.isFile()) {
          const reason = sourceFileExclusion(target, scope);
          if (reason) {
            skip(target, 'file', reason);
            continue;
          }
          const content = readFs(target, 'read', () => fs.readFileSync(target, 'utf8'));
          if (!content.ok) continue;
          if (content.value.trim() === '') {
            skip(target, 'file', 'empty-source');
            errors.push({ path: displayPath(target), operation: 'scan', code: 'EMPTY_SOURCE', message: 'The requested TSX source is empty; no source patterns could be checked.' });
            continue;
          }
          const file = displayPath(target);
          const findings = analyze(content.value);
          coverage.scannedFiles.push(file);
          for (const finding of findings) {
            issues.push({ validator, file, ...finding });
          }
        } else {
          skip(target, 'special-file', 'not-a-regular-file');
        }
      }
    }
    if (coverage.scannedFiles.length === 0) {
      errors.push({ path: null, operation: 'scan', code: 'NO_SCANNED_FILES', message: 'No readable, nonempty TSX files were scanned. Review requestedTargets and skipped entries; this is not a clean result.' });
    }
  }

  const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0;
  coverage.scannedFiles.sort(compare);
  coverage.skipped.sort((left, right) => compare(left.path, right.path) || compare(left.reason, right.reason));
  issues.sort((left, right) => compare(left.file, right.file) || left.line - right.line || compare(left.rule, right.rule));
  const status = errors.length ? 'incomplete' : issues.length ? 'findings' : 'clean';
  const exitCode = errors.length ? 2 : parsed.strict && issues.length ? 1 : 0;
  const report = {
    schemaVersion: 1,
    validator,
    evidence: 'source-pattern-heuristics',
    strict: parsed.strict,
    status,
    passed: status === 'clean',
    exitCode,
    issues,
    coverage,
    errors,
    limitations: [
      'Static source-pattern heuristics only; source is read as text, never executed, parsed, or rendered. Findings can include false positives and false negatives.',
      'No rendered WCAG contrast ratios, accessibility conformance, layout measurements, or visual-quality approval are established by this report, including a clean result.',
      'Only coverage.scannedFiles were inspected. Excluded directories and symbolic links are not traversed; their descendants are not enumerated or validated.',
      'Imports, aliases, computed styles, theme/token values, runtime states, and inherited component behavior are not resolved.',
      'Issue line numbers are best-effort first literal matches (line 1 when no direct match exists). autoFixable is a suggestion, not a verified safe edit.',
      '--report alone is informational for findings; use --report --strict and inspect coverage, errors, issues, and limitations before workflow completion.',
      ...limitations,
    ],
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (status !== 'clean') {
    process.stderr.write(`[mobile-app] ${validator}: ${status}; ${issues.length} finding(s), ${errors.length} error(s). Read the JSON report and coverage.${!parsed.strict && issues.length ? ' Report-only mode does not gate findings; use --report --strict as the workflow gate.' : ''}\n`);
  }
  return exitCode;
}

module.exports = { runSourceReport, sourceFileExclusion };
