#!/usr/bin/env node

// Lists conflicts between local Changes and incoming Updates — the equivalent
// of the "Conflicts" tab in the maker portal's Git integration UI.
//
// CANONICAL SOURCE (verified live 2026-06-19): the portal Conflicts tab queries
// `sourcecontrolcomponents?$filter=(action eq 3 and useraction eq 0)` (action 3 =
// Conflict, useraction 0 = not yet resolved), partitioned by solutionId. We use
// that as the PRIMARY source whenever a solution is known; `gitconflictfiles` (a
// legacy entity that 404s on most tenants) is only a fallback for the no-solution
// case. Each conflict row carries componentpath + the three SHA hashes
// (git/lastsync/env) so callers can build the ADO path and classify sides.
//
// `RefreshChangesFromGit` MUST be called before this helper so Dataverse has
// populated the conflict rows.
//
// Output (JSON to stdout):
//   {
//     count: <number>,
//     via: "sourcecontrolcomponent" | "gitconflictfiles",
//     items: [
//       {
//         conflictId, componentId, componentName, componentPath, componentType,
//         partitionId, gitHashId, lastSyncHashId, envHashId,
//         localChangeType, incomingChangeType, resolutionRequired: true,
//       }, ...
//     ]
//   }
//   On error: { error: "<message>", statusCode?: <number> }
//
// Usage:
//   node list-conflicts.js [--envUrl <url>] [--token <token>]
//                          [--solutionUniqueName <name> | --solutionId <guid>]

'use strict';

const { getAuthToken, getEnvironmentUrl, makeRequest } = require('./validation-helpers');
const { listSourceControlComponents } = require('./list-source-control-components');
const {
  normalizeComponentType, typeFromComponentName, mergeStrategyForType,
  isEligibleForSelectiveMerge, labelForType,
} = require('./component-type-map');

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

const CHANGE_TYPE_LABEL = Object.freeze({ 0: 'Add', 1: 'Modify', 2: 'Delete' });

// A4: enrich a raw row with the RESOLVED numeric ppc type + merge classification so
// callers never infer eligibility from name suffixes. The sourcecontrolcomponent
// `componentType` is the solution sub-type (e.g. 10429), NOT the ppc type — so we
// derive the real type from the serialized componentName (".webtemplate", etc.),
// falling back to the componentPath type-folder. Adds: ppcType (numeric|null),
// ppcTypeLabel, mergeStrategy ('text'|'scalar'|'binary'|'unsupported'),
// eligibleForSelectiveMerge (boolean).
//
// CODE-SITE SOURCE FILES (Bug 1): rows whose componentName ends in `.sourcefile`
// OR whose componentPath sits under `/powerpagescodesites/<site>/src/...` resolve to
// the first-class SOURCEFILE_TYPE sentinel (string, not a numeric ppc type). These
// are plain text → mergeStrategy 'text', eligibleForSelectiveMerge true, routed to
// the same clone-based 3-way merge as web templates/pages. The env bytes are read
// from `powerpagessourcefile.filecontent` (componentId == powerpagessourcefileid),
// NOT from a powerpagecomponent envelope. We keep fail-toward-config/binary on
// ambiguity: an unresolvable type stays unsupported/ineligible.
function enrichConflictRow(item) {
  const ppcType =
    normalizeComponentType(item.componentName) != null ? normalizeComponentType(item.componentName)
    : typeFromComponentName(item.componentPath || '');
  const mergeStrategy = ppcType != null ? mergeStrategyForType(ppcType) : 'unsupported';
  return {
    ...item,
    ppcType: ppcType != null ? ppcType : null,
    ppcTypeLabel: ppcType != null ? labelForType(ppcType) : null,
    mergeStrategy,
    eligibleForSelectiveMerge: ppcType != null ? isEligibleForSelectiveMerge(ppcType) : false,
  };
}

// Map one sourcecontrolcomponent row → the enriched conflict item shape.
function sccToItem(r) {
  return enrichConflictRow({
    conflictId:         r.sourceControlComponentId || null,
    componentId:        r.componentId || null,
    componentName:      r.componentName || null,
    componentPath:      r.componentPath || null,
    componentType:      r.componentType || null,
    partitionId:        r.partitionId || null,
    gitHashId:          r.gitHashId || null,
    lastSyncHashId:     r.lastSyncHashId || null,
    envHashId:          r.envHashId || null,
    localChangeType:    null,
    incomingChangeType: null,
    localCommitSha:     null,
    incomingCommitSha:  null,
    resolutionRequired: true,
  });
}

/**
 * @param {object} options
 * @param {string} [options.envUrl]
 * @param {string} [options.token]
 * @param {string} [options.solutionUniqueName]
 * @param {string} [options.solutionId]
 * @returns {Promise<{ count: number, items: object[] } | { error: string }>}
 */
async function listConflicts({ envUrl, token, solutionUniqueName, solutionId } = {}) {
  const url = envUrl || getEnvironmentUrl();
  if (!url) return { error: 'Could not determine environment URL.' };
  const tok = token || getAuthToken(url);
  if (!tok) return { error: 'Could not acquire auth token.' };
  const base = url.replace(/\/+$/, '');

  // PRIMARY: the canonical Conflicts-tab query on sourcecontrolcomponent
  // (action eq 3 = Conflict, useraction eq 0 = unresolved), partitioned by
  // solutionId. Used whenever a solution is known.
  if (solutionId || solutionUniqueName) {
    const scc = await listSourceControlComponents({
      envUrl: url, token: tok, solutionId, solutionUniqueName, action: 3, userAction: 0,
    });
    if (!scc.error) {
      const items = scc.items.map(sccToItem);
      return { count: items.length, items, via: 'sourcecontrolcomponent' };
    }
    // On a hard error (not a clean empty), fall through to the legacy entity.
  }

  // FALLBACK / no-solution: the legacy gitconflictfiles entity (404s on most tenants).
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
  if (res.statusCode === 404) {
    const hint = 'gitconflictfiles 404 — entity may differ; run RefreshChangesFromGit first.';
    if (!solutionId && !solutionUniqueName) return { count: 0, items: [], hint };
    const fallback = await listSourceControlComponents({
      envUrl: url, token: tok, solutionId, solutionUniqueName, action: 3, userAction: 0,
    });
    if (fallback.error) return { error: fallback.error, statusCode: fallback.statusCode, hint };
    const items = fallback.items.map(sccToItem);
    return { count: items.length, items, via: 'sourcecontrolcomponent', hint };
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

  const items = (rows || []).map((r) => enrichConflictRow({
    conflictId:         r.gitconflictfileid || null,
    componentName:      r.componentname || null,
    componentType:      r.componenttype || null,
    localChangeType:    CHANGE_TYPE_LABEL[r.localchangetype] || String(r.localchangetype),
    incomingChangeType: CHANGE_TYPE_LABEL[r.incomingchangetype] || String(r.incomingchangetype),
    localCommitSha:     r.localcommitsha || null,
    incomingCommitSha:  r.incomingcommitsha || null,
    resolutionRequired: true,
  }));

  return { count: items.length, items, via: 'gitconflictfiles' };
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

module.exports = { listConflicts, CHANGE_TYPE_LABEL, enrichConflictRow };
