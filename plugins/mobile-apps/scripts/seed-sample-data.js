#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--allow-partial') {
      args.allowPartial = true;
    } else if (arg.startsWith('--') && argv[i + 1]) {
      args[arg.slice(2)] = argv[++i];
    }
  }
  return args;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, file);
}

function stableKey(table, businessKey) {
  const entries = Object.entries(businessKey || {}).sort(([a], [b]) => a.localeCompare(b));
  return `${table}:${JSON.stringify(Object.fromEntries(entries))}`;
}

function odataLiteral(value) {
  if (typeof value === 'string') return `'${value.replace(/'/g, "''")}'`;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  throw new TypeError(`Unsupported business-key value: ${JSON.stringify(value)}`);
}

function businessKeyFilter(businessKey) {
  const entries = Object.entries(businessKey || {});
  if (entries.length === 0) throw new Error('Every sample row requires a non-empty businessKey');
  return entries.map(([column, value]) => `${column} eq ${odataLiteral(value)}`).join(' and ');
}

function createJournal(plan, environmentUrl, solution) {
  return {
    version: 1,
    runId: plan.runId || `sample-data-${Date.now()}`,
    environmentUrl,
    solution: solution || null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    records: {},
  };
}

function loadJournal(file, plan, environmentUrl, solution) {
  if (!fs.existsSync(file)) return createJournal(plan, environmentUrl, solution);
  const journal = readJson(file);
  if (journal.environmentUrl !== environmentUrl) {
    throw new Error(`Journal environment mismatch: ${journal.environmentUrl} != ${environmentUrl}`);
  }
  if ((journal.solution || null) !== (solution || null)) {
    throw new Error(`Journal solution mismatch: ${journal.solution || '<none>'} != ${solution || '<none>'}`);
  }
  journal.records ||= {};
  return journal;
}

function validatePlan(plan) {
  if (!plan || !Array.isArray(plan.tables) || plan.tables.length === 0) {
    throw new Error('Seed plan must contain a non-empty tables array');
  }
  const names = new Set(plan.tables.map((table) => table.logicalName));
  for (const table of plan.tables) {
    if (!table.logicalName || !table.entitySetName || !table.primaryIdColumn) {
      throw new Error('Each table requires logicalName, entitySetName, and primaryIdColumn');
    }
    if (!Number.isInteger(table.tier) || table.tier < 0) {
      throw new Error(`${table.logicalName} requires a non-negative integer tier`);
    }
    if (!Array.isArray(table.rows) || table.rows.length === 0) {
      throw new Error(`${table.logicalName} requires at least one row`);
    }
    for (const row of table.rows) {
      businessKeyFilter(row.businessKey);
      row.body ||= {};
      for (const [column, value] of Object.entries(row.businessKey)) {
        if (!(column in row.body)) {
          throw new Error(`${table.logicalName} business-key column ${column} must be present in body`);
        }
        if (row.body[column] !== value) {
          throw new Error(`${table.logicalName} business-key column ${column} does not match body`);
        }
      }
      for (const required of table.requiredColumns || []) {
        const suppliedByLookup = (row.lookups || []).some((lookup) => lookup.property === required);
        if (!(required in row.body) && !suppliedByLookup) {
          throw new Error(`${table.logicalName} ${stableKey(table.logicalName, row.businessKey)} is missing required column ${required}`);
        }
      }
      for (const lookup of row.lookups || []) {
        if (!lookup.property || !lookup.targetTable || !lookup.businessKey) {
          throw new Error(`${table.logicalName} has an invalid lookup dependency`);
        }
        if (!names.has(lookup.targetTable) &&
            (!lookup.targetEntitySetName || !lookup.targetPrimaryIdColumn)) {
          throw new Error(`${table.logicalName} lookup ${lookup.property} needs targetEntitySetName and targetPrimaryIdColumn for external table ${lookup.targetTable}`);
        }
      }
    }
  }
}

async function batchRead(request, label, descriptors) {
  if (descriptors.length === 0) return [];
  const operations = descriptors.map((descriptor, index) => ({
    index,
    apiPath: descriptor.apiPath,
  }));
  const response = await request('BATCH-READS', label, operations);
  if (response.status < 200 || response.status >= 300 || !Array.isArray(response.data)) {
    throw new Error(`${label} failed: ${response.error || response.status}`);
  }
  const byIndex = new Map(response.data.map((result) => [result.index, result]));
  return descriptors.map((descriptor, index) => ({
    descriptor,
    result: byIndex.get(index) || {
      index,
      status: 0,
      error: 'Batch read omitted an operation result',
    },
  }));
}

async function discoverChoiceValues(request, tables) {
  const descriptors = [];
  for (const table of tables) {
    for (const column of table.choiceColumns || []) {
      descriptors.push({
        table,
        column,
        apiPath: `EntityDefinitions(LogicalName='${table.logicalName}')/Attributes(LogicalName='${column}')/Microsoft.Dynamics.CRM.PicklistAttributeMetadata?$expand=OptionSet`,
      });
    }
  }

  const discovered = new Map(tables.map((table) => [table.logicalName, {}]));
  const reads = await batchRead(request, 'Sample choice metadata', descriptors);
  for (const { descriptor, result } of reads) {
    if (result.status < 200 || result.status >= 300) {
      throw new Error(`Choice metadata unavailable for ${descriptor.table.logicalName}.${descriptor.column}: ${result.error || result.status}`);
    }
    discovered.get(descriptor.table.logicalName)[descriptor.column] =
      new Set((result.data?.OptionSet?.Options || []).map((option) => option.Value));
  }
  return discovered;
}

function validateChoiceValues(table, choiceValues) {
  for (const row of table.rows) {
    for (const [column, allowed] of Object.entries(choiceValues)) {
      if (!(column in row.body)) continue;
      if (!allowed.has(row.body[column])) {
        throw new Error(`${table.logicalName}.${column} value ${row.body[column]} is not present in live metadata`);
      }
    }
  }
}

function existingReadDescriptor(table, businessKey) {
  const select = [table.primaryIdColumn, ...Object.keys(businessKey)].join(',');
  const filter = businessKeyFilter(businessKey);
  return {
    key: stableKey(table.logicalName, businessKey),
    table,
    businessKey,
    apiPath: `${table.entitySetName}?$select=${select}&$filter=${encodeURIComponent(filter)}&$top=2`,
  };
}

async function findExistingBatch(request, label, descriptors) {
  const unique = [...new Map(descriptors.map((descriptor) => [descriptor.key, descriptor])).values()];
  const reads = await batchRead(request, label, unique);
  const found = new Map();
  for (const { descriptor, result } of reads) {
    if (result.status < 200 || result.status >= 300) {
      throw new Error(`Business-key lookup failed for ${descriptor.key}: ${result.error || result.status}`);
    }
    const rows = result.data?.value || [];
    if (rows.length > 1) {
      throw new Error(`Business key is not unique for ${descriptor.key}`);
    }
    found.set(descriptor.key, rows[0] || null);
  }
  return found;
}

function blockPending(journal, summary, persist, error) {
  const message = error instanceof Error ? error.message : String(error);
  for (const entry of Object.values(journal.records)) {
    if (entry.status !== 'pending') continue;
    entry.status = 'blocked';
    entry.error = message;
    entry.updatedAt = new Date().toISOString();
    summary.blocked += 1;
  }
  journal.updatedAt = new Date().toISOString();
  persist(journal);
}

async function executeSeedPlan(plan, options) {
  validatePlan(plan);
  const journal = options.journal;
  const byTable = new Map(plan.tables.map((table) => [table.logicalName, table]));
  const resolved = new Map();
  const requested = plan.tables.reduce((count, table) => count + table.rows.length, 0);
  const summary = { requested, created: 0, reused: 0, failed: 0, blocked: 0, skipped: 0 };

  for (const table of plan.tables) {
    for (const row of table.rows) {
      const key = stableKey(table.logicalName, row.businessKey);
      journal.records[key] ||= {
        table: table.logicalName,
        businessKey: row.businessKey,
        status: 'pending',
        attempts: 0,
        updatedAt: new Date().toISOString(),
      };
    }
  }
  options.persist(journal);

  try {
    const choiceValues = await discoverChoiceValues(options.request, plan.tables);
    for (const table of plan.tables) {
      validateChoiceValues(table, choiceValues.get(table.logicalName));
    }
  } catch (error) {
    blockPending(journal, summary, options.persist, error);
    throw error;
  }

  const tiers = [...new Set(plan.tables.map((table) => table.tier))].sort((a, b) => a - b);
  for (const tier of tiers) {
    const operations = [];
    const operationRows = [];
    const tierTables = plan.tables.filter((table) => table.tier === tier);
    const rowDescriptors = [];
    for (const table of tierTables) {
      for (const row of table.rows) {
        rowDescriptors.push(existingReadDescriptor(table, row.businessKey));
      }
    }

    let existingRows;
    try {
      existingRows = await findExistingBatch(
        options.request,
        `Sample data tier ${tier} business keys`,
        rowDescriptors,
      );
    } catch (error) {
      blockPending(journal, summary, options.persist, error);
      throw error;
    }

    const pendingRows = [];
    for (const table of tierTables) {
      for (const row of table.rows) {
        const key = stableKey(table.logicalName, row.businessKey);
        const existing = existingRows.get(key);
        if (existing) {
          const recordId = existing[table.primaryIdColumn];
          resolved.set(key, { table, recordId });
          journal.records[key] = {
            table: table.logicalName,
            businessKey: row.businessKey,
            status: 'reused',
            recordId,
            attempts: journal.records[key]?.attempts || 0,
            updatedAt: new Date().toISOString(),
          };
          summary.reused += 1;
          continue;
        }
        pendingRows.push({ table, row, key });
      }
    }

    const lookupDescriptors = [];
    for (const { row } of pendingRows) {
      for (const lookup of row.lookups || []) {
        const targetKey = stableKey(lookup.targetTable, lookup.businessKey);
        if (resolved.has(targetKey)) continue;
        const target = byTable.get(lookup.targetTable) || {
          logicalName: lookup.targetTable,
          entitySetName: lookup.targetEntitySetName,
          primaryIdColumn: lookup.targetPrimaryIdColumn,
        };
        lookupDescriptors.push(existingReadDescriptor(target, lookup.businessKey));
      }
    }

    let existingLookups;
    try {
      existingLookups = await findExistingBatch(
        options.request,
        `Sample data tier ${tier} lookup dependencies`,
        lookupDescriptors,
      );
    } catch (error) {
      blockPending(journal, summary, options.persist, error);
      throw error;
    }

    for (const { table, row, key } of pendingRows) {
      const body = { ...row.body };
      let blockedReason = null;
      for (const lookup of row.lookups || []) {
        const target = byTable.get(lookup.targetTable) || {
          logicalName: lookup.targetTable,
          entitySetName: lookup.targetEntitySetName,
          primaryIdColumn: lookup.targetPrimaryIdColumn,
        };
        const targetKey = stableKey(lookup.targetTable, lookup.businessKey);
        let targetRecord = resolved.get(targetKey);
        if (!targetRecord) {
          const targetExisting = existingLookups.get(targetKey);
          if (targetExisting) {
            targetRecord = { table: target, recordId: targetExisting[target.primaryIdColumn] };
            resolved.set(targetKey, targetRecord);
          }
        }
        if (!targetRecord) {
          blockedReason = `Required parent ${targetKey} was not created or found`;
          break;
        }
        body[`${lookup.property}@odata.bind`] =
          `/${target.entitySetName}(${targetRecord.recordId})`;
      }

      if (blockedReason) {
        journal.records[key] = {
          table: table.logicalName,
          businessKey: row.businessKey,
          status: 'blocked',
          error: blockedReason,
          attempts: journal.records[key]?.attempts || 0,
          updatedAt: new Date().toISOString(),
        };
        summary.blocked += 1;
        continue;
      }

      operations.push({ index: operations.length, entitySet: table.entitySetName, body });
      operationRows.push({ table, row, key });
    }

    if (operations.length > 0) {
      let response;
      try {
        response = await options.request('BATCH-RECORDS', `Sample data tier ${tier}`, operations);
        if (response.status < 200 || response.status >= 300 || !Array.isArray(response.data)) {
          throw new Error(`Tier ${tier} batch failed: ${response.error || response.status}`);
        }
      } catch (error) {
        blockPending(journal, summary, options.persist, error);
        throw error;
      }
      for (const result of response.data) {
        const context = operationRows[result.index];
        const previousAttempts = journal.records[context.key]?.attempts || 0;
        if (result.status >= 200 && result.status < 300 && result.recordId) {
          resolved.set(context.key, { table: context.table, recordId: result.recordId });
          journal.records[context.key] = {
            table: context.table.logicalName,
            businessKey: context.row.businessKey,
            status: 'created',
            recordId: result.recordId,
            attempts: previousAttempts + 1,
            updatedAt: new Date().toISOString(),
          };
          summary.created += 1;
        } else {
          journal.records[context.key] = {
            table: context.table.logicalName,
            businessKey: context.row.businessKey,
            status: 'failed',
            error: result.error || `HTTP ${result.status}`,
            attempts: previousAttempts + 1,
            updatedAt: new Date().toISOString(),
          };
          summary.failed += 1;
        }
      }
    }

    journal.updatedAt = new Date().toISOString();
    options.persist(journal);
    if (!options.allowPartial && (summary.failed > 0 || summary.blocked > 0)) {
      for (const entry of Object.values(journal.records)) {
        if (entry.status !== 'pending') continue;
        entry.status = 'blocked';
        entry.error = `Not attempted because dependency tier ${tier} did not complete`;
        entry.updatedAt = new Date().toISOString();
        summary.blocked += 1;
      }
      options.persist(journal);
      break;
    }
  }

  const concerns = summary.failed + summary.blocked;
  return {
    status: concerns === 0 ? 'DONE' : options.allowPartial ? 'DONE_WITH_CONCERNS' : 'BLOCKED',
    summary,
    records: Object.values(journal.records),
  };
}

function createCliRequest(args) {
  const script = path.join(__dirname, 'dataverse-request.js');
  return async (method, apiPath, operations) => {
    const command = [script, args['env-url'], method, apiPath];
    if (method === 'BATCH-READS' || method === 'BATCH-RECORDS') {
      command.push('--operations', JSON.stringify(operations), '--concurrency', args.concurrency || '5');
    }
    if (args.solution) command.push('--solution', args.solution);
    if (args['tenant-id']) command.push('--tenant-id', args['tenant-id']);
    const stdout = execFileSync(process.execPath, command, { encoding: 'utf8' });
    return JSON.parse(stdout.trim());
  };
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.plan || !args['env-url']) {
    process.stderr.write('Usage: node seed-sample-data.js --plan <json> --env-url <url> [--journal <path>] [--solution <name>] [--tenant-id <id>] [--allow-partial]\n');
    process.exit(1);
  }
  const planPath = path.resolve(args.plan);
  const journalPath = path.resolve(args.journal || path.join(path.dirname(planPath), '.sample-data-journal.json'));
  const plan = readJson(planPath);
  const journal = loadJournal(journalPath, plan, args['env-url'], args.solution);
  const result = await executeSeedPlan(plan, {
    request: createCliRequest(args),
    journal,
    allowPartial: Boolean(args.allowPartial),
    persist: (value) => atomicWriteJson(journalPath, value),
  });
  console.log(JSON.stringify({ ...result, journalPath }, null, 2));
  if (result.status === 'BLOCKED') process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
}

module.exports = {
  atomicWriteJson,
  businessKeyFilter,
  executeSeedPlan,
  loadJournal,
  stableKey,
  validatePlan,
};
