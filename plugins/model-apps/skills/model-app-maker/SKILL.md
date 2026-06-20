---
name: model-app-maker
version: 0.2.0
description: Builds a model-driven Power Apps app from a natural-language intent. Delegates interactive planning (env selection, App Spec authoring, guardrail lint, plan-mode approval) to the `model-app-planner` agent, then runs the deterministic build. Use when the user says "build an app for X", "create a model-driven app", or "make me an app to manage Y". For generative PAGES use /genpage; for editing one existing form use the model-maker relay.
author: Microsoft Corporation
argument-hint: "<app description>"
user-invocable: true
model: sonnet
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, AskUserQuestion, Task, TaskCreate, TaskUpdate, TaskList
---

# model-app-maker — intent → model-driven app

Thin orchestrator. The interactive planning (env, requirements, the App Spec, the
guardrail lint, and the plan-mode approval) is done by the `model-app-planner` agent;
this skill coordinates it and runs the build.

## Workflow

### Phase 0 — Working directory

1. Derive a short kebab-case slug from the app description in `$ARGUMENTS`
   (e.g., "Project Tracker" → `project-tracker`).
2. `mkdir -p <slug>` and resolve its absolute path.
3. This directory is the **working directory** for all subsequent phases; it holds
   `app-spec.json`, `model-app-plan.md`, and `workflow-log.md`.

### Phase 1 — Plan (invoke `model-app-planner` via `Task`)

> **CRITICAL — you MUST invoke `model-app-planner` via the `Task` tool. You MUST
> NOT inline its prerequisite, auth, env, or authoring questions yourself with
> `AskUserQuestion`.**
>
> The planner is not optional or skippable. It runs:
> 1. Prerequisite validation (`node --version`, `pac help` >= 2.7.0)
> 2. PAC CLI auth check and environment selection (`pac auth list`, `pac org who`)
> 3. Detect existing Dataverse tables and model-driven apps
> 4. Two-level interactive authoring — data model first, then forms/views/charts/
>    sample data — confirmed turn by turn via `AskUserQuestion` inside the subagent
> 5. Guardrail lint (`spec-lint.js`) — hard gate; errors block plan-mode entry
> 6. Plan-mode approval (`EnterPlanMode` / `ExitPlanMode`)
> 7. Writes `app-spec.json` and `model-app-plan.md` to the working directory
>
> Even if `$ARGUMENTS` appears self-explanatory, **still invoke the planner** — the
> prereq / auth / env steps must run, and the structured two-level authoring gives
> the user labeled options rather than free-text guesses.

#### Invocation

Invoke `model-app-planner` via the `Task` tool with a prompt that includes:

- The user's requirements: `$ARGUMENTS`
- The working directory (absolute path from Phase 0)
- The plugin root: `${CLAUDE_PLUGIN_ROOT}`

Example prompt:

> You are the model-app-planner agent. Plan a model-driven app for the following
> requirements:
>
> [paste $ARGUMENTS here verbatim, or "no arguments provided — gather from user"]
>
> Working directory: [absolute path from Phase 0]
> Plugin root: ${CLAUDE_PLUGIN_ROOT}
>
> Follow the instructions in your agent file. Validate prereqs, confirm auth and
> environment, detect existing tables and apps, run two-level interactive authoring,
> lint the spec, and get plan-mode approval. Write app-spec.json and
> model-app-plan.md to the working directory. Return a summary with the env URL,
> solution, tables, and artifact counts when complete.

Wait for the planner to finish — it returns a summary and has written `app-spec.json`.
Capture the `envUrl` from the summary. Proceed to Phase 2.

### Phase 2 — Build

**Dry-run first** (no `--apply` = prints the ordered plan, writes nothing):

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/build-model-app.js" \
  --env <envUrl> \
  --spec @<working-dir>/app-spec.json
```

Show the plan output to the user. On their go-ahead, apply:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/build-model-app.js" \
  --env <envUrl> \
  --spec @<working-dir>/app-spec.json \
  --apply [--sample-data] [--publish]
```

Run the command so the `[n/total]` progress lines display live. Publishing is the
slow step (1–2 min). Everything is scoped to a dedicated unmanaged solution.
`<envUrl>` is the environment URL the planner captured in Phase 1.

### Phase 3 — Verify & iterate

Open the app in the browser. Refine `app-spec.json` and re-run Phase 2 to iterate.

---

## What the builder does (in order)

solution → tables + columns (`dv-*` scripts) → relationships → **publish entities**
→ **sample data** (opt-in `--sample-data`, relational/topological + `$parent` binds)
→ **views** (kernel `buildView` → `savedquery`) → **charts** (kernel `buildChart` →
`savedqueryvisualization`) → **forms** (kernel `buildForm` with adaptive layout +
sub-grids → PATCH the system form) → app module + sitemap (kernel `buildSitemap` →
`appmodule` / `sitemap` / `AddAppComponents`, components include charts: type 59) →
publish (opt-in `--publish`). Views and charts build **before** forms so a parent
form's sub-grid can reference the child view id. Each phase emits a `[n/total]`
progress line.

## Notes & limits

- **Dedicated unmanaged solution per app** (review / teardown). **Publish and
  preview are opt-in** (`--publish` / `--preview`); the builder never publishes by
  accident.
- **Creates, does not update.** Updating an existing app (diffing a spec against a
  deployed app) is a later increment; a name/schema collision stops with a clear
  message.
- The kernel produces designer-fidelity FormXML by reusing the form designer's own
  serializer headlessly — no browser needed for the build. The relay is only the
  optional `--preview`.
- Not in scope (later phases): quick-create / quick-view forms, lookup/associated
  views, multi-area sitemaps, security roles, business rules. (Adaptive main forms,
  related-record sub-grids, and Choice-column charts are supported.)
