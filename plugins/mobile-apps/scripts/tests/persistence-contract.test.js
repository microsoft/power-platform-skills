'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  compilePersistenceContract,
  validatePersistenceArtifacts,
} = require('../compile-persistence-contract');

function scope(realizations) {
  return {
    schemaVersion: 1,
    contractType: 'product-scope',
    dataEntities: Object.entries(realizations).map(([name, realization]) => ({
      name,
      role: 'primary',
      realization,
      screenIds: [],
    })),
  };
}

function decisions(owners, connectors = []) {
  return {
    schemaVersion: 1,
    nativeCapabilities: [],
    connectors,
    conceptOwners: Object.entries(owners).map(([conceptId, owner]) => ({
      conceptId,
      owner,
      reason: `${conceptId} is persisted by its approved architecture owner.`,
    })),
  };
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

test('Dataverse ownership compiles a Dataverse mode contract', () => {
  const contract = compilePersistenceContract(
    scope({ Equipment: 'existing-table', Inspection: 'new-table' }),
    decisions({ equipment: 'dataverse', inspection: 'dataverse' }),
  );
  assert.equal(contract.mode, 'dataverse');
  assert.deepEqual(contract.dataverseConceptIds, ['equipment', 'inspection']);
  assert.deepEqual(contract.connectorConceptIds, []);
});

test('connector-only ownership contains no Dataverse concepts', () => {
  const contract = compilePersistenceContract(
    scope({ Booking: 'connector-source', Order: 'connector-source' }),
    decisions(
      { booking: 'connector:contoso-booking', order: 'connector:contoso-booking' },
      [{ apiName: 'contoso-booking', displayName: 'Contoso Booking', approved: true }],
    ),
  );
  assert.equal(contract.mode, 'connector-only');
  assert.deepEqual(contract.dataverseConceptIds, []);
  assert.deepEqual(contract.connectorConceptIds, ['booking', 'order']);
});

test('local prototype ownership contains only local and transient concepts', () => {
  const contract = compilePersistenceContract(
    scope({ Catalog: 'local-configuration', Cart: 'transient-ui-state' }),
    decisions({ catalog: 'local', cart: 'transient' }),
  );
  assert.equal(contract.mode, 'local-prototype');
  assert.deepEqual(contract.localConceptIds, ['catalog']);
  assert.deepEqual(contract.transientConceptIds, ['cart']);
});

test('mixed ownership keeps connector concepts out of the Dataverse projection', () => {
  const contract = compilePersistenceContract(
    scope({ Equipment: 'existing-table', Warranty: 'connector-source', Filter: 'transient-ui-state' }),
    decisions(
      {
        equipment: 'dataverse',
        warranty: 'connector:warranty-api',
        filter: 'transient',
      },
      [{ apiName: 'warranty-api', displayName: 'Warranty API', approved: true }],
    ),
  );
  assert.equal(contract.mode, 'mixed');
  assert.deepEqual(contract.dataverseConceptIds, ['equipment']);
  assert.deepEqual(contract.connectorConceptIds, ['warranty']);
});

test('every Product Scope concept requires exactly one compatible owner', () => {
  assert.throws(
    () => compilePersistenceContract(
      scope({ Equipment: 'existing-table', Warranty: 'connector-source' }),
      decisions({ equipment: 'dataverse' }),
    ),
    /Warranty.*owner/i,
  );
  assert.throws(
    () => compilePersistenceContract(
      scope({ Warranty: 'connector-source' }),
      decisions({ warranty: 'connector:unapproved' }),
    ),
    /approved connector/i,
  );
  assert.throws(
    () => compilePersistenceContract(
      scope({ Equipment: 'existing-table' }),
      decisions({ equipment: 'local' }),
    ),
    /incompatible/i,
  );
});

test('Product Scope concept names must remain unique after canonical normalization', () => {
  assert.throws(
    () => compilePersistenceContract(
      scope({ 'Repair Log': 'existing-table', repair_log: 'existing-table' }),
      decisions({}),
    ),
    /concept IDs collide at repair-log/,
  );
});

test('native capabilities cannot silently select persistence mode', () => {
  const input = decisions({ evidence: 'dataverse' });
  input.nativeCapabilities = [{
    id: 'camera',
    displayName: 'Camera',
    persistenceConsequence: 'Produces photo evidence',
    approved: true,
  }];
  const contract = compilePersistenceContract(scope({ Evidence: 'new-table' }), input);
  assert.equal(contract.mode, 'dataverse');
  assert.equal(Object.hasOwn(contract, 'offline'), false);
});

test('connector-only and local projects reject Dataverse planning or mutation artifacts', () => {
  for (const mode of ['connector-only', 'local-prototype']) {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), `persistence-${mode}-`));
    try {
      const contract = { mode };
      assert.deepEqual(validatePersistenceArtifacts(projectRoot, contract).errors, []);
      fs.mkdirSync(path.join(projectRoot, '.tmp'), { recursive: true });
      fs.writeFileSync(
        path.join(projectRoot, '.tmp', 'dataverse-schema-contract.json'),
        '{}\n',
      );
      const result = validatePersistenceArtifacts(projectRoot, contract);
      assert.equal(result.ok, false);
      assert.match(result.errors[0].message, /dataverse-schema-contract/);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  }
});

test('CLI writes a revisioned contract and rejects forbidden artifacts before overwriting output', () => {
  const compiler = path.resolve(__dirname, '..', 'compile-persistence-contract.js');
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'persistence-cli-'));
  try {
    writeJson(
      path.join(projectRoot, '.tmp', 'product-scope-contract.json'),
      scope({ Equipment: 'existing-table', Warranty: 'connector-source' }),
    );
    writeJson(
      path.join(projectRoot, '.tmp', 'architecture-decisions.json'),
      decisions(
        { equipment: 'dataverse', warranty: 'connector:warranty-api' },
        [{ apiName: 'warranty-api', displayName: 'Warranty API', approved: true }],
      ),
    );

    const compiled = spawnSync(
      process.execPath,
      [compiler, '--project-root', projectRoot, '--check-artifacts'],
      { encoding: 'utf8' },
    );
    assert.equal(compiled.status, 0, compiled.stderr);
    const report = JSON.parse(compiled.stdout);
    const outputPath = path.join(projectRoot, '.tmp', 'persistence-contract.json');
    const contract = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    assert.equal(report.output, outputPath);
    assert.equal(report.mode, 'mixed');
    assert.equal(contract.mode, 'mixed');
    assert.match(report.revision, /^[a-f0-9]{64}$/);
    assert.equal(contract.persistenceRevision, report.revision);

    writeJson(
      path.join(projectRoot, '.tmp', 'product-scope-contract.json'),
      scope({ Booking: 'connector-source' }),
    );
    writeJson(
      path.join(projectRoot, '.tmp', 'architecture-decisions.json'),
      decisions(
        { booking: 'connector:booking-api' },
        [{ apiName: 'booking-api', displayName: 'Booking API', approved: true }],
      ),
    );
    writeJson(path.join(projectRoot, '.tmp', 'dataverse-schema-contract.json'), {});
    const previousOutput = fs.readFileSync(outputPath, 'utf8');

    const rejected = spawnSync(
      process.execPath,
      [compiler, '--project-root', projectRoot, '--check-artifacts'],
      { encoding: 'utf8' },
    );
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /forbidden-dataverse-artifact/);
    assert.equal(fs.readFileSync(outputPath, 'utf8'), previousOutput);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});
