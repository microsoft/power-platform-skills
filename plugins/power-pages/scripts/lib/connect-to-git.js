#!/usr/bin/env node

// Binds the current Dataverse environment to an ADO repository + branch via
// the `ConnectToGit` OData action. This is the environment-binding path
// (ConnectionType = 1). For solution binding, see `connect-solution-to-git.js`.
//
// API reference: references/git-integration-api-patterns.md §1
//   POST {envUrl}/api/data/v9.2/ConnectToGit
//   Body: { GitFolder, Branch, ConnectionType: 1, GitProvider: 0,
//           Organization, Project, Repository }
//   Response: 204 No Content
//
// Output (JSON to stdout):
//   Success: {
//     bound: true,
//     bindingType: "environment",
//     organization, project, repository, branch, gitFolder,
//     calledAt: "<ISO>",
//     verifiedBindingId: "<guid>" | null,    // populated when --verify is set
//   }
//   Failure: { error: "<message>", statusCode?: <number>, errorCode?: "<dvCode>" }
//
// Usage:
//   node connect-to-git.js
//       --envUrl       <url>
//       --organization <adoOrg>
//       --project      <adoProject>
//       --repository   <adoRepo>
//       --branch       <branchName>
//       --gitFolder    <folderInRepo>
//       [--token       <dvToken>]
//       [--verify]                  // run detect-git-binding.js after success
//
// TODO: HAR-verify — confirm the response is truly 204 (no body) and not
// 200 with a body on a real tenant. Microsoft Learn says 204.

'use strict';

const { getAuthToken, makeRequest, LONG_RUNNING_GIT_ACTION_TIMEOUT_MS } = require('./validation-helpers');
const { detectGitBinding } = require('./detect-git-binding');

const GIT_PROVIDER_ADO = 0;
// GitHub support (GitProvider=1) is documented but not GA-confirmed.
// TODO: HAR-verify whether GitProvider=1 works in production tenants.
const CONNECTION_TYPE_ENVIRONMENT = 1;

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = {
    envUrl: null, token: null,
    organization: null, project: null, repository: null,
    branch: null, gitFolder: null,
    verify: false,
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--envUrl' && args[i + 1]) out.envUrl = args[++i];
    else if (args[i] === '--token' && args[i + 1]) out.token = args[++i];
    else if (args[i] === '--organization' && args[i + 1]) out.organization = args[++i];
    else if (args[i] === '--project' && args[i + 1]) out.project = args[++i];
    else if (args[i] === '--repository' && args[i + 1]) out.repository = args[++i];
    else if (args[i] === '--branch' && args[i + 1]) out.branch = args[++i];
    else if (args[i] === '--gitFolder' && args[i + 1]) out.gitFolder = args[++i];
    else if (args[i] === '--verify') out.verify = true;
  }
  return out;
}

function requireArg(value, name) {
  if (!value) throw new Error(`--${name} is required`);
}

/**
 * @param {object} options
 * @returns {Promise<object>}
 */
async function connectToGit({
  envUrl, token,
  organization, project, repository, branch, gitFolder,
  verify = false,
} = {}) {
  requireArg(envUrl, 'envUrl');
  requireArg(organization, 'organization');
  requireArg(project, 'project');
  requireArg(repository, 'repository');
  requireArg(branch, 'branch');
  requireArg(gitFolder, 'gitFolder');

  const tok = token || getAuthToken(envUrl);
  if (!tok) return { error: 'Could not acquire auth token. Run `az login` or pass --token.' };

  const base = envUrl.replace(/\/+$/, '');
  const apiUrl = `${base}/api/data/v9.2/ConnectToGit`;

  const body = JSON.stringify({
    GitFolder: gitFolder,
    Branch: branch,
    ConnectionType: CONNECTION_TYPE_ENVIRONMENT,
    GitProvider: GIT_PROVIDER_ADO,
    Organization: organization,
    Project: project,
    Repository: repository,
  });

  const res = await makeRequest({
    url: apiUrl,
    method: 'POST',
    headers: {
      Authorization: `Bearer ${tok}`,
      'OData-MaxVersion': '4.0',
      'OData-Version': '4.0',
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body,
    // ConnectToGit fires the SourceControlInitialSyncPlugin which serializes
    // every component in the env to the bound folder — typically 5–15 min
    // server-side. Pass the long-running override so the helper does not
    // mis-classify a successful slow reply as { error: 'Request timed out' }.
    socketTimeoutMs: LONG_RUNNING_GIT_ACTION_TIMEOUT_MS,
  });

  if (res.error) return { error: res.error };

  // Per spec: 204 No Content on success. Accept 200 too in case the platform
  // returns a body in some scenarios — neither is parsed.
  if (res.statusCode !== 204 && res.statusCode !== 200) {
    let msg = `HTTP ${res.statusCode}`;
    let code = null;
    try {
      const parsed = JSON.parse(res.body);
      msg = parsed.error?.message || msg;
      code = parsed.error?.code || null;
    } catch { /* leave raw */ }
    return { error: msg, statusCode: res.statusCode, errorCode: code };
  }

  const result = {
    bound: true,
    bindingType: 'environment',
    organization,
    project,
    repository,
    branch,
    gitFolder,
    calledAt: new Date().toISOString(),
    verifiedBindingId: null,
  };

  // Verify phase — pillar #2. The action returns 204 with no body; we have to
  // read state back to confirm the binding actually landed.
  if (verify) {
    const binding = await detectGitBinding({ envUrl, token: tok });
    if (binding.bound) {
      result.verifiedBindingId = binding.gitIntegrationId || null;
      result.verifiedAt = new Date().toISOString();
    } else {
      result.verifyWarning = 'ConnectToGit returned 2xx but detect-git-binding did not see a binding. ' +
        'The platform may take a few seconds to propagate; re-check via /power-pages:git-sync.';
    }
  }

  return result;
}

if (require.main === module) {
  const args = parseArgs(process.argv);
  connectToGit(args)
    .then((r) => { process.stdout.write(JSON.stringify(r, null, 2) + '\n'); })
    .catch((e) => {
      process.stderr.write('connect-to-git: ' + e.message + '\n');
      process.exit(1);
    });
}

module.exports = { connectToGit, GIT_PROVIDER_ADO, CONNECTION_TYPE_ENVIRONMENT };
