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
