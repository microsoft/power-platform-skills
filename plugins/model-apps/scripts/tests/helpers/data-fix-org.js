'use strict';
// A small fake of the Dataverse surface a data fix (lib/data-fix-runner.js) talks to, shared by
// tests/data-fix-runner.test.js and the CLI preload helpers/data-fix-org-preload.js. The shared lifecycle fake does not
// model the narrow metadata reads a data fix makes (the table's `IsOptimisticConcurrencyEnabled`, the per-kind
// attribute casts) nor `$batch` of one change set per row with `odata.continue-on-error`, so this serves exactly those:
// one table, conditional PATCHes that answer 412 on a moved token and 404 0x80040217 on a deleted row, and WhoAmI.
const { randomUUID } = require('node:crypto');

const ORIGIN = 'https://contoso.crm.dynamics.com';
const SENTINEL = 'SENTINEL-c0ffee-business-value';
const USER = '11111111-1111-4111-8111-111111111111';
const ORG = '22222222-2222-4222-8222-222222222222';

const json = (statusCode, body, headers = {}) => ({ statusCode, headers: { 'content-type': 'application/json; odata.metadata=minimal', ...headers }, body: body === undefined ? '' : JSON.stringify(body) });
const odataError = (statusCode, code, message) => json(statusCode, { error: { code, message } });

// `seed` (what `org.snapshot()` returned) restores a fake across processes: the CLI tests run scripts/data-fix.js in a
// child, one verb at a time, against the same rows.
function createDataFixOrg({ rows = 4, seed } = {}) {
  const tickets = new Map(seed ? seed.tickets : []);
  let version = seed ? seed.version : 100;
  for (let i = 0; i < (seed ? 0 : rows); i += 1) {
    const id = randomUUID();
    tickets.set(id, { contoso_ticketid: id, contoso_name: `Ticket ${i}`, contoso_note: `${SENTINEL}-${i}`, contoso_status: 'open', etag: `W/"${(version += 1)}"` });
  }
  const org = {
    origin: ORIGIN,
    tickets,
    identity: seed ? seed.identity : { UserId: USER, OrganizationId: ORG, BusinessUnitId: randomUUID() },
    requests: [],
    // A test seam: called with each PATCH part before it is applied; may answer for it instead.
    onPatch: null,
    // A test seam: called with the whole `$batch` request; may answer for it instead (or throw: a lost answer).
    onBatch: null,
    // Another writer: a plain PATCH that moves the row's token, as a second maker's edit would.
    touch(id, note) {
      const row = tickets.get(id);
      row.contoso_note = note;
      row.etag = `W/"${(version += 1)}"`;
    },
    snapshot: () => ({ tickets: [...tickets.entries()], version, identity: org.identity }),
  };
  const attributes = {
    contoso_name: { LogicalName: 'contoso_name', AttributeType: 'String', AttributeTypeName: { Value: 'StringType' }, IsValidForRead: true, IsValidForUpdate: true, IsSecured: false },
    contoso_note: { LogicalName: 'contoso_note', AttributeType: 'String', AttributeTypeName: { Value: 'StringType' }, IsValidForRead: true, IsValidForUpdate: true, IsSecured: false },
    contoso_status: { LogicalName: 'contoso_status', AttributeType: 'String', AttributeTypeName: { Value: 'StringType' }, IsValidForRead: true, IsValidForUpdate: true, IsSecured: false },
    contoso_secret: { LogicalName: 'contoso_secret', AttributeType: 'String', AttributeTypeName: { Value: 'StringType' }, IsValidForRead: true, IsValidForUpdate: true, IsSecured: true },
  };
  const namesIn = (filter) => [...String(filter || '').matchAll(/LogicalName eq '([^']*)'/g)].map((m) => m[1]);
  const project = (row, select) => {
    const out = { '@odata.etag': row.etag };
    for (const name of select) if (name in row) out[name] = row[name];
    return out;
  };

  function patchRow(where, headers, body) {
    const m = /^\/contoso_tickets\(([0-9a-f-]{36})\)(?:\?\$select=(.*))?$/i.exec(where);
    if (!m) return odataError(400, '0x80040203', `unmodelled PATCH ${where}`);
    const row = tickets.get(m[1].toLowerCase());
    if (!row) return odataError(404, '0x80040217', 'contoso_ticket With Id = ... Does Not Exist');
    const ifMatch = Object.entries(headers).find(([k]) => k.toLowerCase() === 'if-match');
    if (!ifMatch || ifMatch[1] !== row.etag) return odataError(412, '0x80060882', 'The version of the existing record doesn\'t match the RowVersion property provided.');
    Object.assign(row, body);
    row.etag = `W/"${(version += 1)}"`;
    return json(200, project(row, (m[2] || 'contoso_ticketid').split(',')), { ETag: row.etag });
  }

  // The SDK's `$batch` of single-operation change sets (BatchApi.renderChangeSets), e.g.
  //   --batch_<id>
  //   Content-Type: multipart/mixed;boundary=changeset_<id>
  //
  //   --changeset_<id>
  //   Content-Type: application/http
  //   Content-Transfer-Encoding: binary
  //   Content-ID: 1
  //
  //   PATCH https://contoso.crm.dynamics.com/api/data/v9.2/contoso_tickets(<id>)?$select=... HTTP/1.1
  //   If-Match: W/"101"
  //   ...
  //
  //   {"contoso_note":"..."}
  //   --changeset_<id>--
  //   --batch_<id>--
  function batch(text, headers) {
    const outer = /^--(\S+)/.exec(text)[1];
    const answers = [];
    for (const segment of text.split(`--${outer}`).slice(1)) {
      if (segment.startsWith('--')) break;
      const changeset = /boundary=(\S+)/.exec(segment)[1];
      const part = segment.split(`--${changeset}`)[1];
      const whole = part.replace(/^\r\n/, '');
      const mime = whole.slice(0, whole.indexOf('\r\n\r\n'));
      const request = whole.slice(whole.indexOf('\r\n\r\n') + 4);
      const contentId = /Content-ID:\s*(\S+)/i.exec(mime)[1];
      const [head, ...rest] = request.split(/\r\n\r\n/);
      const lines = head.split(/\r\n/);
      const [, method, url] = /^(\w+) (\S+) HTTP\/1\.1$/.exec(lines[0]);
      const partHeaders = Object.fromEntries(lines.slice(1).map((l) => [l.slice(0, l.indexOf(':')).trim(), l.slice(l.indexOf(':') + 1).trim()]));
      const where = decodeURIComponent(new URL(url, ORIGIN).pathname + new URL(url, ORIGIN).search).replace(/^\/api\/data\/v9\.\d+/, '');
      const body = rest.join('\r\n\r\n').trim() ? JSON.parse(rest.join('\r\n\r\n').trim()) : undefined;
      const injected = org.onPatch && org.onPatch({ method, where, headers: partHeaders, body, id: (/\(([0-9a-f-]{36})\)/i.exec(where) || [])[1] });
      answers.push({ contentId, res: injected || patchRow(where, partHeaders, body) });
    }
    const out = 'batchresponse_00000000-0000-0000-0000-00000000000a';
    const lines = [];
    for (const { contentId, res } of answers) {
      const cs = `changesetresponse_${randomUUID()}`;
      lines.push(`--${out}`, `Content-Type: multipart/mixed; boundary=${cs}`, '', `--${cs}`, 'Content-Type: application/http', 'Content-Transfer-Encoding: binary', `Content-ID: ${contentId}`, '',
        `HTTP/1.1 ${res.statusCode} ${res.statusCode < 300 ? 'OK' : 'Error'}`, ...Object.entries(res.headers).map(([k, v]) => `${k}: ${v}`), '', res.body, `--${cs}--`);
    }
    lines.push(`--${out}--`, '');
    return { statusCode: 200, headers: { 'content-type': `multipart/mixed; boundary=${out}` }, body: lines.join('\r\n') };
  }

  org.request = async ({ url, method, headers = {}, body }) => {
    const parsed = new URL(url);
    if (parsed.origin !== ORIGIN) throw new Error(`a request to another origin: ${url}`);
    const where = decodeURIComponent(parsed.pathname + parsed.search).replace(/^\/api\/data\/v9\.\d+/, '');
    org.requests.push({ method, path: where });
    if (method === 'GET' && where === '/WhoAmI') return json(200, org.identity);
    if (method === 'GET' && where.startsWith("/EntityDefinitions(LogicalName='contoso_ticket')?")) {
      return json(200, { EntitySetName: 'contoso_tickets', PrimaryIdAttribute: 'contoso_ticketid', PrimaryNameAttribute: 'contoso_name', IsOptimisticConcurrencyEnabled: true });
    }
    if (method === 'GET' && where.startsWith("/EntityDefinitions(LogicalName='contoso_nowhere')")) return odataError(404, '0x80060888', 'not found');
    // A table the signed-in user may not read, whose refusal quotes a business value (a service message can quote anything).
    if (method === 'GET' && where.startsWith("/EntityDefinitions(LogicalName='contoso_secretive')")) return odataError(403, '0x80040220', `Principal lacks read access; the last value seen was ${SENTINEL}-refusal`);
    const attr = /^\/EntityDefinitions\(LogicalName='contoso_ticket'\)\/Attributes(\/Microsoft\.Dynamics\.CRM\.(\w+))?\?(.*)$/.exec(where);
    if (method === 'GET' && attr) {
      const params = new URLSearchParams(attr[3]);
      const names = namesIn(params.get('$filter')).filter((n) => attributes[n]);
      if (!attr[2]) return json(200, { value: names.map((n) => attributes[n]) });
      return json(200, { value: names.map((n) => ({ LogicalName: n, MaxLength: 200 })) });
    }
    const rowsRead = /^\/contoso_tickets\?(.*)$/.exec(where);
    if (method === 'GET' && rowsRead) {
      const params = new URLSearchParams(rowsRead[1]);
      const select = (params.get('$select') || '').split(',');
      const filter = params.get('$filter') || '';
      const ids = /CRM\.In\(PropertyName='contoso_ticketid',PropertyValues=\[(.*)\]\)/.exec(filter);
      const eq = /^(\w+) eq '([^']*)'$/.exec(filter);
      let rows = [...tickets.values()];
      if (ids) {
        const wanted = new Set([...ids[1].matchAll(/'([^']*)'/g)].map((m) => m[1].toLowerCase()));
        rows = rows.filter((r) => wanted.has(r.contoso_ticketid));
      } else if (eq) {
        rows = rows.filter((r) => r[eq[1]] === eq[2]);
      } else {
        return odataError(400, '0x80060888', `unmodelled filter ${filter}`);
      }
      return json(200, { value: rows.map((r) => project(r, select)) });
    }
    if (method === 'POST' && where === '/$batch') {
      if (org.onBatch) {
        const answer = await org.onBatch({ body: String(body), headers });
        if (answer) return answer;
      }
      return batch(String(body), headers);
    }
    return odataError(501, '0x80040265', `the data fix fake does not model ${method} ${where}`);
  };
  return org;
}

module.exports = { ORIGIN, SENTINEL, USER, ORG, json, odataError, createDataFixOrg };
