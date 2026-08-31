# Return-Only Agent Orchestration

This is the one foreground contract for `native-app-planner`,
`data-model-architect`, `screen-planner`, `screen-builder`, and
`offline-profile-architect`. All five agents declare `tools: []`.

## Ownership

Children receive complete immutable context inline, reason within one assigned
role, and return content. They never read files, write files, run commands, ask
users, approve sections, mutate services, or dispatch another agent.

The foreground owns:

- file and environment reads;
- work-order construction and fingerprinting;
- child dispatch and response capture;
- questions and approvals;
- response parsing and target allowlisting;
- role-specific validation and atomic materialization;
- commands, Dataverse, connectors, packages, and native mutations;
- timing, concerns, retries, pipeline state, and resume state.

## Execution Mode

Cache exactly one base execution mode for a host/runtime/plugin-version
session:

- `parallel-return`: custom-agent dispatch works. Dispatch independent work
  orders concurrently when the host exposes concurrency; otherwise use the
  same return-only agents sequentially with effective concurrency 1.
- `foreground-return`: custom-agent dispatch itself is unavailable. The
  foreground performs each role sequentially from the same sealed work order
  and emits the same response envelope before validation and materialization.

Never attempt a write-capable child first. Never load a separately specified
inline implementation. Sequential mode uses the same semantic rules,
artifacts, validators, and gates as concurrent mode.

An individual work order may switch from the `parallel-return` base mode to
`foreground-return` after its transport retry is exhausted. This scoped
override does not change the cached base mode or the channels of successful
siblings.

Cache the mode in `.tmp/agent-execution-mode.json`, bound to host ID, runtime or
session ID, and plugin version:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/agent-return-runtime.js" \
  --project-root "<working_dir>" --read-mode \
  --host-id "<host>" --runtime-id "<runtime-or-session>" \
  --plugin-version "<plugin-version>"

node "${CLAUDE_SKILL_DIR}/../../scripts/agent-return-runtime.js" \
  --project-root "<working_dir>" --write-mode \
  --host-id "<host>" --runtime-id "<runtime-or-session>" \
  --plugin-version "<plugin-version>" \
  --execution-mode "<parallel-return|foreground-return>"
```

The cache expires after 30 minutes and invalidates when any binding changes.
Do not spawn a no-op capability probe. On a cache miss, use the first real
return-only work order. Only an agent-routing/dispatch failure selects
`foreground-return`; an application-level `blocked`, malformed response, or
validator failure does not.

## Work Order

Every work order is one JSON object. It contains all context inline, not paths
that the child must read:

```json
{
  "schemaVersion": 1,
  "agent": "screen-builder",
  "workOrderId": "screen:home",
  "attempt": 1,
  "context": {
    "completeRoleSpecificContext": "inline"
  },
  "artifacts": [
    {
      "artifactId": "screen:home",
      "targetPath": "/absolute/project/app/(app)/home.tsx"
    }
  ]
}
```

A work order requests file `artifacts`, one typed structured `result`, or both.
The Data Model work order requests no files or target paths:

```json
{
  "schemaVersion": 1,
  "agent": "data-model-architect",
  "workOrderId": "planning:data-model",
  "attempt": 1,
  "context": { "completeRoleSpecificContext": "inline" },
  "artifacts": [],
  "result": {
    "resultId": "semantic:data-model",
    "resultType": "data-model-semantic-v1"
  }
}
```

For any structured artifact, complete context includes the exact current JSON
schema and applicable semantic-rule requirements read by the foreground from
the plugin. A schema path alone is insufficient. Product Experience, Product
Scope, Workflow Journey, screen build-pack, and normalized Dataverse contract
producers never infer machine shapes from model memory.

Children set cross-artifact revision fields to the deterministic 64-zero
placeholder. They never calculate hashes or copy `inputFingerprint` into an
artifact revision. Before semantic validators, the foreground runs
`bind-return-only-contracts.js` against staged files. It computes canonical
Product Experience, Product Scope, and Workflow Journey revisions and changes
only their binding fields.

Write the unsealed foreground-owned work order under
`.tmp/agent-work-orders/`, then seal its complete content:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/agent-return-envelope.js" \
  --project-root "<working_dir>" \
  --seal-work-order ".tmp/agent-work-orders/<id>.unsealed.json" \
  --output ".tmp/agent-work-orders/<id>.json"
```

`workOrderId` is stable across attempts for one assigned role/artifact, such as
`planning:native`, `planning:data-model`, `planning:screen-graph`, or
`screen:home`. Retry limits are scoped to that ID, so one screen never consumes
another screen's allowance. `inputFingerprint` is SHA-256 over the complete
work order without that field.
The child echoes it verbatim and never computes it. Any context, artifact,
attempt, clarification answer, or validator finding change requires resealing.
On a targeted repair, only the affected work order changes.

### Payload budgets and Data Model partitions

Before dispatch, measure the exact UTF-8 byte length of every sealed work order,
including inline context, schema, and fingerprint. Data Model planning uses
`data-model-agent-partitions.js`; do not estimate from token counts or source
object size. The default limit is 65,536 bytes, configurable through
`MOBILE_AGENT_MAX_PAYLOAD_BYTES` or `--max-payload-bytes` with an 8,192-byte
minimum.

- A fitting Data Model request remains one `data-model-semantic-v1` call.
- An oversized request dispatches one `data-model-topology-v1` call, then
  deterministic parent-before-child `data-model-detail-v1` partitions.
- Topology owns global requirement coverage, entity shells, relationships,
  operation assignments, and fixtures. Detail owns complete fields and
  operations for exact assigned entity IDs.
- Every detail result echoes the topology hash. The strict foreground merger
  rejects missing, duplicate, drifting, or cross-partition content before the
  canonical semantic compiler runs.
- A partition is indivisible. If it cannot fit, stop with measured bytes rather
  than dropping evidence or product scope. Screen work orders are unchanged.

Checkpoint state lives at `.tmp/data-model-partition-state.json`, bound to the
run ID and hash of `.tmp/data-model-partition-request.json`. Resume verifies
work-order fingerprints and completed result-file hashes, then returns only
pending partition IDs. A detail failure repairs only that detail; a topology
repair invalidates all details because their hashes no longer match.
When bounded `needs_context` evidence arrives, increment the request attempt and
run `data-model-agent-partitions.js --refresh-request`: topology/summary changes
invalidate all details, while detail-only changes rebuild only owning partitions
and preserve completed siblings.

Dispatch the complete sealed JSON object inline. Do not tell the child to read
the work-order path. Capture the exact response as text under
`.tmp/agent-responses/`; do not extract JSON from prose or Markdown fences.

## Response Envelope

Every child returns exactly one JSON object and nothing outside it:

```json
{
  "schemaVersion": 1,
  "status": "ready",
  "agent": "screen-builder",
  "inputFingerprint": "foreground-generated-value-echoed-verbatim",
  "artifacts": [
    {
      "artifactId": "screen:home",
      "targetPath": "/absolute/project/app/(app)/home.tsx",
      "content": "complete artifact content"
    }
  ],
  "concerns": [],
  "clarification": null
}
```

For a typed structured-result work order, `artifacts` is empty and `result`
contains the object directly. It contains no escaped files or target paths:

```json
{
  "schemaVersion": 1,
  "status": "ready",
  "agent": "data-model-architect",
  "inputFingerprint": "foreground-generated-value-echoed-verbatim",
  "artifacts": [],
  "result": { "schemaVersion": 1, "status": "ready", "mode": "dataverse-required" },
  "concerns": [],
  "clarification": null
}
```

Unknown fields, schema versions, roles, fingerprints, artifact IDs, and target
paths are rejected. Content must be complete and non-empty, with no truncation
marker. Every `content` value is serialized UTF-8 file text represented as a
JSON string. A `.json` target contains a complete serialized JSON document
string, not a nested object. Duplicate artifact IDs or target paths within or
across concurrent responses are rejected before any final write.

The Data Model semantic result is validated against the exact inline
`schema-data-model-semantic-result.json`, then
`compile-data-model-semantic-result.js` deterministically renders the Markdown,
Dataverse contract, and equivalence receipt. Mechanical rendering may not add
an entity, field, relationship, operation, fixture, or requirement.

Validate structure without materializing:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/agent-return-envelope.js" \
  --project-root "<working_dir>" \
  --work-order ".tmp/agent-work-orders/<id>.json" \
  --response ".tmp/agent-responses/<id>.json" \
  --validate-only \
  --output ".tmp/agent-results/<id>.json"
```

For a concurrent wave, repeat paired `--work-order` and `--response` arguments
in deterministic artifact-ID order. The parser validates the complete set.

## Status Handling

- `ready`: validate and materialize all requested content.
- `ready_with_concerns`: validate and materialize complete content; aggregate
  concerns in foreground state and surface them at the existing phase boundary.
- `needs_context`: gather only the exact named fact, update the same work order,
  reseal, and dispatch once more. A second context request stops.
- `needs_clarification`: persist waiting state, ask the one returned question,
  attach the answer to the same work order, reseal, and resume. Ordinary
  approvals do not redispatch the planner.
- `blocked`: stop only for a substantive safety or correctness condition.
  Missing tools, filesystem, shell, Plan Mode, or structured question UI are
  never valid child blocks.

Invalid or truncated transport gets one retry of the byte-identical sealed work
order. Role-validator repair is targeted to one artifact, includes exact
findings, and is capped at two repair dispatches. Never regenerate successful
siblings or replan the whole app for one failed artifact.

After each malformed response, record the transport failure against that run
and work order:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/agent-return-runtime.js" \
  --project-root "<working_dir>" --record-transport-failure \
  --run-id "<current-run-id>" \
  --agent "<role>" --work-order-id "<stable-id>" \
  --input-fingerprint "<sealed-fingerprint>"
```

The first failure returns `nextAction: transport_retry`; record and dispatch
that byte-identical retry once. The second returns
`nextAction: foreground_return` and changes only that work order's channel.
Do not regenerate successful siblings or change the cached host-level mode.

Before each dispatch, record the stable work-order ID, reason, and sealed
fingerprint. Allowed reasons are `initial`, `transport_retry`, `needs_context`,
`needs_clarification`, and `targeted_repair`; there is no approval redispatch:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/agent-return-runtime.js" \
  --project-root "<working_dir>" --record-dispatch \
  --run-id "<current-run-id>" \
  --agent "<role>" --work-order-id "<stable-id>" \
  --reason "<allowed-reason>" --input-fingerprint "<sealed-fingerprint>"
```

Generate one opaque run ID when a fresh `/create-mobile-app` run begins and
reuse it for every dispatch and deliberate resume in that run. A new run gets a
new ID, so dispatches and retry budgets from a failed or abandoned run cannot
poison its initial work orders. Never reuse a prior run ID for an ordinary fresh
start.

## Questions and Approvals

The foreground exposes these logical adapters:

```text
askUser(question, context)
approveSection(sectionId, renderedContent, revision)
```

- Claude Code uses structured question and Plan Mode tools when available.
- Copilot CLI asks in normal foreground conversation.
- VS Code Copilot Chat asks in normal foreground chat.

Normal chat is a supported interaction path, not degraded execution. Before
yielding, persist state with `status: waiting_for_user`, the same phase and
revision, and the complete pending interaction:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/agent-return-runtime.js" \
  --project-root "<working_dir>" --wait --run-id "<current-run-id>" \
  --phase "<phase>" \
  --kind "<clarification|approval>" --section-id "<section>" \
  --question "<question>" --affected-decisions "<comma-separated IDs>" \
  --revision "<revision>"
```

On the next user message:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/agent-return-runtime.js" \
  --project-root "<working_dir>" --resume \
  --run-id "<current-run-id>" --answer "<answer>"
```

Resume the same phase and revision. Do not restart from the original prompt.
Reject a resume whose run ID does not match the persisted waiting interaction.
Gated mode retains the existing four sections; consolidated mode retains its
single review of those same sections.

## Validation and Materialization

Build a foreground-owned validation plan using existing role validators. The
plan may reference staged paths as `{{artifact:<artifactId>}}`, final paths as
`{{target:<artifactId>}}`, and the project root as `{{projectRoot}}`:

```json
{
  "schemaVersion": 1,
  "commands": [
    {
      "id": "contract-bindings",
      "command": "node",
      "args": [
        "/plugin/scripts/bind-return-only-contracts.js",
        "--project-root",
        "{{projectRoot}}",
        "--experience",
        "{{artifact:contract:product-experience}}",
        "--scope",
        "{{artifact:contract:product-scope}}"
      ]
    },
    {
      "id": "product-experience",
      "command": "node",
      "args": [
        "/plugin/scripts/validate-product-experience.js",
        "--contract",
        "{{artifact:contract:product-experience}}"
      ]
    }
  ]
}
```

The common materializer structurally revalidates every envelope, stages all
content with its original extension, runs deterministic binding and then the
validation plan against staged files, and atomically renames in deterministic
target-path order only when all commands pass:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/agent-return-envelope.js" \
  --project-root "<working_dir>" \
  --work-order ".tmp/agent-work-orders/<id>.json" \
  --response ".tmp/agent-responses/<id>.json" \
  --materialize \
  --validation-plan ".tmp/agent-validation/<id>.json" \
  --materialization-state ".tmp/agent-materialization-state.json" \
  --phase "<phase-or-wave-id>" \
  --output ".tmp/agent-results/<id>.json"
```

No final target changes when structural or staged validation fails. Existing
independent artifacts remain untouched during targeted repair. Each successful
materialization increments the foreground-owned revision and stores artifact
hashes without dropping successful siblings. At the existing phase boundary,
record the same artifacts in `.tmp/pipeline-state.json` through
`mobile-pipeline-state.js`. After screen wave materialization, the foreground
still runs TypeScript, routes,
accessibility, safe-area, clipping, stylistic, and cross-screen gates.

## Instrumentation

Record only bounded execution facts, never prompts or artifact content:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/planning-timings.js" \
  --project-root "<working_dir>" --record-agent-execution \
  --execution-mode "<parallel-return|foreground-return>" \
  --agent-dispatch-count "<count>" --agent-retry-count "<count>" \
  --agent-tool-call-count 0 \
  --request-payload-bytes "<bytes>" \
  --response-payload-bytes "<bytes>" \
  --work-order-count "<count>" \
  --detail-partition-count "<count>" \
  --completed-work-order-count "<count>" \
  --resumed-work-order-count "<count>" \
  --foreground-materialization-ms "<milliseconds>" \
  --foreground-validation-ms "<milliseconds>"
```

Record the channel actually used by each dispatch/materialization batch. If a
run starts in `parallel-return` and one or more exhausted work orders fall back
to `foreground-return`, the timing summary reports `executionMode:
mixed-return` plus separate dispatch counts for both channels.

For converted children, `agentToolCallCount` must always be zero.