# Action Bindings (Dataverse Custom API invocation)

Action-backed GenPages call Dataverse **Custom API Actions and Functions** — server-side
plug-in business logic the page could not otherwise reach — on the **signed-in user's own
token** (no broker, no impersonation). The `name` string a page passes to
`dataApi.executeAction` / `executeFunction` **MUST** equal an `actionBindings[].name` value
in the page `config.json`, and that Custom API must exist in the target environment.

> **Custom API support has no feature flag.** Discovery, authoring and upload are always
> available; the `custom-api` flag that once gated them was removed, and
> `GENPAGE_ENABLE_CUSTOM_API` is ignored. The `genpage-customapi-builder` agent owns discovery.

> **Vocabulary.** Makers author **Custom APIs** (the Dataverse `customapi` artifact); each is
> either an **Action** (POST; call with `executeAction`) or a **Function** (GET;
> call with `executeFunction`). Known read semantics, not GET alone, determine whether automatic
> invocation is appropriate. The shipped runtime contract uses the technical term
> *action*: bindings persist into `config.json.actionBindings` and the upload flag is
> `--actions`. So the maker-facing skill says "Custom API" while the wire format stays
> `actionBindings` — the two describe the same thing at different layers.

> **Two `actionBindings` names are not Custom APIs.** Exactly `WhoAmI` and `RetrieveVersion`
> are reviewed built-in Dataverse Functions behind their own default-off
> `dataverse-operations` flag: discovery here never lists them, and a missing Custom API row
> is never their problem. See `references/dataverse-operations.md`.

## Binding shape: `actions.json` (array) vs page `config.json` (object)

The skill writes a **bare JSON array** of bindings to working-dir `actions.json`.
`genpage-upload.js --actions <actions.json>` then persists that array into the
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

**page `config.json`** — what the upload writes into the deployed page (the same array wrapped
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
- `isFunction`: `true` ⇒ a **Function** (call with `executeFunction`; GET
  semantics); `false`/absent ⇒ an **Action** (call with `executeAction`; may mutate; POST).
  Calling the wrong method is rejected with `wrong_operation_kind` before dispatch.
- `boundEntityLogicalName`: present ⇒ the operation is **entity-bound** and its calls
  **REQUIRE** a `boundTo` whose `entityName` equals this value; absent ⇒ the operation is
  **Global** and calls must **NOT** pass `boundTo`.
- `displayName`: friendly name surfaced by `listBoundActions()`; discovery/affordance only.
- `parameterKinds`: the Custom API's DECLARED request-parameter kinds, keyed by parameter
  unique name (e.g. `{ "Amount": "Decimal" }`). The runtime has no other source for these,
  so record every primitive request parameter's Dataverse type. Values are `DataverseParameterKind`
  strings: `String`, `Integer`, `Decimal`, `Float`, `Money`, `Boolean`, `DateTime`, `Guid`,
  `StringArray`, `Picklist`.
  EntityReference, Entity and EntityCollection are **not** declared kinds: an unsupported kind
  causes the runtime to drop the whole binding, so calls fail with `not_bound`.
  See <https://learn.microsoft.com/power-apps/developer/data-platform/custom-api>.

## In an App Spec

An app a download reads is written with each page's `actionBindings` in `pages[].actionBindings`, and a rebuild
writes that list back onto the page (a spec that states none leaves the page's own). A spec states an entry by the
properties documented above — `name`, `isFunction`, `boundEntityLogicalName`, `displayName`, `parameterKinds` — and
by nothing else, each with a value of a conservative shape known to be safe (an identifier, a label, a flag, a map of
parameter names to the ten primitive declared kinds documented above). A list in which any entry holds anything else is left out of the spec
WHOLE, reported by its place and the vetted property (never a value or an unrecognized key), and stays on the page;
a spec that states one is refused (see `references/app-spec-schema.md` → `pages[]`). `/genpage`
itself never reads or writes the spec. The spec carries the list and not the Custom APIs it names: each must
already exist in the environment you rebuild into, deployed in a solution. A rebuild reads the environment's Custom
APIs before it writes and says by name one that is not there, one that is the other kind (Action or Function) and
one bound to another table; it does not stop for them.

An App Spec must not declare `EntityReference`, `Entity` or `EntityCollection`. A downloaded list
holding an unsupported declared kind is left out whole and reported by place and property, never
by value; the raw page config and an omitted list's rebuild payload stay untouched. A sparse
primitive map such as `{ "Note": "String" }` is valid, as is `{}` for a lookup-only API. The lookup
still belongs in the call as `{ entityName, id }`; its authoring hints remain discovery-only,
not App Spec binding fields (see below). A deliberate repair states the verified primitive map
explicitly; omitting the list preserves it rather than repairing it. Do not coerce a lookup to `Guid`.

## Discovery-only lookup inputs

`list-custom-apis.js` discovers supported public Global APIs and APIs bound to the page's
tables. It excludes private APIs, collection-bound APIs, and APIs with Entity/EntityCollection
inputs **or outputs**. It reads request and response type metadata inline in one query;
an unreadable or incomplete required metadata answer is an error, never a successful empty list.
These discovery rules do not remove unrelated existing page bindings.
Single-level expanded collections normally include relationship `@odata.nextLink` annotations
that describe the same related rows, not another page. Discovery accepts those known links
without following them; genuine/ambiguous paging and the 5,000-related-row ceiling fail explicitly.
See <https://learn.microsoft.com/power-apps/developer/data-platform/webapi/query/join-tables#single-expand-on-collection-valued-navigation-properties>.
Request names must be usable and unique. Lookup requiredness must be a real boolean, and a
supplied table hint must be a valid string; missing or malformed authoring facts are errors,
not guessed defaults. An absent/null table hint is legitimate.

A lookup (request type 5) is supported **structurally**, not through a declared kind.
Discovery retains its exact input name separately:

```json
{
  "name": "new_ResolveReference",
  "parameterKinds": { "Note": "String" },
  "lookupParameters": {
    "Ref": { "isOptional": false, "logicalEntityName": "account" },
    "OptionalRef": { "isOptional": true }
  }
}
```

`lookupParameters` is **discovery-only authoring metadata**, not an `actions.json` or
`config.json.actionBindings` field. Keep lookup names and required/optional/table information
in the plan's separate lookup-input notes, not in its primitive kind column.
The callable `Ref` input must not disappear just because it has no declared kind.

Pass a lookup as exactly `{ entityName, id }`, for example
`Ref: { entityName: 'account', id: selectedAccount.accountid }` from a record the page
actually loaded or selected. For the directly checked member form, use a named helper's explicit
record input (for example `selectedAccount: { accountid: string }`) supplied from the page's
existing record input. Do not fabricate a local record or cast an unknown object to provide
type/provenance evidence. For a more complex record source, pass its verified ID through an
explicitly typed `string` helper input instead of an unproven member chain.
Honor `logicalEntityName` when discovery supplies a table hint;
when it is absent, establish the table from actual schema/record context rather than guessing.
Omit an optional lookup when no record was selected. Never invent a GUID, substitute a
primitive Guid parameter, or manufacture a null lookup value.
See <https://learn.microsoft.com/power-apps/developer/data-platform/reference/entities/customapirequestparameter>.

## Runtime requirements

- Always cast `dataApi` to the optional action-method shape and **presence-check** the method
  before calling it — the methods are absent on older runtimes.
- **Actions may mutate: guard against double-submit.** Keep a synchronous latch per
  action-triggering control (`pending.current`, set before the call and reset in `finally`, as in
  the pattern below) or an `isSubmitting` flag; disable the control while a call is in flight;
  never fire a second `executeAction` for the same trigger before the first resolves.
- **Functions use GET, not a proof of harmless behavior.** Automatic mount/filter invocation
  requires author-known read semantics for the selected Custom API. Otherwise require an explicit
  user trigger and prevent overlapping submissions; still avoid pointless fetches and ignore stale responses.
- **`boundTo` rules** (checked against the manifest BEFORE dispatch; every mismatch is
  `invalid_bound_to`): an entity-bound operation (`boundEntityLogicalName` present) REQUIRES
  `boundTo`; `boundTo.entityName` must equal that table; a Global operation must NOT receive
  `boundTo`; both `entityName` and `id` must be non-empty. Build it from a record the page
  already has — `{ entityName: pageInput.entityName, id: pageInput.recordId }` when embedded
  on a form — never a hard-coded/invented GUID.
- **Read outputs from `res.outputs`, never `res.value`.**
- **Never surface raw fault text.** On `res.ok === false`, show only the SANITIZED
  `res.error?.message` in a message bar. Never render stack traces or plug-in fault detail.
  Every failed result and every rejection goes through the page's `reportPageError`
  (rules.md → *Missing Error Handling*) with the result's `res.error?.code` and
  `res.error?.message` — never the result itself — and a literal kind; `PageErrorBar` shows
  the view it returns.
- **Never auto-retry.** `res.indeterminate` (timeout after dispatch — the server may have
  committed) must never be retried automatically; ask the user to refresh. Only
  `res.error?.code === 'network'` is safely retryable (the request never left the client), and
  even then only via a manual "Try again". Do not confuse the two. Check both indeterminate
  forms first — `res.indeterminate`, then `res.error?.code === 'indeterminate'` — then
  `network`, then any other failure, each reporting and returning before `res.outputs` is read.
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

A complete `PageBody` for a bound Action, built on the page error block of rules.md (which supplies
`PAGE_NAME`, `reportPageError`, `PageErrorBar`, the boundary and the default export). The handler is a
named function inside `PageBody` because it closes over state; `setActionFailure` stores the view and
`pending: false` in one update; `retryApprove` is passed, never called, and only for a `network` result.
The approval belongs to the record it was started on: `approvalFor` holds the record the panel shows, a
record change clears the panel — and with it any retry — and an answer that arrives after the page moved
to another record is ignored, so a retry can only ever re-send the approval of the record on screen.

```typescript
type ActionResult = { ok: boolean; indeterminate?: boolean; outputs?: Record<string, unknown>; error?: { message: string; code?: string } };
type ActionApi = {
  executeAction?: (request: { name: string; parameters?: Record<string, unknown>; boundTo?: { entityName: string; id: string } }) => Promise<ActionResult>;
};

function PageBody(props: GeneratedComponentProps) {
  const { dataApi, pageInput } = props;
  const actionApi = dataApi as unknown as ActionApi;
  const currentRecord = pageInput?.recordId ?? '';
  const [comment, setComment] = React.useState('');
  const [approval, setApproval] = React.useState<{ pending: boolean; status: string; error: PageErrorView | null }>({ pending: false, status: '', error: null });
  const pending = React.useRef(false);                          // double-submit latch
  const approvalFor = React.useRef(currentRecord);              // the record the approval panel belongs to

  // Another record starts a clean panel: the previous record's result, and its retry, are cleared.
  React.useEffect(() => {
    approvalFor.current = currentRecord;
    setApproval({ pending: false, status: '', error: null });
  }, [currentRecord]);

  function setActionFailure(view: PageErrorView) {
    setApproval({ pending: false, status: '', error: view });
  }

  function retryApprove() {
    if (currentRecord && currentRecord === approvalFor.current) void approveOrder(currentRecord, comment);   // only while this record is shown
  }

  async function approveOrder(recordId: string, note: string) {
    if (typeof actionApi.executeAction !== 'function') return;   // presence-check; hide/disable the trigger
    if (pending.current || !recordId) return;                    // double-submit guard
    pending.current = true;
    setApproval({ pending: true, status: '', error: null });
    try {
      const res = await actionApi.executeAction({
        name: 'new_ApproveOrder',
        parameters: { Comment: note },                           // types match parameterKinds
        boundTo: { entityName: 'salesorder', id: recordId },     // REQUIRED: entity-bound
      });
      if (recordId !== approvalFor.current) return;              // the page moved on: not this record's answer
      if (res.indeterminate) { setActionFailure(reportPageError(PAGE_NAME, 'approveOrder', res.error?.code, res.error?.message, 'indeterminate')); return; }
      if (res.error?.code === 'indeterminate') { setActionFailure(reportPageError(PAGE_NAME, 'approveOrder', res.error?.code, res.error?.message, 'indeterminate')); return; }
      if (!res.ok && res.error?.code === 'network') { setActionFailure(reportPageError(PAGE_NAME, 'approveOrder', res.error?.code, res.error?.message, 'network', retryApprove)); return; }
      if (!res.ok) { setActionFailure(reportPageError(PAGE_NAME, 'approveOrder', res.error?.code, res.error?.message, 'write')); return; }
      const status = res.outputs?.NewStatus;                      // read from outputs, never value
      setApproval({ pending: false, status: typeof status === 'string' ? status : '', error: null });
    } catch (error) {
      if (recordId !== approvalFor.current) return;
      setActionFailure(reportPageError(PAGE_NAME, 'approveOrder', undefined, error, 'write'));
    } finally {
      pending.current = false;
    }
  }

  return (
    <div>
      <PageErrorBar error={approval.error} />
      <Input aria-label="Comment" value={comment} onChange={(_, data) => setComment(data.value)} />
      <Button appearance="primary" disabled={approval.pending} onClick={() => void approveOrder(currentRecord, comment)}>Approve</Button>
      {approval.status && <Text>{approval.status}</Text>}
    </div>
  );
}
```

The order is the contract: both indeterminate forms first (`'indeterminate'`, no retry — the server may
have committed), then `network` (`'network'`, the named manual retry), then any other failure
(`'write'`, no retry), each storing its view and returning before `res.outputs` is read; a rejection is
a `'write'` too. Each kind is a literal — never a ternary. For a **Global** action, omit `boundTo`
entirely.

## Function pattern (known read semantics required before automatic invocation)

A complete `PageBody` for a Function the plan records as a read: a failure is a `'read'` with a named
reload. A Function whose side effects are not established is a `'write'` with no retry, called only
from a button with the Action's overlap guard.

```typescript
type FunctionResult = { ok: boolean; indeterminate?: boolean; outputs?: Record<string, unknown>; error?: { message: string; code?: string } };
type FunctionApi = {
  executeFunction?: (request: { name: string; parameters?: Record<string, unknown> }) => Promise<FunctionResult>;
};

function PageBody(props: GeneratedComponentProps) {
  const { dataApi, pageInput } = props;
  const functionApi = dataApi as unknown as FunctionApi;
  const [summary, setSummary] = React.useState<{ total: number | null; error: PageErrorView | null }>({ total: null, error: null });

  function setSummaryFailure(view: PageErrorView) {
    setSummary({ total: null, error: view });
  }

  function retrySummary() {
    void loadSummary(pageInput?.recordId ?? '');
  }

  async function loadSummary(orderId: string) {
    if (typeof functionApi.executeFunction !== 'function') return;
    try {
      const res = await functionApi.executeFunction({ name: 'new_GetOrderSummary', parameters: { OrderId: orderId } });
      if (res.indeterminate) { setSummaryFailure(reportPageError(PAGE_NAME, 'loadSummary', res.error?.code, res.error?.message, 'indeterminate')); return; }
      if (res.error?.code === 'indeterminate') { setSummaryFailure(reportPageError(PAGE_NAME, 'loadSummary', res.error?.code, res.error?.message, 'indeterminate')); return; }
      if (!res.ok && res.error?.code === 'network') { setSummaryFailure(reportPageError(PAGE_NAME, 'loadSummary', res.error?.code, res.error?.message, 'network', retrySummary)); return; }
      if (!res.ok) { setSummaryFailure(reportPageError(PAGE_NAME, 'loadSummary', res.error?.code, res.error?.message, 'read', retrySummary)); return; }
      const total = res.outputs?.Total;
      setSummary({ total: typeof total === 'number' ? total : null, error: null });
    } catch (error) {
      setSummaryFailure(reportPageError(PAGE_NAME, 'loadSummary', undefined, error, 'read', retrySummary));
    }
  }

  return (
    <div>
      <PageErrorBar error={summary.error} />
      <Button onClick={() => void loadSummary(pageInput?.recordId ?? '')}>Show summary</Button>
      {summary.total !== null && <Text>{summary.total}</Text>}
    </div>
  );
}
```
## Optional discovery: `listBoundActions`

`dataApi.listBoundActions?.()` returns the operations THIS PAGE is bound to (`name`,
`displayName`, `isFunction`, `bindingType`). Use it only to render affordances for what is
available; it reflects the page's `actionBindings`, **not** the signed-in user's privileges,
so a listed operation can still fail with `not_permitted`. Never use it to discover names —
always code against the plan's `## Custom API Bindings`.
