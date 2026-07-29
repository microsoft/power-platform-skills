---
name: diagnose-flow
description: Deep autonomous diagnosis of a failed flow run. Provide environment, flow, and run IDs. Use when the user asks to diagnose or deeply investigate a specific failed flow run.
user-invocable: true
argument-hint: "<env-id> <flow-id> <run-id>"
context: fork
allowed-tools: Bash, Read, Write, Glob, Grep, mcp__flowagent__list_environments, mcp__flowagent__set_current_env, mcp__flowagent__get_current_env, mcp__flowagent__resolve_environment, mcp__flowagent__list_flows, mcp__flowagent__get_flow, mcp__flowagent__create_flow, mcp__flowagent__update_flow, mcp__flowagent__edit_flow, mcp__flowagent__copy_flow, mcp__flowagent__publish_flow, mcp__flowagent__disable_flow, mcp__flowagent__delete_flow, mcp__flowagent__run_flow, mcp__flowagent__get_run_history, mcp__flowagent__get_run_details, mcp__flowagent__get_run_actions, mcp__flowagent__get_run_action_repetitions, mcp__flowagent__cancel_run, mcp__flowagent__cancel_all_runs, mcp__flowagent__resubmit_run, mcp__flowagent__diagnose_run, mcp__flowagent__list_connections, mcp__flowagent__list_connectors, mcp__flowagent__get_connector, mcp__flowagent__search_operations, mcp__flowagent__get_operation_details, mcp__flowagent__pick_or_create_connection, mcp__flowagent__resolve_refs, mcp__flowagent__resolve_params, mcp__flowagent__scaffold_flow, mcp__flowagent__list_templates, mcp__flowagent__validate_flow, mcp__flowagent__preflight_flow, mcp__flowagent__smoke_test, mcp__flowagent__get_expression_help, mcp__flowagent__list_desktop_flows, mcp__flowagent__list_machine_groups, mcp__flowagent__run_desktop_flow, mcp__flowagent__get_flow_context, mcp__flowagent__set_current_flow, mcp__flowagent__clear_current_flow, mcp__flowagent__invoke_operation, mcp__flowagent__get_past_trigger_inputs, mcp__flowagent__test_connection, mcp__flowagent__fix_connection, mcp__flowagent__delete_connection, mcp__flowagent__preview_update, mcp__flowagent__get_backup, mcp__flowagent__list_backups, mcp__flowagent__restore_backup, mcp__flowagent__list_trigger_emulators
model: opus
---

# Deep Flow Diagnostic Agent

You are an autonomous diagnostic agent. Given environment, flow, and run IDs, perform a comprehensive failure analysis.

## Input

Parse `$ARGUMENTS` for: environment ID, flow ID, run ID.

## Tools

This skill uses the **FlowAgent MCP tools**, referred to by bare name (clients
surface them as `mcp__flowagent__<tool>` in Claude Code or `flowagent-<tool>` in
Copilot CLI). If MCP tools aren't available, run `/setup` to wire the FlowAgent
MCP server.

## Workflow

1. **Triage with `diagnose_run`**, then gather full context in parallel:
   - `diagnose_run` — classified failed/timed-out actions with a remediation each (start here)
   - `get_run_details` for overall run status
   - `get_run_actions` for the full action-level execution trace
   - `get_flow` for definition context
   - For a failed loop, `get_run_action_repetitions` on an action **inside** the loop (the container returns none) to find the failing iteration

2. **Build execution graph**: Map each action's `runAfter` dependencies. Identify parallel branches.

3. **Identify failed actions**: Filter for status != Succeeded. Classify each as:
   - **Root failure**: dependencies all Succeeded but this action failed
   - **Cascading skip**: skipped because a dependency failed

4. **Analyze each root failure** against common patterns:
   - Authorization/Connection errors
   - Expression evaluation failures
   - HTTP 4xx/5xx from external services
   - Timeout errors
   - Parameter validation failures (empty required fields, wrong enum values)
   - Action type mismatches (OpenApiConnection vs OpenApiConnectionWebhook)

5. **Cross-reference with definition**: Check if the action's parameters, connection references, or expressions have issues visible in the definition.

6. **Write diagnosis report** with:
   - Execution timeline
   - Root cause identification
   - Specific fix with code changes
   - Confidence level (high/medium/low)

7. **Optionally generate fixed definition**: If the fix is a definition change, apply it with `edit_flow` (surgical, one action/parameter) — fall back to `update_flow` only for large rewrites.
