---
name: route-environments
description: Manage environment resolution — check which environment you create flows in by default, list available environments, and set your working environment. Use when the user asks about environments, their default environment, where to create flows, or switching environments.
user-invocable: true
argument-hint: "[list|check|set]"
allowed-tools: Bash, Read, Write, Glob, Grep, AskUserQuestion, mcp__flowagent__list_environments, mcp__flowagent__set_current_env, mcp__flowagent__get_current_env, mcp__flowagent__resolve_environment
model: opus
---

# Environment Resolution

You are helping the user understand and manage which Power Automate environment
they work in — where their flows are created, where they should build new ones,
and how to switch between environments.

> Uses the **FlowAgent MCP tools** (`resolve_environment`, `list_environments`,
> `set_current_env`, `get_current_env`).

## Step 1: Understand what the user needs

- **"Which environment am I in?"** → call `get_current_env` or `resolve_environment`
- **"Where should I create flows?"** → help them pick the right environment
- **"What environments do I have?"** → call `list_environments`
- **"Switch my environment"** → call `set_current_env`

## Step 2: List and explain environments

Call `list_environments` and present a clear summary:

| Environment | Type | Location | Notes |
|-------------|------|----------|-------|
| ... | Default / Developer / Sandbox / Production | ... | ... |

Help the user identify:
- **Default environment** — shared, not recommended for production flows
- **Developer environments** — personal, ideal for building and testing
- **Production/Sandbox** — team environments for deployed flows

## Step 3: Set the working environment

If the user wants to create flows in a specific environment, call
`set_current_env` with that environment ID. This pins all subsequent
FlowAgent operations to that environment (no need to pass `--env` each time).

**Recommendation for new users**: If they have a Developer environment, suggest
using that. If not, suggest they ask their admin to provision one, or use the
default environment for simple personal automations.

## Guidance

- `resolve_environment` shows how the environment resolves (routing → poll → fallback)
- `set_current_env` changes the session default — it does NOT change tenant-level routing
- Tenant-level environment routing (which env new makers land in by default) is
  configured at the admin level in `admin.powerplatform.microsoft.com` — direct
  admins there if they ask about changing org-wide routing
- For maker-facing questions: "When you open make.powerautomate.com, your default
  environment determines where new flows are created"

## Decision Tree

```
User asks about environments?
├── "Which environment am I in?" → get_current_env / resolve_environment
├── "What environments exist?" → list_environments with summary table
├── "Where should I build?" → Recommend Developer env; set_current_env
├── "Switch to X environment" → set_current_env
├── "How do I create a new environment?" → Direct to PPAC admin center
└── "What is environment routing?" → Explain: determines default for new makers
```
