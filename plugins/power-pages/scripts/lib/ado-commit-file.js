#!/usr/bin/env node

// Commits one or more files to a branch in an Azure DevOps Git repository via the
// Pushes API — the "put the clean merged file in ADO" step of the selective-merge
// apply path. After this push lands on the bound branch, the Power Pages flow runs
// RefreshChangesFromGit → accept-incoming → PullChangesFromGit so the merged content
// flows back into Dataverse (see selective-merge-reference.md).
//
// This is a MUTATION. The consent gate is the caller's responsibility — this helper
// performs the push unconditionally when invoked.
//
// API reference:
//   https://learn.microsoft.com/rest/api/azure/devops/git/pushes/create
//   POST {org}/{project}/_apis/git/repositories/{repo}/pushes?api-version=7.0
//   {
//     "refUpdates": [{ "name": "refs/heads/<branch>", "oldObjectId": "<current tip sha>" }],
//     "commits":    [{ "comment": "...", "changes": [
//        { "changeType": "edit"|"add", "item": { "path": "/..." },
//          "newContent": { "content": "...", "contentType": "rawtext" } } ] }]
//   }
//
// `oldObjectId` MUST be the current branch tip; ADO rejects a stale value with a
// "branch has been updated by another client" conflict. When not supplied, this
// helper resolves it from refs/heads/<branch>.
//
// Output (JSON to stdout):
//   Success: { ok: true, commitId, pushId, branch, fileCount }
//   Failure: { ok: false, statusCode?, error, errorCode? }
//
// Usage:
//   node ado-commit-file.js
//     --organization <o> --project <p> --repository <r>
//     --branch <branch> --comment "<commit message>"
//     --changesFile <path>     // JSON array of { path, content, changeType? (default edit) }
//     [--oldObjectId <sha>]    // branch tip; resolved from refs if omitted
//     [--token <bearer>] | [--pat <PAT>] | [--tokenFile <path>]
//     [--apiVersion <ver>]     // default 7.0 (MUST be a stable, non-preview version)

'use strict';

const fs = require('fs');
const { createAdoClient } = require('./ado-client');
const { resolveAdoTokenOrAcquire } = require('./resolve-ado-token');

const DEFAULT_API_VERSION = '7.0';
const VALID_CHANGE_TYPES = new Set(['edit', 'add']);

function normalizeBranchRef(branch) {
  if (!branch) return branch;
  return branch.startsWith('refs/heads/') ? branch : `refs/heads/${branch.replace(/^\/+/, '')}`;
}

/**
 * Resolve the current tip objectId of a branch via the refs API.
 * @returns {Promise<{ found:boolean, objectId?:string, error?:string, statusCode?:number }>}
 */
async function resolveBranchTip(client, branch) {
  const branchName = normalizeBranchRef(branch).replace(/^refs\/heads\//, '');
  const res = await client.get('/refs', { query: { filter: `heads/${branchName}` } });
  if (res.error) return { found: false, error: res.error };
  if (res.statusCode < 200 || res.statusCode >= 300) {
    let msg = `HTTP ${res.statusCode}`;
    try { msg = JSON.parse(res.body).message || msg; } catch {}
    return { found: false, statusCode: res.statusCode, error: msg };
  }
  let value = [];
  try { value = JSON.parse(res.body).value || []; } catch (e) { return { found: false, error: 'refs body not JSON: ' + e.message }; }
  const exact = value.find((r) => r.name === `refs/heads/${branchName}`) || value[0];
  if (!exact || !exact.objectId) return { found: false, error: `Branch not found: ${branchName}` };
  return { found: true, objectId: exact.objectId };
}

/**
 * Push file change(s) to a branch.
 *
 * @param {object} opts
 * @param {string} opts.organization
 * @param {string} opts.project
 * @param {string} opts.repository
 * @param {string} opts.branch
 * @param {string} opts.comment
 * @param {Array<{path:string, content:string, changeType?:string}>} opts.changes
 * @param {string} [opts.oldObjectId]  Current branch tip; resolved if omitted.
 * @param {string} [opts.token] [opts.pat] [opts.tokenFile]
 * @param {string} [opts.apiVersion]
 * @param {string} [opts.baseUrl]  Test seam.
 * @returns {Promise<object>}
 */
async function commitFiles({
  organization, project, repository, branch, comment, changes,
  oldObjectId = null, token = null, pat = null, tokenFile = null,
  apiVersion = DEFAULT_API_VERSION, baseUrl = null,
} = {}) {
  if (!organization) throw new Error('--organization is required');
  if (!project) throw new Error('--project is required');
  if (!repository) throw new Error('--repository is required');
  if (!branch) throw new Error('--branch is required');
  if (!comment) throw new Error('--comment is required');
  if (!Array.isArray(changes) || changes.length === 0) throw new Error('changes must be a non-empty array');

  const normalizedChanges = changes.map((c, i) => {
    if (!c || !c.path) throw new Error(`changes[${i}].path is required`);
    if (typeof c.content !== 'string') throw new Error(`changes[${i}].content must be a string`);
    const changeType = c.changeType || 'edit';
    if (!VALID_CHANGE_TYPES.has(changeType)) throw new Error(`changes[${i}].changeType must be edit|add; got ${changeType}`);
    return {
      changeType,
      item: { path: c.path.startsWith('/') ? c.path : `/${c.path}` },
      newContent: { content: c.content, contentType: 'rawtext' },
    };
  });

  let resolvedToken = token;
  if (!pat) {
    const tr = resolveAdoTokenOrAcquire({ token, tokenFile, env: process.env });
    if (!tr.ok) throw new Error(`Either --pat or --token/--tokenFile/ADO_TOKEN is required for ADO auth: ${tr.error}`);
    resolvedToken = tr.token;
  }

  const client = createAdoClient({ organization, project, repository, pat, token: resolvedToken, baseUrl, apiVersion });

  // Resolve the branch tip if the caller didn't supply it.
  let tip = oldObjectId;
  if (!tip) {
    const t = await resolveBranchTip(client, branch);
    if (!t.found) return { ok: false, statusCode: t.statusCode || null, error: `Could not resolve branch tip: ${t.error}` };
    tip = t.objectId;
  }

  const pushBody = {
    refUpdates: [{ name: normalizeBranchRef(branch), oldObjectId: tip }],
    commits: [{ comment, changes: normalizedChanges }],
  };

  const res = await client.post('/pushes', { body: pushBody });
  if (res.error) return { ok: false, error: res.error };
  if (res.statusCode !== 200 && res.statusCode !== 201) {
    let msg = `HTTP ${res.statusCode}`;
    let code = null;
    try { const p = JSON.parse(res.body); msg = p.message || msg; code = p.typeKey || null; } catch {}
    return { ok: false, statusCode: res.statusCode, error: msg, errorCode: code };
  }

  let parsed;
  try { parsed = JSON.parse(res.body); } catch (e) {
    return { ok: false, error: 'push returned 2xx but body was not JSON: ' + e.message };
  }
  const commitId = (parsed.commits && parsed.commits[0] && parsed.commits[0].commitId) || null;
  return {
    ok: true,
    commitId,
    pushId: parsed.pushId || null,
    branch: normalizeBranchRef(branch),
    fileCount: normalizedChanges.length,
  };
}

function parseArgs(argv) {
  const a = argv.slice(2);
  const o = { organization: null, project: null, repository: null, branch: null, comment: null,
    changesFile: null, oldObjectId: null, token: null, pat: null, tokenFile: null, apiVersion: DEFAULT_API_VERSION };
  for (let i = 0; i < a.length; i++) {
    const n = a[i + 1];
    if (a[i] === '--organization' && n) o.organization = a[++i];
    else if (a[i] === '--project' && n) o.project = a[++i];
    else if (a[i] === '--repository' && n) o.repository = a[++i];
    else if (a[i] === '--branch' && n) o.branch = a[++i];
    else if (a[i] === '--comment' && n) o.comment = a[++i];
    else if (a[i] === '--changesFile' && n) o.changesFile = a[++i];
    else if (a[i] === '--oldObjectId' && n) o.oldObjectId = a[++i];
    else if (a[i] === '--token' && n) o.token = a[++i];
    else if (a[i] === '--pat' && n) o.pat = a[++i];
    else if (a[i] === '--tokenFile' && n) o.tokenFile = a[++i];
    else if (a[i] === '--apiVersion' && n) o.apiVersion = a[++i];
  }
  return o;
}

if (require.main === module) {
  const args = parseArgs(process.argv);
  (async () => {
    const changes = JSON.parse(fs.readFileSync(args.changesFile, 'utf8'));
    const r = await commitFiles({ ...args, changes });
    process.stdout.write(JSON.stringify(r, null, 2) + '\n');
    if (!r.ok) process.exit(1);
  })().catch((e) => { process.stderr.write('ado-commit-file: ' + e.message + '\n'); process.exit(1); });
}

module.exports = { commitFiles, resolveBranchTip, normalizeBranchRef, VALID_CHANGE_TYPES };
