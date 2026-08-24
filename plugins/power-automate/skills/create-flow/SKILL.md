---
name: create-flow
description: Guided flow creation wizard. Use when the user wants to create a new flow interactively.
user-invocable: true
argument-hint: "[description]"
allowed-tools: Bash, Read, Write, Glob, Grep, AskUserQuestion, mcp__flowagent__*
model: opus
---

# Guided Flow Creation Wizard

Walk the user through creating a Power Automate flow step by step.

## Tools

This skill uses the **FlowAgent MCP tools**. Clients surface them with a
client-specific prefix — `mcp__flowagent__<tool>` (Claude Code) or
`flowagent-<tool>` (Copilot CLI) — so they're referred to by bare name below
(e.g. `create_flow`). Fall back to `@microsoft/power-automate-mcp` shell commands only for
CLI-only operations (connection lifecycle, sharing, solutions/admin) or when no
MCP tools are present.

## Steps

1. **Gather requirements**: Ask what the flow should do. Identify triggers, actions, connectors.

2. **Select environment**: Call `list_environments` (use `query` to filter). Let user pick or auto-select.

3. **Check for templates**: Call `list_templates`. If a template matches (approval, digest, webhook, etc.), offer to use `scaffold_flow` as a starting point.

4. **Discover connectors**: For each connector, call `get_connector` with `query` to find the operation, then `get_operation_details` for exact parameters. **Never guess parameter names or types.**

5. **Verify connections**: Call `list_connections` filtered by each connector. Confirm Connected status.

6. **Resolve dynamic values**: For params with `dynamicValues`/`dynamicTree` annotations, call `invoke_operation` to get actual values (Teams channels, SharePoint sites, etc.).

7. **Review with user**: Present the flow design. Use AskUserQuestion to confirm trigger, actions, and connections before creating.

8. **Generate definition**: Build following all rules:
   - Always declare `$authentication` (SecureObject) and `$connections` (Object) parameters
   - Use correct action type: `OpenApiConnection` or `OpenApiConnectionWebhook` (from `get_operation_details`)
   - Do NOT include `authentication` in action inputs
   - Use `Embedded` source in connection references
   - HTTP Request triggers require Premium; prefer `Button` kind

9. **Validate**: Call `validate_flow` (and optionally `preflight_flow`) to pre-check. For expressions, look up syntax with `get_expression_help`.

10. **Create**: Call `create_flow` in Stopped state. Report ID and name.

11. **Optionally publish**: Ask if user wants to enable. If yes, call `publish_flow`. For later one-off tweaks, use `edit_flow` (surgical) rather than resending the whole definition.
