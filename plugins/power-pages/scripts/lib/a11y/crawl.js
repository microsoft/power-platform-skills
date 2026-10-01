'use strict';

// URL normalization and a bounded crawl queue for the accessibility audit.
//
// Mirrors test-site's crawl rules (same-origin only, fragments stripped, 25-page cap)
// so both skills see the same set of pages, plus exclusions that matter more when the
// crawler is a script rather than an agent: an agent notices it is about to click
// "Sign out", a script does not.

// Power Pages sign-out lives at /Account/Login/LogOff; SPAs often add their own.
// Visiting any of these mid-audit would silently drop the captured session and
// every later page would be audited as anonymous.
const SIGN_OUT_PATTERN = /(log-?off|log-?out|sign-?out)/i;

// Platform endpoints that are not pages: Web API, server logic, portal services,
// and static resources. Auditing them produces noise (raw JSON has no landmarks).
const NON_PAGE_PATH_PATTERN = /^\/(_api|_services|_resources|_layout|_portal)\//i;

const FILE_EXTENSION_PATTERN = /\.(pdf|zip|docx?|xlsx?|pptx?|csv|txt|json|xml|png|jpe?g|gif|svg|webp|ico|mp4|mp3|webm)$/i;

function normalizeUrl(href, base) {
  let url;
  try {
    url = new URL(href, base);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  url.hash = '';
  if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
    url.pathname = url.pathname.replace(/\/+$/, '');
  }
  return url.toString();
}

function exclusionReason(urlString, origin, extraExcludes = []) {
  const url = new URL(urlString);
  if (url.origin !== origin) return 'external';
  if (SIGN_OUT_PATTERN.test(url.pathname)) return 'sign-out';
  if (NON_PAGE_PATH_PATTERN.test(url.pathname)) return 'platform-endpoint';
  if (FILE_EXTENSION_PATTERN.test(url.pathname)) return 'file';
  const lower = urlString.toLowerCase();
  if (extraExcludes.some((s) => lower.includes(s))) return 'user-excluded';
  return null;
}

function routeOf(urlString) {
  const url = new URL(urlString);
  return `${url.pathname}${url.search}`;
}

class CrawlQueue {
  constructor({ origin, maxPages, exclude = [] }) {
    this.origin = origin;
    this.maxPages = maxPages;
    this.exclude = exclude;
    this.seen = new Set();
    this.pending = [];
    this.excluded = new Map();
    this.overflow = new Set();
  }

  // Returns true when the URL was queued. Excluded and over-cap URLs are recorded so
  // the report can say exactly what was not audited and why.
  add(href, base) {
    const normalized = normalizeUrl(href, base || this.origin);
    if (!normalized || this.seen.has(normalized)) return false;
    const reason = exclusionReason(normalized, this.origin, this.exclude);
    if (reason) {
      if (reason !== 'external') this.excluded.set(normalized, reason);
      return false;
    }
    if (this.seen.size >= this.maxPages) {
      this.overflow.add(normalized);
      return false;
    }
    this.seen.add(normalized);
    this.pending.push(normalized);
    return true;
  }

  // Routes the user asked for by name skip --exclude and the crawl cap: naming a route
  // is an explicit request to audit it. The built-in safety exclusions still apply —
  // visiting a sign-out URL would end a captured session for every later page, and
  // platform endpoints and files are not pages — and cross-origin is still refused.
  // A refused route is recorded in summary().excluded so the report shows it.
  addExplicit(href) {
    const normalized = normalizeUrl(href, this.origin);
    if (!normalized || this.seen.has(normalized)) return false;
    const reason = exclusionReason(normalized, this.origin);
    if (reason) {
      if (reason !== 'external') this.excluded.set(normalized, reason);
      return false;
    }
    this.seen.add(normalized);
    this.pending.push(normalized);
    return true;
  }

  next() {
    return this.pending.shift() || null;
  }

  summary() {
    return {
      queued: this.seen.size,
      notAuditedOverCap: [...this.overflow].map(routeOf),
      excluded: [...this.excluded].map(([url, reason]) => ({ route: routeOf(url), reason })),
    };
  }
}

module.exports = {
  CrawlQueue,
  exclusionReason,
  normalizeUrl,
  routeOf,
};
