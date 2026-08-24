---
name: generate-ppmplugin
description: The single entry point for the third-party-control track — produces a verified `.ppmplugin` binary bundle from an extension repo end-to-end. The user invokes ONLY this skill; every stage runs internally. Detects which native platforms the repo can actually build (`android/build.gradle` → Android; `ios/RCT*Module.{h,m}` → iOS), recommends the right target set (both / Android-only / iOS-only) based on what's present, confirms via `AskUserQuestion`, then drives the stage skills in sequence with gates between — `/generate-ppmplugin-manifest` → `/build-android-binary` and/or `/build-ios-binary` → `/assemble-ppmplugin` → `/audit-ppmplugin` (the final verification gate). The bundle is native binaries only (`manifest.json` + `android/` and/or `ios/`); no TS / JS layer ships. If any stage fails, halts with a clear handoff — never silently continues with a partial or unverified build. Run after the native module exists.
---

# /generate-ppmplugin

**The single entry point** for the third-party-control track. The user invokes only `/generate-ppmplugin`; the five stage skills (`/generate-ppmplugin-manifest`, `/build-android-binary`, `/build-ios-binary`, `/assemble-ppmplugin`, `/audit-ppmplugin`) are **internal stages** this orchestrator drives in order — they are not the user's entry points. Inspect the repo, pick the right target set, run manifest → build skill(s) → assemble → audit in sequence. The user runs **one** skill; they get a *verified* `.ppmplugin` on disk (or a clear stop with the failing stage).

Read [`shared/ppmplugin-format.md`](../../shared/ppmplugin-format.md) §1 — the bundle layout this orchestrator produces.

## What this skill does NOT do
- Does not author the manifest, build the DEX, build the framework, zip the bundle, or run the audit itself — those are the stage skills. This skill **invokes** them in the right order, with the right inputs, and gates between them.
- Does not skip any stage's confirmations / mismatch gates / replace-existing prompts — those still surface to the user. The orchestrator just removes the "which stage next?" decision so the user never has to invoke a stage directly.
- Does not upload to Dataverse or wire into a canvas app (Stage 3 — deferred).
- Does not edit source code under `src/`, `ios/`, `android/` — every stage builds from a staged copy. The repo is read-only from the build's perspective.

---

## Step 1 — Read shared docs + prereq summary

1. Read [`shared/shared-instructions.md`](../../shared/shared-instructions.md) and [`shared/ppmplugin-format.md`](../../shared/ppmplugin-format.md).
2. Confirm the working directory is a third-party-control repo: a `package.json` (dev-only `<kebab>-control` name — **not** a published `@powerapps/extension-*` scope; this track ships a binary, not an npm package) and either `android/` or `ios/` (or both). If missing, STOP with `NEEDS_CONTEXT: not a third-party-control-ready repo — missing <list>` and point at [`shared/repo-layout.md`](../../shared/repo-layout.md).
3. Print the orchestrator prereq block (sub-skills each re-run their own prereq check when invoked — this is the summary the user sees up front so they know what's required end-to-end):

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 Prereqs — /generate-ppmplugin (end-to-end)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 /generate-ppmplugin-manifest  — no toolchain (pure read + validate + write)
 /build-android-binary         — JDK 17, Android SDK Build-Tools 35 (d8), Gradle
 /build-ios-binary             — Xcode 16+ (26.2+ recommended; CocoaPods optional — header-only path)  (Mac-only)
 /assemble-ppmplugin           — jar (JDK)
 /audit-ppmplugin              — jar (JDK); dexdump or strings (DEX scan)
```

Each stage will surface its own prereq failure when reached (don't pre-fail the orchestrator on a missing tool the user may have on a different machine).

---

## Step 2 — Detect available targets

Look at the repo to see which native platforms could actually build. **Detection is structural, not aspirational** — the user can't ship a platform whose source doesn't exist.

| Target | Detection signal |
|---|---|
| Android | `android/build.gradle` exists AND `android/src/main/java/**/*.kt` contains a `ReactContextBaseJavaModule` subclass |
| iOS | `ios/RCT*Module.h` declaring `<RCTBridgeModule>` AND a `.m` with `+ (NSString *)moduleName` (**NOT** `RCT_EXPORT_MODULE`) (podspec **optional** — only declares extra iOS system frameworks; `/build-ios-binary` builds from the `.h/.m` source + the `react-native` devDep headers, not the podspec) |

Print a visible ✓/✗ block:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 Targets available in this repo
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 🟢 ✓ Android — android/build.gradle + PenInputModule.kt found
 🟢 ✓ iOS     — ios/RCTPenInputModule.h (+ .m with +moduleName) found
```

(If a signal is present but malformed — e.g. `android/` exists but no Kotlin module — list it as ✗ with the specific gap. `/generate-ppmplugin-manifest` will run the deeper structure preflight; this orchestrator just sees if there's enough to consider the platform a viable target.)

If neither target is viable → STOP with `NEEDS_CONTEXT: no native target available — repo has neither a buildable android/ nor ios/ module`. The `.ppmplugin` format requires at least one native entrypoint; a manifest-only bundle is not shippable.

---

## Step 3 — Recommend + confirm the target set

Use the detection from Step 2 to pre-mark the recommended option, then confirm with `AskUserQuestion`:

- **Both available** → recommend **Both**. Reasoning: the whole pipeline runs in one shot; the user gets a bundle that works on every mobile platform.
- **Android only available** → recommend **Android-only**. No iOS source to build.
- **iOS only available** → recommend **iOS-only**. No Android source to build.

```text
Question: Which target(s) should this .ppmplugin ship?
- Both (Recommended)           — runs /build-android-binary AND /build-ios-binary
- Android only                  — skips iOS even though the source is here
- iOS only                      — skips Android even though the source is here
```

Only show options whose target is viable. If only Android is viable, do not offer "Both" or "iOS only" — just confirm "Android-only" (one option is still worth confirming so the user can cancel).

**On Mac-only constraint:** if the user picks Both or iOS-only on a non-Mac, surface a one-line warning (`/build-ios-binary` is Mac-only and will halt the orchestrator when reached). Offer to fall back to Android-only or stop.

Record the chosen target set; it's the contract every downstream sub-skill sees.

---

## Step 4 — Run the stages in sequence (with gates)

Invoke each stage via the `Skill` tool. After each step, check its result; on `DONE` continue, on `BLOCKED` / `NEEDS_CONTEXT` halt the orchestrator with a clear handoff. Do not try to auto-recover — a failed stage is a signal the user needs to look.

### 4.1 — `/generate-ppmplugin-manifest`

Invoke `Skill: generate-ppmplugin-manifest`. On the normal flow the committed `./manifest.json` already exists (authored by `/generate-native-extension` at scaffold time), so the sub-skill **validates it, reconciles its `entrypoints` to the chosen target, and writes the staged build copy** `ppmplugin/staging/manifest.json` — it does not re-author the contract. (If the repo has no `./manifest.json` — a hand-authored module — the sub-skill falls back to authoring it from source.) It runs its own structure preflight, asks the target via `AskUserQuestion` (default to the orchestrator's choice from Step 3 — recorded in `.extension-state.md` so the sub-skill doesn't re-prompt unnecessarily), and returns `DONE` with the staged manifest path.

**Re-run safety.** If a staged manifest already exists from a prior run, the sub-skill's re-run mode (Step 1.5 in its SKILL.md) handles update / keep-as-is; that's not the orchestrator's concern.

### 4.2 — Build skill(s) in parallel where possible

The Android and iOS builds are **independent** — they touch different staging directories (`ppmplugin/staging/android-build/` vs `…/ios-build/`) and produce different outputs. Run them concurrently when both are selected:

| Target set | Sub-skills invoked |
|---|---|
| Android-only | `Skill: build-android-binary` |
| iOS-only | `Skill: build-ios-binary` |
| Both | both, in a single turn (parallel `Skill` tool calls) |

Each build skill returns `DONE` (with the staged binary path) or `BLOCKED` (prereq / build failure). On a Both target, if one build fails and the other succeeds, ask via `AskUserQuestion`:

> *"`/build-<platform>` failed; `/build-<other>` succeeded. How do you want to proceed?"*
> - **Fix and re-run the failing build** — stop the orchestrator; the user investigates the failure
> - **Ship `<other>`-only** — drop the failing platform from the target set, continue to assemble
> - **Stop**

If both fail → STOP with `BLOCKED: no platform built — see sub-skill output above`.

### 4.3 — `/assemble-ppmplugin`

Invoke `Skill: assemble-ppmplugin`. The stage reconciles the manifest's native entrypoints against the staged binaries, re-validates, zips, and verifies. It returns `DONE` with the `.ppmplugin` path.

If the user dropped a platform in Step 4.2 (Ship `<other>`-only), the stage's own reconcile gate will offer to remove the missing entrypoint from `manifest.json` — accept that, since the orchestrator already made that decision upstream. Pass through without re-prompting if the underlying tooling allows.

### 4.4 — `/audit-ppmplugin` (final verification gate)

Invoke `Skill: audit-ppmplugin` on the `.ppmplugin` that `/assemble-ppmplugin` just produced (pass the bundle path). This is the gate that turns "well-formed zip" into "will actually load on device": it re-runs the validator rules against the built artifact, scans the DEX for SDK-era leakage (`INativeExtension*`, `sendAsync`, `HermesBytecodeLoader`, …), checks manifest↔bundle consistency and the source-to-receiver contract, and returns a verdict.

- `DONE` (0 CRITICAL) → the bundle is verified; continue to Step 5 and report **READY TO UPLOAD**. Surface any WARNINGs in the final report.
- `BLOCKED` (≥1 CRITICAL) → do NOT report success. Halt with the audit's CRITICAL findings and the owning-stage handoff (audit already routes each finding to `/generate-ppmplugin-manifest` or the build skill). The bundle exists on disk but is **not** upload-ready; the user fixes upstream and re-runs `/generate-ppmplugin`.

Because the orchestrator runs audit automatically, the user never invokes `/audit-ppmplugin` themselves on the happy path — it's the last internal stage.

---

## Step 5 — Report

Print the final deliverable as a visible block (informational, no question):

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 /generate-ppmplugin — DONE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 Bundle: ppmplugin/pen-input.ppmplugin   (v0.1.4)   ✓ audit: READY TO UPLOAD
 Target: Both (Android DEX + iOS framework)
 Steps:  manifest ✓  build-android ✓  build-ios ✓  assemble ✓  audit ✓
 Next:   • deploy the dispatcher PCF → /publish-pcf-companion
         • upload this .ppmplugin via the wrap wizard + wire the PCF into a
           canvas app (Stage 3 — not yet a skill).
```

Then offer the actionable next step via `AskUserQuestion` (shared-instructions §9.1 — invoke via the Skill tool):
- **Run /publish-pcf-companion** (deploy the dispatcher PCF to a Power Platform env — needed before the control works in a canvas app)
- **Run /debug-extension** (debug/refine the control, then re-run /generate-ppmplugin)
- **Stay — I'll upload the .ppmplugin manually** (Stage 3 isn't a skill yet)

Return `DONE` with the bundle path. Only report this block when audit returned `DONE` — a bundle
that failed audit is reported via the failure handoff below, never as success.

---

## Failure handoffs

The orchestrator's value is *single entry point on the happy path*. On a failure it should surface, **not absorb**. Each handoff names the failing stage and tells the user to re-run `/generate-ppmplugin` after fixing — they fix upstream, not by invoking a stage directly:

| Failure | Handoff message |
|---|---|
| Manifest derivation blocked | `BLOCKED at manifest stage — <reason>. Fix the flagged item, then re-run /generate-ppmplugin.` |
| Android build failed | `BLOCKED at android-build stage — <reason>. The manifest in ppmplugin/staging/manifest.json is preserved; re-run /generate-ppmplugin after fixing.` |
| iOS build failed (Mac-only) | `BLOCKED at ios-build stage — <reason>. If you don't have Xcode here, re-run on a Mac or pick "Android-only" target.` |
| Assemble failed | `BLOCKED at assemble stage — <reason>. The staged binaries are intact; re-run /generate-ppmplugin after fixing.` |
| Audit found CRITICAL | `BLOCKED at audit stage — <N> CRITICAL finding(s). The .ppmplugin was built but is NOT upload-ready. <first finding + its routed fix>. Fix upstream, then re-run /generate-ppmplugin.` |

Never report a partial or unverified `.ppmplugin` as success. A bundle missing a declared
entrypoint, or carrying SDK-leakage in its DEX, will fail during upload or silently on device;
surface the gap here instead.
