'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const pluginRoot = path.resolve(__dirname, '..', '..');
const generator = path.join(pluginRoot, 'skills', 'create-mobile-prototype', 'scripts', 'gen-mock-services.js');
const migrationPlanner = path.join(pluginRoot, 'skills', 'add-sample-data', 'scripts', 'prepare-prototype-seed-migration.js');
const manifestValidator = path.join(pluginRoot, 'scripts', 'validate-datamodel-manifest.js');
const cleanup = path.join(pluginRoot, 'scripts', 'cleanup-prototype-artifacts.js');
const mobileValidator = path.join(pluginRoot, 'scripts', 'validate-mobile-files.js');

function write(root, relativePath, value) {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(root, relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'));
}

function hash(root, relativePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(path.join(root, relativePath))).digest('hex');
}

function run(script, root, ...args) {
  return spawnSync(process.execPath, [script, root, ...args], { encoding: 'utf8' });
}

test('prototype plan edit preserves seed identity through real migration and cleanup', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prototype-lifecycle-story-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  write(root, 'package.json', { name: 'task-prototype' });
  write(root, 'brief.md', 'A task queue for operations coordinators with priorities and completion states.');
  write(root, 'native-app-plan.md', '# Task prototype\n\n## Data Model\n\nApproved contract.\n\n## Connectors\n\n_None._\n');
  write(root, '.tmp/seed-vocabulary.json', {
    domain: 'task queue',
    rowCount: 12,
    pools: {
      person: ['Amina Okafor', 'Diego Morales', 'Haruka Sato', 'Lina Haddad', 'Mateo Silva', 'Priya Nair', 'Tomasz Kowalski', 'Zoe Laurent'],
      company: ['Northstar Operations', 'Beacon Service Group', 'Citadel Workflow Systems', 'Harbor Delivery Partners', 'Summit Process Labs', 'Verity Coordination Works'],
      location: ['North Operations Hub', 'Riverside Service Centre', 'West Annex Office', 'Central Dispatch Floor'],
      door: ['Dispatch Zone A', 'Review Room', 'Planning Area', 'Intake Desk', 'Approval Gate', 'Completion Station'],
      title: ['Review urgent service task', 'Coordinate delivery follow-up', 'Approve completion request', 'Investigate blocked work item', 'Schedule priority handoff', 'Close verified task'],
      note: ['Priority needs confirmation', 'Coordinator review is recorded', 'Completion evidence is available', 'Follow-up is scheduled', 'Task owner has been notified'],
      role: ['operations coordinators'],
    },
    idFormats: {
      serial: 'TSK-{seq4}',
      reference: 'TASK-{year}-{seq4}',
      code: '{ALPHA2}-{seq3}',
    },
  });

  const contract = {
    schemaVersion: 1,
    planningMode: 'prototype',
    executionEligible: false,
    publisherPrefix: 'cr',
    tables: [{
      logicalName: 'cr_task',
      displayName: 'Task',
      plannedDecision: 'create',
      dependencyTier: 0,
      serviceRequired: true,
      columns: [
        { logicalName: 'cr_name', displayName: 'Task Name', type: 'string', primaryName: true, requiredLevel: 'ApplicationRequired' },
        { logicalName: 'cr_status', displayName: 'Status', type: 'choice', options: [{ value: 1, label: 'Draft' }, { value: 2, label: 'Complete' }] },
      ],
    }],
  };
  write(root, '.tmp/dataverse-schema-contract.json', contract);

  const created = run(generator, root);
  assert.equal(created.status, 0, created.stderr);
  const seedPath = 'src/generated/services/Cr_task.seed.json';
  const firstSeeds = readJson(root, seedPath);
  const stableId = firstSeeds[0].cr_taskid;
  firstSeeds[0].cr_name = 'User-authored critical task';
  write(root, seedPath, firstSeeds);

  // Simulate the approved /edit-plan Data Model output before /edit-app --apply-plan.
  fs.appendFileSync(path.join(root, 'native-app-plan.md'), '\nPriority field approved.\n');
  contract.tables[0].columns.push({
    logicalName: 'cr_priority',
    displayName: 'Priority',
    type: 'integer',
    requiredLevel: 'None',
  });
  write(root, '.tmp/dataverse-schema-contract.json', contract);

  const regenerated = run(generator, root);
  assert.equal(regenerated.status, 0, regenerated.stderr);
  const editedSeeds = readJson(root, seedPath);
  assert.equal(editedSeeds[0].cr_taskid, stableId);
  assert.equal(editedSeeds[0].cr_name, 'User-authored critical task');
  assert.equal(typeof editedSeeds[0].cr_priority, 'number');
  const regeneration = readJson(root, '.tmp/prototype-seed-regeneration.json');
  assert.deepEqual(regeneration.tables[0].addedFields, ['cr_priority']);

  fs.mkdirSync(path.join(root, '.tmp/prototype-plan-artifacts'), { recursive: true });
  fs.copyFileSync(
    path.join(root, '.tmp/dataverse-schema-contract.json'),
    path.join(root, '.tmp/prototype-plan-artifacts/dataverse-schema-contract.json'),
  );
  const realManifest = {
    environmentUrl: 'https://example.crm.dynamics.com',
    tables: [{
      logicalName: 'cr1_task',
      entitySetName: 'cr1_tasks',
      primaryIdAttribute: 'cr1_taskid',
      primaryNameAttribute: 'cr1_name',
      dependencyTier: 0,
      status: 'new',
      customEntity: true,
      sharedSystemTable: false,
      columns: [
        { logicalName: 'cr1_name', schemaName: 'cr1_Name', type: 'String' },
        { logicalName: 'cr1_status', schemaName: 'cr1_Status', type: 'Choice', options: [{ value: 10, label: 'Draft' }, { value: 20, label: 'Complete' }] },
        { logicalName: 'cr1_priority', schemaName: 'cr1_Priority', type: 'Integer' },
      ],
    }],
  };
  write(root, '.datamodel-manifest.json', realManifest);
  const validated = spawnSync(process.execPath, [manifestValidator, path.join(root, '.datamodel-manifest.json')], { encoding: 'utf8' });
  assert.equal(validated.status, 0, validated.stderr);

  // Conversion must validate the full non-generated app surface, not only
  // files rewritten during the final sync. This stale shared helper simulates
  // a prototype-era display binding that still type-checks after real service
  // generation but fails against Dataverse at runtime.
  write(root, 'src/hooks/useTasks.ts', `
export function loadTasks(Service) {
  return Service.getAll({ select: ['cr1_name', 'cr1_statusname'] });
}
`);
  const staleBindings = spawnSync(
    process.execPath,
    [mobileValidator, '--project-root', root, '--all-source'],
    { encoding: 'utf8' },
  );
  assert.equal(staleBindings.status, 2);
  assert.match(staleBindings.stderr, /cr1_statusname/);

  write(root, 'src/hooks/useTasks.ts', `
export function loadTasks(Service) {
  return Service.getAll({ select: ['cr1_name', 'cr1_status'] });
}
`);
  const reboundBindings = spawnSync(
    process.execPath,
    [mobileValidator, '--project-root', root, '--all-source'],
    { encoding: 'utf8' },
  );
  assert.equal(reboundBindings.status, 0, reboundBindings.stderr);

  write(root, '.tmp/prototype-plan-artifacts/live-name-map.json', {
    schemaVersion: 1,
    approvedPlanSha256: hash(root, 'native-app-plan.md'),
    prototypeContractSha256: hash(root, '.tmp/prototype-plan-artifacts/dataverse-schema-contract.json'),
    dataverseManifestSha256: hash(root, '.datamodel-manifest.json'),
    environment: { id: 'environment-1', url: 'https://example.crm.dynamics.com' },
    publisherPrefix: 'cr1',
    tables: {
      cr_task: {
        logicalName: 'cr1_task',
        decision: 'create',
        columns: {
          cr_name: { logicalName: 'cr1_name', decision: 'create' },
          cr_status: { logicalName: 'cr1_status', decision: 'create' },
          cr_priority: { logicalName: 'cr1_priority', decision: 'create' },
        },
      },
    },
  });

  const migration = run(migrationPlanner, root);
  assert.equal(migration.status, 0, migration.stderr);
  const migrationPlan = readJson(root, '.tmp/prototype-seed-migration.json');
  assert.equal(migrationPlan.summary.blockerCount, 0);
  const migratedRow = migrationPlan.tables[0].rows.find((row) => row.seedId === stableId);
  assert.equal(migratedRow.body.cr1_taskid, stableId);
  assert.equal(migratedRow.body.cr1_name, 'User-authored critical task');
  assert.equal(typeof migratedRow.body.cr1_priority, 'number');
  assert.ok([10, 20].includes(migratedRow.body.cr1_status));

  // Simulate real service generation before conversion cleanup. Seed/schema
  // artifacts remain until cleanup, while every marker-bearing runtime file is
  // replaced by real generated content.
  const prototypeManifest = readJson(root, 'src/generated/.prototype-manifest.json');
  for (const relativePath of prototypeManifest.files) {
    if (relativePath.endsWith('.seed.json') || relativePath.includes('/schemas/')) continue;
    const filePath = path.join(root, relativePath);
    if (fs.existsSync(filePath)) fs.writeFileSync(filePath, '// Real generated Dataverse service surface.\n');
  }

  const cleaned = run(cleanup, root);
  assert.equal(cleaned.status, 0, cleaned.stderr);
  assert.equal(fs.existsSync(path.join(root, seedPath)), false);
  assert.equal(fs.existsSync(path.join(root, 'src/generated/.prototype-manifest.json')), false);
  assert.equal(fs.existsSync(path.join(root, '.tmp/prototype-seed-migration.json')), true);
  const preservedMigration = readJson(root, '.tmp/prototype-seed-migration.json');
  assert.equal(preservedMigration.tables[0].rows[0].body.cr1_taskid, editedSeeds[0].cr_taskid);
});