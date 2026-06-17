#!/usr/bin/env node

// Creates a new branch (git ref) in an EXISTING, non-empty Azure DevOps repo,
// based on the HEAD commit of a base branch. Fills the gap where git-configure's
// branch picker ("➕ Create new branch…") previously had no helper for a
// populated repo — `init-ado-repo.js` only seeds an EMPTY repo's first commit.
// Used by git-configure Phase 4 (branch choice, gate git-configure:4.create-branch)
// in both setup and switch-branch modes.
//
// Branch creation = a ref update POST with oldObjectId = 40 zeros (the "create"
// sentinel) and newObjectId = the base branch's HEAD SHA, so the new branch
// starts as an exact copy of the base branch (your bound content carries over).
//
//   POST {org}/{project}/_apis/git/repositories/{repo}/refs?api-version=7.1
//   Body: [{ "name": "refs/heads/<newBranch>",
//            "oldObjectId": "0000000000000000000000000000000000000000",
//            "newObjectId": "<baseSha>" }]
//
// Idempotent: if <newBranch> already exists, returns ok:true, alreadyExists:true,
// created:false (no POST) so re-runs are safe.
//
// Output (JSON to stdout):
//   Success: {
//     ok: true, organization, project, repository,
//     newBranch, baseBranch, baseSha,
//     created: true | false, alreadyExists: true | false
//   }
//   Failure: { ok:false, statusCode:<int|null>, error:"<message>", hint:"<message>"|null }
//
// Usage:
//   node create-ado-branch.js \
//       --organization <org> --project <proj> --repository <repo> \
//       --newBranch <name> --baseBranch <name> [--baseSha <sha>] [--token <bearer-or-pat>]

'use strict';

const { makeRequest } = require('./validation-helpers');
const { buildAuthHeader } = require('./verify-ado-permissions');
const { resolveAdoTokenOrAcquire } = require('./resolve-ado-token');

const API_VERSION = '7.1';
const ZERO_OBJECT_ID = '0000000000000000000000000000000000000000';

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = {
    organization: null, project: null, repository: null,
    newBranch: null, baseBranch: null, baseSha: null,
    token: null, tokenFile: null,
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--organization' && args[i + 1]) out.organization = args[++i];
    else if (args[i] === '--project' && args[i + 1]) out.project = args[++i];
    else if (args[i] === '--repository' && args[i + 1]) out.repository = args[++i];
    else if ((args[i] === '--newBranch' || args[i] === '--branch') && args[i + 1]) out.newBranch = args[++i];
    else if ((args[i] === '--baseBranch' || args[i] === '--fromBranch') && args[i + 1]) out.baseBranch = args[++i];
    else if (args[i] === '--baseSha' && args[i + 1]) out.baseSha = args[++i];
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

function hintForStatus(sc, repository) {
  if (sc === 401) return 'Token rejected by ADO. If using a PAT, confirm Code (read & write) scope; OAuth bearer needs ADO code write scopes.';
  if (sc === 403) return `Token authenticated but lacks Create Branch / Contribute on "${repository}". Ask the project admin to grant it, then re-run.`;
  if (sc === 404) return `Repository "${repository}" not found, or the token lacks access.`;
  return null;
}

// Strip a leading refs/heads/ and any wrapping whitespace. Branch refs may
// legitimately contain forward slashes (feature/dev-a) so those are preserved.
function normalizeRefName(branch) {
  if (!branch) return null;
  let b = String(branch).trim();
  if (b.startsWith('refs/heads/')) b = b.slice('refs/heads/'.length);
  return b || null;
}

// Validates a git branch name against the load-bearing git check-ref-format
// rules. Forward slashes between segments are allowed; everything that ADO
// would reject is caught BEFORE any network call. Returns { ok:true } or
// { ok:false, error, hint }.
function validateBranchName(name) {
  const hint = 'Use a valid git branch name, e.g. "feature/dev-a" (forward slashes ok; no spaces, backslashes, ".." or control characters).';
  if (!name) return { ok: false, error: 'branch name is empty', hint };
  if (/\\/.test(name)) return { ok: false, error: `branch name must not contain backslashes. Got: "${name}".`, hint };
  if (/\s/.test(name)) return { ok: false, error: `branch name must not contain whitespace. Got: "${name}".`, hint };
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f~^:?*\[]/.test(name)) return { ok: false, error: `branch name contains an invalid character. Got: "${name}".`, hint };
  if (name.startsWith('/') || name.endsWith('/')) return { ok: false, error: `branch name must not start or end with "/". Got: "${name}".`, hint };
  if (name.includes('//') || name.includes('..') || name.includes('@{')) return { ok: false, error: `branch name has an invalid sequence ("//", ".." or "@{"). Got: "${name}".`, hint };
  if (name.startsWith('.') || name.endsWith('.')) return { ok: false, error: `branch name must not start or end with ".". Got: "${name}".`, hint };
  if (name.endsWith('.lock')) return { ok: false, error: `branch name must not end with ".lock". Got: "${name}".`, hint };
  for (const seg of name.split('/')) {
    if (seg === '' || seg.startsWith('.') || seg.endsWith('.lock')) {
      return { ok: false, error: `branch name has an invalid path segment ("${seg}") in "${name}".`, hint };
    }
  }
  return { ok: true };
}

async function getRefObjectId(request, authHeader, adoBase, repoSegment, branch) {
  const url =
    `${adoBase}/${repoSegment}/refs?filter=${encodeURIComponent('heads/' + branch)}` +
    `&$top=1&api-version=${API_VERSION}`;
  const res = await request({
    url, method: 'GET',
    headers: { Authorization: authHeader, Accept: 'application/json' },
  });
  return res;
}

/**
 * @param {object} options
 * @returns {Promise<object>}
 */
async function createAdoBranch(options = {}) {
  const { organization, project, repository, token, tokenFile } = options;
  const newBranch = normalizeRefName(options.newBranch || options.branch);
  const baseBranch = normalizeRefName(options.baseBranch || options.fromBranch);
  const request = typeof options._makeRequestImpl === 'function' ? options._makeRequestImpl : makeRequest;

  if (!organization) return failure(null, '--organization is required');
  if (!project) return failure(null, '--project is required');
  if (!repository) return failure(null, '--repository is required');
  if (!newBranch) return failure(null, '--newBranch is required');
  if (!options.baseSha && !baseBranch) {
    return failure(null, '--baseBranch (or --baseSha) is required so the new branch has a base commit',
      'Pass the branch to fork from, e.g. --baseBranch main.');
  }

  const nameCheck = validateBranchName(newBranch);
  if (!nameCheck.ok) return failure(null, nameCheck.error, nameCheck.hint);

  const tokenResult = resolveAdoTokenOrAcquire({ token, tokenFile, env: process.env });
  if (!tokenResult.ok) return failure(null, tokenResult.error);
  const { header: authHeader } = buildAuthHeader(tokenResult.token);
  const adoBase = `https://dev.azure.com/${encodeURIComponent(organization)}`;
  const repoSegment =
    `${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repository)}`;

  // ---------- Idempotency: does the target branch already exist?
  const existingRes = await getRefObjectId(request, authHeader, adoBase, repoSegment, newBranch);
  if (existingRes && existingRes.error) return failure(null, existingRes.error);
  if (existingRes && existingRes.statusCode === 200) {
    let body;
    try { body = JSON.parse(existingRes.body || '{}'); } catch (e) { return failure(200, 'Failed to parse refs response: ' + e.message); }
    if (Array.isArray(body.value) && body.value.length > 0) {
      return {
        ok: true, organization, project, repository,
        newBranch, baseBranch, baseSha: body.value[0].objectId || null,
        created: false, alreadyExists: true,
      };
    }
  } else if (existingRes && existingRes.statusCode !== 404) {
    return failure(existingRes.statusCode, errorMessage(existingRes), hintForStatus(existingRes.statusCode, repository));
  }

  // ---------- Resolve base SHA (unless caller supplied --baseSha).
  let baseSha = options.baseSha || null;
  if (!baseSha) {
    const baseRes = await getRefObjectId(request, authHeader, adoBase, repoSegment, baseBranch);
    if (baseRes && baseRes.error) return failure(null, baseRes.error);
    if (!baseRes || baseRes.statusCode !== 200) {
      return failure(baseRes && baseRes.statusCode || null, errorMessage(baseRes), hintForStatus(baseRes && baseRes.statusCode, repository));
    }
    let baseBody;
    try { baseBody = JSON.parse(baseRes.body || '{}'); } catch (e) { return failure(200, 'Failed to parse base refs response: ' + e.message); }
    if (!Array.isArray(baseBody.value) || baseBody.value.length === 0) {
      return failure(404, `Base branch "${baseBranch}" not found in ${repository}.`,
        'Pick an existing base branch (e.g. the repo default) to fork from.');
    }
    baseSha = baseBody.value[0].objectId || null;
  }
  if (!baseSha) return failure(null, `Could not resolve a base commit SHA for "${baseBranch}".`);

  // ---------- Create the ref.
  const createUrl = `${adoBase}/${repoSegment}/refs?api-version=${API_VERSION}`;
  const createRes = await request({
    url: createUrl,
    method: 'POST',
    headers: { Authorization: authHeader, Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify([{
      name: `refs/heads/${newBranch}`,
      oldObjectId: ZERO_OBJECT_ID,
      newObjectId: baseSha,
    }]),
  });

  if (createRes && createRes.error) return failure(null, createRes.error);
  if (!createRes || (createRes.statusCode !== 200 && createRes.statusCode !== 201)) {
    return failure(createRes && createRes.statusCode || null, errorMessage(createRes), hintForStatus(createRes && createRes.statusCode, repository));
  }

  let createBody;
  try { createBody = JSON.parse(createRes.body || '{}'); } catch (e) { return failure(200, 'Failed to parse create-ref response: ' + e.message); }
  const result = Array.isArray(createBody.value) ? createBody.value[0] : createBody;
  const succeeded = result && (result.success === true || result.updateStatus === 'succeeded');
  if (!succeeded) {
    const status = result && result.updateStatus ? result.updateStatus : 'unknown';
    return failure(createRes.statusCode, `ADO refused the branch creation (updateStatus: ${status}).`,
      'Confirm you have Create Branch permission and that the base branch is current.');
  }

  return {
    ok: true, organization, project, repository,
    newBranch, baseBranch, baseSha,
    created: true, alreadyExists: false,
  };
}

if (require.main === module) {
  const args = parseArgs(process.argv);
  createAdoBranch(args)
    .then((r) => { process.stdout.write(JSON.stringify(r, null, 2) + '\n'); })
    .catch((e) => {
      process.stderr.write('create-ado-branch: ' + (e && e.message ? e.message : e) + '\n');
      process.exit(1);
    });
}

module.exports = {
  createAdoBranch,
  API_VERSION,
  ZERO_OBJECT_ID,
  normalizeRefName,
  validateBranchName,
};
