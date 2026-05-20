---
name: migrate-traditional-site-to-spa-implement
description: >-
  Implements an approved EDM-to-SPA migration plan. Phases 7-9 of the migration workflow: scaffold
  the SPA with `/create-site`, deploy to hydrate `.powerpages-site/`, activate the site for live-URL
  verification, run the required Power Pages skills (`/integrate-webapi`, `/create-webroles`,
  `/setup-auth`, `/audit-permissions`, `/add-server-logic`), translate EDM metadata, implement
  routes/components/services, validate via `migration-validator`, and hand off. Reads the
  artifacts produced by `migrate-traditional-site-to-spa-analyze` — requires `analyze-complete.json` to exist
  before starting. Invoked by `migrate-traditional-site-to-spa` (the meta skill) or standalone when the user
  already has an approved plan. Intended for development environments only — this skill deploys,
  activates a `*.powerappsportals.com` URL bound to the tenant (the site stays private until
  `websiteaccess.yml` / table permissions / web roles allow anonymous access), and writes table
  permissions / web roles / site settings / server logic into the target Dataverse tenant.
user-invocable: true
argument-hint: "<target-project-root-or-blank>"
allowed-tools: Read, Write, Edit, Bash, Grep, Glob, AskUserQuestion, Task, TaskCreate, TaskUpdate, TaskList, Skill, mcp__plugin_power-pages_playwright__browser_navigate, mcp__plugin_power-pages_playwright__browser_snapshot, mcp__plugin_power-pages_playwright__browser_click, mcp__plugin_power-pages_playwright__browser_close, mcp__plugin_power-pages_playwright__browser_network_requests, mcp__plugin_power-pages_playwright__browser_console_messages, mcp__plugin_power-pages_playwright__browser_wait_for, mcp__plugin_power-pages_playwright__browser_resize, mcp__plugin_power-pages_playwright__browser_evaluate
model: opus
---

> **Plugin check**: Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/check-version.js"` — if it outputs a message, show it to the user before proceeding.

# Implement EDM-to-SPA Migration

> ## 🎯 Recommended run mode
>
> This skill drives ~30 discrete sub-steps from scaffold to handoff (see Phase 0.2's task list). Past runs have skipped sub-steps — activation, validator URL, inline `/test-site` — when the agent self-declared "done" before the full workflow finished. Run this skill inside a goal-tracking mode so the agent cannot quit early:
>
> - **Claude Code or Codex** — invoke with `/goal`. Goal mode keeps the agent on-target until the stated goal is satisfied.
> - **GitHub Copilot** — turn on autopilot mode.
>
> Without a goal mode, the migration may report `Partial` or `Blocked` because of premature termination rather than any genuine blocker in the source.


> ## ⚠️ Use a development environment only
>
> This skill creates and modifies live infrastructure in the target Power Platform tenant:
>
> 1. **Scaffolds** a new Power Pages site (Phase 7.1, `/create-site`).
> 2. **Deploys** the SPA build to the tenant (Phase 7.2.b, `/deploy-site`).
> 3. **Activates** the site (Phase 7.9, `/activate-site`) — provisions a `https://<subdomain>.powerappsportals.com` URL bound to the tenant. **Activation is non-reversible.** The site stays private until `websiteaccess.yml` / table permissions / web roles allow anonymous access — activation alone does not expose content to the public internet.
> 4. **Writes metadata** to Dataverse (Phase 7.3): table permissions, web roles, site settings, server logic via the required Power Pages skills (`/integrate-webapi`, `/create-webroles`, `/setup-auth`, `/audit-permissions`, `/add-server-logic`).
>
> Point this skill at a **development tenant**. Validate the full migration end-to-end in dev before considering production. Production migrations should be planned separately with an explicit rollout strategy, backups, and approval from whoever owns the target tenant.

Phase 7-9 of the EDM-to-SPA migration workflow. Reads the approved plan and canonical model that `migrate-traditional-site-to-spa-analyze` produced, scaffolds and deploys the SPA, activates it, migrates EDM metadata via the required Power Pages skills, implements routes/components/services, validates the result, and hands off.

## Core Principles

- **Approved plan in, working SPA out**: this skill writes SPA files — `migrate-traditional-site-to-spa-analyze` must already have approved the plan.
- **Migration is re-authoring, not blind conversion**: every EDM route, Liquid behavior, form, and runtime call maps to an explicit SPA target.
- **Use existing Power Pages skills**: reuse `/create-site`, `/integrate-webapi`, `/setup-auth`, `/create-webroles`, `/audit-permissions`, `/add-server-logic`, `/deploy-site`, `/activate-site` rather than duplicating their logic.
- **Static SPA only**: target frameworks are React, Vue, Angular, Astro. Never generate Next.js, Nuxt, Remix, SvelteKit, Liquid, or server-rendered output.
- **Validator is the verdict**: Phase 9's status header comes from `migration-completion-status.json`, never from the implement agent's self-report.

**Initial request:** $ARGUMENTS

---

## Workflow

- **Phase 0: Confirm Prerequisites and Target Environment** — Read `analyze-complete.json`, verify the canonical model + checklist + agent artifacts exist, then show the dev-environment warning and gate progress with `AskUserQuestion`. Stop if analyze has not run, the plan is not approved, or the user does not confirm dev environment.
- **Phase 7: Create the SPA, Deploy, Activate, Migrate Metadata, Then Implement** — `/create-site` + `/deploy-site` + `/activate-site` + the required-skill manifest + routes + components.
- **Phase 8: Verify Migration** — Build, browse-test, invoke `migration-validator`, summarize drift.
- **Phase 9: Summarize and Hand Off** — Record skill usage, present the validator's verdict, recommend post-migration next skills.

Phase numbering continues from `migrate-traditional-site-to-spa-analyze` (which owns Phases 1-6) so cross-references in agent definitions and reference docs remain stable. Phase 0 is a precondition check unique to this sub-skill.

---

## Phase 0: Confirm Prerequisites and Target Environment

Before doing anything else, do both: confirm `migrate-traditional-site-to-spa-analyze` finished and the user approved the plan, **and** confirm the user is targeting a development environment for the writes this phase performs.

### 0.1 Confirm analyze artifacts

1. Look for `<TARGET_PROJECT_ROOT>/migration-artifacts/analyze-complete.json`. If `$ARGUMENTS` is empty, search the user's current working directory and any subdirectory likely to contain `migration-artifacts/` (one level deep). If multiple candidates exist, ask the user which to use.
2. Parse the file. Reject if `status !== "approved"`. Reload `targetProjectRoot`, `targetFramework`, `edmSourceRoot`, `liveSiteUrl`, `planPath` from it.
3. Confirm the canonical model and verification checklist exist:
   - `migration-artifacts/canonical-site-model.json`
   - `migration-artifacts/migration-verification-checklist.json`
   - `migration-artifacts/static-analysis.json`
   - `migration-artifacts/forms-inventory.json`
   - `migration-artifacts/runtime-discovery.json` (or `status: "skipped"`)
4. If any required artifact is missing or `analyze-complete.json` is absent, stop and ask the user to run `migrate-traditional-site-to-spa-analyze` first.

### 0.2 Create the Full Per-Step Migration Task List

**Why this comes before the dev-environment gate.** This skill has a long, branching workflow (~25 discrete sub-steps from scaffold through summary). Past runs that tracked progress only at Phase granularity (Phase 0 / 7 / 8 / 9) routinely skipped sub-steps inside Phase 7 — activation was missed, validators were passed source URLs, `/test-site` was demoted to a "next step." Each of those was a sub-step the agent silently glossed over. Per-step `TaskCreate` accountability is the broader fix: every sub-step listed below becomes its own task with explicit `in_progress` → `completed` transitions, so a skipped step shows up as a still-`pending` task in the task list rather than as a silent omission in the summary.

Create the full task list **now**, before Phase 0.3. One task per row. Mark Phase 0.1 already `completed` (it ran first); mark Phase 0.2 `in_progress` while you create this list; flip it to `completed` once the list is fully created and you proceed to Phase 0.3.

> **Single source of truth.** The table below is the canonical task list. Do not invent additional tasks, merge rows, or skip rows. If a sub-step is genuinely not applicable (e.g. the source had no `weblink-sets/` so the weblink-layout pass is unnecessary), mark the task `completed` with a `notApplicable` note rather than dropping it from the list — that way every Phase 9 summary shows the same task shape regardless of source variation, and a sub-step that was actually skipped is visually distinguishable from one that was a no-op.

| # | Subject | activeForm | Phase ref |
|---|---------|------------|-----------|
| 1 | Confirm analyze artifacts | Confirming analyze artifacts | 0.1 |
| 2 | Create full migration task list | Creating task list | 0.2 |
| 3 | Confirm target environment is dev | Confirming dev environment | 0.3 |
| 4 | Scaffold SPA via `/create-site` | Scaffolding SPA | 7.1 |
| 5 | Verify dev server up + share URL with user | Verifying dev server | 7.1 post-conditions |
| 6 | Detect existing `.powerpages-site/` hydration | Detecting prior hydration | 7.2.a |
| 7 | Build SPA (`npm run build`) | Building SPA | 7.2.b |
| 8 | Deploy via `/deploy-site` (first deploy) | Deploying SPA | 7.2.b |
| 9 | Verify `.powerpages-site/` hydrated | Verifying metadata folder | 7.2.b |
| 10 | Build `required-skill-invocations.json` manifest | Building skill manifest | 7.3.a |
| 11 | Re-snapshot Dataverse against the **target** tenant + re-verify canonical model | Re-snapshotting target | 7.3.a.1 |
| 12 | Invoke `/integrate-webapi` (with target snapshot) | Integrating Web API | 7.3.b |
| 13 | Invoke `/create-webroles` | Creating web roles | 7.3.b |
| 14 | Invoke `/setup-auth` | Wiring auth | 7.3.b |
| 15 | Invoke `/audit-permissions` | Auditing permissions | 7.3.b |
| 16 | Invoke `/add-server-logic` | Adding server logic | 7.3.b |
| 17 | Translate EDM aggregate metadata into `.powerpages-site/` | Translating metadata | 7.3.d |
| 18 | Establish migration traceability | Establishing traceability | 7.4 |
| 19 | Implement routes and layout (including mandatory route families) | Implementing routes | 7.5 |
| 20 | Implement components, content, services, asset reuse, weblink layout | Implementing components | 7.6 |
| 21 | Build + commit milestones | Committing milestones | 7.7 |
| 22 | Deploy the migrated SPA via `/deploy-site` | Deploying migrated SPA | 7.8 |
| 23 | Activate the migrated site via `/activate-site` | Activating site | 7.9 |
| 24 | Persist activation record in `migration-completion-status.json` | Recording activation | 7.9 |
| 25 | Verify file inventory | Verifying inventory | 8.1 |
| 26 | Verify build (`npm run build`) | Verifying build | 8.2 |
| 27 | Browser-verify SPA on dev server (static + client-side) | Verifying dev server | 8.3 |
| 28 | Invoke `migration-validator` (with target-tenant Dataverse verification artifact) | Running validator | 8.4 |
| 29 | Live runtime verification via `/test-site` (against activated URL) | Running /test-site | 8.5 |
| 30 | Drift summary | Summarizing drift | 8.6 |
| 31 | Save verification artifacts | Saving artifacts | 8.7 |
| 32 | Record skill usage | Recording skill usage | 9.1 |
| 33 | Present final migration summary | Presenting summary | 9.2 |
| 34 | Recommend post-migration next skills | Recommending next skills | 9.3 |

Issue exactly one `TaskCreate` call per row. After the list is created, flip task #2 to `completed` and task #3 to `in_progress`, then proceed to Phase 0.3.

**Rules during the run:**

1. Before starting any sub-step, set its task to `in_progress`. Before moving to the next sub-step, set the current one to `completed`. Two sub-steps can never both be `in_progress` simultaneously — that pattern is what lets the agent silently skip ahead.
2. If a sub-step blocks on a user decision (e.g. activation deferred, or required-skill failure), keep the task `in_progress` until the decision resolves; do not flip to `completed` to "park" the step.
3. Phase 9's summary table reads from this task list — every row's status appears there verbatim. Pending or in_progress rows at Phase 9 time mean the migration is incomplete, not "done with caveats."

### 0.3 Confirm target environment is dev

Display the target-environment warning to the user **as a chat message** (not only as a SKILL.md callout — the user will not see the SKILL.md). Use this text verbatim:

> ⚠️ **Use a development environment only.** The next phases will:
>
> 1. Scaffold a new Power Pages site in the target tenant (`/create-site`).
> 2. Build and deploy the SPA to the tenant (`/deploy-site`) — this writes `.powerpages-site/` metadata.
> 3. Activate the site (`/activate-site`) — provisions a `https://<subdomain>.powerappsportals.com` URL and **permanently binds the subdomain to the tenant**. Activation is non-reversible. The site stays private behind sign-in / 403 until `websiteaccess.yml`, table permissions, and web roles allow anonymous access — activation alone does not expose content to anonymous internet users.
> 4. Write table permissions, web roles, site settings, and server logic to the target Dataverse via `/integrate-webapi`, `/create-webroles`, `/setup-auth`, `/audit-permissions`, `/add-server-logic`.
>
> Make sure your `pac` CLI is authenticated against a development tenant before continuing. If you're unsure which tenant `pac` is pointing at, run `pac auth who` in a separate terminal.

Then gate progress with `AskUserQuestion`:

| Header | Question | Options |
|--------|----------|---------|
| Dev environment? | Confirm the target tenant (where `pac` is currently authenticated) is a **development environment** (not a production tenant). This skill scaffolds, deploys, activates, and writes Dataverse metadata to that tenant. | Yes — target is a dev environment, I'll check `pac auth who` first, Cancel |

Branches:

- **Yes — target is a dev environment** → proceed to Phase 7.
- **I'll check `pac auth who` first** → ask the user to run `pac auth who`, surface the result, then re-ask the dev-environment confirmation.
- **Cancel** → stop immediately. Tell the user they can re-invoke after switching environments. Do not proceed to Phase 7.

---

## Phase 7: Create, Migrate, Implement, Deploy, Activate

**Goal:** Scaffold the SPA, hydrate `.powerpages-site/`, run the required Power Pages skills, implement routes/components/services, deploy the migrated SPA, and activate the live URL.

Mandatory order:

1. **`/create-site`** (7.1) — scaffold the SPA project.
2. **First `/deploy-site`** (7.2) — hydrates `.powerpages-site/` so 7.3 can write into it.
3. **Required Skill Invocations** (7.3) — `/integrate-webapi`, `/create-webroles`, `/setup-auth`, `/audit-permissions`, `/add-server-logic`. Never deferred to "Recommended Next Skills".
4. **Routes + layout + components + content + services** (7.4–7.6) reference the migrated metadata.
5. **Build and commit milestones** (7.7).
6. **Second `/deploy-site`** (7.8) — uploads the migrated SPA bundle.
7. **`/activate-site`** (7.9) — provisions the live URL Phase 8 verifies against.

Do not implement SPA code that depends on EDM metadata until that metadata has been migrated. Do not declare the migration complete until every required-skill manifest entry is `completed`, `not-required`, or `user-deferred` (which downgrades the migration to `Partial`).

### Actions

#### 7.1 Scaffold the SPA with `/create-site`

If `TARGET_PROJECT_ROOT` does not yet contain a Power Pages code site, invoke `/create-site` first. Pass `TARGET_FRAMEWORK`, the target location, and the full `DESIGN_DATA` (aesthetic, mood, derived typography, motion, palette, plus the optional `weblinkLayout` captured in analyze Phase 6.1.b when the source has `weblink-sets/`) captured by `migrate-traditional-site-to-spa-analyze` in its Phase 6.1. Because the analyze skill asks the same two design questions `/create-site` asks (aesthetic + mood) using the same reference doc, the create-site agent should reuse the captured answers rather than re-prompt.

Let `/create-site` run its normal discovery flow only for: site name and purpose, audience, framework confirmation, feature direction. If it would otherwise re-ask aesthetic/mood/palette/typography, supply the captured `DESIGN_DATA` so the user does not make the same choices twice. Do not bypass `/create-site` by manually copying templates.

If the target already exists, verify `powerpages.config.json`, `package.json`, framework/router, source directory and build command. If it exists and is not empty, ask before overwriting.

**EDM-source images take precedence over stock photography.** `/create-site`'s Phase 5.3 may source Unsplash imagery for hero/card/background slots. Treat any such images as placeholders only — Phase 7.6 will replace them with EDM-source assets from the canonical model's `assets[]`.

**`/create-site` Phase 2 must complete in full before this step returns.** `/create-site` Phase 2 has seven sub-steps (2.1 copy template → 2.2 replace placeholders → 2.3 rename gitignore → 2.4 `npm install` → 2.5 `git init` → **2.6 start dev server in background** → **2.7 Playwright snapshot + share URL with user**), gated by an explicit "do not proceed until the dev server is running" check at the end of 2.7. "Scaffolding complete" is *not* "templates landed on disk" — it is "dev server up, Playwright-verified, and the user has been told the preview URL." Do not treat 2.6 or 2.7 as optional preview work; they are part of the scaffold contract that downstream steps in this skill (and the user's ability to watch the migration unfold) depend on.

**Post-conditions you must verify before leaving 7.1:**

1. `npm run dev` (or the framework equivalent — `ng serve`, `astro dev`, etc.) is running in the background and listening on a local URL.
2. A `browser_snapshot` of that URL succeeded (the scaffold loader renders, no fatal errors in console).
3. The dev-server URL has been printed to the user in chat (so they can open it themselves and watch subsequent migration phases render live).

If `/create-site` returned without completing 2.6/2.7 (this happens when the create-site agent treats "scaffolding" as just the file-on-disk steps because this skill supplied all design answers up front), do **not** advance to Phase 7.2. Instead, run 2.6 and 2.7 yourself right here:

```bash
cd "<TARGET_PROJECT_ROOT>"
npm run dev
```

Launch with `Bash` `run_in_background: true`. Read the framework's expected port from `${CLAUDE_PLUGIN_ROOT}/references/framework-conventions.md` if it isn't obvious from stdout. Then `browser_navigate` to the local URL, `browser_snapshot` to confirm the scaffold loader is visible, and tell the user the URL in one line (e.g. "Scaffold is live at `http://localhost:5173` — open it in your browser to watch the migration as I build."). Only after those three post-conditions hold do you proceed.

**Continuation after the dev server is up.** Once the post-conditions above are satisfied:

- Keep the Phase 7 task `in_progress`. Phase 7 spans 7.1–7.7; the running dev server is the start, not the end.
- Do not pause for a user "ready to continue?" confirmation — sharing the URL is one-way information, not a checkpoint. Immediately proceed to Phase 7.2 in the same turn.
- Validate the scaffold (`package.json`, Power Pages config, non-empty source dir). If `/create-site` reported a failure or the scaffold is broken, stop and surface the failed prerequisite — do not deploy a broken scaffold.
- If the user chose **Deploy now** inside `/create-site`'s own Phase 8, `.powerpages-site/` may already exist. Phase 7.2 below detects this and skips the redundant deploy.

#### 7.2 Build and Deploy to Hydrate `.powerpages-site/`

##### 7.2.a Detect existing hydration

Inspect `<TARGET_PROJECT_ROOT>/.powerpages-site/`:

- **Exists and non-empty** (`website.yml` plus subfolders like `site-settings/`, `web-roles/`, `table-permissions/`, `web-pages/`): scaffold was already deployed. Skip deploy approval and 7.2.b. Still run `npm run build` once to confirm the scaffold compiles, then go to 7.2.c.
- **Empty or partial**: note the incomplete state in `migration-gap-log.md` and continue with the full deploy flow in 7.2.b.
- **Does not exist**: full deploy flow in 7.2.b.

##### 7.2.b Build, approve, and deploy

1. Run `npm run build`. Fix failures before deployment.
2. Ask for the required first-deployment approval:

   | Question | Options |
   |----------|---------|
   | The migrated SPA needs an initial deployment so Power Pages creates `.powerpages-site` metadata. Deploy now? | Deploy now (Required for metadata migration), Stop and deploy later |

   > **⚠️** Deployment writes the migrated SPA into the target tenant — confirm with the user that they are pointing at a **development environment** before approving. If the user is unsure which environment `pac` is authenticated against, ask them to run `pac auth who` first.

3. If approved, invoke `/deploy-site` for `TARGET_PROJECT_ROOT`.
4. After deployment completes, verify `.powerpages-site/` exists and is non-empty. If it is missing, stop metadata-dependent work and report the failure — table permissions, web roles, site settings, server logic, and tracking cannot be finalized until a successful deployment hydrates it.

##### 7.2.c Continuation after Phase 7.2 returns

This applies to **both** 7.2.a (fast path) and 7.2.b (deploy-now path):

- Treat `/deploy-site`'s `Deployment verified. .powerpages-site/ is fully hydrated with N files ...` line as an *interim* return — the start of Phase 7.3, not the end of Phase 7.
- Keep the Phase 7 task `in_progress`. Phases 7.3–7.9 are still pending.
- **Immediately proceed to Phase 7.3 in the same turn** — no "ready to continue?" prompt, no task-completion flip.
- Leave the dev server (`npm run dev`) running. Phase 8.3 reuses the same server.

If the agent ends the turn here, the resume entrypoint is **Phase 7.3**.

#### 7.3 Migrate EDM Metadata and Invoke Required Skills

Translate EDM metadata into the hydrated `.powerpages-site/` **and invoke every Power Pages skill needed for parity with the source**. This runs after Phase 7.2 (metadata folder hydrated) and before 7.4–7.6 (so SPA code can reference the migrated metadata). Required-skill invocation is **not optional and is not deferred to Phase 9**.

##### 7.3.a Build the Required Skill Invocations manifest

Derive a manifest from the approved migration plan and save it to `migration-artifacts/required-skill-invocations.json`. The trigger conditions, input context, expected evidence, and invocation order are in:

> Reference: `${CLAUDE_PLUGIN_ROOT}/skills/migrate-traditional-site-to-spa/references/required-skill-manifest.md`

For each candidate skill, evaluate its trigger condition against the plan. If the trigger fires, the skill is `required`; if not, the manifest still records the skill with `status: "not-required"` and a short reason so the migration considered every skill explicitly.

Each required entry records `skill`, `trigger` (the specific plan evidence that satisfied the trigger), `inputContext`, `expectedEvidence[]`, `order`, `notes`, and `status: "required"` initially.

##### 7.3.a.1 Re-snapshot Dataverse against the **target** tenant

Analyze's snapshot (`dataverse-schema-snapshot.json`) was captured against the **source's** tenant. Implementation writes to the **target's** tenant — possibly a different Dataverse org with different custom tables or renamed columns. Before any required-skill invocation writes Web API site settings, table permissions, web roles, or server-logic metadata, capture a fresh snapshot of the target:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/snapshot-dataverse-schema.js" \
  --tables "<comma-separated logical names from canonical-site-model.json#/dataverseEntities and componentMapping[].entity>" \
  --output "<TARGET_PROJECT_ROOT>/migration-artifacts/dataverse-schema-snapshot.target.json" \
  --all-metadata
```

`pac auth who` at this point reports the target environment (confirmed in Phase 0.3). If `pac` is unauthenticated, fail loudly — do not fall back to the source snapshot.

Then re-run the verifier against the target snapshot:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/verify-canonical-model-against-dataverse.js" \
  --canonicalModel "<TARGET_PROJECT_ROOT>/migration-artifacts/canonical-site-model.json" \
  --snapshot "<TARGET_PROJECT_ROOT>/migration-artifacts/dataverse-schema-snapshot.target.json" \
  --edmReferences "<TARGET_PROJECT_ROOT>/migration-artifacts/edm-metadata-references.json" \
  --output "<TARGET_PROJECT_ROOT>/migration-artifacts/canonical-model-vs-dataverse.target.json"
```

Exit-code handling:

- `0` (`verdict: ok`) — proceed to 7.3.b. The target snapshot is now the authoritative input for every sub-skill in 7.3.b. Pass its path on each invocation's `inputContext` so `/integrate-webapi`, `/create-webroles`, `/setup-auth`, `/audit-permissions`, and `/add-server-logic` all anchor on the target schema, not the agent's recollection.
- `2` (`verdict: fail`) — the target Dataverse is missing a table/column/relationship/optionset/lookup the canonical model references. **Do not proceed to 7.3.b.** This is the migration-blocker scenario the metadata gates are designed to catch (e.g. the source had `faq_articlebody` but the target's Dataverse provisioning missed it). Surface the findings to the user and ask whether to (a) provision the missing metadata in the target tenant and retry, (b) update the canonical model to drop the reference and re-run analyze Phase 5, or (c) cancel the migration.
- `1` — fatal error (e.g. snapshot or model file missing). Fix the input and retry.

##### 7.3.b Invoke the required skills in order

The invocation order is `/integrate-webapi` → `/create-webroles` → `/setup-auth` → `/audit-permissions` → `/add-server-logic`, because each provides inputs the next consumes (see the manifest reference for the full rationale).

For each invocation:

- Pass the manifest's `inputContext` + `notes` directly so the sub-skill does not re-prompt for settled facts.
- Flip the manifest entry `status: "required"` → `"invoked"` before handing control over; flip to `"completed"` only when the sub-skill returns and every `expectedEvidence[]` file exists on disk.
- On failure or missing evidence, set `status: "failed"`, append a remediation note, and **stop**. Surface the failure and ask whether to retry, narrow scope, or stop. A failure must never silently fall through to Phase 9.

##### 7.3.c User-initiated deferral (downgrades to Partial)

The user may explicitly decline to run a required skill (e.g., they lack tenant access for `/setup-auth`). Capture via `AskUserQuestion`:

| Question | Options |
|----------|---------|
| Skill `<name>` is required by the approved plan because `<trigger>`. Run now or defer? | Run now (Recommended), Defer to later session, Cancel migration |

On **Defer**: set manifest entry to `status: "user-deferred"` with the reason, add a `category: "skill-deferred"` row to `migration-gap-log.md`, leave typed stubs + TODO references in SPA code that depended on the deferred skill — never invent client-side substitutes for auth, permissions, or server logic. Final migration status becomes `Partial`.

##### 7.3.d Translate EDM aggregate metadata into split SPA YAML

Drive metadata translation from the approved plan (the manifest's sub-skills handle most of this). The EDM-aggregate → SPA-granular file-shape mapping and the `adx_*` → normalized field-name rules are in:

> Reference: `${CLAUDE_PLUGIN_ROOT}/skills/migrate-traditional-site-to-spa/references/pac-edm-structure.md#edm-aggregate-to-spa-granular-mapping`

Before writing metadata, save `migration-artifacts/metadata-translation-plan.md`: for each EDM aggregate record list source file, source record name, target `.powerpages-site` folder, target file name, action (`create` / `update` / `skip` / `gap`), ID strategy, confidence. If a metadata item cannot be confidently mapped, log it in `migration-gap-log.md` instead of copying silently. Preserve the hydrated SPA baseline files created by `/deploy-site`; only add or update what the approved plan requires. Never bypass table permissions or imply client-side role checks enforce data security.

**Route-shadow audit (precondition for SPA route implementation in 7.5).** Before metadata translation finalizes, run the route-shadow audit:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/audit-route-shadows.js" \
  --projectRoot "<TARGET_PROJECT_ROOT>" \
  --canonicalModel "<TARGET_PROJECT_ROOT>/migration-artifacts/canonical-site-model.json" \
  --output "<TARGET_PROJECT_ROOT>/migration-artifacts/route-shadows.json"
```

Exit code:

- `0` — no collisions; proceed to the preservation-contract loop below.
- `2` — at least one collision; **do not proceed to 7.5**. Read the findings:
  - `kind: "deployed-webpage-shadow"` — a `.powerpages-site/web-pages/<page>.webpage.yml` shares a `partialurl` with a planned SPA route. Even with the SPA route registered, Power Pages serves the deployed legacy webpage at that URL. Resolution: delete or rename the offending webpage YAML, then re-run the audit.
  - `kind: "server-rendered-route"` — the SPA plan registers a route that Power Pages always server-renders (`/profile`, `/sign-in`, etc.). Resolution: implement the route per the documented Power-Pages-aware pattern (auth callbacks via `/setup-auth`, profile editor wired to Web API via `/integrate-webapi`), not as a plain SPA route. Update the canonical model's componentMapping for that route to reflect the pattern, then re-run the audit.
- `1` — fatal error (missing inputs). Fix the input path.

**Preservation contract is the authoritative input.** The canonical model's `preservation` section (see [Preservation Contract](../migrate-traditional-site-to-spa/references/edm-migration-model.md#preservation-contract)) lists every source web role, table permission, and column that must exist in the target. Drive metadata translation from it directly:

- For each `preservation.webRoles[]` entry with `source: true`, generate `.powerpages-site/web-roles/<sanitized-name>.webrole.yml` (via the `/create-webroles` sub-skill or `scripts/create-web-role.js` directly). Never drop a `source: true` role.
- For each `preservation.tablePermissions[]` entry with `source: true`, generate `.powerpages-site/table-permissions/<sanitized-name>.tablepermission.yml` (via `/integrate-webapi`'s Phase 6 path-A flow or `scripts/create-table-permission.js`). Source permissions get fresh GUIDs but identical `entityLogicalName` / `scope` / `privileges` / `webRoleNames`. Never narrow scope, never drop.
- For each `preservation.dataModel.tables[].columns[]` entry, confirm the column exists in the target tenant's Dataverse snapshot (already verified in 7.3.a.1). Renaming or retyping is forbidden.
- `source: false` additions appear only with a `justification` string. If an addition lacks justification, surface it to the user as a Phase 5 omission and stop until the canonical model is corrected.

##### 7.3.e Phase 7.3 exit criteria

Conclude only when:

- `migration-artifacts/required-skill-invocations.json` exists and every entry has `status` in `{completed, not-required, user-deferred}` — never `required`, `invoked`, or `failed`.
- `.powerpages-site/` contains the metadata 7.4–7.6 will rely on.
- Every `user-deferred` entry has a matching `category: "skill-deferred"` row in `migration-gap-log.md`.

If any is unmet, stay in 7.3 — do not advance by treating an unfinished sub-skill as good enough.

#### 7.4 Establish Migration Traceability

For each generated route/component/service, record source in `migration-artifacts/migration-traceability.json`:

| Generated artifact | Derived from | Evidence | Confidence |
|--------------------|--------------|----------|------------|

Use concise inline comments only when they help future maintainers understand non-obvious EDM mappings.

#### 7.5 Implement Routes and Layout

Create the SPA route structure from the approved model: home/root route, child routes from web page hierarchy, shared header/footer/navigation from web templates / web link sets / snippets, framework-appropriate routing conventions.

**Mandatory route families** (not-found, access-denied, search, profile, sign-in/out/callback, registration/invitation/password-reset, entity CRUD, admin/role-gated, Copilot embed) must be implemented as real routes backed by real components in 7.5–7.6 when the source had them. The when-the-source-has-it conditions and the mandatory SPA implementation per family are in:

> Reference: `${CLAUDE_PLUGIN_ROOT}/skills/migrate-traditional-site-to-spa/references/edm-to-spa-patterns.md#mandatory-route-families`

None of those families may be left as a `manualGap`, placeholder shell, or "next step". If a mandatory family is implied by the source but missing from the plan's `ROUTES_DATA[]`, treat that as unexpected drift: update the plan, then implement.

#### 7.6 Implement Components, Content, and Services

Map web page copy/summaries → page components; web templates → reusable layout/section components; content snippets → constants/content modules; web files → public or imported assets; custom CSS → framework/project styles. Do not leave placeholder-only pages for routes in scope.

**What MUST NOT appear in any rendered SPA output** — scaffold/phase labels, migration-internal metadata as content, sensitive identifiers (tenant ID, client ID, OIDC params), phase-by-phase commentary as page copy, TODO strings in production-shape components. Full rules and rationale:

> Reference: `${CLAUDE_PLUGIN_ROOT}/skills/migrate-traditional-site-to-spa/references/spa-output-rules.md`

**Generate one SPA component per `reusableComponents[]` entry.** Walk `canonical-site-model.json#/reusableComponents[]` (see [Reusable Components](../migrate-traditional-site-to-spa/references/edm-migration-model.md#reusable-components)). For every entry with `reuseCount >= 2`, generate exactly one component at the framework-appropriate location, named `spaTarget.componentName`. Page-level `componentMapping[]` entries that referenced the source artifact must import this component — do **not** inline the source content into multiple SPA files. Inlining is unexpected drift and Phase 8 flags it. Entries with `reuseCount === 1` may be inlined when the source content is trivially short; longer single-use snippets still get factored. `spaTarget.kind` determines the component shape: `content` → content module, `layout` → layout component, `navigation` → nav component, `asset` → shared CSS/JS module.

**Reuse EDM-source assets** (images, icons, downloadables) — walk the canonical model's `assets[]`, copy each binary to `public/<original-filename>` (or `src/assets/<original-filename>` for bundler-imported), rewrite references in migrated content, replace stock placeholders left by `/create-site`, reuse logo/favicon, record reuse in `migration-traceability.json`. Full procedure:

> Reference: `${CLAUDE_PLUGIN_ROOT}/skills/migrate-traditional-site-to-spa/references/edm-to-spa-patterns.md#reuse-edm-source-assets`

**Implement the profile route** (when the source had `/profile`) — identity from `/setup-auth`, contact read/update from `/integrate-webapi` respecting `Contact`-scoped permissions and narrowed `Webapi/contact/fields`, fallback to read-only when write is not permitted, portal-only sub-features stay as gaps, wire the route into AppShell navigation. Full procedure:

> Reference: `${CLAUDE_PLUGIN_ROOT}/skills/migrate-traditional-site-to-spa/references/edm-to-spa-patterns.md#profile-route-implementation`

**Render weblink sets in the layout the user approved.** When the source has `weblink-sets/` records (primary nav, footer columns, sidebar "quick links" widgets, related-content menus), build one SPA link-list component per source set. Each component reads its layout from `DESIGN_DATA.weblinkLayout`:

- `"horizontal"` — render the links as an inline row / pill bar (e.g., flex container with `gap`, `flex-wrap`, no list bullets). Suits primary nav and footer-link row layouts.
- `"vertical"` — render the links as a stacked list (e.g., column of `<a>` elements or `<ul>` with vertical spacing). Suits sidebar widgets and footer columns.
- `null` — the source had no weblink sets; do not build a link-list component.

Use the link order from the source YAML (`weblinkset.yml`'s `weblinks[]` array). Preserve link text and target URL verbatim — these are content, not configuration. If a link points to an EDM web-page that has been migrated, rewrite the target URL to the new SPA route from `ROUTES_DATA[]`; if it points off-site, keep the absolute URL.

The single `weblinkLayout` value applies to every set. If the user wants different layouts per set, the analyze SKILL's Phase 6.5 revise loop is the place to capture that — never invent per-set variations here.

Wire SPA services against migrated metadata: tables with Web API integration call into services scaffolded by `/integrate-webapi`; server logic calls into endpoints created by `/add-server-logic`; auth/role-aware UI uses patterns from `/setup-auth` and roles from `/create-webroles`. If any of those was user-deferred, leave typed stubs and migration notes — never invent client-side substitutes. Never bypass table permissions or imply that client-side role checks enforce data security.

#### 7.7 Build and Commit Milestones

Run `npm run build` after meaningful implementation chunks. Fix build errors before proceeding. Commit after significant milestones when working in a git repository.

#### 7.8 Deploy the Migrated SPA

1. Final `npm run build`. Stop if the build fails — surface the error and ask whether to fix-and-retry.
2. Invoke `/deploy-site` via the `Skill` tool for `TARGET_PROJECT_ROOT`. It uploads the built bundle plus the populated `.powerpages-site/` metadata to the same website record from 7.2.
3. Do **not** invoke `/activate-site` from here. Activation is 7.9.

If the deploy fails, stop and ask the user whether to retry, fix the build, or defer. Do not proceed to 7.9.

#### 7.9 Activate the migrated site

Activation provisions a `https://<subdomain>.powerappsportals.com` URL that Phase 8's `migration-validator` and Phase 8.5's `/test-site` need for live-site checks. It does **not** on its own change `websiteaccess.yml` / table-permission gating — the existing access records still control visibility.

Run once per migration. **The skip check must be tied to the new SPA's website record id, never to the site name** — the migrated SPA can share a `siteName` with the source EDM site, so a name-based "already activated?" check resolves to the source's already-activated record and falsely skips activation of the new target.

Resolve the authoritative target id, then evaluate the skip conditions in this exact order:

1. Read `<TARGET_PROJECT_ROOT>/.powerpages-site/website.yml#id` — the new SPA's website record GUID, written by `pac pages upload-code-site`. Call it `TARGET_WEBSITE_RECORD_ID`. If the file is missing, jump to the "Otherwise" branch below. Do not fall back to a name search.
2. Skip with `status: "already-activated"` only when **all** of the following hold:
   - `migration-completion-status.json#/activation/status === "succeeded"` **and** the recorded `websiteRecordId` equals `TARGET_WEBSITE_RECORD_ID`, **or**
   - `node "${CLAUDE_PLUGIN_ROOT}/scripts/check-activation-status.js" --projectRoot "<TARGET_PROJECT_ROOT>"` returns `{ "activated": true, ... }` **and** the returned `websiteRecordId` equals `TARGET_WEBSITE_RECORD_ID`. (The script reads `.powerpages-site/website.yml` to anchor on the right GUID — see its header doc.)

   If either branch fires, write/refresh the `activation` block with `status: "already-activated"`, the matched `websiteRecordId`, and the recorded `liveUrl`, then continue to Phase 8.

3. If `check-activation-status.js` returns `{ "error": "Ambiguous site name match: ... " }`, do **not** skip and do **not** proceed to a guessed activation — surface the error to the user and ask whether to rename the SPA's `siteName` (recommended) or pass an explicit `websiteRecordId` to `/activate-site` (advanced).

Otherwise:

1. Ask the user (activation is non-reversible — the subdomain is bound to the tenant on success):

   | Header | Question | Options |
   |--------|----------|---------|
   | Activate now? | The migrated SPA is deployed and waiting on a live URL. Activation gives it a `https://<subdomain>.powerappsportals.com` URL — required so Phase 8's validator and `/test-site` can verify against the live site. Activation does **not** publish the site to anonymous internet users on its own. Activate now via `/activate-site`? | Activate now (Recommended), Defer activation (Phase 8 live-site checks run as `deferred`), Cancel migration |

   > **⚠️** Activation provisions a `*.powerappsportals.com` URL on a public DNS name and **permanently binds the subdomain to the target tenant** — this cannot be undone. The site itself stays private (anonymous visitors hit sign-in / 403) until `websiteaccess.yml` / table permissions / web roles allow anonymous access. Confirm with the user that they are activating in a **development environment** and the chosen subdomain is acceptable as a long-lived dev URL.

   - **Defer activation** → record `activation: { status: "user-deferred", reason: "..." }` in `migration-completion-status.json`, add a `category: "activation-deferred"` row to `migration-gap-log.md`, continue to Phase 8. Final status will be `Partial`, never `Complete`.
   - **Cancel migration** → stop. User can resume by re-invoking this skill.
   - **Activate now** → step 2.

2. Invoke `/activate-site` via the `Skill` tool with `TARGET_PROJECT_ROOT`, the website record id (from `.powerpages-site/website.yml` `id`), and an optional pre-approved subdomain. `/activate-site` runs its own confirmation step and handles the provisioning poll; do not wrap it in a background shell.

3. Persist the activation record in `migration-artifacts/migration-completion-status.json`:

   ```json
   {
     "activation": {
       "status": "succeeded",
       "liveUrl": "https://faq-5t31u.powerappsportals.com",
       "subdomain": "faq-5t31u",
       "websiteRecordId": "<id>",
       "activatedAt": "<ISO 8601>"
     }
   }
   ```

   `status` is one of `succeeded`, `partial`, `failed`, `user-deferred`, `already-activated`. The validator reads `liveUrl` as its `LIVE_SITE_URL` input.

4. If `/activate-site` fails (auth, subdomain conflict, provisioning timeout), surface the diagnostic and ask whether to retry, change the subdomain, or defer. Do **not** silently proceed to Phase 8 with a failed activation.

### Output

- SPA scaffolded, deployed, and activated. `migration-completion-status.json#/activation` recorded.
- `migration-artifacts/required-skill-invocations.json` written; every required entry resolved to `completed` / `not-required` / `user-deferred`.
- EDM metadata migrated into `.powerpages-site/` before SPA code wired against it.
- All mandatory route families implemented as real routes backed by real components.
- Routes, components, content, and services implemented per the approved plan.
- Traceability artifacts saved. Build passes before verification.

---

## Phase 8: Verify Migration

**Goal:** Verify the migrated SPA against the approved plan and the observed EDM behavior.

### Actions

#### 8.1 Verify File Inventory

Quick sanity check before the validator runs. Confirm the expected routes, components, services, assets, and migration artifacts exist on disk. For each `assets[]` entry, confirm the binary exists at its planned `targetPath` and at least one component/layout/stylesheet references it — unreferenced entries are drift items.

Grep the SPA source for stock-image URLs (`images.unsplash.com`, `placehold.co`, `placeholder.com`). Any remaining stock URL in a slot whose source had a matching `assets[]` entry is unexpected drift.

Confirm `.powerpages-site/` exists when the approved migration includes metadata. If missing, mark metadata verification as failed and direct the user to run `/deploy-site`.

#### 8.2 Verify Build

```bash
npm run build
```

Fix failures before continuing.

#### 8.3 Browser-Verify the SPA on the Dev Server (Static + Client-Side Only)

Reuse the dev server already running from Phase 7.1 — do not start a second one. If the user closed the terminal, the build failed earlier, or the port was reclaimed, restart `npm run dev` in the background now. Capture the dev-server URL — Phase 8.4 passes it to the validator so its behavioural gates can drive the real UI.

**The dev server cannot verify data integrations.** It serves the SPA's static bundle, not the Power Pages runtime, so any client call to `/_api/` or `/_services/` returns `404` locally. Treat dev-server verification as *static + client-side only*: it confirms the JS renders, routes resolve, links are wired, and form structure is correct, but it cannot prove that Web API calls, OData queries, or server-logic endpoints actually work. Runtime verification of those integrations happens in **Phase 8.5 against the activated live URL** — do not declare the SPA "verified" based on a green dev-server pass alone.

Navigate with Playwright and confirm at a minimum:

- All in-scope routes render meaningful content.
- Navigation matches the approved route model — **and every authenticated/role-gated route is reachable from a visible `<Link>` / `<NavLink>` in the AppShell**, not just by typing the URL.
- No critical console errors (ignore expected `/_api/` 404s — those are dev-server-only artifacts and are exercised against the live URL in 8.5).
- Data/API placeholders, pending work, and manual gaps are visibly and accurately documented.
- The Sign-in button, when present, actually navigates to the identity provider when clicked (not just renders the right label).
- Auth-gated or role-gated routes behave per the approved scope.

Leave the dev server running until Phase 8.4 completes — the validator's behavioural gates (`gate-route-reachability`, `gate-signin-click-redirect`, `gate-form-submission-shape`) need it alive. If the dev server cannot stay up (port conflict, build failure that the build step missed), those gates are marked `deferred` and the migration cannot finish `Complete`.

#### 8.4 Invoke the Migration Validator (Completion Gate)

Delegate the completion verdict to `migration-validator`. The validator is **independent of the agent that performed the migration** — it reads the checklist (built in Phase 5) and the manifest (built in Phase 7.3), walks every entry against the SPA filesystem and the running dev server, and produces the final verdict.

The validator's full Task prompt template (with `LIVE_SITE_URL`, `DEV_SERVER_URL`, and the synthetic gate-* check list) is in:

> Reference: `${CLAUDE_PLUGIN_ROOT}/skills/migrate-traditional-site-to-spa/references/agent-prompts.md#validator-prompt`

Use the `Task` tool to invoke `${CLAUDE_PLUGIN_ROOT}/agents/migration-validator.md` with the prompt from the reference, substituting `TARGET_PROJECT_ROOT`, the checklist/manifest/`.powerpages-site/` paths, the dev-server URL from 8.3, and `LIVE_SITE_URL` from `migration-completion-status.json#/activation/liveUrl` (or `none` if activation was deferred/failed).

> **⚠️ `LIVE_SITE_URL` resolution — read carefully.** The validator's `LIVE_SITE_URL` is the **target SPA's** live URL, **not** the source EDM site's. Two places hold a "live URL"; only one is correct here:
>
> | File | Field | Meaning | Use for validator? |
> |------|-------|---------|--------------------|
> | `migration-completion-status.json` | `activation.liveUrl` | URL of the newly-activated **target SPA** | ✅ Yes — this is `LIVE_SITE_URL` |
> | `analyze-complete.json` | `liveSiteUrl` | URL of the **source EDM site** that was crawled in analyze Phase 4 | ❌ Never |
>
> If `migration-completion-status.json#/activation/liveUrl` is missing, equals `analyze-complete.json#/liveSiteUrl`, or `activation.status` is not `succeeded`/`already-activated`, **do not pass a guessed URL** to the validator — pass `'none'` and let the live-site gates record `deferred`. Passing the source's URL silently fails: the validator will look at the original EDM site, see content unrelated to the SPA, and either mark live-site checks `deferred` ("live URL still serves the original EDM source") or worse, falsely pass them.
>
> If activation succeeded after a prior validator run with a wrong/missing URL (e.g., the activation skip-check incorrectly fired in an earlier run), **re-run the validator** with the corrected `LIVE_SITE_URL` and overwrite the stale `migration-validation-report.json`. A stale "live-site deferred" verdict must not survive a successful re-activation.

When the validator returns, read `migration-completion-status.json`:

- **`Blocked`** — do not advance to Phase 9. Surface blockers, return to the indicated phase, re-run the validator.
- **`Partial`** — continue to 8.5 and Phase 9. Phase 9 must report `Partial` and list every `deferred` check.
- **`Complete`** — continue with a clean handoff.

Never describe the migration as `Complete` while `migration-completion-status.json` says otherwise — the validator's verdict is the single source of truth.

#### 8.5 Live Runtime Verification via `/test-site`

The validator in 8.4 checks the checklist and runs targeted behavioural gates, but it does not crawl the live site or capture full network traffic against `/_api/` and `/_services/` endpoints. That live-runtime smoke test is what `/test-site` is for — and because Web API calls 404 on the dev server (see 8.3), this is the **only** Phase 8 step that can prove data integrations actually work end-to-end. Run it inline; do not demote it to a "Recommended Next Skill" in Phase 9.

**Skip rule** — and the only valid reasons to skip:

- `migration-completion-status.json#/activation/status` is **not** `succeeded` or `already-activated` → activation was deferred or failed; there is no live URL to test. Mark live-runtime verification as `deferred` and downgrade the migration to `Partial`.
- The validator in 8.4 already returned `Blocked` → fix the blockers and re-run 8.4 first; only invoke `/test-site` after the validator passes (`Complete` or `Partial`).

Otherwise, invoke `/test-site` via the `Skill` tool, passing the **target SPA's** live URL as the argument. The same disambiguation rule as 8.4 applies — use `migration-completion-status.json#/activation/liveUrl`, never `analyze-complete.json#/liveSiteUrl`:

```text
/test-site <migration-completion-status.json#/activation/liveUrl>
```

When `/test-site` returns:

1. Read its report (the skill writes a per-page + per-API-call rollup). Surface the headline counters (pages crawled, API calls observed, failures).
2. **Cross-check against the manifest:** every endpoint enabled by `/integrate-webapi` in Phase 7.3 must appear in `/test-site`'s captured network traffic and return a non-4xx status. If a `/_api/` or `/_services/` endpoint is missing from the captured traffic, or returns 4xx/5xx, that's unexpected drift — append a `category: "runtime-endpoint-failure"` row to `migration-gap-log.md` and treat the migration as `Partial`.
3. **Response-shape mismatches** that `/test-site` reports against `/_api/serverlogics/` endpoints feed back into Phase 7.6 — record them as drift items so the SPA's parsing matches the observed shape. Do not silently accept a shape mismatch.

If `/test-site` cannot reach the live URL (DNS not yet propagated, activation still provisioning, auth gate blocks an anonymous crawl), surface the diagnostic and ask the user whether to retry now, defer (downgrades to `Partial`), or cancel.

#### 8.6 Compare Against EDM Evidence (Drift Summary)

The validator already emitted drift checks (`runtime-route-missing`, `runtime-endpoint-missing`, `stock-image-remaining`) in `migration-validation-report.json`. Summarize them for the user in a short table — do not re-do the comparison:

| EDM route/behavior | SPA result | Status | Notes |
|--------------------|------------|--------|-------|
| `<route>` | `<route/component>` | Match / Changed / Gap | `<from validator report>` |

Classify drift as `match` / `intentional change` / `manual gap` / `unexpected drift`. Any `unexpected drift` means the validator flagged `fail` — return to 7.6 (or earlier) instead of accepting it silently.

Include any `runtime-endpoint-failure` rows that 8.5 appended — those are runtime drift, not file-shape drift, and they belong in the same summary so the user sees the full picture.

#### 8.7 Save Verification Artifacts

Save `migration-verification-report.md` (human-readable rollup of the drift summary) and the updated `migration-gap-log.md`. Per-check validator findings live in `migration-validation-report.md`.

### Output

- Build verified. Dev-server browser verification complete (static + client-side).
- Validator verdict written to `migration-completion-status.json` and consumed by Phase 9.
- Live-runtime smoke test via `/test-site` completed (or recorded as `deferred` when activation was deferred/failed). Any `runtime-endpoint-failure` rows appended to `migration-gap-log.md`.
- Per-check validation report saved alongside the canonical artifacts.
- Drift summary reviewed.

---

## Phase 9: Summarize and Hand Off

**Goal:** Record skill usage, present the validator's verdict, recommend the smallest useful next steps.

### Actions

#### 9.1 Record Skill Usage

> Reference: `${CLAUDE_PLUGIN_ROOT}/references/skill-tracking-reference.md`

Record this skill's usage with `--skillName "MigrateEdmToSpaImplement"`.

#### 9.2 Present Final Summary

Lead with the validator's status header from `migration-completion-status.json`:

- **`Migration Complete`** — every required-skill invocation finished, every mandatory route implemented, every gate passed.
- **`Migration Partial — [N] required skill(s) deferred, [M] route(s) stubbed`** — gate passed only because the user deferred items. List each with its gap-log row.
- **`Migration Blocked — [N] required item(s) still incomplete`** — Phase 8 gate could not pass. List blockers and the phase to return to. Do **not** present a "complete" summary table when status is `Blocked`.

Then include:

| Area | Summary |
|------|---------|
| Migration status | `Complete` / `Partial` / `Blocked` (from the validator) |
| Activation | `succeeded` / `already-activated` / `user-deferred` / `failed` (from `migration-completion-status.json#/activation`) |
| Source EDM site | `<website id or source path>` |
| Target SPA | `<framework and project root>` |
| Live URL | `<https://<subdomain>.powerappsportals.com>` when activation succeeded, else `Activation deferred — run /activate-site to provision a live URL` |
| Routes migrated | `<count and notable routes>`, including mandatory route families confirmed |
| Required Skill Invocations | `<completed count> / <required count>` from the manifest |
| Data/API work | `<completed / pending>` |
| Auth/security work | `<completed / pending>` |
| Metadata hydration | `<.powerpages-site present / missing>` |
| Manual gaps | `<count and highest-risk items>` (excludes skill-deferred entries) |
| Skill-deferred items | `<count and list>` (from `migration-gap-log.md` rows tagged `skill-deferred`) |
| Verification | `<build/browser/drift status>` |
| Key artifacts | `<migration-artifacts paths>` including `required-skill-invocations.json` and `migration-completion-status.json` |

Never describe the migration as `Complete` when `migration-completion-status.json` says otherwise. If the user pushes back on a `Partial` or `Blocked` result, walk them through the blockers and offer to return to the relevant phase.

#### 9.3 Recommended Next Skills

For **post-migration enhancements only**. Core migration skills (`/integrate-webapi`, `/create-webroles`, `/setup-auth`, `/audit-permissions`, `/add-server-logic`) must never appear here — those belong inside Phase 7.3. If any would otherwise appear, the migration is `Partial` or `Blocked` and should be reported as such in 9.2.

| Situation | Recommend |
|-----------|-----------|
| Activation in 7.9 failed and the user wants to retry after fixing the cause | `/activate-site` |
| Phase 8.5's inline `/test-site` run flagged issues, or activation succeeded after Phase 8 completed and runtime parity needs a re-check | `/test-site` |
| The migrated SPA needs SEO metadata, sitemap, or social previews | `/add-seo` |
| Empty Dataverse tables need seed records to demo the SPA | `/add-sample-data` |
| A first deployment is still pending (and not previously declined) | `/deploy-site` |

**Deferred core skills** — if `migration-completion-status.json` lists any `user-deferred` entries from the Phase 7.3 manifest, surface them:

| Deferred skill | Reason captured at deferral | Recommended action |
|----------------|------------------------------|---------------------|
| `<skill>` | `<reason>` | Re-run Phase 7.3 (or invoke `<skill>` directly with the input context recorded in the manifest) |

Empty when the migration completed cleanly. If non-empty, the migration is `Partial` and the deferred skills are the path back to `Complete`.

### Output

- Skill usage recorded.
- Final status reported as `Complete` / `Partial` / `Blocked` based on `migration-completion-status.json` — never `Complete` while required skills remain user-deferred or while gate blockers exist.
- User receives a concise migration handoff with paths, gaps, deferred skills, and next skills (post-migration enhancements only).

---

## Key Decision Points

1. **Phase 7.2.b**: Required first deployment (only when `.powerpages-site/` is not already hydrated).
2. **Phase 7.9**: Activation via `/activate-site`. Required for live-site validator checks; deferring downgrades to `Partial`.
3. **Phase 7.3**: For each required skill in the manifest, confirm via `AskUserQuestion` only if the user wants to defer. Deferral downgrades to `Partial`; never silently skip.
4. **Phase 8**: Whether unexpected drift should be fixed, accepted, or moved to manual gaps. The Phase 8.4 validator must return `Complete` or `Partial` before Phase 9 can hand off.

---

## Progress Tracking

**Phase-level tracking is intentionally coarse here** — the authoritative task list is the 34-row per-sub-step list created in Phase 0.2. The four phase-level rows below are a roll-up for readers skimming the SKILL.md; the actual `TaskCreate` calls in a run produce one task per sub-step (scaffold, dev-server-up, deploy, activate, integrate-webapi, etc.). See Phase 0.2 for the full row list and the per-sub-step rules (one `in_progress` at a time, no silent merging, no row dropped for non-applicability).

| Task subject | activeForm | Description |
|--------------|------------|-------------|
| Phase 0: Confirm analyze artifacts + create task list | Phase 0: Confirming inputs | Read `analyze-complete.json`, verify canonical model + checklist + agent artifacts exist, create the 34-row per-sub-step task list, confirm dev environment |
| Phase 7: Migrate SPA implementation | Phase 7: Migrating SPA | `/create-site` (with dev-server-up post-conditions), deploy to hydrate `.powerpages-site`, `/activate-site` for the live URL, re-snapshot Dataverse against the target tenant and re-verify the canonical model, build and execute the Required Skill Invocations manifest inline, then implement mandatory routes (including profile), components, services, translated metadata, assets, traceability — each as its own task per Phase 0.2 |
| Phase 8: Verify migration | Phase 8: Verifying migration | Build, dev-server browser-verify (static/client-side only), delegate the completion gate to `migration-validator` (now including five metadata blocker gates), run `/test-site` inline against the live activated URL (Web API and server-logic endpoints can only be exercised here, not on the dev server), summarize drift — each as its own task per Phase 0.2 |
| Phase 9: Summarize migration | Phase 9: Summarizing | Record skill usage, present the validator's verdict, recommend post-migration next skills — each as its own task per Phase 0.2 |

---

## Test Prompts

| Scenario | Example |
|----------|---------|
| Standard handoff | "Implement the migration plan in `./my-spa/migration-artifacts/`." |
| Resume after defer | "Resume the migration in `./my-spa/` — I'm ready to run `/setup-auth` now." |
| Standalone (already analyzed) | "I already approved the plan yesterday in `./my-spa/`; run the implement skill." |
