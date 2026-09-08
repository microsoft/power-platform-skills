---
name: assemble-ppmplugin
description: "Assemble the final `.ppmplugin` binary bundle for a PAM native extension and verify its contents. First **reconciles** the manifest's declared `entrypoints` against the binaries actually staged — if the manifest declares a platform with no built binary it gates (build it / ship without it / stop) rather than shipping a broken bundle. Then re-runs the plugin's upload-compatibility checks on the reconciled manifest, zips the manifest plus whichever of `android/<PascalName>Plugin.dex` and `ios/<PascalName>Plugin.framework/` are present into `ppmplugin/<name>.ppmplugin`, and verifies the archive layout with `jar tf` (exactly the manifest + the shipped binaries — nothing missing, nothing extra). Output: a statically verified `.ppmplugin` file on disk. Prereqs: `jar` (JDK). Run after /generate-ppmplugin-manifest and the build skill(s)."
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, AskUserQuestion, Skill
model: sonnet
---

# /assemble-ppmplugin

The final step: take the label (`manifest.json` from [`/generate-ppmplugin-manifest`](../generate-ppmplugin-manifest/SKILL.md)) and the binaries the build skills produced, zip them into the single `<name>.ppmplugin` file, and verify the box contains exactly the right items. The output is the deliverable — the file you can hand off / upload. Before zipping, it **reconciles** the manifest's declared platforms against the binaries that actually built, so the shipped bundle never claims a platform it doesn't contain.

Read [`shared/ppmplugin-format.md`](../../shared/ppmplugin-format.md) §1 — the bundle layout this skill produces and verifies.

## What this skill does NOT do
- Does not author the manifest or build any binary — it consumes the staged outputs of the prior third-party-control skills (manifest + the build skill(s)).
- Does not upload to Dataverse / wire into a canvas app (Stage 3 — deferred).
- Does not build any binary — it consumes whatever the build skills staged (`android/<Pascal>Plugin.dex` from `/build-android-binary` and/or `ios/<Pascal>Plugin.framework/` from `/build-ios-binary`) and bundles those present.

---

## Step 1 — Read shared docs + prereq block

1. Read [`shared/shared-instructions.md`](../../shared/shared-instructions.md) and [`shared/ppmplugin-format.md`](../../shared/ppmplugin-format.md).
2. Prereq: `jar` (ships with the JDK). Print the visible block (shared-instructions §9.2):

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 Prereq check — /assemble-ppmplugin
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 🟢 ✓ jar (JDK) available
 🟢 1 check passed, 0 failed. Ready to proceed.
```

If `jar` is missing, STOP with `BLOCKED: jar not found — install a JDK (JDK 17)`.

---

## Step 2 — Reconcile declared entrypoints against staged binaries (the gate)

The shipped bundle's `manifest.json` MUST declare exactly the platforms whose binaries are in the zip — no more, no less. The manifest was authored from *intent* (target choice); this step makes it match *reality* (what actually built). This is the one place that sees the final set of binaries, so it owns consistency.

1. Read `ppmplugin/staging/manifest.json` — else STOP with `NEEDS_CONTEXT: manifest missing — run /generate-ppmplugin-manifest`. Read `name` for the output filename `<name>.ppmplugin` (the **version is NOT in the filename** — it lives in the manifest's `version` field; the wrap pipeline reads it from there. Still read `version` to show it in the deliverable report).
2. **Declared** platforms: is `entrypoints.android` present? `entrypoints.ios`?
3. **Staged** binaries:
   - Android: `ppmplugin/staging/android/<dex>` exists, where `<dex>` = `entrypoints.android.dex`.
   - iOS: `ppmplugin/staging/ios/<framework>.framework/` exists (a **flat** `.framework`, NOT an `.xcframework` — [§5b](../../shared/ppmplugin-format.md)), where `<framework>` = `entrypoints.ios.framework`. If an `.xcframework` is staged instead, surface it as a gate — the wrap CI can't ingest it; re-run `/build-ios-binary` for the flat device-slice framework.
4. Reconcile, per platform:

| Declared | Staged | Action |
|---|---|---|
| yes | yes | ship it ✓ |
| yes | **no** | **MISMATCH → gate** (below) |
| no | yes | binary present but the manifest won't route it — surface; offer to re-run `/generate-ppmplugin-manifest` to declare it, or leave it out |
| no | no | not part of this bundle — ignore |

5. If nothing is both declared AND staged → STOP with `NEEDS_CONTEXT: no built binary to ship — run a build skill first`.

**The mismatch gate (declared but not staged).** Do NOT silently ship a manifest pointing at a missing binary. The situation is genuinely ambiguous (changed-my-mind vs forgot-to-build), so surface it and ask via `AskUserQuestion`:

> *"Manifest declares `<platform>` but no `<platform>` binary is staged."*
> - **Build `<platform>` first** — run the build skill (`/build-android-binary`, or `/build-ios-binary` for iOS, Mac-only) [invoke it via the Skill tool — execute, don't describe]
> - **Ship without `<platform>`** — remove `entrypoints.<platform>` from the staged `manifest.json`, ship the platforms that ARE built
> - **Stop**

If the user picks "Ship without", **edit the staged `manifest.json` to drop that entrypoint** before continuing. After this step, the manifest's `entrypoints` set equals the staged-binary set exactly.

---

## Step 3 — Final validation pass

Re-run the [`ppmplugin-format §4`](../../shared/ppmplugin-format.md) validation rules on the **reconciled** staged `manifest.json` (it may have been edited in Step 2 or by hand). Also cross-check, for each shipped platform:
- Android: `entrypoints.android.dex` exactly matches the staged DEX filename.
- iOS: `entrypoints.ios.framework` matches the staged `…/<framework>.framework` directory name, and that `.framework/` carries the binary + `Headers/<framework>.h` + `Modules/module.modulemap` + `Info.plist` (the wrap-CI requirements — `/audit-ppmplugin` does the deep check; flag here if any are obviously absent).

If validation fails, STOP with `BLOCKED: manifest validation — <rule>` and do not produce the
bundle. A `.ppmplugin` that fails the local compatibility checks is not ready for upload.

---

## Step 4 — Zip + verify

**Before zipping:** if the output `ppmplugin/<name>.ppmplugin` already exists, do NOT silently overwrite it — ask via `AskUserQuestion`: **Replace** [default] / **Keep existing** (stop, leave the prior bundle untouched). Proceed to zip only on Replace.

1. **Zip** the manifest plus **only the platform folder(s) reconciled as shipped in Step 2**. Pass them explicitly so the build dirs (`android-build/`, `ios-build/`) are never swept in. `jar` (JDK) recurses directories, so it handles the iOS `.framework` tree, and it behaves identically on every OS — only the shell glue differs (§5):

   macOS / Linux (bash):
   ```bash
   mkdir -p ppmplugin
   # list only the shipped platforms, e.g. `android` for Android-only, `android ios` for Both:
   ( cd ppmplugin/staging && jar cMf "../<name>.ppmplugin" manifest.json android ios )
   ```

   Windows (PowerShell):
   ```powershell
   New-Item -ItemType Directory -Force ppmplugin | Out-Null
   Push-Location ppmplugin\staging
   jar cMf ..\<name>.ppmplugin manifest.json android ios
   Pop-Location
   ```
   (`-M` = no JAR manifest entry; the bundle's `manifest.json` is our own. Drop `ios` (or `android`) from the argument list if that platform isn't shipped.) On **Replace** (confirmed above), the prior bundle is overwritten.

2. **Verify layout** — list and assert it matches the reconciled manifest exactly:
   ```bash
   jar tf ppmplugin/<name>.ppmplugin
   ```
   Android-only expects exactly:
   ```
   manifest.json
   android/<Pascal>Plugin.dex
   ```
   A **Both** bundle also has `ios/<Pascal>Plugin.framework/…` entries (flat framework — binary + `Headers/` + `Modules/module.modulemap` + `Info.plist`). STOP with `BLOCKED: unexpected bundle contents` (and the actual listing) if: a build dir leaked in (`android-build/`, `ios-build/`), a stray file appears (`.DS_Store`, `META-INF/`), an `ios/<…>.xcframework/` is present (must be a flat `.framework`), or a declared platform's binary is missing. The bundle must contain exactly the manifest + the entrypoints' binaries — nothing else.

---

## Step 5 — Report

Update the `## ppmplugin (third-party controls)` block in `.extension-state.md`: `Bundle: <name>.ppmplugin assembled <ISO timestamp> (v<version>, platforms: <android[,ios]>)`. Print the deliverable as a visible fenced block (shared-instructions §9.1, informational form):

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 .ppmplugin ready
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 ppmplugin/pen-input.ppmplugin   (v0.1.4, Android-only)
 Contents:
   manifest.json
   android/PenInputPlugin.dex
 Next: /audit-ppmplugin — verify the bundle is upload-ready before shipping it.
       (Then: deploy the dispatcher PCF via /publish-pcf-companion, and upload the
        .ppmplugin via the wrap wizard — Stage 3, not yet a skill.)
```

Then offer the next step via `AskUserQuestion` (shared-instructions §9.1 — **invoke the chosen skill via the Skill tool; execute, don't describe**):
- **Run /audit-ppmplugin** (recommended — the final upload-readiness gate: validator rules + DEX SDK-leakage scan + iOS framework checks)
- **Run /publish-pcf-companion** (deploy the dispatcher PCF to a Power Platform env)
- **Stay — I'll inspect the bundle first**

(When `/assemble-ppmplugin` runs as an internal stage of `/generate-ppmplugin`, the orchestrator invokes `/audit-ppmplugin` automatically and this gate is skipped.) Return `DONE` with the bundle path.
