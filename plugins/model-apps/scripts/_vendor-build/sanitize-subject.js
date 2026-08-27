/* Strip merge-tool prefixes from an upstream commit subject before it is recorded in
 * vendor/PROVENANCE.json.
 *
 * The SDK's history is squash-merged by a server-side tool that prepends its own PR id, e.g.
 *   "Merged PR 16896261: feat(cds-maker-sdk): configurable authoring LCID, command bind fixes"
 *   "Merge pull request #4312 from someone/some-branch"
 * That id is unresolvable from THIS repository, and PROVENANCE.json is committed to a public one,
 * so the prefix is noise that also advertises a tracker nobody reading it can open. The part that
 * carries the "why" is the description after the prefix, so keep exactly that. The upstream SHA is
 * recorded separately and is the field that actually identifies the source.
 *
 * Lives in its own module rather than inside build.js so it can be unit-tested: build.js is a CLI
 * that resolves its --sdk argument and calls process.exit at load time, so requiring it from a test
 * would terminate the test runner.
 */

// Only a LEADING, well-formed prefix is removed. Anchoring matters: a subject that merely mentions
// "merged PR 42" mid-sentence is prose, not a tool prefix, and must survive untouched.
const MERGE_PREFIXES = [
  // Azure DevOps / TFS squash-merge subject.
  /^\s*Merged\s+PR\s+\d+\s*:\s*/i,
  // GitHub merge-commit subject. The trailing description is optional here, so the branch ref is
  // consumed with or without a following colon.
  /^\s*Merge\s+pull\s+request\s+#\d+\s+from\s+\S+\s*:?\s*/i,
];

function sanitizeSubject(subject) {
  if (typeof subject !== 'string') return subject;
  let out = subject;
  for (const re of MERGE_PREFIXES) out = out.replace(re, '');
  out = out.trim();
  // A subject that is ONLY a prefix ("Merged PR 123:") would sanitize to an empty string. Keep the
  // original in that case: a useless-but-present subject is easier to diagnose than a missing field,
  // which reads as "provenance could not be determined" and is a different, more alarming claim.
  return out || subject.trim();
}

module.exports = { sanitizeSubject };
