#!/usr/bin/env node

// Shared Dataverse metadata queries (EntityDefinitions). Single source of truth
// for "list the environment's custom unmanaged tables" — previously duplicated
// in estimate-solution-size.js, discover-site-components.js, and inline in the
// setup-solution skill prose. All three now go through this helper.

'use strict';

const helpers = require('./validation-helpers');

/**
 * Lists every CUSTOM, UNMANAGED table in the environment.
 *
 * Note: `EntityDefinitions` does not support `$top`, but it does paginate via
 * `@odata.nextLink`, so we use the shared `odataGetAll`. `IsCustomEntity` is
 * filtered server-side; `IsManaged` is filtered client-side (the metadata
 * `$filter` grammar is limited).
 *
 * @param {string} envUrl - environment base URL
 * @param {string} token - bearer token
 * @param {Function} [request=helpers.makeRequest] - injectable for tests
 * @returns {Promise<{ logicalName: string, metadataId: string, schemaName: string, displayName: string }[]>}
 */
async function queryCustomUnmanagedTables(envUrl, token, request = helpers.makeRequest) {
  const base = String(envUrl).replace(/\/+$/, '');
  const url =
    `${base}/api/data/v9.2/EntityDefinitions` +
    `?$filter=IsCustomEntity eq true` +
    `&$select=LogicalName,MetadataId,SchemaName,DisplayName,IsManaged,IsCustomEntity`;
  const rows = await helpers.odataGetAll(url, token, request);
  return rows
    .filter((e) => e && e.IsCustomEntity === true && e.IsManaged === false)
    .map((e) => ({
      logicalName: e.LogicalName,
      metadataId: e.MetadataId,
      schemaName: e.SchemaName,
      displayName:
        (e.DisplayName && e.DisplayName.UserLocalizedLabel && e.DisplayName.UserLocalizedLabel.Label) ||
        e.SchemaName,
    }));
}

module.exports = { queryCustomUnmanagedTables };
