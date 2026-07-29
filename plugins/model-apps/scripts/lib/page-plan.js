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

// --- Untrusted-text hardening -------------------------------------------------------------------
// The projected plan is READ AS INSTRUCTIONS by a Read/Write/Edit-capable worker, and its section
// headings are a machine-readable contract. App Spec strings (page name, purpose, app description)
// are author- or DOWNLOAD-supplied (hydrate-spec.js reconstructs them from a deployed app), so they
// cross a trust boundary. A value containing a newline + `## Per-Page Specifications` could inject or
// truncate a section; a `|` could break a table row. Neither is caught by schema validation, because
// the resulting markdown is still "valid".
// So every interpolated value is flattened to a single line and its markdown-structural characters
// are neutralised. This is deliberately lossy for display, never for identity: keys/entity logical
// names are separately constrained (see assertIdentitySafe).
//
// `|` is REPLACED (not backslash-escaped) because the same sanitised page name has to appear both in
// a `## Pages` table cell and in its `### <name>` per-page heading, and the eval Layer 1 validator
// cross-references those two byte-for-byte. An escape that only applies inside tables would make
// them disagree and fail `missing-page-spec`.
function mdText(value, fallback = '') {
  const s = String(value == null ? '' : value);
  if (!s.trim()) return fallback;
  return s
    .replace(/[\r\n]+/g, ' ')      // no line breaks -> cannot start a new block/section
    // ATX heading syntax only (`#` followed by whitespace). A bare `#` is NOT stripped, because
    // `accentColor: "#0f6cbd"` is a legitimate value and dropping the `#` corrupts the design token.
    // Newlines are already gone by this point, so a value can never begin a line anyway.
    .replace(/^\s*#+\s+/, '')
    .replace(/`/g, "'")            // cannot open a code fence / inline code
    // `~~~` is the other CommonMark fence and `<!--` an HTML comment: an unterminated one would
    // swallow every section AFTER this value, silently truncating the worker's contract.
    .replace(/~/g, '-')
    .replace(/<!--|-->/g, '')
    .replace(/\|/g, '/')           // cannot add a table column
    .replace(/\s+/g, ' ')
    .trim();
}

// Identity values (page key, entity logical name) end up in `PAGEREF_<key>` tokens and in
// `--data-sources`, so they must be strict identifiers — not merely escaped. A spec that violates
// this is a hard error rather than something we silently mangle, because a mangled key produces a
// PAGEREF the build cannot resolve.
const IDENT_RE = /^[A-Za-z0-9_-]+$/;
function assertIdentitySafe(kind, value) {
  if (!IDENT_RE.test(String(value || ''))) {
    throw new Error(`buildPagePlan: unsafe ${kind} "${value}" — must match ${IDENT_RE} (letters, digits, _ and -)`);
  }
  return String(value);
}

/** The page's stable identity — the ONLY thing `/app-builder` derives `PAGEREF_<key>` from.
 *  Identity is deliberately NOT derived from the file name: a downloaded/round-tripped page carries a
 *  pinned `codeFile` (e.g. `pages/<guid>/page.tsx`), so a file-derived token would not match the
 *  spec's `navigatesTo[].targetKey` and the build's nav-parity gate would halt. The plan therefore
 *  publishes an explicit Key column and the worker uses that under app-builder. */
function pageKey(p) {
  return assertIdentitySafe('page key', p.key || p.name);
}

function pageFile(p) {
  // A pinned codeFile (edit / download round-trip) is preserved so we write where the page really
  // lives. It is NOT the identity — see pageKey().
  const existing = p.source && p.source.kind === 'tsx' && p.source.codeFile;
  return existing || `${pageKey(p)}.tsx`;
}

/** Entities a page reads, as the plan's comma-separated logical names (or the literal "mock data").
 *  Logical names flow into `--data-sources` on the generate-types command line, so they are held to
 *  the identifier contract rather than merely escaped. */
function pageEntities(p) {
  const ds = Array.isArray(p.dataSources) ? p.dataSources.filter(Boolean) : [];
  return ds.length ? ds.map((e) => assertIdentitySafe('entity logical name', lc(e))).join(', ') : 'mock data';
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

/** Cross-page navigation targets, as stable keys — the worker emits one `"PAGEREF_<key>"` per edge.
 *  Guarded because the key is emitted verbatim into generated TSX. */
function navTargets(p) {
  return (Array.isArray(p.navigatesTo) ? p.navigatesTo : [])
    .map((n) => n && n.targetKey)
    .filter(Boolean)
    .map((k) => assertIdentitySafe('navigatesTo targetKey', k));
}

// Project the App Spec's `design` contract into the plan's `## Design Preferences` section.
//
// The canonical field set is fixed and validated (app-spec.js rejects unknown keys):
// `accentColor`, `density`, `cornerRadius`, `darkMode`, `layout`. These are the tokens the user
// approved during authoring, so every generated page must apply them — a page that ignores them is
// visually inconsistent with the rest of the app and with the model-driven shell.
// Values are sanitised because `design` is author-supplied (and download-derived on an edit).
function designPreferences(design) {
  const d = design && typeof design === 'object' ? design : {};
  const tokens = [
    ['Accent color', d.accentColor],
    ['Density', d.density],
    ['Corner radius', d.cornerRadius],
    ['Dark mode', d.darkMode],
  ]
    .filter(([, v]) => v != null && String(v).trim())
    .map(([label, v]) => `${label}: ${mdText(v)}`);

  return {
    // Always name Fluent UI V9 — it is the required component library, not a preference — then
    // append the approved tokens so the worker has a single authoritative styling line.
    styling: tokens.length
      ? `Fluent UI V9 tokens — ${tokens.join('; ')}`
      : 'Fluent UI V9 defaults; clean, content-first layout',
    layout: d.layout ? `${mdText(d.layout)} layout, responsive` : null,
    features: 'Search, sorting and filtering where the page lists records',
    accessibility: 'WCAG AA (ARIA labels, keyboard navigation, semantic HTML)',
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
  out.push('## User Requirements', mdText(requirements, 'Generative pages for a model-driven app.'), '');
  out.push('## Working Directory', workingDir, '');
  out.push('## Plugin Root', pluginRoot, '');
  out.push('## Environment');
  out.push(`- URL: ${mdText(opts.envUrl, '(supplied by /app-builder)')}`);
  out.push(`- App: ${mdText(appLabel, 'model-driven app')}`);
  out.push(`- Languages: ${mdText(opts.languages, 'English (1033) only')}`);
  out.push(`- Solution: ${mdText(solution, 'Default')}`);
  out.push(`- Publisher Prefix: ${mdText(prefix, 'new')}`);
  // Explicit caller mode: the worker cannot otherwise tell which cross-page identity rule applies
  // (stable Key under /app-builder vs file stem under standalone /genpage).
  out.push('- Mode: app-builder', '');

  // The Key column is the identity contract. `File` is only where to write.
  out.push('## Pages');
  out.push('| Page | Key | File | Purpose | Entities |');
  out.push('|------|-----|------|---------|----------|');
  for (const p of pages) {
    out.push(`| ${mdText(p.name, pageKey(p))} | ${pageKey(p)} | ${mdText(pageFile(p))} | ${mdText(p.purpose, 'Generative page')} | ${mdText(pageEntities(p))} |`);
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
  if (design.layout) out.push(`- Layout: ${design.layout}`);
  out.push(`- Features: ${design.features}`);
  out.push(`- Accessibility: ${design.accessibility}`, '');

  out.push('## Relevant Samples');
  out.push('| Page | Sample | Reason |');
  out.push('|------|--------|--------|');
  for (const p of pages) {
    // Sample names are validated against samples/ by write-page-plan.js before the plan is written —
    // naming a file that does not exist makes the worker's Step 3 read fail.
    const mock = pageDataMode(p) === 'mock';
    const sample = mock ? '7-responsive-cards.tsx' : '9-list-with-caching.tsx';
    const reason = mock
      ? 'Mock-data page: inline sample records, card layout'
      : 'Dataverse-bound page: queryTable + DataTable rows with the on-mount de-dupe cache';
    out.push(`| ${mdText(p.name, pageKey(p))} | ${sample} | ${reason} |`);
  }
  out.push('');

  out.push('## Per-Page Specifications', '');
  for (const p of pages) {
    const nav = navTargets(p);
    out.push(`### ${mdText(p.name, pageKey(p))}`);
    out.push(`- **Key:** ${pageKey(p)}`);
    out.push(`- **File:** ${mdText(pageFile(p))}`);
    out.push(`- **Purpose:** ${mdText(p.purpose, 'Generative page')}`);
    out.push(`- **Entities:** ${mdText(pageEntities(p))}`);
    out.push(`- **Needs caching:** ${needsCaching(p)}`);
    out.push(`- **Key Features:** ${mdText(p.purpose, 'Present the page data and its primary actions')}`);
    out.push('- **Components:** Fluent UI V9 (unsized Regular/Filled icons only)');
    out.push(`- **Layout:** ${design.layout ? `${design.layout} — r` : 'R'}esponsive flexbox/grid with relative units (never 100vh/100vw)`);
    out.push(`- **Data Binding:** ${pageDataMode(p) === 'mock' ? 'Inline mock arrays' : 'dataApi.queryTable / retrieveRow over the entities above'}`);
    out.push(`- **Interactions:** ${nav.length
      ? `Navigate to ${nav.map((k) => `"PAGEREF_${k}"`).join(', ')} via Xrm.Navigation.navigateTo (pageType "generative"); custom ids go in data:`
      : 'In-page interactions only (no cross-page navigation)'}`);
    if (p.pageInput !== undefined) {
      out.push('- **Page Input:** reads `pageInput` (caller-supplied context)');
    }
    out.push('');
  }

  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

module.exports = {
  buildPagePlan,
  REQUIRED_PAGE_FIELDS,
  mdText,
  pageKey,
  pageFile,
  pageEntities,
  pageDataMode,
  needsCaching,
  navTargets,
};
