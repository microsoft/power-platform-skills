#!/usr/bin/env node

// Checks whether a specific top-level folder in an Azure DevOps git repository
// is already occupied with content on a specific branch. Used by
// `git-configure` Phase 4 (folder-occupied gate, git-configure:4.folder-occupied,
// solution-binding only) to surface a collision-risk consent gate BEFORE the
// `ConnectToGit` bind co-locates Dataverse-managed files with whatever's
// already in that folder.
//
// Two-step probe:
//   1. GET refs?filter=heads/<branch>&top=1 → obtains headCommitId for the
//      requested branch. If the response value array is empty (or 404 with
//      TF401174), the repo is empty — return ok:true, exists:false,
//      itemCount:0, emptyRepo:true. The folder cannot exist if no commits
//      do; no further query is needed.
//   2. GET items?scopePath=/<gitFolder>/&recursionLevel=OneLevel
//        &versionDescriptor.version=<branch>&versionDescriptor.versionType=branch
//      → 200 with value.length>0 means the folder is occupied; itemCount is
//      that array length. 404/TF401174 means the folder doesn't exist (the
//      branch has commits, but no tree at that path); return exists:false.
//
// This is intentionally a SEPARATE helper from list-ado-folders.js because
// the two have different semantics: list-ado-folders enumerates top-level
// folders for picker UX (recursionLevel=OneLevel on scopePath=/), while this
// helper interrogates ONE specific path's occupancy on ONE specific branch
// (with a versionDescriptor — list-ado-folders defaults to the repo's HEAD).
//
// Output (JSON to stdout):
//   {
//     "ok":            true,
//     "organization":  "<org>",
//     "project":       "<proj>",
//     "repository":    "<repo>",
//     "branch":        "<branch>",
//     "gitFolder":     "<folder>",
//     "exists":        true | false,
//     "itemCount":     <number>,
//     "headCommitId":  "<sha>" | null,
//     "emptyRepo":     true | undefined
//   }
//
//   On failure: { "ok": false, "statusCode": <int|null>, "error": "<message>", "hint": "<message>"|null }
//
// Usage:
//   node check-ado-folder-exists.js \
//       --organization <org> --project <proj> --repository <repo> \
//       --gitFolder <folder> --branch <branch> --token <bearer-or-pat>

'use strict';

const { makeRequest } = require('./validation-helpers');
const { buildAuthHeader } = require('./verify-ado-permissions');
const { resolveAdoToken } = require('./resolve-ado-token');

const API_VERSION = '7.1';

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = {
    organization: null, project: null, repository: null,
    gitFolder: null, branch: null, token: null, tokenFile: null,
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--organization' && args[i + 1]) out.organization = args[++i];
    else if (args[i] === '--project' && args[i + 1]) out.project = args[++i];
    else if (args[i] === '--repository' && args[i + 1]) out.repository = args[++i];
    else if ((args[i] === '--gitFolder' || args[i] === '--folder') && args[i + 1]) out.gitFolder = args[++i];
    else if (args[i] === '--branch' && args[i + 1]) out.branch = args[++i];
    else if (args[i] === '--token' && args[i + 1]) out.token = args[++i];
    else if (args[i] === '--tokenFile' && args[i + 1]) out.tokenFile = args[++i];
  }
  return out;
}

function failure(statusCode, error, hint = null) {
  return { ok: false, statusCode: statusCode == null ? null : statusCode, error, hint };
}

function errorMessage(res) {
  try { return JSON.parse(res.body || '{}').message || `HTTP ${res.statusCode}`; }
  catch { return res && res.error ? res.error : `HTTP ${res && res.statusCode}`; }
}

function isEmptyRepo404(res) {
  if (!res || res.statusCode !== 404) return false;
  const text = String(res.body || '');
  return /TF401174/i.test(text) || /doesn'?t exist/i.test(text);
}

function hintForStatus(sc, repository) {
  if (sc === 401) {
    return 'Token rejected by ADO. If using a PAT, confirm Code (read) scope. If using OAuth, the bearer token needs ADO code read scopes.';
  }
  if (sc === 403) {
    return `Token authenticated but lacks read access to "${repository}". Ask the project admin to grant Reader on the repo or the Contributors group, then re-run.`;
  }
  if (sc === 404) {
    return `Repository "${repository}" not found, or the token lacks access.`;
  }
  return null;
}

// Strip leading slash, strip refs/heads/ prefix, defensively trim whitespace.
// Mirrors the format the git-configure skill normalizes before invoking this
// helper (the skill's Phase 4 solution-binding flow requires a plain branch name).
function normalizeBranch(branch) {
  if (!branch) return null;
  let b = String(branch).trim();
  if (b.startsWith('refs/heads/')) b = b.slice('refs/heads/'.length);
  if (b.startsWith('/')) b = b.slice(1);
  return b || null;
}

// Strip leading and trailing slashes; the 3e sub-step's prompt forbids
// trailing slashes but a defensive strip here keeps the helper usable
// from contexts that haven't been through that validation (tests, ad-hoc
// CLI use). DOES NOT silently sanitize embedded slashes — those still
// produce an error.
function normalizeGitFolder(folder) {
  if (!folder) return null;
  let f = String(folder).trim();
  if (f.startsWith('/')) f = f.slice(1);
  if (f.endsWith('/')) f = f.slice(0, -1);
  return f || null;
}

/**
 * @param {object} options
 * @param {string} options.organization
 * @param {string} options.project
 * @param {string} options.repository
 * @param {string} options.gitFolder      Plain folder name; no slashes.
 * @param {string} options.branch         Plain branch name; no refs/heads/.
 * @param {string} options.token          PAT or OAuth bearer.
 * @param {Function} [options._makeRequestImpl]   DI hook for HTTP (tests).
 * @returns {Promise<object>}
 */
async function checkAdoFolderExists(options = {}) {
  const { organization, project, repository, token, tokenFile } = options;
  const gitFolder = normalizeGitFolder(options.folder || options.gitFolder);
  const branch = normalizeBranch(options.branch);
  const request = typeof options._makeRequestImpl === 'function'
    ? options._makeRequestImpl
    : makeRequest;

  if (!organization) return failure(null, '--organization is required');
  if (!project) return failure(null, '--project is required');
  if (!repository) return failure(null, '--repository is required');
  if (!gitFolder) return failure(null, '--gitFolder is required');
  if (!branch) return failure(null, '--branch is required');

  // Reject embedded path separators with a clear error — this helper
  // checks a single top-level folder, not nested paths.
  if (/[\/\\]/.test(gitFolder)) {
    return failure(null,
      `--gitFolder must be a single folder name (no '/' or '\\'). Got: "${gitFolder}".`,
      'Pass just the folder name, e.g. "solutions" (NOT "solutions/sub" or "/solutions").');
  }

  const tokenResult = resolveAdoToken({ token, tokenFile, env: process.env });
  if (!tokenResult.ok) return failure(null, tokenResult.error);
  const { header: authHeader } = buildAuthHeader(tokenResult.token);
  const adoBase = `https://dev.azure.com/${encodeURIComponent(organization)}`;
  const repoSegment =
    `${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repository)}`;

  // ---------- Step 1 — GET refs/heads/<branch> to obtain headCommitId.
  const refsUrl =
    `${adoBase}/${repoSegment}/refs?filter=${encodeURIComponent('heads/' + branch)}` +
    `&$top=1&api-version=${API_VERSION}`;
  const refsRes = await request({
    url: refsUrl,
    method: 'GET',
    headers: { Authorization: authHeader, Accept: 'application/json' },
  });

  if (refsRes && refsRes.error) return failure(null, refsRes.error);
  if (isEmptyRepo404(refsRes)) {
    return {
      ok: true, organization, project, repository, branch, gitFolder,
      exists: false, itemCount: 0, headCommitId: null, emptyRepo: true,
    };
  }
  if (!refsRes || refsRes.statusCode !== 200) {
    return failure(refsRes && refsRes.statusCode || null,
      errorMessage(refsRes),
      hintForStatus(refsRes && refsRes.statusCode, repository));
  }

  let refsBody;
  try { refsBody = JSON.parse(refsRes.body || '{}'); }
  catch (e) { return failure(200, 'Failed to parse refs response: ' + e.message); }

  if (!Array.isArray(refsBody.value) || refsBody.value.length === 0) {
    // No matching branch ref — either the repo is empty or the branch
    // doesn't exist yet. Either way, the folder cannot exist on it.
    // The helper conservatively reports exists:false; the caller can
    // distinguish empty-repo from missing-branch by running
    // verify-repo-initialized first (git-configure Phase 2 repo-init gate
    // already runs this immediately before the folder-occupied check in Phase 4).
    return {
      ok: true, organization, project, repository, branch, gitFolder,
      exists: false, itemCount: 0, headCommitId: null,
    };
  }

  const headCommitId = refsBody.value[0].objectId || null;

  // ---------- Step 2 — GET items at /<gitFolder>/ on <branch>.
  const itemsUrl =
    `${adoBase}/${repoSegment}/items` +
    `?scopePath=${encodeURIComponent('/' + gitFolder + '/')}` +
    `&recursionLevel=OneLevel` +
    `&versionDescriptor.version=${encodeURIComponent(branch)}` +
    `&versionDescriptor.versionType=branch` +
    `&api-version=${API_VERSION}`;
  const itemsRes = await request({
    url: itemsUrl,
    method: 'GET',
    headers: { Authorization: authHeader, Accept: 'application/json' },
  });

  if (itemsRes && itemsRes.error) return failure(null, itemsRes.error);
  if (isEmptyRepo404(itemsRes)) {
    return {
      ok: true, organization, project, repository, branch, gitFolder,
      exists: false, itemCount: 0, headCommitId,
    };
  }
  if (!itemsRes || itemsRes.statusCode !== 200) {
    return failure(itemsRes && itemsRes.statusCode || null,
      errorMessage(itemsRes),
      hintForStatus(itemsRes && itemsRes.statusCode, repository));
  }

  let itemsBody;
  try { itemsBody = JSON.parse(itemsRes.body || '{}'); }
  catch (e) { return failure(200, 'Failed to parse items response: ' + e.message); }

  // The /items endpoint with scopePath=/<gitFolder>/ returns the folder
  // itself as the first entry when the folder exists. We count only the
  // CHILDREN (entries whose path is NOT exactly /<gitFolder>) so itemCount
  // reflects what's actually inside the folder.
  const scopePath = '/' + gitFolder;
  const allItems = Array.isArray(itemsBody.value) ? itemsBody.value : [];
  const children = allItems.filter((i) => i && i.path && i.path !== scopePath);

  if (allItems.length === 0) {
    return {
      ok: true, organization, project, repository, branch, gitFolder,
      exists: false, itemCount: 0, headCommitId,
    };
  }

  return {
    ok: true, organization, project, repository, branch, gitFolder,
    exists: true, itemCount: children.length, headCommitId,
  };
}

if (require.main === module) {
  const args = parseArgs(process.argv);
  checkAdoFolderExists(args)
    .then((r) => { process.stdout.write(JSON.stringify(r, null, 2) + '\n'); })
    .catch((e) => {
      process.stderr.write('check-ado-folder-exists: ' + (e && e.message ? e.message : e) + '\n');
      process.exit(1);
    });
}

module.exports = {
  checkAdoFolderExists,
  API_VERSION,
  isEmptyRepo404,
  normalizeBranch,
  normalizeGitFolder,
};
