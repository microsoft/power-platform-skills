#!/usr/bin/env node

// Adds a connector-bound GenPage and its connection references to a solution so it
// travels cross-environment. Verified live 2026-07-10 on a Dataverse test environment:
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
  validateFlags,
  emitResult,
} = require('./lib/dataverse-auth');

const APPMODULE_COMPONENT_TYPE = 80;
// Solution component type for the GenPage itself. uxagentproject IS a registered
// component type (10372 = its ObjectTypeCode), verified live 2026-07-10 on a
// Dataverse test environment. It does NOT auto-travel with the appmodule, so it is added
// explicitly; AddRequiredComponents=true then pulls its uxagentprojectfile rows
// (10373: page.tsx, page.compiled, config.json, firstPrompt.json).
const UXAGENTPROJECT_COMPONENT_TYPE = 10372;
// Solution component type for connectionreference. Verified live (2026-07-10) by
// reading solutioncomponent.componenttype for an existing connection reference in the
// Default/Active solutions of a test environment (= 10158). Note: 371 is "Connector"
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

  // Parsed BEFORE the first mutation so a malformed list fails the run outright rather than
  // leaving a half-packaged solution (app + pages added, refs missing).
  const refs = (flags['connection-refs'] || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

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

    for (const logicalName of refs) {
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

    emitResult(true, { ok: true, added });
  } catch (e) {
    emitResult(false, e);
  }
}

// Only run when invoked directly as a CLI; requiring the module (e.g. from tests)
// must not execute main().
if (require.main === module) {
  main();
}

// Exported for unit tests: the OData literal escaper, and the three solution component
// type codes. The codes are live-verified magic numbers whose correctness is not locally
// obvious (10158 is connectionreference; 371 is "Connector"/msdyn_Connector and FAILS with
// "entity ... not found in MetadataCache"), so they are pinned by test rather than left to
// a future edit to silently change.
module.exports = {
  escapeODataString,
  APPMODULE_COMPONENT_TYPE,
  UXAGENTPROJECT_COMPONENT_TYPE,
  CONNECTION_REFERENCE_COMPONENT_TYPE,
};
