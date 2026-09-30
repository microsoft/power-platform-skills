'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const {
  makePcfSdk,
  findCustomControl,
  listCustomControls,
  findForm,
  readFormXml,
  dependentsOf,
  formsContainingControl,
  solutionPrefix,
} = require('../lib/pcf-dataverse.js');

function fakeSdk({ rows = {}, gets = {} } = {}) {
  const calls = [];
  return {
    calls,
    queryRecords: async (table, options) => {
      calls.push({ table, options });
      const value = rows[table];
      return typeof value === 'function' ? value(options) : (value || []);
    },
    dataverse: {
      get: async (url) => {
        calls.push({ get: url });
        const value = gets[url];
        return typeof value === 'function' ? value(url) : value;
      },
    },
  };
}

function walkProductionPcfModules(root) {
  const files = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'tests' || entry.name === 'vendor') continue;
        visit(full);
      } else if (entry.isFile() && /^pcf-|^verify-pcf$|^lint-pcf$|^write-pcf-plan$/.test(path.basename(entry.name, '.js')) && entry.name.endsWith('.js')) {
        files.push(full);
      }
    }
  };
  visit(root);
  return files;
}

function stripJsComments(text) {
  return String(text || '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

test('makePcfSdk initializes the vendored SDK with the provided workspace and client', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcf-sdk-'));
  try {
    const httpClient = {
      get: async () => ({ status: 200, headers: {}, body: {} }),
      post: async () => ({ status: 204, headers: {}, body: {} }),
      patch: async () => ({ status: 204, headers: {}, body: {} }),
      put: async () => ({ status: 204, headers: {}, body: {} }),
      delete: async () => ({ status: 204, headers: {}, body: {} }),
    };

    const sdk = await makePcfSdk('https://contoso.crm.dynamics.com', dir, httpClient);

    assert.equal(typeof sdk.queryRecords, 'function');
    assert.equal(typeof sdk.dataverse.get, 'function');
    assert.equal(fs.existsSync(dir), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('findCustomControl queries customcontrol by escaped name and maps the row', async () => {
  const sdk = fakeSdk({
    rows: {
      customcontrol: [{
        customcontrolid: '11111111-1111-1111-1111-111111111111',
        name: "Contoso's Star",
        version: '1.2.3',
        componentstate: 0,
        ismanaged: false,
      }],
    },
  });

  const row = await findCustomControl(sdk, "Contoso's Star");

  assert.deepEqual(row, {
    id: '11111111-1111-1111-1111-111111111111',
    name: "Contoso's Star",
    version: '1.2.3',
    componentState: 0,
    isManaged: false,
  });
  assert.deepEqual(sdk.calls, [{
    table: 'customcontrol',
    options: {
      select: ['customcontrolid', 'name', 'version', 'componentstate', 'ismanaged'],
      filter: "name eq 'Contoso''s Star'",
      top: 2,
    },
  }]);
});

test('findCustomControl returns null for no rows and errors on duplicates', async () => {
  assert.equal(await findCustomControl(fakeSdk({ rows: { customcontrol: [] } }), 'Missing'), null);
  await assert.rejects(
    findCustomControl(fakeSdk({ rows: { customcontrol: [{ customcontrolid: '1' }, { customcontrolid: '2' }] } }), 'Dup'),
    /More than one custom control named 'Dup'/,
  );
});

test('listCustomControls paginates and excludes managed controls by default', async () => {
  const sdk = fakeSdk({ rows: { customcontrol: [{ customcontrolid: '1' }] } });
  const rows = await listCustomControls(sdk, {});

  assert.deepEqual(rows, [{ id: '1', name: undefined, version: undefined, componentState: undefined, isManaged: undefined }]);
  assert.deepEqual(sdk.calls[0], {
    table: 'customcontrol',
    options: {
      select: ['customcontrolid', 'name', 'version', 'componentstate', 'ismanaged'],
      filter: 'ismanaged eq false',
      paginate: true,
    },
  });
});

test('listCustomControls can include managed controls without adding a top cap', async () => {
  const sdk = fakeSdk({ rows: { customcontrol: [] } });
  await listCustomControls(sdk, { includeManaged: true });

  assert.deepEqual(sdk.calls[0], {
    table: 'customcontrol',
    options: {
      select: ['customcontrolid', 'name', 'version', 'componentstate', 'ismanaged'],
      paginate: true,
    },
  });
});

test('findForm resolves by table, form name, and types', async () => {
  const sdk = fakeSdk({
    rows: {
      systemform: [{ formid: '22222222-2222-2222-2222-222222222222', name: 'Main', type: 2 }],
    },
  });

  const row = await findForm(sdk, { table: 'account', form: "Maker's Main", types: [2, 7] });

  assert.deepEqual(row, { formid: '22222222-2222-2222-2222-222222222222', name: 'Main', type: 2 });
  assert.deepEqual(sdk.calls[0], {
    table: 'systemform',
    options: {
      select: ['formid', 'name', 'type'],
      filter: "objecttypecode eq 'account' and (type eq 2 or type eq 7) and name eq 'Maker''s Main'",
      paginate: true,
    },
  });
});

test('PCF production modules do not build OData filters with the unsupported in operator', () => {
  const scriptsRoot = path.join(__dirname, '..');
  const offenders = walkProductionPcfModules(scriptsRoot)
    .filter((file) => /\bin\s*\(/.test(stripJsComments(fs.readFileSync(file, 'utf8'))))
    .map((file) => path.relative(scriptsRoot, file));

  assert.deepEqual(offenders, []);
});

test('findForm resolves by GUID and reports zero or several matches with candidates', async () => {
  const id = '22222222-2222-2222-2222-222222222222';
  const byId = fakeSdk({ rows: { systemform: [{ formid: id, name: 'Main', type: 2 }] } });
  assert.deepEqual(await findForm(byId, { table: 'account', form: id }), { formid: id, name: 'Main', type: 2 });
  assert.match(byId.calls[0].options.filter, /formid eq 22222222-2222-2222-2222-222222222222/);

  await assert.rejects(findForm(fakeSdk({ rows: { systemform: [] } }), { table: 'account', form: 'Missing' }), /No form matched/);
  await assert.rejects(
    findForm(fakeSdk({ rows: { systemform: [{ formid: '1', name: 'Main', type: 2 }, { formid: '2', name: 'Main Copy', type: 2 }] } }), { table: 'account', form: 'Main' }),
    /Several forms matched.*Main.*Main Copy/s,
  );
});

test('readFormXml reads draft and published layers with explicit status checks', async () => {
  const formId = '22222222-2222-2222-2222-222222222222';
  const sdk = fakeSdk({
    gets: {
      [`/systemforms(${formId})/Microsoft.Dynamics.CRM.RetrieveUnpublished()?$select=formxml`]: { status: 200, body: { formxml: '<draft />' } },
      [`/systemforms(${formId})?$select=formxml`]: { status: 200, body: { formxml: '<published />' } },
    },
  });

  assert.equal(await readFormXml(sdk, formId, { layer: 'draft' }), '<draft />');
  assert.equal(await readFormXml(sdk, formId, { layer: 'published' }), '<published />');
  assert.deepEqual(sdk.calls.map((c) => c.get), [
    `/systemforms(${formId})/Microsoft.Dynamics.CRM.RetrieveUnpublished()?$select=formxml`,
    `/systemforms(${formId})?$select=formxml`,
  ]);

  await assert.rejects(readFormXml(fakeSdk({ gets: { [`/systemforms(${formId})?$select=formxml`]: { status: 404, body: {} } } }), formId, { layer: 'published' }), /HTTP 404/);
});

test('readFormXml rejects unsupported layers instead of falling back to published', async () => {
  await assert.rejects(
    readFormXml(fakeSdk(), '22222222-2222-2222-2222-222222222222', { layer: 'preview' }),
    /Unsupported FormXML layer 'preview'/,
  );
});

test('dependentsOf returns rows on 2xx and ok:false on failures', async () => {
  const controlId = '33333333-3333-3333-3333-333333333333';
  const path = `/RetrieveDependentComponents(ObjectId=@o,ComponentType=@t)?@o=${controlId}&@t=66`;
  const sdk = fakeSdk({
    gets: {
      [path]: { status: 200, body: { value: [{ dependentcomponenttype: 60, dependentcomponentobjectid: '44444444-4444-4444-4444-444444444444', dependencytype: 2 }] } },
    },
  });

  assert.deepEqual(await dependentsOf(sdk, controlId), { ok: true, rows: [{ type: 60, objectId: '44444444-4444-4444-4444-444444444444' }] });
  assert.deepEqual(sdk.calls, [{ get: path }]);
  assert.deepEqual(await dependentsOf(fakeSdk({ gets: { [path]: { status: 500, body: { error: { message: 'boom' } } } } }), controlId), { ok: false, reason: 'HTTP 500: boom' });
});

test('formsContainingControl uses contains fallback with ok/reason shape', async () => {
  const sdk = fakeSdk({ rows: { systemform: [{ formid: '1', name: 'Main' }] } });

  assert.deepEqual(await formsContainingControl(sdk, "Contoso's Star"), { ok: true, rows: [{ formid: '1', name: 'Main' }] });
  assert.deepEqual(sdk.calls[0], {
    table: 'systemform',
    options: {
      select: ['formid', 'name'],
      filter: "contains(formxml,'Contoso''s Star')",
      paginate: true,
    },
  });
  assert.equal((await formsContainingControl({ queryRecords: async () => { throw new Error('no permission'); } }, 'Star')).ok, false);
});

test('solutionPrefix resolves unmanaged solution publisher prefix', async () => {
  const sdk = fakeSdk({
    rows: {
      solution: [{ solutionid: 's1', _publisherid_value: 'p1', ismanaged: false }],
      publisher: [{ publisherid: 'p1', customizationprefix: 'new' }],
    },
  });

  assert.equal(await solutionPrefix(sdk, 'contoso_core'), 'new');
  assert.deepEqual(sdk.calls, [
    {
      table: 'solution',
      options: {
        select: ['solutionid', '_publisherid_value', 'ismanaged'],
        filter: "uniquename eq 'contoso_core'",
        top: 2,
      },
    },
    {
      table: 'publisher',
      options: {
        select: ['publisherid', 'customizationprefix'],
        filter: 'publisherid eq p1',
        top: 1,
      },
    },
  ]);
});

test('solutionPrefix reports missing, duplicate, managed, and publisher failures', async () => {
  await assert.rejects(solutionPrefix(fakeSdk({ rows: { solution: [] } }), 'missing'), /Solution 'missing' was not found/);
  await assert.rejects(solutionPrefix(fakeSdk({ rows: { solution: [{}, {}] } }), 'dup'), /More than one solution/);
  await assert.rejects(solutionPrefix(fakeSdk({ rows: { solution: [{ _publisherid_value: 'p1', ismanaged: true }] } }), 'managed'), /managed solution/);
  await assert.rejects(solutionPrefix(fakeSdk({ rows: { solution: [{ _publisherid_value: 'p1', ismanaged: false }], publisher: [] } }), 'nopub'), /publisher.*could not be resolved/);
});
