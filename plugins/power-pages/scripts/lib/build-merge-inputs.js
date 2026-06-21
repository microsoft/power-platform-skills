#!/usr/bin/env node

// Assembles the 3-way merge inputs (BASE / OURS / THEIRS) for each conflicted
// Power Pages component field — the data-layer core of the selective-merge flow.
// Emits a merge manifest that the companion VS Code extension consumes.
//
// For each conflict it:
//   1. Reads OURS (live Dataverse content field) via read-component-content.js.
//      Non-text strategies (binary web files, scalar settings) are routed to the
//      existing binary keep/accept flow — NOT to the merge editor.
//   2. Resolves the component's ADO source-file path via map-component-to-git-path.js.
//   3. Fetches THEIRS (branch tip) and BASE (upstreamBranchSyncedCommitId) via
//      ado-get-file.js. A 404 on BASE means add/add (empty base, 2-way merge);
//      a 404 on THEIRS means deleted-in-git (route to delete/modify, not text merge).
//
// OURS (plain text from the JSON `content` envelope) and THEIRS/BASE (standalone
// ADO source files) are already plain text, so they drop straight into a 3-way
// merge with no extra normalization beyond the envelope extraction.
//
// Output (JSON to stdout): the merge manifest
//   {
//     runId, generatedAt, binding: {...},
//     components: [
//       {
//         conflictId, componentId, name, type, typeLabel, mergeStrategy,
//         routedTo: "selective-merge" | "binary-keep-accept",
//         units: [
//           { field, adoPath, resolvedVia, status,
//             base:   { present, content },
//             ours:   { content },
//             theirs: { present, content } }
//         ],
//         note?
//       }
//     ],
//     summary: { total, selectiveMerge, binaryKeepAccept, deletedInGit, identical }
//   }
//
// Unit `status` values:
//   mergeable        — all three sides present and OURS != THEIRS (a real merge)
//   add-add          — BASE absent (component added on both sides); 2-way merge
//   deleted-in-git   — THEIRS absent; route to delete/modify sub-case
//   identical        — OURS == THEIRS; nothing to merge for this field
//   path-unresolved  — could not map the component to an ADO file; fall back to binary
//
// Usage:
//   node build-merge-inputs.js
//     --conflictsFile <path>     // JSON array of { conflictId?, componentId?, componentType, componentName }
//     --bindingFile   <path>     // detect-git-binding.js output (+ siteName)
//     [--siteName <name>]        // powerpagesite folder name (overrides binding)
//     [--runId <id>] [--token <dvToken>] [--envUrl <url>]
//     [--organization <o> --project <p> --repository <r>]  // overrides binding

'use strict';

const fs = require('fs');
const crypto = require('crypto');

// Big-file guard (Wave 3 #2): above these, a field is routed to binary keep/accept
// instead of an inline 3-way merge (protects O(n·m) time + the ADO 17 MB push cap).
const MAX_MERGE_BYTES = 1_500_000; // 1.5 MB per side
const MAX_MERGE_LINES = 20_000;

const defaultDeps = {
  readComponentContent: require('./read-component-content').readComponentContent,
  resolveSourceFilePath: require('./map-component-to-git-path').resolveSourceFilePath,
  buildPathFromComponentPath: require('./map-component-to-git-path').buildPathFromComponentPath,
  getFile: require('./ado-get-file').getFile,
  scoreConflictRisk: require('./score-conflict-risk').scoreConflictRisk,
};

/** Normalize line endings for an EOL-insensitive equality check. */
function eolNormalize(s) {
  return typeof s === 'string' ? s.replace(/\r\n/g, '\n') : s;
}

/**
 * Assemble the merge unit(s) for a single conflicted component.
 *
 * @param {object} args
 * @param {object} args.conflict   { conflictId?, componentId?, componentType, componentName }
 * @param {object} args.binding    { organization, project, repository, branch,
 *                                   upstreamBranchSyncedCommitId, rootFolder, gitFolder, siteName }
 * @param {string} [args.envUrl]
 * @param {string} [args.dvToken]
 * @param {string} [args.adoToken]
 * @param {object} [args.deps]     DI for the three helpers (tests).
 * @returns {Promise<object>}      One manifest component entry.
 */
async function buildComponentMergeUnit({ conflict, binding, envUrl, dvToken, adoToken, deps = defaultDeps } = {}) {
  const { readComponentContent, resolveSourceFilePath, buildPathFromComponentPath, getFile, scoreConflictRisk } = deps;
  const type = conflict.componentType;
  const name = conflict.componentName;

  // Risk score (Wave 4 #4) — SECURITY gate, not AI. A 'binary-only' (critical:
  // auth/secret/credential) component is forced off the selective-merge path even
  // if it has text fields, so its source is never inline-merged or written to scratch.
  const risk = typeof scoreConflictRisk === 'function'
    ? scoreConflictRisk({ componentType: type, componentName: name, componentPath: conflict.componentPath, field: conflict.field })
    : null;

  // 1) OURS — live Dataverse field(s).
  const ours = await readComponentContent({
    envUrl, token: dvToken,
    componentId: conflict.componentId || null,
    componentType: conflict.componentId ? null : type,
    name: conflict.componentId ? null : name,
    siteId: binding.siteId || null,
  });

  const baseEntry = {
    conflictId: conflict.conflictId || null,
    componentId: ours && ours.id ? ours.id : (conflict.componentId || null),
    name: ours && ours.name ? ours.name : name,
    type,
    typeLabel: ours ? ours.typeLabel : undefined,
  };

  if (ours && ours.error) {
    return { ...baseEntry, mergeStrategy: 'unknown', routedTo: 'binary-keep-accept', units: [], note: `Could not read OURS: ${ours.error}` };
  }

  // Non-text components (web files, scalar settings) → binary keep/accept.
  if (!ours || ours.mergeStrategy !== 'text' || ours.mergeFields.length === 0) {
    return {
      ...baseEntry,
      mergeStrategy: ours ? ours.mergeStrategy : 'binary',
      routedTo: 'binary-keep-accept',
      units: [],
      note: 'Not a text component; resolve with keep current / accept incoming.',
    };
  }

  // 2+3) For each text field, resolve the ADO path and fetch THEIRS + BASE.
  // IMPORTANT: use the actual powerpagecomponent type + clean name from the OURS
  // read for PATH RESOLUTION, NOT conflict.componentType/componentName. The conflict
  // roster (sourcecontrolcomponent) reports componenttype=10429 (the SOLUTION
  // component type) and a suffixed display name (e.g. "Search Results.webtemplate"),
  // neither of which the ADO path mapper understands — it needs type 8/7/2 and the
  // bare name ("Search Results"). Verified live 2026-06-19 on sri-alm-dev-1: passing
  // 10429 made every text conflict resolve as `path-unresolved`. (ours.type is the
  // real powerpagecomponenttype; ours.name is the unsuffixed component name.)
  const pathType = (ours && ours.type != null) ? ours.type : type;
  const pathName = (ours && ours.name) ? ours.name : name;
  const units = [];
  for (const field of ours.mergeFields) {
    if (!field.isText) {
      // scalar field inside an otherwise-text component → keep/accept
      units.push({ field: field.key, status: 'identical', adoPath: null, note: 'Scalar field; keep/accept.' });
      continue;
    }

    // Resolve the ADO source-file path. PREFER the conflict row's componentpath
    // (authoritative, from Dataverse — deterministic, no ADO listing). Fall back
    // to the slug-listing resolver only when componentpath is unavailable.
    let mapped = null;
    if (conflict.componentPath && typeof buildPathFromComponentPath === 'function') {
      const built = buildPathFromComponentPath({
        componentPath: conflict.componentPath, type: pathType, field: field.key,
        rootFolder: binding.rootFolder, gitFolder: binding.gitFolder,
      });
      if (built && built.path) mapped = built;
    }
    if (!mapped) {
      mapped = await resolveSourceFilePath({
        type: pathType, name: pathName, field: field.key,
        rootFolder: binding.rootFolder, gitFolder: binding.gitFolder, siteName: binding.siteName,
        branch: binding.branch,
        organization: binding.organization, project: binding.project, repository: binding.repository,
        token: adoToken,
      });
    }

    if (mapped.supported === false || !mapped.path) {
      units.push({ field: field.key, status: 'path-unresolved', adoPath: null, ours: { content: field.value },
        note: mapped.reason || 'Could not map component to an ADO source file.' });
      continue;
    }

    // Fetch THEIRS (branch tip) and BASE (ancestor commit) CONCURRENTLY — they are
    // independent reads (Wave 3 #4: was sequential). BASE tries
    // upstreamBranchSyncedCommitId first, then falls back to branchSyncedCommitId —
    // the two can diverge, and on some bindings the upstream commit doesn't contain
    // the file (404) while the branch-synced commit does. Only a genuine absence on
    // BOTH is treated as add/add (empty base).
    const fetchTheirs = () => getFile({
      organization: binding.organization, project: binding.project, repository: binding.repository,
      path: mapped.path, version: binding.branch, versionType: 'branch', token: adoToken,
    });
    const fetchBase = async () => {
      let b = { found: false };
      const baseCommits = [binding.upstreamBranchSyncedCommitId, binding.branchSyncedCommitId].filter(Boolean);
      for (const sha of baseCommits) {
        // eslint-disable-next-line no-await-in-loop
        b = await getFile({
          organization: binding.organization, project: binding.project, repository: binding.repository,
          path: mapped.path, version: sha, versionType: 'commit', token: adoToken,
        });
        if (b && b.found) break;
      }
      return b;
    };
    const [theirs, base] = await Promise.all([fetchTheirs(), fetchBase()]);

    const oursContent = field.value;
    const theirsPresent = theirs && theirs.found === true;
    const basePresent = base && base.found === true;

    // Big-file guard (Wave 3 #2): inline 3-way merge is O(n·m) time; an oversized
    // field (e.g. a giant generated template) would be slow even with linear-space
    // LCS, and risks the ADO 17 MB push cap. Above the threshold we don't attempt an
    // inline merge — route to binary keep/accept so the maker still resolves it.
    const sideLen = (s) => (typeof s === 'string' ? s.length : 0);
    const sideLines = (s) => (typeof s === 'string' ? (s.match(/\n/g) || []).length + 1 : 0);
    const maxBytes = Math.max(sideLen(oursContent), theirsPresent ? sideLen(theirs.content) : 0, basePresent ? sideLen(base.content) : 0);
    const maxLines = Math.max(sideLines(oursContent), theirsPresent ? sideLines(theirs.content) : 0, basePresent ? sideLines(base.content) : 0);
    const tooLarge = maxBytes > MAX_MERGE_BYTES || maxLines > MAX_MERGE_LINES;

    let status;
    if (tooLarge) {
      status = 'too-large';
    } else if (!theirsPresent) {
      status = 'deleted-in-git';
    } else if (eolNormalize(oursContent) === eolNormalize(theirs.content)) {
      status = 'identical';
    } else if (!basePresent) {
      status = 'add-add';
    } else {
      status = 'mergeable';
    }

    units.push({
      field: field.key,
      adoPath: mapped.path,
      resolvedVia: mapped.resolvedVia,
      status,
      ...(tooLarge ? { note: `Field too large to merge inline (${maxBytes} bytes / ${maxLines} lines > ${MAX_MERGE_BYTES}/${MAX_MERGE_LINES}); resolve with keep current / accept incoming.` } : {}),
      base: { present: basePresent, content: basePresent ? base.content : null },
      ours: { content: oursContent },
      theirs: { present: theirsPresent, content: theirsPresent ? theirs.content : null },
    });
  }

  const anyMergeable = units.some((u) => u.status === 'mergeable' || u.status === 'add-add');
  const anyDeleted = units.some((u) => u.status === 'deleted-in-git');
  const anyTooLarge = units.some((u) => u.status === 'too-large');
  // Route to selective-merge ONLY when there is a real text merge to do. Without
  // any mergeable/add-add unit (identical-only, deleted-only, path-unresolved-only,
  // too-large-only), route to binary keep/accept so the component is never silently
  // dropped by the workspace materializer. Mixed components (some mergeable + some
  // deleted/too-large) stay selective-merge; their non-mergeable units surface as
  // the workspace's deferredUnits.
  const routedTo = (anyMergeable && !(risk && risk.recommendedGate === 'binary-only')) ? 'selective-merge' : 'binary-keep-accept';
  let note;
  if (risk && risk.recommendedGate === 'binary-only' && anyMergeable) note = `Security-sensitive (${risk.level}); resolve binary (keep current / accept incoming) — not inline-merged.`;
  else if (anyDeleted) note = 'One or more fields deleted in Git; review delete vs keep.';
  else if (anyTooLarge && !anyMergeable) note = 'Field too large to merge inline; resolve with keep current / accept incoming.';
  else if (!anyMergeable) note = 'No text-mergeable field change; resolve with keep current / accept incoming.';
  return {
    ...baseEntry,
    mergeStrategy: 'text',
    routedTo,
    units,
    ...(risk ? { risk } : {}),
    ...(note ? { note } : {}),
  };
}

/** Map items through an async fn with bounded concurrency, preserving order. */
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = new Array(Math.min(limit, items.length || 1)).fill(0).map(async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

const COMPONENT_CONCURRENCY = 4;

/**
 * Build the full merge manifest across a list of conflicts.
 * @returns {Promise<object>} manifest
 */
async function buildMergeInputs({ conflicts, binding, envUrl, dvToken, adoToken, runId, deps = defaultDeps } = {}) {
  if (!Array.isArray(conflicts)) throw new Error('conflicts must be an array');
  if (!binding || typeof binding !== 'object') throw new Error('binding is required');

  // Process components with bounded concurrency (Wave 3 #4) — each does several
  // independent Dataverse/ADO reads; a small pool keeps the pipeline fast without
  // hammering the services. Output order is preserved.
  const components = await mapWithConcurrency(conflicts, COMPONENT_CONCURRENCY, (conflict) =>
    buildComponentMergeUnit({ conflict, binding, envUrl, dvToken, adoToken, deps }));

  const summary = {
    total: components.length,
    selectiveMerge: components.filter((c) => c.routedTo === 'selective-merge').length,
    binaryKeepAccept: components.filter((c) => c.routedTo === 'binary-keep-accept').length,
    deletedInGit: components.filter((c) => (c.units || []).some((u) => u.status === 'deleted-in-git')).length,
    identical: components.filter((c) => (c.units || []).length > 0 && (c.units || []).every((u) => u.status === 'identical')).length,
  };

  return {
    runId: runId || crypto.randomUUID(),
    generatedAt: new Date().toISOString(),
    binding: {
      organization: binding.organization, project: binding.project, repository: binding.repository,
      branch: binding.branch, rootFolder: binding.rootFolder, gitFolder: binding.gitFolder,
      siteName: binding.siteName,
      upstreamBranchSyncedCommitId: binding.upstreamBranchSyncedCommitId || null,
      branchSyncedCommitId: binding.branchSyncedCommitId || null,
    },
    components,
    summary,
  };
}

function parseArgs(argv) {
  const a = argv.slice(2);
  const o = { conflictsFile: null, bindingFile: null, siteName: null, runId: null, token: null, envUrl: null,
    organization: null, project: null, repository: null };
  for (let i = 0; i < a.length; i++) {
    const n = a[i + 1];
    if (a[i] === '--conflictsFile' && n) o.conflictsFile = a[++i];
    else if (a[i] === '--bindingFile' && n) o.bindingFile = a[++i];
    else if (a[i] === '--siteName' && n) o.siteName = a[++i];
    else if (a[i] === '--runId' && n) o.runId = a[++i];
    else if (a[i] === '--token' && n) o.token = a[++i];
    else if (a[i] === '--envUrl' && n) o.envUrl = a[++i];
    else if (a[i] === '--organization' && n) o.organization = a[++i];
    else if (a[i] === '--project' && n) o.project = a[++i];
    else if (a[i] === '--repository' && n) o.repository = a[++i];
  }
  return o;
}

if (require.main === module) {
  const args = parseArgs(process.argv);
  (async () => {
    const conflicts = JSON.parse(fs.readFileSync(args.conflictsFile, 'utf8'));
    const binding = JSON.parse(fs.readFileSync(args.bindingFile, 'utf8'));
    if (args.siteName) binding.siteName = args.siteName;
    if (args.organization) binding.organization = args.organization;
    if (args.project) binding.project = args.project;
    if (args.repository) binding.repository = args.repository;
    const manifest = await buildMergeInputs({ conflicts, binding, envUrl: args.envUrl, dvToken: args.token, runId: args.runId });
    process.stdout.write(JSON.stringify(manifest, null, 2) + '\n');
  })().catch((e) => { process.stderr.write('build-merge-inputs: ' + e.message + '\n'); process.exit(1); });
}

module.exports = { buildMergeInputs, buildComponentMergeUnit, eolNormalize, MAX_MERGE_BYTES, MAX_MERGE_LINES };
