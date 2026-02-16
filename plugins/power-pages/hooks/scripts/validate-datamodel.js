#!/usr/bin/env node

// Validates Dataverse data model creation output.
// Runs as a Stop hook to verify tables and columns were properly created.
// Reads .datamodel-manifest.json (written by the setup-datamodel skill) and
// queries the Dataverse OData API to confirm each table/column exists.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Command hook output: exit 0 with no output to allow, JSON with decision:"block" to block.
const approve = () => { process.exit(0); };
const block = (reason) => {
  console.log(JSON.stringify({ decision: "block", reason }));
  process.exit(1);
};

let inputData = '';
process.stdin.on('data', chunk => (inputData += chunk));
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(inputData);
    const cwd = input.cwd;

    if (!cwd) approve();

    const manifestPath = findManifest(cwd);
    if (!manifestPath) approve(); // Not a data model session, skip

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (!manifest.tables || manifest.tables.length === 0) approve();

    const envUrl = manifest.environmentUrl || getEnvironmentUrl();
    if (!envUrl) {
      // Can't determine environment — don't block
      approve();
    }

    const token = getAuthToken(envUrl);
    if (!token) {
      // Auth not available — don't block
      approve();
    }

    const errors = [];

    for (const table of manifest.tables) {
      // Verify table exists
      const tableExists = checkTableExists(envUrl, token, table.logicalName);
      if (!tableExists) {
        errors.push(`Missing table: ${table.logicalName} (${table.displayName || 'unknown'})`);
        continue; // Skip column checks if table doesn't exist
      }

      // Verify columns exist
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
  } catch {
    // Don't block on script errors
    approve();
  }
});

function findManifest(dir) {
  const direct = path.join(dir, '.datamodel-manifest.json');
  if (fs.existsSync(direct)) return direct;

  // Check one level of subdirectories
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== '.git') {
        const sub = path.join(dir, entry.name, '.datamodel-manifest.json');
        if (fs.existsSync(sub)) return sub;
      }
    }
  } catch {}

  return null;
}

function getEnvironmentUrl() {
  try {
    const output = execSync('pac env who', { encoding: 'utf8', timeout: 15000 });
    const match = output.match(/Environment URL:\s*(https:\/\/[^\s]+)/i);
    return match ? match[1].replace(/\/+$/, '') : null;
  } catch {
    return null;
  }
}

function getAuthToken(envUrl) {
  try {
    return execSync(
      `az account get-access-token --resource "${envUrl}" --query accessToken -o tsv`,
      { encoding: 'utf8', timeout: 15000 }
    ).trim();
  } catch {
    return null;
  }
}

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
