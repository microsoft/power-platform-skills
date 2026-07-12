'use strict';

const fs = require('fs');
const path = require('path');
const { getAuthToken, makeRequest } = require('./validation-helpers');

function emptySummary() {
  return { ok: true, inserted: 0, failed: 0, skipped: 0, errors: [] };
}

function listSeedFiles(seedDir, deps = {}) {
  const fsImpl = deps.fs || fs;
  if (!seedDir || !fsImpl.existsSync(seedDir)) return [];
  return fsImpl.readdirSync(seedDir)
    .filter((name) => name.toLowerCase().endsWith('.json'))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((name) => path.join(seedDir, name));
}

function isDuplicateConflict(res) {
  // Dataverse duplicate-key conflicts arrive as HTTP 409 with either a JSON
  // OData envelope or plain text depending on the caller surface, e.g.:
  //   { "error": { "code": "0x80040237", "message": "Cannot insert duplicate key." } }
  //   "A record with matching key values already exists."
  // Only those duplicate shapes are treated as idempotent skips; other 409s
  // (for example concurrency/version conflicts) remain failures.
  if (res.statusCode !== 409) return false;
  const message = `${res.error || ''} ${res.body || ''}`;
  return /duplicate|already\s+exists|cannot\s+insert\s+duplicate/i.test(message);
}

function readSeedFile(filePath, deps = {}) {
  const fsImpl = deps.fs || fs;
  // Seed files are intentionally small authored JSON files, e.g.:
  //   { "entitySetName": "cr123_categories",
  //     "records": [{ "cr123_categoryid": "<guid>", "cr123_name": "Announcements" }] }
  // The numeric filename prefix (`010-...json`) is the ordering contract; the
  // file body names the OData entity set to POST records into.
  const parsed = JSON.parse(fsImpl.readFileSync(filePath, 'utf8'));
  if (!parsed || typeof parsed.entitySetName !== 'string' || !Array.isArray(parsed.records)) {
    throw new Error('Expected { entitySetName: string, records: array }');
  }
  return parsed;
}

async function postRecord({ envUrl, token, entitySetName, record }, deps = {}) {
  const request = deps.makeRequest || makeRequest;
  // Dataverse Web API creates records by POSTing to the entity set collection:
  //   POST /api/data/v9.2/accounts
  // See: https://learn.microsoft.com/power-apps/developer/data-platform/webapi/create-entity-web-api
  return request({
    url: `${envUrl.replace(/\/+$/, '')}/api/data/v9.2/${entitySetName}`,
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(record),
    includeHeaders: true,
    timeout: 30000,
  });
}

async function applySeedData({ seedDir, envUrl }, deps = {}) {
  const summary = emptySummary();
  try {
    const resolveToken = deps.getAuthToken || getAuthToken;
    const token = deps.token || resolveToken(envUrl);
    if (!token) {
      return { ...summary, ok: false, failed: 1, errors: [{ scope: 'auth', message: `Azure CLI token unavailable for ${envUrl}` }] };
    }

    for (const filePath of listSeedFiles(seedDir, deps)) {
      let seed;
      try {
        seed = readSeedFile(filePath, deps);
      } catch (err) {
        summary.failed += 1;
        summary.errors.push({ file: path.basename(filePath), message: err.message });
        continue;
      }

      for (const record of seed.records) {
        const context = { file: path.basename(filePath), entitySetName: seed.entitySetName };
        try {
          const res = await postRecord({ envUrl, token, entitySetName: seed.entitySetName, record }, deps);
          if (res.error) {
            summary.failed += 1;
            summary.errors.push({ ...context, message: res.error });
          } else if (isDuplicateConflict(res)) {
            summary.skipped += 1;
          } else if (res.statusCode >= 200 && res.statusCode < 300) {
            summary.inserted += 1;
          } else {
            summary.failed += 1;
            summary.errors.push({ ...context, statusCode: res.statusCode, message: res.body || `HTTP ${res.statusCode}` });
          }
        } catch (err) {
          summary.failed += 1;
          summary.errors.push({ ...context, message: err.message });
        }
      }
    }
  } catch (err) {
    summary.ok = false;
    summary.failed += 1;
    summary.errors.push({ scope: 'seedDir', message: err.message });
  }
  return summary;
}

module.exports = { applySeedData, emptySummary, listSeedFiles, readSeedFile, postRecord, isDuplicateConflict };
