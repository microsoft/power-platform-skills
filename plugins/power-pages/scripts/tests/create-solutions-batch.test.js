const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const helpers = require('../lib/validation-helpers');
const { createSolutionsBatch } = require('../lib/create-solutions-batch');

// Routes the mock by the `uniquename` field in the POST body. Each spec gets
// its own outcome (created, 409→re-query, fatal failure) so a single batch
// can exercise all three paths at once.
function buildMockMakeRequest(behaviorByUniqueName) {
  return async function mockMakeRequest({ url, method, body }) {
    if (method === 'POST' && url.endsWith('/api/data/v9.2/solutions')) {
      const parsed = JSON.parse(body);
      const uniqueName = parsed.uniquename;
      const behavior = behaviorByUniqueName[uniqueName] || { kind: 'unknown' };
      if (behavior.kind === 'created') {
        return {
          statusCode: 204,
          body: '',
          headers: {
            'odata-entityid': `https://org.crm.dynamics.com/api/data/v9.2/solutions(${behavior.solutionId})`,
          },
        };
      }
      if (behavior.kind === '409-existing' || behavior.kind === '409-orphan') {
        return { statusCode: 409, body: '{}', headers: {} };
      }
      if (behavior.kind === '500') {
        return { statusCode: 500, body: '{"error":"boom"}', headers: {} };
      }
      return { statusCode: 500, body: '{"error":"unknown route"}', headers: {} };
    }

    // verify-solution-exists.js re-query after 409 — extract uniquename from the
    // URL-encoded $filter param. The script builds the URL via
    // URL.searchParams.set('$filter', `uniquename eq '<name>'`), which percent-
    // encodes single quotes and the $; using `new URL(...)` + `searchParams.get`
    // here normalizes the decoding so we can match against the raw name.
    if (method === undefined || method === 'GET') {
      try {
        const parsed = new URL(url);
        const filter = parsed.searchParams.get('$filter');
        const m = filter && filter.match(/uniquename eq '([^']+)'/);
        if (m) {
          const uniqueName = m[1];
          const behavior = behaviorByUniqueName[uniqueName] || { kind: 'unknown' };
          if (behavior.kind === '409-existing') {
            return {
              statusCode: 200,
              body: JSON.stringify({
                value: [{
                  solutionid: behavior.solutionId,
                  uniquename: uniqueName,
                  version: '1.0.0.0',
                  ismanaged: false,
                }],
              }),
            };
          }
          if (behavior.kind === '409-orphan') {
            return { statusCode: 200, body: JSON.stringify({ value: [] }) };
          }
        }
      } catch {
        // fall through
      }
    }
    return { statusCode: 500, body: '{"error":"unmatched request"}', headers: {} };
  };
}

function withMock(t, behaviorByUniqueName) {
  const orig = helpers.makeRequest;
  helpers.makeRequest = buildMockMakeRequest(behaviorByUniqueName);
  t.after(() => { helpers.makeRequest = orig; });
}

// --- arg validation ---------------------------------------------------------

test('createSolutionsBatch throws when --envUrl is missing', async () => {
  await assert.rejects(
    () => createSolutionsBatch({ publisherId: 'p1', specs: [] }),
    /--envUrl is required/,
  );
});

test('createSolutionsBatch throws when --publisherId is missing', async () => {
  await assert.rejects(
    () => createSolutionsBatch({ envUrl: 'https://x.crm.dynamics.com', specs: [] }),
    /--publisherId is required/,
  );
});

test('createSolutionsBatch throws when neither specs nor solutionsFile provided', async () => {
  await assert.rejects(
    () => createSolutionsBatch({ envUrl: 'https://x.crm.dynamics.com', publisherId: 'p1', token: 'tok' }),
    /--solutionsFile is required/,
  );
});

// --- happy path: all created in parallel ------------------------------------

test('createSolutionsBatch creates all entries in parallel and reports each result', async (t) => {
  withMock(t, {
    'Site_Core':      { kind: 'created', solutionId: 'aaaaaaaa-1111-1111-1111-111111111111' },
    'Site_WebAssets': { kind: 'created', solutionId: 'bbbbbbbb-2222-2222-2222-222222222222' },
    'Site_EnvVars':   { kind: 'created', solutionId: 'cccccccc-3333-3333-3333-333333333333' },
  });

  const result = await createSolutionsBatch({
    envUrl: 'https://x.crm.dynamics.com',
    publisherId: 'pub-001',
    token: 'fake-token',
    specs: [
      { uniqueName: 'Site_Core', friendlyName: 'Site — Core', version: '1.0.0.0', description: 'd1' },
      { uniqueName: 'Site_WebAssets', friendlyName: 'Site — Web Assets', version: '1.0.0.0' },
      { uniqueName: 'Site_EnvVars', friendlyName: 'Site — EnvVars', version: '1.0.0.0' },
    ],
  });

  assert.equal(result.total, 3);
  assert.equal(result.success, 3);
  assert.equal(result.skipped, 0);
  assert.equal(result.failed, 0);
  assert.equal(result.results.length, 3);
  assert.deepEqual(
    result.results.map((r) => ({ uniqueName: r.uniqueName, solutionId: r.solutionId, created: r.created })),
    [
      { uniqueName: 'Site_Core',      solutionId: 'aaaaaaaa-1111-1111-1111-111111111111', created: true },
      { uniqueName: 'Site_WebAssets', solutionId: 'bbbbbbbb-2222-2222-2222-222222222222', created: true },
      { uniqueName: 'Site_EnvVars',   solutionId: 'cccccccc-3333-3333-3333-333333333333', created: true },
    ],
  );
});

// --- future-buffer skip -----------------------------------------------------

test('createSolutionsBatch skips entries with isFutureBuffer: true without hitting Dataverse', async (t) => {
  let postCalls = 0;
  const orig = helpers.makeRequest;
  helpers.makeRequest = async ({ method, body, url }) => {
    if (method === 'POST' && url.endsWith('/api/data/v9.2/solutions')) {
      postCalls += 1;
      const parsed = JSON.parse(body);
      return {
        statusCode: 204,
        body: '',
        headers: {
          'odata-entityid': `https://x.crm.dynamics.com/api/data/v9.2/solutions(deadbeef-${postCalls.toString().padStart(4,'0')}-aaaa-bbbb-cccccccccccc)`,
        },
      };
    }
    return { statusCode: 500, body: '{}', headers: {} };
  };
  t.after(() => { helpers.makeRequest = orig; });

  const result = await createSolutionsBatch({
    envUrl: 'https://x.crm.dynamics.com',
    publisherId: 'pub-001',
    token: 'fake-token',
    specs: [
      { uniqueName: 'Site_Core', friendlyName: 'Site — Core', version: '1.0.0.0' },
      { uniqueName: 'Site_Future', isFutureBuffer: true, friendlyName: 'Site — Future', version: '1.0.0.0' },
      { uniqueName: 'Site_WebAssets', friendlyName: 'Site — Web Assets', version: '1.0.0.0' },
    ],
  });

  assert.equal(result.total, 3);
  assert.equal(result.success, 2);
  assert.equal(result.skipped, 1);
  assert.equal(result.failed, 0);
  assert.equal(postCalls, 2, 'isFutureBuffer entry must NOT POST to Dataverse');

  const skipped = result.results.find((r) => r.uniqueName === 'Site_Future');
  assert.equal(skipped.skipped, true);
  assert.equal(skipped.reason, 'futureBuffer');
});

// --- 409 idempotent path ----------------------------------------------------

test('createSolutionsBatch resolves 409 by re-query and reports created: false', async (t) => {
  withMock(t, {
    'Site_Core':     { kind: 'created', solutionId: '11111111-1111-1111-1111-111111111111' },
    'Site_Existing': { kind: '409-existing', solutionId: '22222222-2222-2222-2222-222222222222' },
  });

  const result = await createSolutionsBatch({
    envUrl: 'https://x.crm.dynamics.com',
    publisherId: 'pub-001',
    token: 'fake-token',
    specs: [
      { uniqueName: 'Site_Core', friendlyName: 'Site — Core', version: '1.0.0.0' },
      { uniqueName: 'Site_Existing', friendlyName: 'Site — Existing', version: '1.0.0.0' },
    ],
  });

  assert.equal(result.success, 2, 'both 204 and 409→existing count as success');
  assert.equal(result.failed, 0);
  const existing = result.results.find((r) => r.uniqueName === 'Site_Existing');
  assert.equal(existing.solutionId, '22222222-2222-2222-2222-222222222222');
  assert.equal(existing.created, false, 'created:false signals "already existed"');
});

// --- partial failure --------------------------------------------------------

test('createSolutionsBatch returns partial failure when some entries fail', async (t) => {
  withMock(t, {
    'Site_Core':     { kind: 'created', solutionId: '11111111-1111-1111-1111-111111111111' },
    'Site_Bad':      { kind: '409-orphan' },  // 409 with no matching record on re-query → throws
    'Site_FiveHun':  { kind: '500' },         // 500 → throws unexpected response
  });

  const result = await createSolutionsBatch({
    envUrl: 'https://x.crm.dynamics.com',
    publisherId: 'pub-001',
    token: 'fake-token',
    specs: [
      { uniqueName: 'Site_Core', friendlyName: 'Site — Core', version: '1.0.0.0' },
      { uniqueName: 'Site_Bad', friendlyName: 'Site — Bad', version: '1.0.0.0' },
      { uniqueName: 'Site_FiveHun', friendlyName: 'Site — 500', version: '1.0.0.0' },
    ],
  });

  assert.equal(result.total, 3);
  assert.equal(result.success, 1);
  assert.equal(result.failed, 2);
  assert.equal(result.skipped, 0);

  const bad = result.results.find((r) => r.uniqueName === 'Site_Bad');
  assert.ok(bad && bad.error, 'failed entries surface error message');
  assert.match(bad.error, /409.*not found/i);

  const fivehun = result.results.find((r) => r.uniqueName === 'Site_FiveHun');
  assert.ok(fivehun && fivehun.error);
  assert.match(fivehun.error, /Unexpected response/);

  const ok = result.results.find((r) => r.uniqueName === 'Site_Core');
  assert.equal(ok.created, true, 'successful entries still complete despite siblings failing');
});

// --- spec validation --------------------------------------------------------

test('createSolutionsBatch flags spec entries missing required fields', async (t) => {
  withMock(t, {
    'Site_Good': { kind: 'created', solutionId: '11111111-1111-1111-1111-111111111111' },
  });

  const result = await createSolutionsBatch({
    envUrl: 'https://x.crm.dynamics.com',
    publisherId: 'pub-001',
    token: 'fake-token',
    specs: [
      { uniqueName: 'Site_Good', friendlyName: 'Site — Good', version: '1.0.0.0' },
      { uniqueName: 'Site_NoVersion', friendlyName: 'Site — No Version' },  // missing version
      { uniqueName: 'Site_NoFriendly', version: '1.0.0.0' },                // missing friendlyName
    ],
  });

  assert.equal(result.success, 1);
  assert.equal(result.failed, 2);
  for (const r of result.results) {
    if (r.uniqueName === 'Site_Good') continue;
    assert.match(r.error, /missing required fields/);
  }
});

// --- solutionsFile path -----------------------------------------------------

test('createSolutionsBatch reads specs from --solutionsFile when no inline specs provided', async (t) => {
  withMock(t, {
    'Site_FromFile': { kind: 'created', solutionId: '99999999-9999-9999-9999-999999999999' },
  });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csb-'));
  const file = path.join(dir, 'specs.json');
  fs.writeFileSync(file, JSON.stringify([
    { uniqueName: 'Site_FromFile', friendlyName: 'Site — From File', version: '1.0.0.0' },
  ]));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

  const result = await createSolutionsBatch({
    envUrl: 'https://x.crm.dynamics.com',
    publisherId: 'pub-001',
    token: 'fake-token',
    solutionsFile: file,
  });

  assert.equal(result.success, 1);
  assert.equal(result.results[0].solutionId, '99999999-9999-9999-9999-999999999999');
});

// --- 401-retry path ---------------------------------------------------------

test('createSolutionsBatch refreshes token once on 401 and retries the failing entry', async (t) => {
  // First POST per uniqueName returns 401. After refresh, the second POST
  // returns 204 + a synthetic entityId. Asserts: tokenRefreshed: true,
  // exactly ONE refresh across the batch (even with multiple 401s racing),
  // both entries marked success after retry.
  let refreshes = 0;
  const failedOnce = new Set();
  const orig = helpers.makeRequest;
  helpers.makeRequest = async ({ method, url, headers, body }) => {
    if (method === 'POST' && url.endsWith('/api/data/v9.2/solutions')) {
      const parsed = JSON.parse(body);
      const auth = headers.Authorization || '';
      // First call with the stale token → 401. After refresh, headers carry
      // the fresh token (we encode that in the bearer below).
      if (auth === 'Bearer stale' && !failedOnce.has(parsed.uniquename)) {
        failedOnce.add(parsed.uniquename);
        return { statusCode: 401, body: 'Unauthorized', headers: {} };
      }
      return {
        statusCode: 204,
        body: '',
        headers: {
          'odata-entityid': `https://x.crm.dynamics.com/api/data/v9.2/solutions(11111111-${parsed.uniquename.length.toString().padStart(4,'0')}-aaaa-bbbb-cccccccccccc)`,
        },
      };
    }
    return { statusCode: 500, body: '{}', headers: {} };
  };
  t.after(() => { helpers.makeRequest = orig; });

  const result = await createSolutionsBatch({
    envUrl: 'https://x.crm.dynamics.com',
    publisherId: 'pub-001',
    token: 'stale',
    refreshToken: () => { refreshes += 1; return 'fresh'; },
    specs: [
      { uniqueName: 'Site_Core', friendlyName: 'Site — Core', version: '1.0.0.0' },
      { uniqueName: 'Site_WebAssets', friendlyName: 'Site — Web Assets', version: '1.0.0.0' },
    ],
  });

  assert.equal(result.success, 2, 'both entries succeed after the retry');
  assert.equal(result.failed, 0);
  assert.equal(result.tokenRefreshed, true, 'tokenRefreshed flag must be set');
  assert.equal(refreshes, 1, 'token must be refreshed exactly ONCE for the whole batch, not per-entry');
});

test('createSolutionsBatch surfaces failure when the post-refresh retry also fails', async (t) => {
  const orig = helpers.makeRequest;
  helpers.makeRequest = async ({ method, url }) => {
    if (method === 'POST' && url.endsWith('/api/data/v9.2/solutions')) {
      return { statusCode: 401, body: 'Unauthorized', headers: {} };
    }
    return { statusCode: 500, body: '{}', headers: {} };
  };
  t.after(() => { helpers.makeRequest = orig; });

  const result = await createSolutionsBatch({
    envUrl: 'https://x.crm.dynamics.com',
    publisherId: 'pub-001',
    token: 'stale',
    refreshToken: () => 'still-stale',
    specs: [
      { uniqueName: 'Site_Bad', friendlyName: 'Site — Bad', version: '1.0.0.0' },
    ],
  });

  assert.equal(result.success, 0);
  assert.equal(result.failed, 1);
  assert.match(result.results[0].error, /Retry after token refresh failed/);
});

// --- parallelism check ------------------------------------------------------

test('createSolutionsBatch issues create calls concurrently (not serially)', async (t) => {
  const inFlight = new Set();
  let maxConcurrent = 0;
  const orig = helpers.makeRequest;
  helpers.makeRequest = async ({ method, body, url }) => {
    if (method === 'POST' && url.endsWith('/api/data/v9.2/solutions')) {
      const parsed = JSON.parse(body);
      const key = parsed.uniquename;
      inFlight.add(key);
      maxConcurrent = Math.max(maxConcurrent, inFlight.size);
      // Yield to the event loop so siblings can start before this one finishes.
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      inFlight.delete(key);
      return {
        statusCode: 204,
        body: '',
        headers: {
          'odata-entityid': `https://x.crm.dynamics.com/api/data/v9.2/solutions(11111111-aaaa-bbbb-cccc-${key.length.toString().padStart(12, '0')})`,
        },
      };
    }
    return { statusCode: 500, body: '{}', headers: {} };
  };
  t.after(() => { helpers.makeRequest = orig; });

  const N = 5;
  const specs = [];
  for (let i = 0; i < N; i++) {
    specs.push({ uniqueName: `Site_${i}`, friendlyName: `Site ${i}`, version: '1.0.0.0' });
  }

  await createSolutionsBatch({
    envUrl: 'https://x.crm.dynamics.com',
    publisherId: 'pub-001',
    token: 'fake-token',
    specs,
  });

  assert.ok(
    maxConcurrent >= 2,
    `expected concurrent POSTs (>= 2 in flight), observed max=${maxConcurrent} — batch is running serially`,
  );
});
