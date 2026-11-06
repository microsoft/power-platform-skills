'use strict';
// The canonical page error block of references/rules.md ("Missing Error Handling"), read once and kept as canonical
// lines — comments blanked, each line trimmed, empty lines dropped, line breaks kept: here PageErrorBoundary and its
// documented `extends Component<…>` form and telemetry hand-off. The boundary-wrapper proof of source-evidence.js compares
// a page's boundary with these: a wrapper whose boundary is not this class may hand PageBody anything, so it must not prove
// where the page's dataApi comes from. polymorphic-lookup-contract.js reads its canonical normalizer with the same line and
// top-level-function readers. Whether a page's failures reach its reporter is not graded (EVAL_GUIDE.md).
//
// This module requires nothing from the evaluator modules (source-evidence.js requires it), so either can load first.

const fs = require('node:fs');
const path = require('node:path');
const { blankNonCodePreservingTemplateExpressions, commentRanges } = require('../../../../plugins/model-apps/scripts/lib/source-literals.js');

const RULES_PATH = path.join(__dirname, '..', '..', '..', '..', 'plugins', 'model-apps', 'references', 'rules.md');
const REPORTER = 'reportPageError';
const BOUNDARY = 'PageErrorBoundary';

// A source's significant lines: comments blanked (the lexer's own ranges, so a `//` inside a string survives), each
// line trimmed, empty lines dropped. Line breaks are KEPT: they decide automatic semicolon insertion (`return\nview`).
function canonicalLines(text) {
  const chars = String(text).replace(/\r\n/g, '\n').split('');
  for (const { start, end } of commentRanges(chars.join(''))) for (let i = start; i < end; i += 1) if (chars[i] !== '\n') chars[i] = ' ';
  return chars.join('').split('\n').map((line) => line.trim()).filter(Boolean);
}

// The index of the bracket closing the one at `open` in a masked source (strings, comments and JSX text blanked).
function closeOf(mask, open) {
  const pairs = { '(': ')', '{': '}', '[': ']' };
  const stack = [];
  for (let i = open; i < mask.length; i += 1) {
    if (pairs[mask[i]]) stack.push(pairs[mask[i]]);
    else if (')}]'.includes(mask[i])) {
      if (stack.pop() !== mask[i]) throw new Error('unbalanced source');
      if (!stack.length) return i;
    }
  }
  throw new Error('unbalanced source');
}

// How many brackets are open at `at`: 0 at the top level of the module.
function depthAt(mask, at) {
  let depth = 0;
  for (let i = 0; i < at; i += 1) {
    if ('({['.includes(mask[i])) depth += 1;
    else if (')}]'.includes(mask[i])) depth -= 1;
  }
  return depth;
}

const escapeRe = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// `function <name>(…) … { … }` declared at the top level of `code`, as [start, end) offsets; null when absent.
function topLevelFunction(code, mask, name) {
  for (const match of mask.matchAll(new RegExp(`\\bfunction\\s+${escapeRe(name)}\\s*\\(`, 'g'))) {
    if (depthAt(mask, match.index) !== 0) continue;
    const paramsOpen = match.index + match[0].length - 1;
    const paramsEnd = closeOf(mask, paramsOpen);
    const bodyOpen = mask.indexOf('{', paramsEnd);
    if (bodyOpen < 0) return null;
    return { start: match.index, bodyOpen, end: closeOf(mask, bodyOpen) + 1 };
  }
  return null;
}

// `class <name> extends …<…> { … }` declared at the top level of `code`, as [start, end) offsets; null when absent.
function topLevelClass(code, mask, name) {
  for (const match of mask.matchAll(new RegExp(`\\bclass\\s+${escapeRe(name)}\\s+extends\\b`, 'g'))) {
    if (depthAt(mask, match.index) !== 0) continue;
    // The body opens at the first `{` after the closing `>` of the base's type arguments.
    let i = match.index + match[0].length;
    let angle = 0;
    for (; i < mask.length; i += 1) {
      if (mask[i] === '<') angle += 1;
      else if (mask[i] === '>' && angle > 0) angle -= 1;
      else if (mask[i] === '{' && angle === 0) break;
      else if (mask[i] === '{') i = closeOf(mask, i);
    }
    if (i >= mask.length) return null;
    return { start: match.index, bodyOpen: i, end: closeOf(mask, i) + 1 };
  }
  return null;
}

let blocks = null;
function ruleBlocks() {
  if (blocks) return blocks;
  const rules = fs.readFileSync(RULES_PATH, 'utf8').replace(/\r\n/g, '\n');
  const start = rules.indexOf('\n### 2. Missing Error Handling\n');
  if (start < 0) throw new Error('references/rules.md has no "Missing Error Handling" section');
  const next = rules.indexOf('\n### ', start + 10);
  const section = rules.slice(start, next < 0 ? rules.length : next);
  const all = [...section.matchAll(/```tsx\n([\s\S]*?)\n```/g)].map((match) => match[1]);
  const foundation = all.find((block) => new RegExp(`\\bfunction ${REPORTER}\\(`).test(block));
  if (!foundation) throw new Error('references/rules.md does not publish the canonical page error block');
  blocks = { foundation, mask: blankNonCodePreservingTemplateExpressions(foundation) };
  return blocks;
}

let boundary = null;
// PageErrorBoundary: every documented form — `React.Component`/`React.ReactNode` or `Component`/`ReactNode` (a page that
// imports React by name), and the render-crash report with or without the telemetry hand-off.
function canonicalBoundaries() {
  if (boundary) return boundary;
  const { foundation, mask } = ruleBlocks();
  const range = topLevelClass(foundation, mask, BOUNDARY);
  const lines = canonicalLines(foundation.slice(range.start, range.end));
  const report = "reportPageError(PAGE_NAME, 'render', undefined, error, 'render');";
  if (!lines.includes(report)) throw new Error('references/rules.md PageErrorBoundary does not report the render crash');
  const telemetry = lines.map((line) => (line === report ? "reportPageError(PAGE_NAME, 'render', undefined, error, 'render', undefined, this.props.appInsights);" : line));
  const named = (text) => text.replace(/\bReact\.Component\b/g, 'Component').replace(/\bReact\.ReactNode\b/g, 'ReactNode');
  boundary = [lines, telemetry].flatMap((form) => [form.join('\n'), named(form.join('\n'))]);
  return boundary;
}

// The boundary-wrapper proof (source-evidence.js) holds only a masked source — strings and comments blanked — so it
// compares the page's boundary with the documented forms masked the same way: the same code, string contents aside (no
// string decides what the boundary hands its child). The page's PageErrorBoundary must be one top-level class equal to a
// documented form — one getDerivedStateFromError, one componentDidCatch, one render that returns `this.props.children`,
// nothing added (a second `render()` overrides the first) — and React and Component must not be names the page binds
// itself. Returns the class range, or null: a wrapper whose boundary is anything else may hand PageBody any object.
// Runs of blanks collapse to one, so a string of another length (a blanked `'error.render'`) compares equal.
const maskedLines = (text) => String(text).split('\n').map((line) => line.trim().replace(/\s+/g, ' ')).filter(Boolean).join('\n');
let boundaryMasks = null;
function transparentBoundary(mask) {
  if (!boundaryMasks) boundaryMasks = canonicalBoundaries().map((form) => maskedLines(blankNonCodePreservingTemplateExpressions(form)));
  const declarations = mask.match(new RegExp(`\\b(?:function|class|const|let|var)\\s+${BOUNDARY}(?![\\w$])`, 'g')) || [];
  if (declarations.length !== 1) return null;
  if (/\b(?:function|class|const|let|var)\s+(?:React|Component)(?![\w$])/.test(mask)) return null;
  if (/(?<![\w$])(?:React\s*\.\s*)?Component\s*=(?![=>])|(?<![\w$.])React\s*=(?![=>])/.test(mask)) return null;
  let range;
  try { range = topLevelClass(mask, mask, BOUNDARY); } catch { return null; }
  if (!range || !boundaryMasks.includes(maskedLines(mask.slice(range.start, range.end)))) return null;
  return range;
}

module.exports = {
  canonicalLines, closeOf, depthAt, topLevelFunction, topLevelClass, canonicalBoundaries,
  transparentBoundary,
};
