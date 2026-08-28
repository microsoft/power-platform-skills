# Framework Recommendations

> Opinionated iOS/Android UI + framework guidance for the most common capability areas a **third-party PAM control's native module** surfaces. In this track it is consulted by **`/debug-extension`** (it MUST conform to a capability area's MANDATORY rows — e.g. a Done/Cancel affordance, active-tool feedback) and by the **self-critique protocol** (the adaptive-UI-primitive checklist). `/design-native-extension-feature` uses its **own framework judgment** for the capability→library mapping (grounded against [`ppmplugin-format.md`](./ppmplugin-format.md) §5/§5b) but the **adaptive-UI primitives + MANDATORY interaction rules below still apply** to the native module it specifies.
>
> **This file is not exhaustive.** For capability areas not listed here, fall back to general iOS/Android best practices and name the practice in the plan.
>
> **Maintenance:** when an OS release changes the recommended pattern, update the entry here — the skill prompts don't hard-code framework choices.

---

## How recommendations flow into ARCHITECTURE

For each operation in PRD §4 (top-level: name + purpose + pattern), the design skill:

1. **Classifies** the operation into a capability area below — by reading the operation's purpose against the headings here.
2. **Reads the matching section** for iOS + Android recommendations.
3. **Presents a recommendation block** to the user with: framework + class choice, *why* (one-line rationale), min OS version, the key APIs, the decisions the user must make explicitly, the edge cases the implementation should handle, alternatives if the default doesn't fit.
4. **Gates with `AskUserQuestion`:** Accept / Adjust iOS / Adjust Android / Override entirely.
5. **Writes the agreed spec to ARCHITECTURE §3.x** — the per-operation implementation block that drives scaffold's code generation.

Scaffold reads §4.x and produces **complete working code**. No `// TODO: implement` markers. The agreed spec is what determines the output.

---

## Preferred adaptive UI primitives

> Status: **preference, not requirement.** Generators and editors should reach for these primitives first because they handle screen-size, font-scale, and overflow concerns automatically — the OS team has already solved the layout problem. If the design genuinely doesn't fit one of these (rare), a manual layout is fine — just be aware that you take on the responsibility for sizing across screen widths.

### Why prefer adaptive primitives

The dominant Android UI bug we've seen in extensions is: a horizontal `LinearLayout` with N wrap-content children overflows on small screens, and a primary action (Done) gets pushed off-edge. The fix isn't to teach the skill to *measure* — it's to use a component that the framework *already* handles measurement for. The adaptive primitives below have built-in overflow, distribution, or scrolling behavior so the "does it fit?" question doesn't arise.

### Android — preferred primitives

| Component | Use it for | What it handles for you |
|---|---|---|
| **`MaterialToolbar`** with menu items (`menu/*.xml`, `app:showAsAction`) | Top nav bar with Cancel + Done + actions | Built-in overflow into `⋮` menu when buttons don't fit. Anchors `navigationIcon` left and menu actions right. Theming, accessibility semantics, back-arrow affordance — all free. |
| **`BottomAppBar`** + FAB | Bottom action bar with a primary action | Handles its own height, insets, and system-gesture areas. Pairs with FAB for the primary action. |
| **`ConstraintLayout`** with chains + barriers | General-purpose container with sibling relationships | Children resize / distribute per chain style (`spread`, `spread_inside`, `packed`); barriers handle dynamic content sizing. |
| **`FlexboxLayout`** (`com.google.android.flexbox:flexbox`) | Tool palettes, chip rows where content count varies | Wraps to next line when full; children can grow/shrink per flex factor. |
| **`HorizontalScrollView`** wrapping a `LinearLayout` | Tool palettes that must stay one row even when there are many tools | Gracefully scrolls horizontally when content exceeds width. |
| **`MaterialButtonToggleGroup`** | Mutually-exclusive mode selectors (Pen/Eraser, Draw/Pan, etc.) | Auto-tints the checked button per the Material 3 theme. Handles single-select / multi-select via `app:singleSelection`. |
| **`RecyclerView`** with `GridLayoutManager` / a Compositional layout | Lists / grids of items | Recycles views, handles arbitrary content size, supports adaptive column counts. |

### Android — manual primitives (use only when the above don't fit)

- Raw horizontal `LinearLayout` with `WRAP_CONTENT` children. **Be aware:** does not compress children when their combined width exceeds the parent. Consider this when you've genuinely got ≤2 controls and there's no overflow risk.
- `FrameLayout`, `RelativeLayout` — fine for stacked / absolute positioning where adaptive distribution isn't relevant.

### iOS — preferred primitives

| Component | Use it for | What it handles for you |
|---|---|---|
| **`UINavigationBar`** with `UIBarButtonItem`s | Top nav bar | Truncates title with ellipsis, demotes items into overflow on compact size class, automatic theming. |
| **`UIToolbar`** with `.flexibleSpace` items | Distributed action bar | Auto-distributes items across width. |
| **`UIStackView`** (`.fillEqually`, `.equalSpacing`, etc.) | General horizontal/vertical arrangement | Children sized by distribution mode; respects intrinsic content size. |
| **`UICollectionView`** with `UICollectionViewCompositionalLayout` | Adaptive grids | Per-section layout adapts to size class. |
| SwiftUI **`HStack { ... Spacer() ... }`** / **`Grid`** / **`ViewThatFits`** | Layout in Swift code | Reactive sizing; `ViewThatFits` picks the first layout that fits. |

iOS UIKit components are opinionated by default, so the discipline is less load-bearing than on Android. If you're constraining custom views, the only common pitfall is constraining to `view` instead of `view.safeAreaLayoutGuide` (notch / home indicator). The preferred-primitive guidance is for awareness rather than as an active prevention measure.

### UI density — keep horizontal groups small

> Status: **soft guideline**, not a rule. Surfaced by the self-critique protocol as a suggestion when violated.

Even with an adaptive primitive that *technically* fits any number of children (e.g. `MaterialToolbar` overflow menu can hide ten actions behind `⋮`), packing many controls into one horizontal row is poor UX:

- **Cognitive load** — users scan a row left-to-right looking for what they need. Five+ controls require more search effort and visual chunking; the eye doesn't land cleanly on the primary action.
- **Discoverability** — items hidden in an overflow menu (`⋮`) are not discovered by most users. If an action is worth surfacing, it deserves a visible spot; if not, it probably doesn't belong in the toolbar at all.
- **Touch precision** — at narrow widths, crammed controls become touch-target collisions. Each button gets less horizontal room, making accidental taps more likely.

**Soft limit:** ~3–4 **logical control groups** per horizontal row. Past that, redesign before reaching for an overflow menu.

A **logical group** is one user-facing affordance, not one widget. Examples:
- One `MaterialButtonToggleGroup` containing N toggles = **1 group** (it's one mode-selector affordance).
- One `MaterialButton` "Cancel" + spacer + one `MaterialButton` "Done" = **2 groups**.
- A row with Cancel + Pen toggle + Eraser toggle + Clear + Undo + Redo + Done = **5 groups** (the two toggles aren't a toggle group, and the rest are individual). Past the soft limit — redesign.

**Redesign options when you're past the limit:**

| Strategy | When to use |
|---|---|
| **Multi-row layout** | When the controls naturally split into navigation (Cancel/Done) + action surface (tools). Already the fallback for §1 drawing. |
| **Contextual surfacing** | Show some controls only when they're relevant (Undo/Redo appear only after the first stroke; Color picker only when Pen is active). Reduces resting-state density. |
| **Drawer or sheet** | Move secondary options (advanced settings, tertiary actions) into a bottom sheet or side drawer triggered by a single toolbar entry. |
| **Grouping** | Combine related individual controls into one logical group: turn "Pen | Eraser | Highlighter" three buttons into one `MaterialButtonToggleGroup` (1 group, 3 toggles). |

**Anti-pattern that this guideline catches:** "I'll just add a `⋮` overflow menu" as a solution to a UI density problem. Overflow menus are appropriate for genuinely tertiary actions (Help, About, Settings). Using them to swallow primary or secondary actions because the toolbar got too crowded is a code smell — fix the design, not the layout.

### When to deviate from adaptive primitives

Adaptive primitives are a default, not a mandate. Legitimate reasons to write a manual layout:

- The adaptive primitive's API genuinely doesn't expose what the design needs (e.g. you need a specific tool-palette visual that doesn't fit `MaterialToolbar`'s menu model).
- The number of children is small and bounded (≤2), and the layout is trivial enough that adaptive behavior isn't needed.
- The capability area is non-standard and no adaptive primitive is obviously a fit.

When you deviate, the responsibility for sizing across screen widths shifts onto you. The self-critique protocol's Gate 3 will surface this as a concern (not a blocker) so the user can decide whether the deviation was intentional. The protocol will not force a switch — it'll just note the gap.

---

## 1. Drawing / signature capture

**iOS — recommend PencilKit.** Min iOS 14.0.

| Detail | Value / guidance |
|---|---|
| Primary class | `PKCanvasView` hosted in a dedicated `UIViewController`, presented modally |
| Tool picker | `PKToolPicker` in window-attached mode (iOS 14+; `setVisible:forFirstResponder:` then `addObserver:`). PencilKit's built-in tool picker handles mode switching (pen / eraser / lasso) with proper active-state UI, so you don't build that yourself. |
| Export | `drawing.image(from: canvas.bounds, scale: 2.0)` → `UIImage` → `UIImagePNGRepresentation` → base64 |
| Stroke count | `canvas.drawing.strokes.count` |
| Decisions for the user | Drawing policy (`.anyInput` vs `.pencilOnly`); ToolPicker visibility (visible vs hidden+custom UI); export scale (default 2.0); modal presentation style |
| Eraser behavior | Free with PencilKit's tool picker — supports both stroke-erase and rubber-pixel-erase modes; user toggles via the tool picker UI. |
| Edge cases | Rotation during capture (default: lock to portrait); empty submission (`USER_CANCELLED` vs empty result); background-app behavior |
| Alternatives | `UIBezierPath` + custom `UIView` (only for iOS < 14 compat — significantly more code, manual palm rejection, build your own tool picker) |

**Android — recommend custom `View` with `Canvas` drawing.** Min SDK 21. There is no PencilKit equivalent — you build the tools UI yourself.

| Detail | Value / guidance |
|---|---|
| Primary class | Custom `View` overriding `onTouchEvent(MotionEvent)`; hosted in a dedicated `Activity` |
| Stroke model | `Path` per stroke, accumulated in a `MutableList<Path>` with parallel `MutableList<Paint>` for per-stroke styling |
| Stylus pressure | Read via `MotionEvent.getPressure()`; scale `Paint.strokeWidth` if the device reports `> 0` (Samsung S-Pen, Wacom EMR support it; most phones return 1.0) |
| Hardware acceleration | `setLayerType(LAYER_TYPE_HARDWARE, null)` for low-latency drawing |
| Export | Render strokes onto a `Bitmap` via `Canvas.drawPath`; compress to PNG with `Bitmap.compress(PNG, 100, ...)`; base64-encode |
| **Toolbar — preferred** | `MaterialToolbar` with menu items (see "Preferred adaptive UI primitives" at the top of this file). Cancel as `navigationIcon` (left), Done as a menu item with `app:showAsAction="always"` (right). Other actions (Clear, etc.) as menu items with `app:showAsAction="ifRoom"`. The Toolbar handles overflow into the `⋮` menu automatically — no hand-rolled width juggling. Mode-toggle controls that need always-visible active state should live in a row *below* the toolbar, not as menu items (overflow menu hides active state). |
| **Toolbar — manual fallback** | A two-row `LinearLayout` (nav row + tool row) is acceptable when the design genuinely doesn't fit `MaterialToolbar`'s menu model. Keep each row to ≤3 wrap-content children; if more, wrap the tool row in a `HorizontalScrollView`. |
| **Done action** | Recommended: include a Done action so the user has a way to submit. Without it, the only exit is Cancel — the operation can never resolve with a success result. The Done handler renders the bitmap and resolves the Promise with the base64 PNG. |
| **Active-tool feedback** | Recommended: when the user toggles between Pen / Eraser / etc., the active tool's button should visually indicate its state. Use a `MaterialButtonToggleGroup` with `app:singleSelection="true"` (radio-style toggle group). Toggled-on button uses theme's `colorPrimaryContainer`; toggled-off uses transparent. Without this, the user can't tell which mode is active. |
| **Eraser semantics** | Two options — pick one and document in ARCHITECTURE §3.<n>: <br>① **Stroke-erase**: tap a stroke, remove the whole `Path` from the list. Cheap and predictable. <br>② **Rubber-pixel-erase**: PaintFlagsDrawFilter / `PorterDuff.Mode.CLEAR`. Erase only where the eraser moves. Matches user mental model of "rubber" but requires a different rendering pipeline (bitmap-backed rather than path-list). **Recommend rubber-pixel-erase** for v1+ extensions — better UX, matches iOS PencilKit behavior. |
| Decisions for the user | Pressure handling (uniform width vs pressure-scaled); active-tool toggle group visual style; **eraser semantics (stroke vs rubber-pixel)**; Done button label ("Done" / "Save" / "Submit") |
| Edge cases | Rotation: `android:screenOrientation="portrait"` in the Activity manifest entry; process death: save draft to `onSaveInstanceState`; mixed stylus + finger input |
| Alternatives | Third-party libs (`Android-SignaturePad`, `ScratchView`) — pulls extra deps for negligible gain |

---

## 2. PDF viewing

**iOS — recommend PDFKit.** Min iOS 11.0.

| Detail | Value / guidance |
|---|---|
| Primary class | `PDFView` hosted in a dedicated `UIViewController` |
| Loading | `PDFDocument(url:)` for file URIs; `PDFDocument(data:)` for base64 input |
| Decisions | Display mode (`.singlePage`, `.singlePageContinuous`, `.twoUp`, `.twoUpContinuous`); auto-scale (yes/no); page navigation gestures (default enabled) |
| Edge cases | Network-fetched URL (download to temp file, then load); password-protected PDF (`PDFDocument.isLocked`, call `unlock(withPassword:)`); huge PDFs (display progress) |
| Alternatives | `WKWebView` rendering the PDF — works for simple display but no PDF-specific affordances (text selection, annotations, search) |

**Android — recommend PdfRenderer.** Min SDK 21.

| Detail | Value / guidance |
|---|---|
| Primary class | `android.graphics.pdf.PdfRenderer` for page-by-page rendering to `Bitmap` |
| File source | Requires `ParcelFileDescriptor` opened on a seekable file — write the input to a temp file if it arrived as base64 |
| Display | Render each `PdfRenderer.Page` into a `Bitmap`, display via `ImageView` in a `ViewPager2` for swipe navigation |
| Decisions | Page-render quality (default: screen-density pixels per point); whether to cache rendered pages in memory |
| Edge cases | Password-protected PDFs (PdfRenderer can't decrypt — need a third-party lib); huge PDFs (page-by-page rendering with LRU cache) |
| Alternatives | `AndroidPdfViewer` (third-party, more features incl. password support); `WebView` (basic, no good UX) |

---

## 3. Camera — photo capture

**iOS — recommend AVFoundation.** Min iOS 13.0 for the recommended API surface.

| Detail | Value / guidance |
|---|---|
| Primary class | `AVCaptureSession` + `AVCapturePhotoOutput` hosted in a dedicated `UIViewController` with `AVCaptureVideoPreviewLayer` |
| Permission | `NSCameraUsageDescription` in Info.plist; `AVCaptureDevice.requestAccess(for: .video)` before starting session |
| Capture | `photoOutput.capturePhoto(with: settings, delegate: self)`; receive `AVCapturePhoto` in delegate callback; convert via `photo.fileDataRepresentation()` |
| Decisions | Front vs back camera default; flash mode; capture format (JPEG vs HEIF); aspect ratio |
| Edge cases | `PERMISSION_DENIED` when user denied at OS level; orientation handling (`AVCapturePhotoSettings.embedsDepthDataInPhoto` and EXIF rotation); low-light auto-flash |
| Alternatives | `UIImagePickerController` (simpler API but less control, no live preview customization) |

**Android — recommend CameraX.** Min SDK 21.

| Detail | Value / guidance |
|---|---|
| Primary class | `CameraX` library (Jetpack); `ImageCapture` use case + `PreviewView` for preview |
| Permission | `android.permission.CAMERA` in manifest; runtime request via `ActivityResultContracts.RequestPermission()` (API 23+) |
| Capture | `imageCapture.takePicture(outputFileOptions, executor, callback)`; receive `OutputFileResults` with the file URI |
| Decisions | Front vs back default; flash mode; quality preset; aspect ratio |
| Edge cases | Permission denied; device with no back camera; storage permission on API < 29 |
| Alternatives | `Camera2` (lower-level, more control, more boilerplate); `Camera` (deprecated, avoid) |

---

## 4. Audio recording

**iOS — recommend AVFoundation.** Min iOS 13.0.

| Detail | Value / guidance |
|---|---|
| Primary class | `AVAudioRecorder` with `AVAudioSession` configured for `.record` category |
| Permission | `NSMicrophoneUsageDescription` in Info.plist; `AVAudioSession.sharedInstance().requestRecordPermission(...)` |
| Format | Default M4A (AAC); WAV available for higher quality with size cost |
| Decisions | Format (M4A vs WAV); sample rate (44.1 kHz default); max duration; live meter levels visible to user (yes/no) |
| Edge cases | Permission denied; interruption (phone call) — handle `AVAudioSession.interruptionNotification`; route change (headphones unplugged) |
| Pattern | **Streaming** if PRD wants live meter levels updating during recording; **one-shot** if just start → stop → return file |

**Android — recommend MediaRecorder.** Min SDK 21.

| Detail | Value / guidance |
|---|---|
| Primary class | `MediaRecorder` (audio-only profile) |
| Permission | `android.permission.RECORD_AUDIO` in manifest; runtime request |
| Format | `OutputFormat.MPEG_4` + `AudioEncoder.AAC` for M4A; `OutputFormat.THREE_GPP` for compatibility |
| Decisions | Format; max duration; max file size; live amplitude metering via `getMaxAmplitude()` |
| Edge cases | Permission denied; audio focus loss (`AudioManager.OnAudioFocusChangeListener`); storage |
| Pattern | Same as iOS — streaming if meter updates needed |

---

## 5. Location (one-shot fix)

**iOS — recommend CoreLocation.** Min iOS 13.0.

| Detail | Value / guidance |
|---|---|
| Primary class | `CLLocationManager` with `desiredAccuracy = kCLLocationAccuracyBest`; `requestLocation()` (one-shot API) |
| Permission | `NSLocationWhenInUseUsageDescription` in Info.plist; `requestWhenInUseAuthorization()` |
| Response | `CLLocationManagerDelegate` returns one fix via `didUpdateLocations` (single-element array) |
| Decisions | Accuracy (`kCLLocationAccuracyBest`, `.tenMeters`, `.hundredMeters`); timeout (no native — wrap in `DispatchQueue.global().asyncAfter`) |
| Edge cases | Permission denied/restricted (`CLAuthorizationStatus`); airplane mode (`didFailWithError` with `kCLErrorLocationUnknown`); timeout |
| Pattern | **One-shot** — `requestLocation()` produces exactly one fix |

**Android — recommend FusedLocationProviderClient.** Min SDK 21 (with Google Play Services).

| Detail | Value / guidance |
|---|---|
| Primary class | `FusedLocationProviderClient` from `com.google.android.gms:play-services-location` |
| Permission | `android.permission.ACCESS_FINE_LOCATION` (or `_COARSE_`); runtime request |
| Method | `client.getCurrentLocation(Priority.PRIORITY_HIGH_ACCURACY, cancellationToken)` |
| Decisions | Priority (`HIGH_ACCURACY`, `BALANCED_POWER_ACCURACY`, `LOW_POWER`); whether to allow stale cached location |
| Edge cases | Permission denied; Google Play Services unavailable (rare on first-party scenarios, but real on Huawei devices) → fall back to `LocationManager`; airplane mode |

---

## 6. Biometric authentication

**iOS — recommend LocalAuthentication.** Min iOS 11.0.

| Detail | Value / guidance |
|---|---|
| Primary class | `LAContext` with `evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, ...)` |
| Permission | `NSFaceIDUsageDescription` in Info.plist (required for Face ID; not for Touch ID) |
| Decisions | Policy (`biometricsOnly` vs `biometricsOrPasscode`); fallback button text |
| Edge cases | No biometric enrolled (`LAErrorBiometryNotEnrolled`); biometry lockout after 5 failed attempts; user cancels (`LAErrorUserCancel`) |
| Pattern | **One-shot** — single auth attempt resolves Promise with success/failure |

**Android — recommend BiometricPrompt.** Min SDK 28 (API 28+); fallback to `FingerprintManager` for older.

| Detail | Value / guidance |
|---|---|
| Primary class | `androidx.biometric.BiometricPrompt` (Jetpack — backports to API 23) |
| Permission | `android.permission.USE_BIOMETRIC` (API 28+) or `USE_FINGERPRINT` (older); no runtime request needed |
| Decisions | Allowed authenticators (`BIOMETRIC_STRONG`, `BIOMETRIC_WEAK`, `DEVICE_CREDENTIAL`); negative button text |
| Edge cases | No biometric enrolled; hardware not present; user cancels; lockout (5 fails) |

---

## 7. Barcode / QR scanning

**iOS — recommend Vision framework + AVCaptureSession.** Min iOS 13.0.

| Detail | Value / guidance |
|---|---|
| Primary class | `VNDetectBarcodesRequest` from `Vision` framework, fed frames from `AVCaptureVideoDataOutput` |
| Permission | `NSCameraUsageDescription` (same as camera) |
| Symbols supported | All AVMetadataObject types (`.qr`, `.ean13`, `.pdf417`, etc.) — pass to `VNDetectBarcodesRequest.supportedSymbologies` |
| Decisions | Which symbol types to scan (QR only? all 1D + 2D?); scan region (full screen vs centered rect); haptic feedback on detection |
| Edge cases | Permission denied; no camera (simulator); multiple codes in frame |
| Pattern | **Streaming** if PRD wants each detection emitted as it happens; **one-shot** if "scan once and dismiss" |

**Android — recommend ML Kit Barcode Scanning.** Min SDK 21.

| Detail | Value / guidance |
|---|---|
| Primary class | `BarcodeScanning.getClient(...)` from `com.google.mlkit:barcode-scanning`; feed frames from CameraX's `ImageAnalysis` use case |
| Permission | `CAMERA` (same as camera) |
| Symbols | `Barcode.FORMAT_QR_CODE`, `FORMAT_EAN_13`, etc. — pass to `BarcodeScannerOptions.Builder.setBarcodeFormats(...)` |
| Decisions | Same as iOS |
| Edge cases | Same as iOS |

---

## Capabilities not covered

For capabilities outside the list above (e.g. NFC, MapKit, AR, file picker, share sheet), the design skill should:

1. Search its own framework knowledge for the standard iOS + Android idioms.
2. Compose a recommendation block in the same format used above.
3. Surface the same decision points (key APIs, decisions for the user, edge cases, alternatives).
4. Flag explicitly that this capability isn't in `framework-recommendations.md` yet — invite the user to confirm or supply expertise.

If the user accepts and the resulting extension ships, the lesson belongs back in this file as a new section.

---

## Two principles

1. **Prefer first-party OS frameworks over third-party libs** unless the third-party lib is materially better. PAM extensions ship as part of the host app's binary; every extra dependency is a long-term maintenance cost.
2. **Surface explicit decisions to the user** — never let the LLM silently pick between two reasonable options. The ARCHITECTURE §3.x block exists exactly to make these decisions visible and reviewable.
