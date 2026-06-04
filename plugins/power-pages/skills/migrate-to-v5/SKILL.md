---
name: migrate-to-v5
description: >-
  Migrates a classic Power Pages site from Bootstrap 3 to Bootstrap 5. Downloads the
  site, runs the pac pages bootstrap-migrate engine, reviews the change report, applies
  AI-assisted fixes for the residual hierarchy/CSS changes the engine only flags, uploads
  the migrated site (which auto-enables the Bootstrap 5 runtime flag), verifies the flag,
  and validates. Use when the user wants to upgrade an older Bootstrap-3 portal to
  Bootstrap 5. NOT for code sites (React/Vue/Angular/Astro) — those are never Bootstrap-3.
user-invocable: true
argument-hint: Optional website name or local site folder path
allowed-tools: Read, Write, Edit, Bash, Grep, Glob, AskUserQuestion, Task, TaskCreate, TaskUpdate, TaskList
model: opus
---

> **Plugin check**: Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/check-version.js"` — if it outputs a message, show it to the user before proceeding.

# Migrate a Classic Power Pages Site from Bootstrap 3 to Bootstrap 5

Guide the user through migrating a **classic / native** Power Pages site from Bootstrap 3
to Bootstrap 5. Follow a systematic approach: verify tooling, acquire and back up the site,
assess scope, run the `pac pages bootstrap-migrate` engine, review the change report, apply
the residual fixes the engine can only flag, upload (which auto-enables the runtime flag),
verify, and validate.

## Core Principles

- **Classic sites only**: This skill targets classic Power Pages sites (Liquid web templates,
  `*.webtemplate.source.html`, `*.html/.aspx/.ascx`, `*.css`, `sitesetting.yml`). It does **NOT**
  apply to code sites (React/Vue/Angular/Astro) — they are never Bootstrap-3-based. If the target
  is a code site, stop and tell the user this skill doesn't apply.
- **The engine does the bulk; you do the residual**: `pac pages bootstrap-migrate` deterministically
  applies the well-known class renames. The skill's value is assisting with the **hierarchy / CSS
  changes the engine only logs** (see [references/bootstrap-v5-manual-fixes.md](references/bootstrap-v5-manual-fixes.md)).
- **Non-destructive, with a restore point**: The engine writes a **new `<folder>V5`** copy and never
  edits the source in place. Still, snapshot the source folder (git) before doing anything.
- **Assist and flag — never silently rewrite**: Residual fixes are Liquid-aware and can break layouts.
  Apply them with per-category consent; when a case is ambiguous (e.g. Liquid conditionals), flag it
  for the user instead of guessing.
- **Verify the runtime flag flip via `pac-log.txt`**: `pac pages upload` flips the server-side
  Bootstrap 5 flag automatically, but **flip outcomes are logged and swallowed** by the CLI. Never
  trust the upload exit code alone. The authoritative record is the PAC diagnostic log (`pac telemetry
  status` → `pac-log.txt`); grep it for `BootstrapV5UploadPostProcessor`. The flip **requires an
  active portal** — a website record with no provisioned site logs `no portal found` and skips.
- **Use TaskCreate/TaskUpdate**: Create the todo list upfront with all 8 phases before starting work.

**Initial request:** $ARGUMENTS

---

## Phase 1: Verify Prerequisites

**Goal**: Ensure PAC CLI is installed, the user is authenticated, the target environment is
confirmed, and the required commands are available.

**Actions**:

1. Create the todo list with all 8 phases (see [Progress Tracking](#progress-tracking)).
2. Run `pac help` to confirm PAC CLI is installed and on PATH. If missing, point the user to
   `https://aka.ms/PowerPlatformCLI` (`dotnet tool install --global Microsoft.PowerApps.CLI.Tool`)
   and re-verify.
3. Run `pac auth who`. If not authenticated, ask for the environment URL via `AskUserQuestion`,
   then `pac auth create --environment "<URL>"` and re-verify. Capture the environment name, URL,
   and ID.
4. Confirm the target environment with the user (`AskUserQuestion`: use this environment / choose
   another via `pac org list` + `pac org select`).
5. **Probe command availability** — both verbs are required:

   ```bash
   pac pages help
   ```

   Confirm `bootstrap-migrate` and `upload` appear in the verb list. If either is missing (feature
   not enabled in this CLI build / tenant), stop and tell the user the migration can't proceed
   until those commands are available.
6. **Locate the PAC diagnostic log** — capture the path now; you will need it in Phase 7 to verify
   the flag flip:

   ```bash
   pac telemetry status
   ```

   It prints `The diagnostic logs can be found at: <…>\logs\pac-log.txt`. This is a **rolling log
   across all `pac` runs** and is the **authoritative record of the Bootstrap V5 flag flip**. Note:
   `pac pages upload` writes **no per-folder log** — `pac-log.txt` is the only place its post-processor
   records the flip result. Set `PAC_LOG = <that path>`.

**Output**: PAC CLI verified, authenticated session, confirmed environment, `bootstrap-migrate`
and `upload` confirmed available, `PAC_LOG` path captured.

---

## Phase 2: Acquire the Site & Back Up

**Goal**: Get a local copy of the classic site to migrate, and establish a restore point.

**Actions**:

### 2.1 Locate or download the site

- **If the user provided a local site folder path** (or `$ARGUMENTS` names one): verify it exists
  and looks like a downloaded classic site (contains `website.yml` and `sitesetting.yml`). Use it
  as `SITE_FOLDER`.
- **Otherwise**: list available websites and download the chosen one.

  ```bash
  pac pages list
  ```

  Present the websites via `AskUserQuestion`, then download the selected site:

  ```bash
  pac pages download --path "<SITE_FOLDER>" --webSiteId "<WEBSITE_ID>"
  ```

  Use the downloaded directory as `SITE_FOLDER`.

> Confirm this is a **classic** site, not a code site. A code-site project has `powerpages.config.json`
> and a framework `package.json`; a classic site has `website.yml`, `sitesetting.yml`, and
> `*.webtemplate.source.html` files. If it's a code site, stop — this skill does not apply.

### 2.3 Confirm the site is ACTIVATED (not just a website record)

`pac pages list` shows **website records** (`adx_website`). A website record can exist with **no
provisioned/active Power Pages site (portal)** behind it — created by data import/clone, deactivated,
or orphaned. The Phase 7 flag flip (`SetPortalBootstrapV5Enabled`) targets the **portal**, not the
website record, so **if no active portal exists the flip silently skips and the live site won't
render** — and you won't find this out until after uploading unless you check now.

Resolve the site URL from `websitebinding.yml` (`adx_sitename`) and probe it:

```bash
curl -s -o /dev/null -w "%{http_code}" "https://<adx_sitename>/"
```

- **`200`** → active portal; proceed.
- **`5xx` with a Dataverse-connection null-ref** (`Object reference not set …` /
  `CrmOnlineOrganizationService.ToOrganizationService` on the error page) or a persistent `404/503`
  → **the site is most likely NOT activated**. This is the same condition that makes the Phase 7
  flag flip log `no portal found for website <id> via Power Pages API`.

If the site is not active, **stop and tell the user to activate/provision it first** (Power Pages
admin center, or the `/power-pages:activate-site` skill). Migrating content into an unactivated
website still uploads, but the runtime flag can't flip and the site can't be verified.

### 2.2 Snapshot the source

Create a restore point before any migration:

```bash
cd "<SITE_FOLDER>"
git init -q && git add -A && git commit -q -m "Pre-migration snapshot (Bootstrap 3)"
```

If the folder is already a git repo, just commit any pending changes so the pre-migration state
is captured.

**Output**: `SITE_FOLDER` resolved, confirmed classic, source snapshot committed.

---

## Phase 3: Pre-Migration Assessment

**Goal**: Set expectations by inventorying Bootstrap-3 usage and flagging risk areas before
running the engine.

**Actions**:

1. Scan the site for Bootstrap-3 markers using `Grep` over `*.html`, `*.aspx`, `*.ascx`, `*.css`:
   - Component classes: `panel`, `navbar-header`, `img-responsive`, `btn-block`, `pull-left|pull-right`,
     `col-(xs|sm|md|lg)-`, `glyphicon`, `label-`, `page-header`, `pager`, `data-toggle|data-dismiss`.
   - Count affected files and the rough number of occurrences per category.
2. Flag risk areas:
   - Heavy **custom CSS** (large `.css` files with non-Bootstrap selectors) — won't be auto-converted.
   - **Liquid-entangled markup** (`{% ... %}` around classes, conditional dropdowns) — needs review.
3. Present a concise scope summary and set expectations:

   > "This is an **assisted** migration. The engine will auto-apply the common Bootstrap 3→5 class
   > renames. Some changes (grid hierarchy, navbar structure, panel/page-header/pager styling) can
   > only be flagged — I'll help apply those in Phase 6. Visual parity isn't guaranteed and you'll
   > want to QA the result."

**Output**: Scope summary presented; user understands this is assisted, not push-button.

---

## Phase 4: Run the Migration Engine

**Goal**: Produce the migrated `<folder>V5` copy.

**Actions**:

1. Get explicit consent to run the engine (`AskUserQuestion`: "Run the Bootstrap 5 migration on
   `<SITE_FOLDER>`? This creates a new `<SITE_FOLDER>V5` copy and does not modify the original.").
2. Run:

   ```bash
   pac pages bootstrap-migrate --path "<SITE_FOLDER>"
   ```

3. Confirm the engine produced **`<SITE_FOLDER>V5`** containing:
   - Rewritten `*.html / *.js / *.aspx / *.ascx / *.css` files
   - Swapped `bootstrap.min.css` (Bootstrap 5)
   - Updated `sitesetting.yml` with a `Site/BootstrapV5Enabled` record
   - `logs.txt` and per-file `*-diff.json`

   See [references/migration-engine-reference.md](references/migration-engine-reference.md) for the
   full output contract. Set `MIGRATED_FOLDER = <SITE_FOLDER>V5`.

**Output**: `MIGRATED_FOLDER` produced with rewritten files, swapped CSS, `logs.txt`, and diffs.

---

## Phase 5: Review the Change Report

**Goal**: Turn `logs.txt` into a structured, grouped summary that surfaces the manual work.

**Actions**:

1. Read `<MIGRATED_FOLDER>/logs.txt` and categorize per the format documented in the engine
   reference. The report opens with three file lists — **no change**, **auto-applied**
   (Replacement/Addition/Deletion), and **hierarchy changes** (logged only) — followed by a
   per-file detail block (`Total Number of Changes:<n>` + change lines). Use `Grep` to count and
   locate the work:

   - `Grep` for `Need hierarchy change` → the manual hierarchy items (often **zero**).
   - The most reliable residual signal is the **V5 output itself**: `Grep` the migrated `*.html`
     for surviving Bootstrap-3 markers (`page-header`, `glyphicon`, `label-(info|danger|primary)`,
     `panel-(primary|success|info|warning|danger)`, `btn-block`, `navbar-header`). Whatever the
     engine left behind is exactly the Phase 6 work.

2. Present a summary:
   - Counts per category.
   - The list of files with **hierarchy changes** and **CSS-dependent contextual classes** (e.g.
     `panel-primary`) — these are the Phase 6 work items.

**Output**: Grouped change summary; explicit list of residual manual items.

---

## Phase 6: AI-Assisted Residual Fixes

**Goal**: Apply the structural / CSS fixes the engine flagged but could not safely auto-apply, in
the `MIGRATED_FOLDER` files.

> Reference recipes: [references/bootstrap-v5-manual-fixes.md](references/bootstrap-v5-manual-fixes.md)

**Actions**:

1. Group the residual items by category (grid hierarchy, navbar structure, panel/card styling,
   page-header, pager, btn-block, Liquid edge cases, partial paths).
2. For **each category**, get per-category consent (`AskUserQuestion`: "Apply the `<category>` fixes
   to `<N>` file(s)?"). On consent:
   - Apply the recipe from the manual-fixes reference using `Edit`.
   - Re-check the affected lines against the file's `*-diff.json` to confirm you didn't disturb
     auto-applied changes.
   - Commit per category: `git -C "<MIGRATED_FOLDER>" add -A && git commit -m "v5 fixes: <category>"`
     (init the V5 folder as a repo first if needed).
3. For **ambiguous / Liquid-entangled** cases, do **not** rewrite — list them for the user with the
   file and line and a suggested manual change.

**Output**: Residual fixes applied (or flagged) per category, each committed; ambiguous items listed.

---

## Phase 7: Upload, Auto-Enable Runtime Flag, and Verify

**Goal**: Upload the migrated site (which automatically flips the server-side Bootstrap 5 flag) and
**verify** the flag actually took effect.

**Actions**:

### 7.1 Pre-flight the manifest

The automatic flag flip is gated on two files in `MIGRATED_FOLDER`:

- `website.yml` must have a valid `adx_websiteid`.
- `sitesetting.yml` must contain `Site/BootstrapV5Enabled` with value `true`.

Verify both (`Grep`/`Read`). If either is missing, the flag flip silently no-ops — fix before uploading.

### 7.2 Final consent gate, then upload

This is the first **outward-facing** change. Get explicit consent (`AskUserQuestion`: "Upload
`<MIGRATED_FOLDER>` to environment `<ENV_NAME>`? This publishes the Bootstrap 5 site and enables the
Bootstrap 5 runtime."). On consent:

```bash
pac pages upload --path "<MIGRATED_FOLDER>"
```

Leave `--modelVersion` at its default (`Standard`) for a classic site. `pac pages upload` uploads the
content **and** auto-flips the server-side Bootstrap 5 flag via its post-processor (triggered by the
`Site/BootstrapV5Enabled=true` setting).

> Use `pac pages upload` — **not** `upload-code-site` (that is the code-site path and will corrupt a
> classic site).

### 7.3 Verify the flag flip (mandatory)

The CLI logs and **swallows** flag-flip outcomes, so a successful upload does **not** prove the
runtime is on Bootstrap 5. **The authoritative record is `pac-log.txt`** (the `PAC_LOG` path captured
in Phase 1), not the live site. Check it **first** — it is decisive in seconds, whereas the live
site can be misleading (an unactivated site throws a 500 that has nothing to do with Bootstrap):

```bash
# grep the PAC diagnostic log for the post-processor's result (most recent run is last)
grep -i "BootstrapV5UploadPostProcessor\|SetPortalBootstrapV5Enabled" "<PAC_LOG>"
```

Three possible outcomes:

| Log line | Meaning | Action |
|----------|---------|--------|
| `Set … BootstrapV5Enabled` / success (`INF`) | Flip **applied** | ✅ Proceed; optionally confirm on the live site. |
| `Skipping SetPortalBootstrapV5Enabled: no portal found for website <id> via Power Pages API` (`WRN`) | **No active portal** — flip never attempted | ❌ The site isn't activated. Activate it (see Phase 2.3 / `/power-pages:activate-site`), then re-run `pac pages upload`. |
| `ERR`/exception from the post-processor | Flip **attempted but failed** (auth/HTTP) | ❌ Re-confirm 7.1 manifest + permissions, then re-run upload. |

Then **corroborate on the live site** (only meaningful if the log shows *applied*): re-render a known
page and confirm the Bootstrap 5 bundle is served, or re-confirm the portal's Bootstrap V5 enabled
state via the Power Pages management surface. If the live URL returns a `5xx` with a Dataverse-connection
null-ref (`CrmOnlineOrganizationService.ToOrganizationService`), that is the **"site not activated"**
signature — match it against the log's `no portal found` line rather than treating it as a transient
restart.

**Output**: Migrated site uploaded; flag-flip outcome read from `pac-log.txt` (applied / skipped-no-portal
/ errored) and, when applied, confirmed on the live site.

---

## Phase 8: Validate & Summarize

**Goal**: Confirm the live site works on Bootstrap 5 and record the outcome.

**Actions**:

1. **Runtime smoke test** — invoke `/test-site` against the site URL to crawl key pages, verify they
   render, and capture console/network errors.
2. **Before/after visual check** — spot-check the highest-traffic pages (home, navbar, any
   panels/cards, forms, pagination) for layout regressions introduced by the migration.
3. **Record skill usage** — follow `${CLAUDE_PLUGIN_ROOT}/references/skill-tracking-reference.md`
   with `--skillName "MigrateToV5"`.
4. **Summary** — present:
   - Files changed per category (auto-applied vs assisted vs flagged-for-manual).
   - Residual items that still need human attention.
   - Confirmation the Bootstrap 5 runtime flag is enabled.
   - Location of the source snapshot (for rollback) and `MIGRATED_FOLDER`.
5. **Suggest next steps** — manual QA pass, `/test-site` re-runs, and (if promoting across
   environments) the ALM skills (`/plan-alm`).

**Output**: Site validated on Bootstrap 5, usage recorded, summary + residual list presented.

---

## Important Notes

### Throughout All Phases

- **Use TaskCreate/TaskUpdate** to track progress at every phase.
- **Ask for user confirmation** at the key decision points (below).
- **Present errors clearly** — show the relevant command output and explain it before suggesting fixes.
- **No automated rollback** after upload — rely on the Phase 2 source snapshot; report failures and
  continue/triage rather than auto-reverting.

### Key Decision Points (Wait for User)

1. Phase 1: If not authenticated, get environment URL; confirm/switch target environment.
2. Phase 2: If multiple sites, which website to download; confirm classic (not code) site.
3. Phase 4: Consent to run the migration engine.
4. Phase 6: Per-category consent before applying residual fixes.
5. Phase 7: Final consent before uploading (outward-facing).

### Progress Tracking

Before starting Phase 1, create a task list with all phases using `TaskCreate`:

| Task subject | activeForm | Description |
|-------------|------------|-------------|
| Verify prerequisites | Verifying prerequisites | PAC CLI, auth, environment, and command availability (`bootstrap-migrate`, `upload`) |
| Acquire site and back up | Acquiring site | Download/locate the classic site; snapshot the source |
| Pre-migration assessment | Assessing scope | Inventory Bootstrap-3 usage; flag custom CSS / Liquid risk |
| Run migration engine | Running migration | `pac pages bootstrap-migrate` → `<folder>V5` |
| Review change report | Reviewing report | Parse `logs.txt`; group auto-applied vs hierarchy/manual |
| Apply residual fixes | Applying fixes | Per-category assisted fixes for the flagged hierarchy/CSS items |
| Upload and verify flag | Uploading and verifying | `pac pages upload`; verify the Bootstrap 5 runtime flag flipped |
| Validate and summarize | Validating | `/test-site`, visual check, record usage, summary |

Mark each task `in_progress` when starting and `completed` when done via `TaskUpdate`.

---

**Begin with Phase 1: Verify Prerequisites**
