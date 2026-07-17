---
name: debug-flow
description: Debug a failed Power Automate flow run. Use when a flow failed, has errors, or the user wants to troubleshoot a run.
user-invocable: true
argument-hint: "[flow-id] [run-id]"
allowed-tools: Bash, Read, Write, Glob, Grep, AskUserQuestion, mcp__flowagent__list_environments, mcp__flowagent__set_current_env, mcp__flowagent__get_current_env, mcp__flowagent__resolve_environment, mcp__flowagent__list_flows, mcp__flowagent__get_flow, mcp__flowagent__create_flow, mcp__flowagent__update_flow, mcp__flowagent__edit_flow, mcp__flowagent__copy_flow, mcp__flowagent__publish_flow, mcp__flowagent__disable_flow, mcp__flowagent__delete_flow, mcp__flowagent__run_flow, mcp__flowagent__get_run_history, mcp__flowagent__get_run_details, mcp__flowagent__get_run_actions, mcp__flowagent__get_run_action_repetitions, mcp__flowagent__cancel_run, mcp__flowagent__cancel_all_runs, mcp__flowagent__resubmit_run, mcp__flowagent__diagnose_run, mcp__flowagent__list_connections, mcp__flowagent__list_connectors, mcp__flowagent__get_connector, mcp__flowagent__search_operations, mcp__flowagent__get_operation_details, mcp__flowagent__pick_or_create_connection, mcp__flowagent__resolve_refs, mcp__flowagent__resolve_params, mcp__flowagent__scaffold_flow, mcp__flowagent__list_templates, mcp__flowagent__validate_flow, mcp__flowagent__preflight_flow, mcp__flowagent__smoke_test, mcp__flowagent__get_expression_help, mcp__flowagent__list_desktop_flows, mcp__flowagent__list_machine_groups, mcp__flowagent__run_desktop_flow, mcp__flowagent__get_flow_context, mcp__flowagent__set_current_flow, mcp__flowagent__clear_current_flow, mcp__flowagent__invoke_operation, mcp__flowagent__get_past_trigger_inputs, mcp__flowagent__test_connection, mcp__flowagent__fix_connection, mcp__flowagent__delete_connection, mcp__flowagent__preview_update, mcp__flowagent__get_backup, mcp__flowagent__list_backups, mcp__flowagent__restore_backup, mcp__flowagent__list_trigger_emulators
model: opus
---

# Debug a Failed Flow Run

You are helping the user debug a failed Power Automate flow run.

## Tools

This skill uses the **FlowAgent MCP tools**. Clients surface them with a
client-specific prefix — `mcp__flowagent__<tool>` (Claude Code) or
`flowagent-<tool>` (Copilot CLI) — so they're referred to by bare name below.
If MCP tools aren't available, run `/setup` to wire the FlowAgent MCP server.

| Tool | Purpose |
|------|---------|
| `list_flows` | Find flows by name (use `name` param for search) |
| `get_run_history` | Get recent runs for a flow |
| `diagnose_run` | One-shot: classify failed actions with remediations |
| `get_run_details` | Get details for a specific run |
| `get_run_actions` | Get action-level execution trace |
| `get_run_action_repetitions` | Iteration-level detail for a loop (which iteration failed — pass an action **inside** the loop) |
| `get_flow` | Get flow definition for context |
| `get_operation_details` | Confirm the correct action type / parameters |
| `edit_flow` | Apply a surgical fix to one action/parameter |
| `update_flow` | Replace the whole definition (large rewrites) |
| `run_flow` | Re-run after fix (use `wait: true` to see result) |
| `resubmit_run` / `cancel_run` | Resubmit a fixed run / cancel a stuck one |

## Steps

1. **Identify the flow and run**
   - Parse `$ARGUMENTS` for flow ID and optional run ID.
   - If no flow ID, call `list_flows` with `name` param to search. Ask user to pick if ambiguous.
   - If no run ID, call `get_run_history` and find the most recent failed run.
   - Present recent runs in a table: Run ID | Status | Start Time | Error

2. **Fast triage with `diagnose_run`**
   - Call `diagnose_run` for the run — it returns the failed/timed-out actions already classified with a remediation each. Use this as the starting point.
   - For deeper analysis, also fetch (in parallel): `get_run_actions` (full trace) and `get_flow` (definition context). For a failed loop, call `get_run_action_repetitions` on an action **inside** the loop to find the failing iteration.

3. **Analyze failures**
   - Identify actions with status != "Succeeded"
   - Trace the `runAfter` dependency chain to separate root cause from cascading failures:
     - **Root cause**: action whose dependencies all Succeeded but it failed
     - **Cascading**: actions skipped because a dependency failed
   - Report root cause actions with: name, type, error code, error message

4. **Root cause classification**
   - **Connection errors** (`AuthorizationFailed`, `ConnectionNotFound`, `InvokerConnectionOverrideFailed`): Suggest re-auth or fix connection source to Embedded
   - **Expression errors** (`ExpressionEvaluationFailed`, `InvalidTemplate`): Show the expression, explain what's wrong, suggest fix
   - **API/External errors** (401/403/404/429/500+): Explain the HTTP error, check connector status
   - **Parameter errors** (`WorkflowOperationParametersRuntimeMissingValue`): Missing/empty required parameter. Add null guard: `@if(empty(...), 'default', ...)`
   - **Timeout** (`ActionTimedOut`): Suggest retry policy or splitting the operation
   - **Type mismatch** (`InvalidOpenApiConnectionOperationType`): Wrong action type. Call `get_operation_details` to find correct type.

5. **Suggest fix**
   - Provide a specific fix with code/expression changes.
   - If the fix is a definition change, offer to apply it with `edit_flow` (surgical, one action/parameter) — fall back to `update_flow` only for large rewrites.

6. **Re-test**
   - Offer to call `run_flow` with `wait: true` to verify the fix works (or `resubmit_run` to retry the original run with its trigger inputs).
   - Report the result: Succeeded/Failed with action details.

## Output Format

### Diagnosis Summary
- **Flow**: [name] ([ID])
- **Run**: [run ID] | [start time] | Status: **[status]**

### Failed Actions
| # | Action | Status | Error Code | Error Message |
|---|--------|--------|------------|---------------|

### Root Cause
[Classification]: [Explanation]

### Fix
[Step-by-step fix with code]
