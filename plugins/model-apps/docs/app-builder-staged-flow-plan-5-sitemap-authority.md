# Plan 5 — Sitemap-as-Authority for Generative Pages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the app's **sitemap** the single authoritative record of "which generative pages belong to this app," so build-reconcile, verify, and the download round-trip are correct and lossless — eliminating the headless-page orphan/duplicate class and the name-vs-title mismatch that live testing surfaced.

**Architecture:** Every generative page a build deploys MUST be attached to the app's sitemap as a `GenPage` subarea (validated fail-closed — no headless pages). Enumeration of "the app's pages" reads the app **sitemap XML** (which the SDK already owns and fetches) and extracts every `GenPageId`, instead of `pac model genpage list --app-id` (which returns the same set but named by sitemap *title*, and which is the *only* app-membership signal pac exposes). All identity matching across reconcile/verify/download is **by page id** (manifest `key→id` ↔ sitemap `GenPageId`), never by display name. Downloads pull each page by id (`pac model genpage download --page-id <ids>`).

**Tech Stack:** Node.js (CommonJS), `node:test`, the vendored `cds-maker-sdk.cjs` (Dataverse + sitemap), PAC CLI (`pac model genpage upload/download`).

## Global Constraints

- **Node**: repo runs on the system Node for tests; the vendored SDK's Jest suite needs Node 20 (not exercised by this plan).
- **Test/build**: from `plugins/model-apps/` — single file `node --test scripts/tests/<f>.test.js`; full suite `node scripts/run-tests.js`. Baseline at plan start: **687 passing, 0 failing** (main `users/akmaloo/model-app-authoring`).
- **Commit trailers (every commit), verbatim:**
  ```
  Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
  Copilot-Session: 42626da2-b66f-4162-acaa-b1127ef23d89
  ```
- **Never** `git add .`; add only each task's named files. Never add `.superpowers/` or any scratch dir.
- **No placeholders / TDD / DRY / YAGNI / frequent commits.** Every code step shows the actual code.
- **schemaVersion 2** is the only page shape the engine sees at runtime (`migrateAppSpec` runs on load). Page identity is the stable **key** (`pages[].key`), grammar `^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$`.

---

## Background: what live testing proved (the spec this plan implements)

A live multi-page build on `aurorabapenv03468` (an app whose `overview` page navigates to a `order-detail` page that is a nav target but **not** a sitemap subarea) established, with captured evidence:

1. `pac model genpage list --app-id <app>` is **sitemap-scoped**: it lists only pages reachable from the app's sitemap, and reports each page's **sitemap subarea title** in the `Name` column — not the page's own name. (`pac model genpage list` **without** `--app-id` lists the whole environment, with real names, but carries **no app column** — so it cannot answer "which of these belong to this app.")
2. Consequently, the headless `order-detail` page was **invisible** to `list`/`download`; `download-model-app.js` produced a spec with `pages: 1` (dropped it), left a raw GUID `pageId` in the sibling `.tsx` (nav not reverse-resolved), and the recovered spec **failed `validateAppSpec`** (`navigatesTo target 'order-detail' is not a known page key`).
3. `verify-model-app.js` reported both pages missing: the headless one (not listed) and the `overview` one (its spec name `Orders Overview` ≠ the sitemap title `Overview` that pac reported).
4. Microsoft docs confirm model-driven app sitemaps have **no hidden-but-navigable subarea** — a page is either a visible sitemap subarea or removed from the sitemap (direct-link only). So there is no "hidden owned entry"; app membership **is** sitemap presence.

The build engine itself (solution/tables/forms/views/app/`PAGEREF_` resolution/manifest/sitemap finalize) worked correctly live. The defect is confined to the **enumeration/identity layer** that assumed `pac genpage list` returns every app page by its real name. This plan replaces that layer with the sitemap-as-authority model.

Also fixed en route (already on `main`, not part of this plan): the real `pac genpage list` **table** output format (`parseList`), and a fail-OPEN in `classifyListOutput`.

---

## The invariant this plan establishes

> **Every generative page a build deploys for an app is a `GenPage` subarea in that app's sitemap. The app's sitemap `GenPageId` set is the complete, authoritative list of the app's pages. All page identity is matched by id (manifest `key→id` ↔ sitemap `GenPageId`), never by display name.**

Corollaries the tasks enforce/rely on:
- **No headless pages.** Validation rejects a `pages[]` entry that no `appShell` subarea references, and a `navigatesTo.targetKey` whose page is not sitemap-attached. (The `generate-pages`/author flow already authors `appShell`; this makes the sitemap-attachment a hard requirement.)
- **Enumeration = read the sitemap.** `reconcile` (build), `verify`, and `download` obtain the live page-id set from the app's **sitemap XML** (`GenPageId` attrs), not from `pac genpage list --app-id`.
- **Match by id.** Reconcile binds `key→id` from the manifest and confirms the id is in the sitemap set. Verify checks each spec page's manifest id is in the sitemap set and (for a page-subarea) that the sitemap binds it. Download pulls each sitemap `GenPageId` and re-keys via the manifest.
- **`pac model genpage download --page-id <ids>`** pulls exactly the sitemap's pages (headless-free), so the round-trip is lossless and reverse-resolution has every id→key.

---

## File Structure (what changes and why)

| File | Responsibility | Change |
|------|----------------|--------|
| `scripts/lib/sitemap-pages.js` *(new)* | Pure extractor: sitemap XML → the app's `GenPageId`s (and their subarea titles). | Create. One responsibility: parse `GenPageId` out of a sitemap. |
| `scripts/lib/app-spec.js` | App Spec validation. | Add the **every-page-is-a-sitemap-subarea** rule + nav-target-must-be-sitemap-page (fail-closed). |
| `scripts/lib/page-manifest.js` | Durable manifest + reconcile authority. | Change `reconcilePageIds` to reconcile against a **live id set** (from the sitemap) by id, dropping name-based matching. |
| `scripts/lib/genpage-cli.js` | `pac model genpage` wrapper. | Add `download({ appId, pageIds, outputDir })` (download specific ids via `--page-id`). Keep `upload`. Retire `enumerate`/`list` from the app-membership path (kept only for env-wide orphan tooling). |
| `scripts/lib/sdk-build.js` | Build engine — pages phase. | Enumerate the app's pages from the **fetched sitemap**; reconcile by id; every page's `GenPage` subarea is finalized; nav resolution uses sitemap ids. Remove the `genpageCli.enumerate` dependency. |
| `scripts/lib/verify-spec.js` | Spec-vs-deployed reconcile core. | Page checks match **by id** via the manifest + sitemap `GenPageId` set (not by name). |
| `scripts/verify-model-app.js` | Verify CLI + reader. | `readerFor` `pages()` returns the sitemap `GenPageId`s; the reader supplies the manifest so verify matches by id; `pageCode(id)` downloads by id. |
| `scripts/download-model-app.js` | Edit-flow download. | Enumerate from the sitemap `GenPageId`s; download **by id**; reconcile/re-key by id; reverse-resolve by id→key. |
| Docs (`references/rules.md`, `references/app-spec-schema.md`, `skills/app-builder/SKILL.md`, `agents/genpage-page-builder.md`, `docs/architecture.md`, `CHANGELOG.md`, `AGENTS.md`, `docs/app-builder-roadmap.md`) | User/agent contract. | Document the every-page-in-sitemap rule, id-based identity, and the removal of headless nav targets. |

---

## Task 1: `sitemap-pages.js` — the pure sitemap → GenPageId extractor

The single structural reader of "which pages does this app's sitemap contain." Used by build, verify, and download so all three agree on the authoritative page set.

**Files:**
- Create: `scripts/lib/sitemap-pages.js`
- Create: `scripts/tests/sitemap-pages.test.js`

**Interfaces:**
- Consumes: for the pure extractors, nothing (leaf). For `fetchSitemapXml`, a `provision`/`sdk` handle with `queryRecords` + `odataLit` (I/O).
- Produces:
  - `sitemapGenPages(xml: string) → Array<{ pageId: string, title?: string }>` — one entry per `<SubArea … GenPageId="<guid>" …>` in the sitemap XML, id as written, with the subarea `Title`/`Description` if present. Deduped by id (a page attached in two areas yields one entry).
  - `sitemapGenPageIds(xml: string) → string[]` — sorted-unique lower-cased ids (the fast set for id membership tests).
  - `fetchSitemapXml(sdk, appUnique: string) → Promise<string>` — the app's **live** sitemap XML, resolved appmodule (by unique name) → appmodulecomponent (componenttype 62) → sitemap.sitemapxml; `''` when the app/sitemap isn't found. **This is `sitemapXmlFor` MOVED here from `verify-model-app.js` (DRY)** so the build (Task 5), verify (Task 6), and download (Task 7) all obtain the authoritative live sitemap the SAME way — a direct Dataverse query, not the fetched app artifact's in-memory shape (which is created-this-run and may not reflect the live deployed sitemap). `verify-model-app.js` re-exports it from here.

> **Why a live query, not `fetchArtifact('app').siteMap`:** the build's `app-shell` phase creates a fresh app with `omitUnbuiltPages:true` (no `GenPage` subareas), and the existing-app branch **defers** the sitemap write to the pages finalizer (C2). So the *live* deployed sitemap at pages-phase START is: empty of genpages on a fresh build (→ all pages absent → create), or the PRIOR run's genpages on a rebuild (→ reconcile reuses them). A live `sitemapxml` query returns exactly that; the in-memory `appDef(...).siteMap` we're about to push does not. This makes reconcile correct for both fresh and rebuild.

**Why this shape:** the vendored SDK already parses `GenPageId="([0-9a-fA-F-]{36})"` from sitemap XML (`cds-maker-sdk.cjs`), and `verify-spec.js` has `subareaHasGenPage(xml, id)` for a single id — this task generalizes to "list all," reusing the same attribute contract (match `GenPageId` specifically; a `Url`/`Id` elsewhere on the SubArea must not be mistaken for a page id).

- [ ] **Step 1: Write the failing test** — `scripts/tests/sitemap-pages.test.js`

```javascript
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { sitemapGenPages, sitemapGenPageIds } = require('../lib/sitemap-pages.js');

// A realistic sitemap fragment: two GenPage subareas + an entity subarea + a decoy Url that is a GUID.
const XML = [
  '<SiteMap>',
  '  <Area Id="Sales" Title="Sales">',
  '    <Group Id="Work" Title="Work">',
  '      <SubArea Id="s1" GenPageId="13ecbc57-a3a4-4132-b0a2-a6c6b12691e8" Title="Overview" />',
  '      <SubArea Id="s2" Entity="new_liveorder" Title="Orders" />',
  '      <SubArea Id="s3" GenPageId="5C0A4889-45FD-46EA-91A8-FF876914D644" Title="Order Detail" />',
  '      <SubArea Id="s4" Url="https://x/00000000-0000-0000-0000-000000000000" Title="Decoy" />',
  '    </Group>',
  '  </Area>',
  '</SiteMap>',
].join('\n');

test('sitemapGenPages returns one entry per GenPage subarea (id + title), case-insensitive id, decoys ignored', () => {
  const rows = sitemapGenPages(XML);
  assert.strictEqual(rows.length, 2, 'only the two GenPageId subareas count (not the Entity or the Url decoy)');
  assert.deepStrictEqual(
    rows.map((r) => ({ pageId: r.pageId.toLowerCase(), title: r.title })).sort((a, b) => a.pageId.localeCompare(b.pageId)),
    [
      { pageId: '13ecbc57-a3a4-4132-b0a2-a6c6b12691e8', title: 'Overview' },
      { pageId: '5c0a4889-45fd-46ea-91a8-ff876914d644', title: 'Order Detail' },
    ],
  );
});

test('sitemapGenPageIds returns sorted-unique lower-cased ids; a page attached twice is deduped', () => {
  const twice = XML.replace('</Group>', '      <SubArea Id="s5" GenPageId="13ECBC57-A3A4-4132-B0A2-A6C6B12691E8" Title="Overview (dup)" />\n    </Group>');
  assert.deepStrictEqual(sitemapGenPageIds(twice), ['13ecbc57-a3a4-4132-b0a2-a6c6b12691e8', '5c0a4889-45fd-46ea-91a8-ff876914d644']);
});

test('empty / malformed / no-genpage sitemap → []', () => {
  assert.deepStrictEqual(sitemapGenPages(''), []);
  assert.deepStrictEqual(sitemapGenPageIds('<SiteMap><Area><Group><SubArea Entity="x"/></Group></Area></SiteMap>'), []);
  assert.deepStrictEqual(sitemapGenPageIds(null), []);
});
```

- [ ] **Step 2: Run the test to verify it fails** — `node --test scripts/tests/sitemap-pages.test.js` → FAIL (module missing).

- [ ] **Step 3: Implement** — `scripts/lib/sitemap-pages.js`

```javascript
'use strict';
// Pure extractor of an app's generative pages FROM ITS SITEMAP XML. A generative-page subarea stores its
// page id in the `GenPageId="<guid>"` attribute SPECIFICALLY (the SDK writes/reads exactly this — see
// cds-maker-sdk.cjs which parses /GenPageId="([0-9a-fA-F-]{36})"/, and the sitemap subarea attribute set
// ["Entity","Url","DefaultDashboard","Page","GenPageId"]). The sitemap is the AUTHORITATIVE, complete
// record of which pages belong to the app (model-driven-app membership == sitemap presence — a page NOT in
// the sitemap is not owned by / navigable-in the app). We therefore enumerate the app's pages by reading
// its sitemap, NOT via `pac model genpage list --app-id` (which returns the same set but named by subarea
// title, and is the only app-membership signal pac exposes anyway).

// Match a <SubArea …> START TAG that carries a GenPageId, capturing the id and (optionally) the Title.
// Attributes are order-independent, so scan each SubArea start tag and pull GenPageId + Title separately.
const SUBAREA_RE = /<SubArea\b[^>]*>/gi;
const GENPAGE_ATTR = /\bGenPageId="([0-9a-fA-F-]{36})"/i;
const TITLE_ATTR = /\bTitle="([^"]*)"/i;
const DESC_ATTR = /\bDescription="([^"]*)"/i;

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
    out.push(t ? { pageId, title: t[1] } : { pageId });
  }
  return out;
}

// Sorted-unique lower-cased ids — the fast membership set for reconcile/verify.
function sitemapGenPageIds(xml) {
  return Array.from(new Set(sitemapGenPages(xml).map((r) => r.pageId.toLowerCase()))).sort();
}

// Fetch the app's LIVE sitemap XML (a direct Dataverse query — the authoritative source; NOT the
// created-this-run in-memory artifact). Resolves appmodule (by unique name) → appmodulecomponent
// (componenttype 62) → sitemap.sitemapxml. Returns '' when the app/sitemap isn't found. MOVED here from
// verify-model-app.js's `sitemapXmlFor` so build/verify/download share one path (DRY). `odataLit` escapes
// the unique name for the OData filter.
async function fetchSitemapXml(sdk, appUnique) {
  const { odataLit } = require('./odata.js');
  const apps = await sdk.queryRecords('appmodule', { select: ['appmoduleid', 'appmoduleidunique'], filter: `uniquename eq '${odataLit(appUnique)}'`, top: 1 });
  const app = apps && apps[0];
  if (!app) return '';
  const comps = await sdk.queryRecords('appmodulecomponent', { select: ['objectid', 'componenttype'], filter: `_appmoduleidunique_value eq ${app.appmoduleidunique} and componenttype eq 62`, top: 1 });
  const smId = comps && comps[0] && comps[0].objectid;
  if (!smId) return '';
  const sms = await sdk.queryRecords('sitemap', { select: ['sitemapxml'], filter: `sitemapid eq ${smId}`, top: 1 });
  return (sms && sms[0] && sms[0].sitemapxml) || '';
}

module.exports = { sitemapGenPages, sitemapGenPageIds, fetchSitemapXml };
```

- [ ] **Step 4: Run the test to verify it passes** — `node --test scripts/tests/sitemap-pages.test.js` → PASS.
- [ ] **Step 5: Full suite** — `node scripts/run-tests.js` → PASS (688).
- [ ] **Step 6: Commit** — `git add scripts/lib/sitemap-pages.js scripts/tests/sitemap-pages.test.js` + trailers.

---

## Task 2: App Spec validation — every page is a sitemap subarea (no headless pages)

Enforce the invariant at authoring time (fail-closed): every declared page must be attached to the sitemap, and every nav target must be such a page. This is what makes the sitemap authoritative — the build can never deploy a page the sitemap doesn't own.

**Files:**
- Modify: `scripts/lib/app-spec.js` — the page/nav validation block (`:546-567`) + the sitemap-subarea loop (`:576-590`).
- Modify: `scripts/tests/app-spec.test.js` — new assertions.

**Interfaces:**
- Consumes: `isV2`, `pageKeysSet` (already built in `validateAppSpec` before the page loop, `:473-474`).
- Produces: two new error classes in `validateAppSpec(spec, { profile })`:
  - `page '<key>' is not placed in the sitemap — every page must be an appShell subarea (a page reached only by navigation is not owned by the app; add a subarea for it)`
  - (existing nav-target error is retained; a nav target that isn't in `pages[]` already errors, and every page must now be sitemapped, so a nav target is transitively required to be a subarea).

> **Profile scope:** apply this rule for the `deploy` and `plan`/`design` profiles (a page-bearing spec being built). The `structural` profile (used by the eval harness for pure fact extraction) must NOT enforce sitemap placement — it validates shape only. Confirm the profile constants by reading the top of `validateAppSpec`.

- [ ] **Step 1: Write the failing test** — append to `scripts/tests/app-spec.test.js`

```javascript
const { test } = require('node:test');
const assert = require('node:assert');
const { validateAppSpec, migrateAppSpec } = require('../lib/app-spec.js');

function v2PagesSpec(subAreas) {
  return migrateAppSpec({
    schemaVersion: 2,
    solution: { uniqueName: 'S', publisherPrefix: 'new' },
    app: { name: 'A' },
    entities: [{ schemaName: 'new_order', displayName: 'Order', primaryAttribute: { schemaName: 'new_name', displayName: 'Order #' }, columns: [] }],
    pages: [
      { key: 'overview', name: 'Overview', source: { kind: 'tsx', codeFile: 'overview.tsx' }, navigatesTo: [{ targetKey: 'order-detail' }] },
      { key: 'order-detail', name: 'Order Detail', source: { kind: 'tsx', codeFile: 'order-detail.tsx' } },
    ],
    appShell: { areas: [{ label: 'Sales', groups: [{ label: 'Work', subAreas }] }] },
  });
}

test('validateAppSpec REJECTS a page with no sitemap subarea (headless page — deploy profile)', () => {
  // Only overview is placed; order-detail (a nav target) is headless → rejected.
  const spec = v2PagesSpec([{ page: 'overview', title: 'Overview' }, { entity: 'new_order', title: 'Orders' }]);
  const r = validateAppSpec(spec, { profile: 'deploy' });
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => /order-detail/.test(e) && /not placed in the sitemap|every page must be/i.test(e)), `expected a headless-page error; got ${JSON.stringify(r.errors)}`);
});

test('validateAppSpec ACCEPTS when every page is a sitemap subarea', () => {
  const spec = v2PagesSpec([
    { page: 'overview', title: 'Overview' },
    { page: 'order-detail', title: 'Order Detail' },
    { entity: 'new_order', title: 'Orders' },
  ]);
  const r = validateAppSpec(spec, { profile: 'deploy' });
  assert.ok(r.ok, `expected ok; got ${JSON.stringify(r.errors)}`);
});

test('the structural profile does NOT enforce sitemap placement (eval-harness shape-only)', () => {
  const spec = v2PagesSpec([{ page: 'overview', title: 'Overview' }]); // order-detail headless
  const r = validateAppSpec(spec, { profile: 'structural' });
  assert.ok(!r.errors.some((e) => /not placed in the sitemap/.test(e)), 'structural profile skips the placement rule');
});
```

- [ ] **Step 2: Run to verify it fails** — `node --test scripts/tests/app-spec.test.js` → FAIL (headless page currently accepted).

- [ ] **Step 3: Implement** — in `scripts/lib/app-spec.js`, after the sitemap-subarea loop closes (after `:590`, still inside `validateAppSpec`, where `isV2`, `pageKeysSet`, and the profile are in scope). First collect the set of page keys the sitemap references, then require every page key to be present:

```javascript
  // Every generative page MUST be attached to the app's sitemap (a page reached only by navigation is not
  // owned by the app — model-driven-app membership is sitemap presence; there is no hidden-but-navigable
  // subarea). Enforce for a spec that will be BUILT (deploy/plan/design); the `structural` profile is
  // shape-only (the eval harness) and skips this. This is what lets the build/verify/download treat the
  // sitemap's GenPageId set as the complete, authoritative page list (Plan 5).
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

> Confirm `profile` is the variable name in `validateAppSpec` (read `:460-475`). The `pageRefSet` lint fix (Plan 4) already made `sa.page` accept keys for v2, so a sitemap `{ page: '<key>' }` resolves — reuse that. Do NOT change the existing nav-target validation.

- [ ] **Step 4: Run to verify it passes** — `node --test scripts/tests/app-spec.test.js` → PASS.
- [ ] **Step 5: Full suite** — `node scripts/run-tests.js` → **watch for fixtures that now fail**: any existing test spec with a page that lacks a subarea must be updated to place the page (that is the new contract). Fix those fixtures. Expected green (≈ 691).
- [ ] **Step 6: Commit** — `git add scripts/lib/app-spec.js scripts/tests/app-spec.test.js` (+ any fixture files you had to update) + trailers.

---

## Task 3: `reconcilePageIds` — reconcile by id against the sitemap set (drop name-matching)

The reconcile authority now matches spec pages to live pages **by id** (manifest `key→id`, confirmed present in the sitemap id set), not by display name. Name-based adoption and the ambiguous-name HALT disappear (id matching cannot be ambiguous), removing the exact class of bug where a title/name mismatch or a duplicate name misbound a page.

**Files:**
- Modify: `scripts/lib/page-manifest.js` — `reconcilePageIds` (`:165-227`).
- Modify: `scripts/tests/page-manifest.test.js` — rewrite the reconcile tests for the id-set signature.

**Interfaces:**
- **Signature change (breaking — Tasks 5/7 updated to match):**
  `reconcilePageIds(pages, manifest, liveIds) → { keyToId: Map<key,id>, absentKeys: string[] }`
  where `liveIds` is an **array or Set of page ids present live** (the app's sitemap `GenPageId`s from Task 1). Authority:
  1. `manifest[key].pageId` **and** that id ∈ `liveIds` (case-insensitive) → reuse (bind `key→id`).
  2. otherwise → `absentKeys` (needs a create).
  - No name lookup, no `ambiguous` return (id matching is unambiguous — each key maps to at most one manifest id). Callers drop their `ambiguous` HALT branch.

- [ ] **Step 1: Rewrite the reconcile tests** — replace the `reconcilePageIds` tests in `scripts/tests/page-manifest.test.js`

```javascript
const { reconcilePageIds } = require('../lib/page-manifest.js');

const MAN = { schemaVersion: 1, pages: [
  { key: 'overview', name: 'Overview', pageId: 'gp-o' },
  { key: 'order-detail', name: 'Order Detail', pageId: 'gp-d' },
] };

test('reconcilePageIds binds key→id when the manifest id is present in the live sitemap set (case-insensitive)', () => {
  const pages = [{ key: 'overview', name: 'Overview' }, { key: 'order-detail', name: 'Order Detail' }];
  const { keyToId, absentKeys } = reconcilePageIds(pages, MAN, ['GP-O', 'gp-d']); // note casing differs
  assert.strictEqual(keyToId.get('overview'), 'gp-o');
  assert.strictEqual(keyToId.get('order-detail'), 'gp-d');
  assert.deepStrictEqual(absentKeys, []);
});

test('reconcilePageIds marks a page ABSENT when its manifest id is NOT in the live set (rebuild after Maker delete)', () => {
  const pages = [{ key: 'overview', name: 'Overview' }, { key: 'order-detail', name: 'Order Detail' }];
  const { keyToId, absentKeys } = reconcilePageIds(pages, MAN, ['gp-o']); // gp-d no longer live
  assert.strictEqual(keyToId.get('overview'), 'gp-o');
  assert.ok(!keyToId.has('order-detail'));
  assert.deepStrictEqual(absentKeys, ['order-detail']);
});

test('reconcilePageIds: no manifest / empty live → every page absent (fresh build)', () => {
  const pages = [{ key: 'overview', name: 'Overview' }];
  assert.deepStrictEqual(reconcilePageIds(pages, null, []).absentKeys, ['overview']);
  assert.deepStrictEqual(reconcilePageIds(pages, MAN, []).absentKeys, ['overview']); // manifest id not live → absent
});

test('reconcilePageIds never returns ambiguous (id matching is unambiguous)', () => {
  const r = reconcilePageIds([{ key: 'overview', name: 'Overview' }], MAN, ['gp-o']);
  assert.ok(!('ambiguous' in r) || r.ambiguous.length === 0);
});
```

- [ ] **Step 2: Run to verify it fails** — `node --test scripts/tests/page-manifest.test.js` → FAIL (old signature takes `livePages` objects; `ambiguous` still returned).

- [ ] **Step 3: Implement** — replace `reconcilePageIds` (`:153-227`) in `scripts/lib/page-manifest.js`

```javascript
// Reconcile the spec's declared pages against the durable manifest AND the app's LIVE page-id set (the
// sitemap's GenPageId set — Plan 5; sitemap-pages.js). Identity is matched BY ID, never by display name:
//   1. manifest key→pageId, and that id is still present live → reuse (a confirmed id is truth even if the
//      display name/subarea title drifted).
//   2. otherwise → absent (mint a fresh id via a create).
// There is no name-based adoption and no ambiguous-name case: each key maps to at most one manifest id, and
// the sitemap set is authoritative for "does it still exist," so misbinding-by-name is impossible.
// `liveIds` is an array/Set of ids present live (case-insensitive). Returns { keyToId, absentKeys }.
function reconcilePageIds(pages, manifest, liveIds) {
  const liveSet = new Set(Array.from(liveIds || []).map((id) => String(id).toLowerCase()));
  const manifestByKey = new Map(
    ((manifest && manifest.pages) || []).filter((p) => p && p.key).map((p) => [p.key, p]),
  );
  const keyToId = new Map();
  const absentKeys = [];
  for (const p of pages || []) {
    const key = p.key || p.name;
    const mp = manifestByKey.get(key);
    if (mp && mp.pageId && liveSet.has(String(mp.pageId).toLowerCase())) {
      keyToId.set(key, mp.pageId); // (1) manifest id confirmed live
    } else {
      absentKeys.push(key); // (2) create
    }
  }
  return { keyToId, absentKeys };
}
```

- [ ] **Step 4: Run to verify it passes** — `node --test scripts/tests/page-manifest.test.js` → PASS. (Tasks 5/7 update the callers; until then the full suite may show sdk-build/download reconcile-call failures — that is expected and fixed in those tasks. Run this task's file green, commit, and proceed.)
- [ ] **Step 5: Commit** — `git add scripts/lib/page-manifest.js scripts/tests/page-manifest.test.js` + trailers. (Full suite goes green at the end of Task 5 + Task 7, which migrate the two callers.)

> **Sequencing note:** Tasks 3 → 5 → 7 are a coupled trio (the reconcile signature + its two callers). Implement them back-to-back; do not merge to main between them with a red full suite. Task 4 (genpage-cli download-by-id) is independent and can land before Task 5.

---

## Task 4: `genpage-cli.js` — download specific pages by id (`--page-id`)

Add id-scoped download so verify/download can pull exactly the sitemap's pages (headless-free, real content). `pac model genpage download --page-id` takes a comma-separated id list (confirmed live in help).

**Files:**
- Modify: `scripts/lib/genpage-cli.js` — the `download` method.
- Modify: `scripts/tests/genpage-cli.test.js` — new download-by-id test.

**Interfaces:**
- **`download({ appId, outputDir, pageIds })`** — when `pageIds` (a non-empty array) is provided, pass `--page-id <comma-joined>`; otherwise download all app pages (existing behavior, retained for back-compat). Returns whatever the current `download` returns.

- [ ] **Step 1: Write the failing test** — append to `scripts/tests/genpage-cli.test.js`

```javascript
test('download passes --page-id <comma-joined> when pageIds is provided', async () => {
  let seen;
  const run = async (args) => { if (args[2] === 'download') { seen = args; return { status: 0, stdout: '', stderr: '' }; } return { status: 0, stdout: '', stderr: '' }; };
  await makeGenpageCli('https://x', { run, sleep: async () => {} }).download({ appId: 'a', outputDir: 'o', pageIds: ['gp-1', 'gp-2'] });
  const i = seen.indexOf('--page-id');
  assert.ok(i > 0, '--page-id passed');
  assert.strictEqual(seen[i + 1], 'gp-1,gp-2', 'ids are comma-joined');
});

test('download omits --page-id when pageIds is empty/absent (all-pages back-compat)', async () => {
  let seen;
  const run = async (args) => { if (args[2] === 'download') { seen = args; return { status: 0, stdout: '', stderr: '' }; } return { status: 0, stdout: '', stderr: '' }; };
  await makeGenpageCli('https://x', { run, sleep: async () => {} }).download({ appId: 'a', outputDir: 'o' });
  assert.ok(!seen.includes('--page-id'), 'no --page-id when not requested');
});
```

- [ ] **Step 2: Run to verify it fails** — `node --test scripts/tests/genpage-cli.test.js` → FAIL.
- [ ] **Step 3: Implement** — in `genpage-cli.js` `download`, build the args and conditionally append `--page-id`:

```javascript
    async download({ appId, outputDir, pageIds }) {
      const args = ['model', 'genpage', 'download', '--environment', env, '--app-id', appId, '--output-directory', outputDir];
      // Plan 5: pull exactly the sitemap's pages by id (headless-free, real content). pac accepts a
      // comma-separated id list; omit the flag to keep the all-pages behavior for any legacy caller.
      if (pageIds && pageIds.length) args.push('--page-id', pageIds.join(','));
      const r = await run(args);
      // (keep the existing success/parse handling that follows — read the real method and preserve it)
      return r;
    },
```

> Read the real `download` body first and preserve its return/parse/error handling; only add the `--page-id` arg wiring and the `outputDir` flag name it already uses (`--output-directory`).

- [ ] **Step 4: Run to verify it passes** → PASS.
- [ ] **Step 5: Full suite** — `node scripts/run-tests.js` → PASS (≈ 693).
- [ ] **Step 6: Commit** — `git add scripts/lib/genpage-cli.js scripts/tests/genpage-cli.test.js` + trailers.

---

## Task 5: Build engine — enumerate the app's pages from the fetched sitemap; reconcile by id

The pages phase stops calling `genpageCli.enumerate` and instead reads the app's **live sitemap** (fetched via the SDK) → `GenPageId`s → the live id set, reconciles by id, and continues the existing `PAGEREF_` protocol (scan/parity → create-absent-first for nav targets → resolve → upload-once → persist manifest → finalize sitemap). Because every page is now a sitemap subarea (Task 2), the finalized sitemap contains a `GenPage` subarea for every page, so the next run's sitemap-read is complete.

**Files:**
- Modify: `scripts/lib/sdk-build.js` — require `sitemap-pages.js`; the pages phase (`:1148-1270`).
- Modify: `scripts/tests/sdk-build.test.js`, `scripts/tests/sdk-build-pages-deploy.test.js`, `scripts/tests/sdk-build-pages-order.test.js`, `scripts/tests/sdk-build-pages-migrate.test.js` — the genpageCli mocks drop `enumerate`; the SDK mock's `fetchArtifact('app', id)` returns a `siteMap` whose subareas carry `GenPageId`s for the "already-live" pages.

**Interfaces:**
- Consumes: `sitemapGenPageIds` (Task 1); `reconcilePageIds(pages, manifest, liveIds)` (Task 3, id-set signature); `readPageManifest`/`persistPageManifest` (unchanged); `extractNavTargets`/`resolvePageRefs`/`navTargetParity`/`navMalformedRefs` (unchanged); `writeStagingFile`/`acquireAppPagesLease` (unchanged).
- Produces: pages phase behavior unchanged externally (same HALT codes minus `pages-enumeration-failed`/`pages-ambiguous-name`, which are removed — see below), `result.created.pages[key] = id`, manifest persisted.

**Key behavioral changes:**
- The live page-id set comes from the app's sitemap. Fetch it once at the start of the pages phase: `const appArt = await provision.fetchArtifact('app', result.created.app); const liveIds = sitemapGenPageIds(sitemapXmlOf(appArt));` where `sitemapXmlOf` extracts the sitemap XML string from the fetched app artifact. **Confirm how the fetched app exposes its sitemap** — the SDK `fetchArtifact('app', id)` returns an object; the existing finalize step calls `provision.fetchArtifact('app', …)` then `appDef(...).siteMap` and `updateElement('/siteMap', …)`. Read how the app artifact holds its current sitemap (it may be `appArt.siteMap` as a JS object, not XML). **If it is a JS object, add a tiny pure `siteMapGenPageIds(siteMapObj)` that walks `areas→groups→subAreas` collecting `s.genPageId`** (mirror `sitemap-pages.js` but for the in-memory object) — put it in `sitemap-pages.js` as `siteMapObjGenPageIds(obj)` and unit-test it in Task 1's file. Use whichever representation the fetched artifact actually provides; do NOT assume XML.
- Remove `pages-enumeration-failed` (there is no `pac genpage list` call to fail) and `pages-ambiguous-name` (id matching is unambiguous). Keep `pages-requires-app`, `pages-malformed-navref`, `pages-nav-parity`, `pages-dangling-navref`, `pages-update-identity-mismatch`, `pages-locked`.
- The `reconcilePageIds(spec.pages, manifest, liveIds)` call now returns `{ keyToId, absentKeys }` (no `ambiguous`) — drop the `if (ambiguous.length) HALT`.
- Everything after reconcile (scan/parity, create-absent-first, staging, upload-once, persist, finalize) is UNCHANGED.

- [ ] **Step 1: Update the shared test mocks** — in each pages test file, (a) remove `enumerate` from the genpageCli mocks and (b) make the SDK mock's fetched app carry a sitemap with the "already-live" pages' `GenPageId`s. Concretely, in `sdk-build.test.js`'s `mockSdk`, the `fetchArtifact('app', id)` app branch returns `{ id, siteMap: opts.liveSiteMap || { areas: [] } }`; add a helper `liveSiteMapWith(pageIdsByTitle)` building `{ areas: [{ groups: [{ subAreas: Object.entries(pageIdsByTitle).map(([title,genPageId]) => ({ title, genPageId })) }] }] }`. Replace each test's `enumerate: async () => ({ ok, pages, empty })` with the corresponding `liveSiteMap` (a fresh build → `{ areas: [] }`; a rebuild-with-existing → the prior ids). Convert the enumeration-failure/ambiguous-name tests: `pages-enumeration-failed` and `pages-ambiguous-name` no longer exist — delete those two tests (they assert removed HALTs) and, in their place, add:

```javascript
test('pages phase reconciles the live sitemap ids by manifest (rebuild reuses, no duplicate create)', async () => {
  const spec = makeSpec();
  spec.schemaVersion = 2;
  spec.pages = [{ key: 'overview', name: 'Overview', source: { kind: 'tsx', codeFile: 'o.tsx' } }];
  spec.appShell.areas[0].groups[0].subAreas.push({ page: 'overview', title: 'Overview' });
  const appDir = stagePages(spec.pages);
  try {
    const existing = Buffer.from(JSON.stringify({ schemaVersion: 1, pages: [{ key: 'overview', name: 'Overview', pageId: 'gp-o' }] }), 'utf8').toString('base64');
    const { sdk, calls } = mockSdk({ pageManifest: existing, manifestId: 'wr-manifest', liveSiteMap: { areas: [{ groups: [{ subAreas: [{ title: 'Overview', genPageId: 'gp-o' }] }] }] } });
    let uploads = 0;
    const genpageCli = { upload: async (o) => { uploads += 1; return { pageId: o.pageId || 'gp-o' }; } };
    await runSdkBuild(spec, { sdk, apply: true, env: 'https://x', appDir, genpageCli, phases: ['solution', 'data-model', 'app-shell', 'pages'] });
    assert.strictEqual(uploads, 1, 'the existing page is UPDATEd in place (matched by manifest id in the live sitemap), never re-created');
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Require the extractor + update the pages phase** — in `sdk-build.js`:

```javascript
// require block:
const { sitemapGenPageIds, fetchSitemapXml } = require('./sitemap-pages.js');
```

Replace the `genpageCli.enumerate(...)` block at the top of the pages phase `try` with the live-sitemap read:

```javascript
      // Live page-id set = the app's LIVE SITEMAP GenPageIds (Plan 5 — the sitemap is the authoritative,
      // complete record of the app's pages; there is no `pac genpage list` here). A direct sitemapxml query
      // (fetchSitemapXml) returns the deployed sitemap: empty of genpages on a fresh build (→ all pages
      // absent → create), or the prior run's genpages on a rebuild (→ reconcile reuses them; the app-shell
      // phase deferred the sitemap write to the finalizer, C2, so the live sitemap still holds them here).
      const liveIds = sitemapGenPageIds(await fetchSitemapXml(provision, appUnique));
      const { id: readId, manifest, text } = await readPageManifest(provision, appUnique);
      let manifestId = readId;
      let lastManifestContent = text;
      const { keyToId } = reconcilePageIds(spec.pages, manifest, liveIds);
```

Delete the `if (!enumd.ok) throw …pages-enumeration-failed…` and the `if (ambiguous.length) throw …pages-ambiguous-name…` lines. Everything else in the pages phase (scan, create-absent-first, resolve, upload-once, persist, finalize, `finally` staging cleanup + lease release) stays.

- [ ] **Step 3: (removed)** — `fetchSitemapXml` replaces any need to read the in-memory app artifact's sitemap; no `siteMapObjGenPageIds` is required. If a future caller needs the in-memory object form, add it then (YAGNI).

- [ ] **Step 4: Run the pages tests + full suite** — `node --test scripts/tests/sdk-build.test.js scripts/tests/sdk-build-pages-deploy.test.js scripts/tests/sdk-build-pages-order.test.js scripts/tests/sdk-build-pages-migrate.test.js` → PASS; then `node scripts/run-tests.js` → PASS. Update any mock that still passes `enumerate`.
- [ ] **Step 5: Commit** — `git add scripts/lib/sdk-build.js scripts/lib/sitemap-pages.js scripts/tests/sitemap-pages.test.js scripts/tests/sdk-build*.test.js` + trailers.

---

## Task 6: Verify — match pages by id via the manifest + sitemap set

`verify-spec.js` stops matching pages by display name against `pac genpage list`. It matches each spec page to its **manifest id** and confirms that id is in the sitemap `GenPageId` set; the page-subarea check (already `GenPageId`-based) and the nav-edge check (already id-based) are retained. The reader (`verify-model-app.js`) supplies the sitemap ids + the manifest and downloads page code by id.

**Files:**
- Modify: `scripts/lib/verify-spec.js` — the page branch (`:68-120`).
- Modify: `scripts/verify-model-app.js` — `readerFor` (`pages()` → sitemap ids; add `manifest()`; `pageCode(id)` → download by id).
- Modify: `scripts/tests/verify-spec.test.js`, `scripts/tests/verify-model-app.test.js`.

**Interfaces:**
- `read.sitemapPageIds() → string[]` — the app's sitemap `GenPageId`s (replaces `read.pages()` for existence).
- `read.manifest() → { pages: [{ key, pageId, … }] } | null` — the durable manifest (key→id map source).
- `read.pageCode(pageId) → string` — download that page by id (unchanged contract, now id-scoped).
- `verifySpec` page checks:
  - `page` present: the spec page's manifest id exists AND is in `sitemapPageIds` (fail if no manifest id, or id not live).
  - `page-subarea`: `subareaHasGenPage(xml, id)` (unchanged, when the appShell references the page).
  - `page-nav`: each declared edge → the target's manifest id appears as a `literal` at a real nav call site (unchanged, id-based).
  - `unableToRun`: still set when the reader can't supply `sitemapPageIds`/`manifest`/`pageCode` for a page-bearing spec (Crit-6 semantics retained).

- [ ] **Step 1: Write failing tests** — in `verify-spec.test.js`, drive the page branch with a `read` mock exposing `sitemapPageIds`, `manifest`, `sitemapXml`, `pageCode`. Assert: (a) a page whose manifest id is in the sitemap set + bound in the sitemap XML → `page`/`page-subarea` pass; (b) a page whose manifest id is NOT in the sitemap set → `page` fails (missing); (c) a name≠title page still passes (matching is by id, not name); (d) missing `sitemapPageIds`/`manifest` on a page-bearing spec → `unableToRun`. In `verify-model-app.test.js`, assert `readerFor(...).sitemapPageIds()` returns the ids parsed from the fetched sitemap, and `pageCode(id)` calls `genpageCli.download({ pageIds: [id] })`.

```javascript
// verify-spec.test.js — id-based page verify (name != title must still pass)
function pageReadById({ sitemapIds, manifest, sitemapXml, code }) {
  return {
    findTable: async () => ({ logicalName: 'contoso_item' }), findColumns: async () => [], queryRecords: async () => [],
    sitemapXml: async () => sitemapXml || '',
    sitemapPageIds: async () => sitemapIds,
    manifest: async () => manifest,
    pageCode: async (id) => (code && code[String(id).toLowerCase()]) || '',
  };
}
test('verifySpec matches pages BY ID via the manifest (spec name != sitemap title still passes)', async () => {
  const spec = { schemaVersion: 2, entities: [{ schemaName: 'contoso_item', primaryAttribute: { schemaName: 'contoso_name' }, columns: [] }],
    pages: [{ key: 'overview', name: 'Orders Overview', source: { kind: 'tsx', codeFile: 'o.tsx' } }],
    appShell: { areas: [{ label: 'M', groups: [{ label: 'G', subAreas: [{ page: 'overview', title: 'Overview' }] }] }] } };
  const sitemapXml = '<SiteMap><Area><Group><SubArea GenPageId="gp-o" Title="Overview"/></Group></Area></SiteMap>';
  const read = pageReadById({ sitemapIds: ['gp-o'], manifest: { pages: [{ key: 'overview', pageId: 'gp-o' }] }, sitemapXml, code: { 'gp-o': 'export default 1;' } });
  const r = await verifySpec(spec, read);
  assert.ok(r.checks.find((c) => c.kind === 'page' && c.name === 'Orders Overview').present, 'page present by id despite name!=title');
});
```

- [ ] **Step 2: Run to verify it fails** — → FAIL (verify still name-matches / calls `read.pages()`).

- [ ] **Step 3: Implement `verify-spec.js` page branch** — replace the `read.pages()`-based section:

```javascript
  const implementedPages = (spec.pages || []).filter((p) => { const s = normalizePageSource(p); return s && s.kind === 'tsx' && s.codeFile; });
  // Reader-incapacity (Crit-6): a page-bearing spec needs id-based readers. Missing any → unableToRun.
  const unableToRun = !!(implementedPages.length && (typeof read.sitemapPageIds !== 'function' || typeof read.manifest !== 'function')) ||
    !!(implementedPages.some((p) => (p.navigatesTo || []).length > 0) && typeof read.pageCode !== 'function');
  if (implementedPages.length) {
    if (unableToRun) {
      add('page-verify', 'pages', false, 'the verify reader cannot read the sitemap page ids / manifest (unable to run)');
    } else {
      const liveIds = new Set(((await read.sitemapPageIds()) || []).map((id) => String(id).toLowerCase()));
      const man = (await read.manifest()) || { pages: [] };
      const idByKey = new Map((man.pages || []).filter((p) => p && p.key && p.pageId).map((p) => [p.key, p.pageId]));
      for (const p of implementedPages) {
        const key = p.key || p.name;
        const id = idByKey.get(key);
        const present = !!id && liveIds.has(String(id).toLowerCase());
        add('page', p.name, present);            // matched BY ID (manifest → sitemap), never by name
        if (!present) continue;
        if (appShellReferencesPage(spec, key)) add('page-subarea', p.name, subareaHasGenPage(xml, id));
        const nav = p.navigatesTo || [];
        if (!nav.length) continue;
        let code;
        try { code = (await read.pageCode(id)) || ''; } catch (e) { add('page-code', p.name, false, String((e && e.message) || e)); continue; }
        const targets = extractNavTargets(code);
        add('page-no-pageref', p.name, !targets.some((t) => t.kind === 'pageref' || t.kind === 'pageref-malformed'));
        const navLiteralIds = new Set(targets.filter((t) => t.kind === 'literal').map((t) => String(t.pageId).toLowerCase()));
        for (const edge of nav) {
          const targetId = idByKey.get(edge.targetKey);
          add('page-nav', `${p.name} -> ${edge.targetKey}`, !!targetId && navLiteralIds.has(String(targetId).toLowerCase()));
        }
      }
    }
  }
  const missing2 = checks.filter((c) => !c.present);
  return { ok: missing2.length === 0 && !unableToRun, checks, missing: missing2, unableToRun: unableToRun || undefined };
```

- [ ] **Step 4: Implement `verify-model-app.js` reader** — `readerFor(sdk, appUnique, { genpageCli, workspaceDir })` gains:

```javascript
    // Plan 5: the app's live page set = its sitemap GenPageIds (authoritative). Reuse the SHARED
    // fetchSitemapXml (moved into sitemap-pages.js in Task 1 — this file re-exports it as sitemapXmlFor for
    // back-compat). `manifest()` reads the durable <appUnique>_pagemanifest. `pageCode` downloads THAT page
    // by id (headless-free).
    sitemapPageIds: async () => { const { fetchSitemapXml, sitemapGenPageIds } = require('./lib/sitemap-pages.js'); return sitemapGenPageIds(await fetchSitemapXml(sdk, appUnique)); },
    manifest: async () => {
      const name = require('./lib/page-manifest.js').manifestResourceName(appUnique);
      const rows = await sdk.queryRecords('webresource', { select: ['content'], filter: `name eq '${odataLit(name)}'`, top: 1 });
      return rows && rows[0] && rows[0].content ? require('./lib/page-manifest.js').parseManifestBase64(rows[0].content) : { pages: [] };
    },
    pageCode: async (pageId) => { /* download by id into a cached temp dir; return page.tsx (read the existing pageCode impl and change it to pageIds:[pageId]) */ },
```

Remove the old `pages()` reader (or keep it only if a non-page consumer uses it — grep first).

- [ ] **Step 5: Run tests + full suite** → PASS. Update `build-model-app.js`'s live `deps.verify` wiring if it referenced `read.pages` (grep). 
- [ ] **Step 6: Commit** — `git add scripts/lib/verify-spec.js scripts/verify-model-app.js scripts/tests/verify-spec.test.js scripts/tests/verify-model-app.test.js` + trailers.

---

## Task 7: Download round-trip — enumerate the sitemap, download by id, re-key by id

`download-model-app.js` obtains the app's page-id set from the **sitemap** (not `pac genpage list`), downloads exactly those ids, re-keys via the manifest (mint for unknown), and reverse-resolves nav by id→key. The old `enumerate` + name-based exact-equality is replaced by sitemap-id ↔ downloaded-id exact-equality (still bidirectional, still fail-closed).

**Files:**
- Modify: `scripts/download-model-app.js` — the pages block (`:220-262`), `assignPageKeys`/`missingDownloads` reuse.
- Modify: `scripts/tests/download-model-app.test.js`.

**Interfaces:**
- Consumes: `sitemapGenPages` (Task 1); `reconcilePageIds(pages, manifest, liveIds)` (Task 3); `genpageCli.download({ appId, outputDir, pageIds })` (Task 4); `assignPageKeys`/`reverseResolveNavIds` (unchanged).
- Produces: a v2 spec whose `pages[]` == the sitemap's pages (no headless drop, no invalid dangling nav), keyed via the manifest, nav reverse-resolved to `PAGEREF_<key>`.

**Key changes:**
- The app's page set = `sitemapGenPages(sitemapXml)` (ids + titles). Download those ids: `genpageCli.download({ appId, outputDir: pagesRoot, pageIds: sitemapIds })`.
- `parseDownloadedPages(pagesRoot, outDir, nameById)` — build `nameById` from the **manifest** (id→name), falling back to the sitemap title, so recovered pages carry a real name (not the id). (The manifest is the real-name source; the sitemap gives titles.)
- Exact-equality: `missingDownloads(sitemapPages, downloaded)` and `missingDownloads(downloaded, sitemapPages)` both empty or abort (sitemap ids ↔ downloaded ids).
- `reconcilePageIds((manifest && manifest.pages) || [], manifest, sitemapIds)` (id-set signature) → `keyToId` for `assignPageKeys`.

- [ ] **Step 1: Rewrite the failing tests** — in `download-model-app.test.js`, replace the enumerate-based tests: mock the sitemap fetch to yield two GenPage subareas; mock `genpageCli.download` to write both pages' dirs; assert the recovered spec has BOTH pages (no drop), keyed via the manifest, and the nav `pageId` reverse-resolved to `"PAGEREF_order-detail"`; assert an id present in the sitemap but not downloaded → abort. Include a full round-trip: sitemap+manifest → download → hydrate → `validateAppSpec({profile:'plan'})` ok AND `resolvePageRefs` re-yields the deployed ids.

- [ ] **Step 2: Run to verify it fails** → FAIL.

- [ ] **Step 3: Implement** — replace the `main` pages block. Obtain the sitemap XML the download already collects (`collectSitemap`/`sitemapXmlFor`), then:

```javascript
  const { sitemapGenPages } = require('./lib/sitemap-pages.js');
  const sm = sitemapGenPages(sitemapXml);                 // [{ pageId, title }] — the app's pages, authoritative
  let pages = [];
  let manifest = null;
  if (sm.length) {
    const appUnique = /* resolve from appId as today */;
    manifest = /* read <appUnique>_pagemanifest via parseManifestBase64 as today */;
    const genpageCli = makeGenpageCli(env);
    const pagesRoot = path.join(outDir, 'pages');
    fs.rmSync(pagesRoot, { recursive: true, force: true });
    fs.mkdirSync(pagesRoot, { recursive: true });
    const sitemapIds = sm.map((p) => p.pageId);
    await genpageCli.download({ appId, outputDir: pagesRoot, pageIds: sitemapIds }); // download EXACTLY the sitemap's pages, by id
    // Real names from the manifest (id→name), else the sitemap title.
    const nameById = new Map();
    for (const p of sm) nameById.set(String(p.pageId).toLowerCase(), p.title);
    for (const mp of (manifest && manifest.pages) || []) if (mp.pageId && mp.name) nameById.set(String(mp.pageId).toLowerCase(), mp.name);
    pages = parseDownloadedPages(pagesRoot, outDir, nameById);
    // Bidirectional exact-equality: sitemap ids ↔ downloaded ids (I3).
    const missing = missingDownloads(sm, pages);
    if (missing.length) { emitResult(false, { ok: false, error: `sitemap page(s) not downloaded: ${missing.map((p) => p.title || p.pageId).join(', ')} — refusing to write a spec that would drop them` }); return; }
    const extra = missingDownloads(pages, sm);
    if (extra.length) { emitResult(false, { ok: false, error: `downloaded page(s) not in the sitemap: ${extra.map((p) => p.pageId).join(', ')} — inconsistent page set` }); return; }
    const { keyToId } = reconcilePageIds((manifest && manifest.pages) || [], manifest, sitemapIds);
    const idToKey = assignPageKeys(pages, manifest, keyToId);
    for (const p of pages) { /* reverseResolveNavIds(readFile(p.codeFile), idToKey) → write back — as today */ }
  }
```

> Preserve the existing `assignPageKeys`, `reverseResolveNavIds`, and `hydrateSpec(design)` wiring; only the ENUMERATION source (sitemap, not `genpageCli.enumerate`) and the DOWNLOAD (by id) change. `missingDownloads(a,b)` compares by `pageId` — `sm` entries have `pageId`, so it works unchanged.

- [ ] **Step 4: Run tests + full suite** → PASS.
- [ ] **Step 5: Commit** — `git add scripts/download-model-app.js scripts/tests/download-model-app.test.js` + trailers.

---

## Task 8: Docs — the every-page-in-sitemap rule + id-based identity

Doc-only. Record the invariant (every page is a sitemap subarea; the sitemap is the authoritative page set; identity is by id), the removal of headless nav targets, and the new validation error, across the contract docs.

**Files:** `references/app-spec-schema.md`, `references/rules.md`, `agents/genpage-page-builder.md`, `skills/app-builder/SKILL.md`, `docs/architecture.md`, `docs/app-builder-roadmap.md`, `CHANGELOG.md`, `AGENTS.md`.

- [ ] **Step 1: `references/app-spec-schema.md`** — under `## pages`: every page MUST be referenced by an `appShell` subarea (validation error otherwise); a `navigatesTo.targetKey` must be such a page (no navigation-only/headless pages); the app's sitemap `GenPageId` set is the authoritative page list; identity is the stable `key` mapped to the deployed `GenPageId` via the durable manifest.
- [ ] **Step 2: `references/rules.md` + `agents/genpage-page-builder.md`** — a `PAGEREF_<key>` target must be a page that is ALSO in the app sitemap (place every page in `appShell`); reachable-only-by-nav pages are not supported.
- [ ] **Step 3: `skills/app-builder/SKILL.md`** — the author/generate-pages flow must place every page in the sitemap; a detail page is a normal sitemap page that takes input via `pageInput`.
- [ ] **Step 4: `docs/architecture.md` + `AGENTS.md`** — enumeration reads the app sitemap (SDK `GenPageId`s); reconcile/verify/download match by id; drop the `pac genpage list --app-id` enumeration description.
- [ ] **Step 5: `docs/app-builder-roadmap.md` + `CHANGELOG.md`** — Changed: generative-page management is sitemap-authoritative + id-based; new validation requires every page to be sitemap-placed; download/verify pull by id.
- [ ] **Step 6: Full suite** (docs add no tests) → PASS (unchanged). Commit the 8 docs + trailers.

---

## Self-Review

**Spec coverage** (the live-testing findings → tasks):
- #2b headless pages invisible → **Task 2** forbids them at validation; **Tasks 5/6/7** enumerate from the sitemap so every owned page is seen. ✓
- #2c name = subarea title → **Task 3/5/6/7** match by id, never by name. ✓
- Download drops headless / dangling nav → **Task 7** downloads the sitemap's ids and re-keys by id (round-trip lossless). ✓
- "How do we know which pages belong to the app?" → the **sitemap** (Task 1 extractor), enforced complete by Task 2. ✓
- #1 (fresh-build op-diff 400) is **out of scope** for Plan 5 (separate op-diff-discovery robustness fix); tracked in the roadmap.

**Type consistency:** `reconcilePageIds(pages, manifest, liveIds) → { keyToId, absentKeys }` is used identically in Tasks 3 (def), 5 (build), 7 (download). `sitemapGenPageIds`/`sitemapGenPages`/`siteMapObjGenPageIds` from Task 1 are consumed by Tasks 5/6/7. `read.sitemapPageIds`/`read.manifest`/`read.pageCode(id)` (Task 6) are the reader contract. `genpageCli.download({ appId, outputDir, pageIds })` (Task 4) is used by Tasks 6/7.

**Placeholder scan:** Task 5's sitemap representation (`appArt.siteMap` object vs. `sitemapXml`) and Task 6/7's "as today" wiring are flagged as **read-the-real-code** points, not omissions — each names the exact function to preserve and provides the new code; the implementer must confirm the fetched-artifact shape (object vs XML) and pick the matching extractor (`siteMapObjGenPageIds` vs `sitemapGenPageIds`), both provided in Task 1/5.

**Open risk for Sol review:** (a) **RESOLVED in-plan** — the live page-id set comes from a direct `sitemapxml` Dataverse query (`fetchSitemapXml`, Task 1), not the created-this-run in-memory app artifact; on a fresh build the deployed sitemap has no genpages (→ create all), on a rebuild it holds the prior run's genpages (the app-shell existing-app branch defers the sitemap write to the finalizer, C2), so reconcile is correct both ways. Sol should still sanity-check that the app-shell/pages phase ordering guarantees the app + sitemap exist before `fetchSitemapXml` runs (app-shell precedes pages; `pages-requires-app` HALT covers the `--from pages` case). (b) `pac genpage upload` without `--add-to-sitemap` creates the page; the SDK adds the `GenPage` subarea in finalize — so within one run the create-absent-first ids come from the `upload` return (seeded into `keyToId`), not the mid-run sitemap; the sitemap read only seeds the PRE-EXISTING set at phase start. Confirm this ordering holds. (c) Cross-app shared pages (`pac genpage add`) — a page can be in two apps' sitemaps; the manifest is per-app so identity stays per-app-correct. (d) The `structural` eval profile must remain green (Task 2 excludes it). (e) **Does removing `pages-enumeration-failed`/`pages-ambiguous-name` lose any safety?** — enumeration can no longer "fail" (a sitemap query returning `''` just means "no live pages" = fresh, which is safe: create all); ambiguity is impossible under id-matching. Sol should confirm no consumer still depends on those two HALT codes.
