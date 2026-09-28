# App edit routing

Use this contract for every native, connector/data-source, data-model, or
mutating design feature request classified by the shared entry preflight.
This includes future feature skills; it is not an allowlist of current names.
Adding a wrapper or registering a service is not the same as delivering the
feature that uses it.

## Direct requests

For an existing mobile app, use a lightweight **entry-choice gate** before loading
or invoking `/edit-app`. Check only the supplied request/caller context and local
project markers needed to identify the app. Do not run health/type checks, scan
all screens/services, discover cloud metadata, start planners, or generate previews
just to ask this question. This gate precedes operational version/auth checks.

Ask one question through the host's question tool: "How far should I take this change?"

| Choice | Work authorized by the choice |
|---|---|
| Implementation only | Generate/register the requested wrapper, service, or bounded artifact; no screen integration, broad replanning, or preview |
| Full app integration | Invoke `/edit-app` to inspect intent and propose the affected plan/data/screens changes; explain that this costs more than implementation-only work |
| Cancel | Stop without invoking `/edit-app`, running implementation commands, or changing files |

Wait for an explicit selection. Silence, dismissal, or an ambiguous answer is not
consent; stop or clarify, never default to full integration. Naming a screen or
giving a detailed feature request does not bypass this gate.

Only after **Full app integration** is selected, delegate the complete request
to `/edit-app`. Forward `entry_choice: full-integration` for this request, the
absolute `working_dir`, original request,
all arguments, supplied answers, and entry skill name, then stop this invocation.
Naming a capability, connector, table, or package does not establish its intended
screen behavior or authorize a wrapper-only/data-only change.

For **Implementation only**, continue the bounded leaf workflow and forward
`--implementation-only` through any router so the next leaf does not ask again.
Retain that operation's own approval and validation gates. Do not silently escalate
to `/edit-app` when implementation-only work is insufficient; explain the missing
integration and ask before broadening scope.

Reuse a mode choice already supplied for this same request. An explicit
`--implementation-only` request needs no entry question. A direct `/edit-app`
invocation already selects the integration workflow; do not send it through this
menu again. Honor `--plan-only` in either mode: return only the proposal, never
execute app/cloud mutations.

`/edit-app` inspects the app and asks only for unresolved intent: what job the
feature supports, where it is used, and whether its output must be retained.
It owns the approved plan delta, affected screens, verification, preview, and
memory-bank update. Do not ask the user to run a second command themselves.
The entry choice approves entering that workflow, not its mutations: preserve
its impact/plan approval and explicit approval for data-source removals.

If the app exists but its plan is missing, report the missing plan and ask whether
to restore it or perform an explicitly limited implementation-only operation.
Do not re-scaffold over the app or fabricate a complete plan from one request.
Outside an existing app, retain the skill's project prerequisites and standalone
planning behavior; brand-only design generation need not create an app.

## Orchestrated calls

`MOBILE_APP_ORCHESTRATING=1` is an invocation-scoped context marker, not approval.
`/create-mobile-app` and `/edit-app` pass it explicitly with every child handoff,
together with:

- `orchestrator`: the owning skill;
- `working_dir`: the absolute app directory;
- `phase`: planning or implementation, or an explicitly delegated design/configuration gate;
- `approved_scope`: the exact approved plan sections/operations and supplied answers
  for implementation, or the read-only planning task.

Check valid caller context before the entry-choice gate. A current approved
`/create-mobile-app` or `/edit-app` child call skips the entry question and executes
only its approved scope. Do not add a second integration/cost question inside
creation, edit, or their routed leaf calls.

`/setup-datamodel` may also pass this context when applying its standalone approved
data-only plan. Routers forward the same context to their selected leaf; internal
native helpers inherit it from `/add-native`. A child returns to its owner, never
delegates back to `/edit-app`, and never starts another orchestration.

Do not persist the marker in project files, shell profiles, or memory-bank.
A shell `export` in one tool call does not propagate reliably to later skill
calls: include the context in each invocation even if the environment is set.
A bare/stale environment value or `--skip-planning` without a matching current
handoff is not an orchestration guard or consent. Ask for the missing scope.

Planning is read-only: no connection creation, schema/service generation, native
wrapper writes, brand/token writes, or dependency installation. Implementation
starts only after the owner approves and saves the plan delta. Reuse approved
answers; if a new choice expands the scope, return `NEEDS_CONTEXT` to the owner
instead of independently approving or silently broadening the change.

During fresh creation, the design child may own its brand-selection gate after
the app architecture is approved. Configuration-only children such as
`setup-app-insights` also retain their own mutation approval. Identify that gate
explicitly in the handoff; these exceptions do not authorize feature leaves to
mutate during planning.

## Conditional impact

| Requirement | Affected plan surfaces |
|---|---|
| Device capture, scan, view, or local export | Native Capabilities; Screens when used by UI |
| Teams/email action, profile lookup, or cloud flow | Connectors and the consuming Screens; no Dataverse Data Model by default |
| SQL/Excel/SharePoint data | Connectors, including external tables/list schemas, and consuming Screens; not automatically Dataverse |
| New/changed Dataverse tables, columns, relationships, or retained artifacts | Data Model; Screens when they consume the change |
| Existing Dataverse schema with missing generated services | Refresh services and Generated Services snapshot; do not invent schema changes |
| Brand refresh/reskin | Design; inspect affected Screens and runtime token/provider wiring |

Ask about retention rather than assuming every photo/signature/PDF needs Dataverse.
Reuse the approved storage platform and existing columns. Update Dataverse schema
only when the feature actually requires new/changed Dataverse storage.

For removed/replaced requirements, apply
[data-source-removal.md](data-source-removal.md). The owner approves retirement,
updates consumers first, then uses the CLI to unregister the source and reconcile
generated/config output. A shortened plan or unused screen is not permission to
delete a server table or manually prune generated files.

## Explicit implementation-only requests

Honor the implementation-only entry choice, `--implementation-only`, or an explicit instruction such as "generate only
the wrapper" or "register the connector without changing screens." Confirm the
bounded operation if it is not already clear; retain the leaf's approval and
validation gates. This is not permission to execute an unrelated existing plan.
Do not infer this mode merely because the user did not mention screens.

After success, reconcile only the affected Native Capabilities, Connectors,
Data Model, Design, and Generated Services entries that actually changed, if an
existing plan is available. Update memory-bank without secrets. Leave screen
specifications/code unchanged and state that UI integration was intentionally
not performed. Do not claim the user-visible feature is complete.

## Returning from implementation

Return the standard first-line status plus implemented operations, existing
skill/helper-owned `writtenFiles`, generator-owned outputs, validation results,
and unresolved integration needs. In orchestrated mode the parent owns the final
plan/service snapshot, screen work, and completion summary; a leaf's `DONE` or
`STOP` returns control to that parent, not completion of the entire feature.

Connection discovery/re-authentication, auth configuration, Application Insights
configuration, telemetry preferences, sample seeding, offline-profile
configuration, dependency maintenance, diagnostics, previews, deployment, and
issue reporting retain their dedicated workflows and approvals. Do not route a
pure operational request through app planning. If it also requests new screen
behavior or schema, hand that feature delta to `/edit-app` rather than implementing
it as an unplanned side effect.
