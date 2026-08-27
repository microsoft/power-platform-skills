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
const MERGE_PREFIXES = [
  // Azure DevOps / TFS squash-merge subject. `#` is optional: not every tool emits it.
  /^\s*Merged\s+PR\s+#?\d+\s*:\s*/i,
  // GitHub merge-commit subject. `#` is optional for the same reason.
  //
  // The branch ref is `[^:\s]+`, NOT `\S+`. A greedy `\S+` swallows any colon in the ref AND the
  // one that ends it, so "…from owner/ref:fix(sdk): tolerate x" sanitized to just "tolerate x" —
  // silently deleting the part of the description that says what changed.
  /^\s*Merge\s+pull\s+request\s+#?\d+\s+from\s+[^:\s]+\s*:?\s*/i,
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
  // Strip to a FIXED POINT, not once. A single anchored `replace` removes one prefix, so a merge of
  // a merge ("Merged PR 1: Merged PR 2: real description") kept the second one and returned a value
  // that still matched the pattern — violating the contract above. Caught by the property test, not
  // by any of the hand-written cases.
  //
  // The loop is bounded: each pass must shorten the string to continue, and MAX_PASSES caps it
  // regardless, so no input can spin here.
  const MAX_PASSES = 8;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
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
