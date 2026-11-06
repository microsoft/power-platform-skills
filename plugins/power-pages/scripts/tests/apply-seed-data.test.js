'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { randomUUID } = require('crypto');
const path = require('path');

const {
  applySeedData,
  listSeedFiles,
  readSeedFile,
  isDuplicateConflict,
  createTokenProvider,
  validateSeedLookupContract,
  validateAttachmentFile,
  splitReservedFiles,
  planSeedData,
} = require('../lib/apply-seed-data');
const { parseArgs, run } = require('../apply-seed-data');

function tempDir() {
  const dir = path.resolve(`.seed-test-${randomUUID()}`);
  fs.mkdirSync(dir);
  return dir;
}

const TEST_ENV = 'https://contoso.crm.dynamics.com';
const RECORD_ID = '11111111-1111-1111-1111-111111111111';

function seedFixture(t, data, attachment = '%PDF-1.4\nsynthetic fixture\n') {
  const seedDir = tempDir();
  t.after(() => fs.rmSync(seedDir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(seedDir, 'files'));
  fs.writeFileSync(path.join(seedDir, 'files', 'stored.pdf'), attachment);
  const seedFile = path.join(seedDir, 'data.json');
  fs.writeFileSync(seedFile, JSON.stringify(data));
  return { seedDir, seedFile, envUrl: TEST_ENV };
}

function attachmentSeed() {
  return {
    entitySetName: 'cr123_attachments',
    primaryKey: 'cr123_attachmentid',
    records: [{
      cr123_attachmentid: RECORD_ID,
      cr123_name: 'Business title',
      cr123_file: '22222222-2222-2222-2222-222222222222',
      cr123_file_name: 'Reviewed invoice.pdf',
      __files: { cr123_file: 'files/stored.pdf' },
      statecode: 0,
      statuscode: 1,
    }],
  };
}

for (const shape of ['flat __files', 'export fileExports']) {
  test(`applySeedData creates and uploads original ${shape} without generated file properties`, async (t) => {
    const flat = attachmentSeed();
    const data = shape === 'flat __files' ? flat : {
      tables: { attachments: {
        logicalName: 'cr123_attachment',
        entitySet: flat.entitySetName,
        idColumn: flat.primaryKey,
        records: flat.records.map(({ __files, ...record }) => record),
      } },
      fileExports: [{ attachmentId: RECORD_ID, fileColumn: 'cr123_file', path: 'files/stored.pdf' }],
    };
    const original = JSON.stringify(data);
    const args = seedFixture(t, data);
    const requests = [];
    const result = await applySeedData(args, {
      token: 'test-token',
      randomBlockId: () => 'block-1',
      makeRequest: async (request) => {
        const body = JSON.parse(request.body);
        requests.push({ ...request, body });
        if (request.url.endsWith('/cr123_attachments') &&
            ('cr123_file' in body || 'cr123_file_name' in body)) {
          return { statusCode: 400, body: 'File and derived name cannot be set on create' };
        }
        if (request.url.endsWith('/InitializeFileBlocksUpload')) {
          return { statusCode: 200, body: '{"FileContinuationToken":"private-continuation"}' };
        }
        return { statusCode: 204 };
      },
    });
    assert.deepEqual(result, { ok: true, inserted: 1, failed: 0, skipped: 0, errors: [] });
    assert.deepEqual(requests.map((r) => r.method), ['POST', 'PATCH', 'POST', 'POST', 'POST']);
    assert.deepEqual(requests[0].body, { cr123_attachmentid: RECORD_ID, cr123_name: 'Business title' });
    assert.deepEqual(requests[1].body, { statecode: 0, statuscode: 1 });
    assert.equal(requests[2].body.FileName, 'Reviewed invoice.pdf');
    assert.equal(requests[2].body.Target.cr123_attachmentid, RECORD_ID);
    assert.equal(requests[3].body.BlockData, Buffer.from('%PDF-1.4\nsynthetic fixture\n').toString('base64'));
    assert.equal(requests[4].body.FileName, 'Reviewed invoice.pdf');
    assert.equal(JSON.stringify(data), original);
  });
}

test('splitReservedFiles preserves source objects and unrelated business name fields', () => {
  const record = attachmentSeed().records[0];
  const before = JSON.stringify(record);
  const { recordBody, files } = splitReservedFiles(record);
  assert.equal(recordBody.cr123_file, undefined);
  assert.equal(recordBody.cr123_file_name, undefined);
  assert.equal(recordBody.cr123_name, 'Business title');
  assert.deepEqual(files, { cr123_file: 'files/stored.pdf' });
  assert.equal(JSON.stringify(record), before);
});

const CURRENCY_ID = '33333333-3333-3333-3333-333333333333';
const CURRENCY_NAV = 'cr123_InvoiceCurrency';

function financialSeed() {
  return {
    tables: {
      contacts: { logicalName: 'contact', entitySet: 'contacts', idColumn: 'contactid',
        records: [{ contactid: RECORD_ID, firstname: 'Unaffected', creditdescription: 'Not Money' }] },
      invoices: { logicalName: 'cr123_invoice', entitySet: 'cr123_invoices', idColumn: 'cr123_invoiceid',
        records: [{
          cr123_invoiceid: '22222222-2222-2222-2222-222222222222',
          cr123_total: 125.25,
          _transactioncurrencyid_value: '44444444-4444-4444-4444-444444444444',
          '_transactioncurrencyid_value@Microsoft.Dynamics.CRM.associatednavigationproperty': CURRENCY_NAV,
        }, { cr123_name: 'No monetary values' }] },
    },
  };
}

function currencyRequests(requests, override = () => null) {
  return async (req) => {
    requests.push(req);
    const custom = override(req);
    if (custom) return custom;
    if (req.method === 'POST' || req.method === 'PATCH') return { statusCode: 204 };
    let value;
    if (req.url.includes('EntityDefinitions?')) {
      const invoice = req.url.includes('cr123_invoices');
      value = [{ EntitySetName: invoice ? 'cr123_invoices' : 'contacts',
        LogicalName: invoice ? 'cr123_invoice' : 'contact',
        PrimaryIdAttribute: invoice ? 'cr123_invoiceid' : 'contactid' }];
    } else if (req.url.includes('MoneyAttributeMetadata')) {
      value = req.url.includes("'cr123_invoice'")
        ? [{ LogicalName: 'cr123_total', IsValidForCreate: true }] : [];
    } else if (req.url.includes('ManyToOneRelationships')) {
      value = [{
        ReferencedEntity: 'transactioncurrency',
        ReferencingEntity: 'cr123_invoice',
        ReferencingAttribute: 'transactioncurrencyid',
        ReferencingEntityNavigationPropertyName: CURRENCY_NAV,
      }];
    } else if (req.url.includes('transactioncurrencies?')) {
      value = [{ transactioncurrencyid: CURRENCY_ID, isocurrencycode: 'SGD',
        currencyname: 'Singapore Dollar', statecode: 0 }];
    } else {
      throw new Error(`unexpected metadata request: ${req.url}`);
    }
    return { statusCode: 200, body: JSON.stringify({ value }) };
  };
}

    for (const filename of ['', ' ', null, 7, {}, '../invoice.pdf', 'dir/invoice.pdf',
      'dir\\invoice.pdf', 'C:\\invoice.pdf', 'invoice.pdf\n', 'invoice.pdf\u0000', '..']) {
      test(`upload filename ${JSON.stringify(filename)} is rejected before record creation`, async (t) => {
        const seed = attachmentSeed();
        seed.records[0].cr123_file_name = filename;
        let calls = 0;
        const result = await applySeedData(seedFixture(t, seed), {
          token: 'test-token', makeRequest: async () => { calls++; return { statusCode: 204 }; },
        });
        assert.equal(result.ok, false);
        assert.equal(result.failed, 1);
        assert.equal(result.inserted, 0);
        assert.equal(calls, 0);
        assert.match(result.errors[0].message, /upload filename/);
      });
    }

    test('absent upload companion retains attachment basename and unrelated name properties', async (t) => {
      const seed = attachmentSeed();
      delete seed.records[0].cr123_file_name;
      seed.records[0].cr123_business_name = 'Unrelated';
      const requests = [];
      const result = await applySeedData(seedFixture(t, seed), {
        token: 'test-token', randomBlockId: () => 'block-1',
        makeRequest: async (req) => {
          requests.push(req);
          return req.url.endsWith('/InitializeFileBlocksUpload')
            ? { statusCode: 200, body: '{"FileContinuationToken":"continuation"}' } : { statusCode: 204 };
        },
      });
      assert.equal(result.ok, true);
      assert.equal(JSON.parse(requests[0].body).cr123_business_name, 'Unrelated');
      assert.equal(JSON.parse(requests[2].body).FileName, 'stored.pdf');
      assert.equal(JSON.parse(requests.at(-1).body).FileName, 'stored.pdf');
    });

    for (const scenario of [
      'state http', 'state transport', 'state throw',
      'init http', 'init transport', 'init throw', 'init invalid JSON', 'init no token', 'init invalid token',
      'init invalid status', 'block http', 'block transport', 'block throw', 'block invalid status',
      'commit http', 'commit transport', 'commit throw', 'commit invalid status',
      'read error', 'short read', 'empty file',
    ]) {
      test(`state/file ${scenario} fails truthfully after creation and continues later records`, async (t) => {
        const seed = attachmentSeed();
        seed.records.push({ cr123_name: 'Later record' });
        const args = seedFixture(t, seed, scenario === 'empty file' ? '' : '%PDF-1.4\nfixture');
        const requests = [];
        const fileFs = scenario === 'read error' || scenario === 'short read' ? {
          ...fs,
          readSync: (...args) => {
            if (args[3] === 200) return fs.readSync(...args);
            if (scenario === 'read error') throw new Error('file read rejected');
            return 0;
          },
        } : fs;
        const result = await applySeedData(args, {
          token: 'private-bearer', fs: fileFs, randomBlockId: () => 'block-1',
          makeRequest: async (req) => {
            requests.push(req);
            const operation = req.method === 'PATCH' ? 'state' :
              req.url.endsWith('/InitializeFileBlocksUpload') ? 'init' :
              req.url.endsWith('/UploadBlock') ? 'block' :
              req.url.endsWith('/CommitFileBlocksUpload') ? 'commit' : 'record';
            if (scenario.startsWith(`${operation} `)) {
              if (scenario.endsWith('transport')) return { error: 'transport rejected' };
              if (scenario.endsWith('throw')) throw new Error('request rejected private-bearer private-continuation');
              if (scenario.endsWith('http')) return { statusCode: 400, body: 'operation rejected' };
              if (scenario.endsWith('invalid status')) return {};
              if (scenario.endsWith('invalid JSON')) return { statusCode: 200, body: 'not JSON' };
              if (scenario.endsWith('no token')) return { statusCode: 200, body: '{}' };
              if (scenario.endsWith('invalid token')) return { statusCode: 200, body: '{"FileContinuationToken":7}' };
            }
            return operation === 'init' ? { statusCode: 200, body: '{"FileContinuationToken":"private-continuation"}' }
              : { statusCode: 204 };
          },
        });
        assert.equal(result.ok, false);
        assert.equal(result.inserted, 2);
        assert.equal(result.failed, 1);
        assert.equal(result.skipped, 0);
        assert.equal(result.errors.length, 1);
        assert.equal(JSON.parse(requests.at(-1).body).cr123_name, 'Later record');
        assert.ok(!JSON.stringify(result).includes('private-bearer'));
        if (scenario.startsWith('block ') || scenario.startsWith('commit ')) {
          assert.ok(!JSON.stringify(result).includes('private-continuation'));
        }
        if (scenario.startsWith('state ')) assert.ok(!requests.some((r) => r.url.endsWith('/InitializeFileBlocksUpload')));
        if (scenario.startsWith('block ') || scenario === 'short read' || scenario === 'read error') {
          assert.ok(!requests.some((r) => r.url.endsWith('/CommitFileBlocksUpload')));
        }
      });
    }

    test('duplicates without failures remain successful and state PATCH behavior is preserved', async (t) => {
      const seed = attachmentSeed();
      delete seed.records[0].__files;
      delete seed.records[0].cr123_file;
      delete seed.records[0].cr123_file_name;
      const requests = [];
      const result = await applySeedData(seedFixture(t, seed), {
        token: 'test-token',
        makeRequest: async (req) => {
          requests.push(req);
          return req.method === 'POST' ? { statusCode: 409, body: 'Cannot insert duplicate key' } : { statusCode: 204 };
        },
      });
      assert.deepEqual(result, { ok: true, inserted: 0, skipped: 1, failed: 0, errors: [] });
      assert.equal(requests[1].method, 'PATCH');
      assert.equal(requests[1].headers['If-Match'], '*');
    });

    for (const scenario of ['invalid record', 'invalid file', 'invalid source JSON', 'invalid query JSON', 'auth']) {
      test(`plan rejects ${scenario} without writes`, async (t) => {
        const data = scenario === 'invalid record' ? { entitySetName: 'contacts', records: [null] }
          : scenario === 'invalid file' ? attachmentSeed() : financialSeed();
        if (scenario === 'invalid file') data.records[0].__files.cr123_file = '../outside.pdf';
        const args = seedFixture(t, data);
        if (scenario === 'invalid source JSON') fs.writeFileSync(args.seedFile, '{');
        const requests = [];
        const result = await planSeedData(args, {
          ...(scenario !== 'auth' ? { token: 'test-token' } : { getAuthToken: () => null }),
          makeRequest: currencyRequests(requests, () => scenario === 'invalid query JSON'
            ? { statusCode: 200, body: '{}' } : null),
        });
        assert.equal(result.ok, false);
        assert.equal(result.writes, 0);
        assert.ok(result.errors.length);
        assert.ok(requests.every((r) => !r.method || r.method === 'GET'));
      });
    }
test('explicit currency resolves metadata and active target before first write without changing amounts or nonfinancial rows', async (t) => {
  const args = seedFixture(t, financialSeed());
  const requests = [];
  const result = await applySeedData({ ...args, currencyCode: 'sgd' }, {
    token: 'test-token',
    makeRequest: currencyRequests(requests),
  });
  assert.equal(result.ok, true);
  const writes = requests.filter((r) => r.method === 'POST');
  const gets = requests.filter((r) => !r.method || r.method === 'GET');
  assert.ok(gets.length >= 6);
  assert.ok(requests.indexOf(writes[0]) > requests.indexOf(gets.at(-1)));
  assert.deepEqual(JSON.parse(writes[0].body), {
    contactid: RECORD_ID, firstname: 'Unaffected', creditdescription: 'Not Money',
  });
  assert.deepEqual(JSON.parse(writes[1].body), {
    cr123_invoiceid: '22222222-2222-2222-2222-222222222222', cr123_total: 125.25,
    [`${CURRENCY_NAV}@odata.bind`]: `/transactioncurrencies(${CURRENCY_ID})`,
  });
  assert.deepEqual(JSON.parse(writes[2].body), { cr123_name: 'No monetary values' });
});

test('planSeedData reports validated source counts, financial rows and active currencies with GETs only', async (t) => {
  const args = seedFixture(t, financialSeed());
  const requests = [];
  const result = await planSeedData(args, { token: 'test-token', makeRequest: currencyRequests(requests) });
  assert.equal(result.ok, true);
  assert.equal(result.writes, 0);
  assert.deepEqual(result.counts, { tables: 2, records: 3, files: 0 });
  assert.deepEqual(result.financialEntitySets, [{
    entitySetName: 'cr123_invoices', logicalName: 'cr123_invoice', recordCount: 1,
    moneyAttributes: ['cr123_total'],
  }]);
  assert.deepEqual(result.currencies, [{ code: 'SGD', name: 'Singapore Dollar', id: CURRENCY_ID }]);
  assert.equal(result.requiresCurrencySelection, true);
  assert.ok(requests.every((r) => !r.method || r.method === 'GET'));
  assert.ok(!JSON.stringify(result).includes('test-token'));
});

for (const references of [
  ['invalid'],
  [42],
  [`/accounts(${RECORD_ID})`, `/contacts(${CURRENCY_ID})`],
  [`/accounts(${RECORD_ID})`],
  [`/contacts(${RECORD_ID})`, null],
  [`/contacts/../accounts(${CURRENCY_ID})`],
]) {
  test(`collection bind preflight rejects ${JSON.stringify(references)} before any write`, async (t) => {
    const data = {
      tables: {
        contacts: { entitySet: 'contacts', idColumn: 'contactid', records: [{ contactid: RECORD_ID }] },
        accounts: { entitySet: 'accounts', idColumn: 'accountid', records: [{
          accountid: CURRENCY_ID, 'cr123_Contacts@odata.bind': references,
        }] },
      },
    };
    const args = seedFixture(t, data);
    let calls = 0;
    const result = await applySeedData(args, {
      token: 'test-token', makeRequest: async () => { calls++; return { statusCode: 204 }; },
    });
    assert.equal(result.ok, false);
    assert.equal(result.inserted, 0);
    assert.equal(calls, 0);
    assert.match(result.errors[0].message, /Lookup/);
  });
}

test('collection binds associate contacts on create unchanged, including valid external targets', async (t) => {
  const references = [`/accounts(${CURRENCY_ID})`, '/accounts(55555555-5555-5555-5555-555555555555)'];
  const args = seedFixture(t, {
    tables: {
      accounts: { entitySet: 'accounts', idColumn: 'accountid', records: [{ accountid: CURRENCY_ID }] },
      contacts: { entitySet: 'contacts', idColumn: 'contactid', records: [{
        contactid: RECORD_ID, 'cr123_Suppliers@odata.bind': references,
      }] },
    },
  });
  const requests = [];
  const result = await applySeedData(args, {
    token: 'test-token',
    makeRequest: async (req) => { requests.push(req); return { statusCode: 204 }; },
  });
  assert.equal(result.ok, true);
  assert.equal(requests.length, 2);
  assert.deepEqual(JSON.parse(requests[1].body)['cr123_Suppliers@odata.bind'], references);
  assert.ok(requests[1].url.endsWith('/contacts'));
});

test('CLI parses plan and currency and reports missing flag values explicitly', async () => {
  assert.deepEqual(parseArgs(['--plan', '--seedDir', 'seed', '--envUrl', TEST_ENV, '--currencyCode', 'sgd']), {
    plan: true, seedDir: 'seed', envUrl: TEST_ENV, currencyCode: 'sgd',
  });
  const usage = ['--seedDir', 'seed', '--envUrl', TEST_ENV];
  for (const argv of [[...usage, '--currencyCode'], [...usage, '--currencyCode', '--plan']]) {
    const result = await run(argv);
    assert.equal(result.ok, false);
    assert.match(result.errors[0].message, /currencyCode.*value/i);
  }
});

  test('CLI plan is read-only and no financial payload means no currency query or selection', async (t) => {
    const args = seedFixture(t, { entitySetName: 'contacts', records: [{ firstname: 'No Money' }] });
    const requests = [];
    const result = await run(['--seedDir', args.seedDir, '--seedFile', args.seedFile,
      '--envUrl', TEST_ENV, '--plan'], { token: 'test-token', makeRequest: currencyRequests(requests) });
    assert.equal(result.ok, true);
    assert.equal(result.writes, 0);
    assert.equal(result.requiresCurrencySelection, false);
    assert.deepEqual(result.financialEntitySets, []);
    assert.deepEqual(result.currencies, []);
    assert.equal(requests.length, 2);
    assert.ok(requests.every((r) => !r.method || r.method === 'GET'));
  });

  test('currency default path performs no metadata queries and preserves explicit currency intent', async (t) => {
    const data = { entitySetName: 'cr123_invoices', records: [{
      cr123_total: 9, 'transactioncurrencyid@odata.bind': `/transactioncurrencies(${CURRENCY_ID})`,
    }] };
    const requests = [];
    const result = await applySeedData(seedFixture(t, data), {
      token: 'test-token',
      makeRequest: async (req) => { requests.push(req); return { statusCode: 204 }; },
    });
    assert.equal(result.ok, true);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, 'POST');
    assert.deepEqual(JSON.parse(requests[0].body), data.records[0]);
  });

  for (const code of ['', 'SG', 'SGDD', 'S9D', ' Sgd ', 'ＳＧＤ', null]) {
    test(`invalid currency code ${JSON.stringify(code)} fails before auth or requests`, async (t) => {
      let calls = 0;
      const result = await applySeedData({ ...seedFixture(t, financialSeed()), currencyCode: code }, {
        getAuthToken: () => { calls++; throw new Error('must not authenticate'); },
        makeRequest: async () => { calls++; throw new Error('must not query'); },
      });
      assert.equal(result.ok, false);
      assert.equal(calls, 0);
      assert.match(result.errors[0].message, /three ASCII letters/);
    });
  }

  for (const scenario of [
    'missing currency', 'duplicate currency', 'inactive currency', 'invalid currency id',
    'invalid currency code', 'wrong currency code', 'missing Money metadata',
    'unsupported Money metadata', 'missing navigation', 'ambiguous navigation', 'unsafe navigation',
    'missing entity', 'wrong entity', 'unsafe logical name', 'wrong source logical name',
    'metadata http', 'metadata transport', 'metadata throw', 'metadata invalid JSON',
    'metadata missing value', 'currency http', 'currency invalid JSON',
    'cross-origin nextLink', 'pagination cycle',
  ]) {
    test(`explicit currency fails before writes for ${scenario}`, async (t) => {
      const data = financialSeed();
      if (scenario === 'wrong source logical name') data.tables.invoices.logicalName = 'cr123_other';
      const requests = [];
      const override = (req) => {
        const metadata = req.url.includes('EntityDefinitions?') && req.url.includes('cr123_invoices');
        const money = req.url.includes('MoneyAttributeMetadata') && req.url.includes("'cr123_invoice'");
        const navigation = req.url.includes('ManyToOneRelationships');
        const currency = req.url.includes('transactioncurrencies?');
        const response = (value) => ({ statusCode: 200, body: JSON.stringify({ value }) });
        if (metadata) {
          if (scenario === 'missing entity') return response([]);
          if (scenario === 'wrong entity') return response([{ EntitySetName: 'wrong', LogicalName: 'invoice', PrimaryIdAttribute: 'invoiceid' }]);
          if (scenario === 'unsafe logical name') return response([{ EntitySetName: 'cr123_invoices', LogicalName: "'injected'", PrimaryIdAttribute: 'invoiceid' }]);
          if (scenario === 'metadata http') return { statusCode: 403, body: 'metadata denied' };
          if (scenario === 'metadata transport') return { error: 'metadata network error' };
          if (scenario === 'metadata throw') throw new Error('metadata request exploded');
          if (scenario === 'metadata invalid JSON') return { statusCode: 200, body: '{' };
          if (scenario === 'metadata missing value') return { statusCode: 200, body: '{}' };
          if (scenario === 'cross-origin nextLink') return { statusCode: 200, body: JSON.stringify({
            value: [], '@odata.nextLink': 'https://other.crm.dynamics.com/api/data/v9.2/EntityDefinitions',
          }) };
          if (scenario === 'pagination cycle') return { statusCode: 200, body: JSON.stringify({
            value: [], '@odata.nextLink': req.url,
          }) };
        }
        if (money) {
          if (scenario === 'missing Money metadata') return { statusCode: 200, body: '{}' };
          if (scenario === 'unsupported Money metadata') return response([{ LogicalName: 'cr123_total', IsValidForCreate: false }]);
        }
        if (navigation) {
          if (scenario === 'missing navigation') return response([]);
          if (scenario === 'ambiguous navigation' || scenario === 'unsafe navigation') {
            const row = { ReferencedEntity: 'transactioncurrency', ReferencingEntity: 'cr123_invoice',
              ReferencingAttribute: 'transactioncurrencyid',
              ReferencingEntityNavigationPropertyName: scenario === 'unsafe navigation' ? '../invalid' : CURRENCY_NAV };
            return response(scenario === 'ambiguous navigation' ? [row, row] : [row]);
          }
        }
        if (currency) {
          if (scenario === 'missing currency') return response([]);
          if (scenario === 'currency http') return { statusCode: 401, body: 'currency denied' };
          if (scenario === 'currency invalid JSON') return { statusCode: 200, body: 'not JSON' };
          const row = { transactioncurrencyid: CURRENCY_ID, isocurrencycode: 'SGD',
            currencyname: 'Singapore Dollar', statecode: 0 };
          if (scenario === 'duplicate currency') return response([row, { ...row, transactioncurrencyid: RECORD_ID }]);
          if (scenario === 'inactive currency') return response([{ ...row, statecode: 1 }]);
          if (scenario === 'invalid currency id') return response([{ ...row, transactioncurrencyid: 'not-a-guid' }]);
          if (scenario === 'invalid currency code') return response([{ ...row, isocurrencycode: '' }]);
          if (scenario === 'wrong currency code') return response([{ ...row, isocurrencycode: 'USD' }]);
        }
        return null;
      };
      const result = await applySeedData({ ...seedFixture(t, data), currencyCode: 'SGD' }, {
        token: 'test-token', makeRequest: currencyRequests(requests, override),
      });
      assert.equal(result.ok, false);
      assert.equal(result.inserted, 0);
      assert.equal(result.failed, 1);
      assert.ok(result.errors[0].message);
      assert.ok(requests.every((r) => !r.method || r.method === 'GET'));
      assert.ok(requests.every((r) => new URL(r.url).origin === TEST_ENV));
    });
  }

  for (const binding of [
    '/transactioncurrencies(55555555-5555-5555-5555-555555555555)',
    [`/transactioncurrencies(${CURRENCY_ID})`],
    `/contacts(${CURRENCY_ID})`,
  ]) {
    test(`explicit conflicting currency ${JSON.stringify(binding)} stops unrelated earlier writes`, async (t) => {
      const data = financialSeed();
      data.tables.invoices.records[0][`${CURRENCY_NAV}@odata.bind`] = binding;
      const requests = [];
      const result = await applySeedData({ ...seedFixture(t, data), currencyCode: 'SGD' }, {
        token: 'test-token', makeRequest: currencyRequests(requests),
      });
      assert.equal(result.ok, false);
      assert.equal(result.inserted, 0);
      assert.match(result.errors[0].message, /currency binding disagrees/);
      assert.ok(requests.every((r) => !r.method || r.method === 'GET'));
    });
  }

  test('explicit matching currency binding is preserved and source lookup/exchange rate fields are not forwarded', async (t) => {
    const data = { entitySetName: 'cr123_invoices', records: [{
      cr123_total: 20, _transactioncurrencyid_value: RECORD_ID, exchangerate: 1.23,
      [`${CURRENCY_NAV}@odata.bind`]: `/transactioncurrencies(${CURRENCY_ID})`,
    }] };
    const requests = [];
    const result = await applySeedData({ ...seedFixture(t, data), currencyCode: 'SGD' }, {
      token: 'test-token', makeRequest: currencyRequests(requests),
    });
    assert.equal(result.ok, true);
    assert.deepEqual(JSON.parse(requests.at(-1).body), {
      cr123_total: 20, [`${CURRENCY_NAV}@odata.bind`]: `/transactioncurrencies(${CURRENCY_ID})`,
    });
  });

  for (const invalid of ['missing active currencies', 'duplicate active currencies']) {
    test(`plan fails explicitly with no writes on ${invalid}`, async (t) => {
      const requests = [];
      const result = await planSeedData(seedFixture(t, financialSeed()), {
        token: 'test-token', makeRequest: currencyRequests(requests, (req) => {
          if (!req.url.includes('transactioncurrencies?')) return null;
          const row = { transactioncurrencyid: CURRENCY_ID, isocurrencycode: 'SGD',
            currencyname: 'Singapore Dollar', statecode: 0 };
          return { statusCode: 200, body: JSON.stringify({
            value: invalid === 'missing active currencies' ? [] : [row, { ...row, transactioncurrencyid: RECORD_ID }],
          }) };
        }),
      });
      assert.equal(result.ok, false);
      assert.equal(result.writes, 0);
      assert.match(result.errors[0].message, /active|ambiguous|duplicate/i);
      assert.ok(requests.every((r) => !r.method || r.method === 'GET'));
    });
  }
for (const fileExports of [
  [null],
  [{ fileColumn: 'cr123_file', path: 'files/stored.pdf' }],
  [{ attachmentId: 'missing', fileColumn: 'cr123_file', path: 'files/stored.pdf' }],
  [{ attachmentId: CURRENCY_ID, fileColumn: 'cr123_file', path: 'files/stored.pdf' }],
  [{ attachmentId: RECORD_ID, fileColumn: 'cr123_file' }],
  'not-an-array',
]) {
  test(`invalid exported upload ${JSON.stringify(fileExports)} fails instead of silently omitting files`, async (t) => {
    const args = seedFixture(t, {
      tables: { attachments: { entitySet: 'cr123_attachments', idColumn: 'cr123_attachmentid',
        records: [{ cr123_attachmentid: RECORD_ID }] } }, fileExports,
    });
    let calls = 0;
    const result = await applySeedData(args, {
      token: 'test-token', makeRequest: async () => { calls++; return { statusCode: 204 }; },
    });
    assert.equal(result.ok, false);
    assert.equal(calls, 0);
    assert.match(result.errors[0].message, /fileExports|upload|attachment/i);
  });
}

for (const failure of ['http', 'transport', 'throw', 'invalid response']) {
  test(`applySeedData reports ok false for ${failure} and continues other rows`, async (t) => {
    const args = seedFixture(t, {
      entitySetName: 'contacts',
      records: [{ firstname: 'Failed' }, { firstname: 'Succeeded' }],
    });
    let calls = 0;
    const result = await applySeedData(args, {
      token: 'test-token',
      makeRequest: async () => {
        if (++calls === 2) return { statusCode: 204 };
        if (failure === 'throw') throw new Error('request exploded');
        if (failure === 'transport') return { error: 'network unavailable' };
        if (failure === 'invalid response') return {};
        return { statusCode: 400, body: 'create rejected' };
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.inserted, 1);
    assert.equal(result.failed, 1);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0].message, /request exploded|network unavailable|create rejected|invalid|HTTP/i);
  });
}

function withSeedStats(fsImpl, seedDir) {
  const resolvedSeedDir = path.resolve(seedDir);
  const existingLstat = fsImpl.lstatSync;
  return {
    ...fsImpl,
    lstatSync(targetPath) {
      if (path.resolve(targetPath) === resolvedSeedDir) {
        return {
          isSymbolicLink: () => false,
          isDirectory: () => true,
          isFile: () => false,
        };
      }
      if (existingLstat) {
        const stat = existingLstat(targetPath);
        return {
          isSymbolicLink: () => typeof stat.isSymbolicLink === 'function' ? stat.isSymbolicLink() : false,
          isDirectory: () => typeof stat.isDirectory === 'function' ? stat.isDirectory() : false,
          isFile: () => typeof stat.isFile === 'function' ? stat.isFile() : false,
        };
      }
      return {
        isSymbolicLink: () => false,
        isDirectory: () => false,
        isFile: () => true,
      };
    },
  };
}

test('listSeedFiles sorts JSON files by filename and ignores non-json files', (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, '020-posts.json'), '{}');
  fs.writeFileSync(path.join(dir, '010-categories.json'), '{}');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'ignore');

  assert.deepEqual(listSeedFiles(dir).map((file) => path.basename(file)), ['010-categories.json', '020-posts.json']);
});

test('listSeedFiles uses an explicit seed file without treating JSON attachments as seeds', (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const seedFile = path.join(dir, 'data.json');
  fs.writeFileSync(seedFile, '{}');
  fs.writeFileSync(path.join(dir, 'attachment.json'), '{"document":"content"}');

  assert.deepEqual(listSeedFiles(dir, {}, seedFile), [seedFile]);
});

test('applySeedData ignores a JSON attachment when an explicit seed file is provided', async (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const seedFile = path.join(dir, 'data.json');
  fs.writeFileSync(seedFile, JSON.stringify({
    entitySetName: 'cr123_categories',
    records: [{ cr123_name: 'Announcements' }],
  }));
  fs.writeFileSync(path.join(dir, 'attachment.json'), JSON.stringify({
    entitySetName: 'cr123_unintended',
    records: [{ cr123_name: 'Must not be inserted' }],
  }));
  const requestUrls = [];

  const result = await applySeedData({
    seedDir: dir,
    seedFile,
    envUrl: 'https://org.crm.dynamics.com',
  }, {
    token: 'token',
    makeRequest: async ({ url }) => {
      requestUrls.push(url);
      return { statusCode: 204 };
    },
  });

  assert.equal(result.inserted, 1);
  assert.equal(requestUrls.length, 1);
  assert.match(requestUrls[0], /\/cr123_categories$/);
});

test('listSeedFiles rejects symlinked seed roots and JSON files', (t) => {
  const parent = tempDir();
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const realSeedDir = path.join(parent, 'real-seed');
  const linkedSeedDir = path.join(parent, 'linked-seed');
  fs.mkdirSync(realSeedDir);
  fs.writeFileSync(path.join(realSeedDir, '010-data.json'), '{}');
  try {
    fs.symlinkSync(realSeedDir, linkedSeedDir, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (err) {
    if (err.code === 'EPERM' || err.code === 'EACCES') {
      t.skip(`directory symlinks are unavailable: ${err.code}`);
      return;
    }
    throw err;
  }
  assert.throws(() => listSeedFiles(linkedSeedDir), /symbolic link/);

  const outsideFile = path.join(parent, 'outside.json');
  const linkedFile = path.join(realSeedDir, '020-linked.json');
  fs.writeFileSync(outsideFile, '{}');
  try {
    fs.symlinkSync(outsideFile, linkedFile, 'file');
  } catch (err) {
    if (err.code === 'EPERM' || err.code === 'EACCES') {
      t.skip(`file symlinks are unavailable: ${err.code}`);
      return;
    }
    throw err;
  }
  assert.throws(() => listSeedFiles(realSeedDir), /symbolic link/);
  assert.throws(() => readSeedFile(linkedFile), /symbolic link/);
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

test('readSeedFile normalizes Dataverse export seed shape', (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'data.json');
  fs.writeFileSync(file, JSON.stringify({
    schemaVersion: 1,
    tables: {
      contacts: {
        logicalName: 'contact',
        entitySet: 'contacts',
        idColumn: 'contactid',
        records: [{ contactid: '11111111-1111-1111-1111-111111111111', fullname: 'Amy Chen' }],
      },
      invoices: {
        logicalName: 'spnvc_invoice',
        entitySet: 'spnvc_invoices',
        idColumn: 'spnvc_invoiceid',
        records: [{
          '@odata.etag': 'W/"1"',
          spnvc_invoiceid: '22222222-2222-2222-2222-222222222222',
          _spnvc_contactid_value: '11111111-1111-1111-1111-111111111111',
          '_spnvc_contactid_value@Microsoft.Dynamics.CRM.associatednavigationproperty': 'spnvc_ContactId',
          createdon: '2026-01-01T00:00:00Z',
        }],
      },
      invoiceAttachments: {
        logicalName: 'spnvc_invoiceattachment',
        entitySet: 'spnvc_invoiceattachments',
        idColumn: 'spnvc_invoiceattachmentid',
        records: [{
          spnvc_invoiceattachmentid: '33333333-3333-3333-3333-333333333333',
          spnvc_name: 'invoice.pdf',
        }],
      },
    },
    fileExports: [{
      attachmentId: '33333333-3333-3333-3333-333333333333',
      fileColumn: 'spnvc_file',
      path: 'files/invoice.pdf',
    }],
  }));

  const normalized = readSeedFile(file);
  assert.deepEqual(normalized.map((entry) => entry.entitySetName), ['contacts', 'spnvc_invoices', 'spnvc_invoiceattachments']);
  assert.deepEqual(normalized[1].records[0], {
    spnvc_invoiceid: '22222222-2222-2222-2222-222222222222',
    'spnvc_ContactId@odata.bind': '/contacts(11111111-1111-1111-1111-111111111111)',
  });
  assert.deepEqual(normalized[2].records[0].__files, { spnvc_file: 'files/invoice.pdf' });
});

test('readSeedFile rejects exports without a valid table entry', (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'data.json');

  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, tables: {} }));
  assert.throws(() => readSeedFile(file), /Expected/);

  fs.writeFileSync(file, JSON.stringify({
    schemaVersion: 1,
    tables: {
      broken: {
        entitySet: 'cr123_broken',
        records: [],
      },
    },
  }));
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
    fs: withSeedStats(fsImpl, '/virtual/seed'),
    makeRequest: async (req) => {
      requests.push(req);
      return { statusCode: 204 };
    },
  });

  assert.equal(result.inserted, 1);
  assert.equal(requests[0].url, 'https://org.crm.dynamics.com/api/data/v9.2/cr123_categories');
  assert.deepEqual(JSON.parse(requests[0].body), { cr123_name: 'Announcements' });
});

test('validateSeedLookupContract rejects inferred lookup aliases and mismatched entity sets', () => {
  const entries = [
    {
      file: '010-categories.json',
      seed: {
        entitySetName: 'spa311_categories',
        primaryKey: 'spa311_categoryid',
        records: [{ spa311_categoryid: '11111111-1111-1111-1111-111111111111' }],
      },
    },
    {
      file: '020-service-types.json',
      seed: {
        entitySetName: 'spa311_servicetypes',
        primaryKey: 'spa311_servicetypeid',
        records: [{
          spa311_servicetypeid: '22222222-2222-2222-2222-222222222222',
          categoryId: '11111111-1111-1111-1111-111111111111',
          'spa311_OtherCategory@odata.bind': '/wrong_categories(11111111-1111-1111-1111-111111111111)',
        }],
      },
    },
  ];

  assert.deepEqual(validateSeedLookupContract(entries), [
    {
      file: '020-service-types.json',
      entitySetName: 'spa311_servicetypes',
      message: 'Lookup categoryId is ambiguous; use the exact <NavigationProperty>@odata.bind name from the solution metadata',
    },
    {
      file: '020-service-types.json',
      entitySetName: 'spa311_servicetypes',
      message: 'Lookup spa311_OtherCategory@odata.bind targets wrong_categories, but the referenced seed record belongs to spa311_categories',
    },
  ]);
});

test('applySeedData preserves exact OData lookup navigation properties', async () => {
  const files = {
    '010-categories.json': {
      entitySetName: 'spa311_categories',
      primaryKey: 'spa311_categoryid',
      records: [{ spa311_categoryid: '11111111-1111-1111-1111-111111111111', spa311_name: 'Roads' }],
    },
    '020-service-types.json': {
      entitySetName: 'spa311_servicetypes',
      primaryKey: 'spa311_servicetypeid',
      records: [{
        spa311_servicetypeid: '22222222-2222-2222-2222-222222222222',
        spa311_name: 'Pothole',
        'spa311_CategoryId@odata.bind': '/spa311_categories(11111111-1111-1111-1111-111111111111)',
      }],
    },
    '030-service-requests.json': {
      entitySetName: 'spa311_servicerequests',
      primaryKey: 'spa311_servicerequestid',
      records: [{
        spa311_servicerequestid: '33333333-3333-3333-3333-333333333333',
        spa311_name: 'SR-001',
        'spa311_ServiceTypeId@odata.bind': '/spa311_servicetypes(22222222-2222-2222-2222-222222222222)',
      }],
    },
    '040-status-updates.json': {
      entitySetName: 'spa311_statusupdates',
      primaryKey: 'spa311_statusupdateid',
      records: [{
        spa311_statusupdateid: '44444444-4444-4444-4444-444444444444',
        spa311_name: 'Created',
        'spa311_ServiceRequestId@odata.bind': '/spa311_servicerequests(33333333-3333-3333-3333-333333333333)',
      }],
    },
  };
  const fsImpl = {
    existsSync: () => true,
    readdirSync: () => Object.keys(files),
    readFileSync: (filePath) => JSON.stringify(files[path.basename(filePath)]),
  };
  const requests = [];

  const result = await applySeedData({ seedDir: '/virtual/seed', envUrl: 'https://org.crm.dynamics.com' }, {
    token: 'token',
    fs: withSeedStats(fsImpl, '/virtual/seed'),
    makeRequest: async (req) => {
      requests.push(req);
      return { statusCode: 204 };
    },
  });

  assert.equal(result.failed, 0);
  assert.equal(result.inserted, 4);
  assert.deepEqual(JSON.parse(requests[1].body), {
    spa311_servicetypeid: '22222222-2222-2222-2222-222222222222',
    spa311_name: 'Pothole',
    'spa311_CategoryId@odata.bind': '/spa311_categories(11111111-1111-1111-1111-111111111111)',
  });
  assert.deepEqual(JSON.parse(requests[2].body), {
    spa311_servicerequestid: '33333333-3333-3333-3333-333333333333',
    spa311_name: 'SR-001',
    'spa311_ServiceTypeId@odata.bind': '/spa311_servicetypes(22222222-2222-2222-2222-222222222222)',
  });
  assert.deepEqual(JSON.parse(requests[3].body), {
    spa311_statusupdateid: '44444444-4444-4444-4444-444444444444',
    spa311_name: 'Created',
    'spa311_ServiceRequestId@odata.bind': '/spa311_servicerequests(33333333-3333-3333-3333-333333333333)',
  });
});

test('applySeedData rejects ambiguous lookup aliases before the first Dataverse write', async () => {
  const files = {
    '010-categories.json': {
      entitySetName: 'spa311_categories',
      primaryKey: 'spa311_categoryid',
      records: [{ spa311_categoryid: '11111111-1111-1111-1111-111111111111', spa311_name: 'Roads' }],
    },
    '020-service-types.json': {
      entitySetName: 'spa311_servicetypes',
      primaryKey: 'spa311_servicetypeid',
      records: [{
        spa311_servicetypeid: '22222222-2222-2222-2222-222222222222',
        categoryId: '11111111-1111-1111-1111-111111111111',
      }],
    },
  };
  const fsImpl = {
    existsSync: () => true,
    readdirSync: () => Object.keys(files),
    readFileSync: (filePath) => JSON.stringify(files[path.basename(filePath)]),
  };
  let requestCount = 0;

  const result = await applySeedData({ seedDir: '/virtual/seed', envUrl: 'https://org.crm.dynamics.com' }, {
    token: 'token',
    fs: withSeedStats(fsImpl, '/virtual/seed'),
    makeRequest: async () => {
      requestCount++;
      return { statusCode: 204 };
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.inserted, 0);
  assert.equal(result.failed, 1);
  assert.match(result.errors[0].message, /exact <NavigationProperty>@odata.bind/);
  assert.equal(requestCount, 0);
});

test('applySeedData posts Dataverse export seed tables and uploads fileExports', async () => {
  const seedDir = path.resolve('export-seed');
  const attachmentPath = path.join(seedDir, 'files', 'invoice.pdf');
  const fileBuffer = Buffer.from('pdf');
  const fsImpl = {
    existsSync: (p) => p === seedDir || p === attachmentPath,
    readdirSync: () => ['data.json'],
    readFileSync: (p) => {
      if (p.endsWith('data.json')) {
        return JSON.stringify({
          schemaVersion: 1,
          tables: {
            contacts: {
              logicalName: 'contact',
              entitySet: 'contacts',
              idColumn: 'contactid',
              records: [{ contactid: '11111111-1111-1111-1111-111111111111', fullname: 'Amy Chen' }],
            },
            invoices: {
              logicalName: 'spnvc_invoice',
              entitySet: 'spnvc_invoices',
              idColumn: 'spnvc_invoiceid',
              records: [{
                spnvc_invoiceid: '22222222-2222-2222-2222-222222222222',
                _contactid_value: '11111111-1111-1111-1111-111111111111',
                '_contactid_value@Microsoft.Dynamics.CRM.associatednavigationproperty': 'spnvc_ContactId',
              }],
            },
            attachments: {
              logicalName: 'spnvc_invoiceattachment',
              entitySet: 'spnvc_invoiceattachments',
              idColumn: 'spnvc_invoiceattachmentid',
              records: [{ spnvc_invoiceattachmentid: '33333333-3333-3333-3333-333333333333' }],
            },
          },
          fileExports: [{ attachmentId: '33333333-3333-3333-3333-333333333333', fileColumn: 'spnvc_file', path: 'files/invoice.pdf' }],
        });
      }
      return fileBuffer;
    },
    lstatSync: () => ({ isFile: () => true }),
    statSync: () => ({ size: fileBuffer.length }),
  };
  const requests = [];
  const result = await applySeedData({ seedDir, envUrl: 'https://org.crm.dynamics.com' }, {
    token: 'token',
    fs: withSeedStats(fsImpl, seedDir),
    randomBlockId: () => 'block-1',
    makeRequest: async (req) => {
      requests.push(req);
      if (req.url.endsWith('/InitializeFileBlocksUpload')) return { statusCode: 200, body: JSON.stringify({ FileContinuationToken: 'continuation' }) };
      return { statusCode: 204 };
    },
  });

  const invoicePost = requests.find((req) => req.url.endsWith('/spnvc_invoices'));
  assert.equal(result.failed, 0);
  assert.equal(result.inserted, 3);
  assert.deepEqual(JSON.parse(invoicePost.body), {
    spnvc_invoiceid: '22222222-2222-2222-2222-222222222222',
    'spnvc_ContactId@odata.bind': '/contacts(11111111-1111-1111-1111-111111111111)',
  });
  assert.equal(requests.some((req) => req.url.endsWith('/InitializeFileBlocksUpload')), true);
});

test('applySeedData creates stateful records before applying the desired state separately', async () => {
  const articleId = '50000000-0000-4000-8000-000000000001';
  const fsImpl = {
    existsSync: () => true,
    readdirSync: () => ['data.json'],
    readFileSync: () => JSON.stringify({
      schemaVersion: 1,
      tables: {
        knowledgearticles: {
          logicalName: 'knowledgearticle',
          entitySet: 'knowledgearticles',
          idColumn: 'knowledgearticleid',
          records: [{
            knowledgearticleid: articleId,
            title: 'How to Report a Pothole',
            statecode: 3,
            statuscode: 7,
          }],
        },
      },
    }),
  };
  const requests = [];

  const result = await applySeedData({ seedDir: '/virtual/seed', envUrl: 'https://org.crm.dynamics.com' }, {
    token: 'token',
    fs: withSeedStats(fsImpl, '/virtual/seed'),
    makeRequest: async (req) => {
      requests.push(req);
      if (req.method === 'POST' && Object.hasOwn(JSON.parse(req.body), 'statecode')) {
        return {
          statusCode: 400,
          body: '7 is not a valid status code for state code KnowledgeArticleState.Draft',
        };
      }
      return { statusCode: 204 };
    },
  });

  assert.deepEqual(result, {
    ok: true,
    inserted: 1,
    failed: 0,
    skipped: 0,
    errors: [],
  });
  assert.equal(requests.length, 2);
  assert.deepEqual({
    method: requests[0].method,
    url: requests[0].url,
    body: JSON.parse(requests[0].body),
  }, {
    method: 'POST',
    url: 'https://org.crm.dynamics.com/api/data/v9.2/knowledgearticles',
    body: {
      knowledgearticleid: articleId,
      title: 'How to Report a Pothole',
    },
  });
  assert.deepEqual({
    method: requests[1].method,
    url: requests[1].url,
    body: JSON.parse(requests[1].body),
    ifMatch: requests[1].headers['If-Match'],
  }, {
    method: 'PATCH',
    url: `https://org.crm.dynamics.com/api/data/v9.2/knowledgearticles(${articleId})`,
    body: {
      statecode: 3,
      statuscode: 7,
    },
    ifMatch: '*',
  });
});

test('applySeedData rejects stateful records without a GUID primary key before writing', async () => {
  const fsImpl = {
    existsSync: () => true,
    readdirSync: () => ['010-articles.json'],
    readFileSync: () => JSON.stringify({
      entitySetName: 'knowledgearticles',
      records: [{
        title: 'How to Report a Pothole',
        statecode: 3,
        statuscode: 7,
      }],
    }),
  };
  let requestCount = 0;

  const result = await applySeedData({ seedDir: '/virtual/seed', envUrl: 'https://org.crm.dynamics.com' }, {
    token: 'token',
    fs: withSeedStats(fsImpl, '/virtual/seed'),
    makeRequest: async () => {
      requestCount += 1;
      return { statusCode: 204 };
    },
  });

  assert.equal(result.inserted, 0);
  assert.equal(result.failed, 1);
  assert.match(result.errors[0].message, /must declare a primaryKey containing a GUID/);
  assert.equal(requestCount, 0);
});

test('applySeedData refreshes tokens across the whole seed run instead of per record', async () => {
  const fsImpl = {
    existsSync: () => true,
    readdirSync: () => ['010-categories.json'],
    readFileSync: () => JSON.stringify({
      entitySetName: 'cr123_categories',
      records: [
        { cr123_name: 'One' },
        { cr123_name: 'Two' },
        { cr123_name: 'Three' },
      ],
    }),
  };
  const authResources = [];
  const authHeaders = [];

  const result = await applySeedData({ seedDir: '/virtual/seed', envUrl: 'https://org.crm.dynamics.com' }, {
    fs: withSeedStats(fsImpl, '/virtual/seed'),
    token: 'initial-token',
    tokenRefreshEvery: 2,
    getAuthToken: (resource) => {
      authResources.push(resource);
      return `refreshed-${authResources.length}`;
    },
    makeRequest: async (req) => {
      authHeaders.push(req.headers.Authorization);
      return { statusCode: 204 };
    },
  });

  assert.equal(result.inserted, 3);
  assert.deepEqual(authHeaders, ['Bearer initial-token', 'Bearer initial-token', 'Bearer refreshed-1']);
  assert.deepEqual(authResources, ['https://org.crm.dynamics.com']);
});

test('applySeedData strips __files, requires primaryKey, and uploads file-column attachments in 4 MiB blocks', async () => {
  const seedDir = path.resolve('virtual-seed');
  const attachmentPath = path.join(seedDir, 'files', 'invoices', 'inv-001.pdf');
  const fileBuffer = Buffer.concat([
    Buffer.alloc(4 * 1024 * 1024, 1),
    Buffer.from('tail'),
  ]);
  const fsImpl = {
    existsSync: (p) => p === seedDir || p === attachmentPath,
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
    lstatSync: () => ({ isFile: () => true }),
    statSync: () => ({ size: fileBuffer.length }),
  };
  const requests = [];
  const result = await applySeedData({ seedDir, envUrl: 'https://org.crm.dynamics.com' }, {
    token: 'token',
    fs: withSeedStats(fsImpl, seedDir),
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
    fs: withSeedStats(fsImpl, '/virtual/seed'),
    makeRequest: async () => ({ statusCode: 204 }),
  });

  assert.equal(result.inserted, 0);
  assert.equal(result.failed, 1);
  assert.match(result.errors[0].message, /primaryKey/);
});

test('validateAttachmentFile rejects symbolic links without reading their targets', (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const targetPath = path.join(dir, 'outside.pdf');
  const linkPath = path.join(dir, 'attachment.pdf');
  fs.writeFileSync(targetPath, 'sensitive content');
  try {
    fs.symlinkSync(targetPath, linkPath);
  } catch (err) {
    if (err.code === 'EPERM' || err.code === 'EACCES') {
      t.skip(`symlinks are unavailable: ${err.code}`);
      return;
    }
    throw err;
  }

  assert.match(validateAttachmentFile(linkPath), /not a file/);
});

test('validateAttachmentFile rejects files reached through a symlinked directory', (t) => {
  const seedDir = tempDir();
  const outside = tempDir();
  t.after(() => {
    fs.rmSync(seedDir, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(outside, 'invoice.pdf'), 'sensitive content');
  const linkedDir = path.join(seedDir, 'files');
  try {
    fs.symlinkSync(outside, linkedDir, 'dir');
  } catch (err) {
    if (err.code === 'EPERM' || err.code === 'EACCES') {
      t.skip(`directory symlinks are unavailable: ${err.code}`);
      return;
    }
    throw err;
  }

  assert.match(
    validateAttachmentFile(path.join(linkedDir, 'invoice.pdf'), { seedDir }),
    /symbolic link/
  );
});

test('applySeedData rejects invalid entity-set paths before sending authenticated requests', async (t) => {
  const seedDir = tempDir();
  t.after(() => fs.rmSync(seedDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(seedDir, '010-invalid.json'), JSON.stringify({
    entitySetName: '../WhoAmI',
    records: [{ name: 'invalid' }],
  }));
  let requests = 0;

  const result = await applySeedData({
    seedDir,
    envUrl: 'https://org.crm.dynamics.com',
  }, {
    token: 'token',
    makeRequest: async () => {
      requests += 1;
      return { statusCode: 204 };
    },
  });

  assert.equal(requests, 0);
  assert.equal(result.failed, 1);
  assert.match(result.errors[0].message, /Invalid Dataverse OData operation name/);
});

test('applySeedData rejects untrusted environment URLs before acquiring a token', async () => {
  let tokenCalls = 0;
  const result = await applySeedData({
    seedDir: '/tmp/missing',
    envUrl: 'https://attacker.invalid',
  }, {
    getAuthToken: () => {
      tokenCalls += 1;
      return 'token';
    },
  });

  assert.equal(result.ok, false);
  assert.match(result.errors[0].message, /not an allowed Microsoft Dataverse/);
  assert.equal(tokenCalls, 0);
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
    fs: withSeedStats(fsImpl, '/virtual/seed'),
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
  const seedDir = path.resolve('virtual-seed');
  const attachmentPath = path.join(seedDir, 'files', 'invoices', 'inv-001.pdf');
  const fileBuffer = Buffer.from('pdf');
  const fsImpl = {
    existsSync: (p) => p === seedDir || p === attachmentPath,
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
    lstatSync: () => ({ isFile: () => true }),
    statSync: () => ({ size: fileBuffer.length }),
  };
  const requests = [];
  const result = await applySeedData({ seedDir, envUrl: 'https://org.crm.dynamics.com' }, {
    token: 'token',
    fs: withSeedStats(fsImpl, seedDir),
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
    lstatSync: () => ({ isFile: () => true }),
    statSync: () => ({ size: 42 }),
  };
  const requests = [];
  const result = await applySeedData({ seedDir: '/virtual/seed', envUrl: 'https://org.crm.dynamics.com' }, {
    token: 'token',
    fs: withSeedStats(fsImpl, '/virtual/seed'),
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

  const failingFs = {
    existsSync: () => true,
    readdirSync: () => { throw new Error('fs exploded'); },
  };
  const result = await applySeedData({ seedDir: '/virtual/seed', envUrl: 'https://org.crm.dynamics.com' }, {
    token: 'token',
    fs: withSeedStats(failingFs, '/virtual/seed'),
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

for (const statusCode of ['204', 200.5, null, undefined]) {
  test(`invalid create status ${statusCode} cannot produce success`, async (t) => {
    const result = await applySeedData(seedFixture(t, { entitySetName: 'contacts', records: [{}] }), {
      token: 'test-token', makeRequest: async () => ({ statusCode }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.inserted, 0);
    assert.equal(result.failed, 1);
  });
}

test('missing seed source is an explicit plan/apply failure, never a successful empty fallback', async () => {
  let calls = 0;
  const args = { seedDir: path.resolve('nonexistent-seed-fixture'), envUrl: TEST_ENV };
  const deps = { token: 'test-token', makeRequest: async () => { calls++; return { statusCode: 204 }; } };
  const plan = await planSeedData(args, deps);
  const applied = await applySeedData(args, deps);
  assert.equal(plan.ok, false);
  assert.equal(plan.writes, 0);
  assert.equal(applied.ok, false);
  assert.match(plan.errors[0].message, /seed.*JSON|seed.*source/i);
  assert.match(applied.errors[0].message, /seed.*JSON|seed.*source/i);
  assert.equal(calls, 0);
});

test('empty refreshed/custom tokens fail before authenticated metadata requests', async (t) => {
  for (const entryPoint of [applySeedData, planSeedData]) {
    let calls = 0;
    const result = await entryPoint({ ...seedFixture(t, financialSeed()), currencyCode: 'SGD' }, {
      token: 'initial-token', tokenProvider: () => null,
      makeRequest: async () => { calls++; return { statusCode: 200, body: '{"value":[]}' }; },
    });
    assert.equal(result.ok, false);
    assert.equal(calls, 0);
    assert.match(result.errors[0].message, /token unavailable/);
  }
});

test('same-origin metadata pagination lists all currencies and returns no continuation or auth secrets', async (t) => {
  const requests = [];
  const result = await planSeedData(seedFixture(t, financialSeed()), {
    token: 'private-auth',
    makeRequest: currencyRequests(requests, (req) => {
      if (!req.url.includes('transactioncurrencies?')) return null;
      if (req.url.includes('skiptoken')) {
        return { statusCode: 200, body: JSON.stringify({ value: [{
          transactioncurrencyid: RECORD_ID, currencyname: 'US Dollar', isocurrencycode: 'USD', statecode: 0,
        }] }) };
      }
      return { statusCode: 200, body: JSON.stringify({
        value: [{ transactioncurrencyid: CURRENCY_ID, currencyname: 'Singapore Dollar', isocurrencycode: 'SGD', statecode: 0 }],
        '@odata.nextLink': `${TEST_ENV}/api/data/v9.2/transactioncurrencies?$skiptoken=private-page-token`,
      }) };
    }),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.currencies.map((c) => c.code), ['SGD', 'USD']);
  assert.equal(result.writes, 0);
  assert.ok(!JSON.stringify(result).includes('private-'));
});

test('plan validates and counts original exported attachments without opening upload sessions', async (t) => {
  const flat = attachmentSeed();
  const args = seedFixture(t, {
    tables: { attachments: { entitySet: 'cr123_attachments', idColumn: 'cr123_attachmentid',
      records: flat.records.map(({ __files, ...record }) => record) } },
    fileExports: [{ attachmentId: RECORD_ID, fileColumn: 'cr123_file', path: 'files/stored.pdf' }],
  });
  const requests = [];
  const result = await planSeedData(args, {
    token: 'test-token',
    makeRequest: async (req) => {
      requests.push(req);
      const value = req.url.includes('EntityDefinitions?') ? [{
        EntitySetName: 'cr123_attachments', LogicalName: 'cr123_attachment', PrimaryIdAttribute: 'cr123_attachmentid',
      }] : [];
      return { statusCode: 200, body: JSON.stringify({ value }) };
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.counts, { tables: 1, records: 1, files: 1 });
  assert.equal(result.requiresCurrencySelection, false);
  assert.ok(requests.every((r) => !r.method || r.method === 'GET'));
});

test('explicit currency never creates source currencies', async (t) => {
  const args = seedFixture(t, { entitySetName: 'transactioncurrencies', records: [{
    transactioncurrencyid: RECORD_ID, currencyname: 'Source currency', isocurrencycode: 'SGD',
  }] });
  let calls = 0;
  const result = await applySeedData({ ...args, currencyCode: 'SGD' }, {
    token: 'test-token', makeRequest: async () => { calls++; return { statusCode: 204 }; },
  });
  assert.equal(result.ok, false);
  assert.equal(calls, 0);
  assert.match(result.errors[0].message, /existing target currency/);
});

test('currency bind with a wrong navigation collection fails before writes', async (t) => {
  const data = financialSeed();
  data.tables.invoices.records[0]['cr123_WrongCurrency@odata.bind'] = [`/transactioncurrencies(${CURRENCY_ID})`];
  const requests = [];
  const result = await applySeedData({ ...seedFixture(t, data), currencyCode: 'SGD' }, {
    token: 'test-token', makeRequest: currencyRequests(requests),
  });
  assert.equal(result.ok, false);
  assert.match(result.errors[0].message, /currency binding disagrees/);
  assert.ok(requests.every((r) => !r.method || r.method === 'GET'));
});

test('export normalization rejects malformed record objects rather than posting an empty replacement', async (t) => {
  let calls = 0;
  const result = await applySeedData(seedFixture(t, {
    tables: { contacts: { entitySet: 'contacts', idColumn: 'contactid', records: [null] } },
  }), { token: 'test-token', makeRequest: async () => { calls++; return { statusCode: 204 }; } });
  assert.equal(result.ok, false);
  assert.equal(calls, 0);
  assert.match(result.errors[0].message, /record must be an object/);
});

for (const filename of ['invoice|bad.pdf', 'invoice?.pdf', 'invoice%2fsecret.pdf', 'invoice%5csecret.pdf', 'invoice%00.pdf']) {
  test(`portable upload filename rejects ${filename}`, async (t) => {
    const data = attachmentSeed();
    data.records[0].cr123_file_name = filename;
    let calls = 0;
    const result = await applySeedData(seedFixture(t, data), {
      token: 'test-token', makeRequest: async () => { calls++; return { statusCode: 204 }; },
    });
    assert.equal(result.ok, false);
    assert.equal(calls, 0);
    assert.match(result.errors[0].message, /upload filename/);
  });
}

test('invalid metadata JSON cannot leak an echoed bearer token through parser diagnostics', async (t) => {
  const requests = [];
  const result = await planSeedData(seedFixture(t, financialSeed()), {
    token: 'private-bearer-token',
    makeRequest: currencyRequests(requests, () => ({ statusCode: 200, body: 'private-bearer-token invalid JSON' })),
  });
  assert.equal(result.ok, false);
  assert.match(result.errors[0].message, /invalid JSON/i);
  assert.ok(!JSON.stringify(result).includes('private-'));
});

test('file action invalid JSON reports no continuation secret from parser excerpts', async (t) => {
  const result = await applySeedData(seedFixture(t, attachmentSeed()), {
    token: 'test-token', makeRequest: async (req) => req.url.endsWith('/InitializeFileBlocksUpload')
      ? { statusCode: 200, body: 'private-continuation invalid JSON' } : { statusCode: 204 },
  });
  assert.equal(result.ok, false);
  assert.match(result.errors[0].message, /invalid JSON/i);
  assert.ok(!JSON.stringify(result).includes('private-'));
});

test('actual CLI plan argument failures emit parseable no-write JSON and remain best effort', () => {
  const { spawnSync } = require('child_process');
  const execution = spawnSync(process.execPath, [
    path.resolve(__dirname, '../apply-seed-data.js'), '--plan', '--currencyCode',
  ], { encoding: 'utf8', env: { ...process.env, POWER_PLATFORM_SKILLS_TELEMETRY_POWER_PAGES_OPTOUT: '1' }, shell: false });
  assert.equal(execution.status, 0);
  assert.equal(execution.stderr, '');
  const result = JSON.parse(execution.stdout);
  assert.equal(result.ok, false);
  assert.equal(result.writes, 0);
  assert.match(result.errors[0].message, /currencyCode.*value/);
});

test('apply-seed-data CLI parser and runner return best-effort summaries', async () => {
  assert.deepEqual(parseArgs(['--seedDir', '/tmp/seed', '--seedFile', '/tmp/seed/data.json', '--envUrl', 'https://org.crm.dynamics.com']), {
    seedDir: '/tmp/seed',
    seedFile: '/tmp/seed/data.json',
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
