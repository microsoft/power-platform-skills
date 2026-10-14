'use strict';
// Pure + I/O readers of an app's generative pages FROM ITS SITEMAP XML (the MEMBERSHIP authority). A
// generative-page subarea stores its page id in the `GenPageId="<guid>"` attribute SPECIFICALLY (the SDK
// writes/reads exactly this — cds-maker-sdk.cjs parses /GenPageId="([0-9a-fA-F-]{36})"/, subarea attr set
// ["Entity","Url","DefaultDashboard","Page","GenPageId"]). The sitemap is the authoritative, complete record
// of which pages BELONG to the app (model-driven-app membership == sitemap presence). Membership is NOT an
// existence check — a page can exist env-wide yet not be in this app's sitemap (see genpage-cli.enumerateEnv).

const { odataLit } = require('./odata.js');
const { appComponentRows, currentAppLayer, collectionRows, currentLayerRows } = require('./app-components.js');
const { subAreaTargetKey } = require('./sitemap-merge.js');

// Match a <SubArea …> START TAG carrying a GenPageId, capturing the id and (optionally) the Title.
// Attributes are order-independent, so scan each start tag and pull GenPageId + Title separately.
const SUBAREA_RE   = /<SubArea\b[^>]*>/gi;
const GENPAGE_ATTR = /\bGenPageId="([0-9a-fA-F-]{36})"/i;
const TITLE_ATTR   = /\bTitle="([^"]*)"/i;
const DESC_ATTR    = /\bDescription="([^"]*)"/i;

// Exact 36-char GUID pattern used for structural validation in `isMalformed`.
const GUID_36 = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

// Decode XML character references so a sitemap Title like "Orders &amp; Overview" becomes a usable page
// NAME ("Orders & Overview") on the download round-trip, and a Url compares as the SDK reads it. Sitemap
// free-text is XML-ESCAPED by the SDK's safe-DOM factory, so it must be reversed before a Title is treated as
// a name — and a serializer may write any character as a numeric reference (`&#38;`, `&#x26;`), not only
// through the five predefined entities. ONE pass, so a double-encoded "a &amp;lt; b" decodes to "a &lt; b",
// never "a < b". A reference to no character (out of range, or a surrogate) is left as written.
const XML_PREDEFINED = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
function decodeXmlEntities(s) {
  return String(s).replace(/&(?:#x([0-9a-fA-F]+)|#([0-9]+)|(lt|gt|amp|quot|apos));/g, (ref, hex, dec, name) => {
    if (name) return XML_PREDEFINED[name];
    const cp = hex !== undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    return cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : ref;
  });
}

// The live nav entries in sitemap XML, by navigation target (subAreaTargetKey, sitemap-merge.js).
// For example
//   <SubArea Id="ops" Url="/workplace/home_dashboards.aspx" DefaultDashboard="{280948EC-…}" VectorIcon="$webresource:new_ops.svg">
// becomes 'DashBoard:280948ec-…' → [{ icon: undefined, vectorIcon: '$webresource:new_ops.svg', url: '/workplace/home_dashboards.aspx' }].
// An entry's type is read the way the SDK reads it — GenPageId, Entity, Page, DefaultDashboard, URL.
// Only ELEMENTS count: a SubArea (not SubArea-Archived or SubAreaÜ) directly under SiteMap/Area/Group.
// Other locations are opaque XML. Comments, CDATA and processing instructions are text, so remove
// them first and walk whole element names (including Unicode) with a stack. A value can contain '>',
// so match tags quote by quote. Fully decode attributes in either quote style, including &#38;.
// Return null for markup this walk cannot account for completely: an unmatched '<' (including a
// document type declaration whose entities could expand into elements), or a mismatched closing tag.
// That gives neither verify a kept-icon exemption nor download a smaller authoritative target set.
const NAV_PATH = ['SiteMap', 'Area', 'Group'];
const XML_TAG = /<(\/?)([^\s/>"'=!?]+)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
const XML_ATTR = /\s([^\s/>"'=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
function liveNavEntries(xml) {
  const markup = String(xml || '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '')
    .replace(/<\?[\s\S]*?\?>/g, '');
  const tags = [...markup.matchAll(XML_TAG)];
  // In well-formed XML every remaining '<' starts a tag; text and attributes escape it.
  if (tags.length !== (markup.match(/</g) || []).length) return null;
  const byKey = new Map();
  const open = [];
  for (const [, closing, name, body, selfClosing] of tags) {
    if (closing) {
      if (open[open.length - 1] !== name) return null;
      open.pop();
      continue;
    }
    if (name === 'SubArea' && open.length === NAV_PATH.length && NAV_PATH.every((n, i) => open[i] === n)) {
      const attrs = Object.create(null);
      for (const m of body.matchAll(XML_ATTR)) attrs[m[1]] = decodeXmlEntities(m[2] !== undefined ? m[2] : m[3]);
      const type = attrs.GenPageId ? 'GenPage' : attrs.Entity ? 'Entity' : attrs.Page ? 'CustomPage' : attrs.DefaultDashboard ? 'DashBoard' : 'URL';
      const key = subAreaTargetKey({ type, entity: attrs.Entity, url: attrs.Url, dashboardId: attrs.DefaultDashboard, page: attrs.Page, genPageId: attrs.GenPageId });
      if (key) {
        if (!byKey.has(key)) byKey.set(key, []);
        byKey.get(key).push({ icon: attrs.Icon, vectorIcon: attrs.VectorIcon, url: attrs.Url });
      }
    }
    if (!selfClosing) open.push(name);
  }
  return open.length ? null : byKey;
}

function appNavigationMatchesSitemap(app, xml) {
  const siteMap = app && app.siteMap;
  if (!siteMap || !Array.isArray(siteMap.areas) || !siteMap.areas.length) return false;
  const selected = liveNavEntries(xml);
  if (!selected) return false;
  // All modeled targets matter: losing a URL, dashboard, custom page or repeated shortcut is
  // silent navigation loss too. The XML reader preserves occurrences, so compare their counts.
  const fetchedTargets = new Map();
  for (const area of siteMap.areas) {
    for (const group of area.groups || []) {
      for (const sub of group.subAreas || []) {
        const key = subAreaTargetKey(sub);
        if (key) fetchedTargets.set(key, (fetchedTargets.get(key) || 0) + 1);
      }
    }
  }
  return selected.size === fetchedTargets.size
    && [...selected].every(([key, entries]) => fetchedTargets.get(key) === entries.length);
}

function sitemapGenPages(xml) {
  const s = String(xml || '');
  const seen = new Set();
  const out  = [];
  let m;
  while ((m = SUBAREA_RE.exec(s)) !== null) {
    const tag = m[0];
    const g = GENPAGE_ATTR.exec(tag);
    if (!g) continue;
    const pageId = g[1];
    const key = pageId.toLowerCase();
    if (seen.has(key)) continue; // a page attached in two areas → one entry (dedup by lower-cased id)
    seen.add(key);
    const t = TITLE_ATTR.exec(tag) || DESC_ATTR.exec(tag);
    out.push(t ? { pageId, title: decodeXmlEntities(t[1]) } : { pageId });
  }
  return out;
}

// Sorted-unique lower-cased ids — the fast MEMBERSHIP set for validation/verify/download.
function sitemapGenPageIds(xml) {
  return Array.from(new Set(sitemapGenPages(xml).map((r) => r.pageId.toLowerCase()))).sort();
}

// Structural validation for a PRESENT sitemapxml string (C4 addenda). Returns true if the XML is
// malformed/truncated and must NOT be accepted as a valid (even page-less) sitemap.
//
// Three malformed conditions (any one is sufficient):
//  1. No root `<SiteMap` or `<Area` marker — not a sitemap at all (wrong entity, JSON, etc.).
//  2. Truncation: trimmed string doesn't end with `>` (common when a DB read was cut short).
//  3. Any `GenPageId="…"` occurrence whose value is NOT a valid 36-char GUID (corrupt attribute value).
//
// A `<SubArea` without a closing `>` is already covered by condition 2 (the whole string is unterminated).
function isMalformed(xml) {
  // Condition 1: must look like a sitemap (has a <SiteMap or <Area opening tag)
  if (!/<SiteMap\b/.test(xml) && !/<Area\b/.test(xml)) return true;
  // Condition 2: truncation — the XML was cut mid-stream
  if (!xml.trim().endsWith('>')) return true;
  // Condition 3: any GenPageId value that is not a valid 36-char GUID
  // Use a fresh RegExp (not the global GENPAGE_ATTR) to avoid lastIndex state
  const gpAll = /GenPageId="([^"]*)"/gi;
  let m;
  while ((m = gpAll.exec(xml)) !== null) {
    if (!GUID_36.test(m[1])) return true;
  }
  return false;
}

// Fetch the app's LIVE sitemap, FAIL-CLOSED and DISCRIMINATED (C4). appmodule (by unique name) →
// appmodulecomponent (componenttype 62 — the sitemap) → sitemap.sitemapxml. The three not-found cases are
// DISTINCT reasons (the old sitemapXmlFor in verify-model-app.js collapsed them all to '' — indistinguishable
// from a valid page-less sitemap — which let reconcile/verify read "no live pages" and recreate-all).
//
// Discriminated results:
//   { ok:false, reason:'app-not-found' }               — appmodule not found for this uniquename
//   { ok:false, reason:'sitemap-component-not-found' }  — no appmodulecomponent type 62
//   { ok:false, reason:'sitemap-xml-unreadable' }       — sitemapxml is falsy/empty
//   { ok:false, reason:'malformed' }                    — present XML fails structural validation (C4)
//   { ok:false, reason:'*-query-failed', detail }       — transport error (still propagates as fail-closed)
//   { ok:true,  xml, ids:[] }                          — valid, page-less sitemap (NOT "missing")
//   { ok:true,  xml, ids:[...] }                        — valid sitemap with genpage subareas
//
// componenttype 62 == sitemap:
//   https://learn.microsoft.com/power-apps/developer/data-platform/reference/entities/appmodulecomponent
async function fetchSitemap(sdk, appUnique, { currentLayer, includeSitemapId } = {}) {
  let app;
  if (currentLayer !== undefined) {
    // Download supplies the SAME current layer as its table/form inventory. Default callers
    // (verify and live-page safety checks) retain their published snapshot; never fall back to it.
    if (!currentLayer.ok) return { ok: false, reason: 'appmodule-query-failed', detail: currentLayer.reason };
    app = { appmoduleidunique: currentLayer.appModuleIdUnique };
  } else {
    try {
      const apps = await sdk.queryRecords('appmodule', {
        select: ['appmoduleid', 'appmoduleidunique'],
        filter: `uniquename eq '${odataLit(appUnique)}'`,
        top:    1,
      });
      app = apps && apps[0];
    } catch (e) {
      return { ok: false, reason: 'appmodule-query-failed', detail: String((e && e.message) || e) };
    }
  }
  if (!app) return { ok: false, reason: 'app-not-found' };

  let comps;
  try {
    // _appmoduleidunique_value is a lookup GUID — it must be UNQUOTED in the OData filter (quoting it 400s
    // because the SDK/Dataverse expects a raw GUID literal for navigation property filters).
    comps = await appComponentRows(sdk, app.appmoduleidunique, 62, { top: 1 });
  } catch (e) {
    return { ok: false, reason: 'sitemap-component-query-failed', detail: String((e && e.message) || e) };
  }
  const smId = comps && comps[0] && comps[0].objectid;
  if (!smId) return { ok: false, reason: 'sitemap-component-not-found' };

  let sms;
  try {
    if (currentLayer !== undefined) {
      const id = String(smId).replace(/[{}]/g, '');
      if (!GUID_36.test(id)) throw new Error(`current sitemap component '${smId}' has no valid GUID`);
      const response = await sdk.dataverse.get(
        `/sitemaps/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()?$select=sitemapxml,componentstate&$filter=sitemapid eq ${id}`);
      if (!response || response.status < 200 || response.status >= 300) throw new Error(`current sitemap read returned HTTP ${response && response.status}`);
      const rows = response.body && response.body.value;
      if (!Array.isArray(rows)) throw new Error('current sitemap read returned no readable result set');
      sms = currentSitemapRows(rows);
    } else {
      sms = await sdk.queryRecords('sitemap', {
        select: ['sitemapxml'],
        filter: `sitemapid eq ${smId}`,
        top:    1,
      });
    }
  } catch (e) {
    return { ok: false, reason: 'sitemap-query-failed', detail: String((e && e.message) || e) };
  }
  const xml = sms && sms[0] && sms[0].sitemapxml;

  // A deployed app ALWAYS has non-empty sitemapxml; falsy/empty is anomalous → fail-closed (NOT "valid, empty").
  if (!xml) return { ok: false, reason: 'sitemap-xml-unreadable' };

  // C4 (addenda): a PRESENT but structurally invalid / truncated XML must also be rejected. A malformed
  // sitemap accepted as { ok:true, ids:[] } would cause the build to treat all pages as absent and recreate them.
  if (isMalformed(String(xml))) return { ok: false, reason: 'malformed' };

  // `sitemapId` (opt-in, so the default result keeps its shape) is the id the read resolved, normalized as guidKey does, for a caller that
  // has to match this app's sitemap to a row it read elsewhere (fetchAppsForPages joins the saved layer by it).
  return { ok: true, xml: String(xml), ids: sitemapGenPageIds(String(xml)), ...(includeSitemapId ? { sitemapId: guidKey(smId) } : {}) };
}

const guidKey = (id) => String(id || '').replace(/^\{|\}$/g, '').toLowerCase();

// The one CURRENT row among the rows RetrieveUnpublishedMultiple returned for a sitemap. With a pending edit the platform can answer with
// both layers —
//   { value: [{ componentstate: 0, sitemapxml: "old" }, { componentstate: 1, sitemapxml: "draft" }] }
// — and only the authored row (componentstate 1) is current. Two rows that do not name exactly one current row are ambiguous, and throw.
// Returns [] for no rows, so the caller decides what an absent row means.
function currentSitemapRows(rows) {
  const current = rows.length <= 1 ? rows : rows.filter((row) => row && Number(row.componentstate) === 1);
  if (current.length > 1 || (rows.length > 1 && current.length !== 1)) throw new Error('current sitemap read returned no single current row');
  return current;
}

// Env-wide MEMBERSHIP scan (Imp5): which apps' sitemaps reference each id in `pageIds`. GROUNDED by a live
// Dataverse probe (test environment): a generative page has NO `appmodulecomponent` row —
// `appmodulecomponents?$filter=objectid eq <genPageId>` returns 0 rows. So a genpage's app membership lives
// ONLY inside the sitemap XML (`GenPageId="…"`), with NO direct genpage→apps join. The ONLY way to find a
// page shared across apps is to scan every OTHER app's sitemap XML for the id.
//
// Cost: O(number of apps) — one appmodule list + one PUBLISHED sitemap read per OTHER app, plus ONE read of every sitemap's SAVED layer (below), plus ONE
// request for the apps that were never published and one component read for each of those (further below; its saved sitemap rides the one saved-layer read).
// `excludeAppUnique` skips the app being built (self can't share with itself), so a SINGLE-APP environment reads ZERO other sitemaps: it costs the one small
// list of apps that were never published, and nothing more when there are none (with a never-published app whose layer has no sitemap component, one saved-layer read as well).
//
// TWO LAYERS. A page another app has saved into its navigation but not published belongs to that app as much as a published one: the maker can
// publish at any moment, and an UPDATE now rewrites a page that app is about to show. So an app counts for an id when its published sitemap OR its saved
// (current, unpublished) sitemap has it. The saved layer is read for ALL other apps in ONE request, however many there are — the `sitemap` collection's
// RetrieveUnpublishedMultiple, which is composable with $select
// (https://learn.microsoft.com/power-apps/developer/data-platform/webapi/reference/retrieveunpublishedmultiple) — and joined to each app by the
// sitemap id its published read resolved. It is the reader, and the current-row rule (currentSitemapRows), that navigationProof applies to this
// app's own saved layer. A draft that REMOVES a page does not clear it: the published layer is what that app's users see until the maker publishes.
//
// NEVER-PUBLISHED APPS. An app that was created in the maker and saved but never published has no row in the published list above, so none of that app's
// navigation was read — yet a page it holds is its page, and publishing it would show the page there. draftOnlyApps lists such apps (one request), and each
// one's saved sitemap is joined from the same one saved-layer read, by the sitemap id its layer's sitemap component names — or, for an app whose layer has no such
// component, by the sitemap whose unique name is the app's (the vendored SDK links an app to its sitemap by that name). It has no published layer, so
// whatever it holds is "saved only".
//
// COMPLETE ENUMERATION (`paginate: true`): the vendored SDK's queryRecords now follows the OData
// `@odata.nextLink` to completion, so the appmodule list is the FULL set even past the ~5000-row server
// page — no silent truncation. This closes the old fail-closed-at-the-cap hole: an unlisted app could
// hide a shared page we are about to UPDATE, so the scan previously HALTed (`apps-truncated`) whenever the
// list hit the single-page cap; it can now safely verify EVERY app in the environment. A pagination fault
// (the SDK aborts on a repeated `@odata.nextLink` to avoid an infinite loop) throws → caught below →
// `{ ok:false }`, so enumeration still fails CLOSED rather than scanning a partial list.
//
// FAIL-CLOSED on the enumeration itself: a failed appmodule list → { ok:false } (caller refuses to proceed
// without full visibility). BEST-EFFORT per app: an app whose sitemap we cannot read is recorded in `unreadable`
// and skipped (one bad app doesn't block the whole env — the caller warns about partial coverage). The saved layer
// is held to the same rule: a read that fails as a whole is { ok:false } (no app's draft is then known), and an app
// whose saved sitemap is missing, ambiguous or malformed is recorded in `unreadable`. So is the list of never-published apps: one that cannot be read
// is { ok:false }, and a draft app whose layer or sitemap cannot be resolved is `unreadable` — except one whose component read succeeds and finds no sitemap
// component AND whose name no sitemap in the saved layer carries, which has no navigation and holds no page.
//   -> { ok:true, byId: Map<id, appUniqueName[]> (an app holding the id in either layer), savedOnly: Map<id, appUniqueName[]> (the
//        apps that hold it ONLY in the saved layer), unreadable: appUniqueName[] } | { ok:false, error }
async function fetchAppsForPages(sdk, pageIds, opts) {
  opts = opts || {};
  const want = new Set(Array.from(pageIds || []).map((x) => String(x).toLowerCase()));
  if (!want.size) return { ok: true, byId: new Map(), savedOnly: new Map(), unreadable: [] };

  const self = opts.excludeAppUnique ? String(opts.excludeAppUnique).toLowerCase() : null;
  let apps;
  try {
    apps = await sdk.queryRecords('appmodule', {
      select: ['appmoduleid', 'appmoduleidunique', 'uniquename'],
      // Follow @odata.nextLink to completion so EVERY app is enumerated (no single-page truncation).
      // Not combined with `top` — Dataverse honors $top as a hard cap and omits @odata.nextLink, which
      // would silently return one page; the SDK rejects paginate+top for exactly that reason.
      paginate: true,
    });
  } catch (e) {
    // Fail-closed: cannot enumerate apps (a query error OR a pagination abort) → cannot verify safety
    // → report failure to caller.
    return { ok: false, error: String((e && e.message) || e) };
  }

  // Fail-closed on an EMPTY enumeration (defense-in-depth). `fetchAppsForPages` is only called when we
  // are about to UPDATE an existing page (see the caller), so the app being built already exists — a real
  // Dataverse env therefore ALWAYS returns ≥1 appmodule (system apps + this app). An empty list means the
  // paginated read returned no rows: refuse rather than fail OPEN (a zero-app scan would miss a shared
  // page). NOTE: the vendored `queryRecords` now THROWS a ConnectionError on a malformed paginated page (a
  // `value` that isn't an array, or a non-string `@odata.nextLink`) instead of silently coercing it to
  // empty — so a mid-pagination or first-page malformation is caught by the try/catch above (fail-closed at
  // the source). This empty check remains a belt-and-suspenders guard for any other way an empty list could
  // arise. See vendor-sdk-smoke.test.js "THROWS on a malformed page".
  if (!(apps && apps.length)) {
    return { ok: false, reason: 'apps-enumeration-empty', error: 'appmodule enumeration returned zero rows, which is impossible for a live environment (system apps always exist) — treating it as a failed/partial read and halting fail-closed rather than trusting an empty cross-app scan.' };
  }

  // Skip self up-front so a single-app env reads no sitemaps at all (minimal work).
  const others = (apps || []).filter(
    (a) => a && a.uniquename && String(a.uniquename).toLowerCase() !== self,
  );

  // The apps that were never published, which the list above cannot show. One small request, and in a single-app environment normally the only one beyond the
  // list itself. Fail-closed as a whole, before any sitemap is read: with no answer there is no knowing which apps the scan has not seen.
  const drafts = await draftOnlyApps(sdk, apps, self);
  if (!drafts.ok) return { ok: false, error: `could not list the apps that have never been published: ${drafts.reason}` };

  const byId     = new Map();
  const savedOnly = new Map();
  const unreadable = [];
  // `app` references `id` — once, whichever layer says so. A set of apps per id, kept as the arrays the callers print.
  const reference = (map, id, app) => {
    const arr = map.get(id) || [];
    if (!arr.includes(app)) arr.push(app);
    map.set(id, arr);
  };
  // Each app whose sitemap is to be joined to the saved layer below: a published app whose PUBLISHED sitemap read, and a never-published app whose sitemap component was
  // found — with the sitemap id and the page ids its PUBLISHED layer holds (a never-published app has none).
  const readable = [];

  for (const a of others) {
    // Reuse the discriminated fetchSitemap reader (DRY) — any ok:false goes into unreadable.
    const r = await fetchSitemap(sdk, a.uniquename, { includeSitemapId: true });
    if (!r.ok) {
      // Best-effort: record for caller to surface partial-coverage warning; do NOT throw.
      unreadable.push(a.uniquename);
      continue;
    }
    readable.push({ app: a.uniquename, sitemapId: r.sitemapId, ids: new Set(r.ids) });
    for (const id of r.ids) if (want.has(id)) reference(byId, id, a.uniquename);
  }

  // A never-published app's sitemap is the one its layer's sitemap component names — the read fetchSitemap makes for any layer key (componenttype 62). A read that FAILS,
  // or one that answers with a component it cannot name, proves nothing about the app: it is unreadable, and the caller halts. A read that SUCCEEDS and finds no sitemap
  // component does not show that the app has no navigation, though: the vendored SDK ties an app to its sitemap by NAME — it looks the sitemap up with `sitemapnameunique eq
  // '<the app's unique name>'` and takes one for the app only while that column holds the app's name, and ensureSitemapInSolution (sdk-build.js) resolves it the same way — so
  // such an app may hold a sitemap, and pages in it, that no component row links to it. The saved-layer read below shows whether it does (`unlinked`); an app with no sitemap of
  // its name has no navigation at all — one saved in the maker with only a name, say — so it holds no page, and one such app must not stop every page update in the environment.
  unreadable.push(...drafts.unreadable);
  const unlinked = [];
  for (const d of drafts.apps) {
    let components;
    try { components = await appComponentRows(sdk, d.layerKey, 62, { top: 1 }); } catch {
      unreadable.push(d.name);
      continue;
    }
    if (!components.length) {
      unlinked.push(d);
      continue;
    }
    const sitemapId = guidKey(components[0].objectid);
    if (!sitemapId) {
      unreadable.push(d.name);
      continue;
    }
    readable.push({ app: d.name, sitemapId, ids: new Set() });
  }

  // The SAVED layer of every readable app, in one request — which also shows the sitemap of an app that is linked to it by name only. A single-app environment with no draft app
  // has no other app, so it reads nothing here; one with a draft app that has no sitemap component reads it once, to rule such a sitemap out.
  if (readable.length || unlinked.length) {
    const saved = await savedSitemaps(sdk);
    // Fail-closed as a whole: with no answer there is nothing known about ANY app's draft, so none can be ruled out.
    if (!saved.ok) return { ok: false, error: `could not read the other apps' saved (unpublished) navigation: ${saved.reason}` };
    for (const d of unlinked) {
      const ids = saved.idsByName.get(String(d.name).toLowerCase());
      if (!ids) continue; // no sitemap carries the app's name: it has no navigation
      // More than one sitemap claiming the name leaves it unknown which is the app's, and either may hold the page.
      if (ids.size !== 1) {
        unreadable.push(d.name);
        continue;
      }
      readable.push({ app: d.name, sitemapId: [...ids][0], ids: new Set() });
    }
    for (const a of readable) {
      const layer = savedLayerIds(saved.byId.get(a.sitemapId));
      // Fail-closed per app, as the published read is: a saved layer that is missing, ambiguous or malformed cannot prove the app does not hold the page.
      if (!layer.ok) {
        if (!unreadable.includes(a.app)) unreadable.push(a.app);
        continue;
      }
      for (const id of layer.ids) {
        if (!want.has(id)) continue;
        reference(byId, id, a.app);
        if (!a.ids.has(id)) reference(savedOnly, id, a.app);
      }
    }
  }

  return { ok: true, byId, savedOnly, unreadable };
}

// The apps that have NEVER been published. The published `appmodule` list that fetchAppsForPages walks has no row for an app that is only saved in the maker, though its navigation is
// saved all the same. The same collection's RetrieveUnpublishedMultiple answers with the CURRENT layer of every app, drafts included, in one request (paged) however many there are:
//   { "value": [ { "appmoduleid": "…", "appmoduleidunique": "…", "uniquename": "contoso_draft", "componentstate": 1 }, … ] }
// An app that has a published row — matched by `appmoduleid`, which a pending edit leaves alone, unlike the layer key `appmoduleidunique` — is read through its published layer and skipped
// here, as is `self`. What is left exists only as a draft, and its one current layer (the only row, or the authored one: currentLayerRows) carries the layer key its components hang off.
// FAIL-CLOSED: a list that cannot be read, or a row with no id, is { ok:false } — what the rows leave out cannot be known; a draft app whose layer cannot be told is named in `unreadable`.
//   -> { ok:true, apps:[{ name, layerKey }], unreadable:[name] } | { ok:false, reason }
async function draftOnlyApps(sdk, published, self) {
  if (!sdk || !sdk.dataverse || typeof sdk.dataverse.get !== 'function') return { ok: false, reason: 'no Dataverse client to read it' };
  let rows;
  try {
    rows = await collectionRows(sdk.dataverse, '/appmodules/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()?$select=appmoduleid,appmoduleidunique,uniquename,componentstate', 'apps that have never been published');
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e) };
  }
  const havePublishedRow = new Set(published.map((app) => guidKey(app && app.appmoduleid)));
  const byApp = new Map();
  for (const row of rows) {
    const id = row && guidKey(row.appmoduleid);
    if (!id) return { ok: false, reason: 'a row came back with no appmoduleid' };
    if (havePublishedRow.has(id)) continue;
    if (!byApp.has(id)) byApp.set(id, []);
    byApp.get(id).push(row);
  }
  const apps = [];
  const unreadable = [];
  for (const [id, group] of byApp) {
    const named = group.find((row) => typeof row.uniquename === 'string' && row.uniquename.trim());
    const name = named ? named.uniquename : id;
    if (name.toLowerCase() === self) continue;
    const current = currentLayerRows(group);
    if (current.length !== 1 || !GUID_36.test(guidKey(current[0].appmoduleidunique))) unreadable.push(name);
    else apps.push({ name, layerKey: guidKey(current[0].appmoduleidunique) });
  }
  return { ok: true, apps, unreadable };
}

// Every sitemap's CURRENT layer in ONE request: { ok:true, byId: Map<sitemapid, row[]>, idsByName: Map<lower-cased sitemapnameunique, Set<sitemapid>> } or { ok:false, reason }. The rows
// of one sitemap are all those the platform returned for its id (currentSitemapRows picks the current one), grouped here so the caller reads each app's by its own id. `idsByName` is
// the same rows seen by the unique name the vendored SDK ties an app to its sitemap by (see fetchAppsForPages): a row looks like
//   { "sitemapid": "5111e0f2-…", "sitemapnameunique": "contoso_orders", "componentstate": 1, "sitemapxml": "<SiteMap>…" }
// and names are lower-cased because Dataverse compares them without regard to case.
// The read pages with @odata.nextLink like every other collection read in app-components.js (collectionRows): a repeated link, a failed page or a
// body that is no result set is a failure, never a shorter list.
async function savedSitemaps(sdk) {
  if (!sdk || !sdk.dataverse || typeof sdk.dataverse.get !== 'function') return { ok: false, reason: 'no Dataverse client to read it' };
  let rows;
  try {
    rows = await collectionRows(sdk.dataverse, '/sitemaps/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()?$select=sitemapid,sitemapxml,componentstate,sitemapnameunique', 'saved sitemaps');
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e) };
  }
  const byId = new Map();
  const idsByName = new Map();
  for (const row of rows) {
    const id = row && guidKey(row.sitemapid);
    if (!id) continue;
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id).push(row);
    const name = typeof row.sitemapnameunique === 'string' ? row.sitemapnameunique.trim().toLowerCase() : '';
    if (name) {
      if (!idsByName.has(name)) idsByName.set(name, new Set());
      idsByName.get(name).add(id);
    }
  }
  return { ok: true, byId, idsByName };
}

// The genpage ids in one app's saved layer — { ok:true, ids } — or { ok:false } when its rows cannot be trusted: none came back for its sitemap, they do
// not name one current row, or the current one has no XML or malformed XML (the same structural check a published sitemap must pass).
function savedLayerIds(rows) {
  let current;
  try { [current] = currentSitemapRows(rows || []); } catch { return { ok: false }; }
  const xml = current && current.sitemapxml;
  if (!xml || isMalformed(String(xml))) return { ok: false };
  return { ok: true, ids: sitemapGenPageIds(String(xml)) };
}

// This app's navigation as OWNERSHIP PROOF for page ids. `published` is a fetchSitemap result for the
// published app; when some candidate id is not already among its pages, the ids of the app's CURRENT
// sitemap are added too — the layer the app designer saves to, and the one a download reads. Both layers
// are this app's own navigation: a page saved into it belongs to this app before anyone publishes, and a
// download that wrote such a page must not be refused by the rebuild or kept by the teardown.
//
// Proof only. The destructive-removal gate and verify keep the published layer, which is what the
// approval preview and the published app show. The current layer is read only when it can prove
// something the published one did not, so an app whose pages are all published costs no extra read.
// Not being able to read it is not a failure: the published proof stands, so nothing is proven that
// was not before, and `currentNavigation: { ok:false, reason }` says why for the message that refuses
// or keeps an unproven page. Ids are lower-cased, as sitemapGenPageIds returns them.
//   -> published unchanged | { ...published, ids: <union>, currentNavigation: { ok:true, ids } | { ok:false, reason } }
async function navigationProof(sdk, appUnique, published, candidateIds = []) {
  if (!published || !published.ok) return published;
  const ids = new Set(published.ids.map((id) => String(id).toLowerCase()));
  if (![...candidateIds].some((id) => !ids.has(String(id).toLowerCase()))) return published;
  const current = await currentNavigation(sdk, appUnique);
  if (!current.ok) return { ...published, currentNavigation: current };
  for (const id of current.ids) ids.add(String(id).toLowerCase());
  return { ...published, ids: [...ids].sort(), currentNavigation: current };
}

// The genpage ids of the app's CURRENT sitemap, or { ok:false, reason }. appmodules by unique name gives the
// app id; RetrieveUnpublishedMultiple gives its current layer (currentAppLayer); fetchSitemap reads that
// layer's sitemap, exactly as download does.
async function currentNavigation(sdk, appUnique) {
  if (!sdk || !sdk.dataverse || typeof sdk.dataverse.get !== 'function') return { ok: false, reason: 'no Dataverse client to read it' };
  let appId;
  try {
    const rows = await sdk.queryRecords('appmodule', { select: ['appmoduleid'], filter: `uniquename eq '${odataLit(appUnique)}'`, top: 1 });
    appId = rows && rows[0] && rows[0].appmoduleid;
  } catch (e) {
    return { ok: false, reason: `appmodule-query-failed: ${(e && e.message) || e}` };
  }
  if (!appId) return { ok: false, reason: 'app-not-found' };
  const layer = await currentAppLayer(sdk.dataverse, String(appId).replace(/[{}]/g, ''));
  const r = await fetchSitemap(sdk, appUnique, { currentLayer: layer });
  return r.ok ? { ok: true, ids: r.ids } : { ok: false, reason: `${r.reason}${r.detail ? `: ${r.detail}` : ''}` };
}

module.exports = { liveNavEntries, appNavigationMatchesSitemap, sitemapGenPages, sitemapGenPageIds, decodeXmlEntities, fetchSitemap, navigationProof, fetchAppsForPages, XML_TAG, XML_ATTR };
