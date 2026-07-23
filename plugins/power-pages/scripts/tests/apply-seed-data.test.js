'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { applySeedData, listSeedFiles, readSeedFile, isDuplicateConflict, createTokenProvider } = require('../lib/apply-seed-data');
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

test('applySeedData strips __files, requires primaryKey, and uploads file-column attachments in 4 MiB blocks', async () => {
  const fileBuffer = Buffer.concat([
    Buffer.alloc(4 * 1024 * 1024, 1),
    Buffer.from('tail'),
  ]);
  const fsImpl = {
    existsSync: (p) => p === '/virtual/seed' || p === '/virtual/seed/files/invoices/inv-001.pdf',
    readdirSync: () => ['010-invoices.json'],
    readFileSync: (p) => {
      if (p.endsWith('010-invoices.json')) {
        return JSON.stringify({
          entitySetName: 'cr123_invoices',
          primaryKey: 'cr123_invoiceid',
          records: [{
            cr123_invoiceid: '11111111-1111-1111-1111-111111111111',
            cr123_name: 'INV-001',
            __files: {
              cr123_invoicepdf: 'files/invoices/inv-001.pdf',
            },
          }],
        });
      }
      return fileBuffer;
    },
    statSync: () => ({ isFile: () => true, size: fileBuffer.length }),
  };
  const requests = [];
  const result = await applySeedData({ seedDir: '/virtual/seed', envUrl: 'https://org.crm.dynamics.com' }, {
    token: 'token',
    fs: fsImpl,
    randomBlockId: (() => {
      const ids = ['block-1', 'block-2'];
      return () => ids.shift();
    })(),
    makeRequest: async (req) => {
      requests.push(req);
      if (req.url.endsWith('/cr123_invoices')) return { statusCode: 204 };
      if (req.url.endsWith('/InitializeFileBlocksUpload')) {
        return { statusCode: 200, body: JSON.stringify({ FileContinuationToken: 'continuation' }) };
      }
      if (req.url.endsWith('/UploadBlock')) return { statusCode: 204 };
      if (req.url.endsWith('/CommitFileBlocksUpload')) return { statusCode: 200 };
      throw new Error(`unexpected request: ${req.url}`);
    },
  });

  const recordBody = JSON.parse(requests[0].body);
  assert.equal(recordBody.__files, undefined);
  assert.equal(result.inserted, 1);
  assert.equal(result.failed, 0);
  assert.equal(requests.filter((req) => req.url.endsWith('/UploadBlock')).length, 2);
  assert.deepEqual(JSON.parse(requests.at(-1).body).BlockList, ['block-1', 'block-2']);
});

test('applySeedData records attachment validation failures without blocking other records', async () => {
  const fsImpl = {
    existsSync: () => true,
    readdirSync: () => ['010-invoices.json'],
    readFileSync: () => JSON.stringify({
      entitySetName: 'cr123_invoices',
      records: [{
        cr123_name: 'INV-001',
        __files: {
          cr123_invoicepdf: '../outside.pdf',
        },
      }],
    }),
  };

  const result = await applySeedData({ seedDir: '/virtual/seed', envUrl: 'https://org.crm.dynamics.com' }, {
    token: 'token',
    fs: fsImpl,
    makeRequest: async () => ({ statusCode: 204 }),
  });

  assert.equal(result.inserted, 0);
  assert.equal(result.failed, 1);
  assert.match(result.errors[0].message, /primaryKey/);
});

test('applySeedData rejects non-object __files before posting', async () => {
  const fsImpl = {
    existsSync: () => true,
    readdirSync: () => ['010-invoices.json'],
    readFileSync: () => JSON.stringify({
      entitySetName: 'cr123_invoices',
      primaryKey: 'cr123_invoiceid',
      records: [{
        cr123_invoiceid: '11111111-1111-1111-1111-111111111111',
        cr123_name: 'INV-001',
        __files: null,
      }],
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

  assert.equal(result.inserted, 0);
  assert.equal(result.failed, 1);
  assert.equal(requests.length, 0);
  assert.match(result.errors[0].message, /__files must be an object/);
});

test('applySeedData accepts attachment paths under a relative seedDir', async (t) => {
  const dir = tempDir();
  const cwd = process.cwd();
  t.after(() => {
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  process.chdir(dir);
  fs.mkdirSync(path.join('seed-data', 'files'), { recursive: true });
  fs.writeFileSync(path.join('seed-data', 'files', 'invoice.pdf'), Buffer.from('pdf'));
  fs.writeFileSync(path.join('seed-data', '010-invoices.json'), JSON.stringify({
    entitySetName: 'cr123_invoices',
    primaryKey: 'cr123_invoiceid',
    records: [{
      cr123_invoiceid: '11111111-1111-1111-1111-111111111111',
      __files: { cr123_invoicepdf: 'files/invoice.pdf' },
    }],
  }));
  const result = await applySeedData({ seedDir: 'seed-data', envUrl: 'https://org.crm.dynamics.com' }, {
    token: 'token',
    randomBlockId: () => 'block-1',
    makeRequest: async (req) => {
      if (req.url.endsWith('/cr123_invoices')) return { statusCode: 204 };
      if (req.url.endsWith('/InitializeFileBlocksUpload')) return { statusCode: 200, body: JSON.stringify({ FileContinuationToken: 'continuation' }) };
      return { statusCode: 204 };
    },
  });

  assert.equal(result.failed, 0);
});

test('applySeedData uploads file attachments when the explicit-guid record already exists', async () => {
  const fileBuffer = Buffer.from('pdf');
  const fsImpl = {
    existsSync: (p) => p === '/virtual/seed' || p === '/virtual/seed/files/invoices/inv-001.pdf',
    readdirSync: () => ['010-invoices.json'],
    readFileSync: (p) => {
      if (p.endsWith('010-invoices.json')) {
        return JSON.stringify({
          entitySetName: 'cr123_invoices',
          primaryKey: 'cr123_invoiceid',
          records: [{
            cr123_invoiceid: '11111111-1111-1111-1111-111111111111',
            cr123_name: 'INV-001',
            __files: { cr123_invoicepdf: 'files/invoices/inv-001.pdf' },
          }],
        });
      }
      return fileBuffer;
    },
    statSync: () => ({ isFile: () => true, size: fileBuffer.length }),
  };
  const requests = [];
  const result = await applySeedData({ seedDir: '/virtual/seed', envUrl: 'https://org.crm.dynamics.com' }, {
    token: 'token',
    fs: fsImpl,
    randomBlockId: () => 'block-1',
    makeRequest: async (req) => {
      requests.push(req);
      if (req.url.endsWith('/cr123_invoices')) return { statusCode: 409, body: 'Cannot insert duplicate key' };
      if (req.url.endsWith('/InitializeFileBlocksUpload')) return { statusCode: 200, body: JSON.stringify({ FileContinuationToken: 'continuation' }) };
      if (req.url.endsWith('/UploadBlock')) return { statusCode: 204 };
      if (req.url.endsWith('/CommitFileBlocksUpload')) return { statusCode: 200 };
      throw new Error(`unexpected request: ${req.url}`);
    },
  });

  assert.equal(result.skipped, 1);
  assert.equal(requests.some((req) => req.url.endsWith('/InitializeFileBlocksUpload')), true);
});

test('applySeedData rejects disallowed attachment extensions and Git LFS pointers before posting', async () => {
  const fsImpl = {
    existsSync: () => true,
    readdirSync: () => ['010-invoices.json', '020-receipts.json'],
    readFileSync: (p) => {
      if (p.endsWith('010-invoices.json')) {
        return JSON.stringify({
          entitySetName: 'cr123_invoices',
          primaryKey: 'cr123_invoiceid',
          records: [{ cr123_invoiceid: '11111111-1111-1111-1111-111111111111', __files: { cr123_invoiceexe: 'files/bad.exe' } }],
        });
      }
      if (p.endsWith('020-receipts.json')) {
        return JSON.stringify({
          entitySetName: 'cr123_receipts',
          primaryKey: 'cr123_receiptid',
          records: [{ cr123_receiptid: '22222222-2222-2222-2222-222222222222', __files: { cr123_receiptpdf: 'files/lfs.pdf' } }],
        });
      }
      return Buffer.from('version https://git-lfs.github.com/spec/v1\n');
    },
    statSync: () => ({ isFile: () => true, size: 42 }),
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

  assert.equal(result.inserted, 2);
  assert.equal(result.failed, 2);
  assert.equal(requests.length, 2);
  assert.match(result.errors[0].message, /extension/);
  assert.match(result.errors[1].message, /Git LFS pointer/);
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

test('createTokenProvider refreshes after the configured request cadence', () => {
  const tokens = ['fresh-1', 'fresh-2'];
  const provider = createTokenProvider({
    envUrl: 'https://org.crm.dynamics.com',
    initialToken: 'initial',
    refreshEvery: 2,
    resolveToken: () => tokens.shift(),
  });

  assert.equal(provider(), 'initial');
  assert.equal(provider(), 'initial');
  assert.equal(provider(), 'fresh-1');
  assert.equal(provider(), 'fresh-1');
  assert.equal(provider(), 'fresh-2');
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
