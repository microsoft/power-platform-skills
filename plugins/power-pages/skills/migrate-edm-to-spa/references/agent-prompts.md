# Agent Task Prompts

Reusable `Task` tool prompts for the agents invoked by the migration skills. The two long-lived subagents are:

| Agent | Invoked by | Why it's a subagent |
|-------|------------|---------------------|
| `migration-static-analyzer` | `migrate-edm-to-spa-analyze` Phase 3 | CPU-bound work on the PAC export; no user interaction needed |
| `migration-validator` | `migrate-edm-to-spa-implement` Phase 8.4 | Independent of the migration agent — produces the completion verdict from primary evidence |

Runtime discovery was previously delegated to a `migration-runtime-discoverer` subagent. That delegation was reverted because subagents cannot use `AskUserQuestion`, which the multi-session login flow needs. The analyze SKILL's Phase 4 now drives Playwright directly in the main agent — see `runtime-discovery-procedure.md` for the per-session crawl details.

## Contents

- [Static analyzer prompt](#static-analyzer-prompt) — used by analyze Phase 3.2
- [Validator prompt](#validator-prompt) — used by implement Phase 8.4

---

## Static analyzer prompt

Used in `migrate-edm-to-spa-analyze` Phase 3.2. The static analyzer inventories a PAC EDM export, classifies every form against the Form Conversion Standards, captures binary assets, and writes the canonical static-analysis artifacts. It runs in parallel with the main agent's Phase 4 Playwright crawl.

**Required substitutions:**

- `<EDM_SOURCE_ROOT>` — absolute path to the PAC export
- `<TARGET_PROJECT_ROOT>` — absolute path where artifacts are written
- `<TARGET_FRAMEWORK>` — `react`, `vue`, `angular`, or `astro`
- `<LIVE_SITE_URL>` — absolute URL or the literal `'none'`

**Prompt template:**

> "You are the `migration-static-analyzer` agent. Follow the agent definition at `${CLAUDE_PLUGIN_ROOT}/agents/migration-static-analyzer.md`.
>
> Inputs:
>
> - `EDM_SOURCE_ROOT` = `<EDM_SOURCE_ROOT>`
> - `TARGET_PROJECT_ROOT` = `<TARGET_PROJECT_ROOT>`
> - `TARGET_FRAMEWORK` = `<TARGET_FRAMEWORK>`
> - `LIVE_SITE_URL` = `<LIVE_SITE_URL>`
>
> Inventory the PAC export, classify every form against the Form Conversion Standards in `references/edm-to-spa-patterns.md` (do not default contact/inquiry/feedback/profile/registration/support/newsletter forms to `manual-gap`), capture every referenced web-file binary in the assets inventory, and write the four required artifacts under `<TARGET_PROJECT_ROOT>/migration-artifacts/`: `edm-source-inventory.json`, `static-analysis.json`, `forms-inventory.json`, `static-analysis-summary.md`.
>
> Return a short summary naming the highest-risk patterns, the number of forms classified per pattern, and any artifact you could not classify confidently."

---

## Validator prompt

Used in `migrate-edm-to-spa-implement` Phase 8.4. The validator is independent of the migration agent — it reads the checklist (built in analyze Phase 5) and the manifest (built in implement Phase 7.3), walks every entry against the SPA filesystem and the running dev server / live site, and produces the completion verdict.

**Required substitutions:**

- `<TARGET_PROJECT_ROOT>`
- `<DEV_SERVER_URL>` — from implement Phase 8.3, or `'none'` if not running
- `<LIVE_SITE_URL>` — value of `migration-completion-status.json#/activation/liveUrl` from implement Phase 7.2.d, or `'none'` if activation was user-deferred or failed

**Prompt template:**

> "You are the `migration-validator` agent. Follow the instructions in the agent definition file at `${CLAUDE_PLUGIN_ROOT}/agents/migration-validator.md`.
>
> Inputs:
>
> - `TARGET_PROJECT_ROOT` = `<TARGET_PROJECT_ROOT>`
> - `CHECKLIST_PATH` = `<TARGET_PROJECT_ROOT>/migration-artifacts/migration-verification-checklist.json`
> - `SKILL_MANIFEST_PATH` = `<TARGET_PROJECT_ROOT>/migration-artifacts/required-skill-invocations.json`
> - `POWERPAGES_SITE_PATH` = `<TARGET_PROJECT_ROOT>/.powerpages-site/`
> - `DEV_SERVER_URL` = `<DEV_SERVER_URL>`
> - `LIVE_SITE_URL` = `<LIVE_SITE_URL>`
> - `INTERACTIONS_MODE` = `read-only` (the validator never submits forms)
>
> The validator must drive its live-site checks against `LIVE_SITE_URL` when one is provided. When `LIVE_SITE_URL` is `none`, mark every live-site check as `deferred` (not `pass`, not `fail`) and surface the reason as `activation deferred or failed in Phase 7.2.d`.
>
> Walk every entry in the checklist, run the synthetic gate-* checks documented in your workflow — both the **structural** gates (`skill-manifest`, `skill-evidence`, `mandatory-routes`, `auth-wiring`, `profile-route`, `copilot-embed`, `stock-drift`, `no-scaffold-leak`, `no-planning-metadata`, `no-secret-leak`) and the **behavioural** gates (`route-reachability`, `signin-click-redirect`, `form-submission-shape`). The behavioural gates require a running site (`DEV_SERVER_URL` or `LIVE_SITE_URL`) — when neither is available, mark them `deferred`, not `pass`. Write all three artifacts under `<TARGET_PROJECT_ROOT>/migration-artifacts/`:
>
> - `migration-validation-report.json`
> - `migration-validation-report.md`
> - `migration-completion-status.json`
>
> Return the verdict (`Complete` / `Partial` / `Blocked`), the per-category counts, and the top blockers or deferred reasons. Do not modify the SPA, the `.powerpages-site/` folder, or any file outside `migration-artifacts/`."
