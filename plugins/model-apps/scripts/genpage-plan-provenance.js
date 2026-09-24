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
const { pageFilesFromPlan } = require('./lib/page-file-targets.js');

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
// document without the section is read by that File line, then by a label that BEGINS a line (under the
// same rule), and only then by any `<guid>/page.tsx` path.
const GUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const LABELLED_ID = new RegExp(`^\`?\\{?(${GUID})\\}?\`?(?![\\w-])`);
function labelledPageIds(text, { lineStart = false } = {}) {
  const label = lineStart ? /^[ \t]*(?:[-*+][ \t]+)?\*\*Page ID:\*\*[ \t]*([^\r\n]*)/gm : /\*\*Page ID:\*\*[ \t]*([^\r\n]*)/g;
  return [...text.matchAll(label)].map((m) => {
    const id = LABELLED_ID.exec(m[1].trim());
    return id ? id[1].toLowerCase() : null;
  });
}
const FILE_LINE = new RegExp(`^[ \\t]*[-*+][ \\t]+\\*\\*File:\\*\\*[ \\t]*\`?(${GUID})[\\\\/]page\\.tsx\\b`, 'im');
function planTargets(text) {
  const src = String(text || '');
  // A Pages table decides "create" first: edit plans never have one, while a create plan's per-page
  // `- **File:**` lines could hold a `<guid>/page.tsx` path and be misread as an edit target. Each file
  // is compared in the page-file rule's own spelling, `.` segments dropped: `./overview.tsx` in the
  // preview and `overview.tsx` in the written plan name the same page.
  const files = pageFilesFromPlan(src, { heading: /^#{2,3}\s+Pages\b/ });
  if (files && files.length) return { kind: 'create', targets: files.map((f) => path.posix.normalize(f.trim())).sort() };
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
    const file = FILE_LINE.exec(src);
    if (file) return { kind: 'edit', targets: [file[1].toLowerCase()] };
    const [first] = labelledPageIds(src, { lineStart: true });
    if (first !== undefined) return first ? { kind: 'edit', targets: [first] } : null;
  }
  const folder = src.match(new RegExp(`(?<![\\w-])(${GUID})[\\\\/]page\\.tsx`));
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

function verifyPlanProvenance({ planPath, approvedPlan }) {
  if (!planPath) return { ok: false, error: '--plan is required' };
  if (approvedPlan == null) return { ok: false, error: '--approved is required' };
  const absPlanPath = path.resolve(planPath);
  const approved = planTargets(approvedPlan);
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
  // lstat reports a link as a link, never as a file, so this refuses links and folders alike.
  if (!entry.isFile()) {
    return { ok: false, action: 'verify', planPath: absPlanPath, approvedTargets: approved.targets, error: `${absPlanPath} is not a regular file (a link, junction or folder) — the plan must be written in place` };
  }
  let written;
  try { written = fs.readFileSync(absPlanPath, 'utf8'); } catch (e) {
    return { ok: false, action: 'verify', planPath: absPlanPath, approvedTargets: approved.targets, error: `could not read ${absPlanPath}: ${e.message}` };
  }
  // Recorded, not compared: an audit line for workflow-log.md naming the exact file that was verified.
  const writtenHash = sha256(written);
  const actual = planTargets(written);
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
