#!/usr/bin/env node

// Validates Dataverse data model creation output.
// Runs as a Stop hook to verify tables and columns were properly created.
// Reads .datamodel-manifest.json (written by the setup-datamodel skill) and
// queries the Dataverse OData API to confirm each table/column exists.

const fs = require('fs');
const path = require('path');
const { approve, block, runValidation, findPath, getAuthToken, makeRequest, getEnvironmentUrl } = require('../../../scripts/lib/validation-helpers');

runValidation(async (cwd) => {
  const manifestPath = findPath(cwd, '.datamodel-manifest.json');
  if (!manifestPath) approve(); // Not a data model session, skip

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (!manifest.tables || manifest.tables.length === 0) approve();

  const envUrl = manifest.environmentUrl || getEnvironmentUrl();
  if (!envUrl) approve(); // Can't determine environment — don't block

  const token = getAuthToken(envUrl);
  if (!token) approve(); // Auth not available — don't block

  const errors = [];

  for (const table of manifest.tables) {
    const tableExists = await checkTableExists(envUrl, token, table.logicalName);
    if (!tableExists) {
      errors.push(`Missing table: ${table.logicalName} (${table.displayName || 'unknown'})`);
      continue;
    }

    if (table.columns && table.columns.length > 0) {
      const existingColumns = await getTableColumns(envUrl, token, table.logicalName);
      for (const col of table.columns) {
        if (!existingColumns.includes(col.logicalName)) {
          errors.push(`Missing column: ${table.logicalName}.${col.logicalName}`);
        }
      }
    }
  }

  if (errors.length > 0) {
    block('Dataverse data model validation failed:\n- ' + errors.join('\n- '));
  }

  approve();
});

async function checkTableExists(envUrl, token, logicalName) {
  try {
    const result = await makeRequest({
      url: `${envUrl}/api/data/v9.2/EntityDefinitions(LogicalName='${logicalName}')`,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
      timeout: 15000,
    });
    return result.statusCode === 200;
  } catch {
    return false;
  }
}

async function getTableColumns(envUrl, token, logicalName) {
  try {
    const result = await makeRequest({
      url: `${envUrl}/api/data/v9.2/EntityDefinitions(LogicalName='${logicalName}')/Attributes?$select=LogicalName`,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
      timeout: 15000,
    });
    if (result.error || result.statusCode !== 200) return [];
    const parsed = JSON.parse(result.body);
    return (parsed.value || []).map((a) => a.LogicalName).filter(Boolean);
  } catch {
    return [];
  }
}
