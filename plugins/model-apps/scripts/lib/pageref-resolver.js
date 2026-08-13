'use strict';
// Pure STRUCTURAL resolver for generative-page cross-page navigation. Authors emit a link as a stable
// symbolic token — pageId: "PAGEREF_<key>" — because the real GenPageId is minted by the server at
// deploy time and differs per environment (SDK opaque-identity rule T5: never bake a resolved GUID into
// canonical source, or a cross-env recreate ships a dead link). See references/rules.md "Generative Page
// Navigation" and docs/app-builder-staged-flow-design.md §9. The ENGINE reads/writes files; this module
// only shapes/parses strings (pure, offline).
//
// THE SINGLE NAV ORACLE. `extractNavTargets` parses the ACTUAL
//   Xrm.Navigation.navigateTo({ pageType: 'generative', pageId: <value>, … })
// call sites and returns one classified entry per generative call site. Every other function here, and
// the build/verify/download consumers, derive from it — so a decoy "PAGEREF_x" string or a stray GUID
// in a comment/label (NOT a real nav pageId) can never satisfy parity, resolution, or verification.
// This replaces the earlier bare-token string scan, which a wrong-quoted or misplaced token could evade
// (review R2, Critical 1/C4).
//
// COMMENT / TEMPLATE-LITERAL STRIPPING (addendum Crit 1): extractNavTargets calls stripNonCode()
// BEFORE scanning for navigateTo call sites. Anything inside a // comment, /* */ block comment, or
// backtick template literal is blanked (same-length space substitution, preserving all character
// offsets) so a navigateTo that appears as comment text or template-literal content is invisible to the
// NAV_CALL regex and is therefore NEVER counted as a real call site.

// `navigateTo(` immediately followed by an object literal `{`. `\s*` tolerates the multi-line form in
// references/rules.md. The method-name prefix (Xrm.Navigation./xrm.Navigation.) is irrelevant to the
// match, so any call spelled `navigateTo({ … })` is covered.
const NAV_CALL = /navigateTo\s*\(\s*\{/g;
const CANON = /^"PAGEREF_([A-Za-z0-9_-]+)"$/;  // canonical: double-quoted, both sides
const PAGEREF_ANY = /PAGEREF_([A-Za-z0-9_-]+)/; // a PAGEREF token in ANY form (used to detect malformed)
// Content must not span across unescaped quote chars — prevents matching a "foo"+"bar" concat
// as a single literal when the full expression is somehow presented as a raw string.
const QUOTED = /^(["'`])((?:[^"'`\\]|\\[\s\S])*)\1$/;

// Replace the body of line comments (//), block comments (/* ... */), and backtick template literals
// — including any ${...} expressions inside them — with ASCII space characters. Every character offset
// in the returned string is identical to the same offset in the input, so `valueStart`/`valueEnd`
// spans extracted from the cleaned string are also valid in the original source.
//
// Why spaces (not empty or shorter substitution): NAV_CALL.exec() and objectArgAt/topLevelValue use
// raw offset arithmetic; replacing with equal-length spaces keeps every span valid in both strings.
//
// Why blank backtick template-literal BODIES (but KEEP the backtick delimiters): we want a
// navigateTo that appears as TEMPLATE LITERAL TEXT to be invisible to the scanner — blanking
// the body achieves this. Keeping the delimiter backtick characters means objectArgAt /
// topLevelValue correctly detect a backtick-QUOTED VALUE (their `inStr` branches already
// handle backtick as a string delimiter), so a nav pageId written as `PAGEREF_x` is
// classified as pageref-malformed instead of falling through to `dynamic` (which would
// silently bypass the malformed-HALT gate — security finding C4).
//
// Template ${} expressions: we track { } depth to correctly identify when a ${...} expression ends.
// We do NOT track strings-inside-${} (e.g. a `}` inside a "string" inside `${}` would decrement
// depth early). This is a known conservative trade-off — a navigateTo call inside a ${} expression
// of a template literal is an extreme edge case, and blanking it conservatively is the right
// fail-closed choice.
function stripNonCode(code) {
  const out = [...code];
  let i = 0;
  while (i < code.length) {
    const c = code[i];
    if (c === '/' && i + 1 < code.length && code[i + 1] === '/') {
      // Line comment: blank from // to end of line; preserve the newline itself so line
      // numbers (and thus any diagnostics referencing them) are not shifted.
      while (i < code.length && code[i] !== '\n') { out[i] = ' '; i++; }
    } else if (c === '/' && i + 1 < code.length && code[i + 1] === '*') {
      // Block comment: blank from /* to */ inclusive.
      out[i] = ' '; out[i + 1] = ' '; i += 2;
      while (i < code.length) {
        if (code[i] === '*' && i + 1 < code.length && code[i + 1] === '/') {
          out[i] = ' '; out[i + 1] = ' '; i += 2; break;
        }
        out[i] = ' '; i++;
      }
    } else if (c === '`') {
      // Template literal: keep the opening backtick delimiter, blank the body content, keep the
      // closing backtick delimiter. The body content (and any ${...} expressions) are blanked so
      // a navigateTo inside template text is invisible to NAV_CALL. The delimiters are preserved
      // so objectArgAt / topLevelValue can detect a backtick-QUOTED pageId VALUE via their inStr
      // branch (see the "Why" comment above). Track { } depth to correctly span ${...} expressions.
      i++;   // advance past the opening backtick — leave it unchanged in `out`
      let depth = 0;
      while (i < code.length) {
        const cc = code[i];
        if (cc === '\\') {
          // Escape sequence: blank both the backslash and the escaped character.
          out[i] = ' ';
          if (i + 1 < code.length) { out[i + 1] = ' '; i += 2; } else i++;
          continue;
        }
        if (depth === 0 && cc === '$' && i + 1 < code.length && code[i + 1] === '{') {
          // Start of a ${} expression: blank both characters and increment depth.
          out[i] = ' '; out[i + 1] = ' '; i += 2; depth++; continue;
        }
        if (depth > 0 && cc === '{') { out[i] = ' '; i++; depth++; continue; }
        if (depth > 0 && cc === '}') { out[i] = ' '; i++; depth--; continue; }
        if (depth === 0 && cc === '`') {
          // Closing backtick of the template literal — leave it unchanged in `out`, then stop.
          i++; break;
        }
        out[i] = ' '; i++;
      }
    } else if (c === '"' || c === "'") {
      // Regular string: skip over it WITHOUT blanking — objectArgAt and topLevelValue need the
      // string contents intact to correctly identify key/value boundaries inside navigateTo({...}).
      i++;
      while (i < code.length) {
        if (code[i] === '\\') { i += 2; continue; }
        if (code[i] === c) { i++; break; }
        i++;
      }
    } else {
      i++;
    }
  }
  return out.join('');
}

// Scan the object-literal argument of a navigateTo(...) call from the '{' at `open` to its matching
// '}', string-aware so a brace inside a string does not end the object. Returns { text, end } or null
// on an unbalanced/broken literal (the caller treats a broken call as having no nav target).
function objectArgAt(code, open) {
  let depth = 0;
  let inStr = null;
  for (let i = open; i < code.length; i += 1) {
    const c = code[i];
    if (inStr) { if (c === '\\') { i += 1; continue; } if (c === inStr) inStr = null; continue; }
    // inStr handles backtick-quoted values (delimiters kept by stripNonCode) so their blanked body
    // doesn't count as unbalanced braces when scanning the object boundary.
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
    // inStr handles backtick-quoted values (delimiters kept by stripNonCode) so their blanked body
    // is not misread as key or bracket content when scanning for the target key.
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
// Comment/template stripping (addendum Crit 1): stripNonCode() is called FIRST; the returned cleaned
// string is used for ALL parsing, so a navigateTo that appears inside a // comment, /* */ block
// comment, or backtick template literal is not matched. Spans in the cleaned string are identical to
// spans in the original because stripping replaces characters with same-length spaces.
function extractNavTargets(code) {
  const src = String(code || '');
  const s = stripNonCode(src);
  const out = [];
  NAV_CALL.lastIndex = 0;
  let m;
  while ((m = NAV_CALL.exec(s)) !== null) {
    const open = m.index + m[0].length - 1; // index of the '{' that opens the object argument
    const obj = objectArgAt(s, open);
    if (!obj) continue;
    const pt = topLevelValue(obj.text, 'pageType');
    const ptQ = pt && QUOTED.exec(pt.raw);
    if (!ptQ || ptQ[2] !== 'generative') continue;
    const pv = topLevelValue(obj.text, 'pageId');
    if (!pv) continue;
    // pv.valueStart / pv.valueEnd are relative to obj.text which starts at `open` in s.
    // Adding `open` makes them absolute offsets into s (and equally into the original code,
    // since stripNonCode replaces with equal-length spaces — offsets are always identical in both).
    const valueStart = open + pv.valueStart;
    const valueEnd = open + pv.valueEnd;
    // Classify from the ORIGINAL source span (not the stripped text): backtick-quoted values have
    // their bodies blanked in `s`, so `pv.raw` from `s` is `\`   \`` (spaces) and PAGEREF_ANY would
    // miss the token. Using `src` at the same offsets recovers the original content (e.g. `\`PAGEREF_x\``)
    // so the token is found and classified as pageref-malformed instead of silently falling to `dynamic`.
    const rawOrig = src.slice(valueStart, valueEnd).trim();
    const canon = CANON.exec(rawOrig);
    if (canon) { out.push({ kind: 'pageref', key: canon[1], valueStart, valueEnd }); continue; }
    // A PAGEREF token in any non-canonical form is malformed (single/back-tick quoted, concatenated)
    // — the resolver can only substitute the canonical double-quoted token, so a malformed one
    // would ship UNRESOLVED. See C4.
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

// Sorted-unique PAGEREF tokens used as a nav pageId in a MALFORMED form. The build HALTs on any
// (C4): the resolver substitutes only the canonical double-quoted token, so a malformed ref would
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
// actually references via canonical nav pagerefs. Exact parity is required (C4): a declared edge
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

module.exports = { extractNavTargets, navReferencedKeys, navMalformedRefs, resolvePageRefs, reverseResolveNavIds, navTargetParity, stripNonCode };
