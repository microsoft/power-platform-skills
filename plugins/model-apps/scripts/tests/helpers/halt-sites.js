'use strict';
// Finds, in the plugin's own sources, every place that raises a build halt, and says what each one declares about the build's retry.
//
// WHY it exists. The build runs itself again (build-model-app.js, isTransientHalt) when a halt looks transient, and a halt that reads as one only
// because of a maker's label ("SQL Timeout Reader") makes it run every earlier phase again, up to three times. The cure is that every halt DECLARES
// its policy where it is raised (lib/retry-policy.js), and tests/halt-retry-policy.test.js holds each declaration against a table. A table can only
// protect the halts it lists, so this scan finds them all, in the source, and the test fails for one the table does not know — which is how a halt
// added on another branch, with no policy, fails when the branches meet instead of silently reading its own text.
//
// THE PATTERN (documented here, and the one thing a new halt must not get around):
//   1. `new BuildHalt(message, { phase, code, recoverable, retry, … })` anywhere under scripts/ outside tests/ and vendor/. The options object is the
//      second argument; its `code:` is a string literal (the halt's code), or an expression — a "dynamic" site — which the test must list on purpose.
//      Its `retry:` is the declaration: `RETRY.NEVER` (a run again cannot change the answer) or anything else that names RETRY or a retry helper, and
//      so decides from the failure the halt wraps. `...retryFrom(…)` in the options counts the same way, and so does a conditional spread
//      (`...(cond ? { retry: … } : { retry: … })`) whose every branch declares one.
//   2. A halt-shaped object literal that is NOT an argument of that constructor — an object with `phase:`, `code:` and `recoverable:` keys, which is how
//      a halt built by another route (`Object.assign(new Error(m), { phase, code, recoverable })`, a subclass, a helper) would carry them.
//   3. `new Error(` in the build's two engine files (lib/sdk-build.js, lib/entity-provision.js): every failure the engine raises is made by
//      `refusal(…)` or `serviceFailure(…)` of lib/retry-policy.js, which say what a run again may do, so a bare `new Error(` there decides nothing.
// The scan reads CODE only: comments, string literals, template text and regular expressions are blanked first (same length, newlines kept), so a halt
// mentioned in prose or in a message is not a site.
const fs = require('node:fs');
const path = require('node:path');

// The words after which a `/` starts a regular expression, not a division.
const REGEX_AFTER_WORD = new Set(['return', 'typeof', 'case', 'in', 'of', 'new', 'delete', 'void', 'throw', 'else', 'do', 'instanceof', 'yield', 'await']);

// `src` with everything that is not code replaced by spaces (newlines kept), so an index in the result is the same place in `src`.
function blankNonCode(src) {
  const out = src.split('');
  const blank = (from, to) => { for (let i = from; i < to; i += 1) if (out[i] !== '\n' && out[i] !== '\r') out[i] = ' '; };
  const stack = []; // the open `${` of template literals: depth of braces inside the substitution
  let braces = 0;
  let prev = ''; // the last significant character of code
  let prevWord = '';
  let i = 0;
  const readTemplateBody = () => {
    // i is just after the opening backtick or just after the `}` of a substitution; stops at the closing backtick (done) or at `${` (a substitution opens)
    const from = i;
    while (i < src.length) {
      const c = src[i];
      if (c === '\\') { i += 2; continue; }
      if (c === '`') { blank(from, i); i += 1; return 'closed'; }
      if (c === '$' && src[i + 1] === '{') { blank(from, i); i += 2; return 'substitution'; }
      i += 1;
    }
    blank(from, i);
    return 'closed';
  };
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === '/' && n === '/') { const e = src.indexOf('\n', i); const to = e < 0 ? src.length : e; blank(i, to); i = to; continue; }
    if (c === '/' && n === '*') { const e = src.indexOf('*/', i + 2); const to = e < 0 ? src.length : e + 2; blank(i, to); i = to; continue; }
    if (c === '\'' || c === '"') {
      const from = i;
      i += 1;
      while (i < src.length && src[i] !== c && src[i] !== '\n') { if (src[i] === '\\') i += 1; i += 1; }
      i += 1;
      blank(from + 1, Math.min(i - 1, src.length));
      prev = c; prevWord = '';
      continue;
    }
    if (c === '`') {
      i += 1;
      if (readTemplateBody() === 'substitution') { stack.push(braces); braces = 0; prev = '{'; }
      else { prev = '`'; }
      prevWord = '';
      continue;
    }
    if (c === '{') { braces += 1; prev = c; prevWord = ''; i += 1; continue; }
    if (c === '}') {
      if (stack.length && braces === 0) {
        braces = stack.pop();
        i += 1;
        if (readTemplateBody() === 'substitution') { stack.push(braces); braces = 0; prev = '{'; } else prev = '`';
        continue;
      }
      braces -= 1; prev = c; prevWord = ''; i += 1; continue;
    }
    if (c === '/' && (prev === '' || /[(,=:[!&|?{};+\-*%<>~^]/.test(prev) || REGEX_AFTER_WORD.has(prevWord))) {
      const from = i;
      i += 1;
      let inClass = false;
      while (i < src.length && src[i] !== '\n') {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === '[') inClass = true;
        else if (src[i] === ']') inClass = false;
        else if (src[i] === '/' && !inClass) break;
        i += 1;
      }
      i += 1;
      blank(from + 1, Math.min(i - 1, src.length));
      while (i < src.length && /[a-z]/i.test(src[i])) i += 1;
      prev = '/'; prevWord = '';
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i;
      while (j < src.length && /[\w$]/.test(src[j])) j += 1;
      prevWord = src.slice(i, j);
      prev = 'a';
      i = j;
      continue;
    }
    if (!/\s/.test(c)) { prev = c; prevWord = ''; }
    i += 1;
  }
  return out.join('');
}

// The index just after the bracket that closes the one at `open`, in blanked code.
function closeOf(code, open) {
  const pairs = { '(': ')', '{': '}', '[': ']' };
  const stack = [pairs[code[open]]];
  for (let i = open + 1; i < code.length; i += 1) {
    const c = code[i];
    if (pairs[c]) stack.push(pairs[c]);
    else if (c === stack[stack.length - 1]) { stack.pop(); if (!stack.length) return i + 1; }
  }
  return code.length;
}

// The comma-separated pieces at the top level of `code[from, to)`, as [start, end) pairs.
function topLevel(code, from, to) {
  const pieces = [];
  let start = from;
  const openers = '({[';
  const closers = ')}]';
  let depth = 0;
  for (let i = from; i < to; i += 1) {
    const c = code[i];
    if (openers.includes(c)) depth += 1;
    else if (closers.includes(c)) depth -= 1;
    else if (c === ',' && depth === 0) { pieces.push([start, i]); start = i + 1; }
  }
  if (code.slice(start, to).trim()) pieces.push([start, to]);
  return pieces;
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (['tests', 'vendor', 'node_modules'].includes(entry.name)) continue;
      walk(full, out);
    } else if (/\.(c|m)?js$/.test(entry.name)) out.push(full);
  }
  return out;
}

const lineOf = (src, index) => src.slice(0, index).split('\n').length;

// How a `retry:` expression declares the policy: 'never' for RETRY.NEVER, 'by-failure' for anything else that names the retry vocabulary, null for something that decides nothing.
function declaredPolicy(text) {
  const t = text.replace(/\s+/g, ' ').trim();
  if (/^RETRY\.NEVER$/.test(t)) return 'never';
  if (/RETRY\.|retryPolicyFor\(|retryFrom\(/.test(t)) return 'by-failure';
  return null;
}

// The object literals of `code[from, to)` that are not inside another one: the branches of a conditional spread (`...(cond ? { … } : { … })`) are these.
function outermostObjects(code, from, to) {
  const found = [];
  for (let i = from; i < to; i += 1) {
    if (code[i] === '{') { found.push(i); i = closeOf(code, i) - 1; }
  }
  return found;
}

// What a spread member of an options object (`...retryFrom(f, words)`, `...(cond ? { … } : { … })`) declares: `retryFrom` always yields a policy; a conditional of
// object literals declares one only when EVERY branch does, since a branch that says nothing would leave its halt to the text.
function declaredOfSpread(code, src, from, to) {
  if (/\bretryFrom\s*\(/.test(code.slice(from, to))) return 'by-failure';
  const branches = outermostObjects(code, from, to).map((open) => declaredOfObject(code, src, open));
  if (!branches.length || branches.some((declared) => declared === null)) return null;
  return branches.every((declared) => declared === 'never') ? 'never' : 'by-failure';
}

// What the object literal opened at `open` declares: its `retry:` member, or what a spread member of it does.
function declaredOfObject(code, src, open) {
  let declared = null;
  for (const [from, to] of topLevel(code, open + 1, closeOf(code, open) - 1)) {
    const member = code.slice(from, to).trim();
    const original = src.slice(from, to).trim();
    const key = /^([A-Za-z_$][\w$]*)\s*:/.exec(member);
    if (key && key[1] === 'retry') declared = declared || declaredPolicy(original.slice(original.indexOf(':') + 1));
    else if (member.startsWith('...')) declared = declared || declaredOfSpread(code, src, from, to);
  }
  return declared;
}

// The halt sites of one source file: [{ file, line, code, codeExpr, declared, how }].
function haltSitesOf(file, src, relative) {
  const code = blankNonCode(src);
  const sites = [];
  const argumentRanges = [];
  const call = /\bnew\s+BuildHalt\s*\(/g;
  for (let m = call.exec(code); m; m = call.exec(code)) {
    const open = m.index + m[0].length - 1;
    const close = closeOf(code, open);
    const args = topLevel(code, open + 1, close - 1);
    const options = args[1];
    argumentRanges.push([open, close]);
    const site = { file: relative, line: lineOf(src, m.index), code: null, codeExpr: null, declared: null, how: 'new BuildHalt' };
    if (options) {
      const text = code.slice(options[0], options[1]).trim();
      if (text.startsWith('{')) {
        const brace = options[0] + code.slice(options[0], options[1]).indexOf('{');
        for (const [from, to] of topLevel(code, brace + 1, closeOf(code, brace) - 1)) {
          const member = code.slice(from, to).trim();
          const original = src.slice(from, to).trim();
          const key = /^([A-Za-z_$][\w$]*)\s*:/.exec(member);
          if (key && key[1] === 'code') {
            const value = original.slice(original.indexOf(':') + 1).trim();
            const literal = /^'([^']+)'$|^"([^"]+)"$/.exec(value);
            if (literal) site.code = literal[1] || literal[2]; else site.codeExpr = value;
          }
        }
        site.declared = declaredOfObject(code, src, brace);
      } else {
        site.codeExpr = `<options: ${src.slice(options[0], options[1]).trim()}>`;
      }
    }
    sites.push(site);
  }
  // Halt-shaped object literals that are not the options of that constructor: `phase:`, `code:` and `recoverable:` in one literal.
  const keys = /\brecoverable\s*:/g;
  for (let m = keys.exec(code); m; m = keys.exec(code)) {
    let depth = 0;
    let open = -1;
    for (let i = m.index - 1; i >= 0; i -= 1) {
      const c = code[i];
      if (c === '}' || c === ')' || c === ']') depth += 1;
      else if (c === '{' || c === '(' || c === '[') { if (depth === 0) { if (c === '{') open = i; break; } depth -= 1; }
    }
    if (open < 0) continue;
    const close = closeOf(code, open);
    if (argumentRanges.some(([from, to]) => open > from && close <= to)) continue;
    const literal = code.slice(open, close);
    if (!/\bphase\s*:/.test(literal) || !/\bcode\s*:/.test(literal)) continue;
    const literalSrc = src.slice(open, close);
    const codeMatch = /\bcode\s*:\s*(?:'([^']+)'|"([^"]+)")/.exec(literalSrc);
    sites.push({ file: relative, line: lineOf(src, open), code: codeMatch ? (codeMatch[1] || codeMatch[2]) : null, codeExpr: codeMatch ? null : '<expression>', declared: null, how: 'halt-shaped literal' });
  }
  return sites;
}

// Every halt site under `root` (the plugin's scripts/ directory).
function scanHaltSites(root) {
  const sites = [];
  for (const file of walk(root)) {
    const relative = path.relative(root, file).replace(/\\/g, '/');
    sites.push(...haltSitesOf(file, fs.readFileSync(file, 'utf8'), relative));
  }
  return sites;
}

// Where `new Error(` appears in the code of `files` (relative to `root`): [{ file, line }].
function scanBareErrors(root, files) {
  const found = [];
  for (const relative of files) {
    const src = fs.readFileSync(path.join(root, relative), 'utf8');
    const code = blankNonCode(src);
    const bare = /\bnew\s+Error\s*\(/g;
    for (let m = bare.exec(code); m; m = bare.exec(code)) found.push({ file: relative, line: lineOf(src, m.index) });
  }
  return found;
}

module.exports = { blankNonCode, haltSitesOf, scanHaltSites, scanBareErrors };
