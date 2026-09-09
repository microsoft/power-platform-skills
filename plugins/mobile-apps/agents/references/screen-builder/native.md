# Native capabilities — load only when used

Check the approved capability matrix and existing `src/native/` signatures. Native
packages must already be allowlisted in the bundled template; installing a package
cannot add native code to the rewrap binary. `expo-haptics` is runtime-banned;
`expo-notifications` is unavailable. Report unsupported capabilities to foreground.

Use approved wrappers, not raw native module imports in screens: camera/gallery,
scanner, secure store, document picker, PDF generation/viewing, pen, file system,
sharing, and location/tracking. Missing wrapper is a foreground `/add-native`
prerequisite, never an invented import with a success-shaped TODO.

Check discriminated results (`ok`/`reason`) before changing UI or reporting success.
Cancellation leaves current data intact and is not a failure. Permission denial,
unsupported platform/module, invalid URL, capture failure, and upload failure each
retain a useful visible recovery path. Recovery/dismiss/manual controls cannot live
only in a camera preview branch that disappears when permission is denied.

## Camera and scanner

- Custom evidence capture needs a first-class visible `Take picture` / `Take evidence
  photo` action calling the camera wrapper. Gallery can be secondary, not its replacement.
- Scanner writes use both the wrapper one-shot guard and a screen-level ref lock:
  lock synchronously, pause before mutation, reset lock/paused/resetKey on focus or
  retryable failure. Pass `paused` and `resetKey` to `BarcodeScannerView`. Manual entry
  shares the same guarded business handler; no duplicate writes from rapid scan events.
- Scan-gate flows look up first. A miss stays on the scanner with “Item does not exist”;
  never create Unknown records unless explicitly approved.
- Processing feedback belongs in the scanner overlay when a preview is available;
  permission recovery must remain outside/alongside that preview. Keep dismiss visible,
  manual entry when the workflow supports it, and request/settings action as appropriate.
- Safe-area protects scanner modal headers as well as preview controls.

## Dataverse File/Image boundary

- Standard Dataverse File/Image form fields use host `FilePicker` / `ImagePicker` from
  `@microsoft/power-apps-native-host`. Capture selected values via the documented
  callbacks; persist with generated `Service.upload` after successful parent save.
  Read with `downloadFile`/`downloadImage`. Do not substitute raw Expo picker workflows
  or put these control payloads into `Service.update`.
- Custom camera URI → Image-column flow uses its wrapper to read base64 then generated
  `Service.update(recordId, { [imageColumn]: base64 })`, not a coerced browser File/Blob.
  This is a different path from the host form controls.
- Pen returns a PNG data URI; strip the prefix where the generated Image payload needs
  raw base64. PDFs/signature PNGs stored as File bytes upload only after the parent (or
  planned Evidence/Attachment child) exists. Never put File bytes into create/update JSON.
- Check every write/upload result. Preserve a committed ID and capture for targeted retry;
  never claim “saved” before required evidence upload, or claim rollback of a saved row.

## PDF / pen / location

Use `openHttpsPdf` for supported HTTPS and local `file://` URIs (viewer 0.2.9+).
Disable/reject empty, `http://`, `content://`, and `blob:` inputs with a visible reason.
Handle `NATIVE_MODULE_MISSING`, `VIEWER_FAILED`, `CAPTURE_FAILED`, `uploadFailed`,
and `invalidUrl`; `USER_CANCELLED` keeps state unchanged. Background GPS calls only
approved wrapper lifecycle APIs and never implies tracking started before success.

A created offline profile or “No connection” banner is not offline runtime support.
No “saved offline”, durable draft, or pending-sync guarantee without implemented,
verified storage/queue behavior.
