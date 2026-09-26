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
const { odataLit } = require('./lib/odata');
const APPMODULE_COMPONENT_TYPE = 80;
const UXAGENTPROJECT_LOGICAL_NAME = 'uxagentproject';
const CONNECTION_REFERENCE_LOGICAL_NAME = 'connectionreference';

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
  const path = `EntityDefinitions(LogicalName='${odataLit(logicalName)}')?$select=ObjectTypeCode`;
  const res = await dataverseRequest(envUrl, 'GET', path);
  ensureOk(res, `Resolve component type for ${logicalName}`);
  const componentType = Number(res.data?.ObjectTypeCode);
  if (!Number.isInteger(componentType) || componentType <= 0) {
    throw new Error(`Entity '${logicalName}' did not return a valid ObjectTypeCode`);
  }
  return componentType;
}

async function resolveConnectionReferences(envUrl, refs) {
  const resolved = [];
  for (const logicalName of refs) {
    const query =
      `connectionreferences?$filter=connectionreferencelogicalname eq '${odataLit(logicalName)}'` +
      '&$select=connectionreferenceid&$top=1';
    const lookup = await dataverseRequest(envUrl, 'GET', query);
    ensureOk(lookup, `Lookup connection reference ${logicalName}`);
    const id = lookup.data?.value?.[0]?.connectionreferenceid;
    if (!id) throw new Error(`Connection reference '${logicalName}' not found in env`);
    resolved.push({ logicalName, id });
  }
  return resolved;
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

  // Parsed BEFORE the first mutation so lookup failures refuse the whole run rather
  // than leaving a half-packaged solution (app + pages added, refs missing).
  const refs = (flags['connection-refs'] || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const pageIds = (flags['page-ids'] || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
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
    const resolvedConnectionRefs = refs.length
      ? await resolveConnectionReferences(envUrl, refs)
      : [];

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

    for (const { logicalName, id } of resolvedConnectionRefs) {
      await addComponent(envUrl, solutionUniqueName, id, connectionReferenceComponentType, false);
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

// Exported for unit tests. AppModule is a stable system component type; the two custom-table
// component types are deliberately resolved per environment by resolveEntityComponentType.
module.exports = {
  APPMODULE_COMPONENT_TYPE,
  UXAGENTPROJECT_LOGICAL_NAME,
  CONNECTION_REFERENCE_LOGICAL_NAME,
  resolveEntityComponentType,
  resolveConnectionReferences,
};
