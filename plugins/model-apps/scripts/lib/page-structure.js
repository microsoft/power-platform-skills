'use strict';

// The structural checks a generated page must pass before it is accepted: ONE list for the two gates
// that accept a page.
//   * genpage-worker-output.js — /genpage accepts one parallel worker's page file;
//   * promote-intent-pages.js — /app-builder flips a page from `intent` to `tsx`, which is sticky:
//     a promoted page is marked implemented and skipped on the next run.
// They were two copies with the same checks and different wording, and they had already drifted once:
// the elision-marker check and the fence check on BLANKED source were added to one gate and had to be
// found missing from the other. A page one gate refuses, the other now refuses too, with the same words.
//
// Deliberately NOT a type check. The plugin ships the TypeScript compiler for the SDK's page compile, which loads it lazily (~0.2 s: lib/typescript-compiler.js) —
// more than a gate on every page file should pay — so the page is read by the lexer, and the parser is asked only about a page on which the lexer guessed
// (parsedViews, below); and that compile is a transpile, not a type check, so a type error is not caught at deploy either. This catches the realistic worker
// failures — an empty file, a truncated write, prose instead of code, elided code.
//
// Every check runs over literal-blanked source (see source-literals.js). A substring search, even over
// a copy that keeps ordinary string bodies, accepted prose that merely MENTIONS an export:
//   /* export default */                                -> accepted
//   const prose = "export default GeneratedComponent";   -> accepted
const { blankLiterals, endsMidStatement, findElisionMarker, hasDefaultExport, hasUnbalancedBrackets, trimTrivia, WS } = require('./source-literals.js');
const { guessedPageViews } = require('./typescript-views.js');

// A line that opens a markdown fence, after the white space TypeScript skips (source-literals.js, isTrivia): U+0085 and the zero-width space before a fence are white space to it.
const MARKDOWN_FENCE = new RegExp(`^${WS}*(\`\`\`|~~~)`, 'm');

// Where the lexer guessed what a construct is (source-literals.js, `onAmbiguity`), its view of the page may be wrong from there on — an interface's generic call
// signature, `interface Api { <U>(x: U): U; }`, reads to it as an element whose text runs to the end of the file, and a complete page as cut off. So where it
// guessed, the page is read as the TypeScript parser reads it (typescript-views.js: the same views, built from the parse), when the parser reports no diagnostic;
// where it does report one, or did not need to be asked, the lexer's views stand — and so they do where another reader reads the page differently or refuses it
// (a JSX attribute string after trivia, grammar only TypeScript's parser takes), decided by guessedPageViews exactly as the navigation oracle decides it. Every
// check is the same either way: only the views they read differ.
function parsedViews(text) {
  return guessedPageViews(text).views;
}

function pageStructureProblems(code) {
  const text = String(code == null ? '' : code);
  if (!trimTrivia(text)) return ['file is empty'];
  const views = parsedViews(text);
  const problems = [];
  // hasDefaultExport also refuses a file cut off INSIDE its export (`export default function P(props)`
  // with no body), so the message says so: the fix is to write the whole page, not to add an export.
  if (!hasDefaultExport(text, views)) {
    problems.push('no complete default export — no real `export default` (or `export { X as default }`), '
      + 'or the file ends inside it, so the host cannot mount the page');
  }
  if (hasUnbalancedBrackets(text, views)) problems.push('unbalanced brackets — the file looks truncated');
  // A cut that leaves every bracket balanced: inside JSX, a template or a comment, or after `a +`.
  if (endsMidStatement(text, views)) problems.push('stops mid-statement — the file looks truncated');
  // A worker that answers in prose usually still opens a fence, and a real .tsx never has one in CODE.
  // Both CommonMark fence markers count. On the blanked source, a fence inside a template literal (a page
  // rendering markdown help) is data, while a fence wrapping the file is code-position text.
  if (MARKDOWN_FENCE.test(views ? views.literal : blankLiterals(text))) {
    problems.push('contains a markdown code fence — the worker returned prose, not a module');
  }
  // Elided code (`// TODO: …`, `// ...`, "omitted for brevity"), the same rule the genpage evals apply.
  const elision = findElisionMarker(text, views);
  if (elision) problems.push(`contains ${elision} — the page is incomplete`);
  return problems;
}

module.exports = { pageStructureProblems };
