# Screen Navigation Contracts

Applies in graph planning and spec expansion. Preserve the host's auth routes and map exact planned file ownership; do not infer screens from schema tables.

## Choose the navigation pattern

Choose from the approved jobs, destination hierarchy, frequency of switching, and phone
ergonomics after screen consolidation—not from total route count or the three preview frames.
Record the pattern, its reason, exact visible destination IDs, and secondary access paths in
the existing `### Navigation Pattern`; no separate navigation-planning artifact.

| Pattern | Use when | Keep out of top-level navigation |
|---|---|---|
| Stack | Work has one primary entry and proceeds through related steps/details | Every step is not a tab; keep Back and a known home/exit path |
| Tabs with child stacks | Users frequently switch among a small set of independent peer destinations | Detail/edit routes, filters, statuses, modal actions and callbacks |
| Drawer with child stacks | Genuine secondary destination groups or hierarchy need discoverable access | Do not put all generated routes in the drawer or hide the main task behind it |
| Tabs plus secondary menu | Frequent peers need visible tabs while occasional settings/admin work needs another access path | Do not duplicate every destination across both navigation surfaces |
| Contextual modal/sheet | A bounded action, picker or focused detour should return to its caller | A scan/report/create action is not automatically a permanent tab |

Do not force a minimum number of tabs or add a drawer merely because many nested routes exist.
When destinations overcrowd a phone bar, consolidate equivalent work first, then use an
explicit secondary menu/drawer only if the remaining task hierarchy calls for it.
Do not hide distinct frequent jobs simply to force stack-only navigation.

Keep Profile/sign-out reachable through a labeled account/header/menu entry; it needs a tab
only when frequent account work justifies one. A workspace/location selector changes context, not the
navigation pattern. Role-sensitive entries reflect real permitted work, not duplicated app
navigation for each role. Child stacks preserve the parent's scope, filters and return state.
Show a reachable menu control for drawers, clear labels/current-destination feedback, and
appropriate Back/dismiss behavior. Hide tabs during a focused task only with an explicit
return path. Adapt tablet chrome if useful without changing the approved destinations.

The intent preview and native layout use these same destination IDs and hierarchy. If a
different navigation pattern would improve the preview, return the proposed change to the
foreground graph gate before implementation; never silently invent more tabs or routes.

## Host routes

| Screen/infrastructure | Route | File |
|---|---|---|
| Splash/redirect | `/` | `app/index.tsx` |
| Login | `/login` | `app/login.tsx` |
| OAuth callback | `/oauth-callback` | `app/oauth-callback.tsx` |
| Authenticated layout | route infrastructure | `app/(app)/_layout.tsx` |
| Real authenticated entry | `/(app)/home` | `app/(app)/home.tsx` |
| Profile | `/(app)/profile` | `app/(app)/profile.tsx` |

Keep template auth/consent logic. Never move Home to `/(app)` or rename its file `index.tsx`; signed-in redirects target `/(app)/home`. This is a route constraint, not a dashboard requirement.

Profile is the single sign-out owner: visible `Sign out`, confirmation, `useAuth().signOut`, then `replace('/login')`. Make it reachable through the chosen navigation. Include real account/app context and useful requirement-backed settings, not fabricated team/territory sections. Do not make sign-out the Home task or repeat it on business screens.

## File and folder rules

- A top-level destination without children can be `app/(app)/<name>.tsx`.
- A destination with subroutes owns `app/(app)/<name>/index.tsx` and its children in that folder. Never combine flat `accounts.tsx` and a sibling `accounts/` destination: it can create phantom tabs.
- A detail with child workflows uses `<parent>/[id]/index.tsx`, `<parent>/[id]/<child>.tsx`, and the matching `_layout.tsx`. Never also emit `<parent>/[id].tsx`; duplicate `[id]` navigator entries collide.
- Navigation layouts remain infrastructure, not separate user-facing business screens. Foreground layout generation uses the Screen Map File and Presentation columns.
- Phone flows remain one-handed and safe-area aware. Tablet/larger layouts can adapt readable widths or master/detail where useful without pointer-only actions or losing the native workflow.

## Parameters and intent

For every destination, collect the **union of path/query params from all senders**. Include optional edit/context/resume params even when only one source supplies them. For example, a form reached with `parentId` by one action and `editId` by another needs both optional keys in its contract and typed params.

Never send secrets, entire records, or stale mutable payloads in navigation params. IDs locate records; generated services load authorized current data. Name defaults/validation for missing or invalid params.

| Source action | Intent |
|---|---|
| Existing singleton/root destination | `navigate` |
| Detail drill-down / child workflow | `push` |
| Auth/guard redirect or post-auth handoff | `replace` |

Intent belongs to the source action, not just a destination: Home may receive both an auth `replace` and a tab `navigate`. Repeat destination rows as necessary; their parameter unions remain identical. Per-screen `Navigation intent` must match.

For every write, specify:

1. Which service call/transaction constitutes commit, and what result is shown.
2. Where successful completion goes (remain with updated result, caller, or named destination).
3. How the caller refreshes (`useFocusEffect` unless an explicit alternative).
4. What happens on failure, cancellation, dirty back, and direct entry with no caller. Do not call `router.back()` blindly for notification/deep-link entry; name a safe fallback route.

Prevent duplicate pushes and duplicate submits; show pending labels while saving and preserve input on error. Form/edited-detail back includes Android hardware back guarding with `BackHandler` inside `useFocusEffect`, as well as header/gesture cancellation.

## Native navigation chrome

When a tab-root List needs search, prefer native iOS `headerLargeTitle` and `headerSearchBarOptions` with platform-appropriate Android behavior; do not layer a duplicate custom search/header above it. Do not add search because a table happens to exceed an arbitrary row threshold.

Use native date/time pickers for date fields; a calendar-management screen is a different task. Short filters/pickers can use a Sheet; content needing a full editing or navigation context may use a modal/stack route. Screen count does not determine presentation.

## Validation handoff

At plan time, check route/file uniqueness, all outgoing destinations, parameter union, source-action intent, success/return/recovery paths, and a reachable Profile. Visible tabs/drawer entries must match the approved destination IDs; directory layout alone does not make a route visible.

After `app/` is generated, the foreground/builder runs the existing `node scripts/check-routes.js` from the generated project root. Do not claim it ran during graph planning without generated files. Route lint alone does not prove service commits or interaction behavior.
