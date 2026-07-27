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
- Interactive two-level authoring in the **main loop** (env select, App Spec, lint gate, plan-mode approval).
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
- 🔲 **Global option-set find-by-name** — re-bind a column to a *pre-existing* global choice (today a duplicate create is swallowed but the column can't rebind for lack of an id).
- 🔲 **Solution-component idempotency** — query existing solution components instead of assuming reused web resources are already present.
- 🔲 **Live-verify Calculated / Rollup** formula columns end-to-end.
- 🔲 **Publish granularity** — optionally publish web resources separately from entity customizations.
- 🔲 **Richer `BuildHalt` recovery** — skip-phase / retry-step / edit-spec-and-resume prompts.

### Phase: Forms, views & data-load polish (from the 2026-07-15 V1↔V2 comparison review)
Source: `IMPROVEMENTS-07-15-app-builder.md` (Project Management V1/V2 diff + a sample data-load). **Status 2026-07-27: 7 of 8 shipped (commits 14da073a, dd94ee51, 84149ce3, 7f1f2e74, 276b9833); only auto Quick Create (#8) remains.** Severity from the source doc.
- ✅ **[High] Validate lookup binds; stop silent data-load lookup failures** — DONE. `validateAppSpec` now validates `$parents` (junction) the same as `$parent` and flags a `$parent`/`$parents.match` that resolves to no parent sample row (the bind would be dropped and the lookup left unset); `buildSeedGroup` THROWS (fail loud) on an unresolvable parent instead of silently skipping. Runs inside `runner.run` (clean phase failure). `app-spec.js` sampleData validation + `entity-provision.js` buildSeedGroup.
- ✅ **[Medium] Don't truncate parent lookups in default-view enrichment** — DONE. `defaultViewColumns` now reserves the parent-lookup slots up front and caps *scalar* columns at the remaining budget, then appends every lookup — so a lookup-heavy table never drops a parent link (`sdk-build.js`). Teardown's `{ includeLookups:false }` reset path unchanged.
- ✅ **[Medium] Normalize N:N relationship schema-name ordering** — DONE. `manyToManySchemaName` sorts the two entity logical names alphabetically before composing, so the N:N name is stable regardless of `entity1`/`entity2` declaration order (`app-spec.js`). 1:N keeps its semantic `referenced_referencing` order; explicit `schemaName` still wins.
- ✅ **[Medium] Resolve Choice values; lint sample data** — lint part DONE. `validateAppSpec` flags a Choice/MultiChoice sample value (per comma token for MultiChoice) that is not a declared option label; raw numeric option values still pass. (The live-metadata label→int *resolution* at load time is still spec-positional — tracked separately if cross-env option drift becomes a real problem.)
- ✅ **[Medium] Sub-grid placement + titling** — DONE. Each sub-grid now lands in its **own 1-column full-width section** (`subgridSectionIntent` + `firstColumnSectionsPointer`) instead of a half-width cell in a field section, and the title defaults to the child's `pluralName`→`displayName` (not the logical name), with `forms[].subgrids[].label` overriding (`sdk-build.js` forms phase).
- ✅ **[Medium] Handle the stock "Information" form** — DONE (opt-in). New `forms[].deactivateOtherMainForms` flag: when set, after promoting our form default the build deactivates every OTHER active main form on the entity (the stock Information form). OFF by default; gated to our own custom table; symmetric with teardown's `restoreStockMainForm` (reactivates on teardown). `promoteDefaultForm` in `sdk-build.js`.
- ✅ **[Low–Med] Drop "Created On" from enriched default views** — DONE (already the SDK's behavior; now locked). Traced the vendored `enrichDefaultViews`: `updateElement('/columns')` is a REPLACE (not a union) and the view serializer reconciles the fetchxml+grid to exactly our column set (which never contains `createdon`), removing the stock Created On. Locked with a real-bundle regression test (`default-view-createdon.test.js`).
- 🔲 **[Medium] Auto-create a Quick Create form for key tables** — OPEN. The build authors only **main** forms, so the inline **"+" quick-create** (from a lookup or a sub-grid *+ New*) has no Quick Create form and comes up empty, even though `formType: "QuickCreate"` is supported by `compileFormIntent`. Auto-generate a Quick Create form (primary + required + parent lookups) for lookup-target / sub-grid-child tables **and enable "Allow quick create" on them**. **Blocker/scope:** the vendored `cds-maker-sdk` has NO `IsQuickCreateEnabled` support (its `updateTable` only maps displayName/pluralName/audit/duplicate-detection/change-tracking/icons), so enabling the table flag needs a raw `EntityDefinitions` GET-mutate-PUT (mirroring the SDK's own `updateTable`, with `MSCRM.MergeLabels`) — new live-metadata plumbing that requires live validation. Also a design call on which tables opt in (auto for all lookup-target/sub-grid-child tables vs an explicit `entities[].quickCreate` flag).

### Phase: Authoring intelligence
- 🔲 **Planner enrichment** — proactively propose the *full* surface (status model, dashboard, validation, default views, security), not just forms/views/charts.
- 🔲 **Form-JS scaffolding** — generate small, real onload/onchange handlers from intent (e.g. "warn when priority is High") instead of empty stubs.
- 🔲 **Spec templates** — domain starters (support desk, CRM, asset tracking) as one-shot scaffolds.

### Phase: Quality & docs
- 🔲 **app-builder eval fixtures** — extend the eval suite with spec → expected-plan/calls cases.
- 🔲 **Workspace reuse** — load `.maker-workspace/` metadata to skip re-discovery on iterative runs.
- 🔲 **Worked samples** — a Form-JS spec (web resource + onchange handler) and a dashboard spec in `samples/`.
- 🔲 **Refresh `authoring-flow.md`** Level (a) column-type list (still shows the pre-Tier-1 short list).
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
- ⚠ **Business-rule validation** — org-gated on the Aurora test orgs (missing the `*ProcessWithWfomJson` action) so it can't be live-verified here, and the modern path is Power-Fx-flavored. Build behind a capability flag once an org supports it.
- 🟡 **Explicit app-component re-pin on an app EDIT** — a NEW chart added to an ALREADY-DEPLOYED app on an edit rebuild is not re-pinned as an explicit app component: the SDK's generic surface can't add a missing `components` object to a fetched app (`setAppDefinition` was retired). Low impact — the chart is still added to the solution and shows on its table's chart pane; rebuild the app fresh, or surface the chart via a dashboard/sitemap subarea, if it must be an explicit component. **Unblock:** an SDK component-set API for a fetched app, or fetch populating `components`.

---

## Notes for the next implementer
- New artifact types reuse the `buildArtifact(type, def)` helper (createArtifact → optional pre-push tweaks → pushArtifact → addSolutionComponent) plus a new `COMPONENT_TYPE` entry.
- Add a phase to `PHASES`, a `planFor` branch, a `spec-lint` / `app-spec` validation block, schema-doc + skill notes, and **both** a mock-SDK engine test **and** a `vendor-sdk-smoke` assertion against the real bundle.
- Rebundle the SDK (`node scripts/_vendor-build/build.js --sdk <ppux>`) only when pulling new SDK methods. See [`../AGENTS.md`](../AGENTS.md) → *Building & Testing*.
