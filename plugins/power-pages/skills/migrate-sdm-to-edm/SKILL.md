---
name: migrate-sdm-to-edm
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

> **Plugin check**: Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/check-version.js"` — if it outputs a message, show it to the user before proceeding.

# Migrate Power Pages Site from Standard to Enhanced Data Model

Guide the user through a comprehensive migration of an existing Power Pages site from the Standard Data Model (SDM) to the Enhanced Data Model (EDM). The skill is organized into **four high-level phases** — Pre-flight Setup, Customization Remediation, Migration Execution, and Post-Migration Validation. Each phase contains numbered sub-steps for granular execution and progress tracking.

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

## Phase 1: Pre-flight Setup

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

   Run these checks in order to determine `<SITE_ROOT>` (where the site source lives or will be downloaded to) and `<OUTPUT_DIR>` (where all migration artifacts go):

   ```powershell
   # Check A: is cwd itself a site root?
   Test-Path .\website.yml

   # Check B: if A is False, is there a single subdirectory containing a site root?
   Get-ChildItem -Directory | Where-Object { Test-Path (Join-Path $_.FullName 'website.yml') }
   ```

   Resolve based on results:

   | Result of check A | Result of check B | `<SITE_ROOT>` | `<OUTPUT_DIR>` |
   |---|---|---|---|
   | True (cwd is the site) | — | `.` (cwd) | `..\migration-reports` (sibling of site dir, so site source stays clean) |
   | False | Exactly one subdir | `.\<subdir>` | `.\migration-reports` (in cwd alongside the site folder) |
   | False | Zero or multiple subdirs | (will download to `.\mysite\<auto-slug>` in step 2.2) | `.\migration-reports` (in cwd) |

   Capture both `<SITE_ROOT>` and `<OUTPUT_DIR>` as durable values used throughout the rest of the skill. Create `<OUTPUT_DIR>` if it doesn't exist yet.

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

   In this path, `<SITE_ROOT>` will be set to the path step 2.2 downloads to (typically `.\mysite\<auto-slug>` once `pac pages download` runs).

**Output**: WebSiteId captured; `<SITE_ROOT>` and `<OUTPUT_DIR>` resolved (or marked "download in step 2.2" for `<SITE_ROOT>`)

---

### 1.3 Site Discovery and Validate Data Model

**Goal**: Find the site in the environment and verify it's on SDM (not already EDM)

**Actions**:

1. **List All Sites**

   ```powershell
   pac pages list -v
   ```

   Verbose output columns: `Index | Website Id | Portal Id | Friendly Name | Portal Url | Data Model Version | Single Page Application | Is Site Active`.

   Parse output to extract all available sites with:
   - WebSiteId
   - Portal Id (may render as `Unknown` if the Power Platform active-websites API failed, or `N/A` if the site is inactive — treat both as "missing" for step 3.2)
   - Site Name (display name from Friendly Name, the part before " - ")
   - URL slug (from Friendly Name, the part after " - ")
   - Current ModelVersion (`Standard` or `Enhanced`)

   > **Note:** Template name is not included in `pac pages list` output. Template will be confirmed separately in step 4.
   >
   > **PAC CLI version note:** The Portal Id column was added on 2026-02-24. If your installed PAC build predates that and the column is missing entirely, treat Portal Id as missing — step 3.2 will prompt the user before the data-model update.

2. **Locate Target Site**

   Search the list for site matching user input (name or GUID):
   - If found: Extract WebSiteId, Portal Id, ModelVersion, and URL slug. Store all four for later phases. If Portal Id parsed as a valid GUID, mark it as "captured"; if `Unknown`/`N/A`/missing, mark as "needs prompt".
   - If not found: Show list and ask user to confirm site name/ID. If still not found, stop and ask user to verify in Power Platform admin center.

3. **Validate Data Model**

   Check `ModelVersion` from output:
   - **If EDM**: Stop with message: "This site is already on Enhanced Data Model. Migration not needed."
   - **If SDM**: Continue to step 1.4

4. **Identify Site Template**

   Template name is not available from `pac pages list`. If step 1.4 reads `adx_templatename` from the migration tracker (populated by a prior migration), use that; otherwise ask user:

   | Question | Header | Options |
   |----------|--------|---------|
   | What template is this site based on? | Site Template | Starter layout 1, Starter layout 2, Starter layout 3, Starter layout 4, Starter layout 5, Application processing, Blank page, Program registration, Schedule and manage meetings, FAQ, Event registration, Community Portal (D365), Customer Self-Service Portal (D365), Employee Self-Service Portal (D365), Partner Portal (D365), Other/Unknown |

   Store the chosen template — it drives the V2 package check in step 1.6. If "Other/Unknown", proceed with caution; step 1.6 will skip the template-specific package check and rely on `PowerPages_Core` validation only.

**Output**: Target site confirmed as SDM, template confirmed by user, WebSiteId/ModelVersion/URL slug/Portal Id captured (Portal Id marked "captured" or "needs prompt")

---

### 1.4 Check Existing Migration Status

**Goal**: Detect whether a migration is already in flight, previously completed, or previously failed for this site — and recover or short-circuit accordingly before doing any new work

**Actions**:

1. **Query Current Status**

   ```powershell
   pac pages migrate-datamodel --webSiteId "<WEBSITE_ID>" --checkMigrationStatus --verbose
   ```

   The `--verbose` flag returns the tracker summary (`createdOn`, `modifiedOn`, `migrationStatus`) plus a step history with per-step UTC timestamps and any chunk errors.

2. **Parse Status**

   Extract:
   - **Status**: one of `NotStarted`, `Running`, `Completed`, `Failed`, `Reverted`, `Unknown`
   - **createdOn** (migration first started) and **modifiedOn** (last update) for elapsed-time calculations
   - **currentStep** and **stepHistory** from the step config block (granular progress)

3. **Branch Based on Status**

   - **NotStarted / no tracker record**: No prior migration. Proceed to step 1.5.

   - **Reverted**: Site was previously rolled back to SDM. Treat as fresh start. Proceed to step 1.5.

   - **Completed**: A prior migration finished but the data model version was not yet flipped to EDM (otherwise step 1.3 would have stopped earlier). Skip steps 1.5–3.1 and jump directly to **step 3.2 (Update Data Model Version)**.

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

     - **Wait**: Skip steps 1.5–3.1 pre-migration work and jump directly to **step 3.1 action 3 (status polling loop)**. After completion, continue to step 3.2.
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

---

### 1.5 Validate Required Dependencies

**Goal**: Verify required packages are installed in environment

**Actions**:

1. **Check Installed Solutions**

   Run the following to list **all** solutions in the environment, including first-party Microsoft solutions:

   ```powershell
   pac solution list --includeSystemSolutions
   ```

   > **Important:** The `--includeSystemSolutions` flag is required. Without it, `pac solution list` returns only user/managed-by-customer solutions and omits the first-party packages we need to verify (`CDSBasePortal`, `PowerPagesCore`, and the V2 template solutions checked in step 1.6).

   Search the output for:
   - `CDSBasePortal` — Dataverse base portal package (required: 9.3.2307.x+)
   - `PowerPagesCore` — Power Pages Core package (required: 1.0.2309.63+)

   Present the found versions to the user.

2. **Evaluate Results**

   - **Both found and versions meet requirements**: Inform user and proceed to step 1.6.
   - **One or both not found**: Stop with message: "Required packages are not installed. Please install them from Power Platform admin center > Manage > Dynamics 365 apps before proceeding."
   - **Found but version too low**: Show current vs required version and stop with upgrade guidance.
   - **`pac solution list --includeSystemSolutions` fails or output is unclear**: Fall back to asking the user:

   | Question | Header | Options |
   |----------|--------|---------|
   | Unable to verify packages automatically. Can you confirm both Dataverse base portal package (9.3.2307.x+) and Power Pages Core (1.0.2309.63+) are installed? | Deps Confirmed | Yes, confirmed, Not sure — help me check |

   - If "Not sure": Guide user to Power Platform admin center > Solutions to verify package versions.
   - If "Yes": Proceed to step 1.6.

**Output**: Required package versions verified (Dataverse base portal 9.3.2307.x+, Power Pages Core 1.0.2309.63+)

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
   - **Not found**: Ask user:

     | Question | Header | Options |
     |----------|--------|---------|
     | The V2 EDM solution `<UNIQUE_NAME>` for your template is not installed. How to proceed? | V2 Package | Install via dummy EDM site (recommended), Skip and let migration warn, Cancel |

     - **Install via dummy EDM site**: Guide user to provision a new EDM site using the same template in this environment. Creating that site auto-installs the V2 solution. Once installed, the dummy site can be deleted.
     - **Skip**: Continue to step 1.7; migration may warn or fail if the solution is genuinely needed.
     - **Cancel**: Halt the skill.

3. **Verify PowerPages_Core Application**

   Check if `PowerPages_Core` application is installed. If missing, ask:

   | Question | Header | Options |
   |----------|--------|---------|
   | PowerPages_Core application is not installed. Should I install it now? | Install Core | Yes, install, No, skip |

   If "Yes":

   ```powershell
   pac application install --application-name "PowerPages_Core"
   ```

   Wait for completion or failure.

**Output**: V2 template package verified/installed (or explicitly skipped); PowerPages_Core available

---

### 1.7 Determine Environment Type and Migration Mode

**Goal**: Capture environment type and select migration data mode

**Actions**:

1. **Identify Environment Type**

   | Question | Header | Options |
   |----------|--------|---------|
   | Which type of environment is this? | Environment Type | Development (Dev), Test/UAT, Production (Prod) |

   Store the choice.

2. **Recommend Migration Mode Based on Environment**

   - **Dev**: Recommend `all` (migrate both configuration metadata and transactional data — full migration on Dev)
   - **Test/UAT/Prod**: Recommend `configurationData` (configuration metadata only)

   Environment type is captured for context; ALM integration is reserved for future versions of this skill.

3. **Confirm Migration Mode**

   Show recommendation with explanation:

   | Question | Header | Options |
   |----------|--------|---------|
   | Recommended migration mode for `<ENV_TYPE>`: `<MODE>`. Proceed? | Migration Mode | Yes, use recommended mode, No, let me choose a different mode |

   If "No", show all three modes with descriptions and allow selection:
   - `configurationData`: Migrate the metadata for the website. More information: List of tables to store configuration data.
   - `configurationDataReferences`: Migrate the transactional data for the website. More information: List of tables to store nonconfiguration data.
   - `all`: Migrate both configuration metadata and transactional data.

   Store final selected mode.

**Output**: Environment type captured, migration mode selected

---

## Phase 2: Customization Remediation

**Goal**: Identify customizations on the SDM site, apply auto-rewrites to source files where safe, surface per-finding guidance for manual fixes, get user approval, and upload the cleaned-up source back to Dataverse — all before any data migration runs.

**Output**: Customization report generated, FetchXML auto-rewrites applied and uploaded, Liquid suggestions surfaced, manual remediation reminders presented, final readiness gate confirmed.

---

### 2.1 Generate Customization Report

**Goal**: Download and analyze current customizations on the SDM site

**Actions**:

1. **Run Customization Report Generation**

   Use the `<OUTPUT_DIR>` resolved in step 1.2 (either `./migration-reports` if a working dir, or `../migration-reports` if cwd IS the site root).

   ```powershell
   pac pages migrate-datamodel --webSiteId "<WEBSITE_ID>" --siteCustomizationReportPath "<OUTPUT_DIR>"
   ```

   PAC creates the directory if it doesn't already exist and writes `<OUTPUT_DIR>/SiteCustomization.csv` (or `SiteCustomization<N>.csv` if re-run — auto-numbered).

   > **Note on file location quirks:** On some PAC builds the CSV may land in the parent or current working directory instead of the path you passed. After running, **Glob for `SiteCustomization*.csv` in both `<OUTPUT_DIR>` and cwd** to find the actual file. Use the most recent one (highest auto-number) if multiple exist.

2. **Parse Report**

   Read the CSV (use the path discovered above) and categorize findings:
   - Liquid contains adx references
   - Data Model Extension (custom columns on adx tables)
   - Plugins registered on adx entities
   - Custom workflows
   - Relationships between custom and adx tables
   - FetchXML with adx references

   > **Important:** The CSV's `Location` column contains paths to PAC's internal scan temp folder (e.g., `\\?\C:\Users\...\Temp\<site-slug>\web-templates\X\Y.html`). **Do NOT** use those paths to locate or modify files. They're informational only — for actual rewrites use the path captured in step 1.2 (`<SITE_ROOT>`). The script's `normalizeLocationPath()` strips the temp prefix when rendering the HTML report.

3. **Generate HTML Report**

   ```bash
   node scripts/generate-migration-reports.js \
     --customization-report "<OUTPUT_DIR>/SiteCustomization.csv" \
     --site-name "<SITE_NAME>" \
     --website-id "<WEBSITE_ID>" \
     --output-dir "<OUTPUT_DIR>"
   ```

   This creates `<OUTPUT_DIR>/customization-report.html` and `<OUTPUT_DIR>/skill-execution-report.html` alongside the CSV — single folder for all migration artifacts.

4. **Present Findings**

   Show summary of customizations found (by category) or "No customizations found" if clean.

**Output**: Customization report generated and analyzed

---

### 2.2 Remediate Customizations

**Goal**: Apply fixes to the site source files for customizations that genuinely need rewriting, before executing migration

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

### 2. Set up the working directory

Auto-fix and semi-auto fix both require the site source files to be on disk:

- **If `website.yml` exists in the current working directory** (the user has the site downloaded): ask the user to confirm the working copy is committed/saved before any rewrites.

  | Question | Header | Options |
  |----------|--------|---------|
  | Site source detected at `<CWD>`. Have you committed/saved your work? We'll modify source files. | Source Ready | Yes, proceed, No, let me commit first, Cancel |

- **Otherwise**: download the site to cwd before fixing.

  ```powershell
  pac pages download --webSiteId "<WEBSITE_ID>" --path "./mysite"
  ```

  > **Important — nested folder quirk:** `pac pages download --path ./mysite` creates a slug-named child folder inside (e.g., `./mysite/site-1---site-k5s85/website.yml`). The actual site root with `website.yml` is one level deeper than `--path`. Update the resolved `<SITE_ROOT>` to point at that inner folder (use `Get-ChildItem .\mysite -Directory` to find it). Subsequent rewrite and upload steps must use `<SITE_ROOT>` (the inner path), not `./mysite`.

### 3. Run automated FetchXML rewrites

```powershell
node "${CLAUDE_PLUGIN_ROOT}/skills/migrate-sdm-to-edm/scripts/generate-migration-reports.js" `
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
- Writes `<file>.pre-edm.bak` sibling before modifying each file
- Produces a unified diff in `<output-dir>/fetchxml-rewrites.diff`
- Logs each rewrite in the execution report (`skill-execution-report.html`)

### 4. Run semi-automated Liquid `entities['adx_*']` rewrites

```powershell
node "${CLAUDE_PLUGIN_ROOT}/skills/migrate-sdm-to-edm/scripts/generate-migration-reports.js" `
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
- Logs all suggestions in the execution report

### 5. Review and approve changes

After steps 3 and 4, show the user:

- Path to the diff file (`fetchxml-rewrites.diff`)
- Path to the Liquid suggestions report
- Path to all `*.pre-edm.bak` files (so they can revert if needed)

  | Question | Header | Options |
  |----------|--------|---------|
  | Review the rewrites in `<diff-file>`. Approve and upload to Dataverse? | Approve Rewrites | Yes, upload now, No, cancel, Let me edit further first |

### 6. Upload approved changes back to Dataverse

If approved:

```powershell
pac pages upload --path "<SITE_ROOT>" --modelVersion 1
```

> **PAC CLI argument notes:**
>
> - `pac pages upload` does **not** accept `--webSiteId` — the site is inferred from `website.yml` inside `<SITE_ROOT>`. If you pass `--webSiteId`, PAC errors with "An unknown argument --webSiteId was passed."
> - `--modelVersion 1` = SDM (the site is still SDM at this point, since step 3.2 hasn't flipped it yet). After step 3.2 the site is on EDM and subsequent uploads would use `--modelVersion 2`.
> - `<SITE_ROOT>` must point at the directory containing `website.yml` (not the wrapper `./mysite`). See the "nested folder quirk" note above.

This pushes the rewritten source files back to the SDM site's Dataverse records, ready for step 3.1 migration.

### 7. Manual remediation reminders (for non-automatable categories)

Show user the following before proceeding to step 3.1:

**Data Model Extensions** — for each custom column found on `adx_*` tables, the user must, in the Data workspace:

1. Create a new custom table (e.g., `contoso_webpage`)
2. Add the custom column (e.g., `contoso_pagetype`) to the new table
3. Add a lookup column on the new table pointing to `powerpagecomponent`
4. Migrate data from the old column to the new table
5. Update any Liquid/FetchXML to reference the new table

**Custom-to-adx relationships** — create a new relationship between the custom table and `powerpagecomponent` (e.g., `powerpagecomponent_contoso_pagelogs`).

**Plugins/Workflows on `adx_*` tables** — refactor code to target `powerpagecomponent`, update attribute references, re-register on the new table.

Reference: <https://learn.microsoft.com/en-us/power-pages/admin/migrate-enhanced-data-model#considerations-for-site-customization-when-migrating-sites-from-standard-to-enhanced-data-model>

### 8. Final readiness check before migration

After auto-rewrites are uploaded and manual recommendations have been presented, gate the transition to step 3.1 explicitly:

| Question | Header | Options |
|----------|--------|---------|
| All customization remediation complete? Auto-rewrites are uploaded; manual items (Data Model Extensions, plugins, workflows, relationships) have been addressed or knowingly deferred. | Migration Readiness | Yes — proceed to migration, Defer remaining manual items and proceed (acknowledge risk), Pause skill — I'll finish manual fixes and re-run |

- **Proceed to migration**: continue to step 3.1.
- **Defer manual items**: capture the user's acknowledgment in the execution report (so post-migration audit shows what was deferred) and proceed to step 3.1. Skill records deferred items.
- **Pause skill**: halt cleanly. User can re-invoke the skill later — step 1.4 will detect that no migration has started and pick up from step 1.5 with the (now-clean) site source.

> **Why this gate exists:** Data Model Extension custom columns ideally land **before** migration so the data migrates cleanly into the new structure. Plugins and workflows can be fixed post-migration without data loss, but if deferred should be tracked. This gate makes the choice explicit rather than implicit.

**Output**: FetchXML auto-rewrites applied and uploaded; Liquid rewrites suggested and uploaded after user review; manual remediation tasks surfaced; user has explicitly confirmed migration readiness or acknowledged deferred items

---

## Phase 3: Migration Execution

**Goal**: Run the actual SDM→EDM migration with the selected mode, then flip the site's data model version from SDM to EDM.

**Output**: Migration tracker reports `Completed`, data model version flipped to Enhanced, Portal Id captured for rollback use in Phase 4.

---

### 3.1 Migrate Site Data Model

**Goal**: Execute the migration using PAC CLI with selected mode

**Actions**:

1. **Execute Migration Command**

   ```powershell
   pac pages migrate-datamodel --webSiteId "<WEBSITE_ID>" --mode <SELECTED_MODE>
   ```

   Where `<SELECTED_MODE>` is one of: `configurationData`, `configurationDataReferences`, `all`

2. **Monitor Execution**

   - Display progress to user
   - If template warning appears, inform user that V2 packages may be missing and migration may not complete

3. **Check Status**

   Poll every 1 minute, up to a maximum of 30 attempts (30 minutes total):

   ```powershell
   pac pages migrate-datamodel --webSiteId "<WEBSITE_ID>" --checkMigrationStatus
   ```

   Possible statuses:
   - **Complete/Success**: Proceed to step 3.2.
   - **In Progress**: Inform user "Migration is running (attempt `<N>`/30). This can take time for large data volumes (5K records per batch). Next check in 1 minute..." and wait before checking again.
   - **Failed**: Stop polling. Show error and ask:

     | Question | Header | Options |
     |----------|--------|---------|
     | Migration encountered an error. How to proceed? | Migration Error | Retry migration, Skip to rollback, Stop and troubleshoot |

   **If still In Progress after 30 minutes**: Stop polling. Run `--checkMigrationStatus --verbose` to get elapsed time (`createdOn`/`modifiedOn`) and current step, then ask:

   > Migration started **`<X>` ago**, last activity **`<Y>` ago**. Current step: **`<currentStep>`**. Migration processes records in batches of 5K — large sites can take hours.
   > Reference: <https://learn.microsoft.com/en-us/power-pages/admin/migrate-enhanced-data-model>

   | Question | Header | Options |
   |----------|--------|---------|
   | Migration still running after 30 minutes. How to proceed? | Long Migration | Poll for another 30 minutes, Reset and restart migration, Exit and check back later |

   - **Poll for another 30 minutes**: Restart the 30-attempt polling loop.
   - **Reset and restart migration**: Show the reset warning (same as step 1.4 action 4 — reset only flips tracker status to Failed, does NOT undo migrated records), confirm, run `pac pages migrate-datamodel --webSiteId "<WEBSITE_ID>" --resetMigration`, then re-run the migrate command in step 1 of this phase.
   - **Exit and check back later**: Halt the skill. User can re-invoke later — step 1.4 will detect the in-flight migration and offer the same wait/reset choices.

**Output**: Migration executed and completed successfully

---

### 3.2 Update Data Model Version

**Goal**: Activate EDM and deactivate SDM for the site

**Actions**:

1. **Retrieve Portal ID**

   Check the Portal Id state captured in step 1.3:

   - **If marked "captured"** (a valid GUID from `pac pages list -v`): Use it directly. Proceed to step 2 — no user prompt needed.
   - **If marked "needs prompt"** (`Unknown`, `N/A`, or column missing from older PAC build): Fall through to the manual lookup below.

   **Manual lookup** — construct the site URL from values collected earlier:

   - URL slug: from step 1.3 (Friendly Name suffix after " - ")
   - Cloud domain: from step 1.1 `pac auth who` cloud field

   | Cloud | Domain |
   |-------|--------|
   | Public | `powerappsportals.com` |
   | UsGov | `powerappsportals.us` |
   | UsGovHigh | `high.powerappsportals.us` |
   | UsGovDod | `appsplatform.us` |
   | China | `powerappsportals.cn` |

   Constructed URL: `https://<URL_SLUG>.<CLOUD_DOMAIN>`

   > **If the site uses a custom domain**, the constructed URL may not work. Ask user to provide the site's base URL directly.

   Guide user to open `<CONSTRUCTED_SITE_URL>/_services/about` — the page returns JSON containing a `portalId` field. Ask user to paste it:

   | Question | Header | Options |
   |----------|--------|---------|
   | `pac pages list -v` did not return a usable Portal Id for this site. Open `<SITE_URL>/_services/about` and paste the `portalId` value from the JSON response | Portal ID | I'll paste the Portal ID |

   Validate the pasted value is a GUID. Store it — it will also be needed for rollback in Phase 4.

   > **Do not run the update command in step 2 until Portal Id is available.** Both `--updateDataModelVersion` and `--revertToStandardDataModel` reject empty Portal Id ([PAPortalMigrateDataModelVerb.cs:214](C:/Users/ashwanikumar/source/repos/PowerPlatform-Scale-AdminTools/src/cli/bolt.module.paportal/verbs/PAPortalMigrateDataModelVerb.cs#L214)).

2. **Execute Update Command**

   ```powershell
   pac pages migrate-datamodel --webSiteId "<WEBSITE_ID>" --updateDatamodelVersion --portalId "<PORTAL_ID>"
   ```

3. **Confirm Switch**

   Inform user: "Data model updated. Site now uses Enhanced Data Model. SDM record has been deactivated."

**Output**: Portal ID captured, site switched to EDM

---

## Phase 4: Post-Migration Validation

**Goal**: Validate the migrated site, optionally rollback if issues are found, and produce the final execution report.

**Output**: Site confirmed working on EDM (or rolled back to SDM), success summary presented, execution report finalized.

> **Future enhancement (placeholder):** automated functional test cases (rendering checks, form submission, web API calls, auth flow smoke tests) will be added here in a follow-up session.

---

### 4.1 Validation, Optional Rollback, and Final Summary

**Goal**: Validate migrated site and summarize results

**Actions**:

1. **Present Validation Checklist**

   > **Post-Migration Validation:**
   > - [ ] Browse all site pages for rendering issues
   > - [ ] Test forms and data operations
   > - [ ] Test web API calls
   > - [ ] Test authentication flows
   > - [ ] Verify web roles and permissions
   > - [ ] Test customization-affected pages
   > - [ ] Run functional smoke tests

2. **Get Validation Status**

   | Question | Header | Options |
   |----------|--------|---------|
   | Did validation pass without issues? | Validation | Yes, all good, Issues found — rollback needed |

   - If "Issues found":

     Confirm the Portal ID collected in step 3.2 is still correct before proceeding:

     | Question | Header | Options |
     |----------|--------|---------|
     | Confirm Portal ID for rollback: `<PORTAL_ID>` (from step 3.2). Is this correct? | Confirm Portal ID | Yes, proceed with rollback, No, let me re-enter it |

     If "No": Ask user to re-open `<SITE_URL>/_services/about` and provide the correct Portal ID.

     ```powershell
     pac pages migrate-datamodel --webSiteId "<WEBSITE_ID>" --revertToStandardDataModel --portalId "<PORTAL_ID>"
     ```

     Inform user: "Site reverted to SDM. EDM record deactivated, SDM record reactivated."

   - If "Yes": Present success summary

3. **Success Summary**

   > **Migration Complete**
   > - Site: `<SITE_NAME>` (ID: `<WEBSITEID>`)
   > - Previous model: Standard (SDM)
   > - Current model: Enhanced (EDM)
   > - Customizations requiring fixes: `<COUNT>` (or "None")
   > - Environment: `<ENV_TYPE>`
   > - Reports available in: `./migration-reports/`

4. **Record Skill Usage**

   Follow instructions in `${CLAUDE_PLUGIN_ROOT}/references/skill-tracking-reference.md`

**Output**: Site validated, migration complete (or rolled back), reports generated

---

## Progress Tracking

| Phase | Task Subject | Active Form |
|-------|-------------|-------------|
| Phase 1 | Pre-flight Setup | Setting up for migration |
| Phase 2 | Customization Remediation | Remediating customizations |
| Phase 3 | Migration Execution | Executing migration |
| Phase 4 | Post-Migration Validation | Validating and completing migration |

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
