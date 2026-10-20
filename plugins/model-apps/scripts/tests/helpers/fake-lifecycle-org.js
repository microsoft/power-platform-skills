'use strict';
// A STATEFUL fake Dataverse that a whole App Spec lifecycle runs against — build, rebuild, download, verify and teardown — over the
// plugin's own az-token HTTP client and the REAL vendored SDK, so a test asserts on what reached the wire and on what the environment
// is left holding, never on which SDK method a mock saw:
//
//   const org = createLifecycleOrg();
//   const client = createAzHttpClient(org.origin, { getToken: () => TOKEN, request: org.request, sleep: async () => {} });
//
// What it holds, and the platform rules it keeps:
//
//   records    one store per entity set (`solutions`, `savedqueries`, `systemforms`, `appmodules`, `webresourceset`, `roles`, `workflows`,
//              …, and the entity set of every table the build creates, for sample data). Every row carries a row version: its
//              `@odata.etag` is `W/"<n>"`, every write moves it, and a conditional write (`If-Match`) on another version answers 412.
//              A view, form, chart, dashboard, app module and site map is a SOLUTION-AWARE row with two layers: the SAVED one, which
//              every write changes and which `RetrieveUnpublished` / `RetrieveUnpublishedMultiple` read (`componentstate` 1 while it
//              holds a change no publish has copied, 0 once one has), and the PUBLISHED one, which a plain read of the COLLECTION
//              answers and which a `PublishXml` that names the row — or its table, or its app — copies the saved one to. A row that was
//              never published is not in a plain collection read at all (the rule helpers/fake-app-build-org.js and
//              helpers/fake-apps-org.js keep, measured).
//   metadata   tables, columns, keys, relationships and global option sets (helpers/fake-lifecycle-metadata.js). Creating a table makes
//              what the platform makes with it: the system columns, the default views ("Active <plural>", "Inactive <plural>",
//              Quick Find, Advanced Find, Lookup and Associated) and the Main form "Information". Deleting it removes them, its rows and
//              its solution components.
//   solution   `solutions`, `publishers` and `solutioncomponents`: a component created with the `MSCRM.SolutionUniqueName` header or
//              added with AddSolutionComponent is a row of that solution; a view, form or chart of a table the solution holds with all
//              its subcomponents has no row of its own (helpers/fake-dataverse.js says why).
//   pages      the generative pages (`uxagentprojects`, their files and conversation), held by the stateful page fake the SDK's own
//              tests drive (helpers/fake-genpage-server.js), which takes their writes, a file's bytes and a `PublishXml`; their reads
//              are answered here from its state, so every query option a read carries is applied (pageRows, answerPageRead).
//
// The platform rules it keeps, and where each comes from. MEASURED or DOCUMENTED (the plugin's code or another fake records it):
//   - a read BY ID answers the saved row with its current token (the SDK reads a form it just created that way), except an app module,
//     whose read by id is its published projection — a draft app answers 404 (helpers/fake-apps-org.js);
//   - a publish rotates the token of every row it names, changed or not (helpers/fake-dataverse.js, helpers/fake-genpage-server.js);
//   - one default form per table and form type: making one the default takes the flag off the other;
//   - an N:N link that exists is refused as a duplicate; an app's settings, and a role's grants, go with it when it is deleted;
//   - a File or Image column is `AttributeType: "Virtual"` with `AttributeTypeName` FileType / ImageType (Microsoft Learn);
//   - a Money column's `<name>_base` twin has no AttributeOf, is not logical, is custom, and is told apart only by `IsBaseCurrency`
//     (live-measured, pinned in download-model-app.test.js);
//   - integer columns the SDK sends as text (`type: "0"`) are stored as numbers.
// ASSUMED, because nothing measured says otherwise (a LIVE CHECK can settle each one):
//   - the app's publish also publishes the dashboards it holds — a dashboard has no table to publish it through, the build names
//     none, and a built dashboard reads back published (helpers/dashboard-two-language-reads.js);
//   - the Main form the platform makes for a new table has no form order (no `<DisplayConditions>`);
//   - a duplicate status reason value or key name is refused with words that say "already exists" (the plugin matches on them);
//   - the environment does not expose the business-rule designer's preview members (CreateProcessWithWfomJson), so the build skips
//     business rules as it documents; their success path is not modelled.
//
// Anything it does not model is answered 501 AND recorded in `org.unexpected`, naming the request: a test asserts the list is empty,
// so a new read or write shows up as a loud failure in the test that first sends it — never as a silent empty answer that the code
// under test might read as "nothing there". For a READ that holds before a single row or definition is looked at: the whole path, every
// query option, every column or property it names (in `$select`, `$filter`, `$orderby`, `$expand`), every navigation, cast and filter
// function, every record key (a row is addressed by its id) and every function argument is checked against an explicit schema
// (RECORD_SCHEMA below; the metadata read contract in fake-lifecycle-metadata.js), so a read over an empty collection is refused exactly
// as one over a full one — and every option a read is allowed to carry is APPLIED to the answer, never accepted and ignored.
// fake-lifecycle-org-contract.test.js pins that boundary, and the values and row counts the accepted reads answer.
//
// What a test compares: `inventory()` names what exists (identities: create/delete), `contents()` what each artifact holds (saved and
// published layers, whole definitions, page files) — the proof that a command left everything it did not make as it found it.
//
// Every request is recorded, in order, in `org.requests` as `{ method, path, body, headers, status }` with the path below the API root,
// decoded, query included, and the HTTP status it was answered with; a `$batch` also carries its `operations` (each `{ method, path,
// body, headers }`), which run atomically.
const { randomUUID } = require('node:crypto');
const { compileFilter, describeFilter, evaluateFilter } = require('./odata-filter.js');
const { createMetadataStore } = require('./fake-lifecycle-metadata.js');
const { FakeGenPageServer, API: PAGE_API, sqlGuidOrder } = require('./fake-genpage-server.js');

const API_ROOT = /^\/api\/data\/v9\.\d/;
const GUID_TEXT = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
const lc = (value) => String(value == null ? '' : value).toLowerCase();
const bare = (id) => lc(id).replace(/[{}]/g, '');

// The system tables whose rows the lifecycle reads or writes, by logical name: entity set, primary id and name columns, object type
// code, the solution component type, and — for a solution-aware row with two layers — the column that names its table.
// See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/reference/about-entity-reference
// See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/reference/entities/solutioncomponent#componenttype-choicesoptions
const SYSTEM_TABLES = {
  solution: { set: 'solutions', id: 'solutionid', name: 'uniquename', otc: 7100 },
  publisher: { set: 'publishers', id: 'publisherid', name: 'uniquename', otc: 7101 },
  solutioncomponent: { set: 'solutioncomponents', id: 'solutioncomponentid', name: null, otc: 7103 },
  savedquery: { set: 'savedqueries', id: 'savedqueryid', name: 'name', otc: 1039, layered: true, tableColumn: 'returnedtypecode', componentType: 26 },
  systemform: { set: 'systemforms', id: 'formid', name: 'name', otc: 1030, layered: true, tableColumn: 'objecttypecode', componentType: 60 },
  savedqueryvisualization: { set: 'savedqueryvisualizations', id: 'savedqueryvisualizationid', name: 'name', otc: 1111, layered: true, tableColumn: 'primaryentitytypecode', componentType: 59 },
  appmodule: { set: 'appmodules', id: 'appmoduleid', name: 'name', otc: 9006, layered: true, componentType: 80 },
  appmodulecomponent: { set: 'appmodulecomponents', id: 'appmodulecomponentid', name: null, otc: 9007 },
  sitemap: { set: 'sitemaps', id: 'sitemapid', name: 'sitemapname', otc: 4709, layered: true, componentType: 62 },
  webresource: { set: 'webresourceset', id: 'webresourceid', name: 'name', otc: 9333, componentType: 61 },
  workflow: { set: 'workflows', id: 'workflowid', name: 'name', otc: 4703, componentType: 29 },
  appaction: { set: 'appactions', id: 'appactionid', name: 'name', otc: 10129 },
  role: { set: 'roles', id: 'roleid', name: 'name', otc: 1036, componentType: 20 },
  roleprivileges: { set: 'roleprivilegescollection', id: 'roleprivilegeid', name: null, otc: 1037 },
  privilege: { set: 'privileges', id: 'privilegeid', name: 'name', otc: 1023 },
  businessunit: { set: 'businessunits', id: 'businessunitid', name: 'name', otc: 10 },
  systemuser: { set: 'systemusers', id: 'systemuserid', name: 'fullname', otc: 8 },
  team: { set: 'teams', id: 'teamid', name: 'name', otc: 9 },
  organization: { set: 'organizations', id: 'organizationid', name: 'name', otc: 1019 },
  settingdefinition: { set: 'settingdefinitions', id: 'settingdefinitionid', name: 'uniquename', otc: 10050 },
  appsetting: { set: 'appsettings', id: 'appsettingid', name: 'uniquename', otc: 10051, layered: true },
  organizationsetting: { set: 'organizationsettings', id: 'organizationsettingid', name: 'uniquename', otc: 10052 },
  uxagentproject: { set: 'uxagentprojects', id: 'uxagentprojectid', name: 'name', otc: 10200, pages: true },
  uxagentprojectfile: { set: 'uxagentprojectfiles', id: 'uxagentprojectfileid', name: 'filename', otc: 10201, pages: true },
  agentconversationmessage: { set: 'agentconversationmessages', id: 'agentconversationmessageid', name: null, otc: 10202, pages: true },
  // The two stock tables a Customer column points at.
  account: { set: 'accounts', id: 'accountid', name: 'name', otc: 1, stock: true },
  contact: { set: 'contacts', id: 'contactid', name: 'fullname', otc: 2, stock: true },
};
const PAGE_PATH = /^\/(uxagentprojects|uxagentprojectfiles|agentconversationmessages)\b/;

// THE READ CONTRACT of the record half: the columns a read may name, per system table, EXPLICITLY — `fields` the platform always fills
// (the fake fills them too, and a row without one is the fake's own modelling gap, refused loudly), `nullable` the ones a row may leave
// empty (answered `null`). A lookup is its `_<name>_value` column; `lookups` names the table a lookup points at (a filter may follow it
// to that row's key, `parentrootroleid/roleid`), `navigations` the collection-valued navigations a read may follow (`$filter` lambdas,
// `/<set>(<id>)/<navigation>`), `expands` the lookups `$expand` may embed. A table the build creates — and the two stock tables a
// Customer column points at — takes its columns from its own definition instead (schemaOfTable). Every read is checked against this
// BEFORE any row is looked at: an unknown column, option, navigation or path is answered 501 and recorded in `org.unexpected`, so an
// empty collection can never stand in for "nothing there" when the read was never modelled.
// See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/reference/about-entity-reference
const AUDIT = ['createdon', 'modifiedon', 'versionnumber'];
const RECORD_SCHEMA = {
  solution: { fields: ['solutionid', 'uniquename', 'friendlyname', 'version', 'ismanaged', 'isvisible', '_publisherid_value', ...AUDIT], nullable: ['description'], lookups: { publisherid: 'publishers' }, expands: { publisherid: 'publishers' } },
  publisher: { fields: ['publisherid', 'uniquename', 'friendlyname', 'customizationprefix', 'customizationoptionvalueprefix', ...AUDIT], nullable: ['description'] },
  solutioncomponent: { fields: ['solutioncomponentid', '_solutionid_value', 'objectid', 'componenttype', ...AUDIT], nullable: ['rootcomponentbehavior'], lookups: { solutionid: 'solutions' } },
  savedquery: { fields: ['savedqueryid', 'name', 'returnedtypecode', 'querytype', 'isdefault', 'isquickfindquery', 'isprivate', 'fetchxml', 'layoutxml', 'statecode', 'statuscode', 'ismanaged', 'iscustomizable', 'canbedeleted', 'componentstate', ...AUDIT], nullable: ['description'] },
  systemform: { fields: ['formid', 'formidunique', 'name', 'objecttypecode', 'type', 'formxml', 'isdefault', 'formactivationstate', 'ismanaged', 'iscustomizable', 'canbedeleted', 'componentstate', ...AUDIT], nullable: ['description', 'formpresentation', 'istabletenabled', 'uniquename'] },
  savedqueryvisualization: { fields: ['savedqueryvisualizationid', 'name', 'primaryentitytypecode', 'datadescription', 'presentationdescription', 'isdefault', 'ismanaged', 'iscustomizable', 'canbedeleted', 'componentstate', ...AUDIT], nullable: ['description', 'charttype', 'type'] },
  appmodule: { fields: ['appmoduleid', 'appmoduleidunique', 'name', 'uniquename', 'clienttype', 'ismanaged', 'statecode', 'statuscode', 'componentstate', ...AUDIT], nullable: ['description', 'aiappdescription', 'webresourceid', 'formfactor', 'navigationtype'], navigations: { appmoduleroles_association: 'roles' } },
  appmodulecomponent: { fields: ['appmodulecomponentid', '_appmoduleidunique_value', 'objectid', 'componenttype', 'rootcomponentbehavior', ...AUDIT], nullable: [] },
  sitemap: { fields: ['sitemapid', 'sitemapidunique', 'sitemapname', 'sitemapnameunique', 'sitemapxml', 'ismanaged', 'componentstate', ...AUDIT], nullable: [] },
  webresource: { fields: ['webresourceid', 'name', 'displayname', 'webresourcetype', 'content', 'ismanaged', 'iscustomizable', 'canbedeleted', ...AUDIT], nullable: ['description'] },
  workflow: { fields: ['workflowid', 'name', 'category', 'type', 'primaryentity', 'statecode', 'statuscode', 'ismanaged', ...AUDIT], nullable: ['description', 'uniquename', 'xaml', 'clientdata', 'businessprocesstype', 'processorder', 'mode', 'scope'] },
  appaction: { fields: ['appactionid', 'name', 'uniquename', 'context', 'contextvalue', 'location', 'type', 'ismanaged', 'statecode', 'statuscode', ...AUDIT], nullable: ['buttonlabeltext', 'sequence', 'onclickeventtype', 'onclickeventjavascriptfunctionname', 'onclickeventjavascriptparameters', 'grouptitle', 'isgrouptitlehidden', '_contextentity_value', '_parentappactionid_value', '_onclickeventjavascriptwebresourceid_value'], lookups: { parentappactionid: 'appactions' } },
  role: { fields: ['roleid', 'name', '_businessunitid_value', '_parentrootroleid_value', 'ismanaged', 'iscustomizable', ...AUDIT], nullable: ['description', '_parentroleid_value', '_roletemplateid_value'], lookups: { businessunitid: 'businessunits', parentrootroleid: 'roles', parentroleid: 'roles' }, navigations: { appmoduleroles_association: 'appmodules' } },
  roleprivileges: { fields: ['roleprivilegeid', 'roleid', 'privilegeid', 'privilegedepthmask', ...AUDIT], nullable: [] },
  privilege: { fields: ['privilegeid', 'name', 'accessright', 'canbebasic', 'canbelocal', 'canbedeep', 'canbeglobal', ...AUDIT], nullable: [] },
  businessunit: { fields: ['businessunitid', 'name', ...AUDIT], nullable: ['_parentbusinessunitid_value'], lookups: { parentbusinessunitid: 'businessunits' } },
  systemuser: { fields: ['systemuserid', 'fullname', 'domainname', '_businessunitid_value', ...AUDIT], nullable: [], lookups: { businessunitid: 'businessunits' } },
  team: { fields: ['teamid', 'name', ...AUDIT], nullable: ['_businessunitid_value'], lookups: { businessunitid: 'businessunits' } },
  organization: { fields: ['organizationid', 'name', 'languagecode', ...AUDIT], nullable: [] },
  settingdefinition: { fields: ['settingdefinitionid', 'uniquename', 'displayname', 'datatype', 'defaultvalue', 'isoverridable', 'overridablelevel', ...AUDIT], nullable: [] },
  appsetting: { fields: ['appsettingid', '_parentappmoduleid_value', '_settingdefinitionid_value', 'value', 'componentstate', ...AUDIT], nullable: ['uniquename'], lookups: { parentappmoduleid: 'appmodules', settingdefinitionid: 'settingdefinitions' } },
  organizationsetting: { fields: ['organizationsettingid', '_settingdefinitionid_value', 'value', 'uniquename', ...AUDIT], nullable: [], lookups: { settingdefinitionid: 'settingdefinitions' } },
  // The page tables are answered by the page fake (helpers/fake-genpage-server.js); their reads are checked here before it sees them.
  uxagentproject: { fields: ['uxagentprojectid', 'name', 'versionnumber', 'componentstate'], nullable: ['description', 'createdon', 'modifiedon'] },
  uxagentprojectfile: { fields: ['uxagentprojectfileid', 'filename', 'filetype', '_uxagentprojectid_value', 'versionnumber'], nullable: ['createdon', 'modifiedon'], lookups: { uxagentprojectid: 'uxagentprojects' } },
  agentconversationmessage: { fields: ['agentconversationmessageid', 'message', 'messagesender', '_regardingobjectid_value', 'createdon', 'versionnumber'], nullable: ['messagecontext', 'modifiedon'], lookups: { regardingobjectid: 'uxagentprojects' } },
};
// The query options each kind of read takes.
const READ_OPTIONS = {
  collection: ['$select', '$filter', '$orderby', '$top', '$expand'],
  single: ['$select', '$expand'],
  navigation: ['$select', '$filter', '$orderby', '$top'],
  unpublished: ['$select'],
  unpublishedMany: ['$select', '$filter', '$orderby', '$top'],
  write: ['$select'],
};

// The fixed ids a fresh environment hands out, so a test can name them.
const IDS = {
  organization: '11111111-0000-4000-8000-000000000001',
  businessUnit: '11111111-0000-4000-8000-000000000002',
  user: '11111111-0000-4000-8000-000000000003',
  defaultPublisher: '11111111-0000-4000-8000-000000000004',
  defaultSolution: '11111111-0000-4000-8000-000000000005',
  systemAdministrator: '11111111-0000-4000-8000-000000000006',
  basicUser: '11111111-0000-4000-8000-000000000007',
};

class Unmodelled extends Error {}

function createLifecycleOrg(options = {}) {
  const origin = options.origin || 'https://contoso.crm.dynamics.com';
  const API = `${origin}/api/data/v9.0`;
  const baseLanguage = options.baseLanguage || 1033;
  const requests = [];
  const unexpected = [];
  let rowVersion = 5000;
  const nextVersion = () => { rowVersion += 1; return rowVersion; };

  // Answers. The transport the plugin's client takes answers `{ statusCode, headers, body }` with the body as TEXT.
  const json = (statusCode, body, headers = {}) => ({ statusCode, headers: { 'content-type': 'application/json; odata.metadata=minimal', 'odata-version': '4.0', ...headers }, body: body === undefined ? '' : JSON.stringify(body) });
  const noContent = (headers = {}) => ({ statusCode: 204, headers: { 'odata-version': '4.0', ...headers }, body: '' });
  const failure = (statusCode, code, message) => json(statusCode, { error: { code, message } });

  // ---------------------------------------------------------------------------------------------------------------------------
  // Rows. `data` is the saved layer; `published` the published layer of a layered kind (null until a publish copies it).
  const sets = new Map(); // entity set -> Map<id, row>
  const associations = []; // { set, id, nav, toSet, toId }
  const publishes = []; // { entities: [], apps: [], other: [] } per PublishXml, PublishAllXml as { all: true }

  const metadata = createMetadataStore({
    baseLanguage,
    addComponent: (solutionName, component) => addComponentByName(solutionName, component),
    removeComponents: (ids) => removeComponents(ids),
    onTableCreated: (table, solutionName) => tableCreated(table, solutionName),
    onTableDeleted: (table) => tableDeleted(table),
  });

  const tableInfo = (logical) => {
    const system = SYSTEM_TABLES[logical];
    if (system) return { logical, ...system };
    const t = metadata.tables.get(logical);
    return t ? { logical, set: t.EntitySetName, id: t.PrimaryIdAttribute, name: t.PrimaryNameAttribute, otc: t.ObjectTypeCode } : null;
  };
  const infoOfSet = (set) => {
    for (const [logical, t] of Object.entries(SYSTEM_TABLES)) if (t.set === set) return { logical, ...t };
    for (const t of metadata.tables.values()) if (t.EntitySetName === set) return tableInfo(t.LogicalName);
    return null;
  };
  const rowsOf = (set) => {
    if (!sets.has(set)) sets.set(set, new Map());
    return sets.get(set);
  };
  function insertRow(set, data, { published = false } = {}) {
    const info = infoOfSet(set);
    const id = bare(data[info.id] || randomUUID());
    const version = nextVersion();
    // Every row carries its creation time; the platform's default views of a table are made together, which is how the SDK tells
    // the generated "Active"/"Inactive" pair from other views (helpers/fake-dataverse.js seedDefaultViews does the same).
    const row = { set, id, data: { createdon: '2026-10-01T00:00:00Z', modifiedon: '2026-10-01T00:00:00Z', ...clone(data), [info.id]: id, versionnumber: version }, version, published: null, publishedVersion: null };
    rowsOf(set).set(id, row);
    if (published) publishRow(row);
    return row;
  }
  // A publish copies the saved layer to the published one and MOVES the row's token (measured: the SDK re-baselines the copies it
  // holds after a publish of its own because the platform rotates them; helpers/fake-dataverse.js `publishBumpsVersion`,
  // helpers/fake-genpage-server.js publishProject) — so a copy held across a publish the SDK did not make is stale.
  function publishRow(row) {
    const info = infoOfSet(row.set);
    if (!info || !info.layered) return;
    // Every row the publish names rotates, changed or not ("it rotates the project's token and EVERY row's", measured for pages; the
    // views, forms and charts of a published table likewise).
    row.version = nextVersion();
    row.data.versionnumber = row.version;
    row.published = clone(row.data);
    row.publishedVersion = row.version;
  }
  const isLayered = (set) => !!(infoOfSet(set) || {}).layered;

  // ---------------------------------------------------------------------------------------------------------------------------
  // Solution components. A table is held with all its subcomponents (rootcomponentbehavior 0) when the build creates it in the
  // solution; its views, forms and charts then have no row of their own (see the header).
  const solutionByName = (name) => [...rowsOf('solutions').values()].find((row) => lc(row.data.uniquename) === lc(name));
  // A component row, as `solutioncomponents` answers it: `{ solutioncomponentid, _solutionid_value, objectid, componenttype,
  // rootcomponentbehavior }` (`rootcomponentbehavior` 0 Include Subcomponents, 1 Do not include, 2 Shell; null on any other kind).
  const componentRows = () => [...rowsOf('solutioncomponents').values()];
  function addComponent(solutionId, { objectid, componenttype, rootcomponentbehavior = null }) {
    const id = bare(objectid);
    if (componentRows().some((c) => bare(c.data._solutionid_value) === solutionId && bare(c.data.objectid) === id && c.data.componenttype === componenttype)) return;
    if ([26, 59, 60].includes(componenttype)) {
      const owner = ownerTableOf(componenttype, id);
      const table = owner && metadata.tables.get(owner);
      if (table && componentRows().some((c) => bare(c.data._solutionid_value) === solutionId && c.data.componenttype === 1 && bare(c.data.objectid) === bare(table.MetadataId) && c.data.rootcomponentbehavior === 0)) return;
    }
    insertRow('solutioncomponents', { _solutionid_value: solutionId, objectid: id, componenttype, rootcomponentbehavior: componenttype === 1 ? rootcomponentbehavior : null });
  }
  function addComponentByName(solutionName, component) {
    if (!solutionName) return;
    const solution = solutionByName(solutionName);
    if (!solution) throw new Unmodelled(`the solution ${solutionName} named by MSCRM.SolutionUniqueName does not exist`);
    addComponent(solution.id, component);
  }
  // A component that is deleted leaves every solution that held it.
  function removeComponents(ids) {
    const gone = new Set(ids.map(bare));
    for (const c of componentRows()) if (gone.has(bare(c.data.objectid))) rowsOf('solutioncomponents').delete(c.id);
  }
  function ownerTableOf(componenttype, id) {
    const set = { 26: 'savedqueries', 59: 'savedqueryvisualizations', 60: 'systemforms' }[componenttype];
    const row = set && rowsOf(set).get(bare(id));
    return row ? row.data[infoOfSet(set).tableColumn] : null;
  }

  // ---------------------------------------------------------------------------------------------------------------------------
  // What a new table comes with: its default views and its Main form, published, not deletable (views) — as the platform makes them.
  const labelText = (stored) => (stored && stored.UserLocalizedLabel ? stored.UserLocalizedLabel.Label : '');
  const classIds = { text: '{4273EDBD-AC1D-40d3-9FB2-095C621B552D}', lookup: '{270BD3DB-D9AF-4782-9025-509E298DEC0A}' };
  const braced = () => `{${randomUUID()}}`;
  function tableCreated(table) {
    recordPrivileges(table);
    if (table.IsIntersect) return;
    const logical = table.LogicalName;
    const plural = labelText(table.DisplayCollectionName) || logical;
    const primary = table.PrimaryNameAttribute;
    const fetch = (extra = '') => `<fetch version="1.0" mapping="logical"><entity name="${logical}"><attribute name="${primary}" /><attribute name="createdon" /><order attribute="${primary}" descending="false" />${extra}<attribute name="${table.PrimaryIdAttribute}" /></entity></fetch>`;
    const state = (value) => `<filter type="and"><condition attribute="statecode" operator="eq" value="${value}" /></filter>`;
    const layout = `<grid name="resultset" object="${table.ObjectTypeCode}" jump="${primary}" select="1" icon="1" preview="1"><row name="result" id="${table.PrimaryIdAttribute}"><cell name="${primary}" width="300" /><cell name="createdon" width="125" /></row></grid>`;
    const view = (name, querytype, extra = {}) => insertRow('savedqueries', { name, description: '', returnedtypecode: logical, querytype, isdefault: false, isquickfindquery: querytype === 4, iscustomizable: { Value: true, CanBeChanged: true }, canbedeleted: { Value: false, CanBeChanged: false }, isprivate: false, ismanaged: false, fetchxml: fetch(querytype === 0 || querytype === 4 ? state(extra.state || 0) : ''), layoutxml: layout, statecode: 0, statuscode: 1, ...extra.data }, { published: true });
    view(`Active ${plural}`, 0, { data: { isdefault: true } });
    view(`Inactive ${plural}`, 0, { state: 1 });
    view(`Quick Find Active ${plural}`, 4, { data: { isdefault: true } });
    view(`${plural} Advanced Find View`, 1, { data: { isdefault: true } });
    view(`${plural} Lookup View`, 64, { data: { isdefault: true } });
    view(`${plural} Associated View`, 2, { data: { isdefault: true } });
    const cell = (column, text, classid) => `<row><cell id="${braced()}"><labels><label description="${text}" languagecode="${baseLanguage}" /></labels><control id="${column}" classid="${classid}" datafieldname="${column}" /></cell></row>`;
    // The Main form the platform makes has no form order (no `<DisplayConditions>`), so a form the build orders is served before it
    // (lib/form-order.js). Were it to carry `Order="0"`, every build that declares a Main form for a new table would warn that the
    // stock form may open first.
    const formxml = `<form><tabs><tab verticallayout="true" id="${braced()}" IsUserDefined="1"><labels><label description="General" languagecode="${baseLanguage}" /></labels><columns><column width="100%"><sections><section showlabel="false" showbar="false" IsUserDefined="0" id="${braced()}"><labels><label description="General" languagecode="${baseLanguage}" /></labels><rows>${cell(primary, labelText((table.Attributes.get(primary) || {}).DisplayName) || 'Name', classIds.text)}${cell('ownerid', 'Owner', classIds.lookup)}</rows></section></sections></column></columns></tab></tabs></form>`;
    insertRow('systemforms', { name: 'Information', description: 'A form for this entity.', objecttypecode: logical, type: 2, isdefault: true, formactivationstate: 1, formpresentation: 1, ismanaged: false, formidunique: randomUUID(), iscustomizable: { Value: true, CanBeChanged: true }, canbedeleted: { Value: true, CanBeChanged: true }, formxml }, { published: true });
  }
  // Deleting a table takes its rows, views, forms, charts and privileges (and every role's grant of them) with it.
  function tableDeleted(table) {
    const logical = table.LogicalName;
    const privilegeIds = new Set((table.Privileges || []).map((p) => bare(p.PrivilegeId)));
    for (const id of privilegeIds) rowsOf('privileges').delete(id);
    for (const [id, row] of [...rowsOf('roleprivilegescollection')]) if (privilegeIds.has(bare(row.data.privilegeid))) rowsOf('roleprivilegescollection').delete(id);
    for (const set of ['savedqueries', 'systemforms', 'savedqueryvisualizations']) {
      const column = infoOfSet(set).tableColumn;
      for (const [id, row] of [...rowsOf(set)]) if (row.data[column] === logical) { rowsOf(set).delete(id); removeComponents([id]); }
    }
    sets.delete(table.EntitySetName);
  }

  // ---------------------------------------------------------------------------------------------------------------------------
  // PublishXml: the rows it names go live. `<entities>` publishes a table's views, forms and charts; `<appmodules>` an app, its site map
  // and its settings; `<sitemaps>` and `<dashboards>` the rows they name. Web resources, option sets and relationships have no second
  // layer here: nothing to copy.
  // See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/reference/publishxml
  function publishXml(xml) {
    const names = (outer, inner) => [...String(xml).matchAll(new RegExp(`<${outer}>([\\s\\S]*?)</${outer}>`, 'g'))]
      .flatMap((m) => [...m[1].matchAll(new RegExp(`<${inner}>([^<]+)</${inner}>`, 'g'))].map((x) => x[1].trim()));
    const entities = names('entities', 'entity').map(lc);
    const apps = names('appmodules', 'appmodule').map(bare);
    const sitemaps = names('sitemaps', 'sitemap').map(bare);
    const dashboards = names('dashboards', 'dashboard').map(bare);
    publishes.push({ entities, apps, sitemaps, dashboards, xml: String(xml) });
    for (const set of ['savedqueries', 'systemforms', 'savedqueryvisualizations']) {
      const column = infoOfSet(set).tableColumn;
      for (const row of rowsOf(set).values()) if (entities.includes(lc(row.data[column]))) publishRow(row);
    }
    for (const id of dashboards) { const row = rowsOf('systemforms').get(id); if (row) publishRow(row); }
    for (const id of sitemaps) { const row = rowsOf('sitemaps').get(id); if (row) publishRow(row); }
    for (const id of apps) {
      const app = rowsOf('appmodules').get(id);
      if (!app) continue;
      publishRow(app);
      for (const c of appComponentsOf(app)) {
        if (c.data.componenttype === 62) { const sm = rowsOf('sitemaps').get(bare(c.data.objectid)); if (sm) publishRow(sm); }
        // A dashboard is a form of no table (`objecttypecode` none), so no table's publish can name it, and the build names none
        // itself: the app's publish publishes the dashboards the app holds. (Measured around it: a PublishXml that names only the
        // app changes what the app's forms publish — publish-scope-real-bundle.test.js — and a dashboard the build made reads back
        // published afterwards — helpers/dashboard-two-language-reads.js.)
        if (c.data.componenttype === 60) { const form = rowsOf('systemforms').get(bare(c.data.objectid)); if (form && Number(form.data.type) === 0) publishRow(form); }
      }
      for (const s of rowsOf('appsettings').values()) if (bare(s.data._parentappmoduleid_value) === id) publishRow(s);
    }
  }
  function publishAll() {
    publishes.push({ all: true });
    for (const set of sets.keys()) for (const row of rowsOf(set).values()) publishRow(row);
  }
  const appComponentsOf = (app) => [...rowsOf('appmodulecomponents').values()].filter((c) => bare(c.data._appmoduleidunique_value) === bare(app.data.appmoduleidunique));

  // ---------------------------------------------------------------------------------------------------------------------------
  // The read contract (RECORD_SCHEMA above): what a set's rows hold, and the check every read passes before a row is looked at.
  const listOf = (text) => String(text).split(',').map((x) => x.trim()).filter(Boolean);
  // A row is addressed by its id. An alternate-key expression (`/accounts(accountnumber='x')`, `/solutions(Unknown='x')`) or any other
  // text in a key's place is not modelled: it is refused, never resolved as an id that "does not exist" (a 404 would prove an absence
  // nothing measured).
  const GUID_KEY = new RegExp(`^${GUID_TEXT}$`);
  const idOf = (key, where) => {
    if (!GUID_KEY.test(String(key))) throw new Unmodelled(`the key (${key}) on ${where} is not modelled: a row is addressed by its id`);
    return bare(key);
  };
  function schemaOf(set) {
    const info = infoOfSet(set);
    if (!info) throw new Unmodelled(`no table has the entity set ${set}`);
    const explicit = RECORD_SCHEMA[info.logical];
    if (explicit) {
      return { info, fields: new Set(explicit.fields), nullable: new Set(explicit.nullable), lookups: explicit.lookups || {}, navigations: explicit.navigations || {}, expands: explicit.expands || {} };
    }
    const table = metadata.tables.get(info.logical);
    if (!table) throw new Unmodelled(`the table of ${set} has no definition`);
    return schemaOfTable(table, info);
  }
  // A table's columns come from its own definition: a lookup (a Customer and an Owner too) is read as `_<name>_value`; a companion
  // (`AttributeOf`, e.g. a lookup's `<name>name`) is an annotation, not a column a read selects. What the platform always fills on a
  // row of it: its key, the audit columns, its state and status.
  function schemaOfTable(table, info) {
    const fields = new Set([table.PrimaryIdAttribute, 'createdon', 'modifiedon', 'versionnumber', 'statecode', 'statuscode']);
    const nullable = new Set();
    const lookups = {};
    for (const a of table.Attributes.values()) {
      if (a.AttributeOf) continue;
      const isLookup = ['Lookup', 'Customer', 'Owner'].includes(a.AttributeType);
      const name = isLookup ? `_${a.LogicalName}_value` : a.LogicalName;
      if (isLookup && Array.isArray(a.Targets) && a.Targets.length === 1) {
        const target = tableInfo(a.Targets[0]);
        if (target) lookups[a.LogicalName] = target.set;
      }
      if (!fields.has(name)) nullable.add(name);
    }
    return { info, fields, nullable, lookups, navigations: {}, expands: {} };
  }
  const knows = (schema, name) => schema.fields.has(name) || schema.nullable.has(name);
  // Refuses — before any row is enumerated — a read that names anything the set does not have: an option, a column (in `$select`,
  // `$orderby` or `$filter`), a navigation (a lambda, a path to a lookup's row, an `$expand`), a filter function. The filter is parsed
  // here, once, so an empty collection checks it exactly as a full one does. Answers what the read then needs: the schema, the parsed
  // filter with the columns it reads that the platform always fills, and the expands.
  function checkRead(set, query, kind, where) {
    const schema = schemaOf(set);
    for (const option of Object.keys(query || {})) if (!READ_OPTIONS[kind].includes(option)) throw new Unmodelled(`the query option ${option} is not modelled on ${where}`);
    const column = (name, clause) => { if (!knows(schema, name)) throw new Unmodelled(`${schema.info.logical} has no column ${name} (${clause} on ${where})`); };
    if (query.$select !== undefined) for (const name of listOf(query.$select)) column(name, '$select');
    if (query.$orderby !== undefined) {
      for (const item of listOf(query.$orderby)) {
        const [name, dir, ...extra] = item.split(/\s+/);
        if (extra.length || (dir && !/^(asc|desc)$/i.test(dir))) throw new Unmodelled(`$orderby=${query.$orderby} on ${where}`);
        column(name, '$orderby');
      }
    }
    if (query.$top !== undefined && !/^\d+$/.test(query.$top)) throw new Unmodelled(`$top=${query.$top} on ${where}`);
    const expands = query.$expand !== undefined ? expandsOf(schema, query.$expand, where) : [];
    let filter = null;
    if (query.$filter !== undefined) {
      const ast = compileFilter(query.$filter);
      const read = describeFilter(ast);
      for (const name of read.fields) column(name, '$filter');
      for (const path of read.paths) {
        const target = schema.lookups[path.navigation];
        if (!target || !knows(schema, `_${path.navigation}_value`) || path.field !== infoOfSet(target).id) throw new Unmodelled(`the navigation path ${path.navigation}/${path.field} is not modelled on ${where}`);
      }
      for (const lambda of read.lambdas) {
        const target = schema.navigations[lambda.navigation];
        if (!target) throw new Unmodelled(`${schema.info.logical} has no navigation ${lambda.navigation} ($filter on ${where})`);
        const related = schemaOf(target);
        for (const name of lambda.fields) if (!knows(related, name)) throw new Unmodelled(`${related.info.logical} has no column ${name} (${lambda.navigation}/${lambda.op} on ${where})`);
      }
      filter = { ast, required: read.fields.filter((name) => !schema.nullable.has(name)) };
    }
    return { schema, filter, expands };
  }

  // ---------------------------------------------------------------------------------------------------------------------------
  // Rows as a read answers them: `$select` narrows the columns (the primary key and `@odata.etag` always come back); a lookup is read
  // as `_<name>_value`. A plain read of a layered row answers its published layer; RetrieveUnpublished* its saved one, with
  // `componentstate`: 0 when no publish is owed, 1 when one is. A selected column the row does not hold is `null` when the platform
  // lets it be empty, and refused otherwise: the platform would have filled it, and the fake does not model how.
  // See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/query/select-columns
  function shape(row, data, query, info, { saved = false } = {}) {
    const full = { ...data, '@odata.etag': etagOf(saved ? row.version : (row.publishedVersion || row.version)) };
    if (info.layered) full.componentstate = saved ? (row.publishedVersion === row.version ? 0 : 1) : 0;
    if (!query.$select) return full;
    return selectColumns(schemaOf(row.set), full, query, { '@odata.etag': full['@odata.etag'], [info.id]: full[info.id] });
  }
  // `$select` over one row: `extra` (the key, the token) always comes back, then each selected column — `null` when the platform lets it
  // be empty and the row holds none, refused when the platform always fills it (the fake does not model how it would be set).
  function selectColumns(schema, full, query, extra) {
    const out = { ...extra };
    for (const name of listOf(query.$select)) {
      if (full[name] !== undefined && full[name] !== null) out[name] = full[name];
      else if (schema.nullable.has(name)) out[name] = null;
      else throw new Unmodelled(`${schema.info.logical} ${full[schema.info.id]} holds no ${name}, which the platform always fills`);
    }
    return out;
  }
  // The checked `$filter`, `$orderby` and `$top` over a list (each item read as `dataOf(item)`), the same for records and page rows:
  // a column the filter reads that the platform always fills must be there; the order is stable, so rows that tie keep the order the
  // list came in (the platform's own order for its set).
  function applyQuery(items, dataOf, query, checked, where, navigate) {
    const { schema, filter } = checked;
    let list = items;
    if (filter) {
      list = list.filter((item) => {
        const data = dataOf(item);
        for (const name of filter.required) if (data[name] === undefined || data[name] === null) throw new Unmodelled(`${schema.info.logical} ${data[schema.info.id]} holds no ${name}, which the platform always fills ($filter on ${where})`);
        return evaluateFilter(filter.ast, data, { navigate });
      });
    }
    if (query.$orderby !== undefined) {
      const keys = listOf(query.$orderby).map((item) => { const [field, dir] = item.split(/\s+/); return { field, sign: lc(dir) === 'desc' ? -1 : 1 }; });
      list = [...list].sort((a, b) => {
        for (const { field, sign } of keys) {
          const x = dataOf(a)[field];
          const y = dataOf(b)[field];
          if (x !== y) return (x == null ? -1 : y == null ? 1 : x > y ? 1 : -1) * sign;
        }
        return 0;
      });
    }
    if (query.$top !== undefined) list = list.slice(0, Number(query.$top));
    return list;
  }
  const etagOf = (version) => `W/"${version}"`;
  const readRows = (set, query, options = {}) => answerRows(set, [...rowsOf(set).values()], query, options);
  // The rows a read answers, out of `candidates` (a whole set, or the rows a navigation links): checked, filtered, ordered, cut, shaped.
  function answerRows(set, candidates, query, { saved = false, kind = 'collection', where = `/${set}` } = {}) {
    const checked = checkRead(set, query, kind, where);
    const { info } = checked.schema;
    const layered = !!info.layered;
    // A lambda over an N:N navigation (`appmoduleroles_association/any(x:x/roleid eq <id>)`) follows the row's links.
    const navigate = (data, nav) => {
      const id = bare(data[info.id]);
      const out = [];
      for (const a of associations) {
        if (a.nav !== nav) continue;
        if (a.set === set && a.id === id) out.push((rowsOf(a.toSet).get(a.toId) || {}).data);
        else if (a.toSet === set && a.toId === id) out.push((rowsOf(a.set).get(a.id) || {}).data);
      }
      return out.filter(Boolean);
    };
    const items = candidates
      .map((row) => ({ row, data: layered && !saved ? row.published : row.data }))
      .filter((x) => x.data)
      .map((x) => ({ ...x, read: layered ? { ...x.data, componentstate: saved && x.row.publishedVersion !== x.row.version ? 1 : 0 } : x.data }));
    return applyQuery(items, (x) => x.read, query, checked, where, navigate)
      .map((x) => withExpands(shape(x.row, x.data, query, info, { saved }), x.data, checked.expands));
  }

  // `$expand` of a single-valued navigation — a lookup — embeds the row it points at, with its own `$select`:
  //   /solutions?$select=solutionid,uniquename&$expand=publisherid($select=publisherid,customizationprefix)
  //   -> { "solutionid": "…", "uniquename": "…", "publisherid": { "publisherid": "…", "customizationprefix": "contoso" } }
  // The navigations modelled are the lookups the lifecycle expands (RECORD_SCHEMA `expands`); any other is refused by name.
  // See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/query/join-tables#expand-many-to-one-relationships
  function expandsOf(schema, text, where) {
    return metadata.parseExpand(text).map((item) => {
      const target = schema.expands[item.name];
      if (!target) throw new Unmodelled(`$expand=${item.name} on ${where} is not modelled`);
      for (const option of Object.keys(item.opts)) if (option !== '$select') throw new Unmodelled(`$expand=${item.name}(${option}) on ${where} is not modelled`);
      const related = schemaOf(target);
      if (item.opts.$select !== undefined) for (const name of listOf(item.opts.$select)) if (!knows(related, name)) throw new Unmodelled(`${related.info.logical} has no column ${name} ($expand=${item.name} on ${where})`);
      return { ...item, target };
    });
  }
  function withExpands(out, data, expands) {
    for (const e of expands) {
      const id = data[`_${e.name}_value`];
      const row = id && rowsOf(e.target).get(bare(id));
      out[e.name] = row ? shape(row, row.data, e.opts, infoOfSet(e.target), { saved: true }) : null;
    }
    return out;
  }

  // `"parentappmoduleid@odata.bind": "/appmodules(<id>)"` -> `_parentappmoduleid_value: <id>`. The name before `@odata.bind` is the
  // lookup's navigation property: the lookup's own name for a single-target lookup (`contoso_ParentId@odata.bind` sets
  // `contoso_parentid`), and `<lookup>_<table>` for a polymorphic one (`regardingobjectid_account@odata.bind` sets `regardingobjectid`).
  // See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/associate-disassociate-entities-using-web-api#associate-entity-records-on-create
  function bindLookups(set, body) {
    const info = infoOfSet(set);
    const table = info && metadata.tables.get(info.logical);
    const out = {};
    for (const [key, value] of Object.entries(body || {})) {
      const bind = /^(.+)@odata\.bind$/.exec(key);
      if (!bind) { out[key] = clone(value); continue; }
      const target = /\/?([A-Za-z_]\w*)\(([^)]+)\)$/.exec(String(value || ''));
      if (!target) throw new Unmodelled(`cannot read the bind ${key}: ${value}`);
      const targetId = idOf(target[2], `the bind ${key}`);
      let name = lc(bind[1]);
      if (table && !table.Attributes.has(name)) {
        const poly = /^(.+)_[a-z0-9]+$/.exec(name);
        if (poly && table.Attributes.has(poly[1])) name = poly[1];
      }
      out[`_${name}_value`] = targetId;
    }
    return out;
  }

  const ifMatchOf = (headers) => Object.entries(headers || {}).find(([k]) => lc(k) === 'if-match');
  // The option-set and whole-number columns of the system tables the SDK writes with a TEXT value (a dashboard's `type` comes as "0"):
  // the platform stores the number, so a filter `type eq 0` finds it.
  const INTEGER_COLUMNS = new Set(['type', 'formactivationstate', 'formpresentation', 'querytype', 'statecode', 'statuscode', 'category', 'mode', 'scope', 'webresourcetype', 'componenttype', 'rootcomponentbehavior', 'location', 'clienttype', 'navigationtype', 'charttype', 'businessprocesstype', 'processorder', 'datatype']);
  const coerce = (data) => Object.fromEntries(Object.entries(data).map(([k, v]) => [k, INTEGER_COLUMNS.has(k) && typeof v === 'string' && /^-?\d+$/.test(v) ? Number(v) : v]));
  const ifNoneMatchOf = (headers) => Object.entries(headers || {}).find(([k]) => lc(k) === 'if-none-match');
  const preferOf = (headers) => (Object.entries(headers || {}).find(([k]) => lc(k) === 'prefer') || [])[1] || '';
  const solutionHeader = (headers) => (Object.entries(headers || {}).find(([k]) => lc(k) === 'mscrm.solutionuniquename') || [])[1] || null;

  // The columns the platform fills in on a create, by entity set: a solution-aware row's unique-layer id and managed state, a form's
  // activation state, a view's and a form's managed properties and default flag (false until one is made the default).
  // See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/reference/entities/appmodule#BKMK_AppModuleIdUnique
  const CREATE_DEFAULTS = {
    appmodules: () => ({ appmoduleidunique: randomUUID(), ismanaged: false, statecode: 0, statuscode: 1 }),
    sitemaps: () => ({ sitemapidunique: randomUUID(), ismanaged: false }),
    savedqueries: () => ({ ismanaged: false, iscustomizable: { Value: true, CanBeChanged: true }, canbedeleted: { Value: true, CanBeChanged: true }, statecode: 0, statuscode: 1, isprivate: false, isdefault: false, isquickfindquery: false }),
    systemforms: () => ({ ismanaged: false, iscustomizable: { Value: true, CanBeChanged: true }, canbedeleted: { Value: true, CanBeChanged: true }, formactivationstate: 1, formidunique: randomUUID(), isdefault: false }),
    savedqueryvisualizations: () => ({ ismanaged: false, iscustomizable: { Value: true, CanBeChanged: true }, canbedeleted: { Value: true, CanBeChanged: true } }),
    webresourceset: () => ({ ismanaged: false, iscustomizable: { Value: true, CanBeChanged: true }, canbedeleted: { Value: true, CanBeChanged: true } }),
    workflows: () => ({ ismanaged: false, statecode: 0, statuscode: 1 }),
    roles: () => ({ ismanaged: false, iscustomizable: { Value: true, CanBeChanged: true } }),
    solutions: () => ({ ismanaged: false, isvisible: true }),
    appactions: () => ({ ismanaged: false, statecode: 0, statuscode: 1 }),
  };

  function createRow(set, body, headers, query = {}) {
    const info = infoOfSet(set);
    if (!info) throw new Unmodelled(`no table has the entity set ${set}`);
    const data = { ...(CREATE_DEFAULTS[set] ? CREATE_DEFAULTS[set]() : {}), ...coerce(bindLookups(set, body)) };
    // A dashboard is a form of no table: the platform stores `objecttypecode` "none" for it.
    if (set === 'systemforms' && Number(data.type) === 0 && !data.objecttypecode) data.objecttypecode = 'none';
    const id = bare(data[info.id] || randomUUID());
    if (rowsOf(set).has(id)) return failure(412, '0x80040237', 'A record with matching key values already exists.');
    // A role of the root business unit is its own `parentrootroleid` (the stock roles are seeded so); a row of a table with a state
    // starts Active (statecode 0) with that state's default status (1) unless the request names another.
    // See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/reference/entities/role#BKMK_ParentRootRoleId
    if (set === 'roles' && data._parentrootroleid_value === undefined) data._parentrootroleid_value = id;
    const definition = (!SYSTEM_TABLES[info.logical] || SYSTEM_TABLES[info.logical].stock) && metadata.tables.get(info.logical);
    if (definition && definition.Attributes.has('statecode')) {
      if (data.statecode === undefined) data.statecode = 0;
      if (data.statuscode === undefined) data.statuscode = 1;
    }
    const row = insertRow(set, { ...data, [info.id]: id, createdon: '2026-10-01T00:00:00Z', modifiedon: '2026-10-01T00:00:00Z' });
    const solution = solutionHeader(headers);
    if (solution && info.componentType) addComponentByName(solution, { objectid: id, componenttype: info.componentType });
    const location = `${API}/${set}(${id})`;
    // `Prefer: return=representation` answers the row as created — narrowed by the request's `$select`, as a read would be.
    if (/return=representation/i.test(preferOf(headers))) return json(201, shape(row, row.data, query, info, { saved: true }), { 'odata-entityid': location, etag: etagOf(row.version) });
    return noContent({ 'odata-entityid': location, etag: etagOf(row.version) });
  }

  function updateRow(set, id, body, headers, query = {}) {
    const info = infoOfSet(set);
    if (!info) throw new Unmodelled(`no table has the entity set ${set}`);
    const row = rowsOf(set).get(bare(id));
    const ifMatch = ifMatchOf(headers);
    const ifNoneMatch = ifNoneMatchOf(headers);
    if (!row) {
      if (ifMatch) return failure(404, '0x80040217', `${info.logical} With Id = ${id} Does Not Exist`);
      // A PATCH without a precondition is an UPSERT: it creates the row it names.
      // See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/perform-conditional-operations-using-web-api#prevent-create-in-upsert
      return createRow(set, { ...body, [info.id]: bare(id) }, headers, query);
    }
    if (ifNoneMatch && ifNoneMatch[1] === '*') return failure(412, '0x80040237', 'A record with matching key values already exists.');
    if (ifMatch && ifMatch[1] !== '*' && ifMatch[1] !== etagOf(row.version)) return failure(412, '0x80060882', "The version of the existing record doesn't match the RowVersion property provided.");
    Object.assign(row.data, coerce(bindLookups(set, body)), { modifiedon: '2026-10-01T00:00:01Z' });
    row.version = nextVersion();
    row.data.versionnumber = row.version;
    // A table has ONE default form of each type: making a form the default takes the flag off the one that had it (the teardown's
    // restore of the stock Main form relies on that to demote the build's form — sdk-teardown.js restoreStockMainForm).
    if (set === 'systemforms' && body && body.isdefault === true) {
      for (const other of rowsOf('systemforms').values()) {
        if (other.id === row.id || other.data.objecttypecode !== row.data.objecttypecode || Number(other.data.type) !== Number(row.data.type) || other.data.isdefault !== true) continue;
        other.data.isdefault = false;
        other.version = nextVersion();
        other.data.versionnumber = other.version;
      }
    }
    if (/return=representation/i.test(preferOf(headers))) return json(200, shape(row, row.data, query, info, { saved: true }), { etag: etagOf(row.version) });
    return noContent({ 'odata-entityid': `${API}/${set}(${row.id})`, etag: etagOf(row.version) });
  }

  function deleteRow(set, id) {
    const info = infoOfSet(set);
    if (!info) throw new Unmodelled(`no table has the entity set ${set}`);
    const row = rowsOf(set).get(bare(id));
    if (!row) return failure(404, '0x80040217', `${info.logical} With Id = ${id} Does Not Exist`);
    rowsOf(set).delete(row.id);
    removeComponents([row.id]);
    for (const c of [...rowsOf('appmodulecomponents').values()]) if (bare(c.data.objectid) === row.id) rowsOf('appmodulecomponents').delete(c.id);
    for (let i = associations.length - 1; i >= 0; i -= 1) if (associations[i].id === row.id || associations[i].toId === row.id) associations.splice(i, 1);
    // A role's grants (`roleprivileges` rows) go with it.
    if (set === 'roles') for (const [rid, grant] of [...rowsOf('roleprivilegescollection')]) if (bare(grant.data.roleid) === row.id) rowsOf('roleprivilegescollection').delete(rid);
    // Deleting an unmanaged solution deletes the container and its component rows; the components themselves stay.
    if (set === 'solutions') for (const c of componentRows()) if (bare(c.data._solutionid_value) === row.id) rowsOf('solutioncomponents').delete(c.id);
    if (set === 'appmodules') {
      for (const c of [...rowsOf('appmodulecomponents').values()]) if (bare(c.data._appmoduleidunique_value) === bare(row.data.appmoduleidunique)) rowsOf('appmodulecomponents').delete(c.id);
      // An app's settings are part of it (`appsetting.parentappmoduleid` is a parental relationship): they go with it.
      for (const s of [...rowsOf('appsettings').values()]) if (bare(s.data._parentappmoduleid_value) === row.id) { rowsOf('appsettings').delete(s.id); removeComponents([s.id]); }
    }
    return noContent();
  }

  // ---------------------------------------------------------------------------------------------------------------------------
  // The environment before anything is built: its organization, root business unit and user, the default publisher and solution,
  // the two stock roles, the setting definitions the app settings bind, and the definitions of the system tables.
  function seedSystemTable(logical, info) {
    const table = metadata.makeTable({ SchemaName: logical, EntitySetName: info.set, ObjectTypeCode: info.otc, OwnershipType: 'OrganizationOwned', DisplayName: logical, DisplayCollectionName: logical, Attributes: info.name ? [{ '@odata.type': 'Microsoft.Dynamics.CRM.StringAttributeMetadata', SchemaName: info.name, IsPrimaryName: true, DisplayName: info.name }] : [] }, { custom: false });
    table.PrimaryIdAttribute = info.id;
    if (!info.name) table.PrimaryNameAttribute = null;
    for (const a of table.Attributes.values()) a.IsCustomAttribute = false;
    metadata.tables.set(logical, table);
    recordPrivileges(table);
  }
  // The privileges of a table are rows too (`privileges`), which a role's grant names by id.
  function recordPrivileges(table) {
    for (const p of table.Privileges || []) insertRow('privileges', { privilegeid: p.PrivilegeId, name: p.Name, accessright: p.PrivilegeType, canbebasic: p.CanBeBasic, canbelocal: p.CanBeLocal, canbedeep: p.CanBeDeep, canbeglobal: p.CanBeGlobal });
  }
  for (const [logical, info] of Object.entries(SYSTEM_TABLES)) seedSystemTable(logical, info);
  insertRow('organizations', { organizationid: IDS.organization, name: 'Contoso', languagecode: baseLanguage });
  insertRow('businessunits', { businessunitid: IDS.businessUnit, name: 'contoso', _parentbusinessunitid_value: null });
  insertRow('systemusers', { systemuserid: IDS.user, fullname: 'Maker', domainname: 'maker@contoso.onmicrosoft.com', _businessunitid_value: IDS.businessUnit });
  insertRow('publishers', { publisherid: IDS.defaultPublisher, uniquename: 'DefaultPublisherContoso', friendlyname: 'Default Publisher for Contoso', customizationprefix: 'new', customizationoptionvalueprefix: 10000 });
  insertRow('solutions', { solutionid: IDS.defaultSolution, uniquename: 'Default', friendlyname: 'Default Solution', version: '1.0', ismanaged: false, isvisible: false, _publisherid_value: IDS.defaultPublisher });
  // The two stock roles of the root business unit. A root role is its own `parentrootroleid`; System Administrator carries its fixed
  // role template id, which is how the SDK finds it to associate it with a new app.
  // See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/reference/entities/role#BKMK_RoleTemplateId
  for (const [id, name, template] of [[IDS.systemAdministrator, 'System Administrator', '627090ff-40a3-4053-8790-584edc5be201'], [IDS.basicUser, 'Basic User', null]]) {
    insertRow('roles', { roleid: id, name, description: null, _businessunitid_value: IDS.businessUnit, _parentrootroleid_value: id, _parentroleid_value: null, _roletemplateid_value: template, ismanaged: true, iscustomizable: { Value: false } });
  }
  for (const name of options.settingDefinitions || ['NewLookAlwaysOn', 'HeaderAndNavigationRefresh']) {
    insertRow('settingdefinitions', { settingdefinitionid: randomUUID(), uniquename: name, displayname: name, datatype: name === 'HeaderAndNavigationRefresh' ? 0 : 2, defaultvalue: name === 'HeaderAndNavigationRefresh' ? '0' : 'false', isoverridable: true, overridablelevel: 0 });
  }

  // ---------------------------------------------------------------------------------------------------------------------------
  // The page tables are served by the page fake, over the SDK's own HttpClient shape (`{ status, headers, body }`).
  const pageServer = new FakeGenPageServer();
  pageServer.languages = { base: baseLanguage, provisioned: options.provisionedLanguages || [baseLanguage], available: options.provisionedLanguages || [baseLanguage] };
  // The page tables. The page fake owns their state and takes their writes, and a file's bytes (`/uxagentprojectfiles(<id>)/filecontent/$value`);
  // their READS are answered here, from that state, so every option a read may carry is APPLIED — `$filter` (any expression the
  // checker admits), `$orderby`, `$top` and `$select` — where the page fake's routes match only the reads the SDK sends today. Which
  // rows a read sees is the page fake's rule (FakeGenPageServer.execute, measured there):
  //   - a plain read is the PUBLISHED layer: each page and file as its last publish left it, with the `versionnumber` the row has NOW;
  //     `MSCRM.IncludeUnpublished: true` shows the saved rows, drafts included, instead;
  //   - RetrieveUnpublishedMultiple() is the saved layer, `componentstate` 1 while a page holds a draft no publish has copied;
  //   - conversation messages have one layer, kept in the platform's order: by `createdon`, then — the turns of one change set share a
  //     second — by primary key in SQL uniqueidentifier order (both measured); a requested `$orderby` sorts over that order.
  // The reads a page table takes (anything else is refused):
  //   /uxagentprojects · /uxagentprojects(<id>) · /uxagentprojects/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple() ·
  //   /uxagentprojectfiles · /uxagentprojectfiles(<id>)/filecontent/$value · /agentconversationmessages
  function checkPageRead(p, query) {
    const m = /^\/(uxagentprojects|uxagentprojectfiles|agentconversationmessages)(?:\(([^)]*)\))?(?:\/(.+))?$/.exec(p);
    if (!m) throw new Unmodelled(`GET ${p}`);
    const [, set, key, rest] = m;
    const read = (kind) => ({ set, kind, where: p, key: key === undefined ? null : idOf(key, `GET ${p}`) });
    if (key === undefined && !rest) return { ...read('collection'), checked: checkRead(set, query, 'collection', p) };
    if (key !== undefined && !rest && set === 'uxagentprojects') return { ...read('single'), checked: checkRead(set, query, 'single', p) };
    if (key === undefined && set === 'uxagentprojects' && rest === 'Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()') return { ...read('unpublishedMany'), checked: checkRead(set, query, 'unpublishedMany', p) };
    if (key !== undefined && set === 'uxagentprojectfiles' && rest === 'filecontent/$value') { noQuery(query, p); return read('content'); }
    throw new Unmodelled(`GET ${p}`);
  }
  // A page table's rows, whole, as the layer a read sees holds them (`saved`: drafts included).
  function pageRows(set, saved) {
    const pages = pageServer.state;
    const published = pageServer.publishedPages;
    if (set === 'uxagentprojects') {
      if (saved) return [...pages.projects.values()].map((p) => ({ uxagentprojectid: p.id, name: p.name, versionnumber: p.version, componentstate: p.draft || !published.has(p.id) ? 1 : 0, '@odata.etag': `W/"${p.etag}"` }));
      return [...published.values()].map(({ project }) => ({ uxagentprojectid: project.id, name: project.name, versionnumber: pages.projects.has(project.id) ? pages.projects.get(project.id).version : project.version, componentstate: 0, '@odata.etag': `W/"${project.etag}"` }));
    }
    if (set === 'uxagentprojectfiles') {
      const row = (file, projectId, version) => ({ uxagentprojectfileid: file.id, filename: file.filename, filetype: file.filetype, versionnumber: version, _uxagentprojectid_value: projectId, '@odata.etag': `W/"${file.etag}"` });
      if (saved) return [...pages.files.values()].map((file) => row(file, file.projectId, file.version));
      return [...published.entries()].flatMap(([id, page]) => (page.files || []).map((file) => row(file, id, pages.files.has(file.id) ? pages.files.get(file.id).version : file.version)));
    }
    return [...pages.messages.values()]
      .sort((a, b) => a.createdon.localeCompare(b.createdon) || sqlGuidOrder(a.id, b.id))
      .map((x) => ({ agentconversationmessageid: x.id, message: x.message, messagesender: x.sender, messagecontext: x.context, createdon: x.createdon, versionnumber: x.version, _regardingobjectid_value: x.regarding }));
  }
  function answerPageRead({ set, kind, key, where, checked }, query, headers) {
    const unpublished = Object.entries(headers || {}).some(([name, value]) => lc(name) === 'mscrm.includeunpublished' && String(value) === 'true');
    const rows = pageRows(set, kind === 'unpublishedMany' || unpublished);
    const { schema } = checked;
    const id = schema.info.id;
    const answer = (row) => (query.$select ? selectColumns(schema, row, query, { ...(row['@odata.etag'] ? { '@odata.etag': row['@odata.etag'] } : {}), [id]: row[id] }) : row);
    if (kind === 'single') {
      const row = rows.find((r) => r[id] === key);
      if (!row) return failure(404, '0x80040217', `${schema.info.logical} With Id = ${key} Does Not Exist`);
      return json(200, answer(row), { etag: row['@odata.etag'] });
    }
    return json(200, { value: applyQuery(rows, (row) => row, query, checked, where).map(answer) });
  }
  async function pageRequest(method, where, body, headers) {
    if (method === 'GET') {
      const read = checkPageRead(pathOf(where), queryOf(where));
      if (read.kind !== 'content') return answerPageRead(read, queryOf(where), headers);
    }
    const res = await pageServer.receive(method, `${PAGE_API}${where}`, body, { headers }, false, {});
    // The page fake answers what it does not route with a 404/405 "no route": that is a request this fake does not model either.
    const routeless = res.body && res.body.error && /^no route for /.test(String(res.body.error.message || ''));
    if (routeless) throw new Unmodelled(`${method} ${where} (the page fake has no route for it)`);
    const lowered = Object.fromEntries(Object.entries(res.headers || {}).map(([name, value]) => [name.toLowerCase(), value]));
    const bytes = Buffer.isBuffer(res.body) || res.body instanceof Uint8Array;
    return { statusCode: res.status, headers: bytes ? lowered : { 'content-type': 'application/json', ...lowered }, body: bytes ? Buffer.from(res.body) : (res.body === undefined ? '' : JSON.stringify(res.body)) };
  }

  // ---------------------------------------------------------------------------------------------------------------------------
  // The router. `where` is the path below the API root with its query; `body` the parsed JSON body.
  const queryOf = (where) => {
    const at = where.indexOf('?');
    const out = {};
    if (at === -1) return out;
    // Split on `&` only outside quotes and parentheses: a filter's text may hold either.
    let depth = 0;
    let quoted = false;
    let start = at + 1;
    const s = where;
    for (let i = at + 1; i <= s.length; i += 1) {
      const ch = s[i];
      if (ch === "'") quoted = !quoted;
      else if (!quoted && ch === '(') depth += 1;
      else if (!quoted && ch === ')') depth -= 1;
      if (i === s.length || (ch === '&' && !quoted && depth === 0)) {
        const part = s.slice(start, i);
        const eq = part.indexOf('=');
        if (eq > 0) out[part.slice(0, eq)] = part.slice(eq + 1);
        start = i + 1;
      }
    }
    return out;
  };
  const pathOf = (where) => (where.indexOf('?') === -1 ? where : where.slice(0, where.indexOf('?')));

  async function dispatch(method, where, body, headers) {
    const p = pathOf(where);
    const query = queryOf(where);
    if (PAGE_PATH.test(p)) return pageRequest(method, where, body, headers);
    const meta = metadata.handle(method, p, query, body, headers, API);
    if (meta) return meta.status === 204 ? noContent(meta.headers) : json(meta.status, meta.body, meta.headers);
    const action = await actions(method, p, query, body, headers, where);
    if (action) return action;
    return records(method, p, query, body, headers);
  }

  // ---------------------------------------------------------------------------------------------------------------------------
  // Actions and functions (unbound and bound). Each answers as the platform does; null when the path is not one.
  // An action or function takes the parameters in its body or its path, never a query option — but for the ones that read rows
  // (RetrieveUnpublished*: the options of a read) and RetrieveFilteredForms (its `@e`, `@t`, `@u` parameter aliases).
  const ACTIONS = /^\/(WhoAmI|RetrieveProvisionedLanguages\(\)|RetrieveAvailableLanguages\(\)|PublishXml|PublishAllXml|AddSolutionComponent|AddAppComponents|RemoveAppComponents|InsertStatusValue|InsertOptionValue|SaveSettingValue|RetrieveSetting\(.*\)|\$batch|[A-Za-z_]\w*\([^)]+\)\/Microsoft\.Dynamics\.CRM\.(AddPrivilegesRole|ReplacePrivilegesRole)|[A-Za-z_]\w*\/Microsoft\.Dynamics\.CRM\.CreateMultiple)$/;
  async function actions(method, p, query, body, headers, where) {
    if (ACTIONS.test(p)) noQuery(query, p);
    if (method === 'GET' && p === '/WhoAmI') return json(200, { UserId: IDS.user, BusinessUnitId: IDS.businessUnit, OrganizationId: IDS.organization });
    if (method === 'GET' && p === '/RetrieveProvisionedLanguages()') return json(200, { RetrieveProvisionedLanguages: pageServer.languages.provisioned });
    if (method === 'GET' && p === '/RetrieveAvailableLanguages()') return json(200, { LocaleIds: pageServer.languages.available });
    if (method === 'POST' && p === '/PublishXml') {
      publishXml(body.ParameterXml);
      await pageServer.receive('POST', `${PAGE_API}/PublishXml`, body, { headers }, false, {});
      return noContent();
    }
    if (method === 'POST' && p === '/PublishAllXml') { publishAll(); return noContent(); }
    if (method === 'POST' && p === '/AddSolutionComponent') {
      const solution = solutionByName(body.SolutionUniqueName);
      if (!solution) return failure(400, '0x8004f01e', `Solution ${body.SolutionUniqueName} does not exist.`);
      addComponent(solution.id, { objectid: body.ComponentId, componenttype: Number(body.ComponentType), rootcomponentbehavior: body.DoNotIncludeSubcomponents ? 1 : 0 });
      return json(200, { id: randomUUID() });
    }
    // AddAppComponents { AppId, Components: [{ "@odata.type": "Microsoft.Dynamics.CRM.systemform", "formid": "<id>" }, …] }: one
    // appmodulecomponent row per component, bound to the app's unique layer (`appmoduleidunique`), as the platform keeps them.
    // See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/reference/addappcomponents
    if (method === 'POST' && (p === '/AddAppComponents' || p === '/RemoveAppComponents')) {
      const app = rowsOf('appmodules').get(bare(body.AppId));
      if (!app) return failure(404, '0x80040217', `appmodule With Id = ${body.AppId} Does Not Exist`);
      for (const c of body.Components || []) {
        const ref = componentRef(c);
        const held = appComponentsOf(app).find((x) => bare(x.data.objectid) === ref.id && x.data.componenttype === ref.type);
        if (p === '/RemoveAppComponents') { if (held) rowsOf('appmodulecomponents').delete(held.id); continue; }
        if (!held) insertRow('appmodulecomponents', { objectid: ref.id, componenttype: ref.type, rootcomponentbehavior: 0, _appmoduleidunique_value: app.data.appmoduleidunique });
      }
      app.version = nextVersion();
      app.data.versionnumber = app.version;
      return noContent();
    }
    // A bound action on a role: AddPrivilegesRole / ReplacePrivilegesRole { Privileges: [{ PrivilegeId, Depth, BusinessUnitId }] }.
    // The intersect rows carry the depth as a mask (1 Basic, 2 Local, 4 Deep, 8 Global).
    // See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/reference/addprivilegesrole
    const roleAction = /^\/roles\(([^)]+)\)\/Microsoft\.Dynamics\.CRM\.(AddPrivilegesRole|ReplacePrivilegesRole)$/.exec(p);
    if (method === 'POST' && roleAction) {
      const role = rowsOf('roles').get(idOf(roleAction[1], p));
      if (!role) return failure(404, '0x80040217', `role With Id = ${roleAction[1]} Does Not Exist`);
      const mask = { Basic: 1, Local: 2, Deep: 4, Global: 8 };
      const held = rowsOf('roleprivilegescollection');
      if (roleAction[2] === 'ReplacePrivilegesRole') for (const [id, row] of [...held]) if (bare(row.data.roleid) === role.id) held.delete(id);
      for (const grant of body.Privileges || []) {
        const existing = [...held.values()].find((row) => bare(row.data.roleid) === role.id && bare(row.data.privilegeid) === bare(grant.PrivilegeId));
        const depth = mask[grant.Depth] || Number(grant.Depth) || 1;
        if (existing) existing.data.privilegedepthmask = Math.max(existing.data.privilegedepthmask, depth);
        else insertRow('roleprivilegescollection', { roleid: role.id, privilegeid: bare(grant.PrivilegeId), privilegedepthmask: depth });
      }
      return noContent();
    }
    const unpublished = /^\/([A-Za-z_]\w*)\(([^)]+)\)\/Microsoft\.Dynamics\.CRM\.RetrieveUnpublished\(\)$/.exec(p);
    if (method === 'GET' && unpublished) {
      const { info } = checkRead(unpublished[1], query, 'unpublished', p).schema;
      if (!info.layered) throw new Unmodelled(`${unpublished[1]} has no unpublished layer (${p})`);
      const row = rowsOf(unpublished[1]).get(idOf(unpublished[2], p));
      if (!row) return failure(404, '0x80040217', `${unpublished[1]} With Id = ${unpublished[2]} Does Not Exist`);
      const shaped = shape(row, row.data, query, info, { saved: true });
      return json(200, shaped, { etag: shaped['@odata.etag'] });
    }
    const unpublishedMany = /^\/([A-Za-z_]\w*)\/Microsoft\.Dynamics\.CRM\.RetrieveUnpublishedMultiple\(\)$/.exec(p);
    if (method === 'GET' && unpublishedMany) {
      if (!(infoOfSet(unpublishedMany[1]) || {}).layered) throw new Unmodelled(`${unpublishedMany[1]} has no unpublished layer (${p})`);
      return json(200, { value: readRows(unpublishedMany[1], query, { saved: true, kind: 'unpublishedMany', where: p }) });
    }
    // The business-rule designer's bound members (`CreateProcessWithWfomJson`, `RetrieveProcessWithWfomJson`) are a preview that most
    // environments do not expose; this one does not, and answers as Dataverse answers a member it does not declare. The SDK reads that
    // 404 as "business-rule authoring is not enabled here" (WFOM_API_UNAVAILABLE) and the build skips the rules with a warning
    // (references/app-spec-schema-advanced.md, businessRules[]). The success path of that preview is not modelled.
    const wfom = /^\/workflows\([^)]+\)\/Microsoft\.Dynamics\.CRM\.(CreateProcessWithWfomJson|RetrieveProcessWithWfomJson|UpdateProcessWithWfomJson)$/.exec(p);
    if (wfom) return failure(404, '0x8006088a', `Resource not found for the segment 'Microsoft.Dynamics.CRM.${wfom[1]}'.`);
    // RetrieveFilteredForms: the forms of one type a user may open, first to last — answered with ids only:
    //   { "value": [ { "@odata.type": "#Microsoft.Dynamics.CRM.systemform", "formid": "<guid>" }, … ] }
    // The user here holds System Administrator, which may open every form, so only the order is modelled, as lib/form-order.js
    // records it measured: by the published `<DisplayConditions Order>`, a form with conditions but no Order after those with one, a
    // form with no conditions after every form that has them; forms that tie come in the order they were created.
    // See: https://learn.microsoft.com/power-apps/developer/data-platform/webapi/reference/retrievefilteredforms
    if (method === 'GET' && /^\/systemforms\/Microsoft\.Dynamics\.CRM\.RetrieveFilteredForms\(EntityLogicalName=@e,FormType=@t,User=@u\)$/.test(p)) {
      // Its three parameter aliases, each as the SDK sends it: `@e='contoso_task'`, `@t=2`, and the user as a reference,
      // `@u={'@odata.id':'systemusers(<id>)'}`. The one user modelled is the maker (System Administrator, who may open every form).
      for (const option of Object.keys(query)) if (!['@e', '@t', '@u'].includes(option)) throw new Unmodelled(`the parameter ${option} is not modelled on ${p}`);
      const named = /^'([A-Za-z_]\w*)'$/.exec(String(query['@e'] || ''));
      const user = new RegExp(`^\\{'@odata\\.id':'systemusers\\((${GUID_TEXT})\\)'\\}$`).exec(String(query['@u'] || ''));
      if (!named || !/^\d+$/.test(String(query['@t'] || ''))) throw new Unmodelled(`the parameters @e=${query['@e']}, @t=${query['@t']} of ${p} are not modelled`);
      if (!user || bare(user[1]) !== IDS.user) throw new Unmodelled(`the user @u=${query['@u']} of ${p} is not modelled: only the maker is`);
      const entity = lc(named[1]);
      const type = Number(query['@t']);
      const rank = (xml) => {
        const conditions = /<DisplayConditions\b([^>]*)>/i.exec(String(xml || ''));
        if (!conditions) return [2, 0];
        const order = /\bOrder="(-?\d+)"/i.exec(conditions[1]);
        return order ? [0, Number(order[1])] : [1, 0];
      };
      const forms = [...rowsOf('systemforms').values()]
        .filter((row) => row.published && lc(row.published.objecttypecode) === entity && Number(row.published.type) === type && row.published.formactivationstate === 1)
        .map((row, at) => ({ id: row.id, at, rank: rank(row.published.formxml) }))
        .sort((a, b) => a.rank[0] - b.rank[0] || a.rank[1] - b.rank[1] || a.at - b.at);
      return json(200, { value: forms.map((f) => ({ '@odata.type': '#Microsoft.Dynamics.CRM.systemform', formid: f.id })) });
    }
    if (method === 'POST' && p === '/$batch') return batch(body, headers);
    // CreateMultiple on a table's entity set: { "Targets": [ { "@odata.type": "Microsoft.Dynamics.CRM.contoso_project", …columns } ] } ->
    // { "Ids": [ "<guid>", … ] }, in the order of the targets. It is one transaction: a target that fails creates none of them.
    // See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/reference/createmultiple
    const createMultiple = /^\/([A-Za-z_]\w*)\/Microsoft\.Dynamics\.CRM\.CreateMultiple$/.exec(p);
    if (method === 'POST' && createMultiple) {
      const saved = snapshotState();
      const ids = [];
      for (const target of body.Targets || []) {
        const record = { ...target };
        delete record['@odata.type'];
        const res = createRow(createMultiple[1], record, headers);
        if (res.statusCode >= 300) { restoreState(saved); return res; }
        ids.push(/\(([^)]+)\)$/.exec(res.headers['odata-entityid'])[1]);
      }
      return json(200, { Ids: ids });
    }
    // InsertStatusValue { EntityLogicalName, AttributeLogicalName: "statuscode", Label, StateCode, Value? } adds a status reason under a state,
    // and InsertOptionValue { EntityLogicalName, AttributeLogicalName, Label, Value? } an option; each answers the value it was given (or
    // the next free one): `{ "NewOptionValue": 100000000 }`. A value that is already an option is refused.
    // See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/reference/insertstatusvalue
    if (method === 'POST' && (p === '/InsertStatusValue' || p === '/InsertOptionValue')) {
      const table = metadata.tables.get(lc(body.EntityLogicalName));
      const attribute = table && table.Attributes.get(lc(body.AttributeLogicalName));
      if (!attribute || !attribute.OptionSet) return failure(404, '0x80040217', `attribute ${body.EntityLogicalName}.${body.AttributeLogicalName} Does Not Exist`);
      const options = attribute.OptionSet.Options;
      const value = body.Value !== undefined && body.Value !== null ? Number(body.Value) : Math.max(100000000 - 1, ...options.map((o) => o.Value)) + 1;
      if (options.some((o) => o.Value === value)) return failure(400, '0x80047007', `An option with the value ${value} already exists.`);
      options.push({ Value: value, Label: metadata.label(body.Label), Description: metadata.label(null), Color: null, IsManaged: false, ExternalValue: null, ...(p === '/InsertStatusValue' ? { State: Number(body.StateCode) } : {}) });
      return json(200, { NewOptionValue: value });
    }
    // SaveSettingValue { SettingName, Value, AppUniqueName?, SolutionUniqueName? }: an app-scoped value is the `appsettings` row of that
    // app and definition, written to the app's SAVED layer (a publish of the app makes it effective — the build's AI step relies on that,
    // sdk-build.js 8b); without an app it is the organization's value. RetrieveSetting(SettingName='x',AppUniqueName='y') answers the
    // EFFECTIVE value — the published app override, else the organization's, else the definition's default — as
    // `{ "SettingDetail": { "Value": "true", "DataType": 2 } }`.
    // See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/reference/savesettingvalue
    // See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/reference/retrievesetting
    if (method === 'POST' && p === '/SaveSettingValue') {
      const definition = settingDefinition(body.SettingName);
      if (!definition) return failure(404, '0x80040217', `settingdefinition With Name = ${body.SettingName} Does Not Exist`);
      if (body.AppUniqueName) {
        const app = [...rowsOf('appmodules').values()].find((row) => lc(row.data.uniquename) === lc(body.AppUniqueName));
        if (!app) return failure(404, '0x80040217', `appmodule With UniqueName = ${body.AppUniqueName} Does Not Exist`);
        const held = [...rowsOf('appsettings').values()].find((row) => bare(row.data._parentappmoduleid_value) === app.id && bare(row.data._settingdefinitionid_value) === definition.id);
        if (held) { held.data.value = String(body.Value); held.version = nextVersion(); held.data.versionnumber = held.version; } else insertRow('appsettings', { _parentappmoduleid_value: app.id, _settingdefinitionid_value: definition.id, value: String(body.Value), uniquename: `${app.data.uniquename}_${definition.data.uniquename}` });
      } else {
        const held = [...rowsOf('organizationsettings').values()].find((row) => bare(row.data._settingdefinitionid_value) === definition.id);
        if (held) held.data.value = String(body.Value); else insertRow('organizationsettings', { _settingdefinitionid_value: definition.id, value: String(body.Value), uniquename: definition.data.uniquename });
      }
      return noContent();
    }
    const setting = /^\/RetrieveSetting\((.*)\)$/.exec(p);
    if (method === 'GET' && setting) {
      // SettingName is required, AppUniqueName optional; nothing else is a parameter of the function.
      const args = functionParameters(setting[1], ['SettingName', 'AppUniqueName'], ['SettingName'], 'RetrieveSetting');
      const definition = settingDefinition(args.SettingName);
      if (!definition) return failure(404, '0x80040217', `settingdefinition With Name = ${args.SettingName} Does Not Exist`);
      const appUnique = args.AppUniqueName;
      const app = appUnique && [...rowsOf('appmodules').values()].find((row) => lc(row.data.uniquename) === lc(appUnique));
      const override = app && [...rowsOf('appsettings').values()].find((row) => row.published && bare(row.published._parentappmoduleid_value) === app.id && bare(row.published._settingdefinitionid_value) === definition.id);
      const org = [...rowsOf('organizationsettings').values()].find((row) => bare(row.data._settingdefinitionid_value) === definition.id);
      const value = override ? override.published.value : org ? org.data.value : definition.data.defaultvalue;
      return json(200, { SettingDetail: { Name: definition.data.uniquename, Value: value, DataType: definition.data.datatype } });
    }
    return null;
  }
  const settingDefinition = (name) => [...rowsOf('settingdefinitions').values()].find((row) => lc(row.data.uniquename) === lc(name));
  // A function's parameters in its path, `Name='text'` pairs (a quote inside doubled: 'O''Neil') separated by commas, checked against
  // the ones it takes BEFORE anything is resolved: an unknown, repeated or missing required parameter, or a value that is not a text
  // literal (an alias, a number), is not modelled — never answered as though the parameter were simply not given.
  // See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/use-web-api-functions#passing-parameters-to-a-function
  function functionParameters(text, allowed, required, where) {
    const params = {};
    const pair = /\s*(\w+)\s*=\s*'((?:[^']|'')*)'\s*(,|$)/y;
    let at = 0;
    while (at < text.length) {
      pair.lastIndex = at;
      const m = pair.exec(text);
      if (!m || (m[3] === ',' && pair.lastIndex === text.length)) throw new Unmodelled(`the parameters (${text}) of ${where} are not modelled`);
      if (!allowed.includes(m[1]) || Object.prototype.hasOwnProperty.call(params, m[1])) throw new Unmodelled(`the parameter ${m[1]} of ${where} is not modelled`);
      params[m[1]] = m[2].replace(/''/g, "'");
      at = pair.lastIndex;
    }
    for (const name of required) if (!Object.prototype.hasOwnProperty.call(params, name)) throw new Unmodelled(`${where} without its ${name} is not modelled`);
    return params;
  }

  // A component of AddAppComponents, by its type: `{ "@odata.type": "Microsoft.Dynamics.CRM.savedquery", "savedqueryid": "<id>" }` or
  // the older `{ "@odata.id": "savedqueries(<id>)" }`. An app component's type is the solution component type of its kind.
  const APP_COMPONENT_TYPES = { systemform: 60, savedquery: 26, savedqueryvisualization: 59, sitemap: 62, appaction: 10129, entity: 1, uxagentproject: 10200 };
  function componentRef(c) {
    const typed = /Microsoft\.Dynamics\.CRM\.(\w+)$/.exec(String(c['@odata.type'] || ''));
    if (typed) {
      const kind = typed[1];
      if (kind === 'entity') return { id: bare(c.entityid || c.MetadataId), type: 1 };
      const info = SYSTEM_TABLES[kind];
      if (!info || !APP_COMPONENT_TYPES[kind]) throw new Unmodelled(`an app component of type ${kind}`);
      return { id: bare(c[info.id]), type: APP_COMPONENT_TYPES[kind] };
    }
    const ref = /^([A-Za-z_]\w*)\(([^)]+)\)$/.exec(String(c['@odata.id'] || ''));
    if (!ref) throw new Unmodelled(`an app component ${JSON.stringify(c)}`);
    const info = infoOfSet(ref[1]);
    return { id: bare(ref[2]), type: (info && APP_COMPONENT_TYPES[info.logical]) || 1 };
  }

  // ---------------------------------------------------------------------------------------------------------------------------
  // Rows: `/<set>`, `/<set>(<id>)`, `/<set>(<id>)/<navigation>` and `/<set>(<id>)/<navigation>/$ref` — and nothing else. A read is checked
  // against the set's schema first (checkRead); a write may carry only the `$select` of the row it answers with; a navigation must be one
  // the set declares.
  const noQuery = (query, where) => { const options = Object.keys(query || {}); if (options.length) throw new Unmodelled(`the query option ${options[0]} is not modelled on ${where}`); };
  function records(method, p, query, body, headers) {
    const m = /^\/([A-Za-z_]\w*)(?:\(([^)]*)\))?(?:\/(.+))?$/.exec(p);
    if (!m) throw new Unmodelled(`${method} ${p}`);
    const [, set, key, rest] = m;
    const info = infoOfSet(set);
    if (!info) throw new Unmodelled(`${method} ${p}: no table has the entity set ${set}`);
    if (key !== undefined) idOf(key, `${method} ${p}`);
    if (!key && !rest) {
      if (method === 'GET') return json(200, { value: readRows(set, query, { kind: 'collection', where: p }) });
      if (method === 'POST') { checkRead(set, query, 'write', p); return createRow(set, body, headers, query); }
    }
    if (key && !rest) {
      if (method === 'GET') {
        const { expands } = checkRead(set, query, 'single', p);
        // A read by id answers the row as saved, with its current version — the SDK reads a form right after it creates it
        // (`systemforms(<id>)?$select=formid`, for the token of its next write) and the platform answers it (fake-dataverse.js models the
        // same). Only a plain read of the COLLECTION is the published layer.
        const row = rowsOf(set).get(bare(key));
        if (!row) return failure(404, '0x80040217', `${info.logical} With Id = ${key} Does Not Exist`);
        // An app module is the exception: its read by id is the PUBLISHED projection, so a draft that was never published answers 404
        // (measured; helpers/fake-apps-org.js) — which is why the download tells the maker to publish a new app first.
        if (set === 'appmodules' && !row.published) return failure(404, '0x80040217', `appmodule With Id = ${key} Does Not Exist`);
        const data = set === 'appmodules' ? row.published : row.data;
        const shaped = shape(row, data, query, info, { saved: true });
        if (info.layered && !listOf(query.$select || '').includes('componentstate')) delete shaped.componentstate;
        // The checked `$expand` is applied as on a collection read: the lookup's row embedded, narrowed by its own `$select`.
        return json(200, withExpands(shaped, data, expands), { etag: shaped['@odata.etag'] });
      }
      if (method === 'PATCH') { checkRead(set, query, 'write', p); return updateRow(set, key, body, headers, query); }
      if (method === 'DELETE') { noQuery(query, p); return deleteRow(set, key); }
    }
    if (key && rest) {
      const schema = schemaOf(set);
      const ref = /^([A-Za-z_]\w*)(?:\(([^)]+)\))?\/\$ref$/.exec(rest);
      if (ref && !schema.navigations[ref[1]]) throw new Unmodelled(`${info.logical} has no navigation ${ref[1]} (${method} ${p})`);
      if (ref && method === 'POST') {
        noQuery(query, p);
        const target = /\/([A-Za-z_]\w*)\(([^)]+)\)$/.exec(String(body['@odata.id'] || ''));
        if (!target || target[1] !== schema.navigations[ref[1]]) throw new Unmodelled(`cannot read the reference ${JSON.stringify(body)} for ${ref[1]}`);
        idOf(target[2], `the reference of ${p}`);
        // An N:N link that exists already is refused as a duplicate, as Dataverse does (sdk-build.js ensureAppAvailableToRole relies on it
        // and treats the refusal as "already linked").
        if (associations.some((a) => a.id === bare(key) && a.nav === ref[1] && a.toId === bare(target[2]))) return failure(400, '0x80040237', 'Cannot insert duplicate key.');
        associations.push({ set, id: bare(key), nav: ref[1], toSet: target[1], toId: bare(target[2]) });
        return noContent();
      }
      if (ref && method === 'DELETE') {
        for (const option of Object.keys(query)) if (option !== '$id') throw new Unmodelled(`the query option ${option} is not modelled on ${p}`);
        const toId = idOf(ref[2] || (/\(([^)]+)\)$/.exec(String(query.$id || '')) || [])[1], `DELETE ${p}`);
        const at = associations.findIndex((a) => a.id === bare(key) && a.nav === ref[1] && a.toId === toId);
        if (at === -1) return failure(404, '0x80040217', 'The association does not exist.');
        associations.splice(at, 1);
        return noContent();
      }
      const nav = /^([A-Za-z_]\w*)$/.exec(rest);
      if (nav && method === 'GET') {
        const target = schema.navigations[nav[1]];
        if (!target) throw new Unmodelled(`${info.logical} has no navigation ${nav[1]} (GET ${p})`);
        // The related rows, by the link either side made, answered as rows of the related set (its own schema, its own options).
        const linked = associations
          .filter((a) => a.nav === nav[1] && ((a.set === set && a.id === bare(key)) || (a.toSet === set && a.toId === bare(key))))
          .map((a) => rowsOf(target).get(a.set === set && a.id === bare(key) ? a.toId : a.id))
          .filter(Boolean);
        return json(200, { value: answerRows(target, linked, query, { saved: true, kind: 'navigation', where: p }) });
      }
    }
    throw new Unmodelled(`${method} ${p}`);
  }

  // ---------------------------------------------------------------------------------------------------------------------------
  // `$batch`: one change set, run atomically — every operation is applied to a copy of the state, and the copy is kept only when all
  // of them succeed; the answer then names every operation's status, or only the one that failed. Change sets of page rows go to the
  // page fake whole.
  // See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/execute-batch-operations-using-web-api#change-sets
  async function batch(text) {
    const operations = parseBatch(String(text));
    if (operations.length && operations.every((op) => PAGE_PATH.test(pathOf(op.path)))) {
      const res = await pageServer.receiveBatch(`${PAGE_API}/$batch`, String(text));
      return { statusCode: res.status, headers: { 'content-type': 'multipart/mixed; boundary=batchresponse_00000000-0000-0000-0000-000000000001', ...(res.headers || {}) }, body: typeof res.body === 'string' ? res.body : JSON.stringify(res.body) };
    }
    const saved = snapshotState();
    const statuses = [];
    for (const op of operations) {
      // eslint-disable-next-line no-await-in-loop
      const res = await dispatch(op.method, op.path, op.body, op.headers);
      if (res.statusCode < 200 || res.statusCode >= 300) {
        restoreState(saved);
        return batchAnswer([{ contentId: op.contentId, status: res.statusCode, body: res.body }]);
      }
      statuses.push({ contentId: op.contentId, status: res.statusCode, headers: res.headers });
    }
    return batchAnswer(statuses);
  }

  // The operations of a `$batch` request, as the SDK renders it (boundaries differ per request):
  //   --batch_<id>
  //   Content-Type: multipart/mixed;boundary=changeset_<id>
  //
  //   --changeset_<id>
  //   Content-Type: application/http
  //   Content-Transfer-Encoding: binary
  //   Content-ID: 1
  //
  //   POST https://contoso.crm.dynamics.com/api/data/v9.0/EntityDefinitions(LogicalName='contoso_item')/Attributes HTTP/1.1
  //   Content-Type: application/json;type=entry
  //   MSCRM.SolutionUniqueName: ContosoKitchen
  //
  //   {"@odata.type":"Microsoft.Dynamics.CRM.StringAttributeMetadata",…}
  //   --changeset_<id>--
  //   --batch_<id>--
  // RFC 2046: the CRLF before a delimiter belongs to the delimiter, not to the body.
  function parseBatch(text) {
    const outer = (/^--(\S+)/.exec(text) || [])[1];
    const inner = (/Content-Type:\s*multipart\/mixed;\s*boundary=(\S+)/i.exec(text) || [])[1];
    const boundary = inner || outer;
    if (!boundary) throw new Unmodelled('a $batch body without a boundary');
    return text.split(`--${boundary}`).slice(1).filter((segment) => !segment.startsWith('--')).map((segment) => {
      const mimeEnd = segment.search(/\r?\n\r?\n/);
      const mime = segment.slice(0, mimeEnd);
      const http = segment.slice(mimeEnd).replace(/^\r?\n\r?\n/, '');
      const headEnd = http.search(/\r?\n\r?\n/);
      const head = (headEnd === -1 ? http : http.slice(0, headEnd)).split(/\r?\n/);
      const [, method, url] = /^(\w+) (\S+) HTTP\/1\.1$/.exec(head[0]) || [];
      if (!method) throw new Unmodelled(`a $batch part without a request line: ${JSON.stringify(head[0])}`);
      const headers = {};
      for (const line of head.slice(1)) {
        const colon = line.indexOf(':');
        if (colon > 0) headers[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
      }
      const payload = headEnd === -1 ? '' : http.slice(headEnd).replace(/^\r?\n\r?\n/, '').replace(/\r?\n$/, '');
      const parsed = new URL(url, origin);
      const where = decodeURIComponent(parsed.pathname + parsed.search).replace(API_ROOT, '');
      // A part's body is JSON when its Content-Type says so; a file's content (a page's source) is kept as the text it is.
      const contentType = (Object.entries(headers).find(([k]) => lc(k) === 'content-type') || [])[1] || '';
      const body = !payload ? undefined : /json/i.test(contentType) ? JSON.parse(payload) : payload;
      return { contentId: (/^Content-ID:\s*(\S+)/im.exec(mime) || [])[1], method, path: where, headers, body };
    });
  }
  // The answer to a change set: the platform's own boundaries, one part per operation (or only the one that failed), Content-ID echoed.
  function batchAnswer(parts) {
    const outer = `batchresponse_${randomUUID()}`;
    const inner = `changesetresponse_${randomUUID()}`;
    const text = [
      `--${outer}`,
      `Content-Type: multipart/mixed; boundary=${inner}`,
      '',
      ...parts.map((part) => [
        `--${inner}`,
        'Content-Type: application/http',
        'Content-Transfer-Encoding: binary',
        `Content-ID: ${part.contentId}`,
        '',
        `HTTP/1.1 ${part.status} ${part.status < 300 ? (part.status === 204 ? 'No Content' : 'OK') : 'Bad Request'}`,
        ...Object.entries(part.headers || {}).filter(([k]) => /^(odata-entityid|location|etag)$/i.test(k)).map(([k, v]) => `${k === 'odata-entityid' ? 'OData-EntityId' : k}: ${v}`),
        'OData-Version: 4.0',
        ...(part.status >= 300 && part.body ? ['Content-Type: application/json; odata.metadata=minimal', '', String(part.body)] : ['']),
        '',
      ].join('\r\n')),
      `--${inner}--`,
      `--${outer}--`,
      '',
    ].join('\r\n');
    return { statusCode: 200, headers: { 'content-type': `multipart/mixed; boundary=${outer}`, 'odata-version': '4.0' }, body: text };
  }
  // The whole environment, for a change set to roll back to.
  const snapshotState = () => structuredClone({ sets, associations, tables: metadata.tables, relationships: metadata.relationships, optionSets: metadata.optionSets });
  function restoreState(saved) {
    for (const [target, source] of [[sets, saved.sets], [metadata.tables, saved.tables], [metadata.relationships, saved.relationships], [metadata.optionSets, saved.optionSets]]) {
      target.clear();
      for (const [k, v] of source) target.set(k, v);
    }
    associations.splice(0, associations.length, ...saved.associations);
  }

  // ---------------------------------------------------------------------------------------------------------------------------
  // The transport: `request({ url, method, headers, body })` -> `{ statusCode, headers, body }`, as lib/dataverse-auth.js makeRequest.
  async function request({ url, method, headers, body }) {
    const parsed = new URL(url);
    if (parsed.origin !== origin) throw new Error(`fake-lifecycle-org: a request to another origin: ${url}`);
    const where = decodeURIComponent(parsed.pathname + parsed.search).replace(API_ROOT, '');
    const type = (Object.entries(headers || {}).find(([k]) => lc(k) === 'content-type') || [])[1] || '';
    let parsedBody;
    if (body !== undefined && body !== null && body !== '') {
      if (Buffer.isBuffer(body) && !/json/i.test(type)) parsedBody = body;
      else if (/json/i.test(type) || !type) parsedBody = JSON.parse(String(body));
      else parsedBody = String(body);
    }
    const recorded = { method, path: where, body: parsedBody, headers };
    if (method === 'POST' && pathOf(where) === '/$batch') {
      try { recorded.operations = parseBatch(String(body)); } catch { /* recorded as sent; the dispatch below names the failure */ }
    }
    requests.push(recorded);
    try {
      const answer = await dispatch(method, where, parsedBody, headers);
      recorded.status = answer && answer.statusCode;
      return answer;
    } catch (error) {
      unexpected.push(`${method} ${where}: ${error && error.message}`);
      return failure(501, '0x80040265', `fake-lifecycle-org does not model ${method} ${where}: ${error && error.message}`);
    }
  }

  // ---------------------------------------------------------------------------------------------------------------------------
  // What a test reads.
  const resourceOf = (path) => pathOf(path).replace(/^\//, '').replace(/\((?:[^()']|'[^']*')*\)/g, '');
  // Every request that changed something since `mark`, a `$batch` as its operations.
  function writes(since = 0) {
    return requests.slice(since).flatMap((r) => {
      if (r.method === 'GET') return [];
      if (r.operations) return r.operations.filter((op) => op.method !== 'GET').map((op) => ({ ...op, batched: true }));
      return [r];
    });
  }
  // `METHOD resource` per write ("POST EntityDefinitions/Attributes", "PATCH savedqueries", "POST PublishXml").
  const writeNames = (since = 0) => writes(since).map((w) => `${w.method} ${resourceOf(w.path)}`);
  const countBy = (list) => list.reduce((acc, name) => { acc[name] = (acc[name] || 0) + 1; return acc; }, {});
  // Reads by `GET resource`, for a budget.
  const readNames = (since = 0) => requests.slice(since).filter((r) => r.method === 'GET').map((r) => `GET ${resourceOf(r.path)}`);

  // Everything the environment holds, by IDENTITY, named so two inventories can be compared: what was made and what was deleted (a
  // teardown must take it back to the seed). What each artifact HOLDS is contents()'s to compare.
  function inventory() {
    const label = (t) => t.LogicalName;
    const out = {
      tables: [...metadata.tables.values()].map(label).sort(),
      columns: Object.fromEntries([...metadata.tables.values()].map((t) => [t.LogicalName, [...t.Attributes.keys()].sort()])),
      keys: Object.fromEntries([...metadata.tables.values()].filter((t) => t.Keys.size).map((t) => [t.LogicalName, [...t.Keys.keys()].sort()])),
      relationships: [...metadata.relationships.values()].map((r) => r.SchemaName).sort(),
      optionSets: [...metadata.optionSets.values()].map((s) => s.Name).sort(),
      rows: {},
      solutionComponents: componentRows().map((c) => `${c.data._solutionid_value} ${c.data.componenttype} ${c.data.objectid}`).sort(),
      associations: associations.map((a) => `${a.set}(${a.id}) ${a.nav} ${a.toSet}(${a.toId})`).sort(),
      pages: [...pageServer.state.projects.keys()].sort(),
      pageFiles: [...pageServer.state.files.keys()].sort(),
      pageMessages: [...pageServer.state.messages.keys()].sort(),
    };
    // A row is named by its id and name; the rows that have no name of their own — a role's grant, a component of a solution or of an
    // app — by what they link, so two inventories compare what the environment holds and not the ids a replace minted.
    const describe = {
      roleprivilegescollection: (d) => `${d.roleid} ${d.privilegeid} ${d.privilegedepthmask}`,
      solutioncomponents: (d) => `${d._solutionid_value} ${d.componenttype} ${d.objectid}`,
      appmodulecomponents: (d) => `${d._appmoduleidunique_value} ${d.componenttype} ${d.objectid}`,
      appsettings: (d) => `${d._parentappmoduleid_value} ${d._settingdefinitionid_value} ${d.value}`,
    };
    for (const [set, rows] of sets) {
      if (!rows.size) continue;
      const info = infoOfSet(set);
      out.rows[set] = [...rows.values()].map((row) => (describe[set] ? describe[set](row.data) : `${row.id} ${info && info.name ? row.data[info.name] : ''}`.trim())).sort();
    }
    return out;
  }

  // Everything the environment holds BY CONTENT, keyed by identity — the proof that a command left another maker's work (and the
  // system's own rows and definitions) as it found it, where `inventory()` only proves what exists:
  //   `row <set> <id>`          a row's saved AND published layers, whole: a view's FetchXML and LayoutXML, a form's XML, a web resource's
  //                             content, a setting's value, a role's grant, a sample row's columns
  //   `table <logical>`         a definition whole: its columns (with their lengths, formats, ranges and option sets), keys and privileges
  //   `relationship <schema>` · `optionset <name>` (with its options) · `link <set>(<id>) <navigation> <set>(<id>)` (an N:N link)
  //   `page <id>` · `page file <id>` · `page message <id>` · `page published <id>`   a generative page, its files' content, its
  //                             conversation, and what its last publish made live
  // Each entry is `{ label, content }`, the content canonical (keys sorted, Maps as objects, bytes as base64). Nothing is normalized:
  // a row's `versionnumber` and `modifiedon` move on every write, and a publish that names a row moves its version — either is touching it.
  function contents() {
    const canon = (value) => {
      if (value instanceof Map) return canon(Object.fromEntries(value));
      if (value instanceof Set) return [...value].map(canon).sort();
      if (Buffer.isBuffer(value) || value instanceof Uint8Array) return { base64: Buffer.from(value).toString('base64') };
      if (Array.isArray(value)) return value.map(canon);
      if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canon(value[key])]));
      return value;
    };
    const out = {};
    for (const [set, rows] of sets) {
      const info = infoOfSet(set);
      for (const row of rows.values()) {
        const name = info && info.name ? row.data[info.name] : null;
        out[`row ${set} ${row.id}`] = { label: `${set} ${row.id}${name ? ` "${name}"` : ''}`, content: canon({ saved: row.data, published: row.published }) };
      }
    }
    for (const table of metadata.tables.values()) out[`table ${table.LogicalName}`] = { label: `table ${table.LogicalName}`, content: canon(table) };
    for (const r of metadata.relationships.values()) out[`relationship ${r.SchemaName}`] = { label: `relationship ${r.SchemaName}`, content: canon(r) };
    for (const set of metadata.optionSets.values()) out[`optionset ${set.Name}`] = { label: `global option set ${set.Name}`, content: canon(set) };
    for (const a of associations) {
      const key = `link ${a.set}(${a.id}) ${a.nav} ${a.toSet}(${a.toId})`;
      out[key] = { label: key, content: true };
    }
    const pages = pageServer.state;
    for (const [id, project] of pages.projects) out[`page ${id}`] = { label: `page ${id} "${project.name}"`, content: canon(project) };
    for (const [id, file] of pages.files) out[`page file ${id}`] = { label: `page file ${id} "${file.filename}"`, content: canon(file) };
    for (const [id, message] of pages.messages) out[`page message ${id}`] = { label: `page message ${id}`, content: canon(message) };
    for (const [id, published] of pageServer.publishedPages) out[`page published ${id}`] = { label: `the published page ${id}`, content: canon(published) };
    return out;
  }

  return {
    origin,
    API,
    request,
    requests,
    unexpected,
    publishes,
    metadata,
    pageServer,
    associations,
    solutionComponents: () => componentRows().map((c) => clone(c.data)),
    rowsOf,
    infoOfSet,
    IDS,
    mark: () => requests.length,
    since: (mark) => requests.slice(mark),
    writes,
    writeNames,
    writeCounts: (since = 0) => countBy(writeNames(since)),
    readNames,
    readCounts: (since = 0) => countBy(readNames(since)),
    inventory,
    contents,
    // Rows whose saved layer holds a change no publish has copied.
    unpublished: () => [...sets].flatMap(([set, rows]) => (isLayered(set) ? [...rows.values()].filter((row) => row.publishedVersion !== row.version).map((row) => `${set} ${row.data.name || row.id}`) : [])),
    // A row by name, saved layer: what the platform holds whatever is published.
    find: (set, predicate) => [...rowsOf(set).values()].map((row) => row.data).filter(predicate),
  };
}

module.exports = { createLifecycleOrg, SYSTEM_TABLES, IDS };
