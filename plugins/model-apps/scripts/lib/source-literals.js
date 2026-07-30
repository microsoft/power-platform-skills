'use strict';
// Literal/comment blanking for TSX source scanning.
//
// WHY a purpose-built lexer: this plugin ships with **zero runtime dependencies** (every `require`
// in scripts/ is a node builtin or relative — the plugin is installed by copying its directory, so
// there is no node_modules to carry a TypeScript parser). Several checks nevertheless have to reason
// about "is this token real code, or is it text inside a string/comment?", and a naive substring
// search gets that wrong in ways that matter:
//   `const prose = "export default GeneratedComponent";`  -> looks like a valid page, isn't one
//   `/* export default */`                                 -> same
//   const s = "window.__ppInflight"                        -> makes an uncached fetch look cached
//
// This is NOT `pageref-resolver.stripNonCode()`. That function deliberately PRESERVES the contents
// of ordinary quoted strings, because its callers (objectArgAt / topLevelValue) need them to find
// key/value boundaries inside a `navigateTo({...})` literal. Reusing it for "is this real code?"
// was a real defect: the bait above passed. Blanking here is total.
//
// Blanked characters are replaced with spaces (never removed), so every offset in the output maps
// 1:1 onto the input and a caller can mix matches across both.

// A quote only starts a string in an EXPRESSION position. JSX text is the reason this matters:
//   <p>it's fine</p>
// Treating that apostrophe as a string opener would blank the rest of the file and make a perfectly
// good page look broken. The standard heuristic: a quote preceded by an identifier char, `)`, `]`
// or `}` cannot be opening a string — it is JSX text (or, harmlessly, a division/regex edge we do
// not care about here).
function opensString(code, i) {
  for (let j = i - 1; j >= 0; j -= 1) {
    const c = code[j];
    if (c === ' ' || c === '\t') continue;
    return !/[\w$)\]}]/.test(c);
  }
  return true; // start of file
}

/**
 * Blank every comment, string and template-literal body in TSX source.
 * @param {string} code
 * @returns {string} same length as `code`, with non-code regions replaced by spaces
 */
function blankLiterals(code) {
  const src = String(code || '');
  const out = [...src];
  const blank = (from, to) => {
    // Keep newlines so line-oriented matching and error offsets still make sense.
    for (let k = from; k < to && k < src.length; k += 1) if (src[k] !== '\n') out[k] = ' ';
  };

  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];

    if (c === '/' && next === '/') {
      const end = src.indexOf('\n', i);
      blank(i, end === -1 ? src.length : end);
      i = end === -1 ? src.length : end;
      continue;
    }
    if (c === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? src.length : end + 2;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (c === '`') {
      // Template literal. `${}` expressions are blanked too: for every question this module answers,
      // an interpolated expression is not a place a real declaration lives, and tracking nesting
      // would only add ways to be wrong.
      let j = i + 1;
      let depth = 0;
      for (; j < src.length; j += 1) {
        if (src[j] === '\\') { j += 1; continue; }
        if (src[j] === '{' && src[j - 1] === '$') depth += 1;
        else if (src[j] === '}' && depth > 0) depth -= 1;
        else if (src[j] === '`' && depth === 0) break;
      }
      blank(i + 1, j);
      i = Math.min(j + 1, src.length);
      continue;
    }
    if ((c === '"' || c === "'") && opensString(src, i)) {
      let j = i + 1;
      for (; j < src.length; j += 1) {
        if (src[j] === '\\') { j += 1; continue; }
        if (src[j] === c) break;
        // A quoted string cannot span a raw newline. Hitting one means this was NOT a string (most
        // often an apostrophe in JSX text that slipped past opensString), so leave it all alone.
        if (src[j] === '\n') { j = -1; break; }
      }
      if (j === -1) { i += 1; continue; }
      blank(i + 1, j);
      i = Math.min(j + 1, src.length);
      continue;
    }
    i += 1;
  }
  return out.join('');
}

/**
 * True when `code` really exports a default binding. Runs over blanked source, so a mention inside
 * a string or comment does not count. Both spellings are accepted:
 *   export default <expr|function|class|async function>
 *   export { P as default }   /   export { default } from './x'
 */
function hasDefaultExport(code) {
  const bare = blankLiterals(code);
  // `[\w$({[*]` requires something to actually follow, which rejects the parse-error `export default;`.
  if (/\bexport\s+default\s+[\w$({[*]/.test(bare)) return true;
  return /\bexport\s*\{[^}]*\bdefault\b[^}]*\}/.test(bare);
}

/**
 * True when the brackets in `code` are unbalanced — the signature of a truncated write. Checked on
 * blanked source so brackets inside strings/comments (and JSX text) do not count. `<` / `>` are NOT
 * checked: JSX and TypeScript generics make them unbalanced in perfectly valid files.
 */
function hasUnbalancedBrackets(code) {
  const bare = blankLiterals(code);
  const stack = [];
  const pairs = { ')': '(', ']': '[', '}': '{' };
  for (const ch of bare) {
    if (ch === '(' || ch === '[' || ch === '{') stack.push(ch);
    else if (pairs[ch]) {
      if (stack.pop() !== pairs[ch]) return true;
    }
  }
  return stack.length > 0;
}

module.exports = { blankLiterals, hasDefaultExport, hasUnbalancedBrackets, opensString };
