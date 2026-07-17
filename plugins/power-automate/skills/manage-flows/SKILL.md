---
name: manage-flows
description: Manage flow lifecycle - publish, test, batch operations, inventory reports. Use when the user asks to publish, test, batch manage, or get an inventory of flows.
user-invocable: true
argument-hint: "<operation> [flow-ids...]"
context: fork
allowed-tools: Bash, Read, Write, Glob, Grep, mcp__flowagent__list_environments, mcp__flowagent__set_current_env, mcp__flowagent__get_current_env, mcp__flowagent__resolve_environment, mcp__flowagent__list_flows, mcp__flowagent__get_flow, mcp__flowagent__create_flow, mcp__flowagent__update_flow, mcp__flowagent__edit_flow, mcp__flowagent__copy_flow, mcp__flowagent__publish_flow, mcp__flowagent__disable_flow, mcp__flowagent__delete_flow, mcp__flowagent__run_flow, mcp__flowagent__get_run_history, mcp__flowagent__get_run_details, mcp__flowagent__get_run_actions, mcp__flowagent__get_run_action_repetitions, mcp__flowagent__cancel_run, mcp__flowagent__cancel_all_runs, mcp__flowagent__resubmit_run, mcp__flowagent__diagnose_run, mcp__flowagent__list_connections, mcp__flowagent__list_connectors, mcp__flowagent__get_connector, mcp__flowagent__search_operations, mcp__flowagent__get_operation_details, mcp__flowagent__pick_or_create_connection, mcp__flowagent__resolve_refs, mcp__flowagent__resolve_params, mcp__flowagent__scaffold_flow, mcp__flowagent__list_templates, mcp__flowagent__validate_flow, mcp__flowagent__preflight_flow, mcp__flowagent__smoke_test, mcp__flowagent__get_expression_help, mcp__flowagent__list_desktop_flows, mcp__flowagent__list_machine_groups, mcp__flowagent__run_desktop_flow, mcp__flowagent__get_flow_context, mcp__flowagent__set_current_flow, mcp__flowagent__clear_current_flow, mcp__flowagent__invoke_operation, mcp__flowagent__get_past_trigger_inputs, mcp__flowagent__test_connection, mcp__flowagent__fix_connection, mcp__flowagent__delete_connection, mcp__flowagent__preview_update, mcp__flowagent__get_backup, mcp__flowagent__list_backups, mcp__flowagent__restore_backup, mcp__flowagent__list_trigger_emulators
model: opus
---

# Flow Lifecycle Manager

Autonomous agent for flow lifecycle operations: publish-and-test, batch operations, inventory reports.

## Tools

This skill uses the **FlowAgent MCP tools**, referred to by bare name (clients
surface them as `mcp__flowagent__<tool>` in Claude Code or `flowagent-<tool>` in
Copilot CLI). If MCP tools aren't available, run `/setup` to wire the FlowAgent
MCP server.

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
