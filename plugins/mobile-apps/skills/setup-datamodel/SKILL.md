---
name: setup-datamodel
description: Use when the user wants to design or redesign the Dataverse schema and connector plan for an existing mobile app, or has an ER diagram (image, Mermaid, or text) to apply. Skip when the user is creating a brand-new app — /create-mobile-app handles the data model inline.
user-invocable: true
allowed-tools: Read, Edit, Write, Grep, Glob, Bash, AskUserQuestion, EnterPlanMode, ExitPlanMode, Skill
model: opus
---

**📋 Shared instructions: [shared-instructions-core.md](${CLAUDE_SKILL_DIR}/../../shared/shared-instructions-core.md)** — read first.

# Set Up Data Model + Connectors

Combined orchestrator for standalone data source planning. Designs the Dataverse schema, plans connectors, gets approval on both, then delegates execution to `/add-dataverse` and `/add-connector`.

`--plan-only` is the foreground planning API used by `/create-mobile-app` and
`/edit-app`. It writes `_dm_section.md` and, when Dataverse is required,
`.tmp/dataverse-schema-contract.json`; validates both against supplied snapshot
evidence; and returns without approval or mutation. The calling foreground skill
owns the combined plan approval.

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

Check `$ARGUMENTS` for diagram hints first (`*.png`, `*.jpg`, `erDiagram` keyword, `||--o{` cardinality syntax). If a hint is present, use Path A. If `$ARGUMENTS` describes the app at all, silently take Path B (foreground proposal). Only if both are empty, ask:

> "How would you like to define the data model?"

| Option | What happens |
|---|---|
| Upload an existing ER diagram | Provide a PNG/JPG path, Mermaid block, or text description |
| Propose one from the requirements (default) | The foreground reconciles requirements with verified Dataverse evidence |
| Skip — no Dataverse tables needed | Jump to Phase 3 |

Default the answer to "propose from requirements" so an empty answer auto-proceeds without blocking the user.

#### Artifact storage rules for PDFs and signatures

When requirements mention signatures, sign-off, ink, drawings, generated PDFs, exported reports, evidence packets, or retained documents, make the storage target explicit in `## Data Model` before approval:

| User signal | Dataverse model implication |
|---|---|
| "capture signature", "sign off", "approval signature", "ink" | Image column on the signed record for one current signature, or child Evidence/Signature table for multiple captures/history |
| "generate PDF", "export report", "evidence packet", "certificate PDF" | Ask whether the generated PDF should be retained. If yes, use a Dataverse File column, usually on the parent record or a child Evidence/Attachment table. If no, document on-device/share-only behavior and add no column. |
| "upload PDF", "attach file", "import document" | File column or child Attachment table with lookup to parent |
| "view PDF" | Store or reference an HTTPS URL if the app has a durable source. Native PDF viewer 0.2.9+ also supports local `file://` URIs; `content://`, `blob:`, and `http://` remain unsupported. |

PDF content must never be modeled as long text/base64 text. Use Dataverse File columns for retained PDFs. Signature PNGs may use Image columns when the generated service supports image payloads; use File columns or child Evidence rows when the capture should behave like an attachment.

#### Path A — Parse user-provided diagram

Accept PNG/JPG (use `Read` to view), Mermaid syntax (paste in chat), or text description. Parse into tables + columns + relationships. Query existing Dataverse tables to mark each as new / extend / reuse. Generate a Mermaid ER diagram for confirmation. Enter `EnterPlanMode` for data model approval. On `ExitPlanMode` approval, write the data model into `native-app-plan.md` `## Data Model` section (creating the file if absent).

#### Path B — Foreground data-model proposal

The foreground owns the proposal. Read the requirements, approved Product Scope
when supplied, publisher prefix, compact planning evidence, and full snapshot
only through deterministic validators. Build one canonical in-memory model and
derive both `_dm_section.md` and `.tmp/dataverse-schema-contract.json` from it.

Apply these decision rules:

- `Reuse`: verified existing table/column satisfies the job without mutation.
- `Extend`: verified customizable table fits and needs additive compatible
  columns or relationships only.
- `Create`: app-owned lifecycle with a collision-checked proposed name.
- `Adapt`: an incompatible name collision requires a checked alternate name.
- `Defer`: explicit functionality is outside this approved release, with a
  visible reason.
- Never replace a column in place to change its type.

Every persistent concept has exactly one owner: Dataverse, a confirmed
connector, local configuration, or transient UI state. Do not duplicate a
connector-owned system of record in Dataverse without an approved projection and
sync/staleness boundary. A table needs `Service required: yes` whenever a screen,
lookup, hook, or identity flow reads it, including `systemuser` resolution.

New tables require independent lifecycle, ownership/security, repeated child
rows, independent reporting, offline boundary, audit/history, or many-to-many
needs. A UI noun alone is not a table. Respect the Product Scope table review
budget without dropping explicit functionality.

Retained photos/signatures use Image or File ownership as appropriate; retained
PDFs use File, never long text/base64. Barcode identity may justify an alternate
key. Retained location needs explicit schema fields. Offline schema is added only
when the approved operating context selects offline.

The Markdown section includes target reconciliation, evidence, decisions,
Mermaid ER diagram, dependency tiers, service-required tables, cross-entity read
paths, risks, and scope boundaries. The structured contract is the executable
authority and must distinguish verified existing identities from proposed ones.
Normalize it with `build-dataverse-operation-manifest.js --normalize-contract`,
then validate it against the full supplied snapshot with
`validate-dataverse-planning-decisions.js`. Missing full metadata for
Reuse/Extend/Adapt is `NEEDS_CONTEXT`, never a guessed decision.

In normal standalone mode, present the resulting section through the existing
approval flow. In `--plan-only`, return the two validated artifact paths and any
bounded concern to the calling foreground skill without asking a question.

#### Path C — No Dataverse

Write `## Data Model` as "None — no Dataverse tables needed." Continue to Phase 3.

### Phase 3 — Plan Connectors

Follow [`shared/references/connector-planning.md`](${CLAUDE_SKILL_DIR}/../../shared/references/connector-planning.md):

1. **Infer** — if `$ARGUMENTS` describes what the app does, scan for connector keywords. Build a candidate list.
2. **Confirm** — present via `AskUserQuestion`. Let the user add, remove, or confirm.
3. **Record** — build the `## Connectors` section.

In `--plan-only`, infer and record connector candidates from already confirmed
requirements without another prompt. Mark any unresolved connector choice as a
visible pending approval for the calling foreground skill.

If the user provided no requirements context, ask:

> "What does your app need to connect to? (e.g. SharePoint, Teams, email, Excel, OneDrive, Azure DevOps — or none)"

### Phase 4 — Combined Approval

Skip this phase in `--plan-only`.

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

Skip Phases 5-7 in `--plan-only`.

Invoke `/add-dataverse` with `--skip-planning` so it reads the approved plan directly without re-prompting:

```
Invoke skill: /add-dataverse

Arguments:
  --working-dir <cwd>
  --plan-section native-app-plan.md#data-model
  --skip-planning
```

`/add-dataverse` creates tables in tier order, runs `npx power-apps add-data-source --api-id dataverse --org-url <envUrl> --resource-name <name>` per table from the app root, publishes customizations, writes `.datamodel-manifest.json`, and type-checks. Wait for it to return before Phase 6.

**Cross-entity reads from the screen plan** — the approved
`### Cross-entity Reads` subsection contains formatted lookups, bounded chained
fetches, or `external-projection-required` blockers. `/add-dataverse` never
synthesizes calculated/formula definitions through code. A user-supplied,
maker-created computed column is validated as an existing dependency during
reconciliation before it can be reused.

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

Branch on the JSON `status` per [offline-profile-reconciliation.md](${CLAUDE_SKILL_DIR}/../../shared/references/offline-profile-reconciliation.md): `no-manifest` / `no-profile` / `in-sync` → continue to Phase 7 silently (do not nag when no profile exists); `delta` → prompt to update, then read and execute `${CLAUDE_SKILL_DIR}/../add-table-to-offline-profile/SKILL.md` for `missingTables[]` and `${CLAUDE_SKILL_DIR}/../edit-offline-profile/SKILL.md` for `tablesWithNewColumns[]`, passing the arguments documented by each workflow, and re-check to `in-sync`.

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
- `build-dataverse-operation-manifest.js` — structured contract normalization
- `validate-dataverse-planning-decisions.js` — snapshot-bound decision validation
