---
name: migrate-webapi-selectall
description: >-
  Reviews and migrates deprecated wildcard (*) values in Power Pages
  Webapi/<table-1>/fields settings to least-privilege explicit Dataverse columns.
  Use whenever a user mentions Web API wildcard or select-all remediation,
  fields settings containing *, data-exposure review, wildcard deprecation
  readiness, or Web API failures after wildcard retirement. Applies to both
  traditional sites using HTML, CSS, JavaScript, Liquid, and downloaded YAML,
  and code/SPA sites using React, Vue, Angular, Astro, or TypeScript. The agent
  must inspect every source Web API call and consumer, report exact fixes for every
  wildcard, report every already-explicit configuration, apply approved edits,
  and verify no wildcard remains.
user-invocable: true
argument-hint: Optional Power Pages project path
allowed-tools: Read, Write, Edit, Bash, Grep, Glob, AskUserQuestion, Task, TaskCreate, TaskUpdate, TaskList
model: opus
---

> **Plugin check**: Run `node "${PLUGIN_ROOT}/scripts/check-version.js"` — if it outputs a message, show it to the user before proceeding.

# Migrate Power Pages Web API Wildcards

Replace every deprecated `Webapi/<table-1>/fields = *` value with the smallest
explicit column set proven by the site's actual Web API behavior.

The LLM owns source discovery, call-chain reasoning, field decisions, report
writing, and edits. Use the bundled script only to retrieve authoritative
Dataverse table schema; it must not decide which columns the code needs.

Support both:

- traditional sites with HTML, JavaScript, Liquid, web templates, and
  aggregate YAML;
- code/SPA sites with React, Vue, Angular, Astro, TypeScript, downloaded
  deployment YAML, or mixed custom JavaScript.

**Initial request:** $ARGUMENTS

## Non-negotiable rules

1. Review every discovered source table Web API call, including shared
   wrappers, dynamic builders, and response consumers.
2. Review every configuration scope and deployment-profile copy.
3. Map request `EntitySetName` values to setting logical names using table
   schema. Never singularize, pluralize, or guess.
4. Treat `*` as unsupported for reads, writes, aggregates, FetchXML, files,
   and images.
5. Give every wildcard an exact proposed replacement before editing anything.
6. Report every already-explicit fields setting, including missing and
   potentially unnecessary columns.
7. Never apply a partial wildcard plan. Resolve all wildcards and call-site
   rows first.
8. Keep reports free of absolute local paths, tokens, URLs, data values,
   filter literals, request bodies, response bodies, and source snippets.
9. Build every report from the bundled HTML template; never invent another
   layout.
10. Preserve unrelated YAML structure and values.
11. Verify with a fresh discovery pass, not remembered inventory.

Read [references/column-analysis.md](references/column-analysis.md) before
analyzing calls. Read
[references/configuration-and-reporting.md](references/configuration-and-reporting.md)
before inventorying settings or writing the report. Read
[references/large-scale-batching.md](references/large-scale-batching.md) before
processing any inventory that may exceed 500 configurations or call
candidates.

## Phase 1: Prepare

**Goal:** Resolve the project and protect existing work.

1. Create all seven tasks from [Progress tracking](#progress-tracking).
2. Resolve `PROJECT_ROOT` from `$ARGUMENTS` or the current directory.
3. Detect site markers independently:
   - `powerpages.config.json` indicates a code/SPA site;
   - root `website.yml`, root `sitesetting.yml`, or `.powerpages-site/`
     indicates downloaded declarative artifacts;
   - when both appear, scan both layouts.
4. Read `.solution-manifest.json` when present. This migration changes existing
   settings; do not create or select another solution.
5. Inspect git status. Never discard, hide, or include unrelated user changes.
6. Run `node --version`.
7. Read
   `${PLUGIN_ROOT}/skills/migrate-webapi-selectall/assets/report-assets.json`
   and every template it lists. Stop if the manifest or any required template
   is missing, unreadable, duplicated, or has a different schema version.

**Output:** Project root, site layouts, solution context, and git state.

## Phase 2: Build the complete inventory

**Goal:** Find every configuration and candidate source Web API call before
reasoning about columns.

### 2.1 Inventory configuration scopes

Use `Glob`, `Grep`, and `Read` to inspect:

- every `sitesetting.yml`;
- every `*.sitesetting.yml`;
- `.powerpages-site/site-settings/`;
- deployment-profile and environment-specific copies.

Record every `Webapi/<table-1>/fields` and `Webapi/<table-1>/enabled` entry with its
relative file, line, scope, key style, and current value. Classify fields
settings as:

- `wildcard`;
- `explicit`;
- `missing` for an enabled table;
- `duplicate` only within the same configuration scope.

Do not treat identical settings in different deployment profiles as
duplicates. Record every profile name and which settings it overrides. Never
assume the `default` profile is the intended deployment profile.

Estimate inventory size before loading records into context. When it can
exceed 500 rows, copy every `large-scale` CSV template from the asset manifest
before appending rows, then follow `references/large-scale-batching.md`. The
same workflow must remain reliable for 10,000, 50,000, and 100,000+
configurations. Never create one task or metadata request per configuration.

### 2.2 Inventory source calls

Analyze only authoritative, editable source files. Never inspect compiled or
generated code.

For code/SPA sites:

1. Read `powerpages.config.json`, `package.json`, and present framework or
   bundler configuration before searching calls.
2. Treat `compiledPath` and every configured build-output directory as a hard
   exclusion.
3. Exclude `.powerpages-site/web-files/`, `node_modules/`, coverage and cache
   directories, source maps, minified bundles, framework output directories,
   and content-hashed assets matching
   `<entry-name>-<content-hash>.<extension>`.
4. Use `.powerpages-site/site-settings/` only for configuration inventory,
   never for source analysis.
5. Search editable roots such as configured source directories and framework
   application directories.

For traditional sites, search editable JavaScript, Liquid, web templates, web
files, and other authored source. Do not exclude an authored traditional web
file merely because it is deployed as a web file.

Search source extensions including `.js`, `.jsx`, `.ts`, `.tsx`, `.vue`,
`.html`, `.htm`, `.liquid`, `.aspx`, `.ascx`, `.cshtml`, and XML web
templates. If a call exists only in compiled, minified, generated, or
content-hashed output, record a `missing-source` blocker and stop the
migration. Do not infer columns from that output.

Search for:

- `/_api/`, encoded variants, split URL fragments, and API base constants;
- `fetch`, Axios, `XMLHttpRequest`, jQuery AJAX, `webapi.safeAjax`,
  `shell.ajaxSafePost`, and custom request wrappers;
- entity-set constants, query builders, FetchXML builders, and body builders;
- callers and consumers imported from other files.

For each source candidate, record relative path, line, method, endpoint
expression, and wrapper chain. A comment, example, or non-table endpoint still
needs an explicit disposition. Excluded build outputs never receive API
coverage rows.

For large inventories, append every completed row to
`api-call-coverage.csv` and reconcile input/output counts before releasing
that batch from context. Keep unresolved rows in the current batch.

Copy the manifest's HTML template unchanged to
`docs/webapi-selectall-migration/migration-report.html`. Populate its tokens
and fixed table bodies with all inventory rows. Preserve the template version,
element IDs, headings, table columns, and CSS. Do not propose fields yet.

Stop if any in-scope source or configuration file cannot be read.

<!-- gate: migrate-webapi-selectall:2.confirm-scope | category=plan | cancel-leaves=draft-migration-report -->

> 🚦 **Gate (plan · migrate-webapi-selectall:2.confirm-scope):** Confirm the project, configuration scopes and profiles, wildcard count, explicit-setting count, and source inventory before schema retrieval. Canceling leaves only the read-only draft report.

Use `AskUserQuestion` to confirm or cancel. Expand the inventory and repeat this
phase if the user identifies another source or deployment scope.

## Phase 3: Retrieve schema and resolve columns

**Goal:** Use authoritative names while letting the LLM determine actual usage.

### 3.1 Retrieve only relevant table schema

Build the initial unique list containing:

- logical table names from all Web API settings;
- entity-set names from all candidate table calls;
- entity-set names directly present in bind targets or related-table calls.

Do not treat a navigation-property name as a table identifier. Its target
logical name is authoritative only after relationship metadata resolves it.

Resolve the environment URL from confirmed project context or `pac env who`.
If unavailable, ask for the URL as data gathering; never ask for or accept an
access token.

<!-- not-a-gate: environment URL supplies read-only metadata query input only -->

Copy the manifest's line-list template to
`docs/webapi-selectall-migration/table-identifiers.txt`, replace
`<table-1>`, and append remaining deduplicated identifiers one per line. Run:

```bash
node "${PLUGIN_ROOT}/skills/migrate-webapi-selectall/scripts/query-table-schema.js" --project-root "<PROJECT_ROOT>" --environment-url "<ENVIRONMENT_URL>" --tables-file "<PROJECT_ROOT>/docs/webapi-selectall-migration/table-identifiers.txt" --output "<PROJECT_ROOT>/docs/webapi-selectall-migration/table-schema.json"
```

The utility retrieves names and relationships only. It does not scan source,
infer required columns, build a plan, edit configuration, or verify migration.
If an identifier does not resolve, trace the code or obtain the correct
contract; do not guess.

After the initial snapshot:

1. Match every used `$expand` navigation property against its source table's
   returned relationship metadata.
2. Collect only target logical names absent from all existing snapshots.
3. Write those names to
   `table-identifiers-pass-<N>.txt` and query them to
   `table-schema.pass-<N>.json`.
4. Repeat for nested expansion paths until every used navigation segment is
   resolved.

Treat `table-schema.json` and all numbered snapshots as one schema package.
Never requery a logical table already present in that package. The utility
deduplicates identifiers, processes tables sequentially, retries transient
throttling, refreshes tokens in bounded batches, and checkpoints progress.
Never launch concurrent schema queries.

### 3.2 Analyze every call and consumer

For every source inventory row:

1. Read the complete enclosing function or template block.
2. Trace imported wrappers, URL variables, query builders, body builders,
   response mappers, types, components, templates, and every caller.
3. Follow conditional branches, spreads, dynamic arrays, and runtime
   configuration.
4. Map the entity set to its logical table using the schema package.
5. Apply every rule in `references/column-analysis.md`.
6. Record requirements per owning logical table, not merely per request.
7. Classify the row as `mapped`, `non-table`, or `not-a-call`.
8. Leave the row unresolved if any runtime branch or consumer remains unknown.

Process large inventories sequentially using the bounded API batches in the
large-scale reference. Persist each complete batch before starting the next,
and update the compact table/column evidence matrix so global unions never
require reloading every call row.

For normal record GETs without `$select`, derive output fields from every
consumer and propose a source edit adding the smallest explicit projection.
Filters, ordering, and other query fields still belong in the fields setting,
even when they should not be added to the output projection.

Keep the response projection and fields-setting allowlist as separate sets.
Never add a filter-only, order-only, grouping-only, or write-only column to an
existing `$select` unless a response consumer also reads it.

### 3.3 Build configuration proposals

For each wildcard setting:

1. Union the proven requirements for that logical table within the applicable
   site behavior.
2. Validate each proposed name against the schema package.
3. Link every proposed column to source path and line or a user-confirmed
   external contract.
4. Produce the exact replacement:

   ```text
   Webapi/<table-1>/fields = <column-name-1>,<column-name-2>,<column-name-3>
   ```

5. Keep the proposal unresolved if it is empty or any evidence is incomplete.

For each already-explicit setting:

- compare configured columns with proven required columns;
- classify it as exact, missing required columns, potentially overbroad, or
  externally justified;
- include an exact proposed fix for every gap;
- do not silently change it.

Update every report section. Resolve all wildcard and call-site rows before
continuing.

At large scale, the HTML report remains authoritative and must contain every
row. Reconcile its counts with the working CSV ledgers before the approval
gate.

**Output:** Evidence-complete report with exact wildcard replacements and all
already-explicit configurations.

## Phase 4: Review the complete plan

**Goal:** Present the full exposure reduction before edits.

Show:

- wildcard issues found and the exact replacement for each;
- evidence for every proposed column;
- source GETs requiring `$select`;
- already-explicit settings and any missing or excess columns;
- missing or duplicate settings;
- zero unresolved call sites.

<!-- gate: migrate-webapi-selectall:4.apply-plan | category=consent | cancel-leaves=reviewed-migration-report -->

> 🚦 **Gate (consent · migrate-webapi-selectall:4.apply-plan):** Approve all wildcard replacements, required source projections, optional explicit-setting hardening, and local edits. Canceling preserves only the report.

Use `AskUserQuestion` with:

- `Apply all wildcard fixes and approved explicit fixes`;
- `Apply all wildcard fixes only`;
- `Cancel`.

Never offer a subset of wildcard fixes.

## Phase 5: Apply approved edits

**Goal:** Update source projections and every wildcard setting.

1. If the worktree is clean, create a local git checkpoint. If it is dirty,
   preserve user changes and clearly record that no automatic checkpoint was
   created.
2. Use `Edit` to add approved `$select` projections. Preserve methods, filters,
   ordering, expansion, pagination, encoding, Liquid expressions, and error
   handling.
3. Use `Edit` to replace every wildcard value in every scope and profile.
   Preserve identifiers, key names, quoting, indentation, comments, and
   unrelated values.
4. Apply already-explicit changes only when included in the selected approval.
5. Re-read every changed block immediately and update report status.

For large inventories, apply one approved batch at a time, never edit the same
file concurrently, verify each scoped diff, and checkpoint after manageable
groups. Keep all later batches pending when one batch fails.

If any edit fails or a file changed since review, stop. Do not continue with a
partial configuration set and do not perform a broad rollback over user work.

**Output:** All approved local edits and updated report.

## Phase 6: Verify independently

**Goal:** Prove the migration without trusting prior notes.

1. Repeat Phase 2 discovery from scratch.
2. Confirm every configuration scope contains zero
   `Webapi/<table-1>/fields` wildcard values.
3. Compare each migrated value with its approved exact replacement.
4. Reopen every call site and replay the coverage analysis:
   - mapped table and method remain correct;
   - required setting columns are present;
   - normal record GETs use explicit `$select`;
   - expanded, lookup, write, FetchXML, file, and image columns remain covered.
5. Run the existing project build for code/SPA sites. For traditional sites,
   inspect edited JavaScript and Liquid syntax and use existing site tests when
   available.
6. Confirm the report retains template version `1`, contains every required
   section, and contains no unresolved `__TOKEN__` values.
7. Confirm every retained companion file has the exact header or line-list
   format declared by asset manifest version `1`.
8. Finalize the report with found, fixed, remaining, explicit-review, and
   verification counts.

For large inventories, use a new verification ledger and fresh bounded
batches. Create it from the manifest's `verification` CSV template. Reconcile
every count using the equations in the large-scale reference; never infer
completion from samples.

Do not claim full hardening while explicit configuration gaps remain. Use the
partial status defined in the reporting contract when applicable.

**Output:** Final report and verified local migration.

## Phase 7: Deploy and summarize

**Goal:** Publish only verified changes.

Before requesting deployment approval, show the confirmed PAC environment and
the exact command. For traditional sites, also select the reviewed deployment
profile and use `default` only when the user explicitly confirms it. A
different environment or profile requires a separate deployment approval.

<!-- gate: migrate-webapi-selectall:7.deploy | category=final | cancel-leaves=local-migration -->

> 🚦 **Gate (final · migrate-webapi-selectall:7.deploy):** Approve the verified migration for the displayed environment and deployment profile. Canceling preserves local edits and the final report without changing the live site.

Use `AskUserQuestion`: `Deploy now` or `Keep local only`.

- Reconfirm that the active PAC environment matches the confirmed target.
- For code/SPA sites, confirm `.powerpages-site` contains the approved
  configuration edits, run the existing production build, then run
  `pac pages upload-code-site --rootPath "<PROJECT_ROOT>"`.
- For traditional sites, run
  `pac pages upload --path "<PROJECT_ROOT>" --deploymentProfile "<PROFILE>"`.

After deployment, smoke-test each affected workflow. Treat HTTP 403 responses
as evidence to investigate and never restore `*`. Do not add a column under
the prior approval. Return to Phase 3, update the exact plan and report, repeat
the Phase 4 approval, independently verify in Phase 6, and obtain a new
Phase 7 deployment approval.

Record usage by following
`${PLUGIN_ROOT}/references/skill-tracking-reference.md` with
`--skillName "MigrateWebapiSelectall"`.

Summarize wildcard counts, explicit reviews, source edits, report path,
verification, deployment, and checkpoint status.

## Progress tracking

Create these tasks before Phase 1:

| Task subject | activeForm | Description |
|---|---|---|
| Prepare migration project | Preparing migration project | Resolve layouts, solution context, and git state |
| Inventory Web API usage | Inventorying Web API usage | Find every configuration and source call |
| Resolve actual columns | Resolving actual columns | Retrieve schema and trace every consumer |
| Review migration plan | Reviewing migration plan | Present exact fixes and evidence |
| Apply approved migration | Applying approved migration | Edit projections and configurations |
| Verify migration results | Verifying migration results | Repeat discovery, build, and finalize report |
| Deploy and summarize | Deploying and summarizing | Publish after approval and report outcome |

Mark each task `in_progress` when starting and `completed` when finished.

---

**Begin with Phase 1: Prepare.**
