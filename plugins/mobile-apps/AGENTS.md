# AGENTS.md — Code Apps Native Plugin (Preview)

This file provides guidance to AI Agents when working with the **mobile-app** plugin.

> **Status:** Preview. The bundled `template/` remains a legacy test fixture, not a release selector or an app-version-independent native allowlist. Read [README.md](./README.md) for the command list and release gate.

## What This Plugin Is

A plugin for building and deploying **Power Apps code apps that run as native mobile + web apps** using Expo + React Native + TypeScript. Connects to Power Platform via connectors using the standard `pa app add data-source` workflow.

`/create-mobile-app` selects an exact published template package, acquires it only into a new/empty folder after approval, installs its lockfile after separate approval, then inspects and prepares it. Existing fresh installed folders use advisory local-development compatibility checks, not blocking admission before installation/startup. See [mobile-release-lifecycle.md](shared/references/mobile-release-lifecycle.md); strict compatibility remains required for deployment.

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
agents/                        ← native-app-planner, data-model-architect, screen-planner, preview-screen-builder, screen-builder, offline-profile-architect
shared/                        ← shared-instructions, references, samples, memory-bank template
skills/                        ← /create-mobile-app, /add-dataverse, /add-connector, /add-native, ...
scripts/                       ← shared helpers, including validate-mobile-files.js and bundled telemetry
hooks/                         ← Telemetry start hooks plus validators invoked explicitly by mobile workflows
```

## Template source

The bundled `template/` is retained for existing preparation/source tests. Runtime selection comes from the published host's compatibility profile and the matching immutable template metadata/lock, not a plugin-owned release array, bundled snapshot or independently chosen npm `latest` dependencies. `/check-updates` keeps npm outdated discovery and delegates migration writes to the published target host. `/create-mobile-app` never copies the bundled snapshot over a user's folder. After immutable acquisition and package validation, preparation applies these bounded edits:

| Edit | Purpose |
|---|---|
| `app.config.js`: `name`, `slug` | Replace `'Power Apps Standalone App'` / `'powerapps-standalone-app'` with wizard answers |
| `package.json`: `name` | Replace `'powerapps-standalone-app'` with the app slug |
| Remove an empty placeholder `power.config.json` | Preserve populated environment configuration; `pa app init` creates a missing file |
| Remove legacy example hooks and query-client files | Preserve every artifact under `src/generated/` |
| `app/_layout.tsx`: add `tamaguiConfig` + `defaultTheme` | Use host light/dark defaults until generated brand themes are explicitly wired |
| `app.json` + `app/_layout.tsx`: `appConfig` | Pass the complete generated app configuration once so the host can resolve opt-in Application Insights settings inside fixed Dev Player |
| `tsconfig.json`: verify the host base | Preserve both host inheritance and any version-specific project-rooted aliases |

Preparation preserves `app.json` compatibility metadata and customer extras byte-for-byte, together with scaffolded or customer-owned `AGENTS.md`, `CLAUDE.md`, and `.github/copilot-instructions.md`. Never synthesize runtime IDs from semver. Existing app instruction updates require a separately reviewed merge.

Only finalized published host/template packages authorize creation or native
upgrades. The former diagnostic artifact mode is retired; do not substitute a
local archive, a bundled template or a Git checkout for a missing publication.
Preserve normal approvals, telemetry checkpoints and app-owned offline profiles,
imports, settings and data.
The installed offline SDK must match the selected host's runtime family, peer
requirements and offline-contract version. Obtain its expected metadata and
complete declared native artifact inventory from the integrity-verified SDK
archive selected by the immutable template lock, never from mutable installed
hashes alone.
Metadata checks do not certify offline synchronization or database migration.
Never patch, fork or locally rewrite a first-party package to work around a defect.
For fixable upgrade failures, follow the [check-updates repair loop](skills/check-updates/SKILL.md#explain-choices-clearly-and-work-through-fixable-problems).
Local workflows and their children follow the
[local-development policy](shared/references/mobile-release-lifecycle.md#local-installation-and-startup-are-not-release-admission-gates):
use `--local-development` on the resolver and changed-file validator; retain
unverified compatibility without blocking installation/startup. Deployment
keeps strict first-party package/base validation.

Do not add preparation rewrites for `scheme`, `package`, `bundleIdentifier`, `src/playerConfig.ts`, `fingerprint.config.js`, or `native-runtime.json` unless those files exist in the synced main template.

## Guiding Principles

1. **Connector-first for data** — All Power Platform data access goes through connectors and generated services in `src/generated/`. No direct Graph / Azure REST calls.
2. **Native code is version-bounded; pure JavaScript is app-scoped.** Use `scripts/resolve-mobile-release.js` to resolve the app's reviewed native inventory, including installed versions and transitive native code. The newest plugin template's names are not an old app's baseline. Adding packages cannot add native code to a fixed player/base; native changes require a coordinated reviewed release. Pure-JS additions retain explicit planning/approval and installed-closure validation. Follow [JavaScript dependency planning](shared/references/javascript-dependency-planning.md) and [the native boundary](skills/add-native/SKILL.md). Verify haptics/controls support in the resolved release before generating wrappers. Native binary changes require matching rebuilt Android/iOS bases and available players before policy promotion.
3. **Fresh-template mode** — acquire only an immutable verified package into a new/empty folder, or validate an existing fresh installed template. Never overwrite a customer project, use a mutable branch, or silently copy the bundled snapshot.
4. **Safety guardrails** — Confirm before deploys, before global installs, before edits outside the project root.
5. **Memory bank** — Persist `memory-bank.md` in the project root.
6. **Two build orders** - `/create-mobile-app` routes the request, gathers the
   requirements with one setup question, classifies where the data lives, and
   then asks for a build order (showing the brief) at Step 0 of
   `skills/create-mobile-app/SKILL.md`; a connector-only brief skips the question
   and builds data model first. It then loads only
   that order's flow file. Keep each order's steps in its own flow file, and keep
   what both share (routing, the creation-state table, the requirements, the
   child-skill handoff context) in `SKILL.md`.
   - **Screens first** (recommended) scaffolds, drafts
     the screen graph itself, gets it approved (screen graph gate), builds every
     screen in parallel with `preview-screen-builder` on sample data behind the
     data layer in
     [`shared/references/preview-data-layer.md`](shared/references/preview-data-layer.md),
     and shows them in a live web preview (preview gate) before any architecture
     work. One `npm run dev` server, started at Step 3.5, serves that preview and,
     through the QR code the preview gate draws, the same app on a phone; it runs
     to the end of the run, so connecting real data reloads the app in place.
     The app registration is chosen at the preview gate (Step 8.0), before the QR:
     Power Apps Mobile Preview shows "Missing auth client ID" instead of the app
     once `power.config.json` names an environment and `auth.config.json` has no
     `msal.clientId`. Step 11 only re-checks it for connector permissions. The architecture gate (`architecture-planner`) then derives native
     capabilities, connectors, and the data platform from the approved screens,
     and the data model gate maps their Data Contract to Dataverse. Gates are
     named, not numbered. Phase A (up to the preview gate) lives in
     `references/screens-first.md` and aims to put the first screen in the phone
     about five minutes after the prompt; Phase B lives in
     `references/make-it-real.md`, so the model never loads it before the user
     has seen the app. Keep anything the preview does not need out of Phase A.
     That includes the full screen checklist: `preview-screen-builder` reads only
     what one screen needs, and Phase B's Step 9.3 runs `screen-builder`'s full
     design and accessibility checklist over every screen once the design system
     exists.
   - **Data model first** is the original workflow, in
     `references/data-model-first.md`: confirm requirements first, then Gate 1
     (`native-app-planner`) presents native capabilities, connectors, and the
     data-platform choice before conditional Dataverse modeling; later gates
     approve the applicable data model and screen plan, and screens are built
     last on generated services. Its apps have no `src/hooks/data/`, so shared
     agents and `/edit-app` treat them as legacy-mode apps.
   - **Shared steps.** A step both orders run the same way lives once, in its
     own flat file under `references/` (publisher prefix, Dataverse planning
     snapshot and recovery, post-plan prefix check, auth, apply data model,
     sample data, offline profile, native capabilities, connectors, stylistic
     sweep, dev server, debug handoff, summary). Each flow keeps the numbered
     heading and its telemetry checkpoint, then says
     `` **Shared step:** read [`<file>.md`](<file>.md) and follow it in full. ``
     Fix a shared step in its file, never in a flow, so there is one place to
     fix it. Shared files name steps rather than number them, and open with a
     table mapping each name to both orders' step numbers. `SKILL.md` uses the
     same line, linking `references/<file>.md`, for a branch only some runs
     take: `creation-continuation.md` and `template-acquisition.md` (a new or
     empty target). Keeping them out of the router keeps a fresh run's Phase A
     small. Tests read the router and flows
     through `scripts/tests/helpers/create-skill.js`, which expands each include
     so assertions see the text a run reads.
7. **Persisted plan** — Write `native-app-plan.md` (Mermaid ER + per-screen specs + native capabilities matrix) as the source of truth that sub-skills `Read`.
8. **CLI compatibility** — Resolve the Power Apps CLI per [`shared/cli-binary.md`](./shared/cli-binary.md) and run code-app lifecycle and data-source commands as `$PA …` in the canonical grouped `pa` form — never a bare `pa`, `power-apps`, or `npx pa`. Every other agent-run `npx` (`tsc`, `expo`, `qrcode`, …) also uses `--no-install` against a package the template pins; never `npx --yes` or a bare `npx <pkg>` that can download from the registry. Use `scripts/resolve-environment.js` plus `az` tokens for Dataverse environment URL/tenant discovery and Azure/Entra operations. See [`shared/shared-instructions.md`](./shared/shared-instructions.md).
   Mobile Node helpers use `scripts/lib/process-runner.js` for external CLI
   execution. Keep arguments separate from commands and reuse its native/batch
   handling rather than adding per-tool Windows shims or `shell: true`.
9. **Agent invocation namespace** — All `Task` invocations of agents in this plugin MUST use the fully-qualified `mobile-app:<agent-name>` form (e.g. `mobile-app:native-app-planner`, `mobile-app:screen-builder`). Bare names like `native-app-planner` return `Agent type 'native-app-planner' not found` because Claude Code namespaces all plugin agents by plugin name.
   Agent frontmatter names no `model`, so each agent runs on the session's model in every host.
   A host-specific alias fails elsewhere: GitHub Copilot CLI rejects `sonnet` and refuses to start the agent, which turned every parallel screen build into a slow inline one.
   Claude Code resolves an absent `model` to the main conversation's model ([model order](https://code.claude.com/docs/en/sub-agents#choose-a-model)).
10. **Plugin isolation** — `hooks/hooks.json` is limited to fail-open telemetry start hooks. They never validate, mutate, or block tool calls. Do not add write/validation hooks: mutating skills follow the changed-file gate in `shared/shared-instructions.md`, and final-artifact agents invoke `scripts/validate-mobile-files.js` directly.
11. **Invocation metadata** — Public entry skills use `user-invocable: true` and remain model-invocable. Bundled implementation helpers use both `user-invocable: false` and `disable-model-invocation: true`; their owner reads `SKILL.md` directly. Hidden standalone workflows such as `assign-offline-profile` and `preview-offline-scope` use `user-invocable: false` without disabling model invocation because no owner reads them directly. Agents use `user-invocable: false` without `disable-model-invocation` so qualified `Task` delegation remains available.
12. **Sub-agent return-status protocol** — Every agent in this plugin (`native-app-planner`, `data-model-architect`, `screen-planner`, `preview-screen-builder`, `screen-builder`, `offline-profile-architect`) MUST return a status code as the **literal first line** of its final message. Orchestrators (skills that invoke agents via `Task`) MUST parse the first line and branch:

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
    - In `/create-mobile-app` only, `NEEDS_CONTEXT: dataverse-planning-mode:<required|connector-only>` from the `gate-only` architecture pass is a phase-completion signal, not a retry. The canonical handler validates the approved architecture before continuing; other phases cannot use it to change the data platform.
    - Special early-return signals (`INDUSTRY_CONFIRM_REQUESTED:`, `DESIGN_VIBE_REQUESTED:`) pre-date this protocol and remain in effect — they are special-cased "ask the user one question and re-spawn me" handoffs, not terminal returns.
    - The canonical orchestrator handler lives in each `/create-mobile-app` build order's flow: `## Sub-agent return status` in [`references/screens-first.md`](./skills/create-mobile-app/references/screens-first.md) (with the architecture and Dataverse signals in Step 10.0 of [`references/make-it-real.md`](./skills/create-mobile-app/references/make-it-real.md) and the shared [`references/dataverse-planning-recovery.md`](./skills/create-mobile-app/references/dataverse-planning-recovery.md)), and Step 3.0 of [`references/data-model-first.md`](./skills/create-mobile-app/references/data-model-first.md). Future skills that spawn agents should reference them rather than duplicating the switch.
13. **Every run documents itself in `docs/`** - [`scripts/app-docs.js`](scripts/app-docs.js) writes `<app>/docs/create-app-plan.html`, a living Fluent-format plan in the same visual language as the Power Pages `/create-site` artifacts (shared encoder ported to [`scripts/lib/render-template.js`](scripts/lib/render-template.js)). It records the environment, the confirmed brief, the screen plan, the design system, the architecture, and the data model with a colour-coded ER diagram, plus per-phase progress in the order of the run's build order (`buildOrder` in `docs/.run-plan.json`; a plan without one is data-model-first). In the screens-first order its phone frame shows the live web preview while the app runs on sample data, and that phone is the only place the preview appears (Step 3.5 starts the template's `npm run dev`, which opens no browser tab). That one dev server also serves the app to a phone: the preview gate draws its QR code under the frame, and Step 14 moves the code into the frame, because a wired app needs a signed-in host the browser frame does not have. Each render also writes `create-app-plan.version.js`, and the open page reloads only when that version changes, because a reload restarts the app in the phone. The shared refresh controller in `scripts/lib/plan-refresh.js` runs this version check for both the build plan and the edit plan (`edit-app-progress.version.js`). A check changes nothing on screen, so it never stops while the page is open; stopping after a run of unchanged checks left pages stale once a step ran long. Only the timed fallback, for a browser that blocks the version file, keeps the pause at input gates and the 30-reload budget. Sections are written **when the decision is made**, so an aborted run still explains itself. The ER, column tables and new/reused/extended colouring are all derived from `dataModel.tables[]`, so populate those structurally rather than only shipping a Mermaid string. It is best-effort and must never gate, retry, or fail a build.
14. **Metro lifecycle is project-local** — template `metro.config.js` delegates to `createPowerAppsMetroConfig`, whose host implementation writes sanitized `.powernative/metro-logs/` output during normal `npm run dev`; `/debug-app` locates and tails those files directly, with its cursor, health, and audit state under `.powernative/debug-app/`. Do not restore required `BashOutput`/terminal-ID behavior or host-specific project state directories. Host terminal APIs may be optional conveniences only. Never write unsanitized Metro output to disk. Runtime monitoring requires a live logged PID/port; bounded startup diagnosis may use correlated failed-launch output as historical evidence, never as a live runtime session.
15. **First-party native package defects are reported, not patched in customer projects** — a `node_modules/@microsoft/power-apps-native-*` frame alone is not proof of package ownership; first rule out invalid app usage against the package's public contract. Once a defect is confirmed inside one of these packages, do not edit `node_modules/`, generate `patch-package` or postinstall rewrites, vendor or fork the package, replace it with a git/tarball/local dependency, or shadow it through resolver aliases. Capture sanitized reproduction evidence and route to `/report-issue`.
16. **Custom events are Application Insights-specific and opt-in** — Each generated app targets one customer-owned, workspace-based Application Insights resource. `app.json` → `expo.extra.appInsightsConfig` defaults to disabled and stores its connection string, matching the Power Apps canvas-app model. Treat the value as sensitive project configuration: do not print it, write it to `memory-bank.md`, or include it in summaries. Keep `includeUserId` false unless explicitly approved.
17. **Plugin update notification** — Immediately after the frontmatter of every `user-invocable: true` skill except `/check-updates`, run `node "${PLUGIN_ROOT}/scripts/check-version.js"` and show any output before proceeding. The check is best-effort and must never block the requested workflow. `/check-updates` owns its explicit plugin-version check in Step 1 and must not run a duplicate startup check.

18. **Data-source operations preserve scope and app identity** — Before data
    work, follow [Data-source invocation scope](shared/shared-instructions.md#data-source-invocation-scope).
    Standalone workflows approve the current delta; child calls carry the owner,
    phase, absolute root, and exact approved operations. Neither a flag nor an
    old plan grants approval. Every shell/file operation uses the same root;
    follow [app-working-directory.md](shared/references/app-working-directory.md)
    for Bash and PowerShell guards.
19. **Data-source retirement is app-local and CLI-owned** — After approved
    consumer edits, use the supported removal command to update registrations,
    schemas, and generated models/services, then regenerate the runtime schema
    map. Never turn a removed plan row into server-table deletion. Follow
    [`shared/references/data-source-removal.md`](shared/references/data-source-removal.md)
    for shared-reference safety, inventory/offline reconciliation, and no-op
    detection; successful exit alone is insufficient.
20. **Seed scope is not the schema inventory** — Orchestrated `/add-sample-data`
    calls pass an approved `--tables` allowlist and retiring-table exclusions.
    Lookup fanout, prototype seeds, media uploads, and retries cannot widen that
    scope. Preserve transitional manifest entries until verified removal.
21. **Offline retirement survives addition checks** — Preserve per-table
    `offlineRetirement` outcomes in leaf results and memory-bank. Addition-only
    `in-sync` never clears a pending profile decision/migration. App-binding
    approval is not permission to delete offline profile items or server data.
22. **Dataverse change planning shares creation's helpers, not its gates** —
    Setup/edit/standalone proposals use compact hash-bound evidence, required
    snapshot-only architect context, and decision validation before the owner's existing approval.
    The same checks apply to diagrams and inline fallbacks. Preapproval
    environment resolution uses `--no-cache --require-tenant`; never downgrade
    to the persistent resolver. Follow
    [scoped Dataverse planning](shared/references/dataverse-change-planning.md).
    Accepted contract/plan hashes travel in the existing scoped context; do not
    fabricate the four-approval create-only execution receipt for an edit.
23. **Feature entry points share one edit owner** — Direct native, connector,
    data-model, and design requests on existing apps choose implementation-only,
    full integration, or cancellation before costly work. Natural-language
    existing-app feature requests preserve the original prompt and invoke
    `/edit-app` after full-integration consent; never merely suggest the command
    or send an existing app through `/create-mobile-app`. Approved children reuse
    their current owner/root/phase/scope and never recurse into another edit.
    Follow [app-edit-routing.md](shared/references/app-edit-routing.md); the
    choice enters a workflow, not permission to mutate.
24. **Shared entry policy is not copied into every skill** — Every new public
    app workflow starts with a read-first link to `shared/shared-instructions.md`
    and allows `Read`. The shared preflight classifies feature work before
    operational commands; leaves only link to it. Invocation discovery tests
    cover newly added skills automatically. These static checks verify the
    instruction contract, not model compliance; do not claim smaller-model or
    host reliability without agent-run evidence.
25. **Natural-language routing is not a fixed skill list** — App guidance selects
    the most specific host-advertised skill by description and supported scope,
    including future/custom workflows not in the example table. Invoke rather
    than merely recommend it after required entry consent. Preserve exact
    namespaces, invocation restrictions, current owners, and all approval gates;
    do not route every request through `/edit-app`.
    Selection needs no extra invocation-approval prompt, but Dataverse and other
    consequential actions keep their target/scope checks and mutation approvals.
    Never fabricate approval context or substitute ad-hoc mutations for an
    unavailable domain workflow.
26. **Startup diagnosis precedes runtime monitoring when necessary** —
    `/debug-app startup` can inspect a failed install, pre-start command, or QR
    opening without a loaded app. `scripts/inspect-startup.js` is local/read-only
    and never authorizes repair or verifies startup. Clean metadata is not an
    exhaustive diagnosis; unexplained symptoms require scoped investigation of
    the original failure, not a guessed reinstall. The bounded workflow in
    [`skills/debug-app/references/startup-diagnostics.md`](skills/debug-app/references/startup-diagnostics.md)
    owns explicit same-lock restoration/restart approval and original-symptom
    verification. Upgrades remain with the separate dependency-update workflow;
    no lock deletion, automatic dependency updates, or host/MSAL patches.
    Creation reuses this workflow on an observed startup failure instead of
    launching another repair loop. Runtime monitoring still requires live logs.

## Telemetry

Mobile Apps bundles the canonical stdlib-only telemetry helpers from the repo-root `shared/telemetry/lib` at `scripts/lib/telemetry/lib`. Edit the shared source first, then refresh this physical copy in the same change; never copy another plugin's `ikey.json` or resolver.

- **Lifecycle:** `UserPromptSubmit` and `PreToolUse(Skill)` remain legacy activity observations, not measured workflow starts. Every tracked operational skill follows `shared/shared-instructions.md` to begin and end a schema-v2 skill span and measure registered checkpoints through `scripts/emit-telemetry-checkpoint.js`. Durable span state uses the Mobile Apps-owned `scripts/lib/mobile-lifecycle.js` helper; orchestration remains in the existing checkpoint CLI. Pass explicit run, parent, and span IDs across Skill, Task, subprocess, and resume boundaries. Do not infer completion from hook returns or recover run identity from an unrelated session. The `telemetry` preference skill remains exempt.
- **Coverage and attribution:** `scripts/lib/mobileapp-hook-utils.js` discovers every user- or model-invocable top-level skill, including `telemetry`. Direct-read helpers with `disable-model-invocation: true` are not independently invoked and are excluded. Bare and `mobile-app:`-qualified names are both attributed; explicitly foreign plugin namespaces are excluded.
- **Session correlation:** Stable host session ids pass through unchanged. Copilot CLI reports a transient `call_*` id to nested-agent hooks, so `resolveCopilotRootSessionId` in `scripts/lib/mobile-telemetry.js` resolves it to the unique recent UUID session whose local `~/.copilot/session-state/<uuid>/events.jsonl` structurally owns that `agentId`, reading only a bounded tail. Keep host-specific quirks contained in that one function. The verified root is cached as one atomic 30-minute alias file per hashed call id so fresh hook processes reuse it; aliases hold no prompts, cwd, or tool arguments and are never transmitted. Missing, stale, malformed, or ambiguous state fails open to the original id, and Claude Code and Codex ids are not rewritten.
- **Privacy:** Only the exact field schema enforced by `scripts/lib/mobile-telemetry-dispatcher.js` and disclosed in this plugin's README and telemetry skill is allowed. Verified environment, tenant, and organization IDs support adoption and support correlation; they are organization-identifying metadata. Mobile telemetry must never capture or transmit an Entra user/object ID, Dataverse UserId, username, email, or guessed home-account ID. Never send prompts, arguments, records, file contents, paths, URLs, credentials, names, hostnames, or raw errors. The dispatcher filters top-level and nested values before local logging and transmission; arbitrary `eventInfo` enrichment is forbidden.
- **Destination and controls:** Mobile-owned `scripts/lib/mobile-telemetry-dispatcher.js` maps shared events to the Power Apps `event` stream configured by `scripts/lib/telemetry/ikey.json`. The repository `disabled` switch is a hard-off; user and CI opt-outs suppress transmission while preserving the local diagnostic mirror.
- **CI:** Every Mobile Apps test job must set `POWER_PLATFORM_SKILLS_TELEMETRY_MOBILE_APP_OPTOUT=1`. The single positive wire test clears that backstop only in its child process and routes the event to `POWER_PLATFORM_SKILLS_FAKE_HTTPS`; all other positive tests remain opted out and exercise the local mirror.

## Decisions made

- ✅ Markdown plan with Mermaid as the durable source, plus a living HTML plan and edit-progress page for user-visible status
- ✅ **Architecture-first approval gates** in the planner (data platform + native APIs + connectors → conditional Dataverse model → screen plan)
- ✅ `/edit-app` skill for post-generation app iteration: updates the approved plan delta, applies Dataverse/native/design/screen mutations, verifies, and refreshes preview output. `--plan-only` is the explicit docs-only escape hatch.
- ✅ Single `/deploy` skill — `npm run build` + `pa app push`; no local native compile, no OTA in v0
- ✅ Connection model: per-environment connections, with platform-specific auth (`expo-msal-intune` on native, `expo-auth-session` on web)
- ✅ Auth: `/create-mobile-app` resolves the tenant from the selected Power Platform environment (`scripts/resolve-environment.js`), lists every tenant app registration visible to the signed-in Azure CLI user, evaluates the native runtime permission profile as one boolean, shows passing registrations first, and paginates the rest. The baseline requires Dynamics CRM `user_impersonation` and Power Platform API `PowerApps.Apps.Read`; when the approved plan contains non-Dataverse connectors, the checker also requires Azure API Connections `Runtime.All` plus the four Power Platform API connector read/write/user-consent scopes. The list uses self-contained `✓ All required permissions configured` / `✗ Missing required permissions` labels; missing details appear after selection. Discovery is best-effort: any CLI, Graph, tenant, response, or permission-check failure immediately falls back to the original pasted-client-ID flow with status unavailable. `/set-app-registration-native` infers connector use from the persisted plan or nonempty `power.config.json.connectionReferences` and provides the same read-only discovery, verification, ranking, pagination, and fallback behavior. Power Apps Wrap remains the final authority for redirect platforms, packaging permissions, third-party-app allowlisting, and admin consent.
- ✅ `/add-native` v0 scope: camera, location, push, biometrics, secure-store (already in template)
- ✅ Build documentation: every run writes `docs/create-app-plan.html` - environment, requirements, architecture, a colour-coded Dataverse ER diagram, screen plan, design system, and live phase progress - in the Power Pages plan format. The page also carries a phone frame that advances from a building state to the live preview, where the user tries the app, to the device QR code. The folder survives the run so the app carries its own design record.
- ✅ Cross-host Metro diagnostics: user-owned `npm run dev`, port-probe liveness and stale-PID protection, sanitized project-local logs, a durable debug cursor, and read-only `status` plus foreground-loop `stop` commands
- ✅ Template acquisition uses a verified exact package and lockfile; no default release is promoted until publication and both platforms' bases/players are verified.
- ✅ `brand/` directory convention: `/design-system` (`/create-mobile-app` Step 9) writes `brand/design-system.md` (spec), `brand/tokens.ts` (importable Tamagui tokens), and `brand/design-system.html` (visual gallery). Screen-builders MUST read `brand/design-system.md` if present; `## Negatives` = HARD RULES. `/create-mobile-app` Step 9.2 imports `brand/tokens.ts` via `skills/design-system/references/tamagui-integration.md`. Projects without `brand/` fall back to `## Design Direction` only — no breakage.
- ✅ Offline profile creation is **configuration-only in v0.1** —
  `/setup-offline-profile` and `/enable-tables-offline` POST
  `mobileofflineprofile` / `mobileofflineprofileitem` /
  `mobileofflineprofileitemassociation` to Dataverse and write
  `offline-profile.json`. The template already bundles
  `@microsoft/power-apps-native-offline`, and
  `@microsoft/power-apps-native-host` consumes it for local SQLite access,
  queued synchronization, reconnect handling, and its status overlay. Skills
  configure that host runtime; they do not scaffold a second app-owned store,
  sync engine, queue, or duplicate offline UX.
- ✅ Custom filter mode (`recorddistributioncriteria=3`, `profileitemrule` → `savedquery`) is **deferred to v0.5**. v0.1 supports Related-rows-only / All-records / Organization-rows radio options only.
- ✅ `offline-profile-architect` agent follows the existing `mobile-app:` namespace + status-code protocol (`DONE` / `DONE_WITH_CONCERNS:` / `NEEDS_CONTEXT:` / `BLOCKED:`). Read-only — proposes scope; never mutates Dataverse. Mutation lives in `/setup-offline-profile` after the 3 gates.
- ✅ **Offline profile ↔ schema reconciliation across the lifecycle.** Any schema change (`/add-dataverse`, `/setup-datamodel`, `/edit-app`) reconciles an existing offline profile, and `/deploy` gates the final push on offline coverage. Mechanism: `scripts/offline-profile-delta.js` — a purely LOCAL, no-network diff of `.datamodel-manifest.json` (schema) vs `offline-profile.json` (offline coverage) reporting `missingTables` + new columns; `status` ∈ `no-manifest`/`no-profile`/`in-sync`/`delta`/`error` (exit 0 = ran, 1 = fatal). It is distinct from `verify-offline-profile.js`, which is a Dataverse-network drift check of the snapshot vs the live published profile. Column delta is computed against a per-table `schemaColumns` baseline (all schema columns present at reconciliation time), written by `/setup-offline-profile`, `/add-table-to-offline-profile`, and refreshed by `/edit-offline-profile` — NOT against the curated `selectedColumns`, so deliberate exclusions aren't false-flagged; legacy snapshots without it degrade to table-only delta. The one canonical flow (prompt wording, reconcile ordering, deploy gate/override) lives in [`shared/references/offline-profile-reconciliation.md`](shared/references/offline-profile-reconciliation.md); the four skills reference it rather than duplicating it. Orchestrator-invoked `/add-dataverse` (`--skip-planning`) suppresses its own Step 8.5 so the orchestrator owns reconciliation once.

## Maintaining This File

Once skills exist, keep this file updated with the current skills table and architecture notes for this plugin.
