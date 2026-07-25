# Plan 5 (v2) — Three-Authority Generative-Page Management (Identity · Existence · Membership)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make generative-page management correct and crash-safe by separating the **three distinct authorities** a build/verify/download must consult — **IDENTITY** (the durable per-app manifest `key→pageId`), **EXISTENCE** (the env-wide set of all generative-page ids that exist), and **MEMBERSHIP** (this app's sitemap `GenPageId` set) — instead of collapsing them into one "read the sitemap" signal. This eliminates the crash-after-create duplicate class, the app-scoped uncertain-create duplicate, the headless-page orphan/drop, the name-vs-title mismatch, and the fail-open "empty sitemap ⇒ recreate-all" hazard.

**Architecture (non-negotiable — the whole point of v2): three authorities.**
- **IDENTITY** = the durable per-app manifest web resource `<appUnique>_pagemanifest` — maps stable `key` → deployed `pageId` (+ name/purpose/dataSources/navigatesTo/pageInput/source). The source of truth for "which id is this page." A downloaded **edit-snapshot** spec ALSO self-describes each page's `pageId`, which OUTRANKS the manifest when present.
- **EXISTENCE** = **env-wide** `pac model genpage list` (NO `--app-id`, `--include-unpublished`): the set of ALL generative-page ids in the environment. A manifest/spec id present here = the page EXISTS (not deleted), even before it is attached to any sitemap. This is what makes reconcile **crash-safe**: a page created-and-manifested but not yet finalized into the sitemap is still in the env-wide existence set → reused, never duplicated.
- **MEMBERSHIP** = the app's **sitemap** `GenPageId` set: which pages belong to THIS app's navigation. Used to (a) validate every page is placed, (b) enumerate what to download in the edit flow, (c) verify placement. **NOT** an existence check.

Live-verified facts the plan relies on: `pac model genpage list` help confirms env-wide by default, sitemap-scoped only with `--app-id`; `--include-unpublished` lists drafts; `download --page-id <comma ids>` pulls specific pages. The env-wide list returns all env pages with real names + a `Published` column and **no app column** (so it answers EXISTENCE, not MEMBERSHIP). A model-driven app's sitemap has no hidden-but-navigable subarea, so app MEMBERSHIP is exactly sitemap presence.

**Tech Stack:** Node.js (CommonJS), `node:test`, the vendored `cds-maker-sdk.cjs` (Dataverse + sitemap), PAC CLI (`pac model genpage list/upload/download`).

## Global Constraints

- **Node**: repo runs on the system Node for tests; the vendored SDK's Jest suite needs Node 20 (not exercised by this plan).
- **Test/build**: from `plugins/model-apps/` — single file `node --test scripts/tests/<f>.test.js`; full suite `node scripts/run-tests.js`. Baseline at plan start: **687 passing, 0 failing** (main `users/akmaloo/model-app-authoring`). The app-builder **eval harness** runs from the **repo root**: `node evals/model-apps/app-builder/run-app-builder.js` (must exit 0).
- **Commit trailers (every commit), verbatim:**
  ```
  Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
  Copilot-Session: 42626da2-b66f-4162-acaa-b1127ef23d89
  ```
- **Never** `git add .`; add only each task's named files. Never add `.superpowers/` or any scratch dir.
- **No placeholders / TDD / DRY / YAGNI / frequent commits.** Every code step shows the actual code.
- **schemaVersion 2** is the only page shape the engine sees at runtime (`migrateAppSpec` runs on load). Page identity is the stable **key** (`pages[].key`), grammar `^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$`.
- **Test data realism (Imp9):** every mock uses **real 36-char GUIDs** (never `gp-o`), because the GUID-only extractors (`sitemapGenPages`, `parseList`) match `[0-9a-fA-F-]{36}`. Reuse these across tasks:
  | symbol | GUID |
  |--------|------|
  | `GP_OVERVIEW` | `13ecbc57-a3a4-4132-b0a2-a6c6b12691e8` |
  | `GP_DETAIL` | `5c0a4889-45fd-46ea-91a8-ff876914d644` |
  | `GP_EXTRA` | `9f2b1a3c-77de-4a10-8b6e-2c4d5e6f7a8b` |
  | `APP_ID` | `a1b2c3d4-0000-4000-8000-000000000001` |
  | `APP_UNIQUE_VALUE` (appmoduleidunique lookup GUID) | `c0ffee00-0000-4000-8000-00000000dddd` |
  | `SITEMAP_ID` | `5111e0f2-0000-4000-8000-0000000000aa` |
  | `APP2_UNIQUE` | `contoso_secondapp` |

---

## Background: what live testing + Sol's review proved (the spec this plan implements)

**Live testing (v1 origin).** A multi-page build on `aurorabapenv03468` (an app whose `overview` page navigates to an `order-detail` page that was a nav target but **not** a sitemap subarea) established, with captured evidence:

1. `pac model genpage list --app-id <app>` is **sitemap-scoped**: it lists only pages reachable from the app's sitemap and reports each page's **sitemap subarea title** in the `Name` column — not the page's own name. `pac model genpage list` **without** `--app-id` lists the whole environment with real names, but carries **no app column** (it cannot answer "which of these belong to this app").
2. The headless `order-detail` page was **invisible** to app-scoped `list`/`download`; `download-model-app.js` produced a spec with `pages: 1` (dropped it), left a raw GUID `pageId` in the sibling `.tsx`, and the recovered spec **failed `validateAppSpec`**.
3. `verify-model-app.js` reported both pages missing (the headless one, and `overview` because its spec name `Orders Overview` ≠ the sitemap title `Overview`).

**Sol's review (v2 correction).** v1 tried to make the **sitemap the single authority** ("enumeration = read the sitemap"). Sol showed this is *wrong for existence*: if a build creates a page (mints an id, writes the manifest) and then **crashes before the finalizer adds the sitemap subarea**, the sitemap does NOT contain the id → a v1 reconcile marks it absent → re-creates it → **duplicate**. The fix is architectural: reconcile must key off **EXISTENCE** (env-wide `genpage list`), which DOES contain the crash-orphaned id, so it is reused. The sitemap remains authoritative only for **MEMBERSHIP** (placement/enumeration/verify). Identity stays the manifest, extended so a downloaded **edit-snapshot** spec self-describes each page's `pageId` (highest authority) — letting a downloaded app (including pages a Maker user added) rebuild without duplicating.

The build engine's spine (solution/tables/forms/views/app/`PAGEREF_` resolution/manifest/sitemap-finalize) is correct. The defect is confined to the **enumeration/identity layer**. This plan replaces that layer with the three-authority model and adds the safety detections (shared-page, destructive-removal) Sol required.

Already on `main` (not part of this plan): the real `pac genpage list` **table** format (`parseList`) and a fail-OPEN fix in `classifyListOutput`. v2 reuses `classifyListOutput` for the env-wide existence read.

---

## The invariant this plan establishes

> **Generative-page management consults THREE authorities, each for its own question.** (1) **IDENTITY** — "which id is this page?" — the durable manifest `<appUnique>_pagemanifest` (`key→pageId`), OUTRANKED by a spec page's own `pageId` when the spec is an edit-snapshot. (2) **EXISTENCE** — "does this page still exist?" — the **env-wide** `pac model genpage list` id set; this alone decides create-vs-reuse (crash-safe). (3) **MEMBERSHIP** — "does this page belong to THIS app's nav?" — the app's **sitemap** `GenPageId` set; this alone decides placement, download enumeration, and verify. All matching is **by id**, never by display name.

Corollaries the tasks enforce/rely on:
- **Reconcile keys off EXISTENCE, not membership** (C1). A manifest/spec id present in the env-wide set is reused even if it isn't (yet) in the sitemap. So a crash-after-create converges to reuse.
- **Uncertain-create recovery uses the env-wide set** (C2). An `upload` that may or may not have landed is resolved by an env-wide before/after id diff — never by an app-scoped list (which can't see a just-created not-yet-placed page).
- **Reads are fail-closed and discriminated** (C4). `fetchSitemap` distinguishes "valid sitemap, zero pages" from "app/component/sitemap missing or XML unreadable"; the env-wide read reuses `classifyListOutput` (fail-closed on unrecognized). A read failure HALTs; it never collapses to `[]`→"empty"→recreate-all.
- **Edit-snapshots self-describe** (C3). Download keeps each page's `pageId` in the emitted spec; reconcile treats that `pageId` as the highest identity authority, so a downloaded app (incl. Maker-added pages) rebuilds without duplicating.
- **Every page is placed** (validation). Every `pages[]` entry must be an `appShell` subarea; the sitemap `GenPageId` set is then the complete MEMBERSHIP list.
- **Safety detections, report-only.** A page shared across apps → HALT `pages-shared-across-apps` (detected by scanning every app's sitemap, since a genpage has no queryable app-membership row; never auto-modify). A page removed from the spec but still live → HALT `pages-removed` unless `--allow-destructive` (never auto-delete).

---

## File Structure (what changes and why)

| File | Responsibility | Change |
|------|----------------|--------|
| `scripts/lib/sitemap-pages.js` *(new)* | Pure sitemap `GenPageId` extractors + the discriminated live **MEMBERSHIP** reader + the cross-app shared-page scan. | Create. `sitemapGenPages`/`sitemapGenPageIds` (pure, XML-entity-decoded titles); `fetchSitemap(sdk, appUnique) → {ok,xml,ids}|{ok:false,reason}` (fail-closed, C4); `fetchAppsForPages(sdk, pageIds, {excludeAppUnique}) → {ok,byId,unreadable}|{ok:false,error}` (Imp5 — genpages have no `appmodulecomponent` row, so the sitemap XML is the only membership signal). |
| `scripts/lib/genpage-cli.js` | `pac model genpage` wrapper. | Add env-wide **EXISTENCE** `enumerateEnv() → {ok,ids,pages}|{ok:false,error}` (no `--app-id`, `--include-unpublished`); redesign `upload` uncertain-create recovery to the env-wide before/after diff (C2); add `download({appId,outputDir,pageIds})` (by id). |
| `scripts/lib/app-spec.js` | App Spec validation. | Every page must be a sitemap subarea (deploy/plan/design; not `structural`); **accept** optional `pages[].pageId` (edit-snapshot, C3). |
| `scripts/lib/page-manifest.js` | Durable manifest (**IDENTITY**) + reconcile. | `reconcilePageIds(pages, manifest, existenceIds) → {keyToId, absentKeys, conflicts}` — spec-pageId > manifest, confirmed by **existence** (C1/C3); `parseManifest` rejects two keys→one id (Imp11). |
| `scripts/lib/sdk-build.js` | Build engine — pages phase. | Existence via `enumerateEnv`; reconcile by existence; conflicts HALT; shared-page HALT (Imp5); destructive-removal HALT-gate (Imp6, thread `opts.allowDestructive`); membership via `fetchSitemap` (C4); finalize-all. |
| `scripts/build-model-app.js` | Build CLI wrapper. | Thread `allowDestructive` into the `runSdkBuild` call. |
| `scripts/lib/verify-spec.js` | Spec-vs-deployed reconcile core. | Page checks match by id against **existence** (env-wide) + **membership** (sitemap); `unableToRun`/`page-identity` when the manifest can't correlate (Imp7); EXACT set-equality (Imp7); one cached snapshot each (Imp7). |
| `scripts/verify-model-app.js` | Verify CLI + reader. | Reader supplies `existenceIds()`/`membership()`/`manifest()` (cached) + `pageCode(id)` (download by id). |
| `scripts/download-model-app.js` | Edit-flow download. | Enumerate MEMBERSHIP via `fetchSitemap`; download **by id**; reconcile by id; **keep** each page's `pageId` (C3); report Maker-deleted manifest pages. |
| `scripts/lib/hydrate-spec.js` | Spec reconstruction. | Emit `pageId` on each v2 page (edit-snapshot, C3). |
| `evals/model-apps/app-builder/fixtures/2-orders-multipage/app-spec.json` | Eval fixture (author uses `plan` profile). | Place `order-detail` in the sitemap (Imp8). |
| Docs (`docs/architecture.md`, `references/app-spec-schema.md`, `references/rules.md`, `agents/genpage-page-builder.md`, `skills/app-builder/SKILL.md`, `CHANGELOG.md`, `docs/app-builder-roadmap.md`, `AGENTS.md`) | User/agent contract. | Document the three-authority model, edit-snapshot vs portable spec, every-page-placed, and the safety HALTs. |

**Task order + atomicity (Imp10):** Tasks **1, 2, 3** are independent and land first (each commits green). Tasks **4 (reconcile) + 5 (build) + 6 (download)** are the reconcile-signature-change atomic unit — implement back-to-back with per-task TDD, but commit **all three together in ONE commit** at the end of Task 6 so the full suite is NEVER committed red. Task **7 (verify)** depends only on Tasks 1+2 and lands independently. Task **8** is docs.

---

## Task 1: `sitemap-pages.js` — pure MEMBERSHIP extractors + discriminated fail-closed `fetchSitemap` + cross-app scan

The single reader of "which pages does this app's sitemap contain" (MEMBERSHIP) and "which other apps reference these pages" (Imp5). Fail-closed and discriminated (C4): a valid-but-page-less sitemap is `{ ok:true, ids:[] }`; a missing app/component/sitemap or unreadable XML is `{ ok:false, reason }` — NEVER `''`→"empty".

**Files:**
- Create: `scripts/lib/sitemap-pages.js`
- Create: `scripts/tests/sitemap-pages.test.js`

**Interfaces:**
- Consumes: for the pure extractors, nothing (leaf). For `fetchSitemap`/`fetchAppsForPages`, an `sdk`/`provision` handle with `queryRecords` (I/O), and `odata.js`'s `odataLit`.
- Produces:
  - `sitemapGenPages(xml) → Array<{ pageId, title? }>` — one entry per `<SubArea … GenPageId="<guid>" …>`, id as written, subarea `Title`/`Description` **XML-entity-decoded** (Imp9). Deduped by lower-cased id.
  - `sitemapGenPageIds(xml) → string[]` — sorted-unique **lower-cased** ids (the fast MEMBERSHIP set).
  - `fetchSitemap(sdk, appUnique) → Promise<{ ok:true, xml, ids } | { ok:false, reason }>` — the app's **live** sitemap (a direct Dataverse query: appmodule → appmodulecomponent type 62 → sitemap.sitemapxml). Discriminated reasons: `app-not-found`, `sitemap-component-not-found`, `sitemap-xml-unreadable`, or `*-query-failed`. **Replaces** `verify-model-app.js`'s `sitemapXmlFor` (the C4 bug that collapsed all three not-found cases to `''`).
  - `fetchAppsForPages(sdk, pageIds) → Promise<{ ok:true, byId: Map<idLower, appUnique[]> } | { ok:false, error }>` — best-effort env-wide MEMBERSHIP scan: which apps' sitemaps reference each of `pageIds` (Imp5).

> **Why a live query, not `fetchArtifact('app').siteMap`:** the build's `app-shell` phase creates a fresh app with no `GenPage` subareas, and the existing-app branch **defers** the sitemap write to the pages finalizer (`sdk-build.js:1256-1264`). So the *live* deployed sitemap at pages-phase start is empty-of-genpages on a fresh build or the prior run's genpages on a rebuild. `fetchSitemap` reads exactly that. It is the **single** sitemap source for build/verify/download (Imp9 — no in-memory `siteMapObjGenPageIds` walker).

- [ ] **Step 1: Write the failing test** — `scripts/tests/sitemap-pages.test.js`

```javascript
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { sitemapGenPages, sitemapGenPageIds, fetchSitemap, fetchAppsForPages } = require('../lib/sitemap-pages.js');

const GP_OVERVIEW = '13ecbc57-a3a4-4132-b0a2-a6c6b12691e8';
const GP_DETAIL = '5c0a4889-45fd-46ea-91a8-ff876914d644';
const APP_UNIQUE_VALUE = 'c0ffee00-0000-4000-8000-00000000dddd';
const SITEMAP_ID = '5111e0f2-0000-4000-8000-0000000000aa';

// A realistic sitemap: two GenPage subareas (one Title carries an XML entity), an entity subarea, a Url decoy GUID.
const XML = [
  '<SiteMap>',
  '  <Area Id="Sales" Title="Sales">',
  '    <Group Id="Work" Title="Work">',
  `      <SubArea Id="s1" GenPageId="${GP_OVERVIEW}" Title="Orders &amp; Overview" />`,
  '      <SubArea Id="s2" Entity="new_liveorder" Title="Orders" />',
  `      <SubArea Id="s3" GenPageId="${GP_DETAIL.toUpperCase()}" Title="Order Detail" />`,
  '      <SubArea Id="s4" Url="https://x/00000000-0000-0000-0000-000000000000" Title="Decoy" />',
  '    </Group>',
  '  </Area>',
  '</SiteMap>',
].join('\n');

test('sitemapGenPages: one entry per GenPage subarea, XML-entity-decoded title, decoys ignored', () => {
  const rows = sitemapGenPages(XML);
  assert.strictEqual(rows.length, 2, 'only the two GenPageId subareas count');
  const byId = new Map(rows.map((r) => [r.pageId.toLowerCase(), r.title]));
  assert.strictEqual(byId.get(GP_OVERVIEW), 'Orders & Overview', 'title entity-decoded (&amp; → &)');
  assert.strictEqual(byId.get(GP_DETAIL), 'Order Detail');
});

test('sitemapGenPageIds: sorted-unique lower-cased ids; a page attached twice is deduped', () => {
  const twice = XML.replace('</Group>', `      <SubArea Id="s5" GenPageId="${GP_OVERVIEW.toUpperCase()}" Title="dup" />\n    </Group>`);
  assert.deepStrictEqual(sitemapGenPageIds(twice), [GP_OVERVIEW, GP_DETAIL].sort());
});

test('empty / malformed / no-genpage sitemap → []', () => {
  assert.deepStrictEqual(sitemapGenPages(''), []);
  assert.deepStrictEqual(sitemapGenPageIds('<SiteMap><Area><Group><SubArea Entity="x"/></Group></Area></SiteMap>'), []);
  assert.deepStrictEqual(sitemapGenPageIds(null), []);
});

// fetchSitemap mocks the THREE queryRecords calls it actually makes (Imp9), not a fake fetchArtifact().siteMap.
function sdkWith({ apps, comps, sms } = {}) {
  return {
    queryRecords: async (entity) => {
      if (entity === 'appmodule') return apps;
      if (entity === 'appmodulecomponent') return comps;
      if (entity === 'sitemap') return sms;
      return [];
    },
  };
}

test('fetchSitemap: a valid sitemap with genpages → { ok:true, ids }', async () => {
  const sdk = sdkWith({ apps: [{ appmoduleid: 'a', appmoduleidunique: APP_UNIQUE_VALUE }], comps: [{ objectid: SITEMAP_ID, componenttype: 62 }], sms: [{ sitemapxml: XML }] });
  const r = await fetchSitemap(sdk, 'contoso_app');
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.ids, [GP_OVERVIEW, GP_DETAIL].sort());
});

test('fetchSitemap: a VALID sitemap with ZERO genpages → { ok:true, ids:[] } (distinct from a read failure)', async () => {
  const sdk = sdkWith({ apps: [{ appmoduleid: 'a', appmoduleidunique: APP_UNIQUE_VALUE }], comps: [{ objectid: SITEMAP_ID }], sms: [{ sitemapxml: '<SiteMap><Area><Group><SubArea Entity="x"/></Group></Area></SiteMap>' }] });
  const r = await fetchSitemap(sdk, 'contoso_app');
  assert.deepStrictEqual(r, { ok: true, xml: '<SiteMap><Area><Group><SubArea Entity="x"/></Group></Area></SiteMap>', ids: [] });
});

test('fetchSitemap is FAIL-CLOSED & DISCRIMINATED: missing app / component / xml each yield a distinct reason (never [])', async () => {
  assert.deepStrictEqual(await fetchSitemap(sdkWith({ apps: [] }), 'x'), { ok: false, reason: 'app-not-found' });
  assert.deepStrictEqual(await fetchSitemap(sdkWith({ apps: [{ appmoduleid: 'a', appmoduleidunique: APP_UNIQUE_VALUE }], comps: [] }), 'x'), { ok: false, reason: 'sitemap-component-not-found' });
  assert.deepStrictEqual(await fetchSitemap(sdkWith({ apps: [{ appmoduleid: 'a', appmoduleidunique: APP_UNIQUE_VALUE }], comps: [{ objectid: SITEMAP_ID }], sms: [{ sitemapxml: '' }] }), 'x'), { ok: false, reason: 'sitemap-xml-unreadable' });
});

test('fetchAppsForPages: an id in TWO apps sitemaps is reported under both (Imp5 shared detection)', async () => {
  // app-a (unique 'ua') → sitemap SITEMAP_ID = XML (has GP_OVERVIEW); app-b (unique 'ub') → sitemap 'sm-2' (also has GP_OVERVIEW).
  const smXmlById = { [SITEMAP_ID]: XML, 'sm-2': `<SiteMap><Area><Group><SubArea GenPageId="${GP_OVERVIEW}" Title="Reused"/></Group></Area></SiteMap>` };
  const smIdByAppUnique = { ua: SITEMAP_ID, ub: 'sm-2' };
  const sdk = {
    queryRecords: async (entity, o) => {
      const filter = (o && o.filter) || '';
      if (entity === 'appmodule') {
        // The un-filtered list (fetchAppsForPages) returns both apps; a uniquename-filtered read (inside
        // fetchSitemap) returns just that one.
        const all = [{ appmoduleid: 'a', uniquename: 'app-a', appmoduleidunique: 'ua' }, { appmoduleid: 'b', uniquename: 'app-b', appmoduleidunique: 'ub' }];
        const m = filter.match(/uniquename eq '([^']+)'/);
        return m ? all.filter((a) => a.uniquename === m[1]) : all;
      }
      if (entity === 'appmodulecomponent') { const u = filter.match(/_appmoduleidunique_value eq (\S+)/)[1]; return [{ objectid: smIdByAppUnique[u], componenttype: 62 }]; }
      if (entity === 'sitemap') { const smId = filter.match(/sitemapid eq (\S+)/)[1]; return [{ sitemapxml: smXmlById[smId] }]; }
      return [];
    },
  };
  const r = await fetchAppsForPages(sdk, [GP_OVERVIEW]);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual((r.byId.get(GP_OVERVIEW) || []).sort(), ['app-a', 'app-b']);
  assert.deepStrictEqual(r.unreadable, [], 'both sitemaps readable → no partial coverage');
  // excludeAppUnique skips self so a build doesn't count its own app (and a single-app env reads 0 sitemaps).
  const excl = await fetchAppsForPages(sdk, [GP_OVERVIEW], { excludeAppUnique: 'app-a' });
  assert.deepStrictEqual((excl.byId.get(GP_OVERVIEW) || []), ['app-b'], 'self (app-a) excluded');
});

test('fetchAppsForPages is FAIL-CLOSED when the appmodule enumeration fails (cannot verify → ok:false)', async () => {
  const sdk = { queryRecords: async (e) => { if (e === 'appmodule') throw new Error('429 throttled'); return []; } };
  const r = await fetchAppsForPages(sdk, [GP_OVERVIEW]);
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /throttled/);
});

test('fetchAppsForPages records (does not fail on) an app whose sitemap is unreadable (best-effort partial)', async () => {
  const sdk = {
    queryRecords: async (entity, o) => {
      const filter = (o && o.filter) || '';
      if (entity === 'appmodule') { const m = filter.match(/uniquename eq '([^']+)'/); const all = [{ appmoduleid: 'b', uniquename: 'app-b', appmoduleidunique: 'ub' }]; return m ? all.filter((a) => a.uniquename === m[1]) : all; }
      if (entity === 'appmodulecomponent') return []; // app-b has no readable sitemap component → fetchSitemap ok:false
      return [];
    },
  };
  const r = await fetchAppsForPages(sdk, [GP_OVERVIEW]);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.unreadable, ['app-b']);
  assert.strictEqual(r.byId.size, 0);
});
```

- [ ] **Step 2: Run to verify it fails** — `node --test scripts/tests/sitemap-pages.test.js` → FAIL (module missing).

- [ ] **Step 3: Implement** — `scripts/lib/sitemap-pages.js`

```javascript
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
const SUBAREA_RE = /<SubArea\b[^>]*>/gi;
const GENPAGE_ATTR = /\bGenPageId="([0-9a-fA-F-]{36})"/i;
const TITLE_ATTR = /\bTitle="([^"]*)"/i;
const DESC_ATTR = /\bDescription="([^"]*)"/i;

// Decode the 5 predefined XML entities so a sitemap Title like "Orders &amp; Overview" becomes a usable page
// NAME ("Orders & Overview") on the download round-trip (Imp9). Sitemap free-text is XML-ESCAPED by the SDK's
// safe-DOM factory (see vendor-sdk-smoke CONTRACT), so we must reverse it before treating a Title as a name.
function decodeXmlEntities(s) {
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&apos;/g, "'").replace(/&amp;/g, '&'); // &amp; LAST so "&amp;lt;" → "&lt;"
}

function sitemapGenPages(xml) {
  const s = String(xml || '');
  const seen = new Set();
  const out = [];
  let m;
  while ((m = SUBAREA_RE.exec(s)) !== null) {
    const tag = m[0];
    const g = GENPAGE_ATTR.exec(tag);
    if (!g) continue;
    const pageId = g[1];
    const key = pageId.toLowerCase();
    if (seen.has(key)) continue; // a page attached in two areas → one entry
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

// Fetch the app's LIVE sitemap, FAIL-CLOSED and DISCRIMINATED (C4). appmodule (by unique name) →
// appmodulecomponent (componenttype 62 — the sitemap) → sitemap.sitemapxml. The three not-found cases are
// DISTINCT reasons (the old sitemapXmlFor collapsed them all to '' — indistinguishable from a valid page-less
// sitemap — which let reconcile/verify read "no live pages" and recreate-all). A VALID sitemap with zero
// genpages is { ok:true, ids:[] }; a missing row / unreadable XML / query error is { ok:false, reason }.
// componenttype 62 == sitemap (https://learn.microsoft.com/power-apps/developer/data-platform/reference/entities/appmodulecomponent).
async function fetchSitemap(sdk, appUnique) {
  let apps;
  try {
    apps = await sdk.queryRecords('appmodule', { select: ['appmoduleid', 'appmoduleidunique'], filter: `uniquename eq '${odataLit(appUnique)}'`, top: 1 });
  } catch (e) { return { ok: false, reason: 'appmodule-query-failed', detail: String((e && e.message) || e) }; }
  const app = apps && apps[0];
  if (!app) return { ok: false, reason: 'app-not-found' };
  let comps;
  try {
    // _appmoduleidunique_value is a lookup GUID → UNQUOTED in the OData filter (quoting it 400s).
    comps = await sdk.queryRecords('appmodulecomponent', { select: ['objectid', 'componenttype'], filter: `_appmoduleidunique_value eq ${app.appmoduleidunique} and componenttype eq 62`, top: 1 });
  } catch (e) { return { ok: false, reason: 'sitemap-component-query-failed', detail: String((e && e.message) || e) }; }
  const smId = comps && comps[0] && comps[0].objectid;
  if (!smId) return { ok: false, reason: 'sitemap-component-not-found' };
  let sms;
  try {
    sms = await sdk.queryRecords('sitemap', { select: ['sitemapxml'], filter: `sitemapid eq ${smId}`, top: 1 });
  } catch (e) { return { ok: false, reason: 'sitemap-query-failed', detail: String((e && e.message) || e) }; }
  const xml = sms && sms[0] && sms[0].sitemapxml;
  // A deployed app ALWAYS has non-empty sitemapxml; empty/null is anomalous → fail-closed (NOT "valid, empty").
  if (!xml) return { ok: false, reason: 'sitemap-xml-unreadable' };
  return { ok: true, xml: String(xml), ids: sitemapGenPageIds(String(xml)) };
}

// Env-wide MEMBERSHIP scan (Imp5): which apps' sitemaps reference each of `pageIds`. GROUNDED by a live
// Dataverse probe (aurorabapenv03468): a generative page has **NO `appmodulecomponent` row** —
// `appmodulecomponents?$filter=objectid eq <genPageId>` returns 0 rows, and an app's only component is the
// sitemap (`componenttype 62`). So a genpage's app membership lives ONLY inside the sitemap XML
// (`GenPageId="…"`), with **no direct genpage→apps join**. The ONLY way to find a page shared across apps is
// to scan every OTHER app's sitemap XML for the id. Cost: O(number of apps) — one appmodule list + one
// sitemap read per OTHER app. `excludeAppUnique` skips the app being built (self can't share with itself), so
// a SINGLE-APP environment reads ZERO other sitemaps (minimal work). FAIL-CLOSED on the enumeration itself (a
// failed appmodule list → { ok:false } so the caller refuses to UPDATE without verifying safety); BEST-EFFORT
// per app (an app whose sitemap we cannot read is recorded in `unreadable` and skipped, so one unreadable app
// doesn't block the whole env — the caller warns about partial coverage). It relies on each app's CURRENT
// sitemapxml, so a page added to an app whose sitemap wasn't refreshed is not seen (documented limit).
async function fetchAppsForPages(sdk, pageIds, opts = {}) {
  const want = new Set(Array.from(pageIds || []).map((x) => String(x).toLowerCase()));
  if (!want.size) return { ok: true, byId: new Map(), unreadable: [] };
  const self = opts.excludeAppUnique ? String(opts.excludeAppUnique).toLowerCase() : null;
  let apps;
  try {
    apps = await sdk.queryRecords('appmodule', { select: ['appmoduleid', 'appmoduleidunique', 'uniquename'], top: 500 });
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; } // fail-closed: can't enumerate ⇒ can't verify
  // Skip self up front so a single-app env reads no sitemaps at all (minimal work).
  const others = (apps || []).filter((a) => a && a.uniquename && String(a.uniquename).toLowerCase() !== self);
  const byId = new Map();
  const unreadable = [];
  for (const a of others) {
    const r = await fetchSitemap(sdk, a.uniquename); // reuse the discriminated reader (DRY)
    if (!r.ok) { unreadable.push(a.uniquename); continue; } // best-effort: record + skip (partial-coverage warning)
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
```

- [ ] **Step 4: Run to verify it passes** — `node --test scripts/tests/sitemap-pages.test.js` → PASS.
- [ ] **Step 5: Full suite** — `node scripts/run-tests.js` → PASS (688).
- [ ] **Step 6: Commit** — `git add scripts/lib/sitemap-pages.js scripts/tests/sitemap-pages.test.js` + trailers.

---

## Task 2: `genpage-cli.js` — env-wide EXISTENCE `enumerateEnv` + fix uncertain-create (env-wide diff) + download by id

Add the env-wide **EXISTENCE** enumeration (the id set that drives crash-safe reconcile) and redesign `upload`'s uncertain-create recovery to use it (C2 — the current recovery enumerates **app-scoped**, so a just-created not-yet-in-sitemap page reads as absent → duplicate CREATE). Add `download --page-id` so verify/download pull exactly the sitemap's pages.

**Files:**
- Modify: `scripts/lib/genpage-cli.js` — add `enumerateEnv`; rewrite the `upload` uncertain-create recovery (`:178-236`); add `pageIds` to `download` (`:243-248`).
- Modify: `scripts/tests/genpage-cli.test.js` — new `enumerateEnv`, upload-C2, and download-by-id tests.

**Interfaces:**
- `enumerateEnv() → Promise<{ ok:true, ids:string[], pages:[{pageId,name}] } | { ok:false, ids:[], error }>` — env-wide `pac model genpage list` (NO `--app-id`, WITH `--include-unpublished` so a just-created draft counts, C1). Reuses `classifyListOutput` (fail-closed on unrecognized/incomplete). `ids` are **lower-cased**; `pages` carries names for the C2 name-diff.
- `upload({ appId, pageId, codeFile, name, prompt, agentMessage, dataSources })` — unchanged signature; the uncertain-create recovery now uses `enumerateEnv` before/after id diff.
- `download({ appId, outputDir, pageIds })` — when `pageIds` (non-empty) is provided, pass `--page-id <comma-joined>`; otherwise all-pages (back-compat).

> The app-scoped `list`/`enumerate` methods stay (still tested), but are no longer on any production create/verify/download path after this plan. `pac` accepts `--include-unpublished` and `--page-id <comma ids>` (help-confirmed).

- [ ] **Step 1: Write the failing tests** — append to `scripts/tests/genpage-cli.test.js`

```javascript
const GP_A = '13ecbc57-a3a4-4132-b0a2-a6c6b12691e8';
const GP_B = '5c0a4889-45fd-46ea-91a8-ff876914d644';
// Build a real fixed-width `pac genpage list` table (Page ID / Name / Published) for N pages.
function envList(rows) {
  const header = 'Page ID                              Name             Published';
  const body = rows.map((r) => `${r.pageId} ${String(r.name).padEnd(16)} -`).join('\n');
  return `Connected as user@contoso.com\nRetrieving generated pages...\nFound ${rows.length} generated page(s):\n\n${header}\n${body}\n`;
}

test('enumerateEnv runs env-wide (NO --app-id, WITH --include-unpublished) and returns lower-cased ids + pages', async () => {
  let seen;
  const run = async (args) => { seen = args; return { status: 0, stdout: envList([{ pageId: GP_A, name: 'Overview' }, { pageId: GP_B, name: 'Order Detail' }]), stderr: '' }; };
  const r = await makeGenpageCli('https://x', { run, sleep: async () => {} }).enumerateEnv();
  assert.ok(!seen.includes('--app-id'), 'env-wide: no --app-id');
  assert.ok(seen.includes('--include-unpublished'), 'drafts included so a just-created page counts (C1)');
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.ids, [GP_A, GP_B]); // already lower-case here
  assert.strictEqual(r.pages.length, 2);
});

test('enumerateEnv is FAIL-CLOSED on an unrecognized/incomplete listing (never masquerades as empty)', async () => {
  // count says 2 but only 1 row parsed → classifyListOutput 'unrecognized'
  const run = async () => ({ status: 0, stdout: envList([{ pageId: GP_A, name: 'Overview' }]).replace('Found 1', 'Found 2'), stderr: '' });
  const r = await makeGenpageCli('https://x', { run, sleep: async () => {}, attempts: 2 }).enumerateEnv();
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(r.ids, []);
  assert.match(r.error, /unrecognized|incomplete|after 2 attempt/i);
});

test('upload uncertain-CREATE: an env-wide before/after diff showing ONE new id for our name → adopt+UPDATE (no 2nd CREATE) (C2)', async () => {
  let creates = 0;
  let listCall = 0;
  const run = async (args) => {
    if (args.includes('upload')) { creates += 1; return { status: 0, stdout: 'done, no id here', stderr: '' }; } // uncertain: zero-exit, NO Page ID
    // 1st list = BEFORE (empty); 2nd list = AFTER (our page landed)
    listCall += 1;
    return { status: 0, stdout: listCall === 1 ? envList([]) : envList([{ pageId: GP_A, name: 'Overview' }]), stderr: '' };
  };
  const up = await makeGenpageCli('https://x', { run, sleep: async () => {}, attempts: 3 }).upload({ appId: 'app', codeFile: 'o.tsx', name: 'Overview', prompt: 'p', agentMessage: 'm' });
  assert.strictEqual(up.pageId, GP_A, 'adopted the one NEW id and UPDATEd it (matched by name)');
  assert.strictEqual(creates, 1, 'exactly ONE create — the env-wide diff proved it landed; never a blind 2nd CREATE');
});

test('upload uncertain-CREATE: env enumeration failure → THROW (never blind-retry a CREATE) (C2)', async () => {
  const run = async (args) => (args.includes('upload') ? { status: 0, stdout: 'no id', stderr: '' } : { status: 1, stdout: '', stderr: 'list failed' });
  await assert.rejects(
    makeGenpageCli('https://x', { run, sleep: async () => {}, attempts: 2 }).upload({ appId: 'app', codeFile: 'o.tsx', name: 'Overview', prompt: 'p', agentMessage: 'm' }),
    /refusing to (create|retry)|enumeration failed/i,
  );
});

test('download passes --page-id <comma-joined> when pageIds is provided; omits it otherwise', async () => {
  let seen;
  const run = async (args) => { if (args[2] === 'download') { seen = args; } return { status: 0, stdout: '', stderr: '' }; };
  const cli = makeGenpageCli('https://x', { run, sleep: async () => {} });
  await cli.download({ appId: 'a', outputDir: 'o', pageIds: [GP_A, GP_B] });
  const i = seen.indexOf('--page-id');
  assert.ok(i > 0 && seen[i + 1] === `${GP_A},${GP_B}`, 'ids comma-joined');
  await cli.download({ appId: 'a', outputDir: 'o' });
  assert.ok(!seen.includes('--page-id'), 'no --page-id when not requested (all-pages back-compat)');
});
```

- [ ] **Step 2: Run to verify it fails** — `node --test scripts/tests/genpage-cli.test.js` → FAIL.

- [ ] **Step 3a: Implement `enumerateEnv`** — in `makeGenpageCli` (after `enumeratePages`, `scripts/lib/genpage-cli.js:171`):

```javascript
  // Env-WIDE EXISTENCE enumeration (NO --app-id): the set of ALL generative-page ids that exist in the
  // environment (design: the EXISTENCE authority). `--include-unpublished` so a just-created draft counts —
  // this is what makes reconcile crash-safe (a page created+manifested but not yet finalized into the sitemap
  // still shows up here → reused, never re-created; C1). Reuses classifyListOutput (fail-closed). Returns
  // lower-cased `ids` + `pages` (names, for the upload uncertain-create name-diff, C2). Fail-closed: an
  // unrecognized/incomplete listing NEVER masquerades as an empty environment.
  async function enumerateEnv() {
    let lastErr = '';
    for (let i = 0; i < attempts; i += 1) {
      const r = await run(['model', 'genpage', 'list', '--environment', env, '--include-unpublished']);
      if (r.status === 0) {
        const c = classifyListOutput(r.stdout);
        if (c.kind !== 'unrecognized') {
          const pages = c.pages || [];
          return { ok: true, ids: pages.map((p) => String(p.pageId).toLowerCase()), pages };
        }
        lastErr = 'unrecognized/incomplete env-wide `pac genpage list` output (zero exit, no valid listing or a count mismatch) — refusing to treat as empty';
      } else {
        lastErr = lastLine(r);
      }
      if (i < attempts - 1) await sleep(500 * (i + 1));
    }
    return { ok: false, ids: [], error: `pac genpage list (env-wide) failed after ${attempts} attempt(s): ${lastErr}` };
  }
```

- [ ] **Step 3b: Rewrite `upload`'s uncertain-create recovery** — replace the `upload` body (`:178-236`) with the env-wide before/after diff (keep the I7 UPDATE-identity guard verbatim):

```javascript
    // Create (no pageId) or update (with pageId) a page's content. On an UNCERTAIN CREATE (non-zero, or
    // zero-exit with no Page ID) resolve via an ENV-WIDE before/after id diff (C2) — NEVER app-scoped (a
    // just-created not-yet-in-sitemap page is invisible there → false-absent → duplicate). Enumeration
    // failure → THROW (can't verify; refuse to risk a duplicate).
    async upload({ appId, pageId, codeFile, name, prompt, agentMessage, dataSources }) {
      const once = async (pid) => {
        const args = ['model', 'genpage', 'upload', '--environment', env, '--app-id', appId, '--code-file', codeFile];
        if (pid) args.push('--page-id', pid);
        if (name) args.push('--name', name);
        // pac requires BOTH --prompt and --agent-message for a new page.
        args.push('--prompt', prompt && String(prompt).trim() ? String(prompt) : `Generative page ${name || ''}`.trim());
        args.push('--agent-message', agentMessage && String(agentMessage).trim() ? String(agentMessage) : 'Authored by app-builder');
        if (dataSources && dataSources.length) args.push('--data-sources', dataSources.join(','));
        return run(args);
      };
      let pid = pageId;
      let lastErr = '';
      let beforeIds = null; // env-wide id snapshot captured BEFORE the first CREATE attempt (C2)
      for (let i = 0; i < attempts; i += 1) {
        // Snapshot the environment BEFORE the first create so an uncertain outcome is decidable by diff.
        if (!pid && name && beforeIds === null) {
          const before = await enumerateEnv();
          if (!before.ok) throw new Error(`pac genpage upload for '${name}': cannot snapshot the environment before create (${before.error}) — refusing to create (would risk a duplicate)`);
          beforeIds = new Set(before.ids);
        }
        const r = await once(pid);
        if (r.status === 0) {
          const id = parsePageId(r.stdout);
          if (id) {
            // I7 guard: an UPDATE (pid set) MUST return the same id (case-insensitive; PAC may re-case GUIDs).
            if (pid && id.toLowerCase() !== pid.toLowerCase()) {
              throw new Error(`pac genpage upload for '${name}': UPDATE returned an unexpected Page ID (got ${id}, expected ${pid}) — refusing to persist a mismatched update`);
            }
            return { pageId: id };
          }
          lastErr = `returned no Page ID: ${lastLine(r)}`;
        } else {
          lastErr = lastLine(r);
        }
        // Uncertain CREATE (no caller pid): resolve with the env-wide before/after diff. NEVER retry a CREATE
        // unless the env proves the page does NOT exist (zero new ids).
        if (!pid && name) {
          const after = await enumerateEnv();
          if (!after.ok) throw new Error(`pac genpage upload for '${name}' had an uncertain result and env enumeration failed — refusing to retry (would risk a duplicate): ${after.error}`);
          const newPages = after.pages.filter((p) => !beforeIds.has(String(p.pageId).toLowerCase()));
          const ours = newPages.filter((p) => p.name === name);
          if (ours.length === 1) pid = ours[0].pageId;            // our CREATE landed → adopt; next iter UPDATEs
          else if (ours.length > 1) throw new Error(`pac genpage upload for '${name}': multiple NEW pages share this name after an uncertain create — refusing (ambiguous)`);
          else if (newPages.length === 1) pid = newPages[0].pageId; // exactly one new id (name unknown) → adopt
          else if (newPages.length === 0) { /* did NOT land → safe to retry a CREATE (pid stays undefined) */ }
          else throw new Error(`pac genpage upload for '${name}': ${newPages.length} new pages appeared after an uncertain create but none match this name — refusing to guess (ambiguous)`);
        }
        if (i < attempts - 1) await sleep(500 * (i + 1));
      }
      throw new Error(`pac genpage upload failed for '${name}' after ${attempts} attempt(s): ${lastErr}`);
    },
```

- [ ] **Step 3c: Add `pageIds` to `download`** — replace the `download` method (`:243-248`):

```javascript
    // Download page CONTENT into `outputDir/<pageId>/{page.tsx,page.js,config.json,prompt.txt}`. With
    // `pageIds` (non-empty) pull EXACTLY those ids by `--page-id <comma>` (the sitemap's pages — headless-free,
    // real content); omit the flag to keep the all-pages behavior for any legacy caller.
    async download({ appId, outputDir, pageIds }) {
      const args = ['model', 'genpage', 'download', '--environment', env, '--app-id', appId, '--output-directory', outputDir];
      if (pageIds && pageIds.length) args.push('--page-id', pageIds.join(','));
      const r = await run(args);
      if (r.status !== 0) throw new Error(`pac genpage download failed: ${lastLine(r)}`);
      return true;
    },
```

- [ ] **Step 3d: Export** — add `enumerateEnv` to the returned object (next to `enumerate`, `:240-242`):

```javascript
    enumerateEnv() { return enumerateEnv(); },
```

- [ ] **Step 4: Run to verify it passes** — `node --test scripts/tests/genpage-cli.test.js` → PASS.
- [ ] **Step 5: Full suite** — `node scripts/run-tests.js` → PASS (≈ 693).
- [ ] **Step 6: Commit** — `git add scripts/lib/genpage-cli.js scripts/tests/genpage-cli.test.js` + trailers.

---

## Task 3: App Spec validation — every page placed + accept optional `pages[].pageId`; fix the eval harness (Imp8)

Enforce the MEMBERSHIP invariant at authoring time (every page is a sitemap subarea) and **accept** an optional `pages[].pageId` so a downloaded **edit-snapshot** spec validates (C3). Because `validateAppSpec(..., {profile:'plan'})` now rejects headless pages AND the app-builder eval harness author stage validates with the `plan` profile (`evals/model-apps/app-builder/lib/facts.js:26`), the headless `order-detail` fixture (`fixtures/2-orders-multipage/app-spec.json`) must be fixed in the SAME task, and the harness run (exit 0) added (Imp8).

**Files:**
- Modify: `scripts/lib/app-spec.js` — the page loop (`:500-551`, accept `pageId`) + after the sitemap-subarea loop (`:591`, every-page-placed).
- Modify: `scripts/tests/app-spec.test.js` — new assertions.
- Modify: `evals/model-apps/app-builder/fixtures/2-orders-multipage/app-spec.json` — place `order-detail`.
- Verify: `evals/model-apps/app-builder/lib/facts.js` already uses `profile: 'plan'` for the author stage (`:26`) — no change; confirm and run the harness.

**Interfaces:**
- Consumes: `isV2`, `pageKeysSet` (built before the page loop, `:473-474`), `profile` (`:255`), `VALIDATION_PROFILES` (`:229`).
- Produces: a new error `page '<key>' is not placed in the sitemap — every page must be an appShell subarea (a page reached only by navigation is not owned by the app; add a subarea for it)`; and acceptance of `pages[].pageId` (a non-empty string) as an edit-snapshot marker.

> **Profile scope:** enforce placement for `deploy`, `plan`, and `design` (a spec that will be built). The `structural` profile (pure fact extraction) skips it. `VALIDATION_PROFILES = ['design','plan','deploy','structural']` (`:229`); `profile = opts.profile || 'deploy'` (`:255`).

- [ ] **Step 1: Write the failing tests** — append to `scripts/tests/app-spec.test.js`

```javascript
const { test } = require('node:test');
const assert = require('node:assert');
const { validateAppSpec, migrateAppSpec } = require('../lib/app-spec.js');

function v2PagesSpec(subAreas, extraPageFields = {}) {
  return migrateAppSpec({
    schemaVersion: 2,
    solution: { uniqueName: 'S', publisherPrefix: 'new' },
    app: { name: 'A' },
    entities: [{ schemaName: 'new_order', displayName: 'Order', primaryAttribute: { schemaName: 'new_name', displayName: 'Order #' }, columns: [] }],
    pages: [
      { key: 'overview', name: 'Overview', source: { kind: 'tsx', codeFile: 'overview.tsx' }, navigatesTo: [{ targetKey: 'order-detail' }], ...extraPageFields },
      { key: 'order-detail', name: 'Order Detail', source: { kind: 'tsx', codeFile: 'order-detail.tsx' } },
    ],
    appShell: { areas: [{ label: 'Sales', groups: [{ label: 'Work', subAreas }] }] },
  });
}

test('validateAppSpec REJECTS a headless page (nav target with no sitemap subarea) — plan profile', () => {
  const spec = v2PagesSpec([{ page: 'overview', title: 'Overview' }, { entity: 'new_order', title: 'Orders' }]); // order-detail headless
  const r = validateAppSpec(spec, { profile: 'plan' });
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => /order-detail/.test(e) && /not placed in the sitemap/i.test(e)), JSON.stringify(r.errors));
});

test('validateAppSpec ACCEPTS when every page is a sitemap subarea', () => {
  const spec = v2PagesSpec([{ page: 'overview', title: 'Overview' }, { page: 'order-detail', title: 'Order Detail' }, { entity: 'new_order', title: 'Orders' }]);
  assert.ok(validateAppSpec(spec, { profile: 'plan' }).ok, JSON.stringify(validateAppSpec(spec, { profile: 'plan' }).errors));
});

test('the structural profile does NOT enforce placement (eval-harness shape-only)', () => {
  const spec = v2PagesSpec([{ page: 'overview', title: 'Overview' }]); // order-detail headless
  assert.ok(!validateAppSpec(spec, { profile: 'structural' }).errors.some((e) => /not placed in the sitemap/.test(e)));
});

test('validateAppSpec ACCEPTS an optional pages[].pageId (edit-snapshot, C3); rejects a non-string/empty one', () => {
  const ok = v2PagesSpec([{ page: 'overview', title: 'Overview' }, { page: 'order-detail', title: 'Order Detail' }], { pageId: '13ecbc57-a3a4-4132-b0a2-a6c6b12691e8' });
  assert.ok(validateAppSpec(ok, { profile: 'plan' }).ok, JSON.stringify(validateAppSpec(ok, { profile: 'plan' }).errors));
  const bad = v2PagesSpec([{ page: 'overview', title: 'Overview' }, { page: 'order-detail', title: 'Order Detail' }], { pageId: '' });
  assert.ok(!validateAppSpec(bad, { profile: 'plan' }).ok, 'an empty pageId is rejected');
});
```

- [ ] **Step 2: Run to verify it fails** — `node --test scripts/tests/app-spec.test.js` → FAIL.

- [ ] **Step 3a: Accept `pages[].pageId`** — inside the page loop in `validateAppSpec`, after the case-insensitive name-uniqueness block (`scripts/lib/app-spec.js:507`), add:

```javascript
    // A page MAY carry its own deployed `pageId` — this marks the spec as an EDIT-SNAPSHOT (env-specific:
    // downloaded from a live app, so it self-describes each page's identity). A portable fresh-authored spec
    // omits it. reconcilePageIds treats a present pageId as the HIGHEST identity authority (above the
    // manifest) so a downloaded app — incl. pages a Maker user added — rebuilds without duplicating (C3).
    if (p.pageId !== undefined && (typeof p.pageId !== 'string' || !p.pageId)) {
      errors.push(`page '${p.key || p.name}': pageId, when present, must be a non-empty string (the deployed GenPageId)`);
    }
```

- [ ] **Step 3b: Enforce every-page-placed** — after the sitemap-subarea loop closes (after `scripts/lib/app-spec.js:591`, still inside `validateAppSpec` with `isV2`/`profile`/`errors` in scope):

```javascript
  // Every generative page MUST be attached to the app's sitemap (MEMBERSHIP): a page reached only by
  // navigation is not owned by the app (model-driven-app membership IS sitemap presence — there is no
  // hidden-but-navigable subarea). Enforce for a spec that will be BUILT (deploy/plan/design); `structural`
  // is shape-only (the eval harness) and skips it. This is what lets build/verify/download treat the
  // sitemap's GenPageId set as the complete, authoritative MEMBERSHIP list (Plan 5 v2).
  if (isV2 && profile !== 'structural') {
    const sitemappedPageKeys = new Set();
    for (const a of (spec.appShell && spec.appShell.areas) || [])
      for (const g of a.groups || [])
        for (const sa of g.subAreas || []) if (sa && sa.page) sitemappedPageKeys.add(sa.page);
    for (const p of spec.pages || []) {
      const key = p.key || p.name;
      if (!sitemappedPageKeys.has(key)) {
        errors.push(`page '${key}' is not placed in the sitemap — every page must be an appShell subarea (a page reached only by navigation is not owned by the app; add a subarea for it)`);
      }
    }
  }
```

> `migrateAppSpec` already rewrites name-based `sa.page` refs to keys (`:770-772`) and `buildManifest`/`hydrate-spec` carry `pageId` through — no schema-doc rename needed here beyond Task 8.

- [ ] **Step 4a: Fix the eval fixture (Imp8)** — in `evals/model-apps/app-builder/fixtures/2-orders-multipage/app-spec.json`, add the `order-detail` subarea so every page is placed. Change the `subAreas` array to:

```json
        { "label": "Work", "subAreas": [
          { "page": "overview", "title": "Overview" },
          { "page": "order-detail", "title": "Order Detail" },
          { "entity": "new_order", "title": "Orders" },
          { "entity": "new_customer", "title": "Customers" }
        ] }
```

- [ ] **Step 4b: Confirm the harness author profile** — `evals/model-apps/app-builder/lib/facts.js:26` is `validateAppSpec(spec, { profile: 'plan' })` (NOT `structural`). No change; this is why the fixture must place every page.

- [ ] **Step 5: Run tests + the harness** — `node --test scripts/tests/app-spec.test.js` → PASS; `node scripts/run-tests.js` (from `plugins/model-apps/`) → watch for any other fixture whose page lacks a subarea and fix it; then, **from the repo root**, `node evals/model-apps/app-builder/run-app-builder.js` → **exit 0** (the 2-orders-multipage author assertions now pass with every page placed). Full suite ≈ 697.
- [ ] **Step 6: Commit** — `git add scripts/lib/app-spec.js scripts/tests/app-spec.test.js evals/model-apps/app-builder/fixtures/2-orders-multipage/app-spec.json` (+ any other fixture you had to place) + trailers.

---

> **⚠ ATOMIC TRIO (Tasks 4 + 5 + 6) — Imp10.** `reconcilePageIds`'s signature change breaks BOTH callers (build + download). Implement Tasks 4, 5, 6 back-to-back with per-task TDD (each task's own test file runs green in isolation), but **do NOT commit Task 4 or Task 5 alone** — the reconcile signature + both callers land in **ONE commit at the end of Task 6** so the full suite is never committed red. Task 4's own file (`page-manifest.test.js`) passes standalone; the full suite goes green only after Task 6.

## Task 4: `page-manifest.js` — reconcile by EXISTENCE + spec-pageId authority + reject duplicate ids

Change reconcile to key off the **EXISTENCE** id set (env-wide), with a spec page's own `pageId` as the highest authority (C3) and the manifest second (C1). Add `conflicts` for a 1:1 identity violation, and make `parseManifest` reject a manifest that maps two keys to one id (Imp11).

**Files:**
- Modify: `scripts/lib/page-manifest.js` — `reconcilePageIds` (`:165-227`), `parseManifest` (`:90-142`).
- Modify: `scripts/tests/page-manifest.test.js` — rewrite the reconcile tests + add the dup-id parse test.

**Interfaces (breaking — Tasks 5/6 updated to match):**
- `reconcilePageIds(pages, manifest, existenceIds) → { keyToId: Map<key,id>, absentKeys: string[], conflicts: [{ pageId, keys:[…] }] }`, where `existenceIds` is an **array/Set of page ids that EXIST** (case-insensitive). Authority per page key:
  1. the spec page's own `p.pageId` **and** it ∈ `existenceIds` → reuse (EDIT-SNAPSHOT, highest — C3). A stale cross-env id (not in existence) falls through.
  2. else `manifest[key].pageId` **and** it ∈ `existenceIds` → reuse (C1 — a crash-orphaned page still in existence is reused, even if not yet in the sitemap).
  3. else → `absentKeys` (create).
  - `conflicts`: any live id that ≥2 distinct keys resolve to (a 1:1 violation) → the caller HALTs. No name lookup, no `ambiguous` return.
- `parseManifest` now also rejects a manifest whose pages map two keys to the same `pageId` (case-insensitive) — a 1:1 key↔id identity conflict → `null` (fail-closed).

- [ ] **Step 1: Rewrite the reconcile tests + add the dup-id parse test** — replace the `reconcilePageIds` tests in `scripts/tests/page-manifest.test.js`

```javascript
const { reconcilePageIds, parseManifest } = require('../lib/page-manifest.js');

const GP_O = '13ecbc57-a3a4-4132-b0a2-a6c6b12691e8';
const GP_D = '5c0a4889-45fd-46ea-91a8-ff876914d644';
const MAN = { schemaVersion: 1, pages: [
  { key: 'overview', name: 'Overview', pageId: GP_O },
  { key: 'order-detail', name: 'Order Detail', pageId: GP_D },
] };

test('reconcile binds key→id when the manifest id EXISTS (case-insensitive)', () => {
  const pages = [{ key: 'overview', name: 'Overview' }, { key: 'order-detail', name: 'Order Detail' }];
  const { keyToId, absentKeys, conflicts } = reconcilePageIds(pages, MAN, [GP_O.toUpperCase(), GP_D]);
  assert.strictEqual(keyToId.get('overview'), GP_O);
  assert.strictEqual(keyToId.get('order-detail'), GP_D);
  assert.deepStrictEqual(absentKeys, []);
  assert.deepStrictEqual(conflicts, []);
});

test('reconcile: crash-safety — a manifest id in EXISTENCE but NOT in the sitemap is REUSED (C1)', () => {
  // Existence includes GP_O (created + manifested), even though the sitemap doesn't (finalizer died).
  const { keyToId, absentKeys } = reconcilePageIds([{ key: 'overview', name: 'Overview' }], MAN, [GP_O]);
  assert.strictEqual(keyToId.get('overview'), GP_O, 'reused from existence — NOT re-created');
  assert.deepStrictEqual(absentKeys, []);
});

test('reconcile: a spec page pageId OUTRANKS the manifest (edit-snapshot, C3) when it exists', () => {
  const pages = [{ key: 'overview', name: 'Overview', pageId: GP_D }]; // spec self-describes a DIFFERENT id
  const { keyToId } = reconcilePageIds(pages, MAN, [GP_O, GP_D]);
  assert.strictEqual(keyToId.get('overview'), GP_D, 'spec pageId wins over the manifest id');
});

test('reconcile: a stale spec pageId (not in existence) falls through to the manifest', () => {
  const pages = [{ key: 'overview', name: 'Overview', pageId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' }];
  const { keyToId } = reconcilePageIds(pages, MAN, [GP_O]); // stale id absent; manifest GP_O exists
  assert.strictEqual(keyToId.get('overview'), GP_O);
});

test('reconcile: absent when neither spec nor manifest id EXISTS (fresh build / Maker delete)', () => {
  const pages = [{ key: 'overview', name: 'Overview' }];
  assert.deepStrictEqual(reconcilePageIds(pages, null, []).absentKeys, ['overview']);
  assert.deepStrictEqual(reconcilePageIds(pages, MAN, []).absentKeys, ['overview']); // manifest id not live → absent
});

test('reconcile: two keys resolving to ONE live id → conflicts (1:1 violation), never a silent collapse', () => {
  const pages = [{ key: 'a', name: 'A', pageId: GP_O }, { key: 'b', name: 'B', pageId: GP_O }];
  const { conflicts } = reconcilePageIds(pages, null, [GP_O]);
  assert.strictEqual(conflicts.length, 1);
  assert.strictEqual(conflicts[0].pageId, GP_O);
  assert.deepStrictEqual(conflicts[0].keys.sort(), ['a', 'b']);
});

test('reconcile never returns `ambiguous` (id matching is unambiguous)', () => {
  assert.ok(!('ambiguous' in reconcilePageIds([{ key: 'overview', name: 'Overview' }], MAN, [GP_O])));
});

test('parseManifest REJECTS two keys mapping to the same pageId (case-insensitive 1:1 identity conflict, Imp11)', () => {
  const dup = JSON.stringify({ schemaVersion: 1, pages: [
    { key: 'a', name: 'A', pageId: GP_O },
    { key: 'b', name: 'B', pageId: GP_O.toUpperCase() },
  ] });
  assert.strictEqual(parseManifest(dup), null);
});
```

- [ ] **Step 2: Run to verify it fails** — `node --test scripts/tests/page-manifest.test.js` → FAIL (old signature takes `livePages` objects; returns `ambiguous`; parse allows dup ids).

- [ ] **Step 3a: Reject duplicate pageIds in `parseManifest`** — in the page loop (`scripts/lib/page-manifest.js:90-139`), add a `seenIds` set alongside the existing `seen` (keys) set and check `pageId`:

```javascript
  const seen = new Set();
  const seenIds = new Set(); // Imp11: enforce a 1:1 key↔id map — two keys sharing a pageId is corrupt.
```

Then extend the existing `pageId` check (`:106`) to reject a duplicate id:

```javascript
    // pageId — when present, must be a non-empty string AND unique across keys (1:1 identity, Imp11). Two
    // keys mapping to the same live page is an identity conflict; reconstruct from live state rather than
    // trust a corrupt payload (fail-closed).
    if (p.pageId !== undefined) {
      if (typeof p.pageId !== 'string' || !p.pageId) return null;
      const idLower = p.pageId.toLowerCase();
      if (seenIds.has(idLower)) return null;
      seenIds.add(idLower);
    }
```

- [ ] **Step 3b: Rewrite `reconcilePageIds`** — replace `:153-227`:

```javascript
// Reconcile the spec's declared pages against the durable manifest AND the app's EXISTENCE id set (env-wide
// `pac model genpage list` — Plan 5 v2; genpage-cli.enumerateEnv). Identity is matched BY ID, highest first:
//   1. the spec page's OWN pageId (EDIT-SNAPSHOT, C3) — reuse it when the environment still HAS that page.
//      This lets a downloaded app (incl. Maker-added pages absent from our manifest) rebuild without
//      duplicating. A stale cross-env id (absent from existence) falls through to the manifest.
//   2. manifest key→pageId, confirmed by EXISTENCE (env-wide, NOT sitemap membership — C1 crash-safety): a
//      page created + manifested but not yet finalized into the sitemap is still in existence → reused.
//   3. otherwise → absent (mint a fresh id via a create).
// There is no name-based adoption. `conflicts` reports any live id that TWO+ distinct keys resolve to (a 1:1
// identity violation), which the caller HALTs on rather than overwrite an arbitrary page.
// `existenceIds` is an array/Set of ids that EXIST (case-insensitive). Returns { keyToId, absentKeys, conflicts }.
function reconcilePageIds(pages, manifest, existenceIds) {
  const existSet = new Set(Array.from(existenceIds || []).map((id) => String(id).toLowerCase()));
  const manifestByKey = new Map(
    ((manifest && manifest.pages) || []).filter((p) => p && p.key).map((p) => [p.key, p]),
  );
  const keyToId = new Map();
  const absentKeys = [];
  for (const p of pages || []) {
    const key = p.key || p.name;
    let id;
    if (p.pageId && existSet.has(String(p.pageId).toLowerCase())) {
      id = p.pageId; // (1) edit-snapshot, highest authority
    } else {
      const mp = manifestByKey.get(key);
      if (mp && mp.pageId && existSet.has(String(mp.pageId).toLowerCase())) id = mp.pageId; // (2) manifest, by existence
    }
    if (id) keyToId.set(key, id);
    else absentKeys.push(key); // (3) create
  }
  // 1:1 identity guard: two distinct keys must not resolve to the same live id (an ambiguous overwrite).
  const keysById = new Map();
  for (const [key, id] of keyToId) {
    const k = String(id).toLowerCase();
    const arr = keysById.get(k) || [];
    arr.push(key);
    keysById.set(k, arr);
  }
  const conflicts = [];
  for (const [pageId, keys] of keysById) if (keys.length > 1) conflicts.push({ pageId, keys });
  return { keyToId, absentKeys, conflicts };
}
```

- [ ] **Step 4: Run this task's file** — `node --test scripts/tests/page-manifest.test.js` → PASS. (The FULL suite stays RED until Tasks 5 + 6 migrate the callers — that is expected; do NOT commit yet, per the atomic-trio note.)
- [ ] **Step 5: (no commit yet)** — proceed directly to Task 5; the trio commits together at Task 6.

---

## Task 5: Build engine — existence-driven reconcile + shared-page HALT + destructive-removal gate + fail-closed membership

The pages phase drops the app-scoped `genpageCli.enumerate` and instead: reads **EXISTENCE** via `enumerateEnv` (drives reconcile), reads **MEMBERSHIP** via `fetchSitemap` (removal detection + finalize verification), HALTs on identity conflicts, HALTs on a page shared across apps (Imp5), and HALTs (gated by `--allow-destructive`) on a page the spec removed but that is still live (Imp6). Everything after reconcile (scan/parity → create-absent-first → resolve → upload-once → persist → finalize) is unchanged.

**Files:**
- Modify: `scripts/lib/sdk-build.js` — require `sitemap-pages.js`; the pages phase (`:1148-1271`); read `opts.allowDestructive`.
- Modify: `scripts/build-model-app.js` — thread `allowDestructive` into the `runBuild(...)` call (`:230-242`).
- Modify: `scripts/tests/sdk-build.test.js`, `scripts/tests/sdk-build-pages-deploy.test.js`, `scripts/tests/sdk-build-pages-order.test.js`, `scripts/tests/sdk-build-pages-migrate.test.js` — the SDK mock's `queryRecords` answers the THREE `fetchSitemap` calls (Imp9 — real GUIDs, not a fake `fetchArtifact().siteMap`); the genpageCli mock gains `enumerateEnv`.

**Interfaces:**
- Consumes: `enumerateEnv` (Task 2 — EXISTENCE); `fetchSitemap`/`fetchAppsForPages` (Task 1 — MEMBERSHIP); `reconcilePageIds(pages, manifest, existenceIds)` (Task 4); `readPageManifest`/`persistPageManifest`/`extractNavTargets`/`resolvePageRefs`/`navTargetParity`/`navMalformedRefs`/`writeStagingFile`/`acquireAppPagesLease` (unchanged).
- Produces: `result.created.pages[key] = id`; manifest persisted; new HALT codes `pages-existence-failed`, `pages-identity-conflict`, `pages-shared-across-apps`, `pages-shared-check-failed` (fail-closed on an env-scan error), `pages-removed`, `pages-sitemap-read-failed`. **Removed:** `pages-enumeration-failed`, `pages-ambiguous-name` (no app-scoped `list`; id matching is unambiguous). Kept: `pages-requires-app`, `pages-malformed-navref`, `pages-nav-parity`, `pages-dangling-navref`, `pages-update-identity-mismatch`, `pages-locked`.

- [ ] **Step 1: Update the shared SDK/genpageCli mocks (Imp9)** — in EACH pages test file's mock, (a) drop `enumerate` from the genpageCli mock and add `enumerateEnv`, (b) make `queryRecords` answer `appmodule`/`appmodulecomponent`/`sitemap` (with `sitemapxml`) so `fetchSitemap` works. Concretely, in `sdk-build.test.js`'s `mockSdk`, replace the `queryRecords` and add a `liveSitemapXml` option:

```javascript
// mockSdk(opts): the genpageCli mock seeds EXISTENCE (enumerateEnv); opts.liveSitemapXml seeds THIS app's
// fetchSitemap (MEMBERSHIP). For the cross-app shared scan (fetchAppsForPages), opts.selfAppUnique is THIS
// app's unique name (= appUniqueName(spec)) and opts.otherApps = [{ uniquename, sitemapxml }] are additional
// apps in the env. Real GUIDs throughout (Imp9); appmoduleidunique lookup GUIDs are per-app.
const APP_ID = 'a1b2c3d4-0000-4000-8000-000000000001';
const SELF_UNIQUE_VALUE = 'c0ffee00-0000-4000-8000-00000000dddd';
const SELF_SITEMAP_ID = '5111e0f2-0000-4000-8000-0000000000aa';
// ...inside queryRecords(e, o):
      const filter = (o && o.filter) || '';
      if (e === 'appmodule') {
        // One row per app: this app + any opts.otherApps. A uniquename-filtered read (inside fetchSitemap)
        // returns just the matching one; the un-filtered list (fetchAppsForPages) returns ALL apps.
        const rows = [{ appmoduleid: APP_ID, appmoduleidunique: SELF_UNIQUE_VALUE, uniquename: opts.selfAppUnique }];
        (opts.otherApps || []).forEach((a, i) => rows.push({ appmoduleid: `app-${i + 2}`, appmoduleidunique: `uv-${i + 2}`, uniquename: a.uniquename }));
        const m = filter.match(/uniquename eq '([^']+)'/);
        return m ? rows.filter((r) => r.uniquename === m[1]) : rows;
      }
      if (e === 'appmodulecomponent') {
        const uv = (filter.match(/_appmoduleidunique_value eq (\S+)/) || [])[1];
        const idx = (opts.otherApps || []).findIndex((_, i) => `uv-${i + 2}` === uv);
        return [{ objectid: uv === SELF_UNIQUE_VALUE ? SELF_SITEMAP_ID : `sm-${idx + 2}`, componenttype: 62 }];
      }
      if (e === 'sitemap') {
        const smId = (filter.match(/sitemapid eq (\S+)/) || [])[1];
        if (smId === SELF_SITEMAP_ID) return [{ sitemapxml: opts.liveSitemapXml || '<SiteMap><Area><Group></Group></Area></SiteMap>' }];
        const idx = Number(String(smId).replace('sm-', '')) - 2;
        return [{ sitemapxml: (opts.otherApps && opts.otherApps[idx] && opts.otherApps[idx].sitemapxml) || '<SiteMap/>' }];
      }
      if (e === 'solution') return [];
      if (e === 'webresource') { if (/_pagemanifest'/.test(filter)) return opts.pageManifest ? [{ webresourceid: opts.manifestId || 'wr-manifest', content: opts.pageManifest }] : []; return []; }
      if (e === 'systemform') return [];
      if (e === 'savedquery') return [{ savedqueryid: 'defview-x', isdefault: true }];
      return [{ publisherid: 'pub-1' }];
```

And the genpageCli mock gains `enumerateEnv` (drop `enumerate`):

```javascript
    enumerateEnv: async () => ({ ok: true, ids: (live || []).map((p) => String(p.pageId).toLowerCase()), pages: live || [] }),
```

> Import `appUniqueName` in the test file (already exported from `sdk-build.js`, used by `sdk-build-pages-order.test.js:10`) so each test can pass `selfAppUnique: appUniqueName(spec)` — this is what lets `fetchAppsForPages`'s `excludeAppUnique` skip THIS app (so a normal single-app build never self-flags as shared).

- [ ] **Step 2: Add the C1 crash-safety + Imp5/Imp6 tests** — replace the deleted `pages-enumeration-failed`/`pages-ambiguous-name` tests with:

```javascript
const GP_O = '13ecbc57-a3a4-4132-b0a2-a6c6b12691e8';

test('pages: crash-after-create convergence — a manifest id in EXISTENCE but NOT in the sitemap is UPDATED, never re-created (C1)', async () => {
  const spec = makeSpec(); spec.schemaVersion = 2;
  spec.pages = [{ key: 'overview', name: 'Overview', source: { kind: 'tsx', codeFile: 'o.tsx' } }];
  spec.appShell.areas[0].groups[0].subAreas.push({ page: 'overview', title: 'Overview' });
  const appUnique = appUniqueName(spec);
  const appDir = stagePages(spec.pages);
  try {
    const existing = Buffer.from(JSON.stringify({ schemaVersion: 1, pages: [{ key: 'overview', name: 'Overview', pageId: GP_O }] }), 'utf8').toString('base64');
    // EXISTENCE has GP_O (created + manifested); the SITEMAP is empty (finalizer died before adding the subarea).
    const { sdk } = mockSdk({ pageManifest: existing, manifestId: 'wr-manifest', selfAppUnique: appUnique, liveSitemapXml: '<SiteMap><Area><Group></Group></Area></SiteMap>' });
    const uploads = [];
    const genpageCli = { enumerateEnv: async () => ({ ok: true, ids: [GP_O], pages: [{ pageId: GP_O, name: 'Overview' }] }), upload: async (o) => { uploads.push(o); return { pageId: o.pageId || GP_O }; } };
    await runSdkBuild(spec, { sdk, apply: true, env: 'https://x', appDir, genpageCli, phases: ['solution', 'data-model', 'app-shell', 'pages'] });
    assert.strictEqual(uploads.length, 1, 'exactly one upload');
    assert.strictEqual(uploads[0].pageId, GP_O, 'UPDATE in place by the existing id (Imp9: assert the id, not just uploads===1)');
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

test('pages: a page shared across TWO apps sitemaps HALTs pages-shared-across-apps (Imp5, report-only)', async () => {
  const spec = makeSpec(); spec.schemaVersion = 2;
  spec.pages = [{ key: 'overview', name: 'Overview', source: { kind: 'tsx', codeFile: 'o.tsx' } }];
  spec.appShell.areas[0].groups[0].subAreas.push({ page: 'overview', title: 'Overview' });
  const appUnique = appUniqueName(spec);
  const appDir = stagePages(spec.pages);
  try {
    const existing = Buffer.from(JSON.stringify({ schemaVersion: 1, pages: [{ key: 'overview', name: 'Overview', pageId: GP_O }] }), 'utf8').toString('base64');
    // THIS app reuses GP_O (an UPDATE); contoso_secondapp ALSO has GP_O in its sitemap → shared (the two
    // appmodules in the env both reference the id, confirmed by the live probe: only the sitemap XML carries it).
    const sitemapWithO = `<SiteMap><Area><Group><SubArea GenPageId="${GP_O}" Title="Overview"/></Group></Area></SiteMap>`;
    const { sdk } = mockSdk({ pageManifest: existing, manifestId: 'wr-manifest', selfAppUnique: appUnique, liveSitemapXml: sitemapWithO, otherApps: [{ uniquename: 'contoso_secondapp', sitemapxml: sitemapWithO }] });
    const genpageCli = { enumerateEnv: async () => ({ ok: true, ids: [GP_O], pages: [{ pageId: GP_O, name: 'Overview' }] }), upload: async (o) => ({ pageId: o.pageId || GP_O }) };
    await assert.rejects(runSdkBuild(spec, { sdk, apply: true, env: 'https://x', appDir, genpageCli, phases: ['solution', 'data-model', 'app-shell', 'pages'] }), /shared across apps|pages-shared-across-apps/);
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

test('pages: a live page removed from the spec HALTs pages-removed unless allowDestructive (Imp6)', async () => {
  const spec = makeSpec(); spec.schemaVersion = 2;
  spec.pages = [{ key: 'overview', name: 'Overview', source: { kind: 'tsx', codeFile: 'o.tsx' } }]; // order-detail dropped
  spec.appShell.areas[0].groups[0].subAreas.push({ page: 'overview', title: 'Overview' });
  const appUnique = appUniqueName(spec);
  const appDir = stagePages(spec.pages);
  try {
    const GP_D = '5c0a4889-45fd-46ea-91a8-ff876914d644';
    // The manifest + sitemap both still reference GP_D (order-detail), but the spec no longer does.
    const existing = Buffer.from(JSON.stringify({ schemaVersion: 1, pages: [{ key: 'overview', name: 'Overview', pageId: GP_O }, { key: 'order-detail', name: 'Order Detail', pageId: GP_D }] }), 'utf8').toString('base64');
    const sm = `<SiteMap><Area><Group><SubArea GenPageId="${GP_O}"/><SubArea GenPageId="${GP_D}"/></Group></Area></SiteMap>`;
    const mkOpts = { pageManifest: existing, manifestId: 'wr-manifest', selfAppUnique: appUnique, liveSitemapXml: sm };
    const genpageCli = { enumerateEnv: async () => ({ ok: true, ids: [GP_O, GP_D], pages: [{ pageId: GP_O, name: 'Overview' }, { pageId: GP_D, name: 'Order Detail' }] }), upload: async (o) => ({ pageId: o.pageId || GP_O }) };
    await assert.rejects(runSdkBuild(spec, { sdk: mockSdk(mkOpts).sdk, apply: true, env: 'https://x', appDir, genpageCli, phases: ['solution', 'data-model', 'app-shell', 'pages'] }), /removed from the spec|pages-removed/);
    // With allowDestructive the build proceeds (the removed page is LEFT deployed, not deleted).
    await runSdkBuild(spec, { sdk: mockSdk(mkOpts).sdk, apply: true, allowDestructive: true, env: 'https://x', appDir, genpageCli, phases: ['solution', 'data-model', 'app-shell', 'pages'] });
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});
```

> Add a **finalizer-failure retry** test: make `pushArtifact('app', …)` return `{ success:false }` on the first run (build HALTs at finalize), then a second run with the same mock state (existence still has the created id) reuses it (`uploads.length === 1`) and finalizes — proving idempotent convergence (C1). Also add a **shared-check fail-closed** test: make the un-filtered `appmodule` list throw → assert the build HALTs `pages-shared-check-failed` (fail-closed on scan error), and a **single-app minimal-work** assertion (no `otherApps` → the shared scan reads no other sitemaps and the build succeeds).

- [ ] **Step 3: Require the extractors + read `allowDestructive`** — in `scripts/lib/sdk-build.js`:

```javascript
const { sitemapGenPageIds, fetchSitemap, fetchAppsForPages } = require('./sitemap-pages.js');
```

- [ ] **Step 4: Replace the top of the pages-phase `try` block** — replace the enumerate/reconcile/ambiguous section (`sdk-build.js:1160-1167`) with the three-authority reads + safety gates:

```javascript
      // EXISTENCE (env-wide `pac genpage list`) drives reconcile: create-vs-reuse. Fail-closed — a failed
      // listing must NOT look like "no pages" (that would recreate everything). This is NOT the sitemap:
      // a page created + manifested but not yet finalized into the sitemap is still in EXISTENCE, so a
      // crash-after-create converges to REUSE, not a duplicate (C1).
      const existence = await genpageCli.enumerateEnv();
      if (!existence.ok) throw new BuildHalt(`generative-page EXISTENCE enumeration failed — refusing to (re)create pages against an unknown environment: ${existence.error}`, { phase: 'pages', code: 'pages-existence-failed', recoverable: true });
      const { id: readId, manifest, text } = await readPageManifest(provision, appUnique);
      let manifestId = readId;
      let lastManifestContent = text;
      const { keyToId, conflicts } = reconcilePageIds(spec.pages, manifest, existence.ids);
      if (conflicts.length) throw new BuildHalt(`generative-page identity conflict — id(s) each claimed by multiple page keys: ${conflicts.map((c) => `${c.pageId} ← [${c.keys.join(', ')}]`).join('; ')}. Refusing to overwrite an arbitrary page; fix the duplicate id in the spec/manifest.`, { phase: 'pages', code: 'pages-identity-conflict', recoverable: false });

      // MEMBERSHIP (this app's live sitemap) — fail-closed & discriminated (C4). A page-bearing build just
      // created (or is editing) the app, so the sitemap MUST be readable; ok:false is a real failure, never
      // "empty". Used for the removal gate and (below) for finalize. A fresh build's app has an empty-of-
      // genpages sitemap here → ids:[] (valid), which is correct.
      const membership = await fetchSitemap(provision, appUnique);
      if (!membership.ok) throw new BuildHalt(`could not read the app sitemap (${membership.reason}) — refusing to proceed without verifying the app's page set`, { phase: 'pages', code: 'pages-sitemap-read-failed', recoverable: true });

      // Imp6 (destructive removal, gated): a page in THIS app's live set (sitemap MEMBERSHIP ∪ manifest ids)
      // that the spec no longer references would be orphaned by the rebuild. HALT with a report unless
      // --allow-destructive (mirrors the op-diff destructive gate; this build NEVER deletes the page — it is
      // left deployed). New pages (absent, to be minted) aren't in the live set, so they're never flagged.
      const liveAppIds = new Set([
        ...membership.ids,
        ...((manifest && manifest.pages) || []).filter((p) => p.pageId).map((p) => String(p.pageId).toLowerCase()),
      ]);
      const keptIds = new Set([
        ...Array.from(keyToId.values()).map((id) => String(id).toLowerCase()),
        ...((spec.pages || []).filter((p) => p.pageId).map((p) => String(p.pageId).toLowerCase())),
      ]);
      const removedIds = [...liveAppIds].filter((id) => !keptIds.has(id));
      if (removedIds.length && opts.allowDestructive !== true) throw new BuildHalt(`refusing to orphan ${removedIds.length} page(s) the spec removed but the app still references (sitemap/manifest): ${removedIds.join(', ')}. Re-run with --allow-destructive to proceed (the pages are LEFT deployed; this build will not delete them), or restore them to the spec.`, { phase: 'pages', code: 'pages-removed', recoverable: false });

      // Imp5 (shared-page detection, report-only, FAIL-CLOSED on scan error). A page we are about to UPDATE (a
      // reused id in keyToId) that ALSO belongs to ANOTHER app's sitemap is shared (`pac genpage add`) —
      // updating its content mutates a page another app uses. GROUNDED (live probe, aurorabapenv03468): a
      // genpage has NO appmodulecomponent row, so the ONLY signal is the sitemap XML — there is no direct
      // genpage→apps join; we MUST scan every OTHER app's sitemap (fetchAppsForPages). `excludeAppUnique` skips
      // this app (self can't share with itself), so a SINGLE-APP env reads zero other sitemaps (minimal work).
      // FAIL-CLOSED: if the env enumeration fails we cannot verify safety → HALT (recoverable, so a transient
      // failure retries). BEST-EFFORT per app: apps we couldn't read are WARNED (partial coverage), not fatal.
      // On positive detection (id in ≥1 other app) → HALT pages-shared-across-apps (never auto-modify).
      const updateIds = Array.from(keyToId.values());
      if (updateIds.length) {
        const scan = await fetchAppsForPages(provision, updateIds, { excludeAppUnique: appUnique });
        if (!scan.ok) throw new BuildHalt(`could not scan the environment for pages shared across apps (${scan.error}) — refusing to UPDATE a page without verifying it is not shared. Re-run to retry.`, { phase: 'pages', code: 'pages-shared-check-failed', recoverable: true });
        if (scan.unreadable.length) runner.skip('pages', `shared-page check partial: ${scan.unreadable.length} app(s) had an unreadable sitemap and were not scanned (${scan.unreadable.join(', ')})`);
        // scan.byId already excludes self, so ANY entry means the id lives in another app's sitemap → shared.
        const shared = Array.from(scan.byId, ([id, apps]) => ({ id, others: apps }));
        if (shared.length) throw new BuildHalt(`generative page(s) shared across apps: ${shared.map((s) => `${s.id} (also in ${s.others.join(', ')})`).join('; ')} — refusing to UPDATE a page another app's sitemap references (a rebuild would mutate shared content). Detach it in Maker, or give this app its own page.`, { phase: 'pages', code: 'pages-shared-across-apps', recoverable: false });
      }
      const persistNow = async () => { const pr = await persistPageManifest(provision, spec, keyToId, sol, appUnique, manifestId, lastManifestContent); manifestId = pr.id; lastManifestContent = pr.content; };
```

Everything below `persistNow` (the `keyOf`/`canonicalPath`/`implemented` setup at `:1170` onward — structural scan, create-absent-first, upload-once, persist, finalize, and the `finally` staging cleanup + lease release) is UNCHANGED.

- [ ] **Step 5: Thread `allowDestructive` into the engine** — in `scripts/build-model-app.js`, add one line to the `runBuild(spec, {…})` options object (`:230-242`):

```javascript
        allowDestructive: opts.allowDestructive, // pages phase gates destructive page removals (Imp6)
```

> The preflight op-diff gate (`:204-216`) still runs first for form/sitemap-entity removals; the pages-removal gate lives in the engine because it needs the reconciled live page set. See the Self-Review "residual risk" note on the all-pages-removed edge.

- [ ] **Step 6: Run the pages tests + full suite** — `node --test scripts/tests/sdk-build.test.js scripts/tests/sdk-build-pages-deploy.test.js scripts/tests/sdk-build-pages-order.test.js scripts/tests/sdk-build-pages-migrate.test.js` → PASS (fix any mock still passing `enumerate` / lacking `enumerateEnv` / lacking the `fetchSitemap` queryRecords). Then continue to Task 6 (the full-suite-green gate + the single commit happen at Task 6).

---

## Task 6: Download round-trip — enumerate MEMBERSHIP, download by id, KEEP pageId (edit-snapshot)

`download-model-app.js` obtains the app's page set from the **sitemap** (MEMBERSHIP via `fetchSitemap`), downloads exactly those ids, reconciles/re-keys by id, and — the C3 change — `hydrate-spec.js` **keeps each page's `pageId`** in the emitted spec so the downloaded spec is a self-describing edit-snapshot that rebuilds (Maker-added pages included) without duplicating.

**Files:**
- Modify: `scripts/download-model-app.js` — the pages block (`:219-263`); `assignPageKeys`/`missingDownloads` reuse.
- Modify: `scripts/lib/hydrate-spec.js` — emit `pageId` on each v2 page (`:77-96`).
- Modify: `scripts/tests/download-model-app.test.js`, `scripts/tests/hydrate-spec.test.js`.

**Interfaces:**
- Consumes: `fetchSitemap` (Task 1 — MEMBERSHIP ids + titles); `reconcilePageIds(pages, manifest, existenceIds)` (Task 4); `genpageCli.download({ appId, outputDir, pageIds })` (Task 2); `assignPageKeys`/`reverseResolveNavIds` (unchanged).
- Produces: a v2 spec whose `pages[]` == the sitemap's pages (no headless drop, no dangling nav), each carrying its `pageId` (C3), keyed via the manifest, nav reverse-resolved to `PAGEREF_<key>`. A WARNING for a manifest page no longer in the sitemap (Maker-deleted).

**Key changes:**
- The app's page set = `fetchSitemap(sdk, appUnique)` → `{ ids, xml }`; titles come from `sitemapGenPages(xml)`. Download those ids: `genpageCli.download({ appId, outputDir: pagesRoot, pageIds: sitemapIds })`.
- Reconcile against the sitemap ids (the app's known-to-exist pages): `reconcilePageIds((manifest && manifest.pages) || [], manifest, sitemapIds)`.
- `hydrate-spec.js` v2 page shape gains `...(p.pageId ? { pageId: p.pageId } : {})` — `parseDownloadedPages` already sets `pageId: entry` (`download-model-app.js:103`), so the id flows through `read.pages()` into the spec.

- [ ] **Step 1: Write the failing tests** — in `download-model-app.test.js`, mock `fetchSitemap` (via the sdk's three `queryRecords`) to yield two GenPage subareas, mock `genpageCli.download` to write both page dirs, and assert: (a) BOTH pages recovered (no drop); (b) each spec page carries its `pageId` (C3); (c) the nav literal reverse-resolved to `"PAGEREF_order-detail"`; (d) a sitemap id not downloaded → abort. Add a full **Maker-add → download → rebuild** round-trip asserting the rebuild UPDATEs by the ORIGINAL id (no create). In `hydrate-spec.test.js`, assert the v2 page shape includes `pageId`.

```javascript
// hydrate-spec.test.js — edit-snapshot keeps pageId (C3)
const { hydrateSpec } = require('../lib/hydrate-spec.js');
test('hydrateSpec emits pageId on v2 pages (edit-snapshot self-describes its ids, C3)', async () => {
  const GP_O = '13ecbc57-a3a4-4132-b0a2-a6c6b12691e8';
  const read = {
    app: async () => ({ name: 'A', description: '', siteMap: { areas: [{ title: 'M', groups: [{ title: 'G', subAreas: [{ type: 'GenPage', genPageId: GP_O, title: 'Overview' }] }] }] } }),
    pages: async () => [{ pageId: GP_O, key: 'overview', name: 'Overview', codeFile: 'pages/overview.tsx' }],
    entities: async () => [], webResources: async () => [], dashboards: async () => [], solution: async () => ({ uniqueName: 'S', publisherPrefix: 'new' }),
  };
  const spec = await hydrateSpec(read);
  assert.strictEqual(spec.pages[0].pageId, GP_O);
  assert.strictEqual(spec.pages[0].key, 'overview');
});
```

- [ ] **Step 2: Run to verify it fails** — → FAIL (download still calls `enumerate`; hydrate drops `pageId`).

- [ ] **Step 3a: `hydrate-spec.js` — keep `pageId`** — in the v2 page emit (`:77-88`), add `pageId` right after `name`:

```javascript
      ? {
          key: p.key,
          name: p.name,
          // Carry the deployed GenPageId so the downloaded spec is a self-describing EDIT-SNAPSHOT (C3):
          // a rebuild reuses this id (reconcilePageIds authority #1) instead of minting a new one, even for
          // a page the user added in Maker that our manifest never knew about. A portable fresh-authored
          // spec has no ids; this one does — that is the intended distinction (see references/app-spec-schema.md).
          ...(p.pageId ? { pageId: p.pageId } : {}),
          ...(p.purpose !== undefined ? { purpose: p.purpose } : {}),
          ...(p.dataSources && p.dataSources.length ? { dataSources: p.dataSources } : {}),
          ...(p.navigatesTo ? { navigatesTo: p.navigatesTo } : {}),
          ...(p.pageInput !== undefined ? { pageInput: p.pageInput } : {}),
          ...(p.prompt ? { prompt: p.prompt } : {}),
          source: { kind: 'tsx', codeFile: p.codeFile },
        }
```

- [ ] **Step 3b: `download-model-app.js` — enumerate MEMBERSHIP, download by id** — replace the pages block (`:219-263`). Require `fetchSitemap`/`sitemapGenPages`:

```javascript
const { fetchSitemap, sitemapGenPages } = require('./lib/sitemap-pages.js');
```

Then the block:

```javascript
  // Pages = this app's SITEMAP MEMBERSHIP (the authoritative set of pages owned by the app), read fail-closed
  // & discriminated. Download EXACTLY those ids and KEEP each page's pageId in the spec so the round-trip is a
  // self-describing edit-snapshot (C3). Everything is fail-closed: a sitemap read failure, a download gap, or
  // a read/write error ABORTS with a structured error rather than silently writing a page-dropping spec.
  const appRows = await sdk.queryRecords('appmodule', { select: ['uniquename'], filter: `appmoduleid eq ${appId}`, top: 1 });
  const appUnique = appRows && appRows[0] && appRows[0].uniquename;
  const sm = appUnique ? await fetchSitemap(sdk, appUnique) : { ok: false, reason: 'app-unique-unresolved' };
  if (!sm.ok) { emitResult(false, { ok: false, error: `could not read the app sitemap during download (${sm.reason}) — refusing to write a spec without the authoritative page set` }); return; }
  const smPages = sitemapGenPages(sm.xml); // [{ pageId, title }] — deduped
  let pages = [];
  let manifest = null;
  if (smPages.length) {
    // Durable manifest (keys + v2 semantics + real names). Best-effort: a missing/corrupt manifest → fresh keys.
    const rows = await sdk.queryRecords('webresource', { select: ['content'], filter: `name eq '${manifestResourceName(appUnique).replace(/'/g, "''")}'`, top: 1 });
    if (rows && rows[0] && rows[0].content) manifest = parseManifestBase64(rows[0].content);
    const genpageCli = makeGenpageCli(env);
    const pagesRoot = path.join(outDir, 'pages');
    fs.rmSync(pagesRoot, { recursive: true, force: true });
    fs.mkdirSync(pagesRoot, { recursive: true });
    const sitemapIds = smPages.map((p) => p.pageId);
    await genpageCli.download({ appId, outputDir: pagesRoot, pageIds: sitemapIds }); // download EXACTLY the sitemap's pages, by id
    // Real names: prefer the manifest (id→name), else the sitemap title (already XML-entity-decoded).
    const nameById = new Map();
    for (const p of smPages) nameById.set(String(p.pageId).toLowerCase(), p.title);
    for (const mp of (manifest && manifest.pages) || []) if (mp.pageId && mp.name) nameById.set(String(mp.pageId).toLowerCase(), mp.name);
    pages = parseDownloadedPages(pagesRoot, outDir, nameById);
    // Bidirectional exact-equality: sitemap ids ↔ downloaded ids (I3). A gap either way is a page set mismatch.
    const missing = missingDownloads(smPages, pages);
    if (missing.length) { emitResult(false, { ok: false, error: `sitemap page(s) not downloaded: ${missing.map((p) => p.title || p.pageId).join(', ')} — refusing to write a spec that would drop them` }); return; }
    const extra = missingDownloads(pages, smPages);
    if (extra.length) { emitResult(false, { ok: false, error: `downloaded page(s) not in the sitemap: ${extra.map((p) => p.pageId).join(', ')} — inconsistent page set` }); return; }
    // Reconcile by EXISTENCE = the sitemap ids (the app's pages, all known to exist). conflicts HALT.
    const { keyToId, conflicts } = reconcilePageIds((manifest && manifest.pages) || [], manifest, sitemapIds);
    if (conflicts.length) { emitResult(false, { ok: false, error: `page identity conflict during download: id(s) ${conflicts.map((c) => c.pageId).join(', ')} each claimed by multiple keys — cannot safely reconstruct` }); return; }
    const idToKey = assignPageKeys(pages, manifest, keyToId);
    for (const p of pages) {
      const abs = path.join(outDir, p.codeFile);
      const src = fs.readFileSync(abs, 'utf8');            // FAIL on a read error (no swallow)
      const rev = reverseResolveNavIds(src, idToKey);      // structural — nav pageId literals only
      if (rev !== src) fs.writeFileSync(abs, rev, 'utf8');  // FAIL on a write error (no swallow)
    }
    // Report (WARNING) a manifest page no longer in the sitemap — the user deleted it in Maker, so the
    // rebuilt spec drops it (mirrors the existing droppedSubareaCount WARNING; not fatal).
    const liveSet = new Set(sitemapIds.map((id) => String(id).toLowerCase()));
    const goneManifestPages = ((manifest && manifest.pages) || []).filter((mp) => mp.pageId && !liveSet.has(String(mp.pageId).toLowerCase()));
    if (goneManifestPages.length) process.stderr.write(`WARNING: ${goneManifestPages.length} manifest page(s) are no longer in the app sitemap (deleted in Maker): ${goneManifestPages.map((p) => p.name || p.pageId).join(', ')} — the rebuilt spec drops them.\n`);
  }
```

> `parseDownloadedPages` already sets `pageId: entry` (`:103`), so `read.pages()` carries the id into `hydrateSpec` (Step 3a). `missingDownloads(a,b)` compares by `pageId` — `smPages` entries have `pageId`, so it works unchanged. Update the `reconcilePageIds` import line (`:16`) — it already imports from `page-manifest.js`; no change needed beyond the new call shape.

- [ ] **Step 4: Run tests + FULL suite** — `node --test scripts/tests/download-model-app.test.js scripts/tests/hydrate-spec.test.js scripts/tests/page-manifest.test.js scripts/tests/sdk-build*.test.js` → PASS, then `node scripts/run-tests.js` → **PASS (the trio is now complete; the full suite goes green here)** (≈ 700).
- [ ] **Step 5: Commit the ATOMIC TRIO together (Tasks 4 + 5 + 6, Imp10)** — a SINGLE commit:
  `git add scripts/lib/page-manifest.js scripts/tests/page-manifest.test.js scripts/lib/sdk-build.js scripts/build-model-app.js scripts/tests/sdk-build.test.js scripts/tests/sdk-build-pages-deploy.test.js scripts/tests/sdk-build-pages-order.test.js scripts/tests/sdk-build-pages-migrate.test.js scripts/download-model-app.js scripts/lib/hydrate-spec.js scripts/tests/download-model-app.test.js scripts/tests/hydrate-spec.test.js` + trailers.

---

## Task 7: Verify — match by id against EXISTENCE + MEMBERSHIP; `unableToRun`/`page-identity`; exact set-equality

`verify-spec.js` stops name-matching against `pac genpage list`. It resolves each spec page's id (spec `pageId` > manifest), checks it EXISTS (env-wide) and is PLACED (sitemap MEMBERSHIP), matches by id, adds EXACT set-equality (an extra live page not in the spec is reported), and yields `unableToRun` (not "every page missing") when the manifest cannot correlate (Imp7). All page checks share **ONE** cached env-wide snapshot + **ONE** cached sitemap read (Imp7). Independent of the reconcile trio — depends only on Tasks 1 + 2.

**Files:**
- Modify: `scripts/lib/verify-spec.js` — the page branch (`:68-124`).
- Modify: `scripts/verify-model-app.js` — `readerFor` (`:47-88`): add `existenceIds()`/`membership()`/`manifest()` (cached), `pageCode(id)` (download by id); `sitemapXml()` fail-closed from `fetchSitemap`.
- Modify: `scripts/tests/verify-spec.test.js`, `scripts/tests/verify-model-app.test.js`.

**Interfaces (reader contract):**
- `read.sitemapXml() → string` — for the existing entity/icon `hasElement` checks (fail-closed `''` when unreadable).
- `read.existenceIds() → Promise<{ ok, ids } | { ok:false, error }>` — env-wide EXISTENCE (`genpageCli.enumerateEnv`), memoized.
- `read.membership() → Promise<{ ok, xml, ids } | { ok:false, reason }>` — the app's sitemap (`fetchSitemap`), memoized.
- `read.manifest() → Promise<{ pages } | null>` — the durable manifest, memoized.
- `read.pageCode(id) → Promise<string>` — download THAT page by id (memoized bulk download).

- [ ] **Step 1: Write failing tests** — in `verify-spec.test.js`, drive the page branch with a `read` mock exposing `existenceIds`, `membership`, `manifest`, `sitemapXml`, `pageCode`. Assert: (a) a page whose manifest id EXISTS and is PLACED → `page`/`page-subarea` pass even when spec name ≠ sitemap title (id match, not name); (b) a page whose id is NOT in existence → `page` fails; (c) manifest empty/uncorrelatable on a page-bearing spec → `unableToRun` (page-identity), NOT "every page missing"; (d) an EXTRA sitemap id with no spec page → a `page-extra` miss; (e) a spec `pageId` overrides the manifest for the id lookup. In `verify-model-app.test.js`, assert `readerFor(...).existenceIds()` returns the env ids and `pageCode(id)` calls `genpageCli.download({ pageIds: [id] })`.

```javascript
const GP_O = '13ecbc57-a3a4-4132-b0a2-a6c6b12691e8';
const GP_X = '9f2b1a3c-77de-4a10-8b6e-2c4d5e6f7a8b';
function pageRead({ existence, membershipIds, membershipXml, manifest, code }) {
  return {
    findTable: async () => ({ logicalName: 'contoso_item' }), findColumns: async () => [], queryRecords: async () => [],
    sitemapXml: async () => membershipXml || '',
    existenceIds: async () => ({ ok: true, ids: existence }),
    membership: async () => ({ ok: true, xml: membershipXml || '', ids: membershipIds }),
    manifest: async () => manifest,
    pageCode: async (id) => (code && code[String(id).toLowerCase()]) || '',
  };
}
test('verifySpec matches pages BY ID (spec name != sitemap title still passes)', async () => {
  const spec = { schemaVersion: 2, entities: [{ schemaName: 'contoso_item', primaryAttribute: { schemaName: 'contoso_name' }, columns: [] }],
    pages: [{ key: 'overview', name: 'Orders Overview', source: { kind: 'tsx', codeFile: 'o.tsx' } }],
    appShell: { areas: [{ label: 'M', groups: [{ label: 'G', subAreas: [{ page: 'overview', title: 'Overview' }] }] }] } };
  const xml = `<SiteMap><Area><Group><SubArea GenPageId="${GP_O}" Title="Overview"/></Group></Area></SiteMap>`;
  const read = pageRead({ existence: [GP_O], membershipIds: [GP_O], membershipXml: xml, manifest: { pages: [{ key: 'overview', pageId: GP_O }] }, code: { [GP_O]: 'export default 1;' } });
  const r = await verifySpec(spec, read);
  assert.ok(r.checks.find((c) => c.kind === 'page' && c.name === 'Orders Overview').present, 'page present by id despite name!=title');
  assert.ok(r.checks.find((c) => c.kind === 'page-subarea' && c.name === 'Orders Overview').present, 'placement verified by id');
});
test('verifySpec: an EXTRA sitemap page not in the spec is reported (exact set-equality, Imp7)', async () => {
  const spec = { schemaVersion: 2, entities: [], pages: [{ key: 'overview', name: 'Overview', source: { kind: 'tsx', codeFile: 'o.tsx' } }],
    appShell: { areas: [{ label: 'M', groups: [{ label: 'G', subAreas: [{ page: 'overview', title: 'Overview' }] }] }] } };
  const xml = `<SiteMap><Area><Group><SubArea GenPageId="${GP_O}"/><SubArea GenPageId="${GP_X}"/></Group></Area></SiteMap>`;
  const read = pageRead({ existence: [GP_O, GP_X], membershipIds: [GP_O, GP_X], membershipXml: xml, manifest: { pages: [{ key: 'overview', pageId: GP_O }] }, code: {} });
  const r = await verifySpec(spec, read);
  assert.ok(r.checks.some((c) => c.kind === 'page-extra' && !c.present), 'the unmatched live page GP_X is reported');
});
test('verifySpec: manifest empty on a page-bearing spec → unableToRun (page-identity), NOT every page missing (Imp7)', async () => {
  const spec = { schemaVersion: 2, entities: [], pages: [{ key: 'overview', name: 'Overview', source: { kind: 'tsx', codeFile: 'o.tsx' } }],
    appShell: { areas: [{ label: 'M', groups: [{ label: 'G', subAreas: [{ page: 'overview', title: 'Overview' }] }] }] } };
  const read = pageRead({ existence: [GP_O], membershipIds: [GP_O], membershipXml: `<SiteMap/>`, manifest: { pages: [] }, code: {} });
  const r = await verifySpec(spec, read);
  assert.strictEqual(r.unableToRun, true);
  assert.ok(!r.checks.some((c) => c.kind === 'page' && c.present === false && /Overview/.test(c.name)), 'no false "page missing" for every page');
});
```

- [ ] **Step 2: Run to verify it fails** — → FAIL (verify still calls `read.pages()` and name-matches).

- [ ] **Step 3: Implement the `verify-spec.js` page branch** — replace `:68-120` (the `implementedPages`…per-page loop) with the existence+membership id logic:

```javascript
  const implementedPages = (spec.pages || []).filter((p) => { const s = normalizePageSource(p); return s && s.kind === 'tsx' && s.codeFile; });
  // Reader-incapacity (fail-closed): a page-bearing spec needs the EXISTENCE + MEMBERSHIP + manifest readers.
  let unableToRun = !!(implementedPages.length && (typeof read.existenceIds !== 'function' || typeof read.membership !== 'function' || typeof read.manifest !== 'function')) ||
    !!(implementedPages.some((p) => (p.navigatesTo || []).length > 0) && typeof read.pageCode !== 'function');
  if (implementedPages.length) {
    if (unableToRun) {
      add('page-verify', 'pages', false, 'the verify reader cannot read existence / membership / manifest (unable to run)');
    } else {
      // ONE cached snapshot each (Imp7 — never re-query per page).
      const ex = await read.existenceIds();
      const mem = await read.membership();
      if (!ex.ok || !mem.ok) {
        // A fail-closed read failure on a page-bearing spec = reader-incapacity, NOT "every page missing".
        unableToRun = true;
        add('page-verify', 'pages', false, `cannot read ${!ex.ok ? 'page existence' : 'the app sitemap'} (${!ex.ok ? ex.error : mem.reason}) — unable to run`);
      } else {
        const existSet = new Set((ex.ids || []).map((id) => String(id).toLowerCase()));
        const memSet = new Set((mem.ids || []).map((id) => String(id).toLowerCase()));
        const man = (await read.manifest()) || { pages: [] };
        const idByKey = new Map((man.pages || []).filter((p) => p && p.key && p.pageId).map((p) => [p.key, p.pageId]));
        // Resolve each spec page's id: its OWN pageId (edit-snapshot) OUTRANKS the manifest (C3).
        const idOf = (p) => p.pageId || idByKey.get(p.key || p.name);
        // Imp7: if NO implemented page can be given an id (manifest missing/empty AND no spec pageIds), the
        // manifest can't correlate — that is unableToRun (page-identity), not N false "page missing" checks.
        const resolvable = implementedPages.filter((p) => !!idOf(p));
        if (resolvable.length === 0) {
          unableToRun = true;
          add('page-verify', 'pages', false, 'the page manifest is missing/empty/uncorrelatable — cannot map any spec page to a deployed id (page-identity)');
        } else {
          const specIds = new Set();
          for (const p of implementedPages) {
            const key = p.key || p.name;
            const id = idOf(p);
            if (!id) { add('page', p.name, false, 'no manifest/spec id for this page (page-identity)'); continue; }
            specIds.add(String(id).toLowerCase());
            add('page', p.name, existSet.has(String(id).toLowerCase()));                 // EXISTENCE, by id
            if (appShellReferencesPage(spec, key)) add('page-subarea', p.name, subareaHasGenPage(xml, id)); // MEMBERSHIP, by id
            const nav = p.navigatesTo || [];
            if (!nav.length) continue;
            let code;
            try { code = (await read.pageCode(id)) || ''; } catch (e) { add('page-code', p.name, false, String((e && e.message) || e)); continue; }
            const targets = extractNavTargets(code);
            add('page-no-pageref', p.name, !targets.some((t) => t.kind === 'pageref' || t.kind === 'pageref-malformed'));
            const navLiteralIds = new Set(targets.filter((t) => t.kind === 'literal').map((t) => String(t.pageId).toLowerCase()));
            for (const edge of nav) {
              const targetId = idOf((spec.pages || []).find((pp) => (pp.key || pp.name) === edge.targetKey) || {});
              add('page-nav', `${p.name} -> ${edge.targetKey}`, !!targetId && navLiteralIds.has(String(targetId).toLowerCase()));
            }
          }
          // EXACT set-equality (Imp7): a live sitemap page with no matching spec page is reported.
          for (const liveId of memSet) if (!specIds.has(liveId)) add('page-extra', liveId, false, 'a sitemap page not present in the spec');
        }
      }
    }
  }
  const missing2 = checks.filter((c) => !c.present);
  return { ok: missing2.length === 0 && !unableToRun, checks, missing: missing2, unableToRun: unableToRun || undefined };
```

> `xml` (the sitemap XML for the entity/icon `hasElement` checks) is already fetched above the page branch via `read.sitemapXml()` (`verify-spec.js:44`); the page-subarea check reuses it (id-based `subareaHasGenPage`). Keep `read.sitemapXml()` as the string source for that.

- [ ] **Step 4: Implement the `verify-model-app.js` reader** — replace the page-reader block (`:75-86`) and `sitemapXml` (`:73`). Memoize each authority once:

```javascript
  const base = {
    findTable: async (logical) => { const l = String(logical).toLowerCase(); const t = await sdk.findTables(l); return (t || []).find((x) => String(x.logicalName).toLowerCase() === l) || null; },
    findColumns: async (logical) => sdk.findColumns(logical),
    queryRecords: (set, o) => sdk.queryRecords(set, o),
    // sitemapXml (string, fail-closed '') for the entity/icon hasElement checks — from the discriminated read.
    sitemapXml: async () => { const r = await memoMembership(); return r.ok ? r.xml : ''; },
  };
  const { fetchSitemap } = require('./lib/sitemap-pages.js');
  let membershipP; const memoMembership = () => (membershipP || (membershipP = fetchSitemap(sdk, appUnique)));
  let existenceP;
  if (genpageCli) {
    base.existenceIds = () => (existenceP || (existenceP = genpageCli.enumerateEnv()));   // EXISTENCE (env-wide), cached
    base.membership = () => memoMembership();                                              // MEMBERSHIP (sitemap), cached
    base.manifest = async () => {
      const name = require('./lib/page-manifest.js').manifestResourceName(appUnique);
      const rows = await sdk.queryRecords('webresource', { select: ['content'], filter: `name eq '${odataLit(name)}'`, top: 1 });
      return rows && rows[0] && rows[0].content ? require('./lib/page-manifest.js').parseManifestBase64(rows[0].content) : { pages: [] };
    };
    base.pageCode = async (pageId) => { await ensureDownloaded(pageId); return codeById.get(String(pageId).toLowerCase()) || ''; };
  }
  return base;
```

And change `ensureDownloaded` to download by id (reuse the existing cached-dir pattern, `:58-68`), passing `pageIds: [pageId]` to `genpageCli.download`. Remove the old `base.pages` reader (grep confirms only verify used `read.pages()`).

- [ ] **Step 5: Run tests + full suite** — `node --test scripts/tests/verify-spec.test.js scripts/tests/verify-model-app.test.js` → PASS; `node scripts/run-tests.js` → PASS (≈ 706). Confirm `build-model-app.js`'s `deps.verify` wiring (`:396`) still constructs the reader with `{ genpageCli, workspaceDir }` — no signature change needed (the reader gained methods, not params).
- [ ] **Step 6: Commit** — `git add scripts/lib/verify-spec.js scripts/verify-model-app.js scripts/tests/verify-spec.test.js scripts/tests/verify-model-app.test.js` + trailers.

---

## Task 8: Docs — the three-authority model + edit-snapshot vs portable spec

Doc-only. Record the three authorities (IDENTITY/EXISTENCE/MEMBERSHIP), the edit-snapshot `pageId`, the every-page-placed rule, and the safety HALTs across the contract docs.

**Files:** `references/app-spec-schema.md`, `references/rules.md`, `agents/genpage-page-builder.md`, `skills/app-builder/SKILL.md`, `docs/architecture.md`, `docs/app-builder-roadmap.md`, `CHANGELOG.md`, `AGENTS.md`.

- [ ] **Step 1: `references/app-spec-schema.md`** — under `## pages`: every page MUST be referenced by an `appShell` subarea (validation error otherwise); the sitemap `GenPageId` set is the authoritative MEMBERSHIP list; identity is the stable `key` mapped to the deployed `GenPageId` via the durable manifest. Add the optional `pages[].pageId` field: present only in an **edit-snapshot** spec (downloaded from a live app; env-specific, self-describing); a portable fresh-authored spec omits it. Note reconcile authority: spec `pageId` > manifest, confirmed by env-wide EXISTENCE.
- [ ] **Step 2: `references/rules.md` + `agents/genpage-page-builder.md`** — a `PAGEREF_<key>` target must be a page ALSO placed in the app sitemap (place every page in `appShell`); reachable-only-by-nav (headless) pages are not supported.
- [ ] **Step 3: `skills/app-builder/SKILL.md`** — the author/generate-pages flow places every page in the sitemap; a detail page is a normal sitemap page that takes input via `pageInput`. Note the new HALTs a build can surface: `pages-shared-across-apps` (a page in another app's sitemap — detach in Maker) and `pages-removed` (a removed page still live — re-add or `--allow-destructive`).
- [ ] **Step 4: `docs/architecture.md` + `AGENTS.md`** — describe the **three authorities**: IDENTITY = the manifest (+ edit-snapshot pageId); EXISTENCE = env-wide `pac model genpage list` (drives crash-safe reconcile); MEMBERSHIP = the app sitemap `GenPageId` set (placement/enumeration/verify). Replace any "enumeration = `pac genpage list --app-id`" wording. In `AGENTS.md`, update the pages-phase bullet to name existence-driven reconcile + the fail-closed `fetchSitemap` membership read.
- [ ] **Step 5: `docs/app-builder-roadmap.md` + `CHANGELOG.md`** — Changed: generative-page management is now three-authority (identity/existence/membership) + id-based + crash-safe; new validation requires every page sitemap-placed; download keeps `pageId` (edit-snapshots); verify matches by id with exact set-equality; build detects shared pages and gated destructive removals.
- [ ] **Step 6: Full suite** (docs add no tests) → PASS (unchanged). Commit the docs + trailers.

---

## Self-Review

**Sol finding → task that fixes it:**
| Finding | Fixed in | How |
|---------|----------|-----|
| **C1** reconcile must use EXISTENCE, not membership | **Task 4** (`reconcilePageIds(…, existenceIds)`) + **Task 5** (`enumerateEnv` feeds it) | A crash-orphaned id is in existence → reused. Tests: crash-after-create convergence + finalizer-failure retry (Task 5 Step 2). |
| **C2** uncertain-create must use env-wide, not app-scoped | **Task 2** (`upload` env-wide before/after diff) | Never re-CREATE unless env proves absence; adopt the one new id for our name; else HALT. |
| **C3** keep `pageId` in edit-snapshot; spec pageId highest authority; validate optional `pageId` | **Task 3** (accept `pages[].pageId`) + **Task 4** (authority #1) + **Task 6** (`hydrate-spec` emits it) | Maker-add → download → rebuild uses the ORIGINAL id (Task 6 round-trip test). |
| **C4** fail-closed, discriminated reads | **Task 1** (`fetchSitemap` `{ok,…}|{ok:false,reason}`) + **Task 2** (`enumerateEnv` via `classifyListOutput`) | A read failure HALTs (`pages-sitemap-read-failed`/`pages-existence-failed`); never `[]`→"empty"→recreate. |
| **Imp5** detect+HALT shared pages (report-only) | **Task 1** (`fetchAppsForPages`) + **Task 5** (`pages-shared-across-apps`) | Env-wide sitemap scan (GROUNDED: a genpage has no `appmodulecomponent` row → the sitemap XML is the only signal); `excludeAppUnique` minimal-work gate; two-app mock test; FAIL-CLOSED on scan error (`pages-shared-check-failed`). |
| **Imp6** detect+HALT removals unless `--allow-destructive` | **Task 5** (`pages-removed` gate) + thread `allowDestructive` | `(sitemap ∪ manifest) − (kept ids)`; test asserts HALT then proceed-with-flag. |
| **Imp7** verify existence+membership; `unableToRun`/`page-identity`; set-equality; one snapshot each | **Task 7** | Cached `existenceIds()`/`membership()`; `page-extra` set-equality; manifest-uncorrelatable → `unableToRun`. |
| **Imp8** eval harness `plan` profile + headless fixture | **Task 3** | Fixture places `order-detail`; harness run asserts exit 0. |
| **Imp9** real mocks | **Tasks 1/5/7** | Three-`queryRecords` `fetchSitemap` mocks; real 36-char GUIDs; assert `upload.pageId === priorId`; no `siteMapObjGenPageIds`; XML-entity-decoded titles. |
| **Imp10** atomic reconcile-signature change | **Tasks 4+5+6** land first behind Tasks 1/2, committed as ONE commit | Full suite never committed red (per-task files green in isolation). |
| **Imp11** parseManifest reject dup ids | **Task 4** (`seenIds`) | 1:1 key↔id; dup-id parse test. |

**Interface consistency (verified across tasks):**
- `reconcilePageIds(pages, manifest, existenceIds) → { keyToId, absentKeys, conflicts }` — defined Task 4; consumed identically by Task 5 (build) + Task 6 (download).
- `fetchSitemap(sdk, appUnique) → { ok, xml, ids } | { ok:false, reason }` — Task 1; consumed by Task 5 (membership/removal), Task 6 (download enum), Task 7 (verify membership).
- `enumerateEnv() → { ok, ids, pages } | { ok:false, error }` — Task 2 (`ids` is the canonical existence field; `pages` adds names for the C2 diff); consumed by Task 5 (reconcile input) + Task 7 (verify existence) + Task 2's own `upload`.
- `genpage-cli.download({ appId, outputDir, pageIds })` — Task 2; consumed by Task 6 + Task 7.
- `fetchAppsForPages(sdk, pageIds) → { ok, byId } | { ok:false, error }` — Task 1; consumed by Task 5 (Imp5).

**Placeholder scan:** none. Every step pastes the real code; anchors cite exact files/line ranges verified against the current tree (`sdk-build.js:1148-1271`, `genpage-cli.js:178-248`, `verify-spec.js:68-124`, `app-spec.js:500-591`, `page-manifest.js:90-227`, `download-model-app.js:219-263`, `hydrate-spec.js:77-96`, `build-model-app.js:230-242`, `facts.js:26`, `fixtures/2-orders-multipage/app-spec.json`).

**Judgment calls the reviewer should check (round-2 residual risk):**
1. **`conflicts` semantics.** The `reconcilePageIds` interface lists `conflicts` but not its meaning; I defined it as **"≥2 distinct keys resolve to one live id"** (a 1:1 identity violation → build/download HALT), the reconcile-time complement to Imp11's parse-time dup-id rejection (which catches spec-pageId↔manifest collisions the manifest alone can't). Confirm this is the intended shape.
2. **Imp5/Imp6 placement in the pages phase (not the build-model-app preflight/op-diff).** Both gates live in the engine because they need the reconciled live set + `keyToId` (which ids will be UPDATEd), reusing the same `enumerateEnv`/`fetchSitemap` reads (so the gate and the engine can never disagree). This required threading `opts.allowDestructive` into `runSdkBuild` — a small deviation from the codebase's "the destructive gate lives in the CLI wrapper, not the engine" note (`build-model-app.js:163`). **Residual risk:** the pages phase only runs when `spec.pages` is non-empty, so a spec that removes **ALL** pages would not trigger the `pages-removed` gate here; if that edge must be covered, add a mirror check in the `build-model-app.js` preflight (extend `op-diff.js`, which currently OMITS genpage subareas at `:23-24`). Flagging for a decision.
3. **Imp5 shared-page detection is now GROUNDED + FAIL-CLOSED on scan error.** A live probe (aurorabapenv03468) confirmed a generative page has **no `appmodulecomponent` row** — `objectid eq <genPageId>` returns 0 rows; the sitemap XML `GenPageId` attr is the ONLY membership signal, with no direct genpage→apps join. So `fetchAppsForPages` scans every OTHER app's sitemap (cost O(number of apps)); `excludeAppUnique` skips self so a single-app env reads zero other sitemaps (minimal work). The scan is **fail-closed on the enumeration** (a failed `appmodule` list → HALT `pages-shared-check-failed`, `recoverable:true` so a transient failure retries) and **best-effort per app** (an unreadable app is warned as partial coverage, not fatal). **Residual risk for Sol:** (a) there is no `--allow-destructive`-style escape for `pages-shared-check-failed`, so a *persistent* `appmodule`-read failure (e.g. a permissions gap) blocks the build by design — confirm this is desired or add an escape; (b) per-app unreadable sitemaps are skipped (a page shared only via an unreadable app would be missed) — confirm best-effort-per-app is acceptable vs. fully fail-closed; (c) the O(apps) scan runs on every build with ≥1 reused page id — confirm the cost is acceptable at scale, or gate it behind a cheaper signal.
4. **Download reconciles against the sitemap ids (membership), not env-wide existence.** For download the relevant "exists" set is the app's own pages, so `reconcilePageIds(manifestPages, manifest, sitemapIds)` binds keys only to ids in THIS app — intentional divergence from the build (which passes env-wide existence for crash-safety). Confirm this is the right scoping.
5. **Verify treats a fail-closed existence/membership read as `unableToRun`** (reader-incapacity) rather than a hard non-zero "missing" — matching the C6 semantics the codebase already uses for page verification. Confirm that a truly unreadable sitemap on a page-bearing verify SHOULD surface as `unableToRun` (build gate turns it non-zero) rather than a distinct failure.

---
