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
// Deliberately NOT a type check: the plugin ships with no dependencies, so there is no TypeScript
// parser to call, and type checking is the deploy's job. This catches the realistic worker failures —
// an empty file, a truncated write, prose instead of code, elided code.
//
// Every check runs over literal-blanked source (see source-literals.js). A substring search, even over
// a copy that keeps ordinary string bodies, accepted prose that merely MENTIONS an export:
//   /* export default */                                -> accepted
//   const prose = "export default GeneratedComponent";   -> accepted
const { blankLiterals, endsMidStatement, findElisionMarker, hasDefaultExport, hasUnbalancedBrackets } = require('./source-literals.js');

function pageStructureProblems(code) {
  const text = String(code == null ? '' : code);
  if (!text.trim()) return ['file is empty'];
  const problems = [];
  // hasDefaultExport also refuses a file cut off INSIDE its export (`export default function P(props)`
  // with no body), so the message says so: the fix is to write the whole page, not to add an export.
  if (!hasDefaultExport(text)) {
    problems.push('no complete default export — no real `export default` (or `export { X as default }`), '
      + 'or the file ends inside it, so the host cannot mount the page');
  }
  if (hasUnbalancedBrackets(text)) problems.push('unbalanced brackets — the file looks truncated');
  // A cut that leaves every bracket balanced: inside JSX, a template or a comment, or after `a +`.
  if (endsMidStatement(text)) problems.push('stops mid-statement — the file looks truncated');
  // A worker that answers in prose usually still opens a fence, and a real .tsx never has one in CODE.
  // Both CommonMark fence markers count. On the blanked source, a fence inside a template literal (a page
  // rendering markdown help) is data, while a fence wrapping the file is code-position text.
  if (/^\s*(```|~~~)/m.test(blankLiterals(text))) {
    problems.push('contains a markdown code fence — the worker returned prose, not a module');
  }
  // Elided code (`// TODO: …`, `// ...`, "omitted for brevity"), the same rule the genpage evals apply.
  const elision = findElisionMarker(text);
  if (elision) problems.push(`contains ${elision} — the page is incomplete`);
  return problems;
}

module.exports = { pageStructureProblems };
