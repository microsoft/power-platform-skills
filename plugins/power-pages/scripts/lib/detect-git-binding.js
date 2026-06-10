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
//   • Provided  → result is scoped to that solution; pendingChangesCount and
//     cleanState reflect THAT solution only.
//   • Omitted   → the helper enumerates every Git-bound solution on the env,
//     populates `boundSolutions[]`, sets `multipleSolutionsBound`, and the
//     top-level `pendingChangesCount` becomes the SUM across all bound
//     solutions (so `cleanState` is meaningful at env scope). When only one
//     solution is bound this is equivalent to scoping to that solution.
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

// HAR-confirmed 2026-06 (sri-alm-dev-1 tenant): many envs do NOT expose the
// `gitintegrations` entity. The binding state lives in two other entities
// instead. See references/inner-loop-empirical-findings.md §2.
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

  // 2. Read the per-(folder, branch) branch configs.
  const branchRes = await makeRequest({
    url: `${base}/api/data/v9.2/sourcecontrolbranchconfigurations?$select=branchname,rootfolderpath,branchsyncedcommitid,upstreambranchsyncedcommitid,statuscode`,
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

  // 4c. When no --solutionUniqueName was provided and we successfully
  //     enumerated bound solutions, expose the env-wide aggregate Clean/Dirty
  //     so the orchestrator can route without iterating per-solution itself.
  if (!solutionUniqueName && aggregatePendingComputed) {
    pendingChangesCount = aggregatePending;
  }

  // 5. Derive gitFolder = last segment of rootfolderpath, rootFolder = parent.
  const fullPath = row.rootfolderpath || '';
  const lastSlash = fullPath.lastIndexOf('/');
  const gitFolder = lastSlash >= 0 ? fullPath.substring(lastSlash + 1) : fullPath;
  const rootFolder = lastSlash >= 0 ? fullPath.substring(0, lastSlash) : '';

  return {
    bound: true,
    bindingType: solutionUniqueName ? 'solution' : (fullPath && fullPath.includes('/') ? 'solution' : 'environment'),
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
    cleanState: pendingChangesCount === 0 ? 'Clean' : (pendingChangesCount > 0 ? 'Dirty' : 'Unknown'),
    boundSolutions,
    multipleSolutionsBound,
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
