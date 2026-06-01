#!/usr/bin/env node

// Downloads solution zip after a successful async export via DownloadSolutionExportData.
//
// Usage:
//   node download-export-data.js --envUrl <url> --asyncOperationId <id> --outputPath <path> [--token <token>]
//
// Options:
//   --envUrl <url>             Dataverse environment URL
//   --asyncOperationId <id>    AsyncOperationId returned by ExportSolutionAsync
//   --outputPath <path>        Destination path for the solution zip (e.g. MySolution_managed.zip)
//   --token <token>            Azure CLI Bearer token (optional; acquired via helpers.getAuthToken if omitted)
//
// Output (JSON to stdout):
//   { "zipPath": "...", "fileSizeBytes": N }
//
// Exit 0 on success, exit 1 on failure (error on stderr).

'use strict';

const fs = require('fs');
const path = require('path');
const helpers = require('./validation-helpers');

function parseArgs(argv) {
  const args = argv.slice(2);
  let envUrl = null;
  let asyncOperationId = null;
  let outputPath = null;
  let token = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--envUrl' && args[i + 1]) envUrl = args[++i];
    else if (args[i] === '--asyncOperationId' && args[i + 1]) asyncOperationId = args[++i];
    else if (args[i] === '--outputPath' && args[i + 1]) outputPath = args[++i];
    else if (args[i] === '--token' && args[i + 1]) token = args[++i];
  }

  return { envUrl, asyncOperationId, outputPath, token };
}

async function downloadExportData({ envUrl, asyncOperationId, outputPath, token } = {}) {
  if (!envUrl) throw new Error('--envUrl is required');
  if (!asyncOperationId) throw new Error('--asyncOperationId is required');
  if (!outputPath) throw new Error('--outputPath is required');

  const cleanEnvUrl = envUrl.replace(/\/+$/, '');
  const resolvedOutputPath = path.resolve(outputPath);

  // Acquire token if not provided
  const authToken = token || helpers.getAuthToken(cleanEnvUrl);
  if (!authToken) {
    throw new Error(
      'Azure CLI token acquisition failed. Run `az login` and retry, or pass --token explicitly.'
    );
  }

  // Step 1: POST DownloadSolutionExportData
  const requestBody = JSON.stringify({ ExportJobId: asyncOperationId });

  const res = await helpers.makeRequest({
    url: `${cleanEnvUrl}/api/data/v9.2/DownloadSolutionExportData`,
    method: 'POST',
    headers: {
      Authorization: `Bearer ${authToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'OData-MaxVersion': '4.0',
      'OData-Version': '4.0',
    },
    body: requestBody,
    timeout: 60000,
  });

  if (res.error) {
    throw new Error(`DownloadSolutionExportData request failed: ${res.error}`);
  }
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error(
      `DownloadSolutionExportData returned HTTP ${res.statusCode}: ${res.body}`
    );
  }

  // Step 2: Parse response body for ExportSolutionFile (base64)
  let responseData;
  try {
    responseData = JSON.parse(res.body);
  } catch {
    throw new Error(`DownloadSolutionExportData returned non-JSON body: ${res.body}`);
  }

  const base64Encoded = responseData.ExportSolutionFile;
  if (!base64Encoded) {
    throw new Error(
      'DownloadSolutionExportData response is missing ExportSolutionFile. ' +
      'The export job may have failed or the ExportJobId is incorrect.'
    );
  }

  // Step 3: Decode base64 and write zip to disk
  const zipBuffer = Buffer.from(base64Encoded, 'base64');
  const fileSizeBytes = zipBuffer.length;

  // Ensure output directory exists
  const outputDir = path.dirname(resolvedOutputPath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  fs.writeFileSync(resolvedOutputPath, zipBuffer);

  return { zipPath: resolvedOutputPath, fileSizeBytes };
}

// CLI entry point
if (require.main === module) {
  const { envUrl, asyncOperationId, outputPath, token } = parseArgs(process.argv);

  downloadExportData({ envUrl, asyncOperationId, outputPath, token })
    .then((result) => {
      console.log(JSON.stringify(result));
      process.exit(0);
    })
    .catch((err) => {
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    });
}

module.exports = { downloadExportData };
