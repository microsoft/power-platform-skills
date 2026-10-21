'use strict';
// The CONTRACT of the stateful fake the lifecycle tests run on (helpers/fake-lifecycle-org.js, fake-lifecycle-metadata.js): a read it
// does not model must FAIL LOUD — 501 and an entry in `org.unexpected`, which every lifecycle test asserts is empty — and never answer
// an empty success that the code under test could take for "nothing there". Each refusal is pinned twice, over a collection that holds
// rows and over one that holds none (the check runs before any row is looked at), beside a control that the same shape with a known
// name is answered. A read it DOES accept must answer what it asks for — every option applied, pinned on the values and the row counts
// it returns; a function's arguments and a record's key are checked before anything is resolved. And the content proof the lifecycle
// tests rely on (org.contents + diffContents) is pinned to see an overwrite the identity inventory cannot.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createLifecycleOrg } = require('./helpers/fake-lifecycle-org.js');
const { seedForeignWork, diffContents, FOREIGN } = require('./helpers/lifecycle-harness.js');

const BASIC_USER = '11111111-0000-4000-8000-000000000007';

async function send(org, method, where, body, headers = {}) {
  const from = org.unexpected.length;
  const res = await org.request({ url: `${org.API}${where}`, method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null, unexpected: org.unexpected.slice(from) };
}
// A fresh environment with another maker's work in it (populated), and one with nothing but what a new environment has (empty).
async function populated() {
  const org = createLifecycleOrg();
  await seedForeignWork(org);
  return org;
}
const empty = async () => createLifecycleOrg();

// A refusal: 501, the platform's error envelope, and one `unexpected` entry that names what was not modelled.
function refused(res, names) {
  assert.equal(res.status, 501, JSON.stringify(res.body));
  assert.equal(res.unexpected.length, 1);
  assert.match(res.unexpected[0], names);
  assert.match(res.body.error.message, /does not model/);
}
const answered = (res) => { assert.equal(res.status, 200, JSON.stringify(res.body)); assert.deepEqual(res.unexpected, []); return res.body; };

// The record reads. `workflows` holds no row in either environment, `solutions` and `roles` hold several.
const RECORD_CASES = [
  { what: 'an unknown column in $filter', populated: "/solutions?$filter=unmodelledfield eq 'FabrikamCore'", empty: "/workflows?$filter=unmodelledfield eq 'x'", names: /no column unmodelledfield/, control: "/solutions?$filter=uniquename eq 'FabrikamCore'&$select=solutionid" },
  { what: 'an unknown filter function', populated: '/solutions?$filter=mystery(uniquename)', empty: '/workflows?$filter=mystery(name)', names: /function mystery is not modelled/, control: "/solutions?$filter=contains(uniquename,'fabrikam')&$select=solutionid" },
  { what: 'an unknown column in $select', populated: '/roles?$select=roleid,unmodelledfield', empty: '/workflows?$select=workflowid,unmodelledfield', names: /no column unmodelledfield \(\$select/, control: '/roles?$select=roleid,name,description' },
  { what: 'an unknown column in $orderby', populated: '/publishers?$orderby=unmodelledfield desc', empty: '/workflows?$orderby=unmodelledfield', names: /no column unmodelledfield \(\$orderby/, control: '/publishers?$select=publisherid&$orderby=uniquename desc' },
  { what: 'an unknown query option', populated: '/roles?$apply=groupby((name))', empty: '/workflows?$count=true', names: /query option \$(apply|count) is not modelled/, control: '/roles?$select=roleid&$top=1' },
  { what: 'an unknown navigation in a lambda', populated: `/roles?$filter=unknown_association/any(x:x/roleid eq ${FOREIGN.app})`, empty: `/workflows?$filter=unknown_association/any(x:x/workflowid eq ${FOREIGN.app})`, names: /has no navigation unknown_association/, control: `/appmodules?$select=appmoduleid&$filter=appmoduleroles_association/any(x:x/roleid eq ${BASIC_USER})` },
  { what: 'an unknown column of the rows a lambda reads', populated: `/appmodules?$filter=appmoduleroles_association/any(x:x/nothere eq ${BASIC_USER})`, empty: `/appmodules?$filter=appmoduleroles_association/any(x:x/nothere eq ${BASIC_USER})`, names: /role has no column nothere/, control: `/appmodules?$select=appmoduleid&$filter=appmoduleroles_association/any(x:x/name eq 'Basic User')` },
  { what: 'a navigation path to a column that is not the key', populated: "/roles?$filter=parentrootroleid/name eq 'Basic User'", empty: "/workflows?$filter=parentworkflowid/workflowid eq null", names: /navigation path/, control: `/roles?$select=roleid&$filter=parentrootroleid/roleid eq ${BASIC_USER}` },
  { what: 'an unknown $expand', populated: '/solutions?$expand=unknownnav($select=x)', empty: '/workflows?$expand=publisherid($select=publisherid)', names: /\$expand=(unknownnav|publisherid) on/, control: '/solutions?$select=solutionid&$expand=publisherid($select=publisherid,uniquename)' },
  { what: 'an unknown column of an expanded row', populated: '/solutions?$expand=publisherid($select=nothere)', empty: '/solutions?$expand=publisherid($select=nothere)', names: /publisher has no column nothere/, control: '/solutions?$select=solutionid&$expand=publisherid($select=customizationprefix)' },
];

for (const c of RECORD_CASES) {
  test(`fake contract: ${c.what} is refused, over a collection with rows and one without`, async () => {
    refused(await send(await populated(), 'GET', c.populated), c.names);
    refused(await send(await empty(), 'GET', c.empty), c.names);
    answered(await send(await populated(), 'GET', c.control));
  });
}

test('fake contract: an unknown single-row navigation, a function and a path suffix are refused; the declared one is answered', async () => {
  const org = await populated();
  refused(await send(org, 'GET', `/roles(${BASIC_USER})/unknown_association`), /has no navigation unknown_association/);
  refused(await send(org, 'GET', `/roles(${BASIC_USER})/Microsoft.Dynamics.CRM.Mystery()`), /has no navigation|GET \/roles/);
  refused(await send(org, 'GET', `/roles(${BASIC_USER})/appmoduleroles_association/extra`), /GET \/roles/);
  refused(await send(org, 'GET', `/roles(${BASIC_USER})/appmoduleroles_association?$select=nothere`), /appmodule has no column nothere/);
  refused(await send(org, 'GET', '/notamodelledset'), /no table has the entity set notamodelledset/);
  assert.deepEqual(answered(await send(org, 'GET', `/roles(${BASIC_USER})/appmoduleroles_association?$select=appmoduleid`)).value, []);
});

test('fake contract: the page tables refuse an unknown column before the page fake sees the read', async () => {
  for (const org of [await populated(), await empty()]) {
    refused(await send(org, 'GET', '/uxagentprojects?$select=uxagentprojectid,nothere'), /uxagentproject has no column nothere/);
    refused(await send(org, 'GET', "/uxagentprojectfiles?$filter=nothere eq 'x'"), /uxagentprojectfile has no column nothere/);
    refused(await send(org, 'GET', '/uxagentprojects/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()?$filter=mystery(name)'), /function mystery/);
    answered(await send(org, 'GET', '/uxagentprojects?$select=uxagentprojectid,name'));
  }
});

test('fake contract: a column the platform lets be empty reads null; one it always fills, missing from a row, is refused', async () => {
  const org = await populated();
  const solutions = answered(await send(org, 'GET', "/solutions?$select=uniquename,description&$filter=uniquename eq 'Default'")).value;
  assert.deepEqual(solutions.map((s) => [s.uniquename, s.description]), [['Default', null]]);
  // A row the fake made without a column every row of its table has: the read names the gap instead of answering null.
  const publisher = [...org.rowsOf('publishers').values()].find((row) => row.data.uniquename === 'fabrikam');
  delete publisher.data.friendlyname;
  refused(await send(org, 'GET', '/publishers?$select=uniquename,friendlyname'), /holds no friendlyname, which the platform always fills/);
});

// The metadata reads. A fresh environment has no relationship and no global option set; the seeded one has both.
const METADATA_CASES = [
  { what: 'an unknown attribute cast', populated: "/EntityDefinitions(LogicalName='fabrikam_widget')/Attributes/Microsoft.Dynamics.CRM.UnknownAttributeMetadata", empty: "/EntityDefinitions(LogicalName='account')/Attributes/Microsoft.Dynamics.CRM.UnknownAttributeMetadata", names: /cast UnknownAttributeMetadata/, control: "/EntityDefinitions(LogicalName='fabrikam_widget')/Attributes/Microsoft.Dynamics.CRM.StringAttributeMetadata?$select=LogicalName,MaxLength" },
  { what: 'an unknown *Relationships navigation', populated: "/EntityDefinitions(LogicalName='fabrikam_widget')/UnknownRelationships", empty: "/EntityDefinitions(LogicalName='account')/UnknownRelationships", names: /UnknownRelationships is not modelled/, control: "/EntityDefinitions(LogicalName='account')/OneToManyRelationships?$select=SchemaName" },
  { what: 'an unknown GlobalOptionSetDefinitions navigation', populated: '/GlobalOptionSetDefinitions/UnknownNavigation?$select=Name', empty: '/GlobalOptionSetDefinitions/UnknownNavigation?$select=Name', names: /GlobalOptionSetDefinitions\/UnknownNavigation is not modelled/, control: '/GlobalOptionSetDefinitions?$select=Name' },
  { what: 'an unknown property in $filter', populated: "/EntityDefinitions?$select=LogicalName&$filter=UnknownProperty eq 'fabrikam_widget'", empty: "/RelationshipDefinitions?$select=SchemaName&$filter=UnknownProperty eq 'x'", names: /has no property UnknownProperty \(\$filter/, control: "/EntityDefinitions?$select=LogicalName&$filter=LogicalName eq 'fabrikam_widget'" },
  { what: 'an unknown property in $select', populated: '/GlobalOptionSetDefinitions?$select=Name,UnknownProperty', empty: '/GlobalOptionSetDefinitions?$select=Name,UnknownProperty', names: /has no property UnknownProperty \(\$select/, control: '/GlobalOptionSetDefinitions?$select=Name,IsManaged,Description' },
  { what: "a derived type's property on the base collection", populated: "/EntityDefinitions(LogicalName='fabrikam_widget')/Attributes?$select=LogicalName,MaxLength", empty: "/EntityDefinitions(LogicalName='account')/Attributes?$select=LogicalName,MaxLength", names: /AttributeMetadata has no property MaxLength/, control: "/EntityDefinitions(LogicalName='account')/Attributes?$select=LogicalName,AttributeType" },
  { what: 'an unknown $expand of a table', populated: "/EntityDefinitions(LogicalName='fabrikam_widget')?$expand=UnknownNavigation", empty: "/EntityDefinitions(LogicalName='account')?$expand=Attributes($select=MaxLength)", names: /has no (navigation UnknownNavigation|property MaxLength)/, control: "/EntityDefinitions(LogicalName='account')?$select=LogicalName&$expand=Attributes($select=LogicalName)" },
  { what: 'an unknown relationship cast', populated: '/RelationshipDefinitions/Microsoft.Dynamics.CRM.UnknownRelationshipMetadata', empty: '/RelationshipDefinitions/Microsoft.Dynamics.CRM.UnknownRelationshipMetadata', names: /cast UnknownRelationshipMetadata/, control: '/RelationshipDefinitions/Microsoft.Dynamics.CRM.OneToManyRelationshipMetadata?$select=SchemaName,ReferencedEntity' },
  { what: 'a key a collection is not keyed by', populated: "/EntityDefinitions(SchemaName='fabrikam_widget')", empty: "/EntityDefinitions(SchemaName='account')", names: /not keyed by SchemaName/, control: "/EntityDefinitions(LogicalName='account')?$select=LogicalName" },
];

for (const c of METADATA_CASES) {
  test(`fake contract: metadata — ${c.what} is refused, with definitions and without`, async () => {
    refused(await send(await populated(), 'GET', c.populated), c.names);
    refused(await send(await empty(), 'GET', c.empty), c.names);
    answered(await send(await populated(), 'GET', c.control));
  });
}

test("fake contract: a Money column's base-currency twin has the live-measured flags, and goes with the column", async () => {
  const org = await populated();
  const label = (text) => ({ LocalizedLabels: [{ Label: text, LanguageCode: 1033 }] });
  const created = await send(org, 'POST', "/EntityDefinitions(LogicalName='fabrikam_widget')/Attributes", { '@odata.type': 'Microsoft.Dynamics.CRM.MoneyAttributeMetadata', SchemaName: 'fabrikam_price', DisplayName: label('Price'), RequiredLevel: { Value: 'None' }, PrecisionSource: 2 });
  assert.equal(created.status, 204);
  const read = answered(await send(org, 'GET', "/EntityDefinitions(LogicalName='fabrikam_widget')/Attributes?$select=LogicalName,AttributeType,AttributeOf,IsLogical,IsCustomAttribute,IsValidForCreate&$filter=startswith(LogicalName,'fabrikam_price')")).value;
  const money = answered(await send(org, 'GET', "/EntityDefinitions(LogicalName='fabrikam_widget')/Attributes/Microsoft.Dynamics.CRM.MoneyAttributeMetadata?$select=LogicalName,IsBaseCurrency")).value;
  // As measured on stock opportunity.estimatedvalue / estimatedvalue_base (download-model-app.test.js pins the same shape): the twin
  // is a physical, custom, non-logical column with NO AttributeOf — only IsBaseCurrency tells it from the column it converts.
  assert.deepEqual(read.map((a) => [a.LogicalName, a.AttributeType, a.AttributeOf, a.IsLogical, a.IsCustomAttribute, a.IsValidForCreate]).sort(), [
    ['fabrikam_price', 'Money', null, false, true, true],
    ['fabrikam_price_base', 'Money', null, false, true, false],
  ]);
  assert.deepEqual(money.map((a) => [a.LogicalName, a.IsBaseCurrency]).sort(), [['fabrikam_price', false], ['fabrikam_price_base', true]]);
  assert.equal((await send(org, 'DELETE', "/EntityDefinitions(LogicalName='fabrikam_widget')/Attributes(LogicalName='fabrikam_price')")).status, 204);
  assert.deepEqual([...org.metadata.tables.get('fabrikam_widget').Attributes.keys()].filter((name) => name.startsWith('fabrikam_price')), []);
});

// MEASURED on a live environment, from a table's ManyToOneRelationships: a File column comes with a CUSTOM relationship to the stock
// table fileattachment, and an Image column with one, not custom, to imagedescriptor through its `<name>id` — each named for its table and
// column. A download reads them back (download-model-app.js mediaRelationshipKeys); each goes with its column and with its table.
test("fake contract: a File and an Image column come with the platform's relationship of each, as measured, which goes with the column and the table", async () => {
  const org = await populated();
  const label = (text) => ({ LocalizedLabels: [{ Label: text, LanguageCode: 1033 }] });
  const where = "/EntityDefinitions(LogicalName='fabrikam_widget')/Attributes";
  assert.equal((await send(org, 'POST', where, { '@odata.type': 'Microsoft.Dynamics.CRM.FileAttributeMetadata', SchemaName: 'fabrikam_manual', DisplayName: label('Manual'), RequiredLevel: { Value: 'None' }, MaxSizeInKB: 1024 })).status, 204);
  assert.equal((await send(org, 'POST', where, { '@odata.type': 'Microsoft.Dynamics.CRM.ImageAttributeMetadata', SchemaName: 'fabrikam_photo', DisplayName: label('Photo'), RequiredLevel: { Value: 'None' }, MaxSizeInKB: 10240 })).status, 204);
  const rows = async () => answered(await send(org, 'GET', "/EntityDefinitions(LogicalName='fabrikam_widget')/ManyToOneRelationships?$select=SchemaName,ReferencedEntity,ReferencingEntity,ReferencingAttribute,IsCustomRelationship")).value
    .filter((r) => /^(FileAttachment|ImageDescriptor)_/.test(r.SchemaName))
    .map((r) => [r.SchemaName, r.ReferencedEntity, r.ReferencingEntity, r.ReferencingAttribute, r.IsCustomRelationship]).sort();
  assert.deepEqual(await rows(), [
    ['FileAttachment_fabrikam_widget_fabrikam_manual', 'fileattachment', 'fabrikam_widget', 'fabrikam_manual', true],
    ['ImageDescriptor_fabrikam_widget_fabrikam_photo', 'imagedescriptor', 'fabrikam_widget', 'fabrikam_photoid', false],
  ]);
  // The parent of each is a stock table, as the platform reports fileattachment.
  assert.equal(answered(await send(org, 'GET', "/EntityDefinitions(LogicalName='fileattachment')?$select=IsCustomEntity")).IsCustomEntity, false);
  assert.equal(answered(await send(org, 'GET', "/EntityDefinitions(LogicalName='imagedescriptor')?$select=IsCustomEntity")).IsCustomEntity, false);
  assert.equal((await send(org, 'DELETE', `${where}(LogicalName='fabrikam_manual')`)).status, 204);
  assert.deepEqual((await rows()).map((r) => r[0]), ['ImageDescriptor_fabrikam_widget_fabrikam_photo'], 'the File column took its own with it');
  assert.equal((await send(org, 'DELETE', "/EntityDefinitions(LogicalName='fabrikam_widget')")).status, 204);
  assert.deepEqual([...org.metadata.relationships.keys()].filter((name) => /^(fileattachment|imagedescriptor)_/.test(name)), [], 'and the table took the rest');
});

test("fake contract: the content proof sees another maker's work overwritten, which the identity inventory does not", async () => {
  const overwrites = [
    ['the foreign view\'s FetchXML', async (org) => { const v = org.find('savedqueries', (r) => r.name === 'Open Projects')[0]; return send(org, 'PATCH', `/savedqueries(${v.savedqueryid})`, { fetchxml: '<fetch><entity name="wrong_table"/></fetch>' }); }, /changed: savedqueries .* "Open Projects" \(saved\.fetchxml, saved\.modifiedon, saved\.versionnumber\)/],
    ['the foreign web resource\'s content', async (org) => { const w = org.find('webresourceset', (r) => r.name === 'fabrikam_widget.js')[0]; return send(org, 'PATCH', `/webresourceset(${w.webresourceid})`, { content: Buffer.from('destroyed').toString('base64') }); }, /changed: webresourceset .* "fabrikam_widget\.js" \(saved\.content/],
    ['the foreign column\'s maximum length', async (org) => send(org, 'PUT', "/EntityDefinitions(LogicalName='fabrikam_widget')/Attributes(LogicalName='fabrikam_name')", { MaxLength: 1 }), /changed: table fabrikam_widget \(Attributes\.fabrikam_name\)/],
    ['the foreign global choice\'s options', async (org) => send(org, 'PUT', "/GlobalOptionSetDefinitions(Name='fabrikam_size')", { Options: [] }), /changed: global option set fabrikam_size \(.*\bOptions\)/],
  ];
  for (const [what, overwrite, reported] of overwrites) {
    const org = await populated();
    const inventory = org.inventory();
    const before = org.contents();
    const res = await overwrite(org);
    assert.equal(res.status, 204, what);
    assert.deepEqual(org.inventory(), inventory, `${what}: the identity inventory does not see it`);
    const changes = diffContents(before, org.contents());
    assert.equal(changes.length, 1, `${what}: ${JSON.stringify(changes)}`);
    assert.match(changes[0], reported, what);
  }
});

// ====================================================================================================================================
// What an ACCEPTED read answers: every option the checker admits is applied — the values and the row counts below, not only the status.

// A second page that only has a draft, next to the published one the seed made: the two layers a page read can see.
const DRAFT_PAGE = '33333333-0000-4000-8000-000000000001';
async function withDraftPage() {
  const org = await populated();
  org.pageServer.seedPage(DRAFT_PAGE, { name: 'AAA Page' });
  return org;
}
const keysOf = (row) => Object.keys(row).sort();

test('fake contract: a page read applies its $filter, $select, $orderby and $top, over the layer it sees', async () => {
  const org = await withDraftPage();
  const values = async (where, headers) => answered(await send(org, 'GET', where, undefined, headers)).value;
  // The plain read is the published layer: the draft page is not in it, and a filter on any column narrows it.
  assert.deepEqual(await values("/uxagentprojects?$select=uxagentprojectid&$filter=name eq 'No Such Page'"), []);
  const widget = await values("/uxagentprojects?$select=uxagentprojectid&$filter=name eq 'Widget Board'");
  assert.deepEqual(widget.map((row) => [row.uxagentprojectid, keysOf(row)]), [[FOREIGN.page, ['@odata.etag', 'uxagentprojectid']]]);
  assert.deepEqual((await values('/uxagentprojects?$select=name')).map((row) => row.name), ['Widget Board']);
  // With MSCRM.IncludeUnpublished the saved rows are seen, drafts included, in the order asked for, cut at $top.
  const unpublished = { 'MSCRM.IncludeUnpublished': 'true' };
  assert.deepEqual((await values('/uxagentprojects?$select=name&$orderby=name asc', unpublished)).map((row) => row.name), ['AAA Page', 'Widget Board']);
  assert.deepEqual((await values('/uxagentprojects?$select=name&$orderby=name desc&$top=1', unpublished)).map((row) => row.name), ['Widget Board']);
  // RetrieveUnpublishedMultiple() is the saved layer with componentstate.
  const many = '/uxagentprojects/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()';
  assert.deepEqual(await values(`${many}?$select=uxagentprojectid&$top=0`), []);
  const first = await values(`${many}?$select=uxagentprojectid&$orderby=name asc&$top=1`);
  assert.deepEqual(first.map((row) => [row.uxagentprojectid, keysOf(row)]), [[DRAFT_PAGE, ['@odata.etag', 'uxagentprojectid']]]);
  assert.deepEqual((await values(`${many}?$select=name,componentstate&$filter=componentstate eq 1`)).map((row) => [row.name, row.componentstate]), [['AAA Page', 1]]);
  assert.deepEqual((await values(`${many}?$select=name&$filter=startswith(name,'Widget')`)).map((row) => row.name), ['Widget Board']);
  // By id: the selected columns, the draft only with the header.
  const byId = answered(await send(org, 'GET', `/uxagentprojects(${FOREIGN.page})?$select=name`));
  assert.deepEqual([byId.name, keysOf(byId)], ['Widget Board', ['@odata.etag', 'name', 'uxagentprojectid']]);
  assert.equal((await send(org, 'GET', `/uxagentprojects(${DRAFT_PAGE})?$select=name`)).status, 404);
  assert.equal(answered(await send(org, 'GET', `/uxagentprojects(${DRAFT_PAGE})?$select=name`, undefined, unpublished)).name, 'AAA Page');
});

test("fake contract: a page's files and conversation are read with their own filter, order, cut and columns", async () => {
  const org = await withDraftPage();
  const values = async (where) => answered(await send(org, 'GET', where)).value;
  // The published page's four files; the draft page's are not in the published layer.
  const files = await values(`/uxagentprojectfiles?$select=filename&$filter=_uxagentprojectid_value eq ${FOREIGN.page}&$orderby=filename desc&$top=2`);
  assert.deepEqual(files.map((row) => [row.filename, keysOf(row)]), [
    ['src/pages/page.tsx', ['@odata.etag', 'filename', 'uxagentprojectfileid']],
    ['src/pages/page.compiled', ['@odata.etag', 'filename', 'uxagentprojectfileid']],
  ]);
  assert.deepEqual((await values('/uxagentprojectfiles?$select=filename&$filter=filetype eq 200000001')).map((row) => row.filename), ['src/pages/page.compiled']);
  assert.deepEqual(await values(`/uxagentprojectfiles?$select=filename&$filter=_uxagentprojectid_value eq ${DRAFT_PAGE}`), []);
  // The conversation, in the order it was had; a filter on the sender, a cut, and only the columns asked for.
  const turns = await values(`/agentconversationmessages?$select=message&$filter=_regardingobjectid_value eq ${FOREIGN.page}&$orderby=createdon asc,versionnumber asc`);
  assert.deepEqual(turns.map((row) => [row.message, keysOf(row)]), [['Seeded', ['agentconversationmessageid', 'message']], ['Done', ['agentconversationmessageid', 'message']]]);
  assert.deepEqual((await values(`/agentconversationmessages?$select=message&$filter=_regardingobjectid_value eq ${FOREIGN.page} and messagesender eq 200000001`)).map((row) => row.message), ['Done']);
  assert.deepEqual((await values(`/agentconversationmessages?$select=message&$filter=_regardingobjectid_value eq ${DRAFT_PAGE}&$orderby=versionnumber desc&$top=1`)).map((row) => row.message), ['Done']);
});

test('fake contract: a record read applies its options — $expand by id, values, counts — and a write answers its $select', async () => {
  const org = await populated();
  const single = answered(await send(org, 'GET', `/solutions(${FOREIGN.solution})?$select=solutionid&$expand=publisherid($select=customizationprefix)`));
  assert.deepEqual([keysOf(single), single.publisherid.customizationprefix, keysOf(single.publisherid)], [['@odata.etag', 'publisherid', 'solutionid'], 'fabrikam', ['@odata.etag', 'customizationprefix', 'publisherid']]);
  const values = async (where) => answered(await send(org, 'GET', where)).value;
  assert.deepEqual((await values('/roles?$select=name&$filter=ismanaged eq true&$orderby=name desc&$top=1')).map((row) => row.name), ['System Administrator']);
  assert.deepEqual(await values('/roles?$select=name&$top=0'), []);
  assert.deepEqual((await values("/roles?$select=name&$filter=ismanaged eq false and startswith(name,'Fabrikam')")).map((row) => row.name), ['Fabrikam Reader']);
  // Prefer: return=representation answers the created row narrowed by the write's own $select.
  const created = await send(org, 'POST', '/publishers?$select=uniquename', { uniquename: 'adatum', friendlyname: 'Adatum', customizationprefix: 'adatum', customizationoptionvalueprefix: 30000 }, { Prefer: 'return=representation' });
  assert.equal(created.status, 201);
  assert.deepEqual([keysOf(created.body), created.body.uniquename], [['@odata.etag', 'publisherid', 'uniquename'], 'adatum']);
});

// What a function's arguments and a record's key may be: anything else is refused before any row is resolved — never a 200 that
// ignored an argument, never a 404 that "proved" an absence.
test('fake contract: an unknown or missing function argument, and a key that is not a record id, are refused', async () => {
  const org = await populated();
  refused(await send(org, 'GET', "/RetrieveSetting(SettingName='NewLookAlwaysOn',Unknown='x')"), /the parameter Unknown of RetrieveSetting is not modelled/);
  refused(await send(org, 'GET', "/RetrieveSetting(Unknown='NewLookAlwaysOn')"), /the parameter Unknown of RetrieveSetting is not modelled/);
  refused(await send(org, 'GET', "/RetrieveSetting(AppUniqueName='fabrikam_widgets')"), /RetrieveSetting without its SettingName/);
  refused(await send(org, 'GET', '/RetrieveSetting(SettingName=@p)?@p=1'), /not modelled/);
  refused(await send(org, 'GET', "/solutions(Unknown='FabrikamCore')"), /the key \(Unknown='FabrikamCore'\) on GET \/solutions/);
  refused(await send(org, 'PATCH', "/solutions(Unknown='FabrikamCore')", { description: 'x' }), /the key \(Unknown='FabrikamCore'\)/);
  refused(await send(org, 'GET', '/roles(basic-user)/appmoduleroles_association?$select=appmoduleid'), /the key \(basic-user\)/);
  refused(await send(org, 'GET', "/uxagentprojects(name='Widget Board')"), /the key \(name='Widget Board'\)/);
  refused(await send(org, 'GET', "/systemforms(formid='x')/Microsoft.Dynamics.CRM.RetrieveUnpublished()?$select=name"), /the key \(formid='x'\)/);
  refused(await send(org, 'POST', '/roles', { name: 'Adatum Reader', 'businessunitid@odata.bind': "/businessunits(name='contoso')" }), /the key \(name='contoso'\) on the bind/);
  refused(await send(org, 'GET', "/systemforms/Microsoft.Dynamics.CRM.RetrieveFilteredForms(EntityLogicalName=@e,FormType=@t,User=@u)?@e='fabrikam_widget'&@t=2&@u={'@odata.id':'systemusers(44444444-0000-4000-8000-000000000001)'}"), /only the maker is/);
  // The same reads, well formed, are answered.
  assert.equal(answered(await send(org, 'GET', "/RetrieveSetting(SettingName='NewLookAlwaysOn')")).SettingDetail.Value, 'false');
  assert.equal(answered(await send(org, 'GET', "/RetrieveSetting(SettingName='NewLookAlwaysOn',AppUniqueName='fabrikam_widgets')")).SettingDetail.Value, 'false');
  assert.equal(answered(await send(org, 'GET', `/solutions(${FOREIGN.solution})?$select=uniquename`)).uniquename, 'FabrikamCore');
  assert.equal((await send(org, 'GET', '/solutions(44444444-0000-4000-8000-000000000001)?$select=uniquename')).status, 404, 'a well-formed id that names no row is the platform\'s 404');
  assert.deepEqual(answered(await send(org, 'GET', "/systemforms/Microsoft.Dynamics.CRM.RetrieveFilteredForms(EntityLogicalName=@e,FormType=@t,User=@u)?@e='fabrikam_widget'&@t=2&@u={'@odata.id':'systemusers(11111111-0000-4000-8000-000000000003)'}")).value.length, 1);
});
