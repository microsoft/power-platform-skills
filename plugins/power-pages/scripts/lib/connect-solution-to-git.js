#!/usr/bin/env node

// Binds a specific Dataverse solution to an ADO repository + branch via the
// `ConnectToGit` OData action with ConnectionType=0 (solution binding).
//
// Detects whether this is the FIRST solution binding for this env (in which
// case org/project/repo/rootFolder are required) or a SUBSEQUENT one (which
// inherits those from the existing connection — only solutionUniqueName,
// gitFolder, branch are needed).
//
// API reference: references/git-integration-api-patterns.md §2 and §3
//   First solution:
//     { GitFolder, Branch, ConnectionType: 0, GitProvider: 0,
//       Organization, Project, Repository, RootFolder, SolutionUniqueName }
//   Subsequent solution:
//     { GitFolder, Branch, SolutionUniqueName }
//
// Output (JSON to stdout):
//   Success: {
//     bound: true,
//     bindingType: "solution",
//     solutionUniqueName, organization, project, repository, branch, gitFolder, rootFolder,
//     isFirstSolutionBinding: true | false,
//     calledAt: "<ISO>",
//   }
//   Failure: { error, statusCode?, errorCode? }
//
// Usage:
//   node connect-solution-to-git.js
//       --envUrl              <url>
//       --solutionUniqueName  <name>
//       --branch              <branchName>
//       --gitFolder           <folderInRepo>
//       [--organization       <adoOrg>]       // required for FIRST binding only
//       [--project            <adoProject>]   // required for FIRST binding only
//       [--repository         <adoRepo>]      // required for FIRST binding only
//       [--rootFolder         <parentFolder>] // required for FIRST binding only
//       [--token              <dvToken>]
//
// The helper queries existing bindings via detect-git-binding.js first.
// If a connection already exists (for any solution), the subsequent-binding
// shape is used. Otherwise the first-binding shape is required and missing
// required args produce a clear error.

'use strict';

const { getAuthToken, makeRequest, LONG_RUNNING_GIT_ACTION_TIMEOUT_MS } = require('./validation-helpers');
const { detectGitBinding } = require('./detect-git-binding');

const GIT_PROVIDER_ADO = 0;
const CONNECTION_TYPE_SOLUTION = 0;

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = {
    envUrl: null, token: null,
    solutionUniqueName: null, branch: null, gitFolder: null,
    organization: null, project: null, repository: null, rootFolder: null,
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--envUrl' && args[i + 1]) out.envUrl = args[++i];
    else if (args[i] === '--token' && args[i + 1]) out.token = args[++i];
    else if (args[i] === '--solutionUniqueName' && args[i + 1]) out.solutionUniqueName = args[++i];
    else if (args[i] === '--branch' && args[i + 1]) out.branch = args[++i];
    else if (args[i] === '--gitFolder' && args[i + 1]) out.gitFolder = args[++i];
    else if (args[i] === '--organization' && args[i + 1]) out.organization = args[++i];
    else if (args[i] === '--project' && args[i + 1]) out.project = args[++i];
    else if (args[i] === '--repository' && args[i + 1]) out.repository = args[++i];
    else if (args[i] === '--rootFolder' && args[i + 1]) out.rootFolder = args[++i];
  }
  return out;
}

function requireArg(v, name) {
  if (!v) throw new Error(`--${name} is required`);
}

/**
 * @param {object} options
 * @returns {Promise<object>}
 */
async function connectSolutionToGit({
  envUrl, token,
  solutionUniqueName, branch, gitFolder,
  organization, project, repository, rootFolder,
  // Test hook: skip detection and treat this as a first/subsequent binding.
  // Used by unit tests to avoid stacking two HTTP servers.
  _forceFirstBinding = null,
} = {}) {
  requireArg(envUrl, 'envUrl');
  requireArg(solutionUniqueName, 'solutionUniqueName');
  requireArg(branch, 'branch');
  requireArg(gitFolder, 'gitFolder');

  const tok = token || getAuthToken(envUrl);
  if (!tok) return { error: 'Could not acquire auth token.' };

  // Detect whether ANY binding already exists on this env (without a solution
  // filter). If yes, this is a subsequent binding and org/project/repo/rootFolder
  // are inherited. If no, this is a first binding and those args are required.
  let isFirstBinding;
  let inherited = {};
  if (_forceFirstBinding !== null) {
    isFirstBinding = _forceFirstBinding;
  } else {
    const existing = await detectGitBinding({ envUrl, token: tok });
    if (existing.error && !existing.statusCode) {
      // Real error (e.g. network unreachable) — propagate.
      return { error: 'Pre-check failed: ' + existing.error };
    }
    isFirstBinding = !existing.bound;
    if (existing.bound) {
      inherited = {
        organization: existing.organization,
        project: existing.project,
        repository: existing.repository,
        rootFolder: existing.rootFolder,
      };
    }
  }

  // Decide which body shape to use.
  let body;
  let usedOrganization, usedProject, usedRepository, usedRootFolder;
  if (isFirstBinding) {
    // First solution binding requires the full envelope.
    if (!organization || !project || !repository || !rootFolder) {
      return {
        error: 'First solution binding requires --organization, --project, --repository, --rootFolder. ' +
          'No existing connection was found to inherit from.',
      };
    }
    usedOrganization = organization;
    usedProject = project;
    usedRepository = repository;
    usedRootFolder = rootFolder;
    body = JSON.stringify({
      GitFolder: gitFolder,
      Branch: branch,
      ConnectionType: CONNECTION_TYPE_SOLUTION,
      GitProvider: GIT_PROVIDER_ADO,
      Organization: organization,
      Project: project,
      Repository: repository,
      RootFolder: rootFolder,
      SolutionUniqueName: solutionUniqueName,
    });
  } else {
    // Subsequent solution binding — minimal body.
    usedOrganization = inherited.organization || organization;
    usedProject = inherited.project || project;
    usedRepository = inherited.repository || repository;
    usedRootFolder = inherited.rootFolder || rootFolder;
    body = JSON.stringify({
      GitFolder: gitFolder,
      Branch: branch,
      SolutionUniqueName: solutionUniqueName,
    });
  }

  const apiUrl = `${envUrl.replace(/\/+$/, '')}/api/data/v9.2/ConnectToGit`;
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
    // every solution component to the bound folder — typically 5–15 min
    // server-side. Pass the long-running override so the helper does not
    // mis-classify a slow-but-successful reply as { error: 'Request timed out' }.
    // The post-call isTimeout band-aid below is now a defence-in-depth fallback
    // for tenants that exceed the 15-min ceiling.
    socketTimeoutMs: LONG_RUNNING_GIT_ACTION_TIMEOUT_MS,
  });

  // Defence-in-depth: even with the 15-min socketTimeoutMs above, a very large
  // env can still exceed the ceiling. If we hit a timeout, the binding usually
  // committed server-side anyway — verify by re-querying the solution. See
  // references/inner-loop-empirical-findings.md §4.
  const isTimeout = res.error && /time(d)? ?out/i.test(res.error);
  if (isTimeout) {
    try {
      const verifyRes = await makeRequest({
        url: `${envUrl.replace(/\/+$/, '')}/api/data/v9.2/solutions?$select=uniquename,enabledforsourcecontrolintegration,sourcecontrolsyncstatus&$filter=uniquename eq '${encodeURIComponent(solutionUniqueName)}'`,
        method: 'GET',
        headers: {
          Authorization: `Bearer ${tok}`,
          'OData-MaxVersion': '4.0',
          'OData-Version': '4.0',
          Accept: 'application/json',
        },
      });
      if (verifyRes.statusCode === 200) {
        const row = (JSON.parse(verifyRes.body).value || [])[0];
        if (row && row.enabledforsourcecontrolintegration === true) {
          return {
            bound: true,
            bindingType: 'solution',
            solutionUniqueName,
            organization: usedOrganization,
            project: usedProject,
            repository: usedRepository,
            branch,
            gitFolder,
            rootFolder: usedRootFolder,
            isFirstSolutionBinding: isFirstBinding,
            isAsyncStillSyncing: row.sourcecontrolsyncstatus !== 3,
            sourceControlSyncStatus: row.sourcecontrolsyncstatus,
            calledAt: new Date().toISOString(),
            note: 'HTTP request timed out but the binding committed server-side. Initial sync may still be running; poll solutions.sourcecontrolsyncstatus until it reaches 3.',
          };
        }
      }
    } catch (_) { /* fall through to error */ }
    return { error: res.error + ' (post-timeout verify did not find an enabled-for-source-control solution row)' };
  }

  if (res.error) return { error: res.error };
  if (res.statusCode !== 204 && res.statusCode !== 200) {
    let msg = `HTTP ${res.statusCode}`;
    let code = null;
    try {
      const parsed = JSON.parse(res.body);
      msg = parsed.error?.message || msg;
      code = parsed.error?.code || null;
    } catch {}
    return { error: msg, statusCode: res.statusCode, errorCode: code };
  }

  return {
    bound: true,
    bindingType: 'solution',
    solutionUniqueName,
    organization: usedOrganization,
    project: usedProject,
    repository: usedRepository,
    branch,
    gitFolder,
    rootFolder: usedRootFolder,
    isFirstSolutionBinding: isFirstBinding,
    calledAt: new Date().toISOString(),
  };
}

if (require.main === module) {
  const args = parseArgs(process.argv);
  connectSolutionToGit(args)
    .then((r) => { process.stdout.write(JSON.stringify(r, null, 2) + '\n'); })
    .catch((e) => {
      process.stderr.write('connect-solution-to-git: ' + e.message + '\n');
      process.exit(1);
    });
}

module.exports = { connectSolutionToGit, CONNECTION_TYPE_SOLUTION };
