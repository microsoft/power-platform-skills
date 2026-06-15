#!/usr/bin/env node

// Validates that the Dataverse `sourcecontrolcomponents` table contains no
// rows with `action eq 3` (Conflict). The presence of even ONE such row
// causes CommitToGit to fail with:
//   { code: '0x80098015',
//     message: 'Please resolve conflicts before committing the changes' }
//
// Why this is authoritative (replaces list-conflicts.js for pre-commit gating):
// - `list-conflicts.js` queries the `gitconflictfiles` entity which 404s on
//   many tenants (IL-016) — it silently false-zeroes there.
// - The Dataverse `PreValidateGitComponents` action also misses this case
//   (returns IsValid:true even when action=3 rows exist) — see stored memory
//   "power-pages CommitToGit error".
// - Conversely, every action=3 row is a true blocker regardless of
//   `useraction` value (User has Accept-Incoming'd in Maker Portal or not).
//
// API reference: GET .../sourcecontrolcomponents
//                ?$filter=action eq 3
//                &$select=sourcecontrolcomponentid,componenttype,componentpath,useraction
//                &$top=200
//
// Output (JSON to stdout):
//   {
//     ok: bool,
//     totalChecked: int,             // total conflict rows server-side
//     blocking: [
//       {
//         severity: 'blocker',
//         key: 'action-3-conflict',
//         message: 'Conflict on <path> (action=3, useraction=<label>).',
//         ref: 'IL-CONFLICT-002',
//         details: {
//           sourcecontrolcomponentid, componentType, componentPath,
//           useractionLabel,
//         },
//         remediation: 'Open Maker Portal Source Control → Conflicts tab and resolve...',
//       },
//       ...
//     ],
//     warnings: [],
//     info: [],
//     scope: { ... },
//   }
//
// Usage:
//   node validate-no-action-3-conflicts.js
//       [--envUrl <url>] [--token <token>]
//       [--solutionUniqueName <name>] [--solutionId <guid>]
//       [--top <n>]                 // default 200

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

const USERACTION_LABEL = Object.freeze({
  0: 'None',
  1: 'AcceptLocal',
  2: 'AcceptIncoming',
});

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
async function validateNoAction3Conflicts({ envUrl, token, solutionUniqueName, solutionId, top = 200 } = {}) {
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

  const filterParts = ['action eq 3'];
  if (sid) filterParts.push(`partitionid eq ${sid}`);
  const filterExpr = filterParts.join(' and ');

  const apiUrl =
    `${base}/api/data/v9.2/sourcecontrolcomponents` +
    `?$filter=${encodeURIComponent(filterExpr)}` +
    `&$select=sourcecontrolcomponentid,componenttype,componenttypename,componentpath,useraction,solutioncomponentstate` +
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
        key: 'conflict-detection-unavailable',
        message: 'sourcecontrolcomponents entity returned 404 — conflict detection unavailable on this tenant.',
        ref: 'IL-CONFLICT-001',
        details: { statusCode: 404 },
        remediation: 'Skip this validator on this tenant; CommitToGit will surface 0x80098015 inline if conflicts actually exist.',
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

  const blocking = rows.map((r) => {
    const useractionLabel = USERACTION_LABEL[r.useraction] || (r.useraction !== undefined ? String(r.useraction) : 'None');
    return {
      severity: 'blocker',
      key: 'action-3-conflict',
      message: `Conflict on ${r.componentpath || r.sourcecontrolcomponentid} (useraction=${useractionLabel}).`,
      ref: 'IL-CONFLICT-002',
      details: {
        sourcecontrolcomponentid: r.sourcecontrolcomponentid,
        componentType: r.componenttypename || (r.componenttype !== undefined ? String(r.componenttype) : null),
        componentPath: r.componentpath || null,
        useractionLabel,
      },
      remediation: 'Open the Maker Portal Source Control → Conflicts tab and resolve each row (Accept incoming / Accept local), then re-run pre-flight.',
    };
  });

  const info = [];
  if (totalCount > rows.length) {
    info.push({
      severity: 'info',
      key: 'action-3-truncation',
      message: `Server reports ${totalCount} conflict rows; only the first ${rows.length} returned. Increase --top to see more.`,
      ref: 'IL-CONFLICT-003',
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
  validateNoAction3Conflicts(args)
    .then((r) => {
      process.stdout.write(JSON.stringify(r, null, 2) + '\n');
      process.exit(r && r.error ? 1 : 0);
    })
    .catch((e) => {
      process.stderr.write('validate-no-action-3-conflicts: ' + e.message + '\n');
      process.exit(1);
    });
}

module.exports = { validateNoAction3Conflicts, USERACTION_LABEL };
