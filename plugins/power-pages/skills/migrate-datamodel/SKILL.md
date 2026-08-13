---
name: migrate-datamodel
description: >-
  This skill should be used when the user asks to "migrate to enhanced data model",
  "migrate from standard to enhanced", "switch to EDM", "migrate SDM to EDM",
  "upgrade data model", "migrate site data model", or wants to migrate an existing
  Power Pages site from the Standard Data Model (SDM) to the Enhanced Data Model (EDM)
  using PAC CLI.
user-invocable: true
argument-hint: Optional site name or WebSiteId GUID
allowed-tools: Read, Bash, Glob, Grep, AskUserQuestion, TaskCreate, TaskUpdate, TaskList
model: sonnet
---

> **Plugin check**: Run `node "${PLUGIN_ROOT}/scripts/check-version.js"` — if it outputs a message, show it to the user before proceeding.

> **Plugin check**: Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/check-version.js"` — if it outputs a message, show it to the user before proceeding.

# Migrate Power Pages Site from Standard to Enhanced Data Model

Guide the user through a comprehensive migration of an existing Power Pages site from the Standard Data Model (SDM) to the Enhanced Data Model (EDM). The skill is organized into **four high-level phases** — Site Discovery & Pre-checks, Customization Remediation, Migration Execution, and Post-Migration Validation. Each phase contains numbered sub-steps for granular execution and progress tracking.

> **Important:** This is a preview feature. EDM migration behavior may change before GA.

## Core Principles

- **Environment-aware**: Capture environment type (Dev/Test/UAT/Prod) for context and future ALM integration
- **Remediate before migrate**: Identify and fix customizations before executing the data model migration
- **Validate comprehensively**: Check CLI context, site discovery, dependencies, and templates before any execution
- **Confirm before executing**: Present all migration parameters and customization findings to user before proceeding
- **Track all operations**: Generate comprehensive reports documenting all commands, results, and fixes applied
- **Graceful failure**: Halt on blocking issues; guide user to support when needed

**Supported templates:** All Power Pages and D365 portal templates can be migrated, provided the corresponding V2 EDM solution is installed in the environment (see step 1.6). This includes Starter Layouts 1–5, Application Processing, Blank Page, Program Registration, Schedule and Manage Meetings, FAQ, Event Registration, and the D365 portal templates (Community, Customer Self-Service, Employee Self-Service, Partner).

> **PAC CLI version note:** Migration of D365 portal templates requires a recent PAC CLI build. Older builds may still reject these templates.

**Initial request:** $ARGUMENTS

---

## Live Execution Report

Throughout this skill, progress is mirrored to two files inside `<OUTPUT_DIR>`:

- `migration-state.json` — single source of truth for current state
- `sdm-to-edm-migration-report.html` — auto-regenerated from state after every update; user opens in browser to watch progress

**Init point.** As soon as `<OUTPUT_DIR>` is resolved (end of step 1.2) AND WebSiteId is known (from `$ARGUMENTS=GUID`, `website.yml`, or step 1.3 site discovery), run once:

```powershell
node "${CLAUDE_PLUGIN_ROOT}/skills/migrate-datamodel/scripts/update-state.js" --init --output-dir "<OUTPUT_DIR>" --website-id "<WEBSITE_ID>"
```

After init, each sub-step below ends with a **→ Update report** callout. Execute each as a `node update-state.js --output-dir "<OUTPUT_DIR>" <args>` call. The CLI accepts:

| Command | Use |
|---|---|
| `--set-step <id> --status <s> --output "<text>"` | Mark sub-step status + write its output line (status: `pending`/`in-progress`/`completed`/`blocked`) |
| `--set-phase <n> --status <s>` | Mark phase status (`pending`/`in-progress`/`completed`/`blocked`) |
| `--set-site '<json>'` | Update site card fields. Allowed keys: `name`, `portalId`, `slug`, `currentDataModel`, `template`, `environment`, `migrationMode`, `siteRoot` |
| `--set-approval <phaseId> <kind>` | Show approval banner; `kind` ∈ {`phase-start`, `in-phase`} |
| `--clear-approval` | Hide approval banner once user has approved (use only for in-phase gates that don't advance to a new phase) |
| `--approve-and-start <phaseId>` | Atomic: clear approval gate + mark phase in-progress in one render. Use this whenever the user answers a `phase-start` AskUserQuestion approval — avoids the transient "Awaiting Approval" pill that would otherwise flash between `--clear-approval` and `--set-phase`. |
| `--set-prompt <plugin\|dme> --status ready --path "<file>" --summary "<text>"` | Show augmented-prompt card |
| `--set-activity "<text>"` / `--clear-activity` | "Currently doing" text for long-running ops |
| `--render-only` | Re-render HTML from existing state (rare) |

> **Best-effort:** if any `update-state.js` call fails (e.g., node missing), log a warning and continue — the live report is informational, never a blocker for migration work.

> **Use the `Bash` tool for `update-state.js` calls, not `PowerShell`.** PowerShell parses `(...)` as subexpression syntax inside double-quoted strings, so JSON values containing parens — e.g., `"currentDataModel":"Standard (SDM)"` — error out with `'SDM' is not recognized as a name of a cmdlet`. The `Bash` tool runs through sh, which doesn't have this gotcha; single-quoted JSON works cleanly. The `update-state.js` script itself is pure Node and runs identically from either shell.
>
> If you must use PowerShell (e.g., automation requires it), avoid parens and em-dashes inside JSON values — use plain text like `"Standard SDM"` instead of `"Standard (SDM) — eligible for migration"`.

### Pointing the user at the report

The skill **opens the live report in the user's default browser exactly once** — right after `--init` succeeds at Checkpoint 1 (see step 1.2). On every subsequent state change, the file is rewritten in place, so the user just refreshes the already-open tab. After each major state change, **explicitly tell the user where the report is and prompt them to refresh** so they can verify before approving the next phase. The user shouldn't have to guess where files live. Use this pattern in the chat:

```
📄 Live execution report updated:
   <ABSOLUTE_PATH_TO>\sdm-to-edm-migration-report.html

Refresh the browser tab opened in Checkpoint 1 to review the plan/results before approving the next phase. (If you closed it, re-open the path above in your browser.)
```

Surface that callout at these **7 checkpoints**:

| # | Checkpoint | Files to point at |
|---|---|---|
| 1 | After `--init` runs (end of step 1.3) | `sdm-to-edm-migration-report.html` (initialized state) |
| 2 | End of Phase 1, before Phase 2 approval | `sdm-to-edm-migration-report.html` (shows full Phase 1 outcomes + plan for next phase) |
| 3 | After step 2.3 (Authoring Track) — customization CSV parsed | `customization-report.html` (findings catalog) |
| 4 | Mid-step 2.4 (Authoring Track) — after auto-rewrites are staged, before apply+upload approval | `remediation-diff.json` + `remediation-staged/` tree, augmented prompt files (review the **Remediation Diff** card in the live report) |
| 5 | End of Phase 2, before Phase 3 approval | `sdm-to-edm-migration-report.html` (shows Phase 2 outcomes) |
| 6 | End of Phase 3, before Phase 4 approval | `sdm-to-edm-migration-report.html` (shows EDM activation status) |
| 7 | Phase 3.1 (Data Diff Validation — pre-refs gate) | `migration-data-diff.json` + `sdm-to-edm-migration-report.html` (Pages & Components card now shows SDM↔EDM per-category pills) |

The skill-level approval prompt that follows (via AskUserQuestion) is for the **user's substantive approval to proceed** — not Claude Code's standard command-execution permission prompt. Always print the file paths in chat first so the user knows where to look.

---

## Phase 1: Site Discovery & Pre-checks

**Goal**: Gather all context needed to plan and execute migration safely. Establish CLI context, identify the target site, detect any prior migration state, verify dependencies and template packages, and select migration mode.

**Output**: Site identified and confirmed SDM, prior migration state known, dependencies verified, migration mode chosen. Durable values captured: `<SITE_ROOT>`, `<OUTPUT_DIR>`, WebSiteId, Portal Id (if available), template name, migration mode.

---

### 1.1 Establish CLI Context

**Goal**: Set up PAC CLI with correct version and establish authenticated connection to Dataverse

**Actions**:

1. **Create todo list** with the 4 high-level phases (see [Progress Tracking](#progress-tracking) table). Sub-steps within each phase are internal execution detail — agent doesn't need to surface them as separate todos.

2. **Check PAC CLI Installation**

   ```powershell
   pac --version
   ```

   - **If version >= 1.31.6**: Proceed to step 3.
   - **If not installed or version < 1.31.6**: Ask user:

     | Question | Header | Options |
     |----------|--------|---------|
     | PAC CLI is not installed or below v1.31.6. Would you like guidance on installation? | Install PAC CLI | Yes, guide me, I'll install manually |

     If "Yes, guide me": Provide OS-specific installation steps from <https://aka.ms/PowerPlatformCLI>

3. **Check Existing Authentication**

   ```powershell
   pac auth list
   pac auth who
   ```

   - **If authenticated**: Extract environment URL and ask user:

     | Question | Header | Options |
     |----------|--------|---------|
     | Current environment: `<ENV_URL>`. Is this correct for migration? | Confirm Env | Yes, correct, No, switch environment |

     - If "No": Run `pac auth select` to switch
     - If "Yes": Proceed

   - **If not authenticated**: Ask for environment URL and run:

     ```powershell
     pac auth create -u "<ENV_URL>"
     ```

4. **Inform About Requirements** (user must verify manually):
   - Role: System Administrator, Dynamics 365 Admin, or Power Platform Admin
   - Dataverse base portal package: 9.3.2307.x+
   - Power Pages Core package: 1.0.2309.63+
   - Environment mode: If admin mode, background operations must be enabled (warning only)

**Output**: PAC CLI installed/verified, authenticated to correct environment

---

### 1.2 Identify Site Context

**Goal**: Determine target site from local `website.yml` or user input, AND resolve where to place migration outputs

**Actions**:

1. **Resolve site location**

   Run these checks in order to determine `<SITE_ROOT>` (where the site source lives or will be downloaded to) and `<PARENT_OUTPUT_DIR>` (the parent directory under which step 1.3 will create a per-migration subfolder named `<env>--<slug>/` for all migration artifacts):

   ```powershell
   # Check A: is cwd itself a site root?
   Test-Path .\website.yml

   # Check B: if A is False, is there a single subdirectory containing a site root?
   Get-ChildItem -Directory | Where-Object { Test-Path (Join-Path $_.FullName 'website.yml') }
   ```

   Resolve based on results:

   | Result of check A | Result of check B | `<SITE_ROOT>` | `<PARENT_OUTPUT_DIR>` |
   |---|---|---|---|
   | True (cwd is the site) | — | `.` (cwd) | `..\migration-reports` (sibling of site dir, so site source stays clean) |
   | False | Exactly one subdir | `.\<subdir>` | `.\migration-reports` (in cwd alongside the site folder) |
   | False | Zero or multiple subdirs | (will download to `<MIGRATION_OUTPUT_DIR>/site-sdm/<auto-slug>` in step 2.1) | `.\migration-reports` (in cwd) |

   Capture both `<SITE_ROOT>` and `<PARENT_OUTPUT_DIR>` as durable values. The actual per-migration subfolder `<MIGRATION_OUTPUT_DIR>` is computed in step 1.3 and is used throughout the rest of the skill. Create `<PARENT_OUTPUT_DIR>` if it doesn't exist yet.

2. **Use website.yml if present**

   If a `website.yml` exists at `<SITE_ROOT>`, parse it and extract:
   - `adx_name` (site name)
   - `adx_websiteid` (site GUID)

   Ask user confirmation:

   | Question | Header | Options |
   |----------|--------|---------|
   | Found local website.yml for site: `<SITE_NAME>` (ID: `<WEBSITEID>`) at `<SITE_ROOT>`. Use this site? | Use Local Context | Yes, use this site, No, specify different site |

   - If "Yes": use extracted values; continue to step 1.3.
   - If "No": treat as if no website.yml; proceed to step 3.

3. **Get site identification from user**

   If no `website.yml` resolved or user declined, ask:

   | Question | Header | Options |
   |----------|--------|---------|
   | Provide the site name or WebSiteId (GUID) for migration | Site ID | I'll paste the site name, I'll paste the WebSiteId |

   Then prompt for the actual value in the chat (do not create a single-option AskUserQuestion — that errors with "expected array to have >=2 items"; ask in plain text or use 2+ options).

   In this path, `<SITE_ROOT>` will be set to the path step 2.1 downloads to (typically `<MIGRATION_OUTPUT_DIR>/site-sdm/<auto-slug>` once `pac pages download` runs). Downloading into the per-migration subfolder keeps every artifact for this site contained — multiple migrations sharing the same parent dir won't collide on the `site-sdm` / `site-edm` folder names.

**Output**: WebSiteId captured; `<SITE_ROOT>` and `<PARENT_OUTPUT_DIR>` resolved (or marked "download in step 2.2" for `<SITE_ROOT>`)

> **Live report init is deferred to the end of step 1.3.** The init command needs the environment name and the website slug to compute a per-migration subfolder; both are captured by `pac auth list` (step 1.1) and `pac pages list -v` (step 1.3) respectively. We don't write `migration-state.json` here in 1.2.

---

### 1.3 Site Discovery and Validate Data Model

<!-- not-a-gate: The `AskUserQuestion` references in this section are the template-family selection tree (pure data-gathering that only shapes the step 1.6 package check — no side effect to undo) plus prose mentions of the tool's 4-option limit. Per approval-gates.md §2, data-gathering prompts are not approval gates. -->

**Goal**: Find the site in the environment and verify it's on SDM (not already EDM)

**Actions**:

1. **List All Sites**

   ```powershell
   pac pages list -v
   ```

   Verbose output columns: `Index | Website Id | Portal Id | Friendly Name | Portal Url | Data Model Version | Single Page Application | Is Site Active`.

   Parse output to extract all available sites with:
   - WebSiteId
   - Portal Id (may render as `Unknown` if the Power Platform active-websites API failed, or `N/A` if the site is inactive — treat both as "missing" for the activation step in Phase 3, which prompts the user when Portal Id is needed)
   - Portal Url (full site URL from the `Portal Url` column; may be empty for inactive sites — store as `null` if so)
   - Site Name (display name from Friendly Name, the part before " - ")
   - URL slug (from Friendly Name, the part after " - ")
   - Current ModelVersion (`Standard` or `Enhanced`)

   > **Note:** Template name is not included in `pac pages list` output. Template will be confirmed separately in step 4.
   >
   > **PAC CLI version note:** The Portal Id column was added on 2026-02-24. If your installed PAC build predates that and the column is missing entirely, treat Portal Id as missing — the activation step in Phase 3 will prompt the user before the data-model update.

2. **Locate Target Site**

   Search the list for site matching user input (name or GUID):
   - If found: Extract WebSiteId, Portal Id, ModelVersion, and URL slug. Store all four for later phases. If Portal Id parsed as a valid GUID, mark it as "captured"; if `Unknown`/`N/A`/missing, mark as "needs prompt".
   - If not found: Show list and ask user to confirm site name/ID. If still not found, stop and ask user to verify in Power Platform admin center.

3. **Validate Data Model**

   Check `ModelVersion` from output:
   - **If EDM**: Stop with message: "This site is already on Enhanced Data Model. Migration not needed."
   - **If SDM**: Continue to step 1.4

4. **Identify Site Template**

   Template name is not available from `pac pages list`. If step 1.4 reads `adx_templatename` from the migration tracker (populated by a prior migration), use that and skip this prompt.

   Otherwise ask the user via a **2-question tree** (Claude Code's `AskUserQuestion` tool caps at 4 options per question, so the flat 16-template list errors out with `InputValidationError: too_big`). Ask the family first, then drill down based on the answer.

   **Q1 — Template family:**

   | Question | Header | Options |
   |----------|--------|---------|
   | What family is this site's template in? | Template Family | Starter Layout / Blank Page, Power Pages template (FAQ / Event / Application / etc.), D365 portal template, Other or Unknown |

   **Q2a — if "Starter Layout / Blank Page":**

   | Question | Header | Options |
   |----------|--------|---------|
   | Which Starter Layout or Blank template? | Starter | Starter layout 1, Starter layout 2 / 3, Starter layout 4 / 5, Blank page |

   (If user picks "Starter layout 2 / 3" or "Starter layout 4 / 5", drill once more to the specific number with a 4-option follow-up. Or accept the pair and pick the conservative V2 package — the install probe in step 1.6 will fail if it's wrong and surface the actual name.)

   **Q2b — if "Power Pages template (FAQ / Event / Application / etc.)":**

   | Question | Header | Options |
   |----------|--------|---------|
   | Which Power Pages template? | Template | FAQ, Event registration, Application processing, Program registration / Schedule and manage meetings |

   **Q2c — if "D365 portal template":**

   | Question | Header | Options |
   |----------|--------|---------|
   | Which D365 portal? | D365 Portal | Community, Customer Self-Service, Employee Self-Service, Partner |

   **Q2d — if "Other or Unknown":** no follow-up. Treat as Other/Unknown — step 1.6 skips the template-specific V2 package check entirely. The foundation packages (CDSBasePortal, PowerPages_Core) were already validated in step 1.5.

   Store the final chosen template — it drives the V2 package check in step 1.6.

   > **Why the chunking:** `AskUserQuestion` errors with `InputValidationError: questions.0.options: Too big: expected array to have <=4 items` when more than 4 options are passed. The tree shape keeps every individual question within the limit while still letting the user pick from the full 15 supported templates plus Other/Unknown.

**Output**: Target site confirmed as SDM, template confirmed by user, WebSiteId/ModelVersion/URL slug/Portal Id captured (Portal Id marked "captured" or "needs prompt")

> **→ Initialize live report (per-migration subfolder).** Now that env name (from step 1.1's `pac auth list`) and website slug (from `pac pages list -v` above) are both known, initialize state. Run:
>
> ```
> node update-state.js --init \
>   --output-dir "<PARENT_OUTPUT_DIR>" \
>   --website-id "<WEBSITE_ID>" \
>   --env-name "<ENV_NAME>" \
>   --slug "<URL_SLUG>"
> ```
>
> The command creates a per-migration subfolder `<PARENT_OUTPUT_DIR>/<sanitized-env>--<sanitized-slug>/` and writes `migration-state.json` + `sdm-to-edm-migration-report.html` inside it. It prints the resolved subfolder path on stdout — **capture that path as `<MIGRATION_OUTPUT_DIR>` and use it as `--output-dir` for every subsequent `update-state.js` call and as the artifacts directory throughout the rest of the skill.** Pass `--force` only if you intentionally want to wipe an existing migration in the same subfolder.
>
> Then batch-update the steps that ran before init:
>
> ```
> --set-step 1.1 --status completed --output "PAC CLI v<X> · auth <profile> · env <ENV_NAME>"
> --set-step 1.2 --status completed --output "<SITE_ROOT> resolved; parent <PARENT_OUTPUT_DIR>"
> --set-site '{"name":"<SITE_NAME>","slug":"<URL_SLUG>","portalId":"<PORTAL_ID_OR_NULL>","portalUrl":"<PORTAL_URL_OR_NULL>","currentDataModel":"Standard SDM","template":"<TEMPLATE_NAME>","siteRoot":"<SITE_ROOT>"}'
> --set-step 1.3 --status completed --output "Site <NAME> · ModelVersion=Standard · template <TEMPLATE>"
> ```
>
> **📄 Checkpoint 1 — Open the live report in the user's default browser, then tell them.** After `--init` succeeds, open `<MIGRATION_OUTPUT_DIR>\sdm-to-edm-migration-report.html` in the user's default browser using the platform-appropriate file opener for the current environment. For example, use `open` on macOS, `xdg-open` on Linux, or the equivalent default-browser opener available on Windows (PowerShell: `Start-Process <path>`).
>
> Then print this in chat so the user knows where the tab they just saw came from and what to do next:
>
> ```
> 📄 SDM → EDM migration report initialized and opened in your default browser:
>    <MIGRATION_OUTPUT_DIR>\sdm-to-edm-migration-report.html
>
> Keep this tab open and refresh it as the migration progresses — the file is
> regenerated in place after every sub-step. (If the tab didn't open, paste the
> path above into your browser.)
> ```

---

### 1.4 Check Existing Migration Status

**Goal**: Detect whether a migration is already in flight, previously completed, or previously failed for this site — and recover or short-circuit accordingly before doing any new work

**Actions**:

1. **Query Current Status**

   ```powershell
   pac pages migrate-datamodel --webSiteId "<WEBSITE_ID>" --checkMigrationStatus
   ```

   > **PAC CLI build note:** Verbose output (`-v` / `--verbose`) behavior varies by PAC build. On many current builds, `pac pages migrate-datamodel --webSiteId <ID> -s -v` returns a tracker summary with `Created On`, `Modified On`, current step, step history, and per-chunk outcomes — that's the payload Phase 3.1 captures into the Transactional References Migration card. On some older builds the flag errored with `An unknown argument --verbose was passed.`; if you hit that, run without `-v` and feed the simpler payload (`status` + `currentStep` only) to `--set-refs-migration`. For elapsed-time / per-step details when verbose isn't supported, query the migration tracker record directly in Dataverse via PAC data tools.

2. **Parse Status**

   Extract from the output:
   - **Status**: one of `NotStarted`, `Running`, `Completed`, `Failed`, `Reverted`, `Unknown`
   - On older PAC builds where `--verbose` worked, also: **createdOn** / **modifiedOn** (for elapsed-time), **currentStep** / **stepHistory** (granular progress)

3. **Branch Based on Status**

   - **NotStarted / no tracker record**: No prior migration. Proceed to step 1.5.

   - **Reverted**: Site was previously rolled back to SDM. Treat as fresh start. Proceed to step 1.5.

   - **Completed**: A prior migration finished but the data model version was not yet flipped to EDM (otherwise step 1.3 would have stopped earlier). Skip ahead to the activation step in Phase 3 (Authoring Track 3.3 or Downstream Track 3.5 — track is derived in step 1.7, so complete 1.7 first to know which).

   - **Failed**: A prior migration failed. Show the last step and error details (from chunk records in the verbose output), then ask:

     | Question | Header | Options |
     |----------|--------|---------|
     | Previous migration failed at step `<currentStep>`. Retry from the migration phase, or stop and investigate? | Failed Migration | Retry migration, Stop and investigate |

     - **Retry**: Proceed to step 1.5 (full pre-checks still run).
     - **Stop**: Halt. Direct user to verbose status output and Microsoft Learn for diagnostics.

   - **Running**: Migration is in progress. Compute and present elapsed time:

     > Migration started **`<createdOn → now>`**, last activity **`<modifiedOn → now>`** ago. Current step: **`<currentStep>`**. Migration processes records in batches of 5K — large sites can take hours.
     > Reference: <https://learn.microsoft.com/en-us/power-pages/admin/migrate-enhanced-data-model>

     Ask:

     | Question | Header | Options |
     |----------|--------|---------|
     | A migration is already running for this site. How to proceed? | In-Flight Migration | Wait and poll until complete, Reset and start over, Exit and check back later |

     - **Wait**: Skip the rest of Phase 1 and Phase 2 setup work; jump directly to the migration-status polling loop (Authoring Track 2.2 step 2 for an in-flight metadata migration, or Authoring Track 3.2 step 3 / Downstream Track 3.2 step 2 for an in-flight refs migration — depends on which mode the in-flight migration was started with; complete 1.7 first to determine track). After polling reports Completed, continue to the activation step (Authoring Track 3.3 / Downstream Track 3.5).
     - **Reset and start over**: Show the reset warning (see step 4), confirm, run reset, then proceed to step 1.5.
     - **Exit**: Halt the skill cleanly. User can re-invoke later — step 1.4 will re-detect the in-flight migration.

   - **Unknown**: Print warning. Ask user to verify in Power Platform admin center, then choose to proceed or stop.

4. **Reset Warning (only shown if user picks "Reset")**

   > **Reset** flips the migration tracker status from `Running` → `Failed` so a new migration can be triggered. It does **not** undo any data already migrated — records already moved to the target tables stay there. PAC's own behavior: see <https://learn.microsoft.com/en-us/power-pages/admin/migrate-enhanced-data-model>.

   Confirm:

   | Question | Header | Options |
   |----------|--------|---------|
   | Reset will mark the in-flight migration as Failed but will NOT undo migrated records. Continue? | Confirm Reset | Yes, reset, No, cancel |

   If "Yes":

   ```powershell
   pac pages migrate-datamodel --webSiteId "<WEBSITE_ID>" --resetMigration
   ```

   Then proceed to step 1.5.

**Output**: Migration history known; skill either short-circuits to the appropriate phase or proceeds normally with a clean tracker state

> **→ Update report:** `--set-step 1.4 --status completed --output "Status: <STATUS> · <NOTES>"`. If the skill is short-circuiting (in-flight or previously-completed migration), also `--set-phase 1 --status completed`, `--set-phase 2 --status completed` (Phase 2 setup work is skipped), and skip the Phase 2 approval gate — the user has effectively already approved this path by responding to the in-flight prompt.

---

### 1.5 Validate Required Dependencies

**Goal**: Verify required first-party packages are installed at the minimum required version, and install/upgrade them via `pac application install` with explicit user confirmation when they're not.

**Actions**:

1. **Check Installed Solutions**

   Run the following to list **all** solutions in the environment, including first-party Microsoft solutions:

   ```powershell
   pac solution list --includeSystemSolutions
   ```

   > **Important:** The `--includeSystemSolutions` flag is required. Without it, `pac solution list` returns only user/managed-by-customer solutions and omits the first-party packages we need to verify (`CDSBasePortal`, `PowerPages_Core`, and the V2 template solutions checked in step 1.6).

   Search the output for:
   - `CDSBasePortal` — Dataverse base portal package (required: **9.3.2307.x+**)
   - `PowerPages_Core` — Power Pages Core package (required: **1.0.2309.63+**)

   Capture both the **installed version** (or `not found`) and present them to the user.

2. **Evaluate and Install/Upgrade as Needed**

   For **each** of `CDSBasePortal` and `PowerPages_Core`, evaluate independently:

   - **Found and version meets minimum**: log "OK · v<X>" and move on to the next package.
   - **Not found OR installed version is below the minimum**: surface the gap and ask the user before running any install:

     | Question | Header | Options |
     |----------|--------|---------|
     | `<PACKAGE_NAME>` is `<not installed OR v<X> · needs v<MIN>+>`. Install/upgrade via `pac application install` (pulls the latest from the Microsoft application catalog)? | Install Package | Yes — install/upgrade now, Skip — I'll install manually, Cancel — stop the skill |

     - **Yes**: run

       ```powershell
       pac application install --application-name "<PACKAGE_NAME>"
       ```

       Wait for completion. On some clouds the install is asynchronous, so re-run `pac solution list --includeSystemSolutions` afterwards to confirm the package now meets the minimum version. If the re-check still shows the old version, ask the user to wait a minute and re-check, or proceed knowing the install is in flight.

     - **Skip**: log the user's choice and proceed to step 1.6. The migration command in Phase 2/3 will surface a clearer error if the package version is genuinely too low; the user has acknowledged the risk.

     - **Cancel**: halt the skill cleanly.

   - **`pac application install` errors** (rare for these first-party packages — they're always in the Microsoft application catalog, but the call can fail on older PAC builds, missing tenant roles, or transient catalog issues): fall back to manual install.

     | Question | Header | Options |
     |----------|--------|---------|
     | `pac application install --application-name "<PACKAGE_NAME>"` failed: `<error message>`. Install manually via Power Platform admin center → Resources → Dynamics 365 apps → find `<PACKAGE_NAME>` → Install? | Manual Install | I'll install manually now (then continue), Skip — I'll install later, Cancel — stop the skill |

     - **I'll install manually**: pause until user confirms install is complete, then re-run step 1 above to verify.
     - **Skip / Cancel**: same as above.

3. **Fallback if Automatic Check Fails Entirely**

   If `pac solution list --includeSystemSolutions` itself errors out (older PAC build, missing role, transient error), fall back to asking the user:

   | Question | Header | Options |
   |----------|--------|---------|
   | Unable to verify packages automatically. Can you confirm both Dataverse base portal package (9.3.2307.x+) and Power Pages Core (1.0.2309.63+) are installed? | Deps Confirmed | Yes, confirmed, Not sure — help me check |

   - If "Not sure": guide user to Power Platform admin center → Resources → Dynamics 365 apps to verify package versions.
   - If "Yes": proceed to step 1.6.

**Output**: Both required first-party packages verified at or above the minimum version, installed/upgraded via `pac application install`, or explicitly acknowledged as skipped by the user.

> **→ Update report:** `--set-step 1.5 --status completed --output "CDSBasePortal <state> · PowerPages_Core <state>"` where `<state>` is one of `v<X> OK`, `installed via pac application install (v<X> → v<Y>)`, `upgraded via pac application install (v<X> → v<Y>)`, or `user skipped — proceeding at user's risk`. Capturing the install method explicitly so the user can audit afterwards.

---

### 1.6 Validate Site Template and V2 Package

**Goal**: Ensure the EDM-compatible (V2) solution for the site's template is installed in the environment

**Actions**:

1. **Look Up V2 Package for the Captured Template**

   Use this mapping (template → V2 solution `UniqueName` to check in `pac solution list --includeSystemSolutions`):

   | Template | V2 Package UniqueName |
   | --- | --- |
   | Starter layout 1 | `DefaultPortalTemplate_V2` |
   | Starter layout 2 | `PowerPages_BlankDesign002_V2` |
   | Starter layout 3 | `PowerPages_BlankDesign003_V2` |
   | Starter layout 4 | `PowerPages_BlankDesign004_V2` |
   | Starter layout 5 | `PowerPages_BlankDesign005_V2` |
   | Blank page | `PowerPages_BlankTemplate_V2` |
   | FAQ | `PowerPages_FAQ_V2` |
   | Application processing | `PowerPages_BuildingPermit_V2` |
   | Program registration | `PowerPages_ProgramRegistration_V2` |
   | Schedule and manage meetings | `PowerPages_BookMeeting_V2` |
   | Event registration | `EventRegistrationTemplate_V2` |
   | Community Portal (D365) | `PowerPages_CommunityPortal_V2` |
   | Customer Self-Service Portal (D365) | `PowerPages_CustomerPortal_V2` |
   | Employee Self-Service Portal (D365) | `PowerPages_ESSPortal_V2` |
   | Partner Portal (D365) | `PowerPages_PartnerPortal_V2` |
   | Other/Unknown | (skip — fall through to step 3) |

2. **Check Installation**

   ```powershell
   pac solution list --includeSystemSolutions
   ```

   > V2 template packages are first-party — the `--includeSystemSolutions` flag is required to see them. Without it the lookup will always return "not found" even when the package is installed.

   Search output for the V2 `UniqueName` from step 1.

   - **Found**: Proceed to step 3.
   - **Not found**: Continue to step 2a below to determine the best install method.

2a. **Check if V2 package is in the Microsoft application catalog**

   The fastest install path is `pac application install` — it pulls the solution from the Microsoft application catalog and installs it directly. But not every V2 template package is available in the catalog. Check first:

   ```powershell
   pac application list 2>&1 | Select-String -Pattern "<V2_UNIQUE_NAME>" -CaseSensitive:$false
   ```

   - **Match found in catalog**: ask user with `pac application install` as **recommended**:

     | Question | Header | Options |
     |----------|--------|---------|
     | The V2 EDM solution `<UNIQUE_NAME>` for your template is not installed, but it's available in the Microsoft application catalog. How to proceed? | V2 Package | Install via `pac application install` (recommended), Install via dummy EDM site, Skip and let migration warn, Cancel |

     - **Install via `pac application install`**:

       ```powershell
       pac application install --application-name "<V2_UNIQUE_NAME>"
       ```

       Wait for completion. After it returns, re-run `pac solution list --includeSystemSolutions` to confirm the package now appears (the install is async on some clouds).

     - **Install via dummy EDM site**: Guide user to provision a new EDM site using the same template in this environment. Creating that site auto-installs the V2 solution. Once installed, the dummy site can be deleted. Slower but works even when the catalog method fails.
     - **Skip**: Continue to step 1.7; migration may warn or fail if the solution is genuinely needed.
     - **Cancel**: Halt the skill.

   - **No match in catalog**: fall back to the dummy-site method (the catalog doesn't carry this V2 package, so `pac application install` won't work):

     | Question | Header | Options |
     |----------|--------|---------|
     | The V2 EDM solution `<UNIQUE_NAME>` for your template is not installed and not in the Microsoft application catalog. How to proceed? | V2 Package | Install via dummy EDM site (recommended), Skip and let migration warn, Cancel |

     - **Install via dummy EDM site**: Same as above — provision a new EDM site with the template, V2 solution auto-installs, delete the dummy site afterward.
     - **Skip**: Continue to step 1.7; migration may warn or fail if the solution is genuinely needed.
     - **Cancel**: Halt the skill.

   > **Note:** if `pac application list` itself errors out (older PAC builds, missing role), fall back to offering the dummy-site method directly without the catalog check.

**Output**: V2 template package verified/installed (or explicitly skipped). `PowerPages_Core` was already verified and installed/upgraded as needed in step 1.5.

> **→ Update report:** `--set-step 1.6 --status completed --output "<V2_UNIQUE_NAME> <state>"`. If the V2 package was installed during this step, mention the method explicitly so the user can audit — e.g., `"installed via pac application install"` or `"installed via dummy EDM site"`.

---

### 1.7 Determine Environment Type and Migration Mode

**Goal**: Capture env type, select migration mode, and derive the **migration track** (Authoring Track vs Downstream Track) that controls the shape of Phase 2 and Phase 3.

**Actions**:

1. **Identify Environment Type**

   | Question | Header | Options |
   |----------|--------|---------|
   | Which type of environment is this? | Environment Type | Development (Dev), Test/UAT, Production (Prod), Single environment (no ALM) |

   Store the choice.

2. **Recommend Migration Mode Based on Environment**

   | Env Type | Recommended Mode | Rationale |
   |---|---|---|
   | Dev | `configurationData` | Migrate metadata here; allows a customization remediation pass before refs |
   | Test / UAT | `configurationDataReferences` | Assumes config metadata came from Dev via ALM solution import |
   | Prod | `configurationDataReferences` | Assumes config metadata came from Dev via ALM solution import |
   | Single env (no ALM) | `configurationData` | Same as Dev — no upstream env to ALM from; we migrate metadata locally |

3. **Confirm Migration Mode**

   | Question | Header | Options |
   |----------|--------|---------|
   | Recommended mode for `<ENV_TYPE>`: `<RECOMMENDED_MODE>`. Confirm or override? | Migration Mode | Use recommended (`<RECOMMENDED_MODE>`), Use `configurationData`, Use `configurationDataReferences`, Use `all` |

   Mode descriptions:
   - `configurationData`: Migrate metadata (web pages, snippets, settings, etc.) only. **Recommended default** — auto-generates a customization report, allows remediation before refs migrate in Phase 3.
   - `configurationDataReferences`: Migrate transactional data references only. Assumes config metadata is already in EDM (typically via ALM solution import on Test/UAT/Prod).
   - `all`: Migrate metadata AND refs in one shot. **Advanced override.** Only safe if no `adx_*` customizations exist. When chosen, Phase 3.2 (Migrate Transactional References) is skipped automatically because refs are already done in Phase 2.2 — but Phase 3.1 (Data Diff Validation), Phase 3.3 (Activate EDM), and Phase 3.4 (Restart Site) still run.

   If user picks an override for their env, show a warning:
   - **`all` on any env**: "Recommended only when you know there are no `adx_*` customizations. Once refs migrate, customization fixes become much harder. Proceed?"
   - **`configurationDataReferences` on Dev/Single env**: "Only safe if metadata is already in EDM (from a prior `configurationData` run or solution import). Proceed?"

   Store final selected `<MODE>`.

4. **Derive Migration Track**

   | Final Mode | Track | CLI Value |
   |---|---|---|
   | `configurationData` | **Authoring** | `A` |
   | `all` | **Authoring** | `A` |
   | `configurationDataReferences` | **Downstream** | `B` |

   Persist track to state. The Authoring Track and Downstream Track have **different Phase 2 structures**; **both Phase 3 tracks start with the same Data Diff Validation (3.1)** but the Downstream Track has additional customization steps after refs migrate. Step 3.2 (Migrate Transactional References) auto-skipped when mode = `all`.

**Output**: Environment type captured, migration mode confirmed, track derived

> **→ Update report (end of Phase 1):**
>
> ```
> --set-site '{"environment":"<DEV|TEST|UAT|PROD|SINGLE>","migrationMode":"<MODE>"}'
> --set-step 1.7 --status completed --output "Env: <ENV_TYPE> · mode=<MODE> · Track <A|B>"
> --set-track <A|B>
> --set-phase 1 --status completed
> --set-approval 2 phase-start
> ```
>
> `--set-track` rebuilds the Phase 2 and Phase 3 cards in the live report from the chosen track's blueprint. Phase 1 sub-step status is preserved across the swap.
>
> **📄 Checkpoint 2 — Tell the user about the report before asking for approval.** Print this in chat *before* the AskUserQuestion approval gate:
>
> ```
> 📄 Phase 1 complete. Review the plan in your browser before approving Phase 2:
>    <ABSOLUTE_PATH_TO_OUTPUT_DIR>\sdm-to-edm-migration-report.html
>
> The report now shows: site context, env type, migration mode, derived track, and
> the Phase 2 sub-steps that will run if you approve.
> ```
>
> Then proceed to ask the user to approve Phase 2 via AskUserQuestion. On approval, run `node update-state.js --output-dir "<OUTPUT_DIR>" --approve-and-start 2` to atomically clear the approval gate and mark Phase 2 in-progress.

---

## Phase 2: Configuration Setup (track-branched)

This phase has **two completely different shapes** depending on the migration track derived in step 1.7. Pick the matching section below; ignore the other one.

- [**Phase 2 — Authoring Track**](#phase-2--authoring-track) — mode is `configurationData` or `all` (Dev / Test/UAT / Single env)
- [**Phase 2 — Downstream Track**](#phase-2--downstream-track) — mode is `configurationDataReferences` (Prod, ALM assumed)

---

## Phase 2 — Authoring Track

**Applies when**: state.track === 'A' (mode = `configurationData` or `all`)

**Goal**: Capture an SDM baseline snapshot first (so the live report shows pre-migration state and Phase 4 has something to diff against), then migrate configuration metadata to EDM tables. Newer PAC versions auto-generate a customization report as a side effect of the migrate command. If any `adx_*` customizations are flagged, remediate the site source (FetchXML / Liquid auto-rewrites + augmented prompts for plugins / DME) and upload back to Dataverse before activation.

**Output**: SDM baseline captured and reflected in the live report, metadata migrated to EDM tables, customization report parsed, any flagged customizations remediated and uploaded, final readiness gate confirmed.

---

### 2.1 Capture SDM Snapshot

**Goal**: Download the SDM source and snapshot it **before** the migration runs, so the live report's "Migration totals" and "Pages & Components" cards reflect the pre-migration baseline from the start of Phase 2. This also provides `<SITE_ROOT>` for the FetchXML/Liquid rewriters in step 2.4.

**Actions**:

1. **Download SDM source**

   ```powershell
   pac pages download --webSiteId "<WEBSITE_ID>" --modelVersion 1 --path "<MIGRATION_OUTPUT_DIR>/site-sdm"
   ```

   > **Important — nested folder quirk:** `pac pages download --path <MIGRATION_OUTPUT_DIR>/site-sdm` creates a slug-named child folder (e.g., `<MIGRATION_OUTPUT_DIR>/site-sdm/site-1---site-k5s85/website.yml`). Capture the inner folder as `<SITE_ROOT>` via `Get-ChildItem "<MIGRATION_OUTPUT_DIR>/site-sdm" -Directory`. Subsequent migrate, rewrite, and upload steps must use `<SITE_ROOT>` (the inner path), not the `site-sdm` wrapper.
   >
   > **`--modelVersion 1`** explicitly requests SDM data. The site's activation is still SDM at this point (step 3.3 hasn't run yet), so this is the live source of truth for the baseline.

2. **Snapshot the downloaded source**

   ```powershell
   node "${CLAUDE_PLUGIN_ROOT}/skills/migrate-datamodel/scripts/snapshot-site.js" `
     --site-root "<SITE_ROOT>" `
     --output-dir "<OUTPUT_DIR>" `
     --label sdm
   ```

   Output: `<OUTPUT_DIR>/sdm-snapshot.json` — Phase 4 will diff this against an EDM snapshot to confirm every record migrated. The live report's Pages & Components tab also reads this file to populate per-category counts.

**Output**: SDM baseline captured to `sdm-snapshot.json`; `<SITE_ROOT>` ready for step 2.2's migrate command and step 2.4's rewriters.

> **→ Update report:**
>
> ```
> --set-site '{"siteRoot":"<SITE_ROOT>"}'
> --set-step 2.1 --status completed --output "SDM snapshot captured · <N> components"
> ```

---

### 2.2 Migrate Metadata

**Goal**: Run the PAC migrate command for the chosen mode. Auto-generates the customization report.

**Actions**:

1. **Execute Migration Command**

   ```powershell
   pac pages migrate-datamodel --webSiteId "<WEBSITE_ID>" --mode <MODE>
   ```

   Where `<MODE>` is the value confirmed in step 1.7 (either `configurationData` or `all` for the Authoring Track).

2. **Monitor & Poll**

   Poll every 1 minute, up to 30 attempts (30 minutes total). **Use this exact PowerShell loop** — don't improvise a Bash equivalent. Bash subshells can silently fail if `pac` isn't on the Bash `$PATH` (different PATH from PowerShell on many Windows installs), which makes the `until / sleep` pattern spin forever without ever detecting completion.

   ```powershell
   $webSiteId = "<WEBSITE_ID>"
   for ($i = 1; $i -le 30; $i++) {
     $statusOutput = pac pages migrate-datamodel --webSiteId $webSiteId --checkMigrationStatus 2>&1 | Out-String
     if ($statusOutput -match "Completed")      { Write-Host "Status: Completed";  break }
     if ($statusOutput -match "Failed")         { Write-Host "Status: Failed";     break }
     if ($statusOutput -match "Reverted")       { Write-Host "Status: Reverted";   break }
     Write-Host "Attempt $i/30 — still running, sleeping 60s..."
     Start-Sleep -Seconds 60
   }
   ```

   Between iterations, update the live report:

   ```powershell
   node update-state.js --output-dir "<OUTPUT_DIR>" --set-activity "Polling migration status (attempt <N>/30)"
   ```

   - **Completed**: clear activity, proceed to step 2.2.
   - **In Progress (loop exited at i=30 without status change)**: surface 30-min timeout, ask user (retry / reset / exit) — same handling pattern as 1.4 in-flight branch.
   - **Failed / Reverted**: surface error, ask user (retry / reset / exit).

   > **Why this matters:** an earlier real-world test session ran the poll as a Bash `until [ "$(pac ... | grep -oE ...)" != "" ]` loop. `pac` wasn't on the Bash `$PATH` in that environment, so the subshell silently produced empty output, the until condition stayed false, and the loop printed "Still running..." for 12+ iterations after the migration had actually completed. The user had to type "check status" to force the agent to verify via PowerShell. Using PowerShell directly with a bounded `for` loop avoids both issues — PATH consistency and runaway iteration.

**Output**: Metadata moved to EDM tables; site activation still SDM until step 3.3 flips it. Newer PAC builds auto-emit `SiteCustomization*.csv` here; **older builds do not** — step 2.3 will fall back to running the explicit `--siteCustomizationReportPath` command. Don't assume the CSV exists yet.

> **→ Update report:** `--clear-activity` and `--set-step 2.2 --status completed --output "Metadata migration <COMPLETED|FAILED> · mode=<MODE>"`

---

### 2.3 Locate Customization Report

**Goal**: Find the CSV PAC auto-generated in step 2.2; fall back to explicit generation if PAC didn't produce one (older builds).

**Actions**:

1. **Search for the auto-generated CSV**

   Glob both `<OUTPUT_DIR>` and current working directory for `SiteCustomization*.csv`. Use the most recent file (highest auto-number) if multiple exist.

2. **Fallback if not found**

   ```powershell
   pac pages migrate-datamodel --webSiteId "<WEBSITE_ID>" --siteCustomizationReportPath "<OUTPUT_DIR>"
   ```

   Then re-glob.

   > **Note on file location quirks:** Some PAC builds drop the CSV in the parent dir or cwd rather than the path passed. Always glob both locations.

3. **Parse Report**

   Read the CSV and categorize findings:
   - Liquid contains adx references
   - Data Model Extension (custom columns on adx tables)
   - Plugins registered on adx entities
   - Custom workflows
   - Relationships between custom and adx tables
   - FetchXML with adx references

   > **Important:** The CSV's `Location` column contains paths to PAC's internal scan temp folder (e.g., `\\?\C:\Users\...\Temp\<site-slug>\web-templates\X\Y.html`). **Do NOT** use those paths to locate or modify files. They're informational only — for actual rewrites use the path captured in step 1.2 (`<SITE_ROOT>`).

4. **Generate HTML Customization Report**

   ```bash
   node scripts/generate-migration-reports.js \
     --customization-report "<OUTPUT_DIR>/SiteCustomization.csv" \
     --site-name "<SITE_NAME>" \
     --website-id "<WEBSITE_ID>" \
     --output-dir "<OUTPUT_DIR>"
   ```

   This creates `<OUTPUT_DIR>/customization-report.html` alongside the CSV.

5. **Present Findings**

   Show summary of customizations found (by category) or "No customizations found" if clean.

**Output**: Customization report located/generated and parsed. Findings summary available.

> **→ Update report:**
>
> ```
> --set-step 2.3 --status completed --output "CSV: <PATH> · <N> findings total · <BREAKDOWN_BY_CATEGORY>"
> --set-customization-report '{"path":"<ABSOLUTE_PATH_TO_OUTPUT_DIR>/customization-report.html","csvPath":"<ABSOLUTE_PATH_TO_OUTPUT_DIR>/SiteCustomization.csv","totalFindings":<N>,"breakdown":{"fetchxml":<N>,"liquid":<N>,"dme":<N>,"plugins":<N>,"workflows":<N>,"relationships":<N>}}'
> ```
>
> Pass absolute paths so the live report's "Open customization-report.html" link works no matter where the user opens the report from. Omit any breakdown keys with zero count.
>
> **📄 Checkpoint 3 — Tell the user about the customization report.** Print in chat:
>
> ```
> 📄 Customization findings catalog:
>    <ABSOLUTE_PATH_TO_OUTPUT_DIR>\customization-report.html
>
> Open this in your browser to review the per-finding details before remediation starts.
> ```

---

### 2.4 Remediate Customizations

**Goal**: If customization findings exist, apply auto-rewrites + augmented prompts and upload the cleaned source back to Dataverse. SDM source is already downloaded into `<SITE_ROOT>` from step 2.1; this step works against that tree.

> **Important — most flagged Liquid is a false positive.** The customization report greps for any `adx_` substring in Liquid files, but Power Pages Liquid runtime handles legacy attribute names transparently. Patterns like `page.adx_copy`, `website.adx_partialurl`, `{% editable page 'adx_copy' %}`, and `snippets['adx_name']` use documented logical-name access and **don't need rewriting**. See per-category table below.

**Actions**:

### 1. Categorize findings: what to fix vs. leave alone

| Customization category | Action | Reasoning |
|---|---|---|
| FetchXML with `<entity name='adx_*'>` | **Auto-fix** | Doc shows mechanical rewrite: rename entity to `powerpagecomponent` + inject `powerpagecomponenttype` filter |
| Liquid `entities['adx_*']` collection | **Semi-auto fix (user reviews)** | Doc shows replacing with dedicated Liquid object (`weblinks`, `snippets`, etc.). Semantics may shift; user must approve |
| Liquid property access (`page.adx_X`, `website.adx_X`, `botconsumer.adx_X`) | **Leave alone** | Documented `[logical_name]` accessor; works on EDM via virtualization |
| Liquid `{% editable page 'adx_*' %}` tag | **Leave alone** | Uses logical attribute name; same access rule |
| Liquid `snippets['adx_*']`, `weblinks['adx_*']` | **Leave alone** | Index is a user-defined name, not an attribute |
| Data Model Extensions (custom columns on `adx_*`) | **Manual only** | Per migration doc, the fix is to create a new custom table with a lookup to `powerpagecomponent` and migrate data — multi-step schema operation, not automatable safely |
| Relationships between custom and `adx_*` tables | **Manual only** | New relationship to `powerpagecomponent`-side; user-driven |
| Custom plugins/workflows on `adx_*` tables | **Manual only** | Code refactor + re-registration — semantic, not mechanical |

### 2. Branch on findings

- **Zero customization findings**: skip steps 3–7, jump to step 8 (readiness gate).
- **One or more findings**: proceed with auto-rewriters below.

### 3. Stage automated FetchXML rewrites

```powershell
node "${CLAUDE_PLUGIN_ROOT}/skills/migrate-datamodel/scripts/generate-migration-reports.js" `
  --customization-report "<OUTPUT_DIR>/SiteCustomization.csv" `
  --site-name "<SITE_NAME>" `
  --website-id "<WEBSITE_ID>" `
  --site-path "<SITE_ROOT>" `
  --automate-fetchxml `
  --output-dir "<OUTPUT_DIR>"
```

Script behavior:

- Walks `.html` and `.yml` files under `--site-path`
- Finds each `<entity name='adx_X'>` block (in `{% fetchxml %}` Liquid tags and YAML `query:` fields)
- Renames entity to `powerpagecomponent` and injects `<condition attribute='powerpagecomponenttype' operator='eq' value='<N>'/>` based on the component type map
- **Writes the proposed file to `<OUTPUT_DIR>/remediation-staged/<relative path>`.** The live `<SITE_ROOT>` is NOT modified — the staged copy is what step 8 applies after user approval.

### 4. Stage semi-automated Liquid `entities['adx_*']` rewrites

```powershell
node "${CLAUDE_PLUGIN_ROOT}/skills/migrate-datamodel/scripts/generate-migration-reports.js" `
  --customization-report "<OUTPUT_DIR>/SiteCustomization.csv" `
  --site-name "<SITE_NAME>" `
  --website-id "<WEBSITE_ID>" `
  --site-path "<SITE_ROOT>" `
  --automate-liquid `
  --output-dir "<OUTPUT_DIR>"
```

Script behavior:

- Walks `.html` files for `entities['adx_*']` and `entities["adx_*"]` patterns
- For each match, looks up the suggested dedicated Liquid object (e.g., `entities['adx_weblinkset']` → `weblinks`)
- **Inserts a suggested rewrite as a Liquid comment next to the original** — does NOT overwrite the original line. User decides what to keep.
- **Writes the annotated file to `<OUTPUT_DIR>/remediation-staged/<relative path>`** (merging on top of the FetchXML pass if the same file was touched there).

After both rewriters run, the script emits **`<OUTPUT_DIR>/remediation-diff.json`** — a lean, skill-owned manifest consumed by the live execution report's Remediation Diff card. It carries `generatedAt`, `siteRoot`, `stagedDir`, and `files[]` (each with `relativePath`, `kind: "fetchxml" | "liquid" | "fetchxml+liquid"`, `status: "modified"`, `linesAdded`, `linesRemoved`, `hunks[]`, `changeSummary[]`, and **absolute** `livePath` / `stagedPath`). The report renders one expandable row per touched file with inline hunks plus a **Copy diff command** button that copies `code --diff '<live>' '<staged>'` — paste it into any terminal to open VS Code's built-in side-by-side diff editor (current vs proposed). No VS Code extension is required.

### 5. Generate augmented prompts for manual categories

The customization report's plugin and DME findings get exported as paste-ready prompts for fresh Claude Code sessions (the skill never modifies customer-owned plugin source or Dataverse schema directly).

The script in step 3/4 also emits:
- `<OUTPUT_DIR>/plugin-remediation-prompt.txt` (if plugin findings exist)
- `<OUTPUT_DIR>/dme-remediation-prompt.txt` (if DME findings exist)

> **→ Update report (before asking for upload approval):**
>
> ```
> --set-step 2.4 --status in-progress --output "Auto-rewrites staged · awaiting diff review"
> --set-prompt plugin --status ready --path "<OUTPUT_DIR>/plugin-remediation-prompt.txt" --summary "<N> custom plugins on adx_* entities"
> --set-prompt dme    --status ready --path "<OUTPUT_DIR>/dme-remediation-prompt.txt"    --summary "<N> custom columns across <T> adx_* tables"
> --set-approval 2 in-phase
> ```
>
> (Skip a category's `--set-prompt` if zero findings — placeholder card remains.)

### 6. Review and approve changes

> **📄 Checkpoint 4 — Tell the user where to review.** Print this in chat before asking for upload approval:
>
> ```
> 📄 Auto-rewriters staged proposed changes. Review them in the live report:
>    <ABSOLUTE_PATH_TO_OUTPUT_DIR>\sdm-to-edm-migration-report.html
>
> Open the "Migration & Review" tab — the Remediation Diff card shows one
> expandable row per touched file with inline hunks. Click "Open staged file"
> on any row to view it in VSCode.
>
> Augmented prompts (work in parallel, in separate Claude sessions):
>    <ABSOLUTE_PATH_TO_OUTPUT_DIR>\plugin-remediation-prompt.txt   (if plugin findings)
>    <ABSOLUTE_PATH_TO_OUTPUT_DIR>\dme-remediation-prompt.txt      (if DME findings)
>
> Your live site source under <SITE_ROOT> is UNTOUCHED — staged files live
> under <OUTPUT_DIR>\remediation-staged\ and are only applied when you approve.
> ```

| Question | Header | Options |
|----------|--------|---------|
| Review the Remediation Diff card in the live report. Apply the staged changes to your site source and upload to Dataverse? | Approve Rewrites | Yes — apply and upload, No — discard staged changes, Let me edit the staged files first |

### 7. Apply staged changes and upload to Dataverse

Branch on the user's answer:

**Yes — apply and upload:** copy staged files over the live source, then upload.

```powershell
node "${CLAUDE_PLUGIN_ROOT}/skills/migrate-datamodel/scripts/apply-remediation.js" `
  --output-dir "<OUTPUT_DIR>" `
  --site-root "<SITE_ROOT>"

pac pages upload --path "<SITE_ROOT>" --modelVersion 1
```

`apply-remediation.js` reads `remediation-diff.json`, copies each staged file over its live counterpart, and deletes the `remediation-staged/` directory on success. Pass `--dry-run` first if you want to print the planned copies without executing.

**No — discard staged changes:** delete the staged tree and the diff manifest; live source remains untouched.

```powershell
node "${CLAUDE_PLUGIN_ROOT}/skills/migrate-datamodel/scripts/apply-remediation.js" `
  --output-dir "<OUTPUT_DIR>" --discard
```

**Let me edit the staged files first:** the user hand-edits files under `<OUTPUT_DIR>\remediation-staged\` (changes preview live in the report on refresh). When done, re-ask the approval question.

> **PAC CLI argument notes:**
>
> - `pac pages upload` does **not** accept `--webSiteId` — the site is inferred from `website.yml` inside `<SITE_ROOT>`. If you pass `--webSiteId`, PAC errors with "An unknown argument --webSiteId was passed."
> - `--modelVersion 1` = SDM (the site's activation is still SDM at this point, since step 3.3 hasn't flipped it yet).
> - `<SITE_ROOT>` must point at the directory containing `website.yml` (not the `<MIGRATION_OUTPUT_DIR>/site-sdm` wrapper).

> **→ Update report (after upload completes):** `--clear-approval`. The in-phase gate is now resolved.

### 8. Final readiness gate

After auto-rewrites are uploaded (or skipped due to zero findings) and any manual prompts have been handed off:

| Question | Header | Options |
|----------|--------|---------|
| Configuration is migrated, customizations addressed (or knowingly deferred). Proceed to Phase 3 (Migration Execution)? | Migration Readiness | Yes — proceed to migration execution, Defer manual items and proceed (acknowledge risk), Pause skill — I'll finish manual fixes and re-run |

- **Proceed**: continue to Phase 3.
- **Defer manual items**: log the user's acknowledgment in the execution report and proceed.
- **Pause skill**: halt cleanly. User can re-invoke later.

> **Why this gate exists:** Data Model Extension custom columns and custom plugins typically need to land before activation so EDM behaves correctly. This gate makes the choice explicit rather than implicit.

**Output**: FetchXML/Liquid auto-rewrites applied and uploaded (if findings); augmented prompts handed off; readiness gate confirmed.

> **→ Update report (end of Phase 2 Authoring Track):**
>
> ```
> --set-step 2.4 --status completed --output "<auto-rewrites done|no remediation needed> · readiness confirmed"
> --set-phase 2 --status completed
> --set-approval 3 phase-start
> ```
>
> **📄 Checkpoint 5 — Tell the user about the report before asking for Phase 3 approval.** Print in chat:
>
> ```
> 📄 Phase 2 complete. Review the outcomes in your browser before approving Phase 3:
>    <ABSOLUTE_PATH_TO_OUTPUT_DIR>\sdm-to-edm-migration-report.html
>
> The report shows: customization findings handled, SDM snapshot captured, and the
> Phase 3 sub-steps that will run if you approve.
> ```
>
> Then ask the user to approve Phase 3 via AskUserQuestion. On approval, run `node update-state.js --output-dir "<OUTPUT_DIR>" --approve-and-start 3` to atomically clear the approval gate and mark Phase 3 in-progress.

---

## Phase 2 — Downstream Track

**Applies when**: state.track === 'B' (mode = `configurationDataReferences`)

**Goal**: Verify that configuration metadata is already present in the target environment (typically loaded via ALM solution import). If missing, offer the user three import paths (ALM skill / Solution Import / PAC CLI). No data is migrated yet — Phase 3 does the transactional migration.

**Output**: Configuration metadata confirmed available in target environment, ready for Phase 3.

---

### 2.1 Verify Site in Target Environment

**Goal**: Confirm the site exists in the currently-authenticated environment by listing sites via PAC.

**Actions**:

1. **List sites in target env**

   ```powershell
   pac pages list -v
   ```

   Parse output and look for a row matching `<WEBSITE_ID>`.

2. **Branch on result**

   - **Site found**: ALM has likely brought the site (and its metadata) into the target env. Ask the user:

     | Question | Header | Options |
     |----------|--------|---------|
     | Site `<SITE_NAME>` (ID `<WEBSITE_ID>`) is present in this environment. Has the configuration metadata been imported (via ALM, solution import, or PAC CLI)? | Metadata Imported | Yes, metadata is imported, No, I still need to import it |

     - **Yes**: skip step 2.2, jump straight to 2.3.
     - **No**: proceed to step 2.2.

   - **Site NOT found**: this is unexpected for a Prod env. Surface the issue:

     | Question | Header | Options |
     |----------|--------|---------|
     | Site is not visible in the target environment via `pac pages list -v`. The site needs to be imported before this skill can proceed. How would you like to import? | Import Path | Use ALM skill (recommended), Solution Import (manual), PAC CLI import (manual), Cancel — investigate first |

     Whatever the user picks routes into step 2.2.

**Output**: Site presence confirmed; user has either verified metadata is imported (→ 2.3) or chosen an import path (→ 2.2).

> **→ Update report:** `--set-step 2.1 --status completed --output "Site <found|not found> in target env · user response: <response>"`

---

### 2.2 Import Metadata if Missing

**Goal**: Guide the user through one of three import paths so configuration metadata lands in the target env's EDM tables.

**Actions**:

Based on the user's choice in 2.1, run one of:

**Option (a) — Use ALM skill**

The team's ALM skill handles solution-based ALM workflows including metadata import. Look it up:

```powershell
# Find the ALM skill in installed plugins
Get-ChildItem -Path "${env:CLAUDE_PLUGIN_ROOT}\..\..\plugins" -Recurse -Filter "SKILL.md" |
  Where-Object { $_.FullName -match "alm" }
```

(Or use the Glob tool with pattern `plugins/**/skills/*alm*/SKILL.md`.)

- **If found**: print a hand-off message to the user: "To import configuration metadata, please run **/<alm-skill-name>** in your current Claude Code session. Once it reports successful import, resume this skill by re-confirming Phase 2 readiness."
- **If not found**: print "ALM skill not available in installed plugins. Falling through to manual options." and present (b) and (c) below.

**Option (b) — Solution Import**

Print instructions:

> "Open Power Platform admin center → your target environment → Solutions → Import. Import the site's exported solution package (built from your Dev environment). Once import completes, return here."

**Option (c) — PAC CLI Import**

Print the command for the user to run:

```powershell
pac solution import --path "<PATH_TO_SOLUTION_ZIP>" --activate-plugins true --publish-changes true
```

> Instruct the user to provide the path to their site's exported solution package.

After whichever option, loop back to **step 2.1** to re-verify the site is now present.

**Output**: Configuration metadata imported via the chosen path; site now visible in the target environment.

> **→ Update report:** `--set-step 2.2 --status completed --output "Imported via <ALM|Solution|PAC>"` (or `--status pending` and re-run 2.1 if the user needs another import attempt).

---

### 2.3 Confirm Metadata Ready

**Goal**: Final user-facing gate before Phase 3 starts moving transactional data.

**Actions**:

| Question | Header | Options |
|----------|--------|---------|
| Configuration metadata is available in the target environment? Phase 3 will run `pac pages migrate-datamodel --mode configurationDataReferences` to migrate transactional references onto the metadata that's already in place. | Metadata Ready | Yes, proceed to Phase 3, No, pause — I need more time, Cancel — stop the skill |

- **Yes**: proceed to Phase 3.
- **No**: halt skill cleanly; user can re-invoke later.
- **Cancel**: halt skill cleanly.

**Output**: User has confirmed configuration metadata is ready; skill proceeds to Phase 3.

> **→ Update report (end of Phase 2 Downstream Track):**
>
> ```
> --set-step 2.3 --status completed --output "Metadata ready · proceeding to Phase 3"
> --set-phase 2 --status completed
> --set-approval 3 phase-start
> ```
>
> **📄 Checkpoint 5 — Tell the user about the report before asking for Phase 3 approval.** Print in chat:
>
> ```
> 📄 Phase 2 complete. Review the outcomes in your browser before approving Phase 3:
>    <ABSOLUTE_PATH_TO_OUTPUT_DIR>\sdm-to-edm-migration-report.html
>
> The report shows: customization findings handled, SDM snapshot captured, and the
> Phase 3 sub-steps that will run if you approve.
> ```
>
> Then ask the user to approve Phase 3 via AskUserQuestion. On approval, run `node update-state.js --output-dir "<OUTPUT_DIR>" --approve-and-start 3` to atomically clear the approval gate and mark Phase 3 in-progress.

---

## Phase 3: Migration Execution (track-branched)

Phase 3 has **two different shapes** depending on the migration track. The Authoring Track is shorter (4 sub-steps) because customization remediation already happened in Phase 2.4. The Downstream Track is longer (6 sub-steps) because customizations get scanned and remediated here (Phase 2 for the Downstream Track was just metadata verification). **Both tracks start with the same pre-flight check (3.1):** a metadata-only SDM↔EDM diff that confirms the metadata migration in Phase 2 (Authoring) or the upstream ALM import (Downstream) landed cleanly before the irreversible refs migration runs.

- [**Phase 3 — Authoring Track**](#phase-3--authoring-track) — Authoring Track (mode = `configurationData` or `all`). 4 sub-steps: verify metadata diff → migrate refs → activate → restart.
- [**Phase 3 — Downstream Track**](#phase-3--downstream-track) — Downstream Track (mode = `configurationDataReferences`). 6 sub-steps: verify metadata diff → migrate refs → locate customization report → remediate → activate → restart.

---

## Phase 3 — Authoring Track

**Applies when**: state.track === 'A' (mode = `configurationData` or `all`)

**Goal**: Verify the metadata migration succeeded via an SDM↔EDM diff, then migrate transactional references (skipped if mode=all already covered them), activate EDM, prompt user to restart. Customization handling is **not in this phase** — Phase 2.4 already cleaned things up.

**Output**: Metadata diff confirmed, transactional refs migrated (or skip if mode=all), site activated on EDM, user has confirmed restart.

---

### 3.1 Data Diff Validation (SDM ↔ EDM Metadata)

**Goal**: Before running the irreversible refs migration, re-download the site as EDM, snapshot it, and diff against the SDM baseline captured in Phase 2.1. Surface the result so the user can decide whether to proceed with refs migration or pause to investigate. The Pages & Components card in the live report visualizes the per-category comparison.

**Why pre-refs:** at this point only metadata has been migrated (Phase 2.2 for Authoring; assumed via ALM solution import for Downstream) — refs haven't run yet. Catching a metadata mismatch here means the user can fix the source and re-run without having to roll back a completed migration.

**Actions**:

1. **Re-download the migrated site as EDM**

   ```powershell
   pac pages download --webSiteId "<WEBSITE_ID>" --modelVersion 2 --path "<MIGRATION_OUTPUT_DIR>/site-edm"
   ```

   Site root lives one level deeper than `--path` (e.g., `<MIGRATION_OUTPUT_DIR>/site-edm/<slug>/website.yml`). Capture inner path as `<SITE_ROOT_EDM>` via `Get-ChildItem "<MIGRATION_OUTPUT_DIR>/site-edm" -Directory`.

2. **Snapshot the EDM site**

   ```powershell
   node "${CLAUDE_PLUGIN_ROOT}/skills/migrate-datamodel/scripts/snapshot-site.js" `
     --site-root "<SITE_ROOT_EDM>" `
     --output-dir "<OUTPUT_DIR>" `
     --label edm
   ```

   Output: `<OUTPUT_DIR>/edm-snapshot.json`. The live report's **Pages & Components** card now shows `SDM → EDM` per-category pills.

3. **Diff SDM vs EDM**

   ```powershell
   node "${CLAUDE_PLUGIN_ROOT}/skills/migrate-datamodel/scripts/diff-snapshots.js" `
     --sdm "<OUTPUT_DIR>/sdm-snapshot.json" `
     --edm "<OUTPUT_DIR>/edm-snapshot.json" `
     --output-dir "<OUTPUT_DIR>"
   ```

   Output: `<OUTPUT_DIR>/migration-data-diff.json` + console table grouped by category. Exit code: `0` for pass or warn, `1` for fail.

   Per-category status:
   - **pass** — same identity set, no differences
   - **warn** — identity match but some records changed statecode/value, OR an SDM-only category (e.g., `tags`, `websiteBindings`) shows 0 records in EDM (expected — EDM YAML format doesn't surface those; records still in `powerpagecomponent`)
   - **fail** — records actually missing/extra (excluding SDM-only categories)

4. **Surface the diff and gate refs migration**

   > **📄 Checkpoint 7 — Tell the user about the diff result.** Print in chat:
   >
   > ```
   > 📄 Metadata diff complete. Review:
   >    <OUTPUT_DIR>\migration-data-diff.json
   >    <MIGRATION_OUTPUT_DIR>\sdm-to-edm-migration-report.html
   >
   > Status: <PASS | WARN | FAIL>
   >    <N> records missing in EDM
   >    <M> extra records in EDM
   >    <S> records with state changes
   > ```

   Then ask:

   | Question | Header | Options |
   |----------|--------|---------|
   | Metadata diff status: `<PASS\|WARN\|FAIL>`. `<N>` missing, `<M>` extra, `<S>` state-changed. Refs migration (next step) is irreversible — proceed? | Pre-Refs Gate | Looks fine — proceed to refs migration, Concerning — pause so I can investigate, Cancel — stop the skill |

   - **Looks fine**: proceed to step 3.2.
   - **Concerning**: halt Phase 3 cleanly. User can fix the metadata source (re-import solution / re-run Phase 2.2 in Authoring) and re-invoke the skill from this point.
   - **Cancel**: halt cleanly.

**Output**: Metadata SDM↔EDM diff complete, user has decided whether to proceed with refs migration or pause.

> **→ Update report:** `--set-step 3.1 --status completed --output "Metadata diff: <PASS|WARN|FAIL> · <N> missing · <M> extra · <S> state-changed · user chose: <choice>"`

---

### 3.2 Migrate Transactional References

**Goal**: Run `pac pages migrate-datamodel --mode configurationDataReferences` to move transactional data references. Skip if mode was `all` in Phase 2.2.

**Actions**:

1. **Check whether to skip**

   - If `state.mode === 'all'`: refs were already migrated in Phase 2.2. Mark this sub-step completed with output `"Skipped — refs already migrated in Phase 2.2 (mode=all)"` and proceed to step 3.3.
   - Otherwise: proceed with the migration command below.

2. **Execute Migration Command**

   ```powershell
   pac pages migrate-datamodel --webSiteId "<WEBSITE_ID>" --mode configurationDataReferences
   ```

   Newer PAC versions auto-emit `SiteCustomization*.csv` into `<OUTPUT_DIR>` or cwd.

3. **Poll Status with Verbose Output**

   Poll every 1 minute using `-s -v` so each iteration captures the full tracker payload (status, current step, step history, per-chunk outcomes) and refreshes the live report's **Transactional References Migration** card. Up to 30 attempts (30 minutes total). **Use this exact PowerShell loop** — don't improvise a Bash equivalent (same PATH-consistency reasoning as Phase 2.2).

   ```powershell
   $webSiteId = "<WEBSITE_ID>"
   $outputDir = "<OUTPUT_DIR>"
   $finalStatus = $null
   $finalPayload = $null
   for ($i = 1; $i -le 30; $i++) {
     $verboseOutput = pac pages migrate-datamodel --webSiteId $webSiteId -s -v 2>&1 | Out-String

     # Build the --set-refs-migration JSON payload from the verbose output.
     # The agent (you) must parse $verboseOutput and produce a JSON STRING.
     # Required fields:
     #   status        — one of NotStarted | Running | Completed | Failed | Reverted | Unknown
     #                   (from the "Current migration status is :" line)
     #   currentStep   — from the "Current Step:" line under "Migration Step Details"
     #   createdAt     — ISO 8601, from "Created On" in the Migration Tracker Summary
     #   modifiedAt    — ISO 8601, from "Modified On" in the Migration Tracker Summary
     #   stepHistory   — array of { step, at } from the "Step History" block,
     #                   filtered to entries from `ConfigurationDataReferencesStarted` onward
     #                   (drop earlier `ConfigurationData*` metadata steps from Phase 2)
     #   runs          — array of { name, chunkTotal, completed, succeeded,
     #                   chunks: [{ name, runStatus, outcome, errorType, errorDetails }] }
     #                   parsed from the "Migration Run N" + "Chunk Details" blocks
     #
     # Build the object in a hashtable, then ConvertTo-Json -Compress -Depth 10.
     # IMPORTANT: pass the resulting JSON string — NOT the literal text
     # `<PARSED_JSON>` — to --set-refs-migration, or cmdSetRefsMigration will
     # error with "could not parse JSON" and the card will stay empty.
     $refsPayload = @{
       status      = '<STATUS_FROM_OUTPUT>'
       currentStep = '<STEP_FROM_OUTPUT>'
       createdAt   = '<ISO_FROM_OUTPUT>'
       modifiedAt  = '<ISO_FROM_OUTPUT>'
       stepHistory = @( <ARRAY_OF_OBJECTS_FROM_OUTPUT> )
       runs        = @( <ARRAY_OF_RUN_OBJECTS_FROM_OUTPUT> )
     } | ConvertTo-Json -Compress -Depth 10
     $finalPayload = $refsPayload

     node update-state.js --output-dir $outputDir --set-refs-migration $refsPayload
     node update-state.js --output-dir $outputDir --set-activity "Polling migration status (attempt $i/30)"

     if ($verboseOutput -match "Current migration status is\s*:\s*Completed") { $finalStatus = 'Completed'; Write-Host 'Status: Completed'; break }
     if ($verboseOutput -match "Current migration status is\s*:\s*Failed")    { $finalStatus = 'Failed';    Write-Host 'Status: Failed';    break }
     if ($verboseOutput -match "Current migration status is\s*:\s*Reverted")  { $finalStatus = 'Reverted';  Write-Host 'Status: Reverted';  break }
     Write-Host "Attempt $i/30 — still running, sleeping 60s..."
     Start-Sleep -Seconds 60
   }

   # Guaranteed final refresh: re-emit the last captured payload so the card
   # reflects the terminal state even if the last in-loop call had a parsing
   # hiccup. Safe to run — cmdSetRefsMigration is idempotent.
   if ($finalPayload) {
     node update-state.js --output-dir $outputDir --set-refs-migration $finalPayload
   }
   ```

   - **Completed**: clear activity, proceed to step 3.3. The card now shows status=Completed.
   - **In Progress (loop exited at i=30 without status change)**: surface 30-min timeout, ask user (retry / reset / exit) — same handling pattern as 1.4 in-flight branch. The card shows the last captured running state.
   - **Failed / Reverted**: surface error, ask user (retry / reset / exit). The card shows the failed status and chunk-level error details from the last poll.

   > **Chunk-level generic SQL errors — auto-retry before escalating.** When individual chunks fail with a **Generic SQL error** (e.g., `1205` deadlock victim, `3732` type still referenced), these come from the **Dataverse SQL backend, not PAC/client-side**. Under chunked migration most are transient — `1205` is always a deadlock retry, and `3732` ("type still referenced") is frequently a concurrency side-effect from parallel chunk processing that clears on a fresh pass. **The refs migration is resumable**: re-running `pac pages migrate-datamodel --webSiteId "<WEBSITE_ID>" --mode configurationDataReferences` re-processes only the still-unmigrated chunks, so a retry is cheap and non-destructive. **Automatically retry the command up to 3 times** (30–60s backoff between attempts, re-entering the poll loop each time) whenever the only failures are chunk-level generic SQL errors — **do this even when the tracker labels a chunk `Non Retriable`**, because that label reflects PAC's in-run retry classification, not whether a fresh command invocation can succeed. Only escalate if the **same** chunks still fail with the **same** generic SQL error after the retries: capture the failing chunk IDs, error numbers, `pac --version`, WebSiteId, and environment URL for a Microsoft support ticket. Do **not** proceed to step 3.3 (Activate EDM) until refs migration reports `Completed`.

   > **PAC build compatibility:** `-s -v` works on most current builds. If your PAC errors with `An unknown argument --verbose was passed`, fall back to plain `--checkMigrationStatus` in the loop and emit a smaller `--set-refs-migration` payload (`status` + `currentStep` only) once per iteration.

**Output**: Transactional references migrated (or step skipped because mode=all). Live report's Transactional References Migration card reflected real-time progress during polling and shows the final completed/failed payload.

> **→ Update report:**
>
> ```
> --clear-activity
> --set-step 3.2 --status completed --output "<Refs migrated · status=<STATUS> | Skipped — already covered by mode=all in Phase 2.2>"
> ```
>
> When this step is skipped because mode=all, also emit a minimal `--set-refs-migration '{"status":"Completed","currentStep":"Skipped — covered by mode=all in Phase 2.2"}'` so the card shows a Completed pill instead of staying empty. Otherwise the polling loop above already emitted the final payload — no extra `--set-refs-migration` call needed here.

---

### 3.3 Activate EDM (Update Data Model Version)

**Goal**: Run `--updateDataModelVersion` to flip the site to EDM.

**Actions**:

1. **Retrieve Portal ID**

   Check the Portal Id state captured in step 1.3:

   - **If marked "captured"** (valid GUID from `pac pages list -v`): use directly — proceed to step 2.
   - **If marked "needs prompt"** (`Unknown`/`N/A`, column missing on older PAC builds, or the column was present but the value couldn't be parsed): ask the user to paste it directly. Don't try to construct a URL.

   **Why no URL construction:** the previous design constructed `<URL_SLUG>.<CLOUD_DOMAIN>` from a Public/UsGov/UsGovHigh/UsGovDod/China lookup so the user could fetch `portalId` from `<URL>/_services/about`. In practice this is brittle — it doesn't cover Preprod/TIE cloud rings, custom-domain sites, or the cases where DNS isn't resolvable from the user's network. Far simpler to just ask the user; they have several ways to find it:

   - **Easiest:** open Power Platform admin center → Resources → Power Pages sites → `<SITE_NAME>` → check the Site details panel for "Portal Id".
   - Or browse to the site URL (whatever it actually is) and append `/_services/about` — paste the `portalId` JSON value.
   - Or query `pac data` against the `mspp_website` / `adx_website` table for the `mspp_portalid` field.

   Ask via AskUserQuestion:

   | Question | Header | Options |
   |----------|--------|---------|
   | Step 1.3 didn't capture a usable Portal Id from `pac pages list -v`. Please paste the Portal Id for `<SITE_NAME>`. You can find it in Power Platform admin center → Resources → Power Pages sites → <SITE_NAME> → Site details panel, OR by browsing to your site URL + `/_services/about`. | Portal ID | I'll paste the Portal ID |

   Validate the pasted value is a GUID (`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`). Re-prompt if invalid. Store it — also needed for rollback in Phase 4.

   > **Do not run the update command until Portal Id is available.** Both `--updateDataModelVersion` and `--revertToStandardDataModel` reject empty Portal Id ([PAPortalMigrateDataModelVerb.cs:214](C:/Users/ashwanikumar/source/repos/PowerPlatform-Scale-AdminTools/src/cli/bolt.module.paportal/verbs/PAPortalMigrateDataModelVerb.cs#L214)).

2. **Confirm Activation**

   Activating EDM is a one-way switch from the user's perspective — the site begins serving from EDM tables, the SDM record is deactivated, and recovering requires the explicit `--revertToStandardDataModel` rollback path in Phase 4.2. Ask explicitly before running the command, even though Phase 3 was already approved at its start:

   | Question | Header | Options |
   |----------|--------|---------|
   | Ready to activate Enhanced Data Model for `<SITE_NAME>` using Portal Id `<PORTAL_ID>`? This deactivates the SDM record and the site will serve from EDM after the manual restart in step 3.4. | Activate EDM | Yes — activate now, No — pause, I want to verify something, Cancel — stop the skill |

   - **Yes**: proceed to step 3 (execute the command).
   - **No, pause**: halt cleanly; user can re-invoke later to resume from this gate.
   - **Cancel**: halt cleanly.

3. **Execute Update Command**

   ```powershell
   pac pages migrate-datamodel --webSiteId "<WEBSITE_ID>" --updateDatamodelVersion --portalId "<PORTAL_ID>"
   ```

4. **Confirm Switch**

   Inform user: "Data model updated. Site now uses Enhanced Data Model. SDM record has been deactivated."

**Output**: Site flipped to EDM in Dataverse; activation done.

> **→ Update report:**
>
> ```
> --set-site '{"portalId":"<PORTAL_ID>","currentDataModel":"Enhanced EDM"}'
> --set-step 3.3 --status completed --output "Data model flipped to EDM · Portal Id <PORTAL_ID>"
> ```

---

### 3.4 Restart Site (manual)

**Goal**: User must manually restart the site for the data model change to take effect at runtime. There is no PAC command for this.

**Actions**:

1. **Print restart instructions**

   > "The data model has been flipped to EDM in Dataverse, but the running site is still serving from cached SDM state. You need to restart the site for the change to take effect at runtime.
   >
   > **How to restart:**
   > 1. Open Power Platform admin center: <https://admin.powerplatform.microsoft.com>
   > 2. Navigate to your environment → **Resources** → **Power Pages sites**
   > 3. Find your site `<SITE_NAME>` and select it
   > 4. Click **Restart** (or **Deactivate** then **Activate** if Restart isn't available)
   > 5. Wait for the operation to complete (typically 1–3 minutes)"

2. **Wait for user confirmation**

   | Question | Header | Options |
   |----------|--------|---------|
   | Have you restarted the site? | Restart Confirmation | Yes, the site has been restarted, Not yet — I'll do it now (skill will wait), Cancel — stop here |

   - **Yes**: proceed to Phase 4.
   - **Not yet**: surface the instructions again, ask again. Skill stays paused at this gate.
   - **Cancel**: halt skill cleanly. The data model is already flipped — user can run `--revertToStandardDataModel` manually if needed.

**Output**: User has confirmed the site is restarted on EDM.

> **→ Update report (end of Phase 3 Authoring Track):**
>
> ```
> --set-step 3.4 --status completed --output "Site restarted by user · live on EDM"
> --set-phase 3 --status completed
> --set-approval 4 phase-start
> ```
>
> **📄 Checkpoint 6 — Tell the user about the report before asking for Phase 4 approval.** Print in chat:
>
> ```
> 📄 Phase 3 complete. The site is on EDM and restarted. Review before approving Phase 4:
>    <ABSOLUTE_PATH_TO_OUTPUT_DIR>\sdm-to-edm-migration-report.html
>
> Phase 4 will re-download the site as EDM, snapshot it, and diff against the SDM
> baseline to verify every record migrated.
> ```
>
> Then ask the user to approve Phase 4. On approval, run `node update-state.js --output-dir "<OUTPUT_DIR>" --approve-and-start 4` to atomically clear the approval gate and mark Phase 4 in-progress.

---

## Phase 3 — Downstream Track

**Applies when**: state.track === 'B' (mode = `configurationDataReferences`)

**Goal**: Capture an SDM baseline (the Downstream Track has no Phase 2 SDM capture), verify the upstream-imported metadata via SDM↔EDM diff, then migrate transactional references, locate and remediate the auto-emitted customization report (findings here usually indicate an ALM gap), activate EDM, prompt user to restart.

**Output**: Metadata diff confirmed, transactional refs migrated, customizations handled, site activated on EDM, user has confirmed restart.

---

### 3.1 Data Diff Validation (SDM ↔ EDM Metadata)

**Goal**: Before running the irreversible refs migration, capture an SDM baseline (Downstream Track has no Phase 2 SDM capture), re-download the site as EDM, and diff the two. Surface the result so the user can decide whether to proceed with refs migration or pause to investigate. The Pages & Components card in the live report visualizes the per-category comparison.

**Why pre-refs:** the Downstream Track assumes metadata arrived via ALM solution import — but until we diff against an SDM baseline, we have no proof that the import landed cleanly. Catching mismatches here lets the user fix the ALM source and re-import without having to roll back a completed refs migration.

**Actions**:

1. **Capture SDM snapshot** (Downstream Track specific — the Authoring Track captures this in 2.1)

   ```powershell
   pac pages download --webSiteId "<WEBSITE_ID>" --modelVersion 1 --path "<MIGRATION_OUTPUT_DIR>/site-sdm"
   ```

   > **Nested-folder quirk** applies — actual site root is one level deeper. Capture inner path as `<SITE_ROOT>` via `Get-ChildItem "<MIGRATION_OUTPUT_DIR>/site-sdm" -Directory`.

   Then snapshot:

   ```powershell
   node "${CLAUDE_PLUGIN_ROOT}/skills/migrate-datamodel/scripts/snapshot-site.js" `
     --site-root "<SITE_ROOT>" `
     --output-dir "<OUTPUT_DIR>" `
     --label sdm
   ```

2. **Re-download the migrated site as EDM**

   ```powershell
   pac pages download --webSiteId "<WEBSITE_ID>" --modelVersion 2 --path "<MIGRATION_OUTPUT_DIR>/site-edm"
   ```

   Site root lives one level deeper than `--path`. Capture inner path as `<SITE_ROOT_EDM>` via `Get-ChildItem "<MIGRATION_OUTPUT_DIR>/site-edm" -Directory`.

3. **Snapshot the EDM site**

   ```powershell
   node "${CLAUDE_PLUGIN_ROOT}/skills/migrate-datamodel/scripts/snapshot-site.js" `
     --site-root "<SITE_ROOT_EDM>" `
     --output-dir "<OUTPUT_DIR>" `
     --label edm
   ```

   Output: `<OUTPUT_DIR>/edm-snapshot.json`. The live report's **Pages & Components** card now shows `SDM → EDM` per-category pills.

4. **Diff SDM vs EDM**

   ```powershell
   node "${CLAUDE_PLUGIN_ROOT}/skills/migrate-datamodel/scripts/diff-snapshots.js" `
     --sdm "<OUTPUT_DIR>/sdm-snapshot.json" `
     --edm "<OUTPUT_DIR>/edm-snapshot.json" `
     --output-dir "<OUTPUT_DIR>"
   ```

   Output: `<OUTPUT_DIR>/migration-data-diff.json` + console table grouped by category. See Authoring Track 3.1 step 3 for the pass/warn/fail rubric.

5. **Surface the diff and gate refs migration**

   Same Checkpoint 7 chat callout and AskUserQuestion gate as Authoring Track 3.1 step 4. On "Looks fine" proceed to step 3.2; on "Concerning" halt cleanly so the user can fix the upstream ALM source and re-import; on "Cancel" halt.

**Output**: SDM baseline captured, metadata SDM↔EDM diff complete, user has decided whether to proceed with refs migration.

> **→ Update report:** `--set-step 3.1 --status completed --output "Metadata diff: <PASS|WARN|FAIL> · <N> missing · <M> extra · <S> state-changed · user chose: <choice>"`

---

### 3.2 Migrate Transactional References

**Goal**: Run `pac pages migrate-datamodel --mode configurationDataReferences` to move transactional data references.

**Actions**:

1. **Execute Migration Command**

   ```powershell
   pac pages migrate-datamodel --webSiteId "<WEBSITE_ID>" --mode configurationDataReferences
   ```

   Newer PAC versions auto-emit `SiteCustomization*.csv` into `<OUTPUT_DIR>` or cwd.

2. **Poll Status with Verbose Output**

   Poll every 1 minute using `-s -v` so each iteration captures the full tracker payload and refreshes the live report's **Transactional References Migration** card. Same loop shape as Authoring Track 3.2 step 3 — see there for the full PowerShell snippet and JSON payload schema. The Downstream Track loop is identical apart from the schema source comment.

   ```powershell
   $webSiteId = "<WEBSITE_ID>"
   $outputDir = "<OUTPUT_DIR>"
   $finalPayload = $null
   for ($i = 1; $i -le 30; $i++) {
     $verboseOutput = pac pages migrate-datamodel --webSiteId $webSiteId -s -v 2>&1 | Out-String

     # Build the --set-refs-migration JSON payload — see Authoring Track 3.2
     # step 3 for the field schema. Pass the produced JSON STRING, not the
     # literal `<PARSED_JSON>` placeholder, or cmdSetRefsMigration will error.
     $refsPayload = @{
       status      = '<STATUS_FROM_OUTPUT>'
       currentStep = '<STEP_FROM_OUTPUT>'
       createdAt   = '<ISO_FROM_OUTPUT>'
       modifiedAt  = '<ISO_FROM_OUTPUT>'
       stepHistory = @( <ARRAY_OF_OBJECTS_FROM_OUTPUT> )
       runs        = @( <ARRAY_OF_RUN_OBJECTS_FROM_OUTPUT> )
     } | ConvertTo-Json -Compress -Depth 10
     $finalPayload = $refsPayload

     node update-state.js --output-dir $outputDir --set-refs-migration $refsPayload
     node update-state.js --output-dir $outputDir --set-activity "Polling migration status (attempt $i/30)"
     if ($verboseOutput -match "Current migration status is\s*:\s*Completed") { break }
     if ($verboseOutput -match "Current migration status is\s*:\s*Failed")    { break }
     if ($verboseOutput -match "Current migration status is\s*:\s*Reverted")  { break }
     Start-Sleep -Seconds 60
   }

   # Guaranteed final refresh (safe; cmdSetRefsMigration is idempotent).
   if ($finalPayload) {
     node update-state.js --output-dir $outputDir --set-refs-migration $finalPayload
   }
   ```

   - **Completed**: clear activity, proceed to step 3.3. The card now shows status=Completed.
   - **In Progress (30-min timeout)**: surface timeout, ask user (retry / reset / exit). The card shows the last captured running state.
   - **Failed / Reverted**: surface error, ask user; card shows the failed status and chunk-level errors from the last poll.

   > **Chunk-level generic SQL errors — auto-retry before escalating.** Same handling as Authoring Track 3.2: chunk-level **Generic SQL error** failures (e.g., `1205` deadlock victim, `3732` type still referenced) are **Dataverse SQL-backend errors, not PAC/client-side**, and are usually transient under chunked migration. Because the refs migration is resumable (re-running re-processes only the still-unmigrated chunks), **automatically retry the command up to 3 times** (30–60s backoff, re-entering the poll loop) whenever the only failures are chunk-level generic SQL errors — **even when a chunk is labeled `Non Retriable`**, since that label is PAC's in-run classification, not a verdict on a fresh invocation. Only escalate to a Microsoft support ticket (chunk IDs, error numbers, `pac --version`, WebSiteId, env URL) if the **same** chunks fail with the **same** error after the retries. Do **not** proceed until refs migration reports `Completed`.

   > **PAC build compatibility:** `-s -v` works on most current builds. If your PAC errors with `An unknown argument --verbose was passed`, fall back to plain `--checkMigrationStatus` in the loop and emit a smaller `--set-refs-migration` payload (`status` + `currentStep` only) once per iteration.

**Output**: Transactional references migrated, customization CSV auto-emitted. Live report's Transactional References Migration card reflected real-time progress during polling.

> **→ Update report:**
>
> ```
> --clear-activity
> --set-step 3.2 --status completed --output "Refs migrated · status=<STATUS>"
> ```
>
> The polling loop above already emitted the final payload; no extra `--set-refs-migration` call needed here.

---

### 3.3 Locate Customization Report

**Goal**: Find the CSV PAC auto-generated in step 3.2; fall back to explicit generation if missing.

**Actions**:

Same logic as Authoring Track Phase 2.3 — glob `SiteCustomization*.csv` in `<OUTPUT_DIR>` + cwd; if missing, run explicit `--siteCustomizationReportPath`; parse and summarize findings.

**Output**: Customization report located and parsed.

> **→ Update report:**
>
> ```
> --set-step 3.3 --status completed --output "CSV: <PATH> · <N> findings total"
> --set-customization-report '{"path":"<ABSOLUTE_PATH_TO_OUTPUT_DIR>/customization-report.html","csvPath":"<ABSOLUTE_PATH_TO_OUTPUT_DIR>/SiteCustomization.csv","totalFindings":<N>,"breakdown":{"fetchxml":<N>,"liquid":<N>,"dme":<N>,"plugins":<N>,"workflows":<N>,"relationships":<N>}}'
> ```
>
> Pass absolute paths so the live report's "Open customization-report.html" link works no matter where the user opens the report from. Omit any breakdown keys with zero count.

---

### 3.4 Remediate Customizations

**Goal**: If customizations are flagged, apply auto-rewrites + augmented prompts and upload. Findings on Prod/Test/UAT usually indicate an ALM gap, so the warning is stronger than the Authoring Track's.

**Actions**:

1. **Branch on findings**

   - **Zero findings**: log "no customizations to remediate" and proceed to step 3.5.
   - **Has findings**: surface ALM-gap warning, ask user how to proceed.

2. **Surface ALM-gap warning**

   | Question | Header | Options |
   |----------|--------|---------|
   | Found `<N>` customization findings on this Prod/Test/UAT env. Customizations should have been remediated in Dev and shipped via solution import — finding them here indicates an ALM gap. How do you want to proceed? | Prod Customizations | Remediate now (auto-rewrite + augmented prompts + upload), Pause skill — I'll fix at source in Dev and re-import the solution, Cancel — stop the skill |

   - **Remediate now**: proceed with the auto-rewriter steps below.
   - **Pause skill**: halt cleanly; user fixes upstream and re-runs.
   - **Cancel**: halt cleanly.

3. **Stage FetchXML rewrites** — same script as Authoring Track Phase 2.4 step 3 (writes proposed files to `remediation-staged/`).

4. **Stage Liquid annotations** — same script as Authoring Track Phase 2.4 step 4 (writes annotated files to `remediation-staged/`).

5. **Generate augmented prompts** — same as Authoring Track Phase 2.4 step 5 (plugin + DME prompts surfaced for separate Claude sessions).

6. **Review and approve** — same as Authoring Track Phase 2.4 step 6 (`--set-approval 3 in-phase`, AskUserQuestion gates the apply+upload). Users review the **Remediation Diff** card in the live report.

7. **Apply staged changes and upload** — same as Authoring Track Phase 2.4 step 7 (`apply-remediation.js` copies staged → live, then `pac pages upload`). On "No — discard staged changes", run `apply-remediation.js --discard` and skip upload.

   ```powershell
   node "${CLAUDE_PLUGIN_ROOT}/skills/migrate-datamodel/scripts/apply-remediation.js" `
     --output-dir "<OUTPUT_DIR>" `
     --site-root "<SITE_ROOT>"

   pac pages upload --path "<SITE_ROOT>" --modelVersion 1
   ```

   > **→ Update report (after upload):** `--clear-approval`.

**Output**: Customizations remediated and uploaded (or zero findings, skipped).

> **→ Update report:** `--set-step 3.4 --status completed --output "<Auto-rewrites uploaded | No customizations to remediate>"`

---

### 3.5 Activate EDM (Update Data Model Version)

Identical to the Authoring Track's step 3.3 — retrieve Portal ID, ask the user to confirm activation via AskUserQuestion, run `--updateDataModelVersion`, confirm switch.

> **→ Update report:**
>
> ```
> --set-site '{"portalId":"<PORTAL_ID>","currentDataModel":"Enhanced EDM"}'
> --set-step 3.5 --status completed --output "Data model flipped to EDM · Portal Id <PORTAL_ID>"
> ```

---

### 3.6 Restart Site (manual)

Identical to the Authoring Track's step 3.4 — print restart instructions, wait for user confirmation via AskUserQuestion.

> **→ Update report (end of Phase 3 Downstream Track):**
>
> ```
> --set-step 3.6 --status completed --output "Site restarted by user · live on EDM"
> --set-phase 3 --status completed
> --set-approval 4 phase-start
> ```
>
> **📄 Checkpoint 6 — Tell the user about the report before asking for Phase 4 approval.** Print in chat:
>
> ```
> 📄 Phase 3 complete. The site is on EDM and restarted. Review before approving Phase 4:
>    <ABSOLUTE_PATH_TO_OUTPUT_DIR>\sdm-to-edm-migration-report.html
>
> Phase 4 will re-download the site as EDM, snapshot it, and diff against the SDM
> baseline to verify every record migrated.
> ```
>
> Then ask the user to approve Phase 4. On approval, run `node update-state.js --output-dir "<OUTPUT_DIR>" --approve-and-start 4` to atomically clear the approval gate and mark Phase 4 in-progress.


## Phase 4: Post-Migration Validation

**Goal**: Validate the migrated site, optionally rollback if issues are found, and produce the final execution report.

**Output**: Site confirmed working on EDM (or rolled back to SDM), success summary presented, execution report finalized.

> **Future enhancement (placeholder):** automated functional test cases (rendering checks, form submission, web API calls, auth flow smoke tests) will be added here in a follow-up session.

---

### 4.1 Runtime Smoke Test Recommendation (/test-site)

**Goal**: Recommend that the user run `/test-site` against the live migrated site for a browser-based smoke check. This step is **explicitly a recommendation step** in the live report — it's visible as a discrete sub-step so the user understands the runtime check is a real, recommended part of Phase 4.

> **Skip this sub-step if Phase 3.1 (Data Diff Validation) user chose "Concerning"** — we never reached this point because Phase 3 halted. This guard is here defensively in case the agent reaches 4.1 with a degraded migration; in normal flow, only `PASS`/`WARN` diffs let execution continue past the Phase 3.1 gate.

**Actions**:

1. **Print the hand-off message** (informational text, not an AskUserQuestion):

   ```
   📄 Runtime smoke test — recommended next step.

   The migrated site is live at:
      <SITE_URL>

   Open a SEPARATE Claude Code session and run:
      /test-site <SITE_URL>

   /test-site uses Playwright to crawl up to 25 pages, capture API calls,
   check console errors, and report pass/fail per page and per endpoint.
   It needs only the live URL — no re-download required. The site URL
   is unchanged from before migration; only the data model underneath
   has changed.

   What /test-site catches that the data diff cannot:
   • Pages whose records all migrated but render empty because a
     FetchXML rewrite has the wrong powerpagecomponenttype filter
   • Table permissions that worked on SDM but block on EDM (401/403)
   • Liquid runtime errors visible only in browser console
   ```

2. **Ask the user whether they've completed it** (this lets the live report's 4.2 sub-step actually track to a real user decision):

   | Question | Header | Options |
   |----------|--------|---------|
   | Have you run `/test-site` against the live site? (The pre-flight metadata diff already passed in Phase 3.1; this is the recommended runtime check before marking the migration complete.) | Runtime Check | I've run it — all passed, I've run it — issues found, I'll skip and run it later, Skip entirely |

   - **All passed**: log success, proceed to step 4.2.
   - **Issues found**: log details (user describes), proceed to step 4.2 (user can still pick "Validated — but rollback needed" or "Deferred").
   - **Skip and run later**: log "deferred runtime check," proceed to step 4.2.
   - **Skip entirely**: log "user declined runtime check," proceed to step 4.2.

> **Why we don't auto-invoke `/test-site` from here:** the test-site skill is interactive (asks the user to log in for auth-gated sites). Invoking it programmatically from inside this skill would deny the user the chance to pick a browser session and login profile, and would block this skill on a long browser-driven run. The recommendation pattern keeps the workflows decoupled.

**Output**: User has run, deferred, or declined `/test-site`. Result captured for step 4.2.

> **→ Update report (end of 4.1):** `--set-step 4.1 --status completed --output "Runtime check: <passed | issues found: <details> | deferred | declined>"`

---

### 4.2 Final Status, Optional Rollback, Summary

**Goal**: Capture the user's final validation status, perform rollback if requested, and print the success/rollback summary.

**Actions**:

1. **Ask for final validation status**

   | Question | Header | Options |
   |----------|--------|---------|
   | Final validation status for this migration? | Final Status | Validated — all good, Rollback to SDM, Deferred — I'll validate later |

   - **Validated — all good**: proceed to step 3 (success summary).
   - **Rollback to SDM**: proceed to step 2 (rollback).
   - **Deferred**: skip to step 3 with a note that final validation was deferred.

2. **Rollback (if user opted for it)**

   Confirm the Portal ID collected during activation (Authoring Track step 3.3 or Downstream Track step 3.5) is still correct:

   | Question | Header | Options |
   |----------|--------|---------|
   | Confirm Portal ID for rollback: `<PORTAL_ID>`. Is this correct? | Confirm Portal ID | Yes, proceed with rollback, No, let me re-enter it |

   If "No": ask user to paste the correct Portal ID directly (don't try to construct the site URL — same reasoning as Authoring Track step 3.3 / Downstream Track step 3.5).

   ```powershell
   pac pages migrate-datamodel --webSiteId "<WEBSITE_ID>" --revertToStandardDataModel --portalId "<PORTAL_ID>"
   ```

   Inform user: "Site reverted to SDM. EDM record deactivated, SDM record reactivated."

3. **Success Summary**

   Print to chat:

   ```
   ✅ Migration Complete

   Site:                <SITE_NAME> (ID: <WEBSITE_ID>)
   Previous model:      Standard (SDM)
   Current model:       Enhanced (EDM) | Reverted to Standard (SDM)
   Data diff:           <PASS | WARN | FAIL> — <summary>
   Runtime check:       <passed | issues found | deferred | declined>
   Customizations:      <count> (or "None") — see customization-report.html
   Environment:         <ENV_TYPE>
   Track:               <Authoring | Downstream>

   Reports in <OUTPUT_DIR>:
     migration-state.json          — single source of truth for state
     sdm-to-edm-migration-report.html   — live execution timeline (this run)
     customization-report.html     — findings catalog (if any)
     sdm-snapshot.json             — SDM baseline
     edm-snapshot.json             — EDM result
     migration-data-diff.json      — full diff report
     plugin-remediation-prompt.txt — augmented prompt (if findings)
     dme-remediation-prompt.txt    — augmented prompt (if findings)
   ```

4. **Record Skill Usage**

   Follow instructions in `${CLAUDE_PLUGIN_ROOT}/references/skill-tracking-reference.md`.

5. **Emit Completion Telemetry**

   Fire the anonymous `skill_completed` 1DS event with a per-phase rollup built
   from `migration-state.json`. This is best-effort and fails closed — never
   block or surface errors from it:

   ```powershell
   node "${CLAUDE_PLUGIN_ROOT}/skills/migrate-datamodel/scripts/emit-telemetry.js" --output-dir "<OUTPUT_DIR>"
   ```

   `<OUTPUT_DIR>` is the per-migration subfolder holding `migration-state.json`.
   The script honors the plugin telemetry kill switch / opt-out and sends only
   non-PII product signals (track, migration mode, template, per-phase status +
   duration). No site names, URLs, environment names, or paths are sent.

**Output**: Migration complete (or rolled back), final summary printed, skill usage recorded.

> **→ Update report (end of Phase 4):**
>
> ```
> --set-step 4.2 --status completed --output "<Migration complete | Rolled back | Deferred>"
> --set-phase 4 --status completed
> ```
>
> No further approval gates. Live report header pill switches to "✅ Migration Complete".

---

## Progress Tracking

| Phase | Task Subject | Active Form |
|-------|-------------|-------------|
| Phase 1 | Site Discovery & Pre-checks | Setting up for migration |
| Phase 2 | Configuration Setup | Setting up configuration (track-aware) |
| Phase 3 | Migration Execution | Executing migration and activating EDM |
| Phase 4 | Post-Migration Validation | Validating and completing migration |

> **Track-aware naming for Phase 2 and Phase 3:** Both phases have different structures depending on the track derived in step 1.7. The live execution report shows the track-specific phase title and sub-step list:
>
> - **Authoring Track** (mode = `configurationData` or `all`):
>   - Phase 2 renders as "Configuration Migration & Customization Remediation" (**4 sub-steps**: Capture SDM Snapshot → Migrate Metadata → Locate Customization Report → Remediate Customizations)
>   - Phase 3 renders as "Migration Execution" (**4 sub-steps**: Data Diff Validation → Migrate Refs → Activate EDM → Restart)
> - **Downstream Track** (mode = `configurationDataReferences`):
>   - Phase 2 renders as "Setting Up Metadata" (3 sub-steps)
>   - Phase 3 renders as "Migration Execution" (**6 sub-steps**: Data Diff Validation → Migrate Refs → Locate Report → Remediate → Activate EDM → Restart)
>
> **Phase 4 has 2 sub-steps in both tracks**: Runtime Smoke Test Recommendation (`/test-site`) → Final Status & Summary. The SDM↔EDM data diff that used to live in Phase 4.1 was promoted to Phase 3.1 as a pre-refs safety gate.
>
> **Authoring Track total = 17 sub-steps. Downstream Track total = 18 sub-steps.** The `--set-track A|B` command at end of 1.7 (where `A` = Authoring Track and `B` = Downstream Track) rebuilds Phase 2 and Phase 3 cards in the live report from the chosen blueprint.

---

## Component Type Reference

Use this for FetchXML and Liquid customization mapping:

| Component | Type Value |
|-----------|------------|
| Publishing State | 1 |
| Web Page | 2 |
| Web File | 3 |
| Web Link Set | 4 |
| Web Link | 5 |
| Page Template | 6 |
| Content Snippet | 7 |
| Web Template | 8 |
| Site Setting | 9 |
| Web Page Access Control Rule | 10 |
| Web Role | 11 |
| Website Access | 12 |
| Site Marker | 13 |
| Basic Form | 15 |
| Basic Form Metadata | 16 |
| List | 17 |
| Table Permission | 18 |
| Advanced Form | 19 |
| Advanced Form Step | 20 |
| Advanced Form Metadata | 21 |
| Poll Placement | 24 |
| Ad Placement | 26 |
| Bot Consumer | 27 |
| Column Permission Profile | 28 |
| Column Permission | 29 |
| Redirect | 30 |
| Publishing State Transition Rule | 31 |
| Shortcut | 32 |
| Cloud Flow | 33 |
| UX Component | 34 |
