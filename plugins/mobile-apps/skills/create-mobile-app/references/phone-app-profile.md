# Phone app profile

This is a mode of the existing creation skill, not another planner. The user is
building a working **app**. Say app, build, update and sample data in Player;
do not label it a prototype, mockup or toy. Be accurate about local/sample data
versus a real connection. Internal protocol and runtime names remain unchanged.

## Entry and question ownership

Use the exact wrapper supplied in the VS Code request for every plugin script,
including scripts invoked by nested skills. Read
[the shared transport](../../../shared/references/mobile-authoring.md), then
run `scripts/mobile-authoring.js verify` through that wrapper. Require the
verified Player app/job/attempt identity. An invalid or missing phone context
is not permission to ask product questions on the desktop or invent a callback.
Standalone environment-first creation remains the normal create skill.

The maker's **Plan my app** submission authorizes bounded planning artifacts,
not app implementation, remote schema changes or data writes. Reuse the prompt
and app name; ask only unresolved questions that change the first useful
journey. All product decisions return to Player. VS Code's own desktop/tool
permissions remain enabled and are not product approval.

Inspect the supplied installed template with `prepare-prototype.js --check-template`.
Do not clone another template, change dependency versions, initialize Power Apps,
resolve an environment, request a client registration, or generate services now.
Retain the bridge-provided app identity rather than deriving one from a URL.
Use `bind-prototype-identity.js --project-root <root>` to verify that existing
identity. The bridge already supplies it; an identity mismatch is a stop, not
permission to replace the app.

## Same phases, smaller first delivery

| Create phase | Phone profile |
|---|---|
| [Intake](phase-01-intake.md) | Confirm the requested job and first useful outcome, without environment or registration discovery |
| Planning | Use the main experience/information-needs guidance, logical model, selected capabilities and an initial 2-3-screen journey |
| Scaffold | Prepare the existing template with the real local repository/provider generator after app-plan approval |
| Design | Materialize main's task-specific brand, typography, media and shared components; no HTML companion |
| Authentication | No new client-registration wizard; the local first app has no live-data auth dependency |
| Data | Generate typed persistent local repositories and canonical sample records, never fake `src/generated` services |
| Integrations | Implement approved, shipped native capabilities; keep real connector/data setup as an explicit later operation |
| Screen shell | Use explicit main Screen Map file paths and verified local repository interfaces |
| Implementation | Build the small ready wave with the main screen-builder contract and quality guidance |
| Launch | The bridge validates and publishes the native app; no independent Metro or HTML preview |

Emit concise real milestones such as Planning your app, Building Workshop
details and Checking your app. Do not stream internal phase bookkeeping or
invent progress percentages.

## Plan the first complete journey

Follow [main planning](phase-02-planning.md)'s experience synthesis before
choosing fields or routes. Preserve the original requirements in
`native-app-plan.md`. Keep its `App Requirements`, `Data Model`,
`Native Capabilities`, `Connectors`, `Screens` and design sections.

Select **2-3 working screens**, not 2-3 placeholders. A detail/form sheet or
state on the same task can avoid another route. Choose the smallest complete
journey with a real outcome. Capture additional requested screens under
`## Deferred screens`; do not silently drop them or expose dead navigation.
Native/connector needs still appear in the plan. If the user requires real
connector data immediately, explain the staged first app and obtain explicit
acceptance rather than presenting sample results as live integration.

For a local-only brief with no requested native capability or live connector,
record **None** directly in this combined plan. Do not dispatch a separate
worker or write a separate proposal just to reconfirm that absence. If an
actual capability, data source or unresolved trade-off affects the journey,
use its normal bounded owner. In attended VS Code, prefer the exact
workspace-scoped `phone-*` adapters advertised in the request; they reference
the same pinned agents with usable host tools.

The foreground proposes the logical model without Dataverse names/discovery.
Use stable entity/field/action IDs and the existing domain schema:
`.tmp/prototype-domain.json` against `scripts/schema-prototype-domain.json`.
Use the app ID from the verified descriptor. Keep one sample-data authority in
`.tmp/scenario-facts.json` (`contractType: "scenario-facts"`, `records`,
`mediaAssets`); records use explicit `conceptId`, stable `id` and `fields`.
Concept IDs are the deterministic `conceptId(entity.id)` projection, not labels.
Start `.tmp/prototype-rules.json` with `{ "schemaVersion": 1, "rules": [] }`.
Use [sample image guidance](../../../shared/references/prototype-images.md)
for fixed licensed assets, provenance and real loading/error handling.

Write `.tmp/phone-app-plan.json` as the execution projection of the same
approved main Screen Map, never as a second product brief:

```json
{
  "schemaVersion": 1,
  "entryRoute": "/items",
  "screens": [
    {
      "screenId": "items",
      "title": "Items",
      "route": "/items",
      "sourceFile": "app/(app)/items/index.tsx",
      "dependencies": [],
      "entityIds": ["Item"],
      "primaryActions": ["Open an item"],
      "secondaryActions": [],
      "dataAssumptions": ["Read the approved Item repository"]
    },
    {
      "screenId": "item-detail",
      "title": "Item details",
      "route": "/items/[id]",
      "sourceFile": "app/(app)/items/[id].tsx",
      "dependencies": ["items"],
      "entityIds": ["Item"],
      "primaryActions": ["Save the item"],
      "secondaryActions": ["Return to items"],
      "dataAssumptions": ["Load by the typed route ID and preserve save validation"]
    }
  ],
  "deferredScreens": [],
  "navigation": { "pattern": "stack", "destinations": [] },
  "nativeCapabilities": [],
  "deferredConnectors": []
}
```

Use the actual app concepts, not this example's product or layout. For tabs or
drawer, declare `pattern` as `tabs-plus-stacks` or `drawer`; each destination is
`{screenId,label,iconName}`. Detail routes are not primary destinations.
Each deferred screen is `{screenId,title,purpose}`. Native selections are
`{id,displayName,persistenceConsequence}` from the verified template catalogue.
`deferredConnectors` describes the requested later connections, not live services.
Explicit action/data assumptions preserve the behavior of later visual edits.

Run `compile-phone-app-plan.js --project-root <root>` to normalize the proposed
facts and derive the compatibility persistence/navigation/screen artifacts.
It writes planning artifacts only and does **not** approve native selections.
It does not reinstate the older Product Experience/Scope/Journey questionnaire.
In the active Player job it reports that same screen list before asking
approval, so the bridge approves the actual build plan rather than an empty
screen list. A changed plan must be reported and approved again.

## One app-plan review before app writes

Show the intended first outcome, logical model and relationships, selected
native capabilities (or None), connector staging (or None), the first screens,
deferred screens and design direction in one readable Player plan. Resolve
material choices before asking approval; do not bundle an unresolved choice
into a yes/no approval.

Use a `kind: "plan"`, `gateId: "phone-app-plan"` question with no fields and
the shared `request-question` command. Bind **all** proposal inputs:

- `native-app-plan.md`
- `.tmp/phone-app-plan.json`
- `.tmp/prototype-domain.json`
- `.tmp/scenario-facts.json`
- `.tmp/prototype-rules.json`

Use repeated `--bind` arguments, not `--record-gate`. Read the returned decision.
Reject/revise returns to planning without app writes. On approval run
`compile-phone-app-plan.js --project-root <root> --receipt <returned-receipt>`.
That command verifies the live signed decision before activating the selected
capabilities in the derived artifacts. Derived files are not new approvals.
Do not change the bound proposal inputs after acceptance; reapprove if needed.
Keep execution notes and materialized design details in `memory-bank.md` and
the brand files instead of restamping the approved human plan during this build.

## Build with the main UX guidance

Run `prepare-prototype.js` with the approved display name, slug and static
entry route. It owns the precise local provider and repository setup. Do not
write `power.config.json`, `src/generated`, a fake environment or a new auth
registration. Use the generated `src/data` interfaces and data-access registry.
Writes and bookings must persist after reopening; local data is not a
screen-owned array or an error fallback.

For approved record-backed sample photos, run through the same Player wrapper:

```bash
node "${PLUGIN_ROOT}/scripts/materialize-prototype-images.js" \
  --project-root "<working_dir>" --receipt "<returned-plan-receipt>"
node "${PLUGIN_ROOT}/scripts/generate-prototype.js" --project-root "<working_dir>"
```

The materializer downloads the exact licensed canonical assets once into
`assets/sample-media/`; generation projects their verified bindings into
`src/data/sample-images.ts`. No record, photo reference or approved plan byte
is changed. Use suitably sized fixed source images, not multi-megapixel originals
for small list rows. A failed download remains a visible blocker for promised
bundled imagery: correct/reapprove the source or use an explicitly approved
remote-only delivery, never fabricate a local image or bypass network policy.
This is a build-time desktop download, not app-owned business-data HTTP.
In an isolated host without public image access, use its permitted trusted
desktop workflow; do not weaken isolation or forward callback credentials.

Follow main's [design phase](phase-04-design.md), design planning and Tamagui
integration for hierarchy, typography tuples, content density, useful media
proportions and shared recipes. `MOBILE_APP_HTML_COMPANIONS=0` skips only HTML
companions and browser review, **not design work or screen quality**. Preserve
explicit user styling. The first rendered review happens on the native app.
The generated local provider already imports the real `tamagui.config.ts`;
apply brand changes there without rewriting generator-owned provider files.
Use Tamagui's theme context and the actual local data hooks. Do not introduce
host-only auth/theme hooks that require a connected `PowerAppsProvider`.

Use the [main screen-shell](phase-08-screens.md) and
[implementation](phase-09-build.md) contracts. Substitute the actual
`@/data` repository/model/hook interfaces for the generated-service snapshot.
Do not start Dataverse work to satisfy that snapshot. Build shared components
first, then dispatch only the initial assigned screens with bounded context.
Keep the main agent's useful composition, full state handling and media guidance.
Do not copy generic list/detail layouts merely because those are the route types.

### Authoring-ready shell before screen implementation

After the typed source files and local data provider exist, run the existing
`configure-prototype-authoring.js --project-root "<working_dir>"` through the
Player wrapper with every explicit `--screen-source "screenId=app/path.tsx"`.
At this stage pass **no `--ready-screen` and no `--wire-screen`**. This prepares
the runtime, root provider, import aliases and planned registry without
claiming a usable screen or rewriting its UI.

Use the returned `screenSources` and `authoringContract` as the compact
handoff, alongside the actual repository types, shared component signatures,
supported theme tokens and relevant approved screen spec. Read the
[phone screen binding contract](../../../agents/references/screen-builder/phone.md)
once before the wave. Do not make builders discover these APIs by reading
generator or validator implementation files.

Each screen starts within the correct `AuthoringScreen` boundary. Its
readiness/dirty expressions, mounted targets and scroll notifications are
part of normal implementation, not decoration added after the quality sweep.
Do not hardcode successful readiness or silently drop Select/Teach support.
Use the real registered host workers, with one file per builder; the main
foreground still owns shared code and all approvals.

Batch deterministic commands at their existing gate with `&&` so failures
stop the sequence. Emit each started checkpoint **before** its actual work,
not after the screens are built, and completed only after that gate passes.
Do not rerun unchanged whole-project checks between microscopic edits.

Use the existing native owner for each approved shipped capability and its
[local-data rules](../../add-native/references/prototype-mode.md). No package
upgrade, new native build or automatic connector initialization is authorized.
Every nested question and script still uses the same Player wrapper.

Each screen supplies literal `authoringTargets` for useful selectable regions
and real usable/dirty state from the prepared shell. Foreground reruns the
authoring configurator with the complete screen/source assignments after a
finished wave; this verifies those bindings rather than discovering them late.
Use repeated `--screen-source "screenId=app/(app)/path.tsx"` and
`--ready-screen <screenId>` arguments. Use `--wire-screen <screenId>` only for
the actual completed screens needing the existing AST instrumentation.
Metadata alone is not a rendered target. This retains native Chat, Select,
visual editing and Teach app without introducing a pixel editor.

Run the required TypeScript, route, registration, screen-quality and contrast
gates. `compile-screen-build-pack.js --check` verifies this branch's main-based
phone execution projection. It does not run the old creation planner.
When images were bundled, `materialize-prototype-images.js --project-root
"<working_dir>" --check` verifies their bytes without downloading again; the
candidate helper also runs that gate. A compiler pass is not proof of native
image rendering, source reachability or a maker-visible approval screen.
Report only completed screen milestones. Submit a candidate with the real ready
screen IDs; the bridge owns validation, Metro and native publication. Do not
start another Metro or claim native mounting from a compiler result.
Call `mobile-authoring.js complete` only after the operation's required work.

## Grow the same app

**Build more screens** is an ordinary app-wide `edit`, not another creation.
Read the deferred list, ask which next screens are useful, then prepare an
explicit `screen` edit proposal with `newScreens` and the exact required files.
Retain existing screens, app identity, records, styling and rules. Update the
main plan and phone screen projection only within that approved scope; move
implemented ideas out of the deferred list. Build only the additional/affected
screens, re-register the complete app and review the candidate before Apply.

Native controls, connectors, Dataverse, chat edits and basic teaching retain
their existing individual owners and signed decisions. They are not automatic
side effects of completing the first app. For real data, reuse existing desktop
and Player sign-in; do not add a client-registration wizard or disguise a missing
authentication prerequisite as a successful connection.
