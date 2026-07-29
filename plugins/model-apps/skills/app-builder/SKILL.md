---
name: app-builder
version: 0.7.0
description: (Preview) Builds and edits a model-driven Power Apps app from a natural-language intent — tables, columns, relationships, adaptive forms with sub-grids, views, Choice-column charts, generative page intents for overview/dashboard surfaces (page `.tsx` generated in generate-pages after plan approval), and an app module + sitemap — via the headless cds-maker-sdk. Runs an interactive, multi-turn authoring flow (env selection, design-only App Spec authoring with two consent levels, guardrail lint, plan-mode approval, generate-pages, full build) and a narrated build, and can download a deployed app back into an editable spec to change it. Use when the user says "build an app for X", "create a model-driven app", "make me an app to manage Y", or "edit/add to my app". For a standalone generative page that is not part of an app, use /genpage.
author: Microsoft Corporation
argument-hint: "<app description>"
user-invocable: true
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, Task, AskUserQuestion, EnterPlanMode, ExitPlanMode, TaskCreate, TaskUpdate, TaskList
---

# app-builder — intent → model-driven app

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

## CRITICAL — the user sees your chat message, NOT tool output

> **Shell/tool output — the result of running `preview-app.js`, a dry-run plan, or a lint —
> is COLLAPSED BY DEFAULT in the UI. The user does NOT see it unless they manually expand the
> tool panel.** Running the command is therefore NOT the same as showing the user. Every artifact
> the user must **read, review, or approve** — the whole-app **preview wireframes**, the
> **dry-run build plan**, and blocking **lint findings** — MUST be reproduced **verbatim in your
> chat reply**, inside a fenced ` ``` ` code block. Never say "the preview looks right" / "the plan
> is ready" and leave the actual content buried in a collapsed tool-output panel: **paste it into
> your message.** This is the #1 cause of "the wireframes aren't visible" — the preview ran, but
> its output stayed hidden in shell output.

## Capabilities — the full toolbox (pick best-fit per requirement)

You are a **complete** model-driven app builder, not a single-surface tool. Everything below ships in
one App Spec and one build — choose what best serves the user's requirement to make a **useful,
prod-ready** app; don't under-build (a bare table list) or over-build (surfaces the user didn't ask for):

- **Data model** — tables (give each custom table a **meaningful Fluent-style SVG table icon by default** — see [`references/authoring-flow.md`](../../references/authoring-flow.md) → *Table icons*), columns (all types), relationships (1:N / N:N + junctions), sample data
- **Record UI** — forms (sub-grids, quick-create / quick-view), views (with enriched default columns), charts
- **Actions** — modern command-bar buttons (incl. flyout / split menus), web resources (form JS / HTML / CSS)
- **Surfaces** — **generative pages** (modern dashboards / overviews / analytics / landing — the default),
  classic dashboards (opt-in), external URLs
- **App shell** — the app module + sitemap, with per-subarea icons
- **Security & access** — one **security role per persona**, sized from that persona's jobs-to-be-done
  (the entity access each job needs, unioned into the role). The app is granted to each persona role so
  it **opens for non-admins**, not just system administrators. Author via `personas[]` (see below).
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
- A generative page is authored as a **design intent** (`source: { kind: "intent" }`,
  `schemaVersion: 2`) during Phase 1 — its `.tsx` is **not** written yet. The page's `.tsx`
  is produced in **Phase 1.5 — Generate pages** after plan approval and after the data
  pre-build creates the tables so `pac model genpage generate-types` can emit `RuntimeTypes.ts`.
  See [`references/authoring-flow.md`](../../references/authoring-flow.md) → *Pages* and design §5/§8.
- The build's `pages` phase uploads each page via `pac model genpage upload` **without `--add-to-sitemap`** —
  the SDK is the **single sitemap writer**, so a page's nav entry comes from a `page` subarea in `appShell`
  (referenced by the page's **`key`**), which the SDK surfaces as a `GenPage` sitemap subarea. See
  [`references/app-spec-schema.md`](../../references/app-spec-schema.md) → `pages[]` for the field shape.
- **Every page in `pages[]` must be sitemap-placed.** Each `pages[]` entry must have a matching `page`
  subarea in `appShell` — validation rejects any page absent from the sitemap. A "detail" page that
  receives a caller-supplied id or other context is a normal sitemap page; it reads its input via
  `pageInput?.data?.<field>`. Navigation-only (headless) pages — reachable only via `PAGEREF_` calls
  but absent from the sitemap — are not supported; the app does not own them.
- **Three-authority page identity** (build + download + verify all follow this):
  (1) **IDENTITY** — the durable `<app>_pagemanifest` (`key → pageId`); a downloaded spec's own
  `pages[].pageId` outranks it for that rebuild. (2) **EXISTENCE** — env-wide `pac model genpage list`
  (crash-safe; decides create-vs-reuse; a page orphaned by a prior crash is reused). (3) **MEMBERSHIP**
  — the app's sitemap `GenPageId` set (placement, download enumeration, verify coverage). All matching
  is by id — never by display name.
- **Multi-page navigation uses `PAGEREF_<key>`** (the stable `pages[].key`) as the `pageId` placeholder;
  the build resolves each placeholder to the real page GUID in a run-scoped staging copy (the canonical
  `.tsx` is never mutated). After applying, **every nav edge is verified**: the verifier confirms each
  declared `navigatesTo` target resolves to the actual deployed page's `GenPageId`.

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
   [`samples/app-spec.support-desk.json`](../../samples/app-spec.support-desk.json). Phase 1 is
   **design-only**: never emit page `.tsx` here.
   - **Level (a) — data model**: propose entities/columns/relationships; confirm via
     `AskUserQuestion`; run the **early data-model lint** (catches structural errors such as the
     relationship-vs-lookup collision before forms are authored on top).
   - **Level (b) — artifacts + page-intents + design**: once Level (a) is confirmed, propose
     forms + views + charts + sample data **and** page **intents** (key/name/purpose/dataSources/
     navigatesTo/pageInput, `source: { kind: "intent" }`) per the genpage-first policy above, plus
     the optional `design` contract. **Do not author page `.tsx` here.** Emit `dashboards[]` only
     on explicit request. Persist `app-spec.json` after each level.
   - **Level (c) — personas & access** (`personas[]`): identify the **personas** who will use the
     app (e.g. "Dispatcher", "Field Technician", "Sales Rep") and, for each, the **jobs-to-be-done**
     that persona performs. For every job, DECLARE the entity access it needs (read/create/write/
     delete/append/appendTo/assign/share at user/businessUnit/parentChild/organization scope) — the
     builder unions those into one security role per persona and grants the app to it so it **opens
     for that persona, not just sysadmins**. Propose the personas → jobs → access mapping and confirm
     via `AskUserQuestion`; **render the proposed roles + per-entity access as a table in your chat
     reply** (the user can't approve an access model they can't see — see the CRITICAL note above).
     Skip only if the user explicitly wants no roles authored. (Column-level security and access
     teams are not yet supported — see *Notes & limits*.)
   - **Whole-app preview** (design gate for Level (b)): `node "${PLUGIN_ROOT}/scripts/preview-app.js" --spec @<working-dir>/app-spec.json`
     renders data-model + sitemap + form wireframes + page-intents + design contract. **Reproduce the
     ENTIRE rendered output verbatim in your chat reply, inside a fenced ` ``` ` code block — do NOT
     leave it in the (collapsed, invisible) tool output, and do NOT just summarize "the preview looks
     right" (see the CRITICAL note above).** The user must be able to SEE each form, the sitemap, and
     the page intents they are approving. For a single form only: `node "${PLUGIN_ROOT}/scripts/preview-form.js" --spec @<working-dir>/app-spec.json`.
   - **Don't pre-create tables/columns** — the build does it idempotently.
5. **Guardrail lint (hard gate)** — run the **full** `spec-lint.js` on the complete spec; **errors block**, warnings teach. If it blocks (or warns), **paste the findings into your chat reply** — tool output is collapsed and invisible to the user (see the CRITICAL note above), so the user can't fix what they can't see:
   ```bash
   node -e "const{lintAppSpec}=require('${PLUGIN_ROOT}/scripts/lib/spec-lint.js');const s=require('<working-dir>/app-spec.json');const r=lintAppSpec(s);console.log(JSON.stringify(r,null,2));process.exit(r.ok?0:1)"
   ```
6. **Plan-mode approval (the single build approval)** — present the plan **including the build
   dry-run's phase-grouped plan** (run `build-model-app.js` without `--apply`, using the `plan`
   profile that allows intent pages) inside `EnterPlanMode`, then `ExitPlanMode` to get the user's
   go-ahead. On approval, **Phase 1.5** (generate-pages) runs first, then **Phase 2** applies
   directly (no second dry-run/go-ahead). Write `model-app-plan.md`.

### Phase 1.5 — Generate pages (main loop, headless workers)

After plan-mode approval (before the full build):

1. **Data pre-build** — schema-only build so `generate-types` can resolve real column names:
   ```bash
   node "${PLUGIN_ROOT}/scripts/build-model-app.js" \
     --env <envUrl> --spec @<working-dir>/app-spec.json --stage data --apply
   ```
   `--stage data` applies solution + data-model only — **no `--sample-data`** (rows are created
   once in the full build). Only `--stage data` is apply-safe; all other `--stage` selectors
   and legacy `--from/--to/--only/--skip` selectors are dry-run inspection only.

2. **Types** — generate Dataverse type bindings:
   ```bash
   pac model genpage generate-types
   ```

3. **Generate** — for each intent page (`source.kind === "intent"`), dispatch the **headless**
   `page-builder` worker via `Task` with the page intent + `RuntimeTypes.ts` + the optional
   `design` contract + the navigation graph (`PAGEREF_<key>` for cross-page links). Custom nav
   ids go in `data:` — never `recordId` (read as `pageInput?.data?.<field>`). Validate each
   generated page (compile/structure + verified columns + navigation), then flip `source`
   `intent → { kind: "tsx", codeFile }`. The transition is **all-or-nothing**.

4. Proceed to **Phase 2** (full idempotent build), which validates under the `deploy` profile
   and **fails fast** if any page is still `source.kind === "intent"`.

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
> which buffer and hide progress until the run ends (and can even truncate a still-running pipe). If
> you must capture the log, use `Tee-Object -FilePath <log>` (no head-limit). The build also prints a
> `▸ live progress:` line at start pointing at `<workspace>/.maker-workspace/build-status.json` — a
> single-object snapshot (`state`, `steps`, `lastPhase`, `lastLabel`) overwritten every step. Read it
> (or tail `build-log.jsonl`) any time to report where a long build is, even if stdout is buffered.

(**Reaching Phase 2 without a fresh plan-mode approval** — resuming a failed build, or a quick edit
re-run — do a **dry-run first** (drop `--apply`), **paste the phase-grouped plan verbatim into your
chat reply** (tool output is collapsed — see the CRITICAL note above), and get a go-ahead
before applying.)

**Stage selector (`--stage <data|ui|app|publish>`)** maps to its phase range. On `--apply`, ONLY
`--stage data` is accepted (solution + data-model, no rows in run 1; run 2 is a full build). All
other stages and the legacy `--from/--to/--only/--skip` selectors are dry-run inspection only —
their phase ranges are not dependency-closed and are rejected on `--apply`. Do NOT suggest
`--apply --stage ui`, `--apply --from <phase>`, or `--apply --skip data-model`.

Narrate progress as it runs. Transient env errors (429 customization-lock, 503 SQL-timeout,
concurrent-op guards) are **auto-retried** with backoff on `--apply` (the build is idempotent, so a
retry reuses what's already created). If the build still **halts** (`BuildHalt`) on an
unrecoverable error, surface it and ask the user how to proceed via `AskUserQuestion` (adjust the
spec / cancel), then re-run. Everything is scoped to a dedicated unmanaged solution; **`--publish`
gates the final *bulk* publish** — edit/finalize paths still publish their one targeted artifact so the
change takes effect (see *Notes & limits*).

**Recovery from a failed or halted build: run the full build again.** The build is idempotent —
every phase re-uses what's already created and only fills the gaps. SDK metadata is persisted under
`<working-dir>/.maker-workspace/` (override with `--workspace`), so edits reuse it. There is no
apply-safe `--from <phase>` shortcut; a full rerun is the correct and safe recovery path.

### Phase 3 — Verify & iterate
**`--apply --verify` already reconciled the spec against what deployed** (Phase 2) — the build appends a
`verify PASS` / `verify FAIL — N missing` line and **exits non-zero on a silent partial** (an artifact
created but not wired, or a phase that quietly produced nothing). To **re-check later** — e.g. after a
Maker change, without rebuilding — run the standalone read-only verifier (entities/columns/views/charts/
forms and sitemap subareas + icons; exits non-zero and lists anything missing):

```bash
node "${PLUGIN_ROOT}/scripts/verify-model-app.js" --env <envUrl> --spec @<working-dir>/app-spec.json
```

Then open the app in the browser. Refine `app-spec.json` and re-run Phase 2 to iterate.

**Teardown (cleanup).** To remove everything an App Spec built — e.g. a live-verification probe or a
failed build — run the classifier-safe teardown. It deletes only the artifacts the spec declares, in
dependency order (**app module → security roles → dashboards → command bars → forms → charts → views
→ reset enriched default views to drop parent lookups → relationships → AI row summaries → tables
[children-first] → web resources (generated app icon + page manifest + declared) → global choices →
solution**).
Forms/charts/views/relationships are deleted **explicitly before tables** (a table delete does not
reliably cascade cross-references; it does remove the table's own columns). Command teardown removes
the whole command bar for any entity the spec authored commands on. **Teardown only deletes tables
this build created** — a **system/standard table** (account, contact, …) is auto-detected and
**skipped** (never deleted), and a **reused custom table** is skipped when its entity is flagged
`"existing": true` in the spec, so pre-existing data survives cleanup. **Dry-run by default** — it
lists what it would delete and touches nothing; add `--apply --allow-destructive` to actually delete
(add `--clear-workspace` to also prune `.maker-workspace/`). **`--allow-destructive` is required for
`teardown --apply`** — a teardown without it will print a clear refusal and touch nothing.

```bash
node "${PLUGIN_ROOT}/scripts/teardown-model-app.js" \
  --env <envUrl> --spec @<working-dir>/app-spec.json [--apply] [--allow-destructive] [--clear-workspace]
```

**Safety flags (build + teardown).** The apply path is fail-closed against destructive operations:

- **`--allow-destructive`** — authorize destructive operations. For `build --apply`: authorizes
  overwriting an existing app in unattended mode, and allows explicit-layout form-field removals or
  sitemap-target drops; also authorizes DETACHING a `pages-removed` page's nav subarea (the page
  record is left deployed — it is not deleted). For `teardown --apply`: **required** — all deletes
  are destructive by construction, so teardown without this flag halts before touching anything.
- **Pages-phase safety HALTs.** The build halts on identity or safety violations rather than
  proceeding with potentially wrong state. Surface the HALT reason and follow the recovery hint:
  - `pages-identity-conflict` — spec `pageId` and manifest disagree on a key, or a duplicate id
    spans two keys. Resolve the conflict manually (re-download or delete the manifest).
  - `pages-manifest-corrupt` — the manifest cannot be parsed (two keys map to the same id). Delete
    the manifest web resource and rebuild from scratch.
  - `pages-removed` — a live page was dropped from the spec. Re-add it, or pass `--allow-destructive`
    to detach it from the nav (the page record stays deployed; rebuild finalizes the sitemap).
  - `pages-shared-across-apps` — the page appears in another app's sitemap. Detach it in Maker.
    `--allow-destructive` does **not** bypass this halt.
  - `pages-shared-check-failed` / `pages-existence-failed` / `pages-sitemap-read-failed` — a
    prerequisite read failed; the build can't proceed safely. Retry on a transient error; check
    permissions on a persistent one.
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
laid out, explicit `tabs` honored; sub-grids, quick-views, and form JS (`events[]`) applied as
canonical control cells / the `/bag/c` events region via the SDK's generic `addElement` surface)
→ **app module + sitemap** → **generative pages** (each page's `.tsx` was generated in Phase 1.5;
the build uploads each `pages[]` page via `pac model genpage upload`, no `--add-to-sitemap`;
then the SDK rewrites the sitemap once to add the `GenPage` subareas) → **AI features** (opt-in)
→ **security** (one role per `personas[]` entry, sized from its jobs' declared access; injects an
app-module read privilege and associates the app to each role so it opens for that persona) → publish
(opt-in). When the app has generative-page subareas the app module is created first WITHOUT them (they can't
resolve until the pages upload), then the pages phase rewrites the sitemap. All Dataverse access goes through the SDK, so the
downloaded metadata lands in `.maker-workspace/`. Independent ops (columns, views/charts/forms)
run with bounded parallelism; publish is one round-trip per entity + the app. Views/charts build
**before** forms so a sub-grid can reference the child view id. Each step emits `[n/total]`.

## Notes & limits

- **Headless, no browser.** The SDK (`cds-maker-sdk`, vendored at `scripts/vendor/`) generates
  designer-grade FormXML/FetchXML/sitemap by reusing the designer's own serializers, and writes
  via the Web API using an `az`-token HttpClient. No relay, no designer tab.
- **Dedicated unmanaged solution per app** (review / teardown). **`--publish` gates the final
  *bulk* publish** of the app's entity + app customizations (a `PublishXml` per entity + the app). It
  does **not** suppress the small **targeted** publishes that edit/finalize paths must run so the change
  takes effect — reconciling an existing form or view, wiring form events, placing quick-views,
  re-syncing an existing app's sitemap, and finalizing the sitemap after generative pages each publish
  that one artifact (an unpublished edit to a live artifact is invisible). So `--publish` controls the
  expensive bulk publish, not "zero publishes"; a fresh build without it still leaves new
  tables/columns/relationships staged-but-unpublished in the solution.
- **Idempotent — but ADDITIVE, not yet full desired-state convergence.** Existing
  solution/tables/columns/relationships/views/charts/forms/commands/dashboards are detected and **reused**,
  so re-runs and existing-table envs work without collisions or duplicates. **The important caveat for
  EDITS:** a rebuild is *additive* — it creates what's missing but does **not** re-apply changes to an
  artifact that already exists (a changed column type, a removed view column — `reconcileView` only *adds*
  spec columns — an edited form/command/dashboard), and it never removes an artifact you dropped from the
  spec. **To apply a structural edit, `teardown --apply` then rebuild fresh** (both fully converge from the
  spec). `--verify` now catches this: it checks **content** (a view's column set, relationship + command
  existence), so an unapplied edit surfaces as a loud `verify FAIL`, not a false pass. Full in-place
  spec-vs-deployed *diff* convergence is a tracked future increment (see `docs/app-builder-roadmap.md`).
- Not in scope (later): business rules, **conditional** command visibility (Power-Fx-only), **titled
  command groups** (from-scratch — needs an SDK-synthesized parent row), lookup/associated views,
  multi-area sitemaps, **column-level (field) security**, **access teams / hierarchy security** (the
  security surface today is role-per-persona only — the two are a tracked SDK follow-up). (Supported:
  the full data model — all column types,
  **AutoNumber primary**, global choices, status reasons, alternate keys, **N:N + junction-with-payload**;
  adaptive main forms with **1:N / N:N sub-grids**; **quick-create / quick-view forms** (`formType`) +
  **quick-view placement** (`forms[].quickViews[]` — embed a QuickView form via a lookup); Choice-column
  charts; **security roles** (`personas[]` — one role per persona sized from its jobs-to-be-done, with app
  access so the app opens for non-admins); **dashboards** (`dashboards[]` — chart/list/iframe/webresource tiles) + **dashboard sitemap
  placement** (a `dashboard` subarea, auto-pinned); **generative pages** (`pages[]` — the genpage-first
  default for overview/dashboard surfaces, uploaded via `pac model genpage upload` and surfaced as `GenPage`
  sitemap subareas; full **create + edit** round-trip via `download-model-app.js`); **modern command-bar buttons** (`commands[]` — JS
  on-click + static hidden/disabled) incl. **flyout / split-button menus** (`type` + `children[]`);
  **rich view filters** (`eq-userid`/`this-week`/`in`/`not-in`); web resources + form JS event
  handlers; sample data with **multi-parent `$parents`** + **`statusReason`** (Choice/MultiChoice labels
  auto-resolve).) See
  [`docs/app-builder-roadmap.md`](../../docs/app-builder-roadmap.md) and the one-page
  [`references/app-spec-schema.md`](../../references/app-spec-schema.md) — author from that **single**
  doc; you should not need to read the SDK, lint, or engine to write a spec.
