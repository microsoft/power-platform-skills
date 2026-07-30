#!/usr/bin/env node
'use strict';
// promote-intent-pages: validate every generated page, then flip `source: intent -> tsx` in ONE
// atomic spec write.
//
// WHY this is a script and not a prose step: /app-builder Phase 1.5 dispatches N headless workers
// and any subset of them can fail. If the orchestrator flips each page's `source` as that page
// comes back, a partial failure leaves `app-spec.json` half-promoted — some pages claim a `.tsx`
// that was never written, or a page that WAS written is still `intent`. Phase 2 then validates
// under the `deploy` profile and fails, but the spec on disk is already corrupted and the user has
// no clean state to retry from. So promotion is all-or-nothing and performed here: every page is
// validated first, and the spec file is only touched if EVERY page passes.
//
// Exit codes: 0 = promoted (or nothing to do), 3 = validation failed and the spec was NOT modified.
//
// Usage:
//   node promote-intent-pages.js --spec @<working-dir>/app-spec.json --working-dir <dir>

const fs = require('node:fs');
const path = require('node:path');
const { parseArgs, readJsonArg, emitResult } = require('./lib/dataverse-auth.js');
const { migrateAppSpec } = require('./lib/app-spec.js');
const { pageKey, pageFile } = require('./lib/page-plan.js');
const { navReferencedKeys, navMalformedRefs, navTargetParity } = require('./lib/pageref-resolver.js');
const { hasDefaultExport, hasUnbalancedBrackets } = require('./lib/source-literals.js');

// A generated page must be a real React module. We deliberately do NOT typecheck here (the plugin
// ships with no dependencies, so there is no TS parser to call, and typechecking is the build's
// job) — this is the structural gate that catches the realistic worker failures: an empty file, a
// truncated write, or prose returned instead of code.
//
// Every check runs over literal-blanked source (see lib/source-literals.js). A substring search —
// even one over pageref-resolver's stripNonCode, which deliberately PRESERVES ordinary string
// bodies — accepted prose that merely MENTIONS an export:
//   /* export default */                                -> promoted
//   const prose = "export default GeneratedComponent";   -> promoted
// Promotion is sticky (the page is then marked implemented and skipped on the next run), so a
// fail-open here corrupts the state the user would otherwise retry from.
function structuralProblems(code) {
  const out = [];
  if (!code.trim()) return ['file is empty'];
  if (!hasDefaultExport(code)) {
    out.push('no real `export default` (or `export { X as default }`) — the host cannot mount the page');
  }
  if (hasUnbalancedBrackets(code)) {
    out.push('unbalanced brackets — the file looks truncated');
  }
  // A worker that answers in prose usually still opens a fence; a real .tsx never contains one.
  // Both CommonMark fence markers count.
  if (/^\s*(```|~~~)/m.test(code)) out.push('contains a markdown code fence — the worker returned prose, not a module');
  return out;
}

function validatePage(page, absWorkingDir) {
  const key = pageKey(page);
  const file = pageFile(page);

  // Containment check BEFORE any read. `codeFile` is author-editable and, on an edit round-trip,
  // download-derived — so a `../` prefix or an absolute path would make this script read (and then
  // record) a file outside the app folder. The spec is only ever allowed to reference pages inside
  // its own working directory.
  const abs = path.resolve(absWorkingDir, file);
  const rel = path.relative(absWorkingDir, abs);
  if (path.isAbsolute(file) || rel.startsWith('..') || path.isAbsolute(rel)) {
    return { key, file, problems: [`codeFile escapes the working directory (resolved to ${abs})`] };
  }
  if (!fs.existsSync(abs)) return { key, file, problems: ['file was never written'] };

  const code = fs.readFileSync(abs, 'utf8');
  const problems = structuralProblems(code);

  // Cross-page nav must be exactly what the spec declares, checked BEFORE promotion. The build
  // HALTs on a malformed PAGEREF or a nav parity mismatch, so catching it here keeps the failure
  // in Phase 1.5 where the page can simply be regenerated.
  const malformed = navMalformedRefs(code);
  if (malformed.length) problems.push(`malformed nav pageref(s): ${malformed.join(', ')} (must be a double-quoted "PAGEREF_<key>" literal)`);

  const declared = (page.navigatesTo || []).map((n) => (typeof n === 'string' ? n : n && n.targetKey)).filter(Boolean);
  const { declaredNotReferenced, referencedNotDeclared } = navTargetParity(declared, navReferencedKeys(code));
  if (declaredNotReferenced.length) problems.push(`navigatesTo declares ${declaredNotReferenced.join(', ')} but the code never navigates there`);
  if (referencedNotDeclared.length) problems.push(`code navigates to ${referencedNotDeclared.join(', ')} which is not in navigatesTo`);

  return { key, file, problems };
}

function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const str = (v) => (typeof v === 'string' ? v : undefined);
  const specArg = str(flags.spec) || (typeof positional[0] === 'string' ? positional[0] : undefined);
  const workingDir = str(flags['working-dir']);
  if (!specArg || !workingDir) {
    process.stderr.write('Usage: node scripts/promote-intent-pages.js --spec @<app-folder>/app-spec.json --working-dir <dir>\n');
    process.exit(1);
  }

  const specPath = path.resolve(specArg.startsWith('@') ? specArg.slice(1) : specArg);
  const absWorkingDir = path.resolve(workingDir);
  // Read the raw text so the rewrite preserves the author's formatting for everything we do not
  // touch — migrateAppSpec is only used to reason about the CURRENT shape, never to rewrite it.
  // A missing/garbled spec is a normal operator error, not a crash: report it as a fail-closed
  // result so the skill sees the same exit-3 contract as a validation failure.
  let raw;
  let originalText;
  try {
    originalText = fs.readFileSync(specPath, 'utf8');
    raw = JSON.parse(originalText);
  } catch (e) {
    process.stderr.write(`cannot read app spec at ${specPath}: ${e.message}\n`);
    process.exit(3);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    process.stderr.write(`app spec at ${specPath} is not a JSON object\n`);
    process.exit(3);
  }
  if (raw.pages !== undefined && !Array.isArray(raw.pages)) {
    process.stderr.write(`app spec "pages" must be an array (got ${typeof raw.pages})\n`);
    process.exit(3);
  }
  const spec = migrateAppSpec(JSON.parse(JSON.stringify(raw)));

  const pages = spec.pages || [];
  const intentIdx = pages.map((p, i) => [p, i]).filter(([p]) => p && (!p.source || p.source.kind === 'intent'));
  if (!intentIdx.length) {
    emitResult(true, { ok: true, promoted: [], message: 'no intent pages to promote' });
    return;
  }

  const results = intentIdx.map(([p, i]) => ({ index: i, ...validatePage(p, absWorkingDir) }));

  // Two pages resolving to the same file means one worker overwrote the other's output, so both
  // rows would be promoted to identical code. Compare case-insensitively: NTFS and macOS are
  // case-insensitive, so `Overview.tsx` and `overview.tsx` are the SAME file there.
  const byFile = new Map();
  for (const r of results) {
    const k = path.resolve(absWorkingDir, r.file).toLowerCase();
    if (byFile.has(k)) {
      r.problems.push(`resolves to the same file as page "${byFile.get(k)}" — one page overwrote the other`);
    } else byFile.set(k, r.key);
  }

  const failed = results.filter((r) => r.problems.length);
  if (failed.length) {
    // Fail-closed: the spec on disk is untouched, so the caller can regenerate just the bad pages
    // and re-run this command.
    process.stdout.write(JSON.stringify({ ok: false, promoted: [], failed }, null, 2) + '\n');
    process.stderr.write(
      `promotion aborted — ${failed.length} of ${results.length} page(s) failed validation; app-spec.json was NOT modified\n`
      + failed.map((f) => `  - ${f.file}: ${f.problems.join('; ')}`).join('\n') + '\n'
    );
    process.exit(3);
  }

  // All pages passed -> single write. Mutate the RAW object (not the migrated copy) so unrelated
  // fields and legacy shapes survive the round-trip untouched. Pages are matched by POSITION, not by
  // key: `key` is optional in an authored spec (migrateAppSpec derives it by slugifying `name`), so
  // a key lookup against the raw pages would throw on the very specs that need promoting most.
  // migrateAppSpec never reorders or filters `pages[]`, so index i is the same page in both.
  for (const r of results) {
    const target = (raw.pages || [])[r.index];
    if (!target) continue;
    target.source = { kind: 'tsx', codeFile: r.file };
  }
  // Write via a temp file + rename so a crash mid-write cannot truncate the user's spec.
  // fs.renameSync overwrites an existing destination on both POSIX and Windows (libuv uses
  // MoveFileEx with MOVEFILE_REPLACE_EXISTING), so no unlink-first dance is needed. The temp name
  // includes the pid so two concurrent promotions cannot clobber each other's staging file.
  //
  // Compare-and-swap: validating N pages involves N file reads, so a user editing app-spec.json in
  // Maker/an editor meanwhile would have their change silently overwritten by our stale in-memory
  // copy. STAGE FIRST, then re-read and compare in the last instant before the rename — doing the
  // compare before writing the temp file leaves the whole serialize+write window unguarded, which
  // is the larger of the two. This is a narrow-window check, not a lock: without OS-level file
  // locking (unavailable portably in node) a write landing between the compare and the rename is
  // still possible. That residual is acceptable because promotion is operator-driven and rerunnable,
  // and the check closes the window that is actually long (page validation).
  const tmp = `${specPath}.${process.pid}.promote.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(raw, null, 2) + '\n', 'utf8');
    if (fs.readFileSync(specPath, 'utf8') !== originalText) {
      fs.unlinkSync(tmp);
      process.stderr.write('app spec changed while pages were being validated; nothing was written — re-run promotion\n');
      process.exit(3);
    }
    fs.renameSync(tmp, specPath);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* nothing to clean up */ }
    process.stderr.write(`failed to write ${specPath}: ${e.message}\n`);
    process.exit(3);
  }

  emitResult(true, { ok: true, promoted: results.map((r) => ({ key: r.key, codeFile: r.file })), specPath });
}

if (require.main === module) main();

module.exports = { main, validatePage, structuralProblems };
