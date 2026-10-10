'use strict';

const path = require('node:path');

// A parser or lexer that a test is pointed at by an environment variable must load: a variable that is set and a package that is not there is a broken setup, and the tests that need it must FAIL, not skip — the CI job
// that runs them (test-model-apps-lexer-oracles) would otherwise pass without running one. Unset, the loader answers null and the test skips.
function loadFromEnv(name, what, file = '') {
  const at = process.env[name];
  if (!at) return null;
  try {
    return require(file ? path.join(at, file) : at);
  } catch (error) {
    throw new Error(`${name} is set to ${JSON.stringify(at)}, which does not load as ${what}: ${error.message}`);
  }
}

// The TypeScript parser that review snippets are checked against: the lexer's, and the navigation oracle's tolerance of
// type-only tails. The plugin ships dependency-free, so a checkout has none: point TYPESCRIPT_ORACLE_PATH at a
// `typescript` package to run those checks; they are skipped otherwise.
function loadTypescriptOracle() {
  return loadFromEnv('TYPESCRIPT_ORACLE_PATH', 'a typescript package');
}

// The Babel parser, for the few places where compilers read the same text differently — a JSX attribute string written after white space is a
// string with escapes to TypeScript and one without to Babel and esbuild. Point BABEL_ORACLE_PATH at an `@babel/parser` package to run those
// checks; they are skipped otherwise.
function loadBabelOracle() {
  return loadFromEnv('BABEL_ORACLE_PATH', 'an @babel/parser package');
}

// The navigation resolver of the lexer before a change, for the sweeps that compare what each lexer reads (a page that the base resolves must be resolved here, and the pages it misreads show that the sweep sees a
// misread). Point BASE_LIB_PATH at the scripts/lib directory of that release; the comparison is skipped otherwise.
function loadBaseLexer() {
  return loadFromEnv('BASE_LIB_PATH', 'the scripts/lib directory of a release (pageref-resolver.js)', 'pageref-resolver.js');
}

module.exports = { loadTypescriptOracle, loadBabelOracle, loadBaseLexer };
