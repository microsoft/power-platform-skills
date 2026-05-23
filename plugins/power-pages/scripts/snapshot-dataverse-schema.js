#!/usr/bin/env node

// Captures an authoritative snapshot of the Dataverse schema for a defined set of tables
// and writes it as `dataverse-schema-snapshot.json`. The migration pipeline reads this
// snapshot at three points:
//
//   1. Analyze Phase 3 — against the **source** tenant; gives the static analyzer the
//      ground truth of what tables/columns actually exist on the source schema, so it
//      cannot invent column names that look plausible in EDM YAML.
//   2. Analyze Phase 5 — feeds verify-canonical-model-against-dataverse.js so the
//      canonical model only references metadata Dataverse confirms.
//   3. Implement Phase 7.3 — re-snapshot against the **target** tenant before
//      /integrate-webapi writes any `Webapi-<table>-fields.sitesetting.yml`. Schema drift
//      between source and target (renamed columns, missing tables) gets caught here.
//
// Usage:
//   node snapshot-dataverse-schema.js \
//     --tables faq_article,faq_topic,contact \
//     --output ./migration-artifacts/dataverse-schema-snapshot.json \
//     [--envUrl https://org.crm.dynamics.com] \
//     [--include-relationships] [--include-optionsets] [--include-lookups]
//
// When `--envUrl` is omitted the script reads it from `pac env who`. Authentication uses
// Azure CLI via `getAuthToken(envUrl)` — same pattern as dataverse-request.js.
//
// Exit codes:
//   0 — snapshot written
//   1 — fatal error (missing tables flag, no token, network failure for any required call)
//   2 — partial success; some per-table fetches failed. The snapshot is still written
//       and includes an `errors[]` block listing the failing tables. Callers (e.g.
//       verify-canonical-model-against-dataverse.js) refuse to certify a model when the
//       snapshot has errors covering the model's referenced tables.

const fs = require('fs');
const path = require('path');
const {
  getAuthToken,
  getEnvironmentUrl,
} = require('./lib/validation-helpers');
const {
  listTables,
  listTableColumns,
  listTableRelationships,
  listOptionsetValues,
  listLookupTargets,
} = require('./lib/dataverse-metadata');

function parseArgs(argv) {
  // argv shape: ['--tables', 'a,b', '--output', 'x.json', ...]
  const args = { includeRelationships: false, includeOptionsets: false, includeLookups: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    switch (flag) {
      case '--tables':
        args.tables = (argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
        break;
      case '--output':
        args.output = argv[++i];
        break;
      case '--envUrl':
        args.envUrl = argv[++i];
        break;
      case '--include-relationships':
        args.includeRelationships = true;
        break;
      case '--include-optionsets':
        args.includeOptionsets = true;
        break;
      case '--include-lookups':
        args.includeLookups = true;
        break;
      case '--all-metadata':
        // Convenience flag for the migration pipeline — turns on every kind of metadata.
        args.includeRelationships = true;
        args.includeOptionsets = true;
        args.includeLookups = true;
        break;
      default:
        // Unknown args ignored. They might be future flags or stray shell-escaped tokens.
        break;
    }
  }
  return args;
}

// Pure orchestration over the dataverse-metadata helpers. Lifted out of main() so the
// integration test can drive it with a stub `deps` and assert the snapshot shape without
// shelling out a real Node process.
async function buildSnapshot({
  envUrl,
  token,
  tables,
  includeRelationships,
  includeOptionsets,
  includeLookups,
  deps,
}) {
  const helpers = deps || {
    listTables,
    listTableColumns,
    listTableRelationships,
    listOptionsetValues,
    listLookupTargets,
  };

  const snapshot = {
    version: 1,
    capturedAt: new Date().toISOString(),
    envUrl,
    tables: {},
    errors: [],
  };

  // Step 1: get the authoritative list of all tables on the tenant. We don't filter to
  // the requested tables here — we want the full catalog so a "table not found" mismatch
  // is reported with a concrete suggestion (e.g. "did you mean faq_articles?").
  try {
    const allTables = await helpers.listTables({ envUrl, token });
    snapshot.allTables = allTables;
  } catch (e) {
    // Without the table catalog we can still proceed per-table, but the verify script
    // loses its "did you mean" hints. Record and continue.
    snapshot.errors.push({ scope: 'allTables', message: e.message });
    snapshot.allTables = [];
  }

  // Step 2: fetch the per-table metadata in series. Series, not parallel, because the
  // Power Platform metadata endpoints throttle aggressively and a small migration rarely
  // needs more than 5–20 tables — parallel rarely buys time and reliably trips 429s.
  for (const table of tables) {
    const entry = { columns: null };
    try {
      entry.columns = await helpers.listTableColumns({ envUrl, token, table });
    } catch (e) {
      const errorEntry = { scope: 'columns', table, message: e.message };
      if (e.code) errorEntry.code = e.code;
      snapshot.errors.push(errorEntry);
    }

    if (includeRelationships) {
      try {
        entry.relationships = await helpers.listTableRelationships({ envUrl, token, table });
      } catch (e) {
        snapshot.errors.push({ scope: 'relationships', table, message: e.message });
      }
    }

    if (includeOptionsets && entry.columns) {
      // Only fetch optionset values for columns that actually report a Picklist/State/
      // Status type — saves a couple of round trips per non-choice column.
      const choiceTypes = new Set(['Picklist', 'State', 'Status', 'MultiSelectPicklist']);
      const choiceCastByType = {
        Picklist: 'PicklistAttributeMetadata',
        State: 'StateAttributeMetadata',
        Status: 'StatusAttributeMetadata',
        MultiSelectPicklist: 'MultiSelectPicklistAttributeMetadata',
      };
      entry.optionsets = {};
      for (const col of entry.columns) {
        if (!choiceTypes.has(col.attributeType)) continue;
        try {
          entry.optionsets[col.logicalName] = await helpers.listOptionsetValues({
            envUrl,
            token,
            table,
            column: col.logicalName,
            castType: choiceCastByType[col.attributeType],
          });
        } catch (e) {
          snapshot.errors.push({
            scope: 'optionset',
            table,
            column: col.logicalName,
            message: e.message,
          });
        }
      }
    }

    if (includeLookups && entry.columns) {
      // Only Lookup, Customer, and Owner are polymorphic-target attributes. Skip everything
      // else so we don't spam the API with 404s for non-lookup columns.
      const lookupTypes = new Set(['Lookup', 'Customer', 'Owner']);
      entry.lookups = {};
      for (const col of entry.columns) {
        if (!lookupTypes.has(col.attributeType)) continue;
        try {
          entry.lookups[col.logicalName] = await helpers.listLookupTargets({
            envUrl,
            token,
            table,
            column: col.logicalName,
          });
        } catch (e) {
          snapshot.errors.push({
            scope: 'lookup',
            table,
            column: col.logicalName,
            message: e.message,
          });
        }
      }
    }

    snapshot.tables[table] = entry;
  }

  return snapshot;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.tables || args.tables.length === 0) {
    process.stderr.write('Usage: snapshot-dataverse-schema.js --tables a,b,c --output path.json\n');
    process.exit(1);
  }
  if (!args.output) {
    process.stderr.write('Missing --output path\n');
    process.exit(1);
  }

  let envUrl = args.envUrl;
  if (!envUrl) {
    envUrl = getEnvironmentUrl();
    if (!envUrl) {
      process.stderr.write(
        'Could not determine Dataverse environment URL. Pass --envUrl or run `pac env who` to set one.\n',
      );
      process.exit(1);
    }
  }

  const token = getAuthToken(envUrl);
  if (!token) {
    process.stderr.write(
      'Could not acquire Azure CLI token. Run `az login --allow-no-subscriptions` first.\n',
    );
    process.exit(1);
  }

  const snapshot = await buildSnapshot({
    envUrl,
    token,
    tables: args.tables,
    includeRelationships: args.includeRelationships,
    includeOptionsets: args.includeOptionsets,
    includeLookups: args.includeLookups,
  });

  fs.mkdirSync(path.dirname(path.resolve(args.output)), { recursive: true });
  fs.writeFileSync(args.output, JSON.stringify(snapshot, null, 2));

  // The exit code carries the partial-vs-clean signal so the migration's Phase 8 gates
  // can branch without re-parsing the JSON.
  if (snapshot.errors.length > 0) {
    process.stderr.write(`Snapshot wrote ${snapshot.errors.length} error(s) — see ${args.output}\n`);
    process.exit(2);
  }
  process.stdout.write(JSON.stringify({ ok: true, output: args.output, tables: args.tables.length }));
  process.exit(0);
}

if (require.main === module) {
  main().catch((e) => {
    process.stderr.write(`snapshot-dataverse-schema failed: ${e.message}\n`);
    process.exit(1);
  });
}

module.exports = { parseArgs, buildSnapshot };
