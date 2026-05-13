---
name: migrate-edm-to-spa
description: >-
  End-to-end migration of a classic Enhanced Data Model (EDM) Power Pages website to a modern
  static SPA code site. Use when the user wants to migrate EDM to SPA, convert a classic Power
  Pages portal to a React/Vue/Angular/Astro code site, analyze a downloaded PAC website-data
  export, or re-author an existing portal as a client-side Power Pages site. Orchestrates the
  two-skill workflow: `migrate-edm-to-spa-analyze` (Phases 1-6: discover the EDM source, produce
  the canonical model and approval-gated HTML plan) followed by `migrate-edm-to-spa-implement`
  (Phases 7-9: scaffold, deploy, activate, migrate metadata, implement, verify, hand off).
  Intended for development environments only — see the SKILL body for the full safety warning.
user-invocable: true
argument-hint: "<website-id-or-downloaded-site-path>"
allowed-tools: Read, Glob, AskUserQuestion, Skill
model: opus
---

> **Plugin check**: Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/check-version.js"` — if it outputs a message, show it to the user before proceeding.

# Migrate EDM Site to SPA

> ## ⚠️ Use a development environment only
>
> This skill writes to Power Platform environments and provisions live infrastructure. **Do not run it against production tenants** — for either the source EDM site or the target SPA environment.
>
> 1. **Source EDM site (Phase 4 runtime crawl).** The live source site is crawled in your browser. If you choose `submit-synthetic` for the interactions mode, the agent generates synthetic form payloads and submits them — this creates real records (contacts, cases, etc.) against the source's Dataverse.
> 2. **Target environment (Phase 7 implementation).** A new Power Pages site is scaffolded, deployed, and activated. Activation provisions a public `https://<subdomain>.powerappsportals.com` URL bound to the tenant and is non-reversible. The required Power Pages skills (`/integrate-webapi`, `/create-webroles`, `/setup-auth`, `/audit-permissions`, `/add-server-logic`) then write table permissions, web roles, site settings, and server logic into the target.
>
> Validate the full migration end-to-end against a dev tenant before pointing this skill at production.

Top-level entry point for the EDM-to-SPA migration. Orchestrates two sub-skills with a single user-approval checkpoint between them.

| Sub-skill | Phases | Produces |
|-----------|--------|----------|
| [`migrate-edm-to-spa-analyze`](../migrate-edm-to-spa-analyze/SKILL.md) | 1-6: resolve source → pre-flight readiness → static analysis → runtime discovery → canonical model + verification checklist → HTML plan review | `migration-artifacts/` populated, `analyze-complete.json` written on user approval |
| [`migrate-edm-to-spa-implement`](../migrate-edm-to-spa-implement/SKILL.md) | 7-9: `/create-site` → deploy → `/activate-site` → required-skill manifest → routes/components/services → validator → handoff | Working SPA in `TARGET_PROJECT_ROOT`, validator verdict in `migration-completion-status.json` |

Phase numbering is continuous (analyze owns 1-6, implement owns 7-9) so cross-references in agent definitions and reference docs remain stable when sub-skills are invoked standalone.

## Core Principles

- **Single approval gate**: the user reviews and approves the HTML migration plan once, at the end of analyze. The meta skill does not introduce a second approval — it confirms readiness to proceed to implement, then hands off.
- **Standalone-friendly sub-skills**: either sub-skill can be invoked directly when the user already has the right inputs (a prior `analyze-complete.json`, or just an EDM source path). The meta skill is for the common end-to-end flow.
- **Static SPA only**: target frameworks are React, Vue, Angular, Astro.

**Initial request:** $ARGUMENTS

---

## Workflow

### Step 1: Invoke `migrate-edm-to-spa-analyze`

Use the `Skill` tool to run `migrate-edm-to-spa-analyze`, passing `$ARGUMENTS` through verbatim. The analyze skill collects every input the user needs to provide (source mode, framework, target path, live URL, interactions mode, web-role login passes, design direction) and ends with the approval-gated HTML plan.

The analyze skill writes `<TARGET_PROJECT_ROOT>/migration-artifacts/analyze-complete.json` once the user approves the plan. If the user stops or revises indefinitely, the file is not written and this meta skill stops here.

### Step 2: Checkpoint

When the analyze skill returns control, confirm `analyze-complete.json` exists and `status === "approved"`. Read `targetProjectRoot`, `targetFramework`, and `liveSiteUrl` from it so the implement skill can pick them up.

Then ask the user whether to proceed immediately:

| Header | Question | Options |
|--------|----------|---------|
| Ready to implement? | Analysis is complete and the migration plan has been approved (see `<planPath>`). Ready to start the implementation phase now? It will scaffold the SPA via `/create-site`, deploy to hydrate `.powerpages-site/`, activate the site, run the required skills (`/integrate-webapi`, `/create-webroles`, `/setup-auth`, `/audit-permissions`, `/add-server-logic`), implement routes and components, and validate the result. | Start implementation now (Recommended), Stop here — I'll run implement later |

- **Start implementation now** → Step 3.
- **Stop here** → tell the user they can resume by invoking `migrate-edm-to-spa-implement` directly later. Print the `analyze-complete.json` path so they know what to point implement at. Exit.

### Step 3: Invoke `migrate-edm-to-spa-implement`

Use the `Skill` tool to run `migrate-edm-to-spa-implement`, passing `targetProjectRoot` as the argument so implement does not need to search for the artifacts folder. The implement skill drives Phases 7-9 to completion and presents the final summary itself.

When implement returns, the meta skill is done — implement's Phase 9 already presented the migration verdict and recommended next skills. Do not duplicate the summary here.

---

## Standalone Use of Sub-skills

The two sub-skills are designed to work standalone for these scenarios:

| Scenario | Invoke directly |
|----------|-----------------|
| User wants analysis only (e.g., to estimate effort before committing to migration) | `migrate-edm-to-spa-analyze` |
| User wants to revise the plan but not re-run analysis | `migrate-edm-to-spa-analyze` (it detects existing artifacts and offers to resume) |
| User has a previously-approved `analyze-complete.json` and wants to implement now | `migrate-edm-to-spa-implement` |
| User wants to retry a failed implement run without re-doing analysis | `migrate-edm-to-spa-implement` |

The meta skill exists for the common case where the user wants the whole workflow with one command.

---

## Progress Tracking

The meta skill itself does not maintain a phase-level task list — each sub-skill creates its own (`migrate-edm-to-spa-analyze` tracks Phases 1-6; `migrate-edm-to-spa-implement` tracks Phase 0 plus Phases 7-9). The meta skill creates a single task per sub-skill invocation so the user sees the high-level handoff:

| Task subject | activeForm | Description |
|--------------|------------|-------------|
| Analyze the EDM source | Analyzing EDM source | Run `migrate-edm-to-spa-analyze` (Phases 1-6) — produces canonical model, verification checklist, and HTML plan; ends with user approval |
| Implement the migration | Implementing migration | Run `migrate-edm-to-spa-implement` (Phases 7-9) — scaffold/deploy/activate/migrate metadata/implement routes/verify/hand off |

---

## Test Prompts

| Scenario | Example |
|----------|---------|
| Fresh download, end-to-end | "Migrate the EDM portal with website ID `dfcd9f05-5305-458a-a82b-1ce97f05f535` to a React SPA." |
| Existing source, end-to-end | "I already downloaded the portal to `./legacy-site`; migrate it to Vue." |
| Analyze only | (invoke `migrate-edm-to-spa-analyze` directly) |
| Implement only | (invoke `migrate-edm-to-spa-implement` directly after a prior analyze) |
