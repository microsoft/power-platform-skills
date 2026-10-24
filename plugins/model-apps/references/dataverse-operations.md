# Built-in Dataverse operations (WhoAmI, RetrieveVersion)

A generative page can call exactly two **built-in** Dataverse operations — `WhoAmI` and
`RetrieveVersion` — as explicitly selected, user-triggered Functions. They reuse the page's
`actionBindings` and `dataApi.executeFunction`, but they are **not Custom APIs**: they are
messages the platform defines, not rows of the `customapi` table, so Custom API discovery
(`list-custom-apis.js`) never finds them and a Custom API wrapper is never their remedy.

> **Behind a default-off flag.** `dataverse-operations` ships **OFF**. Set
> `GENPAGE_ENABLE_DATAVERSE_OPERATIONS=1` for a run (or `"dataverse-operations": true` in
> `plugins/model-apps/feature-flags.json`). The flag gates **offering and authoring new**
> bindings only: it never strips, repairs or revokes a binding a page already has, and it is not
> the platform's runtime switch. The `genpage-customapi-builder` agent owns the gate.

## The catalogue

The offer is a fixed, reviewed catalogue (`scripts/lib/dataverse-operations.js`, revision 1),
not a check of the environment. Growing it is a reviewed code change, never a setting.

| Name | Kind | Parameters | Response | Display name |
|------|------|------------|----------|--------------|
| `WhoAmI` | Function, unbound (Global) | none | `WhoAmIResponse`: `BusinessUnitId`, `UserId`, `OrganizationId` (each `Edm.Guid`) | Current Dataverse identity |
| `RetrieveVersion` | Function, unbound (Global) | none | `RetrieveVersionResponse`: `Version` (`Edm.String`) | Dataverse server version |

They retrieve the signed-in user's identity and the server's version
(<https://learn.microsoft.com/power-apps/developer/data-platform/webapi/reference/whoami>,
<https://learn.microsoft.com/power-apps/developer/data-platform/webapi/reference/retrieveversion>).
Nothing here claims they have no audit side effect.

**Why nothing else is offered.** "Function" or "GET" does not make an operation harmless:
`CalculateRollupField` and `IncrementKnowledgeArticleViewCount` are Functions that change data.
Record-bound Functions add overloads, record identity and authorization outputs; `QualifyLead`,
Actions and classic process actions mutate business data and need confirmation and ownership
rules; set-bound operations have no invocation shape in the page runtime. Each is separate work,
so this catalogue refuses them all (`not_in_catalogue`) and never probes them.

## The flag and Custom API discovery are independent

| `custom-api` | `dataverse-operations` | What is offered |
|---|---|---|
| on (shipped default) | off (shipped default) | Custom APIs only |
| off | off | nothing new; existing bindings stay |
| off | on | the two built-ins only — `list-custom-apis.js` is not run |
| on | on | both, as two labelled sources; only affirmative selections are written |

## Listing: `list-dataverse-operations.js`

```powershell
node "${PLUGIN_ROOT}/scripts/list-dataverse-operations.js"
```

No arguments and no options: it takes no environment, reads no token and sends no request.

| Exit | When | stdout | stderr |
|---|---|---|---|
| 3 | flag OFF (even with a bad argument) | empty | `Dataverse built-in operation authoring is disabled (feature flag "dataverse-operations" is OFF). Set GENPAGE_ENABLE_DATAVERSE_OPERATIONS=1 to offer WhoAmI and RetrieveVersion. Existing bindings are preserved; runtime governance and user privileges still apply.` |
| 1 | any argument | empty | `Usage: node scripts/list-dataverse-operations.js` |
| 1 | the catalogue cannot be read, or is not exactly the reviewed pair | empty | `The built-in operation catalogue could not be read. No built-in operations were offered.` |
| 0 | otherwise | one JSON line | — |

The success body is `{ "ok": true, "catalogueVersion": 1, "verification": { "mode":
"catalogue-only", "environment": "not-checked", "runtime": "not-checked", "privileges":
"not-checked" }, "operations": [ … ] }`, each operation `{ name, displayName, isFunction: true,
bindingType: "Global", parameters: [], parameterKinds: {}, response: { typeName, properties },
outputPrivacy, invocation: "user-triggered", requiresExplicitSelection: true }`. Listing is an
offer, not a check: whether the environment or its page player has the operation, and whether
the signed-in user may call it, is **not checked** — a page's first call can answer 404. Run it
only when this run needs an explanation or an add/replace offer — never for an upload, a code
generation, a download, a rebuild or an unrelated edit.

## Selection is consent; a mention is not

- An **affirmative** "add a button that calls WhoAmI", or an explicit answer to a picker that
  offered the operation, selects it. Do not ask again.
- A mention, a question, a quotation, a negation ("do **not** add WhoAmI") or a removal is
  **not** an addition. "Explain WhoAmI" writes no binding.
- A generic need ("show who I am", "show the server version") with no affirmative name returns
  `needs_input` with the offer below. Silence is never selection, and an unattended run never
  treats "no answer" as consent: a request or spec counts only when the interaction contract
  recorded that explicit intent.
- The selected names and where they came from stay in this run's orchestration context — never
  on the wire, never in a consent file.

When the two are offered, say:

> These are two reviewed built-in Dataverse Functions, not Custom APIs discovered in this
> environment. Their availability, player support and your permissions have not been checked.
> Select either explicitly to add a user-triggered call. WhoAmI returns your Dataverse user,
> business-unit and organization identifiers.

When the maker affirmatively asked for WhoAmI or RetrieveVersion and the flag is OFF, relay the
script's gate line, write no new built-in row, and add: `This does not mean the environment lacks
these operations, and the remedy is not a Custom API wrapper. No new built-in binding was
added.` Say that only for these two names, and never echo an unknown name back.

| Case | Code | Message |
|---|---|---|
| Any other name: wrong case, namespace, prefix, private or unadvertised message | `not_in_catalogue` | `Only WhoAmI and RetrieveVersion are offered by this feature. Other Dataverse operations require separately reviewed support.` |
| An effectful Function, a record-bound Function, `QualifyLead`, an Action, a classic process action, a set-bound operation | `not_in_catalogue` | the same message (see "Why nothing else is offered") |
| A new row with a false, absent or non-boolean kind, a bound target or inputs | `invalid_operation_contract` | `The selected built-in operation must be an explicitly declared, unbound Function with no inputs.` |
| A name twice, or contradictory rows, in the desired array | `duplicate_operation` | `Select each built-in operation once; duplicate bindings are not supported.` |
| A row about to be written with no affirmative selection | `selection_required` | `Select a built-in operation explicitly before generating its binding or call.` |
| A call on mount, a poll, a filter or a background call | `explicit_trigger_required` | `This version supports user-triggered built-in operation calls only.` No binding and no substitute call is added until the maker accepts a button; the refusal is not completion. |
| The catalogue cannot be read | `catalogue_unavailable` | the listing's exit-1 line |

These are authoring codes, not player `error.code` values, and they never restrict the Custom
API path. If this run's Custom API discovery returned a Custom API with the **same exact unique
name**, the built-in choice is ambiguous: bind neither silently; the maker may select that
Custom API row explicitly. When that discovery did not run, do not claim the name is free.

The platform still decides every call, and nothing here reads or changes its governance: a
player without `executeFunction` (unsupported-player guidance, no second transport); the
`DisableGenUxPluginActionsRuntime` switch; the page's bound manifest; the
`GenUxPluginActionAllowList` (empty or unset allows every **bound** name — it is not
discovery); the kind and target in the manifest; the signed-in user's own Dataverse privileges
(no grant, no impersonation, no privilege probe). A guard that refuses before the transport
sends no request.

## The binding and `actions.json`

A built-in row is the four-key projection of its descriptor — never the descriptor itself
(`bindingType`, `parameters`, `response` and the rest would leave the page's whole list out of
an App Spec):

```json
{ "name": "WhoAmI", "isFunction": true, "displayName": "Current Dataverse identity", "parameterKinds": {} }
```

`RetrieveVersion` differs only in `name` and `displayName` (`Dataverse server version`).
`actions.json` stays one bare array with one writer (`genpage-customapi-builder`): the Custom API
rows first, in their existing order, then the new built-in rows in catalogue order. Every new
row must be exactly that projection; one refusal, or a duplicate name, stops the whole write and
leaves the page untouched. `--actions` is a **full replace** — pass it only when the desired set
changed, and never as a partial file.

| Edit intent | Gate | `--actions` | Page source |
|---|---|---|---|
| preserve (an unrelated edit) | not consulted | omitted | keep existing call text as it is |
| add / replace | must be ON | the full desired array | the button pattern below, for the new names only |
| remove | not consulted | the array minus the named entries | delete those calls only |
| clear all | after the maker's clear choice, which names the built-ins it removes | `[]` | delete every call |
| none, on create | n/a | omitted unless Custom APIs changed | no built-in call |
| none, on an edit whose page already binds one | n/a | not passed | halt: no preserve evidence is no permission to delete the call |

Removing every Custom API is a remove of each Custom API row: the built-in rows stay, byte for
byte, and the file is never `[]` while one remains. With `custom-api` OFF no Custom API row is
removed either: the builder keeps them, reports `Custom API removal not performed (custom-api
disabled): <names>`, and the page's array stays as it is (no `--actions`) — a removal is never
turned into a clear to get around the flag. Only the maker's clear choice — asked with two
options and recorded right before the upload it covers as `Clear choice: Clear every action binding
of page <page-id>, removing <names>` — empties the array; a yes to adding or keeping an operation
never does.

A gate flipped OFF between planning and generation of an add/replace halts: no `actions.json`
is written, no `--actions` is passed, and `[]` is never written in its place (`[]` is only an
explicit clear-all). A preserved entry is never upgraded: an omitted `isFunction`, another
display label or an omitted `parameterKinds` stays as the page holds it.

## The plan section

`## Dataverse Operations` is **optional**. When present it sits after `## Custom API Bindings`
and before `## Solution Packaging`, and it is either the exact sentinel `No Dataverse
operations.` or this table — anything else halts. Absent means no new authoring.

```markdown
## Dataverse Operations
Verification: environment not-checked, runtime not-checked, privileges not-checked.
| Name | Kind | Bound Entity | Display Name | Parameters | Response fields | Invoke |
|------|------|--------------|--------------|------------|-----------------|--------|
| WhoAmI | Function | (Global) | Current Dataverse identity | (none) | BusinessUnitId, UserId, OrganizationId | button |
| RetrieveVersion | Function | (Global) | Dataverse server version | (none) | Version | button |
```

Rows are in catalogue order and every cell is the catalogue's own; `Invoke` is always `button`.
The builder writes `dataverse-operations.md` only for an add/replace of the current run (a file
left by an earlier run is no evidence); the planner copies it verbatim and never re-derives it.

## Generated call

Only for a current-run add/replace, and only from a button. Never in a `useEffect`, at render,
in a filter, on a timer or on mount — and never hand its handler or helper to one
(`setTimeout(showIdentity, 0)`), to a `ref` or to a child component: only the button's
`onClick` names it.

```tsx
type BuiltInResult = { ok: boolean; outputs?: Record<string, unknown>; error?: { message?: string; status?: number } };
type BuiltInApi = { executeFunction?: (request: { name: string }) => Promise<BuiltInResult> };
type IdentityView = { identity?: { userId: string; businessUnitId: string; organizationId: string }; message?: string };
type VersionView = { version?: string; message?: string };

const GUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const UNEXPECTED = 'The operation returned an unexpected response. No result was displayed.';
const UNAVAILABLE = 'The selected operation is unavailable in this environment or player. No fallback was attempted.';
const FAILED = 'The operation failed. No result was displayed.';
const UNSUPPORTED = 'This page player cannot call built-in Dataverse operations.';

// An output only when it is the object's OWN string property.
function ownString(outputs: Record<string, unknown>, field: string): string | undefined {
  const value = Object.prototype.hasOwnProperty.call(outputs, field) ? outputs[field] : undefined;
  return typeof value === 'string' ? value : undefined;
}

async function readIdentity(api: BuiltInApi): Promise<IdentityView> {
  if (typeof api.executeFunction !== 'function') return { message: UNSUPPORTED };
  const res = await api.executeFunction({ name: 'WhoAmI' });
  if (res.ok !== true) {
    return { message: res.error?.status === 404 ? UNAVAILABLE : res.error?.message || FAILED };
  }
  const outputs = res.outputs;
  if (!outputs || typeof outputs !== 'object' || Array.isArray(outputs)) return { message: UNEXPECTED };
  const userId = ownString(outputs, 'UserId');
  const businessUnitId = ownString(outputs, 'BusinessUnitId');
  const organizationId = ownString(outputs, 'OrganizationId');
  if (![userId, businessUnitId, organizationId].every((id) => typeof id === 'string' && GUID.test(id))) return { message: UNEXPECTED };
  return { identity: { userId: userId as string, businessUnitId: businessUnitId as string, organizationId: organizationId as string } };
}

async function readVersion(api: BuiltInApi): Promise<VersionView> {
  if (typeof api.executeFunction !== 'function') return { message: UNSUPPORTED };
  const res = await api.executeFunction({ name: 'RetrieveVersion' });
  if (res.ok !== true) {
    return { message: res.error?.status === 404 ? UNAVAILABLE : res.error?.message || FAILED };
  }
  const outputs = res.outputs;
  if (!outputs || typeof outputs !== 'object' || Array.isArray(outputs)) return { message: UNEXPECTED };
  const version = ownString(outputs, 'Version');
  if (!version || version.length > 128) return { message: UNEXPECTED };
  return { version };
}

const GeneratedComponent = (props: GeneratedComponentProps) => {
  const { dataApi } = props;
  const api = dataApi as unknown as BuiltInApi;
  const mounted = React.useRef(true);
  React.useEffect(() => () => { mounted.current = false; }, []);

  const [identity, setIdentity] = React.useState<IdentityView>({});
  const [identityPending, setIdentityPending] = React.useState(false);
  const identityRequest = React.useRef(0);
  const showIdentity = async () => {
    if (identityPending) return;
    const requestId = ++identityRequest.current;
    setIdentity({});
    setIdentityPending(true);
    try {
      const view = await readIdentity(api);
      if (mounted.current && requestId === identityRequest.current) setIdentity(view);
    } catch {
      if (mounted.current && requestId === identityRequest.current) setIdentity({ message: FAILED });
    } finally {
      if (mounted.current && requestId === identityRequest.current) setIdentityPending(false);
    }
  };

  const [version, setVersion] = React.useState<VersionView>({});
  const [versionPending, setVersionPending] = React.useState(false);
  const versionRequest = React.useRef(0);
  const showVersion = async () => {
    if (versionPending) return;
    const requestId = ++versionRequest.current;
    setVersion({});
    setVersionPending(true);
    try {
      const view = await readVersion(api);
      if (mounted.current && requestId === versionRequest.current) setVersion(view);
    } catch {
      if (mounted.current && requestId === versionRequest.current) setVersion({ message: FAILED });
    } finally {
      if (mounted.current && requestId === versionRequest.current) setVersionPending(false);
    }
  };

  return (
    <div>
      <Button disabled={identityPending} onClick={() => void showIdentity()}>Show my Dataverse identity</Button>
      {identity.message && <Text>{identity.message}</Text>}
      {identity.identity && (
        <div>
          <Text>Dataverse user id: {identity.identity.userId}</Text>
          <Text>Business unit id: {identity.identity.businessUnitId}</Text>
          <Text>Organization id: {identity.identity.organizationId}</Text>
          <Text>The organization id is not an Entra tenant id.</Text>
        </div>
      )}
      <Button disabled={versionPending} onClick={() => void showVersion()}>Show the Dataverse server version</Button>
      {version.message && <Text>{version.message}</Text>}
      {version.version && <Text>Server version: {version.version}</Text>}
    </div>
  );
};
export default GeneratedComponent;
```

What the pattern holds, in this order:

1. The request is exactly `{ name: 'WhoAmI' }` or `{ name: 'RetrieveVersion' }`: no
   `parameters`, no `boundTo`, the unqualified name, on the page's own `dataApi` after a
   presence check that **returns** — a player without `executeFunction` sends nothing and gets
   no second transport, raw URL or token.
2. A result whose `ok` is not `true` shows the sanitized `error.message`, or a fixed fallback,
   and returns **before** `res.outputs` is read; a failed result that happens to carry
   output-shaped data shows none of it. An **actual** HTTP 404 on the result (a numeric
   `status` of 404) says `The selected operation is unavailable in this environment or player.
   No fallback was attempted.` and keeps the binding; a status is never read out of the
   message's words, and no message suggests deploying a Custom API. The current model-driven
   player passes no HTTP status to the page: a 404, a 403, a 429 and a network failure all
   arrive as its own sanitized message, so in practice the page shows that message and cannot
   tell an unavailable operation from a refused one.
3. Only then `res.outputs` — a non-null object that is not an array (an empty or 204 answer is
   `{}`) — and only through own-property reads. Never the result root, `res.value`, `res.body`
   or fault details; never a spread, an iteration or `JSON.stringify` of it; any other property
   is ignored.
4. All or nothing: WhoAmI shows its three identifiers only when every one is an own string
   matching the GUID pattern (no UUID-version check); RetrieveVersion shows `Version` only when
   it is an own string of 1 to 128 characters. Anything else shows `The operation returned an
   unexpected response. No result was displayed.`
5. A rejected promise is caught and shows bounded guidance, never a stack. A timeout or a
   `network` code is **not** proof the request never left the client or was cancelled, and the
   host does not cancel a timed-out GET: the pending button is disabled, which is not a claim
   that the request stopped. The page never retries — a retry is the user's next click. The
   current player's own transport can re-send a request once after a connection reset, so a
   click that failed may still have reached the service (both operations only read).
6. Each operation has its own pending state and request counter: a new click clears that
   operation's previous result, a stale or unmounted answer is ignored, and the other
   operation's button stays usable.

Labels are "Dataverse user id", "Business unit id" and "Organization id", with the line "The
organization id is not an Entra tenant id." A version is an opaque string, not a feature test.

## Privacy

WhoAmI answers the signed-in user's identifiers. Show them only as escaped text in the current
page, as the feature the maker asked for. Never log, store (`localStorage`, `sessionStorage`),
copy, put in a URL, send to telemetry or hash them; never join them to business records or use
them as a client-side authorization; never retrieve the `systemuser`, `businessunit` or
`organization` row behind them; never copy the identity an auth preflight printed into page
source. Binding WhoAmI is not permission to call it for analytics. Results stay in component
memory, and the same holds for everything that keeps them — the state the page renders from, a
ref, a variable derived from either — wherever the page uses it: at render, in an effect or in
another handler.

## Download and rebuild

The flag does not gate either, and neither refuses for it. An **exact** catalogue name is a
built-in (wrong case is a Custom API name):

- **download** names it under `pageBindings.neededInTarget.dataverseOperations`, never under
  `customApis`, and says there is nothing to deploy: the binding is carried as the page holds it
  (not repaired) and its availability and contract are not certified. A parameter map does not
  turn the name into a Custom API. A list holding an unsafe field is still left out whole.
- **rebuild** leaves it out of the `customapi` read, before the names are folded in case (a page
  that binds only built-ins reads no `customapi` row). It says each such binding was **not
  checked** — `These are reviewed built-in operation names; their availability in this
  environment or player and the signed-in user's permissions were not checked.` — and never
  "missing". A binding of that name that does not explicitly declare an unbound Function with no
  inputs gets a `dataverse-operation-shape` warning (an omitted legacy declaration is told apart
  from a contradiction) and is written as the spec states it.

## Compatibility

The wire shape is unchanged, so no migration and no `minimumPluginVersion` bump. Model-apps
2.17, 2.18 and 2.19 do not offer these operations. In 2.18 and 2.19, download and rebuild still
describe them as Custom APIs; they do not strip a valid binding. 2.17's download and rebuild carry
no page bindings. A hand-written page or a hand-written `actions.json` is outside this catalogue:
`genpage-upload.js --actions` writes the array it is given and resolves no name.
