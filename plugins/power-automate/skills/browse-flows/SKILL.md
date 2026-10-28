---
name: browse-flows
description: Browse Power Automate environments and flows interactively. Use when the user wants to browse, list, or explore their flows and environments.
user-invocable: true
argument-hint: "[environment-id]"
allowed-tools: Bash, Read, Glob, Grep, AskUserQuestion, mcp__flowagent__list_environments, mcp__flowagent__set_current_env, mcp__flowagent__get_current_env, mcp__flowagent__resolve_environment, mcp__flowagent__list_flows, mcp__flowagent__get_flow, mcp__flowagent__get_run_history, mcp__flowagent__get_run_details, mcp__flowagent__get_run_actions, mcp__flowagent__list_connections, mcp__flowagent__list_connectors, mcp__flowagent__get_connector, mcp__flowagent__get_flow_context, mcp__flowagent__set_current_flow, mcp__flowagent__clear_current_flow, mcp__flowagent__whoami, mcp__flowagent__doctor, mcp__flowagent__reconnect, mcp__flowagent__list_accounts, mcp__flowagent__switch_account
model: opus
---

# Browse Environments and Flows

Interactive skill for discovering Power Automate environments and flows.

## Tools

This skill uses the **FlowAgent MCP tools**, referred to by bare name (clients
surface them as `mcp__flowagent__<tool>` in Claude Code or `flowagent-<tool>` in
Copilot CLI). If no MCP tools are present, the plugin is not wired up — run the `setup` skill.

## Steps

1. **Resolve environment**:
   - If `$ARGUMENTS` contains an environment ID, use it.
   - Otherwise call `list_environments` (use `query` to filter if user mentioned a name).
   - Reuse the returned environment metadata while browsing. It is cached in memory for up to 60 seconds; use `fresh: true` when the user explicitly needs current discovery or permissions.
   - If multiple environments, use AskUserQuestion to let user pick.

2. **List flows**: Call `list_flows` on the selected environment. Use `name` param if user is looking for something specific.
   - A partial response contains `flows`, `complete: false` and `nextCursor`. Continue with `cursor: nextCursor`, keeping `env`, `top`, `name` and `filter` unchanged.
   - Follow cursors before reporting a complete count or claiming a search found nothing. If stopping early, label the results partial.
   - Continuations may reuse one metadata page for up to 60 seconds, not a fresh inventory. Omit the cursor for a fresh search. If the service page changed, restart without a cursor and discard that search's earlier partial counts.

3. **Present results** in a table:

   | # | Name | State | Trigger | Actions | Last Modified |
   |---|------|-------|---------|---------|---------------|

4. **Offer next steps** via AskUserQuestion:
   - View flow details (`get_flow`)
   - Check run history (`get_run_history`)
   - Debug a failed flow (use `/debug-flow`)
   - Create a new flow (use `/create-flow`)
