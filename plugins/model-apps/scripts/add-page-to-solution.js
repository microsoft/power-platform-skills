#!/usr/bin/env node

// Adds a connector-bound GenPage and its connection references to a solution so it
// travels cross-environment. Verified live 2026-07-10 on AuroraBAPEnv03468:
//   - The appmodule (type 80, AddRequiredComponents=true) pulls the sitemap (62) and
//     appmodulecomponent (10097) but does NOT pull the GenPage — so the GenPage's
//     uxagentproject row MUST be added explicitly (type 10372); adding it pulls its
//     uxagentprojectfile children (10373, incl. config.json with connectorBindings).
//   - connectionreference is its own component (type 10158) and is added explicitly so
//     the bindings resolve in the target env (at import the deployer supplies each
//     ConnectionId via `pac solution create-settings` + `pac solution import --settings-file`).
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
  emitResult,
} = require('./lib/dataverse-auth');
const { isConnectorsEnabled, exitIfConnectorsDisabled } = require('./lib/feature-flags');

// Connection references are connector state. When the connectors flag is OFF, ALM must not add
// them. Two distinct cases, and conflating them is what made this silently lossy:
//   1. The caller passed NO --connection-refs → nothing to gate; non-connector page packaging
//      (appmodule + uxagentproject) proceeds normally whether the flag is on or off.
//   2. The caller EXPLICITLY passed --connection-refs while the flag is OFF → this is the
//      documented fail-closed backstop (AGENTS.md → "Script backstop" / gate checklist item 4):
//      exit 3, BEFORE any AddSolutionComponent call. Previously the refs were dropped and the
//      script still reported `ok: true`, so an out-of-band/stale-plan call packaged a solution
//      WITHOUT the connection references the caller asked for and looked like it succeeded —
//      the resulting solution imports with unbound connectors.
// The gate runs before the first mutation so a refused run leaves the solution untouched rather
// than half-populated (app + pages added, refs missing).
function connectionRefsToAdd(refs, connectorsEnabled) {
  return connectorsEnabled ? refs : [];
}

const APPMODULE_COMPONENT_TYPE = 80;
// Solution component type for the GenPage itself. uxagentproject IS a registered
// component type (10372 = its ObjectTypeCode), verified live 2026-07-10 on
// AuroraBAPEnv03468. It does NOT auto-travel with the appmodule, so it is added
// explicitly; AddRequiredComponents=true then pulls its uxagentprojectfile rows
// (10373: page.tsx, page.compiled, config.json, firstPrompt.json).
const UXAGENTPROJECT_COMPONENT_TYPE = 10372;
// Solution component type for connectionreference. Verified live (2026-07-10) by
// reading solutioncomponent.componenttype for an existing connection reference in the
// Default/Active solutions on AuroraBAPEnv03468 (= 10158). Note: 371 is "Connector"
// (msdyn_Connector), NOT a connection reference — AddSolutionComponent with 371 fails
// with "entity ... 'msdyn_Connector' ... not found in MetadataCache".
const CONNECTION_REFERENCE_COMPONENT_TYPE = 10158;

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

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  if (positional.length < 3) {
    process.stderr.write(
      'Usage: node add-page-to-solution.js <envUrl> <solutionUniqueName> <appId> [--page-ids <id1,id2>] [--connection-refs <logicalName1,logicalName2>]\n'
    );
    process.exit(1);
  }
  const [envUrl, solutionUniqueName, appId] = positional;
  const added = [];

  // Parse the requested connection references BEFORE any mutation so the fail-closed gate can
  // refuse the whole run rather than leaving a half-packaged solution.
  const refs = (flags['connection-refs'] || '')
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
    // The appmodule (type 80) with AddRequiredComponents=true pulls the sitemap and
    // appmodulecomponent, but NOT the GenPage — the page is added explicitly below.
    await addComponent(envUrl, solutionUniqueName, appId, APPMODULE_COMPONENT_TYPE, true);
    added.push({ type: 'appmodule', id: appId });

    // Add each GenPage (uxagentproject, type 10372) explicitly. AddRequiredComponents
    // pulls its uxagentprojectfile rows (10373) — including config.json with the
    // connectorBindings that must travel with the page.
    const pageIds = (flags['page-ids'] || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    for (const pageId of pageIds) {
      await addComponent(envUrl, solutionUniqueName, pageId, UXAGENTPROJECT_COMPONENT_TYPE, true);
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

      await addComponent(envUrl, solutionUniqueName, id, CONNECTION_REFERENCE_COMPONENT_TYPE, false);
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

module.exports = { connectionRefsToAdd };
