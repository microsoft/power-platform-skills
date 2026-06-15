#!/usr/bin/env node

// Validates that the Dataverse `sourcecontrolcomponents` table contains no
// orphan rows — rows whose `sourcecontrolcomponentpayloadid` lookup is null
// while `iscommitted` is false. Orphans are the root cause of CommitToGit
// failing with:
//   { code: '0x80040217',
//     message: 'No record value found for sourcecontrolcomponentpayload' }
//
// Empirical behaviour (see references/inner-loop-error-catalog.md IL-019):
// CommitToGit stops at the FIRST orphan row, so fixing one only surfaces the
// next. A pre-flight pass that names every orphan up-front is the only safe
// path.
//
// Schema note (verified 2026-06 against sri-alm-dev-1 via
// `EntityDefinitions(LogicalName='sourcecontrolcomponent')/Attributes`):
// there is NO `_objectid_value` column on this entity; the underlying
// component reference lives in the plain `componentid` Uniqueidentifier
// attribute. The payload FK is `sourcecontrolcomponentpayloadid` (Lookup),
// queried in OData as `_sourcecontrolcomponentpayloadid_value`. Rows where
// that lookup is null are the orphans the commit pipeline chokes on.
//
// API reference: GET .../sourcecontrolcomponents
//                ?$filter=_sourcecontrolcomponentpayloadid_value eq null and iscommitted eq false
//                &$select=sourcecontrolcomponentid,componenttype,componenttypename,componentpath,action
//                &$top=200
//
// Output (JSON to stdout):
//   {
//     ok: bool,                       // true iff no orphans
//     totalChecked: int,              // orphan rows examined
//     blocking: [
//       {
//         severity: 'blocker',
//         key: 'orphan-source-control-row',
//         message: 'Orphan sourcecontrolcomponent <id> (no objectid).',
//         ref: 'IL-ORPHAN-002',
//         details: {
//           sourcecontrolcomponentid,
//           componentType, componentPath, actionLabel, payloadId
//         },
//         remediation: 'Open Maker Portal Source Control panel and Discard ...'
//       },
//       ...
//     ],
//     warnings: [],
//     info: [],                       // optional notes (tenant-capability fallbacks)
//     scope: { solutionUniqueName?, solutionId? } | { all: true },
//   }
//
// Tenant fallback: if the entity itself is unavailable (HTTP 404) we surface
// a single info-level finding instead of blocking; some sovereign tenants
// don't expose `sourcecontrolcomponent` and the user should not be stuck.
//
// Usage:
//   node validate-no-orphan-source-control-rows.js
//       [--envUrl <url>] [--token <token>]
//       [--solutionUniqueName <name>] [--solutionId <guid>]
//       [--top <n>]                 // default 200; rows beyond this surface as info

'use strict';

const { getAuthToken, getEnvironmentUrl, makeRequest } = require('./validation-helpers');

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = { envUrl: null, token: null, solutionUniqueName: null, solutionId: null, top: 200 };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--envUrl' && args[i + 1]) out.envUrl = args[++i];
    else if (args[i] === '--token' && args[i + 1]) out.token = args[++i];
    else if (args[i] === '--solutionUniqueName' && args[i + 1]) out.solutionUniqueName = args[++i];
    else if (args[i] === '--solutionId' && args[i + 1]) out.solutionId = args[++i];
    else if (args[i] === '--top' && args[i + 1]) out.top = parseInt(args[++i], 10);
  }
  return out;
}

const ACTION_LABEL = Object.freeze({ 0: 'None', 1: 'Push', 2: 'Pull', 3: 'Conflict' });

async function resolveSolutionId({ base, tok, solutionUniqueName }) {
  const url = `${base}/api/data/v9.2/solutions?$filter=uniquename eq '${encodeURIComponent(solutionUniqueName)}'&$select=solutionid&$top=1`;
  const res = await makeRequest({
    url, method: 'GET',
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
async function validateNoOrphanSourceControlRows({ envUrl, token, solutionUniqueName, solutionId, top = 200 } = {}) {
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

  const filterParts = ['_sourcecontrolcomponentpayloadid_value eq null', 'iscommitted eq false'];
  if (sid) filterParts.push(`partitionid eq ${sid}`);
  const filterExpr = filterParts.join(' and ');

  const apiUrl =
    `${base}/api/data/v9.2/sourcecontrolcomponents` +
    `?$filter=${encodeURIComponent(filterExpr)}` +
    `&$select=sourcecontrolcomponentid,componentid,componenttype,componenttypename,componentpath,action` +
    `&$count=true&$top=${top}`;

  const res = await makeRequest({
    url: apiUrl, method: 'GET',
    headers: {
      Authorization: `Bearer ${tok}`,
      'OData-MaxVersion': '4.0',
      'OData-Version': '4.0',
      Accept: 'application/json',
      Prefer: 'odata.include-annotations="*"',
    },
  });

  if (res.error) return { error: res.error };

  const scope = solutionUniqueName
    ? { solutionUniqueName, solutionId: sid }
    : (sid ? { solutionId: sid } : { all: true });

  if (res.statusCode === 404) {
    return {
      ok: true,
      totalChecked: 0,
      blocking: [],
      warnings: [],
      info: [{
        severity: 'info',
        key: 'orphan-detection-unavailable',
        message: 'sourcecontrolcomponents entity returned 404 — orphan detection unavailable on this tenant.',
        ref: 'IL-ORPHAN-001',
        details: { statusCode: 404 },
        remediation: 'Skip this validator on this tenant; CommitToGit will surface 0x80040217 inline if orphans actually exist.',
      }],
      scope,
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

  const rows = parsed.value || [];
  const totalCount = typeof parsed['@odata.count'] === 'number' ? parsed['@odata.count'] : rows.length;

  const blocking = rows.map((r) => ({
    severity: 'blocker',
    key: 'orphan-source-control-row',
    message: `Orphan sourcecontrolcomponent ${r.sourcecontrolcomponentid} (no payload)${r.componentpath ? ` at ${r.componentpath}` : ''}.`,
    ref: 'IL-ORPHAN-002',
    details: {
      sourcecontrolcomponentid: r.sourcecontrolcomponentid,
      componentId: r.componentid || null,
      componentType: r.componenttypename || (r.componenttype !== undefined ? String(r.componenttype) : null),
      componentPath: r.componentpath || null,
      actionLabel: ACTION_LABEL[r.action] || (r.action !== undefined ? String(r.action) : null),
    },
    remediation: 'Open the Maker Portal Source Control panel and Discard each orphan row, then re-run pre-flight.',
  }));

  const info = [];
  if (totalCount > rows.length) {
    info.push({
      severity: 'info',
      key: 'orphan-row-truncation',
      message: `Server reports ${totalCount} orphan rows; only the first ${rows.length} returned. Increase --top to see more.`,
      ref: 'IL-ORPHAN-003',
      details: { totalCount, returnedCount: rows.length, top },
      remediation: 'Re-run with --top <larger-number> to enumerate the remaining rows.',
    });
  }

  return {
    ok: blocking.length === 0,
    totalChecked: totalCount,
    blocking,
    warnings: [],
    info,
    scope,
  };
}

if (require.main === module) {
  const args = parseArgs(process.argv);
  validateNoOrphanSourceControlRows(args)
    .then((r) => {
      process.stdout.write(JSON.stringify(r, null, 2) + '\n');
      process.exit(r && r.error ? 1 : 0);
    })
    .catch((e) => {
      process.stderr.write('validate-no-orphan-source-control-rows: ' + e.message + '\n');
      process.exit(1);
    });
}

module.exports = { validateNoOrphanSourceControlRows, ACTION_LABEL };
