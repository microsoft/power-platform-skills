'use strict';

const fs = require('fs');
const path = require('path');
const { getAuthToken, makeRequest } = require('./validation-helpers');
const generateUuid = require('../generate-uuid');

const FILE_BLOCK_SIZE_BYTES = 4 * 1024 * 1024;
// Large attachment seed runs can issue many Dataverse calls (record create +
// InitializeFileBlocksUpload + one UploadBlock per 4 MiB + Commit). Refreshing
// every 25 requests keeps long runs away from stale Azure CLI tokens without
// hammering `az account get-access-token` on every block. If refresh fails,
// callers receive the normal best-effort seed summary error; telemetry or site
// activation must never depend on seed upload success.
const TOKEN_REFRESH_EVERY_REQUESTS = 25;
const ALLOWED_ATTACHMENT_EXTENSIONS = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.txt', '.csv', '.json', '.docx', '.xlsx']);

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
  // Seed files are intentionally small authored JSON files. Supported shapes:
  //   Flat:
  //   { "entitySetName": "cr123_categories",
  //     "records": [{ "cr123_categoryid": "<guid>", "cr123_name": "Announcements" }] }
  //   Dataverse export:
  //   { "schemaVersion": 1, "tables": { "accounts": {
  //       "entitySet": "accounts", "idColumn": "accountid", "records": [...] } },
  //     "fileExports": [{ "attachmentId": "<guid>", "fileColumn": "cr123_file", "path": "files/a.pdf" }] }
  // The numeric filename prefix (`010-...json`) is the ordering contract; the
  // file body names the OData entity set to POST records into.
  const parsed = JSON.parse(fsImpl.readFileSync(filePath, 'utf8'));
  if (parsed && typeof parsed.entitySetName === 'string' && Array.isArray(parsed.records)) {
    return parsed;
  }
  const normalizedExport = normalizeDataverseExportSeed(parsed);
  if (normalizedExport) return normalizedExport;
  throw new Error('Expected flat { entitySetName: string, records: array } or export { tables: object } seed data');
}

function splitReservedFiles(record) {
  const { __files: files = null, ...recordBody } = record;
  return { recordBody, files };
}

function isCamelCaseLookupKey(key) {
  // Some hand-authored template seed files use app-style lookup keys:
  //   { "categoryId": "<category-guid>", "serviceTypeId": "<type-guid>" }
  // Dataverse rejects those raw properties. When the referenced GUID was seeded
  // earlier in the same ordered seed run, convert the key to an @odata.bind
  // using the target table's logical name derived from its primary key.
  const match = String(key || '').match(/^([a-z][A-Za-z0-9]*)Id$/);
  return Boolean(match);
}

function indexSeedRecords(seed, idToTarget) {
  if (!seed || !seed.primaryKey) return;
  for (const record of Array.isArray(seed.records) ? seed.records : []) {
    const id = record && record[seed.primaryKey];
    if (typeof id === 'string') {
      idToTarget.set(id.toLowerCase(), {
        entitySetName: seed.entitySetName,
        navigationProperty: entityLogicalNameFromPrimaryKey(seed.primaryKey),
      });
    }
  }
}

function applyCamelCaseLookupBinds(recordBody, idToTarget) {
  const out = {};
  for (const [key, value] of Object.entries(recordBody || {})) {
    if (isCamelCaseLookupKey(key) && typeof value === 'string') {
      const target = idToTarget.get(value.toLowerCase());
      if (target) {
        out[`${target.navigationProperty}@odata.bind`] = `/${target.entitySetName}(${value})`;
        continue;
      }
    }
    out[key] = value;
  }
  return out;
}

function normalizeDataverseExportSeed(seed) {
  if (!seed || typeof seed !== 'object' || !seed.tables || typeof seed.tables !== 'object' || Array.isArray(seed.tables)) {
    return null;
  }
  const idToEntitySet = new Map();
  for (const table of Object.values(seed.tables)) {
    if (!table || typeof table !== 'object' || !Array.isArray(table.records) || typeof table.idColumn !== 'string' || typeof table.entitySet !== 'string') {
      continue;
    }
    for (const record of table.records) {
      const id = record && record[table.idColumn];
      if (typeof id === 'string') idToEntitySet.set(id.toLowerCase(), table.entitySet);
    }
  }
  const filesByRecordId = new Map();
  for (const fileExport of Array.isArray(seed.fileExports) ? seed.fileExports : []) {
    if (!fileExport || typeof fileExport !== 'object') continue;
    const { attachmentId, fileColumn, path: filePath } = fileExport;
    if (typeof attachmentId !== 'string' || typeof fileColumn !== 'string' || typeof filePath !== 'string') continue;
    const current = filesByRecordId.get(attachmentId.toLowerCase()) || {};
    current[fileColumn] = filePath;
    filesByRecordId.set(attachmentId.toLowerCase(), current);
  }
  return Object.values(seed.tables)
    .filter((table) => table && typeof table.entitySet === 'string' && typeof table.idColumn === 'string' && Array.isArray(table.records))
    .map((table) => ({
      entitySetName: table.entitySet,
      primaryKey: table.idColumn,
      records: table.records.map((record) => normalizeExportRecord(record, table.idColumn, idToEntitySet, filesByRecordId)),
    }));
}

function normalizeExportRecord(record, primaryKey, idToEntitySet, filesByRecordId) {
  const out = {};
  const lookupBinds = {};
  for (const [key, value] of Object.entries(record || {})) {
    if (key === '@odata.etag') continue;
    if (key.endsWith('@Microsoft.Dynamics.CRM.associatednavigationproperty')) continue;
    if (key.endsWith('@OData.Community.Display.V1.FormattedValue')) continue;
    if (key === 'createdon' || key === 'modifiedon') continue;

    const lookupMatch = key.match(/^_(.+)_value$/);
    if (lookupMatch) {
      if (typeof value !== 'string') continue;
      const navigationProperty = record[`${key}@Microsoft.Dynamics.CRM.associatednavigationproperty`];
      const targetEntitySet = idToEntitySet.get(value.toLowerCase());
      if (typeof navigationProperty === 'string' && targetEntitySet) {
        lookupBinds[`${navigationProperty}@odata.bind`] = `/${targetEntitySet}(${value})`;
      }
      continue;
    }
    out[key] = value;
  }
  Object.assign(out, lookupBinds);
  const recordId = record && record[primaryKey];
  const files = typeof recordId === 'string' ? filesByRecordId.get(recordId.toLowerCase()) : null;
  if (files) out.__files = files;
  return out;
}

function validateFilesContract({ seedDir, seed, record }, deps = {}) {
  // Attachment-bearing seed records use this raw shape:
  //   {
  //     "entitySetName": "cr123_invoices",
  //     "primaryKey": "cr123_invoiceid",
  //     "records": [{
  //       "cr123_invoiceid": "<guid>",
  //       "__files": { "cr123_invoicepdf": "files/invoices/inv-001.pdf" }
  //     }]
  //   }
  // `__files` is reserved metadata and must never be sent in the record POST.
  // Paths are seed-data-root-relative; absolute paths and `..` segments are
  // rejected so a template cannot read arbitrary local files.
  if (!Object.prototype.hasOwnProperty.call(record, '__files')) return null;
  if (!record.__files || typeof record.__files !== 'object' || Array.isArray(record.__files)) {
    return '__files must be an object mapping file column logical names to seed-data-relative paths';
  }
  if (!seed.primaryKey) return 'Seed file with __files must declare primaryKey';
  const recordId = record[seed.primaryKey];
  if (typeof recordId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(recordId)) {
    return `Record with __files must include GUID primary key ${seed.primaryKey}`;
  }
  for (const [columnName, relativePath] of Object.entries(record.__files)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(columnName)) return `Invalid file column name: ${columnName}`;
    if (typeof relativePath !== 'string' || path.isAbsolute(relativePath) || relativePath.split(/[\\/]+/).includes('..')) {
      return `Attachment path must stay under seed-data root: ${relativePath}`;
    }
    const seedRoot = path.resolve(seedDir);
    const absolutePath = path.resolve(seedDir, relativePath);
    if (!absolutePath.startsWith(seedRoot + path.sep)) return `Attachment path must stay under seed-data root: ${relativePath}`;
  }
  return null;
}

function readFilePrefix(filePath, length, deps = {}) {
  const fsImpl = deps.fs || fs;
  if (typeof fsImpl.openSync === 'function' && typeof fsImpl.readSync === 'function' && typeof fsImpl.closeSync === 'function') {
    const buffer = Buffer.alloc(length);
    const handle = fsImpl.openSync(filePath, 'r');
    try {
      const bytesRead = fsImpl.readSync(handle, buffer, 0, length, 0);
      return buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
      fsImpl.closeSync(handle);
    }
  }
  const content = fsImpl.readFileSync(filePath);
  return (Buffer.isBuffer(content) ? content : Buffer.from(String(content))).subarray(0, length).toString('utf8');
}

function validateAttachmentFile(filePath, deps = {}) {
  const fsImpl = deps.fs || fs;
  const ext = path.extname(filePath).toLowerCase();
  if (!ALLOWED_ATTACHMENT_EXTENSIONS.has(ext)) return `Attachment extension is not allowed: ${ext || '(none)'}`;
  if (!fsImpl.existsSync(filePath)) return `Attachment file not found: ${filePath}`;
  const stat = fsImpl.statSync(filePath);
  if (!stat.isFile()) return `Attachment path is not a file: ${filePath}`;
  // Git LFS pointer files start with:
  //   version https://git-lfs.github.com/spec/v1
  // Spec: https://github.com/git-lfs/git-lfs/blob/main/docs/spec.md
  // The real binary content is not present in that case. Reading only the
  // prefix is sufficient because the signature is the first line. Tests can
  // inject a minimal fs shim that only supports readFileSync; production uses
  // open/read/close to avoid loading large attachments just for pointer checks.
  const prefix = readFilePrefix(filePath, 200, deps);
  if (/^version https:\/\/git-lfs\.github\.com\/spec\/v1/m.test(prefix)) {
    return `Attachment file appears to be a Git LFS pointer: ${filePath}`;
  }
  return null;
}

async function postRecord({ envUrl, tokenProvider, entitySetName, record }, deps = {}) {
  // Dataverse Web API creates records by POSTing to the entity set collection:
  //   POST /api/data/v9.2/accounts
  // See: https://learn.microsoft.com/power-apps/developer/data-platform/webapi/create-entity-web-api
  return postDataverseJson({ envUrl, tokenProvider, apiPath: entitySetName, body: record, includeHeaders: true }, deps);
}

function defaultBlockId() {
  return Buffer.from(generateUuid()).toString('base64');
}

function contentTypeForFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const types = {
    '.pdf': 'application/pdf',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.txt': 'text/plain',
    '.csv': 'text/csv',
    '.json': 'application/json',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  };
  return types[ext] || 'application/octet-stream';
}

function entityLogicalNameFromPrimaryKey(primaryKey) {
  // Dataverse primary keys conventionally use the table logical name plus `id`,
  // e.g. `accountid` -> `account`, `cr123_invoiceid` -> `cr123_invoice`.
  // See Microsoft's Web API examples for file-column upload targets:
  // https://learn.microsoft.com/power-apps/developer/data-platform/file-column-data
  return primaryKey.replace(/id$/i, '');
}

async function uploadFileColumn({ envUrl, tokenProvider, primaryKey, recordId, columnName, filePath }, deps = {}) {
  const fileName = path.basename(filePath);
  const entityLogicalName = entityLogicalNameFromPrimaryKey(primaryKey);
  // Dataverse file columns use actions rather than setting bytes in the record:
  //   InitializeFileBlocksUpload -> UploadBlock* -> CommitFileBlocksUpload
  // See: https://learn.microsoft.com/power-apps/developer/data-platform/file-column-data
  const init = await postDataverseAction({ envUrl, tokenProvider, actionName: 'InitializeFileBlocksUpload', body: {
      Target: {
        [primaryKey]: recordId,
        '@odata.type': `Microsoft.Dynamics.CRM.${entityLogicalName}`,
      },
      FileName: fileName,
      FileAttributeName: columnName,
    } }, deps);
  if (init.error || init.statusCode < 200 || init.statusCode >= 300) {
    throw new Error(init.error || init.body || `InitializeFileBlocksUpload failed (${init.statusCode})`);
  }
  // InitializeFileBlocksUpload returns a JSON payload shaped as:
  //   { "FileContinuationToken": "<opaque token>" }
  // Older/proxy-failed responses can be empty or non-JSON even with an HTTP
  // status, so parse defensively and report a missing token as an upload error.
  let tokenPayload;
  try {
    tokenPayload = JSON.parse(init.body || '{}');
  } catch (err) {
    throw new Error(`InitializeFileBlocksUpload returned invalid JSON: ${err.message}`);
  }
  const continuation = tokenPayload.FileContinuationToken;
  if (!continuation) throw new Error('InitializeFileBlocksUpload did not return FileContinuationToken');

  const blockIds = [];
  const randomBlockId = deps.randomBlockId || defaultBlockId;
  const fsImpl = deps.fs || fs;
  const fileSize = fsImpl.statSync(filePath).size || 0;
  const fileHandle = typeof fsImpl.openSync === 'function' ? fsImpl.openSync(filePath, 'r') : null;
  try {
    let offset = 0;
    while (offset < fileSize) {
      const block = Buffer.alloc(Math.min(FILE_BLOCK_SIZE_BYTES, fileSize - offset));
      if (fileHandle !== null && typeof fsImpl.readSync === 'function') {
        fsImpl.readSync(fileHandle, block, 0, block.length, offset);
      } else {
        fsImpl.readFileSync(filePath).copy(block, 0, offset, offset + block.length);
      }
      offset += block.length;
      const blockId = randomBlockId();
      blockIds.push(blockId);
      const res = await postDataverseAction({ envUrl, tokenProvider, actionName: 'UploadBlock', body: {
          BlockId: blockId,
          BlockData: block.toString('base64'),
          FileContinuationToken: continuation,
        } }, deps);
      if (res.error || res.statusCode < 200 || res.statusCode >= 300) {
        throw new Error(res.error || res.body || `UploadBlock failed (${res.statusCode})`);
      }
    }
  } finally {
    if (fileHandle !== null && typeof fsImpl.closeSync === 'function') fsImpl.closeSync(fileHandle);
  }
  const commit = await postDataverseAction({ envUrl, tokenProvider, actionName: 'CommitFileBlocksUpload', body: {
      BlockList: blockIds,
      FileContinuationToken: continuation,
      FileName: fileName,
      MimeType: contentTypeForFile(filePath),
    } }, deps);
  if (commit.error || commit.statusCode < 200 || commit.statusCode >= 300) {
    throw new Error(commit.error || commit.body || `CommitFileBlocksUpload failed (${commit.statusCode})`);
  }
}

function postDataverseAction({ envUrl, tokenProvider, actionName, body }, deps = {}) {
  return postDataverseJson({ envUrl, tokenProvider, apiPath: actionName, body }, deps);
}

function postDataverseJson({ envUrl, tokenProvider, apiPath, body, includeHeaders = false }, deps = {}) {
  const request = deps.makeRequest || makeRequest;
  return request({
    url: `${envUrl.replace(/\/+$/, '')}/api/data/v9.2/${apiPath}`,
    method: 'POST',
    headers: {
      Authorization: `Bearer ${tokenProvider()}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    includeHeaders,
    timeout: 30000,
  });
}

function createTokenProvider({ envUrl, initialToken, resolveToken, refreshEvery = TOKEN_REFRESH_EVERY_REQUESTS }) {
  let token = initialToken;
  let calls = 0;
  return () => {
    if (!token || calls >= refreshEvery) {
      token = resolveToken(envUrl);
      calls = 0;
    }
    calls += 1;
    return token;
  };
}

async function applySeedData({ seedDir, envUrl }, deps = {}) {
  const summary = emptySummary();
  try {
    const resolveToken = deps.getAuthToken || getAuthToken;
    const token = deps.token || resolveToken(envUrl);
    if (!token) {
      return { ...summary, ok: false, failed: 1, errors: [{ scope: 'auth', message: `Azure CLI token unavailable for ${envUrl}` }] };
    }
    const tokenProvider = deps.tokenProvider || createTokenProvider({ envUrl, initialToken: token, resolveToken, refreshEvery: deps.tokenRefreshEvery || TOKEN_REFRESH_EVERY_REQUESTS });
    const idToEntitySet = new Map();

    for (const filePath of listSeedFiles(seedDir, deps)) {
      let seed;
      try {
        seed = readSeedFile(filePath, deps);
      } catch (err) {
        summary.failed += 1;
        summary.errors.push({ file: path.basename(filePath), message: err.message });
        continue;
      }

      for (const seedEntry of (Array.isArray(seed) ? seed : [seed])) {
        indexSeedRecords(seedEntry, idToEntitySet);
        for (const record of seedEntry.records) {
        const context = { file: path.basename(filePath), entitySetName: seedEntry.entitySetName };
        try {
          const validationError = validateFilesContract({ seedDir, seed: seedEntry, record }, deps);
          const { recordBody, files } = splitReservedFiles(record);
          if (validationError) {
            summary.failed += 1;
            summary.errors.push({ ...context, message: validationError });
            continue;
          }
          const res = await postRecord({ envUrl, tokenProvider, entitySetName: seedEntry.entitySetName, record: applyCamelCaseLookupBinds(recordBody, idToEntitySet) }, deps);
          let shouldUploadFiles = false;
          if (res.error) {
            summary.failed += 1;
            summary.errors.push({ ...context, message: res.error });
          } else if (isDuplicateConflict(res)) {
            summary.skipped += 1;
            shouldUploadFiles = true;
          } else if (res.statusCode >= 200 && res.statusCode < 300) {
            summary.inserted += 1;
            shouldUploadFiles = true;
          } else {
            summary.failed += 1;
            summary.errors.push({ ...context, statusCode: res.statusCode, message: res.body || `HTTP ${res.statusCode}` });
          }
          if (shouldUploadFiles && files) {
            await uploadRecordFiles({ seedDir, seed: seedEntry, record, files, envUrl, tokenProvider, summary, context }, deps);
          }
        } catch (err) {
          summary.failed += 1;
          summary.errors.push({ ...context, message: err.message });
        }
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

async function uploadRecordFiles({ seedDir, seed, record, files, envUrl, tokenProvider, summary, context }, deps = {}) {
  for (const [columnName, relativePath] of Object.entries(files)) {
    try {
      const filePath = path.join(seedDir, relativePath);
      const fileError = validateAttachmentFile(filePath, deps);
      if (fileError) throw new Error(fileError);
      await uploadFileColumn({
        envUrl,
        tokenProvider,
        primaryKey: seed.primaryKey,
        recordId: record[seed.primaryKey],
        columnName,
        filePath,
      }, deps);
    } catch (err) {
      summary.failed += 1;
      summary.errors.push({ ...context, columnName, attachmentPath: relativePath, message: err.message });
    }
  }
}

module.exports = {
  applySeedData,
  emptySummary,
  listSeedFiles,
  readSeedFile,
  normalizeDataverseExportSeed,
  normalizeExportRecord,
  postRecord,
  isDuplicateConflict,
  splitReservedFiles,
  validateFilesContract,
  validateAttachmentFile,
  uploadFileColumn,
  uploadRecordFiles,
  postDataverseJson,
  createTokenProvider,
  entityLogicalNameFromPrimaryKey,
  contentTypeForFile,
  postDataverseAction,
  FILE_BLOCK_SIZE_BYTES,
  ALLOWED_ATTACHMENT_EXTENSIONS,
  TOKEN_REFRESH_EVERY_REQUESTS,
};
