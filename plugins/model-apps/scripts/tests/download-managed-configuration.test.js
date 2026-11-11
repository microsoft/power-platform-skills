'use strict';
// The explicit managed download (download-model-app.js main, --include-managed --managed-manifest <store>) of protected configuration
// (configurationIdentity "stable-v1"): the items are built into the strict configuration org by the real build command and the real
// SDK bundle (helpers/configuration-command.js), downloaded through main with only its connections replaced, rebuilt from the
// downloaded spec over the same app folder, and downloaded again. runDownload answers what the plain download of this app gives: a
// spec with no configuration lists (a plain download never writes one).
//
// Privacy is proved with synthetic canaries: every current value, default, value schema and secret reference the build is given is a
// unique marker, and every file and stream the download writes (the output folder, the download SDK's own workspace, stderr and the
// result) is scanned for each, on a restore, a refusal and a failed read alike.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeTempDir } = require('./helpers/temp-dirs.js');
const { runCommand } = require('./helpers/configuration-command.js');
const { createConfigOrg } = require('./helpers/fake-config-org.js');
const { createMakerSdk, createNodeWorkspaceStorage } = require('../lib/maker-sdk.js');
const { createAzHttpClient } = require('../lib/sdk-http-client.js');
const { main: downloadMain } = require('../download-model-app.js');

const SOLUTION = 'ContosoSol';
const APP = 'contoso_configprobe';
const APP_ID = '00000000-0000-4000-8000-00000000c0f1';
const SP = '/providers/Microsoft.PowerApps/apis/shared_sharepointonline';
const SQL = '/providers/Microsoft.PowerApps/apis/shared_sql';
const CANARY = {
  value: 'canary-value-4c1d',
  siteValue: 'canary-site-3a9d',
  default: 'canary-default-8e2f',
  jsonDefault: 'canary-jsondefault-2b70',
  schema: 'canary-schema-5e1b',
  vault: 'canaryvault7d',
  need: 'canary-need-91c4',
  connection: 'canary-conn-6f3e',
};
const KEY_VAULT = `/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg/providers/Microsoft.KeyVault/vaults/${CANARY.vault}/secrets/apikey`;

// What the plain download of the app answers: no configuration lists.
const PLAIN = {
  solution: { uniqueName: SOLUTION, displayName: 'Contoso Sol', publisherPrefix: 'contoso', version: '1.2.0.0' },
  app: { name: 'Config Probe', uniqueName: APP },
  schemaVersion: 2,
  entities: [],
  appShell: { areas: [{ label: 'Main', groups: [{ label: 'Links', subAreas: [{ url: 'https://contoso.example/help', title: 'Help' }] }] }] },
};
const VARIABLES = [
  { schemaName: 'contoso_ApiBase', type: 'string', name: 'API base', description: 'Base address', defaultValue: `https://${CANARY.default}.contoso.example`, isRequired: true },
  { schemaName: 'contoso_Shape', type: 'json', defaultValue: `{"k":"${CANARY.jsonDefault}"}`, valueSchema: `{"type":"object","title":"${CANARY.schema}"}` },
  { schemaName: 'contoso_ApiKey', type: 'secret' },
  { schemaName: 'contoso_Site', type: 'dataSource', connectorId: SP, parameterKey: 'dataset' },
  { schemaName: 'contoso_List', type: 'dataSource', connectorId: SP, parameterKey: 'table', parentSchemaName: 'contoso_Site' },
];
const SETTINGS = {
  EnvironmentVariables: [
    { SchemaName: 'contoso_ApiBase', Value: `https://${CANARY.value}.contoso.example` },
    { SchemaName: 'contoso_ApiKey', Value: KEY_VAULT },
    { SchemaName: 'contoso_Site', Value: `https://${CANARY.siteValue}.sharepoint.example/sites/a` },
  ],
};
const protectedSpec = (extra) => ({ ...PLAIN, minimumPluginVersion: '2.25.0', configurationIdentity: 'stable-v1', ...extra });

const walk = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)])) : []);
const snapshot = (dir) => Object.fromEntries(walk(dir).map((f) => [path.relative(dir, f), fs.readFileSync(f).toString('base64')]));

// The real build command over the strict org, with deployment settings carrying the canary values. Answers the org, the app folder
// (whose .maker-workspace holds the binding store) and the store file.
async function built({ lists = { environmentVariables: VARIABLES }, settings = SETTINGS, intercept = {} } = {}) {
  const org = createConfigOrg({ solution: { uniqueName: SOLUTION, version: '1.0.0.0', prefix: 'contoso' }, intercept: (req) => (intercept.fn ? intercept.fn(req) : undefined) });
  const appDir = path.join(makeTempDir('dl-cfg-'), 'app');
  const settingsFile = path.join(makeTempDir('dl-cfg-settings-'), 'settings.json');
  fs.writeFileSync(settingsFile, JSON.stringify(settings));
  const out = await runCommand(protectedSpec(lists), { org, appDir, argv: ['--stage', 'data', '--allow-destructive', '--deployment-settings', settingsFile] });
  assert.ok(!out.exitCode && !out.thrown && out.payload && out.payload.ok, JSON.stringify(out.payload || out.thrown));
  const ws = path.join(appDir, '.maker-workspace');
  const store = path.join(ws, fs.readdirSync(ws).find((f) => f.startsWith('managed-bindings.')));
  return { org, appDir, store };
}

// download-model-app.js main with its connections replaced: the real SDK over the org's transport, a workspace of its own, and
// runDownload answering the plain download (PLAIN).
async function downloadSdk(org, workspace = makeTempDir('dl-cfg-ws-')) {
  const sdk = createMakerSdk({
    workspaceStorage: createNodeWorkspaceStorage(workspace),
    instanceUrl: org.origin,
    httpClient: createAzHttpClient(org.origin, { getToken: () => 'test-token-0123456789abcdef', request: (r) => org.request(r), sleep: async () => {} }),
  });
  await sdk.initWorkspace();
  return sdk;
}

async function download(org, store, { out = makeTempDir('dl-cfg-out-'), managed = true } = {}) {
  const workspace = makeTempDir('dl-cfg-ws-');
  const sdk = await downloadSdk(org, workspace);
  const dl = Object.create(sdk);
  dl.queryRecords = async (table, o) => (table === 'appmodule' ? [{ uniquename: APP }] : sdk.queryRecords(table, o));
  const said = [];
  const emitted = [];
  const mark = org.requests.length;
  await downloadMain({
    argv: ['--env', org.origin, '--app', APP_ID, '--out', out, ...(managed ? ['--include-managed', '--managed-manifest', store] : [])],
    stderr: { write: (text) => { said.push(String(text)); return true; } },
    exit: () => {},
    emitResult: (ok, payload) => emitted.push({ ok, payload }),
    preflightAuth: async () => ({ ok: true }),
    makeDownloadSdk: async () => ({ sdk: dl, cleanup() {} }),
    makeGenpageSdk: () => ({}),
    runDownload: async () => ({ ok: true, spec: JSON.parse(JSON.stringify(PLAIN)), pages: [], entities: [], webResources: [], droppedSubareas: 0, droppedSubareaDetails: [], notRoundTripped: null }),
  });
  assert.equal(emitted.length, 1);
  const specFile = path.join(out, 'app-spec.json');
  return {
    ...emitted[0],
    said: said.join(''),
    out,
    workspace,
    requests: org.requests.slice(mark),
    writes: org.writes(mark),
    specBytes: fs.existsSync(specFile) ? fs.readFileSync(specFile) : null,
    spec: fs.existsSync(specFile) ? JSON.parse(fs.readFileSync(specFile, 'utf8')) : null,
  };
}

// No canary in any file or stream the download wrote.
function assertNoCanary(dl) {
  const texts = [
    ['stderr', dl.said],
    ['result', JSON.stringify(dl.payload)],
    ...[dl.out, dl.workspace].flatMap((dir) => walk(dir).map((f) => [f, fs.readFileSync(f, 'latin1')])),
  ];
  for (const [where, text] of texts) {
    for (const canary of Object.values(CANARY)) assert.ok(!text.includes(canary), `${canary} written to ${where}`);
  }
}

const configurationRows = (org) => JSON.stringify(['environmentvariabledefinitions', 'environmentvariablevalues', 'connectionreferences', 'customapis', 'customapirequestparameters', 'customapiresponseproperties', 'duplicaterules', 'duplicateruleconditions', 'solutioncomponents'].map((s) => org.rows(s)));
// A row changed outside the plugin (the maker portal's own write): its version moves on.
const editRow = (org, set, pick, patch) => {
  const rows = org.sets.get(set);
  const [id, row] = [...rows].find(([, r]) => pick(r));
  rows.set(id, { ...row, ...patch, versionnumber: row.versionnumber + 1000 });
  return id;
};
// The restore library itself, over a download SDK, for a downloaded spec main's own runDownload double cannot carry (pages).
const restoreDirect = async (org, store, spec) => require('../lib/declared-configuration-io.js').restoreManagedConfiguration({
  sdk: await downloadSdk(org), spec, file: store, environment: org.origin, appUniqueName: APP, solutionUniqueName: SOLUTION, validate: () => ({ ok: true }),
});
const reason = (code) => require('../lib/managed-restore-report.js').REASONS[code];

test('environment variables: each proved definition is restored with its parent and labels, never a value, default, schema or secret; it rebuilds as no change and downloads again byte for byte', async () => {
  const { org, appDir, store } = await built();
  const storeBefore = fs.readFileSync(store);
  const workspaceBefore = snapshot(appDir);
  const dl = await download(org, store);
  assert.equal(dl.ok, true, JSON.stringify(dl.payload));
  assert.deepEqual(dl.spec.environmentVariables, [
    { schemaName: 'contoso_ApiBase', type: 'string', name: 'API base', description: 'Base address', isRequired: true },
    { schemaName: 'contoso_Site', type: 'dataSource', name: 'contoso_Site', isRequired: false, connectorId: SP, parameterKey: 'dataset' },
    { schemaName: 'contoso_List', type: 'dataSource', name: 'contoso_List', isRequired: false, connectorId: SP, parameterKey: 'table', parentSchemaName: 'contoso_Site' },
    { schemaName: 'contoso_Shape', type: 'json', name: 'contoso_Shape', isRequired: false },
  ]);
  assert.equal(dl.spec.configurationIdentity, 'stable-v1');
  assert.equal(dl.spec.minimumPluginVersion, '2.25.0');
  const report = dl.payload.managedEnvironmentVariables;
  assert.deepEqual(report.restored, ['contoso_apibase', 'contoso_site', 'contoso_list', 'contoso_shape']);
  assert.deepEqual(report.omitted.map((o) => [o.key, o.code, o.reason]), [['contoso_apikey', 'secret-withheld', reason('secret-withheld')]]);
  assert.deepEqual(report.withheld.map((w) => [w.key, w.fields]), [
    ['contoso_apibase', ['defaultValue', 'value']],
    ['contoso_site', ['value']],
    ['contoso_shape', ['defaultValue', 'valueSchema']],
  ]);
  assert.match(dl.said, /WARNING: managed environment variable contoso_apikey was not restored: it is a secret variable/);
  assert.match(dl.said, /NOTE: managed environment variable contoso_apibase was restored without defaultValue, value: /);
  // Read only, and only what the strict org models; the store and the build's own folder are untouched (the download wrote to --out).
  assert.deepEqual(dl.writes, []);
  assert.deepEqual(org.unexpected, []);
  assert.deepEqual(fs.readFileSync(store), storeBefore);
  assert.deepEqual(snapshot(appDir), workspaceBefore);
  assertNoCanary(dl);

  // The downloaded spec, rebuilt over the same app folder with no deployment settings, changes nothing: every value, default, parent
  // and membership stays as it was.
  const rows = configurationRows(org);
  const mark = org.requests.length;
  const rebuilt = await runCommand(dl.spec, { org, appDir });
  assert.ok(!rebuilt.exitCode && !rebuilt.thrown && rebuilt.payload.ok, JSON.stringify(rebuilt.payload || rebuilt.thrown));
  assert.deepEqual(org.writes(mark), []);
  assert.deepEqual(rebuilt.payload.created.configuration.unchanged.map((u) => u.key).sort(), ['contoso_ApiBase', 'contoso_List', 'contoso_Shape', 'contoso_Site']);
  assert.equal(configurationRows(org), rows);
  assert.deepEqual(org.unexpected, []);

  const again = await download(org, store);
  assert.ok(again.specBytes.equals(dl.specBytes), 'a second download writes the same bytes');
  assertNoCanary(again);
});

test('environment variables: a definition changed by hand is left out, and so is the data source naming it as parent; a second value row is never picked', async () => {
  const { org, store } = await built();
  editRow(org, 'environmentvariabledefinitions', (r) => r.schemaname === 'contoso_Site', { description: 'edited in the maker portal' });
  const shape = editRow(org, 'environmentvariabledefinitions', (r) => r.schemaname === 'contoso_Shape', {});
  // A second current value under contoso_Shape, made outside the plugin: a download never chooses between them.
  for (const n of [1, 2]) {
    const id = `00000000-0000-4000-8000-0000000eb${n}00`;
    org.sets.get('environmentvariablevalues').set(id, {
      environmentvariablevalueid: id, schemaname: 'contoso_Shape', value: `{"k":"${CANARY.value}"}`, _environmentvariabledefinitionid_value: shape, versionnumber: 9000 + n,
    });
  }
  const dl = await download(org, store);
  assert.equal(dl.ok, true, JSON.stringify(dl.payload));
  assert.deepEqual(dl.spec.environmentVariables.map((v) => v.schemaName), ['contoso_ApiBase']);
  assert.deepEqual(dl.payload.managedEnvironmentVariables.omitted.map((o) => [o.key, o.code]).sort(), [
    ['contoso_apikey', 'secret-withheld'],
    ['contoso_list', 'parent-unproven'],
    ['contoso_shape', 'multiple-values'],
    ['contoso_site', 'changed'],
  ]);
  assert.deepEqual(dl.writes, []);
  assert.deepEqual(org.unexpected, []);
  assertNoCanary(dl);
});

test('environment variables: a read that fails leaves every item out as unread, and a store rewritten during the download stops it with the files already in --out kept as they were', async () => {
  const intercept = {};
  const { org, store } = await built({ intercept });
  intercept.fn = (req) => (req.method === 'GET' && /^\/environmentvariable/.test(req.path) ? { statusCode: 500, body: { error: { code: '0x80040216', message: `failed near ${CANARY.default}` } } } : undefined);
  const failed = await download(org, store);
  assert.equal(failed.ok, true, JSON.stringify(failed.payload));
  assert.equal(failed.spec.environmentVariables, undefined);
  assert.equal(failed.spec.configurationIdentity, undefined);
  assert.deepEqual([...new Set(failed.payload.managedEnvironmentVariables.omitted.map((o) => o.code))], ['unread']);
  assert.equal(failed.payload.managedEnvironmentVariables.omitted.length, 5);
  assertNoCanary(failed);

  // A build that rewrites the store while this download reads it: refused before anything is written.
  const out = makeTempDir('dl-cfg-kept-');
  fs.writeFileSync(path.join(out, 'app-spec.json'), '{"kept":true}\n');
  const kept = snapshot(out);
  let rewritten = false;
  intercept.fn = (req) => {
    if (!rewritten && req.method === 'GET' && /^\/environmentvariabledefinitions\(/.test(req.path)) {
      rewritten = true;
      fs.appendFileSync(store, '\n');
    }
    return undefined;
  };
  const refused = await download(org, store, { out });
  assert.equal(rewritten, true);
  assert.equal(refused.ok, false);
  assert.deepEqual(snapshot(out), kept);
  assert.deepEqual(refused.writes, []);
  assertNoCanary(refused);
});

test('environment variables: a required variable whose value was cleared outside the plugin, with no default, is left out rather than declared to stop a rebuild', async () => {
  const need = { schemaName: 'contoso_Need', type: 'string', isRequired: true };
  const { org, appDir, store } = await built({
    lists: { environmentVariables: [VARIABLES[0], need] },
    settings: { EnvironmentVariables: [SETTINGS.EnvironmentVariables[0], { SchemaName: 'contoso_Need', Value: CANARY.need }] },
  });
  const definition = org.rows('environmentvariabledefinitions').find((r) => r.schemaname === 'contoso_Need').environmentvariabledefinitionid;
  editRow(org, 'environmentvariablevalues', (r) => r._environmentvariabledefinitionid_value === definition, { value: null });
  const dl = await download(org, store);
  assert.equal(dl.ok, true, JSON.stringify(dl.payload));
  assert.deepEqual(dl.spec.environmentVariables.map((v) => v.schemaName), ['contoso_ApiBase']);
  assert.deepEqual(dl.payload.managedEnvironmentVariables.omitted.map((o) => [o.key, o.code, o.reason]), [['contoso_need', 'required-value-missing', reason('required-value-missing')]]);
  assert.deepEqual(dl.writes, []);
  assertNoCanary(dl);
  // Why it is left out: the same declaration rebuilt over the same app folder stops as incomplete. The download's own spec rebuilds.
  const withNeed = { ...dl.spec, environmentVariables: [...dl.spec.environmentVariables, { ...need, name: 'contoso_Need' }] };
  const stopped = await runCommand(withNeed, { org, appDir });
  assert.ok(stopped.exitCode || stopped.thrown || !stopped.payload.ok, 'a required variable with no value stops the rebuild');
  assert.match(JSON.stringify(stopped.payload) + stopped.stderr, /ENVIRONMENT_VARIABLE_VALUE_MISSING/);
  const mark = org.requests.length;
  const rebuilt = await runCommand(dl.spec, { org, appDir });
  assert.ok(!rebuilt.exitCode && !rebuilt.thrown && rebuilt.payload.ok, JSON.stringify(rebuilt.payload || rebuilt.thrown));
  assert.deepEqual(org.writes(mark), []);
});

const REFERENCES = [
  { logicalName: 'contoso_sp', connectorId: SP, name: 'SharePoint', description: 'Lists' },
  { logicalName: 'contoso_sql', connectorId: SQL },
];

test('connection references: each proved definition is restored with its connector and labels, never its connection; it rebuilds as no change with the connection kept, and downloads again byte for byte', async () => {
  const { org, appDir, store } = await built({ lists: { connectionReferences: REFERENCES }, settings: {} });
  // The maker binds a connection after the build (the portal's own write): which connection is private and per environment.
  editRow(org, 'connectionreferences', (r) => r.connectionreferencelogicalname === 'contoso_sp', { connectionid: CANARY.connection });
  const storeBefore = fs.readFileSync(store);
  const dl = await download(org, store);
  assert.equal(dl.ok, true, JSON.stringify(dl.payload));
  assert.deepEqual(dl.spec.connectionReferences, [
    { logicalName: 'contoso_sp', connectorId: SP, name: 'SharePoint', description: 'Lists' },
    { logicalName: 'contoso_sql', connectorId: SQL, name: 'contoso_sql' },
  ]);
  assert.equal(dl.spec.configurationIdentity, 'stable-v1');
  assert.equal(dl.spec.minimumPluginVersion, '2.25.0');
  assert.equal(dl.spec.environmentVariables, undefined);
  const report = dl.payload.managedConnectionReferences;
  assert.deepEqual(report.restored, ['contoso_sp', 'contoso_sql']);
  assert.deepEqual(report.omitted, []);
  assert.deepEqual(report.withheld.map((w) => [w.key, w.fields, w.code]), [['contoso_sp', ['connection'], 'fields-withheld']]);
  assert.match(dl.said, /NOTE: managed connection reference contoso_sp was restored without connection: /);
  assert.equal(dl.payload.managedEnvironmentVariables, undefined);
  assert.deepEqual(dl.writes, []);
  assert.deepEqual(org.unexpected, []);
  assert.deepEqual(fs.readFileSync(store), storeBefore);
  assertNoCanary(dl);

  const rows = configurationRows(org);
  const mark = org.requests.length;
  const rebuilt = await runCommand(dl.spec, { org, appDir });
  assert.ok(!rebuilt.exitCode && !rebuilt.thrown && rebuilt.payload.ok, JSON.stringify(rebuilt.payload || rebuilt.thrown));
  assert.deepEqual(org.writes(mark), []);
  assert.deepEqual(rebuilt.payload.created.configuration.unchanged.map((u) => u.key).sort(), ['contoso_sp', 'contoso_sql']);
  assert.equal(configurationRows(org), rows);
  assert.equal(org.rows('connectionreferences').find((r) => r.connectionreferencelogicalname === 'contoso_sp').connectionid, CANARY.connection);
  assert.deepEqual(org.unexpected, []);

  const again = await download(org, store);
  assert.ok(again.specBytes.equals(dl.specBytes), 'a second download writes the same bytes');
  assertNoCanary(again);
});

test('connection references: one a page names with no connection, one changed by hand and one to a custom connector are left out', async () => {
  const custom = { logicalName: 'contoso_custom', connectorId: '/providers/Microsoft.PowerApps/apis/shared_contoso-5f1', customConnectorId: '00000000-0000-4000-8000-0000000cc001' };
  const { org, store } = await built({ lists: { connectionReferences: [...REFERENCES, custom] }, settings: {} });
  editRow(org, 'connectionreferences', (r) => r.connectionreferencelogicalname === 'contoso_sp', { connectionid: CANARY.connection });
  // A page naming both: the bound one is restored (a rebuild gates the page on it as on any declared reference), the unbound one is
  // left out, as a plain download leaves it (undeclared, so a rebuild writes the page without that gate).
  const page = { key: 'orders', name: 'Orders', source: { kind: 'tsx', codeFile: 'pages/orders.tsx' }, connectorBindings: [{ logicalName: 'contoso_sp' }, { logicalName: 'contoso_sql' }] };
  const spec = { ...JSON.parse(JSON.stringify(PLAIN)), pages: [page] };
  const direct = await restoreDirect(org, store, spec);
  assert.deepEqual(spec.connectionReferences.map((r) => r.logicalName), ['contoso_sp']);
  assert.deepEqual(direct.connectionReferences.omitted.map((o) => [o.key, o.code]), [['contoso_custom', 'unsupported-dependency'], ['contoso_sql', 'page-unready']]);

  editRow(org, 'connectionreferences', (r) => r.connectionreferencelogicalname === 'contoso_sql', { description: 'edited in the maker portal' });
  const dl = await download(org, store);
  assert.equal(dl.ok, true, JSON.stringify(dl.payload));
  assert.deepEqual(dl.spec.connectionReferences.map((r) => r.logicalName), ['contoso_sp']);
  assert.deepEqual(dl.payload.managedConnectionReferences.omitted.map((o) => [o.key, o.code, o.reason]), [
    ['contoso_custom', 'unsupported-dependency', reason('unsupported-dependency')],
    ['contoso_sql', 'changed', reason('changed')],
  ]);
  assert.match(dl.said, /WARNING: managed connection reference contoso_sql was not restored: .*It is left out of connectionReferences\[\]/);
  assert.deepEqual(dl.writes, []);
  assert.deepEqual(org.unexpected, []);
  assertNoCanary(dl);
});

// A request parameter and a response property may share a unique name: they are two children, in two slots.
const CALC = {
  uniqueName: 'contoso_Calc', displayName: 'Calc', description: 'Adds', binding: 'global', isFunction: true,
  requestParameters: [{ uniqueName: 'A', type: 'integer' }, { uniqueName: 'Note', type: 'string', isOptional: true, description: 'Free text' }],
  responseProperties: [{ uniqueName: 'A', type: 'integer' }, { uniqueName: 'Ok', type: 'boolean' }],
};
const scaffold = (uniqueName) => ({ uniqueName, binding: 'global', requestParameters: [{ uniqueName: 'In', type: 'string' }], responseProperties: [{ uniqueName: 'Out', type: 'string' }] });
const apiId = (org, uniqueName) => org.rows('customapis').find((r) => r.uniquename === uniqueName).customapiid;

test('Custom APIs: each proved scaffold is restored with both complete child lists and its labels, never an implementation; it rebuilds as no change and downloads again byte for byte', async () => {
  const { org, appDir, store } = await built({ lists: { customApis: [CALC, scaffold('contoso_Ping')] }, settings: {} });
  const storeBefore = fs.readFileSync(store);
  const dl = await download(org, store);
  assert.equal(dl.ok, true, JSON.stringify(dl.payload));
  // The labels the build pinned when the App Spec left them out are the row's own, so they come back as stated.
  assert.deepEqual(dl.spec.customApis, [
    {
      uniqueName: 'contoso_Calc', name: 'contoso_Calc', displayName: 'Calc', description: 'Adds', binding: 'global', isFunction: true, isPrivate: false, allowedProcessingSteps: 'none', enabledForWorkflow: false,
      requestParameters: [
        { uniqueName: 'A', type: 'integer', name: 'contoso_Calc.A', displayName: 'A', description: 'A', isOptional: false },
        { uniqueName: 'Note', type: 'string', name: 'contoso_Calc.Note', displayName: 'Note', description: 'Free text', isOptional: true },
      ],
      responseProperties: [
        { uniqueName: 'A', type: 'integer', name: 'contoso_Calc.A', displayName: 'A', description: 'A' },
        { uniqueName: 'Ok', type: 'boolean', name: 'contoso_Calc.Ok', displayName: 'Ok', description: 'Ok' },
      ],
    },
    {
      uniqueName: 'contoso_Ping', name: 'contoso_Ping', displayName: 'contoso_Ping', description: 'contoso_Ping', binding: 'global', isFunction: false, isPrivate: false, allowedProcessingSteps: 'none', enabledForWorkflow: false,
      requestParameters: [{ uniqueName: 'In', type: 'string', name: 'contoso_Ping.In', displayName: 'In', description: 'In', isOptional: false }],
      responseProperties: [{ uniqueName: 'Out', type: 'string', name: 'contoso_Ping.Out', displayName: 'Out', description: 'Out' }],
    },
  ]);
  assert.equal(dl.spec.configurationIdentity, 'stable-v1');
  assert.equal(dl.spec.minimumPluginVersion, '2.25.0');
  assert.deepEqual(dl.payload.managedCustomApis, { restored: ['contoso_calc', 'contoso_ping'], omitted: [] });
  assert.deepEqual(dl.writes, []);
  assert.deepEqual(org.unexpected, []);
  assert.deepEqual(fs.readFileSync(store), storeBefore);
  assertNoCanary(dl);

  const rows = configurationRows(org);
  const mark = org.requests.length;
  const rebuilt = await runCommand(dl.spec, { org, appDir });
  assert.ok(!rebuilt.exitCode && !rebuilt.thrown && rebuilt.payload.ok, JSON.stringify(rebuilt.payload || rebuilt.thrown));
  assert.deepEqual(org.writes(mark), []);
  assert.deepEqual(rebuilt.payload.created.configuration.unchanged.map((u) => u.key).sort(), ['contoso_Calc', 'contoso_Ping']);
  assert.equal(configurationRows(org), rows);
  assert.deepEqual(org.unexpected, []);

  const again = await download(org, store);
  assert.ok(again.specBytes.equals(dl.specBytes), 'a second download writes the same bytes');
});

test('Custom APIs: an implemented one, one a page calls, and one with a child renamed, added or deleted outside the plugin are left out whole; other-language labels are named as withheld', async () => {
  const intercept = {};
  const names = ['contoso_Ok', 'contoso_Impl', 'contoso_Paged', 'contoso_Renamed', 'contoso_Extra', 'contoso_Gone'];
  const { org, store } = await built({ lists: { customApis: names.map(scaffold) }, settings: {}, intercept });
  // A plug-in type registered on the row after the build: this environment's code, which a spec never carries.
  editRow(org, 'customapis', (r) => r.uniquename === 'contoso_Impl', { _plugintypeid_value: '00000000-0000-4000-8000-0000000ad001' });
  editRow(org, 'customapirequestparameters', (r) => r._customapiid_value === apiId(org, 'contoso_Renamed'), { uniquename: 'Input' });
  const extra = '00000000-0000-4000-8000-0000000ad002';
  org.sets.get('customapiresponseproperties').set(extra, { customapiresponsepropertyid: extra, uniquename: 'More', name: 'More', displayname: 'More', description: 'More', type: 10, logicalentityname: null, _customapiid_value: apiId(org, 'contoso_Extra'), versionnumber: 9100 });
  const props = org.sets.get('customapiresponseproperties');
  props.delete([...props].find(([, r]) => r._customapiid_value === apiId(org, 'contoso_Gone'))[0]);
  // An environment with two languages: the labels of the other one are not read, so never written.
  intercept.fn = (req) => (req.method === 'GET' && /RetrieveProvisionedLanguages/.test(req.path) ? { statusCode: 200, body: { RetrieveProvisionedLanguages: [1033, 1036] } } : undefined);

  const page = { key: 'calc', name: 'Calc', source: { kind: 'tsx', codeFile: 'pages/calc.tsx' }, actionBindings: [{ name: 'contoso_Paged' }] };
  const spec = { ...JSON.parse(JSON.stringify(PLAIN)), pages: [page] };
  const direct = await restoreDirect(org, store, spec);
  assert.deepEqual(spec.customApis.map((a) => a.uniqueName), ['contoso_Ok']);
  assert.deepEqual(direct.customApis.omitted.map((o) => [o.key, o.code]), [
    ['contoso_extra', 'changed'], ['contoso_gone', 'missing'], ['contoso_impl', 'implemented'], ['contoso_paged', 'page-unready'], ['contoso_renamed', 'changed'],
  ]);

  const dl = await download(org, store);
  assert.equal(dl.ok, true, JSON.stringify(dl.payload));
  assert.deepEqual(dl.spec.customApis.map((a) => a.uniqueName), ['contoso_Ok', 'contoso_Paged']);
  const report = dl.payload.managedCustomApis;
  assert.deepEqual(report.restored, ['contoso_ok', 'contoso_paged']);
  assert.deepEqual(report.omitted.map((o) => [o.key, o.code, o.reason]), [
    ['contoso_extra', 'changed', reason('changed')],
    ['contoso_gone', 'missing', reason('missing')],
    ['contoso_impl', 'implemented', reason('implemented')],
    ['contoso_renamed', 'changed', reason('changed')],
  ]);
  assert.deepEqual(report.withheld.map((w) => [w.key, w.fields]), [['contoso_ok', ['otherLanguageLabels']], ['contoso_paged', ['otherLanguageLabels']]]);
  assert.match(dl.said, /WARNING: managed Custom API contoso_impl was not restored: it has an implementation .*It is left out of customApis\[\]/);
  assert.equal(dl.requests.filter((r) => /RetrieveProvisionedLanguages/.test(r.path)).length, 1);
  assert.deepEqual(dl.writes, []);
  assert.deepEqual(org.unexpected, []);
});

test('a download without --include-managed reads no configuration and writes none, and its result names no configuration list', async () => {
  const { org, store } = await built();
  const dl = await download(org, store, { managed: false });
  assert.equal(dl.ok, true, JSON.stringify(dl.payload));
  assert.deepEqual(dl.spec, PLAIN);
  assert.deepEqual(Object.keys(dl.payload).filter((k) => /^managed/.test(k)), []);
  assert.deepEqual(dl.requests.filter((r) => /environmentvariable|connectionreference|customapi|duplicaterule/i.test(r.path)), []);
  assertNoCanary(dl);
});
