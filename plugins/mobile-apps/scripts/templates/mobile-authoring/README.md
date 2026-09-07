# Source-bound mobile authoring runtime

These app-owned files are emitted by `configure-mobile-authoring.js`. The local
`.tmp/authoring-registry.json` and compiled screen pack are source authority;
`registry.ts` is its device-safe projection, without local `sourceFile` paths.
Do not manually edit compiler-owned output: regeneration rejects drift.

For the prototype workflow, `configure-prototype-authoring.js` is the
higher-level installer. It accepts explicit screen/source assignments and
checks them against compiled routes,
reads each screen's explicit exported literal `authoringTargets` array, writes
the registry, installs these helpers, adds `@/authoring` aliases, and wraps the
current root before any data consumers run. It is invoked after skeletons and
again after each completed wave, with `--ready-screen` for those actual IDs.
Ready screens must supply the export; skeletons may have empty target metadata.
The export is source authority, while the shared registry is its deterministic
projection. This is not screen-structure inference or a second fixture source.

## Root integration — required before publishing a Player prototype

The app generator owns the existing root and providers. Wrap the no-environment
startup seam **outside** `PrototypeProvider`, so repository hooks and its data
subscription cannot execute before configuration:

```tsx
import { Slot } from 'expo-router';
import { AuthoringProvider } from '../src/authoring';
import { configureDataPreview } from '../src/data/runtime';
import { PrototypeProvider } from '../src/data/PrototypeProvider';

export default function RootLayout() {
  return (
    <AuthoringProvider configureDataPreview={configureDataPreview}>
      <PrototypeProvider><Slot /></PrototypeProvider>
    </AuthoringProvider>
  );
}
```

For connected apps, use the existing app-owned `configureDataPreview` and
provider tree; do not recreate authentication or generated services. The
authoring provider is still the outer initialization gate. Native absence does
not change ordinary/connected defaults or grant writes.

The generator creates an **inactive** reserved descriptor only when none exists.
Only the publisher replaces `.devplayer-builder/runtime.json` with the exact
app/job/revision, preview kind, data namespace and optional base namespace.
There are no credentials in that file. An active native builder with a missing
or mismatched publisher stamp is blocked before repository consumers render.
The helper checks native `getCurrentSession`, `getDiagnostics().authoring.authenticated`,
and capabilities; a persisted last-builder association alone cannot enable it.
A full publisher stamp, including a candidate stamp, never falls through to
ordinary local defaults when native support or the active authenticated
association is absent. That preview remains blocked before data consumers
render. Only the explicit inactive descriptor follows ordinary standalone
initialization.

The publisher keeps active namespace stable across publications and candidate
namespace stable within the same logical candidate/job. A namespace change
requires a full preview reload. This helper does not apply, approve, migrate,
copy rows to a backend, or issue maker decisions.

## Screens and explicitly registered targets

```tsx
import { ScrollView, Text } from 'react-native';
import { AuthoringScreen, AuthoringTarget, useAuthoringRemeasure } from '../../src/authoring';

function Contents() {
  const remeasure = useAuthoringRemeasure();
  return (
    <ScrollView onScroll={remeasure} onScrollBeginDrag={remeasure}
      onScrollEndDrag={remeasure} onMomentumScrollEnd={remeasure} scrollEventThrottle={16}>
      <AuthoringTarget targetId="orders-list">
        <Text>Existing real app content goes here</Text>
      </AuthoringTarget>
    </ScrollView>
  );
}
// isUsable and isDirty come from the real screen's data/form state.
export function Orders({ isUsable, isDirty }: { isUsable: boolean; isDirty: boolean }) {
  return <AuthoringScreen screenId="orders" ready={isUsable}
    hasUnsavedChanges={isDirty} style={{ flex: 1 }}><Contents /></AuthoringScreen>;
}
```

IDs must already exist in the registry. Labels, roles and action IDs come from
that explicit metadata, never React internals or pixels. One target ID may have
only one mounted instance per screen; wrap a collection rather than reusing one
ID for every row. For a record target, `recordRef` accepts only
`{conceptId,recordId,label?}`; `conceptId` is the explicit persistence binding.
Never pass a whole record, photo, URI, local path, or token.

`ready` is required and must mean the actual usable screen, not a root, skeleton
or timer. Focus plus positive layout plus `ready` leads to raw native
`registerAuthoringContext(context, targets)` followed by
`reportAuthoringReady({protocolVersion:2,appInstanceId,jobId,previewRevision,screenId})`.
The originating published job ID is preserved. Failed/unavailable registration
or ACK is shown explicitly and never becomes an acknowledged state.

Hook-only integration is also supported:

- `useAuthoringScreen(screenId, {ready,hasUnsavedChanges?})` returns
  `{onLayout,onScroll,remeasure,...}`. Attach `onLayout` to the screen's actual
  root view, scroll handlers to real scroll containers, and pass this handle as
  `screen` to standalone targets/hooks.
- `useAuthoringTarget(targetId, {screen?,recordRef?})` returns `{ref,onLayout}`.
  Attach both to a real native `View` with `collapsable={false}`.
- `useAuthoringRemeasure()` remeasures the nearest `AuthoringScreen`.
- `useAuthoringStatus()` exposes only safe state/error text and the last
  acknowledged screen ID.

Bounds use `measureInWindow` logical points. Focus, unmount, scroll, orientation,
foreground return and target layout invalidate stale measurements. A late
cleanup or measurement cannot clear/replace a newer screen lease. Native
selection itself remains native-owned. Registered unsaved state blocks native
preview updates. General app chat remains available when targeting metadata is
absent; no targets or source paths are invented.

## Installation and verification

Run the plugin's `configure-mobile-authoring.js --project-root <app>` after the
generator has emitted real screen TSX, compiled packs and the local registry.
`--check` verifies deterministic output and ownership without writing.
Its success means helper files were generated/verified, **not** that root
wiring, publishing, binary support or a device mount was verified.

The generator must perform root wrapping and screen instrumentation, then run
the existing TypeScript/source gates before publishing. Native authoring APIs
require a rebuilt compatible Player. Ordinary standalone apps without that
module remain non-authoring; their existing data defaults are not overridden.

`configure-prototype-authoring.js --check` additionally verifies the current
root, aliases, and metadata projection. It still does not claim usable screen
state, binary capability evidence, publication, or a native mount. Actual
readiness remains the screen's explicit state plus layout/focus and native ACK.
