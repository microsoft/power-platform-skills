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
const GUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
function planTargets(text) {
  const src = String(text || '');
  // A Pages table decides "create" first: edit plans never have one, while a create plan's per-page
  // `- **File:**` lines could hold a `<guid>/page.tsx` path and be misread as an edit target.
  const files = pageFilesFromPlan(src, { heading: /^#{2,3}\s+Pages\b/ });
  if (files && files.length) return { kind: 'create', targets: files.map((f) => f.trim()).sort() };
  // The edit target is the page's GUID: the written plan's `- **Page ID:** <guid>`, or else the GUID
  // folder directly before `page.tsx`, which both the preview's `- **File:** <guid>/page.tsx` and the
  // written plan's `- **Absolute path:** <working-dir>/<guid>/page.tsx` carry.
  const id = src.match(new RegExp(`\\*\\*Page ID:\\*\\*\\s*\`?\\{?(${GUID})`)) || src.match(new RegExp(`(${GUID})[\\\\/]page\\.tsx`));
  if (id) return { kind: 'edit', targets: [id[1].toLowerCase()] };
  return null;
}

function uniquePath(basePath) {
  if (!fs.existsSync(basePath)) return basePath;
  const parsed = path.parse(basePath);
  for (let i = 1; i < 1000; i += 1) {
    const candidate = path.join(parsed.dir, `${parsed.name}-${i}${parsed.ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`could not allocate quarantine path for ${basePath}`);
}

function preparePlanProvenance({ planPath }) {
  if (!planPath) return { ok: false, error: '--plan is required' };
  const absPlanPath = path.resolve(planPath);
  if (!fs.existsSync(absPlanPath)) {
    return { ok: true, action: 'prepare', planPath: absPlanPath, quarantinedPath: null };
  }

  const stale = fs.readFileSync(absPlanPath, 'utf8');
  const staleHash = sha256(stale);
  const quarantineDir = path.join(path.dirname(absPlanPath), '.genpage-provenance');
  fs.mkdirSync(quarantineDir, { recursive: true });
  const parsed = path.parse(absPlanPath);
  const quarantinedPath = uniquePath(path.join(quarantineDir, `${parsed.name}.stale-${staleHash.slice(0, 12)}${parsed.ext || '.md'}`));
  fs.renameSync(absPlanPath, quarantinedPath);
  return { ok: true, action: 'prepare', planPath: absPlanPath, quarantinedPath, staleHash };
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
  if (!fs.existsSync(absPlanPath)) {
    return { ok: false, action: 'verify', planPath: absPlanPath, approvedTargets: approved.targets, error: `planner did not write ${absPlanPath}` };
  }
  const written = fs.readFileSync(absPlanPath, 'utf8');
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

function readApproved(value) {
  if (value && value.startsWith('@')) return fs.readFileSync(path.resolve(value.slice(1)), 'utf8');
  return value;
}

function main() {
  const args = parseArgv(process.argv.slice(2));
  let result;
  if (args.command === 'prepare') {
    result = preparePlanProvenance({ planPath: args.plan });
  } else if (args.command === 'verify') {
    result = verifyPlanProvenance({ planPath: args.plan, approvedPlan: readApproved(args.approved) });
  } else {
    result = { ok: false, error: 'Usage: node genpage-plan-provenance.js prepare --plan <path> OR verify --plan <path> --approved @<approved-plan-file>' };
  }

  process.stdout.write(JSON.stringify(result) + '\n');
  process.exit(result.ok ? 0 : (args.command === 'prepare' || args.command === 'verify' ? 3 : 1));
}

if (require.main === module) main();

module.exports = { preparePlanProvenance, verifyPlanProvenance, planTargets, sha256 };
