# Player authoring transport

The same Mobile Apps foreground workflows run from a desktop CLI or from a
Dev Player job. The question surface changes; the skill, job, gate ownership,
and required validations do not.

## Select the transport once, inherit it everywhere

Run from the selected app workspace:

```bash
node "${PLUGIN_ROOT}/scripts/mobile-authoring.js" verify
```

- `mode: "standalone"`: continue using the ordinary foreground
  `AskUserQuestion`. Do not start a bridge or create a descriptor.
- `mode: "player", verified: true`: all questions use the helper below.
  Inherit `MOBILE_AUTHORING_CONTEXT` and `MOBILE_AUTHORING_RUNNER_TOKEN` through
  every nested foreground skill. A nested `/design-system`, `/add-native`,
  `/setup-datamodel`, offline reconciliation, or repair question is still a
  question in the **same Player job**, not a separate CLI dialog.
  Do not also call `AskUserQuestion` or issue a duplicate desktop prompt.
- A present but invalid descriptor, a protocol mismatch, revocation, stale
  attempt, or unavailable bridge is a block. Never fall back to a desktop
  question or create a replacement job to bypass it.

The bridge starts the CLI without its interactive question tool. Merely
instructing that CLI to ask a question cannot show a maker card. The helper
posts a typed question and waits in its own process using bounded HTTP long
polls; the model does not poll, run curl, or start another skill while waiting.
Use the command tool's normal attached wait/resume mechanism if the command
outlives one tool wait. A timeout retains the same durable question; rerun the
same command and input rather than issuing a duplicate question.

No third model agent owns this adapter. Foreground skills keep all questions
and decisions; the two existing bounded workers retain their sealed scopes.

## Trust boundary

`MOBILE_AUTHORING_CONTEXT` names a nonsecret, read-only, bridge-owned descriptor
outside the runner-writable workspace. It binds protocol version/hash, app,
job, attempt, operation, base source revision, candidate workspace, a loopback
bridge origin, and the issuer's Ed25519 **public** key. The helper verifies the
active scoped runner handshake before acting. The descriptor may include the
minimal runtime `context` or a project-relative `contextFile`, not both.
The bridge checks the original context job against its stored base publication
and any screen against the ready approved route before issuing the descriptor.
Scoped verification must return that same normalized `context`; missing or
swapped context blocks. A candidate-controlled context file cannot replace the
bridge-validated selection. The originating job ID is never rewritten to the
new edit job ID.
An `edit` descriptor may also carry one normalized catalogue `integration`:

```json
{ "kind": "native", "capabilityId": "<catalogue-item-id>", "catalogRevision": "<sha256>" }
```

or:

```json
{
  "kind": "connector",
  "apiId": "<catalogue-api-id>",
  "environmentId": "<selected-environment-id>",
  "connectionId": "<existing-connection-id>",
  "catalogRevision": "<sha256>"
}
```

`connectionRef` may replace `connectionId`; exactly one is required. The
selection belongs to the bridge-validated base app/environment catalogue,
not a model-authored list or a question answer containing a command. The
scoped handshake must echo the exact selection. Missing, swapped, or stale
selections block; never silently choose a different capability or connection.
Catalogue selection is only an edit intent, not preparation, Apply, schema,
or data-import consent.

Only `MOBILE_AUTHORING_RUNNER_TOKEN` carries the per-attempt callback secret.
Never inspect/echo it, include it in a prompt, write it into question JSON,
put it on argv or a URL, or copy it into a diagnostic or receipt. The helper
sends it only in `x-runner-token`. Redirects are forbidden. The maker-facing
credential and `/__builder_verify` are not runner APIs.

File checks do not constitute a sandbox: the bridge must enforce a constrained
runner policy, protect the descriptor and its directory, restrict inherited
tools/credentials, and provide an isolated candidate workspace. There is no
`--allow-all` fallback. A prototype operation cannot mutate Dataverse.

The runner can request a decision, not issue one or publish active files.
Decision receipts are Ed25519 signatures over the complete recursively
key-sorted JSON record excluding `signature`. Arrays retain order. The helper
verifies issuer, protocol, app/job/attempt, approval ID/revision, logical gate,
exact normalized question digest, current canonical artifact digest, action,
and declared answer types/choices before persisting a nonsecret receipt.
Question content cannot supply an issuer key, callback URL, or command.

## Ask a clarification or bounded choice

Write the question JSON under `.devplayer-builder/logs/authoring-input/`, which
is excluded from the source digest. Do not put secrets, full records, captured
photos, tenant-private data, or internal machine paths in it.

```json
{
  "gateId": "edit-scope",
  "kind": "clarification",
  "title": "Which part should change?",
  "summary": "I can change the selected collection without changing how its data loads.",
  "items": ["Existing filters, paging, navigation, and record actions stay unchanged."],
  "fields": [
    {
      "id": "scope",
      "label": "Change",
      "type": "select",
      "choices": ["Selected collection", "App-wide style", "Cancel"]
    }
  ]
}
```

```bash
node "${PLUGIN_ROOT}/scripts/mobile-authoring.js" request-question \
  --input .devplayer-builder/logs/authoring-input/scope.json \
  --bind .tmp/compiled-screen-build-pack.json
```

`fields` supports `text`, `select`, and `boolean`, at most 12 fields. Choice
lists are explicit and bounded. There is no free-form executable answer.
`id` and `sourceRevision` may be omitted: the helper derives a stable question
ID and current binding. Supplying them does not bypass verification. Changing
the question or its artifacts requires a new question, not reuse of an old ID.

Translate ordinary foreground questions without changing their meaning:

| Ordinary question | Player fields |
|---|---|
| Single choice | One `select` with distinct, recognizable choices |
| Yes/no | One `boolean`, or an explicit Yes/No/Cancel `select` |
| Several independent selections | One `boolean` per option, within the 12-field bound |
| Open clarification | One bounded `text` |
| Final consent for a resolved proposal | The owning `plan`/`schema` decision, not an unresolved yes/no field |

Split a larger set of clarifications into bounded questions in the same job;
this never consolidates or bypasses the owning approval gates. If two real
options share a display name, include distinguishing nonsecret identity in
their labels. Authentication secrets go through the supported authentication
UI, not question fields or a fallback CLI prompt. Record “done” only after
the existing authentication/environment verification succeeds.

Use `--bind <canonical-artifact>` repeatedly when the decision concerns a
particular proposal or contract. Bind the complete intended effect, including
all relevant proposal artifacts, not just the summary. Without `--bind`, the
helper binds the current source snapshot. Do not bind mutable timelines,
approval receipts, pipeline state, or remote journals. `binding` accepts the
same binding flags for inspection without asking a question.

The JSON result contains `action`, typed `answer`, a project-relative
`receipt`, and `gateRecorded`. Read the actual answer before branching:
transport action `approve` submits a clarification's fields; an answer of
`Cancel` or `false` is not consent to continue. `reject` stops the proposed
effect; `revise` returns to the same owning planning step with the feedback.
Do not repeat an already answered clarification in a nested skill.

## Four creation gates remain four gates

At each existing gate, present that gate's reviewed content in Player. Replace
the standalone question **and its direct approval-recording command** with:

```bash
node "${PLUGIN_ROOT}/scripts/mobile-authoring.js" request-question \
  --input .devplayer-builder/logs/authoring-input/gate-1.json \
  --record-gate 1
```

The input is a `kind: "plan"` question. `gateId` may be omitted with
`--record-gate`; otherwise it must be `gate1`, `gate2`, `gate3`, or `gate4` as
appropriate. Repeat for each owning gate only when the workflow reaches it.
The helper selects the gate's canonical artifacts and applicable human-plan
sections, obtains and verifies the exact maker receipt, rechecks the live
attempt and artifact bytes, and only then invokes the existing local
`approveGate`. A local status boolean is not an approval.

When the local logical domain exists, Gates 2–4 also bind the complete
`.tmp/prototype-domain.json`, `.tmp/prototype-bindings.json`, and
`.tmp/prototype-rules.json` set. A partial set is a block. Present those
canonical files in the conditional data review before generation; later
changes need the owning gate reopened, not an unchanged data-model approval.

Gate 1 remains architecture/capability/product consent; Gate 2 remains the
conditional data model/journey/build-pack review; Gate 3 remains materialized
design and interactive journey review; Gate 4 remains implementation consent.
There is no consolidated-review shortcut. Reopening Gate 1 invalidates stale
local pipeline bindings through the existing invalidation path, not preserved
remote evidence. Never erase canonical schema or execution journals.

Other schema/data/native decisions keep their existing owner. They use this
same question transport, binding their exact canonical proposal, and call
their owning mutation helper **only after** receipt verification. Use
`verify-receipt --receipt <relative-path>` immediately before that authorized
effect. A `schema` question is not implied by a `plan` question, and neither is
an approval to import sample records or photos. A prototype or ordinary
prototype edit routes real-data conversion to its separately approved
`/prototype-to-real-app` job.

An explicitly selected existing connector is a different, bounded connected
edit: after preparation approval and reopened Gate 1, the owning connector
skill may initialize the isolated candidate in that environment and generate
official SDK output. It must preserve local domain data/rules/UI, cannot
create a connection, list, table, or column, and cannot import records/photos.
Use the catalogue profile in
[`player-authoring.md`](../../skills/edit-app/references/player-authoring.md).
Nested dataset/list/action questions remain in this same Player channel.
Native additions likewise use the supported workflow from the selected
template's packages, never an unsolicited install or a claimed hardware test.

Inventory is a maker-side capability. `nativeCatalog` and `connectorCatalog`
advertise the implemented **read-only browsing adapters**, independently of
candidate editing, SDK metadata transport, or Add/init/generation support.
Each flag requires its actual listing helper and supporting files, all bound
in `buildIdentity`; a missing listing adapter leaves only its affected flag
false. Browsing readiness is not Add permission: the paired bridge's
`controls.canAdd` and per-item availability govern the Add action. Execution
still requires the installed owning workflow, exact source-bound selection,
and its separate preparation, access/schema and Apply decisions.

Normal catalogue requests are maker-authenticated GETs:

- Native: `/apps/:id/catalog/native` reads the selected template's
  `package.json` and the existing friendly-label policy. Supported template
  workflows need no extra device ABI, method inventory, or probe to browse or
  select them. Runtime bans and package compatibility remain; real device
  permissions and unavailable hardware must be handled honestly by the app.
- Connectors: `/apps/:id/catalog/connections?environmentId=<exact-id>` runs
  the existing read-only `/list-connections` on sheet opening and Refresh.
  Keep the exact returned API, environment, connection ID or reference and
  catalogue revision. Do not require SDK metadata/generation credentials
  merely to list connections, or start another discovery orchestrator.

Only a **successful actual empty list** shows: “No connections found in this
environment. Create a connection in the Power Apps portal, then Refresh.”
Include the [official supported connector types](https://learn.microsoft.com/en-us/connectors/connector-reference/connector-reference-powerapps-connectors).
Authentication, permission, network and SDK errors remain visible errors,
never empty lists or an automatic connection-creation/auth-repair flow.
Runner credentials never call maker-only catalogue routes. Listing and
selection grant no connection creation, business-data access, or Dataverse
authority.

The shared Node client exposes
`connectorMetadata({url, authResource}) -> Promise<{status:200,data}>` for the
official SDK owner's injected GET client. It is restricted to a verified
connector-selected edit and posts only to the fixed runner
`connector-metadata` route. The bridge—not the runner—checks the exact selected
environment/connection/metadata URL allowlist and current artifact-bound plan
and schema/access grants before making any GET. No general URL fetch, bearer
token, authentication cache, or mutation transport is provided. Invalid grants,
redirects, cancellation, and stale selections block without fallback.

Metadata responses have a separate 4 MiB bound; question/decision responses
keep their smaller existing bound. Helper
`connectorMetadataTransport: "scoped-sdk-get-v1"` identifies this implemented
transport, not a login or execution grant. It does not enable
`connectorCatalog` and is not required to browse that catalogue. Actual SDK
execution remains subject to the paired bridge's scoped transport, installed
owning adapter, approvals and policy on every operation.

### Explicit Dataverse conversion transport

`createClient(...).dataverse(input)` is a separate, conversion-only desktop
broker seam. It refreshes the active handshake and posts to
`/runner/jobs/:id/dataverse` with the descriptor's `attemptId` and
`appInstanceId`. It accepts only these operation-specific inputs:

| `operation` | Required additional fields |
|---|---|
| `resolve-environment` | `target` |
| `metadata` | `environmentUrl`, `method: "GET"`, `apiPath` |
| `execute-manifest` | `environmentUrl`, `manifestHash` |
| `generate-services` | `environmentUrl`, `manifestHash` |
| `init` | `environmentUrl` |

Targets are bounded text; environment URLs are credential-free HTTPS origins.
Metadata paths cannot cross origins. The bridge still validates the exact
approved environment, metadata endpoint and immutable operation manifest.
No bearer token, command, arbitrary body, auth fallback, or direct remote
fetch is accepted by the runner.

The method returns the bounded JSON object unchanged, including any
failure-state journal artifacts for the owning adapter to preserve. Official
artifact responses may be up to 32 MiB. Init, execution and generation have
a 120-second request timeout and **no automatic transport retry**. An unknown
execution outcome requires remote-evidence reconciliation before retrying;
read-only discovery retains the existing bounded retry policy.

The owning conversion adapter requests its separate `dataverse-discovery`
clarification bound to `.tmp/dataverse-discovery-target.json` before discovery,
and obtains exact artifact-bound schema consent before initialization,
execution or generation. Every request remains subject to bridge grant
verification. Calling this transport grants no consent and does not install
artifacts, mutate active Metro source, publish a candidate, or Apply it.

## Progress, candidates, and completion

`event --input <relative-json>` sends a bounded `plan`, `screen`, or `step`
event. Screen plans use the protocol's stable screen IDs/routes/dependencies;
screen events use `planned`, `building`, `checking`, or `failed`. The bridge
alone marks a screen `ready` after publication. Omit `eventId` for a stable
content-derived ID, or preserve the explicit ID when retrying the same event.
Never report “ready” because a file was submitted or Metro returned HTTP 200.

```bash
node "${PLUGIN_ROOT}/scripts/mobile-authoring.js" candidate \
  --ready-screen work-list --ready-screen work-detail

node "${PLUGIN_ROOT}/scripts/mobile-authoring.js" candidate \
  --ready-screen work-list --ready-screen work-detail --final

node "${PLUGIN_ROOT}/scripts/mobile-authoring.js" complete
```

`candidate` runs fixed, existing TypeScript, compiled-pack, route/navigation,
changed-file, and ready-screen quality/contrast gates. It rejects missing app
dependencies, unknown screen IDs, ambiguous routes, and source changes during
checks. It binds source/contracts/assets using the bundled source capture
implementation and sends the candidate to the bridge. It never edits an
active Metro project or trusts commands/URLs in a receipt.

Apps with a prototype profile or mobile authoring runtime also run
`configure-prototype-authoring.js --check` with ready IDs resolved from the
registered source files. This verifies explicit `authoringTargets` exports
and their real screen/target wiring, usable/dirty state, and derived
registry/runtime outputs without mutating setup.
The foreground runs the configurator after each completed screen wave,
after conversion/new-screen changes, and before publication. Skeletons may
remain unfinished, but an export alone cannot make an unready skeleton ready.
Any configurator edits to screen layout/scroll wiring stay within the exact
approved TSX scope, including during intentional runtime installation.
An authored registry is not a native mount acknowledgement.

The result says `submitted`, with `applied: false`. The bridge performs its
own trusted readiness/publication check; maker Apply and mounted native
acknowledgement are distinct. `complete` ends runner work, not an app session,
and also does not claim Apply or a rendered device screen.

On a terminal failure, use `failed --message "<bounded nonsecret summary>"`.
Do not report a failed or cancelled capture/upload as a successful save.
Stop build, Discard candidate, and Close preview have different bridge-owned
effects; do not emulate them with recursive deletion or remote rollback.

## Helper commands and persistence

| Command | Effect |
|---|---|
| `capabilities` | Installed protocol digest/build identity and only file-backed implemented operations/features; no auth required |
| `verify` | Standalone detection or active runner verification |
| `binding` | Current canonical binding (`--bind`, or `--record-gate`) |
| `request-question --input` | Post/resume one exact question and block for a verified decision |
| `verify-receipt --receipt` | Reverify an approved receipt against current artifacts/attempt |
| `event --input` | Report bounded progress, never publish |
| `candidate --ready-screen … [--final]` | Validate and submit managed source, never Apply |
| `complete` / `failed --message` | Idempotent runner terminal callback |

`--project-root` must match the descriptor workspace. `--wait-ms` sets a
bounded question wait (default 30 minutes, maximum two hours); retry retains
the same question and event IDs. Auth failures, stale attempts, cancellation,
redirects, malformed signatures, and invalid typed answers fail closed.
Network retries are bounded and retain exact payload bytes.

Requests, verified receipts, and candidate check summaries are atomically
stored below `.devplayer-builder/logs/authoring/`, excluded from source
hashing. They are recovery records, never new canonical schema or business
data. Preserve them on failure. The descriptor and callback secret are not
copied there.

Contextual edit/teaching uses
[`edit-app/references/player-authoring.md`](../../skills/edit-app/references/player-authoring.md).
