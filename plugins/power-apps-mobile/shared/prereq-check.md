# Prerequisites — Third-Party `.ppmplugin` Plugin

Single source of truth for the toolchain a skill in this plugin checks before doing real work, and how it auto-resolves a missing one on the user's confirmation. Every skill's Step 1 reads this file and runs **only the sanity check that matches its needs** — per the per-skill matrix in [`./shared-instructions.md`](./shared-instructions.md) §1.5. There is no all-skills "baseline" check.

The plugin itself is markdown + scripts (zero install) and uses public tooling and package registries. Every tool below is available from public installers (brew / winget / `sdkmanager` / the .NET / Node / JDK / Xcode downloads). The toolchains are machine-level and cannot be bundled. The build pins these reference (RN 0.79.7, AGP 8.8.2, Gradle 8.13, compileSdk 35, minSdk 24) live in [`./shared-instructions.md`](./shared-instructions.md) §0 and [`./ppmplugin-format.md`](./ppmplugin-format.md) §5 (Android) / §5b (iOS).

---

## The public tools (what each skill may need)

| Tool | Min version | Used by | Verify | Install (public) |
|---|---|---|---|---|
| Node.js + npm | 20.x LTS (22.x OK) | the PCF build (`npm run build`) and the `react-native` devDep | `node -v` / `npm -v` | [nodejs.org](https://nodejs.org) or [nvm](https://github.com/nvm-sh/nvm) → `nvm install 20 && nvm use 20` |
| `pac` CLI (Power Platform CLI) | 1.40+ | PCF authoring (`pac pcf init` / PCF push) — **public dotnet tool** | `pac --version \| head -1` | [`dotnet tool install -g Microsoft.PowerApps.CLI.Tool`](https://learn.microsoft.com/power-platform/developer/cli/introduction) |
| .NET SDK | 10+ | required by `pac` (public) | `dotnet --version` | [dotnet.microsoft.com](https://dotnet.microsoft.com/download) |
| JDK | 17+ (matches the AGP 8.8.2 / Gradle 8.13 build; `JavaVersion.VERSION_17`) | `/build-android-binary` (Gradle, `d8`), `/assemble-ppmplugin` (`jar`) | `java --version` | `brew install --cask temurin@17` (mac) / `winget install EclipseAdoptium.Temurin.17.JDK` (win) / [adoptium.net](https://adoptium.net/) |
| Android SDK: platform + Build-Tools | `platforms;android-35` + **Build-Tools 35.0.0** (provides `d8`) | `/build-android-binary` | `sdkmanager --list \| grep -E 'android-35\|build-tools;35'` | `sdkmanager "platforms;android-35" "build-tools;35.0.0"` |
| `sdkmanager` (Android command-line tools) | any recent | installs the platform/Build-Tools above | `sdkmanager --version` | [developer.android.com/studio](https://developer.android.com/studio) (Android Studio or command-line tools) |
| Gradle | — (system Gradle optional) | `/build-android-binary` — the staging copy ships a **pre-generated wrapper pinned to 8.13**, so any system Gradle works or none is needed | `gradle -v` (optional) | [gradle.org/install](https://gradle.org/install/) (only if you want a system Gradle) |
| Xcode + Command Line Tools | 16+ minimum; **26.2+ recommended**. iOS deployment target **16.0**. | `/build-ios-binary` — **Mac-only** | `xcodebuild -version` / `xcode-select -p` | App Store / `xcode-select --install` |
| CocoaPods | 1.14+ — **OPTIONAL** | `/build-ios-binary` — the header-only iOS build path does **not** need it | `pod --version` | `sudo gem install cocoapods` |
| `dexdump` or `strings` | any | `/audit-ppmplugin` DEX scan | `dexdump --version` / `strings --version` | `dexdump` ships in Build-Tools 35.0.0; `strings` is on every Unix; on Windows use `strings.exe` (Sysinternals) or the WSL `strings` |

> **`pac: command not found` after install?** `dotnet tool install --global` writes to `~/.dotnet/tools/`, which isn't on PATH by default on macOS/Linux. Add it: `echo 'export PATH="$PATH:$HOME/.dotnet/tools"' >> ~/.zshrc && source ~/.zshrc` (use `~/.bashrc` for bash), then re-run `pac --version`. On Windows the installer usually adds `%USERPROFILE%\.dotnet\tools` automatically; if not, add it via Environment Variables.

> **`d8` is rarely on PATH.** It lives in the Build-Tools dir, not on PATH. Locate it by path — e.g. `"$ANDROID_HOME"/build-tools/35.0.0/d8` (mac/Linux) or `%ANDROID_HOME%\build-tools\35.0.0\d8.bat` (Windows). The same applies to `aapt2` and `dexdump`.

> **No `pac auth` is required for generation.** `pac pcf init` / PCF authoring is a local file generator and needs no environment login. Auth (`pac auth create --environment <url>`) is only the maker's concern when **they** deploy their own PCF to **their own** environment — it is not a prerequisite for building the `.ppmplugin`.

---

## Per-skill checks

Each skill runs **only the check below that matches it** (per [`./shared-instructions.md`](./shared-instructions.md) §1.5). When in doubt, run less — a missing build dependency surfaces naturally via the command that fails, whose failure handler points back here.

Exit codes: `0` = pass; `1` = hard failure (user must fix, or confirm an auto-fix below).

> **No "baseline" one-liner in this track.** Each skill runs *only its own* check below. No package-feed or source-control authentication is required, so if a skill's Step 1 says "run the baseline one-liner," read it as "run the matching per-skill check below."

### `/design-native-extension-feature` — none

Writes two markdown docs; no toolchain, no network. Print the skipped block:
```
Prereq check — /design-native-extension-feature: skipped (writes markdown only — no installs / auth / network).
```

### `/debug-extension` — none

Edits existing files; failures surface at the smoke check. Print the same skipped block (substitute the skill name).

### `/generate-native-extension` — git; Node + pnpm optional

Writes native source + the committed `./manifest.json`. `git` for repo hygiene; Node + pnpm are **optional** — only to seed the dev-only `package.json` devDeps from public npm (the build skills seed them later if absent, so a miss is `n/a`, not a failure).
```bash
git --version >/dev/null 2>&1 || { echo "⚠️  AUTO_FIX_GIT: git not installed — offer OS-aware install"; exit 2; }
node -v >/dev/null 2>&1 && pnpm -v >/dev/null 2>&1 \
  && echo "✅ generate-native prereqs OK (devDep seed available)" \
  || echo "✅ generate-native prereqs OK (Node/pnpm absent — devDep seed deferred to build skills)"
```

### `/generate-pcf-companion` — Node + `pac` CLI

`pac pcf init` is a local file generator; `npm install` / `npm run build` under `pcf/` need Node. **No** .NET SDK runtime and **no** `pac auth` at scaffold time (those are `/publish-pcf-companion`'s concern).
```bash
NODE_MAJOR=$(node -v | sed 's/^v//' | cut -d. -f1) 2>/dev/null && [ "$NODE_MAJOR" -ge 20 ] \
  || { echo "❌ Node 20+ required for the PCF build"; exit 1; }
pac --version >/dev/null 2>&1 || { echo "⚠️  AUTO_FIX_PAC: pac CLI missing — offer: dotnet tool install -g Microsoft.PowerApps.CLI.Tool"; exit 2; }
echo "✅ pcf scaffold prereqs OK"
```
(pwsh: same checks via `if ($LASTEXITCODE -ne 0)`; `pac --version | head -1`.)

### `/test-native-extension` — none for Layers 1–3; Node + npm for Layer 4 (PCF compile)

Layers 0–3 are pure read/grep (no toolchain — see shared-instructions §5 "read/parse vs run"). Layer 4 (`npm run build` in `pcf/<Pascal>PCF/`) needs Node + npm, and only runs if a PCF is on disk — skipped otherwise.
```bash
[ -d pcf ] && { node -v >/dev/null 2>&1 || { echo "❌ Node 20+ required for Layer 4 (PCF compile); Layers 0–3 still run"; }; }
echo "✅ test prereqs OK (Layers 0–3 need no toolchain)"
```

### `/publish-pcf-companion` — `pac` CLI + .NET SDK + active `pac auth`

Deploys the dispatcher PCF via `pac pcf push` (the solution build inside it needs the .NET SDK; the push needs an active auth profile for the target env).
```bash
pac --version >/dev/null 2>&1 || { echo "⚠️  AUTO_FIX_PAC: pac CLI missing — offer: dotnet tool install -g Microsoft.PowerApps.CLI.Tool"; exit 2; }
dotnet --version >/dev/null 2>&1 || { echo "❌ .NET SDK 10+ required — install per dotnet.microsoft.com"; exit 1; }
pac auth list 2>/dev/null | grep -q '\*' || { echo "❌ no active pac auth — run: pac auth create --environment <url>"; exit 1; }
echo "✅ pcf publish prereqs OK"
```

#### `pac auth create` — variant ladder when auth fails

**Default is the interactive browser flow scoped to the environment** — `pac auth create --environment <url>`. `--deviceCode` is a fallback for headless shells only (SSH, container, no browser); it is *not* the more robust option and must not be the first attempt. On managed tenants it commonly fails because Conditional Access wants a compliant-device or browser-backed session, and the error text doesn't name the policy — so it reads transient and invites pointless retries.

**Change a variable each step — never re-run the same failing command more than once:**

1. `pac auth create --environment <url>` (browser).
2. No browser on the machine → add `--deviceCode`.
3. Device code failed → **return to the browser flow with `--environment`**; this is the combination that works on CA-protected tenants and the one most often skipped.
4. `pac auth clear`, then retry step 1.
5. Still failing → STOP, report the exact `pac` error, and note the likely cause is a tenant Conditional Access policy needing an admin, not local misconfiguration.

Omitting `--environment` creates a tenant-level profile with no org bound: `pac auth list` shows it active while `pac org who` / `pac pcf push` can't resolve a target. Always pass `--environment` for a deploy profile.

### `/generate-ppmplugin-manifest` — none (pure read + validate + write)

Validates `./manifest.json` and stages a build copy — all via the Read/Grep tools (no `node`, no shell, no network). Print the skipped block:
```
Prereq check — /generate-ppmplugin-manifest: skipped (read + validate + write only — no installs / auth / network).
```

### `/build-android-binary` — JDK 17 + Android SDK (platform 35 + Build-Tools 35.0.0)

Runs a Gradle `assembleRelease` + `d8` on a throwaway staging copy whose wrapper is pinned to 8.13 (see [`./ppmplugin-format.md`](./ppmplugin-format.md) §5). No system Gradle required.

**bash / zsh:**
```bash
java --version >/dev/null 2>&1 \
  || { echo "❌ JDK not installed — need JDK 17+ (AGP 8.8.2 / Gradle 8.13 build)"; exit 1; }
JAVA_MAJOR=$(java --version 2>&1 | head -1 | sed -E 's/[^0-9]*([0-9]+).*/\1/')
[ "$JAVA_MAJOR" -ge 17 ] || { echo "❌ JDK $JAVA_MAJOR is below required 17+"; exit 1; }
[ -n "$ANDROID_HOME" ] || { echo "❌ ANDROID_HOME not set — install the Android SDK + sdkmanager"; exit 1; }
[ -d "$ANDROID_HOME/platforms/android-35" ] \
  || { echo "❌ platforms;android-35 missing — run: sdkmanager \"platforms;android-35\""; exit 1; }
ls "$ANDROID_HOME"/build-tools/35.* >/dev/null 2>&1 \
  || { echo "❌ Build-Tools 35.0.0 missing (provides d8) — run: sdkmanager \"build-tools;35.0.0\""; exit 1; }
echo "✅ android build prereqs OK"
```

**pwsh (Windows):**
```powershell
java --version 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Host "❌ JDK not installed — need JDK 17+ (AGP 8.8.2 / Gradle 8.13 build)"; exit 1 }
$javaMajor = [int]((java --version 2>&1 | Select-Object -First 1) -replace '[^0-9]*([0-9]+).*','$1')
if ($javaMajor -lt 17) { Write-Host "❌ JDK $javaMajor is below required 17+"; exit 1 }
if (-not $env:ANDROID_HOME) { Write-Host "❌ ANDROID_HOME not set — install the Android SDK + sdkmanager"; exit 1 }
if (-not (Test-Path "$env:ANDROID_HOME\platforms\android-35")) { Write-Host "❌ platforms;android-35 missing — run: sdkmanager `"platforms;android-35`""; exit 1 }
if (-not (Get-ChildItem "$env:ANDROID_HOME\build-tools\35.*" -ErrorAction SilentlyContinue)) { Write-Host "❌ Build-Tools 35.0.0 missing (provides d8) — run: sdkmanager `"build-tools;35.0.0`""; exit 1 }
"✅ android build prereqs OK"
```

> Common `ANDROID_HOME`: `~/Library/Android/sdk` (Mac), `~/Android/Sdk` (Linux), `%LOCALAPPDATA%\Android\Sdk` (Windows).

### `/build-ios-binary` — Mac + Xcode (CocoaPods optional)

Runs `xcodebuild archive` on a throwaway staging copy (see [`./ppmplugin-format.md`](./ppmplugin-format.md) §5b). **Mac-only** — on Linux/Windows this skill SKIPs with a notice and the build proceeds Android-only.

```bash
if [ "$(uname)" != "Darwin" ]; then echo "ℹ️  iOS build is Mac-only — skipping"; exit 0; fi
xcodebuild -version >/dev/null 2>&1 \
  || { echo "❌ Xcode not installed — install Xcode 16+ from the App Store, then xcode-select --install"; exit 1; }
xcode-select -p >/dev/null 2>&1 \
  || { echo "❌ Command Line Tools missing — run: xcode-select --install"; exit 1; }
# CocoaPods is OPTIONAL — the header-only iOS build path doesn't need it.
pod --version >/dev/null 2>&1 || echo "ℹ️  CocoaPods not installed (optional — header-only build doesn't need it)"
echo "✅ ios build prereqs OK"
```

### `/assemble-ppmplugin` — JDK (`jar`) only

Zips the already-built staged artifacts with `jar cMf`. The `jar` tool ships with the JDK, so this needs only a JDK on PATH.

```bash
jar --version >/dev/null 2>&1 \
  || { echo "❌ jar not found — install a JDK 17+ (jar ships with the JDK)"; exit 1; }
echo "✅ assemble prereqs OK"
```

### `/audit-ppmplugin` — `dexdump` or `strings`

Statically inspects the built bundle on disk. The DEX scan needs one of `dexdump` (ships in Build-Tools 35.0.0) or `strings`.

```bash
if command -v dexdump >/dev/null 2>&1 || command -v strings >/dev/null 2>&1; then
  echo "✅ audit prereqs OK"
else
  echo "❌ neither dexdump nor strings found — dexdump ships in Build-Tools 35.0.0; strings is on every Unix"
  exit 1
fi
```

### `/generate-ppmplugin` — none

Orchestrator. It defers every prereq check to the sub-stages it drives (`/generate-ppmplugin-manifest` → `/build-android-binary` → `/build-ios-binary` → `/assemble-ppmplugin` → `/audit-ppmplugin`), each of which runs its own check above.

---

## Auto-fix on confirmation (resolve, don't punt)

Most prereq gaps are **suggest-only** — print the fix command, stop, let the user run it. But a small **safe-list** of fixes are safe enough to offer with explicit confirmation. The skill never silently applies; it prompts:

> Detected: `<failure>`.
> The standard fix is `<command>`.
> Want me to run it now? **[yes / no]**

Only proceed on a typed `yes`. On `no`, print the command and STOP with `BLOCKED: <which fix>; user declined auto-fix`. After running a fix, **re-run the matching check** to confirm the failure is resolved, then log it to `.extension-state.md` under an `Auto-fixes:` line with the ISO timestamp.

These are OS-aware — branch on `uname` / `process.platform` per [`./shared-instructions.md`](./shared-instructions.md) §5.

| Class | Auto-fixable? | Fix (OS-aware) | Reason |
|---|---|---|---|
| JDK 17+ missing | **YES** | `brew install --cask temurin@17` (mac) / `winget install EclipseAdoptium.Temurin.17.JDK` (win) / package manager (linux) | Well-known per-user/cask install; idempotent |
| `platforms;android-35` / Build-Tools 35.0.0 missing | **YES** | `sdkmanager "platforms;android-35" "build-tools;35.0.0"` (requires the Android SDK + `sdkmanager` already present) | Adds an SDK component into an existing SDK; idempotent; no sudo |
| git missing | **YES** | `brew install git` (mac) / `winget install Git.Git` (win) / `apt install git` (linux, may need sudo) | Well-known install |
| Node.js missing | **NO** | print `nvm install 20 && nvm use 20` + the [nodejs.org](https://nodejs.org) link | Version-manager cascade is too varied per machine (nvm / fnm / volta / none) to automate safely |
| Android SDK + `sdkmanager` missing | **NO** | print the [developer.android.com/studio](https://developer.android.com/studio) link | Install via Android Studio or command-line tools; cascade too varied |
| Xcode missing | **NO** | print the instruction; STOP the iOS path (Android continues) | Mac-only, multi-GB, App Store install |
| `pac` CLI missing when .NET is present | **YES** | `dotnet tool install -g Microsoft.PowerApps.CLI.Tool` | Public per-user .NET tool install; idempotent |
| .NET SDK missing | **NO** | print the [.NET SDK](https://dotnet.microsoft.com/download) link | System-level SDK install; user-visible |
| CocoaPods missing | **NO (and optional)** | print `sudo gem install cocoapods` — but the header-only iOS build doesn't need it | sudo + global gem state |

### Hard rules for auto-fix

- **Never auto-fix without `yes`.** Default is "no fix" — a one-character `y` is fine, but silence or `<enter>` is treated as no.
- **Never auto-fix outside the safe-list.** No `sudo` system-wide installs without prompting, no tenant operations, no publish/push steps.
- **Always re-run the failed check after fixing**, to confirm. Never assume a fix worked.
- **Log the fix** in `.extension-state.md` under `Auto-fixes:` with an ISO timestamp (e.g. `Auto-fix: sdkmanager build-tools;35.0.0 at 2026-06-25T14:23:15Z`).
- **One auto-fix per turn.** If a second auto-fixable failure surfaces after re-running the check, ask again. Don't chain.

---

## Failure-message contract

When a prereq check fails, a skill MUST print:
1. **Which check failed** (one line)
2. **Why it matters** for the current skill (one line)
3. **The exact command to fix it** (one line)

Example:
```
❌ Build-Tools 35.0.0 missing
Why it matters: /build-android-binary needs d8 (in Build-Tools 35.0.0) to produce the DEX
Fix: sdkmanager "build-tools;35.0.0"
```

Do not let the user proceed past a failed check unless they explicitly confirm "I know, skip the check."
