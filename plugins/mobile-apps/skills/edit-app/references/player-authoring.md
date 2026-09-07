# Contextual Player editing and teaching

This profile runs the existing foreground `/edit-app` in the bridge-managed
candidate workspace. It does not start another planner or teaching agent.
The one-screen builder keeps the create flow's sealed target-at-init,
baseline, channel, and bounded retry conventions.

Read the shared
[`mobile-authoring.md`](../../../shared/references/mobile-authoring.md)
first. It overrides every nested foreground question surface while a Player
descriptor is present. Direct CLI/VS Code editing without that descriptor
continues to use the normal `/edit-app` workflow and question tool.

## 1. Verify the captured app and scope

```bash
node "${PLUGIN_ROOT}/scripts/mobile-authoring.js" verify
node "${PLUGIN_ROOT}/scripts/authoring-edit.js" inspect --intent general
```

Use `--intent background`, `layout`, or `teach` for those explicit intents.
Inspection is read-only. The helper compares the workspace source to the
descriptor's exact `baseRevision`, validates minimal runtime context, and
checks selected screen/route/target/action IDs against current compiled packs,
the app's semantic registry, and declared domain.

The derived app-owned semantic registry is `.tmp/authoring-registry.json`.
The configurator compiles it from canonical screen routes, explicit assigned
source files, and each screen's exported literal `authoringTargets`; never
hand-author its targets or infer them from rendered pixels:

```json
{
  "schemaVersion": 1,
  "appInstanceId": "<stable-app-id>",
  "screens": [
    {
      "screenId": "work-list",
      "route": "/work",
      "sourceFile": "app/(app)/work/index.tsx",
      "targets": [
        { "id": "work-list.collection", "label": "Work items", "role": "collection" }
      ]
    }
  ]
}
```

This local source mapping is not sent in runtime context. The wire carries
app/job/preview IDs, stable semantic IDs, a canonical route, and at most a
minimal `{conceptId, recordId, label?}` reference. Do not include field values,
full records, photos, tokens, URLs with record data, or source paths. Runtime
selection comes from registered targets, not React internals or pixels.

- **App background:** default to global styling even when a record is selected.
- **Selected list layout:** default to that registered collection only.
  Preserve collection query/filter/sort, paging, actions, navigation, IDs,
  error handling, and refresh behavior.
- **No registered target:** use generic app chat. Ask one small clarification
  with existing screen names before targeted work; never invent a screen or
  infer Dataverse from the rendered content.
- **Old app/revision, unknown target, or mismatched action:** stop and recapture
  context. Keep the last-good preview; do not silently retarget the edit.
- **Unsaved changes:** keep the warning visible in the proposal. Preparing a
  candidate is not permission to discard active drafts.

## 2. Read-only proposal before source changes

Do the existing health and impact analysis, but keep draft proposals and
questions under `.devplayer-builder/logs/authoring-input/` until preparation
is approved. Do not restamp canonical contracts or edit TSX yet. Those are
candidate mutations, not part of asking permission.

Write one bounded proposal JSON:

```json
{
  "schemaVersion": 1,
  "kind": "target-layout",
  "summary": "Show this work collection as cards, keeping its filters, paging, actions, and navigation.",
  "screenIds": ["work-list"],
  "allowedFiles": [
    "app/(app)/work/index.tsx",
    ".tmp/screen-build-pack.json",
    ".tmp/compiled-screen-build-pack.json",
    "native-app-plan.md",
    "memory-bank.md"
  ]
}
```

```bash
node "${PLUGIN_ROOT}/scripts/authoring-edit.js" prepare \
  --input .devplayer-builder/logs/authoring-input/proposal.json

node "${PLUGIN_ROOT}/scripts/authoring-edit.js" authorize --plan <returned-plan-id>
```

Kinds are `global-style`, `target-layout`, `screen`, `business-rule`, and
`integration`. The last kind requires the descriptor's exact catalogue
selection and is described below; do not copy a selection into proposal JSON.
Allowed files are exact project-relative files, never directory grants,
globs, live preview roots, or generated-service escape hatches. Global styling
uses app-owned brand/theme/tokens plus its plan projections. A selected
collection grants only its registered source file plus affected canonical
planning projections. Broader file needs require a revised proposal.

`prepare` creates a sealed proposal, source baseline, and bounded backups; it
does **not** edit app code. `authorize` asks the maker through the blocking
shared adapter. Its signed decision binds the immutable proposal and complete
base source manifest. A revise/reject answer does not enable mutation.

The question is **“Prepare this edit?”**, not “Apply it.” There is no schema,
data-import, or deployment consent hidden inside this question.

## 3. Prepare using the existing foreground delta workflow

After preparation approval:

1. Apply `/edit-app`'s narrow canonical invalidation cascade and recompile only
   affected contracts/packs. The compiled contracts—not plan prose—remain the
   execution authority.
2. Reopen required logical gates when their contents change. Native, connector,
   architecture, or persistence ownership changes reopen Gate 1 and invalidate
   stale local pipeline bindings through the existing helper. Preserve remote
   evidence and the immutable canonical Dataverse schema/separate execution
   schema. Each reopened gate still needs its exact maker receipt in Player.
3. Execute only approved local/native/design prerequisites. Ordinary local prototypes
   use app-owned repositories and never resolve/init an environment, fabricate
   `src/generated`, seed remote data, or silently promote to Dataverse. An
   explicitly selected connector instead follows the bounded connected
   preparation below; it still cannot provision Dataverse or import data.
4. Use the existing sealed one-screen work order for every affected screen.
   Preserve its target-at-init existence and compiling baseline. A child never
   expands file scope or answers maker questions.
5. Run the existing TypeScript, contract, route, native, and screen-quality
   gates selected by the delta. A rule or visual edit does not relax them.

```bash
node "${PLUGIN_ROOT}/scripts/authoring-edit.js" check --plan <sealed-plan-id>
```

This checks the complete current source delta against the approved file set.
For a collection layout it also compares existing TypeScript data/navigation/
action/paging call expressions and preserves the compiled pack's protected
actions, route, navigation, and data assumptions. App dependencies must be
installed for that TypeScript parse; there is no parser-failure bypass.
This structural check supplements—not replaces—foreground behavior review
and the existing gates. It cannot prove all runtime behavior.

Out-of-scope changes are a stop. Preserve them and revise the proposal; do not
recursively restore the project, delete remote journals, or claim atomic
multi-file rollback. The active preview stays unchanged.

For a new route, a `screen` or `integration` proposal may add up to five
`newScreens`, each `{screenId, route, sourceFile}`. Include every ID in
`screenIds`, the exact new source file in `allowedFiles`, and only needed
ancestor layouts. IDs/routes must be unique and each source must not exist
at proposal time. After approval, create the compiling skeleton first, then
initialize the existing sealed one-screen work order against that actual
target. This does not weaken the worker's existence-at-init invariant.

### Derived authoring output scope

A screen or integration proposal that changes registration—including any
new screen—must explicitly include the complete derived output set:

- `.tmp/authoring-registry.json`
- `.tmp/mobile-authoring-runtime.json`
- `src/authoring/registry.ts`

The assigned screen builder authors only its own TSX, including literal
metadata such as:

```tsx
export const authoringTargets = [
  { id: 'work-list.collection', label: 'Work items', role: 'collection' },
] as const;
```

That same TSX must register its real screen through `AuthoringScreen` or
`useAuthoringScreen`, bind actual usable/dirty state, and instrument each
declared target through `AuthoringTarget` or `useAuthoringTarget`. Preserve
layout/scroll measurement handlers. See the
[runtime integration contract](../../../scripts/templates/mobile-authoring/README.md).
Metadata alone is not a rendered target or readiness signal.

The foreground, not a sibling screen worker, runs the configurator after
each completed screen wave and before publication, including after new
screens and conversion. The sealed proposal's `authoringSources` supplies
the complete explicit screen/source mapping; pass each assignment, not a
filename guessed from a route:

```bash
node "${PLUGIN_ROOT}/scripts/configure-prototype-authoring.js" \
  --project-root . \
  --screen-source "work-list=app/(app)/work/index.tsx" \
  --ready-screen work-list
```

Repeat `--screen-source` for every compiled screen. Repeat `--ready-screen`
only for completed screens in the wave. A skeleton may exist without an
export, but it cannot pass the ready check without an explicit
`authoringTargets` array and usable screen registration. `--ready-screen`
checks that claim; it cannot make an unready skeleton ready. The configurator
preserves the inactive standalone stamp; it does not mint an active publisher
stamp or a mounted-screen ACK.

Initial runtime installation requires `authoringRuntime: "install"` in the
proposal; updating existing compiler-owned runtime helpers requires
`authoringRuntime: "upgrade"`. In either case explicitly include the three
derived files, `src/authoring/index.tsx`, `src/authoring/controller.ts`,
`src/authoring/README.md`, `app/_layout.tsx`, and `tsconfig.json`. Only the
two owned authoring import aliases may change in TypeScript configuration.
When no registry exists, supply `authoringSources` as a complete array of
`{screenId, sourceFile}` assignments from the approved work orders.
Explicitly include every screen TSX the configurator must change to bind
layout/scroll handlers. Runtime installation/upgrade does not grant arbitrary
screen writes; unapproved changes require a revised proposal.

Ordinary metadata refresh cannot overwrite runtime helpers. Scoped checks
compare all derived outputs with the actual compiler and authored source,
using the sealed source assignments—not mutable registry hashes as approval.

Keep operational work orders, results, snapshots, and bounded worker backups
under `.devplayer-builder/logs/` using the existing helpers' input/output/state
flags. Keep their canonical source inputs under `.tmp/`. This avoids including
mutable worker journals in source approvals. Name any required canonical
preview, registry, plan-status, or pipeline sidecar in the exact proposal
scope before writing it; the scope checker does not ignore arbitrary `.tmp`
changes. Do not delete older worker or remote execution evidence.

## 4. Catalogue-selected native and connector additions

When `verify`/`inspect` returns `integration`, use `kind: "integration"` and the
returned fixed route. Do not reinterpret it as a generic style edit, call an
arbitrary command from the descriptor, or ask the maker to select the same
connection again. Clarify only placement, existing dataset/list, operation,
and other missing details through Player.

1. Seal and authorize an exact file proposal as above. Include affected
   architecture/persistence/plan projections and normal gate-status sidecars.
   A wrapper-only native add includes the selected actual output. Retained
   local photo capture uses `src/data/capture.ts`, not a guessed `src/native`
   alias, including in an initialized connector profile.
   A UI control needs an existing or explicitly proposed screen. A connector
   names its expected official generated service/schema files; missing app
   configuration explicitly includes `power.config.json`. Its proposal also
   supplies `connectorName`, the exact semantic architecture owner. This name
   is sealed alongside the official selected API ID; never derive it from a
   display label or assume it equals the provider API ID.
2. Reopen Gate 1 through the existing invalidation path. Update architecture
   to explicitly approve the selected native ID or connector API. Review
   current canonical architecture and persistence using
   `mobile-authoring.js request-question --input <gate-json> --record-gate 1`.
   Preparation consent does not substitute for this gate.
3. Verify the authorized foreground handoff:

   ```bash
   node "${PLUGIN_ROOT}/scripts/authoring-edit.js" integration \
     --plan <sealed-plan-id> --gate-receipt <verified-gate-1-receipt>
   ```

   `authorized-handoff` means neither “generated” nor “applied.” Execute the
   returned existing foreground skill with its structured inputs, preserving
   this job's descriptor and question transport:

   | Selection | Foreground owner |
   |---|---|
   | Native capability | `/add-native` with the exact capability ID; explicit prototype mode when local |
   | Existing SharePoint connection/reference | `/add-sharepoint` with the selected environment and existing-connection/resource-only inputs |
   | Other non-Dataverse connector | `/add-connector` with those exact inputs |
   | Dataverse | Separate explicit Connect to Dataverse operation; not this catalogue path |

   Connector inputs map to `--existing-only --environment-id <id> --api-id <api>
   --catalog-revision <sha256>` plus exactly one `--connection-id <id>` or
   `--connection-ref <name>`. Preserve the selected reference in final SDK
   configuration; a verified bound connection ID is for metadata discovery
   only. Do not substitute a newly fetched or self-authored catalogue revision
   for the bridge-bound selection.
   Preserve the sealed `connectorName` for the actual startup owner's
   `--connector-name` input. Gate 1 must approve that same semantic owner;
   an unrelated approved connector or conflicting explicit API binding blocks.

4. Native workflow support derives from the selected template's `package.json`,
   friendly-label policy, and compatible app dependencies. No extra device
   ABI/method inventory or optional probe is required to browse or select a
   supported workflow. Preserve runtime bans and honestly handle permission
   denial or unavailable hardware; package support is not a hardware test.
   Do not install/upgrade dependencies or change native app configuration.
   Follow existing field-ownership
   rules when a Dataverse field uses a host-owned control rather than a raw
   Expo picker. Native handoff selects the initialized path when
   `.tmp/prototype-profile.json` has `profile: "connector"`, even if logical
   persistence remains `local-prototype`; do not pass the no-environment
   `--prototype` flag for that initialized profile.

   For a selected local camera/gallery refresh, include `src/data/capture.ts`,
   `.tmp/prototype-generated.json`, and `.tmp/data-access-registry.json` in
   the same approved proposal. A connector profile also includes
   `.tmp/prototype-connector-startup.json` for its input-revision rebind.
   Include `.tmp/scenario-facts.json` if its canonical revisions need rebinding;
   its record/fixture payload must not change.

   After the existing `integration` handoff, use the bounded preparation step:

   ```bash
   node "${PLUGIN_ROOT}/scripts/authoring-edit.js" capture --plan <sealed-plan-id>
   ```

   This reuses the actual capture/registry producers without broad prototype
   regeneration, which would also rewrite fixture revision metadata. It
   preserves sample-data, model, rule and repository bytes and existing connector
   selection/configuration/namespaces. It neither opens a camera nor stores
   a photo. Resume accepts only sealed before/after bytes; conflicting source
   is preserved. Continue the existing foreground native/UI workflow, not
   another planner or pipeline.
5. An existing connector selected for a local prototype explicitly crosses
   into connected preparation. Use official environment/init/service
   generation, retain every local repository/rule/media namespace and existing
   screen, and wire the supported SDK/provider startup without replacing local
   adapters. Existing app configuration must match the selected environment.
   Connection/schema metadata reads still require their owning artifact-bound
   access approval and scoped broker grant; the handoff is not that grant.
   Business-data probes, connection creation, SharePoint list/column creation,
   Dataverse provisioning, and record/photo imports remain prohibited. Do not fake
   `src/generated`, change persistence mode by hand, or treat `mixed` alone
   as proof that Dataverse exists. Unsupported startup/ownership combinations
   block rather than silently discarding local data.
   After official SDK configuration/schema generation, use the actual
   `stage-prototype-connector.js` owner with the verified catalogue/selection,
   sealed connector name, authorized isolated candidate `DataPreview`, and
   explicit local reference when ambiguous. Its current-root provider
   replacement must preserve existing AuthoringProvider/UI, not restore an
   old template or nest duplicate theme/query providers.

   Name its exact outputs in the proposal: the current root, new
   `PrototypeConnectorProvider.tsx`, `ConnectorPreviewBoundary.tsx`,
   `connector-startup.json`, and the owner's startup/profile/ownership/registry
   sidecars. Only that owner may generate them. The edit guard permits only
   `dev:prototype` removal from `package.json` and revision-only rebinding of
   scenario facts; changing local fixture payloads or existing model/adapter/
   hooks/runtime/provider files is outside this connector scope.
   The owner may restore `app/login.tsx` and `app/oauth-callback.tsx` from the
   saved supported template only when absent at proposal time; explicitly
   name each missing route in the approved file set. Existing auth UI must
   not be overwritten or deleted. Gate the new connector UI/actions with
   `useAuth` and offer `/login`; do not put a global sign-in gate over local
   screens. Run the owner's read-only verification before candidate submission.
   Once the profile is `connector`, use `stage-prototype-connector.js --verify`
   (or `verifyPrototypeConnectorStartup`), not `generate-prototype --check`
   or the no-environment prototype preflight. An action-only connector needs
   no invented persistent concept or forced persistence-mode change.
6. Refresh only actual official generated signatures, recompile affected
   contracts, run the owning SDK/native checks and required downstream gates,
   and build approved screens using the same sealed worker. Unexpected
   generator outputs require a revised scope; do not accept them silently.
   `check` re-verifies preparation and current canonical Gate 1, exact
   selection, dependency/local-ownership preservation, and implementation
   outputs. File presence does not attest authenticated runtime access.
7. Submit the source-bound candidate below. The maker previews it, then makes
   the separate bridge-owned Apply/Discard decision.

On opening the Connector sheet, the maker-side GET runs the existing
read-only `/list-connections`; it does not need an SDK metadata grant.
A successful empty list offers manual connection creation in the Power Apps
portal, **Refresh**, and the
[official supported connector types](https://learn.microsoft.com/en-us/connectors/connector-reference/connector-reference-powerapps-connectors).
Auth, permission, network or SDK errors are errors, not empty results.
Never create a connection automatically or introduce another discovery flow.
The catalogue's `controls.canAdd` is separate from browsing readiness; even
when Add is available, this edit still needs all source-bound approvals.
No static list or package inventory is a live connection inventory.

## 5. Teaching is the same scoped candidate

Use `.tmp/prototype-domain.json` and `.tmp/prototype-rules.json` as the logical
domain/rule authority in both local and connected apps. Inspect real entity,
action, field, and choice IDs. Ask through the shared adapter when the action,
photo field, failure choice, or scope is ambiguous. Do not invent columns or
turn a conditional failure rule into a globally required Dataverse photo.

A rule proposal uses `kind: "business-rule"`, the existing `entityId`, and the
complete proposed typed `rules` contract. Preserve other entities' rules:

```json
{
  "schemaVersion": 1,
  "kind": "business-rule",
  "summary": "Require a stored damage photo before any failed inspection is saved. Passing inspections still need no photo.",
  "entityId": "inspections",
  "screenIds": [],
  "allowedFiles": [
    ".tmp/prototype-rules.json",
    "src/data/rules.ts",
    ".tmp/prototype-generated.json",
    ".tmp/data-access-registry.json"
  ],
  "rules": {
    "schemaVersion": 1,
    "rules": [
      {
        "id": "failure-photo",
        "entityId": "inspections",
        "actionId": "saveInspection",
        "when": { "fieldId": "result", "operator": "equals", "value": "fail" },
        "require": { "fieldId": "damagePhoto", "message": "Add a damage photo before saving a failed inspection." }
      }
    ]
  }
}
```

Names above are illustrative; use actual domain IDs. The existing action must
be `save`, or the approved rules must cover both declared create and update
actions. Explain the scope naturally—for this example, **All inspection
saves**. The compiler permits only bounded `equals`, `not-equals`, and `in`
conditions plus a required declared field. No eval or arbitrary code.

After `prepare` and `authorize`:

```bash
node "${PLUGIN_ROOT}/scripts/authoring-edit.js" teach --plan <sealed-plan-id>
```

This updates only the canonical rules contract itself, then invokes the actual
`generate-prototype-rules.js` owner to refresh `src/data/rules.ts`, ownership
hashes, and the data-access registry binding. It does not run full local or
Dataverse regeneration under a narrow teaching approval.

When an existing compiler-owned `src/data/test-write-permission.json` is
present, add it to `allowedFiles`: the rules owner revokes that temporary grant
without deleting its records. It is not silently added to the proposal or
created when absent. The helper seals exact expected output hashes before
approval and keeps a write/recovery journal for its four or five files.
Approved-file baselines are independent of the shared source index, so
recovery metadata remains bound even when a source policy omits it. A
partially written candidate is not published; recovery accepts only the
known before/after bytes and refuses conflicting user changes. Candidate
checks require the exact approved outputs and the owning generator's check.

All inspection submission paths must call the common high-level repository
create/update API. That API merges the existing record before validation and
validates above either adapter. Preserve historical ready photos when another
field changes. Do not clear evidence merely because replacement capture was
cancelled.

Required focused outcomes before candidate readiness:

| Case | Expected |
|---|---|
| Failed inspection, no photo | Save blocked with the approved message |
| Failed inspection, `{status:"ready", uri:…}` | Save succeeds |
| Passing inspection, no photo | Save succeeds |
| Existing ready photo, unrelated update | Photo retained; save succeeds |
| Capture cancelled / upload pending or failed | Not ready evidence; no false save success |
| Successful retry | One actual save; idempotency/record semantics preserved |

The helper never uploads a photo or mutates a record to test the rule.
Use existing local repository/fixture tests and declared validation scenarios.
Backend-wide enforcement across other Dataverse writers is separate scope.

## 6. Candidate preview, Apply/Discard, and eligible Undo

Complete memory-bank/static-preview updates and rerun the foreground
authoring configurator before the final snapshot:

```bash
node "${PLUGIN_ROOT}/scripts/authoring-edit.js" candidate \
  --plan <sealed-plan-id> --ready-screen <id> --final
node "${PLUGIN_ROOT}/scripts/mobile-authoring.js" complete
```

The candidate command repeats scoped-delta verification, runs the fixed
readiness checks, and sends the exact source revision to the bridge. For
prototype-profile or authoring-runtime apps it resolves ready IDs from
registered source files and runs `configure-prototype-authoring.js --check`
with exactly those IDs. This is read-only: stale projections must be fixed
by the foreground configurator, never silently repaired during validation. It
records an eligible local **code/contracts-only** Undo receipt bound to the
candidate's after revision. It never restores active business records,
photos, remote writes, or schema. Unrelated later changes make that local Undo
ineligible.

The bridge alone publishes. Its candidate preview uses an isolated data/media
namespace. The maker then chooses Apply or Discard in Player; do not issue a
second Apply question or run the standalone in-place edit path. Submission is
not Apply, and Apply is not evidence that the native screen mounted. Report
each real state accurately and keep the last-good active preview on failure,
stop, stale context, or discard.

`authoring-edit.js` commands: `inspect --intent`, `prepare --input`,
`authorize --plan [--wait-ms]`, `integration --plan --gate-receipt`,
`capture --plan`, `teach --plan`, `check --plan`, and
`candidate --plan --ready-screen … [--final]`. No command publishes active
source, accepts arbitrary shell commands, or performs remote mutation.
