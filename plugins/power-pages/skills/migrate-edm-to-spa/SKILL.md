---
name: migrate-edm-to-spa
description: >-
  Migrates classic Enhanced Data Model (EDM) Power Pages websites to modern static SPA code sites.
  Use when the user wants to migrate EDM to SPA, convert a classic Power Pages portal to a React,
  Vue, Angular, or Astro code site, analyze a downloaded PAC website-data export, or re-author an
  existing portal as a client-side Power Pages site with static and Playwright runtime discovery.
user-invocable: true
argument-hint: "<website-id-or-downloaded-site-path>"
allowed-tools: Read, Write, Edit, Bash, Grep, Glob, AskUserQuestion, Task, TaskCreate, TaskUpdate, TaskList, Skill, mcp__plugin_power-pages_playwright__browser_navigate, mcp__plugin_power-pages_playwright__browser_snapshot, mcp__plugin_power-pages_playwright__browser_click, mcp__plugin_power-pages_playwright__browser_close, mcp__plugin_power-pages_playwright__browser_network_requests, mcp__plugin_power-pages_playwright__browser_console_messages, mcp__plugin_power-pages_playwright__browser_wait_for, mcp__plugin_power-pages_playwright__browser_resize, mcp__plugin_power-pages_playwright__browser_evaluate
model: opus
---

> **Plugin check**: Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/check-version.js"` — if it outputs a message, show it to the user before proceeding.

# Migrate EDM Site to SPA

Migrate a classic Enhanced Data Model (EDM) Power Pages website to a modern static SPA code site. This skill discovers the existing EDM source, observes runtime behavior, builds an explainable migration model, presents an approval-gated plan, re-authors the site into React, Vue, Angular, or Astro, and verifies drift before handoff.

## Core Principles

- **Evidence before generation**: Do not write SPA files until both static EDM evidence and runtime behavior have been summarized and approved.
- **Migration is re-authoring, not blind conversion**: EDM runtime features, Liquid, entity lists, entity forms, and portal-managed behavior must be mapped to explicit SPA routes, components, API calls, auth patterns, and documented gaps.
- **Explain every inference**: Each migrated route, component, data dependency, permission, and unsupported feature must trace back to static evidence, runtime evidence, or both.
- **Preserve user control**: Ask before downloading a site, logging in through the browser, testing destructive form actions, writing SPA files, or invoking follow-up skills.
- **Use existing Power Pages skills**: Reuse `/create-site`, `/integrate-webapi`, `/setup-auth`, `/create-webroles`, `/test-site`, and `/deploy-site` instead of duplicating their implementation logic.
- **Deploy to hydrate metadata**: Deploy the scaffolded SPA before metadata-dependent migration work is finalized. `/deploy-site` creates the `.powerpages-site` metadata folder that follow-up skills and migration steps need for table permissions, web roles, site settings, server logic, and related YAML.
- **Static SPA only**: Supported target frameworks are React, Vue, Angular, and Astro. Do not generate Next.js, Nuxt, Remix, SvelteKit, Liquid, or server-rendered output.

**Initial request:** $ARGUMENTS

> **Prerequisites:**
>
> - Either a Power Pages website record ID that can be downloaded with `pac pages download`, or an existing PAC-downloaded EDM site directory.
> - A target static SPA framework: React, Vue, Angular, or Astro.
> - Optional but strongly recommended: the live site URL for Playwright runtime discovery.
> - For authenticated areas, the user must log in manually in the browser when prompted.

---

## Workflow

1. **Resolve Migration Source** — Get the website record ID or downloaded source directory, target framework, output path, and optional live URL.
2. **Pre-flight Readiness** — Validate PAC shape, score complexity, and flag unsupported or high-risk patterns.
3. **Static EDM Analysis** — Inventory PAC records, sidecar files, Liquid, custom JavaScript, data dependencies, auth, and security.
4. **Runtime Discovery** — Use Playwright to crawl routes, observe auth transitions, capture network calls, and identify hidden behavior.
5. **Build Migration Model** — Combine static and runtime evidence into a confidence-scored canonical site model.
6. **Review Migration Plan** — Present the SPA route/component/data/security plan and get user approval before writing files.
7. **Scaffold, Deploy, and Migrate SPA** — Create or reuse the target SPA project, deploy once to hydrate `.powerpages-site`, then re-author pages, components, services, and metadata.
8. **Verify Migration** — Build and browse-test the SPA, compare against EDM evidence, and produce a drift report.
9. **Summarize and Hand Off** — Record skill usage, summarize output, and recommend focused next skills.

---

## Phase 1: Resolve Migration Source

**Goal:** Identify the EDM source, target SPA framework, output location, and runtime discovery options.

### Actions

#### 1.1 Create Task List

Create the full task list with all 9 phases before starting any work (see [Progress Tracking](#progress-tracking) table). Mark this phase `in_progress`.

#### 1.2 Gather Migration Inputs

If `$ARGUMENTS` contains a UUID-like website record ID, treat it as the proposed website record ID. If it contains an existing path, treat it as the proposed EDM source directory. Otherwise ask the user:

| Question | Options |
|----------|---------|
| How should I get the EDM source? | Download by website record ID, Use an already downloaded directory |
| Which static SPA framework should the migrated site use? | React (Recommended), Vue, Angular, Astro |
| Where should the migrated SPA be created? | New folder in current directory (Recommended), Existing empty directory, Other directory |
| Do you have the live site URL for runtime discovery? | I'll provide it, Skip runtime discovery for now |

For download-based migrations, ask for:

- Website record ID.
- Download directory.
- Whether overwriting an existing download directory is allowed.

For existing-directory migrations, ask for:

- Absolute or workspace-relative directory that contains the PAC website-data export.

Store:

- `EDM_SOURCE_MODE`
- `WEBSITE_RECORD_ID` if provided
- `EDM_SOURCE_ROOT`
- `TARGET_FRAMEWORK`
- `TARGET_PROJECT_ROOT`
- `LIVE_SITE_URL` if provided

#### 1.3 Download the EDM Site When Needed

If the user chose download mode, confirm that `pac` is authenticated and run:

```bash
pac pages download --webSiteId "<WEBSITE_RECORD_ID>" --path "<DOWNLOAD_ROOT>" --overwrite
```

If the command fails, report the error and ask the user whether to retry, provide an existing download directory, or stop.

#### 1.4 Locate the Website Data Root

Find the directory that contains EDM records. It usually contains files and folders such as:

```text
website.yml
web-pages/
web-templates/
content-snippets/
page-templates/
web-files/
lists/
basic-forms/
table-permissions/
webrole.yml
sitesetting.yml
```

If the directory shape is unclear, read `${CLAUDE_PLUGIN_ROOT}/skills/migrate-edm-to-spa/references/pac-edm-structure.md`, summarize the mismatch, and ask the user to confirm the correct root before continuing.

### Output

- EDM source root confirmed.
- Target SPA framework and output root confirmed.
- Live URL captured or runtime discovery limitation recorded.

---

## Phase 2: Pre-flight Readiness

**Goal:** Decide whether the migration is feasible and identify risk before deep analysis.

### Actions

#### 2.1 Load PAC Structure Guidance

Read `${CLAUDE_PLUGIN_ROOT}/skills/migrate-edm-to-spa/references/pac-edm-structure.md`.

Use it to validate the source shape and identify all relevant PAC record groups and sidecar files.

#### 2.2 Build a Source Inventory

Use `Glob` and `Read` to count and sample:

- Web pages and content pages.
- Web templates and Liquid source files.
- Content snippets and page templates.
- Web files, CSS, JavaScript, and images.
- Entity lists in `lists/`.
- Basic forms in `basic-forms/`.
- Advanced forms in `advanced-forms/` when present.
- Table permissions in `table-permissions/`.
- Web roles and site settings.
- Navigation records: web link sets, site markers, publishing states, and page rules.

#### 2.3 Detect High-Risk Patterns

Flag each finding with `low`, `medium`, or `high` risk:

| Risk | Examples |
|------|----------|
| Heavy Liquid logic | Deep includes, conditionals, loops, FetchXML blocks, server-side decisions that control UI or data |
| Complex Dataverse behavior | Entity lists/forms with embedded JSON actions, advanced forms, custom redirects, multistep flows, attachment handling |
| Security-sensitive behavior | Role-gated pages, Contact/Account/Parent table-permission scopes, profile settings, auth provider settings |
| Hidden runtime behavior | Custom JavaScript, jQuery validators, portal runtime globals, non-obvious redirects |
| Unsupported or manual work | Forums/blogs/polls, knowledge management search/facets, portal comments, internal portal APIs, custom widgets |

#### 2.4 Present Readiness Summary

Present:

| Area | Count / Finding | Risk | Notes |
|------|-----------------|------|-------|
| Web pages | `<count>` | `<risk>` | `<notes>` |
| Web templates | `<count>` | `<risk>` | `<notes>` |
| Lists/forms | `<count>` | `<risk>` | `<notes>` |
| Liquid/custom JS | `<count>` | `<risk>` | `<notes>` |
| Security/auth | `<summary>` | `<risk>` | `<notes>` |
| Unsupported patterns | `<summary>` | `<risk>` | `<notes>` |

If any high-risk pattern affects core functionality, use `AskUserQuestion`:

| Question | Options |
|----------|---------|
| I found high-risk EDM patterns that may require manual re-authoring. Continue with migration planning? | Continue and document gaps (Recommended), Narrow the scope, Stop |

### Output

- Readiness score and risk list.
- User approval to continue when risk is high.

---

## Phase 3: Static EDM Analysis

**Goal:** Build a structured, evidence-backed understanding of the downloaded EDM site.

### Actions

#### 3.1 Load Model and Pattern References

Read:

- `${CLAUDE_PLUGIN_ROOT}/skills/migrate-edm-to-spa/references/edm-migration-model.md`
- `${CLAUDE_PLUGIN_ROOT}/skills/migrate-edm-to-spa/references/edm-to-spa-patterns.md`

#### 3.2 Analyze Page and Route Structure

Inventory:

- `web-pages/**/<name>.webpage.yml`
- Page partial URLs, parent-child hierarchy, publishing state, hidden-from-sitemap flags, page templates.
- Sidecars such as `.copy.html`, `.summary.html`, `.custom_css.css`, `.custom_javascript.js`.
- Content pages and localized copies.

Produce a route candidate table:

| EDM page | Partial URL | Template | Sidecars | SPA route | Confidence |
|----------|-------------|----------|----------|-----------|------------|

#### 3.3 Analyze Templates, Liquid, and Snippets

Inventory:

- `web-templates/**/<name>.webtemplate.source.html`
- `content-snippets/`
- `page-templates/`
- Liquid includes, assignments, loops, conditionals, FetchXML, `sitemarkers`, `settings`, `snippets`, `user`, `request`, and `entities` usage.

Classify each template behavior:

| Template | Liquid intent | Data dependency | SPA equivalent | Manual work |
|----------|---------------|-----------------|----------------|-------------|

#### 3.4 Analyze Lists, Forms, and Dataverse Dependencies

Inspect:

- `lists/**/*.list.yml`
- `lists/**/*.custom_javascript.js`
- `basic-forms/**/*.basicform.yml`
- `basic-forms/**/*.basicformmetadata.yml`
- `basic-forms/**/*.custom_javascript.js`
- `advanced-forms/**/*.advancedform.yml`

Pay special attention to embedded JSON in `adx_settings`, target entities, modes, redirects, action metadata, attachment settings, validators, list item actions, and advanced-form session/progress/authentication settings.

Produce:

| EDM artifact | Table | Operation | UI behavior | SPA/API mapping | Evidence |
|--------------|-------|-----------|-------------|-----------------|----------|

#### 3.5 Analyze Auth, Roles, Permissions, and Site Settings

Inspect:

- `webrole.yml`
- `table-permissions/**/*.tablepermission.yml`
- `sitesetting.yml`
- `websiteaccess.yml`
- Auth and registration settings.
- Search, knowledge management, product filtering, profile, and Web API settings.

Map:

| EDM security artifact | Meaning | SPA implication | Follow-up skill |
|-----------------------|---------|-----------------|-----------------|

#### 3.6 Analyze Web Files and Custom Client Code

Inventory:

- `web-files/`
- Page/list/form custom CSS and JavaScript sidecars.
- References to jQuery, `Page_Validators`, internal portal globals, `/_api/`, FetchXML endpoints, redirects, or DOM-driven behavior.

Classify each script as:

- Directly portable.
- Needs framework-specific rewrite.
- Needs Web API or server logic replacement.
- Not supported without manual work.

#### 3.7 Save Static Analysis Artifacts

Create a migration artifact directory under the target workspace, not inside the plugin repo:

```text
<TARGET_PROJECT_ROOT>/migration-artifacts/
```

Save:

- `edm-source-inventory.json`
- `static-analysis.json`
- `static-analysis-summary.md`

### Output

- Static inventory and summary saved.
- Evidence-backed route, component, data, auth, permission, and unsupported-pattern findings.

---

## Phase 4: Runtime Discovery

**Goal:** Observe the live EDM site to discover behavior that is implicit in the portal runtime or not obvious from PAC files.

### Actions

#### 4.1 Confirm Runtime Scope

If `LIVE_SITE_URL` is missing, ask:

| Question | Options |
|----------|---------|
| Runtime discovery works best against the live EDM site. What should I do? | Provide live URL, Continue static-only (limited confidence), Stop |

If the user chooses static-only, mark runtime confidence as limited and continue to Phase 5.

#### 4.2 Launch Browser and Load Site

Use Playwright:

1. Resize to width `1280`, height `720`.
2. Navigate to `LIVE_SITE_URL`.
3. Wait for the page to render.
4. Capture an accessibility snapshot.
5. Capture console errors.
6. Capture network requests with static assets excluded.

If the site redirects to an identity provider or private gate, ask the user to complete login in the browser. Never attempt to automate credentials.

#### 4.3 Crawl Discoverable Routes

Use `browser_evaluate` to extract same-origin links from rendered pages. Crawl up to 25 pages unless the user approves a higher cap.

For each page, capture:

- URL and route.
- Snapshot summary.
- Console errors.
- `/_api/` and other data requests.
- Redirects and auth-gated states.
- Forms, list actions, search, filters, buttons, and navigation behavior visible in the snapshot.

#### 4.4 Explore Interactions Safely

For read-only interactions, click navigation, filters, pagination, tabs, accordions, and search controls when they do not create or modify data.

Before submitting forms or triggering create/update/delete actions, ask:

| Question | Options |
|----------|---------|
| I found interactions that may create or modify Dataverse data. Should I test them? | Skip destructive interactions (Recommended), Test with user-approved sample data |

#### 4.5 Compare Runtime and Static Signals

Identify:

- Routes seen at runtime but missing from static navigation.
- Static pages not reachable from runtime navigation.
- API calls not evident in PAC source.
- Form/list behavior that differs from YAML settings.
- Auth-only routes and role-dependent UI.
- Console/runtime errors that should not be reproduced in the SPA.

#### 4.6 Save Runtime Artifacts

Save:

- `runtime-discovery.json`
- `runtime-discovery-summary.md`

### Output

- Runtime route map, behavior log, network/API inventory, auth observations, and static/runtime mismatch list.

---

## Phase 5: Build Migration Model

**Goal:** Combine static and runtime evidence into a canonical migration model that can drive SPA re-authoring.

### Actions

#### 5.1 Use the Canonical Model Schema

Follow `${CLAUDE_PLUGIN_ROOT}/skills/migrate-edm-to-spa/references/edm-migration-model.md`.

Build `canonical-site-model.json` with:

- Site metadata.
- Route/page model.
- Template/component model.
- Dataverse dependency model.
- Form/list behavior model.
- Auth/security model.
- Asset model.
- Unsupported/manual-work model.
- Evidence ledger and confidence scores.

#### 5.2 Build the EDM-to-SPA Mapping Matrix

For each EDM capability, assign one migration status:

| Status | Meaning |
|--------|---------|
| Direct SPA equivalent | Can be implemented as route/component/static asset without special services |
| Requires Web API | Needs Dataverse Web API service, table permissions, and site settings |
| Requires auth/role work | Needs `/setup-auth`, `/create-webroles`, or permission mapping |
| Requires custom code | Needs framework-specific rewrite of Liquid or custom JavaScript |
| Manual gap | Cannot be migrated automatically with confidence |

#### 5.3 Score Confidence

Score each route, data dependency, and behavior:

- `high`: supported by static and runtime evidence, or deterministic configuration.
- `medium`: supported by only one evidence source or simple inference.
- `low`: inferred from ambiguous Liquid/custom JavaScript or unavailable runtime paths.

Low-confidence items must become review items in Phase 6.

#### 5.4 Save Model Artifacts

Save:

- `canonical-site-model.json`
- `edm-to-spa-mapping.md`
- `migration-gap-log.md`

### Output

- Canonical model ready for user review.
- Confidence-scored migration plan inputs.

---

## Phase 6: Review Migration Plan

**Goal:** Get explicit user approval for the migration approach before writing or replacing SPA files.

### Actions

#### 6.1 Present Current-State Summary

Summarize:

- Site name and purpose.
- Page/route count and key navigation.
- Main templates and reusable layouts.
- Dataverse tables and operations.
- Auth, web roles, and table permissions.
- Key custom JavaScript and Liquid behaviors.
- High-risk or unsupported features.

#### 6.2 Present SPA Plan

Use these tables:

```text
| SPA route | Source EDM page(s) | Component(s) | Data/API needs | Confidence |
|-----------|--------------------|--------------|----------------|------------|

| Dataverse table | EDM source | Operations | Required site settings/permissions | Follow-up |
|-----------------|------------|------------|-------------------------------------|-----------|

| EDM behavior | SPA implementation | Status | Manual notes |
|--------------|--------------------|--------|--------------|
```

#### 6.3 Confirm Scope and Gaps

Use `AskUserQuestion`:

| Question | Options |
|----------|---------|
| Approve this migration plan? | Approve and implement, Revise the plan, Narrow scope, Stop |

If the user requests revisions, update the model and plan artifacts, then ask again.

### Output

- Approved route/component/data/security migration plan.
- Explicit list of manual gaps accepted by the user.

---

## Phase 7: Scaffold, Deploy, and Migrate SPA

**Goal:** Create or update the target SPA code site, deploy it once to create `.powerpages-site`, and then complete metadata-aware migration work according to the approved plan.

### Actions

#### 7.1 Create or Reuse Target Project

If `TARGET_PROJECT_ROOT` does not contain a Power Pages code site, ask for approval to invoke `/create-site` to scaffold the selected framework and project location.

If the target project already exists, verify:

- `powerpages.config.json`
- `package.json`
- Framework and router.
- Source directory and build command.

If the target exists and is not empty, ask before overwriting or replacing files.

#### 7.2 Build and Deploy Once to Hydrate Metadata

After the target SPA scaffold exists and before finalizing table permissions, web roles, site settings, server logic, or Web API settings:

1. Run the target project's build command, usually:

   ```bash
   npm run build
   ```

2. Fix build failures before deployment.
3. Ask the user to approve the required first deployment:

   | Question | Options |
   |----------|---------|
   | The migrated SPA needs an initial deployment so Power Pages creates `.powerpages-site` metadata. Deploy now? | Deploy now (Required for metadata migration), Stop and deploy later |

4. If approved, invoke `/deploy-site` for `TARGET_PROJECT_ROOT`.
5. After deployment completes, verify `.powerpages-site/` exists in the target project.
6. If `.powerpages-site/` is still missing, stop metadata-dependent work and report that table permissions, web roles, site settings, server logic, and tracking cannot be finalized until deployment creates it.

This deployment is not optional for migrations that include metadata-dependent functionality. It hydrates the target code site metadata so the migration can create or update YAML through existing Power Pages skill patterns.

#### 7.3 Establish Migration Traceability

For each generated route/component/service, record its source in `migration-artifacts/migration-traceability.json`:

| Generated artifact | Derived from | Evidence | Confidence |
|--------------------|--------------|----------|------------|

Use concise comments only when they help future maintainers understand non-obvious EDM mappings.

#### 7.4 Implement Routes and Layout

Create the SPA route structure from the approved model:

- Home/root route.
- Child routes from web page hierarchy.
- Not-found/access-denied routes when present.
- Shared header/footer/navigation based on web templates, web link sets, and snippets.
- Framework-appropriate routing conventions.

#### 7.5 Implement Components and Content

Map:

- Web page copy and summaries to page components.
- Web templates to reusable layout or section components.
- Content snippets to constants or content modules.
- Web files to public assets or imported assets.
- Custom CSS to framework/project styles.

Do not leave placeholder-only pages for routes marked in scope. For manual gaps, create explicit TODO sections that explain the missing EDM behavior and link to `migration-gap-log.md`.

#### 7.6 Implement Data, Forms, Auth, and Metadata Boundaries

For tables that require Web API integration, either:

- Invoke `/integrate-webapi` with the approved table/operation list, or
- Create only typed stubs and mark the work as pending when the user does not approve Web API implementation.

For auth and role-based UI, either:

- Invoke `/setup-auth` and `/create-webroles` when the approved plan requires them, or
- Add explicit migration notes that deployment-time auth/security remains incomplete.

Never bypass table permissions or imply that client-side role checks enforce data security.

When `.powerpages-site/` exists, use the approved model to migrate or create metadata through existing deterministic scripts and skills:

- Table permissions and Web API site settings via `/integrate-webapi` or approved permission/settings scripts.
- Web roles via `/create-webroles` when missing.
- Auth-related site settings via `/setup-auth` when login/role UX is in scope.
- Server logic only through `/add-server-logic` when an EDM behavior cannot be safely represented client-side.

If a metadata item from the EDM source cannot be confidently mapped to the new SPA site, put it in `migration-gap-log.md` instead of copying it silently.

#### 7.7 Build and Commit Milestones

Run the project build after meaningful implementation chunks:

```bash
npm run build
```

Fix build errors before proceeding. Commit after significant milestones when working in a git repository.

### Output

- Migrated SPA files created or updated.
- Initial deployment completed and `.powerpages-site/` verified for metadata-dependent migrations.
- Metadata-dependent artifacts created or explicitly logged as gaps.
- Traceability artifacts saved.
- Build passes before verification.

---

## Phase 8: Verify Migration

**Goal:** Verify the migrated SPA against the approved plan and the observed EDM behavior.

### Actions

#### 8.1 Verify File Inventory

Confirm the expected routes, components, services, assets, and migration artifacts exist. Compare against the approved plan.

Confirm `.powerpages-site/` exists when the approved migration includes table permissions, web roles, site settings, server logic, or Web API settings. If it is missing, mark metadata verification as failed and direct the user to run `/deploy-site`.

#### 8.2 Verify Build

Run:

```bash
npm run build
```

Fix failures before continuing.

#### 8.3 Browser-Verify the SPA

Start the dev server, navigate with Playwright, and verify:

- All in-scope routes render meaningful content.
- Navigation matches the approved route model.
- No critical console errors appear.
- Data/API placeholders, pending work, or manual gaps are visibly and accurately documented.
- Auth-gated or role-gated routes behave according to the approved implementation scope.

#### 8.4 Compare Against EDM Evidence

Create a drift report:

| EDM route/behavior | SPA result | Status | Notes |
|--------------------|------------|--------|-------|
| `<route>` | `<route/component>` | Match / Changed / Gap | `<notes>` |

Classify drift:

- `match`: behavior/content is represented in the SPA.
- `intentional change`: user approved a change.
- `manual gap`: known unsupported or deferred behavior.
- `unexpected drift`: fix before finishing, or ask the user to accept/narrow scope.

#### 8.5 Save Verification Artifacts

Save:

- `migration-verification-report.md`
- Updated `migration-gap-log.md`

### Output

- Build verified.
- Browser verification complete.
- Drift/gap report saved and reviewed.

---

## Phase 9: Summarize and Hand Off

**Goal:** Record skill usage, summarize the migrated SPA, and recommend the smallest useful next steps.

### Actions

#### 9.1 Record Skill Usage

> Reference: `${CLAUDE_PLUGIN_ROOT}/references/skill-tracking-reference.md`

Follow the skill tracking instructions in the reference to record this skill's usage. Use `--skillName "MigrateEdmToSpa"`.

#### 9.2 Present Final Summary

Include:

| Area | Summary |
|------|---------|
| Source EDM site | `<website id or source path>` |
| Target SPA | `<framework and project root>` |
| Routes migrated | `<count and notable routes>` |
| Data/API work | `<completed / pending>` |
| Auth/security work | `<completed / pending>` |
| Metadata hydration | `<.powerpages-site present / missing>` |
| Manual gaps | `<count and highest-risk items>` |
| Verification | `<build/browser/drift status>` |
| Key artifacts | `<migration-artifacts paths>` |

#### 9.3 Recommended Next Skills

Recommend only what fits the migration result:

| Situation | Recommend |
|-----------|-----------|
| Dataverse tables still need frontend API work | `/integrate-webapi` |
| Auth or role behavior is incomplete | `/setup-auth` or `/create-webroles` |
| Permissions need review | `/audit-permissions` |
| `.powerpages-site` is missing or metadata hydration failed | `/deploy-site` |
| Deployed runtime parity should be checked | `/test-site` |

### Output

- Skill usage recorded when site settings are available.
- User receives a concise migration handoff with paths, gaps, and next skills.

---

## Key Decision Points

1. **Phase 1**: Confirm source mode, target framework, target output location, and whether runtime discovery is available.
2. **Phase 2**: Continue, narrow, or stop if high-risk EDM patterns are found.
3. **Phase 4**: Confirm before authenticated browsing or interactions that may create/modify data.
4. **Phase 6**: Approve the migration plan before writing SPA files.
5. **Phase 7**: Confirm before invoking follow-up skills, overwriting an existing target project, or stopping before the required first deployment that creates `.powerpages-site`.
6. **Phase 8**: Confirm whether unexpected drift should be fixed, accepted, or moved to manual gaps.

---

## Progress Tracking

| Task subject | activeForm | Description |
|--------------|------------|-------------|
| Resolve migration source | Resolving source | Collect website record ID or downloaded source path, target framework, output location, and live URL |
| Assess migration readiness | Assessing readiness | Validate PAC shape, score complexity, and flag unsupported or high-risk EDM patterns |
| Analyze EDM source | Analyzing source | Inventory pages, templates, snippets, lists, forms, assets, custom code, auth, roles, and permissions |
| Discover runtime behavior | Discovering runtime | Crawl the live site with Playwright, capture routes, auth transitions, network calls, and hidden behavior |
| Build migration model | Building model | Combine static and runtime evidence into a confidence-scored canonical site model |
| Review migration plan | Reviewing plan | Present SPA route/component/data/security mapping and get user approval |
| Migrate SPA implementation | Migrating SPA | Scaffold or update the SPA, deploy once to hydrate `.powerpages-site`, and create routes, components, services, metadata, assets, and traceability artifacts |
| Verify migrated SPA | Verifying migration | Build and browser-test the SPA, compare against EDM evidence, and document drift |
| Summarize migration | Summarizing migration | Record usage, summarize outputs and gaps, and recommend focused next skills |

Mark each task `in_progress` when starting it and `completed` when done via `TaskUpdate`.

---

## Test Prompts

| Prompt type | Prompt | Expected outcome |
|-------------|--------|------------------|
| Happy path | "Migrate website record `<id>` from EDM to a React SPA." | Asks for output/runtime details, downloads source, analyzes static/runtime evidence, presents an approval-gated plan, migrates approved scope, verifies drift |
| Existing source | "I already downloaded the portal to `./legacy-site`; convert it to Vue." | Skips PAC download, validates PAC folder shape, performs static analysis, asks for live URL only for runtime discovery |
| Near miss | "Create a new customer portal in React." | Does not use this skill; `/create-site` is the correct skill |

---

**Begin with Phase 1: Resolve Migration Source**
