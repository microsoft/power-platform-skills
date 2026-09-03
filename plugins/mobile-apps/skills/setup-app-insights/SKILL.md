---
name: setup-app-insights
description: Configure optional customer-owned Application Insights telemetry for a Power Apps mobile app — enable it against an existing Azure resource, change the resource, or disable it. Standalone, and invoked by /edit-app.
user-invocable: true
allowed-tools: Read, Write, Edit, Glob, Grep, Bash, AskUserQuestion
model: opus
---

**Shared instructions: [shared-instructions.md](../../shared/shared-instructions.md)** — read first.

# Set up Application Insights

Configures the generated app's optional, customer-owned Application Insights telemetry through `app.json` → `expo.extra.appInsightsConfig`. This is host/runtime configuration, not a connector or plan section — it never touches the data model, native-capability matrix, connector list, or screens.

Application Insights is **off by default**. Invoking this skill (or approving its mutation) is the explicit opt-in; consent is never inferred from an app description.

## When to use

- `/setup-app-insights` — enable, change, or disable customer Application Insights on an existing app.
- Invoked by `/edit-app` when the request is only an Application Insights change (its Step 0.5 fast path delegates here).
- Examples: "Enable Application Insights for this app", "Change the Application Insights resource this app uses", "Disable Application Insights for this app".

## When NOT to use

- Adding or changing customer-defined events in app screens → configure Application Insights here first, then continue through `/edit-app` for those source changes.
- Data model / connector / native / design / screen changes → the respective `/add-*`, `/setup-*`, `/edit-app`, or `/design-system` skills.
- Provisioning a new Azure Application Insights resource → out of scope; this skill discovers or accepts an **existing** resource.

## Inputs

- `working_dir` — absolute path to the project root (auto-detected from cwd, or passed by an orchestrator).
- `--action <enable|change-resource|disable>` — optional; when omitted, inferred from current state and one question.

## Step 1 — Detect invocation mode

```
1. Check env var CODE_APPS_NATIVE_ORCHESTRATING=1
   → Mode A (invoked by /edit-app). Use the passed --working-dir. Return a status block.

2. Else resolve working_dir from cwd (must contain app.json with an expo object)
   → Mode B (standalone). Return a human summary.
```

## Step 2 — Inspect and determine the action

Read, when present:

- `<working_dir>/app.json`
- `<working_dir>/app/_layout.tsx`
- `<working_dir>/package.json`
- `<working_dir>/memory-bank.md`

If `app.json` is missing, malformed, or has no `expo` object, STOP without mutation (`BLOCKED` in Mode A). If uncommitted work overlaps `app.json` or `app/_layout.tsx`, follow the changed-file overlap approval rule in `shared-instructions.md`.

Determine the action:

- `enable` — `appInsightsConfig.enabled` is absent or `false` and the user wants it on.
- `change-resource` — already `enabled: true` and the user wants a different destination.
- `disable` — the user wants customer Application Insights turned off.
- If intent is ambiguous, ask one `AskUserQuestion` with those three choices, seeded by the current `enabled` state.

## Step 3 — Mutation preview + approval

Show one focused preview and continue only after approval:

```text
─── Application Insights ────────────────────────────
Action        <enable | change resource | disable>
Current       enabled: <true|false>
Configuration app.json → expo.extra.appInsightsConfig
Provider      app/_layout.tsx → PowerAppsProvider appConfig
Sensitive     connection string is never printed or stored in memory-bank.md
```

Ask: `Apply this Application Insights change?`

## Step 4 — Emit the selection telemetry

After the action is confirmed, record the choice through Mobile Apps usage telemetry (`enabled` for enable/change-resource, `disabled` for disable):

```bash
node "${PLUGIN_ROOT}/hooks/run-telemetry.js" \
  app-insights-selection \
  "<enabled-or-disabled>" \
  "<working_dir>"
```

This event follows the existing Mobile Apps telemetry controls and contains no Application Insights resource details or connection string. It fails open and never blocks the skill.

## Step 5a — enable / change-resource

Discover Application Insights resources visible to the current Azure CLI identity:

```bash
az resource list \
  --resource-type Microsoft.Insights/components \
  --query "[].{name:name,id:id,resourceGroup:resourceGroup,location:location}" \
  -o json
```

Branch on the result:

- **One or more resources returned:** use `AskUserQuestion` to let the user select one. Retrieve its connection string without printing it:

  ```bash
  APP_INSIGHTS_CONNECTION_STRING=$(
    az resource show \
      --ids "<selected-resource-id>" \
      --api-version 2020-02-02 \
      --query properties.ConnectionString \
      -o tsv
  )
  ```

- **Not logged in:** tell the user to run `az login`, then retry discovery once.
- **No subscription/resource access or authorization failure:** explain that Application Insights Azure RBAC is separate from Power Platform and Entra app-registration permissions. Offer an admin handoff: an administrator can create/select one workspace-based Application Insights resource and give the user its connection string.
- **No resources returned:** ask whether the user wants to paste an administrator-provided connection string or leave telemetry disabled. Do not require the user to create Azure resources.

When accepting a pasted connection string, use `AskUserQuestion` freeform and never repeat the answer in chat or command output. Validate only that it contains `InstrumentationKey=` and either an `IngestionEndpoint=` or that the standard public-cloud default can be used. Do not store the connection string in `memory-bank.md`.

Update `<working_dir>/app.json` so `expo.extra.appInsightsConfig` contains:

```json
{
  "expo": {
    "extra": {
      "appInsightsConfig": {
        "enabled": true,
        "connectionString": "<selected-or-pasted-connection-string>",
        "appId": "<appId>",
        "environment": "development",
        "includeUserId": false
      }
    }
  }
}
```

Field rules:

- `appId` — preserve the existing non-empty value; otherwise use `expo.slug`, then `package.json` `name`.
- `environment` / `includeUserId` — preserve existing values; default to `"development"` and `false`. Never turn on user identity collection implicitly.
- Set `enabled: true` and replace only the connection string. Create the `appInsightsConfig` object when missing, and preserve every other `app.json` field.

Never print the connection string, pass it to another agent, write it to `native-app-plan.md` or `memory-bank.md`, or include it in a summary.

### Runtime notes (for screen work that follows)

The app uses `@microsoft/applicationinsights-web` with the React Native manual-device plugin. The first runtime event is `PowerAppsNative.ApplicationStarted`, a deterministic ingestion check after loading the app in Dev Player. The runtime exposes two intentionally different loggers:

```ts
import {
  getAppLogger,
  getCustomerTelemetryLogger,
} from '@microsoft/power-apps-native-host';
```

- `getAppLogger()` is the host/runtime logger; its events continue to Microsoft OneDS and also fan out to the configured customer resource.
- `getCustomerTelemetryLogger()` is for customer-defined app events; it goes only to the configured customer resource and is a no-op when customer telemetry is disabled.
- Generate customer event calls only when the user explicitly requested those events or an approved screen spec has a `Customer telemetry` entry. Never use `getAppLogger()` for customer-defined events.
- Telemetry properties must be approved scalar values (result codes, durations, counts, screen identifiers, operation names). Never include form values, free text, record titles, names, emails, phone numbers, tokens, precise coordinates, nested objects, or complete URLs.

Persist in `memory-bank.md` (never the connection string):

```markdown
- Customer telemetry: enabled
- Customer telemetry app ID: <appId>
- Customer telemetry resource ID: <selected-resource-id or admin-provided>
- Customer telemetry destination: one customer-owned workspace-based Application Insights resource
```

## Step 5b — disable

Set `enabled: false`, clear `connectionString`, and preserve `appId` and `environment` when present. Keep `includeUserId: false` unless an existing explicitly approved value must be preserved. Do not require Azure sign-in or resource discovery.

```json
{
  "expo": {
    "extra": {
      "appInsightsConfig": {
        "enabled": false,
        "connectionString": "",
        "appId": "<appId>",
        "environment": "development",
        "includeUserId": false
      }
    }
  }
}
```

Persist `Customer telemetry: disabled` and the app ID in `memory-bank.md`; remove stale resource ID / destination lines.

## Step 6 — Verify the provider wiring

Confirm `app/_layout.tsx` imports the root `app.json` and passes the complete object to `PowerAppsProvider`:

```tsx
import appConfig from '../app.json';

<PowerAppsProvider appConfig={appConfig}>
```

If either part is missing, patch only the import and the `appConfig` prop; preserve all other provider props and layout behavior. Run `npx tsc --noEmit` only when `app/_layout.tsx` changed.

Parse `app.json` with Node after the mutation and assert:

- `enable` / `change-resource`: `enabled === true` and `connectionString` is non-empty.
- `disable`: `enabled === false` and `connectionString === ""`.

## Support boundary

This skill discovers or accepts an **existing** Application Insights resource; it does not provision Azure resources. If the user lacks Azure access and has no administrator-provided connection string, leave telemetry disabled without blocking — the app runs fine with customer telemetry off.

## Return

**Mode A (invoked by `/edit-app`) — status block, first line is the status code:**

```
DONE
action: <enable|change-resource|disable>
enabled: <true|false>
app_id: <appId>
layout_patched: <yes|no>
```

Use `DONE_WITH_CONCERNS: <list>` when applied with caveats (e.g. an admin-provided string that could not be verified), `NEEDS_CONTEXT: <missing>` when a required input is unavailable, and `BLOCKED: <reason>` when `app.json` is unusable.

**Mode B (standalone) — human summary:**

> Application Insights <enabled|updated|disabled> for this app.
> Configuration: `app.json` → `expo.extra.appInsightsConfig`
> To change the resource or turn it off later, run `/setup-app-insights` again.
