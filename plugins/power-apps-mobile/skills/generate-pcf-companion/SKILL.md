---
name: generate-pcf-companion
description: Generate the dispatcher PCF for a third-party `.ppmplugin` (wrap-runtime) control. Runs `pac pcf init` in the pcf/ subfolder, rewrites ControlManifest.Input.xml from ARCHITECTURE §6, and writes index.ts derived from ARCHITECTURE §4 (message contract), §8 (PCF surface), §9 (error UX) — no placeholders. The bridge dispatches the composite key `<name>/<receiver>` to `NativeModules.<nativeModule>.<method>` via the host-injected `window.PowerApps.NativeExtension.sendAsync` global (never `cordova.exec` — not in the PCF sandbox); also emits a `PowerAppsNativeExtension.d.ts` ambient declaration. Responses are peeled with `extractResponse`. Emits structured JSON debug/error logs. Validated by `npm run build`. **Local only** — does not deploy. Needs only `pac` CLI. Run after the native module exists. Uses npm (not pnpm).
---

# /generate-pcf-companion

Generates the dispatcher PCF — the Canvas Studio control that calls the third-party native module through the host-injected `window.PowerApps.NativeExtension.sendAsync` global, routed by the composite key `<name>/<receiver>` read from the committed `./manifest.json` (the source of truth `/generate-native-extension` authors at scaffold time). Lives at `pcf/<Pascal>PCF/` in the same repo the native module lives in. The PCF is a Studio-side companion; it is **NOT** part of the `.ppmplugin` bundle (the bundle ships native binaries only — `manifest.json` + `android/`/`ios/`).

This skill assumes the native module already exists in the repo. Run it after the module is in place.

> **PCF framework reference (public Microsoft Learn docs).** Ground `pac pcf init`, the `ControlManifest.Input.xml` schema, the `init`/`updateView`/`getOutputs`/`destroy` lifecycle, and the `usage` (`bound`/`input`/`output`) rules against the official Power Apps Component Framework docs — they are the authority when this skill's templates and the live framework disagree. (The `sendAsync` transport + `extractResponse` response-unwrap specifics are this track's own, in [`shared/ppmplugin-format.md §2`](../../shared/ppmplugin-format.md) — not in these generic PCF docs.)
> - Overview: <https://learn.microsoft.com/en-us/power-apps/developer/component-framework/overview>
> - Create a code component: <https://learn.microsoft.com/en-us/power-apps/developer/component-framework/create-custom-controls-using-pcf>
> - Custom controls overview: <https://learn.microsoft.com/en-us/power-apps/developer/component-framework/custom-controls-overview>

---

## Step 1 — Read the shared docs and the PRD

1. Read [`shared/shared-instructions.md`](../../shared/shared-instructions.md), [`shared/naming-conventions.md`](../../shared/naming-conventions.md), [`shared/ppmplugin-format.md`](../../shared/ppmplugin-format.md), [`shared/repo-layout.md`](../../shared/repo-layout.md).
2. Apply the **per-skill minimal prereq policy** ([`shared-instructions.md §1.5`](../../shared/shared-instructions.md)). This skill needs Node + `pac` CLI only — `pac pcf init` is a local file generator and `npm install`/`npm run build` under `pcf/` only needs Node. It does NOT need pnpm, package-feed authentication, .NET SDK runtime, or active `pac auth`.

   **Print the prereq status as a visible block per `shared-instructions.md §9.2`** before continuing:

   ```
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    Prereq check — /generate-pcf-companion
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

    🟢 ✓ Node 20+ installed                   (for npm install + tsc under pcf/)
    🟢 ✓ pac CLI installed                    (for pac pcf init)

    🟢 2 checks passed. Ready to proceed.
   ```

   If `pac` is missing, STOP with the fix command (`dotnet tool install -g Microsoft.PowerApps.CLI.Tool` — note: installing `pac` requires .NET SDK as a one-time install, but neither .NET nor `pac auth` is needed at runtime for scaffold). If Node is missing, STOP with the install instruction. Run the **`/generate-pcf-companion` check** from [`prereq-check.md`](../../shared/prereq-check.md) (Node + `pac` only — this self-contained track has no "baseline" check).

   **.NET SDK + active `pac auth` are NOT checked here.** If the user later picks the optional "Yes, also deploy now" path in Step 2, the deploy prereq one-liner is run **at that point** (just-in-time, before `pac pcf push`).
3. Read `./PRD.md`. If missing or §8 (PCF surface) is incomplete (any `<NEEDS INPUT>` or missing fields in §8.1–§8.4), STOP with `BLOCKED: PRD.md §8 PCF surface is incomplete — re-run /design-native-extension-feature and complete the PCF section.`
4. Read `./.extension-state.md`. If Phase isn't at least `scaffold`, STOP with `BLOCKED: run /generate-native-extension first.`
The structural patterns this skill needs to emit (manifest shape, `index.ts` bridge wiring, output mapping) are fully prescribed in this SKILL.md (§4–§5) and in [`shared/ppmplugin-format.md`](../../shared/ppmplugin-format.md) §2 (Runtime dispatch contract). Do NOT fetch the reference extension repo at runtime — its lessons are already encoded here, and fetching it would risk reference-specific UI logic bleeding into an unrelated PCF.

---

## Step 1.5 — Resolve the dispatch contract from `./manifest.json` and the native module

The wrap **runtime dispatch contract** ([`shared/ppmplugin-format.md`](../../shared/ppmplugin-format.md) §2) is the **authoritative specification** of how a host call reaches the bundle. The `.ppmplugin` bundle is native-only (no TS `handleMessageAsync` layer *in the bundle*), but the **companion PCF** dispatches through the host-injected **`window.PowerApps.NativeExtension.sendAsync`** global — it must **NEVER** call `cordova.exec` directly (the raw `cordova` global is not exposed to the PCF sandbox; a direct call is a silent no-op on device, worst on Android). `sendAsync` performs the underlying `cordova.exec("SendMessagePlugin", …)` transport *inside the host context* and routes to the React Native module the binary ships:

```
PCF → window.PowerApps.NativeExtension.sendAsync("<name>/<receiver>", { method, args: [request] })
    → host global (host context): cordova.exec("SendMessagePlugin", "<name>/<receiver>", [JSON.stringify({method,args}), corrId])
    → proxy → NativeModules[<nativeModule>][<method>].apply(mod, <args-array>)
```

The **composite routing key** `<name>/<receiver>` is what the host resolves to a module; the **method** is one entry from that receiver's `methods[]`. One PCF drives **both iOS and Android** through this global — no platform branch.

> **⚠️ TWO invariants — both confirmed on device; getting either wrong = silent failure:**
> 1. **Dispatch via `sendAsync`, NEVER `cordova.exec`.** The envelope is a **RAW object** `{ method, args: [request] }` — the PCF does **not** stringify it; `sendAsync` does the `JSON.stringify` internally. A PCF that calls `cordova.exec` directly, or that pre-stringifies the payload, fails silently on the first device tap (no error on screen; nothing dispatches — worst on Android).
> 2. **The inner `args` MUST be a JSON ARRAY ([ppmplugin-format §2](../../shared/ppmplugin-format.md)).** After parsing the envelope the proxy runs `Array.isArray(parsed.args) ? parsed.args : []` then `fn.apply(mod, args)` — spreading it as **positional arguments**. A bare object → dropped → the native method gets no request data. **Our convention: `args: [request]`** — one request object, and the native method takes exactly one `ReadableMap`/`NSDictionary` first parameter.

On `status === "ok"`, `sendAsync` resolves `result.data` — the native method's resolved string. The wrap host both re-stringifies it once **and** nests it in a `{ isUpdate, message }` transport container, so the PCF normalizes it with an `extractResponse` helper (parse `result.data`, then — if the parsed object has no top-level `status` — unwrap the `message` container to reach the module's `{status, result}` object; total-fail → `PARSE` error). A bare single parse lands on the container and fails every call with `UNEXPECTED_PAYLOAD` though native succeeded — see [`shared/ppmplugin-format.md §2`](../../shared/ppmplugin-format.md). `status !== "ok"` → surface `result.error` (fall back to `BRIDGE_FAILED`); missing host global → `NOT_IN_WRAP`.

### Required reads — must succeed before Step 2

1. **Resolve the composite routing key** `<name>/<receiver>` from the **committed `./manifest.json`** — the source of truth `/generate-native-extension` writes at scaffold time, so on the normal flow it already exists when this skill runs. Prefer it; fall back to the staged copy, then ARCHITECTURE only if no manifest exists yet (a hand-authored module). **OS-neutral: read `./manifest.json` with the Read tool and parse the JSON directly — don't shell out to `grep`/`sed` (the bash below is illustrative; it won't run on Windows):**
   ```bash
   MANIFEST=$( [ -f ./manifest.json ] && echo ./manifest.json || echo ppmplugin/staging/manifest.json )
   if [ -f "$MANIFEST" ]; then
     NAME=$(grep -o '"name"[[:space:]]*:[[:space:]]*"[^"]*"' "$MANIFEST" | head -1 | sed 's/.*"\([^"]*\)"$/\1/')
     echo "manifest ($MANIFEST) name: $NAME — receiver/nativeModule/methods read from receivers[]"
   else
     echo "no manifest.json yet (hand-authored module) — derive <name>=kebab(className), <receiver>=<Pascal>Extension, nativeModule=<className> from ARCHITECTURE; /generate-ppmplugin-manifest will author it"
   fi
   ```
   The dispatch key the PCF binds and the receiver the manifest registers MUST match — a PCF that dispatches `<name>/<receiver>` while the manifest registers a different receiver fails on first dispatch. Because `./manifest.json` is authored **before** this skill runs (at native-gen), the PCF **follows the manifest's** receiver — bind exactly the `receivers[].name` it declares.

2. **Read `manifest.json` `receivers[]`** (canonical dispatch target):
   - `receivers[].name` — the `<receiver>` half of the composite key
   - `receivers[].nativeModule` — what the host resolves as `NativeModules.<nativeModule>` (the module's `getName()`)
   - `receivers[].methods` — the `Method` values the host may dispatch; each is a real `@ReactMethod` / `RCT_EXPORT_METHOD` name. The PCF's `onTrigger` calls one of these.

3. **Native source** (verification only — `ios/RCT<Pascal>Module.m`, `android/src/main/java/.../<Pascal>Module.kt`):
   - Android `getName()` / iOS `+ (NSString *)moduleName` MUST equal `receivers[].nativeModule`
   - Every `method` the PCF dispatches MUST be a real `@ReactMethod` / `RCT_EXPORT_METHOD` on the module (an unknown method = `method '<m>' not found` on device)
   - If native drifts from the manifest, STOP with `NEEDS_CONTEXT: native module drifted from manifest.json receivers[]; reconcile and re-run`

### Compose the resolved contract

```
Transport (host global — fixed):
  window.PowerApps.NativeExtension.sendAsync("<name>/<receiver>", { method, args: [request] })
                                              ↑ envelope is a RAW object; sendAsync stringifies it internally
  result.status === "ok"  → extractResponse(result.data) yields the module's response object (unwraps the wrap `message` container)
  result.status !== "ok"  → bridge/transport failure (result.error ?? BRIDGE_FAILED); parse-fail → PARSE
  no window.PowerApps.NativeExtension → NOT_IN_WRAP (Studio preview / non-PAM host / CordovaV2 off)

Dispatch target (from manifest.json receivers[]):
  Composite key: <name>/<receiver>
  nativeModule:  <NativeModules.<nativeModule>>
  method:        <one of methods[]>
  args:          [request]  — a JSON ARRAY (spread positionally via fn.apply). Our convention: ONE request
                 object at args[0]; the @ReactMethod / RCT_EXPORT_METHOD takes one ReadableMap/NSDictionary param.
  Response shape: <list — module's own {status, result, error, message}>  (message = human-readable failure reason)
  Module error codes: <list — USER_CANCELLED, INVALID_INPUT, ...>  (canonical set + meanings: shared/error-codes.md)

Verification (native source):
  All checks: <pass | fail with mismatch>
```

### Drift detection

| Disagreement | Action |
|---|---|
| `manifest.json receivers[]` ↔ native source disagree on `nativeModule` / method names | STOP with `NEEDS_CONTEXT`. List the mismatches. Reconcile before generating PCF. |
| PCF composite key `<name>/<receiver>` ↔ manifest's registered receiver disagree | The PCF and manifest must agree on the key. `./manifest.json` is authored first (at native-gen), so the **PCF follows the manifest** — bind the `receivers[].name` it declares. (Only if the user deliberately renames the receiver in the PCF, update `./manifest.json` to match and re-run.) |
| Host `sendAsync` payload/response wire format ↔ what this skill emits | The exact envelope is owned by the host global + wrap proxy; confirm against `shared/ppmplugin-format.md §2`. The PCF guarantees only the composite key + `method` the bridge ultimately targets. |

**Use the resolved contract** — not the PRD's §5.1/§5.2 — as the source for the PCF's dispatch args and response parsing in Step 5. The PRD describes intent; `./manifest.json` + native is the actual dispatch contract. When they agree, all three are consistent; when they don't, the native source wins (since that's what the running app sees).

---

## Step 2 — Confirm the plan with the user

Print a summary derived from ARCHITECTURE §6 and the derived names, then gate on approval.

```
PCF scaffold plan
─────────────────
Folder: pcf/<Pascal>PCF/
Namespace: PowerApps  (constant for all native-extension PCFs)
Control name: <Pascal>PCF
Dispatches: composite key '<name>/<receiver>' → NativeModules.<nativeModule>.<method>
                                                  via window.PowerApps.NativeExtension.sendAsync (host global)

Bound input (ARCHITECTURE §6.1 (bound input)):
  <Name> : <Type>   <— bound, required>

Configurable inputs (ARCHITECTURE §6.1 (configurable inputs)):
  <Name> : <Type> = <default>   <— purpose>
  ...

Output properties (ARCHITECTURE §6.1 (output properties)):
  <Name> : <Type>   <— purpose>
  ...

Trigger (ARCHITECTURE §6.2): <one line>
```

Use `AskUserQuestion`:

> Proceed with this PCF scaffold?
> - **Yes** — run `pac pcf init`, write/rewrite files, run `npm install` + `npm run build` smoke check. All local — no environment deploy.
> - **Edit the PRD first** — exit; user runs `/design-native-extension-feature` to fix §8.
> - **Cancel**

Deployment to a Power Platform environment is a separate, on-demand step via `/publish-pcf-companion`. This skill is purely local — it doesn't touch `pac auth`, doesn't call `pac pcf push`, doesn't need .NET SDK.

---

## Step 3 — Run `pac pcf init`

Inside the repo root:

```bash
mkdir -p pcf
cd pcf
pac pcf init --namespace PowerApps --name <Pascal>PCF --template field --framework none
```

Notes on the flags:
- `--namespace PowerApps` — constant. All native-extension PCFs share this namespace so they group together in Canvas Studio's Insert panel.
- `--template field` — single-bound-value control. Matches the "trigger a native operation on a maker-set input" pattern. Don't use `dataset` for v0.
- `--framework none` — vanilla DOM. No React. Keeps the bundle tiny and avoids version friction with the host's managed build's React.

`pac pcf init` creates `pcf/<Pascal>PCF/` with this structure:
- `<Pascal>PCF.pcfproj` (MSBuild project)
- `package.json` (uses npm — PCF tooling convention)
- `pcfconfig.json`
- `tsconfig.json`
- `eslint.config.mjs`
- `<Pascal>PCF/` (nested) — `ControlManifest.Input.xml` + `index.ts` + `PowerAppsNativeExtension.d.ts` (ambient host-global decl, emitted in Step 5.5) + (later) `generated/ManifestTypes.d.ts`

If `pac pcf init` fails:
- **"pac not found"** → re-run the prereq check. The `pwsh` prefix may be needed on Windows.
- **"folder already exists"** → ask whether to delete it and regenerate, or merge (only safe if no manual edits were made).
- **Auth-related** → run `pac auth list` and surface which profile is active; suggest `pac auth create` if none.

After `pac pcf init` succeeds, also write `pcf/README.md` (one level up from the control folder). Sections:

1. **Overview** — one paragraph from PRD §1 explaining what this PCF does.
2. **Not in the npm tarball** — explicit note that the PCF folder is excluded from `package.json`'s `files` array; it ships to Power Platform via `pac pcf push`, not via npm.
3. **Properties** — three short tables from ARCHITECTURE §6 (bound, configurable, output).
4. **Build & iterate** — `npm install`, `npm run build`, `pac pcf push --publisher-prefix <2–8 char prefix>` (see `/publish-pcf-companion` for prefix selection).
5. **Trigger behavior** — one line from ARCHITECTURE §6.2.

Keep it ~50 lines. Tailor every section to the PRD; don't invent boilerplate.

---

## Step 4 — Rewrite `ControlManifest.Input.xml`

`pac pcf init` produces a single-property manifest. Rewrite it to match ARCHITECTURE §6 exactly.

**Use human-readable text for `display-name-key` and `description-key`.** These attributes are what the maker sees in Power Apps Studio's properties panel — they're not just internal keys. Without `.resx` resource files (which this scaffold doesn't ship), Studio displays the attribute value verbatim. Write friendly labels and sentences, not programmer-style keys.

> **⚠️ HARD RULE — no apostrophes (and no raw `<` `>` `&`) in these attributes.** `pac pcf push` validates the manifest against an XSD where `display-name-key` / `description-key` are `noAposStringType` — **a literal ASCII apostrophe (`'`) fails the push** with `noAposStringType` validation. It also breaks on raw XML metacharacters. So when deriving these strings:
> - **Rephrase to avoid possessives/contractions** rather than emitting an apostrophe — e.g. "the phone's flashlight" → **"the device flashlight"** / "the phone flashlight"; "doesn't" → "does not"; "user's" → "the user". This reads cleanest.
> - If a string genuinely must keep the punctuation, use the typographic right single quote **`’` (U+2019)**, which is NOT the ASCII apostrophe and passes the XSD — but prefer rephrasing.
> - Escape or avoid `&` (`&amp;`), `<`, `>`. Keep these attributes plain ASCII sentences.
> - This applies to **every** `display-name-key` / `description-key` in the manifest (control + each property). Scan the final manifest for `'` before writing it.

Derivation rules:

| Attribute | Value |
|---|---|
| `<control display-name-key="...">` | PRD §2 "Human-readable name" if present; else convert `<Pascal>PCF` to title case (e.g. `BarcodeScannerPCF` → `Barcode scanner`) |
| `<control description-key="...">` | PRD §1 Summary, trimmed to ~120 chars (single sentence) |
| `<property display-name-key="...">` | Convert the property `name` to title case with spaces (e.g. `PenColor` → `Pen color`, `SignatureBase64` → `Signature base64`) |
| `<property description-key="...">` | The "Purpose" column from ARCHITECTURE §6.1 (bound input) / §8.2 / §8.3 for that property |

The manifest structure (substitute the human-readable strings, NOT placeholder keys):

```xml
<?xml version="1.0" encoding="utf-8" ?>
<manifest>
  <control namespace="PowerApps"
           constructor="<Pascal>PCF"
           version="0.0.1"
           display-name-key="<human-readable name from PRD §2>"
           description-key="<short summary from PRD §1>"
           control-type="standard">

    <!-- §8.1 Bound input — OPTIONAL, at most one, usage=bound. OMIT this block
         entirely unless there is a single primary column the control both reads AND
         writes back (text editor, scrubber, chart). Most native-extension PCFs are
         action/config controls and have NO bound property — see the usage table below. -->
    <property name="<BoundName>"
              display-name-key="<title-cased BoundName>"
              description-key="<Purpose from ARCHITECTURE §6.1 (bound input)>"
              of-type="<Type>"
              usage="bound"
              required="true" />

    <!-- §8.2 Configurable inputs — usage=input, required="false". Values the maker
         TYPES or PICKS in the property panel (read-only to the control). -->
    <property name="<ConfigName>"
              display-name-key="<title-cased ConfigName>"
              description-key="<Purpose from ARCHITECTURE §6.1 (configurable inputs)>"
              of-type="<Type>"
              usage="input"
              required="false"
              default-value="<default>" />
    <!-- ... one <property> per configurable input ... -->

    <!-- §8.3 Output properties — usage=output. Values the control PRODUCES that the
         maker READS in Power Fx (Self.PropertyName) — status, result, error, computed
         text. These are NOT bound and NOT input. Every runtime value the maker consumes
         is an output, NOT a bound prop. Declare each in IOutputs + return from getOutputs(). -->
    <property name="<OutputName>"
              display-name-key="<title-cased OutputName>"
              description-key="<Purpose from ARCHITECTURE §6.1 (output properties)>"
              of-type="<Type>"
              usage="output" />
    <!-- ... one <property> per output ... -->

    <!-- On-device diagnostic — the ONE legitimate usage="bound" in a wrap PCF.
         On a release wrap build the WebView console is unreachable from logcat /
         chrome://inspect, so the PCF surfaces the RAW bridge response (the wire string
         exactly as it arrived, before extractResponse) here. The maker drops it on a Power Fx
         label (Self.<name>Json) and reads what actually came back with no connected
         debugger. See shared/ppmplugin-format.md §2 "Wrap-bridge response quirks". -->
    <property name="<name>Json"
              display-name-key="<title-cased name> raw response"
              description-key="Raw bridge response for on-device debugging — drop on a label as Self.<name>Json."
              of-type="SingleLine.Text"
              usage="bound" />

    <resources>
      <code path="index.ts" order="1" />
    </resources>
  </control>
</manifest>
```

Illustrative example (substitute the actual `<Pascal>` and property names from PRD §2 + §8):

```xml
<control namespace="PowerApps"
         constructor="<Pascal>PCF"
         version="0.0.1"
         display-name-key="<Human-readable name from PRD §2>"
         description-key="<One-line description from PRD §1.>"
         control-type="standard">

  <property name="<InputPropertyName from ARCHITECTURE §6.1 (configurable inputs)>"
            display-name-key="<Human-readable label>"
            description-key="<One-line description>"
            of-type="SingleLine.Text"
            usage="input"
            required="false"
            default-value="<default from ARCHITECTURE §6.1 (configurable inputs)>" />

  <property name="<OutputPropertyName from ARCHITECTURE §6.1 (output properties)>"
            display-name-key="<Human-readable label>"
            description-key="<One-line description>"
            of-type="SingleLine.Text"
            usage="output" />
  ...
</control>
```

PCF property types you'll commonly see: `SingleLine.Text`, `SingleLine.URL`, `SingleLine.Email`, `Whole.None`, `Decimal`, `TwoOptions`, `DateAndTime.DateOnly`, `DateAndTime.DateAndTime`. Map the PRD's TypeScript types accordingly (e.g. `string` → `SingleLine.Text` unless context says URL).

#### Standard diagnostic outputs — ALWAYS emit these three

In **addition** to the operation's result outputs (and the `<name>Json` raw-response bound output above), every dispatcher PCF MUST declare three diagnostic outputs (all `of-type="SingleLine.Text"`, `usage="output"`). For a third-party control this matters even more than first-party: the native binary runs inside the customer's wrap shell with **no logcat / Xcode console / native debugger reachable**, so the only way a failure is visible at all is if the code + message ride back through the bridge into a formula-readable output:

```xml
<property name="Status"       display-name-key="Status"        description-key="ok | error | cancelled" of-type="SingleLine.Text" usage="output" />
<property name="ErrorCode"    display-name-key="Error Code"    description-key="Machine-readable error code; empty on success" of-type="SingleLine.Text" usage="output" />
<property name="ErrorMessage" display-name-key="Error Message" description-key="Human-readable failure reason; empty on success" of-type="SingleLine.Text" usage="output" />
```

- `Status` — `"ok"` | `"error"` | any lifecycle state the control uses (e.g. `"cancelled"`).
- `ErrorCode` — the machine-readable code from the native error response (`USER_CANCELLED`, `INVALID_INPUT`, `BRIDGE_FAILED`, `PARSE`, …); `""` on success. Makers branch on it.
- `ErrorMessage` — the **human-readable** `message` the native side attached (the exception text, the offending field, the denied permission); `""` on success. **This is the field a maker or support engineer reads first when something fails in the field** — without it, a failure is a silent no-op.

The two debugging outputs are complementary: `<name>Json` shows the *raw wire bytes* (transport-level forensics); `ErrorCode`/`ErrorMessage` show the *parsed, structured* failure (what the native module meant). Maker pattern: `If(Self.Status = "error", Notify(Self.ErrorMessage, NotificationType.Error))`. Declare all three in `IOutputs`, set them in `setError` / `setSuccess`, and return them from `getOutputs()`.

#### Optional visual-style inputs (color + border) — ONLY if the user asks

Every dispatcher PCF already ships a **good-looking themed default** (see `applyStyles()` / `ensureStyleTag()` in Step 5) that follows the host Fluent theme — so it never renders as a raw browser button **without** any extra inputs. Do **NOT** add maker-facing color/border inputs by default; they clutter the property panel for controls that don't need them.

**Emit these ONLY when the PRD / user explicitly calls for maker-configurable color or border options.** When they do, add just the knobs requested (from the set below), as `usage="input"`, `required="false"`, all `SingleLine.Text` except the numeric radius:

```xml
<property name="AccentColor"  display-name-key="Accent color"  description-key="Button background color (hex, e.g. #0f6cbd). Blank = host theme." of-type="SingleLine.Text" usage="input" required="false" default-value="" />
<property name="TextColor"    display-name-key="Text color"    description-key="Label color (hex). Blank = auto for contrast on the accent." of-type="SingleLine.Text" usage="input" required="false" default-value="" />
<property name="BorderColor"  display-name-key="Border color"  description-key="Border color (hex). Blank = matches the accent color." of-type="SingleLine.Text" usage="input" required="false" default-value="" />
<property name="BorderRadius" display-name-key="Corner radius" description-key="Corner radius in pixels (0 = square, 4 = default, 20 = pill)." of-type="Whole.None" usage="input" required="false" default-value="4" />
```

Rules that keep this **small and safe** (not a theming engine):
- **The default is to emit NONE of these.** The themed baseline + host theme already look right; only surface a knob the user actually requested. `applyStyles()` reads each one **only if its `<property>` exists**, so omitting them changes nothing about the default look.
- **Contrast is guaranteed, not the maker's problem.** If `AccentColor` is emitted and set but `TextColor` is blank, `applyStyles()` computes black/white by luminance so the label always clears WCAG AA — a maker can't accidentally create an invisible-label button.
- **Don't add width/height/font-size inputs** — the host box sizes the control; sizing inputs fight the canvas resize handle.

### Choosing `usage` per property — decide BEFORE emitting any `<property>`

`usage` is a **required** attribute and the single most common thing to get wrong. The manifest schema defines exactly **three** values ([property element reference](https://learn.microsoft.com/power-apps/developer/component-framework/manifest-schema-reference/property)) — the property "represents a column the component can change (`bound`), read-only (`input`), or output values (`output`)". Pick deliberately; the wrong choice clutters the maker's input panel (everything as a typeable input) or hides values that should be formula-readable (an output mislabeled `bound`).

For **every** property, run this decision in order — first match wins:

1. **Does the control *produce* this value for the maker to read?** (status, result, current value, last error, computed/returned text — anything the maker references as `Self.<Name>` / `<Control>.<Name>` in Power Fx) → **`output`**. This is the default for everything the native operation returns. *If the maker reads it in a formula, it is an output — never `bound`.*
2. **Does the maker *set/configure* this value?** (URL, table name, id, color, interval, toggle, JSON config — typed or picked in the property panel, or bound to a field for reference) → **`input`** (`required="false"`, give a `default-value`).
3. **Is there a single primary column the control both displays AND writes back** (two-way edit — text editor, scrubber, chart)? → **`bound`** (at most one). Otherwise **no bound property at all.**

| `usage` | Meaning (authoritative) | Maker / Studio behavior | TS wiring |
|---|---|---|---|
| `output` | A value the control **produces**. The control writes it; the maker only reads it. | **Hidden** from the input panel; readable in Power Fx as `Self.<Name>`. | declared in `IOutputs`; returned from `getOutputs()`; never read from `context.parameters`. |
| `input` | A **read-only** input. The maker provides it — a static value (`default-value`) or a bound field — and the control reads but never writes it. | Editable field in the property panel. | read via `context.parameters.<Name>.raw`; not in `getOutputs()`. |
| `bound` | A column the control can **change** — two-way. The control reads the field AND writes it back. At most one; **omit for action/config controls.** | Bound to a Dataverse column; `context.parameters.<Name>` also exposes `.formatted` / `.security` / `.attributes`. | read in `updateView` AND returned from `getOutputs()`; `notifyOutputChanged()` on change. |

**Default for native-extension PCFs (the common case): NO `bound` property.** Most of these are action / configuration / status controls (trigger a native op on a maker-set input, surface the result). They use **`input` for what the maker sets** and **`output` for everything the control returns** — and omit `bound` entirely. Reaching for `bound` because a property feels like "the main input" is the #1 mistake: if the maker reads it in a formula it's an `output`; if the maker sets it it's an `input`. `bound` is *only* for a single column the control edits in place.

> **The ONE allowed `bound` in a wrap PCF is the `<name>Json` diagnostic** added to the template above — it surfaces the raw bridge response for on-device debugging where the WebView console is unreachable (`shared/ppmplugin-format.md` §2). That is the only exception; classify every *domain* property through the decision above and never reach for `bound` for them.

> **Don't blindly inherit `bound` from ARCHITECTURE §8.1.** The design doc's "§8.1 Bound input" heading does not mean the property must be `usage="bound"` — re-classify each property through the decision above. A value the native operation *returns* is an `output` even if §8 listed it under inputs.

> **If you later need real localization,** the canonical PCF pattern is to put resource KEYS here (e.g. `<PropertyName>_Display`) and create `strings/<Pascal>PCF.1033.resx` (and additional `.resx` per locale) mapping keys to localized strings. For v0 with no i18n requirement, plain strings as shown above are correct and friendlier.

After writing, validate the XML parses with `pac pcf build --no-restore` or by checking for the `<Pascal>PCF/generated/ManifestTypes.d.ts` file that `pcf-scripts` generates on build.

---

## Step 5 — Write `index.ts`

### Step 5.0 — Branch on ARCHITECTURE §6.0 visual style

Before generating, read ARCHITECTURE §6.0 to know which visual style the PCF should render:

| §8.0 value | Generated UI shape |
|---|---|
| `minimal` (default) | Single themed button. Click → `onTrigger()`. Outputs are read by the maker's Power Fx; the PCF itself doesn't render them. |
| `with-preview` | Button + preview pane. Preview is an `<img>` (for image outputs like base64 PNG / data URI), `<div>` (for text outputs like scan result), or `<span>` (for status). Preview reads from the success-output field and updates in `updateView` when the underlying value changes. |
| `inline-surface` | Custom — the PCF renders an interactive surface itself rather than triggering a native modal. v0 emits a `// TODO: design the inline surface` placeholder and STOPs with `DONE_WITH_CONCERNS`. |

The skeleton below is **for `minimal` mode**. Adapt for `with-preview` by adding a preview element and a `renderPreview()` method called from `updateView` + after `setSuccess`. For `inline-surface`, the skeleton doesn't apply — see the v1+ guidance.



**Generate complete working code, not a skeleton with placeholders.** Every line in `index.ts` is derived from a specific source — and dispatch args / response shapes come from the **native ground-truth contract resolved in Step 1.5**, not directly from the PRD. PRD describes intent; `manifest.json` + native source is what the running app actually exchanges.

| Block in `index.ts` | Derived from |
|---|---|
| `COMPOSITE_KEY` + `METHOD` constants | `manifest.json` → `COMPOSITE_KEY = "<name>/<receiver>"` (composite routing key) and `METHOD = "<one of receivers[].methods>"`. The composite key MUST match the receiver the manifest registers. |
| Types | `<Pascal>Request`, `<Pascal>Response` defined inline in this file (the native-only bundle ships no shared TS `src/types.ts` to import — model the args the `@ReactMethod` parses and the `{status, result, error}` it resolves). |
| Private output-field declarations | ARCHITECTURE §6.1 (output properties) (one private field per output, typed from §8.3's `Type` column, initialized to a safe default — `""` for text, `0` for numbers, `false` for boolean) — plus the `<name>Json` raw-response diagnostic field. |
| `applyStyles()` body | ARCHITECTURE §6.1 (configurable inputs) (one assignment per configurable input — button text, background, foreground, padding, etc.) using the actual property names from §8.2 |
| `onTrigger()` payload-build (dispatch args) | **`<Pascal>Request`** (the object the `@ReactMethod` / `RCT_EXPORT_METHOD` reads as its one `ReadableMap`/`NSDictionary` param). ARCHITECTURE §6.1 (bound input) names which configurable/bound input flows into which field. It rides in the `sendAsync` envelope **`{ method: METHOD, args: [request] }`** — a **RAW object** (the PCF does NOT stringify it; `sendAsync` does) AND the inner `args` MUST be an array (§2). |
| `onTrigger()` outcome branch | Single nested if/else covering four cases of the two-level error model, **each passing both a code AND a message to `setError`**: ① bridge OK + `payload.status === "ok"` → `setSuccess(payload.result)`. ② bridge OK + `payload.status === "error"` → `setError(payload.error, payload.message ?? "")` (the native-supplied human-readable reason). ③ bridge OK + payload shape unrecognized (even after `extractResponse` unwraps the wrap `message` container) → `setError("UNEXPECTED_PAYLOAD", "native response shape not recognized: " + this.<name>Json.slice(0, 200))` — surface the RAW wire string, not the post-parse object. ④ `sendAsync` status !== "ok" / parse-fail / no host global → `setError("BRIDGE_FAILED", <result.error / reason>)` / `setError("PARSE", <raw string that failed to parse>)` / `setError("NOT_IN_WRAP", <reason>)`. The RAW wire response is ALSO surfaced via the `<name>Json` output. Single `notifyOutputChanged()` at the end. |
| `setSuccess(result)` body | `<Pascal>Response["result"]` → ARCHITECTURE §6.1 (output properties). One assignment per §8.3 output, sourced from the corresponding response field. Sets `status="ok"` and **clears `errorCode=""` and `errorMessage=""`**. |
| `setError(code, message)` body | ARCHITECTURE §5 (codes) + ARCHITECTURE §6.3 (error UX mapping) (UX per code). Simplest form: zero out result fields, set `status="error"`, `errorCode=code`, **`errorMessage=message`** (the human-readable reason — never drop it). If ARCHITECTURE §6.3 says specific codes need different output UX (e.g. USER_CANCELLED → status="cancelled"), branch inside `setError`; still set `errorMessage`. |
| `getOutputs()` body | ARCHITECTURE §6.1 (output properties) — one returned entry per output, reading the private field. **MUST include `Status`, `ErrorCode`, and `ErrorMessage`** (and the `<name>Json` raw output) so the failure is visible in Power Fx with no native debugger. |

### The skeleton (with derivation rules inline)

Replace the default scaffolded `pcf/<Pascal>PCF/<Pascal>PCF/index.ts` with this structure, **substituting every value from the PRD**:

```ts
import { IInputs, IOutputs } from "./generated/ManifestTypes";

// Domain contract — modeled INLINE. A native-only .ppmplugin ships NO shared TS layer,
// so there's nothing to import: <Pascal>Request is the args the @ReactMethod parses,
// <Pascal>Response is the {status, result, error} object it resolves. Mirror the module.
interface <Pascal>Request { /* one field per dispatch arg the @ReactMethod parses */ }
interface <Pascal>Response { status: "ok" | "error"; result?: Record<string, unknown>; error?: string; message?: string; }
//   error   — machine code (present when status === "error"); the PCF branches on it.
//   message — HUMAN-READABLE failure reason (present when status === "error"); the PCF surfaces it as ErrorMessage.

// Bridge declaration — the wrap host injects `window.PowerApps.NativeExtension`
// onto the Canvas WebView at boot (when CordovaV2 is enabled). The PCF dispatches
// through its `sendAsync` global — it must NEVER call `cordova.exec` directly (the
// raw `cordova` global is NOT exposed to the PCF sandbox, so a direct call is a
// silent no-op on device, worst on Android). See shared/ppmplugin-format.md §2.
//
// Type it with a local ambient declaration in PowerAppsNativeExtension.d.ts (emitted
// alongside this file) so the PCF stays host-agnostic and pins no SDK package.

// deepParse: the wrap host double-/triple-stringifies the bridge response, so peel string
// layers (bounded) until we reach an object. This is a BOUNDED helper used by extractResponse
// to reach the container/payload — NOT a blind transport walk used on its own.
// See shared/ppmplugin-format.md §2 "Wrap-bridge response quirks".
function deepParse(v: unknown, max = 4): unknown {
  let cur = v;
  for (let i = 0; i < max && typeof cur === "string"; i++) {
    try { cur = JSON.parse(cur); } catch { break; }
  }
  return cur;
}

// extractResponse: the wrap transport ALSO wraps the module's JSON in a container object,
// nesting it (still stringified) under a `message` key:
//   {"isUpdate":false,"message":"{\"status\":\"ok\",\"result\":{…}}"}
// A bare parse lands on {isUpdate, message} (no top-level `status`) → UNEXPECTED_PAYLOAD
// even though native succeeded. So peel string layers, THEN unwrap the container: probe
// `message` (the confirmed wrap key) first, then defensive fallbacks, accepting the first
// nested value that has a top-level `status`. When result.data already IS the {status,…}
// object (the simple already-unwrapped case), the first check returns it directly — so this
// is a strict superset of a single guarded parse. See shared/ppmplugin-format.md §2.
function extractResponse(raw: unknown): unknown {
  const top = deepParse(raw);
  if (top && typeof top === "object" && "status" in top) return top;
  if (top && typeof top === "object") {
    for (const k of ["message", "result", "data", "value", "response", "body", "payload"]) {
      if (k in (top as Record<string, unknown>)) {
        const inner = deepParse((top as Record<string, unknown>)[k]);
        if (inner && typeof inner === "object" && "status" in inner) return inner;
      }
    }
  }
  return top;   // fall through — UNEXPECTED_PAYLOAD surfaces the raw string for diagnosis
}

const COMPOSITE_KEY = "<name>/<receiver>";   // manifest.json — composite routing key; MUST match the receiver the manifest registers
const METHOD = "<method>";                   // manifest.json receivers[].methods — a real @ReactMethod / RCT_EXPORT_METHOD name

export class <Pascal>PCF implements ComponentFramework.StandardControl<IInputs, IOutputs> {
  private container!: HTMLDivElement;
  private notifyOutputChanged!: () => void;
  private context!: ComponentFramework.Context<IInputs>;
  private button!: HTMLButtonElement;
  private seq = 0;                          // per-tap correlation id for the structured logs

  // ── Structured JSON logging (crash-proof) — the only way to diagnose on-device. ──
  // On a release wrap build the WebView console is unreachable, so every dispatch step
  // emits a single-line JSON record (grep-able if a console IS attached, and the raw
  // response is ALSO surfaced via the usage="bound" <name>Json output for Power Fx).
  private static readonly LOG_TAG = "<Pascal>PCF";
  private logDebug(event: string, data?: Record<string, unknown>): void {
    try { console.log(`[${<Pascal>PCF.LOG_TAG}] ` + JSON.stringify({ ts: Date.now(), level: "debug", event, ...data })); } catch { /* logging must never throw */ }
  }
  private logError(event: string, data?: Record<string, unknown>): void {
    try { console.error(`[${<Pascal>PCF.LOG_TAG}] ` + JSON.stringify({ ts: Date.now(), level: "error", event, ...data })); } catch { /* logging must never throw */ }
  }

  // ── Outputs: one private field per ARCHITECTURE §6.1 (output properties) row ──
  // Emit one declaration per output, typed from §8.3's "Type" column (mapping the
  // module's response field type to its PCF property type, inverse direction),
  // initialized to a safe default for that type.
  //
  // Defaults by type:
  //   SingleLine.Text / .URL / .Email → ""
  //   Whole.None / Decimal             → 0
  //   TwoOptions                       → false
  //   DateAndTime.*                    → new Date(0)   (or a sentinel; ARCHITECTURE §6.1 (output properties) may specify)
  //
  // Shape: `private <fieldName>: <tsType> = <default>;`
  // Always include these diagnostic fields (back the standard outputs):
  //   private status: string = "idle";       // "idle" | "ok" | "error" | extension-specific values
  //   private errorCode: string = "";        // empty in success state; the machine code in error state
  //   private errorMessage: string = "";     // empty in success state; the HUMAN-READABLE reason in error state
  //                                           // (the field the maker/support reads first — no native debugger on device)
  //   private <name>Json: string = "";    // RAW bridge response (wire string, before extractResponse) — the
  //                                        // usage="bound" on-device diagnostic; surfaced via Self.<name>Json

  public init(
    context: ComponentFramework.Context<IInputs>,
    notifyOutputChanged: () => void,
    _state: ComponentFramework.Dictionary,
    container: HTMLDivElement,
  ): void {
    this.container = container;
    this.notifyOutputChanged = notifyOutputChanged;
    this.context = context;

    this.button = document.createElement("button");
    this.button.className = "pam-ext-trigger";   // scopes the injected <style> below
    // ── Default: fill the host-allocated rectangle ──────────────────────────
    // The maker resizes the control on the canvas; the host gives us the
    // resulting box via `container`. The button fills that box so the whole
    // control area is the tap target (no dead zone around a small button).
    // To make the control SMALLER by default, shrink the control's default
    // Width/Height in the canvas (see ARCHITECTURE §6 default size), NOT the
    // button — the button just fills whatever box it's given.
    this.button.style.width = "100%";
    this.button.style.height = "100%";
    this.button.style.boxSizing = "border-box";
    this.ensureStyleTag();   // interaction states (hover/active/disabled/focus) — pseudo-classes need a <style>
    this.applyStyles();
    this.button.addEventListener("click", () => { void this.onTrigger(); });
    container.appendChild(this.button);
    this.logDebug("init", { inWrap: !!window.PowerApps?.NativeExtension, key: COMPOSITE_KEY, method: METHOD });
  }

  // Inject a scoped <style> ONCE. Inline styles can't express :hover / :active /
  // :disabled / :focus-visible, and a control with no interaction feedback reads
  // as "dead" on device. Keep the selectors scoped to .pam-ext-trigger so we never
  // leak styles into the host page. `--pam-accent` / `--pam-fg` are set per-instance
  // in applyStyles(), so these rules follow the resolved (possibly maker-overridden) palette.
  private ensureStyleTag(): void {
    if (document.getElementById("pam-ext-trigger-style")) return;
    const s = document.createElement("style");
    s.id = "pam-ext-trigger-style";
    s.textContent = `
      .pam-ext-trigger {
        font-family: "Segoe UI", -apple-system, BlinkMacSystemFont, Roboto, sans-serif;
        font-size: 14px; font-weight: 600; cursor: pointer;
        border-style: solid; border-width: 1px;
        transition: filter .1s ease, box-shadow .1s ease;
      }
      .pam-ext-trigger:hover:not(:disabled)  { filter: brightness(0.94); }
      .pam-ext-trigger:active:not(:disabled) { filter: brightness(0.88); }
      .pam-ext-trigger:disabled              { opacity: .5; cursor: default; }
      .pam-ext-trigger:focus-visible         { outline: 2px solid var(--pam-fg, #201f1e); outline-offset: 2px; }
    `;
    document.head.appendChild(s);
  }

  private applyStyles(): void {
    const p = this.context.parameters;
    const b = this.button;

    // ── 1. Themed defaults (a real control, not a raw browser button) ────────
    // A polished baseline the maker gets for free. Prefer the host Fluent theme
    // when the runtime exposes it, so the control looks native in maker portal
    // AND on mobile; fall back to these Fluent-ish hexes in Studio preview / older hosts.
    const theme = (this.context as unknown as { fluentDesignLanguage?: { palette?: Record<string, string> } }).fluentDesignLanguage;
    let accent = theme?.palette?.themePrimary ?? "#0f6cbd";   // brand blue
    let fg     = theme?.palette?.white ?? "#ffffff";           // text on accent
    let border = accent;                                        // border matches accent by default
    let radius = "4px";                                         // Fluent-standard corner

    // ── 2. Maker overrides (the color + border "options") ────────────────────
    // Read ONLY if the corresponding configurable input exists in ARCHITECTURE §6.1.
    // Emit a line per knob the manifest declares (AccentColor / TextColor / BorderColor / BorderRadius).
    //   accent = (p.AccentColor?.raw   || "").trim() || accent;
    //   fg     = (p.TextColor?.raw     || "").trim() || fg;
    //   border = (p.BorderColor?.raw   || "").trim() || border;
    //   radius = (p.BorderRadius?.raw != null ? p.BorderRadius.raw + "px" : radius);

    // ── 3. Guarantee legible contrast (accessibility, not optional) ──────────
    // If the maker set a background but no explicit text color, pick black/white
    // by luminance so text on the accent always clears WCAG AA (~4.5:1). Prevents
    // the classic "pale button, invisible label" a hand-set color causes.
    if (!((p as Record<string, { raw?: string }>).TextColor?.raw ?? "").trim()) {
      fg = this.readableTextOn(accent);
    }

    b.style.backgroundColor = accent;
    b.style.color = fg;
    b.style.borderColor = border;
    b.style.borderRadius = radius;
    b.style.padding = "8px 16px";
    b.style.setProperty("--pam-accent", accent);
    b.style.setProperty("--pam-fg", fg);

    // ── 4. Label ─────────────────────────────────────────────────────────────
    // Button text from the §8.2 label input (or a sensible default). For a
    // toggleable control label it "<Function> : <State>" (e.g. "Location Tracking : On")
    // so the tap-to-toggle affordance is discoverable — not a bare state word.
    b.textContent = ((p as Record<string, { raw?: string }>).ButtonLabel?.raw ?? "").trim() || "<default label from PRD §6>";

    // Map any remaining §8.2 configurable inputs to DOM properties here (one line each).
    // DO NOT set width/height from inputs — the host box already sizes the control;
    // a width/height input just fights the canvas resize handle.
  }

  // Black or white text for the given background, chosen by relative luminance so
  // the label always clears WCAG AA contrast on the resolved accent color.
  private readableTextOn(hex: string): string {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
    if (!m) return "#ffffff";
    const n = parseInt(m[1], 16);
    const [r, g, bl] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
      const s = c / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    });
    const L = 0.2126 * r + 0.7152 * g + 0.0722 * bl;   // relative luminance
    return L > 0.4 ? "#201f1e" : "#ffffff";            // dark text on light bg, white on dark
  }

  private async onTrigger(): Promise<void> {
    // ─────────────────────────────────────────────────────────────────────────
    // 1. Build the REQUEST args (the object the @ReactMethod parses)
    // ─────────────────────────────────────────────────────────────────────────
    // The request rides inside the sendAsync envelope as a RAW object:
    //   { method: METHOD, args: [request] }
    //   (the PCF does NOT stringify it — sendAsync does; inner args MUST be an array — §2).
    //
    // Shape: one assignment per <Pascal>Request field; source values from
    //   this.context.parameters.<§8.2-name>.raw  (configurable inputs), or
    //   this.context.parameters.<§8.1-name>.raw  (bound input)
    const request: <Pascal>Request = { /* one entry per <Pascal>Request field */ };
    const seq = ++this.seq;
    this.logDebug("dispatch", { seq, key: COMPOSITE_KEY, method: METHOD, request });

    // ─────────────────────────────────────────────────────────────────────────
    // 2. Dispatch via window.PowerApps.NativeExtension.sendAsync — invokeBridge
    //    resolves the parsed response object, or THROWS on a bridge/transport
    //    failure or when the host global isn't available (Studio preview / non-PAM host).
    // ─────────────────────────────────────────────────────────────────────────
    let response: <Pascal>Response;
    try {
      response = await this.invokeBridge(request);
      this.logDebug("bridge_returned", { seq, status: response?.status, error: response?.error });
    } catch (e) {
      // status!=="ok" / parse-fail / no host global. The thrown message carries the code.
      const code = (e as Error)?.message === "PARSE" ? "PARSE"
                 : (e as Error)?.message === "NOT_IN_WRAP" ? "NOT_IN_WRAP"
                 : "BRIDGE_FAILED";
      // Message: prefer the raw wire string (set on this.<name>Json by invokeBridge) so a
      // transport/parse failure is debuggable from Power Fx; fall back to the error string.
      const reason = this.<name>Json || String((e as Error)?.message ?? e);
      this.logError("bridge_error", { seq, code, reason });
      this.setError(code, reason);
      this.notifyOutputChanged();
      return;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 3. Branch on the module's two-level {status, result, error} response.
    //    extractResponse already peeled the host's string layers and unwrapped the
    //    wrap `message` container — `response` is the module's {status,...} object.
    // ─────────────────────────────────────────────────────────────────────────
    if (response?.status === "ok" && response.result) {
      // Operation succeeded. Map response.result.* → output fields.
      this.logDebug("module_success", { seq });
      this.setSuccess(response.result);
    } else if (response?.status === "error") {
      // Operation failed with a module-defined code (USER_CANCELLED, etc., per ARCHITECTURE §5).
      // Pass the native-supplied human-readable message through to the ErrorMessage output.
      this.logError("module_error", { seq, code: response.error, message: response.message });
      this.setError(response.error ?? "INTERNAL_ERROR", response.message ?? "");
    } else {
      // Bridge succeeded but the payload doesn't match <Pascal>Response shape — even after
      // extractResponse tried to unwrap the wrap `message` container. Surface the RAW wire
      // string (not the post-parse object) so the real shape is diagnosable from Power Fx.
      this.logError("unexpected_payload", { seq, raw: this.<name>Json });
      this.setError("UNEXPECTED_PAYLOAD", "native response shape not recognized: " + this.<name>Json.slice(0, 200));
    }
    this.notifyOutputChanged();
    this.logDebug("final_state", { seq, status: this.status, errorCode: this.errorCode, errorMessage: this.errorMessage });
  }

  private setSuccess(result: NonNullable<<Pascal>Response["result"]>): void {
    // ── Map the module's `result` payload → PCF output fields ──
    // For each output declared in ARCHITECTURE §6.1 (output properties), assign from the matching field in `result`
    // (the shape is the inline `<Pascal>Response["result"]` type modeled at the top of this file).
    // Set the status/errorCode/errorMessage outputs to their success values.
    //
    // Shape:
    //   this.<§8.3-field-A> = result.<response-field> ?? <default>;
    //   this.<§8.3-field-B> = result.<response-field> ?? <default>;
    //   ...
    //   this.status = "ok";
    //   this.errorCode = "";
    //   this.errorMessage = "";   // clear any prior failure's message
    //
    // One assignment per §8.3 row. If a §8.3 output has no matching source field
    // in <Pascal>Response["result"], the scaffold STOPS in Step 1.5 — it shouldn't reach here.
    // (this.<name>Json is set in invokeBridge from the raw response — don't touch it here.)
  }

  private setError(code: string, message: string): void {
    // ── Map error code → output fields per ARCHITECTURE §6.3 (error UX mapping) ──
    // Default behavior (covers most extensions): zero out result-bearing outputs, set
    // status="error", surface the code AND the human-readable message as-is.
    //
    // Shape:
    //   this.<§8.3-result-field-A> = <default>;
    //   this.<§8.3-result-field-B> = <default>;
    //   ...
    //   this.status = "error";
    //   this.errorCode = code;
    //   this.errorMessage = message;   // NEVER drop this — it's what makes the failure debuggable on-device
    //
    // If ARCHITECTURE §6.3 (error UX mapping) specifies that certain codes need different output state (e.g. a code
    // that maps to status="cancelled" instead of "error", or a code that preserves a
    // partial result), branch on the code value:
    //
    //   switch (code) {
    //     case "<CODE_A>":
    //       /* ARCHITECTURE §6.3 (error UX mapping) row for CODE_A */
    //       break;
    //     case "<CODE_B>":
    //       /* ARCHITECTURE §6.3 (error UX mapping) row for CODE_B */
    //       break;
    //     default:
    //       /* the standard zero-and-surface mapping above */
    //   }
    //
    // The codes that reach here include BOTH bridge/transport codes (BRIDGE_FAILED, PARSE,
    // UNEXPECTED_PAYLOAD, NOT_IN_WRAP) and module-defined codes from ARCHITECTURE §5.
    // Cover what ARCHITECTURE §6.3 (error UX mapping) specifies; let the default branch handle
    // anything else.
  }

  /**
   * Bridge transport. Dispatches the composite key COMPOSITE_KEY ("<name>/<receiver>")
   * to NativeModules.<nativeModule>.<METHOD> through the host-injected
   * `window.PowerApps.NativeExtension.sendAsync` global, and RESOLVES the parsed
   * <Pascal>Response object.
   *
   * REJECTS with:
   *   - new Error("BRIDGE_FAILED") when sendAsync resolves status !== "ok" (transport/proxy
   *                                failure, e.g. "native module 'X' not loaded")
   *   - new Error("PARSE")         when the resolved data can't be reduced to an object
   *   - new Error("NOT_IN_WRAP")   when the host global is absent — Studio preview, a non-PAM
   *                                web host, or CordovaV2 disabled. Do NOT fall back to
   *                                cordova.exec — it is not exposed to the PCF sandbox.
   *
   * sendAsync resolves { status, data?, error? }. On status==="ok", `data` is the native
   * method's resolved string; the host both re-stringifies it AND wraps it in a { isUpdate,
   * message } transport container, so the raw is run through extractResponse (parse + unwrap
   * the `message` container). The raw string is also captured into the usage="bound" <name>Json
   * output so a maker can read it on-device via Self.<name>Json when the WebView console is unreachable.
   *
   * The envelope is a RAW object { method, args: [request] } — the PCF does NOT stringify it;
   * sendAsync does that internally. The inner `args` MUST be an array (the proxy spreads it
   * positionally via fn.apply), so the single request object rides at args[0] → the native
   * method's one ReadableMap/NSDictionary param. There is no SDK-side timeoutMs to tune here.
   */
  private async invokeBridge(payload: <Pascal>Request): Promise<<Pascal>Response> {
    const bridge = window.PowerApps?.NativeExtension;
    if (!bridge || typeof bridge.sendAsync !== "function") {
      throw new Error("NOT_IN_WRAP");
    }
    // Envelope is a RAW object; args MUST be an array (one request object at args[0]).
    const result = await bridge.sendAsync(COMPOSITE_KEY, { method: METHOD, args: [payload] });
    // Capture the raw wire response for the on-device diagnostic output.
    this.<name>Json = typeof result === "string" ? result : JSON.stringify(result);
    if (!result || result.status !== "ok") {
      throw new Error((result && result.error) || "BRIDGE_FAILED");
    }
    // result.data is re-stringified AND may be wrapped in the wrap transport's response
    // container ({ isUpdate, message:"<json of {status,result}>" }). extractResponse parses
    // it and, if there's no top-level `status`, unwraps the `message` container — NOT a bare
    // parse (which would land on {isUpdate, message} → UNEXPECTED_PAYLOAD though native succeeded). §2.
    const parsed = extractResponse(result.data);
    if (parsed && typeof parsed === "object") {
      return parsed as <Pascal>Response;
    }
    throw new Error("PARSE");
  }

  public updateView(context: ComponentFramework.Context<IInputs>): void {
    this.context = context;
    this.applyStyles();
  }

  public getOutputs(): IOutputs {
    return {
      // ── One returned key per ARCHITECTURE §6.1 (output properties) output, reading the private field ──
      // Shape: `<§8.3-property-name>: this.<privateFieldName>,`
      // The property name on the LEFT matches `<property name="...">` in ControlManifest.Input.xml.
      // The field on the RIGHT is the private declared at the top of the class.
      // MUST include the three standard diagnostic outputs so the failure is visible in
      // Power Fx with no native debugger:
      //   Status: this.status,
      //   ErrorCode: this.errorCode,
      //   ErrorMessage: this.errorMessage,
      // ALSO include the usage="bound" diagnostic so the raw response reaches Self.<name>Json:
      //   <name>Json: this.<name>Json,
    };
  }

  public destroy(): void { /* No-op for v0. */ }
}
```

### Adapting the skeleton for `with-preview` visual style

When ARCHITECTURE §6.0 = `with-preview`, extend the skeleton above with a preview pane:

1. **Add a preview element** in `init`:
   ```typescript
   this.previewEl = document.createElement("img");   // <img> for image outputs; <div> for text
   this.previewEl.style.maxWidth = "100%";
   this.previewEl.style.maxHeight = "200px";   // or per ARCHITECTURE §6.0 sizing
   this.previewEl.style.display = "none";       // hidden until first result
   container.appendChild(this.previewEl);
   ```

2. **Update `setSuccess` to populate the preview**:
   ```typescript
   private setSuccess(result: <Pascal>Response["result"]): void {
     // ... map to outputs as before ...
     this.<successField> = result.<field>;
     // Show preview
     if (this.previewEl instanceof HTMLImageElement) {
       this.previewEl.src = result.<imageField>;
       this.previewEl.style.display = "block";
     }
   }
   ```

3. **Update `setError` to hide the preview** (or show a placeholder):
   ```typescript
   private setError(code: string, message: string): void {
     // ... map error state as before (set status/errorCode/errorMessage) ...
     this.previewEl.style.display = "none";
   }
   ```

4. **`updateView` re-renders the preview** from the current output field (in case the maker changed bound input via Power Fx):
   ```typescript
   public updateView(context: ComponentFramework.Context<IInputs>): void {
     this.context = context;
     this.applyStyles();
     if (this.<successField>) {
       this.renderPreview(this.<successField>);
     }
   }
   ```

The preview type follows the output type per ARCHITECTURE §6.1 (output properties) → §8.0 mapping:
- Base64 PNG / data URI → `<img>` element, `src = result.<field>`
- SVG string → `<div>` with `innerHTML` (caution: only if the SVG source is trusted — sanitize otherwise)
- Plain text result → `<span>` with `textContent`
- Numeric output → `<span>` with formatted number

### Adapting for `inline-surface` (v1+ pattern)

Emit a minimal skeleton with the trigger button replaced by a `<div>` for the interactive surface, plus a `// TODO: implement the inline surface per ARCHITECTURE §6.0` comment. STOP with `DONE_WITH_CONCERNS: ARCHITECTURE §6.0 inline-surface style requires custom UI design beyond the v0 scaffold template`. The engineer fills in the interactive surface; the bridge wiring (`sendAsync` dispatch, `extractResponse`, error handling, output mapping) stays the same.

### Step 5.5 — Emit the ambient `PowerAppsNativeExtension.d.ts`

The `index.ts` skeleton calls `window.PowerApps.NativeExtension.sendAsync`, so the TypeScript build needs the global typed. **Do NOT import the host SDK** (the PCF must stay host-agnostic and pin no SDK package). Write a one-file ambient declaration next to `index.ts` at `pcf/<Pascal>PCF/PowerAppsNativeExtension.d.ts`:

```ts
//! Ambient declaration for the host-injected `window.PowerApps.NativeExtension`
//! global. Wired at boot by PAM's published-app-loader (when CordovaV2 is enabled).
//! A local declaration (rather than importing an SDK package) keeps the PCF
//! host-agnostic — any PCF can call `sendAsync` without pinning the SDK.

interface PowerAppsNativeExtensionResult {
  status: "ok" | "error";
  data?: unknown;
  error?: string;
}

interface Window {
  PowerApps?: {
    NativeExtension?: {
      sendAsync(
        extensionName: string,
        payload: unknown,
        options?: { timeoutMs?: number },
      ): Promise<PowerAppsNativeExtensionResult>;
    };
  };
}
```

This is a **required emit** — without it, `npm run build` (Step 6) fails to type-check `window.PowerApps`. `pcf-scripts` picks up any `*.d.ts` under the control folder automatically, so no `tsconfig` change is needed.

### Hard rules for index.ts generation

- **No `<placeholder>` text** in the emitted file. Every value is substituted from the PRD.
- **No `// TODO`** comments. If a required mapping isn't in the PRD, STOP with `NEEDS_CONTEXT: PRD §<n>.<n> is incomplete for PCF code generation — re-run /design-native-extension-feature` and name the missing column.
- **Dispatch via `sendAsync`, never `cordova.exec`.** The emitted `invokeBridge` MUST call `window.PowerApps.NativeExtension.sendAsync` with a RAW `{ method, args: [request] }` envelope. A direct `cordova.exec` call (or any `cordova.*` reference) in the PCF is a defect — it is not exposed to the PCF sandbox and fails silently on device (worst on Android).
- **Cover every error code** from ARCHITECTURE §5 in `applyErrorState`. The default branch is for unknown codes only; don't skip cases by relying on the default.
- **Verify symmetry with ARCHITECTURE §4.2.** Every output field declared in §8.3 must map to a response field in §5.2 (or to a derived constant from the error state). If §8.3 declares an output that §5.2 has no corresponding field for, STOP and ask the user.

### Pattern coverage

- **One-shot** — the structure above is sufficient. Generate complete code.
- **Streaming** (§6 = streaming) — the `sendAsync` dispatch resolves one response; streaming would need the native module to push updates the PCF receives via an event subscription. The wrap bridge doesn't expose a clean PCF-side subscription API. For v0, emit the one-shot structure and add a `// TODO (streaming): wire up update subscription when the wrap bridge exposes it` comment at the top of the file; STOP scaffolding with `DONE_WITH_CONCERNS: streaming PCF needs wrap-bridge support not yet available — emitted one-shot fallback`. Don't fabricate an API that doesn't exist.
- **Two-way** (ARCHITECTURE §2 = two-way) — add a second button per operation that fires the follow-up message. Generate the second button + handler from ARCHITECTURE §3.<n>'s follow-up spec (which the design skill captures in the implementation walkthrough). If §3.<n> doesn't specify the follow-up surface, STOP with `NEEDS_CONTEXT: ARCHITECTURE §3.<n> doesn't specify the two-way UI affordance — re-run design walkthrough`.

The `NOT_IN_WRAP` rejection surfaces in the test harness (`pcf-scripts start watch` opens a browser preview where `window.PowerApps.NativeExtension` isn't injected) — that's expected. Don't try to mock the bridge in the harness; it's a known gap.

---

## Step 5b — Generate the manual-validation test harness

Generate `test-harness/` (one level up from the PCF folder, at the extension repo root) so the engineer can build a real Canvas app that wires the PCF and confirm end-to-end behavior on a device.

There are two viable approaches; ship both, low-cost:

### 5b.1 — A typed `test-harness/README.md` with the exact Power Fx recipe

Write `test-harness/README.md` containing step-by-step instructions, tailored from the PRD. Sections to include:

```markdown
# Test harness — <Human-Readable Name>

Manual validation recipe. Builds a Canvas app in Studio that wires the `<Pascal>PCF` control to confirm end-to-end behavior on a real wrap build.

## Prerequisites
- The dispatcher PCF is deployed to your environment: run `/publish-pcf-companion` (handles publisher prefix selection, version bump, env confirmation, and the actual push).
- A wrap build that has the `.ppmplugin` bundle loaded (the DEX/framework + `manifest.json` whose `<name>/<receiver>` this PCF dispatches to) — see /test-native-extension for the load recipe.
- `pac auth list` shows your test environment as active.

## Build the test app in Canvas Studio

1. Open <https://make.powerapps.com>; switch to your test environment.
2. Apps → New app → Blank canvas → Phone layout.
3. Insert → Custom → search `<Pascal>PCF` (under the `PowerApps` namespace).
4. Drop it onto Screen1.
5. In the right-side properties panel, set:
   - `<BoundName>` = <one realistic test value, e.g. an HTTPS URL or a base64 sample>
   - `<each configurable input>` = <leave default or set what ARCHITECTURE §6.1 (configurable inputs) says>
6. Insert → Text label, name it `lblResult`. Set its `Text` property to:
   `<Pascal>PCF1.<OutputName>` (the primary output from ARCHITECTURE §6.1 (output properties))
7. (For more outputs:) Add one label per additional output property.

## Run

- Studio preview (▶): runs the PCF in the browser, where `window.PowerApps.NativeExtension` isn't injected; bridge calls reject with `NOT_IN_WRAP` — that's the expected signal that you need a real wrap build to test end-to-end.
- Wrap on device: open the app in Power Apps Mobile (logged into the same tenant). The bridge dispatches, the native module fires, and the output property updates.

## What to verify

Per ARCHITECTURE §6.3 (error UX mapping) (Edge cases):

| Trigger | Expected `<OutputName>` value |
|---|---|
| <error code 1> | <expected user experience> |
| <error code 2> | <expected user experience> |
| <happy path>   | <expected user experience> |

## Optional — save as a reusable .msapp

If you want to share the test app with another machine or check it into source control:

```bash
# Inside Studio: File → Save as → save to your Power Platform environment first.
# Then export from Studio (File → See all versions → Download) — gives you a .msapp file.
# Drop it into ./test-harness/<Pascal>.msapp and commit.
```

To later unpack and edit as source:

```bash
pac canvas unpack --msapp ./test-harness/<Pascal>.msapp --sources ./test-harness/<Pascal>-source/
```

To repack after editing:

```bash
pac canvas pack --sources ./test-harness/<Pascal>-source/ --msapp ./test-harness/<Pascal>.msapp
```
```

Tailor the recipe to the PRD: substitute the actual bound input name + a realistic example value, list every configurable input from §8.2, list every output from §8.3, fill the verification table from §9 (one row per error code + the happy path).

### 5b.2 — Skeleton Canvas source folder (best-effort)

Create `test-harness/canvas-app-source/` with the bare minimum Canvas source format:

```
test-harness/canvas-app-source/
├── CanvasManifest.json       ← minimal manifest with app name = "<Pascal>-test"
├── Src/
│   ├── App.pa.yaml           ← App.OnStart = false; no special config
│   └── Screen1.pa.yaml       ← <Pascal>PCF instance (compact default size) + lblResult bound to its output
└── README.md                 ← "Run: pac canvas pack --sources . --msapp ../<Pascal>.msapp"
```

**Give the control instance a compact default size** in `Screen1.pa.yaml` (`Width: =200`, `Height: =44` for a button-style control — adjust per ARCHITECTURE §6 if it specifies a preferred footprint). The button fills the control box (`width/height: 100%`), so the control's `Width`/`Height` here ARE its rendered size — set them small so the sample app shows a normal-sized button, not one that fills a tall default cell.

> ⚠️ **Canvas source format is fragile.** `Pa.yaml` is sensitive to indentation and specific control-property casing. The skeleton you generate may not import cleanly into Studio. If `pac canvas pack` errors at this step, **fall back to the manual-in-Studio recipe in 5b.1** — that's the supported v0 path. Treat the generated source folder as a convenience, not a guarantee.

After 5b.2 succeeds (or is skipped on failure), the engineer always has 5b.1 as a fallback.

Update `.gitignore` to allow the harness sources but exclude the `.msapp` binary by default (it's user-environment-specific):

```
# Test harness — source is committed, binary is per-machine
test-harness/*.msapp
```

---

## Step 5.7 — Self-verify the round-trip contract (before building)

The bridge round-trip is the class of bug that **passes `npm run build` and every zip/manifest/DEX check, then fails silently on device** — a composite key that doesn't match the manifest receiver, a `cordova.exec` call the sandbox drops, a pre-stringified envelope, a bare `args` object, or a success path that doesn't unwrap the wrap `message` container. Historically these were only caught at the very end by `/audit-ppmplugin` Category F. Run them **here**, over the `index.ts` you just emitted, so a gap is caught at generation instead.

This is **Gate 11 (PCF ↔ native round-trip contract)** from [`shared/self-critique-protocol.md`](../../shared/self-critique-protocol.md). Re-read the `index.ts` (and `PowerAppsNativeExtension.d.ts`) fresh from disk, then check each invariant against the **resolved contract from Step 1.5** and [`shared/ppmplugin-format.md §2`](../../shared/ppmplugin-format.md):

| Check | Assert | Severity |
|---|---|---|
| Composite key | `COMPOSITE_KEY` in `index.ts` == `<manifest.name>/<receivers[].name>` resolved in Step 1.5; `METHOD` ∈ `receivers[].methods` | blocker |
| Transport | dispatch is `window.PowerApps.NativeExtension.sendAsync`; NO `cordova.exec` / `cordova.*` anywhere in `index.ts` | blocker |
| Envelope | `sendAsync` payload is a **raw** `{ method: METHOD, args: [request] }` object — NOT `JSON.stringify(...)`'d | blocker |
| Args array | the inner `args` is a JSON **array** with the request object at `args[0]` (not a bare object) | blocker |
| Response unwrap | the success path calls `extractResponse` (parse `result.data` + unwrap the `{ isUpdate, message }` container), NOT a bare single `JSON.parse` | blocker |
| Error mapping | every ARCHITECTURE §5 code AND the transport codes (`BRIDGE_FAILED`, `PARSE`, `UNEXPECTED_PAYLOAD`, `NOT_IN_WRAP`) reach a PCF output carrying **both** code and human message | concern |
| Ambient global | `PowerAppsNativeExtension.d.ts` typing `window.PowerApps.NativeExtension.sendAsync` was emitted (Step 5.5) | concern |

**Print a visible verdict block** (`shared-instructions.md §9.1`) and gate on it:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 Round-trip self-verify — <Pascal>PCF (dispatches <name>/<receiver>)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 🟢 ✓ Composite key matches manifest receiver; METHOD ∈ receivers[].methods
 🟢 ✓ sendAsync only (no cordova.exec); raw envelope; args is [request]
 🟢 ✓ extractResponse unwraps the { isUpdate, message } container
 🟢 ✓ All §5 + transport error codes map to outputs with a message
```

- Any **blocker** → **fix the emitted `index.ts` inline** (these are mechanical wiring fixes, not design choices — align the key, replace a `cordova.exec` with `sendAsync`, drop a stray `JSON.stringify`, wrap `args` in an array, route the success path through `extractResponse`), re-read, re-check. Only if a blocker is a genuine drift between the manifest and native source (not a PCF-emit mistake) → STOP with `NEEDS_CONTEXT` and route back per the Step 1.5 drift table.
- Any **concern** → note it in the final summary and in `.extension-state.md`.
- All clear → proceed to Step 6.

This does not replace `/audit-ppmplugin` Category F (the final gate over the built artifact) — it front-loads the same reasoning so the round-trip is right before the PCF is even built.

---

## Step 6 — Install and smoke-build

Inside `pcf/<Pascal>PCF/`:

```bash
npm install              # PCF tooling is npm; do NOT use pnpm here
npm run build            # runs `pcf-scripts build`
```

This regenerates `<Pascal>PCF/generated/ManifestTypes.d.ts` from the manifest, type-checks `index.ts`, and bundles. Output lands at `pcf/<Pascal>PCF/out/` (gitignored).

If `npm install` fails:
- Network / feed issues are less likely than for the extension's pnpm install — PCF tooling pulls from the public npm registry, not Azure Artifacts.
- If it fails anyway, surface the failing line and direct to standard `npm install` troubleshooting.

If `npm run build` fails:
- Manifest XML errors — pcf-scripts surfaces them with line numbers. Re-write the offending property.
- TypeScript errors in `index.ts` — most likely a property name mismatch between the manifest and the code. Re-read the manifest's `<property name="...">` values and align.

DO NOT mark the PCF scaffold as complete in `.extension-state.md` until `npm run build` passes.

### Deployment to a Power Platform environment

NOT done in this skill. Run `/publish-pcf-companion` when ready — it handles the just-in-time deploy prereq check (.NET SDK + active `pac auth`), the env-confirmation gate, and `pac pcf push`. This separation lets the engineer iterate on `index.ts` and the manifest locally without needing auth set up, then deploy when the work is ready to share.

---

## Step 7 — Update state and summarize

Update `./.extension-state.md`:
- Phase: `Last completed: scaffold-pcf` / `Next: /test-native-extension`.
- Add a line under "Validation history": `PCF build (Layer 4): pass — <ISO timestamp>`.
- Add a line: `Test harness: README ✓` and, if 5b.2 succeeded, `canvas-app-source ✓` (or `canvas-app-source skipped — pa.yaml generation failed` if it didn't).
- Do NOT touch the "PCF deployments" section — deploy is `/publish-pcf-companion`'s responsibility.

Print:

```
PCF scaffold complete
─────────────────────
Folder: pcf/<Pascal>PCF/
Manifest properties: 1 bound (<name>Json diagnostic), <count input> input, <count output> output
Dispatches: <name>/<receiver> → NativeModules.<nativeModule>.<method> via window.PowerApps.NativeExtension.sendAsync
Build: npm install ✓ | npm run build ✓
Deployment: not yet deployed (run /publish-pcf-companion when ready)

Next steps
──────────
1. Run /test-native-extension to validate the contract now that native + manifest + PCF all exist (Layer 0 cross-check + Layer 4 PCF compile) — cheap pre-flight before the binary build.
2. Run /generate-ppmplugin to produce the verified `.ppmplugin` binary bundle — it reads this PCF's composite key back so the manifest's receiver stays aligned.
3. Run /publish-pcf-companion to push the dispatcher PCF to a Power Platform environment (handles deploy prereq check, env confirmation, and `pac pcf push`).
4. (Iterate) If ARCHITECTURE §6 changes, re-run /generate-pcf-companion — it will detect the existing folder and ask before regenerating.
```

---

## Step 8 — Offer next-step skills

PCF generation is the natural moment to make several decisions — the dispatcher PCF now exists, so building the `.ppmplugin` bundle and deploying are both in play. Per `shared/shared-instructions.md §9.1`, use `AskUserQuestion` with all plausible next skills as options (not Yes/No), and include an escape-hatch option.

```
Question: "What would you like to do next?"
Header:   "Next step"

Options:
  1. "Run /test-native-extension"
     description: "Validate the contract now that all three sides exist — native module ↔ ./manifest.json ↔ this PCF (Layer 0 cross-check: composite key, nativeModule, methods, request/response/error parity) + Layer 4 PCF compile. Cheap structural pre-flight (seconds) that catches drift before the minutes-long binary build. Recommended next step."
  2. "Run /generate-ppmplugin"
     description: "Produce the verified .ppmplugin binary bundle end-to-end (manifest → build → assemble → audit). Reads this PCF's composite key back so the manifest's receiver stays aligned."
  3. "Run /publish-pcf-companion"
     description: "Deploy the dispatcher PCF to a Power Platform environment for Studio testing. Three gates: publisher prefix, version bump, env confirmation."
  4. "Stay — I'll review the PCF code first"
     description: "Skill exits. Inspect pcf/<X>PCF/index.ts and the manifest, decide what's next yourself."
```

**For options 1 (test), 2 (generate-ppmplugin), or 3 (publish):** **invoke that skill via the `Skill` tool in the same turn** — selecting the option IS the request to run it (Execute, don't describe — shared-instructions §9.1 HARD RULE). Do NOT stop and tell the user to run it themselves; the invoked skill runs its own prereq check + gates.

**For option 4 (stay):** print one line: `PCF scaffold complete. Run any of the suggested skills when you're ready.` Then proceed to return-status.

(Need diagnostic logging? Just ask — `console.log` / `NSLog` / `Log.d` can be added to any code area on request; there's no dedicated skill for it. Note: in the wrap runtime a third-party control's native logs aren't surfaced through normal dev tooling, so logging is of limited use here anyway.)

---

## Return-status protocol

The literal first line of your final message MUST be one of:

| Code | Meaning |
|---|---|
| `DONE` | PCF generated, manifest matches PRD, `npm run build` passed. State file updated. |
| `DONE_WITH_CONCERNS: <list>` | Build passed but with non-fatal warnings (e.g. streaming pattern requires UI work the scaffold left as TODO). |
| `NEEDS_CONTEXT: <missing>` | A required ARCHITECTURE §6 sub-section was incomplete and we couldn't proceed. |
| `BLOCKED: <reason>` | Prereq failed, `pac pcf init` failed, or `npm run build` failed and could not be auto-fixed. |

After the first line, blank line, then the human-readable summary.

---

## Scope of this skill — generating vs auditing

This skill **generates** PCF code from a PRD. It's not a linter; it doesn't audit existing working code against the new template. When the skill is re-run on a repo that already has a `pcf/` folder, the regenerate / resume / abort gate asks before overwriting — and the user should pick "resume" or "abort" unless they explicitly want a fresh template.

**A diff between "what we'd generate now" and "what exists" is NOT a list of defects.** Existing PCF code that achieves the same runtime behavior through a different code shape is fine. Don't list stylistic deltas as issues. Flag only:

- Code that doesn't compile (`npm run build` failing)
- Code that produces incorrect outputs (wrong field names, missing error handling that lets crashes propagate)
- Genuine dispatch-contract violations (wrong composite key, wrong `method` name, or a payload shape the `@ReactMethod` can't parse — such that runtime breaks)

A `BridgeResponse` type defined with a different name is NOT a defect. An `applyErrorState(code)` method instead of `setSuccess`/`setError` is NOT a defect. A hand-rolled unwrap that reaches the `{status,…}` object instead of `extractResponse` is NOT a defect. The template prefers one shape; equivalent shapes are not "wrong."

## Hard rules — correctness (these must be true for the PCF to work)

- **PCF tooling uses npm, not pnpm** for the inner `pcf/<Pascal>PCF/` package. PCF ecosystem convention. Mixing produces lockfile chaos.
- **Manifest namespace is always `PowerApps`.** Don't let the user override; this is how Canvas groups native-extension PCFs.
- **The composite key (`COMPOSITE_KEY` constant) MUST equal `<name>/<receiver>` from `manifest.json`** and match the receiver the manifest registers. Mismatch = the wrap host can't route, silent runtime failure.
- **`METHOD` MUST be a real `@ReactMethod` / `RCT_EXPORT_METHOD` name** from `receivers[].methods`. An unknown method = `method '<m>' not found` on device.
- **All required fields from `<Pascal>Request` MUST be present in the dispatched args.** Missing fields = native parses `undefined` = INVALID_INPUT at runtime.
- **`display-name-key` and `description-key` MUST be human-readable strings**, not programmer keys ending in `_Display` / `_Desc`. Studio shows these verbatim when no `.resx` ships.
- **Every output declared in ARCHITECTURE §6.1 (output properties) MUST be returned by `getOutputs()`.** TypeScript catches this via `IOutputs` typing; don't disable that.
- **`npm run build` MUST pass** before declaring scaffold success.
- **Manifest property types from ARCHITECTURE §6** must be PCF-valid (`SingleLine.Text`, `Whole.None`, etc.) — map the module's response field type to its PCF property type.
- **Exactly ONE `usage="bound"` property — the `<name>Json` raw-response diagnostic — and no other.** Every domain property is `input` (maker sets) or `output` (control produces).

## Recommended template style (preferences for new scaffolds; existing code that works is fine)

These describe the cleanest shape for newly-generated PCF code. They're how this skill renders fresh output. Existing working code that takes a different path is **not** in violation — don't flag stylistic differences as defects when auditing.

- **Prefer the `extractResponse` helper** over a raw `JSON.parse(result.data)`. The wrap host re-stringifies the response AND nests it in a `{ isUpdate, message }` container; `extractResponse` parses the string layers and unwraps the `message` container (returning `result.data` directly when it already has a top-level `status`). A bare single parse lands on the container → `UNEXPECTED_PAYLOAD` though native succeeded. An inline unwrap that reaches the `{status,…}` object works fine too.
- **Prefer narrowing the parsed result to `<Pascal>Response`** and branching on `response.status` over ad-hoc shape detection. Defensive code that achieves the same outcome works fine.
- **Prefer modeling `<Pascal>Request` / `<Pascal>Response` inline** (a native-only bundle ships no shared TS layer to import). Mirror exactly what the `@ReactMethod` parses and resolves; inline annotations scattered at each call site drift more easily.
- **Prefer the `sendAsync` envelope `{ method, args: [request] }`** dispatched on the composite `COMPOSITE_KEY` over a hand-built ad-hoc envelope. The envelope is a **RAW object** — the PCF does NOT stringify it (`sendAsync` does); a PCF that pre-stringifies double-encodes → `BRIDGE_FAILED`. NEVER call `cordova.exec` directly.
- **Prefer the nested if/else with `setSuccess`/`setError` helpers** for the response branch. An `applyErrorState` method that handles the same cases is functionally equivalent.

## Things the skill enforces at generation time (only when generating fresh code)

When emitting a new `index.ts` from scratch, the skill follows the template above. Strict requirements:

- **No `<placeholder>` text in the emitted file.** Substitute every value from the PRD or use a sensible default. Placeholders that compile (like `<Pascal>` substituted as the actual class name) are fine; literal `<PLACEHOLDER>` strings that ship into runtime are not.
- **Map every output declared in ARCHITECTURE §6.1 (output properties).** Each output needs an assignment in `setSuccess` (or equivalent), an initialization at the field declaration, and a return entry in `getOutputs()`. Missing outputs cause TypeScript to complain via `IOutputs`.
- **Cross-check `manifest.json receivers[]` against native source in Step 1.5.** If `nativeModule` / method names drift, STOP with `NEEDS_CONTEXT` — that's a real bug the user must reconcile.
- **STOP with `NEEDS_CONTEXT` only when blocked.** Genuine blockers: missing manifest/ARCHITECTURE name+receiver (no composite key derivable), missing ARCHITECTURE §4 (no request/response shape), missing ARCHITECTURE §6 (no PCF surface). Non-blockers that should NOT STOP: ARCHITECTURE §6.3 (error UX mapping) missing UX detail for a specific error code (use the default error mapping), §8.2 missing a default value for a configurable input (use the type's natural default), PRD §1 summary brevity (don't need to STOP for cosmetic prose).

Allowed in generated code (these are not defects):

- **`// TODO:` or `// Customize:` comments** for items that legitimately need engineer judgment — streaming subscription wiring when the SDK doesn't yet expose it, preview thumbnail layout, button corner radius / animation timing not specified in ARCHITECTURE §6.1 (configurable inputs), edge-case UX the PRD intentionally defers. A clear annotated TODO is better than fabricating arbitrary defaults.
- **Fallback to a generic error mapping** in `setError` for codes not explicitly listed in ARCHITECTURE §6.3 (error UX mapping). The default branch handling "any code → status='error', errorCode=code, errorMessage=message, result-fields=defaults" is the right answer for codes the PRD doesn't customize. The message always flows through, even for unrecognized codes.
- **Defensive `?? <default>` on optional response fields.** If a response field is typed `string | undefined` in `<Pascal>Response`, `result.fieldX ?? ""` at the read site is correct; don't refuse to compile because the source is optional.

When the skill encounters an existing PCF folder, the gate offers regenerate / resume / abort — and the user owns that choice. Resume or abort preserve the existing code; regenerate overwrites. **The skill doesn't second-guess existing code unless the user explicitly asks for a regen.**

## Runtime fallbacks the generated PCF SHOULD have

These are correctness-positive — the skill should ensure they're present. They make the PCF resilient against unexpected runtime conditions that aren't bugs in the PCF:

- **Try/catch around `invokeBridge`** for Studio preview (host global not injected, throws `NOT_IN_WRAP`) → `setError("NOT_IN_WRAP", <reason>)` so the not-in-wrap state is diagnosable rather than masked as a generic internal error. Already in the template.
- **`extractResponse` in `invokeBridge`** to peel the host's re-stringification AND unwrap the wrap `{ isUpdate, message }` response container off `result.data`; total-fail throws `PARSE`. The raw response is also captured into the `<name>Json` diagnostic output. Already in the template.
- **Structured JSON logging** (`logDebug`/`logError` with a per-tap `seq`) at each dispatch step so a failure is diagnosable from a single grep-able line even when the WebView console is barely reachable. Already in the template.
- **`<name>Json` on-device diagnostic** (`usage="bound"`) surfacing the raw bridge response so a maker can read what came back via `Self.<name>Json` when the WebView console is unreachable on a release wrap build. Already in the template.
- **Default error mapping in `setError`** for codes the skill couldn't anticipate (the wrap shell or module emitting new codes between releases) → status='error', code surfaced as-is, message surfaced as-is, result fields zeroed.
- **`UNEXPECTED_PAYLOAD` branch** when the parsed response doesn't match `<Pascal>Response` shape → `setError("UNEXPECTED_PAYLOAD", <serialized-payload-snippet>)`. Catches deployed-module-version drift gracefully instead of letting a TypeError propagate — and the snippet shows exactly what shape arrived.
- **Optional-field guards** (`result.fieldX ?? <default>`) when mapping response fields to outputs. If a response field is documented as optional in `<Pascal>Response`, the PCF reads it defensively.

These are runtime safety nets, not template style. They make the PCF degrade gracefully when something unexpected happens at runtime — and they're allowed/encouraged regardless of what other style decisions the code makes.

## Diagnostic logging the generated PCF SHOULD have

In production, the #1 problem when a PCF doesn't work is "I have no idea what happened." Studio's debugger isn't available on device; the Power Apps Mobile log surface is `console.log` redirected to the device console (Xcode Console for iOS, `adb logcat` for Android).

The generated PCF should `console.log` at decision points with a consistent prefix so production debugging is possible without re-deploying with extra instrumentation:

```typescript
// Pattern: console.log("[<Pascal>PCF] <event>:", <relevant context>);

console.log("[<Pascal>PCF] Dispatching:", COMPOSITE_KEY, METHOD, request);
console.log("[<Pascal>PCF] Bridge returned - status:", response?.status, "error:", response?.error);
console.log("[<Pascal>PCF] Module success - <key field>:", response.<field>);
console.error("[<Pascal>PCF] Module error:", response.error);
console.error("[<Pascal>PCF] Unexpected payload shape:", response);
console.error("[<Pascal>PCF] Bridge error:", code);
console.log("[<Pascal>PCF] Output state - status:", this.status, "errorCode:", this.errorCode, "errorMessage:", this.errorMessage);
```

This is light enough not to spam, dense enough to diagnose a field issue from a log dump. Prefix with `[<Pascal>PCF]` so a `adb logcat | grep PCF` filter works.

## Lessons baked into this template (production-PCF wisdom)

Things we learned the hard way from earlier extensions; the template now handles them by default so future PCFs don't repeat the mistake:

| Lesson | How the template addresses it |
|---|---|
| Host re-stringifies `result.data` AND wraps it in a `{ isUpdate, message }` container; a raw read gets `{isUpdate, message}` (no `status`) → `UNEXPECTED_PAYLOAD` | `invokeBridge` runs `result.data` through `extractResponse` (parse string layers + unwrap the `message` container); non-object → `PARSE`. |
| Release wrap build's WebView console is unreachable from logcat / `chrome://inspect` | Template exposes the `<name>Json` `usage="bound"` output carrying the raw response — readable on-device via `Self.<name>Json`. |
| PCF dispatched a different receiver than the manifest registered (real bug: PCF → `Snapshot`, manifest → `DeviceInfoExtension`) | `COMPOSITE_KEY` is `<name>/<receiver>` resolved from `manifest.json`; Step 1.5 confirms it matches the registered receiver. |
| Unknown method dispatched → `method '<m>' not found` on device | `METHOD` is taken from `receivers[].methods`, verified against a real `@ReactMethod` / `RCT_EXPORT_METHOD` in Step 1.5. |
| Display names show `_Display_Key` literal strings to makers | Manifest uses human-readable text from PRD §2 / §8 |
| Publisher prefix > 8 chars rejected by `pac pcf push` | `/publish-pcf-companion` Gate 3.0 validates length 2–8 |
| Hard-coded paths break on layout variation | `find pcf -name ControlManifest.Input.xml` discovers regardless of nesting |
| Field issues unobservable without re-deploying with instrumentation | Diagnostic logging at decision points, in by default |
| Re-publish without version bump → app cache doesn't refresh | `/publish-pcf-companion` Gate 3.1 prompts for version bump |

## Other operational rules

- **No PCF push without an explicit confirmation gate.** Deploy is `/publish-pcf-companion`'s job; this skill is local-only.
- **Don't try to test the PCF end-to-end here.** That requires a wrap build with the `.ppmplugin` bundle loaded — that's `/test-native-extension` (manual recipe).
- **Two-way pattern (ARCHITECTURE §2 = two-way)**: add a follow-up button per the ARCHITECTURE §3.<n> spec. If §3.<n> doesn't specify the UI, STOP with `NEEDS_CONTEXT`.
- **Streaming pattern (ARCHITECTURE §2 = streaming)**: the wrap `SendMessagePlugin` bridge doesn't expose a PCF-side subscription API. Emit the one-shot structure with a top-of-file comment flagging the streaming gap; STOP with `DONE_WITH_CONCERNS`.
