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
//   CON.tsx   page:alt.tsx   x./a.tsx  unportable (a Windows device name, a reserved character — `:` writes
//                                                an NTFS alternate stream — or a trailing dot or space)
//   package.json   RuntimeTypes.ts   extension  (every Pages File is a page `.tsx` — references/plan-schema.md;
//                                                any other name is some other file of the working
//                                                directory, which a worker would overwrite with a page)
//   a.tsx → anywhere                 link       (the target itself is a symbolic link or junction —
//                                                dangling or not, inside the directory or out: a worker
//                                                writes through it, so `page.tsx → package.json` puts a
//                                                page into package.json — or a HARD link, a plain file
//                                                to lstat whose other names a write rewrites too)
//   linked/a.tsx                     realpath-escape (a parent that resolves through a link or junction
//                                                to outside the directory)
//   dead/a.tsx                       unresolvable (a parent that cannot be resolved — a dangling or looping
//                                                link. existsSync calls a dangling link absent, so the walk
//                                                used to step past it to the in-directory folder above.
//                                                Also any disk error other than "not there": EACCES/EIO
//                                                are refused, never read as absence)
//   a.tsx (a folder)                 not-a-file (the target exists but is not a regular file)
//   Page.tsx + page.tsx              collision  (case-insensitive filesystems store them as one file —
//                                                two names of the plan, or a name whose folder or file is
//                                                ALREADY on disk under another spelling, which the worker
//                                                would write into or over; also two names that reach one
//                                                file through a link or junction inside the directory)

const fs = require('node:fs');
const path = require('node:path');

// The name a case-insensitive filesystem stores: NFC first, so a precomposed and a decomposed spelling
// of one name are one identity too.
const identityOf = (name) => name.normalize('NFC').toLowerCase();

// "Nothing there" is only ever ENOENT, or ENOTDIR (a parent is a file, so nothing can be below it). Any
// other error — EACCES, EPERM, EIO — is not an answer: it propagates, and the file is refused as
// `unresolvable`, rather than "could not look" being read as "nothing there" and waved through.
const isAbsent = (e) => !!e && (e.code === 'ENOENT' || e.code === 'ENOTDIR');

function entryAt(p) {
  try { return fs.lstatSync(p); } catch (e) { if (isAbsent(e)) return null; throw e; }
}

// Windows cannot store these as a file or folder name — a device name (with any extension), a reserved
// character, or a trailing dot or space — and `:` is worse than refused: `page:alt.tsx` writes an NTFS
// alternate data stream `alt.tsx` on a file `page`, so the page lands where no one looks. Checked on
// every platform, for the same reason as backslashes: one plan must mean the same files everywhere.
// See: https://learn.microsoft.com/windows/win32/fileio/naming-a-file#naming-conventions
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])(?:\..*)?$/i;
// [what the segment has, why that is refused], or null.
function unportableSegment(segment) {
  const unstorable = 'which Windows cannot store as a file name';
  if (/[<>:"|?*\u0000-\u001f]/.test(segment)) return ['a character Windows reserves', unstorable];
  if (/[. ]$/.test(segment)) return ['a trailing dot or space', unstorable];
  if (WINDOWS_DEVICE.test(segment)) return ['a Windows device name', unstorable];
  // An 8.3 short-name form. On a drive that keeps short names (the system drive, by default)
  // `REPORT~1.TSX` can BE `report-dashboard-a.tsx`, so two planned pages would be one file — and whether
  // they are depends on which was written first. No page name needs one. Windows stores the name fine;
  // the problem is what it can refer to.
  if (/~\d/.test(segment)) return ['a Windows short-name form (`~1`)', 'which on Windows can be the short name of another file'];
  return null;
}

// The first component on the way to a target — a folder or the file itself — that is ALREADY on disk
// under another spelling of the same name (case, or Unicode normalization), as its relative path, or
// null. A case-insensitive filesystem stores the two as one, so `pages/Home.tsx` writes into an existing
// `Pages/` or over an existing `pages/home.tsx`; a case-sensitive one makes a second file or tree beside
// it. Either way the plan does not mean what it says, so it is refused at any level. The identical
// spelling all the way down is that very page, which a re-run rewrites. Listings are cached per folder.
function differentlySpelledOnDisk(root, segments, listings) {
  let dir = root;
  for (let i = 0; i < segments.length; i++) {
    if (!listings.has(dir)) {
      let names = null;
      try { names = fs.readdirSync(dir); } catch (e) { if (!isAbsent(e)) throw e; }
      listings.set(dir, names);
    }
    const names = listings.get(dir);
    if (!names) return null; // this folder is not there yet, so nothing below it can collide
    const hit = names.find((n) => n !== segments[i] && identityOf(n) === identityOf(segments[i]));
    if (hit) return [...segments.slice(0, i), hit].join('/');
    // Not there under any spelling: the next listing fails with ENOENT and ends the walk.
    dir = path.join(dir, segments[i]);
  }
  return null;
}

/**
 * Every problem with `files` as write targets inside `workingDir`, in input order. The link, realpath
 * and existing-file checks run only when `workingDir` is given and exists (a plan projected before its
 * directory exists, or a synthetic eval plan, still gets every lexical check).
 *
 * `built` lists pages ALREADY built, which no worker writes (/app-builder's implemented pages). They are
 * checked first, by the lexical safety rules and for collisions — a new page is never written over one,
 * and two of them colliding is still reported — but not by the write-target rules (the `.tsx` extension,
 * links, the existing-file listing), which guard a file about to be written: HEAD built a plan for an
 * implemented `codeFile` the spec gate accepts, such as `pages/home.jsx`.
 * @param {string[]} files
 * @param {{ workingDir?: string, built?: string[] }} [opts]
 * @returns {{ file: string, code: string, message: string }[]}
 */
function pageFileProblems(files, opts = {}) {
  const problems = [];
  const add = (file, code, message) => problems.push({ file, code, message });
  const root = opts.workingDir ? path.resolve(opts.workingDir) : null;
  let rootReal = null;
  let rootError = null;
  let rootLink = false;
  if (root) {
    // A working directory that does not exist yet leaves only the lexical checks (see above). One that
    // exists but cannot be resolved is not "nothing to check": every written file is refused.
    // The working directory ITSELF must not be a link, the rule generate-page-manifest.js applies to the
    // same directory: `mkdir -p` succeeds silently on a link already at that path, so one planted there
    // redirected every page a worker wrote, and each target resolved inside its realpath and passed. A
    // linked ANCESTOR is still followed — a normal setup (macOS temp dirs sit under a symlinked /var).
    // It is inspected with lstat FIRST, apart from realpath: a DANGLING link there has no realpath
    // (ENOENT), and reading that as "not created yet" left only the lexical checks, so a worker's
    // `mkdir -p` then created the directory through the link.
    let at = null;
    try { at = fs.lstatSync(root); } catch (e) { if (!(e && e.code === 'ENOENT')) rootError = e; }
    rootLink = !!at && at.isSymbolicLink();
    if (at && !rootLink) {
      try { rootReal = fs.realpathSync.native(root); } catch (e) { rootError = e; }
    }
  }
  const seen = new Map();
  // The same file reached under two names — through a link or junction INSIDE the working directory
  // (`alias -> sub` makes `alias/a.tsx` and `sub/a.tsx` one file) — keyed by where it really resolves.
  const seenReal = new Map();
  const listings = new Map();
  // The checks that read the disk. Returns true when it added a problem.
  const onDisk = (file) => {
    const target = path.resolve(root, file);
    const at = entryAt(target);
    if (at && at.isSymbolicLink()) {
      add(file, 'link', `"${file}" is a symbolic link or junction; a worker would write through it to another file`);
      return true;
    }
    if (at && !at.isFile()) {
      add(file, 'not-a-file', `"${file}" already exists and is not a regular file (a folder or a device); a worker cannot write a page there`);
      return true;
    }
    // A HARD link is a plain file to lstat — no link bit, no realpath redirect — yet writing it rewrites
    // every other name of the same file, outside the working directory included. A page this workflow
    // wrote has exactly one name.
    if (at && at.nlink > 1) {
      add(file, 'link', `"${file}" is a hard link (${at.nlink} names for one file); a worker writing it would change the other names too`);
      return true;
    }
    // The target usually does not exist yet (a worker has not written it), so resolve the nearest
    // existing ancestor: that is where a link can redirect a lexically contained path. "Existing" is
    // lstat's answer, so a dangling link on the way stops the walk instead of being stepped past.
    let probe = target;
    while (!entryAt(probe) && path.dirname(probe) !== probe) probe = path.dirname(probe);
    let real;
    try { real = fs.realpathSync.native(probe); } catch (e) {
      add(file, 'unresolvable', `"${file}" passes through a link that cannot be resolved (${(e && e.code) || e}); remove it`);
      return true;
    }
    const rel = path.relative(rootReal, real);
    if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
      add(file, 'realpath-escape', `"${file}" resolves through a link or junction to outside the working directory`);
      return true;
    }
    const existing = differentlySpelledOnDisk(root, file.split('/').filter((s) => s && s !== '.'), listings);
    if (existing) {
      add(file, 'collision', `"${file}" and the existing "${existing}" collide on a case-insensitive filesystem`);
      return true;
    }
    const resolved = identityOf(path.join(real, path.relative(probe, target)));
    const alias = seenReal.get(resolved);
    if (alias !== undefined) {
      // Two spellings of one name (`Page.tsx` / `page.tsx`) land here too — before the plain name check
      // below — and are reported as what they are; only names that differ otherwise went through a link.
      const why = identityOf(path.posix.normalize(alias)) === identityOf(path.posix.normalize(file))
        ? 'collide on a case-insensitive filesystem'
        : 'are the same file, reached through a link or junction';
      add(file, 'collision', `"${alias}" and "${file}" ${why}`);
      return true;
    }
    seenReal.set(resolved, file);
    return false;
  };
  const check = (raw, written) => {
    const file = String(raw == null ? '' : raw).trim();
    if (!file) { add(file, 'empty', 'a page has an empty file name'); return; }
    if (path.win32.isAbsolute(file) || path.posix.isAbsolute(file) || /^[A-Za-z]:/.test(file)) {
      // `C:page.tsx` is DRIVE-relative, not absolute to path.win32.isAbsolute, yet on Windows it
      // resolves against that drive's current directory — anywhere on the machine.
      add(file, 'absolute', `"${file}" is an absolute path; page files are relative to the working directory`);
      return;
    }
    if (file.includes('\\')) {
      add(file, 'backslash', `"${file}" uses a backslash separator; use forward-slash relative paths only`);
      return;
    }
    // Only `..` can climb out; a lone `.` segment (`./overview.tsx`) cannot, and refusing it would force
    // a full re-plan over a harmless spelling. Its identity is normalized below, so `./a.tsx` and
    // `a.tsx` still collide.
    if (file.split('/').some((segment) => segment === '..')) {
      add(file, 'traversal', `"${file}" contains a ".." traversal segment`);
      return;
    }
    if (written) {
      for (const segment of file.split('/')) {
        const why = segment && segment !== '.' ? unportableSegment(segment) : null;
        if (why) {
          add(file, 'unportable', `"${file}" has ${why[0]} in "${segment}", ${why[1]}`);
          return;
        }
      }
      if (!/[^/]\.tsx$/i.test(file)) {
        add(file, 'extension', `"${file}" is not a .tsx page file; the plan's File column names pages only`);
        return;
      }
      if (rootError) {
        add(file, 'unresolvable', `"${file}" cannot be checked: the working directory cannot be resolved (${rootError.code || rootError.message})`);
        return;
      }
      if (rootLink) {
        add(file, 'link', `"${file}" would be written through the working directory, which is itself a symbolic link or junction; pass the directory it points to`);
        return;
      }
      if (rootReal) {
        try {
          if (onDisk(file)) return;
        } catch (e) {
          add(file, 'unresolvable', `"${file}" cannot be checked on disk (${(e && e.code) || e}); fix its folder's permissions or pick another name`);
          return;
        }
      }
    }
    const identity = identityOf(path.posix.normalize(file));
    const prior = seen.get(identity);
    if (prior !== undefined) {
      add(file, 'collision', `"${prior}" and "${file}" collide on a case-insensitive filesystem`);
      return;
    }
    seen.set(identity, file);
    // A built page is not refused for its disk state — no worker writes it — but it is still a file a new
    // page must not reach through a link or junction: `alias/a.tsx`, with `alias -> sub`, IS `sub/a.tsx`,
    // and without its real path on record a worker writing `sub/a.tsx` overwrote the built page.
    if (!written && rootReal && !rootError) {
      try {
        const target = path.resolve(root, file);
        let probe = target;
        while (!entryAt(probe) && path.dirname(probe) !== probe) probe = path.dirname(probe);
        const resolved = identityOf(path.join(fs.realpathSync.native(probe), path.relative(probe, target)));
        if (!seenReal.has(resolved)) seenReal.set(resolved, file);
      } catch { /* unresolvable: it simply cannot be matched through a link */ }
    }
  };
  for (const raw of opts.built || []) check(raw, false);
  for (const raw of files || []) check(raw, true);
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
