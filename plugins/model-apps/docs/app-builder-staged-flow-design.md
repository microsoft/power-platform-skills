# Design — `/app-builder` staged flow re-architecture

> **Status: PROPOSED.** Awaiting architectural review (Sol 5.6 max, against the
> `cds-maker-sdk` `architecture-spec.md`) and user approval before `writing-plans`.
> This supersedes the phase-model discussion in `app-builder-flow-refinement-design.md`
> (which remains the record for the already-landed R0–R3 refinements). Nothing here
> retires an engine phase or the App Spec contract; the changes are **additive**.

## Why

The build engine is sound — spec-driven, idempotent, `create == edit`, journal-resumable,
510 tests, a parity oracle. But the **flow around it** has five concrete problems:

1. **Mental-model mismatch.** The engine exposes 13 fine-grained phases; the user (and the
   skill narration) thinks in ~6 stages. "Build the pages" maps to three scattered engine
   phases (`app-shell` → `pages`(upload) → sitemap rewrite).
2. **Author codes pages too early.** Forms/views are *declared* in author and *serialized*
   later, but generative pages are **fully coded** (`.tsx`) during author — before the app
   design is approved. Design and implementation are entangled.
3. **Eval gap.** `/app-builder` has exactly one eval (`smoke-eval.js`, a single hardcoded
   live spec). There is no data-driven offline harness like `/genpage`'s
   `evals/model-apps/genpage/`. The 13 phases give no clean fixture boundaries.
4. **No autopilot/consent awareness.** The flow assumes an attended human at every
   `AskUserQuestion`/plan-mode gate. There is no non-interactive path (needed for evals and
   automation), and no explicit fail-closed on destructive operations.
5. **Multi-page apps have no look-and-feel contract and no verified cross-page navigation.**
   Parallel page-builders diverge visually, and cross-page `pageInput` navigation
   (`PAGEREF_` → real GUID) is not resolved by the app-builder engine today.

## Goals

- A **6-stage** user-facing model (`data → pages → ui → app → publish → verify`, preceded by
  a design-only `author` stage) that the loop narrates, gates consent on, and evals assert
  against — **without merging or renaming the 13 engine phases**.
- Author emits a **design-only** App Spec; page `.tsx` is generated in a **distinct stage
  after plan approval**, reusing the `/genpage` page-builder.
- **Mode-aware consent** (interactive vs autopilot/eval), with destructive ops fail-closed.
- **Consistent look-and-feel** across pages and the model-driven shell, and **working
  cross-page navigation** designed up front.
- Evals **fall out** of the stage boundaries: a data-driven offline harness + a thin live tier.

## Non-goals (YAGNI)

- **Not** merging the 13 phases into 6, and **not** renaming any phase (rejected: churns
  ~510 tests, the journal, and `--only`/`--skip`, and loses fine-grained re-run control —
  the stage layer delivers the same UX for near-zero churn).
- **Not** agentizing the deterministic engine. Entity/form/view/app creation stays in
  `sdk-build.js` (idempotent, eval-able). Only page code-gen and edit-planning are LLM agents.
- **Not** rewriting `/genpage`. We reuse its page-builder, its `PAGEREF_` convention, and its
  navigation rules verbatim.

---

## Design invariants

These hold across every part below and are the review contract:

- **The main loop owns judgment + consent + narration.** It is never a `Task` subagent — a
  subagent is headless, so `AskUserQuestion`/plan mode cannot reach the user from inside one.
- **The deterministic engine owns all Dataverse writes.** This is what keeps the build
  idempotent and eval-able. Agents never write to Dataverse.
- **Only two LLM agents exist:** `page-builder` (writes one `.tsx`) and `edit-planner` (reads
  a downloaded app, proposes a diff). Both are reused/adapted from `/genpage`.
- **The 13 engine phases are untouched.** Stages are a thin naming layer over contiguous
  phase ranges, driven by the engine's existing `--from`/`--to`/`--only` support.

---

## Part A — The stage layer (over the 13 phases)

A new `STAGES` map is the only structural addition to the engine surface. Each stage is a
**named, contiguous range of the existing phases** (plus two main-loop-only stages that run
no engine phase). The engine's phase list, `--only forms`, journal event names, and 510 tests
are unchanged.

| Stage | Kind | Owns | Engine phases (range) |
|---|---|---|---|
| **author** | main loop (design-only) | data model + artifacts + **page intent**, lint, consent, plan-mode | *(none — no writes)* |
| **data** | engine | tables, columns, relationships, sample data | `solution` → `data-model` → `sample-data` |
| **pages** | main loop + `page-builder` agents | generate `.tsx` from approved page-intents | *(none — writes files)* |
| **ui** | engine | web-resources, views, charts, forms, commands, dashboards | `web-resources` → … → `dashboards` |
| **app** | engine | app module, sitemap, **page upload + `PAGEREF_` resolve**, AI features | `app-shell` → `pages`(upload) → `ai-features` |
| **publish** | engine | publish customizations | `publish` |
| **verify** | engine | reconcile spec vs deployed (`--verify`) | *(reconcile pass, not a phase)* |

**Ordering is forced by real dependencies:**

- `pages` (code-gen) runs **after `data`** because `pac model genpage generate-types` needs
  **deployed tables** to emit `RuntimeTypes.ts` (verified column names). It runs **before
  `ui`/`app`** so the `.tsx` exists by upload time.
- Page **upload** stays in `app`, **after `app-shell`**, because upload needs the **appid**:
  `genpageCli.upload({ appId: result.created.app, …, codeFile })` (`sdk-build.js`). This is
  the existing "app created without page subareas → upload → sitemap rewrite" dance,
  unchanged.

**Namespace note (deliberate):** the *stage* `pages` = code-gen; the *engine phase* `pages` =
upload (a member of stage `app`). These are different namespaces. We keep the engine phase
name (renaming it churns tests/journal/CLI) and disambiguate in prose and in the `STAGES` map
comments.

### Mechanic — stages are phase ranges the orchestrator already supports

`build-model-app.js` already runs partial pipelines (`--from`/`--to`/`--only`/`--skip`) and is
journal-resumable. So the orchestrator drives the stages as:

```
data  = build-model-app --to sample-data           # engine phases 1–3
pages = (main loop) generate-types + page-builders  # no engine phase
ui    = build-model-app --from web-resources --to dashboards
app   = build-model-app --from app-shell --to ai-features
publish = build-model-app --only publish
verify  = build-model-app --verify   (or folded into the app/publish apply)
```

We add thin sugar — `build-model-app.js --stage <name>` — that maps a stage to its phase range
internally (a table beside `STAGES`). No engine phase logic changes; `--stage` is a convenience
over `--from`/`--to`. The single interleaving point is the `pages` code-gen stage between
`data` and `ui`.

---

## Part B — Author redesign (design-only, per-area consent)

Author stops emitting `.tsx`. It produces a **design-only App Spec** and freezes it through
consent gates, then hands a fully-approved design to the stages.

**Two authoring levels, each consent-gated:**

1. **Level 1 — data model.** Propose tables/columns/relationships → **consent gate #1**
   (`AskUserQuestion`: "data model right?") → **early data-model lint** (already in place, R1)
   → freeze the schema before forms are designed on top of it.
2. **Level 2 — artifacts + page intent.** Propose forms/views/charts, and **pages as intent
   only** (no `.tsx`) → **consent gate #2** (forms/views/pages design).

**Page-intent representation (schema decision):** `pages[].codeFile` becomes **optional**. A
page authored without `codeFile` is an *intent*:

```jsonc
{
  "name": "Overview",
  "purpose": "At-a-glance dashboard of open work",
  "dataSources": ["contoso_workorder", "contoso_account"],
  "sitemapSlot": { "group": "Main", "order": 1 },
  "navigatesTo": [{ "target": "WorkOrderDetail", "data": { "workOrderId": "string" } }],
  "pageInput": { "data": { "workOrderId": "string" } }
  // no codeFile yet — filled by the `pages` stage
}
```

Single page shape (no parallel `pageIntents[]`). `spec-lint.js` gains one rule: **intent-only
pages (no `codeFile`) are valid in design/plan mode; the `app`/upload phase requires
`codeFile`** and fails fast if the `pages` stage was skipped.

**Plan mode stays the single build approval** (R2, unchanged) — the go/no-go before any
Dataverse write. So the consent model is: **2 lightweight design checkpoints** (validate the
design incrementally) **+ 1 build approval**. No approval fatigue — the design gates are
shape-level; there is still exactly one build go/no-go.

---

## Part C — Approval & autopilot (mode-aware consent)

Consent is mode-aware. **Autopilot mode is also eval mode** (both are non-interactive), which
ties this requirement directly to the eval goal.

| Gate | Interactive (attended) — default | Autopilot / eval (unattended) |
|---|---|---|
| Design gate #1 (data model) | `AskUserQuestion` | auto-approve, **journaled** `consent: auto` + design hash |
| Design gate #2 (artifacts + pages) | `AskUserQuestion` | auto-approve, journaled |
| Build approval | plan mode | auto-approve, journaled |
| **Destructive ops** (teardown; edit-mode drops of tables/columns/forms) | explicit confirm | **fail-closed** — halt unless explicit `--allow-destructive` |
| Design artifacts | shown inline | still **written to disk + narrated** for audit |

**Detection.** A `--non-interactive` flag on `build-model-app.js` plus an env var the skill
honors (e.g. `POWER_PLATFORM_SKILLS_NONINTERACTIVE=1`). When set, the main loop swaps
`AskUserQuestion`/plan-mode for **narrated auto-approvals** and emits the design artifacts to
the working dir. Non-destructive create/build proceeds unattended; destructive changes never
happen silently (they require `--allow-destructive`, honored even in autopilot — this is the
one gate autopilot cannot auto-clear).

**Whole-app design preview (the "wireframe").** Today only forms render (`preview-form.js`).
Add `preview-app.js` that renders the **entire** design as the approval artifact: data-model
summary (tables/relationships), sitemap tree, views/charts, per-form wireframes (reusing
`preview-form.js`), **page-intents** (name/purpose/data-sources/navigation), and the **shared
design contract** (Part E). Shown at gate #2 + plan mode when attended; written to disk when
autopilot. The user approves the whole app shape once, not one form at a time.

---

## Part D — Generate-pages stage + agent boundaries

The `pages` stage turns approved page-intents into `.tsx`, after `data` (for `RuntimeTypes`)
and before `ui`:

1. Run `pac model genpage generate-types` against the just-deployed tables → `RuntimeTypes.ts`.
2. For each intent page, dispatch the **`page-builder` agent** (reuse `/genpage`'s — a pure
   code-gen agent: no Bash, no MCP, no questions) with: the page-intent, `RuntimeTypes.ts`,
   the **shared design contract** (Part E), and the **navigation graph** (Part E).
3. Each agent writes one `.tsx`; the orchestrator sets `codeFile` on the spec → build-ready.

**Edit flow.** An **`edit-planner` agent** (reuse/adapt `/genpage`'s) reads the downloaded app
+ change request and proposes a diff; the main loop gets consent; the **same deterministic
engine** applies it idempotently. No new write path.

**Boundary recap.** Main loop = judgment + consent + narration; deterministic engine = all
Dataverse writes; `page-builder` + `edit-planner` = the only LLM agents.

---

## Part E — Multi-page consistency & navigation

### Look-and-feel consistency

Parallel page-builders diverge without a shared contract (`genpage-page-builder.md` flags this
but leaves it implicit). Fix: the **author stage emits one shared design contract** —

```jsonc
"design": {
  "accentColor": "#0f6cbd",
  "density": "comfortable",
  "cornerRadius": "medium",
  "darkMode": "system",
  "layout": "cards"
}
```

— threaded to **every** page-builder in the `pages` stage, and aligned with the model-driven
app theme (both are Fluent UI V9). Result: pages look consistent with each other **and** with
the shell. It appears in the whole-app wireframe (Part C), so the look is approved once for all
pages.

### Cross-page navigation & pageInput

Reuse `/genpage`'s proven contract (`references/rules.md` "Generative Page Navigation") — no
reinvention:

- Navigate via `Xrm.Navigation.navigateTo({ pageType: 'generative', pageId, data })`.
- Custom identifiers go in `data:` (never `recordId`), read as `pageInput?.data?.<key>` on the
  target.
- **Code-gen** (`pages` stage) emits `PAGEREF_<page-key>` placeholders for the `pageId` —
  deployed GUIDs do not exist until after upload (`rules.md` 333–337).

**New engine step (the one genuinely new build piece).** In the `app` stage, **after all pages
upload** (real `genPageId`s known), the engine:

1. builds the `page-name → genPageId` map (already built for the sitemap rewrite),
2. replaces `PAGEREF_<key>` in each page's uploaded code with the resolved GUID,
3. **re-uploads** the patched pages.

This co-locates with the existing sitemap `genPageId` resolution (same map, same timing). It is
**idempotent** (a re-run finds placeholders already resolved) and **offline unit-testable**
(assert `PAGEREF_x → guid` against a fixture). The navigation graph itself is designed in
author (page-intent `navigatesTo` + `pageInput`), so it is explicit, approvable, and a fixture
boundary.

---

## Part F — How evals fall out

Each stage is a fixture boundary, giving a data-driven **offline** harness (modeled on
`/genpage`'s `evals/model-apps/genpage/`: `evals.json` + fixtures + TAP runners) plus a thin
**live** tier (keep `smoke-eval.js`). Autopilot mode (Part C) is what the harness drives.

| Stage | Offline assertion (golden) | Existing primitive |
|---|---|---|
| author | App Spec shape + lint result | `spec-lint.js`, `lintAppSpec` |
| plan | `planFor` phase-grouped plan | `planFor` (dry-run) |
| data | wire-facts after data phases | `wire-facts.js` + `parity-golden.json` |
| pages | generated `.tsx` snapshot + navigation-graph facts (PAGEREF placeholders present) | new snapshot fixture |
| ui | wire-facts (forms/views/charts) | `wire-facts.js` |
| app | sitemap-facts + `PAGEREF_`-resolved facts (placeholders → ids) | new facts extractor |
| verify | reconcile `{ ok, checks, missing }` | `verifySpec` (R3) |

New harness layout (mirrors genpage):

```
evals/model-apps/app-builder/
  evals.json                 # data-driven cases
  fixtures/<case>/           # spec.json, expected plan, expected wire-facts, expected .tsx, sitemap-facts
  run-*.js                   # TAP runners (offline; no live env)
```

---

## Engine mechanics & blast radius

Additive, low-churn. Concretely:

- **`STAGES` map** (new, beside `PHASES` in `sdk-build.js`): `{ data: ['solution','data-model','sample-data'], ui: ['web-resources',…,'dashboards'], app: ['app-shell','pages','ai-features'], publish: ['publish'] }`. `author`, `pages`(code-gen), `verify` are orchestrator-level, not phase ranges.
- **`--stage <name>`** sugar in `build-model-app.js` → resolves to `--from/--to` over the range. Existing flags keep working (`--only forms` unchanged).
- **`pages[].codeFile` optional** in the App Spec schema + `spec-lint.js` rule (intent-only OK in design/plan; required at upload).
- **`preview-app.js`** (new) — whole-app design renderer, reuses `preview-form.js`.
- **`--non-interactive` + `--allow-destructive`** flags (build) + env var (skill) for autopilot/eval.
- **`PAGEREF_` resolver** in the `app` stage's upload path (`sdk-build.js` `pages` phase) — patch code + re-upload, idempotent.
- **Shared design contract** (`spec.design`) threaded to `page-builder`.
- **Journal:** stage boundaries wrap existing phase events (a `stage.start/stage.end` around the phase-range run); phase events unchanged, so precise attribution is retained.
- **Evals:** new `evals/model-apps/app-builder/` harness.

Unchanged: the 13 phase names, phase ordering/idempotency, the App Spec core contract, `--only/--skip`, the parity oracle, `create == edit`.

## Doc-sync checklist (on implementation)

`SKILL.md`, `references/authoring-flow.md`, `docs/architecture.md` (add the stage diagram),
`AGENTS.md`, `CHANGELOG.md`, and the `/app-builder` README section.

## Open decisions (locked unless review says otherwise)

- **`ai-features` stays in the `app` stage** (not a separate stage) — it is app-scoped and runs
  after app-shell.
- **Engine phase `pages` keeps its name** (upload); the code-gen stage is `pages` in the stage
  namespace only.
- **Destructive opt-in flag** is `--allow-destructive` and is honored even in autopilot.
- **Stage `verify`** reuses the R3 `--verify` reconcile; it may run as the tail of the `app`/
  `publish` apply rather than a separate invocation.

## Testing strategy

- **Offline unit tests** for each new piece: `STAGES`/`--stage` range resolution; `codeFile`-
  optional lint rule; `preview-app.js` render; `--non-interactive`/`--allow-destructive` gating;
  the `PAGEREF_` resolver (placeholders → ids). Target: keep the suite green (currently 510).
- **New data-driven offline harness** (`evals/model-apps/app-builder/`) asserting the per-stage
  goldens above.
- **Live tier:** keep `smoke-eval.js`; add a multi-page case to cover navigation resolution end
  to end on a real env.
