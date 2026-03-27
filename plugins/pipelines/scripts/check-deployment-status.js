#!/usr/bin/env node
// Check the status of a deployment stage run.
// Usage: node check-deployment-status.js --envUrl <url> --stageRunId <guid> [--poll] [--interval <seconds>] [--maxWait <seconds>] [--waitFor <phase>]
//
// --waitFor validation  Stop polling at ValidationSucceeded (or terminal)
// --waitFor deployment  Stop polling at Succeeded/Failed/Canceled (default)
//
// Output: { "status": "success", "stageRun": { "stagerunstatus": ..., "statusname": "...", ... } }

const { getAuthToken, makeRequest, UUID_REGEX, STAGE_RUN_STATUS, TERMINAL_STATUSES, stageRunStatusName, API_PATHS } = require('./lib/pipeline-helpers');

const API_VERSION = 'v9.2';

// Statuses where polling should stop, depending on the phase being waited for
const STOP_STATUSES = {
  validation: [...TERMINAL_STATUSES, STAGE_RUN_STATUS.VALIDATION_SUCCEEDED],
  deployment: TERMINAL_STATUSES
};

function parseArgs(argv) {
  const args = argv.slice(2);
  const parsed = { poll: false, interval: 15, maxWait: 900, waitFor: 'deployment' };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--envUrl' && i + 1 < args.length) parsed.envUrl = args[++i].replace(/\/+$/, '');
    else if (args[i] === '--stageRunId' && i + 1 < args.length) parsed.stageRunId = args[++i];
    else if (args[i] === '--poll') parsed.poll = true;
    else if (args[i] === '--interval' && i + 1 < args.length) parsed.interval = parseInt(args[++i], 10);
    else if (args[i] === '--maxWait' && i + 1 < args.length) parsed.maxWait = parseInt(args[++i], 10);
    else if (args[i] === '--waitFor' && i + 1 < args.length) parsed.waitFor = args[++i].toLowerCase();
    else if (args[i] === '--tenant' && i + 1 < args.length) parsed.tenant = args[++i];
  }
  if (!parsed.envUrl || !parsed.stageRunId) {
    console.error(JSON.stringify({ error: 'Required: --envUrl, --stageRunId' }));
    process.exit(1);
  }
  if (!UUID_REGEX.test(parsed.stageRunId)) {
    console.error(JSON.stringify({ error: 'stageRunId must be a valid GUID' }));
    process.exit(1);
  }
  if (!['validation', 'deployment'].includes(parsed.waitFor)) {
    console.error(JSON.stringify({ error: '--waitFor must be "validation" or "deployment"' }));
    process.exit(1);
  }
  return parsed;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchStatus(envUrl, stageRunId, token) {
  const result = await makeRequest({
    url: `${envUrl}/api/data/${API_VERSION}/${API_PATHS.STAGE_RUNS}(${stageRunId})`,
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'OData-MaxVersion': '4.0',
      'OData-Version': '4.0'
    }
  });

  if (result.error) return { error: result.error };
  if (result.statusCode !== 200) {
    let errorData;
    try { errorData = JSON.parse(result.body); } catch { errorData = result.body; }
    return { error: `Status check failed with ${result.statusCode}`, details: errorData };
  }

  try {
    return { data: JSON.parse(result.body) };
  } catch {
    return { error: 'Failed to parse response' };
  }
}

async function main() {
  const { envUrl, stageRunId, poll, interval, maxWait, waitFor, tenant } = parseArgs(process.argv);
  const resourceUrl = new URL(envUrl).origin;
  const token = getAuthToken(resourceUrl, tenant);
  if (!token) {
    console.error(JSON.stringify({ error: 'Failed to obtain auth token. Run "az login" first.' }));
    process.exit(1);
  }

  const stopStatuses = STOP_STATUSES[waitFor];
  const startTime = Date.now();

  while (true) {
    const result = await fetchStatus(envUrl, stageRunId, token);

    if (result.error) {
      console.error(JSON.stringify({ error: result.error, details: result.details }));
      process.exit(1);
    }

    const stageRun = result.data;
    const stageRunStatus = stageRun.stagerunstatus;
    const statusName = stageRunStatusName(stageRunStatus);
    const shouldStop = stopStatuses.includes(stageRunStatus);

    const output = {
      status: 'success',
      stageRun: {
        stageRunId,
        stagerunstatus: stageRunStatus,
        statusname: statusName,
        artifactname: stageRun.artifactname,
        approvalstatus: stageRun.approvalstatus,
        predeploymentstepstatus: stageRun.predeploymentstepstatus,
        createdon: stageRun.createdon,
        modifiedon: stageRun.modifiedon
      }
    };

    if (!poll || shouldStop) {
      console.log(JSON.stringify(output));
      process.exit(0);
    }

    // Polling mode — check timeout
    const elapsed = (Date.now() - startTime) / 1000;
    if (elapsed + interval > maxWait) {
      output.stageRun.pollTimedOut = true;
      output.stageRun.elapsedSeconds = Math.round(elapsed);
      console.log(JSON.stringify(output));
      process.exit(0);
    }

    // Log progress to stderr so stdout stays clean for final JSON
    process.stderr.write(`[${new Date().toISOString()}] Status: ${statusName} — polling again in ${interval}s...\n`);
    await sleep(interval * 1000);
  }
}

main();
