---
name: list-flows
description: Lists solution-aware Power Automate cloud flows available in the current environment. Use when you need a flow ID before adding a flow to a code app, or when exploring available flows. Supports optional search filtering.
user-invocable: true
allowed-tools: Bash
model: haiku
---

**📋 Shared Instructions: [shared-instructions.md](${CLAUDE_PLUGIN_ROOT}/shared/shared-instructions.md)** - Cross-cutting concerns (Windows CLI compatibility, memory bank, etc.).

# List Flows

Lists solution-aware Power Automate cloud flows in the default environment using the Power Apps CLI (`npx power-apps`).

## Workflow

1. Fetch Flows → 2. Present Results

---

### Step 1: Fetch Flows

```bash
npx power-apps list-flows
```

To filter by name, pass `--search`:

```bash
npx power-apps list-flows --search "<keyword>"
```

If `pac` is not authenticated or the environment is not set, tell the user to run:

```bash
pwsh -NoProfile -Command "pac auth create"
pwsh -NoProfile -Command "pac env select --environment <environment-id>"
```

**Failures:**
- Non-zero exit for any reason other than auth: Report the exact output. STOP.
- No output or timeout: Run `pwsh -NoProfile -Command "pac env list"` to verify PAC can reach the environment, then retry once.

### Step 2: Present Results

Show the flow list to the user. The **Flow ID** (the `workflowId` / Power Automate resource GUID) is what goes into `--flow-id <guid>` when adding a flow with `/add-flow`.

**If the needed flow is missing:**

1. The flow must be **solution-aware** — only flows inside a solution appear in this list.
2. Direct the user to [Power Automate](https://make.powerautomate.com) → Solutions → open the relevant solution → add or create the flow there.
3. Re-run `/list-flows` after the flow has been added to a solution.

**If `--search` returns no results:** Broaden the search term or run without `--search` to see all available flows.
