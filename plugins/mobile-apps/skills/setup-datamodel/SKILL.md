---
name: setup-datamodel
description: Use when the user wants to design or redesign the Dataverse schema and connector plan for an existing mobile app, or has an ER diagram (image, Mermaid, or text) to apply. Skip when the user is creating a brand-new app — /create-mobile-app handles the data model inline.
user-invocable: true
allowed-tools: Read, Edit, Write, Grep, Glob, Bash, AskUserQuestion, EnterPlanMode, ExitPlanMode, Task, Skill
model: opus
---

**📋 Shared instructions: [shared-instructions.md](${CLAUDE_SKILL_DIR}/../../shared/shared-instructions.md)** — read first.

# Set Up Data Model + Connectors

Combined orchestrator for standalone data source planning. Designs the Dataverse schema, plans connectors, gets approval on both, then delegates execution to `/add-dataverse` and `/add-connector`.

| Use this skill when | Use `/add-dataverse` directly when |
|---|---|
| Standalone schema + connector design (project may or may not exist yet) | The plan already exists and you just need to apply tables + generate services |
| You have an existing ER diagram (image / Mermaid / text) to import | `/create-mobile-app` is invoking this as a sub-step with `--skip-planning` |
| Re-planning the schema or connectors mid-project | You only need to add a single table or a single connector |

## Workflow

1. Verify project & auth → 2. Design data model → 3. Plan connectors → 4. Combined approval → 5. Execute data model → 6. Execute connectors → 7. Summary

---

### Phase 1 — Verify Project & Auth

Confirm we're inside a Power Apps mobile app:

```bash
test -f power.config.json && echo "OK" || echo "ERROR: not a mobile app — run /create-mobile-app first"
node "${CLAUDE_SKILL_DIR}/../../scripts/resolve-environment.js" "$(node -e \"console.log(require('./power.config.json').environmentId)\")"
```

Capture the **environment URL**, **environment ID**, **tenant ID**, and **organization ID** for Phase 5.

### Phase 2 — Design Data Model

Check `$ARGUMENTS` for diagram hints first (`*.png`, `*.jpg`, `erDiagram` keyword, `||--o{` cardinality syntax). If a hint is present → Path A. If `$ARGUMENTS` describes the app at all → silently take Path B (architect propose). Only if both are empty, ask:

> "How would you like to define the data model?"

| Option | What happens |
|---|---|
| Upload an existing ER diagram | Provide a PNG/JPG path, Mermaid block, or text description |
| Let the Data Model Architect propose one (default) | Spawns `data-model-architect` agent to infer from requirements |
| Skip — no Dataverse tables needed | Jump to Phase 3 |

Default the answer to "architect propose" so an empty answer auto-proceeds without blocking the user.

#### Artifact storage rules for PDFs and signatures

When requirements mention signatures, sign-off, ink, drawings, generated PDFs, exported reports, evidence packets, or retained documents, make the storage target explicit in `## Data Model` before approval:

| User signal | Dataverse model implication |
|---|---|
| "capture signature", "sign off", "approval signature", "ink" | Image column on the signed record for one current signature, or child Evidence/Signature table for multiple captures/history |
| "generate PDF", "export report", "evidence packet", "certificate PDF" | Ask whether the generated PDF should be retained. If yes, use a Dataverse File column, usually on the parent record or a child Evidence/Attachment table. If no, document on-device/share-only behavior and add no column. |
| "upload PDF", "attach file", "import document" | File column or child Attachment table with lookup to parent |
| "view PDF" | Store or reference an HTTPS URL only if the app has a durable source. Native PDF viewer does not support local `file://`, `content://`, or `blob:` URIs. |

PDF content must never be modeled as long text/base64 text. Use Dataverse File columns for retained PDFs. Signature PNGs may use Image columns when the generated service supports image payloads; use File columns or child Evidence rows when the capture should behave like an attachment.

#### Path A — Parse user-provided diagram

Accept PNG/JPG (use `Read` to view), Mermaid syntax (paste in chat), or text description. Parse into tables + columns + relationships. Query existing Dataverse tables to mark each as new / extend / reuse. Generate a Mermaid ER diagram for confirmation. Enter `EnterPlanMode` for data model approval. On `ExitPlanMode` approval, write the data model into `native-app-plan.md` `## Data Model` section (creating the file if absent).

#### Path B — Spawn data-model-architect

```
Task: mobile-app:data-model-architect

Prompt:
  You are the data-model-architect agent for a Power Apps mobile app.
  Requirements: <$ARGUMENTS or ask the user what the app does>
  Working directory: <cwd>
  Plugin root: ${CLAUDE_SKILL_DIR}/../../

  Follow your agent file. Return a ## Data Model section with Mermaid ER diagram,
  reuse/extend/create table, and dependency-tier ordering. If requirements mention
  signatures, pen/ink, generated PDFs, report exports, evidence packets, or uploaded
  documents, include the artifact storage target: on-device/share-only, Dataverse
  Image column, Dataverse File column, or child Evidence/Attachment table. Retained
  PDF content must use a File column, not long text/base64.
```

Present the returned section via `EnterPlanMode` / `ExitPlanMode` for approval.

#### Path C — No Dataverse

Write `## Data Model` as "None — no Dataverse tables needed." Continue to Phase 3.

### Phase 3 — Plan Connectors

Follow [`shared/references/connector-planning.md`](${CLAUDE_SKILL_DIR}/../../shared/references/connector-planning.md):

1. **Infer** — if `$ARGUMENTS` describes what the app does, scan for connector keywords. Build a candidate list.
2. **Confirm** — present via `AskUserQuestion`. Let the user add, remove, or confirm.
3. **Record** — build the `## Connectors` section.

If the user provided no requirements context, ask:

> "What does your app need to connect to? (e.g. SharePoint, Teams, email, Excel, OneDrive, Azure DevOps — or none)"

### Phase 4 — Combined Approval

Present the full plan — data model + connectors — together in a single `EnterPlanMode` block:

```
## Plan: Data Sources

### Data Model
[reuse/extend/create table]
[Mermaid ER diagram]
[creation order tiers]

### Connectors
[connector table or "None"]

Approve both to proceed with execution?
```

- **Approved** → proceed to Phase 5
- **Change data model** → loop back to Phase 2 for that section only, then re-present Phase 4
- **Change connectors** → loop back to Phase 3, then re-present Phase 4

### Phase 5 — Execute Data Model

Invoke `/add-dataverse` with `--skip-planning` so it reads the approved plan directly without re-prompting:

```
Invoke skill: /add-dataverse

Arguments:
  --working-dir <cwd>
  --plan-section native-app-plan.md#data-model
  --skip-planning
```

`/add-dataverse` creates tables in tier order, runs `npx power-apps add-data-source --api-id dataverse --org-url <envUrl> --resource-name <name>` per table from the app root, publishes customizations, writes `.datamodel-manifest.json`, and type-checks. Wait for it to return before Phase 6.

**Calculated columns from the screen plan** — if `## Data Model` in the plan includes a `### Cross-entity Reads (auto-derived from screen plan)` subsection (the `data-model-architect`'s Step 6a addendum, approved at the Gate 1 addendum during planning), `/add-dataverse` Step 5c creates each row as a calculated column on the parent table via `scripts/create-calculated-column.js`. No additional action needed in this skill — `/add-dataverse` handles it. If the subsection is absent, Step 5c is silently skipped. See [`shared/references/data-performance.md` § Cross-entity Reads](${PLUGIN_ROOT}/shared/references/data-performance.md#cross-entity-reads) for why this matters.

Skip if Phase 2 chose Path C (no Dataverse).

### Phase 6 — Execute Connectors

Read `## Connectors` from `native-app-plan.md`. For each connector row, invoke `/add-connector`:

```
Invoke skill: /add-connector

Arguments:
  --working-dir <cwd>
  --connector <api-name>
```

Run sequentially. Skip if `## Connectors` is "None".

### Phase 6.5 — Offline profile reconciliation

If Phase 5 created or extended Dataverse tables, an existing Mobile Offline Profile may now be missing those tables/columns. Because Phase 5 invoked `/add-dataverse` with `--skip-planning` (which suppresses that skill's own Step 8.5 reconciliation), this orchestrator owns the check. Skip when Phase 2 chose Path C (no Dataverse).

Run the local, no-network delta check:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/offline-profile-delta.js"
```

Branch on the JSON `status` per [offline-profile-reconciliation.md](${CLAUDE_SKILL_DIR}/../../shared/references/offline-profile-reconciliation.md): `no-manifest` / `no-profile` / `in-sync` → continue to Phase 7 silently (do not nag when no profile exists); `delta` → prompt to update, then invoke `/add-table-to-offline-profile` (for `missingTables[]`) and `/edit-offline-profile --table <t> --columns add:<newColumns>` (for `tablesWithNewColumns[]`), and re-check to `in-sync`.

### Phase 7 — Summary

```
✅ Data sources set up
─────────────────────────────────────────────
Data model:
  Tables reused  : <list>
  Tables extended: <list>
  Tables created : <list>
  Manifest       : .datamodel-manifest.json

Connectors:
  <list of added connectors, or "None">

Generated services:
  src/generated/services/ × <N>
  src/generated/models/   × <N>

Type-check: PASS

Next steps:
  /add-datasource   — add more data sources
  /add-native       — add device capabilities
  screen-builder    — implement screens using the generated services
─────────────────────────────────────────────
```

## Reference

- [shared/references/connector-planning.md](${CLAUDE_SKILL_DIR}/../../shared/references/connector-planning.md) — connector inference + confirmation logic
- [shared/references/offline-profile-reconciliation.md](${CLAUDE_SKILL_DIR}/../../shared/references/offline-profile-reconciliation.md) — Phase 6.5 offline delta check + reconciliation flow
- [skills/add-dataverse/SKILL.md](../add-dataverse/SKILL.md) — full data model execution workflow
- [agents/data-model-architect.md](../../agents/data-model-architect.md) — read-only architect agent
