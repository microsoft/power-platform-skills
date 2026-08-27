# app-builder — Roadmap

What the `/app-builder` skill can do today, what's still pending (grouped by phase), and what's
intentionally deferred (with the *why*). The build engine is `scripts/lib/sdk-build.js`; the App Spec
contract is [`../references/app-spec-schema.md`](../references/app-spec-schema.md); the wiring diagrams
are in [`architecture.md`](architecture.md).

**Status legend**
- ✅ **verified live** — built end-to-end on a real Dataverse env and torn down clean.
- 🧪 **tested** — has automated (unit / golden) coverage, not exercised on a live org.
- ⚠ **not live-verified** — plumbed through and unit-tested, awaiting a live shakeout.

---

## ✅ Complete

### Authoring & build framework — ✅ verified live
- Interactive levelled authoring in the **main loop** — jobs-to-be-done first, then data model,
  artifacts + page-intents, then access (env select, App Spec, lint gate, plan-mode approval).
- Deterministic, **idempotent** build engine — discovers via the SDK (`findTables`/`findColumns`/`fetchEntityMetadata`) and creates only what's missing; new / existing / mixed envs all work.
- **All Dataverse access via the vendored headless SDK**; metadata cached under `<app-folder>/.maker-workspace/` for reuse.
- Phase selection (`--only`/`--skip`/`--from`/`--to`), `[n/total]` narration, `BuildHalt` gate, dry-run by default, `--sample-data` / `--publish` opt-in.
- Bounded-concurrency for independent ops; one publish round-trip per entity + the app. `az`-token HttpClient with transient (429 / 5xx) retry.
- Guardrail lint (`spec-lint.js`) + hard validator (`app-spec.js`). 🧪 full `node:test` suite + the vendored SDK's Jest suite green (`node scripts/run-tests.js --with-sdk <ppux>`).

### Data model (Tier 1) — ✅ verified live
- All column types: Text · Memo · Choice · MultiChoice · Boolean · Money · DateTime · Integer · BigInt · Decimal · Double · File · Image · AutoNumber · Customer (with per-type options), incl. AutoNumber primary columns.
- Global option sets, status reasons (idempotent, deterministic pinned values), alternate keys (idempotent).
- Relationships: OneToMany (lookup) **and** ManyToMany; Customer (polymorphic) columns.
- Sample data: Choice/MultiChoice label→int resolution (inline **and** global choices), `$parent`/`$parents` lookup binds (incl. junction rows with both sides), custom status reasons; resolve-by-name idempotency via the SDK's `seedRecordGraph`.
- ⚠ Calculated / Rollup formula columns — `source` + `formula` plumbed through, **not live-verified**.
- **Table icons** (`entities[].vectorIcon` = SVG web resource → `IconVectorName`; `entities[].icon` = raster web resource → `IconMediumName`) — sets a custom table's own icon (what the modern designer + nav render). Applied after the web-resources phase via the SDK's `setEntityIcon`; hard-validated against declared web resources so an unresolvable value can't break the designer (glimmer). Live-verified: `IconVectorName` set to a published SVG web resource.

### Forms, views & charts — ✅ verified live
- Adaptive main forms (auto + explicit tabs/sections), related-record sub-grids (1:N **and** N:N), Notes/timeline section.
- Quick-create + quick-view forms (`forms[].formType`); quick-view **placement** on a host form via a lookup (`forms[].quickViews[]`).
- Form JS event handlers (`onload`/`onsave`/`onchange`) wired via web resources.
- Views with rich filters (`eq-userid`/`this-week`/`in`/`not-in`/… + Choice-label resolution); default Active/Inactive view **column enrichment** via the SDK's `enrichDefaultViews`.
- Choice-column charts.

### App shell & navigation — ✅ verified live
- App module + sitemap; **multi-area sitemaps** — every `appShell.areas[]` maps to its own `<Area>` (icon + groups + subareas; order follows array order). The app is **self-contained for export/import**: its **sitemap** is added to the solution (componenttype 62), and its **tile icon** is an in-solution web resource — `app.icon` (a declared image web resource) or a generated default SVG — never an arbitrary external/managed icon.
- Generative pages (**genpage-first**) for overview / dashboard surfaces — uploaded via `pac model genpage upload`; the SDK finalizes the sitemap with `GenPage` subareas.
- Dashboards (chart / list / iframe / webresource tiles) with **sitemap placement** (auto-pinned as an app component). Tiles render in a **multi-column grid** (2-wide) rather than one stacked full-width column.
- Modern command-bar buttons — functional **JS on-click** + static hidden/disabled, incl. **flyout / split-button menus**.
- Web resources (JS / HTML / CSS) shipped + added to the solution; idempotent (reuse by name).

### Generative-page management — three-authority, id-based — 🧪 tested
- **Three-authority page identity.** IDENTITY = durable `<app>_pagemanifest` (key→pageId map), outranked by the spec's own `pages[].pageId` for a downloaded (edit-snapshot) spec. EXISTENCE = env-wide `pac model genpage list` — decides create-vs-reuse for crash-safe convergence (`enumerateEnv`, no `--app-id`). MEMBERSHIP = the app's sitemap `GenPageId` set, read fail-closed via `fetchSitemap` (`scripts/lib/sitemap-pages.js`) — drives placement, download enumeration, and verify. All page matching is by id, never by display name.
- **Edit-snapshot `pageId`.** Download keeps each page's deployed `GenPageId` as `pages[].pageId` in the emitted spec. On rebuild, this highest-authority id is confirmed against EXISTENCE and reused — so a downloaded app (including Maker-added pages) rebuilds without creating duplicates.
- **Validation: every page must be sitemap-placed.** A `pages[]` entry absent from the `appShell` sitemap is rejected; navigation-only (headless) pages are not supported. A "detail" page is a normal sitemap page receiving input via `pageInput`.
- **Safety HALTs:** `pages-removed` (live page dropped from spec — re-add or `--allow-destructive` detaches the nav SubArea, page left deployed), `pages-shared-across-apps` (`--allow-destructive` does NOT bypass; detach in Maker), `pages-identity-conflict`, `pages-manifest-corrupt`, `pages-existence-failed`, `pages-sitemap-read-failed`, `pages-shared-check-failed`.
- **Verify and download** match by id with exact set-equality (EXISTENCE + MEMBERSHIP); a manifest-uncorrelatable page surfaces `unableToRun`.

### AI-first features — ✅ verified live
- `ai` block → `ai-features` phase: form-fill, NL search, NL charts, M365 Copilot, and per-table Copilot **row summaries** with tailored `GptDynamicPrompt-2` prompts (auto-selected candidate tables; skips lookup/config/junction + D365-owned incident/lead/opportunity).
- **Admin-gated**: preflights each setting (`RetrieveSetting`), skips/warns when off, never fails the build. NL grid search is **environment-gated** (`EnableNLGridSearch`), not per-app. Standalone reporter `scripts/ai-preflight.js`.

### Edit flow (download → edit → rebuild) — ✅ verified live
- `download-model-app.js` pulls a **deployed app** back into an editable App Spec (+ page code, icons, referenced entities, and the app's **real unmanaged solution** — `recoverAppSolution` enumerates the app's solution memberships and excludes the built-in `Active`/`Default`/`Basic` system solutions, so the spec names the right container for a later clean teardown); edit the spec and re-run the idempotent build — **create and edit share one path** (reuses app/tables, updates pages in place, keeps `GenPage` subareas). The app-shell phase **re-syncs the sitemap + components of any existing app** (fetch → recompute-from-spec → push → publish), so subarea add/rename/reorder edits land for **page-less apps too** — not just generative-page apps — and `--only app-shell` can force the rewrite. **Classic DashBoard subareas round-trip** too: the dashboard is reconstructed into `dashboards[]` with **id-passthrough tiles** (each tile carries the deployed view/chart ids), so a rebuild recreates it against the existing views/charts without re-declaring them. **Round-trip scope (not yet "complete"):** tables, sitemap/appShell, generative pages, dashboards, icons, and solution round-trip; **forms, views, charts, and commands do NOT yet** — view hydration was tried and reverted (LIVE-verified the deployed savedquery set can't reliably distinguish author views from Dataverse's auto-generated Active/Inactive/QuickFind system views). All four survive on the live app (a rebuild preserves them by discovery) but are absent from the downloaded spec, so edit them in Maker or a fresh spec.
- Live regression on the edit path found + fixed **4 bugs**, then re-verified clean.
- `verify-model-app.js` — read-only reconcile of spec vs deployed (exits non-zero on anything missing). Sitemap checks are **element-scoped**: an area/subarea icon is matched on its own `<Area>`/`<SubArea>` element, and a **dashboard subarea** is verified by resolving the dashboard id (systemform type 0, by name) and matching the sitemap's `DefaultDashboard` — so a value reused elsewhere can't produce a false pass. **Multi-area sitemaps** and the dashboard-subarea path were re-verified live (positive + negative).

### Teardown — ✅ verified live
- `teardown-model-app.js` deletes exactly what an App Spec declares, in dependency-safe order (app → dashboards → commands → forms → charts → views → relationships → AI row summaries → tables [children-first] → web-resources → global choices → solution). Forms/charts/views/relationships are removed **before** tables (a table delete doesn't reliably cascade cross-references); **web resources are removed AFTER tables** (a table's icon web resource is referenced by the table).
- **Classifier-safe** (every id resolved from a spec-declared name via an exact-match, entity-scoped filter), dry-run by default, best-effort continue, not-found aware, undeletable (system/managed) artifacts recorded as `skipped`. A **restricted system solution** (`Active`/`Default`/`Basic`) is skipped rather than attempted (Dataverse 400s any delete of one), so a downloaded spec that defaulted its solution to `Default` tears down cleanly. An already-gone relationship (Dataverse 400 *"…but 0 were found"*) is tolerated as deleted, like the table not-found case.

### Tooling & internals — ✅ verified live
- ASCII **form wireframe** preview (`preview-form.js`); phase-grouped build log with per-step status glyphs (`✓`/`⊘`/`✗`) + a closing summary.
- **SDK consolidation** — the SDK owns the Dataverse mechanics (`seedRecordGraph`, `enrichDefaultViews`, AI settings/row-summaries, artifact `resolveArtifact`/`findArtifact`/`deleteAppCascade`); the plugin keeps the judgment (spec validation, choice/status resolution, `$parent`→bind translation, candidate selection).

---

## 🎯 MVP gaps

Assessed 2026-08-12. **9 of 10 core P0 _primitives_ are ✅ complete** — roles + JTBDs as first-class planning outputs,
data model + sample data, auto-number + dedup, Active/Inactive + authored views, main forms, charts,
gen-page landings, custom SVG sitemap icons, in-app agents (`ai.appFeatures` = formFill/nlSearch/nlChart),
Insight Card summaries (`ai.summaries`), and
the dedup/verify quality gates. The open MVP items:

- ✅ **Modern ("new look") shell** (P0) — DONE, opt-in via `app.newLook`. It turned out to be
  a per-app **setting** (`NewLookAlwaysOn`), not an app-module column — `navigationtype` is
  Single/Multi *session* and unrelated, which is why the earlier "app-module header/nav refresh flag"
  framing found nothing to set. `NewLookAlwaysOn` is the one worth writing of the several new-look
  definitions: Dataverse says it enables the new look and **hides the user switch**, so the author
  gets a deterministic result rather than a per-user preference (`NewLookOptOut` and
  `NewLookModernExperienceOct2023` both default to true and are user toggles). Scoped to app +
  solution so it travels on export/import. Best-effort: a tenant without the definition still gets a
  working app on the classic shell, with a warning and `created.newLook: false` — never a silent
  success. Live-verified: the app-scoped override row holds `"true"` against a `"false"` default.
- ✅ **Wave 2 (header/navigation refresh)** (P0) — DONE, via `app.headerNavigationRefresh`. A
  **separate, independent** setting from `app.newLook` above (`HeaderAndNavigationRefresh` vs
  `NewLookAlwaysOn`); enabling one does not enable the other, and conflating them is what kept this
  item open while the new look was already shipping. The platform default is **ON**, so this field
  exists as much to turn the refresh off as on — both values are written, because treating `false`
  as "do nothing" would silently leave it enabled for an author who asked for the classic header.
  Written through the SDK's `setHeaderAndNavigationRefresh` because the encoding is a trap: a Number
  tri-state where ON is `'2'`, and `'1'` is accepted by the API and then silently does nothing.
- ✅ **Roles + JTBD as first-class planning outputs** (P0) — the Level-(c) design flow now models
  **personas** and their **jobs-to-be-done**: the author declares the entity access each job needs, the builder
  unions it into one security role per persona, and the plan/preview surfaces the proposed roles for review. Built
  on the SDK security surface (`createPersonaRole`). JTBD-driven view/summary/sitemap coherence (below) still builds
  further on this.
- 🔲 **Default-on + coherence wiring** — the AI agents, Insight Card summaries, and (once added) Wave 2 exist as
  primitives, but the SKILL flow must **enable them by default** and author **JTBD-quality** content (entity-specific
  summary prompts, the _right_ view columns). A ✅ primitive is necessary but not sufficient for a coherent app.

Important, P1 (not MVP-gating; tracked here for visibility):
- ✅ **Security roles per persona** — `personas[]` authors one security role per persona,
  sized from its jobs-to-be-done, and grants the app to each role so it **opens for non-admins**, not just sysadmins.
  Idempotent + converging (replace-privileges), fail-closed on a foreign same-name role, torn down with the app.
  **Column-level (field) security** and **access teams / hierarchy security** remain a tracked SDK
  follow-up.
- 🔲 **Rich AI descriptions on every artifact** · **quick-find / relevance-search config** ·
  **custom app theme + logo** (the `design` block styles gen pages, not the app theme).

P0.5 stretch (not built): **modern grid visualizations by default** (contingent on the SDK grid-customizer)
and **MCP server + Catalyst by default**.

---

## 🔜 Pending — by phase

### Phase: Edit & lifecycle
- 🔲 **Delta / diff-based edit (full desired-state convergence)** — today the build is **additive**: it creates what's missing and reuses what exists, but does NOT re-apply an edit to an already-deployed artifact (changed column type, removed view column, edited form/command/dashboard) and never removes an artifact dropped from the spec. The converging edit path today is **teardown + rebuild-fresh**; `--verify` now catches unapplied edits via content checks (view column set, relationship + command existence) so divergence is loud, not silent. The future increment: spec-diff against the deployed app and apply only the *changed* delta (SDK `updateColumn`/`deleteColumn`/`updateTable`/`deleteRelationship`/`updateWebResource`, `fetchArtifact` snapshots, `diffArtifact`) instead of a full re-apply — driven by real edit-workflow usage. (Deliberately NOT a per-resource `managed`/`additive`/`reference` mode system: that's backward-compat machinery for a prod tool; this is pre-prod, so convergence-by-default is the likely direction when it lands.)
- 🔲 **Form events on existing forms** — fetch an existing form, add/replace handlers, publish (current wiring assumes a freshly built form).
- 🔲 **`--dry-run` diff view** — show the spec-vs-deployed delta before apply (precursor to delta-based edit).

### Phase: Governance & breadth (Tier 3)
- 🔲 **Business rules** (`businessRules[]`) — ⚠ org-gated + Power-Fx-flavored; build behind a capability flag (see Deferred).
- 🔲 **Standard system views** (All Records / Active / Inactive / Lookup / Associated) auto-generated per table.
- 🔲 **Security roles, environment variables, connection references.**
- 🔲 **Solution packaging** — `exportSolution` / `importSolution` for hand-off / source control (managed / unmanaged).

### Phase: Build engine & correctness
- ✅ **Global option-set find-by-name** — DONE. The vendored `createGlobalOptionSet` is now IDEMPOTENT (probe `GlobalOptionSetDefinitions(Name=…)` → REUSE the existing `MetadataId` instead of a duplicate-`Name` POST). `entity-provision.js` captures the returned id on a rebuild so a `globalChoice` column binds to it (`globalChoiceMetadataId`) instead of falling back to inline options; a genuine create failure now surfaces as a clean phase halt (previously ALL errors were swallowed). Locked by `vendor-sdk-smoke.test.js` (idempotent reuse, no duplicate POST) + `entity-provision.test.js`.
- 🔲 **Solution-component idempotency** — query existing solution components instead of assuming reused web resources are already present.
- 🔲 **Live-verify Calculated / Rollup** formula columns end-to-end.
- 🔲 **Publish granularity** — optionally publish web resources separately from entity customizations.
- 🔲 **Richer `BuildHalt` recovery** — skip-phase / retry-step / edit-spec-and-resume prompts.
- ✅ **Entity-subarea sitemap icons round-trip** — DONE. The sitemap writer no longer DROPS a custom
  `vectorIcon` on an entity nav subarea, and validation no longer REJECTS a platform/OOB icon reference the
  download itself wrote. New shared `isPlatformIconRef` (a value starting with `/` or `$webresource:` is a
  platform reference the platform resolves directly, vs a bare declared-web-resource NAME): `checkIcon`
  passes platform refs through (a bare NAME still must be a declared image WR); `subAreaJson` emits a valid
  platform `vectorIcon` on ANY subarea incl. Entity (a bare Fluent token is still dropped — it breaks the
  modern app-designer — but now with a `warnings[]` entry, not silently) and preserves icon paths VERBATIM
  (case-sensitive; only bare names are lower-cased); `collectSitemap` skips platform-path icons. So
  download→edit→rebuild on a real app with custom/OOB nav icons no longer fails validation or silently
  loses the icon. Adversarially reviewed (Sol + Opus — Opus caught a residual area-icon case-corruption,
  fixed); **live-verified** (entity-subarea `VectorIcon` lands in the deployed sitemap
  XML; the reporter's exact OOB `…/CDSEntity` icon rebuilds `ok:true`; round-trip clean). **Follow-up
  (now resolved — see below):** deploying a `/WebResources/<pub>/icons/x.svg` reference to a DIFFERENT env
  originally rendered a broken icon (the WR was assumed pre-existing).
- ✅ **Custom nav-icon web resources are portable across environments** — DONE. Resolves the follow-up
  above. A sitemap nav icon that references a custom image web resource **by path**
  (`/WebResources/<pub>/icons/x.svg` or `$webresource:<name>`) previously round-tripped only the
  *reference*, so a rebuild into a **fresh** env rendered a broken icon. Now **download re-declares** the
  referenced web resource into `webResources[]` (base64 content) so the build recreates it cross-env —
  gated to be safe: only a WR that is (a) **owned by this app** (name starts with the app's real publisher
  prefix — see the identity round-trip below), (b) **custom** (unmanaged), and (c) an **image** type. A path
  ref processed BEFORE bare names so an overlap keeps `external`; a **foreign-prefix / managed / OOB**
  reference is left as a bare reference (recreating a foreign prefix on a fresh env would BuildHalt). A
  re-declared entry is flagged **`external: true`**: the idempotent web-resources phase creates-if-missing /
  reuses-if-present, and **teardown skips `external` WRs** (including the derived generated-icon/manifest
  cleanup, which now honors a declared-name collision) so a shared publisher WR is never deleted (fail-safe,
  mirrors `existing: true` on downloaded tables). An own-prefix icon that can't be captured (absent on
  source, or read failure) is surfaced as a **download warning**; the build adds a non-blocking
  **portability warning** for an own-prefix path-ref icon missing from `webResources[]`. Adversarially
  re-reviewed across four rounds (Sol + Opus, high effort); full offline coverage (re-declare / skip-foreign
  / skip-managed / overlap-external / unresolved + teardown-skip).
- ✅ **App identity round-trips by its real uniquename (no duplicate app on rebuild)** — DONE. A downloaded
  spec captures the app module's **real, immutable** `uniquename` in `app.uniqueName`; `appUniqueName(spec)`
  (the single identity chokepoint for build's existing-app `findArtifact` AND teardown's app resolution)
  returns it verbatim instead of re-deriving `<publisherPrefix>_<appName>` from the **mutable display name**.
  So **renaming** an app then rebuilding no longer misses the existing app and **creates a duplicate**. The
  publisher prefix (which scopes safe-to-re-declare custom icons and recreates the app's own solution) is
  derived from the app's **own** uniquename — parsed **before** the solution-recovery I/O (a failure can't
  lose it) and validated as a real `<prefix>_<name>` shape — **not** from an arbitrary unmanaged solution
  membership (an app can belong to several, under different publishers). `recoverAppSolution` returns only
  the real solution uniquename (teardown container); the transient prefix-trust signal is stripped from the
  persisted spec. This resolved 4 adversarial-review findings (3 High + 1 Medium, Sol); full offline
  coverage (identity-over-rename, prefix-from-uniquename-not-solution, malformed-shape rejection).
- ✅ **Pre-existing duplicate page names don't block an unrelated build** — DONE. Two-layer, fail-closed:
  (1) `validateAppSpec` scopes the case-insensitive page-name uniqueness rule to pages the run CREATES
  (no `pageId`): a NEW collision is rejected (prevention), a collision purely among PRE-EXISTING pages
  (all carry a deployed `pageId`) is a warning (tolerated) so a form-only edit on a downloaded app with
  two identically-named pages still builds. (2) Because a spec `pageId` is only a CLAIM, the pages phase
  re-checks after `reconcilePageIds`: if a tolerated dup-name group has any member whose id reconciles as
  ABSENT (a stale snapshot — e.g. the page was deleted in Maker since download), the build would
  re-materialize the duplicate, so it HALTs (`pages-duplicate-name-create`) BEFORE any write instead of
  creating it and only failing verify after. The pages phase is otherwise id/key-matched (never
  name-matched — `genpage-cli.js` `enumerateEnv` is id-keyed), so distinct-id same-name pages build fine.
  `validateAppSpec` gained a `warnings[]` channel; `build-model-app.js` narrates + attaches them.
  **Follow-up:** enforce name-uniqueness at `/genpage`-native page creation too (the app got into the
  dupe state via non-app-builder tooling).
- ✅ **Same-named forms (Main/Quick View/Card) no longer block a form edit** — DONE. A Dataverse form name
  is unique only per `(entity, type)`, so a table's auto-created Main (2), Quick View (6), and Card (11)
  forms are commonly ALL named "Information". The build resolved a form by `(entity, name)` only, so a
  name-only lookup matched multiple rows → the SDK's `AmbiguousArtifactError` → the fail-closed preflight
  HALTED, blocking a `formType:"Main"` edit entirely (author had to hand-patch formxml by id). New shared
  `resolveExistingFormId` scopes by TYPE (`FORM_TYPE_CODE` → `type eq <code>`) so a Main edit reconciles
  ONLY the Main form; applied CONSISTENTLY across the form phase (`buildArtifact`), the preflight
  `discoverOpDiffState`, the spec **verifier** (`verify-spec.js` no longer false-passes a Main when only a
  same-named Quick View exists), and **teardown** (which previously deleted EVERY same-named match — a
  data-loss risk on same-named Quick View / Card siblings; now deletes exactly the intended form, skips on
  absent, halts on a residual collision). The residual `(entity, type, name)` collision errors with
  actionable guidance; new optional **`forms[].formId`** pins the exact form (GUID-validated in
  `validateAppSpec` + re-checked at resolve — the id is interpolated unquoted into an Edm.Guid filter — and
  verified to match the target table, TYPE, AND name; a stale pin fails loud instead of minting duplicate
  forms).
  Quick-view form references are keyed by `(targetEntity, QuickView, name)` so same-named Quick View forms
  on different entities — or a same-named Main on the target entity — don't cross-wire (build map,
  `validateAppSpec`, `spec-lint`, and teardown dependency ordering all consistent); verify reuses
  `resolveExistingFormId` for the same identity. `FORM_TYPE_CODE`/`FORM_GUID_RE` live in the shared
  `app-spec.js`. `artifactIdentityQuery('form')` is also type-scoped. Reviewed adversarially across three
  rounds (Sol — the name-only-identity flaw was pervasive; all High/Medium findings fixed). Live-repro
  `zava_javavendor` (three "Information" forms) unblocked; **live-verified end-to-end** (build a
  table → it gets 3 same-named "Information" forms → edit the Main without a halt → the edit lands on the
  Main ONLY, Quick View/Card untouched → teardown resolves the Main type-scoped). Locked by resolver /
  preflight / verify / teardown / validation unit tests. **Follow-up:** a quick-view control already
  cross-wired by the OLD global-name bug is not auto-repaired on a rebuild (`hasQuickView` matches only the
  lookup field, not the embedded form id) — a rare pre-existing-state edge that self-heals on teardown +
  rebuild.
- ✅ **Env-wide appmodule pagination** — DONE. The vendored `queryRecords({ paginate:true })` now follows the OData `@odata.nextLink` to completion. The cross-app shared-page scan (`sitemap-pages.js` `fetchAppsForPages`) enumerates EVERY app instead of one ~5000-row page, so it no longer fails closed at the cap (`apps-truncated` removed). Fail-closed is preserved on: an enumeration throw, a pagination-abort (repeated-nextLink guard), AND an **empty** result (a live env always has ≥1 appmodule, so empty ⇒ a malformed/partial read ⇒ `apps-enumeration-empty` halt). Locked by `vendor-sdk-smoke.test.js` (paginate follows nextLink; rejects paginate+top / paginate+fetchXml) + `sitemap-pages.test.js`.
- ✅ **Paginate throw-on-malformed-page (SDK hardening)** — DONE. The vendored `queryRecords({ paginate:true })` now THROWS a `ConnectionError` (carrying the page URL + HTTP status) when a paginated page's `value` is not an array (missing/null/object — previously coerced to empty, silently dropping rows; a bare-string `value` was iterated char-by-char, fabricating single-char rows) or when `@odata.nextLink` is a truthy non-string. The single-page (non-paginate) path stays lenient; `queryAllRecords` inherits the guard by delegation. The cross-app scan's `fetchAppsForPages` try/catch catches this → fail-closed at the source (the plugin's empty-enumeration guard remains as defense-in-depth). Locked by `vendor-sdk-smoke.test.js` ("THROWS on a malformed page"); re-vendored from `cds-maker-sdk` hardening-3 (`f066a644`).
- 🔲 **Conditional `updateTable` (If-Match / skip-if-unchanged)** — the SDK's `updateTable` does an unconditional GET→PUT of the whole `EntityDefinitions` row (strips `@odata.etag`, no `If-Match`), so a concurrent Maker edit to another property of the SAME table in the GET→PUT window is last-writer-wins. This is pre-existing (icons/audit already use `updateTable`); the quick-create flag adds one more caller. Follow-ups: preserve the ETag + conditional PUT (retry/surface 412), and skip the PUT when the requested flag is already set (avoids a redundant write on every opted-in rebuild). Same class as the build's `requireSuccessfulPush` 412 posture for artifacts.

### Phase: Forms, views & data-load polish (from the 2026-07-15 V1↔V2 comparison review)
From a review comparing two generated Project Management apps plus a sample data-load. **Status 2026-07-27: all 8 addressed — the "Allow quick create" table flag (#8) now ships; auto-GENERATING the Quick Create form's field layout remains a follow-up (see below).** Severity as assessed in that review.
- ✅ **[High] Validate lookup binds; stop silent data-load lookup failures** — DONE. `validateAppSpec` now validates `$parents` (junction) the same as `$parent` and flags a `$parent`/`$parents.match` that resolves to no parent sample row (the bind would be dropped and the lookup left unset); `buildSeedGroup` THROWS (fail loud) on an unresolvable parent instead of silently skipping. Runs inside `runner.run` (clean phase failure). `app-spec.js` sampleData validation + `entity-provision.js` buildSeedGroup.
- ✅ **[Medium] Don't truncate parent lookups in default-view enrichment** — DONE. `defaultViewColumns` now reserves the parent-lookup slots up front and caps *scalar* columns at the remaining budget, then appends every lookup — so a lookup-heavy table never drops a parent link (`sdk-build.js`). Teardown's `{ includeLookups:false }` reset path unchanged.
- ✅ **[Medium] Normalize N:N relationship schema-name ordering** — DONE. `manyToManySchemaName` sorts the two entity logical names alphabetically before composing, so the N:N name is stable regardless of `entity1`/`entity2` declaration order (`app-spec.js`). 1:N keeps its semantic `referenced_referencing` order; explicit `schemaName` still wins.
- ✅ **[Medium] Resolve Choice values; lint sample data** — lint part DONE. `validateAppSpec` flags a Choice/MultiChoice sample value (per comma token for MultiChoice) that is not a declared option label; raw numeric option values still pass. (The live-metadata label→int *resolution* at load time is still spec-positional — tracked separately if cross-env option drift becomes a real problem.)
- ✅ **[Medium] Sub-grid placement + titling** — DONE. Each sub-grid now lands in its **own 1-column full-width section** (`subgridSectionIntent` + `firstColumnSectionsPointer`) instead of a half-width cell in a field section, and the title defaults to the child's `pluralName`→`displayName` (not the logical name), with `forms[].subgrids[].label` overriding (`sdk-build.js` forms phase).
- ✅ **[Medium] Handle the stock "Information" form** — DONE (opt-in). New `forms[].deactivateOtherMainForms` flag: when set, after promoting our form default the build deactivates every OTHER active main form on the entity (the stock Information form). OFF by default; gated to our own custom table; a flagged form must be the only Main form declared for its entity, and deactivation is skipped if the promote failed. Teardown's `restoreStockMainForm` reactivates a stock main form to ENABLE deletion — a delete-enabler, not a faithful restore of pre-build activation state (see the deferred follow-up below). `promoteDefaultForm` in `sdk-build.js`.
- ✅ **[Low–Med] Drop "Created On" from enriched default views** — DONE (already the SDK's behavior; now locked). Traced the vendored `enrichDefaultViews`: `updateElement('/columns')` is a REPLACE (not a union) and the view serializer reconciles the fetchxml+grid to exactly our column set (which never contains `createdon`), removing the stock Created On. Locked with a real-bundle regression test (`default-view-createdon.test.js`).
- ✅ **[Medium] Enable "Allow quick create" on key tables (#8, flag)** — DONE. The vendored `updateTable` now supports `quickCreateEnabled` (→ `IsQuickCreateEnabled`), so the build enables "Allow quick create" on a table when the spec opts in — either an explicit `entities[].quickCreate: true` OR an authored `formType: "QuickCreate"` form (auto-derived via `quickCreateEnabledFor`, so an authored Quick Create form is actually reachable from the inline "+ New"). Idempotent (applied to fresh AND reused tables). `entity-provision.js` data-model phase + `planFor` step; locked by `vendor-sdk-smoke.test.js` (PUT sends `IsQuickCreateEnabled`), `entity-provision.test.js`, `app-spec.test.js`, and eval #4. **Follow-up (open):** auto-GENERATE the Quick Create form's field layout (primary + required + parent lookups) for lookup-target / sub-grid-child tables so the maker doesn't hand-author it — the flag + a hand-authored `formType:"QuickCreate"` form work today; the auto-layout does not yet.
- ✅ **[Low–Med] Authored form column full width** — DONE (SDK safety net). hardening-3's `FormAdapter.normalizeColumn` defaults a synthesized (authored) column's `width` to `100%` when undefined, so a reconcile-added field can never emit invalid formxml ("required attribute 'width' is missing"). The plugin still sets width explicitly for exact control; locked by `hardening2-real-bundle.test.js` (a width-stripped authored column serializes `width="100%"`).

### Phase: Authoring intelligence
- 🔲 **Planner enrichment** — proactively propose the *full* surface (status model, dashboard, validation, default views, security), not just forms/views/charts.
- 🔲 **Form-JS scaffolding** — generate small, real onload/onchange handlers from intent (e.g. "warn when priority is High") instead of empty stubs.
- 🔲 **Spec templates** — domain starters (support desk, CRM, asset tracking) as one-shot scaffolds.

### Phase: Quality & docs
- ✅ **Security-role and jobs-to-be-done verification (2026-08-14)** — both **metadata-only**:
  - **`verify` now proves what a persona role GRANTS, not just that it exists.** The `role` check
    only asserted a row carrying the SDK marker, so a role built with the wrong access — or one whose
    privilege write failed after the row landed — verified clean. The new `role-privileges` check
    resolves each declared `(entity, access)` to its Dataverse `PrivilegeId` from the **same
    metadata source the SDK writes against** and asserts the role holds it at **at least** the
    declared depth. Deliberately a **subset** check (`lib/role-privileges.js` explains why equality
    would false-fail on `appAccess` injection, max-scope union, and shared privileges), and
    **fail-closed** on an unreadable role or table.
  - **`surfaces[]` is no longer documentary.** `lib/surface-resolver.js` resolves every
    `personas[].jobs[].surfaces[]` entry against the spec's own views/forms/pages/dashboards/tables
    /sitemap titles; `spec-lint` **warns** when one matches nothing (a warning, not an error — a
    surface may legitimately name an OOB artifact), and `verify` adds a `job-surface` rollup that
    reports a *deployed* failure as the job it broke ("persona P can no longer do job J") rather
    than only "view X is missing".
- ✅ **Sample-run UX fixes (2026-07-27, from a live Property-Listings build).**
  - ✅ **#1 live build status.** A long build now writes `<workspace>/.maker-workspace/build-status.json` (a single-object snapshot — `state`/`steps`/`lastPhase`/`lastLabel` — overwritten every step) alongside the `build-log.jsonl` trace, and prints a `▸ live progress:` path at start. So a multi-minute build is observable even when the launching shell buffers stdout. SKILL.md now tells the agent to stream (Tee, not Select-Object) and read the status file.
  - ✅ **#2 wireframes shown.** SKILL.md Phase-1 preview step now REQUIRES pasting the `preview-app.js`/`preview-form.js` wireframe output to the user (not summarizing "looks right") before the approval gate — the user must see the forms/sitemap/pages they approve.
  - ✅ **#3 (foundation) track the diff.** After a successful full apply the CLI persists `last-applied.json`; a later dry-run prints `▸ Changed since last apply: <phases>` (pure `phase-diff.js`, stable-stringify deep-equal). **Still open (tracked below): actually running ONLY the changed phases on `--apply`.**
  - ✅ **#5 auto-number reseed lint.** `spec-lint` now WARNS that sampleData for a table whose primary is auto-numbered with no single-column alternate key will DUPLICATE on every re-run (and blocks refreshing data with `--sample-data` on an edit) — nudging a natural alternate key.
- 🔄 **#3 execution / #7 — SAFE `--changed-only` partial apply (Preview; implemented + review-hardened + LIVE-VERIFIED).** Design **design-reviewed** + implementation **adversarially reviewed** all Critical/High fixed with tests + **live regression PASSED** (baseline→eligible, page edit→fast pages-only, chart edit→full fallback+debt, teardown→snapshot deleted). Canonical spec [`docs/app-builder-design.md`](./app-builder-design.md) (read its **v1 scope + contract**). Because the engine is ADDITIVE-not-convergent, the partial apply is **fail-closed**: identity-bound schema-3 snapshot (live orgId/env/app match, appId required), a durable eligibility state machine + sticky debt + teardown tombstone + generation-fenced CAS. **v1 wires ONE shape end-to-end — page-content re-upload**: `--apply --changed-only` after a FRESH baseline runs ONLY the pages phase for a `.tsx` byte edit (uploads just the changed keys — never clobbers an unchanged page — skips the sitemap finalize, records the measured deployed hash, re-blesses only when page verify passes); anything else falls back to a full build. Deliverables ①–⑨ ✅ (919 offline tests green + live regression). Off by default; opt in with `--changed-only`. **Follow-ups (deferred): pre-mutation live page-content drift verifier; view/sitemap/form fast submodes + `expectedSitemap` gating; `clearDebtMatching` production caller; unify `contentPath` confinement.**
- 🔲 **#4 page visual preview before deploy.** The generated `.tsx` is only structurally grep-checked; the user never *sees* the page (they hit the double-render live). Add a page preview/screenshot gate before the page is uploaded.
- 🔲 **#6 lifecycle status modeling.** The skill authored "Listing/Offer/Showing Status" as plain Choices, so the record `statecode` (Active/Inactive) is disconnected from business status (a "Sold" row is still an "active record", and `activeOnly` views need an extra Choice filter to compensate). Steer lifecycle fields toward Dataverse `statusReasons` (statecode/statuscode), which the App Spec already supports.
- 🔲 **#8 approval gate shows artifacts, not counts.** The plan gate presents a phase-count table; the user approves counts, not the reviewable data model / wireframes. Fold the wireframe (#2) + a data-model summary into the approval gate.
- 🔲 **app-builder eval fixtures** — the offline harness now has a `4-hardening` fixture + `ui` oracles that grade the 2026-07-15 fixes (default-view lookups #2 / no createdon #7, N:N ordering #3, sub-grid section+title #5, valid relational sample data #1/#4). Further spec→expected-plan/calls cases still welcome.
- 🔲 **Workspace reuse** — load `.maker-workspace/` metadata to skip re-discovery on iterative runs.
- 🔲 **Worked samples** — a Form-JS spec (web resource + onchange handler) and a dashboard spec in `samples/`.
- 🔲 **Refresh `authoring-flow.md`** Level (a) column-type list (still shows the pre-Tier-1 short list).
- 🔲 **KNOWN BEHAVIOR — an authored view named identically to a stock default view unions onto it.** An authored `views[]` entry whose name equals the Dataverse stock default ("Active/Inactive &lt;PluralName&gt;") is matched by `findArtifact('view', {name,entity})` and **reconciled (unioned) onto that stock default** rather than created as a new view. `reconcileView` (`sdk-build.js`) updates only `/columns`, so the authored **filters and sort are silently ignored** and the stock `createdon` is kept. Live-observed on `a scratch environment` (2026-07). **Mitigated:** `spec-lint` now WARNS when a view name matches the stock-default pattern (recommending a distinct name). **Still to decide (design call):** whether to also (a) fully reconcile a detected default view (columns + filters + sort) or (b) hard-reject the collision — deferred pending a decision; the warning makes it loud in the meantime.
- 🔲 **Review follow-ups deferred from the 2026-07-27 Sol PROD-readiness review (pre-prod-acceptable, documented here so they aren't lost).**
  - **Existing old-style sub-grid migration.** `addSubgrids` is idempotent by relationship (`hasSubgrid`), so a rebuild does NOT move a sub-grid that a *previous, pre-#5 build* placed as a half-width cell into the new full-width section, nor re-apply a changed label/view. No deployed apps predate #5 (the skill is pre-prod and the edit path is teardown+rebuild-fresh), so there is nothing to migrate today; this is consistent with the documented additive-build limitation (edits aren't re-applied in place). Revisit if in-place convergence lands.
  - **Self-referential / cyclic sample-data binds.** A sample row that `$parent`-binds to its own entity can't be seeded (the record-graph seeder resolves `@odata.bind` before the current group's ids exist). Not yet rejected at lint — needs SDK confirmation before a hard reject so a case the SDK *can* handle isn't blocked. Rare; document + revisit.
  - **Choice wire-type normalization.** The lint catches typo labels, but a numeric STRING for a single Choice stays a string and a numeric VALUE for a MultiChoice stays an Int32 (which Dataverse rejects for the multi-select CSV). Related edge: a MultiChoice option **label that itself contains a comma** passes whole-label validation but is split on the comma at resolve time (`resolveChoiceValue`), so it mis-resolves. Authors are steered to plain labels, so these are narrow edges; normalize-or-reject is a follow-up.
  - **Teardown activation-state restore.** `restoreStockMainForm` reactivates a stock main form to *enable deletion*, not to perfectly restore pre-build activation state (a form inactive before the build may be left active after teardown), and it runs for reused-table forms too. Acceptable for cleanup; a faithful save/restore is a follow-up.
- 🔲 **KNOWN ISSUE — /genpage vs /app-builder subagent-interaction contradiction** (design review F10): `/app-builder`'s SKILL says a `Task` subagent is headless (`AskUserQuestion`/plan-mode do not reach the user from inside one), while `/genpage` Phase 1 **mandates** `AskUserQuestion` + plan-mode *inside* the `genpage-planner` subagent (`skills/genpage/SKILL.md:92-124`, `agents/genpage-planner.md`). One is wrong about the host runtime. Portable fix: run interactive steps in the main loop and use the planner subagent only for headless prereq/auth/detection that returns data — align `/genpage` to `/app-builder`. Needs host-behavior confirmation before restructuring.

---

## ⛔ Deferred / blocked

Intentionally punted (a real blocker, not just "not done yet"), with the *why*, so we don't
re-litigate. Two hard blockers dominate: **(A)** anything needing **Power Fx + a component library**
can't be authored headlessly; **(B)** **PCF control bindings** need **solution-import** delivery the
SDK doesn't package.

- 🔴 **PCF custom-control bindings** — the SDK emits correct formxml, but a plain `pushArtifact` strips the control `uniqueid`, so the binding persists **only via solution import** (export → unzip → patch `customizations.xml` → rezip → import). The SDK exposes no artifact→zip packaging, and it needs a pre-deployed control to bind to. **Unblock:** an SDK helper that packages a form artifact (with its `$meta.formxml`) into an importable solution zip.
- 🔴 **Conditional (rule-based) command visibility** — modern commands express this **only** as Power Fx (component-library bind) → blocker A. Static `hidden`/`disabled` **ships**.
- 🔴 **Power Fx command on-click** — same component-library blocker (A). **JavaScript** on-click **ships**.
- 🟡 **Titled command groups** — a titled group needs a parent command-bar row the adapter doesn't synthesize for from-scratch commands (re-confirmed live: Dataverse 400 "Group button must have parentappactionid"). Buttons emit as loose controls; **flyout / split-button menus do work**. **Unblock:** SDK synthesis of the parent group rows.
- 🟡 **Interactive (type 10) dashboards** — different formxml machinery (streams/tiles keyed by cell id); the tile generator targets Standard (type 0). **Unblock:** an interactive-dashboard tile generator.
- ⚠ **Business-rule validation** — org-gated on the available test orgs (missing the `*ProcessWithWfomJson` action) so it can't be live-verified here, and the modern path is Power-Fx-flavored. Build behind a capability flag once an org supports it.
- 🟡 **Explicit app-component re-pin on an app EDIT** — a NEW chart added to an ALREADY-DEPLOYED app on an edit rebuild is not re-pinned as an explicit app component: the SDK's generic surface can't add a missing `components` object to a fetched app (`setAppDefinition` was retired). Low impact — the chart is still added to the solution and shows on its table's chart pane; rebuild the app fresh, or surface the chart via a dashboard/sitemap subarea, if it must be an explicit component. **Unblock:** an SDK component-set API for a fetched app, or fetch populating `components`.

---

## Notes for the next implementer
- New artifact types reuse the `buildArtifact(type, def)` helper (createArtifact → optional pre-push tweaks → pushArtifact → addSolutionComponent) plus a new `COMPONENT_TYPE` entry.
- Add a phase to `PHASES`, a `planFor` branch, a `spec-lint` / `app-spec` validation block, schema-doc + skill notes, and **both** a mock-SDK engine test **and** a `vendor-sdk-smoke` assertion against the real bundle.
- Rebundle the SDK (`node scripts/_vendor-build/build.js --sdk <ppux>`) only when pulling new SDK methods. See [`../AGENTS.md`](../AGENTS.md) → *Building & Testing*.
