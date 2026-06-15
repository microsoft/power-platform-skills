#!/usr/bin/env node

// Discovers the ADO repositories an environment has been bound to — past and
// present — so git-configure can offer "re-use these coordinates" instead of
// making the user re-type org / project / repo / branch / folder from scratch.
//
// Dataverse keeps the binding coordinates in two entities (see
// references/inner-loop-empirical-findings.md §8, §26 and the v2 POC findings):
//
//   sourcecontrolconfigurations        — the ADO repo coordinates (1 row per repo
//                                         the env has ever been wired to). Survives
//                                         even after a binding is torn down.
//     organizationname, projectname, repositoryname, gitprovider (int),
//     sourcecontrolconfigurationid, createdon
//
//   sourcecontrolbranchconfigurations  — the live bindings (branch + root folder +
//                                         which solution). One row per active bind.
//     branchname, rootfolderpath, partitionid, _sourcecontrolconfigurationid_value,
//     branchsyncedcommitid
//
// CRITICAL binding-type rule (verified live, v2 POC-2):
//   The ENVIRONMENT binding row carries partitionid = the ZERO GUID
//   "00000000-0000-0000-0000-000000000000" (NOT null/empty). A SOLUTION binding
//   row carries partitionid = the bound solution's solutionid. A naive
//   `partitionid == null` check would mis-classify every env binding — so we
//   treat (null OR zero-GUID) as environment, anything else as solution.
//
// Output (JSON to stdout):
//   {
//     ok: true,
//     envUrl: "https://...",
//     knownRepos: [
//       {
//         organizationname, projectname, repositoryname,
//         gitprovider: 0, gitProviderName: "AzureDevOps",
//         sourcecontrolconfigurationid, createdon,
//         branchConfigs: [
//           { branchname, rootfolderpath, bindingType: "environment"|"solution",
//             solutionId: <guid|null>, solutionUniqueName: <name|null>,
//             branchsyncedcommitid, isCurrentlyBound: true }
//         ]
//       }
//     ],
//     summary: { repoCount, activeBindingCount, tornDownRepoCount }
//   }
//   On error: { ok: false, error: "<message>", statusCode?: <number> }
//
// Usage:
//   node discover-bindings.js --envUrl <url> [--token <dvToken>]

'use strict';

const { getAuthToken, getEnvironmentUrl, makeRequest } = require('./validation-helpers');

const ZERO_GUID = '00000000-0000-0000-0000-000000000000';

// gitprovider is an integer enum. 0 = Azure DevOps (the only provider supported
// today). Surface the raw value AND a label so callers don't hard-code 0 — a
// future GitHub provider would carry a different int.
const GIT_PROVIDER_NAMES = Object.freeze({ 0: 'AzureDevOps' });

function gitProviderName(value) {
  return GIT_PROVIDER_NAMES[value] || `Unknown(${value})`;
}

/**
 * Classify a branch-config row's binding type from its partitionid.
 * (null || ZERO_GUID) → environment; any real GUID → solution.
 * @param {string|null} partitionid
 * @returns {'environment'|'solution'}
 */
function classifyBinding(partitionid) {
  if (!partitionid || partitionid === ZERO_GUID) return 'environment';
  return 'solution';
}

async function odataGet(base, tok, pathAndQuery) {
  const res = await makeRequest({
    url: `${base}${pathAndQuery}`,
    method: 'GET',
    headers: {
      Authorization: `Bearer ${tok}`,
      'OData-MaxVersion': '4.0',
      'OData-Version': '4.0',
      Accept: 'application/json',
    },
  });
  if (res.error) return { error: res.error };
  if (res.statusCode === 404) return { notFound: true, value: [] };
  if (res.statusCode !== 200) {
    let msg = `HTTP ${res.statusCode}`;
    try { msg = JSON.parse(res.body).error.message || msg; } catch {}
    return { error: msg, statusCode: res.statusCode };
  }
  try { return { value: JSON.parse(res.body).value || [] }; }
  catch (e) { return { error: 'Failed to parse response: ' + e.message }; }
}

/**
 * Resolve solutionId → uniquename for a set of solution ids (batched).
 * @returns {Promise<Map<string,string>>}
 */
async function resolveSolutionNames(base, tok, solutionIds) {
  const map = new Map();
  const ids = [...new Set(solutionIds.filter(Boolean))];
  if (ids.length === 0) return map;
  const filter = ids.map((id) => `solutionid eq ${id}`).join(' or ');
  const r = await odataGet(
    base, tok,
    `/api/data/v9.2/solutions?$filter=${encodeURIComponent(filter)}&$select=solutionid,uniquename`,
  );
  if (r.value) {
    for (const row of r.value) map.set(row.solutionid, row.uniquename);
  }
  return map;
}

/**
 * @param {object} options
 * @returns {Promise<object>}
 */
async function discoverBindings({ envUrl, token } = {}) {
  const url = envUrl || getEnvironmentUrl();
  if (!url) return { ok: false, error: 'Could not determine environment URL.' };
  const tok = token || getAuthToken(url);
  if (!tok) return { ok: false, error: 'Could not acquire auth token.' };
  const base = url.replace(/\/+$/, '');

  // 1) ADO repo coordinates (survives binding teardown).
  const configsRes = await odataGet(
    base, tok,
    '/api/data/v9.2/sourcecontrolconfigurations' +
    '?$select=sourcecontrolconfigurationid,organizationname,projectname,repositoryname,gitprovider,createdon',
  );
  if (configsRes.error) return { ok: false, error: configsRes.error, statusCode: configsRes.statusCode };
  if (configsRes.notFound) {
    // Entity missing → Git integration never provisioned on this env.
    return { ok: true, envUrl: base, knownRepos: [], summary: { repoCount: 0, activeBindingCount: 0, tornDownRepoCount: 0 } };
  }

  // 2) Live branch bindings.
  const branchesRes = await odataGet(
    base, tok,
    '/api/data/v9.2/sourcecontrolbranchconfigurations' +
    '?$select=sourcecontrolbranchconfigurationid,branchname,rootfolderpath,partitionid,_sourcecontrolconfigurationid_value,branchsyncedcommitid',
  );
  if (branchesRes.error) return { ok: false, error: branchesRes.error, statusCode: branchesRes.statusCode };

  const branchRows = branchesRes.value || [];

  // Resolve solution names for solution-binding rows in one batched call.
  const solutionIds = branchRows
    .map((b) => b.partitionid)
    .filter((pid) => classifyBinding(pid) === 'solution');
  const solutionNames = await resolveSolutionNames(base, tok, solutionIds);

  // Group branch rows by their parent configuration id.
  const branchesByConfig = new Map();
  for (const b of branchRows) {
    const cfgId = b._sourcecontrolconfigurationid_value;
    if (!branchesByConfig.has(cfgId)) branchesByConfig.set(cfgId, []);
    const bindingType = classifyBinding(b.partitionid);
    const solutionId = bindingType === 'solution' ? b.partitionid : null;
    branchesByConfig.get(cfgId).push({
      branchname:           b.branchname || null,
      rootfolderpath:       b.rootfolderpath || null,
      bindingType,
      solutionId,
      solutionUniqueName:   solutionId ? (solutionNames.get(solutionId) || null) : null,
      branchsyncedcommitid: b.branchsyncedcommitid || null,
      isCurrentlyBound:     true,
    });
  }

  let activeBindingCount = 0;
  let tornDownRepoCount = 0;
  const knownRepos = (configsRes.value || []).map((c) => {
    const branchConfigs = branchesByConfig.get(c.sourcecontrolconfigurationid) || [];
    activeBindingCount += branchConfigs.length;
    if (branchConfigs.length === 0) tornDownRepoCount += 1;
    return {
      organizationname:             c.organizationname || null,
      projectname:                  c.projectname || null,
      repositoryname:               c.repositoryname || null,
      gitprovider:                  c.gitprovider,
      gitProviderName:              gitProviderName(c.gitprovider),
      sourcecontrolconfigurationid: c.sourcecontrolconfigurationid,
      createdon:                    c.createdon || null,
      branchConfigs,
    };
  });

  return {
    ok: true,
    envUrl: base,
    knownRepos,
    summary: {
      repoCount: knownRepos.length,
      activeBindingCount,
      tornDownRepoCount,
    },
  };
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = { envUrl: null, token: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--envUrl' && args[i + 1]) out.envUrl = args[++i];
    else if (args[i] === '--token' && args[i + 1]) out.token = args[++i];
  }
  return out;
}

if (require.main === module) {
  const args = parseArgs(process.argv);
  discoverBindings(args)
    .then((r) => { process.stdout.write(JSON.stringify(r, null, 2) + '\n'); })
    .catch((e) => {
      process.stderr.write('discover-bindings: ' + e.message + '\n');
      process.exit(1);
    });
}

module.exports = { discoverBindings, classifyBinding, gitProviderName, ZERO_GUID };
