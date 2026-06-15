#!/usr/bin/env node

// Lists Azure DevOps projects in an organization.
// Used by git-configure discovery flows (Phase 4) after org selection.
//
// Output (JSON to stdout):
//   { "ok": true, "organization": "<org>", "count": 1, "projects": [{ "id": "<guid>", "name": "proj", "description": "...", "state": "wellFormed", "visibility": "private" }] }
//   On failure: { "ok": false, "statusCode": <int|null>, "error": "<message>", "hint": "<message>"|null }
//
// Usage:
//   node list-ado-projects.js --organization <org> --token <bearer-or-pat>

'use strict';

const { makeRequest } = require('./validation-helpers');
const { buildAuthHeader } = require('./verify-ado-permissions');
const { resolveAdoTokenOrAcquire } = require('./resolve-ado-token');

const API_VERSION = '7.1';

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = { organization: null, token: null, tokenFile: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--organization' && args[i + 1]) out.organization = args[++i];
    else if (args[i] === '--token' && args[i + 1]) out.token = args[++i];
    else if (args[i] === '--tokenFile' && args[i + 1]) out.tokenFile = args[++i];
  }
  return out;
}

function failure(statusCode, error, hint = null) { return { ok: false, statusCode: statusCode == null ? null : statusCode, error, hint }; }
function errorMessage(res) { try { return JSON.parse(res.body || '{}').message || `HTTP ${res.statusCode}`; } catch { return res && res.error ? res.error : `HTTP ${res && res.statusCode}`; } }
function hintForStatus(sc, org) {
  if (sc === 401) return 'Token rejected by ADO. If using a PAT, confirm project read access. If using OAuth, the bearer token needs ADO read scopes.';
  if (sc === 404) return `Organization "${org}" not found. Verify it exists at https://dev.azure.com/${org}.`;
  return null;
}

async function listAdoProjects(options = {}) {
  const { organization, token, tokenFile } = options;
  const request = typeof options._makeRequestImpl === 'function' ? options._makeRequestImpl : makeRequest;
  if (!organization) return failure(null, '--organization is required');
  const tokenResult = resolveAdoTokenOrAcquire({ token, tokenFile, env: process.env });
  if (!tokenResult.ok) return failure(null, tokenResult.error);
  const { header: authHeader } = buildAuthHeader(tokenResult.token);
  const url = `https://dev.azure.com/${encodeURIComponent(organization)}/_apis/projects?api-version=${API_VERSION}`;
  const res = await request({ url, method: 'GET', headers: { Authorization: authHeader, Accept: 'application/json' } });
  if (res && res.error) return failure(null, res.error);
  if (!res || res.statusCode !== 200) return failure(res && res.statusCode || null, errorMessage(res), hintForStatus(res && res.statusCode, organization));
  let body;
  try { body = JSON.parse(res.body || '{}'); }
  catch (e) { return failure(200, 'Failed to parse projects response: ' + e.message); }
  if (!Array.isArray(body.value)) return failure(200, 'Projects response missing value array.');
  const projects = body.value.map((p) => ({
    id: p.id || null,
    name: p.name || null,
    description: p.description,
    state: p.state || null,
    visibility: p.visibility,
  }));
  return { ok: true, organization, count: projects.length, projects };
}

if (require.main === module) {
  const args = parseArgs(process.argv);
  listAdoProjects(args)
    .then((r) => { process.stdout.write(JSON.stringify(r, null, 2) + '\n'); })
    .catch((e) => { process.stderr.write('list-ado-projects: ' + (e && e.message ? e.message : e) + '\n'); process.exit(1); });
}

module.exports = { listAdoProjects, API_VERSION };
