'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { applySeedData, listSeedFiles, readSeedFile, isDuplicateConflict } = require('../lib/apply-seed-data');
const { parseArgs, run } = require('../apply-seed-data');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'apply-seed-data-test-'));
}

test('listSeedFiles sorts JSON files by filename and ignores non-json files', (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, '020-posts.json'), '{}');
  fs.writeFileSync(path.join(dir, '010-categories.json'), '{}');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'ignore');

  assert.deepEqual(listSeedFiles(dir).map((file) => path.basename(file)), ['010-categories.json', '020-posts.json']);
});

test('readSeedFile validates the seed file contract', (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, '010-categories.json');
  fs.writeFileSync(file, JSON.stringify({ entitySetName: 'cr123_categories', records: [{ cr123_name: 'Announcements' }] }));
  assert.deepEqual(readSeedFile(file), { entitySetName: 'cr123_categories', records: [{ cr123_name: 'Announcements' }] });

  fs.writeFileSync(file, JSON.stringify({ entitySetName: 'cr123_categories' }));
  assert.throws(() => readSeedFile(file), /Expected/);
});

test('applySeedData posts records, skips duplicates, and records failures without throwing', async (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, '010-categories.json'), JSON.stringify({
    entitySetName: 'cr123_categories',
    records: [
      { cr123_categoryid: '11111111-1111-1111-1111-111111111111', cr123_name: 'Announcements' },
      { cr123_categoryid: '11111111-1111-1111-1111-111111111111', cr123_name: 'Duplicate' },
      { cr123_name: 'Broken' },
    ],
  }));
  const bodies = [];
  const responses = [
    { statusCode: 204 },
    { statusCode: 409, body: 'Cannot insert duplicate key' },
    { statusCode: 500, body: 'server error' },
  ];

  const result = await applySeedData({ seedDir: dir, envUrl: 'https://org.crm.dynamics.com' }, {
    token: 'token',
    makeRequest: async (req) => {
      bodies.push(JSON.parse(req.body));
      return responses.shift();
    },
  });

  assert.deepEqual(bodies.map((body) => body.cr123_name), ['Announcements', 'Duplicate', 'Broken']);
  assert.equal(result.inserted, 1);
  assert.equal(result.skipped, 1);
  assert.equal(result.failed, 1);
  assert.match(result.errors[0].message, /server error/);
});

test('applySeedData success path can run with injected fs and request function', async () => {
  const fsImpl = {
    existsSync: () => true,
    readdirSync: () => ['010-categories.json'],
    readFileSync: () => JSON.stringify({
      entitySetName: 'cr123_categories',
      records: [{ cr123_name: 'Announcements' }],
    }),
  };
  const requests = [];
  const result = await applySeedData({ seedDir: '/virtual/seed', envUrl: 'https://org.crm.dynamics.com' }, {
    token: 'token',
    fs: fsImpl,
    makeRequest: async (req) => {
      requests.push(req);
      return { statusCode: 204 };
    },
  });

  assert.equal(result.inserted, 1);
  assert.equal(requests[0].url, 'https://org.crm.dynamics.com/api/data/v9.2/cr123_categories');
  assert.deepEqual(JSON.parse(requests[0].body), { cr123_name: 'Announcements' });
});

test('applySeedData reports auth failure as best-effort summary', async () => {
  assert.deepEqual(await applySeedData({ seedDir: '/tmp/missing', envUrl: 'https://org.crm.dynamics.com' }, {
    getAuthToken: () => null,
  }), {
    ok: false,
    inserted: 0,
    failed: 1,
    skipped: 0,
    errors: [{ scope: 'auth', message: 'Azure CLI token unavailable for https://org.crm.dynamics.com' }],
  });

});

test('applySeedData catches token and filesystem failures as summaries', async () => {
  assert.deepEqual(await applySeedData({ seedDir: '/tmp/seed', envUrl: 'https://org.crm.dynamics.com' }, {
    getAuthToken: () => { throw new Error('token exploded'); },
  }), {
    ok: false,
    inserted: 0,
    failed: 1,
    skipped: 0,
    errors: [{ scope: 'seedDir', message: 'token exploded' }],
  });

  const result = await applySeedData({ seedDir: '/virtual/seed', envUrl: 'https://org.crm.dynamics.com' }, {
    token: 'token',
    fs: {
      existsSync: () => true,
      readdirSync: () => { throw new Error('fs exploded'); },
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.failed, 1);
  assert.match(result.errors[0].message, /fs exploded/);
});

test('isDuplicateConflict only treats duplicate 409s as skipped candidates', () => {
  assert.equal(isDuplicateConflict({ statusCode: 409, body: 'Cannot insert duplicate key' }), true);
  assert.equal(isDuplicateConflict({ statusCode: 409, body: 'Concurrency version mismatch' }), false);
  assert.equal(isDuplicateConflict({ statusCode: 500, body: 'Cannot insert duplicate key' }), false);
});

test('apply-seed-data CLI parser and runner return best-effort summaries', async () => {
  assert.deepEqual(parseArgs(['--seedDir', '/tmp/seed', '--envUrl', 'https://org.crm.dynamics.com']), {
    seedDir: '/tmp/seed',
    envUrl: 'https://org.crm.dynamics.com',
  });
  assert.deepEqual(await run([]), {
    ok: false,
    inserted: 0,
    failed: 1,
    skipped: 0,
    errors: [{ scope: 'args', message: 'Usage: apply-seed-data.js --seedDir <dir> --envUrl <url>' }],
  });
});
