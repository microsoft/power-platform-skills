'use strict';
// Reconstruct a COMPLETE app-spec from a DEPLOYED app (the edit flow's "pull everything" step). Pure
// + testable: `read` supplies the deployed state — the app (sitemap JSON, via the SDK's app read
// path which surfaces entity/genPage/icon subareas), its generative pages (via pac list+download),
// its entities (mapped from metadata), and its solution. hydrateSpec composes these into a spec that
// round-trips through build() with no changes, so create == edit and nothing (incl. Maker-made
// pages) is dropped.

// Map a sitemap SubAreaJson (from the SDK app read path) back to an app-spec subarea. GenPage
// subareas resolve to a `page` target by name (from the downloaded pages); DashBoard subareas resolve
// to a `dashboard` target by name (from the reconstructed dashboards); CustomPage/unmapped are omitted.
function subAreaToSpec(sa, pageNameById, dashboardNameById) {
  const base = { title: sa.title };
  if (sa.icon) base.icon = sa.icon;
  if (sa.vectorIcon) base.vectorIcon = sa.vectorIcon;
  if (sa.type === 'Entity' && sa.entity) return { ...base, entity: sa.entity };
  if (sa.type === 'GenPage' && sa.genPageId) return { ...base, page: pageNameById.get(String(sa.genPageId).toLowerCase()) || sa.genPageId };
  if (sa.type === 'DashBoard' && sa.dashboardId) {
    const name = dashboardNameById && dashboardNameById.get(String(sa.dashboardId).toLowerCase());
    return name ? { ...base, dashboard: name } : null; // drop only if we couldn't reconstruct the dashboard
  }
  if (sa.type === 'URL' && sa.url) return { ...base, url: sa.url };
  return null; // CustomPage / unmapped — not hydrated
}

async function hydrateSpec(read) {
  const app = (await read.app()) || { name: '', description: '', siteMap: { areas: [] } };
  const pages = (await read.pages()) || [];
  const entities = (await read.entities()) || [];
  const webResources = (await read.webResources()) || [];
  const dashboards = (read.dashboards ? await read.dashboards() : []) || [];
  const solution = (await read.solution()) || { uniqueName: 'Default', publisherPrefix: 'new' };
  const pageNameById = new Map(pages.filter((p) => p.pageId && p.name).map((p) => [String(p.pageId).toLowerCase(), p.name]));
  const dashboardNameById = new Map(dashboards.filter((d) => d.id && d.name).map((d) => [String(d.id).toLowerCase(), d.name]));

  const appShell = {
    areas: (app.siteMap.areas || []).map((a) => ({
      label: a.title,
      ...(a.icon ? { icon: a.icon } : {}),
      ...(a.vectorIcon ? { vectorIcon: a.vectorIcon } : {}),
      groups: (a.groups || []).map((g) => ({
        label: g.title,
        subAreas: (g.subAreas || []).map((sa) => subAreaToSpec(sa, pageNameById, dashboardNameById)).filter(Boolean),
      })),
    })),
  };

  return {
    solution,
    app: { name: app.name, description: app.description || '' },
    entities,
    webResources,
    views: [],
    charts: [],
    forms: [],
    commands: [],
    // Dashboards are reconstructed with id-passthrough tiles (each tile carries the deployed
    // view/chart ids), so a rebuild recreates the dashboard against the EXISTING views/charts
    // without needing views[]/charts[] declared (which would else duplicate them or fail validation).
    dashboards: dashboards.map((d) => ({ name: d.name, tiles: d.tiles })),
    pages: pages.map((p) => ({
      name: p.name,
      ...(p.dataSources && p.dataSources.length ? { dataSources: p.dataSources } : {}),
      ...(p.prompt ? { prompt: p.prompt } : {}),
      codeFile: p.codeFile,
    })),
    appShell,
  };
}

module.exports = { hydrateSpec, subAreaToSpec };
