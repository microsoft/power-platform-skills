#!/usr/bin/env node

// Lists the branches (heads) on an Azure DevOps repository so the caller can
// present them as a choice picker — used by git-configure Phase 4 to let the
// user PICK an existing branch (switch-branch / setup) instead of silently
// defaulting to the repo's default branch.
//
// API reference:
//   https://learn.microsoft.com/en-us/rest/api/azure/devops/git/refs/list
//
//   GET {org}/{project}/_apis/git/repositories/{repo}/refs?filter=heads/&api-version=7.0
//
// Response: { value: [{ name: "refs/heads/main", objectId, ... }], count }
//
// Output (JSON to stdout):
//   Success: {
//     ok: true, organization, project, repository,
//     defaultBranch: "main" | null,           // echoed when --default-branch passed
//     count: <number>,
//     branches: [ "main", "feature/x", ... ]   // short names, refs/heads/ stripped, sorted
//   }
//   Empty repo (no heads yet): { ok: true, ..., count: 0, branches: [], emptyRepo: true }
//   Failure: { ok: false, error, statusCode?, errorCode? }
//
// Usage:
//   node list-ado-branches.js
//       --organization <org>
//       --project      <project>
//       --repository   <repo>            // accepts name OR GUID
//       [--default-branch <name>]        // optional; echoed back for picker default-marking
//       [--pat <PAT>] | [--token <bearer>] | [--tokenFile <path>]
//       [--apiVersion <ver>]             // default 7.0

'use strict';

const { createAdoClient } = require('./ado-client');
const { resolveAdoTokenOrAcquire } = require('./resolve-ado-token');

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = {
    organization: null, project: null, repository: null, defaultBranch: null,
    pat: null, token: null, tokenFile: null, apiVersion: '7.0',
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--organization' && args[i + 1]) out.organization = args[++i];
    else if (args[i] === '--project' && args[i + 1]) out.project = args[++i];
    else if (args[i] === '--repository' && args[i + 1]) out.repository = args[++i];
    else if (args[i] === '--default-branch' && args[i + 1]) out.defaultBranch = args[++i];
    else if (args[i] === '--pat' && args[i + 1]) out.pat = args[++i];
    else if (args[i] === '--token' && args[i + 1]) out.token = args[++i];
    else if (args[i] === '--tokenFile' && args[i + 1]) out.tokenFile = args[++i];
    else if (args[i] === '--apiVersion' && args[i + 1]) out.apiVersion = args[++i];
  }
  return out;
}

function stripHeads(ref) {
  return typeof ref === 'string' ? ref.replace(/^refs\/heads\//, '') : ref;
}

async function listAdoBranches({
  organization, project, repository, defaultBranch = null,
  pat = null, token = null, tokenFile = null,
  apiVersion = '7.0', baseUrl = null,
} = {}) {
  if (!organization) throw new Error('--organization is required');
  if (!project) throw new Error('--project is required');
  if (!repository) throw new Error('--repository is required');

  let resolvedToken = token;
  if (!pat) {
    const tokenResult = resolveAdoTokenOrAcquire({ token, tokenFile, env: process.env });
    if (!tokenResult.ok) throw new Error(`Either --pat or --token/--tokenFile/ADO_TOKEN is required for ADO auth: ${tokenResult.error}`);
    resolvedToken = tokenResult.token;
  }

  const client = createAdoClient({ organization, project, repository, pat, token: resolvedToken, baseUrl, apiVersion });
  const res = await client.get('/refs', { query: { filter: 'heads/' } });

  if (res.error) return { ok: false, error: res.error };
  if (res.statusCode < 200 || res.statusCode >= 300) {
    let msg = `HTTP ${res.statusCode}`;
    let code = null;
    try {
      const parsed = JSON.parse(res.body);
      msg = parsed.message || msg;
      code = parsed.typeKey || parsed.errorCode || null;
    } catch {}
    return { ok: false, error: msg, statusCode: res.statusCode, errorCode: code };
  }

  let parsed;
  try { parsed = JSON.parse(res.body); } catch (e) {
    return { ok: false, error: 'list-ado-branches returned 2xx but body was not JSON: ' + e.message };
  }

  const rows = Array.isArray(parsed.value) ? parsed.value : [];
  const branches = rows
    .map((r) => stripHeads(r.name))
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));

  const result = {
    ok: true,
    organization, project, repository,
    defaultBranch: defaultBranch ? stripHeads(defaultBranch) : null,
    count: branches.length,
    branches,
  };
  if (branches.length === 0) result.emptyRepo = true;
  return result;
}

if (require.main === module) {
  const args = parseArgs(process.argv);
  listAdoBranches(args)
    .then((r) => { process.stdout.write(JSON.stringify(r, null, 2) + '\n'); if (!r.ok) process.exit(1); })
    .catch((e) => {
      process.stderr.write('list-ado-branches: ' + e.message + '\n');
      process.exit(1);
    });
}

module.exports = { listAdoBranches, stripHeads };
