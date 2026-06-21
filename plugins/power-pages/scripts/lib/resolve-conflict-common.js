'use strict';

const { makeRequest, getAuthToken } = require('./validation-helpers');
const { resolveGitConflictUserAction } = require('./resolve-git-conflict-useraction');

/**
 * Escape a string literal for use in a Dataverse OData $filter expression.
 * @param {string} value
 * @returns {string}
 */
function escapeODataString(value) {
  return String(value).replace(/'/g, "''");
}

/**
 * Resolve a Dataverse solution unique name to its solutionid.
 * @param {object} options
 * @param {string} options.base
 * @param {string} [options.token]  When omitted, a token is acquired from `base`
 *   (consistent with the other inner-loop helpers, which all self-acquire when the
 *   caller passes null — apply-merged-component relies on this, otherwise the
 *   useraction accept path is silently skipped and falls back to the Maker Portal).
 * @param {string} options.solutionUniqueName
 * @param {Function} [options.makeRequestFn]
 * @returns {Promise<string|null>}
 */
async function resolveSolutionIdByUniqueName({
  base, token, solutionUniqueName, makeRequestFn = makeRequest,
} = {}) {
  if (!base || !solutionUniqueName) return null;
  const tok = token || getAuthToken(base);
  if (!tok) return null;
  const filter = `uniquename eq '${escapeODataString(solutionUniqueName)}'`;
  const url = `${base}/api/data/v9.2/solutions?$filter=${encodeURIComponent(filter)}&$select=solutionid`;
  const res = await makeRequestFn({
    url,
    method: 'GET',
    headers: {
      Authorization: `Bearer ${tok}`,
      'OData-MaxVersion': '4.0',
      'OData-Version': '4.0',
      Accept: 'application/json',
    },
  });
  if (res.error || res.statusCode !== 200) return null;
  try {
    return JSON.parse(res.body).value?.[0]?.solutionid || null;
  } catch {
    return null;
  }
}

/**
 * Try to resolve a conflict through the sourcecontrolcomponent useraction PATCH path.
 * Returns null when required identifiers are unavailable or the useraction helper
 * cannot resolve the conflict, allowing callers to preserve the legacy action fallback.
 * @param {object} options
 * @returns {Promise<object|null>}
 */
async function tryResolveViaUserAction({
  envUrl,
  token,
  conflictId,
  solutionId,
  solutionUniqueName,
  componentId,
  decision,
  outcome,
  action,
  resolveUserActionFn = resolveGitConflictUserAction,
  makeRequestFn = makeRequest,
} = {}) {
  if (!componentId) return null;
  const base = envUrl.replace(/\/+$/, '');
  const resolvedSolutionId = solutionId || await resolveSolutionIdByUniqueName({
    base,
    token,
    solutionUniqueName,
    makeRequestFn,
  });
  if (!resolvedSolutionId) return null;

  let result;
  try {
    result = await resolveUserActionFn({
      envUrl,
      token,
      solutionId: resolvedSolutionId,
      componentId,
      decision,
    });
  } catch {
    return null;
  }
  if (!result || !result.ok || !result.resolved) return null;
  return {
    resolved: true,
    conflictId,
    outcome,
    action,
    via: 'useraction',
    calledAt: new Date().toISOString(),
    sourceControlComponentId: result.sourceControlComponentId,
    useraction: result.useraction,
    statusCode: result.statusCode,
  };
}

/**
 * Call the legacy ResolveGitConflict-style OData action.
 * @param {object} options
 * @returns {Promise<object>}
 */
async function resolveViaAction({
  envUrl,
  token,
  conflictId,
  solutionUniqueName,
  action,
  resolution,
  outcome,
  makeRequestFn = makeRequest,
} = {}) {
  const base = envUrl.replace(/\/+$/, '');
  const apiUrl = `${base}/api/data/v9.2/${action}`;
  const bodyObj = { ConflictId: conflictId, Resolution: resolution };
  if (solutionUniqueName) bodyObj.SolutionUniqueName = solutionUniqueName;

  const res = await makeRequestFn({
    url: apiUrl,
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'OData-MaxVersion': '4.0',
      'OData-Version': '4.0',
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(bodyObj),
  });

  if (res.error) return { error: res.error, via: 'resolvegitconflict' };
  if (res.statusCode !== 204 && res.statusCode !== 200) {
    let msg = `HTTP ${res.statusCode}`;
    let code = null;
    try {
      const parsed = JSON.parse(res.body);
      msg = parsed.error?.message || msg;
      code = parsed.error?.code || null;
    } catch {}
    return { error: msg, statusCode: res.statusCode, errorCode: code, via: 'resolvegitconflict' };
  }

  return {
    resolved: true,
    conflictId,
    outcome,
    action,
    via: 'resolvegitconflict',
    calledAt: new Date().toISOString(),
  };
}

module.exports = {
  escapeODataString,
  resolveSolutionIdByUniqueName,
  tryResolveViaUserAction,
  resolveViaAction,
};
