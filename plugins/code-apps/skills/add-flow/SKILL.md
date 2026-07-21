---
name: add-flow
description: Adds a Power Automate cloud flow to a Power Apps code app, fetching its metadata and swagger and generating a typed TypeScript service file. Use when integrating a cloud flow into a code app via the `npx power-apps add-flow` command.
user-invocable: true
allowed-tools: Read, Edit, Write, Grep, Glob, Bash, LSP, TaskCreate, TaskUpdate, TaskList, TaskGet, AskUserQuestion, Skill
model: sonnet
---

**📋 Shared Instructions: [shared-instructions.md](${CLAUDE_PLUGIN_ROOT}/shared/shared-instructions.md)** - Cross-cutting concerns.

# Add Flow

Adds a Power Automate cloud flow to the current code app by fetching its metadata and swagger from the Power Automate RP, writing connection references into `power.config.json`, saving a schema file, and generating a typed TypeScript service.

## Workflow

1. Check Memory Bank → 2. Find Flow ID → 3. Add Flow → 4. Review Generated Files → 5. Build → 6. Update Memory Bank

---

### Step 1: Check Memory Bank

Check for `memory-bank.md` per [shared-instructions.md](${CLAUDE_PLUGIN_ROOT}/shared/shared-instructions.md).

### Step 2: Find the Flow ID

The `--flow-id` must be the **Power Automate resource GUID** (the BAP/Power Automate resource ID, NOT the Dataverse `workflowidunique`).

**If the user already has the flow ID**, skip to Step 3.

**If the user does not have the flow ID**, run `/list-flows` to find it:

```bash
npx power-apps list-flows
# Or filter by name:
npx power-apps list-flows --search "<flow-name>"
```

The `workflowId` column in the output is the GUID to pass to `--flow-id`.

> **Note:** Only **solution-aware flows** appear in `list-flows`. If the target flow is missing, direct the user to [Power Automate](https://make.powerautomate.com) → Solutions → add the flow to a solution first.

### Step 3: Add Flow

```bash
npx power-apps add-flow --flow-id <guid>
```

**What this does:**

1. Fetches the flow's metadata and swagger from the Power Automate RP.
2. Filters connection references to `invoker`-sourced dependencies only (the ones the calling app must supply).
3. For each dependency, queries the connector and connection APIs to determine `authenticationType` and `sharedConnectionId`.
4. Writes a `shared_logicflows` connection reference (with `workflowDetails`) and stub dependency references into `power.config.json`.
5. Saves the flow's swagger as a schema file under `schemas/logicflows/<FlowName>.Schema.json`.
6. Runs codegen to produce a typed `<FlowName>Service.ts` model service.

Re-adding the same flow is **idempotent** — it matches by `workflowEntityId` and reuses the existing UUID.

**Failures:**

- `Configuration file not found`: Make sure you're running from the project root (the directory containing `power.config.json`). STOP.
- `Unable to retrieve connection '...'`: The user lacks access to an underlying connector connection used by the flow. They must ensure they have access to all connections the flow depends on. STOP.
- Auth errors: Run `pwsh -NoProfile -Command "pac auth create"` and retry.
- Any other non-zero exit: Report the exact output. STOP.

### Step 4: Review Generated Files

The command generates:

- `power.config.json` — updated with a new `shared_logicflows` connection reference containing `workflowDetails` (workflow entity ID, display name, resource name, and dependency UUIDs)
- `schemas/logicflows/<FlowName>.Schema.json` — the flow's swagger schema
- `src/generated/services/<FlowName>Service.ts` — typed async service methods

Show the user the generated service and a usage example:

```typescript
import { MyFlowService } from "../generated/services/MyFlowService";

// Invoke the flow
const result = await MyFlowService.executeAsync({
  // Parameters match the flow's trigger inputs
  inputParam: "value"
});
```

**Inspecting the generated service:**

Generated service files can be large. Use Grep to find available methods rather than reading the whole file:

```
Grep pattern="async \w+" path="src/generated/services/<FlowName>Service.ts"
```

See [connector-reference.md](${CLAUDE_PLUGIN_ROOT}/shared/connector-reference.md#inspecting-large-generated-files) for details.

### Step 5: Build

```bash
npm run build
```

Fix any TypeScript errors before proceeding. Do NOT deploy yet.

### Step 6: Update Memory Bank

Update `memory-bank.md` with: flow name, flow ID, generated service file path, and any dependency connections wired up.
