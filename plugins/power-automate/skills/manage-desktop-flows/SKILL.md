---
name: manage-desktop-flows
description: Manage and run Power Automate Desktop (RPA) flows and machine groups. Use when the user asks about desktop flows, RPA, or machine groups.
user-invocable: true
argument-hint: "[environment-id]"
allowed-tools: Bash, Read, Glob, Grep, AskUserQuestion, mcp__flowagent__list_environments, mcp__flowagent__set_current_env, mcp__flowagent__get_current_env, mcp__flowagent__resolve_environment, mcp__flowagent__list_flows, mcp__flowagent__get_flow, mcp__flowagent__create_flow, mcp__flowagent__update_flow, mcp__flowagent__edit_flow, mcp__flowagent__copy_flow, mcp__flowagent__publish_flow, mcp__flowagent__disable_flow, mcp__flowagent__delete_flow, mcp__flowagent__run_flow, mcp__flowagent__get_run_history, mcp__flowagent__get_run_details, mcp__flowagent__get_run_actions, mcp__flowagent__get_run_action_repetitions, mcp__flowagent__cancel_run, mcp__flowagent__cancel_all_runs, mcp__flowagent__resubmit_run, mcp__flowagent__diagnose_run, mcp__flowagent__list_connections, mcp__flowagent__list_connectors, mcp__flowagent__get_connector, mcp__flowagent__search_operations, mcp__flowagent__get_operation_details, mcp__flowagent__pick_or_create_connection, mcp__flowagent__resolve_refs, mcp__flowagent__resolve_params, mcp__flowagent__scaffold_flow, mcp__flowagent__list_templates, mcp__flowagent__validate_flow, mcp__flowagent__preflight_flow, mcp__flowagent__smoke_test, mcp__flowagent__get_expression_help, mcp__flowagent__list_desktop_flows, mcp__flowagent__list_machine_groups, mcp__flowagent__run_desktop_flow, mcp__flowagent__get_flow_context, mcp__flowagent__set_current_flow, mcp__flowagent__clear_current_flow, mcp__flowagent__invoke_operation, mcp__flowagent__get_past_trigger_inputs, mcp__flowagent__test_connection, mcp__flowagent__fix_connection, mcp__flowagent__delete_connection, mcp__flowagent__preview_update, mcp__flowagent__get_backup, mcp__flowagent__list_backups, mcp__flowagent__restore_backup, mcp__flowagent__list_trigger_emulators
model: opus
---

# Desktop Flow Manager

Manage Power Automate Desktop (RPA) flows, machine groups, and run sessions.

## Tools

This skill uses the **FlowAgent MCP tools**, referred to by bare name (clients
surface them as `mcp__flowagent__<tool>` in Claude Code or `flowagent-<tool>` in
Copilot CLI). If MCP tools aren't available, run `/setup` to wire the FlowAgent
MCP server.

| Tool | Purpose |
|------|---------|
| `list_desktop_flows` | Browse RPA flows (filter by `name`) |
| `run_desktop_flow` | Trigger with optional `machineGroup`, `body`, `timeout` |
| `list_machine_groups` | Browse machine infrastructure |

## Operations

### List Desktop Flows
Call `list_desktop_flows`. Present in table: Name | Status | Created | Modified

### Run Desktop Flow
1. Call `list_desktop_flows` to find the flow (if name given, use `name` filter)
2. Optionally call `list_machine_groups` to target a specific group
3. Call `run_desktop_flow` with optional `machineGroup`, `body` (input data), `timeout`
4. Report: session status (Waiting/InProgress/Failed/Cancelled/Succeeded), outputs

### Machine Infrastructure
Call `list_machine_groups`. Present: Name | Type | Status | Machines
