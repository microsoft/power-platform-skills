# Power Apps Standalone App Template

This template is an Expo, React Native, and TypeScript starter for building a standalone mobile app that connects to Power Platform data through `@microsoft/power-apps-native-host`.

## Requirements

- Node.js 24 LTS.
- npm 10 or newer.
- The Power Apps Mobile Preview app from the Apple App Store or Google Play.

## Setup

**Building native mobile apps with Power Platform is in Private Preview; do not use this in production.**

Have questions or feedback? Join the [Native Apps Office Hours](OFFICE_HOURS.md).

Start from the Power Platform mobile app template, then use the mobile-app
skill to generate the app plan, data model, screens, native capabilities, and
connector wiring.

1. Select a verified release and create a new app from its immutable template:

    ```sh
    node "${PLUGIN_ROOT}/scripts/resolve-mobile-release.js" --default
    node "${PLUGIN_ROOT}/scripts/mobile-template-lifecycle.js" acquire \
      --release "<reviewed-release-id>" --destination ./my-mobile-app
    cd my-mobile-app
    npm ci
    ```

    `${PLUGIN_ROOT}` is the installed mobile-app plugin directory. Acquisition
    and dependency installation require approval. The helper checks the exact
    package version, integrity, and compatibility manifest and never overwrites
    a non-empty target. Use existing npm user/environment authentication; it
    does not provision registry credentials.

    **Release gate:** the reviewed policy currently contains no release/default.
    These commands therefore block until maintainers verify matching template,
    host, native dependencies, Android/iOS bases, and available players. Do not
    substitute `latest`, a Git branch, or the bundled template to bypass this
    check. Existing source-only editing remains possible without claiming native
    compatibility. See [the lifecycle contract](shared/references/mobile-release-lifecycle.md).

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

    The template includes this host package and the required Expo / React Native
    runtime dependencies. The skill updates the app in place as it designs and
    generates the mobile experience.

    When prompted to sign in, use credentials for the tenant where the Dataverse
    environment belongs.

4. Select or create the Microsoft Entra app registration.

    `/create-mobile-app` uses your Azure CLI sign-in to list all app registrations
    that Microsoft Graph allows you to read in the selected environment's tenant.
    Registrations passing every applicable native runtime permission check appear first, and
    the rest remain available through pagination. Each choice shows only a short
    client-ID prefix and either `✓ All required permissions configured` or
    `✗ Missing required permissions`. The full client ID and missing-permission
    details are shown after selection.
    Discovery is best-effort: if Azure CLI,
    Microsoft Graph, tenant validation, or permission checking fails, the skill
    immediately falls back to asking for the app registration client ID and
    continues with its permission check marked unavailable.

    To create a registration or repair one whose permissions are incomplete,
    open the Power Apps Wrap page for the selected environment:

    ```text
    https://make.powerapps.com/environments/<environment-id>/wraps#create-app-registration
    ```

    The Wrap experience configures the native registration, flags missing
    permissions, and offers one-click repair. Do not add redirect URIs or API
    permissions manually. Some repairs and consent operations require an Azure
    tenant admin.

    If the app was created without a client ID, run
    `/set-app-registration-native` later from the app folder. It provides the
    same discovery and verification flow before writing `auth.config.json`.

    ### Required API permissions

    The read-only checker validates the native runtime profile. The baseline is
    Dynamics CRM `user_impersonation` plus Power Platform API
    `PowerApps.Apps.Read`. Apps using Power Platform connectors additionally
    require Azure API Connections `Runtime.All` and the Power Platform API
    `Connectivity.Connectors.Read`, `Connectivity.Connections.Read`,
    `Connectivity.Connections.Write`, and
    `Connectivity.Connections.UserConsent` scopes. The checker does not require
    unrelated Wrap packaging permissions. Platform redirects, packaging
    permissions, third-party-app allowlisting, and admin consent are finalized
    in Wrap.

5. Start mobile app:

    `/create-mobile-app` starts Metro with `npm run dev`; its `predev` lifecycle
    runs schema generation and type-checking before Expo starts.
    The template's Metro config delegates sanitized logging to the native host package, which writes `.powernative/metro-logs/`,
    so `/debug-app` works after switching between VS Code, Copilot CLI, and
    Claude Code without asking for a terminal ID.

    To start Metro manually instead, run the command below from the app directory.
    Manual starts and `/debug-app` use the same `.powernative` log source.

    ```bash
    npm run dev
    ```

    The Metro config removes sensitive lines before writing logs. The complete
    `.powernative/` folder is ignored by the template's `.gitignore`.

6. Preview the app by scanning the QR code with the Power Apps Mobile Preview app

    - App store: https://apps.apple.com/us/app/power-apps-developer/id6753083462
    - Play store: https://play.google.com/store/apps/details?id=com.microsoft.PreviewApp

## License and notices

This template is provided under the license in `LICENSE`.

The mobile-app plugin is stored in `plugins/mobile-apps` in the `power-platform-skills` marketplace. It works with GitHub Copilot in VS Code and Claude Code.

## Updating an existing app

`/check-updates` **offers to update** a verified native release as a unit:
template migrations, host, Expo/React Native, native inventory, and matching
bases/players. It checks for stale templates even when the host was already
updated and supports same-template host repair. It previews every migration in
a disposable copy, then asks separately before applying the full reviewed
chain. Customer code, settings, local changes, and instruction files are preserved.

Managed/native packages are never offered as unrelated npm bumps. Pure-JS
dependencies retain individual approval, validation, rollback, and direct-advisory
auditing. Unsupported metadata, conflicts, unavailable releases, and incomplete
previews block changes rather than inventing state. See
[the lifecycle contract](shared/references/mobile-release-lifecycle.md).

When an old app has no supported migration, retain the original app and report
the missing route. Do not run the new-project CLI over it, replace its root
configuration wholesale, or rewrite its protected compatibility IDs.

## Existing native controls

When a verified release includes `@microsoft/power-apps-native-controls`,
`/add-native` routes PDF viewing, pen capture, and geolocation to its public
`/pdf`, `/pen`, and `/geolocation` subpaths. Older releases use only the leaf
APIs their binary actually ships; installing the aggregate is not a binary
upgrade. Barcode is not an aggregate subpath.

The template owns the dependency; a compatible host owns plugin registration.
Merely adding the package does not grant runtime permissions or start tracking.
Existing Android library declarations can remain even for unused controls.
This workflow uses a fixed-capability base, not per-customer optional-permission
selection during wrapping. Different declarations require another verified base.

## Hello world — your first run

After the prereq sanity check passes:

```text
> /create-mobile-app build me a small notes app
```

Expected: ~6 prompts (wizard + gates), then ~5 minutes of scaffolding, table creation, and parallel screen builds. End state: a working Notes app with a project-local Metro session ready to scan and debug. If anything fails, the [memory bank](#glossary) remembers where you left off — re-run the same command and it resumes.

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
4. **Up to 4 approval gates** — data platform + native capabilities + connectors → Dataverse model when selected → screen graph → screen specs (reviewed in markdown before code is written)
5. **Design system** — brand inputs (logo, brand doc, website, or free-text) → cost picker → style picker → component reference sheet → branded screen previews
6. **Scaffold + build** — validates the prepared template folder, runs `pa app init`, verifies installed dependencies, generates schemas, builds Dataverse tables, wires connectors, spawns N parallel screen-builders for the TSX
7. **Dev server** — the plugin starts a portable Metro session; scan the QR with your native dev client and use `/debug-app` against its persisted sanitized log

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
> /add-native haptics           # expo-haptics impact, selection, and notification wrapper
```

Native modules are allowlist-bound by the current template `package.json`. If the relevant package is present, `/add-native` can use it through the proper wrapper or host control. If the package is absent, the skill does not install it or fake support; it adds a transparency note and stops for that capability. For example, push notifications require `expo-notifications`; if the template does not ship it, notifications cannot be added until the upstream template includes it.

### 4. Add a connector

```text
> /add-sharepoint                # SharePoint Online lists / documents
> /add-connector                 # any other Power Platform connector
```

Runs `pa app add data-source` under the hood, regenerates services, prints how to import in your screens.

### 5. Iterate on the generated app after the fact

```text
> /edit-app "Improve the search screen to make it easier to use on mobile"
> /deploy                        # npm run build + pa app push
> /open-wrap-url --app-id <id> --env-id <env-id>   # open make.powerapps.com Wrap page for this app
> /preview-screens               # browser preview of generated screens (no Metro needed)
> /list-connections              # diagnostic when a service call returns 401
> /check-updates                 # ordered dependency updates
> /report-issue                  # copy-paste-ready GitHub issue body
```

Use `/edit-app` for post-generation improvements. It first inspects the existing app and asks only for missing intent details (which screen, table, scanned field, launch point, brand source, etc.). Then it updates `native-app-plan.md` when the request changes the plan, applies the generated app edits, runs the relevant verification, updates `memory-bank.md`, and regenerates `preview.html` when UI changed. You do not need to manually run `npm run generate-schemas`, `npx --no-install tsc --noEmit`, or `/preview-screens` after each edit unless you are doing diagnostics outside the skill.

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
| `/create-mobile-app` | ✅ v0 | Orchestrator — starts from a fresh installed `expo-app-standalone` template folder, gates planning, runs `pa app init`, resolves the selected environment tenant, discovers tenant-visible app registrations and checks the complete required permission profile, lets the user select or create one (or skip auth), then applies data/native/connectors, builds screens, starts dev server |
| `/set-app-registration-native` | ✅ v0 | Auth helper — discovers tenant-visible app registrations, checks the applicable native runtime permission profile, opens the environment-specific Wrap page for creation or repair, and writes the selected client ID to `auth.config.json`. |
| `/add-dataverse` | ✅ v0 | Add Dataverse — connect to existing tables, or create / extend tables in Tier 0 → N order via the Dataverse Web API, then generate TS services. Accepts ER diagrams via image / Mermaid / text, or spawns the data-model-architect agent. |
| `/setup-datamodel` | ✅ v0 | Discoverable alias for `/add-dataverse` optimized for the design-first entry point ("how do I plan my Dataverse schema?"). Same workflow under a more searchable name. |
| `/add-connector` | ✅ v0 | Generic connector — runs `pa app add data-source` for any first-party or custom connector |
| `/add-native` | ✅ v0 | Add a supported native capability/control (camera, image-picker, barcode/QR scanner, document-picker, PDF viewer/report, pen/signature, secure-store, file-system, sharing, haptics, etc.) — verifies the module already ships in the template and writes typed wrappers under `src/native/` without installing native packages or editing `app.config.js` |
| `/list-connections` | ✅ v0 | Finds or creates a Power Platform connection ID, or resolves a solution connection reference, for `pa app add data-source`. Use when adding non-Dataverse connectors or re-binding after a 401. |
| `/edit-app` | ✅ v0 | Post-generation app editor — updates affected sections of `native-app-plan.md`, applies Dataverse/native/design/connector changes, rebuilds affected screens, runs verification, updates `memory-bank.md`, and regenerates `preview.html` when UI changed. `--plan-only` preserves the old docs-only behavior. |
| `/debug-app` | ✅ v0 | Monitors live `.powernative/metro-logs/` files with a durable byte cursor, stores host-neutral cursor/audit/health state under `.powernative/debug-app/`, diagnoses runtime and silent data-path failures, and verifies bounded fixes without depending on host terminal IDs. |
| `/setup-app-insights` | ✅ v0 | Configure optional customer-owned Application Insights telemetry — discover or accept an existing Azure resource and wire `app.json` → `expo.extra.appInsightsConfig` + `PowerAppsProvider`, change the resource, or disable it. Off by default; invoking it is the opt-in. Also delegated to by `/edit-app`. Never provisions Azure resources or stores the connection string. |
| `/check-updates` | ✅ v0 | Offers a coordinated verified native release/template upgrade or host repair, then individually approved JS-only updates and direct-advisory auditing. Full-chain preview, explicit application approval, validation, and rollback; never independent native bumps. |
| `/deploy` | ✅ v0 | Build + push — `npm run build` then `pa app push` to the env in `power.config.json`. **Does not** drive `expo run:ios` or `expo run:android` (out of scope for v0). |
| `/open-wrap-url` | ✅ v0 | Opens the Wrap URL in browser for an app ID using `https://make.powerapps.com/environments/<envID>/wrap?appID=<appID>`. Requires both `--app-id` and `--env-id`. |
| `/report-issue` | ✅ v0 | Read-only diagnostic — collects env / Expo / Node versions, project context, recent errors, and renders a copy-paste-ready GitHub issue body. Sanitizes secrets. |
| `/telemetry` | ✅ v0 | Enable, disable, or show the per-user Mobile Apps telemetry transmission preference. |
| `/design-system` | ✅ v0 | End-to-end design system — collects brand inputs (logo, brand doc, website, free text, canvas app, code app, Figma), runs a 3-style visual picker, writes `brand/design-system.md` + `brand/tokens.ts`, renders branded screen previews. Auto-invoked at Step 6.75 of `/create-mobile-app`; also standalone. |
| `/preview-screens` | ✅ v0 | Renders generated TSX screens as a browser-viewable HTML preview (no Metro needed). Uses Tamagui → HTML mapping. |
| `/add-datasource` | ✅ v0 | Alias for `/add-connector` — discoverable name for "how do I connect to X?" |
| `/add-sharepoint`, `/add-teams`, `/add-office365`, `/add-excel`, `/add-onedrive`, `/add-azuredevops` | 🟡 v1 | Pre-filled wrappers around `/add-connector` |
| `/setup-offline-profile` | 🟡 v0.1 | Create a Dataverse Mobile Offline Profile for the app's tables. One consolidated configuration questionnaire (no per-step approval clicks), schema+screen-aware architect proposal, single `accept` confirm. Writes `offline-profile.json`; never mutates `power.config.json`. The bundled offline package is consumed by the native host for local storage, queued synchronization, reconnect handling, and status UX, so the skill configures the host runtime instead of generating duplicate app-owned offline infrastructure. Offered explicitly by `/create-mobile-app` after Dataverse materialization; connectivity wording in the initial prompt does not auto-enable it. Also runs standalone on existing apps. |
| `/enable-tables-offline` | 🟡 v0.1 | Pre-flight pass — flip `IsAvailableOffline` + `ChangeTrackingEnabled` on selected tables' EntityMetadata, then `PublishAllXml`. Idempotent. Mostly a no-op for fresh scaffolds since `/add-dataverse` Step 5b now sets these flags at create time; primary use case is fixing legacy / imported tables. |
| `/assign-offline-profile` | 🟡 v0.1 | Bind users / teams to a Mobile Offline Profile via `usermobileofflineprofilemembership` / `teammobileofflineprofilemembership` rows. Without this, the profile exists but no one's app uses it. Accepts `--user <upn>`, `--team <name>`, `--me`, `--all-app-users`, `--unassign-*` flags. |
| `/edit-offline-profile` | 🟡 v0.1 | Change ONE aspect of an existing profile (table scope, sync frequency, column list, name/description) without re-running the full wizard. Mirrors the `/edit-app` gated edit pattern. Accepts `--rename`, `--table X --scope`, `--table X --sync`, `--table X --columns add:/remove:/reset` flags. |
| `/add-table-to-offline-profile` | 🟡 v0.1 | Add ONE new table to an existing profile (typically after running `/add-dataverse` to extend the data model). Auto-enables table prereqs; single scope-picker question; POST item + PATCH selectedcolumns + publish. `--all-new` for bulk-adding every manifest table not yet in the profile. |
| `/preview-offline-scope` | 🟡 v0.1 | Read-only diagnostic. Per-table row count + cache-size estimate + sync-cost forecast. Useful before `/assign-offline-profile` (so users don't get surprised by data caps) and after `/edit-offline-profile` to gauge impact. Wraps `verify-offline-profile.js` with row-count probes. |

## Agents

| Agent | Role |
| --- | --- |
| `native-app-planner` | Orchestrator — approves data platform + native capabilities + connectors, conditionally coordinates the data-model architect, coordinates screen planning, and runs up to 4 approval gates |
| `data-model-architect` | Read-only — discovers Dataverse, scores reuse / extend / create, returns an ER section |
| `screen-planner` | Read-only — picks navigation pattern, designs per-screen specs |
| `screen-builder` | Mutation — writes ONE TSX file per assigned screen, runs N in parallel |
| `offline-profile-architect` | Read-only — proposes per-table row scope, relationships, selected columns, sync frequency; returns `_offline_section.md` for `/setup-offline-profile` to embed in `native-app-plan.md` |

## Telemetry and privacy

The Mobile Apps plugin sends usage and measured workflow telemetry to Microsoft by default. Events can include skill and checkpoint names, plugin/agent/OS/Node versions, random app/run/span/event IDs, measured durations, outcomes, retry attempts, and fixed error classifications. When verified target metadata is available, events can also include Power Platform environment and Entra tenant IDs plus the Dataverse organization ID.

Events never include Entra user/object IDs, Dataverse user IDs, prompts, arguments, tool inputs, business records, document contents, file paths, cwd, app/site names, URLs, credentials, usernames, email addresses, hostnames, or raw error descriptions. Organization and environment identifiers are identifying metadata, not anonymous user counts. The same field filtering applies before local logging and transmission.

Before local logging and again before transmission (including replay), the dispatcher retains organization, tenant, and environment IDs only when they match the current project's verified span or ancestor context. A missing, pruned, or mismatched verification record drops those identifiers while preserving the remaining usage event.

Prompt and Skill-tool hooks remain legacy activity observations and can both fire for one visible command. Measured metrics use schema-v2 lifecycle records with explicit run/span IDs instead. A missing terminal event remains incomplete; it is not inferred from a hook return. Each measured run returns a Support ID that can be included in an issue report without exposing project content.

Control the per-user transmission preference with:

```text
/mobile-app:telemetry status
/mobile-app:telemetry off
/mobile-app:telemetry on
```

`off` stops network transmission but retains the sanitized local diagnostic mirror under `~/.power-platform-skills/telemetry/mobile-app/sessions/<sessionId>/events.jsonl`. Private lifecycle state is retained separately under `~/.power-platform-skills/telemetry/mobile-app/runs/` for support reports and cross-process timing; it contains generated IDs, registered skill/checkpoint names, fixed states, and timestamps, never prompts or command content. Automation can force transmission off with `POWER_PLATFORM_SKILLS_TELEMETRY_MOBILE_APP_OPTOUT=1`; this overrides the saved preference and `on`.

## Known blockers

## See also

- [`plugins/mobile-apps/template`](https://github.com/microsoft/power-platform-skills/tree/main/plugins/mobile-apps/template) — bundled Expo standalone template and fresh-template working directory source
- [Expo docs](https://docs.expo.dev/)
- [Power Apps developer docs](https://learn.microsoft.com/en-us/power-apps/developer/)
