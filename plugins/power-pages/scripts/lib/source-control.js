'use strict';

// Shared OData helpers for Power Pages source-control entities.
//
// Two entities are involved per the live schema:
//   - sourcecontrolconfigurations      (env-level: org/project/repo/provider)
//   - sourcecontrolbranchconfigurations (per-solution: branch/folder/syncedCommit,
//                                        keyed by partitionid = solutionId,
//                                        and _sourcecontrolconfigurationid_value FK)
//
// repositoryUrl is not stored — it's derived from org/project/repo/provider.

const { makeRequest } = require('./validation-helpers');

const ACTION = Object.freeze({
  COMMIT: 1,    // pending commit
  PULL: 2,      // available from upstream
  CONFLICT: 3,
});

function buildRepositoryUrl({ organizationName, projectName, repositoryName, gitProvider }) {
  if (gitProvider === 1) {
    return `https://github.com/${organizationName}/${repositoryName}`;
  }
  return `https://dev.azure.com/${organizationName}/${projectName}/_git/${repositoryName}`;
}

async function odataGet(envUrl, token, path) {
  return makeRequest({
    url: `${envUrl}/api/data/v9.2/${path}`,
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'OData-Version': '4.0',
    },
    timeout: 30000,
  });
}

function parseOdataValue(res) {
  if (res.error) throw new Error(res.error);
  if (res.statusCode === 401) throw new Error('Authentication failed (401). Run az login again.');
  if (res.statusCode !== 200) throw new Error(`Unexpected status ${res.statusCode} (${res.body || ''})`);
  let data;
  try { data = JSON.parse(res.body); }
  catch { throw new Error('Failed to parse OData response'); }
  return data.value || [];
}

const EMPTY_GUID = '00000000-0000-0000-0000-000000000000';

async function listGitConnections({ envUrl, token, solutionUniqueName, solutionId, includeEnvLevel = false }) {
  // The skill schema-aware filter goes on partitionid (= solutionId).
  // The env exposes a `partitionid = EMPTY_GUID` row that represents the
  // environment-level git binding (not tied to a specific solution); callers
  // usually want only the per-solution rows. Pass includeEnvLevel:true to keep it.
  // If only a unique name is provided, resolve it first.
  let resolvedSolutionId = solutionId || null;
  if (!resolvedSolutionId && solutionUniqueName) {
    const solRes = await odataGet(
      envUrl, token,
      `solutions?$filter=uniquename eq '${encodeURIComponent(solutionUniqueName)}'&$select=solutionid,uniquename`,
    );
    const sols = parseOdataValue(solRes);
    if (sols.length === 0) return [];
    resolvedSolutionId = sols[0].solutionid;
  }

  const branchPath = resolvedSolutionId
    ? `sourcecontrolbranchconfigurations?$filter=partitionid eq '${resolvedSolutionId}'`
    : 'sourcecontrolbranchconfigurations';
  const branchRes = await odataGet(envUrl, token, branchPath);
  const branches = parseOdataValue(branchRes);
  if (branches.length === 0) return [];

  const configCache = new Map();
  const solutionCache = new Map();
  const connections = [];

  for (const b of branches) {
    const scid = b._sourcecontrolconfigurationid_value;
    const partitionId = b.partitionid;

    if (scid && !configCache.has(scid)) {
      const r = await odataGet(envUrl, token, `sourcecontrolconfigurations(${scid})`);
      if (r.statusCode === 200 && r.body) {
        try { configCache.set(scid, JSON.parse(r.body)); }
        catch { configCache.set(scid, null); }
      } else { configCache.set(scid, null); }
    }

    if (partitionId && !solutionCache.has(partitionId)) {
      const r = await odataGet(envUrl, token, `solutions(${partitionId})?$select=uniquename,version,ismanaged,modifiedon`);
      if (r.statusCode === 200 && r.body) {
        try { solutionCache.set(partitionId, JSON.parse(r.body)); }
        catch { solutionCache.set(partitionId, null); }
      } else { solutionCache.set(partitionId, null); }
    }

    const cfg = configCache.get(scid) || {};
    const sol = solutionCache.get(partitionId) || {};

    const organizationName = cfg.organizationname || null;
    const projectName = cfg.projectname || null;
    const repositoryName = cfg.repositoryname || null;
    const gitProvider = (typeof cfg.gitprovider === 'number') ? cfg.gitprovider : null;

    connections.push({
      solutionId: partitionId || null,
      solutionUniqueName: sol.uniquename || null,
      solutionVersion: sol.version || null,
      isManaged: typeof sol.ismanaged === 'boolean' ? sol.ismanaged : null,
      lastSolutionModifiedOn: sol.modifiedon || null,
      branchName: b.branchname || null,
      upstreamBranchName: b.upstreambranchname || null,
      rootFolderPath: b.rootfolderpath || null,
      branchSyncedCommitId: b.branchsyncedcommitid || null,
      organizationName,
      projectName,
      repositoryName,
      gitProvider,
      repositoryUrl: (organizationName && repositoryName)
        ? buildRepositoryUrl({ organizationName, projectName, repositoryName, gitProvider })
        : null,
      sourceControlConfigurationId: scid || null,
      sourceControlBranchConfigurationId: b.sourcecontrolbranchconfigurationid || null,
    });
  }

  let filtered = connections;
  if (!includeEnvLevel) {
    filtered = filtered.filter(c => c.solutionId && c.solutionId !== EMPTY_GUID);
  }
  if (solutionUniqueName && !solutionId) {
    filtered = filtered.filter(c => c.solutionUniqueName === solutionUniqueName);
  }
  return filtered;
}

async function listSourceControlComponents({ envUrl, token, action }) {
  const res = await odataGet(envUrl, token, `sourcecontrolcomponents?$filter=action eq ${action}`);
  const rows = parseOdataValue(res);
  const label = action === ACTION.COMMIT ? 'Commit'
    : action === ACTION.PULL ? 'Pull'
    : action === ACTION.CONFLICT ? 'Conflict'
    : `action${action}`;
  return rows.map(c => ({
    name: c.name || 'Unknown',
    type: c.componenttype || 'Unknown',
    action: label,
  }));
}

async function countSourceControlComponents({ envUrl, token, action }) {
  const res = await odataGet(envUrl, token, `sourcecontrolcomponents?$filter=action eq ${action}&$count=true`);
  if (res.error) throw new Error(res.error);
  if (res.statusCode === 401) throw new Error('Authentication failed (401). Run az login again.');
  if (res.statusCode !== 200) throw new Error(`Unexpected status ${res.statusCode}`);
  try {
    const data = JSON.parse(res.body);
    return data['@odata.count'] ?? (data.value || []).length;
  } catch { throw new Error('Failed to parse OData count response'); }
}

module.exports = {
  ACTION,
  listGitConnections,
  listSourceControlComponents,
  countSourceControlComponents,
  buildRepositoryUrl,
};
