# Common API Errors & Fixes

> **Note:** These shell commands require a local engine build. If you installed this as a plugin, use the MCP tools instead — they cover the same operations.

| Error | Cause | Fix |
|-------|-------|-----|
| `500 NullReferenceException` | Missing `$authentication` parameter | Add `parameters` block with `$authentication` and `$connections` |
| `InvokerConnectionOverrideFailed` | Used `"source": "Invoker"` | Change to `"source": "Embedded"` in connection refs |
| `WorkflowRunActionInputsInvalidProperty` | Included `"authentication"` in action inputs | Remove it — PA auto-injects on save |
| `InvalidTemplate` / parameter not declared | Missing parameter declaration | Declare `$authentication` and `$connections` in definition |
| `DirectApiRequestHasMoreThanOneAuthorization` | Added auth header to SAS URL | Don't add `Authorization` header to SAS URLs |
| `ConnectionNotFound` / `AuthorizationFailed` | Expired or deleted connection | Re-authorize: `create-connection --env=$ENV --connector=<name>` |
| `ExpressionEvaluationFailed` | Bad expression or null reference | Check expression syntax, add `coalesce()` for nullable values |
| `ActionTimedOut` | Action exceeded timeout | Add retry policy or increase timeout |
| `triggerBody() returns null` | Used management API trigger (not callback) | Use `--body=@file` with `run-flow` (auto-uses callback URL) or explicit `--no-callback` |
| `DirectApiAuthorizationRequired` / `MisMatchingOAuthClaims` | Ran a gated trigger **with a body** over the SAS callback. Six kinds are gated (`PowerApp`, `PowerAppV2`, `Button`, `ApiConnection`, `PowerPages`, `Skills`), plus any trigger with `type: "Manual"`. That transport requires SAS *and* an OAuth token identifying the Logic Flows runtime, which a delegated user token cannot present, and enforcement is on in every production cloud. | Not fatal. `run_flow` delivers inputs over the **Logic Flows connector runtime** instead, which does accept a delegated user token. Only surfaced as `DirectApiTriggerInputsUnsupported` if the connector also refuses — see the next row. |
| `DirectApiTriggerInputsUnsupported` | The Logic Flows connector refused the run. Measured causes: you do not hold the ACL on that flow's Logic Flows connection (403 `Permission denied due to missing connection ACL`), the trigger is disabled or the flow is stopped (400 `WorkflowTriggerIsNotEnabled`), or the flow id does not exist (404). | The 403 is a **per-flow access** problem, not a trigger-kind limitation — every gated kind, `Skills` included, runs fine on a flow you own. Ask the owner to share the flow, or run it from the app or agent that owns it. Start the flow if it is stopped. Otherwise use `get-past-trigger-inputs` + `resubmit-run`. |
| `TriggerInputMissing` | The trigger body is missing keys listed in the trigger schema `required[]` | The error lists the missing keys and expected shape; pass them via `--body=@file`. Applies to **every** trigger kind, including `PowerApps` / `PowerAppsV2`: the connector does not validate required inputs itself (it returns `202` with nulls), so the check must happen client-side. |
| `InvalidEnvironmentId` | An environment id that is not a GUID (e.g. a display name or a slug) was passed to `--env` | Pass the environment **id**, not its name: `list-environments` shows the GUID. `Default-<tenantGuid>` is also accepted. Previously this produced an opaque `ENOTFOUND` on `*.environment.api.powerplatform.com`. |
| `ENOTFOUND *.environment.api.powerplatform.com` | Almost always a malformed environment id (see above); occasionally a network/proxy block | Run `doctor`. If the id is a bare tenant GUID, use `Default-<tenantGuid>` instead. |
| `EnvironmentAccessDenied` / `ServiceToServiceEnvironmentNotFound` on a Flow, Dataverse, Graph, or API Hub request | Identity or access problem on the Azure CLI-backed request path | Run `whoami` and confirm the active Azure CLI account. If it is wrong, use `az login` or `az account set`, then `reconnect` to clear stale tokens. If it is correct, investigate resource access. `switch_account` does not change the Azure CLI identity. |
| The same errors on a Connectivity connection-management request | Identity or access problem on the separate MSAL-backed request path | Run `list_accounts` to inspect the effective Connectivity identity. If it is wrong, use `switch_account`; if it is correct, investigate environment/connection permissions. `reconnect` clears credentials but does not grant access. |
| Calls still succeed as the *old* account after `az login` | Stale disk token entry | Fixed: cache entries are now stamped with the active `az` identity and are rejected on mismatch. If you still see it, run `reconnect`. |
| `az` account looks right but FlowAgent disagrees | `AZURE_CONFIG_DIR` points at a different CLI profile | `whoami` reports the profile directory in use; `doctor` flags a custom `AZURE_CONFIG_DIR`. |
| `token-cache-clear-failed` | An explicit credential reset could not enumerate or delete cache files | Read the failed path in the error, close competing processes or fix directory permissions, then retry `reconnect` or `switch_account`. A persisted account preference alone does not mean credentials were reset. |
| `auth-reset-required` | A token request crossed an account-reset boundary, or an earlier reset failed | Retry after the reset finishes. If cleanup failed, correct its reported cause and complete a new reset first; the provider will not silently reuse stale credentials. |
| `DataversePickerUnavailable` / `DataverseLogicalNamesUnavailable` | The selected picker schema or logical-name metadata is unavailable | Inspect `get_operation_details` and `resolve_params` for the same environment, connection and organization. This is not evidence that the table is absent. |
| `DataverseDiscoveryIncomplete` / `DataverseDiscoveryChanged` | Table discovery is incomplete or changed between related reads | Retry with the intended organization and a working connection. Do not infer absence, uniqueness, or a need to recreate a table. |
| `ResponseTooLarge` | The response cannot fit without losing data | No partial success payload is returned. Use `resolve_params` filtering/paging, or `get_flow` with a supported `properties.definition...` path. |
| `DiscoveryChanged` | A discovery cursor was used with different arguments or the catalog changed | Restart without `cursor`, then keep the environment, connector, operation, connection, inputs, parameter and query unchanged across pages. |
| `DynamicPickerContinuationUnsupported` | An upstream continuation changes the authenticated origin/picker path, or an opaque token has no unambiguous schema-declared paging parameter | Do not infer absence. Use the connector's documented scoped discovery operation; the client will not guess a token binding or forward credentials to another origin. |
| `DynamicPickerPaginationLimit` / `DynamicPickerPaginationLoop` | Service discovery exceeded a bound or repeated a continuation | Narrow the connector inputs or investigate the upstream paging response. No complete catalog is returned for a failed collection. |
| `OperationDiscoveryUnavailable` | The per-environment PPAPI endpoint needed by operation search/schema discovery is unavailable | Check the environment ID, configured cloud and network/DNS access. These operations have no classic Flow RP fallback implemented in this client. |
| `UnsupportedCloudConfiguration` with `PA_CLOUD=dod` | No explicit DoD Flow token audience was configured | Set `PA_FLOW_RESOURCE` to an operator-verified audience. DoD has no guessed built-in Flow audience. |
| Machine-group calls return `400` on `$select` | Old builds selected a non-existent `grouptype` column | Fixed — the real column is `flowgrouptype` (label `flowgrouptypename`). Rebuild/update the plugin. |

## Auth and identity diagnostics

FlowAgent uses Azure CLI for Flow, Dataverse and Graph calls, and a separate
MSAL sign-in for Connectivity. A mismatch can surface as a permission or
environment error. These tools distinguish the effective identity from the
inventory of historical cached accounts:

Determine the failed request's auth path first; the error code alone does not
identify which account needs attention. `switch_account` changes only the
Connectivity preference, not the Azure CLI account.

| Tool | Use it when |
|------|-------------|
| `whoami` | Shows the active `az` account, CLI profile dir, cloud, token identity and `effectiveConnectivityIdentity`. `connectivityIdentity` remains the full cached-account inventory. |
| `reconnect` | After `az login` / `az account set` switched accounts, or when a stale token is causing 401/403. Clears cached tokens and re-acquires. |
| `doctor` | Full checklist, including effective Connectivity username and tenant versus `az`. Different users within one tenant fail this check; inactive cache entries alone do not. |
| `list_accounts` | Lists cached accounts separately from `effectiveConnectivityIdentity`, plus the stored preference and effective `nextSignIn` settings. Acquires no token. |
| `switch_account` | Clears the cached sign-in and saves a username preference; omit `username` to clear it. Check `preferencePersisted` and `nextSignIn` before assuming the requested account will be targeted. |

Interactive selection follows `PA_LOGIN_HINT`, then the stored preference,
then `PA_NO_ACCOUNT_PICKER`, then the default picker. Environment overrides
still apply after `switch_account` or `reconnect`; reconnect preserves the
stored preference.
Reset is awaited before reacquisition. `reconnect` clears all Azure CLI resource
tokens, including Graph, API Hub and Dataverse, rather than only the Flow token.
The returned counts describe files actually removed. Failed credential removal
is reported as an error and must not be interpreted as a completed account switch.

## Dataverse discovery and complete responses

`resolve_entity` uses the Dataverse operation's schema-driven `entityName`
picker. For a selected organization, pass
`dependencies: {"organization": "https://contoso.crm.dynamics.com"}` along with
the intended environment and existing connection. When omitted, the organization
is discovered from that environment's linked Dataverse instance, rather than
assuming a generic connection has an organization bound to it. Logical names, connector
values and display labels are matched without guessing plural forms; the
returned value is the connector's value, which may differ from the logical name.
Raw metadata paths accept the service's camelCase keys when the connector schema
declares the corresponding PascalCase paths.
Authorization, malformed-response and incomplete-discovery errors are tool
errors, not `not-found`.

To inspect a large picker through MCP, use `resolve_params` with
`parameter: "entityName"`, an optional `query`, and `pageSize` from 1 to 500.
Use `operation: "ListRecordsWithOrganization"` and
`currentInputs: {"organization": "https://contoso.crm.dynamics.com"}` when
selecting an organization. Repeat the same request with `_page.nextCursor`
as `cursor` until `_page.hasMore` is false.

Supported service continuations are retrieved before local response paging:
HTTPS next links must keep the authenticated origin and picker path, and opaque
tokens must map to a schema-declared paging parameter (`continuationToken`, or
`pageToken`/`nextPageToken` for a returned `nextPageToken`). Discovery is bounded
to 100 upstream pages, 100,000 values and 10,000,000 serialized characters.
Unsupported continuations and exceeded bounds produce explicit errors instead
of discarding the continuation or reporting a complete first page.

`_page.returned` counts entries in the current response; `_page.available`
counts matching entries observed from the service. `_page.total` is `null`
when discovery is incomplete. `_page.sourceComplete` must be true before
absence can be inferred. `_page.complete` means the current response contains
the entire filtered result, not that the current page is valid; later pages can
therefore have `complete: false` with `hasMore: false`. A requested page can
shrink to keep the returned JSON within the response-size limit.

Small, healthy, unfiltered responses keep their existing envelope. Oversized
results are never sliced into malformed JSON or described as a full result
saved elsewhere.

## Diagnostic Steps

1. **Get recent failed run**:
   ```bash
   node dist/cli.js get-run-history --env=$ENV --flow=$FLOW --top=5
   ```

2. **Get action-level details**:
   ```bash
   node dist/cli.js get-run-actions --env=$ENV --flow=$FLOW --run=$RUN
   ```

3. **Check flow definition**:
   ```bash
   node dist/cli.js get-flow --env=$ENV --flow=$FLOW
   ```

4. **Validate before creating**:
   ```bash
   node dist/cli.js validate-flow --definition=@flow.json --connection-refs=@refs.json
   ```
