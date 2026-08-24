# Power Apps Mobile Extension Plugin

Claude Code / GitHub Copilot plugin for creating **third-party controls for Power Apps Mobile
(PAM)**. It helps design, generate, test, package, and publish a native control using public tooling
and package registries.

The plugin produces a `.ppmplugin` bundle for the Power Apps Wrap runtime and a matching dispatcher
PCF control for use in a Canvas app.

---

## Install & run

First, make a folder for your control and open it — this is where the skills write your control's files:

```bash
mkdir my-control && cd my-control
```

Then load the skills using one of the following options.

### Option A — local checkout (`--plugin-dir`)

Clone the public repository, then launch your CLI from the control folder and point it at the
`power-apps-mobile-extension` plugin:

```bash
git clone https://github.com/microsoft/power-platform-skills.git
copilot --plugin-dir /path/to/power-platform-skills/plugins/power-apps-mobile-extension
# or
claude --plugin-dir /path/to/power-platform-skills/plugins/power-apps-mobile-extension
```

### Option B — marketplace (no clone needed)

Inside a Claude Code or GitHub Copilot CLI session, add the marketplace once and install the
plugin:

```text
/plugin marketplace add microsoft/power-platform-skills
/plugin install power-apps-mobile-extension@power-platform-skills
```

Once your CLI is open, run the skills — start with **`/design-native-extension-feature`** (or jump to `/generate-ppmplugin` if you already have a native module).

---

## Prerequisites

Each skill checks **only the tools its own work touches**, at Step 1 — there is no blanket baseline.
When a prerequisite is missing, the skill explains why it is needed and prints the exact fix.
Only the small safe-list in [`shared/prereq-check.md`](shared/prereq-check.md) can be offered as an
automatic fix, always with explicit confirmation and one fix at a time. System-level or
interactive setup such as Node.js, Xcode, the Android SDK itself, .NET, CocoaPods, and `pac auth`
remains user-driven.

Every dependency below is available from a public installer or package registry. No
organization-specific package feed or credentials are required to generate or build a plugin.

| Tool | Min ver | Used by | Verify | Install / fix |
|---|---|---|---|---|
| **Node.js + npm** | 20.x LTS (22.x supported) | generate-pcf-companion, test (Layer 4), PCF build, iOS devDep seed | `node --version` / `npm --version` | `nvm install 20 && nvm use 20`, or [nodejs.org](https://nodejs.org) |
| **JDK** | **17+** | build-android-binary and assemble (`jar`) | `java -version` | mac: `brew install --cask temurin@17` · win: `winget install EclipseAdoptium.Temurin.17.JDK` · linux: package manager — **auto-fix on confirm** |
| **Android SDK command-line tools** | any recent (provides `sdkmanager`) | installing Android platform and Build-Tools | `sdkmanager --version` | [Android Studio or command-line tools](https://developer.android.com/studio) |
| **Android SDK Build-Tools** | 35 (provides `d8`) | build-android-binary | located by path (rarely on `PATH`) | `sdkmanager "build-tools;35.0.0"` — **auto-fix on confirm** |
| **Android platform 35** | exactly 35 | build-android-binary | `$ANDROID_HOME/platforms/android-35/` | `sdkmanager "platforms;android-35"` — **auto-fix on confirm** |
| **Gradle** | optional | build-android-binary uses its pre-generated wrapper pinned to 8.13 | `gradle --version` | No system install required |
| **Xcode + Command Line Tools** | 16+; 26.2+ recommended (**Mac only**) | build-ios-binary | `xcodebuild -version` / `xcode-select -p` | Mac App Store / `xcode-select --install` — print-only (build-ios BLOCKs on non-Mac) |
| **CocoaPods** | 1.14+ (**optional**) | build-ios-binary (fallback path only) | `pod --version` | `brew install cocoapods` — not needed for the header-only build |
| **`react-native` devDep** | 0.79.7 (pinned) | build-ios-binary (React-Core headers) | `node_modules/react-native/React/Base/RCTBridgeModule.h` exists | `pnpm install` (or `npm install`) in the control repo |
| **`pac` CLI** | 1.40+ | generate-pcf-companion, publish-pcf-companion | `pac --version \| head -1` | `dotnet tool install --global Microsoft.PowerApps.CLI.Tool` (needs .NET SDK first) — **auto-fix on confirm** |
| **.NET SDK** | **10+** | publish-pcf-companion (the PCF solution build inside `pac pcf push`) | `dotnet --version` | mac: `brew install --cask dotnet-sdk` · win: `winget install Microsoft.DotNet.SDK.10` · linux: distro package — print-only |
| **Active `pac auth`** | — | publish-pcf-companion only | `pac auth list` (★ = active) | `pac auth create --environment <url>` — browser-interactive (skill initiates) |
| **`dexdump` / `strings`** | any (**optional**) | audit-ppmplugin (DEX scan) | `dexdump --version` / `strings -V` | from Android SDK Build-Tools / coreutils — scan degrades to a WARNING if absent |

> **`pac: command not found` after install?** `dotnet tool install --global` writes to `~/.dotnet/tools/`, which **isn't on `PATH` by default on macOS/Linux** — so `pac` won't run until you add it:
> ```bash
> echo 'export PATH="$PATH:$HOME/.dotnet/tools"' >> ~/.zshrc && source ~/.zshrc   # ~/.bashrc for bash
> ```
> Then re-run `pac --version`. On Windows the installer usually adds `%USERPROFILE%\.dotnet\tools` automatically; if not, add it via Environment Variables.

> **`d8` is rarely on `PATH`.** It lives in `build-tools/35.0.0/`. The build skill locates it by path (`$ANDROID_HOME/build-tools/35.0.0/d8`) and invokes it by absolute path — you don't need to edit `PATH` for it.

Full per-skill matrix + one-liners: [`shared/prereq-check.md`](shared/prereq-check.md). Auto-fix safe-list + policy: [`shared/shared-instructions.md §1.5`](shared/shared-instructions.md).

For more information about code components, see the
[Power Apps component framework overview](https://learn.microsoft.com/en-us/power-apps/developer/component-framework/overview).

---

## Skills

For a new control, run the numbered skills in order. If you already have a native module, start
with `/generate-ppmplugin`.

| # | Skill | Purpose |
|---|---|---|
| 1 | **`/design-native-extension-feature`** | Gather requirements and create the product and technical design. |
| 2 | **`/generate-native-extension`** | Generate the Android and iOS native extension source. |
| 3 | **`/generate-pcf-companion`** | Generate the dispatcher PCF control used by the Canvas app. |
| 4 | **`/test-native-extension`** | Check that the native extension, plugin manifest, and dispatcher PCF agree. |
| 5 | **`/generate-ppmplugin`** | Build and verify the Android, iOS, or combined `.ppmplugin` bundle. |
| 6 | **`/publish-pcf-companion`** | Publish the dispatcher PCF to a Power Platform environment. |
| 7 | **`/debug-extension`** | Diagnose and fix issues found while testing the wrapped app on a device. |

## Integrate the control into an existing Canvas app

### 1. How it fits together

A third-party native extension has two matching artifacts:

- The **dispatcher PCF control**, which a maker adds to a Canvas app. It sends requests to the
  native extension and exposes the result to Power Fx.
- The **`.ppmplugin` binary**, which contains the Android and/or iOS native modules. The wrap
  process compiles it into the final APK, AAB, or IPA.

At runtime, calls follow this path:

```text
Canvas app -> dispatcher PCF -> wrap host -> native method -> Power Fx
```

The PCF and `.ppmplugin` must come from the same extension build so requests are routed to the
correct native control.

### 2. Before you start

Have the following ready in the target Dataverse environment:

- An existing Canvas app in a Dataverse-backed environment that you can edit.
- The dispatcher PCF control for the extension, published to that environment (or supplied by the
  extension developer).
- The matching `<name>.ppmplugin` file for every native extension the app uses.
- Maker access to the [Power Apps maker portal](https://make.powerapps.com/) and permission to run
  wrap.
- Access to the Microsoft Entra app registration used by the Wrap project.
- Signing configuration for each target platform. Automatic code signing requires an Azure
  subscription and a supported Azure Key Vault; otherwise, follow the platform's manual signing
  requirements.
- Access to the native-extensions preview in the target tenant and environment, with the
  `.ppmplugin` upload control visible in the Wrap experience.
- The **Power Apps component framework for canvas apps** environment feature enabled. An
  administrator can enable it in **Power Platform admin center > Environments > Settings >
  Product > Features**. See
  [Code components for canvas apps](https://learn.microsoft.com/power-apps/developer/component-framework/component-framework-for-canvas-apps#enable-the-power-apps-component-framework-feature).

Review the current
[Wrap prerequisites](https://learn.microsoft.com/power-apps/maker/common/wrap/prerequisites) before
starting a build because licensing, signing, and device requirements vary by target platform.

If you are building or publishing the artifacts yourself, install only the tools used by those
skills. The [Prerequisites](#prerequisites) table summarizes them, while
[`shared/prereq-check.md`](shared/prereq-check.md) is the versioned source of truth for exact
versions, per-skill checks, public installers, and `pac auth` recovery.

### 3. Build and publish the components

Follow the ordered skills above through `/generate-ppmplugin` and `/publish-pcf-companion`. The
final binary is written to `ppmplugin/<name>.ppmplugin`; the generated `pcf/README.md` also contains
the control-specific manual build and publish commands.

If another developer supplies both artifacts, confirm they came from the same build before
continuing. Repeat the build for each extension the app needs.

### 4. Add the dispatcher PCF to the app

1. Open the Canvas app in Power Apps Studio in the same environment where the PCF was published.
2. On the target screen, select **Insert > Get more components > Code**, choose the published
   dispatcher control, and import it. The control then appears under **Insert > Code components**.
3. Add the control to a screen. It is a utility control, so its size and position do not affect
   behavior.
4. Bind its input properties to app values, variables, or user input with Power Fx.
5. Trigger the control, for example from a button's `OnSelect`, and read its result and diagnostic
   outputs. Use `YourControl.Status`, `YourControl.ErrorCode`, and
   `YourControl.ErrorMessage` to handle failures.
6. Save and publish the app.

The native call does not run in Power Apps Studio's browser preview. The expected diagnostic is
`NOT_IN_WRAP`; build and validate the screen there, then test native behavior in the wrapped app
on a device. See [`shared/error-codes.md`](shared/error-codes.md) for the canonical output codes
and their meanings.

### 5. Add the app to a solution

Wrap requires the Canvas app to belong to a solution. In the maker portal, switch to the target
environment, open **Solutions**, create or select a solution, and add the Canvas app to it.

### 6. Wrap the app and upload the plugin

1. Start the **Wrap** experience for the app and select the primary app.
2. Refresh the page if the native-extension options do not initially appear.
3. On the build screen, set the bundle identifier, such as `com.yourcompany.yourapp`, and select
   an app registration under owned registrations.
4. Upload every `.ppmplugin` required by the app. Each uploaded plugin must match its published
   dispatcher PCF.
5. Select the configured automatic or manual signing option and choose Dataverse as the storage
   option.
6. Complete the remaining wrap steps to build the Android or iOS package.

See the official
[Wrap wizard guide](https://learn.microsoft.com/power-apps/maker/common/wrap/wrap-how-to) for the
current end-to-end screens and signing requirements.

> Uploading `.ppmplugin` files during wrap is a limited-preview capability and is not covered by
> the public Wrap guide. If the upload option is not available, the tenant or environment is not
> enabled for this preview; contact your tenant administrator or Microsoft representative. Preview
> availability and screens can change.

### 7. Install and test

1. Install the generated APK or IPA on a physical device. Android emulator testing may work when
   the plugin and app package support the emulator architecture; the device-only iOS framework and
   IPA require a physical iOS device.
2. Sign in with an account that can access the app and its Dataverse environment.
3. Exercise every screen that uses the dispatcher control.
4. Confirm the native behavior and verify that `Status`, `ErrorCode`, and `ErrorMessage` expose
   actionable results for both success and failure paths.

The iOS builder performs static framework and linkage checks, but its React weak-link model still
requires validation in a wrapped app on a physical device before release. Treat an iOS-containing
bundle as ready for wrap testing, not production-ready, until that device test passes.

### 8. Example scenarios

Good starting scenarios are capabilities that use permissions already present in the base Android
and iOS packages, such as local notifications, current location, biometric authentication, battery
or device information, flashlight, screen brightness, clipboard access, speech-to-text, and audio
recording. Adding new permissions to the base Power Apps Mobile package is not currently supported
by this workflow. Use [`shared/framework-recommendations.md`](shared/framework-recommendations.md)
for the current platform APIs, lifecycle patterns, and implementation guidance for supported
capabilities.

### 9. Troubleshooting

| Symptom | Check |
|---|---|
| The control is not in the component list | Confirm that the PCF was pushed successfully, Power Apps Studio is using the same environment shown as active by `pac auth list`, and the environment's PCF feature is enabled. |
| **Code** or **Code components** is missing | Ask an administrator to enable **Power Apps component framework for canvas apps** for the environment, then reopen Studio. |
| The `.ppmplugin` upload option is missing | The native-extensions preview is not enabled for the environment or tenant; contact an administrator. |
| Nothing happens in browser preview | Expected: native modules run only in the wrapped mobile app. Test on a device. |
| The control returns an error | Read `ErrorCode`, `ErrorMessage`, and the raw `<name>Json` diagnostic; use the canonical [`shared/error-codes.md`](shared/error-codes.md) catalog, then confirm that the uploaded `.ppmplugin` matches the published dispatcher PCF. |

## License

[MIT](../../LICENSE)
