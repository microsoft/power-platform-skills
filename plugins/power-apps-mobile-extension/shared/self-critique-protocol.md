# Self-Critique Protocol

Structured proactive review every skill that writes or edits code MUST run over its output before declaring done. Replaces a backward-looking "list of bugs we've shipped" with a forward-looking "list of questions you must answer about your own work."

The protocol is **gated reasoning**, not pattern matching. Each gate enumerates a specific category of thing (PRD-listed behaviors, user-reachable controls, mutually-exclusive modes, etc.) and forces the skill to answer concrete questions about each enumerated item. "Looks fine" is not an answer.

This protocol catches bugs the skill has never seen before, because the gates derive from first principles (small-screen layout, completeness against spec, reachability of user actions) rather than from incident history.

---

## How to use this protocol

Run the gates **in order**. Each gate's input is the set of files touched in this skill run plus the PRD. Each gate produces zero or more **findings** — structured notes describing a problem the gate's reasoning surfaced.

```
For each gate G in [PRD coverage, User journey, Layout feasibility,
                    State coverage, Cross-platform parity, Reversibility,
                    Asymptotic, Spec-drift, Runtime safety & lifecycle,
                    Buildability & bundle-fit, PCF ↔ native round-trip]:
    enumerate the items G applies to
    for each item, answer G's checkable question
    record findings
If any findings have severity = blocker → STOP, return BLOCKED.
If any findings have severity = concern → apply auto-fix if possible
                                           (re-enter gate loop after fix)
                                           else surface in final summary.
Return DONE / DONE_WITH_CONCERNS based on remaining findings.
```

A **finding** has this shape:

```
- Gate: <gate name>
- File: <path>:<line range if applicable>
- Severity: blocker | concern
- Problem: <one sentence describing what's wrong>
- Why this is wrong: <one sentence — anchor in the gate's principle>
- Suggested fix: <what to change>
- Autofix: applied | proposed | requires human review
```

The protocol completes in 3 outcomes:
- **All gates clean** → `DONE`.
- **Some concerns auto-fixed; nothing remaining** → `DONE`.
- **Concerns remain but no blockers** → `DONE_WITH_CONCERNS`.
- **Any blocker** → `BLOCKED: <list>`.

Iterate the full gate set up to 3 times: a fix at gate 3 might surface a new finding at gate 5, and the loop converges (or hits the cap; if so, surface remaining as concerns regardless).

---

## Run modes

The protocol runs in either of two scopes — same gates, different enumeration set:

- **Generation / edit mode** (default for `/generate-native-extension` Step 3.8, `/debug-extension` Step 7.5). Input = the files *touched in this run* + the PRD. Fast; keeps just-written code honest before it's declared done.
- **Holistic review mode** (on-demand — e.g. `/test-native-extension`'s opt-in deep-review layer). Input = **every source file in the control**: the native modules (`ios/`, `android/`), the PCF (`pcf/`), `manifest.json`, `build.gradle` / podspec, `AndroidManifest.xml` / `Info.plist` — regardless of who wrote them. Use it to review a hand-authored, imported, or drifted control, or to re-audit an existing repo end-to-end. Heavier (reasons over the whole tree) and **advisory by default** (returns `DONE_WITH_CONCERNS`, does not hard-block) so a broad reasoning pass can't false-positive-gate a working control. This is the deep counterpart to the fast, deterministic grep checks in `/test-native-extension` Layer 0 and `/audit-ppmplugin`.

---

## Gate 1 — PRD coverage

**Principle:** Code is correct only if it implements what the spec promised. The most common silent failure is "implemented 90% of §4.1, the remaining 10% just got skipped."

**Enumerate:** For the operation being implemented, list every behavior described in ARCHITECTURE §3.<n>. Be granular — each bullet point under "Key APIs and decisions" is a separate item; each row of "Edge cases handled" is a separate item; the "UI structure" subsection's individual claims (e.g., "Done button is anchored to the right edge") are separate items.

**For each item, answer:**
- "Which lines of code implement this behavior?"
- If the answer is "none" → finding (severity: blocker if the behavior is a core operation step, concern if it's a UI detail or edge case).

**Output shape:**

```
ARCHITECTURE §3.<n> <operationName> — <platform> implementation, N items enumerated:

✓ "<exact PRD bullet text>"
    → <path/to/file>:<line(s) where this is implemented>
✓ "<next PRD bullet text>"
    → <path/to/file>:<line(s)>
✗ "<PRD bullet text that isn't fully implemented>"
    → <what the code actually has, vs. what PRD specifies>
    Severity: concern | blocker. Autofix: applied | proposed | requires human review.
```

**Why this gate is proactive:** It doesn't rely on past bugs. It derives the checklist from the PRD itself — which is unique to this extension, written specifically for this run.

---

## Gate 2 — User journey walkthrough

**Principle:** Code is broken if any user-reachable path leads to a dead end. The compiler will not catch "user can never submit." Only walking the journey will.

**Enumerate:** For each operation the user can trigger:
1. The happy path — entry → action → submit → result.
2. The cancel path — entry → cancel → result (USER_CANCELLED).
3. Each documented error path — entry → trigger error → result.

Plus implicit dismissal paths the OS provides: Android hardware back, iOS swipe-to-dismiss on modal sheets, app backgrounding.

**For each journey, simulate:**
- "Where does the user start? What's the first thing they see?"
- "What can they tap, drag, or otherwise interact with?"
- "Does each tap have a code path that responds?"
- "Does the journey **end** — either resolving the operation Promise with success, or resolving with an error?"
- "If the journey ends in error, is the error one of the codes declared in ARCHITECTURE §5?"

A journey that doesn't end is a blocker. A journey that ends in an undeclared error code is a concern.

**Output shape:**

```
User journeys for <operationName> (N journeys enumerated):

✓ Happy path: <entry trigger> → <user actions> → <submit action> → <result code path> → Promise resolves.
✓ Cancel: <entry> → <cancel action> → Promise resolves with USER_CANCELLED (or ARCHITECTURE §5 equivalent).
✓ Implicit dismiss: <hardware back / swipe / background> → routes to cancel path.
✗ <An edge case named in PRD §4 / §9 that the code doesn't visibly handle>:
    Promised in PRD §<n> ("<exact text>"), but the code path is <missing | unclear>.
    Severity: concern | blocker. Suggested: <specific verification or fix>.
✓ <Lifecycle case>: PRD §<n> declares <behavior>; code <matches | does not match>; acceptable per §10 if out-of-scope.
```

**Why this gate is proactive:** It catches missing exit paths, unreachable controls, dead-ends — without needing a past bug that documented "we shipped a modal with no Done button once."

---

## Gate 3 — Layout feasibility and UI density

**Principle:** A horizontal row of interactive controls is a good design choice only if (a) the container handles screen-size and overflow automatically AND (b) the row isn't so dense that users struggle to scan it. Two checks, each surfaced as a suggestion if violated. Neither check forces a refactor.

**Enumerate:** For each container view (`LinearLayout`, `Row`, `HStack`, `UIStackView`, etc.) with **horizontally-laid-out** interactive children (buttons, toggles, chips — not static text or icons), apply two passes.

### Check 3a — Adaptive primitive?

**Ask:** Is the container an adaptive primitive? (See `shared/framework-recommendations.md` § "Preferred adaptive UI primitives" for the canonical list — `MaterialToolbar` with menu, `BottomAppBar`, `ConstraintLayout` with chains, `FlexboxLayout`, `HorizontalScrollView`-wrapped `LinearLayout`, `MaterialButtonToggleGroup`, `UINavigationBar`, `UIToolbar`, `UIStackView`.)

- **Adaptive** → pass for this check; proceed to 3b.
- **Manual (raw horizontal `LinearLayout` / `Row` / `HStack` without distribution)** with **3+ wrap-content interactive children** → concern. Suggestion: switch to an adaptive primitive. The usual answer for top bars is `MaterialToolbar` + menu; the usual answer when the menu model doesn't fit is a two-row split.
- **Manual but documented as deliberate** (PRD/ARCHITECTURE note explains the choice, e.g. "two-row toolbar per ARCHITECTURE §3.1") → low-severity informational note, no suggestion.

### Check 3b — UI density (logical control groups)

This check runs **regardless of whether 3a passed** — an adaptive primitive doesn't excuse a cluttered design.

**Ask:** How many **logical control groups** does this row contain?

A logical group is one user-facing affordance, not one widget:
- One `MaterialButtonToggleGroup` containing N toggles = **1 group** (one mode-selector affordance).
- A spacer / divider / static label = **0 groups**.
- Each standalone interactive widget = **1 group**.

**Soft limit: ~4 logical groups per row.** This aligns with Material and HIG guidance.

- **≤4 logical groups** → pass.
- **5+ logical groups** → concern. Suggestion: redesign the row using one of:
  - Multi-row split — group navigation actions in one row, tools in another.
  - Contextual surfacing — show some controls only when they're relevant (e.g. Undo/Redo after first stroke; color picker only when Pen is active).
  - Drawer or sheet — move secondary / tertiary actions into a bottom sheet or side drawer behind a single toolbar entry.
  - Logical grouping — combine related individual widgets into one logical group (three pen buttons → one toggle group with three options).
- **5+ groups in an adaptive primitive whose overflow swallows them** (e.g. `MaterialToolbar` menu hiding 4 of 6 actions) → concern with a sharper note: **overflow menus are appropriate for genuinely tertiary actions (Help, About, Settings), not for swallowing primary/secondary actions because the toolbar got crowded.** Suggest redesign, not just relying on the overflow.

### What the gate does NOT do

- It does NOT measure children and sum widths. Earlier drafts tried that; intrinsic-width estimation is unreliable across font scales, locales, and themes.
- It does NOT force a refactor. Adaptive primitives are preferred; the density limit is a soft guideline. Both checks surface as **concerns** with **suggestions**, with autofix posture `requires human review`. The gate's job is to make sure the user *saw* the suggestion, not to force their hand.

### Output shape

```
Container <path/to/file>:<line> (description, e.g. "top toolbar, row 1"):

  3a (adaptive primitive):
    Classification: <component type, e.g. "MaterialToolbar" | "horizontal LinearLayout (manual, non-adaptive)" | etc.>
    Interactive children: N (<comma-separated child descriptions>) → M logical groups
    Finding: <pass | "manual layout with X+ wrap-content children" | etc.>
    Severity: pass | concern.

  3b (UI density):
    Logical groups: M (<comma-separated group descriptions>)
    Finding: <pass | "exceeds soft limit of ~4">
    Severity: pass | concern.
```

```
Container <imagined denser toolbar>:

  3a: MaterialToolbar with menu — adaptive. Pass.

  3b (UI density):
    Logical groups: 6 (Cancel, Pen/Eraser toggle, Color picker, Undo, Redo, Done).
    Finding: 6 logical groups exceeds soft limit of ~4.
    Severity: concern.
    Suggestion: redesign rather than relying on MaterialToolbar overflow.
      Option A: multi-row split — nav row [Cancel] [Done], tool row [Pen|Eraser toggle, Color],
                Undo/Redo as a contextual cluster appearing only after first stroke.
      Option B: drawer/sheet — move Color and Undo/Redo into a tools drawer behind a single
                toolbar entry, keeping the resting-state row light.
    Autofix: requires human review.
```

**Why this gate is proactive:** Check 3a catches "Done off-screen on 360dp" by checking *which component* was chosen, not by estimating widths. Check 3b catches the next class of design problem — UIs that fit mechanically but are still cognitively overloaded — by counting logical affordances.

**Why concerns, not blockers:** Adaptive primitives and density limits are preferences. Legitimate exceptions exist (a documented two-row split per PRD; a deliberately rich UI where the user accepts the cognitive load trade-off). The gate makes the design choice visible; the user decides.

---

## Gate 4 — State coverage

**Principle:** Any operation with N states (modes, tabs, error conditions) needs N code paths AND N visual indicators. Forgetting either is a silent failure: code runs but the user can't tell what's happening or can't recover from a bad state.

**Enumerate:**
- Mutually-exclusive UI modes (Pen / Eraser, Draw / Pan, Read / Edit, etc.).
- Operation result branches (success / each declared error code).
- Boolean toggles whose UI state must be observable (enabled / disabled, on / off).

**For each enumerated state, ask:**
- "Is there a code path that handles this state?"
- "Is the user given a visual indication when this state is active? (For UI modes: active-tint, checked styling, etc. For errors: a message routed through the PCF's error UX from ARCHITECTURE §6.3.)"
- "Can the user transition out of this state cleanly? (For modes: tap the other one. For errors: dismiss the error and retry or cancel.)"

A state with no code path → blocker. A state with code path but no visual indicator → concern. A state the user can enter but can't exit → blocker.

**Output shape:**

```
States in <operationName>:

  UI modes (mutually exclusive): <ModeA>, <ModeB>, ...
    ✓ All have code paths in <file>.<method>.
    ✓ All have visual indicator: <how the active mode is shown — toggle group, segmented control, etc.>.
    ✓ User can transition: <how the user switches modes>.

  Operation results: ok, <error codes from ARCHITECTURE §5>
    ✓ ok: <how success is returned>.
    ✓ <ERROR_CODE>: <how this error is returned>.
    ✗ <ERROR_CODE_NOT_HANDLED>: <what's missing — code path, PCF-side mapping, etc.>.
      Severity: concern | blocker. Autofix: <applied | proposed | requires human review>.
```

**Why this gate is proactive:** It catches "implemented mode-switching but forgot the active-state indicator" without listing that as a specific anti-pattern. The principle ("every state needs code + visual + exit") generalizes.

---

## Gate 5 — Cross-platform parity

**Principle:** When the PRD specifies both an iOS and an Android implementation of the same operation, the user-facing affordances should be **equivalent**, even if the native APIs differ. A drift between platforms is usually a sign that one side cut a corner.

**Enumerate:** For each operation with both iOS and Android sections in ARCHITECTURE §3.<n>:
- List the user-visible affordances on iOS (buttons, modes, tools, gestures, dismiss paths).
- List the user-visible affordances on Android.
- Compute the diff.

**For each diff item, decide:**
- Is it documented in PRD as intentional ("iOS bonus: PKToolPicker — not replicated on Android")? → acceptable.
- Is it accidental / undocumented? → concern.

A user being able to do something on one platform but not the other (with no PRD note explaining why) → concern. Different visual treatments of the same affordance are fine if both are platform-idiomatic.

**Output shape:**

```
Cross-platform parity for <operationName>:

  iOS affordances:                          Android affordances:
    <affordance 1, e.g. Cancel (nav bar)>     <affordance 1, e.g. Cancel (nav row)>
    <affordance 2>                            <affordance 2>
    <iOS-only affordance>                     (no equivalent)
    <affordance N>                            <affordance N>

  Diff:
    <list of asymmetries, e.g. "iOS has color picker; Android does not.">
    <For each asymmetry, check PRD: documented intentional difference, or accidental gap?>
    → <Acceptable; documented difference> | <Concern; PRD does not justify the asymmetry>.
```

**Why this gate is proactive:** It catches "iOS got 5 features, Android got 3" without listing the specific missing feature in advance.

---

## Gate 6 — Reversibility

**Principle:** Every user action that mutates state should have a way out. Modals must have a cancel path. Multi-step flows must have back navigation. Destructive actions (Clear All, Delete) should ideally have a confirmation or undo.

**Enumerate:** Every user action that mutates state — taps that change a mode, clicks that submit data, drags that draw or delete.

**For each, ask:**
- "Can the user undo this in the same session?" (For modes: tap the other mode. For draws: eraser. For Clear All: ideally a confirmation prompt or undo.)
- "Can the user exit the operation entirely without committing?" (Every modal needs Cancel + back-button + swipe-dismiss handling.)

Destructive actions without confirmation → concern (often acceptable for v0; flag and document). Modals without an exit path → blocker.

**Output shape:**

```
Reversibility checks:

  ✓ <Mutating action 1>: reversible — <how the user undoes it in-session>.
  ✓ <Mutating action 2>: reversible — <how>.
  ⚠ <Destructive action without confirmation>: destructive, no confirmation prompt.
    <Cross-reference PRD §7 (Out of scope) to determine whether confirmation is in or out of scope.>
    Severity: concern (acceptable per PRD §7 (Out of scope)) | concern (PRD does not exempt).
  ✓ Modal exit: <list of exit paths — Cancel, hardware back, swipe-dismiss, etc.>.
```

**Why this gate is proactive:** It catches dead-ends and unconfirmed destructive actions by reasoning about user agency, not by checking against a list.

---

## Gate 7 — Asymptotic / lifecycle

**Principle:** Code that works in steady state can break under load: rotation, low memory, app backgrounding, fast taps, slow networks, dropped permissions. The skill won't catch every such case, but it should walk a small lifecycle checklist.

**For each touched Activity / UIViewController, ask:**
- **Rotation:** does state survive? If yes, is it implemented? If no, does PRD declare this out of scope?
- **Background → foreground:** does the operation pause/resume cleanly?
- **Low-memory kill:** is the operation's current state losable? Is that acceptable per PRD?
- **Rapid double-tap on a primary action:** is the action idempotent or guarded?
- **Permission revocation mid-flow:** if the operation needs runtime permissions, what happens if they're revoked between request and result?

Findings are usually concerns, not blockers — most are acceptable for v0 and the right answer is "documented in PRD §7 (Out of scope) out-of-scope." A finding that contradicts PRD §7 (Out of scope) (e.g., PRD says rotation is supported but code loses state) → blocker.

**Output shape:** small table per file. Don't over-engineer — this gate's value is in not silently glossing over lifecycle, not in catching every possible failure.

---

## Gate 8 — Spec-drift

**Principle:** Code and PRD must stay in sync. If a behavior implemented in the code is **not** documented in PRD — that's drift the other direction from Gate 1. Catch both.

**Enumerate:** For each non-trivial behavior in the code (a custom UI element, an edge-case branch, an error code returned, a request field consumed), check whether PRD §4 / §5 / §7 / §9 documents it.

**For each undocumented behavior, ask:**
- "Is this a stylistic detail (a margin, a color, a font size) that doesn't need to be in PRD?" → ignore.
- "Is this an observable user-facing behavior the maker / consumer needs to know about?" → finding.

Severity is usually concern, not blocker. The fix is either (a) document the behavior in PRD via `/debug-extension` PRD edits, or (b) remove the behavior from code.

**Why this gate is proactive:** Symmetric to Gate 1. Gate 1 finds spec-promises not implemented; Gate 8 finds implementations not promised. Together they keep PRD ↔ code honest.

---

## Gate 9 — Runtime safety & resource lifecycle

**Principle:** Native code that compiles and dispatches correctly can still **crash the host, hang the caller, or leak resources at runtime**. Unlike Gates 1–8 (which reason about UX / spec), this gate reasons about the module's *runtime contract*: it must construct without throwing, settle every Promise exactly once, acquire and release resources symmetrically, touch the OS on the right thread with the right permissions, and never dereference a null context. These are the failures no compiler and no single structural grep reliably catches.

**Enumerate — per native module, list:**
- **The construction closure** — everything that runs when the module is instantiated (constructor, `init{}`, property initializers, and any private fun they call).
- **Every acquired resource / listener** — `register*` / `add*Listener` / `observe`, camera / sensor / location managers, files, sockets, `Handler`s.
- **Every exported method** (`@ReactMethod` / `RCT_EXPORT_METHOD`) and its `Promise` / resolver.
- **Every thread hop** — coroutines, `Thread`, `Handler`, `dispatch_*`.
- **Every OS call that needs a runtime permission**, and every **context / `currentActivity` / `keyWindow` dereference**.

**For each enumerated item, ask:**
- **Construction:** does anything in the construction closure throw, register a callback with a `null`/implicit `Looper`, or do un-try/caught I/O? → the module crashes the host **at launch**. (blocker)
- **Resource:** is every acquired resource released on `invalidate()` / `onCatalystInstanceDestroy` / dealloc? An unreleased listener leaks and can fire into a dead module. (concern; blocker if it holds a hardware lock like the camera)
- **Promise:** does every reachable path settle its Promise **exactly once** — never zero (hang) and never twice (crash / undefined)? (blocker on a guaranteed hang or double-settle)
- **Threading:** is UI presentation on the main thread and heavy work off the JS thread? (blocker if UI is presented off-main)
- **Permission:** for each dangerous-permission API, is the permission checked first and a declared error code resolved on denial? (concern; blocker if the un-permitted call is the operation's only path)
- **Context:** is every `currentActivity` / context deref null-guarded (backgrounded app)? (blocker on an unguarded deref in a reachable path)

**Output shape:** a per-module table — `Item | Question | Finding | Severity | Fix`. Findings follow the same auto-fix policy as the other gates.

**Why this gate is proactive:** It derives from the module's runtime contract, not a list of past crashes — so it catches the whole class (unreleased camera, double-resolve, wrong-thread UI, backgrounded-context NPE, permission `SecurityException`) even for bugs never shipped before. The two known crash-classes (a Looper-less constructor `Handler`; an un-unwrapped bridge `{message}` response) fall out of the Construction and Promise questions. The fast deterministic subset of these lives in `/test-native-extension` Layer 0 (checks 12–17) and `/audit-ppmplugin` Category F; this gate is the reasoning superset that also catches what those greps can't.

---

## Gate 10 — Buildability & bundle-fit feasibility

**Principle:** A design or implementation is shippable only if it can actually be **compiled into a `.ppmplugin` and loaded by the wrap runtime**. The most expensive silent failure this plugin sees is discovering *at the Gradle / xcodebuild / assemble stage — or on device* — that a chosen library, interaction pattern, or return shape can't be expressed in the native-only bundle model, **after** design and codegen already committed to it. This gate moves that discovery to the front: it reasons about each operation against the hard bundle constraints in [`ppmplugin-format.md`](./ppmplugin-format.md) §2 (dispatch), §5 (Android DEX + pinned standalone build), §5b (iOS flat framework), §6 (what the format does NOT cover) — the same constraints the build skills enforce later, applied *before* code is trusted.

**Enumerate:** For each operation in ARCHITECTURE §3.<n>, list:
- Its **interaction pattern** (one-shot / streaming / two-way) from §2 / PRD §4.
- Each **iOS framework** (§1.2) and **Android dependency** (§1.3) the operation names.
- Its **return-value shape** (§4.2) — everything that crosses the bridge.
- Any **construction-time work** the module needs (hardware managers, listeners, I/O).

**For each item, answer (ground in the format §):**
- **Dispatch model (§2, §6):** Is the operation expressible as a **promise-based one-shot** request → response routed to `NativeModules.<module>.<method>`? Streaming and two-way have **no shipped PCF-side channel** in this bundle model (§6). → *concern* if it can degrade to one-shot / polling (document the fallback); *blocker* if the feature is meaningless without a live channel.
- **Android build ceiling (§5):** Does the dependency compile under the **pinned standalone build** — `compileSdk 35`, AGP `8.8.2`, Gradle `8.13`, React Native `compileOnly`? A dep that requires `compileSdk > 35` or AGP `> 8.8.2` will **not** build in the standalone pipeline. → *blocker*; name the exact version constraint so the user can pick a compatible library **now**, not after a failed Gradle run.
- **iOS framework model (§5b):** Can the code ship as a **FLAT device-slice `<Name>.framework`** that weak-links React (no simulator slice, no `.xcframework`, React never embedded)? A dependency that must be **statically embedded**, needs an `.xcframework`, or duplicates React symbols → *blocker*.
- **Return shape (§2, §4.2):** Does everything returned cross the bridge as **JSON** (base64 / URI for binaries; no native object handles, no file descriptors)? A return that can't be JSON-serialized → *blocker*; propose the serializable form (e.g. base64 PNG / temp-file URI).
- **Construction cost (§5):** Does the module **construct cheaply without throwing** on a possibly Looper-less thread (hardware/listeners deferred to first call)? A capability whose init inherently acquires hardware or a `Looper` at construction → *concern* (defer to lazy first-call) or *blocker* if unavoidable.
- **No JS/TS layer (§6):** Is any operation logic assumed to live in a **shipped JS layer**? None ships — logic must be **native or in the companion PCF**. → *finding* naming where the logic must move.

**Output shape:**

```
Buildability & bundle-fit for <operationName>:

  Pattern:        <one-shot | streaming | two-way> → <expressible as promise req/resp? | needs channel §6>
  iOS framework:  <name> → <ships as flat weak-linked framework? | blocker: needs xcframework/static embed>
  Android dep:    <name> → <builds at compileSdk 35 / AGP 8.8.2? | blocker: needs compileSdk >35 / AGP >8.8.2>
  Return shape:   <shape> → <JSON-serializable? | blocker: <what can't cross the bridge>>
  Construction:   <init work> → <cheap + non-throwing? | concern: defer to lazy first-call>
  JS-layer logic: <none | finding: <logic that must move to native/PCF>>

  ✗ <the specific infeasibility>  — Severity: blocker | concern.  Suggested: <the concrete alternative>.
```

**Severity:** *blocker* when the operation **cannot be built or dispatched at all** in the bundle model (unbuildable dependency, non-serializable return, streaming with no fallback). *concern* when it works with a **documented degrade** (one-shot fallback for streaming, lazy init, a swapped library).

**Why this gate is proactive:** It derives from the bundle's build + dispatch **contract**, so it catches "this can't ship as a `.ppmplugin`" at design / codegen instead of after the toolchain fails minutes later. The deterministic subset lives in the build skills (`/build-android-binary`, `/build-ios-binary` assert §5 / §5b) and `/audit-ppmplugin`; this gate is the reasoning superset run early — which is exactly the stage the maker can still change the design cheaply.

---

## Gate 11 — PCF ↔ native round-trip contract

**Principle:** A native module that dispatches correctly is still broken **end-to-end** if the companion PCF can't reach it or can't read its response. The failures here are the worst kind — they pass every zip / manifest / DEX / compile check and **only surface on device** (a silent no-op tap, or every call failing though native succeeded). This gate reasons about the **full round-trip** across the three artifacts that MUST agree: the committed `./manifest.json`, the native module, and `pcf/**/index.ts`. Ground it in [`ppmplugin-format.md`](./ppmplugin-format.md) §2 (*Runtime dispatch contract*) — the same invariants `/audit-ppmplugin` Category F checks deterministically.

**Enumerate:** When a companion PCF exists in this run or the tree (`pcf/<…>/index.ts`), list:
- The **composite routing key** the PCF binds, vs `<manifest.name>/<receivers[].name>`.
- The **dispatch transport + envelope** the PCF uses.
- The inner **`args`** shape.
- The **success-path** response handling.
- **Each error code path** (module codes from ARCHITECTURE §5 + the transport codes).

**For each item, answer (ground in §2):**
- **Key agreement:** Does the PCF `COMPOSITE_KEY` equal `<manifest.name>/<receivers[].name>`, and is the dispatched `method` one of `receivers[].methods`, backed by a real `@ReactMethod` / `RCT_EXPORT_METHOD`? A mismatch dispatches to a receiver the manifest never registers → fails on first call → *blocker*.
- **Transport:** Does the PCF dispatch via `window.PowerApps.NativeExtension.sendAsync` and **never** call `cordova.exec` / any `cordova.*` directly? The raw `cordova` global isn't in the PCF sandbox — a direct call is a **silent on-device no-op** (worst on Android) → *blocker*.
- **Envelope:** Is the payload a **raw object** `{ method, args: [request] }` and NOT pre-`JSON.stringify`'d (sendAsync stringifies internally)? Pre-stringifying double-encodes → proxy parses a string → `BRIDGE_FAILED` → *blocker*.
- **Args array:** Is the inner `args` a **JSON array** (`args: [request]`, one request object at `args[0]`)? The proxy does `Array.isArray(parsed.args) ? parsed.args : []` and **drops a bare object** → native gets no payload → *blocker*.
- **Response unwrap:** Does the success path run an `extractResponse`-style unwrap of the wrap `{ isUpdate, message:"<json>" }` **transport container** (parse `result.data`, then probe `message`) — NOT a bare single `JSON.parse`? A single parse lands on the container and fails **every** call with `UNEXPECTED_PAYLOAD` though native succeeded → *blocker*.
- **Error mapping:** Does **every** module error code (ARCHITECTURE §5) **and** every transport code (`BRIDGE_FAILED`, `PARSE`, `UNEXPECTED_PAYLOAD`, `NOT_IN_WRAP`) map to a PCF output carrying **both** the code AND the human-readable message? A dropped `message` leaves an on-device failure undebuggable → *concern*.

**Output shape:**

```
PCF ↔ native round-trip (<name>/<receiver>):

  ✓ Composite key: PCF "<key>" == manifest "<name>/<receiver>"; method ∈ receivers[].methods; backed by @ReactMethod/RCT_EXPORT_METHOD.
  ✓ Transport: sendAsync only; no cordova.exec / cordova.* reference.
  ✓ Envelope: raw { method, args: [request] } — not pre-stringified.
  ✓ Args: JSON array; one request object at args[0].
  ✓ Response: extractResponse unwraps the { isUpdate, message } container (not a bare JSON.parse).
  ✗ Error mapping: <CODE> reaches no PCF output / drops the message.
      Severity: blocker | concern.  Suggested: <the specific wiring fix>.
```

**Severity:** *blocker* for the silent-on-device failures (key mismatch, `cordova.exec`, double-encode, non-array `args`, container-not-unwrapped). *concern* for incomplete error mapping.

**Why this gate is proactive:** It reasons about the dispatch round-trip as a **contract between three artifacts**, so it catches PCF-communication gaps at generation time rather than at the final `/audit-ppmplugin` (Category F) or on a device with no console. The deterministic subset lives in `/test-native-extension` Layer 0 and `/audit-ppmplugin` Category F; this gate is the reasoning superset. `/generate-pcf-companion` runs this gate's reasoning as its Step 5.7 round-trip self-verify even when it runs standalone (outside a `/generate-native-extension` self-critique pass).

---

## Severity guide

When rendering findings in a visible block, prefix the severity per `shared-instructions.md §9.3`: 🔴 blocker, 🟡 concern (🟢 for a clean/passing gate). Keep the word + `✓/✗/⚠` glyph too — the dot only makes the blocker pop.

| Severity | When | What happens |
|---|---|---|
| 🔴 **blocker** | The user cannot complete the documented operation. Examples: no Done button, modal with no exit, primary action overflows off-screen. | Skill returns `BLOCKED`. If autofix is `applied` and the re-loop resolves it, severity drops. |
| 🟡 **concern** | The operation works but has a flaw worth flagging — undocumented behavior, asymmetric platform features, accessibility miss, missing confirmation on a destructive action. | Skill returns `DONE_WITH_CONCERNS: <count>`. Listed in `.extension-state.md`. |

If unsure, classify higher and let the user demote.

---

## Auto-fix policy

The protocol does NOT include an `autofix: high/medium/low` field per gate. The judgment is per-finding, made by the skill at the moment of finding it. Three categories:

| Category | When the skill applies it | Examples |
|---|---|---|
| **applied** | The fix is **mechanical** (no design choice). The skill applies it before reporting. Logs in `.extension-state.md` what was auto-fixed. | Adding a missing `isSingleSelection=true` flag. Adding a missing `import`. Replacing a raw resource key with a human-readable string. |
| **proposed** | The fix is **structural** but unambiguous. The skill writes the fix and gates on user confirm before applying. | Splitting a toolbar into two rows. Wrapping buttons in a toggle group. Switching from string-typed bridge response to ExtensionResult. |
| **requires human review** | The fix involves **design judgment**. The skill flags and surfaces but does not propose code. | "Eraser semantics need redesign" — pick rubber-pixel vs stroke-erase. "Done content shape" — what does Submit return for this operation? |

Generation skills (`/generate-native-extension`) lean toward `applied` because there's no human between code emission and final file write. Interactive-fix skills (`/debug-extension`) lean toward `proposed` because the user is already in an interactive review cadence.

---

## What this protocol does NOT do

- It does not run code. It is LLM reasoning over generated source.
- It does not catch every bug — the reasoning can be sloppy. Gates are designed to force enumeration, but they don't enforce correctness inside each enumeration step.
- It does not check platform-specific issues that require runtime measurement (real font scaling, dynamic content sizes, OS-version-specific rendering bugs).
- It is not a substitute for `/test-native-extension` Layer 5 (manual device verification). Self-critique catches design-time errors; Layer 5 catches runtime errors. Both are necessary.

---

## When to update this protocol

Update the gate list when:
- A new **category** of failure is discovered that doesn't map cleanly to an existing gate. (Don't keep extending one gate forever; if Gate 3 grows to 10 sub-checks, split it.)
- A gate is consistently producing **noise** — many findings that aren't real problems. Either tighten the question or remove the gate.
- The set of "things to enumerate" in a gate changes (e.g., a new platform is added; the PRD format changes).

Do **not** update the protocol by adding "AP-A07: foo" anti-pattern entries. That's the reactive shape we deliberately moved away from. If a specific past bug needs to be guarded against, find which gate's reasoning should have caught it — and if no gate would have, that's a sign the gate set needs a new entry, not the protocol needs a fix-list appended.
