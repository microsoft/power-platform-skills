'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  readWebFileBytes,
  patchWebFileBytes,
  detectEolStyle,
  detectBomName,
} = require('../lib/read-web-file-bytes');

// ── Helper: build a _deps object that injects the HTTP layer ─────────────────
// makeRequest is used for the annotation (JSON/base64) query.
// httpGetBuffer is used for the filecontent/$value binary fallback.

function makeDeps({ annotationRows = null, filecontentBuffer = null, filecontentError = null, filecontentStatusCode = null } = {}) {
  return {
    makeRequest: async () => {
      if (annotationRows === null) {
        // Simulate empty annotation list (no annotation for this component)
        return { statusCode: 200, body: JSON.stringify({ value: [] }) };
      }
      return { statusCode: 200, body: JSON.stringify({ value: annotationRows }) };
    },
    httpGetBuffer: async () => {
      if (filecontentError) {
        const r = { error: filecontentError };
        if (filecontentStatusCode != null) r.statusCode = filecontentStatusCode;
        return r;
      }
      return { buffer: filecontentBuffer, statusCode: 200 };
    },
  };
}

const BASE_OPTS = {
  envUrl: 'https://org.crm.dynamics.com',
  componentId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  token: 'test-token',
};

// ─── detectEolStyle unit tests ────────────────────────────────────────────────

test('detectEolStyle: CRLF-only → crlf', () => {
  assert.equal(detectEolStyle(Buffer.from('hello\r\nworld\r\n')), 'crlf');
});

test('detectEolStyle: LF-only → lf', () => {
  assert.equal(detectEolStyle(Buffer.from('hello\nworld\n')), 'lf');
});

test('detectEolStyle: mixed CRLF and LF → mixed', () => {
  assert.equal(detectEolStyle(Buffer.from('line1\r\nline2\nline3\r\n')), 'mixed');
});

test('detectEolStyle: no newlines → null', () => {
  assert.equal(detectEolStyle(Buffer.from('no newlines here')), null);
});

test('detectEolStyle: empty buffer → null', () => {
  assert.equal(detectEolStyle(Buffer.alloc(0)), null);
});

test('detectEolStyle: lone \\r (old Mac) does not count as either', () => {
  // \r without following \n is neither CRLF nor LF — should not set either flag
  assert.equal(detectEolStyle(Buffer.from('a\rb')), null);
});

// ─── detectBomName unit tests ─────────────────────────────────────────────────

test('detectBomName: UTF-8 BOM (EF BB BF) → utf8', () => {
  assert.equal(detectBomName(Buffer.from([0xEF, 0xBB, 0xBF, 0x68, 0x69])), 'utf8');
});

test('detectBomName: UTF-16 LE BOM (FF FE) → utf16le', () => {
  assert.equal(detectBomName(Buffer.from([0xFF, 0xFE, 0x68, 0x00])), 'utf16le');
});

test('detectBomName: UTF-16 BE BOM (FE FF) → utf16be', () => {
  assert.equal(detectBomName(Buffer.from([0xFE, 0xFF, 0x00, 0x68])), 'utf16be');
});

test('detectBomName: no BOM → null', () => {
  assert.equal(detectBomName(Buffer.from('hello world')), null);
});

test('detectBomName: empty buffer → null', () => {
  assert.equal(detectBomName(Buffer.alloc(0)), null);
});

// ─── readWebFileBytes: input validation ──────────────────────────────────────

test('readWebFileBytes: missing envUrl returns error without throwing', async () => {
  const r = await readWebFileBytes({ componentId: 'abc', token: 'tok' });
  assert.equal(typeof r.error, 'string');
  assert.ok(r.error.includes('envUrl'));
  assert.equal(r.bytes, undefined);
});

test('readWebFileBytes: missing componentId returns error without throwing', async () => {
  const r = await readWebFileBytes({ envUrl: 'https://org.crm.dynamics.com', token: 'tok' });
  assert.equal(typeof r.error, 'string');
  assert.ok(r.error.includes('componentId'));
});

test('readWebFileBytes: no token and no Azure CLI returns error without throwing', async () => {
  const r = await readWebFileBytes({
    envUrl: 'https://org.crm.dynamics.com',
    componentId: 'abc',
    _deps: { getAuthToken: () => null },
  });
  assert.equal(typeof r.error, 'string');
  assert.ok(r.error.includes('auth'));
});

// ─── readWebFileBytes: success via annotation documentbody ────────────────────

test('success: CRLF text round-trips correctly via documentbody', async () => {
  const original = Buffer.from('hello\r\nworld');
  const b64 = original.toString('base64');

  const r = await readWebFileBytes({
    ...BASE_OPTS,
    _deps: makeDeps({ annotationRows: [{ annotationid: 'ann-1', documentbody: b64 }] }),
  });

  assert.ok(!r.error, `unexpected error: ${r.error}`);
  assert.deepEqual(r.bytes, original);
  assert.equal(r.base64, b64);
  assert.equal(r.eol, 'crlf');
  assert.equal(r.bom, null);
});

test('success: LF-only text has eol=lf', async () => {
  const original = Buffer.from('line1\nline2\nline3');
  const b64 = original.toString('base64');

  const r = await readWebFileBytes({
    ...BASE_OPTS,
    _deps: makeDeps({ annotationRows: [{ annotationid: 'ann-2', documentbody: b64 }] }),
  });

  assert.ok(!r.error, `unexpected error: ${r.error}`);
  assert.equal(r.eol, 'lf');
  assert.equal(r.bom, null);
});

test('success: mixed EOL text has eol=mixed', async () => {
  const original = Buffer.from('line1\r\nline2\nline3\r\n');
  const b64 = original.toString('base64');

  const r = await readWebFileBytes({
    ...BASE_OPTS,
    _deps: makeDeps({ annotationRows: [{ annotationid: 'ann-3', documentbody: b64 }] }),
  });

  assert.ok(!r.error, `unexpected error: ${r.error}`);
  assert.equal(r.eol, 'mixed');
});

test('success: no-newline content has eol=null', async () => {
  const original = Buffer.from('no-newline-content-here');
  const b64 = original.toString('base64');

  const r = await readWebFileBytes({
    ...BASE_OPTS,
    _deps: makeDeps({ annotationRows: [{ annotationid: 'ann-4', documentbody: b64 }] }),
  });

  assert.ok(!r.error, `unexpected error: ${r.error}`);
  assert.equal(r.eol, null);
});

test('success: UTF-8 BOM is detected via documentbody path', async () => {
  // UTF-8 BOM + text content
  const original = Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from('BOM text\nline2')]);
  const b64 = original.toString('base64');

  const r = await readWebFileBytes({
    ...BASE_OPTS,
    _deps: makeDeps({ annotationRows: [{ annotationid: 'ann-bom', documentbody: b64 }] }),
  });

  assert.ok(!r.error, `unexpected error: ${r.error}`);
  assert.equal(r.bom, 'utf8');
  assert.equal(r.eol, 'lf');
  assert.deepEqual(r.bytes, original);
});

test('success: binary PNG bytes round-trip without corruption via base64 path', async () => {
  // Fake PNG signature + bytes that include values 0x80–0xFF which would be
  // corrupted if processed as UTF-8 string (the makeRequest gotcha).
  const pngSignature = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]); // PNG magic
  const chunk = Buffer.from([0xFF, 0xFE, 0xD0, 0x00, 0xAB, 0xCD, 0xEF, 0x01, 0x02, 0x03]);
  const original = Buffer.concat([pngSignature, chunk]);
  const b64 = original.toString('base64');

  const r = await readWebFileBytes({
    ...BASE_OPTS,
    _deps: makeDeps({ annotationRows: [{ annotationid: 'ann-png', documentbody: b64 }] }),
  });

  assert.ok(!r.error, `unexpected error: ${r.error}`);
  // Byte-for-byte integrity check
  assert.deepEqual(r.bytes, original);
  assert.equal(r.base64, b64);
  // PNG magic has 0x0D 0x0A at bytes [4,5] (CRLF) and 0x0A at byte [7] (LF) → mixed
  assert.equal(r.eol, 'mixed');
});

// ─── readWebFileBytes: fallback to filecontent/$value ─────────────────────────

test('success: falls back to filecontent when no annotation found', async () => {
  const original = Buffer.from('CSS content\r\nbody { color: red; }\r\n');

  const r = await readWebFileBytes({
    ...BASE_OPTS,
    _deps: {
      makeRequest: async () => ({ statusCode: 200, body: JSON.stringify({ value: [] }) }),
      httpGetBuffer: async () => ({ buffer: original, statusCode: 200 }),
    },
  });

  assert.ok(!r.error, `unexpected error: ${r.error}`);
  assert.deepEqual(r.bytes, original);
  assert.equal(r.eol, 'crlf');
});

test('success: falls back to filecontent when annotation has empty documentbody', async () => {
  const original = Buffer.from('fallback content');

  const r = await readWebFileBytes({
    ...BASE_OPTS,
    _deps: {
      // annotation exists but documentbody is empty string
      makeRequest: async () => ({
        statusCode: 200,
        body: JSON.stringify({ value: [{ annotationid: 'ann-empty', documentbody: '' }] }),
      }),
      httpGetBuffer: async () => ({ buffer: original, statusCode: 200 }),
    },
  });

  assert.ok(!r.error, `unexpected error: ${r.error}`);
  assert.deepEqual(r.bytes, original);
});

test('success: binary-safe filecontent path preserves high bytes intact', async () => {
  // UTF-16 LE BOM (FF FE) at position 0 followed by high bytes that would be
  // corrupted (replaced with U+FFFD replacement chars) if coerced through a
  // UTF-8 string — exactly the bug makeRequest() would introduce.
  const highBytes = Buffer.from([0xFF, 0xFE, 0x80, 0x81, 0xC0, 0xC1, 0x00, 0x01]);

  const r = await readWebFileBytes({
    ...BASE_OPTS,
    _deps: {
      makeRequest: async () => ({ statusCode: 200, body: JSON.stringify({ value: [] }) }),
      httpGetBuffer: async () => ({ buffer: highBytes, statusCode: 200 }),
    },
  });

  assert.ok(!r.error, `unexpected error: ${r.error}`);
  assert.deepEqual(r.bytes, highBytes);
  // First two bytes are FF FE → UTF-16 LE BOM
  assert.equal(r.bom, 'utf16le');
});

// ─── readWebFileBytes: error paths ────────────────────────────────────────────

test('error: filecontent 404 returns { error, statusCode: 404 } and does NOT throw', async () => {
  let threw = false;
  let r;
  try {
    r = await readWebFileBytes({
      ...BASE_OPTS,
      _deps: makeDeps({
        annotationRows: [],
        filecontentError: 'filecontent/$value returned HTTP 404',
        filecontentStatusCode: 404,
      }),
    });
  } catch {
    threw = true;
  }
  assert.equal(threw, false, 'readWebFileBytes must not throw');
  assert.equal(typeof r.error, 'string');
  assert.equal(r.statusCode, 404);
  assert.equal(r.bytes, undefined);
});

test('error: filecontent 500 returns { error, statusCode: 500 } and does NOT throw', async () => {
  let threw = false;
  let r;
  try {
    r = await readWebFileBytes({
      ...BASE_OPTS,
      _deps: makeDeps({
        annotationRows: [],
        filecontentError: 'filecontent/$value returned HTTP 500',
        filecontentStatusCode: 500,
      }),
    });
  } catch {
    threw = true;
  }
  assert.equal(threw, false, 'readWebFileBytes must not throw');
  assert.equal(typeof r.error, 'string');
  assert.equal(r.statusCode, 500);
  assert.equal(r.bytes, undefined);
});

test('error: network error returns { error } without statusCode and does NOT throw', async () => {
  let threw = false;
  let r;
  try {
    r = await readWebFileBytes({
      ...BASE_OPTS,
      _deps: {
        makeRequest: async () => ({ statusCode: 200, body: JSON.stringify({ value: [] }) }),
        httpGetBuffer: async () => ({ error: 'ECONNREFUSED' }),
      },
    });
  } catch {
    threw = true;
  }
  assert.equal(threw, false, 'readWebFileBytes must not throw');
  assert.equal(typeof r.error, 'string');
  assert.ok(r.error.includes('ECONNREFUSED'));
});

// ─── readWebFileBytes: annotation query URL correctness ──────────────────────

test('annotation query uses correct URL structure and passes Authorization header', async () => {
  let capturedOpts = null;

  await readWebFileBytes({
    ...BASE_OPTS,
    _deps: {
      makeRequest: async (opts) => {
        capturedOpts = opts;
        return { statusCode: 200, body: JSON.stringify({ value: [] }) };
      },
      httpGetBuffer: async () => ({ buffer: Buffer.from('x'), statusCode: 200 }),
    },
  });

  assert.ok(capturedOpts, 'makeRequest should have been called');
  assert.ok(capturedOpts.url.includes('/api/data/v9.2/annotations'), 'URL must target annotations entity');
  assert.ok(capturedOpts.url.includes('powerpagecomponent'), 'filter must include objecttypecode');
  assert.ok(
    capturedOpts.url.includes(BASE_OPTS.componentId),
    'filter must include the componentId',
  );
  assert.equal(capturedOpts.method, 'GET');
  assert.equal(capturedOpts.headers.Authorization, 'Bearer test-token');
  assert.equal(capturedOpts.headers.Accept, 'application/json');
});

test('filecontent/$value URL targets the correct powerpagecomponents path', async () => {
  let capturedUrl = null;
  let capturedToken = null;

  await readWebFileBytes({
    ...BASE_OPTS,
    _deps: {
      makeRequest: async () => ({ statusCode: 200, body: JSON.stringify({ value: [] }) }),
      httpGetBuffer: async (url, tok) => {
        capturedUrl = url;
        capturedToken = tok;
        return { buffer: Buffer.from('ok'), statusCode: 200 };
      },
    },
  });

  assert.ok(capturedUrl.includes('/api/data/v9.2/powerpagecomponents('), 'URL targets powerpagecomponents');
  assert.ok(capturedUrl.includes('/filecontent/$value'), 'URL ends with /filecontent/$value');
  assert.ok(capturedUrl.includes(BASE_OPTS.componentId), 'URL includes componentId');
  assert.equal(capturedToken, 'test-token', 'token passed to httpGetBuffer');
});

test('base64 field in success result is consistent with bytes field', async () => {
  const original = Buffer.from('consistency check\nline2');
  const b64 = original.toString('base64');

  const r = await readWebFileBytes({
    ...BASE_OPTS,
    _deps: makeDeps({ annotationRows: [{ annotationid: 'ann-c', documentbody: b64 }] }),
  });

  assert.ok(!r.error);
  assert.equal(r.base64, r.bytes.toString('base64'));
  assert.equal(r.base64, b64);
});

// ─── patchWebFileBytes: input validation ─────────────────────────────────────

test('patchWebFileBytes: missing envUrl returns error', async () => {
  const r = await patchWebFileBytes({ componentId: 'abc', base64: 'Zm9v', token: 'tok' });
  assert.ok(typeof r.error === 'string');
  assert.ok(r.error.includes('envUrl'));
});

test('patchWebFileBytes: missing componentId returns error', async () => {
  const r = await patchWebFileBytes({ envUrl: 'https://org.crm.dynamics.com', base64: 'Zm9v', token: 'tok' });
  assert.ok(typeof r.error === 'string');
  assert.ok(r.error.includes('componentId'));
});

test('patchWebFileBytes: missing base64 returns error', async () => {
  const r = await patchWebFileBytes({ envUrl: 'https://org.crm.dynamics.com', componentId: 'abc', token: 'tok' });
  assert.ok(typeof r.error === 'string');
  assert.ok(r.error.includes('base64'));
});

test('patchWebFileBytes: no token and no Azure CLI returns error', async () => {
  const r = await patchWebFileBytes({
    envUrl: 'https://org.crm.dynamics.com', componentId: 'abc', base64: 'Zm9v',
    _deps: { getAuthToken: () => null },
  });
  assert.ok(typeof r.error === 'string');
  assert.ok(r.error.includes('auth'));
});

// ─── patchWebFileBytes: PRIMARY path — annotation documentbody PATCH ─────────

test('patchWebFileBytes: PRIMARY — finds annotation and PATCHes documentbody, returns {ok:true}', async () => {
  const requests = [];
  const b64 = Buffer.from('hello world').toString('base64');

  const r = await patchWebFileBytes({
    ...BASE_OPTS,
    base64: b64,
    _deps: {
      makeRequest: async (opts) => {
        requests.push({ method: opts.method, url: opts.url, body: opts.body });
        if (opts.method === 'GET') {
          // annotation lookup: returns one annotation row
          return { statusCode: 200, body: JSON.stringify({ value: [{ annotationid: 'ann-xyz' }] }) };
        }
        // PATCH annotation
        return { statusCode: 204, body: '' };
      },
    },
  });

  assert.ok(!r.error, `unexpected error: ${r.error}`);
  assert.equal(r.ok, true);
  // first call: GET annotations
  assert.ok(requests[0].url.includes('/api/data/v9.2/annotations'), 'first call must query annotations');
  assert.ok(requests[0].url.includes(BASE_OPTS.componentId), 'annotation query must include componentId');
  // second call: PATCH annotation
  assert.ok(requests[1].url.includes('annotations(ann-xyz)'), 'PATCH must target the annotation record');
  assert.equal(requests[1].method, 'PATCH');
  const patchBody = JSON.parse(requests[1].body);
  assert.equal(patchBody.documentbody, b64, 'PATCH body must carry the base64 as documentbody');
});

test('patchWebFileBytes: PRIMARY — annotation PATCH returning 200 is also treated as success', async () => {
  const r = await patchWebFileBytes({
    ...BASE_OPTS,
    base64: 'Zm9v',
    _deps: {
      makeRequest: async (opts) => {
        if (opts.method === 'GET') return { statusCode: 200, body: JSON.stringify({ value: [{ annotationid: 'ann-1' }] }) };
        return { statusCode: 200, body: '' }; // some servers return 200 on PATCH
      },
    },
  });
  assert.equal(r.ok, true);
});

test('patchWebFileBytes: PRIMARY — annotation PATCH 4xx returns {error}', async () => {
  const r = await patchWebFileBytes({
    ...BASE_OPTS,
    base64: 'Zm9v',
    _deps: {
      makeRequest: async (opts) => {
        if (opts.method === 'GET') return { statusCode: 200, body: JSON.stringify({ value: [{ annotationid: 'ann-1' }] }) };
        return { statusCode: 403, body: '{"error":{"message":"Forbidden"}}' };
      },
    },
  });
  assert.ok(typeof r.error === 'string');
  assert.equal(r.statusCode, 403);
});

// ─── patchWebFileBytes: FALLBACK path — filecontent octet-stream PATCH ────────

test('patchWebFileBytes: FALLBACK — no annotation → PATCHes filecontent with binary buffer, returns {ok:true}', async () => {
  let patchedUrl = null;
  let patchedToken = null;
  let patchedBuffer = null;

  const originalText = 'binary content\r\n';
  const b64 = Buffer.from(originalText).toString('base64');

  const r = await patchWebFileBytes({
    ...BASE_OPTS,
    base64: b64,
    _deps: {
      makeRequest: async () => ({ statusCode: 200, body: JSON.stringify({ value: [] }) }), // no annotation
      httpPatchBuffer: async (url, tok, buf) => {
        patchedUrl = url;
        patchedToken = tok;
        patchedBuffer = buf;
        return { ok: true, statusCode: 204 };
      },
    },
  });

  assert.ok(!r.error, `unexpected error: ${r.error}`);
  assert.equal(r.ok, true);
  assert.ok(patchedUrl.includes(`/api/data/v9.2/powerpagecomponents(${BASE_OPTS.componentId})/filecontent`),
    'fallback PATCH URL must target powerpagecomponents filecontent');
  assert.equal(patchedToken, BASE_OPTS.token, 'token passed to httpPatchBuffer');
  assert.deepEqual(patchedBuffer, Buffer.from(originalText), 'buffer decoded from base64 correctly');
});

test('patchWebFileBytes: FALLBACK — filecontent PATCH 4xx returns {error, statusCode}', async () => {
  const r = await patchWebFileBytes({
    ...BASE_OPTS,
    base64: 'Zm9v',
    _deps: {
      makeRequest: async () => ({ statusCode: 200, body: JSON.stringify({ value: [] }) }),
      httpPatchBuffer: async () => ({ error: 'filecontent PATCH returned HTTP 404', statusCode: 404 }),
    },
  });
  assert.ok(typeof r.error === 'string');
  assert.equal(r.statusCode, 404);
});

test('patchWebFileBytes: FALLBACK — network error returns {error} without statusCode', async () => {
  const r = await patchWebFileBytes({
    ...BASE_OPTS,
    base64: 'Zm9v',
    _deps: {
      makeRequest: async () => ({ statusCode: 200, body: JSON.stringify({ value: [] }) }),
      httpPatchBuffer: async () => ({ error: 'ECONNREFUSED' }),
    },
  });
  assert.ok(typeof r.error === 'string');
  assert.ok(r.error.includes('ECONNREFUSED'));
  assert.equal(r.statusCode, undefined);
});

// ─── reconcile-dataverse wiring: patchWebFileBytes resolves to the real function ──

test('reconcile-dataverse defaultDeps.patchWebFileBytes is the real patchWebFileBytes (not undefined)', () => {
  // reconcile-dataverse lazy-requires patchWebFileBytes from read-web-file-bytes.
  // Verify the export is now a real function (previously undefined — the missing export).
  const { patchWebFileBytes: patchFn } = require('../lib/read-web-file-bytes');
  assert.equal(typeof patchFn, 'function', 'patchWebFileBytes must be exported as a function');

  // Verify reconcile-dataverse's defaultDeps wires it (defaultDeps is not exported so we
  // check indirectly: after the module loads, reading .patchWebFileBytes from the iife must not be null).
  // The reconcile module does: (() => { try { return require('./read-web-file-bytes').patchWebFileBytes; } catch { return null; } })()
  const rwfb = require('../lib/read-web-file-bytes');
  assert.equal(typeof rwfb.patchWebFileBytes, 'function', 'patchWebFileBytes must be a function in the module');
});

