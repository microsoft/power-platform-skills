'use strict';
// Reconstruct a COMPLETE app-spec from a DEPLOYED app (the edit flow's "pull everything" step). Pure
// + testable: `read` supplies the deployed state — the app (sitemap JSON, via the SDK's app read
// path which surfaces entity/genPage/icon subareas), its generative pages (via pac list+download),
// its entities (mapped from metadata), and its solution. hydrateSpec composes these into a spec that
// round-trips through build() with no changes, so create == edit and nothing (incl. Maker-made
// pages) is dropped.

// Map a sitemap SubAreaJson (from the SDK app read path) back to an app-spec subarea. GenPage
// subareas resolve to a `page` target by name (from the downloaded pages); DashBoard/CustomPage are
// not round-tripped (rare legacy) and are omitted.
function subAreaToSpec(sa, pageNameById) {
  const base = { title: sa.title };
  if (sa.icon) base.icon = sa.icon;
  if (sa.vectorIcon) base.vectorIcon = sa.vectorIcon;
  if (sa.type === 'Entity' && sa.entity) return { ...base, entity: sa.entity };
  if (sa.type === 'GenPage' && sa.genPageId) return { ...base, page: pageNameById.get(String(sa.genPageId).toLowerCase()) || sa.genPageId };
  if (sa.type === 'URL' && sa.url) return { ...base, url: sa.url };
  return null; // DashBoard / CustomPage / unmapped — not hydrated
}

async function hydrateSpec(read) {
  const app = (await read.app()) || { name: '', description: '', siteMap: { areas: [] } };
  const pages = (await read.pages()) || [];
  const entities = (await read.entities()) || [];
  const webResources = (await read.webResources()) || [];
  const solution = (await read.solution()) || { uniqueName: 'Default', publisherPrefix: 'new' };
  const pageNameById = new Map(pages.filter((p) => p.pageId && p.name).map((p) => [String(p.pageId).toLowerCase(), p.name]));

  const appShell = {
    areas: (app.siteMap.areas || []).map((a) => ({
      label: a.title,
      ...(a.icon ? { icon: a.icon } : {}),
      ...(a.vectorIcon ? { vectorIcon: a.vectorIcon } : {}),
      groups: (a.groups || []).map((g) => ({
        label: g.title,
        subAreas: (g.subAreas || []).map((sa) => subAreaToSpec(sa, pageNameById)).filter(Boolean),
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
    dashboards: [],
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
