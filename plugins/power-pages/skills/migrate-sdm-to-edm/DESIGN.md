# Skill Design: Migrate Site from Standard Data Model (SDM) to Enhanced Data Model (EDM)

**Status:** Implemented (12-phase plan; preview feature, ALM integration deferred)
**Source Doc:** [Migrate standard data model sites to enhanced data model (preview)](https://learn.microsoft.com/en-us/power-pages/admin/migrate-enhanced-data-model)
**Plugin:** power-pages

---

## Overview

This skill guides the user through migrating an existing Power Pages site from the Standard Data Model (SDM) to the Enhanced Data Model (EDM). The skill is structured as 12 phases that cover prerequisite checks, in-flight migration detection, customization analysis and remediation (performed **before** migration), migration execution, data-model version switch, and post-migration validation/rollback.

> **Note:** EDM migration is a preview feature. Behavior may change before GA. Always test on a non-production environment first.

---

## Scope

### In Scope

- PAC CLI version and authentication validation
- Site discovery via `pac pages list -v` (Portal Id auto-captured from verbose output)
- **In-flight migration detection** (Phase 4) — handles already-running, completed, failed, and reverted prior migrations
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

All Power Pages and D365 portal templates can be migrated, provided the corresponding V2 EDM solution is installed in the target environment. Phase 6 validates installation per template.

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

Each template maps to a specific V2 solution `UniqueName` (see SKILL.md Phase 6 for the full mapping). Older PAC CLI builds may still reject D365 portal templates — confirm with `pac --version`.

---

## Phase Breakdown

| # | Phase | Description | Primary PAC Command(s) | Automated? |
| --- | --- | --- | --- | --- |
| 1 | **Establish CLI Context** | Verify PAC CLI ≥ 1.31.6, auth profile, environment URL, cloud type | `pac --version`, `pac auth list/who` | Yes |
| 2 | **Identify Site Context** | Parse local `website.yml` or prompt user for site name/GUID | — | Guided |
| 3 | **Site Discovery & Validate Data Model** | List sites, locate target, capture WebSiteId / Portal Id / ModelVersion / URL slug; stop if already EDM; confirm template | `pac pages list -v` | Yes |
| 4 | **Check Existing Migration Status** | Detect in-flight, completed, failed, or reverted prior migrations. Branch accordingly (wait / reset / short-circuit) | `pac pages migrate-datamodel --checkMigrationStatus --verbose` | Yes |
| 5 | **Validate Required Dependencies** | Verify `MicrosoftCRMPortalBase ≥ 9.3.2307.x` and `PowerPagesCore ≥ 1.0.2309.63` | `pac solution list` | Yes |
| 6 | **Validate Template & V2 Package** | Look up V2 solution `UniqueName` for the captured template, verify installed via `pac solution list`; install `PowerPages_Core` if missing | `pac solution list`, `pac application install` | Yes |
| 7 | **Determine Env Type & Migration Mode** | Ask Dev/Test-UAT/Prod; recommend mode (Dev → `all`, others → `configurationData`) | — | Guided |
| 8 | **Generate Customization Report** | Download CSV from PAC, render HTML report via JS script | `pac pages migrate-datamodel --siteCustomizationReportPath`, `node generate-migration-reports.js` | Yes |
| 9 | **Customization Remediation** | FetchXML auto-rewrite (incl. link-entity) and Liquid `entities['adx_*']` semi-auto annotation in downloaded site files; per-finding Liquid/plugin categorization; per-table DME checklists; user reviews diffs, approves, then `pac pages upload`; final readiness gate before Phase 10 | `pac pages download`, `node generate-migration-reports.js --automate-fetchxml --automate-liquid`, `pac pages upload` | Mixed |
| 10 | **Migrate Site Data Model** | Run migrate command, poll every 1 min × 30. On timeout: wait/reset/exit | `pac pages migrate-datamodel --mode <…>`, `--checkMigrationStatus` | Yes |
| 11 | **Update Data Model Version** | Flip SDM → EDM using captured Portal Id (or manual fallback) | `pac pages migrate-datamodel --updateDatamodelVersion --portalId` | Yes |
| 12 | **Post-Migration Validation & Summary** | Validation checklist, optional rollback, success summary, execution report | `pac pages migrate-datamodel --revertToStandardDataModel --portalId` (if rollback) | Guided |

### Why Customization Remediation moved before Migration (Phase 9, was post-migration)

The previous design placed remediation after migration. The current design fixes customizations **before** migration for three reasons:

1. **File-level rewrites are safer on SDM source.** Both Liquid and FetchXML rewrites operate on the downloaded source files (`.html` / `.yml`); editing SDM-source files and re-uploading via `pac pages upload` is well-understood, with `pac pages download` providing a clean rollback point.
2. **Data Model Extensions need a clean target before metadata moves.** Per the migration doc, the correct fix for a custom column on an `adx_*` table is to create a new custom table with a lookup to `powerpagecomponent`. If this happens before Phase 10, the data migration is straightforward; if deferred to post-migration the user has to navigate the new EDM `content` JSON structure.
3. **Plugins/workflows are deferrable.** These are also recommended pre-migration (so EDM has working plugins from day 1) but can be safely deferred — the Phase 9 final-readiness gate makes that choice explicit.

The Microsoft doc places all fixes post-migration. The skill deviates here intentionally for the reasons above; the deviation is documented in SKILL.md and DESIGN.md.

Moving remediation to Phase 9 means the migration runs against a cleaner customization surface.

### Why Phase 4 was added

The skill needs to be re-entrant. A user may:

- Trigger a migration outside of this skill, then run the skill later
- Exit the skill mid-migration and re-invoke after hours
- Hit the Phase 10 polling timeout and need to choose wait/reset/exit

A single early status check in Phase 4 detects any of these and routes the flow appropriately — including short-circuiting to Phase 11 if a prior migration completed but the data-model version wasn't flipped.

---

## Customization Remediation Categories

The customization report (Phase 8) categorizes findings into five types. Phase 9 applies a mix of auto-rewrites, per-finding categorization, and per-table manual checklists. The rule is: **fix what the official doc shows as a mechanical rewrite; categorize and recommend everything else**.

| Type | Sub-pattern | Phase 9 action |
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
| **Plugins registered on adx entities** | `Adxstudio.*` framework plugins | Recommendation: verify V2 EDM-compatible solution installed (Phase 6 check) |
| **Plugins registered on adx entities** | Custom plugins | Per-finding refactor recommendation with original entity + step name |
| **Custom workflow** | Any | Generic doc guidance (no per-finding info available without Dataverse queries) |
| **Relationships between custom and adx tables** | (not in sample reports) | Manual guidance in SKILL.md if encountered |

### Phase 9 workflow

```text
1. Has cwd got the site downloaded?    Yes → confirm work is committed
                                       No  → pac pages download --path ./mysite
2. Run --automate-fetchxml             → file-level regex rewrites + backups + diff
3. Run --automate-liquid               → annotated suggestions + backups + diff
4. Review diffs                        → user approves / cancels / edits further
5. pac pages upload                    → push rewritten source back to Dataverse
6. Show manual reminders               → DME per-table checklists, plugin recs, etc.
7. Final readiness gate                → user confirms before Phase 10 (migration)
```

The auto-rewriter is non-destructive: every modified file gets a `<file>.pre-edm.bak` sibling so the user can revert. Diffs (unified format) are written to `<output-dir>/fetchxml-rewrites.diff` and `liquid-suggestions.diff`.

### Per-finding categorization logic

The skill executes local-only analysis (no Dataverse API) for every customization finding:

- **`categorizeLiquidFinding(snippet)`** — pattern-matches the snippet against `entities[...]`, `{% fetchxml %}`, `{% editable %}`, property access, and lookup-key patterns; emits one of `needs-rewrite` / `auto-fetchxml` / `false-positive` / `unknown` with a tailored action message.
- **`categorizePlugin(snippet)`** — name-prefix match on `Microsoft.*` / `Adxstudio.*` / custom; emits per-finding action including original entity and step name.
- **`buildDataModelExtensionChecklists(items)`** — groups column findings by source `adx_*` table; produces one checklist per source table with suggested new-table name and step-by-step guidance from the migration doc.

Output is rendered in `skill-execution-report.html` under the "Liquid Findings — Categorized", "Plugin Findings — Categorized", "Auto-applied Rewrites", and "Data Model Extensions — Per-table Remediation Checklists" sections.

See `assets/skill-execution-report.html` for the rendered remediation guidance shown to users.

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
| `Completed` | 746610002 | Prior migration done; skip to Phase 11 if version not yet flipped |
| `Failed` | 746610003 | Show last step + errors; offer Retry / Stop |
| `Reverted` | 746610004 | Site was rolled back; proceed as fresh start |
| `Unknown` | 0 | Warn user; ask whether to proceed |

`--resetMigration` is non-destructive to migrated data — it only flips the tracker status from `Running` → `Failed` so a new migration can be triggered.

---

## Known Limitations

1. **5K record batch limit** — Migration processes records in batches of 5,000. Large sites can take hours.
2. **Preview feature** — Not GA; behavior may change.
3. **EDM template solutions required** — Every template needs its corresponding V2 solution installed in the environment (see SKILL.md Phase 6 mapping). Missing V2 solutions can be provisioned by creating a dummy EDM site with the same template (the dummy can be deleted after).
4. **PAC CLI version dependency for D365 portals** — Migration of D365 portal templates (Community, Customer Self-Service, Employee Self-Service, Partner) requires a recent PAC CLI build. Older builds may still reject these templates.
5. **Portal Id column** — Available in `pac pages list -v` output only on PAC CLI builds with the 2026-02-24 commit (PR 14824169) or later. Older builds fall back to manual `_services/about` lookup in Phase 11.
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

- **ALM integration**: Phase 7 captures environment type but does not yet branch on it for ALM-aware mode selection or remediation deployment. Plan: integrate with a future ALM-deployment skill so Test/UAT/Prod can consume fixes from Dev via managed solutions.
- **Resumable polling**: Persist a `.migration-state.json` keyed by WebSiteId so multi-session migrations can resume without re-running pre-checks. Currently Phase 4 detects in-flight state from PAC's server-side tracker, which is sufficient for most cases.
- **Bulk-site migration**: Currently single-site. A wrapper skill could iterate `pac pages list -v` output and sequence migrations.
- **Data Model Extension table-creation automation**: Phase 9 currently produces per-table checklists with suggested table names. A future enhancement could pre-populate Dataverse via API given publisher prefix and column-type input — but schema decisions remain user-driven, so this is deliberately deferred.
- **Per-workflow guidance**: Custom workflow remediation is generic doc-text today. Adding Dataverse queries to fetch each workflow's primary entity and step bindings would let us emit per-finding guidance, similar to plugins.
