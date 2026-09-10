# Phase 8 of 10 — Screen shell

**Steps:** 10b–10.8. **Previous:** [7 — Integrations](phase-07-integrations.md). **Next:** [9 — Implementation](phase-09-build.md).
[Phase index](../SKILL.md#load-only-the-active-phase). Advance only after this phase's exit condition passes.

Load only after data/native/dependency/connector work. Foreground owns shared code and layouts;
builders own assigned route files. Do not let several builders race on the same shared file.

### Step 10b — Wire navigation layout

**Telemetry checkpoint: `wire_app_navigation`**

Use the approved Screen Map **File** column, not screen-name-derived paths.
Keep auth guards and all unrelated root layout logic intact.
Read the selected [navigation pattern](${PLUGIN_ROOT}/shared/references/screen-planning/navigation-contracts.md#choose-the-navigation-pattern)
and its explicit visible destination IDs; do not choose tabs/drawer from route count.

## 10b.1 — Compute structure and reject invalid routes

Classify `app/(app)/<name>.tsx` as a flat route, `<folder>/index.tsx` as a folder root,
and other files inside that folder as stack children. Only approved visible destination IDs
become Tabs/Drawer entries; a flat route or folder root is not automatically a menu item.
Child detail/modal/form routes and account routes reached from a header stay out of primary chrome.
Folders with children need an index row; otherwise return
`BLOCKED: folder has children but no index.tsx row in the Screen Map`.

Normalize routes by stripping `.tsx`, collapsing trailing `/index`, preserving dynamic segments.
Block duplicate normalized routes and `[id].tsx` together with `[id]/<child>.tsx`.
For a dynamic detail with children use `[id]/index.tsx` plus a nested layout.
Missing File column is a planning block; never guess flat fallback paths.

## 10b.2 — Inner stacks

Foreground creates required route folders and inner `_layout.tsx` before builders.
Use `Stack` from `expo-router`, required `Stack.Screen name="index"`, child names matching paths,
and the Screen Map presentation (`modal`/`formSheet`; omit for default).
Use `headerShown: false` when routes own headers. Dynamic child stacks get their own `[id]/_layout.tsx`.
Stack-only navigation still needs these nested contracts; don't skip folder validation.

## 10b.3 — Outer layout

For stack-only use `Stack`; for Tabs/Tabs+Stack use `Tabs` from `expo-router`; for Drawer use `Drawer` from
`expo-router/drawer`. Read the relevant existing
[layout sample](${PLUGIN_ROOT}/shared/samples/_layout.tsx) or
[drawer sample](${PLUGIN_ROOT}/shared/samples/_layout-drawer.tsx) for API shape only.
Do not paste over auth/provider logic. Add only required imports and change the navigator return.
Use `useThemeTokens()` semantic colors and appropriate Ionicons icons for actual destinations.
Drawer needs a reachable hamburger/header; hide non-destination template routes rather than
allowing auto-registration to expose phantom tabs. Preserve approved visibility/presentation.
For tabs plus a secondary menu, keep primary destinations in tabs and only explicitly approved
secondary destinations in the menu; do not introduce a drawer dependency for a simple account menu.
The navigation/skeleton gate below covers the combined edits; no per-edit full-app typecheck loop.

### Step 10.7 — Snapshot generated services into the plan

Inspect `src/generated/services/` **once in foreground**; read actual exported class names,
methods and relevant model types/signatures. Do not infer pluralization from filenames or table labels.
Refresh `## Generated Services (snapshot at <ISO timestamp>)` after Screens:

```markdown
| Service | Path | Methods present |
|---|---|---|
| `<actual export>` | `src/generated/services/<actual file>.ts` | `<actual methods>` |
```

Use exact paths/exports in all builder prompts. If a required service/method is absent, STOP
and route to its owning data-source skill or foreground scope revision. No expected import
plus TODO, invented method, placeholder hook or mock data to hide an incomplete approved capability.
For genuine no-data apps, the empty table explicitly says no generated services are required.
Refresh this snapshot after any regeneration/alias correction; never edit generated source by hand.
Resolve every generation-pending entry in `### Information and interaction coverage` against
these actual methods, fields, lookup bindings and upload/download signatures. A missing required
operation is not a reason to drop UI content or insert a fixture. Carry resolved coverage into
the relevant skeleton and builder context before the navigation/skeleton gate can pass.
If a resumed plan predates coverage, run the same focused plan audit and owning approval rather
than treating generated files as proof of complete screen support.

### Step 10.8 — Generate app-specific shared code + screen skeletons

**Telemetry checkpoint: `generate_shared_code_and_screen_skeletons`**

## 10.8a — Shared code

Read compact specs and existing shared exports. Generate shared entity rows/cards only when
several screens need the same representation; shared choice maps/formatters/hooks only for
actual repeated behavior. Reuse existing helpers; don't overwrite copied/user implementations.
Caller owns `src/components`, `src/hooks`, `src/utils`, exports and constants before fan-out.

Apply [component choice and creation](${PLUGIN_ROOT}/shared/references/design-planning.md#component-choice-and-creation):
AI may generate better-fitting task-specific UI rather than force a sample layout. Screen-local
components may live in their assigned screen; foreground creates/adapts reusable components and
their typed exports. Reuse existing behavior helpers and preserve user customizations.

Materialize the accepted task-specific recipes from brand `## Components` here, not after
parallel builders independently recreate them. For reused treatments supply an actual component
path/export, typed view data and callbacks, state handling, and complete typography/icon/media
props. Check populated, long-content and error states within a consuming screen; an interface
or empty component is not a completed handoff. Missing shared presentation returns to foreground
instead of being replaced with generic cards. Keep one-screen treatments local.

Use current helpers as the API authority:
[hooks](${PLUGIN_ROOT}/shared/samples/src/hooks/index.ts),
[components](${PLUGIN_ROOT}/shared/samples/src/components/index.tsx),
[utils](${PLUGIN_ROOT}/shared/samples/src/utils/index.ts).
Load only the concrete helper/sample needed, not the entire sample tree.
When approved typography roles are present, reuse the Step 9b `nativeTypography.text` tuples
through `TypographyText` or complete `Text` prop spreads in shared and screen primitives.
Prepare the actual helper/token exports before builders. Family/size-only calls do not
preserve the approved weight, line height and tracking; follow the canonical integration.
If a screen needs larger Dataverse images, prepare the focused
[image reader and query contract](${PLUGIN_ROOT}/shared/references/media-sources.md#dataverse-image-resolution)
with the actual generated download signature before builders; do not enlarge record thumbnails.

## 10.8b — Typed screen shell

For each screen to build, use its exact File path. Preserve existing starter/route code rather
than overwriting it with `return null`; mark `skeleton_exists` accurately for that builder.
A starter route assigned substantive app work still needs the builder; don't skip it merely
because the template already contains the file.
New skeletons contain actual resolved imports, typed route params, planned hooks and an empty
JSX return. They must compile; remove/avoid unused scaffolding that fails the project's compiler.
Skeleton imports/hook calls are the implementation handoff, not a duplicate per-screen import
catalog appended to the plan.

| Spec | Skeleton contract / API reference |
|---|---|
| Cursor/unbounded list | `useCursorListData` or approved infinite-query/domain hook; server-side search/filter, stable order with key tie-breaker, select rendered fields, opaque skipToken, first-load/refresh/load-more/retry state. Never top:50 plus local search masquerading as a complete result set. |
| Bounded list | `useListData`; `useSearchFilter` only over explicitly bounded loaded rows. Reference [screen-list.tsx](${PLUGIN_ROOT}/shared/samples/screen-list.tsx). |
| Detail | Typed id, actual service.get, loading/error/missing/retry/stale-result handling; reference [screen-detail.tsx](${PLUGIN_ROOT}/shared/samples/screen-detail.tsx), not an inline uncaught promise. |
| Form | Approved fields, validation, lookup/payload types and save lifecycle; reference [screen-form.tsx](${PLUGIN_ROOT}/shared/samples/screen-form.tsx). No fake successful submit. |
| Profile | App-specific Profile content plus the single confirmed sign-out owner; never sign-out-only filler. |

Profile uses actual `useAuth()` fields (`isLoading`, `isAuthReady`, `isSignedIn`, `error`,
`acquireToken`, `signIn`, `signOut`), never nonexistent `user`/`account`/`profile`/`claims`.
Resolve identity via a supported approved data path; do not invent claim access.
Keep a `handleSignOut` confirmation helper and one visible button wired to it on Profile only.
Call host `signOut`; preserve auth-guard routing to `/login` and show failures rather than
pretending logout succeeded. Other screens must not receive duplicate sign-out code.

Samples are API/error-state references, **not layouts to copy**. Derive composition from the
approved compact screen spec, actual journey, shared conventions and brand design rules.
Do not add duplicate Standard Imports documentation now.

## 10.8d — Navigation/skeleton TypeScript gate

```bash
npx tsc --noEmit
```

Run after layouts, service snapshot and shared/skeleton writes. On failure capture once and
batch-fix route names, exports, imports, signatures and shared code before rerunning.
No Step 11 builders launch until the entire navigation/skeleton gate is clean.
