const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const { EventEmitter } = require('node:events');

const { downloadPinned, integrityOf, matchesIntegrity, parseIntegrity } = require('../lib/pinned-download');

const BODY = Buffer.from('console.log("pinned asset");\n');
const INTEGRITY = `sha512-${crypto.createHash('sha512').update(BODY).digest('base64')}`;

// Answers https.get with the given status and body chunks, and records each request.
function fakeHttps({ statusCode = 200, chunks = [BODY] } = {}) {
  const requests = [];
  return {
    requests,
    get(url, options, onResponse) {
      requests.push({ url, options });
      const req = new EventEmitter();
      req.destroy = (error) => { if (error) process.nextTick(() => req.emit('error', error)); };
      const res = new EventEmitter();
      res.statusCode = statusCode;
      res.resume = () => {};
      process.nextTick(() => {
        onResponse(res);
        for (const chunk of chunks) res.emit('data', chunk);
        res.emit('end');
      });
      return req;
    },
  };
}

test('integrity helpers use the Subresource Integrity format', () => {
  assert.equal(integrityOf(BODY, 'sha512'), INTEGRITY);
  assert.equal(matchesIntegrity(BODY, INTEGRITY), true);
  assert.equal(matchesIntegrity(Buffer.from('tampered'), INTEGRITY), false);
  assert.deepEqual(parseIntegrity('sha256-abc='), { algorithm: 'sha256', digest: 'abc=' });
  assert.throws(() => parseIntegrity('md5-abc'), /Unsupported integrity/);
  assert.throws(() => parseIntegrity(''), /Unsupported integrity/);
});

test('downloadPinned returns the bytes when they match the pinned hash', async () => {
  const httpsImpl = fakeHttps({ chunks: [BODY.subarray(0, 5), BODY.subarray(5)] });
  const body = await downloadPinned({ url: 'https://cdn.example/a.js', integrity: INTEGRITY, maxBytes: 1024, httpsImpl });
  assert.deepEqual(body, BODY);
  assert.equal(httpsImpl.requests[0].url, 'https://cdn.example/a.js');
});

test('downloadPinned refuses bytes that do not match the pinned hash', async () => {
  const httpsImpl = fakeHttps({ chunks: [Buffer.from('console.log("swapped");')] });
  await assert.rejects(
    downloadPinned({ url: 'https://cdn.example/a.js', integrity: INTEGRITY, maxBytes: 1024, httpsImpl }),
    /does not match its pinned sha512 hash/,
  );
});

test('downloadPinned rejects redirects, errors, oversized bodies, and plain http', async () => {
  const spec = { url: 'https://cdn.example/a.js', integrity: INTEGRITY, maxBytes: 1024 };
  await assert.rejects(downloadPinned({ ...spec, httpsImpl: fakeHttps({ statusCode: 301 }) }), /failed with 301/);
  await assert.rejects(downloadPinned({ ...spec, httpsImpl: fakeHttps({ statusCode: 404 }) }), /failed with 404/);
  await assert.rejects(downloadPinned({ ...spec, maxBytes: 4, httpsImpl: fakeHttps() }), /exceeded 4 bytes/);
  const httpsImpl = fakeHttps();
  await assert.rejects(downloadPinned({ ...spec, url: 'http://cdn.example/a.js', httpsImpl }), /only https/);
  assert.equal(httpsImpl.requests.length, 0, 'nothing is requested over plain http');
});
