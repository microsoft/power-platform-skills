# model-app-maker — Roadmap / TODO

Status of the `/model-app-maker` skill (intent → model-driven app via the headless
`cds-maker-sdk`). Tracks what's shipped, what's pending (by priority), and the full enhancement
backlog. The build engine is `scripts/lib/sdk-build.js`; the App Spec contract is
`references/app-spec-schema.md`. **Intentionally deferred / blocked items (with the *why*) are
tracked in [`model-app-maker-todo.md`](./model-app-maker-todo.md).**

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
- ✅ Lint guardrail (`spec-lint.js`) + hard validator (`app-spec.js`); 207 tests green.

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

### Live-build hardening (2026-06-20) — three gaps hit in a real build, now closed
Found during a live build; each is fixed where it actually belongs (lint can only see the spec,
not runtime phase selection or re-run state):
- ✅ **Global-choice sample labels resolve** — `resolveSampleRecords`/`choiceValueMap` now map labels
  → option ints for `globalChoice`-backed Choice **and** MultiChoice columns (not just inline
  `options[]`), using the same `100000000+index` convention the engine creates them with. Writing
  `"Platinum"` for a global choice just works. **Lint backstop:** any Choice/MultiChoice sample value
  that isn't a declared option label or a raw int is now an error (catches typos forever).
- ✅ **Alt-key creation is idempotent** — the SDK has no key lister, so a re-run used to halt on the
  duplicate. A reusable `skipIf` on the engine's `run()` + an `isAlreadyExists(err)` classifier turns
  an already-exists create into a **skip** (a genuine bad-key error still halts). Re-running
  `data-model` no longer needs `--skip`.
- ✅ **Status-reason guard** — custom `statusReason` option values are captured during `data-model`;
  if that phase is skipped, the engine now **halts loudly** ("status value wasn't captured…") instead
  of silently inserting the record with a default status. (Fixing the alt-key idempotency removes the
  reason anyone was skipping `data-model` in the first place.)

### Live-build hardening, round 2 (2026-06-21) — two more gaps from a real build
- ✅ **MultiChoice single value renders as a string** — a multi-select picklist needs a
  comma-separated `Edm.String` *even for one value*; the resolver was emitting a bare `Int32`
  (`Cannot convert '100000002' (Int32) to Edm.String`). `resolveChoiceValue` now stringifies +
  comma-joins MultiChoice tokens (single-select Choice still resolves to an int).
- ✅ **Status reasons are idempotent across `data-model` re-runs** — `insertStatusValue` is NOT
  idempotent (no explicit Value → Dataverse auto-assigns a new one each call → duplicates). The
  engine now PINS a deterministic publisher-range value (`100000000+i`, or `sr.value`) and passes
  it explicitly, so a re-run hits already-exists → `skipIf` skips (no duplicate) while the value
  stays captured for sample data. Resolves the catch-22 with the status-capture guard: re-running
  *with* `data-model` is now safe.
- ✅ **SDK rebundled** from `users/akmaloo/cds-maker-sdk` (Notes/timeline control, quick-create /
  quick-view form types, PCF `addCustomControl`, verified PCF binding). Bundle 3121 KB.
- ✅ **Live-verified on 983a1 (2026-06-21):** a throwaway 3-table app exercised every change —
  AutoNumber primary (`RC-1000`), global-choice label→int (Silver→`100000002`), MultiChoice single
  (`'100000001'`) + multi (`'100000000,100000002'`) as strings, status-reason pinned value
  (`statuscode 100000000`), junction `$parents` (both lookups set), QuickCreate form (`type=QuickCreate`),
  and an idempotent `--only data-model` re-run (alt-key + status reason both `⊘ exists`, no halt/dup).
  Built 22/22, verified via Web API, torn down clean.

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

### SDK uptake (2026-06-21) — in progress (user approved all four)
- ✅ **Quick-create / quick-view forms** (`forms[].formType` = `Main`/`QuickCreate`/`QuickView`).
  QuickCreate is a full simplified create form; QuickView is created but **placement on a parent
  form (via a lookup) isn't auto-wired** (no SDK helper — lint warns). Notes/sub-grids are Main-only
  (validator + lint enforced). ✅ live-verified on 983a1 (a QuickCreate form built as `type=QuickCreate`).
- ✅ **Modern command-bar buttons** — `commands[]` → `createArtifact('command')`, **functional**
  JS on-click (the SDK now sets `onclickeventtype=2` + the web-resource bind + function name) plus
  static `hidden`/`disabled`. Buttons are emitted as loose controls (empty-title group — a titled
  group needs a parent command-bar row the adapter doesn't synthesize: Dataverse 400s "Group button
  must have parentappactionid"). ✅ **live-verified on 983a1 (2026-06-21):** 2 buttons landed with
  `onclickeventtype=2`, the right function names + web-resource bind, and `isdisabled=true` on the
  disabled one; torn down clean. ⚠ **Deferred:** conditional (rule-based) visibility + Power Fx
  on-click are Power-Fx-only and need a component library that can't be authored headlessly.
- ✅ **Dashboards** (`dashboards[]` → `createArtifact('dashboard')` + `addDashboardTile`). The SDK's
  tile generator synthesizes chart/list/iframe/webresource `<cell><control>` tiles (chart/list
  reference the views/charts already built); pushed + added to the solution (systemform, type 60).
  ✅ **live-verified on 983a1 (2026-06-21):** a Standard dashboard with a chart + list tile landed
  with 2 cells/controls referencing the created view savedqueryid + chart visualizationId; torn down
  clean. ⚠ **Deferred:** sitemap placement (the dashboard isn't auto-added to the app yet);
  interactive (type 10) dashboards.
- ⛔ **PCF custom controls** (`addCustomControl`) — **DEFERRED** (blocker recorded in
  [`model-app-maker-todo.md`](./model-app-maker-todo.md)). The binding persists only via **solution
  import**; a plain `pushArtifact` strips the control `uniqueid`. Delivering it needs zip surgery
  (export → patch `customizations.xml` → rezip → import) the SDK doesn't package, a new zip dep, and a
  pre-deployed control — not live-verifiable here. Shipping a stripped (non-functional) binding would
  be dead wiring, so deferred until the SDK packages a form artifact into an importable zip.

### SDK uptake, round 2 (2026-06-22) — three former 🟡-deferrals shipped + live-verified
Pulled the latest SDK (rebundled, 3142 KB) for three new helpers, each wired (engine + validator +
lint + tests) and **live-verified on 983a1** via one combined throwaway probe (`Rc3Probe`), torn down
clean. Tests 207 → **222**.
- ✅ **Quick-view placement** — `forms[].quickViews[]` → `sdk.addQuickViewControl(hostFormId, …)` embeds
  a `QuickView` form on a host form via a lookup column (resolved by form name). A forms-phase post-pass
  (fetch → add → push → publish); renders from plain formxml, so no solution import. **Live:** the host
  Main form's formxml carried a `{5C5600E0-…}` QuickViewControl bound to `datafieldname=<lookup>`.
- ✅ **Command flyout / split menus** — `commands[].type: FlyoutAnchor|SplitButton` + `children[]`; the
  adapter synthesizes the *intervening* group (parented to the flyout). **Live:** `More` (FlyoutAnchor)
  → synthesized Group → `Option A`/`Option B`. **Titled groups stay deferred** — re-confirmed the
  from-scratch 400 ("Group button must have parentappactionid") on a fresh entity; the parent
  command-bar row is adapter-internal, so the engine can't supply it. (Despite the SDK note that
  "labeled groups already worked," from-scratch *titled* groups don't — only flyouts do.)
- ✅ **Dashboard → sitemap placement** — a `dashboard` sitemap subarea (`appShell …subAreas[].dashboard`)
  → `{type:'DashBoard', dashboardId}`; the SDK auto-pins the dashboard as an app component (type 60) so
  `ValidateApp` passes. **Live:** the app's sitemap carried a `DefaultDashboard=…` subarea and the
  dashboard was pinned (componenttype 60); app created clean.

### P2 — shippable defaults + breadth
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
