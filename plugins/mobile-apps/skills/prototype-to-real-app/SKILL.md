---
name: prototype-to-real-app
description: Use when the user wants to convert a mock-data mobile prototype created by /create-mobile-prototype into a real Power Apps mobile app backed by Dataverse, Power Platform connectors, and generated schemas. Binds the existing project to an environment, provisions data/connectors/native wrappers, cleans mock artifacts, then syncs screens from native-app-plan.md.
user-invocable: true
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, AskUserQuestion, Skill
model: opus
---

**Shared instructions: [shared-instructions.md](../../shared/shared-instructions.md)** — read first.

# Prototype To Real App

Convert an existing `/create-mobile-prototype` project from local mock services to real Dataverse and Power Platform connector services. This skill does not scaffold a new app.

## Inputs

- `--working-dir <path>` — optional; default current directory.
- `--environment <environment-id-or-url>` — optional target environment.
- `--no-sample-data` — skip real Dataverse sample data.
- `--skip-auth-registration` — leave `auth.config.json` client ID blank.
- `--force` — continue only after explicit confirmation when state is missing but prototype markers exist.

## Non-Negotiables

- Do not call `/create-mobile-app` or scaffold a new project.
- Do not mark `dataMode` as `dataverse` while mock services, `*.seed.json`, connector throw-stubs, or prototype schemas remain.
- Do not edit user screens to work around missing real services; provision the missing service first.
- Run `npm run generate-schemas` after real data sources/flows/connectors are added.
- Run `/sync-from-plan` exactly once after real services and native wrappers are in place.

## Workflow

### Step 1 — Verify Prototype State

Print:

```text
→ [real 1/9] Checking prototype state…
```

Verify:

```bash
test -f app.config.js && test -f package.json && test -f native-app-plan.md
```

Accept prototype mode when one is true:

- `.code-apps-native/state.json` has `dataMode: "prototype"`
- `power.config.json` uses the all-zero placeholder environment ID
- `src/generated/services/*.seed.json` exists and `.datamodel-manifest.json` is absent

If state is missing but prototype markers exist, create `.code-apps-native/state.json` with `dataMode: prototype` after user confirmation.

Run a baseline gate before conversion:

```bash
npm --prefix "<PROJECT_DIR>" run type-check
node "${CLAUDE_SKILL_DIR}/../../scripts/check-routes.js"
node "${CLAUDE_SKILL_DIR}/../../hooks/validate-screen-quality.js" --report app
node "${CLAUDE_SKILL_DIR}/../../hooks/validate-color-contrast.js" --report app
```

If baseline fails, stop and ask the user to repair the prototype before binding it to real data.

### Step 2 — Confirm Environment

Print:

```text
→ [real 2/9] Confirming Power Platform environment…
```

Resolve the target environment from `--environment`, `power.config.json`, or user prompt. Use `scripts/resolve-environment.js` to capture environment URL, environment ID, and tenant.

Before mutating, show the target environment and ask for explicit confirmation.

### Step 3 — Bind Project To Environment

Print:

```text
→ [real 3/9] Binding prototype to the selected environment…
```

Run `npx power-apps init -t MobileApp --display-name <name> --environment-id <id> --non-interactive` only when `power.config.json` is placeholder/missing or not bound to the selected environment. Preserve app files; do not copy a template over the project.

Then configure `auth.config.json` the same way as `/create-mobile-app` Step 7 unless `--skip-auth-registration` is set.

### Step 4 — Apply Dataverse

Print:

```text
→ [real 4/9] Applying Dataverse tables and generated services…
```

Invoke:

```text
/add-dataverse --working-dir <PROJECT_DIR> --skip-planning
```

`native-app-plan.md` remains the source of truth. `/add-dataverse` must create/extend/reuse tables, run `npx power-apps add-data-source`, write `.datamodel-manifest.json`, run `npm run generate-schemas`, and type-check.

Postconditions:

```bash
test -f "<PROJECT_DIR>/.datamodel-manifest.json"
npm --prefix "<PROJECT_DIR>" run generate-schemas
npm --prefix "<PROJECT_DIR>" run type-check
```

### Step 5 — Add Real Connectors And Flows

Print:

```text
→ [real 5/9] Adding real connector and flow services…
```

Read `## Connectors` from `native-app-plan.md`.

For each connector row:

| API name | Invoke |
|---|---|
| `sharepointonline` | `/add-sharepoint --working-dir <PROJECT_DIR>` |
| anything else | `/add-connector --working-dir <PROJECT_DIR> --connector <api-name>` |

For flow rows or migration packages that include `flows.json`, resolve target flow IDs and run:

```bash
npx power-apps list-flows --search "<flow-name>" --json
npx power-apps add-flow --flow-id <target-guid> --non-interactive
```

After each connector/flow batch:

```bash
npm --prefix "<PROJECT_DIR>" run generate-schemas
npm --prefix "<PROJECT_DIR>" run type-check
```

### Step 6 — Reconcile Native Capabilities

Print:

```text
→ [real 6/9] Reconciling native wrappers…
```

Read `## Native Capabilities` from the plan. Invoke `/add-native` or a dedicated native helper for missing/stale wrappers. This step is idempotent.

### Step 7 — Seed Real Sample Data

Print:

```text
→ [real 7/9] Seeding Dataverse sample data…
```

Unless `--no-sample-data`, ask whether to seed from prototype seed JSON. On yes:

```text
/add-sample-data --working-dir <PROJECT_DIR> --from-seed --auto
```

Sample-data failure is non-fatal; record `DONE_WITH_CONCERNS` and continue.

### Step 8 — Remove Prototype Artifacts And Mark Real

Print:

```text
→ [real 8/9] Removing mock artifacts and marking project real…
```

Run:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/cleanup-prototype-artifacts.js" "<PROJECT_DIR>"
npm --prefix "<PROJECT_DIR>" run generate-schemas
npm --prefix "<PROJECT_DIR>" run type-check
```

If cleanup fails, stop. Do not delete real generated services to force a pass.

Update `.code-apps-native/state.json`:

```json
{
  "dataMode": "dataverse",
  "environment": { "environmentId": "<id>", "environmentUrl": "<url>", "tenantId": "<tenant>" }
}
```

Append a concise `memory-bank.md` entry.

### Step 9 — Sync Screens Once

Print:

```text
→ [real 9/9] Syncing screens and running final gates…
```

Invoke:

```text
/sync-from-plan --working-dir <PROJECT_DIR>
```

Final summary includes environment, Dataverse status, connectors/flows added, native wrappers, sample-data status, cleanup status, sync result, and preview path.