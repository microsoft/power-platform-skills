#!/usr/bin/env node

// Initializes an empty Azure DevOps repo by pushing a single README commit
// on the requested branch. Used by `git-configure` Phase 2 (repo-init gate,
// git-configure:2.repo-init) when `verify-repo-initialized.js` reports the
// target repo has no default branch.
//
// Idempotent: if the repo already has a `defaultBranch`, no write is made.
// This lets the calling skill retry the consent gate safely.
//
// Empty-repo signalling on the ADO Pushes API:
//   refUpdates[0].oldObjectId = "0000000000000000000000000000000000000000"
// See: https://learn.microsoft.com/rest/api/azure/devops/git/pushes/create
//
// Output (JSON to stdout):
//   {
//     "ok":                  true,
//     "initialized":         true | false,
//     "alreadyInitialized":  true | false,
//     "commitId":            "<sha>" | null,
//     "branch":              "main",
//     "pushedAt":            "<ISO 8601>" | null,
//     "organization":        "<org>",
//     "project":             "<proj>",
//     "repository":          "<repo>",
//     "repoId":              "<guid>" | null
//   }
//
//   On failure: { "ok": false, "statusCode": <int|null>, "error": "<message>", "hint": "<message>"|null }
//
// Usage:
//   node init-ado-repo.js \
//       --organization <org> --project <proj> --repository <repo> \
//       --branch <branch> --token <bearer-or-pat> \
//       [--readmeContent "<markdown>"]

'use strict';

const { makeRequest } = require('./validation-helpers');
const { buildAuthHeader } = require('./verify-ado-permissions');
const { resolveAdoToken } = require('./resolve-ado-token');

const EMPTY_REPO_OLD_OBJECT_ID = '0000000000000000000000000000000000000000';
// MUST be a stable api-version (no `-preview.N` suffix). The Pushes endpoint
// (`POST /_apis/git/repositories/{repoId}/pushes`) rejects preview api-versions
// with HTTP 405 "The requested resource does not support http method 'POST'.",
// even though the sibling GET on `/_apis/git/repositories/{repo}` happily
// accepts the same preview value. Field-verified on 2026-06-11:
//   api-version=7.1-preview.1  →  405
//   api-version=7.1            →  201 with commitId
// Keep these in sync if/when bumping the constant; both calls must use stable.
const API_VERSION = '7.1';

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = {
    organization: null,
    project: null,
    repository: null,
    branch: null,
    token: null, tokenFile: null,
    readmeContent: null,
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--organization' && args[i + 1]) out.organization = args[++i];
    else if (args[i] === '--project' && args[i + 1]) out.project = args[++i];
    else if (args[i] === '--repository' && args[i + 1]) out.repository = args[++i];
    else if (args[i] === '--branch' && args[i + 1]) out.branch = args[++i];
    else if (args[i] === '--token' && args[i + 1]) out.token = args[++i];
    else if (args[i] === '--tokenFile' && args[i + 1]) out.tokenFile = args[++i];
    else if (args[i] === '--readmeContent' && args[i + 1]) out.readmeContent = args[++i];
  }
  return out;
}

/**
 * Normalizes a branch name to its full `refs/heads/<name>` form for the ADO
 * Pushes API. Passes through values that are already fully qualified.
 *
 * @param {string} branch
 * @returns {string}
 */
function normalizeBranchRef(branch) {
  if (!branch) return branch;
  if (branch.startsWith('refs/heads/')) return branch;
  return `refs/heads/${branch}`;
}

function defaultReadme({ repository }) {
  const stamp = new Date().toISOString();
  return (
    `# ${repository}\n\n` +
    `Initialized automatically by Power Platform \`git-configure\` skill ` +
    `on ${stamp}.\n\n` +
    `This repository will be populated by Dataverse via the \`ConnectToGit\` ` +
    `integration. Solutions land under \`solutions/<gitFolder>/\` after the ` +
    `first \`commit-to-git\` run.\n`
  );
}

function hintForStatus(statusCode, repoSlug) {
  if (statusCode === 401) {
    return (
      'Token rejected by ADO. If using a PAT, confirm "Code (read & write)" ' +
      'scope. If using OAuth, the bearer token needs the `vso.code_write` ' +
      'scope (the default Entra ADO token mints with this scope).'
    );
  }
  if (statusCode === 403) {
    return (
      `Your account lacks Contribute on this repo. Ask the project admin to ` +
      `grant the Contributors group write access on ${repoSlug}, then re-run.`
    );
  }
  if (statusCode === 404) {
    return (
      `Repository "${repoSlug}" not found. Verify the org / project / ` +
      'repository names match exactly what appears in the ADO portal.'
    );
  }
  return null;
}

/**
 * @param {object} options
 * @param {string} options.organization
 * @param {string} options.project
 * @param {string} options.repository
 * @param {string} options.branch                 e.g. "main" or "refs/heads/main"
 * @param {string} options.token                  PAT or OAuth bearer
 * @param {string} [options.readmeContent]        Override default README body.
 * @param {Function} [options._makeRequestImpl]   DI hook for HTTP (tests).
 * @returns {Promise<object>}
 */
async function initAdoRepo(options = {}) {
  const { organization, project, repository, branch, token, tokenFile, readmeContent } = options;
  const request = typeof options._makeRequestImpl === 'function'
    ? options._makeRequestImpl
    : makeRequest;

  if (!organization) return { ok: false, error: '--organization is required' };
  if (!project) return { ok: false, error: '--project is required' };
  if (!repository) return { ok: false, error: '--repository is required' };
  if (!branch) return { ok: false, error: '--branch is required' };
  const tokenResult = resolveAdoToken({ token, tokenFile, env: process.env });
  if (!tokenResult.ok) return { ok: false, error: tokenResult.error };

  const { header: authHeader } = buildAuthHeader(tokenResult.token);
  const adoBase = `https://dev.azure.com/${encodeURIComponent(organization)}`;
  const repoSlug = `${organization}/${project}/${repository}`;

  // ---------- Step 1 — GET repo metadata; bail out if already initialized.
  const repoUrl =
    `${adoBase}/${encodeURIComponent(project)}/_apis/git/repositories/` +
    `${encodeURIComponent(repository)}?api-version=${API_VERSION}`;
  const repoRes = await request({
    url: repoUrl,
    method: 'GET',
    headers: { Authorization: authHeader, Accept: 'application/json' },
  });

  if (repoRes && repoRes.error) {
    return { ok: false, statusCode: null, error: repoRes.error, hint: null };
  }
  if (!repoRes || repoRes.statusCode !== 200) {
    const sc = repoRes && repoRes.statusCode;
    let msg = `HTTP ${sc}`;
    try { msg = JSON.parse(repoRes.body).message || msg; } catch { /* keep msg */ }
    return { ok: false, statusCode: sc || null, error: msg, hint: hintForStatus(sc, repoSlug) };
  }

  let body;
  try { body = JSON.parse(repoRes.body); }
  catch (e) {
    return { ok: false, statusCode: 200, error: 'Failed to parse repo metadata: ' + e.message, hint: null };
  }

  const repoId = body.id || null;
  const existingDefaultBranch = body.defaultBranch || null;

  if (existingDefaultBranch) {
    return {
      ok: true,
      initialized: false,
      alreadyInitialized: true,
      commitId: null,
      branch: existingDefaultBranch.replace(/^refs\/heads\//, ''),
      pushedAt: null,
      organization,
      project,
      repository,
      repoId,
    };
  }

  if (!repoId) {
    return {
      ok: false,
      statusCode: 200,
      error: 'Repo metadata returned without an id field; cannot push.',
      hint: null,
    };
  }

  // ---------- Step 2 — POST initial commit via the Pushes API.
  const branchRef = normalizeBranchRef(branch);
  const branchName = branchRef.replace(/^refs\/heads\//, '');
  const readme = readmeContent || defaultReadme({ repository });

  const pushUrl =
    `${adoBase}/${encodeURIComponent(project)}/_apis/git/repositories/` +
    `${repoId}/pushes?api-version=${API_VERSION}`;

  const pushBody = {
    refUpdates: [
      {
        name: branchRef,
        oldObjectId: EMPTY_REPO_OLD_OBJECT_ID,
      },
    ],
    commits: [
      {
        comment: 'Initialize repository for Power Platform Git integration',
        changes: [
          {
            changeType: 'add',
            item: { path: '/README.md' },
            newContent: { content: readme, contentType: 'rawtext' },
          },
        ],
      },
    ],
  };

  const pushRes = await request({
    url: pushUrl,
    method: 'POST',
    headers: {
      Authorization: authHeader,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(pushBody),
  });

  if (pushRes && pushRes.error) {
    return { ok: false, statusCode: null, error: pushRes.error, hint: null };
  }
  const sc = pushRes && pushRes.statusCode;
  if (sc !== 200 && sc !== 201) {
    let msg = `HTTP ${sc}`;
    try { msg = JSON.parse(pushRes.body).message || msg; } catch { /* keep msg */ }
    return { ok: false, statusCode: sc || null, error: msg, hint: hintForStatus(sc, repoSlug) };
  }

  let pushBodyParsed;
  try { pushBodyParsed = JSON.parse(pushRes.body); }
  catch (e) {
    return {
      ok: false,
      statusCode: sc,
      error: 'Push succeeded but response was not JSON: ' + e.message,
      hint: null,
    };
  }

  const commitId =
    (pushBodyParsed.commits && pushBodyParsed.commits[0] && pushBodyParsed.commits[0].commitId) ||
    null;

  return {
    ok: true,
    initialized: true,
    alreadyInitialized: false,
    commitId,
    branch: branchName,
    pushedAt: new Date().toISOString(),
    organization,
    project,
    repository,
    repoId,
  };
}

if (require.main === module) {
  const args = parseArgs(process.argv);
  initAdoRepo(args)
    .then((r) => { process.stdout.write(JSON.stringify(r, null, 2) + '\n'); })
    .catch((e) => {
      process.stderr.write('init-ado-repo: ' + (e && e.message ? e.message : e) + '\n');
      process.exit(1);
    });
}

module.exports = {
  initAdoRepo,
  normalizeBranchRef,
  EMPTY_REPO_OLD_OBJECT_ID,
};
