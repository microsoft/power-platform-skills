'use strict';
const { blankNonCodePreservingTemplateExpressions } = require('./source-literals.js');

// Pure STRUCTURAL resolver for generative-page cross-page navigation. Authors emit a link as a stable
// symbolic token — pageId: "PAGEREF_<key>" — because the real GenPageId is minted by the server at
// deploy time and differs per environment (SDK opaque-identity rule T5: never bake a resolved GUID into
// canonical source, or a cross-env recreate ships a dead link). See references/rules.md "Generative Page
// Navigation" and docs/app-builder-design.md §9. The ENGINE reads/writes files; this module
// only shapes/parses strings (pure, offline).
//
// THE SINGLE NAV ORACLE. `extractNavTargets` parses the ACTUAL
//   Xrm.Navigation.navigateTo({ pageType: 'generative', pageId: <value>, … })
// call sites and returns one classified entry per generative call site. Every other function here, and
// the build/verify/download consumers, derive from it — so a decoy "PAGEREF_x" string or a stray GUID
// in a comment/label (NOT a real nav pageId) can never satisfy parity, resolution, or verification.
// This replaces the earlier bare-token string scan, which a wrong-quoted or misplaced token could evade.
//
// COMMENT / LITERAL STRIPPING (#588): extractNavTargets scans a code-only mask
// BEFORE scanning for navigateTo call sites. Anything inside a // comment, /* */ block comment, quoted
// string, regex literal, JSX text, or template-literal TEXT is blanked (same-length space substitution,
// preserving all character offsets) so a navigateTo that appears as help text is invisible to NAV_CALL.
// JavaScript inside template `${...}` expressions remains visible because it is executable code.
//
// The call's OBJECT is parsed from that same mask, and each value is then read from the ORIGINAL
// source at the same offsets. The mask blanks a string's contents but keeps its quotes, so it can
// locate `pageType: "…"` and `pageId: "…"` but not say what they hold. One lexer drives both steps:
// a lighter second copy that knew no regexes read the `/*` inside
//   u.replace(/\/*$/, "")
// as a comment opener, blanked everything after it, and dropped every later call — so a literal
// "PAGEREF_detail" shipped unresolved while verification passed.

// A navigation call can be bare, a member call, optional (`navigateTo?.({ … })`), or spell the
// identifier through JavaScript Unicode escapes (`navigate\u0054o`). A regex cannot distinguish
// that identifier from a longer one such as `notnavigateTo`, `x\u0041navigateTo`, or a name using
// ZWNJ/ZWJ continuation characters, so call-site discovery tokenizes identifiers before checking
// for the object-literal argument.
const CANON = /^"PAGEREF_([A-Za-z0-9_-]+)"$/;  // canonical: double-quoted, both sides
const PAGEREF_ANY = /PAGEREF_([A-Za-z0-9_-]+)/; // a PAGEREF token in ANY form (used to detect malformed)
// Content must not span across unescaped quote chars — prevents matching a "foo"+"bar" concat
// as a single literal when the full expression is somehow presented as a raw string.
const QUOTED = /^(["'`])((?:[^"'`\\]|\\[\s\S])*)\1$/;

function isIdentifierStart(ch) {
  return ch === '$' || ch === '_' || /\p{ID_Start}/u.test(ch || '');
}

function isIdentifierContinue(ch) {
  return ch === '$' || ch === '_' || ch === '\u200c' || ch === '\u200d' || /\p{ID_Continue}/u.test(ch || '');
}

function readUnicodeEscape(src, i) {
  if (src[i] !== '\\' || src[i + 1] !== 'u') return null;
  if (src[i + 2] === '{') {
    const end = src.indexOf('}', i + 3);
    if (end === -1) return null;
    const hex = src.slice(i + 3, end);
    if (!/^[0-9A-Fa-f]{1,6}$/.test(hex)) return null;
    const cp = Number.parseInt(hex, 16);
    if (cp > 0x10ffff) return null;
    return { ch: String.fromCodePoint(cp), end: end + 1 };
  }
  const hex = src.slice(i + 2, i + 6);
  if (!/^[0-9A-Fa-f]{4}$/.test(hex)) return null;
  return { ch: String.fromCharCode(Number.parseInt(hex, 16)), end: i + 6 };
}

function readCodePoint(src, i) {
  const cp = src.codePointAt(i);
  if (cp === undefined) return null;
  return { ch: String.fromCodePoint(cp), end: i + (cp > 0xffff ? 2 : 1) };
}

function readIdentifier(src, i) {
  if (src[i] === '#') {
    const privateName = readIdentifier(src, i + 1);
    return privateName ? { name: `#${privateName.name}`, end: privateName.end } : null;
  }
  const firstEscape = readUnicodeEscape(src, i);
  const first = firstEscape || readCodePoint(src, i);
  if (!first || !isIdentifierStart(first.ch)) return null;
  let name = first.ch;
  let end = first.end;
  while (end < src.length) {
    const esc = readUnicodeEscape(src, end);
    const next = esc || readCodePoint(src, end);
    if (!next || !isIdentifierContinue(next.ch)) break;
    name += next.ch;
    end = next.end;
  }
  return { name, end };
}

function skipSpace(mask, i) {
  while (i < mask.length && /\s/.test(mask[i])) i += 1;
  return i;
}

function matchingBraces(mask) {
  const matches = new Map();
  const stack = [];
  for (let i = 0; i < mask.length; i += 1) {
    if (mask[i] === '{') stack.push(i);
    else if (mask[i] === '}' && stack.length) {
      const open = stack.pop();
      matches.set(open, i);
    }
  }
  return matches;
}

function navigationObjectOpenAt(mask, nameEnd) {
  let i = skipSpace(mask, nameEnd);
  if (mask[i] === '?' && mask[i + 1] === '.') i = skipSpace(mask, i + 2);
  if (mask[i] !== '(') return -1;
  i = skipSpace(mask, i + 1);
  return mask[i] === '{' ? i : -1;
}

function navigateCallObjectOpens(mask) {
  const opens = [];
  for (let i = 0; i < mask.length; i += 1) {
    const id = readIdentifier(mask, i);
    if (!id) continue;
    if (id.name === 'navigateTo') {
      const open = navigationObjectOpenAt(mask, id.end);
      if (open !== -1) opens.push(open);
    }
    i = Math.max(i, id.end - 1);
  }
  return opens;
}

// Read the object-literal argument of a navigateTo(...) call from the precomputed brace table. The
// mask has already blanked comments and literal bodies, so unmatched malformed calls are an O(1)
// miss instead of every candidate scanning to EOF.
function objectArgAt(code, open, braceMatches) {
  const close = braceMatches.get(open);
  return close === undefined ? null : { text: code.slice(open, close + 1), end: close + 1 };
}

// Read the VALUE of the last effective TOP-LEVEL `key` in an object-literal text. Object
// literals are last-write-wins at runtime, including methods, accessors and shorthand properties:
//   { pageId: "PAGEREF_detail", get pageId() { return "runtime"; } }
//   { pageType: "generative", pageType() { return "entityrecord"; } }
// Later computed keys and spreads can also overwrite either property, so a literal before them is
// classified dynamic; a literal after them wins again by normal object order.
function topLevelValue(objText, key, sourceObjText = objText) {
  const scanStringEnd = (from) => {
    const q = objText[from];
    for (let k = from + 1; k < objText.length; k += 1) {
      if (objText[k] === '\\') { k += 1; continue; }
      if (objText[k] === q) return k + 1;
    }
    return null;
  };
  const decodeQuotedKey = (from, to) => {
    const quote = sourceObjText[from];
    if (quote !== '"' && quote !== "'" || sourceObjText[to - 1] !== quote) return null;
    let value = '';
    for (let i = from + 1; i < to - 1; i += 1) {
      const c = sourceObjText[i];
      if (c !== '\\') { value += c; continue; }
      i += 1;
      if (i >= to - 1) return null;
      const e = sourceObjText[i];
      if (e === '\r' && sourceObjText[i + 1] === '\n') { i += 1; continue; }
      if (e === '\n' || e === '\r' || e === '\u2028' || e === '\u2029') continue;
      if (e === 'u') {
        if (sourceObjText[i + 1] === '{') {
          const close = sourceObjText.indexOf('}', i + 2);
          if (close === -1 || close >= to - 1) return null;
          const hex = sourceObjText.slice(i + 2, close);
          if (!/^[0-9A-Fa-f]{1,6}$/.test(hex)) return null;
          const cp = Number.parseInt(hex, 16);
          if (cp > 0x10ffff) return null;
          value += String.fromCodePoint(cp);
          i = close;
          continue;
        }
        const hex = sourceObjText.slice(i + 1, i + 5);
        if (!/^[0-9A-Fa-f]{4}$/.test(hex)) return null;
        value += String.fromCharCode(Number.parseInt(hex, 16));
        i += 4;
        continue;
      }
      if (e === 'x') {
        const hex = sourceObjText.slice(i + 1, i + 3);
        if (!/^[0-9A-Fa-f]{2}$/.test(hex)) return null;
        value += String.fromCharCode(Number.parseInt(hex, 16));
        i += 2;
        continue;
      }
      if (e === '0') { value += '\0'; continue; }
      const simple = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', "'": "'", '"': '"', '\\': '\\' };
      value += Object.prototype.hasOwnProperty.call(simple, e) ? simple[e] : e;
    }
    return value;
  };
  const readValue = (colonEnd) => {
    let j = skipSpace(objText, colonEnd);
    const q = objText[j];
    if (q === '"' || q === "'" || q === '`') {
      const end = scanStringEnd(j) || objText.length;
      let kk = skipSpace(objText, end);
      if (!(kk < objText.length && objText[kk] === '+')) {
        return { raw: objText.slice(j, end), valueStart: j, valueEnd: end };
      }
    }
    let depth = 0;
    let inStr = null;
    let k = j;
    for (; k < objText.length; k += 1) {
      const cc = objText[k];
      if (inStr) {
        if (cc === '\\') { k += 1; continue; }
        if (cc === inStr) inStr = null;
        continue;
      }
      if (cc === '"' || cc === "'" || cc === '`') { inStr = cc; continue; }
      if (cc === '{' || cc === '[' || cc === '(') depth += 1;
      else if (cc === '}' || cc === ']' || cc === ')') { if (depth === 0) break; depth -= 1; }
      else if (cc === ',' && depth === 0) break;
    }
    return { raw: objText.slice(j, k).trim(), valueStart: j, valueEnd: k };
  };
  const readPropertyName = (i) => {
    const c = objText[i];
    if (c === '"' || c === "'") {
      const end = scanStringEnd(i);
      if (end === null) return null;
      return { name: decodeQuotedKey(i, end), end, quoted: true };
    }
    // From the MASK, like every other structural read: a comment is blank there, so a word inside one —
    // `/* keep pageId */` — never reads as a property. Read from the source, it was taken for a later
    // `pageId` and the call's real literal for an override.
    const id = readIdentifier(objText, i);
    return id ? { name: id.name, end: id.end, quoted: false } : null;
  };
  const skipBalancedGroup = (i, open, close) => {
    let depth = 0;
    let inStr = null;
    for (let k = i; k < objText.length; k += 1) {
      const c = objText[k];
      if (inStr) {
        if (c === '\\') { k += 1; continue; }
        if (c === inStr) inStr = null;
        continue;
      }
      if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
      if (c === open) depth += 1;
      else if (c === close && --depth === 0) return k + 1;
    }
    return objText.length;
  };
  let depth = 0;
  let inStr = null;
  let lastMatch = null;
  const markRuntimeOverride = () => { if (lastMatch) lastMatch.hasRuntimeOverrideAfter = true; };
  const applyRuntimeProperty = (name) => { if (name === key) markRuntimeOverride(); };
  // The offset of the last non-blank character before each offset (-1 for none), computed in one pass.
  // Scanning back from every offset instead made a long comment — blank in the mask — quadratic: a
  // 16,000-character comment inside one call took about 19 seconds.
  const prevNonBlank = new Int32Array(objText.length);
  for (let i = 0, last = -1; i < objText.length; i += 1) {
    prevNonBlank[i] = last;
    if (!/\s/.test(objText[i])) last = i;
  }
  for (let i = 0; i < objText.length; i += 1) {
    const c = objText[i];
    if (inStr) { if (c === '\\') { i += 1; continue; } if (c === inStr) inStr = null; continue; }
    if (depth === 1) {
      const p = prevNonBlank[i];
      const atBoundary = p < 0 || objText[p] === '{' || objText[p] === ',';
      if (atBoundary) {
        if (c === '.' && objText[i + 1] === '.' && objText[i + 2] === '.') { markRuntimeOverride(); i += 2; continue; }
        if (c === '[') { markRuntimeOverride(); i = skipBalancedGroup(i, '[', ']') - 1; continue; }

        let k = i;
        let modifier = null;
        if (objText[k] === '*') k = skipSpace(objText, k + 1);
        if (objText[k] === '[') { markRuntimeOverride(); i = skipBalancedGroup(k, '[', ']') - 1; continue; }
        let first = readPropertyName(k);
        if (first) {
          if ((first.name === 'get' || first.name === 'set' || first.name === 'async') && !first.quoted) {
            modifier = first.name;
            k = skipSpace(objText, first.end);
            if (objText[k] === '*') k = skipSpace(objText, k + 1);
            if (objText[k] === '[') { markRuntimeOverride(); i = skipBalancedGroup(k, '[', ']') - 1; continue; }
            first = readPropertyName(k);
            if (!first) continue;
          }
          const prop = first;
          k = skipSpace(objText, prop.end);
          if (objText[k] === ':') {
            const value = readValue(k + 1);
            if (prop.name === key) lastMatch = value;
            i = value.valueEnd - 1;
            continue;
          }
          if (objText[k] === '(') {
            applyRuntimeProperty(prop.name);
            i = skipBalancedGroup(k, '(', ')') - 1;
            continue;
          }
          if (!modifier) applyRuntimeProperty(prop.name);
        }
      }
    }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
    if (c === '{' || c === '[' || c === '(') { depth += 1; continue; }
    if (c === '}' || c === ']' || c === ')') { depth -= 1; continue; }
  }
  return lastMatch;
}

// Parse every generative navigateTo(...) call site into a classified pageId descriptor (see the module
// header). Spans are ABSOLUTE offsets into `code` so resolve/reverse can rewrite precisely and never
// partial-collide. Only pageType:'generative' string-literal call sites are returned — a non-generative
// or dynamic pageType is not a cross-page genpage navigation.
//
// Code-mask scanning (#588): call sites are found in a mask that blanks inert strings/comments/JSX
// text/template text but preserves executable template expressions. The object is parsed from the
// same mask (string bodies blanked, quotes kept) and every value is read from the original source at
// the span the mask gives. Both strings are the same length, so every span maps 1:1.
function extractNavTargets(code) {
  const src = String(code || '');
  const callSites = blankNonCodePreservingTemplateExpressions(src);
  const out = [];
  const braceMatches = matchingBraces(callSites);
  for (const open of navigateCallObjectOpens(callSites)) {
    const obj = objectArgAt(callSites, open, braceMatches);
    if (!obj) continue;
    // pv.valueStart / pv.valueEnd are relative to obj.text, which starts at `open`; adding `open`
    // makes them absolute offsets into the mask and, equally, into the original source.
    const valueAt = (v) => src.slice(open + v.valueStart, open + v.valueEnd).trim();
    const sourceObjText = src.slice(open, obj.end);
    const pt = topLevelValue(obj.text, 'pageType', sourceObjText);
    const ptQ = pt && QUOTED.exec(valueAt(pt));
    if (!ptQ || ptQ[2] !== 'generative') continue;
    const pv = topLevelValue(obj.text, 'pageId', sourceObjText);
    if (!pv) continue;
    const valueStart = open + pv.valueStart;
    const valueEnd = open + pv.valueEnd;
    // Classify from the ORIGINAL source span: the mask blanks every string body, so a backtick-quoted
    // `PAGEREF_x` is found (and classified as pageref-malformed) only in `src`.
    const rawOrig = valueAt(pv);
    if (pt.hasRuntimeOverrideAfter || pv.hasRuntimeOverrideAfter) {
      out.push({ kind: 'dynamic', raw: rawOrig, valueStart, valueEnd });
      continue;
    }
    const canon = CANON.exec(rawOrig);
    if (canon) { out.push({ kind: 'pageref', key: canon[1], valueStart, valueEnd }); continue; }
    // A PAGEREF token in any non-canonical form is malformed (single/back-tick quoted, concatenated)
    // — the resolver can only substitute the canonical double-quoted token, so a malformed one
    // would ship UNRESOLVED — which is why the build halts on one (navMalformedRefs).
    const anyRef = PAGEREF_ANY.exec(rawOrig);
    if (anyRef) { out.push({ kind: 'pageref-malformed', key: anyRef[1], raw: rawOrig, valueStart, valueEnd }); continue; }
    const quoted = QUOTED.exec(rawOrig);
    if (quoted) { out.push({ kind: 'literal', pageId: quoted[2], quote: quoted[1], valueStart, valueEnd }); continue; }
    out.push({ kind: 'dynamic', raw: rawOrig, valueStart, valueEnd });
  }
  return out;
}

// Sorted-unique keys referenced by a CANONICAL nav pageref (the parity input). Derived from the
// oracle, so only real nav call sites count — a decoy PAGEREF_ string is never included.
function navReferencedKeys(code) {
  const keys = new Set();
  for (const t of extractNavTargets(code)) if (t.kind === 'pageref') keys.add(t.key);
  return [...keys].sort();
}

// Sorted-unique PAGEREF tokens used as a nav pageId in a MALFORMED form. The build HALTs on any:
// the resolver substitutes only the canonical double-quoted token, so a malformed ref would
// deploy a dead link. Derived from the oracle, so a malformed PAGEREF that is NOT a nav pageId is
// ignored.
function navMalformedRefs(code) {
  const bad = new Set();
  for (const t of extractNavTargets(code)) if (t.kind === 'pageref-malformed') bad.add(`PAGEREF_${t.key}`);
  return [...bad].sort();
}

// Resolve every source's CANONICAL nav pageref to a quoted GenPageId, structurally (span-based,
// applied right-to-left so earlier spans stay valid). Returns the resolved copies plus the
// sorted-unique referenced keys that had NO id (dangling nav targets), left verbatim so the caller
// can HALT fail-closed.
function resolvePageRefs(sources, keyToId) {
  const deployment = new Map();
  const unresolved = new Set();
  for (const [key, entry] of sources) {
    const code = entry && typeof entry.code === 'string' ? entry.code : '';
    const targets = extractNavTargets(code).filter((t) => t.kind === 'pageref');
    let out = code;
    // Process right-to-left so replacing a later span does not shift the positions of earlier spans.
    for (let i = targets.length - 1; i >= 0; i -= 1) {
      const t = targets[i];
      if (keyToId.has(t.key)) {
        out = out.slice(0, t.valueStart) + JSON.stringify(String(keyToId.get(t.key))) + out.slice(t.valueEnd);
      } else {
        unresolved.add(t.key);
      }
    }
    deployment.set(key, out);
  }
  return { deployment, unresolved: [...unresolved].sort() };
}

// Download inverse: rewrite each nav pageId LITERAL whose value is a known deployed id back to its
// symbolic "PAGEREF_<key>". Structural (via the oracle) + span-based, so it NEVER touches a
// recordId, a data value, or a GUID in a comment — only an actual navigation pageId. Dataverse may
// echo the GUID upper- or lower-cased, so match case-insensitively.
function reverseResolveNavIds(code, idToKey) {
  const byLower = new Map([...(idToKey || new Map())].map(([id, key]) => [String(id).toLowerCase(), key]));
  const s = String(code || '');
  const targets = extractNavTargets(s).filter((t) => t.kind === 'literal' && byLower.has(String(t.pageId).toLowerCase()));
  let out = s;
  // Process right-to-left so replacing a later span does not shift earlier span positions.
  for (let i = targets.length - 1; i >= 0; i -= 1) {
    const t = targets[i];
    out = out.slice(0, t.valueStart) + `"PAGEREF_${byLower.get(String(t.pageId).toLowerCase())}"` + out.slice(t.valueEnd);
  }
  return out;
}

// Pure exact-parity between a page's DECLARED navigatesTo targetKeys and the keys its source
// actually references via canonical nav pagerefs. Exact parity is required: a declared edge
// missing from the source, or a source ref with no declaration, is an authoring error the caller
// HALTs on before deploy.
function navTargetParity(declaredKeys, referencedKeysList) {
  const d = new Set((declaredKeys || []).map(String));
  const r = new Set((referencedKeysList || []).map(String));
  return {
    declaredNotReferenced: [...d].filter((k) => !r.has(k)).sort(),
    referencedNotDeclared: [...r].filter((k) => !d.has(k)).sort(),
  };
}

module.exports = { extractNavTargets, navReferencedKeys, navMalformedRefs, resolvePageRefs, reverseResolveNavIds, navTargetParity };
