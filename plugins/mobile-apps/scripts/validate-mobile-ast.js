#!/usr/bin/env node

/**
 * Semantic (AST) validator for mobile app TypeScript/TSX.
 *
 * This is the authoritative behavioral gate for generated app code. It builds a
 * single TypeScript `Program` for the whole batch, resolves imports and symbols
 * with the TypeChecker, and reports structured findings:
 *
 *   { status: 'fail' | 'unknown', rule, file, line, message }
 *
 *   fail    → the analyzer proved the contract is violated. Exit code 2.
 *   unknown → the analyzer could not see enough to decide (opaque dependency,
 *             dynamic value, or no TypeScript install). Printed as a warning and
 *             included in `--report` JSON, but never blocking: "I could not tell"
 *             is not evidence of a defect, and blocking on it is exactly the
 *             false-positive behavior this validator replaces.
 *
 * Usage:
 *   node scripts/validate-mobile-ast.js --project-root <path> --file <path> [--file <path> ...]
 *   node scripts/validate-mobile-ast.js --project-root <path> --report --file <path> ...
 *   node scripts/validate-mobile-ast.js --project-root <path> --report <dir-or-file> ...
 *
 * Exit codes:
 *   0 = no blocking findings (unknowns may still be present)
 *       `--report` also exits 0 and carries proven failures in JSON.
 *   1 = bad invocation
 *   2 = at least one `fail` finding in canonical (non-report) mode
 */

const fs = require('node:fs');
const path = require('node:path');

const { analyzeMobileFiles, isAnalyzableFile } = require('./lib/ast');
const { collectSourceFiles } = require('./lib/ast/program');

// Findings a stylistic sweep can fix mechanically without design judgement.
// Consumed by the `--report` JSON so /create-mobile-app and /edit-app can batch
// them the same way they batch lexical validator output.
const AUTO_FIXABLE_RULES = new Set([
  'custom-pressable-missing-role',
  'dynamic-type-disabled',
  'icon-only-control-missing-label',
  'low-contrast-foreground-token',
  'small-touch-target-without-hitslop',
  'unsupported-button-theme',
  'white-on-warm-status-fill',
]);

function usage() {
  return [
    'Usage: node validate-mobile-ast.js --project-root <path> [--report] --file <path> [--file <path> ...]',
    '',
    'Runs every semantic mobile rule over one TypeScript Program built for the whole batch.',
    'Directories passed as targets are expanded to their .js/.jsx/.ts/.tsx files.',
    'Canonical mode exits 2 for blocking (`fail`) findings.',
    'Report mode always exits 0; inspect each JSON issue status. `unknown` never blocks.',
  ].join('\n');
}

function parseArgs(argv) {
  const parsed = {
    projectRoot: null,
    targets: [],
    report: false,
    help: false,
    json: false,
    errors: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--project-root') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) parsed.errors.push('Missing value for --project-root.');
      else parsed.projectRoot = value;
      index += 1;
    } else if (arg === '--file') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) parsed.errors.push('Missing value for --file.');
      else parsed.targets.push(value);
      index += 1;
    } else if (arg === '--report' || arg === '--json') {
      parsed.report = true;
      parsed.json = true;
    } else if (arg === '--help' || arg === '-h') {
      parsed.help = true;
    } else if (arg) {
      parsed.targets.push(arg);
    }
  }
  return parsed;
}

function isWithinRoot(filePath, projectRoot) {
  const relative = path.relative(projectRoot, filePath);
  return relative === ''
    || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

/** Expands directories to their analyzable sources so `--report app/` works. */
function expandTargets(projectRoot, targets, { allowMissing = false } = {}) {
  const files = new Set();
  for (const target of targets) {
    if (!target) continue;
    const requested = path.resolve(projectRoot, target);
    if (!fs.existsSync(requested)) {
      if (allowMissing) continue;
      throw new Error(`Validation target not found: ${requested}`);
    }
    const requestedStat = fs.lstatSync(requested);
    if (requestedStat.isSymbolicLink()) {
      throw new Error(`Validation target must not be a symbolic link: ${requested}`);
    }
    const resolved = fs.realpathSync(requested);
    if (!isWithinRoot(resolved, projectRoot)) {
      throw new Error(`Resolved validation target is outside the mobile project root: ${resolved}`);
    }
    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) {
      const realDirectory = fs.realpathSync(resolved);
      for (const file of collectSourceFiles(realDirectory)) {
        if (isAnalyzableFile(file)) files.add(fs.realpathSync(file));
      }
      continue;
    }
    if (stat.isFile() && isAnalyzableFile(resolved)) files.add(fs.realpathSync(resolved));
  }
  return [...files];
}

function formatFinding(finding) {
  return `  ${finding.status.toUpperCase()} [${finding.rule}] ${finding.file}:${finding.line}\n    ${finding.message}`;
}

function main(argv) {
  const parsed = parseArgs(argv);
  if (parsed.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  if (parsed.errors.length > 0) {
    process.stderr.write(`${parsed.errors.join('\n')}\n\n${usage()}\n`);
    return 1;
  }
  if (!parsed.projectRoot) {
    process.stderr.write(`${usage()}\n`);
    return 1;
  }

  const requestedProjectRoot = path.resolve(parsed.projectRoot);
  const projectRoot = fs.existsSync(requestedProjectRoot)
    ? fs.realpathSync(requestedProjectRoot)
    : requestedProjectRoot;
  if (!fs.existsSync(projectRoot) || !fs.statSync(projectRoot).isDirectory()) {
    process.stderr.write(`Project root not found: ${projectRoot}\n`);
    return 1;
  }

  let targets;
  const usingImplicitTargets = parsed.targets.length === 0;
  try {
    targets = expandTargets(
      projectRoot,
      usingImplicitTargets ? ['app', 'src'] : parsed.targets,
      { allowMissing: usingImplicitTargets },
    );
  } catch (error) {
    process.stderr.write(`BLOCKED: ${error.message}\n`);
    return 1;
  }
  if (targets.length === 0) {
    if (parsed.report) {
      process.stdout.write(`${JSON.stringify({ validator: 'validate-mobile-ast', issues: [] }, null, 2)}\n`);
    }
    return 0;
  }

  const { findings, typescript } = analyzeMobileFiles({ projectRoot, files: targets });
  const failures = findings.filter((finding) => finding.status === 'fail');
  const unknowns = findings.filter((finding) => finding.status === 'unknown');

  if (parsed.report) {
    const payload = {
      validator: 'validate-mobile-ast',
      typescript: typescript
        ? { version: typescript.version, source: typescript.source }
        : null,
      summary: { analyzed: targets.length, fail: failures.length, unknown: unknowns.length },
      issues: findings.map((finding) => ({
        validator: 'validate-mobile-ast',
        status: finding.status,
        file: finding.file,
        line: finding.line,
        rule: finding.rule,
        match: finding.rule,
        message: finding.message,
        fix: finding.message,
        autoFixable: finding.status === 'fail' && AUTO_FIXABLE_RULES.has(finding.rule),
      })),
    };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return 0;
  }

  if (unknowns.length > 0) {
    process.stderr.write(
      `[mobile-app] Semantic validation could not verify ${unknowns.length} item(s). These are warnings and do not block:\n`
      + `${unknowns.map(formatFinding).join('\n')}\n`,
    );
  }

  if (failures.length > 0) {
    process.stderr.write(
      '[mobile-app] Semantic validation found code that breaks a runtime or accessibility contract. '
      + 'The write was blocked; the agent will fix and retry.\n\n'
      + `For the agent: BLOCKED: ${failures.length} semantic finding(s)\n`
      + `${failures.map(formatFinding).join('\n')}\n`,
    );
    return 2;
  }

  process.stdout.write(
    `Semantic validation passed for ${targets.length} TypeScript file(s)`
    + `${typescript ? ` (TypeScript ${typescript.version} from ${typescript.source})` : ''}`
    + `${unknowns.length > 0 ? `; ${unknowns.length} unknown warning(s)` : ''}.\n`,
  );
  return 0;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = { AUTO_FIXABLE_RULES, expandTargets, isWithinRoot, main, parseArgs };
