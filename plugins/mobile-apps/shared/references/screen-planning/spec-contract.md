# Screen Planning Contract

Read graph fields for `phase: graph`; read spec fields only for `phase: specs` or legacy full mode. These extend the existing `## Screens` section of `native-app-plan.md`; there is no separate journey/preview sidecar.

## Graph fields

Retain the existing headings `### Navigation Pattern`, `### Screen Map`, `### Navigation Contracts`, and `### Shared Conventions`. Add `### Primary journeys` and `### Preview selection` within that section.

### Screen Map

Keep the original columns in order and append ID + Rationale:

```markdown
| Screen | Route | File | Presentation | Purpose | Data | Native | Source | ID | Rationale |
|---|---|---|---|---|---|---|---|---|---|
```

- ID is a stable kebab-case identifier, not an ordinal or generated file name. Preserve it when editing a screen; update references if a screen is intentionally retired.
- Rationale names the actor/task and why a dedicated surface is useful. A schema table existing is not a rationale.
- File is project-relative to `working_dir`; resolve it to an absolute `target_file` at dispatch. Preserve exact route/file columns used by layout generation.
- Data in graph mode can name semantic dependencies; specs resolve actual generated services. Source remains `template (keep)`, `replace template`, or `new`.
- Include retained auth routes and Profile, identifying them as platform support rather than primary business journeys. The protected layout is infrastructure, not a preview screen.
- Presentation is `default`, `modal`, or `formSheet` as supported by the router. Choose by focus, navigation, and available space, not by entity type.

#### Screen scope and consolidation

Before Gate 4a, choose the **smallest coherent screen set that preserves every approved job**.
Screen count is an output of this review, never a target derived from tables, roles, or features.
Do not default to a large graph, but do not remove necessary work to meet an arbitrary cap.

1. **Start with jobs and existing surfaces.** Reuse a suitable destination before adding one.
   A main tab represents frequent independent work, not every noun, action, or record type.
2. **Separate screens from variants.** A different organizational context, selected record, status, filter, role
   permission, loading/error/success state, or empty result normally changes the same surface.
   Parameterize detail routes by ID and shared create/edit routes by mode where their workflow fits.
   Preserve real authorization; shared UI does not grant roles the same actions.
3. **Consolidate contextual work.** Related facts and activity history can be sections of their parent;
   filters and short actions can be local sheets; status queues can be one filtered worklist.
   Keep standalone history/claims/admin routes only when the brief gives them an independent job.
   A list, detail, and editor may all remain when they serve distinct decisions or interaction needs.
4. **Justify splits in the existing Screen Map Rationale.** For similar candidates, record why a
   section, state, parameterized route, or contextual sheet cannot serve the job as well. Valid
   reasons include a long/resumable task, direct-link requirements, separate permissions/context,
   or excessive complexity if combined—not simply another entity or a desire for more screens.
   Do not replace route proliferation with an overloaded mega-screen or an unmanageable sheet.
5. **Recheck coverage after merging.** Every journey still has its entry, action, outcome,
   recovery, and return context. Specs expand only the approved graph; a necessary new route
   returns to Gate 4a with the missing job and proposed change, never grows silently during building.

In `### Navigation Pattern`, report a short derived scope summary: main destinations (a subset
of routes), unique business routes (including routed modals/sheets), local overlays/states hosted
by those routes, and retained platform routes separately. Count each route once; layouts,
redirect infrastructure, records, filters, and preview frames are not extra business screens.
Unrouted overlays belong in their host's spec, not phantom Screen Map/File rows.
State what was consolidated and why the remaining splits matter. The foreground shows this
summary at the existing graph review; no extra approval gate or count-only JSON file.

Three intent-preview screens are representative views, not the application's route budget.
Use [job-to-surface examples](journey-examples.md) only when useful; examples from shopping,
learning, review or capture workflows are alternatives, not a product architecture to copy.

### Primary journeys

```markdown
| Journey | Actor | Task | Entry | Decision | Action + operation | Committed outcome | Next destination | Recovery | Screen IDs |
|---|---|---|---|---|---|---|---|---|---|
```

One compact row per primary job, with short clauses. Journey is a stable identifier. Entry names a screen ID and its context (for example, notification with claim ID). Action + operation pairs the visible action with its approved semantic operation, resolved to a generated service before building. Screen IDs lists the ordered surfaces involved; no screen-count quota.

Committed outcome names the persisted/observable postcondition, not only a toast or route change. Next destination names a Screen Map ID or an explicit external destination and return policy. Recovery describes what is retained and where retry/resume occurs. For read-only work, state the useful read/selection outcome rather than inventing a write.

Use one coherent illustrative scenario across a journey's entry, action, result, and recovery; selected preview states should continue the same records/context. Put any needed scenario cue in these existing cells, not a new artifact or schema requirement. Screen Map and Preview selection carry the surface/selection rationales.

Supporting entities need no journeys/screens unless an actor manages them. For example: product images and categories support shopping; lesson progress supports learning; receipt attachments support expense review; checklist responses support an inspection. CRUD remains valid for real record-management jobs.

#### Domain rules and first-use review

Capture applicable rules in existing journey cells and per-screen UX/Data/Navigation fields,
not another table or sidecar:

- Keep independent business states separate. Record which states represent distinct facts and
  which transitions intentionally affect related records according to confirmed rules.
  Neither automatically couple nor artificially separate transitions merely because records relate.
- For consequential actions, state the authorized actor, preconditions, permitted transition,
  affected records, and observable postcondition. Use confirmed requirements and platform evidence;
  ask through foreground only when an unknown rule changes authorization, persistence, or outcome.
  Do not invent related-record creation, approvals, signatures or status changes from a vague label.
- First entry into a top-level destination opens the task-appropriate collection, discovery,
  reader, resume point, workspace, or justified singleton—not an arbitrary example record.
  Where applicable, define initial scope/filter and its rationale; do not add them to every screen.
- Preserve explicit user filters and scope. An applicable filter-empty screen explains the active filter and
  offers a supported way to clear/change it; do not silently switch scope or fabricate rows.
  Distinguish no records, no matching records, unauthorized access, and a failed load.
- Selected-item/deep-link entry, including an approved scan flow, opens the exact identified record
  with required parent/context.
  Invalid/missing identifiers have a recoverable destination; Back returns to the originating
  collection/filter where possible, with a safe direct-entry fallback.

These are minimum task-usability requirements, not optional visual polish. Read-only journeys
need no invented mutation, and useful repeated cards/forms remain valid.

### Preview selection

```markdown
| Screen ID | Rationale | State |
|---|---|---|
```

Reference existing Screen Map IDs; multiple states of the same ID are allowed. Select surfaces that demonstrate primary work and its result or consequential recovery. State names the specific populated, selected, blocked, success, error, or empty condition to illustrate. The rationale explains what a reviewer can judge there. This selection guides both early design validation and later previews, without pretending a static state verifies runtime behavior.
Name the initial selection/filter and selected-record context in State when applicable. A preview
may deliberately show a later or filtered state; label that variant instead of confusing it with
the app's first-entry behavior in Data/Navigation. Do not default every collection to All.
For the initial intent review, choose three representative main screens by default, fewer for a
smaller product. Details/sheets and recovery states can support those screens; do not create
filler destinations or constrain the eventual app to three screens.

Foreground `/preview-screens --mode intent` uses the plan and approved brand tokens to write `_design_preview.html`; post-build `--mode implementation` derives `preview.html` from visible screen sources/config/local components. The optional brand gallery is separate. Screen planning owns the selection, not these foreground artifacts.

### Navigation Contracts

```markdown
| Route | Path params | Query params (UNION across all senders) | Intent | Returns to caller | Source action / outcome |
|---|---|---|---|---|---|
```

Retain original columns and append Source action / outcome. Emit a row per incoming action when intent/return behavior differs; every row for a destination carries the same complete query-param union. Do not force auth redirects and ordinary tab navigation into a single ambiguous intent. See [navigation-contracts.md](navigation-contracts.md).

### Shared Conventions

Only relevant defaults: comparable row/content styles; detail treatment if needed; field order; form controls/input ergonomics; draft behavior; loading/error/empty conventions; primary/destructive action placement; density/motion/surface inheritance. Permit task-based overrides. Repetition of a useful structure is consistency, not a defect.

Do not repeat a convention in each spec. No domain decoration requirement or mandatory section/tile quota.

## Per-Screen Specs

Write `### Per-Screen Specs` with `#### <Screen name> (<route>)` entries. Use flat field bullets; inherited values are omitted. Preserve graph IDs, routes, conventions, and selection.

| Field | Contract |
|---|---|
| **Screen ID** | Exact Screen Map ID |
| **Domain layout decisions** | Name the facts/relationships needed to understand, compare, decide or act; choose their hierarchy before containers, then disclosure and composition. Use a representative scenario to assess this; no mandatory metadata fields, container types or record counts |
| **Archetype** | Nearest useful composition hint: List, Detail, Form, Auth, Tab-root, Modal-Sheet, Empty-onboarding, or a described custom composition |
| **Purpose**, **Route**, **File**, **Presentation** | Same as approved map; File resolves under working_dir |
| **Layout delta** | Screen-specific structure and primary arrangement; include the entry composition below for main destinations and selected preview screens; no repeated shared chrome |
| **UX contract** | Actor decision/read; action label/placement; confirmed domain rules, authorized transitions and prerequisites; commit operation + postcondition; visible result; next destination; failure/retry/cancel path. Keep independent states distinct |
| **Data** | Approved semantic service/schema dependencies before generation; exact generated services/methods/properties once available. Name selected fields, initial scope/filter with rationale, ordering; local/static/auth-only data is explicit |
| **Navigation** | Top-level entry behavior, scan/deep-link context, outgoing actions, preserved return scope and direct-entry fallback. Selection opens the relevant task/content, not merely a related record unless that serves the approved job |
| **Navigation intent** | `navigate`, `push`, or `replace` per outgoing action, matching Navigation Contracts |
| **State delta** | Domain empty/filter-empty, independently failing source, stale/conflict/permission/interruption states not covered by defaults; never present failed fetch as empty |
| **Key user actions** | Buttons, form submission, gestures, read/selection behavior |
| **Idempotency guards** | Navigation lock for primary navigation; submit lock and visible pending label for async writes; preserve input and remain on screen on failure |

### Entry composition within existing specs

For each main destination and selected preview screen, make **Layout delta** concrete before
rendering: `First viewport: <proposed content order and focal evidence>; Below fold:
<secondary content and how it is reached, or none>`. Mark model-suggested arrangement as
provisional until visual approval; keep explicit user presentation requirements identified
separately. This describes the initial usable screen area at the target device size, not the
surrounding review canvas.

- Name the actual approved context, facts/content, and next action or read outcome. "Clean",
  "premium", "cards", or "use hierarchy" alone are not an entry composition.
- Describe hierarchy with grouping, emphasis, typography, media purpose and action placement,
  not just colors. For recognition media describe the visible subject's emphasis, not only its
  container. A section label or inline context can be sufficient; no separate banner is required.
- Keep first-entry scope in **Data/Navigation**, illustrative state in **Preview selection**, and
  common chrome in **Shared Conventions**. Reuse those values; do not duplicate their authority.
- Let meaningful content begin in the first viewport without shrinking text or touch targets.
  Long forms, reading and larger text may scroll; do not force every action above the fold.
- No mandatory hero, grid, dashboard, palette, card count, or minimum record count. A focused
  reader can lead with retained reading context and prose; a review queue with scope and pending
  rows. Neither needs promotional content to pass.

These are additions to existing fields, not a new artifact or approval gate. Pre-design specs
describe provisional visual intent, not a frozen composition. Apply the
[behavior and presentation authority](../design-planning.md#entry-composition-and-reference-transfer):
visual authors may improve arrangement within approved behavior and explicit brand constraints;
foreground records the accepted composition at the existing design review.

**Conditional fields** — omit when not relevant:

**Pre-generation staging:** creation specs precede service generation. Record approved entity/operation/read-path needs in the existing Data and Lookup writes fields, explicitly marking generated exports/signatures/keys pending Step 10.7 verification. Expected absent files do not cause `NEEDS_CONTEXT`. Foreground resolves those fields against actual generated models/services before skeletons/builders; no unresolved identifier may reach implementation. Edits use verified existing evidence now. Missing approved schema, unsupported read/operation, or native feasibility is consequential context, not routine pending generation.

- **Row style override / Hero type override / Operational pattern / Control patterns / Calendar pattern**: optional keys from [screen-templates.md](../screen-templates.md), with a task-based reason and necessary app-specific values. Bespoke compositions do not require catalogue edits.
- **Role**: authorization/visibility constraints from actual requirements; UI hiding is not server authorization.
- **Profile content**: useful auth/app context and only genuine preferences/support information. No invented role, team, territory, or filler section quota.
- **Sign-out affordance**: Profile only; visible `Sign out`, confirmation, `useAuth().signOut`, then replace `/login`.
- **Pagination**: `cursor` for unbounded records; `none` with a defensible bound for lookups. Cursor calls specify `maxPageSize: 50`, unique-key tiebreaker in `orderBy`, `select`, `skipToken` continuation, and server-side search/filter. `top: 50` alone is not pagination.
- **Related entity fields**: every visible field sourced beyond the primary table, using the block and decision table below.
- **Lookup writes**: approved relationship/target before generation, then exact quoted `@odata.bind` key from the generated model plus entity set at Step 10.7. Never infer casing or write an annotation property. A verified unsupported write is `BLOCKED`; expected pre-generation absence follows the staging handoff above.
- **Audit**: only when required; action/event code/label/payload fields plus approved audit service contract. Do not invent inspection-specific event numbers or services.
- **Native capabilities / Artifact persistence**: approved modules/wrappers, platform/permission fallback, target, and failure states below.
- **Calendar library / JavaScript Dependencies**: compatible exact version and evidence per [javascript-dependency-planning.md](../javascript-dependency-planning.md); only when selected. No planning-time install.
- **Input ergonomics override / A11y notes / Animations / Density mode / Surface style / Refresh trigger**: exceptions to shared rules only. Respect reduced motion; standard list refresh uses `useFocusEffect`.

Do not emit `Standard Imports` or `Resolved Imports`. Do not duplicate universal accessibility/safe-area/keyboard/skeleton rules in each spec.

### Related entity read contract

```yaml
related_entity_fields:
  - field: <visible field>
    source: <primary lookup logical column → resolved column>
    cardinality: "1:1" # or "1:many" / "M:N"
    archetype_class: list # or detail / tab-root / dashboard
    recommends: formatted-lookup # or chained-fetch / external-projection-required
```

| Context | Relationship/read | recommends |
|---|---|---|
| List / tab-root / dashboard | Direct lookup's primary display name | `formatted-lookup` |
| List / tab-root / dashboard | Any other related field or per-row aggregate | `external-projection-required` |
| Detail / single-record form / modal | `1:1` or bounded `1:many` | `chained-fetch` |
| Any context | `M:N` | `external-projection-required`, unless approved generated intersect service + exact bounded query exists |

Map mixed/custom screens by access pattern: repeated collection rows follow list rules even inside a Form; a single-record detail follows detail rules. Never hide per-row fan-out behind an archetype name. Use [data-performance.md](../data-performance.md#cross-entity-reads) for complete limits. Missing supported reads are context/model handoffs, not blank fallback cells.

When identity links through `systemuser`, require `SystemusersService` and the planned profile lookup logical column. Resolve token `oid` with `SystemusersService.getAll({ filter: "azureactivedirectoryobjectid eq <oid> and isdisabled eq false", top: 2 })`; then use the exact generated profile read property. No generic `_lookup_value` placeholder or relationship traversal filter.

### Native and persistence contract

Resolve native requests against the live template/package allowlist and approved Native Capabilities. Pure-JavaScript selection follows its separate reference. `expo-haptics` is runtime-banned.

- `document-picker` = `expo-document-picker` for user-picked files; camera capture and gallery selection are different requirements. Generic attachment does not imply a camera.
- `pdf-report` = `expo-print`; add `expo-sharing` only when device sharing is required and shipped. Retention needs a verified File column or Attachment/Evidence table.
- `native-pdf-viewer` = `@microsoft/power-apps-native-pdf-viewer` 0.2.9+ for HTTPS or local `file://` input, never `content://`, `blob:`, or `http://`. Name URL/local source and invalid/viewer failure handling.
- `pen-input` = `@microsoft/power-apps-native-pen-input` only for explicit ink/signature capture, not ordinary approval. Name the Dataverse Image/File or child table target; cancellation is not an error.
- One-shot `location` = `expo-location`. Continuous/background `geolocation` = `@microsoft/power-apps-native-bglocation` (MSAL-only); verified existing Dataverse location table/field map, start/stop/status controls, permission-denied path. Never promise tracking solely from "field work".
- Relevant artifact states: `invalidUrl`, `viewerFailed`, `pdfGenerationFailed`, `uploadFailed`, `signatureCancelled`, `signatureCaptureFailed`, `nativeModuleMissing`. State whether local success differs from server persistence; a failed required upload cannot be represented as submitted.
- Offline profile configuration alone does not supply an offline runtime queue. Describe actual network failure/retry/resume behavior; do not fabricate sync counts.

## Examples on demand

Read [journey-examples.md](journey-examples.md) only if the job-to-surface decision is unclear. Examples are composition choices, not defaults or measured AI-output evaluations.
