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
// The most bytes an alternate key may hold. A text column takes 2 bytes a character, so a name column of 450 characters is the longest
// that can be in a key alone — and the 850 characters some environments make of a new name column are far too long.
const KEY_BYTES_LIMIT = 900;
// A table or a column in a metadata path is named by its logical name — the alternate key, `LogicalName='new_ticket'` — or by its
// MetadataId, the primary key. A table's MetadataId stops answering when the table is deleted, whatever is made under its name afterwards.
// See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/retrieve-metadata-name-metadataid
const TABLE_KEY = "(LogicalName='[^']+'|[0-9a-f-]{36})";
const COLUMN_KEY = TABLE_KEY;
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
  keepsAskedRequired = false,  // the environment that keeps the required level asked of a plain text primary column (the one measured stores it None whatever is sent)
  levelRead = null,            // (n) => response | undefined; overrides the typed read of one column's RequiredLevel (the SDK's check of a primary column's level)
  lengthRead = null,           // (n) => response | undefined; overrides the typed read of a text column's MaxLength
  identityRead = null,         // (n) => response | undefined; overrides the read of which table answers to a name (its MetadataId and primary name column)
  updateFails = null,          // (body) => response | falsy, for the PUT of a typed column; a falsy answer lets it through
  keyFails = null,             // (body, table) => response | falsy, for the request that creates an alternate key; a falsy answer lets it through
  extraCompanions = null,      // (body) => names the platform makes beside a column that nothing in the build lists
} = {}) {
  const log = [];
  const refusals = [];
  const tables = new Map();
  const optionSets = new Map();
  let attributeReadCount = 0;
  let lengthReadCount = 0;
  let levelReadCount = 0;
  let identityReadCount = 0;
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
  const tableAt = (key) => { const named = /^LogicalName='([^']+)'$/.exec(key); return named ? tables.get(named[1]) : [...tables.values()].find((x) => x.id === key); };
  const columnAt = (table, key) => { const named = /^LogicalName='([^']+)'$/.exec(key); return named ? table.columns.get(named[1]) : [...table.columns.values()].find((c) => c.row.MetadataId === key); };

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
      // Which table answers to a name right now: its MetadataId and its primary name column, in one narrow request by name.
      if ((m = /^\/EntityDefinitions\(LogicalName='([^']+)'\)\?\$select=MetadataId,PrimaryNameAttribute$/.exec(p))) {
        identityReadCount += 1;
        const override = identityRead && identityRead(identityReadCount);
        if (override) return override;
        const t = tables.get(m[1]);
        return t ? reply(200, { MetadataId: t.id, PrimaryNameAttribute: t.primaryName }) : reply(404, { error: { message: `no table ${m[1]}` } });
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
      // The read of a text column's length: one typed request that selects MaxLength and nothing else. The table and the column are
      // addressed by logical name (the alternate key) or by MetadataId (the primary key) — a debt an earlier attempt carried is paid by ids.
      if ((m = new RegExp(`^/EntityDefinitions\\(${TABLE_KEY}\\)/Attributes\\(${COLUMN_KEY}\\)/Microsoft\\.Dynamics\\.CRM\\.StringAttributeMetadata\\?\\$select=MaxLength$`).exec(p))) {
        lengthReadCount += 1;
        const override = lengthRead && lengthRead(lengthReadCount);
        if (override) return override;
        const t = tableAt(m[1]);
        const column = t && columnAt(t, m[2]);
        if (!column) return reply(404, { error: { message: `no table or column ${m[1]} / ${m[2]}` } });
        return reply(200, { MaxLength: column.row.LogicalName === t.primaryName ? t.primaryLength : column.body.MaxLength, MetadataId: column.row.MetadataId });
      }
      // The read of ONE column's requirement level, by names: the SDK's check, after a create that asked for a primary column to be required, of
      // the level the platform kept (createTable, `primaryColumnRequired`). It selects RequiredLevel and nothing else.
      if ((m = /^\/EntityDefinitions\(LogicalName='([^']+)'\)\/Attributes\(LogicalName='([^']+)'\)\?\$select=RequiredLevel$/.exec(p))) {
        levelReadCount += 1;
        const override = levelRead && levelRead(levelReadCount);
        if (override) return override;
        const t = tables.get(m[1]);
        const column = t && t.columns.get(m[2]);
        return column ? reply(200, { RequiredLevel: column.body.RequiredLevel, MetadataId: column.row.MetadataId }) : reply(404, { error: { message: `no column ${m[2]}` } });
      }
      // The two reads of the SDK's updateColumn: the column's id and type by name, then its whole typed definition by id.
      if ((m = /^\/EntityDefinitions\(LogicalName='([^']+)'\)\/Attributes\(LogicalName='([^']+)'\)\?\$select=MetadataId,AttributeType$/.exec(p))) {
        const t = tables.get(m[1]);
        const column = t && t.columns.get(m[2]);
        return column ? reply(200, { MetadataId: column.row.MetadataId, AttributeType: 'String' }) : reply(404, { error: { message: `no column ${m[2]}` } });
      }
      if ((m = new RegExp(`^/EntityDefinitions\\(${TABLE_KEY}\\)/Attributes\\(([0-9a-f-]{36})\\)/Microsoft\\.Dynamics\\.CRM\\.StringAttributeMetadata$`).exec(p))) {
        const t = tableAt(m[1]);
        const column = t && columnAt(t, m[2]);
        if (!column) return reply(404, { error: { message: `no table or column ${m[1]} / ${m[2]}` } });
        const isPrimary = column.row.LogicalName === t.primaryName;
        // `@odata.context` is what the platform adds to an answer; the SDK drops every `@odata.*` member before it writes the definition back.
        return reply(200, { '@odata.context': `${API}/$metadata#EntityDefinitions('${t.logical}')/Attributes/Microsoft.Dynamics.CRM.StringAttributeMetadata/$entity`, ...clone(column.body), ...column.row, ...(isPrimary ? { MaxLength: t.primaryLength } : {}) });
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
          id: tableId(body.SchemaName), logical, primaryName: String(body.Attributes[0].SchemaName).toLowerCase(), columns: new Map(), keys: new Map(),
          reserved: new Set([`${logical}id`, ...SYSTEM_COLUMNS]), lagReads: lookupLag,
          // What the platform makes of the primary name column's length in a create that carries only that column (measured on two
          // environments): one keeps the length asked, the other makes a plain text column 850 whatever length was asked and keeps
          // the length asked of an auto-numbered one.
          primaryLength: !body.Attributes[0].AutoNumberFormat && !keepsAskedLength ? 850 : body.Attributes[0].MaxLength,
        };
        const collision = firstTaken(table, body.Attributes);
        if (collision) return refuse(p, duplicateAttribute(collision, logical));
        tables.set(logical, table);
        // The requirement level of the primary name column in a create that carries only that column (measured on Dataverse 9.2.26101,
        // AB#6770007): an auto-numbered column keeps the level the create sends, a plain text one is stored `None` whatever is sent,
        // and a later update (a PUT) sets it.
        const primary = clone(body.Attributes[0]);
        if (!primary.AutoNumberFormat && !keepsAskedRequired) primary.RequiredLevel = { ...primary.RequiredLevel, Value: 'None' };
        addColumn(table, primary);
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
      // The request that creates an alternate key. The platform validates a key when it is created: its columns must exist, and the
      // key's total size must stay within what an index holds — 900 bytes, 2 for each character of a text column. This stub refuses a
      // key that is too large with a message of its own: the rule is the platform's, the wording is not.
      // See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/define-alternate-keys-entity#create-alternate-keys
      if ((m = /^\/EntityDefinitions\(LogicalName='([^']+)'\)\/Keys$/.exec(p))) {
        const t = tables.get(m[1]);
        if (!t) return reply(404, { error: { message: `no table ${m[1]}` } });
        const failure = keyFails && keyFails(body, t);
        if (failure) return refuse(p, failure);
        const name = String(body.SchemaName).toLowerCase();
        if (t.keys.has(name)) return refuse(p, reply(400, { error: { message: `A key with the same name already exists on ${t.logical}.` } }));
        let bytes = 0;
        for (const attribute of body.KeyAttributes) {
          const column = t.columns.get(attribute);
          if (!column) return refuse(p, reply(400, { error: { message: `The key column ${attribute} does not exist on ${t.logical}.` } }));
          const isText = /StringAttributeMetadata$/.test(String(column.body['@odata.type']));
          bytes += isText ? 2 * (attribute === t.primaryName ? t.primaryLength : (column.body.MaxLength || 100)) : 8;
        }
        if (bytes > KEY_BYTES_LIMIT) return refuse(p, reply(400, { error: { message: `The key ${body.SchemaName} is ${bytes} bytes long; a key may hold at most ${KEY_BYTES_LIMIT}.` } }));
        const id = attributeId(t.logical, `key.${body.SchemaName}`);
        t.keys.set(name, { body: clone(body), id });
        return created(`EntityDefinitions(LogicalName='${m[1]}')/Keys(${id})`);
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
    // stored are kept — what the SDK's updateColumn sends. The table is addressed by logical name (the SDK's own update) or by
    // MetadataId (the update of a debt an earlier attempt carried): an id that no table has any more is a 404.
    put: async (url, body, options) => {
      const p = relative(url);
      log.push({ method: 'PUT', path: p, body: clone(body), headers: (options && options.headers) || {} });
      const m = new RegExp(`^/EntityDefinitions\\(${TABLE_KEY}\\)/Attributes\\(([0-9a-f-]{36})\\)$`).exec(p);
      if (!m) throw new Error(`unexpected PUT ${p}`);
      if (updateFails) {
        const failure = updateFails(body);
        if (failure) return refuse(p, failure);
      }
      const t = tableAt(m[1]);
      const column = t && columnAt(t, m[2]);
      if (!column) return reply(404, { error: { message: `no table or column ${m[1]} / ${m[2]}` } });
      // The PUT replaces the definition, level included: what the SDK read is what it writes back, with the one change it was asked for.
      if (body.RequiredLevel !== undefined) column.body = { ...column.body, RequiredLevel: clone(body.RequiredLevel) };
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
  return { httpClient, log, refusals, tables, attributeReadCount: () => attributeReadCount, lengthReadCount: () => lengthReadCount, identityReadCount: () => identityReadCount, levelReadCount: () => levelReadCount };
}

// What another maker does while the build waits to retry: deletes a table and makes it again. The same logical names then answer for a
// table with another MetadataId, and for columns with other MetadataIds, and the name column has the length that maker gave it.
const REPLACEMENT_ID = '11111111-2222-3333-4444-555555555555';
function replaceTable(dv, logical, { length = 600 } = {}) {
  const original = dv.tables.get(logical);
  const columns = new Map([...original.columns].map(([name, column]) => [name, { body: clone(column.body), row: { ...column.row, MetadataId: attributeId(`replacement.${logical}`, name) } }]));
  dv.tables.set(logical, { ...original, id: REPLACEMENT_ID, primaryLength: length, columns, keys: new Map(), reserved: new Set(original.reserved) });
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

// --- the primary name column's requirement level on a new table (AB#6770007) -------------------------------------------------------
// The table's create asks for it (`primaryColumnRequired`). Measured on Dataverse 9.2.26101: an auto-numbered name column keeps the level the
// create sends, a plain text one is stored not required whatever is sent, and an update (a PUT) sets it. The real SDK reads the level back,
// updates it where it differs, reads it again, and answers it; the build says "applied on create" only when it does — and when it cannot, the
// table exists, the build stops once, and the re-run finds the table and sets the level as it does for any existing column.
const requiredName = (extra = {}) => ({ schemaName: 'new_name', displayName: 'Name', required: true, ...extra });
const levelOf = (dv, logical = 'new_ticket', column = 'new_name') => dv.tables.get(logical).columns.get(column).body.RequiredLevel.Value;
const levelReads = (run) => gets(run).filter((r) => /\/Attributes\(LogicalName='[^']+'\)\?\$select=RequiredLevel$/.test(r.path));
const requiredSteps = (events) => events.filter((e) => e.status !== 'start' && /^required /.test(e.label)).map((e) => `${e.status}: ${e.label}`);

test('a required auto-numbered name column keeps the level the create sends: the SDK reads it once, updates nothing, and the build reports it applied on create', async () => {
  const run = await provisionOver(oneTable([], requiredName({ autoNumberFormat: 'WO-{SEQNUM:5}' })));
  assert.strictEqual(tablePosts(run)[0].body.Attributes[0].RequiredLevel.Value, 'ApplicationRequired', 'the level is in the create');
  assert.strictEqual(levelOf(run.dv), 'ApplicationRequired');
  assert.strictEqual(levelReads(run).length, 1, 'read once, to confirm it');
  assert.deepStrictEqual(puts(run), [], 'and nothing is updated');
  assert.deepStrictEqual(requiredSteps(run.events), ['skip: required new_ticket.new_name (applied on create)']);
  assert.deepStrictEqual(run.warnings, []);
});

test('a required plain text name column is stored not required by the create, so the SDK sets the level with one update — and the build reports it applied on create', async () => {
  const run = await provisionOver(oneTable([], requiredName()));
  assert.strictEqual(tablePosts(run)[0].body.Attributes[0].RequiredLevel.Value, 'ApplicationRequired', 'the level is asked in the create');
  assert.strictEqual(puts(run).length, 1, 'one update');
  assert.strictEqual(puts(run)[0].body.RequiredLevel.Value, 'ApplicationRequired');
  assert.strictEqual(puts(run)[0].headers['MSCRM.MergeLabels'], 'true', 'which merges the labels already stored');
  assert.strictEqual(levelOf(run.dv), 'ApplicationRequired', 'what the platform holds');
  assert.strictEqual(levelReads(run).length, 2, 'the level is read before the update and again after it');
  assert.deepStrictEqual(requiredSteps(run.events), ['skip: required new_ticket.new_name (applied on create)']);
  assert.deepStrictEqual(run.warnings, []);
  // `recommended` is a level too.
  const recommended = await provisionOver(oneTable([], requiredName({ required: 'recommended' })));
  assert.strictEqual(levelOf(recommended.dv), 'Recommended');
  assert.deepStrictEqual(requiredSteps(recommended.events), ['skip: required new_ticket.new_name (applied on create)']);
});

test('an environment that keeps the level asked of a plain text name column is read once and updated not at all', async () => {
  const run = await provisionOver(oneTable([], requiredName()), { dataverse: { keepsAskedRequired: true } });
  assert.strictEqual(levelOf(run.dv), 'ApplicationRequired');
  assert.strictEqual(levelReads(run).length, 1);
  assert.deepStrictEqual(puts(run), []);
  assert.deepStrictEqual(requiredSteps(run.events), ['skip: required new_ticket.new_name (applied on create)']);
});

test('a name column without an explicit required is created as ever — no level asked, none read, none updated — and an explicit required:false sends None and reads nothing back', async () => {
  const omitted = await provisionOver(oneTable([]));
  assert.strictEqual(tablePosts(omitted)[0].body.Attributes[0].RequiredLevel.Value, 'None');
  assert.deepStrictEqual(levelReads(omitted), []);
  assert.deepStrictEqual(puts(omitted), []);
  assert.deepStrictEqual(requiredSteps(omitted.events), []);
  const off = await provisionOver(oneTable([], requiredName({ required: false })));
  assert.deepStrictEqual(tablePosts(off).map((r) => r.body), tablePosts(omitted).map((r) => r.body), 'the same request: None is what the create always sent');
  assert.deepStrictEqual(levelReads(off), [], 'there is nothing to confirm');
  assert.deepStrictEqual(puts(off), []);
  assert.deepStrictEqual(requiredSteps(off.events), ['skip: required new_ticket.new_name (applied on create)']);
});

test('the level and the length asked of a plain text name column are both set, one update each, and the second does not undo the first', async () => {
  const run = await provisionOver(oneTable([], requiredName({ maxLength: 120 })));
  assert.strictEqual(puts(run).length, 2, 'the SDK\'s update of the level, then the build\'s update of the length');
  assert.strictEqual(puts(run)[0].body.RequiredLevel.Value, 'ApplicationRequired');
  assert.strictEqual(puts(run)[1].body.MaxLength, 120);
  assert.strictEqual(puts(run)[1].body.RequiredLevel.Value, 'ApplicationRequired', 'the length update is written from a read that already holds the level');
  assert.strictEqual(run.dv.tables.get('new_ticket').primaryLength, 120);
  assert.strictEqual(levelOf(run.dv), 'ApplicationRequired');
  assert.deepStrictEqual(run.warnings, []);
});

test('a name column level the platform will not take: the SDK refuses with PRIMARY_COLUMN_REQUIRED_NOT_APPLIED, the build stops once with the table made, and the re-run finds the table and sets the level — and a run after that changes nothing', async () => {
  const refuse = () => ({ status: 400, headers: {}, body: { error: { message: 'The attribute cannot be changed right now' } } });
  const spec = oneTable([textColumn('new_a')], requiredName());
  const run = await provisionOver(spec, { dataverse: { updateFails: refuse }, capture: true });
  assert.ok(run.error instanceof BuildHalt && run.error.code === 'PRIMARY_COLUMN_REQUIRED_NOT_APPLIED' && run.error.recoverable === true, `the halt carries the SDK's code: ${run.error && run.error.message}`);
  assert.match(run.error.message, /WAS CREATED/);
  assert.match(run.error.message, /Run the build again: it finds the table, does not create it again/);
  assert.strictEqual(tablePosts(run).length, 1, 'the table was created once');
  assert.strictEqual(levelOf(run.dv), 'None', 'it exists, with a name column that is not required');
  assert.deepStrictEqual(columnPosts(run).concat(batchPosts(run)), [], 'no column is created beside it');
  assert.strictEqual(run.warnings.length, 1);
  assert.match(run.warnings[0], /^table new_ticket was created, but the required level \(ApplicationRequired\) of its primary name column new_name could not be confirmed, so the build stops here — the table exists: run the build again, which finds it, does not create it again, and sets that level on the column/);

  // The re-run, against a platform that takes the update: the table is found, not created, and its level is reconciled like an existing column's.
  const run2 = fakeDataverse();
  run2.tables.set('new_ticket', run.dv.tables.get('new_ticket'));
  const again = async (dv) => {
    const sdk = await realSdk(dv.httpClient);
    const events = [];
    const warnings = [];
    await provisionDataModel({ sdk, provision: sdk, runner: makeRunner({ emit: (e) => events.push(e), total: 99 }), spec, apply: true, preResolvedLanguageCode: 1033, provisionedLanguages: async () => [1033], sleep: async () => {}, warn: (m) => warnings.push(m) });
    return { events, warnings };
  };
  const second = await again(run2);
  assert.strictEqual(run2.log.filter((r) => r.method === 'POST' && r.path === '/EntityDefinitions').length, 0, 'the table is not created again');
  assert.strictEqual(levelOf(run2), 'ApplicationRequired');
  assert.deepStrictEqual(requiredSteps(second.events), ['ok: required new_ticket.new_name -> ApplicationRequired']);
  assert.deepStrictEqual(second.warnings, []);
  assert.deepStrictEqual(second.events.filter((e) => e.status === 'ok').map((e) => e.label).filter((l) => /^column /.test(l)), ['column new_ticket.new_a (Text)'], 'and the column the first run never reached is created');

  // A third run has nothing left to do for the level.
  const putsBefore = run2.log.filter((r) => r.method === 'PUT').length;
  const third = await again(run2);
  assert.strictEqual(run2.log.filter((r) => r.method === 'PUT').length, putsBefore, 'no update');
  assert.deepStrictEqual(requiredSteps(third.events), ['skip: required new_ticket.new_name (already ApplicationRequired)']);
});

test('a name column level the SDK cannot read back is not taken for the one asked: PRIMARY_COLUMN_REQUIRED_NOT_APPLIED, the table is made once and not made again', async () => {
  const unreadable = () => ({ status: 200, headers: {}, body: {} });
  const run = await provisionOver(oneTable([], requiredName()), { dataverse: { levelRead: unreadable }, capture: true });
  assert.ok(run.error instanceof BuildHalt && run.error.code === 'PRIMARY_COLUMN_REQUIRED_NOT_APPLIED', run.error && run.error.message);
  assert.strictEqual(tablePosts(run).length, 1);
  assert.strictEqual(run.warnings.length, 1);
  // The new table's read-back failing is the same refusal when a level was asked: the table exists, and the level was neither applied nor checked.
  const down = await provisionOver(oneTable([], requiredName()), { dataverse: { tableReadBack: () => ({ status: 500, headers: {}, body: { error: { message: 'An unexpected error occurred.' } } }) }, capture: true });
  assert.ok(down.error instanceof BuildHalt && down.error.code === 'PRIMARY_COLUMN_REQUIRED_NOT_APPLIED', down.error && down.error.message);
  assert.match(down.error.message, /was NOT applied or checked|reading it back failed/);
  assert.strictEqual(tablePosts(down).length, 1, 'the create is not repeated');
});

test('a spec that asks for a required name column and a length gets one warning that names both when the level cannot be confirmed on an environment that ignores the length', async () => {
  const refuse = () => ({ status: 400, headers: {}, body: { error: { message: 'no' } } });
  const run = await provisionOver(oneTable([], requiredName({ maxLength: 120 })), { dataverse: { updateFails: refuse }, capture: true });
  assert.ok(run.error instanceof BuildHalt && run.error.code === 'PRIMARY_COLUMN_REQUIRED_NOT_APPLIED');
  assert.strictEqual(run.warnings.length, 1);
  assert.match(run.warnings[0], /sets that level on the column; the spec also asks for a name column length of 120, which may not have been applied either/);
  assert.strictEqual(run.dv.tables.get('new_ticket').primaryLength, 850, 'and it was not: a re-run leaves an existing table\'s name column length as it is');
});

test('a table that exists and whose name column states no required level is left as it is: nothing written, nothing narrated about the level', async () => {
  const first = await provisionOver(oneTable([]));
  const again = fakeDataverse();
  again.tables.set('new_ticket', first.dv.tables.get('new_ticket'));
  const sdk = await realSdk(again.httpClient);
  const events = [];
  await provisionDataModel({ sdk, provision: sdk, runner: makeRunner({ emit: (e) => events.push(e), total: 99 }), spec: oneTable([]), apply: true, preResolvedLanguageCode: 1033, provisionedLanguages: async () => [1033], sleep: async () => {}, warn: () => {} });
  assert.deepStrictEqual(again.log.filter((r) => r.method !== 'GET'), [], 'no write of any kind');
  assert.deepStrictEqual(requiredSteps(events), []);
  assert.strictEqual(levelOf(again), 'None');
});

test('through the plugin\'s own HTTP client — which has put() — a required plain text name column is made required, and without a put() nothing is created at all', async () => {
  const dv = fakeDataverse();
  const { httpClient, sent } = throughAzHttpClient(dv);
  assert.strictEqual(typeof httpClient.put, 'function', 'the client can send the update the SDK needs');
  const sdk = await realSdk(httpClient);
  const events = [];
  await provisionDataModel({ sdk, provision: sdk, runner: makeRunner({ emit: (e) => events.push(e), total: 99 }), spec: oneTable([], requiredName()), apply: true, preResolvedLanguageCode: 1033, provisionedLanguages: async () => [1033], sleep: async () => {}, warn: () => {} });
  assert.strictEqual(levelOf(dv), 'ApplicationRequired');
  assert.deepStrictEqual(sent.filter((s) => s.method === 'PUT').map((s) => JSON.parse(s.body).RequiredLevel.Value), ['ApplicationRequired']);
  assert.deepStrictEqual(requiredSteps(events), ['skip: required new_ticket.new_name (applied on create)']);

  // A client without put() cannot finish what the create leaves undone for a plain text name column, so the SDK refuses BEFORE it creates the table.
  const bare = fakeDataverse();
  delete bare.httpClient.put;
  const bareSdk = await realSdk(bare.httpClient);
  await assert.rejects(provisionDataModel({ sdk: bareSdk, provision: bareSdk, runner: makeRunner({ emit: () => {}, total: 99 }), spec: oneTable([], requiredName()), apply: true, preResolvedLanguageCode: 1033, provisionedLanguages: async () => [1033], sleep: async () => {}, warn: () => {} }), (err) => err instanceof BuildHalt && /needs an HttpClient that implements put\(\)/.test(err.message));
  assert.deepStrictEqual(bare.log.filter((r) => r.method === 'POST'), [], 'no table was created');
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

// --- an alternate key over a new table's name column -----------------------------------------------------------------------------
// The platform validates a key when it is created, and a key may hold at most 900 bytes (KEY_BYTES_LIMIT, 2 a character of text). The
// name column of a new table has the length the spec asks for only once the length step has run — last in the phase, because its read
// carries labels (see the order tests above) — and an environment that ignores the length asked of the create makes it 850 characters,
// 1,700 bytes: far too long for a key. So a key over the name column of a table whose length is still to be set waits for that step,
// and is not asked for when the step failed.

const NAME_KEY = { schemaName: 'new_namekey', displayName: 'Name Key', columns: ['new_name'] };
// One table with a name column as given and the alternate keys given, beside a text column `new_code`.
function keyedTable(keys, primaryAttribute = asksFor(120), columns = [textColumn('new_code')]) {
  const spec = oneTable(columns, primaryAttribute);
  spec.entities[0].alternateKeys = keys;
  return spec;
}
const keyPosts = (run) => posts(run).filter((r) => /\/Keys$/.test(r.path));
const finished = (run) => run.events.filter((e) => e.status !== 'start').map((e) => [e.status, e.label]);

test('an alternate key over a new table\'s name column is created after the length is set: the first build succeeds where the platform made the column too long for a key', async () => {
  // The stub's default is the environment that makes a new name column 850 characters whatever length the create asks for.
  const run = await provisionOver(keyedTable([NAME_KEY]));
  const table = run.dv.tables.get('new_ticket');
  assert.strictEqual(table.primaryLength, 120, 'the name column has the length the spec asks for');
  assert.deepStrictEqual([...table.keys.keys()], ['new_namekey'], 'and the key exists after the first build');
  assert.deepStrictEqual(run.dv.refusals, [], 'the platform refused nothing');
  assert.deepStrictEqual(finished(run).slice(-2), [['ok', 'primary column length new_ticket.new_name -> 120'], ['ok', 'alt key new_ticket.new_namekey']], 'the length step, then the key');
  const lines = run.dv.log.map(requestLine);
  assert.ok(lines.findIndex((l) => l.startsWith('PUT ')) < lines.findIndex((l) => /\/Keys$/.test(l)), 'the length is written before the key is asked for');
  assert.strictEqual(keyPosts(run).length, 1, 'the key is asked for once');
  assert.deepStrictEqual(run.warnings, []);
});

test('where the environment keeps the length asked, the key still follows the length step — which is a skip, and writes nothing', async () => {
  const run = await provisionOver(keyedTable([NAME_KEY]), { dataverse: HONOURING });
  assert.deepStrictEqual(puts(run), [], 'the column is already the length asked');
  assert.deepStrictEqual(finished(run).slice(-2), [['skip', 'primary column length new_ticket.new_name (already 120)'], ['ok', 'alt key new_ticket.new_namekey']]);
  assert.strictEqual(run.dv.tables.get('new_ticket').keys.size, 1);
  assert.deepStrictEqual(run.warnings, []);
});

test('a key over the name column among other columns waits too, and a second key that needs no length is created where it always was', async () => {
  const keys = [{ schemaName: 'new_pairkey', columns: ['new_code', 'new_name'] }, { schemaName: 'new_codekey', columns: ['new_code'] }];
  const run = await provisionOver(keyedTable(keys));
  assert.deepStrictEqual(finished(run).map(([, label]) => label), [
    'table new_ticket', 'column new_ticket.new_code (Text)', 'alt key new_ticket.new_codekey', 'primary column length new_ticket.new_name -> 120', 'alt key new_ticket.new_pairkey',
  ], 'the key without the name column is made with its table, the other after the length step');
  assert.deepStrictEqual([...run.dv.tables.get('new_ticket').keys.keys()].sort(), ['new_codekey', 'new_pairkey']);
});

// Where each kind of key is made, against a second table, a relationship and the length step. The doubles record the order of every
// write. A key that needs no length keeps the place it has always had — with its table, before the next one — and only a key over a
// name column whose length is still to be set moves, to after the length step.
const KEYED_PAIR = (key, primaryAttribute = { schemaName: 'new_n', maxLength: 120 }) => ({
  solution: { uniqueName: 'S', publisherPrefix: 'new' },
  entities: [
    { schemaName: 'new_a', displayName: 'A', primaryAttribute, columns: [textColumn('new_x')], alternateKeys: [key] },
    { schemaName: 'new_b', displayName: 'B', primaryAttribute: { schemaName: 'new_m' }, columns: [] },
  ],
  relationships: [{ type: 'OneToMany', referenced: 'new_a', referencing: 'new_b', schemaName: 'new_a_b', lookup: { schemaName: 'new_aid', displayName: 'A' } }],
});
const A_FIRST = ['createTable new_a', 'createColumns new_a new_x'];
const THEN_B = ['createTable new_b', 'createRelationship new_a_b'];
const KEY_ON_A = 'createAlternateKey new_a.new_k';
const SET_A_LENGTH = 'updateColumn new_a.new_n {"maxLength":120}';

test('where a key is made: after the length step only when it holds the name column of a table whose length is still to be set — every other key keeps its place', async (t) => {
  for (const [what, spec, existing, expected] of [
    ['a key over the name column of a new table whose spec asks for a length', KEYED_PAIR({ schemaName: 'new_k', columns: ['new_n'] }), [],
      [...A_FIRST, ...THEN_B, SET_A_LENGTH, KEY_ON_A]],
    ['the same with the column named in capitals: logical names are lower case', KEYED_PAIR({ schemaName: 'new_k', columns: ['new_N'] }), [],
      [...A_FIRST, ...THEN_B, SET_A_LENGTH, KEY_ON_A]],
    ['a key over the name column and another column', KEYED_PAIR({ schemaName: 'new_k', columns: ['new_x', 'new_n'] }), [],
      [...A_FIRST, ...THEN_B, SET_A_LENGTH, KEY_ON_A]],
    ['a key over another column: it needs no length', KEYED_PAIR({ schemaName: 'new_k', columns: ['new_x'] }), [],
      [...A_FIRST, KEY_ON_A, ...THEN_B, SET_A_LENGTH]],
    ['a key over the name column when the spec asks for no length: there is no length step to wait for', KEYED_PAIR({ schemaName: 'new_k', columns: ['new_n'] }, { schemaName: 'new_n' }), [],
      [...A_FIRST, KEY_ON_A, ...THEN_B]],
    ['a key over the name column whose label is in several languages: a read that carries labels must not come before it', KEYED_PAIR({ schemaName: 'new_k', columns: ['new_n'], displayName: { 1033: 'Key', 3082: 'Clave' } }), [],
      [...A_FIRST, KEY_ON_A, ...THEN_B, SET_A_LENGTH]],
    ['a label map that holds only the build\'s language is the request the string is, so the key waits like one', KEYED_PAIR({ schemaName: 'new_k', columns: ['new_n'], displayName: { 1033: 'Key' } }), [],
      [...A_FIRST, ...THEN_B, SET_A_LENGTH, KEY_ON_A]],
    ['a label map of one language is one label whichever language that is — the build\'s language does not enter into it — so the key waits', KEYED_PAIR({ schemaName: 'new_k', columns: ['new_n'], displayName: { 3082: 'Clave' } }), [],
      [...A_FIRST, ...THEN_B, SET_A_LENGTH, KEY_ON_A]],
    ['a key over the name column of a table that already existed: its name column is never written', KEYED_PAIR({ schemaName: 'new_k', columns: ['new_n'] }), ['new_a'],
      ['createColumn new_a.new_x', KEY_ON_A, ...THEN_B]],
  ]) {
    await t.test(what, async () => {
      const doubles = orderDoubles({ existing });
      await runOrder(doubles, spec);
      assert.deepStrictEqual(doubles.calls, expected);
    });
  }
});

test('a name column key that waits is created once, with the options the inline key has — and a key over a column that is not the name column has them where it always did', async () => {
  const doubles = orderDoubles();
  const seen = [];
  const createAlternateKey = doubles.sdk.createAlternateKey;
  doubles.sdk.createAlternateKey = async (table, options) => { seen.push([table, options]); return createAlternateKey(table, options); };
  await runOrder(doubles, KEYED_PAIR({ schemaName: 'new_k', displayName: 'The Key', columns: ['new_N'] }));
  assert.deepStrictEqual(seen, [['new_a', { schemaName: 'new_k', displayName: 'The Key', keyAttributes: ['new_n'], languageCode: 1033 }]]);
});

test('a table found after the answer to its create was lost keeps its keys where they were: nothing shows that this build made it, so its name column is not written for a key', async () => {
  const run = await provisionOver(keyedTable([NAME_KEY]), { dataverse: { createCommitsThenFails: lostAnswer }, capture: true });
  assert.deepStrictEqual(puts(run), [], 'the column is left alone');
  assert.strictEqual(keyPosts(run).length, 1, 'and the key is asked for where it always was');
  assert.ok(run.error instanceof BuildHalt && run.error.code !== 'alt-key-name-length-not-set', 'where the platform refuses it, as it did before');
});

test('a key that waits for a length that could not be set is not asked for: the build stops there and says why, in words of its own', async () => {
  const refuse = () => ({ status: 400, headers: {}, body: { error: { message: 'The attribute cannot be changed right now' } } });
  const run = await provisionOver(keyedTable([NAME_KEY]), { dataverse: { updateFails: refuse }, capture: true });
  assert.ok(run.error instanceof BuildHalt, 'the build stops');
  assert.strictEqual(run.error.code, 'alt-key-name-length-not-set');
  assert.strictEqual(run.error.phase, 'data-model');
  assert.strictEqual(run.error.recoverable, true, 'a re-run can finish it');
  assert.deepStrictEqual(keyPosts(run), [], 'no request was sent for the key, so the platform said nothing about it');
  assert.match(run.error.message, /^data-model failed: alt key new_ticket\.new_namekey was not created: .*\bnew_name\b.*\b120\b/);
  assert.match(run.error.message, /The attribute cannot be changed right now/, 'with what stopped the length from being set');
  assert.match(run.error.message, /900 bytes/, 'and why a key needs it');
  assert.match(run.error.message, /Maker/, 'and what to do');
  assert.deepStrictEqual(run.events.filter((e) => e.status === 'error').map((e) => e.label), ['primary column length new_ticket.new_name -> 120', 'alt key new_ticket.new_namekey'], 'both steps are narrated as failed, the length first');
  assert.strictEqual(run.warnings.length, 1, 'and the length is warned about once, as ever');
  assert.match(run.warnings[0], /^could not set the length of the primary name column new_ticket\.new_name to 120/);
  assert.strictEqual(run.dv.tables.get('new_ticket').primaryLength, 850);
  assert.strictEqual(run.dv.tables.get('new_ticket').keys.size, 0);
});

test('a key that could not wait for the length fails the way the length step failed: a 429 or a 503 is the build\'s to retry, a refusal is not', async () => {
  const { isTransientHalt } = require('../build-model-app.js');
  const answer = (status, message) => () => ({ status, headers: {}, body: { error: { message } } });
  for (const [what, failure, transient] of [
    ['the update is throttled (429)', { updateFails: answer(429, 'Cannot start another [EntityCustomization] because there is a previous [EntityCustomization] running.') }, true],
    ['the update gets a 503', { updateFails: answer(503, 'Service Unavailable') }, true],
    ['the length cannot be read (503)', { lengthRead: answer(503, 'Service Unavailable') }, true],
    ['the update is refused (400)', { updateFails: answer(400, 'The attribute cannot be changed right now') }, false],
    ['the length cannot be read (500)', { lengthRead: answer(500, 'An unexpected error occurred.') }, false],
  ]) {
    const run = await provisionOver(keyedTable([NAME_KEY]), { dataverse: failure, capture: true });
    assert.strictEqual(run.error && run.error.code, 'alt-key-name-length-not-set', what);
    assert.strictEqual(isTransientHalt(run.error), transient, what);
    assert.deepStrictEqual(keyPosts(run), [], `${what}: the key is not asked for`);
  }
});

// The stop is a halt raised around the failure of the length step (retry: retryPolicyFor(…), lib/retry-policy.js), so the build's retry judges that failure and never the halt's own
// words: they name the key, and a key's schema name can hold a word the retry once looked for in a message.
test('a key that could not wait for the length is judged by the failure of the length step, never by its own words: a key named like a lock, over a length the platform refused, is not run again', async () => {
  const { isTransientHalt } = require('../build-model-app.js');
  const LOCK_KEY = { ...NAME_KEY, schemaName: 'new_CustomizationLockException' };
  const run = await provisionOver(keyedTable([LOCK_KEY]), { dataverse: { updateFails: () => ({ status: 400, headers: {}, body: { error: { message: 'The attribute cannot be changed right now' } } }) }, capture: true });
  assert.strictEqual(run.error && run.error.code, 'alt-key-name-length-not-set');
  assert.match(run.error.message, /new_CustomizationLockException/, 'the halt names the key');
  assert.strictEqual(isTransientHalt(run.error), false, 'the length step was refused (400), and that is final whatever the key is called');
  assert.strictEqual(isTransientHalt(new Error(run.error.message)), true, 'the control: the halt\'s words alone would have read as a customization lock');
  assert.deepStrictEqual(keyPosts(run), [], 'the key is not asked for');
});

test('a key that waits and that the platform then refuses, or finds already there, is treated as any key is: the platform\'s own words stop the build, an already-exists answer is a skip', async () => {
  const refusedKey = await provisionOver(keyedTable([NAME_KEY]), {
    dataverse: { keyFails: () => ({ status: 400, headers: {}, body: { error: { message: 'The key column new_name is not valid in a key.' } } }) }, capture: true,
  });
  assert.ok(refusedKey.error instanceof BuildHalt && /The key column new_name is not valid in a key\./.test(refusedKey.error.message), 'the platform\'s words');
  assert.notStrictEqual(refusedKey.error.code, 'alt-key-name-length-not-set', 'not the build\'s own refusal: the length was set');
  assert.strictEqual(refusedKey.dv.tables.get('new_ticket').primaryLength, 120);
  const there = await provisionOver(keyedTable([NAME_KEY]), {
    dataverse: { keyFails: () => ({ status: 400, headers: {}, body: { error: { message: 'A key with the same name already exists on new_ticket.' } } }) },
  });
  assert.deepStrictEqual(finished(there).slice(-1), [['skip', 'alt key new_ticket.new_namekey (exists)']]);
});

// What the build's own retry does with a name column length that an attempt which created the table left unset. The build runs a phase
// that halts on a transient answer again (build-model-app.js); the attempt that created the table sets the length in its `finally`, but
// that step can fail too — the lock that stopped the phase may still be held — and the retry, which finds the table, used to leave its
// name column as it found it. What an attempt still owes is carried to the next one the way what it owes for the views and forms it
// saved is (`owedLengths`, sdk-build.js runSdkBuild), and paid at the end of that attempt's data-model phase.
//
// These run the real retry loop over the real engine (runSdkBuild, data-model phase), the real SDK and the stub. `faults` says how the
// stub misbehaves: the first N requests of a kind answer 503 — and, for the writes of the table, change nothing. `arrange(dv)` is a
// last word on the stub, made after the faults are in place: a test wraps the transport in it (swapAfterIdentityRead).
async function buildWithRetries(spec, { dataverse = OVERRIDING, faults = {}, arrange, halts = false } = {}) {
  const { buildModelApp } = require('../build-model-app.js');
  const { runSdkBuild } = require('../lib/sdk-build.js');
  const dv = fakeDataverse(dataverse);
  const left = { createTable: faults.createTable || 0, createFile: faults.createFile || 0, setLength: faults.setLength || 0 };
  const refuse503 = (what, path, body) => { dv.log.push({ method: what, path: `(503) ${path}`, body }); return { status: 503, headers: {}, body: { error: { message: 'Service Unavailable' } } }; };
  // `failWrite(n)` refuses the n-th write of the whole build (a POST or a PUT, counted across the attempts) when it answers true.
  let writes = 0;
  const failThisWrite = () => { writes += 1; return !!(faults.failWrite && faults.failWrite(writes)); };
  const post = dv.httpClient.post;
  dv.httpClient.post = async (url, body, options) => {
    const p = String(url).replace(API, '');
    if (failThisWrite()) return refuse503('POST', p, body);
    if (left.createTable > 0 && p === '/EntityDefinitions') { left.createTable -= 1; return refuse503('POST', p, body); }
    if (left.createFile > 0 && /\/Attributes$/.test(p) && body && body.SchemaName === 'new_attachment') { left.createFile -= 1; return refuse503('POST', p, body); }
    return post(url, body, options);
  };
  const put = dv.httpClient.put;
  dv.httpClient.put = async (url, body, options) => {
    if (failThisWrite()) return refuse503('PUT', String(url).replace(API, ''), body);
    if (left.setLength > 0) { left.setLength -= 1; return refuse503('PUT', String(url).replace(API, ''), body); }
    return put(url, body, options);
  };
  if (arrange) arrange(dv);
  const sdk = await realSdk(dv.httpClient);
  const attempts = [];
  const events = [];
  const warnings = [];
  const runBuild = async (builtSpec, options) => {
    const attempt = { number: attempts.length + 1, from: dv.log.length, owedIn: options.owedLengths };
    attempts.push(attempt);
    try {
      return await runSdkBuild(builtSpec, {
        ...options, phases: ['data-model'], preResolvedLanguageCode: 1033, provisionedLanguages: async () => [1033, 3082],
        emit: (e) => events.push({ attempt: attempt.number, ...e }), warn: (m) => warnings.push({ attempt: attempt.number, text: m }),
      });
    } catch (err) {
      attempt.owedOut = err.owedLengths;
      attempt.owedOutVisible = Object.keys(err).includes('owedLengths');
      throw err;
    } finally {
      attempt.to = dv.log.length;
    }
  };
  const journal = [];
  // `halts`: a build that stops for good answers with its halt (`halt`) instead of throwing, so what each attempt did can still be read.
  let halt;
  const result = await buildModelApp(spec, { apply: true, env: ORG, retryDelayMs: 0 }, {
    sdk, provisionSdk: sdk, runBuild,
    // The pause between two attempts is where another maker can change the environment (`faults.between`).
    sleep: async () => { if (faults.between) await faults.between(dv, attempts.length); },
    journal: { path: 'x', record: (e) => journal.push(e), close: () => {} },
    discoverOpDiffState: async () => ({ collision: { appExists: false, solutionExists: false }, forms: [], sitemap: null }),
  }).catch((err) => { if (!halts) throw err; halt = err; return undefined; });
  const requests = (n) => dv.log.slice(attempts[n - 1].from, attempts[n - 1].to);
  const steps = (n, pattern) => events.filter((e) => e.attempt === n && e.status !== 'start' && pattern.test(e.label)).map((e) => `${e.status} ${e.label}`);
  return { result, halt, dv, attempts, events, warnings, journal, requests, steps, retries: journal.filter((e) => e.status === 'retry').length };
}

// A table with a File column, which has its own request (so a fault can hit it), and a name column of 120 characters, with a key over
// the name column unless told otherwise.
function retriedTicket({ key = true } = {}) {
  return {
    app: { name: 'Ticket Desk' },
    solution: { uniqueName: 'TableColumns', publisherPrefix: 'new' },
    relationships: [],
    entities: [{
      schemaName: 'new_ticket', displayName: 'Ticket', primaryAttribute: { schemaName: 'new_name', displayName: 'Name', maxLength: 120 },
      columns: [textColumn('new_title'), { schemaName: 'new_attachment', displayName: 'Attachment', type: 'File', maxSizeKb: 1024 }],
      ...(key ? { alternateKeys: [NAME_KEY] } : {}),
    }],
  };
}
const isWrite = (r) => r.method === 'PUT' && !/^\(503\)/.test(r.path);
const OWED = 'owed by the attempt that created the table';
const OWED_NOTE = ` (${OWED})`;
const owedIn = (run, attempt) => run.attempts[attempt - 1].owedIn || [];

test('a transient halt after a table\'s create, where the length step cannot be set either: the retry sets the length the first attempt owed, and says so', async () => {
  const run = await buildWithRetries(retriedTicket({ key: false }), { faults: { createFile: 1, setLength: 1 } });
  assert.strictEqual(run.result.ok, true, 'the retry completed the build');
  assert.strictEqual(run.retries, 1, 'one transient halt, one retry');
  assert.deepStrictEqual(run.steps(1, /^primary column length /), ['error primary column length new_ticket.new_name -> 120'], 'the first attempt could not set it');
  assert.deepStrictEqual(run.steps(2, /^primary column length /), [`ok primary column length new_ticket.new_name -> 120${OWED_NOTE}`], 'the retry narrates the step it owed — not "table exists — kept"');
  assert.strictEqual(run.requests(1).filter(isWrite).length, 0, 'the first attempt wrote nothing to the column: its one update was refused');
  assert.strictEqual(run.requests(2).filter(isWrite).length, 1, 'the retry set the length');
  assert.strictEqual(run.dv.tables.get('new_ticket').primaryLength, 120, 'and the column has the length the spec asks for');
  assert.deepStrictEqual(run.attempts[0].owedOut, [{ ...DEBT }], 'the halt carries what the attempt left undone');
  assert.strictEqual(run.attempts[0].owedOutVisible, false, 'and it rides along: it is never part of a serialized error');
  assert.deepStrictEqual(run.attempts.map((a) => a.owedIn), [[], [{ ...DEBT }]], 'the first attempt is handed nothing, the retry is handed what the first owed');
});

test('the retry creates the key after the length it owed — and the first attempt, which never got that far, did not ask for it', async () => {
  const run = await buildWithRetries(retriedTicket(), { faults: { createFile: 1, setLength: 1 } });
  assert.strictEqual(run.result.ok, true, 'the build completed — without the fix the key is refused for a column of 850 characters and the build stops');
  assert.strictEqual(run.retries, 1);
  assert.deepStrictEqual(run.requests(1).filter((r) => /\/Keys$/.test(r.path)), [], 'the first attempt did not ask for the key');
  const retry = run.requests(2).map(requestLine);
  assert.strictEqual(retry.filter((l) => /\/Keys$/.test(l)).length, 1, 'the retry asked for it once');
  assert.ok(retry.findIndex((l) => l.startsWith('PUT ')) < retry.findIndex((l) => /\/Keys$/.test(l)), 'after the length');
  assert.strictEqual(run.dv.tables.get('new_ticket').primaryLength, 120);
  assert.deepStrictEqual([...run.dv.tables.get('new_ticket').keys.keys()], ['new_namekey']);
  assert.deepStrictEqual(run.steps(2, /^(primary column length|alt key) /), [`ok primary column length new_ticket.new_name -> 120${OWED_NOTE}`, 'ok alt key new_ticket.new_namekey']);
});

test('what an attempt paid is not owed again: a third attempt finds the table and leaves its name column alone', async () => {
  const run = await buildWithRetries(retriedTicket({ key: false }), { faults: { createFile: 2, setLength: 1 } });
  assert.strictEqual(run.result.ok, true);
  assert.strictEqual(run.retries, 2);
  assert.deepStrictEqual(run.steps(2, /^primary column length /), [`ok primary column length new_ticket.new_name -> 120${OWED_NOTE}`], 'the second attempt halts after the table, and pays it in its `finally`');
  assert.deepStrictEqual(run.steps(3, /^primary column length /), ['skip primary column length new_ticket.new_name (table exists — kept)']);
  assert.strictEqual(run.requests(3).filter((r) => /StringAttributeMetadata/.test(r.path)).length, 0, 'the third attempt did not even read the column');
  assert.strictEqual([1, 2, 3].reduce((n, a) => n + run.requests(a).filter(isWrite).length, 0), 1, 'the length was written once');
  assert.deepStrictEqual(run.attempts.map((a) => (a.owedIn || []).length), [0, 1, 0], 'the second attempt paid it, so the third is handed nothing');
  assert.deepStrictEqual(run.attempts[1].owedOut, [], 'and the halt of the second attempt says so');
});

test('a table that was never created is not owed: the attempt that creates it carries no debt, and its step is not worded as one', async () => {
  const run = await buildWithRetries(retriedTicket({ key: false }), { faults: { createTable: 1 } });
  assert.strictEqual(run.result.ok, true);
  assert.strictEqual(run.retries, 1);
  assert.deepStrictEqual(owedIn(run, 2), [], 'the failed create left nothing to carry');
  assert.strictEqual(run.attempts[0].owedOut, undefined, 'and the halt of the attempt that could not create the table carries no record at all');
  assert.deepStrictEqual(run.steps(2, /^primary column length /), ['ok primary column length new_ticket.new_name -> 120'], 'and the retry sets the length of the table it made as any build does');
});

test('where the first attempt did set the length, the retry owes nothing and finds the table as it always did', async () => {
  const run = await buildWithRetries(retriedTicket(), { faults: { createFile: 1 } });
  assert.strictEqual(run.result.ok, true);
  assert.deepStrictEqual(owedIn(run, 2), []);
  assert.deepStrictEqual(run.steps(1, /^primary column length /), ['ok primary column length new_ticket.new_name -> 120'], 'the attempt that created the table set the length in its `finally`');
  assert.deepStrictEqual(run.steps(2, /^primary column length /), ['skip primary column length new_ticket.new_name (table exists — kept)']);
  assert.strictEqual(run.requests(2).filter(isWrite).length, 0);
  assert.deepStrictEqual(run.requests(1).filter((r) => /\/Keys$/.test(r.path)), [], 'the key of an attempt that halted before the length step is not asked for');
  assert.strictEqual(run.requests(2).filter((r) => /\/Keys$/.test(r.path)).length, 1, 'the retry creates it, where a key on an existing table always was made — the length is already right');
  assert.deepStrictEqual([...run.dv.tables.get('new_ticket').keys.keys()], ['new_namekey']);
});

test('a length step that fails on its own stops the build at the key that waited for it, which the build retries — and the retry sets the length and makes the key', async () => {
  // Nothing else goes wrong: the one update of the name column's length is refused with a 503, which the build does not stop for.
  const run = await buildWithRetries(retriedTicket(), { faults: { setLength: 1 } });
  assert.strictEqual(run.result.ok, true, 'the build completed');
  assert.strictEqual(run.retries, 1, 'the key that could not be asked for stopped the first attempt, and a 503 is retried');
  assert.deepStrictEqual(run.requests(1).filter((r) => /\/Keys$/.test(r.path)), [], 'the first attempt did not ask for the key');
  assert.deepStrictEqual(run.steps(1, /^(primary column length|alt key) /), ['error primary column length new_ticket.new_name -> 120', 'error alt key new_ticket.new_namekey']);
  assert.deepStrictEqual(run.steps(2, /^(primary column length|alt key) /), [`ok primary column length new_ticket.new_name -> 120${OWED_NOTE}`, 'ok alt key new_ticket.new_namekey']);
  assert.strictEqual(run.dv.tables.get('new_ticket').primaryLength, 120);
  assert.deepStrictEqual([...run.dv.tables.get('new_ticket').keys.keys()], ['new_namekey']);
  assert.deepStrictEqual(run.attempts.map((a) => (a.owedIn || []).length), [0, 1]);
});

// The engine's own requests — the read of the column's length, the read of which table answers to a name and the update that pays a carried length (readTextColumn,
// readTableIdentity, updateTextColumnLengthById: the last two address the table and the column by their ids) — fail as the engine's error around the answer (statusError),
// and the answer's OData `error.code` rides on it to the build's retry (lib/retry-policy.js), as it rides on the SDK's ConnectionError for the first attempt's update
// (the SDK's own updateColumn). A condition the service names by its code is run again whatever the status; any other status is final, whatever the answer's words say.
// Here the first attempt's update is refused with a 503 — the key that waited for it stops that attempt, and the retry is handed the debt — and the retry's update, the
// engine's own request, gets the answer under test.
const odataAnswer = (status, code, message) => ({ status, headers: {}, body: { error: { ...(code ? { code } : {}), message } } });
const SERVICE_UNAVAILABLE = odataAnswer(503, null, 'Service Unavailable');
const SQL_TIMEOUT = odataAnswer(500, '0x80044151', 'SQL timeout expired.');
const DEADLOCK_VICTIM = ' Sql error: Generic SQL error. CRM ErrorCode: -2147204784 Sql ErrorCode: -2146232060 Sql Number: 1205';
// Each update of the name column's length gets the next answer; one that has none goes through.
const lengthUpdates = (...answers) => { let n = 0; return () => { n += 1; return answers[n - 1] || null; }; };

for (const [what, refused] of [
  ['SQL giving up waiting (500, 0x80044151)', SQL_TIMEOUT],
  ['a customization lock (409, 0x8004F064)', odataAnswer(409, '0x8004F064', 'Cannot start the requested operation [Update] because there is another [EntityCustomization] running at this moment.')],
  ['a SQL deadlock victim (500, 0x80044150, Sql Number: 1205 last)', odataAnswer(500, '0x80044150', DEADLOCK_VICTIM)],
]) {
  test(`the update that pays a carried length, refused for ${what}: the build runs again, and the next attempt sets the length and makes the key`, async () => {
    const run = await buildWithRetries(retriedTicket(), { dataverse: { updateFails: lengthUpdates(SERVICE_UNAVAILABLE, refused) } });
    assert.strictEqual(run.result.ok, true, 'the build completed');
    assert.strictEqual(run.retries, 2, 'the first attempt stopped at the key for the 503, the second for the answer under test, and the third completed');
    assert.deepStrictEqual(run.steps(2, /^(primary column length|alt key) /), [`error primary column length new_ticket.new_name -> 120${OWED_NOTE}`, 'error alt key new_ticket.new_namekey']);
    assert.deepStrictEqual(run.steps(3, /^(primary column length|alt key) /), [`ok primary column length new_ticket.new_name -> 120${OWED_NOTE}`, 'ok alt key new_ticket.new_namekey']);
    assert.strictEqual(run.dv.tables.get('new_ticket').primaryLength, 120, 'the third attempt set the length');
    assert.deepStrictEqual([...run.dv.tables.get('new_ticket').keys.keys()], ['new_namekey'], 'and made the key');
  });
}

for (const [what, refused] of [
  ['a unique-key violation (500, 0x80044150) whose message quotes the deadlock\'s number in front of its own', odataAnswer(500, '0x80044150', " Sql error: Violation of UNIQUE KEY constraint 'ndx_name'. Cannot insert duplicate key. The duplicate key value is (Sql Number: 1205). CRM ErrorCode: -2147204784 Sql ErrorCode: -2146232060 Sql Number: 2627")],
  ['a 400 under a code that names no condition, whose words say to try again', odataAnswer(400, '0x80040203', 'The attribute cannot be changed right now. Please try again later.')],
  ['a 500 whose message names the SQL timeout\'s code under another code', odataAnswer(500, '0x80040216', 'An unexpected error occurred (0x80044151). SQL timeout expired.')],
]) {
  test(`the update that pays a carried length, refused with ${what}: final — the build stops at the key and does not run again`, async () => {
    const { isTransientHalt } = require('../build-model-app.js');
    const run = await buildWithRetries(retriedTicket(), { dataverse: { updateFails: lengthUpdates(SERVICE_UNAVAILABLE, refused) }, halts: true });
    assert.ok(run.halt, 'the build stopped');
    assert.strictEqual(run.halt.code, 'alt-key-name-length-not-set');
    assert.strictEqual(isTransientHalt(run.halt), false, 'a status that says no, and no code that names a condition a run again can ride out');
    assert.deepStrictEqual([run.attempts.length, run.retries], [2, 1], 'the 503 of the first attempt was run again, the answer of the second was not');
    assert.strictEqual(run.dv.tables.get('new_ticket').primaryLength, 850, 'the length was never set');
    assert.strictEqual(run.dv.tables.get('new_ticket').keys.size, 0, 'and the key was never asked for');
  });
}

test('the read of the column\'s length, answered 500 0x80044151 in the attempt that created the table: the build runs again, and the retry sets the length and makes the key', async () => {
  const run = await buildWithRetries(retriedTicket(), { dataverse: { lengthRead: (n) => (n === 1 ? SQL_TIMEOUT : undefined) } });
  assert.strictEqual(run.result.ok, true, 'the build completed');
  assert.strictEqual(run.retries, 1, 'the first attempt stopped at the key, and the read\'s answer is run again');
  assert.deepStrictEqual(run.steps(2, /^(primary column length|alt key) /), [`ok primary column length new_ticket.new_name -> 120${OWED_NOTE}`, 'ok alt key new_ticket.new_namekey']);
  assert.strictEqual(run.dv.tables.get('new_ticket').primaryLength, 120);
  assert.deepStrictEqual([...run.dv.tables.get('new_ticket').keys.keys()], ['new_namekey']);
});

test('a 404 on the read of which table answers to the name is still "no table" — the debt\'s table is gone and left alone — and never a failure the build judges', async () => {
  const run = await buildWithRetries(retriedTicket({ key: false }), {
    dataverse: { updateFails: lengthUpdates(SERVICE_UNAVAILABLE), identityRead: (n) => (n === 1 ? odataAnswer(404, '0x80040217', 'Could not find entity new_ticket.') : undefined) },
    faults: { createFile: 1 },
  });
  assert.strictEqual(run.result.ok, true, 'the build completed');
  assert.strictEqual(run.retries, 1, 'only the File column\'s 503 was run again');
  assert.deepStrictEqual(run.steps(2, /^primary column length /), ['skip primary column length new_ticket.new_name (the table the build created is gone — kept)']);
  assert.deepStrictEqual(run.requests(2).filter((r) => r.method === 'PUT'), [], 'nothing was written to a table the build cannot prove is its own');
  assert.ok(run.warnings.some((w) => w.attempt === 2 && /the table new_ticket this build created is no longer there/.test(w.text)), 'and it says so');
});

test('whichever write of the build is refused with a 503, the build converges: the table has the length the spec asks for and the key exists', async () => {
  const clean = await buildWithRetries(retriedTicket());
  const writes = clean.dv.log.filter((r) => (r.method === 'POST' || r.method === 'PUT') && r.path !== '/$batch').length;
  assert.ok(writes >= 4, `a clean build writes the table, the File column, the length and the key (the other column goes in a change set): ${writes}`);
  assert.strictEqual(clean.retries, 0);
  for (const [what, faults] of [
    ['alone', (n) => ({ failWrite: (i) => i === n })],
    ['with the first update of the length refused as well', (n) => ({ failWrite: (i) => i === n, setLength: 1 })],
    ['and again at the same place on the retry', (n) => ({ failWrite: (i) => i === n || i === n + 1 })],
  ]) {
    for (let n = 1; n <= writes; n += 1) {
      const run = await buildWithRetries(retriedTicket(), { faults: faults(n) });
      const label = `write ${n} of ${writes} refused, ${what}`;
      assert.strictEqual(run.result.ok, true, label);
      assert.ok(run.retries >= 1 && run.retries <= 3, `${label}: retried ${run.retries} time(s)`);
      const table = run.dv.tables.get('new_ticket');
      assert.strictEqual(table.primaryLength, 120, `${label}: the name column's length`);
      assert.deepStrictEqual([...table.keys.keys()], ['new_namekey'], `${label}: the key`);
      assert.deepStrictEqual([...table.columns.keys()].filter((c) => c.startsWith('new_')).sort(), ['new_attachment', 'new_name', 'new_title'], `${label}: the columns`);
      assert.strictEqual(run.dv.log.filter((r) => /\/Keys$/.test(r.path) && !/^\(503\)/.test(r.path)).length, 1, `${label}: the key is asked for once`);
    }
  }
});
// What `owedLengths` — the Map a halted attempt leaves, from a table's logical name to what is owed for it — holds, and what an attempt
// that is handed one does with it, without the retry loop around them. Two attempts over the same stub: a second SDK over the first's
// transport is a new process finding what the first left.
async function provisionAgain(dv, spec, options = {}) {
  const sdk = await realSdk(dv.httpClient, options.sdkOptions);
  const events = [];
  const warnings = [];
  const owedLengths = options.owedLengths || new Map();
  const error = await provisionDataModel({
    sdk, provision: sdk, runner: makeRunner({ emit: (e) => events.push(e), total: 99 }), spec, apply: true, preResolvedLanguageCode: 1033,
    provisionedLanguages: async () => [1033, 3082], sleep: async () => {}, warn: (m) => warnings.push(m), owedLengths,
  }).then(() => null, (err) => err);
  return { events, warnings, owedLengths, error };
}
const refusal = () => ({ status: 400, headers: {}, body: { error: { message: 'The attribute cannot be changed right now' } } });
// What a table the build created and could not set the length of is recorded as: the names, the length asked, whether an attempt tried
// it, and the MetadataIds of the table and of its name column — the ids that tell this table from another that comes to answer to the
// same name. The column's is there because the attempt read the column before its update was refused.
const DEBT = { table: 'new_ticket', column: 'new_name', asked: 120, tried: true, tableId: tableId('new_ticket'), columnId: attributeId('new_ticket', 'new_name') };

test('owedLengths: a table the build creates is owed until its length step is done, and is left out once it is paid', async () => {
  const owed = new Map();
  const paid = await provisionOver(oneTable([], asksFor(120)), { owedLengths: owed });
  assert.deepStrictEqual([...owed], [], 'the step set the length: nothing is owed');
  assert.strictEqual(paid.dv.tables.get('new_ticket').primaryLength, 120);
  const unpaid = await provisionOver(oneTable([], asksFor(120)), { owedLengths: owed, dataverse: { updateFails: refusal } });
  assert.deepStrictEqual([...owed], [['new_ticket', DEBT]], 'a step that failed leaves the table owed, and says it was tried');
  assert.strictEqual(unpaid.warnings.length, 1);
  const none = new Map();
  await provisionOver(oneTable([], { schemaName: 'new_name', displayName: 'Name' }), { owedLengths: none });
  assert.deepStrictEqual([...none], [], 'a spec that asks for no length owes none');
  const read = new Map();
  await provisionOver(oneTable([], asksFor(120)), { owedLengths: read, dataverse: { lengthRead: () => ({ status: 500, headers: {}, body: { error: { message: 'An unexpected error occurred.' } } }) } });
  assert.deepStrictEqual([...read.keys()], ['new_ticket'], 'a length that could not even be read is owed too');
});

test('owedLengths: a table found after its create, or one that already existed, is never owed', async () => {
  const lost = new Map();
  await provisionOver(oneTable([], asksFor(120)), { owedLengths: lost, dataverse: { createCommitsThenFails: lostAnswer } });
  assert.deepStrictEqual([...lost], [], 'nothing shows that this build made the table found after its create');
  const dv = fakeDataverse(OVERRIDING);
  await provisionAgain(dv, oneTable([], asksFor(120)));
  const rebuilt = await provisionAgain(dv, oneTable([], asksFor(120)));
  assert.deepStrictEqual([...rebuilt.owedLengths], [], 'an existing table');
  assert.deepStrictEqual(lengthEvents(rebuilt).map((e) => [e.status, e.label]), [['skip', 'primary column length new_ticket.new_name (table exists — kept)']]);
});

test('owedLengths: handed a table an earlier attempt created, the phase sets its length and says it was owed, instead of keeping the table as it finds it', async () => {
  let blocked = true;
  const dv = fakeDataverse({ updateFails: () => (blocked ? refusal() : null) });
  const spec = oneTable([textColumn('new_a')], asksFor(120));
  const owed = new Map();
  await provisionAgain(dv, spec, { owedLengths: owed });
  assert.strictEqual(dv.tables.get('new_ticket').primaryLength, 850, 'the first attempt could not set it');
  assert.deepStrictEqual([...owed], [['new_ticket', DEBT]]);
  blocked = false;
  const retry = await provisionAgain(dv, spec, { owedLengths: owed });
  assert.deepStrictEqual(retry.events.filter((e) => e.status !== 'start').map((e) => [e.status, e.label]), [
    ['skip', 'table new_ticket (exists — reuse)'],
    ['skip', 'column new_ticket.new_a (exists)'],
    ['ok', `primary column length new_ticket.new_name -> 120 (${OWED})`],
  ], 'the step is the last of the phase, narrated once, and it is not the "table exists — kept" skip');
  assert.strictEqual(dv.tables.get('new_ticket').primaryLength, 120);
  assert.deepStrictEqual([...owed], [], 'and it is paid');
  assert.deepStrictEqual(retry.warnings, []);
});

test('owedLengths: a debt whose column already has the length is a skip that says so — an update can land although its answer was lost', async () => {
  let blocked = true;
  const dv = fakeDataverse({ updateFails: () => (blocked ? refusal() : null) });
  const spec = oneTable([], asksFor(120));
  const owed = new Map();
  await provisionAgain(dv, spec, { owedLengths: owed });
  dv.tables.get('new_ticket').primaryLength = 120;
  blocked = false;
  const updatesBefore = puts({ dv }).length;
  const retry = await provisionAgain(dv, spec, { owedLengths: owed });
  assert.deepStrictEqual(lengthEvents(retry).map((e) => [e.status, e.label]), [['skip', `primary column length new_ticket.new_name (already 120; ${OWED})`]]);
  assert.strictEqual(puts({ dv }).length, updatesBefore, 'nothing is written');
  assert.deepStrictEqual([...owed], []);
});

test('owedLengths: a debt that fails again stays owed — and is told it was tried, so a build that stops for good does not try it a second time', async () => {
  const dv = fakeDataverse({ updateFails: refusal });
  const spec = oneTable([], asksFor(120));
  const owed = new Map();
  await provisionAgain(dv, spec, { owedLengths: owed });
  owed.get('new_ticket').tried = false;
  const retry = await provisionAgain(dv, spec, { owedLengths: owed });
  assert.deepStrictEqual(lengthEvents(retry).map((e) => [e.status, e.label]), [['error', `primary column length new_ticket.new_name -> 120 (${OWED})`]]);
  assert.strictEqual(retry.warnings.length, 1);
  assert.deepStrictEqual([...owed], [['new_ticket', DEBT]]);
});

test('owedLengths: a debt is paid even when the phase halts before it reaches the table, and the halt is still the error that is thrown', async () => {
  let blocked = true;
  const dv = fakeDataverse({ updateFails: () => (blocked ? refusal() : null) });
  const spec = oneTable([textColumn('new_a')], asksFor(120));
  const owed = new Map();
  await provisionAgain(dv, spec, { owedLengths: owed });
  blocked = false;
  // The phase starts with a global choice, whose create is refused: nothing of the table loop runs.
  const halting = { ...spec, globalChoices: [{ name: 'new_cat', options: ['A', 'B'] }] };
  const post = dv.httpClient.post;
  dv.httpClient.post = async (url, body, options) => (/\/GlobalOptionSetDefinitions$/.test(String(url)) ? { status: 503, headers: {}, body: { error: { message: 'Service Unavailable' } } } : post(url, body, options));
  const retry = await provisionAgain(dv, halting, { owedLengths: owed });
  assert.ok(retry.error instanceof BuildHalt && /global choice new_cat/.test(retry.events.filter((e) => e.status === 'error')[0].label), 'the halt is the global choice\'s');
  assert.strictEqual(dv.tables.get('new_ticket').primaryLength, 120, 'the debt was paid');
  assert.deepStrictEqual([...owed], []);
  assert.deepStrictEqual(lengthEvents(retry).map((e) => [e.status, e.label]), [['ok', `primary column length new_ticket.new_name -> 120 (${OWED})`]]);
});

test('owedLengths: a debt for a table the spec asks no length of is dropped, and a debt nothing in the spec matches is left alone', async () => {
  const dv = fakeDataverse(OVERRIDING);
  await provisionAgain(dv, oneTable([], { schemaName: 'new_name', displayName: 'Name' }));
  const before = dv.log.length;
  const owed = new Map([['new_ticket', { ...DEBT, tried: false }], ['new_elsewhere', { table: 'new_elsewhere', column: 'new_name', asked: 50, tried: false }]]);
  const retry = await provisionAgain(dv, oneTable([], { schemaName: 'new_name', displayName: 'Name' }), { owedLengths: owed });
  assert.deepStrictEqual(lengthEvents(retry), [], 'no length is asked, so no step');
  assert.deepStrictEqual(dv.log.slice(before).filter((r) => r.method !== 'GET'), [], 'and nothing is written');
  assert.deepStrictEqual([...owed.keys()], ['new_elsewhere']);
});

test('settleOwedLengths: a build that stops for good sets what no attempt got as far as — once, and what an attempt already tried is left alone', async () => {
  const { settleOwedLengths } = require('../lib/sdk-build.js');
  let blocked = true;
  const dv = fakeDataverse({ updateFails: () => (blocked ? refusal() : null) });
  const spec = oneTable([], asksFor(120));
  await provisionAgain(dv, spec);
  const sdk = await realSdk(dv.httpClient);
  const warnings = [];
  const settle = (owed) => settleOwedLengths({ sdk, provision: sdk, spec, owed, warn: (m) => warnings.push(m), sleep: async () => {} });
  const updates = () => puts({ dv }).length;
  const refusedAtFirst = updates();

  await settle([{ ...DEBT, tried: true }]);
  assert.strictEqual(updates(), refusedAtFirst, 'an attempt tried this one, and the build would only fail again: nothing is written');
  assert.strictEqual(dv.log.filter((r) => /StringAttributeMetadata\?\$select=MaxLength$/.test(r.path)).length, 1, 'only the first attempt read it');

  await settle([{ ...DEBT, tried: false }]);
  assert.strictEqual(warnings.length, 1, 'a settle that cannot set the length warns once');
  assert.match(warnings[0], /^could not set the length of the primary name column new_ticket\.new_name to 120 .* the platform made 850: /);
  assert.strictEqual(dv.tables.get('new_ticket').primaryLength, 850);

  blocked = false;
  await settle([{ ...DEBT, tried: false }]);
  assert.strictEqual(warnings.length, 1, 'and says nothing when it succeeds');
  assert.strictEqual(dv.tables.get('new_ticket').primaryLength, 120, 'the length is set');

  for (const nothing of [undefined, null, [], [{}], [{ table: 'new_nowhere', column: 'new_name', asked: 5, tried: false }], 'new_ticket']) await settle(nothing);
  assert.strictEqual(warnings.length, 1, 'nothing owed, or owed for a table the spec has no such entity for: nothing happens');
  await settleOwedLengths({ sdk: null, provision: null, spec, owed: [{ ...DEBT, tried: false }], warn: (m) => warnings.push(m) });
  assert.strictEqual(warnings.length, 2, 'and an SDK that is not there is a warning, never a throw');
});

test('an attempt that halts before its data-model phase hands on what it was given, unpaid and untried — and a build that stops there settles it', async () => {
  const { runSdkBuild, settleOwedLengths } = require('../lib/sdk-build.js');
  let blocked = true;
  const dv = fakeDataverse({ updateFails: () => (blocked ? refusal() : null) });
  const spec = oneTable([], asksFor(120));
  const owed = new Map();
  await provisionAgain(dv, spec, { owedLengths: owed });
  assert.strictEqual(dv.tables.get('new_ticket').primaryLength, 850, 'the first attempt made the table and could not set its length');
  // The next attempt halts in its first phase, long before the data-model phase.
  const stub = { queryRecords: async () => { throw new Error('the environment is not answering'); } };
  const halted = await runSdkBuild(spec, { sdk: stub, provisionSdk: stub, apply: true, phases: ['solution'], owedLengths: [...owed.values()] }).then(() => null, (err) => err);
  assert.match(halted.message, /not answering/);
  assert.deepStrictEqual(halted.owedLengths, [{ ...DEBT, tried: false }], 'what it was handed, nobody has tried it');
  assert.strictEqual(Object.keys(halted).includes('owedLengths'), false, 'and it rides along, never into a serialized error');
  // No retry follows: the settle sets it.
  blocked = false;
  const sdk = await realSdk(dv.httpClient);
  await settleOwedLengths({ sdk, provision: sdk, spec, owed: halted.owedLengths, warn: (m) => assert.fail(`no warning expected: ${m}`), sleep: async () => {} });
  assert.strictEqual(dv.tables.get('new_ticket').primaryLength, 120);
});

test('runSdkBuild carries nothing on a halt when nothing is owed and nothing was handed to it', async () => {
  const { runSdkBuild } = require('../lib/sdk-build.js');
  const stub = { queryRecords: async () => { throw new Error('the environment is not answering'); } };
  for (const owedLengths of [undefined, [], 'new_ticket', [null, 7, {}, { table: '' }]]) {
    const halted = await runSdkBuild(oneTable([], asksFor(120)), { sdk: stub, provisionSdk: stub, apply: true, phases: ['solution'], owedLengths }).then(() => null, (err) => err);
    assert.match(halted.message, /not answering/);
    assert.strictEqual(halted.owedLengths, undefined, JSON.stringify(owedLengths));
  }
});

test('the plan lists a key that waits for the name column length after the length steps, where the build makes it — and every other key where it always was', async () => {
  const { planFor } = require('../lib/sdk-build.js');
  const labels = (spec) => planFor(spec, { phases: ['data-model'] }).map((item) => item.label);
  assert.deepStrictEqual(labels(KEYED_PAIR({ schemaName: 'new_k', columns: ['new_n'] })), [
    'table new_a ("A")', 'column new_a.new_x (Text)', 'table new_b ("B")', 'relationship 1:N new_a->new_b', 'primary column length new_a.new_n', 'alt key new_a.new_k',
  ]);
  assert.deepStrictEqual(labels(KEYED_PAIR({ schemaName: 'new_k', columns: ['new_x'] })), [
    'table new_a ("A")', 'column new_a.new_x (Text)', 'alt key new_a.new_k', 'table new_b ("B")', 'relationship 1:N new_a->new_b', 'primary column length new_a.new_n',
  ]);
  assert.deepStrictEqual(labels(KEYED_PAIR({ schemaName: 'new_k', columns: ['new_n'] }, { schemaName: 'new_n' })), [
    'table new_a ("A")', 'column new_a.new_x (Text)', 'alt key new_a.new_k', 'table new_b ("B")', 'relationship 1:N new_a->new_b',
  ], 'with no length asked there is no length step to wait for');
  assert.deepStrictEqual(labels(KEYED_PAIR({ schemaName: 'new_k', columns: ['new_n'], displayName: { 1033: 'Key', 3082: 'Clave' } })), [
    'table new_a ("A")', 'column new_a.new_x (Text)', 'alt key new_a.new_k', 'table new_b ("B")', 'relationship 1:N new_a->new_b', 'primary column length new_a.new_n',
  ], 'a key labelled in several languages keeps its place');
  // A map of one language is the request a string is, whichever language that is: the plan does not need to know the build's.
  const waits = [
    'table new_a ("A")', 'column new_a.new_x (Text)', 'table new_b ("B")', 'relationship 1:N new_a->new_b', 'primary column length new_a.new_n', 'alt key new_a.new_k',
  ];
  const keeps = [
    'table new_a ("A")', 'column new_a.new_x (Text)', 'alt key new_a.new_k', 'table new_b ("B")', 'relationship 1:N new_a->new_b', 'primary column length new_a.new_n',
  ];
  const labelled = (languageCode, displayName) => ({ ...KEYED_PAIR({ schemaName: 'new_k', columns: ['new_n'], displayName }), languageCode });
  assert.deepStrictEqual(labels(KEYED_PAIR({ schemaName: 'new_k', columns: ['new_n'], displayName: { 1033: 'Key' } })), waits, 'a map of one language, in a spec that names no language');
  assert.deepStrictEqual(labels(labelled(1033, { 1033: 'Key' })), waits, 'the spec\'s language');
  assert.deepStrictEqual(labels(labelled(3082, { 3082: 'Clave' })), waits, 'whichever it is');
  assert.deepStrictEqual(labels(labelled(3082, { 1033: 'Key' })), waits, 'a language the spec does not write in is one label too');
  assert.deepStrictEqual(labels(labelled(3082, { 1033: 'Key', 3082: 'Clave' })), keeps, 'two languages are not');
});

test('keyWaitsForNameLength is the half of the rule the spec decides: the name column in the key, a length asked of it, and a label that is the request a plain string makes', () => {
  const { keyWaitsForNameLength, keyNeedsNameLength } = require('../lib/app-spec.js');
  const entity = (primaryAttribute) => ({ schemaName: 'new_a', primaryAttribute });
  const asked = { schemaName: 'new_Name', maxLength: 120 };
  const key = (columns, extra = {}) => ({ schemaName: 'new_k', columns, ...extra });
  assert.strictEqual(keyWaitsForNameLength(entity(asked), key(['NEW_NAME'])), true, 'logical names are lower case, whatever case the spec writes');
  assert.strictEqual(keyWaitsForNameLength(entity(asked), key(['new_x', 'new_name'])), true, 'among other columns');
  assert.strictEqual(keyWaitsForNameLength(entity(asked), key(['new_name'], { displayName: 'Name Key' })), true, 'a string label');
  assert.strictEqual(keyWaitsForNameLength(entity(asked), key(['new_x'])), false, 'another column');
  assert.strictEqual(keyWaitsForNameLength(entity({ schemaName: 'new_name' }), key(['new_name'])), false, 'no length asked');
  assert.strictEqual(keyWaitsForNameLength(entity({ ...asked, maxLength: null }), key(['new_name'])), false, 'a null length is none');
  // What goes out decides, not the shape of the value and not the language the build writes in: the SDK writes a string as one label in
  // the build's language, and a map as one label per language it names — so a label that goes out in ONE language is one label, whichever.
  const labelled = (displayName, language) => keyWaitsForNameLength(entity(asked), key(['new_name'], { displayName }), language);
  assert.strictEqual(labelled({ 1033: 'Key' }), true, 'a map of one language is the same request as the string');
  assert.strictEqual(labelled({ 3082: 'Clave' }), true, 'whichever language that is');
  assert.strictEqual(labelled('Clave'), true, 'a string is one label');
  assert.strictEqual(labelled({ 1033: 'Key', 3082: 'Clave' }), false, 'a label in several languages');
  assert.strictEqual(labelled({}), false, 'a map of no language');
  assert.strictEqual(labelled({ 'en-US': 'Key' }), false, 'a key that is not an LCID');
  for (const language of [undefined, null, 1033, 3082, '3082', 'x']) {
    assert.strictEqual(labelled({ 1033: 'Key' }, language), true, `a language the caller still passes (${language}) changes nothing: a map of one language`);
    assert.strictEqual(labelled({ 3082: 'Clave' }, language), true, `${language}: whichever language the map names`);
    assert.strictEqual(labelled('Clave', language), true, `${language}: a string`);
    assert.strictEqual(labelled({ 1033: 'Key', 3082: 'Clave' }, language), false, `${language}: several languages`);
  }
  // The half that does not look at the label: the columns and the length, which is what the build also needs to say that a key over the name column is in the way.
  assert.strictEqual(keyNeedsNameLength(entity(asked), key(['new_name'], { displayName: { 1033: 'Key', 3082: 'Clave' } })), true, 'a key in several languages needs it as much as any');
  assert.strictEqual(keyNeedsNameLength(entity(asked), key(['new_x'])), false);
  assert.strictEqual(keyNeedsNameLength(entity({ schemaName: 'new_name' }), key(['new_name'])), false);
  for (const [what, e, k] of [
    ['no key', entity(asked), undefined],
    ['no columns', entity(asked), { schemaName: 'new_k' }],
    ['columns that are not a list', entity(asked), { schemaName: 'new_k', columns: 'new_name' }],
    ['no primary attribute', { schemaName: 'new_a' }, key(['new_name'])],
    ['no entity', undefined, key(['new_name'])],
  ]) {
    assert.strictEqual(keyWaitsForNameLength(e, k), false, `${what}: false, never a throw`);
    assert.strictEqual(keyNeedsNameLength(e, k), false, `${what}: false, never a throw`);
  }
});

test('a spec with a key that waits narrates exactly the steps the plan has, so [n/total] holds, and ends on the key', async () => {
  const { planFor } = require('../lib/sdk-build.js');
  for (const [what, spec, dataverse] of [
    ['the platform ignores the length', keyedTable([NAME_KEY]), {}],
    ['the platform keeps the length', keyedTable([NAME_KEY]), HONOURING],
  ]) {
    const run = await provisionOver(spec, { dataverse });
    const planned = planFor(spec, { phases: ['data-model'] });
    assert.strictEqual(run.events.filter((e) => e.status !== 'start').length, planned.length, `${what}: as many steps as the plan has`);
    const last = run.events[run.events.length - 1];
    assert.deepStrictEqual([last.label, last.n], ['alt key new_ticket.new_namekey', planned.length], `${what}: the last step is the key, and n has reached the total`);
  }
});

// --- a length is paid to the table it was owed for --------------------------------------------------------------------------------
// A debt names a table, and the build waits at least three seconds before it retries (backoffMs, build-model-app.js): long enough for
// another maker to delete that table and make it again. The same logical names then answer for a table this build did not create,
// and the build — which never writes to an existing table's name column, because a rebuild must not shorten a column that may hold
// data — must not shorten that one either. So the record keeps the MetadataId of the table the attempt created, and of its name
// column once the column has been read, and every way a debt is paid checks that the table now answering to the name is that one
// first: the retry, a phase that stops before it reaches the table, and the settle of a build that stops for good.
const isIdentityRead = (r) => r.method === 'GET' && /\?\$select=MetadataId,PrimaryNameAttribute$/.test(r.path);
const identityReads = (run) => gets(run).filter(isIdentityRead);
const isLengthRead = (r) => r.method === 'GET' && /StringAttributeMetadata\?\$select=MaxLength$/.test(r.path);
const leftAlone = /^did not set the length of the primary name column new_ticket\.new_name to 120 — /;
const NOT_THIS_BUILDS = 'skip primary column length new_ticket.new_name (not the table the build created — kept)';
const unavailable = () => ({ status: 503, headers: {}, body: { error: { message: 'Service Unavailable' } } });

test('a table another maker made again while the build waited to retry is not the one the length was owed for: its name column is left alone, and the retry says so', async () => {
  const run = await buildWithRetries(retriedTicket({ key: false }), { faults: { createFile: 1, setLength: 1, between: (dv) => replaceTable(dv, 'new_ticket') } });
  assert.strictEqual(run.result.ok, true, 'the build completes');
  assert.strictEqual(run.retries, 1);
  const replacement = run.dv.tables.get('new_ticket');
  assert.strictEqual(replacement.id, REPLACEMENT_ID, 'the table that answers to the name is the one the other maker made');
  assert.strictEqual(replacement.primaryLength, 600, 'and its name column has the length that maker gave it');
  assert.deepStrictEqual(run.requests(2).filter((r) => r.method === 'PUT'), [], 'the retry updated no column');
  assert.deepStrictEqual(run.steps(2, /^primary column length /), [NOT_THIS_BUILDS], 'it is narrated as a table the build leaves alone, not as the step the build owed');
  const warned = run.warnings.filter((w) => w.attempt === 2).map((w) => w.text);
  assert.strictEqual(warned.length, 1, 'with one warning');
  assert.match(warned[0], leftAlone);
  assert.match(warned[0], /the table new_ticket is not the one this build created \(it was deleted and created again, or replaced, after the build created it\)/);
  assert.match(warned[0], /never writes to a table it did not create, so the column is left as it is \(change it in Maker if the length matters\)$/);
  assert.deepStrictEqual(run.attempts[1].owedIn.map((d) => d.table), ['new_ticket'], 'the retry was handed the debt');
});

test('a key that waited for the length of such a table is made as the build makes a key on any table it found: the platform decides, not a length the build never set', async () => {
  const run = await buildWithRetries(retriedTicket(), { faults: { createFile: 1, setLength: 1, between: (dv) => replaceTable(dv, 'new_ticket', { length: 300 }) } });
  assert.strictEqual(run.result.ok, true);
  const replacement = run.dv.tables.get('new_ticket');
  assert.strictEqual(replacement.primaryLength, 300, 'the name column is as the other maker left it');
  assert.deepStrictEqual([...replacement.keys.keys()], ['new_namekey'], 'and the key is made over it');
  assert.deepStrictEqual(run.requests(2).filter((r) => r.method === 'PUT'), []);
  assert.deepStrictEqual(run.steps(2, /^(primary column length|alt key) /), [NOT_THIS_BUILDS, 'ok alt key new_ticket.new_namekey']);
});

test('owedLengths: a debt is not paid to a table that is not the one it was owed for even when the phase halts before it reaches the table — and the halt is still what is thrown', async () => {
  let blocked = true;
  const dv = fakeDataverse({ updateFails: () => (blocked ? refusal() : null) });
  const spec = oneTable([textColumn('new_a')], asksFor(120));
  const owed = new Map();
  await provisionAgain(dv, spec, { owedLengths: owed });
  blocked = false;
  replaceTable(dv, 'new_ticket');
  // The phase starts with a global choice, whose create is refused: nothing of the table loop runs.
  const halting = { ...spec, globalChoices: [{ name: 'new_cat', options: ['A', 'B'] }] };
  const post = dv.httpClient.post;
  dv.httpClient.post = async (url, body, options) => (/\/GlobalOptionSetDefinitions$/.test(String(url)) ? unavailable() : post(url, body, options));
  const updatesBefore = puts({ dv }).length;
  const retry = await provisionAgain(dv, halting, { owedLengths: owed });
  assert.ok(retry.error instanceof BuildHalt && /global choice new_cat/.test(retry.events.filter((e) => e.status === 'error')[0].label), 'the halt is the global choice\'s');
  assert.strictEqual(puts({ dv }).length, updatesBefore, 'nothing was written to the table that is not the debt\'s');
  assert.strictEqual(dv.tables.get('new_ticket').primaryLength, 600);
  assert.deepStrictEqual([...owed], [], 'and the debt is dropped: it was not owed for this table');
  assert.deepStrictEqual(lengthEvents(retry).map((e) => [e.status, e.label]), [['skip', NOT_THIS_BUILDS.replace(/^skip /, '')]]);
  assert.strictEqual(retry.warnings.length, 1);
  assert.match(retry.warnings[0], leftAlone);
});

test('settleOwedLengths: a build that stops for good does not set the length of a table that is not the one the debt was owed for', async () => {
  const { settleOwedLengths } = require('../lib/sdk-build.js');
  let blocked = true;
  const dv = fakeDataverse({ updateFails: () => (blocked ? refusal() : null) });
  const spec = oneTable([], asksFor(120));
  const first = await provisionAgain(dv, spec);
  blocked = false;
  replaceTable(dv, 'new_ticket');
  const sdk = await realSdk(dv.httpClient);
  const warnings = [];
  const updatesBefore = puts({ dv }).length;
  await settleOwedLengths({ sdk, provision: sdk, spec, owed: [...first.owedLengths.values()].map((d) => ({ ...d, tried: false })), warn: (m) => warnings.push(m), sleep: async () => {} });
  assert.strictEqual(puts({ dv }).length, updatesBefore, 'nothing is written');
  assert.strictEqual(dv.tables.get('new_ticket').primaryLength, 600);
  assert.strictEqual(warnings.length, 1);
  assert.match(warnings[0], leftAlone);
  assert.strictEqual(identityReads({ dv }).length, 1, 'the table was asked for once');
  assert.strictEqual(dv.log.filter(isLengthRead).length, 1, 'and the column of the table that is not the debt\'s was not read: only the first attempt\'s read is there');
});

test('the final settle of a build that stops for good, after a retry that never reached the data-model phase, leaves a table another maker made again alone — and the halt is still what is reported', async () => {
  const { buildModelApp } = require('../build-model-app.js');
  const { runSdkBuild } = require('../lib/sdk-build.js');
  let blocked = true;
  let refuseFile = true;
  const dv = fakeDataverse({ updateFails: () => (blocked ? refusal() : null) });
  const post = dv.httpClient.post;
  dv.httpClient.post = async (url, body, options) => {
    if (refuseFile && body && body.SchemaName === 'new_attachment') { refuseFile = false; return unavailable(); }
    return post(url, body, options);
  };
  const sdk = await realSdk(dv.httpClient);
  const warnings = [];
  let attempts = 0;
  const error = await buildModelApp(retriedTicket({ key: false }), { apply: true, env: ORG, retryDelayMs: 0, maxRetries: 1 }, {
    sdk, provisionSdk: sdk, warn: (m) => warnings.push(m),
    sleep: async () => { blocked = false; replaceTable(dv, 'new_ticket'); },
    discoverOpDiffState: async () => ({ collision: { appExists: false, solutionExists: false }, forms: [], sitemap: null }),
    runBuild: async (built, options) => {
      attempts += 1;
      if (attempts === 1) return runSdkBuild(built, { ...options, phases: ['data-model'], preResolvedLanguageCode: 1033 });
      // The retry stops in its first phase, long before the data model: the environment denies the read.
      const denied = { queryRecords: async () => { throw Object.assign(new Error('permanent solution-read denial'), { statusCode: 403 }); } };
      return runSdkBuild(built, { ...options, sdk: denied, provisionSdk: denied, phases: ['solution'], preResolvedLanguageCode: 1033 });
    },
  }).then(() => null, (err) => err);
  assert.match(error && error.message, /permanent solution-read denial/, 'the halt of the retry is what is reported');
  assert.strictEqual(attempts, 2);
  assert.strictEqual(puts({ dv }).length, 1, 'only the first attempt\'s refused update: the settle wrote nothing');
  assert.strictEqual(dv.tables.get('new_ticket').primaryLength, 600);
  assert.strictEqual(warnings.filter((w) => leftAlone.test(w)).length, 1, 'and said why');
});

test('owedLengths: the record of a table the build created holds its MetadataId, and its name column\'s once the column has been read', async () => {
  const unpaid = new Map();
  await provisionOver(oneTable([], asksFor(120)), { owedLengths: unpaid, dataverse: { updateFails: refusal } });
  assert.deepStrictEqual([...unpaid.values()], [DEBT], 'the update was refused after the column was read: both ids');
  const unreadable = () => ({ status: 500, headers: {}, body: { error: { message: 'An unexpected error occurred.' } } });
  const { columnId, ...tableOnly } = DEBT;
  const unread = new Map();
  await provisionOver(oneTable([], asksFor(120)), { owedLengths: unread, dataverse: { lengthRead: unreadable } });
  assert.deepStrictEqual([...unread.values()], [tableOnly], 'a column that could not be read has no id to record: the table\'s id is the proof');
  // The retry that does read the column, once the table is proved to be the one, records the column too.
  const dv = fakeDataverse({ lengthRead: (n) => (n === 1 ? unreadable() : undefined), updateFails: refusal });
  const spec = oneTable([], asksFor(120));
  const owed = new Map();
  await provisionAgain(dv, spec, { owedLengths: owed });
  assert.deepStrictEqual([...owed.values()], [tableOnly]);
  await provisionAgain(dv, spec, { owedLengths: owed });
  assert.deepStrictEqual([...owed.values()], [DEBT]);
});

test('the identity read is made for a debt an earlier attempt carried, and for nothing else: a first build, a rebuild and the attempt that created the table send none', async () => {
  const first = await provisionOver(keyedTable([NAME_KEY]));
  assert.deepStrictEqual(identityReads(first), [], 'a first build');
  assert.strictEqual(lengthReads(first).length, 1);
  const before = first.dv.log.length;
  const rebuilt = await provisionAgain(first.dv, keyedTable([NAME_KEY]));
  assert.strictEqual(rebuilt.error, null);
  assert.deepStrictEqual(first.dv.log.slice(before).filter((r) => isIdentityRead(r) || isLengthRead(r) || r.method === 'PUT'), [], 'a rebuild that finds the table reads nothing of its name column and writes none');
  const run = await buildWithRetries(retriedTicket({ key: false }), { faults: { createFile: 2, setLength: 1 } });
  assert.strictEqual(run.result.ok, true);
  assert.deepStrictEqual([1, 2, 3].map((n) => run.requests(n).filter(isIdentityRead).length), [0, 1, 0], 'attempt 1 created the table, attempt 2 was handed the debt and asked once, and attempt 3 owed nothing');
});

test('a table that is no longer there is not owed a length: nothing is written, and the warning says so', async () => {
  const { settleOwedLengths } = require('../lib/sdk-build.js');
  let blocked = true;
  const dv = fakeDataverse({ updateFails: () => (blocked ? refusal() : null) });
  const spec = oneTable([], asksFor(120));
  await provisionAgain(dv, spec);
  blocked = false;
  dv.tables.delete('new_ticket');
  const sdk = await realSdk(dv.httpClient);
  const warnings = [];
  const updatesBefore = puts({ dv }).length;
  await settleOwedLengths({ sdk, provision: sdk, spec, owed: [{ ...DEBT, tried: false }], warn: (m) => warnings.push(m), sleep: async () => {} });
  assert.strictEqual(puts({ dv }).length, updatesBefore);
  assert.strictEqual(warnings.length, 1);
  assert.match(warnings[0], /^did not set the length of the primary name column new_ticket\.new_name to 120 — the table new_ticket this build created is no longer there, so the column is left as it is/);
});

test('where the read that would prove the table fails, nothing is written and the step fails — a 503 is the build\'s to retry, and the retry proves the table and pays', async () => {
  const run = await buildWithRetries(retriedTicket(), { dataverse: { identityRead: (n) => (n === 1 ? unavailable() : undefined) }, faults: { createFile: 1, setLength: 1 } });
  assert.strictEqual(run.result.ok, true);
  assert.strictEqual(run.retries, 2, 'attempt 2 could not prove the table and stopped at the key; attempt 3 paid');
  assert.deepStrictEqual(run.requests(2).filter((r) => r.method === 'PUT' || /\/Keys$/.test(r.path)), [], 'attempt 2 wrote nothing, not even the key');
  const steps = (n) => run.steps(n, /^(primary column length|alt key) /);
  assert.deepStrictEqual(steps(2), [`error primary column length new_ticket.new_name -> 120${OWED_NOTE}`, 'error alt key new_ticket.new_namekey']);
  assert.deepStrictEqual(steps(3), [`ok primary column length new_ticket.new_name -> 120${OWED_NOTE}`, 'ok alt key new_ticket.new_namekey']);
  const failedStep = run.events.find((e) => e.attempt === 2 && e.status === 'error' && /^primary column length/.test(e.label));
  assert.match(failedStep.detail, /^asked 120, it could not be confirmed that the table is the one this build created: could not read the table \(HTTP 503: Service Unavailable\)/);
  assert.strictEqual(run.dv.tables.get('new_ticket').primaryLength, 120);
  assert.deepStrictEqual([...run.dv.tables.get('new_ticket').keys.keys()], ['new_namekey']);
});

test('owedLengths: a debt is paid only as recorded — a spec that asks another column, or another length, of the table is not the spec the length was owed for', async () => {
  let blocked = true;
  const dv = fakeDataverse({ updateFails: () => (blocked ? refusal() : null) });
  const original = oneTable([{ schemaName: 'new_other', type: 'Text', maxLength: 700 }], asksFor(120));
  const owed = new Map();
  await provisionAgain(dv, original, { owedLengths: owed });
  blocked = false;
  const lengths = () => [dv.tables.get('new_ticket').primaryLength, dv.tables.get('new_ticket').columns.get('new_other').body.MaxLength];
  assert.deepStrictEqual(lengths(), [850, 700]);
  for (const [what, change, step, why] of [
    ['another column', (spec) => { spec.entities[0].primaryAttribute = { schemaName: 'new_other', displayName: 'Other', maxLength: 80 }; },
      ['skip', 'primary column length new_ticket.new_other (no longer what the spec asks — kept)'], /the spec no longer asks what the build owed \(new_name at 120 characters; it now asks new_other at 80\)/],
    ['another length', (spec) => { spec.entities[0].primaryAttribute.maxLength = 80; },
      ['skip', 'primary column length new_ticket.new_name (no longer what the spec asks — kept)'], /the spec no longer asks what the build owed \(new_name at 120 characters; it now asks new_name at 80\)/],
    ['no length', (spec) => { delete spec.entities[0].primaryAttribute.maxLength; }, null, /the spec no longer asks the table's name column for a length/],
  ]) {
    const debts = new Map([['new_ticket', { ...owed.get('new_ticket'), tried: false }]]);
    const revised = clone(original);
    change(revised);
    const updatesBefore = puts({ dv }).length;
    const run = await provisionAgain(dv, revised, { owedLengths: debts });
    assert.strictEqual(puts({ dv }).length, updatesBefore, `${what}: nothing is written`);
    assert.deepStrictEqual(lengths(), [850, 700], `${what}: neither the name column nor another column changed`);
    assert.deepStrictEqual([...debts], [], `${what}: the debt is dropped`);
    assert.deepStrictEqual(lengthEvents(run).map((e) => [e.status, e.label]), step ? [step] : [], `${what}: one step the plan has, or none where the plan has none`);
    assert.strictEqual(run.warnings.length, 1, `${what}: and one warning`);
    assert.match(run.warnings[0], /^did not set the length of the primary name column new_ticket\.new_name to 120 — /, what);
    assert.match(run.warnings[0], why, what);
  }
});

test('owedLengths: a debt that records no table id cannot be proved to be this table\'s: nothing is written, and it is said', async () => {
  let blocked = true;
  const dv = fakeDataverse({ updateFails: () => (blocked ? refusal() : null) });
  const spec = oneTable([], asksFor(120));
  await provisionAgain(dv, spec);
  blocked = false;
  const bare = { table: 'new_ticket', column: 'new_name', asked: 120, tried: false };
  const updatesBefore = puts({ dv }).length;
  const run = await provisionAgain(dv, spec, { owedLengths: new Map([['new_ticket', { ...bare }]]) });
  assert.strictEqual(puts({ dv }).length, updatesBefore);
  assert.strictEqual(dv.tables.get('new_ticket').primaryLength, 850);
  assert.deepStrictEqual(lengthEvents(run).map((e) => [e.status, e.label]), [['skip', 'primary column length new_ticket.new_name (nothing shows which table the build created — kept)']]);
  assert.strictEqual(run.warnings.length, 1);
  assert.match(run.warnings[0], /^did not set the length of the primary name column new_ticket\.new_name to 120 — nothing shows which table this build created, and it never writes to a table it did not create/);
  const { settleOwedLengths } = require('../lib/sdk-build.js');
  const sdk = await realSdk(dv.httpClient);
  const requests = dv.log.length;
  const warnings = [];
  await settleOwedLengths({ sdk, provision: sdk, spec, owed: [{ ...bare }], warn: (m) => warnings.push(m), sleep: async () => {} });
  assert.strictEqual(dv.log.length, requests, 'the settle sends nothing for it');
  assert.strictEqual(warnings.length, 1);
});

test('a table with the right id whose name column is not the one the debt recorded is left alone too', async () => {
  const gone = /^did not set the length of the primary name column new_ticket\.new_name to 120 — the table new_ticket this build created \(or its name column\) was deleted, or deleted and created again, while the build was setting its length, and the build never writes to a table it did not create/;
  for (const [what, change, step, why] of [
    ['its primary name column is another column now', (dv) => { dv.tables.get('new_ticket').primaryName = 'new_title'; },
      'primary column length new_ticket.new_name (not the name column the build created — kept)', /the primary name column of table new_ticket is new_title now, not new_name/],
    // The request that reads the column is addressed by the id the debt records, and the table has no column with it: a 404, like a table that is gone.
    ['its name column is another column of the same name', (dv) => { dv.tables.get('new_ticket').columns.get('new_name').row.MetadataId = attributeId('replacement.new_ticket', 'new_name'); },
      'primary column length new_ticket.new_name (the table the build created changed — kept)', gone],
  ]) {
    let blocked = true;
    const dv = fakeDataverse({ updateFails: () => (blocked ? refusal() : null) });
    const spec = oneTable([textColumn('new_title')], asksFor(120));
    const owed = new Map();
    await provisionAgain(dv, spec, { owedLengths: owed });
    blocked = false;
    change(dv);
    const updatesBefore = puts({ dv }).length;
    const run = await provisionAgain(dv, spec, { owedLengths: owed });
    assert.strictEqual(puts({ dv }).length, updatesBefore, `${what}: nothing is written`);
    assert.deepStrictEqual(lengthEvents(run).map((e) => [e.status, e.label]), [['skip', step]], what);
    assert.strictEqual(run.warnings.length, 1, what);
    assert.match(run.warnings[0], leftAlone, what);
    assert.match(run.warnings[0], why, what);
    assert.deepStrictEqual([...owed], [], `${what}: the debt is dropped`);
  }
});

test('an answer to the read of the column that is not the column the debt records, or that does not say which column it is, is not written to either', async () => {
  const OTHER = attributeId('replacement.new_ticket', 'new_name');
  const answer = (body) => () => ({ status: 200, headers: {}, body });
  for (const [what, recorded, read, step, why] of [
    ['an answer that names another column than the recorded one', true, answer({ MaxLength: 850, MetadataId: OTHER }),
      'primary column length new_ticket.new_name (not the name column the build created — kept)', /new_name is not the column this build created in new_ticket/],
    ['an answer that names no column, where the debt records one', true, answer({ MaxLength: 850 }),
      'primary column length new_ticket.new_name (not the name column the build created — kept)', /new_name is not the column this build created in new_ticket/],
    ['an answer that names no column, where the debt records none: there is no id to address the update by', false, answer({ MaxLength: 850 }),
      'primary column length new_ticket.new_name (nothing shows which column the build created — kept)', /carries no MetadataId, so nothing shows which column an update would write to/],
  ]) {
    const state = { blocked: true, read: null };
    const dv = fakeDataverse({
      updateFails: () => (state.blocked ? refusal() : null),
      lengthRead: (n) => (state.read ? state.read() : (n === 1 && !recorded ? unavailable() : undefined)),
    });
    const spec = oneTable([], asksFor(120));
    const owed = new Map();
    await provisionAgain(dv, spec, { owedLengths: owed });
    assert.strictEqual(owed.get('new_ticket').columnId !== undefined, recorded, `${what}: the debt ${recorded ? 'records' : 'does not record'} the column`);
    state.blocked = false;
    state.read = read;
    const updatesBefore = puts({ dv }).length;
    const run = await provisionAgain(dv, spec, { owedLengths: owed });
    assert.strictEqual(puts({ dv }).length, updatesBefore, `${what}: nothing is written`);
    assert.deepStrictEqual(lengthEvents(run).map((e) => [e.status, e.label]), [['skip', step]], what);
    assert.strictEqual(run.warnings.length, 1, what);
    assert.match(run.warnings[0], why, what);
  }
});

// --- the language a key's label goes out in -------------------------------------------------------------------------------------
// What matters to the order of a key is what the SDK sends for its label, not the shape of the value and not the language the build is
// authored in: a string, and a map that names one language, are ONE label, byte for byte (the SDK writes a string in the build's language
// and a map in the languages it names) — and one label is what a read that carries labels cannot strip. A label that goes out in several
// languages is the case the build keeps ahead of the length step, and where the platform then refuses the key for the length of its column,
// the build says so and what to do.
const MAP_KEY = (displayName) => ({ ...NAME_KEY, displayName });
const keyLabels = (run) => keyPosts(run).map((r) => r.body.DisplayName.LocalizedLabels.map((l) => [l.LanguageCode, l.Label]));

test('a key whose label is a map holding only the build\'s language is the request the string is, so it waits for the length too: its first build succeeds', async () => {
  const string = await provisionOver(keyedTable([NAME_KEY]));
  const map = await provisionOver(keyedTable([MAP_KEY({ 1033: NAME_KEY.displayName })]));
  assert.deepStrictEqual(keyPosts(map).map((r) => r.body), keyPosts(string).map((r) => r.body), 'the same request, byte for byte');
  assert.deepStrictEqual(keyLabels(map), [[[1033, 'Name Key']]]);
  assert.deepStrictEqual(map.dv.refusals, [], 'the platform refused nothing');
  assert.strictEqual(map.dv.tables.get('new_ticket').primaryLength, 120);
  assert.deepStrictEqual([...map.dv.tables.get('new_ticket').keys.keys()], ['new_namekey'], 'and the key exists after the first build');
  assert.deepStrictEqual(finished(map).slice(-2), [['ok', 'primary column length new_ticket.new_name -> 120'], ['ok', 'alt key new_ticket.new_namekey']]);
  assert.deepStrictEqual(map.warnings, []);
});

test('what is sent decides, not the language the build is authored in: a key whose label goes out in ONE language waits for the length, whatever that language is', async () => {
  for (const [what, authoring, displayName] of [
    ['a string', 3082, 'Clave del nombre'],
    ['a map of the authoring language', 3082, { 3082: 'Clave del nombre' }],
    ['a map of the environment\'s base language, under another authoring language', 3082, { 1033: 'Name Key' }],
    ['a map of another language than the authoring one, under the base language', 1033, { 3082: 'Clave del nombre' }],
  ]) {
    const run = await provisionOver(keyedTable([MAP_KEY(displayName)]), { preResolvedLanguageCode: authoring, capture: true });
    assert.strictEqual(run.error, undefined, `${what}: the first build succeeds`);
    const lines = run.dv.log.map(requestLine);
    assert.ok(lines.findIndex((l) => /\/Keys$/.test(l)) > lines.findIndex((l) => l.startsWith('PUT ')), `${what}: the key is made after the length step`);
    assert.deepStrictEqual([...run.dv.tables.get('new_ticket').keys.keys()], ['new_namekey'], what);
    assert.deepStrictEqual(run.dv.refusals, [], `${what}: the platform refused nothing`);
    assert.deepStrictEqual(run.warnings, [], what);
  }
  // The same request in every authoring language: the key's label goes out as it names itself, so where it is made cannot depend on the build's language.
  const base = await provisionOver(keyedTable([MAP_KEY({ 1033: 'Name Key' })]), { preResolvedLanguageCode: 1033 });
  const other = await provisionOver(keyedTable([MAP_KEY({ 1033: 'Name Key' })]), { preResolvedLanguageCode: 3082 });
  assert.deepStrictEqual(keyPosts(other).map((r) => r.body), keyPosts(base).map((r) => r.body), 'the one-language map is the same key request under either authoring language');
  assert.deepStrictEqual(keyLabels(other), [[[1033, 'Name Key']]]);
  assert.deepStrictEqual(finished(other).slice(-2), finished(base).slice(-2), 'and the same last two steps: the length, then the key');
});

test('a key labelled in several languages keeps its place ahead of the length step, and where the platform then refuses it the build says why and what to do — and the run that follows makes it, with both labels', async () => {
  const labelled = MAP_KEY({ 1033: 'Name Key', 3082: 'Clave del nombre' });
  const run = await provisionOver(keyedTable([labelled]), { capture: true });
  assert.ok(run.error instanceof BuildHalt, 'the build stops where the platform refuses the key');
  assert.deepStrictEqual(run.events.filter((e) => e.status === 'error').map((e) => e.label), ['alt key new_ticket.new_namekey'], 'at the key');
  assert.match(run.error.message, /1700 bytes/, 'with the platform\'s own words');
  assert.notStrictEqual(run.error.code, 'alt-key-name-length-not-set', 'this is the platform\'s refusal: the key was asked for');
  const lines = run.dv.log.map(requestLine);
  assert.ok(lines.findIndex((l) => /\/Keys$/.test(l)) < lines.findIndex((l) => l.startsWith('PUT ')), 'the key is asked for before the length step, as it always was');
  assert.strictEqual(run.dv.tables.get('new_ticket').primaryLength, 120, 'the length is set as the build stops');
  const advice = run.warnings.filter((w) => /alt key new_ticket\.new_namekey/.test(w));
  assert.strictEqual(advice.length, 1, 'one warning names the key');
  assert.match(advice[0], /It is over the name column new_name of a table this build created/);
  assert.match(advice[0], /its label is in several languages \(1033, 3082\), so the build creates it before it sets that column/, 'says why this key was made first, from the languages the label goes out in');
  assert.doesNotMatch(advice[0], /more than the build's language/, 'and not in terms of the build\'s language: only what goes out matters');
  assert.match(advice[0], /900 bytes/, 'and what the platform refused it for');
  assert.match(advice[0], /run the build again/, 'and what to do');
  assert.match(advice[0], /A key labelled in one language is created after the length is set/, 'and how to have it made first time');
  const again = await provisionAgain(run.dv, keyedTable([labelled]));
  assert.strictEqual(again.error, null, 'the run that follows finds the table with the length set');
  assert.deepStrictEqual([...run.dv.tables.get('new_ticket').keys.keys()], ['new_namekey']);
  assert.deepStrictEqual(keyLabels({ dv: run.dv }).slice(-1), [[[1033, 'Name Key'], [3082, 'Clave del nombre']]], 'and creates the key with both of its labels');
});

test('a key labelled in several languages that the platform accepts, or refuses for another reason, is not warned about', async () => {
  const labelled = MAP_KEY({ 1033: 'Name Key', 3082: 'Clave del nombre' });
  const honoured = await provisionOver(keyedTable([labelled]), { dataverse: HONOURING });
  assert.deepStrictEqual(honoured.warnings, [], 'where the environment keeps the length asked the key is made, and nothing is wrong');
  assert.strictEqual(honoured.dv.tables.get('new_ticket').keys.size, 1);
  const refuse = () => ({ status: 400, headers: {}, body: { error: { message: 'The key column new_code is not valid in a key.' } } });
  const another = await provisionOver(keyedTable([{ ...labelled, columns: ['new_code'] }]), { dataverse: { keyFails: refuse }, capture: true });
  assert.ok(another.error instanceof BuildHalt);
  assert.deepStrictEqual(another.warnings, [], 'a key over another column has nothing to do with the name column');
  const unasked = await provisionOver(keyedTable([labelled], { schemaName: 'new_name', displayName: 'Name' }), { dataverse: { keyFails: refuse }, capture: true });
  assert.ok(unasked.error instanceof BuildHalt);
  assert.deepStrictEqual(unasked.warnings, [], 'nor has a spec that gives the name column no length');
  const dv = fakeDataverse({ keyFails: refuse });
  await provisionAgain(dv, keyedTable([]));
  const existing = await provisionAgain(dv, keyedTable([labelled]));
  assert.ok(existing.error instanceof BuildHalt, 'a table that already existed');
  assert.deepStrictEqual(existing.warnings, [], 'is not one the build set the length of, so the advice does not apply');
});

// --- the dry run and the apply agree on where a key goes ------------------------------------------------------------------------
// The plan lists the steps in the order the apply takes them. Where a key over the name column goes depends only on what the key is
// sent as, so the plan cannot disagree with the apply about it — whichever language the spec, the command line and the label name. This
// goes through the entry both of them share (runSdkBuild), with the same spec and the same options: only `apply` differs.
test('the dry-run plan and the apply put a key over the name column in the same place, whichever language the spec, the command line and the label name', async () => {
  const { runSdkBuild } = require('../lib/sdk-build.js');
  const kinds = (labels) => labels.filter((l) => /^(alt key|primary column length) /.test(l)).map((l) => (l.startsWith('alt key') ? 'key' : 'length'));
  for (const specLanguage of [undefined, 1033, 3082]) {
    for (const override of [undefined, 1033, 3082]) {
      for (const [what, displayName] of [['a string', 'Name Key'], ['a map of 1033', { 1033: 'Name Key' }], ['a map of 3082', { 3082: 'Clave' }], ['a map of both', { 1033: 'Name Key', 3082: 'Clave' }]]) {
        const spec = keyedTable([MAP_KEY(displayName)]);
        if (specLanguage) spec.languageCode = specLanguage;
        const dv = fakeDataverse(HONOURING);
        const sdk = await realSdk(dv.httpClient);
        // What the CLI hands the engine: the command line's language, and the language it resolved (the command line's, else the spec's, else the environment's).
        const options = {
          sdk, provisionSdk: sdk, phases: ['data-model'], livePlan: false, ...(override ? { languageCode: override } : {}),
          preResolvedLanguageCode: override || specLanguage || 1033, provisionedLanguages: async () => [1033, 3082],
        };
        const dry = await runSdkBuild(spec, { ...options, apply: false });
        const events = [];
        const applied = await runSdkBuild(spec, { ...options, apply: true, emit: (e) => events.push(e) });
        assert.strictEqual(applied.ok, true);
        assert.deepStrictEqual(
          kinds(dry.plan), kinds(events.filter((e) => e.status !== 'start').map((e) => e.label)),
          `${what}: the spec names ${specLanguage || 'no language'}, the command line ${override || 'none'}`,
        );
      }
    }
  }
});

test('a spec written in one language and built with the command line\'s other language: the plan lists a one-language key where the apply makes it, after the length', async () => {
  const { runSdkBuild } = require('../lib/sdk-build.js');
  const spec = keyedTable([MAP_KEY({ 3082: 'Clave' })]);
  spec.languageCode = 3082;
  const dv = fakeDataverse(HONOURING);
  const sdk = await realSdk(dv.httpClient);
  const options = { sdk, provisionSdk: sdk, phases: ['data-model'], livePlan: false, languageCode: 1033, preResolvedLanguageCode: 1033, provisionedLanguages: async () => [1033, 3082] };
  const dry = await runSdkBuild(spec, { ...options, apply: false });
  const events = [];
  await runSdkBuild(spec, { ...options, apply: true, emit: (e) => events.push(e) });
  const relevant = (labels) => labels.filter((l) => /^(alt key|primary column length) /.test(l));
  const expected = ['primary column length new_ticket.new_name', 'alt key new_ticket.new_namekey'];
  assert.deepStrictEqual(relevant(dry.plan), expected, 'the plan');
  assert.deepStrictEqual(relevant(events.filter((e) => e.status !== 'start').map((e) => e.label)).map((l) => l.replace(/ (->|\().*$/, '')), expected, 'the apply');
});

// --- what the warning for a length that could not be set promises ---------------------------------------------------------------
// "The rest of the build continues" is true only where nothing waits for the length. Where an alternate key does, the build stops at it,
// and the warning says that instead.
test('a length that could not be set: the warning promises the build goes on where nothing waits for the length, and says the build stops where a key does', async () => {
  const refuse = () => ({ status: 400, headers: {}, body: { error: { message: 'invalid length' } } });
  const nothing = await provisionOver(oneTable([textColumn('new_code')], asksFor(120)), { dataverse: { updateFails: refuse } });
  assert.strictEqual(nothing.warnings.length, 1);
  assert.match(nothing.warnings[0], /^could not set the length of the primary name column new_ticket\.new_name to 120 — it keeps the length the platform gave it, and the rest of the build continues: asked 120, the platform made 850: .*invalid length/);
  const elsewhere = await provisionOver(keyedTable([{ schemaName: 'new_codekey', columns: ['new_code'] }]), { dataverse: { updateFails: refuse } });
  assert.strictEqual(elsewhere.warnings.length, 1, 'a key that needs no length does not wait');
  assert.match(elsewhere.warnings[0], /and the rest of the build continues: /);
  const waiting = await provisionOver(keyedTable([NAME_KEY]), { dataverse: { updateFails: refuse }, capture: true });
  assert.strictEqual(waiting.error.code, 'alt-key-name-length-not-set', 'the build stops at the key');
  assert.strictEqual(waiting.warnings.length, 1);
  assert.match(waiting.warnings[0], /^could not set the length of the primary name column new_ticket\.new_name to 120 — it keeps the length the platform gave it, and the build stops at alt key new_ticket\.new_namekey, which is over that column and cannot be created while the column is that long: asked 120, the platform made 850: .*invalid length/);
  assert.doesNotMatch(waiting.warnings[0], /rest of the build continues/, 'it does not promise what the build is about to refuse');
  const two = await provisionOver(keyedTable([NAME_KEY, { schemaName: 'new_pairkey', columns: ['new_code', 'new_name'] }]), { dataverse: { updateFails: refuse }, capture: true });
  assert.match(two.warnings[0], /the build stops at alt keys new_ticket\.new_namekey, new_ticket\.new_pairkey, which are over that column/, 'every key that waits is named');
});

test('where the phase stops before the length step and a key that waits was not made, the warning says the key needs the length, instead of promising the build goes on', async () => {
  const doubles = orderDoubles({ failOn: (label) => label === 'createRelationship new_a_b' || label.startsWith('updateColumn') });
  const events = [];
  await assert.rejects(runOrder(doubles, KEYED_PAIR({ schemaName: 'new_k', columns: ['new_n'] }), events), /createRelationship new_a_b/);
  const warned = events.filter((e) => e.warning).map((e) => e.warning);
  assert.strictEqual(warned.length, 1);
  assert.match(warned[0], /^could not set the length of the primary name column new_a\.new_n to 120 — it keeps the length the platform gave it, and because the data-model phase stopped, and a run that finds the table already there leaves its name column as it is, change the length in Maker if it matters — it does for alt key new_a\.new_k, which is over that column and is refused while the column is that long: /);
  assert.doesNotMatch(warned[0], /rest of the build continues/);
  assert.ok(!doubles.calls.includes('createAlternateKey new_a.new_k'), 'the key was not made');
});

test('a key that could not wait for the length fails the way the step failed whatever the error is made of: its status is read on it and on what it wraps, and an explicit refusal to retry wins', async () => {
  const { isTransientHalt } = require('../build-model-app.js');
  for (const [what, error, transient] of [
    ['a 429 status', Object.assign(new Error('throttled'), { statusCode: 429 }), true],
    ['a 503 on the cause', new Error('wrapped', { cause: Object.assign(new Error('unavailable'), { statusCode: 503 }) }), true],
    ['a 403', Object.assign(new Error('forbidden'), { statusCode: 403 }), false],
    ['a 400', Object.assign(new Error('invalid length'), { statusCode: 400 }), false],
    ['a 503 that says it must not be retried', Object.assign(new Error('try again later'), { statusCode: 503, transient: false }), false],
    ['the same, deeper in the chain', new Error('try again later', { cause: Object.assign(new Error('stop'), { statusCode: 503, transient: false }) }), false],
    ['a SQL timeout in words', new Error('SQL timeout'), true],
  ]) {
    const dv = fakeDataverse();
    const sdk = await realSdk(dv.httpClient);
    sdk.updateColumn = async () => { throw error; };
    const warnings = [];
    const refused = await provisionDataModel({
      sdk, provision: sdk, runner: makeRunner({ emit: () => undefined, total: 99 }), spec: keyedTable([NAME_KEY]), apply: true, preResolvedLanguageCode: 1033,
      provisionedLanguages: async () => [1033, 3082], sleep: async () => {}, warn: (m) => warnings.push(m),
    }).then(() => null, (err) => err);
    assert.strictEqual(refused.code, 'alt-key-name-length-not-set', what);
    assert.strictEqual(isTransientHalt(refused), transient, what);
    assert.strictEqual(refused.recoverable, true, what);
    assert.deepStrictEqual(dv.log.filter((r) => /\/Keys$/.test(r.path)), [], `${what}: the key is not asked for`);
    assert.strictEqual(warnings.length, 1, what);
    assert.match(warnings[0], /and the build stops at alt key new_ticket\.new_namekey, which is over that column/, `${what}: the warning does not promise the build goes on`);
  }
});

// --- a debt is paid through the mutation itself ---------------------------------------------------------------------------------
// Which table answers to a name (the identity read) and the update of its name column are separate requests, and another maker can
// replace the table between any two of them. A check followed by an update that resolves the table or the column BY NAME again only
// moves the window — the replacement is then what the update finds, which is what the SDK's own updateColumn does. So a debt an earlier
// attempt carried is paid by requests addressed with the MetadataIds it records, the table's and the name column's: a table made again
// under the name has other ids, and an id that no table has any more answers 404, so the replacement cannot be the target of any request
// that follows the check, wherever in the payment it is made.
// See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/retrieve-metadata-name-metadataid

// Another maker deletes the table and makes it again at the worst moment: right after the build proved that the table which answers to
// the name is the one it created (the identity read), before the `before`-th request that follows it (1 is the very next one).
// `dv.swapped` says before which request that happened, and how many requests the build had sent by then.
function swapAfterIdentityRead(dv, { before = 1, logical = 'new_ticket' } = {}) {
  let proved = false;
  let seen = 0;
  dv.swapped = null;
  for (const method of ['get', 'put', 'post']) {
    const send = dv.httpClient[method];
    dv.httpClient[method] = async (url, ...rest) => {
      const path = decodeURIComponent(String(url).replace(API, ''));
      if (proved && dv.swapped === null && (seen += 1) === before) {
        replaceTable(dv, logical);
        dv.swapped = { before: `${method.toUpperCase()} ${path}`, sent: dv.log.length };
      }
      const answer = await send(url, ...rest);
      if (method === 'get' && isIdentityRead({ method: 'GET', path })) proved = true;
      return answer;
    };
  }
  return dv;
}

// The first attempt creates the table and cannot set its length (the update is refused), so the table is owed it, with the ids of the
// table and of its name column. The update is allowed from then on.
async function owingTicket(spec = oneTable([textColumn('new_a')], asksFor(120))) {
  const state = { blocked: true };
  const dv = fakeDataverse({ updateFails: () => (state.blocked ? refusal() : null) });
  const owed = new Map();
  await provisionAgain(dv, spec, { owedLengths: owed });
  state.blocked = false;
  return { dv, spec, owed };
}

test('a table made again at any moment after the build proved the debt is the table\'s — before the read of the column, of its definition, or the update — is never written to', async (t) => {
  const { settleOwedLengths } = require('../lib/sdk-build.js');
  const routes = {
    'the retry of a build': async (before) => {
      const run = await buildWithRetries(retriedTicket({ key: false }), { faults: { createFile: 1, setLength: 1 }, arrange: (dv) => swapAfterIdentityRead(dv, { before }) });
      assert.strictEqual(run.result.ok, true, 'the build completes');
      return { dv: run.dv, warnings: run.warnings.map((w) => w.text), steps: run.steps(2, /^primary column length /) };
    },
    'a phase that stops before it reaches the table': async (before) => {
      const { dv, spec, owed } = await owingTicket();
      swapAfterIdentityRead(dv, { before });
      const post = dv.httpClient.post;
      dv.httpClient.post = async (url, body, options) => (/\/GlobalOptionSetDefinitions$/.test(String(url)) ? unavailable() : post(url, body, options));
      const run = await provisionAgain(dv, { ...spec, globalChoices: [{ name: 'new_cat', options: ['A', 'B'] }] }, { owedLengths: owed });
      assert.ok(run.error instanceof BuildHalt, 'the halt is still what is thrown');
      return { dv, warnings: run.warnings, steps: lengthEvents(run).map((e) => `${e.status} ${e.label}`) };
    },
    'the settle of a build that stops for good': async (before) => {
      const { dv, spec, owed } = await owingTicket();
      swapAfterIdentityRead(dv, { before });
      const sdk = await realSdk(dv.httpClient);
      const warnings = [];
      await settleOwedLengths({ sdk, provision: sdk, spec, owed: [...owed.values()].map((d) => ({ ...d, tried: false })), warn: (m) => warnings.push(m), sleep: async () => {} });
      return { dv, warnings, steps: [] };
    },
  };
  for (const [route, pay] of Object.entries(routes)) {
    for (const before of [1, 2, 3]) {
      await t.test(`${route}: the table is made again before the ${['first', 'second', 'third'][before - 1]} request that follows the proof`, async () => {
        const { dv, warnings, steps } = await pay(before);
        assert.ok(dv.swapped, 'the table was made again in the middle of the payment');
        assert.strictEqual(dv.tables.get('new_ticket').id, REPLACEMENT_ID, 'and it is the table that answers to the name');
        assert.strictEqual(dv.tables.get('new_ticket').primaryLength, 600, 'its name column keeps the length its maker gave it');
        assert.strictEqual(warnings.filter((w) => leftAlone.test(w)).length, 1, 'and the build says it left the column alone');
        assert.deepStrictEqual(steps.filter((s) => s.startsWith('ok ')), [], 'the step is not narrated as done');
      });
    }
  }
});

test('the requests that pay a debt are addressed by the MetadataIds it records — the table\'s and its name column\'s — and nothing is resolved by name once the table is proved', async () => {
  const { dv, spec, owed } = await owingTicket();
  const before = dv.log.length;
  const run = await provisionAgain(dv, spec, { owedLengths: owed });
  assert.strictEqual(run.error, null);
  const T = tableId('new_ticket');
  const C = attributeId('new_ticket', 'new_name');
  const paying = dv.log.slice(before).filter((r) => isIdentityRead(r) || /\/Attributes\(/.test(r.path));
  assert.deepStrictEqual(paying.map(requestLine), [
    "GET /EntityDefinitions(LogicalName='new_ticket')?$select=MetadataId,PrimaryNameAttribute",
    `GET /EntityDefinitions(${T})/Attributes(${C})/Microsoft.Dynamics.CRM.StringAttributeMetadata?$select=MaxLength`,
    `GET /EntityDefinitions(${T})/Attributes(${C})/Microsoft.Dynamics.CRM.StringAttributeMetadata`,
    `PUT /EntityDefinitions(${T})/Attributes(${C})`,
  ], 'the table is looked up by its name once, to prove it is the one the build created — and then nothing is looked up by name again');
  const update = paying[paying.length - 1];
  assert.strictEqual(update.body.MaxLength, 120);
  assert.strictEqual(update.body['@odata.type'], 'Microsoft.Dynamics.CRM.StringAttributeMetadata');
  assert.deepStrictEqual(Object.keys(update.body).filter((key) => key.startsWith('@odata.')), ['@odata.type'], 'the annotations of the answer are not written back');
  assert.deepStrictEqual(update.headers, { 'MSCRM.MergeLabels': 'true' }, 'the labels already stored are kept');
  assert.strictEqual(dv.tables.get('new_ticket').primaryLength, 120);
  assert.deepStrictEqual(lengthEvents(run).map((e) => [e.status, e.label]), [['ok', `primary column length new_ticket.new_name -> 120 (${OWED})`]]);
  assert.deepStrictEqual(run.warnings, []);
});

test('a debt that records no column id is paid the same way: the column is found by name inside the table the debt names, and the update is addressed by the id that read answers', async () => {
  const dv = fakeDataverse({ lengthRead: (n) => (n === 1 ? unavailable() : undefined) });
  const spec = oneTable([], asksFor(120));
  const owed = new Map();
  await provisionAgain(dv, spec, { owedLengths: owed });
  const { columnId, ...tableOnly } = DEBT;
  assert.deepStrictEqual([...owed.values()], [tableOnly], 'the first attempt could not read the column: only the table\'s id is recorded');
  const before = dv.log.length;
  const run = await provisionAgain(dv, spec, { owedLengths: owed });
  assert.strictEqual(run.error, null);
  const T = tableId('new_ticket');
  const C = attributeId('new_ticket', 'new_name');
  assert.deepStrictEqual(dv.log.slice(before).filter((r) => isIdentityRead(r) || /\/Attributes\(/.test(r.path)).map(requestLine), [
    "GET /EntityDefinitions(LogicalName='new_ticket')?$select=MetadataId,PrimaryNameAttribute",
    `GET /EntityDefinitions(${T})/Attributes(LogicalName='new_name')/Microsoft.Dynamics.CRM.StringAttributeMetadata?$select=MaxLength`,
    `GET /EntityDefinitions(${T})/Attributes(${C})/Microsoft.Dynamics.CRM.StringAttributeMetadata`,
    `PUT /EntityDefinitions(${T})/Attributes(${C})`,
  ]);
  assert.strictEqual(dv.tables.get('new_ticket').primaryLength, 120);
  assert.deepStrictEqual([...owed], [], 'and the debt is paid');
});

test('what a debt\'s update writes is what the SDK\'s own update writes — the column\'s whole definition with its labels, the merge-labels header and the solution header — only the address differs', async () => {
  const sdkOptions = { solutionUniqueName: 'TableColumns' };
  const own = await provisionOver(oneTable([textColumn('new_a')], asksFor(120)), { sdkOptions });
  const state = { blocked: true };
  const dv = fakeDataverse({ updateFails: () => (state.blocked ? refusal() : null) });
  const spec = oneTable([textColumn('new_a')], asksFor(120));
  const owed = new Map();
  await provisionAgain(dv, spec, { owedLengths: owed, sdkOptions });
  state.blocked = false;
  const refused = puts({ dv }).length;
  const run = await provisionAgain(dv, spec, { owedLengths: owed, sdkOptions });
  assert.strictEqual(run.error, null);
  const [theirs] = puts({ dv }).slice(refused);
  const [ours] = puts(own);
  assert.deepStrictEqual(ours.headers, { 'MSCRM.MergeLabels': 'true', 'MSCRM.SolutionUniqueName': 'TableColumns' }, 'what the SDK\'s own update sends');
  assert.deepStrictEqual(theirs.headers, ours.headers);
  assert.ok(ours.body.DisplayName.LocalizedLabels.length > 0 && ours.body.MetadataId, 'the whole definition: its labels and its id are in the body');
  assert.deepStrictEqual(theirs.body, ours.body);
  assert.strictEqual(dv.tables.get('new_ticket').primaryLength, 120);
});

// What the SDK does after every write of its own (`schemaWrite`): it forgets the metadata it cached for the table, so that a later read
// does not serve a definition older than the write. A debt's update does not go through the SDK's updateColumn, so it asks for the same.
test('a debt\'s update runs inside the SDK\'s schema write, as its own update does, so the metadata the SDK cached for the table is forgotten', async () => {
  const { ArtifactNotFoundError } = require(BUNDLE);
  // Records which schema writes a PUT went out inside of.
  const watched = (dv, sdk) => {
    const writes = [];
    let current = null;
    const put = dv.httpClient.put;
    dv.httpClient.put = async (...args) => { if (current) current.put = true; return put(...args); };
    const schemaWrite = sdk.schemaWrite.bind(sdk);
    sdk.schemaWrite = (tables, fn) => {
      const entry = { tables, put: false };
      writes.push(entry);
      current = entry;
      return schemaWrite(tables, fn).finally(() => { current = null; });
    };
    return () => writes.filter((w) => w.put).map((w) => w.tables);
  };
  const run = (sdk, spec, owed) => provisionDataModel({
    sdk, provision: sdk, runner: makeRunner({ emit: () => undefined, total: 99 }), spec, apply: true, preResolvedLanguageCode: 1033,
    provisionedLanguages: async () => [1033, 3082], sleep: async () => {}, warn: () => {}, owedLengths: owed,
  });
  const spec = oneTable([textColumn('new_a')], asksFor(120));

  const first = fakeDataverse(OVERRIDING);
  const firstSdk = await realSdk(first.httpClient);
  const firstWrites = watched(first, firstSdk);
  await run(firstSdk, spec, new Map());
  assert.deepStrictEqual(firstWrites(), [['new_ticket']], 'the SDK\'s own update of a first attempt is one schema write of the table');

  const state = { blocked: true };
  const dv = fakeDataverse({ updateFails: () => (state.blocked ? refusal() : null) });
  const sdk = await realSdk(dv.httpClient);
  const owed = new Map();
  await run(sdk, spec, owed);
  state.blocked = false;
  const writes = watched(dv, sdk);
  await cacheMetadataOf(dv, sdk, 'new_ticket');
  assert.strictEqual((await sdk.getEntityMetadata('new_ticket')).logicalName, 'new_ticket', 'the SDK holds the table\'s metadata');
  await run(sdk, spec, owed);
  assert.strictEqual(dv.tables.get('new_ticket').primaryLength, 120, 'the debt was paid');
  assert.deepStrictEqual(writes(), [['new_ticket']], 'by one schema write of the table, as the SDK\'s own update is');
  await assert.rejects(() => sdk.getEntityMetadata('new_ticket'), (err) => err instanceof ArtifactNotFoundError, 'and what the SDK held of the table is forgotten');
});

// Fills the SDK's cache of a table's metadata the way a build's own broad reads do (fetchEntityMetadata), over the stub.
async function cacheMetadataOf(dv, sdk, logical) {
  const send = dv.httpClient.get;
  const reply = (body) => ({ status: 200, headers: {}, body });
  dv.httpClient.get = async (url, options) => {
    const p = decodeURIComponent(String(url).replace(API, ''));
    const table = dv.tables.get(logical);
    if (/\?\$select=LogicalName,SchemaName,DisplayName,Description/.test(p)) {
      return reply({
        MetadataId: table.id, LogicalName: table.logical, SchemaName: table.logical,
        DisplayName: { UserLocalizedLabel: { Label: 'Ticket' }, LocalizedLabels: [{ Label: 'Ticket', LanguageCode: 1033 }] },
        EntitySetName: `${table.logical}s`, PrimaryNameAttribute: table.primaryName, PrimaryIdAttribute: `${table.logical}id`, IsCustomEntity: true,
        Attributes: [...table.columns.values()].map((c) => ({ ...clone(c.body), ...c.row, AttributeType: 'String', AttributeTypeName: { Value: 'StringType' }, IsCustomAttribute: true })),
      });
    }
    if (/Attributes\/Microsoft\.Dynamics\.CRM\.StringAttributeMetadata/.test(p)) {
      return reply({ value: [...table.columns.values()].map((c) => ({ LogicalName: c.row.LogicalName, MaxLength: c.row.LogicalName === table.primaryName ? table.primaryLength : c.body.MaxLength })) });
    }
    if (/\$expand=.*Relationships/.test(p)) return reply({ OneToManyRelationships: [], ManyToOneRelationships: [], ManyToManyRelationships: [] });
    if (p.startsWith(`/EntityDefinitions(LogicalName='${logical}')`) || p.startsWith('/RelationshipDefinitions')) return reply({ value: [] });
    return send(url, options);
  };
  try {
    await sdk.fetchEntityMetadata(logical);
  } finally {
    dv.httpClient.get = send;
  }
}

test('where the read of the column that pays a debt fails, nothing is written and the step fails — a 503 is the build\'s to retry, and the retry pays', async () => {
  // The reads of the column's length are counted across the attempts: the first attempt's (1) answers, the retry's (2) is refused, the third attempt's (3) answers.
  const run = await buildWithRetries(retriedTicket(), { dataverse: { lengthRead: (n) => (n === 2 ? unavailable() : undefined) }, faults: { createFile: 1, setLength: 1 } });
  assert.strictEqual(run.result.ok, true);
  assert.strictEqual(run.retries, 2, 'attempt 2 could not read the column and stopped at the key; attempt 3 paid');
  assert.deepStrictEqual(run.requests(2).filter((r) => r.method === 'PUT' || /\/Keys$/.test(r.path)), [], 'attempt 2 wrote nothing, not even the key');
  const steps = (n) => run.steps(n, /^(primary column length|alt key) /);
  assert.deepStrictEqual(steps(2), [`error primary column length new_ticket.new_name -> 120${OWED_NOTE}`, 'error alt key new_ticket.new_namekey']);
  assert.deepStrictEqual(steps(3), [`ok primary column length new_ticket.new_name -> 120${OWED_NOTE}`, 'ok alt key new_ticket.new_namekey']);
  const failedStep = run.events.find((e) => e.attempt === 2 && e.status === 'error' && /^primary column length/.test(e.label));
  assert.match(failedStep.detail, /^asked 120, the length the platform made is unknown: could not read the column's length \(HTTP 503: Service Unavailable\)/);
  assert.strictEqual(run.dv.tables.get('new_ticket').primaryLength, 120);
  assert.deepStrictEqual([...run.dv.tables.get('new_ticket').keys.keys()], ['new_namekey']);
});


