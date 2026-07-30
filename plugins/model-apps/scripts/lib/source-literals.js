'use strict';
// A small lexer for TSX source, used where a check has to distinguish real code from text.
//
// WHY hand-rolled: this plugin ships **dependency-free** (no package.json, no node_modules; it is
// installed by copying its directory, and every runtime `require` under scripts/ is a node builtin
// or a relative path), so there is no TypeScript parser to call. Several checks nevertheless have to
// answer "is this token code, or is it text?", and getting that wrong is costly in BOTH directions:
//
//   accepting text as code   ->  prose is promoted as a page, permanently marked implemented
//   rejecting code as text   ->  a valid generated page is refused and the user is blocked mid-build
//
// The second is worse, which is why this tracks JSX properly instead of running regexes over the
// raw file. Naive approaches fail on ordinary generated pages:
//   <p>https://contoso.com/help</p>   `//` is not a comment here
//   <p>1) Review details</p>          `)` is not a bracket here
//   const re = /\(/;                  `(` is not a bracket here
//   "The worker says export default X is required."   not an export statement
//
// MODES: code (incl. JSX expressions), comment, string, template, regex, JSX tag, JSX text.
// Blanked characters become spaces and newlines are preserved, so output offsets map 1:1 onto the
// input and a caller may mix matches across both.

// `/` starts a regex (rather than division) only where an expression may begin. Same idea for `<`
// starting JSX rather than a comparison or a TypeScript generic argument list.
const EXPR_START_PUNCT = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^', '\n']);
const EXPR_START_WORDS = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'case', 'do', 'else', 'yield', 'await']);

function prevSignificant(src, i) {
  for (let j = i - 1; j >= 0; j -= 1) {
    if (!/\s/.test(src[j])) return { ch: src[j], index: j };
  }
  return { ch: '', index: -1 };
}

function expressionPosition(src, i) {
  const { ch, index } = prevSignificant(src, i);
  if (ch === '') return true;                    // start of file
  if (EXPR_START_PUNCT.has(ch)) return true;
  if (/[\w$)\]]/.test(ch)) {
    // Could be the tail of a keyword like `return` — read the word back.
    let s = index;
    while (s >= 0 && /[\w$]/.test(src[s])) s -= 1;
    return EXPR_START_WORDS.has(src.slice(s + 1, index + 1));
  }
  return false;
}

// `<` in a .tsx file is ambiguous: JSX, or a TypeScript type-parameter list. Both can appear right
// after `=`, so position alone cannot separate them:
//   const updateField = <K extends keyof FormState>(key: K) => { … }   // generic arrow
//   const pick = <T extends { id: string }>(x: T): T => x;             // generic arrow
//   const el = <Section title="x">…</Section>;                         // JSX
//   return <button>(</button>;                                          // JSX
// Treating JSX as a generic (or vice versa) desynchronises the lexer for the rest of the file.
//
// Discriminate STRUCTURALLY rather than on keywords: a generic arrow's type-parameter list is
// followed by a balanced parameter list and then `=>` (optionally via a return-type annotation).
// Nothing else has that shape. Keyword heuristics were not enough — `extends` misses `<T,>(x) => x`,
// and "the matching `>` is followed by `(`" wrongly claimed `<button>(</button>`.
function looksLikeTypeParams(src, i) {
  const limit = Math.min(src.length, i + 400);   // type-parameter lists are short; bail rather than scan a file
  let angle = 0;
  let brace = 0;                                 // `<T extends { id: string }>` — braces are legal inside
  let j = i;
  for (; j < limit; j += 1) {
    const c = src[j];
    if (c === '{') brace += 1;
    else if (c === '}') brace -= 1;
    else if (c === ';' || c === '`') return false;
    else if (brace === 0) {
      if (c === '<') angle += 1;
      else if (c === '>') { angle -= 1; if (angle === 0) break; }
    }
  }
  if (j >= limit) return false;                  // never closed within the window

  // Skip the balanced parameter list that must follow.
  let k = j + 1;
  while (k < src.length && /\s/.test(src[k])) k += 1;
  if (src[k] !== '(') return false;
  let depth = 0;
  for (; k < src.length; k += 1) {
    if (src[k] === '(') depth += 1;
    else if (src[k] === ')') { depth -= 1; if (depth === 0) { k += 1; break; } }
  }
  if (depth !== 0) return false;                 // unbalanced — this was JSX text, not a parameter list

  while (k < src.length && /\s/.test(src[k])) k += 1;
  if (src[k] === '=' && src[k + 1] === '>') return true;
  // A return-type annotation may sit between: `<T>(x: T): T => x`. Look for the arrow before the
  // statement ends.
  if (src[k] !== ':') return false;
  const tail = src.slice(k, Math.min(src.length, k + 200));
  const stop = tail.indexOf(';');
  return /=>/.test(stop === -1 ? tail : tail.slice(0, stop));
}

/**
 * Blank every comment, string, template, regex literal and JSX text run in TSX source.
 * @param {string} code
 * @returns {string} same length as `code`, non-code regions replaced by spaces
 */
function blankLiterals(code) {
  const src = String(code || '');
  // split('') and NOT [...src]: the spread iterates by CODE POINT, so an astral character (an emoji
  // in a label, which generated pages do use) makes array indices drift out of step with the UTF-16
  // offsets everything else here uses, corrupting the output.
  const out = src.split('');
  const blank = (from, to) => {
    for (let k = Math.max(0, from); k < to && k < src.length; k += 1) if (src[k] !== '\n') out[k] = ' ';
  };

  let mode = 'code';
  let jsxDepth = 0;                 // open JSX elements in the CURRENT expression frame
  let angleDepth = 0;               // nested < > inside a tag's type arguments
  const frames = [];                // JSX-expression frames: { returnMode, braceDepth, savedJsxDepth }
  let i = 0;

  const leaveJsxExpr = () => {
    const f = frames.pop();
    if (!f) { mode = 'code'; return; }
    // Restore the enclosing element depth. It must be per-frame: in
    //   <div>{items.map(x => { return (<section>…</section>); })}</div>
    // the `<div>` is open across the whole expression, but once `</section>` closes we are back in
    // CODE (inside the arrow body), not in the div's text run. A single global counter left the
    // lexer in jsxText for the rest of the file and blanked the real `export default`.
    jsxDepth = f.savedJsxDepth;
    mode = f.returnMode;
  };
  const enterJsxExpr = (returnMode) => {
    frames.push({ returnMode, braceDepth: 0, savedJsxDepth: jsxDepth });
    jsxDepth = 0;
    mode = 'code';
  };

  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];

    if (mode === 'code') {
      if (c === '/' && n === '/') {
        const end = src.indexOf('\n', i);
        blank(i, end === -1 ? src.length : end);
        i = end === -1 ? src.length : end;
        continue;
      }
      if (c === '/' && n === '*') {
        const end = src.indexOf('*/', i + 2);
        const stop = end === -1 ? src.length : end + 2;
        blank(i, stop);
        i = stop;
        continue;
      }
      if (c === '"' || c === "'") {
        let j = i + 1;
        for (; j < src.length; j += 1) {
          if (src[j] === '\\') { j += 1; continue; }
          if (src[j] === c) break;
          if (src[j] === '\n') { j = -1; break; }   // a string cannot span a raw newline
        }
        if (j === -1) { i += 1; continue; }
        blank(i + 1, j);
        i = Math.min(j + 1, src.length);
        continue;
      }
      if (c === '`') {
        // Template literal. `${}` expressions are blanked with the rest: no declaration lives inside
        // one, and tracking their nesting would only add ways to be wrong.
        let j = i + 1;
        let d = 0;
        for (; j < src.length; j += 1) {
          if (src[j] === '\\') { j += 1; continue; }
          if (src[j] === '{' && src[j - 1] === '$') d += 1;
          else if (src[j] === '}' && d > 0) d -= 1;
          else if (src[j] === '`' && d === 0) break;
        }
        blank(i + 1, j);
        i = Math.min(j + 1, src.length);
        continue;
      }
      if (c === '/' && expressionPosition(src, i)) {
        // Regex literal: scan to the unescaped closing `/`, honouring a character class so `/[/]/`
        // does not terminate early.
        let j = i + 1;
        let inClass = false;
        for (; j < src.length; j += 1) {
          if (src[j] === '\\') { j += 1; continue; }
          if (src[j] === '\n') { j = -1; break; }
          if (src[j] === '[') inClass = true;
          else if (src[j] === ']') inClass = false;
          else if (src[j] === '/' && !inClass) break;
        }
        if (j === -1) { i += 1; continue; }
        blank(i + 1, j);
        i = Math.min(j + 1, src.length);
        continue;
      }
      if (c === '<' && /[A-Za-z_$>]/.test(n || '') && expressionPosition(src, i) && !looksLikeTypeParams(src, i)) {
        mode = 'jsxTag';
        i += 1;
        continue;
      }
      if (frames.length) {
        const top = frames[frames.length - 1];
        if (c === '{') { top.braceDepth += 1; i += 1; continue; }
        if (c === '}') {
          if (top.braceDepth === 0) { leaveJsxExpr(); i += 1; continue; }
          top.braceDepth -= 1; i += 1; continue;
        }
      }
      i += 1;
      continue;
    }

    if (mode === 'jsxTag') {
      if (c === '"' || c === "'") {                 // attribute value
        let j = i + 1;
        while (j < src.length && src[j] !== c) j += 1;
        blank(i + 1, j);
        i = Math.min(j + 1, src.length);
        continue;
      }
      if (c === '{') { enterJsxExpr('jsxTag'); i += 1; continue; }
      if (c === '/' && n === '>') {                 // self-closing: no text run follows
        mode = jsxDepth > 0 ? 'jsxText' : 'code';
        i += 2;
        continue;
      }
      // An explicit type argument (`<Table<Row> rows={r} />`) nests angle brackets inside the tag.
      // Without tracking that, the `>` of `<Row>` would end the tag early and the element would
      // never close, desynchronising the rest of the file. A bare `<` can only be a type argument
      // here — a comparison would be inside a `{…}` expression, which switches to code mode.
      if (c === '<') { angleDepth += 1; i += 1; continue; }
      if (c === '>') {
        if (angleDepth > 0) { angleDepth -= 1; i += 1; continue; }
        jsxDepth += 1;
        mode = 'jsxText';
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }

    // mode === 'jsxText' — everything here is prose until a tag or an expression starts.
    if (c === '{') { enterJsxExpr('jsxText'); i += 1; continue; }
    if (c === '<' && n === '/') {                   // closing tag
      const end = src.indexOf('>', i);
      const stop = end === -1 ? src.length : end + 1;
      jsxDepth = Math.max(0, jsxDepth - 1);
      mode = jsxDepth > 0 ? 'jsxText' : 'code';
      i = stop;
      continue;
    }
    if (c === '<' && /[A-Za-z_$>]/.test(n || '')) { mode = 'jsxTag'; i += 1; continue; }
    blank(i, i + 1);
    i += 1;
  }
  return out.join('');
}

/**
 * True when `code` really exports a default binding.
 *
 * Two conditions, both required. (1) The match is in code, not in a string/comment/JSX text — that
 * is what blankLiterals gives us. (2) `export` begins a STATEMENT: at the start of a line, or right
 * after `;` or `}`. Without (2), ordinary prose in a failed worker response is accepted:
 *   "The worker says export default GeneratedComponent is required."
 * Real source always writes the keyword at a statement position.
 *
 * Both spellings count:
 *   export default <expr|function|class|async function>
 *   export { P as default }   /   export { default } from './x'
 */
const DEFAULT_EXPORT = /(?:^[ \t]*|[;}][ \t]*)export[ \t]+default[ \t\r\n]+[\w$({[*]/m;
const NAMED_DEFAULT_EXPORT = /(?:^[ \t]*|[;}][ \t]*)export[ \t]*\{[^}]*\bdefault\b[^}]*\}/m;
function hasDefaultExport(code) {
  const bare = blankLiterals(code);
  return DEFAULT_EXPORT.test(bare) || NAMED_DEFAULT_EXPORT.test(bare);
}

/**
 * True when the brackets in `code` are unbalanced — the signature of a truncated write. Counted only
 * over code (blankLiterals removes strings, comments, regex literals and JSX text, so `1) Review`
 * and `/\(/` do not count). `<` / `>` are never counted: JSX and TypeScript generics make them
 * legitimately unbalanced.
 */
function hasUnbalancedBrackets(code) {
  const bare = blankLiterals(code);
  const stack = [];
  const pairs = { ')': '(', ']': '[', '}': '{' };
  for (const ch of bare) {
    if (ch === '(' || ch === '[' || ch === '{') stack.push(ch);
    else if (pairs[ch] && stack.pop() !== pairs[ch]) return true;
  }
  return stack.length > 0;
}

module.exports = { blankLiterals, hasDefaultExport, hasUnbalancedBrackets, expressionPosition };
