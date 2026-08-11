# Action Bindings (Dataverse Custom API invocation)

Action-backed GenPages call Dataverse **Custom API Actions and Functions** — server-side
plug-in business logic the page could not otherwise reach — on the **signed-in user's own
token** (no broker, no impersonation). The `name` string a page passes to
`dataApi.executeAction` / `executeFunction` **MUST** equal an `actionBindings[].name` value
in the page `config.json`, and that Custom API must exist in the target environment.

> **Gated behind the `custom-api` feature flag (default OFF).** This reference is only used
> when Custom API support is enabled — see the Feature Flags section in the plugin `AGENTS.md`
> and `feature-flags.json`. When OFF, pages are Dataverse / mock-data (and, when their own
> flag is on, connector) only; **no Custom API code is emitted and no `actionBindings` are
> written**. The `genpage-customapi-builder` agent is the single owner of this gate.

> **Vocabulary.** Makers author **Custom APIs** (the Dataverse `customapi` artifact); each is
> either an **Action** (may mutate; call with `executeAction`) or a **Function** (read-only;
> call with `executeFunction`). The shipped runtime contract uses the technical term
> *action*: bindings persist into `config.json.actionBindings` and the pac verb is
> `--actions`. So the maker-facing skill says "Custom API" while the wire format stays
> `actionBindings` — the two describe the same thing at different layers.

## Binding shape: `actions.json` (array) vs page `config.json` (object)

The skill writes a **bare JSON array** of bindings to working-dir `actions.json`.
`pac model genpage upload --actions <actions.json>` then persists that array into the
deployed page's `config.json` under an `actionBindings` property. The two files therefore
have **different shapes** — do not write the object wrapper to `actions.json`.

**`actions.json`** — what the skill writes (a JSON array; no wrapper object):

```json
[
  {
    "name": "new_ApproveOrder",
    "isFunction": false,
    "boundEntityLogicalName": "salesorder",
    "displayName": "Approve Order",
    "parameterKinds": { "Comment": "String", "Amount": "Decimal" }
  },
  {
    "name": "new_GetOrderSummary",
    "isFunction": true,
    "displayName": "Get Order Summary",
    "parameterKinds": { "OrderId": "Guid" }
  }
]
```

**page `config.json`** — what `pac` writes into the deployed page (the same array wrapped
under `actionBindings`; the skill never writes this file directly):

```json
{
  "actionBindings": [ /* ...the identical array from actions.json... */ ]
}
```

- `name`: the Custom API **unique name** (e.g. `new_ApproveOrder`); this is the exact string
  the TSX passes as `executeAction({ name })` / `executeFunction({ name })`. **This is the
  revision-bound gate — a name not in `actionBindings` is rejected client-side with
  `not_bound` and is never dispatched.**
- `isFunction`: `true` ⇒ a read-only **Function** (call with `executeFunction`; GET
  semantics); `false`/absent ⇒ an **Action** (call with `executeAction`; may mutate; POST).
  Calling the wrong method is rejected with `wrong_operation_kind` before dispatch.
- `boundEntityLogicalName`: present ⇒ the operation is **entity-bound** and its calls
  **REQUIRE** a `boundTo` whose `entityName` equals this value; absent ⇒ the operation is
  **Global** and calls must **NOT** pass `boundTo`.
- `displayName`: friendly name surfaced by `listBoundActions()`; discovery/affordance only.
- `parameterKinds`: the Custom API's DECLARED request-parameter kinds, keyed by parameter
  unique name (e.g. `{ "Amount": "Decimal" }`). The runtime has no other source for these,
  so record every request parameter's Dataverse type. Values are `DataverseParameterKind`
  strings: `String`, `Integer`, `Decimal`, `Float`, `Money`, `Boolean`, `DateTime`, `Guid`,
  `StringArray`, `EntityReference`, `Entity`, `EntityCollection`, `Picklist`.
  See <https://learn.microsoft.com/power-apps/developer/data-platform/custom-api>.

## Runtime requirements

- Always cast `dataApi` to the optional action-method shape and **presence-check** the method
  before calling it — the methods are absent on older runtimes.
- **Actions may mutate: guard against double-submit.** Keep an `isSubmitting` flag per
  action-triggering control; disable it while a call is in flight; never fire a second
  `executeAction` for the same trigger before the first resolves.
- **Functions are read-only** — safe to call on mount / on a filter change; no double-submit
  guard needed (still avoid pointless overlapping fetches; ignore stale responses).
- **`boundTo` rules** (checked against the manifest BEFORE dispatch; every mismatch is
  `invalid_bound_to`): an entity-bound operation (`boundEntityLogicalName` present) REQUIRES
  `boundTo`; `boundTo.entityName` must equal that table; a Global operation must NOT receive
  `boundTo`; both `entityName` and `id` must be non-empty. Build it from a record the page
  already has — `{ entityName: pageInput.entityName, id: pageInput.recordId }` when embedded
  on a form — never a hard-coded/invented GUID.
- **Read outputs from `res.outputs`, never `res.value`.**
- **Never surface raw fault text.** On `res.ok === false`, show only the SANITIZED
  `res.error?.message` in a message bar. Never render stack traces or plug-in fault detail.
- **Never auto-retry.** `res.indeterminate` (timeout after dispatch — the server may have
  committed) must never be retried automatically; ask the user to refresh. Only
  `res.error?.code === 'network'` is safely retryable (the request never left the client), and
  even then only via a manual "Try again". Do not confuse the two.
- **Never guess** a name, parameter name, or output field. Use only the plan's
  `## Custom API Bindings` values and the declared parameter/output names.
- Keep non-action pages unchanged; only emit action code when the plan has action bindings.

## DataAPI method shapes

These are OPTIONAL methods on `props.dataApi`; presence-check each before use.

```typescript
interface ActionBoundTo { entityName: string; id: string; }
interface ExecuteActionRequest { name: string; parameters?: Record<string, unknown>; boundTo?: ActionBoundTo; }
interface ExecuteFunctionRequest { name: string; parameters?: Record<string, unknown>; boundTo?: ActionBoundTo; }
interface ActionError { message: string; code?: string; correlationId?: string; }
interface ActionResult { ok: boolean; indeterminate?: boolean; outputs?: Record<string, unknown>; error?: ActionError; }
interface BoundActionInfo { name: string; displayName: string; isFunction: boolean; bindingType: 'Global' | 'Entity'; boundEntityLogicalName?: string; }

type ActionDataApi = {
  executeAction?(request: ExecuteActionRequest): Promise<ActionResult>;
  executeFunction?(request: ExecuteFunctionRequest): Promise<ActionResult>;
  listBoundActions?(): Promise<BoundActionInfo[]>;
};
```

### `error.code` values the runtime can return

Teach every one; a page that mishandles a code degrades badly.

- `wrong_operation_kind` — an Action was called with `executeFunction` (or the reverse). Fix
  the call site; do NOT retry with the other method.
- `invalid_parameter` — a value did not match its declared Dataverse type (from
  `parameterKinds`). Pass a `number` for numeric, `boolean` for boolean, ISO/`Date` for
  date-time, a GUID-formatted string for a GUID, `string[]` for an array.
- `invalid_bound_to` — `boundTo` did not satisfy the binding (missing on an entity-bound op,
  wrong table, present on a Global op, or incomplete).
- `not_bound` — the name is not in this page's `actionBindings`. Never guess names.
- `not_permitted` / `not_enabled` — blocked by environment governance (allow-list / kill
  switch or per-user privilege).
- `indeterminate` — the call timed out AFTER being sent; the server may have committed it.
  Never auto-retry; ask the user to refresh and confirm.
- `network` — the request never left the client (offline / synchronous failure before
  dispatch); nothing was committed, so a **manual** "Try again" is appropriate. Still never
  auto-retry.

## Verified Action pattern (may mutate; double-submit guarded)

```typescript
const actionApi = dataApi as unknown as { executeAction?: (request: { name: string; parameters?: Record<string, unknown>; boundTo?: { entityName: string; id: string } }) => Promise<{ ok: boolean; indeterminate?: boolean; outputs?: Record<string, unknown>; error?: { message: string; code?: string } }>; };
if (typeof actionApi.executeAction !== 'function') { return; } // presence-check; hide/disable the trigger
if (isSubmitting) { return; }                                   // double-submit guard
setIsSubmitting(true);
try {
  const res = await actionApi.executeAction({
    name: 'new_ApproveOrder',
    parameters: { Comment: comment, Amount: amount },           // types match parameterKinds
    boundTo: { entityName: pageInput.entityName, id: pageInput.recordId }, // REQUIRED: entity-bound
  });
  if (res.indeterminate) { setError("We couldn't confirm this completed — refresh before retrying."); return; }
  if (!res.ok) { setError(res.error?.message ?? 'The action failed.'); return; } // sanitized only
  const { NewStatus } = res.outputs as { NewStatus: string };   // read from outputs, never value
} finally {
  setIsSubmitting(false);
}
```

For a **Global** action, omit `boundTo` entirely.

## Verified Function pattern (read-only; safe on mount)

```typescript
const actionApi = dataApi as unknown as { executeFunction?: (request: { name: string; parameters?: Record<string, unknown> }) => Promise<{ ok: boolean; outputs?: Record<string, unknown>; error?: { message: string; code?: string } }>; };
if (typeof actionApi.executeFunction !== 'function') { return; }
const res = await actionApi.executeFunction({ name: 'new_GetOrderSummary', parameters: { OrderId: orderId } });
if (!res.ok) { setError(res.error?.message ?? 'Could not load the summary.'); return; }
const { Total, Status } = res.outputs as { Total: number; Status: string };
```

## Optional discovery: `listBoundActions`

`dataApi.listBoundActions?.()` returns the operations THIS PAGE is bound to (`name`,
`displayName`, `isFunction`, `bindingType`). Use it only to render affordances for what is
available; it reflects the page's `actionBindings`, **not** the signed-in user's privileges,
so a listed operation can still fail with `not_permitted`. Never use it to discover names —
always code against the plan's `## Custom API Bindings`.
