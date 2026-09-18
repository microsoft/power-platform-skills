const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  buildSharing,
  emptyManifest,
  readSharingManifest,
  upsertSharingEntry,
  writeSharingManifest,
} = require('../lib/sharepoint-sharing-map');
const { buildSharingReport } = require('../lib/sharepoint-sharing-report');
const { validateArtifact, readArtifact } = require('../render-sharepoint-artifact');

const PARTNER_ROLE = '11111111-1111-1111-1111-111111111111';
const ANONYMOUS_ROLE = '22222222-2222-2222-2222-222222222222';

function manifest(overrides = {}) {
  return {
    version: 1,
    updatedAt: '2026-09-17T10:00:00Z',
    entries: [{
      source: { site: 'https://contoso.sharepoint.com/sites/Partners', listName: 'Policies' },
      table: { logicalName: 'cr123_policy', schemaName: 'cr123_Policy', displayName: 'Policy', entitySetName: 'cr123_policies' },
      provisioning: { dataSourceId: 'bbbb', createdAt: '2026-09-17T09:58:00Z', verified: true },
      columns: [
        { logicalName: 'cr123_title' },
        { logicalName: 'cr123_effectivedate' },
        { logicalName: 'cr123_internalnotes' },
      ],
      ...overrides,
    }],
  };
}

function config({ roles = 'partner', scope = 756150000, operations = { read: true }, fields = 'cr123_title,cr123_effectivedate', enabled = true } = {}) {
  const webRoles = [
    { id: PARTNER_ROLE, name: 'Partner', anonymoususersrole: false, authenticatedusersrole: true },
    { id: ANONYMOUS_ROLE, name: 'Anonymous Users', anonymoususersrole: true, authenticatedusersrole: false },
  ];
  const roleIds = roles === 'anonymous' ? [ANONYMOUS_ROLE] : roles === 'missing' ? ['99999999-9999-9999-9999-999999999999'] : [PARTNER_ROLE];
  return {
    webRoles,
    tablePermissions: roles === 'none' ? [] : [{
      entityname: 'Policies Read',
      entitylogicalname: 'cr123_policy',
      filePath: '/site/.powerpages-site/table-permissions/Policies-Read.tablepermission.yml',
      scope,
      adx_entitypermission_webrole: roleIds,
      ...operations,
    }],
    siteSettings: [
      ...(enabled === null ? [] : [{ name: 'Webapi/cr123_policy/enabled', value: enabled, filePath: '/site/a.yml' }]),
      ...(fields === null ? [] : [{ name: 'Webapi/cr123_policy/fields', value: fields, filePath: '/site/b.yml' }]),
    ],
  };
}

function codes(sharing) {
  return sharing.rows[0].findings.map((item) => item.code).sort();
}

test('a signed-in read grant reports as reachable by its web roles', () => {
  const sharing = buildSharing(manifest(), config());
  const [row] = sharing.rows;
  assert.equal(row.reach, 'authenticated');
  assert.deepEqual(row.operations, ['read']);
  assert.deepEqual(row.permissions[0].roles.map((role) => role.name), ['Partner']);
  assert.equal(row.webApi.enabled, true);
});

test('an anonymous web role is the highest-severity finding, because the list becomes public', () => {
  const sharing = buildSharing(manifest(), config({ roles: 'anonymous' }));
  const anonymous = sharing.rows[0].findings.find((item) => item.code === 'anonymous-role');
  assert.equal(sharing.rows[0].reach, 'anonymous');
  assert.equal(anonymous.severity, 'danger');
  assert.match(anonymous.message, /Anonymous Users/);
});

test('an anonymous grant the Web API does not share yet still raises a must-fix finding', () => {
  const sharing = buildSharing(manifest(), config({ roles: 'anonymous', enabled: null }));
  // Nothing can fetch it today, so calling it publicly reachable would overstate
  // the risk; enabling the setting later would make it public, so it must not be
  // silently downgraded either.
  assert.equal(sharing.rows[0].reach, 'not-reachable');
  assert.ok(codes(sharing).includes('anonymous-role'));
  assert.equal(sharing.rows[0].findings.find((item) => item.code === 'anonymous-role').severity, 'danger');
});

test('a wildcard field allowlist is flagged as unsupported and over-exposing', () => {
  const sharing = buildSharing(manifest(), config({ fields: '*' }));
  const wildcard = sharing.rows[0].findings.find((item) => item.code === 'wildcard-fields');
  assert.equal(wildcard.severity, 'danger');
  assert.match(wildcard.message, /14 September 2026/);
});

test('Web API enabled without any table permission is reported as unreachable, not as working', () => {
  const sharing = buildSharing(manifest(), config({ roles: 'none' }));
  assert.equal(sharing.rows[0].reach, 'not-reachable');
  assert.ok(codes(sharing).includes('no-permission'));
});

test('a permission with no Web API setting is reported as blocked at the API layer', () => {
  const sharing = buildSharing(manifest(), config({ enabled: null }));
  const finding = sharing.rows[0].findings.find((item) => item.code === 'webapi-not-enabled');
  assert.equal(finding.severity, 'warning');
  assert.equal(sharing.rows[0].reach, 'not-reachable');
});

test('an enabled table with no field allowlist is reported, because every column read is refused', () => {
  const sharing = buildSharing(manifest(), config({ fields: null }));
  assert.ok(codes(sharing).includes('fields-missing'));
});

test('Global scope is reported because SharePoint item permissions do not carry across', () => {
  const finding = buildSharing(manifest(), config()).rows[0].findings.find((item) => item.code === 'global-scope');
  assert.match(finding.message, /every row/);
});

test('Contact scope does not raise the Global-scope finding', () => {
  const sharing = buildSharing(manifest(), config({ scope: 756150001 }));
  assert.ok(!codes(sharing).includes('global-scope'));
  assert.equal(sharing.rows[0].permissions[0].scope, 'Contact');
});

test('write operations are reported as changes to the SharePoint list itself', () => {
  const sharing = buildSharing(manifest(), config({ operations: { read: true, write: true, delete: true } }));
  const finding = sharing.rows[0].findings.find((item) => item.code === 'write-back');
  assert.match(finding.message, /write, delete/);
  assert.match(finding.message, /SharePoint list itself/);
});

test('an allowlisted column that matches no recorded column is caught before it 403s at runtime', () => {
  const sharing = buildSharing(manifest(), config({ fields: 'cr123_title,cr123_Typo' }));
  const finding = sharing.rows[0].findings.find((item) => item.code === 'allowlist-column-unknown');
  assert.match(finding.message, /cr123_Typo/);
});

test('a lookup read form resolves to its own column rather than looking unknown', () => {
  const sharing = buildSharing(
    manifest({ columns: [{ logicalName: 'cr123_owner' }] }),
    config({ fields: '_cr123_owner_value' }),
  );
  assert.ok(!codes(sharing).includes('allowlist-column-unknown'));
});

test('a permission naming a web role with no file is reported as unknown access', () => {
  const sharing = buildSharing(manifest(), config({ roles: 'missing' }));
  assert.ok(codes(sharing).includes('role-not-found'));
});

test('columns absent from the allowlist are reported as withheld', () => {
  const [row] = buildSharing(manifest(), config()).rows;
  assert.deepEqual(row.columns.shared.map((column) => column.logicalName), ['cr123_title', 'cr123_effectivedate']);
  assert.deepEqual(row.columns.withheld.map((column) => column.logicalName), ['cr123_internalnotes']);
});

test('Web API tables outside this workflow are named rather than claimed', () => {
  const other = config();
  other.siteSettings.push({ name: 'Webapi/account/enabled', value: true, filePath: '/site/c.yml' });
  assert.deepEqual(buildSharing(manifest(), other).otherWebApiTables, ['account']);
});

test('the generated report passes the artifact schema and names the sharing record', () => {
  const report = buildSharingReport(buildSharing(manifest(), config()));
  assert.doesNotThrow(() => validateArtifact(report));
  assert.equal(report.artifact, 'sharing');
  assert.ok(report.links.some((link) => link.artifact === 'sharing'));
  assert.match(report.summary, /1 SharePoint list is shared/);
});

test('an empty manifest still produces a valid report that says nothing is shared', () => {
  const report = buildSharingReport(buildSharing(emptyManifest(), config({ roles: 'none' })));
  assert.doesNotThrow(() => validateArtifact(report));
  assert.match(report.summary, /No SharePoint list is shared/);
});

test('the manifest round-trips and replaces an entry in place', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sharepoint-sharing-'));
  try {
    let current = emptyManifest();
    current = upsertSharingEntry(current, { table: { logicalName: 'cr123_a' }, columns: [] });
    current = upsertSharingEntry(current, { table: { logicalName: 'cr123_b' }, columns: [] });
    current = upsertSharingEntry(current, { table: { logicalName: 'cr123_a' }, columns: [{ logicalName: 'x' }] });
    writeSharingManifest(dir, current);
    const reloaded = readSharingManifest(dir);
    assert.deepEqual(reloaded.entries.map((entry) => entry.table.logicalName), ['cr123_a', 'cr123_b']);
    assert.deepEqual(reloaded.entries[0].columns, [{ logicalName: 'x' }]);
    assert.ok(reloaded.updatedAt);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an entry without a table logical name is refused', () => {
  assert.throws(() => upsertSharingEntry(emptyManifest(), { table: {} }), /table\.logicalName/);
});

test('the CLI renders the sharing map from the project on disk', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sharepoint-sharing-cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const siteDir = path.join(dir, '.powerpages-site');
  fs.mkdirSync(path.join(siteDir, 'web-roles'), { recursive: true });
  fs.mkdirSync(path.join(siteDir, 'table-permissions'), { recursive: true });
  fs.mkdirSync(path.join(siteDir, 'site-settings'), { recursive: true });
  fs.writeFileSync(path.join(siteDir, 'web-roles', 'partner.webrole.yml'),
    `anonymoususersrole: false\nauthenticatedusersrole: true\nid: ${PARTNER_ROLE}\nname: Partner\n`);
  fs.writeFileSync(path.join(siteDir, 'table-permissions', 'Policies-Read.tablepermission.yml'),
    `adx_entitypermission_webrole:\n- ${PARTNER_ROLE}\nentitylogicalname: cr123_policy\nentityname: Policies Read\nid: 33333333-3333-3333-3333-333333333333\nread: true\nscope: 756150000\n`);
  fs.writeFileSync(path.join(siteDir, 'site-settings', 'Webapi-cr123_policy-enabled.sitesetting.yml'),
    'id: 44444444-4444-4444-4444-444444444444\nname: Webapi/cr123_policy/enabled\nvalue: true\n');
  fs.writeFileSync(path.join(dir, '.sharepoint-sharing.json'), `${JSON.stringify(manifest(), null, 2)}\n`);

  const script = path.join(__dirname, '..', 'build-sharing-map.js');
  const first = spawnSync(process.execPath, [script, '--projectRoot', dir], { encoding: 'utf8' });
  assert.equal(first.status, 0, first.stderr);
  const result = JSON.parse(first.stdout);
  assert.equal(result.lists, 1);
  assert.equal(readArtifact(result.output).integrity, 'valid');

  // Regeneration must go through the guarded update path rather than failing on
  // the existing file, so the page can be refreshed after every permission change.
  const second = spawnSync(process.execPath, [script, '--projectRoot', dir], { encoding: 'utf8' });
  assert.equal(second.status, 0, second.stderr);

  // A hand-edited page is reported instead of silently replaced.
  fs.appendFileSync(result.output, '<!-- edited -->\n');
  const third = spawnSync(process.execPath, [script, '--projectRoot', dir], { encoding: 'utf8' });
  assert.equal(third.status, 1);
  assert.match(third.stderr, /manual edits/);
});
