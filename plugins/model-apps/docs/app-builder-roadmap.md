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
- App module + sitemap; **multi-area sitemaps** — every `appShell.areas[]` maps to its own `<Area>` (icon + groups + subareas; order follows array order).
- Generative pages (**genpage-first**) for overview / dashboard surfaces — uploaded via `pac model genpage upload`; the SDK finalizes the sitemap with `GenPage` subareas.
- Dashboards (chart / list / iframe / webresource tiles) with **sitemap placement** (auto-pinned as an app component). Tiles render in a **multi-column grid** (2-wide) rather than one stacked full-width column.
- Modern command-bar buttons — functional **JS on-click** + static hidden/disabled, incl. **flyout / split-button menus**.
- Web resources (JS / HTML / CSS) shipped + added to the solution; idempotent (reuse by name).

### AI-first features — ✅ verified live
- `ai` block → `ai-features` phase: form-fill, NL search, NL charts, M365 Copilot, and per-table Copilot **row summaries** with tailored `GptDynamicPrompt-2` prompts (auto-selected candidate tables; skips lookup/config/junction + D365-owned incident/lead/opportunity).
- **Admin-gated**: preflights each setting (`RetrieveSetting`), skips/warns when off, never fails the build. NL grid search is **environment-gated** (`EnableNLGridSearch`), not per-app. Standalone reporter `scripts/ai-preflight.js`.

### Edit flow (download → edit → rebuild) — ✅ verified live
- `download-model-app.js` pulls a **deployed app** back into a complete App Spec (+ page code, icons, referenced entities, solution); edit the spec and re-run the idempotent build — **create and edit share one path** (reuses app/tables, updates pages in place, keeps `GenPage` subareas). The app-shell phase **re-syncs the sitemap + components of any existing app** (fetch → recompute-from-spec → push → publish), so subarea add/rename/reorder edits land for **page-less apps too** — not just generative-page apps — and `--only app-shell` can force the rewrite. **Classic DashBoard subareas round-trip** too: the dashboard is reconstructed into `dashboards[]` with **id-passthrough tiles** (each tile carries the deployed view/chart ids), so a rebuild recreates it against the existing views/charts without re-declaring them.
- Live regression on the edit path found + fixed **4 bugs**, then re-verified clean.
- `verify-model-app.js` — read-only reconcile of spec vs deployed (exits non-zero on anything missing). Sitemap checks are **element-scoped**: an area/subarea icon is matched on its own `<Area>`/`<SubArea>` element, and a **dashboard subarea** is verified by resolving the dashboard id (systemform type 0, by name) and matching the sitemap's `DefaultDashboard` — so a value reused elsewhere can't produce a false pass. **Multi-area sitemaps** and the dashboard-subarea path were re-verified live (positive + negative).

### Teardown — ✅ verified live
- `teardown-model-app.js` deletes exactly what an App Spec declares, in dependency-safe order (dashboards → commands → forms → charts → views → relationships → web-resources → AI row summaries → tables [children-first] → global choices → solution). Forms/charts/views/relationships are removed **before** tables (a table delete doesn't reliably cascade cross-references).
- **Classifier-safe** (every id resolved from a spec-declared name via an exact-match, entity-scoped filter), dry-run by default, best-effort continue, not-found aware, undeletable (system/managed) artifacts recorded as `skipped`. An already-gone relationship (Dataverse 400 *"…but 0 were found"*) is tolerated as deleted, like the table not-found case.

### Tooling & internals — ✅ verified live
- ASCII **form wireframe** preview (`preview-form.js`); phase-grouped build log with per-step status glyphs (`✓`/`⊘`/`✗`) + a closing summary.
- **SDK consolidation** — the SDK owns the Dataverse mechanics (`seedRecordGraph`, `enrichDefaultViews`, AI settings/row-summaries, artifact `resolveArtifact`/`findArtifact`/`deleteAppCascade`); the plugin keeps the judgment (spec validation, choice/status resolution, `$parent`→bind translation, candidate selection).

---

## 🔜 Pending — by phase

### Phase: Edit & lifecycle
- 🔲 **Delta / diff-based edit** — spec-diff against a deployed app and apply only the *changed* delta (SDK `updateColumn`/`deleteColumn`/`updateTable`/`deleteRelationship`/`updateWebResource`, `fetchArtifact` snapshots, `diffArtifact`) instead of a full idempotent re-apply.
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

### Phase: Authoring intelligence
- 🔲 **Planner enrichment** — proactively propose the *full* surface (status model, dashboard, validation, default views, security), not just forms/views/charts.
- 🔲 **Form-JS scaffolding** — generate small, real onload/onchange handlers from intent (e.g. "warn when priority is High") instead of empty stubs.
- 🔲 **Spec templates** — domain starters (support desk, CRM, asset tracking) as one-shot scaffolds.

### Phase: Quality & docs
- 🔲 **app-builder eval fixtures** — extend the eval suite with spec → expected-plan/calls cases.
- 🔲 **Workspace reuse** — load `.maker-workspace/` metadata to skip re-discovery on iterative runs.
- 🔲 **Worked samples** — a Form-JS spec (web resource + onchange handler) and a dashboard spec in `samples/`.
- 🔲 **Refresh `authoring-flow.md`** Level (a) column-type list (still shows the pre-Tier-1 short list).

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

---

## Notes for the next implementer
- New artifact types reuse the `buildArtifact(type, def)` helper (createArtifact → optional pre-push tweaks → pushArtifact → addSolutionComponent) plus a new `COMPONENT_TYPE` entry.
- Add a phase to `PHASES`, a `planFor` branch, a `spec-lint` / `app-spec` validation block, schema-doc + skill notes, and **both** a mock-SDK engine test **and** a `vendor-sdk-smoke` assertion against the real bundle.
- Rebundle the SDK (`node scripts/_vendor-build/build.js --sdk <ppux>`) only when pulling new SDK methods. See [`../AGENTS.md`](../AGENTS.md) → *Building & Testing*.
