# Native project profile and local persistence

Read this before the public native skill or any direct-read native helper.
It changes the project/persistence precheck, not the capability allowlist,
approval gates, or normal Player runtime compatibility.

## Verify the explicit project profile

For an existing initialized connected app:

```bash
node "${PLUGIN_ROOT}/scripts/verify-prototype-native.js" --project-root "<working_dir>"
```

For the explicit local profile, forward `--prototype` to every nested helper:

```bash
node "${PLUGIN_ROOT}/scripts/verify-prototype-native.js" --project-root "<working_dir>" --prototype
```

Only select that branch from the explicit creation profile or an existing
`.tmp/prototype-profile.json` identifying a materialized prototype, never merely
because `power.config.json` is missing. The verifier requires the real local
registry/startup, consistent app UUID, and compiler-owned runtime. It is
read-only and never authenticates, initializes, generates schemas, or writes
a placeholder configuration. Changed approved capability contracts may still
need a generator refresh after verification.

The result's `nativeSupport: "not-verified"` is intentional: a valid project
is not proof that a native binary contains a control.

## List and select an included template capability

Use the owning read-only catalogue helper:

```bash
node "${PLUGIN_ROOT}/scripts/list-native-capabilities.js" \
  --project-root "<working_dir>"
```

The helper uses the selected template's package.json and friendly capability
labels, with current app-package compatibility and runtime-ban policy. It
requires no device inventory or API probes. `availability: "available"` means
the included template workflow can be added, not that hardware/permissions were
exercised. Keep those runtime outcomes in the actual wrapper/UI.

In Player, use the verified descriptor's exact `integration.capabilityId` and
`catalogRevision`; do not replace a stale selection with an alias or a different
control. The owning edit workflow checks that selection and reopens Gate 1
before generation. All questions, including nested clarifications, use the
shared authoring transport. Ordinary chat uses the same inventory and
approval meaning through its normal foreground question channel.

Do not install/upgrade native packages, edit native config, or claim binary
support merely because a JavaScript import type-checks. No catalogue listing
provisions an environment or queries/creates a connection.

## Local capture and retained images

For a prototype's approved `camera` or `image-picker` capability, refresh the
actual app-owned capture implementation after updating the owning approved
capability contract:

```bash
node "${PLUGIN_ROOT}/scripts/generate-prototype.js" --project-root "<working_dir>"
node "${PLUGIN_ROOT}/scripts/generate-prototype.js" --project-root "<working_dir>" --check
```

Use `capturePhoto` from `@/data/capture`; its source allowlist is the actual
`dataAccess.media.captureSources` registry projection. It requests permission,
invokes the installed native picker, persists the result in the current
app/schema/preview namespace, and only then returns a ready reference.
Do not generate a second camera sample-data store or run Dataverse column detection
and upload steps. A requested barcode/QR scanner still uses the existing
scanner-control helper, with no implicit lookup-table provisioning.

A pen/signature wrapper returns a PNG data URI. When the approved logical
domain contains a photo field for that evidence:

```ts
const captured = await captureSignature();
if (captured.ok) {
  const reference = await getDataRuntime().importPhoto({
    uri: captured.dataUri,
    mimeType: 'image/png',
  });
  // Assign the ready reference to the existing logical photo field.
}
```

Import validates bounded image data and writes its bytes to the actual
FileSystem before returning ready. Only references—not duplicated image
base64—enter the record store. Cancellation, unavailable binary, or persistence
failure must preserve existing evidence. Existing repository create/update
performs common domain/rule validation; never treat a data URI alone as a
successfully saved record. Existing compiler-owned `src/data` files must be
regenerated through their owner, not overwritten by native helpers.

Local PDF generation/viewing/sharing and document-picker wrappers require no
Dataverse configuration. A generated/cache PDF is not automatically durable
retained evidence: disclose its lifetime unless an approved app-owned local
file-storage wrapper actually persists it. Do not pass PDFs to `importPhoto`.
Skip every optional Dataverse upload/provisioning step in the prototype branch.
Requests for server retention route to a separately approved connected edit or
explicit Dataverse conversion, not an implicit environment choice.

## Connected-only native functionality

The shipped background geolocation helper couples native tracking to its
verified Dataverse target. It is **not** a local-only tracker. Its precheck is:

```bash
node "${PLUGIN_ROOT}/scripts/verify-prototype-native.js" \
  --project-root "<working_dir>" --require-connected
```

If invoked with a local profile, forward `--prototype` too: the command blocks
before environment queries. Do not fake a table, silently initialize, or report
tracking as usable. One-shot foreground location is a different capability and
may be selected only when separately approved and actually available.

## Validation and publication

Run the existing changed-file gate and TypeScript. Report source validation
separately from observed device behavior. Adding a JavaScript wrapper does not
prove a control works in the running binary.

The parent edit transaction owns screen changes, candidate publication,
Apply/Discard and unsaved-form protection. In Player, a successful source gate
is not a mounted-screen acknowledgement; the bridge/native association remains
the sole preview owner. Outside Player, preserve the existing owned
`dev:prototype` preview instead of starting the real `predev` schema workflow.
