# Power Pages Plugin

A plugin for creating, deploying, and managing Power Pages code sites. Supports static SPA frameworks (React, Vue, Angular, Astro) with Dataverse integration, Web API access, and browser-based previews via Playwright.

**Server-rendered frameworks (Next.js, Nuxt, Remix, SvelteKit) are NOT supported.**

Read `PLUGIN_DEVELOPMENT_GUIDE.md` for UX and reliability standards when creating new skills and agents.

For Codex, symlink or copy the relevant `skills/*` folder into `$CODEX_HOME/skills`. The legacy Claude packaging still exists, but Codex should treat each skill folder as the unit of reuse.

## Key Conventions

- **DRY** — Never duplicate logic. Shared scripts live in `scripts/` (e.g., `generate-uuid.js`, `scripts/lib/validation-helpers.js`). Shared reference docs live in `references/`. Always check for existing helpers before writing new code.
- **Validation scripts** must import from `scripts/lib/validation-helpers.js` for boilerplate, path finders, auth helpers, and constants.
- **UUID generation** must use the shared `scripts/generate-uuid.js` — never copy it into skill-specific directories.
- **Power Pages config loading** must reuse `scripts/lib/powerpages-config.js` anywhere a script reads `.powerpages-site` table-permission or site-setting YAML. Keep that module focused on loading/parsing code-site config only; put validation or business rules in separate validator modules.
- **Script changes require tests** — Whenever you add a new script or modify an existing script, add or update `node:test` coverage under `scripts/tests/`. Prefer one `*.test.js` file per script/module being tested, and keep the PowerShell test command passing: `$files = Get-ChildItem .\plugins\power-pages\scripts\tests\*.test.js | ForEach-Object { $_.FullName }` followed by `node --test $files`. Validator changes are not an exception; they must always ship with test coverage.
- **Dataverse-backed validation** must stay opt-in for local runs only. Do not require live Dataverse connectivity in CI workflows or default test runs; gate it behind explicit local flags such as `--validate-dataverse-relationships`.
- **Reference docs** shared across skills live in `references/` — prefer relative paths from the current skill (`../../references/...`) and don't duplicate.
- **Templates** use `__PLACEHOLDER__` tokens (e.g., `__SITE_NAME__`) replaced during scaffolding. The `gitignore` file is stored without the dot prefix and renamed to `.gitignore` during scaffolding.
- **Hooks** are legacy Claude packaging behavior. For Codex, run validation explicitly as part of the workflow instead of depending on hook registration.

## Skill Development Conventions

All skills follow these patterns. See existing skills for examples.

### Phase-Wise Workflow

Every skill is a sequence of phases (typically 5-8): Prerequisites, Discover/Gather, Plan/Review, Implement, **Verify** (mandatory standalone phase), Deploy/Summarize. Never skip or reorder phases.

### Task Tracking

Create and maintain a concise plan with `update_plan`. Include one step per major phase and move steps through `pending`, `in_progress`, and `completed`.

### SKILL.md Frontmatter

```yaml
---
name: <skill-name>
description: >-
  <when to use this skill>
---
```

### Plugin Version Check

Every SKILL.md must include the following line immediately after the closing `---` of the frontmatter (before the `#` title):

```markdown
> **Plugin check**: Run `node "../../scripts/check-version.js"` from the plugin root — if it outputs a message, show it to the user before proceeding.
```

This runs a lightweight check comparing the local plugin version against `origin/main` and shows an update notice if a newer version is available.

### Key Patterns

- **User confirmation** — Ask the user directly after gathering requirements, after presenting a plan, after implementation, and before deployment.
- **Deployment prompt** — Skills that modify site artifacts should end by asking whether the user wants to run the `deploy-site` workflow next.
- **Lifecycle hooks** — Do not rely on hook registration for Codex workflows; call the validation steps explicitly.
- **Graceful failure** — Track API call results, never auto-rollback, report failures clearly, continue with remaining items.
- **Token refresh** — Refresh Azure CLI token every ~20 records / 3-4 tables / ~60 seconds.
- **Git commits** — Commit after every significant milestone (each page/component, design foundations, phase completion).
- **Agent spawning** — Keep work in the main Codex agent unless the user explicitly asks for delegated parallel work.
- **Skill tracking** — Every skill must record usage in its final phase via `> Reference: ../../references/skill-tracking-reference.md` (pointer pattern, not hardcoded command). When adding a new skill, also add its entry to the skill name mapping table in `references/skill-tracking-reference.md`.
- **Dataverse API calls** — Use deterministic Node.js scripts (in the skill's `scripts/` directory) for Dataverse API queries. Scripts should import `getAuthToken` and `makeRequest` from `scripts/lib/validation-helpers.js`. Never use inline PowerShell `Invoke-RestMethod` for API calls — scripts are more reliable, testable, and cross-platform.

## Common Review Pitfalls

These patterns have caused repeated PR review feedback. Check for them before submitting changes to skills, validators, or hooks.

- **Phase cross-references break silently** — When renumbering or reordering phases in a SKILL.md, also update: `references/` docs that mention phase numbers, the Key Decision Points section, and any other files that cross-reference this skill's phases. After any phase reorder, grep for the old phase number across the skill directory and its references.
- **Validators must match the exact constraint** — If the rule is "no exports at all", block all `module.exports`/`exports` — don't just check if exported names are in an allowlist. If the rule is "try/catch required", verify both `try` AND `catch` exist. Re-read the exact constraint from SKILL.md and test the boundary cases.
- **Hook scripts run on every Skill tool use** — This only applies to the legacy Claude packaging. Gate debug logging behind `process.env.DEBUG`. Only errors should go to stderr unconditionally.
- **Template placeholders in `<script>` blocks need special care** — `render-template.js` injects string values as-is (no encoding), which is safe for HTML text contexts but risky inside JavaScript. Avoid declaring JS variables with `"__PLACEHOLDER__"` in script blocks; prefer reading from the DOM or using `JSON.stringify` for JS contexts.
- **Guidance must be consistent within a skill** — If one section says "always use raw fetch", a framework-specific table in the same file must not recommend a different HTTP client without qualification. Reviewers will flag contradictions.

## Maintaining This File

Update when plugin structure or conventions change or you learn something which can be useful for new skills or agents.

Keep this file concise — detailed docs belong in `PLUGIN_DEVELOPMENT_GUIDE.md` or individual SKILL.md / agent files.
