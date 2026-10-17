'use strict';
// The COMPONENT side of an app, laid over helpers/fake-genpage-server.js `appTransport`: tables its navigation opens, each with the Main forms, public views and
// charts the environment holds for it, and which of them the app's current layer HAS. `appTransport` alone models an app whose navigation holds generative pages
// only, so a push of it derives no component — and the real SDK's app push (the bundle's `appApi.update`) derives one for every Entity sub-area: the table, every
// active Main form, every active public view and every chart of it, posted as ONE AddAppComponents after the sitemap is written. A test of a page edit needs an
// app that has such a sub-area, with components the maker took out of it, to see what the edit does to them.
//
//   const app = appTransport(server);
//   const world = withAppComponents(app, { tables: [{
//     logicalName: 'account', entitySetName: 'accounts', metadataId, title: 'Accounts',
//     forms:  [{ id, inApp: true }, { id, inApp: false }],                  // the table's ACTIVE Main forms; `inApp` says the app's layer holds it
//     views:  [{ id, inApp: true, isDefault: true }, { id, inApp: false }], // its public views (statecode 0)
//     charts: [{ id, inApp: false }],
//   }] });
//   new GenPage backend over `world.http`
//   world.members                { tables, forms, views, charts }: Sets of the ids the app's current layer holds, kept up to date by AddAppComponents
//   world.additions()            the AddAppComponents bodies the app received, in order: [{ AppId, Components: [...] }]
//   world.added()                what they added, flattened: { tables, forms, views, charts } as sorted arrays of ids
// A request for ANOTHER app is not this app's: it is answered as for an app that does not exist, and changes nothing (`appId`, the app `appTransport` serves, is APP_ID unless given).
// The shapes are the raw Web API ones the SDK parses (see the reads in `get`).
const { APP_ID } = require('./fake-genpage-server.js');

const lower = (id) => String(id).replace(/[{}]/g, '').toLowerCase();

function withAppComponents(app, { tables, appId = APP_ID }) {
  const members = { tables: new Set(), forms: new Set(), views: app.state.views, charts: new Set() };
  const byName = new Map();
  for (const table of tables) {
    byName.set(table.logicalName, table);
    if (table.inApp !== false) members.tables.add(lower(table.metadataId));
    for (const form of table.forms || []) if (form.inApp) members.forms.add(lower(form.id));
    for (const view of table.views || []) if (view.inApp) members.views.add(lower(view.id));
    for (const chart of table.charts || []) if (chart.inApp) members.charts.add(lower(chart.id));
  }
  // The navigation opens each table: one Entity sub-area, in both layers (the app is published as it stands).
  const entries = tables.map((table) => `<SubArea Id="sub_${table.logicalName}" Entity="${table.logicalName}"><Titles><Title LCID="1033" Title="${table.title || table.logicalName}"/></Titles></SubArea>`).join('');
  app.state.xml = app.state.xml.replace('</Group>', `${entries}</Group>`);
  app.state.publishedXml = app.state.xml;

  const reply = (body) => ({ status: 200, headers: { ETag: `W/"${app.state.version}"` }, body });
  const tableOf = (filter) => byName.get((/(?:objecttypecode|returnedtypecode|primaryentitytypecode) eq '([^']+)'/.exec(filter) || [])[1]);

  const http = {
    ...app.http,
    get: async (url, options) => {
      const parsed = new URL(url);
      const route = parsed.pathname.replace(/^\/api\/data\/v[0-9.]+/, '');
      const filter = parsed.searchParams.get('$filter') || '';
      // The table's own reference, as the SDK resolves each table the navigation opens: GET /EntityDefinitions(LogicalName='account')?$select=MetadataId,EntitySetName
      const definition = /^\/EntityDefinitions\(LogicalName='([^']+)'\)$/.exec(route);
      if (definition && byName.has(definition[1]) && parsed.searchParams.get('$select') === 'MetadataId,EntitySetName') {
        const table = byName.get(definition[1]);
        return reply({ LogicalName: table.logicalName, MetadataId: table.metadataId, EntitySetName: table.entitySetName });
      }
      // What the environment holds for a table — the catalogs the SDK enumerates to expand a sub-area (the bundle's component builder): active Main forms, public views, charts.
      if (route === '/systemforms' && tableOf(filter) && /type eq 2/.test(filter)) {
        return reply({ value: tableOf(filter).forms.map((form) => ({ formid: form.id, type: 2, objecttypecode: tableOf(filter).logicalName, formactivationstate: 1 })) });
      }
      if (route === '/savedqueries' && tableOf(filter)) {
        const table = tableOf(filter);
        // The page backend asks for the table's DEFAULT public view (top 1); the SDK's expansion asks for every public view.
        const views = /isdefault eq true/.test(filter) ? table.views.filter((view) => view.isDefault) : table.views;
        return reply({ value: views.map((view) => ({ savedqueryid: view.id, isdefault: Boolean(view.isDefault), querytype: 0, returnedtypecode: table.logicalName })) });
      }
      if (route === '/savedqueryvisualizations' && tableOf(filter)) {
        return reply({ value: tableOf(filter).charts.map((chart) => ({ savedqueryvisualizationid: chart.id })) });
      }
      // The app's current layer, by component type: 1 table (a MetadataId), 59 chart, 60 form. (26, the views, and 62, the sitemap, are `appTransport`'s.)
      if (route === '/appmodulecomponents') {
        const type = /componenttype eq (1|59|60)(?:\s|$)/.exec(filter);
        if (type) {
          const held = { 1: members.tables, 59: members.charts, 60: members.forms }[type[1]];
          return reply({ value: [...held].map((objectid) => ({ objectid, componenttype: Number(type[1]) })) });
        }
      }
      return app.http.get(url, options);
    },
    post: async (url, body, options) => {
      // The service applies the action to the app it names and answers as for a row that does not exist for any other, so a request for ANOTHER app — which the limit lets through, it is not that edit's — does not change this one.
      if (url.endsWith('/AddAppComponents') && body && typeof body.AppId === 'string' && lower(body.AppId) !== lower(appId)) {
        return { status: 404, headers: {}, body: { error: { message: `appmodule With Id = ${body.AppId} Does Not Exist` } } };
      }
      const answered = await app.http.post(url, body, options);
      if (url.endsWith('/AddAppComponents') && answered.status < 300) {
        for (const component of body.Components || []) {
          if (component.formid) members.forms.add(lower(component.formid));
          if (component.savedqueryvisualizationid) members.charts.add(lower(component.savedqueryvisualizationid));
          // A table is added by reference: { "@odata.id": "accounts(88888888-…)" }
          const reference = /\(([0-9a-fA-F-]{36})\)$/.exec(component['@odata.id'] || '');
          if (reference) members.tables.add(lower(reference[1]));
        }
      }
      return answered;
    },
  };

  const additions = () => app.state.writes.filter((write) => write.kind === 'components').map((write) => write.body);
  const added = () => {
    const out = { tables: [], forms: [], views: [], charts: [] };
    for (const body of additions()) {
      for (const component of body.Components || []) {
        if (component.formid) out.forms.push(lower(component.formid));
        else if (component.savedqueryid) out.views.push(lower(component.savedqueryid));
        else if (component.savedqueryvisualizationid) out.charts.push(lower(component.savedqueryvisualizationid));
        else if (component['@odata.id']) out.tables.push(component['@odata.id']);
      }
    }
    for (const list of Object.values(out)) list.sort();
    return out;
  };
  return { http, members, additions, added };
}

module.exports = { withAppComponents };
