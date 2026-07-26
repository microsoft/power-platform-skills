'use strict';
// Reconstruct a COMPLETE app-spec from a DEPLOYED app (the edit flow's "pull everything" step). Pure
// + testable: `read` supplies the deployed state — the app (sitemap JSON, via the SDK's app read
// path which surfaces entity/genPage/icon subareas), its generative pages (via pac list+download),
// its entities (mapped from metadata), and its solution. hydrateSpec composes these into a spec that
// round-trips through build() with no changes, so create == edit and nothing (incl. Maker-made
// pages) is dropped.
//
// v2 shape (when downloaded pages carry stable keys from assignPageKeys): schemaVersion 2,
// pages have key/purpose/navigatesTo/pageInput/source:{kind:'tsx',codeFile}, appShell GenPage
// subareas resolve by KEY (not name), and design is threaded through. Legacy callers (no keys on
// pages) get the name-based shape (back-compat).

// Map a sitemap SubAreaJson (from the SDK app read path) back to an app-spec subarea. GenPage
// subareas resolve to a `page` target via `pageRefById` (id → key for v2, id → name for legacy);
// DashBoard subareas resolve to a `dashboard` target by name; CustomPage/unmapped are omitted.
function subAreaToSpec(sa, pageRefById, dashboardNameById) {
  const base = { title: sa.title };
  if (sa.icon) base.icon = sa.icon;
  if (sa.vectorIcon) base.vectorIcon = sa.vectorIcon;
  if (sa.type === 'Entity' && sa.entity) return { ...base, entity: sa.entity };
  if (sa.type === 'GenPage' && sa.genPageId) return { ...base, page: pageRefById.get(String(sa.genPageId).toLowerCase()) || sa.genPageId };
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
  // Views ARE hydrated (F3): the app's public author views round-trip so an edit can preserve/modify them.
  // Charts, forms, and commands are NOT yet hydrated (see below) — they need structured reads the SDK
  // doesn't expose; they survive on the live app, so a rebuild preserves them by discovery.
  const views = (read.views ? await read.views() : []) || [];
  const solution = (await read.solution()) || { uniqueName: 'Default', publisherPrefix: 'new' };
  // `design` is threaded through from the page manifest (§7.3) when present; undefined for legacy apps.
  const design = read.design ? await read.design() : undefined;
  // When downloaded pages carry stable keys (assigned by assignPageKeys), emit the v2 shape;
  // legacy callers without keys fall back to the name-based shape for back-compat.
  const hasKeys = pages.some((p) => p.key);
  // v2: GenPage subareas resolve by KEY (stable identity); legacy: by NAME.
  const pageKeyById = new Map(pages.filter((p) => p.pageId && p.key).map((p) => [String(p.pageId).toLowerCase(), p.key]));
  const pageNameById = new Map(pages.filter((p) => p.pageId && p.name).map((p) => [String(p.pageId).toLowerCase(), p.name]));
  const dashboardNameById = new Map(dashboards.filter((d) => d.id && d.name).map((d) => [String(d.id).toLowerCase(), d.name]));
  // Dispatch: v2 routes GenPage by key; legacy routes by name.
  const subMap = hasKeys ? pageKeyById : pageNameById;

  const appShell = {
    areas: (app.siteMap.areas || []).map((a) => ({
      label: a.title,
      ...(a.icon ? { icon: a.icon } : {}),
      ...(a.vectorIcon ? { vectorIcon: a.vectorIcon } : {}),
      groups: (a.groups || []).map((g) => ({
        label: g.title,
        subAreas: (g.subAreas || []).map((sa) => subAreaToSpec(sa, subMap, dashboardNameById)).filter(Boolean),
      })),
    })),
  };

  return {
    // schemaVersion 2 only when pages carry keys (v2 shape); omitted for legacy back-compat.
    ...(hasKeys ? { schemaVersion: 2 } : {}),
    solution,
    app: { name: app.name, description: app.description || '' },
    entities,
    webResources,
    views,
    // NOT yet round-tripped (documented limitation): charts, forms, and commands need structured deployed
    // reads the vendored SDK does not expose (chart datadescription XML, formxml topology, appaction button
    // rows). They remain on the live app — a rebuild preserves them by discovery — but are absent from the
    // downloaded spec, so edit them in Maker or a fresh spec. See download docs / app-builder-roadmap.
    charts: [],
    forms: [],
    commands: [],
    // Dashboards are reconstructed with id-passthrough tiles (each tile carries the deployed
    // view/chart ids), so a rebuild recreates the dashboard against the EXISTING views/charts
    // without needing views[]/charts[] declared (which would else duplicate them or fail validation).
    dashboards: dashboards.map((d) => ({ name: d.name, tiles: d.tiles })),
    pages: pages.map((p) => (hasKeys
      // v2 shape: key + name + optional semantics + source discriminant (kind:'tsx', codeFile)
      ? {
          key: p.key,
          name: p.name,
          // Carry the deployed GenPageId so the downloaded spec is a self-describing EDIT-SNAPSHOT (C3):
          // a rebuild reuses this id (reconcilePageIds authority #1) instead of minting a new one, even for
          // a page the user added in Maker that our manifest never knew about. A portable fresh-authored
          // spec has no pageIds; a downloaded edit-snapshot does — that is the intended distinction.
          // See references/app-spec-schema.md and docs/app-builder-staged-flow-plan-5-sitemap-authority.md §C3.
          ...(p.pageId ? { pageId: p.pageId } : {}),
          ...(p.purpose !== undefined ? { purpose: p.purpose } : {}),
          ...(p.dataSources && p.dataSources.length ? { dataSources: p.dataSources } : {}),
          ...(p.navigatesTo ? { navigatesTo: p.navigatesTo } : {}),
          ...(p.pageInput !== undefined ? { pageInput: p.pageInput } : {}),
          ...(p.prompt ? { prompt: p.prompt } : {}),
          source: { kind: 'tsx', codeFile: p.codeFile },
        }
      // Legacy shape: name + optional fields + top-level codeFile (back-compat with hydrate callers
      // that predate v2 and do not assign keys to downloaded pages).
      : {
          name: p.name,
          ...(p.dataSources && p.dataSources.length ? { dataSources: p.dataSources } : {}),
          ...(p.prompt ? { prompt: p.prompt } : {}),
          codeFile: p.codeFile,
        })),
    appShell,
    // design from the page manifest (§7.3) — omit entirely when absent so the spec stays minimal.
    ...(design !== undefined ? { design } : {}),
  };
}

module.exports = { hydrateSpec, subAreaToSpec };

