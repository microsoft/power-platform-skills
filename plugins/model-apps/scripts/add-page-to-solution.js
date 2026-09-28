#!/usr/bin/env node

// Adds a connector-bound GenPage and its connection references to a solution so it
// travels cross-environment. Verified live 2026-07-10 on a Dataverse test environment:
//   - The appmodule (type 80, AddRequiredComponents=true) pulls the sitemap (62) and
//     appmodulecomponent (10097) but does NOT pull the GenPage — so the GenPage's
//     uxagentproject row MUST be added explicitly; adding it pulls its
//     uxagentprojectfile children (incl. config.json with connectorBindings).
//   - connectionreference is its own component and is added explicitly so
//     the bindings resolve in the target env (at import the deployer supplies each
//     ConnectionId via `pac solution create-settings` + `pac solution import --settings-file`).
//     Both are custom tables whose ObjectTypeCode varies by environment, so their
//     component types are discovered from EntityDefinitions before any mutation.
//
// Usage:
//   node add-page-to-solution.js <envUrl> <solutionUniqueName> <appId>
//     [--page-ids <uxagentprojectId1,uxagentprojectId2>]
//     [--connection-refs <logicalName1,logicalName2>]
//
// Output: { "ok": true, "added": [...] }

const {
  dataverseRequest,
  ensureOk,
  parseArgs,
  validateFlags,
  emitResult,
} = require('./lib/dataverse-auth');
const { isConnectorsEnabled, exitIfConnectorsDisabled } = require('./lib/feature-flags');

// Connection references are connector state. When the connectors flag is OFF (the GA rollback
// switch), ALM must not add them. Two distinct cases, and conflating them is what made this
// silently lossy:
//   1. The caller passed NO --connection-refs → nothing to gate; non-connector page packaging
//      (appmodule + uxagentproject) proceeds normally whether the flag is on or off.
//   2. The caller EXPLICITLY passed --connection-refs while the flag is OFF → this is the
//      documented fail-closed backstop: exit 3, BEFORE any AddSolutionComponent call. Previously
//      the refs were dropped and the script still reported `ok: true`, so an out-of-band/stale-plan
//      call packaged a solution WITHOUT the connection references the caller asked for and looked
//      like it succeeded — the resulting solution imports with unbound connectors.
// The gate runs before the first mutation so a refused run leaves the solution untouched rather
// than half-populated (app + pages added, refs missing).
function connectionRefsToAdd(refs, connectorsEnabled) {
  return connectorsEnabled ? refs : [];
}

const APPMODULE_COMPONENT_TYPE = 80;
const UXAGENTPROJECT_LOGICAL_NAME = 'uxagentproject';
const CONNECTION_REFERENCE_LOGICAL_NAME = 'connectionreference';

function escapeODataString(value) {
  return String(value).replace(/'/g, "''");
}

async function addComponent(envUrl, solutionUniqueName, componentId, componentType, addRequired) {
  const body = {
    ComponentId: componentId,
    ComponentType: componentType,
    SolutionUniqueName: solutionUniqueName,
    AddRequiredComponents: addRequired,
  };
  const res = await dataverseRequest(envUrl, 'POST', 'AddSolutionComponent', body);
  ensureOk(res, `Add component ${componentId} (type ${componentType}) to ${solutionUniqueName}`);
}

async function resolveEntityComponentType(envUrl, logicalName) {
  const path = `EntityDefinitions(LogicalName='${escapeODataString(logicalName)}')?$select=ObjectTypeCode`;
  const res = await dataverseRequest(envUrl, 'GET', path);
  ensureOk(res, `Resolve component type for ${logicalName}`);
  const componentType = Number(res.data?.ObjectTypeCode);
  if (!Number.isInteger(componentType) || componentType <= 0) {
    throw new Error(`Entity '${logicalName}' did not return a valid ObjectTypeCode`);
  }
  return componentType;
}

async function main() {
  const argv = process.argv.slice(2);
  const { positional, flags } = parseArgs(argv);
  const USAGE = 'Usage: node add-page-to-solution.js <envUrl> <solutionUniqueName> <appId> [--page-ids <id1,id2>] [--connection-refs <logicalName1,logicalName2>]';
  // Both flags are comma-joined id lists. A bare one would become boolean `true`, and `true.split`
  // is a TypeError mid-way through packaging rather than a usage error before it.
  const flagError = validateFlags(argv, {
    known: ['page-ids', 'connection-refs'],
    needValue: ['page-ids', 'connection-refs'],
  });
  if (flagError) {
    process.stderr.write(`✗ ${flagError}\n${USAGE}\n`);
    process.exit(1);
  }
  if (positional.length < 3) {
    process.stderr.write(USAGE + '\n');
    process.exit(1);
  }
  const [envUrl, solutionUniqueName, appId] = positional;
  const added = [];

  // Parsed BEFORE the first mutation so the fail-closed gate can refuse the whole run rather
  // than leaving a half-packaged solution (app + pages added, refs missing).
  const refs = (flags['connection-refs'] || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const pageIds = (flags['page-ids'] || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const connectorsOn = isConnectorsEnabled();
  // Explicitly-requested refs while the feature is OFF = the documented exit-3 backstop.
  if (refs.length && !connectorsOn) {
    exitIfConnectorsDisabled();
    return; // exitIfConnectorsDisabled() exits; `return` keeps the flow explicit for tests.
  }

  try {
    // ObjectTypeCode for custom tables is allocated per environment. Resolve both
    // types before the first AddSolutionComponent so a metadata failure leaves the
    // target solution untouched instead of half-packaged.
    const pageComponentType = pageIds.length
      ? await resolveEntityComponentType(envUrl, UXAGENTPROJECT_LOGICAL_NAME)
      : null;
    const connectionReferenceComponentType = refs.length
      ? await resolveEntityComponentType(envUrl, CONNECTION_REFERENCE_LOGICAL_NAME)
      : null;

    // The appmodule (type 80) with AddRequiredComponents=true pulls the sitemap and
    // appmodulecomponent, but NOT the GenPage — the page is added explicitly below.
    await addComponent(envUrl, solutionUniqueName, appId, APPMODULE_COMPONENT_TYPE, true);
    added.push({ type: 'appmodule', id: appId });

    // Add each GenPage (uxagentproject) explicitly. AddRequiredComponents
    // pulls its uxagentprojectfile rows — including config.json with the
    // connectorBindings that must travel with the page.
    for (const pageId of pageIds) {
      await addComponent(envUrl, solutionUniqueName, pageId, pageComponentType, true);
      added.push({ type: 'uxagentproject', id: pageId });
    }

    const refsToAdd = connectionRefsToAdd(refs, connectorsOn);
    const skippedConnectionRefs = connectorsOn ? [] : refs;
    for (const logicalName of refsToAdd) {
      const query =
        `connectionreferences?$filter=connectionreferencelogicalname eq '${escapeODataString(logicalName)}'` +
        '&$select=connectionreferenceid&$top=1';
      const lookup = await dataverseRequest(envUrl, 'GET', query);
      ensureOk(lookup, `Lookup connection reference ${logicalName}`);
      const id = lookup.data?.value?.[0]?.connectionreferenceid;
      if (!id) throw new Error(`Connection reference '${logicalName}' not found in env`);

      await addComponent(envUrl, solutionUniqueName, id, connectionReferenceComponentType, false);
      added.push({ type: 'connectionreference', logicalName, id });
    }

    emitResult(true, { ok: true, added, skippedConnectionRefs });
  } catch (e) {
    emitResult(false, e);
  }
}

// Only run when invoked directly as a CLI; requiring the module (e.g. from tests)
// must not execute main().
if (require.main === module) {
  main();
}

// Exported for unit tests. AppModule is a stable system component type; the two custom-table
// component types are deliberately resolved per environment by resolveEntityComponentType.
module.exports = {
  connectionRefsToAdd,
  escapeODataString,
  APPMODULE_COMPONENT_TYPE,
  UXAGENTPROJECT_LOGICAL_NAME,
  CONNECTION_REFERENCE_LOGICAL_NAME,
  resolveEntityComponentType,
};
