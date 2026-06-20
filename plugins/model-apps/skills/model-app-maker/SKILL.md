---
name: model-app-maker
version: 0.3.0
description: Builds a model-driven Power Apps app from a natural-language intent — tables, columns, relationships, adaptive forms with sub-grids, views, Choice-column charts, and an app module + sitemap — via the headless cds-maker-sdk. Runs an interactive, multi-turn authoring flow (env selection, App Spec authoring, guardrail lint, plan-mode approval) and a narrated build. Use when the user says "build an app for X", "create a model-driven app", or "make me an app to manage Y". For generative PAGES use /genpage.
author: Microsoft Corporation
argument-hint: "<app description>"
user-invocable: true
model: sonnet
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
4. **Two-level authoring** — propose the **data model** (entities, columns, relationships);
   confirm via `AskUserQuestion` before moving on. Then propose **forms + views + charts +
   sample data** together; confirm. Persist `app-spec.json` after each level so the user can
   hand-edit between turns.
5. **Guardrail lint (hard gate)** — run `spec-lint.js`; **errors block**, warnings teach:
   ```bash
   node -e "const{lintAppSpec}=require('${CLAUDE_PLUGIN_ROOT}/scripts/lib/spec-lint.js');const s=require('<working-dir>/app-spec.json');const r=lintAppSpec(s);console.log(JSON.stringify(r,null,2));process.exit(r.ok?0:1)"
   ```
6. **Plan-mode approval** — present the plan (`EnterPlanMode`), then `ExitPlanMode` to get the
   user's go-ahead. Write `model-app-plan.md`.

### Phase 2 — Build (narrated, main loop)

**Dry-run first** (no `--apply` → prints the ordered plan, writes nothing):

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/build-model-app.js" --env <envUrl> --spec @<working-dir>/app-spec.json
```

Show the plan. On the user's go-ahead, **apply** — run it so the `[n/total]` lines stream live:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/build-model-app.js" \
  --env <envUrl> --spec @<working-dir>/app-spec.json --apply [--sample-data] [--publish]
```

Narrate progress as it runs. If the build **halts** on a collision/error (e.g. a table already
exists), surface it and ask the user how to proceed via `AskUserQuestion` (overwrite a name /
adjust the spec / cancel), then re-run. Everything is scoped to a dedicated unmanaged solution;
publishing (`--publish`) is the slow step (1–2 min) and opt-in.

### Phase 3 — Verify & iterate
Open the app in the browser. Refine `app-spec.json` and re-run Phase 2 to iterate.

---

## What the builder does (in order)

solution (publisher + `createSolution`) → tables + columns (`createTable` / `createColumn`,
Choice → inline options) → relationships (`createRelationship`, 1:N also makes the lookup) →
**sample data** (opt-in `--sample-data`; relational/topological, `$parent`→`@odata.bind`) →
**views** (`createArtifact('view')` → `pushArtifact`) → **charts** (`createArtifact('chart')`) →
**forms** (`createArtifact('form')` with the primary + columns laid out, `addSubGrid` per
related sub-grid) → **app module + sitemap** (`createArtifact('app')`) → publish (opt-in
`--publish`). Views and charts build **before** forms so a parent form's sub-grid can reference
the child view id. Each phase emits a `[n/total]` progress line.

## Notes & limits

- **Headless, no browser.** The SDK (`cds-maker-sdk`, vendored at `scripts/vendor/`) generates
  designer-grade FormXML/FetchXML/sitemap by reusing the designer's own serializers, and writes
  via the Web API using an `az`-token HttpClient. No relay, no designer tab.
- **Dedicated unmanaged solution per app** (review / teardown). **Publish is opt-in**
  (`--publish`); the builder never publishes by accident.
- **Creates, does not update.** Updating a deployed app (diffing a spec against it) is a later
  increment; a name/schema collision stops with a clear message you can gate on.
- Not in scope (later): quick-create / quick-view forms, lookup/associated views, multi-area
  sitemaps, security roles, business rules. (Adaptive main forms, related-record sub-grids, and
  Choice-column charts are supported.)
