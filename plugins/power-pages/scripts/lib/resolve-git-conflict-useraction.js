#!/usr/bin/env node

// Resolves a Power Pages Dataverse Git conflict by PATCHing `useraction` on the
// component's `sourcecontrolcomponent` row — the mechanism the Maker Portal uses
// (captured via HAR). This is the IL-015 workaround: it does NOT depend on the
// `ResolveGitConflict` OData action, which is absent on many tenants.
//
// HAR-confirmed (sri-alm-dev-1, 2026-06-18):
//   POST {env}/api/data/v9.0/$batch
//     changeset →
//       PATCH sourcecontrolcomponents(sourcecontrolcomponentid=<id>, partitionid='<solutionId>')
//       If-Match: <row etag> (or * only when no etag/version could be read)
//       { "useraction": <code> }
//
// useraction codes (authoritative — from the sourcecontrolcomponent.useraction
// option-set metadata, verified live 2026-06-18):
//   0 = None  (undecided — the freshly-detected conflict's default)
//   1 = Push  → "keep current changes" (the environment version wins and will be
//               pushed to Git on the next commit; row moves to the Changes list)
//   2 = Pull  → "accept incoming changes" (the Git/branch version wins and will be
//               pulled into the environment; HAR-confirmed + live-proven)
//
// The conflict row is found by `componentid` (the powerpagecomponent id) within
// the solution partition, filtered to `action eq 3` (a conflict can be
// iscommitted=true, so we deliberately do NOT add an `iscommitted` predicate —
// matching the portal Conflicts tab).
//
// Output (JSON to stdout):
//   { ok, resolved, sourceControlComponentId, componentId, useraction, etag, concurrency, statusCode }
//   On error: { ok:false, error, statusCode? }
//
// Usage:
//   node resolve-git-conflict-useraction.js
//     --envUrl <url> --solutionId <guid> --componentId <powerpagecomponentid>
//     --decision accept-incoming|keep-current
//     [--token <dvToken>] [--sourceControlComponentId <id>] [--etag <etag>]

'use strict';

const { getAuthToken, makeRequest } = require('./validation-helpers');

const USERACTION = Object.freeze({ 'accept-incoming': 2, 'keep-current': 1 });
const API = 'v9.0';
const ACTION_CONFLICT = 3;

function parseArgs(argv) {
  const a = argv.slice(2);
  const o = { envUrl: null, token: null, solutionId: null, componentId: null, decision: null, sourceControlComponentId: null, etag: null };
  for (let i = 0; i < a.length; i++) {
    const n = a[i + 1];
    if (a[i] === '--envUrl' && n) o.envUrl = a[++i];
    else if (a[i] === '--token' && n) o.token = a[++i];
    else if (a[i] === '--solutionId' && n) o.solutionId = a[++i];
    else if (a[i] === '--componentId' && n) o.componentId = a[++i];
    else if (a[i] === '--decision' && n) o.decision = a[++i];
    else if (a[i] === '--sourceControlComponentId' && n) o.sourceControlComponentId = a[++i];
    else if (a[i] === '--etag' && n) o.etag = a[++i];
  }
  return o;
}

function etagFromRow(row) {
  if (!row) return null;
  if (row['@odata.etag']) return row['@odata.etag'];
  if (row.versionnumber !== undefined && row.versionnumber !== null && row.versionnumber !== '') return `W/"${row.versionnumber}"`;
  return null;
}

/**
 * Find the conflict `sourcecontrolcomponent` row id for a given component.
 * @returns {Promise<{ found, id?, action?, useraction?, etag?, error?, statusCode? }>}
 */
async function findConflictRow({ base, token, solutionId, componentId }) {
  // NOTE: `componentid` is not reliably filterable on this entity (the server may
  // ignore $select/$filter on some columns), so filter by the reliable
  // `action eq 3` within the solution partition and match componentId client-side.
  // Do NOT add `iscommitted eq false`: an active (unresolved) conflict can be
  // iscommitted=true (verified live 2026-06-19 — a site-setting conflict the portal
  // listed but `iscommitted eq false` hid), which would make this finder fail to
  // locate the row and wrongly report the conflict as already resolved. `action eq 3`
  // + client-side componentId match is the portal-faithful predicate.
  const filter = `action eq ${ACTION_CONFLICT}`;
  const url = `${base}/api/data/${API}/sourcecontrolcomponents?$filter=${encodeURIComponent(filter)}&partitionId=${solutionId}`;
  const res = await makeRequest({ url, method: 'GET', headers: { Authorization: `Bearer ${token}`, 'OData-MaxVersion': '4.0', 'OData-Version': '4.0', Accept: 'application/json', Prefer: 'odata.include-annotations="*"' } });
  if (res.statusCode !== 200) {
    let msg = `HTTP ${res.statusCode}`; try { msg = JSON.parse(res.body).error.message || msg; } catch {}
    return { found: false, error: msg, statusCode: res.statusCode };
  }
  let rows = [];
  try { rows = JSON.parse(res.body).value || []; } catch {}
  const want = String(componentId).toLowerCase();
  const row = rows.find((r) => String(r.componentid || '').toLowerCase() === want);
  if (!row || !row.sourcecontrolcomponentid) return { found: false, conflictRowsInSolution: rows.length };
  return { found: true, id: row.sourcecontrolcomponentid, action: row.action, useraction: row.useraction, etag: etagFromRow(row) };
}

/**
 * Read a known `sourcecontrolcomponent` row's etag before PATCHing it.
 * @returns {Promise<{ ok, etag?, error?, statusCode? }>}
 */
async function fetchSourceControlComponentEtag({ base, token, solutionId, sourceControlComponentId }) {
  const url = `${base}/api/data/${API}/sourcecontrolcomponents(sourcecontrolcomponentid=${sourceControlComponentId}, partitionid='${solutionId}')?$select=sourcecontrolcomponentid,versionnumber`;
  const res = await makeRequest({ url, method: 'GET', headers: { Authorization: `Bearer ${token}`, 'OData-MaxVersion': '4.0', 'OData-Version': '4.0', Accept: 'application/json', Prefer: 'odata.include-annotations="*"' } });
  if (res.statusCode !== 200) {
    let msg = `HTTP ${res.statusCode}`; try { msg = JSON.parse(res.body).error.message || msg; } catch {}
    return { ok: false, error: msg, statusCode: res.statusCode };
  }
  let row = null;
  try {
    const parsed = JSON.parse(res.body);
    row = Array.isArray(parsed.value) ? parsed.value.find((r) => String(r.sourcecontrolcomponentid || '').toLowerCase() === String(sourceControlComponentId).toLowerCase()) : parsed;
  } catch {}
  return { ok: true, etag: etagFromRow(row) };
}

/**
 * Build the multipart/mixed $batch body that PATCHes useraction (mirrors the HAR, with an etag when available).
 */
function buildBatchBody({ base, sourceControlComponentId, solutionId, useraction, etag = null }) {
  const batch = `batch_${Date.now()}`;
  const changeset = `changeset_${Date.now()}`;
  const patchUrl = `${base}/api/data/${API}/sourcecontrolcomponents(sourcecontrolcomponentid=${sourceControlComponentId}, partitionid='${solutionId}')`;
  const ifMatch = etag || '*';
  const concurrency = etag ? 'etag' : 'blind';
  const body =
    `--${batch}\r\n` +
    `Content-Type: multipart/mixed; boundary=${changeset}\r\n\r\n` +
    `--${changeset}\r\n` +
    `Content-Type: application/http\r\n` +
    `Content-Transfer-Encoding: binary\r\n` +
    `Content-ID: 1\r\n\r\n` +
    `PATCH ${patchUrl} HTTP/1.1\r\n` +
    `Content-Type: application/json\r\n` +
    `Accept: application/json\r\n` +
    `If-Match: ${ifMatch}\r\n\r\n` +
    `${JSON.stringify({ useraction })}\r\n` +
    `--${changeset}--\r\n\r\n` +
    `--${batch}--\r\n`;
  return { batch, body, concurrency };
}

async function resolveGitConflictUserAction({
  envUrl, token, solutionId, componentId, decision, sourceControlComponentId = null, etag = null,
} = {}) {
  if (!envUrl) throw new Error('--envUrl is required');
  if (!solutionId) throw new Error('--solutionId is required');
  if (!decision || !(decision in USERACTION)) throw new Error('--decision must be accept-incoming or keep-current');
  const base = envUrl.replace(/\/+$/, '');
  const tok = token || getAuthToken(envUrl);
  if (!tok) return { ok: false, error: 'Could not acquire auth token.' };
  const useraction = USERACTION[decision];

  let sccId = sourceControlComponentId;
  let rowEtag = etag;
  if (!sccId) {
    if (!componentId) throw new Error('--componentId (or --sourceControlComponentId) is required');
    const row = await findConflictRow({ base, token: tok, solutionId, componentId });
    if (row.error) return { ok: false, error: `conflict lookup failed: ${row.error}`, statusCode: row.statusCode };
    if (!row.found) return { ok: false, error: 'No matching conflict row (action=3) for this component; nothing to resolve.', notFound: true };
    sccId = row.id;
    rowEtag = row.etag || null;
  } else if (!rowEtag) {
    const row = await fetchSourceControlComponentEtag({ base, token: tok, solutionId, sourceControlComponentId: sccId });
    if (row.error) return { ok: false, error: `etag lookup failed: ${row.error}`, statusCode: row.statusCode };
    rowEtag = row.etag || null;
  }

  const { batch, body, concurrency } = buildBatchBody({ base, sourceControlComponentId: sccId, solutionId, useraction, etag: rowEtag });
  const res = await makeRequest({
    url: `${base}/api/data/${API}/$batch`,
    method: 'POST',
    headers: {
      Authorization: `Bearer ${tok}`,
      'OData-MaxVersion': '4.0', 'OData-Version': '4.0', Accept: 'application/json',
      'Content-Type': `multipart/mixed; boundary=${batch}`,
    },
    body,
  });

  const ok = res.statusCode >= 200 && res.statusCode < 300;
  // A $batch returns 200 even if the inner PATCH failed — surface the inner status if present.
  const innerStatus = ok ? ((res.body || '').match(/HTTP\/1\.1\s+([45]\d\d)/) || [])[1] : null;
  const innerFailed = Boolean(innerStatus);
  if (!ok || innerFailed) {
    if (innerStatus === '412') {
      return { ok: false, conflict: true, error: 'the conflict row changed since it was read (412) — re-read and retry', statusCode: 412, batchStatusCode: res.statusCode, body: (res.body || '').slice(0, 400) };
    }
    return { ok: false, error: innerFailed ? 'inner PATCH failed inside $batch' : `HTTP ${res.statusCode}`, statusCode: innerStatus ? Number(innerStatus) : res.statusCode, batchStatusCode: innerStatus ? res.statusCode : undefined, body: (res.body || '').slice(0, 400) };
  }
  return { ok: true, resolved: true, sourceControlComponentId: sccId, componentId, decision, useraction, etag: rowEtag, concurrency, statusCode: res.statusCode };
}

if (require.main === module) {
  const args = parseArgs(process.argv);
  resolveGitConflictUserAction(args)
    .then((r) => { process.stdout.write(JSON.stringify(r, null, 2) + '\n'); if (!r.ok) process.exit(1); })
    .catch((e) => { process.stderr.write('resolve-git-conflict-useraction: ' + e.message + '\n'); process.exit(1); });
}

module.exports = { resolveGitConflictUserAction, findConflictRow, buildBatchBody, USERACTION, ACTION_CONFLICT };
