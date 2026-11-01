'use strict';
// An in-memory Dataverse workflow table, as a TRANSPORT: the `request(opts)` the plugin's real HTTP client
// (lib/sdk-http-client.js createAzHttpClient) sends through. The declared business-rule and process-flow tests drive the
// REAL vendored SDK and the real client (with the workflow-effect gate) over it, so the SDK's own WFOM serializer and
// parser, the client's retry and send-once rules, and the gate are all exercised, and every request is counted.
//
// What it serves, as the platform does:
//   POST workflows(00000000-…)/Microsoft.Dynamics.CRM.CreateProcessWithWfomJson  {"Entity":{"workflowid":…},"WfomJson":"…"}
//        a business rule, created Draft under the id the body carries (an id that exists answers 412)
//   POST workflows(00000000-…)/Microsoft.Dynamics.CRM.UpdateProcessWithWfomJson  the same body, rewrites the WfomJson
//   GET  workflows(<id>)/Microsoft.Dynamics.CRM.RetrieveProcessWithWfomJson       {"Entity":{…},"WfomJson":"…"} + ETag
//   POST workflows {"workflowid":…,"xaml":…}                                      a process flow, created Draft
//   PATCH workflows(<id>) {…}                                                      merges the body (a state change, a XAML edit)
//   GET  workflows(<id>)?$select=…                                                 the row + ETag;  DELETE workflows(<id>)
//   GET  organizations…, EntityDefinitions(LogicalName='…')…                      the language and the entity-set name
// Every write moves the row's version (`W/"<n>"`). With `enforceIfMatch` (the default) a write whose `If-Match` is not
// the row's version answers 412 and changes nothing — what a service that enforces the version token does. With
// `enforceIfMatch: false` the header is ignored: the negative control, a double that cannot prove a conditional write.
//
// `script(match, answer)` makes the next request that `match`es answer `answer` instead: `{ statusCode, body }`, or
// `{ error, code }` for a transport failure after the send (a lost answer). The request is still recorded, and is
// applied unless `answer.unapplied` — so a 503 or a lost answer can be one the service did carry out.
const ORIGIN = 'https://contoso.crm.dynamics.com';
const ZERO = '00000000-0000-0000-0000-000000000000';
const ENTITY_SETS = { workflow: 'workflows', processstage: 'processstages' };
const GUID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

function createWorkflowWire({ enforceIfMatch = true } = {}) {
  const rows = new Map();
  const log = [];
  const scripted = [];
  const deleted = [];
  const json = (statusCode, body, headers = {}) => ({ statusCode, headers, body: body === undefined ? '' : JSON.stringify(body) });
  const notFound = () => json(404, { error: { code: '0x80040217', message: 'workflow With Id Does Not Exist' } });
  const stale = () => json(412, { error: { code: '0x80060882', message: 'The version of the existing record doesn\'t match the RowVersion property provided.' } });
  const etagOf = (r) => `W/"${r.version}"`;
  const bump = (r) => { r.version += 1; };
  // A rule's trigger scope as Create/UpdateProcessWithWfomJson carry it on Entity: 2 = the table (scope Entity),
  // 1 = all forms (AllForms, no form id). Kept on the row and read back, so a scope edit is observable.
  const scopeOf = (e) => ({
    processtriggerscope: e.processtriggerscope == null ? 2 : e.processtriggerscope,
    processtriggerformid: e.processtriggerformid == null ? null : e.processtriggerformid,
  });
  const conditionalFails = (r, headers) => {
    const held = headerValue(headers, 'if-match');
    return enforceIfMatch && held && held !== '*' && held !== etagOf(r);
  };

  function apply(method, p, body, headers, query = '') {
    let m = /^workflows\(([^)]+)\)\/Microsoft\.Dynamics\.CRM\.RetrieveProcessWithWfomJson/i.exec(p);
    if (m && method === 'GET') {
      const r = rows.get(m[1].toLowerCase());
      if (!r || r.kind !== 'rule') return notFound();
      return json(200, { Entity: { workflowid: r.workflowid, name: r.name, description: r.description == null ? '' : r.description, primaryentity: r.primaryentity, statecode: r.statecode, processtriggerscope: r.processtriggerscope, processtriggerformid: r.processtriggerformid }, WfomJson: r.wfom }, { etag: etagOf(r) });
    }
    m = /^workflows\(([^)]+)\)\/Microsoft\.Dynamics\.CRM\.(Create|Update)ProcessWithWfomJson$/i.exec(p);
    if (m && method === 'POST') {
      const id = String(body.Entity.workflowid).toLowerCase();
      if (m[2] === 'Create') {
        if (rows.has(id)) return json(412, { error: { code: '0x80040237', message: 'Cannot insert duplicate key.' } });
        rows.set(id, { kind: 'rule', workflowid: id, category: 2, type: 1, name: body.Entity.name, description: body.Entity.description, primaryentity: body.Entity.primaryentity, ...scopeOf(body.Entity), wfom: body.WfomJson, statecode: 0, statuscode: 1, version: 1 });
        return json(200, { workflowid: id }, { etag: 'W/"1"' });
      }
      const r = rows.get(id);
      if (!r) return notFound();
      if (conditionalFails(r, headers)) return stale();
      r.wfom = body.WfomJson;
      if (body.Entity.description !== undefined) r.description = body.Entity.description;
      if (body.Entity.name !== undefined) r.name = body.Entity.name;
      Object.assign(r, scopeOf(body.Entity));
      bump(r);
      return json(200, { workflowid: id }, { etag: etagOf(r) });
    }
    if (/^workflows$/i.test(p) && method === 'POST') {
      const id = String(body.workflowid).toLowerCase();
      if (rows.has(id)) return json(412, { error: { code: '0x80040237', message: 'Cannot insert duplicate key.' } });
      const r = { ...body, kind: 'bpf', workflowid: id, statecode: 0, statuscode: 1, version: 1 };
      rows.set(id, r);
      return json(201, { workflowid: id, '@odata.etag': etagOf(r) }, { etag: etagOf(r), 'odata-entityid': `${ORIGIN}/api/data/v9.2/workflows(${id})` });
    }
    m = /^workflows\(([^)]+)\)$/i.exec(p);
    if (m) {
      const id = m[1].replace(/'/g, '').toLowerCase();
      const r = rows.get(id);
      if (method === 'GET') {
        if (!r) return notFound();
        const { kind, version, wfom, ...fields } = r;
        return json(200, { '@odata.etag': etagOf(r), ...fields }, { etag: etagOf(r) });
      }
      if (method === 'PATCH') {
        if (!r) return notFound();
        if (conditionalFails(r, headers)) return stale();
        Object.assign(r, body);
        bump(r);
        return json(204, undefined, { etag: etagOf(r) });
      }
      if (method === 'DELETE') {
        if (!r) return notFound();
        rows.delete(id);
        deleted.push(id);
        return json(204);
      }
    }
    if (/^organizations/i.test(p)) return json(200, { value: [{ organizationid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', languagecode: 1033 }] });
    if (/^EntityDefinitions/i.test(p)) {
      const name = (/LogicalName='([^']+)'/.exec(p) || [])[1] || '';
      return json(200, { MetadataId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', LogicalName: name, EntitySetName: ENTITY_SETS[name] || `${name}s`, ObjectTypeCode: 4703 });
    }
    if (/^workflows$/i.test(p) && method === 'GET') {
      const keep = rowFilter(new URLSearchParams(query).get('$filter'));
      return json(200, { value: [...rows.values()].filter(keep).map(({ kind, version, wfom, ...fields }) => ({ '@odata.etag': `W/"${version}"`, ...fields })) });
    }
    return method === 'GET' ? json(200, { value: [] }) : json(204);
  }

  async function request(req) {
    const url = new URL(req.url);
    const p = decodeURIComponent(url.pathname.replace(/^\/api\/data\/v[\d.]+\//, ''));
    const raw = req.body == null ? null : Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body);
    let body = null;
    try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
    const entry = { method: String(req.method).toUpperCase(), url: req.url, path: p, query: url.search, body, headers: { ...(req.headers || {}) } };
    log.push(entry);
    const at = scripted.findIndex((s) => s.match(entry));
    if (at >= 0) {
      const [{ answer }] = scripted.splice(at, 1);
      if (!answer.unapplied) apply(entry.method, p, body, entry.headers, url.search);
      if (answer.error) return { error: answer.error, code: answer.code || 'ECONNRESET' };
      return json(answer.statusCode, answer.body);
    }
    return apply(entry.method, p, body, entry.headers, url.search);
  }

  // A compact line per request, for pinning a complete request list: `GET workflows(<id>)/…Retrieve…`, with every
  // GUID but the zero one written as <id> so a pin does not depend on which id a test derived.
  const lineOf = (e) => `${e.method} ${e.path.replace(GUID, (g) => (g === ZERO ? g : '<id>'))}${e.query && /\$select=/.test(e.query) ? '?$select' : ''}`;

  return {
    request,
    log,
    rows,
    deleted,
    script(match, answer) { scripted.push({ match, answer }); },
    writes() { return log.filter((e) => e.method !== 'GET'); },
    lines(from = 0) { return log.slice(from).map(lineOf); },
    row(id) { return rows.get(String(id).toLowerCase()) || null; },
  };
}

// The `$filter` the workflow reads send: `eq` comparisons joined by `and`, each value quoted ('' escapes a quote) or bare
// (a number or a GUID), e.g.
//   category eq 2 and type eq 1 and name eq 'Hide fax' and primaryentity eq 'account'
//   workflowid eq 12345678-1234-4234-8234-123456789abc
// A filter of any other shape matches every row, so a read this double cannot evaluate sees the whole table.
function rowFilter(filter) {
  if (!filter) return () => true;
  const terms = [];
  for (const part of String(filter).split(/\s+and\s+/i)) {
    const m = /^\s*(\w+)\s+eq\s+(?:'((?:[^']|'')*)'|(\S+))\s*$/i.exec(part);
    if (!m) return () => true;
    terms.push([m[1].toLowerCase(), (m[2] !== undefined ? m[2].replace(/''/g, "'") : m[3]).toLowerCase()]);
  }
  return (row) => terms.every(([field, value]) => String(row[field] == null ? '' : row[field]).toLowerCase() === value);
}

function headerValue(headers, name) {
  for (const [k, v] of Object.entries(headers || {})) if (k.toLowerCase() === name) return v;
  return undefined;
}

module.exports = { createWorkflowWire, ORIGIN, ZERO };
