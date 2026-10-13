'use strict';

const APP = '11111111-0000-4000-8000-000000000001';
const PUBLISHED = '11111111-0000-4000-8000-000000000002';
const CURRENT = '11111111-0000-4000-8000-000000000003';
const SITEMAP = '11111111-0000-4000-8000-000000000004';
const ICON = '11111111-0000-4000-8000-000000000005';
const PAGE = '11111111-0000-4000-8000-000000000006';
const FORM_A = '33333333-0000-4000-8000-000000000001';
const FORM_B = '33333333-0000-4000-8000-000000000002';
const DASHBOARD = '33333333-0000-4000-8000-000000000003';
const META = { contoso_item: '22222222-0000-4000-8000-000000000001', task: '22222222-0000-4000-8000-000000000002', email: '22222222-0000-4000-8000-000000000003' };
const clone = (value) => JSON.parse(JSON.stringify(value));

function membershipSpec({ hidden = true, mainForms = true, page = false, aiDescription } = {}) {
  return {
    solution: { uniqueName: 'ContosoMembership', publisherPrefix: 'contoso' },
    app: {
      name: 'Membership', ...(hidden ? { tables: ['task'] } : {}),
      ...(mainForms ? { mainForms: { CONTOSO_ITEM: ['Summary'] } } : {}),
      ...(aiDescription ? { aiDescription } : {}),
    },
    entities: [{
      schemaName: 'contoso_item', displayName: 'Item', existing: true,
      primaryAttribute: { schemaName: 'contoso_name', displayName: 'Name' }, columns: [],
    }],
    forms: [], views: [], charts: [],
    ...(page ? { schemaVersion: 2, pages: [{ key: 'overview', name: 'Overview', source: { kind: 'intent' } }] } : {}),
    appShell: { areas: [{ label: 'Main', groups: [{ label: 'Records', subAreas: [
      { entity: 'contoso_item', title: 'Items' }, ...(page ? [{ page: 'overview', title: 'Overview' }] : []),
    ] }] }] },
  };
}

function membershipSdk({ existing = false, page = false, forms, warnings = [], malformedTable = false, dropPin = false } = {}) {
  const events = [];
  const pushes = [];
  let exists = existing;
  let currentUnique = PUBLISHED;
  let publishedUnique = PUBLISHED;
  let pending = false;
  const tableIds = new Set([META.contoso_item]);
  let publishedTableIds = new Set(tableIds);
  const catalogs = forms || [
    { formid: FORM_A, name: 'Summary', type: 2, objecttypecode: 'contoso_item', formactivationstate: 1 },
    { formid: FORM_B, name: 'Alternate', type: 2, objecttypecode: 'contoso_item', formactivationstate: 1 },
    { formid: DASHBOARD, name: 'Overview', type: 0, objecttypecode: 'none', formactivationstate: 1 },
  ];
  let art = {
    id: APP, name: 'Membership', uniqueName: 'contoso_membership', description: '', aiDescription: 'Old routing',
    siteMap: { areas: [{ id: 'area_live', title: 'Main', groups: [{ id: 'group_live', title: 'Records', subAreas: [
      { id: 'sub_items', type: 'Entity', entity: 'contoso_item', title: 'Items' },
      ...(page ? [{ id: 'sub_page', type: 'GenPage', genPageId: PAGE, title: 'Overview' }] : []),
    ] }] }] },
  };
  const xml = () => '<SiteMap><Area Id="area_live"><Group Id="group_live"><SubArea Id="sub_items" Entity="contoso_item" Title="Items"/>'
    + (page ? `<SubArea Id="sub_page" GenPageId="${PAGE}" Title="Overview"/>` : '') + '</Group></Area></SiteMap>';
  const response = (value) => ({ status: 200, body: { value } });
  const publish = () => {
    publishedUnique = currentUnique;
    publishedTableIds = new Set(tableIds);
    pending = false;
  };
  const sdk = {
    dataverse: {
      get: async (url) => {
        events.push(['get', url]);
        const logical = /EntityDefinitions\(LogicalName='([^']+)'\)/.exec(url);
        if (logical) {
          if (malformedTable && logical[1] === 'task') return { status: 404, body: null };
          return { status: 200, body: { MetadataId: META[logical[1]], EntitySetName: `${logical[1]}s` } };
        }
        if (url.startsWith('/appmodules/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple')) {
          assertExists();
          return response([{ appmoduleid: APP, appmoduleidunique: currentUnique, componentstate: pending ? 1 : 0 }]);
        }
        if (url.startsWith('/appmodulecomponents')) {
          const ids = url.includes(PUBLISHED) && publishedUnique !== currentUnique ? publishedTableIds : tableIds;
          return response([...ids].map((objectid) => ({ objectid, componenttype: 1 })));
        }
        if (url.startsWith('/systemforms')) {
          const table = /objecttypecode eq '([^']+)'/.exec(url);
          return response(table ? catalogs.filter((row) => row.type === 2 && row.objecttypecode === table[1])
            : catalogs.filter((row) => url.includes(`formid eq ${row.formid}`)));
        }
        throw new Error(`unexpected test read: ${url}`);
      },
      post: async (url, body) => {
        events.push(['post', url, clone(body)]);
        assertExists();
        if (url === '/AddAppComponents') {
          if (!dropPin) for (const component of body.Components) {
            const id = /\(([^)]+)\)/.exec(component['@odata.id']);
            if (id) tableIds.add(id[1]);
          }
          currentUnique = CURRENT;
          pending = true;
        } else if (url === '/PublishXml') publish();
        else throw new Error(`unexpected test action: ${url}`);
        return { status: 204, body: null };
      },
    },
    findArtifact: async (kind) => kind === 'app' && exists ? APP : null,
    listArtifacts: async () => [{ id: APP, isDirty: false }],
    fetchArtifact: async (kind) => {
      events.push(['fetch', kind]);
      return clone(art);
    },
    getArtifact: async () => clone(art),
    createArtifact: async (kind, definition) => {
      events.push(['create', kind]);
      art = { id: APP, ...clone(definition) };
      return clone(art);
    },
    addElement: async (_kind, _id, pointer, value) => {
      if (pointer !== '') throw new Error(`unexpected test add pointer: ${pointer}`);
      Object.assign(art, clone(value));
      return clone(art);
    },
    updateElement: async (_kind, _id, pointer, value) => {
      art[pointer.slice(1)] = clone(value);
      return clone(art);
    },
    pushArtifact: async (kind, id) => {
      events.push(['push', kind]);
      const wasNew = !exists;
      exists = true;
      pushes.push(clone(art));
      if (wasNew) publish();
      return { type: kind, id, saved: true, warnings: [...warnings], publish: { kind: wasNew ? 'verified' : 'notRequested' } };
    },
    publishArtifact: async (kind, id) => {
      events.push(['publish', kind]);
      publish();
      return { type: kind, id, shipped: true, publish: { kind: 'verified' } };
    },
    addSolutionComponent: async () => undefined,
    queryRecords: async (set, opts = {}) => {
      if (set === 'webresource') return /_icon/.test(opts.filter || '') ? [{ webresourceid: ICON }] : [];
      if (set === 'appmodule') return exists ? [{ appmoduleid: APP, appmoduleidunique: publishedUnique, uniquename: 'contoso_membership' }] : [];
      if (set === 'appmodulecomponent') return [{ objectid: SITEMAP, componenttype: 62 }];
      if (set === 'sitemap') return [{ sitemapid: SITEMAP, sitemapxml: xml() }];
      return [];
    },
  };
  function assertExists() { if (!exists) throw new Error('app components accessed before the app exists'); }
  return { sdk, events, pushes, get pending() { return pending; }, get tableIds() { return [...tableIds]; } };
}

// Legacy download fixtures exposed their saved snapshot through queryRecords. Serve that SAME
// fixture through the current app/sitemap projections too, without changing artifact assertions.
function currentReadSdk(sdk, { appId, layerId, sitemapXml }) {
  return {
    ...sdk,
    dataverse: {
      ...sdk.dataverse,
      get: async (url) => {
        if (url.startsWith('/appmodules/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()')) {
          return { status: 200, body: { value: [{ appmoduleid: appId, appmoduleidunique: layerId, componentstate: 0 }] } };
        }
        if (url.startsWith('/sitemaps/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()')) {
          if (typeof sitemapXml !== 'string') throw new Error('fixture has no current sitemap XML');
          return { status: 200, body: { value: [{ sitemapxml: sitemapXml, componentstate: 0 }] } };
        }
        if (!sdk.dataverse || typeof sdk.dataverse.get !== 'function') throw new Error(`unexpected fixture metadata read: ${url}`);
        return await sdk.dataverse.get(url);
      },
    },
  };
}

module.exports = { membershipSpec, membershipSdk, currentReadSdk, APP, PUBLISHED, CURRENT, FORM_A, FORM_B, DASHBOARD, META, PAGE, ICON };
