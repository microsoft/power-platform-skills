'use strict';
// Fakes for the tests of the navigation check (app-navigation-build.test.js). Two things set them apart from the
// fakes in the other build tests:
//   * every call is RECORDED, whatever the fake does with it, so "nothing was written" is a statement about every
//     call the build made and not about the ones a fake chose to log;
//   * whether the app exists, and whether that can be read, are the two answers the check turns on, and a test sets them.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { makeSimpleMockSdk } = require('./mock-sdk.js');
const { fakeGenpage } = require('./fake-genpage.js');
const { withPageType } = require('./page-component-type.js');

// Wrap every function reachable from `target` so a call is recorded as [name, ...args], nested objects (the raw
// `dataverse` client) with a dotted name. Arguments are recorded as given, so a test can compare them.
function recorded(target, calls, prefix = '') {
  return new Proxy(target, {
    get(obj, key) {
      const value = obj[key];
      if (typeof key === 'symbol') return value;
      const name = `${prefix}${String(key)}`;
      if (typeof value === 'function') return (...args) => { calls.push([name, ...args]); return value.apply(obj, args); };
      if (value && typeof value === 'object') return recorded(value, calls, `${name}.`);
      return value;
    },
  });
}

// What a build may do before it writes: ask. Every other call is a write to the environment or the workspace.
const READS = new Set(['findArtifact', 'queryRecords', 'findTables', 'findColumns', 'fetchEntityMetadata', 'listArtifacts', 'getArtifact', 'resolveArtifact', 'dataverse.get']);
const writesIn = (calls) => calls.filter(([name]) => !READS.has(name));

// A simple SDK (helpers/mock-sdk.js) that answers whether the app exists:
//   absent           neither the dry run's read (an `appmodule` query) nor the build's (`findArtifact`) finds it
//   present          both find it
//   unreadable       every read of it fails, as a read that is refused does
//   unreadable-once  the first read of it fails (the check's), the next ones find it absent (the app step's own)
function environment({ app = 'absent' } = {}) {
  const base = makeSimpleMockSdk().sdk;
  let reads = 0;
  const answer = async () => {
    reads += 1;
    if (app === 'unreadable' || (app === 'unreadable-once' && reads === 1)) throw new Error('read refused (HTTP 503)');
    return app === 'present';
  };
  const sdk = {
    ...base,
    queryRecords: async (set, options) => (set === 'appmodule' ? ((await answer()) ? [{ appmoduleid: 'app-existing' }] : []) : base.queryRecords(set, options)),
    findArtifact: async (kind, identity) => (kind === 'app' ? ((await answer()) ? 'app-existing' : null) : base.findArtifact(kind, identity)),
    // What the build asks of the app it finds: whether its workspace copy holds edits it never pushed.
    listArtifacts: async (kind) => (kind === 'app' && app === 'present' ? [{ type: 'app', id: 'app-existing', isDirty: false }] : []),
  };
  const calls = [];
  return { sdk: recorded(sdk, calls), calls };
}

// ── An app with pages ────────────────────────────────────────────────────────────────────────────────────────────
// The pages phase reads the environment through the app's sitemap, the page manifest and the list of generated
// pages, and writes the navigation once, in its finalizer. Same shape as the fakes of sdk-build-pages-deploy.test.js,
// cut down to what a build of one existing or new app with pages touches.
const APP_ID = 'a1b2c3d4-0000-4000-8000-000000000001';
const SELF_UNIQUE_VALUE = 'c0ffee00-0000-4000-8000-00000000dddd';
const SELF_SITEMAP_ID = '5111e0f2-0000-4000-8000-0000000000aa';
const jclone = (value) => JSON.parse(JSON.stringify(value));
function jpSet(obj, pointer, value) {
  const tokens = pointer.split('/').slice(1);
  const last = tokens.pop();
  let at = obj;
  for (const token of tokens) at = at[token];
  at[last] = value;
}

// `existing`: the app is already deployed, with `existingSitemap` as its navigation.
function pagesEnvironment({ existing = false, existingSitemap = { areas: [] } } = {}) {
  const store = {};
  let nextId = 0;
  const base = {
    queryRecords: async (set, options = {}) => {
      const filter = options.filter || '';
      if (set === 'appmodule') {
        const match = filter.match(/uniquename eq '([^']+)'/);
        return [{ appmoduleid: APP_ID, appmoduleidunique: SELF_UNIQUE_VALUE, uniquename: match ? match[1] : undefined }];
      }
      if (set === 'appmodulecomponent') return [{ objectid: SELF_SITEMAP_ID, componenttype: 62 }];
      if (set === 'sitemap') return /sitemapnameunique eq/.test(filter) ? [{ sitemapid: 'sm-1' }] : [{ sitemapxml: '<SiteMap><Area><Group></Group></Area></SiteMap>' }];
      if (set === 'solution') return [];
      if (set === 'webresource' || set === 'uxagentproject' || set === 'systemform') return [];
      if (set === 'savedquery') return [{ savedqueryid: 'defview-x', isdefault: true }];
      return [{ publisherid: 'pub-1' }];
    },
    findArtifact: async (kind) => (kind === 'app' && existing ? 'app-existing' : null),
    listArtifacts: async (kind) => (kind === 'app' && existing ? [{ type: 'app', id: 'app-existing', isDirty: false }] : []),
    // A deployed app as the SDK fetches it: `name` and `description` are always there (the adapter reads a description the row does not
    // hold as ''), and here they are what `specFor` writes — an app whose header already says what the spec says.
    fetchArtifact: async (type, id) => {
      if (!store[`${type}:${id}`]) store[`${type}:${id}`] = type === 'app' ? { id, name: 'Support Desk', description: 'Tickets', siteMap: jclone(existingSitemap) } : { id };
      return store[`${type}:${id}`];
    },
    createPublisher: async () => ({ id: 'pub-new' }),
    createSolution: async () => ({ id: 'sol-1' }),
    findTables: async () => [],
    findColumns: async () => [],
    fetchEntityMetadata: async (logical) => ({ logicalName: logical, entitySetName: `${logical}s`, attributes: [], relationships: [] }),
    createTable: async (o) => ({ logicalName: o.schemaName.toLowerCase(), entitySetName: `${o.schemaName.toLowerCase()}s`, metadataId: `tbl-${o.schemaName}` }),
    createColumn: async (e, o) => ({ logicalName: o.schemaName.toLowerCase(), metadataId: `col-${o.schemaName}` }),
    createRelationship: async (o) => ({ schemaName: o.schemaName }),
    createWebResource: async (o) => ({ id: `wr-${++nextId}`, name: o.name }),
    updateWebResource: async () => ({}),
    enrichDefaultViews: async () => ({ updated: [] }),
    createArtifact: (type, def) => {
      const id = `${type}-${++nextId}`;
      store[`${type}:${id}`] = { id, ...jclone(def) };
      return jclone(store[`${type}:${id}`]);
    },
    getArtifact: async (type, id) => store[`${type}:${id}`] || { id },
    addElement: async () => ({}),
    updateElement: async (type, id, pointer, value) => {
      if (!store[`${type}:${id}`]) store[`${type}:${id}`] = { id };
      jpSet(store[`${type}:${id}`], pointer, jclone(value));
      return {};
    },
    removeElement: async () => ({}),
    pushArtifact: async (type, id) => ({ type, id, saved: true, shipped: false, publish: { kind: 'notRequested' } }),
    addSolutionComponent: async () => undefined,
    publishArtifact: async (type, id) => ({ type, id, shipped: true, publish: { kind: 'verified' } }),
    // The shared-page scan: the apps in the environment, and the saved navigation of each (only this one here). And the page table's solution component type,
    // which the pages phase reads to add the pages it writes to the spec's solution (helpers/page-component-type.js).
    dataverse: {
      get: withPageType(async (url) => {
        if (url.startsWith('/appmodules/')) return { status: 200, body: { value: [{ appmoduleid: APP_ID, appmoduleidunique: SELF_UNIQUE_VALUE, uniquename: 'new_supportdesk', componentstate: 0 }] } };
        if (url.startsWith('/sitemaps/')) return { status: 200, body: { value: [] } };
        return { status: 404, body: null };
      }),
    },
  };
  const calls = [];
  return { sdk: recorded(base, calls), calls, store };
}

// The page backend as the build sees it (lib/genpage-sdk.js, through the shared stand-in helpers/fake-genpage.js): an environment
// with no generated pages, so the build creates each page of the spec, under an id the backend mints — the ids the pac double these
// tests were written with minted, so the requests a build makes (the navigation names each page's id) compare with the recorded
// ones. `uploads` is the names of the pages it was asked to write, created or updated.
function pageBackend() {
  let minted = 0;
  const backend = fakeGenpage({ newId: () => `a22c9d20-0000-4000-8000-${String(++minted).padStart(12, '0')}` });
  Object.defineProperty(backend, 'uploads', {
    get: () => backend.calls
      .filter((c) => c.method === 'create' || c.method === 'update')
      .map((c) => (c.method === 'create' ? c.args[0].name : c.args[1].name)),
  });
  return backend;
}

// A temporary app folder holding an implemented page for each key (the pages phase reads the source from disk).
function appFolder(keys) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-navigation-'));
  for (const key of keys) fs.writeFileSync(path.join(dir, `${key}.tsx`), 'export default function Page(){ return null; }', 'utf8');
  return dir;
}

module.exports = { recorded, writesIn, environment, pagesEnvironment, pageBackend, appFolder, APP_ID };
