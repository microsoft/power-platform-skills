'use strict';
// An in-memory Dataverse TRANSPORT for the managed-settlement tests: the `request(opts)` that the plugin's real HTTP
// client (lib/sdk-http-client.js createAzHttpClient) sends through, so a test exercises the real client, the real
// publication barrier gate (gateRequest) and the real vendored SDK, and counts what reached the wire.
//
// It keeps two layers for each systemform row (a form or a dashboard), as the platform does:
//   GET  systemforms(<id>)/Microsoft.Dynamics.CRM.RetrieveUnpublished()?...   the saved layer
//   GET  systemforms(<id>)?...                                                 the published layer; 404 0x80040217 when never published
//   POST systemforms {"formid":…}   creates the saved layer under the caller's id; an id that exists answers 412 0x80040237
//   POST PublishXml {"ParameterXml":"<importexportxml><entities><entity>account</entity></entities></importexportxml>"}
//        copies the saved layer of every form of `account` to its published layer; a <dashboards><dashboard>id</dashboard>
//        envelope does the same for one dashboard
//   PATCH systemforms(<id>)            writes the saved layer
// The saved layer carries a row version that every write of the row moves, and the GET answers it as `@odata.etag` (body and
// ETag header). The SERVICE DOES NOT DO THIS: a live systemforms GET answers the PUBLISHED row's ETag, which a saved-layer
// edit does not move, and the saved layer's own ETag is refused with 412. The version exists here only because the vendored
// SDK refuses to push an artifact it holds no such token for; a concurrent saved-layer edit is caught by the SDK's
// re-read of the saved content just before its PATCH, never by If-Match, and this wire never answers 412 to a PATCH. A test
// through it proves that re-read and refusal path, not a service guard. The token is kept beside the row, not in it, so
// `saved.get(id)` stays the row itself.
// The same two layers for view (savedquery) and chart (savedqueryvisualization) rows, by id (`putQuery`); a table's PublishXml
// publishes the ones whose `returnedtypecode`/`primaryentitytypecode` is the table, as it publishes its forms.
// And workflow rows:
//   POST workflows(00000000-…)/Microsoft.Dynamics.CRM.CreateProcessWithWfomJson|UpdateProcessWithWfomJson  {"Entity":{"workflowid":…}}
//   POST workflows {"workflowid":…}     PATCH workflows(<id>) {…}     GET workflows(<id>)
// Anything else: a GET answers an empty collection, a write 204. `script(match, answer)` makes the next request that
// `match`es answer `answer` instead (`{ statusCode, body }`, or `{ error }` for a transport failure after the send) —
// the request is still recorded and still applied unless `answer.unapplied`.
const { createMakerSdk, createNodeWorkspaceStorage } = require('../../vendor/cds-maker-sdk.cjs');
const { createAzHttpClient } = require('../../lib/sdk-http-client.js');
const { makeTempDir } = require('./temp-dirs.js');

const ORIGIN = 'https://contoso.crm.dynamics.com';
const ENTITY_SETS = { systemform: 'systemforms', workflow: 'workflows', savedquery: 'savedqueries' };

function createManagedWire() {
  const saved = new Map();
  const published = new Map();
  const workflows = new Map();
  // savedqueries / savedqueryvisualizations: collection -> { saved: Map, published: Map }
  const queries = { savedqueries: { saved: new Map(), published: new Map(), table: 'returnedtypecode' }, savedqueryvisualizations: { saved: new Map(), published: new Map(), table: 'primaryentitytypecode' } };
  const log = [];
  const scripted = [];
  const versions = new Map();
  let version = 0;
  const bump = (id) => { version += 1; versions.set(id, `W/"${version}"`); };
  const json = (statusCode, body, headers = {}) => ({ statusCode, headers, body: body === undefined ? '' : JSON.stringify(body) });
  const notFound = () => json(404, { error: { code: '0x80040217', message: 'Does Not Exist' } });

  function apply(method, p, body) {
    let m = /^systemforms\(([^)]+)\)\/Microsoft\.Dynamics\.CRM\.RetrieveUnpublished\(\)$/i.exec(p);
    if (m && method === 'GET') {
      const id = m[1].toLowerCase();
      const r = saved.get(id);
      return r ? json(200, { ...r, '@odata.etag': versions.get(id) }, { etag: versions.get(id) }) : notFound();
    }
    m = /^systemforms\(([^)]+)\)$/i.exec(p);
    // The test keeps one version per row whichever layer is read (the SDK's pre-push read is this GET). The service
    // answers the published row's ETag here instead; see the header.
    if (m && method === 'GET') { const id = m[1].toLowerCase(); const r = published.get(id); return r ? json(200, { ...r, '@odata.etag': versions.get(id) }, { etag: versions.get(id) }) : notFound(); }
    if (m && method === 'PATCH') {
      const id = m[1].toLowerCase();
      saved.set(id, { ...saved.get(id), ...body, formid: id });
      bump(id);
      return json(204, undefined, { etag: versions.get(id) });
    }
    if (/^systemforms$/i.test(p) && method === 'POST') {
      // A create names its own formid. A second create of an id that exists fails on the primary key and changes nothing.
      const id = String(body && body.formid).toLowerCase();
      if (saved.has(id) || published.has(id)) return json(412, { error: { code: '0x80040237', message: 'Cannot insert duplicate key.' } });
      saved.set(id, { description: null, ...body, formid: id });
      bump(id);
      return json(204, undefined, { etag: versions.get(id), 'odata-entityid': `${ORIGIN}/api/data/v9.0/systemforms(${id})` });
    }
    m = /^(savedqueries|savedqueryvisualizations)\(([^)]+)\)(\/Microsoft\.Dynamics\.CRM\.RetrieveUnpublished\(\))?$/i.exec(p);
    if (m && method === 'GET') { const q = queries[m[1].toLowerCase()]; const r = (m[3] ? q.saved : q.published).get(m[2].toLowerCase()); return r ? json(200, { ...r }) : notFound(); }
    if (/^PublishXml$/i.test(p) && method === 'POST') {
      const xml = String(body && body.ParameterXml);
      for (const [, t] of xml.matchAll(/<entity>([^<]+)<\/entity>/g)) {
        for (const [id, r] of saved) if (r.objecttypecode === t && r.type !== 0) published.set(id, { ...r });
        for (const q of Object.values(queries)) for (const [id, r] of q.saved) if (r[q.table] === t) q.published.set(id, { ...r });
      }
      for (const [, id] of xml.matchAll(/<dashboard>([^<]+)<\/dashboard>/g)) {
        const r = saved.get(id.toLowerCase());
        if (r) published.set(id.toLowerCase(), { ...r });
      }
      return json(204);
    }
    if (/^EntityDefinitions/.test(p)) {
      const name = (/LogicalName='([^']+)'/.exec(p) || [])[1] || '';
      return json(200, { MetadataId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', LogicalName: name, EntitySetName: ENTITY_SETS[name] || `${name}s`, ObjectTypeCode: 1 });
    }
    m = /^workflows\(([^)]+)\)\/Microsoft\.Dynamics\.CRM\.(Create|Update)ProcessWithWfomJson$/i.exec(p);
    if (m && method === 'POST') {
      const id = String(body.Entity.workflowid).toLowerCase();
      workflows.set(id, { ...workflows.get(id), ...body.Entity, workflowid: id, statecode: (workflows.get(id) || { statecode: 0 }).statecode });
      return json(200, { workflowid: id });
    }
    if (/^workflows$/i.test(p) && method === 'POST') {
      const id = String(body.workflowid).toLowerCase();
      workflows.set(id, { statecode: 0, statuscode: 1, ...body, workflowid: id });
      return json(204, undefined, { 'odata-entityid': `${ORIGIN}/api/data/v9.0/workflows(${id})` });
    }
    m = /^workflows\(([^)]+)\)$/i.exec(p);
    if (m && method === 'PATCH') {
      const id = m[1].toLowerCase();
      if (!workflows.has(id)) return notFound();
      workflows.set(id, { ...workflows.get(id), ...body });
      return json(204);
    }
    if (m && method === 'GET') { const r = workflows.get(m[1].toLowerCase()); return r ? json(200, { ...r }) : notFound(); }
    return method === 'GET' ? json(200, { value: [] }) : json(204);
  }

  async function request(req) {
    const url = new URL(req.url);
    const p = decodeURIComponent(url.pathname.replace(/^\/api\/data\/v[\d.]+\//, ''));
    const raw = req.body == null ? null : Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body);
    let body = null;
    try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
    const entry = { method: String(req.method).toUpperCase(), url: req.url, path: p, body, headers: { ...(req.headers || {}) } };
    log.push(entry);
    const at = scripted.findIndex((s) => s.match(entry));
    if (at >= 0) {
      const [{ answer }] = scripted.splice(at, 1);
      if (!answer.unapplied) apply(entry.method, p, body);
      if (answer.error) return { error: answer.error, code: answer.code || 'ECONNRESET' };
      return json(answer.statusCode, answer.body);
    }
    return apply(entry.method, p, body);
  }

  return {
    request,
    log,
    saved,
    published,
    workflows,
    script(match, answer) { scripted.push({ match, answer }); },
    /** Put a systemform row; `publishedToo` makes the published layer equal to it. */
    putForm(row, { publishedToo = false } = {}) {
      const r = { description: null, ...row, formid: row.formid.toLowerCase() };
      saved.set(r.formid, r);
      bump(r.formid);
      if (publishedToo) published.set(r.formid, { ...r });
      return r;
    },
    /** Put a view (`savedqueries`) or chart (`savedqueryvisualizations`) row by its id field; `publishedToo` as putForm. */
    putQuery(collection, idField, row, { publishedToo = false } = {}) {
      const q = queries[collection];
      const r = { description: null, ...row, [idField]: row[idField].toLowerCase() };
      q.saved.set(r[idField], r);
      if (publishedToo) q.published.set(r[idField], { ...r });
      return r;
    },
    /** The PublishXml requests that reached the wire. `name`: only those whose envelope names this table or dashboard id. */
    publishes(name) {
      return log.filter((e) => e.method === 'POST' && /^PublishXml$/i.test(e.path)
        && (!name || new RegExp(`<(entity|dashboard)>${name}</(entity|dashboard)>`, 'i').test(String(e.body && e.body.ParameterXml))));
    },
    writes() { return log.filter((e) => e.method !== 'GET'); },
  };
}

/**
 * The plugin's real client over `wire`, gated as build-model-app.js gates it when a barrier is given. `observer`: a
 * managed attempt send observer (createAttemptSendObserver), installed inside the barrier as the build installs it.
 */
function clientOver(wire, { barrier = null, workflowEffectGate = null, observer = null } = {}) {
  const transport = observer ? observer.wrap(wire.request) : wire.request;
  return createAzHttpClient(ORIGIN, {
    getToken: () => 'x'.repeat(40),
    request: barrier ? barrier.gateRequest(transport) : transport,
    sleep: async () => {},
    ...(workflowEffectGate ? { workflowEffectGate } : {}),
  });
}

/** A real SDK over the real client: a fresh build process, as far as the SDK knows. */
async function sdkOver(wire, opts = {}) {
  const httpClient = clientOver(wire, opts);
  const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(makeTempDir('managed-wire-')), instanceUrl: ORIGIN, httpClient });
  await sdk.initWorkspace();
  return { sdk, httpClient };
}

module.exports = { ORIGIN, createManagedWire, clientOver, sdkOver };
