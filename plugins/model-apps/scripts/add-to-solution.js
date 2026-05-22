#!/usr/bin/env node

// Adds an existing Dataverse component (table, attribute, relationship, etc.)
// to a solution via the AddSolutionComponent Web API action.
//
// Usage:
//   node add-to-solution.js <envUrl> <solutionUniqueName> <componentId> <componentType>
//     [--add-required-components true|false]   (default: false)
//
// componentType reference (common ones):
//   1   = Entity (table)
//   2   = Attribute (column)
//   9   = Entity Relationship (1:N / N:N)
//   10  = Entity Relationship Role
//   20  = Role
//   29  = Workflow
//   59  = Chart
//   60  = Form
//   61  = Web Resource
//   62  = Site Map
//   65  = Hierarchy Rule
//   80  = Model-driven App (appmodule)
//
// Output: { "ok": true }

const {
  dataverseRequest,
  ensureOk,
  parseArgs,
  emitResult,
} = require('./lib/dataverse-auth');

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  if (positional.length < 4) {
    process.stderr.write(
      'Usage: node add-to-solution.js <envUrl> <solutionUniqueName> <componentId> <componentType> [--add-required-components true|false]\n'
    );
    process.exit(1);
  }
  const [envUrl, solutionUniqueName, componentId, componentTypeRaw] = positional;
  const componentType = Number(componentTypeRaw);
  if (!Number.isFinite(componentType)) {
    emitResult(false, new Error(`componentType must be a number, got "${componentTypeRaw}"`));
    return;
  }

  const body = {
    ComponentId: componentId,
    ComponentType: componentType,
    SolutionUniqueName: solutionUniqueName,
    AddRequiredComponents: flags['add-required-components'] === 'true',
  };

  try {
    const res = await dataverseRequest(envUrl, 'POST', 'AddSolutionComponent', body);
    ensureOk(res, `Add component ${componentId} (type ${componentType}) to solution ${solutionUniqueName}`);
    emitResult(true, { ok: true });
  } catch (e) {
    emitResult(false, e);
  }
}

main();
