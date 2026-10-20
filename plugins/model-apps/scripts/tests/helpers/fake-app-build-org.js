'use strict';
// A Dataverse the whole build can run against, the app step included: the stateful fake of views, forms and charts (fake-dataverse.js)
// plus an in-memory app module, sitemap and app components, answered the way the platform answers them. It is the transport of the
// REAL vendored SDK (`createMakerSdk({ httpClient })`), so a test sees exactly what reached the wire and what the platform is left holding:
//
//   const org = createFakeBuildOrg({ entities: { contoso_item: { attributes: { contoso_name: 'String' } } } });
//   const sdk = createMakerSdk({ workspaceStorage, instanceUrl: org.origin, httpClient: org.httpClient });
//
//   org.calls                 every request, in order, as { method, path, body } with the path below the API root, decoded
//   org.fake                  the fake of views, forms and charts: `fake.unpublished()` is what is saved and not live
//   org.components            what the app holds: [{ objectid, componenttype }] (1 table, 26 view, 59 chart, 60 form, 62 sitemap)
//   org.tablePublishes(since) the PublishXml requests that name tables, as arrays of table names, in order
//   org.appPublishes(since)   the PublishXml requests that name the app
//   org.refuseNextTablePublish(status)   answers the next PublishXml that names tables with that status
//   org.addToApp(kind, id)    a maker adds a view, form or chart to the app in the designer
//   org.intercept(match, answer)   answers the requests `match({ method, path, body })` accepts with `answer(request)` instead of the
//                             fake's own answer, until the returned function is called: a refused read, or an answer that leaves a row out
//   org.pages                 Map<page id, row>: the generative pages the environment lists (`uxagentprojects`), which the pages phase reads. A page
//                             backend a test builds with records the page it creates here; the service that holds the page's files is a fake of its own
//   org.resources             Map<id, row>: the web resources a build creates (the page manifest), read back by name
//
// An app is a draft until a PublishXml names it. The generated app icon and the roles exist already, as in an environment that has built
// an app before. A plain read of a view, form or chart by id answers the published layer only, as the platform's does: a record that was never published
// has no row in it, and only the saved layer (RetrieveUnpublishedMultiple, which the fake of views, forms and charts answers) has it. A test about a
// record the app holds that no read answers can answer that read itself (`intercept`).
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createFakeDataverse } = require('./fake-dataverse.js');

const ORIGIN = 'https://contoso.crm.dynamics.com';
const LAYER_ID = '11111111-0000-4000-8000-000000000002';
const ICON_ID = '11111111-0000-4000-8000-000000000003';
const ROLE_ID = '11111111-0000-4000-8000-000000000004';
const GUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const COMPONENT_TYPE = { savedqueries: 26, savedqueryvisualizations: 59, systemforms: 60 };
const ID_FIELD = { savedqueries: 'savedqueryid', savedqueryvisualizations: 'savedqueryvisualizationid', systemforms: 'formid' };

const entitiesOf = (body) => [...String(body.ParameterXml).matchAll(/<entity>([^<]+)<\/entity>/g)].map((m) => m[1]);
const namesApp = (body) => /<appmodule>/.test(String(body.ParameterXml));

function createFakeBuildOrg({ entities, solution = { uniqueName: 'ContosoReview' }, heldTables = {}, publishBumpsVersion = true } = {}) {
  const fake = createFakeDataverse({ entities, solution, publishBumpsVersion, heldTables });
  const calls = [];
  const components = [];
  let app;
  let sitemap;
  let appVersion = 1;
  let sitemapVersion = 1;
  let refusal = null;
  const overrides = [];
  const pages = new Map();
  const resources = new Map();
  const headers = (version) => ({ etag: `W/"${version}"` });
  const response = (body, version = 1) => ({ status: 200, headers: headers(version), body });
  const rows = (value) => response({ value });
  const collection = (p) => p.includes('RetrieveUnpublishedMultiple') || !/\(/.test(p.split('?')[0]);

  async function request(method, url, body, options) {
    const parsed = new URL(url);
    assert.equal(parsed.origin, ORIGIN);
    const p = decodeURIComponent(parsed.pathname + parsed.search).replace(/^\/api\/data\/v9\.\d/, '');
    const recorded = { method, path: p, ...(body === undefined ? {} : { body }) };
    calls.push(recorded);
    const overridden = overrides.find((o) => o.match(recorded));
    if (overridden) return overridden.answer(recorded);
    if (method === 'POST' && p === '/PublishXml') {
      if (refusal && /<entities>/.test(body.ParameterXml)) {
        const status = refusal;
        refusal = null;
        return { status, headers: {}, body: { error: { message: 'injected table-publish refusal' } } };
      }
      if (app && body.ParameterXml.includes(`<appmodule>${app.appmoduleid}</appmodule>`)) {
        app.componentstate = 0;
        appVersion += 1;
      }
      for (const [, id] of String(body.ParameterXml).matchAll(/<webresource>([^<]+)<\/webresource>/g)) {
        const row = resources.get(id.toLowerCase());
        if (row) row.publishedContent = row.content;
      }
      return fake.httpClient.post(url, body, options);
    }
    if (method === 'GET' && /^\/appmodulecomponents/.test(p)) {
      const type = Number((/componenttype eq (\d+)/.exec(p) || [])[1] || 0);
      return rows(components.filter((c) => !type || c.componenttype === type));
    }
    if (method === 'GET' && /^\/appmodules/.test(p)) {
      if (!app) return collection(p) ? rows([]) : { status: 404, body: null };
      const data = { ...app, appmoduleidunique: LAYER_ID, '@odata.etag': `W/"${appVersion}"` };
      return collection(p) ? rows([data]) : response(data, appVersion);
    }
    if (method === 'GET' && /^\/sitemaps/.test(p)) {
      if (!sitemap) return collection(p) ? rows([]) : { status: 404, body: null };
      const data = { ...sitemap, '@odata.etag': `W/"${sitemapVersion}"` };
      return collection(p) ? rows([data]) : response(data, sitemapVersion);
    }
    // The page manifest is a web resource the build creates and reads back by name; a generated icon exists already.
    //   POST  /webresourceset                       { name, content, … }  ->  204, OData-EntityId: <API>/webresourceset(<id>)
    //   PATCH /webresourceset(<id>)                 { content }           ->  204
    //   GET   /webresourceset?$select=webresourceid,content&$filter=name eq '<name>'&$top=1
    //   GET   /webresourceset(<id>)?$select=content                        (the SDK's read-back of what it published)
    // A web resource has two layers, as the platform holds it: a POST or PATCH writes the SAVED content (`content`), a PublishXml that
    // names the row (`<webresources><webresource><id></webresource></webresources>`) copies it to the PUBLISHED layer (`publishedContent`),
    // and every plain read — by name or by id — answers the published content. A row no publish has named is in no plain read, as for the
    // views, forms and charts above (assumed: the plain read of a never-published web resource is not measured; the SDK's create publishes).
    let m;
    const publishedRow = ({ publishedContent, ...row }) => ({ ...row, content: publishedContent });
    if (method === 'POST' && /^\/webresourceset(\?|$)/.test(p)) {
      // A name is unique in an environment: a second create of one is refused, whatever layer the first is in (the SDK says so of its own create; the
      // platform's exact code for it is not measured).
      if ([...resources.values()].some((row) => String(row.name).toLowerCase() === String(body.name).toLowerCase())) {
        return { status: 400, headers: {}, body: { error: { code: '0x80040237', message: `A web resource named ${body.name} already exists.` } } };
      }
      const id = (body.webresourceid || randomUUID()).toLowerCase();
      resources.set(id, { ...body, webresourceid: id });
      return { status: 204, headers: { 'odata-entityid': `${ORIGIN}/api/data/v9.0/webresourceset(${id})` }, body: null };
    }
    if (method === 'PATCH' && (m = /^\/webresourceset\(([0-9a-f-]{36})\)/i.exec(p))) {
      // A write by an id no row has any more is refused as the platform refuses it.
      if (!resources.has(m[1].toLowerCase())) return { status: 404, headers: {}, body: { error: { code: '0x80040217', message: `webresource With Id = ${m[1]} Does Not Exist` } } };
      Object.assign(resources.get(m[1].toLowerCase()), body);
      return { status: 204, headers: {}, body: null };
    }
    if (method === 'GET' && (m = /^\/webresourceset\(([0-9a-f-]{36})\)\?\$select=content$/i.exec(p))) {
      const row = resources.get(m[1].toLowerCase());
      return row && row.publishedContent !== undefined ? response({ webresourceid: row.webresourceid, content: row.publishedContent }) : { status: 404, headers: {}, body: { error: { message: 'Does Not Exist' } } };
    }
    if (method === 'GET' && (m = /^\/webresourceset\(([0-9a-f-]{36})\)\?\$select=name,displayname,webresourcetype,content,description$/i.exec(p))) {
      const row = resources.get(m[1].toLowerCase());
      return row && row.publishedContent !== undefined ? response(publishedRow(row)) : { status: 404, headers: {}, body: { error: { message: 'Does Not Exist' } } };
    }
    if (method === 'GET' && /^\/webresources(et)?\?/.test(p)) {
      const named = /name eq '([^']+)'/.exec(p);
      const stored = named ? [...resources.values()].filter((row) => row.name === named[1] && row.publishedContent !== undefined).map(publishedRow) : [];
      return rows(stored.length ? stored : p.includes('_icon') ? [{ webresourceid: ICON_ID }] : []);
    }
    // The environment's generative pages, plain or in the saved layer: every page of the list, whatever the filter asks (a test that needs a narrower answer intercepts).
    if (method === 'GET' && /^\/uxagentprojects(\?|\/)/.test(p)) return rows([...pages.values()]);
    if (method === 'GET' && /^\/roles/.test(p)) return rows([{ roleid: ROLE_ID, _parentrootroleid_value: ROLE_ID }]);
    // A table component's objectid is the table's MetadataId; the inventory of what an app holds resolves it back:
    //   GET /EntityDefinitions(<MetadataId>)?$select=LogicalName,IsCustomEntity  ->  { "LogicalName": "contoso_item", "IsCustomEntity": true }
    if (method === 'GET' && (m = new RegExp(`^/EntityDefinitions\\((${GUID})\\)`, 'i').exec(p))) {
      const logical = Object.keys(entities || {}).find((name) => fake.entityId(name).toLowerCase() === m[1].toLowerCase());
      return logical ? response({ LogicalName: logical, IsCustomEntity: true }) : { status: 404, body: null };
    }
    // The table of a view, form or chart component, asked by id with a PLAIN read: `$filter=savedqueryid eq <id> or savedqueryid eq <id>`. The platform answers
    // the published layer only, so a record that was never published (a form a maker added to the app in the designer and did not publish) has no row in it;
    // the saved layer, which RetrieveUnpublishedMultiple answers, has.
    if (method === 'GET' && (m = /^\/(savedqueries|systemforms|savedqueryvisualizations)\?/.exec(p)) && /\$filter=[a-z]+id eq [0-9a-f-]{36}( or [a-z]+id eq [0-9a-f-]{36})*$/i.test(p)) {
      const wanted = [...p.matchAll(new RegExp(`${ID_FIELD[m[1]]} eq (${GUID})`, 'gi'))].map((x) => x[1].toLowerCase());
      return rows(fake.rows(m[1]).filter((row) => row.publishedVersion !== null).map((row) => row.data).filter((data) => wanted.includes(String(data[ID_FIELD[m[1]]]).toLowerCase())));
    }
    if (method === 'POST' && /^\/appmodules(\?|$)/.test(p)) {
      app = { ...body, componentstate: 1 };
      return { status: 204, headers: { 'odata-entityid': `${ORIGIN}/api/data/v9.0/appmodules(${app.appmoduleid})` }, body: null };
    }
    if (method === 'POST' && /^\/sitemaps(\?|$)/.test(p)) {
      sitemap = { ...body };
      components.push({ objectid: body.sitemapid, componenttype: 62 });
      return response({ sitemapid: sitemap.sitemapid, '@odata.etag': `W/"${sitemapVersion}"` }, sitemapVersion);
    }
    if (method === 'POST' && p === '/AddAppComponents') {
      for (const c of body.Components) {
        const ref = /^([^()]+)\(([^)]+)\)$/.exec(c['@odata.id'] || '');
        const typed = {
          'Microsoft.Dynamics.CRM.sitemap': ['sitemapid', 62],
          'Microsoft.Dynamics.CRM.systemform': ['formid', 60],
          'Microsoft.Dynamics.CRM.savedquery': ['savedqueryid', 26],
          'Microsoft.Dynamics.CRM.savedqueryvisualization': ['savedqueryvisualizationid', 59],
        }[c['@odata.type']];
        if (!ref && !typed) throw new Error(`Unsupported component: ${JSON.stringify(c)}`);
        const componenttype = typed ? typed[1] : ({ systemforms: 60, savedqueries: 26, savedqueryvisualizations: 59 }[ref[1]] || 1);
        const objectid = typed ? c[typed[0]] : ref[2];
        if (!components.some((held) => held.objectid === objectid && held.componenttype === componenttype)) components.push({ objectid, componenttype });
      }
      return { status: 204, headers: {}, body: null };
    }
    if (method === 'POST' && /\/appmoduleroles_association\/\$ref/.test(p)) return { status: 204, headers: {}, body: null };
    if (method === 'PATCH' && /^\/sitemaps\(/.test(p)) {
      Object.assign(sitemap, body);
      sitemapVersion += 1;
      return { status: 204, headers: headers(sitemapVersion), body: null };
    }
    if (method === 'PATCH' && /^\/appmodules\(/.test(p)) {
      Object.assign(app, body, { componentstate: 1 });
      appVersion += 1;
      return { status: 204, headers: headers(appVersion), body: null };
    }
    return fake.httpClient[method.toLowerCase()](url, ...(method === 'GET' ? [options] : [body, options]));
  }

  const httpClient = Object.fromEntries(['get', 'post', 'patch', 'put', 'delete'].map((method) => [method,
    (url, ...args) => request(method.toUpperCase(), url, ...(method === 'get' ? [undefined, args[0]] : args)),
  ]));
  const publishes = (since, wantApp) => calls.slice(since).filter((c) => c.method === 'POST' && c.path === '/PublishXml' && namesApp(c.body) === wantApp);
  return {
    origin: ORIGIN,
    fake,
    calls,
    httpClient,
    components,
    pages,
    resources,
    appId: () => app && app.appmoduleid,
    tablePublishes: (since = 0) => publishes(since, false).map((c) => entitiesOf(c.body)),
    appPublishes: (since = 0) => publishes(since, true).map((c) => ({ tables: entitiesOf(c.body), apps: [...String(c.body.ParameterXml).matchAll(/<appmodule>([^<]+)<\/appmodule>/g)].map((x) => x[1]) })),
    // Every PublishXml, in the order it was sent: `tables a, b` or `app` or `tables a + app`.
    publishLog: (since = 0) => calls.slice(since).filter((c) => c.method === 'POST' && c.path === '/PublishXml')
      .map((c) => [entitiesOf(c.body).length ? `tables ${entitiesOf(c.body).join(', ')}` : '', namesApp(c.body) ? 'app' : ''].filter(Boolean).join(' + ')),
    refuseNextTablePublish: (status = 400) => { refusal = status; },
    intercept: (match, answer) => {
      const entry = { match, answer };
      overrides.push(entry);
      return () => { overrides.splice(overrides.indexOf(entry), 1); };
    },
    addToApp: (kind, id) => {
      assert.ok(COMPONENT_TYPE[kind], `a view, form or chart collection: ${kind}`);
      components.push({ objectid: id, componenttype: COMPONENT_TYPE[kind] });
    },
  };
}

module.exports = { createFakeBuildOrg };
