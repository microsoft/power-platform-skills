# AGENTS.md — Code Apps Native Plugin (Preview)

This file provides guidance to AI Agents when working with the **mobile-app** plugin.

> **Status:** v0 — 36 skills + 5 agents authored. The latest Expo standalone template snapshot is bundled under `template/`. Read [README.md](./README.md) for the command list.

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
scripts/                       ← shared helpers, including validate-mobile-files.js and bundled telemetry
hooks/                         ← Telemetry start hooks plus validators invoked explicitly by mobile workflows
```

## Template source

The Expo template snapshot ships bundled inside this plugin at `template/`. It is synced from `microsoft/power-platform-skills` `main`, `plugins/mobile-apps/template/`. `/create-mobile-app` does not silently copy the bundled template over a user's folder; it expects a fresh installed template working directory and applies these preparation edits there:

| Edit | Purpose |
|---|---|
| `app.config.js`: `name`, `slug` | Replace `'Power Apps Dev Player'` / `'powerapps-dev-player'` with wizard answers |
| `package.json`: `name` | Replace `'powerapps-dev-app'` with the app slug |
| Remove an empty placeholder `power.config.json` | Preserve populated environment configuration; `npx power-apps init` creates a missing file |
| Remove legacy example hooks and query-client files | Preserve every artifact under `src/generated/` |
| `app/_layout.tsx`: add `tamaguiConfig` + `defaultTheme` | Use host light/dark defaults until generated brand themes are explicitly wired |
| `tsconfig.json`: verify the host base | Package shims and `@/` aliases remain centralized in the native host |

Do not add preparation rewrites for `scheme`, `package`, `bundleIdentifier`, `src/playerConfig.ts`, `fingerprint.config.js`, or `native-runtime.json` unless those files exist in the synced main template.

## Guiding Principles

1. **Connector-first for data** — All Power Platform data access goes through connectors and generated services in `src/generated/`. No direct Graph / Azure REST calls.
2. **Native code is allowlist-bounded; pure JavaScript is app-scoped.** Expo modules and packages that ship native source, a podspec, codegen configuration, an Expo module/config plugin, or platform projects must already exist in `template/package.json`. The rewrap binary is built from a pre-built base, so adding those packages to an app cannot add their native code. Push notifications additionally require the complete `expo-notifications` + React Native Firebase App/Messaging stack and route through `/add-push-notifications`; package presence alone is not runtime proof. Do not classify a package from its name alone: a `react-native-*` package can still be pure JavaScript. For an explicit library request or an approved use case that benefits from an established library, the planner may select a compatible pure-JavaScript package, pin it in the app's `package.json`, and install it before builders use it; no Android/iOS rebuild is required. Do not bundle optional libraries such as `react-native-calendars` in the base template. Follow [`shared/references/javascript-dependency-planning.md`](shared/references/javascript-dependency-planning.md). `expo-haptics` remains runtime-banned even if it appears in a future template (see [`agents/screen-builder.md`](agents/screen-builder.md) HARD RULE). The native boundary and reconciliation rule are in [`skills/add-native/SKILL.md`](skills/add-native/SKILL.md).
3. **Fresh-template mode** — `/create-mobile-app` validates and prepares an existing fresh Expo standalone template working directory. Do not silently copy the bundled `template/` snapshot over the user's folder.
4. **Safety guardrails** — Confirm before deploys, before global installs, before edits outside the project root.
5. **Memory bank** — Persist `memory-bank.md` in the project root.
6. **Plan mode** — Enter plan mode before multi-file work; per-section approval gates (data model → native APIs → screen plan).
7. **Persisted plan** — Write `native-app-plan.md` (Mermaid ER + per-screen specs + native capabilities matrix) as the source of truth that sub-skills `Read`.
8. **Tooling compatibility** — Use `npx power-apps ...` for code-app lifecycle and data-source commands, FlowAgent for Power Automate mutation/read-back, Firebase MCP for `/setup-fcm`, gcloud MCP for `/setup-push-wif`, and Azure MCP for the documented bounded read-back/settings surfaces in push sender-auth workflows. The documented tested stable MCP baselines are Firebase MCP package `firebase-tools` 15.27.0 (`15.28.1` is main/unpublished), gcloud MCP 0.5.3, and Azure MCP GA 2.0.5. In this plugin, Azure MCP coverage is limited to documented read-back/settings surfaces; RBAC mutations, Function provisioning/deployment/auth/managed identity, Entra resource work, and secret-safe writes remain explicit `az` gaps alongside narrow local identity/token exceptions in [`shared/shared-instructions.md`](./shared/shared-instructions.md). Microsoft Learn MCP is the authoritative source for Microsoft-platform docs.
9. **Agent invocation namespace** — All `Task` invocations of agents in this plugin MUST use the fully-qualified `mobile-app:<agent-name>` form (e.g. `mobile-app:native-app-planner`, `mobile-app:screen-builder`). Bare names like `native-app-planner` return `Agent type 'native-app-planner' not found` because Claude Code namespaces all plugin agents by plugin name.
10. **Plugin isolation** — `hooks/hooks.json` is limited to fail-open telemetry start hooks. They never validate, mutate, or block tool calls. Do not add write/validation hooks: mutating skills follow the changed-file gate in `shared/shared-instructions.md`, and final-artifact agents invoke `scripts/validate-mobile-files.js` directly.
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
    - Special early-return signals (`INDUSTRY_CONFIRM_REQUESTED:`, `DESIGN_VIBE_REQUESTED:`) pre-date this protocol and remain in effect — they are special-cased "ask the user one question and re-spawn me" handoffs, not terminal returns.
    - The canonical orchestrator handler lives in [`skills/create-mobile-app/SKILL.md`](./skills/create-mobile-app/SKILL.md) Step 3.0. Future skills that spawn agents should reference it rather than duplicating the switch.
## Telemetry

Mobile Apps bundles the canonical stdlib-only telemetry helpers from the repo-root `shared/telemetry/lib` at `scripts/lib/telemetry/lib`. Edit the shared source first, then refresh this physical copy in the same change; never copy another plugin's `ikey.json` or resolver.

- **Lifecycle:** `UserPromptSubmit` records explicit slash-command starts and `PreToolUse(Skill)` records programmatic Skill-tool starts; both may fire for one visible slash command. `UserPromptSubmit` payloads differ by host — Claude Code passes the raw `/mobile-app:<skill>` text, Copilot CLI pre-expands it to a `<skill-context name="<skill>">` wrapper and emits no Skill pre-tool event — so both shapes must stay recognized or manual runs go uncaptured. Marked workflow boundaries emit explicit checkpoints through `scripts/emit-telemetry-checkpoint.js`; do not broaden hook matchers to observe commands. Every tracked operational skill has checkpoints; the `telemetry` preference skill is intentionally exempt because changing the preference can suppress one side of its own checkpoint lifecycle. Do not infer `skill_completed`, duration, or outcome from hook boundaries.
- **Coverage and attribution:** `scripts/lib/mobileapp-hook-utils.js` discovers every user- or model-invocable top-level skill, including `telemetry`. Direct-read helpers with `disable-model-invocation: true` are not independently invoked and are excluded. Bare and `mobile-app:`-qualified names are both attributed; explicitly foreign plugin namespaces are excluded.
- **Session correlation:** Stable host session ids pass through unchanged. Copilot CLI reports a transient `call_*` id to nested-agent hooks, so `resolveCopilotRootSessionId` in `scripts/lib/mobile-telemetry.js` resolves it to the unique recent UUID session whose local `~/.copilot/session-state/<uuid>/events.jsonl` structurally owns that `agentId`, reading only a bounded tail. Keep host-specific quirks contained in that one function. The verified root is cached as one atomic 30-minute alias file per hashed call id so fresh hook processes reuse it; aliases hold no prompts, cwd, or tool arguments and are never transmitted. Missing, stale, malformed, or ambiguous state fails open to the original id, and Claude Code and Codex ids are not rewritten.
- **Privacy:** Mobile Apps sends no prompt, tool input, cwd, path, URL, credential, username, hostname, Dataverse org/tenant ID, or Entra object ID. The dynamic `eventInfo` contains only `invocationSource` (`prompt`, `pretool`, or `checkpoint`), a random per-project `appInstanceId` (or `null` outside a prepared project), and optional author-defined checkpoint `additionalInfo` validated as `snake_case` with a 64-character limit.
- **Destination and controls:** Mobile-owned `scripts/lib/mobile-telemetry-dispatcher.js` maps shared events to the Power Apps `event` stream configured by `scripts/lib/telemetry/ikey.json`. The repository `disabled` switch is a hard-off; user and CI opt-outs suppress transmission while preserving the local diagnostic mirror.
- **CI:** Every Mobile Apps test job must set `POWER_PLATFORM_SKILLS_TELEMETRY_MOBILE_APP_OPTOUT=1`. The single positive wire test clears that backstop only in its child process and routes the event to `POWER_PLATFORM_SKILLS_FAKE_HTTPS`; all other positive tests remain opted out and exercise the local mirror.

## Decisions made

- ✅ Markdown plan with Mermaid (no HTML rendering)
- ✅ **Per-section approval gates** in the planner (data model → native APIs → screen plan)
- ✅ `/edit-app` skill for post-generation app iteration: updates the approved plan delta, applies Dataverse/native/design/screen mutations, verifies, and refreshes preview output. `--plan-only` is the explicit docs-only escape hatch.
- ✅ `/deploy` remains the Power Platform web-bundle path (`npm run build` +
  `npx power-apps push`). Native push builds route to `/build-android` or
  `/build-ios`; `/deploy` does not run `expo run:ios`/`expo run:android`.
- ✅ Connection model: per-environment connections, with platform-specific auth (`expo-msal-intune` on native, `expo-auth-session` on web)
- ✅ Auth: `/create-mobile-app` resolves the tenant from the selected Power Platform environment (`scripts/resolve-environment.js`), writes that tenant to `auth.config.json`, then lets the user paste an app registration client ID, create one from the Power Apps Wrap page and paste it, or skip auth for later. `/set-app-registration-native` is a manual helper for the same Wrap-page + pasted-client-ID flow.
- ✅ `/add-native` v0 scope: camera, location, push, biometrics, secure-store (already in template)
- ✅ Template is supplied as a fresh `microsoft/power-platform-skills/plugins/mobile-apps/template#main` folder before `/create-mobile-app` runs; users materialize it with `degit`, run `npm install`, then invoke the skill from that folder. The skill validates/prepares the folder and runs `npx power-apps init`.
- ✅ Push notification architecture: `expo-notifications` for consent/presentation/responses, React Native Firebase Messaging for Android+iOS FCM topics, lowercase-canonical Entra OID while signed in, exact `allUsers` while signed out, Expo Router for validated deep links. Client-managed OID topics are explicitly not an authorization boundary.
- ✅ Push cloud setup is **official MCP-first**: `/setup-fcm` owns Firebase project/app selection and SDK config retrieval through the vendor-official Firebase MCP only. `/setup-push-wif` separately requires gcloud MCP for Google-side WIF operations. No Firebase or gcloud CLI fallback is part of the documented architecture.
- ✅ Firebase native app setup is idempotent by exact Android package name and exact iOS bundle identifier. One exact match is reused automatically; safe duplicates require an immutable app-ID selection independently per platform and a fresh identity read-back. Validated client configs live in committed `firebase/` files and are auto-discovered by Expo config. `/setup-apple-ios` provides manual Apple Developer/Xcode guidance with explicit safe confirmations, then `/setup-apns` permits only manual Firebase Console upload of a one-time-downloaded APNs `.p8`; no supported Firebase CLI/Management API upload exists, and agents never handle the key.
- ✅ Push setup has independently resumable owners. The prescribed Android chain
  is `/setup-fcm` → native client integration → sender authentication/flows →
  `/build-android` → `/verify-android-push`. The prescribed iOS chain is
  `/setup-fcm` → `/setup-apple-ios` → `/setup-apns` → native client integration
  → sender authentication/flows → `/build-ios` → `/verify-ios-push`. Existing
  active client integrations may resume at their first unproven stage.
- ✅ Android v1 native distribution is customer-signed direct-test APK only.
  `/build-android` uses the template's `npm run build:android` Wrap path,
  rejects repository-local or symlinked keystores and secret-bearing config,
  never creates a keystore or handles signing passwords, verifies the result
  with `apksigner`, and writes only non-secret artifact identity to
  `android-build.json`. AAB and Google Play distribution are deferred.
- ✅ `/verify-android-push` proves delivery on the exact fresh APK installed on
  a physical Android 8+ device. It covers Android 13+ runtime permission versus
  Android 8-12 behavior, notification channels, foreground/background/
  terminated delivery, exactly-once deep links, lowercase-OID account
  transitions, opt-out, and token refresh or exact-APK re-registration.
  Emulator, Expo Go, Metro/browser preview, Firebase acceptance, and outbox
  `Sent` state are not sufficient evidence.
- ✅ iOS push orchestration adds two independently resumable stages after
  configuration: `/build-ios` creates an exact registered-device
  `development` or `ad-hoc` IPA through `npm run build:ios`, and
  `/verify-ios-push` proves physical delivery. `/add-push-notifications`
  reports native client, APNs, sender auth, flows, wrapped build, and delivery
  verification separately without duplicating their owner workflows.
- ✅ `/setup-apns` ends at **configured, device verification pending** after
  the user confirms the exact Apple Team/identifier/Push setup and completes
  the manual Firebase Console `.p8` upload. Browser automation and
  undocumented upload endpoints are prohibited. Only a complete
  `/verify-ios-push` physical-device matrix may mark APNs physically verified.
- ✅ `/setup-apple-ios` is manual Apple Developer and Xcode guidance. It helps
  the user confirm the exact Team, explicit bundle identifier, Push
  Notifications capability, registered test devices, and development/ad-hoc
  choice, with an explicit safe confirmation before each user-performed
  change. It does not automate Apple configuration or emit a proof contract.
- ✅ `/build-ios` supports registered-device development/ad-hoc scope only. It
  runs a directly confirmed `npm run build:ios` Wrap build after manual
  Apple/Xcode and APNs setup. The user owns signing assets, registered devices,
  profiles, and credentials; the plugin performs safe local validation and
  artifact checks but does not inspect, generate, stage, or attest signing
  assets.
- ✅ `/debug-app` retains Metro and editable JS/TS diagnostics, but wrapped
  Android/iOS notification runtime and delivery failures route to
  `/verify-android-push` or `/verify-ios-push`; stale build or platform
  credential ownership then routes onward to the corresponding build/setup
  owner.
- ✅ WIF is the preferred sender authentication: Power Automate exchanges a dedicated Entra app token through Google Workload Identity Federation, impersonates a least-privilege Firebase sender service account, and calls FCM HTTP v1. `/setup-push-wif` validates/reuses, repairs, or provisions resources through the official gcloud MCP plus Azure MCP read-back/settings coverage, derives trust from observed `iss` plus `appid`/`azp`, proves the full exchange, and writes a non-secret `sender-auth.json`. Azure MCP GA 2.0.5 does not cover the full Azure provisioning surface here, so RBAC mutations, Function provisioning/deployment/auth/managed identity, Entra resource work, secret-safe writes, and narrow local-identity checks remain explicit `az` gaps.
- ✅ Existing service-account integrations use `/setup-push-service-account` only. It validates/reuses or deploys an Entra-protected Azure Function whose managed identity reads the existing Firebase JSON from Azure Key Vault and mints short-lived Google tokens. Azure MCP is limited to covered read-back/settings work (including `role_assignment_list`, `functionapp_get`, `appservice_webapp_get`, `appservice_webapp_deployment_get`, `appservice_webapp_settings_get-appsettings`, `appservice_webapp_settings_update-appsettings`, and diagnostics). The plugin does not expose Azure MCP's `keyvault` namespace because its available secret operations are value-carrying, so RBAC mutations, Function provisioning/deployment/auth/managed identity, Entra resource work, and secret-safe writes remain on the documented `az` gap path. The workflow never creates/downloads a Firebase Admin key or places it in the flow/repository, and this compatibility path still requires the matching Azure/Entra/Key Vault/Function permissions plus a suitable premium Power Automate connector/license.
- ✅ `/create-push-notification-flow` presents three informed sender-auth choices before authoring: WIF is recommended and lists its Entra, Key Vault, Google WIF/service-account/IAM, and premium Power Automate resources; the managed Function compatibility path lists its existing Firebase key, Key Vault, Function hosting/managed identity, Entra protection, connector, RBAC, and licensing requirements; manual/customer-owned setup lists the customer's connector/endpoint, identity, secret store, hosting, monitoring, and licensing ownership. Manual setup has no new skill or `sender-auth.json` mode: the plugin may author producer/outbox work, but never accepts credentials or claims the customer sender is plugin-validated.
- ✅ For managed auth, `/create-push-notification-flow` consumes exactly one fresh validated sender-auth mode and uses FlowAgent for connector discovery and every flow mutation. It creates a queued-outbox sender plus a Dataverse row-created producer by default, resolves `ownerid` through `systemusers.azureactivedirectoryobjectid`, verifies each mutation by reading the live definition back, and defers uncertain Microsoft semantics to Microsoft Learn docs rather than guessed connector contracts. WIF and Function action trees must never coexist as fallbacks. For manual auth, it may create producer/outbox work only and reports the sender as customer-owned and not plugin-validated.
- ✅ The template postinstall compatibility check GUID-validates the native auth account's decoded `claims.oid` and exposes typed `useAuth().user.oid` only when the installed host does not already provide that contract. It never substitutes the MSAL home-account identifier and fails closed on unknown package shapes.
- ✅ `brand/` directory convention: `/design-system` (Step 6.75) writes `brand/design-system.md` (spec), `brand/tokens.ts` (importable Tamagui tokens), and `brand/design-system.html` (visual gallery). Screen-builders MUST read `brand/design-system.md` if present; `## Negatives` = HARD RULES. `/create-mobile-app` Step 9b imports `brand/tokens.ts` via `skills/design-system/references/tamagui-integration.md`. Projects without `brand/` fall back to `## Design Direction` only — no breakage.
- ✅ Offline profile creation is **author-only in v0.1** — `/setup-offline-profile` and `/enable-tables-offline` POST `mobileofflineprofile` / `mobileofflineprofileitem` / `mobileofflineprofileitemassociation` to Dataverse and write `offline-profile.json` to the project, but do NOT scaffold offline runtime code (SQLite store, sync engine, write queue) into the generated app. Runtime support is gated on upstream `@microsoft/power-apps-native-host` confirmation.
- ✅ Custom filter mode (`recorddistributioncriteria=3`, `profileitemrule` → `savedquery`) is **deferred to v0.5**. v0.1 supports Related-rows-only / All-records / Organization-rows radio options only.
- ✅ `offline-profile-architect` agent follows the existing `mobile-app:` namespace + status-code protocol (`DONE` / `DONE_WITH_CONCERNS:` / `NEEDS_CONTEXT:` / `BLOCKED:`). Read-only — proposes scope; never mutates Dataverse. Mutation lives in `/setup-offline-profile` after the 3 gates.
- ✅ **Offline profile ↔ schema reconciliation across the lifecycle.** Any schema change (`/add-dataverse`, `/setup-datamodel`, `/edit-app`) reconciles an existing offline profile, and `/deploy` gates the final push on offline coverage. Mechanism: `scripts/offline-profile-delta.js` — a purely LOCAL, no-network diff of `.datamodel-manifest.json` (schema) vs `offline-profile.json` (offline coverage) reporting `missingTables` + new columns; `status` ∈ `no-manifest`/`no-profile`/`in-sync`/`delta`/`error` (exit 0 = ran, 1 = fatal). It is distinct from `verify-offline-profile.js`, which is a Dataverse-network drift check of the snapshot vs the live published profile. Column delta is computed against a per-table `schemaColumns` baseline (all schema columns present at reconciliation time), written by `/setup-offline-profile`, `/add-table-to-offline-profile`, and refreshed by `/edit-offline-profile` — NOT against the curated `selectedColumns`, so deliberate exclusions aren't false-flagged; legacy snapshots without it degrade to table-only delta. The one canonical flow (prompt wording, reconcile ordering, deploy gate/override) lives in [`shared/references/offline-profile-reconciliation.md`](shared/references/offline-profile-reconciliation.md); the four skills reference it rather than duplicating it. Orchestrator-invoked `/add-dataverse` (`--skip-planning`) suppresses its own Step 8.5 so the orchestrator owns reconciliation once.

## Maintaining This File

Once skills exist, keep this file updated with the current skills table and architecture notes for this plugin.
