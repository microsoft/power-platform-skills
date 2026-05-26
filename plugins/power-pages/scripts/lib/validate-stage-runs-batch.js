#!/usr/bin/env node

// Parallel batch validation of N Power Platform Pipelines stage runs against
// the same stage (MULTI_RUN_MODE / v3 manifest only).
//
// Used by deploy-pipeline Phase 3.6 when the project has a multi-solution
// split (docs/alm/last-pipeline.json `schemaVersion: 3` with N entries in
// `deploymentOrder[]`). The current `DeployPackageAsync` path is intentionally
// serial because Dataverse takes an env-level import lock — running deploys
// in parallel would just queue them on the host. But `ValidatePackageAsync`
// does NOT take the import lock, so all N validations can run concurrently.
// For a typical 5-solution split where each validation runs ~60-180s, this
// compresses the validation phase from `N × 120s` (~10 min) to roughly the
// longest single validation (~3 min).
//
// On any validation failure, the caller (SKILL.md) is responsible for halting
// before the serial deploy loop — this helper just reports per-solution status.
// No automatic retry: the caller decides whether to abort or surface results
// to the user.
//
// Usage (fresh fan-out — fires once before the serial deploy loop):
//   node validate-stage-runs-batch.js \
//     --hostEnvUrl <url> \
//     --stageId <id> \
//     --sourceDeploymentEnvironmentId <id> \
//     --solutionsFile <path> \
//     [--pipelineId <id>] \
//     [--token <token>] \
//     [--intervalMs <ms>] \
//     [--maxAttempts <n>]
//
// Usage (re-poll after user approves PendingApproval validations in PPAC):
//   node validate-stage-runs-batch.js \
//     --hostEnvUrl <url> \
//     --rePoll \
//     --solutionsFile <path>   # each entry must include "stageRunId"
//     [--token <token>] \
//     [--intervalMs <ms>] \
//     [--maxAttempts <n>]
//
//   --stageId / --sourceDeploymentEnvironmentId are NOT required in rePoll mode —
//   the stage run already exists with its bindings intact. Pass them and they're
//   ignored.
//
// solutionsFile format (JSON array of):
//   Fresh:   [{ "solutionUniqueName": "MySite_Core",      "solutionId": "<guid>" }, ...]
//   RePoll:  [{ "solutionUniqueName": "MySite_Core",      "solutionId": "<guid>",
//              "stageRunId": "<guid>" }, ...]
//
//   In rePoll mode, missing `stageRunId` per entry yields an `Error` result
//   for that entry without polling.
//
// Output (JSON to stdout):
//   {
//     "total": N,
//     "succeeded": N,
//     "failed": N,
//     "pendingApproval": N,
//     "timedOut": N,
//     "allPassed": <bool>,                      // true iff succeeded === total
//     "elapsedSeconds": N,                      // wall-clock seconds for the fan-out
//                                               // (excludes token-acquire prelude)
//     "results": [
//       {
//         "solutionUniqueName": "...",
//         "solutionId": "...",
//         "stageRunId": "...",
//         "status": "Succeeded" | "Failed" | "PendingApproval" | "Timeout" | "Error",
//         "validationResults": "<string|null>", // double-encoded JSON when present
//         "error": "<string>"                   // when status is Failed/Error
//       }
//     ]
//   }
//
// Exit 0 always (caller inspects allPassed + per-entry status).
// Exit 1 only on fatal setup errors (missing required args, unparseable JSON).

'use strict';

const fs = require('fs');
const helpers = require('./validation-helpers');
const { getAuthToken } = helpers;
const { createStageRun } = require('./create-stage-run');
const { pollValidationStatus } = require('./poll-validation-status');

const STAGE_RUN_STATUS_PENDING_APPROVAL = 200000005;

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = {
    hostEnvUrl: null,
    token: null,
    pipelineId: null,
    stageId: null,
    sourceDeploymentEnvironmentId: null,
    solutionsFile: null,
    intervalMs: 5000,
    maxAttempts: 36,
    rePoll: false,
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--hostEnvUrl' && args[i + 1]) out.hostEnvUrl = args[++i];
    else if (args[i] === '--token' && args[i + 1]) out.token = args[++i];
    else if (args[i] === '--pipelineId' && args[i + 1]) out.pipelineId = args[++i];
    else if (args[i] === '--stageId' && args[i + 1]) out.stageId = args[++i];
    else if (args[i] === '--sourceDeploymentEnvironmentId' && args[i + 1]) out.sourceDeploymentEnvironmentId = args[++i];
    else if (args[i] === '--solutionsFile' && args[i + 1]) out.solutionsFile = args[++i];
    else if (args[i] === '--intervalMs' && args[i + 1]) out.intervalMs = parseInt(args[++i], 10);
    else if (args[i] === '--maxAttempts' && args[i + 1]) out.maxAttempts = parseInt(args[++i], 10);
    else if (args[i] === '--rePoll' || args[i] === '--repoll') out.rePoll = true;
  }
  return out;
}

async function triggerValidatePackage({ hostEnvUrl, token, stageRunId }) {
  const baseUrl = hostEnvUrl.replace(/\/+$/, '');
  const res = await helpers.makeRequest({
    url: `${baseUrl}/api/data/v9.0/ValidatePackageAsync`,
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'OData-MaxVersion': '4.0',
      'OData-Version': '4.0',
    },
    body: JSON.stringify({ StageRunId: stageRunId }),
    timeout: 30000,
  });
  if (res.error) throw new Error(`ValidatePackageAsync request failed: ${res.error}`);
  // 204 expected. 404 indicates an older Pipelines package that doesn't expose
  // the OData action — surface so the caller can fall back to PAC CLI per-run.
  if (res.statusCode === 404) {
    const err = new Error('ValidatePackageAsync not available on this Pipelines package (404)');
    err.code = 'VALIDATE_PACKAGE_UNAVAILABLE';
    throw err;
  }
  if (res.statusCode !== 204) {
    throw new Error(`ValidatePackageAsync returned ${res.statusCode}: ${res.body}`);
  }
}

/**
 * Polls validation, and on timeout probes once to distinguish "still validating"
 * (timeout) from "pending approval" (`stagerunstatus=200000005`). Centralised so
 * the regular fan-out path (validateOne) and the re-poll path (rePollOne) share
 * the same terminal-state classification.
 *
 * Returns one of:
 *   { status: 'Succeeded', validationResults }
 *   { status: 'PendingApproval', validationResults }
 *   { status: 'Timeout', error }
 *   { status: 'Failed', error }
 */
async function pollAndProbe({ hostEnvUrl, token, stageRunId, intervalMs, maxAttempts }) {
  try {
    const pollResult = await pollValidationStatus({
      hostEnvUrl,
      token,
      stageRunId,
      intervalMs,
      maxAttempts,
    });
    return { status: 'Succeeded', validationResults: pollResult.validationResults || null };
  } catch (pollErr) {
    const baseUrl = hostEnvUrl.replace(/\/+$/, '');
    const probe = await helpers.makeRequest({
      url: `${baseUrl}/api/data/v9.0/deploymentstageruns(${stageRunId})?$select=stagerunstatus,validationresults`,
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'OData-MaxVersion': '4.0',
        'OData-Version': '4.0',
      },
      timeout: 15000,
    });
    if (probe.statusCode === 200) {
      try {
        const data = JSON.parse(probe.body);
        if (data.stagerunstatus === STAGE_RUN_STATUS_PENDING_APPROVAL) {
          return { status: 'PendingApproval', validationResults: data.validationresults || null };
        }
      } catch {
        // fall through to timeout/failed classification
      }
    }
    const msg = pollErr && pollErr.message ? pollErr.message : String(pollErr);
    return { status: /timed out/i.test(msg) ? 'Timeout' : 'Failed', error: msg };
  }
}

async function validateOne({ hostEnvUrl, token, stageId, sourceDeploymentEnvironmentId, pipelineId, spec, intervalMs, maxAttempts }) {
  if (!spec || !spec.solutionUniqueName || !spec.solutionId) {
    return {
      solutionUniqueName: spec && spec.solutionUniqueName,
      solutionId: spec && spec.solutionId,
      stageRunId: null,
      status: 'Error',
      error: 'spec missing required fields (solutionUniqueName, solutionId)',
    };
  }

  let stageRunId = null;
  try {
    // 1) Create stage run
    const createRes = await createStageRun({
      hostEnvUrl,
      token,
      pipelineId,
      stageId,
      sourceDeploymentEnvironmentId,
      solutionId: spec.solutionId,
      artifactName: spec.solutionUniqueName,
    });
    stageRunId = createRes.stageRunId;

    // 2) Trigger validation (204 expected)
    await triggerValidatePackage({ hostEnvUrl, token, stageRunId });

    // 3) Poll + probe (terminal-state classification shared with rePollOne)
    const outcome = await pollAndProbe({ hostEnvUrl, token, stageRunId, intervalMs, maxAttempts });
    return {
      solutionUniqueName: spec.solutionUniqueName,
      solutionId: spec.solutionId,
      stageRunId,
      ...outcome,
    };
  } catch (err) {
    return {
      solutionUniqueName: spec.solutionUniqueName,
      solutionId: spec.solutionId,
      stageRunId,
      status: 'Error',
      error: err && err.message ? err.message : String(err),
    };
  }
}

/**
 * Re-poll an EXISTING stage run that previously hit `PendingApproval`. Skips
 * create-stage-run + ValidatePackageAsync — those already happened on the
 * original `validateOne` call. After the user approves the validation in PPAC,
 * the stage run transitions: 200000005 (PendingApproval) → 200000006 (Validating) →
 * 200000007 (Succeeded). This function picks that up via the same poll+probe
 * path used for the initial fan-out.
 *
 * spec shape: `{ solutionUniqueName, solutionId, stageRunId }`. Missing `stageRunId`
 * is a fatal misuse — return `Error` rather than fabricating one.
 */
async function rePollOne({ hostEnvUrl, token, spec, intervalMs, maxAttempts }) {
  if (!spec || !spec.solutionUniqueName || !spec.solutionId || !spec.stageRunId) {
    return {
      solutionUniqueName: spec && spec.solutionUniqueName,
      solutionId: spec && spec.solutionId,
      stageRunId: spec && spec.stageRunId,
      status: 'Error',
      error: 'rePoll spec missing required fields (solutionUniqueName, solutionId, stageRunId)',
    };
  }

  try {
    const outcome = await pollAndProbe({
      hostEnvUrl,
      token,
      stageRunId: spec.stageRunId,
      intervalMs,
      maxAttempts,
    });
    return {
      solutionUniqueName: spec.solutionUniqueName,
      solutionId: spec.solutionId,
      stageRunId: spec.stageRunId,
      ...outcome,
    };
  } catch (err) {
    return {
      solutionUniqueName: spec.solutionUniqueName,
      solutionId: spec.solutionId,
      stageRunId: spec.stageRunId,
      status: 'Error',
      error: err && err.message ? err.message : String(err),
    };
  }
}

async function validateStageRunsBatch({
  hostEnvUrl, token, pipelineId, stageId, sourceDeploymentEnvironmentId,
  solutionsFile, specs, intervalMs = 5000, maxAttempts = 36,
  // When true, treat each spec as an existing stage run to re-poll (no
  // create-stage-run, no ValidatePackageAsync). Used by deploy-pipeline Phase
  // 3.6.4 after the user approves Pending Approval validations in PPAC.
  rePoll = false,
  // Test seam — defaults to getAuthToken when no token passed.
  refreshToken,
}) {
  if (!hostEnvUrl) throw new Error('--hostEnvUrl is required');
  // stageId + sourceDeploymentEnvironmentId only required for the fresh fan-out
  // path; rePoll re-uses stage runs whose stage was already chosen.
  if (!rePoll) {
    if (!stageId) throw new Error('--stageId is required');
    if (!sourceDeploymentEnvironmentId) throw new Error('--sourceDeploymentEnvironmentId is required');
  }

  let entries = specs;
  if (!entries) {
    if (!solutionsFile) throw new Error('--solutionsFile is required when specs not provided inline');
    entries = JSON.parse(fs.readFileSync(solutionsFile, 'utf8'));
  }
  if (!Array.isArray(entries)) throw new Error('solutions input must be a JSON array');

  // Acquire token once at the start. Validation polling can run several
  // minutes per solution but Azure CLI tokens last ~60min — single fan-out
  // is well within the TTL. If a 401 surfaces mid-batch, the caller can
  // re-invoke after `az account get-access-token`.
  const refresh = refreshToken || (() => getAuthToken(hostEnvUrl));
  const resolvedToken = token || refresh();
  if (!resolvedToken) throw new Error('Failed to acquire Azure CLI token. Run `az login` first.');

  // Wall-clock-measure the batch so callers (deploy-pipeline Phase 3.6.6) can
  // persist `elapsedSeconds` into docs/alm/last-deploy.json's batchValidation
  // block without measuring out-of-band. Captured at the start of fan-out so
  // it covers the actual concurrent work, not the token-acquire prelude.
  const startTimeMs = Date.now();

  const tasks = entries.map((spec) =>
    rePoll
      ? rePollOne({
          hostEnvUrl,
          token: resolvedToken,
          spec,
          intervalMs,
          maxAttempts,
        })
      : validateOne({
          hostEnvUrl,
          token: resolvedToken,
          pipelineId,
          stageId,
          sourceDeploymentEnvironmentId,
          spec,
          intervalMs,
          maxAttempts,
        })
  );

  // Promise.allSettled would also work but every validateOne resolves
  // (never rejects) — errors are wrapped into the result object's `status` +
  // `error` fields. Plain Promise.all is sufficient and gives an array in
  // input order.
  const results = await Promise.all(tasks);

  const tally = { succeeded: 0, failed: 0, pendingApproval: 0, timedOut: 0 };
  for (const r of results) {
    if (r.status === 'Succeeded') tally.succeeded += 1;
    else if (r.status === 'Failed' || r.status === 'Error') tally.failed += 1;
    else if (r.status === 'PendingApproval') tally.pendingApproval += 1;
    else if (r.status === 'Timeout') tally.timedOut += 1;
  }

  const elapsedSeconds = Math.max(0, Math.round((Date.now() - startTimeMs) / 1000));

  return {
    total: entries.length,
    succeeded: tally.succeeded,
    failed: tally.failed,
    pendingApproval: tally.pendingApproval,
    timedOut: tally.timedOut,
    allPassed: tally.succeeded === entries.length,
    elapsedSeconds,
    results,
  };
}

if (require.main === module) {
  const args = parseArgs(process.argv);
  validateStageRunsBatch(args)
    .then((result) => {
      process.stdout.write(JSON.stringify(result, null, 2));
      process.exit(0);
    })
    .catch((err) => {
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    });
}

module.exports = { validateStageRunsBatch };
