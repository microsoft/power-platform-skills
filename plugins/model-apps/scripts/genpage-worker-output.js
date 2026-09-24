#!/usr/bin/env node
'use strict';
// Validate page-builder worker output before the orchestrator accepts it.
//
// A partially written `.tsx` can still contain the token `export default`, so existence plus a token
// scan is not enough. This script reuses the dependency-free TSX lexer that already protects
// promote-intent-pages.js, giving the AI orchestration an executable yes/no gate before it decides
// whether to run the inline fallback.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { blankLiterals, endsMidStatement, findElisionMarker, hasDefaultExport, hasUnbalancedBrackets } = require('./lib/source-literals.js');

// A worker that returns without writing leaves whatever was at its path before, and a complete page an
// earlier attempt left there passes every content check: the stale page was deployed instead of taking
// the inline fallback. So the orchestrator STAMPS each target right before it dispatches the page
// (`--stamp`), and the check refuses a file exactly as it was stamped — same size, modification time and
// content. Any write moves the modification time, so a page rewritten with identical bytes still counts
// as written. The stamp is a sidecar beside the page, `.<name>.dispatch-stamp.json`; a check that finds the
// page changed consumes it, and one that finds it unchanged keeps it, so a retry is refused the same way. A
// check with no stamp checks the content alone.
const STAMP_SUFFIX = '.dispatch-stamp.json';
const stampPathFor = (abs) => path.join(path.dirname(abs), `.${path.basename(abs)}${STAMP_SUFFIX}`);
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function stampPageTarget({ filePath }) {
  if (!filePath) return { ok: false, action: 'stamp', problems: ['--file is required'] };
  const abs = path.resolve(filePath);
  const fail = (problem) => ({ ok: false, action: 'stamp', filePath: abs, problems: [problem] });
  try {
    // A page whose folder does not exist yet cannot be stale — nothing is there to be left behind — so there
    // is nothing to stamp, and the folder is not created for it: a page never written is caught without one.
    try { fs.lstatSync(path.dirname(abs)); } catch (e) {
      if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return { ok: true, action: 'stamp', filePath: abs, existed: false };
      throw e;
    }
    // The sidecar is written in place, so a link there would put it wherever it points — and a folder or
    // a hard link is not the sidecar this wrote. The page path itself was checked by check-page-files.js.
    const sidecar = stampPathFor(abs);
    let side = null;
    try { side = fs.lstatSync(sidecar); } catch (e) { if (!(e && e.code === 'ENOENT')) throw e; }
    if (side && (!side.isFile() || side.nlink > 1)) return fail(`${sidecar} is not a plain file (a link, junction, hard link or folder); remove it and re-run`);
    let state = { existed: false };
    let entry = null;
    try { entry = fs.lstatSync(abs); } catch (e) { if (!(e && e.code === 'ENOENT')) throw e; }
    if (entry) {
      if (!entry.isFile()) return fail('is not a regular file');
      state = { existed: true, size: entry.size, mtimeMs: entry.mtimeMs, sha256: sha256(fs.readFileSync(abs)) };
    }
    fs.writeFileSync(sidecar, JSON.stringify({ filePath: abs, ...state }));
    return { ok: true, action: 'stamp', filePath: abs, existed: state.existed };
  } catch (e) {
    return fail(`could not stamp the page (${(e && e.code) || e})`);
  }
}

// The stamp for `abs`, or null when there is none. A stamp that cannot be read fails closed — the check can
// no longer tell this run's write from what was there before. Reading never removes it: only a page found
// CHANGED consumes its stamp (consumeStamp). Consuming it on a failed check let the very next check — the
// retry the skill prescribes, or the same command run again — see no stamp and pass the stale page.
function readStamp(abs) {
  const sidecar = stampPathFor(abs);
  let side;
  try { side = fs.lstatSync(sidecar); } catch (e) {
    if (e && e.code === 'ENOENT') return null;
    return { unreadable: `could not be inspected (${(e && e.code) || e})` };
  }
  try {
    if (!side.isFile() || side.nlink > 1) return { unreadable: 'is not a plain file' };
    const stamp = JSON.parse(fs.readFileSync(sidecar, 'utf8'));
    if (!stamp || typeof stamp.existed !== 'boolean') return { unreadable: 'is not a dispatch stamp' };
    return stamp;
  } catch (e) {
    return { unreadable: `could not be read (${(e && e.code) || (e && e.message) || e})` };
  }
}
function consumeStamp(abs) {
  try { fs.rmSync(stampPathFor(abs), { force: true }); } catch { /* best-effort: the next --stamp overwrites it */ }
}

function structuralProblems(code) {
  const text = String(code || '');
  const problems = [];
  if (!text.trim()) return ['file is empty'];
  // hasDefaultExport also refuses a file cut off INSIDE its export (`export default function P(props)`
  // with no body), so say so: the one inline rewrite should write the whole page, not add an export.
  if (!hasDefaultExport(text)) problems.push('no complete default export — missing, or the file ends inside it');
  if (hasUnbalancedBrackets(text)) problems.push('unbalanced brackets — output looks truncated');
  // A cut that leaves every bracket balanced: inside JSX, a template or a comment, or after `a +`.
  if (endsMidStatement(text)) problems.push('stops mid-statement — output looks truncated');
  // On the blanked source, so a fence inside a template literal (a page rendering markdown help) is
  // data; a fence wrapping the file — the model answered in markdown — is code-position text.
  if (/^\s*(```|~~~)/m.test(blankLiterals(text))) problems.push('contains a markdown code fence');
  const elision = findElisionMarker(text);
  if (elision) problems.push(`contains ${elision}`);
  return problems;
}

// Every outcome is a result, never a throw: `ok:false` is what sends the orchestrator to its one inline
// rewrite, and a folder or an unreadable file at the page path used to throw out of readFileSync — an
// uncaught CLI failure instead of that recovery. lstat, not existsSync, so a link there (dangling ones
// included) is reported as what it is: not a page written in place — the dispatch gate
// (check-page-files.js) refuses a link at a page path before any worker runs.
function validatePageOutput({ filePath }) {
  if (!filePath) return { ok: false, filePath, problems: ['--file is required'] };
  const abs = path.resolve(filePath);
  const fail = (problem) => ({ ok: false, filePath: abs, problems: [problem] });
  let entry;
  try { entry = fs.lstatSync(abs); } catch (e) {
    return fail(e && e.code === 'ENOENT' ? 'file was never written' : `file could not be inspected (${(e && e.code) || e})`);
  }
  const stamp = readStamp(abs);
  if (stamp && stamp.unreadable) {
    // A link or hard link there is refused by --stamp too, so re-stamping cannot clear it: say what does.
    const remedy = /plain file/.test(stamp.unreadable) ? 'remove it and re-run' : 'stamp the page again before its next write';
    return fail(`the dispatch stamp ${stamp.unreadable}; ${remedy}`);
  }
  if (entry.isSymbolicLink()) return fail('is a symbolic link or junction, not a page file written in place');
  if (!entry.isFile()) return fail('is not a regular file');
  let bytes;
  try { bytes = fs.readFileSync(abs); } catch (e) { return fail(`file could not be read (${(e && e.code) || e})`); }
  if (stamp && stamp.existed && stamp.size === entry.size && stamp.mtimeMs === entry.mtimeMs && stamp.sha256 === sha256(bytes)) {
    return fail('file is unchanged since the page was dispatched — the worker did not write it');
  }
  // Written since the stamp (or no stamp at all): the stamp has done its job.
  if (stamp) consumeStamp(abs);
  const problems = structuralProblems(bytes.toString('utf8'));
  return { ok: problems.length === 0, filePath: abs, problems };
}

function parseArgv(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--file') {
      out.filePath = argv[i + 1];
      i += 1;
    } else if (argv[i] === '--stamp') {
      out.stamp = true;
    }
  }
  return out;
}

function main() {
  const args = parseArgv(process.argv.slice(2));
  const result = args.stamp ? stampPageTarget(args) : validatePageOutput(args);
  process.stdout.write(JSON.stringify(result) + '\n');
  process.exit(result.ok ? 0 : 3);
}

if (require.main === module) main();

module.exports = { validatePageOutput, stampPageTarget, structuralProblems, STAMP_SUFFIX };
