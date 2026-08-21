# Skill Design: Migrate Site from Standard Data Model (SDM) to Enhanced Data Model (EDM)

**Status:** Implemented (12-phase plan; preview feature, ALM integration deferred)
**Source Doc:** [Migrate standard data model sites to enhanced data model (preview)](https://learn.microsoft.com/en-us/power-pages/admin/migrate-enhanced-data-model)
**Plugin:** power-pages

---

## Overview

The **Enhanced Data Model (EDM)** is the next-generation storage model for Power Pages sites. Instead of spreading site configuration across many bespoke `adx_*` Dataverse tables (the legacy **Standard Data Model**, or **SDM**), EDM consolidates site metadata into a small set of unified tables — most notably `powerpagecomponent` — where component-specific properties are stored as JSON in a `content` column. The result is a simpler, future-proof schema that the Power Pages platform and tooling can evolve without per-component table churn, cleaner ALM with fewer tables to package, faster runtime resolution because the platform no longer joins across many `adx_*` tables, and a consistent surface for new Power Pages features that are being built EDM-first.

It's important to note that **not all `adx_*` tables move into `powerpagecomponent`**. Only the **metadata** `adx_*` tables — the ones that describe the structure and authoring surface of the site, such as `adx_webpage`, `adx_webtemplate`, `adx_contentsnippet`, `adx_sitesetting`, `adx_pagetemplate`, `adx_weblink`, `adx_entityform`, `adx_entitylist`, and similar configuration tables — are consolidated into `powerpagecomponent` (with their per-row properties moved into the `content` JSON column). The **transactional / runtime** `adx_*` tables — the ones that capture end-user activity at runtime, such as `adx_invitation`, `adx_inviteredemption`, `adx_portalcomment`, `adx_externalidentity`, and the entity-form / advanced-form submission and log tables — are **not** migrated into `powerpagecomponent`; they remain on their existing schemas and keep storing runtime data as before. What changes for those transactional tables is that their lookups to metadata records get rewired during the references migration so they point at the new `powerpagecomponent` rows instead of the legacy metadata `adx_*` rows.

Existing sites were authored on SDM and continue to run on `adx_*` tables, so to benefit from EDM (and to stay aligned with where the Power Pages platform is headed) each site must be **migrated**. Migration moves the site's configuration metadata into the EDM `powerpagecomponent` shape, rewires transactional references onto those new metadata records, and flips the site record to serve from EDM. Migration is also where **customizations** — custom `adx_*` columns, Liquid that reads `adx_*` attributes, FetchXML over `adx_*` tables, plugins, and workflows — are surfaced and **remediated**, because those customizations don't carry over automatically and must be rewritten or restructured to work against EDM.

The skill is structured as **4 high-level phases**. Phase 1 and Phase 4 run the same way for every site, while Phase 2 and Phase 3 are **track-branched** — their shape depends on the migration mode chosen in step 1.7, which derives the track from the environment type. The **Authoring Track** (mode `configurationData` or `all`) is used for Dev and Single-environment setups, where the metadata itself is migrated locally and customizations are scanned and fixed against SDM source before references move. The **Downstream Track** (mode `configurationDataReferences`) is used for Test, UAT, and Production environments where configuration metadata is assumed to have already arrived via ALM solution import from Dev; only transactional references migrate here, and any customization findings indicate an upstream ALM gap rather than work the user should do locally.

**Phase 1 — Site Discovery & Pre-checks** runs for both tracks and covers seven sub-steps: establish CLI context (1.1), identify the site context (1.2), discover the site and validate it's on SDM (1.3), check for any prior or in-flight migration (1.4), validate the required Dataverse dependencies (1.5), validate the template and its V2 EDM package (1.6), and determine the environment type plus migration mode (1.7) — this last sub-step is where the track is derived.

On the **Authoring Track** (17 sub-steps total), **Phase 2 — Configuration Migration & Customization Remediation** captures an SDM baseline snapshot (2.1), migrates the configuration metadata with `pac pages migrate-datamodel --mode <configurationData|all>` (2.2), locates the auto-emitted `SiteCustomization*.csv` report (2.3), and remediates customizations by staging FetchXML and Liquid auto-rewrites alongside augmented prompts for plugins and Data Model Extensions, then applying the staged diff and uploading back to Dataverse with `pac pages upload --modelVersion 1` (2.4). **Phase 3 — Migration Execution** then runs a four-sub-step path: an SDM↔EDM data diff validation as a pre-refs safety gate (3.1), the transactional references migration (3.2, auto-skipped when mode was `all`), EDM activation via `--updateDataModelVersion --portalId <…>` (3.3), and the user-confirmed site restart (3.4).

On the **Downstream Track** (18 sub-steps total), **Phase 2 — Setting Up Metadata** is shorter because configuration metadata is assumed to have arrived via ALM: verify the metadata is present in the target environment (2.1), capture snapshots for later diffs (2.2), and confirm metadata readiness via a user-facing gate before Phase 3 starts moving transactional data (2.3). **Phase 3 — Migration Execution** is longer here because customizations are scanned and remediated after the refs migration emits its own customization report: data diff validation (3.1), migrate refs with `--mode configurationDataReferences` (3.2), locate the customization report (3.3), remediate customizations with the same staged-rewrite and augmented-prompt flow as the Authoring Track but with a stronger warning since Prod/Test/UAT findings typically signal an ALM gap upstream (3.4), activate EDM (3.5), and confirm the site restart (3.6).

**Phase 4 — Post-Migration Validation** is also shared across tracks and consists of two sub-steps: a runtime smoke-test recommendation that points the user at the `/test-site` flow (4.1) and a final status summary that records skill usage and writes the final execution report (4.2).

> **Note:** EDM migration is a preview feature. Behavior may change before GA. Always test on a non-production environment first.

---

## Scope

### In Scope

- PAC CLI version and authentication validation
- Site discovery via `pac pages list -v` (Portal Id auto-captured from verbose output)
- **In-flight migration detection** (step 1.4) — handles already-running, completed, failed, and reverted prior migrations
- Dependency and template-package validation
- Environment-aware migration mode recommendation (Dev → `all`, Test/UAT/Prod → `configurationData`)
- Customization report generation (always, for any environment)
- Pre-migration customization remediation (manual guidance + automated fixes for Data Model Extensions)
- Migration execution with bounded polling (30-min ceiling + wait/reset/exit escape hatch)
- Data model version flip via Portal Id (captured from `pac pages list -v` when available; manual `/_services/about` fallback otherwise)
- Rollback to SDM
- HTML report generation (customization report + execution report)

### Out of Scope

- Creating new EDM sites from scratch (use a `create-site` skill instead)
- ALM/solution deployment of migration artifacts (deferred to a future skill version; env type is captured but not acted on)
- Dataverse schema design changes unrelated to migration
- Environment-copy operations (only available via Power Platform admin center, no PAC CLI API)

---

## Supported Templates

All Power Pages and D365 portal templates can be migrated, provided the corresponding V2 EDM solution is installed in the target environment. step 1.6 validates installation per template.

**Power Pages templates:**

- Starter layout 1–5
- Application processing
- Blank page
- Program registration
- Schedule and manage meetings
- FAQ
- Event registration

**D365 portal templates (migratable in recent PAC CLI builds):**

- Community Portal
- Customer Self-Service Portal
- Employee Self-Service Portal
- Partner Portal

Each template maps to a specific V2 solution `UniqueName` (see SKILL.md step 1.6 for the full mapping). Older PAC CLI builds may still reject D365 portal templates — confirm with `pac --version`.

---

## Phase Breakdown

The skill is organized into **4 high-level phases**. Each phase contains numbered sub-steps for granular execution and progress tracking.

| # | Phase | Description | Sub-steps |
| --- | --- | --- | --- |
| 1 | **Site Discovery & Pre-checks** | Gather all context needed to plan and execute migration safely. CLI context, site identification, prior migration state detection, dependency verification, template validation, migration mode selection. | 1.1 Establish CLI Context · 1.2 Identify Site Context · 1.3 Site Discovery & Validate Data Model · 1.4 Check Existing Migration Status · 1.5 Validate Required Dependencies · 1.6 Validate Template & V2 Package · 1.7 Determine Env Type & Migration Mode |
| 2 | **Customization Remediation** | Identify customizations, apply auto-rewrites where safe (FetchXML + Liquid), surface per-finding guidance for manual fixes, gate the transition to migration. | 2.1 Generate Customization Report · 2.2 Remediate Customizations (download → rewrite → review → upload → readiness gate) |
| 3 | **Migration Execution** | Run the SDM→EDM migration with the selected mode and flip the data model version. | 3.1 Migrate Site Data Model · 3.2 Update Data Model Version |
| 4 | **Post-Migration Validation** | Validate the migrated site, optionally rollback, produce final execution report. | 4.1 Validation, Optional Rollback, and Final Summary |

### Sub-step → PAC command mapping

| Sub-step | Key Commands |
| --- | --- |
| 1.1 | `pac --version`, `pac auth list/who` |
| 1.2 | `Test-Path .\website.yml` + AskUserQuestion |
| 1.3 | `pac pages list -v` |
| 1.4 | `pac pages migrate-datamodel --webSiteId <…> --checkMigrationStatus [--verbose]` |
| 1.5 | `pac solution list --includeSystemSolutions` |
| 1.6 | `pac solution list --includeSystemSolutions`, `pac application install --application-name <…>` |
| 1.7 | AskUserQuestion |
| 2.1 | `pac pages migrate-datamodel --webSiteId <…> --siteCustomizationReportPath <OUTPUT_DIR>`, `node generate-migration-reports.js` |
| 2.2 | `pac pages download --webSiteId <…> --path ./mysite`, `node generate-migration-reports.js --automate-fetchxml --automate-liquid`, `pac pages upload --path <SITE_ROOT> --modelVersion 1` |
| 3.1 | `pac pages migrate-datamodel --webSiteId <…> --mode <SELECTED>`, `--checkMigrationStatus` (polling) |
| 3.2 | `pac pages migrate-datamodel --webSiteId <…> --updateDatamodelVersion --portalId <…>` |
| 4.1 | `pac pages migrate-datamodel --revertToStandardDataModel --portalId` (only if rollback), `node update-state.js` (final live-report render) |

### Why Customization Remediation (Phase 2) sits before Migration (Phase 3)

The previous design placed remediation after migration. The current design fixes customizations **before** migration for three reasons:

1. **File-level rewrites are safer on SDM source.** Both Liquid and FetchXML rewrites operate on the downloaded source files (`.html` / `.yml`); editing SDM-source files and re-uploading via `pac pages upload` is well-understood, with `pac pages download` providing a clean rollback point.
2. **Data Model Extensions need a clean target before metadata moves.** Per the migration doc, the correct fix for a custom column on an `adx_*` table is to create a new custom table with a lookup to `powerpagecomponent`. If this happens before step 3.1, the data migration is straightforward; if deferred to post-migration the user has to navigate the new EDM `content` JSON structure.
3. **Plugins/workflows are deferrable.** These are also recommended pre-migration (so EDM has working plugins from day 1) but can be safely deferred — the step 2.2 final-readiness gate makes that choice explicit.

The Microsoft doc places all fixes post-migration. The skill deviates here intentionally for the reasons above; the deviation is documented in SKILL.md and DESIGN.md.

Moving remediation to step 2.2 means the migration runs against a cleaner customization surface.

### Why step 1.4 was added

The skill needs to be re-entrant. A user may:

- Trigger a migration outside of this skill, then run the skill later
- Exit the skill mid-migration and re-invoke after hours
- Hit the step 3.1 polling timeout and need to choose wait/reset/exit

A single early status check in step 1.4 detects any of these and routes the flow appropriately — including short-circuiting to step 3.2 if a prior migration completed but the data-model version wasn't flipped.

---

## Directory Layout

The skill operates against two resolved paths captured in step 1.2:

- **`<SITE_ROOT>`** — directory containing `website.yml` (the site source files)
- **`<OUTPUT_DIR>`** — directory for all migration artifacts (CSV, HTML reports, diffs, state files)

These are kept **separate** so site source stays clean: a user can `git diff` or commit `<SITE_ROOT>` without migration artifacts contaminating the change set.

### Two scenarios

**Scenario A — cwd is a working directory** (no `website.yml` in cwd; site lives in a subdirectory or will be downloaded):

```text
cwd/
├── mysite/                            ← site download lands here (step 2.2 if absent)
│   └── site-1---site-k5s85/           ← <SITE_ROOT> — actual site root, has website.yml
│       ├── website.yml
│       ├── web-templates/
│       │   └── migration-check-demo/
│       │       └── Migration-Demo-check.webtemplate.source.html   ← untouched until user approves
│       └── ...
└── migration-reports/                 ← <OUTPUT_DIR> — all migration artifacts
    ├── SiteCustomization.csv          ← PAC writes here
    ├── customization-report.html      ← script writes here
    ├── datamodel-migration-report.html
    ├── remediation-staged/            ← rewriter-proposed files (mirrors <SITE_ROOT> layout)
    │   └── web-templates/
    │       └── migration-check-demo/
    │           └── Migration-Demo-check.webtemplate.source.html
    └── remediation-diff.json          ← structured per-file diff manifest
```

**Scenario B — cwd IS the site** (`website.yml` directly in cwd):

```text
parent/
├── contoso-portal/                    ← cwd; <SITE_ROOT> = "."
│   ├── website.yml
│   ├── web-templates/
│   └── ...
└── migration-reports/                 ← <OUTPUT_DIR> = "..\migration-reports"
    └── (same contents as above)
```

The "go one step back" rule keeps the site dir clean for source control.

### Resolution algorithm (step 1.2)

```text
Test-Path .\website.yml
├── True  → <SITE_ROOT> = "."        ; <OUTPUT_DIR> = "..\migration-reports"
└── False → look for subdir with website.yml
    ├── Exactly one subdir → <SITE_ROOT> = .\<subdir>   ; <OUTPUT_DIR> = ".\migration-reports"
    └── Zero or multiple   → download to .\mysite\<auto-slug> in step 2.2;
                              <OUTPUT_DIR> = ".\migration-reports"
```

`<SITE_ROOT>` and `<OUTPUT_DIR>` resolved once in step 1.2 and used as durable values across all subsequent phases.

### Output artifacts

| File | Producer | Location |
| --- | --- | --- |
| `SiteCustomization.csv` (and auto-numbered `SiteCustomization<N>.csv`) | `pac pages migrate-datamodel --siteCustomizationReportPath` | `<OUTPUT_DIR>` (PAC sometimes writes to cwd instead — step 2.1 globs for it) |
| `customization-report.html` | `generate-migration-reports.js` | `<OUTPUT_DIR>` |
| `datamodel-migration-report.html` (live execution report) | `update-state.js` + `lib/render-live-report.js` | `<OUTPUT_DIR>` |
| `remediation-staged/<rel path>` (proposed file copies) | `generate-migration-reports.js --automate-fetchxml --automate-liquid` | `<OUTPUT_DIR>/remediation-staged/` (mirrors `<SITE_ROOT>` layout; live source untouched until apply step) |
| `remediation-diff.json` (structured per-file diff manifest) | same script | `<OUTPUT_DIR>` (consumed by live report's Remediation Diff card and by `apply-remediation.js`) |

### CSV Location-column path handling

PAC writes paths to its internal scan temp directory in the CSV's `Location` column (e.g., `\\?\C:\Users\...\Temp\<site-slug>\web-templates\X\Y.html`). These paths are unusable as-is because:

1. The `\\?\` Windows extended-path prefix breaks Node's URL parser (used by Claude Code when rendering markdown file links — the `?` becomes `%3F` in `pathToFileURL`).
2. The temp directory may be cleaned up after the scan; it's not where the user should operate.

The script's `normalizeLocationPath()` sanitizes at the parse boundary:

- Strips `\\?\` and `\\?\UNC\` prefixes
- Strips everything up to and including the `*\Temp\<site-slug>\` segment, returning only the relative path within the site (`web-templates\X\Y.html`)

Downstream consumers (HTML reports, markdown links, log messages) always get clean relative paths that map directly to the user's `<SITE_ROOT>`.

---

## Customization Remediation Categories

The customization report (step 2.1) categorizes findings into five types. step 2.2 applies a mix of auto-rewrites, per-finding categorization, and per-table manual checklists. The rule is: **fix what the official doc shows as a mechanical rewrite; categorize and recommend everything else**.

| Type | Sub-pattern | step 2.2 action |
| --- | --- | --- |
| **FetchXml contains adx references** | `<entity name='adx_*'>` | **Auto-rewritten** — rename to `powerpagecomponent`, inject `powerpagecomponenttype` filter |
| **FetchXml contains adx references** | `<link-entity name='adx_*'>` | **Auto-rewritten** — same logic, two-pass to avoid nested-filter collision |
| **FetchXml contains adx references** | `<filter type='or'>` containing adx_* | Flagged for manual review (semantic-change risk) |
| **FetchXml contains adx references** | Unknown adx_* entity (custom table) | Flagged manually (no `powerpagecomponenttype` mapping) |
| **Liquid contains adx references** | `entities['adx_*']` collection access | **Semi-auto** — Liquid-comment suggestion inserted above the original; user reviews diff |
| **Liquid contains adx references** | Embedded `{% fetchxml %}` blocks | Caught by the FetchXML rewriter (above) |
| **Liquid contains adx references** | Property access (`page.adx_X`, `website.adx_X`, etc.) | Categorized as **false positive** — runtime resolves via documented `[logical_name]` accessor |
| **Liquid contains adx references** | `{% editable obj 'adx_X' %}` editable tag | Categorized as **false positive** — parameter is a logical attribute name |
| **Liquid contains adx references** | `snippets[...]` / `weblinks[...]` lookup keys | Categorized as **false positive** — index is a user-defined name, not an attribute |
| **Data Model Extensions** | Custom columns on `adx_*` tables | **Per-table checklist** — grouped by source table; checklist suggests new custom table name, lookup-to-`powerpagecomponent` column, and data-migration steps. **No Dataverse API calls** — schema decisions stay with the user |
| **Plugins registered on adx entities** | `Microsoft.*` system plugins | Categorized as **no action needed** (Power Pages Core handles on EDM) |
| **Plugins registered on adx entities** | `Adxstudio.*` framework plugins | Recommendation: verify V2 EDM-compatible solution installed (step 1.6 check) |
| **Plugins registered on adx entities** | Custom plugins | Per-finding refactor recommendation with original entity + step name |
| **Custom workflow** | Any | Generic doc guidance (no per-finding info available without Dataverse queries) |
| **Relationships between custom and adx tables** | (not in sample reports) | Manual guidance in SKILL.md if encountered |

### Phase 2 workflow

```text
1. Has cwd got the site downloaded?    Yes → confirm work is committed
                                       No  → pac pages download --path ./mysite
2. Run --automate-fetchxml             → file-level regex rewrites staged to remediation-staged/
3. Run --automate-liquid               → annotated suggestions staged to remediation-staged/
                                          (merges on top of step 2 if the file overlaps)
4. Script emits remediation-diff.json  → structured per-file manifest powering the Remediation Diff
                                          card in the live execution report
5. Review in live report               → user expands per-file hunks inline OR clicks "Open staged
                                          file" to view in VSCode's diff editor
6. User decides:
   - Approve  → apply-remediation.js copies staged → live, deletes remediation-staged/
                pac pages upload pushes the (now applied) source back to Dataverse
   - Discard  → apply-remediation.js --discard nukes remediation-staged/, live source untouched
   - Edit     → user hand-edits files in remediation-staged/; the report refreshes;
                re-ask approval
7. Show manual reminders               → DME per-table checklists, plugin recs, etc.
8. Final readiness gate                → user confirms before step 3.1 (migration)
```

The auto-rewriter is non-destructive by construction: it never writes to `<SITE_ROOT>`. All proposed changes live under `<OUTPUT_DIR>/remediation-staged/` until the user explicitly approves. `apply-remediation.js` is the only script that touches `<SITE_ROOT>` after the user picks "Approve" — and even then only with `copyFileSync` from the staged copy, so a partial apply leaves the staged tree intact for re-runs.

### Per-finding categorization logic

The skill executes local-only analysis (no Dataverse API) for every customization finding:

- **`categorizeLiquidFinding(snippet)`** — pattern-matches the snippet against `entities[...]`, `{% fetchxml %}`, `{% editable %}`, property access, and lookup-key patterns; emits one of `needs-rewrite` / `auto-fetchxml` / `false-positive` / `unknown` with a tailored action message.
- **`categorizePlugin(snippet)`** — name-prefix match on `Microsoft.*` / `Adxstudio.*` / custom; emits per-finding action including original entity and step name.
- **`buildDataModelExtensionChecklists(items)`** — groups column findings by source `adx_*` table; produces one checklist per source table with suggested new-table name and step-by-step guidance from the migration doc.

The categorization drives the augmented remediation prompts written to `<OUTPUT_DIR>/plugin-remediation-prompt.txt` and `<OUTPUT_DIR>/dme-remediation-prompt.txt`, plus the per-finding guidance catalogued in `customization-report.html`.

---

## Augmented Prompts for Customer-Owned Code

Two customization categories — **custom plugins** and **Data Model Extensions** — involve modifying code or schema that the skill does NOT own:

- **Plugins** live in the customer's plugin source repo (often a separate code repository)
- **DME (custom columns on adx_* tables)** require Dataverse schema changes that should land via a reviewable solution package, not direct API calls

For both, the skill follows a **paste-ready augmented-prompt** pattern:

1. The script generates a complete, self-contained prompt tailored to the user's actual findings
2. The prompt is written to a `.txt` file in `<OUTPUT_DIR>/`
3. The user opens a fresh Claude Code session pointed at the relevant working directory (their plugin repo for plugins; any working dir for DME)
4. The user pastes the prompt as the first message
5. The receiving session performs the work — refactoring plugin code OR building a Dataverse solution package — and surfaces a diff or artifact for the user to review before applying

### Why this design

| Concern | Direct execution from this skill | Augmented prompt approach |
| --- | --- | --- |
| Customer-owned plugin source | Skill would need access to the plugin repo — not available | User runs the prompt where the repo is — clean separation |
| Dataverse schema changes | Direct API calls are hard to undo, hard to review, bypass ALM | Solution package is a reviewable artifact; user imports it themselves |
| Decision-making (publisher prefix, column types, on-delete behavior) | Lots of interactive prompts in our skill | Batched in the receiving session |
| Source control | Changes hit Dataverse / customer repo invisibly | All artifacts version-controllable as files |

### Template storage

Prompt templates live as static text files under `scripts/prompts/`:

- `plugin-remediation.template.txt` — placeholder: `{{PLUGIN_FINDINGS_BLOCK}}`
- `dme-remediation.template.txt` — placeholder: `{{DME_TABLE_GROUPS_BLOCK}}`

The script's `loadPromptTemplate()` reads the file and substitutes the placeholder with the actual findings (markdown-formatted tables / groupings) before writing to `<OUTPUT_DIR>/plugin-remediation-prompt.txt` and `<OUTPUT_DIR>/dme-remediation-prompt.txt`.

### Surfacing to the user

All three locations cover different user contexts:

1. **Terminal output** at the end of script run — visual separator banner with file paths and copy-paste instructions
2. **Standalone `.txt` files** in `<OUTPUT_DIR>/` — for users who want the prompts without keeping the HTML open
3. **HTML execution report** — embedded inside collapsible `<details>` blocks with copy-to-clipboard buttons (uses `navigator.clipboard.writeText` — self-contained, no external JS)

### What's covered today

| Category | Prompt? | Notes |
| --- | --- | --- |
| Custom plugins | ✅ Yes | Refactor pattern, build/test/deploy guidance, no production push |
| Data Model Extensions | ✅ Yes | Solution-package output; data-migration step documented but not packaged |
| Custom-to-adx relationships | ✅ (within DME prompt) | Receiving session can add relationships to the same solution |
| Custom workflows | ❌ No (yet) | Would require per-workflow Dataverse queries to be useful; generic doc guidance in HTML report for now |

---

## Component Type Reference Table

For FetchXML and Liquid rewrites, map `adx_*` entity → `powerpagecomponenttype` value:

| Component | Type Value |
| --- | --- |
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

---

## Key PAC CLI Commands

```powershell
# Auth & discovery
pac auth create -u <Dataverse URL>
pac auth who
pac pages list -v

# Dependency & template-package verification (first-party solutions — flag is required)
pac solution list --includeSystemSolutions

# Existing migration state
pac pages migrate-datamodel --webSiteId <GUID> --checkMigrationStatus --verbose
pac pages migrate-datamodel --webSiteId <GUID> --resetMigration

# Customization report
pac pages migrate-datamodel --webSiteId <GUID> --siteCustomizationReportPath <PATH>

# Migrate
pac pages migrate-datamodel --webSiteId <GUID> --mode configurationData
pac pages migrate-datamodel --webSiteId <GUID> --mode configurationDataReferences
pac pages migrate-datamodel --webSiteId <GUID> --mode all

# Poll status
pac pages migrate-datamodel --webSiteId <GUID> --checkMigrationStatus

# Flip data model version
pac pages migrate-datamodel --webSiteId <GUID> --updateDatamodelVersion --portalId <PORTAL_GUID>

# Rollback to SDM
pac pages migrate-datamodel --webSiteId <GUID> --revertToStandardDataModel --portalId <PORTAL_GUID>
```

---

## Migration Status Values

From PAC source (`bolt.module.paportal/sitecustomizations/configurations/Constants.cs`):

| Status | Value | Skill Behavior |
| --- | --- | --- |
| `NotStarted` | 746610000 | No prior migration; proceed normally |
| `Running` | 746610001 | Prompt user: Wait / Reset / Exit |
| `Completed` | 746610002 | Prior migration done; skip to step 3.2 if version not yet flipped |
| `Failed` | 746610003 | Show last step + errors; offer Retry / Stop |
| `Reverted` | 746610004 | Site was rolled back; proceed as fresh start |
| `Unknown` | 0 | Warn user; ask whether to proceed |

`--resetMigration` is non-destructive to migrated data — it only flips the tracker status from `Running` → `Failed` so a new migration can be triggered.

---

## Known Limitations

1. **5K record batch limit** — Migration processes records in batches of 5,000. Large sites can take hours.
2. **Preview feature** — Not GA; behavior may change.
3. **EDM template solutions required** — Every template needs its corresponding V2 solution installed in the environment (see SKILL.md step 1.6 mapping). Missing V2 solutions can be provisioned by creating a dummy EDM site with the same template (the dummy can be deleted after).
4. **PAC CLI version dependency for D365 portals** — Migration of D365 portal templates (Community, Customer Self-Service, Employee Self-Service, Partner) requires a recent PAC CLI build. Older builds may still reject these templates.
5. **Portal Id column** — Available in `pac pages list -v` output only on PAC CLI builds with the 2026-02-24 commit (PR 14824169) or later. Older builds fall back to manual `_services/about` lookup in step 3.2.
6. **30-minute polling ceiling** — The skill polls migration status for 30 minutes, then escalates to a wait/reset/exit prompt. PAC's own server-side migration continues regardless of skill polling.

---

## Production Migration Strategy (Advisory Only)

The Microsoft documentation recommends creating a full environment copy before production migration. If feasible:

1. (Recommended) Create a copy of production via Power Platform admin center.
2. Run the full skill on the copy to validate.
3. Add site configuration data to a managed solution.
4. Import the managed solution to production.
5. Re-run the skill on production with `--mode configurationDataReferences` for non-configuration data.
6. Flip the data model version on production.
7. Conduct production validation.

The skill surfaces this as advisory guidance only. Environment copy is an admin-center operation outside PAC CLI's API surface. Schedule production migrations during non-business hours.

---

## Future Work

- **ALM integration**: step 1.7 captures environment type but does not yet branch on it for ALM-aware mode selection or remediation deployment. Plan: integrate with a future ALM-deployment skill so Test/UAT/Prod can consume fixes from Dev via managed solutions.
- **Resumable polling**: Persist a `.migration-state.json` keyed by WebSiteId so multi-session migrations can resume without re-running pre-checks. Currently step 1.4 detects in-flight state from PAC's server-side tracker, which is sufficient for most cases.
- **Bulk-site migration**: Currently single-site. A wrapper skill could iterate `pac pages list -v` output and sequence migrations.
- **Data Model Extension table-creation automation**: step 2.2 currently produces per-table checklists with suggested table names. A future enhancement could pre-populate Dataverse via API given publisher prefix and column-type input — but schema decisions remain user-driven, so this is deliberately deferred.
- **Per-workflow guidance**: Custom workflow remediation is generic doc-text today. Adding Dataverse queries to fetch each workflow's primary entity and step bindings would let us emit per-finding guidance, similar to plugins.
- **Automated post-migration validation test cases (Phase 4)**: The current Phase 4 surfaces a manual validation checklist (browse pages, test forms, verify auth, etc.). A future enhancement could add automated functional tests — Playwright-driven smoke tests for page rendering, form submission, web API calls, and authentication flows — so the user gets pass/fail signal instead of a manual to-do list.
