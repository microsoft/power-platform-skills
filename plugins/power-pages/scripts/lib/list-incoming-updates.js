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
//                                 [--solutionUniqueName <name>]
//
// TODO: HAR-verify — entity name for the Updates tab. Candidates:
// `gitupdatefiles`, `gitincomingupdates`, `msdyn_gitupdates`. Using
// `gitupdatefiles` as a working assumption. Also verify that the entity is
// populated by `RefreshChangesFromGit` and clears after `PullChangesFromGit`.

'use strict';

const { getAuthToken, getEnvironmentUrl, makeRequest } = require('./validation-helpers');

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = { envUrl: null, token: null, solutionUniqueName: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--envUrl' && args[i + 1]) out.envUrl = args[++i];
    else if (args[i] === '--token' && args[i + 1]) out.token = args[++i];
    else if (args[i] === '--solutionUniqueName' && args[i + 1]) out.solutionUniqueName = args[++i];
  }
  return out;
}

// TODO: HAR-verify — integer-to-label mapping for updatetype.
const UPDATE_TYPE_LABEL = Object.freeze({
  0: 'Add',
  1: 'Modify',
  2: 'Delete',
});

/**
 * @param {object} options
 * @param {string} [options.envUrl]
 * @param {string} [options.token]
 * @param {string} [options.solutionUniqueName]
 * @returns {Promise<{ count: number, items: object[] } | { error: string }>}
 */
async function listIncomingUpdates({ envUrl, token, solutionUniqueName } = {}) {
  const url = envUrl || getEnvironmentUrl();
  if (!url) return { error: 'Could not determine environment URL.' };
  const tok = token || getAuthToken(url);
  if (!tok) return { error: 'Could not acquire auth token.' };
  const base = url.replace(/\/+$/, '');

  // TODO: HAR-verify entity name.
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
  if (res.statusCode === 404) return { count: 0, items: [], hint: 'gitupdatefiles 404 — entity name may differ; run RefreshChangesFromGit first.' };
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

  return { count: items.length, items };
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
