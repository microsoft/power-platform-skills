'use strict';
// A small in-memory `appactions` table behind the REAL vendored SDK, for command tests that need
// an EXISTING command bar: rows a push POSTs are stored and served back on the next fetch, a PATCH
// merges, a DELETE removes. Every non-GET request is recorded, so a test can assert what was
// written (and that nothing was).
//
// The served row shape mirrors what the platform returns for `appaction` (see the SDK's
// CommandApi read: `$expand=OnClickEventJavaScriptWebResourceId(...),IconWebResourceId(...)`):
//   { appactionid, name, type, location, sequence, buttonlabeltext, hidden, isdisabled,
//     _parentappactionid_value, onclickeventtype, onclickeventjavascriptfunctionname,
//     onclickeventjavascriptparameters: '<json text>', _onclickeventjavascriptwebresourceid_value,
//     OnClickEventJavaScriptWebResourceId: { name, webresourceid } | null, '@odata.etag': 'W/"n"' }
// Two platform facts are modelled because the SDK depends on them:
//   * `onclickeventjavascriptparameters` is stored as TEXT — the SDK sends an array or a string and
//     reads a string back;
//   * a row's etag ROTATES on every write.
const path = require('node:path');
const { makeTempDir } = require('./temp-dirs.js');

const BUNDLE = path.resolve(__dirname, '..', '..', 'vendor', 'cds-maker-sdk.cjs');
const ENTITY_METADATA_ID = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
const BIND_RE = /^\/(appactions|webresourceset|entities)\(([^()]+)\)$/;

function createCommandBarServer({ entity = 'account', webResources = {} } = {}) {
  const rows = new Map(); // appactionid -> stored row
  const writes = [];
  const reads = [];
  let etag = 0;
  const nextEtag = () => { etag += 1; return `W/"${etag}"`; };

  const stored = (body) => {
    const row = {};
    for (const [k, v] of Object.entries(body || {})) {
      if (k.endsWith('@odata.bind')) {
        const m = BIND_RE.exec(String(v));
        const id = m ? m[2] : null;
        if (k.startsWith('ParentAppActionId')) row._parentappactionid_value = id;
        else if (k.startsWith('OnClickEventJavaScriptWebResourceId')) row._onclickeventjavascriptwebresourceid_value = id;
        else if (k.startsWith('IconWebResourceId')) row._iconwebresourceid_value = id;
        else if (k.startsWith('ContextEntity')) row._contextentity_value = id;
        continue;
      }
      row[k] = (k === 'onclickeventjavascriptparameters' && v !== null && typeof v !== 'string') ? JSON.stringify(v) : v;
    }
    return row;
  };
  const served = (row) => {
    const out = { ...row };
    const wr = row._onclickeventjavascriptwebresourceid_value;
    out.OnClickEventJavaScriptWebResourceId = wr ? { webresourceid: wr, name: webResources[wr] || 'cr_lib.js' } : null;
    out.IconWebResourceId = null;
    return out;
  };
  const rowIdOf = (url) => {
    const m = /\/appactions\(([^()]+)\)/i.exec(url);
    return m ? m[1].toLowerCase() : null;
  };

  /** Seed a row directly (a "foreign" control made by someone else). */
  function seed(row) {
    const r = { location: 0, sequence: 0, type: 0, _parentappactionid_value: null, ...row };
    r.appactionid = String(r.appactionid).toLowerCase();
    if (!r.name) r.name = `${r.appactionid}!${r.appactionid.replace(/-/g, '')}`;
    r['@odata.etag'] = nextEtag();
    rows.set(r.appactionid, r);
    return r;
  }

  const httpClient = {
    get: async (url) => {
      const u = String(url);
      reads.push(u);
      if (/EntityDefinitions/i.test(u)) {
        return { status: 200, headers: {}, body: { MetadataId: ENTITY_METADATA_ID, LogicalName: entity, value: [{ MetadataId: ENTITY_METADATA_ID, LogicalName: entity }] } };
      }
      if (/\/appactions/i.test(u)) {
        const id = rowIdOf(u);
        if (id) {
          const r = rows.get(id);
          return r ? { status: 200, headers: { etag: r['@odata.etag'] }, body: served(r) } : { status: 404, headers: {}, body: { error: { code: '0x80040217', message: 'not found' } } };
        }
        return { status: 200, headers: {}, body: { value: [...rows.values()].map(served) } };
      }
      return { status: 200, headers: {}, body: { value: [] } };
    },
    post: async (url, body) => {
      writes.push({ verb: 'post', url: String(url), body });
      const row = stored(body);
      row.appactionid = String(row.appactionid).toLowerCase();
      row['@odata.etag'] = nextEtag();
      rows.set(row.appactionid, row);
      return { status: 204, headers: { 'odata-entityid': `https://contoso.crm.dynamics.com/api/data/v9.2/appactions(${row.appactionid})` }, body: {} };
    },
    patch: async (url, body, headers) => {
      writes.push({ verb: 'patch', url: String(url), body, headers });
      const id = rowIdOf(String(url));
      const r = id && rows.get(id);
      if (!r) return { status: 404, headers: {}, body: { error: { code: '0x80040217', message: 'not found' } } };
      Object.assign(r, stored(body));
      r['@odata.etag'] = nextEtag();
      return { status: 204, headers: {}, body: {} };
    },
    put: async (url, body) => { writes.push({ verb: 'put', url: String(url), body }); return { status: 204, headers: {}, body: {} }; },
    delete: async (url) => {
      writes.push({ verb: 'delete', url: String(url) });
      const id = rowIdOf(String(url));
      if (id) rows.delete(id);
      return { status: 204, headers: {}, body: {} };
    },
  };

  /** A fresh SDK (its own workspace) over this server — a new build process, as far as the SDK knows. */
  async function newSdk() {
    const { createMakerSdk, createNodeWorkspaceStorage } = require(BUNDLE);
    const dir = makeTempDir('cmdbar-');
    const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(dir), instanceUrl: 'https://contoso.crm.dynamics.com', httpClient });
    await sdk.initWorkspace();
    return sdk;
  }

  return { rows, writes, reads, seed, newSdk, httpClient, clearLog() { writes.length = 0; reads.length = 0; } };
}

module.exports = { createCommandBarServer, ENTITY_METADATA_ID };
