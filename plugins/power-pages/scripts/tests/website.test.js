const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const WEBSITE_PATH = path.resolve(__dirname, '..', 'website.js');
const API_PATH = path.resolve(__dirname, '..', 'lib', 'power-platform-api.js');

// Loads website.js with the `power-platform-api` module replaced by a stub.
// Uses require.cache injection (not Module._resolveFilename patching) so the
// override is contained, exception-safe, and uses only documented Node APIs.
function loadWebsiteWithStubs({ pages, contextError }) {
  const stub = {
    resolveContext: () =>
      contextError ? { error: contextError } : { baseUrl: 'http://stub', token: 't' },
    request: async ({ query }) => {
      const skip = query?.skip ? Number.parseInt(query.skip, 10) : 0;
      const page = pages.find((p) => p.skip === skip) || pages[pages.length - 1];
      if (page.networkError) {
        return {
          ok: false,
          statusCode: 0,
          body: null,
          headers: {},
          error: { code: 'NetworkError', message: page.networkError },
        };
      }
      return { ok: true, statusCode: 200, body: page.body, headers: {} };
    },
    parseCliArgs: () => ({}),
    fail: () => {
      throw new Error('fail() should not run during unit tests');
    },
    runCli: () => {},
  };

  delete require.cache[WEBSITE_PATH];
  require.cache[API_PATH] = {
    id: API_PATH,
    filename: API_PATH,
    loaded: true,
    exports: stub,
    children: [],
    paths: [],
  };

  try {
    return require(WEBSITE_PATH);
  } finally {
    delete require.cache[WEBSITE_PATH];
    delete require.cache[API_PATH];
  }
}

test('nextSkipFrom returns the parsed offset from an @odata.nextLink', () => {
  const { nextSkipFrom } = loadWebsiteWithStubs({ pages: [] });
  assert.equal(nextSkipFrom('https://api.example.com/websites?select=Id&skip=20'), 20);
  assert.equal(nextSkipFrom('https://api.example.com/websites?skip=100&top=10'), 100);
});

test('nextSkipFrom returns null when the link is missing or malformed', () => {
  const { nextSkipFrom } = loadWebsiteWithStubs({ pages: [] });
  assert.equal(nextSkipFrom(undefined), null);
  assert.equal(nextSkipFrom(null), null);
  assert.equal(nextSkipFrom(''), null);
  assert.equal(nextSkipFrom('https://api.example.com/websites'), null);
  assert.equal(nextSkipFrom('https://api.example.com/websites?skip=abc'), null);
  // Non-positive offsets are treated as missing so the pagination loop
  // terminates rather than re-fetching the same page.
  assert.equal(nextSkipFrom('https://api.example.com/websites?skip=0'), null);
});

test('recordIdOf reads WebsiteRecordId or its camelCase variant', () => {
  const { recordIdOf } = loadWebsiteWithStubs({ pages: [] });
  assert.equal(recordIdOf({ WebsiteRecordId: 'abc' }), 'abc');
  assert.equal(recordIdOf({ websiteRecordId: 'xyz' }), 'xyz');
  assert.equal(recordIdOf({ Id: 'p1' }), null);
  assert.equal(recordIdOf(null), null);
  assert.equal(recordIdOf('string'), null);
});

test('findWebsite returns the matching site on the first page', async () => {
  const id = 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE';
  const { findWebsite } = loadWebsiteWithStubs({
    pages: [
      {
        skip: 0,
        body: {
          value: [
            { Id: 'p1', WebsiteRecordId: '11111111-2222-3333-4444-555555555555' },
            { Id: 'p2', WebsiteRecordId: id },
          ],
        },
      },
    ],
  });

  const result = await findWebsite(id);
  assert.equal(result.Id, 'p2');
});

test('findWebsite matches case-insensitively', async () => {
  const upperId = 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE';
  const lowerId = upperId.toLowerCase();
  const { findWebsite } = loadWebsiteWithStubs({
    pages: [{ skip: 0, body: { value: [{ Id: 'p1', WebsiteRecordId: lowerId }] } }],
  });

  const result = await findWebsite(upperId);
  assert.equal(result.Id, 'p1');
});

test('findWebsite follows @odata.nextLink across pages', async () => {
  const target = 'TARGET-ID';
  const { findWebsite } = loadWebsiteWithStubs({
    pages: [
      {
        skip: 0,
        body: {
          value: [{ Id: 'p1', WebsiteRecordId: 'other-1' }],
          '@odata.nextLink': 'https://api/websites?skip=10',
        },
      },
      {
        skip: 10,
        body: {
          value: [{ Id: 'p2', WebsiteRecordId: 'other-2' }],
          '@odata.nextLink': 'https://api/websites?skip=20',
        },
      },
      {
        skip: 20,
        body: { value: [{ Id: 'p3', WebsiteRecordId: target }] },
      },
    ],
  });

  const result = await findWebsite(target);
  assert.equal(result.Id, 'p3');
});

test('findWebsite returns null when no page contains the websiteId', async () => {
  const { findWebsite } = loadWebsiteWithStubs({
    pages: [{ skip: 0, body: { value: [{ Id: 'p1', WebsiteRecordId: 'other' }] } }],
  });
  assert.equal(await findWebsite('not-present'), null);
});

test('findWebsite stops pagination when the server fails to advance skip', async () => {
  // Server returns the same nextLink twice — the loop must terminate rather
  // than spin forever.
  const { findWebsite } = loadWebsiteWithStubs({
    pages: [
      {
        skip: 0,
        body: {
          value: [{ Id: 'p1', WebsiteRecordId: 'other' }],
          '@odata.nextLink': 'https://api/websites?skip=0',
        },
      },
    ],
  });
  const result = await findWebsite('not-present');
  assert.equal(result, null);
});

test('findWebsite throws when the request fails', async () => {
  const { findWebsite } = loadWebsiteWithStubs({
    pages: [{ skip: 0, networkError: 'connection refused' }],
  });
  await assert.rejects(() => findWebsite('any-id'), /List websites failed/);
});

test('findWebsite throws when context resolution fails', async () => {
  const { findWebsite } = loadWebsiteWithStubs({
    pages: [],
    contextError: 'Power Platform CLI is not signed in',
  });
  await assert.rejects(() => findWebsite('any-id'), /CLI is not signed in/);
});

test('findWebsite rejects empty or non-string websiteId', async () => {
  const { findWebsite } = loadWebsiteWithStubs({ pages: [] });
  await assert.rejects(() => findWebsite(''), /must be a non-empty string/);
  await assert.rejects(() => findWebsite(null), /must be a non-empty string/);
  await assert.rejects(() => findWebsite(undefined), /must be a non-empty string/);
});
