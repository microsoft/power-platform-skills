'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { collectReferencedEntityNames, scopeCustomTables } = require('../lib/resolve-site-tables');

function makeProject(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resolve-site-tables-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeTablePermission(root, fileBase, entityLogicalName, displayName) {
  const dir = path.join(root, '.powerpages-site', 'table-permissions');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${fileBase}.tablepermission.yml`),
    [
      'adx_entitypermission_webrole:',
      '- ad89f5ee-8665-f111-a826-6045bd00fdda',
      'append: true',
      'appendto: true',
      'create: true',
      'delete: true',
      `entitylogicalname: ${entityLogicalName}`,
      `entityname: ${displayName}`,
      'id: f03fefed-8665-f111-a826-000d3a597e6a',
      'read: true',
      'scope: 756150000',
      'write: true',
      '',
    ].join('\n'),
  );
}

test('collectReferencedEntityNames: extracts entitylogicalname from table permissions (EDM bp_* fixture)', (t) => {
  const root = makeProject(t);
  writeTablePermission(root, 'Admin-to-Permits', 'bp_defaultapplication', 'Admin to Permits');
  writeTablePermission(root, 'Permit-Steps', 'bp_permitstep', 'Permit Steps');
  writeTablePermission(root, 'Notes-Global', 'annotation', 'Notes Global'); // standard table

  const { names, available, sources } = collectReferencedEntityNames({ projectRoot: root });
  assert.equal(available, true);
  assert.equal(sources.tablePermissions, 3);
  assert.ok(names.has('bp_defaultapplication'));
  assert.ok(names.has('bp_permitstep'));
  assert.ok(names.has('annotation'));
  // entityname (display label) must NOT be added.
  assert.ok(!names.has('admin to permits'));
});

test('collectReferencedEntityNames: unions datamodel manifest entities', (t) => {
  const root = makeProject(t);
  writeTablePermission(root, 'Permit', 'bp_permit', 'Permit');
  fs.writeFileSync(
    path.join(root, '.datamodel-manifest.json'),
    JSON.stringify({ entities: [{ logicalName: 'new_extra' }, { logicalName: 'bp_permit' }] }),
  );
  const { names, sources } = collectReferencedEntityNames({ projectRoot: root });
  assert.ok(names.has('bp_permit'));
  assert.ok(names.has('new_extra'));
  assert.ok(sources.manifest >= 1);
});

test('collectReferencedEntityNames: available=false when no .powerpages-site and no manifest', (t) => {
  const root = makeProject(t);
  const { names, available } = collectReferencedEntityNames({ projectRoot: root });
  assert.equal(available, false);
  assert.equal(names.size, 0);
});

test('scopeCustomTables: keeps only referenced custom tables; drops unreferenced + standard', (t) => {
  const root = makeProject(t);
  writeTablePermission(root, 'Permit', 'bp_permit', 'Permit');
  writeTablePermission(root, 'Inspection', 'BP_Inspection', 'Inspection'); // mixed case
  writeTablePermission(root, 'Notes', 'annotation', 'Notes'); // standard

  const { names } = collectReferencedEntityNames({ projectRoot: root });

  // Simulate the env's custom-unmanaged tables (the old prefix dump would return all of these).
  const customUnmanaged = [
    { logicalName: 'bp_permit', metadataId: 'm1' },
    { logicalName: 'bp_inspection', metadataId: 'm2' },
    { logicalName: 'new_unrelated1', metadataId: 'm3' },   // not referenced -> dropped
    { logicalName: 'new_unrelated2', metadataId: 'm4' },   // not referenced -> dropped
  ];
  const scoped = scopeCustomTables(names, customUnmanaged).map((t2) => t2.logicalName).sort();
  assert.deepEqual(scoped, ['bp_inspection', 'bp_permit']);
  // 'annotation' is referenced but not in the custom-unmanaged list -> naturally excluded.
});

test('scopeCustomTables: empty referenced set -> empty (never a prefix dump)', () => {
  assert.deepEqual(scopeCustomTables(new Set(), [{ logicalName: 'new_x' }]), []);
});

test('collectReferencedEntityNames: sources.tablePermissions reflects FILE existence even when files are unparseable', (t) => {
  const root = makeProject(t);
  const dir = path.join(root, '.powerpages-site', 'table-permissions');
  fs.mkdirSync(dir, { recursive: true });
  // A malformed permission file — present, but yields no entitylogicalname. Without
  // counting files up-front, sources.tablePermissions would be 0 and a real site
  // would be misclassified manifest-only/unavailable by tableCountScope.
  fs.writeFileSync(path.join(dir, 'broken.tablepermission.yml'), ':\n  not: [valid yaml }}}\n');

  const { names, available, sources } = collectReferencedEntityNames({ projectRoot: root });
  assert.equal(available, true, 'the table-permissions dir exists → available');
  assert.equal(sources.tablePermissions, 1, 'counts the permission FILE, not parsed records (0 parsed here)');
  assert.equal(names.size, 0, 'no entity names parsed from the malformed file');
});
