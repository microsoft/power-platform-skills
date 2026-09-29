'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadCli } = require('./helpers/cli-harness.js');

const scriptPath = path.join(__dirname, '..', 'pcf-inventory.js');
const bundlePath = path.join(__dirname, '..', 'vendor', 'cds-maker-sdk.cjs');
const workspaceDirs = [];

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

test.after(() => {
  for (const dir of workspaceDirs) fs.rmSync(dir, { recursive: true, force: true });
});

test('pcf-inventory excludes managed and first-party controls by default, and --include-managed lifts both filters', async () => {
  const calls = [];
  const rows = [
    { id: '11111111-1111-4111-8111-111111111111', name: 'new_Contoso.Controls.StarRating', version: '1.0.0', componentState: 0, isManaged: false },
    { id: '22222222-2222-4222-8222-222222222222', name: 'MscrmControls.Field.TextBox', version: '9.0.0', componentState: 0, isManaged: false },
    { id: '33333333-3333-4333-8333-333333333333', name: 'Microsoft.Controls.Grid', version: '9.0.0', componentState: 0, isManaged: false },
    { id: '44444444-4444-4444-8444-444444444444', name: 'managed_Contoso.Controls.Meter', version: '2.0.0', componentState: 0, isManaged: true },
  ];
  const stubs = {
    './lib/pcf-dataverse': {
      WHERE_USED_CAVEAT: 'registered solution dependencies only — not proof of Liquid or text references; an empty result is not \'safe to delete\'',
      makePcfSdk: async (env, workspace) => {
        calls.push(['makePcfSdk', env, workspace]);
        return { tag: 'sdk' };
      },
      listCustomControls: async (sdk, opts) => {
        calls.push(['listCustomControls', sdk, opts]);
        return rows;
      },
      findCustomControl: async () => { throw new Error('findCustomControl should not be used'); },
      dependentsOf: async () => { throw new Error('dependentsOf should not be used'); },
    },
  };

  const defaultCli = await run(['--env', 'https://contoso.crm.dynamics.com', '--workspace', 'D:\\scratch\\inventory'], stubs);
  assert.equal(defaultCli.exitCode, 0);
  assert.deepEqual(JSON.parse(defaultCli.stdoutText()).controls.map((row) => row.name), ['new_Contoso.Controls.StarRating']);
  assert.deepEqual(calls.find((call) => call[0] === 'listCustomControls')[2], { includeManaged: false });

  calls.length = 0;
  const managedCli = await run(['--env', 'https://contoso.crm.dynamics.com', '--include-managed'], stubs);
  assert.equal(managedCli.exitCode, 0);
  assert.deepEqual(JSON.parse(managedCli.stdoutText()).controls.map((row) => row.name), rows.map((row) => row.name));
  assert.deepEqual(calls.find((call) => call[0] === 'listCustomControls')[2], { includeManaged: true });
});

test('pcf-inventory reports where-used read failures as unknown and emits the shared caveat once', async () => {
  const caveat = 'registered solution dependencies only — not proof of Liquid or text references; an empty result is not \'safe to delete\'';
  const stubs = {
    './lib/pcf-dataverse': {
      WHERE_USED_CAVEAT: caveat,
      makePcfSdk: async () => ({ tag: 'sdk' }),
      listCustomControls: async () => [{
        id: '11111111-1111-4111-8111-111111111111',
        name: 'new_Contoso.Controls.StarRating',
        version: '1.0.0',
        componentState: 0,
        isManaged: false,
      }],
      dependentsOf: async () => ({ ok: false, reason: 'HTTP 403: access denied' }),
    },
  };

  const cli = await run(['--env', 'https://contoso.crm.dynamics.com', '--where-used'], stubs);

  assert.equal(cli.exitCode, 0);
  const payload = JSON.parse(cli.stdoutText());
  assert.equal(payload.ok, true);
  assert.equal(payload.whereUsedCaveat, caveat);
  assert.equal(payload.controls.length, 1);
  assert.deepEqual(payload.controls[0].whereUsed, { ok: false, reason: 'HTTP 403: access denied' });
  assert.equal(Object.prototype.hasOwnProperty.call(payload.controls[0], 'whereUsedCaveat'), false);
});

test('pcf-inventory surfaces documented RetrieveDependentComponents dependency rows', async () => {
  const caveat = 'registered solution dependencies only — not proof of Liquid or text references; an empty result is not \'safe to delete\'';
  const stubs = {
    './lib/pcf-dataverse': {
      WHERE_USED_CAVEAT: caveat,
      makePcfSdk: async () => ({ tag: 'sdk' }),
      listCustomControls: async () => [{
        id: '11111111-1111-4111-8111-111111111111',
        name: 'new_Contoso.Controls.StarRating',
        version: '1.0.0',
        componentState: 0,
        isManaged: false,
      }],
      dependentsOf: async () => ({
        ok: true,
        rows: [{ type: 60, objectId: '22222222-2222-4222-8222-222222222222' }],
      }),
    },
  };

  const cli = await run(['--env', 'https://contoso.crm.dynamics.com', '--where-used'], stubs);

  assert.equal(cli.exitCode, 0);
  const payload = JSON.parse(cli.stdoutText());
  assert.deepEqual(payload.controls[0].whereUsed.rows, [{ type: 60, objectId: '22222222-2222-4222-8222-222222222222' }]);
});

test('pcf-inventory --control queries the exact name and fails with a prefixed-name hint when absent', async () => {
  let queried = null;
  const caveat = 'registered solution dependencies only — not proof of Liquid or text references; an empty result is not \'safe to delete\'';
  const stubs = {
    './lib/pcf-dataverse': {
      WHERE_USED_CAVEAT: caveat,
      makePcfSdk: async () => ({ tag: 'sdk' }),
      findCustomControl: async (sdk, name) => {
        queried = name;
        return null;
      },
      listCustomControls: async () => { throw new Error('listCustomControls should not be used'); },
      dependentsOf: async () => { throw new Error('dependentsOf should not be used'); },
    },
  };

  const cli = await run(['--env', 'https://contoso.crm.dynamics.com', '--where-used', '--control', 'Contoso.Controls.StarRating'], stubs);

  assert.equal(cli.exitCode, 1);
  assert.equal(queried, 'Contoso.Controls.StarRating');
  const payload = JSON.parse(cli.stdoutText());
  assert.equal(payload.ok, false);
  assert.equal(payload.whereUsedCaveat, caveat);
  assert.match(payload.error, /No PCF custom control named 'Contoso\.Controls\.StarRating'/);
  assert.match(payload.error, /<publisherPrefix>_Contoso\.Controls\.StarRating/);
});

test('pcf-inventory rejects values on boolean flags before creating an SDK', async () => {
  let madeSdk = false;
  const stubs = {
    './lib/pcf-dataverse': {
      WHERE_USED_CAVEAT: 'caveat',
      makePcfSdk: async () => { madeSdk = true; },
      listCustomControls: async () => [],
      findCustomControl: async () => null,
      dependentsOf: async () => ({ ok: true, rows: [] }),
    },
  };

  for (const flag of ['--where-used=false', '--include-managed=false']) {
    madeSdk = false;
    const cli = await run(['--env', 'https://contoso.crm.dynamics.com', flag], stubs);

    assert.equal(cli.exitCode, 1);
    assert.equal(madeSdk, false);
    assert.equal(cli.stdoutText(), '');
    assert.match(cli.stderrText(), /Usage:/);
    assert.match(cli.stderrText(), new RegExp(`${flag.split('=')[0]} does not take a value`));
  }
});

test('pcf-inventory output includes controls from every SDK-paginated customcontrol page', async () => {
  const { createMakerSdk, createNodeWorkspaceStorage } = require(bundlePath);
  const workspace = fs.mkdtempSync(path.join(__dirname, 'pcf-inventory-workspace-'));
  workspaceDirs.push(workspace);
  const reads = [];
  const httpClient = {
    get: async (url) => {
      reads.push(String(url));
      const text = String(url);
      if (/EntityDefinitions\(LogicalName='customcontrol'\)/i.test(text)) {
        return { status: 200, headers: {}, body: { EntitySetName: 'customcontrols', LogicalName: 'customcontrol' } };
      }
      if (/\/customcontrols\?/i.test(text) && !/\$skiptoken=page2/i.test(text)) {
        return {
          status: 200,
          headers: {},
          body: {
            value: [{
              customcontrolid: '11111111-1111-4111-8111-111111111111',
              name: 'new_Contoso.Controls.First',
              version: '1.0.0',
              componentstate: 0,
              ismanaged: false,
            }],
            '@odata.nextLink': 'https://contoso.crm.dynamics.com/api/data/v9.0/customcontrols?$skiptoken=page2',
          },
        };
      }
      if (/\/customcontrols\?/i.test(text) && /\$skiptoken=page2/i.test(text)) {
        return {
          status: 200,
          headers: {},
          body: {
            value: [{
              customcontrolid: '22222222-2222-4222-8222-222222222222',
              name: 'new_Contoso.Controls.Second',
              version: '1.0.1',
              componentstate: 0,
              ismanaged: false,
            }],
          },
        };
      }
      return { status: 200, headers: {}, body: {} };
    },
    post: async () => ({ status: 204, headers: {}, body: {} }),
    patch: async () => ({ status: 204, headers: {}, body: {} }),
    put: async () => ({ status: 204, headers: {}, body: {} }),
    delete: async () => ({ status: 204, headers: {}, body: {} }),
  };

  const stubs = {
    './lib/pcf-dataverse': {
      ...require('../lib/pcf-dataverse.js'),
      makePcfSdk: async (env) => {
        const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(workspace), instanceUrl: env, httpClient });
        await sdk.initWorkspace();
        return sdk;
      },
    },
  };

  const cli = await run(['--env', 'https://contoso.crm.dynamics.com'], stubs);

  assert.equal(cli.exitCode, 0);
  const payload = JSON.parse(cli.stdoutText());
  assert.deepEqual(payload.controls.map((row) => row.name), ['new_Contoso.Controls.First', 'new_Contoso.Controls.Second']);
  assert.ok(reads.some((url) => /\$skiptoken=page2/.test(url)), 'the fake second page was requested through the real SDK');
});
