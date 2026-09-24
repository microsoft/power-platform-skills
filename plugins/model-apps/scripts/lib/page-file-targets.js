'use strict';
// Where a generated page may be written — ONE rule for every place a page filename is accepted:
//   - /genpage, before it dispatches parallel page workers (scripts/check-page-files.js)
//   - /app-builder, when it projects an App Spec into a page plan (lib/page-plan.js)
//   - the Layer 1 plan validator the genpage evals run (evals/model-apps/genpage/lib)
// The names come from a plan an AI planner wrote, and workers then write to them unattended, so an
// unsafe name is a write outside the working directory, and two names one filesystem stores as the
// same file are two workers silently overwriting each other. Two copies of this rule had already
// drifted — one checked realpaths, the other did not — so there is only this one.
//
// Raw shapes refused, each as a separate problem code:
//   C:\pages\a.tsx   /tmp/a.tsx   C:a.tsx   absolute   (either platform's form is refused on every
//                                                     platform; `C:a.tsx` is drive-relative, still anywhere)
//   pages\a.tsx                      backslash  (a separator on Windows, a filename character elsewhere:
//                                                the same plan would write different files per OS)
//   ../outside.tsx   x/../../a.tsx   traversal  (`..` segments; a lone `.` cannot climb and is allowed)
//   linked/a.tsx                     realpath-escape (a parent — or a pre-planted file — that resolves
//                                                through a link or junction to outside the directory)
//   Page.tsx + page.tsx              collision  (case-insensitive filesystems store them as one file)

const fs = require('node:fs');
const path = require('node:path');

/**
 * Every problem with `files` as write targets inside `workingDir`, in input order. The realpath check
 * runs only when `workingDir` is given and exists (a plan projected before its directory exists, or a
 * synthetic eval plan, still gets every lexical check).
 * @param {string[]} files
 * @param {{ workingDir?: string }} [opts]
 * @returns {{ file: string, code: string, message: string }[]}
 */
function pageFileProblems(files, opts = {}) {
  const problems = [];
  const add = (file, code, message) => problems.push({ file, code, message });
  const root = opts.workingDir ? path.resolve(opts.workingDir) : null;
  let rootReal = null;
  if (root) {
    try { rootReal = fs.realpathSync.native(root); } catch { rootReal = null; }
  }
  const seen = new Map();
  for (const raw of files || []) {
    const file = String(raw == null ? '' : raw).trim();
    if (!file) { add(file, 'empty', 'a page has an empty file name'); continue; }
    if (path.win32.isAbsolute(file) || path.posix.isAbsolute(file) || /^[A-Za-z]:/.test(file)) {
      // `C:page.tsx` is DRIVE-relative, not absolute to path.win32.isAbsolute, yet on Windows it
      // resolves against that drive's current directory — anywhere on the machine.
      add(file, 'absolute', `"${file}" is an absolute path; page files are relative to the working directory`);
      continue;
    }
    if (file.includes('\\')) {
      add(file, 'backslash', `"${file}" uses a backslash separator; use forward-slash relative paths only`);
      continue;
    }
    // Only `..` can climb out; a lone `.` segment (`./overview.tsx`) cannot, and refusing it would force
    // a full re-plan over a harmless spelling. Its identity is normalized below, so `./a.tsx` and
    // `a.tsx` still collide.
    if (file.split('/').some((segment) => segment === '..')) {
      add(file, 'traversal', `"${file}" contains a ".." traversal segment`);
      continue;
    }
    if (rootReal) {
      // The target usually does not exist yet (a worker has not written it), so resolve the nearest
      // existing ancestor: that is where a link can redirect a lexically contained path. An existing
      // target is resolved itself, so a link pre-planted AT the file name is caught too.
      let probe = path.resolve(root, file);
      while (!fs.existsSync(probe) && path.dirname(probe) !== probe) probe = path.dirname(probe);
      try {
        const rel = path.relative(rootReal, fs.realpathSync.native(probe));
        if (rel.startsWith('..') || path.isAbsolute(rel)) {
          add(file, 'realpath-escape', `"${file}" resolves through a link or junction to outside the working directory`);
          continue;
        }
      } catch { /* cannot resolve the ancestor: the lexical checks above still hold */ }
    }
    // NFC first so a precomposed and a decomposed spelling of one name also collide.
    const identity = path.posix.normalize(file).normalize('NFC').toLowerCase();
    const prior = seen.get(identity);
    if (prior !== undefined) {
      add(file, 'collision', `"${prior}" and "${file}" collide on a case-insensitive filesystem`);
      continue;
    }
    seen.set(identity, file);
  }
  return problems;
}

/**
 * The File column of a plan's Pages table, in order. A genpage plan (references/plan-schema.md) has:
 *   ## Pages
 *   | Page | File | Purpose | Entities |
 *   |------|------|---------|----------|
 *   | Overview | overview.tsx | Summary cards | account |
 * and the preview the planner hands back for approval has the same table under `### Pages (N total)`,
 * which `opts.heading` selects. The table ends at the next heading of any level. An escaped pipe
 * (`\|`) inside a cell is not a column boundary. Returns null when there is no Pages table with a File
 * column — a malformed plan, which the caller must refuse, not read as "no pages".
 * @param {string} plan
 * @param {{ heading?: RegExp }} [opts]
 * @returns {string[]|null}
 */
function pageFilesFromPlan(plan, opts = {}) {
  const heading = opts.heading || /^##\s+Pages\s*$/;
  const lines = String(plan || '').replace(/\r\n?/g, '\n').split('\n');
  const start = lines.findIndex((l) => heading.test(l));
  if (start === -1) return null;
  const rows = [];
  for (let i = start + 1; i < lines.length && !/^#{1,6}\s/.test(lines[i]); i += 1) {
    if (lines[i].trim().startsWith('|')) rows.push(lines[i]);
  }
  const cells = (row) => row.replace(/\\\|/g, '\u0000').trim().replace(/^\|/, '').replace(/\|$/, '')
    .split('|').map((c) => c.replace(/\u0000/g, '|').trim());
  if (rows.length < 2) return null;
  const header = cells(rows[0]).map((h) => h.toLowerCase());
  const col = header.indexOf('file');
  if (col === -1 || !/^[\s|:-]+$/.test(rows[1])) return null;
  return rows.slice(2).map((row) => cells(row)[col] || '');
}

module.exports = { pageFileProblems, pageFilesFromPlan };
