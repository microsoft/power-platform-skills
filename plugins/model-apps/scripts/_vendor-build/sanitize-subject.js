/* Strip merge-tool prefixes from an upstream commit subject before it is recorded in
 * vendor/PROVENANCE.json.
 *
 * The SDK's history is squash-merged by a server-side tool that prepends its own PR id, e.g.
 *   "Merged PR 12345678: feat(cds-maker-sdk): configurable authoring LCID, command bind fixes"
 *   "Merge pull request #4312 from someone/some-branch"
 * (Both example ids here are synthetic. Quoting a real one would reintroduce exactly the identifier
 * this function exists to remove.)
 *
 * That id is unresolvable from THIS repository, and PROVENANCE.json is committed to a public one,
 * so the prefix is noise that also advertises a tracker nobody reading it can open. The part that
 * carries the "why" is the description after the prefix, so keep exactly that. The upstream SHA is
 * recorded separately and is the field that actually identifies the source.
 *
 * CONTRACT: the return value must NEVER match one of the prefix patterns below. That is stronger
 * than "strip a prefix" and is the property the committed-provenance test asserts. An earlier
 * version broke it — when stripping consumed the whole subject it returned the ORIGINAL, putting
 * the identifier straight back and emitting a value that failed that very test.
 *
 * Lives in its own module rather than inside build.js so it can be unit-tested: build.js is a CLI
 * that resolves its --sdk argument and calls process.exit at load time, so requiring it from a test
 * would terminate the test runner.
 */

// Only a LEADING, well-formed prefix is removed. Anchoring matters: a subject that merely mentions
// "merged PR 42" mid-sentence is prose, not a tool prefix, and must survive untouched.
//
// Each pattern ends with `(?::\s*|$)` — a colon OR end-of-string. Requiring the colon left a hole:
// `"Merged PR 123"` (prefix, no description, no colon) was returned UNCHANGED, and the property test
// could not see it because that test uses these same patterns as its oracle. Matching end-of-string
// too means a bare prefix is recognized and replaced by the placeholder.
//
// The alternation does NOT weaken the prose guard: `"Merged PR 99 rollback"` still fails to match,
// because after the digits the next thing must be a colon or the end, and `rollback` is neither.
const MERGE_PREFIXES = [
  // Azure DevOps / TFS squash-merge subject. `#` is optional: not every tool emits it.
  /^\s*Merged\s+PR\s+#?\d+\s*(?::\s*|$)/i,
  // GitHub merge-commit subject. `#` is optional for the same reason.
  //
  // The branch ref is `[^:\s]+`, NOT `\S+`. A greedy `\S+` swallows any colon in the ref AND the
  // one that ends it, so "…from owner/ref:fix(sdk): tolerate x" sanitized to just "tolerate x" —
  // silently deleting the part of the description that says what changed.
  /^\s*Merge\s+pull\s+request\s+#?\d+\s+from\s+[^:\s]+\s*(?::\s*|$)/i,
];

// Returned when a recognized prefix consumed the entire subject (GitHub puts the description on the
// body line, so a bare merge subject is all prefix). A neutral, resolvable-by-nobody string is the
// honest answer: it satisfies the contract above, and unlike an empty string it does not read as
// "provenance could not be determined", which is a different and more alarming claim.
const NO_DESCRIPTION = '(merge commit; upstream subject carried no description)';

function sanitizeSubject(subject) {
  if (typeof subject !== 'string') return subject;
  let out = subject;
  let matched = false;
  // Strip to a FIXED POINT, not a fixed NUMBER of passes. A single anchored `replace` removes one
  // prefix, so a merge of a merge kept the rest and returned a value that still matched a pattern.
  //
  // An earlier attempt capped this at 8 passes, which was worse than useless: it looked defensive
  // while silently reintroducing the same bug for any subject with 9 or more nested prefixes. The
  // cap is gone because the loop provably terminates without one — every pattern above must match at
  // least the literal `Merged PR` / `Merge pull request` plus a digit, so a successful replacement
  // strictly shortens the string and no pattern can match empty. `out === before` is therefore
  // reached in at most `subject.length + 1` passes (the +1 is the final unchanged pass that breaks).
  for (;;) {
    const before = out;
    for (const re of MERGE_PREFIXES) {
      if (re.test(out)) { matched = true; out = out.replace(re, ''); }
    }
    if (out === before) break;
  }
  out = out.trim();
  if (out) return out;
  return matched ? NO_DESCRIPTION : subject.trim();
}

module.exports = { sanitizeSubject, MERGE_PREFIXES, NO_DESCRIPTION };
