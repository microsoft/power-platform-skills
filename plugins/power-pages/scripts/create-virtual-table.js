#!/usr/bin/env node
'use strict';

// Provisions one Dataverse virtual table over one SharePoint list, then verifies
// that the virtual connector provider actually generated its columns.
//
// The connection, connection reference and first data source for a site are built
// by the documented maker wizard - that flow is interactive OAuth and has no
// public API. This script takes the provider and data source ids the platform
// already wrote for that first table (`--seedTable`, or explicit ids from
// list-sharepoint-virtual-sources.js) and repeats the table create for every other
// selected list, so nothing here invents an undocumented contract.
//
// Usage:
//   node create-virtual-table.js --envUrl <url> --projectRoot <path>
//     --schemaName <prefix_Name> --displayName <text> --pluralName <text>
//     --externalName <SharePoint list title>
//     --primaryColumnSchemaName <prefix_Name> --primaryColumnExternalName <SharePoint column>
//     --primaryColumnDisplayName <text>
//     (--seedTable <logicalName> | --dataProviderId <guid> --dataSourceId <guid>)
//     [--site <url>] [--listUrl <url>] [--listId <id>] [--description <text>]
//     [--externalCollectionName <text>] [--solutionUniqueName <name>]
//     [--timeoutMs <ms>] [--pollIntervalMs <ms>] [--dry-run]
//
// Output (JSON to stdout):
//   { "status": "created" | "adopted" | "created-unverified" | "planned",
//     "table": { ... }, "columns": [ ... ], "manifest": "<path>", "nextAction": "..." }
//
// Exit codes: 0 when the table exists in Dataverse (check `status` for whether its
// columns were verified), 1 when the create failed or arguments are invalid.

const {
  getAuthToken,
  makeRequest,
  odataGet,
  validateDataverseEnvironmentUrl,
  UUID_REGEX,
} = require('./lib/validation-helpers');
const {
  API,
  SHAREPOINT_UNSUPPORTED_COLUMN_TYPES,
  WIZARD_DOCS,
  buildVirtualTableDefinition,
  classifyColumns,
  findRecentGenerationJobFailure,
  findSeedTable,
  listVirtualTables,
  readTableColumns,
} = require('./lib/sharepoint-virtual-tables');
const {
  readSharingManifest,
  upsertSharingEntry,
  writeSharingManifest,
} = require('./lib/sharepoint-sharing-map');

const WIZARD_DOC = WIZARD_DOCS.powerPages;

// A Dataverse schema name is `<publisherprefix>_<Name>`; the prefix is 2-8
// alphanumeric characters starting with a letter. Rejecting a bad name here beats
// a 400 from the metadata service that names the wrong field.
const SCHEMA_NAME = /^[A-Za-z][A-Za-z0-9]{1,7}_[A-Za-z][A-Za-z0-9_]*$/;

function getArg(args, name) {
  const index = args.indexOf(`--${name}`);
  return index !== -1 && index + 1 < args.length ? args[index + 1] : null;
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function positiveInt(value, fallback, name) {
  if (value === null) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) fail(`--${name} must be a positive integer, got "${value}".`);
  return parsed;
}

function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

async function postEntityDefinition(envUrl, token, definition, solutionUniqueName) {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'OData-MaxVersion': '4.0',
    'OData-Version': '4.0',
  };
  // Creating the component directly into the target solution avoids a later
  // "add existing" pass and keeps the table out of the Default solution.
  // https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/create-update-entity-definitions-using-web-api
  if (solutionUniqueName) headers['MSCRM.SolutionUniqueName'] = solutionUniqueName;

  const response = await makeRequest({
    url: `${envUrl}/${API}/EntityDefinitions`,
    method: 'POST',
    headers,
    body: JSON.stringify(definition),
    timeout: 60000,
  });
  if (response.error) throw new Error(response.error);
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(describeODataError(response.body, response.statusCode));
  }
}

/**
 * Dataverse metadata errors arrive as:
 *   { "error": { "code": "0x80048408", "message": "..." } }
 * Some surfaces capitalize the envelope, so check both before falling back to
 * the raw body.
 */
function describeODataError(body, statusCode) {
  try {
    const parsed = JSON.parse(body);
    const error = parsed.error || parsed.Error;
    if (error && error.message) return `HTTP ${statusCode}: ${error.message}`;
  } catch {
    // Not JSON - fall through to the truncated raw body.
  }
  return `HTTP ${statusCode}: ${String(body || '').slice(0, 400)}`;
}

async function publishTable(envUrl, token, logicalName) {
  // Publishing is best-effort: the metadata is already live for the Web API, but
  // an unpublished table can stay invisible to designer surfaces the maker will
  // open next. A publish failure must not turn a created table into an error.
  const parameterXml = `<importexportxml><entities><entity>${logicalName}</entity></entities></importexportxml>`;
  const response = await makeRequest({
    url: `${envUrl}/${API}/PublishXml`,
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ParameterXml: parameterXml }),
    timeout: 60000,
  });
  return !response.error && response.statusCode >= 200 && response.statusCode < 300;
}

async function readTable(envUrl, token, logicalName) {
  const url = `${envUrl}/${API}/EntityDefinitions(LogicalName='${encodeURIComponent(logicalName)}')`
    + '?$select=LogicalName,SchemaName,EntitySetName,ExternalName,ExternalCollectionName,DataProviderId,DataSourceId,PrimaryIdAttribute,PrimaryNameAttribute';
  try {
    return await odataGet(url, token);
  } catch (error) {
    if (/HTTP 404/.test(error.message)) return null;
    throw error;
  }
}

/**
 * Waits for the provider's column-generation job. A 204 from the table create
 * only means the definition was accepted; generation runs asynchronously, so the
 * columns are the evidence that the table is usable.
 */
async function waitForGeneratedColumns(envUrl, token, logicalName, { primaryColumnExternalName, timeoutMs, pollIntervalMs }) {
  const deadline = Date.now() + timeoutMs;
  let columns = [];
  for (;;) {
    columns = await readTableColumns(envUrl, token, logicalName);
    // The create declares exactly one externally-mapped column: the primary name.
    // Any other column carrying an external name was written by the provider,
    // including the primary key, which it maps onto the list's hidden `ID`.
    const generated = columns.filter((column) => column.externalName
      && column.externalName !== primaryColumnExternalName);
    if (generated.length > 0) return { columns, verified: true };
    if (Date.now() >= deadline) return { columns, verified: false };
    await sleep(pollIntervalMs);
  }
}

function buildManifestEntry({ args, table, classified, seedTableName, solutionUniqueName, verified }) {
  return {
    source: {
      site: args.site || null,
      listName: args.externalName,
      listUrl: args.listUrl || null,
      listId: args.listId || null,
    },
    table: {
      logicalName: table.LogicalName,
      schemaName: table.SchemaName,
      displayName: args.displayName,
      entitySetName: table.EntitySetName,
      externalName: table.ExternalName || args.externalName,
    },
    provisioning: {
      dataProviderId: table.DataProviderId,
      dataSourceId: table.DataSourceId,
      seedTable: seedTableName || null,
      solutionUniqueName: solutionUniqueName || null,
      createdAt: new Date().toISOString(),
      verified,
    },
    columns: classified.exposable.map((column) => ({
      logicalName: column.logicalName,
      schemaName: column.schemaName,
      externalName: column.externalName,
      attributeType: column.attributeType,
    })),
    providerColumns: classified.providerColumns.map((column) => column.logicalName),
    unsupportedSourceColumnTypes: SHAREPOINT_UNSUPPORTED_COLUMN_TYPES,
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const args = {
    envUrl: getArg(argv, 'envUrl'),
    projectRoot: getArg(argv, 'projectRoot'),
    schemaName: getArg(argv, 'schemaName'),
    displayName: getArg(argv, 'displayName'),
    pluralName: getArg(argv, 'pluralName'),
    externalName: getArg(argv, 'externalName'),
    externalCollectionName: getArg(argv, 'externalCollectionName'),
    description: getArg(argv, 'description'),
    primaryColumnSchemaName: getArg(argv, 'primaryColumnSchemaName'),
    primaryColumnExternalName: getArg(argv, 'primaryColumnExternalName'),
    primaryColumnDisplayName: getArg(argv, 'primaryColumnDisplayName'),
    seedTable: getArg(argv, 'seedTable'),
    dataProviderId: getArg(argv, 'dataProviderId'),
    dataSourceId: getArg(argv, 'dataSourceId'),
    solutionUniqueName: getArg(argv, 'solutionUniqueName'),
    site: getArg(argv, 'site'),
    listUrl: getArg(argv, 'listUrl'),
    listId: getArg(argv, 'listId'),
  };
  const dryRun = argv.includes('--dry-run');
  const timeoutMs = positiveInt(getArg(argv, 'timeoutMs'), 180000, 'timeoutMs');
  const pollIntervalMs = positiveInt(getArg(argv, 'pollIntervalMs'), 5000, 'pollIntervalMs');

  for (const required of ['envUrl', 'projectRoot', 'schemaName', 'displayName', 'pluralName', 'externalName',
    'primaryColumnSchemaName', 'primaryColumnExternalName', 'primaryColumnDisplayName']) {
    if (!args[required]) fail(`Missing required argument: --${required}`);
  }
  if (!SCHEMA_NAME.test(args.schemaName)) fail(`--schemaName must be <publisherprefix>_<Name>, got "${args.schemaName}".`);
  if (!SCHEMA_NAME.test(args.primaryColumnSchemaName)) fail(`--primaryColumnSchemaName must be <publisherprefix>_<Name>, got "${args.primaryColumnSchemaName}".`);
  if (!args.seedTable && !(args.dataProviderId && args.dataSourceId)) {
    fail('Provide --seedTable <logicalName>, or both --dataProviderId and --dataSourceId. '
      + `Run list-sharepoint-virtual-sources.js to find them, or create the site's first table through the wizard: ${WIZARD_DOC}`);
  }
  for (const [name, value] of [['dataProviderId', args.dataProviderId], ['dataSourceId', args.dataSourceId]]) {
    if (value && !UUID_REGEX.test(value)) fail(`--${name} is not a GUID: ${value}`);
  }

  const envUrl = validateDataverseEnvironmentUrl(args.envUrl);
  const logicalName = args.schemaName.toLowerCase();

  // A dry run with explicit ids has nothing to look up, so it stays offline and can
  // show the exact definition while the parent skill's consent gate is still open.
  const needsEnvironment = !dryRun || Boolean(args.seedTable);
  const token = needsEnvironment ? getAuthToken(envUrl) : null;
  if (needsEnvironment && !token) fail('Could not get a Dataverse token. Run `az login --allow-no-subscriptions` first.');

  let { dataProviderId, dataSourceId } = args;
  let seedTableName = null;
  if (args.seedTable) {
    const existing = await listVirtualTables(envUrl, token);
    const seed = findSeedTable(existing.filter((table) => table.logicalName === args.seedTable));
    if (!seed) {
      fail(`--seedTable "${args.seedTable}" is not a virtual table bound to a data source in this environment. `
        + 'Run list-sharepoint-virtual-sources.js to see the candidates.');
    }
    dataProviderId = seed.dataProviderId;
    dataSourceId = seed.dataSourceId;
    seedTableName = seed.logicalName;
  }

  const definition = buildVirtualTableDefinition({
    schemaName: args.schemaName,
    displayName: args.displayName,
    pluralName: args.pluralName,
    description: args.description,
    externalName: args.externalName,
    externalCollectionName: args.externalCollectionName,
    dataProviderId,
    dataSourceId,
    primaryColumnSchemaName: args.primaryColumnSchemaName,
    primaryColumnDisplayName: args.primaryColumnDisplayName,
    primaryColumnExternalName: args.primaryColumnExternalName,
  });

  if (dryRun) {
    process.stdout.write(`${JSON.stringify({ status: 'planned', logicalName, definition }, null, 2)}\n`);
    return;
  }

  // Re-running after a partial failure must not be destructive: an existing
  // virtual table on the same data source is adopted and re-verified instead of
  // recreated, because the parent skill fires its consent gate on every retry.
  const existingTable = await readTable(envUrl, token, logicalName);
  let status = 'created';
  if (existingTable && existingTable.DataSourceId === dataSourceId) {
    status = 'adopted';
  } else if (existingTable) {
    fail(`Table "${logicalName}" already exists but reads from data source ${existingTable.DataSourceId}, `
      + `not ${dataSourceId}. Pick a different schema name or re-create that table through the wizard: ${WIZARD_DOC}`);
  } else {
    await postEntityDefinition(envUrl, token, definition, args.solutionUniqueName);
  }

  const { columns, verified } = await waitForGeneratedColumns(envUrl, token, logicalName, {
    primaryColumnExternalName: args.primaryColumnExternalName, timeoutMs, pollIntervalMs,
  });
  const classified = classifyColumns(columns);
  const table = await readTable(envUrl, token, logicalName);
  if (!table) fail(`Dataverse accepted the create but "${logicalName}" cannot be read back.`);

  const published = await publishTable(envUrl, token, logicalName);

  let jobFailure = null;
  if (!verified) jobFailure = await findRecentGenerationJobFailure(envUrl, token, makeRequest);

  const manifest = readSharingManifest(args.projectRoot);
  const entry = buildManifestEntry({
    args, table, classified, seedTableName, solutionUniqueName: args.solutionUniqueName, verified,
  });
  const manifestFile = writeSharingManifest(args.projectRoot, upsertSharingEntry(manifest, entry));

  process.stdout.write(`${JSON.stringify({
    status: verified ? status : 'created-unverified',
    table: entry.table,
    columns: entry.columns,
    providerColumns: entry.providerColumns,
    published,
    recentGenerationJobFailure: jobFailure,
    manifest: manifestFile,
    nextAction: verified
      ? `Set Webapi/${logicalName}/enabled and an explicit Webapi/${logicalName}/fields list, then create the table permission for the approved web roles.`
      : `The table exists but the provider generated no columns within ${timeoutMs}ms. Check System Jobs for the column-generation job, then re-create the table through the wizard if it failed: ${WIZARD_DOC}`,
  }, null, 2)}\n`);
}

main().catch((error) => fail(`Virtual table provisioning failed: ${error.message}`));
