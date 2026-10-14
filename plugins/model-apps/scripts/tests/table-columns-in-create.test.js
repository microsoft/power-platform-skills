'use strict';

// A new table is created exactly as the previous release created it — one request that carries only its primary name attribute —
// and its ordinary columns then follow in ONE atomic change set (an OData `$batch`) instead of one request per column. These tests
// run the real vendored SDK over a stub transport and count requests, and prove that every column the change set carries is
// byte-for-byte the body the per-column path posts, that a change set the platform refuses (or the transport cannot send) falls back
// to that per-column path with a warning, and that the primary name attribute's request is the previous release's on every path and
// under both behaviours the platform has been measured to have. `inlineColumns: false` is the one-request-per-column path, the
// oracle throughout.
// See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/execute-batch-operations-using-web-api#change-sets

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { makeRunner, provisionDataModel, BuildHalt } = require('../lib/entity-provision.js');
const { hash } = require('./helpers/read-probe.js');

const BUNDLE = path.resolve(__dirname, '..', 'vendor', 'cds-maker-sdk.cjs');
const ORG = 'https://contoso.crm.dynamics.com';
const API = `${ORG}/api/data/v9.0`;

const tempDirs = [];
test.after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

const clone = (value) => JSON.parse(JSON.stringify(value));
const hex = (n, width) => n.toString(16).padStart(width, '0');
// A column's MetadataId is a function of the table and column, so both paths hand back the same id for it.
const attributeId = (table, schema) => `${hex(hash(`${table}.${schema}`), 8)}-0000-4000-8000-${hex(hash(`${schema}.${table}`), 12)}`;
const tableId = (schema) => `${hex(hash(`table.${schema}`), 8)}-0000-4000-8000-${hex(hash(`${schema}.table`), 12)}`;

// --- a stub of the Dataverse metadata endpoints a table create touches -----------------------------

// What Dataverse answers when a request would create an attribute twice: error 0x80060304,
// "Attribute {0} already exists for entity {1}." — and it refuses the WHOLE request, creating nothing.
// See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/reference/web-service-error-codes
const duplicateAttribute = (name, table) => ({ status: 400, headers: {}, body: { error: { code: '0x80060304', message: `Attribute ${name} already exists for entity ${table}.` } } });
// Columns every table gets from the platform, whatever the request says.
const SYSTEM_COLUMNS = ['createdon', 'modifiedon', 'ownerid', 'statecode', 'statuscode'];
// The columns a column creates beside itself: a Money column its base-currency twin, a choice or a Boolean its `<name>name`
// shadow, a Customer lookup its three shadows `<name>name`, `<name>yominame` and `<name>idtype` (measured), a File column the
// `<name>_name` that holds the file's name, an Image column its `<name>id`, `<name>_timestamp` and `<name>_url`, and a rollup
// column its `<name>_date` and `<name>_state` (all three documented on Microsoft Learn: Use file column data, Use image column
// data, Define rollup columns). A Money column that is a rollup has both its own and the rollup's.
// See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/file-column-data#file-name-column
// See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/image-column-data#download-url
// See: https://learn.microsoft.com/en-us/power-apps/maker/data-platform/define-rollup-fields
const companions = (body) => {
  const name = String(body.SchemaName).toLowerCase();
  const type = String(body['@odata.type'] || '');
  const found = [];
  if (/MoneyAttributeMetadata$/.test(type)) found.push(`${name}_base`);
  if (/(?:Picklist|MultiSelectPicklist|Boolean)AttributeMetadata$/.test(type)) found.push(`${name}name`);
  if (/LookupAttributeMetadata$/.test(type)) found.push(`${name}name`, `${name}yominame`, `${name}idtype`);
  if (/FileAttributeMetadata$/.test(type)) found.push(`${name}_name`);
  if (/ImageAttributeMetadata$/.test(type)) found.push(`${name}id`, `${name}_timestamp`, `${name}_url`);
  // SourceType 2 is a rollup column, whatever its data type (0 simple, 1 calculated).
  if (body.SourceType === 2) found.push(`${name}_date`, `${name}_state`);
  return found;
};

// The operations of the change set in a `$batch` request, as the SDK's createColumns renders it: one embedded HTTP request per
// operation, each POSTing a column to the table's `Attributes` collection, with the solution header on EACH operation (the one on
// the outer request is ignored by the platform) —
//   --batch_<id>
//   Content-Type: multipart/mixed;boundary=changeset_<id>
//
//   --changeset_<id>
//   Content-Type: application/http
//   Content-Transfer-Encoding: binary
//   Content-ID: 1
//
//   POST https://contoso.crm.dynamics.com/api/data/v9.0/EntityDefinitions(LogicalName='new_ticket')/Attributes HTTP/1.1
//   Content-Type: application/json;type=entry
//   MSCRM.SolutionUniqueName: TableColumns
//
//   {"@odata.type":"Microsoft.Dynamics.CRM.StringAttributeMetadata",...}
//   --changeset_<id>--
//   --batch_<id>--
const parseChangeSet = (text) => {
  const boundary = /^Content-Type:\s*multipart\/mixed;\s*boundary=(\S+)/im.exec(text)[1];
  return text.split(`--${boundary}`).slice(1).filter((segment) => !segment.startsWith('--')).map((segment) => {
    const mimeEnd = segment.indexOf('\r\n\r\n');
    const mime = segment.slice(0, mimeEnd);
    const http = segment.slice(mimeEnd + 4);
    const headEnd = http.indexOf('\r\n\r\n');
    const head = http.slice(0, headEnd).split('\r\n');
    const [, method, url] = /^(\w+) (\S+) HTTP\/1\.1$/.exec(head[0]);
    const headers = Object.fromEntries(head.slice(1).map((line) => [line.slice(0, line.indexOf(':')).trim(), line.slice(line.indexOf(':') + 1).trim()]));
    const payload = http.slice(headEnd + 4).replace(/\r\n$/, '');
    return { contentId: /^Content-ID:\s*(\S+)/im.exec(mime)[1], method, path: decodeURIComponent(url.replace(API, '')), headers, body: payload ? JSON.parse(payload) : undefined };
  });
};
// What the platform answers a change set with: its own envelope, announcing its own boundary, and one part per operation it
// answers (a refused change set answers only the operation that failed), correlated by Content-ID.
const changeSetAnswer = (parts) => [
  '--batchresponse_x',
  'Content-Type: multipart/mixed; boundary=changesetresponse_x',
  '',
  ...parts.flatMap((part) => [
    '--changesetresponse_x',
    'Content-Type: application/http',
    'Content-Transfer-Encoding: binary',
    `Content-ID: ${part.contentId}`,
    '',
    `HTTP/1.1 ${part.status} ${part.status === 204 ? 'No Content' : 'Bad Request'}`,
    'OData-Version: 4.0',
    ...(part.body ? ['Content-Type: application/json; odata.metadata=minimal', '', JSON.stringify(part.body)] : []),
    '',
  ]),
  '--changesetresponse_x--',
  '--batchresponse_x--',
  '',
].join('\r\n');

function fakeDataverse({
  createCommitsThenFails = null, // (body) => response, sent AFTER the table was created: the answer to the create that made it is lost
  batchFails = null,           // (operations) => response | falsy, for a change set the platform REFUSES (nothing in it is created); a falsy answer lets it through
  batchCommitsThenFails = null, // (operations) => response, sent AFTER a change set was committed: its answer is lost or unreadable
  noPostRaw = false,           // a transport that cannot send the body of a change set verbatim (no `postRaw`)
  dropInline = [],             // columns of a change set that the platform accepts and does not list afterwards
  attributeReads = null,       // (n, columns) => response | undefined; overrides the read of a table's columns by id
  tableReadBack = null,        // (table) => response | undefined; overrides the read the SDK makes of a table it just created
  lookupLag = 0,               // how many reads of a new table BY NAME answer 404 before it shows (the metadata-read lag)
  keepsAskedLength = false,    // the environment that keeps the length asked of a plain text primary column in a one-attribute create
  lengthRead = null,           // (n) => response | undefined; overrides the typed read of a text column's MaxLength
  updateFails = null,          // (body) => response, for the PUT of a typed column
  extraCompanions = null,      // (body) => names the platform makes beside a column that nothing in the build lists
} = {}) {
  const log = [];
  const refusals = [];
  const tables = new Map();
  const optionSets = new Map();
  let attributeReadCount = 0;
  let lengthReadCount = 0;
  const reply = (status, body, headers = {}) => ({ status, headers, body });
  const refuse = (path, response) => { refusals.push({ path, message: response.body && response.body.error && response.body.error.message }); return response; };
  const created = (location) => reply(204, null, { 'odata-entityid': `${API}/${location}` });
  const columnRow = (table, body) => ({ MetadataId: attributeId(table.logical, body.SchemaName), LogicalName: String(body.SchemaName).toLowerCase() });
  const companionsOf = (body) => [...companions(body), ...(extraCompanions ? extraCompanions(body) : [])];
  const addColumn = (table, body) => {
    table.columns.set(String(body.SchemaName).toLowerCase(), { body, row: columnRow(table, body) });
    for (const name of companionsOf(body)) table.reserved.add(name);
  };
  // The first name in `bodies` (taken in order, each with its companions) that the table already has, else null.
  const firstTaken = (table, bodies) => {
    const taken = new Set([...table.reserved, ...table.columns.keys()]);
    for (const body of bodies) {
      for (const name of [String(body.SchemaName).toLowerCase(), ...companionsOf(body)]) {
        if (taken.has(name)) return name;
        taken.add(name);
      }
    }
    return null;
  };
  const relative = (url) => decodeURIComponent(String(url).replace(API, ''));

  const httpClient = {
    get: async (url) => {
      const p = relative(url);
      log.push({ method: 'GET', path: p });
      let m;
      if ((m = /^\/EntityDefinitions\(LogicalName='([^']+)'\)\?\$select=LogicalName,EntitySetName$/.exec(p))) {
        const t = tables.get(m[1]);
        if (t && t.lagReads > 0) { t.lagReads -= 1; return reply(404, { error: { message: `no table ${m[1]} yet` } }); }
        return t ? reply(200, { LogicalName: t.logical, EntitySetName: `${t.logical}s` }) : reply(404, { error: { message: `no table ${m[1]}` } });
      }
      if ((m = /^\/EntityDefinitions\(([0-9a-f-]{36})\)\?\$select=LogicalName,EntitySetName,PrimaryIdAttribute,PrimaryNameAttribute$/.exec(p))) {
        const t = [...tables.values()].find((x) => x.id === m[1]);
        const override = t && tableReadBack && tableReadBack(t);
        if (override) return override;
        return t ? reply(200, { LogicalName: t.logical, EntitySetName: `${t.logical}s`, PrimaryIdAttribute: `${t.logical}id`, PrimaryNameAttribute: t.primaryName }) : reply(404, { error: { message: 'no such table id' } });
      }
      if ((m = /^\/EntityDefinitions\(([0-9a-f-]{36})\)\/Attributes\?\$select=MetadataId,LogicalName$/.exec(p))) {
        attributeReadCount += 1;
        const t = [...tables.values()].find((x) => x.id === m[1]);
        const rows = t ? [...t.columns.values()].map((c) => c.row) : [];
        const override = attributeReads && attributeReads(attributeReadCount, rows);
        return override || (t ? reply(200, { value: rows }) : reply(404, { error: { message: 'no such table id' } }));
      }
      // The same read of a table found by NAME (a table whose create answer never reached the build has no id to read by).
      if ((m = /^\/EntityDefinitions\(LogicalName='([^']+)'\)\/Attributes\?\$select=MetadataId,LogicalName$/.exec(p))) {
        attributeReadCount += 1;
        const t = tables.get(m[1]);
        const rows = t ? [...t.columns.values()].map((c) => c.row) : [];
        const override = attributeReads && attributeReads(attributeReadCount, rows);
        return override || (t ? reply(200, { value: rows }) : reply(404, { error: { message: 'no such table' } }));
      }
      if ((m = /^\/EntityDefinitions\(LogicalName='([^']+)'\)\/Attributes\?\$select=LogicalName,RequiredLevel$/.exec(p))) {
        const t = tables.get(m[1]);
        return t ? reply(200, { value: [...t.columns.values()].map((c) => ({ LogicalName: c.row.LogicalName, RequiredLevel: c.body.RequiredLevel })) }) : reply(404, { error: { message: 'no such table' } });
      }
      // The read of a text column's length: one typed request that selects MaxLength and nothing else.
      if ((m = /^\/EntityDefinitions\(LogicalName='([^']+)'\)\/Attributes\(LogicalName='([^']+)'\)\/Microsoft\.Dynamics\.CRM\.StringAttributeMetadata\?\$select=MaxLength$/.exec(p))) {
        lengthReadCount += 1;
        const override = lengthRead && lengthRead(lengthReadCount);
        if (override) return override;
        const t = tables.get(m[1]);
        const column = t && t.columns.get(m[2]);
        if (!column) return reply(404, { error: { message: `no column ${m[2]}` } });
        return reply(200, { MaxLength: m[2] === t.primaryName ? t.primaryLength : column.body.MaxLength, MetadataId: column.row.MetadataId });
      }
      // The two reads of the SDK's updateColumn: the column's id and type by name, then its whole typed definition by id.
      if ((m = /^\/EntityDefinitions\(LogicalName='([^']+)'\)\/Attributes\(LogicalName='([^']+)'\)\?\$select=MetadataId,AttributeType$/.exec(p))) {
        const t = tables.get(m[1]);
        const column = t && t.columns.get(m[2]);
        return column ? reply(200, { MetadataId: column.row.MetadataId, AttributeType: 'String' }) : reply(404, { error: { message: `no column ${m[2]}` } });
      }
      if ((m = /^\/EntityDefinitions\(LogicalName='([^']+)'\)\/Attributes\(([0-9a-f-]{36})\)\/Microsoft\.Dynamics\.CRM\.StringAttributeMetadata$/.exec(p))) {
        const t = tables.get(m[1]);
        const column = t && [...t.columns.values()].find((c) => c.row.MetadataId === m[2]);
        if (!column) return reply(404, { error: { message: `no column ${m[2]}` } });
        const isPrimary = column.row.LogicalName === t.primaryName;
        return reply(200, { ...clone(column.body), ...column.row, ...(isPrimary ? { MaxLength: t.primaryLength } : {}) });
      }
      // The probe the SDK's createGlobalOptionSet makes by name before it creates the option set.
      if ((m = /^\/GlobalOptionSetDefinitions\(Name='([^']+)'\)\?\$select=MetadataId$/.exec(p))) {
        return optionSets.has(m[1]) ? reply(200, { MetadataId: optionSets.get(m[1]) }) : reply(404, { error: { message: `no option set ${m[1]}` } });
      }
      throw new Error(`unexpected GET ${p}`);
    },
    post: async (url, body, options) => {
      const p = relative(url);
      log.push({ method: 'POST', path: p, body: clone(body), headers: (options && options.headers) || {} });
      let m;
      if (p === '/EntityDefinitions') {
        // The build creates a table exactly as the previous release did: with its primary name attribute and nothing else. A request
        // that carries columns is a regression, so the stub refuses to model one.
        if (body.Attributes.length !== 1) throw new Error(`the table request carries ${body.Attributes.length - 1} column(s) beside the primary name attribute`);
        const logical = String(body.SchemaName).toLowerCase();
        if (tables.has(logical)) return refuse(p, reply(400, { error: { message: `Entities already exist: ${body.SchemaName}` } }));
        const table = {
          id: tableId(body.SchemaName), logical, primaryName: String(body.Attributes[0].SchemaName).toLowerCase(), columns: new Map(),
          reserved: new Set([`${logical}id`, ...SYSTEM_COLUMNS]), lagReads: lookupLag,
          // What the platform makes of the primary name column's length in a create that carries only that column (measured on two
          // environments): one keeps the length asked, the other makes a plain text column 850 whatever length was asked and keeps
          // the length asked of an auto-numbered one.
          primaryLength: !body.Attributes[0].AutoNumberFormat && !keepsAskedLength ? 850 : body.Attributes[0].MaxLength,
        };
        const collision = firstTaken(table, body.Attributes);
        if (collision) return refuse(p, duplicateAttribute(collision, logical));
        tables.set(logical, table);
        addColumn(table, body.Attributes[0]);
        if (createCommitsThenFails) return refuse(p, createCommitsThenFails(body));
        return created(`EntityDefinitions(${table.id})`);
      }
      if ((m = /^\/EntityDefinitions\(LogicalName='([^']+)'\)\/Attributes$/.exec(p))) {
        const t = tables.get(m[1]);
        if (!t) return reply(404, { error: { message: `no table ${m[1]}` } });
        const collision = firstTaken(t, [body]);
        if (collision) return refuse(p, duplicateAttribute(collision, t.logical));
        addColumn(t, body);
        return created(`EntityDefinitions(LogicalName='${m[1]}')/Attributes(${attributeId(t.logical, body.SchemaName)})`);
      }
      if (p === '/CreateCustomerRelationships') {
        const t = tables.get(body.OneToManyRelationships[0].ReferencingEntity);
        if (t) {
          const collision = firstTaken(t, [body.Lookup]);
          if (collision) return refuse(p, duplicateAttribute(collision, t.logical));
          addColumn(t, body.Lookup);
        }
        return reply(200, {});
      }
      if (p === '/GlobalOptionSetDefinitions') {
        const id = attributeId('globalchoice', body.Name);
        optionSets.set(body.Name, id);
        return created(`GlobalOptionSetDefinitions(${id})`);
      }
      throw new Error(`unexpected POST ${p}`);
    },
    patch: async (url) => { throw new Error(`unexpected PATCH ${relative(url)}`); },
    // The documented update of a column: a PUT of its whole typed definition, with MSCRM.MergeLabels so the labels already
    // stored are kept — what the SDK's updateColumn sends.
    put: async (url, body, options) => {
      const p = relative(url);
      log.push({ method: 'PUT', path: p, body: clone(body), headers: (options && options.headers) || {} });
      const m = /^\/EntityDefinitions\(LogicalName='([^']+)'\)\/Attributes\(([0-9a-f-]{36})\)$/.exec(p);
      if (!m) throw new Error(`unexpected PUT ${p}`);
      if (updateFails) return refuse(p, updateFails(body));
      const t = tables.get(m[1]);
      const column = t && [...t.columns.values()].find((c) => c.row.MetadataId === m[2]);
      if (!column) return reply(404, { error: { message: `no column ${m[2]}` } });
      if (column.row.LogicalName === t.primaryName) t.primaryLength = body.MaxLength;
      else column.body = { ...column.body, MaxLength: body.MaxLength };
      return reply(204, null);
    },
    delete: async (url) => { throw new Error(`unexpected DELETE ${relative(url)}`); },
  };
  // An OData `$batch` of ONE change set, as the SDK's createColumns sends it (see parseChangeSet). All or nothing: an operation the
  // platform refuses rolls the others back, and the answer is that operation's own, with its own status — the platform answers the
  // first failure of a batch with the error of that request and processes no more.
  // See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/execute-batch-operations-using-web-api#handling-errors
  if (!noPostRaw) {
    httpClient.postRaw = async (url, text, options) => {
      const p = relative(url);
      if (p !== '/$batch') throw new Error(`unexpected raw POST ${p}`);
      const operations = parseChangeSet(text);
      log.push({ method: 'POST', path: p, headers: (options && options.headers) || {}, operations: clone(operations) });
      if (batchFails) {
        const answer = batchFails(operations);
        // A falsy answer lets this change set through: a test that refuses the first sends only.
        if (answer) {
          refusals.push({ path: p, message: typeof answer.body === 'string' ? answer.body : answer.body && answer.body.error && answer.body.error.message });
          return answer;
        }
      }
      const staged = new Map();
      for (const op of operations) {
        const m = /^\/EntityDefinitions\(LogicalName='([^']+)'\)\/Attributes$/.exec(op.path);
        const t = m && tables.get(m[1]);
        let failure = null;
        if (op.method !== 'POST' || !m) failure = reply(400, { error: { message: `unexpected operation ${op.method} ${op.path}` } });
        else if (!t) failure = reply(404, { error: { message: `no table ${m[1]}` } });
        else {
          if (!staged.has(t)) staged.set(t, { columns: new Map(t.columns), reserved: new Set(t.reserved) });
          const collision = firstTaken(t, [op.body]);
          if (collision) failure = duplicateAttribute(collision, t.logical);
          else if (!dropInline.includes(op.body.SchemaName)) addColumn(t, op.body);
        }
        if (failure) {
          for (const [t2, saved] of staged) { t2.columns = saved.columns; t2.reserved = saved.reserved; }
          refusals.push({ path: p, message: failure.body.error.message });
          return reply(failure.status, changeSetAnswer([{ contentId: op.contentId, status: failure.status, body: failure.body }]));
        }
      }
      if (batchCommitsThenFails) {
        const answer = batchCommitsThenFails(operations);
        refusals.push({ path: p, message: typeof answer.body === 'string' ? answer.body : answer.body && answer.body.error && answer.body.error.message });
        return answer;
      }
      return reply(200, changeSetAnswer(operations.map((op) => ({ contentId: op.contentId, status: 204 }))));
    };
  }
  return { httpClient, log, refusals, tables, attributeReadCount: () => attributeReadCount, lengthReadCount: () => lengthReadCount };
}

async function realSdk(httpClient, { solutionUniqueName, bundle = BUNDLE } = {}) {
  const { createMakerSdk, createNodeWorkspaceStorage } = require(bundle);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'table-columns-in-create-'));
  tempDirs.push(dir);
  const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(dir), instanceUrl: ORG, httpClient, ...(solutionUniqueName ? { solutionUniqueName } : {}) });
  await sdk.initWorkspace();
  return sdk;
}

// The two behaviours the platform has been measured to have for the length asked of a primary name column in a create that carries
// only that column (see DEFAULT_PRIMARY_NAME_LENGTH): one environment keeps it, another makes a plain text column 850 characters
// long whatever was asked. The stub's default is the second; every default and every length the spec asks for is run under both.
const HONOURING = { keepsAskedLength: true };
const OVERRIDING = {};

async function provisionOver(spec, { dataverse = {}, sdkOptions = {}, capture = false, ...options } = {}) {
  const dv = fakeDataverse(dataverse);
  const sdk = await realSdk(dv.httpClient, sdkOptions);
  const events = [];
  const warnings = [];
  const runner = makeRunner({ emit: (event) => events.push(event), total: 99 });
  // `capture` answers a build that stops with what it had done so far, instead of throwing: { error, events, warnings, dv }.
  let error;
  const result = await provisionDataModel({
    sdk, provision: sdk, runner, spec, apply: true, preResolvedLanguageCode: 1033,
    provisionedLanguages: async () => [1033, 3082], sleep: async () => {}, warn: (m) => warnings.push(m), ...options,
  }).catch((err) => { if (!capture) throw err; error = err; });
  return { result, error, events, warnings, dv };
}

const posts = (run) => run.dv.log.filter((r) => r.method === 'POST');
const gets = (run) => run.dv.log.filter((r) => r.method === 'GET');
const puts = (run) => run.dv.log.filter((r) => r.method === 'PUT');
const columnPosts = (run) => posts(run).filter((r) => /\/Attributes$/.test(r.path));
const tablePosts = (run) => posts(run).filter((r) => r.path === '/EntityDefinitions');
// The change sets sent ($batch), and the columns they carry — each operation's body — in the order sent.
const batchPosts = (run) => posts(run).filter((r) => r.path === '/$batch');
const batchColumns = (run) => batchPosts(run).flatMap((r) => r.operations.map((o) => o.body));
const inlineNames = (run) => batchColumns(run).map((a) => a.SchemaName);
// The typed read of a text column's length, and the narrated "primary column length" steps (run or skipped).
const lengthReads = (run) => gets(run).filter((r) => /\/Microsoft\.Dynamics\.CRM\.StringAttributeMetadata\?\$select=MaxLength$/.test(r.path));
const lengthEvents = (run) => run.events.filter((e) => e.status !== 'start' && /^primary column length /.test(e.label));

// --- the spec: every ordinary type and property, plus the columns that must keep the per-column path ---

const ORDINARY = [
  { schemaName: 'new_title', displayName: { 1033: 'Title', 3082: 'Título' }, type: 'Text', maxLength: 200, required: true, description: 'Short title of the ticket' },
  { schemaName: 'new_email', displayName: 'Email', type: 'Text', format: 'Email', maxLength: 120 },
  { schemaName: 'new_notes', displayName: 'Notes', type: 'Memo', maxLength: 4000, description: 'Free text' },
  { schemaName: 'new_count', displayName: 'Count', type: 'Integer', minValue: 0, maxValue: 99, required: 'recommended' },
  { schemaName: 'new_minutes', displayName: 'Minutes', type: 'Integer', integerFormat: 'Duration' },
  { schemaName: 'new_big', displayName: 'Big Number', type: 'BigInt' },
  { schemaName: 'new_ratio', displayName: 'Ratio', type: 'Decimal', precision: 3, minValue: 0, maxValue: 10 },
  { schemaName: 'new_score', displayName: 'Score', type: 'Double', precision: 2 },
  { schemaName: 'new_cost', displayName: 'Cost', type: 'Money', precision: 2, minValue: 0 },
  { schemaName: 'new_due', displayName: 'Due', type: 'DateTime', dateFormat: 'DateOnly' },
  { schemaName: 'new_flag', displayName: 'Flag', type: 'Boolean', trueLabel: 'Yes', falseLabel: 'No', defaultValue: false },
  { schemaName: 'new_priority', displayName: { 1033: 'Priority', 3082: 'Prioridad' }, type: 'Choice', options: ['Low', 'High'] },
  { schemaName: 'new_tags', displayName: 'Tags', type: 'MultiChoice', options: [{ 1033: 'Alpha', 3082: 'Alfa' }, 'Beta'] },
  { schemaName: 'new_ticketno', displayName: 'Ticket No', type: 'AutoNumber', autoNumberFormat: 'T-{SEQNUM:5}' },
  { schemaName: 'new_locked', displayName: 'Locked', type: 'Text', isValidForUpdate: false, isValidForCreate: true, isValidForRead: true },
];
const PER_COLUMN = [
  { schemaName: 'new_account', displayName: 'Account', type: 'Customer' },
  { schemaName: 'new_attachment', displayName: 'Attachment', type: 'File', maxSizeKb: 1024 },
  { schemaName: 'new_calc', displayName: 'Calculated', type: 'Integer', source: 'Calculated', formula: '<xml />' },
];

function ticketSpec(columns = [...ORDINARY, ...PER_COLUMN]) {
  return {
    solution: { uniqueName: 'TableColumns', publisherPrefix: 'new' },
    entities: [
      {
        schemaName: 'new_ticket', displayName: { 1033: 'Ticket', 3082: 'Entrada' }, pluralName: { 1033: 'Tickets', 3082: 'Entradas' },
        description: 'Support tickets', primaryAttribute: { schemaName: 'new_name', displayName: 'Name' }, columns,
      },
      {
        schemaName: 'new_note', displayName: 'Note', primaryAttribute: { schemaName: 'new_notename', displayName: 'Name' },
        columns: [{ schemaName: 'new_a', type: 'Text' }, { schemaName: 'new_b', type: 'Text' }, { schemaName: 'new_c', type: 'Integer' }],
      },
    ],
    relationships: [],
  };
}

// One table with the given columns: the smallest spec that exercises a create.
function oneTable(columns, primaryAttribute = { schemaName: 'new_name', displayName: 'Name' }) {
  return {
    solution: { uniqueName: 'TableColumns', publisherPrefix: 'new' },
    relationships: [],
    entities: [{ schemaName: 'new_ticket', displayName: 'Ticket', primaryAttribute, columns }],
  };
}

test('a new table is created with only its primary name attribute and its ordinary columns follow in ONE change set instead of one request each, with the same results and events', async () => {
  const before = await provisionOver(ticketSpec(), { inlineColumns: false });
  const after = await provisionOver(ticketSpec());

  // Requests. Before: a request per column (every ordinary one + file + calculated + the second table's three), and the
  // Customer action.
  const perColumnRequests = ORDINARY.length + 2 + 3;
  assert.strictEqual(tablePosts(before).length, 2);
  assert.strictEqual(columnPosts(before).length, perColumnRequests, 'one metadata request per column');
  assert.strictEqual(posts(before).length, 2 + perColumnRequests + 1, 'two tables, the per-column requests, and the Customer action');
  // After: each table is created by the request it always was — its primary name attribute and nothing else — and its ordinary
  // columns follow in one change set; only the two that need their own request remain, and the Customer action.
  assert.deepStrictEqual(tablePosts(after).map((r) => r.body.Attributes.length), [1, 1], 'no table request carries a column');
  assert.deepStrictEqual(tablePosts(after).map((r) => r.body), tablePosts(before).map((r) => r.body), 'and the table requests are the ones the per-column path sends');
  assert.deepStrictEqual(batchPosts(after).map((r) => r.operations.length), [ORDINARY.length, 3], 'one change set per table');
  assert.deepStrictEqual(columnPosts(after).map((r) => r.body.SchemaName), ['new_attachment', 'new_calc'], 'File and Calculated keep the per-column path');
  assert.strictEqual(posts(after).filter((r) => r.path === '/CreateCustomerRelationships').length, 1, 'Customer keeps its own action');
  assert.strictEqual(posts(after).length, 2 + 2 + 2 + 1, 'two tables, two change sets, file + calculated, and the Customer action');
  assert.strictEqual(gets(after).length, gets(before).length + 2, 'plus one read of each new table\'s columns, which also returns their ids');

  // Results and the event stream are what the per-column path produced.
  assert.deepStrictEqual(after.result, before.result);
  assert.deepStrictEqual(after.events, before.events);
  assert.deepStrictEqual(after.warnings, []);
  assert.deepStrictEqual(after.dv.refusals, [], 'the platform refused nothing');
  assert.strictEqual(after.result.columns.new_ticket.length, ORDINARY.length + 1 /* customer */ + 2 /* file, calculated */);
});

test('each column\'s body in the change set equals the body the per-column path posts, to the same URL and with the solution header', async () => {
  const sdkOptions = { solutionUniqueName: 'TableColumns' };
  const before = await provisionOver(ticketSpec(), { inlineColumns: false, sdkOptions });
  const after = await provisionOver(ticketSpec(), { sdkOptions });

  const perColumn = new Map(columnPosts(before).map((r) => [r.body.SchemaName, r]));
  const [change] = batchPosts(after);
  const inline = change.operations.map((o) => o.body);
  assert.deepStrictEqual(inline.map((a) => a.SchemaName), ORDINARY.map((c) => c.schemaName), 'the ordinary columns, in spec order');
  for (const operation of change.operations) {
    const own = perColumn.get(operation.body.SchemaName);
    assert.deepStrictEqual(operation.body, own.body, `${operation.body.SchemaName}: the same attribute JSON as its own request`);
    assert.strictEqual(operation.method, 'POST');
    assert.strictEqual(operation.path, own.path, `${operation.body.SchemaName}: to the table's Attributes collection, as its own request`);
    // The header on the outer `$batch` request is ignored by the platform, so a column of the change set would land outside the
    // solution without it on each operation.
    assert.strictEqual(own.headers['MSCRM.SolutionUniqueName'], 'TableColumns', 'the per-column request files the column in the solution');
    assert.strictEqual(operation.headers['MSCRM.SolutionUniqueName'], 'TableColumns', `${operation.body.SchemaName}: and so does its operation in the change set`);
  }
  // The properties a column can carry, present and carried through: localized labels at their LCIDs, required level,
  // description, type-specific metadata (a text format, a whole-number format, a big integer), choice options,
  // defaults and the IsValidFor* flags.
  const byName = new Map(inline.map((a) => [a.SchemaName, a]));
  assert.deepStrictEqual(byName.get('new_title').DisplayName.LocalizedLabels.map((l) => [l.LanguageCode, l.Label]), [[1033, 'Title'], [3082, 'Título']]);
  assert.strictEqual(byName.get('new_title').RequiredLevel.Value, 'ApplicationRequired');
  assert.strictEqual(byName.get('new_title').Description.LocalizedLabels[0].Label, 'Short title of the ticket');
  assert.strictEqual(byName.get('new_title').MaxLength, 200);
  assert.strictEqual(byName.get('new_email').FormatName.Value, 'Email', 'a Text column\'s format');
  assert.strictEqual(byName.get('new_email').MaxLength, 120);
  assert.strictEqual(byName.get('new_count').RequiredLevel.Value, 'Recommended');
  assert.strictEqual(byName.get('new_minutes').Format, 'Duration', 'an Integer column\'s display format');
  assert.strictEqual(byName.get('new_big').AttributeType, 'BigInt', 'a BigInt column');
  assert.strictEqual(byName.get('new_big')['@odata.type'], 'Microsoft.Dynamics.CRM.BigIntAttributeMetadata');
  assert.deepStrictEqual(byName.get('new_priority').OptionSet.Options.map((o) => o.Value), [100000000, 100000001]);
  assert.strictEqual(byName.get('new_tags').OptionSet.Options[0].Label.LocalizedLabels.length, 2, 'a localized option keeps both languages');
  assert.strictEqual(byName.get('new_flag').DefaultValue, false);
  assert.strictEqual(byName.get('new_ticketno').AutoNumberFormat, 'T-{SEQNUM:5}');
  assert.strictEqual(byName.get('new_locked').IsValidForUpdate, false);
  assert.strictEqual(byName.get('new_locked').IsValidForCreate, true);
  assert.strictEqual(byName.get('new_locked').IsValidForRead, true);
  // And the table's own request — the primary name attribute included — is exactly what the per-column path sends.
  assert.deepStrictEqual(tablePosts(after)[0].body, tablePosts(before)[0].body, 'the table request is the same body with or without a change set after it');
});

test('only ordinary columns go in the change set — Customer, File, Image, Calculated, Rollup and global-choice columns do not, and no more than 25 do', async () => {
  const ineligible = [
    { schemaName: 'new_account', type: 'Customer' }, { schemaName: 'new_file', type: 'File' }, { schemaName: 'new_image', type: 'Image' },
    { schemaName: 'new_calc', type: 'Integer', source: 'Calculated', formula: '<xml />' }, { schemaName: 'new_roll', type: 'Integer', source: 'Rollup', formula: '<xml />' },
  ];
  const created = [];
  const together = [];
  const sdk = {
    createColumns: async (logical, options) => { together.push([logical, options]); },
    createTable: async (o) => { created.push(o); return { logicalName: o.schemaName.toLowerCase(), entitySetName: 'x', metadataId: tableId(o.schemaName) }; },
    createColumn: async (l, o) => ({ logicalName: o.schemaName.toLowerCase(), metadataId: attributeId(l, o.schemaName) }),
    createCustomerColumn: async (l, o) => ({ logicalName: o.schemaName.toLowerCase(), metadataId: '' }),
    createGlobalOptionSet: async (o) => ({ metadataId: tableId(o.name) }),
  };
  const many = Array.from({ length: 30 }, (_, n) => ({ schemaName: `new_t${String(n).padStart(2, '0')}`, type: 'Text' }));
  const globalBound = { schemaName: 'new_global', type: 'Choice', globalChoice: 'new_shared' };
  const spec = { solution: { uniqueName: 'S', publisherPrefix: 'new' }, globalChoices: [{ name: 'new_shared', options: ['A'] }], relationships: [], entities: [
    { schemaName: 'new_t', displayName: 'T', primaryAttribute: { schemaName: 'new_n' }, columns: [...ineligible.slice(0, 3), globalBound, ...many, ...ineligible.slice(3)] },
  ] };
  const column = [];
  sdk.createColumn = async (l, o) => { column.push(o.schemaName); return { logicalName: o.schemaName.toLowerCase(), metadataId: attributeId(l, o.schemaName) }; };
  const provision = { findTables: async () => [], findColumns: async () => [], dataverse: { get: async (url) => {
    if (/Attributes\?\$select=MetadataId,LogicalName$/.test(url)) return { status: 200, body: { value: many.slice(0, 25).map((c) => ({ LogicalName: c.schemaName, MetadataId: attributeId('new_t', c.schemaName) })) } };
    return { status: 404, body: null };
  } } };
  await provisionDataModel({ sdk, provision, runner: makeRunner({ emit: () => {}, total: 99 }), spec, apply: true, preResolvedLanguageCode: 1033, sleep: async () => {} });
  assert.strictEqual(created.length, 1);
  assert.ok(!('columns' in created[0]), 'the table request carries no column');
  assert.strictEqual(together.length, 1, 'one change set');
  assert.strictEqual(together[0][0], 'new_t', 'for the new table');
  assert.deepStrictEqual(together[0][1].map((c) => c.schemaName), many.slice(0, 25).map((c) => c.schemaName), 'the first 25 ordinary columns, in order');
  assert.deepStrictEqual(column.sort(), ['new_calc', 'new_file', 'new_global', 'new_image', 'new_roll', ...many.slice(25).map((c) => c.schemaName)].sort(), 'everything else is created by its own request');
});

test('a table that already exists, an SDK without createColumns, or inlineColumns:false keeps the per-column path untouched', async () => {
  const spec = { solution: { uniqueName: 'S', publisherPrefix: 'new' }, relationships: [], entities: [
    { schemaName: 'new_t', displayName: 'T', primaryAttribute: { schemaName: 'new_n' }, columns: [{ schemaName: 'new_a', type: 'Text' }, { schemaName: 'new_b', type: 'Integer' }] },
  ] };
  const run = async ({ withCreateColumns, existing = false, inlineColumns }) => {
    const seen = { createTable: [], createColumn: [], createColumns: [], reads: [] };
    const sdk = {
      createTable: async (o) => { seen.createTable.push(o); return { logicalName: 'new_t', entitySetName: 'new_ts', metadataId: tableId('new_t') }; },
      createColumn: async (l, o) => { seen.createColumn.push(o.schemaName); return { logicalName: o.schemaName.toLowerCase(), metadataId: attributeId(l, o.schemaName) }; },
      ...(withCreateColumns ? { createColumns: async (l, options) => { seen.createColumns.push(options); } } : {}),
    };
    const provision = {
      findTables: async () => (existing ? [{ logicalName: 'new_t', entitySetName: 'new_ts' }] : []),
      findColumns: async () => [],
      dataverse: { get: async (url) => {
        seen.reads.push(url);
        if (/\?\$select=LogicalName,EntitySetName$/.test(url)) return existing ? { status: 200, body: { LogicalName: 'new_t', EntitySetName: 'new_ts' } } : { status: 404, body: null };
        return { status: 200, body: { value: [] } };
      } },
    };
    await provisionDataModel({ sdk, provision, runner: makeRunner({ emit: () => {}, total: 99 }), spec, apply: true, preResolvedLanguageCode: 1033, sleep: async () => {}, inlineColumns });
    return seen;
  };
  for (const [label, options] of [['no createColumns on the SDK', { withCreateColumns: false }], ['inlineColumns:false', { withCreateColumns: true, inlineColumns: false }]]) {
    const seen = await run(options);
    assert.ok(!('columns' in seen.createTable[0]), `${label}: createTable carries no columns`);
    assert.deepStrictEqual(seen.createColumns, [], `${label}: no change set`);
    assert.deepStrictEqual(seen.createColumn, ['new_a', 'new_b'], `${label}: one createColumn each`);
    assert.ok(!seen.reads.some((u) => /MetadataId,LogicalName/.test(u)), `${label}: no read of the new columns`);
  }
  const existing = await run({ withCreateColumns: true, existing: true });
  assert.strictEqual(existing.createTable.length, 0);
  assert.deepStrictEqual(existing.createColumns, [], 'a table that exists is given no change set');
  assert.deepStrictEqual(existing.createColumn, ['new_a', 'new_b'], 'a table that exists gets its missing columns one by one');
  assert.ok(!existing.reads.some((u) => /MetadataId,LogicalName/.test(u)));
});

// --- when the change set cannot be trusted, the per-column path takes over -------------------------------

// A change set the platform refuses is rolled back as a whole, so nothing was created and the build goes on as it always did: one
// request per column. It costs one refused request and a warning that says why.
test('a change set the platform refuses creates nothing — the build falls back to one request per column and still completes, with a warning that says why', async () => {
  const refuse = () => ({ status: 400, headers: {}, body: '{"error":{"code":"0x80048d19","message":"The attribute metadata is not valid for this table"}}' });
  const before = await provisionOver(ticketSpec(), { inlineColumns: false });
  const after = await provisionOver(ticketSpec(), { dataverse: { batchFails: refuse } });
  assert.deepStrictEqual(after.result, before.result, 'the same data model');
  assert.deepStrictEqual(after.events, before.events, 'and the same steps');
  assert.deepStrictEqual(tablePosts(after).map((r) => r.body), tablePosts(before).map((r) => r.body), 'the tables are created as ever, once each');
  assert.strictEqual(batchPosts(after).length, 2, 'one refused change set per table');
  assert.strictEqual(columnPosts(after).length, columnPosts(before).length, 'the columns were then created one by one');
  assert.deepStrictEqual(after.dv.tables.get('new_ticket').columns.size, before.dv.tables.get('new_ticket').columns.size);
  assert.strictEqual(after.warnings.length, 2);
  assert.match(after.warnings[0], new RegExp(`^could not create the ${ORDINARY.length} ordinary column\\(s\\) of table new_ticket in one request \\(HTTP 400: The attribute metadata is not valid for this table\\) — creating them one by one$`));
});

// The platform refusing to START a change set (HTTP 429) is not a defect of the request — the table's customization lock is held, or a
// service protection limit was reached — so the warning says the table was throttled instead of "could not create".
const TABLE_LOCKED_BODY = '{"error":{"code":"0x80072322","message":"Cannot start the requested operation [Publish] because there is another [EntityCustomization] running at this moment."}}';
const LOCKED_REASON = 'HTTP 429: Cannot start the requested operation [Publish] because there is another [EntityCustomization] running at this moment.';

test('a change set refused because the table is locked (HTTP 429) falls back to one request per column, each of which retries its own 429s — with a warning that says the table was throttled, not that the request failed', async () => {
  const locked = () => ({ status: 429, headers: {}, body: TABLE_LOCKED_BODY });
  const spec = oneTable([{ schemaName: 'new_a', type: 'Text' }, { schemaName: 'new_b', type: 'Text' }]);
  const before = await provisionOver(spec, { inlineColumns: false });
  const after = await provisionOver(spec, { dataverse: { batchFails: locked } });
  assert.strictEqual(batchPosts(after).length, 1, 'a transport that does not retry sends the change set once (the plugin\'s HTTP client sends it again: see below)');
  assert.deepStrictEqual(after.result, before.result);
  assert.deepStrictEqual(after.events, before.events);
  assert.deepStrictEqual(after.warnings, [`table new_ticket was throttled (${LOCKED_REASON}), so its 2 ordinary column(s) are created one by one instead of in one request`]);
});

test('a 429 reported by the operations inside a change set is the same throttling: the same warning', async () => {
  // A complete answer that reports every operation of the change set as refused with a 429, under an outer status that is a success.
  const refusedInside = (operations) => ({ status: 200, headers: {}, body: changeSetAnswer(operations.map((op) => ({ contentId: op.contentId, status: 429, body: JSON.parse(TABLE_LOCKED_BODY) }))) });
  const run = await provisionOver(oneTable([textColumn('new_a'), textColumn('new_b')]), { dataverse: { batchFails: refusedInside } });
  assert.deepStrictEqual(run.warnings, [`table new_ticket was throttled (HTTP 429 from ${API}/$batch: atomic write of 2 column(s) on 'new_ticket' was rolled back: the change set reported HTTP 429), so its 2 ordinary column(s) are created one by one instead of in one request`]);
  assert.ok(run.result.columns.new_ticket.some((c) => c.schemaName === 'new_b'), 'and the columns were created one by one');
});

test('only a 429 is reported as throttling: any other refusal keeps the "could not create ... in one request" warning', async () => {
  for (const status of [400, 409, 500, 503]) {
    const run = await provisionOver(oneTable([textColumn('new_a')]), { dataverse: { batchFails: () => ({ status, headers: {}, body: '{"error":{"message":"refused"}}' }) } });
    assert.deepStrictEqual(run.warnings, [`could not create the 1 ordinary column(s) of table new_ticket in one request (HTTP ${status}: refused) — creating them one by one`], String(status));
  }
});

test('an SDK whose transport cannot send a change set (no postRaw) falls back to one request per column, with a warning that says so — nothing is sent', async () => {
  const before = await provisionOver(ticketSpec(), { inlineColumns: false });
  const after = await provisionOver(ticketSpec(), { dataverse: { noPostRaw: true } });
  assert.deepStrictEqual(batchPosts(after), [], 'no change set was sent');
  assert.deepStrictEqual(after.result, before.result);
  assert.deepStrictEqual(after.events, before.events);
  assert.strictEqual(columnPosts(after).length, columnPosts(before).length);
  assert.strictEqual(after.warnings.length, 2);
  assert.match(after.warnings[0], /^could not create the 15 ordinary column\(s\) of table new_ticket in one request \(createColumns writes 15 columns on 'new_ticket' as ONE atomic change set, which needs a verbatim request body\. Implement HttpClient\.postRaw, or call createColumn per column and accept that a failure can leave the table partly extended\.\) — creating them one by one$/);
});

// A change set whose answer was lost or could not be read — a transport failure, a server error, or a success status over a body that
// is not a change-set answer — may have committed. The table is read before anything is assumed: when it has every column the change
// set committed, and each column is answered as it would have been had the answer arrived — created, with its id — instead of being
// asked for again and skipped as existing.
test('a change set that was committed but whose answer was lost or unreadable is recognised by reading the table: every column is narrated as created, with its id, and none is asked for twice', async () => {
  for (const [what, lost, reason] of [
    ['an unreadable answer under a success status', () => ({ status: 200, headers: {}, body: 'this is not a batch answer' }), /^HTTP 200 from \S+\/\$batch: atomic write of 15 column\(s\) on 'new_ticket' cannot be confirmed/],
    ['a server error', () => ({ status: 502, headers: {}, body: null }), /^HTTP 502 from \S+\/\$batch/],
    ['a transport failure', () => { throw new Error('socket hang up'); }, /^Transport failure reaching \S+\/\$batch: socket hang up$/],
  ]) {
    const before = await provisionOver(ticketSpec(), { inlineColumns: false });
    const after = await provisionOver(ticketSpec(), { dataverse: { batchCommitsThenFails: lost } });
    assert.strictEqual(batchPosts(after).length, 2, `${what}: each change set was sent once`);
    assert.deepStrictEqual([...after.dv.tables.get('new_ticket').columns.keys()].sort(), [...before.dv.tables.get('new_ticket').columns.keys()].sort(), `${what}: the table has the very columns the per-column build makes`);
    assert.deepStrictEqual(after.result, before.result, `${what}: the result is the per-column build's, ids included`);
    assert.deepStrictEqual(after.events, before.events, `${what}: and so are the steps — created, not skipped as existing`);
    assert.deepStrictEqual(after.dv.refusals.filter((r) => /already exists/.test(r.message)), [], `${what}: no column was asked for twice`);
    assert.deepStrictEqual(columnPosts(after).map((r) => r.body.SchemaName), ['new_attachment', 'new_calc'], `${what}: only the columns that take their own request were posted`);
    assert.strictEqual(after.warnings.length, 2, `${what}: one warning for each change set`);
    const prefix = 'the answer to the request that creates the 15 ordinary column(s) of table new_ticket was lost or could not be read (';
    const suffix = '), but the table has every one of them';
    assert.ok(after.warnings[0].startsWith(prefix) && after.warnings[0].endsWith(suffix), `${what}: ${after.warnings[0]}`);
    assert.match(after.warnings[0].slice(prefix.length, -suffix.length), reason, `${what}: and the warning says why`);
    assert.strictEqual(after.dv.attributeReadCount(), 2, `${what}: the table was read once for each change set`);
  }
});

// What the read finds decides: nothing, or only part of it, is a refusal and takes the per-column path as it always did.
test('after a lost answer the per-column path takes over unless the table has EVERY column — a server error that created nothing, a platform that left a column out, a name the platform makes itself', async () => {
  const unavailable = () => ({ status: 503, headers: {}, body: '{"error":{"message":"The service is unavailable"}}' });
  const spec = oneTable([textColumn('new_a'), { schemaName: 'new_b', type: 'Integer' }]);
  const baseline = await provisionOver(spec, { inlineColumns: false });
  // Nothing was created: the answer was a gateway error that never reached the platform.
  const refused = await provisionOver(spec, { dataverse: { batchFails: unavailable } });
  assert.strictEqual(refused.dv.attributeReadCount(), 1, 'the table was read once, with no second attempt');
  assert.deepStrictEqual(refused.result, baseline.result);
  assert.deepStrictEqual(refused.events, baseline.events);
  assert.deepStrictEqual(refused.warnings, ['could not create the 2 ordinary column(s) of table new_ticket in one request (HTTP 503: The service is unavailable) — creating them one by one']);
  // The platform committed the change set and then did not list one of its columns: the rest are skipped as existing.
  const partial = await provisionOver(spec, { dataverse: { batchCommitsThenFails: () => ({ status: 502, headers: {}, body: null }), dropInline: ['new_b'] } });
  assert.deepStrictEqual([...partial.dv.tables.get('new_ticket').columns.keys()].sort(), [...baseline.dv.tables.get('new_ticket').columns.keys()].sort(), 'the table still ends up with both columns');
  assert.deepStrictEqual(partial.events.filter((e) => e.status === 'skip').map((e) => e.label), ['column new_ticket.new_a (Text) (exists)'], 'the column that is there was not created twice');
  assert.match(partial.warnings[0], /^could not create the 2 ordinary column\(s\) of table new_ticket in one request \(HTTP 502/);
  // A column the platform makes itself is there whatever the change set did, so it does not show that the change set committed.
  const platformMade = oneTable([{ schemaName: 'createdon', displayName: 'Created', type: 'DateTime' }, textColumn('new_a')]);
  const doomed = await provisionOver(platformMade, { dataverse: { batchFails: unavailable } });
  const doomedBaseline = await provisionOver(platformMade, { inlineColumns: false });
  assert.deepStrictEqual(doomed.result, doomedBaseline.result);
  assert.deepStrictEqual(doomed.events, doomedBaseline.events, 'createdon is a skip, as one by one');
  assert.match(doomed.warnings[0], /^could not create the 2 ordinary column\(s\)/);
});

test('only an answer that leaves the outcome unknown is followed by a read of the table: a refusal (any 4xx) and a request the SDK never sent are not', async () => {
  const spec = oneTable([textColumn('new_a'), textColumn('new_b')]);
  for (const [what, dataverse, reads] of [
    ['HTTP 400', { batchFails: () => ({ status: 400, headers: {}, body: '{"error":{"message":"refused"}}' }) }, 0],
    ['HTTP 409', { batchFails: () => ({ status: 409, headers: {}, body: '{"error":{"message":"refused"}}' }) }, 0],
    ['HTTP 429', { batchFails: () => ({ status: 429, headers: {}, body: TABLE_LOCKED_BODY }) }, 0],
    ['no postRaw on the transport (the SDK refuses before sending)', { noPostRaw: true }, 0],
    ['HTTP 500', { batchFails: () => ({ status: 500, headers: {}, body: '{"error":{"message":"refused"}}' }) }, 1],
    ['HTTP 503', { batchFails: () => ({ status: 503, headers: {}, body: '{"error":{"message":"refused"}}' }) }, 1],
  ]) {
    const run = await provisionOver(spec, { dataverse });
    assert.strictEqual(run.dv.attributeReadCount(), reads, what);
  }
});

// The plugin's own HTTP client over the same stub — what a real build sends: its `postRaw` (the verbatim body a change set needs; the
// SDK's DataverseClient.supportsAtomicBatch is true exactly when the client has it), its headers and its retry policy. `slept` records
// the waits between attempts (without waiting); the jitter is off, so they are the schedule itself.
function throughAzHttpClient(dv) {
  const { createAzHttpClient } = require('../lib/sdk-http-client.js');
  const sent = [];
  const slept = [];
  const request = async ({ url, method, headers, body }) => {
    sent.push({ url, method, headers, body });
    let res;
    if (method === 'GET') res = await dv.httpClient.get(url);
    else if (/\/\$batch$/.test(url)) res = await dv.httpClient.postRaw(url, body, { headers });
    else if (method === 'POST') res = await dv.httpClient.post(url, JSON.parse(body), { headers });
    else if (method === 'PUT') res = await dv.httpClient.put(url, JSON.parse(body), { headers });
    else throw new Error(`unexpected ${method} ${url}`);
    return { statusCode: res.status, headers: res.headers || {}, body: typeof res.body === 'string' ? res.body : (res.body === null || res.body === undefined ? '' : JSON.stringify(res.body)) };
  };
  const httpClient = createAzHttpClient(ORG, { getToken: () => 'test-token', request, sleep: async (ms) => { slept.push(ms); }, random: () => 0 });
  return { httpClient, sent, slept };
}

test('through the plugin\'s own HTTP client the change set goes out once, as a multipart `$batch`, and the build completes with what the per-column build makes', async () => {
  const dv = fakeDataverse();
  const { httpClient, sent } = throughAzHttpClient(dv);
  assert.strictEqual(typeof httpClient.postRaw, 'function', 'the client can send the body of a change set verbatim');
  const sdk = await realSdk(httpClient, { solutionUniqueName: 'TableColumns' });
  assert.strictEqual(sdk.dataverse.supportsAtomicBatch, true, 'so the SDK reports that it can send an atomic change set');
  const events = [];
  const warnings = [];
  const spec = oneTable([textColumn('new_a'), { schemaName: 'new_b', type: 'Integer' }, { schemaName: 'new_file', type: 'File' }]);
  const result = await provisionDataModel({ sdk, provision: sdk, runner: makeRunner({ emit: (e) => events.push(e), total: 99 }), spec, apply: true, preResolvedLanguageCode: 1033, provisionedLanguages: async () => [1033], sleep: async () => {}, warn: (m) => warnings.push(m) });
  const batches = sent.filter((s) => /\/\$batch$/.test(s.url));
  assert.strictEqual(batches.length, 1, 'one change set');
  assert.strictEqual(batches[0].method, 'POST');
  assert.match(batches[0].headers['Content-Type'], /^multipart\/mixed;boundary=batch_/, 'announcing the batch boundary, which the SDK chose');
  assert.strictEqual(typeof batches[0].body, 'string', 'and its body is the multipart text, not JSON');
  assert.ok(batches[0].headers.Authorization, 'authorized like every other request');
  assert.deepStrictEqual(parseChangeSet(batches[0].body).map((o) => [o.method, o.path, o.body.SchemaName, o.headers['MSCRM.SolutionUniqueName']]), [
    ['POST', "/EntityDefinitions(LogicalName='new_ticket')/Attributes", 'new_a', 'TableColumns'],
    ['POST', "/EntityDefinitions(LogicalName='new_ticket')/Attributes", 'new_b', 'TableColumns'],
  ]);
  assert.deepStrictEqual(warnings, []);
  const baseline = await provisionOver(spec, { inlineColumns: false });
  assert.deepStrictEqual(result, baseline.result);
  assert.deepStrictEqual(events, baseline.events);
});

test('a change set the platform answers with a transient error (503) is sent once — it may have committed behind that answer, so the HTTP client does not send it again — and the build falls back to one request per column', async () => {
  const dv = fakeDataverse({ batchFails: () => ({ status: 503, headers: {}, body: '{"error":{"message":"The service is unavailable"}}' }) });
  const { httpClient, sent } = throughAzHttpClient(dv);
  const sdk = await realSdk(httpClient);
  const warnings = [];
  await provisionDataModel({ sdk, provision: sdk, runner: makeRunner({ emit: () => {}, total: 9 }), spec: oneTable([textColumn('new_a'), textColumn('new_b')]), apply: true, preResolvedLanguageCode: 1033, provisionedLanguages: async () => [1033], sleep: async () => {}, warn: (m) => warnings.push(m) });
  assert.strictEqual(sent.filter((s) => /\/\$batch$/.test(s.url)).length, 1, 'one attempt: a change set that may have committed behind a lost answer is not re-sent');
  assert.strictEqual(sent.filter((s) => /\/Attributes$/.test(s.url) && s.method === 'POST').length, 2, 'then each column by its own request');
  assert.match(warnings[0], /^could not create the 2 ordinary column\(s\) of table new_ticket in one request \(HTTP 503: The service is unavailable\) — creating them one by one$/);
});

// The table was created a moment ago, and its customization lock can still be held when the change set arrives. The platform then
// refuses to START the change set (HTTP 429), which proves nothing in it ran, so the plugin's HTTP client sends it again — on the
// schedule of any other throttled write, honouring Retry-After — and the build goes on as if the first send had been accepted.
test('a change set refused with HTTP 429 (the table is still locked) is sent again by the plugin\'s HTTP client, honouring Retry-After — and the build goes on with it: no per-column request, no warning', async () => {
  let refused = 0;
  const dv = fakeDataverse({ batchFails: () => (++refused <= 2 ? { status: 429, headers: { 'retry-after': '3' }, body: TABLE_LOCKED_BODY } : null) });
  const { httpClient, sent, slept } = throughAzHttpClient(dv);
  const sdk = await realSdk(httpClient, { solutionUniqueName: 'TableColumns' });
  const events = [];
  const warnings = [];
  const spec = oneTable([textColumn('new_a'), { schemaName: 'new_b', type: 'Integer' }]);
  const result = await provisionDataModel({ sdk, provision: sdk, runner: makeRunner({ emit: (e) => events.push(e), total: 99 }), spec, apply: true, preResolvedLanguageCode: 1033, provisionedLanguages: async () => [1033], sleep: async () => {}, warn: (m) => warnings.push(m) });
  const batches = sent.filter((s) => /\/\$batch$/.test(s.url));
  assert.strictEqual(batches.length, 3, 'refused twice, then accepted');
  assert.ok(batches.every((b) => b.body === batches[0].body), 'the same change set, byte for byte, each time');
  assert.deepStrictEqual(slept, [3000, 3000], 'after the wait the platform asked for, which is longer than the backoff');
  assert.deepStrictEqual(sent.filter((s) => /\/Attributes$/.test(s.url) && s.method === 'POST'), [], 'so no column needed a request of its own');
  assert.deepStrictEqual(warnings, []);
  const baseline = await provisionOver(spec, { inlineColumns: false });
  assert.deepStrictEqual(result, baseline.result, 'with the result the per-column build gives');
  assert.deepStrictEqual(events, baseline.events, 'and its steps');
});

test('a table still locked after the HTTP client has spent its attempts: the change set was sent six times, then the columns are created one by one, and the warning says the table was throttled', async () => {
  const dv = fakeDataverse({ batchFails: () => ({ status: 429, headers: {}, body: TABLE_LOCKED_BODY }) });
  const { httpClient, sent, slept } = throughAzHttpClient(dv);
  const sdk = await realSdk(httpClient);
  const events = [];
  const warnings = [];
  const spec = oneTable([textColumn('new_a'), textColumn('new_b')]);
  const result = await provisionDataModel({ sdk, provision: sdk, runner: makeRunner({ emit: (e) => events.push(e), total: 99 }), spec, apply: true, preResolvedLanguageCode: 1033, provisionedLanguages: async () => [1033], sleep: async () => {}, warn: (m) => warnings.push(m) });
  assert.strictEqual(sent.filter((s) => /\/\$batch$/.test(s.url)).length, 6, 'six attempts in all, like any other throttled write');
  assert.deepStrictEqual(slept, [1000, 2000, 4000, 8000, 8000]);
  assert.strictEqual(sent.filter((s) => /\/Attributes$/.test(s.url) && s.method === 'POST').length, 2, 'then each column by its own request');
  assert.deepStrictEqual(warnings, [`table new_ticket was throttled (${LOCKED_REASON}), so its 2 ordinary column(s) are created one by one instead of in one request`]);
  const baseline = await provisionOver(spec, { inlineColumns: false });
  assert.deepStrictEqual(result, baseline.result);
  assert.deepStrictEqual(events, baseline.events);
});

// A column whose options cannot even be built (a spec the validator would have refused) must not turn into a different failure for
// being near a change set: the options are built inside the attempt, the attempt is abandoned with its reason, and the column then
// fails in its own step, as it always did.
test('a column whose options cannot be built fails in its own step exactly as one by one — the change set is abandoned with a warning, never sent', async () => {
  const spec = oneTable([textColumn('new_a'), { schemaName: 'new_bad', displayName: 'Bad', type: 'Choice', options: 'not a list' }, textColumn('new_c')]);
  const baseline = await provisionOver(spec, { inlineColumns: false, capture: true });
  const run = await provisionOver(spec, { capture: true });
  assert.ok(baseline.error instanceof BuildHalt, 'one by one, the build stops at that column');
  assert.ok(run.error instanceof BuildHalt);
  assert.strictEqual(run.error.message, baseline.error.message, 'with the same message');
  assert.deepStrictEqual(run.events, baseline.events, 'after the same steps');
  assert.deepStrictEqual(batchPosts(run), [], 'no change set was sent');
  assert.match(run.warnings[0], /^could not create the 3 ordinary column\(s\) of table new_ticket in one request \(.*is not a function.*\) — creating them one by one$/);
});

// Dataverse refuses a change set that would create an attribute twice, as a whole, with 0x80060304. Each way a spec can ask
// for that is a column that must stay OUT of the change set and take the one-by-one path, where the same collision is
// one column's own "already exists" — a skip, which is how the build has always treated it.

// What the platform makes of the primary-name collisions, `<table>id` and money twins is modelled by the stub; this runs a spec
// through both paths and checks the new one asks the platform for nothing it would refuse.
async function collisionRun(columns, primaryAttribute) {
  const spec = oneTable(columns, primaryAttribute);
  const run = await provisionOver(spec);
  const baseline = await provisionOver(spec, { inlineColumns: false });
  assert.deepStrictEqual(run.warnings, [], 'no fallback was needed, so nothing is warned');
  assert.deepStrictEqual(run.dv.refusals.filter((r) => r.path === '/$batch'), [], 'the platform refused no change set');
  assert.strictEqual(tablePosts(run).length, 1, 'ONE table request, which carries no column');
  assert.strictEqual(batchPosts(run).length, 1, 'ONE change set, with the columns that can go in it');
  assert.deepStrictEqual(run.result.columns, baseline.result.columns, 'the same columns, with the same ids, as the one-by-one build');
  return { run, baseline, inline: inlineNames(run), skipped: run.events.filter((e) => e.status === 'skip').map((e) => e.label) };
}

test('a column that repeats the primary name column stays out of the change set and is skipped as already existing', async () => {
  const { inline, skipped, baseline } = await collisionRun([
    { schemaName: 'new_name', displayName: 'Name again', type: 'Text' },
    { schemaName: 'new_a', type: 'Text' },
  ]);
  assert.deepStrictEqual(inline, ['new_a']);
  assert.deepStrictEqual(skipped, ['column new_ticket.new_name (Text) (exists)']);
  assert.deepStrictEqual(baseline.events.filter((e) => e.status === 'skip').map((e) => e.label), skipped, 'the one-by-one build skips it the same way');
});

test('two columns whose names differ only by case: the first goes in the change set, the second is skipped as already existing', async () => {
  const { inline, skipped } = await collisionRun([
    { schemaName: 'new_Code', displayName: 'Code', type: 'Text' },
    { schemaName: 'new_code', displayName: 'Code (lower case)', type: 'Integer' },
    { schemaName: 'new_a', type: 'Text' },
  ]);
  assert.deepStrictEqual(inline, ['new_Code', 'new_a']);
  assert.deepStrictEqual(skipped, ['column new_ticket.new_code (Integer) (exists)']);
});

test('a column named <table>id (the table\'s own key) stays out of the change set and is skipped as already existing', async () => {
  const { inline, skipped } = await collisionRun([
    { schemaName: 'new_ticketid', displayName: 'Ticket Id', type: 'Text' },
    { schemaName: 'new_a', type: 'Text' },
  ]);
  assert.deepStrictEqual(inline, ['new_a']);
  assert.deepStrictEqual(skipped, ['column new_ticket.new_ticketid (Text) (exists)']);
});

test('a Money column and its <money>_base twin: the twin stays out of the change set and is skipped as already existing when it comes second; when it comes first the twin is kept and the Money column is the skip — as one by one', async () => {
  for (const [what, columns, inline, skipped] of [
    ['the Money column first', [{ schemaName: 'new_cost', type: 'Money' }, { schemaName: 'new_cost_base', type: 'Money' }, { schemaName: 'new_a', type: 'Text' }], ['new_cost', 'new_a'], 'column new_ticket.new_cost_base (Money) (exists)'],
    ['the twin first', [{ schemaName: 'new_cost_base', type: 'Money' }, { schemaName: 'new_cost', type: 'Money' }, { schemaName: 'new_a', type: 'Text' }], ['new_a'], 'column new_ticket.new_cost (Money) (exists)'],
  ]) {
    const spec = oneTable(columns);
    const run = await provisionOver(spec);
    const baseline = await provisionOver(spec, { inlineColumns: false });
    assert.deepStrictEqual(run.warnings, [], what);
    assert.deepStrictEqual(run.dv.refusals.filter((r) => r.path === '/$batch'), [], `${what}: the platform refused no change set`);
    assert.strictEqual(tablePosts(run).length, 1, what);
    assert.deepStrictEqual(inlineNames(run), inline, `${what}: the twin is never in the change set, and the owner is not when the twin comes first`);
    assert.deepStrictEqual(run.events.filter((e) => e.status === 'skip').map((e) => e.label), [skipped], `${what}: the column that comes second is the one skipped`);
    assert.deepStrictEqual(run.result.columns, baseline.result.columns, `${what}: the same columns, with the same ids, as the one-by-one build`);
    assert.deepStrictEqual(run.events, baseline.events, `${what}: and the same steps`);
  }
});

test('a Money twin is reserved even when its Money column takes the one-by-one path (a Calculated Money column), so that column is not refused for it', async () => {
  const run = await provisionOver(oneTable([
    { schemaName: 'new_total', displayName: 'Total', type: 'Money', source: 'Calculated', formula: '<xml />' },
    { schemaName: 'new_total_base', displayName: 'Total (base)', type: 'Text' },
    { schemaName: 'new_a', type: 'Text' },
  ]));
  assert.deepStrictEqual(run.warnings, []);
  assert.deepStrictEqual(inlineNames(run), ['new_a'], 'neither the calculated column nor the name its twin will take is in the change set');
  assert.ok(run.result.columns.new_ticket.some((c) => c.schemaName === 'new_total'), 'the Money column is created by its own request, before anything holds its twin\'s name');
  assert.deepStrictEqual(run.events.filter((e) => e.status === 'skip').map((e) => e.label), ['column new_ticket.new_total_base (Text) (exists)']);
});

// A Choice, a MultiChoice and a Boolean column create a `<name>name` shadow beside themselves, as a Money column creates
// `<name>_base`; a Customer column creates three, a File column one, an Image column three and a rollup column two (see
// `companions` above). A column of such a name, put in the change set ahead of the one-by-one columns, would leave the owner —
// created later, and then meeting its own companion's name — refused with "already exists", which the build reads as a skip: the
// owner would vanish from the table without a word. The first four owners go in the change set themselves; the rest (a
// global-choice binding, Customer, File, Image, a rollup) are created by their own request, after it.
const SHADOW_OWNERS = [
  ['a Choice with options of its own', { schemaName: 'new_category', displayName: 'Category', type: 'Choice', options: ['A', 'B'] }, ['new_categoryname']],
  ['a Choice bound to a global option set', { schemaName: 'new_category', displayName: 'Category', type: 'Choice', globalChoice: 'new_cat' }, ['new_categoryname']],
  ['a MultiChoice', { schemaName: 'new_category', displayName: 'Category', type: 'MultiChoice', options: ['A', 'B'] }, ['new_categoryname']],
  ['a Boolean', { schemaName: 'new_category', displayName: 'Category', type: 'Boolean' }, ['new_categoryname']],
  ['a Customer', { schemaName: 'new_category', displayName: 'Category', type: 'Customer' }, ['new_categoryname', 'new_categoryyominame', 'new_categoryidtype']],
  ['a File', { schemaName: 'new_category', displayName: 'Category', type: 'File' }, ['new_category_name']],
  ['an Image', { schemaName: 'new_category', displayName: 'Category', type: 'Image' }, ['new_categoryid', 'new_category_timestamp', 'new_category_url']],
  ['a rollup column', { schemaName: 'new_category', displayName: 'Category', type: 'Integer', source: 'Rollup', formula: '<xml />' }, ['new_category_date', 'new_category_state']],
];
// The owners that go in the change set themselves.
const RIDES_IN_REQUEST = (owner) => ['Choice', 'MultiChoice', 'Boolean'].includes(owner.type) && !owner.globalChoice;
const withGlobalChoice = (spec) => ({ ...spec, globalChoices: [{ name: 'new_cat', options: ['A', 'B'] }] });
const textColumn = (schemaName) => ({ schemaName, displayName: schemaName, type: 'Text' });

test('a column named like what a Choice, MultiChoice, Boolean, Customer, File, Image or rollup column creates beside itself stays out of the change set — the owner is created, the other column is skipped as already existing', async (t) => {
  for (const [what, owner, shadows] of SHADOW_OWNERS) {
    await t.test(what, async () => {
      const spec = withGlobalChoice(oneTable([owner, ...shadows.map(textColumn), { schemaName: 'new_a', type: 'Text' }]));
      const run = await provisionOver(spec);
      const baseline = await provisionOver(spec, { inlineColumns: false });
      assert.deepStrictEqual(run.dv.refusals.filter((r) => r.path === '/$batch'), [], 'the platform refused no change set');
      assert.deepStrictEqual(run.warnings, [], 'no fallback was needed');
      assert.strictEqual(tablePosts(run).length, 1);
      const inline = inlineNames(run);
      for (const shadow of shadows) assert.ok(!inline.includes(shadow), `${shadow} is never in the change set`);
      assert.ok(run.result.columns.new_ticket.some((c) => c.schemaName === 'new_category'), 'the owning column is created');
      assert.deepStrictEqual(run.result.columns, baseline.result.columns, 'the same columns, with the same ids, as the one-by-one build');
      assert.deepStrictEqual(run.events, baseline.events, 'and the same steps');
      assert.deepStrictEqual(run.events.filter((e) => e.status === 'skip').map((e) => e.label), shadows.map((s) => `column new_ticket.${s} (Text) (exists)`));
    });
  }
});

test('a Choice bound to a global option set, then a Text column named like its shadow: the choice is created and the text column is skipped — as one by one', async () => {
  const spec = withGlobalChoice(oneTable([
    { schemaName: 'new_category', displayName: 'Category', type: 'Choice', globalChoice: 'new_cat' },
    { schemaName: 'new_categoryname', displayName: 'Category name', type: 'Text' },
  ]));
  const run = await provisionOver(spec);
  const baseline = await provisionOver(spec, { inlineColumns: false });
  assert.deepStrictEqual(baseline.result.columns.new_ticket.map((c) => c.schemaName), ['new_category'], 'one by one, the choice is created and the platform\'s own name is a skip');
  assert.deepStrictEqual(run.result.columns, baseline.result.columns);
  assert.deepStrictEqual(run.events, baseline.events);
  assert.deepStrictEqual(run.events.filter((e) => e.status === 'skip').map((e) => e.label), ['column new_ticket.new_categoryname (Text) (exists)']);
});

// One by one, the first column to name something creates it and the next is skipped as already existing, so where a twin is listed
// BEFORE the column that makes it as a companion, the twin is kept and the OWNER is the one skipped. The change set runs before
// every per-column create, so an owner in it would be made first and the twin skipped instead — the other column of the pair gone.
// An owner stays out of the change set when an earlier column holds one of its companion names, and is made in spec order.
test('a twin listed BEFORE an owner that goes in the change set keeps the owner out of it: the column listed first is kept, exactly as one by one', async (t) => {
  for (const [what, owner, shadows] of SHADOW_OWNERS.filter(([, o]) => RIDES_IN_REQUEST(o))) {
    await t.test(what, async () => {
      const spec = oneTable([...shadows.map(textColumn), owner, { schemaName: 'new_a', type: 'Text' }]);
      const run = await provisionOver(spec);
      const baseline = await provisionOver(spec, { inlineColumns: false });
      assert.deepStrictEqual(run.dv.refusals.filter((r) => r.path === '/$batch'), [], 'the platform refused no change set');
      assert.deepStrictEqual(run.warnings, []);
      assert.deepStrictEqual(inlineNames(run), ['new_a'], 'neither the twin nor its owner is in the change set');
      assert.deepStrictEqual(run.result.columns.new_ticket.map((c) => c.schemaName), [...shadows, 'new_a'], 'the twin is created; the owner, made after it, finds its shadow taken');
      assert.deepStrictEqual(run.events.filter((e) => e.status === 'skip').map((e) => e.label), [`column new_ticket.new_category (${owner.type}) (exists)`], 'and is the skip');
      assert.deepStrictEqual(run.result.columns, baseline.result.columns, 'the same columns, with the same ids, as the one-by-one build');
      assert.deepStrictEqual(run.events, baseline.events, 'and the same steps');
    });
  }
});

// The same, with the twin a column that has its own request — the shapes where the platform's answer to the owner is a skip.
test('a File, Image, Customer or Calculated column named like the companion of a Choice, Boolean, MultiChoice or Money column that follows it: the column listed first is kept, as one by one', async (t) => {
  for (const [what, twin, owner] of [
    ['a File before a Choice', { schemaName: 'new_categoryname', displayName: 'Category name', type: 'File' }, { schemaName: 'new_category', displayName: 'Category', type: 'Choice', options: ['A', 'B'] }],
    ['an Image before a Boolean', { schemaName: 'new_flagname', displayName: 'Flag name', type: 'Image' }, { schemaName: 'new_flag', displayName: 'Flag', type: 'Boolean' }],
    ['a Customer before a MultiChoice', { schemaName: 'new_tagsname', displayName: 'Tags name', type: 'Customer' }, { schemaName: 'new_tags', displayName: 'Tags', type: 'MultiChoice', options: ['A', 'B'] }],
    ['a Calculated Money before a Money', { schemaName: 'new_cost_base', displayName: 'Cost base', type: 'Money', source: 'Calculated', formula: '<xml />' }, { schemaName: 'new_cost', displayName: 'Cost', type: 'Money' }],
  ]) {
    await t.test(what, async () => {
      const spec = oneTable([twin, owner, textColumn('new_a')]);
      const run = await provisionOver(spec);
      const baseline = await provisionOver(spec, { inlineColumns: false });
      assert.deepStrictEqual(run.dv.refusals.filter((r) => r.path === '/$batch'), [], 'the platform refused no change set');
      assert.deepStrictEqual(run.warnings, []);
      assert.deepStrictEqual(inlineNames(run), ['new_a'], 'the owner is not in the change set');
      assert.deepStrictEqual(run.result.columns.new_ticket.map((c) => c.schemaName), [twin.schemaName, 'new_a'], 'the column listed first is created');
      assert.deepStrictEqual(run.events.filter((e) => e.status === 'skip').map((e) => e.label), [`column new_ticket.${owner.schemaName} (${owner.type}) (exists)`], 'and the owner is the skip');
      assert.deepStrictEqual(run.result.columns, baseline.result.columns, 'the same columns, with the same ids, as the one-by-one build');
      assert.deepStrictEqual(run.events, baseline.events, 'and the same steps');
    });
  }
});

// The platform may make more beside a column than the build lists, and the names are named after the column, so an earlier column
// whose name EXTENDS a column's name keeps that column out as well — whatever its type. The stub here makes a companion of its own,
// `<name>_receipt`, beside a column of the type under test, that no list in the build mentions.
test('a column stays out of the change set when an earlier column is named like something the platform makes beside it that nothing lists — whatever its type', async (t) => {
  for (const [what, owner, typePattern] of [
    ['a Money column', { schemaName: 'new_cost', displayName: 'Cost', type: 'Money' }, /MoneyAttributeMetadata$/],
    ['a DateTime column', { schemaName: 'new_cost', displayName: 'Cost', type: 'DateTime' }, /DateTimeAttributeMetadata$/],
    ['a Text column', { schemaName: 'new_cost', displayName: 'Cost', type: 'Text' }, /StringAttributeMetadata$/],
  ]) {
    await t.test(what, async () => {
      const unlisted = (body) => (typePattern.test(String(body['@odata.type'])) ? [`${String(body.SchemaName).toLowerCase()}_receipt`] : []);
      const spec = oneTable([
        { schemaName: 'new_cost_receipt', displayName: 'Receipt', type: 'File' },
        owner,
        textColumn('new_a'),
      ]);
      const run = await provisionOver(spec, { dataverse: { extraCompanions: unlisted } });
      const baseline = await provisionOver(spec, { inlineColumns: false, dataverse: { extraCompanions: unlisted } });
      assert.deepStrictEqual(run.dv.refusals.filter((r) => r.path === '/$batch'), [], 'the platform refused no change set');
      assert.deepStrictEqual(run.warnings, []);
      assert.ok(!inlineNames(run).includes('new_cost'), 'the column is made after the File column listed before it');
      assert.deepStrictEqual(run.result.columns.new_ticket.map((c) => c.schemaName), ['new_cost_receipt', 'new_a'], 'the File column listed first is kept');
      assert.deepStrictEqual(run.events.filter((e) => e.status === 'skip').map((e) => e.label), [`column new_ticket.new_cost (${owner.type}) (exists)`]);
      assert.deepStrictEqual(run.result.columns, baseline.result.columns);
      assert.deepStrictEqual(run.events, baseline.events);
    });
  }
});

// A column kept out of the change set by that rule is made by its own request like any other owner, so a LATER column whose name
// extends its own stays out too: made after it, that column finds what the platform made beside the owner and is skipped, as one by
// one. Here the platform makes `<name>_utc` beside a DateTime column — something nothing in the build lists — and `new_due_long` before
// `new_due` keeps the DateTime column out, so the `new_due_utc` that follows must stay out too: in the change set it would be created
// first and the DateTime column, made after it, would be refused as "already existing" and vanish from the table.
test('a column kept out of the change set because an earlier column extends its name keeps out a LATER column that extends its own — the owner is created, as one by one', async () => {
  const unlisted = (body) => (/DateTimeAttributeMetadata$/.test(String(body['@odata.type'])) ? [`${String(body.SchemaName).toLowerCase()}_utc`] : []);
  const spec = oneTable([textColumn('new_due_long'), { schemaName: 'new_due', displayName: 'Due', type: 'DateTime' }, textColumn('new_due_utc')]);
  const run = await provisionOver(spec, { dataverse: { extraCompanions: unlisted } });
  const baseline = await provisionOver(spec, { inlineColumns: false, dataverse: { extraCompanions: unlisted } });
  assert.deepStrictEqual(baseline.result.columns.new_ticket.map((c) => c.schemaName), ['new_due_long', 'new_due'], 'one by one the DateTime column is created and the Text column named like its companion is the skip');
  assert.deepStrictEqual(inlineNames(run), ['new_due_long'], 'only the first column goes in the change set: it is made before anything that extends its name');
  assert.deepStrictEqual(run.dv.refusals.filter((r) => r.path === '/$batch'), [], 'the platform refused no change set');
  assert.deepStrictEqual(run.warnings, []);
  assert.deepStrictEqual(run.events.filter((e) => e.status === 'skip').map((e) => e.label), ['column new_ticket.new_due_utc (Text) (exists)']);
  assert.deepStrictEqual(run.result.columns, baseline.result.columns, 'the same columns, with the same ids, as the one-by-one build');
  assert.deepStrictEqual(run.events, baseline.events, 'and the same steps');
  assert.deepStrictEqual([...run.dv.tables.get('new_ticket').columns.keys()].sort(), [...baseline.dv.tables.get('new_ticket').columns.keys()].sort());
});

// The cost of that rule is one request where an earlier column merely starts like a later one's name; the earlier column still goes
// in the change set, because it is made before the later one either way.
test('a column named like the start of an earlier column\'s name is made after it, by its own request — one request for it, and the earlier column still goes in the change set', async () => {
  const spec = oneTable([textColumn('new_title_long'), textColumn('new_title'), { schemaName: 'new_count_total', type: 'Integer' }, { schemaName: 'new_count', type: 'Integer' }, textColumn('new_other')]);
  const run = await provisionOver(spec);
  const baseline = await provisionOver(spec, { inlineColumns: false });
  assert.deepStrictEqual(inlineNames(run), ['new_title_long', 'new_count_total', 'new_other']);
  assert.deepStrictEqual(columnPosts(run).map((r) => r.body.SchemaName), ['new_title', 'new_count']);
  assert.deepStrictEqual(run.warnings, []);
  assert.deepStrictEqual(run.result.columns, baseline.result.columns, 'and the table has every column, with the same ids, as one by one');
  assert.deepStrictEqual(run.events, baseline.events);
  // In the usual order, the shorter name first, nothing is kept out.
  const usual = await provisionOver(oneTable([textColumn('new_title'), textColumn('new_title_long'), { schemaName: 'new_count', type: 'Integer' }, { schemaName: 'new_count_total', type: 'Integer' }]));
  assert.deepStrictEqual(inlineNames(usual), ['new_title', 'new_title_long', 'new_count', 'new_count_total']);
});

// A column made by its own request is made AFTER the change set, and where its twin is listed ahead of it the one-by-one
// build made the twin first and lost the owner. That order is the spec's, and is kept as it was: the twin stays out of the
// change set, so the build does exactly what it did one column at a time.
test('a twin listed BEFORE an owner that is created by its own request is made in spec order, exactly as one by one', async (t) => {
  for (const [what, owner, shadows] of SHADOW_OWNERS.filter(([, o]) => !RIDES_IN_REQUEST(o))) {
    await t.test(what, async () => {
      const spec = withGlobalChoice(oneTable([...shadows.map(textColumn), owner, { schemaName: 'new_a', type: 'Text' }]));
      const run = await provisionOver(spec);
      const baseline = await provisionOver(spec, { inlineColumns: false });
      assert.deepStrictEqual(run.dv.refusals.filter((r) => r.path === '/$batch'), [], 'the platform refused no change set');
      assert.deepStrictEqual(run.warnings, []);
      assert.deepStrictEqual(inlineNames(run), ['new_a'], 'only the column that cannot be a companion is in the change set');
      assert.deepStrictEqual(run.result.columns, baseline.result.columns, 'the same columns, with the same ids, as the one-by-one build');
      assert.deepStrictEqual(run.events, baseline.events, 'and the same steps');
    });
  }
});

// The build does not try to know every column the platform makes beside another: the names it makes are named after the column
// they extend, so ANY longer name stays out of the change set while its owner is made by its own request. This stub's
// File column makes a companion of its own, `<name>_receipt`, that no list in the build mentions.
test('a column whose name extends the name of a column made by its own request stays out of the change set — whatever the platform makes beside that column', async () => {
  const unlisted = (body) => (/FileAttributeMetadata$/.test(String(body['@odata.type'])) ? [`${String(body.SchemaName).toLowerCase()}_receipt`] : []);
  const spec = oneTable([
    { schemaName: 'new_contract', displayName: 'Contract', type: 'File' },
    textColumn('new_contract_receipt'),
    textColumn('new_a'),
  ]);
  const run = await provisionOver(spec, { dataverse: { extraCompanions: unlisted } });
  const baseline = await provisionOver(spec, { inlineColumns: false, dataverse: { extraCompanions: unlisted } });
  assert.deepStrictEqual(run.dv.refusals.filter((r) => r.path === '/$batch'), [], 'the platform refused no change set');
  assert.deepStrictEqual(run.warnings, []);
  assert.deepStrictEqual(inlineNames(run), ['new_a']);
  assert.ok(run.result.columns.new_ticket.some((c) => c.schemaName === 'new_contract'), 'the File column is created');
  assert.deepStrictEqual(run.result.columns, baseline.result.columns);
  assert.deepStrictEqual(run.events, baseline.events);
  assert.deepStrictEqual(run.events.filter((e) => e.status === 'skip').map((e) => e.label), ['column new_ticket.new_contract_receipt (Text) (exists)']);
});

test('only a LONGER name stays out for it: a column that shares the start of an owner\'s name rides in the change set when its name is the shorter, or does not start with it', async () => {
  const spec = oneTable([
    textColumn('new_attach'),
    { schemaName: 'new_attachment', displayName: 'Attachment', type: 'File' },
    textColumn('new_other'),
    textColumn('old_new_attachment'),
    textColumn('new_attachments'),
  ]);
  const run = await provisionOver(spec);
  const baseline = await provisionOver(spec, { inlineColumns: false });
  assert.deepStrictEqual(inlineNames(run), ['new_attach', 'new_other', 'old_new_attachment'], 'the shorter name, the unrelated one and one that only contains the owner\'s name go; the extension of the File column\'s name does not');
  assert.deepStrictEqual(run.warnings, []);
  assert.deepStrictEqual(run.result.columns, baseline.result.columns, 'and the table has every column, as one by one');
  assert.deepStrictEqual(run.events, baseline.events);
});

test('the names compare without regard to case: Dataverse lower-cases logical names, so a twin in any case spelling stays out', async () => {
  const spec = oneTable([
    { schemaName: 'New_Contract', displayName: 'Contract', type: 'File' },
    textColumn('NEW_CONTRACT_NAME'),
    textColumn('new_a'),
  ]);
  const run = await provisionOver(spec);
  const baseline = await provisionOver(spec, { inlineColumns: false });
  assert.deepStrictEqual(run.dv.refusals.filter((r) => r.path === '/$batch'), [], 'the platform refused no change set');
  assert.deepStrictEqual(inlineNames(run), ['new_a']);
  assert.ok(run.result.columns.new_ticket.some((c) => c.schemaName === 'New_Contract'), 'the File column is created');
  assert.deepStrictEqual(run.result.columns, baseline.result.columns);
  assert.deepStrictEqual(run.events, baseline.events);
});

// The change set — and every read and write that follows the table's create — addresses the table by its LOGICAL name: the lower-case
// form Dataverse keeps of the schema name the spec spells. A table whose schema name has capitals is where the two differ.
test('a table whose schema name has capitals is addressed by its lower-case logical name: the change set, the reads and the name column\'s length', async () => {
  const spec = {
    solution: { uniqueName: 'TableColumns', publisherPrefix: 'new' },
    relationships: [],
    entities: [{ schemaName: 'new_Ticket', displayName: 'Ticket', primaryAttribute: { schemaName: 'new_Name', displayName: 'Name', maxLength: 120 }, columns: [textColumn('new_a'), { schemaName: 'new_B', type: 'Integer' }] }],
  };
  const run = await provisionOver(spec);
  const baseline = await provisionOver(spec, { inlineColumns: false });
  assert.deepStrictEqual(run.warnings, []);
  assert.deepStrictEqual(batchPosts(run).map((r) => r.operations.map((o) => o.path)), [["/EntityDefinitions(LogicalName='new_ticket')/Attributes", "/EntityDefinitions(LogicalName='new_ticket')/Attributes"]], 'the change set targets new_ticket');
  assert.deepStrictEqual(inlineNames(run), ['new_a', 'new_B'], 'with the columns as the spec spells them');
  assert.strictEqual(run.dv.tables.get('new_ticket').primaryLength, 120, 'the length was read and set by logical names too');
  assert.deepStrictEqual(lengthEvents(run).map((e) => [e.status, e.label]), [['ok', 'primary column length new_Ticket.new_Name -> 120']]);
  assert.deepStrictEqual(run.result, baseline.result);
  assert.deepStrictEqual(run.events, baseline.events);
});

// The rules that decide which columns may go in the change set are a list of cases; this holds the build to the one-request-per-column
// build's answer over specs that mix every kind of column and every kind of name collision — a companion's name, an extension of a
// name, a repeat in another case — in any order: the table, its columns, their ids and the steps narrated must be the same whichever
// way the columns were made. A change set the platform refuses is accepted only where the stub makes a companion the build cannot
// know (`extraCompanions`), and the fallback then still gives that answer.
test('generated specs: the table, its columns, their ids and the steps are those of the per-column build, whatever the order and the names', async () => {
  let state = 20260501;
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 2 ** 32; };
  const pick = (list) => list[Math.floor(random() * list.length)];
  const STEMS = ['new_a', 'new_b', 'new_cat'];
  const SUFFIXES = ['', '', '', 'name', '_base', '_name', 'id', '_url', '_timestamp', 'yominame', 'idtype', '_date', '_state', '_x', 'NAME', '2'];
  const TYPES = [
    { type: 'Text' }, { type: 'Text' }, { type: 'Integer' }, { type: 'Memo' }, { type: 'Money' }, { type: 'Choice', options: ['A'] }, { type: 'Boolean' },
    { type: 'MultiChoice', options: ['A'] }, { type: 'DateTime' }, { type: 'File' }, { type: 'Image' }, { type: 'Customer' },
    { type: 'Integer', source: 'Calculated', formula: '<xml />' }, { type: 'Integer', source: 'Rollup', formula: '<xml />' },
    { type: 'Money', source: 'Calculated', formula: '<xml />' }, { type: 'Choice', globalChoice: 'new_gc' },
  ];
  // Beside a column of these types the stub's platform also makes `<name>_utc` or `<name>_x`, which nothing in the build lists.
  const UNLISTED = [undefined, undefined, [/MoneyAttributeMetadata$/, '_utc'], [/DateTimeAttributeMetadata$/, '_utc'], [/StringAttributeMetadata$/, '_x']];
  let withChangeSet = 0;
  for (let n = 0; n < 60; n += 1) {
    const columns = Array.from({ length: 2 + Math.floor(random() * 7) }, (_, i) => ({ ...pick(TYPES), schemaName: `${pick(STEMS)}${pick(SUFFIXES)}`, displayName: `c${i}` }));
    const unlisted = pick(UNLISTED);
    const dataverse = unlisted ? { extraCompanions: (body) => (unlisted[0].test(String(body['@odata.type'])) ? [`${String(body.SchemaName).toLowerCase()}${unlisted[1]}`] : []) } : {};
    const spec = { ...oneTable(columns), globalChoices: [{ name: 'new_gc', options: ['A', 'B'] }] };
    const label = `${unlisted ? `(platform also makes <name>${unlisted[1]} for ${unlisted[0]}) ` : ''}${columns.map((c) => `${c.schemaName}:${c.type}${c.source ? `:${c.source}` : ''}${c.globalChoice ? ':global' : ''}`).join(' ')}`;
    const baseline = await provisionOver(clone(spec), { inlineColumns: false, dataverse });
    const run = await provisionOver(clone(spec), { dataverse });
    assert.deepStrictEqual(run.result.columns, baseline.result.columns, label);
    assert.deepStrictEqual(run.events, baseline.events, label);
    assert.deepStrictEqual([...run.dv.tables.get('new_ticket').columns.keys()].sort(), [...baseline.dv.tables.get('new_ticket').columns.keys()].sort(), label);
    if (!unlisted) assert.deepStrictEqual(run.dv.refusals.filter((r) => r.path === '/$batch'), [], `${label}: the platform refused a change set the build could have foreseen`);
    if (batchPosts(run).length) withChangeSet += 1;
  }
  assert.ok(withChangeSet > 30, `most generated specs (${withChangeSet} of 60) have columns that go in a change set`);
});

test('a collision the change set could not foresee (a column named like a column the platform makes) is refused as a whole — the build falls back to one request per column, completes, and warns with the platform\'s own reason', async () => {
  const columns = [{ schemaName: 'createdon', displayName: 'Created', type: 'DateTime' }, { schemaName: 'new_a', type: 'Text' }];
  const spec = oneTable(columns);
  const run = await provisionOver(spec);
  const baseline = await provisionOver(spec, { inlineColumns: false });
  assert.strictEqual(tablePosts(run).length, 1, 'the table is created once, as ever');
  assert.strictEqual(batchPosts(run).length, 1, 'and the change set was sent once');
  const refusals = run.dv.refusals.filter((r) => r.path === '/$batch');
  assert.strictEqual(refusals.length, 1);
  assert.match(refusals[0].message, /^Attribute createdon already exists for entity new_ticket\.$/, 'the documented 0x80060304 answer');
  assert.strictEqual(run.dv.tables.get('new_ticket').columns.size, baseline.dv.tables.get('new_ticket').columns.size, 'and it created nothing: the refused change set was rolled back as a whole');
  assert.strictEqual(run.warnings.length, 1);
  assert.strictEqual(run.warnings[0], 'could not create the 2 ordinary column(s) of table new_ticket in one request (HTTP 400: Attribute createdon already exists for entity new_ticket.) — creating them one by one');
  assert.deepStrictEqual(run.result.columns, baseline.result.columns, 'then each column was created one by one — the platform\'s own `createdon` is a skip');
  assert.deepStrictEqual(run.events.filter((e) => e.status === 'skip').map((e) => e.label), ['column new_ticket.createdon (DateTime) (exists)']);
  assert.deepStrictEqual(run.events, baseline.events);
});

// --- a table that WAS created is never created again -------------------------------------------------

// The table is created exactly as it was, so what a failure of that create (or of the read the SDK makes of the new table
// afterwards) does is what it always did: the build stops. The re-run that follows finds the table and creates its columns.
test('a table created whose read-back then fails stops the build as it always did — no column is created — and the re-run completes the table one column at a time', async () => {
  const unreadable = () => ({ status: 500, headers: {}, body: { error: { message: 'An unexpected error occurred.' } } });
  const dv = fakeDataverse({ tableReadBack: unreadable });
  const sdk = await realSdk(dv.httpClient);
  const events = [];
  const base = { sdk, provision: sdk, spec: oneTable([{ schemaName: 'new_a', type: 'Text' }, { schemaName: 'new_b', type: 'Integer' }]), apply: true, preResolvedLanguageCode: 1033, provisionedLanguages: async () => [1033], sleep: async () => {}, warn: () => {} };
  await assert.rejects(provisionDataModel({ ...base, runner: makeRunner({ emit: (e) => events.push(e), total: 9 }) }), (err) => err instanceof BuildHalt && err.recoverable === true && /HTTP 500/.test(err.message));
  assert.strictEqual(dv.log.filter((r) => r.method === 'POST').length, 1, 'the table was created once, and nothing else was sent');
  // The read-back works again.
  const healthy = fakeDataverse();
  healthy.tables.set('new_ticket', dv.tables.get('new_ticket'));
  const rerunSdk = await realSdk(healthy.httpClient);
  const rerun = [];
  await provisionDataModel({ ...base, sdk: rerunSdk, provision: rerunSdk, runner: makeRunner({ emit: (e) => rerun.push(e), total: 9 }) });
  assert.strictEqual(healthy.log.filter((r) => r.method === 'POST' && r.path === '/EntityDefinitions').length, 0, 'the table is not created again');
  assert.strictEqual(healthy.log.filter((r) => r.method === 'POST' && r.path === '/$batch').length, 0, 'and a table that exists is given no change set');
  assert.deepStrictEqual(rerun.filter((e) => e.status === 'ok').map((e) => e.label), ['column new_ticket.new_a (Text)', 'column new_ticket.new_b (Integer)'], 'its columns are created one by one');
  assert.deepStrictEqual(rerun.filter((e) => e.status === 'skip').map((e) => e.label), ['table new_ticket (exists — reuse)']);
});

// The answer to the table's create can be lost although the table was made. The build then FINDS the table, as it always did,
// and — since nothing shows what the table holds, or that this build made it — gives it no change set: each column is created by
// its own request, where one that is already there is a skip.
test('a lost answer to the table\'s create (the table exists afterwards) is recovered as ever: no change set, each column created one by one, and no warning about columns created together', async () => {
  const lost = () => ({ status: 400, headers: {}, body: { error: { message: 'Entities already exist: new_ticket' } } });
  const baseline = await provisionOver(ticketSpec(), { inlineColumns: false, dataverse: { createCommitsThenFails: lost } });
  const run = await provisionOver(ticketSpec(), { dataverse: { createCommitsThenFails: lost } });
  assert.strictEqual(tablePosts(run).length, 2, 'one create per table, as ever');
  assert.deepStrictEqual(batchPosts(run), [], 'a table found after its create is given no change set');
  assert.deepStrictEqual(run.dv.log.filter((r) => /Attributes\?\$select=MetadataId,LogicalName/.test(r.path)), [], 'and its columns are not read back: none was created together');
  assert.strictEqual(columnPosts(run).length, columnPosts(baseline).length, 'every column is created by its own request');
  assert.deepStrictEqual(run.result, baseline.result);
  assert.deepStrictEqual(run.events, baseline.events);
  assert.deepStrictEqual(run.warnings, [], 'and nothing says that columns were created with the table');
});

test('TABLE_METADATA_NOT_VISIBLE (the table was created but cannot be read yet) is never answered with a second create', async () => {
  const { creates, warnings, error } = await notVisibleRun(oneTable([{ schemaName: 'new_a', type: 'Text' }]));
  assert.ok(error instanceof BuildHalt && /TABLE_METADATA_NOT_VISIBLE|WAS CREATED/.test(error.message) && error.recoverable === true);
  assert.strictEqual(creates.length, 1, 'the create is not repeated, whatever columns the spec has');
  assert.ok(!('columns' in creates[0]), 'and carries none');
  assert.deepStrictEqual(warnings, [], 'and with no length asked there is nothing more to say');
});

// The SDK's TABLE_METADATA_NOT_VISIBLE says the table WAS created and could not be read back, so the build stops. A table created with
// only its name column can come out with a name column of 850 characters whatever length the spec asks for, on some environments, and
// a re-run leaves an existing table's name column as it is — so the build says so before it stops.
async function notVisibleRun(spec) {
  const creates = [];
  const warnings = [];
  const notVisible = Object.assign(new Error('Table WAS CREATED but its metadata was still not readable. Do NOT re-run the create'), { code: 'TABLE_METADATA_NOT_VISIBLE' });
  const sdk = {
    createColumns: async () => { throw new Error('no change set is sent for a table that could not be read'); },
    createTable: async (o) => { creates.push(o); throw notVisible; },
    createColumn: async () => { throw new Error('no column is created for a table that could not be read'); },
  };
  const provision = { findTables: async () => [], findColumns: async () => [], dataverse: { get: async () => ({ status: 404, body: null }) } };
  const error = await provisionDataModel({ sdk, provision, runner: makeRunner({ emit: () => {}, total: 9 }), spec, apply: true, preResolvedLanguageCode: 1033, sleep: async () => {}, warn: (m) => warnings.push(m) })
    .then(() => null, (err) => err);
  return { creates, warnings, error };
}

test('TABLE_METADATA_NOT_VISIBLE out of the create, with a length asked, says the length may not have been applied on some environments — and the build still stops, once', async () => {
  const { creates, warnings, error } = await notVisibleRun(oneTable([], asksFor(120)));
  assert.ok(error instanceof BuildHalt && error.recoverable === true && /WAS CREATED/.test(error.message), 'the halt is the one it always was');
  assert.strictEqual(creates.length, 1);
  assert.strictEqual(warnings.length, 1);
  assert.strictEqual(warnings[0], 'table new_ticket was created, but its metadata could not be read back yet, so the build stops here — the spec asks for a primary name column length of 120, which may not have been applied (some environments make a name column created this way 850 characters long), and a re-run leaves an existing table\'s name column as it is: after the re-run, check new_name in Maker and set its length there if it matters');
  // Whatever columns the spec has, the table is created alone, so the warning is the same.
  const withColumns = await notVisibleRun(oneTable([{ schemaName: 'new_a', type: 'Text' }], asksFor(120)));
  assert.strictEqual(withColumns.creates.length, 1);
  assert.deepStrictEqual(withColumns.warnings, warnings);
  // Asking for the default length is asking: 100 is not what some environments make of it.
  const hundred = await notVisibleRun(oneTable([], asksFor(100)));
  assert.match(hundred.warnings[0], /length of 100, which may not have been applied/);
});

test('TABLE_METADATA_NOT_VISIBLE out of a create whose name column is auto-numbered, whose spec asks for no length, or whose length is the longest there is, makes no length warning', async () => {
  const numbered = await notVisibleRun(oneTable([], asksFor(120, { autoNumberFormat: 'WO-{SEQNUM:5}' })));
  assert.deepStrictEqual(numbered.warnings, [], 'the platform keeps the length asked of an auto-numbered name column');
  const none = await notVisibleRun(oneTable([], { schemaName: 'new_name', displayName: 'Name' }));
  assert.deepStrictEqual(none.warnings, []);
  const longest = await notVisibleRun(oneTable([], asksFor(850)));
  assert.deepStrictEqual(longest.warnings, [], 'a name column of 850 characters is what it comes out as either way');
  assert.ok(longest.error instanceof BuildHalt, 'the build still stops');
});

// The order of a new table's steps is the previous release's — the table, quick create, then the columns: the ordinary ones together
// in one change set, then those that take their own request, one by one in spec order. The name column's length, which the previous
// release never set, is the one step added to that order, and it comes LAST, after every labelled create of the phase (see the
// next tests).
//
// These order tests use doubles that record every write in order; they care what comes before what, not what is on the wire.
function orderDoubles({ failOn, existing = [] } = {}) {
  const calls = [];
  // Records a write, then refuses it when the test says so: the call was made, and failed.
  const record = (label) => { calls.push(label); if (failOn && failOn(label)) throw new Error(`refused: ${label}`); };
  const sdk = {
    createTable: async (o) => { record(`createTable ${o.schemaName}`); return { logicalName: o.schemaName.toLowerCase(), entitySetName: 'x', metadataId: tableId(o.schemaName) }; },
    updateTable: async (l, o) => { record(`updateTable ${l} ${JSON.stringify(o)}`); },
    updateColumn: async (l, c, o) => { record(`updateColumn ${l}.${c} ${JSON.stringify(o)}`); },
    createColumns: async (l, options) => { record(`createColumns ${l} ${options.map((c) => c.schemaName).join(',')}`); },
    createColumn: async (l, o) => { record(`createColumn ${l}.${o.schemaName}`); return { logicalName: o.schemaName.toLowerCase(), metadataId: attributeId(l, o.schemaName) }; },
    createCustomerColumn: async (l, o) => { record(`createCustomerColumn ${l}.${o.schemaName}`); return { logicalName: o.schemaName.toLowerCase(), metadataId: '' }; },
    insertStatusValue: async (l, o) => { record(`insertStatusValue ${l}: ${o.label}`); return o.value; },
    createAlternateKey: async (l, o) => { record(`createAlternateKey ${l}.${o.schemaName}`); },
    createRelationship: async (o) => { record(`createRelationship ${o.schemaName}`); return { schemaName: o.schemaName, metadataId: tableId(o.schemaName), lookupLogicalName: String(o.lookupSchemaName).toLowerCase() }; },
  };
  const provision = { findTables: async () => [], findColumns: async () => [], dataverse: { get: async (url) => {
    // The environment that ignores the length asked of a one-attribute create: every name column reads 850.
    if (/StringAttributeMetadata\?\$select=MaxLength$/.test(url)) return { status: 200, body: { MaxLength: 850 } };
    if (/Attributes\?\$select=MetadataId,LogicalName$/.test(url)) return { status: 200, body: { value: ['new_x', 'new_y'].map((n) => ({ LogicalName: n, MetadataId: attributeId('new_t', n) })) } };
    if (/Attributes\?\$select=LogicalName,RequiredLevel$/.test(url)) return { status: 200, body: { value: [] } };
    if (/Relationships\?\$select=/.test(url)) return { status: 200, body: { value: [] } };
    const table = /EntityDefinitions\(LogicalName='([^']+)'\)\?\$select=LogicalName,EntitySetName$/.exec(url);
    if (table && existing.includes(table[1])) return { status: 200, body: { LogicalName: table[1], EntitySetName: `${table[1]}s` } };
    return { status: 404, body: null };
  } } };
  return { calls, sdk, provision };
}
const runOrder = (doubles, spec, events = []) => provisionDataModel({
  sdk: doubles.sdk, provision: doubles.provision, runner: makeRunner({ emit: (e) => events.push(e), total: 99 }), spec, apply: true, preResolvedLanguageCode: 1033,
  provisionedLanguages: async () => [1033, 3082], sleep: async () => {}, warn: (m) => events.push({ warning: m }),
});

test('a new table\'s steps keep the previous release\'s order — table, quick create, the change set, then the columns that take their own request — and the name column length is set last', async () => {
  const { calls, sdk, provision } = orderDoubles();
  const spec = { solution: { uniqueName: 'S', publisherPrefix: 'new' }, relationships: [], entities: [
    { schemaName: 'new_t', displayName: 'T', quickCreate: true, primaryAttribute: { schemaName: 'new_n', maxLength: 120 }, columns: [{ schemaName: 'new_owner', type: 'Customer' }, textColumn('new_x'), { schemaName: 'new_file', type: 'File' }, { schemaName: 'new_y', type: 'Integer' }] },
  ] };
  await runOrder({ calls, sdk, provision }, spec);
  assert.deepStrictEqual(calls, [
    'createTable new_t',
    'updateTable new_t {"quickCreateEnabled":true}',
    'createColumns new_t new_x,new_y',
    'createCustomerColumn new_t.new_owner',
    'createColumn new_t.new_file',
    'updateColumn new_t.new_n {"maxLength":120}',
  ]);
});

// The length is set through the SDK's updateColumn, which starts by reading the column WITH its labels — and a label-bearing metadata
// read ahead of a labelled create is what makes Dataverse keep only the base-language label of what is created (measured live; see
// findExistingColumns). That read cannot be narrowed, so it goes where nothing labelled is created after it: once every table,
// column, status reason, alternate key and relationship of the phase exists, for every table the build created.
const TWO_TABLES_AND_A_RELATIONSHIP = () => ({
  solution: { uniqueName: 'S', publisherPrefix: 'new' },
  entities: [
    { schemaName: 'new_a', displayName: { 1033: 'A', 3082: 'A' }, pluralName: { 1033: 'As', 3082: 'As' }, quickCreate: true, primaryAttribute: { schemaName: 'new_n', maxLength: 120 }, columns: [textColumn('new_x'), { schemaName: 'new_file', type: 'File' }], statusReasons: [{ label: 'On hold', state: 'Active' }], alternateKeys: [{ schemaName: 'new_a_key', columns: ['new_x'] }] },
    { schemaName: 'new_b', displayName: 'B', primaryAttribute: { schemaName: 'new_m', maxLength: 90 }, columns: [textColumn('new_y')] },
    { schemaName: 'new_c', displayName: 'C', primaryAttribute: { schemaName: 'new_o' }, columns: [] },
  ],
  relationships: [{ type: 'OneToMany', referenced: 'new_a', referencing: 'new_b', schemaName: 'new_a_b', lookup: { schemaName: 'new_aid', displayName: { 1033: 'A', 3082: 'A' } } }],
});

test('the name column length of each table the build created is set after the LAST labelled create of the phase — every table, column, status reason, alternate key and relationship — in table order', async () => {
  const { calls, sdk, provision } = orderDoubles();
  await runOrder({ calls, sdk, provision }, TWO_TABLES_AND_A_RELATIONSHIP());
  assert.deepStrictEqual(calls, [
    'createTable new_a',
    'updateTable new_a {"quickCreateEnabled":true}',
    'createColumns new_a new_x',
    'createColumn new_a.new_file',
    'insertStatusValue new_a: On hold',
    'createAlternateKey new_a.new_a_key',
    'createTable new_b',
    'createColumns new_b new_y',
    'createTable new_c',
    'createRelationship new_a_b',
    'updateColumn new_a.new_n {"maxLength":120}',
    'updateColumn new_b.new_m {"maxLength":90}',
  ], 'the last step is the name column lengths; none is set for a table whose spec gives no length');
});

test('the length steps are narrated after the relationships, one for each table that asks for a length, and [n/total] ends on the last of them', async () => {
  const { calls, sdk, provision } = orderDoubles();
  const events = [];
  const spec = TWO_TABLES_AND_A_RELATIONSHIP();
  await runOrder({ calls, sdk, provision }, spec, events);
  const done = events.filter((e) => e.status && e.status !== 'start');
  assert.deepStrictEqual(done.slice(-3).map((e) => [e.status, e.label]), [
    ['ok', 'relationship 1:N new_a->new_b'],
    ['ok', 'primary column length new_a.new_n -> 120'],
    ['ok', 'primary column length new_b.new_m -> 90'],
  ]);
  const { planFor } = require('../lib/sdk-build.js');
  const planned = planFor(spec, { phases: ['data-model'] }).map((item) => item.label);
  assert.deepStrictEqual(planned.slice(-3), ['relationship 1:N new_a->new_b', 'primary column length new_a.new_n', 'primary column length new_b.new_m'], 'and the plan lists them where they are narrated');
});

// Two things end the data-model phase of the app build: the repair of a lookup column's default label (opt-in, `reconcileLookupLabels`), which is
// labelled work and so belongs to the steps, and the name column lengths, which come after the last labelled write of all, in the phase's `finally`.
// The plan lists them in the order the run takes them, so the counter the runner shows ends on its total instead of passing it.
test('the lookup label steps come before the name column length steps, in the run and in the plan, and [n/total] ends on the last length step', async () => {
  const { sdk, provision } = orderDoubles();
  const spec = TWO_TABLES_AND_A_RELATIONSHIP();
  // No `lookup.displayName`: the build owns this lookup's label, so it has a label step of its own.
  spec.relationships = [{ type: 'OneToMany', referenced: 'new_a', referencing: 'new_b', schemaName: 'new_a_b', lookup: { schemaName: 'new_aid' } }];
  const { planFor } = require('../lib/sdk-build.js');
  const planned = planFor(spec, { phases: ['data-model'] }).map((item) => item.label);
  const kinds = (labels) => labels.map((label) => (/^relationship /.test(label) ? 'relationship' : /^lookup label /.test(label) ? 'lookup label' : /^primary column length /.test(label) ? 'length' : 'other'))
    .filter((kind) => kind !== 'other');
  const events = [];
  await provisionDataModel({
    sdk, provision, runner: makeRunner({ emit: (e) => events.push(e), total: planned.length }), spec, apply: true, preResolvedLanguageCode: 1033,
    provisionedLanguages: async () => [1033, 3082], sleep: async () => {}, warn: (m) => events.push({ warning: m }), reconcileLookupLabels: true,
  });
  const done = events.filter((e) => e.status && e.status !== 'start');
  assert.deepStrictEqual(kinds(planned), ['relationship', 'lookup label', 'length', 'length'], 'the plan');
  assert.deepStrictEqual(kinds(done.map((e) => e.label)), ['relationship', 'lookup label', 'length', 'length'], `the run: ${JSON.stringify(done.map((e) => e.label))}`);
  assert.strictEqual(done.length, planned.length, 'the run narrates exactly the steps the plan lists');
  assert.strictEqual(done[done.length - 1].n, planned.length, '[n/total] ends on the last step');
  assert.ok(done.every((e) => e.n <= planned.length));
});

// A re-run finds the table and never touches an existing table's name column, so a table created by a run that halted would keep the
// length the environment made of its create for good. The lengths are therefore set in a `finally`, for the tables created before the
// halt, and the halt is the error the caller sees.
const FIRST_TABLE_CALLS = ['createTable new_a', 'updateTable new_a {"quickCreateEnabled":true}', 'createColumns new_a new_x', 'createColumn new_a.new_file', 'insertStatusValue new_a: On hold', 'createAlternateKey new_a.new_a_key'];
const SET_FIRST_LENGTH = 'updateColumn new_a.new_n {"maxLength":120}';
const SET_SECOND_LENGTH = 'updateColumn new_b.new_m {"maxLength":90}';

test('a phase that halts after creating tables still sets the name column lengths of the tables it created, and the halt is the error that is thrown', async (t) => {
  for (const [what, failOn, existing, expected] of [
    // The change set is refused too, so the second table's column is created by its own request, which fails.
    ['a column of the second table is refused', (call) => /^createColumns? new_b[ .]new_y$/.test(call), [], [
      ...FIRST_TABLE_CALLS, 'createTable new_b', 'createColumns new_b new_y', 'createColumn new_b.new_y', SET_FIRST_LENGTH, SET_SECOND_LENGTH,
    ]],
    ['a relationship is refused', (call) => call === 'createRelationship new_a_b', [], [
      ...FIRST_TABLE_CALLS, 'createTable new_b', 'createColumns new_b new_y', 'createTable new_c', 'createRelationship new_a_b', SET_FIRST_LENGTH, SET_SECOND_LENGTH,
    ]],
    ['the second table cannot be created: only the first one was', (call) => call === 'createTable new_b', [], [
      ...FIRST_TABLE_CALLS, 'createTable new_b', SET_FIRST_LENGTH,
    ]],
    // A table that existed before is never set, a halt or not: only the table this run created is.
    ['the first table already existed, and a column of the second is refused', (call) => /^createColumns? new_b[ .]new_y$/.test(call), ['new_a'], [
      'updateTable new_a {"quickCreateEnabled":true}', 'createColumn new_a.new_x', 'createColumn new_a.new_file', 'insertStatusValue new_a: On hold', 'createAlternateKey new_a.new_a_key',
      'createTable new_b', 'createColumns new_b new_y', 'createColumn new_b.new_y', SET_SECOND_LENGTH,
    ]],
  ]) {
    await t.test(what, async () => {
      const doubles = orderDoubles({ failOn, existing });
      const events = [];
      await assert.rejects(runOrder(doubles, TWO_TABLES_AND_A_RELATIONSHIP(), events), (err) => err instanceof BuildHalt && /^data-model failed: refused: /.test(err.message), 'the error that is thrown is the one that stopped the phase');
      assert.deepStrictEqual(doubles.calls, expected);
      const failed = events.filter((e) => e.status === 'error');
      assert.strictEqual(failed.length, 1, 'the one failed step is the one that stopped the phase');
      assert.ok(events.indexOf(failed[0]) < events.findIndex((e) => e.status === 'ok' && /^primary column length /.test(e.label)), 'and the length steps follow it');
      assert.deepStrictEqual(events.filter((e) => e.warning && /primary name column/.test(e.warning)), [], 'with nothing said about the lengths: they were set');
    });
  }
});

test('a length that cannot be set while the phase is halting is a failed, warned step of its own — and never replaces the error that stopped the phase', async () => {
  const doubles = orderDoubles({ failOn: (call) => call === 'createRelationship new_a_b' || call === SET_FIRST_LENGTH });
  const events = [];
  await assert.rejects(runOrder(doubles, TWO_TABLES_AND_A_RELATIONSHIP(), events), (err) => err instanceof BuildHalt && /^data-model failed: refused: createRelationship new_a_b$/.test(err.message));
  assert.deepStrictEqual(doubles.calls.slice(-2), [SET_FIRST_LENGTH, SET_SECOND_LENGTH], 'the second table is still set after the first one failed');
  assert.deepStrictEqual(events.filter((e) => e.status === 'error').map((e) => e.label), ['relationship 1:N new_a->new_b', 'primary column length new_a.new_n -> 120']);
  const warnings = events.filter((e) => e.warning).map((e) => e.warning);
  assert.strictEqual(warnings.length, 1, 'and the failed length is warned about');
  assert.match(warnings[0], /^could not set the length of the primary name column new_a\.new_n to 120 — it keeps the length the platform gave it, and because the data-model phase stopped, and a run that finds the table already there leaves its name column as it is, change the length in Maker if it matters: asked 120, the platform made 850: refused: updateColumn new_a\.new_n /, 'the warning does not promise that the build goes on: the phase stopped, and a run that finds the table there will not set the length');
});

// The build runs a phase that halts on a transient answer (a 429, a lock, a 503) again, against the same environment (build-model-app.js). The length is set at the end of
// the phase, in its `finally`, for a table THAT ATTEMPT created — so the attempt that created a table has set its length even though it halted, and the retry, which finds the
// table, keeps its name column as it finds it: one halt, one set. "Nothing labelled is created after the read that sets it" is therefore a claim about one attempt: the retry
// creates what the halt kept the first attempt from, after that attempt's read (alignPrimaryNameLength). This is run through the build's own retry loop.
test('after a transient halt that follows a sized table\'s create, the length is set exactly once — by the attempt that created the table — and the retry, which finds the table, does not set it again', async () => {
  const { buildModelApp } = require('../build-model-app.js');
  const spec = {
    app: { name: 'Ticket Desk' },
    solution: { uniqueName: 'TableColumns', publisherPrefix: 'new' },
    relationships: [],
    entities: [{
      schemaName: 'new_ticket', displayName: 'Ticket', primaryAttribute: { schemaName: 'new_name', displayName: 'Name', maxLength: 120 },
      columns: [textColumn('new_title'), { schemaName: 'new_attachment', displayName: 'Attachment', type: 'File', maxSizeKb: 1024 }],
    }],
  };
  const dv = fakeDataverse(OVERRIDING); // the environment that makes the name column 850 whatever length the create asks for
  // The File column's own request is answered 503 once: what a lock that outlasts the HTTP client's attempts looks like to the phase.
  const post = dv.httpClient.post;
  let refused = false;
  dv.httpClient.post = async (url, body, options) => {
    if (!refused && /\/Attributes$/.test(String(url)) && body && body.SchemaName === 'new_attachment') {
      refused = true;
      dv.log.push({ method: 'POST', path: `(503) ${String(url).replace(API, '')}`, body });
      return { status: 503, headers: {}, body: { error: { message: 'Service Unavailable' } } };
    }
    return post(url, body, options);
  };
  const sdk = await realSdk(dv.httpClient);
  const attempts = [];
  const events = [];
  const runBuild = async (builtSpec, options) => {
    const attempt = { number: attempts.length + 1, from: dv.log.length };
    attempts.push(attempt);
    try {
      await provisionDataModel({
        sdk: options.sdk, provision: options.provisionSdk, runner: makeRunner({ emit: (e) => events.push({ attempt: attempt.number, ...e }), total: 99 }), spec: builtSpec, apply: true,
        preResolvedLanguageCode: 1033, provisionedLanguages: async () => [1033, 3082], sleep: async () => {}, warn: () => {},
      });
    } finally {
      attempt.to = dv.log.length;
    }
    return { ok: true, created: {} };
  };
  const journal = [];
  const result = await buildModelApp(spec, { apply: true, env: ORG, retryDelayMs: 0 }, {
    sdk,
    provisionSdk: sdk,
    runBuild,
    journal: { path: 'x', record: (e) => journal.push(e), close: () => {} },
    discoverOpDiffState: async () => ({ collision: { appExists: false, solutionExists: false }, forms: [], sitemap: null }),
  });
  assert.strictEqual(result.ok, true, 'the retry completed the build');
  assert.strictEqual(journal.filter((e) => e.status === 'retry').length, 1, 'one transient halt, one retry');
  assert.strictEqual(attempts.length, 2);

  const requests = (attempt) => dv.log.slice(attempt.from, attempt.to);
  const isLengthWrite = (r) => r.method === 'PUT' && /\/Attributes\(/.test(r.path);
  assert.strictEqual(requests(attempts[0]).filter(isLengthWrite).length, 1, 'the attempt that created the table set the length of its name column, in its finally, after the halt');
  assert.strictEqual(requests(attempts[1]).filter(isLengthWrite).length, 0, 'the retry found the table and wrote nothing to its name column');
  assert.strictEqual(requests(attempts[1]).filter((r) => /StringAttributeMetadata/.test(r.path)).length, 0, 'nor read it');
  assert.strictEqual(dv.tables.get('new_ticket').primaryLength, 120, 'and the column has the length the spec asks for');
  const steps = (n) => events.filter((e) => e.attempt === n && e.status !== 'start' && /^primary column length /.test(e.label)).map((e) => `${e.status} ${e.label}`);
  assert.deepStrictEqual(steps(1), ['ok primary column length new_ticket.new_name -> 120']);
  assert.deepStrictEqual(steps(2), ['skip primary column length new_ticket.new_name (table exists — kept)']);

  // What the claim leaves out, and why it is made for one attempt: the retry creates the column the halt kept the first attempt from, AFTER that attempt's label-bearing read.
  const labelBearingRead = dv.log.findIndex((r) => r.method === 'GET' && /\/Attributes\([0-9a-f-]{36}\)\/Microsoft\.Dynamics\.CRM\.StringAttributeMetadata$/.test(r.path));
  assert.ok(labelBearingRead >= attempts[0].from && labelBearingRead < attempts[0].to, 'the label-bearing read is the first attempt\'s');
  assert.ok(dv.log.slice(labelBearingRead + 1).some((r) => r.method === 'POST' && r.body && r.body.SchemaName === 'new_attachment' && !/^\(503\)/.test(r.path)), 'and the retry still creates a column after it');
});

test('when the new columns cannot be read back, every one is created the per-column way (already-exists answers are skips) and the build says so', async () => {
  const unreadable = () => ({ status: 503, headers: {}, body: null });
  const run = await provisionOver(ticketSpec(), { dataverse: { attributeReads: unreadable } });
  assert.strictEqual(run.dv.attributeReadCount(), 6, 'three attempts per table');
  assert.strictEqual(columnPosts(run).filter((r) => r.body.SchemaName === 'new_title').length, 1, 'the column is asked for once more, one at a time');
  assert.strictEqual(run.events.filter((e) => e.status === 'skip' && /^column \w+\.\w+ \(.*\) \(exists\)$/.test(e.label)).length, ORDINARY.length + 3, 'every column of the change set is a skip: the platform already has it');
  assert.strictEqual(run.warnings.filter((w) => /could be read back/.test(w)).length, 2);
  assert.strictEqual(run.warnings[0], `${ORDINARY.length} column(s) were created in one request, but 0 could be read back — creating the other ${ORDINARY.length} one by one`);
});

test('a column list that lags the create is read again; one the platform silently left out is created by its own request', async () => {
  const lagging = (n, rows) => (n === 1 ? { status: 200, headers: {}, body: { value: rows.slice(0, 2) } } : undefined);
  const lagged = await provisionOver(ticketSpec(), { dataverse: { attributeReads: lagging } });
  const baseline = await provisionOver(ticketSpec(), { inlineColumns: false });
  assert.deepStrictEqual(lagged.result, baseline.result);
  assert.strictEqual(columnPosts(lagged).filter((r) => r.path.includes("'new_ticket'")).length, 2, 'the second read showed every column: only file and calculated by request');
  assert.deepStrictEqual(lagged.warnings, []);

  const dropped = await provisionOver(ticketSpec(), { dataverse: { dropInline: ['new_flag'] } });
  assert.deepStrictEqual(dropped.result, baseline.result, 'the left-out column is created and captured like any other');
  assert.ok(columnPosts(dropped).some((r) => r.body.SchemaName === 'new_flag'), 'created by its own request');
  assert.match(dropped.warnings.join('\n'), new RegExp(`${ORDINARY.length} column\\(s\\) were created in one request, but ${ORDINARY.length - 1} could be read back`));
});

// A confirmation belongs to the column that went in the change set, never to another column that shares its name: one by one a second
// column of the same name is skipped as already existing, and the narration and the result must say the same. A spec can name a
// column twice (validation accepts it); the first one goes in the change set and the second, a repeat, takes the per-column path.
test('a second column with exactly the name of one in the change set is skipped as already existing, and is never given the first one\'s id — whatever its type', async (t) => {
  for (const [what, second] of [
    ['an Integer', { schemaName: 'new_doc', displayName: 'Doc (number)', type: 'Integer' }],
    ['a File', { schemaName: 'new_doc', displayName: 'Doc (file)', type: 'File' }],
    ['a Customer', { schemaName: 'new_doc', displayName: 'Doc (customer)', type: 'Customer' }],
  ]) {
    await t.test(`a Text column, then ${what} of the same name`, async () => {
      const spec = oneTable([{ schemaName: 'new_doc', displayName: 'Doc', type: 'Text' }, second, textColumn('new_a')]);
      const run = await provisionOver(spec);
      const baseline = await provisionOver(spec, { inlineColumns: false });
      assert.deepStrictEqual(inlineNames(run), ['new_doc', 'new_a'], 'only the first goes in the change set');
      assert.deepStrictEqual(run.warnings, []);
      assert.deepStrictEqual(run.events.filter((e) => e.status === 'skip').map((e) => e.label), [`column new_ticket.new_doc (${second.type}) (exists)`], 'the second is skipped — it was not created, so it is not narrated as created');
      assert.deepStrictEqual(run.events.filter((e) => e.status === 'ok' && /new_doc/.test(e.label)).map((e) => e.label), ['column new_ticket.new_doc (Text)']);
      assert.deepStrictEqual(run.result.columns.new_ticket.map((c) => c.schemaName), ['new_doc', 'new_a'], 'and the column is listed once, with the first one\'s id');
      assert.deepStrictEqual(run.result.columns, baseline.result.columns, 'the same columns, with the same ids, as the one-by-one build');
      assert.deepStrictEqual(run.events, baseline.events, 'and the same steps');
    });
  }
});

// --- the primary name column ---------------------------------------------------------------------------

// The primary name attribute exactly as the table request posts it — the request the previous release sent. Its MaxLength is the
// one property the platform answers differently on different environments (see DEFAULT_PRIMARY_NAME_LENGTH): a table created with
// only this attribute came back with 850 characters although 100 was asked for on one environment, and with 100 on another. The
// previous release always asked for 100, so a spec that gives no length asks for 100 — written out here, whatever the SDK's own
// default becomes.
const primaryNameBody = (maxLength) => ({
  '@odata.type': 'Microsoft.Dynamics.CRM.StringAttributeMetadata',
  AttributeType: 'String',
  AttributeTypeName: { Value: 'StringType' },
  SchemaName: 'new_name',
  RequiredLevel: { Value: 'None', CanBeChanged: true, ManagedPropertyLogicalName: 'canmodifyrequirementlevelsettings' },
  MaxLength: maxLength,
  FormatName: { Value: 'Text' },
  DisplayName: { '@odata.type': 'Microsoft.Dynamics.CRM.Label', LocalizedLabels: [{ '@odata.type': 'Microsoft.Dynamics.CRM.LocalizedLabel', Label: 'Name', LanguageCode: 1033 }] },
  IsPrimaryName: true,
});

// The table request the previous release posts for `oneTable([...])`, recorded from its code: its own SDK's `createTable`, which it
// called without a length for the name column and so got the SDK's default, 100. Written out in full, key order included, so that
// nothing in it is derived from the code under test; the A/B test below runs the previous release itself wherever one is at hand.
const RELEASED_TABLE_REQUEST = {
  '@odata.type': 'Microsoft.Dynamics.CRM.EntityMetadata',
  SchemaName: 'new_ticket',
  DisplayName: { '@odata.type': 'Microsoft.Dynamics.CRM.Label', LocalizedLabels: [{ '@odata.type': 'Microsoft.Dynamics.CRM.LocalizedLabel', Label: 'Ticket', LanguageCode: 1033 }] },
  DisplayCollectionName: { '@odata.type': 'Microsoft.Dynamics.CRM.Label', LocalizedLabels: [{ '@odata.type': 'Microsoft.Dynamics.CRM.LocalizedLabel', Label: 'Tickets', LanguageCode: 1033 }] },
  OwnershipType: 'UserOwned',
  IsActivity: false,
  HasActivities: false,
  HasNotes: false,
  Attributes: [{
    '@odata.type': 'Microsoft.Dynamics.CRM.StringAttributeMetadata',
    AttributeType: 'String',
    AttributeTypeName: { Value: 'StringType' },
    SchemaName: 'new_name',
    RequiredLevel: { Value: 'None', CanBeChanged: true, ManagedPropertyLogicalName: 'canmodifyrequirementlevelsettings' },
    MaxLength: 100,
    FormatName: { Value: 'Text' },
    DisplayName: { '@odata.type': 'Microsoft.Dynamics.CRM.Label', LocalizedLabels: [{ '@odata.type': 'Microsoft.Dynamics.CRM.LocalizedLabel', Label: 'Name', LanguageCode: 1033 }] },
    IsPrimaryName: true,
  }],
};

test('a spec that gives no primary name length posts the previous release\'s table request, byte for byte — with columns or without, on either behaviour of the platform', async () => {
  for (const [model, dataverse] of [['an environment that keeps the length asked', HONOURING], ['an environment that ignores it for a table created alone', OVERRIDING]]) {
    for (const [what, columns] of [
      ['no columns', []],
      ['ordinary columns', [textColumn('new_a'), { schemaName: 'new_b', type: 'Memo' }]],
      ['only columns that take their own request', [{ schemaName: 'new_owner', type: 'Customer' }]],
    ]) {
      const run = await provisionOver(oneTable(columns), { dataverse });
      assert.strictEqual(tablePosts(run).length, 1, `${model}, ${what}`);
      assert.strictEqual(JSON.stringify(tablePosts(run)[0].body), JSON.stringify(RELEASED_TABLE_REQUEST), `${model}, ${what}: the same bytes`);
    }
  }
  // For a table with no columns the whole conversation is the previous release's: its probe, its create and the read of the new
  // table, and nothing more.
  const plain = await provisionOver(oneTable([]));
  assert.deepStrictEqual(plain.dv.log.map(requestLine), [
    "GET /EntityDefinitions(LogicalName='new_ticket')?$select=LogicalName,EntitySetName",
    'POST /EntityDefinitions',
    `GET /EntityDefinitions(${tableId('new_ticket')})?$select=LogicalName,EntitySetName,PrimaryIdAttribute,PrimaryNameAttribute`,
  ]);
});

// The previous release is the oracle for "what was sent": its own code and its own SDK bundle, run over the same stub. It lives
// outside this repository, so this runs where MODEL_APPS_RELEASED_SCRIPTS names the `scripts` directory of a checkout of it, and is
// skipped elsewhere (the recorded request above stands in for it there).
const RELEASED_SCRIPTS = process.env.MODEL_APPS_RELEASED_SCRIPTS;
const SKIP_A_B = 'set MODEL_APPS_RELEASED_SCRIPTS to the scripts directory of the previous release to compare with it';

async function releasedRun(spec, dataverse) {
  const released = require(path.join(RELEASED_SCRIPTS, 'lib', 'entity-provision.js'));
  const dv = fakeDataverse(dataverse);
  const sdk = await realSdk(dv.httpClient, { bundle: path.join(RELEASED_SCRIPTS, 'vendor', 'cds-maker-sdk.cjs') });
  const events = [];
  const warnings = [];
  const result = await released.provisionDataModel({
    sdk, provision: sdk, runner: released.makeRunner({ emit: (event) => events.push(event), total: 99 }), spec: clone(spec), apply: true, preResolvedLanguageCode: 1033,
    provisionedLanguages: async () => [1033, 3082], sleep: async () => {}, warn: (m) => warnings.push(m),
  });
  return { result, events, warnings, dv };
}

test('A/B with the previous release: the table request and every column body a spec gets are what the released code posts, and the table ends up the same, on either behaviour of the platform', { skip: !RELEASED_SCRIPTS && SKIP_A_B }, async () => {
  const localized = {
    solution: { uniqueName: 'TableColumns', publisherPrefix: 'new' },
    relationships: [],
    entities: [{
      schemaName: 'new_ticket', displayName: { 1033: 'Ticket', 3082: 'Entrada' }, pluralName: { 1033: 'Tickets', 3082: 'Entradas' }, description: 'Support tickets', hasNotes: true,
      primaryAttribute: { schemaName: 'new_name', displayName: { 1033: 'Name', 3082: 'Nombre' } }, columns: [textColumn('new_a')],
    }],
  };
  const numbered = { schemaName: 'new_name', displayName: 'Name', autoNumberFormat: 'WO-{SEQNUM:5}' };
  const specs = [
    ['a table with no columns', oneTable([])],
    ['a table with ordinary columns of every type and the columns that take their own request', ticketSpec()],
    ['an auto-numbered name column, with and without columns', oneTable([textColumn('new_a'), { schemaName: 'new_b', type: 'Integer' }], numbered)],
    ['an auto-numbered name column and no columns', oneTable([], numbered)],
    ['a localized table with a description and notes', localized],
  ];
  const bodiesBySchemaName = (run) => new Map([
    ...columnPosts(run).map((r) => [r.body.SchemaName, JSON.stringify(r.body)]),
    ...batchColumns(run).map((body) => [body.SchemaName, JSON.stringify(body)]),
  ]);
  for (const [what, spec] of specs) {
    for (const [model, dataverse] of [['honouring', HONOURING], ['overriding', OVERRIDING]]) {
      const old = await releasedRun(spec, dataverse);
      const now = await provisionOver(clone(spec), { dataverse });
      const label = `${what}, ${model}`;
      assert.deepStrictEqual(tablePosts(now).map((r) => JSON.stringify(r.body)), tablePosts(old).map((r) => JSON.stringify(r.body)), `${label}: the table requests are the same bytes`);
      assert.deepStrictEqual([...bodiesBySchemaName(now)].sort(), [...bodiesBySchemaName(old)].sort(), `${label}: every column is the same body, whether the released code posted it by itself or this build put it in the change set`);
      assert.deepStrictEqual(posts(now).filter((r) => r.path === '/CreateCustomerRelationships').map((r) => JSON.stringify(r.body)), posts(old).filter((r) => r.path === '/CreateCustomerRelationships').map((r) => JSON.stringify(r.body)), `${label}: the Customer actions`);
      // `lookupLabels` is the one field of the result that is new since the previous release: the label each lookup column carries once the data model is done, which a later phase repairs forms from.
      const { lookupLabels, ...nowResult } = now.result;
      assert.ok(lookupLabels && typeof lookupLabels === 'object', `${label}: the result carries the lookup labels`);
      assert.deepStrictEqual(nowResult, old.result, `${label}: the same result`);
      assert.deepStrictEqual(now.events, old.events, `${label}: the same steps`);
      assert.deepStrictEqual(now.warnings, old.warnings, `${label}: and no warning the released code did not give`);
      for (const [name, table] of old.dv.tables) {
        assert.strictEqual(now.dv.tables.get(name).primaryLength, table.primaryLength, `${label}: ${name}'s name column ends up the length the released code gave it`);
        assert.deepStrictEqual([...now.dv.tables.get(name).columns.keys()].sort(), [...table.columns.keys()].sort(), `${label}: ${name} has the same columns`);
      }
      if (!spec.entities[0].columns.length) assert.deepStrictEqual(now.dv.log, old.dv.log, `${label}: for a table with no columns, every request is the released code's`);
    }
  }
});

// What the platform makes of a primary name column's length is one of two things (see DEFAULT_PRIMARY_NAME_LENGTH), and the build
// reaches a table by one of several routes; the length asked of the create, and what the column ends up as, are checked on every
// route under both. `asked` is the spec's length (undefined: none).
const lostCreateAnswer = () => ({ status: 400, headers: {}, body: { error: { message: 'Entities already exist: new_ticket' } } });
const refusedChangeSet = () => ({ status: 400, headers: {}, body: '{"error":{"message":"refused"}}' });
const CREATE_ROUTES = [
  ['a table with no columns', [], {}, { aligned: true, changeSets: 0 }],
  ['a table whose ordinary columns follow in one change set', [textColumn('new_a'), { schemaName: 'new_b', type: 'Integer' }], {}, { aligned: true, changeSets: 1 }],
  ['a table whose only columns take their own request', [{ schemaName: 'new_owner', type: 'Customer' }], {}, { aligned: true, changeSets: 0 }],
  ['a table whose change set the platform refuses, then one request per column', [textColumn('new_a')], { batchFails: refusedChangeSet }, { aligned: true, changeSets: 1 }],
  ['a table found after the answer to its create was lost', [textColumn('new_a')], { createCommitsThenFails: lostCreateAnswer }, { aligned: false, changeSets: 0 }],
];

test('every route that creates a table asks the previous release\'s length for the name column — 100 unless the spec gives one — and ends with it where the environment keeps it, and with what the previous release got where it does not', async (t) => {
  for (const [route, columns, faults, { aligned, changeSets }] of CREATE_ROUTES) {
    for (const [model, behaviour, keeps] of [['honouring', HONOURING, true], ['overriding', OVERRIDING, false]]) {
      for (const [kind, numbering] of [['a plain name column', {}], ['an auto-numbered name column', { autoNumberFormat: 'WO-{SEQNUM:5}' }]]) {
        for (const asked of [undefined, 120]) {
          await t.test(`${route}; ${model} environment; ${kind}; ${asked === undefined ? 'no length given' : `length ${asked}`}`, async () => {
            const primaryAttribute = { schemaName: 'new_name', displayName: 'Name', ...numbering, ...(asked === undefined ? {} : { maxLength: asked }) };
            const run = await provisionOver(oneTable(columns, primaryAttribute), { dataverse: { ...behaviour, ...faults } });
            // The request: the previous release's — one attribute, asking for the length the spec gave or else 100.
            assert.strictEqual(tablePosts(run).length, 1);
            assert.deepStrictEqual(tablePosts(run)[0].body.Attributes, [{ ...primaryNameBody(asked === undefined ? 100 : asked), ...(numbering.autoNumberFormat ? { AutoNumberFormat: numbering.autoNumberFormat } : {}) }]);
            assert.strictEqual(batchPosts(run).length, changeSets, 'and the change sets this route sends');
            // What the column ends up as. An environment that ignores the length asked of a plain name column made 850 of it; the
            // build then sets the length the spec gave (where it made the table), and leaves a default alone — as the previous release did.
            const table = run.dv.tables.get('new_ticket');
            const keptByPlatform = keeps || Boolean(numbering.autoNumberFormat);
            const wanted = asked === undefined ? 100 : asked;
            const expectedLength = keptByPlatform ? wanted : (asked !== undefined && aligned ? asked : 850);
            assert.strictEqual(table.primaryLength, expectedLength, 'the length the name column ends up as');
            if (asked === undefined) {
              assert.deepStrictEqual(lengthReads(run), [], 'a default is not read back');
              assert.deepStrictEqual(puts(run), [], 'or set');
              assert.deepStrictEqual(lengthEvents(run), [], 'and has no step');
            } else {
              assert.strictEqual(lengthReads(run).length, 1, 'a length the spec gave is read back once');
              assert.strictEqual(puts(run).length, keptByPlatform || !aligned ? 0 : 1, 'and set only where the environment did not keep it, on a table this build made');
              assert.strictEqual(lengthEvents(run).length, 1, 'with one narrated step');
            }
          });
        }
      }
    }
  }
});

test('primaryAttribute.maxLength is the length the table request asks for, whatever columns follow', async () => {
  const primaryAttribute = { schemaName: 'new_name', displayName: 'Name', maxLength: 120 };
  const withColumns = await provisionOver(oneTable([{ schemaName: 'new_a', type: 'Text' }], primaryAttribute));
  const plain = await provisionOver(oneTable([], primaryAttribute));
  assert.deepStrictEqual(tablePosts(withColumns)[0].body.Attributes, [primaryNameBody(120)]);
  assert.deepStrictEqual(tablePosts(plain)[0].body.Attributes, [primaryNameBody(120)]);
  for (const length of [1, 850]) {
    const run = await provisionOver(oneTable([], { ...primaryAttribute, maxLength: length }));
    assert.strictEqual(tablePosts(run)[0].body.Attributes[0].MaxLength, length);
  }
});

test('a rebuild never changes the length of a primary name column that already exists, whatever primaryAttribute.maxLength says', async () => {
  // The table is built with the default 100-character name column; the spec then asks for 120. A rebuild that converged the
  // length would have to write it (a PUT of the column), and might shorten a column that holds data — so it writes nothing,
  // and reads nothing either: there is nothing to compare.
  const columns = [{ schemaName: 'new_a', type: 'Text' }];
  const dv = fakeDataverse(HONOURING);
  const sdk = await realSdk(dv.httpClient);
  const make = (events) => makeRunner({ emit: (event) => events.push(event), total: 99 });
  const options = { sdk, provision: sdk, apply: true, preResolvedLanguageCode: 1033, provisionedLanguages: async () => [1033], sleep: async () => {}, warn: () => {} };
  await provisionDataModel({ ...options, runner: make([]), spec: oneTable(columns) });
  assert.strictEqual(tablePosts({ dv })[0].body.Attributes[0].MaxLength, 100);
  const afterFirst = dv.log.length;
  const events = [];
  // A table or column create would be a POST, and the update of the column a PUT.
  await provisionDataModel({ ...options, runner: make(events), spec: oneTable(columns, { schemaName: 'new_name', displayName: 'Name', maxLength: 120 }) });
  const rebuild = dv.log.slice(afterFirst);
  assert.strictEqual(rebuild.filter((r) => r.method !== 'GET').length, 0, 'the rebuild writes nothing: no table, column or length is touched');
  assert.ok(!rebuild.some((r) => /\/Attributes\(/.test(r.path)), 'and it does not read the column either: nothing is compared with the spec\'s length');
  assert.deepStrictEqual(
    events.filter((e) => e.status !== 'start' && /^primary column length /.test(e.label)).map((e) => [e.status, e.label]),
    [['skip', 'primary column length new_ticket.new_name (table exists — kept)']],
    'one narrated step, a skip that says why',
  );
  assert.strictEqual(dv.tables.get('new_ticket').primaryLength, 100, 'the column keeps its length');
});

// --- the length the spec asks for -------------------------------------------------------------------------------
// The table is created with a request that carries nothing but its primary name attribute, and some environments ignore the length
// asked of a plain text name column in such a request (see DEFAULT_PRIMARY_NAME_LENGTH). So for a table THIS build creates, the
// length a spec gives is read back — one typed request — and updated only when it is not the one the spec asked for, once the
// phase's labelled creates are done. The stub's default makes the same distinction, so a build that sent the length and stopped would
// end with 850 where the spec said 120.

const asksFor = (maxLength, extra = {}) => ({ schemaName: 'new_name', displayName: 'Name', maxLength, ...extra });
const requestLine = (r) => `${r.method} ${r.path}`;
const NAME_LENGTH_READ = "GET /EntityDefinitions(LogicalName='new_ticket')/Attributes(LogicalName='new_name')/Microsoft.Dynamics.CRM.StringAttributeMetadata?$select=MaxLength";

test('a table created with only its primary name column ends up with the length the spec asks for: read back after the create, then updated', async () => {
  const run = await provisionOver(oneTable([], asksFor(120)));
  assert.deepStrictEqual(tablePosts(run).map((r) => r.body.Attributes), [[primaryNameBody(120)]], 'the request asks for 120 — and the environment makes 850 of it');
  assert.strictEqual(run.dv.tables.get('new_ticket').primaryLength, 120, 'so the column is updated, and ends up 120');
  const id = attributeId('new_ticket', 'new_name');
  assert.deepStrictEqual(run.dv.log.map(requestLine), [
    "GET /EntityDefinitions(LogicalName='new_ticket')?$select=LogicalName,EntitySetName",
    'POST /EntityDefinitions',
    `GET /EntityDefinitions(${tableId('new_ticket')})?$select=LogicalName,EntitySetName,PrimaryIdAttribute,PrimaryNameAttribute`,
    NAME_LENGTH_READ,
    "GET /EntityDefinitions(LogicalName='new_ticket')/Attributes(LogicalName='new_name')?$select=MetadataId,AttributeType",
    `GET /EntityDefinitions(LogicalName='new_ticket')/Attributes(${id})/Microsoft.Dynamics.CRM.StringAttributeMetadata`,
    `PUT /EntityDefinitions(LogicalName='new_ticket')/Attributes(${id})`,
  ], 'the table\'s existence probe, its create and read-back, then the length: one typed read and the update of the column');
  const [update] = puts(run);
  assert.strictEqual(update.body.MaxLength, 120);
  assert.strictEqual(update.headers['MSCRM.MergeLabels'], 'true', 'the update keeps the labels already stored, as the documented update of a column does');
  assert.deepStrictEqual(run.events.filter((e) => e.status !== 'start').map((e) => [e.status, e.label]), [
    ['ok', 'table new_ticket'],
    ['ok', 'primary column length new_ticket.new_name -> 120'],
  ]);
  assert.deepStrictEqual(run.warnings, []);
});

test('a name column the environment already made the length asked needs no update: the read-back is compared, and the step is a skip', async () => {
  const run = await provisionOver(oneTable([], asksFor(120)), { dataverse: HONOURING });
  assert.strictEqual(lengthReads(run).length, 1, 'read once');
  assert.deepStrictEqual(puts(run), [], 'and not written: it is already 120');
  assert.deepStrictEqual(lengthEvents(run).map((e) => [e.status, e.label]), [['skip', 'primary column length new_ticket.new_name (already 120)']]);
  assert.strictEqual(run.dv.tables.get('new_ticket').primaryLength, 120);
});

// The length is set when the phase's labelled creates are done (the next tests, and the order tests above): after the change set and its
// read-back, and after the columns that take their own request.
test('a table that gets ordinary columns is aligned like any other, once its columns exist: the change set, its read-back and the columns made one by one come first, then the length is read back and set', async () => {
  const run = await provisionOver(oneTable([textColumn('new_a'), { schemaName: 'new_b', type: 'Integer' }, { schemaName: 'new_file', type: 'File' }, { schemaName: 'new_owner', type: 'Customer' }], asksFor(120)));
  const id = attributeId('new_ticket', 'new_name');
  assert.deepStrictEqual(tablePosts(run).map((r) => r.body.Attributes), [[primaryNameBody(120)]], 'the create carries only the name column');
  assert.deepStrictEqual(run.dv.log.map(requestLine), [
    "GET /EntityDefinitions(LogicalName='new_ticket')?$select=LogicalName,EntitySetName",
    'POST /EntityDefinitions',
    `GET /EntityDefinitions(${tableId('new_ticket')})?$select=LogicalName,EntitySetName,PrimaryIdAttribute,PrimaryNameAttribute`,
    'POST /$batch',
    `GET /EntityDefinitions(${tableId('new_ticket')})/Attributes?$select=MetadataId,LogicalName`,
    "POST /EntityDefinitions(LogicalName='new_ticket')/Attributes",
    'POST /CreateCustomerRelationships',
    NAME_LENGTH_READ,
    "GET /EntityDefinitions(LogicalName='new_ticket')/Attributes(LogicalName='new_name')?$select=MetadataId,AttributeType",
    `GET /EntityDefinitions(LogicalName='new_ticket')/Attributes(${id})/Microsoft.Dynamics.CRM.StringAttributeMetadata`,
    `PUT /EntityDefinitions(LogicalName='new_ticket')/Attributes(${id})`,
  ], 'the table, its columns in one change set and one read of them, the File and Customer columns, and last the name column\'s length: no labelled create follows the read that carries labels');
  assert.deepStrictEqual(inlineNames(run), ['new_a', 'new_b']);
  assert.strictEqual(run.dv.tables.get('new_ticket').primaryLength, 120);
  assert.deepStrictEqual(lengthEvents(run).map((e) => [e.status, e.label]), [['ok', 'primary column length new_ticket.new_name -> 120']]);
  assert.deepStrictEqual(run.warnings, []);
});

test('an auto-numbered name column: the length asked is read back after the create, and left alone when the environment kept it', async () => {
  const run = await provisionOver(oneTable([], asksFor(120, { autoNumberFormat: 'WO-{SEQNUM:5}' })));
  assert.deepStrictEqual(tablePosts(run)[0].body.Attributes, [{ ...primaryNameBody(120), AutoNumberFormat: 'WO-{SEQNUM:5}' }]);
  assert.strictEqual(lengthReads(run).length, 1, 'read back');
  assert.deepStrictEqual(puts(run), [], 'and not updated: the platform keeps the length asked of an auto-numbered column');
  assert.deepStrictEqual(lengthEvents(run).map((e) => [e.status, e.label]), [['skip', 'primary column length new_ticket.new_name (already 120)']]);
});

test('a change set the platform refuses leaves the length alone: the columns are then created one by one, and the length is set after them', async () => {
  const run = await provisionOver(oneTable([{ schemaName: 'new_a', type: 'Text' }], asksFor(120)), { dataverse: { batchFails: refusedChangeSet } });
  assert.deepStrictEqual(tablePosts(run).map((r) => [r.body.Attributes.length, r.body.Attributes[0].MaxLength]), [[1, 120]], 'one create, asking for 120');
  assert.strictEqual(run.dv.refusals.length, 1);
  assert.strictEqual(lengthReads(run).length, 1);
  assert.strictEqual(puts(run).length, 1);
  const lines = run.dv.log.map(requestLine);
  assert.ok(lines.lastIndexOf("POST /EntityDefinitions(LogicalName='new_ticket')/Attributes") < lines.indexOf(requestLine(lengthReads(run)[0])), 'the column made by its own request comes before the read of the length');
  assert.strictEqual(run.dv.tables.get('new_ticket').primaryLength, 120);
  assert.deepStrictEqual(lengthEvents(run).map((e) => [e.status, e.label]), [['ok', 'primary column length new_ticket.new_name -> 120']]);
  assert.strictEqual(run.warnings.length, 1, 'only the warning that the columns are created one by one');
  assert.match(run.warnings[0], /^could not create the 1 ordinary column\(s\) of table new_ticket in one request \(HTTP 400: refused\)/);
  assert.ok(run.result.columns.new_ticket.some((c) => c.schemaName === 'new_a'), 'and the column was created');
});

test('a table a create with only its primary name column made, whose length is not the one asked, is read again while the new column is not yet visible', async () => {
  const notYet = () => ({ status: 404, headers: {}, body: { error: { message: 'Could not find an attribute with LogicalName new_name' } } });
  const run = await provisionOver(oneTable([], asksFor(120)), { dataverse: { lengthRead: (n) => (n <= 2 ? notYet() : undefined) } });
  assert.strictEqual(lengthReads(run).length, 3, 'a 404 is asked again, twice');
  assert.strictEqual(puts(run).length, 1);
  assert.strictEqual(run.dv.tables.get('new_ticket').primaryLength, 120);
  assert.deepStrictEqual(run.warnings, []);
});

test('a failed update of the length is a FAILED step that names the table, the length asked and the one the platform made — and a warning; the build goes on', async () => {
  const refuse = () => ({ status: 400, headers: {}, body: { error: { message: 'The attribute cannot be changed right now' } } });
  const run = await provisionOver(oneTable([{ schemaName: 'new_owner', type: 'Customer' }], asksFor(120)), { dataverse: { updateFails: refuse } });
  assert.strictEqual(tablePosts(run)[0].body.Attributes.length, 1, 'a table whose only column takes the one-by-one path is created with only its primary name column');
  const failed = run.events.filter((e) => e.status === 'error');
  assert.strictEqual(failed.length, 1);
  assert.strictEqual(failed[0].label, 'primary column length new_ticket.new_name -> 120', 'the table, and the length asked');
  assert.match(failed[0].detail, /^asked 120, the platform made 850: .*The attribute cannot be changed right now/, 'the length the platform made, and why the update failed');
  assert.strictEqual(run.warnings.length, 1);
  assert.match(run.warnings[0], /^could not set the length of the primary name column new_ticket\.new_name to 120 .* the rest of the build continues: asked 120, the platform made 850: /);
  assert.strictEqual(run.dv.tables.get('new_ticket').primaryLength, 850, 'the column keeps the length the platform gave it');
  assert.ok(run.result.columns.new_ticket.some((c) => c.schemaName === 'new_owner'), 'the build went on and created the column');
});

test('a read of the length that fails is a FAILED step too — never a silent pass — and no update is attempted without knowing what to compare with', async () => {
  const unreadable = () => ({ status: 500, headers: {}, body: { error: { message: 'An unexpected error occurred.' } } });
  const run = await provisionOver(oneTable([], asksFor(120)), { dataverse: { lengthRead: unreadable } });
  assert.strictEqual(lengthReads(run).length, 1, 'a 500 is not read again');
  assert.deepStrictEqual(puts(run), []);
  const failed = run.events.filter((e) => e.status === 'error');
  assert.strictEqual(failed.length, 1);
  assert.strictEqual(failed[0].label, 'primary column length new_ticket.new_name -> 120');
  assert.match(failed[0].detail, /^asked 120, the length the platform made is unknown: could not read the column's length \(HTTP 500: An unexpected error occurred\.\)/);
  assert.strictEqual(run.warnings.length, 1);
  assert.match(run.warnings[0], /could not set the length of the primary name column new_ticket\.new_name to 120/);
});

// A table found after the answer to its create was lost — or one that somebody else made first — is never written to: nothing shows
// that THIS build made it. But the length the spec asks for is compared with what the table has, in one typed read, and a difference
// is said out loud: the stub's default makes a plain text name column 850 characters whatever length a create with only that column
// asks for (measured on one environment), which is the likely state of such a table. Nor is such a table given a change set.
const lostAnswer = lostCreateAnswer;

test('a table found after the answer to its create was lost is never written, but its name column\'s length is read once and a difference is said out loud', async () => {
  const plain = await provisionOver(oneTable([], asksFor(120)), { dataverse: { createCommitsThenFails: lostAnswer } });
  assert.strictEqual(lengthReads(plain).length, 1, 'one typed read of the length');
  assert.deepStrictEqual(puts(plain), [], 'and nothing is written');
  assert.strictEqual(plain.dv.tables.get('new_ticket').primaryLength, 850, 'the column keeps the length the platform gave it');
  assert.deepStrictEqual(lengthEvents(plain).map((e) => [e.status, e.label]), [['skip', 'primary column length new_ticket.new_name (table found after its create — kept at 850, asked 120)']]);
  assert.strictEqual(plain.warnings.length, 1);
  assert.match(plain.warnings[0], /^the primary name column new_ticket\.new_name is 850 characters long, not the 120 the spec asks for — .*answer to that create was lost.*left alone/);
  assert.deepStrictEqual(plain.events.filter((e) => e.status === 'error'), [], 'the build goes on: this is a warning, not a failed step');
});

test('a table found after its create whose name column already has the length asked is a skip that says so, with no warning', async () => {
  // An auto-numbered name column keeps the length asked even in a create with only that column.
  const keeps = await provisionOver(oneTable([], asksFor(120, { autoNumberFormat: 'WO-{SEQNUM:5}' })), { dataverse: { createCommitsThenFails: lostAnswer } });
  assert.strictEqual(lengthReads(keeps).length, 1);
  assert.deepStrictEqual(puts(keeps), []);
  assert.deepStrictEqual(lengthEvents(keeps).map((e) => [e.status, e.label]), [['skip', 'primary column length new_ticket.new_name (already 120)']]);
  assert.deepStrictEqual(keeps.warnings, []);
});

test('a table found after its create whose name column\'s length cannot be read is a skip that says so, with a warning — never a silent pass', async () => {
  const unreadable = () => ({ status: 500, headers: {}, body: { error: { message: 'An unexpected error occurred.' } } });
  const run = await provisionOver(oneTable([], asksFor(120)), { dataverse: { createCommitsThenFails: lostAnswer, lengthRead: unreadable } });
  assert.strictEqual(lengthReads(run).length, 1, 'a 500 is not read again');
  assert.deepStrictEqual(puts(run), []);
  assert.deepStrictEqual(lengthEvents(run).map((e) => [e.status, e.label]), [['skip', 'primary column length new_ticket.new_name (table found after its create — kept; its length could not be read)']]);
  assert.strictEqual(run.warnings.length, 1);
  assert.match(run.warnings[0], /^could not read the length of the primary name column new_ticket\.new_name \(could not read the column's length \(HTTP 500: An unexpected error occurred\.\)\), so the 120 the spec asks for is not confirmed — .*left alone/);
});

test('a table found after its create is not read when the spec asks for no length; with a length and columns it is read and compared, never written, and given no change set', async () => {
  const none = await provisionOver(oneTable([], { schemaName: 'new_name', displayName: 'Name' }), { dataverse: { createCommitsThenFails: lostAnswer } });
  assert.deepStrictEqual(lengthReads(none), [], 'nothing to compare with');
  assert.deepStrictEqual(lengthEvents(none), []);
  assert.deepStrictEqual(none.warnings, []);
  const withColumns = await provisionOver(oneTable([{ schemaName: 'new_a', type: 'Text' }], asksFor(120)), { dataverse: { createCommitsThenFails: lostAnswer } });
  assert.strictEqual(lengthReads(withColumns).length, 1);
  assert.deepStrictEqual(puts(withColumns), []);
  assert.deepStrictEqual(batchPosts(withColumns), [], 'the table is not given a change set');
  assert.deepStrictEqual(columnPosts(withColumns).map((r) => r.body.SchemaName), ['new_a'], 'its column is created by its own request');
  assert.strictEqual(withColumns.dv.tables.get('new_ticket').primaryLength, 850, 'and the name column is left as it is');
  assert.deepStrictEqual(lengthEvents(withColumns).map((e) => [e.status, e.label]), [['skip', 'primary column length new_ticket.new_name (table found after its create — kept at 850, asked 120)']]);
  assert.strictEqual(withColumns.warnings.length, 1, 'with the one warning, and none about columns created together');
});

test('the primary column length step is planned exactly when the spec asks for a length, and narrated once however the table was made, so [n/total] holds', async () => {
  const { planFor } = require('../lib/sdk-build.js');
  const scenarios = [
    ['only the primary name column, platform ignores the length', oneTable([], asksFor(120)), {}],
    ['only the primary name column, already the length', oneTable([], asksFor(120)), HONOURING],
    ['with columns', oneTable([{ schemaName: 'new_a', type: 'Text' }], asksFor(120)), {}],
    ['after a refused change set', oneTable([{ schemaName: 'new_a', type: 'Text' }], asksFor(120)), { batchFails: refusedChangeSet }],
    ['an update that fails', oneTable([], asksFor(120)), { updateFails: () => ({ status: 400, headers: {}, body: { error: { message: 'no' } } }) }],
    ['a table found after the answer to its create was lost', oneTable([], asksFor(120)), { createCommitsThenFails: lostAnswer }],
    ['no length asked', oneTable([{ schemaName: 'new_a', type: 'Text' }], { schemaName: 'new_name', displayName: 'Name' }), {}],
  ];
  for (const [what, spec, dataverse] of scenarios) {
    const run = await provisionOver(spec, { dataverse });
    const planned = planFor(spec, { phases: ['data-model'] });
    const asked = spec.entities[0].primaryAttribute.maxLength !== undefined;
    assert.strictEqual(planned.filter((i) => /^primary column length /.test(i.label)).length, asked ? 1 : 0, `${what}: planned`);
    assert.strictEqual(lengthEvents(run).length, asked ? 1 : 0, `${what}: narrated`);
    assert.strictEqual(run.events.filter((e) => e.status !== 'start').length, planned.length, `${what}: as many steps as the plan has, so n never passes total`);
  }
});
