# App-Builder Staged Flow — Plan 3: Pages Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This is the highest-risk plan in the series (it gets a separate architectural review) — do not skip a step's RED run, and keep the full suite green after every task.

**Goal:** Land the **pages pipeline** for the staged flow — the fail-closed generative-page deployment protocol (`PAGEREF_` cross-page navigation resolved into run-scoped staging copies, never mutating canonical source), a durable versioned `<app>_pagemanifest` web resource that carries page semantics across download/rebuild, the latent key/name binding fix in the pages phase, page-aware **mandatory fail-closed verification** (every navigation edge must resolve to the *actual* target's live `GenPageId`, not merely "no `PAGEREF_` remains"), and a **manifest-aware download/hydration** round-trip. All new logic is either a pure offline-testable module or a discover-reconcile addition to the existing engine — no engine phase is renamed and no non-page build behavior changes.

**Architecture:** Two new **pure leaf modules** — `pageref-resolver.js` (symbolic `PAGEREF_<key>` ⇄ GenPageId substitution + broad-grammar scanning + scoped reverse-normalization + nav parity) and `page-manifest.js` (build/parse/reconcile the durable manifest) — are consumed by the engine's existing `pages` phase (`sdk-build.js:1061-1097`). The pages phase gains: (1) **fail-closed enumeration** via a new `genpageCli.enumerate` that distinguishes a pac failure *and a zero-exit unrecognized listing* from a genuinely empty app (today `listPages` collapses all of them to `[]`, `genpage-cli.js:68-70`); (2) a **safe uncertain-CREATE retry** in `genpageCli.upload` that never issues a second CREATE without a fail-closed enumeration proving no same-named page exists; (3) the **manifest lifecycle** (create → `updateWebResource` on rebuild, content-deduped → re-assert solution membership every run → **always** teardown); (4) the **§9 protocol** (scan-every-source → create-absent-first → resolve-to-run-scoped-staging → upload-once → sitemap-finalize) under an **app-scoped single-writer lease**; (5) the **key-by-KEY** fix so `result.created.pages` is keyed by the stable page key (matching `appDef`'s `result.pages[s.page]` lookup, `sdk-build.js:506`); and (6) **deferring the existing-app sitemap write to the pages finalizer** so an enumeration/upload failure can never leave a persisted GenPage-stripped draft sitemap (C2). Verification is extended in the pure `verifySpec` (`verify-spec.js`) plus a fail-closed page reader (`verify-model-app.js`) and a **mandatory** page-verify gate (`build-model-app.js`). The download round-trip (`download-model-app.js` / `hydrate-spec.js`) reconciles manifest ids against the fail-closed live enumeration, reverse-normalizes only validated navigation `pageId` literals, and reconstructs stable keys (minting fresh keys for a legacy app per §7.3). Destructive page operations (future removals) are out of scope here — they route through Plan 2's `op-diff.js` classifier when added.

**Tech Stack:** Node.js (CommonJS), `node:test` + `node:assert`, run via `node scripts/run-tests.js`. Design source of truth: `plugins/model-apps/docs/app-builder-staged-flow-design.md` — **§5** (execution model: data pre-build → main-loop code-gen → **one full idempotent build; NO cross-run DAG**), **§8** (generate-pages stage), **§9** (cross-page navigation + fail-closed `PAGEREF_` protocol), **§7.3** (durable `<app>_pagemanifest` lifecycle + download reverse-normalization + legacy migration), **§13.1** (verify extended to pages — mandatory + fail-closed). Navigation contract: `references/rules.md:299-356`.

## Global Constraints

- All commands run from the plugin root: `D:\Projects\power-platform-skills-sdk\plugins\model-apps`.
- Tests use `node:test`: `const { test } = require('node:test'); const assert = require('node:assert');`. Full suite: `node scripts/run-tests.js` (**measured baseline 570 passing after Plan 2** — keep it green; each task below adds tests, running totals are approximate). Single file: `node --test scripts/tests/<file>.test.js`.
- The **13 engine phase names and order are unchanged**: `solution, data-model, sample-data, web-resources, views, charts, forms, commands, dashboards, app-shell, pages, ai-features, publish`. This plan only touches the `pages` phase (and its `app-shell`/teardown/verify counterparts).
- **Pure modules are offline-only:** `pageref-resolver.js` and `page-manifest.js` have **no I/O and no SDK handle**. The engine reads/writes the web-resource bytes and the staging `.tsx` files; the pure modules only shape/parse strings. They are unit-tested with in-memory inputs.
- **The canonical `.tsx` is NEVER mutated with a GUID.** `PAGEREF_<key>` resolution writes a **run-scoped staging copy** under `<appDir>/.maker-workspace/.pageref-deploy/<runId>/`, cleaned in a `finally`; `genpageCli.upload` reads that path. Baking an environment-specific id into source would break cross-env recreate (design §9, SDK opaque-identity **T5**).
- **Enumeration is fail-closed and tri-state.** `genpageCli.enumerate` classifies a zero-exit listing as **recognized-pages**, **recognized-empty**, or **unrecognized**; only the first two are success. A pac failure OR an unrecognized zero-exit output yields `{ ok: false }` — the pages phase and the verify reader **HALT** (they never treat a failed/unreadable listing as "no pages", which would duplicate-create and orphan). `listPages`/`list` are retained but no longer drive any create decision.
- **`result.created.pages` is keyed by the stable page key** (`p.key || p.name` — legacy specs with no key fall back to name, so name-referenced specs keep working). This matches `appDef`'s `result.pages[s.page]` lookup where `s.page` is the migrated **key** (`sdk-build.js:506`), fixing a latent bug hidden by legacy (name==ref) test specs.
- **The pages finalizer is the ONLY existing-app sitemap write.** For an app that already exists AND has page subareas, the `app-shell` phase resolves its id but **defers all sitemap mutation** to the pages finalizer; a build that halts before the finalizer leaves the *previous* deployed sitemap intact (design §9 commit point).
- **Manifest lifecycle:** first build creates the `<appUnique>_pagemanifest` web resource; a rebuild **updates its content in place via `updateWebResource`** (content-deduped — a write is skipped when the manifest already holds exactly this content, so a first build issues **zero** `updateWebResource` calls); solution membership is **re-asserted every run** (idempotent `addSolutionComponent`); `planTeardown` **always** removes it (not gated on the current spec still having pages — a not-found delete is idempotent). New page ids are persisted to the manifest **immediately** after each mint (crash-safety, design §9).
- **`updateWebResource` must be added to `SKILL_SDK_SURFACE`** (`sdk-surface-contract.test.js`) — it is exposed by the vendored bundle (`vendor/cds-maker-sdk.cjs`, confirmed a function) but not yet listed; the source-scan half of the contract test fails the moment the pages phase calls `provision.updateWebResource(` unless it is listed.
- **Recovery is a FULL rerun.** Every `runSdkBuild` invocation allocates a fresh `result.created` and populates the app id only in `app-shell` (`sdk-build.js:548,1025`), so `--from pages` cannot resume. After any page halt, re-run the **full** build (idempotent); the engine HALTs if `pages` runs without the app id, and the CLI rejects an apply-time phase selection that includes `pages` but excludes `app-shell`.
- Commit trailers on every commit:
  ```
  Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
  Copilot-Session: 42626da2-b66f-4162-acaa-b1127ef23d89
  ```

---

## File Structure

- `scripts/lib/pageref-resolver.js` **(new)** — pure `PAGEREF_<key>` resolver: `resolvePageRefs`, `referencedKeys`, `scanRawPageRefs` (broad grammar — flags non-canonical refs), `reverseResolveNavIds` (scoped to `pageId:` literals), `navTargetParity`. No dependencies (leaf module).
- `scripts/lib/page-manifest.js` **(new)** — pure manifest builder/parser/reconciler: `MANIFEST_SCHEMA_VERSION`, `manifestResourceName`, `buildManifest`, `serializeManifest`, `parseManifest` (full-schema + key-uniqueness fail-closed), `parseManifestBase64`, `reconcilePageIds` (manifest-confirmed-live → unique-live-name → absent, ambiguous HALTs). No dependencies (leaf module).
- `scripts/lib/genpage-cli.js` **(modify)** — add `classifyListOutput` (tri-state parse) + `enumerate({ appId }) → { ok, pages, empty?, error? }` (fail-closed; retries); harden `upload`'s uncertain-CREATE retry (fail-closed re-enumerate; never a blind 2nd CREATE). Keep `list`/`listPages`.
- `scripts/lib/sdk-build.js` **(modify)** — `app-shell` defers the page-backed existing-app sitemap write (C2); pages phase (`:1061-1097`): fail-closed `enumerate` + manifest seed/reconcile (+ ambiguous HALT) + key-by-KEY fix + scan-every-source/parity + create-absent-first + `resolvePageRefs`-to-run-scoped-staging + upload-once (+ I7 update-id guard) + sitemap-finalize, under an app-scoped lease with `finally` cleanup. New helpers `readPageManifest`/`persistPageManifest`/`writeStagingFile`/`acquireAppPagesLease` (modeled on `ensureAppIcon:436-461`). `planFor` gains a `page manifest` + `resolve cross-page navigation` item (`:279-280`), aligned to exactly one run/skip per page.
- `scripts/lib/sdk-teardown.js` **(modify)** — `planTeardown` **always** adds a `webResource` teardown step for `<appUnique>_pagemanifest` (after the icon step, `:346-349`); import `manifestResourceName`.
- `scripts/lib/verify-spec.js` **(modify)** — `verifySpec` gains a page branch (exists / `GenPageId`-bound / **every declared nav edge resolves to the ACTUAL target's live `GenPageId`** / no unresolved or malformed `PAGEREF_`); new `subareaHasGenPage` helper; import `referencedKeys` + `scanRawPageRefs`.
- `scripts/verify-model-app.js` **(modify)** — `readerFor` gains a fail-closed `pages()` (via `genpageCli.enumerate`, HALTs on `ok:false`) + cached `pageCode(pageId)` (via `genpageCli.download`); `main` builds a `genpageCli` + workspace and threads them.
- `scripts/build-model-app.js` **(modify)** — page verify becomes **mandatory + fail-closed** when the spec has implemented pages (`:231-242`): it runs even without `--verify`, and a verify that cannot run makes the build exit non-zero; reject an apply-time phase selection that includes `pages` but excludes `app-shell` (I1).
- `scripts/download-model-app.js` **(modify)** — fetch `<uniquename>_pagemanifest`, reconcile manifest ids against the fail-closed live enumeration, build `idToKey`, reverse-normalize each downloaded `page.tsx` (nav literals only), reconstruct keys; **fail if an enumerated page was not downloaded**; export `parseDownloadedPages`; thread the manifest to `hydrateSpec`.
- `scripts/lib/hydrate-spec.js` **(modify)** — with a manifest, reconstruct the v2 page shape (`key`/`purpose`/`navigatesTo`/`pageInput`/`source:{kind:'tsx',codeFile}`) + `schemaVersion: 2` + `design`, resolving GenPage subareas to `{ page: <key> }` by id; legacy fallback (no manifest) mints **fresh** stable keys per §7.3 (not the old name shape).
- `scripts/tests/pageref-resolver.test.js`, `scripts/tests/page-manifest.test.js`, `scripts/tests/sdk-build-pages-deploy.test.js`, `scripts/tests/sdk-build-pages-order.test.js` **(new)** — offline unit + integration + failure-ordering tests.
- `scripts/tests/genpage-cli.test.js`, `scripts/tests/sdk-build.test.js`, `scripts/tests/sdk-build-pages-migrate.test.js`, `scripts/tests/sdk-surface-contract.test.js`, `scripts/tests/sdk-teardown.test.js`, `scripts/tests/verify-spec.test.js`, `scripts/tests/build-model-app.test.js`, `scripts/tests/verify-model-app.test.js`, `scripts/tests/download-model-app.test.js`, `scripts/tests/hydrate-spec.test.js` **(modify)** — add `enumerate` to genpageCli mocks; add `updateWebResource` + manifest query branch to `mockSdk`; new assertions.
- `references/rules.md`, `agents/genpage-page-builder.md`, `references/app-spec-schema.md`, `skills/app-builder/SKILL.md`, `CHANGELOG.md` **(modify)** — `PAGEREF_<key>` uses the stable KEY; document the manifest + protocol + full-rerun recovery (docs — not tested).

---

## Task 1: `pageref-resolver.js` — pure `PAGEREF_<key>` substitution, scan, scoped reverse, parity

**Files:**
- Create: `scripts/lib/pageref-resolver.js`
- Create: `scripts/tests/pageref-resolver.test.js`

**Interfaces:**
- Consumes: nothing (leaf module — no I/O, no SDK handle).
- Produces:
  - `resolvePageRefs(sources: Map<string, { code: string }>, keyToId: Map<string, string>) → { deployment: Map<string, string>, unresolved: string[] }` — replaces every canonical `"PAGEREF_<refKey>"` token with the quoted GenPageId; `unresolved` is the sorted-unique set of referenced keys with no id (dangling targets), left **verbatim** so a fail-closed caller HALTs.
  - `referencedKeys(code: string) → string[]` — sorted-unique keys referenced via the **canonical** `"PAGEREF_<key>"` token.
  - `scanRawPageRefs(code: string) → { canonical: string[], malformed: string[] }` — broad-grammar scan of **every** `PAGEREF_` occurrence: `canonical` = keys in the exact double-quoted form; `malformed` = any occurrence NOT in that form (single-quoted, back-ticked, unquoted, concatenated). The build rejects any `malformed` before a write (C4 — a wrong-quoted ref would otherwise be invisible and ship unresolved).
  - `reverseResolveNavIds(code: string, idToKey: Map<string, string>) → string` — the download inverse, **scoped to `pageId:` navigation literals only** (I3): rewrites `pageId: "<guid>"` (or single-quoted) back to `pageId: "PAGEREF_<key>"` when the value is a known deployed id, preserving quote style and never touching an unrelated GUID literal.
  - `navTargetParity(declaredKeys: string[], referencedKeys: string[]) → { declaredNotReferenced: string[], referencedNotDeclared: string[] }` — pure parity between a page's declared `navigatesTo.targetKey`s and the keys its source actually references (C4 exact-parity enforcement).

- [ ] **Step 1: Write the failing test** — `scripts/tests/pageref-resolver.test.js`

```javascript
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { resolvePageRefs, referencedKeys, scanRawPageRefs, reverseResolveNavIds, navTargetParity } = require(path.join(__dirname, '..', 'lib', 'pageref-resolver.js'));

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
  assert.ok(deployment.get('a').includes('"PAGEREF_missing"'), 'a dangling ref must not be dropped or mangled — the caller halts on it');
});

test('resolvePageRefs does not partial-collide "PAGEREF_pet" with "PAGEREF_pet-gallery"', () => {
  const sources = new Map([['x', { code: '["PAGEREF_pet","PAGEREF_pet-gallery"]' }]]);
  const keyToId = new Map([['pet', 'id-pet'], ['pet-gallery', 'id-gallery']]);
  const { deployment, unresolved } = resolvePageRefs(sources, keyToId);
  assert.strictEqual(deployment.get('x'), '["id-pet","id-gallery"]');
  assert.deepStrictEqual(unresolved, []);
});

test('resolvePageRefs is idempotent — resolved code has no canonical PAGEREF_ left', () => {
  const sources = new Map([['x', { code: 'pageId: "PAGEREF_detail"' }]]);
  const keyToId = new Map([['detail', 'gp-1']]);
  const once = resolvePageRefs(sources, keyToId).deployment.get('x');
  assert.strictEqual(referencedKeys(once).length, 0);
});

test('referencedKeys returns the sorted unique set of canonically-quoted keys', () => {
  assert.deepStrictEqual(referencedKeys('"PAGEREF_b" x "PAGEREF_a" y "PAGEREF_b"'), ['a', 'b']);
  assert.deepStrictEqual(referencedKeys('no refs here'), []);
});

test('scanRawPageRefs classifies canonical vs malformed (single-quoted / unquoted / concatenated)', () => {
  const code = '"PAGEREF_ok" then \'PAGEREF_singlequoted\' then bare=PAGEREF_unquoted; and "prefix"+PAGEREF_concat';
  const { canonical, malformed } = scanRawPageRefs(code);
  assert.deepStrictEqual(canonical, ['ok']);
  assert.deepStrictEqual(malformed, ['PAGEREF_concat', 'PAGEREF_singlequoted', 'PAGEREF_unquoted']);
});

test('scanRawPageRefs is clean when every ref is canonical (no malformed)', () => {
  assert.deepStrictEqual(scanRawPageRefs('"PAGEREF_a" and "PAGEREF_b"'), { canonical: ['a', 'b'], malformed: [] });
});

test('reverseResolveNavIds rewrites ONLY a pageId nav literal back to "PAGEREF_<key>" (case-insensitive)', () => {
  const idToKey = new Map([['5d29d8ce-1111-2222-3333-444455556666', 'detail']]);
  const code = 'pageId: "5D29D8CE-1111-2222-3333-444455556666", recordId: "5d29d8ce-1111-2222-3333-444455556666"';
  // The nav pageId is reversed; the SAME guid used as a recordId is NOT (scoped to pageId:, per I3).
  assert.strictEqual(reverseResolveNavIds(code, idToKey), 'pageId: "PAGEREF_detail", recordId: "5d29d8ce-1111-2222-3333-444455556666"');
});

test('resolve then reverse round-trips the navigation literal', () => {
  const keyToId = new Map([['detail', 'gp-42']]);
  const idToKey = new Map([['gp-42', 'detail']]);
  const original = 'pageId: "PAGEREF_detail"';
  const resolved = resolvePageRefs(new Map([['x', { code: original }]]), keyToId).deployment.get('x');
  assert.strictEqual(resolved, 'pageId: "gp-42"');
  assert.strictEqual(reverseResolveNavIds(resolved, idToKey), original);
});

test('navTargetParity reports declared-not-referenced and referenced-not-declared (both directions)', () => {
  assert.deepStrictEqual(navTargetParity(['detail', 'ghost'], ['detail', 'extra']), { declaredNotReferenced: ['ghost'], referencedNotDeclared: ['extra'] });
  assert.deepStrictEqual(navTargetParity(['a'], ['a']), { declaredNotReferenced: [], referencedNotDeclared: [] });
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

// Match ONLY the canonical quoted token `"PAGEREF_<key>"`. The surrounding quotes are part of the match,
// so the replacement swaps the whole string literal. Quoting also bounds the key so "PAGEREF_pet" cannot
// partial-match inside "PAGEREF_pet-gallery" (rules.md keys are slugs [a-z0-9-]; `_` allowed defensively).
// A fresh regex is built per call because a /g RegExp is stateful (lastIndex) — reusing one across
// .exec/.replace loops would skip matches.
const REF = () => /"PAGEREF_([A-Za-z0-9_-]+)"/g;

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Resolve every source's canonical PAGEREF_ tokens to quoted GenPageIds. Returns the resolved copies
// plus the sorted-unique referenced keys that had NO id (dangling nav targets), left verbatim so the
// caller can HALT (fail-closed) rather than upload a broken link.
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

// The sorted-unique keys referenced via the canonical "PAGEREF_<key>" token.
function referencedKeys(code) {
  const re = REF();
  const keys = new Set();
  let m;
  while ((m = re.exec(String(code || ''))) !== null) keys.add(m[1]);
  return [...keys].sort();
}

// Broad-grammar scan: classify EVERY `PAGEREF_<key>` occurrence by the chars immediately around it.
// canonical = double-quoted on BOTH sides ("PAGEREF_x"); malformed = anything else (single-quoted,
// back-ticked, unquoted, or concatenated like "x"+PAGEREF_y). The build rejects `malformed` before any
// write (C4): the resolver can only substitute the canonical token, so a wrong-quoted ref would ship
// UNRESOLVED and break navigation — it must fail loudly, not silently pass the narrow resolver regex.
// `(.?)` captures one char before/after; consuming the trailing char is fine for a scanner.
function scanRawPageRefs(code) {
  const canonical = new Set();
  const malformed = new Set();
  const re = /(.?)PAGEREF_([A-Za-z0-9_-]+)(.?)/g;
  const s = String(code || '');
  let m;
  while ((m = re.exec(s)) !== null) {
    const [, before, key, after] = m;
    if (before === '"' && after === '"') canonical.add(key);
    else malformed.add(`PAGEREF_${key}`);
  }
  return { canonical: [...canonical].sort(), malformed: [...malformed].sort() };
}

// Download inverse, SCOPED to navigation `pageId:` literals only (design §7.3 / I3). Rewrites the value
// of `pageId: "<guid>"` (single or double quoted) back to its symbolic "PAGEREF_<key>" when the value
// is a known deployed id — NEVER a GUID used elsewhere (a recordId, a data value), which a blanket
// quoted-GUID replace would corrupt. Dataverse may echo the GUID upper- or lower-cased, so match the
// value case-insensitively; the original quote style is preserved.
//   raw: pageId: "5d29d8ce-...", recordId: "5d29d8ce-..."  →  only the pageId is reversed.
function reverseResolveNavIds(code, idToKey) {
  const byLower = new Map([...(idToKey || new Map())].map(([id, key]) => [String(id).toLowerCase(), key]));
  return String(code || '').replace(/(\bpageId\s*:\s*)(["'])([^"'`]+)\2/g, (m, lead, q, val) => {
    const key = byLower.get(String(val).toLowerCase());
    return key ? `${lead}${q}PAGEREF_${key}${q}` : m;
  });
}

// Pure exact-parity check between a page's DECLARED navigatesTo targetKeys and the keys its source
// actually references. Exact parity is required (C4): a declared edge missing from source, or a source
// ref with no declaration, is an authoring error the caller HALTs on before deploy.
function navTargetParity(declaredKeys, referencedKeysList) {
  const d = new Set((declaredKeys || []).map(String));
  const r = new Set((referencedKeysList || []).map(String));
  return {
    declaredNotReferenced: [...d].filter((k) => !r.has(k)).sort(),
    referencedNotDeclared: [...r].filter((k) => !d.has(k)).sort(),
  };
}

module.exports = { resolvePageRefs, referencedKeys, scanRawPageRefs, reverseResolveNavIds, navTargetParity };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test scripts/tests/pageref-resolver.test.js`
Expected: PASS (all 10 tests).

Then the full gate: `node scripts/run-tests.js`
Expected: PASS — suite green (≈ 580).

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/pageref-resolver.js scripts/tests/pageref-resolver.test.js
git commit -m "feat(model-apps): pure PAGEREF_ resolver (resolve, scan, scoped reverse, nav parity)" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>" \
  -m "Copilot-Session: 42626da2-b66f-4162-acaa-b1127ef23d89"
```

---

## Task 2: `page-manifest.js` — pure build/parse/reconcile of the durable page manifest

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
  - `reconcilePageIds(pages, manifest, livePages) → { keyToId: Map, absentKeys: string[], ambiguous: [{ key, name, matches }] }` — **authority order (C5):** (1) manifest `key→id` when that id is confirmed live; (2) else exactly one live name-match; (3) else absent; (4) duplicate/ambiguous live names are returned in `ambiguous` (the caller HALTs — never silently collapsed).

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
  assert.strictEqual(parseManifest(JSON.stringify({ schemaVersion: 1, pages: [{ key: 'a', name: 'A', pageId: '' }] })), null); // empty pageId
});

test('parseManifestBase64 decodes then parses (fail-closed on garbage)', () => {
  const m = buildManifest({ pages: [{ key: 'a', name: 'A' }] }, new Map());
  const b64 = Buffer.from(serializeManifest(m), 'utf8').toString('base64');
  assert.deepStrictEqual(parseManifestBase64(b64), m);
  assert.strictEqual(parseManifestBase64('@@ not base64 json @@'), null);
});

test('reconcilePageIds: manifest key->id CONFIRMED LIVE wins over a different page with the same display name (C5)', () => {
  // manifest overview -> page A (live); page B (live) happens to have the same display name "Overview".
  // Authority #1 (manifest-confirmed-live) must bind A, NOT overwrite B.
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
    // (1) manifest key -> id, confirmed live.
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
Expected: PASS — suite green (≈ 593).

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/page-manifest.js scripts/tests/page-manifest.test.js
git commit -m "feat(model-apps): durable page-manifest with fail-closed parse + C5 reconcile authority" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>" \
  -m "Copilot-Session: 42626da2-b66f-4162-acaa-b1127ef23d89"
```

---

## Task 3: `genpage-cli.js` — tri-state fail-closed `enumerate` (I2) + safe uncertain-CREATE retry (C3)

Two tightly-coupled `genpage-cli.js` fixes: (a) an `enumerate` that distinguishes a real empty app from an unreadable listing, and (b) an `upload` whose CREATE retry can never duplicate a page that a possibly-successful first attempt already created.

**Files:**
- Modify: `scripts/lib/genpage-cli.js` — add `classifyListOutput`; add `enumerate` (fail-closed, tri-state, retrying); rewrite `upload`'s CREATE-retry reconcile to use fail-closed enumeration.
- Modify: `scripts/tests/genpage-cli.test.js` — add `enumerate` + uncertain-CREATE tests.

**Interfaces:**
- Produces:
  - `classifyListOutput(stdout) → { kind: 'pages'|'empty'|'unrecognized', pages }` — a zero-exit output with parsed Page IDs is `pages`; an explicit "no pages" marker is `empty`; anything else (blank, a help banner, a changed format) is `unrecognized`.
  - `genpageCli.enumerate({ appId }) → { ok, pages, empty?, error? }` — retries; `{ ok:false }` on a persistent non-zero exit OR a persistent `unrecognized` zero-exit; `{ ok:true, pages, empty }` otherwise.
  - `genpageCli.upload(...)` — on an **uncertain CREATE** (non-zero, or zero-exit with no Page ID) re-enumerates **fail-closed**: enumeration failure → throw (never a blind 2nd CREATE); exactly one same-named live page → adopt it (retry UPDATEs in place); multiple → throw (ambiguous); zero → safe to retry CREATE.

- [ ] **Step 1: Write the failing tests** — append to `scripts/tests/genpage-cli.test.js`

```javascript
const { classifyListOutput } = require('../lib/genpage-cli.js'); // add to the existing require if not present

test('classifyListOutput: pages / empty / unrecognized (tri-state, I2)', () => {
  assert.strictEqual(classifyListOutput(`Overview\n  Page ID: ${GUID}\n`).kind, 'pages');
  assert.strictEqual(classifyListOutput('No pages found\n').kind, 'empty');
  assert.strictEqual(classifyListOutput('').kind, 'unrecognized');
  assert.strictEqual(classifyListOutput('pac model genpage list\nUsage: pac model genpage ...\n').kind, 'unrecognized');
});

test('enumerate returns { ok:true, pages } on a zero-exit list (no retry on success)', async () => {
  let n = 0;
  const cli = makeGenpageCli('env', { run: async () => { n += 1; return { status: 0, stdout: `Overview\n  Page ID: ${GUID}\n`, stderr: '' }; }, sleep: async () => {}, attempts: 3 });
  const r = await cli.enumerate({ appId: 'app-1' });
  assert.deepStrictEqual(r.pages, [{ pageId: GUID, name: 'Overview' }]);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(n, 1);
});

test('enumerate returns { ok:true, pages:[], empty:true } for an app that genuinely has no pages', async () => {
  const cli = makeGenpageCli('env', { run: async () => ({ status: 0, stdout: 'No pages found\n', stderr: '' }), sleep: async () => {}, attempts: 3 });
  const r = await cli.enumerate({ appId: 'app-1' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.empty, true);
  assert.deepStrictEqual(r.pages, []);
});

test('enumerate is fail-closed on a zero-exit UNRECOGNIZED listing (blank/help) — NOT empty (I2)', async () => {
  const cli = makeGenpageCli('env', { run: async () => ({ status: 0, stdout: 'Usage: pac model genpage list ...\n', stderr: '' }), sleep: async () => {}, attempts: 2 });
  const r = await cli.enumerate({ appId: 'app-1' });
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(r.pages, []);
  assert.match(r.error, /unrecognized/i);
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
  const cli = makeGenpageCli('env', { run: async () => { n += 1; return n < 2 ? { status: 1, stdout: '', stderr: 'flake' } : { status: 0, stdout: `A\n  Page ID: ${GUID}\n`, stderr: '' }; }, sleep: async () => {}, attempts: 3 });
  const r = await cli.enumerate({ appId: 'app-1' });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.pages, [{ pageId: GUID, name: 'A' }]);
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
});

test('upload: an uncertain CREATE adopts the one same-named live page and UPDATES it (no duplicate)', async () => {
  let creates = 0, updates = 0;
  const run = async (args) => {
    if (args.includes('upload')) {
      const isUpdate = args.includes('--page-id');
      if (isUpdate) { updates += 1; return { status: 0, stdout: `Page ID: ${GUID}`, stderr: '' }; }
      creates += 1; return { status: 0, stdout: 'no id', stderr: '' }; // uncertain create
    }
    return { status: 0, stdout: `Overview\n  Page ID: ${GUID}\n`, stderr: '' }; // enumeration: the create DID land
  };
  const cli = makeGenpageCli('env', { run, sleep: async () => {}, attempts: 3 });
  const r = await cli.upload({ appId: 'app-1', codeFile: 'x.tsx', name: 'Overview' });
  assert.strictEqual(r.pageId, GUID);
  assert.strictEqual(creates, 1, 'one create attempt');
  assert.strictEqual(updates, 1, 'retry UPDATED the adopted page in place — no second create');
});
```

> If `GUID` / `makeGenpageCli` are not already imported at the top of `genpage-cli.test.js`, add `const { makeGenpageCli, classifyListOutput } = require('../lib/genpage-cli.js'); const GUID = '5d29d8ce-1111-2222-3333-444455556666';` to the existing test header.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test scripts/tests/genpage-cli.test.js`
Expected: FAIL — `classifyListOutput`/`cli.enumerate` are not exported/functions; the C3 upload tests fail (today's retry uses fail-open `listPages`).

- [ ] **Step 3: Implement `classifyListOutput` + `enumerate` + the safe CREATE retry**

(a) Add `classifyListOutput` next to `parseList` (`:59`):

```javascript
// Classify a ZERO-EXIT `pac model genpage list` stdout (design §9 / I2). A zero exit alone is NOT proof
// of "no pages": a changed PAC format, a blank result, or a help banner (pac dumps usage on a flag error
// yet exits 0 on some builds) would all parse to [] and trigger duplicate creation. So:
//   'pages'        — at least one "Page ID: <guid>" parsed (authoritative page listing).
//   'empty'        — an EXPLICIT no-pages marker (only then is [] trustworthy).
//   'unrecognized' — anything else → the caller treats it as a FAILURE, never as empty.
// Observed markers (confirm against a live/fixtured pac run before relying on new phrasings):
//   empty:  "No pages found" | "Found 0 page(s)" | "0 page(s)"
function classifyListOutput(stdout) {
  const pages = parseList(stdout);
  if (pages.length) return { kind: 'pages', pages };
  const s = String(stdout || '');
  if (/\bno\s+pages\b/i.test(s) || /\bfound\s+0\b/i.test(s) || /\b0\s+page\(s\)\b/i.test(s)) return { kind: 'empty', pages: [] };
  return { kind: 'unrecognized', pages: [] };
}
```

(b) Add a fail-closed enumerator inside `makeGenpageCli` (after `listPages`, `:71`), used by BOTH the exposed `enumerate` and `upload`'s retry:

```javascript
  // Fail-closed page enumeration (design §9). Retries (pac genpage list flakes with transient help-dumps)
  // and returns { ok:false } on a persistent non-zero exit OR a persistent zero-exit UNRECOGNIZED output —
  // DISTINCT from { ok:true, pages:[], empty:true } for an app that truly has no pages. Never lets an
  // unreadable listing masquerade as "no pages" (which would re-create every page and orphan the originals).
  async function enumeratePages(appId) {
    let lastErr = '';
    for (let i = 0; i < attempts; i += 1) {
      const r = await run(['model', 'genpage', 'list', '--environment', env, '--app-id', appId]);
      if (r.status === 0) {
        const c = classifyListOutput(r.stdout);
        if (c.kind !== 'unrecognized') return { ok: true, pages: c.pages, empty: c.kind === 'empty' };
        lastErr = 'unrecognized `pac genpage list` output (zero exit, no page listing) — refusing to treat as empty';
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

(e) Export `classifyListOutput` (module.exports, `:119`): add `classifyListOutput` to the exported object.

- [ ] **Step 4: Run the tests + full suite**

Run: `node --test scripts/tests/genpage-cli.test.js`
Expected: PASS (all enumerate + C3 upload tests + existing).

Then: `node scripts/run-tests.js`
Expected: PASS — suite green (≈ 601).

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/genpage-cli.js scripts/tests/genpage-cli.test.js
git commit -m "feat(model-apps): fail-closed tri-state genpage enumerate + safe uncertain-create retry" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>" \
  -m "Copilot-Session: 42626da2-b66f-4162-acaa-b1127ef23d89"
```

---

## Task 4: Engine plumbing — manifest lifecycle, key-by-KEY, surface, always-teardown, plan alignment

Makes the pages phase discover-reconcile-safe **without** the PAGEREF_ protocol yet (Tasks 5–7 add sitemap-deferral and the protocol): fail-closed enumerate → manifest seed/reconcile (+ ambiguous HALT) → **key-by-KEY** upload loop → content-deduped manifest persist → finalize. Adds the `updateWebResource` surface entry, the always-removed teardown step, the `pages-requires-app` recovery guard, and `planFor` alignment.

**Files:**
- Modify: `scripts/lib/sdk-build.js` — requires (`:20-31`); `readPageManifest` + `persistPageManifest` helpers (after `ensureAppIcon`, `:461`); the pages phase (`:1064-1097`); `planFor` (`:279-280`).
- Modify: `scripts/lib/sdk-teardown.js:37` (import `manifestResourceName`), after `:349` (always-on manifest teardown step).
- Modify: `scripts/tests/sdk-surface-contract.test.js:75` (add `'updateWebResource'`).
- Modify: `scripts/tests/sdk-build.test.js:4` (import `appUniqueName`), `:59` (manifest query branch), `:106` (add `updateWebResource`), `:980,:996,:1009` (add `enumerate` to genpageCli mocks), new integration tests.
- Modify: `scripts/tests/sdk-build-pages-migrate.test.js:90,:120,:148` (add `enumerate` to genpageCli mocks).
- Modify: `scripts/tests/sdk-teardown.test.js` (always-on manifest teardown-step test).

**Interfaces:**
- Consumes: `enumerate` (Task 3); `manifestResourceName`/`buildManifest`/`serializeManifest`/`parseManifestBase64`/`reconcilePageIds` (Task 2); `normalizePageSource` (`app-spec.js`); `appUniqueName`/`COMPONENT_TYPE`/`appDef`/`appHasPageSubareas`/`BuildHalt`/`odataLit`/`requireSuccessfulPush` (in-module).
- Produces:
  - `readPageManifest(provision, appUnique) → { id, manifest, text }` — `text` is the decoded serialized content (for the persist dedup).
  - `persistPageManifest(provision, spec, keyToId, sol, appUnique, existingId, lastContent) → { id, content }` — content-deduped: **skips** the create/update write when `content === lastContent`, but **always** re-asserts solution membership.
  - `result.created.pages` keyed by `p.key || p.name`.
  - `pages-requires-app` HALT when `pages` runs without an app id (I1 recovery guard).
  - `SKILL_SDK_SURFACE` includes `updateWebResource`; `planTeardown` always removes the manifest (I5).

- [ ] **Step 1: Update the shared mocks** — so the phase rewrite doesn't break green tests

In `scripts/tests/sdk-build.test.js`: import `appUniqueName` (`:4`), add the manifest query branch (replace the `webresource` line at `:59`), add `updateWebResource` (after `createWebResource`, `:106`):

```javascript
// :4 — add appUniqueName to the destructure:
const { runSdkBuild, planFor, resolvePhases, compileFormIntent, formFieldLogicals, viewDef, appDef, defaultViewColumns, enrichesDefaultViews, artifactIdentityQuery, dashboardTileOpts, PHASES, appUniqueName } = require('../lib/sdk-build.js');

// :59 — replace the single webresource line. content is base64 (Dataverse webresource.content); the
// manifest branch is opt-in (opts.pageManifest) so existing existingWebResource tests are unaffected:
      if (e === 'webresource') {
        if (/_pagemanifest'/.test(filter)) return opts.pageManifest ? [{ webresourceid: opts.manifestId || 'wr-manifest', content: opts.pageManifest }] : [];
        return opts.existingWebResource ? [{ webresourceid: 'wr-existing' }] : [];
      }

// :106 — after createWebResource:
    updateWebResource: async (id, o) => { calls.push({ name: 'updateWebResource', args: [id, o] }); return {}; },
```

Add `enumerate` to the three genpageCli mocks (`:980` empty, `:996` empty, `:1009` existing page):

```javascript
// :980  genpageCli = { list: async () => [], enumerate: async () => ({ ok: true, pages: [], empty: true }), upload: async (o) => { uploads.push(o); return { pageId: 'gp-1' }; } };
// :996  genpageCli = { list: async () => [], enumerate: async () => ({ ok: true, pages: [], empty: true }), upload: async () => ({ pageId: 'gp-1' }) };
// :1009 genpageCli = { list: async () => [{ pageId: 'gp-existing', name: 'Overview' }], enumerate: async () => ({ ok: true, pages: [{ pageId: 'gp-existing', name: 'Overview' }] }), upload: async (o) => { uploads.push(o); return { pageId: 'gp-existing' }; } };
```

In `scripts/tests/sdk-build-pages-migrate.test.js`, add `enumerate: async () => ({ ok: true, pages: [], empty: true }),` to each of the three genpageCli mocks (`:90`, `:120`, `:148`).

- [ ] **Step 2: Write the failing integration tests** — append to `scripts/tests/sdk-build.test.js`

```javascript
test('pages phase (v2, page key != name): result.created.pages is keyed by KEY so the sitemap finalize resolves', async () => {
  const spec = makeSpec();
  spec.schemaVersion = 2;
  spec.pages = [{ key: 'overview', name: 'Overview', source: { kind: 'tsx', codeFile: 'o.tsx' } }];
  spec.appShell.areas[0].groups[0].subAreas.push({ page: 'overview', title: 'Overview' });
  const { sdk, calls } = mockSdk();
  const genpageCli = { list: async () => [], enumerate: async () => ({ ok: true, pages: [], empty: true }), upload: async () => ({ pageId: 'gp-1' }) };
  await runSdkBuild(spec, { sdk, apply: true, env: 'https://x', appDir: process.cwd(), genpageCli, phases: ['solution', 'data-model', 'app-shell', 'pages'] });
  const setDef = find(calls, 'updateElement').find((c) => c.args[2] === '/siteMap');
  const subs = setDef.args[3].areas[0].groups[0].subAreas;
  assert.ok(subs.some((s) => s.type === 'GenPage' && s.genPageId === 'gp-1'), 'GenPage subarea resolved by KEY (was unresolved when keyed by name)');
});

test('pages phase persists the manifest on first build (create, type js, add-to-solution, ZERO update)', async () => {
  const spec = makeSpec();
  spec.pages = [{ name: 'Overview', codeFile: 'o.tsx' }];
  const { sdk, calls } = mockSdk();
  const genpageCli = { list: async () => [], enumerate: async () => ({ ok: true, pages: [], empty: true }), upload: async () => ({ pageId: 'gp-1' }) };
  await runSdkBuild(spec, { sdk, apply: true, env: 'https://x', appDir: process.cwd(), genpageCli, phases: ['solution', 'data-model', 'app-shell', 'pages'] });
  const created = find(calls, 'createWebResource').map((c) => c.args[0]).find((o) => /_pagemanifest$/.test(o.name));
  assert.strictEqual(created.type, 'js');
  assert.deepStrictEqual(JSON.parse(created.content).pages[0], { key: 'Overview', name: 'Overview', pageId: 'gp-1' });
  assert.strictEqual(find(calls, 'updateWebResource').length, 0, 'content-dedup: no redundant update on first build (I6)');
  assert.ok(find(calls, 'addSolutionComponent').some((c) => c.args[0].componentType === 61), 'manifest added to the solution');
});

test('pages phase updates the manifest IN PLACE on a rebuild whose page ids changed (updateWebResource, no dup create)', async () => {
  const spec = makeSpec();
  spec.pages = [{ name: 'Overview', codeFile: 'o.tsx' }, { name: 'Detail', codeFile: 'd.tsx' }];
  // Existing manifest knows Overview only; Detail is new this run → content changes → one in-place update.
  const existing = Buffer.from(JSON.stringify({ schemaVersion: 1, pages: [{ key: 'Overview', name: 'Overview', pageId: 'gp-o' }] }), 'utf8').toString('base64');
  const { sdk, calls } = mockSdk({ pageManifest: existing, manifestId: 'wr-manifest' });
  const live = [{ pageId: 'gp-o', name: 'Overview' }];
  const genpageCli = { list: async () => live, enumerate: async () => ({ ok: true, pages: live }), upload: async (o) => ({ pageId: o.pageId || 'gp-d' }) };
  await runSdkBuild(spec, { sdk, apply: true, env: 'https://x', appDir: process.cwd(), genpageCli, phases: ['solution', 'data-model', 'app-shell', 'pages'] });
  assert.ok(!find(calls, 'createWebResource').some((c) => /_pagemanifest$/.test(c.args[0].name)), 'manifest not re-created on rebuild');
  const upd = find(calls, 'updateWebResource');
  assert.ok(upd.length >= 1 && upd[0].args[0] === 'wr-manifest', 'manifest updated in place');
  assert.ok(find(calls, 'addSolutionComponent').some((c) => c.args[0].componentType === 61), 'solution membership re-asserted every run');
});

test('pages phase HALTS fail-closed when enumeration fails — never treats it as empty, uploads nothing', async () => {
  const spec = makeSpec();
  spec.pages = [{ name: 'Overview', codeFile: 'o.tsx' }];
  const { sdk } = mockSdk();
  let uploaded = 0;
  const genpageCli = { list: async () => [], enumerate: async () => ({ ok: false, pages: [], error: 'auth expired' }), upload: async () => { uploaded += 1; return { pageId: 'gp-1' }; } };
  await assert.rejects(
    runSdkBuild(spec, { sdk, apply: true, env: 'https://x', appDir: process.cwd(), genpageCli, phases: ['solution', 'data-model', 'app-shell', 'pages'] }),
    (e) => e && e.phase === 'pages' && e.code === 'pages-enumeration-failed'
  );
  assert.strictEqual(uploaded, 0);
});

test('pages phase HALTS on ambiguous duplicate live names before any upload (C5 wired)', async () => {
  const spec = makeSpec();
  spec.pages = [{ name: 'Overview', codeFile: 'o.tsx' }];
  const { sdk } = mockSdk();
  let uploaded = 0;
  const dup = [{ pageId: 'x1', name: 'Overview' }, { pageId: 'x2', name: 'Overview' }];
  const genpageCli = { list: async () => dup, enumerate: async () => ({ ok: true, pages: dup }), upload: async () => { uploaded += 1; return { pageId: 'x1' }; } };
  await assert.rejects(
    runSdkBuild(spec, { sdk, apply: true, env: 'https://x', appDir: process.cwd(), genpageCli, phases: ['solution', 'data-model', 'app-shell', 'pages'] }),
    (e) => e && e.phase === 'pages' && e.code === 'pages-ambiguous-name'
  );
  assert.strictEqual(uploaded, 0);
});

test('pages phase HALTS when the app id is absent (I1 recovery guard — do NOT resume from --from pages)', async () => {
  const spec = makeSpec();
  spec.pages = [{ name: 'Overview', codeFile: 'o.tsx' }];
  const { sdk } = mockSdk();
  const genpageCli = { list: async () => [], enumerate: async () => ({ ok: true, pages: [], empty: true }), upload: async () => ({ pageId: 'gp-1' }) };
  await assert.rejects(
    runSdkBuild(spec, { sdk, apply: true, env: 'https://x', appDir: process.cwd(), genpageCli, phases: ['pages'] }),
    (e) => e && e.phase === 'pages' && e.code === 'pages-requires-app'
  );
});

test('planFor emits exactly one step per page + a manifest step (Minor 1 alignment)', () => {
  const spec = makeSpec();
  spec.pages = [{ name: 'Overview', codeFile: 'o.tsx' }, { name: 'Detail', codeFile: 'd.tsx' }];
  const labels = planFor(spec, { phases: PHASES }).map((p) => p.label);
  assert.strictEqual(labels.filter((l) => /^page "/.test(l)).length, 2, 'one step per page');
  assert.ok(labels.includes(`page manifest ${appUniqueName(spec)}_pagemanifest`), 'plan lists the manifest step');
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --test scripts/tests/sdk-build.test.js`
Expected: FAIL — key-by-KEY throws `references page 'overview' which wasn't built`; manifest/halt/planFor tests fail.

- [ ] **Step 4: Implement the helpers, the pages-phase rewrite, planFor, surface**

(a) Require `page-manifest.js` (`:20-31` region of `sdk-build.js`):

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
// run (design §7.3). CONTENT-DEDUP (I6): the write is SKIPPED when the manifest already holds exactly
// `content` (== lastContent). This keeps a first build at ZERO updateWebResource calls (create-absent-
// first writes the final content once, the final persist is a no-op) AND makes the immediate-after-mint
// persist crash-safe without churn. Stored as type 'js' (webresourcetype 3): WEB_RESOURCE_KINDS has no
// 'json' kind and 'js' round-trips arbitrary text unchanged. Returns { id, content } for the next call.
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

(c) Replace the pages phase (`:1064-1097`) with the discover-reconcile / key-by-KEY / manifest version (the PAGEREF_ protocol replaces the middle loop in Task 6):

```javascript
  // 7b. Pages (generative pages). The app now exists; upload each page's content via pac (WITHOUT
  //     --add-to-sitemap — the SDK owns the sitemap), persist the durable manifest, then finalize the
  //     sitemap once so it includes the GenPage subareas.
  if (has('pages') && (spec.pages || []).length) {
    const genpageCli = opts.genpageCli || makeGenpageCli(opts.env);
    const appUnique = appUniqueName(spec);
    // I1 recovery guard: the app id is only populated by app-shell (this run). If pages runs without it
    // (e.g. --from pages), there is nothing to upload against — HALT and require a FULL rerun.
    if (!result.created.app) {
      throw new BuildHalt('pages phase requires the app (app-shell) in the same run — the app id is not carried across invocations. Re-run a FULL build (do not use --from pages).', { phase: 'pages', code: 'pages-requires-app', recoverable: false });
    }
    // Fail-closed enumeration: a failed/unreadable listing must NOT look like "no pages".
    const enumd = await genpageCli.enumerate({ appId: result.created.app });
    if (!enumd.ok) {
      throw new BuildHalt(`page enumeration failed — refusing to (re)create pages against an unknown page set: ${enumd.error || 'pac genpage list returned non-zero'}`, { phase: 'pages', code: 'pages-enumeration-failed', recoverable: true });
    }
    const { id: readId, manifest, text } = await readPageManifest(provision, appUnique);
    let manifestId = readId;
    let lastManifestContent = text;
    const { keyToId, ambiguous } = reconcilePageIds(spec.pages, manifest, enumd.pages);
    if (ambiguous.length) {
      throw new BuildHalt(`ambiguous page name(s) ${ambiguous.map((a) => `"${a.name}"`).join(', ')} — multiple live pages share a display name; refusing to overwrite an arbitrary one. Rename or remove the duplicate in Maker, then rebuild.`, { phase: 'pages', code: 'pages-ambiguous-name', recoverable: false });
    }
    for (const p of spec.pages) {
      const src = normalizePageSource(p);
      if (!src || src.kind !== 'tsx' || !src.codeFile) { runner.skip('pages', `page "${p.name}" (no tsx source)`); continue; }
      const key = p.key || p.name;
      await runner.run('pages', `page "${p.name}"`, async () => {
        const codeFile = path.resolve(opts.appDir || '.', src.codeFile);
        const up = await genpageCli.upload({ appId: result.created.app, pageId: keyToId.get(key), codeFile, name: p.name, prompt: p.prompt, agentMessage: p.agentMessage, dataSources: p.dataSources });
        keyToId.set(key, up.pageId);
        // Key by the STABLE key (p.key||p.name): appDef resolves result.pages[s.page] where s.page is the
        // migrated KEY (:506). Keying by name left v2 key-referenced subareas unresolved.
        result.created.pages[key] = up.pageId;
        return up.pageId;
      });
    }
    await runner.run('pages', `page manifest ${manifestResourceName(appUnique)}`, async () => {
      const persisted = await persistPageManifest(provision, spec, keyToId, sol, appUnique, manifestId, lastManifestContent);
      manifestId = persisted.id; lastManifestContent = persisted.content;
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

(d) `planFor` (`:279-280`) — one step per page + a manifest step + finalize:

```javascript
  if (has('pages')) for (const p of spec.pages || []) items.push({ phase: 'pages', label: `page "${p.name}"` });
  if (has('pages') && (spec.pages || []).length) items.push({ phase: 'pages', label: `page manifest ${appUniqueName(spec)}_pagemanifest` });
  if (has('pages') && (spec.pages || []).length && appHasPageSubareas(spec)) items.push({ phase: 'pages', label: 'finalize sitemap (genpage subareas)' });
```

(e) `SKILL_SDK_SURFACE` — add `'updateWebResource'` alphabetically after `'updateRecord'` (`:75`).

- [ ] **Step 5: Run pages + surface tests + full suite**

Run: `node --test scripts/tests/sdk-build.test.js scripts/tests/sdk-build-pages-migrate.test.js scripts/tests/sdk-surface-contract.test.js`
Expected: PASS.

- [ ] **Step 6: Teardown — ALWAYS remove the manifest (RED → GREEN, I5)**

Add the failing test to `scripts/tests/sdk-teardown.test.js`:

```javascript
test('the page manifest web resource is ALWAYS torn down (even when the spec no longer declares pages, I5)', () => {
  const base = { solution: { uniqueName: 'PgSln', publisherPrefix: 'new' }, app: { name: 'Pages App' },
    entities: [{ schemaName: 'new_widget', primaryAttribute: { schemaName: 'new_name' }, columns: [] }],
    appShell: { areas: [{ label: 'A', groups: [{ label: 'G', subAreas: [{ entity: 'new_widget' }] }] }] } };
  const manifest = `${appUniqueName(base)}_pagemanifest`;
  // With pages…
  assert.ok(planTeardown({ ...base, pages: [{ key: 'overview', name: 'Overview', source: { kind: 'tsx', codeFile: 'o.tsx' } }] }).some((s) => s.kind === 'webResource' && s.target.name === manifest));
  // …and WITHOUT pages (a spec that dropped its pages must still clean up the derived manifest — not-found is idempotent).
  assert.ok(planTeardown(base).some((s) => s.kind === 'webResource' && s.target.name === manifest));
});
```

Run: `node --test scripts/tests/sdk-teardown.test.js` → FAIL.

Implement in `scripts/lib/sdk-teardown.js`: import (`:37`) and the step (after the generated-icon step, `:349`):

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

- [ ] **Step 7: Full suite**

Run: `node scripts/run-tests.js`
Expected: PASS — suite green (≈ 608).

- [ ] **Step 8: Commit**

```bash
git add scripts/lib/genpage-cli.js scripts/lib/sdk-build.js scripts/lib/sdk-teardown.js scripts/tests/sdk-build.test.js scripts/tests/sdk-build-pages-migrate.test.js scripts/tests/sdk-surface-contract.test.js scripts/tests/sdk-teardown.test.js
git commit -m "feat(model-apps): manifest lifecycle + key-by-key pages + surface + always-teardown" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>" \
  -m "Copilot-Session: 42626da2-b66f-4162-acaa-b1127ef23d89"
```

---

## Task 5: C2 — the pages finalizer is the ONLY existing-app sitemap write

Today the `app-shell` phase, for an app that already exists, pushes the `omitUnbuiltPages:true` sitemap **before** pages upload (`sdk-build.js:1040-1044`) — stripping every GenPage subarea. An enumeration/upload failure then leaves the deployed app with broken navigation. Fix: for a page-backed existing app, resolve its id but **defer all sitemap mutation** to the pages finalizer.

**Files:**
- Modify: `scripts/lib/sdk-build.js` — the existing-app branch of the app-shell phase (`:1027-1046`).
- Modify: `scripts/tests/sdk-build.test.js` — C2 ordering tests.

**Interfaces:** no signature change — the existing-app sitemap `updateElement`/`pushArtifact`/`publishArtifact` are now gated on `!appHasPageSubareas(spec)`.

- [ ] **Step 1: Write the failing tests** — append to `scripts/tests/sdk-build.test.js`

```javascript
test('C2: an EXISTING page-backed app does NOT push its sitemap in app-shell — enumeration failure preserves the previous sitemap', async () => {
  const spec = makeSpec();
  spec.schemaVersion = 2;
  spec.pages = [{ key: 'overview', name: 'Overview', source: { kind: 'tsx', codeFile: 'o.tsx' } }];
  spec.appShell.areas[0].groups[0].subAreas.push({ page: 'overview', title: 'Overview' });
  const { sdk, calls } = mockSdk({ artifactsExist: true }); // findArtifact('app') → an existing app id
  const genpageCli = { list: async () => [], enumerate: async () => ({ ok: false, pages: [], error: 'boom' }), upload: async () => ({ pageId: 'gp-1' }) };
  await assert.rejects(
    runSdkBuild(spec, { sdk, apply: true, env: 'https://x', appDir: process.cwd(), genpageCli, phases: ['solution', 'data-model', 'app-shell', 'pages'] }),
    (e) => e && e.code === 'pages-enumeration-failed'
  );
  assert.ok(!find(calls, 'updateElement').some((c) => c.args[2] === '/siteMap'), 'NO sitemap write — app-shell deferred and the finalizer was never reached, so the previous sitemap is intact');
});

test('C2: an EXISTING page-backed app writes its sitemap ONCE, in the finalizer, with GenPage subareas resolved', async () => {
  const spec = makeSpec();
  spec.schemaVersion = 2;
  spec.pages = [{ key: 'overview', name: 'Overview', source: { kind: 'tsx', codeFile: 'o.tsx' } }];
  spec.appShell.areas[0].groups[0].subAreas.push({ page: 'overview', title: 'Overview' });
  const { sdk, calls } = mockSdk({ artifactsExist: true });
  const genpageCli = { list: async () => [], enumerate: async () => ({ ok: true, pages: [], empty: true }), upload: async () => ({ pageId: 'gp-1' }) };
  await runSdkBuild(spec, { sdk, apply: true, env: 'https://x', appDir: process.cwd(), genpageCli, phases: ['solution', 'data-model', 'app-shell', 'pages'] });
  const sitemapWrites = find(calls, 'updateElement').filter((c) => c.args[2] === '/siteMap');
  assert.strictEqual(sitemapWrites.length, 1, 'exactly one sitemap write — the finalizer');
  assert.ok(sitemapWrites[0].args[3].areas[0].groups[0].subAreas.some((s) => s.type === 'GenPage' && s.genPageId === 'gp-1'));
});

test('C2: an EXISTING app with NO page subareas still pushes its sitemap in app-shell (unchanged behavior)', async () => {
  const spec = makeSpec(); // entity subarea only, no pages
  const { sdk, calls } = mockSdk({ artifactsExist: true });
  await runSdkBuild(spec, { sdk, apply: true, env: 'https://x', appDir: process.cwd(), phases: ['solution', 'data-model', 'app-shell'] });
  assert.ok(find(calls, 'updateElement').some((c) => c.args[2] === '/siteMap'), 'a no-page existing app keeps pushing its sitemap in app-shell');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test scripts/tests/sdk-build.test.js`
Expected: FAIL — the first test finds a `/siteMap` write in app-shell (today's behavior); the second finds two.

- [ ] **Step 3: Defer the existing-app sitemap write** — replace the existing-app branch body (`:1027-1046`)

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

- [ ] **Step 4: Run the tests + full suite**

Run: `node --test scripts/tests/sdk-build.test.js`
Expected: PASS.

Then: `node scripts/run-tests.js`
Expected: PASS — suite green (≈ 611).

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/sdk-build.js scripts/tests/sdk-build.test.js
git commit -m "fix(model-apps): pages finalizer is the only existing-app sitemap write (C2)" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>" \
  -m "Copilot-Session: 42626da2-b66f-4162-acaa-b1127ef23d89"
```

---

## Task 6: `PAGEREF_` deployment protocol — scan/parity → create-absent-first → resolve-to-staging → upload-once

Replaces Task 4's simple upload loop with the full design §9 protocol: scan **every** implemented source and enforce nav parity (C4) **before** any write; create-absent-first for nav targets; resolve into **run-scoped** staging (never GUID-mutating canonical, cleaned in `finally`, I4); upload-once with an UPDATE-identity guard (I7); all under an **app-scoped single-writer lease** (I4). Exactly one `runner.run`/`skip` per page keeps `[n/total]` aligned (Minor 1).

**Files:**
- Modify: `scripts/lib/sdk-build.js` — require `pageref-resolver.js`; add `writeStagingFile`, `acquireAppPagesLease`, `appHasCrossPageNav`; replace the pages upload loop with the protocol; add the `resolve cross-page navigation` `planFor` item; thread `opts.workspaceDir`.
- Modify: `scripts/build-model-app.js:196-207` — pass `workspaceDir: opts.workspaceDir` to `runSdkBuild`; `:311-322` — add `workspaceDir` to `opts`.
- Create: `scripts/tests/sdk-build-pages-deploy.test.js`.

**Interfaces:**
- Consumes: `resolvePageRefs`/`referencedKeys`/`scanRawPageRefs`/`navTargetParity` (Task 1); `enumerate`/`readPageManifest`/`persistPageManifest`/`reconcilePageIds` (Tasks 2–4); `normalizePageSource` (`app-spec.js`).
- Produces: `writeStagingFile(stagingDir, key, code) → path`; `acquireAppPagesLease(wsDir, appUnique, deps?) → { release }`; `appHasCrossPageNav(spec) → boolean`; new `BuildHalt` codes `pages-malformed-navref`, `pages-nav-parity`, `pages-dangling-navref`, `pages-update-identity-mismatch`, `pages-locked` (all `recoverable:false` except `pages-locked`).

- [ ] **Step 1: Write the failing integration tests** — create `scripts/tests/sdk-build-pages-deploy.test.js`

```javascript
'use strict';
// Integration tests for the §9 PAGEREF_ deployment protocol: scan/parity → create-absent-first →
// resolve-to-run-scoped-staging (never mutate canonical) → upload-once (no duplicates) → sitemap finalize.
// Uses a REAL temp appDir so the fs read (canonical .tsx) and write (staging) run. Staging is cleaned in a
// finally, so the mock upload captures the uploaded bytes at call time.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
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

// Overview → Detail on disk under a real temp appDir. Options toggle malformed / undeclared / dangling refs.
function makeTwoPageApp(appDir, opts = {}) {
  fs.mkdirSync(appDir, { recursive: true });
  const parts = ['Xrm.Navigation.navigateTo({ pageType:\'generative\', pageId: "PAGEREF_detail", data:{} });'];
  if (opts.malformed) parts.push("const bad = 'PAGEREF_detail';");            // single-quoted → malformed
  if (opts.undeclaredRef) parts.push('const ghost = "PAGEREF_ghost";');       // referenced, not declared
  if (opts.danglingTarget) parts.push('const d = "PAGEREF_ghost";');          // declared + referenced, no page
  fs.writeFileSync(path.join(appDir, 'overview.tsx'), `export default function Overview(){ ${parts.join(' ')} return null; }`, 'utf8');
  fs.writeFileSync(path.join(appDir, 'detail.tsx'), 'export default function Detail(){ return null; }', 'utf8');
  const navigatesTo = [{ targetKey: 'detail' }];
  if (opts.danglingTarget) navigatesTo.push({ targetKey: 'ghost' });
  return {
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
}

const PHASES = ['solution', 'data-model', 'app-shell', 'pages'];

test('deploy: nav page uploads RESOLVED content (target id, no PAGEREF_); canonical .tsx is NEVER GUID-mutated', async () => {
  const appDir = path.join(__dirname, '.tmp-pages-deploy-1');
  try {
    const { sdk } = mockSdk();
    const genpageCli = mockGenpageCli();
    await runSdkBuild(makeTwoPageApp(appDir), { sdk, apply: true, env: 'https://x', appDir, genpageCli, phases: PHASES });
    const overviewUpload = genpageCli.uploads.find((u) => u.name === 'Overview');
    assert.ok(overviewUpload.content.includes('gp-detail'), 'uploaded content carries the resolved target id');
    assert.ok(!/PAGEREF_/.test(overviewUpload.content), 'no PAGEREF_ token remains in the uploaded (staged) bytes');
    assert.ok(fs.readFileSync(path.join(appDir, 'overview.tsx'), 'utf8').includes('"PAGEREF_detail"'), 'canonical .tsx untouched');
    assert.ok(!fs.existsSync(path.join(appDir, '.maker-workspace', '.pageref-deploy')) || fs.readdirSync(path.join(appDir, '.maker-workspace', '.pageref-deploy')).length === 0, 'run-scoped staging cleaned in finally');
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

test('deploy: a MALFORMED (single-quoted) PAGEREF_ HALTS before any upload (C4 grammar)', async () => {
  const appDir = path.join(__dirname, '.tmp-pages-deploy-2');
  try {
    const { sdk } = mockSdk();
    const genpageCli = mockGenpageCli();
    await assert.rejects(
      runSdkBuild(makeTwoPageApp(appDir, { malformed: true }), { sdk, apply: true, env: 'https://x', appDir, genpageCli, phases: PHASES }),
      (e) => e && e.phase === 'pages' && e.code === 'pages-malformed-navref'
    );
    assert.strictEqual(genpageCli.uploads.length, 0, 'scan rejects before any page write');
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

test('deploy: a source ref with NO declaration HALTS on parity before any upload (C4 parity)', async () => {
  const appDir = path.join(__dirname, '.tmp-pages-deploy-3');
  try {
    const { sdk } = mockSdk();
    const genpageCli = mockGenpageCli();
    await assert.rejects(
      runSdkBuild(makeTwoPageApp(appDir, { undeclaredRef: true }), { sdk, apply: true, env: 'https://x', appDir, genpageCli, phases: PHASES }),
      (e) => e && e.phase === 'pages' && e.code === 'pages-nav-parity'
    );
    assert.strictEqual(genpageCli.uploads.length, 0);
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

test('deploy: a declared+referenced DANGLING target HALTS before the sitemap finalize', async () => {
  const appDir = path.join(__dirname, '.tmp-pages-deploy-4');
  try {
    const { sdk, calls } = mockSdk();
    const genpageCli = mockGenpageCli();
    await assert.rejects(
      runSdkBuild(makeTwoPageApp(appDir, { danglingTarget: true }), { sdk, apply: true, env: 'https://x', appDir, genpageCli, phases: PHASES }),
      (e) => e && e.phase === 'pages' && e.code === 'pages-dangling-navref'
    );
    assert.ok(!calls.some((c) => c.name === 'updateElement' && c.args[2] === '/siteMap'), 'sitemap NOT finalized on a dangling target');
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

test('deploy: create-absent-first mints target ids, uploads each page ONCE, records both ids in the manifest', async () => {
  const appDir = path.join(__dirname, '.tmp-pages-deploy-5');
  try {
    const { sdk, calls } = mockSdk();
    const genpageCli = mockGenpageCli();
    await runSdkBuild(makeTwoPageApp(appDir), { sdk, apply: true, env: 'https://x', appDir, genpageCli, phases: PHASES });
    // Detail (a nav target) is minted in create-absent-first; Overview (a nav source) is created in
    // upload-once. Each page is uploaded exactly once — no duplicate.
    assert.strictEqual(genpageCli.uploads.filter((u) => u.name === 'Detail').length, 1);
    assert.strictEqual(genpageCli.uploads.filter((u) => u.name === 'Overview').length, 1);
    const writes = calls.filter((c) => (c.name === 'createWebResource' && /_pagemanifest$/.test(c.args[0].name)) || c.name === 'updateWebResource');
    const last = writes[writes.length - 1];
    const byKey = Object.fromEntries(JSON.parse((last.args[1] || last.args[0]).content).pages.map((p) => [p.key, p.pageId]));
    assert.strictEqual(byKey.overview, 'gp-overview');
    assert.strictEqual(byKey.detail, 'gp-detail');
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

test('deploy: a rebuild re-binds ids from the live enumeration and issues only UPDATEs (no duplicate CREATE)', async () => {
  const appDir = path.join(__dirname, '.tmp-pages-deploy-6');
  try {
    const live = [{ pageId: 'gp-overview', name: 'Overview' }, { pageId: 'gp-detail', name: 'Detail' }];
    const manifest = Buffer.from(JSON.stringify({ schemaVersion: 1, pages: [{ key: 'overview', name: 'Overview', pageId: 'gp-overview' }, { key: 'detail', name: 'Detail', pageId: 'gp-detail' }] }), 'utf8').toString('base64');
    const { sdk } = mockSdk({ pageManifest: manifest, manifestId: 'wr-manifest' });
    const genpageCli = mockGenpageCli(live);
    await runSdkBuild(makeTwoPageApp(appDir), { sdk, apply: true, env: 'https://x', appDir, genpageCli, phases: PHASES });
    assert.ok(genpageCli.uploads.length > 0);
    assert.ok(genpageCli.uploads.every((u) => !!u.requestedId), 'every upload targets a known pageId (UPDATE) — no CREATE, no duplicate');
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test scripts/tests/sdk-build-pages-deploy.test.js`
Expected: FAIL — Task 4's loop uploads canonical directly (no staging, no scan/parity halts).

- [ ] **Step 3: Add the require + helpers to `scripts/lib/sdk-build.js`**

Require (`:20-31` region):

```javascript
const { resolvePageRefs, referencedKeys, scanRawPageRefs, navTargetParity } = require('./pageref-resolver.js');
```

Helpers (next to `persistPageManifest`):

```javascript
// True when any page declares cross-page navigation. Deterministic from the spec, so planFor can plan
// the single "resolve cross-page navigation" step (create-absent-first + resolve) without runtime state.
function appHasCrossPageNav(spec) {
  return ((spec && spec.pages) || []).some((p) => (p.navigatesTo || []).length > 0);
}

// Write a RESOLVED deployment copy of a page's .tsx into the run-scoped staging dir — NEVER over the
// canonical source (a GUID baked into canonical breaks cross-env recreate; design §9 / SDK T5). pac
// genpage upload takes a file PATH, so resolved bytes must exist on disk. The dir is created per RUN
// under <workspace>/.pageref-deploy/<runId>/ and removed in a finally (I4 — never leave env GUIDs on
// disk, no sanitized-name cross-run collision). The key is sanitized to a safe filename.
function writeStagingFile(stagingDir, key, code) {
  fs.mkdirSync(stagingDir, { recursive: true });
  const file = path.join(stagingDir, `${String(key).replace(/[^A-Za-z0-9_-]/g, '_')}.tsx`);
  fs.writeFileSync(file, code, 'utf8');
  return file;
}

// App-scoped single-writer lease over the pages protocol (design §9 / I4). Two concurrent builds of the
// SAME app must not both enumerate "absent" and CREATE duplicate pages. Implemented as an exclusive lock
// file (fs 'wx' create fails if it already exists). A stale lock (older than staleMs — a crashed build)
// is stolen once; a fresh lock held by another live build HALTs (code 'pages-locked', recoverable). This
// guards concurrency within the shared app workspace; it is not a cross-machine distributed lock (out of
// scope — concurrent builds share the app's .maker-workspace). `deps` is a test seam (now/staleMs).
function acquireAppPagesLease(wsDir, appUnique, deps = {}) {
  const now = deps.now || (() => Date.now());
  const staleMs = deps.staleMs || 15 * 60 * 1000;
  fs.mkdirSync(wsDir, { recursive: true });
  const lockPath = path.join(wsDir, `pages-${String(appUnique).replace(/[^A-Za-z0-9_-]/g, '_')}.lock`);
  const create = () => { const fd = fs.openSync(lockPath, 'wx'); fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: now() })); fs.closeSync(fd); };
  try { create(); }
  catch (e) {
    if (e.code !== 'EEXIST') throw e;
    let held = {};
    try { held = JSON.parse(fs.readFileSync(lockPath, 'utf8')); } catch { /* unreadable → treat as stale */ }
    if (!held.at || now() - held.at > staleMs) { fs.rmSync(lockPath, { force: true }); create(); } // steal a crashed lease
    else throw new BuildHalt(`another build is deploying pages for '${appUnique}' (lock held by pid ${held.pid}) — refusing a second concurrent pages deploy (would risk duplicate page creation). Retry after it completes.`, { phase: 'pages', code: 'pages-locked', recoverable: true });
  }
  return { release: () => { try { fs.rmSync(lockPath, { force: true }); } catch { /* best-effort */ } } };
}
```

- [ ] **Step 4: Replace the pages phase upload loop with the §9 protocol**

Replace the Task 4 pages phase body (from the `enumerate` call through the finalize block) with the leased, run-scoped protocol below. The `pages-requires-app` guard and the `enumerate`/`reconcile`/ambiguous-HALT stay; the middle loop becomes scan → create-absent-first → resolve → upload-once; a `try/finally` cleans staging + releases the lease.

```javascript
  if (has('pages') && (spec.pages || []).length) {
    const genpageCli = opts.genpageCli || makeGenpageCli(opts.env);
    const appUnique = appUniqueName(spec);
    if (!result.created.app) {
      throw new BuildHalt('pages phase requires the app (app-shell) in the same run — the app id is not carried across invocations. Re-run a FULL build (do not use --from pages).', { phase: 'pages', code: 'pages-requires-app', recoverable: false });
    }
    const wsDir = opts.workspaceDir || path.join(path.resolve(opts.appDir || '.'), '.maker-workspace');
    const lease = acquireAppPagesLease(wsDir, appUnique);      // I4: single-writer over enumerate → finalize
    const stagingDir = path.join(wsDir, '.pageref-deploy', randomUUID());
    try {
      const enumd = await genpageCli.enumerate({ appId: result.created.app });
      if (!enumd.ok) throw new BuildHalt(`page enumeration failed — refusing to (re)create pages against an unknown page set: ${enumd.error || 'pac genpage list returned non-zero'}`, { phase: 'pages', code: 'pages-enumeration-failed', recoverable: true });
      const { id: readId, manifest, text } = await readPageManifest(provision, appUnique);
      let manifestId = readId;
      let lastManifestContent = text;
      const { keyToId, ambiguous } = reconcilePageIds(spec.pages, manifest, enumd.pages);
      if (ambiguous.length) throw new BuildHalt(`ambiguous page name(s) ${ambiguous.map((a) => `"${a.name}"`).join(', ')} — multiple live pages share a display name; refusing to overwrite an arbitrary one. Rename or remove the duplicate in Maker, then rebuild.`, { phase: 'pages', code: 'pages-ambiguous-name', recoverable: false });

      const keyOf = (p) => p.key || p.name;
      const canonicalPath = (p) => path.resolve(opts.appDir || '.', normalizePageSource(p).codeFile);
      const implemented = [];
      for (const p of spec.pages) {
        const src = normalizePageSource(p);
        if (src && src.kind === 'tsx' && src.codeFile) implemented.push(p);
        else runner.skip('pages', `page "${p.name}" (no tsx source)`);
      }

      // (1) SCAN every implemented canonical source BEFORE any write (C4). Reject a malformed
      //     (non-canonical) PAGEREF_ and enforce EXACT parity between declared navigatesTo targetKeys and
      //     the keys actually referenced — catching a wrong-quoted ref, a declared edge absent from source,
      //     and a source ref with no declaration, all before a page is created.
      const sourceByKey = new Map();
      for (const p of implemented) {
        const code = fs.readFileSync(canonicalPath(p), 'utf8');
        sourceByKey.set(keyOf(p), code);
        const scan = scanRawPageRefs(code);
        if (scan.malformed.length) throw new BuildHalt(`page "${p.name}" has malformed navigation reference(s): ${scan.malformed.join(', ')} — a cross-page link must be a double-quoted "PAGEREF_<key>" literal`, { phase: 'pages', code: 'pages-malformed-navref', recoverable: false });
        const { declaredNotReferenced, referencedNotDeclared } = navTargetParity((p.navigatesTo || []).map((n) => n.targetKey), referencedKeys(code));
        if (declaredNotReferenced.length || referencedNotDeclared.length) throw new BuildHalt(`page "${p.name}" navigation parity mismatch — declared-but-absent: [${declaredNotReferenced.join(', ')}], referenced-but-undeclared: [${referencedNotDeclared.join(', ')}]`, { phase: 'pages', code: 'pages-nav-parity', recoverable: false });
      }

      const navTargets = new Set();
      for (const p of implemented) for (const n of p.navigatesTo || []) navTargets.add(n.targetKey);
      const mintedKeys = new Set();
      const deployment = new Map(); // key -> resolved code (nav sources only)

      // (2+3) Inside ONE "resolve cross-page navigation" step: create-absent-first for absent nav TARGETS
      //       (upload symbolic source to mint an id; persist the manifest IMMEDIATELY for crash-safety),
      //       then RESOLVE the graph now that every referenced target has an id (fail-closed on dangling).
      if (appHasCrossPageNav(spec)) {
        await runner.run('pages', 'resolve cross-page navigation', async () => {
          for (const p of implemented) {
            const key = keyOf(p);
            if (keyToId.has(key) || !navTargets.has(key)) continue; // only ABSENT targets need pre-minting
            const up = await genpageCli.upload({ appId: result.created.app, codeFile: canonicalPath(p), name: p.name, prompt: p.prompt, agentMessage: p.agentMessage, dataSources: p.dataSources });
            keyToId.set(key, up.pageId);
            result.created.pages[key] = up.pageId;
            mintedKeys.add(key);
            const persisted = await persistPageManifest(provision, spec, keyToId, sol, appUnique, manifestId, lastManifestContent);
            manifestId = persisted.id; lastManifestContent = persisted.content;
          }
          const navSources = new Map();
          for (const p of implemented) if ((p.navigatesTo || []).length) navSources.set(keyOf(p), { code: sourceByKey.get(keyOf(p)) });
          const { deployment: dep, unresolved } = resolvePageRefs(navSources, keyToId);
          if (unresolved.length) throw new BuildHalt(`unresolved cross-page navigation target(s): ${unresolved.join(', ')} — a page navigates to a key that isn't a built page`, { phase: 'pages', code: 'pages-dangling-navref', recoverable: false });
          for (const [k, code] of dep) deployment.set(k, code);
          return `${deployment.size} navigation source(s)`;
        });
      }

      // (4) UPLOAD-ONCE — exactly one runner.run/skip per page (Minor 1). A non-nav page already minted in
      //     step 2 is final (skip; re-upload would be wasted). Every UPDATE asserts the returned id matches
      //     the requested id (I7) so previously-resolved siblings never point at a stale target.
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
          return up.pageId;
        });
      }

      // (5) Persist the FINAL manifest (content-deduped → a no-op when create-absent-first already wrote
      //     the final ids), then finalize the sitemap (the true commit point).
      await runner.run('pages', `page manifest ${manifestResourceName(appUnique)}`, async () => {
        const persisted = await persistPageManifest(provision, spec, keyToId, sol, appUnique, manifestId, lastManifestContent);
        manifestId = persisted.id; lastManifestContent = persisted.content;
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

(b) `build-model-app.js` — pass the workspace so the lease/staging live under the real workspace dir: add `workspaceDir` to `opts` (`:311-322`) and thread it into the `runSdkBuild` call (`:196-207`):

```javascript
// :311-322 opts — add:
    workspaceDir,
// :196-207 runSdkBuild opts — add:
    workspaceDir: opts.workspaceDir,
```

- [ ] **Step 6: Run the deploy tests + prior pages tests + full suite**

Run: `node --test scripts/tests/sdk-build-pages-deploy.test.js scripts/tests/sdk-build.test.js scripts/tests/sdk-build-pages-migrate.test.js`
Expected: PASS — the deploy protocol tests green; the Task 4/5 single/no-nav pages tests still green (no `navigatesTo` → no resolve step → per-page upload-once behaves like the simple loop).

Then: `node scripts/run-tests.js`
Expected: PASS — suite green (≈ 617).

- [ ] **Step 7: Commit**

```bash
git add scripts/lib/sdk-build.js scripts/build-model-app.js scripts/tests/sdk-build-pages-deploy.test.js
git commit -m "feat(model-apps): PAGEREF_ protocol — scan/parity, create-absent-first, staging, upload-once, lease" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>" \
  -m "Copilot-Session: 42626da2-b66f-4162-acaa-b1127ef23d89"
```

---

## Task 7: Failure-ordering, restart-convergence, concurrency HALT, and full-rerun recovery (I1, I6)

Locks the protocol's ordering with explicit CALL-SEQUENCE + restart-convergence tests (I6), proves the app-scoped lease HALTs a second concurrent build (I4), and rejects an unsafe apply-time phase range (I1). Pure test/guard additions on top of Task 6.

**Files:**
- Create: `scripts/tests/sdk-build-pages-order.test.js`.
- Modify: `scripts/build-model-app.js` — reject an apply that includes `pages` but not `app-shell` (I1).
- Modify: `scripts/tests/build-model-app.test.js` — the I1 rejection test.

- [ ] **Step 1: Write the failing ordering tests** — create `scripts/tests/sdk-build-pages-order.test.js`

```javascript
'use strict';
// Failure-ordering + restart-convergence for the §9 pages protocol (I6): the sitemap is committed ONLY
// after every resolved upload, a crashed build converges on re-run without duplicate creates, and a
// second concurrent build is refused by the app-scoped lease (I4).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { runSdkBuild, appUniqueName } = require('../lib/sdk-build.js');

// Stateful harness: enumerate() reflects pages a create appended; the manifest webresource persists in
// `store`. `failPushAt` fails the Nth pushArtifact (2 = the pages finalize, after app-create push 1).
function harness({ failPushAt } = {}) {
  const live = [];
  const calls = [];
  const store = {};
  let manifestB64 = null;
  let pushN = 0;
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
    pushArtifact: async (t, id) => { pushN += 1; if (failPushAt && pushN === failPushAt) return { type: t, id, success: false, error: { message: 'version conflict (412)' } }; return { type: t, id, success: true }; },
    addSolutionComponent: async () => {}, publishArtifact: async () => {},
  };
  const genpageCli = {
    uploads: [],
    list: async () => live.slice(),
    enumerate: async () => ({ ok: true, pages: live.slice(), empty: live.length === 0 }),
    upload: async (o) => {
      const pageId = o.pageId || `gp-${String(o.name).toLowerCase()}`;
      genpageCli.uploads.push({ name: o.name, requestedId: o.pageId, resolvedId: pageId });
      if (!o.pageId && !live.some((p) => p.name === o.name)) live.push({ pageId, name: o.name });
      return { pageId };
    },
  };
  return { sdk, genpageCli, calls };
}

function twoPageApp(appDir) {
  fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(path.join(appDir, 'overview.tsx'), 'export default function O(){ const p = "PAGEREF_detail"; return p; }', 'utf8');
  fs.writeFileSync(path.join(appDir, 'detail.tsx'), 'export default function D(){ return null; }', 'utf8');
  return {
    schemaVersion: 2, solution: { uniqueName: 'PgOrd', displayName: 'Pg', publisherPrefix: 'contoso' }, app: { name: 'Order App' },
    entities: [{ schemaName: 'contoso_item', displayName: 'Item', primaryAttribute: { schemaName: 'contoso_name', displayName: 'Name' }, columns: [] }],
    pages: [
      { key: 'overview', name: 'Overview', navigatesTo: [{ targetKey: 'detail' }], source: { kind: 'tsx', codeFile: 'overview.tsx' } },
      { key: 'detail', name: 'Detail', source: { kind: 'tsx', codeFile: 'detail.tsx' } },
    ],
    appShell: { areas: [{ label: 'Main', groups: [{ label: 'Pages', subAreas: [{ page: 'overview', title: 'Overview' }, { page: 'detail', title: 'Detail' }] }] }] },
  };
}
const PHASES = ['solution', 'data-model', 'app-shell', 'pages'];

test('SEQUENCE: the manifest is persisted BEFORE the sitemap finalize, and no manifest write follows it (I6)', async () => {
  const appDir = path.join(__dirname, '.tmp-pages-order-1');
  try {
    const h = harness();
    await runSdkBuild(twoPageApp(appDir), { sdk: h.sdk, apply: true, env: 'https://x', appDir, genpageCli: h.genpageCli, phases: PHASES });
    const isManifest = (c) => (c.name === 'createWebResource' && /_pagemanifest$/.test(c.args[0].name)) || c.name === 'updateWebResource';
    const finalizeIdx = h.calls.findIndex((c) => c.name === 'updateElement' && c.args[2] === '/siteMap');
    const manifestIdxs = h.calls.map((c, i) => (isManifest(c) ? i : -1)).filter((i) => i >= 0);
    assert.ok(finalizeIdx >= 0 && manifestIdxs.length >= 1);
    assert.ok(manifestIdxs.every((i) => i < finalizeIdx), 'every manifest write precedes the sitemap finalize');
    assert.strictEqual(h.calls.filter((c) => c.name === 'updateWebResource').length <= 1, true, 'content-dedup: at most one in-place update, no redundant final persist (I6)');
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

test('RESTART-CONVERGENCE: a build that crashes at the finalize re-runs with NO duplicate create (crash-after-create)', async () => {
  const appDir = path.join(__dirname, '.tmp-pages-order-2');
  try {
    const h = harness({ failPushAt: 2 }); // push 1 = app-shell create; push 2 = pages finalize → fail
    await assert.rejects(runSdkBuild(twoPageApp(appDir), { sdk: h.sdk, apply: true, env: 'https://x', appDir, genpageCli: h.genpageCli, phases: PHASES }));
    const afterRun1 = h.genpageCli.uploads.length;
    assert.ok(afterRun1 >= 2, 'run 1 created the pages before the finalize crash');
    // Re-run (full build). Enumeration + manifest now bind both pages → only UPDATEs, no new create.
    await runSdkBuild(twoPageApp(appDir), { sdk: h.sdk, apply: true, env: 'https://x', appDir, genpageCli: h.genpageCli, phases: PHASES });
    const run2 = h.genpageCli.uploads.slice(afterRun1);
    assert.ok(run2.length > 0 && run2.every((u) => !!u.requestedId), 'run 2 issues only UPDATEs — the crashed run converges without duplicating pages');
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

test('FAILURE-ORDER: an upload failure before the finalize leaves the sitemap unwritten', async () => {
  const appDir = path.join(__dirname, '.tmp-pages-order-3');
  try {
    const h = harness();
    // Fail the upload-once of Overview (after Detail is minted in create-absent-first).
    const realUpload = h.genpageCli.upload;
    h.genpageCli.upload = async (o) => { if (o.name === 'Overview' && o.codeFile && /pageref-deploy/.test(o.codeFile)) throw new Error('pac upload failed'); return realUpload(o); };
    await assert.rejects(runSdkBuild(twoPageApp(appDir), { sdk: h.sdk, apply: true, env: 'https://x', appDir, genpageCli: h.genpageCli, phases: PHASES }));
    assert.ok(!h.calls.some((c) => c.name === 'updateElement' && c.args[2] === '/siteMap'), 'the sitemap is NOT finalized when an upload fails before the commit point');
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

test('CONCURRENCY: a second build HALTs (pages-locked) while the app-scoped lease is held (I4)', async () => {
  const appDir = path.join(__dirname, '.tmp-pages-order-4');
  try {
    const spec = twoPageApp(appDir);
    const wsDir = path.join(appDir, '.maker-workspace');
    fs.mkdirSync(wsDir, { recursive: true });
    // Simulate a concurrent build holding the lease (fresh timestamp so it is not stolen as stale).
    const lockPath = path.join(wsDir, `pages-${appUniqueName(spec).replace(/[^A-Za-z0-9_-]/g, '_')}.lock`);
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999, at: Date.now() }));
    const h = harness();
    await assert.rejects(
      runSdkBuild(spec, { sdk: h.sdk, apply: true, env: 'https://x', appDir, genpageCli: h.genpageCli, phases: PHASES }),
      (e) => e && e.phase === 'pages' && e.code === 'pages-locked'
    );
    assert.strictEqual(h.genpageCli.uploads.length, 0, 'no page uploaded while the lease is held by another build');
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run — the SEQUENCE/order tests should PASS on Task 6's protocol, the I1 CLI test still fails**

Run: `node --test scripts/tests/sdk-build-pages-order.test.js`
Expected: PASS (Task 6 already implements the lease, the persist-before-finalize order, and forward-only convergence — this task locks them with tests).

- [ ] **Step 3: I1 — reject an unsafe apply-time phase range** — add the failing test to `scripts/tests/build-model-app.test.js`

```javascript
test('I1: apply refuses a phase selection that includes pages but excludes app-shell (no --from pages)', async () => {
  const spec = { solution: { uniqueName: 'S', publisherPrefix: 'new' }, app: { name: 'A' }, entities: [{ schemaName: 'new_x', primaryAttribute: { schemaName: 'new_name' }, columns: [] }], pages: [{ key: 'p', name: 'P', source: { kind: 'tsx', codeFile: 'p.tsx' } }], appShell: { areas: [] } };
  const r = await buildModelApp(spec, { apply: true, phases: ['pages'] }, { log: () => {} });
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.join(' ').match(/app-shell|full build/i));
});
```

Run: `node --test scripts/tests/build-model-app.test.js` → FAIL.

Implement the guard in `scripts/lib/`… — in `build-model-app.js` (add `PHASES` to the `sdk-build.js` require, then guard at the top of `buildModelApp`, before the write loop):

```javascript
// Near the top of buildModelApp, before discovery/write:
// I1: the app id is populated only by app-shell in THIS run and is never carried across invocations
// (design §5). Applying `pages` without `app-shell` would run the finalizer against no app — reject it
// and require a FULL rerun instead of a spurious --from pages resume.
if (opts.apply) {
  const active = opts.phases || PHASES;
  if (active.includes('pages') && !active.includes('app-shell')) {
    const msg = 'refusing to apply the pages phase without app-shell in the same run — the app id is not carried across runs (design §5). Re-run a FULL build; do not use --from pages.';
    log(`\n✗ ${msg}`);
    return { ok: false, errors: [msg] };
  }
}
```

Run: `node --test scripts/tests/build-model-app.test.js` → PASS.

- [ ] **Step 4: Full suite**

Run: `node scripts/run-tests.js`
Expected: PASS — suite green (≈ 623).

- [ ] **Step 5: Commit**

```bash
git add scripts/build-model-app.js scripts/tests/sdk-build-pages-order.test.js scripts/tests/build-model-app.test.js
git commit -m "test(model-apps): pages failure-ordering, restart-convergence, lease HALT + full-rerun guard" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>" \
  -m "Copilot-Session: 42626da2-b66f-4162-acaa-b1127ef23d89"
```

---

## Task 8: C1 — page verification (exists / GenPageId-bound / every nav edge → ACTUAL target id) + mandatory fail-closed gate

Adds the promised-but-missing verification: a fail-closed page reader + cached download (`verify-model-app.js`), page checks in the pure `verifySpec` (`verify-spec.js`) that assert **every declared nav edge resolves to the actual target page's live `GenPageId`** (not merely "no `PAGEREF_` remains" — a stale/wrong GUID has no placeholder yet is broken), and a **mandatory + fail-closed** page-verify gate so an unverifiable page set exits the build non-zero (`build-model-app.js`).

**Files:**
- Modify: `scripts/lib/verify-spec.js` — page branch + `subareaHasGenPage` + `appShellReferencesPage`; import `normalizePageSource`, `referencedKeys`, `scanRawPageRefs`.
- Modify: `scripts/verify-model-app.js` — `appIdFor`; `readerFor(sdk, appUnique, { genpageCli, workspaceDir })` gains fail-closed `pages()` + cached `pageCode()`; `main` builds a `genpageCli` + workspace.
- Modify: `scripts/build-model-app.js` — mandatory + fail-closed page verify (`:223-243`); pass `{ genpageCli, workspaceDir }` to `readerFor` (`:336-340`); import `normalizePageSource`.
- Modify: `scripts/tests/verify-spec.test.js`, `scripts/tests/verify-model-app.test.js`, `scripts/tests/build-model-app.test.js` — new assertions.

**Interfaces:**
- `read.pages() → [{ pageId, name }]` (throws fail-closed on an enumeration failure); `read.pageCode(pageId) → string` (throws on a download failure; download cached once).
- `verifySpec` adds checks: `page` (exists), `page-subarea` (GenPageId bound), `page-no-pageref` (no residual/malformed `PAGEREF_`), `page-nav` (per edge → actual target id), `page-code` (download failure).

- [ ] **Step 1: Write the failing `verifySpec` tests** — append to `scripts/tests/verify-spec.test.js`

```javascript
// Minimal read mock: satisfies entity/column/sitemap reads + the new page reader.
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

test('verifySpec pages: present + GenPageId-bound + nav edge resolves to the actual target id → ok', async () => {
  const live = [{ pageId: 'gp-overview', name: 'Overview' }, { pageId: 'gp-detail', name: 'Detail' }];
  const sitemap = '<SiteMap><Area><Group><SubArea Id="s1" Url="gp-overview"/><SubArea Id="s2" Url="gp-detail"/></Group></Area></SiteMap>';
  const read = pageRead({ live, sitemap, code: { 'gp-overview': 'pageId: "gp-detail"' } });
  const r = await require('../lib/verify-spec.js').verifySpec(pageSpec(), read);
  assert.ok(r.checks.some((c) => c.kind === 'page' && c.name === 'Overview' && c.present));
  assert.ok(r.checks.some((c) => c.kind === 'page-nav' && c.name === 'Overview -> detail' && c.present));
  assert.ok(r.checks.filter((c) => c.kind.startsWith('page')).every((c) => c.present), 'all page checks present');
});

test('verifySpec pages: a WRONG deployed GUID in the nav literal FAILS the nav check (C1 wrong-GUID)', async () => {
  const live = [{ pageId: 'gp-overview', name: 'Overview' }, { pageId: 'gp-detail', name: 'Detail' }];
  const sitemap = '<SiteMap><Area><Group><SubArea Id="s1" Url="gp-overview"/><SubArea Id="s2" Url="gp-detail"/></Group></Area></SiteMap>';
  // The deployed code points at some OTHER guid, not gp-detail — no PAGEREF_ remains, yet it is broken.
  const read = pageRead({ live, sitemap, code: { 'gp-overview': 'pageId: "00000000-dead-beef-0000-000000000000"' } });
  const r = await require('../lib/verify-spec.js').verifySpec(pageSpec(), read);
  assert.ok(r.checks.some((c) => c.kind === 'page-nav' && c.name === 'Overview -> detail' && !c.present), 'nav edge must resolve to the ACTUAL target id, not just "no PAGEREF_"');
  assert.strictEqual(r.ok, false);
});

test('verifySpec pages: a residual PAGEREF_ in deployed code FAILS the no-pageref check', async () => {
  const live = [{ pageId: 'gp-overview', name: 'Overview' }, { pageId: 'gp-detail', name: 'Detail' }];
  const sitemap = '<SiteMap><Area><Group><SubArea Id="s2" Url="gp-detail"/></Group></Area></SiteMap>';
  const read = pageRead({ live, sitemap, code: { 'gp-overview': 'pageId: "PAGEREF_detail"' } });
  const r = await require('../lib/verify-spec.js').verifySpec(pageSpec(), read);
  assert.ok(r.checks.some((c) => c.kind === 'page-no-pageref' && !c.present));
  assert.strictEqual(r.ok, false);
});

test('verifySpec pages: a page missing from the live enumeration FAILS the page check', async () => {
  const read = pageRead({ live: [{ pageId: 'gp-detail', name: 'Detail' }], sitemap: '', code: {} });
  const r = await require('../lib/verify-spec.js').verifySpec(pageSpec(), read);
  assert.ok(r.checks.some((c) => c.kind === 'page' && c.name === 'Overview' && !c.present));
  assert.strictEqual(r.ok, false);
});
```

- [ ] **Step 2: Run to verify failure** — `node --test scripts/tests/verify-spec.test.js` → FAIL (no page branch).

- [ ] **Step 3: Add the page branch to `scripts/lib/verify-spec.js`**

Imports (top):

```javascript
const { normalizePageSource } = require('./app-spec.js');
const { referencedKeys, scanRawPageRefs } = require('./pageref-resolver.js');
```

Add the page branch inside `verifySpec` (after the sitemap-subarea loop, before `const missing = ...`):

```javascript
  // Pages (design §13.1). Mandatory when the spec declares implemented pages; the reader is FAIL-CLOSED
  // (read.pages() throws on an enumeration failure, read.pageCode() throws on a download failure), so a
  // verify against an unreadable app cannot silently pass.
  const implementedPages = (spec.pages || []).filter((p) => { const s = normalizePageSource(p); return s && s.kind === 'tsx' && s.codeFile; });
  if (implementedPages.length && read.pages) {
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
      if (nav.length) {
        let code;
        try { code = (await read.pageCode(pageId)) || ''; }
        catch (e) { add('page-code', p.name, false, String((e && e.message) || e)); continue; }
        // No residual/malformed PAGEREF_ means the resolve+upload step actually ran on this page.
        const raw = scanRawPageRefs(code);
        add('page-no-pageref', p.name, referencedKeys(code).length === 0 && raw.malformed.length === 0);
        for (const edge of nav) {
          // The nav literal must equal the ACTUAL live GenPageId of the target — a stale/wrong GUID is
          // still a broken link even though no PAGEREF_ placeholder remains.
          const targetId = idForKey(edge.targetKey);
          const present = !!targetId && new RegExp('["\'`]' + escapeRe(String(targetId)) + '["\'`]', 'i').test(code);
          add('page-nav', `${p.name} -> ${edge.targetKey}`, present);
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

// True when some sitemap <SubArea> carries this GenPageId (braces stripped, case-insensitive). The
// generative-page subarea stores the page id in an attribute value; match the id anywhere within the
// SubArea start-tag. Confirm the exact attribute name against a live sitemap and tighten if the SDK
// serializes GenPage subareas with a dedicated attribute.
function subareaHasGenPage(xml, genPageId) {
  const target = String(genPageId).replace(/[{}]/g, '');
  const re = /<SubArea\b[^>]*>/gi;
  let m;
  while ((m = re.exec(xml)) !== null) if (new RegExp('="\\{?' + escapeRe(target) + '\\}?"', 'i').test(m[0])) return true;
  return false;
}
```

Update the `module.exports` to include `subareaHasGenPage`, `appShellReferencesPage`.

Run: `node --test scripts/tests/verify-spec.test.js` → PASS.

- [ ] **Step 4: Fail-closed page reader + cached download** — append the failing test to `scripts/tests/verify-model-app.test.js`

```javascript
const os = require('node:os');
const fs = require('node:fs');
const pathm = require('node:path');
const { readerFor } = require('../verify-model-app.js');

function stubSdk() { return { queryRecords: async () => [{ appmoduleid: 'app-1' }], findTables: async () => [], findColumns: async () => [] }; }

test('readerFor.pages() HALTS fail-closed when enumeration fails', async () => {
  const reader = readerFor(stubSdk(), 'contoso_app', { genpageCli: { enumerate: async () => ({ ok: false, error: 'auth expired' }) }, workspaceDir: fs.mkdtempSync(pathm.join(os.tmpdir(), 'vf-')) });
  await assert.rejects(reader.pages(), /enumeration failed/i);
});

test('readerFor.pageCode downloads ONCE (cached) and returns the page code; a download failure throws', async () => {
  const ws = fs.mkdtempSync(pathm.join(os.tmpdir(), 'vf-'));
  let downloads = 0;
  const genpageCli = {
    enumerate: async () => ({ ok: true, pages: [{ pageId: 'gp-1', name: 'Overview' }] }),
    download: async ({ outputDir }) => { downloads += 1; fs.mkdirSync(pathm.join(outputDir, 'gp-1'), { recursive: true }); fs.writeFileSync(pathm.join(outputDir, 'gp-1', 'page.tsx'), 'pageId: "gp-2"', 'utf8'); return true; },
  };
  const reader = readerFor(stubSdk(), 'contoso_app', { genpageCli, workspaceDir: ws });
  assert.strictEqual(await reader.pageCode('gp-1'), 'pageId: "gp-2"');
  await reader.pageCode('gp-1');
  assert.strictEqual(downloads, 1, 'download runs once and is cached');

  const failing = readerFor(stubSdk(), 'contoso_app', { genpageCli: { enumerate: async () => ({ ok: true, pages: [] }), download: async () => { throw new Error('pac download failed'); } }, workspaceDir: fs.mkdtempSync(pathm.join(os.tmpdir(), 'vf-')) });
  await assert.rejects(failing.pageCode('gp-1'), /download failed/i);
});
```

Run: `node --test scripts/tests/verify-model-app.test.js` → FAIL.

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
    const outDir = require('node:path').join(workspaceDir, 'verify-pages');
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.mkdirSync(outDir, { recursive: true });
    await genpageCli.download({ appId: id, outputDir: outDir });
    for (const entry of fs.readdirSync(outDir)) {
      const tsx = require('node:path').join(outDir, entry, 'page.tsx');
      if (fs.existsSync(tsx)) codeById.set(String(entry).toLowerCase(), fs.readFileSync(tsx, 'utf8'));
    }
  })()));
  return {
    findTable: async (logical) => { const l = String(logical).toLowerCase(); const t = await sdk.findTables(l); return (t || []).find((x) => String(x.logicalName).toLowerCase() === l) || null; },
    findColumns: async (logical) => sdk.findColumns(logical),
    queryRecords: (set, o) => sdk.queryRecords(set, o),
    sitemapXml: () => sitemapXmlFor(sdk, appUnique),
    pages: async () => {
      if (!genpageCli) return [];
      const r = await genpageCli.enumerate({ appId: await appId() });
      if (!r.ok) throw new Error(`page enumeration failed during verify: ${r.error || 'pac genpage list returned non-zero'}`);
      return r.pages;
    },
    pageCode: async (pageId) => { await ensureDownloaded(); return codeById.get(String(pageId).toLowerCase()) || ''; },
  };
}
```

In `main()`, build the reader with a genpageCli + workspace:

```javascript
  const genpageCli = makeGenpageCli(env);
  const r = await verifySpec(spec, readerFor(sdk, appUniqueName(spec), { genpageCli, workspaceDir }));
```

Run: `node --test scripts/tests/verify-model-app.test.js` → PASS.

- [ ] **Step 5: Mandatory + fail-closed page verify in `build-model-app.js`** — append the failing test to `scripts/tests/build-model-app.test.js`

```javascript
function pageBearingSpec() {
  return { solution: { uniqueName: 'S', publisherPrefix: 'new' }, app: { name: 'A' }, entities: [{ schemaName: 'new_x', primaryAttribute: { schemaName: 'new_name' }, columns: [] }],
    pages: [{ key: 'p', name: 'P', source: { kind: 'tsx', codeFile: 'p.tsx' } }],
    appShell: { areas: [{ label: 'M', groups: [{ label: 'G', subAreas: [{ page: 'p', title: 'P' }] }] }] } };
}

test('page verify is MANDATORY even without --verify: a failing page verify exits non-zero (C1)', async () => {
  const spec = pageBearingSpec();
  const deps = { log: () => {}, sdk: {}, provisionSdk: {}, verify: async () => ({ ok: false, checks: [{ kind: 'page', name: 'P' }], missing: [{ kind: 'page', name: 'P' }] }),
    runBuild: async () => ({ ok: true, created: { app: 'app-1' } }) }; // inject a successful apply
  const r = await buildModelApp(spec, { apply: true, phases: PHASES_WITH_PAGES, verify: false }, deps);
  assert.strictEqual(r.verify.ok, false, 'page verify ran and failed despite --verify not being set');
});

test('page verify is FAIL-CLOSED: a verify that cannot run is fatal for a page-bearing spec', async () => {
  const spec = pageBearingSpec();
  const deps = { log: () => {}, sdk: {}, provisionSdk: {}, verify: async () => { throw new Error('page enumeration failed during verify'); },
    runBuild: async () => ({ ok: true, created: { app: 'app-1' } }) };
  const r = await buildModelApp(spec, { apply: true, phases: PHASES_WITH_PAGES, verify: false }, deps);
  assert.strictEqual(r.verify.ok, false);
  assert.ok(r.verify.unableToRun, 'an unrunnable verify is fatal for pages');
});
```

> Use the test file's existing successful-apply injection seam for `deps` (mirror the closest existing build test); `PHASES_WITH_PAGES` is the full `PHASES` list. If the existing tests inject the applied build differently, follow that pattern — the assertion is on `r.verify`.

Run: `node --test scripts/tests/build-model-app.test.js` → FAIL.

Implement in `scripts/lib/`… `build-model-app.js`: import `normalizePageSource` (from `./lib/app-spec.js`), then make the post-apply verify mandatory + fail-closed (`:231-242`):

```javascript
    const hasImplementedPages = (spec.pages || []).some((p) => { const s = normalizePageSource(p); return s && s.kind === 'tsx' && s.codeFile; });
    // Page verify is MANDATORY + FAIL-CLOSED when the spec has implemented pages (design §13.1): it runs
    // even without --verify, and a verify that CANNOT run is fatal (r.verify.ok=false → non-zero exit) so
    // an unreadable page set never passes silently. For a page-less spec, --verify keeps today's behavior.
    if ((opts.verify || hasImplementedPages) && deps.verify) {
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
```

Thread `{ genpageCli, workspaceDir }` into the `readerFor` call (`:336-340`):

```javascript
      verify: (s) => verifySpec(s, readerFor(provisionSdk, appUniqueName(s), { genpageCli: makeGenpageCli(env), workspaceDir })),
```

(Import `makeGenpageCli` in `build-model-app.js` if not already present.)

Run: `node --test scripts/tests/build-model-app.test.js` → PASS.

- [ ] **Step 6: Full suite**

Run: `node scripts/run-tests.js`
Expected: PASS — suite green (≈ 631).

- [ ] **Step 7: Commit**

```bash
git add scripts/lib/verify-spec.js scripts/verify-model-app.js scripts/build-model-app.js scripts/tests/verify-spec.test.js scripts/tests/verify-model-app.test.js scripts/tests/build-model-app.test.js
git commit -m "feat(model-apps): page verification (nav-edge->actual id) + mandatory fail-closed gate (C1)" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>" \
  -m "Copilot-Session: 42626da2-b66f-4162-acaa-b1127ef23d89"
```

---

## Task 9: I3/C1 — manifest-aware download + hydration round-trip (reverse-normalize, keys, legacy migration)

Closes the round-trip: `download-model-app.js` fetches the `<uniquename>_pagemanifest`, **reconciles its ids against the fail-closed live enumeration** before inversion, assigns stable keys (minting fresh keys for a legacy app per §7.3 — not the old name shape), **reverse-normalizes only validated navigation `pageId` literals** back to `PAGEREF_<key>`, and **fails if any enumerated page was not downloaded**. `hydrate-spec.js` reconstructs the v2 page shape + `design` + key-based GenPage subareas.

**Files:**
- Modify: `scripts/download-model-app.js` — import `parseManifestBase64`/`manifestResourceName` + `reverseResolveNavIds`; add pure `assignPageKeys(pages, manifest)` + `missingDownloads(enumPages, pages)`; in `main` fetch the manifest, enumerate fail-closed, assign keys, reverse-normalize each `page.tsx`, guard downloads, thread `design` to `hydrateSpec`.
- Modify: `scripts/lib/hydrate-spec.js` — emit the v2 shape when pages carry keys (schemaVersion 2, v2 page fields, `source:{kind:'tsx'}`, `design`, key-based GenPage subareas); keep the legacy shape when they don't.
- Modify: `scripts/tests/download-model-app.test.js`, `scripts/tests/hydrate-spec.test.js` — new assertions.

**Interfaces:**
- `assignPageKeys(pages, manifest) → Map<pageId,key>` — mutates each page to carry `key` + v2 semantics (`purpose`/`navigatesTo`/`pageInput`/`dataSources`) from a manifest entry matched by confirmed-live id or name; mints a fresh unique slug key for the rest; returns `idToKey`.
- `missingDownloads(enumPages, downloadedPages) → [{ pageId, name }]` — enumerated pages absent from the download set (I3 guard).

- [ ] **Step 1: Write the failing tests**

Append to `scripts/tests/download-model-app.test.js`:

```javascript
const { assignPageKeys, missingDownloads } = require('../download-model-app.js');

test('assignPageKeys: reuses the manifest key + v2 semantics for a matched page, mints fresh keys otherwise (I3/§7.3)', () => {
  const manifest = { schemaVersion: 1, pages: [{ key: 'overview', name: 'Overview', pageId: 'gp-o', purpose: 'Home', navigatesTo: [{ targetKey: 'detail' }], pageInput: { data: {} } }] };
  const pages = [
    { pageId: 'gp-o', name: 'Overview', dataSources: [], codeFile: 'p/gp-o/page.tsx' },
    { pageId: 'gp-x', name: 'Some Legacy Page', dataSources: [], codeFile: 'p/gp-x/page.tsx' },
  ];
  const idToKey = assignPageKeys(pages, manifest);
  assert.strictEqual(pages[0].key, 'overview');
  assert.deepStrictEqual(pages[0].navigatesTo, [{ targetKey: 'detail' }]);
  assert.strictEqual(pages[0].purpose, 'Home');
  assert.strictEqual(pages[1].key, 'some-legacy-page', 'legacy page gets a fresh slug key, not the old name');
  assert.strictEqual(idToKey.get('gp-o'), 'overview');
  assert.strictEqual(idToKey.get('gp-x'), 'some-legacy-page');
});

test('assignPageKeys: mints unique keys (no manifest) with -N de-dup on slug collision', () => {
  const pages = [{ pageId: 'a', name: 'Work Order', dataSources: [], codeFile: 'a' }, { pageId: 'b', name: 'Work Order', dataSources: [], codeFile: 'b' }];
  assignPageKeys(pages, null);
  assert.deepStrictEqual(pages.map((p) => p.key), ['work-order', 'work-order-2']);
});

test('missingDownloads flags an enumerated page that was not downloaded (I3 fail-if-not-downloaded)', () => {
  const enumPages = [{ pageId: 'gp-o', name: 'Overview' }, { pageId: 'gp-d', name: 'Detail' }];
  const downloaded = [{ pageId: 'gp-o', name: 'Overview' }];
  assert.deepStrictEqual(missingDownloads(enumPages, downloaded).map((p) => p.pageId), ['gp-d']);
  assert.deepStrictEqual(missingDownloads(enumPages, enumPages), []);
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

- [ ] **Step 3: Implement `assignPageKeys` + `missingDownloads` + `main` wiring in `scripts/download-model-app.js`**

Imports:

```javascript
const { parseManifestBase64, manifestResourceName } = require('./lib/page-manifest.js');
const { reverseResolveNavIds } = require('./lib/pageref-resolver.js');
```

Pure helpers (near `parseDownloadedPages`):

```javascript
// Assign a STABLE key to every downloaded page and carry the manifest's v2 semantics. A page matched to
// a manifest entry (by confirmed deployed id, else by name) reuses that entry's key + purpose/navigatesTo/
// pageInput/dataSources — so intent + navigation survive the round-trip. A page with NO manifest entry
// (legacy app, or a Maker-authored page) gets a FRESH unique slug key (design §7.3 — NOT the old name
// shape, which drifted on rename). Returns idToKey for reverse-normalizing nav literals. Mutates pages.
function assignPageKeys(pages, manifest) {
  const byId = new Map(((manifest && manifest.pages) || []).filter((m) => m.pageId).map((m) => [String(m.pageId).toLowerCase(), m]));
  const byName = new Map(((manifest && manifest.pages) || []).map((m) => [m.name, m]));
  const used = new Set();
  const mint = (name) => { const base = String(name || 'page').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'page'; let k = base, i = 2; while (used.has(k)) k = `${base}-${i++}`; used.add(k); return k; };
  for (const p of pages) { const m = byId.get(String(p.pageId).toLowerCase()) || byName.get(p.name); if (m && m.key) { p.key = m.key; used.add(m.key); if (m.purpose !== undefined) p.purpose = m.purpose; if (m.navigatesTo) p.navigatesTo = m.navigatesTo; if (m.pageInput !== undefined) p.pageInput = m.pageInput; if (m.dataSources && !(p.dataSources || []).length) p.dataSources = m.dataSources; } }
  for (const p of pages) if (!p.key) p.key = mint(p.name);
  return new Map(pages.filter((p) => p.pageId).map((p) => [p.pageId, p.key]));
}

// Enumerated pages absent from the download set. A gap means pac downloaded fewer pages than exist —
// rebuilding from this spec would silently drop them, so download FAILS instead (I3).
function missingDownloads(enumPages, downloadedPages) {
  const have = new Set((downloadedPages || []).map((p) => String(p.pageId).toLowerCase()));
  return (enumPages || []).filter((p) => !have.has(String(p.pageId).toLowerCase()));
}
```

In `main()` after `pages` is built (`:171-179`), reconcile + reverse-normalize + guard, then thread `design` into `read`:

```javascript
  // Manifest-aware key reconstruction + reverse-normalization (design §7.3 / I3).
  let manifest = null;
  const appRows = await sdk.queryRecords('appmodule', { select: ['uniquename'], filter: `appmoduleid eq ${appId}`, top: 1 });
  const appUnique = appRows && appRows[0] && appRows[0].uniquename;
  if (appUnique) {
    const rows = await sdk.queryRecords('webresource', { select: ['content'], filter: `name eq '${manifestResourceName(appUnique).replace(/'/g, "''")}'`, top: 1 });
    if (rows && rows[0] && rows[0].content) manifest = parseManifestBase64(rows[0].content);
  }
  if (pages.length) {
    // Reconcile manifest ids against the FAIL-CLOSED live enumeration before trusting any id.
    const enumd = await genpageCli.enumerate({ appId });
    if (!enumd.ok) { emitResult(false, { ok: false, error: `page enumeration failed during download: ${enumd.error}` }); return; }
    const missing = missingDownloads(enumd.pages, pages);
    if (missing.length) { emitResult(false, { ok: false, error: `enumerated page(s) not downloaded: ${missing.map((p) => p.name || p.pageId).join(', ')} — refusing to write a spec that would drop them` }); return; }
    const idToKey = assignPageKeys(pages, manifest);
    // Reverse ONLY validated navigation pageId literals in each page's tsx (write the symbolic source back).
    for (const p of pages) {
      const abs = path.join(outDir, p.codeFile);
      try { const src = fs.readFileSync(abs, 'utf8'); const rev = reverseResolveNavIds(src, idToKey); if (rev !== src) fs.writeFileSync(abs, rev, 'utf8'); } catch { /* skip a page we can't rewrite */ }
    }
  }
```

Add `design` to the `read` object passed to `hydrateSpec` (`:205-212`):

```javascript
    design: async () => (manifest ? manifest.design : undefined),
```

Export the new helpers (`module.exports`, `:230`): add `assignPageKeys`, `missingDownloads`.

- [ ] **Step 4: Implement the v2 hydration in `scripts/lib/hydrate-spec.js`**

Replace `hydrateSpec` so it emits v2 when pages carry keys:

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
Expected: PASS — suite green (≈ 638).

- [ ] **Step 6: Commit**

```bash
git add scripts/download-model-app.js scripts/lib/hydrate-spec.js scripts/tests/download-model-app.test.js scripts/tests/hydrate-spec.test.js
git commit -m "feat(model-apps): manifest-aware download round-trip (keys, reverse-normalize, legacy migration)" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>" \
  -m "Copilot-Session: 42626da2-b66f-4162-acaa-b1127ef23d89"
```

---

## Task 10: Generator contract (stable KEY) + docs + recovery guidance (C4, I1)

Aligns the generator rules and the page-builder agent contract with the stable **key** (C4 — today they say FILENAME), and documents the manifest + `PAGEREF_` protocol + **full-rerun** recovery (I1 — no `--from pages`). Docs only — not tested.

**Files:**
- Modify: `references/rules.md:333-356` (the "Multi-page builds: use `PAGEREF_` placeholders" block).
- Modify: `agents/genpage-page-builder.md` (the navigation-placeholder guidance).
- Modify: `references/app-spec-schema.md` (`pages[].key` is the `PAGEREF_`/`navigatesTo.targetKey` identity; the durable manifest).
- Modify: `skills/app-builder/SKILL.md` (round-trip + recovery note).
- Modify: `CHANGELOG.md`.

- [ ] **Step 1: `references/rules.md` — `PAGEREF_<key>`, not `PAGEREF_<filename>`**

Replace the "Multi-page builds" block (`:333-356`) so the placeholder is keyed by the **stable App Spec page key**, not the filename:

```markdown
#### Multi-page builds: use `PAGEREF_<key>` placeholders

In a multi-page deployment, page GUIDs don't exist until after first upload. Use a
`PAGEREF_<key>` placeholder as the `pageId` — where `<key>` is the **stable key** of the
sibling page (the App Spec `pages[].key`, also used by `navigatesTo[].targetKey`). The build
replaces these with real GUIDs in a resolved deployment copy after all pages are deployed;
your canonical `.tsx` keeps the symbolic token (the build never writes a GUID back into it).

```typescript
// Navigating to a sibling page — use its stable KEY (not its filename or display name)
xrm.Navigation.navigateTo({
    pageType: "generative",
    pageId: "PAGEREF_pet-gallery",   // <key> of the target page; replaced with the real GUID post-deploy
    entityName: "adopt_pet",
    recordId: selectedId,
});
```

The placeholder format is `PAGEREF_` followed by the target page's stable **key** (e.g. a page
with `"key": "pet-gallery"` → `PAGEREF_pet-gallery`). The key is rename-stable; a filename or
display name is not.

**Must be quoted.** The resolver looks for `"PAGEREF_<key>"` as a double-quoted token to avoid
partial-string collisions (e.g. `PAGEREF_pet` inside `PAGEREF_pet-gallery`). Always emit the
placeholder as a string literal inside double quotes — never single-quoted, back-ticked, or
constructed via concatenation (the build's pre-deploy scan **rejects** any non-canonical form).
Every `PAGEREF_<key>` you emit must have a matching `navigatesTo` entry in the page's spec, and
every declared `navigatesTo.targetKey` must appear in the source (the build enforces exact parity).
```

- [ ] **Step 2: `agents/genpage-page-builder.md` — same key-based guidance**

Update the agent's cross-page-navigation instruction to reference the stable **key** (matching `pages[].key` / `navigatesTo.targetKey`) rather than the filename, mirroring the rules.md block above (quoted `"PAGEREF_<key>"` only; one per declared `navigatesTo`).

- [ ] **Step 3: `references/app-spec-schema.md`** — document, under `## pages`:
  - `pages[].key` is the single stable identity used by `navigatesTo[].targetKey`, `PAGEREF_<key>`, and `appShell` page subareas.
  - The build writes a durable `<app>_pagemanifest` web resource carrying `{ schemaVersion, pages:[{ key, name, pageId, purpose, dataSources, navigatesTo, pageInput }], design }`; download reconstructs keys + reverse-normalizes navigation from it (legacy apps get fresh keys).

- [ ] **Step 4: `skills/app-builder/SKILL.md`** — add a short note: multi-page navigation uses `PAGEREF_<key>`; recovery from a page halt is a **full rebuild** (idempotent — `--from pages` is unsupported because the app id is not carried across runs).

- [ ] **Step 5: `CHANGELOG.md`** — under Unreleased/Added:
  - Fail-closed generative-page deployment: `PAGEREF_<key>` navigation resolved into run-scoped staging (canonical `.tsx` never GUID-mutated), durable `<app>_pagemanifest`, key-by-key sitemap binding, app-scoped single-writer lease.
  - Mandatory fail-closed page verification (every nav edge resolves to the actual target `GenPageId`); manifest-aware download round-trip.

- [ ] **Step 6: Full suite (docs don't add tests — confirm nothing regressed)**

Run: `node scripts/run-tests.js`
Expected: PASS — suite green (≈ 638, unchanged from Task 9).

- [ ] **Step 7: Commit**

```bash
git add references/rules.md agents/genpage-page-builder.md references/app-spec-schema.md skills/app-builder/SKILL.md CHANGELOG.md
git commit -m "docs(model-apps): PAGEREF_ keyed by stable key + manifest/round-trip/full-rerun recovery" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>" \
  -m "Copilot-Session: 42626da2-b66f-4162-acaa-b1127ef23d89"
```

---

## Self-Review (completed while writing)

**Finding coverage** (every Critical, Important, and Minor from `sol-plan3-findings.md`):
- **C1** (verify/download promised, no tasks) → **Tasks 8 + 9**: fail-closed page reader + cached download (`verify-model-app.js`); `verifySpec` page checks incl. every nav edge → **actual** target `GenPageId` (not "no `PAGEREF_`"); **mandatory + fail-closed** page-verify gate exits non-zero when it can't run; manifest-aware download/hydration + legacy migration; wrong-GUID / enumeration-failure / download-failure / round-trip tests.
- **C2** (finalizer not the commit point) → **Task 5**: existing page-backed app defers **all** sitemap mutation to the pages finalizer; enumeration/dangling/upload failures push no earlier sitemap and preserve the previous one.
- **C3** (fail-open CREATE retry) → **Task 3**: `upload`'s uncertain CREATE re-enumerates fail-closed; retries only after enumeration proves no same-named page exists; enumeration failure or multiple matches HALT; the "possibly-successful CREATE + list failure" test asserts no 2nd CREATE.
- **C4** (unresolved/wrong nav shipped) → **Tasks 1 + 6 + 10**: scan **every** implemented source; reject non-canonical `PAGEREF_` (broadened grammar); enforce exact declared-vs-referenced parity; resolve all token-bearing sources; generator rules + agent contract use the stable **key**; key≠filename≠display-name covered.
- **C5** (reconcile overwrites wrong page) → **Task 2**: authority order manifest-confirmed-live → unique live-name → absent; duplicate/ambiguous names HALT (not collapsed). Deleted-manifest→create, app-only→adopt, stale-imported→fallback/create covered; ambiguous HALT wired in Task 4.
- **I1** (recovery violates one-build model) → **Tasks 4 + 7 + 10**: engine `pages-requires-app` HALT; CLI rejects apply that includes `pages` but excludes `app-shell`; docs require a full rerun and drop `--from pages`.
- **I2** (zero-exit unparseable = empty) → **Task 3**: `classifyListOutput` tri-state (pages/empty/unrecognized); only the first two succeed; blank/help-banner tests.
- **I3** (reverse normalization under-specified/broad) → **Task 9**: reconcile manifest ids vs fail-closed live enumeration before inversion; mint fresh legacy keys; reverse **only** validated nav `pageId` literals (`reverseResolveNavIds`); fail if an enumerated page isn't downloaded.
- **I4** (staging/concurrency unsafe) → **Task 6**: run-scoped staging under `.maker-workspace`, cleaned in `finally`; app-scoped single-writer lease over enumerate→finalize (concurrency HALT tested in Task 7).
- **I5** (manifest parse/teardown not fail-closed) → **Tasks 2 + 4**: `parseManifest` validates the full schema + key uniqueness; teardown **always** removes the manifest (not-found is idempotent).
- **I6** (test contradiction + missing ordering) → **Tasks 4 + 6 + 7**: content-dedup avoids the redundant final persist (first build issues zero `updateWebResource`); explicit SEQUENCE/restart tests for crash-after-create, uncertain CREATE, existing-app sitemap preservation, upload-failure-before-finalize, ambiguous names, wrong deployed GUID (the last in verify, Task 8).
- **I7** (update identity unguarded) → **Task 6**: every UPDATE asserts returned id == requested id (case-insensitive) else HALT before finalize.
- **Minor 1** (planFor step drift) → **Tasks 4 + 6**: exactly one `runner.run`/`skip` per page + a deterministic `resolve cross-page navigation` step; `planFor` counts match runtime.
- **Minor 2** (over-bundled Task 3) → the old Task 3 is split into **Tasks 3–5** (cli / engine plumbing / C2) and the protocol into **Tasks 6–7** (protocol / failure-ordering) — each an independently reviewable deliverable.

**Placeholder scan:** none — every step carries runnable test + implementation code, exact `node --test` / `node scripts/run-tests.js` commands, and a commit with both trailers. No "TBD"/"similar to Task N"/"add validation".

**Type consistency across tasks:**
- `reconcilePageIds(pages, manifest, livePages) → { keyToId: Map, absentKeys: string[], ambiguous: [{ key, name, matches }] }` — identical in Task 2 (def + tests), Task 4 (seed + ambiguous HALT), Task 6 (seed).
- `enumerate({ appId }) → { ok, pages: [{ pageId, name }], empty?, error? }` — identical in Task 3 (def), Tasks 4/6 (engine consume `.ok`/`.pages`), Task 8 (`read.pages()` maps `.ok`→throw / `.pages`).
- `persistPageManifest(provision, spec, keyToId, sol, appUnique, existingId, lastContent) → { id, content }` — identical in Task 4 (def) and Task 6 (create-absent-first + final persist), both threading `manifestId`/`lastContent`.
- `resolvePageRefs(sources: Map<key,{code}>, keyToId: Map) → { deployment: Map, unresolved: string[] }` and `reverseResolveNavIds(code, idToKey: Map)` — the `idToKey`/`keyToId` map shapes match between Task 1, Task 6 (deploy), and Task 9 (download).

**Each Critical's tests are failure-ordering / restart-convergence (not content-only):** C1 → verify can't-run → non-zero exit + wrong-GUID fails the edge check; C2 → failure produces no earlier sitemap push; C3 → uncertain CREATE + list failure issues no 2nd CREATE; C4 → scan/parity HALT **before** any write; C5 → ambiguous names HALT before upload; plus Task 7's crash-after-create convergence and upload-failure-before-finalize sequence tests.

**Implementer notes:**
- **(a) `subareaHasGenPage` attribute** — the exact sitemap attribute a GenPage subarea stores its id in is matched heuristically (any attribute value on a `<SubArea>` start-tag). Confirm against a live sitemap (or the SDK serializer) and tighten to the real attribute name; the check is correct as long as the id appears on the SubArea element.
- **(b) `classifyListOutput` empty markers** — the recognized-empty phrasings (`No pages found` / `Found 0` / `0 page(s)`) should be confirmed against real `pac model genpage list` output and a fixture added; any other zero-exit output is (correctly) treated as fail-closed `unrecognized`.
- **(c) Baseline count** — measured **570** locally after Plan 2 (the task brief cited 567; use the measured number the implementer sees). Running totals in each task are approximate — the contract is "the suite stays green", verified by `node scripts/run-tests.js` after every task.
- **(d) `build-model-app.test.js` apply seam** — Task 8's mandatory-verify tests assume the file's existing way of injecting a successful apply into `buildModelApp`; follow whatever seam the closest existing build test uses (the assertion is on `r.verify`).

---

## Review R1 → resolutions

| # | Finding | Resolution (task → mechanism) |
|---|---|---|
| **C1** | Verify + download promised, no tasks | **Tasks 8–9** — fail-closed page reader + cached download; `verifySpec` page checks (exists / `GenPageId`-bound / every nav edge → **actual** target id / no residual-or-malformed `PAGEREF_`); **mandatory + fail-closed** gate exits non-zero when unrunnable; manifest-aware download/hydration + legacy migration; wrong-GUID / enum-fail / download-fail / round-trip tests. |
| **C2** | Sitemap finalization not the commit point | **Task 5** — existing page-backed app defers **all** sitemap mutation to the pages finalizer (the only existing-app sitemap write); failures push no earlier sitemap and preserve the previous one. |
| **C3** | CREATE retry has a fail-open duplicate window | **Task 3** — `upload` re-enumerates fail-closed on an uncertain CREATE; retries only after enumeration proves no same-named page; enum-fail / multiple-match HALT; no-2nd-CREATE test. |
| **C4** | Caller can ship unresolved/wrong navigation | **Tasks 1, 6, 10** — scan every source; reject non-canonical `PAGEREF_` (broad grammar); exact declared↔referenced parity; resolve all token sources; generator rules + agent use the stable **key**; key/filename/display-name tests. |
| **C5** | Reconcile can overwrite the wrong live page | **Task 2** (+ Task 4 wiring) — authority manifest-confirmed-live → unique live-name → absent; duplicate/ambiguous names HALT. |
| **I1** | Recovery violates the one-full-build model | **Tasks 4, 7, 10** — engine `pages-requires-app` HALT; CLI rejects apply with `pages` sans `app-shell`; docs require a full rerun, drop `--from pages`. |
| **I2** | Zero-exit unparseable enumeration = empty | **Task 3** — `classifyListOutput` tri-state; only pages/empty succeed; unrecognized HALTs; blank/help tests. |
| **I3** | Reverse normalization under-specified/broad | **Task 9** — reconcile ids vs fail-closed enumeration before inversion; fresh legacy keys; reverse only validated nav `pageId` literals; fail if an enumerated page isn't downloaded. |
| **I4** | Staging + deployment concurrency unsafe | **Task 6** — run-scoped staging under `.maker-workspace`, cleaned in `finally`; app-scoped single-writer lease over enumerate→finalize (HALT tested in Task 7). |
| **I5** | Manifest parse + teardown not fail-closed | **Tasks 2, 4** — full-schema + key-uniqueness `parseManifest`; teardown **always** removes the manifest (not-found idempotent). |
| **I6** | Test contradiction + missing ordering | **Tasks 4, 6, 7** — content-dedup removes the redundant final persist (first build: zero `updateWebResource`); explicit SEQUENCE/restart tests (crash-after-create, uncertain CREATE, sitemap preservation, upload-fail-before-finalize, ambiguous, wrong GUID). |
| **I7** | Update identity changes unguarded | **Task 6** — every UPDATE asserts returned id == requested id (case-insensitive) else HALT before finalize. |
| **Minor 1** | `planFor` step drift vs runtime | **Tasks 4, 6** — one `run`/`skip` per page + deterministic resolve step; plan count matches runtime. |
| **Minor 2** | Over-bundled Task 3 | Split into **Tasks 3–5** (cli / plumbing / C2) + **Tasks 6–7** (protocol / failure-ordering), each independently reviewable. |
