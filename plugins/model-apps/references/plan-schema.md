# Genpage Plan Document Schema

This file defines the structure of `genpage-plan.md` — the single source of truth
that coordinates work between the `/genpage` orchestrator skill and the three
specialist agents (`genpage-planner`, `genpage-entity-builder`, `genpage-page-builder`).

**Who writes it:** `genpage-planner` (Step 6)
**Who reads it:**
- `genpage-entity-builder` reads `## Entity Creation Required` to know what to build
- `genpage-page-builder` reads `## Per-Page Specifications` to know what code to generate
- `/genpage` orchestrator reads `## Environment`, `## Pages`, `## Existing Entities` for Phases 3-6

**Stability contract:** Section headings are NOT prose — they are a machine-readable contract.
Changing a heading name breaks downstream agents. Add new sections only.

---

## Required Structure

All required sections must appear in this exact order with these exact headings.
Optional sections marked opt-in may be omitted; if present, keep them in the
same relative position so downstream parsers can find them predictably:

```markdown
# Genpage Plan

## User Requirements
[The original user requirements passed to the planner — verbatim, never rewritten]

## Assumptions
[Every newly authored standalone `/genpage` create plan writes this section. Exactly:]
No assumptions.

[or one entry per decision the planner made that the request did not state — relationships, target or
roll-up scope, server or client filters, default sort, paging limits, initial-read caching, material page
behaviour (not every CSS token):]

### A1 — [short title]
- Decision: [what the plan does]
- Alternatives considered: [the other candidates]
- Evidence: [metadata: … | sample: … | default: …]
- Resolution: [user-confirmed | planner-default | unattended-default]
- Question: [the question's id — user-confirmed and unattended-default only]
- Answer: [the actual answer — user-confirmed and unattended-default only]
- Default record: [unattended-default only — the exact line logged in workflow-log.md:
  Unattended default: A1 / <question id> → <answer> (<reason>)]

## Working Directory
[Absolute path where .tsx files and RuntimeTypes.ts should be written]

## Plugin Root
[The plugin root path for reading references and samples]

## Environment
- URL: [environment URL]
- App: [app name] ([app-id]) OR "create new: [name]"
- Mode: app-builder    ← **only** when the plan was projected from an App Spec by
  `scripts/write-page-plan.js`; omitted for a planner-authored (standalone `/genpage`) plan
- Languages: [each detected language with its LCID and code, marked `— RTL` when `scripts/list-languages.js`
  reports `rtl: true` for it — e.g. "English (1033, en-US); Arabic (Saudi Arabia) (1025,
  ar-SA) — RTL" — or "English (1033) only". A language the script could not name keeps its number and is written
  "<LCID> (no culture code)" with no mark. The page builder takes text direction from that mark.]
- Solution: [solution unique name — ALWAYS present, default fallback is "Default"]
- Publisher Prefix: [prefix tied to the solution's publisher — ALWAYS present, default fallback is "new"]

`Mode` selects the **page identity rule** the page-builder uses for `PAGEREF_` tokens, so it is
not cosmetic:
- `Mode: app-builder` → the token is the page's **`Key`** (see `## Pages` below). A page pulled
  from a deployed app keeps its real storage path (`pages/<guid>/page.tsx`), so its file stem is
  meaningless as an identity.
- `Mode` absent → there are no App Spec keys and no `Key` column, so the token is the target's
  file name without `.tsx`.

Both `Solution` and `Publisher Prefix` are **mandatory** in every plan. The
planner picks them by asking the user (when metadata work is needed) or by
writing the safe defaults `Solution: Default` + `Publisher Prefix: new` (when
no question is needed). They are never omitted.

Why mandatory: `apps.js create --solution <name>` takes the solution the new app, its
sitemap and its pages are added to, and has no "active solution" fallback — a missing `--solution` is a usage
error. Always writing the field eliminates a fragile conditional branch in the orchestrator.

Downstream consumers honour them:
- `genpage-entity-builder` passes `--solution <Solution>` on every script call
  so newly-created tables/columns/relationships land in that solution. It also
  uses `Publisher Prefix` to build schema names (e.g. `<prefix>_Candidate`).
- The orchestrator (skill) passes `--solution <Solution>` to `apps.js create`
  when provisioning a new model-driven app, and to every `genpage-upload.js`
  create, so each page this run makes joins that solution too (a page joins no
  solution on its own, and the app's add never brings the pages it shows).

## Pages
| Page | File | Purpose | Entities |
|------|------|---------|----------|
| [Name] | [name].tsx | [description] | [entity logical names, comma-separated, OR "mock data"] |

In an `app-builder` plan the table carries an extra **`Key`** column between `Page` and `File`, and
each Per-Page Specification repeats it as `- **Key:** <key>`:

| Page | Key | File | Purpose | Entities |
|------|-----|------|---------|----------|
| [Name] | [stable key] | [file path] | [description] | [entity logical names OR "mock data"] |

## Entity Creation Required
The entity-builder provisions this entire section in one pass via `scripts/provision-entities.js` (SDK-backed, idempotent); the section contract (suffix-only names) is unchanged.

[If NO entities need creating, the value is exactly:]
No entity creation required — all entities already exist.

[If entities need creating, use this structure per entity. **Names in this section
are SUFFIXES ONLY — they must NOT contain a publisher prefix.** The prefix is
recorded once in `## Environment` → `Publisher Prefix:` and downstream agents
construct the full logical name as `${prefix}_${suffix}` at runtime. This is the
plan's only source of truth for the prefix.]

### [Table suffix]
[The full logical name is constructed by the entity-builder as
`${prefix}_${tableSuffix}` (lowercase). Display this resolved name to the user
in plan-mode preview, but write only the suffix here. Suffix must match
`^[a-z][a-z0-9]+$` — lowercase letters and digits only.]

- Display Name: [display name]
- Display Plural: [display collection name]
- Primary Name Suffix: [primary column suffix, default: "name"]
- Columns:
  | Suffix | Type | Required | Notes |
  |--------|------|----------|-------|
  | [column suffix] | string / int / decimal / money / memo / datetime / boolean / picklist | yes / no | [notes] |
- Choice Columns:
  | Column Suffix | Options |
  |---------------|---------|
  | [column suffix] | value1 (100000000), value2 (100000001), ... |
- Relationships:
  | Type | Related Table | Lookup Suffix | Cascade |
  |------|---------------|---------------|---------|
  | 1:N lookup / N:N | [related table suffix] | [lookup field suffix, 1:N only] | [cascade config] |

**No name in this section may contain an underscore or any prefix.** Plan-write
validation rejects values that look like `crb2b_playername` or even
`new_playername` — the section stores `playername`, period.

## Existing Entities
[Comma-separated list of entity logical names that already exist in the environment
 and will be used for RuntimeTypes generation.
 Example: "account, contact, task"
 OR "None" if all data is mock or all entities need creating.]

## Connector Bindings
[If NO connectors are used, the value is exactly:]
No connector bindings.

[Else, one row per binding. `Fields` is required for tabular connectors and
records the authoring-time connector column/schema discovery used by the
page-builder. `Parameters` and `Response` are required for REST/action
connectors. All connector fields are treated as OPTIONAL in generated TSX
because connector rows and responses are dynamically typed and may omit values
at runtime.]
| Logical Name | Connector Id | Dataset | Tables (GUIDs) | Table Display Names | Operations | Fields | Parameters | Response |
|--------------|--------------|---------|----------------|---------------------|------------|--------|------------|----------|
| new_uxtest_sharepoint | /providers/Microsoft.PowerApps/apis/shared_sharepointonline | https://.../sites/foo | 5709dd6f-... | Pet | | PetName (string), OwnerName (string), PetType ({Value:string}), Created (datetime) | | |
| new_uxtest_msnweather | /providers/Microsoft.PowerApps/apis/shared_msnweather | | | | CurrentWeather | | Location (required), units (optional) | temperature (number), conditions (string), humidity (number) |

## Custom API Bindings
[If NO Custom APIs are used, the value is exactly:]
No custom API bindings.

[Else, one row per bound Custom API. `Kind` is Action (may mutate; called with
executeAction) or Function (read-only; called with executeFunction). `Bound Entity` is the
table logical name for an entity-bound API, or `(Global)` for an unbound one. `Parameters`
lists each request parameter as `name: Kind` using the declared Dataverse parameter kind.
All values are discovered by genpage-customapi-builder via list-custom-apis.js — never
fabricated. Persisted (via `genpage-upload.js --actions`) into config.json's `actionBindings`.]
| Name | Kind | Bound Entity | Display Name | Parameters (name: kind) |
|------|------|--------------|--------------|-------------------------|
| new_ApproveOrder | Action | salesorder | Approve Order | Comment: String, Amount: Decimal |
| new_GetOrderSummary | Function | (Global) | Get Order Summary | OrderId: Guid |

## Dataverse Operations
[OPTIONAL section — present ONLY when this run's genpage-customapi-builder added or replaced a
built-in Dataverse operation (WhoAmI, RetrieveVersion; see references/dataverse-operations.md).
Absent means no new built-in operation. When present it is either exactly:]
No Dataverse operations.

[or the builder's `dataverse-operations.md` body, copied verbatim: the verification line, then one
row per selected operation in catalogue order, every cell the catalogue's own. `Invoke` is always
`button`. These rows are never Custom APIs and never go into `## Custom API Bindings`.]
Verification: environment not-checked, runtime not-checked, privileges not-checked.
| Name | Kind | Bound Entity | Display Name | Parameters | Response fields | Invoke |
|------|------|--------------|--------------|------------|-----------------|--------|
| WhoAmI | Function | (Global) | Current Dataverse identity | (none) | BusinessUnitId, UserId, OrganizationId | button |

## Solution Packaging
[OPTIONAL section — include ONLY when packaging into a solution. Omit it entirely
to skip packaging; when absent, the orchestrator skips Phase 6.7. This section is
opt-in, unlike the always-present `## Connector Bindings` (which uses the "No
connector bindings." sentinel).]
- Package into solution: true / false (default false)
- Solution unique name: [when true — the target solution for cross-env travel]
- Connection references: [comma-separated connectionreference logical names to include, or "none"]

## Design Preferences
- Styling: [EITHER `Maker-requested: <the look as concrete values — each color as a hex value with
  its role (primary, accent, background, text), the font family with a fallback, corner radius,
  density, borders and shadows, and the component treatments> (from: screenshot | website <url> |
  description)` when the maker asked for a look of their own — a screenshot or mockup, a website to
  match, or a description; OR the model-driven defaults (`Fluent UI V9 defaults`, plus any
  preference that does not replace that look) when they did not]
- Features: [specific features mentioned — search, filtering, sorting, navigation, etc.]
- Accessibility: [any specific accessibility requirements beyond WCAG AA defaults]

## Relevant Samples
| Page | Sample | Reason |
|------|--------|--------|
| [Page Name] | [N-sample-name.tsx] | [why this sample is relevant to the page type] |

## Per-Page Specifications

### [Page Name]
- **File:** [name].tsx
- **Purpose:** [one-line description]
- **Entities:** [comma-separated logical names OR "mock data"]
- **Needs caching:** true / false — set true for any page that **fetches data on
  mount** through a real host read (Dataverse `dataApi` calls or connector calls
  such as `queryConnectorTable` / `executeConnectorOperation`), regardless of
  Data mode. Set false only for pages that render inline mock arrays or forms
  with no initial fetch. When true, the page-builder reads
  `references/data-caching.md`.
- **Key Features:** [what this specific page should do]
- **Components:** [Fluent UI V9 components to use]
- **Layout:** [responsive design approach]
- **Data Binding:** [how data flows — queryTable, retrieveRow, mock arrays]
- **Interactions:** [click handlers, drag-drop, navigation, etc.]

#### Data semantics
[Every relationship and every server-side or client-side filter this page uses — the internal source-row
and target-resolution filters included. Exactly `None.` when the page has none:]

##### R1
- Kind: relationship
- Definition: [source column, target scope, predicate and value source, null and roll-up behaviour]
- Source: [A1 — the assumption that settled it]

##### F1
- Kind: filter
- Definition: [what rows the filter keeps]
- Source: User Requirements
- Requirement quote: [the words of ## User Requirements that state it]

#### Lookup metadata
[Every lookup a join, a filter, a target-dependent navigation or a write uses, single-target ones included.
Exactly `None.` when the page uses none:]

| Table | Column | Read property | Targets | Used by | Metadata state |
|-------|--------|---------------|---------|---------|----------------|
| [source table] | [lookup column] | _[column]_value | [the COMPLETE target set] | [decision ids; purposes] | [observed / planned] |

| Table | Column | Target | Navigation property | Referenced key |
|-------|--------|--------|---------------------|----------------|
| [source table] | [lookup column] | [target] | [concrete navigation property] | [target key] |

- Evidence: [lookup-metadata.json; successful source/target metadata discovery — or "planned: <table> is created in Phase 2"]
- Read target strategy: normalize the logical-name annotation and qualified prefix; use the metadata-backed
  fallback only for a bare id with missing target evidence.

### [Page Name]
[Repeat the above block once per page in the Pages table]
```

---

## Assumptions, data semantics and lookup metadata

A plan states what the maker asked for in `## User Requirements` — kept **byte for byte** as the original
request, never rewritten — and everything the planner decided on its own in `## Assumptions`, so the approval
gate shows which details are guesses. A later clarification answer is recorded in an assumption, not added to
the requirements (or to the first upload's prompt).

**`## Assumptions` entries** (`### A<n> — <title>`):

- Ids are unique `A1`, `A2`, … — stable across revisions, not necessarily contiguous.
- `Decision`, `Alternatives considered`, `Evidence` and `Resolution` are required, each once and non-empty.
  `Evidence` starts with `metadata:`, `sample:` or `default:`. A sample proves an observed shape, not the
  intended business scope or a lookup's complete target set.
- `Resolution` is `user-confirmed` (the maker answered: `Question` and the actual `Answer` are required),
  `planner-default` (no question was asked, so neither appears) or `unattended-default` (an unattended run
  took the option the planner marked as the default: `Question`, `Answer` and `Default record` are required).
  An automatic pick is never `user-confirmed`.
- `Default record` is the exact line the run logged: `Unattended default: <assumption id> / <question id> →
  <answer> (<reason>)` — the answer word for word, a reason that never contains the word "approved" (that word
  belongs to the separate plan-approval record).
- A question still waiting for its answer is a pending interaction, not an assumption: an entry is written
  only after the answer returns.
- A value may continue on indented lines. Values are compared after line endings, continuation whitespace and
  Unicode normalization; case and wording are substantive. Any other line, field or nested heading is refused.

**`#### Data semantics`** (inside each `### <Page Name>`, after its bullet fields): entries are `##### R<n>`
(`Kind: relationship`) and `##### F<n>` (`Kind: filter`) — level five, never level three, which would read as
another page. `Definition` records the source column, the target scope, the predicate and value source, and
material null or roll-up behaviour. `Source` is one assumption id or exactly `User Requirements`; the latter
also needs a `Requirement quote` that the original requirements contain (whitespace aside). A decision that
is only partly stated cites its assumption rather than the user's broad phrase. The page's `Data Binding` and
`Interactions` refer to these ids and add no unrecorded predicate.

**`#### Lookup metadata`**: one row per lookup a join, a filter, a target-dependent navigation or a write
uses — single-target lookups included. `Targets` is the lookup's **complete** set from metadata, never the
subset a page shows; `Read property` is `_<column>_value`; `Used by` names decision ids and declared purposes
(customer navigation, customer picker). The path table lists only **concrete** paths read from metadata
(`scripts/get-lookup-metadata.js`): a shared path such as Owner's `ownerid` is never a target discriminator,
and no path is invented. Write exactly `None.` when the page uses no lookup.

**Planned and observed.** A lookup on a table this run creates is recorded `planned`, with no paths. After
Phase 2 the orchestrator reads its metadata (`get-lookup-metadata.js`, saved as `lookup-metadata.json`) and
re-invokes the planner, which may only promote a matching record to `observed` and add its measured paths —
never change its column, target set, uses, a decision or an assumption. A difference needs new approval.

**The approval preview** carries the same records at its own levels: `### Assumptions` **first** (entries
`#### A<n> — <title>`, or `No assumptions.`), then `### Pages (N total)`, then `### Data Semantics` and
`### Lookup Metadata`, each grouped under `#### <page file>` (records, or `None.`), then the existing Data
Strategy, App, Solution, Localization and Design sections. `scripts/genpage-plan-provenance.js verify`
compares the two documents' records field by field (never a whole-document hash): a written plan whose
assumptions, decisions or lookup records differ from the approved ones — or that has the contract where the
preview has none, or the reverse — fails even when its page files match. `--require-assumptions` requires the
whole contract of a newly authored plan; `--lookup-metadata <file>` checks every observed lookup against the
saved metadata read (and lets a planned one be promoted); `--require-observed-lookups` refuses a lookup still
planned before generation.

An older plan without these sections is **not recorded**, not "everything was stated": it stays valid. A
present section that is malformed fails whatever the plan's `Mode` — an App Spec projection included.

---

## Section Semantics

| Section | Consumers | Rules |
|---------|-----------|-------|
| `# Genpage Plan` | N/A | Title only, no content |
| `## User Requirements` | Orchestrator — used as the `--prompt` value on the **first** `genpage-upload.js` upload (the create) for each new page only. Subsequent uploads (Phase 6.5 PAGEREF re-upload, Phase 7.5 fix re-deploy, edit flow) use delta prompts, NOT this field. | Verbatim user input — never rewritten; later answers go to `## Assumptions` |
| `## Assumptions` | Orchestrator (approval, shown first), page-builder, provenance verify | Optional on read; written by every new standalone create plan: entries or exactly "No assumptions." (see above) |
| `## Working Directory` | All downstream agents | Absolute path, forward slashes on Windows |
| `## Plugin Root` | Page-builder (to Read references/samples) | Absolute path |
| `## Environment` | Orchestrator | URL, app decision, languages |
| `## Pages` | Orchestrator (page list for Phase 5 dispatch) | File names must be unique, and use only letters, digits, `.`, `-` and `_` (kebab-case, e.g. `project-overview.tsx`). Exactly one Pages table with a File column: `check-page-files.js` refuses a plan with a second, one quoted in `## User Requirements` included |
| `## Entity Creation Required` | Entity-builder | Exact literal "No entity creation required..." when empty, else per-entity subsections |
| `## Existing Entities` | Orchestrator (for `genpage.js types --data-sources`) | Comma-separated logical names |
| `## Connector Bindings` | Planner, page-builder, orchestrator deploy | Exact literal "No connector bindings." when empty; logical names must match Dataverse connectionreferences; tabular bindings must include discovered optional `Fields`; REST/action bindings must include discovered `Parameters` and `Response` |
| `## Custom API Bindings` | Planner, page-builder, orchestrator deploy | Exact literal "No custom API bindings." when empty; names must match existing Dataverse Custom APIs (`customapi.uniquename`); entity-bound rows carry the bound table (else `(Global)`); every row carries its discovered `Parameters` kinds |
| `## Dataverse Operations` | Planner, page-builder, orchestrator deploy (Phase 4.6b) | Optional; absent = no new built-in operation. Exact literal "No Dataverse operations." or the builder's table under its not-checked verification line; only `WhoAmI` / `RetrieveVersion`, catalogue cells, `Invoke` = `button` |
| `## Solution Packaging` | Orchestrator (Phase 6.7) | Opt-in; absent = skip |
| `## Design Preferences` | Page-builder | Prose, free-form; a `Styling:` line that starts with `Maker-requested:` wins over the default look (`references/rules.md` → *Maker-requested styling*) |
| `## Relevant Samples` | Page-builder (for Read path resolution) | Sample filename must match a file in `${PLUGIN_ROOT}/samples/` |
| `## Per-Page Specifications` | Page-builder | Each page gets one `### [Page Name]` subsection matching the Pages table; a new plan also gives each its `#### Data semantics` and `#### Lookup metadata` (entries or exactly "None.") |

---

## Validation Checklist

Before the orchestrator fans out to builders in Phase 5, it should verify:
- [ ] `## Pages` table exists and has at least one row
- [ ] Every page in `## Pages` has a unique file name
- [ ] Every page in `## Pages` has a matching `### [Page Name]` subsection in `## Per-Page Specifications`
- [ ] If `## Pages` contains Dataverse entities, `## Existing Entities` is non-empty OR `## Entity Creation Required` is non-empty
- [ ] Every non-empty `## Connector Bindings` logical name matches an existing `connectionreference` in the selected environment
- [ ] Every non-empty `## Custom API Bindings` name matches an existing `customapi` (uniquename) in the selected environment; entity-bound rows carry the bound table and every row its parameter kinds
- [ ] A `## Dataverse Operations` section, when present, is the exact sentinel or the built-in table (WhoAmI / RetrieveVersion only); its names are never checked against `customapi`
- [ ] Every tabular connector binding records discovered `Fields`; generated connector row interfaces must mark every field optional
- [ ] Every REST/action connector binding records discovered `Parameters` and `Response`; generated request/response interfaces must be built from those schemas only
- [ ] Every relationship and every server-side or client-side filter used in `## Per-Page Specifications` traces to the user's stated text in `## User Requirements` or a named `## Assumptions` entry. The builder introduces no unrecorded business predicate, relationship or roll-up.
  Validation proves structure, ID resolution, quote presence and agreement with approved structured decisions. It does not prove natural-language entailment, judge materiality, or discover arbitrary contradictory prose. Those remain planner/reviewer responsibilities, supplemented by scenario-specific code checks.
- [ ] Every lookup a page record uses names its complete metadata target set, and is `observed` before generation (`genpage-plan-provenance.js verify --require-observed-lookups --lookup-metadata <working-dir>/lookup-metadata.json`)

If validation fails, the orchestrator should surface a clear error to the user rather
than dispatching builders that will fail silently.
