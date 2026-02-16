#!/usr/bin/env node

// Validates Power Pages site activation output.
// Runs as a Stop hook to verify the website was provisioned in the environment.
// Calls the Power Platform GET Websites API to check if the site exists.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Exit 0 = success (allow). Exit 2 = blocking error (stderr is fed back to Claude).
const approve = () => { process.exit(0); };
const block = (reason) => {
  process.stderr.write(reason);
  process.exit(2);
};

// Cloud → Power Platform API base URL mapping
const CLOUD_TO_API = {
  'Public': 'https://api.powerplatform.com',
  'UsGov': 'https://api.gov.powerplatform.microsoft.us',
  'UsGovHigh': 'https://api.high.powerplatform.microsoft.us',
  'UsGovDod': 'https://api.appsplatform.us',
  'China': 'https://api.powerplatform.partner.microsoftonline.cn',
};

let inputData = '';
process.stdin.on('data', chunk => (inputData += chunk));
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(inputData);
    const cwd = input.cwd;

    if (!cwd) approve();

    const configPath = findConfig(cwd);
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
  } catch {
    // Don't block on script errors
    approve();
  }
});

function findConfig(dir) {
  const direct = path.join(dir, 'powerpages.config.json');
  if (fs.existsSync(direct)) return direct;

  // Check one level of subdirectories
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== '.git') {
        const sub = path.join(dir, entry.name, 'powerpages.config.json');
        if (fs.existsSync(sub)) return sub;
      }
    }
  } catch {}

  return null;
}

function getPacAuthInfo() {
  try {
    const output = execSync('pac auth who', { encoding: 'utf8', timeout: 15000 });
    const envMatch = output.match(/Environment ID:\s*([0-9a-fA-F-]+)/i);
    const cloudMatch = output.match(/Cloud:\s*(\S+)/i);
    if (!envMatch) return null;
    return {
      environmentId: envMatch[1],
      cloud: cloudMatch ? cloudMatch[1] : 'Public',
    };
  } catch {
    return null;
  }
}

function getAuthToken(ppApiBaseUrl) {
  try {
    return execSync(
      `az account get-access-token --resource "${ppApiBaseUrl}" --query accessToken -o tsv`,
      { encoding: 'utf8', timeout: 15000 }
    ).trim();
  } catch {
    return null;
  }
}

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
