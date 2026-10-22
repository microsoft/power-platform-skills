'use strict';

const { blankNonCodePreservingTemplateExpressions } = require('../../../../plugins/model-apps/scripts/lib/source-literals.js');

function groupEnd(mask, open) {
  const pairs = { '(': ')', '{': '}', '[': ']' };
  const stack = [];
  for (let i = open; i < mask.length; i += 1) {
    if (pairs[mask[i]]) stack.push(pairs[mask[i]]);
    else if (/[)}\]]/.test(mask[i])) {
      if (stack.pop() !== mask[i]) throw new Error('unbalanced source evidence');
      if (!stack.length) return i;
    }
  }
  throw new Error('truncated source evidence');
}

function literalString(text) {
  const value = text.trim();
  if (value.startsWith('"')) {
    try {
      const parsed = JSON.parse(value);
      return typeof parsed === 'string' ? parsed : null;
    } catch { return null; }
  }
  const match = /^'((?:\\.|[^'\\])*)'$/.exec(value);
  if (!match) return null;
  // The scorer accepts literal ASCII request names/values and ordinary quote/backslash escapes.
  // Unsupported expressions fail closed; no page source is ever evaluated to discover a value.
  if (/\\[^\\']/.test(match[1])) return null;
  return match[1].replace(/\\(['\\])/g, '$1');
}

function objectFields(text) {
  const source = text.trim();
  const mask = blankNonCodePreservingTemplateExpressions(source);
  if (mask[0] !== '{' || groupEnd(mask, 0) !== mask.length - 1) throw new Error('request must be one literal object');
  const fields = new Map();
  let i = 1;
  while (i < mask.length - 1) {
    while (/[\s,]/.test(mask[i])) i++;
    if (i >= mask.length - 1) break;
    let name;
    if (/["']/.test(mask[i])) {
      const quote = mask[i];
      const end = mask.indexOf(quote, i + 1);
      name = literalString(source.slice(i, end + 1));
      i = end + 1;
    } else {
      const key = /^[A-Za-z_$][\w$]*/.exec(mask.slice(i));
      if (!key) throw new Error('computed, spread or dynamic request properties are not gradeable');
      name = key[0];
      i += name.length;
    }
    while (/\s/.test(mask[i])) i++;
    if (!name || mask[i++] !== ':') throw new Error('request properties require literal names and values');
    while (/\s/.test(mask[i])) i++;
    const start = i;
    while (i < mask.length - 1 && mask[i] !== ',') {
      if (/[({[]/.test(mask[i])) i = groupEnd(mask, i) + 1;
      else i++;
    }
    if (fields.has(name)) throw new Error(`duplicate request property ${name}`);
    fields.set(name, source.slice(start, i).trim());
  }
  return fields;
}

function actionCalls(code) {
  const mask = blankNonCodePreservingTemplateExpressions(code);
  const scopes = [];
  for (const match of mask.matchAll(/\b(?:async\s+)?function\s+([\w$]+)\s*\(/g)) {
    const paramsOpen = match.index + match[0].length - 1;
    const paramsEnd = groupEnd(mask, paramsOpen);
    const body = mask.indexOf('{', paramsEnd);
    if (body !== -1) scopes.push({ name: match[1], start: match.index, paramsOpen, paramsEnd, body, end: groupEnd(mask, body) });
  }
  const calls = [];
  for (const match of mask.matchAll(/\.\s*(executeAction|executeFunction)\s*(?:\?\.\s*)?\(/g)) {
    const open = match.index + match[0].length - 1;
    const end = groupEnd(mask, open);
    const scope = innermostScope(scopes, match.index, end);
    if (!scope) throw new Error('Custom API calls require a gradeable named helper scope');
    const assignment = /\b(?:const|let)\s+([\w$]+)\s*=\s*await\s+[\w$.?]+\s*$/.exec(mask.slice(scope.body, match.index));
    if (!assignment) throw new Error('Custom API call has no associated awaited result');
    // The receiver is the identifier chain right before the dot: `api`, `actionApi`, `props.dataApi`
    // (`api?.executeAction` too). Anything else, such as a parenthesised cast, stays null, and the
    // receiver check fails it rather than guessing what it refers to.
    const chain = /([A-Za-z_$][\w$]*(?:\s*\??\.\s*[A-Za-z_$][\w$]*)*)\s*\??$/.exec(mask.slice(0, match.index));
    const receiver = chain ? normalizeChain(chain[1]) : null;
    calls.push({ method: match[1], start: match.index, end, scope, scopes, receiver, resultName: assignment[1], fields: objectFields(code.slice(open + 1, end)), mask });
  }
  return calls;
}

const normalizeChain = (text) => String(text).replace(/\s+/g, '').replace(/\?\./g, '.');
const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const IDENT = /^[A-Za-z_$][\w$]*$/;
const CHAIN = '[A-Za-z_$][\\w$]*(?:\\s*\\??\\.\\s*[A-Za-z_$][\\w$]*)*';

function innermostScope(scopes, at, end = at) {
  return scopes.filter((entry) => entry.body < at && entry.end > end).sort((a, b) => b.body - a.body)[0];
}

// At a `<`, the index of the `>` closing a TypeScript type-argument list (`new Map<string, number>()`,
// `x as Record<string, unknown>`, a `Record<string, number>` parameter type), or -1 when the `<` reads
// as a comparison. A type list holds only type syntax and is followed by something that can follow a
// type: `(`, `)`, `,`, `[`, `>`, `;`, ` =`, `{`, `}`, `|`, `&`, a line break or nothing. The `>` of an
// arrow `=>` never closes it, and `>=` is a comparison.
function typeArgsEnd(mask, open) {
  let depth = 0;
  for (let i = open; i < mask.length; i += 1) {
    const ch = mask[i];
    if (ch === '<') depth += 1;
    else if (ch === '>' && mask[i - 1] === '=') continue; // the arrow of a function type: `() => void`
    else if (ch === '>') {
      depth -= 1;
      if (depth === 0) {
        const after = mask.slice(i + 1);
        if (after[0] === '=') return -1;
        const next = /^[ \t]*(\r?\n|.?)/.exec(after)[1];
        return next === '' || /^[\r\n]/.test(next) || '(),[>;={}|&'.includes(next) ? i : -1;
      }
    } else if ('({['.includes(ch)) {
      try { i = groupEnd(mask, i); } catch { return -1; }
    } else if (!/[\s\w$.,|&?:'"\]=]/.test(ch)) return -1;
  }
  return -1;
}

// Split `(a, b, c)` at its top-level commas; a type-argument list is one unit.
function splitTopLevel(mask, open, close) {
  const parts = [];
  let start = open + 1;
  for (let i = open + 1; i < close; i += 1) {
    const ch = mask[i];
    if ('({['.includes(ch)) { i = groupEnd(mask, i); continue; }
    if (ch === '<') {
      const end = typeArgsEnd(mask, i);
      if (end > i && end < close) { i = end; continue; }
    }
    if (ch === ',') { parts.push(mask.slice(start, i)); start = i + 1; }
  }
  const last = mask.slice(start, close);
  if (last.trim() || parts.length) parts.push(last);
  return parts.map((part) => part.trim());
}

// `dataApi, pageInput: input, ...rest` → local name → property name.
// A rest entry (`...others`) is a copy of the remaining properties, not a property, so it is
// skipped: `const { ...dataApi } = props` names a copy of the props, not their dataApi.
function destructuredNames(list) {
  const names = new Map();
  for (const entry of list.split(',').map((part) => part.trim()).filter(Boolean)) {
    if (entry.startsWith('...')) continue;
    const match = /^([A-Za-z_$][\w$]*)(?:\s*:\s*([A-Za-z_$][\w$]*))?/.exec(entry);
    if (match) names.set(match[2] || match[1], match[1]);
  }
  return names;
}

// Every call of a named helper, with its arguments. The declaration itself and member calls
// (`obj.name(...)`) are not calls of the helper.
function callSites(mask, name) {
  const sites = [];
  for (const match of mask.matchAll(new RegExp(`(?<![\\w$.])${escapeRe(name)}\\s*\\(`, 'g'))) {
    if (/\bfunction\s*$/.test(mask.slice(Math.max(0, match.index - 20), match.index))) continue;
    const open = match.index + match[0].length - 1;
    sites.push({ at: match.index, args: splitTopLevel(mask, open, groupEnd(mask, open)) });
  }
  return sites;
}

// The page component is the default export; React passes its first parameter the props. Returns
// that parameter's name (or, for a destructured parameter, each property's local name) and the
// component's lexical range as a scope, so its bindings are visible only inside it. A named
// function component already has a scope; an arrow component's body is found after its `=>`.
function pageComponent(mask, scopes) {
  const exported = /\bexport\s+default\s+(?:async\s+)?(?:function\s+)?([A-Za-z_$][\w$]*)/.exec(mask);
  if (!exported) return null;
  const id = escapeRe(exported[1]);
  const decl = new RegExp(`(?:\\bfunction\\s+${id}\\s*|\\b(?:const|let|var)\\s+${id}\\s*(?::[^=;]+)?=\\s*(?:async\\s*)?)\\(`).exec(mask);
  if (!decl) return null;
  const open = decl.index + decl[0].length - 1;
  const close = groupEnd(mask, open);
  const first = splitTopLevel(mask, open, close)[0] || '';
  const pattern = /^\{([^{}]*)\}/.exec(first);
  let scope = scopes.find((entry) => entry.paramsOpen === open);
  if (!scope) {
    const arrow = /^\s*(?::[^=]*?)?=>\s*/.exec(mask.slice(close + 1));
    if (!arrow) return null;
    const body = close + 1 + arrow[0].length;
    const end = '({'.includes(mask[body]) ? groupEnd(mask, body) : (mask.indexOf(';', body) + 1 || mask.length);
    scope = { name: exported[1], start: decl.index, paramsOpen: open, paramsEnd: close, body, end };
  }
  return {
    scope: { ...scope, isComponent: true },
    propsName: pattern ? null : (/^([A-Za-z_$][\w$]*)/.exec(first) || [])[1] || null,
    destructured: pattern ? destructuredNames(pattern[1]) : new Map(),
  };
}

// A declaration's complete initializer, from `start` to the end of its statement: a `;`, a
// top-level `,` (the next declarator) or the end of the enclosing group. A line break ends it too
// unless the next line continues the expression (`|| other`, `as Api`, `.member`).
function initializerText(mask, start) {
  // `const x =` followed by a line break: the initializer starts on a later line.
  while (start < mask.length && /\s/.test(mask[start])) start += 1;
  return mask.slice(start, expressionEnd(mask, start));
}

// Where the expression starting at `start` ends: a `;`, a top-level `,`, the end of the enclosing
// group, or a line break where automatic semicolon insertion ends the statement — the text so far is
// complete and the next line does not continue it (`dataApi as\n  Api` and `dataApi\n  || other`
// both continue; a next line starting with `(`, `[` or a template continues it too).
function expressionEnd(mask, start) {
  for (let i = start; i < mask.length; i += 1) {
    const ch = mask[i];
    if ('({['.includes(ch)) { i = groupEnd(mask, i); continue; }
    if (ch === '<') { const end = typeArgsEnd(mask, i); if (end > i) { i = end; continue; } }
    if (';,)}]'.includes(ch)) return i;
    if (ch === '\n') {
      const unfinished = /(?:[=|&?:,.+\-*/%<>!]|\bas|\bsatisfies)\s*$/.test(mask.slice(start, i));
      const continued = /^\s*(?:[|&?:.+\-*/%=<>,!([`]|as\b|satisfies\b)/.test(mask.slice(i + 1));
      if (!unfinished && !continued) return i;
    }
  }
  return mask.length;
}
// The name an initializer passes on unchanged: a reference chain, optionally cast (`as T`,
// `satisfies T`) or non-null asserted. Anything that computes a different value (`a && b`,
// `a ?? b`, a call, a conditional) returns null, so the alias proves nothing.
function identityChain(text) {
  const head = new RegExp(`^\\s*(${CHAIN})`).exec(text);
  if (!head) return null;
  // An arrow's `>` is not a closing angle, so name it before collapsing brackets.
  let rest = text.slice(head[0].length).replace(/=>/g, ' fn ');
  // Collapse bracketed type syntax (`{ … }`, `( … ) => T`, `[ … ]`, `< … >`) so only its outline is checked.
  let previous;
  do {
    previous = rest;
    rest = rest.replace(/\([^()]*\)|\{[^{}]*\}|\[[^[\]]*\]|<[^<>]*>/g, ' T ');
  } while (rest !== previous);
  return /^(?:\s*(?:as|satisfies)\s+(?:[\w$.]+|\s|\|(?!\|)|&(?!&))+)*\s*!?\s*$/.test(rest) ? head[1] : null;
}

// True when `name` is assigned or bound again anywhere (`name = x`, `name ??= x`, `name += x`) — any spot
// that is not its declaration. The binding then no longer proves what it holds at the call, so it
// is not trusted. Conservative: a same-named variable reassigned in another scope counts too, and a
// default value (`{ name = x }`, `(name = x) =>`) does as well; both only ever refuse.
function reassigned(mask, name) {
  const id = escapeRe(name);
  const word = new RegExp(`(?<![\\w$.])${id}(?![\\w$])`);
  const re = new RegExp(`(?<![\\w$.])${id}\\s*(?:\\*\\*|<<|>>>?|&&|\\|\\||\\?\\?|[-+*/%&|^])?=(?![=>])`, 'g');
  for (const match of mask.matchAll(re)) {
    if (!/\b(?:const|let|var)\s+$/.test(mask.slice(Math.max(0, match.index - 12), match.index))) return true;
  }
  // A destructuring assignment writes every name in its pattern: `[client] = [other]`, `({ client } = x)`.
  for (const match of mask.matchAll(/[\]}]\s*=(?![=>])/g)) {
    const open = groupStart(mask, match.index);
    if (open < 0 || /\b(?:const|let|var)\s*$/.test(mask.slice(Math.max(0, open - 8), open))) continue;
    if (word.test(mask.slice(open, match.index))) return true;
  }
  // `for (client of list)` assigns without declaring.
  if (new RegExp(`\\bfor\\s*\\(\\s*${id}\\s+(?:of|in)\\b`).test(mask)) return true;
  // A loop head or catch clause that DECLARES the name binds it again, shadowing an outer binding
  // (`for (const dataApi of [other])`, `catch (dataApi)`); treated the same way, everywhere.
  for (const match of mask.matchAll(/\bfor\s*\(\s*(?:const|let|var)\s+([^;]*?)\s+(?:of|in)\b|\bcatch\s*\(([^)]*)\)/g)) {
    if (word.test(match[1] || match[2] || '')) return true;
  }
  return false;
}

// The index of the bracket that `close` closes, scanning back; -1 when unbalanced.
function groupStart(mask, close) {
  const pairs = { ')': '(', '}': '{', ']': '[' };
  const stack = [];
  for (let i = close; i >= 0; i -= 1) {
    if (pairs[mask[i]]) stack.push(pairs[mask[i]]);
    else if ('({['.includes(mask[i])) {
      if (stack.pop() !== mask[i]) return -1;
      if (!stack.length) return i;
    }
  }
  return -1;
}

// Every identifier a parameter list binds. Deliberately over-approximate: every name in it counts —
// destructured, nested, array, rest and default patterns alike, and type names too — because a name
// this misses would let an outer binding show through, while an extra one only ever refuses.
function boundNames(paramsText) {
  return [...String(paramsText).matchAll(/[A-Za-z_$][\w$]*/g)].map((m) => m[0]);
}

// Walk back from `end` (the index just before an arrow's `=>`, trailing spaces trimmed) over a return
// type annotation (`): { result: T }`, `): Promise<void>`, `): A | B`) to the `)` closing the parameter
// list. Returns that index, or -1 when there is no `:` annotation to skip.
function paramsCloseBeforeReturnType(mask, end) {
  let i = end;
  while (i >= 0) {
    const ch = mask[i];
    if (/\s/.test(ch)) { i -= 1; continue; }
    if (')}]'.includes(ch)) { const open = groupStart(mask, i); if (open < 0) return -1; i = open - 1; continue; }
    if (ch === '>') {
      let depth = 0;
      let j = i;
      for (; j >= 0; j -= 1) {
        if (mask[j] === '>' && mask[j - 1] !== '=') depth += 1;
        else if (mask[j] === '<') { depth -= 1; if (depth === 0) break; }
      }
      if (j < 0) return -1;
      i = j - 1;
      continue;
    }
    if (/[\w$.|&?,'"]/.test(ch) || (ch === '>' && mask[i - 1] === '=')) { i -= 1; continue; }
    if (ch === ':') {
      let k = i - 1;
      while (k >= 0 && /\s/.test(mask[k])) k -= 1;
      return mask[k] === ')' ? k : -1;
    }
    return -1;
  }
  return -1;
}

// Every function the named-helper list does not cover, as a scope whose callers cannot be traced:
// arrows (`(a) =>`, `a =>`, with or without a return type) and anonymous `function (…) {}`
// expressions. Their parameters bind as opaque names and shadow the same names outside them.
function arrowScopes(mask) {
  const scopes = [];
  for (const match of mask.matchAll(/=>/g)) {
    const before = mask.slice(0, match.index).replace(/\s+$/, '');
    let names = [];
    let plainNames = [];
    let paramsOpen = -1;
    let close = before.length - 1;
    if (before[close] !== ')') {
      const typed = paramsCloseBeforeReturnType(mask, close);
      if (typed >= 0) close = typed;
    }
    if (before[close] === ')') {
      paramsOpen = groupStart(mask, close);
      if (paramsOpen < 0) continue;
      names = boundNames(mask.slice(paramsOpen + 1, close));
      plainNames = splitTopLevel(mask, paramsOpen, close)
        .map((param) => /^([A-Za-z_$][\w$]*)(?=\s*(?:[:=]|$))/.exec(param)?.[1]).filter(Boolean);
    } else {
      const single = /([A-Za-z_$][\w$]*)$/.exec(before);
      if (!single || /^(?:async|await|return)$/.test(single[1])) continue;
      names = [single[1]];
      plainNames = [single[1]];
      paramsOpen = before.length - single[1].length;
    }
    let body = match.index + 2;
    while (/\s/.test(mask[body] || '')) body += 1;
    const bodyEnd = mask[body] === '{' ? groupEnd(mask, body) : expressionEnd(mask, body);
    const paramsEnd = before[close] === ')' ? close : before.length;
    scopes.push({ arrow: true, names, plainNames, paramsOpen, paramsEnd, body: match.index, end: bodyEnd });
  }
  // `function (…) {` and `function* (…) {` with no name: a value, so its callers are untraceable too.
  for (const match of mask.matchAll(/\bfunction\s*\*?\s*\(/g)) {
    const paramsOpen = match.index + match[0].length - 1;
    const paramsEnd = groupEnd(mask, paramsOpen);
    const body = mask.indexOf('{', paramsEnd);
    if (body < 0) continue;
    scopes.push({ arrow: true, names: boundNames(mask.slice(paramsOpen + 1, paramsEnd)), paramsOpen, paramsEnd, body: paramsOpen, end: groupEnd(mask, body) });
  }
  return scopes;
}
// The bindings of `name` visible at `at`, innermost only: a parameter of an enclosing named helper
// or of the page component (its first parameter is the props), or a declaration (`const x = …`,
// `const { … } = …`) inside an enclosing scope or outside every scope. A binding inside a scope
// that does not enclose `at` (another helper, or the component seen from a helper outside it) is
// not visible. Several bindings at the same level must all resolve.
function bindingsOf(ctx, name, at, potentialWrite = false, parameterHeader = false) {
  const { mask, scopes, component } = ctx;
  const found = [];
  const levelOf = (index) => {
    const scope = innermostScope(scopes, index);
    if (!scope) return -1;
    return scope.body < at && scope.end > at ? scope.body : null;
  };
  // A parameter default (`record = props.selectedAccount`) is before its body but binds
  // that same parameter. Include it only when identifying an assignment LHS, not its RHS or
  // ordinary value/receiver proof. Header visibility uses the list position so nested scopes win.
  for (const scope of scopes.filter((entry) => (entry.body < at && entry.end > at)
    || (parameterHeader && potentialWrite && !entry.isComponent && entry.paramsOpen < at && entry.paramsEnd > at))) {
    const level = scope.body < at ? scope.body : scope.paramsOpen;
    if (scope.arrow) {
      if (scope.names.includes(name)) found.push({ level, kind: 'opaque', at: scope.paramsOpen, scope,
        definiteParameter: scope.plainNames?.includes(name) === true });
      continue;
    }
    if (scope.isComponent) {
      if (component.propsName === name) found.push({ level: scope.body, kind: 'props' });
      const property = component.destructured.get(name);
      if (property) found.push({ level: scope.body, kind: 'prop-member', property });
      continue;
    }
    // A named helper's parameter is what its callers pass. A plain one (`api`, `api: ActionApi`,
    // `api = fallback`) is traced through every call; a destructured `{ dataApi }` / `{ dataApi: api }`
    // is that property of what every call passes; any other name a parameter binds (a nested, array
    // or rest pattern, a rest parameter) is opaque. Each of them shadows the same name outside.
    splitTopLevel(mask, scope.paramsOpen, scope.paramsEnd).forEach((param, index) => {
      const plain = param.startsWith('...') ? null : /^([A-Za-z_$][\w$]*)/.exec(param);
      if (plain) {
        if (plain[1] === name) found.push({ level, kind: 'param', scope, index, name });
        return;
      }
      const pattern = /^\{([^{}]*)\}/.exec(param);
      const property = pattern ? destructuredNames(pattern[1]).get(name) : undefined;
      if (property) found.push({ level, kind: 'param-member', scope, index, name, property });
      else if (boundNames(param).includes(name)) found.push({ level, kind: 'opaque', scope, index });
    });
  }
  for (const match of mask.matchAll(new RegExp(`\\b(?:const|let|var)\\s+${escapeRe(name)}\\s*(?::[^=;]+)?=`, 'g'))) {
    const level = levelOf(match.index);
    if (level === null) continue;
    // The whole initializer must pass the value on: `const a = dataApi && other` is not `dataApi`.
    const expr = identityChain(initializerText(mask, match.index + match[0].length));
    found.push(expr ? { level, kind: 'alias', expr, at: match.index } : { level, kind: 'opaque', at: match.index });
  }
  for (const match of mask.matchAll(/\b(?:const|let|var)\s*\{([^{}]*)\}\s*(?::[^=;]+)?=/g)) {
    const property = destructuredNames(match[1]).get(name);
    const level = property ? levelOf(match.index) : null;
    if (level === null) continue;
    const object = identityChain(initializerText(mask, match.index + match[0].length));
    found.push(object ? { level, kind: 'member', object, property, at: match.index } : { level, kind: 'opaque', at: match.index });
  }
  if (!found.length) return [];
  const innermost = Math.max(...found.map((binding) => binding.level));
  const visible = found.filter((binding) => binding.level === innermost);
  // A name assigned again after its declaration (or a parameter overwritten in its helper) proves nothing.
  // Write tracking keeps potential identities even after a rebind: an earlier alias may still
  // hold the original object. This over-approximation is used only to refuse member provenance;
  // the ordinary binding/receiver proof keeps its existing fail-closed rebinding behavior.
  return !potentialWrite && reassigned(mask, name) ? visible.map((binding) => ({ ...binding, kind: 'opaque' })) : visible;
}

// A helper parameter is what its callers pass. A recursive call that passes the same PLAIN parameter on
// adds no provenance, so it is not counted; with no other caller, nothing is proven. A destructured
// parameter's local is not the argument it came from — `run(dataApi)` inside `run({ dataApi })` hands
// the next call the property, not the props — so for one of those every call is checked.
function paramFilledWith(ctx, binding, depth, resolve) {
  const { scope, index, name, kind } = binding;
  const sites = callSites(ctx.mask, scope.name)
    .filter((site) => !(kind === 'param' && site.at > scope.body && site.at < scope.end && identityChain(site.args[index] || '') === name));
  return sites.length > 0 && sites.every((site) => resolve(ctx, site.args[index], site.at, depth + 1));
}

// Is `expr` the props object React passed the page component?
function isPropsObject(ctx, expr, at, depth = 0) {
  if (!expr || depth > 8) return false;
  // The whole expression must pass the value on: `props as Props && other` is `other`.
  const chain = identityChain(expr);
  const name = chain ? normalizeChain(chain) : null;
  if (!name || !IDENT.test(name)) return false;
  const bindings = bindingsOf(ctx, name, at);
  return bindings.length > 0 && bindings.every((binding) => {
    if (binding.kind === 'props') return true;
    if (binding.kind === 'param') return paramFilledWith(ctx, binding, depth, isPropsObject);
    if (binding.kind === 'alias') return isPropsObject(ctx, binding.expr, binding.at, depth + 1);
    return false;
  });
}

// Is `expr` the props' `dataApi`?
function isDataApi(ctx, expr, at, depth = 0) {
  if (!expr || depth > 8) return false;
  const chain = identityChain(expr);
  if (!chain) return false;
  const name = normalizeChain(chain);
  const member = /^([A-Za-z_$][\w$]*)\.dataApi$/.exec(name);
  if (member) return isPropsObject(ctx, member[1], at, depth + 1);
  if (!IDENT.test(name)) return false;
  const bindings = bindingsOf(ctx, name, at);
  return bindings.length > 0 && bindings.every((binding) => {
    if (binding.kind === 'param') return paramFilledWith(ctx, binding, depth, isDataApi);
    if (binding.kind === 'alias') return isDataApi(ctx, binding.expr, binding.at, depth + 1);
    if (binding.kind === 'member') return binding.property === 'dataApi' && isPropsObject(ctx, binding.object, binding.at, depth + 1);
    if (binding.kind === 'param-member') return binding.property === 'dataApi' && paramFilledWith(ctx, binding, depth, isPropsObject);
    if (binding.kind === 'prop-member') return binding.property === 'dataApi';
    return false; // the props object itself is not its dataApi
  });
}

// The Custom API surface is the page's `dataApi` prop, so a call or presence check on any other
// object proves nothing. A receiver counts only when it provably is that prop: `<props>.dataApi`
// where <props> is the page component's props parameter, a name destructured from those props or
// assigned from such a name (casts allowed), or a parameter of an enclosing helper that every
// outside call fills with one of those. Anything unresolvable fails.
function sourceContext(mask, scopes) {
  const component = pageComponent(mask, scopes);
  const named = component
    ? [...scopes.filter((scope) => scope.paramsOpen !== component.scope.paramsOpen), component.scope]
    : scopes;
  // The component itself may be an arrow; it is already in the list as the component scope.
  const arrows = arrowScopes(mask).filter((scope) => !component || scope.paramsOpen !== component.scope.paramsOpen);
  const all = [...named, ...arrows];
  return { mask, scopes: all, component };
}

function receiverIsDataApi(mask, scopes, expr, at) {
  return isDataApi(sourceContext(mask, scopes), expr, at);
}

// Resolve only the identity-preserving forms already understood by the shared evidence reader.
// Parameters keep a local identity and their recognized caller identities so writes through a
// named helper or alias cannot conceal a changed member. Opaque expressions establish no identity.
function identityPaths(ctx, expr, at, depth = 0) {
  if (!expr || depth > 8) return [];
  const chain = identityChain(expr);
  if (!chain) return [];
  const [name, ...members] = normalizeChain(chain).split('.');
  const append = (paths, parts = []) => paths.map((entry) => ({ root: entry.root, parts: [...entry.parts, ...parts, ...members] }));
  const bindings = bindingsOf(ctx, name, at, true);
  const bindingKey = (binding) => JSON.stringify(binding.scope
    ? [binding.kind, binding.scope.paramsOpen, binding.index, binding.property]
    : [binding.kind, binding.level, binding.at, binding.property]);
  const bindingKeys = new Set(bindings.map(bindingKey));
  const paths = bindings.flatMap((binding) => {
    if (binding.kind === 'props') return append([{ root: `props:${ctx.component.scope.paramsOpen}`, parts: [] }]);
    if (binding.kind === 'prop-member') return append([{ root: `props:${ctx.component.scope.paramsOpen}`, parts: [] }], [binding.property]);
    if (binding.kind === 'alias') return append(identityPaths(ctx, binding.expr, binding.at, depth + 1));
    if (binding.kind === 'member') return append(identityPaths(ctx, binding.object, binding.at, depth + 1), [binding.property]);
    if (binding.kind === 'param' || binding.kind === 'param-member') {
      const { scope, index } = binding;
      const local = [{ root: `param:${scope.paramsOpen}:${index}`, parts: [] }];
      const callers = callSites(ctx.mask, scope.name).filter((site) => !(site.at > scope.body && site.at < scope.end
        && identityChain(site.args[index] || '') === name));
      const incoming = callers.flatMap((site) => identityPaths(ctx, site.args[index], site.at, depth + 1));
      return append([...local, ...incoming], binding.kind === 'param-member' ? [binding.property] : []);
    }
    return [];
  });
  // A reassigned writer may acquire the input after its initializer. Union recognized RHS
  // identities only for that resolved scope/declaration/parameter, not another scope's `record`.
  // Even opaque bindings retain their declaration position; this adds no value or receiver proof.
  const assignments = new RegExp(`(?<![\\w$.])${escapeRe(name)}\\s*(?:\\?\\?|\\|\\||&&)?=(?![=>])`, 'g');
  for (const assignment of ctx.mask.matchAll(assignments)) {
    if (/\b(?:const|let|var)\s+$/.test(ctx.mask.slice(Math.max(0, assignment.index - 12), assignment.index))) continue;
    const assigned = bindingsOf(ctx, name, assignment.index, true, true);
    // Opaque patterns over-approximate names: `{ other = (outer = input) }` can assign an
    // enclosing `outer`, not declare a parameter. Keep the original body-only possibilities
    // too; ambiguity may refuse provenance but must never silently discard a possible write.
    // A plain arrow parameter definitely declares its own name even though value/caller
    // evidence stays opaque. It cannot assign a same-named outer variable in its header;
    // only genuinely ambiguous patterns need the body-only outer possibilities.
    const opaqueHeader = assigned.some((binding) => binding.kind === 'opaque' && !binding.definiteParameter && binding.scope
      && binding.scope.paramsOpen < assignment.index && binding.scope.paramsEnd > assignment.index);
    const outsideHeader = opaqueHeader ? bindingsOf(ctx, name, assignment.index, true) : null;
    const possible = outsideHeader ? [...assigned, ...outsideHeader] : assigned;
    // Two unresolved references may still share an outer binding. Retain that potential write only
    // for conservative refusal, never as authorization of an input value or API receiver.
    const sameBinding = bindingKeys.size ? possible.some((binding) => bindingKeys.has(bindingKey(binding)))
      : (outsideHeader || assigned).length === 0;
    if (!sameBinding) continue;
    const rhs = identityChain(initializerText(ctx.mask, assignment.index + assignment[0].length));
    if (rhs && normalizeChain(rhs) !== name) paths.push(...append(identityPaths(ctx, rhs, assignment.index, depth + 1)));
  }
  return [...new Map(paths.map((entry) => [JSON.stringify(entry), entry])).values()];
}

function memberWriteTargets(mask) {
  const candidates = [];
  const writes = [];
  for (const match of mask.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)/g)) {
    const parts = [];
    let end = match.index + match[0].length;
    while (end < mask.length) {
      const member = /^\s*\.\s*([A-Za-z_$][\w$]*)/.exec(mask.slice(end));
      if (member) { parts.push(member[1]); end += member[0].length; continue; }
      const bracket = /^\s*\[/.exec(mask.slice(end));
      if (!bracket) break;
      const open = end + bracket[0].length - 1;
      end = groupEnd(mask, open) + 1;
      // Strings are masked, and a computed member may name the used field: refuse rather than guess.
      parts.push('*');
    }
    if (!parts.length) continue;
    const target = { expr: match[1], parts, at: match.index, end };
    candidates.push(target);
    const tail = mask.slice(end);
    const prefix = mask.slice(0, match.index);
    if (/^\s*(?:(?:\*\*|<<|>>>?|&&|\|\||\?\?|[-+*/%&|^])?=(?![=>])|\+\+|--)/.test(tail)
      || /\bdelete\s*$|\+\+\s*$|--\s*$/.test(prefix)
      || (/\bfor\s*\(\s*$/.test(prefix) && /^\s+(?:of|in)\b/.test(tail))) writes.push(target);
  }
  // Destructuring assignments can write a member without an adjacent '=': ({ id: record.id } = x).
  for (const match of mask.matchAll(/[\]}]\s*=(?![=>])/g)) {
    const open = groupStart(mask, match.index);
    if (open < 0 || /\b(?:const|let|var)\s*$/.test(mask.slice(Math.max(0, open - 8), open))) continue;
    writes.push(...candidates.filter((entry) => entry.at > open && entry.end <= match.index));
  }
  for (const match of mask.matchAll(/\b(?:Object\s*\.\s*(?:assign|defineProperty|defineProperties|setPrototypeOf)|Reflect\s*\.\s*(?:set|defineProperty|deleteProperty|setPrototypeOf))\s*\(/g)) {
    const open = match.index + match[0].lastIndexOf('(');
    const close = groupEnd(mask, open);
    const target = splitTopLevel(mask, open, close)[0];
    if (target) writes.push({ expr: target, parts: [], at: match.index });
  }
  return writes;
}

function recordValueWritten(ctx, expr, at) {
  const roots = identityPaths(ctx, expr, at);
  if (!roots.length) return true;
  const writes = ctx.memberWrites || (ctx.memberWrites = memberWriteTargets(ctx.mask));
  return writes.some((write) => identityPaths(ctx, write.expr, write.at).some((entry) => {
    const changed = { root: entry.root, parts: [...entry.parts, ...write.parts] };
    return roots.some((root) => root.root === changed.root
      && root.parts.slice(0, Math.min(root.parts.length, changed.parts.length))
        .every((part, index) => part === '*' || changed.parts[index] === '*' || part === changed.parts[index]));
  }));
}

function recordPropInput(ctx, expr, at, depth = 0) {
  if (!expr || depth > 8) return false;
  const chain = identityChain(expr);
  const name = chain ? normalizeChain(chain) : null;
  if (!name) return false;
  if (recordValueWritten(ctx, name, at)) return false;
  const direct = /^([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)$/.exec(name);
  if (direct) return isPropsObject(ctx, direct[1], at, depth + 1);
  if (!IDENT.test(name)) return false;
  const bindings = bindingsOf(ctx, name, at);
  return bindings.length > 0 && bindings.every((binding) => {
    if (binding.kind === 'prop-member') return true;
    if (binding.kind === 'param') return paramFilledWith(ctx, binding, depth, recordPropInput);
    if (binding.kind === 'alias') return recordPropInput(ctx, binding.expr, binding.at, depth + 1);
    if (binding.kind === 'member') return isPropsObject(ctx, binding.object, binding.at, depth + 1);
    return false;
  });
}

// The bounded member form is a named helper's explicit record input, e.g.
// `selectedAccount: { accountid: string }` supplied from the page's props. A local fabricated
// record, an opaque type alias or an arbitrary chain is not evidence that an ID came from an input.
function stringRecordMemberIsInput(mask, scopes, expr, at) {
  const member = /^([A-Za-z_$][\w$]*)\s*\.\s*([A-Za-z_$][\w$]*)$/.exec(expr.trim());
  if (!member) return false;
  const ctx = sourceContext(mask, scopes);
  // Conservatively refuse recognized writes anywhere on these value paths, including aliased
  // helpers declared later in the module. This is not an execution-order or general heap evaluator.
  if (recordValueWritten(ctx, member[1], at)) return false;
  const bindings = bindingsOf(ctx, member[1], at);
  return bindings.length > 0 && bindings.every((binding) => {
    if (binding.kind !== 'param') return false;
    const parameter = splitTopLevel(mask, binding.scope.paramsOpen, binding.scope.paramsEnd)[binding.index];
    const annotation = new RegExp(`^${escapeRe(member[1])}\\s*:\\s*(\\{[\\s\\S]*\\})$`).exec(parameter);
    if (!annotation) return false;
    try {
      // Flat inline type members use the same literal-name grammar as request objects. TypeScript
      // allows semicolons between members; no value/source code is evaluated to infer their types.
      if (objectFields(annotation[1].replace(/;/g, ',')).get(member[2]) !== 'string') return false;
    } catch { return false; }
    return paramFilledWith(ctx, binding, 0, recordPropInput);
  });
}

module.exports = { groupEnd, literalString, objectFields, actionCalls, receiverIsDataApi, stringRecordMemberIsInput, escapeRe };
