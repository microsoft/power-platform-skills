#!/usr/bin/env node

// Lists conflicts between local Changes and incoming Updates — the equivalent
// of the "Conflicts" tab in the maker portal's Git integration UI.
//
// Important: `RefreshChangesFromGit` MUST be called before this helper so
// Dataverse has populated the conflicts entity. Conflicts arise when both the
// env and the ADO branch have modifications to the same component.
//
// The resolve-conflicts skill uses this helper to enumerate each conflict and
// present a per-object "keep existing" / "accept incoming" card to the user.
//
// Output (JSON to stdout):
//   {
//     count: <number>,
//     items: [
//       {
//         conflictId:          "<guid>",
//         componentName:       "<display name>",
//         componentType:       "<e.g. 'mspp_webtemplate'>",
//         localChangeType:     "Add" | "Modify" | "Delete",
//         incomingChangeType:  "Add" | "Modify" | "Delete",
//         localCommitSha:      "<git sha>" | null,
//         incomingCommitSha:   "<git sha>" | null,
//         resolutionRequired:  true,
//       },
//       ...
//     ]
//   }
//   On error: { error: "<message>", statusCode?: <number> }
//
// Usage:
//   node list-conflicts.js [--envUrl <url>] [--token <token>]
//                          [--solutionUniqueName <name>]
//
// TODO: HAR-verify — entity name for Conflicts tab. Candidates:
// `gitconflicts`, `gitconflictfiles`, `msdyn_gitconflicts`.
// Also verify: can both localCommitSha and incomingCommitSha be non-null, or
// does only one side always have a SHA (e.g., local changes haven't been
// committed yet)?

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

const CHANGE_TYPE_LABEL = Object.freeze({ 0: 'Add', 1: 'Modify', 2: 'Delete' });

/**
 * @param {object} options
 * @param {string} [options.envUrl]
 * @param {string} [options.token]
 * @param {string} [options.solutionUniqueName]
 * @returns {Promise<{ count: number, items: object[] } | { error: string }>}
 */
async function listConflicts({ envUrl, token, solutionUniqueName } = {}) {
  const url = envUrl || getEnvironmentUrl();
  if (!url) return { error: 'Could not determine environment URL.' };
  const tok = token || getAuthToken(url);
  if (!tok) return { error: 'Could not acquire auth token.' };
  const base = url.replace(/\/+$/, '');

  // TODO: HAR-verify entity name for the Conflicts tab.
  let filterExpr = '';
  if (solutionUniqueName) {
    filterExpr = `&$filter=solutionuniquename eq '${solutionUniqueName}'`;
  }
  const apiUrl =
    `${base}/api/data/v9.2/gitconflictfiles` +
    `?$select=gitconflictfileid,componentname,componenttype,` +
    `localchangetype,incomingchangetype,localcommitsha,incomingcommitsha,solutionuniquename` +
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
  if (res.statusCode === 404) return { count: 0, items: [], hint: 'gitconflictfiles 404 — entity may differ; run RefreshChangesFromGit first.' };
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
    conflictId:         r.gitconflictfileid || null,
    componentName:      r.componentname || null,
    componentType:      r.componenttype || null,
    localChangeType:    CHANGE_TYPE_LABEL[r.localchangetype] || String(r.localchangetype),
    incomingChangeType: CHANGE_TYPE_LABEL[r.incomingchangetype] || String(r.incomingchangetype),
    localCommitSha:     r.localcommitsha || null,
    incomingCommitSha:  r.incomingcommitsha || null,
    resolutionRequired: true,
  }));

  return { count: items.length, items };
}

if (require.main === module) {
  const args = parseArgs(process.argv);
  listConflicts(args)
    .then((r) => { process.stdout.write(JSON.stringify(r, null, 2) + '\n'); })
    .catch((e) => {
      process.stderr.write('list-conflicts: ' + e.message + '\n');
      process.exit(1);
    });
}

module.exports = { listConflicts, CHANGE_TYPE_LABEL };
