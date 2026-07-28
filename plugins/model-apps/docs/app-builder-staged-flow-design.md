# Design — `/app-builder` staged flow architecture

> **Status: IMPLEMENTED / LANDED.** This is the design record for the `/app-builder` staged-flow
> architecture that shipped — the engine now runs it (staged flow, design-only author, generate-pages
> stage, structural evals, fail-closed safety). It began as a re-architecture proposal (revised after
> Sol architectural review R1; the four Critical findings were verified against the engine code and
> resolved — see **§17 Sol R1 → resolutions**) and was subsequently implemented, reviewed, and
> live-verified. It is retained as the **design rationale** the engine's code cites by section (§6, §7,
> §9, §11, §13, §14); the section numbers are load-bearing — keep them stable.
>
> **Current status of shipped/pending capabilities lives in [`app-builder-roadmap.md`](./app-builder-roadmap.md)**
> (the canonical roadmap), not here — this doc is the "why", the roadmap is the "what/where". The
> `--changed-only` partial-apply mode built ON TOP of this staged flow has its own contract in
> [`changed-only-design.md`](./changed-only-design.md).
>
> The App Spec **core** contract and the 13 engine phase names are unchanged; the staged flow is an
> additive naming/orchestration layer over them.

## 1. Why

> *This section is the original motivation (pre-implementation). All five problems below were
> addressed by the design that landed — see the roadmap for current status.*

The build engine is sound — spec-driven, idempotent, `create == edit`, a large regression suite, a
parity oracle. But the **flow around it** had five concrete problems:

1. **Mental-model mismatch.** The engine exposes 13 fine-grained phases; the user and the skill
   narration think in ~6 stages. "Build the pages" maps to three scattered phases
   (`app-shell` → `pages`(upload) → sitemap rewrite).
2. **Author codes pages too early.** Forms/views are *declared* in author and serialized later,
   but generative pages are **fully coded** (`.tsx`) during author — before the design is
   approved. Design and implementation are entangled.
3. **Eval gap.** `/app-builder` has one eval (`smoke-eval.js`, a single hardcoded live spec). No
   data-driven offline harness like `/genpage`'s `evals/model-apps/genpage/`.
4. **No autopilot/consent awareness, and destructive ops are not fail-closed.** The flow assumes
   an attended human at every gate; there is no non-interactive path (needed for evals), and
   updates already prune form fields and replace sitemaps with only a warning.
5. **Multi-page apps have no look-and-feel contract and no verified cross-page navigation.**
   Parallel page-builders diverge visually, and cross-page `pageInput` navigation
   (`PAGEREF_` → real GUID) is not resolved by the app-builder engine today.

## 2. Goals

- A **6-stage** user-facing model (`data → generate-pages → ui → app → publish → verify`,
  preceded by a design-only `author` stage) for narration, consent, and evals — **without
  merging or renaming the 13 engine phases**.
- Author emits a **design-only** App Spec; page `.tsx` is generated in a distinct stage **after**
  plan approval and **after** tables are deployed, reusing the `/genpage` page-builder.
- **Mode-aware consent** (interactive vs autopilot/eval) with destructive ops **fail-closed**.
- **Consistent page look-and-feel** and **working, portable cross-page navigation** designed up
  front.
- Evals **fall out** of the stage boundaries via **structural** (not snapshot) oracles.

## 3. Non-goals (YAGNI)

- **Not** merging or renaming the 13 phases (churns ~510 tests/journal/`--only`; loses fine
  re-run control). The stage layer delivers the UX for near-zero phase churn.
- **Not** agentizing the deterministic engine. Entity/form/view/app creation stays in the engine.
- **Not** rewriting `/genpage`. We reuse its page-builder core, its `PAGEREF_` convention, and
  its navigation rules — adapting the agent *contracts* (§8, §11) rather than the code-gen logic.

---

## 4. Design invariants (the review contract)

- **The main loop owns judgment + consent + narration.** It is never a `Task` subagent — a
  subagent is headless, so `AskUserQuestion`/plan mode cannot reach the user from inside one.
- **The deterministic engine owns all Dataverse writes** and **never dispatches an LLM agent.**
  Agents are dispatched *only from the main loop*, as **headless workers** (§8). This keeps the
  build idempotent and eval-able.
- **Only two LLM agents exist:** `page-builder` (writes/edits one page's `.tsx`) and
  `edit-planner` (headless analyzer of a downloaded app). Both are adapted from `/genpage`.
- **The 13 engine phases keep their names and order.** Stages are a naming/orchestration layer.

---

## 5. Execution model (corrected — resolves Critical C1)

**Why the first draft was wrong.** `runSdkBuild` allocates a **fresh** `result.created` map on
every invocation (`sdk-build.js:540`). Downstream phases resolve dependencies from that
in-memory map, not from Dataverse: table icons skip a table not built *this run*
(`sdk-build.js:587-599`); `appDef` reads `result.dashboards`/`pages`/`forms`/`views`/`charts`
for sitemap subareas and pinned components (`sdk-build.js:493-518`). So running `ui` and `app`
as **separate `--from/--to` process invocations would lose IDs or throw**. My original mechanic
was unsound.

**The corrected pipeline** runs the write phases as **one full idempotent build**, with only a
minimal data pre-build ahead of code-gen:

```
author        (main loop)      design-only App Spec, consent, plan-mode approval
   │
data pre-build (engine, run 1)  build --stage data --apply   → tables exist (for type-gen)
   │
generate-pages (main loop)      generate-types + page-builder agents → fill page source (.tsx)
   │
full build     (engine, run 2)  build --apply (FULL, idempotent) → ui + app + publish + verify
```

- **Two engine invocations only.** Run 1 materializes tables so `pac model genpage
  generate-types` can emit `RuntimeTypes.ts`. Run 2 is a **full** build: it re-discovers the
  tables (rehydrating `result.created.entities`), then builds web-resources/views/charts/forms/
  commands/dashboards, creates the app, uploads pages, resolves `PAGEREF_`, finalizes the
  sitemap, publishes (opt-in), and verifies.
- **`result.created` integrity is preserved** because run 2 is a full run: every phase discovers
  existing artifacts and repopulates `result.created` (existing web resource → recorded at
  `:570-573`; the same discover-and-record pattern rehydrates entities/forms/views/charts/
  dashboards). **This is the exact path that already makes `create == edit` work** — an edit is a
  full idempotent rebuild — so it is proven, not new.
- **Parity by construction (answers the reviewer's parity test).** Run 2 *is* today's monolithic
  full build; run 1 is an idempotent **prefix** (solution + data-model only). Because `data-model`
  is discover-reconcile — as are forms/views/charts (`sdk-build.js:782-786,835-838`) — run 1's
  tables are transparently rediscovered by run 2, which then does everything else (including
  `sample-data`) **exactly once**. So run 1 + run 2 reach the **identical** end state as one
  monolithic build. (Dashboards/commands are re-created rather than reconciled on a rebuild — a
  *pre-existing* idempotency nuance at `sdk-build.js:966-975,951-958` — which §14 fixes so a
  full-build retry stays idempotent.) Only the no-write main-loop code-gen sits between the runs.
- **Simpler than the reviewer's per-range rehydration context.** We reuse the proven full-rebuild
  discovery instead of adding a bespoke rehydrator per phase-range. The cost is that run 2 re-runs
  data-model *discovery* (a few metadata reads, no writes) — acceptable and DRY.
- **LLM code-gen stays in the main loop, between the two engine runs** (invariant §4). The engine
  never awaits an agent.

Stages are therefore a **vocabulary and orchestration layer**, not independent write
invocations. `data` executes in run 1; `generate-pages` in the main loop; `ui`/`app`/`publish`/
`verify` are phase groups **within run 2**.

---

## 6. Stages (the vocabulary over the execution model)

| Stage | Executes in | Owns | Engine phases |
|---|---|---|---|
| **author** | main loop | design-only spec, lint, consent, plan-mode | *(none)* |
| **data** | run 1 (schema) + run 2 (rows) | tables, columns, relationships, sample data | `solution`→`data-model` (run 1); `sample-data` (run 2) |
| **generate-pages** | main loop + agents | `RuntimeTypes` + page `.tsx` (symbolic, `PAGEREF_`) | *(none — writes files)* |
| **ui** | run 2 (engine) | web-resources, views, charts, forms, commands, dashboards | `web-resources`…`dashboards` |
| **app** | run 2 (engine) | app module, sitemap, **page upload + `PAGEREF_` resolve** | `app-shell`→`pages`(upload)→`ai-features` |
| **publish** | run 2 (engine) | publish (opt-in) | `publish` |
| **verify** | run 2 or standalone | reconcile spec vs deployed (**incl. pages**) | *(reconcile pass)* |

**Renamed** from the first draft: the code-gen stage is **`generate-pages`**, never `pages` — the
engine phase `pages` (upload, a member of stage `app`) keeps its name, and using one word for
both was ambiguous (reviewer Minor 2). **One namespace** is used for stage names across
narration, journal, and CLI.

**`--stage <name>` sugar** on `build-model-app.js` maps a stage to its phase range internally
(over the existing `--from/--to`). Run 1 uses `--stage data` **without `--sample-data`** (solution +
data-model only); sample rows are created once in run 2 (§14), so the `data` stage's schema lands in
run 1 and its rows in run 2. **Run 2 is a full build**, not a `--from` range, per §5. Unknown
stage/phase selectors are **rejected** (today `resolvePhases` silently ignores unknown endpoints,
`sdk-build.js:191-198` — tightened to error).

---

## 7. Author redesign & App Spec schema (resolves C2, I1)

Author stops emitting `.tsx`. It produces a **design-only** spec and freezes it via consent gates
(two shape-level design checkpoints + the single plan-mode build approval, R2 unchanged).

### 7.1 Validation profiles (resolves C2)

`validateAppSpec` is currently unconditional and requires every page's `codeFile`
(`build-model-app.js:98`, `app-spec.js:431-438`), so an intent-only spec fails before the first
write. Introduce **profiles**:

- **`design`/`plan`** — pages may be intent; `codeFile` not required. Validates intent fields,
  **unique stable keys**, navigation `targetKey`s resolve to known pages, design-contract shape,
  and `appShell` page references resolve. `planFor` must plan pending page implementations.
- **`deploy`** — every page must be implemented (`source.kind === 'tsx'` with a workspace-confined
  `codeFile`); all `PAGEREF_` targets resolvable. Run 2 uses `deploy` and **fails fast** if any
  page is still intent (i.e., `generate-pages` was skipped).

**Profile per caller** (every `validateAppSpec` call site takes an explicit profile — none stays
unconditional; `build-model-app.js:97-101`, `teardown-model-app.js:62-65`, `verify-model-app.js:59-65`):

| Caller | Profile |
|---|---|
| author plan / full dry-run (`planFor`) | `plan` |
| run-1 data apply (`--stage data`) | `plan` (pages still intent) |
| run-2 full apply + verify | `deploy` |
| teardown / partial cleanup | `structural` (no `codeFile` required) |
| default programmatic build | `deploy` |

### 7.2 Page shape — discriminated source (resolves I1, C4 key ambiguity)

One `pages[]` collection; implementation state is **explicit**, not a nullable field:

```jsonc
{
  "schemaVersion": 2,
  "pages": [{
    "key": "overview",                       // STABLE, unique — the only cross-reference id
    "name": "Overview",
    "purpose": "At-a-glance dashboard of open work",
    "dataSources": ["contoso_workorder"],
    "navigatesTo": [{ "targetKey": "wo-detail", "data": { "workOrderId": "string" } }],
    "pageInput": { "data": { "workOrderId": "string" } },
    "source": { "kind": "intent" }           // → { "kind": "tsx", "codeFile": "overview.tsx" }
  }]
}
```

- **Stable `key`** is the single identity used by `navigatesTo.targetKey`, `PAGEREF_<key>`, and
  `appShell` subareas — eliminating the reviewer's key/filename/display-name mixing (C4).
- **`sitemapSlot` is dropped** (reviewer I1): placement lives only in `appShell` (the authoritative
  sitemap model), whose page subareas reference the page **`key`** (`appDef` resolves key →
  `genPageId`, adapting `sdk-build.js:497-506`). Single source of truth.
- **`schemaVersion`** gates the new shape; loaders reject unknown versions.
- **Path confinement:** `codeFile` must resolve inside the working dir (no `..`/absolute escape;
  today it is resolved arbitrarily at `sdk-build.js:1037-1041`). Duplicate key/name/path are
  rejected.

### 7.3 Round-trip (download → edit → rebuild)

`download-model-app.js`/`hydrate-spec.js` currently retain only name/dataSources/prompt/codeFile
(`hydrate-spec.js:61-66`) and lose keys/intent; PAC lists pages by **name** (not key) and
`download` returns **resolved, GUID-bearing** source (`download-model-app.js:86-106`). Stable-key
persistence is therefore **foundational**, and the mechanism is **decided** (not left open):

- **Durable page manifest (versioned).** The `app` stage writes a `<app>_pagemanifest` web resource
  carrying the full design-time metadata — `{ schemaVersion, pages: [{ key, name, pageId, purpose,
  dataSources, navigatesTo, pageInput }], design }` — not just id/name, so the round-trip below
  actually restores purpose/navigation/design. It travels inside the solution and survives download.
- **Lifecycle is explicit.** On first build the manifest web resource is created; its **solution
  membership is re-asserted every run** (idempotent add, not only on first creation); on rebuild its
  content is **updated in place** via `updateWebResource` (`MakerSdk.ts:529-543`) — the engine today
  reuses an existing web resource *without* updating its content (`sdk-build.js:565-580`), so the
  manifest needs the update path, not plain reuse. `planTeardown` removes it (it currently deletes
  only the app icon, `sdk-teardown.js:338-348`).
- **`pageId`s are validated deployment state, not blind portable identity.** Manifest ids are
  environment-specific and can be stale after import to another env, so they are **reconciled against
  the fail-closed current-app enumeration** (§9) before use — the manifest keeps `key ↔ name`
  durable (so a display-name change never orphans a page), while the *deployed* id is confirmed live
  each run.
- **Canonical symbolic source is retained** in the working dir / app-spec sidecar (the `.tsx` with
  `PAGEREF_<key>`); the resolved deployment derivative is never written back over it.
- **Download reconstructs keys** from the manifest and **reverse-normalizes** sibling page-GUID
  literals in downloaded source back to `PAGEREF_<key>`; absent a manifest (legacy app), it falls
  back to name matching and assigns fresh keys. Downloaded pages hydrate as `source.kind === 'tsx'`.
- **Migration:** specs without `schemaVersion`/keys (name-referenced) are upgraded on load — keys
  minted from names, `navigatesTo`/`appShell` references rewritten name→key.

---

## 8. Generate-pages stage & agent contracts (resolves I2)

After run 1 (tables exist), the **main loop**:

1. runs `pac model genpage generate-types` → `RuntimeTypes.ts`;
2. for each intent page, dispatches the **`page-builder`** worker with a **generated per-page
   build contract** (see below), `RuntimeTypes.ts`, the **page design contract** (§10), and the
   **navigation graph** (targets + `data` shapes);
3. **validates every generated page** (compile/structure + verified columns + navigation, §13)
   **before** committing the `source` transition intent→tsx. Commit is all-or-nothing.

**Agent-contract adaptations** (the reused agents do not fit as-is):

- **`page-builder`** today requires a `genpage-plan.md` contract (`genpage-page-builder.md:24-51`).
  The generate-pages step **generates that contract** from the page-intent (a stable, generated
  plan input), so the page-builder's code-gen core is reused unchanged. It must own **both**
  new-page and page-code **edit** generation (for the edit flow).
- **`edit-planner`** today asks questions and enters plan mode itself, handles one page, and
  rejects schema edits (`genpage-edit-planner.md:10-49,94-116`). It becomes a **headless analyzer**
  with **no consent tools**: it returns a proposed diff; the **main loop** gathers requirements and
  approves; **schema edits are handled by the main-loop author**, not the page edit-planner.
- **`/app-builder` SKILL `allowed-tools`** gains the `Task` dispatch tool so the main loop can
  dispatch these **headless workers**. This does **not** violate the "interactive steps stay in the
  main loop" rule — the interactive author never runs inside a subagent; only the pure code-gen
  workers are dispatched.

---

## 9. Cross-page navigation & the `PAGEREF_` resolver (resolves C4)

Reuse `/genpage`'s navigation contract (`references/rules.md` 299–356): navigate via
`Xrm.Navigation.navigateTo({ pageType:'generative', pageId, data })`; custom ids go in `data:`
(never `recordId`), read as `pageInput?.data?.<key>`.

**Source stays symbolic.** Code-gen emits `PAGEREF_<page-key>` and the **canonical `.tsx` is never
mutated** with a GUID (mutation would bake environment-specific ids into source and break
cross-env deploy / recreate — reviewer C4, SDK **T5** opaque-identity). Because `genpageCli.upload`
takes a **file path**, not in-memory content (`genpage-cli.js:77-86`), the resolver writes a
**staging file** (a deployment copy adjacent to `RuntimeTypes.ts`); the canonical source is left
untouched.

**Deployment protocol (safe recovery — new Critical from R2).** `listPages` currently turns any PAC
failure into `[]` (`genpage-cli.js:67-70`), which the engine treats as "no pages" — risking
duplicates and orphans. The `app` stage instead:

1. **Enumerate fail-closed** — page listing retries and **distinguishes failure from empty**; a
   failed enumeration halts (never "no pages exist"). Seed the `key → pageId` map from the durable
   manifest (§7.3) first.
2. **Create only absent pages** (no known `pageId`) by uploading their symbolic source to mint ids —
   brand-new pages have no live navigation to disturb. Persist each returned `key → pageId` to
   pipeline state **and the manifest immediately**.
3. Once **all** ids are known, **resolve** the graph (validate every `PAGEREF_<key>`; fail on any
   dangling target) and write per-page **staging files** with GUIDs substituted.
4. **Upload resolved content exactly once** per page (existing pages get their resolved content in a
   single update — no symbolic intermediate that could break live nav).
5. **Finalize the sitemap** (`sdk-build.js:1045-1054`) — the true commit point, only after all
   resolved uploads succeed.

- **Recovery is forward-only idempotent recompute:** a re-run re-seeds ids from the manifest,
  re-resolves, and re-uploads deterministically (no rollback).
- **Pure resolver module** `pageref-resolver.js` (`(sources, keyMap) → deploymentSources`) is
  unit-tested offline (dangling-target failure, stable substitution) (§14).

---

## 10. Look-and-feel: a **page** design contract (resolves I5)

`appDef` has no theme field or mutation (`sdk-build.js:516-518`), so a `spec.design` cannot drive
the model-driven shell today. Scope honestly:

- **v1: `spec.design` is a *page* design contract** (accent, density, corner radius, dark-mode
  policy, layout) threaded to **every** page-builder → pages are consistent **with each other**.
- **Shell alignment is achieved by targeting the same Fluent UI V9 tokens the shell uses**, via a
  documented **semantic-value → Fluent-token** mapping table; generated pages are **validated** for
  token conformance (§13). We do **not** claim to write the app theme.
- **Future (optional):** a supported `appDef` theme read/write mapping — deferred until the SDK
  exposes it; called out as an extension point, not v1 scope.

---

## 11. Safety & autopilot — fail-closed destructive ops (resolves C3)

Consent is mode-aware; **autopilot mode is also eval mode** (both non-interactive).

**The problem the first draft missed:** `--allow-destructive` was not tied to any real diff, and
`--non-interactive` on the CLI cannot gate main-loop questions. Meanwhile updates already remove
content — collision is warning-only (`build-model-app.js:111-119`), explicit-form fields are
pruned (`sdk-build.js:690-725`), and the sitemap is fully replaced (`:995-1007`); teardown is
gated by `--apply` alone (`teardown-model-app.js:62-95`).

**The fix — a read-only operation-diff planner (`op-diff.js`, new pure module):**

- **Read-only classification, reusing existing logic** — not a duplicate differ. Diff the spec
  against discovered artifacts via the same reconciliation the build uses (and the SDK's generic
  `diffArtifact`), so the planner can't drift from build behavior.
- **v1 scope = the realistically detectable destructive ops** (do **not** claim table/column/form
  *deletion* classification — the build has no such delete path today):
  - **unexpected app collision** (see below);
  - **explicit-layout form-field removals** (`sdk-build.js:690-725`);
  - **sitemap target removals** (`:995-1007`);
  - **all `planTeardown` operations** — already a pure plan (`sdk-teardown.js:269-358`).
- **Collision is scoped, not blanket.** Existing *solutions* (including Default) and the run 1 →
  run 2 sequence are normal, so solution existence must **not** fail unattended. Bind approval to
  **pipeline-owned ids**; fail only on an **unexpected app collision** or an **incompatible solution
  identity**.
- **Hard gate + TOCTOU:** any destructive op without `--allow-destructive` **halts before writes**
  (incl. teardown). Recompute the diff **immediately before apply** so a state change between plan
  and apply can't slip through.
- **Approval binding:** bound to **env/app identity + spec hash + op hash**; not replayable against a
  different target.
- **Env var suppresses questions only** — never grants destructive authority; `--allow-destructive`
  is always explicit, even in autopilot.

| Gate | Interactive | Autopilot / eval |
|---|---|---|
| Design gates #1/#2, build approval | `AskUserQuestion` / plan mode | auto-approve, **journaled** (design + op hash) |
| Destructive ops | explicit confirm | **fail-closed** unless `--allow-destructive` |
| Collision on create | confirm | **fail** (no silent update) |
| Design artifacts | shown inline (`preview-app.js`, §12) | written to disk + narrated |

## 12. Whole-app design preview (`preview-app.js`, new)

Today only forms render (`preview-form.js`). `preview-app.js` renders the **entire** design as the
approval artifact: data-model summary, the `appShell` sitemap tree, views/charts, per-form
wireframes (reusing `preview-form.js`), **page-intents** (purpose/data-sources/navigation graph),
and the **page design contract**. Shown at design gate #2 + plan mode when attended; written to the
working dir when autopilot. The user approves the whole app shape at once.

---

## 13. Verify & evals (resolves I3, I4)

### 13.1 Verify extended to pages (I4)

`verifySpec` has no `sa.page` branch and never checks page content or unresolved `PAGEREF_`
(`verify-spec.js:39-67`); a verify that can't run is only a warning (`build-model-app.js:161-175`).
Add strict page checks — page exists, `GenPageId` bound in the sitemap, and (crucially) **every
navigation edge resolves to the *actual* target page's `GenPageId`**, not merely "no `PAGEREF_`
text remains" (a stale/wrong GUID has no placeholder yet is still broken). This needs the verify
reader to list/download page content (`verify-model-app.js:40-46` lacks it today). Make the
**`verify` stage mandatory and fail-closed** — it fails if verification cannot run.

### 13.2 Structural eval oracles — not `.tsx` snapshots (I3)

LLM page output is non-deterministic, so exact snapshots are the wrong oracle (genpage evals
already grade structurally: `EVAL_GUIDE.md:43-103`). Per-stage offline oracles:

| Stage | Assertion (deterministic) | Primitive |
|---|---|---|
| author | spec shape + lint + profile validation | `spec-lint.js`, validation profiles |
| plan | phase-grouped plan | `planFor` (deterministic for fixed spec/opts) |
| data | **normalized schema-call facts** (create table/column/relationship) | **new `schema-facts` extractor** (wire-facts covers forms/views/charts/sitemap only, `wire-facts.js:34-99`) |
| generate-pages | navigation-graph validity + exact quoted `PAGEREF_<key>` facts; no dangling targets; TS compile/structure; **verified DataAPI columns vs `RuntimeTypes.ts`**; design-token conformance; no forbidden patterns | new page-facts checks |
| ui | normalized wire-facts | `wire-facts.js` |
| app | sitemap-facts + **`PAGEREF_`-resolved facts** (`key`→id) | `pageref-resolver.js` + facts |
| verify | reconcile `{ ok, checks, missing }` incl. pages | `verifySpec` (extended) |

Harness mirrors genpage (`evals/model-apps/app-builder/`: `evals.json` + fixtures + TAP runners),
driven in autopilot mode. Keep `smoke-eval.js` as a thin live tier; add a multi-page live case for
navigation resolution end-to-end.

---

## 14. Engine mechanics & module extraction (resolves I6)

`sdk-build.js` is ~1099 lines; the precedent for pure modules is `artifact-intent.js`. Extract:

- **`stages.js`** — stage registry + stage→phase-range map + stage metadata; unknown-selector
  rejection.
- **`pageref-resolver.js`** — pure `PAGEREF_` deployment resolver (§9).
- **`op-diff.js`** — read-only destructive-op classifier (§11).
- **validation profiles** — extend `app-spec.js` with `design`/`plan`/`deploy` (§7.1).
- **`schema-facts.js`** — normalized data-model provisioning extractor for evals (§13.2).

**Pipeline metadata.** The journal is diagnostic, not a replay checkpoint (`build-journal.js:1-5`),
and each CLI run opens a separate journal (`build-model-app.js:232-236`). Add a **pipeline id**
spanning run 1 + code-gen + run 2, with **stage-attempt metadata** (design hash, code hash,
prerequisite enforcement: "run 2 refuses to start unless every page is implemented"). Recovery
remains **idempotent recomputation**, not journal replay. Commit the `intent→tsx` transition only
after all pages validate (§8).

**No cross-run DAG (R2).** `generate-pages` (main loop) must fully complete **before** the single
full run 2; running `ui` concurrently would require splitting/pausing run 2 and revives C1. For v1
the only parallelism is **within** a stage (page-builders run in parallel; the engine already
parallelizes independent artifacts).

**`--stage` is apply-safe only for `data`.** Other stage selectors are **dry-run-only or rejected**
(their phase ranges aren't dependency-closed — e.g. `--stage publish --apply` would publish against
an empty result map, `sdk-build.js:1083-1093`). The pipeline is exactly:

```
run 1:  build --stage data --apply            # solution + data-model only (NO --sample-data)
code-gen (main loop)
run 2:  build --apply --verify [--sample-data] [--publish]   # the full monolithic build
```

Run 1 **omits `--sample-data`** so sample rows are created **once** in run 2 (dedup via `matchOn` is
conditional — `matchOn` can be absent, `entity-provision.js` — so running sample-data twice is not
safe).

**Retry idempotency fix (R2/R3).** Because full-build re-run is the recovery mechanism, commands and
dashboards — today **re-created without discovery** (`sdk-build.js:951-975`) — must become
**discover-reconcile** (`findArtifact`/`fetchArtifact` + generic mutations by a **stable child
identity** — commands need an explicit stable `key`, since the command schema today has `label`, not
`name` (`app-spec-schema.md:234-243`); dashboard tiles keyed by tile identity), or a retried run 2 duplicates them. **v1 is
additive-only** (discover, add what's missing, **never remove**) so reconciliation cannot strip
Maker-authored commands or dashboard tiles. Spec-driven *removal* of a command/dashboard/tile is
deferred and, if added later, routes through `op-diff` destructive consent (§11) — exactly like
explicit-form field pruning. This is a tightly-coupled correctness fix, in scope here.

## 15. Blast radius / unchanged

**Unchanged:** the 13 phase names + order + idempotency, the App Spec **core** contract,
`--only/--skip`, `create == edit`, the parity oracle, the generic SDK mutation surface (no new
artifact-specific SDK mutator — SDK **T2/T7 pass**).

**New/changed:** `stages.js`, `pageref-resolver.js`, `op-diff.js`, `schema-facts.js`,
`preview-app.js`; validation profiles + `schemaVersion`/discriminated page source + stable keys in
`app-spec.js`/`app-spec-schema.md`; `appDef` resolves sitemap page subareas by **key** and drops
`sitemapSlot`; `verifySpec` page checks; `--stage`/`--non-interactive`/`--allow-destructive` flags
+ pipeline id in the CLI/journal; adapted genpage agent contracts + `Task` in the SKILL
`allowed-tools`; round-trip metadata in `download-model-app.js`/`hydrate-spec.js`.

## 16. Doc-sync checklist (expanded — Minor 1)

`SKILL.md`, `references/authoring-flow.md`, `references/app-spec-schema.md`,
`docs/architecture.md` (stage diagram), `AGENTS.md`, `CHANGELOG.md`, the README section, **plus the
contract/round-trip/agent files most affected**: `app-spec.js`, `hydrate-spec.js`,
`download-model-app.js`, `verify-spec.js`, the genpage agent/plan contracts, and the eval docs.

---

## 17. Sol R1 → resolutions

| # | Finding | Resolution |
|---|---|---|
| **C1** | Phase ranges not composable across invocations (`result.created` per run) | §5 — data pre-build → code-gen → **one full idempotent build**; run 2's discovery rehydrates `result.created` (the proven `create==edit` path). Stages are vocabulary, not write invocations. |
| **C2** | Intent spec fails validation; `--verify`/`--only publish`/data examples are no-ops | §7.1 validation **profiles** (`design`/`plan`/`deploy`); standalone verify via `verify-model-app.js`; §6 correct stage→command mapping with required flags. |
| **C3** | Destructive ops not fail-closed | §11 read-only **`op-diff.js`** planner; hard `--allow-destructive` gate incl. teardown; create fails on collision; approval bound to env/app/spec-hash/op-hash; env var suppresses questions only. |
| **C4** | `PAGEREF_` source mutation not portable/idempotent | §9 stable `key`; **symbolic source preserved**; **staging-file** deployment derivative; fail-closed enumeration + create-absent-first + single resolved upload; pure `pageref-resolver.js`; sitemap-finalize commit; forward-only recovery. |
| **I1** | Bare optional `codeFile` weakens contract | §7.2 discriminated `source:{intent|tsx}` + `schemaVersion` + stable keys + path confinement + duplicate checks; `sitemapSlot` dropped (appShell authoritative). |
| **I2** | Reused agents don't fit the boundary | §8 generate a page-build contract for `page-builder` (owns new+edit); `edit-planner` becomes headless (no consent tools); add `Task` to SKILL `allowed-tools`. |
| **I3** | `.tsx` snapshots are the wrong oracle | §13.2 structural/compile/nav/verified-column/token oracles; new `schema-facts` extractor for data-model. |
| **I4** | Verify doesn't cover page invariants | §13.1 page existence/`GenPageId`/no-unresolved-`PAGEREF_` checks; verify stage mandatory + fail-closed. |
| **I5** | Shell-theme alignment unsupported | §10 scope `spec.design` to a **page** contract + Fluent-token mapping + validation; shell theme deferred. |
| **I6** | Stage state / perf / module ownership | §14 pipeline id + stage-attempt metadata; extract `stages.js`/`pageref-resolver.js`/`op-diff.js`/`schema-facts.js`; reject unknown selectors; **DAG removed** (single full run 2). |
| **Minor 1/2** | Doc-sync gaps; 6-vs-7 stage ambiguity | §16 expanded doc-sync; §6 rename to `generate-pages`, one namespace, author counted as the design stage. |

### 17.1 Sol R2 (confirming pass) → resolutions

R2 **verified C1 sound** (run 2 rehydrates every `appDef` dependency, incl. existing pages) and
passed I2/I3/I5 + both Minors. The remaining PARTIALs + new findings are closed as:

- **New Critical — safe page deployment/recovery** → §9 protocol (staging files; fail-closed
  enumeration; create-absent-first + immediate manifest persist; single resolved upload;
  sitemap-finalize commit).
- **Execution-semantics contradiction (DAG vs single run 2)** → §14: DAG removed; `--stage`
  apply-safe only for `data`; run 1 omits `--sample-data`.
- **Safety-plan realism** → §11: v1 scope limited to detectable ops; reuse reconciliation /
  `diffArtifact`; scoped (not blanket) collision; TOCTOU re-check.
- **Stable-key persistence (foundational)** → §7.3: durable `<app>_pagemanifest` web resource +
  download reverse-normalization + legacy migration.
- **Full-build retry idempotency** → §14: commands/dashboards become discover-reconcile.
- **Validation/verification boundaries** → §7.1 per-caller profile matrix; §13.1 verify each nav
  edge → actual target `GenPageId`.

**R3 (convergence pass)** confirmed the execution model sound and closed the last two items: the
**page manifest** is now a versioned durable contract with full semantic metadata + an explicit
create/update/add-to-solution/teardown lifecycle + `pageId`s validated against enumeration (§7.3),
and **command/dashboard reconcile** is **additive-only** in v1 with removals deferred to `op-diff`
(§14).

## 18. SDK-alignment (target after rework)

- **T1 canonical desired state** — restored: `sitemapSlot` dropped (single source = `appShell`);
  canonical page source stays symbolic (no env-specific GUIDs).
- **T2/T7 generic mutation** — pass (no new artifact-specific SDK mutator).
- **T5 opaque identity** — restored: GUID substitution confined to a deployment derivative.
- **T6 serializer boundary** — sitemap finalize stays `updateElement('/siteMap')`; no raw XML side
  channel.
- **App Spec / idempotency / create==edit** — restored via §5 full-rebuild execution + preserved
  design/navigation metadata (§7.3).

## 19. Open decisions

- **`ai-features`** stays inside the `app` stage (app-scoped, after app-shell).
- **`op-diff.js` v1 scope** (decided, §11): unexpected-app collision, explicit-layout form-field
  removals, sitemap-target removals, and `planTeardown` ops — reusing existing reconciliation /
  `diffArtifact`. Table/column/form *deletion* is **out of scope** until the build supports it.
- **Round-trip persistence** (decided, §7.3): a durable `<app>_pagemanifest` web resource (not an
  ephemeral sidecar), plus retained canonical symbolic source and download reverse-normalization.

## 20. Testing strategy

- **Offline unit tests** per new module: `stages`/`--stage` resolution + unknown-selector rejection;
  validation profiles; discriminated-source lint; `op-diff` classification; `pageref-resolver`
  (`PAGEREF_<key>`→id, dangling-target failure); `preview-app` render; `verifySpec` page checks;
  `schema-facts` extractor. Keep the suite green (currently 510).
- **A staged-vs-monolithic parity test** (reviewer C1): the two-invocation pipeline must produce the
  same deployed state as a single full build.
- **Data-driven offline harness** (`evals/model-apps/app-builder/`) with the §13.2 oracles.
- **Live tier:** keep `smoke-eval.js`; add a multi-page navigation case.
