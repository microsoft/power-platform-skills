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

// `navigateTo(` immediately followed by an object literal `{`. `\s*` tolerates the multi-line form in
// references/rules.md. The method-name prefix (Xrm.Navigation./xrm.Navigation.) is irrelevant to the
// match, so any call spelled `navigateTo({ … })` is covered.
const NAV_CALL = /navigateTo\s*\(\s*\{/g;
const CANON = /^"PAGEREF_([A-Za-z0-9_-]+)"$/;  // canonical: double-quoted, both sides
const PAGEREF_ANY = /PAGEREF_([A-Za-z0-9_-]+)/; // a PAGEREF token in ANY form (used to detect malformed)
// Content must not span across unescaped quote chars — prevents matching a "foo"+"bar" concat
// as a single literal when the full expression is somehow presented as a raw string.
const QUOTED = /^(["'`])((?:[^"'`\\]|\\[\s\S])*)\1$/;

// Scan the object-literal argument of a navigateTo(...) call from the '{' at `open` to its matching
// '}', string-aware so a brace inside a string does not end the object. Returns { text, end } or null
// on an unbalanced/broken literal (the caller treats a broken call as having no nav target).
function objectArgAt(code, open) {
  let depth = 0;
  let inStr = null;
  for (let i = open; i < code.length; i += 1) {
    const c = code[i];
    if (inStr) { if (c === '\\') { i += 1; continue; } if (c === inStr) inStr = null; continue; }
    // inStr handles quoted values — the mask keeps their delimiters and blanks their bodies — so a
    // quote or brace in a value never counts toward the object boundary.
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
    if (c === '{') depth += 1;
    else if (c === '}') { depth -= 1; if (depth === 0) return { text: code.slice(open, i + 1), end: i + 1 }; }
  }
  return null;
}

// Read the VALUE of a TOP-LEVEL `key:` in an object-literal text (depth 1 only — never a key inside a
// nested data:{}/pageInput:{}). `objText` begins with '{'. Returns { raw, valueStart, valueEnd } (span
// relative to objText) or null when the key is absent at the top level. A quoted value captures the
// whole string literal (escape-aware); an unquoted value (or a quoted string followed by '+', which
// indicates a concat expression) runs to the next top-level ',' or the closing '}'. The char-before
// check rejects a false hit inside a longer identifier (e.g. `myPageId`).
function topLevelValue(objText, key) {
  let depth = 0;
  let inStr = null;
  // `key` is always a code-controlled literal ('pageType' or 'pageId'), never user-supplied,
  // so no regex-escape is needed before interpolating into the pattern.
  const keyRe = new RegExp('^' + key + '\\s*:');
  for (let i = 0; i < objText.length; i += 1) {
    const c = objText[i];
    if (inStr) { if (c === '\\') { i += 1; continue; } if (c === inStr) inStr = null; continue; }
    // inStr handles quoted values (delimiters kept, bodies blanked by the mask) so a value is never
    // misread as key or bracket content when scanning for the target key.
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
    if (c === '{' || c === '[' || c === '(') { depth += 1; continue; }
    if (c === '}' || c === ']' || c === ')') { depth -= 1; continue; }
    if (depth !== 1 || c !== key[0]) continue;
    if (!keyRe.test(objText.slice(i))) continue;
    // Reject a false hit inside a longer identifier (e.g. the "p" of "myPageId" — c is 'p'
    // but the character before the match in objText must be a key-boundary: '{', ',', or whitespace).
    const before = objText[i - 1];
    if (before !== undefined && !/[{,\s]/.test(before)) continue;
    let j = i + keyRe.exec(objText.slice(i))[0].length;
    while (j < objText.length && /\s/.test(objText[j])) j += 1;
    const q = objText[j];
    if (q === '"' || q === "'" || q === '`') {
      // Quoted value: scan to the matching closing quote, respecting escape sequences.
      let k = j + 1;
      for (; k < objText.length; k += 1) { if (objText[k] === '\\') { k += 1; continue; } if (objText[k] === q) { k += 1; break; } }
      // If the quoted string is followed (after optional whitespace) by '+', it is a concat
      // expression — fall through to unquoted scanning to capture the full span, so the
      // tightened QUOTED regex correctly classifies it as `dynamic` rather than `literal`.
      let kk = k;
      while (kk < objText.length && /\s/.test(objText[kk])) kk++;
      if (!(kk < objText.length && objText[kk] === '+')) {
        return { raw: objText.slice(j, k), valueStart: j, valueEnd: k };
      }
      // Falls through to the unquoted scanning below.
    }
    // Unquoted value (variable, function call, concat expression, etc.): scan to the next
    // top-level ',' or '}'.
    let d2 = 0;
    let k = j;
    for (; k < objText.length; k += 1) {
      const cc = objText[k];
      if (cc === '{' || cc === '[' || cc === '(') d2 += 1;
      else if (cc === '}' || cc === ']' || cc === ')') { if (d2 === 0) break; d2 -= 1; }
      else if (cc === ',' && d2 === 0) break;
    }
    return { raw: objText.slice(j, k).trim(), valueStart: j, valueEnd: k };
  }
  return null;
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
  NAV_CALL.lastIndex = 0;
  let m;
  while ((m = NAV_CALL.exec(callSites)) !== null) {
    const open = m.index + m[0].length - 1; // index of the '{' that opens the object argument
    const obj = objectArgAt(callSites, open);
    if (!obj) continue;
    // pv.valueStart / pv.valueEnd are relative to obj.text, which starts at `open`; adding `open`
    // makes them absolute offsets into the mask and, equally, into the original source.
    const valueAt = (v) => src.slice(open + v.valueStart, open + v.valueEnd).trim();
    const pt = topLevelValue(obj.text, 'pageType');
    const ptQ = pt && QUOTED.exec(valueAt(pt));
    if (!ptQ || ptQ[2] !== 'generative') continue;
    const pv = topLevelValue(obj.text, 'pageId');
    if (!pv) continue;
    const valueStart = open + pv.valueStart;
    const valueEnd = open + pv.valueEnd;
    // Classify from the ORIGINAL source span: the mask blanks every string body, so a backtick-quoted
    // `PAGEREF_x` is found (and classified as pageref-malformed) only in `src`.
    const rawOrig = valueAt(pv);
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
