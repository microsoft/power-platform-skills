---
name: migrate-traditional-site-to-spa
description: >-
  End-to-end migration of a classic Enhanced Data Model (EDM) Power Pages website to a modern
  static SPA code site. Use when the user wants to migrate EDM to SPA, convert a classic Power
  Pages portal to a React/Vue/Angular/Astro code site, analyze a downloaded PAC website-data
  export, or re-author an existing portal as a client-side Power Pages site. Orchestrates the
  two-skill workflow: `migrate-traditional-site-to-spa-analyze` (Phases 1-6: discover the EDM source, produce
  the canonical model and approval-gated HTML plan) followed by `migrate-traditional-site-to-spa-implement`
  (Phases 7-9: scaffold, deploy, activate, migrate metadata, implement, verify, hand off).
  Intended for development environments only — see the SKILL body for the full safety warning.
user-invocable: true
argument-hint: "<website-id-or-downloaded-site-path>"
allowed-tools: Read, Glob, AskUserQuestion, Skill
model: opus
---

> **Plugin check**: Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/check-version.js"` — if it outputs a message, show it to the user before proceeding.

# Migrate EDM Site to SPA

> ## 🎯 Recommended run mode
>
> This skill runs a ~25-sub-step migration that the agent must follow to completion — partial runs (skipping activation, passing the wrong URL to the validator, demoting `/test-site` to "next steps") have been observed when the agent declared itself done early. To prevent that, invoke this skill inside a goal-tracking mode:
>
> - **Claude Code or Codex** — invoke with `/goal`. Goal mode keeps the agent on-target until the stated goal is met; the agent cannot self-declare "done" until the goal is satisfied.
> - **GitHub Copilot** — turn on autopilot mode.
>
> Without one of these modes, the agent may stop after analyze, after scaffold, or after deploy without finishing the rest of the workflow — the migration will report as `Partial` or `Blocked` for reasons unrelated to the source's quality.

> ## ⚠️ Use a development environment only
>
> This skill writes to Power Platform environments and provisions live infrastructure. **Do not run it against production tenants** — for either the source EDM site or the target SPA environment.
>
> 1. **Source EDM site (Phase 4 runtime crawl).** The live source site is crawled in your browser. If you choose `submit-synthetic` for the interactions mode, the agent generates synthetic form payloads and submits them — this creates real records (contacts, cases, etc.) against the source's Dataverse.
> 2. **Target environment (Phase 7 implementation).** A new Power Pages site is scaffolded, deployed, and activated. Activation provisions a `https://<subdomain>.powerappsportals.com` URL bound to the tenant and is non-reversible. **The site stays private until you open it up** — anonymous visitors still hit a sign-in / 403 until `websiteaccess.yml`, table permissions, and web roles allow anonymous access. The required Power Pages skills (`/integrate-webapi`, `/create-webroles`, `/setup-auth`, `/audit-permissions`, `/add-server-logic`) then write table permissions, web roles, site settings, and server logic into the target.
>
> Validate the full migration end-to-end against a dev tenant before pointing this skill at production.

Top-level entry point for the EDM-to-SPA migration. Orchestrates two sub-skills with a single user-approval checkpoint between them.

| Sub-skill | Phases | Produces |
|-----------|--------|----------|
| [`migrate-traditional-site-to-spa-analyze`](../migrate-traditional-site-to-spa-analyze/SKILL.md) | 1-6: resolve source → pre-flight readiness → static analysis → runtime discovery → canonical model + verification checklist → HTML plan review → capture implement-now preference | `migration-artifacts/` populated, `analyze-complete.json` written on user approval (includes `proceedToImplement` flag) |
| [`migrate-traditional-site-to-spa-implement`](../migrate-traditional-site-to-spa-implement/SKILL.md) | 7-9: `/create-site` → first `/deploy-site` (hydrate `.powerpages-site/`) → required-skill manifest → routes/components/services → second `/deploy-site` (publish migrated SPA) → `/activate-site` → validator → handoff | Working SPA in `TARGET_PROJECT_ROOT`, validator verdict in `migration-completion-status.json` |

Phase numbering is continuous (analyze owns 1-6, implement owns 7-9) so cross-references in agent definitions and reference docs remain stable when sub-skills are invoked standalone.

## Core Principles

- **Single approval gate**: the user reviews and approves the HTML migration plan once, at the end of analyze, and at the same time tells analyze whether to chain into implement. The meta skill does not introduce a second prompt — it reads the `proceedToImplement` flag from `analyze-complete.json` and dispatches accordingly. This keeps the handoff deterministic across sub-skill boundaries.
- **Standalone-friendly sub-skills**: either sub-skill can be invoked directly when the user already has the right inputs (a prior `analyze-complete.json`, or just an EDM source path). The meta skill is for the common end-to-end flow.
- **Static SPA only**: target frameworks are React, Vue, Angular, Astro.

**Initial request:** $ARGUMENTS

---

## Workflow

### Step 1: Invoke `migrate-traditional-site-to-spa-analyze`

Use the `Skill` tool to run `migrate-traditional-site-to-spa-analyze`, passing `$ARGUMENTS` through verbatim. The analyze skill collects every input the user needs to provide (source mode, framework, target path, live URL, interactions mode, web-role login passes, design direction), presents the approval-gated HTML plan, and — once the user approves — asks whether to chain into implement immediately. Both decisions are persisted to `<TARGET_PROJECT_ROOT>/migration-artifacts/analyze-complete.json` before analyze returns. If the user stops without approving the plan, that file is not written and the workflow naturally terminates at Step 2's "file missing" branch.

### Step 2: Read the Handoff Signal — Do Not Re-Prompt

**This step is required even though the analyze sub-skill emitted a "control returned" message. Do not treat that message as the end of the workflow.** Continue immediately.

Read `<TARGET_PROJECT_ROOT>/migration-artifacts/analyze-complete.json`. If you didn't track `TARGET_PROJECT_ROOT` from the analyze invocation, scan the current working directory (and one level of subdirectories) for `migration-artifacts/analyze-complete.json`. If multiple candidates exist, prefer the most recently modified.

Dispatch deterministically based on the file's contents — **do not ask the user for confirmation again**, they already answered while analyze was running:

| File state | Action |
|------------|--------|
| File missing, or `status !== "approved"` | Analysis didn't complete or wasn't approved. Tell the user and exit. They can re-invoke `migrate-traditional-site-to-spa` to retry. |
| `status === "approved"` and `proceedToImplement === false` | The user approved analysis but asked to pause. Print the `analyze-complete.json` path and remind them they can resume later by invoking `migrate-traditional-site-to-spa-implement` directly. Exit. |
| `status === "approved"` and `proceedToImplement === true` | Go straight to Step 3. No further prompts. |

### Step 3: Invoke `migrate-traditional-site-to-spa-implement`

Use the `Skill` tool to run `migrate-traditional-site-to-spa-implement`, passing `targetProjectRoot` (from `analyze-complete.json`) as the argument so implement does not need to search for the artifacts folder. The implement skill drives Phases 7-9 to completion and presents the final summary itself.

When implement returns, the meta skill is done — implement's Phase 9 already presented the migration verdict and recommended next skills. Do not duplicate the summary here.

---

## Standalone Use of Sub-skills

The two sub-skills are designed to work standalone for these scenarios:

| Scenario | Invoke directly |
|----------|-----------------|
| User wants analysis only (e.g., to estimate effort before committing to migration) | `migrate-traditional-site-to-spa-analyze` |
| User wants to revise the plan but not re-run analysis | `migrate-traditional-site-to-spa-analyze` (it detects existing artifacts and offers to resume) |
| User has a previously-approved `analyze-complete.json` and wants to implement now | `migrate-traditional-site-to-spa-implement` |
| User wants to retry a failed implement run without re-doing analysis | `migrate-traditional-site-to-spa-implement` |

The meta skill exists for the common case where the user wants the whole workflow with one command.

---

## Progress Tracking

The meta skill itself does not maintain a phase-level task list — each sub-skill creates its own (`migrate-traditional-site-to-spa-analyze` tracks Phases 1-6; `migrate-traditional-site-to-spa-implement` tracks Phase 0 plus Phases 7-9). The meta skill creates a single task per sub-skill invocation so the user sees the high-level handoff:

| Task subject | activeForm | Description |
|--------------|------------|-------------|
| Analyze the EDM source | Analyzing EDM source | Run `migrate-traditional-site-to-spa-analyze` (Phases 1-6) — produces canonical model, verification checklist, and HTML plan; ends with user approval |
| Implement the migration | Implementing migration | Run `migrate-traditional-site-to-spa-implement` (Phases 7-9) — scaffold/deploy/activate/migrate metadata/implement routes/verify/hand off |

---

## Test Prompts

| Scenario | Example |
|----------|---------|
| Fresh download, end-to-end | "Migrate the EDM portal with website ID `dfcd9f05-5305-458a-a82b-1ce97f05f535` to a React SPA." |
| Existing source, end-to-end | "I already downloaded the portal to `./legacy-site`; migrate it to Vue." |
| Analyze only | (invoke `migrate-traditional-site-to-spa-analyze` directly) |
| Implement only | (invoke `migrate-traditional-site-to-spa-implement` directly after a prior analyze) |
