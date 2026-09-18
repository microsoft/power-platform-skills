# Native artifact compatibility

Apply this contract inside `/add-native` and every nested native helper before
writing or reusing output. Dedicated helpers return before the outer Step 5;
checking only that step leaves their actual artifacts unchecked.

## 1. Resolve the current request

Inherit the absolute `working_dir`, original arguments, supplied answers,
`--implementation-only`, `--plan-only`, and current orchestration context from
`/add-native`. Apply [app-edit-routing.md](app-edit-routing.md): valid
`MOBILE_APP_ORCHESTRATING=1`, `orchestrator`, `phase`, and `approved_scope` identify
the owner and approved operation. An existing plan, memory-bank entry, environment
flag, or filename alone is not approval.
Even a memory-bank entry marked complete must pass this reconciliation; do not
skip inspection or ask a redundant redo question for the current approved request.

- **Orchestrated implementation:** use the approved capability and storage delta.
  Do not repeat entry-choice or mutation questions for an already-approved scoped
  update. Missing context or an expanded operation returns `NEEDS_CONTEXT` to the
  owner; never start `/edit-app` from a helper.
- **Standalone implementation-only:** use the bounded request, not every capability
  in an older plan. Ask only for unresolved requirements or an update outside the
  current approval, then wait. Cancellation/dismissal stops without writes; an
  ambiguous answer is not approval. Do not silently escalate to full integration.
- **Planning / `--plan-only`:** inspect and return a proposal only, without writes.

## 2. Inventory and compare the actual output set

Before any writes, list every requested artifact as **missing**, **compatible**,
or **incompatible/unknown**, with the required exports, behavior, storage contract,
and scoped action. Inspect each existing file and relevant consumers read-only,
including `.tsx`, upload helpers, and app-owned re-exports; do not treat one
existing wrapper as proof that a partial output set is complete.

Use the helper's actual output paths and public APIs below, not a guessed
capability-to-filename conversion. Follow re-exports to their implementation;
a renamed/custom API is compatible only if the approved consumers can use it
without unapproved changes. Preserve existing public exports and call signatures.
Do not create a duplicate wrapper to bypass an incompatible existing artifact.

| Helper | Actual helper-owned outputs and compatibility checks |
|---|---|
| Camera / gallery / scanner | `src/native/camera.ts` exports `takePhoto`, `pickImage`, `requestCameraPermission`, `requestMediaLibraryPermission`, and `PhotoResult`; gallery uses `pickImage` here, not a required `imagePicker.ts`. Check the requested capture/picker methods, options, URI/metadata, and permission/cancel/unsupported/error results. Requested scanning independently needs `src/native/barcodeScanner.tsx`: `BarcodeScannerView`, `BarcodeScannerViewProps`, `ScannerResult`, `onScanned`, `paused`, `resetKey`, requested `barcodeTypes`, one-shot lock, permission fallback, and sibling overlay rendering. Custom Image retention additionally needs `src/native/cameraUpload.ts`: `uploadPhotoToImageColumn`, `ImageUpdateService`, `UploadResult`, native URI-to-base64 reading supported by the installed `expo-file-system` API (or `/legacy`), and a truthy generated-service `success` check. An Image `update()` helper is not a File upload implementation. |
| PDF report | `src/native/pdfReport.ts`: `createPdfReport`, `wrapPdfDocument`, `escapePdfHtml`, `PdfReportResult`; verify requested options, deterministic app-owned HTML, local `file://` output, and `includeBase64`/returned base64 when required for retention. Requested sharing additionally needs `sharePdfReport` and `PdfShareResult`, local URI validation, availability/error handling, and installed `expo-sharing`. Package presence alone does not authorize adding sharing. No direct native-viewer import or remote HTML fetch. |
| PDF viewer | `src/native/pdfViewer.ts`: `openHttpsPdf`, `PdfViewerResult`, requested title/size/cache options and native actions. Verify installed `@microsoft/power-apps-native-pdf-viewer` version 0.2.9+; an HTTPS-only old wrapper is incompatible with a local PDF request. Accept `https://` and non-empty `file://`; reject `content://`, `blob:`, `http://`, empty/malformed inputs. Check `INVALID_URL`, `NATIVE_MODULE_MISSING`, and `VIEWER_FAILED` paths, not just the function name. |
| Pen input | `src/native/penInput.ts`: `captureSignature`, `stripDataUriPrefix`, `PenInputResult`, requested stroke/background options, PNG `data:image/png;base64,...` output, non-error `USER_CANCELLED`, `NATIVE_MODULE_MISSING`, and `CAPTURE_FAILED`. A capture-only wrapper is insufficient when the requested storage contract also needs prefix normalization; check the Image/File payload distinction below. |
| Geolocation | `src/native/geolocation.ts`: `startTracking`, `stopTracking`, `isTracking`, `getPermissionStatus`, `getCurrentLocation`, `GeoTrackingTarget`, `GeoResult`, and the `LocationData`/`PermissionStatus` type exports. Verify `geoService`/`BgLocationClient`, MSAL-only auth, required `connectionUrl`, `trackInBackground`, `persistAcrossRestarts`, and native durable storage/Dataverse sync. A one-shot `expo-location` wrapper is not equivalent. Verify `msdyn_locationrecords` and every default `msdyn_*` mapped column as required by the helper; do not substitute another target or silently drop retention/tracking flags. |
| Inline capability | The actual `src/native/<wrapper>.ts` and the requested domain/permission methods from the supported-capabilities table. Check arguments, result shape, platform guards, and storage behavior against the installed module API. |

For all rows, inspect implementation behavior as well as names/types: requested
methods must handle failure/cancellation/platform states without throwing
(including permission calls). Compare with the installed package APIs/version;
an import that type-checks is not proof the native build supports the operation.
Keep each helper's missing-package, runtime-ban, and native-version gates.
Camera permission rejection must become an `error` result, not an unhandled
promise or a false permission-denied result. Missing APIs return `unsupported`;
public boolean permission helpers report the failure and return false. Scanner
permission rejection renders a failure state instead of escaping its effect.

**Storage is part of compatibility when requested.** Resolve the approved local-only
or retained-artifact behavior before judging reuse. Do not infer uploads from
unrelated generated columns or an old plan. For retained artifacts, inspect the
actual generated target column type and service signature read-only:

- Custom camera/pen **Image** updates use the generated service's supported image
  payload; strip the PNG data URI prefix when raw base64 is expected. Camera's
  native Image helper reads URI bytes as base64, not browser `File`/`Blob`.
- **File** retention saves/updates the parent row, verifies success and its ID,
  then uploads compatible bytes/File/picked-file payload through the generated
  service. Never put File bytes in create/update JSON or assume an upload accepts
  a URI. Verify truthy `success` on writes, not merely absence of an error.
- Host `FilePicker` / `ImagePicker` still own normal Dataverse form fields.
  PDF/pen screen-side save examples are integration guidance, not helper-owned
  upload implementations. Do not claim they were implemented by writing a
  capture wrapper. Identify any approved owner-side adapter/screen work explicitly.
- Missing/unknown required storage targets, generated signatures, or payload
  support are unresolved requirements, not permission to skip retention. Return
  `NEEDS_CONTEXT` to the owner, or ask standalone before proceeding. Do not create
  schema, refresh services, or hand-edit `src/generated/` to make the check pass.
  Geolocation retains its stricter missing-table/column `BLOCKED` gate.

## 3. Apply the reconciliation decisions

Decide the entire requested set before applying writes in the helper's output steps.

- **Compatible:** reuse unchanged, including custom code; do not append a
  regeneration comment or rewrite the file to match the example.
- **Missing and in scope:** create only that requested artifact. In a partial set,
  keep compatible siblings unchanged; a missing scanner/upload helper does not
  authorize regenerating the camera wrapper.
- **Incompatible and update already approved:** make the smallest scoped update
  to helper-owned code, preserving unrelated custom behavior, exports, and callers.
  Proceed without another approval question. Examples are starting points, not
  overwrite templates; adapt them to the live API and the approved contract.
- **Incompatible/unknown and not safely covered by approval:** stop before writes;
  return `NEEDS_CONTEXT: <artifact, mismatch, required scoped decision>` to the
  owner, or ask standalone. This includes a repair needing caller changes,
  replacement of custom code, unapproved storage, or a new capability. Do not
  delete, rename, replace wholesale, or silently skip it.
- **Unrequested:** leave untouched. Do not generate an optional companion merely
  because a package, plan row, or generated column exists.

Recheck if files changed since inspection. No branch permits installs, dependency
or native-config edits, native builds, screen edits, or hand-editing generator-owned
output. Full integration remains the owner's job; implementation-only does not
authorize those changes.

## 4. Verify and return

After scoped edits (or a reuse-only run), recheck every requested artifact and
storage requirement against the inventory. Run the helper's type-check and changed-file
validation, plus available focused behavior checks; review the relevant negative
paths when native execution is unavailable and report that limitation.
Type-check success alone is insufficient: existence, compilation, or one
compatible sibling cannot stand in for an unfulfilled requested artifact.

Return `DONE` only when all requested helper-owned artifacts and their API/behavior/
storage obligations are fulfilled. Otherwise return `NEEDS_CONTEXT` or `BLOCKED`
as applicable, not a success summary or completed memory-bank entry.
List created/updated/reused files, preserved exports, compatibility evidence,
`writtenFiles` (only actual helper-owned edits), validation, and unresolved
owner-side integration. Report no generator-owned changes. In orchestrated mode,
return to the owner for screens and final plan/memory updates; implementation-only
reports that UI integration was intentionally not performed. Never equate helper
success with a completed end-to-end retained-artifact feature.
