'use strict';

// Structure read from a generated page's TSX: its JSX elements and their attributes, the text its JSX
// shows, and its named function definitions with the scopes around them. Used by the Layer 2 checks
// that ask how a page is BUILT (which control is labelled, which step a button moves to, which text a
// user sees, which function is nested in another) rather than whether some word appears in it.
//
// No parser: the plugin ships dependency-free and the harness grades with its own pure primitives.
// Everything is read from the plugin's lexer view (scripts/lib/source-literals.js `blankLiterals`),
// where every comment, string, template, regex body and JSX text run is blanked to spaces and the
// offsets stay 1:1 with the source, so a `>`, `{` or `=>` inside a label never moves a bracket count,
// and the original text at the same offsets gives the value back. For example
//   source:  <Field label="First name"><Input aria-label="First" value={form.x} /></Field>
//   view:    <Field label="··········"><Input aria-label="·····" value={form.x} /></Field>
//   source:  <Text>Hello {name} world</Text>      view:  <Text>······{name}······</Text>
// Limits, by design (each check that uses this says which it lives with):
//   - an element is found where a `<Name` stands at the start of an expression (after `(`, `=`, `,`,
//     `?`, `:`, `{`, `}`, `>`, `&&`, `return`, …); `useState<Row>(…)` and `a < b` are not elements;
//   - a closing tag is matched by name, counting nested same-name elements;
//   - JSX text is a blanked run whose nearest code character before it is `>` or `}` (a string's run
//     follows its quote, a template's its backtick, a regex body its `/`), comments excluded;
//   - a function's scope is a body `{…}` (or an arrow's expression) found from `=>` and `function`;
//     a declaration with no semicolon may run on into the next statement.

const { blankLiterals, commentRanges } = require('../../../../plugins/model-apps/scripts/lib/source-literals.js');

const IDENT_CHAR = /[\w$]/;
// Words after which an expression (so an element) may start, as in source-literals.js EXPR_START_WORDS.
const EXPR_WORDS = new Set(['return', 'yield', 'await', 'default', 'case', 'else', 'do', 'in', 'of', 'typeof', 'void', 'throw']);
const OPENERS = { '(': ')', '[': ']', '{': '}' };

function sourceView(content) {
  const src = String(content || '');
  return { src, code: blankLiterals(src) };
}

function prevSignificant(code, i) {
  let k = i - 1;
  while (k >= 0 && /\s/.test(code[k])) k -= 1;
  return k;
}

function wordBefore(code, end) {
  let k = end;
  while (k >= 0 && IDENT_CHAR.test(code[k])) k -= 1;
  return code.slice(k + 1, end + 1);
}

// Whether a `<` at `at` (in the code view) may open an element: what stands before it starts an expression.
function elementMayStart(code, at) {
  const k = prevSignificant(code, at);
  if (k < 0) return true;
  if (IDENT_CHAR.test(code[k])) return EXPR_WORDS.has(wordBefore(code, k));
  return !/[)\]]/.test(code[k]);
}

// The index of the bracket that closes the one at `open` in the code view, or -1.
function matchingClose(code, open) {
  const close = OPENERS[code[open]];
  if (!close) return -1;
  let depth = 0;
  for (let i = open; i < code.length; i += 1) {
    const c = code[i];
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') {
      depth -= 1;
      if (depth === 0) return c === close ? i : -1;
    }
  }
  return -1;
}

// The end of an opening tag whose name ends at `from`: the index of its `>`, and whether it is `/>`.
function tagEnd(code, from) {
  let depth = 0;
  for (let i = from; i < code.length; i += 1) {
    const c = code[i];
    if (c === '{' || c === '(' || c === '[') depth += 1;
    else if (c === '}' || c === ')' || c === ']') depth -= 1;
    else if (c === '>' && depth === 0) return { end: i, selfClosing: code[prevSignificant(code, i)] === '/' };
    else if (c === '<' && depth === 0 && code[i + 1] !== '/') return null;
  }
  return null;
}

// The attributes of an opening tag, read from the code view between `from` and `end` (its `>`):
//   name="text" | name='text'   → { kind: 'string', value: text }
//   name={expression}           → { kind: 'expression', value: expression source }
//   name                        → { kind: 'flag', value: true }
// A spread `{...props}` is kept under the key '...' (its presence can label a control the page cannot see).
function readAttributes(src, code, from, end) {
  const attrs = new Map();
  let i = from;
  while (i < end) {
    const c = code[i];
    if (/\s|\//.test(c)) { i += 1; continue; }
    if (c === '{') {
      const close = matchingClose(code, i);
      if (close < 0 || close > end) break;
      if (/^\{\s*\.\.\./.test(code.slice(i, close))) attrs.set('...', { kind: 'spread', value: src.slice(i + 1, close) });
      i = close + 1;
      continue;
    }
    const name = /^[A-Za-z_][\w:.-]*/.exec(code.slice(i, end));
    if (!name) { i += 1; continue; }
    let j = i + name[0].length;
    while (j < end && /\s/.test(code[j])) j += 1;
    if (code[j] !== '=') { attrs.set(name[0], { kind: 'flag', value: true }); i = j; continue; }
    j += 1;
    while (j < end && /\s/.test(code[j])) j += 1;
    if (code[j] === '"' || code[j] === '\'') {
      const close = code.indexOf(code[j], j + 1);
      if (close < 0 || close > end) break;
      attrs.set(name[0], { kind: 'string', value: src.slice(j + 1, close), start: j });
      i = close + 1;
    } else if (code[j] === '{') {
      const close = matchingClose(code, j);
      if (close < 0 || close > end) break;
      attrs.set(name[0], { kind: 'expression', value: src.slice(j + 1, close), start: j });
      i = close + 1;
    } else {
      i = j + 1;
    }
  }
  return attrs;
}

// Every element of the page whose tag name `accept` allows (a Set, a RegExp, or nothing for all), in
// source order: { name, start, openEnd, selfClosing, attrs, childrenStart, childrenEnd, end }. The
// children of a self-closing element, or of one whose closing tag cannot be found, are empty.
function jsxElements(content, accept = null) {
  const { src, code } = sourceView(content);
  const allowed = (name) => !accept || (accept instanceof Set ? accept.has(name) : accept.test(name));
  const out = [];
  for (const m of code.matchAll(/<([A-Za-z][\w.]*)(?=[\s/>])/g)) {
    const name = m[1];
    if (!allowed(name) || !elementMayStart(code, m.index)) continue;
    const tag = tagEnd(code, m.index + m[0].length);
    if (!tag) continue;
    const element = {
      name,
      start: m.index,
      openEnd: tag.end + 1,
      selfClosing: tag.selfClosing,
      attrs: readAttributes(src, code, m.index + m[0].length, tag.end),
      childrenStart: tag.end + 1,
      childrenEnd: tag.end + 1,
      end: tag.end + 1,
    };
    if (!tag.selfClosing) {
      const close = closingTag(code, name, tag.end + 1);
      if (close) Object.assign(element, { childrenEnd: close.start, end: close.end });
    }
    out.push(element);
  }
  return out;
}

// The `</name>` that closes an element whose opening tag ends before `from`, counting nested
// non-self-closing elements of the same name.
function closingTag(code, name, from) {
  const re = new RegExp(`<(/?)${name.replace(/[.$]/g, '\\$&')}(?=[\\s/>])`, 'g');
  re.lastIndex = from;
  let depth = 1;
  for (let m = re.exec(code); m; m = re.exec(code)) {
    if (m[1]) {
      depth -= 1;
      if (depth === 0) {
        const gt = code.indexOf('>', m.index);
        return gt < 0 ? null : { start: m.index, end: gt + 1 };
      }
    } else if (elementMayStart(code, m.index)) {
      const tag = tagEnd(code, m.index + m[0].length);
      if (tag && !tag.selfClosing) depth += 1;
    }
  }
  return null;
}

// The text a page's JSX shows as written: each run of JSX text, { start, end, text }. HTML character
// references (`&amp;`, `&#8212;`) are decoded to a space so that `Review &amp; submit` reads as words
// and `&nbsp;` alone reads as none.
function jsxTextRuns(content) {
  const { src, code } = sourceView(content);
  const comment = new Uint8Array(src.length);
  for (const { start, end } of commentRanges(src)) comment.fill(1, start, end);
  const runs = [];
  let opener = '';
  let run = null;
  for (let i = 0; i < src.length; i += 1) {
    const literal = code[i] !== src[i] && !comment[i];
    if (literal && (opener === '>' || opener === '}')) {
      if (!run) run = { start: i, end: i + 1 };
      else run.end = i + 1;
      continue;
    }
    if (!literal && !comment[i] && !/\s/.test(code[i])) {
      if (run) { runs.push(run); run = null; }
      opener = code[i];
    }
  }
  if (run) runs.push(run);
  return runs.map((r) => ({ ...r, text: src.slice(r.start, r.end).replace(/&(?:#\d+|#x[0-9a-f]+|[a-z]+);/gi, ' ') }));
}

// The source of a declaration named `name` — `const name = …`, `let`/`var`, or `function name(…) {…}` —
// up to the end of its body or its depth-0 `;`, or null. Used to follow a handler one level: an
// `onClick={goNext}` is read through `const goNext = () => setStep(…)`.
function declarationSource(content, name) {
  const { src, code } = sourceView(content);
  const escaped = name.replace(/\$/g, '\\$');
  const decl = new RegExp(`(?:\\b(?:const|let|var)\\s+${escaped}\\s*[:=]|\\bfunction\\s+${escaped}\\s*[<(])`).exec(code);
  if (!decl) return null;
  let depth = 0;
  let sawBlock = false;
  for (let i = decl.index + decl[0].length; i < code.length; i += 1) {
    const c = code[i];
    if (c === '(' || c === '[' || c === '{') { depth += 1; if (c === '{') sawBlock = true; continue; }
    if (c === ')' || c === ']' || c === '}') {
      depth -= 1;
      if (depth < 0) return src.slice(decl.index, i);
      if (depth === 0 && c === '}' && sawBlock && /^\s*(?:;|$|\n)/.test(code.slice(i + 1, i + 3))) return src.slice(decl.index, i + 1);
      continue;
    }
    if (depth === 0 && c === ';') return src.slice(decl.index, i + 1);
  }
  return src.slice(decl.index);
}

// --- Function definitions and their scopes ---------------------------------------------------------

// Skip a TypeScript return type after a parameter list: `): JSX.Element {` or `): Promise<void> =>`.
// Returns the index of the `{` or `=>` that follows, or -1.
function afterReturnType(code, from) {
  let i = from;
  while (i < code.length && /\s/.test(code[i])) i += 1;
  if (code[i] !== ':') return i;
  let angle = 0;
  for (i += 1; i < code.length; i += 1) {
    const c = code[i];
    if (c === '<') angle += 1;
    else if (c === '>' && code[i - 1] !== '=') angle -= 1;
    else if (angle === 0 && (c === '{' || (c === '=' && code[i + 1] === '>'))) return i;
    else if (angle === 0 && c === ';') return -1;
  }
  return -1;
}

// The extent of an arrow's or function's body that starts at `at` (a `{`, or the first character of an
// expression body): { start, end } with `end` exclusive.
function bodyExtent(code, at) {
  if (code[at] === '{') {
    const close = matchingClose(code, at);
    return { start: at, end: close < 0 ? code.length : close + 1 };
  }
  let depth = 0;
  for (let i = at; i < code.length; i += 1) {
    const c = code[i];
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) return { start: at, end: i };
      depth -= 1;
    } else if (depth === 0 && (c === ';' || c === ',')) return { start: at, end: i };
  }
  return { start: at, end: code.length };
}

// Identifiers a parameter list or binding pattern declares, with type annotations and defaults left out:
//   (props: GeneratedComponentProps)            → props
//   (e: React.DragEvent<HTMLDivElement>, id)    → e, id
//   [{ tasks, loading, error }, setData]        → tasks, loading, error, setData
//   { dataApi, pageInput: input = null }        → dataApi, input
// A `:` inside an object pattern renames (`a: b` binds b); anywhere else it starts a type annotation,
// which — like a default after `=` — is skipped to the next `,` or closing bracket of its level.
function patternNames(text) {
  const s = String(text);
  const names = [];
  const stack = [];
  const skipValue = (from) => {
    let depth = 0;
    for (let k = from; k < s.length; k += 1) {
      const c = s[k];
      if (c === '(' || c === '[' || c === '{' || c === '<') depth += 1;
      else if (c === ')' || c === ']' || c === '}' || (c === '>' && s[k - 1] !== '=')) {
        if (depth === 0) return k;
        depth -= 1;
      } else if (c === ',' && depth === 0) return k;
    }
    return s.length;
  };
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '(' || c === '[' || c === '{') { stack.push(c); i += 1; continue; }
    if (c === ')' || c === ']' || c === '}') { stack.pop(); i += 1; continue; }
    // A `:` or `=` after a whole pattern (`{ item }: Props`, `[a] = []`) annotates or defaults it.
    if (c === ':' || c === '=') { i = skipValue(i + 1); continue; }
    const word = /^[A-Za-z_$][\w$]*/.exec(s.slice(i));
    if (!word) { i += 1; continue; }
    let j = i + word[0].length;
    while (j < s.length && /\s/.test(s[j])) j += 1;
    if (s[j] === ':' && stack.at(-1) === '{') { i = j + 1; continue; }
    if (!/^(?:const|let|var|async|readonly|public|private|protected)$/.test(word[0])) names.push(word[0]);
    if (s[j] === '?') j += 1;
    while (j < s.length && /\s/.test(s[j])) j += 1;
    i = s[j] === ':' || s[j] === '=' ? skipValue(j + 1) : j;
  }
  return names;
}

// The source with every comment replaced by spaces (line breaks kept), so offsets still map 1:1 and a
// name or a quoted word inside a comment is never read as code or as a string the code holds.
function withoutComments(content) {
  const src = String(content || '');
  const out = src.split('');
  for (const { start, end } of commentRanges(src)) for (let i = start; i < end; i += 1) if (out[i] !== '\n' && out[i] !== '\r') out[i] = ' ';
  return out.join('');
}

// Every function body in the page — of an arrow, a `function` declaration or expression, or a
// method — with its parameter names: { start, end, params }.
function functionScopes(code) {
  const scopes = [];
  for (const m of code.matchAll(/=>/g)) {
    let body = m.index + 2;
    while (body < code.length && /\s/.test(code[body])) body += 1;
    // The parameters: `(…)` before the arrow (after an optional return type), or one bare name.
    let k = prevSignificant(code, m.index);
    let params = '';
    if (code[k] === ')') {
      let depth = 0;
      for (let j = k; j >= 0; j -= 1) {
        if (code[j] === ')') depth += 1;
        else if (code[j] === '(' && --depth === 0) { params = code.slice(j + 1, k); break; }
      }
    } else if (IDENT_CHAR.test(code[k])) {
      params = wordBefore(code, k);
    }
    scopes.push({ ...bodyExtent(code, body), params: patternNames(params) });
  }
  for (const m of code.matchAll(/\bfunction\b\s*\*?\s*(?:[A-Za-z_$][\w$]*)?\s*(?:<[^>()]*>)?\s*\(/g)) {
    const open = m.index + m[0].length - 1;
    const close = matchingClose(code, open);
    if (close < 0) continue;
    const at = afterReturnType(code, close + 1);
    if (at < 0 || code[at] !== '{') continue;
    scopes.push({ ...bodyExtent(code, at), params: patternNames(code.slice(open + 1, close)) });
  }
  return scopes;
}

// A named function definition: `function name(…) {…}`, or a `const|let|var name =` whose value is an
// arrow, a function expression, or one wrapped in memo/forwardRef. A value that is a CALL of something
// else (`useCallback(…)`, `useMemo(…)`) is not a definition of the name.
function namedFunctions(code) {
  const out = [];
  for (const m of code.matchAll(/\bfunction\b\s*\*?\s*([A-Za-z_$][\w$]*)\s*(?:<[^>()]*>)?\s*\(/g)) {
    const before = prevSignificant(code, m.index);
    // `const f = function g() {}` is the const's definition, read below.
    if (code[before] === '=' || (code[before] === '(' && /\b(?:memo|forwardRef)\s*$/.test(code.slice(0, before)))) continue;
    const open = m.index + m[0].length - 1;
    const close = matchingClose(code, open);
    const at = close < 0 ? -1 : afterReturnType(code, close + 1);
    if (at < 0 || code[at] !== '{') continue;
    out.push({ name: m[1], start: m.index, body: bodyExtent(code, at), params: patternNames(code.slice(open + 1, close)) });
  }
  const DECL = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]+?)?=(?!=|>)\s*/g;
  for (const m of code.matchAll(DECL)) {
    let i = m.index + m[0].length;
    const rest = code.slice(i);
    const wrapper = /^(?:React\s*\.\s*)?(?:memo|forwardRef)\s*(?:<[^>()]*>)?\s*\(\s*/.exec(rest);
    if (wrapper) i += wrapper[0].length;
    const value = code.slice(i);
    const asyncWord = /^async\s+/.exec(value);
    const start = i + (asyncWord ? asyncWord[0].length : 0);
    const head = code.slice(start);
    let params = null;
    let arrowAt = -1;
    if (/^function\b/.test(head)) {
      const open = code.indexOf('(', start);
      const close = matchingClose(code, open);
      const at = close < 0 ? -1 : afterReturnType(code, close + 1);
      if (at < 0 || code[at] !== '{') continue;
      out.push({ name: m[1], start: m.index, body: bodyExtent(code, at), params: patternNames(code.slice(open + 1, close)) });
      continue;
    }
    const generic = /^<[^>()]*>\s*/.exec(head);
    const paramsAt = start + (generic ? generic[0].length : 0);
    if (code[paramsAt] === '(') {
      const close = matchingClose(code, paramsAt);
      if (close < 0) continue;
      const at = afterReturnType(code, close + 1);
      if (at < 0 || code[at] !== '=' || code[at + 1] !== '>') continue;
      params = code.slice(paramsAt + 1, close);
      arrowAt = at;
    } else {
      const single = /^([A-Za-z_$][\w$]*)\s*=>/.exec(code.slice(paramsAt));
      if (!single) continue;
      params = single[1];
      arrowAt = paramsAt + single[0].length - 2;
    }
    let body = arrowAt + 2;
    while (body < code.length && /\s/.test(code[body])) body += 1;
    out.push({ name: m[1], start: m.index, body: bodyExtent(code, body), params: patternNames(params) });
  }
  return out.sort((a, b) => a.start - b.start);
}

// Every binding the page declares, with where: const/let/var names (destructured too) and function
// declarations, as { name, at } over the code view. A binding belongs to the innermost function scope
// around `at` (innermostScope); one in no function scope belongs to the module.
function declarations(code) {
  const out = [];
  for (const m of code.matchAll(/\b(?:const|let|var)\s+(\[[^\]=]*\]|\{[^}=]*\}|[A-Za-z_$][\w$]*)/g)) {
    for (const name of patternNames(m[1])) out.push({ name, at: m.index });
  }
  for (const m of code.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)/g)) out.push({ name: m[1], at: m.index });
  return out;
}

function innermostScope(scopes, at) {
  let best = null;
  for (const scope of scopes) {
    if (scope.start <= at && at < scope.end && (!best || scope.end - scope.start < best.end - best.start)) best = scope;
  }
  return best;
}

// Rule 3 of references/rules.md: "All code (components, utilities) in one file; each as separate
// top-level function (no nesting)". A function defined inside another one is reported when it is
//   - a COMPONENT: its name is PascalCase (React's convention for a component, which also remounts —
//     and loses its state — on every render of the one it is nested in); or
//   - a UTILITY: it reads nothing the functions around it declare (their parameters, state, setters,
//     props), so nothing keeps it from being top level.
// A nested function that does read their bindings is a handler or an effect's loader — the rules'
// own samples write those inside the component — and is not reported. Unnamed callbacks (`onClick={() => …}`,
// `useEffect(() => …)`, `rows.map((r) => …)`) are not definitions and are not reported either.
// What a function reads from around it is decided by scope: a binding counts when it is declared directly
// in an enclosing function (its innermost function scope is one of them) or is one of their parameters —
// never a binding declared inside the function itself or inside a sibling — and the function's own
// parameters and locals shadow an enclosing name of the same spelling, so
//   const percent = (n) => { const rounded = Math.round(n * 100); return rounded; };
// reads nothing from the component, whatever the component itself declares.
// Returns a list of problems, empty when every component and utility is top level.
function nestedDefinitionProblems(content) {
  const { code } = sourceView(content);
  const scopes = functionScopes(code);
  const declared = declarations(code);
  const homes = declared.map((d) => ({ ...d, home: innermostScope(scopes, d.at) }));
  const problems = [];
  for (const fn of namedFunctions(code)) {
    const around = scopes.filter((s) => s.start < fn.start && fn.start < s.end && !(s.start === fn.body.start && s.end === fn.body.end));
    if (!around.length) continue;
    if (/^[A-Z]/.test(fn.name)) {
      problems.push(`component ${fn.name} is defined inside another function`);
      continue;
    }
    const outer = new Set();
    for (const scope of around) for (const name of scope.params) outer.add(name);
    for (const d of homes) if (d.home && around.includes(d.home)) outer.add(d.name);
    outer.delete(fn.name);
    const own = new Set(fn.params);
    const fnScope = innermostScope(scopes, fn.body.start);
    for (const d of homes) if (d.home && d.home === fnScope) own.add(d.name);
    for (const name of own) outer.delete(name);
    const body = code.slice(fn.body.start, fn.body.end);
    const closes = [...outer].some((name) => new RegExp(`(?<![.\\w$])${name.replace(/\$/g, '\\$')}(?![\\w$])`).test(body));
    if (!closes) problems.push(`utility ${fn.name} is defined inside another function but reads nothing from it`);
  }
  return problems;
}

module.exports = {
  sourceView, jsxElements, jsxTextRuns, declarationSource, matchingClose, patternNames,
  namedFunctions, nestedDefinitionProblems, withoutComments,
};
