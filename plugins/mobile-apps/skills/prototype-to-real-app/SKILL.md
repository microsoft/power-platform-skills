---
name: prototype-to-real-app
description: Explicitly connect an existing local mobile prototype to approved Dataverse tables using bounded discovery, reviewed logical mappings, official generated services, and a recoverable connected candidate. Does not deploy or import demo data by default.
user-invocable: true
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, AskUserQuestion, Task
model: opus
---

# Connect a prototype to real Dataverse data

Read [shared core](${PLUGIN_ROOT}/shared/shared-instructions-core.md),
[CLI guidance](${PLUGIN_ROOT}/shared/shared-instructions-cli.md), and
[Dataverse contracts](${PLUGIN_ROOT}/skills/add-dataverse/references/dataverse-reference.md).
In Player mode also read and obey
[the shared authoring transport](${PLUGIN_ROOT}/shared/references/mobile-authoring.md).
This skill owns conversion, not a second app creation or design workflow.

## Non-negotiable boundaries

- Conversion is an explicit maker operation. A prototype finish, edit, or teach
  request never implicitly selects an environment or provisions tables.
- Keep stable screens/routes, logical entity/field/choice/action IDs, design,
  canonical fixtures, and taught rules. A necessary product behavior change
  requires its own reviewed proposal, not an adapter-side approximation.
- Use an isolated candidate workspace and exclusive project mutation
  ownership before source changes. Player uses the bridge-owned lease;
  ordinary CLI conversion keeps the last-good source and owns its foreground
  Apply/recovery sequence without calling the Player-only edit wrapper.
  The approved local app stays available until the connected candidate is
  explicitly Applied and verified.
- Reuse the current foreground bounded snapshot/evidence/proposal/compiler
  pipeline and the tool-free return-only `mobile-app:data-model-architect`.
  Never introduce another planner, a name-matching table chooser, or an agent
  with Dataverse mutation tools. The one-screen builder is used only for an
  explicitly approved affected screen, not a wholesale UI rewrite.
- All environment/model/mapping/remote-write and Apply decisions retain their
  logical gates. In Player use `request-question --input <bounded-json>` with
  gate/source bindings and verify the exact decision receipt. Ordinary CLI
  uses normal foreground questions. Runner tokens never enter prompts/source.
- No sample-record or media import by default. `dataImport: "none"` is enforced
  by the conversion journal. Separate migration needs its own approved ID map,
  dependency ordering, idempotency/upload journal, and validation; do not turn
  fixture rows into real business records as part of this operation.
- `src/generated/**` and `power.config.json` are official-tool-owned. Generate
  only app-owned adapters under `src/data`. Never manufacture service exports,
  fake schemas, a success-shaped fallback, or a production auth bypass.

## 1. Preflight and durable conversion state

Read `.tmp/prototype-profile.json`, domain/bindings/rules, the app-owned registry,
Product Experience/Scope, persistence, Journey, usage, canonical facts,
screen packs, and the current source-bound authoring context. Verify the active
app identity and expected revision before staging. A stale target is rejected,
not overwritten. A pending edit/teach operation must finish or be explicitly
discarded first.

Begin only in the isolated candidate workspace: held by the bridge lease in
Player, or under the ordinary conversion foreground's exclusive ownership:

```bash
node "${PLUGIN_ROOT}/scripts/prototype-conversion.js" begin \
  --project-root "<candidate_root>"
node "${PLUGIN_ROOT}/scripts/prototype-conversion.js" status \
  --project-root "<candidate_root>"
```

`begin` uses the shared `authoring-source.captureSource` implementation. The
journal records the base/domain/rule revisions and starts with
`activeProfile: "prototype"`. It is coordination metadata, not an independent
persistence authority. Do not delete it or its remote journal to make retry
look fresh.
An existing journal resumes only against the same bound origin, domain,
bindings, and fixture records/media. Source/profile failure does not authorize
discarding that evidence or starting a fresh-looking remote run.

## 2. Explicit environment and successor ownership approval

Ask the maker to select/confirm the real environment and explain that local
Undo cannot roll back Dataverse metadata or data writes. Only after the explicit
environment decision, use the existing resolver/CLI auth flow:

```bash
node "${PLUGIN_ROOT}/scripts/resolve-environment.js" "<approved-environment-id>"
```

Verify returned environment ID/URL/tenant; keep tokens out of files.
In Player, the resolver uses the trusted desktop broker and its reusable
`dataverse-discovery` approval, bound to `.tmp/dataverse-discovery-target.json`.
Do not run raw `npx` initialization, acquire a token in the runner, copy a
credential file, or add another login flow. Missing desktop sign-in is an
explicit block with the existing desktop login guidance; credentials are
never collected in Player chat. Defer official initialization to Step 4,
after the exact schema/operation manifest is approved.

**Ordinary CLI only:** if no populated official `power.config.json` exists, run the unchanged official
`npx power-apps init -t MobileApp --display-name "<name>"
--environment-id "<approved-environment-id>" --non-interactive` once in the
candidate. Never initialize over a different populated environment.
Configure the real registration using create Phase 7's existing auth path.
Skipping auth leaves a clearly blocked connected-runtime validation, not a
switch to local fallback.

Present which existing logical concepts will be Dataverse-owned and which
remain local, transient, or owned by a connector. Update only that approved
successor architecture/persistence revision and corresponding Product Scope
realizations. Preserve non-Dataverse owners and their adapters. Recompile
persistence and navigation, then obtain Gate 1 through the shared approval
owner. No snapshot or publisher lookup happens before this decision.
If no Dataverse concept is selected or everything is deferred, leave the
prototype local; do not label a no-table adapter as a completed conversion.

## 3. Current bounded model planning, not a parallel reconciler

Read and execute the **Dataverse/mixed branch** of
[create Phase 3, Step 3.3](${PLUGIN_ROOT}/skills/create-mobile-app/references/phase-3-planning.md).
Use the current concept projection, publisher detection, bounded foreground
snapshot, compact evidence packet, return-only proposal envelope, deterministic
`compile-dataverse-model-proposal.js`, and planning-decision validators.
The prototype domain/operations are requirements for this proposal, never a
reason to create one table per screen. Respect Reuse, Extend, Create, Adapt,
and Defer; ambiguous choices/lookups/required columns block.

Show a logical-to-physical mapping proposal: entity/field IDs → exact proposed
tables/columns; stable choice IDs → approved numeric choices; lookups → one
approved target; photos → optional Image columns with the native
`image-base64` strategy. Conditional failure-photo rules remain in the common
repository boundary; **do not globally require a photo column**.

Rebind the existing Journey/usage/scenario contracts to successor persistence
without changing screen IDs, scenario values, or rule meaning. Run all owning
validators. Use the existing Gate 2 approval owner for the model/mapping and
execution contracts. Preserve the design but retain Gates 3–4 and their exact
receipt bindings; an unchanged design can be shown as unchanged, not silently
marked approved by a runner.

## 4. Bound execution copy and sequential remote phases

Read
[create Phase 7, Step 8](${PLUGIN_ROOT}/skills/create-mobile-app/references/phase-7-data.md)
and execute its **binding, fresh bounded reconciliation, manifest preparation,
publish-checkpoint, and `--require-executable` validation** sequence. Stop before
its `/add-dataverse` invocation: the conversion phase coordinator below uses
the same existing executor and service generator.

Keep `.tmp/dataverse-schema-contract.json` immutable at its approved bytes.
`build-dataverse-operation-manifest.js --bind-plan` writes only the separate
`.tmp/dataverse-execution-contract.json`. Never normalize/bind over the
canonical schema after approval. Any stale/changed schema returns to Gate 2.

**Player initialization:** once these exact artifacts exist and
`--require-executable` succeeds, initialize a missing official configuration
through the existing trusted helper:

```bash
node "${PLUGIN_ROOT}/scripts/player-dataverse.js" init \
  --project-root "<candidate_root>"
```

The helper obtains/reuses `dataverse-schema` approval for the immutable schema,
execution contract, operation manifest, reconciliation and human plan. It runs
the official tool only on the trusted desktop and installs its verified output.
It does not plan the model, switch accounts, import records, or Apply source.
Discovery, schema execution, `prototype-mapping`, test writes and Apply remain
distinct permissions. Do not initialize over an already configured environment.

Then run **one phase at a time**, in this order:

```bash
node "${PLUGIN_ROOT}/scripts/prototype-conversion.js" run \
  --project-root "<candidate_root>" --phase metadata --solution "<approved-solution>"
node "${PLUGIN_ROOT}/scripts/prototype-conversion.js" run \
  --project-root "<candidate_root>" --phase services --solution "<approved-solution>"
node "${PLUGIN_ROOT}/scripts/prototype-conversion.js" run \
  --project-root "<candidate_root>" --phase schemas --solution "<approved-solution>"
```

In Player, append `--receipt "<verified-gate4-receipt>"` to each command.
The coordinator rechecks the active `connect` attempt and the exact owning
gate receipt before entering these phases. A local approved boolean cannot
substitute for that maker decision.

`metadata` consumes the exact existing sequential operation-manifest executor.
`services` invokes the existing service generator, which runs
`npx power-apps add-data-source --api-id dataverse --org-url ... --resource-name ...`
sequentially for the approved list. `schemas` runs official
`npm run generate-schemas` and verifies its output.

The coordinator journals `inFlight` before every phase. Remote uncertainty
requires a **new bounded reconciliation and regenerated manifest** before
retry; it is not permission to blindly replay creates. Completed steps resume
only with current bindings. `.tmp/prototype-dataverse-remote-journal.json`,
publish checkpoints, and all prior remote evidence survive local failures.
Do not attempt local file Undo as a rollback of tables, rows, or uploads.

## 5. Verify materialized mappings and generate real adapters

After tables/services exist, fetch a **full-detail** bounded exact-table snapshot into
`.tmp/prototype-materialized-snapshot.json` using the existing snapshot helper.
For mapped lookups, obtain exact
`ReferencingAttribute`, `ReferencedEntity`, and
`ReferencingEntityNavigationPropertyName` from bounded relationship metadata
reads through the existing Dataverse request helper. Save
`.tmp/prototype-relationship-evidence.json` as a table-logical-name-keyed object
of these returned records; use `{}` only when no mapped lookups exist.
Do not infer navigation-property names from lookup columns.

Author `.tmp/prototype-dataverse-mapping-input.json`:

```text
schemaVersion: 1
domainRevision: canonical domain revision
schemaRevision: immutable approved schema revision
entities:
  - entityId, owner, decision
  - for Dataverse: logicalName, serviceFile, serviceExport, serviceSha256
    fields: [{fieldId, column, choiceMap?, navigationProperty?, mediaStrategy?}]
  - for retained owners: decision: defer, no physical fields/table/service
  - for an existing connector owner: retainedAdapter: {file, exportName, sha256}
```

Retained connector repositories must already be real app-owned exported
repository objects under `src/data`, with verified source hashes and the same
typed logical API. Their generated SDK/service ownership stays unchanged.
Missing connector integration blocks; the compiler never substitutes local
fixtures for connector-owned records. Local/transient owners also stay unchanged.

Use actual `verify-dataverse-services.js` results and inspect the official
service source before recording the exact export and SHA. The adapter compiler
checks current static `getAll(IGetAllOptions)`, `get(id,IGetOptions)`,
`create`, `update`, and `delete` signatures and SDK result envelopes; unknown
signatures block rather than falling back to guessed exports. It also verifies
every field/type, numeric choice, lookup target/navigation property, and photo
limit against materialized evidence and the approved schema. Unsupported
polymorphic lookups, files, aggregates, computed writes, or incomplete mappings
remain blocking, not lost fields.
UTC-instant datetime fields require verified `UserLocal` behavior; date-only
or wall-clock mappings need a separately reviewed domain decision. Required
writable physical columns cannot silently strengthen optional logical fields.

Review the fully materialized mapping and its differences from the approved
proposal. New semantic differences reopen the owning gate. After approval:

For Player, ask a shared `kind: "schema"`, `gateId: "prototype-mapping"`
question with `fields: []`, binding all seven canonical mapping inputs:
domain, bindings, rules, mapping input, immutable schema, full materialized
snapshot, and relationship evidence. Use approve/revise/reject actions.

```bash
node "${PLUGIN_ROOT}/scripts/prototype-conversion.js" run \
  --project-root "<candidate_root>" --phase adapters --solution "<approved-solution>"
node "${PLUGIN_ROOT}/scripts/prototype-conversion.js" run \
  --project-root "<candidate_root>" --phase startup --solution "<approved-solution>"
```

Append `--receipt "<verified-prototype-mapping-receipt>"` to both commands in
Player mode. The helper rejects incomplete or stale mapping bindings.

The app-owned logical API remains stable. Both adapters merge stored records
before common rules; all service results require `success === true`. Native
Image writes read the persisted photo as base64 and include it in the same
record write; a failed/cancelled capture never produces a success or a raw
device URI in Dataverse. Stable live `operationId` receipts prevent duplicate
retries; unchanged local screen APIs also receive persistent pending-operation
identities automatically. An uncertain remote response stops for explicit
`repository.reconcileWrite(operationId)`, never a blind create replay.
Remote photo caches are content-addressed and environment-scoped; reads cannot
overwrite old evidence, including evidence needed after candidate discard.

Connected startup derives its real host provider from the saved installed
template and changes only the current provider binding, retaining current root
UI and authoring. It restores login routes and adds the auth guard around the
**existing** navigation tree; it never restores an obsolete root over current
app content. In an instrumented app, run
`configure-prototype-authoring.js --project-root "<candidate_root>"` with the
actual `--ready-screen` IDs, then `--check`. The reserved runtime
stamp/association must still select the proper active/candidate namespace
before repository consumers mount. Existing registry source assignments are
retained; if conversion explicitly adds or moves screens, supply the complete
`--screen-source "<screen-id>=<assigned-app-screen.tsx>"` list from those
approved file assignments, not a route-to-file guess.

## 6. Offline question, validation, and separate Apply

Only now, after real tables and services exist, run the existing create
Step 8.85 explicit offline-support question. Yes routes to the current
`/setup-offline-profile --orchestrated-create`; No records not-applicable.
Do not infer offline from the prototype's local storage, connectivity, or
screen states. The installed host/offline package remains the owner.

Run actual TypeScript, changed-file, route/navigation, canonical contract,
rule, and adapter conformance gates. Verify a connected read using the
approved environment and account. A connected candidate is **read-only by
default**. Create/update/delete validation against real data requires a
separate explicit test-write decision identifying controlled disposable rows;
never destructively validate with existing live business records. Keep fixture
conformance and real environment/device evidence clearly distinguished.

Read and execute [controlled test writes and Apply](references/test-writes-and-apply.md).
It contains the implemented, receipt-checked test-scope commands and the
standalone data activation step. Never change an `allowWrites` boolean by hand.

**Player:** use the shared candidate command with actual validated screen IDs.
The bridge alone publishes. Ask for separate **Apply / Discard** after preview;
only native acknowledgement of that Applied revision establishes the active
switch. Skills do not invoke standalone activation or write the reserved stamp.

**Ordinary CLI:** ask the actual foreground **Apply / Discard** question, then
use the implemented data activation command in the reference under exclusive
mutation ownership with the owned preview paused. The conversion foreground
retains last-good source, finishes bounded validation/recovery, and verifies
the resulting preview. It does not depend on a Player receipt or a nonexistent
ordinary transaction method on the Player-only edit wrapper, and must not
claim root-wide atomicity.

Model/schema approval never approves active-source replacement. Retain the
prior local revision, local records/photos and all remote journals; failure or
Discard leaves the prototype available. Player configures its authorized
native stamp before hooks mount.
Deployed connected builds use real host auth/data without requiring authoring
association; local-prototype production remains explicitly unsupported.

Report what is connected, which owners remain unchanged, offline choice,
validation actually performed, and any irreversible remote effects. Deployment
remains a separate `/mobile-app:deploy` action.
