'use strict';
// A small in-memory Dataverse behind the REAL vendored SDK, for the declared-reconciliation tests
// that need an EXISTING row (a view, a chart, a dashboard, a web resource): rows are served back
// as stored, a PATCH merges and rotates the row's etag, a POST stores. Every non-GET request is
// recorded, so a test can assert what was written — and that nothing was.
//
// URL shapes it answers (the ones the bundle sends for these artifact types):
//   GET  /<set>?$select=...&$filter=returnedtypecode eq 'account' and querytype eq 4
//   GET  /<set>(<id>)?$select=...                       one row (404 when absent)
//   GET  /<set>(<id>)/Microsoft.Dynamics.CRM.RetrieveUnpublished()?$select=...
//   GET  /EntityDefinitions(LogicalName='account')/Attributes?...&$filter=LogicalName eq 'name'
//   PATCH /<set>(<id>)   POST /<set>   DELETE /<set>(<id>)
// The $filter support is deliberately small: `col eq 'text'|number|true|false` clauses joined by
// ` and `. A clause it cannot read is ignored (the row is kept), which can only make a test's
// collection LARGER than the platform's — never hide a row the code under test must cope with.
const path = require('node:path');
const { makeTempDir } = require('./temp-dirs.js');

const BUNDLE = path.resolve(__dirname, '..', '..', 'vendor', 'cds-maker-sdk.cjs');
const ENTITY_METADATA_ID = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
const API = 'https://contoso.crm.dynamics.com/api/data/v9.0';
// The bundle resolves a row table's entity set by reading EntityDefinitions(LogicalName=...).EntitySetName.
const ENTITY_SETS = { savedquery: 'savedqueries', savedqueryvisualization: 'savedqueryvisualizations', systemform: 'systemforms', webresource: 'webresourceset', workflow: 'workflows' };

function parseFilter(url) {
  const m = /[?&]\$filter=([^&]*)/.exec(url);
  if (!m) return [];
  const text = decodeURIComponent(m[1].replace(/\+/g, ' '));
  const out = [];
  for (const clause of text.split(/\s+and\s+/i)) {
    const c = /^\(?\s*([A-Za-z_][A-Za-z0-9_]*)\s+eq\s+('(?:[^']|'')*'|-?\d+|true|false)\s*\)?$/i.exec(clause.trim());
    if (!c) continue;
    const raw = c[2];
    const value = raw.startsWith("'") ? raw.slice(1, -1).replace(/''/g, "'") : raw === 'true' ? true : raw === 'false' ? false : Number(raw);
    out.push([c[1], value]);
  }
  return out;
}

function matches(row, clauses) {
  return clauses.every(([col, value]) => {
    const have = row[col];
    if (typeof value === 'string' && typeof have === 'string') return have.toLowerCase() === value.toLowerCase();
    return have === value;
  });
}

/**
 * @param {object} opts
 * @param {Record<string,string>} opts.tables  entity set -> primary id column, e.g. { savedqueries: 'savedqueryid' }
 * @param {Record<string,Array<{LogicalName:string,AttributeType:string}>>} [opts.attributes]  table -> columns
 */
function createRowTableServer({ tables, attributes = {} }) {
  const store = new Map(Object.keys(tables).map((set) => [set, new Map()]));
  const writes = [];
  const reads = [];
  let etag = 0;
  const nextEtag = () => { etag += 1; return `W/"${etag}"`; };

  function seed(set, row) {
    const idCol = tables[set];
    const r = { ...row };
    r[idCol] = String(r[idCol]).toLowerCase();
    r['@odata.etag'] = nextEtag();
    store.get(set).set(r[idCol], r);
    return r;
  }
  const rowOf = (set, id) => store.get(set) && store.get(set).get(String(id).toLowerCase());
  const target = (url) => {
    const m = /\/api\/data\/v[\d.]+\/([A-Za-z_]+)(?:\(([^()]+)\))?/.exec(url);
    if (!m || !store.has(m[1])) return null;
    return { set: m[1], id: m[2] ? m[2].replace(/^'|'$/g, '').toLowerCase() : null };
  };
  const notFound = { status: 404, headers: {}, body: { error: { code: '0x80040217', message: 'Does Not Exist' } } };

  const httpClient = {
    get: async (url) => {
      const u = String(url);
      reads.push(u);
      const attrs = /EntityDefinitions\(LogicalName='([^']+)'\)\/Attributes/.exec(u);
      if (attrs) {
        const want = parseFilter(u).filter(([c]) => c === 'LogicalName').map(([, v]) => String(v).toLowerCase());
        const cols = (attributes[attrs[1]] || []).filter((a) => !want.length || want.includes(a.LogicalName.toLowerCase()));
        return { status: 200, headers: {}, body: { value: cols.map((a) => ({ DisplayName: { UserLocalizedLabel: null, LocalizedLabels: [] }, ...a })) } };
      }
      if (/EntityDefinitions/.test(u)) {
        const name = (/LogicalName='([^']+)'/.exec(u) || [])[1] || '';
        return { status: 200, headers: {}, body: { MetadataId: ENTITY_METADATA_ID, LogicalName: name, EntitySetName: ENTITY_SETS[name] || `s`, ObjectTypeCode: 1, value: [] } };
      }
      const t = target(u);
      if (!t) return { status: 200, headers: {}, body: { value: [] } };
      if (t.id) {
        const r = rowOf(t.set, t.id);
        return r ? { status: 200, headers: { etag: r['@odata.etag'] }, body: { ...r } } : notFound;
      }
      const clauses = parseFilter(u);
      return { status: 200, headers: {}, body: { value: [...store.get(t.set).values()].filter((r) => matches(r, clauses)).map((r) => ({ ...r })) } };
    },
    post: async (url, body) => {
      const u = String(url);
      writes.push({ verb: 'post', url: u, body });
      const t = target(u);
      if (!t) return { status: 204, headers: {}, body: {} };
      const idCol = tables[t.set];
      const r = seed(t.set, { ...body, [idCol]: body[idCol] || `aaaaaaaa-0000-4000-8000-${String(writes.length).padStart(12, '0')}` });
      return { status: 204, headers: { etag: r['@odata.etag'], 'odata-entityid': `${API}/${t.set}(${r[idCol]})` }, body: {} };
    },
    patch: async (url, body, headers) => {
      const u = String(url);
      writes.push({ verb: 'patch', url: u, body, headers });
      const t = target(u);
      const r = t && t.id && rowOf(t.set, t.id);
      if (!r) return notFound;
      Object.assign(r, body);
      r['@odata.etag'] = nextEtag();
      return { status: 204, headers: { etag: r['@odata.etag'] }, body: {} };
    },
    put: async (url, body) => { writes.push({ verb: 'put', url: String(url), body }); return { status: 204, headers: {}, body: {} }; },
    delete: async (url) => {
      const u = String(url);
      writes.push({ verb: 'delete', url: u });
      const t = target(u);
      if (t && t.id) store.get(t.set).delete(t.id);
      return { status: 204, headers: {}, body: {} };
    },
  };

  /** A fresh SDK (its own workspace) over this server — a new build process, as far as the SDK knows. */
  async function newSdk() {
    const { createMakerSdk, createNodeWorkspaceStorage } = require(BUNDLE);
    const dir = makeTempDir('rowtable-');
    const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(dir), instanceUrl: 'https://contoso.crm.dynamics.com', httpClient });
    await sdk.initWorkspace();
    return sdk;
  }

  return { store, writes, reads, seed, rowOf, newSdk, httpClient, clearLog() { writes.length = 0; reads.length = 0; } };
}

module.exports = { createRowTableServer, parseFilter };
