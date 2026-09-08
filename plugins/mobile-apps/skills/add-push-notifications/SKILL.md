---
name: add-push-notifications
description: Primary guided entry point for adding, resuming, building, or verifying push notifications in a Power Apps Expo mobile app. It orchestrates the independent Firebase, Apple/APNs, app runtime, sender-auth, Power Automate, wrapped-build, and physical-delivery owners while directly owning permissions, registration-token lifecycle, FCM topic synchronization, listeners/background handling, and shared typed navigation-intent integration.
user-invocable: true
allowed-tools: Read, Edit, Write, Grep, Glob, Bash, AskUserQuestion, Skill, Task
model: opus
---

**Shared instructions: [shared-instructions.md](${PLUGIN_ROOT}/shared/shared-instructions.md)** — read first.

**Push contract: [push-notifications.md](${PLUGIN_ROOT}/shared/references/push-notifications.md)** — follow exactly.

**Navigation contract: [navigation-link-contract.md](${PLUGIN_ROOT}/shared/references/navigation-link-contract.md)** —
follow exactly for in-app, custom-scheme, HTTPS, and push navigation.

**Lifecycle and routing:
[push-lifecycle.md](${PLUGIN_ROOT}/shared/references/push-lifecycle.md)** —
use these canonical stages, resume rules, and per-platform reporting states.

# Add Push Notifications

Orchestrate the canonical independent, resumable lifecycle:

1. Firebase client.
2. Platform credentials and capabilities.
3. Runtime integration.
4. Sender authentication.
5. Power Automate flows.
6. Wrapped build.
7. Physical delivery.

This is the default user-facing push command. It implements stage 3 directly:
permissions and consent, registration-token lifecycle, exact topic transitions,
foreground/background/response listeners, and validated navigation intents.
It invokes the owner skills for the other stages and continues after each
successful handoff until the user's selected stopping point is reached.

Never redo a proven stage merely because a downstream stage is missing.
Conversely, completion of one stage does not prove another. Keep cloud
provisioning, flow mutation, wrapped builds, installation handoffs, and
physical-device verification inside their owner skills; orchestration means
invoking and resuming those owners, not copying their implementation here.

Push cloud setup around this skill is **official MCP-first**. `/setup-fcm` is
the only supported Firebase owner and requires the vendor-official Firebase MCP
only; do not substitute `firebase-tools`, `gcloud`, or browser automation from
here. `/setup-push-wif` separately owns Google-side WIF provisioning through
gcloud MCP or its guarded official CLI fallback, and FlowAgent remains the
only Power Automate mutation path.

Do not add gcloud or Azure MCP surfaces to this skill's `allowed-tools`.
`mobile-app:push-wif-worker` owns the cloud plan/execute path, and
`/setup-push-wif` owns the deterministic fallback. This parent only supplies
pinned safe envelopes, asks approval questions, dispatches, validates, joins,
and merges.

**Sender-auth choices: [push-sender-auth-options.md](${PLUGIN_ROOT}/shared/references/push-sender-auth-options.md)** —
use this comparison when reporting sender-auth next steps. Manual FCM
authentication is customer-owned; this plugin does not inspect or validate it.

## Workflow

**Telemetry checkpoint: `configure_push_notifications`**

0. Collect orchestration decisions -> 1. Verify app and runtime -> 2. Verify
auth identity -> 3. Serially resume/establish and join Firebase client setup ->
4. Run the bounded prerequisite/runtime/sender-auth wave -> 5. Write wrapper
and shared navigation module -> 6. Add permission UX -> 7. Wire auth/topic
lifecycle -> 8. Wire navigation sources -> 9. Validate -> 10. Continue
sequential downstream owners -> 11. Update memory bank and report

### 0. Select one stopping point and collect orchestration decisions

Infer the requested platforms and stopping point from the user's prompt and
existing plan. Ask one grouped question only when either is unclear:

- **Configure app** — complete Firebase/platform prerequisites and app runtime
  integration, then stop.
- **Create delivery flows** — also complete sender-auth selection and Power
  Automate producer/sender flows.
- **Build for device** — also run the selected platform build owner.
- **Verify end to end** — also resume physical-device delivery verification.

Default to **Create delivery flows** when the user simply asks to add push
notifications. Building and physical verification require explicit intent
because they involve customer-managed signing, installation, and device
actions.

Record the selected platforms and stopping point for this run. Do not ask the
user to choose or remember the individual owner commands.

In the same main-context decision pass, resolve everything knowable before
worker dispatch. Workers have no authority to ask, infer, or broaden these
choices:

- show the canonical two-option sender-auth comparison and record exactly
  **Workload Identity Federation (Recommended)** or **Create Power Automate
  flows; configure FCM authentication manually**. A valid matching
  `sender-auth.json` may establish the WIF choice; a safe exact existing manual
  flow handoff may establish the manual choice. Otherwise ask once. For
  **Configure app**, record the choice for resumability but do not make
  sender-auth cloud work eligible;
- inspect the approved screen plan and current source to fix the semantic
  destination registry, exact settings/profile surface, exact existing
  navigation-sender files that need conversion, and the Android channel ID.
  Ask one grouped navigation question only for genuine ambiguity; never let a
  worker discover and choose another screen or file;
- ask whether HTTPS App Links/Universal Links are wanted. Record one approved
  exact HTTPS origin or `null`. Never infer an origin from a website, tenant,
  environment, custom scheme, or existing unapproved native setting;
- when iOS is selected, record the registered-device mode
  (`development`, `ad-hoc`, or both), approved Apple Team ID, and whether the
  safe Apple/APNs handoffs are already complete. Do not request a credential,
  credential path, account identity, device identifier, signing-asset
  identifier, screenshot, or portal output.

After Firebase identity is fixed in Step 3, complete any identity-dependent
iOS and WIF questions in the main context. Present every user-performed Apple
and Firebase Console instruction in the canonical `/setup-apple-ios` then
`/setup-apns` order and collect each required Yes/No attestation before an iOS
worker is eligible. This manual Apple Developer/Xcode guidance does not
change credentials or portal state. It does not automate Apple setup or emit a proof artifact.

For cold WIF setup, collect and pin the exact Firebase/Google project, Google
execution mode, Azure tenant/subscription/resource group, pool/provider,
sender service account, exact Entra sender display name, Key Vault URI and
secret name, and runtime connection principal. Pin the Entra sender client ID
when it exists; otherwise pass `null` rather than inventing one. Do not guess
the route, diff, mutation list, API enablement list, or broader-role need.
Those are live facts produced by the read-only WIF planning phase in Step 4.
If initial inventory proves the exact dedicated Entra identity is absent, the
parent first displays and approves only the minimal
identity/credential/secret-safe Key Vault bootstrap plan. After that stage
returns the server-generated client ID, the parent requires a fresh read-only
claim-driven plan and a second explicit approval for all remaining
Google/API/RBAC work. Approval of one stage or action does not approve an
adjacent stage or action. A worker may report a newly discovered decision
through `NEEDS_CONTEXT`, but it must never repeat a question the parent already
answered.

### 1. Verify app and runtime

Require `package.json`, `app.config.js`, `power.config.json`, and
`memory-bank.md`. Verify these exact dependencies exist in both the project and
`${PLUGIN_ROOT}/template/package.json`:

- `expo-notifications`
- `@react-native-firebase/app`
- `@react-native-firebase/messaging`
- `expo-router`

Also verify the installed native runtime exposes the modules. If the project is
running in an older Power Apps Developer/rewrap binary, stop:

> Push packages are present in JavaScript but the wrapped native runtime has not
> been proven to contain them. Install/use a runtime built from the matching
> mobile template before continuing.

Never run `npx expo install` from this skill.

### 2. Verify auth identity

Inspect the installed `@microsoft/power-apps-native-host` type declarations for
the `useAuth()` return type. Continue only if it exposes a typed, non-secret
Entra OID/current-user claim. Record the exact property path in
`src/native/pushNotifications.ts`.

If no OID is exposed, run `npm install` once so the template's version-guarded
postinstall compatibility patch can expose `useAuth().user.oid`, then inspect
the declarations again. If the patch rejects an unknown host package shape,
stop rather than modifying `node_modules` ad hoc. Do not decode MSAL tokens in
app code.
Read `${PLUGIN_ROOT}/shared/references/push-host-contract.md` for the exact
upstream API and runtime contract to report with the blocker.

### 3. Serially resume or establish and join Firebase client setup

Read `memory-bank.md`, evaluate `npx expo config --type public --json`, and
inspect only active project-local `firebase/google-services.json` and
`firebase/GoogleService-Info.plist` paths. Do not treat package presence, an
inactive file, or a remembered project ID as completed client setup.

- If every selected native platform has a valid active client config and all
  configs name the same Firebase project, reuse them and skip `/setup-fcm`.
- If no selected native platform is configured, or a newly selected platform
  is missing its active config, invoke `/setup-fcm --working-dir <root>`.
- If active Android/iOS configs disagree on Firebase project, or a config does
  not match evaluated Expo identity, stop instead of choosing one platform as
  authoritative.

`/setup-fcm` resolves Android by exact package name and iOS by exact bundle
identifier. One exact match is reused automatically. Multiple safe exact
matches require an immutable Firebase app-ID choice independently for Android
and iOS, followed by a fresh exact-identity read-back. New client integrations
still go through `/setup-fcm`; never skip it based only on an existing Firebase
project or similarly named Firebase app. If `/setup-fcm` cannot prove the
Firebase MCP path, stop and repair that owner workflow rather than falling back
to CLI or console automation here.

`/setup-fcm` is the serial foundation even though that owner now internally
fans out Android and iOS client work. Invoke it at most once for the selected
set, wait for its complete parent join, then independently re-read the active
project and every selected immutable Firebase app/config/Expo identity. Do not
start any later worker from one platform's early `/setup-fcm` result. Active
Android and iOS configs must name the same exact project.

Only after this exact Firebase join, reread `memory-bank.md`. Do not freeze the
pre-wave SHA-256 until the WIF read-only plan and all parent approvals are
complete, immediately before execution dispatch in Step 4.3.

### 4. Run the bounded prerequisite/runtime/sender-auth wave

The parent owns all questions, dispatch, joins, validation, memory merge, and
downstream routing. Workers never write `memory-bank.md`, never ask the user,
never invoke another owner, and never expand their exclusive file set.

#### 4.1 Determine incomplete eligible tracks

Evaluate the three tracks independently:

1. **Runtime integration** —
   `mobile-app:push-runtime-worker`, eligible when any selected platform's
   Steps 5-9 runtime state is incomplete or strict validation is not current.
2. **Sender authentication** —
   `mobile-app:push-wif-worker`, eligible only for WIF when the stopping point
   is **Create delivery flows** or later and no fresh matching plugin-managed
   handoff exists. Cold WIF work first requires the read-only
   `operation: plan` phase in Step 4.3. Existing identity reuse/repair may move
   directly from its exact approved plan to final `operation: execute`. A
   truly absent Entra identity must instead complete the separately approved
   serial `operation: identity-bootstrap`, then a fresh claim-driven plan and
   second approval, before final execute is eligible. Manual authentication
   never dispatches this worker, never requires or fabricates
   `sender-auth.json`, and remains customer-owned.
3. **iOS prerequisites** —
   `mobile-app:push-ios-prerequisites-worker`, eligible only for selected iOS
   whose exact Apple/APNs safe state is incomplete and whose complete
   parent-collected confirmation envelope is ready. Android-only work skips
   this track.

Do not dispatch a proven track. A parent-collected **No**, missing manual
action, or unsafe/missing approval keeps only that track incomplete; it does
not erase another platform's completed Firebase or runtime state.

#### 4.2 Preflight and deterministic fallback

After the exact Firebase join and before any planning or execution worker
starts, silently preflight all three fully-qualified agents with ordinary
`Task` requests. Put `operation: preflight` in each task prompt; do not use or
invent a `Task` API mode:

- `mobile-app:push-runtime-worker`
- `mobile-app:push-wif-worker`
- `mobile-app:push-ios-prerequisites-worker`

A preflight prompt contains only `contract_version`, `run_id`, `working_dir`,
`plugin_root`, exact `worker_name`, and `operation: preflight`. It must make no
cloud call, perform no mutation, inspect no project file, take no file
ownership, and write no file. Require `DONE`, one blank line, and exactly one
parseable `WORKER_RESULT` with `operation: "preflight"`,
`stage: "preflight"`, `status: "done"`, empty `identities`, `decisions`,
`changedFiles`, `validatedFiles`, `contextRequests`, `concerns`, and
`blockers`, one successful `capability-contract` validation, an empty memory
patch, and the exact worker-specific `capabilities` object:

- runtime: `supportedOperations` exactly `["preflight","execute"]`, all
  `preflightRequiresExecutionEnvelope`, preflight cloud/read/write,
  prompting/delegation, and memory-write flags false, `executeSupported:
  true`, `executeCloudAccess: "none"`, and
  `executeWriteScope: "exclusive-runtime-files-only"`;
- WIF: `supportedOperations` exactly
  `["preflight","plan","identity-bootstrap","execute"]`, all
  `preflightRequiresExecutionEnvelope`, preflight cloud/read/write,
  prompting/delegation, and memory-write flags false, `planSupported: true`,
  `planCloudReads: true`, `planMutations: false`, `planFileWrites: false`,
  `identityBootstrapSupported: true`,
  `identityBootstrapCloudMutations: true`,
  `identityBootstrapFileWrites: false`, `executeSupported: true`, and
  `executeWriteScope: "sender-auth.json-only"`;
- iOS prerequisites: `supportedOperations` exactly
  `["preflight","execute"]`, all `preflightRequiresExecutionEnvelope`,
  preflight cloud/read/write, prompting/delegation, and memory-write flags
  false, `executeSupported: true`, `executeCloudAccess: "none"`, and
  `executeWriteScope: "none"`.

Reject any missing or extra capability field, extra/reordered supported
operation, wrong boolean/string, nonempty state, wrong summary, or wrong
worker/run ID as unsupported. Bare agent names are invalid.

If `Task` is unavailable, any qualified eligible agent cannot be resolved, or
any preflight is malformed/unsupported, start **no execution worker**. Print
one concise fallback notice and use this deterministic serial fallback for
eligible tracks:

1. apply the iOS combined envelope through the internal orchestrated owner
   mode of `/setup-apns` once. That combined owner must apply
   `/setup-apple-ios` identity/capability/signing semantics before APNs
   semantics and return one final iOS `WORKER_RESULT`; do not invoke
   `/setup-apple-ios` separately or accept an intermediate Apple result;
2. execute runtime Steps 5-9 inline in the parent with the same exclusive
   paths, identities, and validations as the runtime worker;
3. for cold WIF, apply `/setup-push-wif` internal `operation: plan` and
   validate the read-only result. If it returns an identity bootstrap plan,
   obtain the narrow first approval, apply internal `operation:
   identity-bootstrap`, validate its safe generated identity receipt, then run
   a fresh internal `operation: plan` with that receipt and obtain the second
   approval. Apply internal final `operation: execute` only with the exact
   second approved plan and `sender-auth.json` as its only permitted local
   write. Reuse/repair keeps the shorter plan -> approval -> execute path.

Parse and validate fallback owner results exactly like worker results. If
preflight succeeded but an execution batch may have dispatched even one task,
do not enter fallback or duplicate any mutation. Join every definitely started
task; if dispatch/start state is uncertain or partial, return
`BLOCKED: push-worker-partial-dispatch-uncertain` and preserve the observed
files for reconciliation.

#### 4.3 Stage cold WIF, collect exact approvals, and freeze execution contracts

Generate one opaque `run_id` for the entire cold WIF chain and later execution
wave. First invoke `mobile-app:push-wif-worker` synchronously with `operation:
plan`. The initial planning prompt has no memory hash or exclusive files and
contains exactly:

```yaml
contract_version: 1
run_id: <same opaque wave id>
working_dir: <canonical absolute project root>
plugin_root: <absolute plugin root>
worker_name: mobile-app:push-wif-worker
operation: plan
plan_envelope:
  plan_phase: initial
  firebase_project_id: <exact>
  google_project_id: <exact>
  google_execution_mode: mcp|approved-allowlisted-cli
  azure_tenant_id: <exact>
  azure_subscription_id: <exact>
  resource_group: <exact>
  wif_pool_id: <exact>
  wif_provider_id: <exact>
  sender_service_account: <exact>
  entra_sender_display_name: <exact>
  entra_sender_client_id: <exact|null>
  key_vault_uri: <safe URI>
  key_vault_secret_name: <safe name>
  runtime_connection_principal: <exact>
  identity_bootstrap_receipt: null
```

This operation may make bounded cloud reads but must not mutate cloud state,
enable APIs, acquire file ownership, read or write memory, or write any file.
Validate one of only two exact successful plan stages under Step 4.5:

1. `stage: "sender-auth-plan"` for the existing-identity reuse/repair fast
   path. It must echo the non-null client ID and return the complete exact
   remaining `proposedPlan`.
2. `stage: "identity-bootstrap-plan"` only when the initial client ID is null
   and read-only inventory proves the exact named dedicated identity absent.
   It must return `identityBootstrapPlan` with only ordered Entra
   identity/credential and secret-safe Key Vault mutations, explicit
   `googleMutations: []`, explicit `apiEnablement: []`, and no
   `proposedPlan`.

For the bootstrap-plan path, use one parent `AskUserQuestion` call, grouped
with any other pending parent-owned questions, to display the exact named
identity, tenant/subscription/resource group, Key Vault URI/name, every
ordered bootstrap mutation, security impact, and rollback. State explicitly
that this first approval does **not** authorize any Google provider, API,
Google IAM, final runtime RBAC, four-stage proof, flow, or
`sender-auth.json` action. Obtain approval for that exact whole bootstrap plan.

Then invoke the WIF worker synchronously with the same `run_id`:

```yaml
contract_version: 1
run_id: <same opaque wave id>
working_dir: <canonical absolute project root>
plugin_root: <absolute plugin root>
worker_name: mobile-app:push-wif-worker
operation: identity-bootstrap
decision_envelope:
  approved: true
  approved_identity_bootstrap_plan: <exact unchanged identityBootstrapPlan>
```

This stage is serial and never part of the max-three execution batch. It has no
memory fields or exclusive files. Accept only `stage: "identity-bootstrap"`
with empty changed/validated files and memory patch, exact approval/identity
echoes, explicit empty Google/API lists, every required safe read-back
validation, and an `identityBootstrapReceipt` containing the server-generated
client ID and safe Entra/Key Vault identity fields. It must not return
`senderAuthPath`, proof completion, or any credential/token value. A malformed,
blocked, partially dispatched, or uncertain bootstrap is not retried or
replayed; preserve cloud state and require fresh read-only reconciliation.

After accepting bootstrap, invoke `operation: plan` again synchronously with
the same `run_id`. Its plan envelope repeats every original pin and changes
only:

```yaml
plan_phase: post-identity-bootstrap
entra_sender_client_id: <exact generated client ID>
identity_bootstrap_receipt: <exact unchanged accepted safe receipt>
```

The worker must freshly reread the generated identity and Key Vault metadata,
obtain a new app-only token through the stored credential, inspect it only on
stdin, observe exact `iss`, `aud`, and actual `appid`/`azp`, and inventory all
remaining Google/API/IAM and Azure runtime RBAC work. Accept only
`stage: "sender-auth-plan"` whose `proposedPlan` repeats the generated client
ID and exact bootstrap receipt and does not repeat completed bootstrap
mutations. Require its safe `claimContract` to contain the observed `iss`,
`aud`, selected `appid|azp`, application ID equal to the generated client ID,
and normalized Google provider issuer.

For either the fast path's first `sender-auth-plan` or the cold path's fresh
post-bootstrap `sender-auth-plan`, use a separate parent `AskUserQuestion`
call to display the safe pinned identities, Google execution mode, route,
resource group, Key Vault URI/secret name, runtime connection principal,
ordered remaining mutation list, ordered API-enablement list,
least-privilege role, and whether a broader FCM role is required. Obtain
approval for that exact whole remaining plan and a separate explicit Yes/No
decision for the broader role when required. The cold path must clearly label
this as approval #2. Do not ask the worker, summarize away an operation, reuse
bootstrap consent, or treat approval of `reuse`, one mutation, or one API as
approval of another.

If either plan returns `NEEDS_CONTEXT`, batch its stable requests into the
parent question and retry only that planning stage, at most twice. A malformed
or `BLOCKED` plan blocks only sender authentication; remaining eligible
runtime and iOS execution may continue.

Pass the accepted `sender-auth-plan`'s `proposedPlan` object unchanged. The WIF execution decision
envelope is exactly:

```yaml
decision_envelope:
  approved: true
  approved_plan: <exact unchanged proposedPlan object>
  broader_fcm_role_approved: true|false
```

The broader-role decision must be `true` exactly when
`broaderFcmRoleRequired` is true, and otherwise must be false. Any plan drift
or newly required operation returns `NEEDS_CONTEXT:
wif-route-approval-required`; never patch the approved object in place.

Only after the final remaining-plan approval is complete, reread the raw bytes of
`memory-bank.md` and calculate the single pre-wave SHA-256. Every execution or
execution retry prompt must include:

```yaml
contract_version: 1
run_id: <same opaque wave id>
working_dir: <canonical absolute project root>
plugin_root: <absolute plugin root>
operation: execute
memory_bank_path: <working_dir>/memory-bank.md
memory_bank_sha256: <pre-wave SHA-256>
worker_name: <exact fully-qualified worker>
exclusive_files: [<exact absolute paths>]
decision_envelope: <complete immutable worker-specific envelope>
```

Use each already-defined worker contract without renaming fields:

- runtime receives selected platforms, plan path, proven OID property path,
  exact Android channel, approved HTTPS origin or `null`, exact
  settings-surface and navigation-sender files, Firebase project, and selected
  immutable Android/iOS app IDs. Its exclusive list may contain only the
  expected Steps 5-9 files named by the runtime worker contract;
- WIF receives only the exact approval envelope above. All Firebase/Google,
  Azure, pool/provider, sender-account, Entra, Google execution mode, route,
  resource-group, Key Vault, runtime-principal, mutation, API-enablement, and
  role decisions come from the unchanged `approved_plan`. Its exclusive list
  is exactly `<working_dir>/sender-auth.json`;
- iOS receives exact Firebase project/iOS app/bundle/plist identity, Team,
  selected modes, every mode-aware Apple confirmation, `.p8` or `.p12`
  selection, safe conditional Key ID/environment fields, upload attestation,
  and timestamps. Its exclusive list is empty.

Reject missing envelope fields before dispatch. Resolve every path
canonically, require it under `working_dir`, reject symlinks where the worker
contract rejects them, and ensure no path belongs to two tracks.

#### 4.4 Dispatch at most three tracks

When two or three execution tracks are eligible, emit all their fully-qualified
`Task` calls in one bounded batch/message so they run concurrently; the batch maximum is three.
A parent-approved WIF `operation: execute` may run alongside
the remaining eligible runtime and iOS work. WIF `operation: plan` is never
part of this execution batch. When exactly one track is eligible, use one
synchronous worker, or the one-track owner/inline path above when dispatch is
unavailable. Never manufacture another task for symmetry.

From dispatch until accepted join, the parent must not read, edit, validate,
delete, or transfer a worker's exclusive files. Join all started tracks even
when one reports a blocker so successful independent branch progress is not
lost.

#### 4.5 Parse and validate every return

Require the literal first line to be exactly one of:

```text
DONE
DONE_WITH_CONCERNS: <comma-separated concerns>
NEEDS_CONTEXT: <stable reason code>
BLOCKED: <reason>
```

After one blank line, require exactly one single-line `WORKER_RESULT: {...}`
and no extra prose. Parse it as JSON and validate all of the following before
accepting any claimed progress:

- `contractVersion`, fully-qualified `worker`, `runId`, `operation`, canonical
  `stage`, and JSON `status` agree with the invocation and literal first line;
- status mapping is exact: `DONE` -> `done` with all three status arrays empty;
  `DONE_WITH_CONCERNS: a,b` -> `done_with_concerns` with the same nonempty
  ordered `concerns` and the other two arrays empty; `NEEDS_CONTEXT: code` ->
  `needs_context` with exactly `[code]` in `contextRequests`; and `BLOCKED:
  reason` -> `blocked` with exactly `[reason]` in `blockers`;
- every pinned Firebase, platform, app, bundle, Team, Google, Azure, WIF, and
  file identity applicable to the track exactly matches its decision envelope;
- `changedFiles` is unique, canonical, inside the project, and a subset of
  that track's exclusive allowlist; iOS `changedFiles` remains empty;
- required track-specific result fields, validations, proof flags, platform
  states, validated files, context requests, concerns, blockers, and summary
  are present and safe;
- `memoryPatch.sections` contains only the non-secret owner fields allowed by
  that worker contract and contains no credential, token, account, device,
  prompt, raw output, path-to-credential, or unknown field.

Maintain an explicit WIF stage state for the shared `run_id`. The only accepted
transitions are `preflight -> sender-auth-plan -> sender-auth` for reuse/repair,
or `preflight -> identity-bootstrap-plan -> identity-bootstrap ->
sender-auth-plan -> sender-auth` for a truly absent identity. Parent approvals
sit between each mutating transition. Reject an out-of-order, repeated,
different-run, or skipped result as `BLOCKED`; never infer a missing stage from
live files or cloud state.

For WIF `operation: plan`, additionally require `capabilities: null`, empty
changed/validated files and memory patch, and exact top-level
identity/decision echoes. Accept only:

- initial `stage: "identity-bootstrap-plan"` when the requested client ID and
  receipt are null and the exact named identity was proven absent. Require no
  `proposedPlan`, one exact `identityBootstrapPlan`, exact equality to its
  identity/decision echoes, ordered bootstrap-only mutations, and explicit
  empty `googleMutations` and `apiEnablement`;
- `stage: "sender-auth-plan"` for a non-null existing identity or after an
  accepted bootstrap receipt. Require exact equality between the plan envelope
  and `proposedPlan.identities` / `proposedPlan.decisions`, the safe complete
  remaining route, ordered approval lists, role decision, and inventory
  timestamp. A post-bootstrap plan must exactly echo the generated client ID
  and accepted receipt and must include a successful `fresh-entra-claims`
  validation. Its safe `claimContract` must contain exact observed `iss`,
  `aud`, `selectedAppClaim`, matching application ID, and normalized provider
  issuer.

Reject any other plan stage, prose-only or wildcard diff, bootstrap mutation
repeated in the remaining plan, or a post-bootstrap plan accepted before the
matching bootstrap result.

For WIF `operation: identity-bootstrap`, require `stage:
"identity-bootstrap"`, `capabilities: null`, exact equality to the unchanged
approved bootstrap plan, `approved: true`, empty changed/validated files and
memory patch, explicit empty Google mutation/API lists, and the exact safe
validations for plan equality, Entra identity read-back, non-disclosing
credential storage, Key Vault metadata read-back, and no Google mutations.
Require a safe `identityBootstrapReceipt` with generated client/app/service
principal IDs, application ID URI, credential expiry, and Key Vault URI/name.
Reject `senderAuthPath`, proof fields, local paths, credential material,
missing generated identity, or any result received without the accepted
initial bootstrap plan.

For WIF `operation: execute`, require `stage: "sender-auth"`, exact equality
to the unchanged approved plan, `approved: true`, the exact route, ordered
mutation/API lists, execution mode, role fields, resource group, Key Vault
URI/name, runtime connection principal, and inventory timestamp. Require
the exact plan phase and bootstrap receipt; a post-bootstrap execute is invalid
unless the parent previously accepted the matching bootstrap and fresh plan.
Require the unchanged safe `claimContract` from the approved plan and
`senderAuthPath: "sender-auth.json"`, `senderAuthMode: "wif"`,
`changedFiles` and `validatedFiles` to contain only the normalized
project-relative `sender-auth.json`, and resolve each against `working_dir`
before comparing it with the absolute exclusive path. Require all four
execution validations, `proofComplete: true`, and safe current `verifiedAt`
and `validUntil`. Never compare an absolute prompt path directly with a
project-relative result path.

A missing, duplicate, malformed, wrong-worker, wrong-run, wrong-stage,
status-mismatched, identity-drifted, or unexpected-path result is `BLOCKED`;
never infer success from files on disk.

#### 4.6 Batch context requests and retry only affected tracks

Collect all valid `NEEDS_CONTEXT` results from the joined wave before asking
anything. Use one parent `AskUserQuestion` call that identifies each affected
track and contains the bounded questions/confirmations in canonical order.
Keep separately confirmed Apple manual actions as separate Yes/No entries
inside that one parent call; never collapse them into blanket consent.

Update only the affected immutable decision envelope, then redispatch only
those workers, again in one batch of at most three. Preserve the same
`run_id`, exclusive paths, successful results, and unaffected branch state.
Allow at most two retries per worker; a third `NEEDS_CONTEXT` is `BLOCKED`.
Never auto-retry `BLOCKED`, malformed output, identity drift, cloud mutation,
or a changed approval route.

For WIF, never edit an approved stage plan in response to `NEEDS_CONTEXT`.
Before any bootstrap mutation, a valid context request may update only the
initial planning inputs and rerun planning, within the two-retry cap. Once
identity-bootstrap dispatch may have started, never retry or replay that
mutation stage; require a fresh read-only inventory to classify the observed
partial or completed state. For final execution context, return to read-only
`operation: plan`, validate a fresh exact proposal, display and approve it
through the parent, and only then retry `operation: execute` with the unchanged
replacement plan. If a required broader role is not approved, do not dispatch
WIF execution; record sender authentication as incomplete while continuing
independent eligible work.

#### 4.7 Independently revalidate and merge once

After all retries finish, independently revalidate each accepted successful
track before trusting its memory patch:

- for runtime, rerun TypeScript, strict push-client validation, and
  changed-file validation with every accepted changed file listed, and
  recheck selected Firebase/Expo/OID/channel identities;
- for WIF, rerun the sender-auth contract validator against the exact Firebase
  project and require the returned fresh four-stage proof fields. For manual
  auth, confirm no managed handoff was required or fabricated;
- for iOS, reevaluate Expo bundle/plist identity, run the bounded push-config
  checks for each selected mode, and compare only the safe parent
  attestations. Preserve the exact labels **user-confirmed; not portal proof**
  and **configured, device verification pending**; never inspect APNs or
  signing credentials.

Revalidation failure blocks only the affected stage/platform unless it proves
shared Firebase identity drift. Preserve accepted Android progress when iOS is
blocked, preserve accepted runtime progress when sender auth is blocked, and
preserve successful worker-created files for safe resume.

Immediately before memory mutation, recompute `memory-bank.md` SHA-256 and
require exact equality with the pre-wave hash. Hash drift blocks the merge;
never overwrite or three-way-guess concurrent memory changes. Otherwise,
validate all accepted patches, order them by canonical lifecycle
(`ios-prerequisites`, `runtime-integration`, `sender-auth`), and apply them in
one parent edit to `memory-bank.md`. Include accepted concerns and
platform-specific blockers without promoting them to success. Run changed-file
validation for `memory-bank.md` after that single merge. Workers and fallback
owner modes must never write it themselves.

### 5. Write the wrapper and shared navigation module

Steps 5-9 are the canonical runtime execution specification. The runtime
worker applies them when dispatched. The parent applies them only for the
deterministic inline fallback and must not touch runtime exclusive files while
a worker may own them.

Create `src/navigation/linkContract.ts` first. Use the approved screen plan's
Navigation Contracts table to define stable kebab-case destination IDs, exact
typed parameter schemas, authentication requirements, router intent, and the
only destination-to-Expo-Router-href mappings. Implement the non-throwing
in-app, configured custom-scheme, approved HTTPS, and FCM-data parsers plus one
dispatcher from `navigation-link-contract.md`. Never expose a raw route as an
external destination.

Ask for an HTTPS origin before adding App Link/Universal Link configuration;
never guess one. When provided, add exact Android `intentFilters` and iOS
`associatedDomains` settings, then guide the customer to host the platform
association files. Record parser, native config, customer-confirmed association
files, and physical installed-build verification separately.

Create `src/native/pushNotifications.ts` using the required surface and result
types from the push contract. It must:

- use the stable generated imports `import * as Notifications from
  'expo-notifications'` and `import messaging from
  '@react-native-firebase/messaging'`; strict validation follows those imports
  into concrete reachable calls in each required function and does not accept
  markers, export names, hardcoded result objects, constant-false branches, or
  calls placed after an unconditional return as implementation proof
- preserve the template `firebase.json` settings that disable native Messaging
  auto-init and iOS automatic remote-message registration before consent, plus
  its Android default notification channel ID
- create the Android channel before requesting permission, using visible,
  non-silent importance such as `Notifications.AndroidImportance.DEFAULT` or
  `HIGH`; use the same app-owned channel ID in `setNotificationChannelAsync`,
  foreground schedule triggers, and
  `firebase.json` `messaging_android_notification_channel_id` rather than
  inventing a validator-specific fixed ID
- on iOS, sequence granted permission -> remote-message registration when
  required -> enable auto-init -> token acquisition -> exact topic sync
- treat permission denial and missing remote-message registration as explicit,
  non-throwing outcomes; never call `getToken` before registration
- listen for token refresh and re-run exact topic sync from current auth state
- implement the exact `allUsers`/OID transitions
- persist consent + last topic only; never persist an FCM registration token
- keep foreground/token-refresh/response listeners idempotent in the single
  React provider and clean up every subscription exactly once
- inside the `messaging().onMessage` callback, validate `message.data` and
  explicitly `await Notifications.scheduleNotificationAsync(...)` for visible
  immediate local foreground presentation; use an Android trigger whose
  top-level `channelId` is the shared app-owned channel and which has no time or
  calendar fields, keep the schedule inside a non-throwing `try`/`catch`, and
  preserve `message.data ?? {}` in notification content for later response
  navigation
- configure `Notifications.setNotificationHandler` and `messaging().onMessage`
  on Android-reachable paths; the handler must return both
  `shouldShowBanner: true` and `shouldShowList: true` to allow banner/heads-up
  presentation and notification-center/list retention. Parsing alone,
  scheduling elsewhere, or merely installing a handler that suppresses either
  presentation surface is not proof
- export a non-throwing `handleBackgroundNotification` for the early entry
  point; it validates data and never navigates
- parse every notification navigation intent through
  `src/navigation/linkContract.ts` before returning it
- never throw into a screen

Assign and await every value-returning native operation, then use that value in
a later branch or returned validated outcome. In particular, inspect permission
results before continuing, reject an empty `getToken()` result before topic
sync, and pass the assigned cold-start response into the shared deep-link
validator. Await side-effecting native calls inside `try` and return a failure
discriminant from `catch`; an ignored call followed by `{ ok: true }`, an
always-success catch, a throw-only body, or a canned result is invalid.

Keep the permission query in `getPushPermissionState`, the consent/register/
auto-init/token sequence in `requestPushPermission`, topic subscribe and
unsubscribe calls in `syncPushTopic`, listener registration in
`registerNotificationHandlers`, background validation in
`handleBackgroundNotification`, and cold-start response consumption in
`consumeInitialNotificationIntent`. Each native-facing operation catches
package failures and returns the documented discriminated result. Do not
replace these paths with empty functions, hardcoded results, comments, or
implementation markers.

If the wrapper already exists, inspect and update it idempotently; do not append
duplicate listeners.

Update the package entry point (the template uses `index.js`) so
`setBackgroundMessageHandler` is registered before
`require('expo-router/entry')`. Replace the template's
`unconfiguredBackgroundHandler` no-op with a direct project-local require of
`handleBackgroundNotification` from `src/native/pushNotifications.ts`, then pass
that exported function to `setBackgroundMessageHandler`. The generated wrapper,
not `index.js`, owns the implemented handler body. The entry point must not
import React state or require auth/router readiness. Never move registration into
`app/_layout.tsx`, a provider, or a hook.

### 6. Add permission UX

Update `app/login.tsx` with the pre-permission card. Preserve the existing sign
in button and auth error handling. Add or update an app settings/profile screen
with current permission status and enable/open-settings actions.

### 7. Wire lifecycle

Add one provider/hook under `src/hooks/` that observes auth readiness,
sign-in/OID changes, sign-out, consent, and token refresh. Mount it once inside
`app/_layout.tsx` under `PowerAppsProvider`. Preserve provider ordering. The
provider owns foreground, token-refresh, and response subscriptions only;
background registration remains in the early entry point.

The generated lifecycle owner must call both `registerNotificationHandlers()`
and `syncPushTopic(...)`, export a named push/notification hook or Provider,
and be mounted exactly once under `app/`. Strict validation rejects direct
layout-only listener registration, missing lifecycle topic sync, and duplicate
mounts.

### 8. Wire navigation sources

Register one warm response listener and consume the Expo Notifications
cold-start response once. Also consume initial and live custom-scheme/approved
HTTPS URLs. Funnel all external sources through the shared parser, source-aware
deduplication, and pending-intent guard. Use Expo Router only after contract
validation and router/auth readiness; never navigate from the background
message handler. Invalid or stale intents are rejected without fallback
navigation.

Expose the typed in-app helper from the same module. Existing screen actions
that target registered semantic destinations must use it rather than
hand-building router paths.

### 9. Validate

Run:

```bash
npx tsc --noEmit
node "${PLUGIN_ROOT}/scripts/validate-push-notification-config.js" \
  --project-root . --strict-client-integration
node "${PLUGIN_ROOT}/scripts/validate-mobile-files.js" --project-root . \
  --file src/navigation/linkContract.ts \
  --file src/native/pushNotifications.ts \
  --file app/_layout.tsx \
  --file app/login.tsx
```

Add every other changed file explicitly to the final validator call.

### 10. Continue through downstream owners

After strict runtime validation succeeds, continue only as far as the selected
stopping point:

1. For **Create delivery flows** or later, invoke
   `/create-push-notification-flow --working-dir <root>` synchronously. Pass
   the already selected sender-auth route so that owner does not ask the
   sender-auth question a second time. For WIF, require the independently
   revalidated worker/owner handoff. For manual authentication, preserve the
   owner's stopped-flow/customer-configuration behavior and never inspect
   credentials or require `sender-auth.json`.
2. For **Build for device** or later, invoke `/build-android` and/or
   `/build-ios` for selected platforms whose stages 1-5 are ready, in
   deterministic Android-then-iOS order. Preserve platform independence: an
   iOS Apple/APNs blocker must not prevent an otherwise ready Android build,
   and an Android blocker must not rewrite iOS state.
3. For **Verify end to end**, invoke `/verify-android-push` and/or
   `/verify-ios-push`, in deterministic Android-then-iOS order, only after
   each exact current artifact is ready and the owner-required installation handoff is complete.

After every owner returns, reread its project-local handoff and resume from the
first incomplete stage. A shared flow blocker stops both platforms'
flow-dependent continuation; a platform build/verification blocker stops only
that platform while the other safe branch may continue. Never auto-retry an
owner blocker, replace it with a less safe fallback, or merely print the next
slash command when the owner can be invoked in the current session. In
particular, do not merely print the next slash command; invoke the owner when
continuation is safe in the current session.

### 11. Update memory bank and report lifecycle status

Update `memory-bank.md` with packages, Firebase project ID (not credentials),
permission UX, topic policy, navigation schema version/destination registry,
custom-scheme/HTTPS configuration state, and validation status.

Do not reapply worker `memoryPatch` sections here: Step 4 performs their one
ordered parent merge. This final update records only subsequent sequential
owner handoffs and the final lifecycle summary, while preserving every
successful branch and every unresolved platform-specific blocker.

Apply the canonical states and resume rules from `push-lifecycle.md`. Report
one compact row per selected platform plus one shared delivery row:

| Scope | Report |
|---|---|
| Android | Firebase client; runtime integration; wrapped build; physical delivery |
| iOS | Firebase client; Apple/APNs capability; runtime integration; wrapped build; physical delivery |
| Shared delivery | Sender authentication; producer/sender flows |

For each incomplete item, report the owning stage and whether this run stopped
because it reached the selected stopping point, needs a user-managed action, or
hit a blocker. Do not end with a list of commands the user must manually chain.
When continuation is possible in-session, invoke the owner instead.

Keep these distinctions explicit:

- `configured, device verification pending` is not physical iOS delivery.
- Firebase acceptance, an outbox `Sent` state, Metro, Expo Go, or simulator
  behavior is not physical-device proof.
- A customer-owned Power Automate sender may continue only with the exact
  plugin-created sender flow ID and safe FlowAgent read-back recorded as
  `customer-owned Power Automate sender / observable contract read back;
  authentication not plugin-validated`.
- Manual sender authentication never requires or fabricates
  `sender-auth.json`, and this workflow never inspects its credentials.
