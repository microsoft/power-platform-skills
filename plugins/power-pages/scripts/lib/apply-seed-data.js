'use strict';

const fs = require('fs');
const path = require('path');
const {
  getAuthToken,
  makeRequest,
  validateDataverseEnvironmentUrl,
  odataGet,
} = require('./validation-helpers');
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
const ODATA_IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DATAVERSE_GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function emptySummary() {
  return { ok: true, inserted: 0, failed: 0, skipped: 0, errors: [] };
}

function emptyPlan() {
  return { ok: true, writes: 0, counts: { tables: 0, records: 0, files: 0 },
    financialEntitySets: [], currencies: [], requiresCurrencySelection: false, errors: [] };
}

function listSeedFiles(seedDir, deps = {}, seedFile = null) {
  const fsImpl = deps.fs || fs;
  if (!seedDir || !fsImpl.existsSync(seedDir)) return [];
  const rootStat = fsImpl.lstatSync(seedDir);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error('Seed directory must be a regular directory and not a symbolic link');
  }
  if (seedFile) {
    const resolvedSeedFile = path.resolve(seedFile);
    if (path.extname(resolvedSeedFile).toLowerCase() !== '.json') {
      throw new Error(`Seed file must be JSON: ${seedFile}`);
    }
    const containmentError = validateContainedPath(seedDir, resolvedSeedFile, fsImpl);
    if (containmentError) throw new Error(containmentError.replace(/^Attachment path/, 'Seed file'));
    return [resolvedSeedFile];
  }
  return fsImpl.readdirSync(seedDir)
    .filter((name) => name.toLowerCase().endsWith('.json'))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((name) => {
      const filePath = path.join(seedDir, name);
      const fileStat = fsImpl.lstatSync(filePath);
      if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
        throw new Error(`Seed JSON must be a regular file and not a symbolic link: ${name}`);
      }
      return filePath;
    });
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
  const fileStat = fsImpl.lstatSync(filePath);
  if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
    throw new Error(`Seed JSON must be a regular file and not a symbolic link: ${path.basename(filePath)}`);
  }
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
  if (Array.isArray(normalizedExport) && normalizedExport.length > 0) return normalizedExport;
  throw new Error('Expected flat { entitySetName: string, records: array } or export { tables: object } seed data');
}

function splitReservedFiles(record) {
  const { __files: files = null, ...recordBody } = record;
  // File uploads populate the file GUID and its read-only <column>_name companion.
  // Strip only declared uploads; ordinary business name columns remain writable.
  // https://learn.microsoft.com/power-apps/developer/data-platform/file-column-data
  if (files && typeof files === 'object' && !Array.isArray(files)) {
    for (const column of Object.keys(files)) {
      delete recordBody[column];
      delete recordBody[`${column}_name`];
    }
  }
  return { recordBody, files };
}

function uploadFileName(record, columnName, filePath) {
  const companion = `${columnName}_name`;
  const name = Object.prototype.hasOwnProperty.call(record, companion)
    ? record[companion] : path.basename(filePath);
  if (typeof name !== 'string' || !name.trim() || name !== name.trim() ||
      name === '.' || name === '..' || /[\\/:<>"|?*\x00-\x1f\x7f]/.test(name) ||
      /%(?:2f|5c|00)/i.test(name) ||
      /[. ]$/.test(name) || name.length > 255) {
    throw new Error(`Invalid upload filename for ${columnName}; expected a non-empty filename without path segments`);
  }
  return name;
}

function splitCreateAndStateUpdate(seed, record) {
  const createRecord = { ...record };
  const stateUpdate = {};
  for (const field of ['statecode', 'statuscode']) {
    if (!Object.prototype.hasOwnProperty.call(createRecord, field)) continue;
    stateUpdate[field] = createRecord[field];
    delete createRecord[field];
  }
  if (Object.keys(stateUpdate).length === 0) {
    return { createRecord, stateUpdate: null, recordId: null };
  }

  const recordId = seed.primaryKey && record[seed.primaryKey];
  if (typeof recordId !== 'string' || !DATAVERSE_GUID_RE.test(recordId)) {
    throw new Error('Seed records with statecode or statuscode must declare a primaryKey containing a GUID');
  }
  return { createRecord, stateUpdate, recordId };
}

function isCamelCaseLookupKey(key) {
  // App-style lookup aliases can appear in hand-authored seed files:
  //   { "categoryId": "<category-guid>", "serviceTypeId": "<type-guid>" }
  // Dataverse does not accept these aliases, and the exact navigation property
  // cannot be derived from either the alias or the target table's primary key.
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
      });
    }
  }
}

function validateSeedLookupContract(seedEntries) {
  const idToTarget = new Map();
  for (const { seed } of seedEntries) indexSeedRecords(seed, idToTarget);

  const errors = [];
  for (const { file, seed } of seedEntries) {
    if (!ODATA_IDENTIFIER_RE.test(String(seed.entitySetName || ''))) {
      errors.push({ file, entitySetName: seed.entitySetName,
        message: `Invalid Dataverse OData operation name: ${seed.entitySetName}` });
      continue;
    }
    if ((seed.logicalName !== undefined && !ODATA_IDENTIFIER_RE.test(String(seed.logicalName))) ||
        (seed.primaryKey !== undefined && !ODATA_IDENTIFIER_RE.test(String(seed.primaryKey)))) {
      errors.push({ file, entitySetName: seed.entitySetName, message: 'Invalid seed logicalName or primaryKey identifier' });
      continue;
    }
    for (const record of seed.records) {
      if (!record || typeof record !== 'object' || Array.isArray(record)) {
        errors.push({ file, entitySetName: seed.entitySetName, message: 'Seed record must be an object' });
        continue;
      }
      for (const [key, value] of Object.entries(record || {})) {
        if (isCamelCaseLookupKey(key) && typeof value === 'string') {
          errors.push({
            file,
            entitySetName: seed.entitySetName,
            message: `Lookup ${key} is ambiguous; use the exact <NavigationProperty>@odata.bind name from the solution metadata`,
          });
          continue;
        }
        if (!key.endsWith('@odata.bind')) continue;
        // Seed lookups use the OData bind shape:
        //   "spa311_CategoryId@odata.bind":
        //     "/spa311_categories(11111111-1111-1111-1111-111111111111)"
        // Validate references to records in this seed set before any writes. The
        // navigation-property key itself remains authoritative solution metadata.
        // Collection-valued binds associate N:N rows on create, e.g.
        // "cr123_Contacts@odata.bind": ["/contacts(<guid>)", "/contacts(<guid>)"].
        // Validate each member without converting it to intersect-table upserts.
        // https://learn.microsoft.com/power-apps/developer/data-platform/webapi/associate-disassociate-entities-using-web-api
        const references = Array.isArray(value) ? value : [value];
        let collectionEntitySet = null;
        for (const reference of references) {
          const match = typeof reference === 'string' &&
            reference.match(/^\/([A-Za-z_][A-Za-z0-9_]*)\(([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)$/i);
          if (!match) {
            errors.push({
              file,
              entitySetName: seed.entitySetName,
              message: `Lookup ${key} must use /<entitySetName>(<guid>)`,
            });
            continue;
          }
          if (collectionEntitySet && collectionEntitySet !== match[1]) {
            errors.push({ file, entitySetName: seed.entitySetName,
              message: `Lookup ${key} collection must reference one entity set` });
          }
          collectionEntitySet = match[1];
          const target = idToTarget.get(match[2].toLowerCase());
          if (target && target.entitySetName !== match[1]) {
            errors.push({
              file,
              entitySetName: seed.entitySetName,
              message: `Lookup ${key} targets ${match[1]}, but the referenced seed record belongs to ${target.entitySetName}`,
            });
          }
        }
      }
    }
  }
  return errors;
}

function normalizeDataverseExportSeed(seed) {
  if (!seed || typeof seed !== 'object' || !seed.tables || typeof seed.tables !== 'object' || Array.isArray(seed.tables)) {
    return null;
  }
  const idToEntitySet = new Map();
  const idCounts = new Map();
  for (const table of Object.values(seed.tables)) {
    if (!table || typeof table !== 'object' || !Array.isArray(table.records) || typeof table.idColumn !== 'string' || typeof table.entitySet !== 'string') {
      throw new Error('Expected export tables to declare entitySet, idColumn and records');
    }
    for (const record of table.records) {
      if (!record || typeof record !== 'object' || Array.isArray(record)) {
        throw new Error('Export seed record must be an object');
      }
      const id = record && record[table.idColumn];
      if (typeof id === 'string') {
        idToEntitySet.set(id.toLowerCase(), table.entitySet);
        idCounts.set(id.toLowerCase(), (idCounts.get(id.toLowerCase()) || 0) + 1);
      }
    }
  }
  const filesByRecordId = new Map();
  if (seed.fileExports !== undefined && !Array.isArray(seed.fileExports)) {
    throw new Error('fileExports must be an array of declared uploads');
  }
  for (const fileExport of seed.fileExports || []) {
    if (!fileExport || typeof fileExport !== 'object') throw new Error('Invalid fileExports upload declaration');
    const { attachmentId, fileColumn, path: filePath } = fileExport;
    if (typeof attachmentId !== 'string' || !DATAVERSE_GUID_RE.test(attachmentId) ||
        typeof fileColumn !== 'string' || !ODATA_IDENTIFIER_RE.test(fileColumn) ||
        typeof filePath !== 'string' || !filePath.trim()) {
      throw new Error('fileExports upload requires GUID attachmentId, fileColumn and path');
    }
    if (idCounts.get(attachmentId.toLowerCase()) !== 1) {
      throw new Error('fileExports attachmentId must identify exactly one source record');
    }
    const current = filesByRecordId.get(attachmentId.toLowerCase()) || {};
    if (Object.prototype.hasOwnProperty.call(current, fileColumn)) throw new Error('Duplicate fileExports upload column for attachmentId');
    current[fileColumn] = filePath;
    filesByRecordId.set(attachmentId.toLowerCase(), current);
  }
  return Object.values(seed.tables)
    .filter((table) => table && typeof table.entitySet === 'string' && typeof table.idColumn === 'string' && Array.isArray(table.records))
    .map((table) => ({
      entitySetName: table.entitySet,
      primaryKey: table.idColumn,
      ...(table.logicalName !== undefined ? { logicalName: table.logicalName } : {}),
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
  const fsImpl = deps.fs || fs;
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
  if (!ODATA_IDENTIFIER_RE.test(seed.primaryKey)) return 'Invalid file primaryKey identifier';
  const recordId = record[seed.primaryKey];
  if (typeof recordId !== 'string' || !DATAVERSE_GUID_RE.test(recordId)) {
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
    const containmentError = validateContainedPath(seedRoot, absolutePath, fsImpl);
    if (containmentError) return containmentError;
    try {
      uploadFileName(record, columnName, absolutePath);
    } catch (err) {
      return err.message;
    }
  }
  return null;
}

function validateContainedPath(rootPath, targetPath, fsImpl = fs) {
  const root = path.resolve(rootPath);
  const target = path.resolve(targetPath);
  if (target === root || !target.startsWith(root + path.sep)) {
    return `Attachment path must stay under seed-data root: ${targetPath}`;
  }
  try {
    const rootStat = fsImpl.lstatSync(root);
    if (
      (typeof rootStat.isDirectory === 'function' && !rootStat.isDirectory()) ||
      (typeof rootStat.isSymbolicLink === 'function' && rootStat.isSymbolicLink())
    ) {
      return `Seed-data root must be a regular directory: ${root}`;
    }
    let current = root;
    for (const segment of path.relative(root, target).split(path.sep)) {
      current = path.join(current, segment);
      const stat = fsImpl.lstatSync(current);
      if (typeof stat.isSymbolicLink === 'function' && stat.isSymbolicLink()) {
        return `Attachment path contains a symbolic link: ${current}`;
      }
    }
    if (typeof fsImpl.realpathSync === 'function') {
      const realRoot = fsImpl.realpathSync(root);
      const realTarget = fsImpl.realpathSync(target);
      if (realTarget === realRoot || !realTarget.startsWith(realRoot + path.sep)) {
        return `Attachment path resolves outside seed-data root: ${targetPath}`;
      }
    }
  } catch (err) {
    return `Attachment path could not be inspected: ${targetPath} (${err.message})`;
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
  if (deps.seedDir) {
    const containmentError = validateContainedPath(deps.seedDir, filePath, fsImpl);
    if (containmentError) return containmentError;
  }
  const ext = path.extname(filePath).toLowerCase();
  if (!ALLOWED_ATTACHMENT_EXTENSIONS.has(ext)) return `Attachment extension is not allowed: ${ext || '(none)'}`;
  if (!fsImpl.existsSync(filePath)) return `Attachment file not found: ${filePath}`;
  const stat = fsImpl.lstatSync(filePath);
  if (!stat.isFile()) return `Attachment path is not a file: ${filePath}`;
  if (stat.size === 0) return `Attachment file is empty: ${filePath}`;
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

async function patchRecordState({ envUrl, tokenProvider, entitySetName, recordId, stateUpdate }, deps = {}) {
  // Some Dataverse tables permit only their default state during create.
  // KnowledgeArticle, for example, is always created as Draft and must be
  // transitioned to Published through a separate Update containing only its
  // state fields. Mixing statecode/statuscode into the POST makes Dataverse
  // validate the published status reason against the forced Draft state.
  // See: https://learn.microsoft.com/power-apps/developer/data-platform/special-update-operation-behavior
  // See: https://learn.microsoft.com/power-apps/developer/data-platform/reference/entities/knowledgearticle
  return requestDataverseJson({
    envUrl,
    tokenProvider,
    apiPath: entitySetName,
    recordId,
    method: 'PATCH',
    body: stateUpdate,
  }, deps);
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

async function uploadFileColumn({ envUrl, tokenProvider, primaryKey, recordId, columnName, filePath, fileName = path.basename(filePath) }, deps = {}) {
  if (!ODATA_IDENTIFIER_RE.test(String(primaryKey || '')) ||
      !ODATA_IDENTIFIER_RE.test(String(columnName || '')) || !DATAVERSE_GUID_RE.test(String(recordId || ''))) {
    throw new Error('File upload requires valid primaryKey, recordId and columnName identifiers');
  }
  uploadFileName({ [`${columnName}_name`]: fileName }, columnName, filePath);
  const fileError = validateAttachmentFile(filePath, deps);
  if (fileError) throw new Error(fileError);
  const entityLogicalName = entityLogicalNameFromPrimaryKey(primaryKey);
  if (!ODATA_IDENTIFIER_RE.test(entityLogicalName)) throw new Error('Invalid file target logical name');
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
  requireSuccess(init, 'InitializeFileBlocksUpload');
  // InitializeFileBlocksUpload returns a JSON payload shaped as:
  //   { "FileContinuationToken": "<opaque token>" }
  // Older/proxy-failed responses can be empty or non-JSON even with an HTTP
  // status, so parse defensively and report a missing token as an upload error.
  let tokenPayload;
  try {
    tokenPayload = JSON.parse(init.body || '{}');
  } catch {
    // JSON parser messages can quote response bytes containing the opaque upload token.
    throw new Error('InitializeFileBlocksUpload returned invalid JSON');
  }
  const continuation = tokenPayload && tokenPayload.FileContinuationToken;
  if (typeof continuation !== 'string' || !continuation.trim()) throw new Error('InitializeFileBlocksUpload did not return a valid FileContinuationToken');

  const blockIds = [];
  const randomBlockId = deps.randomBlockId || defaultBlockId;
  const fsImpl = deps.fs || fs;
  const fileSize = fsImpl.statSync(filePath).size;
  if (!Number.isSafeInteger(fileSize) || fileSize <= 0) throw new Error('Attachment file must have a non-zero valid size');
  const fileHandle = typeof fsImpl.openSync === 'function' ? fsImpl.openSync(filePath, 'r') : null;
  try {
    let offset = 0;
    while (offset < fileSize) {
      const block = Buffer.alloc(Math.min(FILE_BLOCK_SIZE_BYTES, fileSize - offset));
      if (fileHandle !== null && typeof fsImpl.readSync === 'function') {
        let bytesRead = 0;
        while (bytesRead < block.length) {
          const count = fsImpl.readSync(fileHandle, block, bytesRead, block.length - bytesRead, offset + bytesRead);
          if (!Number.isInteger(count) || count <= 0) throw new Error('Attachment read ended before the expected file size');
          bytesRead += count;
        }
      } else {
        const bytesRead = fsImpl.readFileSync(filePath).copy(block, 0, offset, offset + block.length);
        if (bytesRead !== block.length) throw new Error('Attachment read ended before the expected file size');
      }
      offset += block.length;
      const blockId = randomBlockId();
      blockIds.push(blockId);
      const res = await postDataverseAction({ envUrl, tokenProvider, actionName: 'UploadBlock', body: {
          BlockId: blockId,
          BlockData: block.toString('base64'),
          FileContinuationToken: continuation,
        } }, deps);
      requireSuccess(res, 'UploadBlock');
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
  requireSuccess(commit, 'CommitFileBlocksUpload');
}

function requireSuccess(response, operation) {
  if (!response || !Number.isInteger(response.statusCode) ||
      response.error || response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(response && (response.error || response.body) ||
      `${operation} failed (HTTP ${response && response.statusCode || 'invalid response'})`);
  }
}

function postDataverseAction({ envUrl, tokenProvider, actionName, body }, deps = {}) {
  return postDataverseJson({ envUrl, tokenProvider, apiPath: actionName, body }, deps);
}

function postDataverseJson({ envUrl, tokenProvider, apiPath, body, includeHeaders = false }, deps = {}) {
  return requestDataverseJson({
    envUrl,
    tokenProvider,
    apiPath,
    method: 'POST',
    body,
    includeHeaders,
  }, deps);
}

async function requestDataverseJson({
  envUrl,
  tokenProvider,
  apiPath,
  recordId = null,
  method,
  body,
  includeHeaders = false,
}, deps = {}) {
  const request = safeSeedRequest(envUrl, deps);
  const trustedEnvUrl = validateDataverseEnvironmentUrl(envUrl);
  if (!ODATA_IDENTIFIER_RE.test(String(apiPath || ''))) {
    throw new Error(`Invalid Dataverse OData operation name: ${apiPath}`);
  }
  if (method !== 'POST' && method !== 'PATCH') {
    throw new Error(`Unsupported Dataverse JSON method: ${method}`);
  }
  if (recordId !== null && !DATAVERSE_GUID_RE.test(String(recordId))) {
    throw new Error(`Invalid Dataverse record id: ${recordId}`);
  }
  const headers = {
    Authorization: `Bearer ${requireToken(tokenProvider())}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
  if (method === 'PATCH') {
    // The record was just created or was detected as an existing duplicate.
    // Prevent PATCH from silently upserting a replacement if it disappears.
    headers['If-Match'] = '*';
  }
  return request({
    url: `${trustedEnvUrl}/api/data/v9.2/${apiPath}${recordId === null ? '' : `(${recordId})`}`,
    method,
    headers,
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
    if (typeof token !== 'string' || !token.trim()) throw new Error('Azure CLI token unavailable');
    calls += 1;
    return token;
  };
}

function loadSeedEntries({ seedDir, seedFile }, deps, summary) {
  const seedEntries = [];
  for (const filePath of listSeedFiles(seedDir, deps, seedFile)) {
    try {
      const seed = readSeedFile(filePath, deps);
      for (const seedEntry of (Array.isArray(seed) ? seed : [seed])) {
        seedEntries.push({ file: path.basename(filePath), seed: seedEntry });
      }
    } catch (err) {
      summary.errors.push({ file: path.basename(filePath), message: err.message });
    }
  }
  return seedEntries;
}

function normalizeCurrencyCode(currencyCode) {
  if (typeof currencyCode !== 'string' || !/^[A-Za-z]{3}$/.test(currencyCode)) {
    throw new Error('currencyCode must contain exactly three ASCII letters (ISO currency code)');
  }
  return currencyCode.toUpperCase();
}

function runTokenProvider(envUrl, deps) {
  const resolveToken = deps.getAuthToken || getAuthToken;
  const token = deps.token || resolveToken(envUrl);
  if (typeof token !== 'string' || !token.trim()) {
    const error = new Error(`Azure CLI token unavailable for ${envUrl}`);
    error.code = 'SEED_AUTH_UNAVAILABLE';
    throw error;
  }
  return deps.tokenProvider || createTokenProvider({
    envUrl, initialToken: token, resolveToken,
    refreshEvery: deps.tokenRefreshEvery || TOKEN_REFRESH_EVERY_REQUESTS,
  });
}

function requireToken(token) {
  if (typeof token !== 'string' || !token.trim()) throw new Error('Azure CLI token unavailable');
  return token;
}

function redactDiagnostic(message, secrets = []) {
  let text = String(message);
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret) text = text.split(secret).join('<REDACTED>');
  }
  return text.replace(/("FileContinuationToken"\s*:\s*")[^"]*"/gi, '$1<REDACTED>"')
    .replace(/Bearer\s+\S+/gi, 'Bearer <REDACTED>');
}

function safeSeedRequest(envUrl, deps) {
  const origin = new URL(validateDataverseEnvironmentUrl(envUrl)).origin;
  const request = deps.makeRequest || makeRequest;
  return async (options) => {
    const url = new URL(options.url, origin);
    if (url.origin !== origin || url.username || url.password || url.hash ||
        !url.pathname.startsWith('/api/data/v9.2/')) {
      throw new Error('Seed request must remain on the current Dataverse origin and Web API path');
    }
    const authorization = options.headers && options.headers.Authorization;
    const secrets = [typeof authorization === 'string' ? authorization.replace(/^Bearer /, '') : null];
    if (options.body) {
      const body = JSON.parse(options.body);
      secrets.push(body.FileContinuationToken);
    }
    try {
      const response = await request({ ...options, url: url.href });
      if (!response || typeof response !== 'object') throw new Error('Invalid Dataverse response');
      return {
        ...response,
        ...(response.error ? { error: redactDiagnostic(response.error, secrets) } : {}),
        // Success bodies include continuation tokens needed by the next upload action.
        // Redact only error bodies, so diagnostics cannot echo bearer or file tokens.
        ...((response.error || !Number.isInteger(response.statusCode) || response.statusCode < 200 || response.statusCode >= 300)
          ? { body: redactDiagnostic(response.body || '', secrets) } : {}),
      };
    } catch (err) {
      throw new Error(redactDiagnostic(err.message, secrets));
    }
  };
}

async function seedGetAll(envUrl, apiPath, tokenProvider, deps) {
  const request = safeSeedRequest(envUrl, deps);
  const guardedRequest = async (options) => {
    const response = await request(options);
    requireSuccess(response, 'Metadata/currency query');
    return response;
  };
  const rows = [];
  let next = `${envUrl}/api/data/v9.2/${apiPath}`;
  const visited = new Set();
  while (next) {
    if (visited.has(next) || visited.size >= 100) throw new Error('Metadata/currency pagination did not terminate');
    visited.add(next);
    const token = requireToken(tokenProvider());
    let page;
    try {
      page = await odataGet(next, token, guardedRequest);
    } catch (err) {
      if (err instanceof SyntaxError) throw new Error('Metadata/currency query returned invalid JSON');
      throw new Error(redactDiagnostic(err.message, [token]));
    }
    if (!page || !Array.isArray(page.value)) throw new Error('Metadata/currency query must return a JSON value array');
    rows.push(...page.value);
    next = page['@odata.nextLink'];
    if (next !== undefined && (typeof next !== 'string' || !next.trim())) {
      throw new Error('Invalid metadata/currency @odata.nextLink');
    }
  }
  return rows;
}

async function discoverFinancialEntities(seedEntries, envUrl, tokenProvider, deps) {
  const byEntitySet = new Map();
  for (const { seed } of seedEntries) {
    if (seed.entitySetName === 'transactioncurrencies') {
      throw new Error('Currency selection cannot create currencies from seed data; choose an existing target currency');
    }
    const group = byEntitySet.get(seed.entitySetName) || { seeds: [], records: [] };
    group.seeds.push(seed);
    group.records.push(...seed.records);
    byEntitySet.set(seed.entitySetName, group);
  }
  const financial = [];
  for (const [entitySetName, group] of byEntitySet) {
    if (!ODATA_IDENTIFIER_RE.test(entitySetName)) throw new Error(`Invalid Dataverse OData operation name: ${entitySetName}`);
    if (group.records.length === 0) continue;
    const entities = await seedGetAll(envUrl,
      `EntityDefinitions?$select=LogicalName,EntitySetName,PrimaryIdAttribute&$filter=EntitySetName eq '${entitySetName}'`,
      tokenProvider, deps);
    if (entities.length !== 1 || !entities[0] || entities[0].EntitySetName !== entitySetName ||
        !ODATA_IDENTIFIER_RE.test(String(entities[0].LogicalName || '')) ||
        !ODATA_IDENTIFIER_RE.test(String(entities[0].PrimaryIdAttribute || ''))) {
      throw new Error(`Unsupported or ambiguous entity metadata for ${entitySetName}`);
    }
    const logicalName = entities[0].LogicalName;
    if (group.seeds.some((seed) => seed.logicalName && seed.logicalName !== logicalName)) {
      throw new Error(`Seed logicalName disagrees with target metadata for ${entitySetName}`);
    }
    // Money detection uses the typed metadata endpoint, never amount/price/name heuristics.
    // https://learn.microsoft.com/power-apps/developer/data-platform/webapi/query-metadata-web-api
    const attributes = await seedGetAll(envUrl,
      `EntityDefinitions(LogicalName='${logicalName}')/Attributes/Microsoft.Dynamics.CRM.MoneyAttributeMetadata?$select=LogicalName,IsValidForCreate`,
      tokenProvider, deps);
    if (attributes.some((attr) => !attr || !ODATA_IDENTIFIER_RE.test(String(attr.LogicalName || '')) ||
        typeof attr.IsValidForCreate !== 'boolean') ||
        new Set(attributes.map((attr) => attr.LogicalName)).size !== attributes.length) {
      throw new Error(`Unsupported Money metadata for ${entitySetName}`);
    }
    const usedAttributes = attributes.filter((attr) =>
      group.records.some((record) => Object.prototype.hasOwnProperty.call(record, attr.LogicalName)));
    if (usedAttributes.length === 0) continue;
    if (usedAttributes.some((attr) => !attr.IsValidForCreate)) {
      throw new Error(`Unsupported non-creatable Money attribute in ${entitySetName}`);
    }
    const moneyAttributes = usedAttributes.map((attr) => attr.LogicalName).sort();
    const records = group.records.filter((record) =>
      moneyAttributes.some((attr) => Object.prototype.hasOwnProperty.call(record, attr)));
    const relationships = await seedGetAll(envUrl,
      `EntityDefinitions(LogicalName='${logicalName}')/ManyToOneRelationships?$select=ReferencedEntity,ReferencingEntity,ReferencingAttribute,ReferencingEntityNavigationPropertyName&$filter=ReferencedEntity eq 'transactioncurrency'`,
      tokenProvider, deps);
    const currencyRelationships = relationships.filter((r) => r && r.ReferencedEntity === 'transactioncurrency' &&
      r.ReferencingEntity === logicalName && r.ReferencingAttribute === 'transactioncurrencyid');
    if (currencyRelationships.length !== 1 ||
        !ODATA_IDENTIFIER_RE.test(String(currencyRelationships[0].ReferencingEntityNavigationPropertyName || ''))) {
      throw new Error(`Unsupported or ambiguous currency navigation metadata for ${entitySetName}`);
    }
    // Lookup writes require the exact metadata navigation property, including case.
    // https://learn.microsoft.com/power-apps/developer/data-platform/webapi/web-api-navigation-properties
    financial.push({ entitySetName, logicalName, moneyAttributes, records,
      navigationProperty: currencyRelationships[0].ReferencingEntityNavigationPropertyName });
  }
  return financial;
}

async function queryTargetCurrencies(envUrl, tokenProvider, deps, currencyCode) {
  const rows = await seedGetAll(envUrl,
    'transactioncurrencies?$select=transactioncurrencyid,isocurrencycode,currencyname,statecode&$filter=statecode eq 0' +
      (currencyCode ? ` and isocurrencycode eq '${currencyCode}'` : ''), tokenProvider, deps);
  const currencies = rows.map((row) => {
    if (!row || row.statecode !== 0 || !DATAVERSE_GUID_RE.test(String(row.transactioncurrencyid || '')) ||
        typeof row.currencyname !== 'string' || !row.currencyname.trim()) {
      throw new Error('Target currency query returned invalid or inactive currency metadata');
    }
    const code = normalizeCurrencyCode(row.isocurrencycode);
    if (currencyCode && code !== currencyCode) throw new Error('Target currency query returned a mismatched code');
    return { code, name: row.currencyname, id: row.transactioncurrencyid };
  });
  if (currencyCode && currencies.length !== 1) {
    throw new Error(`Expected one existing active ${currencyCode} target currency; found ${currencies.length}`);
  }
  if (!currencies.length) throw new Error('No existing active target currencies are available');
  if (new Set(currencies.map((currency) => currency.code)).size !== currencies.length) {
    throw new Error('Target active currency codes are ambiguous (duplicate codes)');
  }
  return currencies;
}

function bindTargetCurrency(financial, currency) {
  const bind = `/transactioncurrencies(${currency.id})`;
  // Check every row first. A conflict must stop the run before even unrelated tables write.
  for (const entity of financial) {
    for (const record of entity.records) {
      for (const [key, value] of Object.entries(record)) {
        if (!key.endsWith('@odata.bind')) continue;
        const references = Array.isArray(value) ? value : [value];
        if (key === `${entity.navigationProperty}@odata.bind` ||
            references.some((reference) => typeof reference === 'string' && /^\/transactioncurrencies\(/i.test(reference))) {
          if (key !== `${entity.navigationProperty}@odata.bind` || typeof value !== 'string' ||
              value.toLowerCase() !== bind.toLowerCase()) {
            throw new Error(`Explicit currency binding disagrees with selected ${currency.code} for ${entity.entitySetName}`);
          }
        }
      }
      if (Object.prototype.hasOwnProperty.call(record, 'transactioncurrencyid')) {
        throw new Error(`Currency lookup must use exact metadata navigation for ${entity.entitySetName}`);
      }
    }
  }
  for (const entity of financial) {
    for (const record of entity.records) {
      // Source lookup GUIDs and exchange rates are environment-specific.
      // Select only the reviewed target currency; Dataverse owns its exchange rate.
      // https://learn.microsoft.com/power-apps/developer/data-platform/transaction-currency-currency-entity
      delete record._transactioncurrencyid_value;
      delete record.exchangerate;
      record[`${entity.navigationProperty}@odata.bind`] = bind;
    }
  }
}

async function planSeedData({ seedDir, seedFile, envUrl, currencyCode }, deps = {}) {
  const plan = emptyPlan();
  try {
    envUrl = validateDataverseEnvironmentUrl(envUrl);
    if (currencyCode !== undefined) currencyCode = normalizeCurrencyCode(currencyCode);
    const entries = loadSeedEntries({ seedDir, seedFile }, deps, plan);
    if (!entries.length && !plan.errors.length) throw new Error('No seed JSON source was found');
    plan.errors.push(...validateSeedLookupContract(entries));
    plan.counts.tables = new Set(entries.map(({ seed }) => seed.entitySetName)).size;
    for (const { file, seed } of entries) {
      plan.counts.records += seed.records.length;
      for (const record of seed.records) {
        try {
          const error = validateFilesContract({ seedDir, seed, record }, deps);
          if (error) throw new Error(error);
          const { recordBody, files } = splitReservedFiles(record);
          splitCreateAndStateUpdate(seed, recordBody);
          for (const relativePath of Object.values(files || {})) {
            plan.counts.files += 1;
            const fileError = validateAttachmentFile(path.join(seedDir, relativePath), { ...deps, seedDir });
            if (fileError) throw new Error(fileError);
          }
        } catch (err) {
          plan.errors.push({ file, entitySetName: seed.entitySetName, message: err.message });
        }
      }
    }
    if (plan.errors.length) {
      plan.ok = false;
      return plan;
    }
    const tokenProvider = runTokenProvider(envUrl, deps);
    const financial = await discoverFinancialEntities(entries, envUrl, tokenProvider, deps);
    plan.financialEntitySets = financial.map(({ entitySetName, logicalName, records, moneyAttributes }) =>
      ({ entitySetName, logicalName, recordCount: records.length, moneyAttributes }));
    if (financial.length || currencyCode) {
      plan.currencies = await queryTargetCurrencies(envUrl, tokenProvider, deps, currencyCode);
      if (currencyCode) bindTargetCurrency(financial, plan.currencies[0]);
    }
    plan.requiresCurrencySelection = financial.length > 0 && !currencyCode;
  } catch (err) {
    plan.ok = false;
    plan.errors.push({ scope: 'plan', message: err.message });
  }
  return plan;
}

async function applySeedData({ seedDir, seedFile, envUrl, currencyCode }, deps = {}) {
  const summary = emptySummary();
  try {
    envUrl = validateDataverseEnvironmentUrl(envUrl);
    if (currencyCode !== undefined) currencyCode = normalizeCurrencyCode(currencyCode);
    const seedEntries = loadSeedEntries({ seedDir, seedFile }, deps, summary);
    summary.errors.push(...validateSeedLookupContract(seedEntries));
    if (summary.errors.length > 0) {
      summary.ok = false;
      summary.failed = summary.errors.length;
      return summary;
    }

    const tokenProvider = runTokenProvider(envUrl, deps);
    if (!seedEntries.length) throw new Error('No seed JSON source was found');
    if (currencyCode) {
      const financial = await discoverFinancialEntities(seedEntries, envUrl, tokenProvider, deps);
      const [currency] = await queryTargetCurrencies(envUrl, tokenProvider, deps, currencyCode);
      bindTargetCurrency(financial, currency);
    }
    for (const { file, seed: seedEntry } of seedEntries) {
      for (const record of seedEntry.records) {
        const context = { file, entitySetName: seedEntry.entitySetName };
        try {
          const validationError = validateFilesContract({ seedDir, seed: seedEntry, record }, deps);
          const { recordBody, files } = splitReservedFiles(record);
          if (validationError) {
            summary.failed += 1;
            summary.errors.push({ ...context, message: validationError });
            continue;
          }
          const { createRecord, stateUpdate, recordId } = splitCreateAndStateUpdate(seedEntry, recordBody);
          const res = await postRecord({ envUrl, tokenProvider, entitySetName: seedEntry.entitySetName, record: createRecord }, deps);
          let outcome = null;
          if (res.error) {
            summary.failed += 1;
            summary.errors.push({ ...context, message: res.error });
          } else if (isDuplicateConflict(res)) {
            outcome = 'skipped';
          } else if (Number.isInteger(res.statusCode) && res.statusCode >= 200 && res.statusCode < 300) {
            outcome = 'inserted';
          } else {
            summary.failed += 1;
            summary.errors.push({ ...context, statusCode: res.statusCode, message: res.body || `HTTP ${res.statusCode}` });
          }
          if (outcome === 'inserted') summary.inserted += 1;
          if (outcome === 'skipped') summary.skipped += 1;
          if (outcome && stateUpdate) {
            const stateRes = await patchRecordState({
              envUrl,
              tokenProvider,
              entitySetName: seedEntry.entitySetName,
              recordId,
              stateUpdate,
            }, deps);
            requireSuccess(stateRes, 'State update');
          }
          if (outcome && files) {
            await uploadRecordFiles({ seedDir, seed: seedEntry, record, files, envUrl, tokenProvider, summary, context }, deps);
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
    summary.errors.push({ scope: err.code === 'SEED_AUTH_UNAVAILABLE' ? 'auth' : 'seedDir', message: err.message });
  }
  summary.ok = summary.failed === 0 && summary.errors.length === 0;
  return summary;
}

async function uploadRecordFiles({ seedDir, seed, record, files, envUrl, tokenProvider, summary, context }, deps = {}) {
  for (const [columnName, relativePath] of Object.entries(files)) {
    try {
      const filePath = path.join(seedDir, relativePath);
      const fileError = validateAttachmentFile(filePath, { ...deps, seedDir });
      if (fileError) throw new Error(fileError);
      await uploadFileColumn({
        envUrl,
        tokenProvider,
        primaryKey: seed.primaryKey,
        recordId: record[seed.primaryKey],
        columnName,
        filePath,
        fileName: uploadFileName(record, columnName, filePath),
      }, deps);
    } catch (err) {
      summary.failed += 1;
      summary.errors.push({ ...context, columnName, attachmentPath: relativePath, message: err.message });
    }
  }
}

module.exports = {
  applySeedData,
  planSeedData,
  emptySummary,
  emptyPlan,
  listSeedFiles,
  readSeedFile,
  normalizeDataverseExportSeed,
  normalizeExportRecord,
  postRecord,
  isDuplicateConflict,
  splitReservedFiles,
  validateFilesContract,
  validateContainedPath,
  validateAttachmentFile,
  uploadFileColumn,
  uploadRecordFiles,
  postDataverseJson,
  createTokenProvider,
  validateSeedLookupContract,
  entityLogicalNameFromPrimaryKey,
  contentTypeForFile,
  postDataverseAction,
  FILE_BLOCK_SIZE_BYTES,
  ALLOWED_ATTACHMENT_EXTENSIONS,
  TOKEN_REFRESH_EVERY_REQUESTS,
};
