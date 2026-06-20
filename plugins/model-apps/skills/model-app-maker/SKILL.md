---
name: model-app-maker
version: 0.5.0
description: Builds a model-driven Power Apps app from a natural-language intent — tables, columns, relationships, adaptive forms with sub-grids, views, Choice-column charts, and an app module + sitemap — via the headless cds-maker-sdk. Runs an interactive, multi-turn authoring flow (env selection, App Spec authoring, guardrail lint, plan-mode approval) and a narrated build. Use when the user says "build an app for X", "create a model-driven app", or "make me an app to manage Y". For generative PAGES use /genpage.
author: Microsoft Corporation
argument-hint: "<app description>"
user-invocable: true
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, AskUserQuestion, EnterPlanMode, ExitPlanMode, TaskCreate, TaskUpdate, TaskList
---

# model-app-maker — intent → model-driven app

Turn a natural-language intent into a deployed model-driven app. You author a reviewable
**App Spec** (JSON) with the user across confirmed turns, then a deterministic engine
(`cds-maker-sdk`, vendored) builds it — tables/columns/relationships, sample data, views,
Choice-column charts, adaptive forms with sub-grids, and the app module + sitemap.

## CRITICAL — run the interactive flow in THIS conversation (the main loop)

> **You MUST run the authoring questions and the build narration yourself, in the main
> conversation. Do NOT dispatch a subagent (`Task`) for the interactive steps.**
>
> A subagent is headless — `AskUserQuestion` and plan mode do not reach the user from
> inside one (a `Task` subagent's only output is its final message). The whole point of
> this skill is the multi-turn, propose-then-confirm experience, so every `AskUserQuestion`,
> `EnterPlanMode`, and live build status line must originate here, in the main loop.

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
   moving on. Then propose **forms + views + charts + sample data** together; confirm. Persist
   `app-spec.json` after each level so the user can hand-edit between turns. Forms default to
   `layout: "auto"`; use explicit `tabs`/`sections`/`columns` when the user wants real grouping
   (see the schema). **Show the form wireframe** so the user can see the layout + Notes before
   approving: `node "${CLAUDE_PLUGIN_ROOT}/scripts/preview-form.js" --spec @<working-dir>/app-spec.json`.
   **Don't pre-create tables/columns** during authoring — the build does it idempotently (adds
   only what's missing).
5. **Guardrail lint (hard gate)** — run `spec-lint.js`; **errors block**, warnings teach:
   ```bash
   node -e "const{lintAppSpec}=require('${CLAUDE_PLUGIN_ROOT}/scripts/lib/spec-lint.js');const s=require('<working-dir>/app-spec.json');const r=lintAppSpec(s);console.log(JSON.stringify(r,null,2));process.exit(r.ok?0:1)"
   ```
6. **Plan-mode approval** — present the plan (`EnterPlanMode`), then `ExitPlanMode` to get the
   user's go-ahead. Write `model-app-plan.md`.

### Phase 2 — Build (narrated, main loop)

> **Always use `scripts/build-model-app.js`. Never hand-write a builder.** It's idempotent
> (skips existing solution/tables/columns/relationships — so new, existing, and mixed envs all
> just work), so you don't pre-create anything or special-case existing tables.

**Dry-run first** (no `--apply` → prints the ordered plan grouped by phase, writes nothing):

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/build-model-app.js" --env <envUrl> --spec @<working-dir>/app-spec.json
```

The output is the broken-down build plan — phases as `▶ <phase>` headers, each step as
`[n/total] ▢ <label>`. Show it. On the user's go-ahead, **apply** — each step then streams its
status live (`[n/total] ✓ created` / `⊘ skipped` / `✗ failed — <error>`) and a closing
`✓ build complete — X created, Y skipped, Z failed` summary:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/build-model-app.js" \
  --env <envUrl> --spec @<working-dir>/app-spec.json --apply [--sample-data] [--publish]
```

**Run only what's needed** with phase selectors (the agent decides from detect-existing):
`--only <phases>` · `--skip <phases>` · `--from <phase>` · `--to <phase>`
(phases: `solution,data-model,sample-data,web-resources,views,charts,forms,app-shell,publish`).
E.g. when all tables already exist: `--apply --skip data-model`. SDK metadata is persisted under
`<working-dir>/.maker-workspace/` (override with `--workspace`), so edits can reuse it.

Narrate progress as it runs. If the build **halts** (`BuildHalt`) on an unrecoverable error,
surface it and ask the user how to proceed via `AskUserQuestion` (adjust the spec / cancel),
then re-run. Everything is scoped to a dedicated unmanaged solution; `--publish` is opt-in.

### Phase 3 — Verify & iterate
Open the app in the browser. Refine `app-spec.json` and re-run Phase 2 to iterate.

---

## What the builder does (in order)

solution (idempotent) → data model — **discover** existing tables/columns/relationships via the
SDK (`findTables` / `findColumns` / `fetchEntityMetadata`) and create only what's missing
(`createTable` / `createColumn` / `createRelationship`) → **sample data** (opt-in; relational/
topological, `$parent`→`@odata.bind` using the entity-set name) → **web resources** (opt-in;
`createWebResource` for form JS/HTML/CSS) → **views** → **charts** → **forms** (primary + columns
laid out, explicit `tabs` honored, `addSubGrid` per sub-grid, `addFormEventHandler` per `events[]`)
→ **app module + sitemap** → publish (opt-in). All Dataverse access goes through the SDK, so the
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
- Not in scope (later): dashboards, commands (ribbon buttons), business rules, quick-create /
  quick-view forms, lookup/associated views, multi-area sitemaps, security roles. (Supported:
  the full data model — all column types, **AutoNumber primary**, global choices, status reasons,
  alternate keys, **N:N + junction-with-payload**; adaptive main forms with **1:N / N:N sub-grids**;
  Choice-column charts; **rich view filters** (`eq-userid`/`this-week`/`in`/`not-in`); web resources
  + form JS event handlers; sample data with **multi-parent `$parents`** + **`statusReason`**.) See
  [`docs/model-app-maker-roadmap.md`](../../docs/model-app-maker-roadmap.md) and the one-page
  [`references/app-spec-schema.md`](../../references/app-spec-schema.md) — author from that **single**
  doc; you should not need to read the SDK, lint, or engine to write a spec.
