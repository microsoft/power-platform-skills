---
name: debug-extension
description: "Diagnose and fix failures in a built third-party `.ppmplugin` control: crashes, silent no-ops, PCF error outputs, or incorrect behavior. Uses the reported symptom, `shared/error-codes.md`, and file-level evidence to trace the manifest, Android/iOS modules, PCF dispatch, and build configuration. Produces a ranked diagnosis, asks for approval, then applies a surgical fix while keeping the committed manifest and affected contracts synchronized. Re-validates manifest changes through /generate-ppmplugin-manifest."
---

# /debug-extension

Investigate a failure the user observed while testing a **built** `.ppmplugin` control,
find the root cause, and fix it. The wrap binary runs inside the customer's shell with
**no logcat / Xcode console / native debugger reachable**, so the evidence is usually just
the PCF's `ErrorCode` / `ErrorMessage`, the raw `<name>Json` diagnostic output, a host log
line, or the user's description of what they saw. This skill turns that thin evidence into
a located root cause and a fix.

**Investigation-first, fix as the resolution.** Unlike a plain "apply this change" flow,
`/debug-extension` starts from a *symptom* and works backward to a *cause* before touching
code. When the cause is found, it proposes the fix and applies it under the same discipline
a careful edit uses (spec-vs-drift diagnosis, contract-consistency, surgical edits, gates).

**This is one door, not the only door.** Per `shared/shared-instructions.md §7.5`, a fix
can be applied from *any* skill or a plain conversational turn — the user is never blocked
or forced to route through this skill. What this skill adds is *structure* for a reported
problem: the symptom→layer triage, the dispatch-path trace, and the located-evidence
diagnosis before any edit. Reach for it when something *broke on device* and you don't yet
know why; for a planned feature change where you already know what to edit, just edit
directly.

**When to use:**
- "I tapped the button and nothing happened — no error, no UI." (silent no-op)
- "The PCF shows `ErrorCode: PARSE` / `ErrorMessage: ...`." (a code to trace)
- "The app crashes the moment the screen loads." (crash-at-launch)
- "Host log says `Loaded 0 plugin package(s)`." (a native-load signature)
- "It works on iOS but does nothing on Android." (parity / transport bug)
- "The Done button returns the wrong data." (behavior drift)

**When NOT to use:**
- No repo yet → `/generate-native-extension`.
- A brand-new operation → `/design-native-extension-feature`, then generate.
- A planned change with a known edit and no reported failure → just edit (any skill / chat).
- A build that never produced a binary → the failure is a *build* failure; run
  `/generate-ppmplugin` and read its stage output first.

**Decoupled from generate-*.** This skill refuses to run if no extension repo is detected.
It does NOT scaffold, install dependencies, build binaries, or assemble the bundle. It
diagnoses, then edits files.

---

## Step 0 — Verify this is an extension repo

Detect the repo in this order. Stop with `BLOCKED: not an extension repo (no <X> found)`
if any **required** signal is missing.

| Signal | Required? | Check |
|---|---|---|
| `PRD.md` exists at repo root | **Yes** | The spec is the baseline the observed behavior is compared against. |
| `package.json` exists at repo root | **Yes** | Confirms this is a generated extension repo, not a random directory. |
| `ARCHITECTURE.md` exists at repo root | No | Strongly preferred — holds the dispatch contract + per-op impl the trace follows. Note its absence as a concern. |
| `.extension-state.md` exists at repo root | No | Informational — prior edits / drift entries are debugging leads. Created at Step 9 if absent. |
| `pcf/` folder with a `ControlManifest.Input.xml` inside | No | Drives PCF detection. Capture as `has_pcf: true|false` via `find pcf -name ControlManifest.Input.xml 2>/dev/null`. |
| `ppmplugin/` build output / a `.ppmplugin` artifact | No | Informational — confirms a binary was built (this skill debugs *built* controls). Absence → the failure may be pre-build; note it. |

If PRD or `package.json` is missing, suggest `/generate-native-extension` and stop.

---

## Step 1 — Read shared docs, PRD, ARCHITECTURE, manifest, and state

In this order:

1. `shared/shared-instructions.md` — constants, return-status codes (`DONE` / `DONE_WITH_CONCERNS` / `BLOCKED` / `NEEDS_CONTEXT`), safety rules.
2. **`shared/error-codes.md`** — the canonical catalog + the **symptom → likely cause → where-to-look** map. This is the core input to triage (Step 3). Read it fully.
3. `shared/naming-conventions.md` — maps PRD identity to file paths for the trace.
4. `shared/repo-layout.md` — the expected file tree.
5. `shared/ppmplugin-format.md` — the dispatch contract, the wrap `sendAsync` transport, the `{ isUpdate, message }` response container, and the native-load model (`§2`, `§5`, `§5b`). Essential for tracing transport / load failures.
6. `./PRD.md` — full read (identity, operations, expected behavior).
7. `./ARCHITECTURE.md` — full read (SDK pin, per-op impl walkthroughs, message contract, §5 error codes, manifest impl). The trace follows this.
8. `./manifest.json` — the committed dispatch contract (`name`, `receivers[].method`, `receivers[].nativeModule`).
9. `./.extension-state.md` — prior `## Edits` / `## Debug` entries and any recorded drift — often the fastest lead.

**Skip `shared/prereq-check.md`.** Debug installs/auths nothing. If a fix later needs the
PCF `npm run build`, Step 8 surfaces a missing toolchain then.

Per `shared-instructions.md §9.2`, print a one-line prereq notice at the start of Step 1:

```
Prereq check — /debug-extension: skipped (skill does no installs / auth / network — investigation only until a fix's smoke check).
```

---

## Step 2 — Capture the bug report

Gather the symptom. If the user invoked the skill with no detail, prompt for it — ask for
whichever of these they have (one consolidated prompt, not five):

- **What happened vs. what they expected** (the observable behavior).
- **`ErrorCode` / `ErrorMessage`** shown on the PCF (or in Power Fx via `Self.ErrorCode` / `Self.ErrorMessage`).
- **The raw `<name>Json`** diagnostic output (the wire bytes — transport-level forensics).
- **Any host log line** (e.g. `Loaded 0 plugin package(s)`, `native module '<x>' not loaded`, `method '<m>' not found`, a stack trace).
- **Platform** (iOS / Android / both) and **when** it happens (at launch / on tap / after the operation).
- **Repro steps**, if any.

Keep the raw report in working context for the trace — do not paraphrase away detail, since
an exact code or message is the highest-signal input. **Do not persist it verbatim.**
`.extension-state.md` is committed to the repo, and a pasted report routinely carries a raw
response, stack trace, host log lines, file paths, URLs, tokens, or customer data. Step 9
writes a redacted one-line summary instead — see the redaction rule there.

---

## Step 3 — Triage: map the symptom to candidate layers

Using **`shared/error-codes.md`** (§2 module codes, §3 transport codes, §4 no-code
signatures), classify the symptom into one or more **candidate layers**, most-likely first:

| Layer | Reached when the symptom looks like… |
|---|---|
| **PCF / transport** (`pcf/<Pascal>PCF/index.ts`) | `PARSE`, `UNEXPECTED_PAYLOAD`, `BRIDGE_FAILED`, `NOT_IN_WRAP`; silent no-op on tap; every call fails identically. |
| **Dispatch contract** (`./manifest.json` ↔ native names ↔ PCF key) | `method '<m>' not found`, `native module '<x>' not loaded`, `BRIDGE_FAILED` with a routing message; works on one platform only. |
| **Native module — Android** (`android/.../<Pascal>Module.kt`) | `INTERNAL_ERROR` / `PERMISSION_DENIED` / `NO_ACTIVITY` on Android; Android-only crash; `Loaded 0 plugin package(s)`. |
| **Native module — iOS** (`ios/RCT<Pascal>Module.m`) | `INTERNAL_ERROR` / `PERMISSION_DENIED` on iOS; iOS-only crash / no-op; `+moduleName` / `requiresMainQueueSetup` load issue. |
| **Native load / lifecycle** (constructor, package class) | Crash **at launch** before any UI; module never loads. |
| **Build config / RN pin** (`package.json`, `android/build.gradle`, `.podspec`) | React header / undefined-symbol errors; behavior tied to an SDK level; a pin divergence from the host RN. |
| **Behavior / spec** (native op body vs PRD/ARCHITECTURE) | Wrong result, missing control, incorrect payload — no error code, just wrong output. |

A single report can span layers (e.g. `UNEXPECTED_PAYLOAD` is *usually* PCF, but *can* be a
non-conforming native response). List every plausible layer; Step 4 confirms/eliminates.

If the report is too thin to triage, ask **one** targeted clarifying question (e.g. "Does
it fail on both platforms or just one?"). If still unclear, stop with
`NEEDS_CONTEXT: <what's unclear>`.

---

## Step 4 — Investigate: trace the path and gather evidence

For each candidate layer, read the implicated files and confirm or eliminate the hypothesis
with concrete evidence. Do NOT guess — open the file and cite the line.

Convention-derived files (substitute `<Pascal>` / `<lower>` from PRD identity via
[`shared/naming-conventions.md`](../../shared/naming-conventions.md)):

- **PCF / transport** → `pcf/<Pascal>PCF/index.ts` (`invokeBridge`, `extractResponse`, `onTrigger` outcome branch, `args: [request]`, the composite key), `pcf/<Pascal>PCF/ControlManifest.Input.xml`.
- **Dispatch contract** → `./manifest.json` `receivers[]`; native `getName()` (Android) / `+moduleName` (iOS); the PCF composite key `<name>/<receiver>` + `method`. Cross-check all three agree.
- **Native Android** → `android/src/main/java/com/powerapps/<lower>/<Pascal>Module.kt` (+ `<Pascal>CaptureActivity.kt`), the `ReactPackage` class (public no-arg constructor), `android/src/main/AndroidManifest.xml`.
- **Native iOS** → `ios/RCT<Pascal>Module.{h,m}` (`+moduleName`, `+requiresMainQueueSetup`, no-arg init), the presented VC.
- **Build / pin** → `package.json` (RN pin `0.79.7`), `android/build.gradle`, `ios/<Pascal>Extension.podspec`.

Trace techniques:
- **Follow the dispatch path end-to-end**: PCF key → `sendAsync` envelope (`{ method, args: [request] }`) → manifest `receivers[]` → native method → response JSON → `extractResponse` → PCF output. A break anywhere is the bug.
- **Grep for the specific symbol** in the report (an error code, a field name, a method name) across `ios/`, `android/`, `pcf/` to find every site that emits or consumes it.
- **Compare iOS vs Android** when the symptom is platform-specific — the delta is the lead.
- **Check the raw `<name>Json`** against the `{ status, result?/error?, message? }` convention and the wrap `{ isUpdate, message }` container — a shape mismatch points to `extractResponse` vs a bare parse.
- **Match against `error-codes.md §4 signatures**: `Loaded 0 plugin package(s)` → Android package no-arg ctor; `cordova.exec` in the PCF → forbidden (silent no-op); React header errors → RN pin divergence.

Read `shared/self-critique-protocol.md` if the trace touches a per-operation impl — its
gates (state coverage, cross-platform parity, lifecycle) sharpen the hypotheses.

---

## Step 5 — Root-cause diagnosis + gate

Present a ranked diagnosis. Each hypothesis is anchored in evidence, not intuition:

```
Diagnosis for: "<verbatim symptom>"

1. [HIGH confidence] <one-line root cause>
   Evidence: <file>:<line> — <what the code does / doesn't do>
   Why it produces this symptom: <one sentence tied to error-codes.md>
   Layer: PCF | dispatch contract | native-android | native-ios | native-load | build/pin | behavior

2. [MEDIUM confidence] <alternative cause>
   Evidence: ...

Ruled out: <hypothesis> — <why the evidence eliminates it>

Recommended fix (for #1): <what would change, in which file(s)>
```

**Gate**: `Proceed with the fix for #1? (yes / investigate #2 instead / show me <file> / stop)`.

- On `stop` → `BLOCKED: user stopped after diagnosis` (nothing edited; diagnosis logged at Step 9).
- On `investigate #2` → deepen that hypothesis, re-present.
- If **no** hypothesis reaches at least MEDIUM confidence after the trace → stop with
  `NEEDS_CONTEXT: <what additional evidence is needed>` (e.g. "please paste the raw
  `<name>Json` output" or "a host log line from the crash"). Never fabricate a fix for an
  unconfirmed cause.

---

## Step 6 — Fix plan + spec-vs-drift check + gate

Now derive the fix. First classify it the same way a careful edit does, because a fix can
be more than a code patch:

| Case | What the fix is | Action |
|---|---|---|
| **B — code drift** (most common) | The code diverged from a spec that is already correct (e.g. a missing `extractResponse`, a wrong composite key, a swallowed exception). | Fix the code only. Print `<doc> §<n> already specifies the correct behavior — fixing code only.` |
| **A — spec wrong** | The observed behavior is actually what PRD/ARCHITECTURE currently says, but that spec is wrong. | Propose the PRD/ARCHITECTURE edit **first** (its own mini-gate), apply it, then derive the code. |
| **C — both** | Spec is ambiguous/partial and code is partial. | Update the doc detail, then fix the code. |

Then present the code fix plan:

```
Fix plan:

<path/to/file>
  - Replace: <specific symbol / region> → <replacement> (rationale tied to the diagnosis)
  - Add:     <specific addition>

Contract impact: <"none" | "method set / receiver / nativeModule moves — ./manifest.json + PCF key updated in this same change, re-staged via /generate-ppmplugin-manifest">
Total: N files changed.
Apply? (yes / no / show me <file>)
```

**Contract seam.** If the fix changes the method set, the receiver/routing name, or the
native-module name (Android `getName()` / iOS `+moduleName` = `<Pascal>Module`), three
artifacts move **together** in this fix: native source, the committed `./manifest.json`
(`receivers[]` / `methods`, edited surgically), and the PCF composite key `<name>/<receiver>`.
Then `/generate-ppmplugin-manifest` re-validates + re-stages the manifest. A pure-behavior
fix that leaves those unchanged does not touch the manifest.

If the fix requires PCF edits but `has_pcf: false`, stop with `BLOCKED: this fix requires
PCF edits but pcf/ is not scaffolded — run /generate-pcf-companion first`.

**Gate**: wait for explicit `yes`. On `no` → `BLOCKED: user declined fix plan` (diagnosis
still logged). On `show me <file>` → print the proposed content and re-ask.

---

## Step 7 — Apply the fix

Apply the planned edits with the `Edit` tool. Rules:

- **Surgical, not wholesale.** Change the lines the diagnosis identified; don't rewrite the
  function or file. Reserve `Write` for a genuinely new file (rare in debug).
- **Atomic per file.** Apply all edits to one file in sequence; never leave a file
  half-edited.
- **Atomic across files (best effort).** If a multi-file batch fails mid-way, stop, report
  which files were written and which weren't, and tell the user to `git diff` / `git
  checkout` the half-written ones. Do NOT auto-revert (destructive, not on the safe list).
- **No collateral edits.** Only touch files on the plan. Note unrelated issues in the
  summary; don't fix them in this pass.

---

## Step 7.5 — Self-critique against the proactive protocol

After applying, re-read every touched file and walk
[`shared/self-critique-protocol.md`](../../shared/self-critique-protocol.md). A fix that
resolves the reported symptom can introduce a new one (fixing an Android crash by deferring
init might leave a first-call race; correcting the composite key might orphan an output).

1. **Re-read** each edited file fresh from disk (not from memory).
2. **Walk the gates** — PRD coverage, user journey, layout, state, cross-platform parity,
   reversibility, lifecycle, spec-drift, plus the 3P Gates 10 (buildability / bundle-fit)
   and 11 (PCF↔native round-trip). Pay special attention to **Gate 11** — most debug fixes
   touch the very round-trip that broke.
3. **Report + apply fixes** per the protocol's severity/autofix cadence: mechanical fixes in
   one batch (one `yes`); structural fixes each gated; judgment calls surfaced as concerns.
   Re-loop up to 3 iterations.

Return-status impact: all gates clean → continue. Blockers deferred → `BLOCKED:
self-critique blockers — <list>` (fix stays applied; user re-runs after deciding).
Concerns remain → continue with `DONE_WITH_CONCERNS`.

---

## Step 8 — Verify the fix

Verify the fix actually addresses the symptom, scoped to what was edited:

**Validate before you interpolate.** `<Pascal>` comes from PRD identity, not from a constant —
a crafted or malformed value turns the command below into arbitrary shell or escapes the
project directory. Before running it: require `<Pascal>` to match `^[A-Za-z][A-Za-z0-9]*$`
(no separators, dots, or path segments), resolve `pcf/<Pascal>PCF` and confirm the real path
stays inside `pcf/`, then pass it as a single quoted argument rather than splicing it into
shell syntax. On failure, STOP with `BLOCKED: refusing to run a build command with an invalid
<Pascal> value — <value>`.

| Files edited | Verification | Why |
|---|---|---|
| Any `pcf/<Pascal>PCF/` `.ts` / `ControlManifest.Input.xml` | `npm run build --prefix "$PCF_DIR"` | The only TS build in the repo — catches type + manifest errors immediately. |
| Only `.kt` / `.m` / XML | Print: `Native files fixed — compile + on-device validation defer to /build-android-binary // /build-ios-binary (via /generate-ppmplugin) and /test-native-extension Layer 5. Rebuild + retest on device to confirm the symptom is gone.` | Native standalone compile isn't reliable here; the build skills do the real compile. |
| Contract moved (`./manifest.json` / names) | Re-run `/generate-ppmplugin-manifest` (re-validate + re-stage), then note that `/generate-ppmplugin` (rebuild + `/audit-ppmplugin`) is needed. | The staged manifest and the binary must be regenerated for the fix to reach the device. |

**The definitive verification for a field bug is a rebuild + on-device retest** — a passing
smoke check confirms the fix compiles, not that the symptom is gone. Say so explicitly in
the summary. On smoke-check failure: report the failing command + the most relevant error
line, do NOT auto-revert, stop with `BLOCKED: smoke check failed — <one-line cause>` (still
log at Step 9).

---

## Step 9 — State log + summary

### 9.1 Update `.extension-state.md`

Append (don't overwrite) to a `## Debug` section (create it if absent):

```markdown
## Debug

- <ISO timestamp> — <one-line summary of the bug + fix>
  - Symptom: "<redacted one-line summary — see the redaction rule below>"
  - Root cause: <located cause> (<file>:<line>)
  - Diagnosis case: A | B | C
  - Docs changed: <sections, or "none">
  - Code changed: <file paths>
  - Contract moved: <"none" | "receiver/method/nativeModule changed — ./manifest.json updated; re-staged via /generate-ppmplugin-manifest">
  - Verification: <PCF npm run build → PASS | native — rebuild + device retest required | etc.>
  - Status: DONE | DONE_WITH_CONCERNS: <reasons> | BLOCKED — <reason>
```

**Redact before writing.** `.extension-state.md` is committed to the repo, so treat every
field as published. The `Symptom` line is a short paraphrase — the error code, the affected
operation, and the observable behaviour — never the pasted report. Strip, from every field:
secrets and tokens; PII and customer data; request/response payloads and their fragments;
absolute or internal filesystem paths; internal URLs and hostnames; and stack traces beyond
the single frame that locates the cause. Keep `Root cause` to the repo-relative `<file>:<line>`
that already lives in source control. If a detail is needed to justify the fix but can't be
redacted safely, leave it out of the file and keep it in the chat.

### 9.2 Final summary + next step

One paragraph: the located root cause, what was fixed, and the verification outcome — and
**state plainly that an on-device retest (after a rebuild) is what confirms the symptom is
resolved**. Then offer the next step via `AskUserQuestion` (shared-instructions §9.1),
picking the options that fit the fix:

- **Run /generate-ppmplugin** — rebuild the `.ppmplugin` + re-audit (re-validates + re-stages `./manifest.json` first). The recommended next step for a native or contract fix.
- **Run /test-native-extension** — re-validate the contract (Layer 0 cross-check; Layer 4 PCF compile). Good for a PCF or contract fix before the full rebuild.
- **Run /generate-pcf-companion** — only if the fix needs PCF edits but `pcf/` isn't scaffolded.
- **Stay — I'll retest on device first.**

Per the **Execute, don't describe** HARD RULE (§9.1), when the user picks a `Run /…` option,
invoke that skill via the `Skill` tool in the same turn. Don't *auto*-chain on your own.

---

## Hard rules

1. **Never fix without a located cause.** Every fix traces to file:line evidence from
   Step 4/5. No confirmed cause → `NEEDS_CONTEXT`, not a speculative patch.
2. **Two gates: diagnosis, then fix plan.** Never edit code silently. On a case-A/C spec
   fix, the doc edit gets its own mini-gate first.
3. **Never blow away unrelated files.** Only files on the Step 6 plan are touched — no
   drive-by refactors.
4. **Never auto-revert on failure.** Surface it, stop; the user reviews `git diff`.
5. **File-edit policy — three categories** (identical to the generate/edit discipline):
   - **Tool-managed — NEVER edit:** `.git/`, lockfiles (`pnpm-lock.yaml`, `package-lock.json`, `Podfile.lock`), the generated bundle + its staging (`ppmplugin/staging/manifest.json`, `ppmplugin/` outputs, any `.ppmplugin`), PCF generated artifacts (`pcf/<Pascal>PCF/generated/`), build outputs (`lib/`, `dist/`, `build/`, `pcf/<Pascal>PCF/out/`), `*.bak.*`, `.claude/`. (The committed `./manifest.json` at repo root is the opposite — a consumer site you DO edit when the contract moves.)
   - **Skill-managed — updated only via the canonical state step:** `.extension-state.md` (this skill's Step 9). No mid-flow direct edits.
   - **User-editable on request:** `.gitignore`, `CHANGELOG.md`, `LICENSE`, `README.md`, PCF `eslint.config.js` / `tsconfig.json`, and all source (`ios/**`, `android/**`, `pcf/<Pascal>PCF/{index.ts,ControlManifest.Input.xml}`).
6. **Atomic per file, best-effort across files.**
7. **Contract stays consistent.** If a fix moves the method set / receiver / nativeModule,
   `./manifest.json` + native + PCF move together, then re-stage via
   `/generate-ppmplugin-manifest`. Verify with `/test-native-extension` Layer 0.
8. **Spec and code stay in sync.** A case-A/C fix updates PRD/ARCHITECTURE first; a case-B
   fix logs the drift as such. Never silently update the spec to match a bug.
9. **PCF is auto-detected, never assumed.** No `pcf/<Pascal>PCF/ControlManifest.Input.xml`
   → don't write to `pcf/`; route to `/generate-pcf-companion` if the fix needs it.
10. **Don't *auto*-chain; do honor an explicit pick** at Step 9.2.
11. **A smoke check is not an on-device confirmation.** Always tell the user the fix must be
    rebuilt and retested on device to confirm the field symptom is gone.

---

## Scenarios — how the flow plays out

### Scenario 1 — Silent no-op on Android (PCF transport bug)

```
Step 2: Symptom = "tap does nothing, no error, only on Android."
Step 3: Triage → PCF/transport (error-codes.md §4 top row) + dispatch contract.
Step 4: Read pcf/.../index.ts — invokeBridge calls cordova.exec directly, no sendAsync.
        Evidence: index.ts:NN. Matches the §4 signature (cordova undefined in PCF sandbox).
Step 5: [HIGH] cordova.exec used instead of the host-injected sendAsync → silent no-op,
        worst on Android. Gate: proceed.
Step 6: Case B (ppmplugin-format §2 already specifies sendAsync). Fix plan: replace
        cordova.exec with window.PowerApps.NativeExtension.sendAsync + args:[request].
Step 7: Apply. 7.5: self-critique Gate 11 (round-trip) clean.
Step 8: cd pcf && npm run build → PASS. Note: rebuild PCF + retest on device.
Step 9: Log case B; suggest /test-native-extension then /generate-pcf-companion publish path.
```

### Scenario 2 — Crash at launch (native load)

```
Step 2: Symptom = "app crashes the moment the control's screen opens", host log
        "Loaded 0 plugin package(s)".
Step 3: Triage → native-load + native-android.
Step 4: Read the ReactPackage class — constructor takes an argument (no public no-arg
        ctor). Matches error-codes.md §4 "Loaded 0 plugin package(s)".
Step 5: [HIGH] ReactPackage has no public no-arg constructor → runtime instantiation fails
        fails → 0 packages loaded. Gate: proceed.
Step 6: Case B. Fix: add the public no-arg constructor.
Step 7: Apply. 7.5: Gate 10 buildability clean.
Step 8: Native-only → defer to /build-android-binary; rebuild + device retest required.
Step 9: Log; recommend /generate-ppmplugin (rebuild + audit).
```

### Scenario 3 — Wrong output (behavior drift, spec is right)

```
Step 2: Symptom = "Done returns the image without the drawing layer."
Step 3: Triage → behavior/spec + native (both platforms).
Step 4: Read both native op bodies vs ARCHITECTURE §3.n export step. Android composites
        only the base bitmap; iOS composites both. Evidence: <Pascal>Module.kt:NN.
Step 5: [HIGH] Android export omits the ink layer; ARCHITECTURE §3.1 says composite both.
        Gate: proceed.
Step 6: Case B (spec already correct). Fix Android export to match. Cross-platform parity.
Step 7: Apply. 7.5: Gate 5 parity now holds.
Step 8: Native-only → rebuild + device retest. Step 9: log; suggest /generate-ppmplugin.
```

---

## Failure modes

| What happens | What the skill does |
|---|---|
| PRD / `package.json` missing | STOP with `BLOCKED: not an extension repo`; suggest `/generate-native-extension`. |
| Symptom too thin to triage after one clarifying question | STOP with `NEEDS_CONTEXT: <what's needed>` (e.g. paste `<name>Json` / a host log line). |
| No hypothesis reaches ≥ MEDIUM confidence | STOP with `NEEDS_CONTEXT` — never fabricate a fix. |
| User stops after diagnosis | `BLOCKED: user stopped after diagnosis`; diagnosis logged. |
| User declines the fix plan | `BLOCKED: user declined fix plan`; diagnosis (and any doc edit already applied) logged. |
| Fix requires PCF edits but no `pcf/` | STOP; route to `/generate-pcf-companion`. |
| Smoke check fails | `BLOCKED: smoke check failed — <cause>`; edits stay; log the failure. |
| Edit tool fails (e.g. `old_string` not unique) | Surface the precise error; don't retry blindly; report which files applied. |

---

## Return status

End every run with one of:

- `DONE` — root cause located, fix applied, smoke check passed (or native-only with the rebuild+retest reminder printed).
- `DONE_WITH_CONCERNS: <list>` — fix applied but with caveats (self-critique concerns, missing expected files, an unconfirmed secondary hypothesis).
- `BLOCKED: <reason>` — user stopped/declined, smoke check failed, PRD missing, or PCF needed but absent.
- `NEEDS_CONTEXT: <what's unclear>` — symptom too thin, or no cause reached sufficient confidence.
