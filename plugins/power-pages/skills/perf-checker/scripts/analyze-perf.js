#!/usr/bin/env node

// Static performance analyzer for Power Pages projects. Walks the local code base
// and flags known performance anti-patterns, emitting a findings JSON envelope on
// stdout in the SAME shape the shared report pipeline consumes
// (scripts/build-review-data.js → scripts/render-review.js):
//
//   { status: "ok", findings: [ { id, tag, severity, title, location, details,
//                                  fix, autoFixAvailable, fixSkill, fixAction } ],
//     details: { kind: "kv", label, entries: [ { key, value } ] } }
//
// Usage:
//   node analyze-perf.js --projectRoot <path>     # defaults to cwd
//   node analyze-perf.js --review                 # (flag ignored here; SKILL.md branches)
//
// Exit codes: 0 on success (including "no issues"), 1 only on a fatal I/O error.
//
// Design: the pure rule functions (FetchXML, lists, webpage-as-API, Web API,
// client/rendering, settings, counts, and assets) take already-read strings/data
// and return findings WITHOUT ids or fs access, so they are unit-testable in
// isolation. analyze() does the directory walking, calls each rule function, then
// assigns sequential `perf-N` ids. This mirrors scan-site/transform-report.js
// (deterministic transform → findings) so the SKILL.md stays orchestration-only.
//
// Anti-patterns are grounded in Microsoft Learn:
//   - Site Checker performance: https://learn.microsoft.com/en-us/power-pages/admin/site-checker-performance
//   - Header/footer output caching: https://learn.microsoft.com/en-us/power-pages/configure/enable-header-footer-output-caching
//   - FetchXML with Liquid: https://learn.microsoft.com/en-us/power-pages/configure/liquid/liquid-operators (and fetchxml tag docs)

'use strict';

const fs = require('fs');
const path = require('path');

// loadSiteSettings is the single source of truth for parsing `.sitesetting.yml`
// files (quoting rules, boolean coercion). Reuse it rather than re-parsing YAML
// here — DRY per AGENTS.md ("reuse scripts/lib/powerpages-config.js anywhere a
// script reads .powerpages-site ... site-setting YAML").
const {
  loadSiteSettings,
  parseSimpleYaml,
} = require('../../../scripts/lib/powerpages-config');

// ── Thresholds (documented, overridable only by editing here) ───────────────
// count/top above this is treated as "retrieving too much data per page". Power
// Pages FetchXML best practice keeps page sizes small and pages via
// count + page/nextpagecookie rather than one large fetch.
const FETCHXML_MAX_COUNT = 100;
const FETCHXML_MAX_ATTRIBUTES = 20;
// Keep Web API collection pages in the same conservative range as FetchXML pages.
// Larger `$top` values can be legitimate for admin screens, but they are usually a
// sign that the UI should page, virtualize, or fetch on demand instead.
const WEBAPI_MAX_TOP = 100;
const WEBAPI_MAX_SELECT_COLUMNS = 20;
// Site Checker flags "Large number of web file records" at > 500 active web files
// (startup slowness). See site-checker-performance "Large number of web file records".
const WEB_FILE_WARN_THRESHOLD = 500;
// Site Checker flags web-role counts > 100 (per-request permission evaluation cost).
// See site-checker-performance "Number of web roles".
const WEB_ROLE_WARN_THRESHOLD = 100;
// Unoptimized media is a classic first-load regression. 1 MiB is a conservative
// "worth a look" bar for a single static asset shipped with the site.
const LARGE_ASSET_BYTES = 1024 * 1024;
// Cap the large-asset findings so a media-heavy project can't drown the report.
const LARGE_ASSET_MAX_FINDINGS = 20;
// setInterval delays below this (10s) that poll the portals Web API are treated as
// aggressive polling. The portals Web API "isn't optimized for third-party services
// or application integration" and every call consumes licensed user capacity, so a
// tight poll loop adds avoidable Dataverse load. Kept conservative (sub-10s) to stay
// high-signal. See: https://learn.microsoft.com/en-us/power-pages/configure/web-api-overview
const SHORT_POLL_INTERVAL_MS = 10000;

// Directories we never descend into for ANY scan.
const ALWAYS_SKIP_DIRS = new Set([
  'node_modules', '.git', '.github', '.vs', '.vscode', 'coverage', '.idea',
]);
// Additional directories skipped for SOURCE-content scans (FetchXML / Web API):
// these hold compiled/minified output — the actionable location is the source,
// and scanning minified bundles produces duplicate, un-fixable noise.
const BUILD_OUTPUT_DIRS = new Set([
  'dist', 'build', 'out', '.output', 'public-output', 'bin', 'obj', '.astro',
]);

// Extensions that may embed FetchXML / Liquid. Web-template Liquid source ships as
// `<name>.webtemplate.source.html`; entity list / form config can embed fetchxml in
// `.yml`. `.xml` covers standalone fetch snippets.
const FETCHXML_EXTS = new Set(['.html', '.htm', '.liquid', '.xml', '.yml', '.yaml']);
// Extensions that may contain Power Pages Web API (`/_api/`) calls.
const WEBAPI_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte', '.astro', '.html', '.htm',
]);
// Extensions whose files ship as runtime CSS the browser must parse before render.
// Only `.css` (not `.scss`/`.less`) — pre-processor @import is resolved at build time,
// whereas a runtime `@import` inside a served stylesheet blocks rendering.
const STYLE_EXTS = new Set(['.css']);
// Extensions that can carry a render-blocking <head> (declarative HTML pages). The
// client-script scan (sync XHR, document.write, jQuery sync ajax, short polling) reuses
// WEBAPI_EXTS — the same JS/HTML population that can call the Web API.
const HTML_EXTS = new Set(['.html', '.htm']);
// Media / binary asset extensions checked for oversized files.
const ASSET_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.tif', '.tiff', '.webp', '.svg', '.ico',
  '.mp4', '.webm', '.mov', '.avi', '.mkv', '.mp3', '.wav', '.ogg',
  '.pdf', '.woff', '.woff2', '.ttf', '.otf', '.eot',
]);

const SEVERITY = Object.freeze({
  CRITICAL: 'critical', HIGH: 'high', WARNING: 'warning',
  MEDIUM: 'medium', INFO: 'info', LOW: 'low',
});

function getArg(name, fallback = null) {
  const idx = process.argv.indexOf('--' + name);
  return idx !== -1 && idx + 1 < process.argv.length ? process.argv[idx + 1] : fallback;
}

// 1-based line number of a character offset — used to point findings at a precise
// `path:line` so the report and the agent can jump straight to the offending code.
function lineOf(content, index) {
  return content.slice(0, index).split(/\r?\n/).length;
}

// Rule-function output helper. Findings are id-less here; analyze() numbers them.
function finding(fields) {
  return {
    tag: fields.tag,
    severity: fields.severity,
    title: fields.title,
    location: fields.location || null,
    details: fields.details,
    fix: fields.fix,
    autoFixAvailable: Boolean(fields.autoFixAvailable),
    fixSkill: fields.fixSkill || null,
    // fixAction is a machine-readable descriptor the SKILL.md auto-fix loop uses to
    // apply a deterministic change (only set for autoFixAvailable findings).
    fixAction: fields.fixAction || null,
  };
}

// Tiny attribute parser for the XML/HTML fragments this analyzer inspects. Raw
// shapes handled:
//   <condition attribute="name" operator="like" value="%abc" />
//   <fetch count='50' returntotalrecordcount='true'>
// Unquoted values are accepted defensively because exported snippets are sometimes
// hand-edited; malformed tags simply produce fewer attributes rather than failing
// the whole scan.
function parseTagAttributes(tag) {
  const attrs = {};
  const attrRe = /([:\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s/>]+))/g;
  let match;
  while ((match = attrRe.exec(tag)) !== null) {
    attrs[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? '';
  }
  return attrs;
}

function safeDecodeURIComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

// ── FetchXML rules ──────────────────────────────────────────────────────────
// Parses `<fetch ...> ... </fetch>` blocks. Example raw shapes handled:
//   Liquid web template:
//     {% fetchxml products %}
//       <fetch count="200" returntotalrecordcount="true">
//         <entity name="cr123_product"><all-attributes /></entity>
//       </fetch>
//     {% endfetchxml %}
//   Aggregate count (GOOD — must NOT be flagged for paging/columns):
//     <fetch aggregate="true"><entity name="contact">
//       <attribute name="contactid" alias="c" aggregate="count"/></entity></fetch>
function scanFetchXmlContent(content, relPath) {
  const out = [];
  if (!content.includes('<fetch')) {
    // No fetch element means nothing to flag in this file.
    return out;
  }

  // Each fetch block, with its start offset for line numbers.
  const blockRe = /<fetch\b[\s\S]*?<\/fetch>/gi;
  let m;
  while ((m = blockRe.exec(content)) !== null) {
    const block = m[0];
    const at = `${relPath}:${lineOf(content, m.index)}`;

    const openTag = (block.match(/<fetch\b([^>]*)>/i) || [, ''])[1];
    const isAggregate = /\baggregate\s*=\s*["']?true/i.test(openTag);
    const hasAllAttributes = /all-attributes/i.test(block);
    const attributeMatches = [...block.matchAll(/<attribute\b[^>]*>/gi)];
    const hasAttribute = attributeMatches.length > 0;
    const countMatch = openTag.match(/\b(?:count|top)\s*=\s*["']?(\d+)/i);

    if (hasAllAttributes) {
      out.push(finding({
        tag: 'PERF-FETCHXML-ALLATTR',
        severity: SEVERITY.HIGH,
        title: 'FetchXML retrieves all attributes',
        location: at,
        details:
          'This FetchXML uses <all-attributes /> (or all-attributes="true"), so every ' +
          'column on the table is returned. That inflates the payload, slows the query, ' +
          'and can expose columns not meant for the portal audience.',
        fix:
          'Replace <all-attributes /> with explicit <attribute name="..."/> entries listing ' +
          'only the columns the page renders.',
        autoFixAvailable: false, // needs human knowledge of which columns are used
      }));
    } else if (!hasAttribute && !isAggregate) {
      out.push(finding({
        tag: 'PERF-FETCHXML-NO-COLUMNS',
        severity: SEVERITY.WARNING,
        title: 'FetchXML selects no explicit columns',
        location: at,
        details:
          'The <entity> declares no <attribute> elements, so the platform returns a default ' +
          'column set — more data than the page likely needs.',
        fix: 'Add explicit <attribute name="..."/> entries for only the columns you render.',
        autoFixAvailable: false,
      }));
    } else if (!isAggregate && attributeMatches.length > FETCHXML_MAX_ATTRIBUTES) {
      out.push(finding({
        tag: 'PERF-FETCHXML-MANY-COLUMNS',
        severity: SEVERITY.INFO,
        title: `FetchXML selects many columns (${attributeMatches.length})`,
        location: at,
        details:
          `This FetchXML explicitly selects ${attributeMatches.length} attributes (threshold ` +
          `${FETCHXML_MAX_ATTRIBUTES}). Wide projections increase payload size and query cost, ` +
          'even when they avoid all-attributes.',
        fix:
          'Review the page binding and remove attributes that are not rendered or needed for ' +
          'client logic.',
        autoFixAvailable: false,
      }));
    }

    // Aggregate queries return a single summary row, so paging / count limits do
    // not apply — skip both the no-paging and large-count checks for them.
    if (!isAggregate) {
      if (!/\b(?:count|top)\s*=/i.test(openTag)) {
        out.push(finding({
          tag: 'PERF-FETCHXML-NO-PAGING',
          severity: SEVERITY.WARNING,
          title: 'FetchXML has no page size (count)',
          location: at,
          details:
            'The <fetch> element sets no count/top, so it relies on the default page size and ' +
            'has no explicit upper bound. Unbounded list queries are a common cause of slow ' +
            'pages and portal timeouts on large tables.',
          fix:
            'Add a count (e.g. count="10") and page via the page attribute + nextpagecookie, or ' +
            'use aggregate="true" when you only need a count.',
          autoFixAvailable: false,
        }));
      } else if (countMatch && Number(countMatch[1]) > FETCHXML_MAX_COUNT) {
        out.push(finding({
          tag: 'PERF-FETCHXML-LARGE-COUNT',
          severity: SEVERITY.WARNING,
          title: `FetchXML page size is large (${countMatch[1]})`,
          location: at,
          details:
            `The <fetch> requests ${countMatch[1]} records in one page (threshold ` +
            `${FETCHXML_MAX_COUNT}). Large single-page fetches increase render time and risk ` +
            'timeouts; prefer smaller pages with pagination.',
          fix: `Reduce count to ${FETCHXML_MAX_COUNT} or fewer and paginate.`,
          autoFixAvailable: false,
        }));
      }

      // returntotalrecordcount="true" makes the platform compute the total matching
      // row count (capped at 5000) alongside the page. That extra counting work is
      // only worth paying when the UI actually shows a total, and it adds measurable
      // overhead on large tables. Raw shape: <fetch returntotalrecordcount="true" ...>
      // See FetchXML paging: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/fetchxml/page-results
      if (/\breturntotalrecordcount\s*=\s*["']?true/i.test(openTag)) {
        out.push(finding({
          tag: 'PERF-FETCHXML-TOTALRECORDCOUNT',
          severity: SEVERITY.INFO,
          title: 'FetchXML requests a total record count',
          location: at,
          details:
            'This <fetch> sets returntotalrecordcount="true", so the platform computes the total ' +
            'matching row count (capped at 5000) in addition to returning the page. That counting ' +
            'work is only worth paying when the page actually displays a total, and it adds ' +
            'overhead on large tables.',
          fix:
            'Remove returntotalrecordcount="true" unless the UI shows a total count; rely on paging ' +
            '(page + nextpagecookie) to load more records on demand.',
          autoFixAvailable: false,
        }));
      }
    }

    // Advanced FetchXML optimization switches are not universally beneficial.
    // Microsoft explicitly recommends using SQL query options only when support
    // advises it, and notes that incorrect hints can make a query slower. Surface
    // every use for review rather than assuming it is an optimization.
    // See: https://learn.microsoft.com/power-apps/developer/data-platform/fetchxml/optimize-performance#query-hints
    const queryHints = [];
    const optionsMatch = openTag.match(/\boptions\s*=\s*["']([^"']+)["']/i);
    if (optionsMatch) queryHints.push(`options="${optionsMatch[1]}"`);
    for (const [pattern, label] of [
      [/\blatematerialize\s*=\s*["']?true/i, 'latematerialize="true"'],
      [/\bno-lock\s*=\s*["']?true/i, 'no-lock="true"'],
      [/\buseraworderby\s*=\s*["']?true/i, 'useraworderby="true"'],
    ]) {
      if (pattern.test(openTag)) queryHints.push(label);
    }
    for (const hintMatch of block.matchAll(/<filter\b[^>]*\bhint\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
      queryHints.push(`filter hint="${hintMatch[1]}"`);
    }
    if (queryHints.length > 0) {
      out.push(finding({
        tag: 'PERF-FETCHXML-QUERY-HINT',
        severity: SEVERITY.WARNING,
        title: 'FetchXML uses advanced query hints',
        location: at,
        details:
          `This query uses ${queryHints.join(', ')}. Query hints are workload-specific; ` +
          'Microsoft recommends applying SQL query options only when technical support advises ' +
          'them because an incorrect hint can reduce performance.',
        fix:
          'Confirm the hint is documented for this exact slow query and supported by measured ' +
          'before/after timings. Otherwise remove it and let Dataverse optimize the query.',
        autoFixAvailable: false,
      }));
    }

    // Power Pages caches Dataverse query results. A request-time value such as
    // `"now" | date` inside the FetchXML makes the query text change on every
    // request, which is a common cache-busting technique. Explicit cache=false
    // variants are included defensively even though they are not standard
    // FetchXML attributes.
    const explicitNoCache =
      /\b(?:cache|usecache|enablecache)\s*=\s*["']?(?:false|0|no)\b/i.test(openTag);
    const requestTimeValue =
      /\{\{[\s\S]{0,200}(?:(?:["']now["']|\bnow\b)\s*\|\s*date)\b[\s\S]{0,200}\}\}/i.test(block) ||
      /{%-?[\s\S]{0,200}(?:(?:["']now["']|\bnow\b)\s*\|\s*date)\b[\s\S]{0,200}-?%}/i.test(block);
    if (explicitNoCache || requestTimeValue) {
      out.push(finding({
        tag: 'PERF-FETCHXML-CACHE-BYPASS',
        severity: SEVERITY.WARNING,
        title: 'FetchXML appears to bypass server-side cache',
        location: at,
        details:
          'This query contains an explicit no-cache setting or a request-time date value that ' +
          'changes the FetchXML text on every request. That prevents cache reuse and increases ' +
          'Dataverse load under traffic.',
        fix:
          'Remove cache-busting values unless the page has a measured real-time freshness ' +
          'requirement. Prefer normal Power Pages cache invalidation, the native Web API, or ' +
          'Server Logic for intentionally fresh data.',
        autoFixAvailable: false,
      }));
    }

    // Leading-wildcard LIKE filters (`%term`) are non-sargable in Dataverse-backed
    // searches: the engine cannot seek by the beginning of the string, so large
    // tables can degrade into broad scans. Raw shape:
    //   <condition attribute="name" operator="like" value="%contoso" />
    for (const conditionMatch of block.matchAll(/<condition\b[^>]*>/gi)) {
      const attrs = parseTagAttributes(conditionMatch[0]);
      const operator = String(attrs.operator || '').toLowerCase();
      const value = String(attrs.value || '').trim();
      if ((operator === 'like' || operator === 'not-like') && /^[%*]/.test(value)) {
        out.push(finding({
          tag: 'PERF-FETCHXML-LEADING-WILDCARD',
          severity: SEVERITY.WARNING,
          title: 'FetchXML uses a leading-wildcard string filter',
          location: `${relPath}:${lineOf(content, m.index + conditionMatch.index)}`,
          details:
            `This FetchXML condition uses operator="${operator}" with a value beginning with ` +
            `${JSON.stringify(value[0])}. Leading-wildcard searches cannot use a normal prefix ` +
            'seek and can become expensive on large Dataverse tables.',
          fix:
            'Prefer an exact/prefix filter, a constrained search experience, or a dedicated ' +
            'Dataverse Search-backed feature when users need contains-style search.',
          autoFixAvailable: false,
        }));
      }
    }

    // Ordering by a linked entity's column often requires a wider join/sort than
    // ordering by the primary entity. Choice-column ordering cannot be identified
    // without metadata, but related-column ordering is visible in FetchXML.
    const relatedOrderOffsets = new Set();
    for (const linkMatch of block.matchAll(/<link-entity\b[\s\S]*?<\/link-entity>/gi)) {
      const orderInLink = linkMatch[0].match(/<order\b[^>]*>/i);
      if (orderInLink) {
        relatedOrderOffsets.add(linkMatch.index + orderInLink.index);
      }
    }
    for (const orderMatch of block.matchAll(/<order\b[^>]*>/gi)) {
      const attrs = parseTagAttributes(orderMatch[0]);
      const isRelatedOrder =
        attrs.entityname ||
        attrs.alias ||
        relatedOrderOffsets.has(orderMatch.index);
      if (!isRelatedOrder) continue;
      out.push(finding({
        tag: 'PERF-FETCHXML-ORDER-RELATED',
        severity: SEVERITY.INFO,
        title: 'FetchXML orders by a related table column',
        location: `${relPath}:${lineOf(content, m.index + orderMatch.index)}`,
        details:
          'This FetchXML appears to sort on a linked/related table column. Related-column sorts ' +
          'can force extra join and sort work compared with sorting on the base table.',
        fix:
          'Verify the sort is required for the visible UI. If possible, sort on an indexed base ' +
          'table column, precompute the display order, or page before applying expensive sorts.',
        autoFixAvailable: false,
      }));
    }
  }

  // N+1: a fetch that executes inside a Liquid {% for %} loop runs once per
  // iteration. Walk for-open / for-close / fetch-start tokens in document order and
  // flag any `<fetch` seen while for-depth > 0. Counting `<fetch` (not the wrapping
  // `{% fetchxml %}`) avoids double-counting the same query.
  const tokenRe = /({%-?\s*for\b)|({%-?\s*endfor\b)|(<fetch\b)/gi;
  let depth = 0;
  let t;
  while ((t = tokenRe.exec(content)) !== null) {
    if (t[1]) depth += 1;
    else if (t[2]) depth = Math.max(0, depth - 1);
    else if (t[3] && depth > 0) {
      out.push(finding({
        tag: 'PERF-FETCHXML-IN-LOOP',
        severity: SEVERITY.HIGH,
        title: 'FetchXML query runs inside a Liquid loop',
        location: `${relPath}:${lineOf(content, t.index)}`,
        details:
          'A FetchXML query is placed inside a {% for %} loop, so it executes once per iteration ' +
          '(an N+1 query pattern). This multiplies database round-trips and is one of the biggest ' +
          'Liquid performance pitfalls.',
        fix:
          'Move the query outside the loop and fetch all rows at once (use <link-entity> to join ' +
          'related data in a single query), then iterate over the in-memory results.',
        autoFixAvailable: false,
      }));
    }
  }

  return out;
}

// ── Power Pages list pagination ──────────────────────────────────────────────
// List exports use one `*.list.yml` record with fields such as:
//   adx_entitylistid: <guid>
//   adx_name: Active cases
//   adx_pagesize: 10
// A missing, non-numeric, or non-positive page size leaves the list without an
// explicit pagination bound and can render a large result set at once.
function scanListContent(content, relPath) {
  const out = [];
  const pageSizeMatch = content.match(/^\s*(?:adx_)?pagesize\s*:\s*(.*?)\s*$/im);
  if (pageSizeMatch) {
    const pageSize = Number(String(pageSizeMatch[1]).replace(/^['"]|['"]$/g, '').trim());
    if (Number.isFinite(pageSize) && pageSize > 0) return out;
  }

  const nameMatch = content.match(/^\s*(?:adx_)?name\s*:\s*(.*?)\s*$/im);
  const idMatch = content.match(/^\s*(?:adx_)?entitylistid\s*:/im);
  const at = `${relPath}:${lineOf(content, pageSizeMatch?.index ?? idMatch?.index ?? 0)}`;
  const listName = nameMatch ? nameMatch[1].trim().replace(/^['"]|['"]$/g, '') : relPath;

  out.push(finding({
    tag: 'PERF-LIST-NO-PAGING',
    severity: SEVERITY.WARNING,
    title: 'Power Pages list has no valid page size',
    location: at,
    details:
      `${listName} does not define a positive pagesize/adx_pagesize value. Without an explicit ` +
      'page size, a list can request and render too many records in one response.',
    fix:
      'Set adx_pagesize/pagesize to a bounded value appropriate for the UI (commonly 10-50) ' +
      'and keep the list paging controls enabled.',
    autoFixAvailable: false,
  }));
  return out;
}

// ── Web template/page used as a data API ────────────────────────────────────
// A legacy Power Pages pattern exposes a headerless webpage/web template that
// runs FetchXML and writes JSON/XML, then treats that route as a custom API.
// Detect only data-query templates whose rendered body is structured data and
// has no normal HTML shell; this keeps the heuristic conservative.
function scanWebpageApiContent(content, relPath) {
  if (!/\.(?:webtemplate\.source|webpage\.copy)\.(?:html?|liquid)$/i.test(relPath)) {
    return [];
  }

  const hasDataQuery =
    /{%-?\s*fetchxml\b/i.test(content) ||
    /\bentities\s*\[/i.test(content) ||
    /\bentityview\b/i.test(content);
  if (!hasDataQuery) return [];

  const responseBody = content
    .replace(/{%-?\s*fetchxml\b[\s\S]*?{%-?\s*endfetchxml\s*-?%}/gi, '')
    .replace(/{%-?\s*comment\s*-?%}[\s\S]*?{%-?\s*endcomment\s*-?%}/gi, '');
  const hasHtmlShell =
    /<(?:html|body|main|header|footer|section|article|div|table|form|ul|ol|nav)\b/i
      .test(responseBody);
  const withoutLiquid = responseBody
    .replace(/{%[\s\S]*?%}/g, '')
    .replace(/{{[\s\S]*?}}/g, '"value"')
    .trim();
  const hasStructuredMime = /\b(?:application|text)\/(?:json|xml)\b/i.test(content);
  const looksJson =
    /^[\[{]/.test(withoutLiquid) &&
    /["'][^"'\r\n]+["']\s*:/.test(withoutLiquid);
  const looksXml = /^<\?xml\b/i.test(withoutLiquid);

  if (hasHtmlShell || (!hasStructuredMime && !looksJson && !looksXml)) return [];

  const marker =
    content.search(/\b(?:application|text)\/(?:json|xml)\b/i) >= 0
      ? content.search(/\b(?:application|text)\/(?:json|xml)\b/i)
      : content.search(/{%-?\s*fetchxml\b|\bentities\s*\[|\bentityview\b/i);
  return [finding({
    tag: 'PERF-WEBPAGE-AS-API',
    severity: SEVERITY.WARNING,
    title: 'Webpage/web template appears to be used as a data API',
    location: `${relPath}:${lineOf(content, Math.max(0, marker))}`,
    details:
      'This template queries Dataverse and emits JSON/XML without a normal HTML page shell. ' +
      'Using a webpage route as a custom API adds Liquid rendering overhead and can scale poorly.',
    fix:
      'Prefer the native Power Pages Web API for Dataverse CRUD, Server Logic for secure custom ' +
      'endpoints, or a dedicated backend. If this endpoint must remain, add strict paging, ' +
      'document its cache behavior, and verify table permissions.',
    autoFixAvailable: false,
  })];
}

// ── Web API rules ────────────────────────────────────────────────────────────
// Scans code for Power Pages Web API (`/_api/`) calls. Raw shapes handled:
//   fetch("/_api/cr123_products?$select=*&$filter=statecode eq 0")
//   fetch(`/_api/contacts?$filter=...&$orderby=createdon desc`)   // no $top / no $select
// The webapi-integration agent already enforces explicit $select + $top, so these
// fire on hand-written calls that drifted from that convention.
function scanWebApiContent(content, relPath) {
  const out = [];
  if (!content.includes('/_api/')) return out;

  // Capture quoted/backticked string literals that contain `/_api/`. The
  // backreference \1 matches the same quote char that opened the string; `\\.`
  // consumes escaped chars so an escaped quote inside doesn't end the match early.
  const urlRe = /(['"`])((?:\\.|(?!\1)[\s\S])*?\/_api\/(?:\\.|(?!\1)[\s\S])*?)\1/g;
  let m;
  while ((m = urlRe.exec(content)) !== null) {
    const url = m[2];
    const decodedUrl = safeDecodeURIComponent(url);
    const at = `${relPath}:${lineOf(content, m.index)}`;
    const hasSelect = /[?&]\$select=/i.test(url);
    const selectStar = /[?&]\$select=\*/i.test(url);
    // "collection query" heuristic: presence of any of these options implies a
    // multi-row query where an unbounded result set matters.
    const isCollectionQuery = /[?&]\$(filter|orderby|expand|apply)=/i.test(url);
    const hasAnyOption = /[?&]\$(filter|orderby|expand|apply|select|top|count)=/i.test(url);
    const topMatch = url.match(/[?&]\$top=(\d+)/i);
    const hasTop = Boolean(topMatch);
    const expandMatch = url.match(/[?&]\$expand=([^&]+)/i);
    const selectMatch = url.match(/[?&]\$select=([^&]+)/i);
    const filterMatch = decodedUrl.match(/[?&]\$filter=([^&]+)/i);
    const orderByMatch = decodedUrl.match(/[?&]\$orderby=([^&]+)/i);

    if (selectStar) {
      out.push(finding({
        tag: 'PERF-WEBAPI-SELECT-STAR',
        severity: SEVERITY.HIGH,
        title: 'Web API request selects all columns ($select=*)',
        location: at,
        details:
          'This /_api/ request uses $select=*, returning every column. Power Pages Web API best ' +
          'practice is to list only the columns the UI binds, to shrink the payload and avoid ' +
          'over-exposing data.',
        fix: 'Replace $select=* with an explicit $select=col1,col2,... list.',
        autoFixAvailable: false,
      }));
    } else if (hasAnyOption && !hasSelect) {
      out.push(finding({
        tag: 'PERF-WEBAPI-NO-SELECT',
        severity: SEVERITY.WARNING,
        title: 'Web API request has no $select',
        location: at,
        details:
          'This /_api/ request specifies query options but no $select, so every column is ' +
          'returned by default — more data than the page needs.',
        fix: 'Add an explicit $select=col1,col2,... listing only the columns you render.',
        autoFixAvailable: false,
      }));
    }

    if (isCollectionQuery && !hasTop) {
      out.push(finding({
        tag: 'PERF-WEBAPI-NO-TOP',
        severity: SEVERITY.WARNING,
        title: 'Web API collection query has no $top',
        location: at,
        details:
          'This /_api/ collection query has no $top, so the result set is unbounded. Large ' +
          'responses slow the page and can hit throttling limits.',
        fix: 'Add $top=<n> (and page with @odata.nextLink) to bound the result set.',
        autoFixAvailable: false,
      }));
    }

    if (topMatch && Number(topMatch[1]) > WEBAPI_MAX_TOP) {
      out.push(finding({
        tag: 'PERF-WEBAPI-LARGE-TOP',
        severity: SEVERITY.WARNING,
        title: `Web API page size is large ($top=${topMatch[1]})`,
        location: at,
        details:
          `This /_api/ request asks for ${topMatch[1]} rows in one response (threshold ` +
          `${WEBAPI_MAX_TOP}). Large single-response payloads slow the page and increase ` +
          'throttling risk under load.',
        fix:
          `Reduce $top to ${WEBAPI_MAX_TOP} or fewer, then page with @odata.nextLink or load ` +
          'additional rows on demand.',
        autoFixAvailable: false,
      }));
    }

    if (selectMatch && !selectStar) {
      const columns = selectMatch[1]
        .split(',')
        .map((column) => column.trim())
        .filter(Boolean);
      if (columns.length > WEBAPI_MAX_SELECT_COLUMNS) {
        out.push(finding({
          tag: 'PERF-WEBAPI-MANY-COLUMNS',
          severity: SEVERITY.INFO,
          title: `Web API request selects many columns (${columns.length})`,
          location: at,
          details:
            `This /_api/ request selects ${columns.length} columns (threshold ` +
            `${WEBAPI_MAX_SELECT_COLUMNS}). Wide projections increase payload size and parsing ` +
            'cost even when they avoid $select=*.',
          fix:
            'Review the UI binding and remove columns that are not rendered or needed for client logic.',
          autoFixAvailable: false,
        }));
      }
    }

    if (/[?&]\$count=true\b/i.test(url)) {
      out.push(finding({
        tag: 'PERF-WEBAPI-COUNT',
        severity: SEVERITY.INFO,
        title: 'Web API request asks for a total count',
        location: at,
        details:
          'This /_api/ request sets $count=true, so Dataverse computes the total matching row ' +
          'count in addition to returning data. That work is only worth paying when the UI ' +
          'actually displays a total.',
        fix:
          'Remove $count=true unless the page renders a total count; use paging state or ' +
          '@odata.nextLink for load-more experiences.',
        autoFixAvailable: false,
      }));
    }

    if (expandMatch && !/\(\s*\$select\s*=/i.test(expandMatch[1])) {
      out.push(finding({
        tag: 'PERF-WEBAPI-EXPAND-NO-SELECT',
        severity: SEVERITY.WARNING,
        title: 'Web API $expand has no nested $select',
        location: at,
        details:
          'This /_api/ request expands related records without a nested $select, so the related ' +
          'payload can include more columns than the page needs.',
        fix:
          'Add a nested projection such as $expand=relationship($select=col1,col2), or remove ' +
          '$expand and request only the related data the UI renders.',
        autoFixAvailable: false,
      }));
    }

    if (filterMatch && /\b(?:contains|endswith)\s*\(/i.test(filterMatch[1])) {
      out.push(finding({
        tag: 'PERF-WEBAPI-WILDCARD-FILTER',
        severity: SEVERITY.WARNING,
        title: 'Web API filter uses contains/endswith string search',
        location: at,
        details:
          'This /_api/ request filters with contains(...) or endswith(...), which is similar to ' +
          'a leading-wildcard search and can be expensive on large Dataverse tables.',
        fix:
          'Prefer exact/prefix filters, constrain the search scope, or use a search feature built ' +
          'for contains-style matching.',
        autoFixAvailable: false,
      }));
    }

    if (filterMatch && /\$\{[^}]*\b(?:Date|Date\.now|toISOString)\b[^}]*\}|\bnow\s*\(/i.test(filterMatch[1])) {
      out.push(finding({
        tag: 'PERF-WEBAPI-CACHE-BYPASS',
        severity: SEVERITY.WARNING,
        title: 'Web API filter appears to use request-time date values',
        location: at,
        details:
          'This /_api/ request appears to build a filter with the current date/time. A changing ' +
          'query string prevents cache reuse and increases Dataverse load under traffic.',
        fix:
          'Avoid request-time date filters unless the page truly needs real-time freshness; use ' +
          'coarser time buckets or normal cache invalidation where possible.',
        autoFixAvailable: false,
      }));
    }

    if (orderByMatch && /\//.test(orderByMatch[1])) {
      out.push(finding({
        tag: 'PERF-WEBAPI-ORDER-RELATED',
        severity: SEVERITY.INFO,
        title: 'Web API orders by a related table column',
        location: at,
        details:
          'This /_api/ request appears to sort by a related table property. Related-column sorts ' +
          'can require extra join and sort work compared with sorting on the base table.',
        fix:
          'Verify the sort is required. Prefer sorting by an indexed base table column, or ' +
          'precompute/simplify the display order for large result sets.',
        autoFixAvailable: false,
      }));
    }
  }

  // Conservative N+1: `items.map(async ...)` / `.forEach(async ...)` whose body
  // calls the Web API. Requiring the `async` callback keeps this high-signal —
  // a plain `.map` over already-fetched results is not matched.
  const loopRe = /\.(map|forEach|filter|reduce)\s*\(\s*async\b/gi;
  let l;
  while ((l = loopRe.exec(content)) !== null) {
    // Look ahead within the same statement region for a Web API call.
    const window = content.slice(l.index, l.index + 400);
    if (/\/_api\//.test(window)) {
      out.push(finding({
        tag: 'PERF-WEBAPI-IN-LOOP',
        severity: SEVERITY.INFO,
        title: 'Web API call inside an array iteration (possible N+1)',
        location: `${relPath}:${lineOf(content, l.index)}`,
        details:
          'An async .map/.forEach callback appears to call the Web API, which issues one request ' +
          'per element (an N+1 pattern). This can flood the server on larger arrays.',
        fix:
          'Fetch the data in a single query (use $filter with an in-list or $expand), or batch the ' +
          'requests, instead of one call per item.',
        autoFixAvailable: false,
      }));
    }
  }

  return out;
}

// ── Client-side script rules (blocking / anti-pattern JS) ────────────────────
// Scans standalone JS and inline <script> in HTML for patterns that block the main
// thread or hammer the Web API. Pure over a string so it unit-tests in isolation.
function scanClientScript(content, relPath) {
  const out = [];

  // Synchronous XMLHttpRequest: the 3rd argument to .open(method, url, async) being
  // `false` makes the request block the main thread until it returns. Deprecated and
  // a well-known jank source. Raw shapes handled:
  //   xhr.open("GET", url, false)
  //   req.open('POST', '/_api/x', false, user, pass)
  // The URL arg is matched as a single comma-free token, so a literal URL containing a
  // comma simply won't match (conservative — a miss, never a false positive).
  // See: https://developer.mozilla.org/en-US/docs/Web/API/XMLHttpRequest/open
  const syncXhrRe = /\.open\s*\(\s*(['"`])(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\1\s*,\s*[^,;)]+,\s*false\b/gi;
  let x;
  while ((x = syncXhrRe.exec(content)) !== null) {
    out.push(finding({
      tag: 'PERF-SYNC-XHR',
      severity: SEVERITY.HIGH,
      title: 'Synchronous XMLHttpRequest blocks the main thread',
      location: `${relPath}:${lineOf(content, x.index)}`,
      details:
        'This XMLHttpRequest.open(...) call passes async=false, so the browser freezes the UI ' +
        'thread until the request completes. Synchronous XHR is deprecated and a common cause of ' +
        'unresponsive pages, especially on slow connections.',
      fix:
        'Make the request asynchronous (async=true) and handle the result in a callback/Promise, ' +
        'or use fetch().',
      autoFixAvailable: false,
    }));
  }

  // jQuery synchronous AJAX: `async: false` inside a $.ajax(...) options object blocks
  // the UI thread the same way sync XHR does. Power Pages ships jQuery, so this pattern
  // is common in hand-written portal JS. Gate on an .ajax( call being present so a stray
  // `async: false` in an unrelated config object isn't flagged; \basync\b avoids matching
  // substrings like `isAsync: false`.
  if (/\.ajax\s*\(/.test(content)) {
    const syncAjaxRe = /(['"])?\basync\b\1?\s*:\s*false\b/gi;
    let a;
    while ((a = syncAjaxRe.exec(content)) !== null) {
      out.push(finding({
        tag: 'PERF-JQUERY-SYNC-AJAX',
        severity: SEVERITY.HIGH,
        title: 'Synchronous jQuery AJAX blocks the main thread',
        location: `${relPath}:${lineOf(content, a.index)}`,
        details:
          'A jQuery AJAX call sets async: false, which freezes the UI thread until the request ' +
          'returns. This is deprecated behavior and hurts responsiveness under load.',
        fix:
          'Remove async: false and use the done()/fail() callbacks (or a Promise) to handle the ' +
          'response asynchronously.',
        autoFixAvailable: false,
      }));
    }
  }

  // document.write() / document.writeln() forces a synchronous parse/reflow and, when
  // called after the initial parse, can wipe the document. Browsers penalize it and it
  // blocks rendering. See: https://web.dev/articles/no-document-write
  const docWriteRe = /\bdocument\s*\.\s*write(?:ln)?\s*\(/gi;
  let d;
  while ((d = docWriteRe.exec(content)) !== null) {
    out.push(finding({
      tag: 'PERF-DOCUMENT-WRITE',
      severity: SEVERITY.WARNING,
      title: 'document.write() blocks rendering',
      location: `${relPath}:${lineOf(content, d.index)}`,
      details:
        'document.write() (or writeln) forces a synchronous parser pause and reflow, and used after ' +
        'load it can blank the page. Browsers actively de-prioritize it.',
      fix:
        'Build the markup with DOM APIs (createElement/append) or a template render instead of ' +
        'document.write().',
      autoFixAvailable: false,
    }));
  }

  // Aggressive Web API polling: setInterval(..., <delay>) whose inline callback hits the
  // portals Web API (`/_api/`) with a delay below SHORT_POLL_INTERVAL_MS. Heuristic — only
  // the inline-callback case is caught (a named-function reference is left alone), so this
  // stays high-signal. Raw shape:
  //   setInterval(() => { fetch("/_api/tasks?$select=..."); }, 3000)
  const intervalRe = /setInterval\s*\(/gi;
  let s;
  while ((s = intervalRe.exec(content)) !== null) {
    // A 400-char window comfortably spans a small inline callback + its delay arg.
    const win = content.slice(s.index, s.index + 400);
    if (!/\/_api\//.test(win)) continue;
    // The delay is setInterval's LAST argument. Take the last `, <digits>)` in the
    // window — an inner call like foo(a, 5) sorts before the outer setInterval delay.
    const delayMatches = [...win.matchAll(/,\s*(\d{1,7})\s*\)/g)];
    if (delayMatches.length === 0) continue;
    const delayMs = Number(delayMatches[delayMatches.length - 1][1]);
    if (delayMs > 0 && delayMs < SHORT_POLL_INTERVAL_MS) {
      out.push(finding({
        tag: 'PERF-SHORT-POLL',
        severity: SEVERITY.WARNING,
        title: `Frequent Web API polling (every ${delayMs} ms)`,
        location: `${relPath}:${lineOf(content, s.index)}`,
        details:
          `A setInterval loop appears to call the portals Web API roughly every ${delayMs} ms ` +
          `(threshold ${SHORT_POLL_INTERVAL_MS} ms). The Web API isn't built for high-frequency ` +
          'programmatic polling — each call consumes licensed user capacity and adds Dataverse ' +
          'load, so a tight loop can degrade the site and approach service limits.',
        fix:
          'Increase the interval, poll only while the tab is visible, or switch to an on-demand ' +
          'refresh instead of a fixed short poll.',
        autoFixAvailable: false,
      }));
    }
  }

  return out;
}

// ── Render-blocking <head> script rule ───────────────────────────────────────
// Flags external <script src=...> tags inside <head> that lack async/defer/module,
// which block HTML parsing until the script downloads and executes. Only declarative
// HTML pages have a controllable <head>; code sites inject their own bundle.
// See: https://web.dev/articles/render-blocking-resources
function scanHtmlHead(content, relPath) {
  const out = [];
  const headMatch = content.match(/<head\b[^>]*>([\s\S]*?)<\/head>/i);
  if (!headMatch) return out;
  const headInner = headMatch[1];
  // Absolute offset where the inner head content begins, so findings point at the real
  // line in the file (the script regex below runs over headInner, not the whole file).
  const headStart = headMatch.index + headMatch[0].indexOf(headInner);

  const scriptRe = /<script\b[^>]*\bsrc\s*=[^>]*>/gi;
  let m;
  while ((m = scriptRe.exec(headInner)) !== null) {
    const tag = m[0];
    // async / defer make the download non-blocking; type="module" is deferred by spec.
    const nonBlocking = /\b(?:async|defer)\b/i.test(tag) || /\btype\s*=\s*(['"])module\1/i.test(tag);
    if (nonBlocking) continue;
    out.push(finding({
      tag: 'PERF-RENDER-BLOCKING-SCRIPT',
      severity: SEVERITY.WARNING,
      title: 'Render-blocking script in <head>',
      location: `${relPath}:${lineOf(content, headStart + m.index)}`,
      details:
        'A <script src="..."> in <head> has neither async nor defer, so the browser must download ' +
        'and execute it before it can continue parsing the page — delaying first paint.',
      fix:
        'Add defer (preserves execution order) or async to the tag, use type="module", or move the ' +
        'script to the end of <body>.',
      autoFixAvailable: false,
    }));
  }
  return out;
}

// ── Runtime CSS rule (render-blocking @import) ───────────────────────────────
// A runtime `@import` inside a served stylesheet is fetched only after the parent CSS
// parses, serializing stylesheet downloads and delaying render. Pre-processor sources
// (.scss/.less) are excluded upstream because their @import is resolved at build time.
// See: https://developer.mozilla.org/en-US/docs/Web/CSS/@import
function scanCssContent(content, relPath) {
  const out = [];
  // Blank out block comments while preserving length AND newlines (replace every
  // non-newline char with a space) so a commented-out @import isn't flagged but the
  // reported line numbers for real ones stay accurate.
  const masked = content.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));
  const importRe = /@import\b/gi;
  let m;
  while ((m = importRe.exec(masked)) !== null) {
    out.push(finding({
      tag: 'PERF-CSS-IMPORT',
      severity: SEVERITY.WARNING,
      title: 'CSS @import blocks parallel stylesheet download',
      location: `${relPath}:${lineOf(content, m.index)}`,
      details:
        'This stylesheet uses @import, which the browser can only fetch after it has downloaded and ' +
        'parsed the parent CSS. That serializes stylesheet loading and delays first render.',
      fix:
        'Replace @import with a <link rel="stylesheet"> in the page head, or bundle the imported CSS ' +
        'into one file at build time.',
      autoFixAvailable: false,
    }));
  }
  return out;
}

// ── Site-settings rules (output caching, sign-in tracking) ───────────────────
// settingsByName: Map<lowercaseName, { value, filePath, name, valueField? }>.
// siteSettingsSource is either a per-record directory, a classic aggregate file,
// or null when the project has no local site-setting metadata.
function scanSiteSettings(settingsByName, siteSettingsSource, siteSettingsLayout = 'per-record') {
  const out = [];
  if (!siteSettingsSource) return out; // nothing to check without site-setting metadata

  const isTrue = (v) => v === true || String(v).trim().toLowerCase() === 'true';
  const settingFixAction = (rec, name, value) => {
    // Classic PAC downloads store every setting in one root-level sitesetting.yml.
    // The parser records the exact adx_value line, so set-yaml-field remains a
    // precise, single-record edit instead of replacing the first matching boolean.
    if (rec && rec.valueField === 'adx_value') {
      return {
        type: 'set-yaml-field',
        field: 'adx_value',
        value,
        recordName: name,
      };
    }
    return { type: 'set-site-setting', name, value, valueType: 'boolean' };
  };

  // Header/Footer output caching. On NEW sites these default to true; on UPGRADED
  // sites they default to false (disabled) when absent — hence: present-and-false
  // is a confident warning; absent is an info-level nudge. Enabling the site
  // setting ALONE is not sufficient — the Header/Footer/Languages-Dropdown web
  // templates must also use the {% substitution %} tag or parts stop rendering.
  // See: https://learn.microsoft.com/en-us/power-pages/configure/enable-header-footer-output-caching
  for (const [label, name] of [['Header', 'Header/OutputCache/Enabled'], ['Footer', 'Footer/OutputCache/Enabled']]) {
    const rec = settingsByName.get(name.toLowerCase());
    const tag = label === 'Header' ? 'PERF-HEADER-OUTPUTCACHE' : 'PERF-FOOTER-OUTPUTCACHE';
    const substitutionCaveat =
      ` Note: enabling this setting alone is not enough — update the ${label} (and Languages ` +
      'Dropdown) web templates to use the {% substitution %} tag, or parts of the ' +
      `${label.toLowerCase()} will fail to render.`;

    if (rec && !isTrue(rec.value)) {
      out.push(finding({
        tag,
        severity: SEVERITY.WARNING,
        title: `${label} output caching is disabled`,
        location: rec.filePath,
        details:
          `${label} output caching is turned off (${name} = ${JSON.stringify(rec.value)}). The ` +
          `${label} web template is then parsed and rendered on every page load, which hurts ` +
          'performance under load.',
        fix: `Set ${name} to true.` + substitutionCaveat,
        autoFixAvailable: true,
        fixAction: settingFixAction(rec, name, 'true'),
      }));
    } else if (!rec) {
      // create-site-setting.js writes the per-record `.powerpages-site` format.
      // It must not be used against a classic aggregate sitesetting.yml because
      // that would create a second, incompatible metadata layout beside the site.
      const canAutoCreate = siteSettingsLayout !== 'classic';
      out.push(finding({
        tag,
        severity: SEVERITY.INFO,
        title: `${label} output caching is not explicitly enabled`,
        location: `${siteSettingsSource}`,
        details:
          `No ${name} site setting was found. New sites default this on, but upgraded sites ` +
          `default it off — parsing and rendering the ${label} on every page load.`,
        fix:
          (canAutoCreate
            ? `Create ${name} = true to guarantee caching.`
            : `Add ${name} with adx_value: true to the classic sitesetting.yml export.`) +
          substitutionCaveat,
        autoFixAvailable: canAutoCreate,
        fixAction: canAutoCreate
          ? { type: 'create-site-setting', name, value: 'true', valueType: 'boolean' }
          : null,
      }));
    }
  }

  // Sign-in tracking writes a record on every login — Site Checker flags it as a
  // performance issue. See site-checker-performance "Sign-in tracking enabled".
  const signin = settingsByName.get('authentication/logintrackingenabled');
  if (signin && isTrue(signin.value)) {
    out.push(finding({
      tag: 'PERF-SIGNIN-TRACKING',
      severity: SEVERITY.WARNING,
      title: 'Sign-in tracking is enabled',
      location: signin.filePath,
      details:
        'Authentication/LoginTrackingEnabled is true, so the platform writes a tracking record on ' +
        'every sign-in. Under load this adds avoidable write pressure.',
      fix: 'Set Authentication/LoginTrackingEnabled to false (or delete the site setting).',
      autoFixAvailable: true,
      fixAction: settingFixAction(
        signin,
        'Authentication/LoginTrackingEnabled',
        'false',
      ),
    }));
  }

  return out;
}

// ── Count-based rules (web files, web roles) ─────────────────────────────────
function evaluateCounts({ webFileCount, webRoleCount }) {
  const out = [];
  if (webFileCount > WEB_FILE_WARN_THRESHOLD) {
    out.push(finding({
      tag: 'PERF-WEBFILE-COUNT',
      severity: SEVERITY.WARNING,
      title: `Large number of web files (${webFileCount})`,
      details:
        `The site has ${webFileCount} web files (threshold ${WEB_FILE_WARN_THRESHOLD}). A large ` +
        'web-file table slows website startup.',
      fix:
        'Move static content (CSS/JS/images) to Azure Blob Storage or a CDN, or reparent files off ' +
        'the home page so they load on demand.',
      autoFixAvailable: false,
    }));
  }
  if (webRoleCount > WEB_ROLE_WARN_THRESHOLD) {
    out.push(finding({
      tag: 'PERF-WEBROLE-COUNT',
      severity: SEVERITY.WARNING,
      title: `Large number of web roles (${webRoleCount})`,
      details:
        `The site has ${webRoleCount} web roles (threshold ${WEB_ROLE_WARN_THRESHOLD}). Evaluating ` +
        'many roles per request affects the performance of all pages.',
      fix: 'Consolidate overlapping web roles; keep the number of distinct permission combinations small.',
      autoFixAvailable: false,
    }));
  }
  return out;
}

// ── Large static asset rule ──────────────────────────────────────────────────
// assets: [{ relPath, size }]. Returns at most LARGE_ASSET_MAX_FINDINGS, largest first.
function scanLargeAssets(assets) {
  return assets
    .filter((a) => a.size > LARGE_ASSET_BYTES)
    .sort((a, b) => b.size - a.size)
    .slice(0, LARGE_ASSET_MAX_FINDINGS)
    .map((a) => finding({
      tag: 'PERF-LARGE-STATIC-ASSET',
      severity: SEVERITY.INFO,
      title: `Large static asset (${(a.size / (1024 * 1024)).toFixed(1)} MB)`,
      location: a.relPath,
      details:
        `${a.relPath} is ${(a.size / (1024 * 1024)).toFixed(1)} MB. Large unoptimized assets slow ` +
        'first load, especially on mobile connections.',
      fix:
        'Compress/resize the asset, serve modern formats (WebP/AVIF), or move it to a CDN and ' +
        'reference it by URL.',
      autoFixAvailable: false,
    }));
}

// ── Directory walking ────────────────────────────────────────────────────────
// Recursively lists files under root. `skipBuild` also prunes compiled-output dirs.
function walkFiles(root, { skipBuild } = { skipBuild: true }) {
  const results = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable dir (permissions / race) — skip rather than crash
    }
    for (const ent of entries) {
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ALWAYS_SKIP_DIRS.has(ent.name)) continue;
        if (skipBuild && BUILD_OUTPUT_DIRS.has(ent.name)) continue;
        stack.push(abs);
      } else if (ent.isFile()) {
        results.push(abs);
      }
    }
  }
  return results;
}

function readSafe(absPath) {
  try {
    return fs.readFileSync(absPath, 'utf8');
  } catch {
    return null; // binary/locked/oversized — the rule scans simply skip it
  }
}

// Parse the classic PAC download list shape, where all records of one table are
// stored in a single root-level YAML file, for example:
//   - adx_name: Header/OutputCache/Enabled
//     adx_sitesettingid: <guid>
//     adx_value: false
// A new record starts only at column zero (`- `), so indented block-scalar or
// nested-list lines remain part of their current record. Each record is then
// delegated to the shared parseSimpleYaml helper so scalar coercion and quoting
// stay consistent with the per-record `.powerpages-site` loader.
function parseClassicYamlRecordList(content, filePath) {
  const lines = content.split(/\r?\n/);
  const records = [];
  let current = null;

  const flush = () => {
    if (!current) return;

    const normalized = current.lines
      .map((line, index) => (index === 0 ? line.replace(/^-\s+/, '') : line))
      .join('\n');

    try {
      const parsed = parseSimpleYaml(normalized, filePath);
      const lineByKey = {};
      current.lines.forEach((rawLine, offset) => {
        const line = rawLine.trim().replace(/^-\s+/, '');
        const separatorIndex = line.indexOf(':');
        if (separatorIndex <= 0) return;
        const key = line.slice(0, separatorIndex).trim();
        if (!(key in lineByKey)) {
          lineByKey[key] = current.startLine + offset;
        }
      });
      records.push({ ...parsed, lineByKey });
    } catch {
      // One malformed exported record must not abort the full performance scan.
      // Valid neighboring records remain useful for settings and volume checks.
    }
  };

  lines.forEach((line, index) => {
    if (/^-\s+/.test(line)) {
      flush();
      current = { startLine: index + 1, lines: [line] };
    } else if (current) {
      current.lines.push(line);
    }
  });
  flush();

  return records;
}

// Load site settings into Map<lowercaseName, {value, filePath, name}> from either
// the per-record `.powerpages-site/site-settings/*.sitesetting.yml` layout or the
// classic root-level `sitesetting.yml` list. `rel` prevents machine-specific
// absolute paths from leaking into the shared HTML report.
function loadSiteSettingsMap(projectRoot, rel) {
  const map = new Map();

  const dir = path.join(projectRoot, '.powerpages-site', 'site-settings');
  if (fs.existsSync(dir)) {
    const relDir = rel(dir);
    let records = [];
    try {
      records = loadSiteSettings(dir);
    } catch {
      return {
        map,
        source: relDir,
        layout: 'per-record',
      }; // malformed YAML shouldn't abort the whole analysis
    }
    for (const r of records) {
      if (typeof r.name === 'string') {
        map.set(r.name.toLowerCase(), {
          value: r.value,
          filePath: rel(r.filePath),
          name: r.name,
        });
      }
    }
    return { map, source: relDir, layout: 'per-record' };
  }

  const classicFile = path.join(projectRoot, 'sitesetting.yml');
  if (fs.existsSync(classicFile)) {
    const relFile = rel(classicFile);
    const content = readSafe(classicFile);
    const records = content == null
      ? []
      : parseClassicYamlRecordList(content, classicFile);

    for (const r of records) {
      if (typeof r.adx_name !== 'string') continue;
      const valueLine = r.lineByKey.adx_value || r.lineByKey.adx_name;
      map.set(r.adx_name.toLowerCase(), {
        value: r.adx_value,
        filePath: valueLine ? `${relFile}:${valueLine}` : relFile,
        name: r.adx_name,
        valueField: 'adx_value',
      });
    }
    return { map, source: relFile, layout: 'classic' };
  }

  return { map, source: null, layout: null };
}

// Count records across both Power Pages export layouts. Enhanced/code-site
// metadata uses one descriptor file per record; classic downloads keep web-file
// descriptors in a root folder and web roles in one aggregate `webrole.yml`.
function countPortalRecords(
  projectRoot,
  { subDir, suffix, aggregateFile = null, aggregateIdField = null },
) {
  for (const dir of [
    path.join(projectRoot, '.powerpages-site', subDir),
    path.join(projectRoot, subDir),
  ]) {
    if (!fs.existsSync(dir)) continue;
    return walkFiles(dir, { skipBuild: false })
      .filter((f) => f.toLowerCase().endsWith(suffix))
      .length;
  }

  if (!aggregateFile || !aggregateIdField) return 0;
  const filePath = path.join(projectRoot, aggregateFile);
  const content = readSafe(filePath);
  if (content == null) return 0;
  return parseClassicYamlRecordList(content, filePath)
    .filter((record) => record[aggregateIdField] != null)
    .length;
}

function analyze(projectRoot) {
  const root = path.resolve(projectRoot || process.cwd());
  const findings = [];

  // Single directory walk for content scans (source only), reused for FetchXML,
  // Web API, and deprecated-tracking checks.
  const contentFiles = walkFiles(root, { skipBuild: true });
  const rel = (abs) => path.relative(root, abs).split(path.sep).join('/');

  let fetchxmlFilesScanned = 0;
  let webapiFilesScanned = 0;
  let cssFilesScanned = 0;
  let listFilesScanned = 0;

  for (const abs of contentFiles) {
    const ext = path.extname(abs).toLowerCase();
    const base = path.basename(abs).toLowerCase();
    const wantsFetch = FETCHXML_EXTS.has(ext);
    const wantsWebapi = WEBAPI_EXTS.has(ext);
    const wantsStyle = STYLE_EXTS.has(ext);
    const wantsHtml = HTML_EXTS.has(ext);
    const wantsList = /\.list\.ya?ml$/i.test(base) || base === 'list.yml' || base === 'list.yaml';
    if (!wantsFetch && !wantsWebapi && !wantsStyle && !wantsList) continue;

    const content = readSafe(abs);
    if (content == null) continue;
    const relPath = rel(abs);

    if (wantsFetch) {
      fetchxmlFilesScanned += 1;
      for (const f of scanFetchXmlContent(content, relPath)) findings.push(f);
    }
    if (wantsList) {
      listFilesScanned += 1;
      for (const f of scanListContent(content, relPath)) findings.push(f);
    }
    if (wantsWebapi) {
      webapiFilesScanned += 1;
      for (const f of scanWebApiContent(content, relPath)) findings.push(f);
      // Same JS/HTML population also gets the blocking-script scan (sync XHR,
      // document.write, jQuery sync ajax, short-interval Web API polling).
      for (const f of scanClientScript(content, relPath)) findings.push(f);
    }
    if (wantsHtml) {
      // Render-blocking <head> scripts — declarative HTML pages only.
      for (const f of scanHtmlHead(content, relPath)) findings.push(f);
      // Headerless JSON/XML templates backed by FetchXML are a legacy custom-API
      // pattern; keep this separate from the native `/_api/` rules above.
      for (const f of scanWebpageApiContent(content, relPath)) findings.push(f);
    }
    if (wantsStyle) {
      cssFilesScanned += 1;
      for (const f of scanCssContent(content, relPath)) findings.push(f);
    }

    // Deprecated page/file tracking (retired on 9.3.4.x+ but still a Site Checker
    // finding). Raw YAML shape: `adx_enabletracking: true` (or `enabletracking: true`).
    if ((ext === '.yml' || ext === '.yaml') && /(?:adx_)?enabletracking\s*:\s*(?:true|"true"|'true')/i.test(content)) {
      const isWebFile = base.includes('webfile') || relPath.includes('/web-files/');
      const isWebPage = base.includes('webpage') || relPath.includes('/web-pages/');
      if (isWebFile || isWebPage) {
        const which = isWebFile ? 'web file' : 'web page';
        const tag = isWebFile ? 'PERF-WEBFILE-TRACKING' : 'PERF-WEBPAGE-TRACKING';
        const trackMatch = content.match(/(?:adx_)?enabletracking\s*:/i);
        findings.push(finding({
          tag,
          severity: SEVERITY.INFO,
          title: `Deprecated page tracking enabled on a ${which}`,
          location: `${relPath}:${trackMatch ? lineOf(content, trackMatch.index) : 1}`,
          details:
            `This ${which} has Enable Tracking (deprecated) turned on, which Site Checker flags as ` +
            'a performance risk. The feature is retired on portal versions 9.3.4.x and later.',
          fix: `Set enabletracking to false on this ${which}.`,
          autoFixAvailable: true,
          fixAction: { type: 'set-yaml-field', field: 'adx_enabletracking', value: 'false' },
        }));
      }
    }
  }

  // Site settings (output caching, sign-in tracking).
  const {
    map: settingsMap,
    source: settingsSource,
    layout: settingsLayout,
  } = loadSiteSettingsMap(root, rel);
  for (const f of scanSiteSettings(settingsMap, settingsSource, settingsLayout)) findings.push(f);

  // Count-based rules.
  const webFileCount = countPortalRecords(root, {
    subDir: 'web-files',
    suffix: '.webfile.yml',
  });
  const webRoleCount = countPortalRecords(root, {
    subDir: 'web-roles',
    suffix: '.webrole.yml',
    aggregateFile: 'webrole.yml',
    aggregateIdField: 'adx_webroleid',
  });
  for (const f of evaluateCounts({ webFileCount, webRoleCount })) findings.push(f);

  // Large static assets (scan source dirs only; compiled copies are not actionable).
  const assets = [];
  for (const abs of contentFiles) {
    if (!ASSET_EXTS.has(path.extname(abs).toLowerCase())) continue;
    let size = 0;
    try { size = fs.statSync(abs).size; } catch { continue; }
    if (size > LARGE_ASSET_BYTES) assets.push({ relPath: rel(abs), size });
  }
  for (const f of scanLargeAssets(assets)) findings.push(f);

  // Assign stable sequential ids AFTER all rules run.
  findings.forEach((f, i) => { f.id = `perf-${i + 1}`; });

  const severityCounts = findings.reduce((acc, f) => {
    acc[f.severity] = (acc[f.severity] || 0) + 1;
    return acc;
  }, {});

  const details = {
    kind: 'kv',
    label: 'Scan coverage',
    entries: [
      { key: 'FetchXML/Liquid files scanned', value: String(fetchxmlFilesScanned) },
      { key: 'Power Pages list files scanned', value: String(listFilesScanned) },
      { key: 'Web API / script files scanned', value: String(webapiFilesScanned) },
      { key: 'CSS files scanned', value: String(cssFilesScanned) },
      { key: 'Web files', value: String(webFileCount) },
      { key: 'Web roles', value: String(webRoleCount) },
      { key: 'Total findings', value: String(findings.length) },
    ],
  };

  if (findings.length === 0) {
    findings.push({
      id: 'perf-1',
      tag: 'PERF-NONE',
      severity: SEVERITY.INFO,
      title: 'No performance anti-patterns detected',
      location: null,
      details: 'The analyzer found no known Power Pages performance anti-patterns in the scanned files.',
      fix: null,
      autoFixAvailable: false,
      fixSkill: null,
      fixAction: null,
    });
  }

  return { status: 'ok', findings, details, severityCounts };
}

function main() {
  const projectRoot = getArg('projectRoot', process.cwd());
  let result;
  try {
    result = analyze(projectRoot);
  } catch (err) {
    process.stderr.write(`analyze-perf.js failed: ${err.message}\n`);
    process.exit(1);
  }
  process.stdout.write(JSON.stringify(result) + '\n');
}

// CLI guard so the pure functions can be required from tests without executing main.
if (require.main === module) {
  main();
}

module.exports = {
  analyze,
  scanFetchXmlContent,
  scanListContent,
  scanWebpageApiContent,
  scanWebApiContent,
  scanClientScript,
  scanHtmlHead,
  scanCssContent,
  scanSiteSettings,
  evaluateCounts,
  scanLargeAssets,
  // thresholds exported so tests assert against the real constants, not copies.
  FETCHXML_MAX_COUNT,
  FETCHXML_MAX_ATTRIBUTES,
  WEB_FILE_WARN_THRESHOLD,
  WEB_ROLE_WARN_THRESHOLD,
  LARGE_ASSET_BYTES,
  SHORT_POLL_INTERVAL_MS,
  WEBAPI_MAX_TOP,
  WEBAPI_MAX_SELECT_COLUMNS,
};
