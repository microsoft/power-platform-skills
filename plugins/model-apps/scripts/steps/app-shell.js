const recs = require('../lib/dataverse-records.js');

// --- 5. App shell: kernel buildSitemap -> appmodule + sitemap + AddAppComponents -> publish (opt-in).
async function appShell(spec, opts, deps, result) {
  deps.step(`app shell (sitemap + app module "${spec.app.name}")`);
  const sm = deps.kernel({
    kind: 'buildSitemap',
    spec: {
      areas: (spec.appShell.areas || []).map((a) => ({
        title: a.label,
        groups: (a.groups || []).map((g) => ({
          title: g.label,
          subAreas: (g.subAreas || []).map((s) => ({ entity: s.entity && s.entity.toLowerCase(), title: s.title })),
        })),
      })),
    },
  });
  if (!sm.ok) {
    throw new Error(`kernel buildSitemap failed: ${sm.error && sm.error.message}`);
  }

  const uniqueName = (spec.solution.publisherPrefix + '_' + spec.app.name).replace(/[^a-z0-9_]/gi, '').toLowerCase();
  const webresourceid = await recs.resolveAppIcon(deps.dv); // appmodule.webresourceid is required
  const appRes = await recs.createAppModule(deps.dv, {
    name: spec.app.name,
    uniqueName,
    description: spec.app.description,
    webresourceid,
  });
  const appId = recs.extractId(appRes);
  const smRes = await recs.createSitemap(deps.dv, {
    sitemapname: spec.app.name,
    sitemapnameunique: uniqueName,
    sitemapxml: sm.sitemapxml,
  });
  const smId = recs.extractId(smRes);
  result.created.app = { appModuleId: appId, sitemapId: smId };

  // Components = sitemap + forms + views (the entity is implied by its form/view).
  const components = [];
  if (smId) {
    components.push({ '@odata.type': 'Microsoft.Dynamics.CRM.sitemap', sitemapid: smId });
  }
  for (const formId of Object.values(result.created.forms || {})) {
    components.push({ '@odata.type': 'Microsoft.Dynamics.CRM.systemform', formid: formId });
  }
  for (const viewId of Object.values(result.created.views || {})) {
    if (viewId) {
      components.push({ '@odata.type': 'Microsoft.Dynamics.CRM.savedquery', savedqueryid: viewId });
    }
  }
  for (const chartId of Object.values(result.created.charts || {})) {
    if (chartId) {
      components.push({ '@odata.type': 'Microsoft.Dynamics.CRM.savedqueryvisualization', savedqueryvisualizationid: chartId });
    }
  }
  if (appId) {
    await recs.addAppComponents(deps.dv, appId, components);
    deps.runScript('add-to-solution.js', [opts.env, spec.solution.uniqueName, appId, '80']); // 80 = appmodule
  }

  if (opts.publish) {
    deps.step('publish customizations (this can take 1-2 min)');
    await recs.publishAll(deps.dv);
  } else {
    deps.log('skipped publish (pass --publish to publish)');
  }
}

module.exports = { appShell };
