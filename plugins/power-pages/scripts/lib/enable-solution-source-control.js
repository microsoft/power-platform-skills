#!/usr/bin/env node

// Enables Dataverse source-control integration on a solution, matching the
// maker portal's "Enable for source control" button.
//
// Idempotency: PATCHing enabledforsourcecontrolintegration to string "true" is
// safe to retry. Optional polling observes the async sync status but a timeout
// is reported as ok:true because enablement already succeeded.
//
// Output (JSON to stdout):
//   { "ok": true, "solutionId": "<guid>", "enabled": true, "polled": false, "finalSyncStatus": null }
//   { "ok": true, "solutionId": "<guid>", "enabled": true, "polled": true, "pollAttempts": 2, "finalSyncStatus": 3, "durationMs": 1234 }
//   On failure: { "ok": false, "statusCode": <int|null>, "error": "<message>", "hint": "<message>"|null }
//
// Usage:
//   node enable-solution-source-control.js --envUrl <url> --solutionId <guid> [--token <bearer>] [--poll] [--pollIntervalMs 5000] [--maxPollAttempts 24]

'use strict';

const { makeRequest, getAuthToken } = require('./validation-helpers');

const API_VERSION = 'v9.0';
const SYNC_STATUS_SYNCED = 3;
const DEFAULT_POLL_INTERVAL_MS = 5000;
const DEFAULT_MAX_POLL_ATTEMPTS = 24;

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = { envUrl: null, solutionId: null, token: null, poll: false, pollIntervalMs: DEFAULT_POLL_INTERVAL_MS, maxPollAttempts: DEFAULT_MAX_POLL_ATTEMPTS };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--envUrl' && args[i + 1]) out.envUrl = args[++i];
    else if (args[i] === '--solutionId' && args[i + 1]) out.solutionId = args[++i];
    else if (args[i] === '--token' && args[i + 1]) out.token = args[++i];
    else if (args[i] === '--poll') out.poll = true;
    else if (args[i] === '--pollIntervalMs' && args[i + 1]) out.pollIntervalMs = Number(args[++i]);
    else if (args[i] === '--maxPollAttempts' && args[i + 1]) out.maxPollAttempts = Number(args[++i]);
  }
  return out;
}
function failure(statusCode, error, hint = null) { return { ok: false, statusCode: statusCode == null ? null : statusCode, error, hint }; }
function errorMessage(res) { try { return JSON.parse(res.body || '{}').error?.message || JSON.parse(res.body || '{}').message || `HTTP ${res.statusCode}`; } catch { return res && res.error ? res.error : `HTTP ${res && res.statusCode}`; } }
function hintForStatus(sc, envUrl, solutionId) {
  if (sc === 404) return `Solution ${solutionId} not found in env ${envUrl}.`;
  if (sc === 401) return 'Dataverse token rejected. Run `az login` if expired.';
  return null;
}
function normalizeEnvUrl(envUrl) { return String(envUrl || '').replace(/\/+$/, ''); }
function normalizeGuid(guid) { return String(guid || '').replace(/[{}]/g, ''); }
function delay(ms) { return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve(); }

async function enableSolutionSourceControl(options = {}) {
  const { envUrl, solutionId } = options;
  const request = typeof options._makeRequestImpl === 'function' ? options._makeRequestImpl : makeRequest;
  const getToken = typeof options._getTokenImpl === 'function' ? options._getTokenImpl : getAuthToken;
  if (!envUrl) return failure(null, '--envUrl is required');
  if (!solutionId) return failure(null, '--solutionId is required');
  const normalizedEnv = normalizeEnvUrl(envUrl);
  const token = options.token || getToken(normalizedEnv);
  if (!token) return failure(null, 'Dataverse token is required. Pass --token or run `az login` first.', 'Dataverse token rejected. Run `az login` if expired.');
  const id = normalizeGuid(solutionId);
  const start = Date.now();
  const patchUrl = `${normalizedEnv}/api/data/${API_VERSION}/solutions(${id})`;
  const patchRes = await request({ url: patchUrl, method: 'PATCH', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify({ enabledforsourcecontrolintegration: 'true' }) });
  if (patchRes && patchRes.error) return failure(null, patchRes.error);
  if (!patchRes || patchRes.statusCode !== 204) return failure(patchRes && patchRes.statusCode || null, errorMessage(patchRes), hintForStatus(patchRes && patchRes.statusCode, normalizedEnv, id));
  if (!options.poll) return { ok: true, solutionId: id, enabled: true, polled: false, finalSyncStatus: null };
  const pollIntervalMs = Number.isFinite(Number(options.pollIntervalMs)) ? Number(options.pollIntervalMs) : DEFAULT_POLL_INTERVAL_MS;
  const maxPollAttempts = Number.isFinite(Number(options.maxPollAttempts)) ? Number(options.maxPollAttempts) : DEFAULT_MAX_POLL_ATTEMPTS;
  const pollUrl = `${patchUrl}?$select=sourcecontrolsyncstatus,enabledforsourcecontrolintegration`;
  let finalSyncStatus = null;
  for (let attempt = 1; attempt <= maxPollAttempts; attempt++) {
    if (attempt > 1) await delay(pollIntervalMs);
    const pollRes = await request({ url: pollUrl, method: 'GET', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
    if (pollRes && pollRes.error) return failure(null, pollRes.error);
    if (!pollRes || pollRes.statusCode !== 200) return failure(pollRes && pollRes.statusCode || null, errorMessage(pollRes), hintForStatus(pollRes && pollRes.statusCode, normalizedEnv, id));
    let body;
    try { body = JSON.parse(pollRes.body || '{}'); } catch (e) { return failure(200, 'Failed to parse solution sync status: ' + e.message); }
    finalSyncStatus = body.sourcecontrolsyncstatus;
    if (finalSyncStatus === SYNC_STATUS_SYNCED) {
      return { ok: true, solutionId: id, enabled: true, polled: true, pollAttempts: attempt, finalSyncStatus, durationMs: Date.now() - start };
    }
  }
  return { ok: true, solutionId: id, enabled: true, polled: true, pollAttempts: maxPollAttempts, finalSyncStatus, timedOut: true };
}

if (require.main === module) {
  const args = parseArgs(process.argv);
  enableSolutionSourceControl(args)
    .then((r) => { process.stdout.write(JSON.stringify(r, null, 2) + '\n'); })
    .catch((e) => { process.stderr.write('enable-solution-source-control: ' + (e && e.message ? e.message : e) + '\n'); process.exit(1); });
}
module.exports = { enableSolutionSourceControl, API_VERSION, SYNC_STATUS_SYNCED, DEFAULT_POLL_INTERVAL_MS, DEFAULT_MAX_POLL_ATTEMPTS };
