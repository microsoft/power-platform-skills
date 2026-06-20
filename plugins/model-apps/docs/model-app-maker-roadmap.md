# model-app-maker — Roadmap / TODO

Status of the `/model-app-maker` skill (intent → model-driven app via the headless
`cds-maker-sdk`). Tracks what's shipped, what's pending (by priority), and the full enhancement
backlog. The build engine is `scripts/lib/sdk-build.js`; the App Spec contract is
`references/app-spec-schema.md`.

**Legend:** ✅ done · �priority (P0 = next, P1 = soon, P2 = later) · ⚠ not live-verified.

---

## ✅ Complete

### Authoring + build framework
- ✅ Interactive two-level authoring in the **main loop** (env select, App Spec, lint gate, plan-mode approval).
- ✅ Deterministic, **idempotent** build engine — discover via SDK (`findTables`/`findColumns`/`fetchEntityMetadata`), create only what's missing; new / existing / mixed envs all work.
- ✅ **All Dataverse access via the SDK**; metadata persisted to `<app-folder>/.maker-workspace/` for reuse.
- ✅ **Phase selection** (`--only`/`--skip`/`--from`/`--to`): `solution · data-model · sample-data · web-resources · views · charts · forms · app-shell · publish`.
- ✅ Live narration (`[n/total]`), `BuildHalt` gate, dry-run default, `--sample-data` / `--publish` opt-in.
- ✅ Perf: bounded-concurrency `mapLimit` for independent ops; one publish round-trip per entity + the app.
- ✅ Headless vendored SDK bundle + `az`-token HttpClient with transient (429/5xx) retry.
- ✅ Lint guardrail (`spec-lint.js`) + hard validator (`app-spec.js`); 169 tests green.

### Tier 1 — complete data model
- ✅ All column types: Text · Memo · Choice · MultiChoice · Boolean · Money · DateTime · Integer · BigInt · Decimal · Double · File · Image · AutoNumber · Customer, with per-type options.
- ✅ Global option sets (`globalChoices[]`), status reasons, alternate keys.
- ✅ Relationships: OneToMany (lookup) **and** ManyToMany.
- ✅ Customer (polymorphic) columns.
- ⚠ Calculated / Rollup formula columns (`source` + `formula` plumbed through; not live-verified).

### Tier 2 — UI + logic (partial) — **live-verified on 983a1**
- ✅ **Web resources** (`webResources[]`) — JS/HTML/CSS shipped via `createWebResource`, added to the solution (component type 61). Source from `content` / `contentPath` / `contentBase64`. Idempotent (reuse by name).
- ✅ **Form JS event handlers** (`forms[].events[]`) — `onload`/`onsave`/`onchange` wired via `addFormEventHandler` (fetch → inject → push → publish). Lint enforces the library reference + onchange attribute.
- ✅ Shakeout (2026-06-20): built a Widget app (table, Choice/Integer columns, web resource, view, chart, form with onload+onchange handlers, app, sample data) on 983a1; verified the web resource content + the form's injected `formLibraries`/events in Dataverse; tore down all session artifacts.

### SDK-fix uptake + folded build steps (2026-06-20) — no more post-build scripts
Rebundled the SDK (branch `users/akmaloo/cds-maker-sdk`) and folded every manual post-build step into the one-pass builder:
- ✅ **AutoNumber primary column** — `primaryAttribute.autoNumberFormat` → `createTable.primaryColumnAutoNumberFormat` (the number is the record identity).
- ✅ **N:N sub-grids** — a sub-grid resolves a `OneToMany` **or** `ManyToMany` relationship; plus documented the **junction-with-payload** pattern for N:N-with-attributes.
- ✅ **Multi-parent sample rows** — `$parents[]` binds a junction row to both sides (e.g. technician↔work-order assignment) — replaces the manual association script.
- ✅ **Status reasons on sample rows** — `statusReason` label → resolved `statecode`+`statuscode` (the engine captures `insertStatusValue`'s assigned value).
- ✅ **Rich view filters** — `filters[]` with `eq-userid`/`this-week`/`in`/`not-in`/… and Choice-label resolution (`in`/`not-in` expand to nested groups) — replaces manual FetchXML patching.
- ✅ **Docs**: `app-spec-schema.md` is now the single authoring source (modeling cheatsheet up top), so the skill needs no SDK/lint/engine spelunking. Removed the `model: sonnet` pin so the skill inherits the session model.

### Authoring UX (2026-06-20)
- ✅ **Form wireframe preview** — `scripts/preview-form.js` renders each form as an ASCII wireframe (tabs, sections, fields + widget hints, Notes/timeline, sub-grids, form JS) so the user can *see* a form during authoring before approving.
- ✅ **Build steps broken down with status** — the build log is phase-grouped (`▶ phase`) with a per-step status glyph (`✓` created / `⊘` skipped / `✗` failed) and a closing summary; dry-run lists the same plan with a `▢` marker.
- ✅ Adaptive main forms (auto + explicit tabs/sections), related-record sub-grids, Notes section.
- ✅ Views (active-records), Choice-column charts, app module + sitemap.

---

## 🔜 Pending — by priority

### P0 — finish Tier 2 (UI + logic)
- 🔲 **Dashboards** (`dashboards[]` → `createArtifact('dashboard')`). ⚠ **Design note:** the SDK's
  dashboard adapter is **overlay-oriented** (fetch → edit existing cells → push); `createDefault`
  seeds a single empty cell and `overlayComponents` only touches cells that already contain a
  `<control>`. So **from-scratch** multi-tile dashboards need a **FormXML generator** that emits
  chart/list control cells (control classId `{E7A81278-8635-4D9E-8D4D-59480B391C5B}`; `ChartGridMode`
  = `Chart` for a chart tile, list otherwise; parameters `TargetEntityType` + `ViewId` / chart
  `VisualizationId`), then inject it as the artifact's `$meta.formxml` before push. Component type
  60 (SystemForm). Plan: tile-grid generator referencing the views/charts already built; **needs
  live verification** before shipping.
- 🔲 **Commands / ribbon buttons** (`commands[]` → `createArtifact('command')`). ✅ live-verified in the SDK. New phase + spec section + lint + tests.
- 🔲 **Business rules** (`businessRules[]` → `createArtifact('businessRule')`). ⚠ org-gated; not live-verifiable on Aurora. Build behind a capability flag; condition/action spec shape + lint + tests.

### P1 — edit flow + lifecycle
- 🔲 **Edit flow** — spec-diff against a deployed app; apply only the delta. Leverage SDK `updateColumn`/`deleteColumn`/`updateTable`/`deleteRelationship`/`updateWebResource`, `fetchArtifact` snapshots, and `diffArtifact`. Handles "edit existing form/view", "add column to existing table", "rewire an event handler".
- 🔲 **Teardown command** — delete session-created artifacts in dependency order (app 80 / sitemap 62 / forms 60 / charts 59 / views 26 / web resources 61 / relationships / columns / tables), via `RetrieveDependenciesForDelete`. (One-off teardown recipe already proven manually; make it a first-class, classifier-safe command.)
- 🔲 **Form events on existing forms** — current wiring assumes a freshly built form; the edit flow should fetch an existing form, add/replace handlers, and publish.

### P2 — shippable defaults + breadth
- 🔲 **Quick-create forms** + **quick-view forms** (`formType` variants).
- 🔲 **Standard system views** (All Records, Active, Inactive, Lookup, Associated) auto-generated per table.
- 🔲 **Multi-area sitemaps** + richer app-shell (multiple areas/groups, icons, ordering).
- 🔲 **Tier 3 — governance:** security roles, environment variables, connection references.
- 🔲 **Solution packaging** — `exportSolution`/`importSolution` for hand-off / source control (managed/unmanaged).

---

## 💡 Enhancement backlog (capture-all)

### Build engine / correctness
- 🔲 **Global option-set idempotent lookup** — today a duplicate `createGlobalOptionSet` is swallowed, but an *existing* global choice can't be re-bound to a column (no id). Add a find-by-name so columns bind to a pre-existing set.
- 🔲 **Solution-component idempotency** — `addSolutionComponent` is skipped for reused web resources (assumed already present); harden by querying existing solution components instead of assuming.
- 🔲 **Live-verify Calculated/Rollup** formula columns end-to-end.
- 🔲 **Publish granularity** — optionally publish web resources separately from entity customizations.
- 🔲 **Bulk relationship creation / ordering** — topological create when lookups feed sub-grids/views.
- 🔲 **Retry/halt UX** — richer `BuildHalt` recovery prompts (skip-phase, retry-step, edit-spec-and-resume).

### Authoring intelligence
- 🔲 **Planner enrichment** — proactively propose the *full* surface (status model, dashboard, validation/business rules, default views, security) rather than only forms/views/charts ("think about all of them").
- 🔲 **Form-JS scaffolding** — generate small, real onload/onchange handlers from the user's intent (e.g. "warn when priority is High") instead of empty stubs.
- 🔲 **Spec templates** — domain starters (support desk, CRM, asset tracking) as one-shot scaffolds.

### Quality / ops
- 🔲 **Live e2e shakeout on 983a1** for each new artifact type (dashboards/commands), then tear down.
- 🔲 **Eval coverage** — extend the eval suite with model-app-maker fixtures (spec → expected plan/calls).
- 🔲 **Workspace reuse** — load `.maker-workspace/` metadata to skip re-discovery on iterative runs.
- 🔲 **`--dry-run` diff view** — show spec-vs-deployed delta before apply (precursor to the edit flow).

### Docs
- 🔲 Add a worked **Form-JS sample** spec to `samples/` (web resource + onchange handler).
- 🔲 Add a worked **dashboard** sample once the generator lands.
- 🔲 Refresh `authoring-flow.md` Level (a) column-type list (still shows the pre-Tier-1 short list).

---

## Notes for the next implementer
- New artifact types reuse the `buildArtifact(type, def)` helper (createArtifact → optional pre-push tweaks → pushArtifact → addSolutionComponent) and a new `COMPONENT_TYPE` entry.
- Add a phase to `PHASES`, a `planFor` branch, a `spec-lint`/`app-spec` validation block, schema-doc + skill notes, and both a mock-SDK engine test **and** a `vendor-sdk-smoke` assertion against the real bundle.
- Rebundle the SDK with `node scripts/_vendor-build/build.js` only when pulling new SDK methods.
