# Screen graph

How `/create-mobile-app` Step 4 drafts the screen graph itself, in one pass, from the brief and the setup answers.
The graph is the app's screens, how the user moves between them, and the data each one shows.
The user approves it at the screen graph gate, `preview-screen-builder` builds every screen from it, and Phase B derives the data model from its Data Contract.

## Steps

1. **Draft.** Write `<working_dir>/.tmp/screens.json` once, with the `Write` tool, in the shape below.
   Done when every feature in the brief has a screen or a control that delivers it.
2. **Check and render.** Run `render-screen-graph.js` ([`screens-first.md`](screens-first.md) Step 4 gives the command).
   It checks routes, params, and the Data Contract, then writes the plan's `## Screens` section.
   On `status: "blocked"`, fix every listed problem in one edit and rerun.
   Done when it prints `status: "ok"`; address any `warnings` it names.

## The JSON

```json
{
  "navigation": "Stack",
  "pattern": "Today is the landing screen; a row opens the inspection, and Profile opens from Today's header.",
  "list": [
    { "name": "Login", "route": "/login", "file": "app/login.tsx", "source": "template (keep)",
      "purpose": "Microsoft sign-in", "data": "—", "capabilities": [] },
    { "name": "Today", "route": "/(app)/home", "file": "app/(app)/home.tsx", "presentation": "default",
      "source": "replace template", "archetype": "List",
      "purpose": "Today's inspections and what is left to do",
      "layout": "Date header with a Profile link; a 'Next to complete' card; Remaining and Complete tiles; today's rows with site, title, time, and a labelled status. Bottom CTA 'Open next inspection'. Empty: 'No inspections scheduled today' with a refresh action.",
      "data": "useInspectionList(), useInspectionTodaySummary(today)", "capabilities": [], "params": [],
      "opens": [{ "to": "/(app)/inspection", "params": ["id"], "intent": "push", "from": "Inspection row" },
                { "to": "/(app)/profile", "intent": "navigate", "from": "Profile link" }] }
  ],
  "conventions": ["List rows: status-stripe-card with a text status label.", "Tone: professional and direct."],
  "contract": {
    "entities": [{ "name": "Inspection", "purpose": "One scheduled site inspection.",
      "fields": ["title: string", "siteName: string", "scheduledFor: datetime", "status: 'scheduled' | 'complete'", "photo?: image"],
      "operations": ["list (cursor; order: scheduledFor asc)", "get", "update"],
      "queries": ["`todaySummary(today)` → `{ remaining: number; complete: number }` (Today)"],
      "sampleRecords": 12, "sampleNotes": "Eight scheduled and four complete, dated today." }],
    "deviceActions": ["`capturePhoto()` → `{ uri: string }` - Inspection detail \"Take photo\"; capability: camera"]
  }
}
```

### Screens (`list`)

- Keep the template's routes as rows with `"source": "template (keep)"`: `app/index.tsx` (`/`), `app/login.tsx` (`/login`), and `app/oauth-callback.tsx` (`/oauth-callback`).
  They need only `name`, `route`, `file`, `source`, `purpose`, `data`, and `capabilities`.
- The landing screen is `app/(app)/home.tsx` (`/(app)/home`) with `"source": "replace template"`: the root index opens it after sign-in, and it is the first screen the phone shows.
- Every app has a Profile screen at `app/(app)/profile.tsx` that owns the only sign-out.
- `archetype` is one of `List`, `Detail`, `Form`, `Dashboard`, `Settings`, `Auth`, or `Empty`.
- `layout` is what the builder works from, so write it as a brief: the sections top to bottom, the primary action and where it sits, and the empty-state copy with its action.
  Two to four sentences; name real labels and fields.
- `data` lists the data-layer calls the screen makes, named from the contract: `use<Entity>List()`, `use<Entity>(id)`, `use<Entity><Query>(...)`, `use<Entity>Mutations().<operation>`, and device actions such as `capturePhoto()`. Profile uses `useAuth()` from the template.
- `capabilities` names the native capability behind each device action the screen calls (`camera`, `location`, `barcode`, `documents`, `haptics`, `pen`, `pdf`).
- `presentation` is `default`, `modal`, or `formSheet`.
- Build the screens the brief asks for and no more: three to six is typical.
  Hosting an action inline (attach a photo on the detail screen) beats a screen of its own.

### Routes and navigation

- `navigation` is `Stack` (up to about three screens, or one main flow), `Tabs + Stack` (three to five peer areas), or `Drawer` (many areas, rarely right on a phone).
  With tabs, each top-level file or folder under `app/(app)/` is a tab.
- A folder under `app/(app)/` needs an `index.tsx`. Put an entity's list at `app/(app)/<entities>/index.tsx` and its detail at `app/(app)/<entities>/[id].tsx`; a detail that owns child screens moves to `[id]/index.tsx`.
  A flat detail (`app/(app)/inspection.tsx` with an `id` param) suits a Stack with one entity.
- `params` lists everything the route receives, typed `string`: `id: string` for a record, `editId?: string` for a create-or-edit form.
- `opens` lists each navigation the screen starts: `to` (a route in the graph), the `params` it sends, `from` (the control's label), and `intent`.
  Intent is `push` for a record drill-down, `navigate` for a singleton destination (a tab, Profile, a form), and `replace` for sign-in and sign-out handoffs.
  A sender passes only params the target lists; the renderer rejects any other.

### Shared conventions (`conventions`)

Short lines every builder applies the same way: the list row style, the detail hero, the tone, density, and any field-use ergonomics (larger targets and text for gloved or outdoor use).
The design system replaces visual defaults later, so name patterns rather than colours.

### Data Contract (`contract`)

The app's data in its own words, as [`preview-data-layer.md`](${PLUGIN_ROOT}/shared/references/preview-data-layer.md) `## Data Contract` defines it; that section is the source of truth for field types, operations, and queries.
It names no table, column, connector, or service: the data model gate maps it to those after the preview.

- Entities are PascalCase; fields are `name: type` in camelCase, `?` for optional. Every entity has an implicit `id`.
- An `image` or `file` field reaches screens as a URI named `<field>Uri` (`photo` becomes `photoUri`).
- List an operation only when a screen uses it; give each query the screen that uses it.
- `sampleRecords` is enough to scroll: about 12 for a cursor list, 6 for a short bounded one. `sampleNotes` says which statuses and edge cases the samples must cover.
- Each device action names its result, the screen and control that trigger it, and its capability.
- Connectivity is context, never an entity or screen: apply [`connectivity-intent-ownership.md`](${PLUGIN_ROOT}/shared/references/connectivity-intent-ownership.md) and add no offline or sync data unless the brief asks for that feature.

## Before the gate

The graph is complete when each of these holds; the renderer checks the mechanical ones, and you check the rest:

- Every brief feature is a screen, a control on one, or a contract operation a screen calls.
- The primary entity has a list and a detail, and every operation in the contract has a screen that calls it.
- Every `opens` target exists, and every route declares the params its senders pass.
- Every device action is called by the screen its line names, and that screen lists the capability.
