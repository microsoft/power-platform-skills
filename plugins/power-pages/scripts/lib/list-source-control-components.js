#!/usr/bin/env node

'use strict';

const { getAuthToken, getEnvironmentUrl, makeRequest } = require('./validation-helpers');

const API_VERSION = 'v9.0';

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = { envUrl: null, token: null, solutionId: null, solutionUniqueName: null, action: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--envUrl' && args[i + 1]) out.envUrl = args[++i];
    else if (args[i] === '--token' && args[i + 1]) out.token = args[++i];
    else if (args[i] === '--solutionId' && args[i + 1]) out.solutionId = args[++i];
    else if (args[i] === '--solutionUniqueName' && args[i + 1]) out.solutionUniqueName = args[++i];
    else if (args[i] === '--action' && args[i + 1]) out.action = Number(args[++i]);
  }
  return out;
}

function parseError(res) {
  let msg = `HTTP ${res.statusCode}`;
  try { msg = JSON.parse(res.body).error.message || msg; } catch {}
  return msg;
}

function headers(token) {
  return {
    Authorization: `Bearer ${token}`,
    'OData-MaxVersion': '4.0',
    'OData-Version': '4.0',
    Accept: 'application/json',
  };
}

function escapeODataString(value) {
  return String(value).replace(/'/g, "''");
}

/**
 * Resolves a Dataverse solution unique name to its solutionid.
 * @param {object} options
 * @param {string} options.envUrl
 * @param {string} options.token
 * @param {string} options.solutionUniqueName
 * @returns {Promise<{ solutionId: string } | { error: string, statusCode?: number }>}
 */
async function resolveSolutionId({ envUrl, token, solutionUniqueName } = {}) {
  if (!envUrl) return { error: '--envUrl is required' };
  if (!token) return { error: '--token is required' };
  if (!solutionUniqueName) return { error: '--solutionUniqueName is required' };

  const base = envUrl.replace(/\/+$/, '');
  const filter = `uniquename eq '${escapeODataString(solutionUniqueName)}'`;
  const url = `${base}/api/data/${API_VERSION}/solutions?$filter=${encodeURIComponent(filter)}&$select=solutionid`;
  const res = await makeRequest({ url, method: 'GET', headers: headers(token) });
  if (res.error) return { error: res.error };
  if (res.statusCode !== 200) return { error: parseError(res), statusCode: res.statusCode };

  let rows = [];
  try { rows = JSON.parse(res.body).value || []; } catch (e) {
    return { error: 'Failed to parse response: ' + e.message };
  }
  const solutionId = rows[0] && rows[0].solutionid;
  if (!solutionId) return { error: `Solution not found: ${solutionUniqueName}` };
  return { solutionId };
}

/**
 * Lists Dataverse Git source-control component rows for a solution/action,
 * matching the portal Conflicts/Updates tabs (keyed on action/useraction; rows
 * may be iscommitted=true — NOT filtered out here).
 *
 * @param {object} options
 * @param {string} [options.envUrl]
 * @param {string} [options.token]
 * @param {string} [options.solutionId]
 * @param {string} [options.solutionUniqueName]
 * @param {number} options.action Source-control action option-set value.
 * @returns {Promise<{ count: number, items: object[] } | { error: string, statusCode?: number }>}
 */
async function listSourceControlComponents({ envUrl, token, solutionId, solutionUniqueName, action, userAction } = {}) {
  const url = envUrl || getEnvironmentUrl();
  if (!url) return { error: 'Could not determine environment URL.' };
  const tok = token || getAuthToken(url);
  if (!tok) return { error: 'Could not acquire auth token.' };
  if (action === undefined || action === null || Number.isNaN(Number(action))) return { error: '--action is required' };

  let sid = solutionId;
  if (!sid && solutionUniqueName) {
    const resolved = await resolveSolutionId({ envUrl: url, token: tok, solutionUniqueName });
    if (resolved.error) return resolved;
    sid = resolved.solutionId;
  }
  if (!sid) return { error: '--solutionId or --solutionUniqueName is required' };

  const base = url.replace(/\/+$/, '');
  // NOTE: deliberately NO $select — the partitioned sourcecontrolcomponent table
  // intermittently returns 0 rows when $select is present (verified live
  // 2026-06-19). We fetch full rows and pick fields client-side. `useraction eq 0`
  // (added when userAction=0) = unresolved, matching the portal Conflicts tab.
  //
  // IMPORTANT: do NOT filter on `iscommitted` here. The portal Conflicts/Updates
  // tabs key purely on action (+useraction) — an active conflict or incoming
  // update can have `iscommitted=true`, and adding `iscommitted eq false`
  // SILENTLY UNDER-REPORTS them. Verified live 2026-06-19 (sri-alm-dev-1, RetailOS):
  // the portal showed Conflicts(4)/Updates(2) but `iscommitted eq false` returned
  // 3/1 — it dropped a site-setting conflict and a web-page update that were both
  // iscommitted=true. action(+useraction) alone is the portal-faithful predicate.
  // (Pending Changes — action eq 1 — keep their own `iscommitted eq false` filter in
  // list-pending-changes.js to exclude the committed action=0 baseline; that helper
  // does NOT route through here.)
  let filter = `action eq ${Number(action)}`;
  if (userAction !== undefined && userAction !== null && !Number.isNaN(Number(userAction))) {
    filter += ` and useraction eq ${Number(userAction)}`;
  }
  const apiUrl = `${base}/api/data/${API_VERSION}/sourcecontrolcomponents?$filter=${encodeURIComponent(filter)}&partitionId=${encodeURIComponent(sid)}`;
  const res = await makeRequest({ url: apiUrl, method: 'GET', headers: headers(tok) });
  if (res.error) return { error: res.error };
  if (res.statusCode !== 200) return { error: parseError(res), statusCode: res.statusCode };

  let rows = [];
  try { rows = JSON.parse(res.body).value || []; } catch (e) {
    return { error: 'Failed to parse response: ' + e.message };
  }

  const items = rows.map((r) => ({
    sourceControlComponentId: r.sourcecontrolcomponentid || null,
    componentId: r.componentid || null,
    componentName: r.componentdisplayname || r.componentname || null,
    componentPath: r.componentpath || null,
    componentType: r.componenttype || null,
    partitionId: r.partitionid || null,
    payloadId: r._sourcecontrolcomponentpayloadid_value || null,
    // Three-way SHA-1 hashes — let callers classify which side changed without a fetch.
    gitHashId: r.githashid || null,
    lastSyncHashId: r.lastsynchashid || null,
    envHashId: r.envhashid || null,
    action: r.action,
    useraction: r.useraction,
  }));

  return { count: items.length, items };
}

if (require.main === module) {
  const args = parseArgs(process.argv);
  listSourceControlComponents(args)
    .then((r) => { process.stdout.write(JSON.stringify(r, null, 2) + '\n'); })
    .catch((e) => {
      process.stderr.write('list-source-control-components: ' + e.message + '\n');
      process.exit(1);
    });
}

module.exports = { listSourceControlComponents, resolveSolutionId };
