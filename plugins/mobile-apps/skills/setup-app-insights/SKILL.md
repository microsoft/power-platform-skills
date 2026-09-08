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

- `/setup-app-insights` — enable, change, or disable Application Insights on an existing app.
- Invoked by `/edit-app` when the request is only an Application Insights change (its Step 0.5 fast path delegates here).
- Examples: "Enable Application Insights for this app", "Change the Application Insights resource this app uses", "Disable Application Insights for this app".

## When NOT to use

- Adding or changing custom events in app screens → configure Application Insights here first, then continue through `/edit-app` for those source changes.
- Data model / connector / native / design / screen changes → the respective `/add-*`, `/setup-*`, `/edit-app`, or `/design-system` skills.
- Provisioning a new Azure Application Insights resource → out of scope; this skill discovers or accepts an **existing** resource.

## Inputs

- `working_dir` — absolute path to the project root (auto-detected from cwd, or passed by an orchestrator).
- `--action <enable|change-resource|disable>` — optional; when omitted, inferred from current state and one question.

## Step 1 — Detect invocation mode

**Telemetry checkpoint: `resolve_app_insights_mode`**

```
1. Check env var CODE_APPS_NATIVE_ORCHESTRATING=1
   → Mode A (invoked by /edit-app). Use the passed --working-dir. Return a status block.

2. Else resolve working_dir from cwd (must contain app.json with an expo object)
   → Mode B (standalone). Return a human summary.
```

## Step 2 — Inspect and determine the action

**Telemetry checkpoint: `determine_app_insights_action`**

Read, when present:

- `<working_dir>/app.json`
- `<working_dir>/app/_layout.tsx`
- `<working_dir>/package.json`
- `<working_dir>/memory-bank.md`

If `app.json` is missing, malformed, or has no `expo` object, STOP without mutation (`BLOCKED` in Mode A). If uncommitted work overlaps `app.json` or `app/_layout.tsx`, follow the changed-file overlap approval rule in `shared-instructions.md`.

Determine the action:

- `enable` — `appInsightsConfig.enabled` is absent or `false` and the user wants it on.
- `change-resource` — already `enabled: true` and the user wants a different destination.
- `disable` — the user wants Application Insights turned off.
- If intent is ambiguous, ask one `AskUserQuestion` with those three choices, seeded by the current `enabled` state.

## Step 3 — Mutation preview + approval

**Telemetry checkpoint: `review_app_insights_change`**

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
  "<prompt-or-pretool>" \
  "<working_dir>"
```

Pass the invocation source so the event's `invocationSource` matches how the skill was reached: `pretool` in Mode A (delegated from another skill such as `/edit-app` via the Skill tool) and `prompt` in Mode B (the user ran `/setup-app-insights` directly).

This event follows the existing Mobile Apps telemetry controls and contains no Application Insights resource details or connection string. It fails open and never blocks the skill.

## Step 5a — enable / change-resource

**Telemetry checkpoint: `configure_app_insights_resource`**

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

- `getAppLogger()` is the host/runtime logger; its events continue to Microsoft OneDS and also fan out to the configured Application Insights resource.
- `getCustomerTelemetryLogger()` is for the app's custom events; it goes only to the configured Application Insights resource and is a no-op when custom events are disabled.
- Generate custom event calls only when the user explicitly requested those events or an approved screen spec has a `Custom events` entry. Never use `getAppLogger()` for custom events.
- Telemetry properties must be approved scalar values (result codes, durations, counts, screen identifiers, operation names). Never include form values, free text, record titles, names, emails, phone numbers, tokens, precise coordinates, nested objects, or complete URLs.

Persist in `memory-bank.md` (never the connection string):

```markdown
- Custom events: enabled
- Custom events app ID: <appId>
- Custom events resource ID: <selected-resource-id or admin-provided>
- Custom events destination: one customer-owned workspace-based Application Insights resource
```

## Step 5b — disable

**Telemetry checkpoint: `disable_app_insights`**

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

Persist `Custom events: disabled` and the app ID in `memory-bank.md`; remove stale resource ID / destination lines.

## Step 6 — Verify the provider wiring

**Telemetry checkpoint: `verify_app_insights_provider`**

Confirm `app/_layout.tsx` imports the root `app.json` and passes the complete object to `PowerAppsProvider`:

```tsx
import appConfig from '../app.json';

<PowerAppsProvider appConfig={appConfig}>
```

If either part is missing, patch only the import and the `appConfig` prop; preserve all other provider props and layout behavior. Run `npx tsc --noEmit` only when `app/_layout.tsx` changed.

Parse `app.json` with Node after the mutation and assert:

- `enable` / `change-resource`: `enabled === true` and `connectionString` is non-empty.
- `disable`: `enabled === false` and `connectionString === ""`.

## Step 6.5 — Offer operation instrumentation (enable / change-resource only)

**Telemetry checkpoint: `offer_operation_instrumentation`**

This skill only wires the telemetry pipeline; it never edits screens or generated services. Enabling Application Insights emits host-level signals (app load, unhandled errors, navigation) automatically, but **domain events like `todo_created` or `order_deleted` are custom events and require source changes**. Those changes belong to `/edit-app` → screen-planner → screen-builder, which emit named events through `getCustomerTelemetryLogger` under the existing scalar-only, no-PII allowlist. Offer that follow-up here; never instrument operations from this skill.

Run this step only after a successful `enable` or `change-resource`. Skip it entirely for `disable`.

- **Mode B (standalone):** ask one `AskUserQuestion`, defaulting to **No** (instrumentation is opt-in, mirroring Application Insights being off by default):

  > Application Insights is on. Want me to add custom events for your app's major operations (create / update / delete)?

  - **Yes** → invoke `/edit-app` with a scoped instrumentation brief and let its normal edit flow discover the entities, screens, and operation boundaries (this skill does not read the data model or screens):

    ```
    Invoke skill: /edit-app

    Arguments:
      Add custom events at each successful create, update, and
      delete boundary for the app's main entities. Emit named events through
      getCustomerTelemetryLogger with approved scalar properties only — no
      operation results, response payloads, form values, free text, record
      titles, personal identifiers, tokens, precise coordinates, nested
      objects, or complete URLs. Use trackScenario() for any duration.
    ```

  - **No** → finish with the normal Mode B summary.

- **Mode A (invoked by `/edit-app`):** do **not** ask the user or re-invoke `/edit-app` from here — that would loop back into the orchestrator. Instead signal the available follow-up in the return block (`instrumentation_offer: available`) so `/edit-app` surfaces the offer after the fast path completes.

## Support boundary

This skill discovers or accepts an **existing** Application Insights resource; it does not provision Azure resources. If the user lacks Azure access and has no administrator-provided connection string, leave telemetry disabled without blocking — the app runs fine with custom events off.

## Return

**Mode A (invoked by `/edit-app`) — status block, first line is the status code:**

```
DONE
action: <enable|change-resource|disable>
enabled: <true|false>
app_id: <appId>
layout_patched: <yes|no>
instrumentation_offer: <available|none>
```

`instrumentation_offer` is `available` only after a successful `enable`/`change-resource` (see Step 6.5); use `none` for `disable` or when telemetry was not turned on. Use `DONE_WITH_CONCERNS: <list>` when applied with caveats (e.g. an admin-provided string that could not be verified), `NEEDS_CONTEXT: <missing>` when a required input is unavailable, and `BLOCKED: <reason>` when `app.json` is unusable.

**Mode B (standalone) — human summary:**

> Application Insights <enabled|updated|disabled> for this app.
> Configuration: `app.json` → `expo.extra.appInsightsConfig`
> To change the resource or turn it off later, run `/setup-app-insights` again.

After an `enable`/`change-resource`, if the user accepted the Step 6.5 offer, note that operation instrumentation was handed to `/edit-app`; if they declined, mention they can run `/edit-app` later to add custom operation events.
