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
// MODES: code (incl. JSX expressions), comment, string, template, regex, JSX tag, JSX text. A
// template's `${…}` body is code, read by the same machine (lexInto).
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
  // A postfix operator ends an operand, so a `/` or `<` after one is an operator too:
  //   closed! / total      TypeScript's non-null assertion
  //   i++ / 2              postfix increment (or decrement)
  // `!` is postfix exactly when it does not itself start an expression, so a prefix `!` still
  // opens one: `return !/\(/.test(s)`, and `if (bad) !/\(/.test(s)` (see closesStatementHead).
  if (ch === '!') return expressionPosition(src, index);
  if ((ch === '+' || ch === '-') && src[index - 1] === ch) return false;
  // A `>` can be a binary relational operator (`count > /re/.test(x)`), the `>` of an arrow's `=>`,
  // a JSX tag close, or a type-argument close after a cast. Only the latter two end an operand.
  // The cast case is intentionally narrow: `total as NonNullable< number > / count` divides, but
  // `count<limit ? () => /re/ : ...` must leave `=>` as an expression-start token before a regex.
  if (ch === '>') return !greaterThanEndsOperand(src, index);
  if (EXPR_START_PUNCT.has(ch)) return true;
  // A `)` usually ends an operand — `counts.get(k)! / total`, `(a + b) / 2` — but the `)` that
  // closes an `if (…)`, `for (…)` or `while (…)` head is followed by a STATEMENT, where an
  // expression starts: `if (x) /re/.test(y)`.
  if (ch === ')') return closesStatementHead(src, index);
  if (/[\w$\]]/.test(ch)) {
    // Could be the tail of a keyword like `return` — read the word back. Built char by char so `src`
    // may be the lexer's partly blanked output ARRAY as well as a string (see blankLiterals).
    let s = index;
    while (s >= 0 && /[\w$]/.test(src[s])) s -= 1;
    let word = '';
    for (let k = s + 1; k <= index; k += 1) word += src[k];
    // ...unless it is a PROPERTY that happens to share a keyword's name — a status count is often
    // keyed `new`, and `counts.new / total` divides. `?.new` is a property too; a spread's
    // `...new Set(x)` is the keyword.
    if (EXPR_START_WORDS.has(word) && isPropertyName(src, s)) return false;
    return EXPR_START_WORDS.has(word);
  }
  return false;
}

// True when the word that starts after index `s` is reached through `.` (or `?.`), not `...`.
function isPropertyName(src, s) {
  let p = s;
  while (p >= 0 && /\s/.test(src[p])) p -= 1;
  return src[p] === '.' && !(src[p - 1] === '.' && src[p - 2] === '.');
}

// Heuristic for the ambiguous `>` token in dependency-free TSX scanning. The raw shapes this protects:
//   total as NonNullable< number > / count    `>` closes a cast type argument; `/` is division
//   export default () => <Icon />             `>` closes JSX; EOF is complete
//   export default () => count >              `>` is a relational operator; EOF is truncated
//   count<limit ? () => /re/ : () => /none/   the `>` in `=>` is not an angle close
//
// Dependency-free text cannot safely tell a generic instantiation or type-alias tail from a
// relational expression in all TSX contexts. So expression classification is intentionally narrow:
// `/` after `>` divides only when `>` closes type arguments in a cast/annotation context (`as`,
// `satisfies`, or `: Foo<Bar>`). EOF handling is even stricter below: a final `>` completes only
// when the lexer recorded it as a JSX tag close, and a final type-argument list needs `;`.
function greaterThanEndsOperand(src, close) {
  if (src[close - 1] === '=') return false;
  return greaterThanClosesTypeArguments(src, close) || greaterThanClosesJsxTag(src, close);
}

function greaterThanClosesTypeArguments(src, close) {
  const open = matchingTypeArgumentOpen(src, close);
  if (open === -1) return false;
  return typeArgumentOpenFollowsCastOrAnnotation(src, open);
}

function matchingTypeArgumentOpen(src, close) {
  let depth = 1;
  for (let k = close - 1; k >= 0 && close - k <= LOOKAHEAD; k -= 1) {
    const c = src[k];
    // Function types are valid inside type arguments:
    //   ReturnType<() => number>
    // The arrow's `>` is not an angle close and must not change the balance.
    if (c === '>' && src[k - 1] !== '=') depth += 1;
    else if (c === '<') {
      depth -= 1;
      if (depth === 0) return k;
    } else if (c === ';' && depth === 1) {
      return -1;
    } else if (EXPRESSION_ONLY_OPERATOR(src, k)) {
      // An operator no type can hold ends the match: the `<` and `>` of
      //   lo as number < hi && count > /}/.source.length
      // are comparisons, and pairing them as type arguments read the regex after them as a division.
      return -1;
    }
  }
  return -1;
}

// `&&`, `||`, `??`, `+`, `*`, `/`, `%`, `!`, and `=` outside `=>`: expression operators that never appear inside
// type arguments. A single `&` or `|` (intersection, union), `?` and `:` (conditional and optional types), `-`
// (negative literal types) and `=>` (function types) all can, so they are not in this set.
function EXPRESSION_ONLY_OPERATOR(src, k) {
  const c = src[k];
  if ((c === '&' || c === '|' || c === '?') && (src[k - 1] === c || src[k + 1] === c)) return true;
  if (c === '+' || c === '*' || c === '/' || c === '%' || c === '!') return true;
  return c === '=' && src[k + 1] !== '>';
}

// Type names that take no type arguments: `as number <` can only be a comparison.
const PRIMITIVE_TYPES = new Set(['any', 'unknown', 'never', 'void', 'undefined', 'null', 'number', 'string',
  'boolean', 'bigint', 'symbol', 'object']);

// Is the `<` at `open` the start of type arguments in a cast or annotation? The type they belong to may be one
// constituent of an intersection or union, so the walk back steps over the others to reach `as`/`satisfies`/`:`:
//   total as number & Brand<"USD"> / count     `Brand<…>` is part of the cast; `/` is division
//   value as A | B.C<D> / n                    the same with a union and a qualified name
// Each constituent is a (qualified) name, optionally with its own closed type arguments. Anything else ends the
// walk and the `<` is not taken for type arguments — the conservative reading for the division check.
function typeArgumentOpenFollowsCastOrAnnotation(src, open) {
  const skipSpace = (i) => { while (i >= 0 && /\s/.test(src[i])) i -= 1; return i; };
  const skipName = (i) => { while (i >= 0 && /[\w$.\]\[]/.test(src[i])) i -= 1; return i; };
  let end = skipSpace(open - 1);
  let p = skipName(end);
  // Char by char, not `slice`: `src` may be the lexer's partly blanked output ARRAY (see expressionPosition).
  let name = '';
  for (let k = p + 1; k <= end; k += 1) name += src[k];
  if (p === end || PRIMITIVE_TYPES.has(name)) return false;
  for (let guard = 0; guard < 16; guard += 1) {
    const q = skipSpace(p);
    const op = src[q];
    if (!((op === '&' || op === '|') && src[q - 1] !== op)) break;
    let r = skipSpace(q - 1);
    if (src[r] === '>') {
      const o = matchingTypeArgumentOpen(src, r);
      if (o === -1) return false;
      r = skipSpace(o - 1);
    }
    const e = r;
    r = skipName(r);
    if (r === e) return false;
    p = r;
  }
  const before = prevWordOrPunct(src, p + 1);
  return before === 'as' || before === 'satisfies' || before === ':';
}


function prevWordOrPunct(src, before) {
  let p = before - 1;
  while (p >= 0 && /\s/.test(src[p])) p -= 1;
  if (src[p] === ':') return ':';
  let e = p;
  while (p >= 0 && /[\w$]/.test(src[p])) p -= 1;
  let word = '';
  for (let k = p + 1; k <= e; k += 1) word += src[k];
  return word;
}

function greaterThanClosesJsxTag(src, close) {
  let depth = 0;
  for (let k = close; k >= 0 && close - k <= LOOKAHEAD; k -= 1) {
    if (src[k] === '>') depth += 1;
    else if (src[k] === '<') {
      depth -= 1;
      if (depth !== 0) continue;
      if (src[k + 1] === '/') return true;
      return /[A-Za-z_$/>]/.test(src[k + 1] || '') && expressionPosition(src, k);
    } else if (src[k] === ';') {
      return false;
    }
  }
  return false;
}

// True when the `)` at `close` ends the head of an `if`, `for`, `while` or `with` statement. The
// matching `(` is found by counting back over `src` — the lexer's output, where brackets inside
// strings, comments and regexes are already blanked — and bounded, so a long expression costs at
// most LOOKAHEAD characters; past that, the `)` is taken to end an operand.
const STATEMENT_HEADS = new Set(['if', 'for', 'while', 'with']);
function closesStatementHead(src, close) {
  let depth = 0;
  for (let j = close; j >= 0 && close - j <= LOOKAHEAD; j -= 1) {
    if (src[j] === ')') depth += 1;
    else if (src[j] === '(' && --depth === 0) {
      let { word, start } = wordBefore(src, j);
      // `for await (const x of xs)` — the head's keyword is the word before `await`.
      if (word === 'await') ({ word, start } = wordBefore(src, start + 1));
      return STATEMENT_HEADS.has(word) && !isPropertyName(src, start);
    }
  }
  return false;
}

// The word that ends just before index `j` (whitespace skipped), and the index before its start.
function wordBefore(src, j) {
  let e = j - 1;
  while (e >= 0 && /\s/.test(src[e])) e -= 1;
  let s = e;
  while (s >= 0 && /[\w$]/.test(src[s])) s -= 1;
  let word = '';
  for (let k = s + 1; k <= e; k += 1) word += src[k];
  return { word, start: s };
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
//
// Everything here is depth-aware, because ordinary TypeScript puts the same characters inside a type
// that also terminate a statement outside one:
//   <T extends { id: string; name: string }>(row: T) => row.id      `;` inside an object type
//   <T extends (...args: unknown[]) => void>(fn: T) => fn           `>` belonging to a function type's `=>`
//   <T,>(v: T): { key: string; value: T } => ({ … })                `;` inside the RETURN type
//
// The lookahead loops also skip trivia — comments and quoted/template strings — because a signature
// may legitimately carry either, and a `;` or `(` inside one is not structural:
//   const preserveRow = <T extends Record<string, unknown>, // preserve fields; do not widen
//   >(row: T) => row;
//   const pickKey = <T extends { kind: "a" | "b" }>(x: T) => x.kind;
const LOOKAHEAD = 2000;   // generous: a signature with a large inline object type still fits

// If `j` is the start of a comment or a quoted/template string, return the index just past it;
// otherwise return `j` unchanged.
function skipTrivia(src, j) {
  const c = src[j];
  const n = src[j + 1];
  if (c === '/' && n === '/') {
    const end = src.indexOf('\n', j);
    return end === -1 ? src.length : end;
  }
  if (c === '/' && n === '*') {
    const end = src.indexOf('*/', j + 2);
    return end === -1 ? src.length : end + 2;
  }
  if (c === '"' || c === "'" || c === '`') {
    for (let k = j + 1; k < src.length; k += 1) {
      if (src[k] === '\\') { k += 1; continue; }
      if (src[k] === c) return k + 1;
      if (src[k] === '\n' && c !== '`') return j;   // not a string after all
    }
    return src.length;
  }
  return j;
}

function looksLikeTypeParams(src, i) {
  const limit = Math.min(src.length, i + LOOKAHEAD);
  let angle = 0;
  let brace = 0;
  let paren = 0;
  let bracket = 0;
  const nested = () => brace > 0 || paren > 0 || bracket > 0;
  let j = i;
  for (; j < limit; j += 1) {
    const skipped = skipTrivia(src, j);
    if (skipped !== j) { j = skipped - 1; continue; }
    const c = src[j];
    if (c === '{') brace += 1;
    else if (c === '}') brace -= 1;
    else if (c === '(') paren += 1;
    else if (c === ')') paren -= 1;
    else if (c === '[') bracket += 1;
    else if (c === ']') bracket -= 1;
    else if (c === ';' && !nested()) return false;
    else if (!nested()) {
      if (c === '<') angle += 1;
      else if (c === '>') {
        if (src[j - 1] === '=') continue;        // the `>` of an `=>` in a function-type constraint
        angle -= 1;
        if (angle === 0) break;
      }
    }
  }
  if (j >= limit) return false;                  // never closed within the window

  // Skip the balanced parameter list that must follow.
  let k = j + 1;
  while (k < src.length && /\s/.test(src[k])) k += 1;
  if (src[k] !== '(') return false;
  let depth = 0;
  for (; k < src.length; k += 1) {
    const skipped = skipTrivia(src, k);
    if (skipped !== k) { k = skipped - 1; continue; }
    if (src[k] === '(') depth += 1;
    else if (src[k] === ')') { depth -= 1; if (depth === 0) { k += 1; break; } }
  }
  if (depth !== 0) return false;                 // unbalanced — this was JSX text, not a parameter list

  while (k < src.length && /\s/.test(src[k])) k += 1;
  if (src[k] === '=' && src[k + 1] === '>') return true;
  // A return-type annotation may sit between: `<T>(x: T): T => x`. Find the arrow before the
  // statement ends, ignoring `;` that belongs to an object type rather than the statement.
  if (src[k] !== ':') return false;
  let b = 0;
  let p = 0;
  let br = 0;
  for (let m = k; m < Math.min(src.length, k + LOOKAHEAD); m += 1) {
    const skipped = skipTrivia(src, m);
    if (skipped !== m) { m = skipped - 1; continue; }
    const c = src[m];
    if (c === '{') b += 1;
    else if (c === '}') b -= 1;
    else if (c === '(') p += 1;
    else if (c === ')') p -= 1;
    else if (c === '[') br += 1;
    else if (c === ']') br -= 1;
    else if (b === 0 && p === 0 && br === 0) {
      if (c === ';') return false;
      if (c === '=' && src[m + 1] === '>') return true;
    }
  }
  return false;
}

/**
 * Blank every comment, string, template, regex literal and JSX text run in TSX source.
 * @param {string} code
 * @returns {string} same length as `code`, non-code regions replaced by spaces
 */
function blankLiterals(code, opts) {
  const src = String(code || '');
  // Reports each comment's [start, end) to the caller (commentRanges below), so code that must read
  // COMMENT text uses this lexer's view of what a comment is rather than a regex that takes the `//`
  // in "https://…" for one. Optional: the blanked output is the same either way.
  const onComment = opts && typeof opts.onComment === 'function' ? opts.onComment : null;
  const onRegexEnd = opts && typeof opts.onRegexEnd === 'function' ? opts.onRegexEnd : null;
  // split('') and NOT [...src]: the spread iterates by CODE POINT, so an astral character (an emoji
  // in a label, which generated pages do use) makes array indices drift out of step with the UTF-16
  // offsets everything else here uses, corrupting the output.
  const out = src.split('');
  lexInto(src, out, 0, { onComment, onRegexEnd });
  return out.join('');
}

// The lexer itself. From `start` it blanks inert text into `out` — `src` split into UTF-16 units,
// possibly already partly blanked by an enclosing call — and judges regex and JSX positions on it.
//
// With `untilCloseBrace` it reads the body of a template's `${…}` instead, and returns the index of
// the `}` that closes it (src.length when none does). That body is ordinary code — strings,
// comments, regexes, nested templates and JSX — so it gets this same lexer, not a lighter scanner.
// A brace counter that knew no JSX read the `/` of `</span>` in
//   `${<span>Save</span>}`
// as the start of a regex that swallowed the closing `}`, and the apostrophe in `${<p>it's</p>}` as a
// string. Either way the template never ended, and the page's `export default` vanished with it.
// Otherwise it returns src.length.
function lexInto(src, out, start, { onComment = null, onRegexEnd = null, onJsxTagEnd = null, untilCloseBrace = false, onEnd = null } = {}) {
  const blank = (from, to) => {
    for (let k = Math.max(0, from); k < to && k < src.length; k += 1) if (src[k] !== '\n') out[k] = ' ';
  };

  let mode = 'code';
  let jsxDepth = 0;                 // open JSX elements in the CURRENT expression frame
  let angleDepth = 0;               // nested < > inside a tag's type arguments
  const frames = [];                // JSX-expression frames: { returnMode, braceDepth, savedJsxDepth }
  let braceDepth = 0;               // `{` opened in plain code inside a `${…}` body (untilCloseBrace)
  let unterminated = false;         // a string, regex, template, comment or closing tag ran off the end
  let i = start;

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
        if (onComment) onComment(i, end === -1 ? src.length : end);
        i = end === -1 ? src.length : end;
        continue;
      }
      if (c === '/' && n === '*') {
        const end = src.indexOf('*/', i + 2);
        const stop = end === -1 ? src.length : end + 2;
        if (end === -1) unterminated = true;
        blank(i, stop);
        if (onComment) onComment(i, stop);
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
        if (j >= src.length) unterminated = true;
        blank(i + 1, j);
        i = Math.min(j + 1, src.length);
        continue;
      }
      if (c === '`') {
        // Template literal. Its body — `${}` expressions included — is blanked: no declaration lives
        // inside one. But where it ENDS is found by lexing each `${…}` body with this same lexer
        // (strings, comments, regexes, nested templates and JSX alike). Counting bare braces
        // ended `[${rows.map((r) => `{"id":"${r.id}"}`).join(",")}]` at the `}` in the nested
        // template's TEXT, and everything up to the next backtick — `export default` included — was
        // misread, so a complete page failed as truncated and later nav calls went unseen.
        const j = scanTemplateLiteral(src, i, out, onComment).end;
        if (j >= src.length) unterminated = true;
        blank(i + 1, j);
        i = Math.min(j + 1, src.length);
        continue;
      }
      // Position is judged on the blanked output, not the raw source: every comment before `i` is
      // already spaces there, so a comment's last word is not mistaken for the previous token —
      //   return (
      //     // Instructions
      //     <Text>1) Pick a record</Text>
      // read `Instructions` as the token before `<`, took the JSX for a comparison, lexed its text as
      // code and reported `1)` as an unbalanced bracket.
      if (c === '/' && expressionPosition(out, i)) {
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
        if (j >= src.length) unterminated = true;
        else if (onRegexEnd) onRegexEnd(j);
        blank(i + 1, j);
        i = Math.min(j + 1, src.length);
        continue;
      }
      if (c === '<' && /[A-Za-z_$>]/.test(n || '') && expressionPosition(out, i) && !looksLikeTypeParams(src, i)) {
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
      } else if (untilCloseBrace) {
        if (c === '{') braceDepth += 1;
        else if (c === '}') {
          if (braceDepth === 0) return i;
          braceDepth -= 1;
        }
      }
      i += 1;
      continue;
    }

    if (mode === 'jsxTag') {
      // Comments come FIRST. A `//` or `/* */` comment between attributes is valid TSX, and a
      // generator naturally emits one to explain an attribute. Without this branch the attribute-
      // value case below sees an apostrophe in the comment prose ("Griffel's") and treats it as a
      // quote — and that scanner deliberately does NOT stop at a newline, because a JSX attribute
      // value may legitimately span lines, so it ran to EOF. The real `export default` was blanked
      // and every bracket after it miscounted, which is the false-positive direction this file's
      // header calls the worse one: a complete page refused as truncated. #542.
      //
      // `/` in a tag is otherwise only the start of `/>`, and `n` distinguishes all three cases.
      if (c === '/' && n === '/') {
        const end = src.indexOf('\n', i);
        blank(i, end === -1 ? src.length : end);
        if (onComment) onComment(i, end === -1 ? src.length : end);
        i = end === -1 ? src.length : end;
        continue;
      }
      if (c === '/' && n === '*') {
        const end = src.indexOf('*/', i + 2);
        const stop = end === -1 ? src.length : end + 2;
        if (end === -1) unterminated = true;
        blank(i, stop);
        if (onComment) onComment(i, stop);
        i = stop;
        continue;
      }
      if (c === '"' || c === "'") {                 // attribute value
        let j = i + 1;
        while (j < src.length && src[j] !== c) j += 1;
        if (j >= src.length) unterminated = true;
        blank(i + 1, j);
        i = Math.min(j + 1, src.length);
        continue;
      }
      // A template literal inside a tag can only be part of an explicit TYPE ARGUMENT, e.g.
      //   <Link<`https://${string}`> to={u} />
      // and its content is data, not code. Consuming it as one unit here is what keeps the `//`
      // in a template-literal *type* from being mistaken for the comment branch above — which
      // would blank to end of line and reject a valid module, and could also hide a genuinely
      // malformed expression that follows on the same line. Mirrors the `code`-mode scanner: the
      // body is blanked, and its end is found by the expression-aware scanner.
      if (c === '`') {
        const j = scanTemplateLiteral(src, i, out, onComment).end;
        if (j >= src.length) unterminated = true;
        blank(i + 1, j);
        i = Math.min(j + 1, src.length);
        continue;
      }
      if (c === '{') { enterJsxExpr('jsxTag'); i += 1; continue; }
      if (c === '/' && n === '>') {                 // self-closing: no text run follows
        if (onJsxTagEnd) onJsxTagEnd(i + 1);
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
        if (onJsxTagEnd) onJsxTagEnd(i);
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
      if (end === -1) unterminated = true;
      else if (onJsxTagEnd) onJsxTagEnd(end);
      jsxDepth = Math.max(0, jsxDepth - 1);
      mode = jsxDepth > 0 ? 'jsxText' : 'code';
      i = stop;
      continue;
    }
    if (c === '<' && /[A-Za-z_$>]/.test(n || '')) { mode = 'jsxTag'; i += 1; continue; }
    blank(i, i + 1);
    i += 1;
  }
  // Where the lexer stopped: a complete module ends in plain code, with nothing left open.
  if (onEnd) onEnd({ open: unterminated || mode !== 'code' || frames.length > 0 });
  return src.length;
}

// Index of the `}` that closes the `${…}` whose body starts at `start`, or src.length. The body is
// lexed into `scratch` — a `src.split('')` the caller owns and whose blanks inside the body do not
// matter to it (the lexer passes its own output, which blanks the whole template anyway) — or into
// a fresh copy when none is given. `onComment` hears the body's comments: they are real comments,
// so an elision marker or a comment inside an import there counts like any other.
function scanTemplateExpressionEnd(src, start, scratch, onComment) {
  return lexInto(src, scratch || src.split(''), start, { untilCloseBrace: true, onComment: onComment || null });
}

function scanTemplateLiteral(src, start, scratch, onComment) {
  const expressions = [];
  let view = scratch || null;       // one copy for every `${…}` in this template, made on the first
  for (let i = start + 1; i < src.length; i += 1) {
    const c = src[i];
    if (c === '\\') { i += 1; continue; }
    if (c === '`') return { end: i, expressions };
    if (c === '$' && src[i + 1] === '{') {
      if (!view) view = src.split('');
      const exprStart = i + 2;
      const exprEnd = scanTemplateExpressionEnd(src, exprStart, view, onComment);
      expressions.push({ start: exprStart, end: exprEnd });
      i = exprEnd < src.length ? exprEnd : src.length;
    }
  }
  return { end: src.length, expressions };
}

/**
 * Blank inert source while leaving executable JavaScript inside template `${...}` expressions.
 *
 * Raw shapes this must separate:
 *   `help: navigateTo({ pageId: "PAGEREF_x" })`          template TEXT, inert
 *   `${navigateTo({ pageId: "PAGEREF_x" })}`             template EXPRESSION, executable
 *   `${`nested ${navigateTo({ pageId: "PAGEREF_x" })}`}` nested expression, executable
 *   `${"navigateTo({ pageId: \"PAGEREF_x\" })"}`         string inside expression, inert
 *   `${/navigateTo\({ pageId: "PAGEREF_x" }\)/}`         regex inside expression, inert
 *   `${slash-star navigateTo({ pageId: "PAGEREF_x" }) star-slash real}` comments in expressions are inert
 *   `escaped \` and \${ text`                            escaped template text, inert
 *
 * `blankLiterals` intentionally blanks whole template bodies for declaration/bracket checks. The
 * navigation oracle needs a different view: template text is still data, but `${...}` is live code.
 * This overlays recursively blanked expression bodies back onto the normal blanked output without
 * changing `blankLiterals` for its existing callers.
 */
function blankNonCodePreservingTemplateExpressions(code) {
  const src = String(code || '');
  const out = blankLiterals(src).split('');
  const scratch = src.split('');     // raw copy every `${…}` body below is lexed into
  for (let i = 0; i < src.length; i += 1) {
    if (src[i] !== '`' || out[i] !== '`') continue;
    const { end, expressions } = scanTemplateLiteral(src, i, scratch);
    for (const expr of expressions) {
      // Keep executable substitutions from being concatenated through blanked template text. In
      //   `${Xrm.Navigation.navigateTo} text ${({ pageType: "generative", pageId: "PAGEREF_x" })}`
      // the two expressions are independent, but blanking the `${` / `}` delimiters to spaces made
      // call-site regexes see `navigateTo   ({ ... })`. A same-length semicolon at the close boundary
      // preserves offsets while making the expression boundary syntactically non-whitespace.
      if (expr.end < out.length && out[expr.end] !== '\n') out[expr.end] = ';';
      const blanked = blankNonCodePreservingTemplateExpressions(src.slice(expr.start, expr.end));
      for (let k = 0; k < blanked.length; k += 1) out[expr.start + k] = blanked[k];
    }
    i = end;
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
// Identifiers may be non-ASCII (`Página`), so every name below is matched by Unicode property.
const DEFAULT_EXPORT = /(?:^[ \t]*|[;}][ \t]*)export[ \t]+default[ \t\r\n]+[\p{ID_Continue}$({[*]/gmu;
const NAMED_DEFAULT_EXPORT = /(?:^[ \t]*|[;}][ \t]*)export[ \t]*\{[^}]*\bdefault\b[^}]*\}/m;
function hasDefaultExport(code) {
  const bare = blankLiterals(code);
  if (NAMED_DEFAULT_EXPORT.test(bare)) return true;
  // Any complete one will do: TypeScript overloads declare the signature(s) before the body —
  //   export default function f(x: string): string;
  //   export default function f(x: any) { return x; }
  for (const m of bare.matchAll(DEFAULT_EXPORT)) {
    if (defaultExportIsComplete(bare, m.index + m[0].length - 1)) return true;
  }
  return false;
}

// A write cut off INSIDE its export statement still matches DEFAULT_EXPORT, and its brackets balance
// because the cut came before any was opened:
//   export default function GeneratedComponent(props)    the body never came
//   export default GeneratedComp                         cut mid-name
// So a function or class must reach its body, and a bare exported name must be one the module has.
// `at` is where the exported thing starts in `bare` (blanked code, so strings and comments are gone).
function defaultExportIsComplete(bare, at) {
  const rest = bare.slice(at);
  // `async` and `abstract` only modify what follows. Cut right after one, or inside the keyword it
  // modifies (`export default abstract clas`), the export is incomplete. Followed by `;` or a line
  // break instead, the word is a plain exported name (it is a legal identifier), handled below.
  const mod = /^(async|abstract)\b[ \t]*/.exec(rest);
  if (mod) {
    const after = rest.slice(mod[0].length);
    if (!after.trim()) return false;
    if (!/^(?:function|class)\b/.test(after) && !/^(?:;|\r?\n)/.test(after)) {
      // Only an async ARROW is left — `async (x) => …`, `async x => …` — and it needs its `=>` and body.
      return mod[1] === 'async' && /=>/.test(after) && !/=>\s*$/.test(after);
    }
  }
  const fn = /^(?:async[ \t\r\n]+)?function\b\s*\*?\s*(?:[\p{ID_Start}$_][\p{ID_Continue}$\u200c\u200d]*)?\s*/u.exec(rest);
  if (fn) {
    // Type parameters come first and may hold parentheses of their own: `<T extends (a: A) => void>`.
    let k = fn[0].length;
    if (rest[k] === '<') k = skipTypeArguments(rest, k);
    while (k < rest.length && /\s/.test(rest[k])) k += 1;
    if (rest[k] !== '(') return false;
    let depth = 0;
    for (; k < rest.length; k += 1) {
      if (rest[k] === '(') depth += 1;
      else if (rest[k] === ')') { depth -= 1; if (depth === 0) return hasDeclarationBody(rest, k + 1); }
    }
    return false;
  }
  const cls = /^(?:abstract[ \t\r\n]+)?class\b/.exec(rest);
  if (cls) return hasDeclarationBody(rest, cls[0].length);
  const name = /^([\p{ID_Start}$_][\p{ID_Continue}$\u200c\u200d]*)[ \t]*(?:;|\r?\n|$)/u.exec(rest);
  if (!name) {
    // A member chain at EOF is syntactically complete: `export default UI.Spinner` and
    // `export default pages.Home` are valid exports whether the base is imported or local. A cut at
    // `React.memo` before its call is a known syntactically-complete limit documented for this gate;
    // only truly dangling `React.` / `React?.` tails stay rejected by DANGLING_TAIL below.
    const member = /^([\p{ID_Start}$_][\p{ID_Continue}$]*)(?:\s*\??\.\s*[\p{ID_Start}$_][\p{ID_Continue}$]*)+[ 	]*$/u.exec(rest);
    if (member) return true;
    // So is an arrow's parameter list with the arrow cut off — `export default ()`,
    // `(props: { a: string })`, `(props): JSX.Element` of `export default (props) => <div/>;` —
    // when the group cannot be an expression: empty, spreading at its own level, annotating a type at
    // its own level, or followed by a return type (after a leading group a `:` can only start one; a
    // ternary needs its `?` first). Such a group is parameters, so an `=>` must follow. A ternary's
    // `:` inside the group is not an annotation, nor is a return type's, which follows `)`. A bare
    // `(props)` reads exactly like the valid `export default (GeneratedComponent)`, so it passes; so
    // does a parenthesized function or class.
    if (rest[0] === '(' && !/^\(\s*(?:async\s+)?(?:function|class)\b/.test(rest)) {
      let depth = 0;
      let annotated = false;
      let ternary = false;
      let spread = false;
      for (let k = 0; k < rest.length; k += 1) {
        const c = rest[k];
        if (c === '(' || c === '[' || c === '{') depth += 1;
        else if (c === ')' || c === ']' || c === '}') {
          if (--depth > 0) continue;
          if (c === ')') {
            const inner = rest.slice(1, k).trim();
            const params = !inner || spread || (annotated && !ternary) || /^\s*:/.test(rest.slice(k + 1));
            if (params && !/=>/.test(rest.slice(k + 1))) return false;
          }
          break;
        } else if (depth === 1 && c === '.' && rest.startsWith('...', k)) {
          spread = true;
          k += 2;
        } else if (depth === 1 && c === ':') {
          let p = k - 1;
          while (p >= 0 && /\s/.test(rest[p])) p -= 1;
          if (rest[p] !== ')') annotated = true;
        } else if (depth === 1 && c === '?' && rest[k + 1] !== ':' && rest[k + 1] !== '.') ternary = true;
      }
    }
    // Any other expression — `memo(Page)`, `(props) => …`, `{ … }` — is taken as written (its brackets
    // are checked separately), unless it stops at a token that needs more: `React.`, `Page as`,
    // `cond ?`, `a &&`, an arrow's `=>`.
    return !DANGLING_TAIL.test(rest) && !/(?<![\p{ID_Continue}$])(?:as|satisfies|keyof)\s*$/u.test(rest);
  }
  // `export default GeneratedComponent;` — the module must declare or import the name.
  return declaresName(bare, name[1]);
}

// True when `name` is a local object binding. This is narrower than declaresName on purpose:
// `export default pages.Home` is complete when `pages` is an object literal, but `React.memo` at EOF
// is usually a truncated call on an imported namespace and remains rejected.
function declaresObjectName(bare, name) {
  const w = `(?<![\\p{ID_Continue}$])${name.replace(/\$/g, '\\$')}(?![\\p{ID_Continue}$])`;
  return new RegExp(`(?<![\\p{ID_Continue}$.])(?:const|let|var)\\s+${w}\\s*=\\s*\\{`, 'u').test(bare);
}

// True when `bare` (blanked code) DECLARES or imports `name` — not merely mentions it:
//   const|let|var|function|class|enum|interface|type|namespace NAME
//   import NAME from …      import * as NAME from …      import { A as NAME, NAME } from …
//   const { a: NAME, NAME = 1, ...NAME } = …      const [NAME, , NAME] = …
// A parameter, a property or a call argument is not a binding the module can export — and neither is
// the `as` of `import * as React`, which let a write cut two characters into `export default async`
// pass as `export default as`.
function declaresName(bare, name) {
  const w = `(?<![\\p{ID_Continue}$])${name.replace(/\$/g, '\\$')}(?![\\p{ID_Continue}$])`;
  const direct = new RegExp(`(?<![\\p{ID_Continue}$.])(?:(?:const|let|var|class|enum|interface|type|namespace)\\s+|function\\s*\\*?\\s*|import\\s+(?:type\\s+)?|\\*\\s*as\\s+)${w}`, 'u');
  if (direct.test(bare)) return true;
  const group = /(?<![\p{ID_Continue}$.])(?:import|const|let|var)\s*(?:type\s+)?(?:[\p{ID_Start}$_][\p{ID_Continue}$]*\s*,\s*)?([{[])/gu;
  for (const m of bare.matchAll(group)) {
    if (bindsInGroup(bare, m.index + m[0].length - 1, w, name)) return true;
  }
  // A later declarator of a list — `const Header = () => null, GeneratedComponent = () => null;` —
  // follows a `,` at the list's own depth, before its `;` (or the block that holds it closes). A
  // `const` declarator always has an initializer, so `, NAME` followed by neither `=` nor a type
  // annotation is not one. (A type with no `=` after it is a syntax error the build reports; a cut
  // cannot produce one, since the rest of the file still follows.) A `let` / `var` declarator may
  // stand alone, or assert `NAME!: T`. A later declarator may also be a pattern:
  // `const a = 1, { GeneratedComponent } = lib;`.
  const list = /(?<![\p{ID_Continue}$.])(const|let|var)\s/gu;
  const declarator = new RegExp(`\\s*${w}\\s*(?:!\\s*:|[=:,;\\n]|$)`, 'uy');
  const constDeclarator = new RegExp(`\\s*${w}\\s*[=:]`, 'uy');
  const pattern = /\s*[{[]/y;
  for (const m of bare.matchAll(list)) {
    const re = m[1] === 'const' ? constDeclarator : declarator;
    let depth = 0;
    for (let k = m.index + m[0].length; k < bare.length; k += 1) {
      const c = bare[k];
      if (c === '(' || c === '[' || c === '{') depth += 1;
      else if (c === ')' || c === ']' || c === '}') { if (--depth < 0) break; }
      else if (depth === 0 && c === ';') break;
      else if (depth === 0 && c === ',') {
        re.lastIndex = k + 1;
        if (re.test(bare)) return true;
        pattern.lastIndex = k + 1;
        if (pattern.test(bare) && bindsInGroup(bare, pattern.lastIndex - 1, w, name)) return true;
      }
    }
  }
  return false;
}

// True when the import `{…}` or destructuring `{…}` / `[…]` opening at `open` binds the name `w`
// matches. A binding is followed by `,`, the closing bracket, a default `=` or nothing — so neither
// `NAME:` (a key), `NAME as X` (renamed away), the keywords of `{ A as B }` / `{ type A }`, nor a
// computed key `{ [NAME]: x }` counts; only in an array pattern does `]` end a binding.
function bindsInGroup(bare, open, w, name) {
  const close = matchingBracket(bare, open);
  if (close === -1) return false;
  const inner = bare.slice(open + 1, close);
  for (const hit of inner.matchAll(new RegExp(w, 'gu'))) {
    const after = inner.slice(hit.index + name.length);
    if (/^\s*(?:[,}\]]|=(?![=>])|$)/.test(after) && !/^\s*\]\s*:/.test(after)) return true;
  }
  return false;
}

// Index of the bracket that closes the `{` or `[` at `open`, or -1. Only that bracket kind is
// counted; `bare` is blanked, so none hides in a string or comment.
function matchingBracket(bare, open) {
  const o = bare[open];
  const c = o === '{' ? '}' : ']';
  let depth = 0;
  for (let k = open; k < bare.length; k += 1) {
    if (bare[k] === o) depth += 1;
    else if (bare[k] === c && --depth === 0) return k;
  }
  return -1;
}

// Index just past the `>` that closes the type-argument list opening at `k` (the `>` of an `=>`
// inside it does not count), or rest.length when none does.
function skipTypeArguments(rest, k) {
  let angle = 0;
  for (; k < rest.length; k += 1) {
    if (rest[k] === '<') angle += 1;
    else if (rest[k] === '>' && rest[k - 1] !== '=') { angle -= 1; if (angle === 0) return k + 1; }
  }
  return rest.length;
}

// Tokens after which a `{` opens an object TYPE, not the declaration's body:
//   (props): { id: string } {           the first group is the return type, the second the body
//   extends React.Component<{ id: string }> {    inside type arguments
//   (): A | { b: 1 } {    (): () => { c: 1 } {    (x): x is { d: 1 } {
const TYPE_EXPECTED = new Set([':', '|', '&', ',', '?', '=>', 'extends', 'implements', 'keyof', 'typeof', 'infer', 'is', 'asserts', 'readonly', 'unique']);
// A word that can only start a STATEMENT: met before the body, the declaration ended without one —
//   export default function GeneratedComponent()
//   if (ready) { … }
// (`new` and `import` are left out: both can appear in a type, `new () => T`, `import("./x").T`.)
const STATEMENT_WORDS = new Set(['if', 'else', 'try', 'catch', 'finally', 'for', 'while', 'do', 'switch', 'with', 'return', 'throw', 'break', 'continue', 'debugger', 'const', 'let', 'var', 'function', 'class', 'interface', 'enum', 'namespace', 'module', 'declare', 'export']);

// True when a declaration's body `{` follows `from` — after the parameter list of a function, or the
// `class` keyword. A `;`, a bare `=` or a statement keyword before it means the declaration ended
// without one.
function hasDeclarationBody(rest, from) {
  let paren = 0;
  let angle = 0;
  let bracket = 0;
  let prev = ')';                   // the token before `from`
  for (let k = from; k < rest.length; k += 1) {
    const c = rest[k];
    if (/\s/.test(c)) continue;
    const nested = paren > 0 || angle > 0 || bracket > 0;
    if (c === '{') {
      if (!nested && !TYPE_EXPECTED.has(prev)) return true;
      // An object type (or a brace inside a type argument or parameter list): skip the whole group.
      let depth = 0;
      for (; k < rest.length; k += 1) {
        if (rest[k] === '{') depth += 1;
        else if (rest[k] === '}') { depth -= 1; if (depth === 0) break; }
      }
      if (k >= rest.length) return false;
      prev = '}';
      continue;
    }
    if (/[\p{ID_Continue}$]/u.test(c)) {
      let j = k;
      while (j < rest.length && /[\p{ID_Continue}$]/u.test(rest[j])) j += 1;
      prev = rest.slice(k, j);
      // A statement word — unless reached as a property of a qualified type: `(): Schema.module {`.
      let p = k - 1;
      while (p >= 0 && /\s/.test(rest[p])) p -= 1;
      if (!nested && STATEMENT_WORDS.has(prev) && rest[p] !== '.') return false;
      k = j - 1;
      continue;
    }
    if (c === '=' && rest[k + 1] === '>') { prev = '=>'; k += 1; continue; }
    if (!nested && (c === ';' || c === '=')) return false;
    if (c === '(') paren += 1;
    else if (c === ')') paren = Math.max(0, paren - 1);
    else if (c === '<') angle += 1;
    else if (c === '>') angle = Math.max(0, angle - 1);
    else if (c === '[') bracket += 1;
    else if (c === ']') bracket = Math.max(0, bracket - 1);
    prev = c;
  }
  return false;
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

// A token that cannot end a module: an operator, `.` / `?.`, `,` / `?` / `:`, an arrow's `=>`, or a
// reserved word that needs what follows — an operand, or the rest of its statement (`export`,
// `const`, `function`, `if`, …). `x++` and `x!` can end one, and so can `>` (a JSX tag), `/` (the end
// of a regex) and `debugger`, so none of those is on the list. A word reached through `.` is a
// property (`counts.new`, `api.delete`), and `void` is left off because it is also a complete TYPE:
// `type Handler = (e: Event) => void`.
const DANGLING_TAIL = /(?:=>|\?\.|[.,?:=&|^~*%<]|(?<!\+)\+|(?<!-)-|(?<![\p{ID_Continue}$.])(?:new|typeof|delete|await|yield|in|instanceof|extends|export|import|default|const|let|var|function|class|interface|enum|return|throw|if|else|for|while|do|switch|case|try|catch|finally|with))\s*$/u;

/**
 * True when `code` stops mid-statement: inside a string, template, comment or JSX element, or right
 * after a token that needs more. Every bracket balances in
 *   export default () => <div>Loading        const note = `unfinished        const total = count *
 * so hasUnbalancedBrackets cannot see these cuts. A complete module ends in plain code.
 */
function endsMidStatement(code) {
  const src = String(code || '');
  const out = src.split('');
  const regexEnds = new Set();
  const jsxTagEnds = new Set();
  let open = false;
  lexInto(src, out, 0, { onRegexEnd: (index) => regexEnds.add(index), onJsxTagEnd: (index) => jsxTagEnds.add(index), onEnd: (end) => { open = end.open; } });
  const bare = out.join('');
  return open || DANGLING_TAIL.test(bare) || hasDanglingFinalOperator(out, regexEnds, jsxTagEnds);
}

function hasDanglingFinalOperator(out, regexEnds, jsxTagEnds) {
  const { ch, index } = prevSignificant(out, out.length);
  if (ch === '>') return !jsxTagEnds.has(index);
  if (ch === '/') return !regexEnds.has(index);
  if (ch === '!') return expressionPosition(out, index);
  return false;
}

/**
 * The comments in TSX source, found by the same lexer as blankLiterals — so a `//` inside a string,
 * template or JSX text ("https://…", "a // b") is never taken for one.
 * @param {string} code
 * @returns {{ start: number, end: number, text: string }[]}
 */
function commentRanges(code) {
  const src = String(code || '');
  const ranges = [];
  blankLiterals(src, { onComment: (start, end) => ranges.push({ start, end, text: src.slice(start, end) }) });
  return ranges;
}

/**
 * The first marker showing a generator ELIDED or DEFERRED code instead of writing it, or null. One rule
 * for every gate that asks "is this page complete?" — the genpage evals and the worker-output check
 * before a parallel page is accepted — so they cannot disagree about the same file.
 *
 * Raw shapes, each matched only where it can mean elision:
 *   // TODO: wire the save handler         a TODO/FIXME comment
 *   // ... rest of the component            a comment that opens with an ellipsis
 *   /* ... *\/                              the same, as a block comment
 *   ...                                     a bare line standing in for code
 * The same words in a string or JSX text are UI copy, never elision: "Loading…" and "Search
 * documents…" appear in committed samples and in real captured pages, and 'TODO' is an ordinary
 * status value on a task board.
 * @param {string} code
 * @returns {string|null}
 */
function findElisionMarker(code) {
  const src = String(code || '');
  for (const { text } of commentRanges(src)) {
    // The comment without its delimiters, or a JSDoc block's leading `*` on each line — so
    //   /**
    //    * TODO implement save
    //    */
    // opens with TODO, as `// TODO implement save` does.
    const body = text.replace(/^\/\/+|^\/\*+|\*+\/$/g, '').replace(/^[ \t]*\*+/gm, '').trim();
    // FIXME is never prose, in any case. TODO is — a status on a task board ("board order: TODO ->
    // IN_PROGRESS -> DONE", "each todo: title, due date and owner") — so it counts only as a marker:
    // opening the comment (`// TODO wire paging`, or `// Todo:` in any case with its colon), or
    // written `TODO:` inside one.
    if (/\bfixme\b/i.test(body) || /^TODO\b/.test(body) || /^todo\s*:/i.test(body) || /\bTODO\s*:/.test(body)) {
      return 'a TODO/FIXME comment';
    }
    if (/^(\.\.\.|…)/.test(body)) return 'a comment that elides code (`// ...`)';
    // The one phrasing that only ever stands in for code. "The rest of the file/code" is not on this
    // list: "upload the rest of the file in 4 MB chunks" is how a file-handling page describes itself.
    if (/\bomitted for brevity\b/i.test(body)) return 'a comment that elides code ("omitted for brevity")';
  }
  // Comments and strings are blanked here, but executable `${...}` template bodies are kept: an
  // ellipsis inside an IIFE in a template is code, not template text. A line holding only `...`
  // always fails closed as a placeholder. The text alone cannot reliably distinguish every legal
  // multiline spread/rest from an elided block without a full parser, so generated code must write
  // the spread and operand together: `...rows`, not `...` followed by `rows` on the next line.
  if (bareEllipsisElidesCode(blankNonCodePreservingTemplateExpressions(src))) return 'a bare `...` line standing in for code';
  return null;
}

function bareEllipsisElidesCode(mask) {
  return /^[ 	]*(\.\.\.|…)[ 	]*$/m.test(mask);
}
function ellipsisFollowedByStatement(mask, k) {
  if (!/[\w$]/.test(mask[k])) return false;
  let j = k;
  while (j < mask.length && /[\w$]/.test(mask[j])) j += 1;
  const word = mask.slice(k, j);
  return STATEMENT_WORDS.has(word) || word === 'import' || word === 'export';
}

module.exports = { blankLiterals, blankNonCodePreservingTemplateExpressions, commentRanges, endsMidStatement, findElisionMarker, hasDefaultExport, hasUnbalancedBrackets, expressionPosition, scanTemplateExpressionEnd };
