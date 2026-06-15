#!/usr/bin/env node

// V-9 HTTP validator: WARN per pending Change whose underlying metadata
// has IsCustomizable.Value === false. Such commits succeed (no error from
// CommitToGit) but break Pull on a target env — sync-from-git on the
// downstream env fails because Dataverse refuses to apply a customisation
// to a non-customisable component. Currently the failure is invisible
// until the PR is merged and a downstream env tries to pull.
//
// Strategy: read the pending-snapshot's items[]; collect componentId values
// per entity type (Entity, Attribute, Relationship); for each type, issue
// a single bulk GET against the metadata endpoint filtering by MetadataId
// in (g1,g2,...) batched at 25 GUIDs per call (URL length safety). For
// each match where IsCustomizable.Value===false → WARN.
//
// Out of scope: types without a stable MetadataId (web resources, web
// templates, files, etc.) — those surface as an info finding and skip.
//
// Output (JSON to stdout):
//   {
//     ok: true,                       // never blocks
//     totalChecked: <int>,            // unique components looked up
//     blocking: [],
//     warnings: [
//       {
//         severity: 'warn',
//         key: 'not-customizable-metadata',
//         message: 'Component <name> (IsCustomizable=false) commits but breaks Pull on targets.',
//         ref: 'IL-CUSTOMIZABLE-001',
//         details: { componentId, componentType, entitySet, isCustomizable: false },
//         remediation: 'Mark the component customizable in the source env, or remove it from the pending changes.',
//       },
//     ],
//     info: [...],
//   }
//
// Usage:
//   node validate-no-iscustomizable-false-rows.js
//     --pending-file <path>           // REQUIRED
//     [--envUrl <url>] [--token <token>]
//     [--batch-size <n>]              // default 25

'use strict';

const fs = require('node:fs');
const { getAuthToken, getEnvironmentUrl, makeRequest } = require('./validation-helpers');

const COMPONENT_TYPE_TO_ENTITYSET = Object.freeze({
  1:  { entitySet: 'EntityDefinitions',                  label: 'Entity'       },
  // Attributes are not exposed as a top-level entity set in the Dataverse
  // Web API — they live under EntityDefinitions(LogicalName='X')/Attributes,
  // which requires the parent entity logical name. Pending-changes snapshot
  // rows don't carry that link, so attribute IsCustomizable checks are
  // surfaced as `info` findings (skipped) rather than guessed.
});

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = { envUrl: null, token: null, pendingFile: null, batchSize: 25 };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--envUrl' && args[i + 1]) out.envUrl = args[++i];
    else if (args[i] === '--token' && args[i + 1]) out.token = args[++i];
    else if (args[i] === '--pending-file' && args[i + 1]) out.pendingFile = args[++i];
    else if (args[i] === '--batch-size' && args[i + 1]) out.batchSize = parseInt(args[++i], 10);
  }
  return out;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function buildInFilter(metadataIds) {
  const quoted = metadataIds.map((id) => `'${id}'`).join(',');
  return `Microsoft.Dynamics.CRM.In(PropertyName='MetadataId',PropertyValues=[${quoted}])`;
}

async function queryMetadataBatch({ base, tok, entitySet, ids }) {
  const filter = `$filter=${encodeURIComponent(buildInFilter(ids))}`;
  const select = '$select=MetadataId,LogicalName,IsCustomizable';
  const apiUrl = `${base}/api/data/v9.2/${entitySet}?${select}&${filter}`;
  const res = await makeRequest({
    url: apiUrl, method: 'GET',
    headers: {
      Authorization: `Bearer ${tok}`,
      'OData-MaxVersion': '4.0',
      'OData-Version': '4.0',
      Accept: 'application/json',
    },
  });
  if (res.error) return { error: res.error };
  if (res.statusCode !== 200) {
    let msg = `HTTP ${res.statusCode}`;
    try { msg = JSON.parse(res.body).error.message || msg; } catch {}
    return { error: msg, statusCode: res.statusCode };
  }
  try { return { items: JSON.parse(res.body).value || [] }; }
  catch (e) { return { error: 'parse: ' + e.message }; }
}

/**
 * @param {object} options
 * @returns {Promise<object>}
 */
async function validateNoIscustomizableFalseRows({ envUrl, token, pendingFile, batchSize = 25 } = {}) {
  if (!pendingFile) return { error: '--pending-file is required.' };
  if (!fs.existsSync(pendingFile)) return { error: `Snapshot file not found: ${pendingFile}` };

  const url = envUrl || getEnvironmentUrl();
  if (!url) return { error: 'Could not determine environment URL.' };
  const tok = token || getAuthToken(url);
  if (!tok) return { error: 'Could not acquire auth token.' };
  const base = url.replace(/\/+$/, '');

  let snap;
  try { snap = JSON.parse(fs.readFileSync(pendingFile, 'utf8')); }
  catch (e) { return { error: 'snapshot parse: ' + e.message }; }
  const items = Array.isArray(snap.items) ? snap.items : (Array.isArray(snap) ? snap : []);

  // Bucket componentIds by metadata-bearing type.
  // Source-control entity uses different componenttype codes than the
  // metadata `EntityDefinitions` set; we look at `componentType` label
  // (which list-pending-changes maps from componenttypename) when present
  // and fall back to numeric componenttype.
  const buckets = new Map(); // entitySet -> Set<MetadataId>
  const skippedTypes = new Map(); // label -> count

  for (const it of items) {
    if (!it) continue;
    const id = it.componentId;
    if (!id) continue;
    // We currently only check Entity metadata. Attributes are not exposed
    // as a top-level Dataverse entity set (they live under
    // EntityDefinitions(LogicalName='X')/Attributes), and the pending-
    // changes snapshot doesn't carry the parent entity link reliably.
    // Everything other than componenttype=1 / componentType='Entity' is
    // surfaced as a skipped-type info finding so the user knows the gap.
    let entitySet = null, label = null;
    if (it.componentTypeNumeric === 1 || it.componentType === 'Entity') {
      entitySet = 'EntityDefinitions'; label = 'Entity';
    } else {
      const t = it.componentType || 'Unknown';
      skippedTypes.set(t, (skippedTypes.get(t) || 0) + 1);
      continue;
    }
    if (!buckets.has(entitySet)) buckets.set(entitySet, { ids: new Set(), label, items: new Map() });
    buckets.get(entitySet).ids.add(id);
    buckets.get(entitySet).items.set(id, it);
  }

  const warnings = [];
  const info = [];
  let totalChecked = 0;

  for (const [entitySet, bucket] of buckets) {
    const ids = [...bucket.ids];
    totalChecked += ids.length;
    for (const batch of chunk(ids, batchSize)) {
      const res = await queryMetadataBatch({ base, tok, entitySet, ids: batch });
      if (res.error) return { error: `${entitySet}: ${res.error}` };
      for (const m of res.items) {
        if (m && m.IsCustomizable && m.IsCustomizable.Value === false) {
          const it = bucket.items.get(m.MetadataId);
          warnings.push({
            severity: 'warn',
            key: 'not-customizable-metadata',
            message: `${bucket.label} '${m.LogicalName || it?.componentName || m.MetadataId}' (IsCustomizable=false) commits but breaks Pull on targets.`,
            ref: 'IL-CUSTOMIZABLE-001',
            details: {
              componentId: m.MetadataId,
              componentType: bucket.label,
              entitySet,
              logicalName: m.LogicalName || null,
              isCustomizable: false,
            },
            remediation:
              'Mark the component customizable in the source env (CanBeCustomized=true) ' +
              'or remove it from the pending changes before commit.',
          });
        }
      }
    }
  }

  for (const [t, n] of skippedTypes) {
    info.push({
      severity: 'info',
      key: 'iscustomizable-check-skipped-type',
      message: `Skipped IsCustomizable check for ${n} component(s) of type '${t}' (no metadata-id mapping).`,
      ref: 'IL-CUSTOMIZABLE-002',
      details: { componentType: t, count: n },
      remediation: 'IsCustomizable is only checkable for Entity / Attribute metadata. Other types are unaffected by this validator.',
    });
  }

  return {
    ok: true,
    totalChecked,
    blocking: [],
    warnings,
    info,
  };
}

if (require.main === module) {
  const args = parseArgs(process.argv);
  validateNoIscustomizableFalseRows(args)
    .then((r) => {
      process.stdout.write(JSON.stringify(r, null, 2) + '\n');
      process.exit(r && r.error ? 1 : 0);
    })
    .catch((e) => {
      process.stderr.write('validate-no-iscustomizable-false-rows: ' + e.message + '\n');
      process.exit(1);
    });
}

module.exports = {
  validateNoIscustomizableFalseRows,
  COMPONENT_TYPE_TO_ENTITYSET,
  buildInFilter,
  chunk,
};
