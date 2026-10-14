'use strict';
// A fake Dataverse for scripts/apps.js and scripts/list-tables.js: the reads they make and the writes the SDK's app create makes, answered the
// way the platform answers them (the shapes were captured from the real bundle's own requests), over the LOW-LEVEL transport the plugin's
// az-token HttpClient takes (`request({ url, method, headers, body })` -> `{ statusCode, headers, body }`), so a test drives the real client,
// the real bundle and the real script, and sees exactly what reached the wire:
//
//   const org = createFakeAppsOrg({ pages: [{ id, name }] });
//   const client = createAzHttpClient(ORIGIN, { getToken: () => 'test-token', request: org.request, sleep: async () => {} });
//
// Every request is recorded, in order, as `{ method, path, body }` with the path below the API root and decoded
// (`/solutions?$select=…&$filter=uniquename eq 'ContosoCore'`); `org.writes()` is the ones that changed something. A JSON body is recorded parsed;
// the one request with another kind of body, the SDK's `$batch` change set (multipart), is recorded as the text it is and with its `operations`
// (`{ contentId, method, path, headers }`, the path as above). A request the fake does not know is recorded in `org.unexpected` AND answered 404 —
// the SDK swallows the failure of a best-effort read, so a test asserts the list is empty rather than trusting a thrown error to surface.
//
// An app is a DRAFT (componentstate 1) until a PublishXml names it, as on the platform; `org.state` is what the platform now holds:
//   solutions   [{ solutionid, uniquename, friendlyname, ismanaged }]      the solutions that exist
//   pages       [{ id, name, componentstate }]                             the generative pages (uxagentproject rows). The page's own tables are `dataSources` (default none), and a page with
//                                                                          `raw: true` has no file rows at all — a page the SDK holds as raw files, which has no configuration to read. The page
//                                                                          backend reads a page's rows, files and conversation through the same fake (helpers/fake-genpage-server.js, seeded from this list)
//   views       [{ savedqueryid, table }]                                  the default public view (querytype 0, isdefault) each table has, by logical name
//   apps        [{ appmoduleid, name, uniquename, description, componentstate, published }]   one row per app layer. `published` is whether the
//                                                                          PUBLISHED layer holds the row: by default componentstate 0 does and 1 does
//                                                                          not (a draft); `{ componentstate: 1, published: true }` is a published app with a
//                                                                          saved edit, whose published row is still there
//   sitemaps    [{ sitemapid, sitemapnameunique, sitemapname, sitemapxml }]
//   tables      [{ logicalName, schemaName, displayName, isCustom, entitySetName }]   the table definitions (`EntityDefinitions`)
//   components  [{ solution, objectid, type }]                             what AddSolutionComponent was given
//   publishes   [appmoduleid]                                              what PublishXml named
//   appSettings [{ appsettingid, parentappmoduleid, settingdefinitionid, value, published }]   the app settings the SDK wrote. A new row is in the
//                                                                          unpublished layer only: `RetrieveUnpublishedMultiple` reads it, a plain
//                                                                          read of `appsettings` does not until a PublishXml names its app
// `options.settingDefinitions` are the setting definitions the environment has, by unique name (default: HeaderAndNavigationRefresh); `options.answer(req)`
// may return a response for any request first (a refusal, a 500), where `req` is the recorded request; `options.pageSize` makes the apps collections
// answer that many rows at a time, with an absolute `@odata.nextLink`.
const { randomUUID } = require('node:crypto');
const { FakeGenPageServer, API: PAGE_API } = require('./fake-genpage-server.js');

const ENTITY_SETS = { solution: 'solutions', organization: 'organizations', webresource: 'webresourceset', sitemap: 'sitemaps', appmodule: 'appmodules', uxagentproject: 'uxagentprojects', savedquery: 'savedqueries' };
const GUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const API_ROOT = /^\/api\/data\/v9\.\d/;

const json = (statusCode, body, headers = {}) => ({ statusCode, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const noContent = (headers = {}) => ({ statusCode: 204, headers, body: '' });
const rows = (value) => json(200, { value });

const STATUS_TEXT = { 200: 'OK', 204: 'No Content', 400: 'Bad Request', 404: 'Not Found', 412: 'Precondition Failed', 500: 'Internal Server Error' };

/**
 * The operations of a `$batch` change set, as the SDK writes it (a multipart body; the boundaries differ per request):
 *   --batch_1
 *   Content-Type: multipart/mixed;boundary=changeset_1
 *
 *   --changeset_1
 *   Content-Type: application/http
 *   Content-Transfer-Encoding: binary
 *   Content-ID: 1
 *
 *   DELETE https://contoso.crm.dynamics.com/api/data/v9.0/sitemaps(<id>) HTTP/1.1
 *   If-Match: W/"2001"
 *
 *   --changeset_1--
 *   --batch_1--
 * @returns {{ contentId: string, method: string, path: string, headers: object }[]} each path below the API root; header names lower-cased
 */
function parseBatch(text) {
  const boundary = (/^Content-Type:\s*multipart\/mixed;\s*boundary=(\S+)/im.exec(text) || [])[1];
  if (!boundary) return [];
  return text.split(`--${boundary}`).slice(1).filter((segment) => !segment.startsWith('--')).map((segment) => {
    const blank = segment.search(/\r?\n\r?\n/);
    const mime = segment.slice(0, blank);
    const [requestLine, ...rest] = segment.slice(blank).replace(/^\r?\n\r?\n/, '').split(/\r?\n/);
    const [, method, url] = /^(\w+)\s+(\S+)\s+HTTP\/1\.1$/.exec(requestLine) || [];
    const headers = {};
    for (const line of rest) {
      if (!line) break;
      const colon = line.indexOf(':');
      headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
    }
    const parsed = new URL(url);
    return {
      contentId: (/^Content-ID:\s*(\S+)/im.exec(mime) || [])[1],
      method,
      path: decodeURIComponent(parsed.pathname + parsed.search).replace(API_ROOT, ''),
      headers,
    };
  });
}

/**
 * The answer to a `$batch` change set, as the platform words it (Dataverse names its own boundaries, and echoes each Content-ID):
 *   --batchresponse_1
 *   Content-Type: multipart/mixed; boundary=changesetresponse_1
 *
 *   --changesetresponse_1
 *   Content-Type: application/http
 *   Content-Transfer-Encoding: binary
 *   Content-ID: 1
 *
 *   HTTP/1.1 204 No Content
 *   OData-Version: 4.0
 *
 *   --changesetresponse_1--
 *   --batchresponse_1--
 * A test that wants the platform to refuse the set answers it with `batchResponse([{ contentId: '2', status: 412 }])`: a change set that fails is
 * answered with the failed operation alone, and nothing in it was applied.
 */
function batchResponse(parts) {
  const batch = `batchresponse_${randomUUID()}`;
  const changeset = `changesetresponse_${randomUUID()}`;
  const body = [
    `--${batch}`,
    `Content-Type: multipart/mixed; boundary=${changeset}`,
    '',
    ...parts.map(({ contentId, status }) => [
      `--${changeset}`,
      'Content-Type: application/http',
      'Content-Transfer-Encoding: binary',
      `Content-ID: ${contentId}`,
      '',
      `HTTP/1.1 ${status} ${STATUS_TEXT[status] || 'Status'}`,
      'OData-Version: 4.0',
      '',
      '',
    ].join('\r\n')),
    `--${changeset}--`,
    `--${batch}--`,
    '',
  ].join('\r\n');
  return { statusCode: 200, headers: { 'content-type': `multipart/mixed; boundary=${batch}` }, body };
}

function createFakeAppsOrg(options = {}) {
  const origin = options.origin || 'https://contoso.crm.dynamics.com';
  const state = {
    solutions: options.solutions || [{ solutionid: randomUUID(), uniquename: 'ContosoCore', friendlyname: 'Contoso Core', ismanaged: false }],
    pages: (options.pages || []).map((page) => ({ componentstate: 0, ...page })),
    apps: (options.apps || []).map((app) => ({ description: null, componentstate: 0, ...app })),
    sitemaps: (options.sitemaps || []).map((sitemap) => ({ sitemapname: sitemap.sitemapnameunique, sitemapxml: '<SiteMap />', ...sitemap })),
    tables: options.tables || [],
    baseLanguage: options.baseLanguage === undefined ? 1033 : options.baseLanguage,
    settingDefinitions: (options.settingDefinitions || ['HeaderAndNavigationRefresh']).map((uniquename) => ({ settingdefinitionid: randomUUID(), uniquename, displayname: uniquename })),
    appSettings: [],
    components: [],
    publishes: [],
    views: options.views || [],
  };
  // The page backend reads a page through its own tables (project, files, conversation), which this fake answers by handing those requests to a stateful page fake seeded from `pages`:
  // every page has the four rows the maker lays out, holding its `dataSources` (none, by default) — unless it is `raw`, a project with no rows.
  const pageServer = new FakeGenPageServer();
  for (const page of state.pages) {
    const id = String(page.id).toLowerCase();
    if (page.raw) pageServer.seedProject(id, page.name);
    else pageServer.seedPage(id, { name: page.name, config: { dataSources: page.dataSources || [], model: '' } });
  }
  const PAGE_PATH = /^\/(uxagentprojects\(|uxagentprojectfiles|agentconversationmessages)/;
  // The page fake answers the way the SDK's own HttpClient does (`{ status, headers, body }`); this fake answers the plugin's low-level transport (`{ statusCode, headers, body }`), whose body is text — or,
  // for a file's content, the bytes as they are.
  async function pageRequest({ method, headers, body }, where) {
    const res = await pageServer.receive(method, `${PAGE_API}${where}`, body ? JSON.parse(body) : undefined, { headers }, false, {});
    const lowered = Object.fromEntries(Object.entries(res.headers || {}).map(([name, value]) => [name.toLowerCase(), value]));
    const bytes = Buffer.isBuffer(res.body) || res.body instanceof Uint8Array;
    return { statusCode: res.status, headers: bytes ? lowered : { 'content-type': 'application/json', ...lowered }, body: bytes ? Buffer.from(res.body) : (res.body === undefined ? '' : JSON.stringify(res.body)) };
  }
  const requests = [];
  const unexpected = [];
  const roleId = randomUUID();
  // Whether the PUBLISHED layer holds an app row: a draft's row is saved only, a published app's is in both layers.
  const isPublished = (app) => (app.published === undefined ? app.componentstate === 0 : Boolean(app.published));

  const filterOf = (where) => {
    const m = /[?&]\$filter=([^&]*)/.exec(where);
    return m ? m[1] : '';
  };
  // With `options.pageSize` a collection answers that many rows at a time and an ABSOLUTE `@odata.nextLink`, as the platform does past its page:
  //   { "value": [ … ], "@odata.nextLink": "https://contoso.crm.dynamics.com/api/data/v9.0/appmodules/…?$select=…&$skiptoken=2" }
  const page = (where, all) => {
    if (!options.pageSize) return rows(all);
    const at = Number((/[?&]\$skiptoken=(\d+)/.exec(where) || [])[1] || 0);
    const slice = all.slice(at, at + options.pageSize);
    const base = where.replace(/&\$skiptoken=\d+/, '');
    return json(200, { value: slice, ...(at + options.pageSize < all.length ? { '@odata.nextLink': `${origin}/api/data/v9.0${base}&$skiptoken=${at + options.pageSize}` } : {}) });
  };
  const equalsText = (filter, column) => {
    const m = new RegExp(`${column} eq '((?:[^']|'')*)'`, 'i').exec(filter);
    return m ? m[1].replace(/''/g, "'").toLowerCase() : null;
  };
  const equalsGuids = (filter, column) => [...filter.matchAll(new RegExp(`${column} eq (${GUID})`, 'gi'))].map((m) => m[1].toLowerCase());
  const lc = (value) => String(value || '').toLowerCase();

  function get(where) {
    const filter = filterOf(where);
    // The table list the SDK's findTables reads, each row as the platform shapes it (a table with no display name has no label):
    //   { "LogicalName": "account", "SchemaName": "Account", "EntitySetName": "accounts", "IsCustomEntity": false,
    //     "DisplayName": { "LocalizedLabels": [ { "Label": "Account", "LanguageCode": 1033 } ], "UserLocalizedLabel": { "Label": "Account", "LanguageCode": 1033 } } }
    if (/^\/EntityDefinitions\?/.test(where)) {
      return rows(state.tables.map((table) => ({
        LogicalName: table.logicalName,
        SchemaName: table.schemaName || table.logicalName,
        EntitySetName: table.entitySetName || `${table.logicalName}s`,
        IsCustomEntity: Boolean(table.isCustom),
        DisplayName: table.displayName
          ? { LocalizedLabels: [{ Label: table.displayName, LanguageCode: 1033 }], UserLocalizedLabel: { Label: table.displayName, LanguageCode: 1033 } }
          : { LocalizedLabels: [], UserLocalizedLabel: null },
      })));
    }
    const entity = /^\/EntityDefinitions\(LogicalName='([^']+)'\)/.exec(where);
    if (entity) return json(200, { LogicalName: entity[1], MetadataId: randomUUID(), EntitySetName: ENTITY_SETS[entity[1]] || `${entity[1]}s` });
    if (/^\/solutions\?/.test(where)) {
      const name = equalsText(filter, 'uniquename');
      return rows(state.solutions.filter((solution) => name === null || lc(solution.uniquename) === name));
    }
    if (/^\/organizations\?/.test(where)) {
      return rows(state.baseLanguage === null ? [] : [{ organizationid: randomUUID(), languagecode: state.baseLanguage }]);
    }
    if (/^\/uxagentprojects\/Microsoft\.Dynamics\.CRM\.RetrieveUnpublishedMultiple\(\)\?/.test(where)) {
      const wanted = equalsGuids(filter, 'uxagentprojectid');
      return rows(state.pages.filter((page) => wanted.includes(lc(page.id))).map((page) => ({ uxagentprojectid: page.id, name: page.name, componentstate: page.componentstate })));
    }
    if (/^\/appmodules\/Microsoft\.Dynamics\.CRM\.RetrieveUnpublishedMultiple\(\)\?/.test(where)) {
      const unique = equalsText(filter, 'uniquename');
      const ids = equalsGuids(filter, 'appmoduleid');
      const matching = state.apps.filter((app) => (unique === null || lc(app.uniquename) === unique) && (!ids.length || ids.includes(lc(app.appmoduleid))));
      return page(where, matching);
    }
    if (/^\/sitemaps(\/Microsoft\.Dynamics\.CRM\.RetrieveUnpublishedMultiple\(\))?\?/.test(where)) {
      const unique = equalsText(filter, 'sitemapnameunique');
      const ids = equalsGuids(filter, 'sitemapid');
      return rows(state.sitemaps.filter((sitemap) => (unique === null || lc(sitemap.sitemapnameunique) === unique) && (!ids.length || ids.includes(lc(sitemap.sitemapid)))));
    }
    if (/^\/roles\?/.test(where)) return rows([{ roleid: roleId, _parentrootroleid_value: roleId }]);
    // The default public view of a table, as the page backend asks for it (the same read the placement of a page in an app makes):
    //   GET /savedqueries?$select=savedqueryid&$filter=returnedtypecode eq 'account' and querytype eq 0 and isdefault eq true&$top=1
    if (/^\/savedqueries\?/.test(where)) {
      const table = equalsText(filter, 'returnedtypecode');
      return rows(state.views.filter((view) => lc(view.table) === table).map((view) => ({ savedqueryid: view.savedqueryid })));
    }
    // The setting definitions the environment has, by unique name or by id:
    //   { "settingdefinitionid": "…", "uniquename": "HeaderAndNavigationRefresh", "displayname": "HeaderAndNavigationRefresh" }
    if (/^\/settingdefinitions\?/.test(where)) {
      const names = [...filter.matchAll(/uniquename eq '((?:[^']|'')*)'/gi)].map((m) => m[1].replace(/''/g, "'").toLowerCase());
      const ids = equalsGuids(filter, 'settingdefinitionid');
      return rows(state.settingDefinitions.filter((def) => (!names.length && !ids.length) || names.includes(lc(def.uniquename)) || ids.includes(lc(def.settingdefinitionid))));
    }
    // A setting row the SDK wrote is in the unpublished layer: only RetrieveUnpublishedMultiple reads it until its app is published.
    //   { "appsettingid": "…", "value": "2", "_settingdefinitionid_value": "…", "_parentappmoduleid_value": "…" }
    if (/^\/appsettings(\/Microsoft\.Dynamics\.CRM\.RetrieveUnpublishedMultiple\(\))?\?/.test(where)) {
      const unpublishedToo = /RetrieveUnpublishedMultiple/.test(where);
      const parents = equalsGuids(filter, '_parentappmoduleid_value');
      const definitions = equalsGuids(filter, '_settingdefinitionid_value');
      return rows(state.appSettings
        .filter((setting) => (unpublishedToo || setting.published)
          && (!parents.length || parents.includes(lc(setting.parentappmoduleid)))
          && (!definitions.length || definitions.includes(lc(setting.settingdefinitionid))))
        .map((setting) => ({ appsettingid: setting.appsettingid, value: setting.value, _settingdefinitionid_value: setting.settingdefinitionid, _parentappmoduleid_value: setting.parentappmoduleid })));
    }
    // The PUBLISHED layer of the apps: the apps users can open. A draft is not in it.
    if (/^\/appmodules\?/.test(where)) {
      const unique = equalsText(filter, 'uniquename');
      return page(where, state.apps.filter((app) => isPublished(app) && (unique === null || lc(app.uniquename) === unique)));
    }
    // The reads after a publish that adopt the tokens it rotated, by id: a draft app is not in the published projection, so it answers 404.
    const byId = new RegExp(`^/(appmodules|sitemaps)\\((${GUID})\\)`).exec(where);
    if (byId) {
      const id = lc(byId[2]);
      const found = byId[1] === 'sitemaps'
        ? state.sitemaps.find((sitemap) => lc(sitemap.sitemapid) === id)
        : state.apps.find((app) => lc(app.appmoduleid) === id && app.componentstate === 0);
      return found ? json(200, found, { etag: 'W/"1001"' }) : json(404, { error: { code: '0x80040217', message: `${byId[1]} With Id ${id} Does Not Exist` } });
    }
    return null;
  }

  function post(where, body) {
    if (/^\/appmodules(\?|$)/.test(where)) {
      if (state.apps.some((app) => lc(app.uniquename) === lc(body.uniquename))) {
        return json(400, { error: { code: '0x80040237', message: `A record with the same unique name '${body.uniquename}' already exists.` } });
      }
      state.apps.push({ appmoduleid: body.appmoduleid, name: body.name, uniquename: body.uniquename, description: body.description || null, componentstate: 1 });
      return noContent({ 'odata-entityid': `${origin}/api/data/v9.0/appmodules(${body.appmoduleid})` });
    }
    if (/^\/sitemaps(\?|$)/.test(where)) {
      if (state.sitemaps.some((sitemap) => lc(sitemap.sitemapnameunique) === lc(body.sitemapnameunique))) {
        return json(400, { error: { code: '0x80048404', message: `The name ${body.sitemapnameunique} is already in use by an existing site map.` } });
      }
      state.sitemaps.push({ sitemapid: body.sitemapid, sitemapnameunique: body.sitemapnameunique, sitemapname: body.sitemapname, sitemapxml: body.sitemapxml });
      return json(201, { sitemapid: body.sitemapid, '@odata.etag': 'W/"2001"' }, { etag: 'W/"2001"' });
    }
    if (/^\/AddAppComponents$/.test(where)) return noContent();
    if (/^\/appmodules\(.+\)\/appmoduleroles_association\/\$ref$/.test(where)) return noContent();
    if (/^\/appsettings(\?|$)/.test(where)) {
      // The row binds the app and the definition, and carries the value:
      //   { "parentappmoduleid@odata.bind": "/appmodules(<id>)", "settingdefinitionid@odata.bind": "/settingdefinitions(<id>)", "value": "2" }
      const bound = (key, set) => (new RegExp(`/${set}\\((.+)\\)`).exec(body[key] || '') || [])[1];
      const appsettingid = randomUUID();
      state.appSettings.push({
        appsettingid,
        parentappmoduleid: bound('parentappmoduleid@odata.bind', 'appmodules'),
        settingdefinitionid: bound('settingdefinitionid@odata.bind', 'settingdefinitions'),
        value: body.value,
        published: false,
      });
      return noContent({ 'odata-entityid': `${origin}/api/data/v9.0/appsettings(${appsettingid})` });
    }
    if (/^\/AddSolutionComponent$/.test(where)) {
      if (!state.solutions.some((solution) => lc(solution.uniquename) === lc(body.SolutionUniqueName))) {
        return json(400, { error: { code: '0x80048d19', message: `Solution ${body.SolutionUniqueName} does not exist.` } });
      }
      state.components.push({ solution: body.SolutionUniqueName, objectid: lc(body.ComponentId), type: body.ComponentType });
      return json(200, { id: randomUUID() });
    }
    if (/^\/PublishXml$/.test(where)) {
      const ids = [...String(body.ParameterXml).matchAll(new RegExp(`<appmodule>(${GUID})</appmodule>`, 'g'))].map((m) => lc(m[1]));
      for (const app of state.apps) {
        if (ids.includes(lc(app.appmoduleid))) Object.assign(app, { componentstate: 0, published: true });
      }
      for (const setting of state.appSettings) if (ids.includes(lc(setting.parentappmoduleid))) setting.published = true;
      state.publishes.push(...ids);
      return noContent();
    }
    return null;
  }

  function remove(where) {
    // The SDK removes what a failed create wrote: the appmodule by id (and a sitemap it had written, by id).
    const m = new RegExp(`^/(appmodules|sitemaps)\\((${GUID})\\)`).exec(where);
    if (!m) return null;
    const list = m[1] === 'appmodules' ? state.apps : state.sitemaps;
    const key = m[1] === 'appmodules' ? 'appmoduleid' : 'sitemapid';
    const at = list.findIndex((row) => lc(row[key]) === lc(m[2]));
    if (at !== -1) list.splice(at, 1);
    return noContent();
  }

  // A `$batch` change set. The SDK sends one to take an app and its sitemap away together (a failed create's rollback, a delete): every operation
  // is a DELETE by id, and all of them are applied, or — one that the fake cannot apply — none, as a change set is.
  function batch({ operations }) {
    const removable = (op) => op.method === 'DELETE' && new RegExp(`^/(appmodules|sitemaps)\\(${GUID}\\)`).test(op.path);
    const refused = operations.find((op) => !removable(op));
    if (!operations.length || refused) {
      unexpected.push(`POST $batch (${refused ? `${refused.method} ${refused.path}` : 'no operations'})`);
      return json(400, { error: { code: '0x80060888', message: 'the fake org applies only change sets of deletes by id' } });
    }
    for (const op of operations) remove(op.path);
    return batchResponse(operations.map((op) => ({ contentId: op.contentId, status: 204 })));
  }

  async function request({ url, method, headers, body }) {
    const parsed = new URL(url);
    const where = decodeURIComponent(parsed.pathname + parsed.search).replace(API_ROOT, '');
    const type = Object.entries(headers || {}).find(([name]) => name.toLowerCase() === 'content-type');
    // A body that is not JSON (the multipart change set) is kept as the text it is: parsing it would throw before the request was recorded.
    const isJson = !body || !type || /json/i.test(type[1]);
    const recorded = { method, path: where, body: body ? (isJson ? JSON.parse(body) : body) : undefined, headers };
    if (body && !isJson && method === 'POST' && /^\/\$batch$/.test(where)) recorded.operations = parseBatch(String(body));
    requests.push(recorded);
    const early = options.answer && options.answer(recorded);
    if (early) return early;
    if (PAGE_PATH.test(where)) return pageRequest({ method, headers, body: isJson ? body : undefined }, where);
    const answered = method === 'GET' ? get(where) : method === 'POST' ? (recorded.operations ? batch(recorded) : post(where, recorded.body || {})) : method === 'DELETE' ? remove(where) : null;
    if (answered) return answered;
    unexpected.push(`${method} ${where}`);
    return json(404, { error: { code: '0x80060888', message: `the fake org does not answer ${method} ${where}` } });
  }

  // `METHOD resource` per write, so a test reads like the sequence it pins: "POST appmodules", "POST AddSolutionComponent". A key in
  // parentheses and the query are dropped; what follows the key stays ("POST appmodules/appmoduleroles_association/$ref").
  const writeName = (req) => `${req.method} ${req.path.replace(/^\//, '').replace(/\([^)]*\)/g, '').replace(/\?.*$/, '')}`;

  return {
    origin,
    state,
    requests,
    unexpected,
    request,
    // The requests that changed something (everything but a read): what a refusal must leave empty.
    writes: () => requests.filter((req) => req.method !== 'GET'),
    writeNames: () => requests.filter((req) => req.method !== 'GET').map(writeName),
  };
}

module.exports = { createFakeAppsOrg, json, batchResponse, parseBatch };
