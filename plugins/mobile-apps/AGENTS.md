# AGENTS.md — Code Apps Native Plugin (Preview)

This file provides guidance to AI Agents when working with the **mobile-app** plugin.

> **Status:** v0.3 — 26 skills + 5 agents authored. The latest Expo standalone template snapshot is bundled under `template/`. Read [README.md](./README.md) for the command list.

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
agents/                        ← native-app-planner, real-app-planner, data-model-architect, screen-planner, screen-builder
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
| `tsconfig.json`: merge `@/` path aliases | `@/components`, `@/data`, `@/hooks`, `@/utils`, `@/tokens`, `@/generated`, `@/native` resolve |

Do not add preparation rewrites for `scheme`, `package`, `bundleIdentifier`, `src/playerConfig.ts`, `fingerprint.config.js`, or `native-runtime.json` unless those files exist in the synced main template.

## Guiding Principles

1. **Domain-first for app data** — Screens and feature hooks depend only on neutral contracts under `src/data/`. Prototype repositories use fixtures; Dataverse/connector adapters may call generated services. No screen imports generated services, fixtures, repositories, or direct Graph/Azure/Dataverse HTTP.
2. **Native code is allowlist-bounded; pure JavaScript is app-scoped.** Expo modules and packages that ship native source, a podspec, codegen configuration, an Expo module/config plugin, or platform projects must already exist in `template/package.json`. The rewrap binary is built from a pre-built base, so adding those packages to an app cannot add their native code. Do not classify a package from its name alone: a `react-native-*` package can still be pure JavaScript. For an explicit library request or an approved use case that benefits from an established library, the planner may select a compatible pure-JavaScript package, pin it in the app's `package.json`, and install it before builders use it; no Android/iOS rebuild is required. Do not bundle optional libraries such as `react-native-calendars` in the base template. Follow [`shared/references/javascript-dependency-planning.md`](shared/references/javascript-dependency-planning.md). `expo-haptics` remains runtime-banned even if it appears in a future template (see [`agents/screen-builder.md`](agents/screen-builder.md) HARD RULE). The native boundary and reconciliation rule are in [`skills/add-native/SKILL.md`](skills/add-native/SKILL.md).
3. **Fresh-template mode** — `/create-mobile-app` and `/create-mobile-prototype` validate and prepare an existing fresh Expo standalone template working directory. Do not silently copy the bundled `template/` snapshot over the user's folder.
4. **Safety guardrails** — Confirm before deploys, before global installs, before edits outside the project root.
5. **Memory bank** — Persist `memory-bank.md` in the project root.
6. **Host-neutral planning** — Nested planning agents return bundles and
specialist draft objects without requiring a host-specific approval UI or a
writable workspace. The foreground workflow alone validates and persists
`native-app-plan.md`, the schema contract, Workflow Journey Contract, screen
contract, and foundation contract, then owns textual checkpoints and approval state. Local prototypes
require one consolidated review that never authorizes external mutation; real
external mutations require a current matching textual receipt. Screen builders
follow the same host-neutral boundary: they return one schema-bound, complete
TSX artifact while the foreground validates and atomically persists only the
target authorized by `.tmp/screen-build-pack.json`; each builder receives only
its compact in-memory work order extracted from the immutable pack revision.
7. **Persisted plan + execution contracts** — Write `native-app-plan.md` as the human-reviewable source of truth. Before planning, the foreground persists `.tmp/experience-contract.json`, `.tmp/context-enrichment-contract.json`, `.tmp/workflow-journey-contract.json`, and `.tmp/mobile-plan-execution-preflight.json` from the confirmed brief and selected template; approval hashes bind them. The planner returns a preliminary graph in bundle version 3; the foreground deterministically resolves Navigation and persists nine fixed artifact slots: plan, Context Enrichment Contract, Workflow Journey Contract, Navigation Contract, neutral domain, optional Dataverse target, schema-v3 screen contract, foundation contract, and execution contract. Prototype mode requires the domain and a null Dataverse artifact. The execution contract preserves every preflight requirement ID and trusted native/dependency/connector fact. `apply-navigation-shell.js` exclusively owns shared Expo layouts. `compile-screen-build-pack.js` writes one revision-bound aggregate containing exact destination/flow ownership, per-screen journey/action state, and domain operations; the foreground extracts a matching compact work order in memory for each builder and never persists per-screen task files. A screenshot/HTML input is optional; industry terms may refine vocabulary or compliance needs but never select Home composition or a visual preset. Local-first media contracts reject remote placeholders.
8. **CLI compatibility** — Use `npx power-apps ...` for code-app lifecycle and data-source commands. Use `scripts/resolve-environment.js` plus `az` tokens for Dataverse environment URL/tenant discovery and Azure/Entra operations. See [`shared/shared-instructions.md`](./shared/shared-instructions.md).
9. **Agent invocation namespace** — All `Task` invocations of agents in this plugin MUST use the fully-qualified `mobile-app:<agent-name>` form (e.g. `mobile-app:native-app-planner`, `mobile-app:screen-builder`). Bare names like `native-app-planner` return `Agent type 'native-app-planner' not found` because Claude Code namespaces all plugin agents by plugin name.
10. **Plugin isolation** — Do not add `hooks/hooks.json`: Claude loads plugin hooks during unrelated workflows, so a mobile write hook can block Canvas Apps tool calls. Mutating skills follow the changed-file gate in `shared/shared-instructions.md`, and final-artifact agents invoke `scripts/validate-mobile-files.js` directly.
11. **Invocation metadata** — Public entry skills use `user-invocable: true` and remain model-invocable. Bundled implementation helpers use both `user-invocable: false` and `disable-model-invocation: true`; their owner reads `SKILL.md` directly. Hidden standalone workflows such as `assign-offline-profile` and `preview-offline-scope` use `user-invocable: false` without disabling model invocation because no owner reads them directly. Agents use `user-invocable: false` without `disable-model-invocation` so qualified `Task` delegation remains available.
12. **Sub-agent return-status protocol** — Every agent in this plugin (`real-app-planner`, `data-model-architect`, `screen-planner`, `screen-builder`) MUST return a status code as the **literal first line** of its final message. The tool-free `native-app-planner` is the sole exception: it returns one raw `prototype-semantic-plan` JSON object whose exact bytes are staged by `stage-prototype-planner-response.js`. Orchestrators (skills that invoke agents via `Task`) MUST parse the first line and branch for all status-protocol agents:

    | Code | Meaning | Orchestrator action |
    |---|---|---|
    | `DONE` | Completed cleanly | Log and continue |
    | `DONE_WITH_CONCERNS: <list>` | Worked but flagged doubts | Surface to user before next step; record in `memory-bank.md` |
    | `NEEDS_USER_APPROVAL: <json>` | A return-only plan bundle is ready for portable textual checkpoints | Stage the returned bundle, resolve Navigation deterministically, validate it, persist only its nine fixed artifact slots (removing null data targets), then present the named draft section and wait for a textual `approve` or edits. `mayAuthorizeExternalMutations` is true only for a current approved real-app receipt. |
    | `NEEDS_CONTEXT: <missing>` | Cannot proceed without more info | Re-dispatch with the info filled in (cap 2 retries) |
    | `BLOCKED: <reason>` | Hit a hard wall | STOP, escalate to user, never silently retry |

    Hard rules:
    - Status code is the literal first line — no `Status:` prefix, no backticks, no preamble. After it, blank line, then the agent's normal summary. `real-app-planner` follows `NEEDS_USER_APPROVAL: <json>` with exactly one fenced `mobile-plan-artifact-bundle`; it does not return paths, approval IDs, or write instructions.
    - `native-app-planner` has no tools, receives one complete inline request, and returns compact semantic JSON only. It never returns Markdown, hashes, final routes/files, copied foreground contracts, or final Navigation. The foreground allows one recorded schema repair, compiles the final bundle deterministically, and never reconstructs either artifact conversationally.
    - Agents MUST NOT downgrade `BLOCKED` to `DONE_WITH_CONCERNS` to keep the workflow moving — the orchestrator's job is to handle the block, not the agent's.
    - Nested planners, data-model architects, and screen planners never write planning artifacts, scratch sections, previews, or checkpoint state. The foreground writes only the eight active planning targets through `scripts/write-plan-artifact-bundle.js` after Navigation resolution and `scripts/validate-plan-artifact-bundle.js` succeed; null domain/schema targets are removed rather than persisted as executable-looking files.
    - Screen builders are also return-only. A successful builder returns exactly
      one fenced `mobile-screen-artifact` JSON object after its status line.
      The foreground stages it at a numeric path, validates the whole wave with
      `scripts/validate-screen-artifact.js`, and persists each result through
      `scripts/write-screen-artifact.js`, passing the foreground-expected
      builder-wave screen ID to both. The writer derives the only target from
      that screen's validated pack entry and rejects screen/route/file
      substitution or a changed skeleton hash.
    - Orchestrators MUST NOT treat `NEEDS_USER_APPROVAL` as `BLOCKED` or silently continue. A revision over the plan, schema, Experience Contract, Workflow Journey Contract, screen contract, or foundation contract invalidates its prior checkpoint state; use `scripts/plan-checkpoints.js --action status` before external mutation and before prototype screen build.
    - `mayAuthorizeExternalMutations` is `false` for every prototype and every unapproved real draft. Only a current approved `create-mobile-app` receipt emits `true`; no external operation may run for any other result.
    - `DONE_WITH_CONCERNS` requires at least one concern. If none, use `DONE`.
    - A low-confidence Product Experience Contract permits one focused clarification about the first user outcome before normal planning resumes. Do not use industry or generic style-picker early-return signals.
    - The canonical orchestrator handler lives in [`skills/create-mobile-app/SKILL.md`](./skills/create-mobile-app/SKILL.md) Step 3.0. Future skills that spawn agents should reference it rather than duplicating the switch.
13. **Lifecycle state** — Repository mode lives in `<project>/.mobile-app/state.json` per [`shared/references/lifecycle-state.md`](shared/references/lifecycle-state.md). Schema version 2 records domain, repository mapping, fixture, and validation revisions. Conversion uses `prototype → transitioning → dataverse`; only passing reconciliation, adapter generation, unchanged-screen proof, and `validate-mobile-app.js --scope all --record` commit the final mode. The legacy `.code-apps-native/state.json` path is migration input only.
14. **Prototype vertical-slice authority** — PR1 semantic plans independently
    declare permanent Home, launch, resume, key-flow entry, product roles,
    durable jobs, bounded flows, and operation-bound capability ownership.
    Generation order cannot select any of them. Prompt-only design loads the
    thin dispatcher plus `automatic-native.md` and zero optional references or
    design model calls. After domain/design join, the single build pack owns a
    native canary containing Home plus the complete critical flow. Builders use
    the existing return-only artifact envelope and atomic writer; supporting
    screens do not fan out in this milestone. Metro may report ready only after
    a current canary receipt and HTTP health response. Performance evidence
    records planner/context bytes and calls without controlling phase flow.

## Decisions made

- ✅ Markdown plan with Mermaid (no HTML rendering)
- ✅ **Host-neutral return-only planning.** Planners return a bundle; the
    foreground validates and atomically persists the four planning artifacts.
    Prototype checkpoints are local review only; a current real-app receipt is
    required before external mutations.
- ✅ **Host-neutral return-only screen waves.** Screen agents produce complete
    one-screen TSX artifacts concurrently without workspace write access; the
    foreground validates each against the immutable build pack and atomically
    persists only its fixed screen target.
- ✅ `/edit-app` skill for post-generation app iteration: updates the approved plan delta, applies Dataverse/native/design/screen mutations, verifies, and refreshes preview output. `--plan-only` is the explicit docs-only escape hatch.
- ✅ `/create-mobile-prototype` produces the same plan/design/screen quality as real creation, but generates neutral models, repository interfaces, TanStack Query hooks, realistic fixtures, and a local adapter under `src/data/` with no environment, Dataverse, or app-registration call.
- ✅ `/prototype-to-real-app` converts in place through a resumable lifecycle transaction: archive non-executable prototype approval, bind environment, live-reconcile the same domain, generate Dataverse/connector repository adapters, optionally seed approved fixtures, restore auth/runtime, and prove screens unchanged.
- ✅ Prototype planning never invents Dataverse names or target decisions. `.tmp/prototype-domain-model.json` remains canonical after graduation; `.tmp/dataverse-repository-mapping.json` binds it to live metadata, and only adapter files import generated services.
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
