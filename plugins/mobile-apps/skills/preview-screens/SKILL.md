---
name: preview-screens
description: Preview a planned primary journey or source-derived generated screens in a browser without Metro or a simulator. Supports intent before building and implementation approximation after building.
user-invocable: true
allowed-tools: Read, Write, Glob, Grep, Bash
model: sonnet
---

# Preview Screens

Follow applicable [shared instructions](../../shared/shared-instructions.md). Produce model-authored HTML/CSS with a small local interaction script—not a new renderer framework, not execution of React Native.

## 1 — Locate and select mode

Use `--working-dir <path>` or cwd. Accept an app project (`package.json` or `power.config.json`), or an artifact-only design directory containing `brand/design-system.md`. Read the app name from the plan, memory-bank title, or package metadata.

| Mode | Input source | Output |
|---|---|---|
| `--mode intent` | Approved plan + brand design/tokens; before build | `_design_preview.html` |
| `--mode implementation` | Current screen TSX + referenced local UI/config; after build | `preview.html` |
| No mode | Implementation if visible app screen sources have been built; otherwise intent | As above |

Auth-only/scaffold placeholders, layouts, OAuth callbacks, and redirects alone do not make an implementation. If the caller knows the lifecycle phase, use it: `/create-mobile-app` Step 6.75 explicitly requests intent; after screen building and `/edit-app` implementation changes explicitly request implementation. An explicit mode always wins.

Never copy `_design_preview.html` to `preview.html` or present stale intent as implementation. If explicit implementation has no built screens, report the missing input instead of silently falling back. Intent needs a plan journey, or the standalone design spec's small journey; if neither exists, report the missing context.

## 2 — Scope by journey

**Telemetry checkpoint: `discover_app_screens`**

**Intent:** follow [direct intent authoring](references/intent-authoring.md). Use compact relevant product context from the existing plan: domain/actors, journeys, data relationships and rules, connector operations, approved native capabilities, navigation, and design. Match heading capitalization case-insensitively and reuse `### Preview selection` (legacy `### Primary Preview`) for representative preview screen IDs and selection rationale. Select three main screens by default, fewer for a smaller product; no strict three-screen cap or List/Form/Detail default. If selection is missing, return IDs/rationale to the caller for the existing plan.

**Implementation:** discover visible `app/**/*.tsx`, excluding `_layout.tsx`, `+not-found.tsx`, dot directories, OAuth callbacks, and auth-only redirects. Read layouts separately for navigation/theme context. Match screen IDs/routes to the plan where present, but actual source determines what exists. Preserve all discovered screens by default; an explicit requested journey/screen subset may narrow scope. Order by primary journey entry and action sequence, not home-plus-two-details.

Keep preview navigation controls distinct from app navigation. Use valid stable IDs, human-readable labels, and an entry screen that makes the task obvious. Include every intermediate destination necessary for the selected journey (or explicitly label out-of-scope destinations); never leave a required action as a dead button.

## 3 — Resolve actual design inputs

**Intent:** use approved design/token values directly in CSS. Do not load the Tamagui-to-HTML mapping or a prescribed phone shell.

**Implementation only:** read [Tamagui-to-HTML mapping](../../shared/references/tamagui-html-mapping.md). Read `brand/design-system.md`, `brand/tokens.ts`, `tamagui.config.ts`, and only the local imports needed to resolve used tokens/fonts/themes. Inspect imported brand tokens, exported `appLightTheme` / `appDarkTheme`, provider theme props, and local font assets/loading—not just inline `tokens.color`.

- Intent before integration uses the approved brand inputs and the same host alias mapping planned for Step 9b. Label unresolved values/fallbacks rather than asserting exact host fidelity.
- Implementation uses the current resolved source/config even if it differs from the design spec. Report that drift; do not restyle the source to hide it.
- Resolve light and dark independently: surface/text/accent/status pairs, space, size, radius, font family/weight/size/line-height/tracking. Preserve Tamagui numeric keys and named brand keys separately.
- Define every CSS variable used, including `--surface0` and `--surface1`, in both advertised themes. Never substitute a generic palette for imported brand values.
- Use available local font assets with the correct weights when possible. If unavailable in browser, label the fallback; do not silently fetch Google Fonts or claim an uninstalled native font is rendered.

Do not execute arbitrary imported config, application services, auth code, or business-data network requests to obtain preview data. Verified image-media requests follow [media sources](../../shared/references/media-sources.md); they are not live data discovery. Use static reading and installed documented token definitions; unresolved dynamic values are an explicit approximation.

## 4 — Author screens and mock journey

**Telemetry checkpoint: `render_screen_preview_frames`**

**Intent:** choose composition from the approved purpose and per-screen decisions. Layout delta (or standalone brand Components) supplies provisional visual intent until visual approval, not a frozen layout. Follow the [rendered experience review](references/intent-authoring.md#rendered-experience-review) before handoff. Hierarchy, layout, media, and density may differ where the tasks differ. Token constraints do not mandate identical cards or a fixed template.

**Implementation:** read the full selected screen TSX and its referenced local UI components/hooks as needed to understand rendered branches, navigation targets, action availability, and state feedback. Convert the actual JSX/Tamagui tree, dimensions, styles, and typography to HTML. Preserve source shortcomings and report them; the preview does not fix source.

For either mode:

1. Use one coherent, clearly labeled illustrative scenario: consistent record IDs, names, dates, units, statuses, and relationships across screens. Do not read real tenant records or secrets.
2. Model key actions with small in-memory JS: selection, filter/search, navigation/back, form edit/validation, confirmation, and a visible completion state as appropriate. Include relevant loading/empty/error/retry states through an accessible scenario control where needed. Reset restores the initial scenario.
3. Implementation mock actions must correspond to handlers/states present in source. If absent, show and report the missing implementation rather than inventing a working success flow.
4. Show native-only placeholders for camera/scanner/location, PDF viewer/report, pen/signature capture, sharing/printing, file upload, auth, and offline/device APIs. Label `Native-only — not executed in browser`. Illustrative captured/ready states may be selected as mock scenarios, never falsely triggered as native success.
5. Preserve meaningful media proportions and crop using local illustrative assets or verified, appropriately licensed public HTTPS image URLs, including CDNs, under the media-source policy. Provide accessible alternatives and loading/error fallbacks; local downloads are not mandatory. Use consistent icon approximations with accessible names; never replace critical action labels with unexplained emoji.
6. Use semantic buttons/links/inputs, associated labels, keyboard operation, visible focus, text plus color for status, and contrast-tested pairs. Allow scrolling/reflow, text zoom, and reduced motion. Avoid double safe-area padding.

**Device geometry:** when given a device reference, match its width and height (measure the device,
not the surrounding screenshot) and identify the usable app area inside it. If dimensions are
unavailable, state the estimate. Otherwise use 390 x 844 CSS px as the usable app viewport default,
not a production layout constraint; place decorative bezels outside that area. Honor explicit
phone/tablet targets. Keep the same geometry across screens and revisions. Measure usable content
separately from decorative bezels, system/app chrome and the scrolling viewport. Compare references
at the same usable width; disclose reference estimates rather than silently widening the app.
Do not stretch frames with grid columns or shorten them using
browser `vh` to fit above the fold. Scroll content inside the device; keep app chrome consistent.
If the review canvas cannot fit the devices, wrap or use a switcher. Test narrow reflow separately
at 320px without claiming it is the original device size. Report measured frame/content dimensions.

No live service calls, storage writes outside the preview file, credentials, CDN scripts, analytics, remote font dependencies, or browser handlers pretending to save/upload to the tenant. Declared verified HTTPS image requests are allowed; disclose their network dependency. Local simulation is not an app test.

## 5 — Assemble and check

**Telemetry checkpoint: `write_screen_preview_document`**

**Intent:** author the complete HTML/CSS presentation directly; no prescribed shell or component conversion. **Implementation:** the mapping reference's adaptable phone shell is optional. Write only the selected mode's output. Label mode, scenario, source basis, and any unsupported/fallback behavior visibly. A light/dark switch is present only when both themes are resolved.

**Hard checks before handoff:**

- Safety: external content escaped for its output context; no executable imported content, secrets, unexpected network calls, or production mutations.
  Compare observed requests with declared image sources/validated redirects; remote image media
  is allowed, remote executable scripts are not. Verify image errors preserve layout and usable data.
- Links: unique screen/control IDs; every internal navigation target exists; external links are safe and intentional; no broken required journey destinations.
- Required actions: primary journey can reach its completion and relevant recovery/reset; implementation gaps are visible, not fabricated.
- Domain behavior: the illustrative transition follows the approved actor/preconditions and
  updates only intended state/records. Preserve independent states and any explicitly approved coupling.
- First use: top-level entries open the planned task surface or justified singleton;
  check applicable scope/filter, filtered emptiness, and selected-item/deep-link entry with a
  useful return path. Include scanning only when approved. Do not auto-switch explicit filters.
- Accessibility: controls have names/labels, keyboard/focus behavior, usable targets, readable contrast, non-color status cues, and no clipped essential content.
- Token coherence: all CSS variable references resolve in every offered theme; compare representative surface/text/accent and typography values against actual resolved inputs.
- Experience evidence (intent): compare rendered context, hierarchy, decision/read evidence,
  media proportions, action placement, usable first viewport and initial-state consistency
  against approved task requirements and the current visual-intent proposal, not a frozen
  early layout suggestion.
  Use the linked review's bounded repair and unavailable-tool rules; do not certify this from
  HTML structure or successful handlers alone.

Composition variety, resemblance to a named style, accent ratios, card counts, and screenshot similarity are **advisory**, not blocking tests. Check whether choices serve the task; do not enforce decorative sameness or diversity.

## 6 — Open, exercise, report

**Telemetry checkpoint: `open_screen_preview`**

Honor `visual_companion: no` and legacy `skip` even on standalone invocation: print the file link without auto-opening. Otherwise use available browser tools first: reuse an existing page, open the preview, inspect the accessibility snapshot, exercise every scope/filter binding, top-level entry/filter-empty recovery, exact-record lookup and primary actions/back/reset, toggle resolved themes, compare the wide three-screen canvas, and check 320px reflow. Screenshots supplement these checks; they do not replace interaction.
For intent, inspect an actual screenshot of every selected screen's initial state, its internal
scrolling and bottom actions, at the target device size, at 320px reflow, and in every offered
theme. Normal click/keyboard actions must work: forced clicks or injected handler calls are not
evidence of reachability. Respect opt-out; unavailable screenshots are unverified, not passed.

If browser tools are unavailable, use the OS opener (`open`, `xdg-open`, or PowerShell `Start-Process`) with safely quoted paths, or print the link. Do not install a browser/testing framework merely for preview. State that browser interaction was not verified when only file/static checks were possible.

Return output path, mode, selected screens/scenario, checks actually run, and known gaps. For intent include the compact per-screen review evidence and any repairs; missing visual evidence returns `DONE_WITH_CONCERNS`, not a claimed visual pass. For implementation report source shortcomings rather than improving the preview to hide them. Say “source-derived implementation approximation” after build, never “native app verified.”

Source is read-only: do not modify TSX, services, configs, plan, or memory bank from this skill. The caller persists selection/approval. Re-running replaces only that mode's HTML; generating intent never overwrites implementation and vice versa.
