---
name: create-mobile-app
description: Use when the user wants to start a new Power Apps mobile app (Expo / React Native / TypeScript, targeting iOS and Android) from scratch.
user-invocable: true
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, AskUserQuestion, Task, EnterPlanMode, ExitPlanMode
model: opus
---

**📋 Shared instructions: [shared-instructions.md](${CLAUDE_SKILL_DIR}/../../shared/shared-instructions.md)** — read first. Covers safety guardrails, memory bank usage, preferred-environment policy, connector-first rule, Windows CLI compat, command-failure handling.

# Create Power Apps Code App (Native)

Top-level orchestrator. Owns the user-visible flow; delegates planning to the `native-app-planner` agent and per-domain mutation to dedicated `/add-*` skills.

**Authoritative interaction contract:** read
[`four-gate-planning.md`](${CLAUDE_SKILL_DIR}/../../shared/references/four-gate-planning.md)
before Step 2. A standard run has exactly four approvals: requirements,
complete architecture, experience, and final implementation confirmation.
Visual previews, progress updates, agent fallbacks, and internal graph/spec
passes must not create extra prompts.

Also read these canonical experience contracts before Gate 1:

- [`product-experience-contract.md`](${CLAUDE_SKILL_DIR}/../../shared/references/product-experience-contract.md)
- [`product-archetypes.md`](${CLAUDE_SKILL_DIR}/../../shared/references/product-archetypes.md)
- [`visual-personalities.md`](${CLAUDE_SKILL_DIR}/../../shared/references/visual-personalities.md)
- [`home-compositions.md`](${CLAUDE_SKILL_DIR}/../../shared/references/home-compositions.md)
- [`reference-fidelity.md`](${CLAUDE_SKILL_DIR}/../../shared/references/reference-fidelity.md)

**v0.3.0 contract:** every standard run has exactly four user approvals. The
planner's data-model, capability, connector, screen-graph, screen-spec, design,
and validator passes are internal work inside those approvals. Public progress
lives in `mobile-app-status.json`; executable planning provenance lives in
`.tmp/mobile-plan-status.json` and the normalized schema contract.

## Workflow

0. Resume check + fresh-template gate → 1. Prerequisites → 1.7 Publisher prefix → 2. Gate 1 requirements + operating mode + cost preview → 3. Internal planning + Gate 2 complete architecture + Gate 3 experience → 3.8 Gate 4 implementation confirmation → 3.9 Provenance + prefix verification → 4. Auth & environment → 5. Prepare existing template → 6. `npx power-apps init` → 6.5 Verify dependencies → 6.5b Safe-area gate → 6.6 Scaffold `tsc` gate → 6.7 Seed memory bank → 6.75 Materialize approved design → 6.85 Apply approved offline decision → 7. Apply approved auth → 8. Apply data model → 8.5 Seed sample data → 9. Apply native capabilities → 9a. Install approved JavaScript dependencies → 9b. Integrate approved design tokens → 10. Add connectors → 10b. Wire navigation → 10.7 Snapshot services → 10.8 Generate signature components + skeletons → 11. Build screens → 11.4 Run experience/composition validators → 11.5 Refine approved design → 12. Start Metro → 12.3 Native `/visual-qa` → 12.5 Optional debug handoff → 13. Summary

---

## Fresh-template working-directory mode

This skill assumes the user already has a **fresh** `pa-wrap-tools/templates/expo-app-standalone` template materialized with `degit` in the target working directory and has already run `npm install` there. The skill turns that fresh template into an app; it does not clone, degit, or copy a template itself.

**Fresh template required.** If `--no-design` was passed, skip the preview rendered page.

Handle the return per the status protocol (AGENTS.md rule #10):
- `DONE` → continue to Step 7. Record `brand_path`, `tokens_path`, `direction` in memory-bank.
- `DONE_WITH_CONCERNS` → record and surface the concern; do not open a new design decision.
- `NEEDS_CONTEXT` → return `BLOCKED` because the approved Gate 3 contract is incomplete.
- `BLOCKED` → surface error, STOP.

### Step 6.85 — Apply the approved offline decision

**Print before starting:**
> "→ [Step 6.85/13] Applying the offline scope approved at Gates 1 and 2…"

Do not ask another question here. Gate 1 records whether offline operation is
required, and Gate 2 approves the exact tables, relationships, columns, row
scope, and sync interval.

| Approved plan state | Action |
|---|---|
| No Dataverse tables or offline marked `not-applicable` | Record `status: not-applicable`; continue |
| Offline deferred | Record the explicit deferral and readiness impact; continue |
| Offline approved | Invoke `/setup-offline-profile --skip-planning --plan native-app-plan.md`; its writes must match the Gate 2 contract exactly |

**State transfer:** `/setup-offline-profile` updates `memory-bank.md` `## Offline profile` and writes `offline-profile.json` to the project root. Step 13 (final summary) reads these for the wrap-up summary.

On `BLOCKED`, propagate up. No offline sub-skill approval gate is permitted in
this orchestrated path because the user already approved the complete offline
architecture at Gate 2.

### Step 7 — Auth config

**Print before starting:**
> "→ [Step 7/13] Configuring app authentication (Entra ID app registration)…"

The template ships `auth.config.json` with blank `msal.clientId` and
`msal.tenantId`. There are no baked-in registration IDs to reuse. Consume the
authentication decision approved at Gate 1; do not ask another question here.

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

#### 7.2 Apply the approved authentication decision

Read the Gate 1 authentication entry from `native-app-plan.md`.

- `existing-client-id` → run 7.3 with the already-approved GUID.
- `configure-later` → run 7.4.
- Missing or malformed entry → `BLOCKED`; the four-gate plan is incomplete.

#### 7.3 Write client ID into `auth.config.json`

Validate the Gate 1 client ID as a UUID. Write `auth.config.json` using `Edit`:
- Replace `msal.clientId` with the user's value
- Replace `msal.tenantId` with `<tenant-guid>` from 7.1
- Preserve the existing top-level `environment` block if present. If it is missing but `.resolved-environment.json` exists, add that JSON as top-level `environment`.

Do not create or modify the registration from this skill. The user owns it. Just wire the IDs into `auth.config.json`.

Print:
> "→ Wired app registration into auth.config.json.
> Client ID: `<id>`
> Tenant: `<tenant-guid>`"

Jump to Step 8.

#### 7.4 Configure auth later

Write `auth.config.json` using `Edit`:
- Set `msal.tenantId` to `<tenant-guid>` from 7.1
- Leave `msal.clientId` as `""`
- Preserve or add the top-level `environment` block from `.resolved-environment.json` if available

Print:
> `⚠️ Auth client ID is not configured. The app will fail to sign in until you add one. Run /set-app-registration-native later, or paste an app registration client ID into auth.config.json for tenant <tenant-guid>.`

Do NOT touch `src/playerConfig.ts` — auth identifiers live in `auth.config.json` only.

### Step 8 — Apply data model

If `<dataverse_planning_mode> = connector-only`, verify the approved
`## Data Model` says zero Dataverse tables and no `.datamodel-manifest.json`
exists, print `↷ Step 8 skipped — connector-only app has no Dataverse data model.`,
skip Step 8.5 as well, and continue to Step 9. A non-empty Dataverse plan in
this mode is a planning mismatch and must be corrected before continuing.

**Print before starting:**
> "→ [Step 8/13] Preparing the approved Dataverse operation manifest, then invoking /add-dataverse for sequential metadata writes and service generation. Dataverse write time varies by environment; local manifest preparation is deterministic, not a wall-clock promise."

**Environment pre-check (before invoking /add-dataverse):** Verify that `.resolved-environment.json` / `power.config.json` match the environment captured in Step 1. If they differ, warn the user immediately — creating tables in the wrong environment is the #1 silent breakage in this step. `/add-dataverse` Step 3a does its own check, but catching it here saves a failed attempt.

For the fast-v2 `required` path, keep the foreground planning snapshot as
planning evidence only. It never authorizes a write. Without changing any
approval gate, Step 8 must perform one fresh bounded reconciliation for every
exact table in the approved structured schema; each existing table reloads
ordinary typed columns, lookups, M:N/1:N relationships, and alternate keys.
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

node "${CLAUDE_SKILL_DIR}/../../scripts/create-dataverse-snapshot.js" \
  --env-url "$ACTIVE_ENV_URL" \
  --tenant-id "$ACTIVE_TENANT_ID" \
  --solution "$ACTIVE_SOLUTION_UNIQUE_NAME" \
  --tables "$EXACT_TABLES" \
  --proposed-tables "$PROPOSED_TABLES" \
  --reconcile-exact \
  --output "$EXECUTION_RECONCILIATION"

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
The publish checkpoint is retained across schema/PublishXml failure and
deleted only after successful publish, so a rerun retries pending publication
even when schema writes are already idempotent.
It creates Tier 0 → N tables, applies extensions, runs
`npx power-apps add-data-source --api-id dataverse --org-url <envUrl>
--resource-name <name>` per service-required table from the app root,
type-checks, and returns. Real matched A/B runs are still required to quantify
the end-to-end time saved; do not present local manifest timing as a guaranteed
1–3 minute Dataverse result.

After `/add-dataverse` returns, run the **Dataverse/generated-services gate**:

```bash
npm run generate-schemas
npx tsc --noEmit
```

If this fails, do not continue to native capabilities, connectors, navigation, or screens. Capture the full error list once, batch-fix generated-service/model or alias-map issues, then rerun the gate. If the failure is a hidden Dataverse collision already recovered via an alias (for example `aircraft` → `aircraftv2`), make sure the alias is reflected in `native-app-plan.md`, `memory-bank.md`, and the Generated Services snapshot before rerunning.

### Step 8.5 — Seed sample data (auto)

**Print before starting:**
> "→ [Step 8.5/13] Reconciling exact sample fixtures by business key and seeding missing rows."

Invoke `/add-sample-data` after Step 8. This step is **not optional** — every fresh-scaffolded app must have data to render on first launch:

```
Invoke skill: /add-sample-data

Arguments:
  --working-dir <working_dir>
```

`/add-sample-data` reads `.datamodel-manifest.json`, discovers live insertion
metadata, creates stable business keys for every fixture, validates required
lookups and choice values, and executes `scripts/seed-sample-data.js` in
dependency order. `.sample-data-journal.json` is the authoritative resume
state; unrelated existing records never satisfy a fixture.

If `.datamodel-manifest.json` is missing, return `BLOCKED`; Step 8 did not
complete cleanly enough to seed safely.

If seeding returns `BLOCKED`, stop before Step 9 and preserve the journal. The
user can fix the reported metadata, dependency, permission, or row error and
re-run the same command; successful fixtures are reused by business key. A
partial fixture must not be presented as a completed generated app.

### Step 9 — Apply native capabilities

**Print before starting:**
> "→ [Step 9/13] Wiring <N> native capabilities: <list>. Each runs sequentially."

Read the `## Native Capabilities` section from `native-app-plan.md`. For each capability, invoke `/add-native` — it routes to nested helpers for camera/PDF/pen controls when needed, otherwise generates a generic wrapper:

```
Invoke skill: /add-native

Arguments:
  --working-dir <working_dir>
  --capability <name>
```

Run sequentially. Each writes a single file under `src/native/` and does not touch `package.json` or `app.config.js`, so they could in principle run in parallel — but sequential keeps the orchestration log readable.

If the plan says "None — this app uses only standard React Native components and Power Platform connectors", skip only the native-capability invocation above and continue to Step 9a. Do NOT skip Step 9a or Step 9b; an app can need a pure-JavaScript library without any native capability, and Tamagui aliases/brand tokens are always required.

### Step 9a — Install approved pure-JavaScript dependencies

Read and execute the Installation Contract in [`shared/references/javascript-dependency-planning.md`](${CLAUDE_SKILL_DIR}/../../shared/references/javascript-dependency-planning.md) for every approved row in `## Screens → ### JavaScript Dependencies`. If the subsection is absent or says `None.`, continue without changing dependencies.

Gate 3 approval is consent for exactly the packages and versions in the table.
Install them into `<working_dir>` before any skeleton or builder imports them,
validate `package.json` and the lockfile, and verify module resolution. Do not
substitute another package/version or route a JS-only package through
`/add-native`.

### Step 9b — Integrate the approved design system

`/design-system` owns user-facing brand/design choices. This step owns the internal Tamagui integration that makes those choices usable by generated screens. Even if the user accepts the default design path, run the alias-only integration so screens can rely on the semantic token contract.

Execute the integration step:

| Condition | Action |
|---|---|
| `brand/tokens.ts` exists | **Highest priority.** Apply `../design-system/references/tamagui-integration.md` in brand-import mode, then wire brand `ThemeTokens` into `app/_layout.tsx` (see below). |
| `brand/tokens.ts` missing | Generate default tokens and apply `../design-system/references/tamagui-integration.md` in alias-only mode, then skip `_layout.tsx` wiring. |


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

### Step 10b — Wire navigation layout

Read `## Screens → Navigation Pattern` from `native-app-plan.md`.

- **Stack** — skip. `app/(app)/_layout.tsx` already renders `<Stack>`. Nothing to do.
- **Tabs** or **Tabs + Stack** — write outer `<Tabs>` in `app/(app)/_layout.tsx` AND a per-folder inner `<Stack>` in each `app/(app)/<folder>/_layout.tsx`.
- **Drawer** — write outer `<Drawer>` in `app/(app)/_layout.tsx` AND a per-folder inner `<Stack>` in each `app/(app)/<folder>/_layout.tsx`.

> **⚠️ The phantom-tab fix lives here.** expo-router auto-registers every top-level `.tsx` file under `app/(app)/` as a tab/drawer entry. Step 10b prevents phantom entries by walking the **File** column in the Screen Map (not the Screen names): each unique top-level entry under `app/(app)/` — file OR folder — becomes ONE tab/drawer entry. Folders contain detail/modal screens *inside* their own stack, so they never leak as siblings.

#### Step 10b.1 — Compute the layout structure from the Screen Map

Read the Screen Map's **File** column. For every row whose File starts with `app/(app)/`, classify each path into one of three groups:

| Path shape | Classification | Example |
|---|---|---|
| `app/(app)/<name>.tsx` (no subfolder) | **Top-level flat file** — one outer entry, no inner layout | `app/(app)/home.tsx` |
| `app/(app)/<folder>/index.tsx` | **Folder root** — one outer entry, needs inner `_layout.tsx` | `app/(app)/inspections/index.tsx` |
| `app/(app)/<folder>/<child>.tsx` (any other file inside a folder) | **Folder child** — pushed into the folder's stack, NOT an outer entry | `app/(app)/inspections/[id].tsx` |

Build two lists from the classification:

1. **Outer entries** = unique `<name>` from the top-level flat files + unique `<folder>` from the folder roots. These get one `<Tabs.Screen>` or `<Drawer.Screen>` each in the outer layout.
2. **Inner stacks** = one entry per unique `<folder>`. For each folder, list its children (root + non-root files), with each child's `Presentation` value from the Screen Map.

**Sanity check before writing anything:** if any folder has children but no `index.tsx` row in the Screen Map, STOP and report: `BLOCKED: folder app/(app)/<folder>/ has children (<list>) but no index.tsx row in the Screen Map. The screen-planner must emit an index.tsx row for every folder.` This catches a planner mistake that would render the folder unreachable from the outer tab.

Normalize every Screen Map file to its Expo route (strip `.tsx`, collapse trailing `/index`, preserve dynamic segments). If two files normalize to the same route, STOP before writing layouts. In particular, reject `<parent>/[id].tsx` together with `<parent>/[id]/<child>.tsx`; move the detail contract to `<parent>/[id]/index.tsx`.

```text
BLOCKED: duplicate Expo route <route> from <file-a> and <file-b>. Use [id]/index.tsx when a dynamic detail route owns child screens.
```

#### Step 10b.2 — Write per-folder inner `_layout.tsx` files (if any folders exist)

For each entry in the Inner stacks list, create the folder if missing and write `app/(app)/<folder>/_layout.tsx` with this template:

```tsx
import { Stack } from 'expo-router';

export default function <FolderName>Layout() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="index" />
      {/* one <Stack.Screen> per non-index child, with presentation from Screen Map */}
      <Stack.Screen name="<child-without-tsx>" options={{ presentation: '<Presentation>' }} />
    </Stack>
  );
}
```

Rules:
- `headerShown: false` at the Stack level — each screen sets its own header inline via `<Stack.Screen options={{...}}>` at the top of its component (the Expo Router idiom).
- `<Stack.Screen name="index" />` is required — without it, the folder root won't render.
- `presentation: 'modal'` and `presentation: 'formSheet'` come from the Screen Map's Presentation column. Skip the `options` prop entirely for `default` presentation.
- `name` for `[id].tsx` is literally `[id]` (with brackets). When `[id]` owns child routes, create `<folder>/[id]/_layout.tsx` with `<Stack.Screen name="index" />` and child entries; do not register both `[id].tsx` and a `[id]/` folder.
- Folder name in the function name is PascalCase (e.g. `InspectionsLayout`).

**Why this must run BEFORE Step 11:** screen-builders write their files in parallel, multiple builders may target the same folder, and any of them creating `_layout.tsx` would race. The orchestrator owns these files.

#### Step 10b.3 — Write outer `app/(app)/_layout.tsx`

Now rewrite only the `return` statement in `app/(app)/_layout.tsx`. Keep every line above the `return` untouched (auth guard, all imports).

**How to build the `<Tabs>` block (Tabs / Tabs + Stack pattern):**

For each entry in the Outer entries list, emit one `<Tabs.Screen>`. The `name` is the file/folder name without `.tsx`:

For each tab, infer a Ionicons icon name from the screen name:

| Screen name contains | Icon |
|---|---|
| home, dashboard, overview | `home-outline` |
| inspect, audit, checklist, task | `clipboard-outline` |
| profile, account, me, user | `person-outline` |
| settings, config, preferences | `settings-outline` |
| report, analytics, chart, stats | `bar-chart-outline` |
| map, location, sites, field | `map-outline` |
| message, chat, inbox, notify | `chatbubble-outline` |
| anything else | `apps-outline` |

**The Edit to apply:**

Add `import { Tabs } from 'expo-router';`, `import { Ionicons } from '@expo/vector-icons';`, and `import { useThemeTokens } from '@microsoft/power-apps-native-host';` to the import block if not already present. Inside `AppLayout`, after the auth state is read, add `const theme = useThemeTokens();`. Then replace:

```tsx
return (
  <Stack
    screenOptions={{
      headerShown: false,
    }}
  />
);
```

with:

```tsx
return (
  <Tabs
    screenOptions={{
      headerShown: false,
      tabBarActiveTintColor: theme.accentBase,
      tabBarInactiveTintColor: theme.text2,
    }}
  >
    <Tabs.Screen
      name="<screen-file-name>"
      options={{
        title: '<Screen Title>',
        tabBarIcon: ({ color }) => <Ionicons name="<icon>" size={22} color={color} />,
      }}
    />
    {/* one Tabs.Screen per top-level tab */}
  </Tabs>
);
```

Run `npx tsc --noEmit` after the edit. If it fails, check that the `Tabs.Screen name` values exactly match the file names under `app/(app)/` (without `.tsx`).

**How to build the `<Drawer>` block (Drawer pattern only):**

Same Outer-entries computation as Tabs — one entry per top-level flat file or folder root from Step 10b.1. Detail, modal, and nested routes are inside their folder's inner stack, not drawer items.

Use the same icon mapping table as Tabs (above).

**The Edit to apply:**

Add `import { Drawer } from 'expo-router/drawer';`, `import { Ionicons } from '@expo/vector-icons';`, and `import { useThemeTokens } from '@microsoft/power-apps-native-host';` to the import block if not already present. Inside `AppLayout`, after the auth state is read, add `const theme = useThemeTokens();`. Then replace the existing `<Stack>` return with:

```tsx
return (
  <Drawer
    screenOptions={{
      headerShown: true,
      drawerType: 'front',
      drawerActiveTintColor: theme.accentBase,
      drawerInactiveTintColor: theme.text2,
      drawerStyle: { width: 280 },
    }}
  >
    <Drawer.Screen
      name="<screen-file-name>"
      options={{
        title: '<Screen Title>',
        drawerIcon: ({ color }) => <Ionicons name="<icon>" size={22} color={color} />,
      }}
    />
    {/* one Drawer.Screen per top-level destination */}
  </Drawer>
);
```

**Key differences from Tabs:**
- Import is `from 'expo-router/drawer'` (not `from 'expo-router'`)
- `headerShown: true` — drawer needs the hamburger icon in the header; hiding it makes the drawer unreachable
- `drawerType: 'front'` — standard mobile pattern (drawer slides over content)
- Icon prop is `drawerIcon` (not `tabBarIcon`)

Run `npx tsc --noEmit` after the edit. If it fails, check that the `Drawer.Screen name` values exactly match the file names under `app/(app)/` (without `.tsx`).

### Step 10.7 — Snapshot generated services into the plan

**Print before starting:**
> "→ [Step 10.7/13] Probing src/generated/services/ and writing the service registry into native-app-plan.md…"

Before spawning N parallel screen-builders, the orchestrator probes `src/generated/services/` ONCE and writes the result into `native-app-plan.md`. Without this, every builder runs its own `Glob`, may spell service names differently, and ends up with mixed states inside one app (some screens use `CrXxxService.getAll()`, others write `// TODO(connector-not-yet-added)` for the same service).

```bash
cd <working_dir>
ls -1 src/generated/services/*.ts 2>/dev/null | sed 's|src/generated/services/||;s|\.ts$||'
```

For each service file found, run a quick grep to list its exported methods so builders know what's actually available without re-reading the (large) generated file:

```bash
for svc in $(ls -1 src/generated/services/*.ts 2>/dev/null); do
  name=$(basename "$svc" .ts)
  methods=$(grep -oE 'static async [a-zA-Z_]+' "$svc" | sed 's/static async //' | tr '\n' ',' | sed 's/,$//')
  echo "| \`$name\` | \`src/generated/services/$name.ts\` | $methods |"
done
```

Write the result into `native-app-plan.md` as a new section **immediately after `## Screens`** (and refresh it on every re-run — services come and go as the user runs `/add-dataverse`, `/add-sharepoint`, etc.):

```markdown
## Generated Services (snapshot at <ISO timestamp>)

| Service | Path | Methods present |
|---|---|---|
| `Cr3e9_projectsService` | `src/generated/services/Cr3e9_projectsService.ts` | `getAll, get, create, update, delete` |
| `Cr3e9_tasksService` | `src/generated/services/Cr3e9_tasksService.ts` | `getAll, get, create, update, delete` |

**For screen-builders:** if a service your spec references is in this table, import it and use the exact name + methods listed. If it is NOT in this table, the data source has not been added yet — write the screen with the expected import path and a `// TODO(connector-not-yet-added): run /add-dataverse to generate <ServiceName>` comment so the user can see what's blocked. Do not invent or rename services.
```

If the directory is empty (no data sources added yet), still write the section with an empty table and a one-line note: "No generated services yet — builders will emit TODO stubs for any service their spec references."

### Step 10.8 — Generate app-specific shared code + screen skeletons

**Print before starting:**
> "→ [Step 10.8/13] Generating app-specific components, hooks, utils, and screen skeletons from the plan…"

This step analyzes `## Product Experience`, `brand/design-system.md`, Shared
Conventions, and per-screen specs. It generates approved signature components,
shared code, and typed screen skeletons before parallel builders start.

Before generating anything, run the plan gate:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-experience-contract.js" \
  --project-root "<working_dir>"
```

Exit `2` blocks screen generation. Repair Product Experience, Design Direction,
design intake, Home materialization specs, or tab silhouettes and rerun. Do not
let builders infer missing structural fields.

---

#### 10.8a — Analyze plan for cross-screen patterns

Read all per-screen specs in `## Screens → ### Per-Screen Specs`. Identify:

0. **Signature components** — always generate every component named by Product
  Experience / brand `## Signature Components`, even when only Home uses it.
  Implement its typed props, stable geometry, required content regions,
  populated/loading/error/empty states, media source/fallback contract, and
  reference motifs. Do not replace it with a generic Card.
1. **Reference primitives** — generate a shared primitive when a required motif
  appears on 2+ screens. Preserve the motif's structure and states.
2. **Entity cards/rows** — if 2+ screens render the same entity (same Service) in a card/row format, generate a shared component.
3. **Choice column maps** — if 2+ screens reference the same choice column (e.g. `status: 1=Pending, 2=Active`), generate a constants file.
4. **Custom hooks** — if 2+ screens call the same service with similar params (e.g. both list + detail call `InspectionsService`), generate a domain hook.
5. **Shared formatters** — if screens need entity-specific formatting (e.g. "inspection title" = `${name} · ${equipment}`), generate a formatter.

**Decision rules:**

| Pattern in specs | Generate | Where |
|---|---|---|
| Product Experience names a signature component | `<SignatureName>.tsx` with stable state geometry | `src/components/` |
| Required reference motif appears on 2+ screens | `<MotifName>.tsx` | `src/components/` |
| Same entity shown as list-item on 2+ screens | `<Entity>Card.tsx` or `<Entity>Row.tsx` | `src/components/` |
| Same choice column referenced on 2+ screens | `constants.ts` with `ENTITY_STATUS` map + tone mapping | `src/utils/` |
| Same bounded service + similar `.getAll()` params on 2+ screens | `use<Entity>List.ts` wrapping `useListData` | `src/hooks/` |
| Same cursor-paginated service on 1+ unbounded screens | `use<Entity>CursorList.ts` wrapping `useCursorListData` | `src/hooks/` |
| Entity detail + edit screens for same entity | `use<Entity>.ts` with get + save + delete | `src/hooks/` |

**Write the files directly into the project** (not into samples — these are app-specific):

```bash
# Example — if plan has "Inspections" entity used on list + detail + home screens:
cat > "<working_dir>/src/components/InspectionRow.tsx" << 'EOF'
... generated component ...
EOF
```

Signature components are not subject to the reuse threshold. If none are
declared and no other cross-screen patterns exist, skip this sub-step.

**Signature-component requirements:**

- Use the First Viewport Contract's minimum height and share-compatible API.
- Keep loading/error/empty/populated outer dimensions stable.
- Use `expo-image` for remote/Dataverse media and approved local assets for local media.
- Expose a typed primary-action callback only when this component owns the action.
- Do not include an action that duplicates a tab/dock when forbidden.
- Add the canonical `experience-*` testIDs from
  `product-experience-contract.md` to signature, headline, media, action,
  next-section, and metric views for runtime geometry measurement.
- Export from a focused file and add the exact import to the owning screen skeleton.
- Compile with placeholder data before builders start.

---

#### 10.8b — Generate screen skeletons

For each screen in the plan's Screen Map that will be built by a screen-builder, write a **typed skeleton** file at its `target_file` path. The skeleton contains:

1. All imports (components, hooks, utils, services, types) pre-resolved
2. The exported component function with typed props/params
3. The hook calls (e.g. `useListData`, `useSearchFilter`, `useLocalSearchParams`)
4. An empty return with a `// TODO: screen-builder fills JSX here` marker

**Skeleton template for a Cursor List screen (`Pagination: cursor`):**
```tsx
import React from 'react';
import { FlatList, RefreshControl } from 'react-native';
import { useRouter } from 'expo-router';
import { YStack, XStack, Text, Input, Spinner } from 'tamagui';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LoadingState, ErrorState, EmptyState, ScreenHeader } from '@/components';
import { useCursorListData } from '@/hooks';
import { containsFilter, formatDate, choiceLabel } from '@/utils';
import { <Service> } from '@/generated/services/<Service>';
import type { <Entity> } from '@/generated/models/<Entity>Model';
// App-specific imports (if generated at 10.8a):
import { <Entity>Row } from '@/components/<Entity>Row';
import { <ENTITY>_STATUS } from '@/utils/constants';

export default function <ScreenName>() {
  const router = useRouter();
  const { items, loading, refreshing, loadingMore, hasNextPage, error, query, setQuery, onRefresh, refetch, loadMore } = useCursorListData<<Entity>>({
    queryKey: ['<entityPlural>'],
    fetchPage: ({ pageSize, search, skipToken }) => <Service>.getAll({
      maxPageSize: pageSize,
      orderBy: ['<orderField> desc', '<primaryKey> asc'],
      select: [<renderedColumns>],
      ...(search ? { filter: containsFilter('<searchColumn>', search) } : {}),
      ...(skipToken ? { skipToken } : {}),
    } as any),
  });

  // TODO: screen-builder fills JSX here. FlatList MUST wire:
  // - data={items}
  // - refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
  // - onEndReached={hasNextPage ? loadMore : undefined}
  // - ListFooterComponent={loadingMore ? <Spinner /> : null}
  return null;
}
```

**Skeleton template for a Bounded List screen (`Pagination: none`):**
```tsx
import React from 'react';
import { FlatList } from 'react-native';
import { useRouter } from 'expo-router';
import { YStack, XStack, Text, Input } from 'tamagui';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LoadingState, ErrorState, EmptyState, ScreenHeader } from '@/components';
import { RefreshControl } from 'react-native';
import { useListData, useSearchFilter } from '@/hooks';
import { formatDate, choiceLabel } from '@/utils';
import { <Service> } from '@/generated/services/<Service>';
import type { <Entity> } from '@/generated/models/<Entity>Model';
// App-specific imports (if generated at 10.8a):
import { <Entity>Row } from '@/components/<Entity>Row';
import { <ENTITY>_STATUS } from '@/utils/constants';

export default function <ScreenName>() {
  const router = useRouter();
  const { items, loading, refreshing, error, onRefresh, refetch } = useListData(
    () => <Service>.getAll({ orderBy: ['<orderField> desc'], top: 50 }),
  );
  const { query, setQuery, filtered } = useSearchFilter(items, [<searchKeys>]);

  // TODO: screen-builder fills JSX here
  return null;
}
```

Do NOT use the bounded skeleton for a screen whose spec says `Pagination: cursor`. `useListData` fetches one bounded page; `useSearchFilter` filters only loaded rows. Cursor screens must use `useCursorListData`, `useInfiniteQuery`, or an app-specific cursor hook generated in 10.8a.

**Skeleton template for a Detail screen:**
```tsx
import React from 'react';
import { ScrollView } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { YStack, XStack, Text, Button } from 'tamagui';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LoadingState, ErrorState, BottomActionBar, InfoRow } from '@/components';
import { formatDate, choiceLabel } from '@/utils';
import { <Service> } from '@/generated/services/<Service>';
import type { <Entity> } from '@/generated/models/<Entity>Model';

export default function <ScreenName>() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const [item, setItem] = React.useState<<Entity> | null>(null);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    if (!id) return;
    <Service>.get(id).then(r => { setItem(r.data ?? null); setLoading(false); });
  }, [id]);

  // TODO: screen-builder fills JSX here
  return null;
}
```

**Skeleton template for a Form screen:**
```tsx
import React, { useState } from 'react';
import { Alert, ScrollView, KeyboardAvoidingView, Platform } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { YStack, Text, Button, Input } from 'tamagui';
import { ModalHeader, FormField, RowPick } from '@/components';
import { <Service> } from '@/generated/services/<Service>';

export default function <ScreenName>() {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  // Form state fields from spec:
  <field_declarations>

  const submit = async () => {
    // TODO: screen-builder fills validation + service call
  };

  // TODO: screen-builder fills JSX here
  return null;
}
```

**Skeleton template for the Profile screen** (`/(app)/profile`, always generated; app-specific content comes from the Profile spec):
```tsx
import React from 'react';
import { Alert } from 'react-native';
import { useRouter } from 'expo-router';
import { YStack, XStack, Text, Button } from 'tamagui';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '@microsoft/power-apps-native-host';

export default function <ScreenName>() {
  const router = useRouter();
  // AuthState shape (@microsoft/power-apps-native-host): { isLoading, isAuthReady, isSignedIn, error, acquireToken, signIn, signOut }
  // There is NO `user` / `account` field. Display name comes from the ID-token claim, not from useAuth().
  const { isSignedIn, signOut } = useAuth();

  const handleSignOut = React.useCallback(() => {
    Alert.alert('Sign out?', 'You can sign in again with your work or school account.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Sign out',
        style: 'destructive',
        onPress: () => {
          void Promise.resolve()
            .then(() => signOut())
            .finally(() => router.replace('/login'));
        },
      },
    ]);
  }, [router, signOut]);

  // TODO: screen-builder fills JSX here. Any visible Sign out button calls handleSignOut.
  return null;
}
```

**Rules for skeleton generation:**
- Replace `<Service>`, `<Entity>`, `<ScreenName>`, `<searchKeys>`, `<orderField>`, `<field_declarations>` with actual values from the plan's per-screen spec + Generated Services table.
- If a service is NOT in the Generated Services table, still write the import but add `// TODO(connector-not-yet-added)` above it.
- Profile skeletons may also include generated service/model imports when the Profile spec's `Profile content` or `Data` fields require persisted app-specific user context. Keep the sign-out helper regardless of whether Profile also loads data.
- The skeleton is a **valid TypeScript file** (compiles with `return null`) — builders replace the `return null` with real JSX.
- Do NOT write skeletons for screens that already exist in the template (e.g. `home.tsx` if it's already present).
- The Profile skeleton must keep the `handleSignOut` helper and wire the planned `Sign out` button to it. Do not inline a second auth/logout path, and do not make Profile a sign-out-only screen.
- Do not merge sign-out imports or helpers into non-Profile screen skeletons. The Profile screen is the only sign-out owner.
- **Never destructure `user`, `account`, `profile`, or `claims` from `useAuth()`** — those fields do not exist on `AuthState`. The only fields are `isLoading`, `isAuthReady`, `isSignedIn`, `error`, `acquireToken`, `signIn`, `signOut`. If the screen needs the signed-in user's name/email, add a `// TODO: decode ID token claim` comment — do not invent a field.

---

#### 10.8c — DEPRECATED (skeleton is the import source of truth)

This sub-step previously appended `### Standard Imports` + per-screen `#### Resolved Imports` blocks into the plan. That added ~150 lines on a 14-screen plan and duplicated the imports already pre-resolved into each skeleton file at Step 10.8b.

**The skeleton file IS now the single source of truth** for per-screen imports + hook calls. The screen-builder reads the skeleton at `target_file` and fills the JSX. Do NOT append duplicate import documentation into the plan.

#### 10.8d — Navigation/skeleton TypeScript gate

After Step 10b layouts, Step 10.7 service snapshot, and Step 10.8 shared code/skeletons are all written, run the **Navigation/skeleton gate**:

```bash
npx tsc --noEmit
```

If this fails, do not launch Step 11. Capture the full error list once, batch-fix layout names, route paths, skeleton imports, shared component exports, generated service imports, or hook signatures, then rerun the gate. Screen-builders should start only from a clean shell with typed skeletons that compile with `return null`.

### Step 11 — Build screens (parallel)

**Build mode is NEVER a user-facing question.** Do not ask "Build mode? parallel/inline" or any variant. The orchestrator decides automatically per the preflight below.

**Quality rule — screen count/time is NOT a fallback trigger.** If `Task` can spawn `mobile-app:screen-builder`, always use screen-builder waves, even for 10+ screens. Do NOT write "given the scale/time, I'll write screens inline" or any equivalent shortcut. Screen-builder agents carry the quality checklist, domain-pattern rules, resolved-import discipline, safe-area/contrast/a11y checks, and per-screen return protocol. Inline mode exists only for host/tooling failure, not for convenience.

#### 11.0 — `Task` preflight (silent)

Before the first wave, do a one-shot probe to confirm `Task` can spawn `mobile-app:screen-builder`. Spawn ONE no-op builder via `Task` with `screen_name: __preflight__` and `target_file: <working_dir>/.preflight-probe.tsx` (the probe agent should return `DONE` immediately and the orchestrator deletes the file).

- **Probe returns `DONE` (any status code)** → parallel mode. Proceed with normal fan-out below. Do not downgrade later because there are many screens or because inline writing seems faster.
- **Probe errors with `Agent type … not found`, tool unavailable, or any nested-Task failure** → silent inline fallback. Print **once**:
  > "→ Parallel screen-builders unavailable in this host — building screens inline. (No action needed; this is automatic.)"
  Then iterate the screen list and apply the full screen-builder workflow inline (the orchestrator becomes the builder, reading the same per-screen specs and writing TSX directly). Inline does NOT mean "concise but functional" — it must still satisfy `screen-builder.md` quality gates, operational pattern requirements, safe-area/contrast/a11y rules, resolved imports, and the final checklist for every screen. Do NOT prompt the user.

**Hard rule — never ask the user about build mode.** The probe is the only decision input. If the host changes mid-run (rare), treat the next failure the same way: silently downgrade to inline and continue.

**Hard rule — no nested agent spawning.** Screen-builder agents MUST NOT spawn further agents (no nested `Task` calls). The top-level orchestrator owns the entire screen-builder fan-out: one `Task` batch per wave of up to 5 screens. If a builder needs help that previously would have been a nested spawn, it returns `NEEDS_CONTEXT:` and the orchestrator handles the follow-up at the wave boundary.

**Print before spawning** (substitute computed values; `<W>` = total waves = `ceil(N/5)`):
> "→ [Step 11/13] Building <N> screens in <W> wave(s) of up to 5 concurrent.
> Wave 1/<W> starting: <comma-separated screen names in this wave>."

Read the `## Screens` section's per-screen specs. For each screen the plan marks as new (skip baseline screens already in template), spawn a `mobile-app:screen-builder` agent via `Task` **in a single message** so they run in parallel. The `mobile-app:` plugin-name prefix is required.

```
Spawn N agents (parallel): mobile-app:screen-builder

Each prompt:
  working_dir: <working_dir>
  screen_name: <name>
  route: <route>
  target_file: <working_dir>/<File from Screen Map>
  plan_path: <working_dir>/native-app-plan.md
  skeleton_exists: true

  Follow screen-builder.md. Product Experience, Reference Contract, First
  Viewport, Shared Conventions, and the assigned per-screen spec are binding.
  Design Direction/brand files materialize those decisions. Inherited defaults
  are intentional; samples are API/import references only. A typed skeleton
  already exists at target_file with services and app-specific signature/motif
  imports pre-resolved. Fill in JSX without discarding imports. Return per
  AGENTS.md rule #10.
```

**`target_file` resolution (HARD):** read the **File** column from the Screen Map row for this screen and prefix it with `<working_dir>/`. The path may be nested (e.g. `<working_dir>/app/(app)/inspections/[id].tsx`). The folder is guaranteed to exist because Step 10b.2 created it and wrote the inner `_layout.tsx`. **Do NOT compute the path as `<working_dir>/app/(app)/<screen-name>.tsx`** — that strips the folder structure and produces phantom-tab files. If the Screen Map row has no File column (older planner output), fall back to the flat path and surface a `DONE_WITH_CONCERNS: Screen Map missing File column — used flat fallback paths, expect phantom tabs` after the wave.

**Cap at 5 concurrent.** If the plan has more than 5 new screens, batch them in waves of 5.

**Progress streaming — print one line per builder as the wave returns, then a wave summary.** The `Task` tool returns all parallel results together, but you can still narrate per-builder by iterating the returned results in order before doing the status-switch branching. Format:

```
  ✓ [3/8] HomeScreen — DONE
  ✓ [4/8] ListScreen — DONE_WITH_CONCERNS (1 connector stub)
  ✓ [5/8] DetailScreen — DONE
─── Wave 1/2 complete (5/8 screens built; 0 blocked, 1 with concerns) ───
```

Use `✓` for DONE / DONE_WITH_CONCERNS, `↻` for NEEDS_CONTEXT (will retry), `✗` for BLOCKED. Always print the running counter `[K/N]` so the user sees forward motion. The wave summary line goes on its own line after the per-builder block.

After the wave's TypeScript gate passes, and only then, print the next wave start line (if any):
> "Wave 2/<W> starting: <names>."

**After each wave returns, run the Step 3.2 status switch on every builder's first line.** Branch per builder:

- `DONE` → continue.
- `DONE_WITH_CONCERNS: <list>` (typical case: a `// TODO(connector-not-yet-added)` stub was emitted because the referenced service is not in the Generated Services table) → batch concerns across all builders, surface the consolidated list to the user once at the end of the wave (not per-builder — that would be noise), and ask whether to fix any pending connectors via `/add-connector` before continuing to Step 12. Record in `memory-bank.md`.
- `NEEDS_CONTEXT: <missing>` → re-spawn that one builder with the missing context appended to its prompt (cap 2 retries per screen, then `BLOCKED`). Print `↻ [K/N] <name> — retrying (missing: <missing>)` so the user understands the wave isn't fully clean yet.
- `BLOCKED: <reason>` → STOP for that screen, print `✗ [K/N] <name> — BLOCKED (<reason>)` and ask the user whether to (1) fix and retry, (2) skip the screen and continue with a placeholder, or (3) abort the whole flow.

After handling every builder status in the wave, run the **Screen-wave gate** before launching the next wave:

```bash
npx tsc --noEmit
```

If the wave gate fails, capture the full error list once, group failures by root cause, and repair in batch. For screen-owned files, re-spawn the affected screen-builder(s) with the consolidated TypeScript output appended to their prompts. Affected builders can be re-spawned in parallel. Cap retries at 2 per screen, then surface the failure to the user. Do not launch the next wave until the current wave gate is clean.

Common wave-gate repair classes to batch instead of fixing line-by-line:
- Generated service/model names: singular vs plural generated names, stale aliases after Dataverse rename.
- Service option shapes: `orderBy` must match the generated type, usually `string[]`.
- UI prop mismatches: invalid Tamagui shorthand props on components that do not support them.
- React Native style types: percent widths must use a typed percentage or shared `ProgressBar` helper.
- Dataverse create/update payload typing: prefer typed helper wrappers; if generated base types require server-owned fields, isolate any `as any` at the helper boundary, not throughout screen JSX.
- Stale connector TODOs: remove `TODO(connector-not-yet-added)` when the service exists in the Generated Services snapshot.

**After all waves return and the last wave gate is clean**, run one final `npx tsc --noEmit` before Step 12 to catch cross-screen issues that only appear when all screens exist. If it fails, use the same consolidated batch-repair flow.

Then run the canonical route-contract gate from the app root:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/check-routes.js"
```

This gate is required even when TypeScript passes. It detects duplicate normalized routes, `[id].tsx` plus `[id]/<child>.tsx` file/folder collisions, and sender/destination parameter drift. If it fails, repair the affected route files or re-spawn their screen builders with the consolidated findings, then rerun once. Do not continue to Step 11.4 or start Metro while route findings remain.

**Sticky tsc/build error policy (run-level).** The first time a `tsc` or `npm run build` failure surfaces in this run, ask the user once:

> "tsc found <N> error(s) in <files>. Patch + continue, or stop and let me investigate?"

Record the answer in `memory-bank.md` under `## Policies` as `tsc_error_policy: patch_continue` or `tsc_error_policy: stop_for_review`. **For every subsequent tsc/build error of the same class in the same run** (e.g., another screen failing typecheck after a builder retry, the cross-screen `tsc` after Step 11.4 fixes), apply the recorded policy automatically:

- `patch_continue` → re-spawn the matching builder with the error appended (or auto-patch in inline mode), respecting the 2-retry cap. Do not re-prompt the user.
- `stop_for_review` → STOP and surface the new error.

Reset the policy only if the user explicitly says "ask me again" or `/edit-app` is invoked. This avoids the same class of question being asked 3–5 times per run while still letting the user override at any point.

This sticky policy controls **how to handle a failed gate**, not whether the gate is required. Even with `patch_continue`, every required TypeScript gate must end clean before the flow advances.

### Step 11.4 — Stylistic fix sweep (parallel)

Run one controlled stylistic debt sweep after all screen-builder waves and TypeScript gates are clean, before preview or dev-server launch. This keeps screen-builder retries focused on critical compile/data/route issues, then fixes visual and accessibility quality across the full screen set in batches.

**Print before starting:**
> "→ [Step 11.4/13] Running stylistic validators in batch + auto-fixing contrast / accessibility / token issues across all screens (~2-3 min)"

**Scope:** generated screen files only: every file from the Screen Map plus any `app/(app)/**/*.tsx` screen written by Step 10.8/Step 11. Exclude layout files unless the reported issue is clearly inside generated screen chrome for that route group. Do not scan `src/generated/`, `brand/`, `node_modules/`, `.expo/`, or sample files.

**Available validators in v0:**

```bash
node "${CLAUDE_SKILL_DIR}/../../hooks/validate-screen-quality.js" --report <screen-files-or-app-dir>
node "${CLAUDE_SKILL_DIR}/../../hooks/validate-color-contrast.js" --report <screen-files-or-app-dir>
node "${CLAUDE_SKILL_DIR}/../../hooks/validate-screen-composition.js" --project-root "<working_dir>" --report <screen-files-or-app-dir>
```

`validate-screen-quality` covers general mobile quality;
`validate-color-contrast` resolves brand tokens and calculates measurable pairs
when possible; `validate-screen-composition` enforces Product Experience,
signature geometry/media, metric limits, duplicate tab actions, and tab-root
silhouettes.

For each available stylistic validator:

1. Run in `--report` mode against all generated screens. Report mode is non-blocking; it emits JSON issues with `file`, `line`, `rule`, `match`, `fix`, and `autoFixable`.
2. Merge issues by file and rule. Keep exact line numbers for user/debug output, but do not rely on stale line numbers after the first edit in a file.
3. Split findings into deterministic auto-fixes, structural contract failures,
   and judgement calls:
  - **Auto-fixable:** weak foreground tokens, white-on-yellow/orange status pairs, missing icon-only `aria-label`, missing tappable `role`, tiny icon button `hitSlop`, obvious raw hex/token substitutions, top-only safe area with bottom UI, `allowFontScaling={false}`. Apply these web-standard accessibility props to Tamagui 2 components; raw React Native components retain their React Native accessibility props.
  - **Needs review:** complex safe-area restructuring, dominant red detail headers, redundant status cue design, ambiguous brand colors, empty-state restructuring that requires moving JSX across large blocks.
  - **Structural failures:** every composition-validator issue. Re-dispatch the
    owning screen builder or Step 10.8 signature component generator; do not
    downgrade these to concerns.
4. Build one file-level edit batch per affected file. Apply affected files in parallel because screen files are independent. Do not run one edit per issue when multiple issues are in the same file; that reintroduces slow per-write loops and line-number drift.
5. Re-run the same validator in `--report` mode for the touched files. Cap retries at 2 per file per validator.

These validators are invoked explicitly by this mobile workflow. They are not registered as plugin-wide hooks because that would run them during unrelated Canvas Apps and other plugin operations.

After all quality/contrast auto-fixes and all structural composition failures
are clear, run:

```bash
npx tsc --noEmit
```

If `tsc` fails, use the existing TypeScript batch-repair policy. If stylistic issues remain after 2 retries or are judgement calls, do not keep looping. Record them in `memory-bank.md` and surface them as:

```text
DONE_WITH_CONCERNS: Step 11.4 left <N> stylistic issue(s) for review: <file:line rule summary>
```

#### Step 11.5 — Automated Design Refinement (LLM Polish)

After the script-based stylistic sweep catches the lowest-hanging fruit, apply the final layer of context-aware design polish to the generated screens.

**Print before starting:**
> "→ [Step 11.5/13] Running automated design refinement pass to polish UI, typography, RTL layouts, and accessibility..."

Invoke the design skill against the project:
```text
/design-react-native-app
```
Instruct the skill to review the generated screens in `<working_dir>/app/(app)/` against the brand design system at `<working_dir>/brand/tokens.ts`. The skill will autonomously apply visual polish, ensure WCAG 2.2 AA contrast, prep RTL mirrors, and improve layout hierarchies. 

This is an implementation pass against the already approved Gate 3 contract.
It must not run discovery, ask for a style choice, or create another approval.

Wait for the design skill to complete. If it made any changes, you MUST run a final TypeScript gate to ensure the changes did not break the build:
```bash
npx tsc --noEmit
```

Then continue only if TypeScript is clean. Step 11.5 may leave remaining qualitative concerns, but it may not leave the app in a broken TypeScript state.

#### Optional static preview

After `tsc` passes, offer a static HTML preview. The dev server starts next (Step 12), so default is skip:

> "→ N screens built and type-checked. The live app starts next.
>
> Want a static HTML preview first, or go straight to the live app?
>
> (a) Preview all screens — HTML phone frames for every screen
> (b) Preview key screens — Home + two repeated-loop screens
> (c) Skip preview
>
> [default: c]"

- **(a)** → invoke `/preview-screens` (all screens)
- **(b)** → invoke `/preview-screens` with Home plus two repeated-loop screen files
- **(c)** → proceed directly to Step 12

---

### Step 12 — Start dev server (background)

**Print before starting:**
> "→ [Step 12/13] Launching Metro dev server in the background so you can scan the QR."

This skill **launches** Metro in an async/background terminal so:

1. The QR code prints in the terminal — the user can scan with their dev client immediately.
2. Hot-reload works on file edits — no restart needed for screen tweaks.
3. **The agent owns the terminal** — when the user says "the screen is blank" / "data isn't showing" / "it crashed", the agent can read Metro's `console.log`, BUNDLE errors, and red-box stack traces directly via `BashOutput` (or its equivalent terminal-output tool) without asking the user to copy-paste.

**Launch commands:**

```bash
cd <working_dir>
npm run generate-schemas    # refresh schema map for any data sources added since last run (idempotent)
npx tsc --noEmit            # final gate — dev server starts only from a clean TypeScript state
```

Run the schema regen and final `tsc` synchronously and check both exits. If either fails, do not launch Metro. Capture the full output once, batch-fix by root cause, rerun the final gate, and continue only when clean. Then launch Metro async:

```bash
# Async / background — DO NOT block on this. Capture the terminal id.
npx expo start
```

Use `npx expo start` here instead of `npm run dev` because the orchestrator has already run `npm run generate-schemas` for the final gate. The template keeps `predev: npm run generate-schemas` as a safety net for humans running `npm run dev` manually, but the orchestrated path should not regenerate schemas twice.

When invoking the Bash tool: set `run_in_background: true` (or the equivalent async flag in your tool surface). Capture the returned terminal/shell id as `$METRO_TERMINAL_ID`.

**After launch, wait ≤8s for the "Metro waiting on" line, then:**

1. Read the terminal output once (`BashOutput` with the captured id).
2. **Extract the native Metro URL** from the terminal output:
   - Locate the line beginning `› Metro:` — it has the form `exp+<scheme>://expo-development-client/?url=<encoded-http-url>`. Capture the full Metro URL.
3. **Generate QR code PNG and present it to the user** (chat-first, deterministic fallback):
  - Run `npx --yes qrcode -o <working_dir>/.expo/metro-qr.png "<metro-url>"` to generate the PNG. If the project's npm config requires auth and the fetch fails with `E401`, retry once with `npm_config_registry=https://registry.npmjs.org/ npm_config_always_auth=false` prefixed.
  - Verify the PNG was created: `test -f <working_dir>/.expo/metro-qr.png` (exit code 0 = success). If it fails, print the qrcode error and continue to step 4.
  - **Chat-first render (best effort):** read and base64-encode the file (`base64 <working_dir>/.expo/metro-qr.png`) and embed in markdown as a data URI (`![QR](data:image/png;base64,<data>)`) so hosts that support inline image markdown show the QR directly in chat.
  - **Guaranteed visible fallback:** if inline chat image rendering is unavailable in the host UI, open the PNG directly in the default system image viewer/browser (`open <working_dir>/.expo/metro-qr.png` on macOS, `xdg-open ...` on Linux, `start "" ...` on Windows). This fallback is required whenever chat image rendering is unavailable.
  - Surface only the native Metro URL immediately after the image/fallback message.
4. **Optional: ASCII terminal QR for power users.** Extract and print the terminal's ASCII QR banner as a secondary/backup option:
   - Locate the first line composed of unicode block glyphs (`▀ ▄ █`) — that is the top of the QR.
  - Print every line from that line through the `› Metro:` line.
   - Cap at 30 lines as a safety net. Print as-is inside a fenced code block so terminal renderers preserve glyph alignment.
  - If the ASCII QR banner is not yet in the output, re-read `BashOutput` once more after another 4s before giving up. If still absent, skip the ASCII QR — PNG delivery from step 3 is the primary path.
5. Follow with:

   > "✓ Metro is running in background terminal `<id>`.
  > 📱 Scan the QR code shown above (or opened from `<working_dir>/.expo/metro-qr.png`) with your native dev client to load the app. Metro URL: `<metro-url>`
  > 🔄 Edits hot-reload automatically."

**Persist the terminal id to memory bank** so resumed sessions and downstream skills (`/preview-screens`, `/edit-app`, `/add-*`) can find it:

```markdown
## Project facts
...
- Metro terminal id: <id> (started <ISO date>)
- Metro launch cmd: cd <working_dir> && npx expo start
```

Metro remains running after Step 12. Continue directly to Step 12.3 for native
visual QA, then Step 12.5 and the final summary. Production build + tenant push
is a separate, explicit user action via the `/deploy` skill.

### Step 12.3 — Native visual QA

Read `## Product Experience` and invoke `/visual-qa` after Metro starts.

- All apps: standard native smoke for Home, tab roots, clipping/overlap, safe
  areas, blank media, action ownership, and tab silhouette variation.
- Pass `--full` when visual ambition is `premium`/`bespoke` or reference
  fidelity is `high`/`strict-structural`.
- Pass `--platform` from the target platforms and the plan/design-intake paths.

Handle the literal first line:

- `DONE` — record capture/report paths and continue.
- `DONE_WITH_CONCERNS:` — record missing viewport/platform coverage and surface
  it in Step 13; do not rewrite it as pass.
- `BLOCKED:` — preserve the completed app, record `Visual QA: BLOCKED` and the
  exact missing native evidence/static blocker, and continue to Step 13 without
  claiming visual completion.

Do not substitute `/preview-screens` or source inspection for this step.

### Step 12.5 — Optional debug handoff

Do not perform screen-by-screen runtime verification. Do not crawl routes, open browser targets, use React Native Web, or call Metro HTTP endpoints directly.

After Metro is running and the QR has been presented, offer a single optional debug handoff:

> "If the app shows an error or a workflow looks wrong after you load it in the native dev client, tell me the symptom and I can run `/debug-app "<symptom>"` using the Metro terminal logs."

Only invoke `/debug-app` if the user asks for debugging or gives a concrete symptom. `/debug-app` must use the captured Metro terminal output as its diagnostic source; it must not probe `localhost`, request a bundle URL, or run any React Native Web setup. If the user gives no symptom, proceed directly to Step 13.

When the user is ready to deploy:

```
/deploy            # runs npm run build + npx power-apps push
```

### Step 13 — Summary

Print a compact status block, then present exactly 5 options with no explanation. Do not add prose, tips, or "you might want to" text — keep it concise.

```
✅ Native code app created
─────────────────────────────────────────────
App name      : <displayName>
Project       : <working_dir>
Environment   : <env name> (<env id>)
Data model    : <N tables — M reuse, K extend, L create>
Native caps   : <list>
Connectors    : <list>
Screens       : <N total — M from template, K built in parallel>
Experience    : <product archetype> / <visual personality> / <Home composition>
Visual QA     : <PASS | CONCERNS — summary | BLOCKED — reason>
Visual report : <.visual-qa/report.md path or not produced>
Dev server    : npx expo start — running in background terminal <id>
                (scan QR there when you want to run locally)
─────────────────────────────────────────────
```

If Step 1 emitted warnings, list them in one line each under the block (no decoration).

Then present exactly these 5 options:

```
What now?

1. Preview screens in browser  (/preview-screens)
2. Deploy to tenant            (/deploy)
3. Edit the app                (/edit-app)
4. Add more capabilities       (/add-dataverse, /add-connector, /add-native)
5. Configure auth later        (/set-app-registration-native)

Which option? (or "none — I'll keep iterating locally")
```

**Hard rules for this step:**

- Do NOT add explanatory paragraphs after the options.
- Do NOT recommend an option ("most users want #2").
- Do NOT list alternative `npm` commands — the dev server is already running and is the only local iteration process the user needs to know about.
- Wait for the user's choice before doing anything else. If they pick none, stop.

## Notes

- This skill is the only entry point for new project creation. Do not invoke `/add-*` skills directly during a fresh-project flow — they don't know how to read the plan and would re-prompt the user.
- The foreground orchestrator owns Gate 1 and Gate 4. The planner normally owns Gates 2 and 3; only the documented inline fallback may present those same gates. Never duplicate a gate or turn an internal pass into a fifth approval.
- For mid-project changes after Step 13, the user should run individual `/add-*` skills, or `/edit-app` for plan-backed app iteration.

## Reference

- [shared/shared-instructions.md](${CLAUDE_SKILL_DIR}/../../shared/shared-instructions.md)
- [shared/references/screen-templates.md](${CLAUDE_SKILL_DIR}/../../shared/references/screen-templates.md)
- [agents/native-app-planner.md](${CLAUDE_SKILL_DIR}/../../agents/native-app-planner.md)
