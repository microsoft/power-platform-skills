# Live Build Plan Protocol

`_build_plan.html` is the continuously refreshed execution companion for
`/create-mobile-app`. It is separate from `_plan_preview.html`: the Build Plan
shows plan, data, screens, gates, and implementation progress, while the
existing Gate 3 preview remains the materialized design-system review with at
most three representative phone frames.

## Lifecycle

Step 2c `proceed` is the only start point. Never create `_build_plan.html`, its
`.tmp/mobile-build-progress.json` source, or its server descriptor before that
answer. Immediately after app identity is initialized:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/mobile-build-plan.js" progress \
  --project-root "<working_dir>" \
  --phase requirements --status complete --detail "Brief confirmed"
node "${CLAUDE_SKILL_DIR}/../../scripts/mobile-build-plan.js" serve \
  --project-root "<working_dir>" --port 0
```

Launch `serve` as a long-running background process. Read its one JSON startup
record, retain its process/terminal handle in memory, and open `launchUrl` once.
Do not persist or repeat that token-bearing URL in `memory-bank.md`, the human
plan, logs, or chat. The mode-0600
`.tmp/mobile-build-plan-server.json` descriptor is process-local coordination,
not an approval or resume authority.

The server is bound to `127.0.0.1`, uses a random run token, enforces same-origin
edit requests, and serves only redacted summaries. Do not broaden its bind
address, proxy it, or send environment, tenant, credential, or token values to
its model API.

If a host cannot keep a local server running, use `progress` at the same
milestones. Every call refreshes a tokenless standalone `_build_plan.html`.
Continue the build; live transport is presentation, not an execution gate.

## Canonical planning inputs

The Build Plan renders canonical artifacts; it never decides persistence from
plan prose or the presence/absence of a Dataverse manifest. Its always-present
planning inputs are:

- `.tmp/product-experience-contract.json`
- `.tmp/product-scope-contract.json`
- `.tmp/navigation-manifest.json`
- `.tmp/architecture-decisions.json`
- `.tmp/persistence-contract.json`
- `.tmp/workflow-journey-contract.json`
- `.tmp/compiled-screen-build-pack.json`
- `.tmp/scenario-facts.json`
- `.tmp/data-model-usage.json`

Scenario facts are the sole concrete fixture authority for plan preview, sample
obligations, prototype repositories, and bounded screen work orders. The browser
shows only revision/binding health and record, scenario, screen-binding, media,
and invariant counts. It never exposes raw values, relationships, paths, or
media URLs and never revalidates scenario semantics itself.

The usage artifact is present in every persistence mode. The browser projects
only whether it is present and revision-bound plus compact requirement, table,
field, relationship, and consumer-link counts. It never exposes the raw usage
contract and never independently revalidates or infers its consumers; the
runtime validator remains authoritative.

`.tmp/dataverse-concepts.json`, the foreground snapshot/evidence, and
`.tmp/dataverse-schema-contract.json` exist only when the persistence mode is
`dataverse` or `mixed`. For `connector-only` or `local-prototype`, render Data
Model as `Not applicable` with the approved concept owners and do not infer
missing work.

## Milestones

Update immediately before and after the owning work. `detail` is one short,
non-sensitive fact: counts, gate number, wave number, or validator outcome.
Never include prompts, URLs, identifiers, paths, credentials, or contract
content.

| Existing work | Phase | Start | Finish |
|---|---|---|---|
| Requirements confirmed at Step 2c | `requirements` | `active` | `complete` |
| Product Experience and Product Scope | `experience` | `active` | `complete` |
| Capabilities, connectors, concept owners, compiled persistence, and conditional offline integration | `architecture` | `active` | `complete` |
| Conditional Dataverse plan-only contract | `data-model` | `active` | `complete`, or `complete` with an owner-backed not-applicable detail |
| Gate 1 or Gate 2 response | owning phase | `waiting` | `complete` or `active` for repair |
| Template preparation and initialization | `scaffold` | `active` | `complete` after scaffold TypeScript gate |
| Design materialization and Gates 3–4 | `design` | `active` or `waiting` | `complete` after Gate 4 |
| Dataverse reconciliation, writes, and services | `dataverse` | `active` | `complete`, or `complete` with a connector/local not-applicable detail |
| Layouts, shared code, and skeletons | `navigation` | `active` | `complete` after the navigation TypeScript gate |
| Canary and each screen wave | `screens` | `active` with wave/channel/count and `--screen-id <id> --screen-status building` per dispatched screen | `built` after the file passes its local check; `validated` for each screen after its wave gate; phase `complete` after all screen files pass |
| Canary, wave, and final validators | `validation` | `active` | `complete` after the final gate |

Use the same command shape for every transition:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/mobile-build-plan.js" progress \
  --project-root "<working_dir>" \
  --phase <phase> --status <pending|active|waiting|complete|warning|failed> \
  --detail "<short non-sensitive fact>"
```

For per-screen transitions, append one or more `--screen-id <id>` arguments and
one `--screen-status <planned|packed|building|built|validated>`. The renderer
overlays these statuses onto Product Scope by ID and ignores status entries for
screens not present in the canonical graph.

On a recoverable concern, use `warning`; on a hard stop, use `failed` before
reporting `BLOCKED`. A later retry returns that same phase to `active`. Update
screen progress after every channel attempt and wave validation, not only at
the end.

## Browser Data-Model Edits

The HTML never writes Dataverse and never parses HTML or Mermaid back into a
contract. Its structured editor posts one revision-bound add/update command
for a table, column, or relationship. The local bridge:

1. compares the expected Dataverse contract revision;
2. updates lookup columns and 1:N relationships as one transaction;
3. updates Product Scope only when a new table supplies explicit job and
   lifecycle mappings;
4. runs the existing schema and Product Scope validators;
5. atomically commits or restores all canonical artifacts;
6. records whether the edit is schema-only or changes Product Scope/ownership,
   then invalidates the owning approval and downstream resume checkpoints.

Every schema edit also invalidates `.tmp/data-model-usage.json`. The edit
journal snapshots that compiled artifact with the other stale Data Model
artifacts so Undo restores the exact prior file. Removal impact analysis reads
the current compiled usage when present: a table, column, or relationship with
canonical consumers is blocked and reports the affected consumer IDs. A typed
system exemption alone is not a blocker; primary-name, relationship, key, and
other existing schema safety rules still apply.

Before entering any approval, before Step 3.7, and before every mutation phase,
read `.tmp/mobile-build-plan-edits.json` when present and compare its last
`revision` with the currently validated Data Model and persistence revisions.
If it changed since the prior check:

- stop the current handoff;
- read the canonical JSON files directly, never the HTML;
- rerun Data Model, Product Scope, and persistence validation as applicable;
- repair `.tmp/data-model-usage-input.json`, recompile usage, and rerun
  `validate-data-model-usage.js --project-root "<working_dir>" --check`;
- when Product Scope, persistence, navigation, Journey, or compiled packs
  changed, repair `.tmp/scenario-facts-input.json`, recompile scenario facts,
  and rerun `validate-fixture-scenarios.js --project-root "<working_dir>" --check`;
- rerender affected human-plan sections;
- reopen Gate 2 for a schema-only change within Dataverse-owned concepts;
- reopen Gate 1, recompile persistence, and invalidate every mode-dependent
  downstream artifact when the edit adds/removes a Product Scope concept or
  changes its owner;
- update the Build Plan phase from `waiting` to `active` during repair.

A `409` means the browser submitted a stale revision and must reload. After
`.tmp/dataverse-metadata-execution-journal.json`,
`.tmp/dataverse-publish-pending.json`, or `.datamodel-manifest.json` exists, the
browser editor is locked and subsequent schema work belongs to `/edit-app`.
Never delete execution evidence to re-enable editing.

## Completion

After the final usage check and the other final validators pass, record:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/mobile-build-plan.js" progress \
  --project-root "<working_dir>" \
  --phase validation --status complete --overall-status complete \
  --detail "Build and final validation complete"
```

Then stop only the retained Build Plan server process/terminal. Its shutdown
handler rewrites a tokenless standalone `_build_plan.html` and removes the
server descriptor. Do not kill a PID discovered from an unfamiliar or stale
descriptor. The completed HTML remains in the project for inspection.