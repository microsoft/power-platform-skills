// plugins/model-apps/scripts/lib/nearest-name.js
// Shared "did you mean" matcher for closed vocabularies (CLI flag names, FetchXML operators).
'use strict';

/**
 * Returns the entry of `known` closest to `name`, or null when nothing is within one edit.
 *
 * An exact (case-insensitive) match wins outright, so a caller can use this both to canonicalize a
 * name it already accepts and to suggest a correction for one it does not.
 *
 * The distance bound is a single edit, deliberately, and not full Levenshtein. The only suggestion
 * worth making is a one-character slip — `--stagee` for `--stage`, `eq-businesid` for
 * `eq-businessid`. At two edits the nearest entry is about as likely to be the wrong one as the
 * right one, and a wrong suggestion is worse than none: it sends the reader to a flag or operator
 * that silently does something else.
 *
 * @param {string} name   the name the user actually typed
 * @param {Iterable<string>} known  the accepted vocabulary, in lower case
 * @returns {string|null}
 */
function nearestName(name, known) {
  const lower = String(name).toLowerCase();
  for (const k of known) if (k === lower) return k;
  for (const k of known) {
    // A single edit can change a length by at most one, so anything further apart cannot match and
    // does not need the walk below.
    if (Math.abs(k.length - lower.length) > 1) continue;
    // Walk both strings once, allowing a single edit (substitution when the lengths are equal,
    // otherwise an insertion into whichever string is shorter).
    let i = 0, j = 0, edits = 0;
    while (i < k.length && j < lower.length) {
      if (k[i] === lower[j]) { i++; j++; continue; }
      if (++edits > 1) break;
      if (k.length > lower.length) i++;
      else if (k.length < lower.length) j++;
      else { i++; j++; }
    }
    // Whatever is left unconsumed on either side counts against the same single-edit budget.
    if (edits + (k.length - i) + (lower.length - j) <= 1) return k;
  }
  return null;
}

module.exports = { nearestName };
