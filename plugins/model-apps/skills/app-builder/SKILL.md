---
name: app-builder
version: 1.0.0
description: Builds and edits a model-driven Power Apps app from a natural-language intent — tables, columns, relationships, adaptive forms with sub-grids, views, Choice-column charts, business rules, business process flows, generative page intents for overview/dashboard surfaces, and an app module + sitemap. Runs an interactive authoring flow with plan approval and can download a deployed app back into an editable spec to change it. Use when the user says "build an app for X", "create a model-driven app", "make me an app to manage Y", "add a business process flow", or "edit/add to my app". Do not use it for a generic web or React app or website, Power Pages, canvas apps, or Power Automate, or when the user rules out Power Platform, Dataverse, or model-driven apps (for example "no Power Platform"). This skill stands alone and does not require /genpage — but for a standalone generative page added to an app that already exists, use /genpage instead.
author: Microsoft Corporation
argument-hint: "<app description>"
user-invocable: true
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, Task, AskUserQuestion, EnterPlanMode, ExitPlanMode, TaskCreate, TaskUpdate, TaskList, read, edit, execute, search, agent, todo
---

> **Plugin check**: Run `node "${PLUGIN_ROOT}/scripts/check-version.js"` — if it outputs a message, show it to the user before proceeding.

> **Model check (lightweight models only)**: If you are a lightweight model optimized for fast, simple tasks, tell the user in your first message that `/app-builder` works best on a general-purpose coding model or an advanced reasoning model — designing the App Spec, reasoning about the dependencies between tables, relationships and artifacts, orchestrating the build and reconciling what already exists take multistep planning, tool use and validation — and recommend switching; then continue. On any other model, skip this note and say nothing about it.

# app-builder — intent → model-driven app

Turn a natural-language intent into a deployed model-driven app. You author a reviewable **App Spec**
(JSON) with the user across confirmed turns, then a deterministic engine (`cds-maker-sdk`, vendored)
builds it — tables/columns/relationships, sample data, views, Choice-column charts, adaptive forms
with sub-grids, **generative pages** for overview/dashboard surfaces, and the app module + sitemap.
The **same spec drives create and edit**: download a deployed app back into a spec, change it, and
re-run the build (it's idempotent).

## CRITICAL — run the interactive flow in THIS conversation (the main loop)

> **You MUST run the authoring questions and the build narration yourself, in the main
> conversation. Do NOT dispatch a subagent (`Task`) for the interactive steps.**
>
> A subagent is headless — `AskUserQuestion` and plan mode do not reach the user from inside one
> (its only output is its final message). The whole point of this skill is the multi-turn,
> propose-then-confirm experience, so every `AskUserQuestion`, `EnterPlanMode`, and live build
> status line must originate here, in the main loop.

## CRITICAL — the user sees your chat message, NOT tool output

> **Shell/tool output — the result of running `preview-app.js`, a dry-run plan, or a lint —
> is COLLAPSED BY DEFAULT in the UI. The user does NOT see it unless they manually expand the
> tool panel.** Running the command is therefore NOT the same as showing the user. Every artifact
> the user must **read, review, or approve** — the whole-app **preview wireframes**, the
> **dry-run build plan**, and blocking **lint findings** — MUST be reproduced **verbatim in your
> chat reply**, inside a fenced ` ``` ` code block. Never say "the preview looks right" and leave
> the content buried in a collapsed panel: **paste it into your message.** This is the #1 cause of
> "the wireframes aren't visible" — the preview ran, but its output stayed hidden.

## Capabilities — the full toolbox (pick best-fit per requirement)

You are a **complete** model-driven app builder, not a single-surface tool. Everything below ships in
one App Spec and one build — choose what best serves the user's requirement to make a **useful,
prod-ready** app; don't under-build (a bare table list) or over-build (surfaces nobody asked for):

- **Data model** — tables (give each custom table a **meaningful Fluent-style SVG table icon by default**; propose what the glyph will **depict** in words — never a Fluent token name — and record it as `iconDescription` before drawing the SVG — see [`references/authoring-flow.md`](../../references/authoring-flow.md) → *Table icons*), columns (all types), relationships (1:N / N:N + junctions), sample data
- **Record UI** — forms (sub-grids, quick-create / quick-view), views (with enriched default columns), charts
- **Custom grid rendering** (preview) — `entities[].columns[].visualization`: render a column as a
  `RadialDial`, `LineChart`, `HeatMap` or `StarRating` in **every** grid and view that shows it,
  instead of plain text. Reach for it when a column is a *magnitude a user scans* (a score, a
  utilization %, a rating, a priority) rather than a value they read exactly — it makes a list
  scannable at a glance for one line of spec. It is per-*column*, so set it once on the column, not
  on each view. **Preview:** on an environment where it is not provisioned the build skips it and
  everything else still deploys, so it is always safe to include.
- **Actions** — modern command-bar buttons (incl. flyout / split menus), web resources (form JS / HTML / CSS).
  Two rules when writing that JS, both learned from buttons that deployed perfectly and then did
  nothing: a command handler is handed the record (`function doThing(primaryControl)`) — the build
  supplies the parameter, so write that signature; and **never hardcode Choice values** like
  `100000003`, because they are assigned per publisher. Resolve by label via `getOptions()`
  (see `references/app-spec-schema-advanced.md` → webResources). Note also that command and web-resource
  **edits do not redeploy on rebuild** — the phases reuse what exists, so changing a button or a
  script means deleting it first (the build warns, and verify fails, when a web resource's deployed
  content differs from the spec's). This does not apply to recovery of the build's own
  `WEB_RESOURCE_UNVERIFIED` row: keep that row and the same build workspace, then follow its halt.
- **Form logic without code** — `businessRules[]`: show/hide, lock/unlock, set-required and
  set-value, driven by a condition on the record. **Reach for a business rule before form JS** when
  the requirement is field-level and declarative — it is visible in the maker, survives solution
  export, and needs no web resource. Use form JS when the logic needs a real API call, cross-record
  work, or anything beyond the four supported actions.
- **Guided processes** — `businessProcessFlows[]`: the staged bar across the top of a record
  (ordered stages, each with steps bound to that table's columns — **every step must bind a `field`**;
  the platform rejects one without, so use a Boolean flag for a manual check-off). Reach for one when
  the user describes work moving through **phases** — "triage →
  investigate → resolve", "lead → qualify → close". Author it `Active` (the default) or the stage bar
  does not appear at all. Who may run a flow is `securityRoles: { "personas": [...] }` (Active flows
  only). v1 is single-entity and linear: cross-entity stages, branching and stage actions are
  **rejected** by the spec gate, so offer Maker for those rather than writing them into the spec.
- **Surfaces** — **generative pages** (modern dashboards / overviews / analytics / landing — the default),
  classic dashboards (opt-in), external URLs
- **App shell** — the app module + sitemap, with per-subarea icons. Turn on the **modern shell** with
  `app.newLook: true` unless the user asks for the classic one; it is opt-in and best-effort, so a
  tenant without the setting still gets a working app. `app.headerNavigationRefresh` controls the
  **Wave 2 header/navigation refresh** — a *separate, independent* setting whose platform default is
  **ON**, so set it to `false` only when the user explicitly wants the classic header.
- **Security & access** — one **security role per persona**, sized from that persona's jobs-to-be-done
  (the entity access each job needs, unioned into the role), so the app **opens for non-admins**.
- **AI-first features** (admin-gated) — form-fill assist, natural-language grid/view search, NL chart
  / AI data visualization, M365 Copilot (opt-in); per-table Copilot row summaries (Insight Cards)
  with tailored prompts, auto-selected for good-candidate tables

Author the **smallest spec that fully satisfies the ask**, then let the user refine. The **Genpage-first
policy** below is the record-vs-dashboard rule; [`references/app-spec-schema.md`](../../references/app-spec-schema.md)
documents every field.

## Genpage-first policy (surface classification)

Every app surface is one of two kinds — **enumerate the app's surfaces and classify each one**, don't
decide page-by-page in passing:

- **Record surfaces** (create/read/update/list a table's rows) → a **model-driven form + view**.
- **Everything else** — overview/landing, dashboard, KPIs, analytics, guided or wizard flow,
  composite or comparison screen → a **generative page** (`pages[]`), **not** a classic dashboard.

Rules:

- An app whose jobs include an overview, a queue, analytics or a guided flow but which proposes no
  pages has missed a surface. Where the app genuinely is record-CRUD only, say so explicitly rather
  than silently omitting pages.
- A **traditional `dashboards[]`** is emitted **only on explicit request** (e.g. "use a classic dashboard").
- A generative page is authored as a **design intent** (`source: { kind: "intent" }`,
  `schemaVersion: 2`) during Phase 1 — its `.tsx` is written in **Phase 1.5 — Generate pages**, after
  plan approval and after the data pre-build creates the tables so `genpage.js types`
  can emit `RuntimeTypes.ts`. See [`references/authoring-flow.md`](../../references/authoring-flow.md) → *Pages*.
- The build's `pages` phase writes each page through the SDK and never places it in the sitemap
  itself — the SDK is the **single sitemap writer**, so a page's nav entry comes from a
  `page` subarea in `appShell` (referenced by the page's **`key`**). See
  [`references/app-spec-schema.md`](../../references/app-spec-schema.md) → `pages[]`.
- **Every page in `pages[]` must be sitemap-placed** — validation rejects any page absent from the
  sitemap. A "detail" page that receives a caller-supplied id is a normal sitemap page; it reads its
  input via `pageInput?.data?.<field>`. Navigation-only (headless) pages are not supported.
- **A page that declares `pageInput` MUST declare `directEntry`.** Because every page is
  sitemap-placed, a detail page is also reachable straight from the app navigation with **no input**
  — a state a user reaches by clicking. Say what happens then: `{ "behavior": "selector" }` shows a
  picker and then the record, `{ "behavior": "emptyState" }` explains and renders nothing broken.
  Prefer `selector` when the table is browsable; it is the more useful landing. Every key in
  `pageInput.data` must also be produced by some page's `navigatesTo[].data`, or the generated page
  reads a key nothing ever sets.
- **Three-authority page identity** (build + download + verify all follow this): (1) **IDENTITY** —
  the durable `<app>_pagemanifest` (`key → pageId`); a downloaded spec's own `pages[].pageId`
  outranks it for that rebuild. (2) **EXISTENCE** — the env-wide page list read through the SDK, drafts
  included (crash-safe; decides create-vs-reuse). (3) **MEMBERSHIP** — the app's sitemap `GenPageId` set (placement,
  download enumeration, verify coverage). All matching is by id — never by display name.
- **Multi-page navigation uses `PAGEREF_<key>`** (the stable `pages[].key`) as the `pageId`
  placeholder; the build resolves each to the real page GUID in a run-scoped staging copy (the
  canonical `.tsx` is never mutated), then **verifies every nav edge** resolves to the deployed
  page's `GenPageId`.

## Workflow

### Phase 0 — Working directory
1. Derive a short kebab-case slug from `$ARGUMENTS` (e.g. "Project Tracker" → `project-tracker`).
2. Create the directory (`mkdir -p <slug>` on bash/PowerShell; `mkdir <slug>` on cmd, which has no
   `-p` and errors if it exists) and resolve its absolute path. It holds `app-spec.json`,
   `model-app-plan.md`, and `workflow-log.md`.

### Phase 1 — Author the App Spec (interactive, main loop)

Follow **[references/authoring-flow.md](../../references/authoring-flow.md)** step by step, running
every prompt yourself via `AskUserQuestion`. In short:

#### Unattended runs (Copilot autopilot / automation)

Resolve the interaction mode once before the first authoring question:

```bash
node "${PLUGIN_ROOT}/scripts/resolve-interaction-mode.js" [--non-interactive]
```

`POWER_PLATFORM_SKILLS_NONINTERACTIVE=1`/`true` (or the equivalent
`--non-interactive` invocation) means there is no user waiting for prompts. In
that mode:

- do not call `AskUserQuestion`, `EnterPlanMode`, or `ExitPlanMode`;
- use explicit requirements and supplied existing specs as authoritative, and
  use documented defaults only where the request leaves a non-destructive
  choice open;
- record each skipped gate as
  `Unattended default: <question> → <answer> (<reason>)` in `workflow-log.md`;
- treat the completed lint, preview, rendered design document, and build dry-run
  as the approved plan, then continue with the normal approved path;
- halt rather than guessing an ambiguous environment, app identity, or
  destructive structural edit.

Suppressing interaction never authorizes destructive work. An unattended
existing-app apply still requires `--allow-destructive` wherever the build
normally requires it; `POWER_PLATFORM_SKILLS_NONINTERACTIVE` only suppresses
prompts.

Carry the resolved mode through subprocesses: when it is unattended, append
`--non-interactive` to every `build-model-app.js` invocation (dry-run, data
pre-build, recovery rerun, and full apply). Do not append `--allow-destructive`
unless destructive authority was supplied independently.

1. **Prereqs** — `node --version`, `pac help` (> 2.10.0, the plugin's minimum).
2. **Environment (PAC)** — `pac auth list`. If exactly one / an active profile, **confirm it
   (FYI), don't ask**. If several and none active, **ask** which to use. If none, ask the user
   to `pac auth create`. Capture the org URL (`pac org who`).
3. **Detect existing** — `scripts/list-tables.js --env <envUrl> --search … --exact` and
   `scripts/apps.js list --env <envUrl>` (`<envUrl>` is the org URL from step 2) to find
   tables/apps already present; build *around* them. `--exact` keeps only the tables whose
   logical name is a search term and lists the terms with none in `missing`. A failed read
   (exit 1) is reported and ends the step — never read it as "nothing exists".
4. **Levelled authoring** — **first read the App Spec format** so you author to the exact
   shape (do this once; don't go spelunking through scripts):
   [`references/app-spec-schema.md`](../../references/app-spec-schema.md) and the worked sample
   [`samples/app-spec.support-desk.json`](../../samples/app-spec.support-desk.json). That document
   covers everything an app always has. **Additionally read
   [`references/app-spec-schema-advanced.md`](../../references/app-spec-schema-advanced.md) once your
   design calls for a conditional feature** — business rules, a business process flow, command-bar
   buttons, web resources, global choices, classic dashboards, or `roleGrants[]`. Its pointer table
   is in the main schema, and the toolbox above tells you when to reach for each; read the detail
   only for the ones you are actually using, and never skip a capability just to avoid the read.
   Phase 1 is
   **design-only**: never emit page `.tsx` here. Each level is confirmed via `AskUserQuestion` before
   the next begins, and `app-spec.json` is persisted after each — full prompts in the playbook.
   - **Level (a0) — personas & jobs-to-be-done** (`personas[]`): **before proposing any tables**, ask
     who will use the app and what each needs to get done. Jobs drive everything that follows — a
     table exists because a job needs its data, a surface because a job needs to act on it. Deriving
     the data model first reliably misses surfaces. Privileges come later; capture the jobs now.
   - **Level (a) — data model**: entities/columns/relationships **derived from those jobs**; run the
     **early data-model lint** (catches e.g. the relationship-vs-lookup collision before forms are
     authored on top).
   - **Descriptions are part of authoring, not a cleanup pass.** Every table, column, view, chart,
     form, dashboard and business rule takes an optional `description`, and you should **write one as
     you create the artifact** — never as a backfill. A name says what a thing is called; a
     description says what it is *for*, and it is the only intent an app carries that an agent can
     read back later when it inspects an app it did not build. Describe the purpose, not the shape:
     `"Severity 1-5; drives the escalation rule and the SLA clock"`, not `"The priority column"`.
     (`commands[]` and `Customer` columns accept one but the SDK cannot write it — you'll get a
     warning; `personas[]` does not take one at all. See the schema reference for why.)
     The app itself takes two: `app.description` is the short tile text, and `app.aiDescription` is
     the **routing description** an orchestrator reads to choose between apps — who the app is for,
     what it covers and excludes, and how to tell it from a sibling app over the same tables. Write
     it whenever such a sibling exists or is planned.
   - **Level (b) — artifacts + page-intents + design**: **enumerate every surface each job needs and
     classify it** per the genpage-first policy above — record CRUD → form + view; anything else
     (overview/landing, dashboard, KPIs, analytics, guided/wizard flow, composite or comparison
     screen) → a page **intent** (`source: { kind: "intent" }`). State each classification out loud;
     if the app needs no pages, say so and why rather than silently omitting them. Then forms + views
     + charts + sample data and the optional `design` contract, mapping each job to its surfaces via
     `jobs[].surfaces[]`. **No page `.tsx` here.** `dashboards[]` only on explicit request.
   - **Level (c) — access** (`personas[].jobs[].privileges[]`): personas and jobs already exist from
     (a0) and the entities now exist, so **only add the privileges each job needs** — don't re-ask who
     the users are. The builder unions them into one role per persona and grants the app to it so it
     **opens for that persona, not just sysadmins**. **Render the roles + per-entity access as a table
     in your chat reply** (the user can't approve an access model they can't see — see the CRITICAL
     note above). If they want no roles, tell them jobs live in `personas[]` so dropping the roles
     drops the recorded jobs too; offer read-only privileges to keep the record. (Column-level
     security and access teams are not yet supported — see *Notes & limits*.)
   - **Whole-app preview** (design gate for Level (b)): `node "${PLUGIN_ROOT}/scripts/preview-app.js" --spec @<working-dir>/app-spec.json`
     renders data-model + sitemap + form wireframes + page-intents + design contract. **Reproduce the
     ENTIRE rendered output verbatim in your chat reply, inside a fenced ` ``` ` code block — do NOT
     leave it in the (collapsed, invisible) tool output, and do NOT just summarize "the preview looks
     right" (see the CRITICAL note above).** The user must be able to SEE each form, the sitemap, and
     the page intents they are approving. For a single form only: `node "${PLUGIN_ROOT}/scripts/preview-form.js" --spec @<working-dir>/app-spec.json`.
   - **Don't pre-create tables/columns** — the build does it idempotently.
5. **Guardrail lint (hard gate)** — run the **full** lint on the complete spec; **errors block**, warnings teach. If it blocks (or warns), **paste the findings into your chat reply** — tool output is collapsed and invisible to the user (see the CRITICAL note above), so the user can't fix what they can't see:
   ```bash
   node "${PLUGIN_ROOT}/scripts/lint-app-spec.js" --spec @<working-dir>/app-spec.json --json
   ```
   This runs migration and `validateAppSpec` — the gates the build itself runs on load — plus the `lintAppSpec` authoring guardrails, which the builder does **not** run. It exits non-zero on errors. It validates under the `plan` profile (which allows not-yet-generated intent pages), matching Step 6's dry run.
6. **Plan-mode approval (the single build approval)** — present the plan **including the build
   dry-run's phase-grouped plan** (run `build-model-app.js` without `--apply`, using the `plan`
   profile that allows intent pages) inside `EnterPlanMode`, then `ExitPlanMode` to get the user's
   go-ahead. On approval, **Phase 1.5** (generate-pages) runs first, then **Phase 2** applies
   directly (no second dry-run/go-ahead). Render the design document — never hand-write it:
   ```bash
   node "${PLUGIN_ROOT}/scripts/write-app-spec-doc.js" --spec @<working-dir>/app-spec.json --env <envUrl>
   ```
   It writes `<working-dir>/model-app-plan.md` (jobs → surfaces traceability, data model, every
   surface, navigation, access model, sample data) and prints `{ ok, docPath, bytes, warnings }`.
   **Surface those `warnings`** — they name design gaps such as a job with no covering surface, an
   app with no generative pages, or a new table that no persona and no `roleGrants[]` entry grants a
   privilege on. With `--env` the document also lists, read-only, the roles the app already has
   associated with it, apart from the privileges on the tables the spec adds (opening the app and using
   a table are two questions); a read that fails is reported in the document as "not checked" and does
   not fail the command. Tell the user where the document is; it's theirs to keep, and it's
   regenerable after any spec edit.

### Phase 1.5 — Generate pages (main loop, headless workers)

After plan-mode approval (before the full build):

1. **Data pre-build** — schema-only build so `genpage.js types` can resolve real column names:
   ```bash
   node "${PLUGIN_ROOT}/scripts/build-model-app.js" \
     --env <envUrl> --spec @<working-dir>/app-spec.json --stage data --apply
   ```
   `--stage data` applies solution + data-model only — **no `--sample-data`** (rows are created
   once in the full build). Only `--stage data` is apply-safe; all other `--stage` selectors
   and legacy `--from/--to/--only/--skip` selectors are dry-run inspection only.

2. **Types** — generate Dataverse type bindings for the entities the pages read:
   ```bash
   node "${PLUGIN_ROOT}/scripts/genpage.js" types --env <envUrl> --data-sources "<entity1,entity2,…>" --output-file <working-dir>/RuntimeTypes.ts
   ```
   `--data-sources` is the union of every intent page's `dataSources`. Skip this step entirely when
   every intent page is mock-only. On Windows use forward slashes in the path. The script prints
   `{ "ok": true, "outputFile", "dataSources", "detail", "bytes" }`; a failure (exit 1, `"ok": false`)
   stops the step — report why, since the page workers must not guess column names.

3. **Page plan (adapter)** — the page worker's input contract is a *plan document*, not an App Spec,
   so project the spec into one. This also echoes the per-page dispatch parameters:
   ```bash
   node "${PLUGIN_ROOT}/scripts/write-page-plan.js" \
     --spec @<working-dir>/app-spec.json --working-dir <working-dir> --env <envUrl> \
     --app "<app name>" --languages "<languages from the environment probe>"
   ```
   It writes `<working-dir>/app-builder-page-plan.md` and prints
   `{ ok, planPath, pages: [{ name, key, file, dataMode, intent }] }`. Pass `--languages` through
   from the environment probe — omitting it silently defaults every plan to English-only and drops
   the localization pattern. The command fails (before writing) if the plan would name a sample that
   doesn't exist, or if a page a worker will write is not a safe target in the working directory — a
   link at its path, a folder that links outside the directory, or a page already there under another
   spelling — or if a link, a hard link or a folder is already at the plan's own path. Stop and fix
   what it names; do not dispatch any worker.

4. **Generate** — for each page from step 3 with `intent: true`, dispatch the **headless**
   `genpage-page-builder` worker via `Task`. Use its documented input contract verbatim — a missing
   field is why a page silently never becomes `.tsx`:

   > You are the genpage-page-builder agent. Generate the **[name from step 3]** page.
   >
   > - Target file: [file from step 3 — already includes .tsx; do NOT append another]
   > - Plan document: [absolute path to the app-builder-page-plan.md written in step 3]
   > - Data mode: **[dataMode from step 3 — `dataverse` or `mock`]**
   > - Connectors: **none**
   > - Telemetry: **disabled**
   > - RuntimeTypes: [absolute path to RuntimeTypes.ts]   ← omit this line when Data mode is `mock`
   > - Working directory: [absolute working-dir path]
   > - Plugin root: ${PLUGIN_ROOT}
   >
   > Follow the instructions in your agent file. Write [file] and return your result when done.

   The plan's `## Environment` carries `Mode: app-builder` and every page row carries a **Key**, so
   the worker emits `"PAGEREF_<key>"` for cross-page navigation (never a file-derived token — a
   downloaded page's `codeFile` is a path, not its identity). Custom nav ids go in `data:` — never
   `recordId`. `Connectors: none` and `Telemetry: disabled` are constants here: `/app-builder` writes no
   connector code (the App Spec's `connectorBindings` / `actionBindings` are lists a downloaded page already
   holds, carried through a rebuild and never authored here, so the projected plan always says
   `No connector bindings.`), and `/app-builder` never runs the Phase 4.7 `custom-telemetry` probe. Both are stated explicitly
   rather than omitted — the page-builder treats a missing line as the same fail-closed value, but
   an explicit line is what makes the dispatch contract checkable.

5. **Check styles, then validate + commit the transition (transactional)** — the workers have no
   shell, so first check every generated page for the Griffel shorthands that `makeStyles` drops at
   runtime, one command per page (`<file>` is the page's file from step 3):
   ```bash
   node "${PLUGIN_ROOT}/scripts/check-griffel-styles.js" --file <working-dir>/<file>
   ```
   Griffel does not support ten CSS shorthands, and `makeStyles` drops them at runtime: the page
   type-checks, transpiles and deploys, then renders without the border, color or reset. They are
   `all`, `borderColor`, `borderStyle`, `borderWidth`, `borderBlock`, `borderBlockStart`,
   `borderBlockEnd`, `borderInline`, `borderInlineStart` and `borderInlineEnd`. Write longhands
   instead: `borderColor`, `borderStyle` and `borderWidth` become one longhand per side, `border` +
   `Top`, `Right`, `Bottom` or `Left` + `Color`, `Style` or `Width` (`borderWidth` →
   `borderTopWidth`, `borderRightWidth`, `borderBottomWidth`, `borderLeftWidth`); `borderBlock`,
   `borderInline` and their `Start` and `End` forms become the `Width`, `Style` and `Color` longhands
   of the sides they name (`borderBlockStart` → `borderBlockStartWidth`, `borderBlockStartStyle`,
   `borderBlockStartColor`; `borderBlock` → those and the three `borderBlockEnd…` ones); `all` has no
   longhands, so set the properties you need one by one. Every other shorthand (`padding`, `margin`,
   `border`, `borderRadius`, `gap`, `outline`) is supported, and an inline `style={{ … }}` is not
   Griffel at all.

   `check-griffel-styles.js` prints each problem it finds — a key Griffel drops in a `makeStyles`
   call, at any depth, with its line, column and longhands, or a call or a style object it cannot
   read, with what to change — and exits 3 while any is left: fix what it reports and run it again,
   and do not transpile or upload the page until it exits 0. It reads the style objects written
   inline in the call, `makeStyles({ … })`, so write them there: one passed or spread in from
   elsewhere (`makeStyles(styles)`, `...base`) is reported, because the check cannot see its keys,
   and so is a key computed from an expression (`[key]: …`), whose name it cannot see (a template
   that starts with `--`, `&`, `:` or `@` is read); Fluent's `...shorthands.*(…)` and
   `...typographyStyles.*` may be spread as they are.

   Review every generated page for iteration that another page compiler can lose as well:

   Pages this plugin uploads are compiled with iterator support (ES5 with `downlevelIteration`), so a
   spread, a `for...of` loop or an array destructure of a Map, Set, iterator, generator or string
   reads it as modern JavaScript does. A tool that compiles the page again without that support — an
   older maker portal, or `pac` — reads length and indices instead: values disappear, defaults replace
   them, and rest destructuring or a string spread throws, all with a clean compile. Keep the page
   correct under every compiler: convert with `Array.from(...)` before spreading, looping or
   destructuring, for example `[...new Set(xs)]`, `[...m.values()]`, `[...seen.values()]`, `for (const
   [k, v] of m)`, `new Set([...prev, id])`, `[...selected]` and `[...text.matchAll(re)]`; copy a Set
   with `new Set(prev)` then `.add(id)`. Ordinary array spreads and loops remain valid. `Object.keys`,
   `Object.values` and `Object.entries` return arrays. Rest destructuring of an array-like without
   `slice` throws under every compiler. A destructuring default must not write to the array being
   destructured: `const [a = (values[1] = 3), b] = values` leaves `b` at its old value here, unlike
   modern JavaScript. See **Common Errors > 5. Iteration that another page compiler can lose** in
   `references/rules.md` for the pairs.

   Then validate and commit the transition — never flip `source` by hand, and never
   flip pages one at a time as workers return. Run:
   ```bash
   node "${PLUGIN_ROOT}/scripts/promote-intent-pages.js" \
     --spec @<working-dir>/app-spec.json --working-dir <working-dir>
   ```
   It checks every generated page (file written, structurally a module, `PAGEREF_` tokens
   canonical and in exact parity with the spec's `navigatesTo` edges) and only then flips **all**
   of them `intent → { kind: "tsx", codeFile }` in a single atomic write. On any failure it
   **exits 3 and leaves `app-spec.json` untouched**, printing which page failed and why —
   regenerate just those pages and re-run. All-or-nothing on purpose: a half-flipped spec would
   claim a `.tsx` that was never written, and Phase 2's `deploy` profile fails fast on any
   remaining `source.kind === "intent"`.

6. Proceed to **Phase 2** (full idempotent build).

> ⚠️ The interactive author **never** runs inside a `Task` subagent. Only pure, headless
> code-gen workers are dispatched here — all user-facing prompts originate in the main loop.

### Phase 2 — Build (narrated, main loop)

> **Always use `scripts/build-model-app.js`. Never hand-write a builder.** It's idempotent
> (skips existing solution/tables/columns/relationships — so new, existing, and mixed envs all
> just work), so you don't pre-create anything or special-case existing tables.

**The build plan was already presented and approved in plan mode** (Phase 1 Step 6 shows the engine's
real dry-run plan), so on approval **apply directly** — one build approval, no second go-ahead. Add
`--verify` so the build self-checks after applying (see Phase 3):

```bash
node "${PLUGIN_ROOT}/scripts/build-model-app.js" \
  --env <envUrl> --spec @<working-dir>/app-spec.json --apply --verify [--sample-data] [--publish]
```

Each step streams its status live (`[n/total] ✓ created` / `⊘ skipped` / `✗ failed — <error>`) and a
closing `✓ build complete — X created, Y skipped, Z failed` summary.

> **Keep the build's progress visible.** A full build runs for several minutes. Let its output
> **stream** — do NOT pipe it through `Select-Object -First/-Last N` or `Select-String` head-limits,
> which buffer and hide progress until the run ends (and can truncate a still-running pipe). To
> capture the log use `Tee-Object -FilePath <log>` (no head-limit). The build also prints a
> `▸ live progress:` line pointing at `<workspace>/.maker-workspace/build-status.json` — a snapshot
> (`state`, `steps`, `lastPhase`, `lastLabel`) overwritten every step. Read it (or tail
> `build-log.jsonl`) any time to report where a long build is, even if stdout is buffered.

(**Reaching Phase 2 without a fresh plan-mode approval** — resuming a failed build, or a quick edit
re-run — do a **dry-run first** (drop `--apply`), **paste the phase-grouped plan verbatim into your
chat reply** (tool output is collapsed — see the CRITICAL note above), and get a go-ahead
before applying.)

**Stage selector (`--stage <data|ui|app|publish>`)** maps to its phase range. On `--apply`, ONLY
`--stage data` is accepted (solution + data-model, no rows in run 1; run 2 is a full build). All
other stages and the legacy `--from/--to/--only/--skip` selectors are dry-run inspection only —
their phase ranges are not dependency-closed and are rejected on `--apply`.

**Language (`--language-code` / `--languageCode <lcid>`)** — you normally do **not** pass this.
Data-model labels are
stamped with the organization's own base language, read once per build. Pass it only to author
labels in a different **provisioned** language, or if the build warns that it could not determine
the base language and fell back to 1033.

If you pass an LCID the organization has **not** provisioned, the build now stops in the data-model
phase, before any label is written, and lists the ones it does have. That check exists because
Dataverse handles this **inconsistently**: table and choice labels are accepted (HTTP 204) and
silently stored under the organization's base language, while `DateTime` and `Memo` columns are
rejected with *"The language code N is not a valid language for this organization"*. Without the
check a build therefore creates the table with the wrong labels and then dies partway through the
columns, phases away from the flag that caused it — which reads like an environment fault. List the
provisioned set with
`node "${PLUGIN_ROOT}/scripts/dataverse-request.js" <envUrl> GET RetrieveProvisionedLanguages`.
The check is best-effort: if that read fails the build proceeds unchanged.

The App Spec field `languageCode` pins the same value across runs. It now covers the **whole** build:
data-model labels, and form, dashboard and sitemap labels — the SDK serializers that used to hardcode
1033 take the authoring language as an option.

**Verify with the same flag.** A build run with `--language-code <lcid>` writes a form's tab and section
captions in that language, so run the standalone verifier with the **same** `--language-code <lcid>` (or pin
`languageCode` in the spec): without it, `--verify` looks for the captions in the organization's base language and
cannot confirm a correctly published form's captions (it lists them as unverified or reports them missing). The
build's own `--verify` is told the language automatically. If verify cannot establish the language at all (the
organization cannot be read), it lists those captions as **unverified** — neither passed nor failed — with the
reason: re-run it with the flag.

**A language the environment's form read does not show.** The platform decides which languages' labels the form's
FormXML carries, and it can return fewer than the form stores: a form built with Spanish (`3082`) captions in an
English-language organization reads back, with the Spanish captions stored, with its labels in English only. Verify
never calls a caption missing in a language the read does not carry, as long as the read carries labels in other
languages — it reads those captions from **one translation export of the app's solution** instead (a single extra request,
made only when there is such a caption: 7–11 s for a solution of one table, more as the solution grows; it shows the
published layer), so a right caption passes and a stale or empty one fails like any other, and a
`{ "1033": …, "3082": … }` label map is compared language by language the same way. When the export fails or cannot say (a
failed request, an archive it cannot read, no row for the form), verify lists the labels compared in that language as
**unverified** (neither passed nor failed; the run's result and exit status are unchanged), with the reason and the
languages the read does carry. Say so, and ask the user to check those captions in Power Apps with that language; do not
rebuild to "fix" them. A language the read does carry is still compared strictly, from the read: a stale caption in it
fails. A form whose read carries no label at all is not such a case: the captions the spec declares for it are missing, and fail.

Narrate progress as it runs. Transient env errors (a 429 or 503, a customization lock, a concurrent-operation
guard or a SQL timeout the service names by its error code, a timeout or reset of the connection) are
**auto-retried** with backoff on `--apply` (the build is idempotent, so a retry reuses what's already created).
A throttled service is waited for as long as it asks (`Retry-After`) — by the HTTP client's re-sends of a throttled read or service-protection-limited publish, by the page writes and by the build's own re-runs of a phase — inside one budget of five minutes per run for all the waiting
a throttle costs: when the next wait does not fit, the build stops with a `throttle-budget-exhausted`
halt that says what the service asked — run it again later and it continues. (A 5xx, a reset connection or a deadlock is not a throttle: those keep their own, shorter schedule and are not counted in it.) If the build still **halts** (`BuildHalt`) on an
unrecoverable error, surface it and ask the user how to proceed via `AskUserQuestion` (adjust the
spec / cancel), then re-run. Everything is scoped to a dedicated unmanaged solution; **`--publish`
gates the final *bulk* publish**, which also carries the edits made to existing views and forms.
Without it those edits — and always an existing app's sitemap re-sync — still publish their one
targeted artifact so the change takes effect (see *Notes & limits*).

**Recovery from a failed or halted build: run the full build again.** The build is idempotent — every
phase re-uses what's already created and only fills the gaps. SDK metadata is persisted under
`<working-dir>/.maker-workspace/` (override with `--workspace`). There is no apply-safe
`--from <phase>` shortcut; a full rerun is the correct and safe recovery path — after a `WEB_RESOURCE_UNVERIFIED`
halt too: a web resource was written but its publication could not be confirmed (often because another customization
held the environment's lock), the build recorded it, and a rerun using the **same writable workspace** writes it
again by its id (the page manifest only when its published copy does not already hold that content; otherwise the
rerun keeps it); do not delete or rename it. If the halt says its recovery record could not be saved, or reports
a conflicting name/id, follow that explicit resolution instead — automatic retry is unsafe without the identity.
One exception: an
`already-exists` halt recurs on a rerun until that workspace directory is deleted — follow its message.
Another: that workspace belongs to the environment it was first opened for. Only `--apply` opens it — a dry
run works in a temporary workspace, so it binds nothing, previews from any folder, and warns when an `--apply`
there would be stopped. A build pointed at a different `--env` **halts before reading or writing anything in
it** and names both environments. It is never cleared or re-bound for you — that discards the SDK's saved copies
of the other environment's artifacts, including any edit made in them that was never pushed, and the
page-ownership receipts and baseline kept beside them are that environment's too. Build against the
environment the halt names, or use a fresh app folder (copy `app-spec.json` and the files it names) or a new
`--workspace`. Only if that environment's copy of the app is no longer wanted, tear it down there with the
`--clear-workspace` command the halt prints, which keeps the folder while a page-ownership receipt remains. The
halt prints the folder on a line of its own, and that command takes it as `--workspace` — pass it exactly as
printed, quoted for your shell (inside double quotes PowerShell and bash expand a `$` in the path). A folder that
holds nothing a build saved — the SDK's empty folders only, which an earlier preview or a build that stopped at
its start leaves — is described as exactly that: nothing was built in that environment, so there is nothing to go
back to or tear down, and the folder can simply be deleted or moved aside. A folder whose `manifest.json` names
no usable environment, or is not valid JSON, halts too: move it aside (rename it rather than delete it — it can
hold page-ownership receipts and the baseline) and run again. The same environment under its other host name
(`<org>.api.crm…` against `<org>.crm…`) also halts: re-run with the host the halt names. The standalone verifier
never opens that workspace either, so it verifies any environment the app is deployed to.

Run only one apply command for an app in its workspace at a time, including its data stage and full build. If another build holds the build or pages lock, let it finish and then rerun the same full command; do not repeatedly launch retries, use a second workspace to bypass it, or delete the workspace. A lock refusal is on stderr with exit 1 and no stdout JSON; do not treat empty stdout as an unknown crash or a reason to reset the workspace. A teardown, download, standalone `/genpage` or `apps.js` mutation, or workspace clear is not stopped by this lock; do not run one against the same app/workspace beside the apply. A lock is abandoned only after its owner is confirmed no longer running; age alone is never sufficient. If automatic reclaim cannot complete, inspect the owner evidence and consider removing only the named lock/reclaim file manually after that confirmation. Keep the workspace and its recovery records. For concurrent-build protection, all overlapping build commands must use the new version. During a mixed-version transition, finish older builds first and keep the downloaded app unique name's spelling unchanged.

With `--publish`, the tables the build changed, and the tables whose forms or charts the app holds or is about to hold, are published in one
request before the build writes or publishes the app: the tables whose existing views and forms the build edited, the tables of the
charts it wrote, the navigation's tables whenever the build pushes the app (the SDK adds their active Main forms to it on every push the build
makes, so a form that is live with a label saved and not published would otherwise be pinned and published with the app before its table was:
the first build and the build that pins a form are covered the same way; a changed-only re-upload of a page that has to pin a default view
the app lost pushes and publishes the app through the page backend, whose push adds the view it pins and no form, so it names no table of
the navigation), and — for an app that already exists — the tables of the form and
chart components its saved component list names, whether or not the spec names the table (a form a maker added to it, say, one never
published included). A label someone saved and did not publish on a form of one of them would otherwise stay unpublished once the app
is published. A table the app is not known to hold a form or chart of is not published by it, so what a maker left unfinished there
stays unfinished: a table only declared in `entities` (the target of a lookup column, say), one that only a page reads, or one that
only `app.tables` pins. If the app's components cannot be read completely, or a read of them is ambiguous (a row of the component
list that cannot be placed included), the build publishes only the tables it changed and the navigation's, and says which read failed; run it again once the cause is cleared. That is one more
publish for a build that edits no existing view or form (a first build included); the final publish covers the tables the build has
artifacts of.
If that request is refused the build goes on, and says so: it names what it saved on those tables, the forms the app holds
there, or its write adds, whose labels someone else may have saved, and what the app's publish may leave out as a result.
A build that **halts with an error** publishes the views and forms it had deferred (best effort), then — when it stopped
before the publish phase — lists the forms, views and charts of the spec's tables (the tables its pages read included) that
are still saved but not published, what it created and anything anyone saved there, or says it could not read them and names
the tables to publish. Columns and other kinds of change are not in that list. A halt after the publish phase says nothing of
the kind.
One that is **killed** — Ctrl-C, a crash, a closed terminal — after those edits are saved but before
that publish cannot, so they stay saved but not live until the next build. Run the same full build
again: it publishes them without writing them again.

### Phase 3 — Verify & iterate
**`--apply --verify` already reconciled the spec against what deployed** (Phase 2) — the build appends a
`verify PASS` / `verify FAIL — N missing` line and **exits non-zero on a silent partial** (an artifact
created but not wired, or a phase that quietly produced nothing). To **re-check later** — e.g. after a
Maker change, without rebuilding — run the standalone read-only verifier (entities/columns/views/charts/
forms and sitemap subareas + icons; exits non-zero and lists anything missing):

```bash
node "${PLUGIN_ROOT}/scripts/verify-model-app.js" --env <envUrl> --spec @<working-dir>/app-spec.json [--language-code <lcid>]
```

Pass `--language-code` only if the build was run with it. A line starting `⊘` under the verdict is a check verify
could **not decide** (it is in the JSON result's `unverified` list): it is neither a pass nor a failure, so say what it
was and what settles it — the language of the captions, which `--language-code` gives, or captions in a language the environment's
form read does not carry that the translation export could not settle (the line says why), which only Power Apps can show — never report the run as "everything deployed" while
one is listed.

A `WARNING:` line on stderr — each one is repeated in the JSON result's `warnings` list, which is absent when there is
none — is advice, not a verdict: a spec an earlier release accepted that the build would now refuse (it names the column
or relationship and the fix for the next build), or a page workspace the run could not remove (it names the folder to
delete by hand). It changes neither `ok` nor the exit status, so a run that passes can still carry one: pass each on to
the user. A run that stops on an unexpected error prints that error and no JSON.

Then open the app in the browser. Refine `app-spec.json` and re-run Phase 2 to iterate.

**Teardown (cleanup).** To remove everything an App Spec built — e.g. a live-verification probe or a
failed build — run the classifier-safe teardown. It deletes only the artifacts the spec declares, in
dependency order (**app module → dashboards → command bars → forms → security roles → charts → views
→ reset enriched default views to drop parent lookups → relationships → AI row summaries → tables
[children-first] → web resources (generated app icon + page manifest + declared) → global choices →
solution**). Forms/charts/views/relationships are deleted **explicitly before tables** (a table
delete does not reliably cascade cross-references; it does remove the table's own columns). Security
roles come **after forms** because a form assigned to a role names it inside its own formxml, which
the platform counts as a dependency, and **before** relationships/tables because a role holding a
table's privileges can block that table's delete. Command
teardown removes the whole command bar for any entity the spec authored commands on. **Teardown only
deletes tables this build created** — a **system/standard table** (account, contact, …) is
auto-detected and **skipped**, and a **reused custom table** is skipped when its entity is flagged
`"existing": true`, so pre-existing data survives. The same flag protects **relationships and global
choices** — a download sets it on every one it recovers, so tearing down a downloaded spec never removes
a lookup column from a retained table or deletes a shared option set. Dashboards are found by name, so
teardown deletes only those the app's solution holds, never another app's namesake — and none when the spec
has no real solution to ask (the `Default` a download may leave); it keeps the solution itself while any step
failed, so a re-run can still tell, keeps the page manifest while the generative-pages step failed, so a
re-run still finds the pages the app authored, and keeps a table — with its icon web resource and a global choice its
columns bind, which the platform refuses to delete while the table exists, and its relationship to itself — while a
business rule on it could not be deleted (the rule's activated copy can never be deleted once its table is gone), so
a re-run deletes the rule first, then the table and what was kept with it. It never deletes the solution's
**publisher** (the build reuses one by prefix, and other solutions may share it); its closing summary says so in one line,
so tell the user the publisher stays and can be removed in Maker once nothing uses it. **Known limit — generative pages on
forms:** teardown deletes the app's generative pages even when a form still embeds one (the `MscrmControls.UxAgentControl`
control); the platform records no dependency for that and teardown reads no form, so the form is left pointing at a deleted
page. When the app has pages, tell the user before `--apply` and have them take each page off any form that shows it (or delete
that form) first. **Dry-run by default**; add `--apply
--allow-destructive` to actually delete (`--clear-workspace` also prunes `.maker-workspace/`).
**`--allow-destructive` is required for `teardown --apply`** — without it teardown refuses and
touches nothing.

```bash
node "${PLUGIN_ROOT}/scripts/teardown-model-app.js" \
  --env <envUrl> --spec @<working-dir>/app-spec.json [--apply] [--allow-destructive] [--clear-workspace]
```

**Safety flags (build + teardown).** The apply path is fail-closed against destructive operations:

- **`--allow-destructive`** — authorize destructive operations. For `build --apply`: authorizes
  overwriting an existing app in unattended mode, and allows explicit-layout form-field removals or
  sitemap-target drops; also authorizes DETACHING a `pages-removed` page's nav subarea (the page
  record is left deployed — it is not deleted). For form and sitemap removals, the authority covers
  the removals the last refusal or approved run recorded; if live state would lose anything more,
  the apply halts, lists only the newly destructive removals, and records that new list for review.
  A field or sitemap target that appears during a run is kept or halted before push, never removed
  unseen. The record is consumed only after a full successful build that ran the removal phases and
  kept nothing; it is kept on failures, partial runs, changed-only runs, unreadable records, and
  failed discovery. For `teardown --apply`: **required** — all deletes
  are destructive by construction, so teardown without this flag halts before touching anything.
- **Pages-phase safety HALTs.** The build halts on identity or safety violations rather than
  proceeding with potentially wrong state. Surface the HALT reason and follow the recovery hint:
  - `pages-identity-conflict` — spec `pageId` and manifest disagree on a key, or a duplicate id
    spans two keys. Resolve the conflict manually (re-download or delete the manifest).
  - `pages-manifest-corrupt` — the manifest cannot be parsed (two keys map to the same id). Delete
    the manifest web resource and rebuild from scratch.
  - `pages-removed` — a live page was dropped from the spec. Re-add it, or pass `--allow-destructive`
    to detach it from the nav (the page record stays deployed; rebuild finalizes the sitemap).
  - `pages-shared-across-apps` — the page appears in another app's sitemap, published or only saved (not yet
    published — an app that was never published counts). Detach it from that app — ask the user first, since this
    changes another app. The halt names the app and prints the command with the app's `id` filled in (`<id of app …>` stands where the id could not be read, and
    `scripts/apps.js list --env <envUrl> --search <name>` gives it); `node "${PLUGIN_ROOT}/scripts/genpage.js" remove-from-app --env <envUrl> --app-id <that app's id> --page-id <page id>`
    takes the page out of that app's navigation and publishes that app (everything it has saved goes live with
    it; the page itself stays). Or detach it in Maker. `--allow-destructive` does **not** bypass this halt.
    The build checks again right before it updates pages in place, so a page another app takes in while the build runs halts it
    there too ("became shared across apps while this build ran"); one taken in while the pages upload is reported after them as a
    warning naming the app, since it is written by then.
  - `pages-shared-check-failed` / `pages-existence-failed` / `pages-sitemap-read-failed` — a
    prerequisite read failed; the build can't proceed safely. Retry on a transient error; check
    permissions on a persistent one.
  - `pages-griffel-shorthand` — a page's `makeStyles` writes a CSS shorthand Griffel drops at runtime, so the page
    would deploy without its border, color or reset. The message names the page, each key's line and column, and the
    longhands to write; fix the page's source and re-run. Nothing was uploaded. It is raised for a page the build would
    create and for a page whose source changed since the last build; a page you did not touch that already has one is sent
    again as it is, with a warning (it renders without the key today). Deleting a key keeps the page looking as it does;
    writing the longhands makes the style start to render. The same halt reports a `makeStyles` call the check cannot read
    for certain as that — not as CSS Griffel drops — and says what to change in the code.
- **`--non-interactive`** — suppress interactive prompts (for automation / CI). A non-interactive
  build that encounters an existing app **fails** instead of warning-and-proceeding, unless
  `--allow-destructive` is also set. Does **not** grant destructive authority on its own — only
  `--allow-destructive` does.
- **`POWER_PLATFORM_SKILLS_NONINTERACTIVE=1`** (or `true`) — env-var equivalent of
  `--non-interactive`. Same semantics: suppresses prompts only, never authorizes destructive ops.
  Set this in CI job environments to avoid interactive-prompt hangs.
- In **autopilot / eval mode** (`--non-interactive` + `--allow-destructive`), `preview-app.js`
  is written to disk as the design artifact before plan execution; interactive consent gates are
  bypassed and the build is fail-closed against any destructive op not explicitly authorized.

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

**App-level features** (`ai.appFeatures`) — `formFill` (Copilot-assisted form fill), `nlSearch`
(natural-language grid/view search), `nlChart` (NL chart / AI data visualization), `m365` (M365
Copilot). All default to on except `m365`, which is left at its platform default; `false` writes an
explicit Off for this app (each setting's values: `references/app-spec-schema.md` → `ai`).

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
node "${PLUGIN_ROOT}/scripts/download-model-app.js" --env <envUrl> --app <appId|uniqueName|displayName> --out <working-dir>
```

`--app` resolves in identity order: app id (GUID) → `uniquename` → display name. Prefer the **unique
name** — it is immutable, while a display name can be renamed and is not unique. A display name that
matches more than one app is refused, listing the candidate unique names rather than guessing.

This reconstructs the app into `<working-dir>/app-spec.json`. **Round-trip scope — be precise, it is
not everything:**
- **Round-trips:** the sitemap → `appShell` (all subareas + icons), **every** generative page (read
  through the SDK; the pages are the sitemap's `GenPage` subareas, so Maker-added pages
  are included, and each keeps its own name, model, and connector and Custom API bindings —
  `connectorBindings` / `actionBindings`) into `pages[]` + their `.tsx`, the referenced
  entities (minimal — the build reuses existing tables), **classic dashboards** (id-passthrough tiles
  carrying the deployed view/chart ids), the icon web resources, and the solution.
- **Does NOT round-trip:** `forms[]`, `views[]`, `charts[]`, `commands[]` — they come back empty.
  All four **survive on the live app** (a rebuild preserves them by discovery), so a plain edit is
  safe; they just aren't editable through the downloaded spec. Change them in Maker or a fresh spec.
  The download names every one it leaves out — the command-bar buttons of the app's tables included —
  in its `NOTE` and its result's `notRoundTripped`, and lists them under `descriptionInventory` in the
  spec: tell the user before they rebuild the spec in another environment, which would not have them.
- **Roles are not in the spec, and a rebuild leaves them as they are.** A download carries no
  `personas[]`: the roles associated with the app stay as the environment has them. Keep `personas[]`
  out when you extend an app whose roles somebody else owns — a persona's role is converged to exactly
  the privileges declared, and a role the build did not author is refused. Give an existing role a new
  table with a `roleGrants[]` entry (additive; it does not associate the role with the app). Lint and
  the design document name each new table no persona and no grant covers, and `write-app-spec-doc.js
  --env` lists the roles the app has.

**Page bindings and another environment.** A page's connector and Custom API bindings are in the spec, by the
properties the references document — `logicalName`, `connectorId`, `dataset`, `tables`, `tableDisplayNames`,
`operations` for a connector binding; `name`, `isFunction`, `boundEntityLogicalName`, `displayName`,
`parameterKinds` for a Custom API binding — each with a value of a shape known to be safe, and by nothing else,
so a rebuild writes them back into this environment and into another one. A list in which any binding holds
anything else (a connection id, a credential, a property no spec states, a URL with a query) is **not** in the
spec at all: the pull's `pageBindings.notCarried` names the page, the list and the entry's place (never a value),
and the page keeps that list as it is. Tell the user, and that the page folder's own `config.json` still holds
everything — they must not commit or share that folder if a value there is a credential. A spec that states such
a binding is refused. A rebuild cannot make what the bindings *name*. When the pull's result carries
`pageBindings`, tell the user what it says before any rebuild into another environment: `neededInTarget` lists
the connection references (and the connections behind them), the Custom APIs and the service resources (a
SharePoint site and its list ids, say) that environment must already have, and `notCarried` the lists the spec
could not state (a rebuild into the same environment leaves those as they are; into another one, they are bound
with `/genpage`). The rebuild itself reads that environment's references before it writes anything: it **stops**
(`pages-binding-reference-conflict`, nothing written) at a connection reference of that name that is for another
connector — give the binding the logical name of a reference that is for the right connector, or set the
binding's `connectorId` to the one that environment has, and never pick a reference for the user — and its
warnings say by name each reference or Custom API that is not there yet, a reference that has no connection, an
operation the custom connector there does not define, and what it could NOT check (a row that did not say its
connector or connection, or operations no custom connector definition could prove): relay them. A binding named
exactly `WhoAmI` or `RetrieveVersion` is a reviewed built-in Dataverse operation, not a Custom API: the pull lists it
under `neededInTarget.dataverseOperations` (nothing to deploy), and a rebuild reads nothing for it and says
`These are reviewed built-in operation names; their availability in this environment or player and the signed-in
user's permissions were not checked.` — relay that too, never as "missing" and never as "compatible"
(`references/dataverse-operations.md`). Do not write bindings into a
spec yourself — they come from a page a pull read — and when you reset a page to `intent` to regenerate it, delete
its bindings from the spec: the generator writes no connector code.

Then:

1. **Always pull fresh at the start of an edit session** — someone may have changed the app in Maker. The
   build reads an etag when it hydrates, so a write against an artifact changed since the pull throws a
   version conflict → **re-pull and retry**, never clobber. Pull into the **same `<working-dir>`** every time:
   a page keeps the `key` its earlier download gave it (read from the `app-spec.json` already there, when that
   file names this app in `app.uniqueName`; matched by the page's id), and a copy of the spec deployed to
   another environment is bound to the pages it built there by those keys — a key that changed would update a
   different page. A new folder mints keys again. If the pull answers `"code": "page-keys-ambiguous"`, the
   earlier `app-spec.json` gives one key to two pages (or one page two keys) and **nothing was written**: show
   the user the message, which names the pages and keys, and either correct the file and pull again or —
   only when the user says so, because fresh keys can make a copy deployed elsewhere update the wrong
   pages — pull again with `--reset-page-keys`, which re-keys exactly those pages. If it answers
   `"code": "navigation-language-unknown"`, the environment's base language could not be read, so the
   language of the app's navigation titles is not known, and **nothing was written**: pull again, or pass
   `--language-code <lcid>` (the environment's base language — the flag the build takes; a spec already in
   the folder that pins `languageCode` needs neither). Do not guess it: a spec whose titles were read in the
   wrong language writes them over the right ones on the next build.
2. Edit `app-spec.json` (and any page `.tsx`) for the requested change. A page you edit by hand is
   checked like a generated one: run `node "${PLUGIN_ROOT}/scripts/check-griffel-styles.js" --file <page.tsx>`
   on it before you rebuild (the rule and the ten shorthands are in Phase 1.5, step 5) and fix what it
   reports. A key the page already had when it was downloaded is reported too: the deployed page renders
   without it today, so deleting it keeps the page looking as it does, while writing the longhands makes
   the style start to render — delete it unless the user wants that change. The build runs the same
   check on every page it uploads that is new or that you changed since the last successful apply of this app, and halts as
   `pages-griffel-shorthand` — naming the page, each key's line and column, and the longhands — so a page
   you changed does not reach the app with one. "Changed" is measured against the source that apply recorded for the page in
   `.maker-workspace/last-applied.json` (a successful full or changed-only apply, or a download, writes it; a failed or partial build records nothing).
   A page you did not touch is sent again as it is, and a
   key it already has only draws a warning — and so does a page you changed in a workspace that holds no record of it (a new or moved one, or
   another environment), where the build cannot tell what was sent: run the checker on that page yourself.
   A page you edit by hand also follows the iteration rule of Phase 1.5, step 5 (**Common Errors > 5.
   Iteration that another page compiler can lose** in `references/rules.md`): convert a Map, Set or
   iterator with `Array.from` before spreading, looping over or destructuring it. An upload compiles the
   changed page again with iterator support, so a form it already had now reads its values where an
   earlier release lost them, converted or not; convert such a form only when the requested change needs it.
3. **If the edit ADDS a page** (or resets a page's `source` back to `intent` to regenerate it),
   **re-run Phase 1.5 before Phase 2** — a downloaded spec contains only `kind: "tsx"` pages, so an
   added `intent` page has no code and Phase 2's `deploy` profile rejects it. Phase 1.5 is safe to
   re-run: `write-page-plan.js` projects **all** pages (so the worker sees the real nav graph), a
   worker is dispatched only where the echo says `intent: true`, and `promote-intent-pages.js`
   leaves built pages untouched. Editing an *existing* page's `.tsx` by hand needs no regeneration.
4. Re-run the **build** (Phase 2). It's idempotent: it reuses the existing app/tables/views, **updates
   each page in place** (matched by name → `--page-id`, so no duplicates), and **preserves the
   existing `GenPage` subareas** (the download enumerated them into `pages[]`/`appShell`, so the
   full-replace sitemap write never drops them).
5. **Verify** (Phase 3) to confirm only the intended change landed.

> **Prefer generative pages over classic dashboards** per the genpage-first policy. Classic dashboards
> do round-trip (id-passthrough tiles), but the views and charts their tiles point at do not, so they
> can only be edited in Maker.

## What the builder does (in order)

solution (idempotent) → data model — **discover** existing tables/columns/relationships via the SDK
(`findTables` / `findColumns` / `fetchEntityMetadata`) and create only what's missing (`createTable`
/ `createColumn` / `createRelationship`) → **sample data** (opt-in; relational/topological,
`$parent`→`@odata.bind` using the entity-set name) → **web resources** (opt-in;
`createWebResource` for form JS/HTML/CSS) → **views** → **charts** → **forms** (primary + columns
laid out, explicit `tabs` honored; sub-grids, quick-views, and form JS (`events[]`) applied as
canonical control cells / the `/bag/c` events region via the SDK's generic `addElement` surface)
→ **business rules** (`businessRules[]` — authored as the workflow object model through the bound
`CreateProcessWithWfomJson` member and activated; **skipped with a warning** on an environment that
does not declare that member) →
**business process flows** (`businessProcessFlows[]`; a category-4 process compiled from the
authored stages and activated — this goes through the SDK's generic artifact surface, a plain
`workflows` row, so it is NOT subject to the bound-member gate above) →
**command bar** (`commands[]`) → **classic dashboards** (opt-in)
→ **app module + sitemap** → **generative pages** (each page's `.tsx` was generated in Phase 1.5;
the build writes each `pages[]` page through the SDK, without placing it; then
the SDK rewrites the sitemap once to add the `GenPage` subareas) → **AI features** (opt-in) →
**security** (one role per `personas[]` entry, sized from its jobs' declared access; injects an
app-module read privilege and associates the app to each role so it opens for that persona) →
publish (opt-in). When the app has generative-page subareas the app module is created first WITHOUT
them (they can't resolve until the pages upload), then the pages phase rewrites the sitemap — except for a
new app whose navigation holds ONLY page subareas: its pages are created first, and then the app, with them
already in its first sitemap. All
Dataverse access goes through the SDK, so the downloaded metadata lands in `.maker-workspace/`.
Independent ops (columns, views/charts/forms) run with bounded parallelism; publish is one
round-trip per entity + the app. Views/charts build **before** forms so a sub-grid can reference the
child view id. Each step emits `[n/total]`.

## Notes & limits

- **Headless, no browser.** The SDK (`cds-maker-sdk`, vendored at `scripts/vendor/`) generates
  designer-grade FormXML/FetchXML/sitemap by reusing the designer's own serializers, and writes via
  the Web API using an `az`-token HttpClient. No relay, no designer tab.
- **Dedicated unmanaged solution per app** (review / teardown). **`--publish` gates the final
  *bulk* publish** of the app's entity + app customizations (one `PublishXml` for every entity and the
  app). With `--publish` that one publish also carries the default-view enrichment, and the tables the build
  changed, with the tables whose forms or charts the app holds or is about to hold, are published together once
  more, in one request before the app is: the tables touched by the reconcile of an existing form or view, form
  events and quick-view placement, so none of them publishes on its own, the tables of the charts the build wrote
  (a chart's description is saved on the unpublished layer), the navigation's tables whenever the build pushes the
  app (the SDK adds their active Main forms to it, and a form that is live with a label saved and not published
  would otherwise be pinned and published with the app before its table was; a table whose `app.mainForms` list
  keeps no form adds none; a changed-only re-upload of a page that has to pin a default view the app lost is
  covered too — its push adds the view and no form, so what it publishes ahead of the app is the tables of the forms and charts the app holds — and one that has nothing to pin publishes nothing), and — for an app that already exists — the tables of the form and chart components
  its saved component list names, a form a maker added to it and never published included, so a label saved and
  not published there is not held back by the app's publish. A table the app is not known to hold a form or chart
  of is not named (declared only, a lookup column's target, read only by a page, or only pinned in `app.tables`):
  a table's publish ships everything saved on it, whoever saved it. If the app's components cannot be read
  completely the build publishes only what it changed and what its write adds, and says which read failed. It
  does **not** suppress the small **targeted** publishes that edit/finalize paths must run so the change
  takes effect: without `--publish`, reconciling an existing form or view, wiring form events and
  placing quick-views each publish that one artifact, and with or without it, re-syncing an existing
  app's sitemap and finalizing the sitemap after generative pages publish the app, and repairing a
  lookup column still labelled with an old default publishes its table (an unpublished edit
  to a live artifact is invisible). A fresh build without `--publish` still leaves new
  tables/columns/relationships staged-but-unpublished in the solution.
- **Idempotent — but not full desired-state convergence.** Existing
  solution/tables/columns/relationships/views/charts/forms/commands/dashboards are detected and
  **reused**, so re-runs and existing-table envs work without collisions. **The caveat for EDITS:** a
  rebuild never removes an artifact you dropped from the spec, and re-applies only part of an edit to
  one that already exists. A **form** converges its fields (added; for an explicit layout, dropped ones
  pruned — see `prune: false` below), column counts and spans. A **view** only *adds* columns: a
  column removed from the spec, or a new column order, does **not** apply, and neither do its filters
  or sort. A changed column type, and an edited command or dashboard, are not re-applied at all; an
  existing chart takes only a changed description, an existing app takes a changed name and description
  (an app that was never published keeps its text and the build warns it was not applied, and so does one whose name or
  description is localized — only that text is held back: the other text and a routing description are applied, the SDK
  writes only what changed, and a text that is not plain is never sent, even when the SDK's own read of the header fails;
  the icon is set when the app is created: a
  different `app.icon` is reported as not applied), and an existing
  business process flow takes the stage and step edits that cannot move a record — a stage added or renamed,
  a step added, renamed, rebound or moved — and refuses, saying why, one that would remove a stage or a step
  or reorder the stages (no stage or step edit is then applied; the requested Active/Draft state is handled
  independently).
  **To apply one of those edits, change it in Maker, or `teardown --apply` then rebuild fresh.**
  `--verify` catches what is **missing** — a spec view column, filter condition or sort key (authored
  sort keys must also keep their order), a relationship, a table's command bar, a status reason, an alternate key
  or a dashboard — as a loud `verify FAIL`. It tolerates **extra** deployed content, so
  a view column, filter or sort key you removed from the spec still passes, just as one a maker added
  by hand does. Individual command controls are not verified.
- Not in scope (later): **conditional** command visibility (Power-Fx-only), **titled
  command groups** (from-scratch — needs an SDK-synthesized parent row), lookup/associated views,
  multi-area sitemaps, **column-level (field) security**, and **access teams / hierarchy security**
  (both tracked SDK follow-ups). The security surface today is role-per-persona plus per-form role
  assignment, and both of those ship. Also out of scope: the BPF knobs the spec gate rejects
  (cross-entity stages, branching, stage actions).
- **Environment-gated (may not work where you are running):**
  - **Business rules** (`businessRules[]`). The SDK writes a rule through the bound
    `CreateProcessWithWfomJson` member — the same one the modern business-rule designer uses — and
    **has no fallback**: the client-side workflow-XAML compiler it used to fall back on was removed
    upstream because it covered 4 of the 7 action types and a single clause, so it silently narrowed
    a rule into something that did not say what the author wrote. Environments that do not declare
    the member therefore **cannot host business rules at all** — and that is the common case, not an
    edge case. The build **skips** the rules, warns once naming the
    member, and builds everything else normally, so an app is never left half-created. If rules are
    essential, verify the environment first.
    **Business process flows are NOT affected by this gate** — a BPF is written as an ordinary
    `workflows` row through the SDK's generic artifact surface, with no bound member involved.
- Supported: the full data model — all column types, **AutoNumber primary**, global choices, status
  reasons, alternate keys, **N:N + junction-with-payload**; **`required` reconciled on existing
  columns** (`true`, `false` or `"recommended"` — anything else is refused at validation; an explicit
  `required` converges on rebuild; an omitted one never demotes) and **asked
  of a new table's primary column in its create**, said applied only once the SDK confirms it;
  **Boolean `defaultValue`**, whole-number **`integerFormat`** (incl. `Duration`), and per-column
  **write permissions** (`isValidForCreate` / `isValidForUpdate` / `isValidForRead` — this is how you
  make a column read-only), all applied on **create and on rebuild**; adaptive
  main forms with **1:N / N:N sub-grids** (placed between sections or in a tab / form-column with
  `tab` / `column` / `after` / `before`, and moved into place on rebuild); **per-field form control** (`readOnly` / `hidden` /
  `after` positioning, plus `prune: false` to edit a subset of a form non-destructively);
  **quick-create / quick-view forms** (`formType`) + **quick-view placement**
  (`forms[].quickViews[]`); **per-form security roles** (`forms[].securityRoles` — name the
  `personas[]` this form is offered to, or `everyone: true`; applied after the roles exist. A form
  with no assignment is visible to **every** role, so this **restricts** a form rather than granting
  it); **which form a table opens with** (`forms[].isDefault` / `entities[].mainFormOrder` set the
  table's Main Form Set order, on existing tables too — a user's remembered form still opens first for
  that user; see app-spec-schema.md); Choice-column charts; **business rules** (`businessRules[]` — authored as the modern workflow
  object model and activated; see the environment gate above); **security roles** (`personas[]` — one role per
  persona sized from its jobs-to-be-done, with app access so the app opens for non-admins);
  **dashboards** (`dashboards[]` — chart/list/iframe/webresource tiles) + **dashboard sitemap
  placement**; **generative pages** (`pages[]` — the genpage-first default, written through the SDK
  and surfaced as `GenPage` sitemap subareas; full **create + edit**
  round-trip via `download-model-app.js`); **modern command-bar buttons** (`commands[]`) incl.
  **flyout / split-button menus**; **rich view filters** (`eq-userid`/`this-week`/`in`/`not-in`);
  **custom grid rendering** (`entities[].columns[].visualization` — radial dial / line chart /
  heat map / star rating, preview); web resources + form JS event handlers; sample data with
  **multi-parent `$parents`** + **`statusReason`**. See [`docs/app-builder-capabilities.md`](../../docs/app-builder-capabilities.md) and
  [`references/app-spec-schema.md`](../../references/app-spec-schema.md) (plus
  [`app-spec-schema-advanced.md`](../../references/app-spec-schema-advanced.md) for the conditional
  fields it points at) — author from those docs; you should not need to read the SDK, lint, or
  engine to write a spec.
