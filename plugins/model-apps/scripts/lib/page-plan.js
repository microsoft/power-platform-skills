'use strict';
// App Spec -> `genpage-plan.md` adapter.
//
// WHY this exists: `/app-builder` Phase 1.5 dispatches the SAME worker `/genpage` uses
// (agents/genpage-page-builder.md). That worker's documented input contract is a plan document
// (`## Per-Page Specifications` in references/plan-schema.md) plus an explicit Data mode, target
// file, working directory and plugin root — it does NOT read an App Spec. Before this adapter,
// Phase 1.5 dispatched "the page-builder" with App Spec fragments, so the worker's required inputs
// were never supplied and an intent page could silently never become `.tsx` (the deploy profile
// then fails because `source.kind` is still `intent`). Rather than fork the worker, we project the
// App Spec into the plan shape the worker already understands.
//
// The output is deliberately schema-faithful to references/plan-schema.md: the section headings are
// a machine-readable contract shared with the genpage eval Layer 1 validator, so a plan produced
// here is checked by the same rules as a planner-authored one.
//
// PURE: no I/O, no network. The CLI wrapper (scripts/write-page-plan.js) owns writing the file.

// Per-page fields required by references/plan-schema.md -> `## Per-Page Specifications`.
// Kept as a constant so the tests (and any future validator) assert against one list.
const REQUIRED_PAGE_FIELDS = [
  'File', 'Purpose', 'Entities', 'Needs caching',
  'Key Features', 'Components', 'Layout', 'Data Binding', 'Interactions',
];

const lc = (s) => String(s == null ? '' : s).toLowerCase();

/** The page's stable identity. app-builder names the file after the key so that the worker's
 *  "use the stable key" rule and /genpage's filename-stem resolver produce the SAME PAGEREF token
 *  — the two cross-page identity conventions converge instead of conflicting. */
function pageKey(p) {
  return p.key || p.name;
}

function pageFile(p) {
  // Prefer an already-assigned codeFile (an edit/round-trip may pin one); else <key>.tsx.
  const existing = p.source && p.source.kind === 'tsx' && p.source.codeFile;
  return existing || `${pageKey(p)}.tsx`;
}

/** Entities a page reads, as the plan's comma-separated logical names (or the literal "mock data").
 *  A page with no declared dataSources is a mock page — that is also what selects the worker's
 *  Data mode, so the two must agree. */
function pageEntities(p) {
  const ds = Array.isArray(p.dataSources) ? p.dataSources.filter(Boolean) : [];
  return ds.length ? ds.map(lc).join(', ') : 'mock data';
}

/** Data mode for the worker dispatch. Dataverse whenever the page reads at least one entity. */
function pageDataMode(p) {
  return pageEntities(p) === 'mock data' ? 'mock' : 'dataverse';
}

/** `Needs caching` per plan-schema: true for any page that FETCHES ON MOUNT. A page bound to at
 *  least one entity fetches on mount; a pure mock page does not. */
function needsCaching(p) {
  return pageDataMode(p) === 'dataverse';
}

/** Cross-page navigation targets, as stable keys — the worker emits one `"PAGEREF_<key>"` per edge. */
function navTargets(p) {
  return (Array.isArray(p.navigatesTo) ? p.navigatesTo : [])
    .map((n) => n && n.targetKey)
    .filter(Boolean);
}

function designPreferences(design) {
  const d = design || {};
  return {
    styling: d.styling || d.theme || d.aesthetic || 'Fluent UI V9 defaults; clean, content-first layout',
    features: d.features || 'Search, sorting and filtering where the page lists records',
    accessibility: d.accessibility || 'WCAG AA (ARIA labels, keyboard navigation, semantic HTML)',
  };
}

/**
 * Project an App Spec into a genpage-plan.md document.
 * @param {object} spec  migrated App Spec (schemaVersion 2)
 * @param {object} opts  { envUrl, appLabel, workingDir, pluginRoot, languages, userRequirements }
 * @returns {string} markdown conforming to references/plan-schema.md
 */
function buildPagePlan(spec, opts = {}) {
  const s = spec || {};
  const pages = (s.pages || []).filter(Boolean);
  if (!pages.length) throw new Error('buildPagePlan: the App Spec declares no pages[]');

  const workingDir = opts.workingDir || '.';
  const pluginRoot = opts.pluginRoot || '${PLUGIN_ROOT}';
  const solution = (s.solution && s.solution.uniqueName) || 'Default';
  const prefix = (s.solution && s.solution.publisherPrefix) || 'new';
  const appLabel = opts.appLabel || (s.app && s.app.name) || 'model-driven app';
  const design = designPreferences(s.design);
  const requirements = opts.userRequirements
    || (s.app && s.app.description)
    || `Generative pages for the ${appLabel} model-driven app.`;

  const out = [];
  out.push('# Genpage Plan', '');
  out.push('## User Requirements', requirements, '');
  out.push('## Working Directory', workingDir, '');
  out.push('## Plugin Root', pluginRoot, '');
  out.push('## Environment');
  out.push(`- URL: ${opts.envUrl || '(supplied by /app-builder)'}`);
  out.push(`- App: ${appLabel}`);
  out.push(`- Languages: ${opts.languages || 'English (1033) only'}`);
  out.push(`- Solution: ${solution}`);
  out.push(`- Publisher Prefix: ${prefix}`, '');

  out.push('## Pages');
  out.push('| Page | File | Purpose | Entities |');
  out.push('|------|------|---------|----------|');
  for (const p of pages) {
    out.push(`| ${p.name || pageKey(p)} | ${pageFile(p)} | ${p.purpose || 'Generative page'} | ${pageEntities(p)} |`);
  }
  out.push('');

  // /app-builder provisions the data model in Phase 1.5 step 1 (`--stage data --apply`) BEFORE the
  // workers run, so there is never entity work left for the entity-builder in this flow.
  out.push('## Entity Creation Required');
  out.push('No entity creation required — all entities already exist.', '');

  // Every entity a page reads already exists by the time the workers run (see above), so the whole
  // set is "existing" — this is what drives RuntimeTypes generation. "None" when every page is mock.
  const existing = [...new Set(pages.flatMap((p) => (Array.isArray(p.dataSources) ? p.dataSources : [])).map(lc).filter(Boolean))];
  out.push('## Existing Entities');
  out.push(existing.length ? existing.join(', ') : 'None', '');

  // /app-builder does not author connectors — connector work is owned end-to-end by /genpage's
  // genpage-connector-builder. The schema requires this exact sentinel when there are no bindings,
  // and the page-builder emits connector code ONLY for a real binding table, so the sentinel also
  // guarantees no connector code is generated here.
  out.push('## Connector Bindings');
  out.push('No connector bindings.', '');

  out.push('## Design Preferences');
  out.push(`- Styling: ${design.styling}`);
  out.push(`- Features: ${design.features}`);
  out.push(`- Accessibility: ${design.accessibility}`, '');

  out.push('## Relevant Samples');
  out.push('| Page | Sample | Reason |');
  out.push('|------|--------|--------|');
  for (const p of pages) {
    const mock = pageDataMode(p) === 'mock';
    const sample = mock ? '2-mock-dashboard.tsx' : '3-account-crud-dataverse.tsx';
    const reason = mock ? 'Mock-data page: inline sample records' : 'Dataverse-bound page: queryTable + DataTable rows';
    out.push(`| ${p.name || pageKey(p)} | ${sample} | ${reason} |`);
  }
  out.push('');

  out.push('## Per-Page Specifications', '');
  for (const p of pages) {
    const nav = navTargets(p);
    out.push(`### ${p.name || pageKey(p)}`);
    out.push(`- **File:** ${pageFile(p)}`);
    out.push(`- **Purpose:** ${p.purpose || 'Generative page'}`);
    out.push(`- **Entities:** ${pageEntities(p)}`);
    out.push(`- **Needs caching:** ${needsCaching(p)}`);
    out.push(`- **Key Features:** ${p.purpose || 'Present the page data and its primary actions'}`);
    out.push('- **Components:** Fluent UI V9 (unsized Regular/Filled icons only)');
    out.push('- **Layout:** Responsive flexbox/grid with relative units (never 100vh/100vw)');
    out.push(`- **Data Binding:** ${pageDataMode(p) === 'mock' ? 'Inline mock arrays' : 'dataApi.queryTable / retrieveRow over the entities above'}`);
    // The nav contract is what makes PAGEREF_ resolution deterministic: one placeholder per declared
    // edge, and the build enforces exact parity between emitted tokens and navigatesTo entries.
    out.push(`- **Interactions:** ${nav.length
      ? `Navigate to ${nav.map((k) => `"PAGEREF_${k}"`).join(', ')} via Xrm.Navigation.navigateTo (pageType "generative"); custom ids go in data:`
      : 'In-page interactions only (no cross-page navigation)'}`);
    if (p.pageInput !== undefined) {
      out.push(`- **Page Input:** reads \`pageInput\` (caller-supplied context)`);
    }
    out.push('');
  }

  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

module.exports = {
  buildPagePlan,
  REQUIRED_PAGE_FIELDS,
  pageKey,
  pageFile,
  pageEntities,
  pageDataMode,
  needsCaching,
  navTargets,
};
