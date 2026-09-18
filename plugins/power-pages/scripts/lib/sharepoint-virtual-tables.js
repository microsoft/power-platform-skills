'use strict';

// Dataverse virtual tables backed by the SharePoint virtual connector provider.
//
// Shared by list-sharepoint-virtual-sources.js (read-only environment discovery)
// and create-virtual-table.js (provisioning). Everything here talks to documented
// Dataverse surfaces only:
//   - entitydataproviders        https://learn.microsoft.com/en-us/power-apps/developer/data-platform/reference/entities/entitydataprovider
//   - msdyn_connectordatasources https://learn.microsoft.com/en-us/power-apps/developer/data-platform/reference/entities/msdyn_connectordatasource
//   - EntityDefinitions          https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/create-update-entity-definitions-using-web-api
//   - asyncoperations            https://learn.microsoft.com/en-us/power-apps/developer/data-platform/reference/entities/asyncoperation
//
// The maker-facing wizard that builds the connection, the connection reference and
// the first data source is NOT a public API, so nothing here tries to reproduce it.
// See references/sharepoint-migration.md for where the wizard stays in the loop.

const helpers = require('./validation-helpers');

const API = 'api/data/v9.2';

/** Dataverse returns this instead of null for an unset Guid metadata property. */
const EMPTY_GUID = '00000000-0000-0000-0000-000000000000';

/**
 * Data provider records whose `datasourcelogicalname` is the virtual connector
 * data source table belong to the Virtual Connector Provider solution. That
 * column is the documented link between a provider and the table holding its
 * configuration rows, so it identifies connector providers without matching on
 * a display name the solution is free to change.
 */
const CONNECTOR_DATA_SOURCE_TABLE = 'msdyn_connectordatasource';

/**
 * SharePoint column types the virtual connector provider cannot project into a
 * Dataverse column. A selected list that carries business meaning in one of
 * these loses it silently - the table is still created, just without the column.
 * https://learn.microsoft.com/en-us/power-apps/maker/data-platform/limits-tshoot-virtual-tables
 */
const SHAREPOINT_UNSUPPORTED_COLUMN_TYPES = Object.freeze([
  'Person or Group',
  'Image',
  'Managed metadata',
  'Location (coordinates)',
  'Attachment',
]);

/**
 * SharePoint-specific columns the provider surfaces on every generated table.
 * `ID` is the external primary key and `ComplianceAssetId` is a SharePoint
 * bookkeeping column; neither is portal content, so both stay out of the Web API
 * allowlist unless the maker asks for them explicitly.
 * https://learn.microsoft.com/en-us/power-apps/maker/data-platform/limits-tshoot-virtual-tables
 */
const SHAREPOINT_PROVIDER_COLUMNS = Object.freeze(['ID', 'ComplianceAssetId']);

/** A virtual-table query is limited to this many records. */
const VIRTUAL_TABLE_QUERY_ROW_LIMIT = 1000;

/** Maximum characters a virtual text column can carry through Dataverse. */
const VIRTUAL_TEXT_MAX_LENGTH = 4000;

/**
 * The async job the Virtual Connector Provider runs to generate a new virtual
 * table's columns. Named in the official troubleshooting guide, which instructs
 * makers to look it up in System Jobs when a table is created but empty.
 * https://learn.microsoft.com/en-us/power-apps/maker/data-platform/limits-tshoot-virtual-tables
 */
const GENERATE_PLUGIN_JOB_PREFIX = 'Microsoft.Wrm.DataProvider.Connector.Plugins.ConnectorGenerateVEPlugin';

function base(envUrl) {
  return String(envUrl).replace(/\/+$/, '');
}

/**
 * Lists the environment's virtual connector data providers.
 * Each row is a candidate `DataProviderId` for a connector-backed virtual table.
 */
async function listConnectorDataProviders(envUrl, token, request = helpers.makeRequest) {
  const url = `${base(envUrl)}/${API}/entitydataproviders`
    + '?$select=entitydataproviderid,name,datasourcelogicalname';
  const rows = await helpers.odataGetAll(url, token, request);
  return rows
    .filter((row) => row && row.datasourcelogicalname === CONNECTOR_DATA_SOURCE_TABLE)
    .map((row) => ({
      dataProviderId: row.entitydataproviderid,
      name: row.name || '(unnamed)',
    }));
}

/**
 * Lists the virtual connector data source rows. The wizard names these
 * `VCP_DS_<something>`; `msdyn_connectortype` distinguishes SharePoint rows from
 * SQL/Salesforce/Oracle rows sharing the same table.
 *
 * `msdyn_dataset_value` holds the selected dataset - for SharePoint that is the
 * site the wizard was pointed at. It is reported for the maker to confirm, never
 * used as the authority for which site a table reads from; only the platform's
 * own `DataSourceId` binding is authoritative.
 */
async function listConnectorDataSources(envUrl, token, request = helpers.makeRequest) {
  const url = `${base(envUrl)}/${API}/msdyn_connectordatasources`
    + '?$select=msdyn_connectordatasourceid,msdyn_name,msdyn_connectortype,msdyn_dataset_value,msdyn_connectionreference';
  const rows = await helpers.odataGetAll(url, token, request);
  return rows.map((row) => ({
    dataSourceId: row.msdyn_connectordatasourceid,
    name: row.msdyn_name || '(unnamed)',
    connectorType: row.msdyn_connectortype || null,
    dataset: row.msdyn_dataset_value || null,
    connectionReference: row.msdyn_connectionreference || null,
  }));
}

/** True when a data source row was created for the SharePoint connector. */
function isSharePointDataSource(dataSource) {
  const type = dataSource && dataSource.connectorType;
  return typeof type === 'string' && /sharepoint/i.test(type);
}

/**
 * Lists every custom table bound to a data provider - that is, every virtual
 * table in the environment.
 *
 * `EntityDefinitions` accepts only a narrow `$filter` grammar, so `IsCustomEntity`
 * is filtered server-side and the provider binding client-side. The same split is
 * used by lib/query-metadata.js.
 */
async function listVirtualTables(envUrl, token, request = helpers.makeRequest) {
  const url = `${base(envUrl)}/${API}/EntityDefinitions`
    + '?$select=LogicalName,SchemaName,EntitySetName,DisplayName,ExternalName,ExternalCollectionName,'
    + 'DataProviderId,DataSourceId,IsCustomEntity,IsManaged,PrimaryIdAttribute,PrimaryNameAttribute'
    + '&$filter=IsCustomEntity eq true';
  const rows = await helpers.odataGetAll(url, token, request);
  return rows
    .filter((row) => row && row.DataProviderId && row.DataProviderId !== EMPTY_GUID)
    .map(toVirtualTable);
}

function toVirtualTable(row) {
  return {
    logicalName: row.LogicalName,
    schemaName: row.SchemaName,
    entitySetName: row.EntitySetName,
    displayName: (row.DisplayName && row.DisplayName.UserLocalizedLabel && row.DisplayName.UserLocalizedLabel.Label)
      || row.SchemaName,
    externalName: row.ExternalName || null,
    externalCollectionName: row.ExternalCollectionName || null,
    dataProviderId: row.DataProviderId,
    dataSourceId: row.DataSourceId && row.DataSourceId !== EMPTY_GUID ? row.DataSourceId : null,
    primaryIdAttribute: row.PrimaryIdAttribute,
    primaryNameAttribute: row.PrimaryNameAttribute,
    isManaged: row.IsManaged === true,
  };
}

/**
 * Picks an existing virtual table to copy provider/data-source ids from.
 *
 * The wizard is the only supported way to create the first table for a site
 * because it also creates the connection and the data source. Once one exists,
 * every other list on that site reuses the exact ids the platform already wrote,
 * so provisioning never has to guess a provider id or a data source shape.
 */
function findSeedTable(virtualTables, { dataSourceId = null, dataProviderId = null } = {}) {
  const candidates = virtualTables.filter((table) => table.dataSourceId
    && (!dataSourceId || table.dataSourceId === dataSourceId)
    && (!dataProviderId || table.dataProviderId === dataProviderId));
  // Prefer an unmanaged table: a managed one belongs to an imported solution and
  // its data source may be bound to an environment-variable value this
  // environment has not set.
  return candidates.find((table) => !table.isManaged) || candidates[0] || null;
}

/**
 * Builds the `EntityDefinitions` POST body for one SharePoint list.
 *
 * Pure so the payload shape is unit-testable without an environment. Only the
 * primary name column is declared: the virtual connector provider's generate job
 * adds the remaining columns from the list's own schema after the table exists.
 */
function buildVirtualTableDefinition({
  schemaName,
  displayName,
  pluralName,
  description = null,
  externalName,
  externalCollectionName = null,
  dataProviderId,
  dataSourceId,
  primaryColumnSchemaName,
  primaryColumnDisplayName,
  primaryColumnExternalName,
  primaryColumnMaxLength = 200,
  languageCode = 1033,
}) {
  for (const [name, value] of Object.entries({
    schemaName, displayName, pluralName, externalName, dataProviderId, dataSourceId,
    primaryColumnSchemaName, primaryColumnDisplayName, primaryColumnExternalName,
  })) {
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error(`buildVirtualTableDefinition requires a non-empty ${name}.`);
    }
  }
  if (primaryColumnMaxLength > VIRTUAL_TEXT_MAX_LENGTH) {
    throw new Error(`A virtual text column cannot exceed ${VIRTUAL_TEXT_MAX_LENGTH} characters.`);
  }

  return {
    '@odata.type': 'Microsoft.Dynamics.CRM.EntityMetadata',
    SchemaName: schemaName,
    DisplayName: label(displayName, languageCode),
    DisplayCollectionName: label(pluralName, languageCode),
    ...(description ? { Description: label(description, languageCode) } : {}),
    HasActivities: false,
    HasNotes: false,
    IsActivity: false,
    // Virtual tables are organization-owned; user/team ownership and the row
    // filtering that comes with it are not supported, which is why every access
    // decision has to be made by Power Pages table permissions instead.
    OwnershipType: 'OrganizationOwned',
    DataProviderId: dataProviderId,
    DataSourceId: dataSourceId,
    ExternalName: externalName,
    ExternalCollectionName: externalCollectionName || externalName,
    Attributes: [
      {
        '@odata.type': 'Microsoft.Dynamics.CRM.StringAttributeMetadata',
        AttributeType: 'String',
        AttributeTypeName: { Value: 'StringType' },
        FormatName: { Value: 'Text' },
        IsPrimaryName: true,
        MaxLength: primaryColumnMaxLength,
        RequiredLevel: {
          Value: 'None',
          CanBeChanged: true,
          ManagedPropertyLogicalName: 'canmodifyrequirementlevelsettings',
        },
        SchemaName: primaryColumnSchemaName,
        ExternalName: primaryColumnExternalName,
        DisplayName: label(primaryColumnDisplayName, languageCode),
      },
    ],
  };
}

function label(text, languageCode) {
  return {
    '@odata.type': 'Microsoft.Dynamics.CRM.Label',
    LocalizedLabels: [{
      '@odata.type': 'Microsoft.Dynamics.CRM.LocalizedLabel',
      Label: text,
      LanguageCode: languageCode,
    }],
  };
}

/** Reads one table's columns, with the SharePoint external name for each. */
async function readTableColumns(envUrl, token, logicalName, request = helpers.makeRequest) {
  const url = `${base(envUrl)}/${API}/EntityDefinitions(LogicalName='${encodeURIComponent(logicalName)}')`
    + '/Attributes?$select=LogicalName,SchemaName,ExternalName,AttributeType,IsPrimaryId,IsPrimaryName,IsValidForRead,IsCustomAttribute';
  const rows = await helpers.odataGetAll(url, token, request);
  return rows.map((row) => ({
    logicalName: row.LogicalName,
    schemaName: row.SchemaName,
    externalName: row.ExternalName || null,
    attributeType: row.AttributeType,
    isPrimaryId: row.IsPrimaryId === true,
    isPrimaryName: row.IsPrimaryName === true,
    isReadable: row.IsValidForRead !== false,
  }));
}

/**
 * Splits a generated table's columns into the three groups the sharing decision
 * needs: what a portal page can actually show, what belongs to the provider, and
 * what Dataverse cannot read back.
 */
function classifyColumns(columns) {
  const providerColumns = [];
  const unreadable = [];
  const exposable = [];
  for (const column of columns) {
    if (column.isPrimaryId || SHAREPOINT_PROVIDER_COLUMNS.includes(column.externalName)) {
      providerColumns.push(column);
    } else if (!column.isReadable) {
      unreadable.push(column);
    } else {
      exposable.push(column);
    }
  }
  return { exposable, providerColumns, unreadable };
}

/**
 * Returns the most recent failed column-generation job in the environment.
 *
 * Dataverse accepts the table create and runs generation asynchronously, so a 204
 * from the POST is not evidence that the table has usable columns. The job's
 * `name` is the plugin class; the table it ran for is in the polymorphic
 * `regardingobjectid`, which the Web API cannot filter on by name. So this is a
 * lead for the maker to follow in System Jobs, not proof about a specific table -
 * callers must present it that way.
 */
async function findRecentGenerationJobFailure(envUrl, token, request = helpers.makeRequest) {
  const url = `${base(envUrl)}/${API}/asyncoperations`
    + '?$select=asyncoperationid,name,statecode,statuscode,message,friendlymessage,createdon'
    + `&$filter=startswith(name,'${GENERATE_PLUGIN_JOB_PREFIX}')`
    + '&$orderby=createdon desc&$top=20';
  let rows;
  try {
    rows = (await helpers.odataGet(url, token, request)).value || [];
  } catch {
    // A caller without read access to system jobs still gets the column read-back
    // verdict; losing the job detail must not turn a created table into an error.
    return null;
  }
  // asyncoperation terminal states: statecode 3 (Completed) with statuscode 30
  // (Succeeded); 31 is Failed and 32 is Canceled.
  // https://learn.microsoft.com/en-us/power-apps/developer/data-platform/reference/entities/asyncoperation
  const failed = rows.find((row) => [31, 32].includes(row.statuscode));
  if (!failed) return null;
  return {
    asyncJobId: failed.asyncoperationid,
    statusCode: failed.statuscode,
    createdOn: failed.createdon || null,
    message: failed.friendlymessage || failed.message || 'The column-generation job did not succeed.',
    note: 'Most recent failed column-generation job in this environment. Confirm its Regarding value in System Jobs before attributing it to this table.',
  };
}

/**
 * The wizard's own navigation, quoted so the maker can find it wherever the deep
 * link lands. Both surfaces run the same virtual connector provider flow.
 * https://learn.microsoft.com/en-us/power-pages/configure/data-workspace-virtual-tables
 * https://learn.microsoft.com/en-us/power-apps/maker/data-platform/create-virtual-tables-using-connectors
 */
const WIZARD_BREADCRUMBS = Object.freeze({
  powerApps: 'Solutions > open the approved unmanaged solution > New > Table > Virtual table',
  powerPages: 'Power Pages design studio > Data workspace > + Table > New table from external data',
});

const WIZARD_DOCS = Object.freeze({
  powerApps: 'https://learn.microsoft.com/en-us/power-apps/maker/data-platform/create-virtual-tables-using-connectors',
  powerPages: 'https://learn.microsoft.com/en-us/power-pages/configure/data-workspace-virtual-tables',
});

/**
 * Builds the page to open for the maker so they land in the right environment
 * instead of picking one from a tenant-wide list.
 *
 * Maker-portal routing below the host is product UI, not a documented API, so the
 * environment deep link is a convenience and never the evidence that the wizard
 * ran: callers confirm the outcome by re-reading the environment. Without a known
 * environment id this returns the portal root rather than guessing a route.
 */
function makerPortalWizardUrl({ cloud = 'Public', environmentId = null } = {}) {
  const host = helpers.CLOUD_TO_MAKER_HOST[cloud] || helpers.CLOUD_TO_MAKER_HOST.Public;
  if (!environmentId || !helpers.UUID_REGEX.test(environmentId)) {
    return { url: `https://${host}/`, environmentScoped: false, cloud };
  }
  return { url: `https://${host}/environments/${environmentId}/solutions`, environmentScoped: true, cloud };
}

module.exports = {
  API,
  CONNECTOR_DATA_SOURCE_TABLE,
  EMPTY_GUID,
  GENERATE_PLUGIN_JOB_PREFIX,
  SHAREPOINT_PROVIDER_COLUMNS,
  SHAREPOINT_UNSUPPORTED_COLUMN_TYPES,
  VIRTUAL_TABLE_QUERY_ROW_LIMIT,
  WIZARD_BREADCRUMBS,
  WIZARD_DOCS,
  VIRTUAL_TEXT_MAX_LENGTH,
  buildVirtualTableDefinition,
  classifyColumns,
  findRecentGenerationJobFailure,
  findSeedTable,
  isSharePointDataSource,
  listConnectorDataProviders,
  listConnectorDataSources,
  listVirtualTables,
  makerPortalWizardUrl,
  readTableColumns,
};
