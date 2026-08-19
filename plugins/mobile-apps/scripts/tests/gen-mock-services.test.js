'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const script = path.resolve(__dirname, '..', '..', 'skills', 'create-mobile-prototype', 'scripts', 'gen-mock-services.js');

function makeProject(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-prototype-mocks-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  }
  return root;
}

function run(projectRoot) {
  return spawnSync(process.execPath, [script, projectRoot], { encoding: 'utf8' });
}

test('generates deterministic table mocks, relationships, choices, and connector stubs from the schema contract', (t) => {
  const root = makeProject(t, {
    'brief.md': 'A field inspection app for warehouse technicians.',
    'native-app-plan.md': `
## Data Model

Approved in the structured schema contract.

## Connectors

| Connector | API name | Why needed | Skill |
|---|---|---|---|
| SharePoint Online | \`sharepointonline\` | Store evidence documents | \`/add-sharepoint\` |

## Screens
`,
    '.tmp/dataverse-schema-contract.json': JSON.stringify({
      schemaVersion: 1,
      tables: [
        {
          logicalName: 'cr_site',
          displayName: 'Site',
          plannedDecision: 'create',
          dependencyTier: 0,
          serviceRequired: true,
          columns: [
            { logicalName: 'cr_name', displayName: 'Site Name', type: 'string', primaryName: true, requiredLevel: 'ApplicationRequired' },
          ],
        },
        {
          logicalName: 'cr_inspection',
          displayName: 'Inspection',
          plannedDecision: 'create',
          dependencyTier: 1,
          serviceRequired: true,
          columns: [
            { logicalName: 'cr_name', displayName: 'Inspection Name', type: 'string', primaryName: true, requiredLevel: 'ApplicationRequired' },
            { logicalName: 'cr_siteid', displayName: 'Site', type: 'lookup', lookupTarget: 'cr_site', requiredLevel: 'ApplicationRequired' },
            { logicalName: 'cr_status', displayName: 'Status', type: 'choice', options: [{ value: 100000000, label: 'Draft' }, { value: 100000001, label: 'Complete' }] },
          ],
        },
      ],
    }),
  });

  const first = run(root);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /generated 2 table service\(s\) and 1 connector stub/);

  const sites = JSON.parse(fs.readFileSync(path.join(root, 'src/generated/services/Cr_site.seed.json'), 'utf8'));
  const inspectionsPath = path.join(root, 'src/generated/services/Cr_inspection.seed.json');
  const inspections = JSON.parse(fs.readFileSync(inspectionsPath, 'utf8'));
  assert.equal(sites.length, 8);
  assert.equal(inspections.length, 8);
  assert.equal(inspections[0].cr_siteid, sites[0].cr_siteid);
  assert.deepEqual(new Set(inspections.map((row) => row.cr_status)), new Set([100000000, 100000001]));

  const service = fs.readFileSync(path.join(root, 'src/generated/services/Cr_inspectionService.ts'), 'utf8');
  assert.match(service, /async getAll/);
  assert.match(service, /async getById/);
  assert.match(service, /async create/);
  assert.match(service, /async update/);
  assert.match(service, /async delete/);
  assert.match(service, /Reflect\.get\(left, field\)/);
  assert.doesNotMatch(service, /Record<string, unknown>/);

  const connector = fs.readFileSync(path.join(root, 'src/generated/services/SharePointOnlineService.ts'), 'utf8');
  assert.match(connector, /Run \/prototype-to-real-app to provision it/);
  assert.match(fs.readFileSync(path.join(root, 'src/generated/services/index.ts'), 'utf8'), /export \* from '\.\/dataSourcesInfo'/);
  assert.match(fs.readFileSync(path.join(root, 'src/generated/index.ts'), 'utf8'), /export \* from '\.\/services'/);

  const firstSeed = fs.readFileSync(inspectionsPath, 'utf8');
  const second = run(root);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(fs.readFileSync(inspectionsPath, 'utf8'), firstSeed);

  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'src/generated/.prototype-manifest.json'), 'utf8'));
  assert.deepEqual(manifest.tables, ['cr_site', 'cr_inspection']);
  assert.deepEqual(manifest.connectors, ['sharepointonline']);
});

test('supports the legacy Markdown entity blocks from the test branch', (t) => {
  const root = makeProject(t, {
    'native-app-plan.md': `
## Data Model

**Task** (\`cr_task\`) - prototype task
- \`cr_name\` (String)
- \`cr_dueon\` (DateTime, nullable)

## Connectors

_None - this app uses local data only._
`,
  });

  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /legacy fallback/);
  assert.equal(fs.existsSync(path.join(root, 'src/generated/services/Cr_taskService.ts')), true);
});

test('preserves compatible seed rows across schema edits and archives removed tables', (t) => {
  const contract = {
    schemaVersion: 1,
    tables: [
      {
        logicalName: 'cr_site',
        displayName: 'Site',
        plannedDecision: 'create',
        dependencyTier: 0,
        serviceRequired: true,
        columns: [
          { logicalName: 'cr_name', displayName: 'Site Name', type: 'string', primaryName: true, requiredLevel: 'ApplicationRequired' },
        ],
      },
      {
        logicalName: 'cr_obsolete',
        displayName: 'Obsolete',
        plannedDecision: 'create',
        dependencyTier: 0,
        serviceRequired: true,
        columns: [
          { logicalName: 'cr_name', displayName: 'Name', type: 'string', primaryName: true, requiredLevel: 'ApplicationRequired' },
        ],
      },
      {
        logicalName: 'cr_inspection',
        displayName: 'Inspection',
        plannedDecision: 'create',
        dependencyTier: 1,
        serviceRequired: true,
        columns: [
          { logicalName: 'cr_name', displayName: 'Inspection Name', type: 'string', primaryName: true, requiredLevel: 'ApplicationRequired' },
          { logicalName: 'cr_siteid', displayName: 'Site', type: 'lookup', lookupTarget: 'cr_site', requiredLevel: 'ApplicationRequired' },
          { logicalName: 'cr_status', displayName: 'Status', type: 'choice', options: [{ value: 100000000, label: 'Draft' }, { value: 100000001, label: 'Complete' }] },
        ],
      },
    ],
  };
  const root = makeProject(t, {
    'brief.md': 'A field inspection app.',
    'native-app-plan.md': '## Data Model\n\nApproved in the contract.\n\n## Connectors\n\n_None._\n',
    '.tmp/dataverse-schema-contract.json': JSON.stringify(contract),
  });

  const first = run(root);
  assert.equal(first.status, 0, first.stderr);
  const seedPath = path.join(root, 'src/generated/services/Cr_inspection.seed.json');
  const before = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
  const preservedId = before[0].cr_inspectionid;
  before[0].cr_name = 'User-authored inspection';
  before[0].cr_status = 100000000;
  before[0].localOnly = 'drop me';
  fs.writeFileSync(seedPath, `${JSON.stringify(before, null, 2)}\n`);

  contract.tables = contract.tables
    .filter((table) => table.logicalName !== 'cr_obsolete')
    .map((table) => table.logicalName !== 'cr_inspection' ? table : {
      ...table,
      columns: [
        ...table.columns.filter((column) => column.logicalName !== 'cr_status'),
        { logicalName: 'cr_status', displayName: 'Status', type: 'choice', options: [{ value: 100000001, label: 'Complete' }] },
        { logicalName: 'cr_notes', displayName: 'Notes', type: 'memo' },
      ],
    });
  fs.writeFileSync(
    path.join(root, '.tmp/dataverse-schema-contract.json'),
    JSON.stringify(contract),
  );

  const second = run(root);
  assert.equal(second.status, 0, second.stderr);
  const after = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
  assert.equal(after[0].cr_inspectionid, preservedId);
  assert.equal(after[0].cr_name, 'User-authored inspection');
  assert.equal(after[0].cr_status, 100000001);
  assert.equal(typeof after[0].cr_notes, 'string');
  assert.equal(Object.prototype.hasOwnProperty.call(after[0], 'localOnly'), false);

  const report = JSON.parse(fs.readFileSync(path.join(root, '.tmp/prototype-seed-regeneration.json'), 'utf8'));
  const inspectionReport = report.tables.find((table) => table.logicalName === 'cr_inspection');
  assert.equal(inspectionReport.preservedRows, 8);
  assert.deepEqual(inspectionReport.addedFields, ['cr_notes']);
  assert.deepEqual(inspectionReport.regeneratedFields, ['cr_status']);
  assert.equal(fs.existsSync(path.join(root, 'src/generated/services/Cr_obsolete.seed.json')), false);
  assert.equal(fs.existsSync(path.join(root, '.tmp/prototype-seed-archive/src/generated/services/Cr_obsolete.seed.json')), true);
  assert.equal(fs.existsSync(path.join(root, 'src/generated/services/Cr_obsoleteService.ts')), false);
});

test('fails closed when neither a structured contract nor parseable legacy entities exist', (t) => {
  const root = makeProject(t, {
    'native-app-plan.md': '## Data Model\n\nNo executable schema was written.\n',
  });

  const result = run(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no entities found/);
});