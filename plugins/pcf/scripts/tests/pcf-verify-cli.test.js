'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadCli } = require('./helpers/cli-harness.js');

const scriptPath = path.join(__dirname, '..', 'verify-pcf.js');
const evalFixtureRoot = path.join(__dirname, '..', '..', '..', '..', 'evals', 'pcf', 'fixtures');

async function run(argv, stubs) {
  const cli = loadCli(scriptPath, { argv, requires: stubs });
  assert.equal(typeof cli.main, 'function');
  try {
    await cli.main();
  } catch (err) {
    if (!String(err && err.message).startsWith('process.exit(')) throw err;
  }
  return cli;
}

test('verify-pcf reports a registered control separately from draft-only binding evidence', async () => {
  const calls = [];
  const stubs = {
    './lib/pcf-dataverse': {
      makePcfSdk: async (env, workspace) => {
        calls.push(['makePcfSdk', env, workspace]);
        return { tag: 'sdk' };
      },
      findCustomControl: async (sdk, name) => {
        calls.push(['findCustomControl', sdk, name]);
        return { id: '11111111-1111-4111-8111-111111111111', name, version: '1.2.3', componentState: 0 };
      },
      findForm: async (sdk, query) => {
        calls.push(['findForm', sdk, query]);
        return { formid: '22222222-2222-4222-8222-222222222222', name: 'Main' };
      },
      readFormXml: async (sdk, formId, opts) => {
        calls.push(['readFormXml', sdk, formId, opts]);
        return opts.layer === 'draft' ? '<draft />' : '<published />';
      },
    },
    './lib/pcf-binding-verify': {
      verifyBinding: (formxml, expected) => {
        calls.push(['verifyBinding', formxml, expected]);
        if (formxml === '<draft />') return { ok: true, status: 'bound', issues: [], cells: [] };
        return {
          ok: false,
          status: 'not-bound',
          issues: [{ code: 'PCF_BIND_CLIENT_MISSING', level: 'error', message: 'web is not bound' }],
          cells: [],
        };
      },
    },
  };

  const cli = await run([
    '--env', 'https://contoso.crm.dynamics.com',
    '--control', 'new_Contoso.Controls.StarRating',
    '--version', '1.2.3',
    '--table', 'new_review',
    '--form', 'Main',
    '--column', 'new_rating',
    '--clients', 'web,phone',
    '--workspace', 'D:\\tmp\\pcf-workspace',
    '--param', 'value=column:new_rating',
    '--param', 'max=static:5:Whole.None',
  ], stubs);

  assert.equal(cli.exitCode, 1);
  const payload = JSON.parse(cli.stdoutText());
  assert.equal(payload.ok, false);
  assert.deepEqual(payload.control.registered, { ok: true, version: '1.2.3', expected: '1.2.3', componentState: 0 });
  assert.equal(payload.bindings.length, 1);
  assert.equal(payload.bindings[0].draft.status, 'bound');
  assert.equal(payload.bindings[0].published.status, 'not-bound');
  assert.match(payload.bindings[0].message, /bound but not published/i);
  assert.equal(payload.runtime, 'not-checked');

  const verifyCalls = calls.filter((call) => call[0] === 'verifyBinding');
  assert.deepEqual(verifyCalls.map((call) => call[1]), ['<draft />', '<published />']);
  assert.deepEqual(verifyCalls[0][2].clients, ['web', 'phone']);
  assert.deepEqual(verifyCalls[0][2].parameters, {
    value: { column: 'new_rating' },
    max: { static: '5', type: 'Whole.None' },
  });
});

test('verify-pcf usage errors print usage and do not create an SDK', async () => {
  let madeSdk = false;
  const cli = await run(['--env', 'https://contoso.crm.dynamics.com', '--control', 'new_Contoso.Controls.StarRating', '--table', 'new_review', '--form', 'Main'], {
    './lib/pcf-dataverse': {
      makePcfSdk: async () => { madeSdk = true; },
    },
    './lib/pcf-binding-verify': { verifyBinding: () => ({ ok: true, status: 'bound', issues: [], cells: [] }) },
  });

  assert.equal(cli.exitCode, 1);
  assert.match(cli.stderrText(), /Usage:/);
  assert.match(cli.stderrText(), /--column or --control-id is required/);
  assert.equal(madeSdk, false);
  assert.equal(cli.stdoutText(), '');
});

test('verify-pcf rejects unknown --clients values before creating an SDK', async () => {
  let madeSdk = false;
  const cli = await run([
    '--env', 'https://contoso.crm.dynamics.com',
    '--control', 'new_Contoso.Controls.StarRating',
    '--table', 'new_review',
    '--form', 'Main',
    '--column', 'new_rating',
    '--clients', 'web,console',
  ], {
    './lib/pcf-dataverse': {
      makePcfSdk: async () => { madeSdk = true; },
    },
    './lib/pcf-binding-verify': { verifyBinding: () => ({ ok: true, status: 'bound', issues: [], cells: [] }) },
    });

    assert.equal(cli.exitCode, 1);
    assert.match(cli.stderrText(), /--clients contains unknown value 'console'/);
    assert.match(cli.stderrText(), /web,phone,tablet/);
  assert.equal(madeSdk, false);
  assert.equal(cli.stdoutText(), '');
});

test('verify-pcf rejects intent bindings whose client list normalizes to empty before creating an SDK', async () => {
  let madeSdk = false;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcf-verify-empty-clients-'));
  const intentPath = path.join(dir, 'pcf-intent.json');
  fs.writeFileSync(intentPath, JSON.stringify({
    schemaVersion: 1,
    component: { namespace: 'Contoso.Controls', name: 'StarRating', type: 'field' },
    bindings: [{
      table: 'new_review',
      form: 'Main',
      target: { column: 'new_rating' },
      clients: [' '],
    }],
  }));
  try {
    const cli = await run([
      '--env', 'https://contoso.crm.dynamics.com',
      '--control', 'new_Contoso.Controls.StarRating',
      '--intent', `@${intentPath}`,
    ], {
      './lib/pcf-dataverse': {
        makePcfSdk: async () => { madeSdk = true; },
      },
      './lib/pcf-binding-verify': { verifyBinding: () => ({ ok: true, status: 'bound', issues: [], cells: [] }) },
    });

    assert.equal(cli.exitCode, 1);
    assert.match(cli.stderrText(), /intent binding clients must include at least one of: web,phone,tablet/);
    assert.equal(madeSdk, false);
    assert.equal(cli.stdoutText(), '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('verify-pcf validates every repeated --param before creating an SDK', async () => {
  let madeSdk = false;
  const cli = await run([
    '--env', 'https://contoso.crm.dynamics.com',
    '--control', 'new_Contoso.Controls.StarRating',
    '--table', 'new_review',
    '--form', 'Main',
    '--column', 'new_rating',
    '--param', 'not-a-param',
    '--param', 'value=column:new_rating',
  ], {
    './lib/pcf-dataverse': {
      makePcfSdk: async () => { madeSdk = true; },
    },
    './lib/pcf-binding-verify': { verifyBinding: () => ({ ok: true, status: 'bound', issues: [], cells: [] }) },
  });

  assert.equal(cli.exitCode, 1);
  assert.match(cli.stderrText(), /invalid --param 'not-a-param'/);
  assert.equal(madeSdk, false);
  assert.equal(cli.stdoutText(), '');
});

test('verify-pcf emits JSON on operational form-read failures', async () => {
  const stubs = {
    './lib/pcf-dataverse': {
      makePcfSdk: async () => ({ tag: 'sdk' }),
      findCustomControl: async (sdk, name) => ({ name, version: '1.2.3', componentState: 0 }),
      findForm: async () => {
        throw new Error('No form matched');
      },
    },
    './lib/pcf-binding-verify': {
      verifyBinding: () => ({ ok: true, status: 'bound', issues: [], cells: [] }),
    },
  };

  const cli = await run([
    '--env', 'https://contoso.crm.dynamics.com',
    '--control', 'new_Contoso.Controls.StarRating',
    '--version', '1.2.3',
    '--table', 'new_review',
    '--form', 'Missing',
    '--column', 'new_rating',
  ], stubs);

  assert.equal(cli.exitCode, 1);
  const payload = JSON.parse(cli.stdoutText());
  assert.equal(payload.ok, false);
  assert.equal(payload.control.registered.ok, true);
  assert.equal(payload.error, 'No form matched');
  assert.deepEqual(payload.bindings, []);
  assert.equal(payload.runtime, 'not-checked');
});

test('verify-pcf reads canonical intent target.column bindings and reaches FormXML verification', async () => {
  const calls = [];
  const stubs = {
    './lib/pcf-dataverse': {
      makePcfSdk: async () => ({ tag: 'sdk' }),
      findCustomControl: async (sdk, name) => ({ name, version: '1.0.0', componentState: 0 }),
      findForm: async (sdk, query) => {
        calls.push(['findForm', query]);
        return { formid: '22222222-2222-4222-8222-222222222222', name: query.form };
      },
      readFormXml: async (sdk, formId, opts) => `<${opts.layer} />`,
    },
    './lib/pcf-binding-verify': {
      verifyBinding: (formxml, expected) => {
        calls.push(['verifyBinding', formxml, expected]);
        return { ok: true, status: 'bound', issues: [], cells: [] };
      },
    },
  };

  const cli = await run([
    '--env', 'https://contoso.crm.dynamics.com',
    '--control', 'new_Contoso.Controls.StarRating',
    '--intent', `@${path.join(evalFixtureRoot, '001-intent-field-clean', 'pcf-intent.json')}`,
  ], stubs);

  assert.equal(cli.exitCode, 0);
  assert.deepEqual(calls.find((call) => call[0] === 'findForm')[1], { table: 'account', form: 'Account' });
  assert.equal(calls.find((call) => call[0] === 'verifyBinding')[2].column, 'new_rating');
  assert.deepEqual(JSON.parse(cli.stdoutText()).bindings[0].target, { column: 'new_rating' });
});

test('verify-pcf reads canonical intent target.controlId dataset-subgrid bindings', async () => {
  const calls = [];
  const stubs = {
    './lib/pcf-dataverse': {
      makePcfSdk: async () => ({ tag: 'sdk' }),
      findCustomControl: async (sdk, name) => ({ name, version: '1.0.0', componentState: 0 }),
      findForm: async (sdk, query) => {
        calls.push(['findForm', query]);
        return { formid: '33333333-3333-4333-8333-333333333333', name: query.form };
      },
      readFormXml: async (sdk, formId, opts) => `<${opts.layer} />`,
    },
    './lib/pcf-binding-verify': {
      verifyBinding: (formxml, expected) => {
        calls.push(['verifyBinding', formxml, expected]);
        return { ok: true, status: 'bound', issues: [], cells: [] };
      },
    },
  };

  const cli = await run([
    '--env', 'https://contoso.crm.dynamics.com',
    '--control', 'new_Contoso.Controls.StarRating',
    '--intent', `@${path.join(evalFixtureRoot, '003-intent-quickcreate-subgrid', 'pcf-intent.json')}`,
  ], stubs);

  assert.equal(cli.exitCode, 0);
  const verifyExpected = calls.find((call) => call[0] === 'verifyBinding')[2];
  assert.equal(verifyExpected.kind, 'dataset-subgrid');
  assert.equal(verifyExpected.controlId, 'Contacts');
  assert.deepEqual(JSON.parse(cli.stdoutText()).bindings[0].target, { controlId: 'Contacts' });
});
