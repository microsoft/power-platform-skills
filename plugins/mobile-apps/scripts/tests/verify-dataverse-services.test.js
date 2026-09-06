'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  configuredDataSources,
  verifyDataverseServices,
} = require('../verify-dataverse-services');

function project(testContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-dataverse-services-'));
  testContext.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src', 'generated', 'services'), { recursive: true });
  return root;
}

function writeService(root, name) {
  fs.writeFileSync(
    path.join(root, 'src', 'generated', 'services', name),
    'export {};\n',
  );
}

test('accepts literal default.cds and entity-set-derived service names', (testContext) => {
  const root = project(testContext);
  fs.writeFileSync(path.join(root, 'power.config.json'), JSON.stringify({
    databaseReferences: {
      'default.cds': {
        dataSources: {
          equipment: {
            logicalName: 'new_equipments',
            entitySetName: 'new_equipmentses',
          },
          users: {
            logicalName: 'systemuser',
            entitySetName: 'systemusers',
          },
        },
      },
    },
  }));
  writeService(root, 'New_equipmentsesService.ts');
  writeService(root, 'SystemusersService.ts');

  assert.deepEqual(verifyDataverseServices(root, ['new_equipments', 'systemuser']), [{
    logicalName: 'new_equipments',
    entitySetName: 'new_equipmentses',
    serviceFile: 'New_equipmentsesService.ts',
  }, {
    logicalName: 'systemuser',
    entitySetName: 'systemusers',
    serviceFile: 'SystemusersService.ts',
  }]);
});

test('retains compatibility with nested database reference shape', () => {
  const dataSources = { users: { logicalName: 'systemuser', entitySetName: 'systemusers' } };
  assert.equal(configuredDataSources({
    databaseReferences: { default: { cds: { dataSources } } },
  }), dataSources);
});

test('rejects missing config, entity-set metadata, and service files', (testContext) => {
  const root = project(testContext);
  assert.throws(
    () => verifyDataverseServices(root, ['systemuser']),
    /power.config.json was not generated/,
  );
  fs.writeFileSync(path.join(root, 'power.config.json'), JSON.stringify({
    databaseReferences: {
      'default.cds': {
        dataSources: {
          users: { logicalName: 'systemuser' },
        },
      },
    },
  }));
  assert.throws(
    () => verifyDataverseServices(root, ['systemuser']),
    /missing entitySetName/,
  );
  fs.writeFileSync(path.join(root, 'power.config.json'), JSON.stringify({
    databaseReferences: {
      'default.cds': {
        dataSources: {
          users: { logicalName: 'systemuser', entitySetName: 'systemusers' },
        },
      },
    },
  }));
  assert.throws(
    () => verifyDataverseServices(root, ['systemuser']),
    /missing service file/,
  );
  fs.writeFileSync(path.join(root, 'power.config.json'), JSON.stringify({
    databaseReferences: {
      'default.cds': {
        dataSources: {
          equipment: {
            logicalName: 'new_equipments',
            entitySetName: 'new_equipmentses',
          },
        },
      },
    },
  }));
  writeService(root, 'New_equipmentsService.ts');
  assert.throws(
    () => verifyDataverseServices(root, ['new_equipments']),
    /missing service file/,
  );
});

test('empty required table set needs no generated config', () => {
  assert.deepEqual(verifyDataverseServices('/does/not/exist', []), []);
});