'use strict';
// Lookup discovery for the genpage planner (scripts/get-lookup-metadata.js): for each table a page reads, its lookup columns with
// their COMPLETE target sets and the concrete paths a page can filter a target through. It composes two existing readers and owns
// no HTTP of its own:
//   - the SDK's fetchEntityMetadata(table) — the source of each lookup's identity and complete `targets` (the SDK reads them from
//     the table's LookupAttributeMetadata cast), the table's primary id and name columns, and nothing guessed from a name;
//   - lib/relationship-metadata.js readRelationshipsOf(…, 'ManyToOne', cache, { lookupDetails: true }) — every page of the
//     table's ManyToOne relationships with the target key and the navigation property, which the SDK's projection drops. When the
//     SDK projects ReferencingAttribute and ReferencingEntityNavigationPropertyName on its relationship rows, that read can go.
//
// A path is CONCRETE — a target discriminator a page may filter through (`customerid_account/accountid eq <id>`) — only when one
// relationship of the lookup column reaches that target and its navigation property belongs to no other target. Anything else is
// a SHARED path, listed separately and never used to pick a target: Owner's `ownerid` (one navigation property, a relationship to
// the abstract `owner` table, which is in no lookup's targets), a navigation property two targets share, or a target reached twice.
// Nothing here manufactures a path (`ownerid_team`, `ownerid_systemuser`) or splits a navigation name on `_` to find a table.
//
// Every failure is a failure of the whole read — a missing table, a lookup without targets, an attribute inventory that cannot be
// complete (no primary id column, or a relationship column it does not list or does not classify), a refused or malformed
// relationship page — so a caller never receives a shorter candidate list as if it were complete.

const { readRelationshipsOf } = require('./relationship-metadata.js');
const { missingTableOf } = require('./genpage-sdk.js');

// The attribute types that are lookups (AttributeTypeCode names, as the SDK projects them).
// https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/reference/attributetypecode
const LOOKUP_TYPES = new Set(['Lookup', 'Customer', 'Owner']);
// Every AttributeTypeCode name a metadata read can state (same page). The SDK projects a missing raw AttributeType as 'Unknown',
// which is none of them, so a column it names must not be read as "not a lookup".
const ATTRIBUTE_TYPES = new Set(['BigInt', 'Boolean', 'CalendarRules', 'Customer', 'DateTime', 'Decimal', 'Double', 'EntityName',
  'Integer', 'Lookup', 'ManagedProperty', 'Memo', 'Money', 'Owner', 'PartyList', 'Picklist', 'State', 'Status', 'String',
  'Uniqueidentifier', 'Virtual']);
// The types whose metadata is a LookupAttributeMetadata and so may carry Targets: the three lookups, and a party list (not a
// lookup this reader lists). Targets on any other type contradict its classification.
const TARGET_TYPES = new Set([...LOOKUP_TYPES, 'PartyList']);
const LOGICAL_NAME = /^[a-z_][a-z0-9_]*$/;

function lookupError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * A table's lookups from its SDK metadata and its lookup-details relationship rows.
 * @param {object} metadata - fetchEntityMetadata's answer: { logicalName, primaryIdAttribute, primaryNameAttribute, attributes: [{ logicalName, attributeType, targets? }] }
 * @param {object[]} rows - readRelationshipsOf lookup-details rows: { schemaName, referencedEntity, referencingAttribute, referencedAttribute, navigationProperty }
 */
function tableLookups(metadata, rows) {
  const table = String(metadata.logicalName || '').toLowerCase();
  const attributes = Array.isArray(metadata.attributes) ? metadata.attributes : [];
  // The SDK cannot say its attribute inventory is complete: it maps an absent `Attributes` expansion to [] and a missing
  // PrimaryIdAttribute to '', and it does not follow an `Attributes@odata.nextLink` continuation. So completeness is
  // established here from what must be in it — the table's primary id column, and the referencing column of every
  // ManyToOne relationship the separately paged relationship read returned (every lookup has one) — and a gap fails
  // the whole read rather than becoming a shorter list a planner reads as "no lookup".
  const inventory = new Set(attributes.filter(Boolean).map((attribute) => String(attribute.logicalName || '').toLowerCase()));
  const primaryId = String(metadata.primaryIdAttribute || '').toLowerCase();
  if (!LOGICAL_NAME.test(primaryId) || !inventory.has(primaryId)) {
    throw lookupError('LOOKUP_METADATA_INCOMPLETE', `${table}: the metadata read did not state the table's primary id column among its attributes`);
  }
  // A relationship column is classified, too: an unknown or malformed type (the SDK's 'Unknown' for a missing AttributeType),
  // or Targets on a type that cannot carry them, is an incomplete answer — never a column silently left out as "not a lookup".
  // A known non-lookup type without Targets is kept out of the lookups as before.
  const byColumn = new Map(attributes.filter(Boolean).map((attribute) => [String(attribute.logicalName || '').toLowerCase(), attribute]));
  for (const row of rows) {
    const column = String(row.referencingAttribute || '').toLowerCase();
    if (!inventory.has(column)) {
      throw lookupError('LOOKUP_METADATA_INCOMPLETE', `${table}: relationship ${row.schemaName || '?'} references ${column || '?'}, which the attribute inventory does not list — an incomplete attribute read`);
    }
    const attribute = byColumn.get(column);
    const type = attribute.attributeType;
    if (typeof type !== 'string' || !ATTRIBUTE_TYPES.has(type)) {
      throw lookupError('LOOKUP_METADATA_INCOMPLETE', `${table}.${column}: relationship ${row.schemaName || '?'} references it, but the metadata read did not classify it (attribute type ${JSON.stringify(type ?? null)})`);
    }
    if (!TARGET_TYPES.has(type) && Array.isArray(attribute.targets) && attribute.targets.length) {
      throw lookupError('LOOKUP_METADATA_INCOMPLETE', `${table}.${column}: the metadata read classifies it as ${type}, yet states lookup targets for it`);
    }
  }
  const lookups = [];
  for (const attribute of attributes) {
    if (!attribute || !LOOKUP_TYPES.has(attribute.attributeType)) continue;
    const column = String(attribute.logicalName || '').toLowerCase();
    const targets = Array.isArray(attribute.targets) ? attribute.targets.map((target) => String(target).toLowerCase()) : [];
    // The SDK fills `targets` from a separate cast read and leaves them out when that read fails, so a lookup without them is an
    // incomplete answer, never a lookup with no targets.
    if (!LOGICAL_NAME.test(column) || !targets.length || targets.some((target) => !LOGICAL_NAME.test(target))) {
      throw lookupError('LOOKUP_METADATA_INCOMPLETE', `${table}.${column || '?'}: the metadata read did not state the lookup's targets`);
    }
    const own = rows.filter((row) => String(row.referencingAttribute || '').toLowerCase() === column);
    const byNavigation = new Map();
    for (const row of own) byNavigation.set(row.navigationProperty, (byNavigation.get(row.navigationProperty) || 0) + 1);
    const paths = [];
    const sharedPaths = [];
    for (const row of own) {
      const target = String(row.referencedEntity || '').toLowerCase();
      const entry = { navigationProperty: row.navigationProperty, referencedKey: String(row.referencedAttribute || '').toLowerCase(), relationship: row.schemaName };
      const concrete = targets.includes(target)
        && own.filter((other) => String(other.referencedEntity || '').toLowerCase() === target).length === 1
        && byNavigation.get(row.navigationProperty) === 1;
      if (concrete) paths.push({ target, ...entry });
      else sharedPaths.push({ referencedEntity: target, ...entry });
    }
    const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
    paths.sort((a, b) => byText(a.target, b.target));
    sharedPaths.sort((a, b) => byText(a.navigationProperty, b.navigationProperty) || byText(a.referencedEntity, b.referencedEntity));
    lookups.push({ column, readProperty: `_${column}_value`, attributeType: attribute.attributeType, targets, paths, sharedPaths });
  }
  lookups.sort((a, b) => (a.column < b.column ? -1 : a.column > b.column ? 1 : 0));
  return {
    logicalName: table,
    primaryIdAttribute: primaryId,
    primaryNameAttribute: metadata.primaryNameAttribute || '',
    lookups,
  };
}

/**
 * Reads the lookups of `tables` through an SDK instance (its fetchEntityMetadata, and its `dataverse` client for the relationship read).
 * @param {object} sdk - a maker SDK instance
 * @param {string[]} tables - table logical names
 * @returns {Promise<{ ok: true, tables: object[] }>} - throws an Error with a `code` on any failure
 */
async function readLookupMetadata(sdk, tables) {
  if (!Array.isArray(tables) || !tables.length) throw lookupError('LOOKUP_TABLES_REQUIRED', 'name at least one table');
  const cache = new Map();
  const out = [];
  for (const name of tables) {
    const table = String(name).toLowerCase();
    if (!LOGICAL_NAME.test(table)) throw lookupError('LOOKUP_TABLE_NAME_INVALID', `'${name}' is not a table logical name`);
    let metadata;
    try {
      metadata = await sdk.fetchEntityMetadata(table);
    } catch (err) {
      // The SDK's own read of the table is the first request made for it, so a table the environment does not have fails THERE, before the
      // relationship read below could say so. Dataverse answers that read (measured live)
      //   GET …/api/data/v9.0/EntityDefinitions(LogicalName='opportunity')?$select=…&$expand=Attributes(…)
      //   404 {"error":{"code":"0x80060888","message":"EntityMetadata With Id = LogicalName='opportunity' does not exist."}}
      // and the SDK throws that as its ConnectionError — code CONNECTION_ERROR, which points a planner at sign-in, not at the table's name.
      // Only a 404 of that read, for this table, is the table's absence (missingTableOf reads the error's statusCode and url, never the
      // platform's words, as `genpage.js types` does); any other failure — another status, a request below the table, a transport failure
      // or a missing token (the SDK's statusCode 0) — keeps the SDK's own code.
      if (missingTableOf(err, [table]) === null) throw err;
      throw lookupError('LOOKUP_TABLE_NOT_FOUND', `${table}: the environment has no table with this logical name — ${err.message}`);
    }
    if (!metadata || String(metadata.logicalName || '').toLowerCase() !== table || !Array.isArray(metadata.attributes)) {
      throw lookupError('LOOKUP_METADATA_INCOMPLETE', `${table}: the metadata read did not answer for this table`);
    }
    const relationships = await readRelationshipsOf(sdk.dataverse, table, 'ManyToOne', cache, { lookupDetails: true });
    if (!relationships.ok) {
      throw lookupError(relationships.tableMissing ? 'LOOKUP_TABLE_NOT_FOUND' : 'LOOKUP_RELATIONSHIPS_UNREADABLE', `${table}: ${relationships.error}`);
    }
    out.push(tableLookups(metadata, relationships.rows));
  }
  return { ok: true, tables: out };
}

module.exports = { readLookupMetadata, tableLookups, LOOKUP_TYPES };
