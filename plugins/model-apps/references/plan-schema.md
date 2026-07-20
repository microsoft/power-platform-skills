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
[The original user requirements passed to the planner]

## Working Directory
[Absolute path where .tsx files and RuntimeTypes.ts should be written]

## Plugin Root
[The plugin root path for reading references and samples]

## Environment
- URL: [environment URL]
- App: [app name] ([app-id]) OR "create new: [name]"
- Languages: [detected languages with LCIDs, or "English (1033) only"]
- Solution: [solution unique name — ALWAYS present, default fallback is "Default"]
- Publisher Prefix: [prefix tied to the solution's publisher — ALWAYS present, default fallback is "new"]

Both `Solution` and `Publisher Prefix` are **mandatory** in every plan. The
planner picks them by asking the user (when metadata work is needed) or by
writing the safe defaults `Solution: Default` + `Publisher Prefix: new` (when
no question is needed). They are never omitted.

Why mandatory: `pac model create --solution <name>` errors out with
`"The given solution name is not valid: ()"` when `--solution` is missing —
its documented "active solution" fallback does not work in practice. Always
writing the field eliminates a fragile conditional branch in the orchestrator.

Downstream consumers honour them:
- `genpage-entity-builder` passes `--solution <Solution>` on every script call
  so newly-created tables/columns/relationships land in that solution. It also
  uses `Publisher Prefix` to build schema names (e.g. `<prefix>_Candidate`).
- The orchestrator (skill) passes `--solution <Solution>` to `pac model create`
  when provisioning a new model-driven app.

## Pages
| Page | File | Purpose | Entities |
|------|------|---------|----------|
| [Name] | [name].tsx | [description] | [entity logical names, comma-separated, OR "mock data"] |

## Entity Creation Required
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

## Solution Packaging
[OPTIONAL section — include ONLY when packaging into a solution. Omit it entirely
to skip packaging; when absent, the orchestrator skips Phase 6.7. This section is
opt-in, unlike the always-present `## Connector Bindings` (which uses the "No
connector bindings." sentinel).]
- Package into solution: true / false (default false)
- Solution unique name: [when true — the target solution for cross-env travel]
- Connection references: [comma-separated connectionreference logical names to include, or "none"]

## Design Preferences
- Styling: [user's styling preferences — colors, theme, visual aesthetic]
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
- **Needs caching:** true / false — set true for list pages, detail pages, or any
  page where the user is likely to navigate away and return; false for forms,
  single-visit dashboards, mock-data pages. When true, the page-builder reads
  `references/data-caching.md`.
- **Key Features:** [what this specific page should do]
- **Components:** [Fluent UI V9 components to use]
- **Layout:** [responsive design approach]
- **Data Binding:** [how data flows — queryTable, retrieveRow, mock arrays]
- **Interactions:** [click handlers, drag-drop, navigation, etc.]

### [Page Name]
[Repeat the above block once per page in the Pages table]
```

---

## Section Semantics

| Section | Consumers | Rules |
|---------|-----------|-------|
| `# Genpage Plan` | N/A | Title only, no content |
| `## User Requirements` | Orchestrator — used as the `--prompt` value on the **first** `pac model genpage upload` for each new page only. Subsequent uploads (Phase 6.5 PAGEREF re-upload, Phase 7.5 fix re-deploy, edit flow) use delta prompts, NOT this field. | Verbatim user input |
| `## Working Directory` | All downstream agents | Absolute path, forward slashes on Windows |
| `## Plugin Root` | Page-builder (to Read references/samples) | Absolute path |
| `## Environment` | Orchestrator | URL, app decision, languages |
| `## Pages` | Orchestrator (page list for Phase 5 dispatch) | File names must be unique |
| `## Entity Creation Required` | Entity-builder | Exact literal "No entity creation required..." when empty, else per-entity subsections |
| `## Existing Entities` | Orchestrator (for `pac model genpage generate-types --data-sources`) | Comma-separated logical names |
| `## Connector Bindings` | Planner, page-builder, orchestrator deploy | Exact literal "No connector bindings." when empty; logical names must match Dataverse connectionreferences; tabular bindings must include discovered optional `Fields`; REST/action bindings must include discovered `Parameters` and `Response` |
| `## Solution Packaging` | Orchestrator (Phase 6.7) | Opt-in; absent = skip |
| `## Design Preferences` | Page-builder | Prose, free-form |
| `## Relevant Samples` | Page-builder (for Read path resolution) | Sample filename must match a file in `${PLUGIN_ROOT}/samples/` |
| `## Per-Page Specifications` | Page-builder | Each page gets one `### [Page Name]` subsection matching the Pages table |

---

## Validation Checklist

Before the orchestrator fans out to builders in Phase 5, it should verify:
- [ ] `## Pages` table exists and has at least one row
- [ ] Every page in `## Pages` has a unique file name
- [ ] Every page in `## Pages` has a matching `### [Page Name]` subsection in `## Per-Page Specifications`
- [ ] If `## Pages` contains Dataverse entities, `## Existing Entities` is non-empty OR `## Entity Creation Required` is non-empty
- [ ] Every non-empty `## Connector Bindings` logical name matches an existing `connectionreference` in the selected environment
- [ ] Every tabular connector binding records discovered `Fields`; generated connector row interfaces must mark every field optional
- [ ] Every REST/action connector binding records discovered `Parameters` and `Response`; generated request/response interfaces must be built from those schemas only

If validation fails, the orchestrator should surface a clear error to the user rather
than dispatching builders that will fail silently.
