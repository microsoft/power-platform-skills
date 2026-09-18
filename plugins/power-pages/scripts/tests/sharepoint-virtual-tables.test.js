const test = require('node:test');
const assert = require('node:assert/strict');

const {
  EMPTY_GUID,
  SHAREPOINT_PROVIDER_COLUMNS,
  VIRTUAL_TEXT_MAX_LENGTH,
  buildVirtualTableDefinition,
  classifyColumns,
  findSeedTable,
  isSharePointDataSource,
  listVirtualTables,
  makerPortalWizardUrl,
  WIZARD_BREADCRUMBS,
} = require('../lib/sharepoint-virtual-tables');

const PROVIDER = 'aaaaaaaa-1111-2222-3333-444444444444';
const SOURCE = 'bbbbbbbb-1111-2222-3333-444444444444';

function definition(overrides = {}) {
  return buildVirtualTableDefinition({
    schemaName: 'cr123_Policy',
    displayName: 'Policy',
    pluralName: 'Policies',
    externalName: 'Policies',
    dataProviderId: PROVIDER,
    dataSourceId: SOURCE,
    primaryColumnSchemaName: 'cr123_Title',
    primaryColumnDisplayName: 'Title',
    primaryColumnExternalName: 'Title',
    ...overrides,
  });
}

test('the table definition binds the provider, the data source, and the external list', () => {
  const body = definition();
  assert.equal(body.DataProviderId, PROVIDER);
  assert.equal(body.DataSourceId, SOURCE);
  assert.equal(body.ExternalName, 'Policies');
  assert.equal(body.ExternalCollectionName, 'Policies');
  assert.equal(body.SchemaName, 'cr123_Policy');
  // Virtual tables cannot be user-owned, so the row filtering that comes with
  // ownership is unavailable and every access decision falls to Power Pages.
  assert.equal(body.OwnershipType, 'OrganizationOwned');
});

test('only the primary name column is declared, mapped to its SharePoint column', () => {
  const body = definition();
  assert.equal(body.Attributes.length, 1);
  const [primary] = body.Attributes;
  assert.equal(primary.IsPrimaryName, true);
  assert.equal(primary.ExternalName, 'Title');
  assert.equal(primary.SchemaName, 'cr123_Title');
});

test('an explicit external collection name overrides the singular default', () => {
  assert.equal(definition({ externalCollectionName: 'PolicyDocuments' }).ExternalCollectionName, 'PolicyDocuments');
});

test('a missing required value fails before any request is made', () => {
  assert.throws(() => definition({ dataSourceId: '' }), /dataSourceId/);
  assert.throws(() => definition({ externalName: '   ' }), /externalName/);
});

test('a primary column longer than a virtual text column is refused', () => {
  assert.throws(
    () => definition({ primaryColumnMaxLength: VIRTUAL_TEXT_MAX_LENGTH + 1 }),
    new RegExp(String(VIRTUAL_TEXT_MAX_LENGTH)),
  );
});

test('SharePoint data sources are recognized by their connector type', () => {
  assert.equal(isSharePointDataSource({ connectorType: 'SharePointOnline' }), true);
  assert.equal(isSharePointDataSource({ connectorType: 'sharepoint' }), true);
  assert.equal(isSharePointDataSource({ connectorType: 'SQL' }), false);
  assert.equal(isSharePointDataSource({ connectorType: null }), false);
  assert.equal(isSharePointDataSource(null), false);
});

test('the seed table is an unmanaged table already bound to the wanted data source', () => {
  const tables = [
    { logicalName: 'cr123_managed', dataProviderId: PROVIDER, dataSourceId: SOURCE, isManaged: true },
    { logicalName: 'cr123_partner', dataProviderId: PROVIDER, dataSourceId: SOURCE, isManaged: false },
    { logicalName: 'cr123_other', dataProviderId: PROVIDER, dataSourceId: 'cccccccc-0000-0000-0000-000000000000', isManaged: false },
  ];
  assert.equal(findSeedTable(tables, { dataSourceId: SOURCE }).logicalName, 'cr123_partner');
  assert.equal(findSeedTable(tables).logicalName, 'cr123_partner');
  assert.equal(findSeedTable(tables, { dataSourceId: 'dddddddd-0000-0000-0000-000000000000' }), null);
});

test('a table without a data source is never used as a seed', () => {
  assert.equal(findSeedTable([{ logicalName: 'cr123_none', dataProviderId: PROVIDER, dataSourceId: null }]), null);
});

test('provider bookkeeping columns are kept out of the exposable set', () => {
  const columns = [
    { logicalName: 'cr123_policyid', externalName: 'ID', isPrimaryId: true, isReadable: true },
    { logicalName: 'cr123_complianceassetid', externalName: SHAREPOINT_PROVIDER_COLUMNS[1], isPrimaryId: false, isReadable: true },
    { logicalName: 'cr123_title', externalName: 'Title', isPrimaryId: false, isReadable: true },
    { logicalName: 'cr123_hidden', externalName: 'Hidden', isPrimaryId: false, isReadable: false },
  ];
  const { exposable, providerColumns, unreadable } = classifyColumns(columns);
  assert.deepEqual(exposable.map((column) => column.logicalName), ['cr123_title']);
  assert.deepEqual(providerColumns.map((column) => column.logicalName), ['cr123_policyid', 'cr123_complianceassetid']);
  assert.deepEqual(unreadable.map((column) => column.logicalName), ['cr123_hidden']);
});

test('listing virtual tables keeps only tables actually bound to a provider', async () => {
  // Dataverse returns the all-zero Guid rather than null for an unset metadata
  // Guid, so an ordinary custom table looks "bound" unless that value is excluded.
  const page = {
    value: [
      { LogicalName: 'cr123_plain', SchemaName: 'cr123_Plain', DataProviderId: EMPTY_GUID, DataSourceId: EMPTY_GUID, IsManaged: false },
      { LogicalName: 'cr123_policy', SchemaName: 'cr123_Policy', EntitySetName: 'cr123_policies', DataProviderId: PROVIDER, DataSourceId: SOURCE, ExternalName: 'Policies', IsManaged: false },
    ],
  };
  const request = async ({ url }) => {
    assert.match(url, /EntityDefinitions\?\$select=/);
    return { statusCode: 200, body: JSON.stringify(page) };
  };
  const tables = await listVirtualTables('https://contoso.crm.dynamics.com', 'token', request);
  assert.deepEqual(tables.map((table) => table.logicalName), ['cr123_policy']);
  assert.equal(tables[0].dataSourceId, SOURCE);
  assert.equal(tables[0].externalName, 'Policies');
});

test('the wizard link opens the approved environment when its id is known', () => {
  const target = makerPortalWizardUrl({ cloud: 'Public', environmentId: 'd664a1f5-5c5b-efbf-9cc9-c1923c437109' });
  assert.equal(target.url, 'https://make.powerapps.com/environments/d664a1f5-5c5b-efbf-9cc9-c1923c437109/solutions');
  assert.equal(target.environmentScoped, true);
});

test('an unknown environment opens the portal root rather than a guessed route', () => {
  for (const environmentId of [null, '', 'not-a-guid']) {
    const target = makerPortalWizardUrl({ environmentId });
    assert.equal(target.url, 'https://make.powerapps.com/');
    assert.equal(target.environmentScoped, false);
  }
});

test('sovereign clouds get their own maker host, never the public one', () => {
  // A government tenant sent to make.powerapps.com lands on a portal its account
  // cannot sign into, which reads to the user as the wizard being broken.
  assert.match(makerPortalWizardUrl({ cloud: 'UsGov' }).url, /^https:\/\/make\.gov\.powerapps\.us\//);
  assert.match(makerPortalWizardUrl({ cloud: 'UsGovHigh' }).url, /^https:\/\/make\.high\.powerapps\.us\//);
  assert.match(makerPortalWizardUrl({ cloud: 'UsGovDod' }).url, /^https:\/\/make\.apps\.appsplatform\.us\//);
  assert.match(makerPortalWizardUrl({ cloud: 'China' }).url, /^https:\/\/make\.powerapps\.cn\//);
  assert.match(makerPortalWizardUrl({ cloud: 'Unrecognized' }).url, /^https:\/\/make\.powerapps\.com\//);
});

test('the breadcrumbs name both wizard surfaces so a moved link is recoverable', () => {
  assert.match(WIZARD_BREADCRUMBS.powerApps, /Virtual table/);
  assert.match(WIZARD_BREADCRUMBS.powerPages, /New table from external data/);
});
