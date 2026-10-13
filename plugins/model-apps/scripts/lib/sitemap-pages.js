'use strict';
// Pure + I/O readers of an app's generative pages FROM ITS SITEMAP XML (the MEMBERSHIP authority). A
// generative-page subarea stores its page id in the `GenPageId="<guid>"` attribute SPECIFICALLY (the SDK
// writes/reads exactly this — cds-maker-sdk.cjs parses /GenPageId="([0-9a-fA-F-]{36})"/, subarea attr set
// ["Entity","Url","DefaultDashboard","Page","GenPageId"]). The sitemap is the authoritative, complete record
// of which pages BELONG to the app (model-driven-app membership == sitemap presence). Membership is NOT an
// existence check — a page can exist env-wide yet not be in this app's sitemap (see genpage-cli.enumerateEnv).

const { odataLit } = require('./odata.js');
const { appComponentRows, currentAppLayer } = require('./app-components.js');
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
async function fetchSitemap(sdk, appUnique, { currentLayer } = {}) {
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
      // A projection can return { value: [{ componentstate: 0, sitemapxml: "old" },
      // { componentstate: 1, sitemapxml: "draft" }] }; only the authored row is current.
      sms = rows.length <= 1 ? rows : rows.filter((row) => row && Number(row.componentstate) === 1);
      if (sms.length > 1 || (rows.length > 1 && sms.length !== 1)) throw new Error('current sitemap read returned no single current row');
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

  return { ok: true, xml: String(xml), ids: sitemapGenPageIds(String(xml)) };
}

// Env-wide MEMBERSHIP scan (Imp5): which apps' sitemaps reference each id in `pageIds`. GROUNDED by a live
// Dataverse probe (test environment): a generative page has NO `appmodulecomponent` row —
// `appmodulecomponents?$filter=objectid eq <genPageId>` returns 0 rows. So a genpage's app membership lives
// ONLY inside the sitemap XML (`GenPageId="…"`), with NO direct genpage→apps join. The ONLY way to find a
// page shared across apps is to scan every OTHER app's sitemap XML for the id.
//
// Cost: O(number of apps) — one appmodule list + one sitemap read per OTHER app. `excludeAppUnique` skips the
// app being built (self can't share with itself), so a SINGLE-APP environment reads ZERO other sitemaps.
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
// and skipped (one bad app doesn't block the whole env — the caller warns about partial coverage).
async function fetchAppsForPages(sdk, pageIds, opts) {
  opts = opts || {};
  const want = new Set(Array.from(pageIds || []).map((x) => String(x).toLowerCase()));
  if (!want.size) return { ok: true, byId: new Map(), unreadable: [] };

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

  const byId     = new Map();
  const unreadable = [];

  for (const a of others) {
    // Reuse the discriminated fetchSitemap reader (DRY) — any ok:false goes into unreadable.
    const r = await fetchSitemap(sdk, a.uniquename);
    if (!r.ok) {
      // Best-effort: record for caller to surface partial-coverage warning; do NOT throw.
      unreadable.push(a.uniquename);
      continue;
    }
    for (const id of r.ids) {
      if (!want.has(id)) continue;
      const arr = byId.get(id) || [];
      arr.push(a.uniquename);
      byId.set(id, arr);
    }
  }

  return { ok: true, byId, unreadable };
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
