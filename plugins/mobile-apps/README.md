# Power Apps Standalone App Template

This template is an Expo, React Native, and TypeScript starter for building a standalone mobile app that connects to Power Platform data through `@microsoft/power-apps-native-host`.

## Requirements

- Node.js 22 LTS.
- npm 10 or newer.
- The Power Apps Developer app from the Apple App Store or Google Play.

## Setup

**Building native mobile apps with Power Platform is in Private Preview; do not use this in production.**

Start from the Power Platform mobile app template, then use the mobile-app
skill to generate the app plan, data model, screens, native capabilities, and
connector wiring.

1. Create a new app from the template and install dependencies:

    ```sh
    npx degit microsoft/power-platform-skills/plugins/mobile-apps/template#main my-mobile-app
    cd my-mobile-app
    npm install
    ```

2. Install the mobile-app plugin from the Power Platform Skills marketplace.

    For GitHub Copilot in VS Code:

    1. Open the Command Palette.
    2. Run **Chat: Install Plugin From Source**.
    3. Paste the mobile-app plugin manifest URL:

        ```text
        https://github.com/microsoft/power-platform-skills/tree/main/plugins/mobile-apps/.plugin/plugin.json
        ```

    4. Reload VS Code if prompted, then open Copilot Chat in Agent mode.

    Alternatively, install it from a terminal with GitHub Copilot CLI:

    ```sh
    copilot plugin marketplace add microsoft/power-platform-skills
    copilot plugin install mobile-app@power-platform-skills
    ```

    For Claude CLI:

    ```sh
    claude plugin marketplace add microsoft/power-platform-skills
    claude plugin install mobile-app@power-platform-skills --scope user
    ```

3. Open the template folder in VS Code and run the skill from Copilot Chat:

    ```text
    /create-mobile-app
    ```

    The template includes this host package and the required Expo / React Native
    runtime dependencies. The skill updates the app in place as it designs and
    generates the mobile experience.

    When prompted to sign in, use credentials for the tenant where the Dataverse
    environment belongs.

4. Create the Microsoft Entra app registration from Power Apps Wrap.

    Open the app-registration page for the Power Platform environment selected
    during `/create-mobile-app`:

    ```text
    https://make.powerapps.com/environments/<environment-id>/wraps#create-app-registration
    ```

    Create the registration on that page, copy its **Application (client) ID**,
    and paste it when `/create-mobile-app` asks. The Wrap experience configures
    the native app registration for this flow. You do not need to add redirect
    URIs or API permissions manually, and tenant-wide admin consent is not
    required.

    If the app was created without a client ID, run
    `/set-app-registration-native` later from the app folder. It opens the same
    environment-specific page and writes the pasted client ID to
    `auth.config.json`.

5. Start mobile app:

	Run the below command in a new terminal from the app directory.

    ```bash
    npm run dev
    ```

6. Preview the app by scanning the QR code with the Power Apps Developer app

    - App store: https://apps.apple.com/us/app/power-apps-developer/id6753083462
    - Play store: (coming soon)
    - App center: https://install.appcenter.ms/orgs/appmagic-player-x6ys/apps/rn-dev-player-preview/distribution_groups/public_distribution/releases

## License and notices

This template is provided under the license in `LICENSE`.

The mobile-app plugin is stored in `plugins/mobile-apps` in the `power-platform-skills` marketplace. It works with GitHub Copilot in VS Code and Claude Code.

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
| `/edit-app "Add barcode scanning and use the scanned value to search records"` | Scanner location, scanned value meaning, table/service/field to search, no/multiple-match behavior | `/add-native barcode-scanner`, data-model update if target field is missing, scanner/search screen rebuild, static gates, optional `/debug-app` handoff if you report a symptom |
| `/edit-app "Update the design to better match company branding"` | Brand source and scope: palette, typography, components/density, or full reskin | `/design-system --refresh` or `--reskin`, affected screen rebuild when layout grammar changes, style sweep, preview |

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

## Known blockers

## See also

- [`plugins/mobile-apps/template`](https://github.com/microsoft/power-platform-skills/tree/main/plugins/mobile-apps/template) — bundled Expo standalone template and fresh-template working directory source
- [Expo docs](https://docs.expo.dev/)
- [Power Apps developer docs](https://learn.microsoft.com/en-us/power-apps/developer/)
