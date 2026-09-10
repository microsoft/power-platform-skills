'use strict';

const crypto = require('node:crypto');
const { UUID_REGEX } = require('./validation-helpers');

function logicalName(value, label) {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_]*$/i.test(value)) {
    throw new Error(`${label} must be a metadata logical name`);
  }
  return value;
}

async function read(request, method, apiPath, body) {
  const result = await request(method, apiPath, body);
  if (result.status !== 200 || result.error || !result.data || typeof result.data !== 'object') {
    throw new Error(`Image verification ${apiPath} returned ${result.status}; expected data, not an empty success`);
  }
  return result.data;
}

async function verifyImageColumn(request, { table, column, canStoreFullImage, maxSizeInKB }) {
  logicalName(table, 'table');
  logicalName(column, 'column');
  if (typeof canStoreFullImage !== 'boolean') throw new Error('Expected full-image storage must be explicit');
  if (maxSizeInKB !== undefined && (!Number.isSafeInteger(maxSizeInKB) || maxSizeInKB <= 0)) {
    throw new Error('Expected image capacity must be a positive integer');
  }
  const metadata = await read(request, 'GET',
    `EntityDefinitions(LogicalName='${table}')/Attributes(LogicalName='${column}')/Microsoft.Dynamics.CRM.ImageAttributeMetadata?$select=LogicalName,CanStoreFullImage,MaxSizeInKB`);
  if (metadata.LogicalName !== column || metadata.CanStoreFullImage !== canStoreFullImage ||
      !Number.isSafeInteger(metadata.MaxSizeInKB) || metadata.MaxSizeInKB <= 0 ||
      (maxSizeInKB !== undefined && metadata.MaxSizeInKB < maxSizeInKB)) {
    throw new Error('Live image metadata does not match the approved storage contract; do not copy requested values into the manifest');
  }
  return {
    logicalName: metadata.LogicalName,
    canStoreFullImage: metadata.CanStoreFullImage,
    maxSizeInKB: metadata.MaxSizeInKB,
  };
}

// Authoring-only read-back via the existing request executor, never a native HTTP bypass.
// These Dataverse messages download originals, not the record's thumbnail:
// https://learn.microsoft.com/power-apps/developer/data-platform/image-column-data#download-images
async function verifyImageRoundTrip(request, {
  table, primaryIdAttribute, column, recordId, expectedBytes,
}) {
  logicalName(table, 'table');
  logicalName(primaryIdAttribute, 'primaryIdAttribute');
  logicalName(column, 'column');
  if (typeof recordId !== 'string' || !UUID_REGEX.test(recordId)) throw new Error('A valid record GUID is required');
  if (!(expectedBytes instanceof Uint8Array) || !expectedBytes.length || expectedBytes.length > 30 * 1024 * 1024) {
    throw new Error('Expected image bytes must be nonempty and no larger than the Dataverse 30 MiB limit');
  }
  const init = await read(request, 'POST', 'InitializeFileBlocksDownload', {
    Target: { '@odata.type': `Microsoft.Dynamics.CRM.${table}`, [primaryIdAttribute]: recordId },
    FileAttributeName: column,
  });
  if (init.FileSizeInBytes !== expectedBytes.length ||
      typeof init.FileContinuationToken !== 'string' || !init.FileContinuationToken) {
    throw new Error('Full image is missing or its size differs from the uploaded original');
  }
  const chunks = [];
  let offset = 0;
  while (offset < init.FileSizeInBytes) {
    const length = init.IsChunkingSupported === false
      ? init.FileSizeInBytes : Math.min(4 * 1024 * 1024, init.FileSizeInBytes - offset);
    const block = await read(request, 'POST', 'DownloadBlock', {
      FileContinuationToken: init.FileContinuationToken, Offset: offset, BlockLength: length,
    });
    if (typeof block.Data !== 'string') {
      throw new Error('Image block did not contain valid base64');
    }
    const bytes = Buffer.from(block.Data, 'base64');
    if (bytes.toString('base64') !== block.Data) throw new Error('Image block did not contain canonical base64');
    if (bytes.length !== length) throw new Error('Image block length differs from the requested range');
    chunks.push(bytes);
    offset += length;
  }
  const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
  const sha256 = digest(Buffer.concat(chunks));
  if (sha256 !== digest(expectedBytes)) throw new Error('Downloaded full image differs from the uploaded original');
  return { verified: true, byteLength: offset, sha256 };
}

module.exports = { verifyImageColumn, verifyImageRoundTrip };
