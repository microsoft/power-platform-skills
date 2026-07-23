# Authoring Flow — the App Spec playbook (run in the main loop)

This is the **authoring playbook** the `/app-builder` skill executes **itself, in the main
conversation** — Phase 1 of `skills/app-builder/SKILL.md`. It is **not** a subagent: a
`Task` subagent is headless, so `AskUserQuestion` and plan mode would never reach the user from
inside one. Throughout this file, **"you" means the orchestrator running in the main loop**; run
every prompt yourself so each question and the plan-mode gate surface to the user.

Your job: validate the environment, authenticate with PAC CLI, detect what already exists,
build a complete App Spec through two-level interactive authoring, run the guardrail lint, get
user approval in plan mode, and write `app-spec.json` + `model-app-plan.md` so the build engine
can execute without re-asking or re-discovering.

Inputs you already have in the main loop:

- The user's requirements (`$ARGUMENTS`)
- The working directory (absolute path where artifacts should be written)
- The plugin root directory (`${PLUGIN_ROOT}`)

---

## Workflow-log requirements (applies to every step below)

As you work through the steps, append a Phase 1 section to
`<working-dir>/workflow-log.md` (create the file if it doesn't exist). The
section MUST record commands and structured calls verbatim — not just their
outcomes — because the eval harness greps the log for these tokens. Concretely:

- Every shell command invocation is recorded on its own line as
  `` `node --version` `` / `` `pac help` `` / `` `pac auth list` `` / `` `pac model list-tables --search '<term>'` ``. Include the literal flag values. Result goes on the next line.
- Every `AskUserQuestion` call is recorded as
  `AskUserQuestion: <question text> → <selected option>`. The literal string
  `AskUserQuestion` is required.
- The plan-presentation call is recorded as `EnterPlanMode called` followed
  by the user's response (`approved` / `revised`).
- The PAC CLI version output is recorded explicitly (the assertion checks
  for `>= 2.7.0`-shaped text — `PAC CLI Version 2.7.x` is the canonical
  form).

Decisions and outcomes can be summarized at the end of the section, but they
do **not** substitute for command-level entries. See an existing fixture
(`evals/model-apps/genpage/fixtures/1-account-card-gallery/workflow-log.md`)
for the expected format.

## Step 1 — Validate Prerequisites

Run these checks (first invocation per session only). Run each command separately —
do not chain with `&&`:

```powershell
node --version
```

```powershell
pac help
```

`pac help` output includes the version number. Verify the version is **>= 2.7.0**
(required for `pac model create` support). If the version is older, instruct the
user to update: `dotnet tool update --global Microsoft.PowerApps.CLI.Tool`.

If either command fails, inform the user and provide installation instructions.
Do NOT proceed until prerequisites are met.

## Step 2 — Authenticate and Select Environment

Check PAC CLI authentication:

```powershell
pac auth list
```

**If no profiles:** Ask user to authenticate:
```powershell
pac auth create --environment https://your-env.crm.dynamics.com
```
Wait for user to complete browser sign-in, then re-verify.

**If one profile:** Confirm it's active (has `*` marker). If not, activate it:
```powershell
pac auth select --index 1
```

**If multiple profiles:** Show the list, ask which environment to use via
`AskUserQuestion`, then:
```powershell
pac auth select --index <user-chosen-index>
```

After the active profile is confirmed, capture the environment URL:

```powershell
pac org who
```

Extract the `Org URL:` line (strip any trailing slash). Store this as `$ENV_URL`
for use in solution-listing and any downstream build calls.

Report: "Working with environment: [name] ([url])" and proceed.

## Step 3 — Detect What Exists

### Entity Detection

Use `pac model list-tables` to check which entities the user has mentioned or
that are implied by their requirements. Pass requested entity logical names via
`--search` (comma-separated):

```powershell
pac model list-tables --search "entity1,entity2"
```

**Important:** `--search` matches **substrings** across logical name, schema name,
and display name — so `--search "account"` also returns `accountleads`,
`accountlevelmonitoring`, etc. You **must** post-process the results and compare
the `Logical Name` column against your requested entities using **exact equality**:

- For each requested entity, look for a row where `Logical Name == <entity>`.
- If found → mark as **"exists"** (build around it).
- If not found → mark as **"needs creation"**.

Do NOT trust the raw output as "exists" just because the search returned a match —
the search is fuzzy; your check must be exact.

#### Dominant-prefix detection (for solution UX)

Also run a broader scan to detect the env's working prefix. This lets the
solution question steer the user to a consistent choice:

```powershell
pac model list-tables
```

From the full output, look at the **Custom** rows only (Type column = Custom).
Extract each logical name's prefix (everything before the first `_`). Count
prefixes excluding system ones (`msdyn`, `msdynce`, `msdynmkt`, `adx`, `msa`,
`mscrm`, `appsource`, `msft`).

- If one non-system prefix accounts for **≥50%** of custom tables AND there
  are at least 3 such tables, record this as the **detected prefix** (e.g.
  `crb2b`). Use it as the default solution suggestion below.
- Otherwise, there's no clear dominant prefix — fall back to `new` as the
  safe suggestion.

Store: `detectedPrefix`, `detectedTableCount` for use in solution selection.

### App Detection

Run:

```powershell
pac model list
```

- **0 apps:** Ask user via `AskUserQuestion`: "No model-driven apps found. Would you
  like to create a new one, or cancel?"
- **1 app:** Confirm with user: "Found app [name] ([app-id]). Use this one?"
- **N apps:** Ask user to select one or create a new one via `AskUserQuestion`.

### Solution Selection

The spec's `solution` block **always** contains both `uniqueName` and
`publisherPrefix` — never omit them. The default fallback is
`uniqueName: Default` + `publisherPrefix: new`, which works in every env.

The user-facing **question** about which solution to use is conditional:

- **Ask the question** when there is metadata work to do — any entity needs
  creating, OR a new app will be created in this run.
- **Skip the question** for reuse-only flows (existing entities + existing app).
  Write `uniqueName: Default` and `publisherPrefix: new` into the spec directly.

#### 1. List custom solutions

Query the env for non-managed solutions:

```bash
node "${PLUGIN_ROOT}/scripts/dataverse-request.js" "$ENV_URL" GET \
  "solutions?\$select=uniquename,friendlyname&\$expand=publisherid(\$select=customizationprefix)&\$filter=ismanaged eq false and uniquename ne 'Default' and uniquename ne 'Active' and isvisible eq true&\$top=10"
```

Parse the JSON; capture each `uniquename`, `friendlyname`, and
`publisherid.customizationprefix`.

#### 2. Ask the user

Use `AskUserQuestion`. Order options so the **matching-prefix** choice is first
(recommended) and the **conflict** choices are visibly flagged.

**Recommended-first ordering rule:**

1. If there's a `detectedPrefix` AND at least one existing custom solution uses
   that prefix → put that solution first, labelled "matches your existing custom tables".
2. If there's a `detectedPrefix` but no existing solution uses it → put
   "Create new solution under publisher `<detectedPrefix>`" first.
3. Then any other existing custom solutions.
4. Then "Create a new solution under Default Publisher (prefix: new)".
5. Then "Use Default Solution (prefix: new)" — annotate with ⚠ if
   `detectedPrefix` exists and is not `new`.

**Example with `detectedPrefix = crb2b`:**

> "Your env has 12 existing custom tables using prefix `crb2b`. Where should
> the new tables / app go?
>
> - **Continue in 'Crdec34' (prefix: crb2b)** — matches existing work [RECOMMENDED]
> - **Create new 'model-app-<name>' solution under crb2b publisher**
> - **Use existing 'LandscapeBusiness' (prefix: lndscp)**
> - **Use Default Solution (prefix: new)** ⚠ different prefix from existing work"

**Example when no `detectedPrefix`:**

> "Which solution should the new tables / app go in?
>
> - **Create new 'model-app-<name>' solution (prefix: new)** [RECOMMENDED]
> - **Use Default Solution (prefix: new)**"

#### 3. Act on the answer

Just **record** `uniqueName` + `publisherPrefix` in the spec's `solution` block — **do not
create the solution (or the publisher) here.** The build creates it idempotently via the SDK
(`createSolution`) on apply, resolving/creating the publisher and reusing an existing solution
of the same name. Specifics:

- **Existing solution** → use it directly; capture its prefix from the query above.
- **Create new under publisher `<prefix>`** → record `uniqueName` + `publisherPrefix`; the
  build resolves the publisher (or creates `<prefix>publisher`) and the solution.
- **Default Solution** → `uniqueName: Default`, `publisherPrefix: new`.

If the chosen prefix differs from `detectedPrefix`, log a one-line warning to
the user before continuing:

> "Heads up — env has `<detectedPrefix>_*` tables but you chose `<chosenPrefix>`.
> New tables won't match the prefix of your existing work."

## Step 4 — Multi-Turn, Two-Level Interactive Authoring

This is the core of `model-app-planner` — the step that distinguishes it from
`genpage-planner`. Rather than drafting the entire App Spec in one shot, you
author it **one topic at a time** through conversational turns, persisting the
working spec to `<working-dir>/app-spec.json` after each round so the user can
hand-edit between turns.

**Do not present the entire spec at once.** Level (a) must be agreed before
Level (b) begins.

> **Read the spec format once, up front** — don't reverse-engineer it from scripts:
> [`references/app-spec-schema.md`](./app-spec-schema.md) (every field) and the worked sample
> [`samples/app-spec.support-desk.json`](../samples/app-spec.support-desk.json). Author to that
> shape. **Do not pre-create tables/columns/solution** during authoring — the build is
> idempotent and creates only what's missing.

### Level (a) — Data model

Propose the `entities` block (including `columns` and `primaryAttribute`) and
the `relationships` block. Present your proposal clearly, then use
`AskUserQuestion` to confirm or refine:

> "Here's the data model I'd suggest for your [app name]. Does this look right,
> or would you like to adjust any tables, columns, or relationships before we
> move on to forms and views?"

Column `type` is one of: `Text · Memo · Choice · MultiChoice · Boolean · Money · DateTime ·
Integer · BigInt · Decimal · Double · File · Image · AutoNumber · Customer`. A `Choice`/`MultiChoice`
column needs `options[]` **or** a `globalChoice` reference. Lookups are **not** a column type —
declare a `OneToMany` relationship instead.

> **Author from [`references/app-spec-schema.md`](./app-spec-schema.md) — it is the single source.**
> Its **modeling cheatsheet** answers the recurring questions without reading the SDK/lint/engine:
> auto-number identity → `autoNumberFormat` on `primaryAttribute`; **N:N with attributes** (e.g.
> Technician↔Work-Order with a Role) → a **junction entity** + two `OneToMany` (sample rows bind
> both via `$parents`); "my/this-week/not-Completed" views → view `filters[]`; records pre-set to a
> custom status → `statusReason` on sample rows. The builder does all of this in one pass — never
> hand-author post-build association/status/FetchXML scripts.

When the user has entities that already exist (detected in Step 3), propose
columns that complement rather than duplicate what's already there. Build
*around* existing tables.

#### Table icons (assign one per custom table — default)

**By default, give every _custom_ table you create a meaningful table icon** so the app nav shows a
recognizable glyph instead of the generic Dataverse table cube. This is the default authoring
behavior — only skip it if the user declines. (A model-driven app's nav icon for an `entity`
subarea comes from the **table's own icon**, not the sitemap subarea — a subarea `vectorIcon` is
ignored for entity subareas.)

Author it entirely inside the App Spec (so the app stays self-contained on export/import):

1. Add an **SVG web resource** to `webResources[]` (`"type": "svg"`) carrying the icon markup, named
   `<publisherPrefix>_<tablelogical>_icon` (e.g. `new_project_icon`).
2. Point the table at it with `entities[].vectorIcon: "<that web resource name>"` (→ Dataverse
   `IconVectorName`). The build creates the web resource, publishes it, then sets the table icon.

Pick a glyph that matches the table's concept (a briefcase for Projects, a clipboard/checklist for
Work Items, a person for Team Members, a calendar for Sprints, a document for Contracts, etc.) and
emit **clean, original, single-color SVG** — do **not** paste a third-party icon file. Author it
like a Fluent V9 glyph:

- `viewBox="0 0 24 24"` (or `0 0 32 32`), no fixed `width`/`height`.
- One or two `<path>` elements, `fill="currentColor"` (Dataverse tints it) — simple, legible at 16px.
- Keep it geometric and minimal; avoid gradients, embedded rasters, or `<script>`.

```json
"webResources": [
  { "name": "new_project_icon", "type": "svg",
    "content": "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><path fill='currentColor' d='M9 4h6a2 2 0 0 1 2 2v1h3a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h3V6a2 2 0 0 1 2-2Zm0 3h6V6H9v1Z'/></svg>" }
],
"entities": [
  { "schemaName": "new_project", "displayName": "Project", "vectorIcon": "new_project_icon",
    "primaryAttribute": { "schemaName": "new_name", "displayName": "Name" }, "columns": [ ... ] }
]
```

Standard/reused tables (Account, Contact, systemuser, …) already ship an icon — leave them alone.
See [`references/app-spec-schema.md`](./app-spec-schema.md) → `entities[].vectorIcon` and
`webResources[]`.

Persist the agreed data model to `<working-dir>/app-spec.json`, then run an **early data-model lint**
on it before proceeding to Level (b) — this catches structural data-model errors (e.g. the
relationship-name-vs-lookup-name collision Dataverse rejects) **before** the user authors forms/views
on top of a broken model, the most expensive point to unwind:

```bash
node -e "const{lintAppSpec}=require('${PLUGIN_ROOT}/scripts/lib/spec-lint.js');const s=require('<abs-path-to-app-spec.json>');const r=lintAppSpec(s);console.log(JSON.stringify(r,null,2));"
```

On a data-model-only spec the linter surfaces **only** data-model findings (the forms/views/app checks
are no-ops until those sections exist), so treat any `errors[]` here as a **hard gate**: fix the data
model and re-run before moving to Level (b). Warnings teach — surface and proceed. (The full lint at
Step 5 re-checks the complete spec once artifacts are added.)

### Level (b) — Artifacts and sample data

Once the data model is confirmed, propose all of the following **together** in a
single turn (they are closely related — the user should see charts and sample
data alongside the forms they reference):

#### Forms

Propose one `main` form per entity. Default `"layout": "auto"`. For any entity
that is on the **referenced** (parent) side of a OneToMany relationship, declare
a `subgrids` entry that shows the child records inline:

```json
{
  "entity": "new_customer",
  "type": "main",
  "name": "Customer",
  "layout": "auto",
  "subgrids": [
    { "childEntity": "new_ticket", "view": "Active Tickets", "label": "Related Tickets" }
  ]
}
```

**Show the form wireframe.** After writing the proposed forms to `app-spec.json`, render an
ASCII wireframe so the user can *see* each form's tabs, sections, fields, the Notes block, and
sub-grids before approving — then ask for changes:

```bash
node "${PLUGIN_ROOT}/scripts/preview-form.js" --spec @<working-dir>/app-spec.json [--entity <schemaName>]
```

Include the wireframe in the same turn as the forms/views/charts proposal (it's the visual
companion to the JSON). Iterate on the spec and re-render until the user is happy with the layout.

#### Form JS (optional — client-side logic)

When the user wants validation or dynamic behaviour (e.g. "warn when priority is
High", "default the due date"), propose a `webResources[]` script and wire it onto
the form with `events[]`. Keep the JS small and real (no placeholders); name the
script with the solution prefix and a `.js` extension:

```json
"webResources": [
  { "name": "new_ticket.js", "displayName": "Ticket Scripts", "type": "js",
    "content": "var Ticket={onLoad:function(ctx){},onPriority:function(ctx){}};" }
],
"forms": [
  { "entity": "new_ticket", "type": "main", "name": "Ticket", "layout": "auto",
    "events": [
      { "event": "onload", "library": "new_ticket.js", "function": "Ticket.onLoad" },
      { "event": "onchange", "attribute": "new_priority", "library": "new_ticket.js", "function": "Ticket.onPriority" }
    ] }
]
```

`event` is `onload`/`onsave`/`onchange` (`onchange` needs an `attribute`); `library`
must reference a declared `webResources[]` name (lint-enforced). Only propose form JS
when the user asks for behaviour the data model can't express — don't add it by default.

#### Views

Propose one active-records view per entity. Include the primary attribute plus
the 2–4 most useful columns for quick scanning. Set `"activeOnly": true` and
provide a sensible `sort`.

#### Charts

Auto-suggest **one chart per Choice column on the primary entity**, alternating
`Pie` / `Column` chart types:

- First Choice column → `"chartType": "Pie"`
- Second Choice column → `"chartType": "Column"`
- Third → `"Pie"`, and so on.

Always set `"measure": "count"`.

Entities with no Choice columns get no chart suggestion (but the user may add one).

**A chart's `groupBy` MUST be a Choice column.** The build validator
(`validateAppSpec`) rejects a chart that groups by a non-Choice column — the lint
gate only *warns*, so this would otherwise surface as a confusing build failure
*after* approval. Never propose (or accept) a chart over a Text/DateTime/Number
column; steer the user to a Choice column instead.

#### Sample data

Suggest a `sampleData` block **right alongside** the forms/views/charts. Populate
it with realistic, domain-appropriate records — not "Test Record 1". Include:

- 3–5 parent records per top-level entity.
- 2–4 child records per parent, using `$parent` to express the relationship:
  ```json
  {
    "new_name": "Cannot log in to portal",
    "new_priority": "High",
    "$parent": { "entity": "new_customer", "match": { "new_name": "Northwind Traders" } }
  }
  ```
- Choice values must be label strings (matching the `options[]` you defined),
  not integer codes.

Present Level (b) as a proposal, then use `AskUserQuestion` to let the user edit
or remove any section (forms, views, charts, sample data):

> "Here are the proposed forms, views, charts, and sample data for your app. Feel
> free to edit any section — or tell me what to change — before I lock the spec."

#### App shell

Also propose the `appShell` block — the sitemap areas, groups, and subAreas that
wire each entity into the app's navigation. Keep it simple: one area, one group,
one subArea per entity.

#### Shippable-defaults note

Mention, but do **not** author or build: security roles, quick-create forms, and
standard system views (All Records, Lookup, etc.) are sensible future additions
but are out of scope for this authoring phase.

Persist the fully agreed spec to `<working-dir>/app-spec.json` before Step 5.

## Step 5 — Guardrail Lint (Hard Gate Before Plan Mode)

Before entering plan mode, run the **full** lint on the complete agreed spec (this re-checks the whole
spec — the data model was already gated by the early lint at the end of Level (a), so here you are
validating the artifacts/sample-data/app layered on top):

```bash
node -e "const{lintAppSpec}=require('${PLUGIN_ROOT}/scripts/lib/spec-lint.js');const s=require('<abs-path-to-app-spec.json>');const r=lintAppSpec(s);console.log(JSON.stringify(r,null,2));"
```

Replace `<abs-path-to-app-spec.json>` with the actual absolute path to
`<working-dir>/app-spec.json`. Use `require()` with an absolute path so Node
resolves it regardless of cwd.

**Interpret the result:**

- `ok: true`, no errors → proceed to Step 6.
- **Warnings** (`warnings[]` non-empty, `ok: true`) → surface each warning to
  the user with a short explanation of what it means and why it's a consideration
  (e.g., "A Choice column with more than 12 options may be better modelled as a
  lookup table"). Allow the user to acknowledge and proceed, or loop back to Step 4
  to fix.
- **Errors** (`errors[]` non-empty, `ok: false`) → do NOT proceed to Step 6.
  Surface each error clearly, explain the root cause (e.g., "The relationship
  schema name collides with the lookup attribute name — Dataverse rejects this
  combination"), and loop back to Step 4 to fix the spec. Re-run the lint after
  each fix cycle until `ok: true`.

Common errors the lint catches (teach these to the user if they arise):
- **Duplicate entity schemaName** — two entities with the same schemaName.
- **Missing primaryAttribute** — every entity needs a `primaryAttribute` with
  both `schemaName` and `displayName`.
- **Choice column missing `options[]`** — a `type: "Choice"` column must have a
  non-empty `options` array.
- **Relationship-name collision** — the relationship's auto-derived schema name
  equals the lookup attribute's schemaName; use a distinct name for the relationship.
- **Subgrid with no matching relationship** — a form subgrid references a child
  entity that has no OneToMany relationship pointing to the form's entity.
- **Chart on unknown entity or column** — the chart's `entity` or `groupBy`
  doesn't match what's in the spec.

## Step 6 — Plan-Mode Approval

Create tasks via `TaskCreate`:

1. "Build data model (entities, columns, relationships)"
2. "Author artifacts and sample data (forms, views, charts)"
3. "Write app-spec.json and model-app-plan.md"

Enter plan mode (`EnterPlanMode`) and present a rendered summary. **Resolve and
display full prefixed names** for the user (e.g., `crb2b_customer.crb2b_segment`)
even though the underlying spec stores the schemaName as provided:

```
## Model-App Plan

### App
- Name: [app name]
- Description: [description]
- Action: [Create new | Use existing: <app-id>]

### Solution
- [solution uniqueName] — Publisher prefix: [prefix]

### Data Model
#### Tables
| Table | Status | Columns |
|-------|--------|---------|
| [schemaName] | Create / Reuse | [col1 (Type), col2 (Type), ...] |

#### Relationships
| Type | Parent | Child | Lookup Column |
|------|--------|-------|---------------|
| OneToMany | [referenced] | [referencing] | [lookup.schemaName] |

### Artifacts
- Forms: [N forms — list entity names]
- Views: [N views — list entity names]
- Charts: [N charts — list names and chart types]
- App shell: [N areas / N subAreas]

### Sample Data
- [entity]: [N records]
- [child entity]: [N records] (linked via $parent)

### Lint
- [✓ No errors | ⚠ N warning(s) acknowledged: <list>]

### Notes
- Security roles, quick-create forms, and standard system views are
  out of scope for this phase and can be added later.
```

**Include the engine's real build plan (this is the SINGLE build approval).** Before `ExitPlanMode`,
run the build **dry-run** (no `--apply`) and show its phase-grouped plan beneath the summary above:

```bash
node "${PLUGIN_ROOT}/scripts/build-model-app.js" --env <envUrl> --spec @<working-dir>/app-spec.json
```

This reflects the idempotent detect-existing logic (what will be **created** vs **skipped**), so the
user approves the plan the engine will *actually* run — not a hand-rendered approximation. On
`ExitPlanMode` approval, **Phase 2 applies directly** — do **not** take a second dry-run + go-ahead in
Phase 2 (that redundant double-gate is removed; plan mode is the one build approval).

Then call `ExitPlanMode` to request user approval.

- If **approved**: proceed to Step 7.
- If **changes requested**: revise the relevant section (loop back to Step 4 if
  the spec needs editing, re-run lint, then re-enter plan mode).

Mark the "Build data model" and "Author artifacts and sample data" tasks complete
after approval.

## Step 7 — Write Artifacts and Return

### Write app-spec.json

Write the final, lint-clean spec to `<working-dir>/app-spec.json`. This is the
**machine contract** consumed by the downstream build step — do not abbreviate or
omit any section.

The spec shape follows `plugins/model-apps/samples/app-spec.support-desk.json`:

```
{
  "solution": { "uniqueName": "...", "displayName": "...", "publisherPrefix": "..." },
  "app": { "name": "...", "description": "..." },
  "entities": [ { "schemaName", "displayName", "pluralName", "primaryAttribute", "columns" } ],
  "relationships": [ { "type", "referenced", "referencing", "lookup" } ],
  "forms": [ { "entity", "type", "name", "layout", "subgrids?" } ],
  "views": [ { "entity", "type", "name", "columns", "sort", "activeOnly" } ],
  "charts": [ { "entity", "name", "groupBy", "measure", "chartType" } ],
  "appShell": { "areas": [ { "label", "groups": [ { "label", "subAreas": [...] } ] } ] },
  "sampleData": { "<entitySchemaName>": [ { ...fields, "$parent"?: {...} } ] }
}
```

### Write model-app-plan.md

Write a short human-readable summary to `<working-dir>/model-app-plan.md`. This
is for the user's reference — it does not need to be machine-parseable. Include:

- **App:** name, description, action (create / reuse)
- **Environment:** env URL, solution, prefix
- **Tables:** create vs reuse list with column counts
- **Relationships:** list
- **Artifacts:** form/view/chart counts
- **Sample data:** record counts per entity
- **Lint status:** clean / warnings acknowledged
- **Next step:** "Run the app-builder build step to apply this spec."

### Complete the workflow log

Append a summary entry to `<working-dir>/workflow-log.md`:

```
Phase 1 complete.
Spec written: <working-dir>/app-spec.json
Lint: ok=true, errors=0, warnings=N
Plan approved: yes
```

### Hand off to the build phase

You are still in the main loop — proceed directly to **Phase 2 (Build)** of `SKILL.md` using the
`app-spec.json` and env URL you just produced. First, recap a concise summary to the user:

```
Planning complete.

App: [name]
Environment: [env URL]
Solution: [uniqueName] / prefix: [prefix]

Tables to create: [list, or "none — all entities reuse existing tables"]
Tables to reuse: [list, or "none"]
Relationships: [N]
Forms: [N] | Views: [N] | Charts: [N]
Sample data: [yes — N total records | no]
Lint: [clean | N warning(s) acknowledged]

Spec: <working-dir>/app-spec.json
Plan: <working-dir>/model-app-plan.md
```

Mark the "Write app-spec.json and model-app-plan.md" task complete.

## Critical Constraints (Phase 1 — authoring only)

- **Do NOT write to Dataverse during authoring.** Table/column/relationship creation and
  record insertion happen in **Phase 2 (Build)**, driven by the `cds-maker-sdk` build engine —
  not here. Authoring only reads (`pac` discovery) and writes local files.
- **Do NOT hand-write metadata XML or solution ZIP files.** The build engine
  (`build-model-app.js` → `lib/sdk-build.js`) produces all FormXml/FetchXml/sitemap and Web API
  writes via the SDK.
- **Generative pages ARE authored here** for overview/dashboard surfaces (the genpage-first policy):
  propose a `pages[]` entry and author its `.tsx` `codeFile` following the generative-page code rules in
  [`rules.md`](rules.md); the build's `pages` phase uploads each page. (A **standalone** page that is not
  part of an app is the separate `/genpage` skill.)
- **Interaction points are limited to:**
  1. Step 2 — environment selection (if multiple auth profiles).
  2. Step 3 — app selection and solution selection.
  3. Step 4 — two-level authoring turns (data model confirmation, then
     artifacts + sample data confirmation). These are the only turns where
     the spec is shaped.
  4. Step 5 — lint-warning acknowledgement (if warnings present).
  5. Step 6 — plan-mode gate (`EnterPlanMode` / `ExitPlanMode`).
- **No other interaction points.** Do not ask questions outside these steps.
- **Loop back correctly:** On plan revision, return to Step 4 (re-author),
  re-run lint (Step 5), then re-enter plan mode (Step 6). Do not skip the
  lint on re-entry.
