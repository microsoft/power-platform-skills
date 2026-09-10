'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { verifyImageColumn, verifyImageRoundTrip } = require('../lib/image-verification');

const options = { table: 'sample_asset', column: 'sample_photo', canStoreFullImage: true, maxSizeInKB: 10240 };
const metadata = { LogicalName: 'sample_photo', CanStoreFullImage: true, MaxSizeInKB: 10240 };
const imageOptions = { table: 'sample_asset', primaryIdAttribute: 'sample_assetid', column: 'sample_photo', recordId: '00000000-0000-f111-0000-000000000001' };

test('image metadata verification reads actual published attributes, not intended manifest values', async () => {
  const calls = [];
  const result = await verifyImageColumn(async (...args) => {
    calls.push(args);
    return { status: 200, data: metadata };
  }, options);
  assert.equal(calls[0][0], 'GET');
  assert.match(calls[0][1], /ImageAttributeMetadata\?\$select=.*CanStoreFullImage/);
  assert.deepEqual(result, { logicalName: 'sample_photo', canStoreFullImage: true, maxSizeInKB: 10240 });
  for (const delta of [{ CanStoreFullImage: false }, { MaxSizeInKB: 1024 }, { LogicalName: 'other_image' }]) {
    await assert.rejects(verifyImageColumn(async () => ({ status: 200, data: { ...metadata, ...delta } }), options), /Live image metadata/);
  }
});

test('empty, failed and malformed metadata reads cannot certify storage', async () => {
  for (const response of [{ status: 204 }, { status: 403 }, { status: 200, data: {} }]) {
    await assert.rejects(verifyImageColumn(async () => response, options));
  }
  let calls = 0;
  await assert.rejects(verifyImageColumn(async () => { calls++; }, { ...options, table: "sample_asset')/bad" }));
  assert.equal(calls, 0);
});

function downloader(expectedBytes, { chunking = true, altered = false } = {}) {
  const calls = [];
  return {
    calls,
    async request(method, api, body) {
      calls.push({ method, api, body });
      if (api === 'InitializeFileBlocksDownload') {
        return { status: 200, data: { FileSizeInBytes: expectedBytes.length, FileContinuationToken: 'opaque-test-token', IsChunkingSupported: chunking } };
      }
      assert.equal(api, 'DownloadBlock');
      const bytes = Buffer.from(expectedBytes.subarray(body.Offset, body.Offset + body.BlockLength));
      if (altered) bytes[0] ^= 1;
      return { status: 200, data: { Data: bytes.toString('base64') } };
    },
  };
}

test('full image read-back verifies exact original bytes for catalog, evidence and cover images', async () => {
  for (const column of ['sample_catalogimage', 'sample_evidence', 'sample_cover']) {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
    const transport = downloader(bytes);
    const result = await verifyImageRoundTrip(transport.request, { ...imageOptions, column, expectedBytes: bytes });
    assert.equal(result.verified, true);
    assert.equal(result.byteLength, bytes.length);
    assert.match(result.sha256, /^[a-f0-9]{64}$/);
    assert.equal(transport.calls[0].body.Target.sample_assetid, imageOptions.recordId);
    assert.equal(transport.calls[0].body.FileAttributeName, column);
    assert.ok(transport.calls.every(call => call.method === 'POST' && ['InitializeFileBlocksDownload', 'DownloadBlock'].includes(call.api)));
  }
});

test('chunked and single-block originals preserve exact content and bounded requests', async () => {
  const bytes = new Uint8Array(4 * 1024 * 1024 + 7).fill(123);
  for (const chunking of [true, false]) {
    const transport = downloader(bytes, { chunking });
    await verifyImageRoundTrip(transport.request, { ...imageOptions, expectedBytes: bytes });
    assert.equal(transport.calls.length, chunking ? 3 : 2);
    assert.equal(transport.calls[1].body.Offset, 0);
    if (chunking) assert.equal(transport.calls[2].body.BlockLength, 7);
  }
});

test('empty success, truncated blocks, corrupt bytes and missing originals remain failures', async () => {
  const bytes = new Uint8Array([1, 2, 3, 4]);
  for (const response of [{ status: 204 }, { status: 200, data: { FileSizeInBytes: 0 } }]) {
    await assert.rejects(verifyImageRoundTrip(async () => response, { ...imageOptions, expectedBytes: bytes }));
  }
  const altered = downloader(bytes, { altered: true });
  await assert.rejects(verifyImageRoundTrip(altered.request, { ...imageOptions, expectedBytes: bytes }), /differs/);
  for (const data of ['###', Buffer.from([1]).toString('base64')]) {
    const normal = downloader(bytes);
    await assert.rejects(verifyImageRoundTrip((method, api, body) => api === 'DownloadBlock'
      ? { status: 200, data: { Data: data } } : normal.request(method, api, body),
    { ...imageOptions, expectedBytes: bytes }));
  }
});
