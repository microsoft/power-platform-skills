'use strict';
// The data-model phase's 2.21.0 schema work driven through the REAL vendored SDK over a recording HTTP client: what reaches the wire
// for a declared secured column the build could not see, and for the Date and Time preflight. The doubles in
// schema-features-provision.test.js pin the decisions; these pin that the SDK's requests and answers carry them.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const { makeRunner, provisionDataModel } = require('../lib/entity-provision.js');

const BUNDLE = path.resolve(__dirname, '..', 'vendor', 'cds-maker-sdk.cjs');
const ORIGIN = 'https://contoso.crm.dynamics.com';

// `route(verb, path, body)` answers a request by its decoded path below the API root (e.g. `/EntityDefinitions(...)`), or returns
// undefined for a 404. Every request is recorded as `[VERB, path, body]`.
function realSdk(route) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-real-'));
  const requests = [];
  const handle = (verb) => async (url, body) => {
    const u = new URL(url);
    const p = decodeURIComponent(u.pathname + u.search).replace(/^\/api\/data\/v9\.\d+/, '');
    requests.push([verb, p, body]);
    return (await route(verb, p, body)) || { status: 404, headers: {}, body: { error: { code: '0x80060888', message: 'Not found' } } };
  };
  const B = require(BUNDLE);
  const sdk = B.createMakerSdk({
    workspaceStorage: B.createNodeWorkspaceStorage(dir),
    instanceUrl: ORIGIN,
    httpClient: { get: handle('GET'), post: handle('POST'), put: handle('PUT'), patch: handle('PATCH'), delete: handle('DELETE') },
  });
  return { sdk, requests, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const specOf = (columns) => ({
  solution: { uniqueName: 'S', publisherPrefix: 'new' },
  entities: [{ schemaName: 'new_ticket', displayName: 'Ticket', primaryAttribute: { schemaName: 'new_name' }, columns }],
  relationships: [],
});

async function provision(r, spec, opts = {}) {
  await r.sdk.initWorkspace();
  return provisionDataModel(Object.assign({
    sdk: r.sdk, provision: r.sdk, runner: makeRunner({ emit: () => {}, total: 50 }), spec, apply: true, preResolvedLanguageCode: 1033,
    warn: () => {}, inlineColumns: false,
  }, opts));
}

const ok = (body, headers = {}) => ({ status: 200, headers, body });
const TABLE = ok({ LogicalName: 'new_ticket', EntitySetName: 'new_tickets', MetadataId: '66666666-6666-6666-6666-666666666666' });
const SALARY = {
  '@odata.type': '#Microsoft.Dynamics.CRM.StringAttributeMetadata',
  MetadataId: '77777777-7777-7777-7777-777777777777',
  LogicalName: 'new_salary',
  SchemaName: 'new_salary',
  AttributeType: 'String',
  IsSecured: false,
  MaxLength: 100,
};

// ------------------------------------------------------------------------------------------------ a secured column the build could not see

test('REAL BUNDLE: a declared secured column whose columns read failed and whose create is answered "already exists" is secured', async () => {
  for (const securityRead of [ok({ value: [{ LogicalName: 'new_salary', IsSecured: false }] }), { status: 500, headers: {}, body: {} }]) {
    let put = null;
    const r = realSdk((verb, p, body) => {
      if (verb === 'GET' && /^\/EntityDefinitions\(LogicalName='new_ticket'\)\?\$select=LogicalName,EntitySetName/.test(p)) return TABLE;
      if (verb === 'GET' && p.endsWith('/Attributes?$select=LogicalName,RequiredLevel')) return { status: 500, headers: {}, body: {} };
      if (verb === 'GET' && p.endsWith('/Attributes?$select=LogicalName,IsSecured')) return securityRead;
      if (verb === 'GET' && /\/Attributes\((?:LogicalName='new_salary'|77777777-[0-9-]+)\)/.test(p)) return ok({ ...SALARY, IsSecured: put ? put.IsSecured : false });
      if (verb === 'POST' && /\/Attributes$/.test(p)) return { status: 400, headers: {}, body: { error: { code: '0x80047013', message: 'Attribute new_salary already exists.' } } };
      if (verb === 'PUT' && /\/Attributes\(/.test(p)) { put = body; return { status: 204, headers: {}, body: {} }; }
      return undefined;
    });
    try {
      await provision(r, specOf([{ schemaName: 'new_salary', displayName: 'Salary', type: 'Text', isSecured: true }]));
      assert.ok(put, `no secure write was sent: ${JSON.stringify(r.requests.map((x) => x.slice(0, 2)))}`);
      assert.equal(put.IsSecured, true);
      assert.equal(r.requests.filter((x) => x[1].endsWith('$select=LogicalName,IsSecured')).length, 1);
    } finally {
      r.cleanup();
    }
  }
});

// ------------------------------------------------------------------------------------------------ column types from the existing read

test('REAL BUNDLE: the findColumns rows verification already reads carry the type the column-type check needs, with no other request', async () => {
  const { columnTypeChecks } = require('../lib/schema-feature-contract.js');
  const r = realSdk((verb, p) => {
    if (verb === 'GET' && /\/Attributes\?\$select=LogicalName,SchemaName,DisplayName,AttributeType,IsCustomAttribute$/.test(p)) {
      return ok({ value: [
        { LogicalName: 'new_amount', SchemaName: 'new_Amount', DisplayName: { UserLocalizedLabel: { Label: 'Amount' } }, AttributeType: 'Money', IsCustomAttribute: true },
        { LogicalName: 'new_photo', SchemaName: 'new_Photo', DisplayName: { UserLocalizedLabel: { Label: 'Photo' } }, AttributeType: 'Virtual', IsCustomAttribute: true },
        { LogicalName: 'new_odd', SchemaName: 'new_Odd', DisplayName: { UserLocalizedLabel: { Label: 'Odd' } }, IsCustomAttribute: true },
      ] });
    }
    return undefined;
  });
  try {
    await r.sdk.initWorkspace();
    const rows = await r.sdk.findColumns('new_ticket');
    const entity = { schemaName: 'new_ticket', columns: [{ schemaName: 'new_amount', type: 'Decimal' }, { schemaName: 'new_photo', type: 'Image' }, { schemaName: 'new_odd', type: 'Integer' }] };
    assert.deepEqual(columnTypeChecks(entity, rows), {
      failed: [{ name: 'new_ticket.new_amount', detail: 'declared Decimal, deployed Money: a column\'s type cannot be changed in place' }],
      unverified: ['column-type:new_ticket.new_odd (declared Integer; the deployed type was not stated by the read)'],
    });
    assert.deepEqual(r.requests.map((x) => x[0]), ['GET']);
  } finally {
    r.cleanup();
  }
});