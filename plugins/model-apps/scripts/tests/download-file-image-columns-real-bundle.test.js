'use strict';
// A download keeps the File and Image columns it reads. Both report `AttributeType: "Virtual"` — the type a download leaves out — with
// `AttributeTypeName` FileType / ImageType, so before this every download dropped them without a word and a rebuild elsewhere lost them.
// Pinned at two levels:
//   - the projection (entityFromMetadata over readEntityWithDescriptions, against a scripted SDK): what each column comes back as, what
//     is left out and named, what is left out silently, and which reads a table costs;
//   - the round trip, over the REAL vendored SDK, the plugin's own HTTP client and the stateful fake Dataverse of the lifecycle matrix
//     (helpers/fake-lifecycle-org.js, helpers/lifecycle-harness.js): build -> download -> the columns as they were made; the
//     downloaded spec rebuilt in the same environment sends no write for them; built into a FRESH environment it makes them as they
//     are in the first. The size a build gives a column that sets none is read off that build's own wire, which is what keeps the
//     download's DEFAULT_MAX_SIZE_KB honest.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { makeTempDir } = require('./helpers/temp-dirs.js');
const { createLifecycleOrg } = require('./helpers/fake-lifecycle-org.js');
const { createLifecycleHarness, appUniqueName } = require('./helpers/lifecycle-harness.js');
const { entityFromMetadata, readEntityWithDescriptions } = require('../download-model-app.js');
const { DEFAULT_MAX_SIZE_KB } = require('../lib/entity-provision.js');
const { validateAppSpec } = require('../lib/app-spec.js');

// ====================================================================================================================================
// THE PROJECTION, against a scripted SDK. `attributes` is the SDK's own projection of the table (fetchEntityMetadata), `rows` what the
// attribute read answers (AttributeTypeName, AttributeOf, IsLogical, labels), `file` / `image` what each cast read answers, and
// `answers` replaces a whole answer: `table` (the table's label read), `rows`, `file` or `image`.

const label = (text) => ({ LocalizedLabels: [{ Label: text, LanguageCode: 1033 }], UserLocalizedLabel: { Label: text, LanguageCode: 1033 } });
const sdkAttribute = (logicalName, attributeType, attributeTypeName, extra = {}) => ({ logicalName, displayName: logicalName, attributeType, attributeTypeName, isCustomAttribute: true, ...extra });
const row = (LogicalName, typeName, extra = {}) => ({ LogicalName, DisplayName: label(LogicalName.replace(/^contoso_/, '')), AttributeTypeName: { Value: typeName }, AttributeOf: null, IsLogical: false, ...extra });

function scriptedSdk({ attributes, rows = [], file = [], image = [], answers = {}, urls = [] }) {
  const answer = (name, value) => (answers[name] ? answers[name] : { status: 200, headers: {}, body: { value } });
  return {
    fetchEntityMetadata: async (logical) => ({ logicalName: logical, schemaName: logical, displayName: 'Asset', primaryNameAttribute: 'contoso_name', attributes: [sdkAttribute('contoso_name', 'String', 'StringType'), ...attributes] }),
    dataverse: {
      get: async (url) => {
        urls.push(url);
        if (/FileAttributeMetadata/.test(url)) return answer('file', file);
        if (/ImageAttributeMetadata/.test(url)) return answer('image', image);
        if (/AttributeMetadata/.test(url)) return { status: 200, headers: {}, body: { value: [] } }; // the option-set and Money casts
        if (/\/Attributes\?/.test(url)) return answer('rows', [row('contoso_name', 'StringType'), ...rows]);
        return answers.table || { status: 200, headers: {}, body: { DisplayName: label('Asset'), DisplayCollectionName: label('Assets') } };
      },
    },
  };
}

const FILE_CAST = "/EntityDefinitions(LogicalName='contoso_asset')/Attributes/Microsoft.Dynamics.CRM.FileAttributeMetadata?$select=LogicalName,MaxSizeInKB";
const IMAGE_CAST = "/EntityDefinitions(LogicalName='contoso_asset')/Attributes/Microsoft.Dynamics.CRM.ImageAttributeMetadata?$select=LogicalName,MaxSizeInKB,IsPrimaryImage";
const castReads = (urls) => urls.filter((u) => /(File|Image)AttributeMetadata/.test(u));

test('a File and an Image column download typed, with the size and the primary-image flag each was made with', async () => {
  const urls = [];
  const sdk = scriptedSdk({
    urls,
    attributes: [sdkAttribute('contoso_contract', 'Virtual', 'FileType'), sdkAttribute('contoso_logo', 'Virtual', 'ImageType')],
    rows: [row('contoso_contract', 'FileType'), row('contoso_logo', 'ImageType')],
    file: [{ LogicalName: 'contoso_contract', MaxSizeInKB: 1024 }],
    image: [{ LogicalName: 'contoso_logo', MaxSizeInKB: 30720, IsPrimaryImage: true }],
  });
  const e = entityFromMetadata(await readEntityWithDescriptions(sdk, 'contoso_asset'), 'contoso_asset');
  assert.deepEqual(e.columns, [
    { schemaName: 'contoso_contract', displayName: 'contract', type: 'File', maxSizeKb: 1024 },
    { schemaName: 'contoso_logo', displayName: 'logo', type: 'Image', maxSizeKb: 30720, isPrimaryImage: true },
  ]);
  // One read per type the table has, through the cast that carries the size: MaxSizeInKB is not a property of AttributeMetadata.
  assert.deepEqual(castReads(urls), [FILE_CAST, IMAGE_CAST]);
});

test('a size a build gives a column that sets none is left out, and so is a primary-image flag that is false', async () => {
  // So a column authored without a size downloads exactly as it was authored, and a rebuild makes it at the same size.
  const sdk = scriptedSdk({
    attributes: [sdkAttribute('contoso_manual', 'Virtual', 'FileType'), sdkAttribute('contoso_photo', 'Virtual', 'ImageType')],
    rows: [row('contoso_manual', 'FileType'), row('contoso_photo', 'ImageType')],
    file: [{ LogicalName: 'contoso_manual', MaxSizeInKB: DEFAULT_MAX_SIZE_KB }],
    image: [{ LogicalName: 'contoso_photo', MaxSizeInKB: DEFAULT_MAX_SIZE_KB, IsPrimaryImage: false }],
  });
  const incomplete = [];
  const e = entityFromMetadata(await readEntityWithDescriptions(sdk, 'contoso_asset'), 'contoso_asset', { incomplete });
  assert.deepEqual(e.columns, [
    { schemaName: 'contoso_manual', displayName: 'manual', type: 'File' },
    { schemaName: 'contoso_photo', displayName: 'photo', type: 'Image' },
  ]);
  // Left out because they are the defaults, not because they are missing: the answer was complete.
  assert.deepEqual(incomplete, []);
});

test('a table without a File or Image column reads neither cast, and downloads byte for byte as before', async () => {
  const urls = [];
  const sdk = scriptedSdk({
    urls,
    attributes: [sdkAttribute('contoso_serial', 'String', 'StringType'), sdkAttribute('contoso_bought', 'DateTime', 'DateTimeType')],
    rows: [row('contoso_serial', 'StringType'), row('contoso_bought', 'DateTimeType')],
  });
  const e = entityFromMetadata(await readEntityWithDescriptions(sdk, 'contoso_asset'), 'contoso_asset');
  assert.deepEqual(castReads(urls), []);
  // The bytes an earlier release wrote for this table, unchanged.
  assert.equal(JSON.stringify(e), '{"schemaName":"contoso_asset","displayName":"Asset","primaryAttribute":{"schemaName":"contoso_name","displayName":"name"},"columns":[{"schemaName":"contoso_serial","displayName":"serial","type":"Text"},{"schemaName":"contoso_bought","displayName":"bought","type":"DateTime"}],"existing":true}');
});

test("the table's own image, entityimage, and its companions are left out, and a table that has only it reads no cast", async () => {
  // The worst case: reported as custom and with no AttributeOf, so only the name keeps them out.
  const urls = [];
  const sdk = scriptedSdk({
    urls,
    attributes: [
      sdkAttribute('entityimage', 'Virtual', 'ImageType'), sdkAttribute('entityimage_url', 'String', 'StringType'),
      sdkAttribute('entityimage_timestamp', 'BigInt', 'BigIntType'), sdkAttribute('entityimageid', 'Uniqueidentifier', 'UniqueidentifierType'),
    ],
    rows: [row('entityimage', 'ImageType'), row('entityimage_url', 'StringType'), row('entityimage_timestamp', 'BigIntType'), row('entityimageid', 'UniqueidentifierType')],
  });
  const unexpressible = [];
  const e = entityFromMetadata(await readEntityWithDescriptions(sdk, 'contoso_asset'), 'contoso_asset', { unexpressible });
  assert.deepEqual(e.columns, []);
  assert.deepEqual(unexpressible, [], 'the table image is the platform\'s, not a column the download fails to express');
  assert.deepEqual(castReads(urls), []);
});

test('the companions of a File or Image column stay out even when the read that names them failed', async () => {
  // The attribute read carries `AttributeOf`, which is how a companion is normally told from a column. When it fails, the SDK's own
  // projection still says which columns are File and Image, and their companions are named by the platform's rule.
  const sdk = scriptedSdk({
    answers: { rows: { status: 403, headers: {}, body: {} } },
    attributes: [
      sdkAttribute('contoso_contract', 'Virtual', 'FileType'), sdkAttribute('contoso_contract_name', 'String', 'StringType'),
      sdkAttribute('contoso_logo', 'Virtual', 'ImageType'), sdkAttribute('contoso_logoid', 'Uniqueidentifier', 'UniqueidentifierType'),
      sdkAttribute('contoso_logo_timestamp', 'BigInt', 'BigIntType'), sdkAttribute('contoso_logo_url', 'String', 'StringType'),
    ],
    file: [{ LogicalName: 'contoso_contract', MaxSizeInKB: 4096 }],
    image: [{ LogicalName: 'contoso_logo', MaxSizeInKB: DEFAULT_MAX_SIZE_KB, IsPrimaryImage: false }],
  });
  const meta = await readEntityWithDescriptions(sdk, 'contoso_asset');
  assert.equal(meta.labelReadFailed, 'HTTP 403');
  const e = entityFromMetadata(meta, 'contoso_asset');
  assert.deepEqual(e.columns, [
    { schemaName: 'contoso_contract', displayName: 'contoso_contract', type: 'File', maxSizeKb: 4096 },
    { schemaName: 'contoso_logo', displayName: 'contoso_logo', type: 'Image' },
  ]);
});

test('a File column the platform reports as logical is still kept', async () => {
  // Its data is kept in file storage, not on the row; whatever the platform calls that, the type name proves an authored column.
  const sdk = scriptedSdk({
    attributes: [sdkAttribute('contoso_contract', 'Virtual', 'FileType')],
    rows: [row('contoso_contract', 'FileType', { IsLogical: true })],
    file: [{ LogicalName: 'contoso_contract', MaxSizeInKB: 1024 }],
  });
  const e = entityFromMetadata(await readEntityWithDescriptions(sdk, 'contoso_asset'), 'contoso_asset');
  assert.deepEqual(e.columns, [{ schemaName: 'contoso_contract', displayName: 'contract', type: 'File', maxSizeKb: 1024 }]);
});

test('a Virtual column of another kind is left out and named; a companion is left out without a word', async () => {
  const sdk = scriptedSdk({
    attributes: [
      sdkAttribute('contoso_sensor', 'Virtual', 'VirtualType'),
      sdkAttribute('contoso_kind', 'Picklist', 'PicklistType'), sdkAttribute('contoso_kindname', 'Virtual', 'VirtualType'),
    ],
    rows: [row('contoso_sensor', 'VirtualType'), row('contoso_kind', 'PicklistType'), row('contoso_kindname', 'VirtualType', { AttributeOf: 'contoso_kind', IsLogical: true })],
  });
  const unexpressible = [];
  const e = entityFromMetadata(await readEntityWithDescriptions(sdk, 'contoso_asset'), 'contoso_asset', { unexpressible });
  assert.deepEqual(e.columns.map((c) => c.schemaName), ['contoso_kind']);
  assert.deepEqual(unexpressible, [{ table: 'contoso_asset', column: 'contoso_sensor', typeName: 'VirtualType' }]);
});

test('without the attribute read, a Virtual column cannot be told from a companion, so none is named', async () => {
  // The failed read is what the download reports then (its label-read warning); naming every companion would be noise.
  const sdk = scriptedSdk({
    answers: { rows: { status: 503, headers: {}, body: {} } },
    attributes: [sdkAttribute('contoso_sensor', 'Virtual', 'VirtualType'), sdkAttribute('contoso_kindname', 'Virtual', 'VirtualType')],
  });
  const unexpressible = [];
  const e = entityFromMetadata(await readEntityWithDescriptions(sdk, 'contoso_asset'), 'contoso_asset', { unexpressible });
  assert.deepEqual(e.columns, []);
  assert.deepEqual(unexpressible, []);
});

test('a File read that fails keeps the File columns typed, without their size, and records that read alone; the Image read stands', async () => {
  const sdk = scriptedSdk({
    answers: { file: { status: 503, headers: {}, body: {} } },
    attributes: [sdkAttribute('contoso_contract', 'Virtual', 'FileType'), sdkAttribute('contoso_logo', 'Virtual', 'ImageType')],
    rows: [row('contoso_contract', 'FileType'), row('contoso_logo', 'ImageType')],
    image: [{ LogicalName: 'contoso_logo', MaxSizeInKB: 2048, IsPrimaryImage: false }],
  });
  const meta = await readEntityWithDescriptions(sdk, 'contoso_asset');
  assert.deepEqual(meta.mediaReadFailures, { File: 'HTTP 503' });
  const incomplete = [];
  assert.deepEqual(entityFromMetadata(meta, 'contoso_asset', { incomplete }).columns, [
    { schemaName: 'contoso_contract', displayName: 'contract', type: 'File' },
    { schemaName: 'contoso_logo', displayName: 'logo', type: 'Image', maxSizeKb: 2048 },
  ]);
  // The File column's read failed, which is said as such; the Image answer was complete.
  assert.deepEqual(incomplete, []);
});

test('an Image read that fails keeps the Image columns typed, without their size or flag, and records that read alone; the File read stands', async () => {
  const sdk = scriptedSdk({
    answers: { image: { status: 503, headers: {}, body: {} } },
    attributes: [sdkAttribute('contoso_contract', 'Virtual', 'FileType'), sdkAttribute('contoso_logo', 'Virtual', 'ImageType')],
    rows: [row('contoso_contract', 'FileType'), row('contoso_logo', 'ImageType')],
    file: [{ LogicalName: 'contoso_contract', MaxSizeInKB: 1024 }],
  });
  const meta = await readEntityWithDescriptions(sdk, 'contoso_asset');
  assert.deepEqual(meta.mediaReadFailures, { Image: 'HTTP 503' });
  const incomplete = [];
  assert.deepEqual(entityFromMetadata(meta, 'contoso_asset', { incomplete }).columns, [
    { schemaName: 'contoso_contract', displayName: 'contract', type: 'File', maxSizeKb: 1024 },
    { schemaName: 'contoso_logo', displayName: 'logo', type: 'Image' },
  ]);
  assert.deepEqual(incomplete, []);
});

test('a cast answer without a column, or with an unusable value, is reported by column, and what did come back is kept', async () => {
  // A successful answer is checked against the File and Image columns the download writes: a row that is not there, a size that is
  // not a positive whole number, a primary-image flag that is not true or false. No request is added for it.
  const urls = [];
  const sdk = scriptedSdk({
    urls,
    attributes: [
      sdkAttribute('contoso_badge', 'Virtual', 'ImageType'), sdkAttribute('contoso_contract', 'Virtual', 'FileType'),
      sdkAttribute('contoso_logo', 'Virtual', 'ImageType'), sdkAttribute('contoso_manual', 'Virtual', 'FileType'), sdkAttribute('contoso_photo', 'Virtual', 'ImageType'),
    ],
    rows: [row('contoso_badge', 'ImageType'), row('contoso_contract', 'FileType'), row('contoso_logo', 'ImageType'), row('contoso_manual', 'FileType'), row('contoso_photo', 'ImageType')],
    file: [{ LogicalName: 'contoso_manual', MaxSizeInKB: 4096 }], // no row for contoso_contract
    image: [
      { LogicalName: 'contoso_badge', MaxSizeInKB: 2048, IsPrimaryImage: null }, // a size, but no usable flag
      { LogicalName: 'contoso_logo', MaxSizeInKB: '30720', IsPrimaryImage: true }, // a flag, but no usable size
    ], // no row for contoso_photo
  });
  const incomplete = [];
  const e = entityFromMetadata(await readEntityWithDescriptions(sdk, 'contoso_asset'), 'contoso_asset', { incomplete });
  assert.deepEqual(e.columns, [
    { schemaName: 'contoso_badge', displayName: 'badge', type: 'Image', maxSizeKb: 2048 },
    { schemaName: 'contoso_contract', displayName: 'contract', type: 'File' },
    { schemaName: 'contoso_logo', displayName: 'logo', type: 'Image', isPrimaryImage: true },
    { schemaName: 'contoso_manual', displayName: 'manual', type: 'File', maxSizeKb: 4096 },
    { schemaName: 'contoso_photo', displayName: 'photo', type: 'Image' },
  ]);
  assert.deepEqual(incomplete, [
    { table: 'contoso_asset', column: 'contoso_badge', type: 'Image', missing: ['primary'] },
    { table: 'contoso_asset', column: 'contoso_contract', type: 'File', missing: ['size'] },
    { table: 'contoso_asset', column: 'contoso_logo', type: 'Image', missing: ['size'] },
    { table: 'contoso_asset', column: 'contoso_photo', type: 'Image', missing: ['size', 'primary'] },
  ]);
  assert.deepEqual(castReads(urls), [FILE_CAST, IMAGE_CAST]);
});

test('the two label reads are recorded apart: the table\'s own, and the columns\'', async () => {
  // Each read carries different things, so what a download says about a failure depends on which one failed. `labelReadFailed`, the
  // first of the two reasons, is kept for its readers.
  const read = async (answers) => {
    const meta = await readEntityWithDescriptions(scriptedSdk({ attributes: [], answers }), 'contoso_asset');
    return { table: meta.tableLabelReadFailed, columns: meta.attributeReadFailed, first: meta.labelReadFailed };
  };
  const refused = (status) => ({ status, headers: {}, body: {} });
  assert.deepEqual(await read({ table: refused(403) }), { table: 'HTTP 403', columns: undefined, first: 'HTTP 403' });
  assert.deepEqual(await read({ rows: refused(503) }), { table: undefined, columns: 'HTTP 503', first: 'HTTP 503' });
  assert.deepEqual(await read({ table: refused(403), rows: refused(503) }), { table: 'HTTP 403', columns: 'HTTP 503', first: 'HTTP 403' });
  assert.deepEqual(await read({}), { table: undefined, columns: undefined, first: undefined });
});

// ====================================================================================================================================
// THE ROUND TRIP, over the real bundle. One environment, walked in order: the build, what a maker then adds in Maker, the download, the
// rebuild of the downloaded spec, the same spec built into a fresh environment; then downloads the environment refuses one read of, or
// answers one read short.

const spec = {
  schemaVersion: 2,
  minimumPluginVersion: '2.13.0',
  solution: { uniqueName: 'ContosoAssets', displayName: 'Contoso Assets', publisherPrefix: 'contoso', description: 'Assets, with their files and pictures.' },
  app: { name: 'Asset Register', description: 'The assets the company owns.' },
  entities: [{
    schemaName: 'contoso_asset', displayName: 'Asset', pluralName: 'Assets', description: 'A thing the company owns.',
    primaryAttribute: { schemaName: 'contoso_name', displayName: 'Name' },
    columns: [
      { schemaName: 'contoso_serial', displayName: 'Serial', type: 'Text' },
      { schemaName: 'contoso_manual', displayName: 'Manual', type: 'File' },
      { schemaName: 'contoso_contract', displayName: 'Contract', type: 'File', maxSizeKb: 2048 },
      { schemaName: 'contoso_photo', displayName: 'Photo', type: 'Image' },
    ],
  }],
  appShell: { areas: [{ label: 'Assets', groups: [{ label: 'Records', subAreas: [{ entity: 'contoso_asset', title: 'Assets' }] }] }] },
};
const APP = appUniqueName(spec);

// An environment with a seam in front of its transport. `refuse` answers what it names with the Dataverse OData error a client does not
// retry (the error shape: https://learn.microsoft.com/power-apps/developer/data-platform/webapi/compose-http-requests-handle-errors#parse-errors-from-the-response);
// `alter` lets the fake answer what it names and edits the JSON body of that answer — a read that succeeds with less than it should.
// A rule names a method and a path and, where one path is read for different things, the `$select`: the table's own label read and
// the SDK's metadata read of the table share their path.
function environment(prefix) {
  const org = createLifecycleOrg();
  const rules = [];
  const ruleFor = (req, kind) => {
    const url = new URL(req.url);
    const where = decodeURIComponent(url.pathname);
    return rules.find((r) => r.kind === kind && r.method === req.method && r.path.test(where) && (r.select === undefined || url.searchParams.get('$select') === r.select));
  };
  const request = async (req) => {
    if (ruleFor(req, 'refuse')) {
      return { statusCode: 400, headers: { 'content-type': 'application/json; odata.metadata=minimal' }, body: JSON.stringify({ error: { code: '0x80040216', message: 'An unexpected error occurred.' } }) };
    }
    const res = await org.request(req);
    const alter = ruleFor(req, 'alter');
    return alter ? { ...res, body: JSON.stringify(alter.edit(JSON.parse(res.body))) } : res;
  };
  const root = makeTempDir(prefix);
  const harness = createLifecycleHarness({ ...org, request }, root);
  const add = (rule) => { rules.push(rule); return () => rules.splice(rules.indexOf(rule), 1); };
  const refuse = (method, pattern, { select } = {}) => add({ kind: 'refuse', method, path: pattern, select });
  const alter = (method, pattern, edit) => add({ kind: 'alter', method, path: pattern, edit });
  return { org, root, harness, refuse, alter };
}

// What a maker sends from Maker, as the Web API call Maker makes.
async function inMaker(org, method, where, body) {
  const res = await org.request({ url: `${org.API}${where}`, method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.ok(res.statusCode < 300, `${method} ${where} answered ${res.statusCode}: ${res.body}`);
}

// The File and Image columns of the table as the environment holds them: `<type> <size> KB[ primary]`.
function mediaColumns(org) {
  const table = org.metadata.tables.get('contoso_asset');
  return Object.fromEntries([...table.Attributes.values()]
    .filter((a) => ['FileType', 'ImageType'].includes(a.AttributeTypeName.Value))
    .map((a) => [a.LogicalName, `${a.AttributeTypeName.Value} ${a.MaxSizeInKB} KB${a.IsPrimaryImage ? ' primary' : ''}`])
    .sort(([a], [b]) => (a < b ? -1 : 1)));
}

const ran = (step, what) => {
  if (step.error) throw step.error;
  assert.deepEqual(step.unexpected, [], `every request ${what} sent is one the fake models`);
  return step;
};

let walkP;
const walk = () => walkP || (walkP = (async () => {
  const env = environment('download-file-image-');
  const { org, harness } = env;
  const build = ran(await harness.measure(() => harness.build(spec)), 'the build');
  assert.equal(build.value.result.ok, true, JSON.stringify(build.value.result.errors));
  env.built = mediaColumns(org);
  // Then, in Maker: a File column at the size Maker gives one (32 MB, Microsoft Learn: file-attributes), an Image column made the
  // table's primary image, the table's own image with its companions, and a Virtual column of a kind the App Spec has no type for. The
  // fake has no Web API create for that last kind, so it is put in its store with the shape the platform reports.
  const where = "/EntityDefinitions(LogicalName='contoso_asset')/Attributes";
  await inMaker(org, 'POST', where, { '@odata.type': 'Microsoft.Dynamics.CRM.FileAttributeMetadata', SchemaName: 'contoso_scan', DisplayName: { LocalizedLabels: [{ Label: 'Scan', LanguageCode: 1033 }] }, RequiredLevel: { Value: 'None' }, MaxSizeInKB: 32768 });
  await inMaker(org, 'POST', where, { '@odata.type': 'Microsoft.Dynamics.CRM.ImageAttributeMetadata', SchemaName: 'contoso_badge', DisplayName: { LocalizedLabels: [{ Label: 'Badge', LanguageCode: 1033 }] }, RequiredLevel: { Value: 'None' }, MaxSizeInKB: 30720, IsPrimaryImage: true });
  await inMaker(org, 'POST', where, { '@odata.type': 'Microsoft.Dynamics.CRM.ImageAttributeMetadata', SchemaName: 'EntityImage', DisplayName: { LocalizedLabels: [{ Label: 'Entity Image', LanguageCode: 1033 }] }, RequiredLevel: { Value: 'None' }, MaxSizeInKB: 10240, IsPrimaryImage: false });
  const table = org.metadata.tables.get('contoso_asset');
  const sensor = org.metadata.makeAttribute(table, { '@odata.type': 'Microsoft.Dynamics.CRM.StringAttributeMetadata', SchemaName: 'contoso_sensor', DisplayName: 'Sensor' });
  Object.assign(sensor, { '@odata.type': '#Microsoft.Dynamics.CRM.AttributeMetadata', AttributeType: 'Virtual', AttributeTypeName: { Value: 'VirtualType' } });
  delete sensor.MaxLength;
  delete sensor.FormatName;
  table.Attributes.set(sensor.LogicalName, sensor);
  env.held = mediaColumns(org);
  env.download = ran(await harness.measure(() => harness.download(APP, path.join(env.root, 'download'))), 'the download');
  return env;
})());

test('the size a build gives a File or Image column that sets none is DEFAULT_MAX_SIZE_KB, on the real wire', async () => {
  // What the download leaves out must be what the build really makes: read off the environment the real SDK wrote to.
  const { built } = await walk();
  assert.deepEqual(built, {
    contoso_contract: 'FileType 2048 KB',
    contoso_manual: `FileType ${DEFAULT_MAX_SIZE_KB} KB`,
    contoso_photo: `ImageType ${DEFAULT_MAX_SIZE_KB} KB`,
  });
});

test('a download writes each File and Image column as it was made, leaves the platform\'s own out, and names what it cannot express', async () => {
  const { download } = await walk();
  const { emitted, spec: downloaded, stderr } = download.value;
  assert.equal(emitted.ok, true, JSON.stringify(emitted));
  const asset = downloaded.entities.find((e) => e.schemaName === 'contoso_asset');
  // The authored columns exactly as authored; the two made in Maker with what they were made with. No `entityimage`, no companion
  // (`*_name`, `*id`, `*_timestamp`, `*_url`), no `contoso_sensor`.
  assert.deepEqual(asset.columns.slice().sort((a, b) => (a.schemaName < b.schemaName ? -1 : 1)), [
    { schemaName: 'contoso_badge', displayName: 'Badge', type: 'Image', maxSizeKb: 30720, isPrimaryImage: true },
    { schemaName: 'contoso_contract', displayName: 'Contract', type: 'File', maxSizeKb: 2048 },
    { schemaName: 'contoso_manual', displayName: 'Manual', type: 'File' },
    { schemaName: 'contoso_photo', displayName: 'Photo', type: 'Image' },
    { schemaName: 'contoso_scan', displayName: 'Scan', type: 'File', maxSizeKb: 32768 },
    { schemaName: 'contoso_serial', displayName: 'Serial', type: 'Text' },
  ]);
  const warnings = stderr.split('\n').filter((l) => /^WARNING:/.test(l));
  assert.deepEqual(warnings, [
    'WARNING: 1 column(s) have a type the App Spec cannot express and were left out of the spec (contoso_asset.contoso_sensor (VirtualType)). Rebuilding this spec into an environment that already has the table leaves them as they are, but rebuilding into a FRESH environment would not create them: add them there in Maker after the rebuild.',
  ]);
  assert.deepEqual(validateAppSpec(downloaded, { profile: 'plan', reconstructed: true }).errors, []);
});

test('the downloaded spec rebuilt in the same environment sends no write for a File or Image column', async () => {
  const { org, harness, root, download } = await walk();
  const before = org.inventory();
  const dir = path.join(root, 'download');
  const rebuild = ran(await harness.measure(() => harness.build(download.value.spec, { appFolder: dir, workspace: path.join(dir, '.maker-workspace') })), 'the rebuild of the downloaded spec');
  assert.equal(rebuild.value.result.ok, true, JSON.stringify(rebuild.value.result.errors));
  const columnWrites = Object.keys(rebuild.writes).filter((w) => /Attributes/.test(w));
  assert.deepEqual(columnWrites, [], `no column is created or changed: ${JSON.stringify(rebuild.writes)}`);
  assert.deepEqual(org.inventory(), before);
});

test('the downloaded spec built into a fresh environment makes each File and Image column as it is in the first', async () => {
  const { held, download } = await walk();
  const fresh = environment('download-file-image-fresh-');
  const build = ran(await fresh.harness.measure(() => fresh.harness.build(download.value.spec)), 'the build into a fresh environment');
  assert.equal(build.value.result.ok, true, JSON.stringify(build.value.result.errors));
  // Everything but the table's own image, which no build makes.
  const { entityimage, ...authorable } = held;
  assert.equal(entityimage, 'ImageType 10240 KB');
  assert.deepEqual(mediaColumns(fresh.org), authorable);
});

// What a download of the walked environment says about each read that failed or came back short, word for word: each warning names
// only what the read it is about carries, so one read failing never reads as another's loss.
const SENSOR_NAMED = 'WARNING: 1 column(s) have a type the App Spec cannot express and were left out of the spec (contoso_asset.contoso_sensor (VirtualType)). Rebuilding this spec into an environment that already has the table leaves them as they are, but rebuilding into a FRESH environment would not create them: add them there in Maker after the rebuild.';
const TABLE_LABEL_READ_FAILED = "WARNING: the table label read failed for 1 table(s) (contoso_asset (HTTP 400)). Their display names and descriptions fall back to ONE language and their plurals are not written, so rebuilding into a FRESH environment would recreate each of those tables labelled in one language, with the plural '<display name>s'. Re-run the download to recover them before a cross-environment rebuild.";
const COLUMN_READ_FAILED = "WARNING: the column read failed for 1 table(s) (contoso_asset (HTTP 400)). Their COLUMN labels and descriptions fall back to ONE language, so a column labelled in several languages downloads as single-language and rebuilding into a FRESH environment would recreate it that way. That read also carries the flags that identify a lookup's synthetic '<lookup>name' column, so those tables may additionally have captured one as a real Text column — delete any you see before a cross-environment rebuild — and the type names that tell a column of a type the App Spec cannot express from the platform's own, so any such column on those tables was left out without being named. Re-run the download to recover them.";
const FILE_READ_FAILED = `WARNING: the File column read failed for 1 table(s) (contoso_asset (HTTP 400)). Their File columns are captured WITHOUT the maximum size each was made with, so rebuilding into a FRESH environment would create them at the default size of ${DEFAULT_MAX_SIZE_KB} KB. Re-run the download to recover them before a cross-environment rebuild.`;
const IMAGE_READ_FAILED = `WARNING: the Image column read failed for 1 table(s) (contoso_asset (HTTP 400)). Their Image columns are captured WITHOUT the maximum size each was made with or whether one is the table's primary image, so rebuilding into a FRESH environment would create them at the default size of ${DEFAULT_MAX_SIZE_KB} KB, none of them asked to be the table's primary image. Re-run the download to recover them before a cross-environment rebuild.`;
const READ_INCOMPLETE = `WARNING: the File/Image column read came back incomplete for 3 column(s): contoso_asset.contoso_badge (whether it is the table's primary image), contoso_asset.contoso_contract (its maximum size), contoso_asset.contoso_photo (its maximum size and whether it is the table's primary image). Each is captured without what did not come back, so rebuilding into a FRESH environment would create a column without its maximum size at the default size of ${DEFAULT_MAX_SIZE_KB} KB and would not ask an Image column without its primary-image flag to be the table's primary image. Re-run the download to recover them before a cross-environment rebuild.`;

// The table's File and Image columns as a download wrote them, `<name> <type>[ <size>][ primary]`, and the warnings it printed.
const mediaOf = (downloaded) => downloaded.entities[0].columns.filter((c) => c.type === 'File' || c.type === 'Image')
  .map((c) => `${c.schemaName} ${c.type}${c.maxSizeKb ? ` ${c.maxSizeKb}` : ''}${c.isPrimaryImage ? ' primary' : ''}`).sort();
const warningsOf = (stderr) => stderr.split('\n').filter((l) => /^WARNING:/.test(l));
const HEALTHY_MEDIA = ['contoso_badge Image 30720 primary', 'contoso_contract File 2048', 'contoso_manual File', 'contoso_photo Image', 'contoso_scan File 32768'];

// One download of the walked environment with `rules` in front of it (each returns its own undo), into a folder of its own.
async function downloadWith(name, rules) {
  const env = await walk();
  const undo = rules(env);
  try {
    const step = ran(await env.harness.measure(() => env.harness.download(APP, path.join(env.root, name))), `the download ${name}`);
    assert.equal(step.value.emitted.ok, true, JSON.stringify(step.value.emitted));
    return step.value;
  } finally {
    for (const lift of undo) lift();
  }
}

const TABLE_LABEL_READ = { select: 'LogicalName,Description,DisplayName,DisplayCollectionName' };

test('a download the environment refuses only the table label read of says so of the table\'s labels alone, and still names what it cannot express', async () => {
  const { spec: downloaded, stderr } = await downloadWith('download-no-table-labels', ({ refuse }) => [
    refuse('GET', /^\/api\/data\/v9\.\d\/EntityDefinitions\(LogicalName='contoso_asset'\)$/, TABLE_LABEL_READ),
  ]);
  assert.deepEqual(mediaOf(downloaded), HEALTHY_MEDIA);
  // The table's label comes from the SDK's own read; its plural, which only the refused read carries, is not written.
  assert.deepEqual({ displayName: downloaded.entities[0].displayName, plural: 'pluralName' in downloaded.entities[0] }, { displayName: 'Asset', plural: false });
  assert.deepEqual(warningsOf(stderr), [TABLE_LABEL_READ_FAILED, SENSOR_NAMED]);
});

test('a download the environment refuses the column read of still keeps each File and Image column and none of their companions, and says what that read carries', async () => {
  // That read carries AttributeOf, which normally tells a companion from a column; without it the SDK's own projection still names the
  // File and Image columns, and their companions are known by the platform's names for them. A Virtual column the App Spec cannot
  // express cannot be told from the platform's own without it, so none is named — and the warning says that is why.
  const { spec: downloaded, stderr } = await downloadWith('download-no-column-read', ({ refuse }) => [
    refuse('GET', /^\/api\/data\/v9\.\d\/EntityDefinitions\(LogicalName='contoso_asset'\)\/Attributes$/),
  ]);
  assert.deepEqual(downloaded.entities[0].columns.map((c) => c.schemaName).sort(), ['contoso_badge', 'contoso_contract', 'contoso_manual', 'contoso_photo', 'contoso_scan', 'contoso_serial']);
  assert.deepEqual(mediaOf(downloaded), HEALTHY_MEDIA);
  assert.deepEqual(warningsOf(stderr), [COLUMN_READ_FAILED]);
});

test('a download the environment refuses the File read of keeps the File columns, without their size, and says so of the File columns alone', async () => {
  const { spec: downloaded, stderr } = await downloadWith('download-no-file-read', ({ refuse }) => [
    refuse('GET', /\/Attributes\/Microsoft\.Dynamics\.CRM\.FileAttributeMetadata$/),
  ]);
  // The Image read was not refused: its sizes and flag stand.
  assert.deepEqual(mediaOf(downloaded), ['contoso_badge Image 30720 primary', 'contoso_contract File', 'contoso_manual File', 'contoso_photo Image', 'contoso_scan File']);
  assert.deepEqual(warningsOf(stderr), [FILE_READ_FAILED, SENSOR_NAMED]);
});

test('a download the environment refuses the Image read of keeps the Image columns, without their size or flag, and says so of the Image columns alone', async () => {
  const { spec: downloaded, stderr } = await downloadWith('download-no-image-read', ({ refuse }) => [
    refuse('GET', /\/Attributes\/Microsoft\.Dynamics\.CRM\.ImageAttributeMetadata$/),
  ]);
  // The File read was not refused: its sizes stand.
  assert.deepEqual(mediaOf(downloaded), ['contoso_badge Image', 'contoso_contract File 2048', 'contoso_manual File', 'contoso_photo Image', 'contoso_scan File 32768']);
  assert.deepEqual(warningsOf(stderr), [IMAGE_READ_FAILED, SENSOR_NAMED]);
});

test('a File or Image read that answers without a column, or with an unusable value, keeps what did come back and names each column it lacks', async () => {
  // Both reads succeed, but the File answer has no row for contoso_contract, and the Image answer has no row for contoso_photo and no
  // usable primary-image flag for contoso_badge — what an answer read while the table changes, say, can carry. No request is added.
  const { spec: downloaded, stderr } = await downloadWith('download-short-answers', ({ alter }) => [
    alter('GET', /\/Attributes\/Microsoft\.Dynamics\.CRM\.FileAttributeMetadata$/, (body) => ({ ...body, value: body.value.filter((r) => r.LogicalName !== 'contoso_contract') })),
    alter('GET', /\/Attributes\/Microsoft\.Dynamics\.CRM\.ImageAttributeMetadata$/, (body) => ({ ...body, value: body.value.filter((r) => r.LogicalName !== 'contoso_photo').map((r) => (r.LogicalName === 'contoso_badge' ? { ...r, IsPrimaryImage: null } : r)) })),
  ]);
  assert.deepEqual(mediaOf(downloaded), ['contoso_badge Image 30720', 'contoso_contract File', 'contoso_manual File', 'contoso_photo Image', 'contoso_scan File 32768']);
  assert.deepEqual(warningsOf(stderr), [READ_INCOMPLETE, SENSOR_NAMED]);
});