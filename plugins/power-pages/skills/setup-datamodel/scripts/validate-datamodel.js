#!/usr/bin/env node

// Validates Dataverse data model creation output.
// Runs as a Stop hook to verify tables and columns were properly created.
// Reads .datamodel-manifest.json (written by the setup-datamodel skill) and
// queries the Dataverse OData API to confirm each table/column exists.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { approve, block, runValidation, findPath, getAuthToken, getEnvironmentUrl } = require('../../../scripts/lib/validation-helpers');

runValidation((cwd) => {
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
    const tableExists = checkTableExists(envUrl, token, table.logicalName);
    if (!tableExists) {
      errors.push(`Missing table: ${table.logicalName} (${table.displayName || 'unknown'})`);
      continue;
    }

    if (table.columns && table.columns.length > 0) {
      const existingColumns = getTableColumns(envUrl, token, table.logicalName);
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

function checkTableExists(envUrl, token, logicalName) {
  try {
    execSync(
      `powershell -NoProfile -Command "Invoke-RestMethod -Uri '${envUrl}/api/data/v9.2/EntityDefinitions(LogicalName=''${logicalName}'')' -Headers @{ Authorization = 'Bearer ${token}'; Accept = 'application/json' } | Out-Null"`,
      { encoding: 'utf8', timeout: 15000 }
    );
    return true;
  } catch {
    return false;
  }
}

function getTableColumns(envUrl, token, logicalName) {
  try {
    const output = execSync(
      `powershell -NoProfile -Command "(Invoke-RestMethod -Uri '${envUrl}/api/data/v9.2/EntityDefinitions(LogicalName=''${logicalName}'')/Attributes?$select=LogicalName' -Headers @{ Authorization = 'Bearer ${token}'; Accept = 'application/json' }).value.LogicalName -join ','  "`,
      { encoding: 'utf8', timeout: 15000 }
    );
    return output.trim().split(',').filter(Boolean);
  } catch {
    return [];
  }
}
