// Thin Web-API record helpers used by the model-app builder. `dv` is a function
// (method, apiPath, body, opts) -> { status, data, headers } (a thin wrapper over
// dataverseRequest bound to the target env). The exact shapes here were validated
// live on a test env (model-app-maker-plan Task 9).

function extractId(res) {
  const h = (res && res.headers) || {};
  const loc = h['odata-entityid'] || h['OData-EntityId'] || '';
  const m = String(loc).match(/\(([^)]+)\)/);
  return m ? m[1] : null;
}

// Find the main form (type=2) for an entity by its logical name (objecttypecode).
async function findMainForm(dv, entityLogical) {
  const q = `systemforms?$select=formid,name,type&$filter=objecttypecode eq '${entityLogical}' and type eq 2`;
  const r = await dv('GET', q);
  const forms = (r.data && r.data.value) || [];
  return forms[0] || null;
}

async function patchFormXml(dv, formId, formxml) {
  return dv('PATCH', `systemforms(${formId})`, { formxml });
}

async function createSavedQuery(dv, { name, entityLogical, fetchxml, layoutxml }) {
  return dv(
    'POST',
    'savedqueries',
    { name, returnedtypecode: entityLogical, fetchxml, layoutxml, querytype: 0, isdefault: false },
    { includeHeaders: true }
  );
}

// Publish the given entities so their new attributes resolve when forms/views are
// saved (an unpublished column is silently stripped from a form on save).
async function publishEntities(dv, entityLogicalNames) {
  const entities = (entityLogicalNames || []).map((n) => `<entity>${n}</entity>`).join('');
  const ParameterXml = `<importexportxml><entities>${entities}</entities></importexportxml>`;
  return dv('POST', 'PublishXml', { ParameterXml });
}

// Resolve any PNG web resource to satisfy appmodule.webresourceid (a required FK).
async function resolveAppIcon(dv) {
  const r = await dv('GET', 'webresourceset?$select=webresourceid&$filter=webresourcetype eq 5&$top=1');
  const w = ((r.data && r.data.value) || [])[0];
  return w && w.webresourceid;
}

async function createAppModule(dv, { name, uniqueName, description, webresourceid }) {
  const body = { name, uniquename: uniqueName, description: description || '', formfactor: 1, clienttype: 4 };
  if (webresourceid) {
    body.webresourceid = webresourceid; // primitive Guid, NOT an @odata.bind
  }
  return dv('POST', 'appmodules', body, { includeHeaders: true });
}

async function createSitemap(dv, { sitemapname, sitemapnameunique, sitemapxml }) {
  return dv('POST', 'sitemaps', { sitemapname, sitemapnameunique, sitemapxml }, { includeHeaders: true });
}

// Attach components to the app via the UNBOUND AddAppComponents action. The entity
// is implied by its form/view, so components = sitemap + forms + views (no entity).
async function addAppComponents(dv, appId, components) {
  return dv('POST', 'AddAppComponents', { AppId: appId, Components: components });
}

async function publishAll(dv) {
  return dv('POST', 'PublishAllXml', {});
}

module.exports = {
  extractId,
  findMainForm,
  patchFormXml,
  createSavedQuery,
  publishEntities,
  resolveAppIcon,
  createAppModule,
  createSitemap,
  addAppComponents,
  publishAll,
};
