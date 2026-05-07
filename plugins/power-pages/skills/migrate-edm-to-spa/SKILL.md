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
7. **Create the SPA, Deploy, Migrate Metadata, Then Implement** — Invoke `/create-site` with the selected framework and approved design choices, run `/deploy-site` to hydrate `.powerpages-site`, migrate EDM metadata (table permissions, server logic, web roles, site settings) into the new SPA via `/integrate-webapi`, `/add-server-logic`, `/create-webroles`, and `/setup-auth`, and only then implement the routes, components, content, and services that depend on that metadata.
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

For download-based migrations, ask **only** for the website record ID. Do **not** prompt for a download directory or an overwrite flag — Phase 1.3 creates a fresh OS temp directory automatically, so there is nothing to overwrite.

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

If the user chose download mode, confirm that `pac` is authenticated, then create a fresh OS temp directory for the PAC export and download into it. Use Node to create the temp directory cross-platform:

```bash
node -e "const fs=require('fs'),os=require('os'),path=require('path');console.log(fs.mkdtempSync(path.join(os.tmpdir(),'edm-source-')))"
```

Capture the printed path as `EDM_SOURCE_ROOT`, then run:

```bash
pac pages download --webSiteId "<WEBSITE_RECORD_ID>" --path "<EDM_SOURCE_ROOT>" --modelVersion 2
```

Tell the user where the source was downloaded (e.g., "Downloaded EDM source to `/tmp/edm-source-abc123`"). The temp directory is freshly created and empty, so no `--overwrite` flag is needed and no overwrite confirmation is required from the user.

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
- Route/page model with **per-route component mappings** — each route lists the EDM artifacts in use today (web template, snippet, entity list, basic/advanced form, custom JS, Liquid block, etc.) paired with the SPA replacement and a `targetKind` of `component`, `content`, `webApi`, `serverLogic`, or `manualGap`.
- Template/component model.
- Dataverse dependency model with **table fields and relationships** — for each table, capture key columns and lookup/one-to-many/many-to-many relationships so the migration plan can render an ER diagram.
- Form/list behavior model.
- Auth/security model.
- Asset model.
- Unsupported/manual-work model.
- Evidence ledger and confidence scores.

Use `${CLAUDE_PLUGIN_ROOT}/skills/migrate-edm-to-spa/references/edm-to-spa-patterns.md` to classify Liquid: composition/static content → component or content; safe read-only data access reproducible via Dataverse Web API + table permissions → Web API; server-only context, privileged access, or server-evaluated business rules → **Server Logic** (handed off to `/add-server-logic` in Phase 7.3); complex/ambiguous Liquid → manual gap.

#### 5.2 Build the EDM-to-SPA Mapping Matrix

For each EDM capability, assign one migration status:

| Status | Meaning |
|--------|---------|
| Direct SPA equivalent | Can be implemented as route/component/static asset without special services |
| Requires Web API | Needs Dataverse Web API service, table permissions, and site settings |
| Requires server logic | Needs `/add-server-logic` because the behavior depends on server-only context, privileged access, or server-evaluated business rules |
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

**Goal:** Capture the new SPA's design choices, present the migration plan in an interactive HTML document, and get explicit user approval before writing or replacing SPA files.

### Actions

#### 6.1 Capture New SPA Design Direction

Mirror the design experience from `/create-site` so users get the same delightful flow whether they're starting fresh or migrating. Ask just two high-level questions and let your design judgement do the rest — do not ask the user for raw palette hex values, density, navigation pattern, or font names.

Use `AskUserQuestion`:

| Question | Header | Options |
|----------|--------|---------|
| What aesthetic direction do you want for the new SPA? | Aesthetic | Minimal & Clean (Recommended), Bold & Vibrant, Dark & Moody, Warm & Organic |
| What's the overall mood? | Mood | Professional & Trustworthy (Recommended), Creative & Playful, Technical & Precise, Elegant & Premium |

Then read the design aesthetics reference shared with `/create-site`:

> Reference: `${CLAUDE_PLUGIN_ROOT}/skills/create-site/references/design-aesthetics.md`

Use its **Aesthetic × Mood Mapping** table and design principles to derive concrete choices with best judgement. Specifically:

- **Typography** — pick a Google Fonts pairing matching the chosen font direction (e.g., `Cabinet Grotesk + Fira Code` for Bold & Vibrant + Professional). Never default to Inter/Roboto/Open Sans/Arial.
- **Color palette** — pick five named hex values (Primary, Accent, Background, Surface, Text) that follow the chosen color direction. Avoid the cliched purple-on-white AI palette. Give the palette a short descriptive name (e.g., `"Charcoal + Copper"`, `"Earth Tones with Terracotta Accent"`).
- **Motion** — pick a motion style matching the mapping table (e.g., `"Subtle fades, minimal"`, `"Energetic staggers"`).
- **Layout density** — derive from the EDM source's information density and the chosen aesthetic, not from a separate question. High-density data sites (dashboards, list-heavy portals) should default to `Compact`; marketing/content-heavy sites should default to `Spacious`.
- **Primary navigation pattern** — derive from the existing EDM's primary nav and the chosen aesthetic. Sites with deep hierarchies and frequent task switching tend toward `Sidebar`; flat marketing/portal sites tend toward `Topbar`.

Persist the captured input + derived choices as `DESIGN_DATA`. Keep `aesthetic` and `mood` as separate fields so they can be passed to `/create-site` in Phase 7.1 verbatim — `/create-site` natively understands them and will skip its own aesthetic/mood prompt when they are supplied.

`DESIGN_DATA` shape:

```json
{
  "framework": "<from Phase 1>",
  "aesthetic": "Minimal & Clean",
  "mood": "Professional & Trustworthy",
  "layout": "<derived: Spacious | Compact>",
  "navigation": "<derived: Sidebar | Topbar | Minimal>",
  "typography": "<derived Google Fonts pair>",
  "motion": "<derived motion direction>",
  "palette": {
    "name": "<short descriptive label>",
    "colors": [
      { "name": "Primary",    "hex": "<derived>" },
      { "name": "Accent",     "hex": "<derived>" },
      { "name": "Background", "hex": "<derived>" },
      { "name": "Surface",    "hex": "<derived>" },
      { "name": "Text",       "hex": "<derived>" }
    ]
  }
}
```

The plan's Overview tab visualizes the derived palette as labeled swatches and surfaces the chosen aesthetic + mood, so the user sees and confirms the direction before approving.

#### 6.2 Consolidate Plan Data

Build a JSON object from `canonical-site-model.json` (from Phase 5) and `DESIGN_DATA` (from Phase 6.1) with all required keys:

> Reference: `${CLAUDE_PLUGIN_ROOT}/skills/migrate-edm-to-spa/references/edm-migration-plan-data-format.md`

The data object must include:

- `SITE_NAME` — Site name from Phase 1
- `PLAN_TITLE` — Always `"EDM Migration Plan"`
- `SUMMARY` — One paragraph summarizing the migration scope, target framework, and strategy
- `SITE_STATS` — Pre-computed: `{ routeCount, componentCount, tableCount, manualGapCount }`. `componentCount` counts unique SPA components only (entries whose `targetKind` is `component` or `content`); it must not count `serverLogic`, `webApi`, or `manualGap` mappings.
- `ROUTES_DATA` — Array of routes. Each route includes a `componentMapping` array of `{ edm, targetKind, target }` pairs that show what each EDM artifact becomes in the SPA. Use `targetKind: "serverLogic"` for any server-side Liquid handed off to `/add-server-logic`.
- `DATAVERSE_DATA` — Array of tables with name, source, operations, site settings, follow-up skill, plus optional `fields[]` and `relationships[]` so the plan can render an ER diagram.
- `SECURITY_DATA` — Web roles, permissions, and security constraints
- `GAPS_DATA` — Array of unsupported features and manual work items (can be empty)
- `RATIONALE_DATA` — Array of design rationale points
- `DESIGN_DATA` — `{ framework, aesthetic, mood, layout, navigation, typography, motion, palette: { name, colors: [{ name, hex }, ...] } }` captured in Phase 6.1.

Write this data to a temporary JSON file, e.g., `edm-migration-plan-data.json`.

#### 6.3 Render and Open HTML Plan

Generate the HTML plan file from the template and open it in the user's default browser before asking for approval.

When working inside a Power Pages project, write the plan to:

```text
<PROJECT_ROOT>/docs/edm-migration-plan.html
```

Create the `docs/` folder if it does not already exist. Keep this HTML file inside the repository so it can be reviewed and committed with the rest of the migration work.

Do **not** hand-author the HTML. Use the render script:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/render-edm-migration-plan.js" --output "<OUTPUT_PATH>" --data "<DATA_JSON_PATH>"
```

The render script refuses to overwrite existing files. Before calling it, check if the default output path (`<PROJECT_ROOT>/docs/edm-migration-plan.html`) already exists. If it does, choose a new descriptive filename based on context — e.g., `edm-migration-plan-revised.html`, `edm-migration-plan-apr-2026.html`. Pass the chosen name via `--output`.

After the render script completes, open the resulting HTML file in the user's default browser so they can review the plan interactively. Use the OS-appropriate command for the user's environment.

The rendered plan now includes:

- An **Overview** tab with the chosen aesthetic + mood headline and the derived color palette displayed as labeled swatches with hex values.
- A **Routes** tab where each row shows EDM artifacts today next to their SPA replacement, with badges marking `Server Logic`, `Web API`, and `Manual Gap` mappings.
- A **Data Model** tab that embeds a Mermaid ER diagram built from `DATAVERSE_DATA[].fields` and `DATAVERSE_DATA[].relationships`. Mermaid is loaded from a CDN; the raw `erDiagram` syntax is also kept on the page so the diagram is still legible if the CDN cannot be reached.

#### 6.4 Present CLI Summary

Do **not** repeat the full plan in the CLI. Instead, show a brief summary:

```
✓ Migration plan rendered to: docs/edm-migration-plan.html
  Opening in your browser now...

Quick Summary:
  • Routes: <routeCount> SPA routes mapped from <N> EDM pages
  • Components: <componentCount> reusable SPA components (excludes server logic / web API / manual gap mappings)
  • Tables: <tableCount> Dataverse tables with Web API integration
  • Server logic: <N> componentMapping entries handed off to /add-server-logic in Phase 7.3
  • Gaps: <manualGapCount> unsupported features requiring manual work
  • Confidence: <N> high-confidence routes, <N> medium, <N> low
  • Design: <aesthetic> + <mood> — <palette name> palette, <layout>, <navigation> nav

Review the plan in the browser, then confirm below.
```

#### 6.5 Confirm Scope and Gaps

Use `AskUserQuestion` to get approval:

| Question | Options |
|----------|---------|
| Approve this migration plan? | Approve and implement, Revise the plan, Narrow scope, Stop |

If the user requests revisions:
1. Update the model and data artifacts
2. Regenerate the HTML plan (the render script will complain if the output file exists; ask the user whether to overwrite)
3. Open the updated plan in the browser
4. Ask for approval again

If the user chooses **Stop**, clean up temporary artifacts and exit.

### Output

- Captured `DESIGN_DATA` (aesthetic, mood, palette, typography, motion, layout, navigation) for Phase 7.1's `/create-site` invocation — the same fields `/create-site` natively asks for.
- Approved route/component/data/security migration plan.
- Explicit list of manual gaps accepted by the user.
- HTML plan document saved in `<PROJECT_ROOT>/docs/edm-migration-plan.html` (or user-chosen path) for version control and future reference.

---

## Phase 7: Create the SPA, Deploy, Migrate Metadata, Then Implement

**Goal:** Bring up the target SPA in a deterministic, ordered sequence — scaffold via `/create-site`, deploy once via `/deploy-site` to hydrate `.powerpages-site/`, translate the EDM metadata (table permissions, server logic, web roles, site settings) into the new SPA's `.powerpages-site/`, and *only then* implement the routes, components, and services that depend on that metadata.

The order is mandatory:

1. **`/create-site`** — scaffold the SPA project (Phase 7.1). Never hand-roll the scaffold.
2. **`/deploy-site`** — perform the initial deployment so `.powerpages-site/` is created (Phase 7.2). Metadata-dependent migration cannot proceed until this folder exists.
3. **Migrate metadata into `.powerpages-site/`** — table permissions, server logic, web roles, site settings, sitemarkers, and related YAML, using deterministic skills like `/integrate-webapi`, `/add-server-logic`, `/create-webroles`, and `/setup-auth` (Phase 7.3).
4. **Implement routes, layout, components, content, and services** that reference the migrated metadata (Phases 7.4–7.6).
5. **Build and commit milestones** (Phase 7.7).

Do not implement SPA code that depends on EDM metadata until that metadata has been migrated into the new SPA's `.powerpages-site/`.

### Actions

#### 7.1 Scaffold the SPA with `/create-site`

If `TARGET_PROJECT_ROOT` does not contain a Power Pages code site, invoke `/create-site` first. Pass the selected framework and target location from Phase 1, and the full `DESIGN_DATA` captured in Phase 6.1 — including `aesthetic`, `mood`, derived `typography`, `motion`, and `palette` — as input context to `/create-site`. Because Phase 6.1 asks the same two design questions `/create-site` asks (aesthetic + mood) using the same reference doc and option set, the create-site agent should reuse the captured answers rather than re-prompt the user.

Let `/create-site` run its normal discovery flow only for the items not already decided:

- Site name and purpose.
- Audience.
- Framework confirmation.
- Feature direction.

If `/create-site` would otherwise re-ask the aesthetic, mood, palette, or typography questions, supply the captured answers from `DESIGN_DATA` so the user does not have to make the same choices twice.

Do not bypass `/create-site` by manually copying templates. The migration skill must start from a valid Power Pages SPA scaffold created through the existing skill.

If the target project already exists, verify:

- `powerpages.config.json`
- `package.json`
- Framework and router.
- Source directory and build command.

If the target exists and is not empty, ask before overwriting or replacing files.

#### 7.2 Build and Deploy Once with `/deploy-site`

After the target SPA scaffold exists and before any metadata work begins:

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

This deployment is not optional for migrations that include metadata-dependent functionality. It hydrates the target code-site metadata so Phase 7.3 can create or update YAML through existing Power Pages skill patterns.

#### 7.3 Migrate EDM Metadata into the SPA's `.powerpages-site/`

This step copies/translates EDM metadata into the SPA's hydrated `.powerpages-site/`. It must run **after** `/deploy-site` (so the target metadata folder exists) and **before** Phases 7.4–7.6 (so SPA code can reference the migrated metadata).

Drive this step from the approved migration plan:

- Every route's `componentMapping` entry tagged `targetKind: "serverLogic"` becomes a `/add-server-logic` invocation.
- Every Dataverse table in `DATAVERSE_DATA` with `Read/Create/Update/Delete` operations and the listed `siteSettings` becomes a `/integrate-webapi` invocation (or scripted permission/setting writes when `/integrate-webapi` is not appropriate).
- Every web role in `SECURITY_DATA.webRoles` with status `Create` becomes a `/create-webroles` invocation; roles with status `Reuse` are left untouched; status `Update` becomes a permission-only edit.
- Auth/registration site settings driven by the plan become `/setup-auth` work.

Use existing deterministic skills for each metadata category:

| Metadata category | Source in the plan | Migration skill |
|-------------------|--------------------|-----------------|
| Table permissions and Web API site settings | `DATAVERSE_DATA[].siteSettings`, `DATAVERSE_DATA[].operations` | `/integrate-webapi` |
| Server logic (any `targetKind: "serverLogic"` mapping) | `ROUTES_DATA[].componentMapping[]` with `targetKind === "serverLogic"` | `/add-server-logic` |
| Web roles | `SECURITY_DATA.webRoles[]` with `status === "Create"` or `"Update"` | `/create-webroles` |
| Auth and registration | `SECURITY_DATA.constraints` describing login/redirect flows | `/setup-auth` |
| Complex existing permissions | `SECURITY_DATA.constraints` flagging risky table permissions | `/audit-permissions` |

Do not copy EDM metadata files directly. The SPA's `.powerpages-site/` shape is more granular, so EDM aggregate files must be split:

| EDM source shape | SPA `.powerpages-site` target shape |
|------------------|-------------------------------------|
| `sitesetting.yml` with many settings | `site-settings/<sanitized-name>.sitesetting.yml`, one file per setting |
| `webrole.yml` with many roles | `web-roles/<role-name>.webrole.yml`, one file per role |
| `sitemarker.yml` | `sitemarkers/<marker-name>.sitemarker.yml`, one file per marker |
| `webpagerule.yml` | `webpage-rules/<rule-name>.webpagerule.yml`, one file per rule |
| `websitelanguage.yml` | `site-languages/<language-name>.websitelanguage.yml`, one file per language |
| `publishingstate.yml` | `publishing-states/<state-name>.publishingstate.yml`, one file per state |
| `websiteaccess.yml` | `website-accesss/<access-name>.websiteaccess.yml`, one file per access record. `website-accesss` reflects the current deployed code-site folder name. |
| `table-permissions/*.tablepermission.yml` | `table-permissions/*.tablepermission.yml` using SPA/code-site field names |

The field shape can also differ. EDM records often use `adx_`-prefixed keys such as `adx_name`, `adx_value`, and `adx_entitylogicalname`; code-site metadata commonly uses normalized keys such as `name`, `value`, and `entitylogicalname`. Use existing Power Pages scripts and skills when possible so IDs, filenames, field ordering, and normalized schemas are created correctly.

Before writing metadata, save `migration-artifacts/metadata-translation-plan.md`. For each EDM aggregate record, show the source file, source record name, target `.powerpages-site` folder, target file name, action (`create`, `update`, `skip`, or `gap`), ID strategy, and confidence. Use FAQ-style EDM exports as the cautionary example: records such as `Webapi/faq_topic/enabled` and `Webapi/faq_topic/fields` live inside one `sitesetting.yml` file in EDM, but must become separate `site-settings/*.sitesetting.yml` files in the SPA metadata folder.

If a metadata item from the EDM source cannot be confidently mapped to the new SPA site, put it in `migration-gap-log.md` instead of copying it silently. Preserve the hydrated SPA baseline files created by `/deploy-site`; only add or update records that are required by the approved migration plan. Never bypass table permissions or imply that client-side role checks enforce data security.

After Phase 7.3 completes, the SPA's `.powerpages-site/` should already contain all metadata-driven authorization, server logic, web roles, and site settings the SPA code will rely on in Phases 7.4–7.6.

#### 7.4 Establish Migration Traceability

For each generated route/component/service, record its source in `migration-artifacts/migration-traceability.json`:

| Generated artifact | Derived from | Evidence | Confidence |
|--------------------|--------------|----------|------------|

Use concise comments only when they help future maintainers understand non-obvious EDM mappings.

#### 7.5 Implement Routes and Layout

Create the SPA route structure from the approved model:

- Home/root route.
- Child routes from web page hierarchy.
- Not-found/access-denied routes when present.
- Shared header/footer/navigation based on web templates, web link sets, and snippets.
- Framework-appropriate routing conventions.

#### 7.6 Implement Components, Content, and Services

Map:

- Web page copy and summaries to page components.
- Web templates to reusable layout or section components.
- Content snippets to constants or content modules.
- Web files to public assets or imported assets.
- Custom CSS to framework/project styles.

Do not leave placeholder-only pages for routes marked in scope. For manual gaps, create explicit TODO sections that explain the missing EDM behavior and link to `migration-gap-log.md`.

Wire SPA services against the metadata that Phase 7.3 already migrated:

- For tables with Web API integration, call into the services scaffolded by `/integrate-webapi` in Phase 7.3. If Phase 7.3 did not run `/integrate-webapi` (for example, because the user deferred it), create only typed stubs and mark the work as pending — do not silently invent client-side permission shortcuts.
- For server logic referenced by the plan, call into the endpoints created by `/add-server-logic` in Phase 7.3. If a `serverLogic` mapping was deferred, mark the corresponding SPA component as a manual gap rather than reimplementing the logic client-side.
- For auth and role-aware UI, use the patterns from `/setup-auth` and the roles created by `/create-webroles` in Phase 7.3. Add explicit migration notes if any auth/security work remains incomplete.

Never bypass table permissions or imply that client-side role checks enforce data security.

#### 7.7 Build and Commit Milestones

Run the project build after meaningful implementation chunks:

```bash
npm run build
```

Fix build errors before proceeding. Commit after significant milestones when working in a git repository.

### Output

- SPA scaffolded via `/create-site`.
- Initial deployment completed and `.powerpages-site/` verified.
- EDM metadata (table permissions, server logic, web roles, site settings) migrated into `.powerpages-site/` *before* SPA code wired against it.
- Routes, components, content, and services implemented per the approved plan.
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
| Migrate SPA implementation | Migrating SPA | Run `/create-site` with design choices, deploy once to hydrate `.powerpages-site`, and create routes, components, services, translated metadata, assets, and traceability artifacts |
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
