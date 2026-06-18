// Thin Web-API record helpers used by the model-app builder. `dv` is a function
// (method, apiPath, body, opts) -> { status, data, headers } (a thin wrapper over
// dataverseRequest bound to the target env).

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

async function createAppModule(dv, { name, uniqueName, description }) {
  return dv(
    'POST',
    'appmodules',
    { name, uniquename: uniqueName, description: description || '', formfactor: 1, clienttype: 4 },
    { includeHeaders: true }
  );
}

async function createSitemap(dv, { sitemapname, sitemapxml }) {
  return dv('POST', 'sitemaps', { sitemapname, sitemapxml }, { includeHeaders: true });
}

// Attach components (sitemap / entities / forms / views) to the app via the
// AddAppComponents bound action. `components` are OData entity references.
async function addAppComponents(dv, appModuleId, components) {
  return dv('POST', `appmodules(${appModuleId})/Microsoft.Dynamics.CRM.AddAppComponents`, { Components: components });
}

async function publishAll(dv) {
  return dv('POST', 'PublishAllXml', {});
}

module.exports = {
  extractId,
  findMainForm,
  patchFormXml,
  createSavedQuery,
  createAppModule,
  createSitemap,
  addAppComponents,
  publishAll,
};
