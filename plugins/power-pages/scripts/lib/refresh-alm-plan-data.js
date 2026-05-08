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
//     - hostResolution from .last-host-check.json
//     - pipelineMeta from .last-pipeline.json (no lastDeploy yet)
//     - drop pre-run NoHost / *Unbound* warnings from risks[]
//   deploy-pipeline:
//     - pipelineMeta.lastDeploy from .last-deploy.json
//     - drop pre-run "Pipelines host not yet provisioned" warnings (defensive)
//   test-site:
//     - validationRuns[stage] from .last-test-site.json (if present)
//   finalize:
//     - PLAN_STATUS = "Completed"
//
// Exit 0 on success (including no-op when planData missing — caller decides).
// Exit 1 on argparse / fatal error.

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const PHASES = new Set([
  'setup-solution',
  'setup-pipeline',
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
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--projectRoot' && args[i + 1]) out.projectRoot = args[++i];
    else if (args[i] === '--phase' && args[i + 1]) out.phase = args[++i];
    else if (args[i] === '--render') out.render = true;
    else if (args[i] === '--rendererPath' && args[i + 1]) out.rendererPath = args[++i];
    else if (args[i] === '--stageName' && args[i + 1]) out.stageName = args[++i];
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

// Map .last-host-check.json's resolutionStatus to plan-alm's hostResolution.status.
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
  const hostCheckPath = path.join(projectRoot, '.last-host-check.json');
  const pipelineMarkerPath = path.join(projectRoot, '.last-pipeline.json');
  const hostCheck = readJson(hostCheckPath);
  const pipelineMarker = readJson(pipelineMarkerPath);

  if (hostCheck) {
    const next = buildHostResolutionFromCheck(hostCheck);
    if (next) planData.hostResolution = next;
  }

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
  return planData;
}

function refreshDeployPipeline(planData, projectRoot) {
  const deployMarker = readJson(path.join(projectRoot, '.last-deploy.json'));
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
    planData.pipelineMeta.isActive = true;
  }
  planData.risks = dropResolvedRisks(planData.risks, 'deploy-pipeline');
  return planData;
}

function refreshTestSite(planData, projectRoot, stageName) {
  if (!stageName) return planData;
  const tsMarker = readJson(path.join(projectRoot, '.last-test-site.json'));
  if (!tsMarker) return planData;
  planData.validationRuns = planData.validationRuns || {};
  planData.validationRuns[stageName] = {
    url: tsMarker.url || null,
    runAt: tsMarker.runAt || null,
    durationSec: tsMarker.durationSec != null ? tsMarker.durationSec : null,
    runOutcome: tsMarker.runOutcome || null,
    summary: tsMarker.summary || null,
    categories: Array.isArray(tsMarker.categories) ? tsMarker.categories : null,
  };
  return planData;
}

function refreshFinalize(planData) {
  planData.PLAN_STATUS = 'Completed';
  return planData;
}

function refreshSetupSolution(planData) {
  // The setup-solution skill writes .solution-manifest.json, which Phase 3
  // already consumed for solutionContents. After it runs, any "planned" env
  // vars have either been created (and would be picked up by a future
  // discover-env-var-definitions run) or explicitly skipped by the user.
  // Either way, the planned-vs-existing distinction in the renderer is no
  // longer informative — zero it out so the Env Variables tab + stat card
  // reflect existing-only state. (For a fully-fresh env-vars list, the user
  // can re-run /power-pages:plan-alm.)
  if (typeof planData.plannedEnvVarCount === 'number' && planData.plannedEnvVarCount > 0) {
    planData.plannedEnvVarCount = 0;
  }
  return planData;
}

// Manual-path passthrough refreshes. The agent updates planData.steps[i].status
// before calling these phases, so the main work each handler does is trigger
// the re-render. Each may grow to ingest a per-stage marker file (e.g.
// .last-import.json keyed by target stage) in a future iteration.

function refreshExportSolution(planData) {
  // export-solution writes the solution zip to disk + a .solution-manifest.json
  // version bump. No structured marker file today — re-rendering picks up
  // the agent's step.status updates. If a future commit introduces
  // .last-export.json (zipPath / exportedAt / version / managed flag), expand
  // this handler to populate planData.manualMeta.lastExport from it.
  return planData;
}

function refreshImportSolution(planData, projectRoot, stageName) {
  // import-solution writes .last-import.json with { solutionName,
  // targetEnvironment, importedAt, status, componentResults }. For Manual
  // path with multiple targets, the file reflects the MOST RECENT import —
  // not a per-stage history. We resolve the stage label from --stageName
  // (passed by plan-alm Phase 7's per-target loop) or by matching
  // .last-import.json's targetEnvironment URL against planData.stages[].envUrl.
  // The result writes into planData.manualImports[stageName] (parallel to
  // validationRuns[stageName]) so reviewers see per-target outcome on the
  // rendered plan, not just the most recent.
  const importMarker = readJson(path.join(projectRoot, '.last-import.json'));
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
  return planData;
}

function refreshActivateSite(planData) {
  // activate-site writes nothing today (or a transient confirmation only —
  // no canonical marker file). The PP Pipelines path tracks activation
  // status in .last-deploy.json (refreshDeployPipeline reads it). For
  // Manual path the agent updates step.status before calling this refresh,
  // so re-rendering surfaces the status change. Future enhancement: write
  // a .last-activate.json marker per stage and ingest per-stage activation
  // outcome here, parallel to validationRuns.
  return planData;
}

function applyRefresh(planData, phase, projectRoot, stageName) {
  switch (phase) {
    case 'setup-solution':  return refreshSetupSolution(planData);
    case 'setup-pipeline':  return refreshSetupPipeline(planData, projectRoot);
    case 'deploy-pipeline': return refreshDeployPipeline(planData, projectRoot);
    case 'export-solution': return refreshExportSolution(planData);
    case 'import-solution': return refreshImportSolution(planData, projectRoot, stageName);
    case 'activate-site':   return refreshActivateSite(planData);
    case 'test-site':       return refreshTestSite(planData, projectRoot, stageName);
    case 'finalize':        return refreshFinalize(planData);
    default: throw new Error('Unknown phase: ' + phase);
  }
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

  const dataPath = path.join(projectRoot, 'docs', '.alm-plan-data.json');
  const htmlPath = path.join(projectRoot, 'docs', 'alm-plan.html');

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
  fs.writeFileSync(dataPath, JSON.stringify(planData, null, 2), 'utf8');

  let rendered = false;
  if (render) {
    invokeRenderer(findRendererPath(rendererPath), dataPath, htmlPath);
    rendered = true;
  }

  return { ok: true, phase, dataPath, htmlPath, rendered };
}

if (require.main === module) {
  const args = parseArgs(process.argv);
  try {
    const result = refresh(args);
    process.stdout.write(JSON.stringify(result) + '\n');
    process.exit(result.ok ? 0 : 0);  // ok:false is a soft no-op (missing planData)
  } catch (err) {
    process.stderr.write('refresh-alm-plan-data: ' + err.message + '\n');
    process.exit(1);
  }
}

module.exports = {
  refresh,
  buildHostResolutionFromCheck,
  dropResolvedRisks,
  PHASES,
};
