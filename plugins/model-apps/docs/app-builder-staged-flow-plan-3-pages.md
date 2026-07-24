# App-Builder Staged Flow — Plan 3: Pages Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This is the highest-risk plan in the series (it gets a separate architectural review) — do not skip a step's RED run, and keep the full suite green after every task.

**Goal:** Land the **pages pipeline** for the staged flow — the fail-closed generative-page deployment protocol (`PAGEREF_` cross-page navigation resolved into staging copies, never mutating canonical source), a durable versioned `<app>_pagemanifest` web resource that carries page semantics across download/rebuild, the latent key/name binding fix in the pages phase, and page-aware verification (every navigation edge must resolve to the *actual* target's `GenPageId`). All new logic is either a pure offline-testable module or a discover-reconcile addition to the existing engine — no engine phase is renamed and no non-page build behavior changes.

**Architecture:** Two new **pure leaf modules** — `pageref-resolver.js` (symbolic `PAGEREF_<key>` ⇄ GUID substitution) and `page-manifest.js` (build/parse/reconcile the durable manifest) — are consumed by the engine's existing `pages` phase (`sdk-build.js:1061-1097`). The pages phase gains: (1) **fail-closed enumeration** via a new `genpageCli.enumerate` that distinguishes a pac failure from an empty app (today `listPages` collapses both to `[]`, `genpage-cli.js:68-70`); (2) the **manifest lifecycle** (create → `updateWebResource` on rebuild → re-assert solution membership every run → teardown), modeled on the existing `ensureAppIcon` web-resource helper (`sdk-build.js:436-461`); (3) the **create-absent-first / resolve-to-staging / upload-once / sitemap-finalize** protocol (design §9); and (4) the **key-by-KEY** fix so `result.created.pages` is keyed by the stable page key (matching `appDef`'s `result.pages[s.page]` lookup, `sdk-build.js:506`). Verification is extended in the pure `verifySpec` (`verify-spec.js`) plus a reader addition (`verify-model-app.js`). The download round-trip (`download-model-app.js` / `hydrate-spec.js`) reconstructs keys from the manifest and reverse-normalizes GUID literals back to `PAGEREF_<key>`. Destructive page operations (future removals) are out of scope here — they route through Plan 2's `op-diff.js` classifier when added.

**Tech Stack:** Node.js (CommonJS), `node:test` + `node:assert`, run via `node scripts/run-tests.js`. Design source of truth: `plugins/model-apps/docs/app-builder-staged-flow-design.md` — **§5** (execution model: data pre-build → main-loop code-gen → one full idempotent build; no cross-run DAG), **§8** (generate-pages stage), **§9** (cross-page navigation + fail-closed `PAGEREF_` protocol), **§7.3** (durable `<app>_pagemanifest`), **§13.1** (verify extended to pages). Navigation contract: `references/rules.md:299-356`.

## Global Constraints

- All commands run from the plugin root: `D:\Projects\power-platform-skills-sdk\plugins\model-apps`.
- Tests use `node:test`: `const { test } = require('node:test'); const assert = require('node:assert');`. Full suite: `node scripts/run-tests.js` (currently **558** passing — keep it green; each task below adds tests). Single file: `node --test scripts/tests/<file>.test.js`.
- The **13 engine phase names and order are unchanged**: `solution, data-model, sample-data, web-resources, views, charts, forms, commands, dashboards, app-shell, pages, ai-features, publish`. This plan only touches the `pages` phase (and its teardown/verify counterparts).
- **Pure modules are offline-only:** `pageref-resolver.js` and `page-manifest.js` have **no I/O and no SDK handle**. The engine reads/writes the web-resource bytes and the staging `.tsx` files; the pure modules only shape/parse strings. They are unit-tested with in-memory inputs.
- **The canonical `.tsx` is NEVER mutated with a GUID.** `PAGEREF_<key>` resolution writes a **staging copy** under `<appDir>/.pageref-deploy/`; `genpageCli.upload` reads that path. Baking an environment-specific id into source would break cross-env recreate (design §9, SDK opaque-identity **T5**).
- **Enumeration is fail-closed.** `genpageCli.enumerate` distinguishes a pac failure (`{ ok: false }`) from an empty app (`{ ok: true, pages: [] }`). The pages phase and the verify reader **HALT** on `ok: false` — they never treat a failed listing as "no pages" (which would duplicate-create and orphan). `listPages`/`list` are retained for backward compatibility.
- **`result.created.pages` is keyed by the stable page key** (`p.key || p.name` — legacy specs with no key fall back to name, so name-referenced specs keep working). This matches `appDef`'s `result.pages[s.page]` lookup where `s.page` is the migrated **key** (`sdk-build.js:506`). This fixes a latent bug hidden by legacy (name==ref) test specs.
- **Manifest lifecycle:** first build creates the `<appUnique>_pagemanifest` web resource; a rebuild **updates its content in place via `updateWebResource`** (plain reuse would leave stale content, `sdk-build.js:576-589`); solution membership is **re-asserted every run** (idempotent `addSolutionComponent`); `planTeardown` removes it. New page ids are persisted to the manifest **immediately** after each mint (crash-safety, design §9).
- **`updateWebResource` must be added to `SKILL_SDK_SURFACE`** (`sdk-surface-contract.test.js`) — it is exposed by the vendored bundle but not yet listed; the source-scan half of the contract test fails the moment the pages phase calls `provision.updateWebResource(` unless it is listed.
- Commit trailers on every commit:
  ```
  Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
  Copilot-Session: 42626da2-b66f-4162-acaa-b1127ef23d89
  ```

---

## File Structure

- `scripts/lib/pageref-resolver.js` **(new)** — pure `PAGEREF_<key>` resolver: `resolvePageRefs`, `reverseResolvePageRefs`, `referencedKeys`. No dependencies (leaf module).
- `scripts/lib/page-manifest.js` **(new)** — pure manifest builder/parser/reconciler: `MANIFEST_SCHEMA_VERSION`, `manifestResourceName`, `buildManifest`, `serializeManifest`, `parseManifest`, `parseManifestBase64`, `reconcilePageIds`. No dependencies (leaf module).
- `scripts/lib/genpage-cli.js` **(modify)** — add `enumerate({ appId }) → { ok, pages, error }` (fail-closed; retries; distinguishes failure from empty). Keep `list`/`listPages`.
- `scripts/lib/sdk-build.js` **(modify)** — pages phase (`:1061-1097`): fail-closed `enumerate` + manifest seed/reconcile + key-by-KEY fix + create-absent-first + `resolvePageRefs`-to-staging + upload-once + sitemap-finalize. New internal helpers `readPageManifest` / `persistPageManifest` / `writeStagingFile` (modeled on `ensureAppIcon:436-461`). `planFor` gains a `page manifest` item (`:279-280`).
- `scripts/lib/sdk-teardown.js` **(modify)** — `planTeardown` adds a `webResource` teardown step for `<appUnique>_pagemanifest` (after the icon step, `:346-349`); import `manifestResourceName`.
- `scripts/lib/verify-spec.js` **(modify)** — `verifySpec` gains a page branch (exists / `GenPageId`-bound / every-nav-edge-resolves-to-actual-target / no unresolved `PAGEREF_`); new `subareaHasGenPage` helper; import `referencedKeys` + `normalizePageSource`.
- `scripts/verify-model-app.js` **(modify)** — `readerFor` gains `pages()` + `pageCode()` (via `genpageCli.enumerate` + `download`); new `appIdFor`; `main` builds a `genpageCli` and passes it + a workspace dir.
- `scripts/build-model-app.js` **(modify)** — auto-verify becomes **mandatory + fail-closed** when the spec has implemented pages (`:157-176`); the default `verify` dep passes a `genpageCli` + workspace to `readerFor` (`:247`).
- `scripts/download-model-app.js` **(modify)** — fetch the `<uniquename>_pagemanifest` web resource, build `idToKey`, reverse-normalize each downloaded `page.tsx`, reconstruct keys; export `parseDownloadedPages`; thread the manifest to `hydrateSpec`.
- `scripts/lib/hydrate-spec.js` **(modify)** — when a manifest is present, reconstruct the v2 page shape (key/purpose/navigatesTo/pageInput/source) + `schemaVersion: 2` + `design`, and resolve GenPage subareas to `{ page: <key> }` by id; legacy fallback (no manifest) keeps today's name-based shape.
- `scripts/tests/pageref-resolver.test.js`, `scripts/tests/page-manifest.test.js`, `scripts/tests/sdk-build-pages-deploy.test.js` **(new)** — offline unit + integration tests.
- `scripts/tests/genpage-cli.test.js`, `scripts/tests/sdk-build.test.js`, `scripts/tests/sdk-build-pages-migrate.test.js`, `scripts/tests/sdk-surface-contract.test.js`, `scripts/tests/sdk-teardown.test.js`, `scripts/tests/verify-spec.test.js`, `scripts/tests/build-model-app.test.js`, `scripts/tests/download-model-app.test.js`, `scripts/tests/hydrate-spec.test.js` **(modify)** — add `enumerate` to genpageCli mocks; add `updateWebResource` + manifest query branch to `mockSdk`; new assertions.
- `references/app-spec-schema.md`, `skills/app-builder/SKILL.md`, `CHANGELOG.md` **(modify)** — document the manifest + `PAGEREF_` pipeline (docs — not tested).

---

## Task 1: `pageref-resolver.js` — pure `PAGEREF_<key>` ⇄ GenPageId substitution

**Files:**
- Create: `scripts/lib/pageref-resolver.js`
- Create: `scripts/tests/pageref-resolver.test.js`

**Interfaces:**
- Consumes: nothing (leaf module — no I/O, no SDK handle).
- Produces:
  - `resolvePageRefs(sources: Map<string, { code: string }>, keyToId: Map<string, string>) → { deployment: Map<string, string>, unresolved: string[] }` — for each source, replaces every `"PAGEREF_<refKey>"` token with the quoted GenPageId; `unresolved` is the sorted-unique set of referenced keys with no id (dangling targets). Unresolved refs are left **verbatim** so a fail-closed caller can halt before shipping a broken id.
  - `reverseResolvePageRefs(code: string, idToKey: Map<string, string>) → string` — the download inverse: rewrites each quoted GenPageId literal back to `"PAGEREF_<key>"`.
  - `referencedKeys(code: string) → string[]` — sorted-unique keys referenced via `"PAGEREF_<key>"` (verify uses this to assert no unresolved ref remains in deployed code).

- [ ] **Step 1: Write the failing test** — `scripts/tests/pageref-resolver.test.js`

```javascript
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { resolvePageRefs, reverseResolvePageRefs, referencedKeys } = require(path.join(__dirname, '..', 'lib', 'pageref-resolver.js'));

test('resolvePageRefs replaces every "PAGEREF_<key>" with the quoted genPageId', () => {
  const sources = new Map([
    ['overview', { code: 'Xrm.Navigation.navigateTo({ pageType: "generative", pageId: "PAGEREF_detail", data })' }],
  ]);
  const keyToId = new Map([['detail', '5d29d8ce-1111-2222-3333-444455556666']]);
  const { deployment, unresolved } = resolvePageRefs(sources, keyToId);
  assert.strictEqual(deployment.get('overview'), 'Xrm.Navigation.navigateTo({ pageType: "generative", pageId: "5d29d8ce-1111-2222-3333-444455556666", data })');
  assert.deepStrictEqual(unresolved, []);
});

test('resolvePageRefs collects dangling targets (sorted, unique) and leaves them verbatim', () => {
  const sources = new Map([
    ['a', { code: '"PAGEREF_missing" then "PAGEREF_gone" then "PAGEREF_missing"' }],
    ['b', { code: '"PAGEREF_gone"' }],
  ]);
  const { deployment, unresolved } = resolvePageRefs(sources, new Map());
  assert.deepStrictEqual(unresolved, ['gone', 'missing']);
  // A dangling ref must NOT be silently dropped or mangled — the caller halts on it.
  assert.ok(deployment.get('a').includes('"PAGEREF_missing"'));
});

test('resolvePageRefs does not partial-collide "PAGEREF_pet" with "PAGEREF_pet-gallery"', () => {
  const sources = new Map([['x', { code: '["PAGEREF_pet","PAGEREF_pet-gallery"]' }]]);
  const keyToId = new Map([['pet', 'id-pet'], ['pet-gallery', 'id-gallery']]);
  const { deployment, unresolved } = resolvePageRefs(sources, keyToId);
  assert.strictEqual(deployment.get('x'), '["id-pet","id-gallery"]');
  assert.deepStrictEqual(unresolved, []);
});

test('resolvePageRefs is idempotent — resolved code has no PAGEREF_ left; second pass is a no-op', () => {
  const sources = new Map([['x', { code: 'pageId: "PAGEREF_detail"' }]]);
  const keyToId = new Map([['detail', 'gp-1']]);
  const once = resolvePageRefs(sources, keyToId).deployment.get('x');
  const twice = resolvePageRefs(new Map([['x', { code: once }]]), keyToId).deployment.get('x');
  assert.strictEqual(once, twice);
  assert.strictEqual(referencedKeys(once).length, 0);
});

test('referencedKeys returns the sorted unique set of referenced keys', () => {
  assert.deepStrictEqual(referencedKeys('"PAGEREF_b" x "PAGEREF_a" y "PAGEREF_b"'), ['a', 'b']);
  assert.deepStrictEqual(referencedKeys('no refs here'), []);
});

test('reverseResolvePageRefs rewrites a deployed genPageId literal back to "PAGEREF_<key>" (case-insensitive)', () => {
  const idToKey = new Map([['5d29d8ce-1111-2222-3333-444455556666', 'detail']]);
  const code = 'pageId: "5D29D8CE-1111-2222-3333-444455556666"';
  assert.strictEqual(reverseResolvePageRefs(code, idToKey), 'pageId: "PAGEREF_detail"');
});

test('resolve ∘ reverse round-trips the navigation literal', () => {
  const keyToId = new Map([['detail', 'gp-42']]);
  const idToKey = new Map([['gp-42', 'detail']]);
  const original = 'pageId: "PAGEREF_detail"';
  const resolved = resolvePageRefs(new Map([['x', { code: original }]]), keyToId).deployment.get('x');
  assert.strictEqual(resolved, 'pageId: "gp-42"');
  assert.strictEqual(reverseResolvePageRefs(resolved, idToKey), original);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test scripts/tests/pageref-resolver.test.js`
Expected: FAIL — `Cannot find module '.../lib/pageref-resolver.js'`.

- [ ] **Step 3: Create `scripts/lib/pageref-resolver.js`**

```javascript
'use strict';
// Pure symbolic-navigation resolver for generative pages. Page authors emit a cross-page link as a
// STABLE symbolic token — `pageId: "PAGEREF_<key>"` — because the real GenPageId is minted by the
// server at deploy time and differs per environment (SDK opaque-identity rule: never bake a resolved
// GUID into canonical source, or a cross-env recreate ships a dead link). See references/rules.md
// "Generative Page Navigation" and docs/app-builder-staged-flow-design.md §9. This module maps those
// tokens to/from real ids; the ENGINE (not this module) reads/writes files — this stays pure/offline.

// Match ONLY the quoted token `"PAGEREF_<key>"`. The surrounding quotes are part of the match, so the
// replacement swaps the whole string literal (quotes included). Quoting the token also bounds the key
// so "PAGEREF_pet" cannot partial-match inside "PAGEREF_pet-gallery" (rules.md keys are slugs:
// [a-z0-9-]; `_` is allowed here defensively). A fresh regex is built per call because a /g RegExp is
// stateful (lastIndex) and reusing one across .exec loops would skip matches.
const REF = () => /"PAGEREF_([A-Za-z0-9_-]+)"/g;

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Resolve every source's PAGEREF_ tokens to quoted GenPageIds. Returns the resolved copies plus the
// sorted-unique set of referenced keys that had NO id (dangling nav targets). Dangling refs are left
// verbatim in `deployment` so the caller can HALT (fail-closed) rather than upload a broken link.
function resolvePageRefs(sources, keyToId) {
  const deployment = new Map();
  const unresolved = new Set();
  for (const [key, entry] of sources) {
    const code = entry && typeof entry.code === 'string' ? entry.code : '';
    const resolved = code.replace(REF(), (m, refKey) => {
      if (keyToId.has(refKey)) return JSON.stringify(String(keyToId.get(refKey)));
      unresolved.add(refKey);
      return m; // leave the dangling token untouched — do not ship a half-resolved id
    });
    deployment.set(key, resolved);
  }
  return { deployment, unresolved: [...unresolved].sort() };
}

// Download inverse: rewrite a deployed page's concrete GenPageId literal back to its symbolic
// "PAGEREF_<key>" so the canonical .tsx pulled from Dataverse is environment-independent again.
// Dataverse may echo the GUID upper- or lower-cased, so match case-insensitively — but only as a
// full quoted literal so a substring can't be corrupted.
function reverseResolvePageRefs(code, idToKey) {
  let out = String(code || '');
  for (const [id, key] of idToKey) {
    out = out.replace(new RegExp('"' + escapeRe(id) + '"', 'gi'), JSON.stringify('PAGEREF_' + key));
  }
  return out;
}

// The sorted-unique keys a page references via "PAGEREF_<key>". Verify uses this to prove a deployed
// page carries NO unresolved token (a leftover PAGEREF_ means the resolve/upload step was skipped).
function referencedKeys(code) {
  const re = REF();
  const keys = new Set();
  let m;
  while ((m = re.exec(String(code || ''))) !== null) keys.add(m[1]);
  return [...keys].sort();
}

module.exports = { resolvePageRefs, reverseResolvePageRefs, referencedKeys };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test scripts/tests/pageref-resolver.test.js`
Expected: PASS (all 7 tests).

Then the full gate: `node scripts/run-tests.js`
Expected: PASS — suite green (baseline **558** + 7 = **565**).

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/pageref-resolver.js scripts/tests/pageref-resolver.test.js
git commit -m "feat(model-apps): pure PAGEREF_ resolver for cross-page navigation" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>" \
  -m "Copilot-Session: 42626da2-b66f-4162-acaa-b1127ef23d89"
```

---

## Task 2: `page-manifest.js` — pure build/parse/reconcile of the durable page manifest

**Files:**
- Create: `scripts/lib/page-manifest.js`
- Create: `scripts/tests/page-manifest.test.js`

**Interfaces:**
- Consumes: nothing (leaf module — no I/O, no SDK handle).
- Produces:
  - `MANIFEST_SCHEMA_VERSION: number` (= `1`).
  - `manifestResourceName(appUnique: string) → string` — `` `${appUnique}_pagemanifest` `` (the web-resource schema name; `appUnique` is `appUniqueName(spec)`).
  - `buildManifest(spec, keyToId: Map<string,string>) → { schemaVersion, pages: [{ key, name, pageId?, purpose?, dataSources?, navigatesTo?, pageInput? }], design? }` — full page semantics keyed by `p.key || p.name`; omits undefined/empty optional fields; sets `pageId` from `keyToId` when known. Matches the design §7.3 payload exactly.
  - `serializeManifest(manifest) → string` (pretty JSON).
  - `parseManifest(text: string) → manifest | null` — **fail-closed**: bad JSON / wrong `schemaVersion` / non-array `pages` → `null`.
  - `parseManifestBase64(b64: string) → manifest | null` — decode the Dataverse `content` (base64) then `parseManifest`.
  - `reconcilePageIds(pages, manifest, livePages) → { keyToId: Map<string,string>, absentKeys: string[] }` — authority order **live-name-match > manifest-id-confirmed-live > absent** (§7.3, §9).

- [ ] **Step 1: Write the failing test** — `scripts/tests/page-manifest.test.js`

```javascript
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { MANIFEST_SCHEMA_VERSION, manifestResourceName, buildManifest, serializeManifest, parseManifest, parseManifestBase64, reconcilePageIds } = require(path.join(__dirname, '..', 'lib', 'page-manifest.js'));

test('manifestResourceName appends _pagemanifest to the app unique name', () => {
  assert.strictEqual(manifestResourceName('contoso_workorders'), 'contoso_workorders_pagemanifest');
});

test('buildManifest carries full page semantics keyed by key||name, omitting undefined fields', () => {
  const spec = {
    design: { theme: 'ocean' },
    pages: [
      { key: 'overview', name: 'Overview', purpose: 'At-a-glance', dataSources: ['contoso_wo'], navigatesTo: [{ targetKey: 'wo-detail', data: { id: 'string' } }], pageInput: { data: { id: 'string' } } },
      { name: 'Legacy' }, // no key → falls back to name; no optional fields → omitted
    ],
  };
  const m = buildManifest(spec, new Map([['overview', 'gp-1']]));
  assert.strictEqual(m.schemaVersion, MANIFEST_SCHEMA_VERSION);
  assert.deepStrictEqual(m.design, { theme: 'ocean' });
  assert.deepStrictEqual(m.pages[0], { key: 'overview', name: 'Overview', pageId: 'gp-1', purpose: 'At-a-glance', dataSources: ['contoso_wo'], navigatesTo: [{ targetKey: 'wo-detail', data: { id: 'string' } }], pageInput: { data: { id: 'string' } } });
  assert.deepStrictEqual(m.pages[1], { key: 'Legacy', name: 'Legacy' });
});

test('serializeManifest ∘ parseManifest round-trips', () => {
  const m = buildManifest({ pages: [{ key: 'a', name: 'A' }] }, new Map());
  assert.deepStrictEqual(parseManifest(serializeManifest(m)), m);
});

test('parseManifest is fail-closed: bad JSON / wrong schemaVersion / non-array pages / missing version → null', () => {
  assert.strictEqual(parseManifest('not json{'), null);
  assert.strictEqual(parseManifest(JSON.stringify({ schemaVersion: 999, pages: [] })), null);
  assert.strictEqual(parseManifest(JSON.stringify({ schemaVersion: 1, pages: 'x' })), null);
  assert.strictEqual(parseManifest(JSON.stringify({ pages: [] })), null);
});

test('parseManifestBase64 decodes then parses (fail-closed on garbage)', () => {
  const m = buildManifest({ pages: [{ key: 'a', name: 'A' }] }, new Map());
  const b64 = Buffer.from(serializeManifest(m), 'utf8').toString('base64');
  assert.deepStrictEqual(parseManifestBase64(b64), m);
  assert.strictEqual(parseManifestBase64('@@ not base64 json @@'), null);
});

test('reconcilePageIds: LIVE name-match wins over a stale manifest id', () => {
  const pages = [{ key: 'overview', name: 'Overview' }];
  const manifest = { schemaVersion: 1, pages: [{ key: 'overview', name: 'Overview', pageId: 'stale-id' }] };
  const live = [{ pageId: 'live-id', name: 'Overview' }];
  const { keyToId, absentKeys } = reconcilePageIds(pages, manifest, live);
  assert.strictEqual(keyToId.get('overview'), 'live-id');
  assert.deepStrictEqual(absentKeys, []);
});

test('reconcilePageIds: manifest id used only when confirmed live by id (display name drifted)', () => {
  const pages = [{ key: 'overview', name: 'Overview (renamed)' }];
  const manifest = { schemaVersion: 1, pages: [{ key: 'overview', name: 'Overview', pageId: 'gp-1' }] };
  const live = [{ pageId: 'gp-1', name: 'Overview' }];
  const { keyToId, absentKeys } = reconcilePageIds(pages, manifest, live);
  assert.strictEqual(keyToId.get('overview'), 'gp-1');
  assert.deepStrictEqual(absentKeys, []);
});

test('reconcilePageIds: a manifest id NOT present in the live enumeration is treated as absent', () => {
  const pages = [{ key: 'gone', name: 'Gone' }];
  const manifest = { schemaVersion: 1, pages: [{ key: 'gone', name: 'Gone', pageId: 'deleted-id' }] };
  const { keyToId, absentKeys } = reconcilePageIds(pages, manifest, []);
  assert.strictEqual(keyToId.has('gone'), false);
  assert.deepStrictEqual(absentKeys, ['gone']);
});

test('reconcilePageIds: no manifest, no live match → absent', () => {
  const { keyToId, absentKeys } = reconcilePageIds([{ key: 'new', name: 'New' }], null, []);
  assert.strictEqual(keyToId.size, 0);
  assert.deepStrictEqual(absentKeys, ['new']);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test scripts/tests/page-manifest.test.js`
Expected: FAIL — `Cannot find module '.../lib/page-manifest.js'`.

- [ ] **Step 3: Create `scripts/lib/page-manifest.js`**

```javascript
'use strict';
// Pure builder/parser/reconciler for the durable `<appUnique>_pagemanifest` web resource. The manifest
// carries the FULL design-time page semantics — { schemaVersion, pages:[{ key, name, pageId, purpose,
// dataSources, navigatesTo, pageInput }], design } — so a download→edit→rebuild round-trip restores
// intent + navigation that pac's page download (name + resolved-GUID source only) drops. It travels
// inside the solution and survives export/import. See docs/app-builder-staged-flow-design.md §7.3.
// PURE: the engine reads/writes the web-resource bytes; this module only shapes/parses strings.

// Manifest payload schema version. Parse rejects any other version fail-closed: an unknown version
// means an incompatible producer, so reconstruct from live state rather than mis-read the payload.
const MANIFEST_SCHEMA_VERSION = 1;

// Web-resource (schema) name of the manifest, derived from appUniqueName(spec), e.g.
// 'contoso_workorders' → 'contoso_workorders_pagemanifest'.
function manifestResourceName(appUnique) {
  return `${appUnique}_pagemanifest`;
}

// Build the manifest payload from the spec + reconciled key→pageId map. Keyed by the stable page key
// (falling back to name for a legacy page with no key). Empty/undefined optional fields are omitted so
// the serialized manifest stays minimal and diff-friendly.
function buildManifest(spec, keyToId) {
  const km = keyToId || new Map();
  const pages = ((spec && spec.pages) || []).map((p) => {
    const key = p.key || p.name;
    const entry = { key, name: p.name };
    const id = km.get(key);
    if (id) entry.pageId = id;
    if (p.purpose !== undefined) entry.purpose = p.purpose;
    if (p.dataSources && p.dataSources.length) entry.dataSources = p.dataSources;
    if (p.navigatesTo && p.navigatesTo.length) entry.navigatesTo = p.navigatesTo;
    if (p.pageInput !== undefined) entry.pageInput = p.pageInput;
    return entry;
  });
  const m = { schemaVersion: MANIFEST_SCHEMA_VERSION, pages };
  if (spec && spec.design !== undefined) m.design = spec.design;
  return m;
}

function serializeManifest(manifest) {
  return JSON.stringify(manifest, null, 2);
}

// Parse a manifest string, FAIL-CLOSED: malformed JSON, an unknown schemaVersion, or a non-array
// `pages` all yield null so the caller reconstructs from live enumeration instead of trusting a
// corrupt/incompatible payload.
function parseManifest(text) {
  let m;
  try { m = JSON.parse(String(text)); } catch { return null; }
  if (!m || typeof m !== 'object') return null;
  if (m.schemaVersion !== MANIFEST_SCHEMA_VERSION) return null;
  if (!Array.isArray(m.pages)) return null;
  return m;
}

// Dataverse stores webresource.content as base64. Decode to utf8, then parse (same fail-closed
// contract — bad base64 yields utf8 garbage that JSON.parse rejects → null).
function parseManifestBase64(b64) {
  if (typeof b64 !== 'string' || !b64) return null;
  let text;
  try { text = Buffer.from(b64, 'base64').toString('utf8'); } catch { return null; }
  return parseManifest(text);
}

// Reconcile the spec's declared pages against the durable manifest AND the fail-closed live page
// enumeration (§9). Authority order (highest first):
//   1. LIVE name-match      — the server is truth; a page listed live by this name binds now.
//   2. manifest key→pageId  — but ONLY if that id is still present in the live enumeration (a manifest
//                             id absent from live is stale: deleted, or imported from another env).
//   3. absent               — needs a create (mint a fresh id).
// Returns { keyToId: Map<key,id> (server-cased ids), absentKeys: [key…] }.
function reconcilePageIds(pages, manifest, livePages) {
  const live = livePages || [];
  const liveById = new Map(live.filter((p) => p.pageId).map((p) => [String(p.pageId).toLowerCase(), p.pageId]));
  const liveByName = new Map(live.filter((p) => p.name && p.pageId).map((p) => [p.name, p.pageId]));
  const manifestByKey = new Map(((manifest && manifest.pages) || []).filter((p) => p && p.key).map((p) => [p.key, p]));
  const keyToId = new Map();
  const absentKeys = [];
  for (const p of pages || []) {
    const key = p.key || p.name;
    let id = liveByName.get(p.name);
    if (!id) {
      const mp = manifestByKey.get(key);
      if (mp && mp.pageId && liveById.has(String(mp.pageId).toLowerCase())) id = liveById.get(String(mp.pageId).toLowerCase());
    }
    if (id) keyToId.set(key, id);
    else absentKeys.push(key);
  }
  return { keyToId, absentKeys };
}

module.exports = { MANIFEST_SCHEMA_VERSION, manifestResourceName, buildManifest, serializeManifest, parseManifest, parseManifestBase64, reconcilePageIds };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test scripts/tests/page-manifest.test.js`
Expected: PASS (all 9 tests).

Then the full gate: `node scripts/run-tests.js`
Expected: PASS — suite green (≈ **574**).

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/page-manifest.js scripts/tests/page-manifest.test.js
git commit -m "feat(model-apps): pure durable page-manifest build/parse/reconcile" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>" \
  -m "Copilot-Session: 42626da2-b66f-4162-acaa-b1127ef23d89"
```

---

## Task 3: Fail-closed enumeration + manifest lifecycle + key-by-KEY fix (+ surface + teardown)

This task makes the pages phase discover-reconcile-safe: it enumerates pages **fail-closed**, seeds `key→pageId` from the durable manifest, writes/updates the manifest, and fixes the latent **key vs name** binding bug — without yet doing PAGEREF_ staging (Task 4).

**Files:**
- Modify: `scripts/lib/genpage-cli.js:106-109` (add `enumerate` to the returned object; keep `list`/`listPages`).
- Modify: `scripts/lib/sdk-build.js` — add requires from `page-manifest.js` (`:20-30` requires region); add `readPageManifest` + `persistPageManifest` helpers (near `ensureAppIcon`, `:436-461`); rewrite the pages phase (`:1064-1097`); add the manifest `planFor` item (`:279-280`).
- Modify: `scripts/lib/sdk-teardown.js:36-39` (import `manifestResourceName`), after `:346-349` (manifest teardown step).
- Modify: `scripts/tests/sdk-surface-contract.test.js:75` (add `'updateWebResource'`).
- Modify: `scripts/tests/genpage-cli.test.js` (add `enumerate` unit tests).
- Modify: `scripts/tests/sdk-build.test.js:4` (import `appUniqueName`), `:59` (manifest query branch), `:106` (add `updateWebResource` to `mockSdk`), `:980,:996,:1009` (add `enumerate` to genpageCli mocks), new integration tests.
- Modify: `scripts/tests/sdk-build-pages-migrate.test.js:90,:120,:148` (add `enumerate` to genpageCli mocks).
- Modify: `scripts/tests/sdk-teardown.test.js` (manifest teardown-step test).

**Interfaces:**
- Consumes: `enumerate` (new below); `manifestResourceName` / `buildManifest` / `serializeManifest` / `parseManifestBase64` / `reconcilePageIds` (Task 2); `normalizePageSource` (`app-spec.js`); `appUniqueName` / `COMPONENT_TYPE` / `appDef` / `appHasPageSubareas` / `BuildHalt` / `odataLit` (in-module, `sdk-build.js`).
- Produces:
  - `genpageCli.enumerate({ appId }) → { ok: boolean, pages: [{ pageId, name }], error?: string }` — retries; `{ ok: false }` on a persistent non-zero exit (distinct from `{ ok: true, pages: [] }`).
  - `result.created.pages` keyed by `p.key || p.name` (was `p.name`) — matches `appDef`'s `result.pages[s.page]` (`:506`).
  - Durable `<appUnique>_pagemanifest` web resource: created on first build, `updateWebResource` on rebuild, solution membership re-asserted every run, torn down by `planTeardown`.
  - `SKILL_SDK_SURFACE` includes `updateWebResource`.

- [ ] **Step 1: Write the failing `enumerate` unit tests** — append to `scripts/tests/genpage-cli.test.js`

```javascript
test('enumerate returns { ok:true, pages } on a zero-exit list (no retry on success)', async () => {
  let n = 0;
  const cli = makeGenpageCli('env', { run: async () => { n += 1; return { status: 0, stdout: `Overview\n  Page ID: ${GUID}\n`, stderr: '' }; }, sleep: async () => {}, attempts: 3 });
  const r = await cli.enumerate({ appId: 'app-1' });
  assert.deepStrictEqual(r, { ok: true, pages: [{ pageId: GUID, name: 'Overview' }] });
  assert.strictEqual(n, 1);
});

test('enumerate returns { ok:true, pages:[] } for an app that genuinely has no pages', async () => {
  const cli = makeGenpageCli('env', { run: async () => ({ status: 0, stdout: 'No pages found\n', stderr: '' }), sleep: async () => {}, attempts: 3 });
  const r = await cli.enumerate({ appId: 'app-1' });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.pages, []);
});

test('enumerate is fail-closed: a persistent non-zero exit yields { ok:false } (NOT empty), after retrying', async () => {
  let n = 0;
  const cli = makeGenpageCli('env', { run: async () => { n += 1; return { status: 1, stdout: '', stderr: 'auth expired' }; }, sleep: async () => {}, attempts: 3 });
  const r = await cli.enumerate({ appId: 'app-1' });
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(r.pages, []);
  assert.match(r.error, /pac genpage list failed after 3 attempt\(s\): auth expired/);
  assert.strictEqual(n, 3);
});

test('enumerate recovers on a later attempt (transient flake)', async () => {
  let n = 0;
  const cli = makeGenpageCli('env', { run: async () => { n += 1; return n < 2 ? { status: 1, stdout: '', stderr: 'flake' } : { status: 0, stdout: `A\n  Page ID: ${GUID}\n`, stderr: '' }; }, sleep: async () => {}, attempts: 3 });
  const r = await cli.enumerate({ appId: 'app-1' });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.pages, [{ pageId: GUID, name: 'A' }]);
  assert.strictEqual(n, 2);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test scripts/tests/genpage-cli.test.js`
Expected: FAIL — `cli.enumerate is not a function`.

- [ ] **Step 3: Implement `enumerate` in `scripts/lib/genpage-cli.js`**

Insert into the object returned by `makeGenpageCli` (after `list({ appId })`, `:107-109`):

```javascript
    // Fail-closed page enumeration (design §9). listPages()/list() collapse ANY pac failure to []
    // (:68-70) — indistinguishable from a genuinely empty app — which would make the pages phase
    // re-create every page and orphan the originals. enumerate() RETRIES (pac genpage list flakes with
    // transient help-dumps) and returns { ok:false } on a persistent non-zero exit, DISTINCT from
    // { ok:true, pages:[] } for an app that truly has no pages. list()/listPages() are retained for the
    // by-name reconcile inside upload().
    async enumerate({ appId }) {
      let lastErr = '';
      for (let i = 0; i < attempts; i += 1) {
        const r = await run(['model', 'genpage', 'list', '--environment', env, '--app-id', appId]);
        if (r.status === 0) return { ok: true, pages: parseList(r.stdout) };
        lastErr = lastLine(r);
        if (i < attempts - 1) await sleep(500 * (i + 1));
      }
      return { ok: false, pages: [], error: `pac genpage list failed after ${attempts} attempt(s): ${lastErr}` };
    },
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test scripts/tests/genpage-cli.test.js`
Expected: PASS (4 new tests + existing).

- [ ] **Step 5: Update the existing mocks so the phase rewrite won't break green tests**

In `scripts/tests/sdk-build.test.js` `mockSdk`, add `updateWebResource` (after `createWebResource`, `:106`) and a manifest-gated `webresource` query branch (replace the `webresource` line at `:59`). The branch is **opt-in** (`opts.pageManifest`) so existing `existingWebResource` tests are unaffected:

```javascript
// Replace :59 (`if (e === 'webresource') return opts.existingWebResource ? ...`) with:
      if (e === 'webresource') {
        // Manifest lookup (readPageManifest) — gated so existing web-resource tests are unaffected.
        // content is base64 (Dataverse webresource.content). Opt in via opts.pageManifest/opts.manifestId.
        if (/_pagemanifest'/.test(filter)) return opts.pageManifest ? [{ webresourceid: opts.manifestId || 'wr-manifest', content: opts.pageManifest }] : [];
        return opts.existingWebResource ? [{ webresourceid: 'wr-existing' }] : [];
      }

// Add after createWebResource (:106):
    updateWebResource: async (id, o) => { calls.push({ name: 'updateWebResource', args: [id, o] }); return {}; },
```

Add `enumerate` to the three genpageCli mocks:

```javascript
// :980 (empty app):     genpageCli = { list: async () => [], enumerate: async () => ({ ok: true, pages: [] }), upload: async (o) => { uploads.push(o); return { pageId: 'gp-1' }; } };
// :996 (empty app):     genpageCli = { list: async () => [], enumerate: async () => ({ ok: true, pages: [] }), upload: async () => ({ pageId: 'gp-1' }) };
// :1009 (existing page):genpageCli = { list: async () => [{ pageId: 'gp-existing', name: 'Overview' }], enumerate: async () => ({ ok: true, pages: [{ pageId: 'gp-existing', name: 'Overview' }] }), upload: async (o) => { uploads.push(o); return { pageId: 'gp-existing' }; } };
```

In `scripts/tests/sdk-build-pages-migrate.test.js`, add `enumerate: async () => ({ ok: true, pages: [] }),` to each of the three genpageCli mocks (`:90`, `:120`, `:148`). Also update the import at `:4` of `sdk-build.test.js` to include `appUniqueName`:

```javascript
const { runSdkBuild, planFor, resolvePhases, compileFormIntent, formFieldLogicals, viewDef, appDef, defaultViewColumns, enrichesDefaultViews, artifactIdentityQuery, dashboardTileOpts, PHASES, appUniqueName } = require('../lib/sdk-build.js');
```

- [ ] **Step 6: Write the failing integration tests** — append to `scripts/tests/sdk-build.test.js`

```javascript
test('pages phase (v2, page key != name): result.created.pages is keyed by KEY so the sitemap finalize resolves', async () => {
  const spec = makeSpec();
  spec.schemaVersion = 2;
  spec.pages = [{ key: 'overview', name: 'Overview', source: { kind: 'tsx', codeFile: 'o.tsx' } }];
  spec.appShell.areas[0].groups[0].subAreas.push({ page: 'overview', title: 'Overview' });
  const { sdk, calls } = mockSdk();
  const genpageCli = { list: async () => [], enumerate: async () => ({ ok: true, pages: [] }), upload: async () => ({ pageId: 'gp-1' }) };
  await runSdkBuild(spec, { sdk, apply: true, env: 'https://x', appDir: process.cwd(), genpageCli, phases: ['solution', 'data-model', 'app-shell', 'pages'] });
  const setDef = find(calls, 'updateElement').find((c) => c.args[2] === '/siteMap');
  assert.ok(setDef, 'sitemap finalized');
  const subs = setDef.args[3].areas[0].groups[0].subAreas;
  assert.ok(subs.some((s) => s.type === 'GenPage' && s.genPageId === 'gp-1'), 'GenPage subarea resolved by KEY (was unresolved when keyed by name)');
});

test('pages phase persists the page manifest on first build (create, type js, add-to-solution, no update)', async () => {
  const spec = makeSpec();
  spec.pages = [{ name: 'Overview', codeFile: 'o.tsx' }];
  const { sdk, calls } = mockSdk();
  const genpageCli = { list: async () => [], enumerate: async () => ({ ok: true, pages: [] }), upload: async () => ({ pageId: 'gp-1' }) };
  await runSdkBuild(spec, { sdk, apply: true, env: 'https://x', appDir: process.cwd(), genpageCli, phases: ['solution', 'data-model', 'app-shell', 'pages'] });
  const createdManifest = find(calls, 'createWebResource').map((c) => c.args[0]).find((o) => /_pagemanifest$/.test(o.name));
  assert.ok(createdManifest, 'manifest web resource created');
  assert.strictEqual(createdManifest.type, 'js');
  const manifest = JSON.parse(createdManifest.content);
  assert.strictEqual(manifest.schemaVersion, 1);
  assert.deepStrictEqual(manifest.pages[0], { key: 'Overview', name: 'Overview', pageId: 'gp-1' });
  assert.strictEqual(find(calls, 'updateWebResource').length, 0, 'no update on first build');
  assert.ok(find(calls, 'addSolutionComponent').some((c) => c.args[0].componentType === 61), 'manifest web resource added to the solution');
});

test('pages phase updates the manifest IN PLACE on a rebuild (updateWebResource, no duplicate create)', async () => {
  const spec = makeSpec();
  spec.pages = [{ name: 'Overview', codeFile: 'o.tsx' }];
  const existing = Buffer.from(JSON.stringify({ schemaVersion: 1, pages: [{ key: 'Overview', name: 'Overview', pageId: 'gp-existing' }] }), 'utf8').toString('base64');
  const { sdk, calls } = mockSdk({ pageManifest: existing, manifestId: 'wr-manifest' });
  const genpageCli = { list: async () => [{ pageId: 'gp-existing', name: 'Overview' }], enumerate: async () => ({ ok: true, pages: [{ pageId: 'gp-existing', name: 'Overview' }] }), upload: async (o) => ({ pageId: o.pageId || 'gp-existing' }) };
  await runSdkBuild(spec, { sdk, apply: true, env: 'https://x', appDir: process.cwd(), genpageCli, phases: ['solution', 'data-model', 'app-shell', 'pages'] });
  const upd = find(calls, 'updateWebResource');
  assert.strictEqual(upd.length, 1, 'manifest updated in place exactly once');
  assert.strictEqual(upd[0].args[0], 'wr-manifest');
  assert.strictEqual(JSON.parse(upd[0].args[1].content).pages[0].pageId, 'gp-existing');
  assert.ok(!find(calls, 'createWebResource').some((c) => /_pagemanifest$/.test(c.args[0].name)), 'manifest not re-created on rebuild');
  assert.ok(find(calls, 'addSolutionComponent').some((c) => c.args[0].componentType === 61), 'solution membership re-asserted every run');
});

test('pages phase HALTS (fail-closed) when page enumeration fails — never treats it as an empty app', async () => {
  const spec = makeSpec();
  spec.pages = [{ name: 'Overview', codeFile: 'o.tsx' }];
  const { sdk } = mockSdk();
  let uploaded = 0;
  const genpageCli = { list: async () => [], enumerate: async () => ({ ok: false, pages: [], error: 'auth expired' }), upload: async () => { uploaded += 1; return { pageId: 'gp-1' }; } };
  await assert.rejects(
    runSdkBuild(spec, { sdk, apply: true, env: 'https://x', appDir: process.cwd(), genpageCli, phases: ['solution', 'data-model', 'app-shell', 'pages'] }),
    (e) => e && e.phase === 'pages' && e.code === 'pages-enumeration-failed'
  );
  assert.strictEqual(uploaded, 0, 'no page uploaded when enumeration failed');
});

test('planFor includes the page manifest step when the spec has pages', () => {
  const spec = makeSpec();
  spec.pages = [{ name: 'Overview', codeFile: 'o.tsx' }];
  const labels = planFor(spec, { phases: PHASES }).map((p) => p.label);
  assert.ok(labels.includes(`page manifest ${appUniqueName(spec)}_pagemanifest`), 'plan lists the manifest step');
});
```

- [ ] **Step 7: Run the tests to verify they fail**

Run: `node --test scripts/tests/sdk-build.test.js`
Expected: FAIL — key-by-KEY test throws `references page 'overview' which wasn't built`; manifest create/update/planFor/halt tests fail (no manifest write / no halt yet).

- [ ] **Step 8: Implement the pages-phase rewrite + helpers + planFor + surface**

(a) Add the `page-manifest.js` require to `sdk-build.js` (in the requires region, `:20-31`):

```javascript
const { manifestResourceName, buildManifest, serializeManifest, parseManifestBase64, reconcilePageIds } = require('./page-manifest.js');
```

(b) Add the two helpers next to `ensureAppIcon` (after `:461`):

```javascript
// Read the durable page manifest (`<appUnique>_pagemanifest` web resource). Looked up by NAME via
// queryRecords (getWebResource needs the GUID we don't have yet). Returns { id, manifest }; manifest is
// null when absent/unreadable (fail-closed parse) so the caller relies on the live enumeration.
// content is base64 (Dataverse webresource.content). See design §7.3.
async function readPageManifest(provision, appUnique) {
  const name = manifestResourceName(appUnique);
  const rows = await provision.queryRecords('webresource', { select: ['webresourceid', 'content'], filter: `name eq '${odataLit(name)}'`, top: 1 });
  const wr = rows && rows[0];
  if (!wr) return { id: undefined, manifest: null };
  return { id: wr.webresourceid, manifest: parseManifestBase64(wr.content) };
}

// Create or UPDATE the durable page manifest and (idempotently) re-assert its solution membership
// EVERY run (design §7.3). First build creates the web resource; a rebuild updates its content IN
// PLACE via updateWebResource — plain reuse (the web-resources phase at :576-589) would leave STALE
// content, so the manifest needs the update path. Stored as type 'js' (webresourcetype 3): the SDK's
// WEB_RESOURCE_KINDS has no 'json' kind (:83) and 'js' round-trips arbitrary text unchanged. Returns id.
async function persistPageManifest(provision, spec, keyToId, sol, appUnique, existingId) {
  const name = manifestResourceName(appUnique);
  const content = serializeManifest(buildManifest(spec, keyToId));
  let id = existingId;
  if (id) {
    await provision.updateWebResource(id, { content });
  } else {
    const r = await provision.createWebResource({ name, displayName: `${spec.app.name} Page Manifest`, type: 'js', content });
    id = r.id;
  }
  await provision.addSolutionComponent({ componentId: id, componentType: COMPONENT_TYPE.webResource, solutionUniqueName: sol.uniqueName });
  return id;
}
```

(c) Replace the pages phase (`:1064-1097`) with the fail-closed / manifest / key-by-KEY version:

```javascript
  // 7b. Pages (generative pages) — fail-closed deployment (design §9). The app now exists, so upload
  //     each page's content via pac (WITHOUT --add-to-sitemap — the SDK owns the sitemap), persist the
  //     durable page manifest, then rewrite the sitemap once to include the GenPage subareas.
  if (has('pages') && (spec.pages || []).length) {
    const genpageCli = opts.genpageCli || makeGenpageCli(opts.env);
    const appUnique = appUniqueName(spec);
    // Fail-closed enumeration: a failed listing must NOT look like "no pages" (that would re-create
    // every page and orphan the originals). Thrown directly (not via runner.run) so the BuildHalt keeps
    // its structured `code` for a `--from pages` resume. recoverable:true — re-running re-enumerates.
    const enumd = await genpageCli.enumerate({ appId: result.created.app });
    if (!enumd.ok) {
      throw new BuildHalt(`page enumeration failed — refusing to (re)create pages against an unknown page set: ${enumd.error || 'pac genpage list returned non-zero'}`, { phase: 'pages', code: 'pages-enumeration-failed', recoverable: true });
    }
    // Seed key→pageId from the durable manifest reconciled against the live enumeration (design §7.3):
    // live name-match wins; a manifest id is used only if still live; everything else is absent.
    const { id: manifestId, manifest } = await readPageManifest(provision, appUnique);
    const { keyToId } = reconcilePageIds(spec.pages, manifest, enumd.pages);
    for (const p of spec.pages) {
      const src = normalizePageSource(p);
      if (!src || src.kind !== 'tsx' || !src.codeFile) {
        runner.skip('pages', `page "${p.name}" (no tsx source)`);
        continue;
      }
      const key = p.key || p.name;
      await runner.run('pages', `page "${p.name}"`, async () => {
        const codeFile = path.resolve(opts.appDir || '.', src.codeFile);
        const up = await genpageCli.upload({ appId: result.created.app, pageId: keyToId.get(key), codeFile, name: p.name, prompt: p.prompt, agentMessage: p.agentMessage, dataSources: p.dataSources });
        keyToId.set(key, up.pageId);
        // Key by the STABLE key (p.key||p.name): appDef resolves result.pages[s.page] where s.page is
        // the migrated KEY (:506). Keying by name left v2 key-referenced subareas unresolved (they throw
        // "references page '<key>' which wasn't built"); a legacy no-key spec falls back to name.
        result.created.pages[key] = up.pageId;
        return up.pageId;
      });
    }
    // Persist the manifest (create first build; updateWebResource on rebuild; add-to-solution every
    // run) so the next download/rebuild reconstructs keys + navigation. Visible progress step.
    await runner.run('pages', `page manifest ${manifestResourceName(appUnique)}`, async () => {
      await persistPageManifest(provision, spec, keyToId, sol, appUnique, manifestId);
      return manifestResourceName(appUnique);
    });
    if (appHasPageSubareas(spec)) {
      await runner.run('pages', 'finalize sitemap (genpage subareas)', async () => {
        await provision.fetchArtifact('app', result.created.app);
        const full = appDef(spec, result.created);
        provision.updateElement('app', result.created.app, '/siteMap', full.siteMap);
        requireSuccessfulPush(await provision.pushArtifact('app', result.created.app), 'app sitemap finalize');
        await provision.publishArtifact('app', result.created.app);
        return result.created.app;
      });
    }
  }
```

(d) Add the manifest `planFor` item — insert between the per-page items and the finalize item (`:279-280`):

```javascript
  if (has('pages')) for (const p of spec.pages || []) items.push({ phase: 'pages', label: `page "${p.name}"` });
  if (has('pages') && (spec.pages || []).length) items.push({ phase: 'pages', label: `page manifest ${appUniqueName(spec)}_pagemanifest` });
  if (has('pages') && (spec.pages || []).length && appHasPageSubareas(spec)) items.push({ phase: 'pages', label: 'finalize sitemap (genpage subareas)' });
```

(e) Add `'updateWebResource'` to `SKILL_SDK_SURFACE` (`sdk-surface-contract.test.js`) — alphabetical, after `'updateRecord'` (`:75`):

```javascript
  'updateElement',
  'updateRecord',
  'updateWebResource',
];
```

- [ ] **Step 9: Run the pages tests + the full suite**

Run: `node --test scripts/tests/sdk-build.test.js scripts/tests/sdk-build-pages-migrate.test.js scripts/tests/genpage-cli.test.js scripts/tests/sdk-surface-contract.test.js`
Expected: PASS (new integration tests green; existing pages/migrate/surface tests still green — `updateWebResource` is now both on the bundle **and** listed).

Then: `node scripts/run-tests.js`
Expected: PASS — suite green.

- [ ] **Step 10: Teardown — remove the manifest web resource (RED → GREEN)**

Add the failing test to `scripts/tests/sdk-teardown.test.js`:

```javascript
test('the durable page manifest web resource is torn down when the app has pages (no orphan)', () => {
  const spec = {
    solution: { uniqueName: 'PgSln', publisherPrefix: 'new' },
    app: { name: 'Pages App' },
    entities: [{ schemaName: 'new_widget', primaryAttribute: { schemaName: 'new_name' }, columns: [] }],
    pages: [{ key: 'overview', name: 'Overview', source: { kind: 'tsx', codeFile: 'o.tsx' } }],
    appShell: { areas: [{ label: 'A', groups: [{ label: 'G', subAreas: [{ entity: 'new_widget' }] }] }] },
  };
  const wrNames = planTeardown(spec).filter((s) => s.kind === 'webResource').map((s) => s.target.name);
  assert.ok(wrNames.includes(`${appUniqueName(spec)}_pagemanifest`), 'the page manifest web resource is torn down');
});
```

Run: `node --test scripts/tests/sdk-teardown.test.js` → FAIL (no manifest step yet).

Implement in `scripts/lib/sdk-teardown.js`: add the import (`:36-39` region) and the step (after the generated-icon step, `:346-349`):

```javascript
// :36-39 — add manifestResourceName (no cycle: page-manifest.js is a pure leaf):
const { manifestResourceName } = require('./page-manifest.js');

// After the generated-app-icon step (:346-349):
  // The build also creates a durable `<appUnique>_pagemanifest` web resource when the app has pages
  // (Task 3). Like the generated icon it is referenced only by the (already-deleted) app module, so it
  // must be removed here or the solution delete leaves it orphaned. Gated on pages so an app without
  // pages adds no step.
  if (spec.app && spec.solution && (spec.pages || []).length) {
    const manifestName = manifestResourceName(appUniqueName(spec));
    steps.push({ kind: 'webResource', phase: 'web-resources', label: `web resource ${manifestName} (page manifest)`, target: { name: manifestName } });
  }
```

Run: `node --test scripts/tests/sdk-teardown.test.js` → PASS.

- [ ] **Step 11: Full suite**

Run: `node scripts/run-tests.js`
Expected: PASS — suite green (≈ **583**).

- [ ] **Step 12: Commit**

```bash
git add scripts/lib/genpage-cli.js scripts/lib/sdk-build.js scripts/lib/sdk-teardown.js scripts/tests/genpage-cli.test.js scripts/tests/sdk-build.test.js scripts/tests/sdk-build-pages-migrate.test.js scripts/tests/sdk-surface-contract.test.js scripts/tests/sdk-teardown.test.js
git commit -m "feat(model-apps): fail-closed page enumeration + durable page manifest + key-by-key fix" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>" \
  -m "Copilot-Session: 42626da2-b66f-4162-acaa-b1127ef23d89"
```

---

## Task 4: `PAGEREF_` fail-closed deployment protocol (create-absent-first → resolve-to-staging → upload-once)

Replaces Task 3's single upload loop with the full design §9 protocol. The canonical `.tsx` is never GUID-mutated; resolved bytes go to staging files; a dangling nav target halts **before** the sitemap commit.

**Files:**
- Modify: `scripts/lib/sdk-build.js` — add the `pageref-resolver.js` require (`:20-31`); add the `writeStagingFile` helper (next to `persistPageManifest`); change `reconcilePageIds` destructure to include `absentKeys` and `manifestId` to `let`; replace the pages **upload** section (the Task 3 loop) with the 5-step protocol.
- Create: `scripts/tests/sdk-build-pages-deploy.test.js`.

**Interfaces:**
- Consumes: `resolvePageRefs` (Task 1); `enumerate` / `readPageManifest` / `persistPageManifest` / `reconcilePageIds` (Tasks 2–3); `normalizePageSource` (`app-spec.js`); `writeStagingFile` (new below).
- Produces:
  - `writeStagingFile(appDir, key, code) → string` — writes `<appDir>/.pageref-deploy/<sanitized-key>.tsx`, returns its path.
  - The §9 protocol in the pages phase; new `BuildHalt` code `pages-dangling-navref` (`recoverable: false`).

- [ ] **Step 1: Write the failing integration tests** — create `scripts/tests/sdk-build-pages-deploy.test.js`

```javascript
'use strict';
// Integration tests for the §9 PAGEREF_ deployment protocol: create-absent-first (mint ids) →
// resolve-to-staging (never mutate canonical) → upload-once (no duplicates) → sitemap finalize.
// Uses a REAL temp appDir under the project so the fs read (canonical .tsx) and write (staging) run.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { runSdkBuild } = require('../lib/sdk-build.js');

// Local mock SDK (same shape as sdk-build-pages-migrate.test.js) + updateWebResource. Covers
// solution + data-model + app-shell + pages. `opts.pageManifest` (base64) seeds an existing manifest.
function mockSdk(opts = {}) {
  const calls = [];
  let idc = 0;
  const store = {};
  const sdk = {
    queryRecords: async (e, o) => {
      calls.push({ name: 'queryRecords', args: [e, o] });
      const filter = (o && o.filter) || '';
      if (e === 'sitemap') return [{ sitemapid: 'sm-1' }];
      if (e === 'solution') return [];
      if (e === 'webresource') {
        if (/_pagemanifest'/.test(filter)) return opts.pageManifest ? [{ webresourceid: opts.manifestId || 'wr-manifest', content: opts.pageManifest }] : [];
        return [];
      }
      if (e === 'systemform') return [];
      if (e === 'savedquery') return [{ savedqueryid: 'defview-x', isdefault: true }];
      return [{ publisherid: 'pub-1' }];
    },
    findArtifact: async () => null,
    fetchArtifact: async (t, id) => { if (!store[`${t}:${id}`]) store[`${t}:${id}`] = { id, siteMap: { areas: [] } }; return store[`${t}:${id}`]; },
    createPublisher: async () => ({ id: 'pub-new' }),
    createSolution: async () => ({ id: 'sol-1' }),
    findTables: async () => [],
    findColumns: async () => [],
    fetchEntityMetadata: async (logical) => ({ logicalName: logical, entitySetName: `${logical}s`, attributes: [], relationships: [] }),
    createTable: async (o) => ({ logicalName: o.schemaName.toLowerCase(), entitySetName: `${o.schemaName.toLowerCase()}s`, metadataId: `tbl-${o.schemaName}` }),
    createColumn: async (e, o) => ({ logicalName: o.schemaName.toLowerCase(), metadataId: `col-${o.schemaName}` }),
    createRelationship: async (o) => ({ schemaName: o.schemaName }),
    createWebResource: async (o) => { calls.push({ name: 'createWebResource', args: [o] }); return { id: `wr-${++idc}`, name: o.name }; },
    updateWebResource: async (id, o) => { calls.push({ name: 'updateWebResource', args: [id, o] }); return {}; },
    enrichDefaultViews: async () => ({ updated: [] }),
    createArtifact: (t, def) => { calls.push({ name: 'createArtifact', args: [t, def] }); const id = `${t}-${++idc}`; store[`${t}:${id}`] = Object.assign({ id }, def); return JSON.parse(JSON.stringify(store[`${t}:${id}`])); },
    getArtifact: (t, id) => store[`${t}:${id}`] || { id },
    addElement: () => ({}),
    updateElement: (t, id, ptr, patch) => { calls.push({ name: 'updateElement', args: [t, id, ptr, patch] }); return {}; },
    removeElement: () => ({}),
    pushArtifact: async (t, id) => ({ type: t, id, success: true }),
    addSolutionComponent: async (o) => { calls.push({ name: 'addSolutionComponent', args: [o] }); },
    publishArtifact: async () => {},
  };
  return { sdk, calls };
}

// genpageCli mock: mints deterministic ids from the page name, records every upload. `live` seeds
// enumerate() for a rebuild.
function mockGenpageCli(live = []) {
  const uploads = [];
  return {
    uploads,
    list: async () => live,
    enumerate: async () => ({ ok: true, pages: live }),
    upload: async (o) => { uploads.push({ name: o.name, pageId: o.pageId, codeFile: o.codeFile }); return { pageId: o.pageId || `gp-${String(o.name).toLowerCase()}` }; },
  };
}

// Two implemented pages A→B on disk under a real temp appDir. A navigates to B via "PAGEREF_detail".
function makeTwoPageApp(appDir, opts = {}) {
  fs.mkdirSync(appDir, { recursive: true });
  const aCode = `export default function Overview(){ Xrm.Navigation.navigateTo({ pageType:'generative', pageId: "PAGEREF_detail", data:{} }); ${opts.extraRef ? 'const x = "PAGEREF_nonexistent";' : ''} return null; }`;
  fs.writeFileSync(path.join(appDir, 'overview.tsx'), aCode, 'utf8');
  fs.writeFileSync(path.join(appDir, 'detail.tsx'), 'export default function Detail(){ return null; }', 'utf8');
  return {
    schemaVersion: 2,
    solution: { uniqueName: 'PgDeploy', displayName: 'Pg', publisherPrefix: 'contoso' },
    app: { name: 'Deploy App' },
    entities: [{ schemaName: 'contoso_item', displayName: 'Item', primaryAttribute: { schemaName: 'contoso_name', displayName: 'Name' }, columns: [] }],
    pages: [
      { key: 'overview', name: 'Overview', navigatesTo: [{ targetKey: 'detail' }], source: { kind: 'tsx', codeFile: 'overview.tsx' } },
      { key: 'detail', name: 'Detail', source: { kind: 'tsx', codeFile: 'detail.tsx' } },
    ],
    appShell: { areas: [{ label: 'Main', groups: [{ label: 'Pages', subAreas: [{ page: 'overview', title: 'Overview' }, { page: 'detail', title: 'Detail' }] }] }] },
  };
}

const PHASES = ['solution', 'data-model', 'app-shell', 'pages'];

test('deploy protocol: nav page gets a resolved STAGING file (target id, no PAGEREF_); canonical .tsx is untouched', async () => {
  const appDir = path.join(__dirname, '.tmp-pages-deploy-1');
  try {
    const spec = makeTwoPageApp(appDir);
    const { sdk } = mockSdk();
    const genpageCli = mockGenpageCli();
    await runSdkBuild(spec, { sdk, apply: true, env: 'https://x', appDir, genpageCli, phases: PHASES });
    const staging = fs.readFileSync(path.join(appDir, '.pageref-deploy', 'overview.tsx'), 'utf8');
    assert.ok(staging.includes('gp-detail'), 'staging has the resolved target id');
    assert.ok(!/PAGEREF_/.test(staging), 'no PAGEREF_ token remains in the staged deployment copy');
    const canonical = fs.readFileSync(path.join(appDir, 'overview.tsx'), 'utf8');
    assert.ok(canonical.includes('"PAGEREF_detail"'), 'canonical .tsx is NEVER GUID-mutated');
  } finally {
    fs.rmSync(appDir, { recursive: true, force: true });
  }
});

test('deploy protocol: a dangling nav target HALTS before the sitemap finalize', async () => {
  const appDir = path.join(__dirname, '.tmp-pages-deploy-2');
  try {
    const spec = makeTwoPageApp(appDir, { extraRef: true }); // adds "PAGEREF_nonexistent"
    const { sdk, calls } = mockSdk();
    const genpageCli = mockGenpageCli();
    await assert.rejects(
      runSdkBuild(spec, { sdk, apply: true, env: 'https://x', appDir, genpageCli, phases: PHASES }),
      (e) => e && e.phase === 'pages' && e.code === 'pages-dangling-navref'
    );
    assert.ok(!calls.some((c) => c.name === 'updateElement' && c.args[2] === '/siteMap'), 'sitemap NOT finalized when a nav target is dangling');
  } finally {
    fs.rmSync(appDir, { recursive: true, force: true });
  }
});

test('deploy protocol: a rebuild re-binds ids from the live enumeration and never CREATEs a duplicate', async () => {
  const appDir = path.join(__dirname, '.tmp-pages-deploy-3');
  try {
    const spec = makeTwoPageApp(appDir);
    const live = [{ pageId: 'gp-overview', name: 'Overview' }, { pageId: 'gp-detail', name: 'Detail' }];
    const manifest = Buffer.from(JSON.stringify({ schemaVersion: 1, pages: [{ key: 'overview', name: 'Overview', pageId: 'gp-overview' }, { key: 'detail', name: 'Detail', pageId: 'gp-detail' }] }), 'utf8').toString('base64');
    const { sdk } = mockSdk({ pageManifest: manifest, manifestId: 'wr-manifest' });
    const genpageCli = mockGenpageCli(live);
    await runSdkBuild(spec, { sdk, apply: true, env: 'https://x', appDir, genpageCli, phases: PHASES });
    assert.ok(genpageCli.uploads.length > 0, 'pages uploaded');
    assert.ok(genpageCli.uploads.every((u) => !!u.pageId), 'every upload targets a known pageId (UPDATE) — no CREATE, no duplicate');
  } finally {
    fs.rmSync(appDir, { recursive: true, force: true });
  }
});

test('deploy protocol: create-absent-first mints ids and persists them to the manifest before finalize', async () => {
  const appDir = path.join(__dirname, '.tmp-pages-deploy-4');
  try {
    const spec = makeTwoPageApp(appDir);
    const { sdk, calls } = mockSdk();
    const genpageCli = mockGenpageCli();
    await runSdkBuild(spec, { sdk, apply: true, env: 'https://x', appDir, genpageCli, phases: PHASES });
    // The manifest web resource was created during the run (before the sitemap finalize)…
    const manifestCreates = calls.filter((c) => c.name === 'createWebResource' && /_pagemanifest$/.test(c.args[0].name));
    assert.ok(manifestCreates.length >= 1, 'manifest created during the run');
    // …and its final content records the minted pageIds for BOTH pages.
    const writes = calls.filter((c) => (c.name === 'createWebResource' && /_pagemanifest$/.test(c.args[0].name)) || c.name === 'updateWebResource');
    const last = writes[writes.length - 1];
    const content = (last.args[1] || last.args[0]).content;
    const byKey = Object.fromEntries(JSON.parse(content).pages.map((p) => [p.key, p.pageId]));
    assert.strictEqual(byKey.overview, 'gp-overview');
    assert.strictEqual(byKey.detail, 'gp-detail');
  } finally {
    fs.rmSync(appDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test scripts/tests/sdk-build-pages-deploy.test.js`
Expected: FAIL — Task 3's phase uploads canonical directly (no `.pageref-deploy/` staging file), never resolves, so the staging + dangling-halt tests fail.

- [ ] **Step 3: Add the `pageref-resolver.js` require + `writeStagingFile` helper to `scripts/lib/sdk-build.js`**

Require (in the `:20-31` region):

```javascript
const { resolvePageRefs } = require('./pageref-resolver.js');
```

Helper (next to `persistPageManifest`):

```javascript
// Write a RESOLVED deployment copy of a page's .tsx into a staging dir — NEVER over the canonical
// source (a GUID baked into canonical source breaks cross-env recreate; design §9 / SDK T5). pac
// genpage upload takes a file PATH (genpage-cli.js:77-86), so the resolved bytes must exist on disk.
// Staged under <appDir>/.pageref-deploy/<sanitized-key>.tsx (adjacent to the app dir / RuntimeTypes.ts
// per §9). The key is sanitized to a safe filename ([^A-Za-z0-9_-] → _).
function writeStagingFile(appDir, key, code) {
  const dir = path.join(path.resolve(appDir || '.'), '.pageref-deploy');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${String(key).replace(/[^A-Za-z0-9_-]/g, '_')}.tsx`);
  fs.writeFileSync(file, code, 'utf8');
  return file;
}
```

- [ ] **Step 4: Replace the pages upload section with the §9 protocol**

In the pages phase, change the seed destructure to capture `absentKeys` and make `manifestId` reassignable, then replace the Task 3 upload loop (the `for (const p of spec.pages) { … runner.run('pages', \`page "${p.name}"\`, …) }` block **and** the subsequent single manifest-persist step) with the protocol below. The trailing `if (appHasPageSubareas(spec)) { … finalize … }` block is unchanged.

```javascript
    // Seed key→pageId (+ which keys are absent) from the durable manifest reconciled against the live
    // enumeration. manifestId is `let` because create-absent-first persists after each mint and must
    // reuse the id it just created (else the next persist would create a DUPLICATE manifest).
    let { id: manifestId, manifest } = await readPageManifest(provision, appUnique);
    const { keyToId, absentKeys } = reconcilePageIds(spec.pages, manifest, enumd.pages);

    // Implemented (tsx) pages only; intent pages are announced as skips (progress parity) and ignored.
    const keyOf = (p) => p.key || p.name;
    const canonicalPath = (p) => path.resolve(opts.appDir || '.', normalizePageSource(p).codeFile);
    const implemented = [];
    for (const p of spec.pages) {
      const src = normalizePageSource(p);
      if (src && src.kind === 'tsx' && src.codeFile) implemented.push(p);
      else runner.skip('pages', `page "${p.name}" (no tsx source)`);
    }
    const absentSet = new Set(absentKeys);
    const createdKeys = new Set();

    // (2) CREATE-ABSENT-FIRST: upload the canonical (symbolic) source of each absent page — no pageId,
    //     so pac CREATEs and mints an id. Brand-new pages have no live navigation to disturb. Persist
    //     each minted id to the manifest IMMEDIATELY (crash-safety: a crash mid-loop must never re-create
    //     an already-minted page). manifestId is captured so the next persist UPDATEs in place.
    for (const p of implemented) {
      const key = keyOf(p);
      if (!absentSet.has(key)) continue;
      await runner.run('pages', `page "${p.name}" (create)`, async () => {
        const up = await genpageCli.upload({ appId: result.created.app, codeFile: canonicalPath(p), name: p.name, prompt: p.prompt, agentMessage: p.agentMessage, dataSources: p.dataSources });
        keyToId.set(key, up.pageId);
        result.created.pages[key] = up.pageId;
        createdKeys.add(key);
        manifestId = await persistPageManifest(provision, spec, keyToId, sol, appUnique, manifestId);
        return up.pageId;
      });
    }

    // (3) RESOLVE the navigation graph now that every id is known. Read ONLY the pages that navigate
    //     (have a nav edge) — a single-page app needs no file reads. Fail-closed: ANY dangling target
    //     HALTS before the sitemap commit (recoverable:false — a dangling ref is an author error, not a
    //     transient fault; retrying can't fix it).
    const navPages = implemented.filter((p) => (p.navigatesTo || []).length > 0);
    const sources = new Map();
    for (const p of navPages) sources.set(keyOf(p), { code: fs.readFileSync(canonicalPath(p), 'utf8') });
    const { deployment, unresolved } = resolvePageRefs(sources, keyToId);
    if (unresolved.length) {
      throw new BuildHalt(`unresolved cross-page navigation target(s): ${unresolved.join(', ')} — a page navigates to a key that isn't a built page`, { phase: 'pages', code: 'pages-dangling-navref', recoverable: false });
    }

    // (4) UPLOAD-ONCE per page (every page now has a known pageId → UPDATE, never a second CREATE):
    //     - nav page → its resolved STAGING copy (GUIDs substituted; canonical never GUID-mutated);
    //     - non-nav page just created in step 2 → already final (skip; re-upload would be wasted);
    //     - non-nav existing page → its canonical content (no PAGEREF_ to resolve) in one update.
    for (const p of implemented) {
      const key = keyOf(p);
      const isNav = (p.navigatesTo || []).length > 0;
      if (!isNav && createdKeys.has(key)) continue;
      await runner.run('pages', `page "${p.name}"`, async () => {
        const codeFile = isNav ? writeStagingFile(opts.appDir, key, deployment.get(key)) : canonicalPath(p);
        const up = await genpageCli.upload({ appId: result.created.app, pageId: keyToId.get(key), codeFile, name: p.name, prompt: p.prompt, agentMessage: p.agentMessage, dataSources: p.dataSources });
        keyToId.set(key, up.pageId);
        result.created.pages[key] = up.pageId;
        return up.pageId;
      });
    }

    // (5) Persist the FINAL manifest, then finalize the sitemap (the true commit point, below).
    await runner.run('pages', `page manifest ${manifestResourceName(appUnique)}`, async () => {
      manifestId = await persistPageManifest(provision, spec, keyToId, sol, appUnique, manifestId);
      return manifestResourceName(appUnique);
    });
```

- [ ] **Step 5: Run the deploy tests + the full suite**

Run: `node --test scripts/tests/sdk-build-pages-deploy.test.js`
Expected: PASS (4 tests).

Then: `node --test scripts/tests/sdk-build.test.js scripts/tests/sdk-build-pages-migrate.test.js`
Expected: PASS — the Task 3 pages tests still pass. (The single-page Task 3 tests have no `navigatesTo`, so no file reads or staging occur; `absentKeys` drives their CREATE, and existing-page tests bind via reconcile → UPDATE.)

Then: `node scripts/run-tests.js`
Expected: PASS — suite green (≈ **587**).

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/sdk-build.js scripts/tests/sdk-build-pages-deploy.test.js
git commit -m "feat(model-apps): PAGEREF_ fail-closed deployment protocol (create-absent, resolve-to-staging, upload-once)" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>" \
  -m "Copilot-Session: 42626da2-b66f-4162-acaa-b1127ef23d89"
```

---
