#!/usr/bin/env node

// Creates a new empty Azure DevOps git repository in an existing project.
// Used by git-configure (Phase 4 create-repo gate, git-configure:4.create-repo)
// when the user chooses to create a repo instead of selecting an existing one.
//
// Idempotency: repo name conflicts are not retried; they return ok:false with a
// targeted hint so the caller can choose the existing repo or a new name.
//
// Output (JSON to stdout):
//   { "ok": true, "organization": "<org>", "project": "<proj>", "repoId": "<guid>", "repoName": "<name>", "defaultBranch": null, "webUrl": "https://..." }
//   On failure: { "ok": false, "statusCode": <int|null>, "error": "<message>", "hint": "<message>"|null }
//
// Usage:
//   node create-ado-repo.js --organization <org> --project <proj> --projectId <guid> --name <repoName> --token <bearer-or-pat>

'use strict';

const { makeRequest } = require('./validation-helpers');
const { buildAuthHeader } = require('./verify-ado-permissions');
const { resolveAdoTokenOrAcquire } = require('./resolve-ado-token');

const API_VERSION = '7.1';

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = { organization: null, project: null, projectId: null, name: null, token: null, tokenFile: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--organization' && args[i + 1]) out.organization = args[++i];
    else if (args[i] === '--project' && args[i + 1]) out.project = args[++i];
    else if (args[i] === '--projectId' && args[i + 1]) out.projectId = args[++i];
    else if (args[i] === '--name' && args[i + 1]) out.name = args[++i];
    else if (args[i] === '--token' && args[i + 1]) out.token = args[++i];
    else if (args[i] === '--tokenFile' && args[i + 1]) out.tokenFile = args[++i];
  }
  return out;
}
function failure(statusCode, error, hint = null) { return { ok: false, statusCode: statusCode == null ? null : statusCode, error, hint }; }
function errorMessage(res) { try { return JSON.parse(res.body || '{}').message || `HTTP ${res.statusCode}`; } catch { return res && res.error ? res.error : `HTTP ${res && res.statusCode}`; } }
function hintForStatus(sc, name, project) {
  if (sc === 403) return `Your account lacks Project Administrator on "${project}". Required for repo creation.`;
  if (sc === 409) return `Repo "${name}" already exists in project "${project}". Pick a different name or use the existing repo.`;
  if (sc === 401) return 'Token rejected by ADO. Confirm the token can create repositories in this project.';
  if (sc === 404) return `Project "${project}" not found. Verify it exists and the token can access it.`;
  return null;
}
async function createAdoRepo(options = {}) {
  const { organization, project, projectId, name, token, tokenFile } = options;
  const request = typeof options._makeRequestImpl === 'function' ? options._makeRequestImpl : makeRequest;
  if (!organization) return failure(null, '--organization is required');
  if (!project) return failure(null, '--project is required');
  if (!projectId) return failure(null, '--projectId is required');
  if (!name) return failure(null, '--name is required');
  const tokenResult = resolveAdoTokenOrAcquire({ token, tokenFile, env: process.env });
  if (!tokenResult.ok) return failure(null, tokenResult.error);
  const { header: authHeader } = buildAuthHeader(tokenResult.token);
  const url = `https://dev.azure.com/${encodeURIComponent(organization)}/${encodeURIComponent(project)}/_apis/git/repositories?api-version=${API_VERSION}`;
  const payload = { name, project: { id: projectId } };
  const res = await request({ url, method: 'POST', headers: { Authorization: authHeader, Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  if (res && res.error) return failure(null, res.error);
  if (!res || res.statusCode !== 201) return failure(res && res.statusCode || null, errorMessage(res), hintForStatus(res && res.statusCode, name, project));
  let body;
  try { body = JSON.parse(res.body || '{}'); } catch (e) { return failure(201, 'Failed to parse create repo response: ' + e.message); }
  if (!body.id) return failure(201, 'Create repo response missing id field.');
  return { ok: true, organization, project, repoId: body.id, repoName: body.name || name, defaultBranch: body.defaultBranch || null, webUrl: body.webUrl || body.remoteUrl || body.url || null };
}
if (require.main === module) {
  const args = parseArgs(process.argv);
  createAdoRepo(args)
    .then((r) => { process.stdout.write(JSON.stringify(r, null, 2) + '\n'); })
    .catch((e) => { process.stderr.write('create-ado-repo: ' + (e && e.message ? e.message : e) + '\n'); process.exit(1); });
}
module.exports = { createAdoRepo, API_VERSION };
