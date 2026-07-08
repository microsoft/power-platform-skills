---
name: model-app-maker
version: 0.6.0
description: (Preview) Builds and edits a model-driven Power Apps app from a natural-language intent — tables, columns, relationships, adaptive forms with sub-grids, views, Choice-column charts, generative pages (genpage-first) for overview/dashboard surfaces, and an app module + sitemap — via the headless cds-maker-sdk. Runs an interactive, multi-turn authoring flow (env selection, App Spec authoring, guardrail lint, plan-mode approval) and a narrated build, and can download a deployed app back into an editable spec to change it. Use when the user says "build an app for X", "create a model-driven app", "make me an app to manage Y", or "edit/add to my app". For a standalone generative page that is not part of an app, use /genpage.
author: Microsoft Corporation
argument-hint: "<app description>"
user-invocable: true
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, AskUserQuestion, EnterPlanMode, ExitPlanMode, TaskCreate, TaskUpdate, TaskList
---

# model-app-maker — intent → model-driven app

> ⚠️ **Preview.** This skill is in preview — its App Spec shape, flags, and build behavior may change
> between versions. Review the plan-mode summary before applying, and prefer a non-production
> environment while it stabilizes.

Turn a natural-language intent into a deployed model-driven app. You author a reviewable
**App Spec** (JSON) with the user across confirmed turns, then a deterministic engine
(`cds-maker-sdk`, vendored) builds it — tables/columns/relationships, sample data, views,
Choice-column charts, adaptive forms with sub-grids, **generative pages** for overview/dashboard
surfaces, and the app module + sitemap. The **same spec drives create and edit**: download a
deployed app back into a spec, change it, and re-run the build (it's idempotent).

## CRITICAL — run the interactive flow in THIS conversation (the main loop)

> **You MUST run the authoring questions and the build narration yourself, in the main
> conversation. Do NOT dispatch a subagent (`Task`) for the interactive steps.**
>
> A subagent is headless — `AskUserQuestion` and plan mode do not reach the user from
> inside one (a `Task` subagent's only output is its final message). The whole point of
> this skill is the multi-turn, propose-then-confirm experience, so every `AskUserQuestion`,
> `EnterPlanMode`, and live build status line must originate here, in the main loop.

## Capabilities — the full toolbox (pick best-fit per requirement)

You are a **complete** model-driven app builder, not a single-surface tool. Everything below ships in
one App Spec and one build — choose what best serves the user's requirement to make a **useful,
prod-ready** app; don't under-build (a bare table list) or over-build (surfaces the user didn't ask for):

- **Data model** — tables, columns (all types), relationships (1:N / N:N + junctions), sample data
- **Record UI** — forms (sub-grids, quick-create / quick-view), views (with enriched default columns), charts
- **Actions** — modern command-bar buttons (incl. flyout / split menus), web resources (form JS / HTML / CSS)
- **Surfaces** — **generative pages** (modern dashboards / overviews / analytics / landing — the default),
  classic dashboards (opt-in), external URLs
- **App shell** — the app module + sitemap, with per-subarea icons
- **AI-first features** (admin-gated) — form-fill assist (data entry), natural-language grid/view
  search (data exploration), NL chart / AI data visualization, M365 Copilot (opt-in); per-table
  Copilot row summaries (Insight Cards) with tailored prompts, auto-selected for good-candidate tables

Author the **smallest spec that fully satisfies the ask**, then let the user refine. The **Genpage-first
policy** below is the record-vs-dashboard rule; [`references/app-spec-schema.md`](../../references/app-spec-schema.md)
documents every field.

## Genpage-first policy (surface classification)

Every app surface is one of two kinds — classify each as you author:

- **Record surfaces** (create/read/update/list a table's rows) → a **model-driven form + view**. This
  is the default for anything that edits or lists records.
- **Overview / dashboard / analytics / landing surfaces** → a **generative page** (`pages[]`), **not** a
  classic dashboard. This is the default for any non-record, at-a-glance or composite surface.

Rules:

- **Prefer generative pages** for overviews/dashboards by default. Propose a Home/overview genpage when
  the app benefits from one — never force-add it.
- A **traditional `dashboards[]`** is emitted **only on explicit request** (e.g. "use a classic dashboard").
- Each generative page needs a **`codeFile`** (its `.tsx`). You author that page code **here, at the skill
  layer**, before the build — a page always resolves to a concrete `codeFile`. Follow the generative-page
  code rules in [`references/rules.md`](../../references/rules.md).
- The build's `pages` phase uploads each page via `pac model genpage upload` **without `--add-to-sitemap`** —
  the SDK is the **single sitemap writer**, so a page's nav entry comes from a `page` subarea in `appShell`,
  which the SDK surfaces as a `GenPage` sitemap subarea. See
  [`references/app-spec-schema.md`](../../references/app-spec-schema.md) → `pages[]` for the field shape.

## Workflow

### Phase 0 — Working directory
1. Derive a short kebab-case slug from `$ARGUMENTS` (e.g. "Project Tracker" → `project-tracker`).
2. `mkdir -p <slug>`; resolve its absolute path. It holds `app-spec.json`, `model-app-plan.md`,
   and `workflow-log.md`.

### Phase 1 — Author the App Spec (interactive, main loop)

Follow **[references/authoring-flow.md](../../references/authoring-flow.md)** step by step,
running every prompt yourself via `AskUserQuestion`. In short:

1. **Prereqs** — `node --version`, `pac help` (≥ 2.7.0).
2. **Environment (PAC)** — `pac auth list`. If exactly one / an active profile, **confirm it
   (FYI), don't ask**. If several and none active, **ask** which to use. If none, ask the user
   to `pac auth create`. Capture the org URL (`pac org who`).
3. **Detect existing** — `pac model list-tables --search …` (exact-match) and `pac model list`
   to find tables/apps already present; build *around* them.
4. **Two-level authoring** — **first read the App Spec format** so you author to the exact
   shape (do this once; don't go spelunking through scripts):
   [`references/app-spec-schema.md`](../../references/app-spec-schema.md) and the worked sample
   [`samples/app-spec.support-desk.json`](../../samples/app-spec.support-desk.json). Then propose
   the **data model** (entities, columns, relationships); confirm via `AskUserQuestion` before
   moving on. Then propose **forms + views + charts + sample data** together; confirm. **Classify each surface per the
   genpage-first policy above** — record CRUD → a model-driven form/view; overview/dashboard/analytics/
   landing → a generative `page` in `pages[]` (author its `.tsx` `codeFile` following
   [`references/rules.md`](../../references/rules.md)); emit a classic `dashboards[]` only on explicit
   request. Persist
   `app-spec.json` after each level so the user can hand-edit between turns. Forms default to
   `layout: "auto"`; use explicit `tabs`/`sections`/`columns` when the user wants real grouping
   (see the schema). **Show the form wireframe** so the user can see the layout + Notes before
   approving: `node "${PLUGIN_ROOT}/scripts/preview-form.js" --spec @<working-dir>/app-spec.json`.
   **Don't pre-create tables/columns** during authoring — the build does it idempotently (adds
   only what's missing).
5. **Guardrail lint (hard gate)** — run `spec-lint.js`; **errors block**, warnings teach:
   ```bash
   node -e "const{lintAppSpec}=require('${PLUGIN_ROOT}/scripts/lib/spec-lint.js');const s=require('<working-dir>/app-spec.json');const r=lintAppSpec(s);console.log(JSON.stringify(r,null,2));process.exit(r.ok?0:1)"
   ```
6. **Plan-mode approval** — present the plan (`EnterPlanMode`), then `ExitPlanMode` to get the
   user's go-ahead. Write `model-app-plan.md`.

### Phase 2 — Build (narrated, main loop)

> **Always use `scripts/build-model-app.js`. Never hand-write a builder.** It's idempotent
> (skips existing solution/tables/columns/relationships — so new, existing, and mixed envs all
> just work), so you don't pre-create anything or special-case existing tables.

**Dry-run first** (no `--apply` → prints the ordered plan grouped by phase, writes nothing):

```bash
node "${PLUGIN_ROOT}/scripts/build-model-app.js" --env <envUrl> --spec @<working-dir>/app-spec.json
```

The output is the broken-down build plan — phases as `▶ <phase>` headers, each step as
`[n/total] ▢ <label>`. Show it. On the user's go-ahead, **apply** — each step then streams its
status live (`[n/total] ✓ created` / `⊘ skipped` / `✗ failed — <error>`) and a closing
`✓ build complete — X created, Y skipped, Z failed` summary:

```bash
node "${PLUGIN_ROOT}/scripts/build-model-app.js" \
  --env <envUrl> --spec @<working-dir>/app-spec.json --apply [--sample-data] [--publish]
```

**Run only what's needed** with phase selectors (the agent decides from detect-existing):
`--only <phases>` · `--skip <phases>` · `--from <phase>` · `--to <phase>`
(phases: `solution,data-model,sample-data,web-resources,views,charts,forms,commands,dashboards,app-shell,pages,ai-features,publish`).
E.g. when all tables already exist: `--apply --skip data-model`. SDK metadata is persisted under
`<working-dir>/.maker-workspace/` (override with `--workspace`), so edits can reuse it.

Narrate progress as it runs. Transient env errors (429 customization-lock, 503 SQL-timeout,
concurrent-op guards) are **auto-retried** with backoff on `--apply` (the build is idempotent, so a
retry reuses what's already created). If the build still **halts** (`BuildHalt`) on an
unrecoverable error, surface it and ask the user how to proceed via `AskUserQuestion` (adjust the
spec / cancel), then re-run. Everything is scoped to a dedicated unmanaged solution; `--publish` is opt-in.

**Resuming a failed build:** each `--apply` run appends a durable journal to
`<working-dir>/.maker-workspace/build-log.jsonl` (one line per step + a terminal `run-end`
record carrying the halt `phase`/`code` or the completion counts). To resume, inspect the last
record for where it stopped, then **re-run the exact same command** — the build is idempotent, so
it reuses every artifact already created and only fills the gaps (or use `--from <phase>` to skip
ahead). Resume is a re-run, not a replayed checkpoint; the journal is the diagnostic record.

### Phase 3 — Verify & iterate
**Reconcile the spec against what actually deployed** — catch silent partial builds — with the
read-only verifier (exits non-zero and lists anything missing: entities/columns/views/charts/forms
and sitemap subareas + icons):

```bash
node "${PLUGIN_ROOT}/scripts/verify-model-app.js" --env <envUrl> --spec @<working-dir>/app-spec.json
```

Then open the app in the browser. Refine `app-spec.json` and re-run Phase 2 to iterate.

**Teardown (cleanup).** To remove everything an App Spec built — e.g. a live-verification probe or a
failed build — run the classifier-safe teardown. It deletes only the artifacts the spec declares, in
dependency order (**app [+ its generative pages and the orphaned sitemap] → dashboards → commands → web-resources → tables [children-first] → solution**;
a table delete cascades its forms/views/charts/relationships/columns). **Dry-run by default** — it
lists what it would delete and touches nothing; add `--apply` to actually delete (add
`--clear-workspace` to also prune `.maker-workspace/`):

```bash
node "${PLUGIN_ROOT}/scripts/teardown-model-app.js" \
  --env <envUrl> --spec @<working-dir>/app-spec.json [--apply] [--clear-workspace]
```

### AI-first features

The `ai` block in the App Spec controls four app-level features and per-table Copilot row
summaries. All features are **admin-gated**: they are enabled only where the environment
administrator has turned them on in Power Platform Admin Center (Environments → Settings →
Product → Features). The `ai-features` build phase preflights each setting via the SDK
(`RetrieveSetting`) and, for anything off, **skips it with a warning** — it never fails the
build and cannot flip admin or tenant switches itself.

**Preflight (standalone):**
```bash
node "${PLUGIN_ROOT}/scripts/ai-preflight.js" --env <envUrl> [--app <uniqueName>]
```
Prints each feature's on/off status and the exact admin action required for anything that is off.
Never fails.

**App-level features** (`ai.appFeatures`):
- `formFill` — Copilot-assisted form fill (data entry)
- `nlSearch` — natural-language grid/view search (data exploration)
- `nlChart` — NL chart / AI data visualization
- `m365` — M365 Copilot integration (opt-in; defaults to `false`)

All default to `true` except `m365`. Set any to `false` to explicitly opt out.

**Per-table row summaries** (`ai.summaries`):
- `default: "auto"` — the skill auto-selects good-candidate tables (skips lookup-only / config /
  junction tables and the Dynamics 365-owned `incident`, `lead`, `opportunity`).
- `default: "off"` — summaries disabled unless a table opts in explicitly.
- Per-table overrides in `summaries.tables`: set `enabled`, a tailored `instruction`, and
  `columns[]` (the fields the summary reads). A `{ "enabled": false }` entry opts a specific
  table out.

**Prompt authoring guidelines** (for `instruction`): write for meaningful insights — not field/value
repetition; never include record GUIDs; pull in recent activity where relevant; use
audience-appropriate tone; aim for an explicit output shape (a short paragraph).

**Teardown** removes the AI records created by the `ai-features` phase (summary config rows and
published AI models) in addition to the standard artifacts.

---

## Editing a deployed app (download → edit → rebuild)

The **same App Spec drives edit** — there is no separate edit path. When the user wants to change an
existing app (add a field/view/page, edit a page's code, retitle/reorder nav, swap an icon), **pull the
deployed app fresh into a spec first**, then edit that spec and re-run Phase 2:

```bash
node "${PLUGIN_ROOT}/scripts/download-model-app.js" --env <envUrl> --app <appId|uniqueName> --out <working-dir>
```

This reconstructs the **complete** app into `<working-dir>/app-spec.json`: the sitemap → `appShell` (all
subareas + icons), **every** generative page (downloaded via `pac model genpage download`; page names come
from the sitemap's `GenPage` subarea titles, so Maker-added pages are included too) into `pages[]` + their `.tsx` `codeFile`s, the referenced entities (minimal — the build reuses
existing tables idempotently), the icon web resources, and the solution. Then:

1. **Always pull fresh at the start of an edit session** — someone may have changed the app in Maker. The
   build reads an etag when it hydrates, so a write against an artifact changed since the pull throws a
   version conflict → **re-pull and retry**, never clobber.
2. Edit `app-spec.json` (and any page `.tsx`) for the requested change.
3. Re-run the **build** (Phase 2). It's idempotent: it reuses the existing app/tables/views, **updates each
   page in place** (matched by name → `--page-id`, so no duplicate pages), and **preserves the existing
   `GenPage` subareas** (the download enumerated them into `pages[]`/`appShell`, so the full-replace sitemap
   write never drops them).
4. **Verify** (Phase 3) to confirm only the intended change landed.

> **Edit-flow limitation (Preview):** classic `dashboards[]` and their sitemap subareas are **not yet
> round-tripped** by `download-model-app.js` — it prints a `WARNING: N sitemap subarea(s) could not be
> round-tripped` and a rebuild would drop them from the nav. If the app has a classic dashboard, **re-add
> it to the downloaded spec before rebuilding**. (Genpage, entity, URL subareas + icons round-trip
> losslessly.) Prefer generative pages over classic dashboards per the genpage-first policy.

---

## What the builder does (in order)

solution (idempotent) → data model — **discover** existing tables/columns/relationships via the
SDK (`findTables` / `findColumns` / `fetchEntityMetadata`) and create only what's missing
(`createTable` / `createColumn` / `createRelationship`) → **sample data** (opt-in; relational/
topological, `$parent`→`@odata.bind` using the entity-set name) → **web resources** (opt-in;
`createWebResource` for form JS/HTML/CSS) → **views** → **charts** → **forms** (primary + columns
laid out, explicit `tabs` honored, `addSubGrid` per sub-grid, `addFormEventHandler` per `events[]`)
→ **app module + sitemap** → **generative pages** (upload each `pages[]` page via `pac model genpage upload`,
no `--add-to-sitemap`; then the SDK rewrites the sitemap once to add the `GenPage` subareas) → publish
(opt-in). When the app has generative-page subareas the app module is created first WITHOUT them (they can't
resolve until the pages upload), then the pages phase rewrites the sitemap. All Dataverse access goes through the SDK, so the
downloaded metadata lands in `.maker-workspace/`. Independent ops (columns, views/charts/forms)
run with bounded parallelism; publish is one round-trip per entity + the app. Views/charts build
**before** forms so a sub-grid can reference the child view id. Each step emits `[n/total]`.

## Notes & limits

- **Headless, no browser.** The SDK (`cds-maker-sdk`, vendored at `scripts/vendor/`) generates
  designer-grade FormXML/FetchXML/sitemap by reusing the designer's own serializers, and writes
  via the Web API using an `az`-token HttpClient. No relay, no designer tab.
- **Dedicated unmanaged solution per app** (review / teardown). **Publish is opt-in**
  (`--publish`); the builder never publishes by accident.
- **Idempotent.** Existing solution/tables/columns/relationships are detected and reused, so
  re-runs and existing-table envs work without collisions. (Full spec-vs-deployed *diff* editing
  of views/forms is a later increment.)
- Not in scope (later): business rules, **conditional** command visibility (Power-Fx-only), **titled
  command groups** (from-scratch — needs an SDK-synthesized parent row), lookup/associated views,
  multi-area sitemaps, security roles. (Supported: the full data model — all column types,
  **AutoNumber primary**, global choices, status reasons, alternate keys, **N:N + junction-with-payload**;
  adaptive main forms with **1:N / N:N sub-grids**; **quick-create / quick-view forms** (`formType`) +
  **quick-view placement** (`forms[].quickViews[]` — embed a QuickView form via a lookup); Choice-column
  charts; **dashboards** (`dashboards[]` — chart/list/iframe/webresource tiles) + **dashboard sitemap
  placement** (a `dashboard` subarea, auto-pinned); **generative pages** (`pages[]` — the genpage-first
  default for overview/dashboard surfaces, uploaded via `pac model genpage upload` and surfaced as `GenPage`
  sitemap subareas; full **create + edit** round-trip via `download-model-app.js`); **modern command-bar buttons** (`commands[]` — JS
  on-click + static hidden/disabled) incl. **flyout / split-button menus** (`type` + `children[]`);
  **rich view filters** (`eq-userid`/`this-week`/`in`/`not-in`); web resources + form JS event
  handlers; sample data with **multi-parent `$parents`** + **`statusReason`** (Choice/MultiChoice labels
  auto-resolve).) See
  [`docs/model-app-maker-roadmap.md`](../../docs/model-app-maker-roadmap.md) and the one-page
  [`references/app-spec-schema.md`](../../references/app-spec-schema.md) — author from that **single**
  doc; you should not need to read the SDK, lint, or engine to write a spec.
