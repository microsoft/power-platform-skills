# Version Check — Power Apps Native Code App

Tooling prerequisites only. Runtime compatibility comes from the app-matched
[verified release context](references/mobile-release-lifecycle.md), not this
file or the newest bundled template.

The lifecycle's explicit `--diagnostic-artifacts` workflow is a separate
online-only Android test selection. Only that opt-in inspection needs `tar`, `unzip` and
an explicitly selected SDK `aapt2` on `PATH`; it does not discover devices or
build native code. Keep normal tooling tiers unchanged, record iOS as untested,
and never use this selection for deployment.

## Guiding principle — **scope-aware checks, not blanket gates**

This plugin uses scope-aware checks based on the mobile workflow:

- **Deploy** = `npm run build` + `pa app push`. No local Xcode / Android Studio involvement.
- **Local dev** = the user runs `npm run dev` (= `expo start`) directly. Metro starts and prints a QR for native dev clients.
- **Local native compile** (platform-specific native run commands) is the user's choice and lives **outside** this plugin's skills. Not a prerequisite, not validated, not driven.

Result: the only required tooling is what Node/npm, the Power Apps CLI (`pa`), and the relevant helper scripts need. Xcode/JDK/Android Studio are explicitly out of scope.

These apps use an **immutable, prebuilt native runtime**. `npm run build`
exports application JavaScript; it does not prebuild or compile new native code.
Adding a dependency or config plugin cannot add native support to a player/base.
Use `/add-native` only for packages and versions already verified in that app's
release. Changing native dependencies requires a maintainer-verified release
migration through `/check-updates`, not an ad hoc install or local native build.

### What the user owns vs what Expo generates

| Layer | Edited by user? | Source of truth |
|---|---|---|
| `app/`, `src/`, `assets/`, `tamagui.config.ts` | ✅ yes | application code |
| `app.json` app metadata / opt-in app telemetry | ✅ within the owning skill | app configuration, not native compatibility proof |
| `package.json` pure-JavaScript dependencies | ✅ with approval | exact-version JavaScript dependency plan |
| Native dependencies, plugins, permissions, Info.plist / manifest declarations | ❌ not per-customer capability edits | verified fixed-capability base |
| `ios/`, `android/`, `Info.plist`, `AndroidManifest.xml` | ❌ never in these skills | maintainer-built native release |

Package inclusion, OS declarations, runtime grants, and app usage are four
separate facts. Disabling a control or omitting its JS import does not remove
default Android permissions. Different declarations require another verified
base; optional permission wrapping is deferred.

## Always required (any target)

| Tool | Min version | Check command | Why |
|---|---|---|---|
| Node.js | `22.0.0`, or higher when the resolved release requires it | `node --version` | Also honor installed package engines and verified release tooling requirements |
| npm | `10.0.0` | `npm --version` | Expo install / lockfile v3 |
| Expo CLI (project-local via npx) | release-matched | `npx --no-install expo --version` | Export with the app's resolved Expo release; never fetch a newer CLI to repair native compatibility |
| TypeScript (project-local) | `5.4.0` | `npx --no-install tsc --version` | Required by generated service types |
| POSIX shell (Windows only) | bash 4+ / zsh 5+ | `echo $BASH_VERSION || echo $ZSH_VERSION` | Skills use `cp -R`, `rm -rf`, `mkdir -p`, `grep`, `sed`, `find`. Native PowerShell / cmd.exe lack these. Use **Git Bash** or **WSL** on Windows. See [shared-instructions.md → Shell Requirement](./shared-instructions.md#shell-requirement-windows-users). |

## Required only when the relevant skill runs

| Tool | Required by | Min version | Check |
|---|---|---|---|
| Azure CLI (`az`) | ADO npm token setup, `/add-dataverse` token acquisition | `2.60.0` | `az --version` |

If the user is just editing screens or running web, `az` does not need to be installed.

## Required only for **local native builds** — OUT OF SCOPE for plugin skills

The following are needed **only** if the user manually runs platform-specific native run commands to compile a local native binary. **No skill in this plugin runs those commands or probes for these tools.** Documented here purely as user reference.

| Tool | Min version | Platforms | Why |
|---|---|---|---|
| JDK | `17` | Android | Gradle 8.x requirement for RN 0.83 |
| Android Studio + SDK | latest | Android | Emulator + platform tools |
| Xcode | `15.0` | iOS (macOS only) | iOS 18 SDK |
| CocoaPods | `1.14.0` | iOS (macOS only) | Pod install for native modules |
| Watchman | any | macOS / Linux dev | File-watching perf (optional) |

If the user asks how to run on a real device or simulator: point them at the Expo docs (https://docs.expo.dev/get-started/set-up-your-environment/) and let them install whatever they need. Do not gate any plugin skill on these.


## Resolve SDK and native package versions

```bash
node "${PLUGIN_ROOT}/scripts/resolve-mobile-release.js" --project-root "<working_dir>"
```

Use only its sanitized tuple for the app's template, host, Expo, React Native,
native inventory, and verified player/base context. A package version existing
on npm is not a verified player/base release. An empty policy is intentional:
unknown/missing records block native mutations and deployment. Existing pure
source/UI work may continue with installed contracts and an explicit
`native compatibility unverified` limitation.

The tuple's `nativePackages` contains reviewed canonical `node_modules`-relative
package paths and exact versions; `managedDependencies` contains reviewed
registry declarations or safe `file:./vendor/*.tgz` specs. These policy values
are not absolute project paths, raw config, or lockfile download URLs. Preserve
the nested inventory when handing context to planners/builders.

`--release <id>` selects an exact maintainer-verified set; `--default` requires
a verified default. Neither means “newest”. Deployment must also check each
actual intended base using `--platform android|ios --base-version <version>
--base-fingerprint <fingerprint>`. All three flags are required together for
deployment. Obtain both values from the selected target's verifiable metadata;
do not copy the policy's expected values to make a check pass. Missing or
mismatched fingerprint blocks deployment even when the version label matches.

## Standard prereq snippet for skills

Most skills only need the always-required tier. Copy this into Step 1.

Use shell/project-file checks directly:

```bash
# Always required
node --version          # expect v22+

# Conditionally required — only if THIS skill needs it
# az account show                            # for /add-dataverse

# Project-local (only if inside a project)
test -f power.config.json && echo "OK: code app project"
node "${PLUGIN_ROOT}/scripts/resolve-mobile-release.js" --project-root "<working_dir>"
```

**Do NOT call `xcodebuild`, `java -version`, or check for Android Studio in any skill.** Local native compile is the user's choice, not a plugin concern.

## Install pointers

| Tool | Install |
|---|---|
| Node 22 | `nvm install 22 && nvm use 22` (https://nvm.sh) |
| `az` | https://aka.ms/InstallAzureCLI |

*Out-of-scope tools (user-managed if they want local native builds):* JDK 17 (https://adoptium.net), Android Studio (https://developer.android.com/studio), Xcode (Mac App Store), CocoaPods (`brew install cocoapods`).


## When to update this file

- New skill needs a tool not listed → add it here, then reference from the skill (don't hard-code in the skill).
- A verified release changes tooling requirements → update this tooling guidance; keep runtime pins in the shared release policy, not a duplicate SDK table here.
- A new Power Platform CLI feature requires a newer minimum → bump the table, surface a one-line warning in the affected skills.
