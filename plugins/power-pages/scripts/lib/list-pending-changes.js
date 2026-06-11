#!/usr/bin/env node

// Lists the pending Changes in the bound Dataverse environment — the
// equivalent of the "Changes" tab in the maker portal's Git integration UI.
//
// HAR-CONFIRMED (2026-06, development tenant):
//   Pending Changes live in the `sourcecontrolcomponent` entity, NOT
//   `gitcommitfiles` (the older guess returned 404 on every tenant we tried).
//   See references/inner-loop-empirical-findings.md §10.
//
//   Canonical query:
//     GET /api/data/v9.2/sourcecontrolcomponents
//        ?$filter=partitionid eq <solutionid> and iscommitted eq false
//        &$count=true&$top=<page>
//        Prefer: odata.include-annotations="*"
//
//   Field mapping:
//     componentId    ← objectid (the entity's own id)
//     componentName  ← componentdisplayname OR name
//     componentType  ← componenttypename (e.g. "Entity", "Web Page", "Solution")
//     changeType     ← solutioncomponentstate { 0=Create→"Add", 1=Update→"Modify", 2=Delete→"Delete" }
//     filePath       ← componentpath
//     action         ← action.FormattedValue (Push|Delete|None)
//
// Output (JSON to stdout):
//   {
//     count: <number>,           // total pending Changes across all bound solutions or scoped to one
//     scope: { solutionUniqueName?, solutionId? },
//     items: [ ...up to --top items, see field mapping above... ],
//   }
//   On error: { error: "<message>", statusCode?: <number> }
//
// Usage:
//   node list-pending-changes.js
//       [--envUrl <url>]
//       [--token <token>]
//       [--solutionUniqueName <name>]   // preferred way to scope per-solution
//       [--solutionId <guid>]           // alternative if you already have the id
//       [--top <n>]                     // default 50 items returned; count is always exact
//       [--probe]                       // fast count-only mode: returns { count } without
//                                       // materialising items[]. Used by the cache layer
//                                       // in validate-pending-changes Phase 2 to compute
//                                       // a cache key without paying for full row fetch.

'use strict';

const { getAuthToken, getEnvironmentUrl, makeRequest } = require('./validation-helpers');

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = { envUrl: null, token: null, solutionUniqueName: null, solutionId: null, top: 50, probe: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--envUrl' && args[i + 1]) out.envUrl = args[++i];
    else if (args[i] === '--token' && args[i + 1]) out.token = args[++i];
    else if (args[i] === '--solutionUniqueName' && args[i + 1]) out.solutionUniqueName = args[++i];
    else if (args[i] === '--solutionId' && args[i + 1]) out.solutionId = args[++i];
    else if (args[i] === '--top' && args[i + 1]) out.top = parseInt(args[++i], 10);
    else if (args[i] === '--probe') out.probe = true;
  }
  return out;
}

// HAR-CONFIRMED — solutioncomponentstate integer to label mapping.
// Mirrors the "Create / Update / Delete" labels shown in the maker portal
// Changes tab. (formatted-value annotations confirm this on every row.)
const CHANGE_TYPE_LABEL = Object.freeze({
  0: 'Add',
  1: 'Modify',
  2: 'Delete',
});

async function resolveSolutionId({ base, tok, solutionUniqueName }) {
  const url = `${base}/api/data/v9.2/solutions?$filter=uniquename eq '${encodeURIComponent(solutionUniqueName)}'&$select=solutionid&$top=1`;
  const res = await makeRequest({
    url,
    method: 'GET',
    headers: {
      Authorization: `Bearer ${tok}`,
      'OData-MaxVersion': '4.0',
      'OData-Version': '4.0',
      Accept: 'application/json',
    },
  });
  if (res.error) return { error: res.error };
  if (res.statusCode !== 200) return { error: `Solution lookup HTTP ${res.statusCode}` };
  let rows;
  try { rows = JSON.parse(res.body).value; } catch (e) { return { error: 'Solution lookup parse error: ' + e.message }; }
  if (!rows || rows.length === 0) return { error: `Solution '${solutionUniqueName}' not found.` };
  return { solutionId: rows[0].solutionid };
}

/**
 * @param {object} options
 * @returns {Promise<object>}
 */
async function listPendingChanges({ envUrl, token, solutionUniqueName, solutionId, top = 50, probe = false } = {}) {
  const url = envUrl || getEnvironmentUrl();
  if (!url) return { error: 'Could not determine environment URL.' };
  const tok = token || getAuthToken(url);
  if (!tok) return { error: 'Could not acquire auth token.' };
  const base = url.replace(/\/+$/, '');

  let sid = solutionId;
  if (!sid && solutionUniqueName) {
    const r = await resolveSolutionId({ base, tok, solutionUniqueName });
    if (r.error) return { error: r.error };
    sid = r.solutionId;
  }

  // Build filter. iscommitted eq false is the canonical "pending Changes" predicate.
  const filterParts = ['iscommitted eq false'];
  if (sid) filterParts.push(`partitionid eq ${sid}`);
  const filterExpr = filterParts.join(' and ');

  // Probe mode: count-only query. We use $top=1 (Dataverse rejects $top=0)
  // and the smallest viable $select so the server returns @odata.count with a
  // near-empty payload. ~50-100ms round-trip vs ~300-700ms for the full row
  // fetch on tenants with a few hundred pending Changes — used by the cache
  // layer to compute a key cheaply.
  const apiUrl = probe
    ? `${base}/api/data/v9.2/sourcecontrolcomponents` +
      `?$filter=${encodeURIComponent(filterExpr)}` +
      `&$select=sourcecontrolcomponentid` +
      `&$count=true&$top=1`
    : `${base}/api/data/v9.2/sourcecontrolcomponents` +
      `?$filter=${encodeURIComponent(filterExpr)}` +
      `&$select=sourcecontrolcomponentid,componentid,componentdisplayname,name,componenttypename,componenttype,componentpath,solutioncomponentstate,action,partitionid,modifiedon` +
      `&$count=true&$top=${top}`;

  const res = await makeRequest({
    url: apiUrl,
    method: 'GET',
    headers: {
      Authorization: `Bearer ${tok}`,
      'OData-MaxVersion': '4.0',
      'OData-Version': '4.0',
      Accept: 'application/json',
      Prefer: 'odata.include-annotations="*"',
    },
  });

  if (res.error) return { error: res.error };
  if (res.statusCode === 404) {
    // Should not happen on tenants with Git integration enabled — surface a hint.
    return {
      count: 0,
      items: [],
      hint: 'sourcecontrolcomponent 404 — verify the env actually has Git integration. ' +
            'If the entity is missing, the env was likely never bound to Git.',
    };
  }
  if (res.statusCode !== 200) {
    let msg = `HTTP ${res.statusCode}`;
    try { msg = JSON.parse(res.body).error.message || msg; } catch {}
    return { error: msg, statusCode: res.statusCode };
  }

  let parsed;
  try { parsed = JSON.parse(res.body); } catch (e) {
    return { error: 'Failed to parse response: ' + e.message };
  }

  const totalCount = typeof parsed['@odata.count'] === 'number'
    ? parsed['@odata.count']
    : (parsed.value || []).length;

  if (probe) {
    // Probe mode returns count only — caller (cache layer) needs just the key.
    return {
      count: totalCount,
      scope: solutionUniqueName ? { solutionUniqueName, solutionId: sid } : (sid ? { solutionId: sid } : { all: true }),
      probe: true,
    };
  }

  const items = (parsed.value || []).map((r) => ({
    componentId:    r.componentid || null,
    componentName:  r.componentdisplayname || r.name || null,
    componentType:  r.componenttypename || String(r.componenttype),
    changeType:     CHANGE_TYPE_LABEL[r.solutioncomponentstate] || String(r.solutioncomponentstate),
    action:         r['action@OData.Community.Display.V1.FormattedValue'] || String(r.action),
    filePath:       r.componentpath || null,
    partitionId:    r.partitionid || null,
    lastModifiedOn: r.modifiedon || null,
  }));

  return {
    count: totalCount,
    scope: solutionUniqueName ? { solutionUniqueName, solutionId: sid } : (sid ? { solutionId: sid } : { all: true }),
    items,
  };
}

if (require.main === module) {
  const args = parseArgs(process.argv);
  listPendingChanges(args)
    .then((r) => { process.stdout.write(JSON.stringify(r, null, 2) + '\n'); })
    .catch((e) => {
      process.stderr.write('list-pending-changes: ' + e.message + '\n');
      process.exit(1);
    });
}

module.exports = { listPendingChanges, CHANGE_TYPE_LABEL };
