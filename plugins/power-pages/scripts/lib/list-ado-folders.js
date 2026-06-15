#!/usr/bin/env node

// Lists top-level folders in an Azure DevOps git repository for gitFolder
// selection during git-configure (Phase 4). Only tree entries are returned.
//
// Empty-repo handling: ADO may return 404 TF401174 for an empty repository's
// items endpoint. That specific signal is treated as success with emptyRepo:true.
//
// Output (JSON to stdout):
//   { "ok": true, "organization": "<org>", "project": "<proj>", "repository": "<repo>", "count": 1, "folders": [{ "path": "/solutions", "isFolder": true, "gitObjectType": "tree" }] }
//   On failure: { "ok": false, "statusCode": <int|null>, "error": "<message>", "hint": "<message>"|null }
//
// Usage:
//   node list-ado-folders.js --organization <org> --project <proj> --repository <repo> --token <bearer-or-pat>

'use strict';

const { makeRequest } = require('./validation-helpers');
const { buildAuthHeader } = require('./verify-ado-permissions');
const { resolveAdoToken } = require('./resolve-ado-token');

const API_VERSION = '7.1';

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = { organization: null, project: null, repository: null, token: null, tokenFile: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--organization' && args[i + 1]) out.organization = args[++i];
    else if (args[i] === '--project' && args[i + 1]) out.project = args[++i];
    else if (args[i] === '--repository' && args[i + 1]) out.repository = args[++i];
    else if (args[i] === '--token' && args[i + 1]) out.token = args[++i];
    else if (args[i] === '--tokenFile' && args[i + 1]) out.tokenFile = args[++i];
  }
  return out;
}
function failure(statusCode, error, hint = null) { return { ok: false, statusCode: statusCode == null ? null : statusCode, error, hint }; }
function errorMessage(res) { try { return JSON.parse(res.body || '{}').message || `HTTP ${res.statusCode}`; } catch { return res && res.error ? res.error : `HTTP ${res && res.statusCode}`; } }
function isEmptyRepo404(res) {
  if (!res || res.statusCode !== 404) return false;
  const text = String(res.body || '');
  return /TF401174/i.test(text) || /doesn'?t exist/i.test(text);
}
function hintForStatus(sc, repository) {
  if (sc === 401) return 'Token rejected by ADO. If using a PAT, confirm Code (read) scope. If using OAuth, the bearer token needs ADO code read scopes.';
  if (sc === 404) return `Repository "${repository}" not found, or the token lacks access.`;
  return null;
}
async function listAdoFolders(options = {}) {
  const { organization, project, repository, token, tokenFile } = options;
  const request = typeof options._makeRequestImpl === 'function' ? options._makeRequestImpl : makeRequest;
  if (!organization) return failure(null, '--organization is required');
  if (!project) return failure(null, '--project is required');
  if (!repository) return failure(null, '--repository is required');
  const tokenResult = resolveAdoToken({ token, tokenFile, env: process.env });
  if (!tokenResult.ok) return failure(null, tokenResult.error);
  const { header: authHeader } = buildAuthHeader(tokenResult.token);
  const url = `https://dev.azure.com/${encodeURIComponent(organization)}/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repository)}/items?scopePath=/&recursionLevel=OneLevel&api-version=${API_VERSION}`;
  const res = await request({ url, method: 'GET', headers: { Authorization: authHeader, Accept: 'application/json' } });
  if (res && res.error) return failure(null, res.error);
  if (isEmptyRepo404(res)) return { ok: true, organization, project, repository, count: 0, folders: [], emptyRepo: true };
  if (!res || res.statusCode !== 200) return failure(res && res.statusCode || null, errorMessage(res), hintForStatus(res && res.statusCode, repository));
  let body;
  try { body = JSON.parse(res.body || '{}'); } catch (e) { return failure(200, 'Failed to parse items response: ' + e.message); }
  if (!Array.isArray(body.value)) return failure(200, 'Items response missing value array.');
  const folders = body.value
    .filter((i) => i && i.isFolder === true && i.gitObjectType === 'tree')
    .map((i) => ({ path: i.path || null, isFolder: true, gitObjectType: 'tree' }));
  return { ok: true, organization, project, repository, count: folders.length, folders };
}
if (require.main === module) {
  const args = parseArgs(process.argv);
  listAdoFolders(args)
    .then((r) => { process.stdout.write(JSON.stringify(r, null, 2) + '\n'); })
    .catch((e) => { process.stderr.write('list-ado-folders: ' + (e && e.message ? e.message : e) + '\n'); process.exit(1); });
}
module.exports = { listAdoFolders, API_VERSION, isEmptyRepo404 };
