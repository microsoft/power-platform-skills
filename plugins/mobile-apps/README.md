# Power Apps Standalone App Template

This template is an Expo, React Native, and TypeScript starter for building a standalone mobile app that connects to Power Platform data through `@microsoft/power-apps-native-host`.

> **Plugin status:** v0.3.0. The template records source and compatibility in
> `.powerapps-native/version.json`; plan status/rendering and Product Experience
> validation follow the canonical four-gate architecture described below.

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

    1. Open the Extensions pane.
    2. Enter `@agentPlugins mobile-app` in the search box.
    3. Select the **mobile-app** plugin and install it.
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

    For a local UX prototype with deterministic mock data and no Power
    Platform environment yet, run this instead:

    ```text
    /create-mobile-prototype
    ```

    Both commands use the same installed template, planner, design system,
    native wrappers, screen builders, and quality gates. The prototype path
    writes no Dataverse metadata and can later be converted in place with
    `/prototype-to-real-app`.

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

The plugin is conversational — you describe what you want and the skill drives the rest. Six typical flows:

### 1. Create a new app from a one-liner

```text
> /create-mobile-app I want a field inspection app where technicians log site visits with photos, GPS location, and notes
```

What happens:
1. **Gate 1** — confirms requirements, primary product structure, workflow capabilities,
    operating context, target platforms/environment, and any visual references
2. **Gate 2** — approves complete architecture: data, projections, offline,
    native capabilities, connectors, and blockers
3. **Gate 3** — approves Product Experience through a validated structural
    preview: screen graph/specs, visual character, Home hierarchy, First
    Viewport geometry, action ownership, media, navigation, and reference
    fidelity
4. **Gate 4** — final implementation confirmation
5. **Design system** — materializes the approved experience into composition,
    signature components, brand tokens, typography, components, and previews
6. **Scaffold + build** — validates the prepared template folder, runs `npx power-apps init`, verifies installed dependencies, generates schemas, builds Dataverse tables, wires connectors, and spawns N parallel screen-builders for the TSX
7. **Refine + validate** — `/design-react-native-app` runs in non-interactive,
    plan-aware, UI-only mode; changed files then pass quality, contrast,
    composition, route, and TypeScript gates
8. **Dev server + visual QA** — `npm run dev` starts Metro; scan the QR with
    your native dev client on a device. Native screenshot/view-tree checks then
    verify Home, tab silhouettes, clipping, media, premium/reference fidelity,
    and required RTL locale coverage.

End state: a working app you can iterate on with hot reload. ~5–12 minutes for the planning gates, then scaffolding runs.

### 2. Prototype first, connect to Power Platform later

```text
> /create-mobile-prototype I want a warehouse inspection app with scan-first lookup, checklists, and photo evidence
```

The skill plans a Dataverse-style schema without selecting an environment,
generates deterministic local CRUD services and realistic linked seed rows,
builds the same production-quality screens, and starts Metro without requiring
Microsoft sign-in. Planned external connectors are visible throw-stubs, so an
unsupported interaction fails clearly instead of silently succeeding.

When the model and UX are approved:

```text
> /prototype-to-real-app --environment <environment-id>
```

Graduation binds the existing project, reconciles placeholder entities against
live Dataverse, replaces mocks/connectors, optionally carries seed scenarios
into real tables, restores auth/schema generation, and rebinds affected screens.
It does not scaffold another app.

### 3. Add Dataverse tables to an existing app

```text
> /add-dataverse I need an Asset table with name, serial number, and a lookup to an existing Account
```

Or paste an ER diagram (image / Mermaid / text). The data-model-architect agent discovers what already exists in your environment, scores reuse vs extend vs create, walks through approval, then creates the tables in dependency order and regenerates `src/generated/services/`.

### 4. Add a native capability

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

### 5. Add a connector

```text
> /add-sharepoint                # SharePoint Online lists / documents
> /add-connector                 # any other Power Platform connector
```

Runs `npx power-apps add-data-source` under the hood, regenerates services, prints how to import in your screens.

### 6. Iterate on the generated app after the fact

```text
> /edit-app "Improve the search screen to make it easier to use on mobile"
> /deploy                        # npm run build + npx power-apps push
> /open-wrap-url --app-id <id> --env-id <env-id>   # open make.powerapps.com Wrap page for this app
> /preview-screens               # browser preview of generated screens (no Metro needed)
> /visual-qa                     # native screenshot + Product Experience verification
> /list-connections              # diagnostic when a service call returns 401
> /report-issue                  # copy-paste-ready GitHub issue body
```

Use `/edit-app` for post-generation improvements. It first inspects the existing app and asks only for missing intent details (which screen, table, scanned field, launch point, brand source, etc.). Then it updates `native-app-plan.md` when the request changes the plan, applies the generated app edits, runs the relevant verification, updates `memory-bank.md`, and regenerates `preview.html` when UI changed. You do not need to manually run `npm run generate-schemas`, `npx tsc --noEmit`, or `/preview-screens` after each edit unless you are doing diagnostics outside the skill.

For a mock-backed prototype, `/edit-app` regenerates local schema/services and
uses `/sync-from-plan`; it never creates real tables or connections. Requests
such as "make this real", "connect this prototype to Dataverse", or "choose an
environment" route to `/prototype-to-real-app`.

Common follow-ups:

| Prompt | What `/edit-app` does |
|---|---|
| "Improve the search screen for mobile" | Re-plans/rebuilds the affected search or list screen, then previews. |
| "Add loading, empty, and error states" | Updates the screen spec and TSX state handling, then type-checks. |
| "Add a detail screen for the selected record" | Updates navigation contracts, creates the detail route, and updates the source screen navigation. |
| "Update the design to match branding" | Token-only requests use design refresh; premium/reference/composition changes update Product Experience, rebuild affected screens, and run native visual QA. |
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
| `/edit-app "Update the design to better match company branding"` | Brand/reference source and whether scope is tokens, component grammar, composition/media/navigation, personality, or full redesign | Product Experience update for structural scope, `/design-system` materialization, affected screen rebuild, validators, static preview, native visual QA |

## Commands

| Command | Status | Description |
| --- | --- | --- |
| `/create-mobile-app` | ✅ v0 | Orchestrator — starts from a fresh installed `expo-app-standalone` template folder, gates planning, runs `npx power-apps init`, resolves the selected environment tenant, lets the user paste an app registration client ID, create one in the portal and paste it, or skip auth for later, then applies data/native/connectors, builds screens, starts dev server |
| `/create-mobile-prototype` | ✅ v0 | Prototype orchestrator — starts from the same fresh installed template, runs environment-free approval gates, writes a non-executable structured data contract, generates deterministic local CRUD services/seed data and connector throw-stubs, builds polished screens, and starts Metro without Power Platform provisioning. |
| `/prototype-to-real-app` | ✅ v0 | Resumable in-place graduation — binds a prototype to a selected environment, rebases placeholder publisher names, live-reconciles and applies Dataverse, replaces connector stubs, optionally reuses seed scenarios, proves all mocks are gone, restores auth/runtime, and commits Dataverse state after one final sync. |
| `/sync-from-plan` | ✅ v0 | Reconciles an existing prototype or real app from `native-app-plan.md`; refreshes service/field bindings, routes, shared code, affected screens, quality gates, preview, and lifecycle hashes. Conversion uses its target-mode gate to commit `dataverse`. |
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
| `/design-system` | ✅ v0 | Materializes approved Product Experience from brand/reference inputs (logo, brand doc, website, free text, canvas app, code app, Figma, or screenshots) into composition, media/navigation/signature components, `brand/design-system.md`, `brand/tokens.ts`, typography, a gallery, and branded previews. Presets never override archetype/composition. Auto-invoked by `/create-mobile-app`; also standalone. |
| `/design-react-native-app` | ✅ v0 | Automated LLM design refinement agent. Reviews generated screens for visual coherence, RTL support, accessibility, and Unsplash imagery usage, applying direct stylistic improvements. Often invoked automatically after deterministic styling sweeps. |
| `/preview-screens` | ✅ v0 | Renders generated TSX screens through Tamagui-to-HTML mapping as a static browser approximation (no Metro). Useful for sharing, but not a native fidelity or release gate. |
| `/visual-qa` | ✅ v0 | Runs native Expo screenshot/view-tree QA against Product Experience and design intake, checks geometry/media/safe areas/Dynamic Type/tab silhouettes, repairs focused drift, and writes `.visual-qa/report.md`. |
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
| `native-app-planner` | Orchestrator — coordinates architecture and experience planning for Gates 2–3; product archetype and visual personality remain independent |
| `data-model-architect` | Read-only — discovers Dataverse, scores reuse / extend / create, returns an ER section |
| `screen-planner` | Read-only — picks navigation pattern, designs per-screen specs |
| `screen-builder` | Mutation — writes ONE TSX file per assigned screen, runs N in parallel |
| `offline-profile-architect` | Read-only — proposes per-table row scope, relationships, selected columns, sync frequency; returns `_offline_section.md` for `/setup-offline-profile` to embed in `native-app-plan.md` |

## Known blockers

## See also

- [Product Archetype and UX Architecture Report](docs/product-archetype-architecture-report.md) — CMMS vs field inspection case study, decision ownership, implemented contracts, migration, and validation architecture
- [`plugins/mobile-apps/template`](https://github.com/microsoft/power-platform-skills/tree/main/plugins/mobile-apps/template) — bundled Expo standalone template and fresh-template working directory source
- [Expo docs](https://docs.expo.dev/)
- [Power Apps developer docs](https://learn.microsoft.com/en-us/power-apps/developer/)
