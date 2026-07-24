# App-Builder Staged Flow — Plan 3: Pages Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This is the highest-risk plan in the series (it gets a separate architectural review, and has already failed two rounds) — do not skip a step's RED run, and keep the full suite green after every task.

**Goal:** Land the **pages pipeline** for the staged flow — the fail-closed generative-page deployment protocol (`PAGEREF_<key>` cross-page navigation resolved into run-scoped staging copies, never mutating canonical source), a durable versioned `<app>_pagemanifest` web resource that carries page semantics across download/rebuild, the latent key/name binding fix in the pages phase, page-aware **mandatory fail-closed verification**, and a **manifest-aware download/hydration** round-trip. The correctness spine is: **fail-closed enumeration + create-absent-first + immediate-manifest-persist-after-every-create** so any re-run (even after a crash) re-seeds from `manifest + live enumeration` and converges idempotently — that convergence, not a distributed lock, is the safety guarantee. All new logic is either a pure offline-testable module or a discover-reconcile addition to the existing engine — no engine phase is renamed and no non-page build behavior changes.

**Architecture:** Two new **pure leaf modules** — `pageref-resolver.js` and `page-manifest.js` — are consumed by the engine's existing `pages` phase (`sdk-build.js:1064-1097`). The keystone of this revision is a **single structural navigation oracle**, `extractNavTargets(code)`, in `pageref-resolver.js`: it parses the ACTUAL `Xrm.Navigation.navigateTo({ pageType: 'generative', pageId: <literal|"PAGEREF_key"> })` **call sites** (not arbitrary string/comment scanning) and is the ONE source of truth used by (a) forward `PAGEREF_` resolution + parity in the pages phase (Task 8), (b) reverse-normalization in download (Task 11), and (c) nav-edge verification (Task 10). A decoy `"PAGEREF_detail"` string or a stray GUID in a comment can therefore never satisfy parity, resolution, or verification. The pages phase gains: (1) **fail-closed enumeration** via a new `genpageCli.enumerate` that validates the **complete** `pac model genpage list` output — names AND the summary count — and distinguishes a pac failure or an unrecognized/partial listing from a genuinely empty app; (2) a **safe uncertain-CREATE retry** that never issues a second CREATE without a fail-closed enumeration; (3) the **manifest lifecycle** (create → `updateWebResource` on rebuild, content-deduped, **persisted immediately after every page CREATE** for crash-safety → re-assert solution membership every run → **always** teardown); (4) the **§9 protocol** (structural scan/parity → create-absent-first → resolve-to-run-scoped-staging → upload-once → sitemap-finalize) under a **descoped single-machine advisory lockfile** (halts a fresh concurrent build, never steals; correctness rests on convergence, not the lock); (5) the **key-by-KEY** fix; and (6) **deferring the existing-app sitemap write to the pages finalizer** (C2). Required **page-spec validation** (unique names/paths, workspace-confined paths, stable-key grammar) is added to `app-spec.js` **before any write**. Verification is extended in the pure `verifySpec` plus a fail-closed page reader (`verify-model-app.js`) and a **mandatory** page-verify gate (`build-model-app.js`) that yields `{ ok:false, unableToRun:true }` (non-zero exit) rather than skipping. The download round-trip fetches the manifest, **enumerates fail-closed FIRST**, cleans the download dir, **fails on any download/read/write error**, requires **exact enumerated↔downloaded id equality**, reconciles via `reconcilePageIds`, and reverse-normalizes only validated navigation literals via the structural oracle. Destructive page operations (future removals) are out of scope — they route through Plan 2's `op-diff.js` classifier when added.

**Tech Stack:** Node.js (CommonJS), `node:test` + `node:assert`, run via `node scripts/run-tests.js`. Design source of truth: `plugins/model-apps/docs/app-builder-staged-flow-design.md` — **§5** (execution model: data pre-build → main-loop code-gen → **one full idempotent build; NO cross-run DAG**), **§8** (generate-pages stage), **§9** (cross-page navigation + fail-closed `PAGEREF_` protocol), **§7.3** (durable `<app>_pagemanifest` lifecycle + download reverse-normalization + legacy migration), **§13.1** (verify extended to pages — mandatory + fail-closed), **§14** (`--stage` apply-safe only for `data`). Navigation contract: `references/rules.md:299-356`.

## Global Constraints

- All commands run from the plugin root: `D:\Projects\power-platform-skills-sdk\plugins\model-apps`. The plan is implemented in a **worktree branched from the Plan-2-complete base** (measured baseline **570 passing**).
- Tests use `node:test`: `const { test } = require('node:test'); const assert = require('node:assert');`. Full suite: `node scripts/run-tests.js` (**measured baseline 570 passing after Plan 2** — keep it green; each task below adds tests, running totals are approximate). Single file: `node --test scripts/tests/<file>.test.js`.
- The **13 engine phase names and order are unchanged**: `solution, data-model, sample-data, web-resources, views, charts, forms, commands, dashboards, app-shell, pages, ai-features, publish`. This plan only touches the `pages` phase (and its `app-shell`/teardown/verify counterparts) plus pre-write page-spec validation.
- **One structural nav oracle.** `extractNavTargets(code)` parses the actual `navigateTo({ pageType:'generative', pageId: … })` **call sites**. It is the ONLY place navigation is interpreted — forward resolution/parity (Task 8), reverse-normalization (Task 11), and verification (Task 10) all derive from it. **Bare `PAGEREF_` token scanning is forbidden** (a decoy string/comment could evade it — review R2 Critical 1/C4).
- **Pure modules are offline-only:** `pageref-resolver.js` and `page-manifest.js` have **no I/O and no SDK handle**. The engine reads/writes the web-resource bytes and the staging `.tsx` files; the pure modules only shape/parse strings. They are unit-tested with in-memory inputs.
- **The canonical `.tsx` is NEVER mutated with a GUID.** `PAGEREF_<key>` resolution writes a **run-scoped staging copy** under `<workspace>/.pageref-deploy/<runId>/`, cleaned in a `finally`; `genpageCli.upload` reads that path. Baking an environment-specific id into source would break cross-env recreate (design §9, SDK opaque-identity **T5**).
- **Enumeration is fail-closed and validates the COMPLETE listing.** `genpageCli.enumerate` classifies a zero-exit `pac model genpage list` output as **recognized-pages** (every listed page has a name AND the parsed page count equals the summary "Found N page(s)" count), **recognized-empty** (an explicit no-pages / "Found 0" marker), or **unrecognized** (blank, help banner, changed format, missing count, or any page missing a name). Only the first two are success. A pac failure OR an `unrecognized` zero-exit yields `{ ok:false }` — the pages phase, the verify reader, and download **HALT** (they never treat a failed/unreadable/partial listing as "no pages"). `listPages`/`list` are retained but drive no create decision.
- **`result.created.pages` is keyed by the stable page key** (`p.key || p.name` — legacy specs with no key fall back to name). This matches `appDef`'s `result.pages[s.page]` lookup where `s.page` is the migrated **key** (`sdk-build.js:506`), fixing a latent bug hidden by legacy (name==ref) test specs.
- **The pages finalizer is the ONLY existing-app sitemap write.** For an app that already exists AND has page subareas, the `app-shell` phase resolves its id but **defers all sitemap mutation** to the pages finalizer; a build that halts before the finalizer leaves the *previous* deployed sitemap intact (design §9 commit point).
- **Manifest lifecycle & crash-safety:** first build creates the `<appUnique>_pagemanifest` web resource; a rebuild **updates its content in place via `updateWebResource`** (content-deduped — a write is skipped when the manifest already holds exactly this content); solution membership is **re-asserted every run** (idempotent `addSolutionComponent`); `planTeardown` **always** removes it (not gated on the current spec still having pages — a not-found delete is idempotent). The manifest is **persisted immediately after EVERY page CREATE** (design §9) — so a single-page first build issues one `createWebResource` + zero `updateWebResource`, while an N-new-page first build issues one `createWebResource` (first mint) + (N-1) `updateWebResource` (one per subsequent mint), and a halt after any create re-converges from the persisted manifest.
- **`updateWebResource` must be added to `SKILL_SDK_SURFACE`** (`sdk-surface-contract.test.js`) — it is exposed by the vendored bundle (`vendor/cds-maker-sdk.cjs`, confirmed a function) but not yet listed; the source-scan half of the contract test fails the moment the pages phase calls `provision.updateWebResource(` unless it is listed.
- **Concurrency is a single-machine advisory courtesy, not a distributed lock (review R2 Critical 3 — descoped).** A local advisory lockfile HALTs (`pages-locked`) a **fresh** concurrent build of the same app; it **never steals a fresh lock**, is reclaimable **only by age** (generous, 30 min) via a single **atomic exclusive create** (`fs.writeFileSync` flag `wx`), and is **owner-checked on release** (only the owning pid removes it). Concurrent builds of the SAME app across machines/worktrees are **unsupported**. CORRECTNESS comes from the convergence spine (fail-closed enumeration + create-absent-first + immediate-manifest-persist), NOT from mutual exclusion.
- **`--stage` is apply-safe only for `data`.** On apply, `build-model-app.js` accepts EXACTLY the full 13-phase set OR EXACTLY the `data` stage (`solution,data-model,sample-data`); every other partial range (`--from/--to/--only/--skip`, or any other `--stage`) is **rejected** for apply (design §14). Recovery from a page halt is a **full rerun** (idempotent) — `--from pages` is unsupported because the app id is not carried across runs. The engine additionally HALTs if `pages` runs without the app id.
- Commit trailers on every commit:
  ```
  Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
  Copilot-Session: 42626da2-b66f-4162-acaa-b1127ef23d89
  ```

---

## File Structure

- `scripts/lib/pageref-resolver.js` **(new)** — pure structural nav resolver: `extractNavTargets` (the single oracle), `navReferencedKeys`, `navMalformedRefs`, `resolvePageRefs` (structural, span-based), `reverseResolveNavIds` (structural, `pageId:` literals only), `navTargetParity`. No dependencies (leaf module).
- `scripts/lib/page-manifest.js` **(new)** — pure manifest builder/parser/reconciler: `MANIFEST_SCHEMA_VERSION`, `manifestResourceName`, `buildManifest`, `serializeManifest`, `parseManifest` (full-schema + key-uniqueness fail-closed), `parseManifestBase64`, `reconcilePageIds` (manifest-confirmed-live → unique-live-name → absent; ambiguous HALTs). No dependencies (leaf module).
- `scripts/lib/app-spec.js` **(modify)** — extend the Plan-1 page-validation loop (`:474-522`) with, BEFORE any write: case-insensitive page-**name** uniqueness, implemented-page **codeFile** path uniqueness + **workspace confinement** (reject `..`/absolute escape), and **stable-key grammar** (v2). No signature change.
- `scripts/lib/genpage-cli.js` **(modify)** — add `parseListCount` + `classifyListOutput` (tri-state, validates names + summary count) and `enumerate({ appId }) → { ok, pages, empty?, error? }` (fail-closed; retries); harden `upload`'s uncertain-CREATE retry (fail-closed re-enumerate; never a blind 2nd CREATE). Keep `list`/`listPages`.
- `scripts/lib/sdk-build.js` **(modify)** — `app-shell` defers the page-backed existing-app sitemap write (C2); pages phase (`:1064-1097`): fail-closed `enumerate` + manifest seed/reconcile (+ ambiguous HALT) + key-by-KEY + structural scan/parity + create-absent-first (**persist-after-each-create**) + `resolvePageRefs`-to-run-scoped-staging + upload-once (**persist-after-each-create** + I7 update-id guard) + sitemap-finalize, under the advisory lease with `finally` cleanup. New helpers `readPageManifest`/`persistPageManifest`/`writeStagingFile`/`acquireAppPagesLease`/`appHasCrossPageNav`. `planFor` gains a `resolve cross-page navigation` + `page manifest` item.
- `scripts/lib/sdk-teardown.js` **(modify)** — `planTeardown` **always** adds a `webResource` teardown step for `<appUnique>_pagemanifest`; import `manifestResourceName`.
- `scripts/lib/verify-spec.js` **(modify)** — `verifySpec` gains a page branch (exists / `GenPageId`-bound / **every declared nav edge resolves to the ACTUAL target's live `GenPageId`** via `extractNavTargets` / no residual/malformed nav `PAGEREF_`); **fails closed when the spec has implemented pages but the reader lacks `pages`**; new `subareaHasGenPage` (matches the **`GenPageId`** attribute only) + `appShellReferencesPage`; import `extractNavTargets` + `normalizePageSource`.
- `scripts/verify-model-app.js` **(modify)** — `readerFor(sdk, appUnique, { genpageCli, workspaceDir })` gains a fail-closed `pages()` (via `enumerate`, throws on `ok:false`) + cached `pageCode(pageId)` (via `download`); `main` builds a `genpageCli` + workspace and threads them. Export `appIdFor`.
- `scripts/build-model-app.js` **(modify)** — **wire the `deps.runBuild` seam** (`const runBuild = deps.runBuild || runSdkBuild`); page verify becomes **mandatory + fail-closed** when the spec has implemented pages; reject an apply-time phase selection that is not exactly the full set or the `data` stage (I1); import `normalizePageSource`, `PHASES`, `STAGES`.
- `scripts/download-model-app.js` **(modify)** — enumerate fail-closed FIRST, clean the download dir, `download` (no swallow), require exact enumerated↔downloaded id equality, fetch `<uniquename>_pagemanifest`, `reconcilePageIds`, build `idToKey`, reverse-normalize each `page.tsx` (structural), reconstruct keys; export `assignPageKeys`/`missingDownloads`; thread the manifest to `hydrateSpec`.
- `scripts/lib/hydrate-spec.js` **(modify)** — with keys present, reconstruct the v2 page shape (`key`/`purpose`/`navigatesTo`/`pageInput`/`source:{kind:'tsx',codeFile}`) + `schemaVersion: 2` + `design` + key-based GenPage subareas; legacy fallback (no keys) keeps the name shape.
- `scripts/tests/pageref-resolver.test.js`, `scripts/tests/page-manifest.test.js`, `scripts/tests/sdk-build-pages-deploy.test.js`, `scripts/tests/sdk-build-pages-order.test.js`, `scripts/tests/verify-model-app.test.js` **(new)** — offline unit + integration + failure-ordering + reader tests.
- `scripts/tests/app-spec.test.js`, `scripts/tests/genpage-cli.test.js`, `scripts/tests/sdk-build.test.js`, `scripts/tests/sdk-build-pages-migrate.test.js`, `scripts/tests/sdk-surface-contract.test.js`, `scripts/tests/sdk-teardown.test.js`, `scripts/tests/verify-spec.test.js`, `scripts/tests/build-model-app.test.js`, `scripts/tests/download-model-app.test.js`, `scripts/tests/hydrate-spec.test.js` **(modify)** — add page-validation rejections; add `enumerate` to genpageCli mocks; add `updateWebResource` + manifest query branch to `mockSdk`; **write REAL staged `.tsx` fixtures** for pages tests (Task 5) so the source-reading scan (Task 8) does not ENOENT; new assertions.
- `references/rules.md`, `agents/genpage-page-builder.md`, `references/app-spec-schema.md`, `skills/app-builder/SKILL.md`, `CHANGELOG.md` **(modify)** — `PAGEREF_<key>` uses the stable KEY; `data:` (never `recordId`) for custom ids; the manifest + protocol + full-rerun recovery; remove `--from <phase>` recovery advice (docs — not tested).

---

## Task 1: `pageref-resolver.js` — the single structural nav oracle (`extractNavTargets`) + resolve/reverse/parity (C1, C4)

Introduces `extractNavTargets` — the ONE structural extractor that parses actual `navigateTo({ pageType:'generative', pageId: … })` call sites — and builds every other function on top of it, so bare-token scanning (which a decoy could evade) is eliminated.

**Files:**
- Create: `scripts/lib/pageref-resolver.js`
- Create: `scripts/tests/pageref-resolver.test.js`

**Interfaces:**
- Consumes: nothing (leaf module — no I/O, no SDK handle).
- Produces:
  - `extractNavTargets(code: string) → NavTarget[]` — one entry per **generative** `navigateTo` call site, classifying its `pageId` VALUE with an absolute character span for precise, collision-free rewrites:
    - `{ kind: 'pageref', key, valueStart, valueEnd }` — canonical double-quoted `"PAGEREF_<key>"`.
    - `{ kind: 'pageref-malformed', key, raw, valueStart, valueEnd }` — a `PAGEREF_` token NOT in canonical double-quoted form (single-quoted, back-ticked, concatenated).
    - `{ kind: 'literal', pageId, quote, valueStart, valueEnd }` — a quoted id/GUID (a resolved deployment target).
    - `{ kind: 'dynamic', raw, valueStart, valueEnd }` — a variable/expression pageId (not a static literal).
  - `navReferencedKeys(code) → string[]` — sorted-unique keys referenced by **canonical** nav pagerefs (parity input).
  - `navMalformedRefs(code) → string[]` — sorted-unique `PAGEREF_<key>` tokens used as a nav pageId in a malformed form (the build HALTs on any).
  - `resolvePageRefs(sources: Map<key, { code }>, keyToId: Map<key,id>) → { deployment: Map<key,code>, unresolved: string[] }` — structural, span-based substitution of every canonical nav `pageId` PAGEREF with the quoted GenPageId; `unresolved` = sorted-unique dangling target keys, left **verbatim** so the caller HALTs.
  - `reverseResolveNavIds(code, idToKey: Map<id,key>) → string` — the download inverse: rewrites a **nav `pageId` literal** back to `"PAGEREF_<key>"` when its value is a known deployed id (case-insensitive), touching NOTHING else (recordId, data values, comments).
  - `navTargetParity(declaredKeys, referencedKeys) → { declaredNotReferenced, referencedNotDeclared }` — pure exact-parity between declared `navigatesTo.targetKey`s and canonically-referenced keys.

- [ ] **Step 1: Write the failing test** — `scripts/tests/pageref-resolver.test.js`

```javascript
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { extractNavTargets, navReferencedKeys, navMalformedRefs, resolvePageRefs, reverseResolveNavIds, navTargetParity } = require(path.join(__dirname, '..', 'lib', 'pageref-resolver.js'));

const NAV = (id) => `Xrm.Navigation.navigateTo({ pageType: "generative", pageId: ${id}, data: {} });`;

test('extractNavTargets classifies a canonical PAGEREF nav pageId (structural — real call site only)', () => {
  const t = extractNavTargets(NAV('"PAGEREF_detail"'));
  assert.strictEqual(t.length, 1);
  assert.strictEqual(t[0].kind, 'pageref');
  assert.strictEqual(t[0].key, 'detail');
});

test('extractNavTargets IGNORES a decoy "PAGEREF_" string that is NOT a nav pageId (C1 oracle)', () => {
  const code = `const label = "PAGEREF_detail"; // decoy, not navigation\n${NAV('"PAGEREF_gallery"')}`;
  const t = extractNavTargets(code);
  assert.strictEqual(t.length, 1, 'only the real nav call site counts');
  assert.strictEqual(t[0].key, 'gallery');
  assert.deepStrictEqual(navReferencedKeys(code), ['gallery'], 'the decoy "detail" is not a referenced key');
});

test('extractNavTargets classifies a resolved GUID literal, and a dynamic (variable) pageId', () => {
  assert.strictEqual(extractNavTargets(NAV('"5d29d8ce-1111-2222-3333-444455556666"'))[0].kind, 'literal');
  assert.strictEqual(extractNavTargets(NAV('targetPageId'))[0].kind, 'dynamic');
});

test('extractNavTargets only counts pageType:"generative" call sites', () => {
  const code = 'Xrm.Navigation.navigateTo({ pageType: "entityrecord", pageId: "PAGEREF_detail" });';
  assert.deepStrictEqual(extractNavTargets(code), []);
});

test('extractNavTargets handles pageId BEFORE pageType and a nested data:{} object', () => {
  const code = 'navigateTo({ pageId: "PAGEREF_detail", pageType: "generative", data: { recordId: "PAGEREF_notakey", nested: { x: 1 } } });';
  const t = extractNavTargets(code);
  assert.strictEqual(t.length, 1);
  assert.strictEqual(t[0].kind, 'pageref');
  assert.strictEqual(t[0].key, 'detail', 'the top-level pageId is the target — a PAGEREF-looking string inside data:{} is NOT');
});

test('navMalformedRefs flags a single-quoted PAGEREF_ used as a nav pageId (C4 grammar)', () => {
  const code = "Xrm.Navigation.navigateTo({ pageType: 'generative', pageId: 'PAGEREF_detail' });";
  assert.deepStrictEqual(navMalformedRefs(code), ['PAGEREF_detail']);
  assert.deepStrictEqual(navReferencedKeys(code), [], 'a malformed ref is NOT a valid canonical reference');
});

test('resolvePageRefs replaces each canonical nav pageId with the quoted genPageId (span-based, no partial collide)', () => {
  const sources = new Map([['x', { code: `${NAV('"PAGEREF_pet"')}\n${NAV('"PAGEREF_pet-gallery"')}` }]]);
  const keyToId = new Map([['pet', 'id-pet'], ['pet-gallery', 'id-gallery']]);
  const { deployment, unresolved } = resolvePageRefs(sources, keyToId);
  assert.ok(deployment.get('x').includes('pageId: "id-pet"'));
  assert.ok(deployment.get('x').includes('pageId: "id-gallery"'));
  assert.deepStrictEqual(unresolved, []);
});

test('resolvePageRefs collects dangling targets (sorted, unique) and leaves them verbatim', () => {
  const sources = new Map([
    ['a', { code: `${NAV('"PAGEREF_missing"')}\n${NAV('"PAGEREF_gone"')}` }],
    ['b', { code: NAV('"PAGEREF_gone"') }],
  ]);
  const { deployment, unresolved } = resolvePageRefs(sources, new Map());
  assert.deepStrictEqual(unresolved, ['gone', 'missing']);
  assert.ok(deployment.get('a').includes('"PAGEREF_missing"'), 'a dangling ref must not be dropped or mangled — the caller halts on it');
});

test('resolvePageRefs is idempotent — resolved code has no canonical nav PAGEREF left', () => {
  const once = resolvePageRefs(new Map([['x', { code: NAV('"PAGEREF_detail"') }]]), new Map([['detail', 'gp-1']])).deployment.get('x');
  assert.deepStrictEqual(navReferencedKeys(once), []);
});

test('reverseResolveNavIds rewrites ONLY the nav pageId literal back to "PAGEREF_<key>" (case-insensitive), never a recordId', () => {
  const idToKey = new Map([['5d29d8ce-1111-2222-3333-444455556666', 'detail']]);
  const code = 'Xrm.Navigation.navigateTo({ pageType: "generative", pageId: "5D29D8CE-1111-2222-3333-444455556666", recordId: "5d29d8ce-1111-2222-3333-444455556666" });';
  const out = reverseResolveNavIds(code, idToKey);
  assert.ok(out.includes('pageId: "PAGEREF_detail"'), 'nav pageId reversed');
  assert.ok(out.includes('recordId: "5d29d8ce-1111-2222-3333-444455556666"'), 'the SAME guid used as a recordId is NOT reversed (scoped to nav pageId)');
});

test('resolve then reverse round-trips the navigation literal', () => {
  const original = NAV('"PAGEREF_detail"');
  const resolved = resolvePageRefs(new Map([['x', { code: original }]]), new Map([['detail', 'gp-42']])).deployment.get('x');
  assert.ok(resolved.includes('pageId: "gp-42"'));
  assert.strictEqual(reverseResolveNavIds(resolved, new Map([['gp-42', 'detail']])), original);
});

test('navTargetParity reports declared-not-referenced and referenced-not-declared (both directions)', () => {
  assert.deepStrictEqual(navTargetParity(['detail', 'ghost'], ['detail', 'extra']), { declaredNotReferenced: ['ghost'], referencedNotDeclared: ['extra'] });
  assert.deepStrictEqual(navTargetParity(['a'], ['a']), { declaredNotReferenced: [], referencedNotDeclared: [] });
});

test('DECOY end-to-end: declared "detail" but the real nav points at "wrong" — parity REJECTS it', () => {
  const code = `const decoy = "PAGEREF_detail";\n${NAV('"PAGEREF_wrong"')}`;
  assert.deepStrictEqual(navTargetParity(['detail'], navReferencedKeys(code)), { declaredNotReferenced: ['detail'], referencedNotDeclared: ['wrong'] });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test scripts/tests/pageref-resolver.test.js`
Expected: FAIL — `Cannot find module '.../lib/pageref-resolver.js'`.

- [ ] **Step 3: Create `scripts/lib/pageref-resolver.js`**

```javascript
'use strict';
// Pure STRUCTURAL resolver for generative-page cross-page navigation. Authors emit a link as a stable
// symbolic token — pageId: "PAGEREF_<key>" — because the real GenPageId is minted by the server at
// deploy time and differs per environment (SDK opaque-identity rule T5: never bake a resolved GUID into
// canonical source, or a cross-env recreate ships a dead link). See references/rules.md "Generative Page
// Navigation" and docs/app-builder-staged-flow-design.md §9. The ENGINE reads/writes files; this module
// only shapes/parses strings (pure, offline).
//
// THE SINGLE NAV ORACLE. `extractNavTargets` parses the ACTUAL
//   Xrm.Navigation.navigateTo({ pageType: 'generative', pageId: <value>, … })
// call sites and returns one classified entry per generative call site. Every other function here, and
// the build/verify/download consumers, derive from it — so a decoy "PAGEREF_x" string or a stray GUID
// in a comment/label (NOT a real nav pageId) can never satisfy parity, resolution, or verification.
// This replaces the earlier bare-token string scan, which a wrong-quoted or misplaced token could evade
// (review R2, Critical 1/C4).

// `navigateTo(` immediately followed by an object literal `{`. `\s*` tolerates the multi-line form in
// references/rules.md. The method-name prefix (Xrm.Navigation./xrm.Navigation.) is irrelevant to the
// match, so any call spelled `navigateTo({ … })` is covered.
const NAV_CALL = /navigateTo\s*\(\s*\{/g;
const CANON = /^"PAGEREF_([A-Za-z0-9_-]+)"$/;   // canonical: double-quoted, both sides
const PAGEREF_ANY = /PAGEREF_([A-Za-z0-9_-]+)/;  // a PAGEREF token in ANY form (used to detect malformed)
const QUOTED = /^(["'`])([\s\S]*)\1$/;           // a single quoted/back-ticked string literal

// Scan the object-literal argument of a navigateTo(...) call from the '{' at `open` to its matching
// '}', string-aware so a brace inside a string does not end the object. Returns { text, end } or null
// on an unbalanced/broken literal (the caller treats a broken call as having no nav target).
function objectArgAt(code, open) {
  let depth = 0;
  let inStr = null;
  for (let i = open; i < code.length; i += 1) {
    const c = code[i];
    if (inStr) { if (c === '\\') { i += 1; continue; } if (c === inStr) inStr = null; continue; }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
    if (c === '{') depth += 1;
    else if (c === '}') { depth -= 1; if (depth === 0) return { text: code.slice(open, i + 1), end: i + 1 }; }
  }
  return null;
}

// Read the VALUE of a TOP-LEVEL `key:` in an object-literal text (depth 1 only — never a key inside a
// nested data:{}/pageInput:{}). `objText` begins with '{'. Returns { raw, valueStart, valueEnd } (span
// relative to objText) or null when the key is absent at the top level. A quoted value captures the
// whole string literal (escape-aware); an unquoted value runs to the next top-level ',' or the closing
// '}'. The char-before check rejects a false hit inside a longer identifier (e.g. `myPageId`).
function topLevelValue(objText, key) {
  let depth = 0;
  let inStr = null;
  const keyRe = new RegExp('^' + key + '\\s*:');
  for (let i = 0; i < objText.length; i += 1) {
    const c = objText[i];
    if (inStr) { if (c === '\\') { i += 1; continue; } if (c === inStr) inStr = null; continue; }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
    if (c === '{' || c === '[' || c === '(') { depth += 1; continue; }
    if (c === '}' || c === ']' || c === ')') { depth -= 1; continue; }
    if (depth !== 1 || c !== key[0]) continue;
    if (!keyRe.test(objText.slice(i))) continue;
    const before = objText[i - 1];
    if (before !== undefined && !/[{,\s]/.test(before)) continue; // e.g. the "p" in myPageId — not a key
    let j = i + keyRe.exec(objText.slice(i))[0].length;
    while (j < objText.length && /\s/.test(objText[j])) j += 1;
    const q = objText[j];
    if (q === '"' || q === "'" || q === '`') {
      let k = j + 1;
      for (; k < objText.length; k += 1) { if (objText[k] === '\\') { k += 1; continue; } if (objText[k] === q) { k += 1; break; } }
      return { raw: objText.slice(j, k), valueStart: j, valueEnd: k };
    }
    let d2 = 0;
    let k = j;
    for (; k < objText.length; k += 1) { const cc = objText[k]; if (cc === '{' || cc === '[' || cc === '(') d2 += 1; else if (cc === '}' || cc === ']' || cc === ')') { if (d2 === 0) break; d2 -= 1; } else if (cc === ',' && d2 === 0) break; }
    return { raw: objText.slice(j, k).trim(), valueStart: j, valueEnd: k };
  }
  return null;
}

// Parse every generative navigateTo(...) call site into a classified pageId descriptor (see the module
// header). Spans are ABSOLUTE offsets into `code` so resolve/reverse can rewrite precisely and never
// partial-collide. Only pageType:'generative' string-literal call sites are returned — a non-generative
// or dynamic pageType is not a cross-page genpage navigation.
function extractNavTargets(code) {
  const s = String(code || '');
  const out = [];
  NAV_CALL.lastIndex = 0;
  let m;
  while ((m = NAV_CALL.exec(s)) !== null) {
    const open = m.index + m[0].length - 1; // index of the '{'
    const obj = objectArgAt(s, open);
    if (!obj) continue;
    const pt = topLevelValue(obj.text, 'pageType');
    const ptQ = pt && QUOTED.exec(pt.raw);
    if (!ptQ || ptQ[2] !== 'generative') continue;
    const pv = topLevelValue(obj.text, 'pageId');
    if (!pv) continue;
    const valueStart = open + pv.valueStart;
    const valueEnd = open + pv.valueEnd;
    const raw = pv.raw;
    const canon = CANON.exec(raw);
    if (canon) { out.push({ kind: 'pageref', key: canon[1], valueStart, valueEnd }); continue; }
    // A PAGEREF token in any non-canonical form is malformed (single/back-tick quoted, concatenated) —
    // the resolver can only substitute the canonical token, so a malformed one would ship UNRESOLVED.
    const anyRef = PAGEREF_ANY.exec(raw);
    if (anyRef) { out.push({ kind: 'pageref-malformed', key: anyRef[1], raw, valueStart, valueEnd }); continue; }
    const quoted = QUOTED.exec(raw);
    if (quoted) { out.push({ kind: 'literal', pageId: quoted[2], quote: quoted[1], valueStart, valueEnd }); continue; }
    out.push({ kind: 'dynamic', raw, valueStart, valueEnd });
  }
  return out;
}

// Sorted-unique keys referenced by a CANONICAL nav pageref (the parity input). Derived from the oracle,
// so only real nav call sites count.
function navReferencedKeys(code) {
  const keys = new Set();
  for (const t of extractNavTargets(code)) if (t.kind === 'pageref') keys.add(t.key);
  return [...keys].sort();
}

// Sorted-unique PAGEREF tokens used as a nav pageId in a MALFORMED form. The build HALTs on any (C4):
// the resolver substitutes only the canonical double-quoted token, so a malformed ref would deploy a
// dead link. Derived from the oracle, so a malformed PAGEREF that is NOT a nav pageId is ignored.
function navMalformedRefs(code) {
  const bad = new Set();
  for (const t of extractNavTargets(code)) if (t.kind === 'pageref-malformed') bad.add(`PAGEREF_${t.key}`);
  return [...bad].sort();
}

// Resolve every source's CANONICAL nav pageref to a quoted GenPageId, structurally (span-based, applied
// right-to-left so earlier spans stay valid). Returns the resolved copies plus the sorted-unique
// referenced keys that had NO id (dangling nav targets), left verbatim so the caller can HALT fail-closed.
function resolvePageRefs(sources, keyToId) {
  const deployment = new Map();
  const unresolved = new Set();
  for (const [key, entry] of sources) {
    const code = entry && typeof entry.code === 'string' ? entry.code : '';
    const targets = extractNavTargets(code).filter((t) => t.kind === 'pageref');
    let out = code;
    for (let i = targets.length - 1; i >= 0; i -= 1) {
      const t = targets[i];
      if (keyToId.has(t.key)) out = out.slice(0, t.valueStart) + JSON.stringify(String(keyToId.get(t.key))) + out.slice(t.valueEnd);
      else unresolved.add(t.key);
    }
    deployment.set(key, out);
  }
  return { deployment, unresolved: [...unresolved].sort() };
}

// Download inverse: rewrite each nav pageId LITERAL whose value is a known deployed id back to its
// symbolic "PAGEREF_<key>". Structural (via the oracle) + span-based, so it NEVER touches a recordId, a
// data value, or a GUID in a comment — only an actual navigation pageId. Dataverse may echo the GUID
// upper- or lower-cased, so match case-insensitively.
function reverseResolveNavIds(code, idToKey) {
  const byLower = new Map([...(idToKey || new Map())].map(([id, key]) => [String(id).toLowerCase(), key]));
  const s = String(code || '');
  const targets = extractNavTargets(s).filter((t) => t.kind === 'literal' && byLower.has(String(t.pageId).toLowerCase()));
  let out = s;
  for (let i = targets.length - 1; i >= 0; i -= 1) {
    const t = targets[i];
    out = out.slice(0, t.valueStart) + `"PAGEREF_${byLower.get(String(t.pageId).toLowerCase())}"` + out.slice(t.valueEnd);
  }
  return out;
}

// Pure exact-parity between a page's DECLARED navigatesTo targetKeys and the keys its source actually
// references via canonical nav pagerefs. Exact parity is required (C4): a declared edge missing from the
// source, or a source ref with no declaration, is an authoring error the caller HALTs on before deploy.
function navTargetParity(declaredKeys, referencedKeysList) {
  const d = new Set((declaredKeys || []).map(String));
  const r = new Set((referencedKeysList || []).map(String));
  return {
    declaredNotReferenced: [...d].filter((k) => !r.has(k)).sort(),
    referencedNotDeclared: [...r].filter((k) => !d.has(k)).sort(),
  };
}

module.exports = { extractNavTargets, navReferencedKeys, navMalformedRefs, resolvePageRefs, reverseResolveNavIds, navTargetParity };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test scripts/tests/pageref-resolver.test.js`
Expected: PASS (all 13 tests).

Then the full gate: `node scripts/run-tests.js`
Expected: PASS — suite green (≈ 583).

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/pageref-resolver.js scripts/tests/pageref-resolver.test.js
git commit -m "feat(model-apps): single structural nav oracle (extractNavTargets) + resolve/reverse/parity" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>" \
  -m "Copilot-Session: 42626da2-b66f-4162-acaa-b1127ef23d89"
```

---

## Task 2: `page-manifest.js` — pure build/parse/reconcile of the durable page manifest (I5, C5)

**Files:**
- Create: `scripts/lib/page-manifest.js`
- Create: `scripts/tests/page-manifest.test.js`

**Interfaces:**
- Consumes: nothing (leaf module).
- Produces:
  - `MANIFEST_SCHEMA_VERSION: number` (= `1`).
  - `manifestResourceName(appUnique: string) → string` — `` `${appUnique}_pagemanifest` ``.
  - `buildManifest(spec, keyToId: Map<string,string>) → { schemaVersion, pages: [{ key, name, pageId?, purpose?, dataSources?, navigatesTo?, pageInput? }], design? }` — full page semantics keyed by `p.key || p.name`; omits undefined/empty optional fields; sets `pageId` from `keyToId`. Matches design §7.3 exactly.
  - `serializeManifest(manifest) → string` (pretty JSON).
  - `parseManifest(text) → manifest | null` — **fail-closed FULL-schema validation (I5):** bad JSON / wrong `schemaVersion` / non-array `pages` / a page missing a string `key`/`name` / a **duplicate key** / a malformed optional field → `null`.
  - `parseManifestBase64(b64) → manifest | null` — decode the Dataverse `content` (base64) then `parseManifest`.
  - `reconcilePageIds(pages, manifest, livePages) → { keyToId: Map, absentKeys: string[], ambiguous: [{ key, name, matches }] }` — **authority order (C5):** (1) manifest `key→id` when that id is confirmed live; (2) else exactly one live name-match; (3) else absent; (4) duplicate/ambiguous live names are returned in `ambiguous` (the caller HALTs — never silently collapsed). Used by the pages phase (Task 5/8), download (Task 11).

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

test('serializeManifest then parseManifest round-trips', () => {
  const m = buildManifest({ pages: [{ key: 'a', name: 'A' }] }, new Map());
  assert.deepStrictEqual(parseManifest(serializeManifest(m)), m);
});

test('parseManifest is fail-closed on structure: bad JSON / wrong schemaVersion / non-array pages / missing version', () => {
  assert.strictEqual(parseManifest('not json{'), null);
  assert.strictEqual(parseManifest(JSON.stringify({ schemaVersion: 999, pages: [] })), null);
  assert.strictEqual(parseManifest(JSON.stringify({ schemaVersion: 1, pages: 'x' })), null);
  assert.strictEqual(parseManifest(JSON.stringify({ pages: [] })), null);
});

test('parseManifest is fail-closed on page schema: missing key/name, duplicate key, malformed optional (I5)', () => {
  assert.strictEqual(parseManifest(JSON.stringify({ schemaVersion: 1, pages: [{ name: 'NoKey' }] })), null);
  assert.strictEqual(parseManifest(JSON.stringify({ schemaVersion: 1, pages: [{ key: 'a' }] })), null); // no name
  assert.strictEqual(parseManifest(JSON.stringify({ schemaVersion: 1, pages: [{ key: 'a', name: 'A' }, { key: 'a', name: 'A2' }] })), null); // duplicate key
  assert.strictEqual(parseManifest(JSON.stringify({ schemaVersion: 1, pages: [{ key: 'a', name: 'A', dataSources: 'x' }] })), null); // dataSources not array
  assert.strictEqual(parseManifest(JSON.stringify({ schemaVersion: 1, pages: [{ key: 'a', name: 'A', navigatesTo: 'x' }] })), null); // navigatesTo not array
  assert.strictEqual(parseManifest(JSON.stringify({ schemaVersion: 1, pages: [{ key: 'a', name: 'A', pageInput: [] }] })), null); // pageInput not object
  assert.strictEqual(parseManifest(JSON.stringify({ schemaVersion: 1, pages: [{ key: 'a', name: 'A', pageId: '' }] })), null); // empty pageId
});

test('parseManifestBase64 decodes then parses (fail-closed on garbage)', () => {
  const m = buildManifest({ pages: [{ key: 'a', name: 'A' }] }, new Map());
  const b64 = Buffer.from(serializeManifest(m), 'utf8').toString('base64');
  assert.deepStrictEqual(parseManifestBase64(b64), m);
  assert.strictEqual(parseManifestBase64('@@ not base64 json @@'), null);
});

test('reconcilePageIds: manifest key->id CONFIRMED LIVE wins over a different page with the same display name (C5)', () => {
  const pages = [{ key: 'overview', name: 'Overview' }];
  const manifest = { schemaVersion: 1, pages: [{ key: 'overview', name: 'Overview', pageId: 'A' }] };
  const live = [{ pageId: 'A', name: 'Renamed In Maker' }, { pageId: 'B', name: 'Overview' }];
  const { keyToId, absentKeys, ambiguous } = reconcilePageIds(pages, manifest, live);
  assert.strictEqual(keyToId.get('overview'), 'A');
  assert.deepStrictEqual(absentKeys, []);
  assert.deepStrictEqual(ambiguous, []);
});

test('reconcilePageIds: a manifest id NOT present in live falls back to the unique live name-match (stale imported id)', () => {
  const pages = [{ key: 'overview', name: 'Overview' }];
  const manifest = { schemaVersion: 1, pages: [{ key: 'overview', name: 'Overview', pageId: 'imported-from-other-env' }] };
  const live = [{ pageId: 'live-id', name: 'Overview' }];
  const { keyToId, absentKeys } = reconcilePageIds(pages, manifest, live);
  assert.strictEqual(keyToId.get('overview'), 'live-id');
  assert.deepStrictEqual(absentKeys, []);
});

test('reconcilePageIds: app-only page (no manifest) adopts the unique live name-match', () => {
  const { keyToId, absentKeys } = reconcilePageIds([{ key: 'overview', name: 'Overview' }], null, [{ pageId: 'live-id', name: 'Overview' }]);
  assert.strictEqual(keyToId.get('overview'), 'live-id');
  assert.deepStrictEqual(absentKeys, []);
});

test('reconcilePageIds: deleted manifest page (id absent, no name match) -> absent (create)', () => {
  const manifest = { schemaVersion: 1, pages: [{ key: 'gone', name: 'Gone', pageId: 'deleted-id' }] };
  const { keyToId, absentKeys } = reconcilePageIds([{ key: 'gone', name: 'Gone' }], manifest, []);
  assert.strictEqual(keyToId.has('gone'), false);
  assert.deepStrictEqual(absentKeys, ['gone']);
});

test('reconcilePageIds: no manifest, no live match -> absent', () => {
  const { keyToId, absentKeys } = reconcilePageIds([{ key: 'new', name: 'New' }], null, []);
  assert.strictEqual(keyToId.size, 0);
  assert.deepStrictEqual(absentKeys, ['new']);
});

test('reconcilePageIds: duplicate live names with no confirmed manifest id -> AMBIGUOUS (halt), not bound/absent (C5)', () => {
  const live = [{ pageId: 'x1', name: 'Overview' }, { pageId: 'x2', name: 'Overview' }];
  const { keyToId, absentKeys, ambiguous } = reconcilePageIds([{ key: 'overview', name: 'Overview' }], null, live);
  assert.strictEqual(keyToId.has('overview'), false);
  assert.deepStrictEqual(absentKeys, []);
  assert.strictEqual(ambiguous.length, 1);
  assert.strictEqual(ambiguous[0].name, 'Overview');
  assert.deepStrictEqual(ambiguous[0].matches.sort(), ['x1', 'x2']);
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

function manifestResourceName(appUnique) {
  return `${appUnique}_pagemanifest`;
}

// Build the manifest payload from the spec + reconciled key→pageId map. Keyed by the stable page key
// (falling back to name for a legacy page with no key). Empty/undefined optional fields are omitted so
// the serialized manifest stays minimal and diff-friendly (content-dedup depends on stable output).
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

// Parse a manifest string, FAIL-CLOSED on the FULL schema (I5): malformed JSON, an unknown
// schemaVersion, a non-array `pages`, a page missing a string key/name, a DUPLICATE key, or a malformed
// optional field all yield null so the caller reconstructs from live enumeration rather than trusting a
// corrupt/incompatible payload. Validating uniqueness here (not only in the spec loader) matters because
// the manifest is the authority that maps a stable key to a deployed id.
function parseManifest(text) {
  let m;
  try { m = JSON.parse(String(text)); } catch { return null; }
  if (!m || typeof m !== 'object' || Array.isArray(m)) return null;
  if (m.schemaVersion !== MANIFEST_SCHEMA_VERSION) return null;
  if (!Array.isArray(m.pages)) return null;
  const seen = new Set();
  for (const p of m.pages) {
    if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
    if (typeof p.key !== 'string' || !p.key) return null;
    if (typeof p.name !== 'string' || !p.name) return null;
    if (seen.has(p.key)) return null; // duplicate key — corrupt manifest; reconstruct from live state
    seen.add(p.key);
    if (p.pageId !== undefined && (typeof p.pageId !== 'string' || !p.pageId)) return null;
    if (p.dataSources !== undefined && !Array.isArray(p.dataSources)) return null;
    if (p.navigatesTo !== undefined && !Array.isArray(p.navigatesTo)) return null;
    if (p.pageInput !== undefined && (typeof p.pageInput !== 'object' || p.pageInput === null || Array.isArray(p.pageInput))) return null;
  }
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

// Reconcile the spec's declared pages against the durable manifest AND the fail-closed live enumeration
// (§7.3, §9). Authority order, highest first (C5):
//   1. manifest key→pageId — ONLY when that id is still present in the live enumeration. A confirmed
//      identity is truth even if the display name drifted, and it must NOT be overridden by a DIFFERENT
//      live page that merely shares the name (that is the exact overwrite bug C5 fixes).
//   2. exactly ONE live page with this display name — unique-name adoption / stale-imported-id fallback.
//   3. absent — needs a create (mint a fresh id).
//   4. duplicate/ambiguous live names (and no confirmed manifest id) — returned in `ambiguous`; the
//      caller HALTS. Never silently collapsed into a Map (which would pick an arbitrary page to overwrite).
// Returns { keyToId: Map<key,id>, absentKeys: [key…], ambiguous: [{ key, name, matches:[id…] }] }.
function reconcilePageIds(pages, manifest, livePages) {
  const live = livePages || [];
  const liveById = new Map(live.filter((p) => p.pageId).map((p) => [String(p.pageId).toLowerCase(), p.pageId]));
  const idsByName = new Map(); // name -> [id…], so duplicate live names are DETECTED, not collapsed
  for (const p of live) {
    if (p.name && p.pageId) { const a = idsByName.get(p.name) || []; a.push(p.pageId); idsByName.set(p.name, a); }
  }
  const manifestByKey = new Map(((manifest && manifest.pages) || []).filter((p) => p && p.key).map((p) => [p.key, p]));
  const keyToId = new Map();
  const absentKeys = [];
  const ambiguous = [];
  for (const p of pages || []) {
    const key = p.key || p.name;
    const mp = manifestByKey.get(key);
    let id = mp && mp.pageId && liveById.has(String(mp.pageId).toLowerCase()) ? liveById.get(String(mp.pageId).toLowerCase()) : undefined;
    if (!id) {
      const matches = idsByName.get(p.name) || [];
      if (matches.length > 1) { ambiguous.push({ key, name: p.name, matches: matches.slice() }); continue; } // (4) HALT
      if (matches.length === 1) id = matches[0]; // (2) unique-name adoption
    }
    if (id) keyToId.set(key, id);
    else absentKeys.push(key); // (3) create
  }
  return { keyToId, absentKeys, ambiguous };
}

module.exports = { MANIFEST_SCHEMA_VERSION, manifestResourceName, buildManifest, serializeManifest, parseManifest, parseManifestBase64, reconcilePageIds };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test scripts/tests/page-manifest.test.js`
Expected: PASS (all 13 tests).

Then the full gate: `node scripts/run-tests.js`
Expected: PASS — suite green (≈ 596).

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/page-manifest.js scripts/tests/page-manifest.test.js
git commit -m "feat(model-apps): durable page-manifest with fail-closed parse + C5 reconcile authority" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>" \
  -m "Copilot-Session: 42626da2-b66f-4162-acaa-b1127ef23d89"
```

---

## Task 3: `app-spec.js` — required page-spec validation BEFORE any write (Critical 4)

`validateAppSpec`'s page loop (`app-spec.js:474-522`) checks page names, source shape, and (v2) key presence + uniqueness, but does NOT reject **duplicate page names**, **duplicate/escaping codeFile paths**, or an **invalid key grammar** — so a spec that collides two pages, or whose `codeFile` escapes the working dir, reaches the write engine (`sdk-build.js:1037-1041` resolves an arbitrary path). Add these hard validations, which run on **every** `validateAppSpec` call site (author plan, run-1/run-2, teardown, verify) and therefore **before any write** (Critical 4, design §7.2).

**Files:**
- Modify: `scripts/lib/app-spec.js` — the page-validation loop (`:474-522`).
- Modify: `scripts/tests/app-spec.test.js` — the four rejection tests + an accept test.

**Interfaces:** no signature change (`validateAppSpec(spec, { profile }) → { ok, errors }`).

- [ ] **Step 1: Write the failing tests** — append to `scripts/tests/app-spec.test.js`

```javascript
// A minimal spec that passes everything EXCEPT the page rule under test. schemaVersion 2 so the stable
// -key rules apply; one entity so the base validation is satisfied.
function pageSpec(pages) {
  return {
    schemaVersion: 2,
    solution: { uniqueName: 'S', publisherPrefix: 'new' },
    app: { name: 'A' },
    entities: [{ schemaName: 'new_widget', primaryAttribute: { schemaName: 'new_name' }, columns: [] }],
    pages,
    appShell: { areas: [] },
  };
}

test('validateAppSpec rejects case-insensitive duplicate page names (Critical 4)', () => {
  const r = validateAppSpec(pageSpec([
    { key: 'a', name: 'Overview', source: { kind: 'tsx', codeFile: 'a.tsx' } },
    { key: 'b', name: 'overview', source: { kind: 'tsx', codeFile: 'b.tsx' } },
  ]), { profile: 'plan' });
  assert.ok(!r.ok && r.errors.some((e) => /duplicate page name/i.test(e)), r.errors.join('; '));
});

test('validateAppSpec rejects duplicate implemented codeFile paths (Critical 4)', () => {
  const r = validateAppSpec(pageSpec([
    { key: 'a', name: 'A', source: { kind: 'tsx', codeFile: 'pages/x.tsx' } },
    { key: 'b', name: 'B', source: { kind: 'tsx', codeFile: 'pages/x.tsx' } },
  ]), { profile: 'plan' });
  assert.ok(!r.ok && r.errors.some((e) => /duplicate .*codeFile|codeFile .*already/i.test(e)), r.errors.join('; '));
});

test('validateAppSpec rejects a codeFile that escapes the workspace (.. or absolute) (Critical 4)', () => {
  for (const bad of ['../evil.tsx', '/etc/evil.tsx', 'C:/evil.tsx', 'a/../../evil.tsx']) {
    const r = validateAppSpec(pageSpec([{ key: 'a', name: 'A', source: { kind: 'tsx', codeFile: bad } }]), { profile: 'plan' });
    assert.ok(!r.ok && r.errors.some((e) => /codeFile.*(outside|escape|confin|absolute|\.\.)/i.test(e)), `${bad}: ${r.errors.join('; ')}`);
  }
});

test('validateAppSpec rejects an invalid stable key grammar (Critical 4)', () => {
  for (const bad of ['Overview', 'wo_detail', '-lead', 'lead-', 'a b']) {
    const r = validateAppSpec(pageSpec([{ key: bad, name: 'A', source: { kind: 'tsx', codeFile: 'a.tsx' } }]), { profile: 'plan' });
    assert.ok(!r.ok && r.errors.some((e) => /key.*grammar|invalid.*key|key '/i.test(e)), `${bad}: ${r.errors.join('; ')}`);
  }
});

test('validateAppSpec accepts a unique-name, confined-path, well-keyed page set', () => {
  const r = validateAppSpec(pageSpec([
    { key: 'overview', name: 'Overview', source: { kind: 'tsx', codeFile: 'overview.tsx' } },
    { key: 'wo-detail', name: 'WO Detail', navigatesTo: [{ targetKey: 'overview' }], source: { kind: 'tsx', codeFile: 'pages/wo-detail.tsx' } },
  ]), { profile: 'deploy' });
  assert.ok(r.ok, r.errors.join('; '));
});
```

- [ ] **Step 2: Run to verify failure** — `node --test scripts/tests/app-spec.test.js` → FAIL (no such rejections yet).

- [ ] **Step 3: Extend the page-validation loop in `scripts/lib/app-spec.js`**

Just before the page loop (near `:471-473`, where `isV2`/`pageKeysSet`/`pageNamesSet` are declared) add the trackers, the key grammar, and a pure confinement helper:

```javascript
  // Stable-key grammar (schemaVersion 2): a lowercase slug — alphanumerics + internal single hyphens,
  // no leading/trailing hyphen, no underscores/spaces/uppercase. migrateAppSpec mints keys via slugify
  // (:686), which always conforms; a hand-authored v2 key must too, since the key is the cross-reference
  // identity (navigatesTo.targetKey / PAGEREF_<key> / appShell page subareas).
  const PAGE_KEY_GRAMMAR = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
  const pageNamesLower = new Set();   // case-insensitive name-uniqueness (Critical 4)
  const pageCodeFilesLower = new Set(); // implemented-page codeFile path uniqueness (Critical 4)
  // A codeFile must resolve INSIDE the working dir — reject an absolute path or any `..` segment (either
  // escapes the app folder, and sdk-build resolves it with path.resolve(appDir, codeFile) at :1037-1041).
  // Pure string check (no path import / no platform normalize needed): '/', a drive-letter root, or a '..'
  // path segment are all rejects. Design §7.2.
  const codeFileConfined = (codeFile) => {
    const cf = String(codeFile).replace(/\\/g, '/');
    if (!cf || cf.startsWith('/') || /^[a-zA-Z]:\//.test(cf)) return false;
    return !cf.split('/').some((seg) => seg === '..');
  };
```

Inside the page loop, after `pageNamesSet.add(p.name);` (`:476`), add the case-insensitive name-uniqueness check:

```javascript
    const nameLower = String(p.name).toLowerCase();
    if (pageNamesLower.has(nameLower)) errors.push(`duplicate page name '${p.name}' (page names must be unique, case-insensitive)`);
    else pageNamesLower.add(nameLower);
```

Inside the loop, right after `const src = normalizePageSource(p);` (`:477`), add the codeFile confinement + path-uniqueness checks (only for an implemented tsx page):

```javascript
    if (src && src.kind === 'tsx' && typeof src.codeFile === 'string' && src.codeFile) {
      if (!codeFileConfined(src.codeFile)) {
        errors.push(`page '${p.key || p.name}': codeFile '${src.codeFile}' must be a workspace-confined relative path (no '..' escape, no absolute path)`);
      }
      const cfLower = src.codeFile.replace(/\\/g, '/').toLowerCase();
      if (pageCodeFilesLower.has(cfLower)) errors.push(`page '${p.key || p.name}': duplicate codeFile '${src.codeFile}' (another page already uses it)`);
      else pageCodeFilesLower.add(cfLower);
    }
```

Inside the `if (isV2)` key block (`:502-506`), add the grammar check as the first key validation (so a non-string/empty key still reports the existing message, and a present-but-malformed key reports the grammar error):

```javascript
    if (isV2) {
      if (!p.key || typeof p.key !== 'string') errors.push(`page '${p.name}': needs a stable key (schemaVersion 2)`);
      else if (!PAGE_KEY_GRAMMAR.test(p.key)) errors.push(`page '${p.name}': key '${p.key}' has an invalid key grammar (lowercase slug: ^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$)`);
      else if (pageKeysSet.has(p.key)) errors.push(`duplicate page key '${p.key}'`);
      else pageKeysSet.add(p.key);
    }
```

- [ ] **Step 4: Run the tests + full suite**

Run: `node --test scripts/tests/app-spec.test.js scripts/tests/app-spec-keys.test.js scripts/tests/app-spec-profiles.test.js scripts/tests/app-spec-migrate.test.js`
Expected: PASS — the new rejections + accept pass; the existing profile/key/migrate tests stay green (migrated specs slugify to conforming keys, so the grammar rule never rejects them).

Then: `node scripts/run-tests.js`
Expected: PASS — suite green (≈ 601).

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/app-spec.js scripts/tests/app-spec.test.js
git commit -m "feat(model-apps): required page-spec validation (name/path uniqueness, confinement, key grammar)" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>" \
  -m "Copilot-Session: 42626da2-b66f-4162-acaa-b1127ef23d89"
```

---

## Task 4: `genpage-cli.js` — tri-state fail-closed `enumerate` validating the COMPLETE listing (I2) + safe uncertain-CREATE retry (C3)

Two tightly-coupled `genpage-cli.js` fixes: (a) an `enumerate` that distinguishes a real empty app from an unreadable/**incomplete** listing — it accepts a zero-exit output only when **every** listed page has a name **and** the parsed page count equals the summary "Found N page(s)" count; and (b) an `upload` whose CREATE retry can never duplicate a page a possibly-successful first attempt already created.

**Files:**
- Modify: `scripts/lib/genpage-cli.js` — add `parseListCount` + `classifyListOutput`; add `enumerate` (fail-closed, tri-state, retrying); rewrite `upload`'s CREATE-retry reconcile to use fail-closed enumeration.
- Modify: `scripts/tests/genpage-cli.test.js` — add `classifyListOutput` + `enumerate` + uncertain-CREATE tests; **update the two existing CREATE-retry tests** (`:91-103`, `:105-109`) to the fail-closed behavior + the real "Found N" summary format.

**Interfaces:**
- Produces:
  - `parseListCount(stdout) → number | null` — the integer from `Found N generated page(s)` (the summary line), else `null`.
  - `classifyListOutput(stdout) → { kind: 'pages'|'empty'|'unrecognized', pages }` — a zero-exit output is `pages` only when ≥1 page parsed, EVERY page has a name, and `pages.length === parseListCount`; `empty` on an explicit no-pages / "Found 0" marker; else `unrecognized`.
  - `genpageCli.enumerate({ appId }) → { ok, pages, empty?, error? }` — retries; `{ ok:false }` on a persistent non-zero exit OR a persistent `unrecognized` zero-exit; `{ ok:true, pages, empty }` otherwise.
  - `genpageCli.upload(...)` — on an **uncertain CREATE** (non-zero, or zero-exit with no Page ID) re-enumerates **fail-closed**: enumeration failure → throw (never a blind 2nd CREATE); exactly one same-named live page → adopt it (retry UPDATEs in place); multiple → throw (ambiguous); zero → safe to retry CREATE.

- [ ] **Step 1: Write / update the tests** — `scripts/tests/genpage-cli.test.js`

Extend the top-of-file require and add a real-output fixture constant:

```javascript
// :4 — add classifyListOutput + parseListCount to the destructure:
const { makeGenpageCli, parsePageId, parseList, quoteArg, buildPacInvocation, classifyListOutput, parseListCount } = require('../lib/genpage-cli.js');

// Real `pac model genpage list` shapes (confirm against a live run; the parseList test at :48-54 already
// uses the "Found N generated page(s):" header — enumerate now VALIDATES that count). CONFIRM the empty
// phrasing against a real run and adjust the regex if pac differs; any unmatched zero-exit output is
// (correctly) fail-closed 'unrecognized'.
const LIST_ONE = `Found 1 generated page(s):\n\n  Overview\n    Page ID: ${GUID}\n    Description: Created 2026-07-07\n`;
const LIST_EMPTY = 'Found 0 generated page(s):\n';
```

Add the classifier + enumerate + uncertain-CREATE tests:

```javascript
test('parseListCount reads the summary "Found N generated page(s)" count (else null)', () => {
  assert.strictEqual(parseListCount(LIST_ONE), 1);
  assert.strictEqual(parseListCount(LIST_EMPTY), 0);
  assert.strictEqual(parseListCount('  Overview\n    Page ID: abc'), null);
});

test('classifyListOutput: pages / empty / unrecognized (tri-state, COMPLETE-listing, I2)', () => {
  assert.strictEqual(classifyListOutput(LIST_ONE).kind, 'pages');
  assert.strictEqual(classifyListOutput(LIST_EMPTY).kind, 'empty');
  assert.strictEqual(classifyListOutput('No generated pages found.\n').kind, 'empty');
  assert.strictEqual(classifyListOutput('').kind, 'unrecognized');
  assert.strictEqual(classifyListOutput('pac model genpage list\nUsage: pac model genpage ...\n').kind, 'unrecognized');
  // count mismatch (truncated listing): summary says 3 but only 1 Page ID parsed → fail-closed.
  assert.strictEqual(classifyListOutput(`Found 3 generated page(s):\n\n  Overview\n    Page ID: ${GUID}\n`).kind, 'unrecognized');
  // an UNNAMED page (a Page ID with no preceding name line) → fail-closed (would else reconcile blindly).
  assert.strictEqual(classifyListOutput(`Found 1 generated page(s):\n    Page ID: ${GUID}\n`).kind, 'unrecognized');
});

test('enumerate returns { ok:true, pages } on a COMPLETE zero-exit list (no retry on success)', async () => {
  let n = 0;
  const cli = makeGenpageCli('env', { run: async () => { n += 1; return { status: 0, stdout: LIST_ONE, stderr: '' }; }, sleep: async () => {}, attempts: 3 });
  const r = await cli.enumerate({ appId: 'app-1' });
  assert.deepStrictEqual(r.pages, [{ pageId: GUID, name: 'Overview' }]);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(n, 1);
});

test('enumerate returns { ok:true, pages:[], empty:true } for an app that genuinely has no pages', async () => {
  const cli = makeGenpageCli('env', { run: async () => ({ status: 0, stdout: LIST_EMPTY, stderr: '' }), sleep: async () => {}, attempts: 3 });
  const r = await cli.enumerate({ appId: 'app-1' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.empty, true);
  assert.deepStrictEqual(r.pages, []);
});

test('enumerate is fail-closed on a zero-exit UNRECOGNIZED / INCOMPLETE listing (blank/help/count-mismatch) — NOT empty (I2)', async () => {
  const cli = makeGenpageCli('env', { run: async () => ({ status: 0, stdout: `Found 2 generated page(s):\n\n  Overview\n    Page ID: ${GUID}\n`, stderr: '' }), sleep: async () => {}, attempts: 2 });
  const r = await cli.enumerate({ appId: 'app-1' });
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(r.pages, []);
  assert.match(r.error, /unrecognized|incomplete/i);
});

test('enumerate is fail-closed on a persistent non-zero exit, after retrying', async () => {
  let n = 0;
  const cli = makeGenpageCli('env', { run: async () => { n += 1; return { status: 1, stdout: '', stderr: 'auth expired' }; }, sleep: async () => {}, attempts: 3 });
  const r = await cli.enumerate({ appId: 'app-1' });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /after 3 attempt\(s\)/);
  assert.strictEqual(n, 3);
});

test('enumerate recovers on a later attempt (transient flake)', async () => {
  let n = 0;
  const cli = makeGenpageCli('env', { run: async () => { n += 1; return n < 2 ? { status: 1, stdout: '', stderr: 'flake' } : { status: 0, stdout: LIST_ONE, stderr: '' }; }, sleep: async () => {}, attempts: 3 });
  const r = await cli.enumerate({ appId: 'app-1' });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.pages, [{ pageId: GUID, name: 'Overview' }]);
  assert.strictEqual(n, 2);
});

test('upload: a possibly-successful CREATE + a failing enumeration NEVER issues a 2nd CREATE (C3)', async () => {
  let creates = 0;
  let lists = 0;
  const run = async (args) => {
    if (args.includes('upload')) { creates += 1; return { status: 0, stdout: 'done, no id here', stderr: '' }; } // zero-exit, NO Page ID → uncertain
    lists += 1; return { status: 1, stdout: '', stderr: 'list failed' }; // enumeration fails
  };
  const cli = makeGenpageCli('env', { run, sleep: async () => {}, attempts: 3 });
  await assert.rejects(cli.upload({ appId: 'app-1', codeFile: 'x.tsx', name: 'Overview' }), /uncertain result and page enumeration failed|refusing to retry/i);
  assert.strictEqual(creates, 1, 'exactly ONE create attempt — no blind duplicate');
  assert.ok(lists >= 1, 'it did try to enumerate before deciding');
});

test('upload: an uncertain CREATE adopts the one same-named live page and UPDATES it (no duplicate)', async () => {
  let creates = 0, updates = 0;
  const run = async (args) => {
    if (args.includes('upload')) {
      if (args.includes('--page-id')) { updates += 1; return { status: 0, stdout: `Page ID: ${GUID}`, stderr: '' }; }
      creates += 1; return { status: 0, stdout: 'no id', stderr: '' }; // uncertain create
    }
    return { status: 0, stdout: LIST_ONE, stderr: '' }; // enumeration: the create DID land as "Overview"
  };
  const cli = makeGenpageCli('env', { run, sleep: async () => {}, attempts: 3 });
  const r = await cli.upload({ appId: 'app-1', codeFile: 'x.tsx', name: 'Overview' });
  assert.strictEqual(r.pageId, GUID);
  assert.strictEqual(creates, 1, 'one create attempt');
  assert.strictEqual(updates, 1, 'retry UPDATED the adopted page in place — no second create');
});

test('upload: an uncertain CREATE whose enumeration shows ZERO matches safely retries the CREATE', async () => {
  let creates = 0;
  const run = async (args) => {
    if (args.includes('upload')) { creates += 1; return creates === 1 ? { status: 0, stdout: 'no id', stderr: '' } : { status: 0, stdout: `Page ID: ${GUID}`, stderr: '' }; }
    return { status: 0, stdout: LIST_EMPTY, stderr: '' }; // enumeration proves the create did NOT land
  };
  const cli = makeGenpageCli('env', { run, sleep: async () => {}, attempts: 3 });
  const r = await cli.upload({ appId: 'app-1', codeFile: 'x.tsx', name: 'Overview' });
  assert.strictEqual(r.pageId, GUID);
  assert.strictEqual(creates, 2, 'zero live matches → the retry re-issues a CREATE (not a duplicate — none existed)');
});
```

**Update the two existing CREATE-retry tests** to the fail-closed behavior + the summary format:

```javascript
// REPLACE :91-103 — the list mock must be a COMPLETE listing (add the "Found N" summary) so enumerate
// recognizes it; behavior is otherwise unchanged (adopt the matched page as an UPDATE).
test('upload converts a failed CREATE to an UPDATE on retry (resolve by name, no duplicate)', async () => {
  const uploadArgs = [];
  let up = 0;
  const run = async (args) => {
    if (args[2] === 'list') return { status: 0, stdout: `Found 1 generated page(s):\n\n  Overview\n    Page ID: ${GUID}\n`, stderr: '' };
    up += 1; uploadArgs.push(args);
    return up === 1 ? { status: 1, stdout: '', stderr: 'flaky' } : { status: 0, stdout: `Page ID: ${GUID}`, stderr: '' };
  };
  const r = await makeGenpageCli('https://x', { run, sleep: async () => {} }).upload({ appId: 'a', codeFile: 'o.tsx', name: 'Overview' });
  assert.strictEqual(r.pageId, GUID);
  assert.ok(!uploadArgs[0].includes('--page-id'), 'first attempt was a create (no page-id)');
  assert.ok(uploadArgs[1].includes('--page-id') && uploadArgs[1].includes(GUID), 'retry updates in place via the resolved page id (never duplicates)');
});

// REPLACE :105-109 — a persistent pac failure where enumeration ALSO fails is now FAIL-CLOSED: the first
// uncertain CREATE + failed enumeration THROWS (refusing to retry) rather than blindly retrying 3×.
test('upload is fail-closed when a CREATE is uncertain and enumeration cannot run (no blind retry)', async () => {
  let creates = 0;
  const run = async (args) => { if (args[2] === 'list') return { status: 1, stdout: '', stderr: '' }; creates += 1; return { status: 1, stdout: '', stderr: 'boom' }; };
  await assert.rejects(makeGenpageCli('https://x', { run, sleep: async () => {} }).upload({ appId: 'a', codeFile: 'o.tsx', name: 'X' }), /uncertain result and page enumeration failed|refusing to retry/i);
  assert.strictEqual(creates, 1, 'exactly one create attempt — never a blind duplicate on an unverifiable failure');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test scripts/tests/genpage-cli.test.js`
Expected: FAIL — `classifyListOutput`/`parseListCount`/`cli.enumerate` are not exported/functions; the updated C3 tests fail (today's retry uses fail-open `listPages` + no count validation).

- [ ] **Step 3: Implement `parseListCount` + `classifyListOutput` + `enumerate` + the safe CREATE retry**

(a) Add `parseListCount` + `classifyListOutput` next to `parseList` (`:59`):

```javascript
// The summary count pac prints, e.g. "Found 3 generated page(s):" / "Found 0 generated page(s):".
// Returns the integer, or null when absent. parseList skips the "Found …" line as metadata (:56); this
// reads its N so enumerate can prove the listing is COMPLETE (parsed page count == N).
function parseListCount(stdout) {
  const m = /found\s+(\d+)\s+(?:generated\s+)?page/i.exec(String(stdout || ''));
  return m ? Number(m[1]) : null;
}

// Classify a ZERO-EXIT `pac model genpage list` stdout (design §9 / I2). A zero exit alone is NOT proof
// of a valid listing: a changed format, a blank result, a help banner (pac dumps usage on a flag error
// yet exits 0 on some builds), a TRUNCATED listing (fewer Page IDs than the summary count), or an UNNAMED
// page would all mis-read as pages/empty and drive duplicate creation or a blind reconcile. Fail-closed:
//   'pages'        — >=1 "Page ID" parsed, EVERY page has a name, AND the parsed count == the summary
//                    "Found N page(s)" count (a COMPLETE, authoritative listing).
//   'empty'        — an EXPLICIT no-pages / "Found 0" marker (only then is [] trustworthy).
//   'unrecognized' — anything else → the caller treats it as FAILURE, never as empty.
// Confirm the exact 'Found N generated page(s)' + no-pages phrasing against a real pac run before relying
// on a new format; any unmatched zero-exit output is (correctly) fail-closed.
function classifyListOutput(stdout) {
  const s = String(stdout || '');
  const count = parseListCount(s);
  if (count === 0 || /\bno\s+(?:generated\s+)?pages?\b/i.test(s)) return { kind: 'empty', pages: [] };
  const pages = parseList(s);
  const allNamed = pages.length > 0 && pages.every((p) => p.name && String(p.name).trim());
  if (allNamed && count !== null && count === pages.length) return { kind: 'pages', pages };
  return { kind: 'unrecognized', pages: [] };
}
```

(b) Add a fail-closed enumerator inside `makeGenpageCli` (after `listPages`, `:71`), used by BOTH the exposed `enumerate` and `upload`'s retry:

```javascript
  // Fail-closed page enumeration (design §9). Retries (pac genpage list flakes with transient help-dumps)
  // and returns { ok:false } on a persistent non-zero exit OR a persistent zero-exit UNRECOGNIZED/INCOMPLETE
  // output — DISTINCT from { ok:true, pages:[], empty:true } for an app that truly has no pages. Never lets
  // an unreadable/partial listing masquerade as "no pages" (which would re-create every page and orphan the
  // originals).
  async function enumeratePages(appId) {
    let lastErr = '';
    for (let i = 0; i < attempts; i += 1) {
      const r = await run(['model', 'genpage', 'list', '--environment', env, '--app-id', appId]);
      if (r.status === 0) {
        const c = classifyListOutput(r.stdout);
        if (c.kind !== 'unrecognized') return { ok: true, pages: c.pages, empty: c.kind === 'empty' };
        lastErr = 'unrecognized/incomplete `pac genpage list` output (zero exit, no valid page listing or a count mismatch) — refusing to treat as empty';
      } else {
        lastErr = lastLine(r);
      }
      if (i < attempts - 1) await sleep(500 * (i + 1));
    }
    return { ok: false, pages: [], error: `pac genpage list failed after ${attempts} attempt(s): ${lastErr}` };
  }
```

(c) Expose it on the returned object (after `list({ appId })`, `:107-109`):

```javascript
    enumerate({ appId }) {
      return enumeratePages(appId);
    },
```

(d) Replace `upload`'s fail-open CREATE-retry reconcile (`:99-102`) with a fail-closed one:

```javascript
        // Uncertain outcome. If this was a CREATE (no pid yet), the create may ALREADY have landed
        // server-side, so a blind retry could DUPLICATE it (design §9, C3). Re-enumerate FAIL-CLOSED:
        //  - enumeration failure → THROW (never retry blind — a duplicate is worse than a hard stop).
        //  - exactly one same-named live page → adopt it (the create landed; the retry UPDATES in place).
        //  - multiple → THROW (ambiguous — refuse to add another).
        //  - zero → the create did NOT land; safe to retry a CREATE (pid stays undefined).
        if (!pid && name) {
          const listed = await enumeratePages(appId);
          if (!listed.ok) throw new Error(`pac genpage upload for '${name}' had an uncertain result and page enumeration failed — refusing to retry (would risk a duplicate): ${listed.error}`);
          const matches = listed.pages.filter((p) => p.name === name);
          if (matches.length > 1) throw new Error(`pac genpage upload for '${name}': multiple live pages already share this name — refusing to create another (ambiguous)`);
          if (matches.length === 1) pid = matches[0].pageId;
        }
```

(e) Export `classifyListOutput` + `parseListCount` (module.exports, `:119`).

- [ ] **Step 4: Run the tests + full suite**

Run: `node --test scripts/tests/genpage-cli.test.js`
Expected: PASS.

Then: `node scripts/run-tests.js`
Expected: PASS — suite green (≈ 612).

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/genpage-cli.js scripts/tests/genpage-cli.test.js
git commit -m "feat(model-apps): fail-closed genpage enumerate (complete-listing) + safe uncertain-create retry" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>" \
  -m "Copilot-Session: 42626da2-b66f-4162-acaa-b1127ef23d89"
```

---

## Task 5: Engine plumbing — manifest lifecycle (persist-after-each-create), key-by-KEY, surface, planFor, real fixtures

Makes the pages phase discover-reconcile-safe **without** the PAGEREF_ protocol yet (Task 8 adds scan/parity/create-absent-first/staging/lease): fail-closed enumerate → manifest seed/reconcile (+ ambiguous HALT) → **key-by-KEY** upload loop with the I7 update-identity guard → **manifest persisted immediately after each page create** (content-deduped) → finalize. Adds the `updateWebResource` surface entry and `planFor` alignment. Because Task 8 makes the pages phase **read canonical source from disk**, this task also **stages real `.tsx` fixtures** for every pages-phase test so a later scan never ENOENTs.

**Files:**
- Modify: `scripts/lib/sdk-build.js` — require `page-manifest.js`; `readPageManifest` + `persistPageManifest` helpers (after `ensureAppIcon`, `:461`); the pages phase (`:1064-1097`); `planFor` (`:279-280`).
- Modify: `scripts/tests/sdk-surface-contract.test.js` (add `'updateWebResource'`).
- Modify: `scripts/tests/sdk-build.test.js` — import `appUniqueName`; manifest query branch + `updateWebResource` in `mockSdk`; a `stagePages` fixture helper; add `enumerate` to genpageCli mocks; convert the existing pages tests to real fixtures; new integration tests.
- Modify: `scripts/tests/sdk-build-pages-migrate.test.js` — add `enumerate` to the three genpageCli mocks; stage real `.tsx` for the two implemented-page tests.

**Interfaces:**
- Consumes: `enumerate` (Task 4); `manifestResourceName`/`buildManifest`/`serializeManifest`/`parseManifestBase64`/`reconcilePageIds` (Task 2); `normalizePageSource` (`app-spec.js`); `appUniqueName`/`COMPONENT_TYPE`/`appDef`/`appHasPageSubareas`/`BuildHalt`/`odataLit`/`requireSuccessfulPush` (in-module).
- Produces:
  - `readPageManifest(provision, appUnique) → { id, manifest, text }` — `text` is the decoded serialized content (for persist dedup).
  - `persistPageManifest(provision, spec, keyToId, sol, appUnique, existingId, lastContent) → { id, content }` — content-deduped write; always re-asserts solution membership (idempotent). **Stable 7-arg signature across Tasks 5 and 8.**
  - `result.created.pages` keyed by `p.key || p.name`; new HALT codes `pages-requires-app`, `pages-enumeration-failed`, `pages-ambiguous-name`, `pages-update-identity-mismatch`.
  - `SKILL_SDK_SURFACE` includes `updateWebResource`.

- [ ] **Step 1: Update the shared mocks + fixture helper** — so the phase rewrite doesn't break green tests

In `scripts/tests/sdk-build.test.js`: import `appUniqueName` (`:4`); add fs/os/path requires + a `stagePages` helper near the top; add the manifest query branch (replace `:59`); add `updateWebResource` (after `createWebResource`, `:106`):

```javascript
// :4 — add appUniqueName:
const { runSdkBuild, planFor, resolvePhases, compileFormIntent, formFieldLogicals, viewDef, appDef, defaultViewColumns, enrichesDefaultViews, artifactIdentityQuery, dashboardTileOpts, PHASES, appUniqueName } = require('../lib/sdk-build.js');

// near the top-of-file requires (add if not present):
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Stage a fresh temp appDir with a minimal valid .tsx for each IMPLEMENTED page. Task 8's pages-phase
// scan READS canonical source from disk, so any pages-phase test must have real files (not a bare
// 'o.tsx' string). Optional `bodyByCodeFile` overrides a page's source (e.g. to inject navigation).
function stagePages(pages, bodyByCodeFile = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdkb-pages-'));
  for (const p of pages || []) {
    const cf = (p.source && p.source.codeFile) || p.codeFile;
    if (!cf) continue;
    const f = path.join(dir, cf);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, bodyByCodeFile[cf] || 'export default function P(){ return null; }', 'utf8');
  }
  return dir;
}

// :59 — replace the single webresource line. content is base64 (Dataverse webresource.content); the
// manifest branch is opt-in (opts.pageManifest) so existing existingWebResource tests are unaffected:
      if (e === 'webresource') {
        if (/_pagemanifest'/.test(filter)) return opts.pageManifest ? [{ webresourceid: opts.manifestId || 'wr-manifest', content: opts.pageManifest }] : [];
        return opts.existingWebResource ? [{ webresourceid: 'wr-existing' }] : [];
      }

// :106 — after createWebResource:
    updateWebResource: async (id, o) => { calls.push({ name: 'updateWebResource', args: [id, o] }); return {}; },
```

> `mockSdk`'s `queryRecords` receives `(e, o)`; the manifest branch reads `filter = (o && o.filter) || ''`. If the current mock doesn't already destructure `filter`, add `const filter = (o && o.filter) || '';` at the top of the `queryRecords` mock (some sibling mocks already do).

Add `enumerate` to the three genpageCli mocks (`:980` / `:996` / `:1009`) AND convert those existing pages tests to real fixtures. Replace the three tests (`:974-1012`) with:

```javascript
test('pages phase uploads each page (no --add-to-sitemap) then finalizes the sitemap with GenPage subareas', async () => {
  const spec = makeSpec();
  spec.pages = [{ name: 'Overview', codeFile: 'o.tsx', prompt: 'kpis', dataSources: ['new_customer'] }];
  spec.appShell.areas[0].groups[0].subAreas.push({ page: 'Overview', title: 'Overview' });
  const appDir = stagePages(spec.pages);
  try {
    const { sdk, calls } = mockSdk();
    const uploads = [];
    const genpageCli = { list: async () => [], enumerate: async () => ({ ok: true, pages: [], empty: true }), upload: async (o) => { uploads.push(o); return { pageId: 'gp-1' }; } };
    await runSdkBuild(spec, { sdk, apply: true, env: 'https://x', appDir, genpageCli, phases: ['solution', 'data-model', 'app-shell', 'pages'] });
    assert.strictEqual(uploads.length, 1, 'one page uploaded');
    const setDef = find(calls, 'updateElement').find((c) => c.args[2] === '/siteMap');
    assert.ok(setDef.args[3].areas[0].groups[0].subAreas.some((s) => s.type === 'GenPage' && s.genPageId === 'gp-1'), 'GenPage subarea in the finalized sitemap');
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

test('app-shell creates the app WITHOUT unbuilt page subareas (app_early ordering)', async () => {
  const spec = makeSpec();
  spec.pages = [{ name: 'Overview', codeFile: 'o.tsx' }];
  spec.appShell.areas[0].groups[0].subAreas.push({ page: 'Overview', title: 'Overview' });
  const appDir = stagePages(spec.pages);
  try {
    const { sdk, calls } = mockSdk();
    const genpageCli = { list: async () => [], enumerate: async () => ({ ok: true, pages: [], empty: true }), upload: async () => ({ pageId: 'gp-1' }) };
    await runSdkBuild(spec, { sdk, apply: true, env: 'https://x', appDir, genpageCli, phases: ['solution', 'data-model', 'app-shell', 'pages'] });
    const appCreate = find(calls, 'createArtifact').find((c) => c.args[0] === 'app');
    assert.ok(!appCreate.args[1].siteMap.areas[0].groups[0].subAreas.some((s) => s.type === 'GenPage'), 'no GenPage subarea at app-create time');
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

test('pages phase updates an existing page in place (matched by name -> --page-id)', async () => {
  const spec = makeSpec();
  spec.pages = [{ name: 'Overview', codeFile: 'o.tsx' }];
  const appDir = stagePages(spec.pages);
  try {
    const { sdk } = mockSdk();
    const uploads = [];
    const live = [{ pageId: 'gp-existing', name: 'Overview' }];
    const genpageCli = { list: async () => live, enumerate: async () => ({ ok: true, pages: live }), upload: async (o) => { uploads.push(o); return { pageId: 'gp-existing' }; } };
    await runSdkBuild(spec, { sdk, apply: true, env: 'https://x', appDir, genpageCli, phases: ['solution', 'data-model', 'app-shell', 'pages'] });
    assert.strictEqual(uploads[0].pageId, 'gp-existing', 'existing page updated via --page-id, not duplicated');
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});
```

In `scripts/tests/sdk-build-pages-migrate.test.js`, add `enumerate: async () => ({ ok: true, pages: [], empty: true }),` to each of the three genpageCli mocks (`:90`, `:120`, `:148`), and for the **two implemented-page tests** (`:78-109`, `:112-137`) stage a real fixture: add `const fs = require('node:fs'); const os = require('node:os');` at the top, then replace `appDir: process.cwd()` with a staged temp dir written for the page's codeFile, wrapping the `runSdkBuild` call in a `try/finally` that `fs.rmSync`es it, e.g.:

```javascript
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-pages-'));
  fs.writeFileSync(path.join(appDir, 'overview.tsx'), 'export default function O(){ return null; }', 'utf8');
  try {
    await assert.doesNotReject(runSdkBuild(migrated, { sdk, apply: true, env: 'https://x.dynamics.com', appDir, genpageCli, phases: ['solution', 'data-model', 'app-shell', 'pages'] }));
    assert.strictEqual(uploads.length, 1);
    assert.ok(uploads[0].codeFile.endsWith('overview.tsx') || uploads[0].codeFile.endsWith(path.sep + 'overview.tsx'));
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
```

(The `intent page is skipped` test at `:140` reads no file — only add `enumerate` to its mock.)

- [ ] **Step 2: Write the failing integration tests** — append to `scripts/tests/sdk-build.test.js`

```javascript
test('pages phase (v2, page key != name): result.created.pages is keyed by KEY so the sitemap finalize resolves', async () => {
  const spec = makeSpec();
  spec.schemaVersion = 2;
  spec.pages = [{ key: 'overview', name: 'Overview', source: { kind: 'tsx', codeFile: 'o.tsx' } }];
  spec.appShell.areas[0].groups[0].subAreas.push({ page: 'overview', title: 'Overview' });
  const appDir = stagePages(spec.pages);
  try {
    const { sdk, calls } = mockSdk();
    const genpageCli = { list: async () => [], enumerate: async () => ({ ok: true, pages: [], empty: true }), upload: async () => ({ pageId: 'gp-1' }) };
    await runSdkBuild(spec, { sdk, apply: true, env: 'https://x', appDir, genpageCli, phases: ['solution', 'data-model', 'app-shell', 'pages'] });
    const setDef = find(calls, 'updateElement').find((c) => c.args[2] === '/siteMap');
    assert.ok(setDef.args[3].areas[0].groups[0].subAreas.some((s) => s.type === 'GenPage' && s.genPageId === 'gp-1'), 'GenPage subarea resolved by KEY (was unresolved when keyed by name)');
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

test('pages phase persists the manifest on a SINGLE-page first build (one create, type js, add-to-solution, ZERO update)', async () => {
  const spec = makeSpec();
  spec.pages = [{ name: 'Overview', codeFile: 'o.tsx' }];
  const appDir = stagePages(spec.pages);
  try {
    const { sdk, calls } = mockSdk();
    const genpageCli = { list: async () => [], enumerate: async () => ({ ok: true, pages: [], empty: true }), upload: async () => ({ pageId: 'gp-1' }) };
    await runSdkBuild(spec, { sdk, apply: true, env: 'https://x', appDir, genpageCli, phases: ['solution', 'data-model', 'app-shell', 'pages'] });
    const created = find(calls, 'createWebResource').map((c) => c.args[0]).find((o) => /_pagemanifest$/.test(o.name));
    assert.strictEqual(created.type, 'js');
    assert.deepStrictEqual(JSON.parse(created.content).pages[0], { key: 'Overview', name: 'Overview', pageId: 'gp-1' });
    assert.strictEqual(find(calls, 'updateWebResource').length, 0, 'one create writes the final content; the final persist is deduped → ZERO updates (I6)');
    assert.ok(find(calls, 'addSolutionComponent').some((c) => c.args[0].componentType === 61), 'manifest added to the solution');
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

test('pages phase persists the manifest per-create on a MULTI-page first build (one create + one update, I6)', async () => {
  const spec = makeSpec();
  spec.pages = [{ name: 'Overview', codeFile: 'o.tsx' }, { name: 'Detail', codeFile: 'd.tsx' }];
  const appDir = stagePages(spec.pages);
  try {
    const { sdk, calls } = mockSdk();
    const genpageCli = { list: async () => [], enumerate: async () => ({ ok: true, pages: [], empty: true }), upload: async (o) => ({ pageId: o.name === 'Detail' ? 'gp-d' : 'gp-o' }) };
    await runSdkBuild(spec, { sdk, apply: true, env: 'https://x', appDir, genpageCli, phases: ['solution', 'data-model', 'app-shell', 'pages'] });
    assert.strictEqual(find(calls, 'createWebResource').filter((c) => /_pagemanifest$/.test(c.args[0].name)).length, 1, 'manifest created once (first mint)');
    assert.strictEqual(find(calls, 'updateWebResource').length, 1, 'the second mint UPDATES the manifest in place (immediate persist-after-each-create)');
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

test('pages phase updates the manifest IN PLACE on a rebuild whose page ids changed (no dup create)', async () => {
  const spec = makeSpec();
  spec.pages = [{ name: 'Overview', codeFile: 'o.tsx' }, { name: 'Detail', codeFile: 'd.tsx' }];
  const appDir = stagePages(spec.pages);
  try {
    const existing = Buffer.from(JSON.stringify({ schemaVersion: 1, pages: [{ key: 'Overview', name: 'Overview', pageId: 'gp-o' }] }), 'utf8').toString('base64');
    const { sdk, calls } = mockSdk({ pageManifest: existing, manifestId: 'wr-manifest' });
    const live = [{ pageId: 'gp-o', name: 'Overview' }];
    const genpageCli = { list: async () => live, enumerate: async () => ({ ok: true, pages: live }), upload: async (o) => ({ pageId: o.pageId || 'gp-d' }) };
    await runSdkBuild(spec, { sdk, apply: true, env: 'https://x', appDir, genpageCli, phases: ['solution', 'data-model', 'app-shell', 'pages'] });
    assert.ok(!find(calls, 'createWebResource').some((c) => /_pagemanifest$/.test(c.args[0].name)), 'manifest not re-created on rebuild');
    assert.ok(find(calls, 'updateWebResource').some((c) => c.args[0] === 'wr-manifest'), 'manifest updated in place');
    assert.ok(find(calls, 'addSolutionComponent').some((c) => c.args[0].componentType === 61), 'solution membership re-asserted every run');
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

test('pages phase HALTS fail-closed when enumeration fails — never treats it as empty, uploads nothing', async () => {
  const spec = makeSpec();
  spec.pages = [{ name: 'Overview', codeFile: 'o.tsx' }];
  const appDir = stagePages(spec.pages);
  try {
    const { sdk } = mockSdk();
    let uploaded = 0;
    const genpageCli = { list: async () => [], enumerate: async () => ({ ok: false, pages: [], error: 'auth expired' }), upload: async () => { uploaded += 1; return { pageId: 'gp-1' }; } };
    await assert.rejects(
      runSdkBuild(spec, { sdk, apply: true, env: 'https://x', appDir, genpageCli, phases: ['solution', 'data-model', 'app-shell', 'pages'] }),
      (e) => e && e.phase === 'pages' && e.code === 'pages-enumeration-failed'
    );
    assert.strictEqual(uploaded, 0);
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

test('pages phase HALTS on ambiguous duplicate live names before any upload (C5 wired)', async () => {
  const spec = makeSpec();
  spec.pages = [{ name: 'Overview', codeFile: 'o.tsx' }];
  const appDir = stagePages(spec.pages);
  try {
    const { sdk } = mockSdk();
    let uploaded = 0;
    const dup = [{ pageId: 'x1', name: 'Overview' }, { pageId: 'x2', name: 'Overview' }];
    const genpageCli = { list: async () => dup, enumerate: async () => ({ ok: true, pages: dup }), upload: async () => { uploaded += 1; return { pageId: 'x1' }; } };
    await assert.rejects(
      runSdkBuild(spec, { sdk, apply: true, env: 'https://x', appDir, genpageCli, phases: ['solution', 'data-model', 'app-shell', 'pages'] }),
      (e) => e && e.phase === 'pages' && e.code === 'pages-ambiguous-name'
    );
    assert.strictEqual(uploaded, 0);
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

test('pages phase HALTS when the app id is absent (I1 recovery guard — do NOT resume from --from pages)', async () => {
  const spec = makeSpec();
  spec.pages = [{ name: 'Overview', codeFile: 'o.tsx' }];
  const appDir = stagePages(spec.pages);
  try {
    const { sdk } = mockSdk();
    const genpageCli = { list: async () => [], enumerate: async () => ({ ok: true, pages: [], empty: true }), upload: async () => ({ pageId: 'gp-1' }) };
    await assert.rejects(
      runSdkBuild(spec, { sdk, apply: true, env: 'https://x', appDir, genpageCli, phases: ['pages'] }),
      (e) => e && e.phase === 'pages' && e.code === 'pages-requires-app'
    );
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

test('planFor emits one step per page + a manifest step (alignment)', () => {
  const spec = makeSpec();
  spec.pages = [{ name: 'Overview', codeFile: 'o.tsx' }, { name: 'Detail', codeFile: 'd.tsx' }];
  const labels = planFor(spec, { phases: PHASES }).map((p) => p.label);
  assert.strictEqual(labels.filter((l) => /^page "/.test(l)).length, 2, 'one step per page');
  assert.ok(labels.includes(`page manifest ${appUniqueName(spec)}_pagemanifest`), 'plan lists the manifest step');
});
```

- [ ] **Step 3: Run the tests to verify they fail** — `node --test scripts/tests/sdk-build.test.js` → FAIL (key-by-KEY throws `references page 'overview' which wasn't built`; manifest/halt/planFor tests fail).

- [ ] **Step 4: Implement the helpers, the pages-phase rewrite, planFor, surface**

(a) Require `page-manifest.js` in the `sdk-build.js` require block (`:14-54`):

```javascript
const { manifestResourceName, buildManifest, serializeManifest, parseManifestBase64, reconcilePageIds } = require('./page-manifest.js');
```

(b) Add the helpers after `ensureAppIcon` (`:461`):

```javascript
// Read the durable page manifest (`<appUnique>_pagemanifest`). Looked up by NAME via queryRecords
// (getWebResource needs the GUID we don't have yet). content is base64; `text` is the decoded serialized
// content, used by persist's content-dedup. manifest is null when absent/unreadable (fail-closed parse)
// so the caller relies on the live enumeration. See design §7.3.
async function readPageManifest(provision, appUnique) {
  const name = manifestResourceName(appUnique);
  const rows = await provision.queryRecords('webresource', { select: ['webresourceid', 'content'], filter: `name eq '${odataLit(name)}'`, top: 1 });
  const wr = rows && rows[0];
  if (!wr) return { id: undefined, manifest: null, text: undefined };
  const text = wr.content ? Buffer.from(wr.content, 'base64').toString('utf8') : undefined;
  return { id: wr.webresourceid, manifest: parseManifestBase64(wr.content), text };
}

// Create or UPDATE the durable page manifest and (idempotently) re-assert its solution membership EVERY
// run (design §7.3). CONTENT-DEDUP: the write is SKIPPED when the manifest already holds exactly `content`
// (== lastContent). Called immediately after EVERY page create (crash-safety, C5) AND once at the end;
// dedup means a single-page first build issues one create + zero updates, an N-new-page first build one
// create + (N-1) updates, and a no-op final persist. Stored as type 'js' (webresourcetype 3): there is no
// 'json' web-resource kind and 'js' round-trips arbitrary text unchanged. Returns { id, content } for the
// next call. Stable 7-arg signature (Tasks 5 + 8).
async function persistPageManifest(provision, spec, keyToId, sol, appUnique, existingId, lastContent) {
  const name = manifestResourceName(appUnique);
  const content = serializeManifest(buildManifest(spec, keyToId));
  let id = existingId;
  if (content !== lastContent) {
    if (id) await provision.updateWebResource(id, { content });
    else { const r = await provision.createWebResource({ name, displayName: `${spec.app.name} Page Manifest`, type: 'js', content }); id = r.id; }
  }
  if (id) await provision.addSolutionComponent({ componentId: id, componentType: COMPONENT_TYPE.webResource, solutionUniqueName: sol.uniqueName });
  return { id, content };
}
```

(c) Replace the pages phase (`:1064-1097`) with the discover-reconcile / key-by-KEY / persist-after-each-create version (Task 8 layers the PAGEREF_ protocol on top):

```javascript
  // 7b. Pages (generative pages). The app now exists; upload each page's content via pac (WITHOUT
  //     --add-to-sitemap — the SDK owns the sitemap), persisting the durable manifest immediately after
  //     each create (crash-safety), then finalize the sitemap once so it includes the GenPage subareas.
  if (has('pages') && (spec.pages || []).length) {
    const genpageCli = opts.genpageCli || makeGenpageCli(opts.env);
    const appUnique = appUniqueName(spec);
    // I1 recovery guard: the app id is only populated by app-shell (this run). If pages runs without it
    // (e.g. --from pages), there is nothing to upload against — HALT and require a FULL rerun.
    if (!result.created.app) throw new BuildHalt('pages phase requires the app (app-shell) in the same run — the app id is not carried across invocations. Re-run a FULL build (do not use --from pages).', { phase: 'pages', code: 'pages-requires-app', recoverable: false });
    // Fail-closed enumeration: a failed/unreadable/incomplete listing must NOT look like "no pages".
    const enumd = await genpageCli.enumerate({ appId: result.created.app });
    if (!enumd.ok) throw new BuildHalt(`page enumeration failed — refusing to (re)create pages against an unknown page set: ${enumd.error || 'pac genpage list returned non-zero'}`, { phase: 'pages', code: 'pages-enumeration-failed', recoverable: true });
    const { id: readId, manifest, text } = await readPageManifest(provision, appUnique);
    let manifestId = readId;
    let lastManifestContent = text;
    const { keyToId, ambiguous } = reconcilePageIds(spec.pages, manifest, enumd.pages);
    if (ambiguous.length) throw new BuildHalt(`ambiguous page name(s) ${ambiguous.map((a) => `"${a.name}"`).join(', ')} — multiple live pages share a display name; refusing to overwrite an arbitrary one. Rename or remove the duplicate in Maker, then rebuild.`, { phase: 'pages', code: 'pages-ambiguous-name', recoverable: false });
    const persistNow = async () => { const p = await persistPageManifest(provision, spec, keyToId, sol, appUnique, manifestId, lastManifestContent); manifestId = p.id; lastManifestContent = p.content; };
    for (const p of spec.pages) {
      const src = normalizePageSource(p);
      if (!src || src.kind !== 'tsx' || !src.codeFile) { runner.skip('pages', `page "${p.name}" (no tsx source)`); continue; }
      const key = p.key || p.name;
      await runner.run('pages', `page "${p.name}"`, async () => {
        const requestedId = keyToId.get(key);
        const codeFile = path.resolve(opts.appDir || '.', src.codeFile);
        const up = await genpageCli.upload({ appId: result.created.app, pageId: requestedId, codeFile, name: p.name, prompt: p.prompt, agentMessage: p.agentMessage, dataSources: p.dataSources });
        // I7: an UPDATE (requestedId set) must return the SAME id, else a resolved sibling could point at
        // a stale target. Case-insensitive (Dataverse may echo a differently-cased GUID).
        if (requestedId && String(up.pageId).toLowerCase() !== String(requestedId).toLowerCase()) throw new BuildHalt(`page "${p.name}" UPDATE returned a different id (${up.pageId} != ${requestedId}) — refusing to finalize with an inconsistent target`, { phase: 'pages', code: 'pages-update-identity-mismatch', recoverable: false });
        // Key by the STABLE key (p.key||p.name): appDef resolves result.pages[s.page] where s.page is the
        // migrated KEY (:506). Keying by name left v2 key-referenced subareas unresolved.
        keyToId.set(key, up.pageId);
        result.created.pages[key] = up.pageId;
        await persistNow(); // manifest carries this id BEFORE the next create (crash-safety, design §9 / C5)
        return up.pageId;
      });
    }
    await runner.run('pages', `page manifest ${manifestResourceName(appUnique)}`, async () => { await persistNow(); return manifestResourceName(appUnique); });
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

(d) `planFor` (`:279-280`) — one step per page + a manifest step + finalize:

```javascript
  if (has('pages')) for (const p of spec.pages || []) items.push({ phase: 'pages', label: `page "${p.name}"` });
  if (has('pages') && (spec.pages || []).length) items.push({ phase: 'pages', label: `page manifest ${appUniqueName(spec)}_pagemanifest` });
  if (has('pages') && (spec.pages || []).length && appHasPageSubareas(spec)) items.push({ phase: 'pages', label: 'finalize sitemap (genpage subareas)' });
```

(e) `SKILL_SDK_SURFACE` — add `'updateWebResource'` alphabetically after `'updateRecord'` (`sdk-surface-contract.test.js:75` lists the expected surface too — add it there so the source-scan half passes).

- [ ] **Step 5: Run pages + surface + migrate tests + full suite**

Run: `node --test scripts/tests/sdk-build.test.js scripts/tests/sdk-build-pages-migrate.test.js scripts/tests/sdk-surface-contract.test.js`
Expected: PASS.

Then: `node scripts/run-tests.js`
Expected: PASS — suite green (≈ 621).

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/sdk-build.js scripts/tests/sdk-build.test.js scripts/tests/sdk-build-pages-migrate.test.js scripts/tests/sdk-surface-contract.test.js
git commit -m "feat(model-apps): manifest lifecycle (persist-after-each-create) + key-by-key pages + surface" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>" \
  -m "Copilot-Session: 42626da2-b66f-4162-acaa-b1127ef23d89"
```

---

## Task 6: Teardown — ALWAYS remove the page manifest (I5)

`planTeardown` deletes the generated app icon but never the `<appUnique>_pagemanifest` web resource, so an app's manifest is orphaned after teardown. Always emit its teardown step for an app-bearing spec (not gated on the current spec still having pages — a not-found delete is idempotent).

**Files:**
- Modify: `scripts/lib/sdk-teardown.js` — import `manifestResourceName` (`:37`); the always-on manifest step (after the generated-icon step, `:346-349`).
- Modify: `scripts/tests/sdk-teardown.test.js` — the always-on teardown-step test.

- [ ] **Step 1: Write the failing test** — append to `scripts/tests/sdk-teardown.test.js`

```javascript
test('the page manifest web resource is ALWAYS torn down (even when the spec no longer declares pages, I5)', () => {
  const base = { solution: { uniqueName: 'PgSln', publisherPrefix: 'new' }, app: { name: 'Pages App' },
    entities: [{ schemaName: 'new_widget', primaryAttribute: { schemaName: 'new_name' }, columns: [] }],
    appShell: { areas: [{ label: 'A', groups: [{ label: 'G', subAreas: [{ entity: 'new_widget' }] }] }] } };
  const manifest = `${appUniqueName(base)}_pagemanifest`;
  assert.ok(planTeardown({ ...base, pages: [{ key: 'overview', name: 'Overview', source: { kind: 'tsx', codeFile: 'o.tsx' } }] }).some((s) => s.kind === 'webResource' && s.target.name === manifest), 'with pages');
  assert.ok(planTeardown(base).some((s) => s.kind === 'webResource' && s.target.name === manifest), 'without pages — the derived manifest is still cleaned up');
});
```

> If `appUniqueName` is not already imported in `sdk-teardown.test.js`, add it to the `require('../lib/sdk-build.js')` destructure at the top.

Run: `node --test scripts/tests/sdk-teardown.test.js` → FAIL.

- [ ] **Step 2: Implement in `scripts/lib/sdk-teardown.js`**

```javascript
// :37 — add manifestResourceName (no cycle: page-manifest.js is a pure leaf):
const { manifestResourceName } = require('./page-manifest.js');

// After the generated-app-icon step (:346-349) — ALWAYS emitted for an app-bearing spec (I5). The
// manifest is referenced only by the (already-deleted) app module, so it must be removed here or the
// solution delete leaves it orphaned. NOT gated on the current spec still having pages: a spec that
// dropped its pages would else leak the derived manifest. A not-found delete is treated as deleted
// (idempotent), so an app that never had pages adds a harmless no-op step.
if (spec.app && spec.solution) {
  const manifestName = manifestResourceName(appUniqueName(spec));
  steps.push({ kind: 'webResource', phase: 'web-resources', label: `web resource ${manifestName} (page manifest)`, target: { name: manifestName } });
}
```

Run: `node --test scripts/tests/sdk-teardown.test.js` → PASS.

- [ ] **Step 3: Full suite** — `node scripts/run-tests.js` → PASS (≈ 622).

- [ ] **Step 4: Commit**

```bash
git add scripts/lib/sdk-teardown.js scripts/tests/sdk-teardown.test.js
git commit -m "fix(model-apps): always tear down the page manifest web resource (I5)" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>" \
  -m "Copilot-Session: 42626da2-b66f-4162-acaa-b1127ef23d89"
```

---

## Task 7: C2 — the pages finalizer is the ONLY existing-app sitemap write (seed + preserve)

For an app that already exists AND has page subareas, the `app-shell` phase pushes the `omitUnbuiltPages:true` sitemap **before** pages upload (`sdk-build.js:1040-1044`) — stripping every GenPage subarea. An enumeration/upload failure then leaves the deployed app with broken navigation. Fix: for a page-backed existing app, resolve its id but **defer all sitemap mutation** to the pages finalizer. The tests **seed a prior deployed sitemap** (with GenPage subareas) and assert it is **preserved** on failure — not merely that no write occurred on a fresh app.

**Files:**
- Modify: `scripts/lib/sdk-build.js` — the existing-app branch of the app-shell phase (`:1027-1046`).
- Modify: `scripts/tests/sdk-build.test.js` — seed a prior sitemap in `mockSdk`; C2 preservation/ordering tests.

**Interfaces:** no signature change — the existing-app sitemap `updateElement`/`pushArtifact`/`publishArtifact` are now gated on `!appHasPageSubareas(spec)`.

- [ ] **Step 1: Let `mockSdk` seed a prior sitemap** — in `scripts/tests/sdk-build.test.js`, the app branch of the `fetchArtifact` mock (`:113`):

```javascript
    else if (t === 'app') store[`${t}:${id}`] = { id, siteMap: opts.existingSitemap ? JSON.parse(JSON.stringify(opts.existingSitemap)) : { areas: [] } };
```

- [ ] **Step 2: Write the failing tests** — append to `scripts/tests/sdk-build.test.js`

```javascript
// A prior deployed sitemap that ALREADY carries a GenPage subarea (the previous good deployment).
const PRIOR_SITEMAP = { areas: [{ title: 'Main', groups: [{ title: 'Pages', subAreas: [{ type: 'GenPage', genPageId: 'gp-prev', title: 'Overview' }] }] }] };
const hasGenPage = (sm, id) => (sm.areas || []).some((a) => (a.groups || []).some((g) => (g.subAreas || []).some((s) => s.type === 'GenPage' && s.genPageId === id)));

test('C2: an EXISTING page-backed app does NOT push its sitemap in app-shell — an enumeration failure PRESERVES the prior sitemap', async () => {
  const spec = makeSpec();
  spec.schemaVersion = 2;
  spec.pages = [{ key: 'overview', name: 'Overview', source: { kind: 'tsx', codeFile: 'o.tsx' } }];
  spec.appShell.areas[0].groups[0].subAreas.push({ page: 'overview', title: 'Overview' });
  const appDir = stagePages(spec.pages);
  try {
    const { sdk, calls } = mockSdk({ artifactsExist: true, existingSitemap: PRIOR_SITEMAP });
    const genpageCli = { list: async () => [], enumerate: async () => ({ ok: false, pages: [], error: 'boom' }), upload: async () => ({ pageId: 'gp-1' }) };
    await assert.rejects(
      runSdkBuild(spec, { sdk, apply: true, env: 'https://x', appDir, genpageCli, phases: ['solution', 'data-model', 'app-shell', 'pages'] }),
      (e) => e && e.code === 'pages-enumeration-failed'
    );
    assert.ok(!find(calls, 'updateElement').some((c) => c.args[2] === '/siteMap'), 'NO sitemap write in app-shell (deferred) and the finalizer was never reached');
    const deployed = await sdk.fetchArtifact('app', 'app-existing');
    assert.ok(hasGenPage(deployed.siteMap, 'gp-prev'), 'the PRIOR deployed sitemap (gp-prev) is intact — nav was not stripped');
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

test('C2: an EXISTING page-backed app writes its sitemap ONCE, in the finalizer, with GenPage subareas resolved', async () => {
  const spec = makeSpec();
  spec.schemaVersion = 2;
  spec.pages = [{ key: 'overview', name: 'Overview', source: { kind: 'tsx', codeFile: 'o.tsx' } }];
  spec.appShell.areas[0].groups[0].subAreas.push({ page: 'overview', title: 'Overview' });
  const appDir = stagePages(spec.pages);
  try {
    const { sdk, calls } = mockSdk({ artifactsExist: true, existingSitemap: PRIOR_SITEMAP });
    const genpageCli = { list: async () => [], enumerate: async () => ({ ok: true, pages: [], empty: true }), upload: async () => ({ pageId: 'gp-1' }) };
    await runSdkBuild(spec, { sdk, apply: true, env: 'https://x', appDir, genpageCli, phases: ['solution', 'data-model', 'app-shell', 'pages'] });
    const sitemapWrites = find(calls, 'updateElement').filter((c) => c.args[2] === '/siteMap');
    assert.strictEqual(sitemapWrites.length, 1, 'exactly one sitemap write — the finalizer');
    assert.ok(sitemapWrites[0].args[3].areas[0].groups[0].subAreas.some((s) => s.type === 'GenPage' && s.genPageId === 'gp-1'));
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

test('C2: an EXISTING app with NO page subareas still pushes its sitemap in app-shell (unchanged behavior)', async () => {
  const spec = makeSpec(); // entity subarea only, no pages
  const { sdk, calls } = mockSdk({ artifactsExist: true, existingSitemap: PRIOR_SITEMAP });
  await runSdkBuild(spec, { sdk, apply: true, env: 'https://x', appDir: process.cwd(), phases: ['solution', 'data-model', 'app-shell'] });
  assert.ok(find(calls, 'updateElement').some((c) => c.args[2] === '/siteMap'), 'a no-page existing app keeps pushing its sitemap in app-shell');
});
```

- [ ] **Step 3: Run the tests to verify they fail** — `node --test scripts/tests/sdk-build.test.js` → FAIL (the first test finds a `/siteMap` write in app-shell; the second finds two).

- [ ] **Step 4: Defer the existing-app sitemap write** — replace the existing-app branch body (`:1027-1046`)

```javascript
      if (existingId) {
        await provision.fetchArtifact('app', existingId);
        // C2: the pages finalizer is the ONLY existing-app sitemap write for a page-backed app. Pushing
        // the omitUnbuiltPages def HERE would persist a draft sitemap with every GenPage subarea stripped,
        // so an enumeration/upload failure before the finalizer would leave the deployed app with broken
        // nav. Defer the entire sitemap write (update + push + publish) to the finalizer, which pushes the
        // FULL def (entity + resolved GenPage subareas). With no page subareas, keep today's behavior.
        if (!appHasPageSubareas(spec)) {
          provision.updateElement('app', existingId, '/siteMap', def.siteMap);
          requireSuccessfulPush(await provision.pushArtifact('app', existingId), `app ${def.name}`);
          await provision.publishArtifact('app', existingId);
        }
        await ensureSitemapInSolution(provision, sol, def.uniqueName);
        return existingId;
      }
```

- [ ] **Step 5: Run the tests + full suite**

Run: `node --test scripts/tests/sdk-build.test.js`
Expected: PASS.

Then: `node scripts/run-tests.js`
Expected: PASS — suite green (≈ 625).

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/sdk-build.js scripts/tests/sdk-build.test.js
git commit -m "fix(model-apps): pages finalizer is the only existing-app sitemap write; preserve prior sitemap (C2)" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>" \
  -m "Copilot-Session: 42626da2-b66f-4162-acaa-b1127ef23d89"
```

---

## Task 8: `PAGEREF_` deployment protocol — structural scan/parity → create-absent-first → staging → upload-once, under a descoped advisory lease (C1, C3-lease, C5, I4, I7)

Replaces Task 5's simple upload loop with the full design §9 protocol: **structurally** scan every implemented source and enforce nav parity (C1/C4) **before** any write; create-absent-first for nav targets (persisting the manifest after **every** create, C5); resolve into **run-scoped** staging (never GUID-mutating canonical, cleaned in `finally`); upload-once with an UPDATE-identity guard (I7); all under a **single-machine advisory lockfile** (review R2 Critical 3 — halts a fresh concurrent build, never steals, owner-checked release; correctness rests on convergence, not the lock).

**Files:**
- Modify: `scripts/lib/sdk-build.js` — require `pageref-resolver.js`; add `writeStagingFile`, `acquireAppPagesLease`, `appHasCrossPageNav`; replace the pages upload loop with the protocol; add the `resolve cross-page navigation` `planFor` item; thread `opts.workspaceDir`.
- Modify: `scripts/build-model-app.js` — pass `workspaceDir: opts.workspaceDir` into `runSdkBuild`; add `workspaceDir` to `opts` (already resolved in `main`).
- Create: `scripts/tests/sdk-build-pages-deploy.test.js`.

**Interfaces:**
- Consumes: `extractNavTargets`/`navReferencedKeys`/`navMalformedRefs`/`resolvePageRefs`/`navTargetParity` (Task 1); `enumerate`/`readPageManifest`/`persistPageManifest`/`reconcilePageIds` (Tasks 2/4/5); `normalizePageSource` (`app-spec.js`).
- Produces: `writeStagingFile(stagingDir, key, code) → path`; `acquireAppPagesLease(wsDir, appUnique, deps?) → { release }`; `appHasCrossPageNav(spec) → boolean`; new `BuildHalt` codes `pages-malformed-navref`, `pages-nav-parity`, `pages-dangling-navref`, `pages-locked` (`recoverable:true`), others `recoverable:false`.

- [ ] **Step 1: Write the failing integration tests** — create `scripts/tests/sdk-build-pages-deploy.test.js`

```javascript
'use strict';
// Integration tests for the §9 PAGEREF_ deployment protocol: STRUCTURAL scan/parity → create-absent-first
// → resolve-to-run-scoped-staging (never mutate canonical) → upload-once (no duplicates) → sitemap finalize.
// Uses a REAL temp appDir so the fs read (canonical .tsx) and write (staging) run. Staging is cleaned in a
// finally, so the mock upload captures the uploaded bytes at call time.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runSdkBuild } = require('../lib/sdk-build.js');

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
      if (e === 'webresource') { if (/_pagemanifest'/.test(filter)) return opts.pageManifest ? [{ webresourceid: opts.manifestId || 'wr-manifest', content: opts.pageManifest }] : []; return []; }
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

// genpageCli mock: mints deterministic ids from the page name; captures the uploaded bytes (staging is
// cleaned in a finally). `live` seeds enumerate() for a rebuild.
function mockGenpageCli(live = []) {
  const uploads = [];
  return {
    uploads,
    list: async () => live,
    enumerate: async () => ({ ok: true, pages: live, empty: live.length === 0 }),
    upload: async (o) => {
      let content = '';
      try { content = fs.readFileSync(o.codeFile, 'utf8'); } catch { /* nothing */ }
      const pageId = o.pageId || `gp-${String(o.name).toLowerCase()}`;
      uploads.push({ name: o.name, requestedId: o.pageId, resolvedId: pageId, codeFile: o.codeFile, content });
      return { pageId };
    },
  };
}

const NAV = (key) => `Xrm.Navigation.navigateTo({ pageType: "generative", pageId: "PAGEREF_${key}", data: {} });`;

// Overview → Detail on disk under a real temp appDir. Options toggle malformed / undeclared / dangling refs.
function makeTwoPageApp(opts = {}) {
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pages-deploy-'));
  const parts = [NAV('detail')];
  if (opts.malformed) parts.push("Xrm.Navigation.navigateTo({ pageType: 'generative', pageId: 'PAGEREF_detail' });"); // single-quoted → malformed
  if (opts.undeclaredRef) parts.push(NAV('ghost'));   // referenced at a real nav site, not declared
  if (opts.danglingTarget) parts.push(NAV('ghost'));  // declared + referenced, but 'ghost' is not a page
  fs.writeFileSync(path.join(appDir, 'overview.tsx'), `export default function Overview(){ ${parts.join(' ')} return null; }`, 'utf8');
  fs.writeFileSync(path.join(appDir, 'detail.tsx'), 'export default function Detail(){ return null; }', 'utf8');
  const navigatesTo = [{ targetKey: 'detail' }];
  if (opts.danglingTarget) navigatesTo.push({ targetKey: 'ghost' });
  const spec = {
    schemaVersion: 2,
    solution: { uniqueName: 'PgDeploy', displayName: 'Pg', publisherPrefix: 'contoso' },
    app: { name: 'Deploy App' },
    entities: [{ schemaName: 'contoso_item', displayName: 'Item', primaryAttribute: { schemaName: 'contoso_name', displayName: 'Name' }, columns: [] }],
    pages: [
      { key: 'overview', name: 'Overview', navigatesTo, source: { kind: 'tsx', codeFile: 'overview.tsx' } },
      { key: 'detail', name: 'Detail', source: { kind: 'tsx', codeFile: 'detail.tsx' } },
    ],
    appShell: { areas: [{ label: 'Main', groups: [{ label: 'Pages', subAreas: [{ page: 'overview', title: 'Overview' }, { page: 'detail', title: 'Detail' }] }] }] },
  };
  return { appDir, spec };
}

const PHASES = ['solution', 'data-model', 'app-shell', 'pages'];

test('deploy: nav page uploads RESOLVED content (target id, no PAGEREF_); canonical .tsx is NEVER GUID-mutated', async () => {
  const { appDir, spec } = makeTwoPageApp();
  try {
    const { sdk } = mockSdk();
    const genpageCli = mockGenpageCli();
    await runSdkBuild(spec, { sdk, apply: true, env: 'https://x', appDir, genpageCli, phases: PHASES });
    const overviewUpload = genpageCli.uploads.find((u) => u.name === 'Overview');
    assert.ok(overviewUpload.content.includes('gp-detail'), 'uploaded content carries the resolved target id');
    assert.ok(!/PAGEREF_/.test(overviewUpload.content), 'no PAGEREF_ token remains in the uploaded (staged) bytes');
    assert.ok(fs.readFileSync(path.join(appDir, 'overview.tsx'), 'utf8').includes('"PAGEREF_detail"'), 'canonical .tsx untouched');
    const stagingRoot = path.join(appDir, '.maker-workspace', '.pageref-deploy');
    assert.ok(!fs.existsSync(stagingRoot) || fs.readdirSync(stagingRoot).length === 0, 'run-scoped staging cleaned in finally');
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

test('deploy: a MALFORMED (single-quoted) nav PAGEREF_ HALTS before any upload (C4 grammar, structural)', async () => {
  const { appDir, spec } = makeTwoPageApp({ malformed: true });
  try {
    const { sdk } = mockSdk();
    const genpageCli = mockGenpageCli();
    await assert.rejects(
      runSdkBuild(spec, { sdk, apply: true, env: 'https://x', appDir, genpageCli, phases: PHASES }),
      (e) => e && e.phase === 'pages' && e.code === 'pages-malformed-navref'
    );
    assert.strictEqual(genpageCli.uploads.length, 0, 'scan rejects before any page write');
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

test('deploy: a real nav ref with NO declaration HALTS on parity before any upload (C4 parity, structural)', async () => {
  const { appDir, spec } = makeTwoPageApp({ undeclaredRef: true });
  try {
    const { sdk } = mockSdk();
    const genpageCli = mockGenpageCli();
    await assert.rejects(
      runSdkBuild(spec, { sdk, apply: true, env: 'https://x', appDir, genpageCli, phases: PHASES }),
      (e) => e && e.phase === 'pages' && e.code === 'pages-nav-parity'
    );
    assert.strictEqual(genpageCli.uploads.length, 0);
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

test('deploy: a DECOY "PAGEREF_" string (not a nav call site) does NOT satisfy a declared edge — parity HALTs (C1)', async () => {
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pages-decoy-'));
  try {
    // Overview DECLARES nav to detail, but the only "PAGEREF_detail" is a decoy string; the REAL nav
    // points at "PAGEREF_other". Structural parity: referenced=[other], declared=[detail] → mismatch.
    fs.writeFileSync(path.join(appDir, 'overview.tsx'), `export default function O(){ const decoy = "PAGEREF_detail"; ${NAV('other')} return null; }`, 'utf8');
    fs.writeFileSync(path.join(appDir, 'detail.tsx'), 'export default function D(){ return null; }', 'utf8');
    const spec = {
      schemaVersion: 2, solution: { uniqueName: 'PgDecoy', displayName: 'Pg', publisherPrefix: 'contoso' }, app: { name: 'Decoy App' },
      entities: [{ schemaName: 'contoso_item', displayName: 'Item', primaryAttribute: { schemaName: 'contoso_name', displayName: 'Name' }, columns: [] }],
      pages: [{ key: 'overview', name: 'Overview', navigatesTo: [{ targetKey: 'detail' }], source: { kind: 'tsx', codeFile: 'overview.tsx' } }, { key: 'detail', name: 'Detail', source: { kind: 'tsx', codeFile: 'detail.tsx' } }],
      appShell: { areas: [{ label: 'M', groups: [{ label: 'P', subAreas: [{ page: 'overview' }, { page: 'detail' }] }] }] },
    };
    const { sdk } = mockSdk();
    const genpageCli = mockGenpageCli();
    await assert.rejects(
      runSdkBuild(spec, { sdk, apply: true, env: 'https://x', appDir, genpageCli, phases: PHASES }),
      (e) => e && e.phase === 'pages' && e.code === 'pages-nav-parity'
    );
    assert.strictEqual(genpageCli.uploads.length, 0, 'a decoy string cannot pass structural parity');
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

test('deploy: a declared+referenced DANGLING target HALTS before the sitemap finalize', async () => {
  const { appDir, spec } = makeTwoPageApp({ danglingTarget: true });
  try {
    const { sdk, calls } = mockSdk();
    const genpageCli = mockGenpageCli();
    await assert.rejects(
      runSdkBuild(spec, { sdk, apply: true, env: 'https://x', appDir, genpageCli, phases: PHASES }),
      (e) => e && e.phase === 'pages' && e.code === 'pages-dangling-navref'
    );
    assert.ok(!calls.some((c) => c.name === 'updateElement' && c.args[2] === '/siteMap'), 'sitemap NOT finalized on a dangling target');
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

test('deploy: create-absent-first mints target ids, uploads each page ONCE, records both ids in the manifest', async () => {
  const { appDir, spec } = makeTwoPageApp();
  try {
    const { sdk, calls } = mockSdk();
    const genpageCli = mockGenpageCli();
    await runSdkBuild(spec, { sdk, apply: true, env: 'https://x', appDir, genpageCli, phases: PHASES });
    assert.strictEqual(genpageCli.uploads.filter((u) => u.name === 'Detail').length, 1);
    assert.strictEqual(genpageCli.uploads.filter((u) => u.name === 'Overview').length, 1);
    const writes = calls.filter((c) => (c.name === 'createWebResource' && /_pagemanifest$/.test(c.args[0].name)) || c.name === 'updateWebResource');
    const last = writes[writes.length - 1];
    const content = last.name === 'updateWebResource' ? last.args[1].content : last.args[0].content;
    const byKey = Object.fromEntries(JSON.parse(content).pages.map((p) => [p.key, p.pageId]));
    assert.strictEqual(byKey.overview, 'gp-overview');
    assert.strictEqual(byKey.detail, 'gp-detail');
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

test('deploy: a rebuild re-binds ids from the live enumeration and issues only UPDATEs (no duplicate CREATE)', async () => {
  const { appDir, spec } = makeTwoPageApp();
  try {
    const live = [{ pageId: 'gp-overview', name: 'Overview' }, { pageId: 'gp-detail', name: 'Detail' }];
    const manifest = Buffer.from(JSON.stringify({ schemaVersion: 1, pages: [{ key: 'overview', name: 'Overview', pageId: 'gp-overview' }, { key: 'detail', name: 'Detail', pageId: 'gp-detail' }] }), 'utf8').toString('base64');
    const { sdk } = mockSdk({ pageManifest: manifest, manifestId: 'wr-manifest' });
    const genpageCli = mockGenpageCli(live);
    await runSdkBuild(spec, { sdk, apply: true, env: 'https://x', appDir, genpageCli, phases: PHASES });
    assert.ok(genpageCli.uploads.length > 0);
    assert.ok(genpageCli.uploads.every((u) => !!u.requestedId), 'every upload targets a known pageId (UPDATE) — no CREATE, no duplicate');
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run the tests to verify they fail** — `node --test scripts/tests/sdk-build-pages-deploy.test.js` → FAIL (Task 5's loop uploads canonical directly; no staging, no scan/parity halts).

- [ ] **Step 3: Add the require + helpers to `scripts/lib/sdk-build.js`**

Require (`:14-54` block):

```javascript
const { navReferencedKeys, navMalformedRefs, resolvePageRefs, navTargetParity } = require('./pageref-resolver.js');
```

Helpers (next to `persistPageManifest`):

```javascript
// True when any page declares cross-page navigation. Deterministic from the spec, so planFor can plan
// the single "resolve cross-page navigation" step without runtime state.
function appHasCrossPageNav(spec) {
  return ((spec && spec.pages) || []).some((p) => (p.navigatesTo || []).length > 0);
}

// Write a RESOLVED deployment copy of a page's .tsx into the run-scoped staging dir — NEVER over the
// canonical source (a GUID baked into canonical breaks cross-env recreate; design §9 / SDK T5). pac
// genpage upload takes a file PATH, so resolved bytes must exist on disk. The dir is created per RUN
// under <workspace>/.pageref-deploy/<runId>/ and removed in a finally (never leave env GUIDs on disk,
// no sanitized-name cross-run collision). The key is sanitized to a safe filename.
function writeStagingFile(stagingDir, key, code) {
  fs.mkdirSync(stagingDir, { recursive: true });
  const file = path.join(stagingDir, `${String(key).replace(/[^A-Za-z0-9_-]/g, '_')}.tsx`);
  fs.writeFileSync(file, code, 'utf8');
  return file;
}

// SINGLE-MACHINE advisory lockfile over the pages protocol (design §9 / review R2 Critical 3 — descoped).
// A COURTESY to stop two LOCAL builds of the same app racing to CREATE duplicate pages; NOT a distributed
// lock, and correctness does NOT depend on it — the convergence spine (fail-closed enumeration +
// create-absent-first + immediate-manifest-persist) makes any re-run idempotent. Rules:
//   - Acquire via a single ATOMIC exclusive create (fs 'wx'): the OS guarantees one winner.
//   - A FRESH lock (age <= staleMs) held by another build → HALT 'pages-locked'. NEVER steal a fresh lock.
//   - A STALE lock (age > staleMs — generous 30 min — or unreadable/abandoned) → reclaim with ONE attempt:
//     remove it, then re-create 'wx'; if that loses the race (EEXIST) → HALT (no steal loop, no mutual-steal).
//   - Release removes the lock ONLY if it still records THIS pid — so a build never deletes a lock a
//     different live build now holds.
// Concurrent builds of the SAME app across machines/worktrees are UNSUPPORTED. `deps` is a test seam.
function acquireAppPagesLease(wsDir, appUnique, deps = {}) {
  const now = deps.now || (() => Date.now());
  const staleMs = deps.staleMs || 30 * 60 * 1000;
  fs.mkdirSync(wsDir, { recursive: true });
  const lockPath = path.join(wsDir, `pages-${String(appUnique).replace(/[^A-Za-z0-9_-]/g, '_')}.lock`);
  const mine = JSON.stringify({ pid: process.pid, at: now() });
  const create = () => fs.writeFileSync(lockPath, mine, { flag: 'wx' }); // atomic exclusive create
  const locked = (held) => new BuildHalt(`another build is deploying pages for '${appUnique}' (lock held by pid ${held && held.pid}) — refusing a second concurrent pages deploy (would risk duplicate page creation). Retry after it completes, or delete ${lockPath} if it is stale.`, { phase: 'pages', code: 'pages-locked', recoverable: true });
  try { create(); }
  catch (e) {
    if (e.code !== 'EEXIST') throw e;
    let held = null;
    try { held = JSON.parse(fs.readFileSync(lockPath, 'utf8')); } catch { held = null; } // unreadable → abandoned
    if (held && held.at && now() - held.at <= staleMs) throw locked(held); // FRESH — never steal
    try { fs.rmSync(lockPath, { force: true }); create(); } // stale/abandoned: ONE reclaim attempt
    catch (e2) { if (e2.code === 'EEXIST') throw locked(null); throw e2; }
  }
  return { release: () => { try { const h = JSON.parse(fs.readFileSync(lockPath, 'utf8')); if (h && h.pid === process.pid) fs.rmSync(lockPath, { force: true }); } catch { /* gone/unreadable — best-effort */ } } };
}
```

- [ ] **Step 4: Replace the pages phase upload loop with the §9 protocol**

Replace the Task 5 pages phase body (from the `enumerate` call through the finalize block) with the leased, run-scoped protocol below. The `pages-requires-app` guard stays OUTSIDE the try; the lease/staging wrap the rest in `try/finally`.

```javascript
  if (has('pages') && (spec.pages || []).length) {
    const genpageCli = opts.genpageCli || makeGenpageCli(opts.env);
    const appUnique = appUniqueName(spec);
    if (!result.created.app) throw new BuildHalt('pages phase requires the app (app-shell) in the same run — the app id is not carried across invocations. Re-run a FULL build (do not use --from pages).', { phase: 'pages', code: 'pages-requires-app', recoverable: false });
    const wsDir = opts.workspaceDir || path.join(path.resolve(opts.appDir || '.'), '.maker-workspace');
    const lease = acquireAppPagesLease(wsDir, appUnique);          // advisory single-machine courtesy (Critical 3)
    const stagingDir = path.join(wsDir, '.pageref-deploy', randomUUID());
    try {
      const enumd = await genpageCli.enumerate({ appId: result.created.app });
      if (!enumd.ok) throw new BuildHalt(`page enumeration failed — refusing to (re)create pages against an unknown page set: ${enumd.error || 'pac genpage list returned non-zero'}`, { phase: 'pages', code: 'pages-enumeration-failed', recoverable: true });
      const { id: readId, manifest, text } = await readPageManifest(provision, appUnique);
      let manifestId = readId;
      let lastManifestContent = text;
      const { keyToId, ambiguous } = reconcilePageIds(spec.pages, manifest, enumd.pages);
      if (ambiguous.length) throw new BuildHalt(`ambiguous page name(s) ${ambiguous.map((a) => `"${a.name}"`).join(', ')} — multiple live pages share a display name; refusing to overwrite an arbitrary one. Rename or remove the duplicate in Maker, then rebuild.`, { phase: 'pages', code: 'pages-ambiguous-name', recoverable: false });
      const persistNow = async () => { const pr = await persistPageManifest(provision, spec, keyToId, sol, appUnique, manifestId, lastManifestContent); manifestId = pr.id; lastManifestContent = pr.content; };

      const keyOf = (p) => p.key || p.name;
      const canonicalPath = (p) => path.resolve(opts.appDir || '.', normalizePageSource(p).codeFile);
      const implemented = [];
      for (const p of spec.pages) {
        const src = normalizePageSource(p);
        if (src && src.kind === 'tsx' && src.codeFile) implemented.push(p);
        else runner.skip('pages', `page "${p.name}" (no tsx source)`);
      }

      // (1) STRUCTURAL SCAN of every implemented canonical source BEFORE any write (C1/C4), via the single
      //     nav oracle (extractNavTargets). Reject a malformed (non-canonical) nav PAGEREF and enforce EXACT
      //     parity between declared navigatesTo targetKeys and the keys the source references at REAL nav
      //     call sites — a decoy "PAGEREF_" string or a stray GUID in a comment can never pass.
      const sourceByKey = new Map();
      for (const p of implemented) {
        const code = fs.readFileSync(canonicalPath(p), 'utf8');
        sourceByKey.set(keyOf(p), code);
        const malformed = navMalformedRefs(code);
        if (malformed.length) throw new BuildHalt(`page "${p.name}" has malformed navigation reference(s): ${malformed.join(', ')} — a cross-page link must be a double-quoted "PAGEREF_<key>" pageId literal`, { phase: 'pages', code: 'pages-malformed-navref', recoverable: false });
        const { declaredNotReferenced, referencedNotDeclared } = navTargetParity((p.navigatesTo || []).map((n) => n.targetKey), navReferencedKeys(code));
        if (declaredNotReferenced.length || referencedNotDeclared.length) throw new BuildHalt(`page "${p.name}" navigation parity mismatch — declared-but-absent: [${declaredNotReferenced.join(', ')}], referenced-but-undeclared: [${referencedNotDeclared.join(', ')}]`, { phase: 'pages', code: 'pages-nav-parity', recoverable: false });
      }

      const navTargets = new Set();
      for (const p of implemented) for (const n of p.navigatesTo || []) navTargets.add(n.targetKey);
      const mintedKeys = new Set();
      const deployment = new Map(); // key -> resolved code (nav sources only)

      // (2+3) Inside ONE "resolve cross-page navigation" step: create-absent-first for ABSENT nav TARGETS
      //       (upload symbolic source to mint an id; persist the manifest IMMEDIATELY after EVERY create for
      //       crash-safety, C5), then RESOLVE the graph once every referenced target has an id (fail-closed
      //       on a dangling target).
      if (appHasCrossPageNav(spec)) {
        await runner.run('pages', 'resolve cross-page navigation', async () => {
          for (const p of implemented) {
            const key = keyOf(p);
            if (keyToId.has(key) || !navTargets.has(key)) continue; // only ABSENT targets need pre-minting
            const up = await genpageCli.upload({ appId: result.created.app, codeFile: canonicalPath(p), name: p.name, prompt: p.prompt, agentMessage: p.agentMessage, dataSources: p.dataSources });
            keyToId.set(key, up.pageId);
            result.created.pages[key] = up.pageId;
            mintedKeys.add(key);
            await persistNow();
          }
          const navSources = new Map();
          for (const p of implemented) if ((p.navigatesTo || []).length) navSources.set(keyOf(p), { code: sourceByKey.get(keyOf(p)) });
          const { deployment: dep, unresolved } = resolvePageRefs(navSources, keyToId);
          if (unresolved.length) throw new BuildHalt(`unresolved cross-page navigation target(s): ${unresolved.join(', ')} — a page navigates to a key that isn't a built page`, { phase: 'pages', code: 'pages-dangling-navref', recoverable: false });
          for (const [k, code] of dep) deployment.set(k, code);
          return `${deployment.size} navigation source(s)`;
        });
      }

      // (4) UPLOAD-ONCE — exactly one runner.run/skip per page. A non-nav page already minted in step 2 is
      //     final (skip). Every UPDATE asserts the returned id matches the requested id (I7). Persist the
      //     manifest immediately after each create (C5).
      for (const p of implemented) {
        const key = keyOf(p);
        const isNav = (p.navigatesTo || []).length > 0;
        if (!isNav && mintedKeys.has(key)) { runner.skip('pages', `page "${p.name}" (created)`); continue; }
        await runner.run('pages', `page "${p.name}"`, async () => {
          const requestedId = keyToId.get(key);
          const codeFile = isNav ? writeStagingFile(stagingDir, key, deployment.get(key)) : canonicalPath(p);
          const up = await genpageCli.upload({ appId: result.created.app, pageId: requestedId, codeFile, name: p.name, prompt: p.prompt, agentMessage: p.agentMessage, dataSources: p.dataSources });
          if (requestedId && String(up.pageId).toLowerCase() !== String(requestedId).toLowerCase()) throw new BuildHalt(`page "${p.name}" UPDATE returned a different id (${up.pageId} != ${requestedId}) — refusing to finalize with an inconsistent target`, { phase: 'pages', code: 'pages-update-identity-mismatch', recoverable: false });
          keyToId.set(key, up.pageId);
          result.created.pages[key] = up.pageId;
          await persistNow();
          return up.pageId;
        });
      }

      // (5) Persist the FINAL manifest (deduped no-op after per-create persists), then finalize the sitemap
      //     (the true commit point — only after all resolved uploads succeed).
      await runner.run('pages', `page manifest ${manifestResourceName(appUnique)}`, async () => { await persistNow(); return manifestResourceName(appUnique); });
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
    } finally {
      try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch { /* best-effort — never leave env GUIDs on disk */ }
      lease.release();
    }
  }
```

- [ ] **Step 5: `planFor` + `workspaceDir` threading**

(a) `planFor` — insert the resolve step between the per-page items and the manifest item (`:279-280`):

```javascript
  if (has('pages')) for (const p of spec.pages || []) items.push({ phase: 'pages', label: `page "${p.name}"` });
  if (has('pages') && (spec.pages || []).length && appHasCrossPageNav(spec)) items.push({ phase: 'pages', label: 'resolve cross-page navigation' });
  if (has('pages') && (spec.pages || []).length) items.push({ phase: 'pages', label: `page manifest ${appUniqueName(spec)}_pagemanifest` });
  if (has('pages') && (spec.pages || []).length && appHasPageSubareas(spec)) items.push({ phase: 'pages', label: 'finalize sitemap (genpage subareas)' });
```

(b) `build-model-app.js` — thread the workspace so the lease/staging live under the real workspace dir. `main` already resolves `workspaceDir` (`:310`); add it to `opts` (`:311-322`) and into the `runSdkBuild` opts (`:210-221`):

```javascript
// opts (:311-322) — add:
    workspaceDir,
// runSdkBuild opts (:210-221) — add:
        workspaceDir: opts.workspaceDir,
```

- [ ] **Step 6: Run the deploy tests + prior pages tests + full suite**

Run: `node --test scripts/tests/sdk-build-pages-deploy.test.js scripts/tests/sdk-build.test.js scripts/tests/sdk-build-pages-migrate.test.js`
Expected: PASS — the deploy protocol tests green; the Task 5/7 single/no-nav pages tests still green (no `navigatesTo` → no resolve step → per-page upload-once behaves like the simple loop).

Then: `node scripts/run-tests.js`
Expected: PASS — suite green (≈ 632).

- [ ] **Step 7: Commit**

```bash
git add scripts/lib/sdk-build.js scripts/build-model-app.js scripts/tests/sdk-build-pages-deploy.test.js
git commit -m "feat(model-apps): PAGEREF_ protocol — structural scan/parity, create-absent-first, staging, advisory lease" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>" \
  -m "Copilot-Session: 42626da2-b66f-4162-acaa-b1127ef23d89"
```

---

## Task 9: Failure-ordering, crash-after-FIRST-create convergence, descoped-lease guarantees, and the broad apply-range guard (C5, I1, I4, I6)

Locks the protocol's ordering with explicit CALL-SEQUENCE + restart-convergence tests — the crash test now halts **directly after the first page CREATE** (I6/C5) — proves the **descoped** advisory lease HALTs a fresh concurrent build and never steals/mis-releases (I4), and rejects **any** partial apply range except the exact `data` stage (I1).

**Files:**
- Create: `scripts/tests/sdk-build-pages-order.test.js`.
- Modify: `scripts/lib/sdk-build.js` — export `acquireAppPagesLease` for direct unit testing.
- Modify: `scripts/build-model-app.js` — the broad I1 apply-range guard; import `PHASES`, `STAGES`.
- Modify: `scripts/tests/build-model-app.test.js` — the I1 rejection test.

- [ ] **Step 1: Export the lease** — add `acquireAppPagesLease` to `sdk-build.js` `module.exports` (alongside `appUniqueName`, `planFor`, etc.).

- [ ] **Step 2: Write the failing ordering + lease tests** — create `scripts/tests/sdk-build-pages-order.test.js`

```javascript
'use strict';
// Failure-ordering + restart-convergence for the §9 pages protocol (I6/C5): the sitemap is committed ONLY
// after every resolved upload; a halt directly after the FIRST create converges on re-run without
// duplicate creates; and the descoped advisory lease refuses a fresh concurrent build (I4).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runSdkBuild, appUniqueName, acquireAppPagesLease } = require('../lib/sdk-build.js');

// Stateful harness: enumerate() reflects pages a create appended; the manifest webresource persists in
// `store`/`manifestB64`; uploads are recorded in the shared `calls` sequence log.
function harness() {
  const live = [];
  const calls = [];
  const store = {};
  let manifestB64 = null;
  const sdk = {
    queryRecords: async (e, o) => {
      const filter = (o && o.filter) || '';
      if (e === 'sitemap') return [{ sitemapid: 'sm-1' }];
      if (e === 'solution') return [];
      if (e === 'webresource') { if (/_pagemanifest'/.test(filter)) return manifestB64 ? [{ webresourceid: 'wr-m', content: manifestB64 }] : []; return []; }
      if (e === 'systemform') return [];
      if (e === 'savedquery') return [{ savedqueryid: 'defview-x', isdefault: true }];
      return [{ publisherid: 'pub-1' }];
    },
    findArtifact: async () => null,
    fetchArtifact: async (t, id) => { if (!store[`${t}:${id}`]) store[`${t}:${id}`] = { id, siteMap: { areas: [] } }; return store[`${t}:${id}`]; },
    createPublisher: async () => ({ id: 'pub-new' }), createSolution: async () => ({ id: 'sol-1' }),
    findTables: async () => [], findColumns: async () => [],
    fetchEntityMetadata: async (l) => ({ logicalName: l, entitySetName: `${l}s`, attributes: [], relationships: [] }),
    createTable: async (o) => ({ logicalName: o.schemaName.toLowerCase(), entitySetName: `${o.schemaName.toLowerCase()}s`, metadataId: 't' }),
    createColumn: async (e, o) => ({ logicalName: o.schemaName.toLowerCase(), metadataId: 'c' }),
    createRelationship: async (o) => ({ schemaName: o.schemaName }),
    createWebResource: async (o) => { calls.push({ name: 'createWebResource', args: [o] }); if (/_pagemanifest$/.test(o.name)) manifestB64 = Buffer.from(o.content, 'utf8').toString('base64'); return { id: 'wr-m', name: o.name }; },
    updateWebResource: async (id, o) => { calls.push({ name: 'updateWebResource', args: [id, o] }); manifestB64 = Buffer.from(o.content, 'utf8').toString('base64'); return {}; },
    enrichDefaultViews: async () => ({ updated: [] }),
    createArtifact: (t, def) => { const id = `${t}-1`; store[`${t}:${id}`] = Object.assign({ id }, def); return JSON.parse(JSON.stringify(store[`${t}:${id}`])); },
    getArtifact: (t, id) => store[`${t}:${id}`] || { id },
    addElement: () => ({}), updateElement: (t, id, ptr, patch) => { calls.push({ name: 'updateElement', args: [t, id, ptr, patch] }); },
    removeElement: () => ({}),
    pushArtifact: async (t, id) => ({ type: t, id, success: true }),
    addSolutionComponent: async () => {}, publishArtifact: async () => {},
  };
  const genpageCli = {
    uploads: [],
    list: async () => live.slice(),
    enumerate: async () => ({ ok: true, pages: live.slice(), empty: live.length === 0 }),
    upload: async (o) => {
      const pageId = o.pageId || `gp-${String(o.name).toLowerCase()}`;
      genpageCli.uploads.push({ name: o.name, requestedId: o.pageId, resolvedId: pageId });
      calls.push({ name: 'upload', args: [o.name] });
      if (!o.pageId && !live.some((p) => p.name === o.name)) live.push({ pageId, name: o.name });
      return { pageId };
    },
  };
  return { sdk, genpageCli, calls, live };
}

const NAV = (key) => `Xrm.Navigation.navigateTo({ pageType: "generative", pageId: "PAGEREF_${key}", data: {} });`;

// Overview → Detail. Detail (the nav target) is created FIRST in create-absent-first, so the "first create"
// is Detail; Overview is created (or updated) in upload-once.
function twoPageApp() {
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pages-order-'));
  fs.writeFileSync(path.join(appDir, 'overview.tsx'), `export default function O(){ ${NAV('detail')} return null; }`, 'utf8');
  fs.writeFileSync(path.join(appDir, 'detail.tsx'), 'export default function D(){ return null; }', 'utf8');
  const spec = {
    schemaVersion: 2, solution: { uniqueName: 'PgOrd', displayName: 'Pg', publisherPrefix: 'contoso' }, app: { name: 'Order App' },
    entities: [{ schemaName: 'contoso_item', displayName: 'Item', primaryAttribute: { schemaName: 'contoso_name', displayName: 'Name' }, columns: [] }],
    pages: [
      { key: 'overview', name: 'Overview', navigatesTo: [{ targetKey: 'detail' }], source: { kind: 'tsx', codeFile: 'overview.tsx' } },
      { key: 'detail', name: 'Detail', source: { kind: 'tsx', codeFile: 'detail.tsx' } },
    ],
    appShell: { areas: [{ label: 'Main', groups: [{ label: 'Pages', subAreas: [{ page: 'overview', title: 'Overview' }, { page: 'detail', title: 'Detail' }] }] }] },
  };
  return { appDir, spec };
}
const PHASES = ['solution', 'data-model', 'app-shell', 'pages'];

test('SEQUENCE: uploads → per-create manifest persist → sitemap finalize; no manifest write after finalize (I6)', async () => {
  const { appDir, spec } = twoPageApp();
  try {
    const h = harness();
    await runSdkBuild(spec, { sdk: h.sdk, apply: true, env: 'https://x', appDir, genpageCli: h.genpageCli, phases: PHASES });
    const idxs = (pred) => h.calls.map((c, i) => (pred(c) ? i : -1)).filter((i) => i >= 0);
    const uploadIdxs = idxs((c) => c.name === 'upload');
    const manifestIdxs = idxs((c) => (c.name === 'createWebResource' && /_pagemanifest$/.test(c.args[0].name)) || c.name === 'updateWebResource');
    const finalizeIdx = h.calls.findIndex((c) => c.name === 'updateElement' && c.args[2] === '/siteMap');
    assert.ok(uploadIdxs.length >= 2 && manifestIdxs.length >= 1 && finalizeIdx >= 0);
    assert.ok(Math.min(...manifestIdxs) > Math.min(...uploadIdxs), 'the first manifest persist follows the first upload (persist-after-each-create)');
    assert.ok(manifestIdxs.every((i) => i < finalizeIdx), 'every manifest write precedes the sitemap finalize (the commit point)');
    assert.ok(uploadIdxs.every((i) => i < finalizeIdx), 'every upload precedes the finalize');
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

test('RESTART-CONVERGENCE: a halt directly after the FIRST page CREATE re-runs with NO duplicate create (C5)', async () => {
  const { appDir, spec } = twoPageApp();
  try {
    const h = harness();
    let n = 0;
    const realUpload = h.genpageCli.upload;
    h.genpageCli.upload = async (o) => { n += 1; if (n === 2) throw new Error('crash directly after the first page create'); return realUpload(o); };
    await assert.rejects(runSdkBuild(spec, { sdk: h.sdk, apply: true, env: 'https://x', appDir, genpageCli: h.genpageCli, phases: PHASES }));
    const created1 = h.genpageCli.uploads.filter((u) => !u.requestedId);
    assert.strictEqual(created1.length, 1, 'exactly ONE create landed before the crash; the manifest was persisted right after it');
    const firstName = created1[0].name; // 'Detail' (the absent nav target minted first)
    // Re-run the FULL build. Enumeration + the persisted manifest bind the created page → it is only
    // UPDATEd this run, and the un-created page is created once. No duplicate of the first page.
    h.genpageCli.upload = realUpload;
    const before = h.genpageCli.uploads.length;
    await runSdkBuild(spec, { sdk: h.sdk, apply: true, env: 'https://x', appDir, genpageCli: h.genpageCli, phases: PHASES });
    const run2 = h.genpageCli.uploads.slice(before);
    assert.ok(run2.filter((u) => u.name === firstName).every((u) => !!u.requestedId), 'the already-created page is only UPDATEd in run 2 (seeded from the persisted manifest + enumeration)');
    assert.strictEqual(h.live.filter((p) => p.name === firstName).length, 1, 'the first page exists exactly once — no duplicate');
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

test('FAILURE-ORDER: an upload failure before the finalize leaves the sitemap unwritten', async () => {
  const { appDir, spec } = twoPageApp();
  try {
    const h = harness();
    const realUpload = h.genpageCli.upload;
    h.genpageCli.upload = async (o) => { if (o.name === 'Overview' && o.codeFile && /pageref-deploy/.test(o.codeFile)) throw new Error('pac upload failed'); return realUpload(o); };
    await assert.rejects(runSdkBuild(spec, { sdk: h.sdk, apply: true, env: 'https://x', appDir, genpageCli: h.genpageCli, phases: PHASES }));
    assert.ok(!h.calls.some((c) => c.name === 'updateElement' && c.args[2] === '/siteMap'), 'the sitemap is NOT finalized when an upload fails before the commit point');
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

test('CONCURRENCY: a second build HALTs (pages-locked) while a FRESH app-scoped lock is held (I4)', async () => {
  const { appDir, spec } = twoPageApp();
  try {
    const wsDir = path.join(appDir, '.maker-workspace');
    fs.mkdirSync(wsDir, { recursive: true });
    fs.writeFileSync(path.join(wsDir, `pages-${appUniqueName(spec).replace(/[^A-Za-z0-9_-]/g, '_')}.lock`), JSON.stringify({ pid: 999999, at: Date.now() }));
    const h = harness();
    await assert.rejects(
      runSdkBuild(spec, { sdk: h.sdk, apply: true, env: 'https://x', appDir, genpageCli: h.genpageCli, phases: PHASES }),
      (e) => e && e.phase === 'pages' && e.code === 'pages-locked'
    );
    assert.strictEqual(h.genpageCli.uploads.length, 0, 'no page uploaded while the lease is held by another build');
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

// Direct unit tests of the DESCOPED advisory lease (review R2 Critical 3): never steals a fresh lock,
// reclaims only by age, owner-checked release.
test('LEASE: a FRESH lock HALTs a second acquire (never steals); release then allows re-acquire', () => {
  const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lease-'));
  try {
    const now = () => 1000;
    const a = acquireAppPagesLease(wsDir, 'app', { now, staleMs: 100000 });
    assert.throws(() => acquireAppPagesLease(wsDir, 'app', { now, staleMs: 100000 }), (e) => e && e.code === 'pages-locked');
    a.release();
    const b = acquireAppPagesLease(wsDir, 'app', { now, staleMs: 100000 });
    b.release();
  } finally { fs.rmSync(wsDir, { recursive: true, force: true }); }
});

test('LEASE: a STALE lock (age > staleMs) is reclaimed by age (single atomic attempt, no steal loop)', () => {
  const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lease-'));
  try {
    acquireAppPagesLease(wsDir, 'app', { now: () => 0, staleMs: 100 }); // held at t=0, never released
    const b = acquireAppPagesLease(wsDir, 'app', { now: () => 100000, staleMs: 100 }); // stale → reclaimed
    assert.ok(b && typeof b.release === 'function');
    b.release();
  } finally { fs.rmSync(wsDir, { recursive: true, force: true }); }
});

test('LEASE: release is owner-checked — it does NOT remove a lock a different pid now holds', () => {
  const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lease-'));
  try {
    const lease = acquireAppPagesLease(wsDir, 'app', { now: () => 0, staleMs: 100000 });
    const lockPath = path.join(wsDir, 'pages-app.lock');
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid + 1, at: Date.now() })); // another build took over
    lease.release();
    assert.ok(fs.existsSync(lockPath), 'release did not delete a lock now owned by a different pid');
  } finally { fs.rmSync(wsDir, { recursive: true, force: true }); }
});
```

- [ ] **Step 3: Run — the ordering + lease tests should PASS on Task 8's protocol**

Run: `node --test scripts/tests/sdk-build-pages-order.test.js`
Expected: PASS (Task 8 already implements the lease, the persist-after-each-create order, and forward-only convergence — this task locks them with tests).

- [ ] **Step 4: I1 — broad apply-range guard** — add the failing test to `scripts/tests/build-model-app.test.js`

```javascript
test('I1: apply refuses ANY partial phase range except the full build or exactly --stage data', async () => {
  const spec = { solution: { uniqueName: 'S', publisherPrefix: 'new' }, app: { name: 'A' }, entities: [{ schemaName: 'new_x', primaryAttribute: { schemaName: 'new_name' }, columns: [] }], pages: [{ key: 'p', name: 'P', source: { kind: 'tsx', codeFile: 'p.tsx' } }], appShell: { areas: [] } };
  for (const phases of [['pages'], ['views', 'charts'], ['app-shell', 'pages', 'ai-features']]) {
    const r = await buildModelApp(spec, { apply: true, phases }, { log: () => {} });
    assert.strictEqual(r.ok, false, `should reject apply with phases=${phases}`);
    assert.ok(/partial|full build|stage data/i.test(r.errors.join(' ')));
  }
});
```

Run: `node --test scripts/tests/build-model-app.test.js` → FAIL.

Implement in `scripts/build-model-app.js` — import `PHASES`, `STAGES` from `./lib/stages.js`, then add the guard near the top of `buildModelApp` (before the preflight safety gate, `:148`):

```javascript
  // I1: on APPLY, the ONLY safe phase selections are the FULL build or EXACTLY the `data` stage
  // (solution+data-model+sample-data). Every other partial range (--from/--to/--only/--skip, or any other
  // --stage) is dry-run-only (design §14): its range is not dependency-closed and the app id is not carried
  // across runs, so applying it would run phases against an incomplete result map. Recovery from a halt is
  // a FULL rerun (idempotent), never --from pages.
  if (opts.apply) {
    const active = opts.phases || PHASES;
    const sameSet = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
    if (!sameSet(active, PHASES) && !sameSet(active, STAGES.data)) {
      const msg = `refusing to apply a partial phase range (${active.join(',')}) — on --apply only a FULL build or exactly --stage data is allowed (design §14). The app id is not carried across runs, so recover from a halt with a FULL rerun (idempotent), not --from/--to/--only/--skip.`;
      log(`\n✗ ${msg}`);
      if (journal) journal.close({ status: 'halt', phase: 'preflight', label: 'partial-apply-range', detail: active.join(',') });
      return { ok: false, errors: [msg] };
    }
  }
```

> This replaces the narrower "pages without app-shell" CLI guard; the engine's `pages-requires-app` HALT (Task 5) remains the deeper safety net. Existing apply tests pass `phases: undefined` (→ full `PHASES`), so they are unaffected.

Run: `node --test scripts/tests/build-model-app.test.js` → PASS.

- [ ] **Step 5: Full suite** — `node scripts/run-tests.js` → PASS (≈ 642).

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/sdk-build.js scripts/build-model-app.js scripts/tests/sdk-build-pages-order.test.js scripts/tests/build-model-app.test.js
git commit -m "test(model-apps): pages ordering, crash-after-first-create convergence, lease guarantees + apply-range guard" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>" \
  -m "Copilot-Session: 42626da2-b66f-4162-acaa-b1127ef23d89"
```

---

## Task 10: C1/C6 — structural page verification (nav edge → ACTUAL GenPageId) + mandatory fail-closed gate

Adds the promised-but-missing verification, built on the **single structural oracle**: `verifySpec` checks that **every declared nav edge resolves to the actual target page's live `GenPageId` at a real nav call site** (a decoy/comment guid or a stale/wrong id FAILS), matches the sitemap on the **`GenPageId` attribute only**, and **fails closed** when a page-bearing spec's reader can't enumerate. The build gate becomes **mandatory + fail-closed** (`r.verify={ok:false,unableToRun:true}` → non-zero exit, never skip), the fictional `deps.runBuild` seam is **wired**, and the missing `verify-model-app.test.js` is created.

**Files:**
- Modify: `scripts/lib/verify-spec.js` — page branch (structural, via `extractNavTargets`) + `subareaHasGenPage` (matches `GenPageId` only) + `appShellReferencesPage`; import `normalizePageSource`, `extractNavTargets`.
- Modify: `scripts/verify-model-app.js` — `appIdFor`; `readerFor(sdk, appUnique, { genpageCli, workspaceDir })` gains fail-closed `pages()` + cached `pageCode()`; `main` builds a `genpageCli` + workspace.
- Modify: `scripts/build-model-app.js` — **wire `deps.runBuild || runSdkBuild`**; mandatory + fail-closed page verify; pass `{ genpageCli, workspaceDir }` to `readerFor`; import `normalizePageSource`, `makeGenpageCli`.
- Modify: `scripts/tests/verify-spec.test.js`, `scripts/tests/build-model-app.test.js` — new assertions.
- Create: `scripts/tests/verify-model-app.test.js` (**it does not exist today**).

**Interfaces:**
- `read.pages() → [{ pageId, name }]` (throws fail-closed on an enumeration failure); `read.pageCode(pageId) → string` (throws on a download failure; download cached once).
- `verifySpec` adds checks: `page` (exists), `page-subarea` (`GenPageId` bound), `page-no-pageref` (no residual/malformed nav `PAGEREF_`), `page-nav` (edge → ACTUAL target id at a real nav call site), `page-code` (download failure), `page-verify` (reader can't enumerate → unable-to-run).

- [ ] **Step 1: Write the failing `verifySpec` tests** — append to `scripts/tests/verify-spec.test.js`

```javascript
// Minimal read mock: satisfies entity/column/sitemap reads + the new page reader. Sitemap binds pages via
// the GenPageId attribute (the real SDK attribute, vendor cds-maker-sdk.cjs:50).
function pageRead({ live, code, sitemap }) {
  return {
    findTable: async () => ({ logicalName: 'contoso_item' }),
    findColumns: async () => [],
    queryRecords: async () => [],
    sitemapXml: async () => sitemap || '',
    pages: async () => live,
    pageCode: async (id) => (code && code[String(id).toLowerCase()]) || '',
  };
}
function pageSpec(navTargets = [{ targetKey: 'detail' }]) {
  return {
    entities: [{ schemaName: 'contoso_item', primaryAttribute: { schemaName: 'contoso_name' }, columns: [] }],
    schemaVersion: 2,
    pages: [
      { key: 'overview', name: 'Overview', navigatesTo: navTargets, source: { kind: 'tsx', codeFile: 'overview.tsx' } },
      { key: 'detail', name: 'Detail', source: { kind: 'tsx', codeFile: 'detail.tsx' } },
    ],
    appShell: { areas: [{ label: 'M', groups: [{ label: 'G', subAreas: [{ page: 'overview', title: 'Overview' }, { page: 'detail', title: 'Detail' }] }] }] },
  };
}
const SITEMAP_OK = '<SiteMap><Area><Group><SubArea Id="s1" GenPageId="gp-overview"/><SubArea Id="s2" GenPageId="gp-detail"/></Group></Area></SiteMap>';
const NAV_TO = (id) => `Xrm.Navigation.navigateTo({ pageType: "generative", pageId: "${id}", data: {} });`;
const { verifySpec } = require('../lib/verify-spec.js');

test('verifySpec pages: present + GenPageId-bound + nav edge resolves to the actual target id → ok', async () => {
  const live = [{ pageId: 'gp-overview', name: 'Overview' }, { pageId: 'gp-detail', name: 'Detail' }];
  const read = pageRead({ live, sitemap: SITEMAP_OK, code: { 'gp-overview': NAV_TO('gp-detail') } });
  const r = await verifySpec(pageSpec(), read);
  assert.ok(r.checks.some((c) => c.kind === 'page' && c.name === 'Overview' && c.present));
  assert.ok(r.checks.some((c) => c.kind === 'page-subarea' && c.name === 'Overview' && c.present));
  assert.ok(r.checks.some((c) => c.kind === 'page-nav' && c.name === 'Overview -> detail' && c.present));
  assert.ok(r.checks.filter((c) => c.kind.startsWith('page')).every((c) => c.present), 'all page checks present');
});

test('verifySpec pages: a WRONG deployed GUID in the nav literal FAILS the nav check (C1 wrong-GUID)', async () => {
  const live = [{ pageId: 'gp-overview', name: 'Overview' }, { pageId: 'gp-detail', name: 'Detail' }];
  const read = pageRead({ live, sitemap: SITEMAP_OK, code: { 'gp-overview': NAV_TO('00000000-dead-beef-0000-000000000000') } });
  const r = await verifySpec(pageSpec(), read);
  assert.ok(r.checks.some((c) => c.kind === 'page-nav' && c.name === 'Overview -> detail' && !c.present), 'nav edge must resolve to the ACTUAL target id');
  assert.strictEqual(r.ok, false);
});

test('verifySpec pages: the correct target id only in a COMMENT (not a nav call site) FAILS the edge (C1 structural oracle)', async () => {
  const live = [{ pageId: 'gp-overview', name: 'Overview' }, { pageId: 'gp-detail', name: 'Detail' }];
  const read = pageRead({ live, sitemap: SITEMAP_OK, code: { 'gp-overview': `// go to gp-detail\n${NAV_TO('some-other-id')}` } });
  const r = await verifySpec(pageSpec(), read);
  assert.ok(r.checks.some((c) => c.kind === 'page-nav' && !c.present), 'a decoy id in a comment does not satisfy the edge');
  assert.strictEqual(r.ok, false);
});

test('verifySpec pages: a residual PAGEREF_ in deployed nav code FAILS the no-pageref check', async () => {
  const live = [{ pageId: 'gp-overview', name: 'Overview' }, { pageId: 'gp-detail', name: 'Detail' }];
  const read = pageRead({ live, sitemap: SITEMAP_OK, code: { 'gp-overview': NAV_TO('PAGEREF_detail') } });
  const r = await verifySpec(pageSpec(), read);
  assert.ok(r.checks.some((c) => c.kind === 'page-no-pageref' && !c.present));
  assert.strictEqual(r.ok, false);
});

test('verifySpec pages: a page missing from the live enumeration FAILS the page check', async () => {
  const read = pageRead({ live: [{ pageId: 'gp-detail', name: 'Detail' }], sitemap: '', code: {} });
  const r = await verifySpec(pageSpec(), read);
  assert.ok(r.checks.some((c) => c.kind === 'page' && c.name === 'Overview' && !c.present));
  assert.strictEqual(r.ok, false);
});

test('verifySpec pages: the sitemap subarea check matches the GenPageId attribute ONLY (a decoy attr does not satisfy it)', async () => {
  const live = [{ pageId: 'gp-overview', name: 'Overview' }, { pageId: 'gp-detail', name: 'Detail' }];
  // gp-overview appears in a DECOY attribute, not GenPageId → the subarea binding must be reported missing.
  const sitemap = '<SiteMap><Area><Group><SubArea Id="s1" Url="gp-overview"/><SubArea Id="s2" GenPageId="gp-detail"/></Group></Area></SiteMap>';
  const read = pageRead({ live, sitemap, code: { 'gp-overview': NAV_TO('gp-detail') } });
  const r = await verifySpec(pageSpec(), read);
  assert.ok(r.checks.some((c) => c.kind === 'page-subarea' && c.name === 'Overview' && !c.present), 'only a GenPageId="…" binding counts');
});

test('verifySpec pages: FAIL-CLOSED when the reader cannot enumerate pages (C6 unable-to-run)', async () => {
  const read = { findTable: async () => ({ logicalName: 'contoso_item' }), findColumns: async () => [], queryRecords: async () => [], sitemapXml: async () => '' }; // NO pages()
  const r = await verifySpec(pageSpec(), read);
  assert.ok(r.checks.some((c) => c.kind === 'page-verify' && !c.present), 'a page-bearing spec with no page reader must fail, not silently pass');
  assert.strictEqual(r.ok, false);
});
```

- [ ] **Step 2: Run to verify failure** — `node --test scripts/tests/verify-spec.test.js` → FAIL (no page branch).

- [ ] **Step 3: Add the page branch to `scripts/lib/verify-spec.js`**

Imports (top):

```javascript
const { normalizePageSource } = require('./app-spec.js');
const { extractNavTargets } = require('./pageref-resolver.js');
```

Add the page branch inside `verifySpec` (after the sitemap-subarea loop, before `const missing = ...`):

```javascript
  // Pages (design §13.1). When the spec declares implemented pages the reader MUST be able to read them:
  // if it lacks a page enumeration, verification CANNOT run and must FAIL (fail-closed, C6), not silently
  // pass. read.pages()/read.pageCode() themselves throw on an enumeration/download failure — the mandatory
  // build gate turns that into a non-zero exit.
  const implementedPages = (spec.pages || []).filter((p) => { const s = normalizePageSource(p); return s && s.kind === 'tsx' && s.codeFile; });
  if (implementedPages.length) {
    if (!read.pages) {
      add('page-verify', 'pages', false, 'the verify reader cannot enumerate pages (unable to run)');
    } else {
      const live = (await read.pages()) || [];
      const liveByName = new Map(live.filter((p) => p.name && p.pageId).map((p) => [p.name, p.pageId]));
      const idForKey = (key) => { const pg = (spec.pages || []).find((p) => (p.key || p.name) === key); return pg ? liveByName.get(pg.name) : undefined; };
      for (const p of implementedPages) {
        const key = p.key || p.name;
        const pageId = liveByName.get(p.name);
        add('page', p.name, !!pageId);
        if (!pageId) continue;
        if (appShellReferencesPage(spec, key)) add('page-subarea', p.name, subareaHasGenPage(xml, pageId));
        const nav = p.navigatesTo || [];
        if (!nav.length) continue;
        let code;
        try { code = (await read.pageCode(pageId)) || ''; }
        catch (e) { add('page-code', p.name, false, String((e && e.message) || e)); continue; }
        // The SINGLE structural oracle: parse the deployed page's real navigateTo call sites.
        const targets = extractNavTargets(code);
        // No residual/malformed nav PAGEREF means the resolve+upload step actually ran on this page.
        add('page-no-pageref', p.name, !targets.some((t) => t.kind === 'pageref' || t.kind === 'pageref-malformed'));
        // Every declared edge must resolve to the ACTUAL target's live GenPageId at a REAL nav call site.
        // A decoy/comment guid, a stale/wrong id, or a dynamic pageId all FAIL (C1).
        const navLiteralIds = new Set(targets.filter((t) => t.kind === 'literal').map((t) => String(t.pageId).toLowerCase()));
        for (const edge of nav) {
          const targetId = idForKey(edge.targetKey);
          add('page-nav', `${p.name} -> ${edge.targetKey}`, !!targetId && navLiteralIds.has(String(targetId).toLowerCase()));
        }
      }
    }
  }
```

Add the two helpers (near `subareaHasDashboard`) + export them:

```javascript
// True when any appShell subarea targets this page key (so the sitemap must bind its GenPageId).
function appShellReferencesPage(spec, key) {
  for (const a of (spec.appShell && spec.appShell.areas) || [])
    for (const g of a.groups || [])
      for (const s of g.subAreas || []) if (s && s.page === key) return true;
  return false;
}

// True when some sitemap <SubArea GenPageId="<id>"> binds this page id. A generative-page subarea stores
// its id in the GenPageId attribute SPECIFICALLY (vendor cds-maker-sdk.cjs:50 parses
// /GenPageId="([0-9a-fA-F-]{36})"/), so match THAT attribute only — a decoy id elsewhere on the SubArea
// start-tag (a Url, an Id) must NOT satisfy the check. Braces stripped, case-insensitive.
function subareaHasGenPage(xml, genPageId) {
  const norm = (s) => String(s).replace(/[{}]/g, '').toLowerCase();
  const target = norm(genPageId);
  const re = /<SubArea\b[^>]*\bGenPageId="([^"]*)"[^>]*>/gi;
  let m;
  while ((m = re.exec(String(xml || ''))) !== null) if (norm(m[1]) === target) return true;
  return false;
}
```

Update `module.exports` to include `subareaHasGenPage`, `appShellReferencesPage`.

Run: `node --test scripts/tests/verify-spec.test.js` → PASS.

- [ ] **Step 4: Fail-closed page reader + cached download** — create `scripts/tests/verify-model-app.test.js` (**new file**)

```javascript
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { readerFor } = require('../verify-model-app.js');

function stubSdk() { return { queryRecords: async () => [{ appmoduleid: 'app-1' }], findTables: async () => [], findColumns: async () => [] }; }

test('readerFor.pages() HALTS fail-closed when enumeration fails', async () => {
  const reader = readerFor(stubSdk(), 'contoso_app', { genpageCli: { enumerate: async () => ({ ok: false, error: 'auth expired' }) }, workspaceDir: fs.mkdtempSync(path.join(os.tmpdir(), 'vf-')) });
  await assert.rejects(reader.pages(), /enumeration failed/i);
});

test('readerFor.pageCode downloads ONCE (cached) and returns the page code; a download failure throws', async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-'));
  let downloads = 0;
  const genpageCli = {
    enumerate: async () => ({ ok: true, pages: [{ pageId: 'gp-1', name: 'Overview' }] }),
    download: async ({ outputDir }) => { downloads += 1; fs.mkdirSync(path.join(outputDir, 'gp-1'), { recursive: true }); fs.writeFileSync(path.join(outputDir, 'gp-1', 'page.tsx'), 'pageId: "gp-2"', 'utf8'); return true; },
  };
  const reader = readerFor(stubSdk(), 'contoso_app', { genpageCli, workspaceDir: ws });
  assert.strictEqual(await reader.pageCode('gp-1'), 'pageId: "gp-2"');
  await reader.pageCode('gp-1');
  assert.strictEqual(downloads, 1, 'download runs once and is cached');

  const failing = readerFor(stubSdk(), 'contoso_app', { genpageCli: { enumerate: async () => ({ ok: true, pages: [] }), download: async () => { throw new Error('pac download failed'); } }, workspaceDir: fs.mkdtempSync(path.join(os.tmpdir(), 'vf-')) });
  await assert.rejects(failing.pageCode('gp-1'), /download failed/i);
});

test('readerFor WITHOUT a genpageCli has no pages() — verifySpec then fails closed for a page-bearing spec', () => {
  const reader = readerFor(stubSdk(), 'contoso_app', {});
  assert.strictEqual(typeof reader.pages, 'undefined', 'no page reader when no genpageCli is wired (drives the C6 unable-to-run path)');
});
```

Run: `node --test scripts/tests/verify-model-app.test.js` → FAIL (no `pages`/`pageCode`).

Implement in `scripts/verify-model-app.js`:

```javascript
const { makeGenpageCli } = require('./lib/genpage-cli.js'); // add to imports

// Resolve the app module id (needed by genpage enumerate/download).
async function appIdFor(sdk, appUnique) {
  const rows = await sdk.queryRecords('appmodule', { select: ['appmoduleid'], filter: `uniquename eq '${odataLit(appUnique)}'`, top: 1 });
  return rows && rows[0] && rows[0].appmoduleid;
}

function readerFor(sdk, appUnique, opts = {}) {
  const genpageCli = opts.genpageCli;
  const workspaceDir = opts.workspaceDir;
  let appIdP;
  const appId = () => (appIdP || (appIdP = appIdFor(sdk, appUnique)));
  let downloadP;
  const codeById = new Map();
  // Download EVERY page once, cache by id. Fail-closed: a download failure rejects, so pageCode() throws
  // and (design §13.1) the mandatory page-verify gate turns that into a non-zero build exit.
  const ensureDownloaded = () => (downloadP || (downloadP = (async () => {
    const id = await appId();
    const outDir = path.join(workspaceDir, 'verify-pages');
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.mkdirSync(outDir, { recursive: true });
    await genpageCli.download({ appId: id, outputDir: outDir });
    for (const entry of fs.readdirSync(outDir)) {
      const tsx = path.join(outDir, entry, 'page.tsx');
      if (fs.existsSync(tsx)) codeById.set(String(entry).toLowerCase(), fs.readFileSync(tsx, 'utf8'));
    }
  })()));
  const base = {
    findTable: async (logical) => { const l = String(logical).toLowerCase(); const t = await sdk.findTables(l); return (t || []).find((x) => String(x.logicalName).toLowerCase() === l) || null; },
    findColumns: async (logical) => sdk.findColumns(logical),
    queryRecords: (set, o) => sdk.queryRecords(set, o),
    sitemapXml: () => sitemapXmlFor(sdk, appUnique),
  };
  // Only expose the page reader when a genpageCli is wired — absent it, verifySpec fails closed (C6).
  if (genpageCli) {
    base.pages = async () => { const r = await genpageCli.enumerate({ appId: await appId() }); if (!r.ok) throw new Error(`page enumeration failed during verify: ${r.error || 'pac genpage list returned non-zero'}`); return r.pages; };
    base.pageCode = async (pageId) => { await ensureDownloaded(); return codeById.get(String(pageId).toLowerCase()) || ''; };
  }
  return base;
}
```

In `main()`, build the reader with a genpageCli + workspace:

```javascript
  const genpageCli = makeGenpageCli(env);
  const r = await verifySpec(spec, readerFor(sdk, appUniqueName(spec), { genpageCli, workspaceDir }));
```

Run: `node --test scripts/tests/verify-model-app.test.js` → PASS.

- [ ] **Step 5: Wire `deps.runBuild` + mandatory + fail-closed page verify** — append the failing tests to `scripts/tests/build-model-app.test.js`

```javascript
const { PHASES } = require('../lib/stages.js');
function pageBearingSpec() {
  return { solution: { uniqueName: 'S', publisherPrefix: 'new' }, app: { name: 'A' }, entities: [{ schemaName: 'new_x', primaryAttribute: { schemaName: 'new_name' }, columns: [] }],
    pages: [{ key: 'p', name: 'P', source: { kind: 'tsx', codeFile: 'p.tsx' } }],
    appShell: { areas: [{ label: 'M', groups: [{ label: 'G', subAreas: [{ page: 'p', title: 'P' }] }] }] } };
}

test('page verify is MANDATORY even without --verify: a failing page verify exits non-zero (C6)', async () => {
  const deps = { log: () => {}, runBuild: async () => ({ ok: true, dryRun: false, created: { app: 'app-1' } }), verify: async () => ({ ok: false, checks: [{ kind: 'page', name: 'P' }], missing: [{ kind: 'page', name: 'P' }] }) };
  const r = await buildModelApp(pageBearingSpec(), { apply: true, phases: PHASES, verify: false }, deps);
  assert.strictEqual(r.verify.ok, false, 'page verify ran and failed despite --verify not being set');
});

test('page verify is FAIL-CLOSED: a verify that throws is fatal for a page-bearing spec (C6 unableToRun)', async () => {
  const deps = { log: () => {}, runBuild: async () => ({ ok: true, dryRun: false, created: { app: 'app-1' } }), verify: async () => { throw new Error('page enumeration failed during verify'); } };
  const r = await buildModelApp(pageBearingSpec(), { apply: true, phases: PHASES, verify: false }, deps);
  assert.strictEqual(r.verify.ok, false);
  assert.ok(r.verify.unableToRun, 'an unrunnable verify is fatal for pages');
});

test('page verify is FAIL-CLOSED: a page-bearing spec with NO verifier wired is unable-to-run (C6)', async () => {
  const deps = { log: () => {}, runBuild: async () => ({ ok: true, dryRun: false, created: { app: 'app-1' } }) };
  const r = await buildModelApp(pageBearingSpec(), { apply: true, phases: PHASES, verify: false }, deps);
  assert.strictEqual(r.verify.ok, false);
  assert.ok(r.verify.unableToRun);
});
```

> These use the now-wired `deps.runBuild` seam to inject a successful apply (production defaults `deps.runBuild` to `runSdkBuild`). `phases: PHASES` is the full set, so the Task 9 apply-range guard admits it.

Run: `node --test scripts/tests/build-model-app.test.js` → FAIL.

Implement in `scripts/build-model-app.js`:

(a) Imports: add `normalizePageSource` (from `./lib/app-spec.js`) and `makeGenpageCli` (from `./lib/genpage-cli.js`).

(b) Wire the build seam — replace the `r = await runSdkBuild(spec, {…})` call (`:210-221`) so it goes through an injectable `runBuild`:

```javascript
  const runBuild = deps.runBuild || runSdkBuild; // injectable apply seam (tests); production = runSdkBuild
  // … inside the retry loop:
      r = await runBuild(spec, { sdk: deps.sdk, provisionSdk: deps.provisionSdk, apply: opts.apply, sampleData: opts.sampleData, publish: opts.publish, phases: opts.phases, appDir: opts.appDir, env: opts.env, workspaceDir: opts.workspaceDir, genpageCli: deps.genpageCli, emit });
```

(c) Replace the post-apply verify block (`:245-256`) with the mandatory + fail-closed version:

```javascript
    const hasImplementedPages = (spec.pages || []).some((p) => { const s = normalizePageSource(p); return s && s.kind === 'tsx' && s.codeFile; });
    // Page verify is MANDATORY + FAIL-CLOSED when the spec has implemented pages (design §13.1, C6): it runs
    // even without --verify, and a verify that CANNOT run (no verifier wired, or verifySpec throws — e.g. a
    // page enumeration/download failure) yields r.verify={ok:false,unableToRun:true} → non-zero exit, so an
    // unreadable page set never passes silently. A page-less spec keeps today's opt-in (--verify) behavior.
    if (opts.verify || hasImplementedPages) {
      if (!deps.verify) {
        if (hasImplementedPages) {
          log('\n✗ page verification is required but no verifier is wired — cannot confirm the deployed pages');
          r.verify = { ok: false, present: 0, total: 0, missing: ['verify-unrunnable:no verifier'], unableToRun: true };
          if (journal) journal.record({ phase: 'verify', status: 'error', label: 'verify could not run', detail: 'no verifier wired' });
        }
      } else {
        try {
          const vr = await deps.verify(spec);
          const present = vr.checks.length - vr.missing.length;
          log(`\n${vr.ok ? '✓ verify PASS' : `✗ verify FAIL — ${vr.missing.length} missing`} (${present}/${vr.checks.length} present)`);
          if (!vr.ok) for (const m of vr.missing) log(`  ✗ ${m.kind}: ${m.name}`);
          r.verify = { ok: vr.ok, present, total: vr.checks.length, missing: vr.missing.map((m) => `${m.kind}:${m.name}`) };
          if (journal) journal.record({ phase: 'verify', status: vr.ok ? 'ok' : 'error', label: `verify ${present}/${vr.checks.length} present`, ...(vr.ok ? {} : { detail: r.verify.missing.join(', ') }) });
        } catch (e) {
          if (hasImplementedPages) {
            log(`\n✗ page verification could not run (build applied, but the deployed pages are unverifiable): ${(e && e.message) || e}`);
            r.verify = { ok: false, present: 0, total: 0, missing: [`verify-unrunnable:${(e && e.message) || e}`], unableToRun: true };
            if (journal) journal.record({ phase: 'verify', status: 'error', label: 'verify could not run', detail: String((e && e.message) || e) });
          } else {
            log(`\n⚠ verify step could not run (build itself succeeded): ${(e && e.message) || e}`);
          }
        }
      }
    }
```

(d) Thread `{ genpageCli, workspaceDir }` into the `readerFor` call in `main()` (`:339`):

```javascript
      verify: (s) => verifySpec(s, readerFor(provisionSdk, appUniqueName(s), { genpageCli: makeGenpageCli(env), workspaceDir })),
```

Run: `node --test scripts/tests/build-model-app.test.js` → PASS.

- [ ] **Step 6: Full suite** — `node scripts/run-tests.js` → PASS (≈ 653).

- [ ] **Step 7: Commit**

```bash
git add scripts/lib/verify-spec.js scripts/verify-model-app.js scripts/build-model-app.js scripts/tests/verify-spec.test.js scripts/tests/verify-model-app.test.js scripts/tests/build-model-app.test.js
git commit -m "feat(model-apps): structural page verification (nav edge->actual GenPageId) + mandatory fail-closed gate (C1/C6)" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>" \
  -m "Copilot-Session: 42626da2-b66f-4162-acaa-b1127ef23d89"
```

---

## Task 11: Critical 2 / I3 — manifest-aware download round-trip (enumerate-first, exact equality, reconcile, structural reverse)

Closes the round-trip and stops the **silent page-dropping** bug: `download-model-app.js` currently swallows a download failure (`:171-179`) and produces a spec with **no pages** → a rebuild drops them. The rewrite **enumerates fail-closed FIRST**, cleans the download dir, **fails on any download/read/write error**, requires **exact enumerated↔downloaded id equality (both directions)**, reconciles ids via **`reconcilePageIds`** (not a name-collapsing Map), assigns stable keys, and **structurally** reverse-normalizes only nav `pageId` literals via the single oracle. `hydrate-spec.js` reconstructs the v2 shape.

**Files:**
- Modify: `scripts/download-model-app.js` — import `parseManifestBase64`/`manifestResourceName`/`reconcilePageIds` + `reverseResolveNavIds`; add pure `assignPageKeys(pages, manifest, keyToId)` + `missingDownloads(a, b)`; rewrite the `main` pages block; export the helpers; thread `design` to `hydrateSpec`.
- Modify: `scripts/lib/hydrate-spec.js` — emit the v2 shape (schemaVersion 2, v2 page fields, `source:{kind:'tsx'}`, `design`, key-based GenPage subareas) when pages carry keys; legacy fallback otherwise.
- Modify: `scripts/tests/download-model-app.test.js`, `scripts/tests/hydrate-spec.test.js` — new assertions + the full round-trip.

**Interfaces:**
- `assignPageKeys(pages, manifest, keyToId) → Map<pageId,key>` — for a page bound by `keyToId` (from `reconcilePageIds`) reuses the manifest key + v2 semantics; mints a fresh unique slug key for the rest; returns `idToKey`. Mutates `pages`.
- `missingDownloads(a, b) → [{ pageId, name }]` — entries of `a` whose id is absent from `b` (used both directions for exact-equality).

- [ ] **Step 1: Write the failing tests**

Append to `scripts/tests/download-model-app.test.js`:

```javascript
const { assignPageKeys, missingDownloads } = require('../download-model-app.js');
const { reconcilePageIds, buildManifest } = require('../lib/page-manifest.js');
const { hydrateSpec } = require('../lib/hydrate-spec.js');
const { validateAppSpec } = require('../lib/app-spec.js');
const { resolvePageRefs, reverseResolveNavIds } = require('../lib/pageref-resolver.js');

test('assignPageKeys: reuses the manifest key + v2 semantics for a reconcile-bound page, mints fresh keys otherwise (I3/§7.3)', () => {
  const manifest = { schemaVersion: 1, pages: [{ key: 'overview', name: 'Overview', pageId: 'gp-o', purpose: 'Home', navigatesTo: [{ targetKey: 'detail' }], pageInput: { data: {} } }] };
  const downloaded = [
    { pageId: 'gp-o', name: 'Overview', dataSources: [], codeFile: 'p/gp-o/page.tsx' },
    { pageId: 'gp-x', name: 'Some Legacy Page', dataSources: [], codeFile: 'p/gp-x/page.tsx' },
  ];
  const { keyToId } = reconcilePageIds(manifest.pages, manifest, downloaded);
  const idToKey = assignPageKeys(downloaded, manifest, keyToId);
  assert.strictEqual(downloaded[0].key, 'overview');
  assert.deepStrictEqual(downloaded[0].navigatesTo, [{ targetKey: 'detail' }]);
  assert.strictEqual(downloaded[0].purpose, 'Home');
  assert.strictEqual(downloaded[1].key, 'some-legacy-page', 'a page with no manifest binding gets a fresh slug key, not the old name');
  assert.strictEqual(idToKey.get('gp-o'), 'overview');
  assert.strictEqual(idToKey.get('gp-x'), 'some-legacy-page');
});

test('assignPageKeys: mints unique keys (no manifest) with -N de-dup on slug collision', () => {
  const downloaded = [{ pageId: 'a', name: 'Work Order', dataSources: [], codeFile: 'a' }, { pageId: 'b', name: 'Work Order', dataSources: [], codeFile: 'b' }];
  assignPageKeys(downloaded, null, new Map());
  assert.deepStrictEqual(downloaded.map((p) => p.key), ['work-order', 'work-order-2']);
});

test('missingDownloads flags a gap in EITHER direction (I3 exact enumerated<->downloaded equality)', () => {
  const enumPages = [{ pageId: 'gp-o', name: 'Overview' }, { pageId: 'gp-d', name: 'Detail' }];
  const downloaded = [{ pageId: 'gp-o', name: 'Overview' }];
  assert.deepStrictEqual(missingDownloads(enumPages, downloaded).map((p) => p.pageId), ['gp-d'], 'enumerated-but-not-downloaded');
  assert.deepStrictEqual(missingDownloads(downloaded, enumPages), [], 'downloaded-and-enumerated → no extra');
  assert.deepStrictEqual(missingDownloads(enumPages, enumPages), []);
});

test('ROUND-TRIP: manifest → download → reverse → hydrate → validate → resolve reproduces the deployed ids (Critical 2/I3)', async () => {
  const manifest = buildManifest({ pages: [{ key: 'overview', name: 'Overview', navigatesTo: [{ targetKey: 'detail' }] }, { key: 'detail', name: 'Detail' }] }, new Map([['overview', 'gp-o'], ['detail', 'gp-d']]));
  const deployedOverview = 'Xrm.Navigation.navigateTo({ pageType: "generative", pageId: "gp-d", data: {} });';
  const downloaded = [
    { pageId: 'gp-o', name: 'Overview', dataSources: [], codeFile: 'overview.tsx', _code: deployedOverview },
    { pageId: 'gp-d', name: 'Detail', dataSources: [], codeFile: 'detail.tsx', _code: 'export default function D(){ return null; }' },
  ];
  const { keyToId, ambiguous } = reconcilePageIds(manifest.pages, manifest, downloaded);
  assert.deepStrictEqual(ambiguous, []);
  const idToKey = assignPageKeys(downloaded, manifest, keyToId);
  for (const p of downloaded) p._reversed = reverseResolveNavIds(p._code, idToKey);
  assert.ok(downloaded[0]._reversed.includes('"PAGEREF_detail"'), 'overview nav reversed back to the symbolic key');
  const spec = await hydrateSpec({
    app: async () => ({ name: 'A', description: '', siteMap: { areas: [{ title: 'M', groups: [{ title: 'G', subAreas: [{ type: 'GenPage', genPageId: 'gp-o', title: 'Overview' }, { type: 'GenPage', genPageId: 'gp-d', title: 'Detail' }] }] }] } }),
    pages: async () => downloaded,
    entities: async () => [{ schemaName: 'contoso_item', primaryAttribute: { schemaName: 'contoso_name' }, columns: [] }],
    webResources: async () => [], solution: async () => ({ uniqueName: 'S', publisherPrefix: 'new' }),
    design: async () => manifest.design,
  });
  const v = validateAppSpec(spec, { profile: 'plan' });
  assert.ok(v.ok, v.errors.join('; '));
  assert.strictEqual(spec.pages.find((p) => p.key === 'overview').navigatesTo[0].targetKey, 'detail');
  assert.strictEqual(spec.appShell.areas[0].groups[0].subAreas[0].page, 'overview', 'GenPage subarea resolved by KEY');
  const resolved = resolvePageRefs(new Map([['overview', { code: downloaded[0]._reversed }]]), keyToId).deployment.get('overview');
  assert.ok(resolved.includes('pageId: "gp-d"') && !/PAGEREF_/.test(resolved), 'reverse∘resolve returns the deployed id — the loop is closed');
});
```

Append to `scripts/tests/hydrate-spec.test.js`:

```javascript
test('hydrateSpec emits the v2 shape when pages carry keys (schemaVersion 2, source.kind tsx, design, key subareas)', async () => {
  const read = {
    app: async () => ({ name: 'A', description: '', siteMap: { areas: [{ title: 'M', groups: [{ title: 'G', subAreas: [{ type: 'GenPage', genPageId: 'gp-o', title: 'Overview' }] }] }] } }),
    pages: async () => [{ pageId: 'gp-o', name: 'Overview', key: 'overview', purpose: 'Home', navigatesTo: [{ targetKey: 'detail' }], dataSources: [], codeFile: 'overview.tsx' }],
    entities: async () => [], webResources: async () => [], solution: async () => ({ uniqueName: 'S', publisherPrefix: 'new' }),
    design: async () => ({ theme: 'ocean' }),
  };
  const spec = await hydrateSpec(read);
  assert.strictEqual(spec.schemaVersion, 2);
  assert.deepStrictEqual(spec.design, { theme: 'ocean' });
  assert.strictEqual(spec.pages[0].source.kind, 'tsx');
  assert.strictEqual(spec.pages[0].key, 'overview');
  assert.deepStrictEqual(spec.pages[0].navigatesTo, [{ targetKey: 'detail' }]);
  assert.strictEqual(spec.appShell.areas[0].groups[0].subAreas[0].page, 'overview', 'GenPage subarea resolved by KEY');
});

test('hydrateSpec keeps the legacy name-based shape when pages carry no key (back-compat)', async () => {
  const read = {
    app: async () => ({ name: 'A', description: '', siteMap: { areas: [{ title: 'M', groups: [{ title: 'G', subAreas: [{ type: 'GenPage', genPageId: 'gp-o', title: 'Overview' }] }] }] } }),
    pages: async () => [{ pageId: 'gp-o', name: 'Overview', dataSources: [], codeFile: 'overview.tsx' }],
    entities: async () => [], webResources: async () => [], solution: async () => ({ uniqueName: 'S', publisherPrefix: 'new' }),
  };
  const spec = await hydrateSpec(read);
  assert.strictEqual(spec.schemaVersion, undefined);
  assert.strictEqual(spec.pages[0].codeFile, 'overview.tsx');
  assert.strictEqual(spec.appShell.areas[0].groups[0].subAreas[0].page, 'Overview', 'legacy GenPage subarea resolved by NAME');
});
```

- [ ] **Step 2: Run to verify failure** — `node --test scripts/tests/download-model-app.test.js scripts/tests/hydrate-spec.test.js` → FAIL.

- [ ] **Step 3: Implement `assignPageKeys` + `missingDownloads` + the `main` rewrite in `scripts/download-model-app.js`**

Imports:

```javascript
const { parseManifestBase64, manifestResourceName, reconcilePageIds } = require('./lib/page-manifest.js');
const { reverseResolveNavIds } = require('./lib/pageref-resolver.js');
```

Pure helpers (near `parseDownloadedPages`):

```javascript
// Assign a STABLE key to every downloaded page + carry the manifest's v2 semantics. `keyToId` (from
// reconcilePageIds — the authority: manifest-confirmed-live id → unique live-name, ambiguous already
// HALTed upstream) binds manifest keys to live ids; a page bound there reuses that key + purpose/
// navigatesTo/pageInput/dataSources. A page with NO binding (legacy app / Maker-authored) gets a FRESH
// unique slug key (design §7.3 — NOT the old name shape, which drifted on rename). Returns idToKey for
// reverse-normalizing nav literals. Mutates pages. This uses reconcilePageIds, NOT a name-collapsing Map.
function assignPageKeys(pages, manifest, keyToId) {
  const idToKey = new Map();
  const used = new Set();
  const manifestByKey = new Map(((manifest && manifest.pages) || []).map((m) => [m.key, m]));
  for (const [key, id] of (keyToId || new Map())) { idToKey.set(String(id).toLowerCase(), key); used.add(key); }
  const mint = (name) => { const base = String(name || 'page').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'page'; let k = base, i = 2; while (used.has(k)) k = `${base}-${i++}`; used.add(k); return k; };
  for (const p of pages) {
    const bound = idToKey.get(String(p.pageId).toLowerCase());
    if (!bound) continue;
    p.key = bound;
    const m = manifestByKey.get(bound);
    if (m) { if (m.purpose !== undefined) p.purpose = m.purpose; if (m.navigatesTo) p.navigatesTo = m.navigatesTo; if (m.pageInput !== undefined) p.pageInput = m.pageInput; if (m.dataSources && !(p.dataSources || []).length) p.dataSources = m.dataSources; }
  }
  for (const p of pages) if (!p.key) { p.key = mint(p.name); idToKey.set(String(p.pageId).toLowerCase(), p.key); }
  return idToKey;
}

// Entries of `a` whose pageId is absent from `b`. Used BOTH directions to require exact enumerated<->
// downloaded id equality (I3). A gap either way means pac downloaded a different set than exists —
// rebuilding from this spec would silently drop/add pages, so download FAILS instead.
function missingDownloads(a, b) {
  const have = new Set((b || []).map((p) => String(p.pageId).toLowerCase()));
  return (a || []).filter((p) => !have.has(String(p.pageId).toLowerCase()));
}
```

Rewrite the `main` pages block (replace `:162-179`) — enumerate fail-closed FIRST, clean, download (no swallow), exact equality, reconcile, reverse-normalize:

```javascript
  // Pages (all — incl. Maker-authored). AUTHORITATIVE via a fail-closed enumeration (lists every page,
  // even ones not in the sitemap), NOT the sitemap titles alone. Everything below is fail-closed: an
  // enumeration failure, a download failure, a missing-page gap, or a read/write error ABORTS with a
  // structured error rather than silently writing a page-dropping spec (Critical 2 / I3).
  const genpageCli = makeGenpageCli(env);
  const enumd = await genpageCli.enumerate({ appId });
  if (!enumd.ok) { emitResult(false, { ok: false, error: `page enumeration failed during download: ${enumd.error}` }); return; }
  let pages = [];
  let manifest = null;
  if (!enumd.empty) {
    // Durable manifest (keys + v2 semantics), looked up by the app's unique name.
    const appRows = await sdk.queryRecords('appmodule', { select: ['uniquename'], filter: `appmoduleid eq ${appId}`, top: 1 });
    const appUnique = appRows && appRows[0] && appRows[0].uniquename;
    if (appUnique) {
      const rows = await sdk.queryRecords('webresource', { select: ['content'], filter: `name eq '${manifestResourceName(appUnique).replace(/'/g, "''")}'`, top: 1 });
      if (rows && rows[0] && rows[0].content) manifest = parseManifestBase64(rows[0].content);
    }
    // Clean the download dir, then download — FAIL on error (genpageCli.download throws → main().catch).
    const pagesRoot = path.join(outDir, 'pages');
    fs.rmSync(pagesRoot, { recursive: true, force: true });
    fs.mkdirSync(pagesRoot, { recursive: true });
    await genpageCli.download({ appId, outputDir: pagesRoot });
    const nameById = new Map(enumd.pages.filter((p) => p.name).map((p) => [String(p.pageId).toLowerCase(), p.name]));
    pages = parseDownloadedPages(pagesRoot, outDir, nameById);
    // EXACT enumerated<->downloaded id equality, BOTH directions.
    const missing = missingDownloads(enumd.pages, pages);
    if (missing.length) { emitResult(false, { ok: false, error: `enumerated page(s) not downloaded: ${missing.map((p) => p.name || p.pageId).join(', ')} — refusing to write a spec that would drop them` }); return; }
    const extra = missingDownloads(pages, enumd.pages);
    if (extra.length) { emitResult(false, { ok: false, error: `downloaded page(s) not enumerated: ${extra.map((p) => p.pageId).join(', ')} — inconsistent page set` }); return; }
    // Reconcile ids via the reconcilePageIds authority (ambiguous names HALT), assign keys, reverse-normalize.
    const { keyToId, ambiguous } = reconcilePageIds((manifest && manifest.pages) || [], manifest, pages);
    if (ambiguous.length) { emitResult(false, { ok: false, error: `ambiguous page name(s) during download: ${ambiguous.map((a) => a.name).join(', ')} — cannot safely reconstruct keys` }); return; }
    const idToKey = assignPageKeys(pages, manifest, keyToId);
    for (const p of pages) {
      const abs = path.join(outDir, p.codeFile);
      const src = fs.readFileSync(abs, 'utf8');           // FAIL on a read error (no swallow)
      const rev = reverseResolveNavIds(src, idToKey);     // structural — nav pageId literals only
      if (rev !== src) fs.writeFileSync(abs, rev, 'utf8'); // FAIL on a write error (no swallow)
    }
  }
```

> Remove the old `nameById`/`try{…}catch{ pages download skipped }` block (`:162-179`) entirely — the enumeration is now authoritative and the download is fail-closed. `main` already runs under `main().catch(err => emitResult(false, err))`, so a thrown download/read/write error surfaces as a structured failure.

Add `design` to the `read` object passed to `hydrateSpec` (`:205-212`):

```javascript
    design: async () => (manifest ? manifest.design : undefined),
```

Export the new helpers (`module.exports`, `:230`): add `assignPageKeys`, `missingDownloads`.

- [ ] **Step 4: Implement the v2 hydration in `scripts/lib/hydrate-spec.js`**

Replace `hydrateSpec` so it emits v2 when pages carry keys (and route GenPage subareas by key vs name accordingly):

```javascript
async function hydrateSpec(read) {
  const app = (await read.app()) || { name: '', description: '', siteMap: { areas: [] } };
  const pages = (await read.pages()) || [];
  const entities = (await read.entities()) || [];
  const webResources = (await read.webResources()) || [];
  const dashboards = (read.dashboards ? await read.dashboards() : []) || [];
  const solution = (await read.solution()) || { uniqueName: 'Default', publisherPrefix: 'new' };
  const design = read.design ? await read.design() : undefined;
  const hasKeys = pages.some((p) => p.key); // download assigns keys → v2; a legacy caller without keys → legacy shape
  const pageKeyById = new Map(pages.filter((p) => p.pageId && p.key).map((p) => [String(p.pageId).toLowerCase(), p.key]));
  const pageNameById = new Map(pages.filter((p) => p.pageId && p.name).map((p) => [String(p.pageId).toLowerCase(), p.name]));
  const dashboardNameById = new Map(dashboards.filter((d) => d.id && d.name).map((d) => [String(d.id).toLowerCase(), d.name]));
  const subMap = hasKeys ? pageKeyById : pageNameById; // GenPage subarea → { page: key } (v2) | { page: name } (legacy)

  const appShell = {
    areas: (app.siteMap.areas || []).map((a) => ({
      label: a.title,
      ...(a.icon ? { icon: a.icon } : {}),
      ...(a.vectorIcon ? { vectorIcon: a.vectorIcon } : {}),
      groups: (a.groups || []).map((g) => ({ label: g.title, subAreas: (g.subAreas || []).map((sa) => subAreaToSpec(sa, subMap, dashboardNameById)).filter(Boolean) })),
    })),
  };

  return {
    ...(hasKeys ? { schemaVersion: 2 } : {}),
    solution,
    app: { name: app.name, description: app.description || '' },
    entities, webResources, views: [], charts: [], forms: [], commands: [],
    dashboards: dashboards.map((d) => ({ name: d.name, tiles: d.tiles })),
    pages: pages.map((p) => (hasKeys
      ? { key: p.key, name: p.name, ...(p.purpose !== undefined ? { purpose: p.purpose } : {}), ...(p.dataSources && p.dataSources.length ? { dataSources: p.dataSources } : {}), ...(p.navigatesTo ? { navigatesTo: p.navigatesTo } : {}), ...(p.pageInput !== undefined ? { pageInput: p.pageInput } : {}), ...(p.prompt ? { prompt: p.prompt } : {}), source: { kind: 'tsx', codeFile: p.codeFile } }
      : { name: p.name, ...(p.dataSources && p.dataSources.length ? { dataSources: p.dataSources } : {}), ...(p.prompt ? { prompt: p.prompt } : {}), codeFile: p.codeFile })),
    appShell,
    ...(design !== undefined ? { design } : {}),
  };
}
```

- [ ] **Step 5: Run the tests + full suite**

Run: `node --test scripts/tests/download-model-app.test.js scripts/tests/hydrate-spec.test.js`
Expected: PASS.

Then: `node scripts/run-tests.js`
Expected: PASS — suite green (≈ 660).

- [ ] **Step 6: Commit**

```bash
git add scripts/download-model-app.js scripts/lib/hydrate-spec.js scripts/tests/download-model-app.test.js scripts/tests/hydrate-spec.test.js
git commit -m "feat(model-apps): fail-closed manifest-aware download round-trip (enumerate-first, exact equality, reconcile)" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>" \
  -m "Copilot-Session: 42626da2-b66f-4162-acaa-b1127ef23d89"
```

---

## Task 12: Generator contract (stable KEY) + docs + recovery guidance (C4, I1)

Aligns the generator rules and the page-builder agent contract with the stable **key** (C4 — today they say FILENAME), uses `data:` (never `recordId`) for the custom id in the nav example (design §9), documents the manifest + `PAGEREF_` protocol, and removes the generic `--from <phase>` recovery advice in favour of a **full rerun** (I1). Docs only — not tested.

**Files:**
- Modify: `references/rules.md:333-356` (the "Multi-page builds" block).
- Modify: `agents/genpage-page-builder.md` (the navigation-placeholder guidance).
- Modify: `references/app-spec-schema.md` (`pages[].key` + the durable manifest).
- Modify: `skills/app-builder/SKILL.md` (round-trip + full-rerun recovery; drop `--from` recovery advice).
- Modify: `CHANGELOG.md`.

- [ ] **Step 1: `references/rules.md` — `PAGEREF_<key>`, `data:` not `recordId`**

Replace the "Multi-page builds" block (`:333-356`) so the placeholder is keyed by the **stable App Spec page key** and the custom id travels in `data:` (never `recordId`, per design §9 / `references/rules.md:318`):

```markdown
#### Multi-page builds: use `PAGEREF_<key>` placeholders

In a multi-page deployment, page GUIDs don't exist until after first upload. Use a
`PAGEREF_<key>` placeholder as the `pageId` — where `<key>` is the **stable key** of the
sibling page (the App Spec `pages[].key`, also used by `navigatesTo[].targetKey`). The build
replaces these with real GUIDs in a resolved deployment copy after all pages are deployed;
your canonical `.tsx` keeps the symbolic token (the build never writes a GUID back into it).

```typescript
// Navigating to a sibling page — use its stable KEY, and pass any custom id in `data` (never recordId)
xrm.Navigation.navigateTo({
    pageType: "generative",
    pageId: "PAGEREF_pet-gallery",   // <key> of the target page; replaced with the real GUID post-deploy
    data: { selectedPetId: selectedId },   // custom ids go in data (read as pageInput?.data?.selectedPetId)
});
```

The placeholder format is `PAGEREF_` followed by the target page's stable **key** (e.g. a page
with `"key": "pet-gallery"` → `PAGEREF_pet-gallery`). The key is rename-stable; a filename or
display name is not.

**Must be quoted, and it is the pageId.** The build's single structural resolver only rewrites a
`PAGEREF_<key>` that appears as the **double-quoted `pageId:` value of a `pageType:"generative"`
`navigateTo` call**. Always emit it exactly there — never single-quoted, back-ticked, concatenated,
or as a decoy string elsewhere (the pre-deploy scan **rejects** a malformed nav ref and any parity
mismatch). Every `PAGEREF_<key>` you emit must have a matching `navigatesTo` entry in the page's
spec, and every declared `navigatesTo.targetKey` must appear as a real nav pageId in the source
(the build enforces exact parity, and verification confirms each edge resolves to the actual target).
```

- [ ] **Step 2: `agents/genpage-page-builder.md`** — update the cross-page-navigation instruction to reference the stable **key** (matching `pages[].key` / `navigatesTo.targetKey`) rather than the filename, mirroring the rules.md block above: quoted `"PAGEREF_<key>"` as the `pageId` of a `pageType:"generative"` `navigateTo` only, one per declared `navigatesTo`, custom ids in `data:`.

- [ ] **Step 3: `references/app-spec-schema.md`** — document, under `## pages`:
  - `pages[].key` is the single stable identity used by `navigatesTo[].targetKey`, `PAGEREF_<key>`, and `appShell` page subareas; it must match `^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$`, be unique, and (for an implemented page) its `codeFile` path must be unique and workspace-confined.
  - The build writes a durable `<app>_pagemanifest` web resource carrying `{ schemaVersion, pages:[{ key, name, pageId, purpose, dataSources, navigatesTo, pageInput }], design }`; download reconstructs keys + reverse-normalizes navigation from it (legacy apps get fresh keys).

- [ ] **Step 4: `skills/app-builder/SKILL.md`** — two edits:
  - Add a short note: multi-page navigation uses `PAGEREF_<key>` (resolved post-deploy); the deployed pages are **verified** (every nav edge must resolve to the actual target page).
  - **Recovery / phase-selector guidance (I1):** state that `--apply` accepts only a **full build** or exactly `--stage data`; the fine-grained `--only/--skip/--from/--to` selectors are **dry-run-only** (inspection); **recovery from a halt is a full rebuild** (idempotent). Remove the `:143-160` guidance that suggests applying a partial range (e.g. `--apply --skip data-model`) and the "or use `--from <phase>` to skip ahead" line — those are no longer apply-safe.

- [ ] **Step 5: `CHANGELOG.md`** — under Unreleased/Added:
  - Fail-closed generative-page deployment: `PAGEREF_<key>` navigation resolved into run-scoped staging (canonical `.tsx` never GUID-mutated) via a single structural nav oracle, durable `<app>_pagemanifest`, key-by-key sitemap binding, a single-machine advisory lock, and required page-spec validation (unique names/paths, workspace confinement, key grammar).
  - Mandatory fail-closed page verification (every nav edge resolves to the actual target `GenPageId`); fail-closed manifest-aware download round-trip; `--apply` restricted to a full build or `--stage data`.

- [ ] **Step 6: Full suite (docs don't add tests — confirm nothing regressed)**

Run: `node scripts/run-tests.js`
Expected: PASS — suite green (≈ 660, unchanged from Task 11).

- [ ] **Step 7: Commit**

```bash
git add references/rules.md agents/genpage-page-builder.md references/app-spec-schema.md skills/app-builder/SKILL.md CHANGELOG.md
git commit -m "docs(model-apps): PAGEREF_ keyed by stable key + data-not-recordId + manifest/round-trip/full-rerun recovery" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>" \
  -m "Copilot-Session: 42626da2-b66f-4162-acaa-b1127ef23d89"
```

---

## Self-Review (completed while writing)

**Residual-Critical coverage** (the 6 new/residual Criticals from `sol-plan3-confirm-findings.md`):
- **Critical 1 (nav oracle bypassable)** → **Tasks 1 + 8 + 10 + 11**: ONE structural extractor `extractNavTargets` parses actual `navigateTo({ pageType:'generative', pageId })` call sites and is the sole basis for forward resolution/parity (Task 8), reverse-normalization (Task 11), AND verification (Task 10). Verify matches each edge against the ACTUAL deployed target `GenPageId` at a real nav call site, and the sitemap only on the `GenPageId` attribute; decoy-string + wrong-GUID + comment-GUID tests are REJECTED (Tasks 1, 8, 10). No bare-token scanning remains.
- **Critical 2 (download drops pages)** → **Task 11**: enumerate fail-closed FIRST, clean the dir, FAIL on any download/read/write error, exact enumerated↔downloaded id equality (both directions), reconcile via `reconcilePageIds` (not a name-collapsing Map), then structural reverse + hydrate. A real manifest→download→reverse→hydrate→validate→resolve round-trip test.
- **Critical 3 (lease not safe — DESCOPE per controller)** → **Tasks 8 + 9**: replaced with a single-machine advisory lockfile that HALTs a fresh concurrent build (never steals), reclaims a stale lock only by age via ONE atomic `wx` create, and is owner-checked on release; the steal-if-stale race is gone. CORRECTNESS is the convergence spine (fail-closed enumeration + create-absent-first + immediate-manifest-persist), stated as the real guarantee. No Dataverse/heartbeat lock. Cross-machine/worktree concurrency documented unsupported.
- **Critical 4 (page validation absent)** → **Task 3**: `app-spec.js` rejects (before any write) case-insensitive duplicate names, duplicate/`..`/absolute codeFile paths (workspace confinement), and an invalid stable-key grammar (`^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$`); one rejection test each + an accept test.
- **Critical 5 (crash persistence window)** → **Tasks 5 + 8 + 9**: the manifest is persisted (content-deduped) IMMEDIATELY after EVERY page CREATE (both create-absent-first and upload-once). Task 9 halts directly after the FIRST create and proves a full re-run converges without duplicating (the created page is seeded from the persisted manifest + enumeration).
- **Critical 6 (mandatory verify can vanish)** → **Task 10**: a page-bearing spec whose verifier/`read.pages` is absent, or whose verify throws, yields `r.verify={ok:false,unableToRun:true}` (non-zero exit) — never a skip. The `deps.runBuild` seam is WIRED (production defaults to `runSdkBuild`); the assumed `build-model-app.js:210-221` seam did not exist — grounded in the real `deps.verify` seam. `verify-model-app.test.js` is CREATED.

**Important coverage:**
- **I1** → **Tasks 9 + 12**: apply rejects ANY partial range except exactly `data`; the engine `pages-requires-app` HALT remains; SKILL.md drops `--from` recovery advice (full rerun).
- **I2** → **Task 4**: `enumerate` validates the COMPLETE listing (every page named + parsed count == summary "Found N page(s)"); the persistent-CREATE + adopt tests updated with the real summary format and a real-output fixture.
- **I3** → **Task 11**: reconcile-authority + structural reverse + exact-equality guard.
- **I4** → **Tasks 8 + 9**: run-scoped staging cleaned in `finally`; the descoped advisory lease.
- **I5** → **Tasks 2 + 6**: full-schema `parseManifest`; teardown always removes the manifest.
- **I6** → **Tasks 5 + 9**: immediate-persist call-order reconciled (single-page first build = 1 create + 0 update; multi-page = 1 create + (N-1) updates); the crash test crashes after the FIRST create; uploads are in the sequence log.
- **I7** → **Tasks 5 + 8**: every UPDATE (incl. the internal one after an uncertain-CREATE adoption, guarded inside `genpage-cli.upload`) asserts returned id == requested id (case-insensitive) else HALT.
- **Test fixtures** → **Task 5**: real staged `.tsx` files written for every pages-phase test so Task 8's source-reading scan never ENOENTs.
- **recordId → data** → **Task 12**; **C2 seed-and-preserve** → **Task 7** (+ Task 8/9 failure paths); **Minor 2 split** → the old bundled task is now Tasks 3–9.

**Placeholder scan:** none — every step carries runnable test + implementation code, exact `node --test` / `node scripts/run-tests.js` commands, and a commit with both trailers. No "TBD"/"similar to Task N"/"add validation".

**Type consistency across tasks:**
- `extractNavTargets(code) → NavTarget[]` (kinds `pageref`/`pageref-malformed`/`literal`/`dynamic` with `valueStart`/`valueEnd`) — defined in Task 1; consumed by Task 8 (via `navReferencedKeys`/`navMalformedRefs`/`resolvePageRefs`), Task 10 (verify), Task 11 (via `reverseResolveNavIds`). One extractor, three consumers.
- `enumerate({ appId }) → { ok, pages:[{ pageId, name }], empty?, error? }` — Task 4 (def), Tasks 5/8 (engine `.ok`/`.pages`), Tasks 10/11 (reader/download).
- `reconcilePageIds(pages, manifest, livePages) → { keyToId: Map, absentKeys, ambiguous }` — Task 2 (def), Tasks 5/8 (seed + ambiguous HALT), Task 11 (download authority).
- `persistPageManifest(provision, spec, keyToId, sol, appUnique, existingId, lastContent) → { id, content }` — stable 7-arg signature, Tasks 5 + 8.
- `acquireAppPagesLease(wsDir, appUnique, deps?) → { release }` — Task 8 (def), Task 9 (unit + concurrency tests).

**Implementer notes:**
- **(a) `parseListCount` / empty markers** — confirm the exact `Found N generated page(s)` + no-pages phrasing against a real `pac model genpage list` run and adjust the regex (a fixture is added); any unmatched zero-exit output is (correctly) fail-closed `unrecognized`.
- **(b) Baseline count** — measured **570** after Plan 2; the plan is implemented in a worktree branched from that base. Running totals per task are approximate — the contract is "the suite stays green" (`node scripts/run-tests.js` after every task).
- **(c) `sameSet` phase compare (I1)** — `opts.phases` from `stagePhasesOrResolve` is the phase array; a plain `--apply` resolves to the full `PHASES`, so existing apply tests (no `phases`) are unaffected.

---

## Review R1 → resolutions

| # | Finding | Resolution (task → mechanism) |
|---|---|---|
| **C1** | Verify + download promised, no tasks | **Tasks 10–11** — structural page verification (every edge → actual target `GenPageId`) + fail-closed reader/download round-trip. |
| **C2** | Sitemap finalization not the commit point | **Task 7** — existing page-backed app defers all sitemap mutation to the finalizer (seed-and-preserve tests). |
| **C3** | CREATE retry fail-open duplicate window | **Task 4** — fail-closed uncertain-CREATE re-enumerate; no blind 2nd CREATE. |
| **C4** | Caller can ship unresolved/wrong navigation | **Tasks 1, 8, 12** — the single structural nav oracle: malformed-ref + exact parity HALT before any write; stable-key generator contract. |
| **C5** | Reconcile can overwrite the wrong live page | **Task 2** (+ 5/8 wiring) — manifest-confirmed-live → unique-name authority; ambiguous HALT. |
| **I1** | Recovery violates the one-full-build model | **Tasks 5, 9, 12** — engine `pages-requires-app` HALT; broad apply-range guard; docs require a full rerun. |
| **I2** | Zero-exit unparseable enumeration = empty | **Task 4** — tri-state complete-listing classifier. |
| **I3** | Reverse normalization under-specified/broad | **Task 11** — reconcile authority + structural reverse + exact-equality. |
| **I4** | Staging + deployment concurrency unsafe | **Tasks 8, 9** — run-scoped staging cleaned in `finally`; descoped advisory lease. |
| **I5** | Manifest parse + teardown not fail-closed | **Tasks 2, 6** — full-schema parse; always-teardown. |
| **I6** | Test contradiction + missing ordering | **Tasks 5, 9** — immediate-persist call-order + crash-after-first-create + sequence tests. |
| **I7** | Update identity changes unguarded | **Tasks 4, 5, 8** — returned-id == requested-id guard (incl. inside `genpage-cli.upload`). |
| **Minor 1** | `planFor` step drift vs runtime | **Tasks 5, 8** — one `run`/`skip` per page + deterministic resolve/manifest steps. |
| **Minor 2** | Over-bundled task | Split into **Tasks 3–9** (validation / cli / plumbing / teardown / C2 / protocol / ordering). |

## Review R2 → resolutions

| Residual finding (confirming pass) | Status before | Resolution (task → mechanism) |
|---|---|---|
| **C1/C4 nav oracle bypassable** (decoy `PAGEREF_` + wrong pageId passes parity AND verify; parity scanned arbitrary strings) | FAIL | **Tasks 1 + 8 + 10 + 11** — ONE `extractNavTargets` structural oracle over real `navigateTo` call sites drives resolution/parity/reverse/verify; decoy-string, wrong-GUID, and comment-GUID tests REJECTED; verify matches the ACTUAL target `GenPageId` and the sitemap on `GenPageId` only. |
| **C1/I3 download drops pages** (failures swallowed; name-collapsing Map) | FAIL | **Task 11** — enumerate fail-closed FIRST, clean dir, FAIL on error, exact id equality both ways, `reconcilePageIds` authority, structural reverse; full round-trip test. |
| **I4/Critical 3 lease unsafe** (stale-steal + release races; one workspace) — CONTROLLER: descope | FAIL | **Tasks 8 + 9** — descoped single-machine advisory lockfile (HALT-not-steal, age-only reclaim via one atomic `wx`, owner-checked release); convergence spine is the correctness guarantee; cross-machine unsupported. Steal logic removed. |
| **Critical 4 required page validation absent** (`app-spec.js:474-505`) | (new) | **Task 3** — ci name uniqueness + codeFile path uniqueness + workspace confinement + key grammar, before any write; rejection tests each. |
| **Critical 5 crash persistence window** (persisted only at final write) | (new) | **Tasks 5 + 8 + 9** — persist the manifest immediately after EVERY create; crash-after-first-create convergence test. |
| **Critical 6 mandatory verify can vanish** (`&& deps.verify` skips; `deps.runBuild` fictional; no `verify-model-app.test.js`) | (new) | **Task 10** — absent verifier/reader-methods → `{ok:false,unableToRun:true}` + non-zero exit; `deps.runBuild` wired; `verify-model-app.test.js` created; seam grounded in the real `deps.verify` at `build-model-app.js:245-256`/`:339`. |
| **I1 phase-range guard too narrow** (only `pages` sans `app-shell`; `--stage app` allowed) | FAIL | **Tasks 9 + 12** — apply rejects ALL partial ranges except exactly `data`; SKILL.md drops `--from` recovery advice. |
| **I2 tri-state accepts any single id** (no name/count/completeness) | PARTIAL | **Task 4** — classifier requires every page named AND parsed count == summary count; persistent-CREATE test updated; real-output fixture. |
| **I3 reverse-norm not using reconcile / stale dirs / one-direction / swallowed writes** | FAIL | **Task 11** — `reconcilePageIds`, clean dir, both-direction equality, no swallowed read/write, structural reverse. |
| **I5 "full-schema" parse only container types** | PARTIAL | **Task 2** — validates purpose/array elements/nav/pageInput types + key uniqueness (kept from R1, verified). |
| **I6 crash test crashes at finalization; uploads not in log; false zero-update claim** | PARTIAL | **Tasks 5 + 9** — crash after FIRST create; uploads in the sequence log; single-page = 1 create + 0 update, multi-page = 1 create + (N-1) updates (immediate-persist reconciled). |
| **I7 internal UPDATE after uncertain-CREATE adoption unguarded** | PARTIAL | **Tasks 4 + 5 + 8** — the adopted-then-UPDATE path is guarded inside `genpage-cli.upload` (returned id == requested), plus the engine's per-page I7 guard; mismatch HALT. |
| **C2 dangling/upload tests use FRESH apps** | PARTIAL | **Tasks 7 (+ 8/9)** — existing-app tests SEED a prior sitemap and assert it is PRESERVED on enumeration/dangling/upload failure. |
| **Test fixtures reference nonexistent `o.tsx`/`overview.tsx`** | (new) | **Task 5** — real staged `.tsx` fixtures written in test setup for every pages-phase test. |
| **recordId nav example** | (new) | **Task 12** — replaced with `data:` (design §9). |
| **Minor 2 Task still bundled** | PARTIAL | Split into **Tasks 3–9**, each an independently testable deliverable. |
| **Ground truth: `GenPageId` attribute; `build-model-app.js:210-221` seam absent** | (note) | **Tasks 10** — sitemap matched on `GenPageId` (vendor `cds-maker-sdk.cjs:50`); build-test seam corrected to `deps.runBuild` (wired) + `deps.verify`.
