'use strict';
// A small STATEFUL stand-in for the slice of Dataverse that a rebuild of views, charts and forms touches, to be
// handed to the REAL vendored SDK as its `httpClient`. A test then asserts on what actually went over the wire —
// request counts by kind, the rows left behind, what was published — rather than on which SDK methods a mock saw.
//
// It models just enough of the platform's behaviour for the SDK's own concurrency checks to hold:
//   * every row carries a version; `etag` is `W/"<version>"`, and a PATCH whose `If-Match` is not the current one
//     answers 412, so a write built on a stale copy fails here as it would live;
//   * a row records the version last PUBLISHED (`publishedVersion`), set by a `PublishXml` that names its table, so
//     "was every saved change published?" is a question a test can ask (`unpublished()`);
//   * `solutioncomponents` rows are the components AddSolutionComponent was called for (or seeded), plus one row per
//     table the solution holds (`heldTables`), and the collection pages when `pageSize` is set. The rows are shaped,
//     and left out, the way the platform does it:
//       - a table row is `{ componenttype: 1, objectid: <the table's MetadataId>, rootcomponentbehavior: 0|1|2 }`
//         (0 Include Subcomponents, 1 Do not include subcomponents, 2 Include As Shell Only); any other row carries
//         `rootcomponentbehavior: null`;
//       - the views, forms and charts of a table held with ALL its subcomponents (0) are members without a row of
//         their own — an AddSolutionComponent for one succeeds and leaves nothing behind (measured live: a rebuild of
//         a build-created table found no row for them, and the SDK's own solution reader documents the same);
//       - a table held at 1 or 2, or not held at all, lists such a component only once it was added on its own;
//       - `$select` is honoured, so a read that forgets to select `rootcomponentbehavior` is not handed it.
//
// Anything it does not model throws, naming the request — a new SDK read shows up as a loud failure in the test that
// first needs it, not as a silently empty answer.
//
// Wire shapes mirrored (abridged):
//   GET  /savedqueries(<id>)?$select=savedqueryid                                    -> ETag header (the row token)
//   GET  /savedqueries(<id>)/Microsoft.Dynamics.CRM.RetrieveUnpublished()?$select=…  -> the row + "@odata.etag"
//   GET  /EntityDefinitions(LogicalName='x')?$select=MetadataId,EntitySetName        -> the table's metadata
//   GET  /solutioncomponents?$select=objectid,componenttype,rootcomponentbehavior&$filter=_solutionid_value eq <id> and (componenttype eq 26 or …)
//   PATCH /savedqueries(<id>)?$select=savedqueryid   If-Match, Prefer: return=representation -> 200 + ETag
//   POST /AddSolutionComponent  { ComponentId, ComponentType, SolutionUniqueName }
//   POST /PublishXml            { ParameterXml: "<importexportxml><entities><entity>x</entity></entities>…" }
const { randomUUID } = require('node:crypto');

const GUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const clone = (value) => JSON.parse(JSON.stringify(value));

// Entity sets the SDK resolves through EntityDefinitions(LogicalName='x')?$select=EntitySetName.
const SET_NAMES = {
  savedquery: 'savedqueries',
  savedqueryvisualization: 'savedqueryvisualizations',
  systemform: 'systemforms',
  solution: 'solutions',
  solutioncomponent: 'solutioncomponents',
};

// How each row type names its table and its id, so the generic handlers below serve all three.
const KINDS = {
  savedqueries: { id: 'savedqueryid', entity: 'returnedtypecode', published: 'view' },
  systemforms: { id: 'formid', entity: 'objecttypecode', published: 'form' },
  savedqueryvisualizations: { id: 'savedqueryvisualizationid', entity: 'primaryentitytypecode', published: 'chart' },
};

// The solution component type of each row type: Saved Query, System Form, Saved Query Visualization.
const COMPONENT_KIND = { 26: 'savedqueries', 60: 'systemforms', 59: 'savedqueryvisualizations' };

function createFakeDataverse({ entities = {}, solution = { uniqueName: 'ContosoSD' }, pageSize, failSolutionComponentReads = false, heldTables = {}, failTableIdReads = false } = {}) {
  const solutionId = solution.id || randomUUID();
  const tables = { savedqueries: new Map(), systemforms: new Map(), savedqueryvisualizations: new Map() };
  const members = new Set(); // `${componentType}:${lower-case id}`
  const held = new Map(Object.entries(heldTables)); // table logical name -> rootcomponentbehavior the solution holds it at
  const entityIds = new Map(); // table logical name -> its MetadataId
  const requests = [];
  const publishes = []; // entity logical names, one array entry per PublishXml entity element
  let denyWrites = null; // (request) => HTTP status | undefined — lets a test make a write fail
  let failTableIds = failTableIdReads; // answers 500 to a metadata read that asks for `MetadataId`, and to no other

  const entityIdOf = (logical) => {
    if (!entityIds.has(logical)) entityIds.set(logical, randomUUID());
    return entityIds.get(logical);
  };

  const etagOf = (row) => `W/"${row.version}"`;
  const reply = (status, body, headers = {}) => ({ status, headers, body });
  const notFound = () => reply(404, { error: { code: '0x80040217', message: 'Does Not Exist' } });
  const normId = (id) => String(id || '').replace(/[{}]/g, '').toLowerCase();

  // `field eq 'text'` / `field eq 12` / `field eq <guid>` joined by `and`. Parenthesised `or` groups are only
  // used by the solution-component query, which has its own reader below.
  function matches(row, filter) {
    if (!filter) return true;
    return filter.split(/\s+and\s+/i).every((clause) => {
      const m = /^\s*([A-Za-z_][\w]*)\s+eq\s+(?:'((?:[^']|'')*)'|(true|false)|(-?\d+)|(\S+))\s*$/.exec(clause);
      if (!m) throw new Error(`fake-dataverse: cannot evaluate filter clause '${clause}'`);
      const [, field, text, bool, num, bare] = m;
      const actual = row[field];
      if (text !== undefined) return String(actual) === text.replace(/''/g, "'");
      if (bool !== undefined) return actual === (bool === 'true');
      if (num !== undefined) return Number(actual) === Number(num);
      return normId(actual) === normId(bare);
    });
  }

  function page(path, rows, query) {
    if (!pageSize) return reply(200, { value: rows });
    const skip = Number(query.get('$skiptoken') || 0);
    const slice = rows.slice(skip, skip + pageSize);
    if (skip + pageSize >= rows.length) return reply(200, { value: slice });
    // An ABSOLUTE same-origin link, as Dataverse emits: the SDK refuses to follow a cross-origin one.
    const next = new URLSearchParams(query);
    next.set('$skiptoken', String(skip + pageSize));
    return reply(200, { value: slice, '@odata.nextLink': `${path.base}/api/data/v9.0${path.pathname}?${next.toString()}` });
  }

  // The solution's rows, shaped as the platform returns them (see the header): one per table it holds, then one per
  // component that was added on its own. `$select` narrows the columns, and the primary key is always returned.
  function solutionComponentRows(filter, select) {
    const solutionMatch = new RegExp(`_solutionid_value eq (${GUID})`, 'i').exec(filter || '');
    if (!solutionMatch || normId(solutionMatch[1]) !== normId(solutionId)) return [];
    const types = [...String(filter).matchAll(/componenttype eq (\d+)/g)].map((m) => Number(m[1]));
    const listed = [
      ...[...held].map(([logical, behavior]) => ({ objectid: entityIdOf(logical), componenttype: 1, rootcomponentbehavior: behavior })),
      ...[...members].map((key) => { const [type, id] = key.split(':'); return { objectid: id, componenttype: Number(type), rootcomponentbehavior: null }; }),
    ];
    const columns = select ? String(select).split(',').map((name) => name.trim()).filter(Boolean) : null;
    return listed
      .filter((row) => !types.length || types.includes(row.componenttype))
      .map((row) => {
        const full = { solutioncomponentid: randomUUID(), ...row };
        if (!columns) return full;
        return Object.fromEntries(Object.entries(full).filter(([name]) => name === 'solutioncomponentid' || columns.includes(name)));
      });
  }

  // The table a view, form or chart belongs to, by the component type AddSolutionComponent was given.
  function tableOfComponent(type, id) {
    const kind = COMPONENT_KIND[Number(type)];
    const row = kind && tables[kind].get(normId(id));
    return row ? row.data[KINDS[kind].entity] : undefined;
  }

  function get(path, query) {
    const p = path.pathname;
    let m;
    if ((m = /^\/EntityDefinitions\(LogicalName='([^']+)'\)$/.exec(p))) {
      // Only a read that asks for the table's MetadataId fails: the rest of the build reads the same endpoint for
      // attributes and entity sets, and a test about the membership lookup must not break the build around it.
      if (failTableIds && /(^|,)MetadataId(,|$)/.test(query.get('$select') || '')) return reply(500, { error: { code: '0x80040E14', message: 'simulated failure' } });
      const logical = m[1];
      const known = entities[logical] || {};
      const attributes = Object.entries(known.attributes || {}).map(([LogicalName, AttributeType]) => ({
        LogicalName, AttributeType, DisplayName: { UserLocalizedLabel: { Label: LogicalName, LanguageCode: 1033 } },
      }));
      return reply(200, { LogicalName: logical, MetadataId: entityIdOf(logical), EntitySetName: SET_NAMES[logical] || known.entitySetName || `${logical}s`, ObjectTypeCode: known.objectTypeCode || 10001, Attributes: attributes });
    }
    if ((m = new RegExp(`^/(savedqueries|systemforms|savedqueryvisualizations)\\((${GUID})\\)(/Microsoft\\.Dynamics\\.CRM\\.RetrieveUnpublished\\(\\))?$`, 'i').exec(p))) {
      const row = tables[m[1]].get(normId(m[2]));
      if (!row) return notFound();
      const body = { ...clone(row.data), '@odata.etag': etagOf(row) };
      if (m[3]) return reply(200, body, { etag: etagOf(row) });
      return reply(200, { [KINDS[m[1]].id]: row.data[KINDS[m[1]].id], '@odata.etag': etagOf(row) }, { etag: etagOf(row) });
    }
    if ((m = /^\/(savedqueries|systemforms|savedqueryvisualizations)$/.exec(p))) {
      const rows = [...tables[m[1]].values()].map((row) => clone(row.data)).filter((data) => matches(data, query.get('$filter')));
      return page(path, rows, query);
    }
    if (p === '/solutions') {
      return reply(200, { value: matches({ uniquename: solution.uniqueName, solutionid: solutionId }, query.get('$filter')) ? [{ solutionid: solutionId, uniquename: solution.uniqueName }] : [] });
    }
    if (p === '/solutioncomponents') {
      if (failSolutionComponentReads) return reply(500, { error: { code: '0x80040E14', message: 'simulated failure' } });
      return page(path, solutionComponentRows(query.get('$filter'), query.get('$select')), query);
    }
    return null;
  }

  function create(kind, body, headers) {
    const idField = KINDS[kind].id;
    const id = normId(body[idField]) || randomUUID();
    if (tables[kind].has(id)) return reply(412, { error: { code: '0x80060892', message: 'A record with matching key values already exists.' } });
    // `canbedeleted`, `formactivationstate` and `createdon` are platform-owned: the platform fills them in.
    const data = { ...clone(body), [idField]: id, createdon: new Date(0).toISOString(), formactivationstate: kind === 'systemforms' ? 1 : undefined };
    if (data.formactivationstate === undefined) delete data.formactivationstate;
    const row = { data, version: 1, publishedVersion: null };
    tables[kind].set(id, row);
    const echo = /return=representation/i.test((headers && headers.Prefer) || '');
    return reply(echo ? 201 : 204, echo ? { [idField]: id, '@odata.etag': etagOf(row) } : {}, { etag: etagOf(row), 'odata-entityid': `https://fake/api/data/v9.0/${kind}(${id})` });
  }

  function patch(kind, id, body, headers) {
    const row = tables[kind].get(normId(id));
    if (!row) return notFound();
    const ifMatch = headers && (headers['If-Match'] || headers['if-match']);
    if (ifMatch && ifMatch !== etagOf(row)) return reply(412, { error: { code: '0x80060882', message: 'The version of the existing record doesn\'t match the RowVersion property provided.' } });
    Object.assign(row.data, clone(body));
    row.version += 1;
    const echo = /return=representation/i.test((headers && headers.Prefer) || '');
    return reply(echo ? 200 : 204, echo ? { [KINDS[kind].id]: normId(id), '@odata.etag': etagOf(row) } : {}, { etag: etagOf(row) });
  }

  function post(path, body, headers) {
    const p = path.pathname;
    let m;
    if ((m = /^\/(savedqueries|systemforms|savedqueryvisualizations)$/.exec(p))) return create(m[1], body, headers);
    if (p === '/AddSolutionComponent') {
      // A table the solution holds with ALL its subcomponents already counts its views, forms and charts: the add
      // succeeds and records nothing (see the header). Held at any other behavior, or not held, the add is the row.
      const owner = tableOfComponent(body.ComponentType, body.ComponentId);
      if (!(owner && held.get(owner) === 0)) members.add(`${Number(body.ComponentType)}:${normId(body.ComponentId)}`);
      return reply(200, { id: randomUUID() });
    }
    if (p === '/PublishXml') {
      const xml = String(body.ParameterXml || '');
      for (const entity of [...xml.matchAll(/<entity>([^<]+)<\/entity>/g)].map((x) => x[1])) {
        publishes.push(entity);
        for (const kind of Object.keys(tables)) {
          for (const row of tables[kind].values()) if (row.data[KINDS[kind].entity] === entity) row.publishedVersion = row.version;
        }
      }
      return reply(204, {});
    }
    return null;
  }

  function dispatch(method, url, body, options) {
    const u = new URL(url);
    const path = { pathname: decodeURIComponent(u.pathname.replace(/^.*\/api\/data\/v[\d.]+/, '')), base: u.origin };
    const headers = (options && options.headers) || {};
    const entry = { method, path: path.pathname, query: Object.fromEntries(u.searchParams), body: body === undefined ? undefined : clone(body), headers };
    requests.push(entry);
    if (method !== 'GET' && denyWrites) {
      const status = denyWrites(entry);
      if (status) return reply(status, { error: { code: '0x80040E14', message: `simulated ${status}` } });
    }
    let response = null;
    if (method === 'GET') response = get(path, u.searchParams);
    else if (method === 'POST') response = post(path, body, headers);
    else if (method === 'PATCH') {
      const m = new RegExp(`^/(savedqueries|systemforms|savedqueryvisualizations)\\((${GUID})\\)$`, 'i').exec(path.pathname);
      if (m) response = patch(m[1], m[2], body, headers);
    }
    if (!response) throw new Error(`fake-dataverse: unhandled ${method} ${path.pathname}${u.search}`);
    return response;
  }

  const httpClient = {
    get: async (url, options) => dispatch('GET', url, undefined, options),
    post: async (url, body, options) => dispatch('POST', url, body, options),
    patch: async (url, body, options) => dispatch('PATCH', url, body, options),
    put: async (url) => { throw new Error(`fake-dataverse: unexpected PUT ${url}`); },
    delete: async (url) => { throw new Error(`fake-dataverse: unexpected DELETE ${url}`); },
  };

  // `METHOD resource` per write ("PATCH savedqueries", "POST PublishXml"), so a test reads like the measurement
  // that motivated it. `since` limits it to the requests after a `mark()`.
  const resourceOf = (entry) => entry.path.replace(/^\//, '').replace(/\([^)]*\)/g, '').split('/')[0];
  function writeCounts(since = 0) {
    const counts = {};
    for (const entry of requests.slice(since)) {
      if (entry.method === 'GET') continue;
      const key = `${entry.method} ${resourceOf(entry)}`;
      counts[key] = (counts[key] || 0) + 1;
    }
    return counts;
  }

  return {
    httpClient,
    requests,
    solutionId,
    solutionUniqueName: solution.uniqueName,
    // The platform's own "Active <Plural>" / "Inactive <Plural>" pair for a table, as it ships: not deletable, one
    // `statecode` condition, created together. The SDK's default-view enrichment finds the pair by that shape.
    seedDefaultViews(entity, plural) {
      const grid = (primary) => `<grid name="resultset" object="10001" jump="${primary}" select="1" icon="1" preview="1"><row name="result" id="${entity}id"><cell name="${primary}" width="300"/></row></grid>`;
      for (const [name, state] of [[`Active ${plural}`, 0], [`Inactive ${plural}`, 1]]) {
        const id = randomUUID();
        tables.savedqueries.set(id, {
          data: { savedqueryid: id, name, description: '', returnedtypecode: entity, querytype: 0, isdefault: state === 0, canbedeleted: { Value: false }, createdon: new Date(0).toISOString(),
            fetchxml: `<fetch version="1.0" mapping="logical"><entity name="${entity}"><attribute name="${entity}_name"/><filter type="and"><condition attribute="statecode" operator="eq" value="${state}"/></filter></entity></fetch>`,
            layoutxml: grid(`${entity}_name`) },
          version: 1, publishedVersion: 1,
        });
      }
    },
    mark: () => requests.length,
    since: (mark) => requests.slice(mark),
    writeCounts,
    // Writes carrying a document (a form's formxml, a view's layoutxml) are SAVES; the others PATCH one flag.
    saves: (since = 0) => requests.slice(since).filter((e) => e.method === 'PATCH' && e.body && (e.body.formxml || e.body.layoutxml || e.body.fetchxml)),
    reads: (pattern, since = 0) => requests.slice(since).filter((e) => e.method === 'GET' && pattern.test(e.path)),
    members,
    removeMember: (type, id) => members.delete(`${Number(type)}:${normId(id)}`),
    publishes,
    rows: (kind) => [...tables[kind].values()],
    // Rows whose latest saved version is not the one last published.
    unpublished: () => Object.keys(tables).flatMap((kind) => [...tables[kind].values()]
      .filter((row) => row.publishedVersion !== row.version)
      .map((row) => ({ kind, id: row.data[KINDS[kind].id], name: row.data.name }))),
    failWritesWhen: (fn) => { denyWrites = fn; },
    // What the solution holds of each table (logical name -> rootcomponentbehavior), and the MetadataId the table
    // row and the table's metadata carry. `holdTable` changes it between builds, as a maker would.
    heldTables: held,
    holdTable: (logical, behavior) => { held.set(logical, behavior); },
    entityId: entityIdOf,
    failTableIdReads: (fails) => { failTableIds = fails; },
  };
}

module.exports = { createFakeDataverse };
