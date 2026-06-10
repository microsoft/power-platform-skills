#!/usr/bin/env node

// Lists Azure DevOps git repositories in a project.
// Empty repositories are returned with defaultBranch:null so callers can decide
// whether to run init-ado-repo.js.
//
// Output (JSON to stdout):
//   { "ok": true, "organization": "<org>", "project": "<proj>", "count": 1, "repos": [{ "id": "<guid>", "name": "repo", "defaultBranch": null, "size": 0, "webUrl": "https://...", "isDisabled": false }] }
//   On failure: { "ok": false, "statusCode": <int|null>, "error": "<message>", "hint": "<message>"|null }
//
// Usage:
//   node list-ado-repos.js --organization <org> --project <proj> --token <bearer-or-pat>

'use strict';

const { makeRequest } = require('./validation-helpers');
const { buildAuthHeader } = require('./verify-ado-permissions');

const API_VERSION = '7.1';

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = { organization: null, project: null, token: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--organization' && args[i + 1]) out.organization = args[++i];
    else if (args[i] === '--project' && args[i + 1]) out.project = args[++i];
    else if (args[i] === '--token' && args[i + 1]) out.token = args[++i];
  }
  return out;
}
function failure(statusCode, error, hint = null) { return { ok: false, statusCode: statusCode == null ? null : statusCode, error, hint }; }
function errorMessage(res) { try { return JSON.parse(res.body || '{}').message || `HTTP ${res.statusCode}`; } catch { return res && res.error ? res.error : `HTTP ${res && res.statusCode}`; } }
function hintForStatus(sc, project) {
  if (sc === 401) return 'Token rejected by ADO. If using a PAT, confirm Code (read) scope. If using OAuth, the bearer token needs ADO code read scopes.';
  if (sc === 404) return `Project "${project}" not found. Verify the project exists and the token can access it.`;
  return null;
}
async function listAdoRepos(options = {}) {
  const { organization, project, token } = options;
  const request = typeof options._makeRequestImpl === 'function' ? options._makeRequestImpl : makeRequest;
  if (!organization) return failure(null, '--organization is required');
  if (!project) return failure(null, '--project is required');
  if (!token) return failure(null, '--token is required');
  const { header: authHeader } = buildAuthHeader(token);
  const url = `https://dev.azure.com/${encodeURIComponent(organization)}/${encodeURIComponent(project)}/_apis/git/repositories?api-version=${API_VERSION}`;
  const res = await request({ url, method: 'GET', headers: { Authorization: authHeader, Accept: 'application/json' } });
  if (res && res.error) return failure(null, res.error);
  if (!res || res.statusCode !== 200) return failure(res && res.statusCode || null, errorMessage(res), hintForStatus(res && res.statusCode, project));
  let body;
  try { body = JSON.parse(res.body || '{}'); } catch (e) { return failure(200, 'Failed to parse repositories response: ' + e.message); }
  if (!Array.isArray(body.value)) return failure(200, 'Repositories response missing value array.');
  const repos = body.value.map((r) => ({
    id: r.id || null,
    name: r.name || null,
    defaultBranch: r.defaultBranch || null,
    size: typeof r.size === 'number' ? r.size : 0,
    webUrl: r.webUrl || r.remoteUrl || r.url || null,
    isDisabled: r.isDisabled,
  }));
  return { ok: true, organization, project, count: repos.length, repos };
}
if (require.main === module) {
  const args = parseArgs(process.argv);
  listAdoRepos(args)
    .then((r) => { process.stdout.write(JSON.stringify(r, null, 2) + '\n'); })
    .catch((e) => { process.stderr.write('list-ado-repos: ' + (e && e.message ? e.message : e) + '\n'); process.exit(1); });
}
module.exports = { listAdoRepos, API_VERSION };
