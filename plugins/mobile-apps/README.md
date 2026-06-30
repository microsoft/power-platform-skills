# Mobile Apps Plugin (Code Apps Native, Preview)

Claude Code / Copilot plugin for building **Power Apps code apps for mobile** using Expo + React Native + TypeScript.

> **Marketplace:** `power-platform-skills`, plugin `mobile-app`, stored in `plugins/mobile-apps`.
> **What:** Build mobile Power Apps with Expo + RN + TS (iOS & Android).
> **Status:** public preview / v0.

---

<a id="glossary"></a>
### Glossary

| Term | Meaning |
|---|---|
| **Skill** | `/command` you invoke (e.g. `/create-mobile-app`, `/add-dataverse`) |
| **Agent** | Sub-process a skill spawns (e.g. `data-model-architect`, `screen-builder`) |
| **Gate** | Approval prompt before a mutation — user must confirm before the skill proceeds |
| **Memory bank** | `memory-bank.md` per project — source of truth for resume across sessions |
| **Brief** | Confirmed feature description (4–8 bullets) the planner consumes |

---

### Repo layout

```
skills/       — /commands users invoke
agents/       — sub-processes (planner, architects, screen-builder)
hooks/        — pre/post-tool validators
shared/       — cross-cutting refs (memory-bank, version-check, MCP, …)
AGENTS.md     — agent contract
```

---

## Install

The plugin works with **Claude Code** and **GitHub Copilot in VS Code**. Both use the same plugin directory — no separate distributions.

### Marketplace install

After adding the Power Platform Skills marketplace, install the mobile app plugin:

```bash
/plugin marketplace add microsoft/power-platform-skills
/plugin install mobile-app@power-platform-skills
```

The repository root installer also installs this plugin along with the rest of the marketplace:

```bash
node scripts/install.js
```

### Local checkout install

After cloning this marketplace, use the repository root installer when you want all marketplace plugins installed:

```bash
cd /path/to/power-platform-skills
node scripts/install.js
```

To install only this plugin from a local checkout, register the repository root as the marketplace and install `mobile-app` directly:

```bash
claude plugin marketplace add /path/to/power-platform-skills
claude plugin install mobile-app@power-platform-skills --scope user
```

For GitHub Copilot CLI, use the same marketplace root with `copilot plugin marketplace add` and `copilot plugin install mobile-app@power-platform-skills`. Reload VS Code or restart Claude after installation so the slash-command registry refreshes.

### Existing installs / rename migration

If you already had the preview installed and your slash menu still shows the old namespace, uninstall the old local preview plugin and marketplace, then install `mobile-app@power-platform-skills`:

```bash
claude plugin uninstall "code-apps-native@code-apps-native-local" --scope user
claude plugin marketplace remove code-apps-native-local
```

Use the equivalent `copilot plugin uninstall "code-apps-native@code-apps-native-local"` and `copilot plugin marketplace remove code-apps-native-local` commands if your old preview install was in Copilot. Reload VS Code or restart Claude after cleanup so the slash-command registry refreshes.

### Claude Code fallback

**Step 1 — Clone the marketplace anywhere.**

```bash
git clone https://github.com/microsoft/power-platform-skills.git
```

**Step 2 — Register the local marketplace.**

```bash
claude plugin marketplace add /path/to/power-platform-skills
claude plugin install mobile-app@power-platform-skills --scope user
```

Use this only if the installer cannot find or configure your Claude CLI. You can also add it to your global plugin config manually — see the [Claude Code plugin docs](https://docs.anthropic.com/claude/docs/claude-code-plugins).

**Step 3 — Prepare a fresh template folder** (next section). Use `degit` to materialize the public template from this repository, run `npm install` in that folder, then open that folder and run `/create-mobile-app` there.

### GitHub Copilot (VS Code) fallback

Use this only if the installer cannot configure your Copilot CLI or VS Code plugin state.

**Option A — Install from the git URL:**

1. Open the Command Palette (`⇧⌘P`) and run **Chat: Install Plugin From Source**
2. Enter the repository URL (`https://github.com/microsoft/power-platform-skills`) and press Enter
3. VS Code clones and activates the plugin — skills appear under `/` in Copilot Chat

**Option B — Register a local directory:**

Add the extracted folder to VS Code's `settings.json`:

```json
"chat.pluginLocations": {
  "/Users/you/power-platform-skills/plugins/mobile-apps": true
}
```

**Using the plugin in Copilot:**

- In the Copilot Chat panel, switch to **Agent mode**
- Type `/` to see available skills (`/create-mobile-app`, `/add-dataverse`, etc.)
- Skills run with the same tool access and instructions as in Claude Code

> **Note:** `EnterPlanMode` / `ExitPlanMode` are Claude Code-only directives. Copilot approximates plan mode by restricting itself to read-only operations during the planning phase — the workflow still proceeds correctly.

Create a new app from the template and install dependencies before invoking `/create-mobile-app`:

```bash
npx degit microsoft/power-platform-skills/plugins/mobile-apps/template#main my-mobile-app
cd my-mobile-app
npm install
```

Then open `my-mobile-app` and run `/create-mobile-app` there. The skill assumes the current working directory is this fresh installed template folder.

Install the mobile-app skill from the Power Platform Skills plugin:

```text
https://github.com/microsoft/power-platform-skills/tree/main/plugins/mobile-apps/.plugin/plugin.json
```

---

## Prerequisites — what you must set up before `/create-mobile-app`

The skill checks these in Step 1 (Prerequisites) and stops with a clear error if any are missing. Get them ready up front to avoid mid-flow blocks.

### 1. Tooling versions

| Tool | Min version | How to install / check |
|---|---|---|
| Node.js | **22.x** | `node -v` — install via [nvm](https://github.com/nvm-sh/nvm) (`nvm install 22 && nvm use 22`) |
| `az` (Azure CLI) | **2.60+** | `az --version` — needed for Dataverse helper scripts. Install via Homebrew: `brew install azure-cli` |
| `git` | any recent | required for upstream template clone |

Detailed matrix (and Xcode/Android Studio notes if you want local native builds): [`shared/version-check.md`](shared/version-check.md).

### 2. Power Platform environment

You'll need an environment to deploy into. `/create-mobile-app` runs `npx power-apps init`, then reads the generated `power.config.json`, resolves the Dataverse URL and tenant through `resolve-environment.js`, and continues. The resolver calls the BAP admin environments endpoint (`api.bap.microsoft.com/providers/Microsoft.BusinessAppPlatform/scopes/admin/environments/<environment-id>`). If the signed-in Azure CLI account cannot read that environment through BAP, provide the Dataverse environment URL directly.

When resolution succeeds from an initialized app root, the resolver writes the non-secret environment details to both `.resolved-environment.json` and `auth.config.json.environment`. Later skills should read those cached values before re-running the environment API. Current-user values such as `UserId` and `BusinessUnitId` are resolved only by skills that explicitly need Dataverse identity context.

Requirements:
- Start from a fresh installed `expo-app-standalone` template folder; `/create-mobile-app` owns `npx power-apps init`
- Environment URL handy (e.g. `https://orgXXX.crm.dynamics.com/`) as a fallback if the resolver cannot infer the URL from the selected environment ID
- Environment ID handy for the `npx power-apps init` selection
- Permissions to create tables (system customizer or higher) if you'll let the planner create new Dataverse tables

If environment resolution cannot get a Dataverse token during the skill, run `az login --tenant <env-tenant>` and retry.

### 3. (Optional) Companion plugins

- **`expo/skills`** — see the next section. Strongly recommended for native UI patterns.

### Quick sanity check

Before you run `/create-mobile-app`, paste this one-liner from the fresh template folder. It touches the required local tooling and verifies the template dependencies are installed:

```bash
node -v && \
npx --yes degit --help >/dev/null && \
npm install --package-lock-only --ignore-scripts && \
echo "✅ all prereqs OK"
```

If any line fails, fix that one before starting the skill. The most common failures are an older Node.js version or running the command outside the fresh template folder.

---

## Recommended companion plugin: `expo/skills`

This plugin owns Power Platform integration (auth, Dataverse, connectors, planning, scaffolding). For Expo Router patterns, native UI conventions, and library preferences, install the official Expo team's plugin alongside this one:

```bash
/plugin marketplace add expo/skills
/plugin install expo
```

We **defer to** these Expo skills for:
- `building-native-ui` — Expo Router, Stack, NativeTabs, Link previews, sheets, modals, search bars, Apple HIG conventions, library preferences (e.g., `expo-audio` not `expo-av`)
- `expo-dev-client` — custom dev clients
- `expo-module` — authoring local native modules
- `upgrading-expo` — SDK upgrades
- `use-dom`, `expo-tailwind-setup`, etc.

We **do not use** their `expo-deployment` / `expo-cicd-workflows` / `expo-api-routes` skills — deployment in this plugin is `npm run build` + `npx power-apps push`. Power Platform integration uses Dataverse + connectors, not Expo API Routes.

The two plugins layer cleanly: this plugin owns _what_ to build (data model, screens, connectors) and _Power Platform mechanics_; Expo skills own _how_ to build native UI.

After deploy, use `/open-wrap-url --app-id <app-id> --env-id <env-id>` to jump straight to the Wrap page for native extension / package generation.

## What you get

- **Expo standalone template** prepared with `degit` from [`plugins/mobile-apps/template`](https://github.com/microsoft/power-platform-skills/tree/main/plugins/mobile-apps/template). The plugin bundles the latest template snapshot under `template/`, while `/create-mobile-app` expects the user to run from a fresh installed template working directory and applies the app identity / connector preparation edits there.
- **Same `npx power-apps add-data-source` workflow** across this plugin's skills — generated services in `src/generated/services/` work consistently
- **Auth pre-wired** via the Power Apps CLI first-party Entra app — no custom Azure registration required
- **Two platforms** in one codebase: iOS, Android
- **Deploy = `npm run build` + `npx power-apps push`** — local native compile (platform-specific native run commands) is the user's choice and is **out of scope**; users run those directly when they want them.
- **Local dev = `npm run dev`** — the user runs this directly. The plugin doesn't start Metro.

## Hello world — your first run

After the prereq sanity check passes:

```text
> /create-mobile-app build me a small notes app
```

Expected: ~6 prompts (wizard + gates), then ~5 minutes of scaffolding, table creation, and parallel screen builds. End state: a working Notes app with `npm run dev` ready to go. If anything fails, the [memory bank](#glossary) remembers where you left off — re-run the same command and it resumes.

## Quick examples

The plugin is conversational — you describe what you want and the skill drives the rest. Five typical flows:

### 1. Create a new app from a one-liner

```text
> /create-mobile-app I want a field inspection app where technicians log site visits with photos, GPS location, and notes
```

What happens:
1. **Wizard** (~30s) — confirms device class / aesthetic
2. **Requirements brief** — the orchestrator infers features (data entry, camera, location), pre-checks them, asks you to confirm or adjust
3. **Industry confirmation** — only fires if the inference is shaky (your description matched multiple industries, or none)
4. **4 approval gates** — data model → native capabilities → connectors → screens (with a visual `_plan_preview.html` of every screen before any code is written)
5. **Design system** — brand inputs (logo, brand doc, website, or free-text) → cost picker → style picker → component reference sheet → branded screen previews
6. **Scaffold + build** — validates the prepared template folder, runs `npx power-apps init`, verifies installed dependencies, generates schemas, builds Dataverse tables, wires connectors, spawns N parallel screen-builders for the TSX
7. **Dev server** — `npm run dev` starts Metro; scan the QR with your native dev client on a device

End state: a working app you can iterate on with hot reload. ~5–12 minutes for the planning gates, then scaffolding runs.

### 2. Add Dataverse tables to an existing app

```text
> /add-dataverse I need an Asset table with name, serial number, and a lookup to an existing Account
```

Or paste an ER diagram (image / Mermaid / text). The data-model-architect agent discovers what already exists in your environment, scores reuse vs extend vs create, walks through approval, then creates the tables in dependency order and regenerates `src/generated/services/`.

### 3. Add a native capability

```text
> /add-native camera
```

Generates `src/native/camera.ts` (typed wrapper around `expo-camera` + `expo-image-picker`) and — if Dataverse image columns exist — a `cameraUpload.ts` helper that bridges to `Service.upload()`. The Expo modules are already in the upstream template; no `package.json` or `app.config.js` edits.

For other capabilities (only those actually shipped by the template):
```text
> /add-native document-picker   # expo-document-picker wrapper
> /add-native secure-store      # expo-secure-store wrapper
> /add-native file-system       # expo-file-system wrapper
> /add-native sharing           # expo-sharing wrapper
```

Native modules are allowlist-bound by the current template `package.json`. If the relevant package is present and not runtime-banned, `/add-native` can use it through the proper wrapper or host control. If the package is absent, the skill does not install it or fake support; it adds a transparency note and stops for that capability. For example, push notifications require `expo-notifications`; if the template does not ship it, notifications cannot be added until the upstream template includes it.

### 4. Add a connector

```text
> /add-sharepoint                # SharePoint Online lists / documents
> /add-connector                 # any other Power Platform connector
```

Runs `npx power-apps add-data-source` under the hood, regenerates services, prints how to import in your screens.

### 5. Iterate on the generated app after the fact

```text
> /edit-app "Improve the search screen to make it easier to use on mobile"
> /deploy                        # npm run build + npx power-apps push
> /open-wrap-url --app-id <id> --env-id <env-id>   # open make.powerapps.com Wrap page for this app
> /preview-screens               # browser preview of generated screens (no Metro needed)
> /list-connections              # diagnostic when a service call returns 401
> /report-issue                  # copy-paste-ready GitHub issue body
```

Use `/edit-app` for post-generation improvements. It first inspects the existing app and asks only for missing intent details (which screen, table, scanned field, launch point, brand source, etc.). Then it updates `native-app-plan.md` when the request changes the plan, applies the generated app edits, runs the relevant verification, updates `memory-bank.md`, and regenerates `preview.html` when UI changed. You do not need to manually run `npm run generate-schemas`, `npx tsc --noEmit`, or `/preview-screens` after each edit unless you are doing diagnostics outside the skill.

Common follow-ups:

| Prompt | What `/edit-app` does |
|---|---|
| "Improve the search screen for mobile" | Re-plans/rebuilds the affected search or list screen, then previews. |
| "Add loading, empty, and error states" | Updates the screen spec and TSX state handling, then type-checks. |
| "Add a detail screen for the selected record" | Updates navigation contracts, creates the detail route, and updates the source screen navigation. |
| "Update the design to match branding" | Runs the design refresh/reskin path, rebuilds affected screens when layout grammar changes, then previews. |
| "Add a form to create a new Dataverse record" | Updates plan/data needs, builds the form route and create payload, and verifies generated services. |
| "Add barcode scanning and use the scan value to search" | Adds the native scanner wrapper if supported, updates screen flow, and rebuilds affected screens. |
| "Add a new requirement with a new screen" | Determines whether the feature needs data model, connector, native, or design changes, applies those first, then plans/builds the new screen. |
| "Add a new data source" | Routes through Dataverse, SharePoint, or the generic connector flow, regenerates services, and rebuilds screens only if the request includes UI. |
| "Generate a new static preview" | Runs the preview path without changing source unless the app is stale. |

Example edit flows:

| User prompt | If intent is missing, `/edit-app` asks | Then it runs |
|---|---|---|
| `/edit-app "Add loading, empty and error states to the list screen"` | Which list screen, unless only one exists; whether to improve existing states or add missing ones | Existing screen inspection, screen spec update if needed, targeted TSX rebuild, `tsc`, screen validators |
| `/edit-app "Add a detail screen for the selected record"` | Source list/search screen, table/service, fields/actions, route style | Screen-plan delta, route/layout update, Generated Services snapshot, detail skeleton, detail + source screen builders, route check |
| `/edit-app "Add a form to create a new record in Dataverse"` | Table, required/editable fields, launch point, after-save behavior, lookup/file/image fields | Data-model update via `/add-dataverse` if needed, schema generation, form skeleton, form + parent screen builders, create-payload validation |
| `/edit-app "Add barcode scanning and use the scanned value to search records"` | Scanner location, scanned value meaning, table/service/field to search, no/multiple-match behavior | `/add-native barcode-scanner`, data-model update if target field is missing, scanner/search screen rebuild, native/runtime checks |
| `/edit-app "Update the design to better match company branding"` | Brand source and scope: palette, typography, components/density, or full reskin | `/design-system --refresh` or `--reskin`, affected screen rebuild when layout grammar changes, style sweep, preview |

### Prefer browser-free / token-budget mode?

At Step 6.75 of `/create-mobile-app`, the `/design-system` skill offers a cost picker — option (c) *"Skip — no design work"* skips the style picker and brand rendering entirely, inferring the design from your description. The plan and preview HTML are still generated; you open them yourself if curious. The flag is persisted to the project's `memory-bank.md` so future `/preview-screens` and `/edit-app` invocations honor it.

## Commands

| Command | Status | Description |
| --- | --- | --- |
| `/create-mobile-app` | ✅ v0 | Orchestrator — starts from a fresh installed `expo-app-standalone` template folder, gates planning, runs `npx power-apps init`, resolves the selected environment tenant, lets the user paste an app registration client ID, create one in the portal and paste it, or skip auth for later, then applies data/native/connectors, builds screens, starts dev server |
| `/set-app-registration-native` | ✅ v0 | Manual auth helper — opens the Power Apps Wrap app-registration page for the selected environment, captures the pasted client ID, and writes `auth.config.json`. |
| `/add-dataverse` | ✅ v0 | Add Dataverse — connect to existing tables, or create / extend tables in Tier 0 → N order via the Dataverse Web API, then generate TS services. Accepts ER diagrams via image / Mermaid / text, or spawns the data-model-architect agent. |
| `/setup-datamodel` | ✅ v0 | Discoverable alias for `/add-dataverse` optimized for the design-first entry point ("how do I plan my Dataverse schema?"). Same workflow under a more searchable name. |
| `/add-connector` | ✅ v0 | Generic connector — runs `npx power-apps add-data-source` for any first-party or custom connector |
| `/add-native` | ✅ v0 | Add a supported native capability/control (camera, image-picker, barcode/QR scanner, document-picker, PDF viewer/report, pen/signature, secure-store, file-system, sharing, etc.) — verifies the module already ships in the template and writes typed wrappers under `src/native/` without installing native packages or editing `app.config.js` |
| `/list-connections` | ✅ v0 | Finds or creates a Power Platform connection ID, or resolves a solution connection reference, for `npx power-apps add-data-source`. Use when adding non-Dataverse connectors or re-binding after a 401. |
| `/edit-app` | ✅ v0 | Post-generation app editor — updates affected sections of `native-app-plan.md`, applies Dataverse/native/design/connector changes, rebuilds affected screens, runs verification, updates `memory-bank.md`, and regenerates `preview.html` when UI changed. `--plan-only` preserves the old docs-only behavior. |
| `/deploy` | ✅ v0 | Build + push — `npm run build` then `npx power-apps push` to the env in `power.config.json`. **Does not** drive `expo run:ios` or `expo run:android` (out of scope for v0). |
| `/open-wrap-url` | ✅ v0 | Opens the Wrap URL in browser for an app ID using `https://make.powerapps.com/environments/<envID>/wrap?appID=<appID>`. Requires both `--app-id` and `--env-id`. |
| `/report-issue` | ✅ v0 | Read-only diagnostic — collects env / Expo / Node versions, project context, recent errors, and renders a copy-paste-ready GitHub issue body. Sanitizes secrets. |
| `/design-system` | ✅ v0 | End-to-end design system — collects brand inputs (logo, brand doc, website, free text, canvas app, code app, Figma), runs a 3-style visual picker, writes `brand/design-system.md` + `brand/tokens.ts`, renders branded screen previews. Auto-invoked at Step 6.75 of `/create-mobile-app`; also standalone. |
| `/preview-screens` | ✅ v0 | Renders generated TSX screens as a browser-viewable HTML preview (no Metro needed). Uses Tamagui → HTML mapping. |
| `/add-datasource` | ✅ v0 | Alias for `/add-connector` — discoverable name for "how do I connect to X?" |
| `/add-sharepoint`, `/add-teams`, `/add-office365`, `/add-excel`, `/add-onedrive`, `/add-azuredevops` | 🟡 v1 | Pre-filled wrappers around `/add-connector` |
| `/setup-offline-profile` | 🟡 v0.1 | Create a Dataverse Mobile Offline Profile for the app's tables. One consolidated configuration questionnaire (no per-step approval clicks), schema+screen-aware architect proposal, single `accept` confirm. Writes `offline-profile.json`; never mutates `power.config.json`. Author-only — no runtime stubs in the generated app yet; runtime support is deferred until upstream host support is confirmed. Auto-proposed by `/create-mobile-app` Step 6.85 for offline-relevant apps; also runs standalone on existing apps. |
| `/enable-tables-offline` | 🟡 v0.1 | Pre-flight pass — flip `IsAvailableOffline` + `ChangeTrackingEnabled` on selected tables' EntityMetadata, then `PublishAllXml`. Idempotent. Mostly a no-op for fresh scaffolds since `/add-dataverse` Step 5b now sets these flags at create time; primary use case is fixing legacy / imported tables. |
| `/assign-offline-profile` | 🟡 v0.1 | Bind users / teams to a Mobile Offline Profile via `usermobileofflineprofilemembership` / `teammobileofflineprofilemembership` rows. Without this, the profile exists but no one's app uses it. Accepts `--user <upn>`, `--team <name>`, `--me`, `--all-app-users`, `--unassign-*` flags. |
| `/edit-offline-profile` | 🟡 v0.1 | Change ONE aspect of an existing profile (table scope, sync frequency, column list, name/description) without re-running the full wizard. Mirrors the `/edit-app` gated edit pattern. Accepts `--rename`, `--table X --scope`, `--table X --sync`, `--table X --columns add:/remove:/reset` flags. |
| `/add-table-to-offline-profile` | 🟡 v0.1 | Add ONE new table to an existing profile (typically after running `/add-dataverse` to extend the data model). Auto-enables table prereqs; single scope-picker question; POST item + PATCH selectedcolumns + publish. `--all-new` for bulk-adding every manifest table not yet in the profile. |
| `/preview-offline-scope` | 🟡 v0.1 | Read-only diagnostic. Per-table row count + cache-size estimate + sync-cost forecast. Useful before `/assign-offline-profile` (so users don't get surprised by data caps) and after `/edit-offline-profile` to gauge impact. Wraps `verify-offline-profile.js` with row-count probes. |

## Agents

| Agent | Role |
| --- | --- |
| `native-app-planner` | Orchestrator — coordinates the data-model + screen-planner architects, plans native capabilities + connectors inline, runs 4 approval gates |
| `data-model-architect` | Read-only — discovers Dataverse, scores reuse / extend / create, returns an ER section |
| `screen-planner` | Read-only — picks navigation pattern, designs per-screen specs |
| `screen-builder` | Mutation — writes ONE TSX file per assigned screen, runs N in parallel |
| `offline-profile-architect` | Read-only — proposes per-table row scope, relationships, selected columns, sync frequency; returns `_offline_section.md` for `/setup-offline-profile` to embed in `native-app-plan.md` |

## Mobile Plugin Snapshot

| Area | `mobile-app` (this plugin) |
|---|---|
| Stack | Expo + React Native + TypeScript |
| Targets | iOS, Android |
| Native APIs | Camera, location, biometrics, push, sensors (Expo SDK) |
| Data access | Power Platform connectors |
| Generated services | `src/generated/services/` |
| Deploy | `npm run build` + `npx power-apps push` |

## Shared resources

| File | Purpose |
| --- | --- |
| [`shared/shared-instructions.md`](shared/shared-instructions.md) | **Read first by every skill.** Cross-cutting safety rules, memory-bank protocol, preferred-environment policy, connector-first rule, OS-aware CLI invocation, command-failure handling, prompt-injection guard, sub-skill invocation, execution style. |
| [`shared/version-check.md`](shared/version-check.md) | Single source of truth for minimum tool versions. Always-required: Node 22+, npm 10+. Conditional: `az` 2.60+ for ADO npm token setup and `/add-dataverse` token acquisition. Xcode/JDK/Android Studio are documented but **not gated by any skill** — user-managed if they want local native builds. |
| [`shared/preferred-environment.md`](shared/preferred-environment.md) | Environment selection priority: `power.config.json` → memory-bank → explicit environment URL/ID. Never silent switches. |
| [`shared/connector-reference.md`](shared/connector-reference.md) | Connection ID workflow, common API names, dataset/table discovery, Grep-not-Read pattern for large generated files. |
| [`shared/references/expo-mcp.md`](shared/references/expo-mcp.md) | **Opt-in MCP server** — the plugin's [`.mcp.json`](.mcp.json) registers `expo-mcp` (MIT, free, local-only) pointed at the Metro dev server (`http://localhost:8081`). Skills prefer 5 structured `expo.*` tools (project info, SDK-matched installs, plugin effects preview, build with parsed errors, doctor diagnostics) when the host advertises them; shell fallback otherwise. **Dev loop**: while `npm run dev` is running, the agent reads live runtime errors via MCP, fixes code, and Metro hot-reloads. No EAS/cloud calls. |
| [`shared/memory-bank.md`](shared/memory-bank.md) | Per-project notebook template — copied into the working directory by `/create-mobile-app` Step 6. Tracks data-model decisions, connectors bound, screens built, build history. Read at start of every skill, updated after each successful step, enables resume on failure. |
| [`hooks/`](hooks/) | PostToolUse validator hook — runs per-skill validators after a Skill tool call (currently scaffolded; v0 ships with no validators yet). |
| [`shared/references/offline-profile-schema.md`](shared/references/offline-profile-schema.md) | Canonical Dataverse entity field map for the three Mobile Offline Profile entities (`mobileofflineprofile`, `mobileofflineprofileitem`, `mobileofflineprofileitemassociation`) + the per-table `EntityMetadata` prereqs. Source of truth for POST body shapes. |
| [`shared/references/dataverse-offline-api.md`](shared/references/dataverse-offline-api.md) | Web API recipes — every PUT/POST/PATCH/DELETE that `/setup-offline-profile` and `/enable-tables-offline` issue, with §-numbered sections each skill step references. |

## Known blockers

1. **Fresh template preparation.** `/create-mobile-app` expects a fresh installed `expo-app-standalone` template working directory. Use `degit` to materialize [`plugins/mobile-apps/template`](https://github.com/microsoft/power-platform-skills/tree/main/plugins/mobile-apps/template), then run `npm install` in that template folder before invoking the skill there.
2. ~~**Sub-agent slash-command limitation.**~~ ✅ **Resolved** — `/design-system` (Step 6.75) now runs as a top-level skill invocation by the orchestrator, not inside a sub-agent. The old `DESIGN_VIBE_REQUESTED:` handoff signal is no longer needed.
3. ~~**Connector usage requires the player runtime.**~~ ✅ **Resolved** — `PowerAppsHostProvider` in `app/_layout.tsx` (from `power-apps-native-host`) handles all connector routing, connection resolution, disambiguation, and OAuth consent automatically. No separate executor or provider wiring needed.

## Local Zip Install

For a local checkout, install from the marketplace repository root:

```bash
cd /path/to/power-platform-skills
node scripts/install.js
```

To install only this plugin, register the repository root as a marketplace and install `mobile-app@power-platform-skills` directly with the Claude or Copilot plugin CLI.

## See also

- [`plugins/mobile-apps/template`](https://github.com/microsoft/power-platform-skills/tree/main/plugins/mobile-apps/template) — bundled Expo standalone template and fresh-template working directory source
- [Expo docs](https://docs.expo.dev/)
- [Power Apps developer docs](https://learn.microsoft.com/en-us/power-apps/developer/)
