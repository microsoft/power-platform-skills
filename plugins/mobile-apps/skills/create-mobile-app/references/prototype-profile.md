# Explicit local prototype profile

This reference supplies mode-specific behavior to the shared creation phases,
not a second plan or orchestrator. The default real profile is unchanged.

## Before Phase 0: no-environment compatibility gate

Do not run Azure account probes, environment/name-collision queries, publisher
discovery, auth setup, `power-apps init`, connector/schema generators, seed
imports, or offline-profile setup. Inspect only the selected installed template:

```bash
node "${PLUGIN_ROOT}/scripts/prepare-prototype.js" \
  --project-root "<working_dir>" --check-template
```

This verifies the frozen dependency declarations, installed storage/media
interfaces, and the host's `config/expoConfig`, `babelConfig`, `metroConfig`,
`tamaguiConfig`, and `tsconfig` exports. The supported template uses host
`^0.3.3`; an older host with no config factories is not repaired by changing
versions. The 0.3.3 Metro factory supports no environment and keeps
`/__pawrap_verify`/native-runtime version checks. Preserve it.

The host's no-environment Player branch does not make the template's static
`power.config`/schema imports or guarded login routes disappear. Preparation
therefore installs an app-owned `PrototypeProvider` composing the installed
Safe Area, Tamagui, and React Query providers. It does not instantiate host
auth/connectors/offline. Original connected root/login source is retained as
non-importable JSON text for explicit conversion. This local provider throws
outside a development build; it is not a production authentication bypass.
The inactive OAuth callback is also removed from the route graph. Preparation
merges `@/data` aliases with the actual host TypeScript aliases instead of
replacing the inherited paths or assuming a nonexistent catch-all alias.

Phase 0 still validates freshness/tooling and gathers the same product brief.
Omit only the environment question and environment-specific summary fields.
Step 2c still authorizes initial project writes. Use the stable app instance
identity created there; if Player supplied an existing identity, bind/verify it
through the shared authoring adapter rather than deriving one from an address.

## Logical domain and sole fixture authority

In Phase 3, author `.tmp/prototype-domain.json` against
`scripts/schema-prototype-domain.json`. Records are flat `{ id, ...fieldIds }`.
Conservative entity, field, choice and action IDs remain stable across visual
edits and conversion. The domain contains **no records, examples, URLs, or
second fixture definitions**.
Entity IDs cannot be TypeScript keywords or collide with generated
`EntityMap`, `EntityId`, or `PhotoReference` types. Object-prototype member
names are not valid logical identifiers.

Keep the exact base shape:

```json
{
  "schemaVersion": 1,
  "appInstanceId": "<existing-app-instance-id>",
  "schemaVersionNumber": 1,
  "entities": [{
    "id": "Inspection",
    "label": "Inspection",
    "fields": [{"id": "title", "label": "Title", "type": "text", "required": true}],
    "operations": ["list", "get", "create", "update", "delete"]
  }],
  "actions": [{"id": "saveInspection", "label": "Save", "entityId": "Inspection", "operation": "save"}]
}
```

Use product-specific concepts; the example is an API shape, not an inspection
default. Each entity binds explicitly in `.tmp/prototype-bindings.json`:
`{ "schemaVersion": 1, "entities": [{ "entityId": "Inspection", "conceptId": "inspection" }] }`.
Concept IDs must already exist in the approved persistence contract with local
or transient ownership. Do not derive a physical table or mirror a connector.
Prototype durable entities use `local-configuration`; view state remains
transient. A later Dataverse preference is conversion intent, not live ownership.

Create the separate default rule contract `.tmp/prototype-rules.json` as
`{ "schemaVersion": 1, "rules": [] }`. The real bounded rules compiler always
generates `src/data/rules.ts`, including for an empty set. Teaching later changes
this contract, not fixtures or generated services.

Canonical `.tmp/scenario-facts.json` remains the only sample-data authority.
For scenarios that need photos, follow
[canonical sample images](${PLUGIN_ROOT}/shared/references/prototype-images.md):
use licensed fixed HTTPS assets with explicit provenance and record photo-field
references, and render the current row through the generated `PrototypeImage`.
It provides loading/error fallbacks and attribution without a second seed set
or automatic Dataverse import.
Domain record facts use the explicitly bound concept IDs and field IDs; the
compiler projects them into `src/data/fixtures.ts`. Presentation-only records
stay with the canonical screen projections. Relationships, media references,
Journey and usage bindings must validate before Gate 2:

```bash
node "${PLUGIN_ROOT}/scripts/generate-prototype.js" \
  --project-root "<working_dir>" --validate-contracts
```

Include these three contracts in Gate 2 review and immutable pipeline
checkpoint bindings. A semantic domain/rule change reopens Gate 2; an ownership
change also reopens Gate 1. Never restamp old approvals.
The ordinary approval helper, CLI validation, and resume checkpoints bind the
complete optional trio by exact regular-file bytes at Gates 2–4, including its
absence. Partial contracts, deleting them after approval, or introducing them
after a data gate require reapproval; a declared revision alone is not evidence.

## Materialize and use the local implementation

After the shared preparation/approval sequence reaches Step 5:

```bash
node "${PLUGIN_ROOT}/scripts/prepare-prototype.js" \
  --project-root "<working_dir>" --display-name "<displayName>" \
  --slug "<slug>" --entry-route "<approved-static-primary-route>"
```

This calls the existing precise template preparer (the approved precreated plan
is allowed), then generates real app-owned model, contracts, rules,
repositories, hooks, and provider under `src/data`. It never writes
`src/generated`, `power.config.json`, or a fake environment. Dependency versions
remain unchanged. `dev:prototype` deliberately bypasses `predev`/live schema
generation. For a compiler-owned refresh/check:

```bash
node "${PLUGIN_ROOT}/scripts/generate-prototype.js" --project-root "<working_dir>"
node "${PLUGIN_ROOT}/scripts/generate-prototype.js" --project-root "<working_dir>" --check
```

Do not refresh local runtime outputs after conversion; the explicit conversion
compiler owns the connected adapter selection.

Before **rules-only** approval, call
`planPrototypeRules(root, { rules: proposedContract })` from
`scripts/lib/prototype-rules.js`. It performs no writes and returns sorted
`inputs: [{path,sha256}]`, `effects: [{path,beforeSha256,afterSha256,content}]`,
and a deterministic `planRevision`. Seal these bytes/hashes and original
backups in the owning transaction before asking the maker; a self-hash is not
approval. The effects include the canonical rule contract and its three
generated outputs, plus the permission file only when it already exists.

After approval and exact baseline checks, write the contract effect's supplied
content and use the same narrow compiler in local or connected mode:

```bash
node "${PLUGIN_ROOT}/scripts/generate-prototype-rules.js" --project-root "<working_dir>"
node "${PLUGIN_ROOT}/scripts/generate-prototype-rules.js" --project-root "<working_dir>" --check
```

It updates only the exact compiled rules, registry rules revision, and ownership
manifest, and clears an existing temporary test-write permission. Domain,
binding, mapping, persistence, fixture, or unrelated owned-source drift blocks;
it never regenerates adapters, changes records, or restamps approval gates.
An already-written `rules.ts` is accepted only if byte-identical to the real
compiler output. Interrupted metadata writes are resumable. Remote evidence
and source-recovery journals are preserved. `generatePrototypeRules(root,
{check})` is the library entry; `refreshPrototypeRules` remains its alias.
`--check` only verifies current outputs. Compare every resulting hash with the
sealed plan, never freshly derived mutable metadata.

The optional permission-file write must be approved explicitly; no missing
permission file is created. A retained connector startup seal requiring another
write blocks before mutation and belongs to a separately approved workflow.
The narrow compiler never expands into startup, adapter, profile or namespace
updates. Cross-file Apply/rollback remains the owning transaction's job.

Phase 10 consumes `.tmp/data-access-registry.json`, not an empty generated-
services snapshot. Typed screens use `getRepository("EntityId")`,
`useEntityList`, `useEntity`, and `useEntityActions` from `@/data`; model types
come from `@/data/model`. Bound only each screen's required registry entries in
its work order. Missing APIs block compilation; no TODO services or screen-local
fixture fallbacks.

Repository semantics:

- Stable app-instance/schema-version namespace; screen publication, Fast
  Refresh, edits, and address changes do not reseed active records.
- Serialized persistent writes and optional local `operationId` receipts;
  errors and query bounds are explicit. Local React Query uses
  `networkMode: 'always'`, so airplane mode does not pause local reads/writes.
- Updates merge the stored record before shared domain/rule validation. Omitted
  photos survive; cancelled/pending/failed captures cannot produce saved success.
- Native captures go through `getDataRuntime().importPhoto(...)` to copy into
  the installed FileSystem document directory before assigning a ready reference.
- For approved `camera` / `image-picker` capability IDs, `capturePhoto` from
  `@/data/capture` performs the real native permission/picker/persistence sequence.
  `registry.media.captureSources` is its allowlist. The disabled-capability
  branch imports no native picker and never invents a successful photo.
- Approved pen/signature PNG data URIs can use the same `importPhoto` boundary:
  bytes persist to the isolated FileSystem namespace before a ready reference
  is returned, without duplicating image bytes into record storage.
- Text/number/datetime ordering and bounded equality/range filters are supported.
  Choice/lookup ordering is rejected rather than silently changing order when
  numeric Dataverse choices or related rows replace local IDs.
- Candidate data uses a separate namespace and a persistent copy-on-write
  snapshot of active rows. Candidate photos belong to that namespace; discard
  removes only those files/records, never active photos or data.
- External emails, payments, connector writes, and similar effects are not
  simulated as success. Defer them visibly, or obtain a separate approved
  connected operation. A local save is labeled as local.

Parent/native authoring instrumentation calls
`configureDataPreview({previewKind,dataNamespace,baseDataNamespace?})` before
any `getDataRuntime()` or child repository hook. It uses the bridge-injected
reserved runtime stamp and native association through the shared authoring
helper, never a source-embedded runtime token. Do not generate that stamp here.

After typed skeletons exist, Phase 10 runs
`configure-prototype-authoring.js --project-root "<working_dir>"
--screen-source "<screen-id>=<assigned-app-screen.tsx>"`, repeating the source
option for every compiled screen's actual typed-skeleton assignment. This is the
actual root/registry installer, not a reminder for the maker to edit their app.
It keeps the original root as a child of the authoring initialization gate,
preserves its UI/providers, and emits the shared runtime plus import aliases.
Each one-screen builder exports literal `authoringTargets` metadata in its
assigned file and wires the real screen hooks from the sealed `authoring`
projection. After each completed wave, the foreground reruns the configurator
with the actual `--ready-screen` IDs before source checks and publication.
Later runs reuse the saved explicit paths; an approved screen addition, removal
or move supplies the complete source list again. No source paths are inferred
from routes or pixels. Unfinished skeletons never become ready merely because
they exist.

## Preview and completion

Keep all normal screen/type/route/design gates. In Player mode, after each
dependency-complete canary/wave passes, report the actual approved screen plan
and checking states, then call the shared candidate command with the actual
ready screen IDs. The bridge alone publishes; mounted readiness is a separate
native acknowledgement.

Outside Player, after the final gates run `npm run dev:prototype`; verify the
server responds and retain its owned terminal. Do not run `npm run dev` because
its `predev` assumes real schema generation. Completion offers edit/teach,
continued local use, or explicit `/mobile-app:prototype-to-real-app`, never an
automatic environment conversion, demo import, or deployment.
The app-scoped storage guarantees target the native Player/mobile runtime.
Web preview uses browser-origin storage and cannot promise persistence across
origin changes or native FileSystem/camera behavior.
