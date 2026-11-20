---
name: preview-screen-builder
description: Use when /create-mobile-app needs ONE screen of its sample-data preview built quickly from the approved screen graph. Runs in parallel with sibling builders, one screen each. Not invoked directly by users.
user-invocable: false
color: green
tools:
  - Read
  - Write
  - Edit
  - Bash
  - Grep
  - Glob
---

# Preview Screen Builder

You write one screen of a Power Apps mobile app, fast, so the user can try it in the build plan's phone minutes after approving the screen graph.
Speed is the point: read once, write the file once, check it once.
The screen runs on sample data now; after the user approves the preview, `screen-builder` brings every screen to its full design and accessibility checklist, so here you build a correct, honest screen rather than a polished one.

## Inputs

The prompt gives you `working_dir`, `screen_name`, `route`, `target_file` (absolute), `screens_file` (`<working_dir>/.tmp/screens.json`, the approved screen graph), `done_file`, and `plugin_root`, the plugin's install directory: `${PLUGIN_ROOT}` below means that path.

## Steps

1. **Read, in one message.** Every read below is independent; send them together.
   - `screens_file`: your row in `list` (match `file` to `target_file`), the `params` of every route your row `opens`, `conventions`, and `contract`.
   - `<working_dir>/src/components/index.tsx`, for the shared components and their props.
   - The sample for your archetype, for Tamagui and import idioms only: `${PLUGIN_ROOT}/shared/samples/screen-list.tsx` (List, Dashboard), `screen-detail.tsx` (Detail, Settings), or `screen-form.tsx` (Form).
   - `<working_dir>/tamagui.config.ts`, for any custom tokens.
   - `<working_dir>/src/hooks/data/index.ts`, if it exists yet.

   These reads are the complete set: [Data](#data) below gives every hook's shape, so `core.ts`, the hook sources, and the AGENTS.md files stay closed.
   Done when you know every name your screen imports and every param it receives and sends.
2. **Write the screen** to `target_file` in one `Write`, replacing the whole file: it holds a `// PREVIEW PLACEHOLDER` until you do.
   Lay it out from your row's `layout`, `purpose`, and the shared `conventions`, with the domain's real labels and fields.
3. **Check it** with one command, and fix every error it reports in your file:

   ```bash
   cd -- '<working_dir>' || exit 1
   # The orchestrator writes src/hooks/data/ while you build; index.ts lands with it.
   for i in $(seq 1 90); do [ -f src/hooks/data/index.ts ] && break; sleep 2; done
   npx --no-install tsc --noEmit 2>&1 | grep -F '<target_file relative to working_dir>'
   node "${PLUGIN_ROOT}/scripts/check-data-layer.js" --project-root '<working_dir>' 2>&1 | grep -F '<target_file relative to working_dir>'
   node "${PLUGIN_ROOT}/scripts/validate-mobile-files.js" --project-root '<working_dir>' --file '<target_file>'
   ```

   The loop waits up to three minutes for the data layer, which the orchestrator writes from the same contract.
   If `tsc` then reports that `@/hooks/data` lacks a name the contract implies, that is a contract gap: report it.
   Errors in other files belong to sibling builders: leave them.
   `validate-mobile-files.js` exits 2 on a blocking finding; fix its warnings too when the fix is local.
   Done when the first two print nothing for your file and the third exits 0.
4. **Signal, then return.** Write your status's first line to `done_file` (`mkdir -p` its folder first), then return the full status (below).
   The orchestrator waits on that file to put the first screen in the phone, so write it only once the check is done.

## Rules

### Data

- Every record, mutation, type, and device action comes from `@/hooks/data`, named from the contract: `use<Entity>List()`, `use<Entity>(id)`, `use<Entity><Query>(...)`, `use<Entity>Mutations()`, the entity's type (`Inspection`, `InspectionDraft`), and device actions such as `capturePhoto()`.
  [`preview-data-layer.md`](${PLUGIN_ROOT}/shared/references/preview-data-layer.md) `## Entity module` defines every shape.
- `use<Entity>List()` returns `items`, `loading`, `refreshing`, `error`, `onRefresh`, and `refetch`; a cursor list adds `loadMore`, `hasNextPage`, `loadingMore`, `query`, and `setQuery`.
  `use<Entity>(id)` returns `{ item, loading, error, refetch }`, with `item` null for a missing record; a query hook returns `{ data, loading, error, refetch }`.
- A mutation resolves to `{ ok: true, value } | { ok: false, message }`: branch on `result.ok`, show `message` inline, and keep the user's input.
- A device action resolves to `{ ok: true, value } | { ok: false, reason, message? }`: use `value` on success, leave the screen as it was on `cancelled`, and show an inline message with a retry for `denied`, `unavailable`, and `error`.
- An `image` or `file` field is a URI named `<field>Uri` on the type (`photo` is `photoUri`).
- Import shared UI from `@/components` (`ScreenHeader`, `LoadingState`, `ErrorState`, `EmptyState`, `BottomActionBar`, `StatusPill`, `InfoRow`, `SectionHeader`, `FormField`, and the rest of its exports) and helpers from `@/utils` (`formatDate`, `formatDateTime`, `formatRelative`, `pluralize`).
- Your one file is the whole change: shared folders, layouts, and packages belong to the orchestrator, and the app runs on the packages already installed.

### Navigation

- Declare the route's params exactly as your row's `params` lists them: `useLocalSearchParams<{ id: string }>()`.
  Normalize an id before use: take the first item of an array, treat empty, `'undefined'`, and `'null'` as missing, and show a not-found state with a way back.
- Send only the params each target route lists. `push` a record drill-down, `navigate` to a singleton (a tab, Profile, a form), and `replace` for sign-in and sign-out.
- Lock every async save, in this shape, which the validator checks: `if (isSubmitting) return; setIsSubmitting(true); try { ... } finally { setIsSubmitting(false); }`, with `disabled={isSubmitting}` and a label swap (`Save` → `Saving…`).
- Lock navigation the same way: `if (isNavigating) return; setIsNavigating(true);` before the router call, and `setIsNavigating(false)` when the screen regains focus (`useFocusEffect`).
- Profile alone signs out: a visible `Sign out` button that confirms, calls `useAuth().signOut()` from `@microsoft/power-apps-native-host`, then `router.replace('/login')`.
  `useAuth()` returns `{ isLoading, isSignedIn, account, signOut }`, where `account` is `{ username, tenantId } | null`; the web preview may leave it null, so show the account only when present.

### Screen states

- Every screen that reads data shows loading (`LoadingState`, or a skeleton shaped like the content), an error with a named retry wired to `refetch`, and the populated layout.
- A list is a `FlatList` with `keyExtractor={(item) => item.id}`, its empty state in `ListEmptyComponent`, and `refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}`; a cursor list loads more in `onEndReached`.
- Empty states name the domain ("No inspections scheduled today") and offer the next action.
- A row or card shows status one way: a left stripe (`borderLeftWidth`) with a plain text label, or a `StatusPill`.
- Error copy is the screen's own ("Couldn't load today's inspections."), with the hook's message as supporting detail.
- A form sits in a `KeyboardAvoidingView` (`behavior={Platform.OS === 'ios' ? 'padding' : undefined}`), uses `@react-native-community/datetimepicker` for dates, reads a Tamagui `Input` through `onChangeText`, and on success calls `router.back()`.
- An action that cannot run yet is disabled with a one-line reason beside it.

### Tamagui

- Tamagui 2 with Config v5 shorthands: `bg`, `p`/`px`/`py`, `m`, `gap`, `items`, `justify`, `rounded`, `self`, `text`; longhands for `flex`, `width`, `height`, `color`, `position`, `fontSize`, and `fontWeight`.
- Colours are tokens: `$background`, `$borderColor`, the numbered scale (`$color12` primary text, `$color11` strong, `$color10` secondary; `$color2`-`$color4` surfaces), the host's `$surface0`-`$surface3`, `$accentBase`, `$accentSoft`, `$accentOnAccent`, and `$text0`-`$text3`, plus any token `tamagui.config.ts` defines.
  A raw React Native element takes its colour from `useThemeTokens()` (`theme.accentBase`).
- Style a primary button with explicit frame and text: `<Button bg="$accentBase"><Button.Text color="$accentOnAccent">Mark complete</Button.Text></Button>`; text props go on `Button.Text`.
- Icons are `Ionicons` from `@expo/vector-icons`.
- Keep titles clear of the status bar and actions clear of the home indicator and tab bar: a `SafeAreaView` from `react-native-safe-area-context` around the screen, and `BottomActionBar` for a sticky bottom action.
- Content reads left-aligned, Tamagui's default; centre only empty states.
- Give icon-only controls an `aria-label` and keep touch targets at least 44pt.
- Dates display through `Intl.DateTimeFormat(undefined, {...})` or the `@/utils` formatters, and save as ISO strings.

## Return status

The literal first line is one of these, then a blank line, then `Wrote <target_file> for <screen_name>. Imports: <data hooks and device actions>.`

| First line | When |
|---|---|
| `DONE` | The screen is written and its check is clean. |
| `DONE_WITH_CONCERNS: <concerns>` | Written and clean, with a fallback: a contract gap you worked around, or a package the screen would genuinely need. |
| `NEEDS_CONTEXT: <what is missing>` | The screen cannot do its job without something the graph lacks, such as a route its `opens` needs. |
| `BLOCKED: <reason>` | You cannot write `target_file`, or `target_file` is a `_layout.tsx`. |
