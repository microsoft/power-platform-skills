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

All sections must appear in this exact order with these exact headings:

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

## Pages
| Page | File | Purpose | Entities |
|------|------|---------|----------|
| [Name] | [name].tsx | [description] | [entity logical names, comma-separated, OR "mock data"] |

## Entity Creation Required
[If NO entities need creating, the value is exactly:]
No entity creation required — all entities already exist.

[If entities need creating, use this structure per entity:]

### [Entity logical name]
- Display Name: [display name]
- Columns:
  | Logical Name | Type | Required | Notes |
  |-------------|------|----------|-------|
  | [name] | string / int / decimal / datetime / bool / choice | yes / no | [notes] |
- Choice Columns:
  | Column | Options |
  |--------|---------|
  | [column logical name] | value1 (100000000), value2 (100000001), ... |
- Relationships:
  | Type | Related Entity | Lookup Field | Cascade |
  |------|---------------|-------------|---------|
  | 1:N lookup / N:N | [entity logical name] | [lookup field logical name] | [cascade config] |

## Existing Entities
[Comma-separated list of entity logical names that already exist in the environment
 and will be used for RuntimeTypes generation.
 Example: "account, contact, task"
 OR "None" if all data is mock or all entities need creating.]

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
  `references/data-caching-pattern.md`.
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
| `## User Requirements` | Page-builder (for `--prompt` deploy flag context) | Verbatim user input |
| `## Working Directory` | All downstream agents | Absolute path, forward slashes on Windows |
| `## Plugin Root` | Page-builder (to Read references/samples) | Absolute path |
| `## Environment` | Orchestrator | URL, app decision, languages |
| `## Pages` | Orchestrator (page list for Phase 5 dispatch) | File names must be unique |
| `## Entity Creation Required` | Entity-builder | Exact literal "No entity creation required..." when empty, else per-entity subsections |
| `## Existing Entities` | Orchestrator (for `pac model genpage generate-types --data-sources`) | Comma-separated logical names |
| `## Design Preferences` | Page-builder | Prose, free-form |
| `## Relevant Samples` | Page-builder (for Read path resolution) | Sample filename must match a file in `${CLAUDE_PLUGIN_ROOT}/samples/` |
| `## Per-Page Specifications` | Page-builder | Each page gets one `### [Page Name]` subsection matching the Pages table |

---

## Validation Checklist

Before the orchestrator fans out to builders in Phase 5, it should verify:
- [ ] `## Pages` table exists and has at least one row
- [ ] Every page in `## Pages` has a unique file name
- [ ] Every page in `## Pages` has a matching `### [Page Name]` subsection in `## Per-Page Specifications`
- [ ] If `## Pages` contains Dataverse entities, `## Existing Entities` is non-empty OR `## Entity Creation Required` is non-empty

If validation fails, the orchestrator should surface a clear error to the user rather
than dispatching builders that will fail silently.
