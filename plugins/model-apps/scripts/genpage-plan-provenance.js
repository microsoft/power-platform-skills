#!/usr/bin/env node
'use strict';
// Deterministic provenance gate for planner-authored markdown.
//
// WHY this is a script: the orchestrator is an AI workflow and `genpage-plan.md` /
// `genpage-edit-plan.md` may already exist from an earlier run. Checking "file exists" after a
// planner invocation accepts stale approved content if the planner failed to write this time. The
// contract is two-part:
//   1. `prepare` quarantines the old authoritative file BEFORE the planner is re-invoked, so the file
//      existing afterwards means this invocation wrote it.
//   2. `verify` proves the written file targets exactly what the approved plan named.
//
// Why not a hash of the whole approved body: the planner hands back a PREVIEW for approval and then
// writes a DIFFERENT document. The preview is
//   ## Genpage Plan / ### Pages (N total) / ### Data Strategy …   (full prefixed names)
// and the written plan is
//   # Genpage Plan / ## User Requirements / … / ## Pages / … / ## Per-Page Specifications   (suffixes)
// (agents/genpage-planner.md Steps 5 and 6; the edit planner likewise, Steps 3 and 4). No two such
// documents hash equal, so a hash gate halted every approved run. What both documents DO state is
// what the run will touch — the page files of a create, the page id of an edit — and that is what is
// compared: a stale plan from an earlier run, or one the planner re-derived, targets other pages.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { pagesSections } = require('./lib/page-file-targets.js');

function sha256(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

// What a plan document targets.
//   create:  the Pages table's File column — `## Pages` in the written plan, `### Pages (N total)`
//            in the preview.
//   edit:    the page id — `- **Page ID:** <guid>` in the written edit plan, and
//            `- **File:** <guid>/page.tsx` in the preview's `### Current State`.
// Returns { kind, targets } or null when the document names neither.
//
// Both GUID patterns are bounded by `[\w-]` on the side that could run on, exactly as the upload
// parser bounds pac's `Page ID:` (lib/genpage-cli.js parsePageId): an overlong `<guid>deadbeef` was
// truncated to its first 36 characters and certified.
//
// The written edit plan states the id ONCE, structurally, in `## File Being Edited`
// (agents/genpage-edit-planner.md), and only that section is read: the plan also copies the page's
// earlier prompts in full (`## Original Page Context`), and a label quoted there — "(**Page ID:** …)",
// "Show the **Page ID:** in the footer" — blocked every later edit of that page. Within the section every
// label must hold the same well-formed id: a malformed one makes the plan name NOTHING and is never
// rescued by an id found elsewhere, since the edit worker reads that very label.
//
// The approval PREVIEW has no such section. It names its page in its own `- **File:** <guid>/page.tsx`
// line under `### Current State` and quotes the first ~100 characters of the page's prompt a few lines
// later (`- **Original prompt:** …`), so a label read anywhere came out of that quote and decided the
// approved target — the same page halting on every edit, since its first prompt never changes. So a
// preview is read by the File line in its Current State block ALONE: a block whose File line is missing
// or names another file is a broken preview, and reading on found a label or a path quoted from the
// prompt, which approved another page. Only a document with neither section nor block is read by a File
// line anywhere, then by a label that BEGINS a line (under the same rule), and then by any
// `<guid>/page.tsx` path.
const GUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const LABELLED_ID = new RegExp(`^\`?\\{?(${GUID})\\}?\`?(?![\\w-])`);
function labelledPageIds(text, { lineStart = false } = {}) {
  const label = lineStart ? /^[ \t]*(?:[-*+][ \t]+)?\*\*Page ID:\*\*[ \t]*([^\r\n]*)/gm : /\*\*Page ID:\*\*[ \t]*([^\r\n]*)/g;
  return [...text.matchAll(label)].map((m) => {
    const id = LABELLED_ID.exec(m[1].trim());
    return id ? id[1].toLowerCase() : null;
  });
}
// A path names `page.tsx` only when the name ENDS there: `page\.tsx\b` also took `<guid>/page.tsx.bak`, a
// different file, and since an edit's provenance compares only the GUID, an approval naming it certified a
// written plan for the real page. What goes on naming a file is a letter or digit in any script, one of
// `_ - ~ + # $ @ % & =`, an opening bracket, or a path separator (`page.tsx/old.tsx` is a file in a FOLDER
// of that name) — or a `.` or `:` before one of those (`page.tsx.bak`, the NTFS stream `page.tsx:alt`).
// Anything else ends it: a blank, the end, sentence punctuation, a quote, a dash or a closing mark in any
// script (`”`, `»`, `<br>`). The rule says what CONTINUES a name, not what ends one, because a path the
// fallback cannot end is skipped and the next one in the document wins — which may be a path quoted in the
// page's own prompt.
const NAME_GOES_ON = String.raw`[\p{L}\p{N}_\-~+#$@%&=(\[{/\\]`;
const PAGE_END = `(?!${NAME_GOES_ON}|[.:]+${NAME_GOES_ON})`;
// The File line reads the same way; a note after the path (` (edit)`) is not part of it. The page folder may
// come after a path (`D:\work\edit\<guid>\page.tsx`, `./<guid>/page.tsx`), which a planner writing the
// plan's absolute path beside it can easily carry over: only the GUID is compared, so it changes nothing.
const FILE_LINE = new RegExp(`^[ \\t]*[-*+][ \\t]+\\*\\*File:\\*\\*[ \\t]*\`?(?:[^\\r\\n\`]*[\\\\/])?(${GUID})[\\\\/]page\\.tsx${PAGE_END}`, 'imu');
// The preview's own block, or null when there is none. Its File line is read there only: the preview also
// quotes the page's prompt, and a `- **File:** <other>/page.tsx` bullet in that quote, placed ahead of the
// block, decided the target.
function currentStateBlock(src) {
  const state = /^###[ \t]+Current State[ \t]*$/im.exec(src);
  if (!state) return null;
  const rest = src.slice(state.index + state[0].length);
  const next = /^#{1,3}[ \t]+\S/m.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}
// `kind` is what the flow says the document is ('create' | 'edit' — see planKindOf), or null to read it from
// the document itself. With a kind, only that kind's target is read.
function planTargets(text, { kind = null } = {}) {
  const src = String(text || '');
  if (kind !== 'edit') {
    // A Pages table decides "create" first when the kind is not known: an edit plan has none of its own,
    // while a create plan's per-page `- **File:**` lines could hold a `<guid>/page.tsx` path and be misread
    // as an edit target. Each file is compared in the page-file rule's own spelling, `.` segments dropped:
    // `./overview.tsx` in the preview and `overview.tsx` in the written plan name the same page.
    // Read by the page-file gate's own rule, `## Pages` in the written plan and `### Pages (N total)` in the
    // preview alike. More than one table with a File column names nothing — a Pages table quoted in the
    // requirements used to stand in for the real one (lib/page-file-targets.js pagesSections).
    const tables = pagesSections(src).filter(Boolean);
    if (tables.length > 1) return null;
    const files = tables[0];
    if (files && files.length) return { kind: 'create', targets: files.map((f) => path.posix.normalize(f.trim())).sort() };
    // A create plan is read by its Pages table alone: without one it names nothing, never a page id its text
    // happens to hold.
    if (kind === 'create') return null;
  }
  // The edit target is the page's GUID: the written plan's `- **Page ID:** <guid>`, or else the GUID
  // folder directly before `page.tsx`, which both the preview's `- **File:** <guid>/page.tsx` and the
  // written plan's `- **Absolute path:** <working-dir>/<guid>/page.tsx` carry.
  const section = /^##[ \t]+File Being Edited[ \t]*$/im.exec(src);
  if (section) {
    const rest = src.slice(section.index + section[0].length);
    const next = /^#{1,2}[ \t]+\S/m.exec(rest);
    const labels = labelledPageIds(next ? rest.slice(0, next.index) : rest);
    if (labels.length) return labels.every((id) => id && id === labels[0]) ? { kind: 'edit', targets: [labels[0]] } : null;
  } else {
    const state = currentStateBlock(src);
    const file = FILE_LINE.exec(state === null ? src : state);
    if (file) return { kind: 'edit', targets: [file[1].toLowerCase()] };
    if (state !== null) return null;
    const [first] = labelledPageIds(src, { lineStart: true });
    if (first !== undefined) return first ? { kind: 'edit', targets: [first] } : null;
  }
  const folder = src.match(new RegExp(`(?<![\\w-])(${GUID})[\\\\/]page\\.tsx${PAGE_END}`, 'u'));
  if (folder) return { kind: 'edit', targets: [folder[1].toLowerCase()] };
  return null;
}

// What is AT `p` — lstat, not existsSync. existsSync follows a link and answers false for a DANGLING
// one, so a planted link at the plan path read as "no plan here" and stayed in place for the planner
// to write through. null when there is nothing there at all.
function entryAt(p) {
  try { return fs.lstatSync(p); } catch (e) { if (e && e.code === 'ENOENT') return null; throw e; }
}

function uniquePath(basePath) {
  if (!entryAt(basePath)) return basePath;
  const parsed = path.parse(basePath);
  for (let i = 1; i < 1000; i += 1) {
    const candidate = path.join(parsed.dir, `${parsed.name}-${i}${parsed.ext}`);
    if (!entryAt(candidate)) return candidate;
  }
  throw new Error(`could not allocate quarantine path for ${basePath}`);
}

// Both paths this touches are refused when they are links (dangling ones included) or not the kind of
// entry they should be. The planner writes THROUGH a link at the plan path, putting the approved plan
// wherever it points; and mkdir({ recursive }) plus rename both follow a link at `.genpage-provenance`,
// which moved the stale plan outside the working directory. The workflow never creates either link, so
// refusing costs a legitimate run nothing. Every failure is an `ok:false` result, never a throw.
function preparePlanProvenance({ planPath }) {
  if (!planPath) return { ok: false, error: '--plan is required' };
  const absPlanPath = path.resolve(planPath);
  const refuse = (error) => ({ ok: false, action: 'prepare', planPath: absPlanPath, error });
  try {
    // The working directory ITSELF must not be a link — the rule the page-file gate and the manifest
    // generator apply to the same directory. With the plan absent this returned ok at once, and the planner
    // then wrote the plan, and the orchestrator its approval sidecar, wherever a link planted there points.
    // A linked ANCESTOR is still followed, a normal setup (macOS temp dirs sit under a symlinked /var).
    const workingDir = path.dirname(absPlanPath);
    const dir = entryAt(workingDir);
    if (dir && dir.isSymbolicLink()) {
      return refuse(`${workingDir} is a symbolic link or junction — pass the directory it points to as the working directory`);
    }
    // The approval sidecar the skill has the orchestrator write next to the plan
    // (`.approved-genpage-plan.md`, `.approved-genpage-edit-plan.md`) is written IN PLACE after this
    // runs, so a link there — or a hard link, whose other name the write would rewrite — puts the approved
    // body wherever it points. Refused here, before anything is written, like a link at the plan path.
    const sidecarPath = path.join(path.dirname(absPlanPath), `.approved-${path.basename(absPlanPath)}`);
    const sidecar = entryAt(sidecarPath);
    if (sidecar && (!sidecar.isFile() || sidecar.nlink > 1)) {
      return refuse(`${sidecarPath} is not a plain file (a link, junction, hard link or folder) — remove it and re-run; the approved plan would be written through it`);
    }
    const plan = entryAt(absPlanPath);
    if (!plan) return { ok: true, action: 'prepare', planPath: absPlanPath, quarantinedPath: null };
    if (plan.isSymbolicLink()) return refuse(`${absPlanPath} is a symbolic link or junction — remove it and re-run; the planner would write the plan through it`);
    if (!plan.isFile()) return refuse(`${absPlanPath} is not a regular file — remove it and re-run`);
    // A HARD link is a plain file to lstat, yet quarantining it only renames this name: the plan stays
    // reachable through its other names, outside the working directory included — the sidecar rule, here.
    if (plan.nlink > 1) return refuse(`${absPlanPath} is a hard link (${plan.nlink} names for one file) — remove it and re-run`);
    const quarantineDir = path.join(path.dirname(absPlanPath), '.genpage-provenance');
    const quarantine = entryAt(quarantineDir);
    // lstat never reports a link as a directory, so this refuses a link, a junction and a file alike.
    if (quarantine && !quarantine.isDirectory()) {
      return refuse(`${quarantineDir} is not a plain directory (a link, junction or file) — remove it and re-run`);
    }
    if (!quarantine) fs.mkdirSync(quarantineDir);
    const stale = fs.readFileSync(absPlanPath, 'utf8');
    const staleHash = sha256(stale);
    const parsed = path.parse(absPlanPath);
    const quarantinedPath = uniquePath(path.join(quarantineDir, `${parsed.name}.stale-${staleHash.slice(0, 12)}${parsed.ext || '.md'}`));
    fs.renameSync(absPlanPath, quarantinedPath);
    return { ok: true, action: 'prepare', planPath: absPlanPath, quarantinedPath, staleHash };
  } catch (e) {
    return refuse(`could not quarantine the earlier plan: ${e.message}`);
  }
}

// Which kind of plan a path holds is the flow's choice, not the document's: /genpage writes a create plan to
// `genpage-plan.md` and an edit plan to `genpage-edit-plan.md` (skills/genpage/SKILL.md and edit-flow.md), and
// neither the planner nor the maker's text names the file. The document cannot say it reliably: an edit plan
// quotes the page's earlier prompts, and a Pages table quoted there — in the preview's prompt snippet and the
// written plan's `## Original Page Context` alike — read both as the same create, so an edit of ANOTHER page
// was certified. null for any other name, which is then read from the document as before.
function planKindOf(planPath) {
  const name = path.basename(String(planPath || '')).toLowerCase();
  if (name === 'genpage-edit-plan.md') return 'edit';
  if (name === 'genpage-plan.md') return 'create';
  return null;
}

function verifyPlanProvenance({ planPath, approvedPlan }) {
  if (!planPath) return { ok: false, error: '--plan is required' };
  if (approvedPlan == null) return { ok: false, error: '--approved is required' };
  const absPlanPath = path.resolve(planPath);
  const kind = planKindOf(absPlanPath);
  const approved = planTargets(approvedPlan, { kind });
  if (!approved) {
    return {
      ok: false,
      action: 'verify',
      planPath: absPlanPath,
      error: 'the approved plan body names no pages — save the plan body the planner returned for approval (its Pages table, or the Current State file of an edit) as the --approved file',
    };
  }
  // The file this certifies must be the one written in place: a link would have it vouch for a
  // document that lives somewhere else.
  let entry;
  try { entry = entryAt(absPlanPath); } catch (e) {
    return { ok: false, action: 'verify', planPath: absPlanPath, approvedTargets: approved.targets, error: `could not inspect ${absPlanPath}: ${e.message}` };
  }
  if (!entry) {
    return { ok: false, action: 'verify', planPath: absPlanPath, approvedTargets: approved.targets, error: `planner did not write ${absPlanPath}` };
  }
  // lstat reports a link as a link, never as a file, so this refuses links and folders alike — and a hard
  // link, whose other names the planner's write would have rewritten too.
  if (!entry.isFile() || entry.nlink > 1) {
    return { ok: false, action: 'verify', planPath: absPlanPath, approvedTargets: approved.targets, error: `${absPlanPath} is not a plain file (a link, junction, hard link or folder) — the plan must be written in place` };
  }
  let written;
  try { written = fs.readFileSync(absPlanPath, 'utf8'); } catch (e) {
    return { ok: false, action: 'verify', planPath: absPlanPath, approvedTargets: approved.targets, error: `could not read ${absPlanPath}: ${e.message}` };
  }
  // Recorded, not compared: an audit line for workflow-log.md naming the exact file that was verified.
  const writtenHash = sha256(written);
  const actual = planTargets(written, { kind });
  const same = actual && actual.kind === approved.kind
    && actual.targets.length === approved.targets.length
    && actual.targets.every((t, i) => t === approved.targets[i]);
  if (!same) {
    return {
      ok: false,
      action: 'verify',
      planPath: absPlanPath,
      approvedTargets: approved.targets,
      writtenTargets: actual ? actual.targets : [],
      writtenHash,
      error: `the written plan targets ${actual ? actual.targets.join(', ') || 'nothing' : 'no pages'}, but the approved plan named ${approved.targets.join(', ')}`,
    };
  }
  return { ok: true, action: 'verify', planPath: absPlanPath, kind: approved.kind, targets: approved.targets, writtenHash };
}

function parseArgv(argv) {
  const out = { command: argv[0] || '' };
  for (let i = 1; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) continue;
    out[key.slice(2)] = argv[i + 1];
    i += 1;
  }
  return out;
}

// The approved body comes from a file the orchestrator wrote. It must be that file, written in place — a
// link would have the gate compare against whatever it points at.
function readApproved(value) {
  if (!(value && value.startsWith('@'))) return value;
  const file = path.resolve(value.slice(1));
  if (!fs.lstatSync(file).isFile()) throw new Error(`${file} is not a regular file (a link, junction or folder) — the approved plan must be written in place`);
  return fs.readFileSync(file, 'utf8');
}

function main() {
  const args = parseArgv(process.argv.slice(2));
  let result;
  if (args.command === 'prepare') {
    result = preparePlanProvenance({ planPath: args.plan });
  } else if (args.command === 'verify') {
    let approvedPlan;
    try {
      approvedPlan = readApproved(args.approved);
      result = verifyPlanProvenance({ planPath: args.plan, approvedPlan });
    } catch (e) {
      result = { ok: false, action: 'verify', error: `could not read the approved plan: ${e.message}` };
    }
  } else {
    result = { ok: false, error: 'Usage: node genpage-plan-provenance.js prepare --plan <path> OR verify --plan <path> --approved @<approved-plan-file>' };
  }

  process.stdout.write(JSON.stringify(result) + '\n');
  process.exit(result.ok ? 0 : (args.command === 'prepare' || args.command === 'verify' ? 3 : 1));
}

if (require.main === module) main();

module.exports = { preparePlanProvenance, verifyPlanProvenance, planTargets, sha256 };
