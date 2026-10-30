'use strict';
// A read-only inventory of a solution's artifacts, for diagnosis: what the SDK's fetchSolution() can read of it, and
// what it could not. It is NOT a list of everything the solution owns and NOT a portable closure, and it says so in
// every result:
//   - fetchSolution() reads only the 14 artifact kinds the SDK models (SUPPORTED_KINDS); a component of any other kind is
//     never asked for, so it is neither listed nor counted.
//   - A table the solution holds with ALL its subcomponents is reported `notExpanded`: its forms, views, charts and
//     dashboards are members the solution does not list one by one, and fetchSolution() does not enumerate them.
//   - A component the SDK could not map is `skipped` (reason `unsupported`); one whose read failed is `skipped`
//     (reason `failed`) and makes the result `ok:false`, because the inventory is then known to be short.
// App download stays component-aware (it reads an app's own components); it must not be replaced with this, which reads
// a solution, not an app, and only the kinds above.
//
// Cost: every request is a GET, counted in `cost.gets` (five metadata reads for org-assigned component type codes, the
// component pages, one read or more per component). The SDK's transport is wrapped by readOnlyHttpClient, so a write
// would be refused before it is sent and counted in `cost.refusedWrites`; there is none to expect.
//
// fetchSolution() copies every artifact it reads into the SDK workspace. The caller passes a throwaway workspace
// (lib/throwaway-sdk.js), removed when the run ends, so no copy outlives it. The result carries ids, names and kinds
// only: never an artifact body, an environment variable's value or a connection id.
const { readOnlyHttpClient, findingOf } = require('./readonly-operations.js');

// ArtifactType of the bundled SDK (types/common.ts): the kinds fetchSolution() can return.
const SUPPORTED_KINDS = Object.freeze([
  'form', 'view', 'businessRule', 'app', 'command', 'chart', 'dashboard', 'genPage', 'bpf',
  'environmentVariable', 'connectionReference', 'fieldSecurityProfile', 'customApi', 'duplicateRule',
]);

// fetchSolution() overlaps its per-component reads in a window of this size (the SDK accepts 1-8 and defaults to 1).
// Four matches the page backend (lib/genpage-sdk.js): each component is a handful of reads, and a solution can hold
// hundreds of components. The order of `summaries` and `skipped` does not depend on it.
const INVENTORY_READ_CONCURRENCY = 4;

// Solution component type 1 is a table (https://learn.microsoft.com/en-us/power-apps/developer/data-platform/reference/entities/solutioncomponent).
const TABLE_COMPONENT_TYPE = 1;

const LIMITS = Object.freeze([
  'Lists only the artifact kinds in supportedKinds; a component of any other kind is not read and not counted.',
  'A table held with all its subcomponents is listed in notExpanded; its forms, views, charts and dashboards are not listed.',
  'This is not a list of everything the solution owns, and not a set of artifacts that can be moved on their own.',
]);

function errorOf(error) {
  if (!error) return undefined;
  const { code, message } = findingOf(error, 'COMPONENT_READ_FAILED');
  const statusCode = Number.isInteger(error.statusCode) ? error.statusCode : undefined;
  return { code, ...(statusCode ? { statusCode } : {}), message };
}

function describeSolution(info) {
  return {
    solutionId: info.solutionId,
    uniqueName: info.uniqueName,
    friendlyName: info.friendlyName,
    version: info.version,
    isManaged: info.isManaged === true,
    publisherUniqueName: info.publisherUniqueName,
  };
}

/**
 * Reads a solution (and, with `includeArtifacts`, its artifacts) through a GET-only transport.
 * @param {object} options
 * @param {object} options.httpClient - the SDK HttpClient to read through (wrapped read-only here)
 * @param {(client: object) => object} options.makeSdk - builds an SDK over the given client and a throwaway workspace
 * @param {string} options.solution - the solution's unique name or id
 * @param {boolean} [options.includeArtifacts]
 */
async function inspectSolution({ httpClient, makeSdk, solution, includeArtifacts = false }) {
  if (typeof solution !== 'string' || !solution.trim()) {
    return { ok: false, error: { code: 'SOLUTION_INSPECT_INPUT_INVALID', message: 'a solution unique name or id is required' } };
  }
  const { client, stats } = readOnlyHttpClient(httpClient);
  const cost = () => ({ gets: stats.gets, refusedWrites: stats.refusedWrites });
  let sdk;
  let info;
  try {
    sdk = makeSdk(client);
    info = await sdk.getSolution(solution.trim());
  } catch (error) {
    return { ok: false, error: findingOf(error, 'SOLUTION_READ_FAILED'), cost: cost() };
  }
  const result = { ok: stats.refusedWrites === 0, solution: describeSolution(info), cost: cost() };
  if (!includeArtifacts) return result;

  let fetched;
  try {
    await sdk.initWorkspace();
    fetched = await sdk.fetchSolution(info.solutionId);
  } catch (error) {
    return { ...result, ok: false, error: findingOf(error, 'SOLUTION_INVENTORY_FAILED'), cost: cost() };
  }
  const summaries = Array.isArray(fetched && fetched.summaries) ? fetched.summaries : [];
  const skippedRaw = Array.isArray(fetched && fetched.skipped) ? fetched.skipped : [];
  const byKind = {};
  const artifacts = [];
  const unknownKinds = [];
  for (const s of summaries) {
    // A kind the plugin does not know is reported by name, not dropped: the bundle may have learned a kind after this list.
    if (!SUPPORTED_KINDS.includes(s.type)) unknownKinds.push(s.type);
    byKind[s.type] = (byKind[s.type] || 0) + 1;
    artifacts.push({ kind: s.type, id: s.id, name: s.name, ...(s.entityLogicalName ? { table: s.entityLogicalName } : {}) });
  }
  const notExpanded = [];
  const skipped = [];
  for (const k of skippedRaw) {
    if (k.reason === 'unsupported' && k.componentType === TABLE_COMPONENT_TYPE) {
      notExpanded.push({ componentId: k.componentId });
      continue;
    }
    skipped.push({
      componentId: k.componentId,
      componentType: k.componentType,
      reason: k.reason,
      ...(k.workflowCategory !== undefined ? { workflowCategory: k.workflowCategory } : {}),
      ...(k.error ? { error: errorOf(k.error) } : {}),
    });
  }
  const failed = skipped.filter((k) => k.reason === 'failed').length;
  return {
    ...result,
    ok: stats.refusedWrites === 0 && failed === 0,
    inventory: {
      supportedKinds: [...SUPPORTED_KINDS],
      byKind,
      artifacts,
      notExpanded,
      skipped,
      ...(unknownKinds.length ? { unknownKinds: [...new Set(unknownKinds)] } : {}),
      complete: failed === 0 && skipped.length === 0 && notExpanded.length === 0,
      limits: [...LIMITS],
    },
    cost: cost(),
  };
}

module.exports = { SUPPORTED_KINDS, INVENTORY_READ_CONCURRENCY, inspectSolution };
