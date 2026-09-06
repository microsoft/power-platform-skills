'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { PHASE_ORDER, sha256, stableJson } = require('../build-dataverse-operation-manifest');
const {
  generateDataverseServices,
  verifyGeneratedServices,
} = require('../generate-dataverse-services');

const ENVIRONMENT_URL = 'https://example.crm.dynamics.com';

function manifest(names = ['new_asset', 'new_service']) {
  const value = {
    executable: true,
    binding: {
      environmentUrl: ENVIRONMENT_URL,
      tenantId: 'tenant-1',
      solutionUniqueName: 'Default',
      reconciliationSha256: 'b'.repeat(64),
    },
    execution: {
      executor: 'BATCH-METADATA',
      parallelWrites: false,
      odataBatch: false,
      phases: PHASE_ORDER.map((name) => ({ name, operations: [] })),
    },
    service: {
      requiredTables: names.map((logicalName) => ({ logicalName, consumers: ['screen:home'] })),
    },
  };
  value.integritySha256 = sha256(stableJson(value));
  return value;
}

function project(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dataverse-services-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src', 'generated', 'services'), { recursive: true });
  return root;
}

function writeOutputs(root, completed) {
  fs.writeFileSync(path.join(root, 'power.config.json'), JSON.stringify({
    databaseReferences: {
      default: {
        cds: {
          dataSources: Object.fromEntries(completed.map((logicalName) => [logicalName, {
            logicalName,
            entitySetName: `${logicalName}s`,
          }])),
        },
      },
    },
  }));
  for (const logicalName of completed) {
    fs.writeFileSync(
      path.join(root, 'src', 'generated', 'services', `${logicalName}sService.ts`),
      'export {};\n',
    );
  }
}

test('generates exactly the manifest-required services sequentially', (context) => {
  const root = project(context);
  const completed = [];
  const calls = [];
  const progress = [];
  const result = generateDataverseServices({
    projectRoot: root,
    manifest: manifest(),
    environmentUrl: ENVIRONMENT_URL,
    tenantId: 'tenant-1',
    solution: 'Default',
    runCommand: (command, args, options) => {
      calls.push({ command, args, cwd: options.cwd });
      completed.push(args.at(-1));
      writeOutputs(root, completed);
      return { status: 0, stdout: '', stderr: '' };
    },
    onProgress: ({ logicalName }) => progress.push(logicalName),
    nowMs: (() => {
      let value = 0;
      return () => value += 5;
    })(),
  });

  assert.deepEqual(calls.map((call) => call.args.at(-1)), ['new_asset', 'new_service']);
  assert.ok(calls.every((call) => call.command === 'npx' && call.cwd === root));
  assert.deepEqual(progress, ['new_asset', 'new_service']);
  assert.deepEqual(result.services.map((item) => item.logicalName), ['new_asset', 'new_service']);
  assert.equal(result.count, 2);
});

test('zero-service manifest completes without invoking the CLI or requiring config', (context) => {
  const root = project(context);
  let called = false;
  const result = generateDataverseServices({
    projectRoot: root,
    manifest: manifest([]),
    environmentUrl: ENVIRONMENT_URL,
    tenantId: 'tenant-1',
    solution: 'Default',
    runCommand: () => {
      called = true;
      return { status: 0 };
    },
  });
  assert.equal(called, false);
  assert.deepEqual(result.services, []);
  assert.equal(result.count, 0);
});

test('stops on the first failed service command', (context) => {
  const root = project(context);
  const calls = [];
  assert.throws(() => generateDataverseServices({
    projectRoot: root,
    manifest: manifest(['new_first', 'new_second', 'new_third']),
    environmentUrl: ENVIRONMENT_URL,
    tenantId: 'tenant-1',
    solution: 'Default',
    runCommand: (_command, args) => {
      calls.push(args.at(-1));
      return args.at(-1) === 'new_second'
        ? { status: 1, stderr: 'schema unavailable' }
        : { status: 0, stderr: '' };
    },
  }), /service generation failed for new_second: schema unavailable/);
  assert.deepEqual(calls, ['new_first', 'new_second']);
});

test('rejects manifest tampering before running commands', (context) => {
  const root = project(context);
  const value = manifest();
  value.service.requiredTables.push({ logicalName: 'new_extra', consumers: [] });
  let called = false;
  assert.throws(() => generateDataverseServices({
    projectRoot: root,
    manifest: value,
    environmentUrl: ENVIRONMENT_URL,
    tenantId: 'tenant-1',
    solution: 'Default',
    runCommand: () => {
      called = true;
      return { status: 0 };
    },
  }), /integrity hash/);
  assert.equal(called, false);
});

test('verification requires config and generated service output for every table', (context) => {
  const root = project(context);
  writeOutputs(root, ['new_asset']);
  assert.throws(
    () => verifyGeneratedServices(root, ['new_asset', 'new_service']),
    /new_service \(missing config, missing entitySetName, missing service file\)/,
  );
});

test('verification accepts dotted database reference and entity-set service names', (context) => {
  const root = project(context);
  fs.writeFileSync(path.join(root, 'power.config.json'), JSON.stringify({
    databaseReferences: {
      'default.cds': {
        dataSources: {
          equipment: {
            entitySetName: 'new_equipmentses',
            logicalName: 'new_equipments',
          },
        },
      },
    },
  }));
  fs.writeFileSync(
    path.join(root, 'src', 'generated', 'services', 'New_equipmentsesService.ts'),
    'export {};\n',
  );

  assert.deepEqual(verifyGeneratedServices(root, ['new_equipments']), [{
    logicalName: 'new_equipments',
    entitySetName: 'new_equipmentses',
    serviceFile: 'New_equipmentsesService.ts',
  }]);
});