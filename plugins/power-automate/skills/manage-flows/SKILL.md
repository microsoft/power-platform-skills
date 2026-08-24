---
name: manage-flows
description: Manage flow lifecycle - publish, test, batch operations, inventory reports.
user-invocable: true
argument-hint: "<operation> [flow-ids...]"
context: fork
allowed-tools: Bash, Read, Write, Glob, Grep, mcp__flowagent__*
model: opus
---

# Flow Lifecycle Manager

Autonomous agent for flow lifecycle operations: publish-and-test, batch operations, inventory reports.

## Tools

This skill uses the **FlowAgent MCP tools**, referred to by bare name (clients
surface them as `mcp__flowagent__<tool>` in Claude Code or `flowagent-<tool>` in
Copilot CLI). Fall back to `@microsoft/power-automate-mcp` shell commands only for CLI-only
operations (connection lifecycle, sharing, solutions/admin) or when no MCP tools
are present.

## Capabilities

### 1. Publish-and-Test Cycle
1. Call `publish_flow` to enable
2. Call `run_flow` with `wait: true` and `timeout: 30` to trigger and wait for completion
3. Report: pass/fail, duration, action statuses

### 2. Batch Operations
For multiple flows (IDs from `$ARGUMENTS` or from `list_flows`):
- **Batch disable**: Call `disable_flow` per flow
- **Batch delete**: Call `delete_flow` per flow (confirm first)
- **Batch publish**: Call `publish_flow` per flow
Report per-item success/failure.

### 3. Inventory Report
1. Call `list_environments` to get environments
2. Call `list_flows` on each (or specified) environment
3. Produce summary: flow counts by state, trigger types, recent modifications

### 4. Health Check
For each flow in an environment:
1. Call `get_run_history` with `top: 5`
2. Count Succeeded vs Failed runs
3. Flag flows with >50% failure rate
Report: flow name, success rate, last run status, last failure error.

### 5. Incident Response (runaway runs)
When a flow is misfiring with many queued runs:
1. Call `cancel_all_runs` to bulk-cancel every Running/Waiting run (uses the
   Dataverse bulk action for solution & modern non-solution flows, per-run
   fallback otherwise). Pass `turnOff: true` to also disable the flow while the
   root cause is fixed.
2. After fixing, `resubmit_run` the affected runs (note: only self-invoked runs
   are resubmittable per PA policy).
