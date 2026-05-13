---
name: migrate-edm-to-spa-implement
description: >-
  Implements an approved EDM-to-SPA migration plan. Phases 7-9 of the migration workflow: scaffold
  the SPA with `/create-site`, deploy to hydrate `.powerpages-site/`, activate the site for live-URL
  verification, run the required Power Pages skills (`/integrate-webapi`, `/create-webroles`,
  `/setup-auth`, `/audit-permissions`, `/add-server-logic`), translate EDM metadata, implement
  routes/components/services, validate via `migration-validator`, and hand off. Reads the
  artifacts produced by `migrate-edm-to-spa-analyze` — requires `analyze-complete.json` to exist
  before starting. Invoked by `migrate-edm-to-spa` (the meta skill) or standalone when the user
  already has an approved plan. Intended for development environments only — this skill deploys,
  activates a public URL, and writes table permissions / web roles / site settings / server logic
  into the target Dataverse tenant.
user-invocable: true
argument-hint: "<target-project-root-or-blank>"
allowed-tools: Read, Write, Edit, Bash, Grep, Glob, AskUserQuestion, Task, TaskCreate, TaskUpdate, TaskList, Skill, mcp__plugin_power-pages_playwright__browser_navigate, mcp__plugin_power-pages_playwright__browser_snapshot, mcp__plugin_power-pages_playwright__browser_click, mcp__plugin_power-pages_playwright__browser_close, mcp__plugin_power-pages_playwright__browser_network_requests, mcp__plugin_power-pages_playwright__browser_console_messages, mcp__plugin_power-pages_playwright__browser_wait_for, mcp__plugin_power-pages_playwright__browser_resize, mcp__plugin_power-pages_playwright__browser_evaluate
model: opus
---

> **Plugin check**: Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/check-version.js"` — if it outputs a message, show it to the user before proceeding.

# Implement EDM-to-SPA Migration

> ## ⚠️ Use a development environment only
>
> This skill creates and modifies live infrastructure in the target Power Platform tenant:
>
> 1. **Scaffolds** a new Power Pages site (Phase 7.1, `/create-site`).
> 2. **Deploys** the SPA build to the tenant (Phase 7.2.b, `/deploy-site`).
> 3. **Activates** the site (Phase 7.2.d, `/activate-site`) — provisions a public `https://<subdomain>.powerappsportals.com` URL bound to the tenant. **Activation is non-reversible.**
> 4. **Writes metadata** to Dataverse (Phase 7.3): table permissions, web roles, site settings, server logic via the required Power Pages skills (`/integrate-webapi`, `/create-webroles`, `/setup-auth`, `/audit-permissions`, `/add-server-logic`).
>
> Point this skill at a **development tenant**. Validate the full migration end-to-end in dev before considering production. Production migrations should be planned separately with an explicit rollout strategy, backups, and approval from whoever owns the target tenant.

Phase 7-9 of the EDM-to-SPA migration workflow. Reads the approved plan and canonical model that `migrate-edm-to-spa-analyze` produced, scaffolds and deploys the SPA, activates it, migrates EDM metadata via the required Power Pages skills, implements routes/components/services, validates the result, and hands off.

## Core Principles

- **Approved plan in, working SPA out**: this skill writes SPA files — `migrate-edm-to-spa-analyze` must already have approved the plan.
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

Phase numbering continues from `migrate-edm-to-spa-analyze` (which owns Phases 1-6) so cross-references in agent definitions and reference docs remain stable. Phase 0 is a precondition check unique to this sub-skill.

---

## Phase 0: Confirm Prerequisites and Target Environment

Before doing anything else, do both: confirm `migrate-edm-to-spa-analyze` finished and the user approved the plan, **and** confirm the user is targeting a development environment for the writes this phase performs.

### 0.1 Confirm analyze artifacts

1. Look for `<TARGET_PROJECT_ROOT>/migration-artifacts/analyze-complete.json`. If `$ARGUMENTS` is empty, search the user's current working directory and any subdirectory likely to contain `migration-artifacts/` (one level deep). If multiple candidates exist, ask the user which to use.
2. Parse the file. Reject if `status !== "approved"`. Reload `targetProjectRoot`, `targetFramework`, `edmSourceRoot`, `liveSiteUrl`, `planPath` from it.
3. Confirm the canonical model and verification checklist exist:
   - `migration-artifacts/canonical-site-model.json`
   - `migration-artifacts/migration-verification-checklist.json`
   - `migration-artifacts/static-analysis.json`
   - `migration-artifacts/forms-inventory.json`
   - `migration-artifacts/runtime-discovery.json` (or `status: "skipped"`)
4. If any required artifact is missing or `analyze-complete.json` is absent, stop and ask the user to run `migrate-edm-to-spa-analyze` first.

### 0.2 Confirm target environment is dev

Display the target-environment warning to the user **as a chat message** (not only as a SKILL.md callout — the user will not see the SKILL.md). Use this text verbatim:

> ⚠️ **Use a development environment only.** The next phases will:
>
> 1. Scaffold a new Power Pages site in the target tenant (`/create-site`).
> 2. Build and deploy the SPA to the tenant (`/deploy-site`) — this writes `.powerpages-site/` metadata.
> 3. Activate the site (`/activate-site`) — provisions a public `https://<subdomain>.powerappsportals.com` URL and **permanently binds the subdomain to the tenant**. Activation is non-reversible.
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

## Phase 7: Create the SPA, Deploy, Activate, Migrate Metadata, Then Implement

**Goal:** Scaffold via `/create-site`, deploy once to hydrate `.powerpages-site/`, activate for the live URL, translate EDM metadata via the required Power Pages skills, then implement routes/components/services that reference the migrated metadata.

The order is mandatory:

1. **`/create-site`** (Phase 7.1) — scaffold the SPA project. Never hand-roll.
2. **Hydrate `.powerpages-site/`** (Phase 7.2.a–c) — deploy once via `/deploy-site` unless `/create-site`'s own Phase 8 already deployed.
3. **Activate** (Phase 7.2.d) — `/activate-site` provisions the live URL Phase 8's validator needs.
4. **Required Skill Invocations manifest** (Phase 7.3) — `/integrate-webapi`, `/create-webroles`, `/setup-auth`, `/audit-permissions`, `/add-server-logic` run **here**, never deferred to "Recommended Next Skills".
5. **Routes + layout + components + content + services** (Phases 7.4–7.6) reference the migrated metadata, never the other way around.
6. **Build and commit milestones** (Phase 7.7).

Do not implement SPA code that depends on EDM metadata until that metadata has been migrated. Do not declare the migration complete until every required-skill manifest entry is `completed`, `not-required`, or `user-deferred` (which downgrades the migration to `Partial`).

### Actions

#### 7.1 Scaffold the SPA with `/create-site`

If `TARGET_PROJECT_ROOT` does not yet contain a Power Pages code site, invoke `/create-site` first. Pass `TARGET_FRAMEWORK`, the target location, and the full `DESIGN_DATA` (aesthetic, mood, derived typography, motion, palette, plus the optional `weblinkLayout` captured in analyze Phase 6.1.b when the source has `weblink-sets/`) captured by `migrate-edm-to-spa-analyze` in its Phase 6.1. Because the analyze skill asks the same two design questions `/create-site` asks (aesthetic + mood) using the same reference doc, the create-site agent should reuse the captured answers rather than re-prompt.

Let `/create-site` run its normal discovery flow only for: site name and purpose, audience, framework confirmation, feature direction. If it would otherwise re-ask aesthetic/mood/palette/typography, supply the captured `DESIGN_DATA` so the user does not make the same choices twice. Do not bypass `/create-site` by manually copying templates.

If the target already exists, verify `powerpages.config.json`, `package.json`, framework/router, source directory and build command. If it exists and is not empty, ask before overwriting.

**EDM-source images take precedence over stock photography.** `/create-site`'s Phase 5.3 may source Unsplash imagery for hero/card/background slots. Treat any such images as placeholders only — Phase 7.6 will replace them with EDM-source assets from the canonical model's `assets[]`.

**Continuation after `/create-site` returns.** Treat `/create-site`'s "Scaffolding complete" summary as interim, not terminal:

- Keep the Phase 7 task `in_progress`. Phase 7 spans 7.1–7.7; `/create-site` ending is not the end.
- Do not pause or wait for the user. Immediately proceed to Phase 7.2 in the same turn.
- Validate the scaffold first (`package.json`, Power Pages config, non-empty source dir). If `/create-site` reported a failure or the scaffold is broken, stop and surface the failed prerequisite — do not deploy a broken scaffold.
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

- Treat `/deploy-site`'s `Deployment verified. .powerpages-site/ is fully hydrated with N files ...` line as an *interim* return — the start of Phase 7.2.d, not the end of Phase 7.
- Keep the Phase 7 task `in_progress`. The metadata-translation, required-skill invocations, route/component implementation, and milestone commits in 7.3–7.7 are still pending.
- **Immediately proceed to Phase 7.2.d in the same turn** — no "ready to continue?" prompt, no task-completion flip. Ending the turn here with Phase 7.3 still pending is a stall, not a checkpoint.
- Ignore background shells `/create-site` left running (e.g., `npm run dev`); they are intentional and do not block downstream work.

If the agent does end the turn here (context pressure, unrelated stop), the resume entrypoint is **Phase 7.2.d — Activate the migrated site**, not "re-deploy".

##### 7.2.d Activate the migrated site

Activation provisions a `https://<subdomain>.powerappsportals.com` URL that Phase 8's `migration-validator` needs for live-site checks. It does **not** on its own change `websiteaccess.yml` / table-permission gating — the existing access records still control visibility.

Run once per migration. On re-runs, skip if `migration-completion-status.json#/activation/status === "succeeded"`, the website record's `adx_websiteurl` is already set, or `pac` reports the site as provisioned. In any of those cases write/refresh the `activation` block with `status: "already-activated"` and the recorded `liveUrl`, then go to 7.3.

Otherwise:

1. Ask the user (activation is non-reversible — the subdomain is bound to the tenant on success):

   | Header | Question | Options |
   |--------|----------|---------|
   | Activate now? | The first deployment hydrated `.powerpages-site/` but the site has no live URL yet. Activation gives it a `https://<subdomain>.powerappsportals.com` URL — required so Phase 8's validator can verify the migrated SPA against the live site. Activation does **not** publish the site to anonymous internet users on its own. Activate now via `/activate-site`? | Activate now (Recommended), Defer activation (Phase 8 live-site checks run as `deferred`), Cancel migration |

   > **⚠️** Activation provisions a public `*.powerappsportals.com` URL and **permanently binds the subdomain to the target tenant** — this cannot be undone. Confirm with the user that they are activating in a **development environment** and the chosen subdomain is acceptable as a long-lived dev URL.

   - **Defer activation** → record `activation: { status: "user-deferred", reason: "..." }` in `migration-completion-status.json`, add a `category: "activation-deferred"` row to `migration-gap-log.md`, continue to 7.3. Final status will be `Partial`, never `Complete`.
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

4. If `/activate-site` fails (auth, subdomain conflict, provisioning timeout), surface the diagnostic and ask whether to retry, change the subdomain, or defer. Do **not** silently proceed to 7.3 with a failed activation.

#### 7.3 Migrate EDM Metadata and Invoke Required Skills

Translate EDM metadata into the hydrated `.powerpages-site/` **and invoke every Power Pages skill needed for parity with the source**. This runs after Phase 7.2 (metadata folder hydrated) and before 7.4–7.6 (so SPA code can reference the migrated metadata). Required-skill invocation is **not optional and is not deferred to Phase 9**.

##### 7.3.a Build the Required Skill Invocations manifest

Derive a manifest from the approved migration plan and save it to `migration-artifacts/required-skill-invocations.json`. The trigger conditions, input context, expected evidence, and invocation order are in:

> Reference: `${CLAUDE_PLUGIN_ROOT}/skills/migrate-edm-to-spa/references/required-skill-manifest.md`

For each candidate skill, evaluate its trigger condition against the plan. If the trigger fires, the skill is `required`; if not, the manifest still records the skill with `status: "not-required"` and a short reason so the migration considered every skill explicitly.

Each required entry records `skill`, `trigger` (the specific plan evidence that satisfied the trigger), `inputContext`, `expectedEvidence[]`, `order`, `notes`, and `status: "required"` initially.

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

> Reference: `${CLAUDE_PLUGIN_ROOT}/skills/migrate-edm-to-spa/references/pac-edm-structure.md#edm-aggregate-to-spa-granular-mapping`

Before writing metadata, save `migration-artifacts/metadata-translation-plan.md`: for each EDM aggregate record list source file, source record name, target `.powerpages-site` folder, target file name, action (`create` / `update` / `skip` / `gap`), ID strategy, confidence. If a metadata item cannot be confidently mapped, log it in `migration-gap-log.md` instead of copying silently. Preserve the hydrated SPA baseline files created by `/deploy-site`; only add or update what the approved plan requires. Never bypass table permissions or imply client-side role checks enforce data security.

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

> Reference: `${CLAUDE_PLUGIN_ROOT}/skills/migrate-edm-to-spa/references/edm-to-spa-patterns.md#mandatory-route-families`

None of those families may be left as a `manualGap`, placeholder shell, or "next step". If a mandatory family is implied by the source but missing from the plan's `ROUTES_DATA[]`, treat that as unexpected drift: update the plan, then implement.

#### 7.6 Implement Components, Content, and Services

Map web page copy/summaries → page components; web templates → reusable layout/section components; content snippets → constants/content modules; web files → public or imported assets; custom CSS → framework/project styles. Do not leave placeholder-only pages for routes in scope.

**What MUST NOT appear in any rendered SPA output** — scaffold/phase labels, migration-internal metadata as content, sensitive identifiers (tenant ID, client ID, OIDC params), phase-by-phase commentary as page copy, TODO strings in production-shape components. Full rules and rationale:

> Reference: `${CLAUDE_PLUGIN_ROOT}/skills/migrate-edm-to-spa/references/spa-output-rules.md`

**Reuse EDM-source assets** (images, icons, downloadables) — walk the canonical model's `assets[]`, copy each binary to `public/<original-filename>` (or `src/assets/<original-filename>` for bundler-imported), rewrite references in migrated content, replace stock placeholders left by `/create-site`, reuse logo/favicon, record reuse in `migration-traceability.json`. Full procedure:

> Reference: `${CLAUDE_PLUGIN_ROOT}/skills/migrate-edm-to-spa/references/edm-to-spa-patterns.md#reuse-edm-source-assets`

**Implement the profile route** (when the source had `/profile`) — identity from `/setup-auth`, contact read/update from `/integrate-webapi` respecting `Contact`-scoped permissions and narrowed `Webapi/contact/fields`, fallback to read-only when write is not permitted, portal-only sub-features stay as gaps, wire the route into AppShell navigation. Full procedure:

> Reference: `${CLAUDE_PLUGIN_ROOT}/skills/migrate-edm-to-spa/references/edm-to-spa-patterns.md#profile-route-implementation`

**Render weblink sets in the layout the user approved.** When the source has `weblink-sets/` records (primary nav, footer columns, sidebar "quick links" widgets, related-content menus), build one SPA link-list component per source set. Each component reads its layout from `DESIGN_DATA.weblinkLayout`:

- `"horizontal"` — render the links as an inline row / pill bar (e.g., flex container with `gap`, `flex-wrap`, no list bullets). Suits primary nav and footer-link row layouts.
- `"vertical"` — render the links as a stacked list (e.g., column of `<a>` elements or `<ul>` with vertical spacing). Suits sidebar widgets and footer columns.
- `null` — the source had no weblink sets; do not build a link-list component.

Use the link order from the source YAML (`weblinkset.yml`'s `weblinks[]` array). Preserve link text and target URL verbatim — these are content, not configuration. If a link points to an EDM web-page that has been migrated, rewrite the target URL to the new SPA route from `ROUTES_DATA[]`; if it points off-site, keep the absolute URL.

The single `weblinkLayout` value applies to every set. If the user wants different layouts per set, the analyze SKILL's Phase 6.5 revise loop is the place to capture that — never invent per-set variations here.

Wire SPA services against migrated metadata: tables with Web API integration call into services scaffolded by `/integrate-webapi`; server logic calls into endpoints created by `/add-server-logic`; auth/role-aware UI uses patterns from `/setup-auth` and roles from `/create-webroles`. If any of those was user-deferred, leave typed stubs and migration notes — never invent client-side substitutes. Never bypass table permissions or imply that client-side role checks enforce data security.

#### 7.7 Build and Commit Milestones

Run `npm run build` after meaningful implementation chunks. Fix build errors before proceeding. Commit after significant milestones when working in a git repository.

### Output

- SPA scaffolded, deployed, activated; `migration-completion-status.json#/activation` recorded.
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

#### 8.3 Browser-Verify the SPA

Start the dev server and navigate with Playwright. Capture the dev-server URL — Phase 8.4 passes it to the validator so its behavioural gates can drive the real UI. Confirm at a minimum:

- All in-scope routes render meaningful content.
- Navigation matches the approved route model — **and every authenticated/role-gated route is reachable from a visible `<Link>` / `<NavLink>` in the AppShell**, not just by typing the URL.
- No critical console errors.
- Data/API placeholders, pending work, and manual gaps are visibly and accurately documented.
- The Sign-in button, when present, actually navigates to the identity provider when clicked (not just renders the right label).
- Auth-gated or role-gated routes behave per the approved scope.

Leave the dev server running until Phase 8.4 completes — the validator's behavioural gates (`gate-route-reachability`, `gate-signin-click-redirect`, `gate-form-submission-shape`) need it alive. If the dev server cannot stay up (port conflict, build failure that the build step missed), those gates are marked `deferred` and the migration cannot finish `Complete`.

#### 8.4 Invoke the Migration Validator (Completion Gate)

Delegate the completion verdict to `migration-validator`. The validator is **independent of the agent that performed the migration** — it reads the checklist (built in Phase 5) and the manifest (built in Phase 7.3), walks every entry against the SPA filesystem and the running dev server, and produces the final verdict.

The validator's full Task prompt template (with `LIVE_SITE_URL`, `DEV_SERVER_URL`, and the synthetic gate-* check list) is in:

> Reference: `${CLAUDE_PLUGIN_ROOT}/skills/migrate-edm-to-spa/references/agent-prompts.md#validator-prompt`

Use the `Task` tool to invoke `${CLAUDE_PLUGIN_ROOT}/agents/migration-validator.md` with the prompt from the reference, substituting `TARGET_PROJECT_ROOT`, the checklist/manifest/`.powerpages-site/` paths, the dev-server URL from 8.3, and `LIVE_SITE_URL` from `migration-completion-status.json#/activation/liveUrl` (or `none` if activation was deferred/failed).

When the validator returns, read `migration-completion-status.json`:

- **`Blocked`** — do not advance to Phase 9. Surface blockers, return to the indicated phase, re-run the validator.
- **`Partial`** — continue to 8.5 and Phase 9. Phase 9 must report `Partial` and list every `deferred` check.
- **`Complete`** — continue with a clean handoff.

Never describe the migration as `Complete` while `migration-completion-status.json` says otherwise — the validator's verdict is the single source of truth.

#### 8.5 Compare Against EDM Evidence (Drift Summary)

The validator already emitted drift checks (`runtime-route-missing`, `runtime-endpoint-missing`, `stock-image-remaining`) in `migration-validation-report.json`. Summarize them for the user in a short table — do not re-do the comparison:

| EDM route/behavior | SPA result | Status | Notes |
|--------------------|------------|--------|-------|
| `<route>` | `<route/component>` | Match / Changed / Gap | `<from validator report>` |

Classify drift as `match` / `intentional change` / `manual gap` / `unexpected drift`. Any `unexpected drift` means the validator flagged `fail` — return to 7.6 (or earlier) instead of accepting it silently.

#### 8.6 Save Verification Artifacts

Save `migration-verification-report.md` (human-readable rollup of the drift summary) and the updated `migration-gap-log.md`. Per-check validator findings live in `migration-validation-report.md`.

### Output

- Build verified. Browser verification complete.
- Validator verdict written to `migration-completion-status.json` and consumed by Phase 9.
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
| Activation in 7.2.d failed and the user wants to retry after fixing the cause | `/activate-site` |
| Runtime parity should be re-verified against the live activated site | `/test-site` |
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
2. **Phase 7.2.d**: Activation via `/activate-site`. Required for live-site validator checks; deferring downgrades to `Partial`.
3. **Phase 7.3**: For each required skill in the manifest, confirm via `AskUserQuestion` only if the user wants to defer. Deferral downgrades to `Partial`; never silently skip.
4. **Phase 8**: Whether unexpected drift should be fixed, accepted, or moved to manual gaps. The Phase 8.4 validator must return `Complete` or `Partial` before Phase 9 can hand off.

---

## Progress Tracking

| Task subject | activeForm | Description |
|--------------|------------|-------------|
| Phase 0: Confirm analyze artifacts | Phase 0: Confirming inputs | Read `analyze-complete.json`, verify canonical model + checklist + agent artifacts exist |
| Phase 7: Migrate SPA implementation | Phase 7: Migrating SPA | `/create-site`, deploy to hydrate `.powerpages-site`, `/activate-site` for the live URL, build and execute the Required Skill Invocations manifest inline, then implement mandatory routes (including profile), components, services, translated metadata, assets, traceability |
| Phase 8: Verify migration | Phase 8: Verifying migration | Build + browser-verify + delegate the completion gate to `migration-validator`; summarize drift |
| Phase 9: Summarize migration | Phase 9: Summarizing | Record skill usage, present the validator's verdict, recommend post-migration next skills |

---

## Test Prompts

| Scenario | Example |
|----------|---------|
| Standard handoff | "Implement the migration plan in `./my-spa/migration-artifacts/`." |
| Resume after defer | "Resume the migration in `./my-spa/` — I'm ready to run `/setup-auth` now." |
| Standalone (already analyzed) | "I already approved the plan yesterday in `./my-spa/`; run the implement skill." |
