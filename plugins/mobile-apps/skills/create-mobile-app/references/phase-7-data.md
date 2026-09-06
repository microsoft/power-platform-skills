# Data, Native Capabilities, and Connectors

Follow the retained
[`Live Build Plan protocol`](./build-plan.md). Keep `dataverse` current around
Step 8, including a completed not-applicable milestone for `connector-only` and
`local-prototype`. Derive every branch from `.tmp/persistence-contract.json`,
never an inferred or legacy planning variable. Use `architecture` warnings for
capability/connector concerns without rewriting the approved scope.

### Step 7 — Auth config

**Print before starting:**
> "→ [Step 7/13] Configuring app authentication (Entra ID app registration)…"

The template ships `auth.config.json` with blank `msal.clientId` and `msal.tenantId`. There are no baked-in registration IDs to reuse. Always use the selected Power Platform environment tenant resolved earlier in the flow, then ask the user how they want to provide the Entra app registration client ID.

`auth.config.json` may also contain a non-secret sibling `environment` object written by `scripts/resolve-environment.js`:

```json
{
  "msal": { "clientId": "...", "tenantId": "..." },
  "environment": {
    "environmentId": "<guid>",
    "environmentUrl": "https://orgXXX.crm.dynamics.com",
    "tenantId": "<guid>",
    "cachedAt": "<iso timestamp>"
  }
}
```

Keep this block when editing `auth.config.json`. It lets later skills avoid re-running the environment-specific Power Platform API. Do not store tokens, secrets, or current-user Dataverse identity fields there.

#### 7.1 Resolve selected Power Platform tenant

Use the environment selected in Step 4. Prefer `$ACTIVE_TENANT_ID`, then `.resolved-environment.json`, then the cached `auth.config.json.environment.tenantId`. Do not use the old `msal.tenantId` as an authority source; it may be blank or stale from a previous registration.

```bash
TENANT_ID="$ACTIVE_TENANT_ID"
if [ -z "$TENANT_ID" ]; then
  TENANT_ID=$(node -e "const j=require('./.resolved-environment.json'); console.log(j.tenantId || '')" 2>/dev/null || true)
fi
if [ -z "$TENANT_ID" ]; then
  TENANT_ID=$(node -e "const j=require('./auth.config.json'); console.log((j.environment && j.environment.tenantId) || '')" 2>/dev/null || true)
fi
echo "$TENANT_ID"
```

If `TENANT_ID` is empty, rerun `scripts/resolve-environment.js` using the environment ID in `power.config.json`:

```bash
ENV_ID=$(node -e "console.log(require('./power.config.json').environmentId || '')")
node "${PLUGIN_ROOT}/scripts/resolve-environment.js" "$ENV_ID" > .resolved-environment.json
TENANT_ID=$(node -e "const j=require('./.resolved-environment.json'); console.log(j.tenantId || '')")
```

If `TENANT_ID` is still empty, STOP and ask the user to fix environment resolution before continuing. Do not guess the tenant and do not copy `msal.tenantId` from `auth.config.json`.

#### 7.2 Choose app registration path

Ask one question, using the resolved tenant:

> "This app needs an Entra ID app registration in tenant `<tenant-guid>` to sign in.
>
> Choose one:
> (a) Paste an existing app registration client ID
> (b) Create a new app registration from the Power Apps Wrap page, then paste its client ID
> (c) Skip for now — configure auth later"

Do not default to any option silently. The user must choose because app registration ownership varies by tenant/admin role.

- **(a) Paste existing** — run the client-ID write path in 7.3.
- **(b) Create new in Power Apps Wrap** — print the environment-specific Wrap URL in 7.4, then ask for the client ID and run 7.3. If the user cannot finish creation, allow `skip` and follow 7.5.
- **(c) Skip** — run the skip path in 7.5.

#### 7.3 Write client ID into `auth.config.json`

Ask:
> "Paste the Entra ID app registration client ID for tenant `<tenant-guid>` (GUID format), or type `skip` to configure auth later:"

If the user types `skip`, run 7.5. Otherwise validate UUID format. Write `auth.config.json` using `Edit`:
- Replace `msal.clientId` with the user's value
- Replace `msal.tenantId` with `<tenant-guid>` from 7.1
- Preserve the existing top-level `environment` block if present. If it is missing but `.resolved-environment.json` exists, add that JSON as top-level `environment`.

Do not create or modify the registration from this skill. The user owns it. Just wire the IDs into `auth.config.json`.

Print:
> "→ Wired app registration into auth.config.json.
> Client ID: `<id>`
> Tenant: `<tenant-guid>`"

Jump to Step 8.

#### 7.4 Create a new app registration in Power Apps Wrap

Resolve the selected Power Platform environment ID from `$ACTIVE_ENV_ID`, then `power.config.json`. Print the public Power Apps Wrap URL:

> "Open the Power Apps Wrap app-registration page for the selected environment:
> `https://make.powerapps.com/environments/<environment-id>/wraps#create-app-registration`
>
> Create the app registration on that page, then copy the Application (client) ID and paste it here.
> The Wrap experience configures the native registration for this flow. Do not add redirect URIs or API permissions manually; tenant-wide admin consent is not required.
> If you cannot create it now, type `skip` and run `/set-app-registration-native` later."

Tell the user the registration must be created/configured from the Power Apps Wrap page for the selected environment. Do not direct them to the Entra admin center for manual redirect URI, delegated permission, or admin-consent setup.

After the user creates the registration, run 7.3 to capture and write the client ID.

#### 7.5 Skip auth for later

Write `auth.config.json` using `Edit`:
- Set `msal.tenantId` to `<tenant-guid>` from 7.1
- Leave `msal.clientId` as `""`
- Preserve or add the top-level `environment` block from `.resolved-environment.json` if available

Print:
> `⚠️ Auth client ID is not configured. The app will fail to sign in until you add one. Run /set-app-registration-native later, or paste an app registration client ID into auth.config.json for tenant <tenant-guid>.`

Do NOT touch `src/playerConfig.ts` — auth identifiers live in `auth.config.json` only.

### Step 8 — Apply data model

Before any reconciliation, manifest generation, or Dataverse write, check
`.tmp/mobile-build-plan-edits.json` and the approval receipt as required by the
Build Plan protocol. A newer schema-only edit blocks Step 8 and returns through
Gate 2. A scope or ownership edit returns through Gate 1. The mutation phase
cannot create or refresh its own approval.

Recompile the persistence authority and reject forbidden mode artifacts before
branching:

```bash
PERSISTENCE_CONTRACT="<working_dir>/.tmp/persistence-contract.json"
node "${CLAUDE_SKILL_DIR}/../../scripts/compile-persistence-contract.js" \
  --project-root "<working_dir>" --check-artifacts
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-fixture-scenarios.js" \
  --project-root "<working_dir>" --check
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-data-model-usage.js" \
  --project-root "<working_dir>" --check
PERSISTENCE_MODE=$(node -e \
  "process.stdout.write(require(process.argv[1]).mode)" \
  "$PERSISTENCE_CONTRACT")
```

The usage check is required in all four modes and must match the just-compiled
persistence revision. Connector-only and local-prototype artifacts have no
schema tables but still prove persistable requirement ownership. A missing,
stale, or invalid usage artifact is `BLOCKED`; no Dataverse reconciliation,
manifest generation, metadata write, connector mutation, or package adapter
work may begin until Phase 3 recompiles and Gate 2 reapproves it.

Branch on all four modes:

| `persistence.mode` | Step 8 / 8.5 / 8.85 behavior |
|---|---|
| `dataverse` | Run Dataverse reconciliation/writes/services and seed only `dataverseConceptIds`; Step 8.85 asks the offline-support question. |
| `mixed` | Same Dataverse steps, but only for `dataverseConceptIds`; connector/local concepts remain with their declared owners and are never mirrored as tables. Step 8.85 asks the offline-support question. |
| `connector-only` | No publisher, snapshot, schema, Dataverse service, manifest, seed, or Mobile Offline Profile artifact. Steps 8, 8.5, and 8.85 are not applicable. |
| `local-prototype` | No publisher, snapshot, schema, Dataverse service, manifest, seed, or Mobile Offline Profile artifact. Steps 8, 8.5, and 8.85 are not applicable. |

For `connector-only` and `local-prototype`, require the approved `## Data
Model` to say `Not applicable` and render every concept owner. The successful
`--check-artifacts` call is the execution gate; a Dataverse artifact is a
planning mismatch, not something Step 8 may delete or overwrite.
Print the Step 8/8.5 not-applicable result, then continue through Step 8.85 so a
selected package adapter can be applied. Do not infer that selection from the
persistence mode or connectivity description.

**Print before starting:**
> "→ [Step 8/13] Preparing the approved Dataverse operation manifest, then invoking /add-dataverse for sequential metadata writes and service generation. Dataverse write time varies by environment; local manifest preparation is deterministic, not a wall-clock promise."

**Environment pre-check (before invoking /add-dataverse):** Verify that `.resolved-environment.json` / `power.config.json` match the environment captured in Step 1. If they differ, warn the user immediately — creating tables in the wrong environment is the #1 silent breakage in this step. `/add-dataverse` Step 3a does its own check, but catching it here saves a failed attempt.

For `dataverse` and `mixed`, read `dataverseConceptIds` from the persistence
contract and require `.tmp/dataverse-concepts.json` and the approved schema
contract to represent every and only those concepts. In `mixed`, any
connector/local/transient concept represented by a schema table or Dataverse
service is `BLOCKED`; return to planning rather than creating a duplicate
system of record.

Keep the foreground planning snapshot as planning evidence only. It never
authorizes a write. Without changing any approval gate, Step 8 must perform one
fresh bounded reconciliation for every exact table in the approved structured
schema; each existing table reloads ordinary typed columns, lookups, M:N/1:N
relationships, and alternate keys.
Create/adapt table reruns also reload and compare creation-significant table
behavior: ownership, activities, notes, offline availability, change tracking,
labels/schema identity, and primary-name identity.
The exact/proposed scope also includes every effective M:N intersect entity
name, and 1:N reuse requires complete matching `CascadeConfiguration`
evidence. An absent or colliding intersect name, or missing/mismatched cascade
evidence, is non-executable.
Step 8 also binds the structured artifact to the current fully approved plan
content hash and the gate-owned approval receipt's exact contract hash and
service dependencies. Step 8 cannot create or refresh this receipt. Use
resolved context and these structured artifacts, never values inferred from
free-form Markdown:

```bash
SCHEMA_CONTRACT="<working_dir>/.tmp/dataverse-schema-contract.json"
APPROVAL_RECEIPT="<working_dir>/.tmp/mobile-plan-status.json"
FOREGROUND_PLANNING_SNAPSHOT="<working_dir>/.tmp/dataverse-foreground-planning-snapshot.json"
RECONCILIATION_SCOPE="<working_dir>/.tmp/dataverse-reconciliation-scope.json"
EXECUTION_RECONCILIATION="<working_dir>/.tmp/dataverse-execution-reconciliation.json"
OPERATION_MANIFEST="<working_dir>/.tmp/dataverse-operation-manifest.json"
PUBLISH_CHECKPOINT="<working_dir>/.tmp/dataverse-publish-pending.json"
ACTIVE_SOLUTION_UNIQUE_NAME="Default"

test -f "$SCHEMA_CONTRACT" -a -f "$APPROVAL_RECEIPT" \
  -a -f "$FOREGROUND_PLANNING_SNAPSHOT" \
  -a -f "<working_dir>/native-app-plan.md"

node "${CLAUDE_SKILL_DIR}/../../scripts/build-dataverse-operation-manifest.js" \
  --bind-plan "$SCHEMA_CONTRACT" \
  --approval-receipt "$APPROVAL_RECEIPT" \
  --plan "<working_dir>/native-app-plan.md" \
  --output "$SCHEMA_CONTRACT"

node "${CLAUDE_SKILL_DIR}/../../scripts/build-dataverse-operation-manifest.js" \
  --reconciliation-scope "$SCHEMA_CONTRACT" \
  --output "$RECONCILIATION_SCOPE"

EXACT_TABLES=$(node -e "console.log(require(process.argv[1]).exactTables.join(','))" "$RECONCILIATION_SCOPE")
PROPOSED_TABLES=$(node -e "console.log(require(process.argv[1]).proposedTables.join(','))" "$RECONCILIATION_SCOPE")

node "${CLAUDE_SKILL_DIR}/../../scripts/planning-timings.js" \
  --project-root "<working_dir>" --stage dataverseExecutionReconciliation --action start
node "${CLAUDE_SKILL_DIR}/../../scripts/create-dataverse-snapshot.js" \
  --env-url "$ACTIVE_ENV_URL" \
  --tenant-id "$ACTIVE_TENANT_ID" \
  --solution "$ACTIVE_SOLUTION_UNIQUE_NAME" \
  --tables "$EXACT_TABLES" \
  --proposed-tables "$PROPOSED_TABLES" \
  --reconcile-exact \
  --output "$EXECUTION_RECONCILIATION"
node "${CLAUDE_SKILL_DIR}/../../scripts/planning-timings.js" \
  --project-root "<working_dir>" --stage dataverseExecutionReconciliation --action finish \
  --count "exactTables=<EXACT_TABLES_COUNT>" \
  --count "proposedNames=<PROPOSED_TABLES_COUNT>"

node "${CLAUDE_SKILL_DIR}/../../scripts/planning-timings.js" \
  --project-root "<working_dir>" --stage dataverseManifestPreparation --action start
node "${CLAUDE_SKILL_DIR}/../../scripts/build-dataverse-operation-manifest.js" \
  --contract "$SCHEMA_CONTRACT" \
  --approval-receipt "$APPROVAL_RECEIPT" \
  --reconciliation "$EXECUTION_RECONCILIATION" \
  --plan "<working_dir>/native-app-plan.md" \
  --output "$OPERATION_MANIFEST" \
  --environment-id "$ACTIVE_ENV_ID" \
  --env-url "$ACTIVE_ENV_URL" \
  --tenant-id "$ACTIVE_TENANT_ID" \
  --publisher-prefix "$DETECTED_PUBLISHER_PREFIX" \
  --solution "$ACTIVE_SOLUTION_UNIQUE_NAME" \
  --publish-checkpoint "$PUBLISH_CHECKPOINT"
node "${CLAUDE_SKILL_DIR}/../../scripts/planning-timings.js" \
  --project-root "<working_dir>" --stage dataverseManifestPreparation --action finish \
  --count "tables=<CONTRACT_TABLE_COUNT>" \
  --count "columns=<CONTRACT_COLUMN_COUNT>" \
  --count "relationships=<CONTRACT_RELATIONSHIP_COUNT>" \
  --count "operations=<MANIFEST_OPERATION_COUNT>"
```

The manifest builder mechanically verifies the approved `Reuse`, `Extend`,
`Create`, `Adapt`, `Defer`, and `Unverified` decisions. It must not invent or
change architecture decisions. Any mismatch is a non-executable verification
conflict and returns to the orchestrator; do not add another opportunistic read
loop or fall back to agent reconciliation. No operation may execute until:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/build-dataverse-operation-manifest.js" \
  --validate "$OPERATION_MANIFEST" \
  --contract "$SCHEMA_CONTRACT" \
  --approval-receipt "$APPROVAL_RECEIPT" \
  --reconciliation "$EXECUTION_RECONCILIATION" \
  --plan "<working_dir>/native-app-plan.md" \
  --environment-id "$ACTIVE_ENV_ID" \
  --env-url "$ACTIVE_ENV_URL" \
  --tenant-id "$ACTIVE_TENANT_ID" \
  --publisher-prefix "$DETECTED_PUBLISHER_PREFIX" \
  --solution "$ACTIVE_SOLUTION_UNIQUE_NAME" \
  --publish-checkpoint "$PUBLISH_CHECKPOINT" \
  --require-executable
```

Invoke `/add-dataverse` with the working directory, approved plan, and exact
artifact paths:

```
Invoke skill: /add-dataverse

Arguments:
  --working-dir <working_dir>
  --plan-section <native-app-plan.md#data-model>
  --schema-contract <working_dir>/.tmp/dataverse-schema-contract.json
  --approval-receipt <working_dir>/.tmp/mobile-plan-status.json
  --execution-reconciliation <working_dir>/.tmp/dataverse-execution-reconciliation.json
  --operation-manifest <working_dir>/.tmp/dataverse-operation-manifest.json
  --publish-checkpoint <working_dir>/.tmp/dataverse-publish-pending.json
  --skip-planning   (the planner already ran)
```

`/add-dataverse` validates the bindings and consumes valid phases immediately.
Any supplied artifact/binding failure returns to this orchestrator; it must
not silently enter standalone reconciliation. A non-executable manifest
authorizes no metadata writes.
The publish checkpoint is retained across schema/PublishXml failure and until
post-publish inventory-cache invalidation succeeds. It is deleted only after
that complete boundary, so a rerun can safely retry publication and cleanup
even when schema writes are already idempotent.
It creates Tier 0 → N tables, applies extensions, then runs
`generate-dataverse-services.js` once from the app root. That script consumes
the signed manifest's exact service-required list, invokes
`npx power-apps add-data-source` sequentially, verifies config/service output,
records service workload timing, and returns. Real matched A/B runs are still required to quantify
the end-to-end time saved; do not present local manifest timing as a guaranteed
1–3 minute Dataverse result.

The manifest executor records `dataverseMetadataWrites` with actual phase
operation counts and duration. The deterministic service runner records
`dataverseServiceGeneration` with `services=<required table count>`. Report
these measurements separately; table count alone is not a
duration estimate because extension columns, relationships, keys, publish, and
service generation are separate serialized operations.

After `/add-dataverse` returns, run the **Dataverse/generated-services gate**:

```bash
npm run generate-schemas
npx tsc --noEmit
```

If this fails, do not continue to native capabilities, connectors, navigation, or screens. Capture the full error list once, batch-fix generated-service/model or alias-map issues, then rerun the gate. If the failure is a hidden Dataverse collision already recovered via an alias (for example `aircraft` → `aircraftv2`), make sure the alias is reflected in `native-app-plan.md`, `memory-bank.md`, and the Generated Services snapshot before rerunning.

### Step 8.5 — Seed Dataverse sample data (conditional)

**Print before starting:**
> "→ [Step 8.5/13] Checking existing record counts and seeding sample data into tables with fewer than 5 records."

Invoke `/add-sample-data` after Step 8 only for `dataverse` or `mixed`. Within
those modes this step is not optional: the Dataverse-owned concepts should have
data to render on first launch. Connector-owned and local concepts keep their
own source/adapters and are never seeded through Dataverse.

Before branching, require current `.tmp/scenario-facts.json` and compile its
canonical data projection:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-fixture-scenarios.js" \
  --project-root "<working_dir>" --check
node "${CLAUDE_SKILL_DIR}/../../scripts/compile-sample-data-obligations.js" \
  --project-root "<working_dir>"
node "${CLAUDE_SKILL_DIR}/../../scripts/compile-sample-data-obligations.js" \
  --project-root "<working_dir>" --check
```

Records, relationships, media keys, invariants, and screen bindings come from
scenario facts. The conditional Dataverse schema constrains only valid payload
shape and insertion order. For `connector-only` and `local-prototype`, do not
invoke `/add-sample-data`; generated connector/local prototype repositories may
consume the same scenario projection without any Dataverse read or write.

```
Invoke skill: /add-sample-data

Arguments:
  --working-dir <working_dir>
```

`/add-sample-data` reads `.datamodel-manifest.json`, queries the current record
count for each table, skips any table that already has ≥5 records, and seeds the
rest with contextually appropriate rows in dependency-tier order. Before
invocation, require every manifest table to trace to a
`persistence.dataverseConceptIds` entry. In `mixed`, a table for any
connector/local/transient concept is blocking. Inserted GUIDs are tracked in
`memory-bank.md` for idempotent re-runs.

If `.datamodel-manifest.json` is missing or malformed, STOP. A `dataverse` or
`mixed` run cannot seed Dataverse data or create a Mobile Offline Profile
without the manifest produced by the completed Step 8 mutation.

If the seeding step fails for a non-manifest reason (network drop, permission
error, etc.), surface the failure but continue to Step 8.85 — the app is still
usable, just empty on first launch. The user can re-run `/add-sample-data`
later to retry.

Offline support is deliberately not selected from requirements, prompt
keywords, operating-context assumptions, Product Experience, architecture, or
persistence. Step 8.85 is the only selection point in `/create-mobile-app`.

### Step 8.85 — Ask about offline support

Ask only for `dataverse` or `mixed`, after `.datamodel-manifest.json` has been
materialized. For `connector-only` or `local-prototype`, print
`↷ Step 8.85 skipped — Mobile Offline Profiles require Dataverse tables.` and
continue to Step 9 without asking.

If `memory-bank.md` `## Offline profile` already has `status: done` or
`status: not-applicable`, print
`↷ Step 8.85 skipped — offline profile already <done|not-applicable> from a prior run.`
and continue to Step 9. Do not add any other skip condition.

Ask one `AskUserQuestion` with no inferred default:

> **Question header**: `Offline support`
>
> **Question body**: `Do you want offline support for this app? A Mobile Offline Profile lets users keep working without a connection and sync changes when connectivity returns.`
>
> **Options**:
> - `Yes — configure offline support now`
> - `No — continue without offline support`

If the user answers Yes, invoke `/setup-offline-profile` directly from the
project root with `--orchestrated-create`. The flag records that the parent has
already received an affirmative answer; it is not a planning contract and the
child must not ask the selection question again.

If the user answers No, skip offline profile setup, write `status:
not-applicable` under `memory-bank.md` `## Offline profile`, and continue to
Step 9. Do not create `offline-profile.json` or any placeholder artifact.

The connection, queued, syncing, failed, retry, and conflict runtime UX remains
owned by the template host/offline package. The question and its answer do not
change Product Scope, navigation, domain jobs, domain tables, Journey, or screen
packs.

Handle `/setup-offline-profile` through the canonical status switch: `DONE`
continues, `DONE_WITH_CONCERNS:` is surfaced and recorded, and `BLOCKED:`
stops. New custom Dataverse tables were configured for offline availability
and change tracking by `/add-dataverse`, so the setup skill validates rather
than guesses table readiness.

### Step 9 — Apply native capabilities

**Print before starting:**
> "→ [Step 9/13] Wiring <N> independent native capabilities concurrently: <list>."

Read the `## Native Capabilities` section from `native-app-plan.md`. For each capability, invoke `/add-native` — it routes to nested helpers for camera/PDF/pen controls when needed, otherwise generates a generic wrapper:

```
Invoke skill: /add-native

Arguments:
  --working-dir <working_dir>
  --capability <name>
```

Invoke all approved capabilities in one parallel sub-skill batch. Each
invocation owns exactly one file under `src/native/` and must not touch
`package.json`, `app.config.js`, generated services, or shared manifests.
Render one result line per capability after the batch and apply the canonical
status switch to every result. If any capability would modify shared state,
remove it from the batch and run it separately after the independent writes.

If the plan says "None — this app uses only standard React Native components and Power Platform connectors", skip only the native-capability invocation above and continue to Step 9a. Do NOT skip Step 9a or Step 9b; an app can need a pure-JavaScript library without any native capability, and Tamagui aliases/brand tokens are always required.

### Step 9a — Install approved pure-JavaScript dependencies

Read and execute the Installation Contract in [`shared/references/javascript-dependency-planning.md`](${CLAUDE_SKILL_DIR}/../../shared/references/javascript-dependency-planning.md) for every approved row in `## Screens → ### JavaScript Dependencies`. If the subsection is absent or says `None.`, continue without changing dependencies.

Gate 3 experience approval is consent for exactly the packages and versions in
the table. Install them into `<working_dir>` only after Gate 4 final
implementation confirmation and before any skeleton or builder imports them.
Validate `package.json`, the lockfile, and module resolution. Do not substitute
another package/version, infer a package from a compiler error, or route a
JS-only package through `/add-native`. If final inspection finds native
code/config or incompatible runtime dependencies, remove only the newly added
package and STOP with the exact failed criterion.

### Step 9b — Apply design system

`/design-system` owns user-facing brand/design choices. This step owns the internal Tamagui integration that makes those choices usable by generated screens. Even if the user accepts the default design path, run the alias-only integration so screens can rely on the semantic token contract.

Read the `## Design` section from `native-app-plan.md` and follow the execution mapping in [`shared/references/design-planning.md`](${CLAUDE_SKILL_DIR}/../../shared/references/design-planning.md):

| Condition | Action |
|---|---|
| `brand/tokens.ts` exists | **Highest priority.** Apply [`../design-system/references/tamagui-integration.md`](../../design-system/references/tamagui-integration.md) in brand-import mode, then wire brand `ThemeTokens` into `app/_layout.tsx` (see below). |
| `## Design` says `required` | Apply the same reference using the approved `## Design` section. Builds custom token system + aliases. |
| `## Design` says `add-aliases` | Apply the same reference in alias-only mode. Adds semantic surface/accent aliases over `defaultConfig`. |
| Custom font only | `npx expo install expo-font` + `useFonts()` in `_layout.tsx` + `add-aliases` mode. |

**No skip path.** Screen-builders require `$surface0`–`$surface3` and `$accent*` aliases. Minimum action is always `add-aliases`. Pass the complete `## Design` section verbatim — not a summary. Re-run `npx tsc --noEmit` after Tamagui config changes.

**Brand-token wiring** — when `brand/tokens.ts` exists, update `app/_layout.tsx` to spread brand values over the built-in `lightTheme`/`darkTheme` with nullish fallback:

```tsx
import { tokens as brandTokens } from '../brand/tokens';
import { PowerAppsProvider, lightTheme as hostLightTheme, darkTheme as hostDarkTheme } from '@microsoft/power-apps-native-host';
import type { ThemeTokens } from '@microsoft/power-apps-native-host';

const brandedLightTheme: ThemeTokens = {
  ...hostLightTheme,
  accentDeep: brandTokens.color.primary,
  accentBase: brandTokens.color.primary,
  accentSoft: brandTokens.color.accent,
  surface0: brandTokens.color.bg,
  surface1: brandTokens.color.surface,
  surface2: brandTokens.color.surface,
  surface3: brandTokens.color.border,
  text0: brandTokens.color.text,
  text1: brandTokens.color.textMuted,
};
const brandedDarkTheme: ThemeTokens = {
  ...hostDarkTheme,
  accentDeep: brandTokens.color.primary,
  accentBase: brandTokens.color.primary,
  accentSoft: brandTokens.color.accent,
};

// In RootLayout:
<PowerAppsProvider ... theme={brandedLightTheme} darkTheme={brandedDarkTheme}>
```

The generated schema has one brand palette, so dark surfaces and text retain the host defaults while brand accents carry across modes. For runtime theme switching (in-app theme pickers, per-tenant branding), use `useThemeControl()` from `@microsoft/power-apps-native-host`: `setTheme({ ...hostLightTheme, accentBase: color })` / `resetTheme()`.

### Step 10 — Add connectors

**Print before starting:**
> "→ [Step 10/13] Adding <N> connectors: <list>. Each runs sequentially (parallel writes would race)."

Read the `## Connectors` section from `native-app-plan.md`. If it says "None", skip this step entirely.

For each row in the table, route to the correct skill based on the API name:

| API name | Invoke |
|---|---|
| `sharepointonline` | `/add-sharepoint --working-dir <working_dir>` |
| anything else | `/add-connector --working-dir <working_dir> --connector <api-name>` |

Run sequentially — each generates files under `src/generated/`. Parallel writes would race.

**Mutation-heavy steps stay sequential.** Dataverse table creation (Step 8), connector adds (Step 10), and generated-service writes are all sequential by design. The fast path in this skill is **parallel screen generation** (Step 11) plus **fewer prompts** (token cache, sticky policies, auto-proceed) — NOT parallelizing the data-source/service mutations. Do not attempt to parallel-batch `npx power-apps add-data-source` or `/add-connector` invocations; they share `src/generated/` and `power.config.json` and will race or corrupt state.
