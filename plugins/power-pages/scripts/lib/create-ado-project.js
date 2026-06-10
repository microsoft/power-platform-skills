#!/usr/bin/env node

// Creates a new Azure DevOps project and polls the operation until it finishes.
// Used by setup-git-integration when the user chooses to create a project
// instead of selecting an existing one.
//
// Idempotency: ADO name conflicts are not retried; they return ok:false with a
// Project already exists hint so the caller can choose the existing project.
//
// Output (JSON to stdout):
//   { "ok": true, "operationId": "<guid>", "status": "succeeded", "projectId": "<guid>", "projectName": "<name>", "durationMs": 1234 }
//   On failure: { "ok": false, "statusCode": <int|null>, "error": "<message>", "hint": "<message>"|null, "operationId": "<guid>" }
//
// Usage:
//   node create-ado-project.js --organization <org> --name <projectName> --token <bearer-or-pat> [--description <text>] [--processTemplateId <guid>] [--pollIntervalMs 2000] [--maxPollAttempts 60]

'use strict';

const { makeRequest } = require('./validation-helpers');
const { buildAuthHeader } = require('./verify-ado-permissions');

const API_VERSION = '7.1';
const AGILE_PROCESS_TEMPLATE_ID = '6b724908-ef14-45cf-84f8-768b5384da45';
const DEFAULT_POLL_INTERVAL_MS = 2000;
const DEFAULT_MAX_POLL_ATTEMPTS = 60;

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = { organization: null, name: null, description: null, processTemplateId: null, token: null, pollIntervalMs: DEFAULT_POLL_INTERVAL_MS, maxPollAttempts: DEFAULT_MAX_POLL_ATTEMPTS };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--organization' && args[i + 1]) out.organization = args[++i];
    else if (args[i] === '--name' && args[i + 1]) out.name = args[++i];
    else if (args[i] === '--description' && args[i + 1]) out.description = args[++i];
    else if (args[i] === '--processTemplateId' && args[i + 1]) out.processTemplateId = args[++i];
    else if (args[i] === '--token' && args[i + 1]) out.token = args[++i];
    else if (args[i] === '--pollIntervalMs' && args[i + 1]) out.pollIntervalMs = Number(args[++i]);
    else if (args[i] === '--maxPollAttempts' && args[i + 1]) out.maxPollAttempts = Number(args[++i]);
  }
  return out;
}
function failure(statusCode, error, hint = null, extra = {}) { return { ok: false, statusCode: statusCode == null ? null : statusCode, error, hint, ...extra }; }
function errorMessage(res) { try { return JSON.parse(res.body || '{}').message || `HTTP ${res.statusCode}`; } catch { return res && res.error ? res.error : `HTTP ${res && res.statusCode}`; } }
function hintForStatus(sc) {
  if (sc === 401) return 'Token rejected by ADO. Confirm the token can create projects in this organization.';
  if (sc === 403) return 'Your account lacks permission to create projects in this ADO organization.';
  if (sc === 400 || sc === 409) return 'Project already exists';
  return null;
}
function delay(ms) { return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve(); }

async function createAdoProject(options = {}) {
  const { organization, name, description, token } = options;
  const request = typeof options._makeRequestImpl === 'function' ? options._makeRequestImpl : makeRequest;
  if (!organization) return failure(null, '--organization is required');
  if (!name) return failure(null, '--name is required');
  if (!token) return failure(null, '--token is required');
  const pollIntervalMs = Number.isFinite(Number(options.pollIntervalMs)) ? Number(options.pollIntervalMs) : DEFAULT_POLL_INTERVAL_MS;
  const maxPollAttempts = Number.isFinite(Number(options.maxPollAttempts)) ? Number(options.maxPollAttempts) : DEFAULT_MAX_POLL_ATTEMPTS;
  const processTemplateId = options.processTemplateId || AGILE_PROCESS_TEMPLATE_ID;
  const start = Date.now();
  const { header: authHeader } = buildAuthHeader(token);
  const url = `https://dev.azure.com/${encodeURIComponent(organization)}/_apis/projects?api-version=${API_VERSION}`;
  const payload = {
    name,
    visibility: 'private',
    capabilities: {
      versioncontrol: { sourceControlType: 'Git' },
      processTemplate: { templateTypeId: processTemplateId },
    },
  };
  if (description) payload.description = description;
  const postRes = await request({ url, method: 'POST', headers: { Authorization: authHeader, Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  if (postRes && postRes.error) return failure(null, postRes.error);
  const postStatus = postRes && postRes.statusCode;
  if (postStatus !== 202) {
    const mapped = postStatus === 400 ? 409 : (postStatus || null);
    return failure(mapped, errorMessage(postRes), hintForStatus(postStatus));
  }
  let op;
  try { op = JSON.parse(postRes.body || '{}'); } catch (e) { return failure(202, 'Failed to parse project create operation: ' + e.message); }
  const operationId = op.id || null;
  if (!operationId) return failure(202, 'ADO project create response did not include an operation id.', null);
  const pollUrl = op.url || `https://dev.azure.com/${encodeURIComponent(organization)}/_apis/operations/${encodeURIComponent(operationId)}?api-version=${API_VERSION}`;
  let lastStatus = op.status || 'queued';
  for (let attempt = 0; attempt < maxPollAttempts; attempt++) {
    if (attempt > 0 || lastStatus !== 'succeeded') {
      if (attempt > 0) await delay(pollIntervalMs);
      const pollRes = await request({ url: pollUrl, method: 'GET', headers: { Authorization: authHeader, Accept: 'application/json' } });
      if (pollRes && pollRes.error) return failure(null, pollRes.error, null, { operationId });
      if (!pollRes || pollRes.statusCode !== 200) return failure(pollRes && pollRes.statusCode || null, errorMessage(pollRes), null, { operationId });
      try { lastStatus = (JSON.parse(pollRes.body || '{}').status || lastStatus); }
      catch (e) { return failure(200, 'Failed to parse operation poll response: ' + e.message, null, { operationId }); }
    }
    if (lastStatus === 'succeeded') return { ok: true, operationId, status: 'succeeded', projectName: name, durationMs: Date.now() - start };
    if (lastStatus === 'failed') return failure(200, 'ADO project creation operation failed.', null, { operationId });
  }
  return failure(null, `Timed out waiting for ADO project creation after ${maxPollAttempts} attempts.`, null, { operationId });
}

if (require.main === module) {
  const args = parseArgs(process.argv);
  createAdoProject(args)
    .then((r) => { process.stdout.write(JSON.stringify(r, null, 2) + '\n'); })
    .catch((e) => { process.stderr.write('create-ado-project: ' + (e && e.message ? e.message : e) + '\n'); process.exit(1); });
}
module.exports = { createAdoProject, API_VERSION, AGILE_PROCESS_TEMPLATE_ID, DEFAULT_POLL_INTERVAL_MS, DEFAULT_MAX_POLL_ATTEMPTS };
