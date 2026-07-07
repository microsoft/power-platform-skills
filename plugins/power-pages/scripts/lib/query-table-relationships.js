#!/usr/bin/env node

// Shared Dataverse relationship queries for a table: lookups (OneToMany) + N:N
// (ManyToMany). Extracted from skills/audit-permissions/scripts/query-table-relationships.js
// so it can be require()d (that file is a self-executing CLI). The CLI is now a
// thin wrapper over this module. Used by:
//   - estimate-solution-size.js — to build the dependency graph for the
//     schema-split clustering (so related tables ship in the same solution).
//   - audit-permissions — to validate contact/account/parent relationship scopes.

'use strict';

const helpers = require('./validation-helpers');

/**
 * Fetches OneToMany (lookup-backed) and ManyToMany relationships for a table.
 *
 * OneToMany errors propagate (a genuinely missing/inaccessible table is a real
 * error the CLI surfaces via exit 1; the estimator wraps the call per-table for
 * resilience). ManyToMany is best-effort — many tables/envs have no N:N and the
 * navigation property can be finicky — so its errors are swallowed to `[]`.
 *
 * @param {string} envUrl - environment base URL
 * @param {string} table - table logical name
 * @param {string} token - bearer token
 * @param {Function} [request=helpers.makeRequest] - injectable for tests
 * @returns {Promise<{
 *   oneToMany: { schemaName, referencedEntity, referencingEntity, referencingAttribute }[],
 *   manyToMany: { schemaName, entity1, entity2 }[]
 * }>}
 */
async function fetchTableRelationships(envUrl, table, token, request = helpers.makeRequest) {
  const base = String(envUrl).replace(/\/+$/, '');
  const safe = String(table).replace(/'/g, "''");

  const o2mUrl =
    `${base}/api/data/v9.2/EntityDefinitions(LogicalName='${safe}')/OneToManyRelationships` +
    `?$select=SchemaName,ReferencedEntity,ReferencingEntity,ReferencingAttribute`;
  const o2mRows = await helpers.odataGetAll(o2mUrl, token, request);
  const oneToMany = o2mRows.map((r) => ({
    schemaName: r.SchemaName,
    referencedEntity: r.ReferencedEntity,
    referencingEntity: r.ReferencingEntity,
    referencingAttribute: r.ReferencingAttribute,
  }));

  let manyToMany = [];
  try {
    const m2mUrl =
      `${base}/api/data/v9.2/EntityDefinitions(LogicalName='${safe}')/ManyToManyRelationships` +
      `?$select=SchemaName,Entity1LogicalName,Entity2LogicalName`;
    const m2mRows = await helpers.odataGetAll(m2mUrl, token, request);
    manyToMany = m2mRows.map((r) => ({
      schemaName: r.SchemaName,
      entity1: r.Entity1LogicalName,
      entity2: r.Entity2LogicalName,
    }));
  } catch {
    // N:N unavailable for this table/env — best-effort, leave empty.
  }

  return { oneToMany, manyToMany };
}

module.exports = { fetchTableRelationships };
