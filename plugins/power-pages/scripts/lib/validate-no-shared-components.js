#!/usr/bin/env node

// Validates that no component in the target Git-bound solution is ALSO a
// member of another Git-bound solution. The Dataverse SourceControl plugin
// rejects shared-component commits with:
//   { code: '0x80040216',
//     message: 'Shared components are not supported' }
//
// Worse, the error names ONE component at a time — users hit it N times
// sequentially. This pre-flight enumerates every overlap at once.
//
// Strategy:
//   1. List all Git-bound solutions: solutions?$filter=isgitintegrationenabled eq true
//      (with fallback to enabledforsourcecontrolintegration eq true if the
//      former is unrecognised on this tenant).
//   2. For the target solution, list its solutioncomponents (objectid set).
//   3. For each other Git-bound solution, list its solutioncomponents and
//      intersect with the target's set.
//   4. Each overlap → BLOCKER finding citing the other solution's uniquename.
//
// Performance guard: skip the intersection (emit info-only finding) if either
//   - there are > maxOtherSolutions other bound solutions (default 5), OR
//   - the target solution itself has > maxTargetComponents components (default 5000)
// Tunable via --max-other-solutions and --max-target-components.
//
// Output (JSON to stdout):
//   {
//     ok: bool,
//     totalChecked: int,             // number of solutioncomponents rows compared
//     blocking: [
//       {
//         severity: 'blocker',
//         key: 'shared-component',
//         message: 'Component <objectid> (<componenttype>) is also in solution <other>.',
//         ref: 'IL-009',
//         details: {
//           objectId, componentType,
//           otherSolutionUniqueName, otherSolutionId,
//         },
//         remediation: 'Remove the component from one of the two solutions, then re-run.',
//       },
//       ...
//     ],
//     warnings: [],
//     info: [],
//     scope: { solutionUniqueName, solutionId },
//     boundSolutions: [ { uniqueName, id } ],
//   }
//
// Usage:
//   node validate-no-shared-components.js
//       --solutionUniqueName <name>     // REQUIRED; this validator is solution-scoped
//       [--envUrl <url>] [--token <token>]
//       [--max-other-solutions <n>]     // default 5
//       [--max-target-components <n>]   // default 5000

'use strict';

const { getAuthToken, getEnvironmentUrl, makeRequest } = require('./validation-helpers');

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = {
    envUrl: null, token: null,
    solutionUniqueName: null,
    maxOtherSolutions: 5,
    maxTargetComponents: 5000,
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--envUrl' && args[i + 1]) out.envUrl = args[++i];
    else if (args[i] === '--token' && args[i + 1]) out.token = args[++i];
    else if (args[i] === '--solutionUniqueName' && args[i + 1]) out.solutionUniqueName = args[++i];
    else if (args[i] === '--max-other-solutions' && args[i + 1]) out.maxOtherSolutions = parseInt(args[++i], 10);
    else if (args[i] === '--max-target-components' && args[i + 1]) out.maxTargetComponents = parseInt(args[++i], 10);
  }
  return out;
}

const SCS_HEADERS = (tok) => ({
  Authorization: `Bearer ${tok}`,
  'OData-MaxVersion': '4.0',
  'OData-Version': '4.0',
  Accept: 'application/json',
});

async function listBoundSolutions({ base, tok }) {
  // Primary filter: isgitintegrationenabled (newer); fall back to
  // enabledforsourcecontrolintegration if the column is unrecognised.
  const tryFilter = async (filterExpr) => {
    const url =
      `${base}/api/data/v9.2/solutions` +
      `?$filter=${encodeURIComponent(filterExpr)}` +
      `&$select=solutionid,uniquename` +
      `&$top=200`;
    const res = await makeRequest({ url, method: 'GET', headers: SCS_HEADERS(tok) });
    return res;
  };

  let res = await tryFilter('isgitintegrationenabled eq true');
  if (res.error) return { error: res.error };
  if (res.statusCode === 400) {
    res = await tryFilter('enabledforsourcecontrolintegration eq true');
    if (res.error) return { error: res.error };
  }
  if (res.statusCode !== 200) {
    let msg = `HTTP ${res.statusCode}`;
    try { msg = JSON.parse(res.body).error.message || msg; } catch {}
    return { error: msg, statusCode: res.statusCode };
  }

  let parsed;
  try { parsed = JSON.parse(res.body); } catch (e) { return { error: 'parse: ' + e.message }; }
  const rows = parsed.value || [];
  return {
    items: rows.map((r) => ({ id: r.solutionid, uniqueName: r.uniquename })),
  };
}

async function listSolutionComponentIds({ base, tok, solutionId, maxRows }) {
  // Paginate via @odata.nextLink if present.
  const collected = [];
  let url =
    `${base}/api/data/v9.2/solutioncomponents` +
    `?$filter=_solutionid_value eq ${solutionId}` +
    `&$select=objectid,componenttype` +
    `&$top=5000`;
  while (url) {
    const res = await makeRequest({ url, method: 'GET', headers: SCS_HEADERS(tok) });
    if (res.error) return { error: res.error };
    if (res.statusCode !== 200) {
      let msg = `HTTP ${res.statusCode}`;
      try { msg = JSON.parse(res.body).error.message || msg; } catch {}
      return { error: msg, statusCode: res.statusCode };
    }
    let parsed;
    try { parsed = JSON.parse(res.body); } catch (e) { return { error: 'parse: ' + e.message }; }
    const rows = parsed.value || [];
    for (const r of rows) {
      collected.push({ objectId: r.objectid, componentType: r.componenttype });
      if (collected.length >= maxRows) return { items: collected, truncatedAt: maxRows };
    }
    url = parsed['@odata.nextLink'] || null;
  }
  return { items: collected };
}

/**
 * @param {object} options
 * @returns {Promise<object>}
 */
async function validateNoSharedComponents({
  envUrl, token, solutionUniqueName,
  maxOtherSolutions = 5,
  maxTargetComponents = 5000,
} = {}) {
  if (!solutionUniqueName) return { error: '--solutionUniqueName is required.' };

  const url = envUrl || getEnvironmentUrl();
  if (!url) return { error: 'Could not determine environment URL.' };
  const tok = token || getAuthToken(url);
  if (!tok) return { error: 'Could not acquire auth token.' };
  const base = url.replace(/\/+$/, '');

  // 1. List bound solutions.
  const bound = await listBoundSolutions({ base, tok });
  if (bound.error) return { error: bound.error };

  const target = bound.items.find((s) => s.uniqueName === solutionUniqueName);
  if (!target) {
    return { error: `Solution '${solutionUniqueName}' not found among Git-bound solutions.` };
  }

  const others = bound.items.filter((s) => s.id !== target.id);
  const info = [];

  if (others.length > maxOtherSolutions) {
    return {
      ok: true,
      totalChecked: 0,
      blocking: [],
      warnings: [],
      info: [{
        severity: 'info',
        key: 'shared-components-skipped-too-many-solutions',
        message: `Skipping shared-component check: ${others.length} other Git-bound solutions exceed limit ${maxOtherSolutions}.`,
        ref: 'IL-009',
        details: { otherCount: others.length, maxOtherSolutions },
        remediation: 'Re-run with --max-other-solutions <larger> to force the check.',
      }],
      scope: { solutionUniqueName, solutionId: target.id },
      boundSolutions: bound.items,
    };
  }

  // 2. Target solution components.
  const targetComponents = await listSolutionComponentIds({
    base, tok, solutionId: target.id, maxRows: maxTargetComponents,
  });
  if (targetComponents.error) return { error: targetComponents.error };

  if (targetComponents.truncatedAt) {
    info.push({
      severity: 'info',
      key: 'shared-components-target-truncated',
      message: `Target solution has > ${maxTargetComponents} components; only the first ${maxTargetComponents} compared.`,
      ref: 'IL-009',
      details: { maxTargetComponents },
      remediation: 'Re-run with --max-target-components <larger> for full coverage.',
    });
  }

  const targetSet = new Map();
  for (const c of targetComponents.items) {
    if (c.objectId) targetSet.set(c.objectId, c.componentType);
  }

  // 3. For each other bound solution, intersect.
  const blocking = [];
  let totalChecked = targetComponents.items.length;
  for (const other of others) {
    const others_components = await listSolutionComponentIds({
      base, tok, solutionId: other.id, maxRows: maxTargetComponents,
    });
    if (others_components.error) return { error: others_components.error };
    totalChecked += others_components.items.length;

    for (const c of others_components.items) {
      if (c.objectId && targetSet.has(c.objectId)) {
        blocking.push({
          severity: 'blocker',
          key: 'shared-component',
          message: `Component ${c.objectId} (componenttype=${c.componentType}) is also in solution '${other.uniqueName}'.`,
          ref: 'IL-009',
          details: {
            objectId: c.objectId,
            componentType: c.componentType,
            otherSolutionUniqueName: other.uniqueName,
            otherSolutionId: other.id,
          },
          remediation: `Remove the component from either '${solutionUniqueName}' or '${other.uniqueName}' (whichever should not own it), then re-run pre-flight.`,
        });
      }
    }

    if (others_components.truncatedAt) {
      info.push({
        severity: 'info',
        key: 'shared-components-other-truncated',
        message: `Other solution '${other.uniqueName}' has > ${maxTargetComponents} components; only the first ${maxTargetComponents} compared.`,
        ref: 'IL-009',
        details: { otherSolutionUniqueName: other.uniqueName, maxTargetComponents },
        remediation: 'Re-run with --max-target-components <larger> for full coverage.',
      });
    }
  }

  return {
    ok: blocking.length === 0,
    totalChecked,
    blocking,
    warnings: [],
    info,
    scope: { solutionUniqueName, solutionId: target.id },
    boundSolutions: bound.items,
  };
}

if (require.main === module) {
  const args = parseArgs(process.argv);
  validateNoSharedComponents(args)
    .then((r) => {
      process.stdout.write(JSON.stringify(r, null, 2) + '\n');
      process.exit(r && r.error ? 1 : 0);
    })
    .catch((e) => {
      process.stderr.write('validate-no-shared-components: ' + e.message + '\n');
      process.exit(1);
    });
}

module.exports = { validateNoSharedComponents };
