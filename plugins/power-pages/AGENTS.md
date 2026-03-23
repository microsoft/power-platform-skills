# Power Pages Plugin

A plugin for creating, deploying, and managing Power Pages code sites. Supports static SPA frameworks (React, Vue, Angular, Astro) with Dataverse integration, Web API access, and browser-based previews via Playwright.

**Server-rendered frameworks (Next.js, Nuxt, Remix, SvelteKit) are NOT supported.**

Read `PLUGIN_DEVELOPMENT_GUIDE.md` for UX and reliability standards when creating new skills and agents.

## Key Conventions

- **DRY** — Never duplicate logic. Shared scripts live in `scripts/` (e.g., `generate-uuid.js`, `scripts/lib/validation-helpers.js`). Shared reference docs live in `references/`. Always check for existing helpers before writing new code.
- **Validation scripts** must import from `scripts/lib/validation-helpers.js` for boilerplate, path finders, auth helpers, and constants.
- **UUID generation** must use the shared `scripts/generate-uuid.js` — never copy it into skill-specific directories.
- **Power Pages config loading** must reuse `scripts/lib/powerpages-config.js` anywhere a script reads `.powerpages-site` table-permission or site-setting YAML. Keep that module focused on loading/parsing code-site config only; put validation or business rules in separate validator modules.
- **Script changes require tests** — Whenever you add a new script or modify an existing script, add or update `node:test` coverage under `scripts/tests/`. Prefer one `*.test.js` file per script/module being tested, and keep the PowerShell test command passing: `$files = Get-ChildItem .\plugins\power-pages\scripts\tests\*.test.js | ForEach-Object { $_.FullName }` followed by `node --test $files`. Validator changes are not an exception; they must always ship with test coverage.
- **Dataverse-backed validation** must stay opt-in for local runs only. Do not require live Dataverse connectivity in CI workflows or default test runs; gate it behind explicit local flags such as `--validate-dataverse-relationships`.
- **Reference docs** shared across skills live in `references/` — reference via `${CLAUDE_PLUGIN_ROOT}/references/` paths, don't duplicate.
- **Templates** use `__PLACEHOLDER__` tokens (e.g., `__SITE_NAME__`) replaced during scaffolding. The `gitignore` file is stored without the dot prefix and renamed to `.gitignore` during scaffolding.
- **Hooks** are defined centrally in `hooks/hooks.json`, using `PostToolUse` with matcher `Skill` so validation runs when a tracked Power Pages skill completes.

## Skill Development Conventions

All skills follow these patterns. See existing skills for examples.

### Phase-Wise Workflow

Every skill is a sequence of phases (typically 5-8): Prerequisites, Discover/Gather, Plan/Review, Implement, **Verify** (mandatory standalone phase), Deploy/Summarize. Never skip or reorder phases.

### Task Tracking

Create all tasks upfront at Phase 1 start using `TaskCreate` (one per phase). Each task needs `subject` (imperative), `activeForm` (present continuous for spinner), and `description`. Mark `in_progress` when starting, `completed` when done. Include a progress tracking table at the end of the SKILL.md.

### SKILL.md Frontmatter

```yaml
---
name: <skill-name>
description: >-
  <when to use this skill>
user-invocable: true
argument-hint: <optional>
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, Task, TaskCreate, TaskUpdate, TaskList, AskUserQuestion
model: opus
---
```

Note: `allowed-tools` must be a comma-separated list, not JSON array or YAML list syntax.

### Key Patterns

- **User confirmation** — Pause with `AskUserQuestion` after gathering requirements, after presenting a plan, after implementation, and before deployment.
- **Deployment prompt** — Skills that modify site artifacts should end by asking "Ready to deploy?" and invoke `/deploy-site` if yes.
- **Lifecycle hooks** — If a skill needs command validation or checklist enforcement, update `hooks/hooks.json` and `scripts/lib/powerpages-hook-utils.js`. Do not define hook registration in individual `SKILL.md` files.
- **Graceful failure** — Track API call results, never auto-rollback, report failures clearly, continue with remaining items.
- **Token refresh** — Refresh Azure CLI token every ~20 records / 3-4 tables / ~60 seconds.
- **Git commits** — Commit after every significant milestone (each page/component, design foundations, phase completion).
- **Agent spawning** — Process sequentially (not parallel), wait for completion, present output for approval.
- **Skill tracking** — Every skill must record usage in its final phase via `> Reference: ${CLAUDE_PLUGIN_ROOT}/references/skill-tracking-reference.md` (pointer pattern, not hardcoded command). When adding a new skill, also add its entry to the skill name mapping table in `references/skill-tracking-reference.md`.
- **Dataverse API calls** — Use deterministic Node.js scripts (in the skill's `scripts/` directory) for Dataverse API queries. Scripts should import `getAuthToken` and `makeRequest` from `scripts/lib/validation-helpers.js`. Never use inline PowerShell `Invoke-RestMethod` for API calls — scripts are more reliable, testable, and cross-platform.

## Maintaining This File

Update when plugin structure or conventions change or you learn something which can be useful for new skills or agents.

Keep this file concise — detailed docs belong in `PLUGIN_DEVELOPMENT_GUIDE.md` or individual SKILL.md / agent files.
