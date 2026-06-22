#!/usr/bin/env node

// Refreshes docs/.alm-plan-data.json with post-run state from the marker
// files written by setup-pipeline / deploy-pipeline / ensure-pipelines-host /
// test-site, then optionally invokes the renderer.
//
// Plan-alm Phase 3 writes the planData JSON once at plan generation time,
// reflecting pre-run intent (e.g. hostResolution.status: "NoHost",
// risks: ["No Pipelines host detected — setup-pipeline will provision..."]).
// After each run step actually executes, the rendered HTML stays frozen at
// pre-run state unless the planData is refreshed and re-rendered.
//
// This helper centralizes the refresh so the SKILL.md prose can stay short
// and the agent doesn't have to inline shape transforms each time.
//
// Usage:
//   node refresh-alm-plan-data.js
//     --projectRoot <path>
//     --phase <setup-solution|setup-pipeline|deploy-pipeline|export-solution|import-solution|activate-site|test-site|finalize>
//     [--render]                  also invoke render-alm-plan.js after writing
//     [--rendererPath <path>]     defaults to skills/plan-alm/scripts/render-alm-plan.js
//                                 relative to plugin root
//
// What gets refreshed per phase:
//   setup-solution:
//     - plan footer status (no change — stays "In Execution")
//   setup-pipeline:
//     - hostResolution from docs/alm/last-host-check.json
//     - pipelineMeta from docs/alm/last-pipeline.json (no lastDeploy yet)
//     - drop pre-run NoHost / *Unbound* warnings from risks[]
//   deploy-pipeline:
//     - pipelineMeta.lastDeploy from docs/alm/last-deploy.json
//     - drop pre-run "Pipelines host not yet provisioned" warnings (defensive)
//   test-site:
//     - validationRuns[stage] from docs/alm/last-test-site.json (if present)
//   finalize:
//     - PLAN_STATUS = "Completed"
//
// After every phase's step-sync, a completion evaluator flips PLAN_STATUS to
// "Completed" (+ COMPLETED_AT) once all non-skip steps are completed and none
// failed — so the last execution skill terminates the plan automatically,
// without any skill needing to call the explicit "finalize" phase. The
// Approved -> In Execution promotion that starts the lifecycle lives in
// check-alm-plan.js (first execution-skill Phase 0).
//
// stdout JSON includes `nextStep: { name, skill: string | null } | null` (when ok:true) — the first
// still-pending checklist step and the slash command that runs it. Execution
// skills echo this so the user knows the next step to invoke (user-driven
// sequencing — never auto-fired). null when every step is complete.
//
// Exit 0 on success (including no-op when planData missing — caller decides).
// Exit 1 on argparse / fatal error.

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { almPath, planDataPath, planHtmlPath } = require('./alm-paths');

const PHASES = new Set([
  'setup-solution',
  'setup-pipeline',
  // configure-env-variables: invoked when the user runs the standalone
  // /power-pages:configure-env-variables skill (or when setup-solution
  // delegates to it). The refresh re-reads docs/alm/last-env-vars.json
  // (if setup-solution's Phase 6.2b sidecar exists or configure-env-variables
  // wrote its own equivalent) AND backfills planData.envVars[i].values{}
  // from the freshly-written deployment-settings.json so the rendered plan
  // shows both the created definitions and their per-stage values.
  'configure-env-variables',
  'deploy-pipeline',
  // Manual-path phases (export/import/activate). For PP Pipelines path the
  // deploy is a single 'deploy-pipeline' phase that covers import + activate
  // implicitly; for Manual path each step is a separate phase. Each handler
  // is intentionally minimal — the main work the refresh-and-render does for
  // Manual path is re-rendering the HTML so the agent's step-status updates
  // (planData.steps[i].status) flow through. Per-stage data ingestion (e.g.
  // last-import.json with import outcomes per target) can be added later
  // without changing the phase set.
  'export-solution',
  'import-solution',
  'activate-site',
  'test-site',
  'ensure-pipelines-host',
  'finalize',
]);

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = {
    projectRoot: process.cwd(),
    phase: null,
    render: false,
    rendererPath: null,
    stageName: null,
    reconcile: false,
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--projectRoot' && args[i + 1]) out.projectRoot = args[++i];
    else if (args[i] === '--phase' && args[i + 1]) out.phase = args[++i];
    else if (args[i] === '--render') out.render = true;
    else if (args[i] === '--rendererPath' && args[i + 1]) out.rendererPath = args[++i];
    else if (args[i] === '--stageName' && args[i + 1]) out.stageName = args[++i];
    else if (args[i] === '--reconcile') out.reconcile = true;
  }
  return out;
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

// Map docs/alm/last-host-check.json's resolutionStatus to plan-alm's hostResolution.status.
// Pass-through when the value already matches plan-alm's enum; the wrappers
// emit the same names today, but we keep this map explicit so the SKILL.md
// contract stays clear. ensure-pipelines-host post-run typically reports
// "AvailableUsingCustomHost" (the new host is now bound to the source env).
function buildHostResolutionFromCheck(check) {
  if (!check || typeof check !== 'object') return null;
  return {
    status: check.resolutionStatus || 'DetectionFailed',
    hostEnvUrl: check.finalHostEnvUrl || null,
    hostEnvId: check.finalHostEnvId || null,
    hostEnvName: check.finalHostEnvName || null,    // BAP env displayName — surfaces in the renderer's host card so the env is identifiable by name, not by URL alone
    hostType: check.hostType || null,
    pipelinesSolutionVersion: check.pipelinesSolutionVersion || null,
    candidatesCount: check.candidates?.existingCustomHosts?.length || 0,
    willEnsureDuringExecution: false,        // post-run: nothing left to ensure
    willProvisionPlatform: false,
    willProvisionCustom: false,
    willUsePpac: false,
    chosenEnvUrl: null,
    userChoseDeferToSetupPipeline: false,
  };
}

// Reads `deployment-settings.json` from the project root. Returns null when
// missing or malformed — callers degrade to "no per-stage backfill" rather
// than throwing. deploy-pipeline Phase 5 writes/reads this file; the user
// can also hand-edit it. The file is the source of truth for per-stage env
// var override values.
function readDeploymentSettings(projectRoot) {
  if (!projectRoot) return null;
  try {
    const filePath = path.join(projectRoot, 'deployment-settings.json');
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

// Pivot deployment-settings.json into `{ schemaName: { stageName: value, ... } }`.
// Accepts two shapes observed in the wild:
//   - top-level stage keys: `{ "Staging": { "EnvironmentVariables": [...] }, "Production": {...} }`
//     (deploy-pipeline SKILL.md Phase 5.0a template)
//   - nested under `stages`:  `{ "stages": { "Staging": {...} } }`
//     (deploy-pipeline SKILL.md Phase 5.1 read path)
// Also accepts both casings on inner keys: `SchemaName`/`Value` (per the
// platform's deploymentsettingsjson schema) and `schemaName`/`value` (camelCase
// for parity with planData). Empty-string values are skipped so a template
// row that the user hasn't filled in yet doesn't clobber a real value
// already on `ev.values[stageName]`.
function extractPerStageValues(deploymentSettings) {
  if (!deploymentSettings || typeof deploymentSettings !== 'object') return null;
  const stagesContainer = deploymentSettings.stages && typeof deploymentSettings.stages === 'object'
    ? deploymentSettings.stages
    : deploymentSettings;

  const bySchema = {};
  for (const [stageName, stageBlock] of Object.entries(stagesContainer)) {
    if (!stageBlock || typeof stageBlock !== 'object') continue;
    // Guard against the user mixing the two shapes — if the value at the
    // root is itself the inner `EnvironmentVariables` array (rare but
    // possible from a hand-edit), skip; we only walk stage-shaped values.
    if (Array.isArray(stageBlock)) continue;
    if (stageName === 'stages' || stageName === 'EnvironmentVariables' ||
        stageName === 'ConnectionReferences') continue;

    const envVars = stageBlock.EnvironmentVariables || stageBlock.environmentVariables;
    if (!Array.isArray(envVars)) continue;
    for (const ev of envVars) {
      if (!ev || typeof ev !== 'object') continue;
      const schemaName = ev.SchemaName || ev.schemaName;
      const rawValue = ev.Value != null ? ev.Value : ev.value;
      if (!schemaName) continue;
      if (rawValue == null || rawValue === '') continue;
      const strValue = String(rawValue);
      bySchema[schemaName] = bySchema[schemaName] || {};
      bySchema[schemaName][stageName] = strValue;
    }
  }
  return bySchema;
}

// Backfill planData.envVars[i].values{} from deployment-settings.json so
// the rendered plan's "Values by Environment" matrix auto-populates after
// deploy-pipeline runs. Idempotent: an existing non-empty value on
// ev.values[stageName] is preserved (manual overrides win). Returns the
// number of cells filled in this call.
//
// TODO(follow-up): also query the live `environmentvariablevalues` table
// per target env so values set in Power Platform Admin Center (bypassing
// the file) show up. Needs per-stage tokens + env var definition GUIDs,
// neither of which the helper currently has — deferring until those
// inputs are wired through the refresh contract.
function backfillEnvVarValuesFromSettings(planData, projectRoot) {
  if (!Array.isArray(planData.envVars) || planData.envVars.length === 0) return 0;
  const settings = readDeploymentSettings(projectRoot);
  if (!settings) return 0;
  const bySchema = extractPerStageValues(settings);
  if (!bySchema || Object.keys(bySchema).length === 0) return 0;

  let filled = 0;
  for (const ev of planData.envVars) {
    if (!ev || typeof ev.schemaName !== 'string') continue;
    const matches = bySchema[ev.schemaName];
    if (!matches) continue;
    ev.values = (ev.values && typeof ev.values === 'object') ? ev.values : {};
    for (const [stageName, value] of Object.entries(matches)) {
      // Manual override / prior call wins — never overwrite a populated cell.
      const existing = ev.values[stageName];
      if (existing != null && existing !== '') continue;
      ev.values[stageName] = value;
      filled += 1;
    }
  }
  return filled;
}

// Flip a matching entry in planData.steps[] to the given status. Each phase
// owns a "what step does this complete?" rule, captured at the bottom of the
// per-phase refresh function. The agent used to flip steps[i].status by hand
// via Edit tool between phases; in multi-phase orchestration that consistently
// got missed, so the rendered checklist drifted from reality. This helper
// closes the gap. Rules:
//   - Match `step.name` case-insensitively against `keyword` (regex).
//   - When `stage` is set, also require that lower-cased stage substring in
//     `step.name` — needed for "Deploy via pipeline to Staging" vs
//     "...Production" disambiguation.
//   - Skip steps with `skip: true` (user opted out — never auto-mark).
//   - Skip steps already in a terminal state UNLESS we're setting `failed`
//     (a retry that succeeded after a failure is recorded as completed by a
//     subsequent invocation; a fresh failure overrides any prior status).
// Recover the bare target label from a pipeline stage name. setup-pipeline names
// pipeline stages "Deploy to {targetLabel}" and the deploy marker carries that
// verbatim (last-deploy.json's stageName = SELECTED_STAGE.name = "Deploy to
// Staging"), but plan step names ("Deploy via pipeline to Staging", "Activate site
// in Staging") AND the per-stage object keys (validationRuns/manualImports/
// activations, which the renderer looks up by the bare label) all use just
// "Staging". Strip a leading "Deploy to " so the step matcher and the keys line up.
// Case-preserving + trimmed (callers lowercase if they need a case-insensitive
// compare); a no-op when the prefix isn't present (a caller already passing the
// bare label, e.g. test-site --stageName "Staging"). Centralizing this here keeps
// every stage consumer consistent so the "Deploy to {label}" mismatch can't recur
// in just one code path.
function normalizeStageLabel(stage) {
  if (typeof stage !== 'string') return stage;
  return stage.replace(/^\s*deploy\s+to\s+/i, '').trim();
}

function setStepStatus(planData, { keyword, stage, status }) {
  if (!Array.isArray(planData.steps)) return 0;
  if (!keyword) return 0;
  const targetStage = (typeof stage === 'string' && stage.length > 0)
    ? normalizeStageLabel(stage).toLowerCase()
    : null;
  let flipped = 0;
  for (const step of planData.steps) {
    if (!step || typeof step.name !== 'string') continue;
    if (step.skip === true) continue;
    const name = step.name.toLowerCase();
    if (!keyword.test(name)) continue;
    if (targetStage && !name.includes(targetStage)) continue;
    // Don't regress a completed step to anything other than `failed`. A retry
    // that succeeded should NOT downgrade to `in_progress`, but a `failed`
    // signal from a fresh failure must override a stale `completed`.
    if (step.status === 'completed' && status !== 'failed') continue;
    if (step.status === status) continue;
    step.status = status;
    flipped += 1;
  }
  return flipped;
}

// Drop risk entries that are no longer applicable after a phase completes.
// We match by canonical leading-text fragments because the risks list is
// authored as free text in Phase 3 — exact-text matching is brittle but
// more deterministic than pattern matching the whole sentence.
function dropResolvedRisks(risks, phase) {
  if (!Array.isArray(risks)) return risks || [];
  const stalePrefixes = {
    'setup-pipeline': [
      'No Pipelines host detected',
      'An existing Custom Host (',
      ' existing Custom Hosts found in tenant',
      'Tenant has a Platform Host',
    ],
    'deploy-pipeline': [
      // Defensive — if a future Phase 3 risks template adds "host not yet
      // provisioned" entries, drop them here too.
      'Pipelines host has not been provisioned yet',
    ],
  };
  const prefixes = stalePrefixes[phase] || [];
  if (prefixes.length === 0) return risks;
  return risks.filter((r) => {
    const msg = (r && typeof r === 'object' && typeof r.message === 'string') ? r.message : '';
    return !prefixes.some((p) => msg.includes(p));
  });
}

function refreshSetupPipeline(planData, projectRoot) {
  const hostCheckPath = almPath(projectRoot, 'lastHostCheck');
  const pipelineMarkerPath = almPath(projectRoot, 'lastPipeline');
  const hostCheck = readJson(hostCheckPath);
  const pipelineMarker = readJson(pipelineMarkerPath);

  if (hostCheck) {
    const next = buildHostResolutionFromCheck(hostCheck);
    if (next) planData.hostResolution = next;
  }
  // Rewrite alm-host-resolution.json so the audit snapshot tracks the
  // resolved state instead of the pre-run "NoHost" capture.
  mirrorHostResolutionSnapshot(planData, projectRoot);

  if (pipelineMarker) {
    planData.pipelineMeta = {
      ...(planData.pipelineMeta || {}),
      pipelineId: pipelineMarker.pipelineId || null,
      pipelineName: pipelineMarker.pipelineName || null,
      hostEnvUrl: pipelineMarker.hostEnvUrl || null,
      sourceDeploymentEnvironmentId: pipelineMarker.sourceDeploymentEnvironmentId || null,
      stages: Array.isArray(pipelineMarker.stages) ? pipelineMarker.stages : null,
      isActive: true,
      // Keep any reusedByWiring annotation Phase 6 may have written.
      reusedByWiring: planData.pipelineMeta?.reusedByWiring || null,
      // lastDeploy fills in from the next phase.
      lastDeploy: planData.pipelineMeta?.lastDeploy || null,
    };
  }

  planData.risks = dropResolvedRisks(planData.risks, 'setup-pipeline');
  // Step-sync: a successful invocation of --phase setup-pipeline completes
  // the "Setup pipeline" checklist entry. Marker presence is not required
  // because the agent invokes this helper only after the phase finished; the
  // invocation itself is the proof of completion.
  setStepStatus(planData, { keyword: /\bsetup\s+pipeline\b/i, status: 'completed' });
  return planData;
}

// Host-only refresh from docs/alm/last-host-check.json. Used when the Pipelines
// host was resolved/provisioned (ensure-pipelines-host) but the pipeline doesn't
// exist yet — so we update `hostResolution` + drop the NoHost risks WITHOUT
// flipping the "Setup pipeline" step or touching `pipelineMeta` (those belong to
// the later setup-pipeline phase). This is what lets a host install that crossed
// a session boundary still surface in the plan.
function refreshEnsurePipelinesHost(planData, projectRoot) {
  const hostCheck = readJson(almPath(projectRoot, 'lastHostCheck'));
  if (hostCheck) {
    const next = buildHostResolutionFromCheck(hostCheck);
    if (next) planData.hostResolution = next;
    mirrorHostResolutionSnapshot(planData, projectRoot);
    // Drop the pre-run NoHost / *Unbound* / Platform-Host warnings now that the
    // host is resolved (same set setup-pipeline clears).
    planData.risks = dropResolvedRisks(planData.risks, 'setup-pipeline');
  }
  return planData;
}

function refreshDeployPipeline(planData, projectRoot) {
  // Refresh hostResolution from the most recent host-check (and mirror into
  // rawDiscovery.hostResolution if the plan was generated with that envelope).
  // Validation surfaced the case where rawDiscovery.hostResolution stayed at
  // {ready:false, status:"NoHost"} from the initial Phase 1 scan even though
  // a successful setup-pipeline or ensure-pipelines-host had since resolved
  // the host. deploy-pipeline runs AFTER setup-pipeline so by the time we
  // get here the host is unambiguously bound. Mirror the resolved state into
  // both top-level and rawDiscovery so the rendered host card and the raw
  // diagnostic envelope agree.
  const hostCheck = readJson(almPath(projectRoot, 'lastHostCheck'));
  if (hostCheck) {
    const next = buildHostResolutionFromCheck(hostCheck);
    if (next) {
      planData.hostResolution = next;
      // Mirror to rawDiscovery if that envelope exists in the plan.
      if (planData.rawDiscovery && typeof planData.rawDiscovery === 'object') {
        planData.rawDiscovery.hostResolution = { ...next };
      }
      // Rewrite the audit snapshot too — same logic as refreshSetupPipeline.
      mirrorHostResolutionSnapshot(planData, projectRoot);
    }
  }

  const deployMarker = readJson(almPath(projectRoot, 'lastDeploy'));
  if (deployMarker) {
    planData.pipelineMeta = planData.pipelineMeta || {};
    planData.pipelineMeta.lastDeploy = {
      stageRunId: deployMarker.stageRunId || null,
      stageName: deployMarker.stageName || null,
      status: deployMarker.status || null,
      deployedAt: deployMarker.deployedAt || null,
      artifactVersion: deployMarker.artifactVersion || null,
      componentCount: deployMarker.componentCount != null ? deployMarker.componentCount : null,
      activationStatus: deployMarker.activationStatus || null,
      siteUrl: deployMarker.siteUrl || null,
    };
    // MULTI_RUN_MODE only: deploy-pipeline Phase 3.6 fans out parallel
    // ValidatePackageAsync calls before the serial deploy loop and persists
    // a `batchValidation` summary into the marker. Surface it on
    // pipelineMeta.lastDeploy so the renderer can display "Parallel validation:
    // N solutions in ~Ts, M succeeded" without re-querying. We carry the
    // per-solution stageRunIds too in case the renderer wants to deep-link
    // each one back to PPAC. Field absent for single-solution / legacy v2
    // deploys — caller's renderer should treat `null` as "not multi-run".
    if (deployMarker.batchValidation && typeof deployMarker.batchValidation === 'object') {
      const b = deployMarker.batchValidation;
      // Accept both `elapsedSeconds` (current Phase 3.6.6 schema, populated
      // directly from validate-stage-runs-batch.js's helper output) and
      // `elapsedSecondsApprox` (legacy name used in earlier drafts of the
      // SKILL.md before the helper exposed wall-clock measurement). The
      // helper is the source of truth going forward, but legacy markers
      // written before that change shouldn't get silently dropped.
      const elapsed = b.elapsedSeconds != null
        ? b.elapsedSeconds
        : (b.elapsedSecondsApprox != null ? b.elapsedSecondsApprox : null);
      planData.pipelineMeta.lastDeploy.batchValidation = {
        totalSolutions: b.totalSolutions != null ? b.totalSolutions : null,
        succeeded: b.succeeded != null ? b.succeeded : null,
        failed: b.failed != null ? b.failed : null,
        pendingApproval: b.pendingApproval != null ? b.pendingApproval : null,
        timedOut: b.timedOut != null ? b.timedOut : null,
        elapsedSeconds: elapsed,
        perSolutionStageRunIds: (b.perSolutionStageRunIds && typeof b.perSolutionStageRunIds === 'object')
          ? { ...b.perSolutionStageRunIds }
          : null,
      };
    } else {
      planData.pipelineMeta.lastDeploy.batchValidation = null;
    }
    planData.pipelineMeta.isActive = true;
  }
  planData.risks = dropResolvedRisks(planData.risks, 'deploy-pipeline');
  // Env var values matrix: backfill from deployment-settings.json (the same
  // file deploy-pipeline Phase 5 reads to build `deploymentsettingsjson`).
  // Without this the renderer's "Values by Environment" matrix stays empty
  // even though the deploy already shipped those values to the target env,
  // because the planData.envVars[].values map only gets populated if the
  // agent manually edits the JSON. Runs unconditionally — independent of
  // deployMarker presence, since the values are user-authored and may exist
  // for stages that haven't been deployed yet.
  backfillEnvVarValuesFromSettings(planData, projectRoot);
  // Step-sync: complete the "Deploy via pipeline to {stage}" step. Outcome
  // comes from the marker — a failed deploy marks the step `failed` so the
  // checklist surfaces what actually happened. Without a marker we don't
  // know the stage, so we leave steps[] alone (rare — deploy-pipeline always
  // writes one).
  if (deployMarker && deployMarker.stageName) {
    const failed = /fail/i.test(String(deployMarker.status || ''));
    setStepStatus(planData, {
      keyword: /\bdeploy\b/i,
      stage: deployMarker.stageName,
      status: failed ? 'failed' : 'completed',
    });
    // The PP deploy flow can activate the site as part of deployment (deploy-pipeline
    // Phase 7.7), recording the outcome in the marker's `activationStatus`. When the
    // deploy succeeded AND the marker shows the site was actually activated, complete
    // the matching "Activate site in {stage}" step too — otherwise computeNextStep
    // would point the user at /activate-site for work the deploy already did. Gate on
    // the explicit "Activated" outcome, NOT mere truthiness: deploy-pipeline writes
    // activationStatus: "Pending" when the user DEFERS activation, which is truthy but
    // means the Activate step is still REQUIRED. Any non-"Activated" value (Pending,
    // null, a failure note) leaves the Activate step pending. Testing stays a separate
    // step (the test-site skill flips it via refreshTestSite).
    if (!failed && /^activated$/i.test(String(deployMarker.activationStatus || ''))) {
      setStepStatus(planData, {
        keyword: /\bactivate\b/i,
        stage: deployMarker.stageName,
        status: 'completed',
      });
    }
  }
  return planData;
}

function refreshTestSite(planData, projectRoot, stageName) {
  // Stage resolution: explicit --stageName arg wins; falls back to the
  // marker's stageName field (test-site writes it when known, e.g. from the
  // upstream deploy context); finally falls back to the FIRST target
  // stage in planData.stages when planData has only one target. Standalone
  // single-stage test-site invocations work without --stageName via the
  // last fallback; multi-stage standalone runs need the explicit arg.
  const tsMarker = readJson(almPath(projectRoot, 'lastTestSite'));
  if (!tsMarker) return planData;

  let resolvedStage = (typeof stageName === 'string' && stageName.length > 0) ? stageName : null;
  if (!resolvedStage && tsMarker.stageName) resolvedStage = tsMarker.stageName;
  if (!resolvedStage && Array.isArray(planData.stages)) {
    const targets = planData.stages.filter((s) => s && s.type === 'target');
    if (targets.length === 1 && targets[0].label) resolvedStage = targets[0].label;
  }
  if (!resolvedStage) return planData;
  resolvedStage = normalizeStageLabel(resolvedStage);

  planData.validationRuns = planData.validationRuns || {};
  planData.validationRuns[resolvedStage] = {
    url: tsMarker.url || null,
    runAt: tsMarker.runAt || null,
    durationSec: tsMarker.durationSec != null ? tsMarker.durationSec : null,
    runOutcome: tsMarker.runOutcome || null,
    summary: tsMarker.summary || null,
    categories: Array.isArray(tsMarker.categories) ? tsMarker.categories : null,
  };
  // Step-sync: test-site is intentionally non-blocking — a "failed" runOutcome
  // does NOT abort the plan. The corresponding checklist step still marks
  // `completed` because the test ran; per-test pass/fail detail lives in
  // validationRuns[stage], which the renderer surfaces alongside the step.
  setStepStatus(planData, {
    keyword: /\btest\s+site\b/i,
    stage: resolvedStage,
    status: 'completed',
  });
  return planData;
}

function refreshFinalize(planData) {
  planData.PLAN_STATUS = 'Completed';
  // Step-sync: complete the "Finalize" checklist entry.
  setStepStatus(planData, { keyword: /\bfinalize\b/i, status: 'completed' });
  return planData;
}

// Completion evaluator. Once every non-skipped checklist step is `completed`
// (and none `failed`), the plan has been fully executed — transition it to
// "Completed" + stamp COMPLETED_AT. Runs after each phase's step-sync (in both
// refresh() and reconcile()), so the LAST execution skill to finish flips the
// plan terminal automatically — no skill has to call `--phase finalize`
// explicitly (nothing did, so the lifecycle previously never completed). Only
// advances from a pre-terminal, non-draft state: "In Execution" (the normal
// case after check-alm-plan.js promoted it on the first execution skill) or
// "Approved" (defensive fallback if that promotion didn't run). Never regresses
// a Draft or an already-Completed plan, and a `failed` step blocks completion
// (e.g. a failed deploy must not look "done" just because later steps are
// pending-skipped).
function evaluatePlanCompletion(planData) {
  if (!planData) return;
  const status = planData.PLAN_STATUS;
  if (status !== 'In Execution' && status !== 'Approved') return;
  if (!Array.isArray(planData.steps)) return;
  const live = planData.steps.filter((s) => s && s.skip !== true && typeof s.name === 'string');
  if (live.length === 0) return;
  const anyFailed = live.some((s) => s.status === 'failed');
  const allCompleted = live.every((s) => s.status === 'completed');
  if (!anyFailed && allCompleted) {
    planData.PLAN_STATUS = 'Completed';
    planData.COMPLETED_AT = new Date().toISOString();
  }
}

// Refresh-phase helper: stamp `LAST_SYNC_AT` on planData so check-alm-plan.js's
// freshness check correctly accounts for source-solution modifications caused
// by the just-completed phase. Called by every phase that touches the source
// solution's modifiedon — setup-solution (bump + AddSolutionComponent),
// configure-env-variables (env var definition creation + AddSolutionComponent),
// and export-solution (bump-solution-version.js). Without this stamp, a
// subsequent Phase 0 check sees `sol.modifiedon > GENERATED_AT` and falsely
// classifies the plan as stale — even though the modification was caused by
// the just-completed phase, not by drift. The check uses
// `max(GENERATED_AT, LAST_SYNC_AT)` as the reference point.
//
// Phases that do NOT call this helper: setup-pipeline (only writes to host env),
// deploy-pipeline (writes to target, not source — though Phase 3.5 may delegate
// to setup-solution which stamps via its own refresh), import-solution (target),
// activate-site (no source mod), test-site (read-only), ensure-pipelines-host
// (host env), force-link-environment (host env).
function stampLastSyncAt(planData) {
  planData.LAST_SYNC_AT = new Date().toISOString();
}

// Refresh-phase helper: copy the post-phase env var snapshot (docs/alm/last-env-vars.json
// — written by setup-solution Phase 6.2b after each setup-solution run, or by
// configure-env-variables if it adds a similar sidecar write) over to
// docs/alm/alm-env-vars.json so the plan-time snapshot stays current.
//
// Background: plan-alm Phase 1 Step 10b writes alm-env-vars.json once at
// plan-generation time. Validation surfaced the case where alm-env-vars.json
// was {envVars: [], count: 0} long after env vars were actually created —
// because nothing refreshed the file. last-env-vars.json IS refreshed
// (setup-solution Phase 6.2b runs the discovery helper post-setup), and
// refreshSetupSolution / refreshConfigureEnvVariables here ingest it into
// planData.envVars[]. Mirroring the same content over to alm-env-vars.json
// closes the audit-file gap so a user inspecting docs/alm/ doesn't see two
// disagreeing snapshots.
//
// Best-effort: a missing last-env-vars.json (rare — both refresh callers
// only invoke this AFTER checking the sidecar exists) is a no-op rather than
// an error; alm-env-vars.json simply stays at whatever plan-alm wrote.
// Refresh-phase helper: rewrite docs/alm/alm-host-resolution.json with the
// current planData.hostResolution state. Without this, the file persists at
// whatever plan-alm Phase 1 captured (typically `{ready:false, status:"NoHost"}`
// for a fresh project) even after setup-pipeline / ensure-pipelines-host has
// resolved the host. Validation surfaced this case on Citizens portal — the
// stale "no host" snapshot sat alongside a resolved last-host-check.json,
// confusing the audit trail.
function mirrorHostResolutionSnapshot(planData, projectRoot) {
  if (!projectRoot) return;
  if (!planData || !planData.hostResolution || typeof planData.hostResolution !== 'object') return;
  try {
    const targetPath = almPath(projectRoot, 'hostResolution');
    const content = JSON.stringify(planData.hostResolution, null, 2);
    const tmp = targetPath + '.tmp';
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, targetPath);
  } catch {
    // Best-effort.
  }
}

// Refresh-phase helper: patch `publisherPrefix` and `siteName` fields in
// docs/alm/alm-size-estimate.json with the post-setup-solution values from
// .solution-manifest.json. Without this, the estimate file persists at
// plan-time defaults (e.g. `cr5fe`, the new-project default) even after
// setup-solution established the actual publisher prefix (`c311`, etc.).
// Best-effort — a missing or unparseable file is a no-op.
function patchSizeEstimatePublisherFields(projectRoot, fields) {
  if (!projectRoot || !fields) return;
  try {
    const estPath = almPath(projectRoot, 'sizeEstimate');
    if (!fs.existsSync(estPath)) return;
    const raw = fs.readFileSync(estPath, 'utf8');
    let est;
    try { est = JSON.parse(raw); } catch { return; }
    let changed = false;
    if (fields.publisherPrefix && est.publisherPrefix !== fields.publisherPrefix) {
      est.publisherPrefix = fields.publisherPrefix;
      changed = true;
    }
    if (fields.siteName && est.siteName !== fields.siteName) {
      est.siteName = fields.siteName;
      changed = true;
    }
    if (!changed) return;
    const tmp = estPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(est, null, 2));
    fs.renameSync(tmp, estPath);
  } catch {
    // Best-effort.
  }
}

function mirrorEnvVarsSnapshot(projectRoot) {
  if (!projectRoot) return;
  try {
    const lastEnvVarsPath = almPath(projectRoot, 'lastEnvVars');
    const almEnvVarsPath = almPath(projectRoot, 'envVars');
    if (!fs.existsSync(lastEnvVarsPath)) return;
    const content = fs.readFileSync(lastEnvVarsPath, 'utf8');
    // Sanity check — only mirror if the source parses as JSON.
    try { JSON.parse(content); } catch { return; }
    // Same tmp-file + rename pattern used everywhere else in this module.
    const tmp = almEnvVarsPath + '.tmp';
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, almEnvVarsPath);
  } catch {
    // Best-effort — don't break the broader refresh on a mirror failure.
  }
}

function refreshSetupSolution(planData, projectRoot) {
  // After setup-solution runs, the planned-vs-existing distinction the
  // renderer surfaces (Overview stat + Size Analysis signal + Env Variables
  // tab) needs to flip:
  //   - plannedEnvVarCount → 0 (the planned set was either created or skipped)
  //   - planData.envVars[]  → the freshly-created/adopted definitions
  // setup-solution Phase 6 step 2b writes docs/alm/last-env-vars.json by running
  // discover-env-var-definitions.js with post-setup state — we ingest that
  // sidecar here. Without this, the rendered plan's Env Variables tab stays
  // empty even though setup-solution just created definitions in Dataverse,
  // and the Overview stat card stays at "0 / +N planned" forever.
  if (typeof planData.plannedEnvVarCount === 'number' && planData.plannedEnvVarCount > 0) {
    planData.plannedEnvVarCount = 0;
  }
  const envVarsMarker = projectRoot ? readJson(almPath(projectRoot, 'lastEnvVars')) : null;
  if (envVarsMarker && Array.isArray(envVarsMarker.envVars)) {
    // Discovery returns the same { schemaName, type, defaultValue, siteSetting }
    // shape the renderer expects — pass through verbatim. Empty array is a
    // valid post-state: setup-solution may have skipped all env vars (Tier 1
    // Skip-all + no Tier 2 promotions), in which case the tab should reflect
    // the empty existing state instead of carrying stale planned counts.
    planData.envVars = envVarsMarker.envVars;
  }
  // Refresh sizeAnalysis.envVarCount so the Overview stat card + Size Analysis
  // signal reflect the post-setup-solution count (after OAuth promotions,
  // credential conversions, and orphan adoptions land). Without this, the
  // pre-setup snapshot from plan generation persists and the Overview shows
  // a misleading "0 env vars" even after several were created.
  const postCount = Array.isArray(planData.envVars) ? planData.envVars.length : 0;
  if (planData.sizeAnalysis && typeof planData.sizeAnalysis === 'object') {
    planData.sizeAnalysis = {
      ...planData.sizeAnalysis,
      envVarCount: {
        ...(planData.sizeAnalysis.envVarCount || {}),
        value: postCount,
      },
    };
  }
  // Mirror the freshly-written last-env-vars.json over to alm-env-vars.json so
  // the plan-time snapshot stays current. Closes the audit gap where
  // alm-env-vars.json sat at {envVars:[],count:0} after env vars existed.
  mirrorEnvVarsSnapshot(projectRoot);
  // Patch alm-size-estimate.json with the post-setup publisher prefix +
  // siteName from .solution-manifest.json. Without this, the estimate file
  // keeps the plan-time defaults (often `cr5fe` for fresh projects) even
  // after setup-solution established the actual publisher (e.g. `c311`).
  if (projectRoot) {
    try {
      const manifestPath = path.join(projectRoot, '.solution-manifest.json');
      if (fs.existsSync(manifestPath)) {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        const publisherPrefix = manifest.publisher && manifest.publisher.customizationPrefix;
        const siteName = manifest.siteName || (planData && planData.SITE_NAME);
        patchSizeEstimatePublisherFields(projectRoot, { publisherPrefix, siteName });
      }
    } catch {
      // Best-effort — no-op if the manifest is missing or malformed.
    }
  }
  // Mark `LAST_SYNC_AT` so check-alm-plan.js's freshness check accounts for
  // the source-solution modification this phase just caused.
  stampLastSyncAt(planData);
  // Step-sync: complete the "Setup solution" checklist entry.
  setStepStatus(planData, { keyword: /\bsetup\s+solution\b/i, status: 'completed' });
  return planData;
}

// Manual-path passthrough refreshes. The agent updates planData.steps[i].status
// before calling these phases, so the main work each handler does is trigger
// the re-render. Each may grow to ingest a per-stage marker file (e.g.
// docs/alm/last-import.json keyed by target stage) in a future iteration.

function refreshExportSolution(planData, projectRoot) {
  // export-solution writes:
  //   - the solution zip to disk
  //   - a `.solution-manifest.json` version bump
  //   - `docs/alm/last-export.json` marker (since 2026-05-25 — `bump-solution-version.js`
  //     + always-on Phase 4.0 bump)
  //
  // Ingest the marker into `planData.manualMeta.lastExport` so the rendered
  // plan's Manual-path tab surfaces what was last shipped: solution name,
  // bumped version (and the previous version it superseded), managed flag,
  // zip path, and timestamp. The renderer is free to ignore fields it
  // doesn't display today — we persist all the marker's known fields so
  // future renderer changes don't have to round-trip through a refresh PR.
  const exportMarker = readJson(almPath(projectRoot, 'lastExport'));
  if (exportMarker) {
    planData.manualMeta = planData.manualMeta || {};
    planData.manualMeta.lastExport = {
      solutionUniqueName: exportMarker.solutionUniqueName || null,
      solutionId: exportMarker.solutionId || null,
      previousVersion: exportMarker.previousVersion || null,
      version: exportMarker.version || null,
      managed: typeof exportMarker.managed === 'boolean' ? exportMarker.managed : null,
      sourceEnvironmentUrl: exportMarker.sourceEnvironmentUrl || null,
      zipPath: exportMarker.zipPath || null,
      fileSizeBytes: exportMarker.fileSizeBytes != null ? exportMarker.fileSizeBytes : null,
      asyncOperationId: exportMarker.asyncOperationId || null,
      exportedAt: exportMarker.exportedAt || null,
    };
  }

  // export-solution Phase 4 Step 4.0 always-on-bump modifies source `modifiedon`.
  // Stamp LAST_SYNC_AT so subsequent Phase 0 checks don't falsely flag stale.
  stampLastSyncAt(planData);
  // Step-sync: a successful invocation of --phase export-solution completes
  // the "Export solution" checklist entry. Independent of marker presence —
  // legacy projects on the manual path may not yet have the marker file even
  // though the export succeeded.
  setStepStatus(planData, { keyword: /\bexport\b/i, status: 'completed' });
  return planData;
}

function refreshImportSolution(planData, projectRoot, stageName) {
  // import-solution writes docs/alm/last-import.json with { solutionName,
  // targetEnvironment, importedAt, status, componentResults }. For Manual
  // path with multiple targets, the file reflects the MOST RECENT import —
  // not a per-stage history. We resolve the stage label from --stageName
  // (passed by import-solution's final-phase refresh) or by matching
  // docs/alm/last-import.json's targetEnvironment URL against planData.stages[].envUrl.
  // The result writes into planData.manualImports[stageName] (parallel to
  // validationRuns[stageName]) so reviewers see per-target outcome on the
  // rendered plan, not just the most recent.
  const importMarker = readJson(almPath(projectRoot, 'lastImport'));
  if (!importMarker) return planData;

  // Resolve the target stage label: explicit --stageName wins; fall back to
  // matching the marker's targetEnvironment URL origin against the plan's
  // stages array. If neither resolves, log a soft note via stderr but still
  // capture the data under a synthetic key so the import isn't silently lost.
  let resolvedStage = (typeof stageName === 'string' && stageName.length > 0) ? stageName : null;
  if (!resolvedStage && importMarker.targetEnvironment && Array.isArray(planData.stages)) {
    const matchOrigin = (u) => {
      try { return new URL(u).origin.toLowerCase(); } catch { return null; }
    };
    const targetOrigin = matchOrigin(importMarker.targetEnvironment);
    if (targetOrigin) {
      const hit = planData.stages.find((s) => matchOrigin(s.envUrl) === targetOrigin);
      if (hit && hit.label) resolvedStage = hit.label;
    }
  }
  if (resolvedStage) resolvedStage = normalizeStageLabel(resolvedStage);
  if (!resolvedStage) {
    // Defensive — write to a synthetic key so subsequent imports for resolvable
    // stages don't clobber it. Caller should pass --stageName explicitly.
    resolvedStage = `unresolved-${importMarker.targetEnvironment || 'unknown'}`;
  }

  planData.manualImports = planData.manualImports || {};
  planData.manualImports[resolvedStage] = {
    solutionName: importMarker.solutionName || null,
    targetEnvironment: importMarker.targetEnvironment || null,
    importedAt: importMarker.importedAt || null,
    status: importMarker.status || null,
    artifactVersion: importMarker.artifactVersion || importMarker.version || null,
    componentCount: importMarker.componentCount != null ? importMarker.componentCount
      : (Array.isArray(importMarker.componentResults) ? importMarker.componentResults.length : null),
    componentFailureCount: Array.isArray(importMarker.componentResults)
      ? importMarker.componentResults.filter((c) => c && c.status && /fail/i.test(c.status)).length
      : null,
    importJobId: importMarker.importJobId || null,
  };
  // Step-sync: complete the "Import to {stage}" step unless the marker
  // indicates failure. `resolvedStage` defended above; if it ended up as
  // `unresolved-...` we still won't match a real step entry, so the call is
  // safely a no-op in that branch.
  if (!/^unresolved-/.test(resolvedStage)) {
    const failed = /fail/i.test(String(importMarker.status || ''));
    setStepStatus(planData, {
      keyword: /\bimport\b/i,
      stage: resolvedStage,
      status: failed ? 'failed' : 'completed',
    });
  }
  return planData;
}

function refreshActivateSite(planData, projectRoot, stageName) {
  // activate-site Phase 5.1b writes docs/alm/last-activate.json with the post-activation
  // state (siteUrl, websiteRecordId, environmentUrl, activatedAt, status). We
  // ingest it into planData.activations[stageName] (parallel to validationRuns
  // and manualImports) so the Manual-path "Activate site in {stage}" checklist
  // step can render an ACTIVATED badge with the live site URL inline.
  //
  // Stage resolution: explicit --stageName wins; falls back to URL matching
  // docs/alm/last-activate.json's environmentUrl against planData.stages[].envUrl when
  // omitted. PP Pipelines path tracks activation in docs/alm/last-deploy.json instead
  // (refreshDeployPipeline ingests it); the Manual-path standalone case is
  // what this handler covers.
  const marker = projectRoot ? readJson(almPath(projectRoot, 'lastActivate')) : null;
  if (!marker) return planData;

  let resolvedStage = (typeof stageName === 'string' && stageName.length > 0) ? stageName : null;
  if (!resolvedStage && marker.stageName) resolvedStage = marker.stageName;
  if (!resolvedStage && marker.environmentUrl && Array.isArray(planData.stages)) {
    const matchOrigin = (u) => {
      try { return new URL(u).origin.toLowerCase(); } catch { return null; }
    };
    const targetOrigin = matchOrigin(marker.environmentUrl);
    if (targetOrigin) {
      const hit = planData.stages.find((s) => matchOrigin(s.envUrl) === targetOrigin);
      if (hit && hit.label) resolvedStage = hit.label;
    }
  }
  if (resolvedStage) resolvedStage = normalizeStageLabel(resolvedStage);
  if (!resolvedStage) {
    resolvedStage = `unresolved-${marker.environmentUrl || 'unknown'}`;
  }

  planData.activations = planData.activations || {};
  planData.activations[resolvedStage] = {
    siteName: marker.siteName || null,
    siteUrl: marker.siteUrl || null,
    websiteRecordId: marker.websiteRecordId || null,
    environmentUrl: marker.environmentUrl || null,
    activatedAt: marker.activatedAt || null,
    status: marker.status || null,
  };
  // Step-sync: complete the "Activate site in {stage}" step. Activate-site
  // is treated as success when the marker exists at all — activation failures
  // halt the upstream skill before the marker writes, so a marker present
  // means activation succeeded.
  if (!/^unresolved-/.test(resolvedStage)) {
    setStepStatus(planData, {
      keyword: /\bactivate\b/i,
      stage: resolvedStage,
      status: 'completed',
    });
  }
  return planData;
}

function refreshConfigureEnvVariables(planData, projectRoot) {
  // configure-env-variables creates env var definitions (mirrors setup-solution's
  // Phase 5.4 path) AND writes deployment-settings.json with per-stage values.
  // Refresh responsibilities:
  //   1. Re-read docs/alm/last-env-vars.json so newly-created definitions show
  //      up in planData.envVars[] (same sidecar setup-solution Phase 6.2b uses;
  //      configure-env-variables should write to it too for consistency).
  //   2. Backfill values{} from deployment-settings.json (the file the skill
  //      just wrote — the per-stage matrix is now usable in the rendered plan).
  //   3. Zero out plannedEnvVarCount — configuration phase is the moment the
  //      "planned" count converts to "actual".
  //   4. Drop pre-run "env vars not yet configured" risks (defensive — current
  //      Phase 3 risks don't include this template, but a future addition is
  //      protected here).
  //   5. Step-sync the matching checklist entry.
  if (typeof planData.plannedEnvVarCount === 'number' && planData.plannedEnvVarCount > 0) {
    planData.plannedEnvVarCount = 0;
  }
  const envVarsMarker = projectRoot ? readJson(almPath(projectRoot, 'lastEnvVars')) : null;
  if (envVarsMarker && Array.isArray(envVarsMarker.envVars)) {
    planData.envVars = envVarsMarker.envVars;
  }
  // Backfill is the major payoff for this phase — the user just authored
  // per-stage values in deployment-settings.json and the rendered plan should
  // surface them in the Values by Environment matrix immediately.
  backfillEnvVarValuesFromSettings(planData, projectRoot);
  planData.risks = dropResolvedRisks(planData.risks, 'configure-env-variables');
  // Refresh sizeAnalysis.envVarCount so the Overview stat card + Size Analysis
  // signal reflect the post-config count, not the pre-setup-solution snapshot
  // from plan generation. Without this, validation surfaced the case where
  // sizeAnalysis.envVarCount.value stayed at 0 even after configure-env-variables
  // had created two definitions.
  const postCount = Array.isArray(planData.envVars) ? planData.envVars.length : 0;
  if (planData.sizeAnalysis && typeof planData.sizeAnalysis === 'object') {
    planData.sizeAnalysis = {
      ...planData.sizeAnalysis,
      envVarCount: {
        ...(planData.sizeAnalysis.envVarCount || {}),
        value: postCount,
      },
    };
  }
  // Mirror the latest last-env-vars.json over to alm-env-vars.json so both
  // snapshots agree after configure-env-variables creates new definitions.
  mirrorEnvVarsSnapshot(projectRoot);
  // Env var definition creation + AddSolutionComponent bumps source `modifiedon`.
  // Stamp LAST_SYNC_AT to keep subsequent Phase 0 checks accurate.
  stampLastSyncAt(planData);
  setStepStatus(planData, { keyword: /\bconfigure\s+env(?:ironment)?\s+var/i, status: 'completed' });
  return planData;
}

// Map a checklist step name (planData.steps[].name) to the slash command that
// runs it. Single source of truth for the "what runs next" lookup so the 8 ALM
// execution skills don't each re-derive it in SKILL.md prose. Matched by keyword
// because step names carry stage suffixes ("Deploy via pipeline to Staging").
// `finalize` and any unmatched name return null — there is no user-invocable
// skill for them.
const STEP_TO_SKILL = [
  { test: /\bsetup\s+solution\b/i, skill: '/power-pages:setup-solution' },
  { test: /\bsetup\s+pipeline\b/i, skill: '/power-pages:setup-pipeline' },
  { test: /\bconfigure\s+env(?:ironment)?\s+var/i, skill: '/power-pages:configure-env-variables' },
  { test: /\bexport\b/i, skill: '/power-pages:export-solution' },
  { test: /\bimport\b/i, skill: '/power-pages:import-solution' },
  { test: /\bdeploy\b/i, skill: '/power-pages:deploy-pipeline' },
  { test: /\bactivate\b/i, skill: '/power-pages:activate-site' },
  { test: /\btest\s+site\b/i, skill: '/power-pages:test-site' },
];

function mapStepToSkill(stepName) {
  if (typeof stepName !== 'string') return null;
  for (const entry of STEP_TO_SKILL) {
    if (entry.test.test(stepName)) return entry.skill;
  }
  return null;
}

// Compute the next recommended step a user should run: the first steps[] entry
// that is still pending (not completed/failed/in_progress) and not opted-out
// (skip !== true). Returns { name, skill } or null when nothing remains. The
// execution skills echo this after their final-phase refresh so the user is
// pointed at the next skill — without ever auto-firing it (user-driven
// sequencing). `skill` is null when the pending step has no user-invocable
// command (e.g. an internal "Finalize" step), so callers still get the name.
function computeNextStep(planData) {
  if (!planData || !Array.isArray(planData.steps)) return null;
  for (const step of planData.steps) {
    if (!step || typeof step.name !== 'string') continue;
    if (step.skip === true) continue;
    const status = step.status || 'pending';
    if (status !== 'pending') continue;
    return { name: step.name, skill: mapStepToSkill(step.name) };
  }
  return null;
}

function applyRefresh(planData, phase, projectRoot, stageName) {
  switch (phase) {
    case 'setup-solution':          return refreshSetupSolution(planData, projectRoot);
    case 'setup-pipeline':          return refreshSetupPipeline(planData, projectRoot);
    case 'configure-env-variables': return refreshConfigureEnvVariables(planData, projectRoot);
    case 'deploy-pipeline':         return refreshDeployPipeline(planData, projectRoot);
    case 'export-solution':         return refreshExportSolution(planData, projectRoot);
    case 'import-solution':         return refreshImportSolution(planData, projectRoot, stageName);
    case 'activate-site':           return refreshActivateSite(planData, projectRoot, stageName);
    case 'test-site':               return refreshTestSite(planData, projectRoot, stageName);
    case 'ensure-pipelines-host':   return refreshEnsurePipelinesHost(planData, projectRoot);
    case 'finalize':                return refreshFinalize(planData);
    default: throw new Error('Unknown phase: ' + phase);
  }
}

// Marker key (alm-paths FILE_NAMES) -> the refresh phase that ingests it. Used by
// the reconcile pass. `lastForceLink` is intentionally absent — there is no
// force-link refresh phase. `lastPipeline` maps to setup-pipeline, which also
// ingests lastHostCheck, so a present lastPipeline supersedes the host-only phase.
const MARKER_TO_PHASE = Object.freeze({
  lastPipeline:  'setup-pipeline',
  lastHostCheck: 'ensure-pipelines-host',
  lastDeploy:    'deploy-pipeline',
  lastExport:    'export-solution',
  lastImport:    'import-solution',
  lastActivate:  'activate-site',
  lastTestSite:  'test-site',
  // lastEnvVars resolved dynamically (configure-env-variables vs setup-solution).
});

// Returns the mtime (ms) of a file, or 0 if it doesn't exist / can't be stat'd.
function mtimeMs(filePath) {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

// Reconcile: the enforcement backstop. Scans the ALM marker files and, for each
// one that is NEWER than docs/.alm-plan-data.json (i.e. written by a skill whose
// refresh step was skipped), applies the corresponding phase refresh against a
// single loaded planData, writes once, and renders once. Idempotent — a marker
// the plan already reflects (plan newer than marker) is skipped, so the steady
// state is a cheap no-op. Honors the .alm-deferred opt-out and soft-no-ops when
// there is no plan. Returns { ok, reconciled:[phases healed], failed:[{phase,error}],
// rendered, nextStep } — `failed` is non-empty when a phase's refresh threw (e.g. a
// marker schema the refresh can't parse); the reconcile still heals the other phases.
function reconcile({ projectRoot, render, rendererPath }) {
  if (!projectRoot) throw new Error('--projectRoot is required');
  const dataPath = planDataPath(projectRoot);
  const htmlPath = planHtmlPath(projectRoot);

  // Respect the project-level ALM opt-out. nextStep is null on these early paths
  // (there's nothing to guide toward), kept on the return for a stable contract so
  // callers never have to special-case a missing property.
  if (fs.existsSync(path.join(projectRoot, '.alm-deferred'))) {
    return { ok: true, reconciled: [], failed: [], rendered: false, nextStep: null, reason: 'deferred' };
  }
  if (!fs.existsSync(dataPath)) {
    return { ok: false, reconciled: [], failed: [], rendered: false, nextStep: null, reason: 'no-plan' };
  }

  const planMtime = mtimeMs(dataPath);

  // Decide the env-var marker's phase: configure-env-variables when a
  // deployment-settings.json is present (its per-stage values), else setup-solution.
  const envVarPhase = fs.existsSync(path.join(projectRoot, 'deployment-settings.json'))
    ? 'configure-env-variables'
    : 'setup-solution';

  // Collect pending phases (marker newer than the plan), deduped, in a stable order.
  const pending = new Set();
  for (const [markerKey, phase] of Object.entries(MARKER_TO_PHASE)) {
    if (mtimeMs(almPath(projectRoot, markerKey)) > planMtime) pending.add(phase);
  }
  // lastHostCheck is covered by setup-pipeline when a pipeline marker is also
  // pending — drop the host-only phase to avoid a redundant ingest.
  if (pending.has('setup-pipeline')) pending.delete('ensure-pipelines-host');
  if (mtimeMs(almPath(projectRoot, 'lastEnvVars')) > planMtime) pending.add(envVarPhase);

  // Load the plan once. We parse it even when nothing is pending so the return
  // can still carry nextStep — the plan may be current with all markers yet have
  // unfinished checklist steps, and callers shouldn't lose "what to run next" (or
  // have to special-case a missing property) just because no heal was needed.
  let planData;
  try {
    planData = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  } catch (e) {
    throw new Error('Could not parse docs/.alm-plan-data.json: ' + e.message);
  }

  if (pending.size === 0) {
    return { ok: true, reconciled: [], failed: [], rendered: false, nextStep: computeNextStep(planData) };
  }

  // Deterministic application order (source schema first, host/pipeline, then
  // per-stage outcomes). Only the phases actually pending are applied.
  const ORDER = [
    'setup-solution', 'configure-env-variables', 'ensure-pipelines-host',
    'setup-pipeline', 'export-solution', 'import-solution',
    'deploy-pipeline', 'activate-site', 'test-site',
  ];
  const phases = ORDER.filter((p) => pending.has(p));

  // A single phase failing must not abort the reconcile — keep healing the rest —
  // but the failure must be visible (an empty catch makes a broken marker schema
  // impossible to diagnose: reconcile would report success while silently skipping
  // the phase). Collect failures and surface them in the result + on stderr.
  const reconciled = [];
  const failed = [];
  for (const phase of phases) {
    try {
      applyRefresh(planData, phase, projectRoot, null);
      reconciled.push(phase);
    } catch (e) {
      failed.push({ phase, error: e.message });
      process.stderr.write(`[refresh-alm-plan-data] reconcile phase "${phase}" failed: ${e.message}\n`);
    }
  }
  evaluatePlanCompletion(planData);
  fs.writeFileSync(dataPath, JSON.stringify(planData, null, 2), 'utf8');

  let rendered = false;
  if (render) {
    invokeRenderer(findRendererPath(rendererPath), dataPath, htmlPath);
    rendered = true;
  }

  return { ok: true, reconciled, failed, rendered, nextStep: computeNextStep(planData) };
}

function findRendererPath(rendererPath) {
  if (rendererPath) return rendererPath;
  // The helper lives at scripts/lib/; the renderer at skills/plan-alm/scripts/.
  // Both are siblings under the plugin root.
  return path.resolve(__dirname, '..', '..', 'skills', 'plan-alm', 'scripts', 'render-alm-plan.js');
}

function invokeRenderer(rendererPath, dataPath, outputPath) {
  execFileSync(process.execPath, [rendererPath, '--data', dataPath, '--output', outputPath], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
}

function refresh({ projectRoot, phase, render, rendererPath, stageName }) {
  if (!projectRoot) throw new Error('--projectRoot is required');
  if (!phase) throw new Error('--phase is required');
  if (!PHASES.has(phase)) {
    throw new Error('--phase must be one of: ' + [...PHASES].join(', '));
  }

  const dataPath = planDataPath(projectRoot);
  const htmlPath = planHtmlPath(projectRoot);

  if (!fs.existsSync(dataPath)) {
    return {
      ok: false,
      reason: 'docs/.alm-plan-data.json not found — was the file deleted? plan-alm Phase 3 writes it; the file must persist for post-run refreshes.',
      dataPath,
    };
  }

  let planData;
  try {
    planData = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  } catch (e) {
    throw new Error('Could not parse docs/.alm-plan-data.json: ' + e.message);
  }

  applyRefresh(planData, phase, projectRoot, stageName);
  evaluatePlanCompletion(planData);
  fs.writeFileSync(dataPath, JSON.stringify(planData, null, 2), 'utf8');

  let rendered = false;
  if (render) {
    invokeRenderer(findRendererPath(rendererPath), dataPath, htmlPath);
    rendered = true;
  }

  // nextStep: the first still-pending checklist step + its skill command, so
  // the calling execution skill can tell the user what to run next (user-driven
  // sequencing — never auto-fired). null when the plan is fully executed.
  const nextStep = computeNextStep(planData);

  return { ok: true, phase, dataPath, htmlPath, rendered, nextStep };
}

if (require.main === module) {
  const args = parseArgs(process.argv);
  try {
    const result = args.reconcile ? reconcile(args) : refresh(args);
    process.stdout.write(JSON.stringify(result) + '\n');
    process.exit(0);  // ok:false (missing planData / deferred) is a soft no-op
  } catch (err) {
    process.stderr.write('refresh-alm-plan-data: ' + err.message + '\n');
    process.exit(1);
  }
}

module.exports = {
  refresh,
  reconcile,
  buildHostResolutionFromCheck,
  dropResolvedRisks,
  setStepStatus,
  backfillEnvVarValuesFromSettings,
  extractPerStageValues,
  computeNextStep,
  mapStepToSkill,
  STEP_TO_SKILL,
  MARKER_TO_PHASE,
  PHASES,
  // Exported so other plan-data writers (e.g. set-plan-status.js) reuse the SAME
  // renderer-invocation instead of re-implementing the execFileSync call — keeps
  // the "where is render-alm-plan.js / how is it invoked" knowledge in one place.
  findRendererPath,
  invokeRenderer,
  // Single source of the "Deploy to {label}" → "{label}" normalization so every
  // stage consumer (verify-env-var-values.js included) matches stage labels the
  // same way — prevents the mismatch recurring in one un-normalized code path.
  normalizeStageLabel,
};
