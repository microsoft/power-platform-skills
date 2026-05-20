#!/usr/bin/env node

// Dataverse metadata fetchers — pure async helpers that call the Web API's EntityDefinitions
// endpoints. Together they are the source of truth that replaces agent inference in the
// EDM → SPA migration pipeline. Hallucinated column / table / relationship / optionset /
// lookup names get caught here by comparing the migration plan against what Dataverse
// actually reports.
//
// Every helper:
//   - takes (envUrl, token, ...rest) so callers control auth and base URL
//   - takes an optional `httpRequest` injection so tests can stub the HTTP layer without
//     spinning up a real server
//   - returns plain JSON-serializable shapes (no class instances, no functions)
//   - throws on unexpected statusCode so callers can distinguish "not found" from "API
//     failure"
//
// Dataverse Web API references:
//   - EntityDefinitions: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/use-web-api-metadata
//   - Querying attribute metadata: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/query-metadata-web-api

const { makeRequest } = require('./validation-helpers');

// All metadata endpoints live under /api/data/v9.2/. v9.2 is the long-term-stable channel
// recommended for code-site consumers.
const API_VERSION = 'v9.2';

// Wraps a single Dataverse GET with consistent headers + JSON parse. Throws an Error with
// a descriptive message for any non-200 status so callers (and tests) can branch on it.
async function dataverseGet({ envUrl, token, apiPath, httpRequest = makeRequest, timeout = 30000 }) {
  // The annotation header asks Dataverse to inline formatted/derived values (e.g.
  // FormattedValue for choice columns). Cheap to request; lets callers skip a second
  // round trip when they need labels alongside raw values.
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    'OData-MaxVersion': '4.0',
    'OData-Version': '4.0',
    Prefer: 'odata.include-annotations="*"',
  };
  const url = `${envUrl.replace(/\/+$/, '')}/api/data/${API_VERSION}/${apiPath}`;
  const res = await httpRequest({ url, method: 'GET', headers, timeout });
  if (res.error) {
    throw new Error(`Dataverse request failed: ${res.error}`);
  }
  if (res.statusCode === 404) {
    // EntityDefinitions returns 404 when the requested table/attribute logical name does
    // not exist. Surface a typed Error so callers can map this to a "metadata not found"
    // finding without needing to parse the body.
    const err = new Error(`Dataverse metadata not found at ${apiPath}`);
    err.code = 'NOT_FOUND';
    throw err;
  }
  if (res.statusCode !== 200) {
    throw new Error(`Dataverse returned ${res.statusCode} for ${apiPath}: ${(res.body || '').slice(0, 200)}`);
  }
  try {
    return JSON.parse(res.body);
  } catch (e) {
    throw new Error(`Dataverse returned unparseable JSON for ${apiPath}: ${e.message}`);
  }
}

// 1) Tables ------------------------------------------------------------------
//
// GET /api/data/v9.2/EntityDefinitions?$select=LogicalName,SchemaName,EntitySetName,IsCustomEntity
//
// Returns a flat array of table descriptors. LogicalName is the lowercase identifier the
// migration plan uses everywhere ("faq_article"); SchemaName is the cased original
// ("faq_Article"); EntitySetName is the OData collection name ("faq_articles") used in
// Web API URLs.
async function listTables({ envUrl, token, httpRequest } = {}) {
  const body = await dataverseGet({
    envUrl,
    token,
    apiPath: 'EntityDefinitions?$select=LogicalName,SchemaName,EntitySetName,IsCustomEntity',
    httpRequest,
  });
  const value = Array.isArray(body.value) ? body.value : [];
  return value.map((row) => ({
    logicalName: row.LogicalName,
    schemaName: row.SchemaName,
    entitySetName: row.EntitySetName,
    isCustom: Boolean(row.IsCustomEntity),
  }));
}

// 2) Columns for one table ---------------------------------------------------
//
// GET /api/data/v9.2/EntityDefinitions(LogicalName='<table>')/Attributes
//   ?$select=LogicalName,SchemaName,AttributeType,IsCustomAttribute,
//            IsValidForRead,IsValidForCreate,IsValidForUpdate
//
// AttributeType is the type discriminator ("String", "Lookup", "Picklist", "Money", etc).
// IsValidForRead / Create / Update tell us whether the column can appear in a SELECT /
// POST / PATCH body — used to flag whitelist entries that exist but can't actually be
// returned to the SPA.
async function listTableColumns({ envUrl, token, table, httpRequest } = {}) {
  if (!table) throw new Error('listTableColumns: table is required');
  // IsPrimaryId / IsLogical are essential for write-side code generation:
  //   IsPrimaryId  — the PK; never includable in a PATCH/POST body, and on certain
  //                  tables (contact, systemuser, account) Power Pages also blocks it
  //                  from $select. /integrate-webapi consults this flag to emit the
  //                  correct <Table>Update type.
  //   IsLogical    — a computed / non-stored attribute. Read-only by definition; must
  //                  not appear in <Table>Update.
  const apiPath =
    `EntityDefinitions(LogicalName='${encodeURIComponent(table)}')/Attributes` +
    '?$select=LogicalName,SchemaName,AttributeType,IsCustomAttribute,IsValidForRead,IsValidForCreate,IsValidForUpdate,IsPrimaryId,IsLogical';
  const body = await dataverseGet({ envUrl, token, apiPath, httpRequest });
  const value = Array.isArray(body.value) ? body.value : [];
  return value.map((row) => ({
    logicalName: row.LogicalName,
    schemaName: row.SchemaName,
    attributeType: row.AttributeType,
    isCustom: Boolean(row.IsCustomAttribute),
    readable: Boolean(row.IsValidForRead),
    creatable: Boolean(row.IsValidForCreate),
    writable: Boolean(row.IsValidForUpdate),
    isPrimaryId: Boolean(row.IsPrimaryId),
    isLogical: Boolean(row.IsLogical),
  }));
}

// 3) Relationships for one table ---------------------------------------------
//
// Dataverse splits relationships across three separate endpoints; we call all three and
// merge. The migration plan can reference any of these shapes (the source EDM may
// configure a portal table-permission scope that hops through any one of them):
//
//   GET /api/data/v9.2/EntityDefinitions(LogicalName='<t>')/OneToManyRelationships
//   GET /api/data/v9.2/EntityDefinitions(LogicalName='<t>')/ManyToOneRelationships
//   GET /api/data/v9.2/EntityDefinitions(LogicalName='<t>')/ManyToManyRelationships
//
// SchemaName is the canonical relationship identifier (case-sensitive in some places, so
// we preserve both raw and lowercased forms).
async function listTableRelationships({ envUrl, token, table, httpRequest } = {}) {
  if (!table) throw new Error('listTableRelationships: table is required');
  const encoded = encodeURIComponent(table);
  const oneToMany = await dataverseGet({
    envUrl,
    token,
    apiPath:
      `EntityDefinitions(LogicalName='${encoded}')/OneToManyRelationships` +
      '?$select=SchemaName,ReferencedEntity,ReferencingEntity,ReferencedAttribute,ReferencingAttribute',
    httpRequest,
  });
  const manyToOne = await dataverseGet({
    envUrl,
    token,
    apiPath:
      `EntityDefinitions(LogicalName='${encoded}')/ManyToOneRelationships` +
      '?$select=SchemaName,ReferencedEntity,ReferencingEntity,ReferencedAttribute,ReferencingAttribute',
    httpRequest,
  });
  const manyToMany = await dataverseGet({
    envUrl,
    token,
    apiPath:
      `EntityDefinitions(LogicalName='${encoded}')/ManyToManyRelationships` +
      '?$select=SchemaName,Entity1LogicalName,Entity2LogicalName,IntersectEntityName',
    httpRequest,
  });
  return {
    oneToMany: (oneToMany.value || []).map((r) => ({
      schemaName: r.SchemaName,
      referencedEntity: r.ReferencedEntity,
      referencingEntity: r.ReferencingEntity,
      referencedAttribute: r.ReferencedAttribute,
      referencingAttribute: r.ReferencingAttribute,
    })),
    manyToOne: (manyToOne.value || []).map((r) => ({
      schemaName: r.SchemaName,
      referencedEntity: r.ReferencedEntity,
      referencingEntity: r.ReferencingEntity,
      referencedAttribute: r.ReferencedAttribute,
      referencingAttribute: r.ReferencingAttribute,
    })),
    manyToMany: (manyToMany.value || []).map((r) => ({
      schemaName: r.SchemaName,
      entity1LogicalName: r.Entity1LogicalName,
      entity2LogicalName: r.Entity2LogicalName,
      intersectEntityName: r.IntersectEntityName,
    })),
  };
}

// 4) Optionset (Choice) values for one column --------------------------------
//
// Choice columns (`AttributeType: "Picklist"` or `"State"` / `"Status"`) carry their
// allowed values on the OptionSet expansion. Cast the attribute to its
// PicklistAttributeMetadata type to expose OptionSet:
//
//   GET /api/data/v9.2/EntityDefinitions(LogicalName='<t>')/Attributes(LogicalName='<a>')
//       /Microsoft.Dynamics.CRM.PicklistAttributeMetadata?$expand=OptionSet
//
// MultiSelectPicklist and State/Status follow the same shape under different casts —
// the helper accepts an explicit `castType` so callers can fetch any choice variant
// without copy-pasting the URL.
async function listOptionsetValues({
  envUrl,
  token,
  table,
  column,
  castType = 'PicklistAttributeMetadata',
  httpRequest,
} = {}) {
  if (!table) throw new Error('listOptionsetValues: table is required');
  if (!column) throw new Error('listOptionsetValues: column is required');
  const apiPath =
    `EntityDefinitions(LogicalName='${encodeURIComponent(table)}')` +
    `/Attributes(LogicalName='${encodeURIComponent(column)}')` +
    `/Microsoft.Dynamics.CRM.${castType}?$expand=OptionSet`;
  const body = await dataverseGet({ envUrl, token, apiPath, httpRequest });
  const optionSet = body.OptionSet || {};
  const options = Array.isArray(optionSet.Options) ? optionSet.Options : [];
  return options.map((opt) => ({
    value: opt.Value,
    // Labels carry localizations under UserLocalizedLabel.Label. Fall back to the raw
    // string if Dataverse returned a stripped shape (some custom builds drop the
    // localized wrapper).
    label:
      (opt.Label && opt.Label.UserLocalizedLabel && opt.Label.UserLocalizedLabel.Label) ||
      (typeof opt.Label === 'string' ? opt.Label : null),
    description:
      (opt.Description && opt.Description.UserLocalizedLabel && opt.Description.UserLocalizedLabel.Label) ||
      null,
  }));
}

// 5) Lookup target entities for one column -----------------------------------
//
// Lookup columns (`AttributeType: "Lookup"` or `"Customer"`/`"Owner"`) carry the list of
// referenceable entity logical names on the Targets property of LookupAttributeMetadata:
//
//   GET /api/data/v9.2/EntityDefinitions(LogicalName='<t>')/Attributes(LogicalName='<a>')
//       /Microsoft.Dynamics.CRM.LookupAttributeMetadata?$select=Targets,LogicalName
//
// Most lookups point at one entity (Targets = ["account"]); polymorphic lookups (Customer,
// Owner, Regarding) point at several. The verify script flags any plan-referenced lookup
// target not in this list.
async function listLookupTargets({ envUrl, token, table, column, httpRequest } = {}) {
  if (!table) throw new Error('listLookupTargets: table is required');
  if (!column) throw new Error('listLookupTargets: column is required');
  const apiPath =
    `EntityDefinitions(LogicalName='${encodeURIComponent(table)}')` +
    `/Attributes(LogicalName='${encodeURIComponent(column)}')` +
    `/Microsoft.Dynamics.CRM.LookupAttributeMetadata?$select=Targets,LogicalName`;
  const body = await dataverseGet({ envUrl, token, apiPath, httpRequest });
  return {
    logicalName: body.LogicalName || column,
    targets: Array.isArray(body.Targets) ? body.Targets : [],
  };
}

module.exports = {
  // Helpers (the public API)
  listTables,
  listTableColumns,
  listTableRelationships,
  listOptionsetValues,
  listLookupTargets,
  // Lower-level escape hatch used by the snapshot orchestrator + tests
  dataverseGet,
  API_VERSION,
};
