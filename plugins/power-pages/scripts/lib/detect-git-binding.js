#!/usr/bin/env node

// Detects whether the current Dataverse environment (or a specific solution)
// is bound to a Git repository via the Connect-to-Git feature.
//
// Returns the binding metadata or null (Disconnected). This is the first call
// every inner-loop skill makes in Phase 1 — the state machine entry point.
//
// Output (JSON to stdout):
//   Bound:
//     {
//       bound:                   true,
//       bindingType:             "environment" | "solution",
//       organization:            "<ADO org>",
//       project:                 "<ADO project>",
//       repository:              "<ADO repo>",
//       branch:                  "<branch name>",
//       gitFolder:               "<folder in repo>",
//       rootFolder:              "<root folder>" | null,     // solution binding only
//       solutionUniqueName:      "<name>"        | null,     // mirrors the input filter
//       branchSyncedCommitId:    "<sha>"         | null,     // last INBOUND sync from ADO
//       upstreamBranchSyncedCommitId: "<sha>"    | null,     // ADO HEAD at last sync
//       sourceControlSyncStatus: <int>           | null,     // per-solution sync status
//       enabledForSourceControlIntegration: <bool> | null,
//       pendingChangesCount:     <int>           | null,     // see notes below
//       nonCommittedRootCount:   <int>           | null,     // see notes below
//       cleanState:              "Clean" | "Dirty" | "Unknown",
//       boundSolutions: [                                    // ALL Git-bound solutions on env
//         { uniqueName, solutionId, pendingChangesCount, sourceControlSyncStatus }
//       ],
//       multipleSolutionsBound:  <bool>,
//       connectionStatus:        "<string>",
//       gitIntegrationId:        "<guid>",
//       detectedVia:             "sourcecontrol-entities" | "gitintegrations",
//     }
//   Not bound:
//     { bound: false }
//   Error:
//     { error: "<message>", statusCode?: <number> }
//
// Usage:
//   node detect-git-binding.js [--envUrl <url>] [--token <token>]
//                              [--solutionUniqueName <name>]
//
// --solutionUniqueName semantics:
//   • Provided  → result is scoped to that solution; `pendingChangesCount` and
//     `cleanState` reflect THAT solution only (direct count of
//     `sourcecontrolcomponents?$filter=iscommitted eq false and partitionid eq <sid>`,
//     which matches `list-pending-changes --solutionUniqueName <name>` exactly).
//     `nonCommittedRootCount` is the same value in this scoped case.
//   • Omitted   → the helper enumerates every Git-bound solution on the env,
//     populates `boundSolutions[]`, sets `multipleSolutionsBound`, and exposes
//     two distinct env-scope counters that historically reported the same
//     number but can diverge significantly:
//
//       pendingChangesCount      = direct env-wide query of
//                                  `sourcecontrolcomponents?$filter=iscommitted eq false`
//                                  (NO partitionid filter). Matches what
//                                  `list-pending-changes` returns without a
//                                  --solutionUniqueName filter. This is the
//                                  authoritative "is anything unflushed across
//                                  the env" signal, including rows whose owning
//                                  solution has `enabledforsourcecontrolintegration=false`
//                                  (e.g. solutions that were disconnected but
//                                  whose stale sourcecontrolcomponent rows still
//                                  exist).
//
//       nonCommittedRootCount    = SUM of per-solution `pendingChangesCount`
//                                  across the rows in `boundSolutions[]` (which
//                                  EXCLUDES `enabledforsourcecontrolintegration=false`
//                                  solutions). Useful for "how much will commit-to-git
//                                  actually flush" — i.e. the user-actionable subset.
//
//     Live evidence (observed during live testing 2026-06-11):
//       pendingChangesCount   = 344   (direct env-wide query)
//       nonCommittedRootCount = 2     (only the freshly-bound solution rows)
//     The 342-row gap was stale rows from a disconnected solution.
//
//     `cleanState` is derived from `pendingChangesCount` (the direct env-wide
//     signal) so a "Clean" answer means there are zero unflushed rows of any
//     kind, not just unflushed rows for currently-enabled solutions.
//
// Callers (e.g. plan-inner-loop Phase 2) SHOULD inspect `multipleSolutionsBound`
// and, if true, iterate `boundSolutions[]` to surface per-solution state to the
// user instead of treating the env as a single binding.
//
// TODO: HAR-verify — entity name `gitintegrations`, field names, and filter
// syntax against a real tenant before GA. Public docs reference the entity
// exists; exact schema confirmed via Microsoft Learn's "git-api" page but
// field-level coverage is incomplete.

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

// The Dataverse ConnectionType integer values from ConnectToGit action spec.
// TODO: HAR-verify these map correctly to what gitintegrations.connectiontype returns.
const CONNECTION_TYPE = Object.freeze({
  0: 'solution',
  1: 'environment',
});

// HAR-confirmed 2026-06: many tenants do NOT expose the `gitintegrations`
// entity. The binding state lives in two other entities instead.
// See references/inner-loop-empirical-findings.md §2.
//   - sourcecontrolconfigurations          (org/project/repository per env)
//   - sourcecontrolbranchconfigurations    (branch/rootfolderpath/synced-commit-id per solution-folder)
// Per-solution sync status is on `solutions` itself:
//   - enabledforsourcecontrolintegration   (bool)
//   - sourcecontrolsyncstatus              (int — 0 NotStarted / 1 InProgress / 3 Synced)
async function detectViaSourceControlEntities(tok, base, solutionUniqueName) {
  const hdr = {
    Authorization: `Bearer ${tok}`,
    'OData-MaxVersion': '4.0',
    'OData-Version': '4.0',
    Accept: 'application/json',
  };
  // 1. Read the env-level config (org/project/repo). Single row when bound.
  const cfgRes = await makeRequest({
    url: `${base}/api/data/v9.2/sourcecontrolconfigurations?$select=organizationname,projectname,repositoryname,gitprovider,sourcecontrolconfigurationid`,
    method: 'GET',
    headers: hdr,
  });
  if (cfgRes.statusCode === 404) {
    // Both entity models absent → genuinely not bound, OR Git integration is
    // not provisioned on this org (older Dataverse versions, BYOK, etc.).
    return {
      bound: false,
      hint: 'Neither gitintegrations nor sourcecontrolconfigurations is present — Git integration may not be enabled on this Managed Environment / Dataverse org version. See references/inner-loop-empirical-findings.md §2.',
    };
  }
  if (cfgRes.statusCode !== 200) {
    return { error: `sourcecontrolconfigurations HTTP ${cfgRes.statusCode}`, statusCode: cfgRes.statusCode };
  }
  let cfgRows;
  try { cfgRows = JSON.parse(cfgRes.body).value; } catch { return { error: 'Failed to parse sourcecontrolconfigurations response.' }; }
  if (!cfgRows || cfgRows.length === 0) return { bound: false };
  const cfg = cfgRows[0];

  // 2. Read the per-(folder, branch) branch configs. The `partitionid` column
  //    holds the solutionId this branch row belongs to (or the all-zeros GUID
  //    for env-level rows). E10: we need it to distinguish a live solution
  //    binding from a stale leftover row whose owning solution has been
  //    disconnected.
  const branchRes = await makeRequest({
    // NOTE: `partitionid` on `sourcecontrolbranchconfiguration` is a plain
    // UUID column, NOT a lookup. Requesting `_partitionid_value` returns
    // HTTP 400 "Could not find a property named '_partitionid_value'"
    // (verified 2026-06-11 on org5ba33a19/v9.2). Do NOT add it back to the
    // $select — the source-grep regression test in detect-git-binding.test.js
    // enforces this. The defensive read at partitionIdOf() below still tries
    // `r._partitionid_value` first to remain forward-compatible in the
    // hypothetical case some tenant exposes it as a lookup; that path is
    // dead in current Dataverse but costs nothing.
    url: `${base}/api/data/v9.2/sourcecontrolbranchconfigurations?$select=branchname,rootfolderpath,branchsyncedcommitid,upstreambranchsyncedcommitid,statuscode,partitionid`,
    method: 'GET',
    headers: hdr,
  });
  if (branchRes.statusCode !== 200) {
    return { error: `sourcecontrolbranchconfigurations HTTP ${branchRes.statusCode}`, statusCode: branchRes.statusCode };
  }
  let branchRows;
  try { branchRows = JSON.parse(branchRes.body).value; } catch { return { error: 'Failed to parse branch configs response.' }; }
  if (!branchRows || branchRows.length === 0) {
    // Config exists but no branch row — partial bind / Broken
    return { bound: false, hint: 'sourcecontrolconfiguration exists but no sourcecontrolbranchconfigurations rows — partial bind state.' };
  }

  // 3. Pick the right branch row.
  //    - With --solutionUniqueName: find a row whose rootfolderpath ends with `/<sol>`.
  //    - Without: prefer the first row whose rootfolderpath looks like a solution folder
  //      (i.e. contains a `/`), falling back to row[0].
  let row;
  if (solutionUniqueName) {
    row = branchRows.find((r) => r.rootfolderpath && r.rootfolderpath.endsWith('/' + solutionUniqueName));
    if (!row) {
      // Probably bound but to a different folder name. Return env config so caller can decide.
      row = branchRows[0];
    }
  } else {
    row = branchRows.find((r) => r.rootfolderpath && r.rootfolderpath.includes('/')) || branchRows[0];
  }

  // 4. If --solutionUniqueName provided, also confirm the solution flag is set
  //    and count REAL pending changes from sourcecontrolcomponent.
  //    (HAR 2026-06 §3+§8+§10: the branch-config commit columns track INBOUND
  //    sync only — they do NOT reflect outbound pending pushes. The real
  //    "Dirty" signal is sourcecontrolcomponent rows with iscommitted=false.)
  let solRow = null;
  let pendingChangesCount = null;
  if (solutionUniqueName) {
    const solRes = await makeRequest({
      url: `${base}/api/data/v9.2/solutions?$select=solutionid,uniquename,enabledforsourcecontrolintegration,sourcecontrolsyncstatus&$filter=uniquename eq '${encodeURIComponent(solutionUniqueName)}'`,
      method: 'GET',
      headers: hdr,
    });
    if (solRes.statusCode === 200) {
      try { solRow = (JSON.parse(solRes.body).value || [])[0] || null; } catch { /* leave null */ }
    }
    if (solRow && solRow.solutionid) {
      const filter = `partitionid eq ${solRow.solutionid} and iscommitted eq false`;
      const pendRes = await makeRequest({
        url: `${base}/api/data/v9.2/sourcecontrolcomponents?$filter=${encodeURIComponent(filter)}&$count=true&$top=1`,
        method: 'GET',
        headers: { ...hdr, Prefer: 'odata.include-annotations="*"' },
      });
      if (pendRes.statusCode === 200) {
        try {
          const p = JSON.parse(pendRes.body);
          pendingChangesCount = typeof p['@odata.count'] === 'number' ? p['@odata.count'] : null;
        } catch { /* leave null */ }
      }
    }
  }

  // 4b. ALWAYS enumerate Git-bound solutions on the env, even when no
  //     --solutionUniqueName filter was provided. This lets callers
  //     (especially plan-inner-loop) know whether multiple solutions are
  //     bound and reach a meaningful Clean/Dirty answer at env scope.
  //     Without this, a multi-solution-bound env returns cleanState='Unknown'
  //     because the per-solution count cannot be computed from a single
  //     branch-config row. See references/inner-loop-empirical-findings.md §13.
  let boundSolutions = [];
  let multipleSolutionsBound = false;
  let aggregatePending = 0;
  let aggregatePendingComputed = false;
  try {
    const allSolRes = await makeRequest({
      url: `${base}/api/data/v9.2/solutions?$select=solutionid,uniquename,enabledforsourcecontrolintegration,sourcecontrolsyncstatus&$filter=enabledforsourcecontrolintegration eq true`,
      method: 'GET',
      headers: hdr,
    });
    if (allSolRes.statusCode === 200) {
      const allRows = (JSON.parse(allSolRes.body).value || []);
      multipleSolutionsBound = allRows.length > 1;
      for (const s of allRows) {
        let pc = null;
        // Reuse the count we already fetched when --solutionUniqueName matched.
        if (solutionUniqueName && solRow && s.solutionid === solRow.solutionid && typeof pendingChangesCount === 'number') {
          pc = pendingChangesCount;
        } else {
          const filter = `partitionid eq ${s.solutionid} and iscommitted eq false`;
          const pr = await makeRequest({
            url: `${base}/api/data/v9.2/sourcecontrolcomponents?$filter=${encodeURIComponent(filter)}&$count=true&$top=1`,
            method: 'GET',
            headers: { ...hdr, Prefer: 'odata.include-annotations="*"' },
          });
          if (pr.statusCode === 200) {
            try {
              const p = JSON.parse(pr.body);
              pc = typeof p['@odata.count'] === 'number' ? p['@odata.count'] : null;
            } catch { /* leave null */ }
          }
        }
        boundSolutions.push({
          uniqueName: s.uniquename,
          solutionId: s.solutionid,
          pendingChangesCount: pc,
          sourceControlSyncStatus: s.sourcecontrolsyncstatus != null ? s.sourcecontrolsyncstatus : null,
        });
        if (typeof pc === 'number') { aggregatePending += pc; aggregatePendingComputed = true; }
      }
    }
  } catch (_) { /* swallow — boundSolutions stays [] */ }

  // 4c. When no --solutionUniqueName was provided, expose TWO distinct env-scope
  //     counters because they can diverge (see header docstring "live evidence"):
  //
  //       pendingChangesCount   — direct env-wide query of sourcecontrolcomponents
  //                               (no partitionid filter). Includes rows whose
  //                               owning solution has enabledforsourcecontrolintegration=false.
  //                               Matches list-pending-changes' unfiltered count.
  //
  //       nonCommittedRootCount — SUM of per-solution pendingChangesCount across
  //                               boundSolutions[] (which excludes disabled solutions).
  //
  //     When --solutionUniqueName WAS provided, both fields are the same per-solution
  //     direct count already computed above.
  let nonCommittedRootCount = null;
  if (solutionUniqueName) {
    // Scoped case: per-solution count is authoritative for both fields.
    nonCommittedRootCount = pendingChangesCount;
  } else {
    if (aggregatePendingComputed) {
      nonCommittedRootCount = aggregatePending;
    }
    // Direct env-wide query — matches list-pending-changes without a filter.
    // This is the field that should drive `cleanState` because it sees stale
    // rows from disconnected solutions that the aggregate would miss.
    try {
      const envPendRes = await makeRequest({
        url: `${base}/api/data/v9.2/sourcecontrolcomponents?$filter=${encodeURIComponent('iscommitted eq false')}&$count=true&$top=1`,
        method: 'GET',
        headers: { ...hdr, Prefer: 'odata.include-annotations="*"' },
      });
      if (envPendRes.statusCode === 200) {
        try {
          const p = JSON.parse(envPendRes.body);
          pendingChangesCount = typeof p['@odata.count'] === 'number' ? p['@odata.count'] : null;
        } catch { /* leave null */ }
      }
    } catch (_) { /* leave null — defensive */ }
  }

  // 5. Derive gitFolder = last segment of rootfolderpath, rootFolder = parent.
  const fullPath = row.rootfolderpath || '';
  const lastSlash = fullPath.lastIndexOf('/');
  const gitFolder = lastSlash >= 0 ? fullPath.substring(lastSlash + 1) : fullPath;
  const rootFolder = lastSlash >= 0 ? fullPath.substring(0, lastSlash) : '';

  // 6. E10: Disambiguate bindingType by reconciling each branchconfig row's
  //    `partitionid` against the live solutions enumeration.
  //
  //    The legacy heuristic was: `bindingType: 'solution'` iff rootfolderpath
  //    contains a `/`. That heuristic flips to `solution` for STALE
  //    branchconfig rows whose owning solution has been disconnected — the
  //    row's rootfolderpath is still `solutions/Foo` even though no row in
  //    `solutions` has `solutionid === <Foo-id>` any more (and even if such
  //    a row exists, it may have `enabledforsourcecontrolintegration=false`).
  //
  //    Live evidence (observed during live testing 2026-06-11): a fresh
  //    solution bind produced `newBranchConfigsCreated=2` — one for the
  //    env-level row (partitionid all-zeros), one for the per-solution
  //    row (partitionid=<solutionId>). A naive caller iterating
  //    `branchRows[0]` could see the wrong row first.
  //
  //    Rule:
  //      bindingType = 'solution'
  //        iff some branchconfig row has a NON-ZERO partitionid AND that
  //        solutionid appears in `boundSolutions[]` (which itself filtered
  //        on `enabledforsourcecontrolintegration eq true`).
  //      bindingType = 'environment'
  //        iff the surviving (non-stale) branchconfig is the env-level one
  //        (partitionid = all-zeros OR no rootfolderpath /).
  //      Otherwise fall back to the legacy path heuristic (preserve back-compat
  //      on tenants where partitionid is not exposed for some reason).
  const ZERO_GUID = '00000000-0000-0000-0000-000000000000';
  const boundIds = new Set(boundSolutions.map((s) => (s.solutionId || '').toLowerCase()));
  const partitionIdOf = (r) =>
    (r._partitionid_value || r.partitionid || '').toString().toLowerCase();
  const isStale = (r) => {
    const pid = partitionIdOf(r);
    // Unknown partitionid (older Dataverse versions): can't tell — not stale, not live.
    if (!pid) return false;
    // Env-level rows (zero-guid partition) are NOT stale — they're the env config row.
    if (pid === ZERO_GUID) return false;
    // Solution-scoped rows are stale when their partition doesn't match a live, enabled solution.
    return !boundIds.has(pid);
  };
  const staleBranchConfigs = branchRows.filter(isStale).map((r) => ({
    partitionId: partitionIdOf(r) || null,
    rootFolderPath: r.rootfolderpath || null,
    branchName: r.branchname || null,
    reason: 'partitionId does not match any enabled solution row (sourcecontrolbranchconfigurations row may be leftover from a disconnected solution)',
  }));
  const liveSolutionRow = branchRows.find((r) => {
    const pid = partitionIdOf(r);
    return pid && pid !== ZERO_GUID && boundIds.has(pid);
  });
  // Only treat ALL-ZEROS partitionid as definitively env-level. Empty/missing
  // partitionid (older Dataverse versions) means "unknown" — fall through to
  // the legacy path heuristic instead of assuming env-level.
  const liveEnvRow = branchRows.find((r) => partitionIdOf(r) === ZERO_GUID);
  // "Tenant exposes partitionid" iff at least one branchRow has a non-empty
  // partition value. When true, we use strict disambiguation; when false
  // (older Dataverse), we fall back to the legacy path heuristic for
  // back-compat.
  const partitionIdExposed = branchRows.some((r) => !!partitionIdOf(r));
  let bindingType;
  if (solutionUniqueName) {
    bindingType = 'solution';
  } else if (liveSolutionRow) {
    bindingType = 'solution';
  } else if (liveEnvRow) {
    bindingType = 'environment';
  } else if (partitionIdExposed) {
    // Tenant DOES expose partitionid, but no row matches a live enabled
    // solution AND no row is the env-level zero-guid row. The remaining
    // rows must all be stale → don't promote them to 'solution' or
    // 'environment'; report 'environment' as the conservative default
    // (the env CONFIG exists but no live binding owns it). This is what
    // happens when every Git-bound solution has been disconnected but
    // the sourcecontrolbranchconfigurations rows haven't been GC'd.
    bindingType = 'environment';
  } else {
    // Tenant does NOT expose partitionid → fall back to legacy path heuristic.
    bindingType = (fullPath && fullPath.includes('/')) ? 'solution' : 'environment';
  }

  return {
    bound: true,
    bindingType,
    organization: cfg.organizationname || null,
    project: cfg.projectname || null,
    repository: cfg.repositoryname || null,
    branch: row.branchname || null,
    gitFolder: gitFolder || null,
    rootFolder: rootFolder || null,
    solutionUniqueName: solutionUniqueName || null,
    branchSyncedCommitId: row.branchsyncedcommitid || null,
    upstreamBranchSyncedCommitId: row.upstreambranchsyncedcommitid || null,
    sourceControlSyncStatus: solRow ? solRow.sourcecontrolsyncstatus : null,
    enabledForSourceControlIntegration: solRow ? solRow.enabledforsourcecontrolintegration : null,
    pendingChangesCount,
    nonCommittedRootCount,
    cleanState: pendingChangesCount === 0 ? 'Clean' : (pendingChangesCount > 0 ? 'Dirty' : 'Unknown'),
    boundSolutions,
    multipleSolutionsBound,
    staleBranchConfigs,
    connectionStatus: String(row.statuscode != null ? row.statuscode : ''),
    gitIntegrationId: cfg.sourcecontrolconfigurationid || null,
    detectedVia: 'sourcecontrol-entities',
  };
}

/**
 * Detects the Git binding for an environment (or solution).
 *
 * @param {object} options
 * @param {string} [options.envUrl]              Dataverse env URL (auto from PAC CLI if omitted)
 * @param {string} [options.token]               Bearer token (auto from Azure CLI if omitted)
 * @param {string} [options.solutionUniqueName]  Filter to a specific solution binding
 * @returns {Promise<object>}                    Binding object, { bound: false }, or { error }
 */
async function detectGitBinding({ envUrl, token, solutionUniqueName } = {}) {
  const url = envUrl || getEnvironmentUrl();
  if (!url) return { error: 'Could not determine environment URL. Run `pac env who` or pass --envUrl.' };

  const tok = token || getAuthToken(url);
  if (!tok) return { error: 'Could not acquire an auth token. Run `az login` or pass --token.' };

  const base = url.replace(/\/+$/, '');

  // TODO: HAR-verify — `gitintegrations` is the Dataverse entity that stores
  // binding state. Field names (connectiontype, organizationname, etc.) sourced
  // from the MS Learn "Connect and disconnect by using code" article and the
  // ConnectToGit action reference. Verify against a real tenant before GA.
  let filterExpr = '';
  if (solutionUniqueName) {
    // Solution binding: only look for rows with the matching solutionuniquename.
    // The platform stores each solution binding as a separate row.
    filterExpr = `&$filter=solutionuniquename eq '${solutionUniqueName}'`;
  }
  // Without a solution filter, get all binding rows. For env binding there
  // should be exactly one row; for solution binding there may be multiple.
  const apiUrl =
    `${base}/api/data/v9.2/gitintegrations` +
    `?$select=gitintegrationid,connectiontype,organizationname,projectname,` +
    `repositoryname,branchname,gitfolder,rootfolder,solutionuniquename,connectionstatus` +
    filterExpr;

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
    // HAR-confirmed 2026-06: many tenants don't have `gitintegrations` — the
    // binding lives in sourcecontrolconfigurations + sourcecontrolbranchconfigurations
    // instead. Try the fallback path before giving up.
    // See references/inner-loop-empirical-findings.md §2.
    const fallback = await detectViaSourceControlEntities(tok, base, solutionUniqueName);
    return fallback;
  }
  if (res.statusCode !== 200) {
    let errMsg = `HTTP ${res.statusCode}`;
    try { errMsg = JSON.parse(res.body).error.message || errMsg; } catch { /* keep raw */ }
    return { error: errMsg, statusCode: res.statusCode };
  }

  let rows;
  try {
    rows = JSON.parse(res.body).value;
  } catch (e) {
    return { error: 'Failed to parse gitintegrations response: ' + e.message };
  }

  if (!rows || rows.length === 0) return { bound: false };

  // When env-binding is active there is exactly one row (connectiontype=1).
  // When solution binding is used there may be multiple rows (connectiontype=0),
  // one per bound solution. Surface ALL rows in `boundSolutions[]` so callers
  // (e.g. switch-branch) can detect ambiguous multi-binding state — this is
  // consistent with the sourcecontrol-entities fallback path, which always
  // populates `boundSolutions[]`.
  const row = rows[0];
  const isSolutionBinding = CONNECTION_TYPE[row.connectiontype] === 'solution';
  const boundSolutionsLegacy = isSolutionBinding
    ? rows
      .filter((r) => CONNECTION_TYPE[r.connectiontype] === 'solution' && r.solutionuniquename)
      .map((r) => ({
        uniqueName: r.solutionuniquename,
        solutionId: null,
        pendingChangesCount: null,
        sourceControlSyncStatus: null,
      }))
    : [];
  return {
    bound: true,
    bindingType: CONNECTION_TYPE[row.connectiontype] || String(row.connectiontype),
    organization: row.organizationname || null,
    project: row.projectname || null,
    repository: row.repositoryname || null,
    branch: row.branchname || null,
    gitFolder: row.gitfolder || null,
    rootFolder: row.rootfolder || null,
    solutionUniqueName: row.solutionuniquename || null,
    connectionStatus: row.connectionstatus || null,
    gitIntegrationId: row.gitintegrationid || null,
    boundSolutions: boundSolutionsLegacy,
    multipleSolutionsBound: boundSolutionsLegacy.length > 1,
  };
}

if (require.main === module) {
  const args = parseArgs(process.argv);
  detectGitBinding(args)
    .then((r) => { process.stdout.write(JSON.stringify(r, null, 2) + '\n'); })
    .catch((e) => {
      process.stderr.write('detect-git-binding: ' + e.message + '\n');
      process.exit(1);
    });
}

module.exports = { detectGitBinding, CONNECTION_TYPE };
