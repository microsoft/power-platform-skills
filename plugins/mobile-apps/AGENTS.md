# AGENTS.md — Code Apps Native Plugin (Preview)

This file provides guidance to AI Agents when working with the **mobile-app** plugin.

> **Status:** v0 — 26 skills + 5 agents authored. The latest Expo standalone template snapshot is bundled under `template/`. Read [README.md](./README.md) for the command list.

## What This Plugin Is

A plugin for building and deploying **Power Apps code apps that run as native mobile + web apps** using Expo + React Native + TypeScript. It supports both real Power Platform apps and mock-backed UX prototypes that can later graduate in place. Real apps connect through the standard `npx power-apps add-data-source` workflow.

The Expo template snapshot is distributed with this plugin under `template/` and published from [`plugins/mobile-apps/template`](https://github.com/microsoft/power-platform-skills/tree/main/plugins/mobile-apps/template). `/create-mobile-app` and `/create-mobile-prototype` run in fresh-template working-directory mode: the user starts in an installed template folder, then the skill validates and prepares it.

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
agents/                        ← native-app-planner, data-model-architect, screen-planner, screen-builder
shared/                        ← shared-instructions, references, samples, memory-bank template
skills/                        ← /create-mobile-app, /create-mobile-prototype, /prototype-to-real-app, /sync-from-plan, /design-react-native-app, /add-*, ...
scripts/                       ← shared helpers, including validate-mobile-files.js for skill-owned changed-file validation
hooks/                         ← Validator implementations invoked explicitly by mobile workflows
```

## Template source

The Expo template snapshot ships bundled inside this plugin at `template/`. It is synced from `pa-wrap-tools-1` / `pa-wrap-tools` `main`, `templates/expo-app-standalone/`. Neither creation skill silently copies the bundled template over a user's folder; both expect a fresh installed template working directory and apply mode-specific preparation there:

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
2. **Native code is allowlist-bounded; pure JavaScript is app-scoped.** Expo modules and packages that ship native source, a podspec, codegen configuration, an Expo module/config plugin, or platform projects must already exist in `template/package.json`. The rewrap binary is built from a pre-built base, so adding those packages to an app cannot add their native code. Do not classify a package from its name alone: a `react-native-*` package can still be pure JavaScript. For an explicit library request or an approved use case that benefits from an established library, the planner may select a compatible pure-JavaScript package, pin it in the app's `package.json`, and install it before builders use it; no Android/iOS rebuild is required. Do not bundle optional libraries such as `react-native-calendars` in the base template. Follow [`shared/references/javascript-dependency-planning.md`](shared/references/javascript-dependency-planning.md). `expo-haptics` remains runtime-banned even if it appears in a future template (see [`agents/screen-builder.md`](agents/screen-builder.md) HARD RULE). The native boundary and reconciliation rule are in [`skills/add-native/SKILL.md`](skills/add-native/SKILL.md).
3. **Fresh-template mode** — `/create-mobile-app` and `/create-mobile-prototype` validate and prepare an existing fresh Expo standalone template working directory. Do not silently copy the bundled `template/` snapshot over the user's folder.
4. **Safety guardrails** — Confirm before deploys, before global installs, before edits outside the project root.
5. **Memory bank** — Persist `memory-bank.md` in the project root.
6. **Approval mode** — Real-app planning keeps section approvals for data, native APIs/connectors, and screens. Prototype planning produces the complete editable plan first and uses one consolidated local approval that cannot authorize external mutation. When plan-mode tools are absent, use the textual foreground fallback in `shared/references/host-capability-adapter.md`; never report a host limitation as a project filesystem failure.
7. **Persisted plan + experience contract** — Write `native-app-plan.md` (Mermaid ER + per-screen specs + native capabilities matrix) as the human-reviewable source of truth. Before data or screen planning, persist `.tmp/experience-contract.json` from the brief; it defines audience, primary job, content model, primary surface, asset policy, entry mode, first viewport, motifs, forbidden defaults, visual character, and prompt-evidence spans. `screen-planner` derives `.tmp/experience-screen-contract.json` with canonical primary composition, an ordered complete key flow, and runtime anchors plus `.tmp/experience-foundation-contract.json` with 2-5 reusable motif components. After design and data intent are available, `compile-screen-build-pack.js` writes `.tmp/screen-build-pack.json`, a plan-revision-bound compact execution sheet for builders, mocks, refiner, and validation. It preserves approved navigation, Profile reachability, per-screen data/native intent, Home + complete key-flow canary order, and bounded supporting waves; downstream consumers read it and never mutate it. A screenshot/HTML input is optional; industry terms may refine vocabulary or compliance needs but never select Home composition or a visual preset. Local-first media contracts reject remote placeholders.
8. **CLI compatibility** — Use `npx power-apps ...` for code-app lifecycle and data-source commands. Use `scripts/resolve-environment.js` plus `az` tokens for Dataverse environment URL/tenant discovery and Azure/Entra operations. See [`shared/shared-instructions.md`](./shared/shared-instructions.md).
9. **Agent invocation namespace** — All `Task` invocations of agents in this plugin MUST use the fully-qualified `mobile-app:<agent-name>` form (e.g. `mobile-app:native-app-planner`, `mobile-app:screen-builder`). Bare names like `native-app-planner` return `Agent type 'native-app-planner' not found` because Claude Code namespaces all plugin agents by plugin name.
10. **Plugin isolation** — Do not add `hooks/hooks.json`: Claude loads plugin hooks during unrelated workflows, so a mobile write hook can block Canvas Apps tool calls. Mutating skills follow the changed-file gate in `shared/shared-instructions.md`, and final-artifact agents invoke `scripts/validate-mobile-files.js` directly.
11. **Invocation metadata** — Public entry skills use `user-invocable: true` and remain model-invocable. Bundled implementation helpers use both `user-invocable: false` and `disable-model-invocation: true`; their owner reads `SKILL.md` directly. Hidden standalone workflows such as `assign-offline-profile` and `preview-offline-scope` use `user-invocable: false` without disabling model invocation because no owner reads them directly. Agents use `user-invocable: false` without `disable-model-invocation` so qualified `Task` delegation remains available.
12. **Sub-agent return-status protocol** — Every agent in this plugin (`native-app-planner`, `data-model-architect`, `screen-planner`, `screen-builder`) MUST return a status code as the **literal first line** of its final message. Orchestrators (skills that invoke agents via `Task`) MUST parse the first line and branch:

    | Code | Meaning | Orchestrator action |
    |---|---|---|
    | `DONE` | Completed cleanly | Log and continue |
    | `DONE_WITH_CONCERNS: <list>` | Worked but flagged doubts | Surface to user before next step; record in `memory-bank.md` |
    | `NEEDS_CONTEXT: <missing>` | Cannot proceed without more info | Re-dispatch with the info filled in (cap 2 retries) |
    | `BLOCKED: <reason>` | Hit a hard wall | STOP, escalate to user, never silently retry |

    Hard rules:
    - Status code is the literal first line — no `Status:` prefix, no backticks, no preamble. After it, blank line, then the agent's normal summary.
    - Agents MUST NOT downgrade `BLOCKED` to `DONE_WITH_CONCERNS` to keep the workflow moving — the orchestrator's job is to handle the block, not the agent's.
    - `DONE_WITH_CONCERNS` requires at least one concern. If none, use `DONE`.
    - A low-confidence Product Experience Contract permits one focused clarification about the first user outcome before normal planning resumes. Do not use industry or generic style-picker early-return signals.
    - The canonical orchestrator handler lives in [`skills/create-mobile-app/SKILL.md`](./skills/create-mobile-app/SKILL.md) Step 3.0. Future skills that spawn agents should reference it rather than duplicating the switch.
13. **Lifecycle state** — Mock/real mode lives in `<project>/.mobile-app/state.json` per [`shared/references/lifecycle-state.md`](shared/references/lifecycle-state.md). Conversion uses `prototype → transitioning → dataverse`; only `/sync-from-plan --target-data-mode dataverse` commits the final mode after cleanup and validation. The legacy `.code-apps-native/state.json` path is migration input only.
14. **Prototype execution evidence** — `_prototype_workspace.html` is a derived local maker control surface, not an app preview or planning authority. Automatic design records its mode-owned references, exact bytes, and model-call count in `.tmp/design-execution-evidence.json`. Changed-file validation records phase-aware passing fingerprints. `.mobile-app/metro-session.json` may suggest reuse, but only current foreground terminal output proves Metro readiness. Without native captures, report static validation plus Metro readiness, never visual completion.

## Decisions made

- ✅ Markdown plan with Mermaid remains the planning authority; derived HTML control/preview surfaces never replace it.
- ✅ Real-app planning uses section gates; prototype planning uses one consolidated editable local review.
- ✅ `/edit-app` skill for post-generation app iteration: updates the approved plan delta, applies Dataverse/native/design/screen mutations, verifies, and refreshes preview output. `--plan-only` is the explicit docs-only escape hatch.
- ✅ `/create-mobile-prototype` produces the same approved plan/design/screen quality as real creation, but uses deterministic in-memory CRUD services and connector throw-stubs with no environment, Dataverse, or app-registration call.
- ✅ Prototype offline UX requires explicit connectivity evidence; industry, scanner, capture, or field terms alone do not imply offline readiness.
- ✅ Every prototype includes a reachable local Profile screen, and scanner/camera remains subordinate to the product unless the brief explicitly defines a true single-purpose immersive utility.
- ✅ Typed runtime data and automatic design may run in disjoint lanes after logical data approval, then join before build-pack compilation and TypeScript validation.
- ✅ Home plus every ordered key-flow screen builds and validates before Metro; supporting screens build afterward in bounded waves.
- ✅ `/prototype-to-real-app` converts in place through a resumable lifecycle transaction: archive non-executable prototype approvals, bind environment, live-reconcile schema, replace services/connectors, consume seeds, fail-closed cleanup, restore auth/runtime, then one `/sync-from-plan`.
- ✅ Prototype schema contracts use placeholder `cr_` names and are marked `planningMode: "prototype"`, `executionEligible: false`. Graduation rebases only contract-proven identifiers to the selected publisher prefix and never feeds prototype approval artifacts into the real operation-manifest fast path.
- ✅ Single `/deploy` skill — `npm run build` + `npx power-apps push`; no local native compile, no OTA in v0
- ✅ Connection model: per-environment connections, with platform-specific auth (`expo-msal-intune` on native, `expo-auth-session` on web)
- ✅ Auth: `/create-mobile-app` resolves the tenant from the selected Power Platform environment (`scripts/resolve-environment.js`), writes that tenant to `auth.config.json`, then lets the user paste an app registration client ID, create one from the Power Apps Wrap page and paste it, or skip auth for later. `/set-app-registration-native` is a manual helper for the same Wrap-page + pasted-client-ID flow.
- ✅ `/add-native` v0 scope: camera, location, push, biometrics, secure-store (already in template)
- ✅ Template is supplied as a fresh `pa-wrap-tools/templates/expo-app-standalone` folder before either creation skill runs; users materialize it with `degit`, run `npm install`, then invoke the skill from that folder. Real creation runs `npx power-apps init`; prototype creation installs a reversible local runtime and defers init until graduation.
- ✅ `brand/` directory convention: `/design-system` (Step 6.75) writes `brand/design-system.md` (spec), `brand/tokens.ts` (importable Tamagui tokens), and `brand/design-system.html` (visual gallery). Screen-builders MUST read `brand/design-system.md` if present; `## Negatives` = HARD RULES and `## Product Experience Primitives` materializes the shared contract. `/create-mobile-app` Step 9b imports `brand/tokens.ts` via `skills/design-system/references/tamagui-integration.md`. Projects without `brand/` retain the Product Experience Contract plus semantic aliases; no industry/default-design fallback is allowed.
- ✅ Offline profile creation is **author-only in v0.1** — `/setup-offline-profile` and `/enable-tables-offline` POST `mobileofflineprofile` / `mobileofflineprofileitem` / `mobileofflineprofileitemassociation` to Dataverse and write `offline-profile.json` to the project, but do NOT scaffold offline runtime code (SQLite store, sync engine, write queue) into the generated app. Runtime support is gated on upstream `@microsoft/power-apps-native-host` confirmation.
- ✅ Custom filter mode (`recorddistributioncriteria=3`, `profileitemrule` → `savedquery`) is **deferred to v0.5**. v0.1 supports Related-rows-only / All-records / Organization-rows radio options only.
- ✅ `offline-profile-architect` agent follows the existing `mobile-app:` namespace + status-code protocol (`DONE` / `DONE_WITH_CONCERNS:` / `NEEDS_CONTEXT:` / `BLOCKED:`). Read-only — proposes scope; never mutates Dataverse. Mutation lives in `/setup-offline-profile` after the 3 gates.
- ✅ **Offline profile ↔ schema reconciliation across the lifecycle.** Any schema change (`/add-dataverse`, `/setup-datamodel`, `/edit-app`) reconciles an existing offline profile, and `/deploy` gates the final push on offline coverage. Mechanism: `scripts/offline-profile-delta.js` — a purely LOCAL, no-network diff of `.datamodel-manifest.json` (schema) vs `offline-profile.json` (offline coverage) reporting `missingTables` + new columns; `status` ∈ `no-manifest`/`no-profile`/`in-sync`/`delta`/`error` (exit 0 = ran, 1 = fatal). It is distinct from `verify-offline-profile.js`, which is a Dataverse-network drift check of the snapshot vs the live published profile. Column delta is computed against a per-table `schemaColumns` baseline (all schema columns present at reconciliation time), written by `/setup-offline-profile`, `/add-table-to-offline-profile`, and refreshed by `/edit-offline-profile` — NOT against the curated `selectedColumns`, so deliberate exclusions aren't false-flagged; legacy snapshots without it degrade to table-only delta. The one canonical flow (prompt wording, reconcile ordering, deploy gate/override) lives in [`shared/references/offline-profile-reconciliation.md`](shared/references/offline-profile-reconciliation.md); the four skills reference it rather than duplicating it. Orchestrator-invoked `/add-dataverse` (`--skip-planning`) suppresses its own Step 8.5 so the orchestrator owns reconciliation once.

## Maintaining This File

Once skills exist, keep this file updated with the current skills table and architecture notes for this plugin.
