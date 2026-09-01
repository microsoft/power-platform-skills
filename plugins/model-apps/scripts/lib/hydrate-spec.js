'use strict';
const { isSafeHttpUrl, webResourceNameFromRef } = require('./app-spec.js');
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
  if (sa.type === 'GenPage' && sa.genPageId) {
    const pageRef = pageRefById.get(String(sa.genPageId).toLowerCase());
    // An unmapped GenPageId cannot validate as an App Spec page reference, so drop the subarea rather
    // than emitting a broken round-trip spec when PAC's page list is incomplete.
    return pageRef ? { ...base, page: pageRef } : null;
  }
  if (sa.type === 'DashBoard' && sa.dashboardId) {
    const name = dashboardNameById && dashboardNameById.get(String(sa.dashboardId).toLowerCase());
    return name ? { ...base, dashboard: name } : null; // drop only if we couldn't reconstruct the dashboard
  }
  if (sa.type === 'URL' && sa.url) {
    // A URL subarea is EITHER a real link OR a web-resource TOKEN (`$webresource:<name>`, which
    // Dataverse also serves at `/WebResources/<name>`) — the Site Map Designer's "custom page backed
    // by an HTML web resource". BOTH round-trip: the validator accepts a token whose web resource is
    // declared in `webResources[]`, and `collectSitemap` adds that name to the download's
    // `customRefs`, so its CONTENT is fetched and re-declared — the same path a custom nav icon
    // referenced by token already takes.
    //
    // Anything else (a `javascript:`/`file:` scheme, a malformed string) cannot be expressed in the
    // App Spec, so it is dropped here rather than emitted. Passing it through made the WHOLE download
    // fail validation and write no spec at all, blocking download → edit → rebuild for the entire app
    // over one nav entry (issue #430). A drop is counted in `droppedSubareas`, so the maker is told
    // which entry will be missing and `--allow-lossy-download` writes the rest.
    if (webResourceNameFromRef(sa.url) || isSafeHttpUrl(sa.url)) return { ...base, url: sa.url };
    return null;
  }
  return null; // CustomPage / unmapped — not hydrated
}

function droppedSubareaDetail(sa) {
  return {
    type: sa && sa.type ? sa.type : 'Unknown',
    id: (sa && (sa.genPageId || sa.dashboardId || sa.id || sa.url || sa.entity)) || undefined,
    title: (sa && sa.title) || undefined,
  };
}

function descriptionFromDataverse(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value.trim() ? value : undefined;
  if (typeof value !== 'object') return undefined;
  // Metadata descriptions arrive as a Dataverse Label, for example:
  //   {
  //     "LocalizedLabels": [{ "Label": "text", "LanguageCode": 1033 }],
  //     "UserLocalizedLabel": { "Label": "text", "LanguageCode": 1033 }
  //   }
  // Prefer the user-localized text because it is the platform's chosen label for this caller, then
  // fall back to the first localized label. A missing/null Label means "no description"; returning
  // undefined (not "") keeps the hydrated spec valid and avoids blanking a maker-authored value on
  // rebuild. Shape: https://learn.microsoft.com/power-apps/developer/data-platform/webapi/reference/label
  const user = value.UserLocalizedLabel && value.UserLocalizedLabel.Label;
  if (typeof user === 'string' && user.trim()) return user;
  const first = Array.isArray(value.LocalizedLabels)
    ? value.LocalizedLabels.find((l) => l && typeof l.Label === 'string' && l.Label.trim())
    : null;
  return first ? first.Label : undefined;
}

function withDescription(obj, rawDescription) {
  const out = { ...obj };
  delete out.description;
  delete out.Description;
  const description = descriptionFromDataverse(rawDescription);
  if (description !== undefined) out.description = description;
  return out;
}

function sanitizeDescriptionInventory(inv) {
  if (!inv || typeof inv !== 'object' || Array.isArray(inv)) return undefined;
  const out = {};
  for (const key of ['views', 'charts', 'forms', 'businessRules', 'globalChoices']) {
    if (!Array.isArray(inv[key])) continue;
    out[key] = inv[key].map((item) => {
      const { Description, description, ...rest } = item || {};
      return withDescription(rest, description !== undefined ? description : Description);
    });
  }
  return Object.keys(out).length ? out : undefined;
}

async function hydrateSpec(read) {
  const app = (await read.app()) || { name: '', description: '', siteMap: { areas: [] } };
  const pages = (await read.pages()) || [];
  const entities = ((await read.entities()) || []).map((e) => {
    const columns = Array.isArray(e && e.columns)
      ? e.columns.map((c) => withDescription(c || {}, (c && (c.description !== undefined ? c.description : c.Description))))
      : [];
    return withDescription({ ...(e || {}), columns }, e && (e.description !== undefined ? e.description : e.Description));
  });
  const webResources = ((await read.webResources()) || []).map((wr) => withDescription(wr || {}, wr && (wr.description !== undefined ? wr.description : wr.Description)));
  const dashboards = ((read.dashboards ? await read.dashboards() : []) || [])
    .map((d) => withDescription(d || {}, d && (d.description !== undefined ? d.description : d.Description)));
  // `prefixResolved` is a TRANSIENT download-time signal (whether recoverAppSolution trusted the publisher
  // prefix) consumed by iconWebResources BEFORE hydrate; strip it so it never leaks into the persisted,
  // user-facing spec — the build reads only uniqueName + publisherPrefix from solution.
  const { prefixResolved, ...solutionRaw } = (await read.solution()) || { uniqueName: 'Default', publisherPrefix: 'new' };
  const solution = withDescription(solutionRaw, solutionRaw.description !== undefined ? solutionRaw.description : solutionRaw.Description);
  void prefixResolved;
  // `design` is threaded through from the page manifest (§7.3) when present; undefined for legacy apps.
  const design = read.design ? await read.design() : undefined;
  const descriptionInventory = read.descriptionInventory ? sanitizeDescriptionInventory(await read.descriptionInventory()) : undefined;
  // When downloaded pages carry stable keys (assigned by assignPageKeys), emit the v2 shape;
  // legacy callers without keys fall back to the name-based shape for back-compat.
  const hasKeys = pages.some((p) => p.key);
  // v2: GenPage subareas resolve by KEY (stable identity); legacy: by NAME.
  const pageKeyById = new Map(pages.filter((p) => p.pageId && p.key).map((p) => [String(p.pageId).toLowerCase(), p.key]));
  const pageNameById = new Map(pages.filter((p) => p.pageId && p.name).map((p) => [String(p.pageId).toLowerCase(), p.name]));
  const dashboardNameById = new Map(dashboards.filter((d) => d.id && d.name).map((d) => [String(d.id).toLowerCase(), d.name]));
  // Dispatch: v2 routes GenPage by key; legacy routes by name.
  const subMap = hasKeys ? pageKeyById : pageNameById;
  const droppedSubareaDetails = [];

  const mapSubArea = (sa) => {
    const mapped = subAreaToSpec(sa, subMap, dashboardNameById);
    if (!mapped) {
      // Dropping remains the safest App Spec behavior (an invalid GenPage/DashBoard ref would fail
      // validation or rebuild the wrong nav), but download must be able to fail loudly instead of
      // claiming a lossless pull. Keep compact type/id/title facts so the CLI can tell the maker what
      // needs manual recovery without persisting SDK sitemap internals into the app-spec.
      droppedSubareaDetails.push(droppedSubareaDetail(sa));
    }
    return mapped;
  };

  const appShell = {
    areas: (app.siteMap.areas || []).map((a) => ({
      label: a.title,
      ...(a.icon ? { icon: a.icon } : {}),
      ...(a.vectorIcon ? { vectorIcon: a.vectorIcon } : {}),
      groups: (a.groups || []).map((g) => ({
        label: g.title,
        subAreas: (g.subAreas || []).map(mapSubArea).filter(Boolean),
      })),
    })),
  };

  // BACK-COMPAT: a page reconstructed from an app deployed BEFORE `directEntry` existed carries
  // `pageInput` and no `directEntry`. App Spec validation requires the pair, and download validates
  // BEFORE writing — so without a default, downloading such an app fails and writes NO spec file at
  // all, leaving the author nothing to edit and no way back into the round-trip. That is precisely
  // the "one unrelated nav entry blocks the whole download → edit → rebuild flow" failure #430 was
  // filed for, and it would have been reintroduced by the rule that fixed a different hole.
  //
  // Default to the CONSERVATIVE behaviour. `emptyState` does not promise a picker the already-
  // deployed `.tsx` never had, which `selector` would. It is a prospective intent for the NEXT
  // rebuild, not a claim about what the deployed page does today — that is genuinely unknown here,
  // since the page was written before the field existed and implements neither behaviour explicitly.
  // The value is written into the spec visibly, with a note saying where it came from, so the author
  // can decide rather than discover it later.
  //
  // This deliberately does NOT weaken the rule for hand-authored specs: those do not come through
  // hydration, so an author writing a new page with `pageInput` still has to decide.
  const directEntryDefaulted = [];
  const directEntryOf = (p) => {
    if (p.directEntry !== undefined) return { directEntry: p.directEntry };
    // Match the validation condition exactly: only a pageInput that declares DATA keys requires it.
    if (!Object.keys((p.pageInput && p.pageInput.data) || {}).length) return {};
    directEntryDefaulted.push(p.key || p.name);
    return {
      directEntry: {
        behavior: 'emptyState',
        note: 'Defaulted on download: this app predates directEntry. Change to "selector" if opening this page from the navigation should show a record picker.',
      },
    };
  };

  const spec = {
    // schemaVersion 2 only when pages carry keys (v2 shape); omitted for legacy back-compat.
    ...(hasKeys ? { schemaVersion: 2 } : {}),
    solution,
    // Round-trip the app's REAL, immutable uniquename so a rebuild resolves the EXISTING app by identity
    // (appUniqueName prefers this over the display-name derivation) — survives a display-name rename and
    // never creates a duplicate app. Omitted for a legacy read that didn't surface it.
    app: { name: app.name, description: app.description || '', ...(app.uniquename ? { uniqueName: app.uniquename } : {}) },
    entities,
    webResources,
    views: [],
    // NOT yet round-tripped (documented limitation): views, charts, forms, and commands. VIEWS were
    // tried (F3) but reverted — the deployed savedquery set can't reliably distinguish app-builder-
    // authored views from Dataverse's auto-generated Active/Inactive/QuickFind/Lookup/AdvancedFind
    // system views (LIVE-verified: `isdefault` marks the AUTHORED primary "Active" view TRUE and the
    // SYSTEM "Inactive" view FALSE, so no `isdefault`/`querytype` filter isolates author views — it
    // grabbed the wrong one). Charts/forms/commands also need structured reads the SDK doesn't expose.
    // All four survive on the live app — a rebuild preserves them by discovery — but are absent from the
    // downloaded spec, so edit them in Maker or a fresh spec. See download docs / app-builder-capabilities.
    charts: [],
    forms: [],
    commands: [],
    // Dashboards are reconstructed with id-passthrough tiles (each tile carries the deployed
    // view/chart ids), so a rebuild recreates the dashboard against the EXISTING views/charts
    // without needing views[]/charts[] declared (which would else duplicate them or fail validation).
    dashboards: dashboards.map((d) => ({ name: d.name, ...(d.description ? { description: d.description } : {}), tiles: d.tiles })),
    pages: pages.map((p) => (hasKeys
      // v2 shape: key + name + optional semantics + source discriminant (kind:'tsx', codeFile)
      ? {
          key: p.key,
          name: p.name,
          // Carry the deployed GenPageId so the downloaded spec is a self-describing EDIT-SNAPSHOT (C3):
          // a rebuild reuses this id (reconcilePageIds authority #1) instead of minting a new one, even for
          // a page the user added in Maker that our manifest never knew about. A portable fresh-authored
          // spec has no pageIds; a downloaded edit-snapshot does — that is the intended distinction.
          // See references/app-spec-schema.md (pages[].pageId) and docs/app-builder-design.md.
          ...(p.pageId ? { pageId: p.pageId } : {}),
          ...(p.purpose !== undefined ? { purpose: p.purpose } : {}),
          ...(p.dataSources && p.dataSources.length ? { dataSources: p.dataSources } : {}),
          ...(p.navigatesTo ? { navigatesTo: p.navigatesTo } : {}),
          ...(p.pageInput !== undefined ? { pageInput: p.pageInput } : {}),
          ...directEntryOf(p),
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
    // Views, charts, forms, business rules, and global choices are not structurally reconstructed by
    // this hydrator today. Keep their descriptions in a read-only inventory so an inspecting agent can
    // still see the deployed intent without pretending these partial records are rebuildable spec
    // entries.
    ...(descriptionInventory !== undefined ? { descriptionInventory } : {}),
  };
  // These diagnostics are intentionally non-enumerable: hydrateSpec returns them to the download CLI,
  // but `app-spec.json` must stay the user-facing contract rather than gaining transient loss metadata.
  Object.defineProperties(spec, {
    droppedSubareas: { value: droppedSubareaDetails.length, enumerable: false },
    droppedSubareaDetails: { value: droppedSubareaDetails, enumerable: false },
    // Page keys that received a defaulted `directEntry` (see directEntryOf above). Surfaced so the
    // download CLI can tell the author a value was chosen FOR them — a silently injected behaviour
    // would be its own bug, quieter than the hard failure it replaces.
    directEntryDefaulted: { value: directEntryDefaulted, enumerable: false },
  });
  return spec;
}

module.exports = { hydrateSpec, subAreaToSpec, descriptionFromDataverse, withDescription };
