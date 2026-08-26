# Performance Reference

Rule catalog for `scripts/analyze-perf.js` — the deterministic analyzer behind `/power-pages:perf-checker`. Use this when explaining a finding, deciding whether an auto-fix is safe, or extending the analyzer.

> **Terminology**: the analyzer emits **findings**. Each finding carries a stable `tag` (e.g., `PERF-FETCHXML-ALLATTR`), a `severity`, a plain-language `title`/`details`/`fix`, and — for the subset that is safely automatable — `autoFixAvailable: true` plus a machine-readable `fixAction`.

## Table of contents

- [Finding envelope](#finding-envelope)
- [Severity scale](#severity-scale)
- [Rule catalog](#rule-catalog)
  - [FetchXML rules](#fetchxml-rules)
  - [List & webpage API rules](#list--webpage-api-rules)
  - [Web API rules](#web-api-rules)
  - [Client-side script rules](#client-side-script-rules)
  - [Render-blocking & CSS rules](#render-blocking--css-rules)
  - [Output caching & tracking rules](#output-caching--tracking-rules)
  - [Volume rules](#volume-rules)
- [Auto-fix actions](#auto-fix-actions)
- [Manual-only checks](#manual-only-checks)
- [Key nuances](#key-nuances)
- [Thresholds](#thresholds)
- [Microsoft Learn sources](#microsoft-learn-sources)

---

## Finding envelope

`analyze-perf.js` prints a single JSON object to stdout:

```json
{
  "status": "ok",
  "findings": [
    {
      "id": "perf-1",
      "tag": "PERF-FETCHXML-ALLATTR",
      "severity": "high",
      "title": "FetchXML retrieves all attributes",
      "location": ".powerpages-site/web-templates/home/Home.webtemplate.source.html:2",
      "details": "...",
      "fix": "...",
      "autoFixAvailable": false,
      "fixSkill": null,
      "fixAction": null
    }
  ],
  "details": { "kind": "kv", "label": "Scan coverage", "entries": [ { "key": "...", "value": "..." } ] },
  "severityCounts": { "high": 3, "warning": 3, "info": 1 }
}
```

This is the exact `{ status, findings, details }` shape that `scripts/build-review-data.js` (via the `perf-checker.json` `SECTION_MAP` entry, id `performance`, icon ⚡) and `scripts/render-review.js` consume — the same shared HTML report pipeline `scan-site` uses. `severityCounts` is an analyzer convenience for the in-chat summary; the renderer ignores it.

When no anti-pattern is found the analyzer still emits one `info` finding tagged `PERF-NONE` so the report is never empty.

## Severity scale

| `severity` | Meaning in this skill |
|------------|-----------------------|
| `high` | A pattern that materially multiplies data volume or round-trips (over-fetching, N+1). Fix before shipping. |
| `warning` | A likely performance cost that depends on data size (unbounded queries, disabled caching, large volume counts). |
| `info` | A nudge or context-dependent item (missing-but-defaultable settings, deprecated tracking, large assets). |

The analyzer never emits `critical` — these are code-quality/perf issues, not outages. The severity vocabulary itself is the shared set (`critical|high|warning|medium|info|low|pass`) understood by `build-review-data.js`.

---

## Rule catalog

Each rule is a pure function in `analyze-perf.js` (unit-tested in `scripts/tests/analyze-perf.test.js`). `location` is a repo-relative `path:line` wherever a source offset exists.

### FetchXML rules

Scanned in files with extensions `.html/.htm/.liquid/.xml/.yml/.yaml` (web-template Liquid source ships as `<name>.webtemplate.source.html`; FetchXML can also be embedded in list/form YAML).

| Tag | Detect | Severity | Auto-fix | Why it matters |
|-----|--------|----------|----------|----------------|
| `PERF-FETCHXML-ALLATTR` | `<all-attributes/>` or `all-attributes="true"` inside a `<fetch>` | high | No | Returns every column — inflates payload, slows the query, over-exposes data. |
| `PERF-FETCHXML-NO-COLUMNS` | `<entity>` with no `<attribute>` and not an aggregate | warning | No | No explicit projection ⇒ platform returns a default column set, more than the page needs. |
| `PERF-FETCHXML-MANY-COLUMNS` | more than `FETCHXML_MAX_ATTRIBUTES` (20) explicit `<attribute>` elements | info | No | Wide projections increase payload size and query cost, even when they avoid `all-attributes`. |
| `PERF-FETCHXML-NO-PAGING` | `<fetch>` with no `count`/`top` and not an aggregate | warning | No | Unbounded list query — a common cause of slow pages and portal timeouts on large tables. |
| `PERF-FETCHXML-LARGE-COUNT` | `count`/`top` > `FETCHXML_MAX_COUNT` (100) | warning | No | Large single-page fetch increases render time and timeout risk; prefer smaller pages. |
| `PERF-FETCHXML-IN-LOOP` | `<fetch` appears while inside a Liquid `{% for %}`…`{% endfor %}` | high | No | N+1: the query runs once per iteration, multiplying round-trips. The single biggest Liquid perf pitfall. |
| `PERF-FETCHXML-TOTALRECORDCOUNT` | `returntotalrecordcount="true"` on a `<fetch>` | info | No | Forces the platform to compute the total matching row count (capped at 5000) alongside the page — only worth it when the UI shows a total; adds overhead on large tables. |
| `PERF-FETCHXML-QUERY-HINT` | `options`, `latematerialize="true"`, `no-lock="true"`, `useraworderby="true"`, or a filter `hint` | warning | No | Advanced optimization switches are workload-specific. Microsoft warns that unsupported/incorrect query options can reduce performance. |
| `PERF-FETCHXML-CACHE-BYPASS` | explicit no-cache attribute or request-time `"now" \| date` value inside FetchXML | warning | No | Makes the query text change per request, preventing server-side cache reuse and increasing Dataverse load. |
| `PERF-FETCHXML-LEADING-WILDCARD` | `operator="like"` / `not-like` with a value beginning `%` or `*` | warning | No | Leading-wildcard string searches cannot use a normal prefix seek and can become expensive on large tables. |
| `PERF-FETCHXML-ORDER-RELATED` | `<order>` inside a `<link-entity>` or with a related entity/alias | info | No | Sorting by a related table column can force extra join/sort work compared with sorting on the base table. |

Aggregate fetches (`aggregate="true"`) are **exempt** from the no-columns, no-paging, and large-count rules — they return a single summary row, so paging/projection do not apply.

### List & webpage API rules

| Tag | Detect | Severity | Auto-fix | Why it matters |
|-----|--------|----------|----------|----------------|
| `PERF-LIST-NO-PAGING` | a `*.list.yml` definition with no positive `adx_pagesize` / `pagesize` | warning | No | An unbounded list can retrieve and render too many rows in one response. |
| `PERF-WEBPAGE-AS-API` | a FetchXML/entity-backed `.webtemplate.source.html` or `.webpage.copy.html` that emits JSON/XML and has no normal HTML shell | warning | No | Treating a Liquid webpage as a custom API adds server rendering overhead and scales worse than the native Web API or Server Logic. |

`PERF-WEBPAGE-AS-API` is intentionally conservative and heuristic: it requires
both a Dataverse data-query signal and structured JSON/XML output without a
normal HTML shell. Review the finding before changing an intentional endpoint.

### Web API rules

Scanned in code files (`.ts/.tsx/.js/.jsx/.mjs/.cjs/.vue/.svelte/.astro/.html/.htm`) for the Power Pages Web API path segment `/_api/`.

| Tag | Detect | Severity | Auto-fix | Why it matters |
|-----|--------|----------|----------|----------------|
| `PERF-WEBAPI-SELECT-STAR` | `/_api/` URL with `$select=*` | high | No | Returns every column; list only the columns the UI binds. |
| `PERF-WEBAPI-NO-SELECT` | `/_api/` URL with query options but no `$select` | warning | No | Default projection returns all columns — more data than needed. |
| `PERF-WEBAPI-MANY-COLUMNS` | `$select` lists more than `WEBAPI_MAX_SELECT_COLUMNS` (20) columns | info | No | Wide projections increase payload size and client parsing cost. |
| `PERF-WEBAPI-NO-TOP` | `/_api/` collection query (`$filter`/`$orderby`/`$expand`/`$apply`) with no `$top` | warning | No | Unbounded result set slows the page and can hit throttling limits. |
| `PERF-WEBAPI-LARGE-TOP` | `$top` > `WEBAPI_MAX_TOP` (100) | warning | No | Large single-response payloads slow rendering and increase throttling risk; prefer smaller pages. |
| `PERF-WEBAPI-COUNT` | `$count=true` on a Web API request | info | No | Forces Dataverse to compute the total matching row count; only worth it when the UI displays a total. |
| `PERF-WEBAPI-EXPAND-NO-SELECT` | `$expand=...` without a nested `$select` | warning | No | Expanded related rows can return more columns than the page needs. |
| `PERF-WEBAPI-WILDCARD-FILTER` | `$filter` uses `contains(...)` or `endswith(...)` | warning | No | Contains/ends-with searches are leading-wildcard-like and can be expensive on large tables. |
| `PERF-WEBAPI-CACHE-BYPASS` | `$filter` appears to include request-time date values (`new Date`, `Date.now`, `toISOString`, `now()`) | warning | No | A changing query string prevents cache reuse and increases Dataverse load under traffic. |
| `PERF-WEBAPI-ORDER-RELATED` | `$orderby` uses a related property path (`relationship/column`) | info | No | Related-column sorts can require extra join/sort work compared with sorting on the base table. |
| `PERF-WEBAPI-IN-LOOP` | async `.map`/`.forEach`/`.filter`/`.reduce` callback whose body calls `/_api/` | info | No | Possible N+1: one request per array element. Heuristic — verify before acting. |

### Client-side script rules

Scanned in JS/HTML code files (`.ts/.tsx/.js/.jsx/.mjs/.cjs/.vue/.svelte/.astro/.html/.htm`) — the same population as the Web API scan (inline `<script>` in HTML is covered). These flag main-thread-blocking JS and aggressive Web API polling.

| Tag | Detect | Severity | Auto-fix | Why it matters |
|-----|--------|----------|----------|----------------|
| `PERF-SYNC-XHR` | `XMLHttpRequest.open(method, url, false)` (async flag `false`) | high | No | Synchronous XHR freezes the UI thread until the request returns; deprecated. |
| `PERF-JQUERY-SYNC-AJAX` | `async: false` inside a file that calls `.ajax(` | high | No | Synchronous jQuery AJAX blocks the UI thread the same way sync XHR does. |
| `PERF-DOCUMENT-WRITE` | `document.write(` / `document.writeln(` | warning | No | Forces a synchronous parse/reflow and, post-load, can blank the page; browsers de-prioritize it. |
| `PERF-SHORT-POLL` | `setInterval(…, <10000ms)` whose inline callback references `/_api/` | warning | No | Frequent Web API polling consumes licensed capacity and adds Dataverse load; can approach service limits. |

The sync-ajax rule gates on an `.ajax(` call being present and uses a `\basync\b` word boundary, so a stray `async: false` in an unrelated config object (or a `isAsync` substring) is not flagged. The short-poll rule only catches the **inline-callback** shape (`setInterval(() => { fetch("/_api/…") }, 3000)`) — a named-function reference is left alone — to stay high-signal.

### Render-blocking & CSS rules

| Tag | Detect | Severity | Auto-fix | Why it matters | Scanned in |
|-----|--------|----------|----------|----------------|------------|
| `PERF-RENDER-BLOCKING-SCRIPT` | external `<script src=…>` inside `<head>` with no `async`/`defer`/`type="module"` | warning | No | Blocks HTML parsing until the script downloads and executes — delays first paint. | `.html/.htm` |
| `PERF-CSS-IMPORT` | `@import` in a runtime `.css` file | warning | No | The browser fetches an `@import`ed sheet only after parsing the parent CSS, serializing downloads and delaying render. | `.css` only |

Only runtime `.css` is scanned for `@import`; pre-processor sources (`.scss`/`.less`) are excluded because their `@import` is resolved at build time. Commented-out `@import`s (inside `/* … */`) are ignored while line numbers for real ones stay accurate.

### Output caching & tracking rules

These read either `.powerpages-site/site-settings/*.sitesetting.yml` (via the
shared `loadSiteSettings` parser) or a classic PAC download's root-level
`sitesetting.yml` aggregate list. Page/file tracking reads the per-record YAML in
either export layout. The rules run only when the relevant metadata exists.

| Tag | Detect | Severity | Auto-fix | Why it matters |
|-----|--------|----------|----------|----------------|
| `PERF-HEADER-OUTPUTCACHE` | `Header/OutputCache/Enabled` present & false | warning | **Yes** (`set-site-setting`) | Header web template re-parsed/rendered on every page load. |
| `PERF-HEADER-OUTPUTCACHE` | `Header/OutputCache/Enabled` absent | info | **Yes** (`create-site-setting`) | Upgraded sites default this off; new sites default on. |
| `PERF-FOOTER-OUTPUTCACHE` | `Footer/OutputCache/Enabled` present & false | warning | **Yes** (`set-site-setting`) | Footer web template re-parsed/rendered on every page load. |
| `PERF-FOOTER-OUTPUTCACHE` | `Footer/OutputCache/Enabled` absent | info | **Yes** (`create-site-setting`) | Same default-on/off nuance as header. |
| `PERF-SIGNIN-TRACKING` | `Authentication/LoginTrackingEnabled` true | warning | **Yes** (`set-site-setting`) | Writes a tracking record on every sign-in — avoidable write pressure. |
| `PERF-WEBPAGE-TRACKING` | web-page YAML with `adx_enabletracking: true` | info | **Yes** (`set-yaml-field`) | Deprecated page tracking (retired 9.3.4.x+); Site Checker flags it. |
| `PERF-WEBFILE-TRACKING` | web-file YAML with `adx_enabletracking: true` | info | **Yes** (`set-yaml-field`) | Deprecated file tracking (retired 9.3.4.x+); Site Checker flags it. |

### Volume rules

| Tag | Detect | Severity | Auto-fix | Why it matters |
|-----|--------|----------|----------|----------------|
| `PERF-WEBFILE-COUNT` | `.webfile.yml` count across `.powerpages-site/web-files/` or classic root `web-files/` > `WEB_FILE_WARN_THRESHOLD` (500) | warning | No | Large web-file table slows website startup. Move static content to Blob/CDN. |
| `PERF-WEBROLE-COUNT` | per-record `.webrole.yml` count or classic root `webrole.yml` record count > `WEB_ROLE_WARN_THRESHOLD` (100) | warning | No | Many roles evaluated per request affect every page. Consolidate roles. |
| `PERF-LARGE-STATIC-ASSET` | any media/binary asset > `LARGE_ASSET_BYTES` (1 MiB) | info | No | Large unoptimized assets slow first load, especially on mobile. Compress or move to CDN. |

`PERF-LARGE-STATIC-ASSET` reports at most the 20 largest offenders so a media-heavy project cannot drown the report.

---

## Auto-fix actions

For findings with `autoFixAvailable: true`, `fixAction` tells the SKILL.md Phase 4 loop exactly what deterministic change to apply. **Every fix is gated by per-finding consent** (`perf-checker:4.auto-fix`, category=consent) — the analyzer never mutates anything.

| `fixAction.type` | Fields | How the skill applies it |
|------------------|--------|--------------------------|
| `create-site-setting` | `name`, `value`, `valueType` | Per-record `.powerpages-site` layout only: `node "${PLUGIN_ROOT}/scripts/create-site-setting.js" --projectRoot <root> --name <name> --value <value> --type boolean --description "<why>"`. Errors if the setting already exists — treat that as "already handled". A missing setting in classic aggregate `sitesetting.yml` remains manual because creating a second metadata layout would be unsafe. |
| `set-site-setting` | `name`, `value`, `valueType` | The setting file already exists; use `Edit` to flip the `value:` line (e.g., `false` → `true`, or tracking `true` → `false`). Do **not** call `create-site-setting.js` (it refuses to overwrite). |
| `set-yaml-field` | `field`, `value`, optional `recordName` | Use `Edit` at the finding's precise `location` to set `<field>: <value>` (e.g., `adx_enabletracking: false`). For classic aggregate `sitesetting.yml`, `recordName` identifies the record and the location points at its exact `adx_value` line. |

**Output-cache fixes carry a mandatory caveat** (already baked into the finding's `fix` text): enabling `Header/Footer/OutputCache/Enabled` alone is **not** sufficient — the Header, Footer, and Languages-Dropdown web templates must also use the `{% substitution %}` Liquid tag, or those regions stop rendering. Always surface this caveat when applying the fix and recommend verifying the templates.

---

## Manual-only checks

Documented here for completeness; **not** emitted by the analyzer because they require live Dataverse data the static scan cannot see:

- **Basic/advanced form lookup dropdown with > 200 records.** A lookup rendered as a dropdown that binds a table with more than ~200 rows loads slowly. Site Checker flags this at runtime. Recommend switching the control to a modal lookup / search, or filtering the source view. Route the user to review the form in Power Pages Studio.
- **Missing table indexes / slow custom Dataverse views.** Query plans are a server-side concern; recommend the Power Platform admin center and Site Checker for these.
- **Ordering by choice columns.** Static source only has logical column names, not Dataverse attribute metadata, so the analyzer cannot reliably know whether `<order attribute="statuscode">` or `$orderby=statuscode` is a choice column. Treat this as a Dataverse metadata/live review item.
- **Filtering on multiline text columns.** The analyzer can detect leading-wildcard/contains-style filters, but it cannot reliably know whether a filtered logical name is a multiline text column without metadata. Avoid guessing from names like `description` because that creates noisy false positives.
- **Apostrophes/special characters in search text.** This is usually an escaping/correctness or search-quality concern rather than a stable performance finding in local source. The analyzer flags the expensive query shapes around it (`contains`, `endswith`, leading wildcards), not arbitrary apostrophe characters.

---

## Key nuances

- **Code sites vs declarative sites.** `pac pages upload-code-site` replaces the Header and Footer web templates with a `<div/>` on every upload, so output-cache findings apply mainly to **declarative** sites. The analyzer reads either `.powerpages-site/site-settings/` or classic root-level `sitesetting.yml`; a pure code site with neither metadata source simply won't produce those findings.
- **Default-on vs default-off caching.** New sites default header/footer output caching **on**; upgraded sites default it **off** when the setting is absent. Hence: present-and-false ⇒ `warning` (confident), absent ⇒ `info` (a nudge).
- **`adx_enabletracking` is deprecated, not removed.** The field is retired on portal versions 9.3.4.x and later, but older exports still carry it; Site Checker continues to flag it, so the analyzer does too (at `info`).
- **Heuristics are intentionally conservative.** `PERF-WEBAPI-IN-LOOP` requires an `async` callback and a `/_api/` reference within the same statement window to stay high-signal; a plain `.map` over already-fetched results is not flagged.
- **Query hints are review findings, not automatic removals.** `options`,
  `latematerialize`, and `hint="union"` can help specific measured workloads.
  The analyzer flags their presence because Microsoft recommends support-guided
  use; it does not claim every hint is wrong.
- **Cache-bypass detection is narrow.** It flags explicit no-cache variants and
  current-time Liquid inside FetchXML. User-input filters are not treated as
  cache bypassing because they are usually legitimate query parameters.
- **Build output is skipped.** Content scans prune `dist/build/out/bin/obj/.astro/...` so minified bundles don't create duplicate, un-fixable noise — the actionable location is always the source file.

## Thresholds

Defined and exported from `analyze-perf.js` (tests assert against the real constants, not copies):

| Constant | Value | Rule |
|----------|-------|------|
| `FETCHXML_MAX_COUNT` | 100 | `PERF-FETCHXML-LARGE-COUNT` |
| `FETCHXML_MAX_ATTRIBUTES` | 20 | `PERF-FETCHXML-MANY-COLUMNS` |
| `WEBAPI_MAX_TOP` | 100 | `PERF-WEBAPI-LARGE-TOP` |
| `WEBAPI_MAX_SELECT_COLUMNS` | 20 | `PERF-WEBAPI-MANY-COLUMNS` |
| `SHORT_POLL_INTERVAL_MS` | 10000 (10s) | `PERF-SHORT-POLL` |
| `WEB_FILE_WARN_THRESHOLD` | 500 | `PERF-WEBFILE-COUNT` |
| `WEB_ROLE_WARN_THRESHOLD` | 100 | `PERF-WEBROLE-COUNT` |
| `LARGE_ASSET_BYTES` | 1 MiB (1048576) | `PERF-LARGE-STATIC-ASSET` |

## Microsoft Learn sources

- Site Checker — performance checks: <https://learn.microsoft.com/en-us/power-pages/admin/site-checker-performance>
- Enable header and footer output caching: <https://learn.microsoft.com/en-us/power-pages/configure/enable-header-footer-output-caching>
- Use FetchXML to retrieve data (Liquid): <https://learn.microsoft.com/en-us/power-pages/configure/liquid/liquid-tags#fetchxml>
- Page large result sets with FetchXML (`returntotalrecordcount`): <https://learn.microsoft.com/en-us/power-apps/developer/data-platform/fetchxml/page-results>
- Optimize FetchXML and review query hints: <https://learn.microsoft.com/en-us/power-apps/developer/data-platform/fetchxml/optimize-performance>
- Power Pages server-side caching: <https://learn.microsoft.com/en-us/power-pages/admin/clear-server-side-cache>
- Power Pages Web API overview & limits: <https://learn.microsoft.com/en-us/power-pages/configure/web-api-overview>
- Eliminate render-blocking resources (scripts & CSS): <https://web.dev/articles/render-blocking-resources>
- Avoid `document.write()`: <https://web.dev/articles/no-document-write>
- `XMLHttpRequest.open()` (synchronous request deprecation): <https://developer.mozilla.org/en-US/docs/Web/API/XMLHttpRequest/open>
- CSS `@import`: <https://developer.mozilla.org/en-US/docs/Web/CSS/@import>
