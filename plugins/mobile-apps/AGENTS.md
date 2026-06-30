# AGENTS.md — Code Apps Native Plugin (Preview)

This file provides guidance to AI Agents when working with the **mobile-app** plugin.

> **Status:** v0 — 23 skills + 5 agents authored. The latest Expo standalone template snapshot is bundled under `template/`. Read [README.md](./README.md) for the command list.

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
agents/                        ← native-app-planner, data-model-architect, screen-planner, screen-builder
shared/                        ← shared-instructions, references, samples, memory-bank template
skills/                        ← /create-mobile-app, /add-dataverse, /add-connector, /add-native, ...
scripts/                       ← dataverse-request.js helper used by /add-dataverse + open-wrap-url.js helper used by /open-wrap-url
hooks/                         ← PostToolUse validators
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
2. **Native APIs via Expo modules + RN libraries — allowlist-bounded.** Native capabilities backed by Expo modules and any RN UI/runtime libraries with native assumptions are limited to modules actually shipped by `template/package.json` from the synced `pa-wrap-tools` main template. The rewrap binary is built from a pre-built base, so the runtime knows ONLY about modules the upstream template includes. Do not propose, install, or import modules absent from that package list (notably `expo-notifications` and RN native libraries not already present). Calendar management views may use `react-native-calendars` only when it is present in the template/project `package.json`; otherwise planner/builders must fall back to timeline/list UI or block with a template-update request. `expo-haptics` remains runtime-banned even if it appears in a future template (see [`agents/screen-builder.md`](agents/screen-builder.md) HARD RULE). The canonical list and reconciliation rule are in [`skills/add-native/SKILL.md`](skills/add-native/SKILL.md).
3. **Fresh-template mode** — `/create-mobile-app` validates and prepares an existing fresh Expo standalone template working directory. Do not silently copy the bundled `template/` snapshot over the user's folder.
4. **Safety guardrails** — Confirm before deploys, before global installs, before edits outside the project root.
5. **Memory bank** — Persist `memory-bank.md` in the project root.
6. **Plan mode** — Enter plan mode before multi-file work; per-section approval gates (data model → native APIs → screen plan).
7. **Persisted plan** — Write `native-app-plan.md` (Mermaid ER + per-screen specs + native capabilities matrix) as the source of truth that sub-skills `Read`.
8. **CLI compatibility** — Use `npx power-apps ...` for code-app lifecycle and data-source commands. Use `scripts/resolve-environment.js` plus `az` tokens for Dataverse environment URL/tenant discovery and Azure/Entra operations. See [`shared/shared-instructions.md`](./shared/shared-instructions.md).
9. **Agent invocation namespace** — All `Task` invocations of agents in this plugin MUST use the fully-qualified `mobile-app:<agent-name>` form (e.g. `mobile-app:native-app-planner`, `mobile-app:screen-builder`). Bare names like `native-app-planner` return `Agent type 'native-app-planner' not found` because Claude Code namespaces all plugin agents by plugin name.
10. **Sub-agent return-status protocol** — Every agent in this plugin (`native-app-planner`, `data-model-architect`, `screen-planner`, `screen-builder`) MUST return a status code as the **literal first line** of its final message. Orchestrators (skills that invoke agents via `Task`) MUST parse the first line and branch:

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
    - Special early-return signals (`INDUSTRY_CONFIRM_REQUESTED:`, `DESIGN_VIBE_REQUESTED:`) pre-date this protocol and remain in effect — they are special-cased "ask the user one question and re-spawn me" handoffs, not terminal returns.
    - The canonical orchestrator handler lives in [`skills/create-mobile-app/SKILL.md`](./skills/create-mobile-app/SKILL.md) Step 3.0. Future skills that spawn agents should reference it rather than duplicating the switch.
11. **Web target works for free** — `expo start --web` uses `expo-auth-session` PKCE flow. Native modules need `Platform.OS` branching when web doesn't support them.

## Decisions made

- ✅ Markdown plan with Mermaid (no HTML rendering)
- ✅ **Per-section approval gates** in the planner (data model → native APIs → screen plan)
- ✅ `/edit-app` skill for post-generation app iteration: updates the approved plan delta, applies Dataverse/native/design/screen mutations, verifies, and refreshes preview output. `--plan-only` is the explicit docs-only escape hatch.
- ✅ Single `/deploy` skill — `npm run build` + `npx power-apps push`; no local native compile, no OTA in v0
- ✅ Connection model: per-environment connections, with platform-specific auth (`expo-msal-intune` on native, `expo-auth-session` on web)
- ✅ Auth: `/create-mobile-app` resolves the tenant from the selected Power Platform environment (`scripts/resolve-environment.js`), writes that tenant to `auth.config.json`, then lets the user paste an app registration client ID, create one from the Power Apps Wrap page and paste it, or skip auth for later. `/set-app-registration-native` is a manual helper for the same Wrap-page + pasted-client-ID flow.
- ✅ `/add-native` v0 scope: camera, location, push, biometrics, secure-store (already in template)
- ✅ Template is supplied as a fresh `pa-wrap-tools/templates/expo-app-standalone` folder before `/create-mobile-app` runs; users materialize it with `degit`, run `npm install`, then invoke the skill from that folder. The skill validates/prepares the folder and runs `npx power-apps init`.
- ✅ `brand/` directory convention: `/design-system` (Step 6.75) writes `brand/design-system.md` (spec), `brand/tokens.ts` (importable Tamagui tokens), and `brand/design-system.html` (visual gallery). Screen-builders MUST read `brand/design-system.md` if present; `## Negatives` = HARD RULES. `/create-mobile-app` Step 9b imports `brand/tokens.ts` via `skills/design-system/references/tamagui-integration.md`. Projects without `brand/` fall back to `## Design Direction` only — no breakage.
- ✅ Offline profile creation is **author-only in v0.1** — `/setup-offline-profile` and `/enable-tables-offline` POST `mobileofflineprofile` / `mobileofflineprofileitem` / `mobileofflineprofileitemassociation` to Dataverse and write `offline-profile.json` to the project, but do NOT scaffold offline runtime code (SQLite store, sync engine, write queue) into the generated app. Runtime support is gated on upstream `@microsoft/power-apps-native-host` confirmation.
- ✅ Custom filter mode (`recorddistributioncriteria=3`, `profileitemrule` → `savedquery`) is **deferred to v0.5**. v0.1 supports Related-rows-only / All-records / Organization-rows radio options only.
- ✅ `offline-profile-architect` agent follows the existing `mobile-app:` namespace + status-code protocol (`DONE` / `DONE_WITH_CONCERNS:` / `NEEDS_CONTEXT:` / `BLOCKED:`). Read-only — proposes scope; never mutates Dataverse. Mutation lives in `/setup-offline-profile` after the 3 gates.

## Maintaining This File

Once skills exist, keep this file updated with the current skills table and architecture notes for this plugin.
