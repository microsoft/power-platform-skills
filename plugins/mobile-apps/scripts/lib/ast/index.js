'use strict';

/**
 * Semantic (AST) mobile validator.
 *
 * This module owns every behavioral rule for generated TypeScript/React Native
 * app code. Regex validators remain only for lexical contracts (raw literal
 * colors/tokens, Markdown/generated-text shapes) where there is no program to
 * reason about.
 *
 * Contract:
 *   - One `ts.Program` is built per batch and shared by all rules (see program.js).
 *   - Every finding carries `status: 'fail' | 'unknown'`. `unknown` means the
 *     analyzer could not see enough to decide (an opaque dependency, a spread of
 *     an unresolved value, a missing TypeScript install). `unknown` is reported
 *     but never blocks, because "I could not tell" is not evidence of a defect.
 */

const fs = require('node:fs');
const path = require('node:path');

const { createProgram, getProgramBuildCount, resetProgramBuildCount } = require('./program');
const { createJsxHelpers } = require('./jsx');
const { Resolver, lineOf } = require('./resolve');
const { loadTypeScript } = require('./typescript-loader');

const RULE_MODULES = [
  require('./rules/icon-imports'),
  require('./rules/connector-first'),
  require('./rules/dataverse-payload'),
  require('./rules/dataverse-heavy-lists'),
  require('./rules/navigation-idempotency'),
  require('./rules/screen-structure'),
  require('./rules/accessibility'),
  require('./rules/color-contrast'),
];

const ANALYZABLE_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx']);

function isAnalyzableFile(filePath) {
  if (typeof filePath !== 'string') return false;
  const normalized = filePath.replace(/\\/g, '/');
  if (normalized.includes('/node_modules/')) return false;
  if (normalized.includes('/src/generated/')) return false;
  if (normalized.includes('/.expo/')) return false;
  if (normalized.includes('/dist/') || normalized.includes('/build/')) return false;
  return ANALYZABLE_EXTENSIONS.has(path.extname(normalized).toLowerCase());
}

function relativeTo(root, filePath) {
  const relative = path.relative(root, filePath);
  return relative && !relative.startsWith('..') ? relative.replace(/\\/g, '/') : filePath;
}

/**
 * Analyzes a batch of files with a single TypeScript Program.
 *
 * @param {{ projectRoot: string, files: string[] }} options
 * @returns {{ findings: object[], typescript: object|null, analyzedFiles: string[] }}
 */
function analyzeMobileFiles({ projectRoot, files }) {
  const resolvedRoot = fs.realpathSync(path.resolve(projectRoot));
  const targets = files
    .map((file) => path.resolve(resolvedRoot, file))
    .filter((file) => isAnalyzableFile(file) && fs.existsSync(file));

  if (targets.length === 0) {
    return { findings: [], typescript: null, analyzedFiles: [] };
  }

  const loaded = loadTypeScript(resolvedRoot);
  if (!loaded) {
    // Non-blocking by design: without a compiler the analyzer has no opinion.
    return {
      findings: [{
        status: 'unknown',
        rule: 'analyzer-unavailable',
        file: relativeTo(resolvedRoot, targets[0]),
        line: 1,
        message:
          'TypeScript was not found in the app (node_modules/typescript) or in the mobile plugin. '
          + 'Semantic validation was skipped for this batch; run `npm install` in the app to enable it.',
      }],
      typescript: null,
      analyzedFiles: [],
    };
  }

  const { ts } = loaded;
  const { program, checker } = createProgram({ ts, projectRoot: resolvedRoot, files: targets });
  const resolver = new Resolver({ ts, checker, projectRoot: resolvedRoot });
  const jsx = createJsxHelpers(ts);

  const findings = [];
  const context = {
    ts,
    program,
    checker,
    resolver,
    jsx,
    path,
    projectRoot: resolvedRoot,
    lineOf,
    relativePath: (filePath) => relativeTo(resolvedRoot, filePath),
    report(sourceFile, node, { status, rule, message }) {
      findings.push({
        status,
        rule,
        target: context.currentTarget || relativeTo(resolvedRoot, sourceFile.fileName),
        file: relativeTo(resolvedRoot, sourceFile.fileName),
        line: node ? lineOf(node) : 1,
        message,
      });
    },
  };

  const analyzedFiles = [];
  for (const target of targets) {
    context.currentTarget = relativeTo(resolvedRoot, target);
    const sourceFile = program.getSourceFile(target);
    if (!sourceFile) {
      findings.push({
        status: 'unknown',
        rule: 'source-not-parsed',
        target: relativeTo(resolvedRoot, target),
        file: relativeTo(resolvedRoot, target),
        line: 1,
        message: 'TypeScript did not parse this file, so semantic rules were skipped for it.',
      });
      continue;
    }
    analyzedFiles.push(target);
    for (const rule of RULE_MODULES) {
      if (typeof rule.appliesTo === 'function' && !rule.appliesTo(target, context)) continue;
      try {
        rule.run(context, sourceFile);
      } catch (error) {
        // A rule crash must not block a build, but it must be visible.
        findings.push({
          status: 'unknown',
          rule: `${rule.id}-error`,
          target: relativeTo(resolvedRoot, target),
          file: relativeTo(resolvedRoot, target),
          line: 1,
          message: `Rule "${rule.id}" could not complete: ${error && error.message ? error.message : error}`,
        });
      }
    }
  }

  const dedupedFindings = [];
  const seenFindings = new Set();
  for (const finding of findings) {
    const key = [
      finding.status,
      finding.rule,
      finding.target,
      finding.file,
      finding.line,
      finding.message,
    ].join('\u0000');
    if (seenFindings.has(key)) continue;
    seenFindings.add(key);
    dedupedFindings.push(finding);
  }

  return { findings: dedupedFindings, typescript: loaded, analyzedFiles };
}

module.exports = {
  analyzeMobileFiles,
  getProgramBuildCount,
  isAnalyzableFile,
  resetProgramBuildCount,
  RULE_MODULES,
};
