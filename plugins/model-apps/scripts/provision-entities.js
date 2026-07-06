#!/usr/bin/env node
// provision-entities CLI: provision Dataverse entities via the shared core.
// Validates the input, builds SDK clients, runs the shared provision functions, and prints
// a structured JSON result. Dry-run by default; --apply writes. --sample-data opt-in.
//
// Usage:
//   node provision-entities.js --env <orgUrl> --input @<path> [--apply] [--sample-data]
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { validateProvisionInput } = require('./lib/provision-input.js');
const { makeRunner, provisionSolution, provisionDataModel, provisionSampleData } = require('./lib/entity-provision.js');
const { createAzHttpClient } = require('./lib/sdk-http-client.js');
const { parseArgs, readJsonArg, emitResult } = require('./lib/dataverse-auth.js');

// Construct the SDK against the vendored bundle + an az-token HttpClient. Two clients:
//   sdk          — carries solutionUniqueName (metadata + record writes auto-join the
//                  solution via the MSCRM.SolutionUniqueName header).
//   provision    — header-less; used for discovery reads (findTables/findColumns/
//                  fetchEntityMetadata/queryRecords).
function makeSdk(env, input) {
  const { createMakerSdk } = require('./vendor/cds-maker-sdk.cjs');
  const httpClient = createAzHttpClient(env);
  const sdk = createMakerSdk({
    workspacePath: fs.mkdtempSync(path.join(os.tmpdir(), 'provision-')),
    instanceUrl: env,
    httpClient,
    solutionUniqueName: input.solution.uniqueName,
  });
  const provision = createMakerSdk({ workspacePath: fs.mkdtempSync(path.join(os.tmpdir(), 'provision-')), instanceUrl: env, httpClient });
  return { sdk, provision };
}

// Count the total steps in the plan for makeRunner's [n/total] narration.
function computeTotal(input, opts) {
  let total = 1; // solution
  
  // entities + columns + status reasons + alternate keys
  for (const e of input.entities || []) {
    total += 1; // table
    total += (e.columns || []).filter((c) => c.type !== 'Lookup').length; // columns (Lookup comes from relationships)
    total += (e.statusReasons || []).length; // status reasons
    total += (e.alternateKeys || []).length; // alternate keys
  }
  
  // relationships
  total += (input.relationships || []).length;
  
  // global choices
  total += (input.globalChoices || []).length;
  
  // sample data (if requested)
  if (opts.sampleData && input.sampleData) {
    total += Object.keys(input.sampleData).length;
  }
  
  return total;
}

// Build a dry-run plan (list of steps that would be executed).
function buildPlan(input, opts) {
  const plan = [];
  
  plan.push(`solution ${input.solution.uniqueName}`);
  
  for (const gc of input.globalChoices || []) {
    plan.push(`global choice ${gc.name}`);
  }
  
  for (const e of input.entities || []) {
    plan.push(`table ${e.schemaName}`);
    for (const c of e.columns || []) {
      if (c.type !== 'Lookup') {
        plan.push(`column ${e.schemaName}.${c.schemaName} (${c.type || 'Text'})`);
      }
    }
    for (const sr of e.statusReasons || []) {
      plan.push(`status reason ${e.schemaName}: ${sr.label}`);
    }
    for (const k of e.alternateKeys || []) {
      plan.push(`alt key ${e.schemaName}.${k.schemaName}`);
    }
  }
  
  for (const rel of input.relationships || []) {
    if (rel.type === 'OneToMany') {
      plan.push(`relationship 1:N ${rel.referenced}->${rel.referencing}`);
    } else if (rel.type === 'ManyToMany') {
      plan.push(`relationship N:N ${rel.entity1}<->${rel.entity2}`);
    }
  }
  
  if (opts.sampleData && input.sampleData) {
    for (const [entityKey, records] of Object.entries(input.sampleData)) {
      if (Array.isArray(records) && records.length > 0) {
        plan.push(`${records.length} record(s) -> ${entityKey}`);
      }
    }
  }
  
  return plan;
}

// The testable core: validates, computes plan, runs the shared provision functions.
// `deps` injects { sdk, provision, emit, log } so tests never touch the network.
async function provisionEntities(input, opts = {}, deps = {}) {
  // 1. Validation gate first — if invalid, return errors with ZERO SDK writes.
  const v = validateProvisionInput(input);
  if (!v.ok) {
    return { ok: false, errors: v.errors };
  }
  
  // 2. Dry-run default: without --apply, return a plan with NO SDK writes.
  if (!opts.apply) {
    const plan = buildPlan(input, opts);
    return { ok: true, dryRun: true, plan };
  }
  
  // 3. Apply: run the shared core (solution → data-model → sample-data-if-requested).
  const log = deps.log || (() => undefined);
  const emit = deps.emit || (() => undefined);
  const sdk = deps.sdk;
  const provision = deps.provision;
  
  const total = computeTotal(input, opts);
  const runner = makeRunner({ emit, total });
  
  // Convert input to spec shape expected by the shared core
  const spec = {
    solution: input.solution,
    entities: input.entities,
    relationships: input.relationships || [],
    globalChoices: input.globalChoices || [],
    sampleData: input.sampleData,
  };
  
  // Provision solution
  await provisionSolution({ sdk, provision, runner, solution: spec.solution });
  
  // Provision data model (entities, columns, relationships)
  const dataModel = await provisionDataModel({
    sdk,
    provision,
    runner,
    spec,
    apply: true,
    concurrency: 5,
  });
  
  // Provision sample data (if requested)
  let sampleResult = { records: {} };
  if (opts.sampleData && spec.sampleData) {
    sampleResult = await provisionSampleData({
      sdk,
      provision,
      runner,
      spec,
      dataModel,
    });
  }
  
  // 4. Assemble the structured result from the captured maps.
  // dataModel.entities is { [schemaName]: { logicalName, entitySetName } }
  // We need to convert to the array shape: [{ schemaName, logicalName, entitySetName }]
  const entities = Object.entries(dataModel.entities || {}).map(([schemaName, data]) => ({
    schemaName,
    logicalName: data.logicalName,
    entitySetName: data.entitySetName,
    // metadataId not currently surfaced by the shared core's return maps
  }));
  
  // Build columns array from input (the shared core doesn't return a column map yet)
  const columns = [];
  for (const e of spec.entities) {
    for (const c of e.columns || []) {
      if (c.type !== 'Lookup') {
        columns.push({
          table: e.schemaName.toLowerCase(),
          schemaName: c.schemaName,
          logicalName: c.schemaName.toLowerCase(),
          // metadataId not currently surfaced
        });
      }
    }
  }
  
  // Build relationships array from input
  const relationships = (spec.relationships || []).map((r) => {
    if (r.type === 'OneToMany') {
      return {
        kind: '1n',
        schemaName: r.schemaName || `${r.referenced}_${r.referencing}`,
        // metadataId not currently surfaced
      };
    } else if (r.type === 'ManyToMany') {
      return {
        kind: 'nn',
        schemaName: r.schemaName || `${r.entity1}_${r.entity2}`,
        // metadataId not currently surfaced
      };
    }
    return null;
  }).filter(Boolean);
  
  return {
    ok: true,
    solution: spec.solution.uniqueName,
    entities,
    columns,
    relationships,
    records: sampleResult.records || {},
  };
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const env = flags.env;
  const inputArg = flags.input || positional[0];
  
  if (!env || !inputArg) {
    process.stderr.write(
      'Usage: node provision-entities.js --env <url> --input @<path> [--apply] [--sample-data]\n'
    );
    process.exit(1);
  }
  
  const inputPath = path.resolve(typeof inputArg === 'string' && inputArg.startsWith('@') ? inputArg.slice(1) : inputArg);
  const input = readJsonArg('@' + inputPath);
  
  const opts = {
    apply: flags.apply === true,
    sampleData: flags['sample-data'] === true,
  };
  
  // Construct SDK clients (offline until first call)
  const { sdk, provision } = makeSdk(env, input);
  
  const deps = {
    log: (m) => process.stderr.write(m + '\n'),
    sdk,
    provision,
  };
  
  const r = await provisionEntities(input, opts, deps);
  emitResult(r.ok, r);
}

if (require.main === module) {
  main();
}

module.exports = { provisionEntities };
