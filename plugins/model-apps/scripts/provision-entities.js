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
const { quickCreateEnabledFor, normalizeLanguageCode } = require('./lib/app-spec.js');
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
  const sdkTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'provision-'));
  const provisionTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'provision-'));
  const sdk = createMakerSdk({
    workspacePath: sdkTempDir,
    instanceUrl: env,
    httpClient,
    solutionUniqueName: input.solution && input.solution.uniqueName,
  });
  sdk.initWorkspace();
  const provision = createMakerSdk({ workspacePath: provisionTempDir, instanceUrl: env, httpClient });
  provision.initWorkspace();
  const cleanup = () => {
    fs.rmSync(sdkTempDir, { recursive: true, force: true });
    fs.rmSync(provisionTempDir, { recursive: true, force: true });
  };
  return { sdk, provision, cleanup };
}

// Count the total steps in the plan for makeRunner's [n/total] narration.
function computeTotal(input, opts) {
  let total = 1; // solution
  
  // entities + columns + status reasons + alternate keys
  for (const e of input.entities || []) {
    total += 1; // table
    // quick-create enable step — MUST match provisionDataModel's condition (entity-provision.js) and
    // buildPlan below, or [n/total] drifts. This CLI's input has no forms[], so quickCreateEnabledFor
    // fires only on an explicit entities[].quickCreate === true.
    if (quickCreateEnabledFor(input, e)) total += 1;
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
    if (quickCreateEnabledFor(input, e)) plan.push(`enable quick create on ${String(e.schemaName).toLowerCase()}`);
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
// `deps` injects { sdk, provision, emit, log, warn } so tests never touch the network.
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
  const warn = deps.warn || (() => undefined);
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
    // Carried through so a caller can pin the label LCID here exactly as an App Spec can. Without
    // it the field would be silently dropped on this path while working on the build path.
    ...(input.languageCode !== undefined ? { languageCode: input.languageCode } : {}),
  };
  
  // Provision solution
  await provisionSolution({ sdk, provision, runner, solution: spec.solution });
  
  // Provision data model (entities, columns, relationships)
  // `warn` is threaded so a fallback to the default label LCID is REPORTED here too. This CLI is the
  // genpage create flow's data-model path, so without it a non-English org would hit the same opaque
  // "language code 1033 is not a valid language for this organization" that #447 describes, with no
  // diagnostic — the build path would explain itself and this one would not.
  const dataModel = await provisionDataModel({
    sdk,
    provision,
    runner,
    spec,
    apply: true,
    languageCode: opts.languageCode,
    warn,
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
  // dataModel.entities is { [schemaName]: { logicalName, entitySetName, metadataId? } }
  // We need to convert to the array shape: [{ schemaName, logicalName, entitySetName, metadataId? }]
  const entities = Object.entries(dataModel.entities || {}).map(([schemaName, data]) => ({
    schemaName,
    logicalName: data.logicalName,
    entitySetName: data.entitySetName,
    metadataId: data.metadataId,
  }));
  
  // Build columns array from dataModel.columns (real captured values) with fallback to input-derived
  const columns = [];
  for (const e of spec.entities) {
    const capturedCols = dataModel.columns[e.schemaName] || [];
    const capturedMap = new Map(capturedCols.map((c) => [c.schemaName, c]));
    for (const c of e.columns || []) {
      if (c.type !== 'Lookup') {
        const captured = capturedMap.get(c.schemaName);
        if (captured) {
          columns.push({
            table: e.schemaName.toLowerCase(),
            schemaName: c.schemaName,
            logicalName: captured.logicalName,
            metadataId: captured.metadataId,
          });
        } else {
          // Fallback for existing/uncaptured columns
          columns.push({
            table: e.schemaName.toLowerCase(),
            schemaName: c.schemaName,
            logicalName: c.schemaName.toLowerCase(),
          });
        }
      }
    }
  }
  
  // Build relationships array from dataModel.relationships (real captured values) with fallback to input-derived
  const relationships = [];
  const capturedRelMap = new Map(dataModel.relationships.map((r) => [r.schemaName.toLowerCase(), r]));
  for (const r of spec.relationships || []) {
    let schema;
    if (r.type === 'OneToMany') {
      schema = r.schemaName || `${r.referenced}_${r.referencing}`;
      const captured = capturedRelMap.get(schema.toLowerCase());
      if (captured) {
        relationships.push({
          kind: '1n',
          schemaName: captured.schemaName,
          metadataId: captured.metadataId,
          lookupLogicalName: captured.lookupLogicalName,
        });
      } else {
        // Fallback for existing/uncaptured relationships
        relationships.push({
          kind: '1n',
          schemaName: schema,
        });
      }
    } else if (r.type === 'ManyToMany') {
      schema = r.schemaName || `${r.entity1}_${r.entity2}`;
      const captured = capturedRelMap.get(schema.toLowerCase());
      if (captured) {
        relationships.push({
          kind: 'nn',
          schemaName: captured.schemaName,
          metadataId: captured.metadataId,
        });
      } else {
        // Fallback for existing/uncaptured relationships
        relationships.push({
          kind: 'nn',
          schemaName: schema,
        });
      }
    }
  }
  
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
  // parseArgs represents a value-less flag as boolean true. These are value-bearing flags, so
  // coerce bare `--env` / `--input` to missing and let the usage guard produce the same clear error
  // as an omitted value instead of passing a boolean into auth or path resolution.
  const env = typeof flags.env === 'string' ? flags.env : undefined;
  const inputArg = (typeof flags.input === 'string' ? flags.input : undefined) || (typeof positional[0] === 'string' ? positional[0] : undefined);
  
  if (!env || !inputArg || flags.input === true) {
    process.stderr.write(
      'Usage: node provision-entities.js --env <url> --input @<path> [--apply] [--sample-data] [--language-code|--languageCode <lcid>]\n'
    );
    process.exit(1);
  }
  // A value-less `--language-code` is a usage error, never a silent fall-through to the org default.
  const valuelessLang = ['language-code', 'languageCode'].find((k) => flags[k] === true);
  if (valuelessLang) {
    process.stderr.write(`✗ --${valuelessLang} requires a value.\n`);
    process.exit(1);
  }
  
  const inputPath = path.resolve(typeof inputArg === 'string' && inputArg.startsWith('@') ? inputArg.slice(1) : inputArg);
  const input = readJsonArg('@' + inputPath);
  
  const rawLang = flags['language-code'] ?? flags.languageCode;
  let languageCode;
  if (rawLang !== undefined) {
    languageCode = normalizeLanguageCode(rawLang);
    if (languageCode === null) {
      process.stderr.write(`✗ --language-code / --languageCode must be a positive integer LCID (got '${rawLang}')\n`);
      process.exit(1);
    }
  }

  const opts = {
    apply: flags.apply === true,
    sampleData: flags['sample-data'] === true,
    languageCode,
  };
  
  // Construct SDK clients (offline until first call)
  const { sdk, provision, cleanup } = makeSdk(env, input);

  let r;
  try {
    const deps = {
      log: (m) => process.stderr.write(m + '\n'),
      warn: (m) => process.stderr.write(`⚠ ${m}\n`),
      sdk,
      provision,
    };

    r = await provisionEntities(input, opts, deps);
  } finally {
    cleanup();
  }
  // emitResult() calls process.exit(), so emit AFTER cleanup() has run.
  emitResult(r.ok, r);
}

if (require.main === module) {
  main().catch((err) => emitResult(false, err));
}

module.exports = { provisionEntities };
