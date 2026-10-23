'use strict';
// The harness the lifecycle tests share (lifecycle-matrix-real-bundle.test.js, lifecycle-scenarios-real-bundle.test.js): the
// kitchen-sink App Spec, and each command of the lifecycle run the way its CLI runs it — over the REAL vendored SDK, the plugin's own
// az-token HTTP client and a stateful fake Dataverse (helpers/fake-lifecycle-org.js) — so a test reads what reached the wire and what
// the environment holds afterwards. Nothing here is a stand-in for plugin code: build, download, verify and teardown are the scripts' own
// entry points, given the seams their CLIs give them (the SDK instances, the page backend, the auth probe).
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { createAzHttpClient } = require('../../lib/sdk-http-client.js');
const { createMakerSdk, createNodeWorkspaceStorage } = require('../../lib/maker-sdk.js');
const { buildModelApp } = require('../../build-model-app.js');
const { verifySpec } = require('../../lib/verify-spec.js');
const { readerFor } = require('../../verify-model-app.js');
const { appUniqueName } = require('../../lib/sdk-build.js');
const { makeGenpageSdk } = require('../../lib/genpage-sdk.js');
const { PHASES } = require('../../lib/stages.js');
const download = require('../../download-model-app.js');
const { teardownModelApp } = require('../../teardown-model-app.js');

// A token long enough for the client's scrubber, never sent anywhere: the transport is the fake.
const TOKEN = 'lifecycle-matrix-token-0123456789';
const PAGE_SOURCE = "import * as React from 'react';\nexport default function KitchenPage() { return <div>Kitchen</div>; }\n";
const ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M2 2h12v12H2z"/></svg>';

// Every feature the fake models faithfully (see the header of lifecycle-matrix-real-bundle.test.js for what is left out, and why).
function kitchenSinkSpec() {
  return {
    schemaVersion: 2,
    minimumPluginVersion: '2.13.0',
    solution: { uniqueName: 'ContosoKitchen', displayName: 'Contoso Kitchen', publisherPrefix: 'contoso', description: 'Every App Spec feature in one app.' },
    app: { name: 'Kitchen Sink', description: 'One app that uses every feature.', headerNavigationRefresh: false, newLook: true, tables: ['contact'] },
    globalChoices: [{ name: 'contoso_stage', displayName: 'Stage', options: ['Planned', 'Active', 'Done'] }],
    entities: [
      {
        schemaName: 'contoso_project', displayName: 'Project', pluralName: 'Projects', description: 'A unit of work.', vectorIcon: 'contoso_projecticon.svg',
        primaryAttribute: { schemaName: 'contoso_name', displayName: 'Name' },
        statusReasons: [{ label: 'In Review', state: 'Active' }],
        alternateKeys: [{ schemaName: 'contoso_emailkey', displayName: 'Email Key', columns: ['contoso_email'] }],
        columns: [
          { schemaName: 'contoso_email', displayName: 'Contact Email', type: 'Text', format: 'Email', maxLength: 200 },
          { schemaName: 'contoso_notes', displayName: 'Notes', type: 'Memo' },
          { schemaName: 'contoso_priority', displayName: 'Priority', type: 'Choice', options: ['Low', 'Medium', 'High'] },
          { schemaName: 'contoso_stage', displayName: 'Stage', type: 'Choice', globalChoice: 'contoso_stage' },
          { schemaName: 'contoso_labels', displayName: 'Labels', type: 'MultiChoice', options: ['Red', 'Green', 'Blue'] },
          { schemaName: 'contoso_billable', displayName: 'Billable', type: 'Boolean', trueLabel: 'Yes', falseLabel: 'No' },
          { schemaName: 'contoso_budget', displayName: 'Budget', type: 'Money' },
          { schemaName: 'contoso_due', displayName: 'Due', type: 'DateTime', dateFormat: 'DateOnly' },
          { schemaName: 'contoso_headcount', displayName: 'Headcount', type: 'Integer', minValue: 0, maxValue: 500 },
          { schemaName: 'contoso_bytes', displayName: 'Bytes', type: 'BigInt' },
          { schemaName: 'contoso_rate', displayName: 'Rate', type: 'Decimal', precision: 2 },
          { schemaName: 'contoso_score', displayName: 'Score', type: 'Double' },
          { schemaName: 'contoso_ref', displayName: 'Reference', type: 'AutoNumber', autoNumberFormat: 'P-{SEQNUM:5}' },
          { schemaName: 'contoso_contract', displayName: 'Contract', type: 'File', maxSizeKb: 1024 },
          { schemaName: 'contoso_logo', displayName: 'Logo', type: 'Image' },
        ],
      },
      {
        schemaName: 'contoso_task', displayName: 'Task Item', pluralName: 'Task Items', description: 'A step of a project.',
        primaryAttribute: { schemaName: 'contoso_title', displayName: 'Title' },
        columns: [
          { schemaName: 'contoso_hours', displayName: 'Hours', type: 'Integer' },
          { schemaName: 'contoso_done', displayName: 'Done', type: 'Boolean' },
          { schemaName: 'contoso_customer', displayName: 'Customer', type: 'Customer' },
        ],
      },
      // A plural that is not "<displayName>s": the round trip has to carry it, since a rebuild elsewhere cannot derive it.
      { schemaName: 'contoso_tag', displayName: 'Tag', pluralName: 'Tag Catalog', description: 'A label for tasks.', primaryAttribute: { schemaName: 'contoso_label', displayName: 'Label' }, columns: [] },
    ],
    relationships: [
      { type: 'OneToMany', referenced: 'contoso_project', referencing: 'contoso_task', lookup: { schemaName: 'contoso_ProjectId', displayName: 'Project' } },
      { type: 'OneToMany', referenced: 'contoso_project', referencing: 'contoso_project', lookup: { schemaName: 'contoso_ParentProjectId', displayName: 'Parent Project' } },
      { type: 'ManyToMany', entity1: 'contoso_task', entity2: 'contoso_tag' },
    ],
    webResources: [
      { name: 'contoso_project.js', displayName: 'Project Scripts', type: 'js', content: 'var Project={onLoad:function(ctx){},escalate:function(ctx){}};' },
      { name: 'contoso_projecticon.svg', displayName: 'Project Icon', type: 'svg', content: ICON_SVG },
    ],
    views: [
      { entity: 'contoso_project', name: 'Open Projects', description: 'Projects still running.', columns: ['contoso_name', 'contoso_priority', 'contoso_stage', 'contoso_due'], sort: [{ attr: 'contoso_name', dir: 'asc' }], filters: [{ attr: 'contoso_priority', op: 'eq', value: 'High' }] },
      { entity: 'contoso_task', name: 'Open Tasks', columns: ['contoso_title', 'contoso_hours'] },
      { entity: 'contoso_task', name: 'My Open Tasks', columns: ['contoso_title', 'contoso_hours'], filters: [{ attr: 'ownerid', op: 'eq-userid' }, { attr: 'contoso_done', op: 'eq', value: 0 }] },
    ],
    charts: [{ entity: 'contoso_project', name: 'Projects by Priority', chartType: 'Pie', groupBy: 'contoso_priority', measure: 'count', description: 'Workload by priority.' }],
    forms: [
      {
        entity: 'contoso_project', name: 'Project', layout: 'auto', description: 'The project record.', notes: true,
        subgrids: [{ childEntity: 'contoso_task', view: 'Open Tasks', label: 'Tasks' }],
        events: [{ event: 'onload', library: 'contoso_project.js', function: 'Project.onLoad' }],
        securityRoles: { personas: ['Kitchen Planner'], fallbackForm: true, order: 0 },
      },
      { entity: 'contoso_task', name: 'Task Quick Create', formType: 'QuickCreate', layout: 'auto' },
      { entity: 'contoso_project', name: 'Project Card', formType: 'QuickView', layout: 'auto' },
      { entity: 'contoso_task', name: 'Task', layout: 'auto', quickViews: [{ lookup: 'contoso_projectid', targetEntity: 'contoso_project', form: 'Project Card', label: 'Project' }] },
    ],
    commands: [
      { entity: 'contoso_project', label: 'Escalate', location: 'MainTab', library: 'contoso_project.js', function: 'Project.escalate' },
      { entity: 'contoso_project', label: 'More', type: 'FlyoutAnchor', children: [{ label: 'Approve', library: 'contoso_project.js', function: 'Project.escalate' }] },
    ],
    dashboards: [{
      name: 'Kitchen Overview', description: 'Project health.', tiles: [
        { type: 'chart', chart: 'Projects by Priority', view: 'Open Projects' },
        { type: 'list', view: 'Open Projects', name: 'Open' },
        { type: 'iframe', url: 'https://contoso.example/status', name: 'Status', colspan: 2, rowspan: 8 },
      ],
    }],
    pages: [{ key: 'overview', name: 'Kitchen Page', purpose: 'A page over projects.', dataSources: ['contoso_project'], source: { kind: 'tsx', codeFile: 'KitchenPage.tsx' } }],
    appShell: {
      areas: [{
        label: 'Work',
        groups: [{
          label: 'Records',
          subAreas: [
            { entity: 'contoso_project', title: 'Projects' },
            { entity: 'contoso_task', title: 'Tasks' },
            { entity: 'contoso_tag', title: 'Tags' },
            { dashboard: 'Kitchen Overview', title: 'Overview' },
            { url: 'https://contoso.example/help', title: 'Help' },
            { page: 'overview', title: 'Kitchen Page' },
          ],
        }],
      }],
    },
    sampleData: {
      contoso_project: [{ contoso_name: 'Apollo', contoso_priority: 'High', contoso_stage: 'Active', contoso_billable: true, contoso_headcount: 4, statusReason: 'In Review' }],
      contoso_task: [{ contoso_title: 'Kickoff', contoso_hours: 2, $parent: { entity: 'contoso_project', match: { contoso_name: 'Apollo' } } }],
    },
    personas: [{
      persona: 'Kitchen Planner',
      jobs: [{ name: 'Plan projects', surfaces: ['Open Projects', 'Project'], privileges: [{ entity: 'contoso_project', access: ['read', 'write', 'create'], scope: 'businessUnit' }, { entity: 'contoso_task', access: ['read'], scope: 'user' }] }],
    }],
    roleGrants: [{ role: 'Basic User', privileges: [{ entity: 'contoso_tag', access: ['read'], scope: 'organization' }] }],
  };
}

// The commands of the lifecycle against one fake environment. `root` is a temporary folder the caller removes; the app folder in it
// holds the page's source, and its `.maker-workspace` is the build's, as the CLI makes it next to app-spec.json.
function createLifecycleHarness(org, root) {
  const appDir = path.join(root, 'app');
  const workspaceDir = path.join(appDir, '.maker-workspace');
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.writeFileSync(path.join(appDir, 'KitchenPage.tsx'), PAGE_SOURCE);
  // The production client, over the fake's transport: retries, change sets and the token scrubber are the ones a maker runs.
  const client = createAzHttpClient(org.origin, { getToken: () => TOKEN, request: org.request, sleep: async () => {} });
  const throwaway = (prefix) => fs.mkdtempSync(path.join(root, prefix));

  // build-model-app.js: the two SDK instances its makeSdk makes — one that names the solution, and the header-less one that owns the app
  // folder's workspace and recovers a form create whose answer was lost — and the deps its main() hands buildModelApp.
  async function build(spec, { apply = true, publish = true, sampleData = true, verify = true, appFolder = appDir, workspace = workspaceDir, languageCode = 1033 } = {}) {
    const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(throwaway('sdk-')), instanceUrl: org.origin, httpClient: client, solutionUniqueName: spec.solution.uniqueName, languageCode });
    const provisionSdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(apply ? workspace : throwaway('preview-')), instanceUrl: org.origin, httpClient: client, languageCode, createRecovery: 'adoptExact' });
    await provisionSdk.initWorkspace();
    const genpage = makeGenpageSdk(org.origin, { httpClient: client });
    const warnings = [];
    const log = [];
    try {
      const result = await buildModelApp(spec, {
        apply, publish, sampleData, verify, phases: PHASES, profile: apply ? 'deploy' : 'plan', nonInteractive: false,
        appDir: appFolder, env: org.origin, workspaceDir: workspace, preResolvedLanguageCode: apply ? languageCode : undefined,
      }, {
        sdk, provisionSdk, genpage, sleep: async () => {}, warn: (m) => warnings.push(String(m)), log: (m) => log.push(String(m)), provisionedLanguages: async () => org.pageServer.languages.provisioned,
        verify: async (s, o) => verifySpec(s, readerFor(provisionSdk, appUniqueName(s), { genpage, workspaceDir: workspace }), o),
      });
      return { result, warnings, log };
    } finally {
      await genpage.dispose();
    }
  }

  // download-model-app.js main(), with the seams it gives: the result printer, the process exit, the auth probe, the HTTP client.
  async function downloadApp(appUnique, outDir, { languageCode } = {}) {
    let emitted;
    const stderr = [];
    // runDownload writes its WARNING lines to process.stderr itself (main's `stderr` seam carries the rest): both are what the maker reads.
    const write = process.stderr.write;
    process.stderr.write = (text) => { stderr.push(String(text)); return true; };
    try {
      await download.main({
        argv: ['--env', org.origin, '--app', appUnique, '--out', outDir, ...(languageCode ? ['--language-code', String(languageCode)] : [])],
        stderr: { write: (text) => { stderr.push(String(text)); return true; } },
        exit: (code) => { throw new Error(`download exited ${code}: ${stderr.join('')}`); },
        emitResult: (ok, payload) => { emitted = { ok, payload }; },
        preflightAuth: async () => ({ ok: true }),
        httpClient: client,
      });
    } finally {
      process.stderr.write = write;
    }
    const specPath = path.join(outDir, 'app-spec.json');
    return { emitted, stderr: stderr.join(''), spec: fs.existsSync(specPath) ? JSON.parse(fs.readFileSync(specPath, 'utf8')) : null, dir: outDir, text: fs.existsSync(specPath) ? fs.readFileSync(specPath, 'utf8') : null };
  }

  // verify-model-app.js: a throwaway SDK workspace, the page backend's own; the app folder is only read, for the build's baseline.
  async function verify(spec, { workspace = workspaceDir } = {}) {
    const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(throwaway('verify-')), instanceUrl: org.origin, httpClient: client });
    await sdk.initWorkspace();
    const genpage = makeGenpageSdk(org.origin, { httpClient: client });
    try {
      return await verifySpec(spec, readerFor(sdk, appUniqueName(spec), { genpage, workspaceDir: workspace }), { languageCode: 1033 });
    } finally {
      await genpage.dispose();
    }
  }

  // teardown-model-app.js: a throwaway SDK workspace; the build's workspace is where it fences the changed-only snapshot.
  async function teardown(spec, { apply = true, workspace = workspaceDir } = {}) {
    const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(throwaway('teardown-')), instanceUrl: org.origin, httpClient: client });
    await sdk.initWorkspace();
    const log = [];
    const result = await teardownModelApp(spec, { apply, allowDestructive: apply, workspaceDir: workspace, env: org.origin }, { sdk, log: (m) => log.push(String(m)) });
    return { result, log };
  }

  // Runs `fn` and records what it sent: the writes per `METHOD resource`, the reads, every request, what the fake did not model, how long
  // it took, and what is left saved but unpublished. A throw is recorded, not raised, so a caller can still read what was sent.
  async function measure(fn) {
    const mark = org.mark();
    const unexpected = org.unexpected.length;
    const started = performance.now();
    const record = { mark };
    try {
      record.value = await fn();
    } catch (error) {
      record.error = error;
    }
    record.ms = Math.round(performance.now() - started);
    record.end = org.mark();
    record.writes = org.writeCounts(mark);
    record.reads = org.requests.slice(mark, record.end).filter((r) => r.method === 'GET').length;
    record.unexpected = org.unexpected.slice(unexpected);
    record.unpublished = org.unpublished();
    return record;
  }

  return { client, appDir, workspaceDir, build, download: downloadApp, verify, teardown, measure };
}

// Another maker's work, already in the environment before the kitchen sink is built: a solution of another publisher with a table (and
// on it a view that has the same name as one of the spec's views), an app with its navigation, a generative page, a web resource, a
// global choice and a security role. A build must not touch any of it, and a teardown must leave every row of it where it was — which
// a test proves by comparing the inventory before and after. It is created through the fake's own transport, as the maker's tools would.
const FOREIGN = {
  publisher: '22222222-0000-4000-8000-000000000001',
  solution: '22222222-0000-4000-8000-000000000002',
  app: '22222222-0000-4000-8000-000000000003',
  sitemap: '22222222-0000-4000-8000-000000000004',
  page: '22222222-0000-4000-8000-000000000005',
};
async function seedForeignWork(org) {
  const send = async (method, where, body, headers = {}) => {
    const res = await org.request({ url: `${org.API}${where}`, method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (res.statusCode >= 300) throw new Error(`seeding ${method} ${where} answered ${res.statusCode}: ${res.body}`);
  };
  const label = (text) => ({ LocalizedLabels: [{ Label: text, LanguageCode: 1033 }] });
  const inSolution = { 'MSCRM.SolutionUniqueName': 'FabrikamCore' };
  await send('POST', '/publishers', { publisherid: FOREIGN.publisher, uniquename: 'fabrikam', friendlyname: 'Fabrikam', customizationprefix: 'fabrikam', customizationoptionvalueprefix: 20000 });
  await send('POST', '/solutions', { solutionid: FOREIGN.solution, uniquename: 'FabrikamCore', friendlyname: 'Fabrikam Core', version: '1.0.0.0', 'publisherid@odata.bind': `/publishers(${FOREIGN.publisher})` });
  await send('POST', '/EntityDefinitions', { '@odata.type': 'Microsoft.Dynamics.CRM.EntityMetadata', SchemaName: 'fabrikam_widget', DisplayName: label('Widget'), DisplayCollectionName: label('Widgets'), OwnershipType: 'UserOwned', HasNotes: false, HasActivities: false, Attributes: [{ '@odata.type': 'Microsoft.Dynamics.CRM.StringAttributeMetadata', SchemaName: 'fabrikam_name', IsPrimaryName: true, MaxLength: 100, DisplayName: label('Name'), RequiredLevel: { Value: 'None' } }] }, inSolution);
  await send('POST', '/savedqueries', { name: 'Open Projects', returnedtypecode: 'fabrikam_widget', querytype: 0, fetchxml: '<fetch version="1.0" mapping="logical"><entity name="fabrikam_widget"><attribute name="fabrikam_name" /></entity></fetch>', layoutxml: '<grid name="resultset" object="10400" jump="fabrikam_name" select="1" icon="1" preview="1"><row name="result" id="fabrikam_widgetid"><cell name="fabrikam_name" width="300" /></row></grid>' }, inSolution);
  await send('POST', '/GlobalOptionSetDefinitions', { '@odata.type': 'Microsoft.Dynamics.CRM.OptionSetMetadata', Name: 'fabrikam_size', DisplayName: label('Size'), IsGlobal: true, OptionSetType: 'Picklist', Options: [{ Value: 200000000, Label: label('Small') }] }, inSolution);
  await send('POST', '/webresourceset', { name: 'fabrikam_widget.js', displayname: 'Widget Scripts', webresourcetype: 3, content: Buffer.from('var Widget = {};').toString('base64') }, inSolution);
  await send('POST', '/roles', { name: 'Fabrikam Reader', 'businessunitid@odata.bind': '/businessunits(11111111-0000-4000-8000-000000000002)' }, inSolution);
  await send('POST', '/appmodules', { appmoduleid: FOREIGN.app, name: 'Fabrikam Widgets', uniquename: 'fabrikam_widgets', clienttype: 4 });
  await send('POST', '/sitemaps', { sitemapid: FOREIGN.sitemap, sitemapnameunique: 'fabrikam_widgets', sitemapname: 'Fabrikam Widgets', sitemapxml: '<SiteMap IntroducedVersion="7.0.0.0"><Area Id="area_0"><Group Id="group_0"><SubArea Id="sub_0" Entity="fabrikam_widget" /></Group></Area></SiteMap>' });
  await send('POST', '/AddAppComponents', { AppId: FOREIGN.app, Components: [{ '@odata.type': 'Microsoft.Dynamics.CRM.sitemap', sitemapid: FOREIGN.sitemap }] });
  await send('POST', '/PublishXml', { ParameterXml: `<importexportxml><entities><entity>fabrikam_widget</entity></entities><appmodules><appmodule>${FOREIGN.app}</appmodule></appmodules></importexportxml>` });
  // A generative page of the other app, published.
  org.pageServer.seedPage(FOREIGN.page, { name: 'Widget Board' });
  org.pageServer.publishProject(org.pageServer.state, FOREIGN.page);
}

// What the environment holds of each feature of the kitchen-sink spec, read from the fake's state (not from what a build reports): the
// deployed facts the matrix compares with the spec, and a recovery test compares with a clean build's.
function deployedFeatures(org) {
  const label = (l) => (l && l.UserLocalizedLabel ? l.UserLocalizedLabel.Label : null);
  const tables = {};
  for (const t of org.metadata.tables.values()) {
    if (!t.LogicalName.startsWith('contoso_')) continue;
    // The columns a maker sees: custom, not the table's id, not the companion of another column — and not a Money column's
    // base-currency twin, which is a physical custom column with no AttributeOf, told apart only by `IsBaseCurrency`
    // (fake-lifecycle-metadata.js companionsOf). An Image column is the one column that is `AttributeOf` something and still a column
    // (it is the projection of its `<name>id`, MEASURED live), and that `<name>id` is a custom Uniqueidentifier that is `AttributeOf`
    // nothing — no App Spec column is a Uniqueidentifier, so none is listed.
    const fileOrImage = (a) => ['FileType', 'ImageType'].includes(a.AttributeTypeName && a.AttributeTypeName.Value);
    const attributes = [...t.Attributes.values()].filter((a) => a.IsCustomAttribute && (!a.AttributeOf || fileOrImage(a)) && !a.IsPrimaryId && a.AttributeType !== 'Uniqueidentifier' && a.IsBaseCurrency !== true);
    // A column as `<AttributeTypeName> <RequiredLevel>` and then what its type carries: a text format and length, a whole number's
    // format and range, a decimal's precision, an auto-number format, a file's size, a Boolean's two labels, a choice's options (and
    // whether they are a global set's), a lookup's targets.
    const detail = (a) => [
      a.AttributeTypeName.Value, a.RequiredLevel.Value,
      ...(a.FormatName && a.FormatName.Value !== 'Text' ? [a.FormatName.Value] : []), ...(a.Format ? [a.Format] : []),
      ...(a.MaxLength !== undefined && a.AttributeType === 'String' ? [`max ${a.MaxLength}`] : []),
      ...(a.MinValue !== undefined || a.MaxValue !== undefined ? [`${a.MinValue}..${a.MaxValue}`] : []),
      ...(a.Precision !== undefined ? [`precision ${a.Precision}`] : []),
      ...(a.AutoNumberFormat ? [a.AutoNumberFormat] : []),
      ...(a.MaxSizeInKB !== undefined ? [`${a.MaxSizeInKB} KB`] : []),
      ...(a.OptionSet && a.OptionSet.TrueOption ? [`${label(a.OptionSet.TrueOption.Label)}/${label(a.OptionSet.FalseOption.Label)}`] : []),
      ...(a.OptionSet && a.OptionSet.Options.length ? [`${a.OptionSet.IsGlobal ? 'global ' : ''}${a.OptionSet.Options.map((o) => label(o.Label)).join('|')}`] : []),
      ...(a.Targets ? [a.Targets.join('|')] : []),
    ].join(' ');
    tables[t.LogicalName] = {
      plural: label(t.DisplayCollectionName),
      icon: t.IconVectorName || null,
      quickCreate: t.IsQuickCreateEnabled === true,
      intersect: t.IsIntersect || undefined,
      columns: Object.fromEntries(attributes.map((a) => [a.LogicalName, detail(a)]).sort()),
      keys: [...t.Keys.values()].map((k) => `${k.SchemaName}(${k.KeyAttributes.join(',')})`),
      statusReasons: (t.Attributes.get('statuscode').OptionSet.Options || []).map((o) => `${o.Value} ${label(o.Label)} state ${o.State}`),
    };
    for (const key of Object.keys(tables[t.LogicalName])) if (tables[t.LogicalName][key] === undefined) delete tables[t.LogicalName][key];
  }
  const rows = (set, predicate = () => true) => org.find(set, predicate);
  const own = (set, column) => rows(set, (r) => String(r[column] || '').startsWith('contoso_'));
  // The kitchen sink's own app, navigation, page, option sets and web resources — another maker's are in the environment too.
  const app = rows('appmodules', (a) => a.uniquename === 'contoso_kitchensink')[0] || {};
  const appRow = org.rowsOf('appmodules').get(app.appmoduleid);
  const appComponents = rows('appmodulecomponents', (c) => c._appmoduleidunique_value === app.appmoduleidunique);
  const sitemap = rows('sitemaps', (m) => m.sitemapnameunique === 'contoso_kitchensink')[0] || {};
  const setting = (name) => {
    const def = rows('settingdefinitions', (d) => d.uniquename === name)[0];
    const row = def && rows('appsettings', (s) => s._settingdefinitionid_value === def.settingdefinitionid)[0];
    return row ? row.value : null;
  };
  const roleNamed = (name) => rows('roles', (r) => r.name === name)[0];
  const grantsOf = (role) => rows('roleprivilegescollection', (g) => role && g.roleid === role.roleid)
    .map((g) => `${(rows('privileges', (p) => p.privilegeid === g.privilegeid)[0] || {}).name} ${g.privilegedepthmask}`).sort();
  const page = [...org.pageServer.state.projects.values()].find((p) => p.name === 'Kitchen Page');
  return {
    tables,
    relationships: [...org.metadata.relationships.values()].map((r) => (r.RelationshipType === 'ManyToManyRelationship' ? `${r.SchemaName} N:N ${r.Entity1LogicalName}-${r.Entity2LogicalName}` : `${r.SchemaName} 1:N ${r.ReferencedEntity}->${r.ReferencingEntity}.${r.ReferencingAttribute}`)).sort(),
    optionSets: Object.fromEntries([...org.metadata.optionSets.values()].filter((s) => s.Name.startsWith('contoso_')).map((s) => [s.Name, s.Options.map((o) => `${o.Value} ${label(o.Label)}`)])),
    views: own('savedqueries', 'returnedtypecode').filter((v) => !/^(Active|Inactive|Quick Find Active) |( Advanced Find View| Lookup View| Associated View)$/.test(v.name)).map((v) => `${v.returnedtypecode}: ${v.name}`).sort(),
    // A chart as it draws: the series' type from its presentation XML, and what its data XML measures by what —
    //   <Chart …><Series><Series ChartType="Pie" … /></Series>…</Chart>
    //   <datadefinition><fetchcollection><fetch … aggregate="true"><entity name="contoso_project">
    //     <attribute alias="agg_0" name="contoso_projectid" aggregate="count" /><attribute alias="grp_0" name="contoso_priority" groupby="true" />
    // as `Pie: count(contoso_projectid) by contoso_priority` (the attributes' order and aliases do not matter).
    charts: rows('savedqueryvisualizations').map((c) => {
      const attributes = [...String(c.datadescription || '').matchAll(/<attribute\b([^>]*?)\/?>/g)].map((m) => Object.fromEntries([...m[1].matchAll(/(\w+)="([^"]*)"/g)].map((x) => [x[1], x[2]])));
      const types = [...String(c.presentationdescription || '').matchAll(/ChartType="([^"]+)"/g)].map((m) => m[1]);
      const measures = attributes.filter((a) => a.aggregate).map((a) => `${a.aggregate}(${a.name})`);
      const groups = attributes.filter((a) => a.groupby === 'true').map((a) => a.name);
      return `${c.primaryentitytypecode}: ${c.name} (${types.join('/')}: ${measures.join(', ')} by ${groups.join(', ')})`;
    }),
    forms: own('systemforms', 'objecttypecode').map((f) => `${f.objecttypecode}: ${f.name} (type ${f.type}${f.isdefault ? ', default' : ''})`).sort(),
    dashboards: rows('systemforms', (f) => f.type === 0).map((f) => f.name),
    commands: rows('appactions').map((a) => a.contextvalue).sort(),
    webResources: rows('webresourceset', (w) => w.name.startsWith('contoso_')).map((w) => w.name).sort(),
    app: {
      uniquename: app.uniquename,
      published: !!(appRow && appRow.published),
      // The tables the app holds, by name, and the kinds of its other components (26 view, 59 chart, 60 form or dashboard, 62 sitemap).
      tables: appComponents.filter((c) => c.componenttype === 1).map((c) => ([...org.metadata.tables.values()].find((t) => t.MetadataId.toLowerCase() === String(c.objectid).toLowerCase()) || {}).LogicalName).sort(),
      components: [...new Set(appComponents.map((c) => c.componenttype))].sort((a, b) => a - b),
    },
    navigation: [...String(sitemap.sitemapxml || '').matchAll(/<SubArea\b[^>]*?\bId="([^"]+)"/g)].length,
    settings: { NewLookAlwaysOn: setting('NewLookAlwaysOn'), HeaderAndNavigationRefresh: setting('HeaderAndNavigationRefresh') },
    page: page ? { name: page.name, published: org.pageServer.publishedPages.has(page.id) } : null,
    personaRole: grantsOf(roleNamed('Kitchen Planner')),
    basicUserGrants: grantsOf(roleNamed('Basic User')),
    records: {
      projects: rows('contoso_projects').map((r) => `${r.contoso_name} status ${r.statuscode}`),
      tasks: rows('contoso_tasks').map((r) => `${r.contoso_title} -> ${(rows('contoso_projects', (p) => p.contoso_projectid === r._contoso_projectid_value)[0] || {}).contoso_name}`),
    },
    unpublished: org.unpublished(),
  };
}

// The publishes a measured step sent (`measure` gives its marks), each as the tables and kinds it names: `app`, `page` and `webresource`
// stand for the id of one.
function publishesOf(org, step) {
  return org.requests.slice(step.mark, step.end).filter((r) => r.path === '/PublishXml').map((r) => {
    const xml = String(r.body.ParameterXml);
    const named = (tag) => [...xml.matchAll(new RegExp(`<${tag}>([^<]+)</${tag}>`, 'g'))].map((match) => match[1]);
    return [...named('entity'), ...named('appmodule').map(() => 'app'), ...named('uxagentproject').map(() => 'page'), ...named('webresource').map(() => 'webresource')].join(' ');
  });
}

// What changed between two `org.contents()` (fake-lifecycle-org.js): an artifact of `before` that is gone, or that holds something
// else (naming the first fields that differ: `saved.fetchxml`, `Attributes.fabrikam_name`, `Options`); and — unless `added: false` —
// one that `after` holds and `before` did not. One line each, empty when nothing changed. A command that only reads must leave the
// whole environment as it was; one that builds or tears down must leave every artifact it did not make as it was (`added: false`, the
// identity inventory then proving what it made and deleted).
function diffContents(before, after, { added = true } = {}) {
  const out = [];
  const differing = (a, b, at, depth) => {
    if (JSON.stringify(a) === JSON.stringify(b)) return [];
    if (depth >= 2 || !a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) || Array.isArray(b)) return [at || '(the value)'];
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap((key) => differing(a[key], b[key], at ? `${at}.${key}` : key, depth + 1));
  };
  for (const [key, entry] of Object.entries(before)) {
    if (!Object.prototype.hasOwnProperty.call(after, key)) { out.push(`gone: ${entry.label}`); continue; }
    const fields = differing(entry.content, after[key].content, '', 0);
    if (fields.length) out.push(`changed: ${entry.label} (${fields.slice(0, 6).join(', ')}${fields.length > 6 ? `, +${fields.length - 6} more` : ''})`);
  }
  if (added) for (const [key, entry] of Object.entries(after)) if (!Object.prototype.hasOwnProperty.call(before, key)) out.push(`added: ${entry.label}`);
  return out;
}

module.exports = { kitchenSinkSpec, createLifecycleHarness, seedForeignWork, deployedFeatures, publishesOf, diffContents, FOREIGN, appUniqueName, PAGE_SOURCE, ICON_SVG };
