'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const script = path.resolve(__dirname, '..', '..', 'skills', 'create-mobile-prototype', 'scripts', 'gen-mock-services.js');
const templateTsc = path.resolve(__dirname, '..', '..', 'template', 'node_modules', 'typescript', 'bin', 'tsc');

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

function makeVocabulary({
  domain = 'field inspection',
  roles = ['warehouse technicians'],
  prefix = 'INS',
  pools = {},
} = {}) {
  return {
    domain,
    rowCount: 12,
    pools: {
      person: ['Amina Okafor', 'Diego Morales', 'Haruka Sato', 'Lina Haddad', 'Mateo Silva', 'Priya Nair', 'Tomasz Kowalski', 'Zoe Laurent'],
      company: ['Northstar Safety Services', 'Beacon Facilities Group', 'Citadel Equipment Works', 'Harbor Operations Partners', 'Summit Inspection Labs', 'Verity Compliance Systems'],
      location: ['North Dock Facility', 'Cold Room Campus', 'Riverside Warehouse', 'West Annex Depot'],
      door: ['Loading Gate A', 'Plant Room Door', 'Roof Access Zone', 'Receiving Entrance', 'Inspection Area East', 'Equipment Room'],
      title: ['North dock safety walk', 'Cold room equipment audit', 'Rooftop unit inspection', 'Loading bay compliance review', 'Generator maintenance check', 'Packaging line follow-up'],
      note: ['Evidence requires review', 'Inspection is ready for sign-off', 'Follow-up work is scheduled', 'Equipment readings are within target', 'Site access was confirmed'],
      role: roles,
      ...pools,
    },
    idFormats: {
      serial: `${prefix}-{seq4}`,
      reference: `${prefix}-{year}-{seq4}`,
      code: '{ALPHA2}-{seq3}',
    },
  };
}

function vocabularyFile(options) {
  return JSON.stringify(makeVocabulary(options));
}

function writeProjectFile(root, relativePath, contents) {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
}

function simpleContract(displayName = 'Work Item') {
  return {
    schemaVersion: 1,
    tables: [{
      logicalName: 'cr_workitem',
      displayName,
      plannedDecision: 'create',
      dependencyTier: 0,
      serviceRequired: true,
      columns: [
        { logicalName: 'cr_name', displayName: 'Name', type: 'string', primaryName: true, requiredLevel: 'ApplicationRequired' },
        { logicalName: 'cr_company', displayName: 'Company', type: 'string' },
        { logicalName: 'cr_location', displayName: 'Location', type: 'string' },
        { logicalName: 'cr_notes', displayName: 'Notes', type: 'memo' },
      ],
    }],
  };
}

function typeCheckGenerated(projectRoot) {
  const tsconfigPath = path.join(projectRoot, 'tsconfig.generated.json');
  fs.writeFileSync(tsconfigPath, `${JSON.stringify({
    compilerOptions: {
      strict: true,
      noEmit: true,
      target: 'ES2020',
      module: 'ESNext',
      moduleResolution: 'Bundler',
      resolveJsonModule: true,
      esModuleInterop: true,
      skipLibCheck: true,
    },
    include: ['src/generated/**/*.ts'],
  }, null, 2)}\n`);

  if (fs.existsSync(templateTsc)) {
    return spawnSync(process.execPath, [templateTsc, '--project', tsconfigPath], { encoding: 'utf8' });
  }

  const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  return spawnSync(
    npx,
    ['--yes', '--package', 'typescript@5.9.3', '--', 'tsc', '--project', tsconfigPath],
    { encoding: 'utf8' },
  );
}

test('generates deterministic table mocks, relationships, choices, and connector stubs from the schema contract', (t) => {
  const root = makeProject(t, {
    'brief.md': 'A field inspection app for warehouse technicians.',
    '.tmp/seed-vocabulary.json': vocabularyFile(),
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
  assert.equal(sites.length, 12);
  assert.equal(inspections.length, 12);
  assert.equal(new Set(sites.map((site) => site.cr_siteid)).has(inspections[0].cr_siteid), true);
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
  const generatedIndex = fs.readFileSync(path.join(root, 'src/generated/index.ts'), 'utf8');
  assert.match(generatedIndex, /export \* from '\.\/services'/);
  assert.match(generatedIndex, /export \* from '\.\/choiceLabels'/);
  const choiceLabels = fs.readFileSync(path.join(root, 'src/generated/choiceLabels.ts'), 'utf8');
  assert.match(choiceLabels, /export const Cr_inspection_cr_status_LABELS: Record<string, string>/);
  assert.match(choiceLabels, /"100000000": "Draft"/);
  assert.match(choiceLabels, /"100000001": "Complete"/);
  assert.match(choiceLabels, /export function choiceLabel/);
  assert.match(choiceLabels, /map\[key\] \?\? 'Unknown'/);
  assert.doesNotMatch(choiceLabels, /map\[key\] \?\? key/);

  const typeCheck = typeCheckGenerated(root);
  assert.equal(typeCheck.status, 0, `${typeCheck.stdout}\n${typeCheck.stderr}`);

  const firstSeed = fs.readFileSync(inspectionsPath, 'utf8');
  const second = run(root);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(fs.readFileSync(inspectionsPath, 'utf8'), firstSeed);

  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'src/generated/.prototype-manifest.json'), 'utf8'));
  assert.deepEqual(manifest.tables, ['cr_site', 'cr_inspection']);
  assert.deepEqual(manifest.connectors, ['sharepointonline']);
  assert.equal(manifest.choiceLabelFile, 'src/generated/choiceLabels.ts');
  assert.equal(manifest.files.includes('src/generated/choiceLabels.ts'), true);
});

test('uses the brief-derived vocabulary without a fixed retail profile', (t) => {
  const vocabulary = makeVocabulary({
    domain: 'onboard retail',
    roles: ['flight attendants', 'cabin retail managers'],
    prefix: 'ONB',
    pools: {
      category: ['Travel Comfort', 'Beauty', 'Watches', 'Power and Adapters', 'Leather Goods', 'Gifts'],
      company: ['Nomad Form', 'Luma Atelier', 'Aster and Company', 'Orbit Supply', 'Northline Goods', 'Voyager Works'],
      location: ['Forward Cabin Cart', 'Aft Cabin Cart', 'Premium Cabin Store', 'Galley Retail Bay'],
      door: ['Forward Galley Locker', 'Aft Cart Compartment', 'Premium Display Case', 'Cabin Stock Drawer', 'Duty Free Cabinet', 'Service Trolley Bay'],
      title: ['CloudRest Travel Pillow', 'Altitude Beauty Edit', 'Aero Classic Watch', 'WorldPort Travel Adapter', 'Cabin Glow Face Mist', 'Voyager Passport Wallet'],
      note: ['Available on this flight', 'Selected for compact travel', 'Limited onboard quantity', 'Cabin crew can assist', 'Stock checked before departure'],
      image: [
        'https://example.com/travel-pillow.jpg',
        'https://example.com/beauty-edit.jpg',
        'https://example.com/classic-watch.jpg',
        'https://example.com/travel-adapter.jpg',
      ],
    },
  });
  const root = makeProject(t, {
    'brief.md': 'An onboard retail app for flight passengers, flight attendants, and cabin retail managers buying travel accessories, beauty products, and watches.',
    '.tmp/seed-vocabulary.json': JSON.stringify(vocabulary),
    'native-app-plan.md': '## Data Model\n\nApproved in the contract.\n\n## Connectors\n\nNone.\n',
    '.tmp/dataverse-schema-contract.json': JSON.stringify({
      schemaVersion: 1,
      tables: [
        {
          logicalName: 'cr_category',
          displayName: 'Category',
          plannedDecision: 'create',
          dependencyTier: 0,
          serviceRequired: true,
          columns: [
            { logicalName: 'cr_name', displayName: 'Name', type: 'string', primaryName: true, requiredLevel: 'ApplicationRequired' },
            { logicalName: 'cr_description', displayName: 'Description', type: 'memo' },
            { logicalName: 'cr_displayorder', displayName: 'Display Order', type: 'integer', requiredLevel: 'ApplicationRequired' },
          ],
        },
        {
          logicalName: 'cr_product',
          displayName: 'Product',
          plannedDecision: 'create',
          dependencyTier: 1,
          serviceRequired: true,
          columns: [
            { logicalName: 'cr_name', displayName: 'Name', type: 'string', primaryName: true, requiredLevel: 'ApplicationRequired' },
            { logicalName: 'cr_brand', displayName: 'Brand', type: 'string' },
            { logicalName: 'cr_categoryid', displayName: 'Category', type: 'lookup', lookupTarget: 'cr_category', requiredLevel: 'ApplicationRequired' },
            { logicalName: 'cr_imageurl', displayName: 'Image URL', type: 'string', requiredLevel: 'ApplicationRequired' },
            { logicalName: 'cr_price', displayName: 'Price', type: 'money', requiredLevel: 'ApplicationRequired' },
            { logicalName: 'cr_sku', displayName: 'SKU', type: 'string', requiredLevel: 'ApplicationRequired' },
          ],
        },
        {
          logicalName: 'cr_inventoryitem',
          displayName: 'Inventory Item',
          plannedDecision: 'create',
          dependencyTier: 2,
          serviceRequired: true,
          columns: [
            { logicalName: 'cr_name', displayName: 'Name', type: 'string', primaryName: true, requiredLevel: 'ApplicationRequired' },
            { logicalName: 'cr_productid', displayName: 'Product', type: 'lookup', lookupTarget: 'cr_product', requiredLevel: 'ApplicationRequired' },
            { logicalName: 'cr_availabilitystatus', displayName: 'Availability', type: 'choice', requiredLevel: 'ApplicationRequired', options: [
              { value: 100000000, label: 'Available' },
              { value: 100000001, label: 'Low stock' },
              { value: 100000002, label: 'Sold out' },
            ] },
            { logicalName: 'cr_cabinlocation', displayName: 'Cabin Location', type: 'string' },
            { logicalName: 'cr_lowstockthreshold', displayName: 'Low Stock Threshold', type: 'integer', requiredLevel: 'ApplicationRequired' },
            { logicalName: 'cr_quantityavailable', displayName: 'Quantity Available', type: 'integer', requiredLevel: 'ApplicationRequired' },
          ],
        },
      ],
    }),
  });

  const result = run(root);
  assert.equal(result.status, 0, result.stderr);

  const categoryRows = JSON.parse(fs.readFileSync(path.join(root, 'src/generated/services/Cr_category.seed.json'), 'utf8'));
  const productRows = JSON.parse(fs.readFileSync(path.join(root, 'src/generated/services/Cr_product.seed.json'), 'utf8'));
  const inventoryRows = JSON.parse(fs.readFileSync(path.join(root, 'src/generated/services/Cr_inventoryitem.seed.json'), 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'src/generated/.prototype-manifest.json'), 'utf8'));

  assert.match(manifest.seedProfile, /^vocabulary-[a-f0-9]{16}$/);
  assert.equal(manifest.seedVocabulary, '.tmp/seed-vocabulary.json');
  assert.match(manifest.seedVocabularySha256, /^[a-f0-9]{64}$/);
  assert.equal(categoryRows.length, vocabulary.pools.category.length);
  assert.equal(productRows.length, vocabulary.rowCount);
  assert.equal(new Set(productRows.map((row) => row.cr_name)).size, vocabulary.pools.title.length);
  assert.equal(productRows.every((row) => vocabulary.pools.title.includes(row.cr_name)), true);
  assert.equal(productRows.every((row) => vocabulary.pools.company.includes(row.cr_brand)), true);
  assert.equal(productRows.every((row) => row.cr_imageurl.startsWith('data:image/png;base64,')), true);
  assert.equal(new Set(productRows.map((row) => row.cr_imageurl)).size, 1);
  assert.equal(JSON.stringify(productRows).includes('https://'), false);

  const categoryIds = new Set(categoryRows.map((row) => row.cr_categoryid));
  const productIds = new Set(productRows.map((row) => row.cr_productid));
  assert.equal(productRows.every((row) => categoryIds.has(row.cr_categoryid)), true);
  assert.equal(inventoryRows.every((row) => productIds.has(row.cr_productid)), true);
  assert.deepEqual(new Set(inventoryRows.map((row) => row.cr_availabilitystatus)), new Set([100000000, 100000001, 100000002]));
});

test('generates entity-aware names, distinct sibling lookups and numerics, and ordered relative dates', (t) => {
  const vocabulary = makeVocabulary({
    domain: 'corporate access control',
    roles: ['security officers', 'facilities coordinators'],
    prefix: 'BDG',
    pools: {
      person: ['Nadia El-Sayed', 'Kenji Watanabe', 'Lucia Ferreira', 'Samira Khan', 'Ethan Redbird', 'Mei Chen', 'Owen Murphy', 'Anika Bose'],
      company: ['Northstar Security Services', 'Beacon Facilities Group', 'Citadel Badge Systems', 'Harbor Access Partners', 'Summit Credential Works', 'Verity Office Security'],
      location: ['Atrium Office Building', 'North Campus Security Desk', 'Riverside Administration Building', 'West Annex Badge Office'],
      door: ['Lobby Turnstile A', 'Server Room Door', 'North Loading Entrance', 'Executive Floor Gate', 'Visitor Reception Door', 'Parking Garage Barrier'],
      title: ['Review contractor badge request', 'Approve visitor access window', 'Investigate expired credential', 'Assign server room permission', 'Replace damaged employee badge', 'Audit weekend door access'],
      note: ['Photo identification needs review', 'Manager approval is recorded', 'Credential expires after the visit', 'Door assignment follows facilities policy', 'Badge pickup is waiting at reception'],
    },
  });
  const contract = {
    schemaVersion: 1,
    tables: [
      {
        logicalName: 'cr_person', displayName: 'Person', plannedDecision: 'create', dependencyTier: 0, serviceRequired: true,
        columns: [{ logicalName: 'cr_name', displayName: 'Name', type: 'string', primaryName: true, requiredLevel: 'ApplicationRequired' }],
      },
      {
        logicalName: 'cr_building', displayName: 'Building', plannedDecision: 'create', dependencyTier: 0, serviceRequired: true,
        columns: [{ logicalName: 'cr_name', displayName: 'Name', type: 'string', primaryName: true, requiredLevel: 'ApplicationRequired' }],
      },
      {
        logicalName: 'cr_door', displayName: 'Door', plannedDecision: 'create', dependencyTier: 1, serviceRequired: true,
        columns: [
          { logicalName: 'cr_name', displayName: 'Name', type: 'string', primaryName: true, requiredLevel: 'ApplicationRequired' },
          { logicalName: 'cr_buildingid', displayName: 'Building', type: 'lookup', lookupTarget: 'cr_building', requiredLevel: 'ApplicationRequired' },
        ],
      },
      {
        logicalName: 'cr_badgerequest', displayName: 'Badge Request', plannedDecision: 'create', dependencyTier: 1, serviceRequired: true,
        columns: [
          { logicalName: 'cr_name', displayName: 'Name', type: 'string', primaryName: true, requiredLevel: 'ApplicationRequired' },
          { logicalName: 'cr_subjectname', displayName: 'Subject Name', type: 'string' },
          { logicalName: 'cr_subjectcompany', displayName: 'Subject Company', type: 'string' },
          { logicalName: 'cr_badgeserial', displayName: 'Badge Serial', type: 'string' },
          { logicalName: 'cr_requestreference', displayName: 'Request Reference', type: 'string' },
          { logicalName: 'cr_doorcode', displayName: 'Door Code', type: 'string' },
          { logicalName: 'cr_requesterid', displayName: 'Requester', type: 'lookup', lookupTarget: 'cr_person' },
          { logicalName: 'cr_approverid', displayName: 'Approver', type: 'lookup', lookupTarget: 'cr_person' },
          { logicalName: 'cr_issuedbyid', displayName: 'Issued By', type: 'lookup', lookupTarget: 'cr_person' },
          { logicalName: 'cr_expected', displayName: 'Expected', type: 'integer' },
          { logicalName: 'cr_received', displayName: 'Received', type: 'integer' },
          { logicalName: 'cr_damaged', displayName: 'Damaged', type: 'integer' },
          { logicalName: 'cr_latitude', displayName: 'Latitude', type: 'decimal' },
          { logicalName: 'cr_longitude', displayName: 'Longitude', type: 'decimal' },
          { logicalName: 'cr_amount', displayName: 'Amount', type: 'money' },
          { logicalName: 'cr_createdat', displayName: 'Created At', type: 'datetime' },
          { logicalName: 'cr_issuedat', displayName: 'Issued At', type: 'datetime' },
          { logicalName: 'cr_completedat', displayName: 'Completed At', type: 'datetime' },
          { logicalName: 'cr_validfrom', displayName: 'Valid From', type: 'datetime' },
          { logicalName: 'cr_validto', displayName: 'Valid To', type: 'datetime' },
          { logicalName: 'cr_notes', displayName: 'Notes', type: 'memo' },
        ],
      },
    ],
  };
  const root = makeProject(t, {
    'brief.md': 'Build a corporate access control app for security officers and facilities coordinators.',
    'native-app-plan.md': '## Data Model\n\nApproved in the contract.\n\n## Connectors\n\nNone.\n',
    '.tmp/seed-vocabulary.json': JSON.stringify(vocabulary),
    '.tmp/dataverse-schema-contract.json': JSON.stringify(contract),
  });

  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  const people = JSON.parse(fs.readFileSync(path.join(root, 'src/generated/services/Cr_person.seed.json'), 'utf8'));
  const buildings = JSON.parse(fs.readFileSync(path.join(root, 'src/generated/services/Cr_building.seed.json'), 'utf8'));
  const doors = JSON.parse(fs.readFileSync(path.join(root, 'src/generated/services/Cr_door.seed.json'), 'utf8'));
  const requests = JSON.parse(fs.readFileSync(path.join(root, 'src/generated/services/Cr_badgerequest.seed.json'), 'utf8'));
  assert.equal(people.length, 12);
  assert.equal(people.every((row) => vocabulary.pools.person.includes(row.cr_name)), true);
  assert.equal(buildings.every((row) => vocabulary.pools.location.includes(row.cr_name)), true);
  assert.equal(doors.every((row) => vocabulary.pools.door.includes(row.cr_name)), true);
  assert.equal(requests.every((row) => vocabulary.pools.title.includes(row.cr_name)), true);
  assert.equal(requests.every((row) => vocabulary.pools.person.includes(row.cr_subjectname)), true);
  assert.equal(requests.every((row) => vocabulary.pools.company.includes(row.cr_subjectcompany)), true);
  assert.equal(requests.every((row) => /^BDG-\d{4}$/.test(row.cr_badgeserial)), true);
  assert.equal(requests.every((row) => /^BDG-\d{4}-\d{4}$/.test(row.cr_requestreference)), true);
  assert.equal(requests.every((row) => /^[A-Z]{2}-\d{3}$/.test(row.cr_doorcode)), true);
  assert.equal(requests.every((row) => new Set([row.cr_requesterid, row.cr_approverid, row.cr_issuedbyid]).size === 3), true);
  assert.equal(requests.every((row) => row.cr_expected !== row.cr_received && row.cr_received !== row.cr_damaged), true);
  assert.equal(requests.every((row) => row.cr_latitude !== row.cr_longitude), true);
  assert.equal(requests.every((row) => Date.parse(row.cr_validto) > Date.parse(row.cr_validfrom)), true);
  assert.equal(requests.every((row) => Date.parse(row.cr_issuedat) !== Date.parse(row.cr_createdat)), true);
  assert.equal(requests.every((row) => Date.parse(row.cr_completedat) !== Date.parse(row.cr_createdat)), true);
  const ninetyDays = 90 * 24 * 60 * 60 * 1000;
  assert.equal(requests.every((row) => Math.abs(Date.parse(row.cr_createdat) - Date.now()) < ninetyDays), true);
  for (const [entity, rows] of [['Person', people], ['Building', buildings], ['Door', doors], ['Badge Request', requests]]) {
    assert.equal(rows.some((row) => Object.values(row).some((value) => typeof value === 'string' && new RegExp(`^${entity} \\d+$`).test(value))), false);
  }
});

test('three unrelated brief vocabularies produce disjoint rendered strings', (t) => {
  const cases = [
    {
      brief: 'Build a field inspection app for warehouse technicians.',
      vocabulary: makeVocabulary(),
    },
    {
      brief: 'Build a wildlife rehabilitation app for veterinarians and animal care volunteers.',
      vocabulary: makeVocabulary({
        domain: 'wildlife rehabilitation', roles: ['veterinarians', 'animal care volunteers'], prefix: 'WLD',
        pools: {
          company: ['Coastal Wildlife Rescue', 'Greenwing Veterinary Network', 'Riverbend Raptor Centre', 'Wildhaven Care Alliance', 'Meadow Flight Foundation', 'Northshore Avian Clinic'],
          location: ['Wetland Recovery Campus', 'Forest Edge Release Site', 'Lakeside Veterinary Wing', 'Coastal Intake Centre'],
          door: ['Quarantine Flight Pen', 'Raptor Treatment Room', 'Songbird Nursery Zone', 'Waterfowl Recovery Enclosure', 'Medication Preparation Area', 'Release Crate Station'],
          title: ['Review kestrel treatment plan', 'Prepare heron release assessment', 'Record owl feeding response', 'Schedule songbird medical review', 'Transfer tern to recovery enclosure', 'Document eagle wing rehabilitation'],
          note: ['Weight trend supports continued recovery', 'Flight strength needs another assessment', 'Feeding response is improving', 'Release weather window is being monitored', 'Veterinary medication was administered'],
        },
      }),
    },
    {
      brief: 'Build a craft brewery quality app for brewers and laboratory technicians.',
      vocabulary: makeVocabulary({
        domain: 'craft brewery quality', roles: ['brewers', 'laboratory technicians'], prefix: 'BRW',
        pools: {
          company: ['Copper Kettle Brewing', 'Maltline Laboratory Services', 'Hearthstone Hop Supply', 'Clearwort Quality Partners', 'Barrelhouse Packaging', 'Golden Grain Cooperative'],
          location: ['Main Brewhouse Floor', 'Oak Barrel Cellar', 'Riverside Taproom', 'South Packaging Hall'],
          door: ['Fermentation Tank Bay', 'Yeast Culture Room', 'Cold Cellar Zone', 'Quality Sample Bench', 'Canning Line Gate', 'Hop Storage Room'],
          title: ['Inspect lager fermentation tank', 'Review packaged stout release', 'Record pale ale batch sample', 'Investigate cellar contamination finding', 'Approve seasonal canning run', 'Verify taproom keg quality'],
          note: ['Gravity reading is within target', 'Sample aroma needs laboratory review', 'Packaging seal passed inspection', 'Fermentation temperature remained stable', 'Contamination swab requires follow-up'],
        },
      }),
    },
  ];
  const renderedSets = [];
  for (const [index, entry] of cases.entries()) {
    const root = makeProject(t, {
      'brief.md': entry.brief,
      'native-app-plan.md': '## Data Model\n\nApproved in the contract.\n\n## Connectors\n\nNone.\n',
      '.tmp/seed-vocabulary.json': JSON.stringify(entry.vocabulary),
      '.tmp/dataverse-schema-contract.json': JSON.stringify(simpleContract()),
    });
    const result = run(root);
    assert.equal(result.status, 0, `${index}: ${result.stderr}`);
    const rows = JSON.parse(fs.readFileSync(path.join(root, 'src/generated/services/Cr_workitem.seed.json'), 'utf8'));
    assert.equal(rows.length, 12);
    renderedSets.push(new Set(rows.flatMap((row) => [row.cr_name, row.cr_company, row.cr_location, row.cr_notes])));
  }
  for (let left = 0; left < renderedSets.length; left += 1) {
    for (let right = left + 1; right < renderedSets.length; right += 1) {
      assert.deepEqual([...renderedSets[left]].filter((value) => renderedSets[right].has(value)), []);
    }
  }
});

test('fails closed when the seed vocabulary or a required field pool is missing', (t) => {
  const files = {
    'brief.md': 'A field inspection app for warehouse technicians.',
    'native-app-plan.md': '## Data Model\n\nApproved in the contract.\n',
    '.tmp/dataverse-schema-contract.json': JSON.stringify({
      schemaVersion: 1,
      tables: [{
        logicalName: 'cr_item', displayName: 'Item', plannedDecision: 'create', dependencyTier: 0, serviceRequired: true,
        columns: [
          { logicalName: 'cr_name', displayName: 'Name', type: 'string', primaryName: true },
          { logicalName: 'cr_status', displayName: 'Status', type: 'string' },
        ],
      }],
    }),
  };
  const root = makeProject(t, files);
  const noVocabulary = run(root);
  assert.equal(noVocabulary.status, 1);
  assert.match(noVocabulary.stderr, /missing \.tmp\/seed-vocabulary\.json/);

  writeProjectFile(root, '.tmp/seed-vocabulary.json', vocabularyFile());
  const missingPool = run(root);
  assert.equal(missingPool.status, 1);
  assert.match(missingPool.stderr, /pool "status" is required/);
});

test('fails closed when a choice label is a raw optionset integer', (t) => {
  const root = makeProject(t, {
    'brief.md': 'A field inspection app for warehouse technicians.',
    'native-app-plan.md': '## Data Model\n\nApproved in the contract.\n',
    '.tmp/seed-vocabulary.json': vocabularyFile(),
    '.tmp/dataverse-schema-contract.json': JSON.stringify({
      schemaVersion: 1,
      tables: [{
        logicalName: 'cr_item', displayName: 'Item', plannedDecision: 'create', dependencyTier: 0, serviceRequired: true,
        columns: [
          { logicalName: 'cr_name', displayName: 'Name', type: 'string', primaryName: true },
          {
            logicalName: 'cr_status', displayName: 'Status', type: 'choice',
            options: [{ value: 100000000, label: '100000000' }],
          },
        ],
      }],
    }),
  });
  const result = run(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /label must be human-readable, not a raw optionset integer/);
});

test('does not contain fixed domain packs or generic entity-number rendering', () => {
  const generator = fs.readFileSync(script, 'utf8');
  assert.doesNotMatch(generator, /DOMAIN_PACKS|function domainPack/);
  assert.doesNotMatch(generator, /`\$\{entity\.displayName\} \$\{index \+ 1\}`/);
  assert.doesNotMatch(generator, /Milk top-up|Avery Johnson|Priority review/);
});

test('supports the legacy Markdown entity blocks from the test branch', (t) => {
  const root = makeProject(t, {
    'brief.md': 'A field inspection app for warehouse technicians.',
    '.tmp/seed-vocabulary.json': vocabularyFile(),
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
    'brief.md': 'A field inspection app for field inspectors.',
    '.tmp/seed-vocabulary.json': vocabularyFile({ roles: ['field inspectors'] }),
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
  assert.equal(inspectionReport.preservedRows, 12);
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