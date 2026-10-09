'use strict';

// The TypeScript parser that review snippets are checked against: the lexer's, and the navigation oracle's tolerance of
// type-only tails. The plugin ships dependency-free, so a checkout has none: point TYPESCRIPT_ORACLE_PATH at a
// `typescript` package to run those checks; they are skipped otherwise.
function loadTypescriptOracle() {
  const at = process.env.TYPESCRIPT_ORACLE_PATH;
  if (!at) return null;
  try {
    return require(at);
  } catch {
    return null;
  }
}

// The Babel parser, for the few places where compilers read the same text differently — a JSX attribute string written after white space is a
// string with escapes to TypeScript and one without to Babel and esbuild. Point BABEL_ORACLE_PATH at an `@babel/parser` package to run those
// checks; they are skipped otherwise.
function loadBabelOracle() {
  const at = process.env.BABEL_ORACLE_PATH;
  if (!at) return null;
  try {
    return require(at);
  } catch {
    return null;
  }
}

module.exports = { loadTypescriptOracle, loadBabelOracle };
