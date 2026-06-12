#!/usr/bin/env node

// Creates a deploymentpipelines record, associates the source environment via
// the deploymentpipeline_deploymentenvironment M2M $ref, and creates
// deploymentstages records for each target environment.
//
// Uses the **unprefixed** field schema (canonical per
// power-pipeline-skill-reference.md and verified against
// msdyn_AppDeploymentAnchor v9.1.2026034 on 2026-04-28). The earlier
// msdyn_-prefixed format we used was from an early-preview HAR; the shipped
// schema rejects msdyn_-prefixed properties.
//
// Field mapping summary (vs the old msdyn_ format):
//   msdyn_name                      → name
//   msdyn_description               → description
//   msdyn_sourceenvironment (PUT)   → deploymentpipeline_deploymentenvironment (POST $ref)
//   msdyn_pipelineid@odata.bind     → deploymentpipelineid@odata.bind
//   msdyn_targetenvironmentid@odata → targetdeploymentenvironmentid@odata.bind
//   msdyn_order                     → (omit; unprefixed schema doesn't use this field)
//
// Usage:
//   node create-deployment-pipeline.js \
//     --hostEnvUrl <url> \
//     --token <hostToken> \
//     --pipelineName <name> \
//     --description <desc> \
//     --sourceDeploymentEnvironmentId <guid> \
//     --stagesJson '[{"name":"Deploy to Staging","targetDeploymentEnvironmentId":"..."}]'
//
// Output (JSON to stdout):
//   {
//     "pipelineId": "...",
//     "pipelineName": "...",
//     "stages": [{ "stageId": "...", "name": "...", "targetDeploymentEnvironmentId": "..." }]
//   }
//
// Exit 0 on success, exit 1 on error (stderr).

'use strict';

const helpers = require('./validation-helpers');

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = {
    hostEnvUrl: null,
    token: null,
    pipelineName: null,
    description: '',
    sourceDeploymentEnvironmentId: null,
    stagesJson: null,
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--hostEnvUrl' && args[i + 1]) out.hostEnvUrl = args[++i];
    else if (args[i] === '--token' && args[i + 1]) out.token = args[++i];
    else if (args[i] === '--pipelineName' && args[i + 1]) out.pipelineName = args[++i];
    else if (args[i] === '--description' && args[i + 1]) out.description = args[++i];
    else if (args[i] === '--sourceDeploymentEnvironmentId' && args[i + 1]) out.sourceDeploymentEnvironmentId = args[++i];
    else if (args[i] === '--stagesJson' && args[i + 1]) out.stagesJson = args[++i];
  }

  return out;
}

function extractGuid(header) {
  if (!header) return null;
  const m = header.match(/\(([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)/i);
  return m ? m[1] : null;
}

async function findExistingPipelineByName({ cleanHost, token, name }) {
  const filter = encodeURIComponent(`name eq '${name.replace(/'/g, "''")}'`);
  const url = `${cleanHost}/api/data/v9.1/deploymentpipelines?$filter=${filter}&$select=deploymentpipelineid,name`;
  const res = await helpers.makeRequest({
    url, method: 'GET',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    timeout: 15000,
  });
  if (res.statusCode === 200 && res.body) {
    try {
      const data = JSON.parse(res.body);
      if (Array.isArray(data.value) && data.value.length > 0) return data.value[0].deploymentpipelineid;
    } catch {}
  }
  return null;
}

// Finds an existing pipeline that has the SAME source-env and target-env wiring
// as the request. This is the deduplication-by-wiring path: if the user creates
// a pipeline named "Pipeline A" with source X and target Y, and then asks for
// "Pipeline B" with the same source X and same target Y, this function returns
// Pipeline A's id (with its stage ids per target) so the caller can offer reuse
// instead of creating a duplicate.
//
// Match criteria:
//   - source env: requestedSourceDeId is in the pipeline's
//     deploymentpipeline_deploymentenvironment M2M
//   - target envs: every requestedTargetDeId has a matching stage on the pipeline
// Returns the FIRST matching pipeline with its stage layout. Null if no match.
async function findExistingPipelineByWiring({ cleanHost, token, requestedSourceDeId, requestedTargetDeIds }) {
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };

  // List all pipelines on the host (typically a small number).
  const listRes = await helpers.makeRequest({
    url: `${cleanHost}/api/data/v9.1/deploymentpipelines?$select=deploymentpipelineid,name`,
    method: 'GET',
    headers,
    timeout: 15000,
  });
  if (listRes.statusCode !== 200) return null;

  let pipelines;
  try { pipelines = JSON.parse(listRes.body).value || []; } catch { return null; }
  if (pipelines.length === 0) return null;

  const targetSet = new Set(requestedTargetDeIds.map(String));

  for (const p of pipelines) {
    const pid = p.deploymentpipelineid;

    // Check source binding
    const srcRes = await helpers.makeRequest({
      url: `${cleanHost}/api/data/v9.1/deploymentpipelines(${pid})/deploymentpipeline_deploymentenvironment?$select=deploymentenvironmentid`,
      method: 'GET', headers, timeout: 15000,
    });
    if (srcRes.statusCode !== 200) continue;
    let srcs;
    try { srcs = JSON.parse(srcRes.body).value || []; } catch { continue; }
    const srcMatch = srcs.some((s) => String(s.deploymentenvironmentid) === String(requestedSourceDeId));
    if (!srcMatch) continue;

    // Check stage targets
    const stageFilter = encodeURIComponent(`_deploymentpipelineid_value eq ${pid}`);
    const stageRes = await helpers.makeRequest({
      url: `${cleanHost}/api/data/v9.1/deploymentstages?$filter=${stageFilter}&$select=deploymentstageid,name,_targetdeploymentenvironmentid_value`,
      method: 'GET', headers, timeout: 15000,
    });
    if (stageRes.statusCode !== 200) continue;
    let stages;
    try { stages = JSON.parse(stageRes.body).value || []; } catch { continue; }
    const stageTargetSet = new Set(stages.map((s) => String(s._targetdeploymentenvironmentid_value)));

    // All requested targets must have a matching stage
    const allTargetsCovered = [...targetSet].every((t) => stageTargetSet.has(t));
    if (!allTargetsCovered) continue;

    // Match. Return the pipeline + the stages for each requested target.
    const stagesByTarget = {};
    stages.forEach((s) => { stagesByTarget[String(s._targetdeploymentenvironmentid_value)] = { stageId: s.deploymentstageid, name: s.name }; });
    return {
      pipelineId: pid,
      pipelineName: p.name,
      stagesByTarget,
    };
  }

  return null;
}

async function findExistingStage({ cleanHost, token, pipelineId, stageName }) {
  const filter = encodeURIComponent(`_deploymentpipelineid_value eq ${pipelineId} and name eq '${stageName.replace(/'/g, "''")}'`);
  const url = `${cleanHost}/api/data/v9.1/deploymentstages?$filter=${filter}&$select=deploymentstageid,name`;
  const res = await helpers.makeRequest({
    url, method: 'GET',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    timeout: 15000,
  });
  if (res.statusCode === 200 && res.body) {
    try {
      const data = JSON.parse(res.body);
      if (Array.isArray(data.value) && data.value.length > 0) return data.value[0].deploymentstageid;
    } catch {}
  }
  return null;
}

async function isSourceAlreadyAssociated({ cleanHost, token, pipelineId, sourceDeId }) {
  const url = `${cleanHost}/api/data/v9.1/deploymentpipelines(${pipelineId})/deploymentpipeline_deploymentenvironment?$select=deploymentenvironmentid`;
  const res = await helpers.makeRequest({
    url, method: 'GET',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    timeout: 15000,
  });
  if (res.statusCode === 200 && res.body) {
    try {
      const data = JSON.parse(res.body);
      return Array.isArray(data.value) && data.value.some((e) => e.deploymentenvironmentid === sourceDeId);
    } catch {}
  }
  return false;
}

async function createDeploymentPipeline({
  hostEnvUrl,
  token,
  pipelineName,
  description = '',
  sourceDeploymentEnvironmentId,
  stagesJson,
} = {}) {
  if (!hostEnvUrl) throw new Error('--hostEnvUrl is required');
  if (!token) throw new Error('--token is required');
  if (!pipelineName) throw new Error('--pipelineName is required');
  if (!sourceDeploymentEnvironmentId) throw new Error('--sourceDeploymentEnvironmentId is required');
  if (!stagesJson) throw new Error('--stagesJson is required');

  const cleanHost = hostEnvUrl.replace(/\/+$/, '');

  let stages;
  try { stages = typeof stagesJson === 'string' ? JSON.parse(stagesJson) : stagesJson; }
  catch (e) { throw new Error(`Failed to parse --stagesJson: ${e.message}`); }
  if (!Array.isArray(stages)) throw new Error('--stagesJson must be a JSON array');

  // Step 1: Pipeline (idempotent — reuse existing on name match OR wiring match)
  let pipelineId = await findExistingPipelineByName({ cleanHost, token, name: pipelineName });
  let reusedByWiring = null;

  if (!pipelineId) {
    // Try to find a pipeline with matching source + targets, regardless of name.
    // This catches "the user created a pipeline before and is asking again with
    // a different name" — we shouldn't create duplicate pipelines pointing at
    // the same Stage-1→Stage-2 wiring.
    const requestedTargetDeIds = stages.map((s) => s.targetDeploymentEnvironmentId);
    reusedByWiring = await findExistingPipelineByWiring({
      cleanHost, token,
      requestedSourceDeId: sourceDeploymentEnvironmentId,
      requestedTargetDeIds,
    });
    if (reusedByWiring) {
      pipelineId = reusedByWiring.pipelineId;
    }
  }

  if (!pipelineId) {
    const pipelineBody = JSON.stringify({
      name: pipelineName,
      description: description || `Pipeline for ${pipelineName}`,
      statuscode: 1,
      statecode: 0,
      enableaideploymentnotes: false,
    });

    const pipelineRes = await helpers.makeRequest({
      url: `${cleanHost}/api/data/v9.1/deploymentpipelines`,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'OData-MaxVersion': '4.0',
        'OData-Version': '4.0',
        Prefer: 'return=representation',
      },
      body: pipelineBody,
      includeHeaders: true,
      timeout: 30000,
    });

    if (pipelineRes.error) throw new Error(`Create deploymentpipelines failed: ${pipelineRes.error}`);
    if (pipelineRes.statusCode < 200 || pipelineRes.statusCode >= 300) {
      throw new Error(`Create deploymentpipelines returned ${pipelineRes.statusCode}: ${pipelineRes.body.slice(0, 500)}`);
    }
    pipelineId = extractGuid(pipelineRes.headers && (pipelineRes.headers['odata-entityid'] || pipelineRes.headers['OData-EntityId']));
    if (!pipelineId && pipelineRes.body) {
      try { pipelineId = JSON.parse(pipelineRes.body).deploymentpipelineid || null; } catch {}
    }
    if (!pipelineId) throw new Error(`Could not extract pipelineId from response`);
  }

  // Step 2: Associate source via deploymentpipeline_deploymentenvironment M2M $ref
  const alreadyAssociated = await isSourceAlreadyAssociated({ cleanHost, token, pipelineId, sourceDeId: sourceDeploymentEnvironmentId });
  if (!alreadyAssociated) {
    const refBody = JSON.stringify({
      '@odata.context': `${cleanHost}/api/data/v9.1/$metadata#$ref`,
      '@odata.id': `deploymentenvironments(${sourceDeploymentEnvironmentId})`,
    });

    const refRes = await helpers.makeRequest({
      url: `${cleanHost}/api/data/v9.1/deploymentpipelines(${pipelineId})/deploymentpipeline_deploymentenvironment/$ref`,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'OData-MaxVersion': '4.0',
        'OData-Version': '4.0',
      },
      body: refBody,
      timeout: 15000,
    });

    if (refRes.error) throw new Error(`Associate source via $ref failed: ${refRes.error}`);
    if (refRes.statusCode < 200 || refRes.statusCode >= 300) {
      throw new Error(`Associate source via $ref returned ${refRes.statusCode}: ${refRes.body.slice(0, 500)}`);
    }
  }

  // Step 3: Create stages (idempotent — reuse existing by pipelineId+name OR
  // pipelineId+targetDeploymentEnvironmentId. The latter handles the case
  // where the pipeline was reused by wiring: existing stage names may differ
  // from the requested names but the target env IDs match exactly.)
  const createdStages = [];
  for (const stage of stages) {
    const { name: stageName, targetDeploymentEnvironmentId, description: stageDesc } = stage;
    if (!stageName) throw new Error('Each stage must have a "name" field');
    if (!targetDeploymentEnvironmentId) throw new Error('Each stage must have a "targetDeploymentEnvironmentId" field');

    // Prefer the by-wiring lookup if we reused the pipeline by wiring
    let stageId = null;
    let reusedStageOriginalName = null;
    if (reusedByWiring && reusedByWiring.stagesByTarget[String(targetDeploymentEnvironmentId)]) {
      const m = reusedByWiring.stagesByTarget[String(targetDeploymentEnvironmentId)];
      stageId = m.stageId;
      reusedStageOriginalName = m.name;
    }
    if (!stageId) stageId = await findExistingStage({ cleanHost, token, pipelineId, stageName });

    if (!stageId) {
      const stageBody = JSON.stringify({
        name: stageName,
        description: stageDesc || `Deploy to ${stageName}`,
        'deploymentpipelineid@odata.bind': `/deploymentpipelines(${pipelineId})`,
        'targetdeploymentenvironmentid@odata.bind': `/deploymentenvironments(${targetDeploymentEnvironmentId})`,
      });

      const stageRes = await helpers.makeRequest({
        url: `${cleanHost}/api/data/v9.1/deploymentstages`,
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'OData-MaxVersion': '4.0',
          'OData-Version': '4.0',
          Prefer: 'return=representation',
        },
        body: stageBody,
        includeHeaders: true,
        timeout: 30000,
      });

      if (stageRes.error) throw new Error(`Create deploymentstage "${stageName}" failed: ${stageRes.error}`);
      if (stageRes.statusCode < 200 || stageRes.statusCode >= 300) {
        throw new Error(`Create deploymentstage "${stageName}" returned ${stageRes.statusCode}: ${stageRes.body.slice(0, 500)}`);
      }

      stageId = extractGuid(stageRes.headers && (stageRes.headers['odata-entityid'] || stageRes.headers['OData-EntityId']));
      if (!stageId && stageRes.body) {
        try { stageId = JSON.parse(stageRes.body).deploymentstageid || null; } catch {}
      }
      if (!stageId) throw new Error(`Could not extract stageId for stage "${stageName}"`);
    }

    createdStages.push({
      stageId,
      name: reusedStageOriginalName || stageName,
      targetDeploymentEnvironmentId,
      reusedFromWiringMatch: !!reusedStageOriginalName,
    });
  }

  return {
    pipelineId,
    pipelineName: reusedByWiring ? reusedByWiring.pipelineName : pipelineName,
    stages: createdStages,
    reused: !!reusedByWiring,
    reusedByWiring: reusedByWiring ? {
      originalName: reusedByWiring.pipelineName,
      requestedName: pipelineName,
    } : null,
  };
}

if (require.main === module) {
  const args = parseArgs(process.argv);
  createDeploymentPipeline(args)
    .then((result) => {
      console.log(JSON.stringify(result));
      process.exit(0);
    })
    .catch((err) => {
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    });
}

module.exports = { createDeploymentPipeline };
