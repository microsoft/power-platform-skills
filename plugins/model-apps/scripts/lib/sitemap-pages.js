'use strict';
// Pure + I/O readers of an app's generative pages FROM ITS SITEMAP XML (the MEMBERSHIP authority). A
// generative-page subarea stores its page id in the `GenPageId="<guid>"` attribute SPECIFICALLY (the SDK
// writes/reads exactly this — cds-maker-sdk.cjs parses /GenPageId="([0-9a-fA-F-]{36})"/, subarea attr set
// ["Entity","Url","DefaultDashboard","Page","GenPageId"]). The sitemap is the authoritative, complete record
// of which pages BELONG to the app (model-driven-app membership == sitemap presence). Membership is NOT an
// existence check — a page can exist env-wide yet not be in this app's sitemap (see genpage-cli.enumerateEnv).

const { odataLit } = require('./odata.js');

// Match a <SubArea …> START TAG carrying a GenPageId, capturing the id and (optionally) the Title.
// Attributes are order-independent, so scan each start tag and pull GenPageId + Title separately.
const SUBAREA_RE   = /<SubArea\b[^>]*>/gi;
const GENPAGE_ATTR = /\bGenPageId="([0-9a-fA-F-]{36})"/i;
const TITLE_ATTR   = /\bTitle="([^"]*)"/i;
const DESC_ATTR    = /\bDescription="([^"]*)"/i;

// Exact 36-char GUID pattern used for structural validation in `isMalformed`.
const GUID_36 = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

// Decode the 5 predefined XML entities so a sitemap Title like "Orders &amp; Overview" becomes a usable page
// NAME ("Orders & Overview") on the download round-trip. Sitemap free-text is XML-ESCAPED by the SDK's
// safe-DOM factory, so we must reverse it before treating a Title as a name.
// &amp; is decoded LAST so "a &amp;lt; b" → "a &lt; b" (not "a < b" — double-encoded sequences are rare but
// ordering matters; only a single decode pass is done intentionally).
function decodeXmlEntities(s) {
  return String(s)
    .replace(/&lt;/g,   '<')
    .replace(/&gt;/g,   '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g,  "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g,  '&'); // &amp; LAST so "&amp;lt;" → "&lt;" not "<"
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
async function fetchSitemap(sdk, appUnique) {
  let apps;
  try {
    apps = await sdk.queryRecords('appmodule', {
      select: ['appmoduleid', 'appmoduleidunique'],
      filter: `uniquename eq '${odataLit(appUnique)}'`,
      top:    1,
    });
  } catch (e) {
    return { ok: false, reason: 'appmodule-query-failed', detail: String((e && e.message) || e) };
  }
  const app = apps && apps[0];
  if (!app) return { ok: false, reason: 'app-not-found' };

  let comps;
  try {
    // _appmoduleidunique_value is a lookup GUID — it must be UNQUOTED in the OData filter (quoting it 400s
    // because the SDK/Dataverse expects a raw GUID literal for navigation property filters).
    comps = await sdk.queryRecords('appmodulecomponent', {
      select: ['objectid', 'componenttype'],
      filter: `_appmoduleidunique_value eq ${app.appmoduleidunique} and componenttype eq 62`,
      top:    1,
    });
  } catch (e) {
    return { ok: false, reason: 'sitemap-component-query-failed', detail: String((e && e.message) || e) };
  }
  const smId = comps && comps[0] && comps[0].objectid;
  if (!smId) return { ok: false, reason: 'sitemap-component-not-found' };

  let sms;
  try {
    sms = await sdk.queryRecords('sitemap', {
      select: ['sitemapxml'],
      filter: `sitemapid eq ${smId}`,
      top:    1,
    });
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

// Dataverse's maximum server-side page size. The vendored queryRecords issues one GET and cannot follow
// `@odata.nextLink`, so an appmodule list of this many rows may be TRUNCATED — fetchAppsForPages treats a
// full page as a coverage failure and fails CLOSED (see its doc + the cap check).
const APPMODULE_PAGE_CAP = 5000;

// Env-wide MEMBERSHIP scan (Imp5): which apps' sitemaps reference each id in `pageIds`. GROUNDED by a live
// Dataverse probe (aurorabapenv03468): a generative page has NO `appmodulecomponent` row —
// `appmodulecomponents?$filter=objectid eq <genPageId>` returns 0 rows. So a genpage's app membership lives
// ONLY inside the sitemap XML (`GenPageId="…"`), with NO direct genpage→apps join. The ONLY way to find a
// page shared across apps is to scan every OTHER app's sitemap XML for the id.
//
// Cost: O(number of apps) — one appmodule list + one sitemap read per OTHER app. `excludeAppUnique` skips the
// app being built (self can't share with itself), so a SINGLE-APP environment reads ZERO other sitemaps.
//
// PAGINATION / FAIL-CLOSED AT THE CAP: `$top:APPMODULE_PAGE_CAP` requests one over-provisioned page. The
// vendored SDK's queryRecords issues a SINGLE GET and does NOT follow `@odata.nextLink` (it exposes no
// paginating query), so a result AT the cap means the list may be TRUNCATED and the rest is invisible.
// Because an unlisted app could be the very one that shares a page we are about to UPDATE, a full page is
// treated as a coverage failure → `{ ok:false, reason:'apps-truncated' }`, so this safety scan fails
// CLOSED (the caller HALTs) instead of fail OPEN by silently missing apps. (A tenant with EXACTLY
// APPMODULE_PAGE_CAP apps false-positives here — acceptably rare and still safe. Replace with cursor
// pagination if the SDK ever exposes @odata.nextLink.)
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
      top:    APPMODULE_PAGE_CAP, // one over-provisioned page — see the FAIL-CLOSED-AT-THE-CAP note above
    });
  } catch (e) {
    // Fail-closed: cannot enumerate apps → cannot verify safety → report failure to caller.
    return { ok: false, error: String((e && e.message) || e) };
  }

  // Fail CLOSED on a full (possibly-truncated) page: queryRecords cannot page `@odata.nextLink`, so a
  // result AT the cap may omit apps we can't see — and an unseen app could share the page we are about to
  // UPDATE. Refuse rather than fail OPEN by scanning an incomplete list. See the PAGINATION note above.
  if ((apps || []).length >= APPMODULE_PAGE_CAP) {
    return {
      ok: false,
      reason: 'apps-truncated',
      error: `appmodule enumeration returned the full ${APPMODULE_PAGE_CAP}-row page cap; the vendored SDK cannot paginate @odata.nextLink, so cross-app page-sharing cannot be verified for every app in this environment. Halting fail-closed to avoid overwriting a page shared by an unlisted app.`,
    };
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

module.exports = { sitemapGenPages, sitemapGenPageIds, decodeXmlEntities, fetchSitemap, fetchAppsForPages };
