#!/usr/bin/env node

// Validates Power Pages site activation output.
// Runs as a Stop hook to verify the website was provisioned in the environment.
// Calls the Power Platform GET Websites API to check if the site exists.

const fs = require('fs');
const path = require('path');
const { approve, block, runValidation, findPath, getAuthToken, makeRequest, getPacAuthInfo, CLOUD_TO_API } = require('../../../scripts/lib/validation-helpers');

runValidation(async (cwd) => {
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

  const websites = await getWebsites(ppApiBaseUrl, token, pacInfo.environmentId);
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

async function getWebsites(ppApiBaseUrl, token, environmentId) {
  try {
    const result = await makeRequest({
      url: `${ppApiBaseUrl}/powerpages/environments/${environmentId}/websites?api-version=2022-03-01-preview`,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
      timeout: 15000,
    });
    if (result.error || result.statusCode !== 200) return null;
    const parsed = JSON.parse(result.body);
    const value = parsed.value;
    if (!value) return [];
    return Array.isArray(value) ? value : [value];
  } catch {
    return null;
  }
}
