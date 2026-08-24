# Error codes & messages — the canonical catalog

This is the **single source of truth** for the error codes a third-party `.ppmplugin`
control can surface, what each one means, where it originates, and how to trace it.
It exists so a failure in the field is *diagnosable*: the binary runs inside the
customer's wrap shell with **no logcat / Xcode console / native debugger reachable**,
so the `error` code + human-readable `message` the control returns are often the only
evidence available. `/debug-extension` reads this file to map a reported symptom back
to its likely source.

Who uses this file:

| Skill | How it uses the catalog |
|---|---|
| `/design-native-extension-feature` | Declares each operation's error set in **ARCHITECTURE §5** using these canonical names (extend with domain-specific codes as needed). |
| `/generate-native-extension` | Emits the module-layer codes via `errorJson(code, message)` (see [`generate-native-extension` §3.4/§3.5](../skills/generate-native-extension/SKILL.md)). |
| `/generate-pcf-companion` | Emits the transport-layer codes and surfaces `ErrorCode` / `ErrorMessage` outputs. |
| `/test-native-extension`, `/audit-ppmplugin` | Verify code parity across native ↔ manifest ↔ PCF. |
| `/debug-extension` | Maps a reported code / message / symptom → likely layer → files to inspect (the **symptom map** below). |

---

## 1. The response envelope (recap)

The native module resolves the Promise with a two-level object (never throws, never
resolves empty) — full detail in [`ppmplugin-format.md §2`](ppmplugin-format.md):

```jsonc
{ "status": "ok" | "error", "result"?: <success payload>, "error"?: "<CODE>", "message"?: "<human-readable reason>" }
```

- On `status === "error"`, **both** `error` (a stable machine code from this catalog) and
  `message` (a human-readable reason) MUST be present. A bare code with no message is
  undebuggable in the field.
- The PCF peels the wrap transport container with `extractResponse`, then exposes
  `Status` / `ErrorCode` / `ErrorMessage` (+ a raw `<name>Json` diagnostic) so the failure
  is visible from Power Fx.

**Codes are stable strings.** Canvas formulas branch on them; never reword an existing
code (that silently breaks maker formulas and this catalog). Add a new code instead.

---

## 2. Module-layer codes (emitted by the native module)

These come from the Kotlin / Obj-C module via `errorJson(code, message)`. "Expected?"
distinguishes a *normal outcome the maker handles* (not a bug) from a *defect to fix*.

| Code | Meaning | Typical origin / where to look | Expected? |
|---|---|---|---|
| `USER_CANCELLED` | The user dismissed / backed out of the presented UI before completing the operation. | The Cancel / dismiss / back handler in the native module or its presented Activity/ViewController. | ✅ Normal — maker branches on it. |
| `PERMISSION_DENIED` | A runtime OS permission (camera, mic, location, …) was not granted. | Android `ContextCompat.checkSelfPermission` guard; iOS authorization callback. Also check the `AndroidManifest.xml` / `Info.plist` declaration exists. | ✅ Normal — surface a prompt-to-settings UX. |
| `INVALID_INPUT` | The request args were missing, malformed, or failed validation. | The `@ReactMethod` / `RCT_EXPORT_METHOD` argument-parse + validation block. Message should name the offending field. | ✅ Normal — a maker wiring mistake. |
| `NO_ACTIVITY` | *(Android only)* No foreground Activity to present UI on — app was backgrounded. | The `currentActivity ?: return promise.resolve(errorJson("NO_ACTIVITY", …))` guard. | ✅ Normal — transient. |
| `NOT_FOUND` | A referenced resource / file URI / record does not exist. | The lookup step in the operation body. | ✅ Normal. |
| `NETWORK_ERROR` | An HTTPS / network call failed. | The network call site; message names the failure class (timeout / offline / non-2xx) without the URL or response body. | ✅ Normal. |
| `NOT_SUPPORTED` | The capability / API is unavailable on this OS version or device. | The feature-availability check (e.g. `isAvailable`, API-level guard). | ✅ Normal — maker hides the control. |
| `TIMEOUT` | The operation exceeded its deadline. | The timeout / deadline guard in the operation body. | ✅ Normal. |
| `INTERNAL_ERROR` | Catch-all for an unexpected exception. The caller-visible message MUST be a **fixed, caller-safe string** plus a correlation id — never `e.message` / `exception.reason` / `error.localizedDescription`. | The outer `try/catch` (and every coroutine / `Thread` / async callback) in the operation body. **A frequent, real bug** — match the correlation id to the device log for the actual cause. | ⚠️ Usually a defect. |

> **Naming discipline.** Use these exact spellings. Do **not** introduce synonyms
> (`INVALID_ARGUMENT`, `BAD_REQUEST`, `INTERNAL`, `UNSUPPORTED_PLATFORM`) — divergent
> spellings for the same condition are exactly what makes field failures hard to triage.
> Domain-specific codes are welcome (`ENCODE_FAILED`, `SCAN_ABORTED`, …) — declare them in
> ARCHITECTURE §5 and keep native (iOS + Android) byte-identical.

---

## 3. Transport / PCF-layer codes (emitted by the dispatcher PCF)

These never come from the native module — the PCF's `invokeBridge` / `extractResponse`
produces them when the round-trip itself fails. See
[`generate-pcf-companion` §onTrigger](../skills/generate-pcf-companion/SKILL.md) and
[`ppmplugin-format.md §2`](ppmplugin-format.md).

| Code | Meaning | Typical root cause / where to look |
|---|---|---|
| `NOT_IN_WRAP` | The host global `window.PowerApps.NativeExtension.sendAsync` is absent. | Running in **Studio preview / a browser**, not inside the wrap shell — usually benign. If it happens **on device**, the host build is too old or the control is loaded outside wrap. |
| `BRIDGE_FAILED` | `sendAsync` resolved with `status !== "ok"` (its own `error`). | The wrap transport rejected the call. Common causes: `native module '<x>' not loaded` (DEX/framework didn't load — see §4 signatures), `method '<m>' not found` (method-name / manifest drift), or a malformed composite key `<name>/<receiver>`. |
| `PARSE` | The resolved `result.data` could not be reduced to an object. | The native side returned a non-JSON string, or `errorJson` was built with string interpolation and a `"`/`\`/newline corrupted the JSON. Inspect the raw `<name>Json` output. |
| `UNEXPECTED_PAYLOAD` | Parsed fine but the shape has no top-level `status`. | The PCF did a bare single `JSON.parse` instead of `extractResponse` (landing on the `{ isUpdate, message }` container), **or** the native response shape genuinely doesn't match the `{ status, result?/error? }` convention. |

---

## 4. Failure signatures that are NOT a returned code

Some of the highest-frequency field failures never produce a clean `error` code — they
surface as a crash, a silent no-op, or a wrap-transport string. These are the first
things `/debug-extension` checks:

| Symptom (what the user reports) | Likely root cause | Where to look |
|---|---|---|
| **Nothing happens on tap; no error on screen** (worst on Android) | The PCF called `cordova.exec` directly (undefined in the PCF sandbox → swallowed `ReferenceError`), **or** inner `args` wasn't an array (silent empty call). | `pcf/<Pascal>PCF/index.ts` — must use `sendAsync`, `args: [request]`. |
| Host log: **`Loaded 0 plugin package(s)`** / `native module '<x>' not loaded` | Android `ReactPackage` lacks a **public no-arg constructor**, or the DEX didn't load. | Android package class; the `<Name>Plugin.dex` build; `manifest.json` `packageClass`. |
| **App crashes at launch** (before any UI) | The native module constructor / `init{}` threw (registered a callback with a `null` Looper, did I/O eagerly, etc.). | Native module constructor — must be cheap + non-throwing; defer hardware/listener registration to first method call. iOS: `+requiresMainQueueSetup` = `NO`, no-arg `[cls new]`. |
| `BRIDGE_FAILED: method '<m>' not found` | The PCF's `method` / composite key drifted from the module's real `@ReactMethod` / manifest `methods[]`. | `./manifest.json` `receivers[]` ↔ native method names ↔ PCF dispatch key `<name>/<receiver>`. Run `/test-native-extension` Layer 0. |
| **React header / undefined-symbol errors** at build/link | The control's `react-native` pin diverged from the wrap host's RN. | `package.json` RN pin (`0.79.7`) vs the host's RN — a pin problem, not a code bug. |
| Every call returns `UNEXPECTED_PAYLOAD` though native "worked" | Bare single `JSON.parse` instead of `extractResponse` (lands on the `{ isUpdate, message }` container). | `pcf/<Pascal>PCF/index.ts` `invokeBridge` / `extractResponse`. |
| A real failure shows up as `PARSE` | `errorJson` (or a success JSON) built with string interpolation, corrupted by a quote/newline in the message. | Native `errorJson` helper — must serialize via `JSONObject` / `NSJSONSerialization`. |

---

## 5. Message-quality rules (what makes a message debuggable)

Every `message` is the maker's / support engineer's primary evidence. It MUST:

1. **Name the specific cause using caller-safe wording** — the offending field
   (`missing required field 'uri'`), the denied permission (`CAMERA not granted`).
   **Never** interpolate exception text (`e.message`, `exception.reason`,
   `error.localizedDescription`), stack traces, internal paths, URLs, raw payloads, or any
   customer data: the dispatcher PCF surfaces this string verbatim as `ErrorMessage`.
2. **Be built via the JSON serializer**, never string interpolation — a `"`, `\`, or
   newline in the reason would corrupt the JSON and surface as a misleading `PARSE`.
3. **Be present on every error path** — `errorJson(code, message)`, never a bare code,
   never a thrown/uncaught exception, never a never-resolved Promise.
4. **Include enough context to locate the operation** — when practical, mention the
   receiver / method so the maker knows *which* call failed.
5. For `INTERNAL_ERROR`, return a **fixed message** (e.g. `"The operation could not be
   completed."`) plus a **correlation/trace id**, and log the full exception under that id
   with `Log.e` / `NSLog` where it stays on-device. The id links the maker's report to the
   real cause without putting exception text on the wire.

---

## 6. Adding a new code

1. Add it to ARCHITECTURE §5 for the operation(s) that emit it.
2. Emit it identically on **both** native platforms (byte-identical JSON).
3. Handle it (or pass it through verbatim) in the PCF error mapping.
4. Add a row here if it's reusable across operations (domain-specific one-offs can stay
   in ARCHITECTURE §5).

Keep this catalog synchronized with the native modules and dispatcher PCF. Module-layer codes
describe native outcomes; transport-layer codes describe the wrap `sendAsync` path.
