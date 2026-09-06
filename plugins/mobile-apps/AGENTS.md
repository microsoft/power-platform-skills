# AGENTS.md — Code Apps Native Plugin (Preview)

This file provides guidance to AI Agents when working with the **mobile-app** plugin.

> **Status:** v0 — 24 skills + 2 bounded agents authored. The latest Expo standalone template snapshot is bundled under `template/`. Read [README.md](./README.md) for the command list.

## What This Plugin Is

A plugin for building and deploying **Power Apps code apps that run as native mobile + web apps** using Expo + React Native + TypeScript. Connects to Power Platform via connectors using the standard `npx power-apps add-data-source` workflow.

The Expo template snapshot is distributed with this plugin under `template/` and published from [`plugins/mobile-apps/template`](https://github.com/microsoft/power-platform-skills/tree/main/plugins/mobile-apps/template). `/create-mobile-app` runs in fresh-template working-directory mode: the user starts in an installed template folder, then the skill validates and prepares it.

## Local Development

```bash
claude --plugin-dir /path/to/power-platform-skills/plugins/mobile-apps
```

## Architecture

```
.plugin/plugin.json            ← Open Plugins metadata
.claude-plugin/plugin.json     ← Legacy metadata mirror
AGENTS.md                      ← This file
README.md                      ← Plugin overview
agents/                        ← return-only data-model architect + one-screen builder
shared/                        ← shared-instructions, references, samples, memory-bank template
skills/                        ← /create-mobile-app, /add-dataverse, /add-connector, /add-native, ...
scripts/                       ← shared helpers, including validate-mobile-files.js and bundled telemetry
hooks/                         ← Telemetry start hooks plus validators invoked explicitly by mobile workflows
```

## Template source

The Expo template snapshot ships bundled inside this plugin at `template/`. It is synced from `pa-wrap-tools-1` / `pa-wrap-tools` `main`, `templates/expo-app-standalone/`. `/create-mobile-app` does not silently copy the bundled template over a user's folder; it expects a fresh installed template working directory and applies these preparation edits there:

| Edit | Purpose |
|---|---|
| `app.config.js`: `name`, `slug` | Replace `'Power Apps Dev Player'` / `'powerapps-dev-player'` with wizard answers |
| `package.json`: `name` | Replace `'powerapps-dev-app'` with the app slug |
| Delete `power.config.json` | `npx power-apps init` regenerates for the user's environment |
| Reset `src/generated/` + `src/hooks/` | Remove any example stubs — `npx power-apps add-data-source` repopulates |
| `app/_layout.tsx`: add `tamaguiConfig` + `defaultTheme` props | Screens render under brand tokens, not upstream defaults |
| `tsconfig.json`: merge `@/` path aliases | `@/components`, `@/hooks`, `@/utils`, `@/tokens`, `@/generated`, `@/native` resolve |

Do not add preparation rewrites for `scheme`, `package`, `bundleIdentifier`, `src/playerConfig.ts`, `fingerprint.config.js`, or `native-runtime.json` unless those files exist in the synced main template.

## Guiding Principles

1. **Connector-first for data** — All Power Platform data access goes through connectors and generated services in `src/generated/`. No direct Graph / Azure REST calls.
2. **Native code is allowlist-bounded; pure JavaScript is app-scoped.** Expo modules and packages that ship native source, a podspec, codegen configuration, an Expo module/config plugin, or platform projects must already exist in `template/package.json`. The rewrap binary is built from a pre-built base, so adding those packages to an app cannot add their native code. Do not classify a package from its name alone: a `react-native-*` package can still be pure JavaScript. For an explicit library request or an approved use case that benefits from an established library, foreground planning may select a compatible pure-JavaScript package, pin it in the app's `package.json`, and install it before builders use it; no Android/iOS rebuild is required. Do not bundle optional libraries such as `react-native-calendars` in the base template. Follow [`shared/references/javascript-dependency-planning.md`](shared/references/javascript-dependency-planning.md). `expo-haptics` remains runtime-banned even if it appears in a future template (see [`agents/screen-builder.md`](agents/screen-builder.md) HARD RULE). The native boundary and reconciliation rule are in [`skills/add-native/SKILL.md`](skills/add-native/SKILL.md).
3. **Fresh-template mode** — `/create-mobile-app` validates and prepares an existing fresh Expo standalone template working directory. Do not silently copy the bundled `template/` snapshot over the user's folder.
4. **Safety guardrails** — Confirm before deploys, before global installs, before edits outside the project root.
5. **Memory bank** — Persist `memory-bank.md` in the project root.
6. **Four-gate Product Experience flow** — Gate 1 approves UX DNA, Product
   Scope, and data model; Gate 2 approves architecture/capabilities/connectors;
   Gate 3 approves the materialized design and interactive HTML journey
   preview; Gate 4 confirms implementation. Graph/spec compilation does not
  create extra user gates. `_build_plan.html` is a separate live execution
  companion opened only after Step 2c `proceed`; it derives from canonical
  contracts, uses revision-checked pre-Dataverse data-model edits, and never
  replaces the at-most-three-frame `_plan_preview.html` design review.
7. **Persisted semantic contracts** — `native-app-plan.md` is the human plan.
  Deterministic execution uses Product Experience, Product Scope, persistence,
  Workflow Journey, and compiled screen-build-pack JSON sidecars under `.tmp/`.
8. **CLI compatibility** — Use `npx power-apps ...` for code-app lifecycle and data-source commands. Use `scripts/resolve-environment.js` plus `az` tokens for Dataverse environment URL/tenant discovery and Azure/Entra operations. See [`shared/shared-instructions-cli.md`](./shared/shared-instructions-cli.md).
9. **Two bounded child-agent boundaries** — Questions, approvals, environment access, files, mutations, deterministic compilation, validation, and recovery stay in foreground skills. `mobile-app:data-model-architect` is a tool-free return-only semantic worker over one sealed compact evidence packet. `mobile-app:screen-builder` implements exactly one sealed screen work order. Neither child may spawn another agent or widen its supplied context.
10. **Plugin isolation** — `hooks/hooks.json` is limited to fail-open telemetry start hooks. They never validate, mutate, or block tool calls. Do not add write/validation hooks: mutating skills follow the changed-file gate in `shared/shared-instructions-core.md`, and final-artifact agents invoke `scripts/validate-mobile-files.js` directly.
11. **Invocation metadata** — Public entry skills use `user-invocable: true` and remain model-invocable. Bundled implementation helpers use both `user-invocable: false` and `disable-model-invocation: true`; their owner reads `SKILL.md` directly. Hidden standalone workflows such as `assign-offline-profile` and `preview-offline-scope` use `user-invocable: false` without disabling model invocation because no owner reads them directly. Both agents use `user-invocable: false`; the data-model architect has an empty tool list, while the screen builder receives only the tools required by its selected channel.
12. **Child-agent return protocol** — The data-model architect always uses the run-scoped return-only proposal envelope in [`agents/data-model-architect.md`](agents/data-model-architect.md). Screen direct-write returns use a literal first-line status; screen return-only responses use the delimiter envelope in [`agents/screen-builder.md`](agents/screen-builder.md). Foreground orchestrators parse the selected contract and branch:

    | Code | Meaning | Orchestrator action |
    |---|---|---|
    | `DONE` | Completed cleanly | Log and continue |
    | `DONE_WITH_CONCERNS: <list>` | Worked but flagged doubts | Surface to user before next step; record in `memory-bank.md` |
    | `NEEDS_CONTEXT: <missing>` | Cannot proceed without more info | Re-dispatch with the info filled in (cap 2 retries) |
    | `BLOCKED: <reason>` | Hit a hard wall | STOP, escalate to user, never silently retry |

    Hard rules:
    - Status code is the literal first line — no `Status:` prefix, no backticks, no preamble. After it, blank line, then the agent's normal summary.
    - The child MUST NOT downgrade `BLOCKED` to `DONE_WITH_CONCERNS` to keep the workflow moving — the foreground's job is to handle the block, not the child’s.
    - `DONE_WITH_CONCERNS` requires at least one concern. If none, use `DONE`.
    - `DESIGN_VIBE_REQUESTED:` is accepted only as a legacy compatibility
      signal and is normalized into the Step 6.75 design-system flow.
      `INDUSTRY_CONFIRM_REQUESTED:` is obsolete; industry is vocabulary only
      and cannot choose product scope or visual direction.
    - The canonical channel, retry, and per-screen foreground fallback handler lives in [`skills/create-mobile-app/references/phase-11-screens.md`](./skills/create-mobile-app/references/phase-11-screens.md). Future skills that invoke the builder should reference it rather than duplicating the protocol.
## Telemetry

Mobile Apps bundles the canonical stdlib-only telemetry helpers from the repo-root `shared/telemetry/lib` at `scripts/lib/telemetry/lib`. Edit the shared source first, then refresh this physical copy in the same change; never copy another plugin's `ikey.json` or resolver.

- **Start-only lifecycle:** `UserPromptSubmit` records explicit slash-command starts and `PreToolUse(Skill)` records programmatic Skill-tool starts; both may fire for one visible slash command. `UserPromptSubmit` payloads differ by host — Claude Code passes the raw `/mobile-app:<skill>` text, Copilot CLI pre-expands it to a `<skill-context name="<skill>">` wrapper and emits no Skill pre-tool event — so both shapes must stay recognized or manual runs go uncaptured. Do not add `skill_completed`, duration, outcome, or persisted correlation state: Power Pages deliberately removed that flow because the hook boundary does not prove the workflow completed.
- **Coverage and attribution:** `scripts/lib/mobileapp-hook-utils.js` discovers every user- or model-invocable top-level skill, including `telemetry`. Direct-read helpers with `disable-model-invocation: true` are not independently invoked and are excluded. Bare and `mobile-app:`-qualified names are both attributed; explicitly foreign plugin namespaces are excluded.
- **Session correlation:** Stable host session ids pass through unchanged. Copilot CLI reports a transient `call_*` id to nested-agent hooks, so `resolveCopilotRootSessionId` in `scripts/lib/mobile-telemetry.js` resolves it to the unique recent UUID session whose local `~/.copilot/session-state/<uuid>/events.jsonl` structurally owns that `agentId`, reading only a bounded tail. Keep host-specific quirks contained in that one function. The verified root is cached as one atomic 30-minute alias file per hashed call id so fresh hook processes reuse it; aliases hold no prompts, cwd, or tool arguments and are never transmitted. Missing, stale, malformed, or ambiguous state fails open to the original id, and Claude Code and Codex ids are not rewritten.
- **Privacy:** Mobile Apps sends no prompt, tool input, cwd, path, URL, credential, username, hostname, Dataverse org/tenant ID, or Entra object ID. The dynamic `eventInfo` contains only `invocationSource` (`prompt` or `pretool`) and a random per-project `appInstanceId` (or `null` outside a prepared project).
- **Destination and controls:** Mobile-owned `scripts/lib/mobile-telemetry-dispatcher.js` maps shared events to the Power Apps `event` stream configured by `scripts/lib/telemetry/ikey.json`. The repository `disabled` switch is a hard-off; user and CI opt-outs suppress transmission while preserving the local diagnostic mirror.
- **CI:** Every Mobile Apps test job must set `POWER_PLATFORM_SKILLS_TELEMETRY_MOBILE_APP_OPTOUT=1`. The single positive wire test clears that backstop only in its child process and routes the event to `POWER_PLATFORM_SKILLS_FAKE_HTTPS`; all other positive tests remain opted out and exercise the local mirror.

## Decisions made

- ✅ Markdown plan with Mermaid plus a model-authored, deterministically
  validated interactive HTML experience preview before implementation
- ✅ Product Experience Compiler with adaptive screen/table budgets,
  workflow journeys, classified assumptions, and revision-bound build packs
- ✅ **Four user gates** owned by the foreground workflow; graph/spec passes are
  internal compiler phases
- ✅ `/edit-app` skill for post-generation app iteration: updates the approved plan delta, applies Dataverse/native/design/screen mutations, verifies, and refreshes preview output. `--plan-only` is the explicit docs-only escape hatch.
- ✅ Single `/deploy` skill — `npm run build` + `npx power-apps push`; no local native compile, no OTA in v0
- ✅ Connection model: per-environment connections, with platform-specific auth (`expo-msal-intune` on native, `expo-auth-session` on web)
- ✅ Auth: `/create-mobile-app` resolves the tenant from the selected Power Platform environment (`scripts/resolve-environment.js`), writes that tenant to `auth.config.json`, then lets the user paste an app registration client ID, create one from the Power Apps Wrap page and paste it, or skip auth for later. `/set-app-registration-native` is a manual helper for the same Wrap-page + pasted-client-ID flow.
- ✅ `/add-native` v0 scope: camera, location, push, biometrics, secure-store (already in template)
- ✅ Template is supplied as a fresh `pa-wrap-tools/templates/expo-app-standalone` folder before `/create-mobile-app` runs; users materialize it with `degit`, run `npm install`, then invoke the skill from that folder. The skill validates/prepares the folder and runs `npx power-apps init`.
- ✅ `brand/` directory convention: `/design-system` (Step 6.75) always writes
  `brand/design-system.md` and `brand/tokens.ts`, and writes
  `_plan_preview.html` in the same design-system model execution from generated
  tokens, signature components, and the compiled primary journey. The
  deterministic renderer writes only `_plan_preview.structural.html`. No-brand
  paths materialize Product Experience deliberately; inspection presets are
  explicit-only.
- ✅ Offline selection is one explicit post-materialization question. `/create-mobile-app` never infers it from requirements, prompt keywords, connectivity, Product Experience, or architecture. For `dataverse` and `mixed`, Step 8.85 asks once; Yes invokes `/setup-offline-profile --orchestrated-create`, and No records `status: not-applicable`. Connector/local modes skip the Dataverse-only question. Product Scope, Journey, screen packs, persistence contracts, and the Build Plan never own offline selection or `states.offline`. The template's existing `@microsoft/power-apps-native-host` / `@microsoft/power-apps-native-offline` integration owns connection, queued, syncing, failed, retry, and conflict UX.
- ✅ Offline profile creation is **Dataverse profile authoring only** — after an affirmative choice, `/setup-offline-profile` and `/enable-tables-offline` POST `mobileofflineprofile` / `mobileofflineprofileitem` / `mobileofflineprofileitemassociation` to Dataverse and write `offline-profile.json` for the template host integration. They do not own product screens, routes, jobs, domain tables, or a parallel runtime. Connector/local modes never create a Mobile Offline Profile.
- ✅ Custom filter mode (`recorddistributioncriteria=3`, `profileitemrule` → `savedquery`) is **deferred to v0.5**. v0.1 supports Related-rows-only / All-records / Organization-rows radio options only.
- ✅ `/setup-offline-profile` designs row scope, relationships, selected columns, and sync frequency in the foreground, then owns approval and Dataverse mutation.
- ✅ **Offline profile ↔ schema reconciliation across the lifecycle.** Any schema change (`/add-dataverse`, `/setup-datamodel`, `/edit-app`) reconciles an existing offline profile, and `/deploy` gates the final push on offline coverage. Mechanism: `scripts/offline-profile-delta.js` — a purely LOCAL, no-network diff of `.datamodel-manifest.json` (schema) vs `offline-profile.json` (offline coverage) reporting `missingTables` + new columns; `status` ∈ `no-manifest`/`no-profile`/`in-sync`/`delta`/`error` (exit 0 = ran, 1 = fatal). It is distinct from `verify-offline-profile.js`, which is a Dataverse-network drift check of the snapshot vs the live published profile. Column delta is computed against a per-table `schemaColumns` baseline (all schema columns present at reconciliation time), written by `/setup-offline-profile`, `/add-table-to-offline-profile`, and refreshed by `/edit-offline-profile` — NOT against the curated `selectedColumns`, so deliberate exclusions aren't false-flagged; legacy snapshots without it degrade to table-only delta. The one canonical flow (prompt wording, reconcile ordering, deploy gate/override) lives in [`shared/references/offline-profile-reconciliation.md`](shared/references/offline-profile-reconciliation.md); the four skills reference it rather than duplicating it. Orchestrator-invoked `/add-dataverse` (`--skip-planning`) suppresses its own Step 8.5 so the orchestrator owns reconciliation once.

## Maintaining This File

Once skills exist, keep this file updated with the current skills table and architecture notes for this plugin.
