---
name: app-builder
version: 0.8.0
description: (Preview) Builds and edits a model-driven Power Apps app from a natural-language intent — tables, columns, relationships, adaptive forms with sub-grids, views, Choice-column charts, generative page intents for overview/dashboard surfaces (page `.tsx` generated in generate-pages after plan approval), and an app module + sitemap — via the headless cds-maker-sdk. Runs an interactive, multi-turn authoring flow (env selection, jobs-to-be-done first, then design-only App Spec authoring across confirmed levels, guardrail lint, plan-mode approval, generate-pages, full build) and a narrated build, and can download a deployed app back into an editable spec to change it. Use when the user says "build an app for X", "create a model-driven app", "make me an app to manage Y", or "edit/add to my app". For a standalone generative page that is not part of an app, use /genpage.
author: Microsoft Corporation
argument-hint: "<app description>"
user-invocable: true
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, Task, AskUserQuestion, EnterPlanMode, ExitPlanMode, TaskCreate, TaskUpdate, TaskList
---

# app-builder — intent → model-driven app

> ⚠️ **Preview.** This skill is in preview — its App Spec shape, flags, and build behavior may change
> between versions. Review the plan-mode summary before applying, and prefer a non-production
> environment while it stabilizes.

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

- **Data model** — tables (give each custom table a **meaningful Fluent-style SVG table icon by default** — see [`references/authoring-flow.md`](../../references/authoring-flow.md) → *Table icons*), columns (all types), relationships (1:N / N:N + junctions), sample data
- **Record UI** — forms (sub-grids, quick-create / quick-view), views (with enriched default columns), charts
- **Actions** — modern command-bar buttons (incl. flyout / split menus), web resources (form JS / HTML / CSS)
- **Surfaces** — **generative pages** (modern dashboards / overviews / analytics / landing — the default),
  classic dashboards (opt-in), external URLs
- **App shell** — the app module + sitemap, with per-subarea icons
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
  plan approval and after the data pre-build creates the tables so `pac model genpage generate-types`
  can emit `RuntimeTypes.ts`. See [`references/authoring-flow.md`](../../references/authoring-flow.md) → *Pages*.
- The build's `pages` phase uploads each page via `pac model genpage upload` **without
  `--add-to-sitemap`** — the SDK is the **single sitemap writer**, so a page's nav entry comes from a
  `page` subarea in `appShell` (referenced by the page's **`key`**). See
  [`references/app-spec-schema.md`](../../references/app-spec-schema.md) → `pages[]`.
- **Every page in `pages[]` must be sitemap-placed** — validation rejects any page absent from the
  sitemap. A "detail" page that receives a caller-supplied id is a normal sitemap page; it reads its
  input via `pageInput?.data?.<field>`. Navigation-only (headless) pages are not supported.
- **Three-authority page identity** (build + download + verify all follow this): (1) **IDENTITY** —
  the durable `<app>_pagemanifest` (`key → pageId`); a downloaded spec's own `pages[].pageId`
  outranks it for that rebuild. (2) **EXISTENCE** — env-wide `pac model genpage list` (crash-safe;
  decides create-vs-reuse). (3) **MEMBERSHIP** — the app's sitemap `GenPageId` set (placement,
  download enumeration, verify coverage). All matching is by id — never by display name.
- **Multi-page navigation uses `PAGEREF_<key>`** (the stable `pages[].key`) as the `pageId`
  placeholder; the build resolves each to the real page GUID in a run-scoped staging copy (the
  canonical `.tsx` is never mutated), then **verifies every nav edge** resolves to the deployed
  page's `GenPageId`.

## Workflow

### Phase 0 — Working directory
1. Derive a short kebab-case slug from `$ARGUMENTS` (e.g. "Project Tracker" → `project-tracker`).
2. `mkdir -p <slug>`; resolve its absolute path. It holds `app-spec.json`, `model-app-plan.md`, and `workflow-log.md`.

### Phase 1 — Author the App Spec (interactive, main loop)

Follow **[references/authoring-flow.md](../../references/authoring-flow.md)** step by step, running
every prompt yourself via `AskUserQuestion`. In short:

1. **Prereqs** — `node --version`, `pac help` (≥ 2.7.0).
2. **Environment (PAC)** — `pac auth list`. If exactly one / an active profile, **confirm it
   (FYI), don't ask**. If several and none active, **ask** which to use. If none, ask the user
   to `pac auth create`. Capture the org URL (`pac org who`).
3. **Detect existing** — `pac model list-tables --search …` (exact-match) and `pac model list`
   to find tables/apps already present; build *around* them.
4. **Levelled authoring** — **first read the App Spec format** so you author to the exact
   shape (do this once; don't go spelunking through scripts):
   [`references/app-spec-schema.md`](../../references/app-spec-schema.md) and the worked sample
   [`samples/app-spec.support-desk.json`](../../samples/app-spec.support-desk.json). Phase 1 is
   **design-only**: never emit page `.tsx` here. Each level is confirmed via `AskUserQuestion` before
   the next begins, and `app-spec.json` is persisted after each — full prompts in the playbook.
   - **Level (a0) — personas & jobs-to-be-done** (`personas[]`): **before proposing any tables**, ask
     who will use the app and what each needs to get done. Jobs drive everything that follows — a
     table exists because a job needs its data, a surface because a job needs to act on it. Deriving
     the data model first reliably misses surfaces. Privileges come later; capture the jobs now.
   - **Level (a) — data model**: entities/columns/relationships **derived from those jobs**; run the
     **early data-model lint** (catches e.g. the relationship-vs-lookup collision before forms are
     authored on top).
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
     note above). Skip only if the user explicitly wants no roles. (Column-level security and access
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
   directly (no second dry-run/go-ahead). Render the design document — never hand-write it:
   ```bash
   node "${PLUGIN_ROOT}/scripts/write-app-spec-doc.js" --spec @<working-dir>/app-spec.json --env <envUrl>
   ```
   It writes `<working-dir>/model-app-plan.md` (jobs → surfaces traceability, data model, every
   surface, navigation, access model, sample data) and prints `{ ok, docPath, bytes, warnings }`.
   **Surface those `warnings`** — they name design gaps such as a job with no covering surface or an
   app with no generative pages. Tell the user where the document is; it's theirs to keep, and it's
   regenerable after any spec edit.

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

2. **Types** — generate Dataverse type bindings for the entities the pages read:
   ```bash
   pac model genpage generate-types --data-sources "<entity1,entity2,…>" --output-file <working-dir>/RuntimeTypes.ts
   ```
   `--data-sources` is the union of every intent page's `dataSources`. Skip this step entirely when
   every intent page is mock-only. On Windows use forward slashes in the path.

3. **Page plan (adapter)** — the page worker's input contract is a *plan document*, not an App Spec,
   so project the spec into one. This also echoes the per-page dispatch parameters:
   ```bash
   node "${PLUGIN_ROOT}/scripts/write-page-plan.js" \
     --spec @<working-dir>/app-spec.json --working-dir <working-dir> --env <envUrl> \
     --app "<app name>" --languages "<languages from the environment probe>"
   ```
   It writes `<working-dir>/genpage-plan.md` and prints
   `{ ok, planPath, pages: [{ name, key, file, dataMode, intent }] }`. Pass `--languages` through
   from the environment probe — omitting it silently defaults every plan to English-only and drops
   the localization pattern. The command fails (before writing) if the plan would name a sample that
   doesn't exist.

4. **Generate** — for each page from step 3 with `intent: true`, dispatch the **headless**
   `genpage-page-builder` worker via `Task`. Use its documented input contract verbatim — a missing
   field is why a page silently never becomes `.tsx`:

   > You are the genpage-page-builder agent. Generate the **[name from step 3]** page.
   >
   > - Target file: [file from step 3 — already includes .tsx; do NOT append another]
   > - Plan document: [absolute path to the genpage-plan.md written in step 3]
   > - Data mode: **[dataMode from step 3 — `dataverse` or `mock`]**
   > - Connectors: **disabled**
   > - RuntimeTypes: [absolute path to RuntimeTypes.ts]   ← omit this line when Data mode is `mock`
   > - Working directory: [absolute working-dir path]
   > - Plugin root: ${PLUGIN_ROOT}
   >
   > Follow the instructions in your agent file. Write [file] and return your result when done.

   The plan's `## Environment` carries `Mode: app-builder` and every page row carries a **Key**, so
   the worker emits `"PAGEREF_<key>"` for cross-page navigation (never a file-derived token — a
   downloaded page's `codeFile` is a path, not its identity). Custom nav ids go in `data:` — never
   `recordId`. `Connectors: disabled` is a constant here: the App Spec has no connector-binding
   concept, so the projected plan always says `No connector bindings.`

5. **Validate + commit the transition (transactional)** — never flip `source` by hand, and never
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

Narrate progress as it runs. Transient env errors (429 customization-lock, 503 SQL-timeout,
concurrent-op guards) are **auto-retried** with backoff on `--apply` (the build is idempotent, so a
retry reuses what's already created). If the build still **halts** (`BuildHalt`) on an
unrecoverable error, surface it and ask the user how to proceed via `AskUserQuestion` (adjust the
spec / cancel), then re-run. Everything is scoped to a dedicated unmanaged solution; **`--publish`
gates the final *bulk* publish** — edit/finalize paths still publish their one targeted artifact so the
change takes effect (see *Notes & limits*).

**Recovery from a failed or halted build: run the full build again.** The build is idempotent — every
phase re-uses what's already created and only fills the gaps. SDK metadata is persisted under
`<working-dir>/.maker-workspace/` (override with `--workspace`). There is no apply-safe
`--from <phase>` shortcut; a full rerun is the correct and safe recovery path.

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
solution**). Forms/charts/views/relationships are deleted **explicitly before tables** (a table
delete does not reliably cascade cross-references; it does remove the table's own columns). Command
teardown removes the whole command bar for any entity the spec authored commands on. **Teardown only
deletes tables this build created** — a **system/standard table** (account, contact, …) is
auto-detected and **skipped**, and a **reused custom table** is skipped when its entity is flagged
`"existing": true`, so pre-existing data survives. **Dry-run by default**; add `--apply
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

**App-level features** (`ai.appFeatures`) — `formFill` (Copilot-assisted form fill), `nlSearch`
(natural-language grid/view search), `nlChart` (NL chart / AI data visualization), `m365` (M365
Copilot). All default to `true` except `m365`; set any to `false` to opt out.

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

This reconstructs the app into `<working-dir>/app-spec.json`. **Round-trip scope — be precise, it is
not everything:**
- **Round-trips:** the sitemap → `appShell` (all subareas + icons), **every** generative page (via
  `pac model genpage download`; names come from the sitemap's `GenPage` subarea titles, so
  Maker-added pages are included) into `pages[]` + their `.tsx`, the referenced entities (minimal —
  the build reuses existing tables), **classic dashboards** (id-passthrough tiles carrying the
  deployed view/chart ids), the icon web resources, and the solution.
- **Does NOT round-trip:** `forms[]`, `views[]`, `charts[]`, `commands[]` — they come back empty.
  All four **survive on the live app** (a rebuild preserves them by discovery), so a plain edit is
  safe; they just aren't editable through the downloaded spec. Change them in Maker or a fresh spec.

Then:

1. **Always pull fresh at the start of an edit session** — someone may have changed the app in Maker. The
   build reads an etag when it hydrates, so a write against an artifact changed since the pull throws a
   version conflict → **re-pull and retry**, never clobber.
2. Edit `app-spec.json` (and any page `.tsx`) for the requested change.
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
→ **app module + sitemap** → **generative pages** (each page's `.tsx` was generated in Phase 1.5;
the build uploads each `pages[]` page via `pac model genpage upload`, no `--add-to-sitemap`; then
the SDK rewrites the sitemap once to add the `GenPage` subareas) → **AI features** (opt-in) →
**security** (one role per `personas[]` entry, sized from its jobs' declared access; injects an
app-module read privilege and associates the app to each role so it opens for that persona) →
publish (opt-in). When the app has generative-page subareas the app module is created first WITHOUT
them (they can't resolve until the pages upload), then the pages phase rewrites the sitemap. All
Dataverse access goes through the SDK, so the downloaded metadata lands in `.maker-workspace/`.
Independent ops (columns, views/charts/forms) run with bounded parallelism; publish is one
round-trip per entity + the app. Views/charts build **before** forms so a sub-grid can reference the
child view id. Each step emits `[n/total]`.

## Notes & limits

- **Headless, no browser.** The SDK (`cds-maker-sdk`, vendored at `scripts/vendor/`) generates
  designer-grade FormXML/FetchXML/sitemap by reusing the designer's own serializers, and writes via
  the Web API using an `az`-token HttpClient. No relay, no designer tab.
- **Dedicated unmanaged solution per app** (review / teardown). **`--publish` gates the final
  *bulk* publish** of the app's entity + app customizations (a `PublishXml` per entity + the app). It
  does **not** suppress the small **targeted** publishes that edit/finalize paths must run so the change
  takes effect — reconciling an existing form or view, wiring form events, placing quick-views,
  re-syncing an existing app's sitemap, and finalizing the sitemap after generative pages each publish
  that one artifact (an unpublished edit to a live artifact is invisible). A fresh build without
  `--publish` still leaves new tables/columns/relationships staged-but-unpublished in the solution.
- **Idempotent — but ADDITIVE, not yet full desired-state convergence.** Existing
  solution/tables/columns/relationships/views/charts/forms/commands/dashboards are detected and
  **reused**, so re-runs and existing-table envs work without collisions. **The caveat for EDITS:** a
  rebuild is *additive* — it creates what's missing but does **not** re-apply changes to an artifact
  that already exists (a changed column type, a removed view column — `reconcileView` only *adds* —
  an edited form/command/dashboard), and never removes an artifact you dropped from the spec. **To
  apply a structural edit, `teardown --apply` then rebuild fresh.** `--verify` catches this: it
  checks **content** (a view's column set, relationship + command existence), so an unapplied edit
  surfaces as a loud `verify FAIL`, not a false pass. Full in-place convergence is tracked in
  `docs/app-builder-roadmap.md`.
- Not in scope (later): business rules, **conditional** command visibility (Power-Fx-only), **titled
  command groups** (from-scratch — needs an SDK-synthesized parent row), lookup/associated views,
  multi-area sitemaps, **column-level (field) security**, **access teams / hierarchy security** (the
  security surface today is role-per-persona only — a tracked SDK follow-up).
- Supported: the full data model — all column types, **AutoNumber primary**, global choices, status
  reasons, alternate keys, **N:N + junction-with-payload**; adaptive main forms with **1:N / N:N
  sub-grids**; **quick-create / quick-view forms** (`formType`) + **quick-view placement**
  (`forms[].quickViews[]`); Choice-column charts; **security roles** (`personas[]` — one role per
  persona sized from its jobs-to-be-done, with app access so the app opens for non-admins);
  **dashboards** (`dashboards[]` — chart/list/iframe/webresource tiles) + **dashboard sitemap
  placement**; **generative pages** (`pages[]` — the genpage-first default, uploaded via
  `pac model genpage upload` and surfaced as `GenPage` sitemap subareas; full **create + edit**
  round-trip via `download-model-app.js`); **modern command-bar buttons** (`commands[]`) incl.
  **flyout / split-button menus**; **rich view filters** (`eq-userid`/`this-week`/`in`/`not-in`);
  web resources + form JS event handlers; sample data with **multi-parent `$parents`** +
  **`statusReason`**. See [`docs/app-builder-roadmap.md`](../../docs/app-builder-roadmap.md) and
  [`references/app-spec-schema.md`](../../references/app-spec-schema.md) — author from that **single**
  doc; you should not need to read the SDK, lint, or engine to write a spec.
