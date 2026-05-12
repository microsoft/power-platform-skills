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

# Migrate Power Pages Site from Standard to Enhanced Data Model

Guide the user through a comprehensive migration of an existing Power Pages site from the Standard Data Model (SDM) to the Enhanced Data Model (EDM). This skill implements a multi-phase approach with environment-aware decision making, automatic dependency validation, customization analysis, and customization remediation performed before migration execution.

> **Important:** This is a preview feature. EDM migration behavior may change before GA.

## Core Principles

- **Environment-aware**: Capture environment type (Dev/Test/UAT/Prod) for context and future ALM integration
- **Remediate before migrate**: Identify and fix customizations before executing the data model migration
- **Validate comprehensively**: Check CLI context, site discovery, dependencies, and templates before any execution
- **Confirm before executing**: Present all migration parameters and customization findings to user before proceeding
- **Track all operations**: Generate comprehensive reports documenting all commands, results, and fixes applied
- **Graceful failure**: Halt on blocking issues; guide user to support when needed

**Supported templates:** Starter layout 1–5, Application processing, Blank page, Program registration, Schedule and manage meetings, FAQ.

**Not migratable:** Community (D365), Customer Self Service Portal (D365), Employee Self Service Portal (D365), Partner Portal (D365) — these support new EDM creation but can't be migrated from SDM.

**Initial request:** $ARGUMENTS

---

## Phase 1: Establish CLI Context

**Goal**: Set up PAC CLI with correct version and establish authenticated connection to Dataverse

**Actions**:

1. **Create todo list** with all 12 phases (see [Progress Tracking](#progress-tracking) table)

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

## Phase 2: Identify Site Context

**Goal**: Determine target site from local website.yml or user input

**Actions**:

1. **Check for Local website.yml**

   Look for `website.yml` in current directory:

   ```powershell
   Test-Path .\website.yml
   ```

   If found, parse it and extract:
   - `adx_name` (site name)
   - `adx_websiteid` (site GUID)

   Ask user confirmation:

   | Question | Header | Options |
   |----------|--------|---------|
   | Found local website.yml for site: `<SITE_NAME>` (ID: `<WEBSITEID>`). Use this site? | Use Local Context | Yes, use this site, No, specify different site |

   - If "Yes": Use extracted values
   - If "No": Proceed to step 2

2. **Get Site Identification from User**

   If website.yml not found or user declined, ask:

   | Question | Header | Options |
   |----------|--------|---------|
   | Provide the site name or WebSiteId (GUID) for migration | Site ID | I'll paste the site name, I'll paste the WebSiteId |

   Store the provided value.

**Output**: Target site name and/or WebSiteId captured

---

## Phase 3: Site Discovery and Validate Data Model

**Goal**: Find the site in the environment and verify it's on SDM (not already EDM)

**Actions**:

1. **List All Sites**

   ```powershell
   pac pages list -v
   ```

   Verbose output columns: `Index | Website Id | Portal Id | Friendly Name | Portal Url | Data Model Version | Single Page Application | Is Site Active`.

   Parse output to extract all available sites with:
   - WebSiteId
   - Portal Id (may render as `Unknown` if the Power Platform active-websites API failed, or `N/A` if the site is inactive — treat both as "missing" for Phase 11)
   - Site Name (display name from Friendly Name, the part before " - ")
   - URL slug (from Friendly Name, the part after " - ")
   - Current ModelVersion (`Standard` or `Enhanced`)

   > **Note:** Template name is not included in `pac pages list` output. Template will be confirmed separately in step 4.
   >
   > **PAC CLI version note:** The Portal Id column was added on 2026-02-24. If your installed PAC build predates that and the column is missing entirely, treat Portal Id as missing — Phase 11 will prompt the user before the data-model update.

2. **Locate Target Site**

   Search the list for site matching user input (name or GUID):
   - If found: Extract WebSiteId, Portal Id, ModelVersion, and URL slug. Store all four for later phases. If Portal Id parsed as a valid GUID, mark it as "captured"; if `Unknown`/`N/A`/missing, mark as "needs prompt".
   - If not found: Show list and ask user to confirm site name/ID. If still not found, stop and ask user to verify in Power Platform admin center.

3. **Validate Data Model**

   Check `ModelVersion` from output:
   - **If EDM**: Stop with message: "This site is already on Enhanced Data Model. Migration not needed."
   - **If SDM**: Continue to Phase 4

4. **Identify Site Template**

   Template name is not available from `pac pages list`. Ask user to confirm their site's template:

   | Question | Header | Options |
   |----------|--------|---------|
   | What template is this site based on? | Site Template | Starter layout 1, Starter layout 2, Starter layout 3, Starter layout 4, Starter layout 5, Application processing, Blank page, Program registration, Schedule and manage meetings, FAQ, Other/Unknown |

   - If a supported template: Store template name and continue.
   - If "Other/Unknown": Check if it matches a non-migratable D365 portal (Community, Customer Self Service, Employee Self Service, Partner Portal). If so, stop with message: "This template cannot be migrated from SDM to EDM." Otherwise proceed with caution.

**Output**: Target site confirmed as SDM, template confirmed by user, WebSiteId/ModelVersion/URL slug/Portal Id captured (Portal Id marked "captured" or "needs prompt")

---

## Phase 4: Check Existing Migration Status

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

   - **NotStarted / no tracker record**: No prior migration. Proceed to Phase 5.

   - **Reverted**: Site was previously rolled back to SDM. Treat as fresh start. Proceed to Phase 5.

   - **Completed**: A prior migration finished but the data model version was not yet flipped to EDM (otherwise Phase 3 would have stopped earlier). Skip Phases 5–10 and jump directly to **Phase 11 (Update Data Model Version)**.

   - **Failed**: A prior migration failed. Show the last step and error details (from chunk records in the verbose output), then ask:

     | Question | Header | Options |
     |----------|--------|---------|
     | Previous migration failed at step `<currentStep>`. Retry from the migration phase, or stop and investigate? | Failed Migration | Retry migration, Stop and investigate |

     - **Retry**: Proceed to Phase 5 (full pre-checks still run).
     - **Stop**: Halt. Direct user to verbose status output and Microsoft Learn for diagnostics.

   - **Running**: Migration is in progress. Compute and present elapsed time:

     > Migration started **`<createdOn → now>`**, last activity **`<modifiedOn → now>`** ago. Current step: **`<currentStep>`**. Migration processes records in batches of 5K — large sites can take hours.
     > Reference: <https://learn.microsoft.com/en-us/power-pages/admin/migrate-enhanced-data-model>

     Ask:

     | Question | Header | Options |
     |----------|--------|---------|
     | A migration is already running for this site. How to proceed? | In-Flight Migration | Wait and poll until complete, Reset and start over, Exit and check back later |

     - **Wait**: Skip Phases 5–10's pre-migration work and jump directly to **Phase 10 step 3 (status polling loop)**. After completion, continue to Phase 11.
     - **Reset and start over**: Show the reset warning (see step 4), confirm, run reset, then proceed to Phase 5.
     - **Exit**: Halt the skill cleanly. User can re-invoke later — Phase 4 will re-detect the in-flight migration.

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

   Then proceed to Phase 5.

**Output**: Migration history known; skill either short-circuits to the appropriate phase or proceeds normally with a clean tracker state

---

## Phase 5: Validate Required Dependencies

**Goal**: Verify required packages are installed in environment

**Actions**:

1. **Check Installed Solutions**

   Run the following to list all solutions in the environment:

   ```powershell
   pac solution list
   ```

   Search the output for:
   - `MicrosoftCRMPortalBase` — Dataverse base portal package (required: 9.3.2307.x+)
   - `PowerPagesCore` — Power Pages Core package (required: 1.0.2309.63+)

   Present the found versions to the user.

2. **Evaluate Results**

   - **Both found and versions meet requirements**: Inform user and proceed to Phase 6.
   - **One or both not found**: Stop with message: "Required packages are not installed. Please install them from Power Platform admin center > Manage > Dynamics 365 apps before proceeding."
   - **Found but version too low**: Show current vs required version and stop with upgrade guidance.
   - **`pac solution list` fails or output is unclear**: Fall back to asking the user:

   | Question | Header | Options |
   |----------|--------|---------|
   | Unable to verify packages automatically. Can you confirm both Dataverse base portal package (9.3.2307.x+) and Power Pages Core (1.0.2309.63+) are installed? | Deps Confirmed | Yes, confirmed, Not sure — help me check |

   - If "Not sure": Guide user to Power Platform admin center > Solutions to verify package versions.
   - If "Yes": Proceed to Phase 6.

**Output**: Required package versions verified (Dataverse base portal 9.3.2307.x+, Power Pages Core 1.0.2309.63+)

---

## Phase 6: Validate Site Template and V2 Package

**Goal**: Ensure EDM-compatible template solution exists for the target site

**Actions**:

1. **Identify Template Requirements**

   Based on template extracted in Phase 3:
   - Some templates (Program Registration, Schedule and Manage Meetings) require specific EDM-compatible solutions
   - Inform user which V2 packages are needed

2. **Prompt About V2 Solution Availability**

   | Question | Header | Options |
   |----------|--------|---------|
   | Does your environment have EDM-compatible solution for template `<TEMPLATE_NAME>`? | V2 Package | Yes, installed, Not sure — try and see, Need to install it |

   - If "Need to install": Guide user to create a dummy site using same template in EDM-enabled environment (this installs the V2 packages)
   - If "Not sure": Continue and migration will warn if missing
   - If "Yes": Proceed to Phase 7

3. **Verify PowerPages_Core Installation**

   Check if `PowerPages_Core` application is installed. If missing, ask:

   | Question | Header | Options |
   |----------|--------|---------|
   | PowerPages_Core application is not installed. Should I install it now? | Install Core | Yes, install, No, skip |

   If "Yes":
   ```powershell
   pac application install --application-name "PowerPages_Core"
   ```

   Wait for completion or failure.

**Output**: V2 packages verified/installed, PowerPages_Core available

---

## Phase 7: Determine Environment Type and Migration Mode

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

## Phase 8: Generate Customization Report

**Goal**: Download and analyze current customizations on the SDM site

**Actions**:

1. **Run Customization Report Generation**

   ```powershell
   pac pages migrate-datamodel --webSiteId "<WEBSITE_ID>" --siteCustomizationReportPath "./migration-report"
   ```

   This creates `./migration-report/SiteCustomization.csv`

2. **Parse Report**

   Read CSV and categorize findings:
   - Liquid contains adx references
   - Data Model Extension (custom columns on adx tables)
   - Plugins registered on adx entities
   - Custom workflows
   - Relationships between custom and adx tables
   - FetchXML with adx references

3. **Generate HTML Report**

   ```bash
   node scripts/generate-migration-reports.js \
     --customization-report "./migration-report/SiteCustomization.csv" \
     --site-name "<SITE_NAME>" \
     --website-id "<WEBSITE_ID>" \
     --output-dir "./migration-reports"
   ```

   This creates user-friendly HTML reports for review.

4. **Present Findings**

   Show summary of customizations found (by category) or "No customizations found" if clean.

**Output**: Customization report generated and analyzed

---

## Phase 9: Customization Remediation

**Goal**: Guide user through fixing customizations identified in Phase 8 before executing the migration

**Actions**:

If customizations were found in Phase 8, present remediation guidance:

**For Liquid references to adx tables:**
- Replace `entities['adx_webpage']` with `page` or `page.adx_*` where available
- Use `powerpagecomponent` table with type filters for complex queries
- Reference component type mapping table

**For Data Model Extensions (custom columns on adx tables):**
- Create new tables in Data workspace (e.g., `contoso_webpage`)
- Add custom columns to new tables
- Migrate data from old columns
- Update Liquid/FetchXML to reference new tables

**For FetchXML with adx references:**
- Replace entity names with `powerpagecomponent`
- Add filter on `powerpagecomponenttype` attribute
- Reference component type mapping table

**For Plugins/Workflows on adx tables:**
- Refactor to target `powerpagecomponent` (logical name)
- Update attribute references
- Re-register on new table

**Execute Automated Fixes** (if safe):

```bash
node scripts/generate-migration-reports.js \
  --site-name "<SITE_NAME>" \
  --website-id "<WEBSITE_ID>" \
  --siteCustomizationReportPath "./migration-report/SiteCustomization.csv" \
  --env-url "https://org.crm.dynamics.com" \
  --automate \
  --environment-type "<ENV_TYPE>" \
  --output-dir "./migration-reports"
```

Script will:
- Identify safe fixes (string attribute creation)
- Apply via Dataverse API
- Log all operations in execution report

**Output**: Remediation guidance provided and automated fixes applied where safe

---

## Phase 10: Migrate Site Data Model

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
   - **Complete/Success**: Proceed to Phase 11.
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
   - **Reset and restart migration**: Show the reset warning (same as Phase 4 step 4 — reset only flips tracker status to Failed, does NOT undo migrated records), confirm, run `pac pages migrate-datamodel --webSiteId "<WEBSITE_ID>" --resetMigration`, then re-run the migrate command in step 1 of this phase.
   - **Exit and check back later**: Halt the skill. User can re-invoke later — Phase 4 will detect the in-flight migration and offer the same wait/reset choices.

**Output**: Migration executed and completed successfully

---

## Phase 11: Update Data Model Version

**Goal**: Activate EDM and deactivate SDM for the site

**Actions**:

1. **Retrieve Portal ID**

   Check the Portal Id state captured in Phase 3:

   - **If marked "captured"** (a valid GUID from `pac pages list -v`): Use it directly. Proceed to step 2 — no user prompt needed.
   - **If marked "needs prompt"** (`Unknown`, `N/A`, or column missing from older PAC build): Fall through to the manual lookup below.

   **Manual lookup** — construct the site URL from values collected earlier:

   - URL slug: from Phase 3 (Friendly Name suffix after " - ")
   - Cloud domain: from Phase 1 `pac auth who` cloud field

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

   Validate the pasted value is a GUID. Store it — it will also be needed for rollback in Phase 12.

   > **Do not run the update command in step 2 until Portal Id is available.** Both `--updateDataModelVersion` and `--revertToStandardDataModel` reject empty Portal Id ([PAPortalMigrateDataModelVerb.cs:214](C:/Users/ashwanikumar/source/repos/PowerPlatform-Scale-AdminTools/src/cli/bolt.module.paportal/verbs/PAPortalMigrateDataModelVerb.cs#L214)).

2. **Execute Update Command**

   ```powershell
   pac pages migrate-datamodel --webSiteId "<WEBSITE_ID>" --updateDatamodelVersion --portalId "<PORTAL_ID>"
   ```

3. **Confirm Switch**

   Inform user: "Data model updated. Site now uses Enhanced Data Model. SDM record has been deactivated."

**Output**: Portal ID captured, site switched to EDM

---

## Phase 12: Post-Migration Validation and Summary

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

     Confirm the Portal ID collected in Phase 11 is still correct before proceeding:

     | Question | Header | Options |
     |----------|--------|---------|
     | Confirm Portal ID for rollback: `<PORTAL_ID>` (from Phase 11). Is this correct? | Confirm Portal ID | Yes, proceed with rollback, No, let me re-enter it |

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
| Phase 1 | Establish CLI context | Establishing CLI context |
| Phase 2 | Identify site context | Identifying site context |
| Phase 3 | Site discovery and validation | Discovering and validating site |
| Phase 4 | Check existing migration status | Checking existing migration status |
| Phase 5 | Validate dependencies | Validating dependencies |
| Phase 6 | Validate template and V2 package | Validating template and V2 package |
| Phase 7 | Determine environment and migration mode | Determining environment and migration mode |
| Phase 8 | Generate customization report | Generating customization report |
| Phase 9 | Remediate customizations | Remediating customizations |
| Phase 10 | Execute migration | Executing migration |
| Phase 11 | Update data model version | Updating data model version |
| Phase 12 | Validate and complete | Validating and completing migration |

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
