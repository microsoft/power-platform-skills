# Common API Errors & Fixes

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
| `DirectApiAuthorizationRequired` / `MisMatchingOAuthClaims` | Ran a `PowerApps` / `PowerAppsV2` trigger **with a body**. These Direct-API triggers require SAS + an OAuth token identifying the Power Apps runtime, which a user token cannot present. | Surfaced as `DirectApiTriggerInputsUnsupported`. Run the flow **without** a body (inputs will be null — the designer's Test button behaves identically), run it from the Power App, or use `get-past-trigger-inputs` + `resubmit-run`. |
| `TriggerInputMissing` | A non-Direct-API trigger body is missing keys listed in the trigger schema `required[]` | The error lists the missing keys and expected shape; pass them via `--body=@file`. Not raised for `PowerApps` / `PowerAppsV2`, where a bodyless run is legal. |
| `InvalidEnvironmentId` | An environment id that is not a GUID (e.g. a display name or a slug) was passed to `--env` | Pass the environment **id**, not its name: `list-environments` shows the GUID. `Default-<tenantGuid>` is also accepted. Previously this produced an opaque `ENOTFOUND` on `*.environment.api.powerplatform.com`. |
| `ENOTFOUND *.environment.api.powerplatform.com` | Almost always a malformed environment id (see above); occasionally a network/proxy block | Run `doctor`. If the id is a bare tenant GUID, use `Default-<tenantGuid>` instead. |
| `EnvironmentAccessDenied` / `ServiceToServiceEnvironmentNotFound` | FlowAgent is authenticated as a different account than intended, or a cached token outlived an `az logout`/`az login` | Run `whoami` to see the active identity, then `reconnect` to clear cached tokens and re-acquire. No session restart needed. |
| Calls still succeed as the *old* account after `az login` | Stale disk token entry | Fixed: cache entries are now stamped with the active `az` identity and are rejected on mismatch. If you still see it, run `reconnect`. |
| `az` account looks right but FlowAgent disagrees | `AZURE_CONFIG_DIR` points at a different CLI profile | `whoami` reports the profile directory in use; `doctor` flags a custom `AZURE_CONFIG_DIR`. |
| Machine-group calls return `400` on `$select` | Old builds selected a non-existent `grouptype` column | Fixed — the real column is `flowgrouptype` (label `flowgrouptypename`). Rebuild/update the plugin. |

## Auth and identity diagnostics

FlowAgent rides whichever identity the Azure CLI is signed in as. When that is
not the intended account, failures surface as permission or DNS errors that
never mention identity. Three tools make it visible and recoverable in-session:

| Tool | Use it when |
|------|-------------|
| `whoami` | First stop for any auth-shaped failure — shows the active `az` account, the CLI profile dir (honours `AZURE_CONFIG_DIR`), the resolved cloud, the token cache location, and the tenant the token actually carries. |
| `reconnect` | After `az login` / `az account set` switched accounts, or when a stale token is causing 401/403. Clears cached tokens and re-acquires. |
| `doctor` | Full checklist: CLI present, signed in, config dir, cloud, token acquisition, token-vs-`az` identity agreement, current environment, environment reachability — each with a concrete fix. |

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
