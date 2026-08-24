# Power Apps Standalone App Template

This template is an Expo, React Native, and TypeScript starter for building a standalone mobile app that connects to Power Platform data through `@microsoft/power-apps-native-host`.

## Requirements

- Node.js 24 LTS.
- npm 10 or newer.
- The Power Apps Developer app from the Apple App Store or Google Play.
- For wrapped iOS push delivery: macOS with the installed Wrap/Xcode toolchain,
  Apple Developer team access, and a physical iPhone or iPad registered to that
  team. The preview supports registered-device `development` and `ad-hoc`
  builds only—not simulator, TestFlight, App Store, or enterprise distribution.

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

    ### Required API permissions

    The Microsoft Entra app registration requires these delegated permissions
    from the **Power Platform API**:

    - `PowerApps.Apps.Play`
    - `PowerApps.Apps.Read`
    - `Connectivity.Connectors.Read`
    - `Connectivity.Connections.Read`
    - `Connectivity.Connections.Write`
    - `Connectivity.Connections.UserConsent`

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

## Manual migration to a new template

To migrate without `upgrade-template`, create a new app from the latest template
instead of modifying the old app in place. Commit or back up the old app first.

1. Create the new app and install its dependencies.
2. Copy the contents of `app/` and `src/` from the old app into the same
    directories in the new app:

    ```bash
    cp -R ../old-app/app/. app/
    cp -R ../old-app/src/. src/
    ```

3. Copy app-owned assets and settings such as `assets/`, `auth.config.json`,
    `power.config.json`, and `offline-profile.json` as needed. Review each file
    before replacing the version supplied by the new template.
4. Keep the new template's `package.json`, root configuration files,
    `android/`, and `ios/`. Reapply old customizations selectively rather than
    copying these files wholesale.
5. Run `npm install`, `npm run type-check`, and the bundle command for each
    target platform, such as `npm run bundle:android` or `npm run bundle:ios`.
6. Give the resulting errors to GitHub Copilot in Agent mode and ask it to
    update the migrated `app/` and `src/` code for the new template APIs while
    preserving the new template configuration. Review the changes and rerun the
    failing command until the build succeeds.

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

Native modules are allowlist-bound by the current template `package.json`. Push notifications use the dedicated `/add-push-notifications` workflow because they require `expo-notifications`, React Native Firebase Messaging, permission UX, auth/topic lifecycle, and Expo Router deep links.

Notification delivery must be tested on matching wrapped physical-device
builds. Native client setup, sender authentication, and Power Automate flow
authoring are independent resumable stages. iOS adds two more independent
stages: a wrapped registered-device build and physical delivery verification.
An already integrated client can run `/create-push-notification-flow` directly;
a new or newly added native platform still runs `/setup-fcm`. The prescribed
iOS route is:

```text
/setup-fcm -> /setup-apple-ios -> /setup-apns -> /add-push-notifications
-> sender auth + /create-push-notification-flow -> /build-ios
-> /verify-ios-push
```

Push cloud setup is **official MCP-first**. `/setup-fcm` is the only supported
owner for Firebase project/app selection and requires the vendor-official
Firebase MCP; do not fall back to `firebase-tools` or other CLI/browser
automation when that MCP path is unavailable. Android package names and iOS
bundle identifiers are resolved from Expo config, so matching Firebase apps are
reused and only missing registrations are created. One exact match is reused
automatically; multiple safe exact matches require an explicit Android/iOS
app-ID choice, which is revalidated before client-config download.

Validated client files are stored as
`firebase/google-services.json` and
`firebase/GoogleService-Info.plist`. These client configurations are intended
to be committed, and the template discovers them automatically; project-relative
environment overrides remain available when needed. For iOS, `/setup-apple-ios` first creates or repairs a fresh, non-secret
`apple-ios-provisioning.json` for the exact Team and bundle. `/setup-apns` then
validates that Apple Team, explicit bundle identifier, and Push capability
handoff before guiding the user through the
only supported Firebase path: manual Apple APNs authentication-key (`.p8`)
upload in Firebase Console. Fastlane `pem`, APNs `.p12` generation, browser
automation, undocumented endpoints, and agent access to the one-time-downloaded
key are prohibited. Static completion is recorded as **configured, device
verification pending**. It remains pending until `/verify-ios-push` passes on a
matching physical-device build.

After APNs configuration, complete the native client and sender auth/flows,
then run `/build-ios` to create either a `development`
IPA (`aps-environment=development`) or a registered-device `ad-hoc` IPA
(`aps-environment=production`) through the template's `npm run build:ios`
Wrap path. It requires a fresh `apple-ios-provisioning.json` for the exact
Team, bundle, and selected mode. Immediately before Wrap, the secure keychain
helper temporarily unlocks and prepends the retained project-specific keychain,
proves the required Apple Development or Apple Distribution identity plus the
matching installed profile/APNs environment, runs Wrap with that keychain in
scope, and restores the previous search list on success or failure. Passwords,
certificate names, profile UUIDs, device UDIDs, and keychain paths are never
written to `wrap.config.json` or logs.
Apple certificates, private keys, provisioning profiles, device UDIDs, passwords,
and signing secrets remain outside the repository.

Run `/verify-ios-push` only after the exact IPA is installed and sender auth
plus both Power Automate flows are ready. It verifies the physical-device
foreground, background, terminated/cold-start deep-link, signed-out
`allUsers`, signed-in lowercase-OID, sign-out, opt-out, and re-registration
cases. Firebase acceptance, a `Sent` outbox row, simulator, Expo Go, Metro, or
configuration checks alone do not prove delivery.

Run `/setup-push-wif` before flow authoring when the Google trust is not already
verified. WIF is the preferred sender mode: it uses the official gcloud MCP and
Azure MCP where its current coverage applies, inspects a real Entra app-only
token, configures the provider from the observed issuer and application claim,
and proves the Google STS and service-account impersonation exchange without
storing a Google private key. Azure MCP GA `2.0.5` is used here for covered
read-back/settings operations; RBAC mutations, Function
provisioning/deployment/auth/managed identity, Entra resource work, and
secret-safe provisioning gaps remain explicit `az` work owned by the sender-auth
skills.

Organizations with an existing Firebase service-account integration may
instead run `/setup-push-service-account`. It validates or deploys an
Entra-protected Azure Function, using Azure MCP only for covered read-back /
settings surfaces such as `role_assignment_list`, `functionapp_get`, and App
Service web app/deployment/appsettings/diagnostics reads. The package's full
Azure MCP GA `2.0.5` surface includes value-carrying Key Vault secret tools,
so this plugin does not expose the `keyvault` namespace. RBAC
mutations, Function provisioning/deployment/auth/managed identity, Entra
resource work, and secret-safe writes remain explicit `az` gaps. The skill
never creates or downloads a Firebase Admin key.

Customers may also choose **manual/customer-owned sender authentication**.
That route can use an organization-selected Power Automate connector, custom
connector, HTTP action, or hosted endpoint and whatever identity provider,
secret store, API gateway, hosting, monitoring, and licensing it requires. The
plugin does not provide a setup skill, accept credentials, or mark this route
validated. The customer owns secure authentication, credential rotation, FCM
HTTP v1 compliance, non-delivery testing, publication, monitoring, and support.

`/create-push-notification-flow` first shows an informed comparison of all
three choices—**WIF (Recommended)**, managed Azure Function compatibility, and
manual/customer-owned setup. For either managed choice it consumes the
validated sender-auth handoff and uses FlowAgent to create the outbox sender
and producer flow. For manual setup it may create the producer/outbox only;
the customer owns the sender. The
producer defaults to a Dataverse row-created trigger and resolves the row owner
to a lowercase Entra OID topic. When Microsoft-side semantics are uncertain,
use Microsoft Learn docs rather than guessed contracts.

#### Push notification cloud prerequisites

- **Required MCP servers:** vendor-official Firebase MCP for Firebase
  project/app work, gcloud MCP for `/setup-push-wif` Google Cloud operations,
  Azure MCP for covered read-back/settings work, and FlowAgent for Power
  Automate mutation/read-back. There is no CLI fallback for Firebase or gcloud
  in the documented push architecture. Azure MCP GA `2.0.5` currently covers
  `role_assignment_list`, `functionapp_get`,
  `appservice_webapp_get`, `appservice_webapp_deployment_get`,
  `appservice_webapp_settings_get-appsettings`,
  `appservice_webapp_settings_update-appsettings`, and diagnostics. This plugin
  intentionally does not expose the `keyvault` namespace because its available
  secret operations can return or accept secret values.
  Azure CLI remains the explicit gap path for RBAC mutations, Function
  provisioning/deployment/auth/managed identity, Entra resource work,
  secret-safe writes, plus narrow local identity checks.
  Microsoft Learn MCP/docs remain the authoritative source for
  Microsoft-platform behavior. Tested stable package baselines for this path
  are Firebase MCP package `firebase-tools` **15.27.0** (`15.28.1` is
  main/unpublished), gcloud MCP **0.5.3**, and Azure MCP GA **2.0.5**.
- **Common:** a Firebase project, matching wrapped physical-device runtime,
  Dataverse environment, Power Automate access, and licensing for Dataverse
  plus the premium connectors/actions selected by FlowAgent.
- **WIF (Recommended):** a dedicated Entra app/service principal and
  credential, Azure Key Vault with data-plane RBAC for the Power Automate
  connection identity, a Google Workload Identity Pool/Provider, a dedicated
  least-privilege Google sender service account/FCM role, and Power Automate
  Dataverse, Key Vault, and HTTP connections/actions.
- **Managed Function compatibility:** an existing Firebase service-account
  JSON, Azure Key Vault, managed-identity-enabled Azure Function hosting and
  deployment resources, Entra protection, a tested Power Automate
  connection/custom connector, Azure RBAC, and applicable premium licensing.
- **Manual/customer-owned:** all connector or endpoint hosting, identity,
  secret storage, gateway/networking, monitoring, licensing, credential
  rotation, and operational support required by the customer's selected
  architecture. The plugin does not validate this path.
- **Azure/Entra:** an Azure subscription; permission to create or validate the
  dedicated Entra applications/service principals and connection identities;
  and Azure Key Vault with data-plane RBAC. Contributor alone does not grant
  secret read/write access.
- **WIF (preferred):** Google Cloud IAM/WIF administration, a dedicated Google
  sender service account, an Entra sender credential stored in Key Vault, and
  Power Automate connections for Key Vault and the discovered premium HTTP
  actions.
- **Existing service-account compatibility:** an already provisioned Firebase
  service-account JSON kept outside repositories; Azure Function hosting,
  managed identity, Key Vault, App Service/Function Entra authentication, and
  an Entra-authenticated premium connector/connection usable by Power
  Automate. Azure hosting charges and Power Platform premium licensing may
  apply.
- **iOS configuration:** Apple Developer access and manual APNs `.p8` upload
  to Firebase. The agent never handles the key or its local path. Apple
  provisioning stays on pinned local Fastlane because no vendor-official Apple
  provisioning MCP exists for the required Developer Portal workflow, and
  community MCPs are excluded.
- **iOS build and verification:** macOS Wrap/Xcode tooling, a registered
  physical device, and Apple signing assets retained outside the repository.
  `/setup-apple-ios` pins managed Ruby 3.3+, Bundler 4.0.19, and Fastlane
  2.238.0. Install gems locally from the app root with
  `bundle _4.0.19_ install`, and invoke Fastlane only as
  `bundle exec fastlane`; do not rely on system Ruby or a global Fastlane.
  Only development and ad-hoc registered-device IPA workflows are supported.

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
> /check-updates                 # ordered dependency updates
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
| `/add-push-notifications` | 🟡 preview | End-to-end notification client setup: permission UX, FCM topics on Android/iOS, Entra OID ↔ `allUsers` lifecycle, and Expo Router deep links. Requires a matching wrapped runtime; the template exposes a GUID-validated signed-in OID through its guarded native-host compatibility patch. |
| `/setup-fcm` | 🟡 preview | Official MCP-first Firebase owner — uses the vendor-official Firebase MCP to list/select/create Firebase projects, idempotently reuse or register exact-identity Android/iOS apps, explicitly select among safe duplicates by immutable app ID, then validate committed `firebase/` client configs that Expo auto-discovers. No CLI fallback. |
| `/setup-apns` | 🟡 preview | After `/setup-apple-ios`, validate the Firebase iOS identity plus exact Apple Team/identifier/Push handoff, then guide the supported manual APNs `.p8` upload in Firebase Console; no supported CLI/API upload exists and the agent never handles the key. |
| `/setup-apple-ios` | 🟡 preview | Scaffold pinned local Bundler/Fastlane tooling; prove the exact Apple Team and Expo/Firebase bundle ID; create/reuse the explicit identifier, Push capability, registered devices, modern certificates, and verified development/ad-hoc profiles; emit the fresh non-secret build handoff. Fastlane stays because Apple provides no vendor-official provisioning MCP for this workflow, and community MCPs are excluded. Creates no App Store Connect listing and does not build. |
| `/build-ios` | 🟡 preview | Build a registered-device development or ad-hoc IPA through `npm run build:ios` (`wrap ios`), requiring the fresh exact Apple provisioning handoff and a secure dedicated-keychain/profile/APNs proof immediately before Wrap. The previous keychain search list is always restored. Not for simulator, TestFlight, App Store, or enterprise distribution. |
| `/verify-ios-push` | 🟡 preview | Verify the exact fresh wrapped IPA and published producer/sender flows on a registered physical iPhone/iPad across permission, foreground/background/terminated delivery, deep links, topic transitions, opt-out, and re-registration recovery. |
| `/setup-push-wif` | 🟡 preview | Preferred sender-auth path: validate/reuse, repair, or provision keyless Entra-to-Google Workload Identity Federation through the official gcloud MCP plus Azure MCP read-back/settings coverage, while explicit `az` gaps remain for RBAC, Function provisioning/auth/managed identity, Entra resource work, and secret-safe writes that Azure MCP GA 2.0.5 does not cover. Then prove the complete exchange and write the non-secret sender-auth handoff. |
| `/setup-push-service-account` | 🟡 preview | Compatibility path for an existing Firebase service-account integration: use Azure MCP for covered read-back/settings work, but keep RBAC mutations, Function provisioning/deployment/auth/managed identity, Entra resource work, and secret-safe writes on the documented `az` gap path. Never creates or downloads a Firebase Admin key. |
| `/create-push-notification-flow` | 🟡 preview | Resume from an integrated Firebase client, compare recommended WIF, managed Function compatibility, and customer-owned manual sender authentication, then use FlowAgent for managed sender/producer flows or producer/outbox-only manual handoff. User notifications use lowercase Entra OID topics; broadcasts use exact `allUsers`. |
| `/list-connections` | ✅ v0 | Finds or creates a Power Platform connection ID, or resolves a solution connection reference, for `npx power-apps add-data-source`. Use when adding non-Dataverse connectors or re-binding after a 401. |
| `/edit-app` | ✅ v0 | Post-generation app editor — updates affected sections of `native-app-plan.md`, applies Dataverse/native/design/connector changes, rebuilds affected screens, runs verification, updates `memory-bank.md`, and regenerates `preview.html` when UI changed. `--plan-only` preserves the old docs-only behavior. |
| `/check-updates` | ✅ v0 | Standalone dependency maintenance — checks for a plugin update and restart first, then presents, approves, updates, and validates direct packages one at a time in host, other `@microsoft/*`, and remaining npm package order. |
| `/deploy` | ✅ v0 | Power Platform web deployment — `npm run build` then `npx power-apps push` to the env in `power.config.json`. Routes registered-device iOS native builds to `/build-ios`; it does not run `expo run:ios` or `expo run:android`. |
| `/debug-app` | ✅ v0 | Diagnose Metro/dev-client runtime and silent failures. Keeps general JS/bundle diagnostics local, but routes wrapped iOS notification delivery/runtime verification to `/verify-ios-push`. |
| `/open-wrap-url` | ✅ v0 | Opens the Wrap URL in browser for an app ID using `https://make.powerapps.com/environments/<envID>/wrap?appID=<appID>`. Requires both `--app-id` and `--env-id`. |
| `/report-issue` | ✅ v0 | Read-only diagnostic — collects env / Expo / Node versions, project context, recent errors, and renders a copy-paste-ready GitHub issue body. Sanitizes secrets. |
| `/telemetry` | ✅ v0 | Enable, disable, or show the per-user Mobile Apps telemetry transmission preference. |
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

## Telemetry and privacy

The Mobile Apps plugin sends start-only usage telemetry to Microsoft. A start event can include the skill name, plugin version, session and per-start correlation IDs, OS/Node versions, AI-agent name/version, invocation source, and a random per-project app instance ID. It never includes prompts, skill arguments, tool inputs, file paths, cwd, app/site names, URLs, credentials, usernames, hostnames, Dataverse organization or tenant IDs, or Entra object IDs.

Both host surfaces are covered — an explicit slash command and a programmatic Skill-tool call — so some hosts may produce two `skill_started` records for one visible run. The plugin does not emit `skill_completed`, success/failure, error, or duration data because the available hook boundary does not prove that the workflow itself completed.

Control the per-user transmission preference with:

```text
/mobile-app:telemetry status
/mobile-app:telemetry off
/mobile-app:telemetry on
```

`off` stops network transmission but retains the sanitized local diagnostic mirror under `~/.power-platform-skills/telemetry/mobile-app/sessions/<sessionId>/events.jsonl`. Automation can force transmission off with `POWER_PLATFORM_SKILLS_TELEMETRY_MOBILE_APP_OPTOUT=1`; this overrides the saved preference and `on`.

## Known blockers

## See also

- [`plugins/mobile-apps/template`](https://github.com/microsoft/power-platform-skills/tree/main/plugins/mobile-apps/template) — bundled Expo standalone template and fresh-template working directory source
- [Expo docs](https://docs.expo.dev/)
- [Power Apps developer docs](https://learn.microsoft.com/en-us/power-apps/developer/)
