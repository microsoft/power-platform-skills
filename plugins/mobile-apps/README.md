# Power Apps Standalone App Template

This template is an Expo, React Native, and TypeScript starter for building a standalone mobile app that connects to Power Platform data through `@microsoft/power-apps-native-host`.

## Requirements

- Node.js 24 LTS.
- npm 10 or newer.
- The Power Apps Developer app from the Apple App Store or Google Play.
- For wrapped Android push delivery: a physical Android 8/API 26+ device and
  the local Wrap/Android SDK toolchain, including `apksigner` for signature
  verification. Direct-test APK signing remains customer-managed; AAB and
  Google Play distribution are not included in the preview.
- For wrapped iOS push delivery: macOS with the installed Wrap/Xcode toolchain,
  Apple Developer team access, and a physical iPhone or iPad registered to that
  team. The preview supports registered-device `development` and `ad-hoc`
  builds only—not simulator, TestFlight, App Store, or enterprise distribution.
  Apple Developer and Xcode configuration, signing assets, device registration,
  and credentials remain user-managed; `/build-ios` runs the direct Wrap
  command only after exact confirmation.

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

Native modules are allowlist-bound by the current template `package.json`.
Push notifications use one guided entry point:

```text
> /add-push-notifications
```

The skill detects existing progress, asks for the target platform and stopping
point only when they are unclear, and resumes the required owner workflows.
Choose whether to stop after app configuration, Power Automate delivery flows,
a wrapped device build, or end-to-end physical-device verification. You do not
need to remember or manually chain the individual push commands.

Setup is faster when independent work is available: Firebase project setup
stays serial, then Android and iOS client configuration may run together.
After Firebase joins, independent runtime, WIF, and iOS-prerequisite work may
also run in a bounded wave. The workflow falls back to one worker or serial
execution when needed. Flow authoring, wrapped builds, installation handoffs,
and physical verification still run in their required order, so not every
push step runs concurrently.

Each bounded worker first completes a no-read/no-write capability preflight.
Workers receive fixed identities and files, never write the memory bank, and
return project-relative paths that the parent checks against its absolute
allowlist. WIF reuse/repair requires a read-only plan and approval before
execution. Truly cold WIF uses two approvals: first only for creating the
absent dedicated Entra identity/credential and storing it safely in Key Vault,
then—after a fresh claim-driven plan using the generated client ID—for the
remaining Google/API/RBAC work and final proof. The bootstrap never writes
`sender-auth.json`. If iOS worker dispatch is unavailable, one combined
`/setup-apns` fallback validates Apple setup first and returns one Apple/APNs
result.

The workflow configures `expo-notifications`, React Native Firebase Messaging,
permission UX, auth/topic lifecycle, and a typed semantic navigation contract.
That contract uses Expo Router and is shared by in-app actions, the configured
custom scheme, approved HTTPS App Links/Universal Links, and notification taps.
See
[`shared/references/push-notifications-architecture-diagrams.md`](./shared/references/push-notifications-architecture-diagrams.md)
for app, Power Automate, WIF, MCP ownership, and unified navigation diagrams.

Notification delivery must be tested on matching wrapped physical-device
builds. Native client setup, sender authentication, and Power Automate flow
authoring are independent resumable stages. Each platform then adds a wrapped
build and physical delivery-verification stage. `/add-push-notifications`
invokes the first incomplete owner and continues to the selected stopping
point. The individual commands remain available as advanced repair or resume
entry points.

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
environment overrides remain available when needed. For iOS,
`/setup-apple-ios` provides manual Apple Developer and Xcode guidance for the
exact Team, explicit bundle identifier, Push Notifications capability,
registered test devices, and the selected `development` or `ad-hoc` path. Each portal or Xcode step is presented separately and confirmed with a Yes/No
choice; the skill does not automate Apple configuration or generate an Apple
proof artifact. `/setup-apns` then lets the user choose a manual Apple APNs
authentication-key (`.p8`, recommended) or APNs certificate (`.p12`) upload in
Firebase Console. Browser automation, undocumented endpoints, and agent access
to either credential are prohibited. Completion is recorded as **configured,
device verification pending** until `/verify-ios-push` passes on the matching
physical-device build.

After APNs configuration, the guided workflow can continue through native
client integration, sender auth/flows, and `/build-ios` to create either a `development`
IPA (`aps-environment=development`) or a registered-device `ad-hoc` IPA
(`aps-environment=production`) through the template's `npm run build:ios`
Wrap path. The user directly manages Xcode signing, registered devices,
profiles, and credentials, confirms the exact Team, bundle, and selected mode
before building, and keeps all signing assets and secrets outside the
repository. After explicit confirmation, `/build-ios` runs the direct Wrap
command but does not inspect, generate, stage, or attest signing assets.

The guided workflow invokes `/verify-ios-push` only after the exact IPA is
installed and sender auth plus both Power Automate flows are ready. It verifies the physical-device
foreground, background, terminated/cold-start deep-link, signed-out
`allUsers`, signed-in lowercase-OID, sign-out, opt-out, and re-registration
cases. Firebase acceptance, a `Sent` outbox row, simulator, Expo Go, Metro, or
configuration checks alone do not prove delivery.

For Android, the guided workflow invokes `/build-android` to produce and
validate a direct-test APK through the template's `npm run build:android` Wrap
path. Android v1 does not
cover AAB or Google Play distribution. The plugin never creates a keystore or
handles signing passwords: customers provide an existing signing setup and run
credential-bearing signing in their own uncaptured terminal or approved
external signing system. The skill records only non-secret artifact identity
and `apksigner verify` evidence in `android-build.json`.

The guided workflow invokes `/verify-android-push` only after that exact APK
is installed and sender auth plus both Power Automate flows are ready. It verifies permission and
notification-channel behavior, foreground/background/terminated delivery,
exactly-once deep links, signed-out `allUsers`, signed-in lowercase-OID account
transitions, opt-out, and token refresh or exact-APK re-registration recovery
on a physical Android 8+ device. Emulator, Expo Go, Metro/browser preview,
Firebase acceptance, and an outbox `Sent` state alone do not prove delivery.

When the Google trust is not already verified, the flow owner offers
`/setup-push-wif` as the preferred sender mode. It uses the official gcloud MCP and
Azure MCP where its current coverage applies, inspects a real Entra app-only
token, configures the provider from the observed issuer and application claim,
and proves the Google STS and service-account impersonation exchange without
storing a Google private key. Azure MCP GA `2.0.5` is used here for covered
read-back operations; RBAC mutations, Entra resource work, and secret-safe
provisioning gaps remain explicit `az` work owned by the sender-auth skill.

Customers may instead choose **Create Power Automate flows; configure FCM
authentication manually**. The plugin creates the producer/outbox and sender
flow structure stopped, then identifies the exact FCM action the customer must
configure. It does not accept credentials or mark the customer's
authentication validated.

The flow stage shows an informed comparison of two choices—**WIF (Recommended)**
or customer-configured FCM authentication in the plugin-created Power Automate
sender. The producer defaults to a Dataverse
row-created trigger and resolves the row owner to a lowercase Entra OID topic.
It warns about lock-screen/device exposure but lets the user choose title and
body mappings. Based on the trigger table, it suggests a matching detail or
list destination and lets the user change it or choose no deep link. The flow
does not solicit arbitrary extra FCM data. When Microsoft-side semantics are
uncertain, use Microsoft Learn docs rather than guessed contracts.

#### Push notification cloud prerequisites

- **Required MCP servers:** vendor-official Firebase MCP for Firebase
  project/app work, gcloud MCP for `/setup-push-wif` Google Cloud operations,
  Azure MCP for covered WIF read-back, and FlowAgent for Power Automate
  mutation/read-back. The separate `power-automate@power-platform-skills`
  plugin is not installed automatically; `/create-push-notification-flow`
  provides the exact manual install, restart, setup, and MCP verification steps
  when FlowAgent is unavailable. The gcloud MCP requires Node.js 20+ and the Google Cloud
  CLI. `/setup-push-wif` can install the CLI only after explicit approval and
  only through a supported package manager already present. Azure MCP GA
  `2.0.5` currently covers the WIF subscription/group/RBAC read-back used by
  this plugin. This plugin
  intentionally does not expose the `keyvault` namespace because its available
  secret operations can return or accept secret values.
  Azure CLI remains the explicit gap path for RBAC mutations, Entra resource
  work, secret-safe writes, plus narrow local identity checks.
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
- **Manual FCM authentication:** Power Automate Dataverse and HTTP
  connections/actions plus the customer's chosen Google credential and secret
  storage approach. The plugin authors both flows stopped but does not inspect
  or validate the configured authentication.
- **Azure/Entra:** an Azure subscription; permission to create or validate the
  dedicated Entra applications/service principals and connection identities;
  and Azure Key Vault with data-plane RBAC. Contributor alone does not grant
  secret read/write access.
- **WIF (preferred):** Google Cloud IAM/WIF administration, a dedicated Google
  sender service account, an Entra sender credential stored in Key Vault, and
  Power Automate connections for Key Vault and the discovered premium HTTP
  actions.
- **iOS configuration:** Apple Developer access and manual APNs `.p8` key or
  `.p12` certificate upload to Firebase. `/setup-apple-ios` provides manual
  Apple Developer/Xcode guidance with Yes/No confirmations; `/setup-apns`
  guides the selected manual Firebase Console upload. The agent never handles
  the credential, password, private key, or local path and does not automate
  Apple configuration.
- **iOS build and verification:** macOS Wrap/Xcode tooling, a registered
  physical device, and Apple signing assets retained outside the repository.
  The user directly manages signing; `/build-ios` runs the confirmed Wrap
  command and performs safe artifact checks. Only development and ad-hoc
  registered-device IPA workflows are supported.

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
| `/add-push-notifications` | 🟡 preview | **Recommended push entry point.** Resumes existing progress and guides Firebase, Apple/APNs, app runtime, sender auth, Power Automate flows, wrapped builds, and physical verification to one selected stopping point. Directly owns permission UX, FCM topic lifecycle, and the shared typed navigation contract. |
| `/setup-fcm` | 🟡 preview | Advanced resume/repair owner for exact-identity Firebase Android/iOS app registration and validated client configs through the vendor-official Firebase MCP. No CLI fallback. |
| `/setup-apns` | 🟡 preview | Advanced iOS resume/repair owner for the manual APNs `.p8` or `.p12` Firebase Console handoff; the agent never handles the credential. |
| `/setup-apple-ios` | 🟡 preview | Advanced iOS resume/repair owner for manual Apple Developer and Xcode prerequisites for the exact Team, bundle, device, and development/ad-hoc scope. |
| `/build-android` | 🟡 preview | Advanced direct build owner for a customer-signed test APK. Normally invoked by `/add-push-notifications` when the selected stopping point includes a device build. |
| `/verify-android-push` | 🟡 preview | Advanced direct verification owner for the exact installed APK and physical Android delivery matrix. Normally invoked by `/add-push-notifications`. |
| `/build-ios` | 🟡 preview | Advanced direct build owner for a registered-device development or ad-hoc IPA with user-managed signing. Normally invoked by `/add-push-notifications`. |
| `/verify-ios-push` | 🟡 preview | Advanced direct verification owner for the exact installed IPA and physical iOS delivery matrix. Normally invoked by `/add-push-notifications`. |
| `/setup-push-wif` | 🟡 preview | Advanced sender-auth resume/repair owner for keyless Entra-to-Google Workload Identity Federation. Normally invoked after the guided flow stage selects WIF. |
| `/create-push-notification-flow` | 🟡 preview | Advanced flow resume/repair owner for sender-auth selection and Power Automate producer/sender authoring. Normally invoked by `/add-push-notifications`. |
| `/list-connections` | ✅ v0 | Finds or creates a Power Platform connection ID, or resolves a solution connection reference, for `npx power-apps add-data-source`. Use when adding non-Dataverse connectors or re-binding after a 401. |
| `/edit-app` | ✅ v0 | Post-generation app editor — updates affected sections of `native-app-plan.md`, applies Dataverse/native/design/connector changes, rebuilds affected screens, runs verification, updates `memory-bank.md`, and regenerates `preview.html` when UI changed. `--plan-only` preserves the old docs-only behavior. |
| `/check-updates` | ✅ v0 | Standalone dependency maintenance — checks for a plugin update and restart first, then presents, approves, updates, and validates direct packages one at a time in host, other `@microsoft/*`, and remaining npm package order. |
| `/deploy` | ✅ v0 | Power Platform web deployment — `npm run build` then `npx power-apps push` to the env in `power.config.json`. Routes native push builds to `/build-android` or `/build-ios`; it does not run `expo run:ios` or `expo run:android`. |
| `/debug-app` | ✅ v0 | Diagnose Metro/dev-client runtime and silent failures. Keeps general JS/bundle diagnostics local, but routes wrapped Android/iOS notification delivery verification to `/verify-android-push` or `/verify-ios-push`. |
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
| `firebase-platform-worker` | Bounded Android-or-iOS Firebase client worker; `/setup-fcm` may run at most two after serial project activation |
| `push-runtime-worker` | Bounded runtime integration worker with exclusive app-file ownership |
| `push-wif-worker` | Bounded staged WIF worker; cold identity bootstrap writes no local file, and only final execute may write `sender-auth.json` |
| `push-ios-prerequisites-worker` | Read-only validator for parent-collected Apple/APNs confirmations |

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
