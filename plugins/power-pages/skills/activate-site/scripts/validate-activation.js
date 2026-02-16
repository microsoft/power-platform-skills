#!/usr/bin/env node

// Validates Power Pages site activation output.
// Runs as a Stop hook to verify the website was provisioned in the environment.
// Calls the Power Platform GET Websites API to check if the site exists.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { approve, block, runValidation, findPath, getAuthToken, getPacAuthInfo, CLOUD_TO_API } = require('../../../scripts/lib/validation-helpers');

runValidation((cwd) => {
  const configPath = findPath(cwd, 'powerpages.config.json');
  if (!configPath) approve(); // Not a Power Pages project, skip

  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const siteName = config.siteName;
  if (!siteName) approve();

  const pacInfo = getPacAuthInfo();
  if (!pacInfo) approve(); // PAC CLI not authenticated, don't block

  const ppApiBaseUrl = CLOUD_TO_API[pacInfo.cloud] || CLOUD_TO_API['Public'];

  const token = getAuthToken(ppApiBaseUrl);
  if (!token) approve(); // Auth not available, don't block

  const websites = getWebsites(ppApiBaseUrl, token, pacInfo.environmentId);
  if (websites === null) approve(); // API call failed, don't block

  const found = websites.some(
    (w) => w.name && w.name.toLowerCase() === siteName.toLowerCase()
  );

  if (!found) {
    block(
      `Power Pages activation validation failed:\n- Website "${siteName}" not found in environment ${pacInfo.environmentId}. The site may not have been provisioned successfully.`
    );
  }

  approve();
});

function getWebsites(ppApiBaseUrl, token, environmentId) {
  try {
    const output = execSync(
      `powershell -NoProfile -Command "(Invoke-RestMethod -Uri '${ppApiBaseUrl}/powerpages/environments/${environmentId}/websites?api-version=2022-03-01-preview' -Headers @{ Authorization = 'Bearer ${token}'; Accept = 'application/json' }).value | ConvertTo-Json -Compress"`,
      { encoding: 'utf8', timeout: 15000 }
    );
    const parsed = JSON.parse(output.trim());
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return null;
  }
}
