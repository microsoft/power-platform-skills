#!/usr/bin/env node

// Lists incoming updates from the bound ADO branch — the equivalent of the
// "Updates" tab in the maker portal's Git integration UI.
//
// Important: `RefreshChangesFromGit` MUST be called before this helper so
// Dataverse has queried ADO and populated the incoming-updates entity.
// Callers (sync-from-git, plan-inner-loop) are responsible for running
// refresh-changes-from-git.js first.
//
// Output (JSON to stdout):
//   {
//     count: <number>,
//     items: [
//       {
//         componentId:   "<guid>",
//         componentName: "<display name>",
//         componentType: "<e.g. 'mspp_webpage'>",
//         updateType:    "Add" | "Modify" | "Delete",
//         commitSha:     "<git sha>" | null,
//         commitMessage: "<string>" | null,
//       },
//       ...
//     ]
//   }
//   On error: { error: "<message>", statusCode?: <number> }
//
// Usage:
//   node list-incoming-updates.js [--envUrl <url>] [--token <token>]
//                                 [--solutionUniqueName <name> | --solutionId <guid>]
//
// SOURCE (Bug 10): the PRIMARY, reliable path is `sourcecontrolcomponents` (the same
// entity the portal Updates tab uses), partitioned by solutionId — it does NOT depend
// on the unverified `gitupdatefiles` entity, which 404s on real tenants (it was only a
// `// TODO: HAR-verify` working assumption). The Updates set = pure incoming
// (`action eq 2`) PLUS maker-accepted-incoming-not-yet-pulled (`action eq 3 AND
// useraction eq 2`). `gitupdatefiles` remains only as a last-ditch fallback for the
// no-solution case (still 404s on most tenants).

'use strict';

const { getAuthToken, getEnvironmentUrl, makeRequest } = require('./validation-helpers');
const { listSourceControlComponents } = require('./list-source-control-components');

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = { envUrl: null, token: null, solutionUniqueName: null, solutionId: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--envUrl' && args[i + 1]) out.envUrl = args[++i];
    else if (args[i] === '--token' && args[i + 1]) out.token = args[++i];
    else if (args[i] === '--solutionUniqueName' && args[i + 1]) out.solutionUniqueName = args[++i];
    else if (args[i] === '--solutionId' && args[i + 1]) out.solutionId = args[++i];
  }
  return out;
}

// TODO: HAR-verify — integer-to-label mapping for updatetype.
const UPDATE_TYPE_LABEL = Object.freeze({
  0: 'Add',
  1: 'Modify',
  2: 'Delete',
});

// Merge + de-dupe pure-incoming (action 2) and accepted-incoming-pending-pull
// (action 3 + useraction 2) source-control rows into the Updates output shape.
function sccRowsToItems(pure, acceptedPendingPull) {
  const seen = new Set();
  const items = [];
  for (const r of [...(pure.items || []), ...(acceptedPendingPull.items || [])]) {
    const key = r.sourceControlComponentId || r.componentId;
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    items.push({
      componentId:   r.componentId || null,
      updateId:      r.sourceControlComponentId || null,
      componentName: r.componentName || null,
      componentPath: r.componentPath || null,
      componentType: r.componentType || null,
      updateType:    r.action === 3 ? 'AcceptedPendingPull' : null,
      commitSha:     null,
      commitMessage: null,
    });
  }
  return items;
}

/**
 * @param {object} options
 * @param {string} [options.envUrl]
 * @param {string} [options.token]
 * @param {string} [options.solutionUniqueName]
 * @param {string} [options.solutionId]
 * @returns {Promise<{ count: number, items: object[] } | { error: string }>}
 */
async function listIncomingUpdates({ envUrl, token, solutionUniqueName, solutionId } = {}) {
  const url = envUrl || getEnvironmentUrl();
  if (!url) return { error: 'Could not determine environment URL.' };
  const tok = token || getAuthToken(url);
  if (!tok) return { error: 'Could not acquire auth token.' };
  const base = url.replace(/\/+$/, '');

  // PRIMARY (Bug 10): the portal "Updates" tab = rows that need to be PULLED into the
  // env — BOTH pure incoming updates (action eq 2) AND conflicts the maker resolved as
  // "accept incoming" that have not been pulled yet (action eq 3 AND useraction eq 2),
  // keyed on partitionId = solutionId. This is the reliable path and does NOT touch
  // the unverified `gitupdatefiles` entity (which 404s on real tenants). Querying only
  // action eq 2 SILENTLY UNDER-REPORTS the accepted-incoming rows (verified live
  // 2026-06-19, sri-alm-dev-1).
  if (solutionId || solutionUniqueName) {
    const [pure, acceptedPendingPull] = await Promise.all([
      listSourceControlComponents({ envUrl: url, token: tok, solutionId, solutionUniqueName, action: 2 }),
      listSourceControlComponents({ envUrl: url, token: tok, solutionId, solutionUniqueName, action: 3, userAction: 2 }),
    ]);
    if (!pure.error && !acceptedPendingPull.error) {
      const items = sccRowsToItems(pure, acceptedPendingPull);
      return { count: items.length, items, via: 'sourcecontrolcomponent' };
    }
    // On a hard error (not a clean empty), fall through to the legacy entity below.
  }

  // FALLBACK / no-solution: the legacy `gitupdatefiles` entity (404s on most tenants;
  // unverified). Only reached when no solution is known, or the primary path errored.
  let filterExpr = '';
  if (solutionUniqueName) {
    filterExpr = `&$filter=solutionuniquename eq '${solutionUniqueName}'`;
  }
  const apiUrl =
    `${base}/api/data/v9.2/gitupdatefiles` +
    `?$select=gitupdatefileid,componentname,componenttype,updatetype,commitsha,commitmessage,solutionuniquename` +
    filterExpr +
    `&$orderby=componenttype asc,componentname asc`;

  const res = await makeRequest({
    url: apiUrl,
    method: 'GET',
    headers: {
      Authorization: `Bearer ${tok}`,
      'OData-MaxVersion': '4.0',
      'OData-Version': '4.0',
      Accept: 'application/json',
    },
  });

  if (res.error) return { error: res.error };
  if (res.statusCode === 404) {
    const hint = 'gitupdatefiles 404 — entity not present on this tenant; pass a solution so the sourcecontrolcomponent path can be used.';
    return { count: 0, items: [], hint };
  }
  if (res.statusCode !== 200) {
    let msg = `HTTP ${res.statusCode}`;
    try { msg = JSON.parse(res.body).error.message || msg; } catch {}
    return { error: msg, statusCode: res.statusCode };
  }

  let rows;
  try { rows = JSON.parse(res.body).value; } catch (e) {
    return { error: 'Failed to parse response: ' + e.message };
  }

  const items = (rows || []).map((r) => ({
    componentId:   r.gitupdatefileid || null,
    componentName: r.componentname || null,
    componentType: r.componenttype || null,
    updateType:    UPDATE_TYPE_LABEL[r.updatetype] || String(r.updatetype),
    commitSha:     r.commitsha || null,
    commitMessage: r.commitmessage || null,
  }));

  return { count: items.length, items, via: 'gitupdatefiles' };
}

if (require.main === module) {
  const args = parseArgs(process.argv);
  listIncomingUpdates(args)
    .then((r) => { process.stdout.write(JSON.stringify(r, null, 2) + '\n'); })
    .catch((e) => {
      process.stderr.write('list-incoming-updates: ' + e.message + '\n');
      process.exit(1);
    });
}

module.exports = { listIncomingUpdates, UPDATE_TYPE_LABEL };
