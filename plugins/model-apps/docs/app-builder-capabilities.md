# app-builder — capabilities

What the `/app-builder` skill can do today, and how far each capability has been proven. The build
engine is [`../scripts/lib/sdk-build.js`](../scripts/lib/sdk-build.js); the App Spec contract is
[`../references/app-spec-schema.md`](../references/app-spec-schema.md); the wiring diagrams are in
[`architecture.md`](architecture.md).

This file records **shipped** behaviour only. Planned and unbuilt work is tracked in GitHub issues —
the carried-over backlog is
[#480](https://github.com/microsoft/power-platform-skills/issues/480). A roadmap committed alongside
the code goes stale silently and states intent the code does not yet support, so the two are kept
apart deliberately.

**Evidence legend**
- ✅ **verified live** — built end-to-end on a real Dataverse environment and torn down clean.
- 🧪 **tested** — has automated (unit / golden / real-bundle) coverage, not exercised on a live org.
- ⚠ **not live-verified** — plumbed through and unit-tested, awaiting a live shakeout.

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

### Business rules — 🧪 tested
- `businessRules[]` — declarative form logic with no code: show/hide (`SetVisibility`), lock/unlock
  (`LockUnlock`), set-required (`SetBusinessRequired`) and set-value (`SetFieldValue`), gated on a
  condition over the record (`Equals` · `DoesNotEqual` · `ContainsData` · `DoesNotContainData`).
- Compiled to classic workflow XAML by the vendored SDK and activated on create. The supported slice
  is exactly what that compiler accepts; every field is validated against the rule's own entity, so a
  rule naming a column that does not exist is rejected up front rather than deploying and never firing.
- Additive on rebuild (matched by `entity` + `name`, reused if present); torn down with the app.
- The **SDK path** is ✅ live-verified — a rule created, activated, and the platform's own generated
  `clientdata` named the authored columns. The **App Spec surface** over it is unit- and
  real-bundle-tested; a live end-to-end build through `businessRules[]` is the outstanding step.

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
- `download-model-app.js` pulls a **deployed app** back into an editable App Spec (+ page code, icons, referenced entities, and the app's **real unmanaged solution** — `recoverAppSolution` enumerates the app's solution memberships and excludes the built-in `Active`/`Default`/`Basic` system solutions, so the spec names the right container for a later clean teardown); edit the spec and re-run the idempotent build — **create and edit share one path** (reuses app/tables, updates pages in place, keeps `GenPage` subareas). The app-shell phase **re-syncs the sitemap + components of any existing app** (fetch → recompute-from-spec → push → publish), so subarea add/rename/reorder edits land for **page-less apps too** — not just generative-page apps — and `--only app-shell` can force the rewrite. **Classic DashBoard subareas are *designed* to round-trip** — the dashboard is reconstructed into `dashboards[]` with **id-passthrough tiles** (each tile carries the deployed view/chart ids), so a rebuild recreates it against the existing views/charts without re-declaring them. **This does not currently work end to end:** live-verified 2026-08-27, the vendored SDK's `fetchArtifact('dashboard', …)` throws `Cannot read properties of null (reading 'length')` while deserializing the `<parameters>` block it itself serialized, so no tiles are recovered and the subarea is dropped — which then fails the whole download unless `--allow-lossy-download` is passed. Reproduced on the current **and** the previous bundle, so it is not a regression from the SDK uptake; tracked upstream. Download now names the cause instead of silently dropping the subarea. **Round-trip scope (not yet "complete"):** tables, sitemap/appShell, generative pages, icons, and solution round-trip; **dashboards, forms, views, charts, and commands do NOT yet** — view hydration was tried and reverted (LIVE-verified the deployed savedquery set can't reliably distinguish author views from Dataverse's auto-generated Active/Inactive/QuickFind system views). All survive on the live app (a rebuild preserves them by discovery) but are absent from the downloaded spec, so edit them in Maker or a fresh spec.
- Live regression on the edit path found + fixed **4 bugs**, then re-verified clean.
- `verify-model-app.js` — read-only reconcile of spec vs deployed (exits non-zero on anything missing). Sitemap checks are **element-scoped**: an area/subarea icon is matched on its own `<Area>`/`<SubArea>` element, and a **dashboard subarea** is verified by resolving the dashboard id (systemform type 0, by name) and matching the sitemap's `DefaultDashboard` — so a value reused elsewhere can't produce a false pass. **Multi-area sitemaps** and the dashboard-subarea path were re-verified live (positive + negative).

### Teardown — ✅ verified live
- `teardown-model-app.js` deletes exactly what an App Spec declares, in dependency-safe order (app → dashboards → commands → forms → charts → views → relationships → AI row summaries → tables [children-first] → web-resources → global choices → solution). Forms/charts/views/relationships are removed **before** tables (a table delete doesn't reliably cascade cross-references); **web resources are removed AFTER tables** (a table's icon web resource is referenced by the table).
- **Classifier-safe** (every id resolved from a spec-declared name via an exact-match, entity-scoped filter), dry-run by default, best-effort continue, not-found aware, undeletable (system/managed) artifacts recorded as `skipped`. A **restricted system solution** (`Active`/`Default`/`Basic`) is skipped rather than attempted (Dataverse 400s any delete of one), so a downloaded spec that defaulted its solution to `Default` tears down cleanly. An already-gone relationship (Dataverse 400 *"…but 0 were found"*) is tolerated as deleted, like the table not-found case.

### Tooling & internals — ✅ verified live
- ASCII **form wireframe** preview (`preview-form.js`); phase-grouped build log with per-step status glyphs (`✓`/`⊘`/`✗`) + a closing summary.
- **SDK consolidation** — the SDK owns the Dataverse mechanics (`seedRecordGraph`, `enrichDefaultViews`, AI settings/row-summaries, artifact `resolveArtifact`/`findArtifact`/`deleteAppCascade`); the plugin keeps the judgment (spec validation, choice/status resolution, `$parent`→bind translation, candidate selection).

