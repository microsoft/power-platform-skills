# Host Compatibility

The skill uses standard Agent Skills frontmatter and relative resources. Keep host-specific features optional so the workflow remains usable in GitHub Copilot, VS Code GitHub Copilot integration, and Claude Code.

## Discovery Locations

Use one location appropriate to the host:

| Host | Project location |
|---|---|
| VS Code GitHub Copilot | copy every folder under `skills/` to `.github/skills/` or `.agents/skills/` |
| GitHub Copilot CLI | install the plugin, or copy every folder under `skills/` to a supported skills root |
| Claude Code | install the plugin, or copy every folder under `skills/` to `.claude/skills/` |

The orchestrator delegates to sibling skills, so copying only `create-mobile-app` is incomplete. The distributable package includes `.plugin/plugin.json` and `.claude-plugin/plugin.json`. Do not maintain divergent copies of skill bodies for different hosts.

## Capability Fallbacks

- Structured question tool available: batch related questions and provide recommended defaults.
- No structured question tool: ask the same questions in concise numbered prose.
- Explicit nested skill tool available: invoke the stage by its exact frontmatter `name` and parse its first-line return status.
- Tool accepts only agent/subagent identifiers: it cannot invoke a skill. Do not use a UI command or display label as an agent identifier; read the sibling stage's `SKILL.md` and execute it inline in the current agent.
- No nested skill tool: use the same inline fallback without retrying delegation; preserve the workspace, original request, handoff, and resume context.
- Microsoft Learn tool available: use it for uncertain Power Apps, Dataverse, Entra, or connector behavior.
- Microsoft Learn unavailable: use official `learn.microsoft.com` documentation through available web tools; stop rather than inventing mutation syntax.

## Tool Naming

Skill instructions describe capabilities, not vendor-specific tool names. Use the host's native equivalents for reading, editing, asking questions, running commands, and tracking tasks. Respect the host's confirmation and sandbox policies.

## Background Installation

- After cloning, run `npm install > /dev/null 2>&1 &` in the target workspace only to restore the template-declared dependency set. Do not add or upgrade packages during this baseline install.
- Continue Stages 1-2 without dependency-dependent commands.
- Stage 3 runs `npm run type-check` before editing and blocks on failure.

## Portability Rules

- Use paths relative to `SKILL.md` for references and assets.
- Keep YAML frontmatter to common fields: `name`, `description`, `argument-hint`, and `user-invocable`.
- Do not require a specific model.
- Do not require nested agents for correctness.
- Do not encode absolute paths to the source repository or template.
- Keep shell commands cross-platform where practical; detect the current shell before using POSIX-only scripts.