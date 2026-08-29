const path = require('node:path');

const SOURCE_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx']);
const SEMANTIC_SOURCE_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx']);
const TEXT_EXTENSIONS = new Set([
  '.css',
  '.html',
  '.js',
  '.json',
  '.jsx',
  '.md',
  '.ts',
  '.tsx',
  '.yaml',
  '.yml',
]);

function hasExtension(filePath, extensions) {
  return extensions.has(path.extname(filePath).toLowerCase());
}

/**
 * Per-file validators. These are *lexical* checks only: path safety, package
 * manifests, and raw literal color/token bans. Anything that depends on what the
 * code actually does — imports, symbols, component composition, payload shape —
 * belongs to the semantic batch validator below.
 *
 * The behavioral hooks that used to run here (`validate-icon-imports.js`,
 * `validate-connector-first.js`, `validate-dataverse-payload.js`,
 * `validate-dataverse-heavy-lists.js`, `validate-navigation-idempotency.js`,
 * `validate-color-contrast.js`) still exist so anything invoking them directly
 * keeps working, but they are no longer the authority: those rules are
 * implemented semantically under `scripts/lib/ast/rules/` and reached through
 * `scripts/validate-mobile-ast.js`.
 */
const VALIDATORS = [
  { script: 'validate-write-safety.js', appliesTo: () => true },
  { script: 'validate-protected-paths.js', appliesTo: () => true },
  { script: 'validate-package-deps.js', appliesTo: (filePath) => path.basename(filePath) === 'package.json' },
  { script: 'validate-screen-quality.js', appliesTo: (filePath) => path.extname(filePath).toLowerCase() === '.tsx' },
];

/**
 * Batch validators run ONCE per dispatcher invocation over every matching file.
 *
 * The semantic validator builds one `ts.Program` for the batch and reuses it for
 * every rule. Running it per file would rebuild — and re-parse every transitively
 * imported module of — the program once per screen, so the batch contract is a
 * correctness-of-cost requirement, not a micro-optimisation.
 */
const BATCH_VALIDATORS = [
  {
    script: 'validate-mobile-ast.js',
    directory: 'scripts',
    appliesTo: (filePath) => hasExtension(filePath, SEMANTIC_SOURCE_EXTENSIONS),
  },
];

function isTextFile(filePath) {
  return hasExtension(filePath, TEXT_EXTENSIONS);
}

module.exports = {
  BATCH_VALIDATORS,
  SOURCE_EXTENSIONS,
  SEMANTIC_SOURCE_EXTENSIONS,
  VALIDATORS,
  isTextFile,
};
