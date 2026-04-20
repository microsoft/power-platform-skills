# Power Pages Plugin

A plugin for creating, deploying, and managing Power Pages code sites. Supports static SPA frameworks (React, Vue, Angular, Astro) with Dataverse integration, Web API access, and browser-based previews via Playwright.

**Server-rendered frameworks (Next.js, Nuxt, Remix, SvelteKit) are NOT supported.**

Read `PLUGIN_DEVELOPMENT_GUIDE.md` for UX and reliability standards when creating new skills and agents.

## Key Conventions

- **DRY** — Never duplicate logic. Shared scripts live in `scripts/` (e.g., `generate-uuid.js`, `scripts/lib/validation-helpers.js`, `scripts/lib/discover-site-components.js`). Shared reference docs live in `references/`. Always check for existing helpers before writing new code.
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

Note: `allowed-tools` must be a comma-separated list, not JSON array or YAML list syntax. Do not add `hooks` to skill frontmatter; Power Pages skills register lifecycle hooks centrally.

### Plugin Version Check

Every SKILL.md must include the following line immediately after the closing `---` of the frontmatter (before the `#` title):

```markdown
> **Plugin check**: Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/check-version.js"` — if it outputs a message, show it to the user before proceeding.
```

This runs a lightweight check comparing the local plugin version against `origin/main` and shows an update notice if a newer version is available.

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
- **ALM-aware by default** — Any skill that creates, modifies, or depends on Dataverse records that belong in a Power Pages site's solution (site components, env var definitions, web roles, site settings, server logic, cloud flow bindings, bot consumers, custom tables/columns, etc.) MUST ensure those records land in the user's solution when `.solution-manifest.json` exists. Concrete rules:
  - **Solution selection — strict resolution order.** When a skill or script needs "which solution?" for an `AddSolutionComponent` call, resolve in this order and stop at the first match:
    1. **Explicit `--solutionUniqueName` CLI arg** (or `solutionName=…` skill argument). Always wins. Used by advanced flows and CI.
    2. **`.solution-manifest.json` in the project root** — read `solution.uniqueName`. This is the default path for nearly every invocation.
    3. **No manifest AND no explicit arg**:
       - **Interactive skill**: query Dataverse for unmanaged solutions whose publisher prefix matches the site publisher, present them via `AskUserQuestion` alongside the option **"Run `/power-pages:setup-solution` first (recommended)"** and **"Leave in Default (not recommended)"**. Proceed only after explicit selection.
       - **Non-interactive script**: exit with a clear error — `--solutionUniqueName not provided and no .solution-manifest.json found. Run /power-pages:setup-solution first, or pass --solutionUniqueName.` Never silently fall back to `Default`.
    Skills must never auto-pick "the first solution that looks relevant" — auto-selection masks misconfigurations (wrong env, wrong branch, wrong project).
  - **Component-creation scripts** must accept a `--solutionUniqueName` argument and, when provided, add the created record to that solution via `AddSolutionComponent`. Test that `solutionUniqueName` flows through end to end.
  - **Skill workflows** must read `.solution-manifest.json` during prerequisite checks and pass the solution's `uniqueName` to any component-creation script they call. When no manifest is present, the skill should surface that gap to the user (per the resolution order above) rather than silently creating records in `Default`.
  - **Skills that can leave Dataverse artifacts uncovered** (e.g. `setup-auth` writing OAuth secrets as env vars) must end by prompting the user to run `/power-pages:setup-solution` in sync mode so the discovery pass picks up any newly-created records.
  - **New component types** added to Power Pages must be reflected in `scripts/lib/discover-site-components.js` (the single source of truth for site inventory) and, if applicable, in the `PPC_TYPE_LABELS` enum. Discovery should never silently skip a type.

## Common Review Pitfalls

These patterns have caused repeated PR review feedback. Check for them before submitting changes to skills, validators, or hooks.

- **Phase cross-references break silently** — When renumbering or reordering phases in a SKILL.md, also update: `references/` docs that mention phase numbers, the Key Decision Points section, and any other files that cross-reference this skill's phases. After any phase reorder, grep for the old phase number across the skill directory and its references.
- **Validators must match the exact constraint** — If the rule is "no exports at all", block all `module.exports`/`exports` — don't just check if exported names are in an allowlist. If the rule is "try/catch required", verify both `try` AND `catch` exist. Re-read the exact constraint from SKILL.md and test the boundary cases.
- **Hook scripts run on every Skill tool use** — The PostToolUse hook fires for all tracked skills, so unconditional `process.stderr.write` creates noise. Gate debug logging behind `process.env.DEBUG`. Only errors should go to stderr unconditionally.
- **Template placeholders in `<script>` blocks need special care** — `render-template.js` injects string values as-is (no encoding), which is safe for HTML text contexts but risky inside JavaScript. Avoid declaring JS variables with `"__PLACEHOLDER__"` in script blocks; prefer reading from the DOM or using `JSON.stringify` for JS contexts.
- **Guidance must be consistent within a skill** — If one section says "always use raw fetch", a framework-specific table in the same file must not recommend a different HTTP client without qualification. Reviewers will flag contradictions.

## Maintaining This File

Update when plugin structure or conventions change or you learn something which can be useful for new skills or agents.

Keep this file concise — detailed docs belong in `PLUGIN_DEVELOPMENT_GUIDE.md` or individual SKILL.md / agent files.
