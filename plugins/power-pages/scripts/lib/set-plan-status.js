#!/usr/bin/env node
'use strict';

// set-plan-status.js — the single deterministic owner of the CREATION-TIME ALM
// plan status write (`Draft` / `Approved`).
//
// Background / why this exists:
//   The plan-status badge and the "Approved by" stamp in docs/alm-plan.html are
//   BOTH re-derived from docs/.alm-plan-data.json every time the plan is rendered
//   (render-alm-plan.js reads PLAN_STATUS / APPROVED_BY / APPROVAL_DATE). Every
//   OTHER status transition is owned by a deterministic helper:
//     - Approved -> In Execution : check-alm-plan.js  (first execution skill)
//     - In Execution -> Completed: refresh-alm-plan-data.js (evaluatePlanCompletion)
//   ...but the Draft/Approved write was historically done by HAND-AUTHORED Edits
//   in plan-alm Phase 4 — to two places (the HTML spans AND the JSON), with no
//   helper. That produced two real bugs:
//     1. Editing the HTML span is non-durable — the next refresh re-derives the
//        badge from plan-data and reverts it if plan-data wasn't also updated.
//     2. A partial write (APPROVED_BY set in plan-data but PLAN_STATUS left at
//        "Draft") leaves the plan shown-as-approved but stuck on Draft forever,
//        because check-alm-plan.js only promotes from "Approved".
//   This helper makes plan-data the single source of truth and writes all four
//   fields together (atomically), so neither bug can recur. Phase 4 (and the
//   in-place Draft->Approved fast-path) call this instead of hand-editing.
//
// Usage:
//   node set-plan-status.js --projectRoot <root> --status Approved --approver "Jane Doe" [--render]
//   node set-plan-status.js --projectRoot <root> --status Draft [--render]
//   node set-plan-status.js --projectRoot <root> --status Draft --force   (re-draft a running plan)
//
// Output (JSON to stdout):
//   { "ok": true, "projectRoot": "...", "previousStatus": "Draft", "status": "Approved",
//     "mode": "approved", "approver": "Jane Doe", "approvalDate": "2026-…Z", "rendered": true }
//
// Exit 0 on success, exit 1 on any validation error (missing plan, bad status,
// Approved-without-approver, or a refused regression of a live plan).

const fs = require('fs');
const { planDataPath, planHtmlPath } = require('./alm-paths');
// Reuse the SAME renderer-invocation as the post-run refresh, rather than
// re-implementing the execFileSync call. Requiring this module is side-effect
// free (its CLI body is guarded by `require.main === module`).
const { findRendererPath, invokeRenderer } = require('./refresh-alm-plan-data');

// The two statuses this helper owns. In Execution / Completed are owned by
// check-alm-plan.js and refresh-alm-plan-data.js respectively and must NOT be
// settable here — that would let a caller fabricate lifecycle state.
const CREATION_STATUSES = new Set(['Draft', 'Approved']);
// A plan in one of these states is past the creation/approval stage; re-writing
// it back to Draft/Approved would erase live execution state, so it is refused
// unless --force is passed.
const LIVE_STATUSES = new Set(['In Execution', 'Completed']);

/**
 * Atomically set the creation-time plan status in docs/.alm-plan-data.json.
 *
 * @param {object} opts
 * @param {string} opts.projectRoot
 * @param {'Draft'|'Approved'} opts.status
 * @param {string} [opts.approver]      required (non-empty) when status === 'Approved'
 * @param {string} [opts.approvalDate]  ISO string; defaults to now when status === 'Approved'
 * @param {boolean} [opts.force]        allow overwriting an In Execution / Completed plan
 * @param {boolean} [opts.render]       re-render docs/alm-plan.html after writing
 * @param {string} [opts.rendererPath]  override the renderer path (tests)
 * @param {() => string} [opts.makeNow] injectable clock (tests); returns an ISO string
 * @returns {{ ok: true, projectRoot, previousStatus, status, mode, approver, approvalDate, rendered }}
 */
function setPlanStatus(opts) {
  const {
    projectRoot,
    status,
    approver,
    approvalDate,
    force = false,
    render = false,
    rendererPath = null,
    makeNow = () => new Date().toISOString(),
  } = opts || {};

  if (!projectRoot) throw new Error('--projectRoot is required');
  if (!CREATION_STATUSES.has(status)) {
    throw new Error(
      `--status must be one of: ${[...CREATION_STATUSES].join(', ')} ` +
      `(got ${JSON.stringify(status)}). "In Execution"/"Completed" are owned by ` +
      'check-alm-plan.js / refresh-alm-plan-data.js, not this helper.',
    );
  }

  const dataPath = planDataPath(projectRoot);
  if (!fs.existsSync(dataPath)) {
    throw new Error(`No ALM plan found at ${dataPath}. Run /power-pages:plan-alm first.`);
  }

  let planData;
  try {
    planData = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  } catch (e) {
    throw new Error(`Could not parse ${dataPath}: ${e.message}`);
  }

  const previousStatus = planData.PLAN_STATUS || null;

  // Never silently erase live execution state. A plan that has started executing
  // (In Execution) or finished (Completed) should not be quietly reset to a
  // creation-time status — that would drop heartbeat/step state and confuse the
  // downstream gates. Require an explicit --force to override.
  if (LIVE_STATUSES.has(previousStatus) && !force) {
    throw new Error(
      `Refusing to set status to "${status}": the plan is already "${previousStatus}". ` +
      'Pass --force to override (this discards live execution state).',
    );
  }

  const approverTrimmed = (approver || '').trim();
  let mode;
  let finalApprover;
  let finalApprovalDate;

  if (status === 'Approved') {
    // Approved without an approver is exactly the half-written state the
    // consistency guard flags — refuse to create it here.
    if (!approverTrimmed) {
      throw new Error('--approver is required (and must be non-empty) when --status is Approved.');
    }
    mode = 'approved';
    finalApprover = approverTrimmed;
    finalApprovalDate = (approvalDate && approvalDate.trim()) || makeNow();
  } else {
    // Draft: per plan-alm Phase 4 option 2, a draft does NOT carry an approver.
    // Clear any stale approver fields so we never leave "Draft + approver" behind.
    mode = 'draft';
    finalApprover = '';
    finalApprovalDate = '';
  }

  planData.PLAN_STATUS = status;
  planData.PLAN_MODE = mode;
  planData.APPROVED_BY = finalApprover;
  planData.APPROVAL_DATE = finalApprovalDate;

  // Stage the new plan-data to a temp file (don't commit it yet). Atomicity
  // matters two ways: (1) a crash mid-write can't truncate the plan file every
  // downstream Phase 0 gate depends on; (2) when --render is requested, a renderer
  // failure must leave BOTH docs/.alm-plan-data.json AND docs/alm-plan.html
  // unchanged — otherwise the status write lands, the HTML stays stale, the CLI
  // exits non-zero, and a caller that commits docs/ ships a new JSON beside a
  // stale HTML. So we render FROM the staged temp into a temp HTML first, and only
  // swap both into place after a clean render. Without --render, just commit the JSON.
  const dataTmp = dataPath + '.tmp';
  fs.writeFileSync(dataTmp, JSON.stringify(planData, null, 2));

  let rendered = false;
  if (render) {
    const htmlPath = planHtmlPath(projectRoot);
    const htmlTmp = htmlPath + '.tmp';
    try {
      invokeRenderer(findRendererPath(rendererPath), dataTmp, htmlTmp);
    } catch (e) {
      // Render failed — discard both staged files so nothing changed on disk.
      try { fs.unlinkSync(dataTmp); } catch {}
      try { fs.unlinkSync(htmlTmp); } catch {}
      throw e;
    }
    // Both products are ready: commit the HTML then the JSON. A crash BETWEEN these
    // two same-dir renames (vanishingly unlikely in one process) would leave the new
    // HTML in place with the JSON still old — "HTML ahead of JSON". That's benign and
    // self-healing: the next render re-derives the HTML from whatever the JSON says,
    // and no file is ever torn (each rename is atomic). It is the inverse of the
    // original pre-atomic bug (new JSON + stale HTML), and harmless in the same way.
    fs.renameSync(htmlTmp, htmlPath);
    rendered = true;
  }
  // Commit the JSON. If this final rename ever fails (e.g. a transient lock on the
  // plan file), unlink the staged temp so we don't leave an orphaned
  // `.alm-plan-data.json.tmp` behind, then rethrow so the caller sees the failure.
  try {
    fs.renameSync(dataTmp, dataPath);
  } catch (e) {
    try { fs.unlinkSync(dataTmp); } catch {}
    throw e;
  }

  return {
    ok: true,
    projectRoot,
    previousStatus,
    status,
    mode,
    approver: finalApprover,
    approvalDate: finalApprovalDate,
    rendered,
  };
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = {
    projectRoot: null, status: null, approver: null, approvalDate: null,
    force: false, render: false, rendererPath: null,
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--projectRoot' && args[i + 1]) out.projectRoot = args[++i];
    else if (args[i] === '--status' && args[i + 1]) out.status = args[++i];
    else if (args[i] === '--approver' && args[i + 1]) out.approver = args[++i];
    else if (args[i] === '--approvalDate' && args[i + 1]) out.approvalDate = args[++i];
    else if (args[i] === '--force') out.force = true;
    else if (args[i] === '--render') out.render = true;
    else if (args[i] === '--rendererPath' && args[i + 1]) out.rendererPath = args[++i];
  }
  return out;
}

if (require.main === module) {
  try {
    const result = setPlanStatus(parseArgs(process.argv));
    process.stdout.write(JSON.stringify(result) + '\n');
    process.exit(0);
  } catch (err) {
    process.stderr.write(`set-plan-status: ${err.message}\n`);
    process.exit(1);
  }
}

module.exports = { setPlanStatus, parseArgs, CREATION_STATUSES, LIVE_STATUSES };
