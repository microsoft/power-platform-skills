#!/usr/bin/env node

// Adds a GenPage (via its appmodule) and its connection references to a solution
// so the page travels cross-env. The GenPage itself (uxagentproject) is NOT a
// standalone solution component type — it travels as a REQUIRED component of the
// appmodule/sitemap that references it, so we add the appmodule with
// AddRequiredComponents=true. Connection references ARE their own component and
// are added explicitly so connectorBindings resolve in the target env.
// Ref: docs/topics/GenPages/architecture/genpages-architecture.md (uxagentproject ALM)
//
// Usage:
//   node add-page-to-solution.js <envUrl> <solutionUniqueName> <appId>
//     [--connection-refs <logicalName1,logicalName2>]
//
// Output: { "ok": true, "added": [...] }

const {
  dataverseRequest,
  ensureOk,
  parseArgs,
  emitResult,
} = require('./lib/dataverse-auth');

const APPMODULE_COMPONENT_TYPE = 80;
const CONNECTION_REFERENCE_COMPONENT_TYPE = 371; // confirm per env (Task A0)

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
      'Usage: node add-page-to-solution.js <envUrl> <solutionUniqueName> <appId> [--connection-refs <logicalName1,logicalName2>]\n'
    );
    process.exit(1);
  }
  const [envUrl, solutionUniqueName, appId] = positional;
  const added = [];

  try {
    // The appmodule AddSolutionComponent action must receive the equivalent of
    // { ComponentType: 80, AddRequiredComponents: true } because that required
    // component closure is what carries uxagentproject rows and sitemap links.
    await addComponent(envUrl, solutionUniqueName, appId, APPMODULE_COMPONENT_TYPE, true);
    added.push({ type: 'appmodule', id: appId });

    const refs = (flags['connection-refs'] || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
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

main();
