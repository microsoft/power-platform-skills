# Flow Definition Reference

## Required Structure

```json
{
  "$schema": "https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json#",
  "contentVersion": "1.0.0.0",
  "parameters": {
    "$authentication": { "defaultValue": {}, "type": "SecureObject" },
    "$connections": { "defaultValue": {}, "type": "Object" }
  },
  "triggers": { ... },
  "actions": { ... }
}
```

## Common Triggers

**Manual (Button)**
```json
{ "type": "Request", "kind": "Button", "inputs": { "schema": { "type": "object" } } }
```

**Recurrence (Scheduled)**
```json
{ "type": "Recurrence", "recurrence": { "frequency": "Day", "interval": 1 } }
```

**HTTP Request**
```json
{ "type": "Request", "kind": "Http", "inputs": { "schema": { "type": "object", "properties": { ... } } } }
```

## Action Template (OpenApiConnection)

```json
{
  "type": "OpenApiConnection",
  "inputs": {
    "parameters": { "param1": "value1" },
    "host": {
      "apiId": "/providers/Microsoft.PowerApps/apis/shared_teams",
      "operationId": "PostMessageToConversation",
      "connectionName": "shared_teams"
    }
  },
  "runAfter": {}
}
```

## Other Action Types

- `Compose`: `{ "type": "Compose", "inputs": "<expression>" }`
- `Http`: `{ "type": "Http", "inputs": { "method": "GET", "uri": "..." } }`
- `If`: `{ "type": "If", "expression": { ... }, "actions": { ... }, "else": { "actions": { ... } } }`
- `Foreach`: `{ "type": "Foreach", "foreach": "@...", "actions": { ... } }`
- `Response`: `{ "type": "Response", "inputs": { "statusCode": 200, "body": "@..." } }`

## Expression Syntax

- String interpolation: `@{triggerBody()?['name']}`
- Functions: `concat()`, `formatDateTime()`, `utcNow()`, `body('<action>')`, `outputs('<action>')`
- Null handling: `coalesce()`, `if()`, `equals()`
- Connection ref: `@parameters('$connections')['shared_teams']['connectionId']`

## Validation Rules (checked by `validate-flow`)

1. Declare both `$authentication` and `$connections` in `parameters`
2. Use `"type": "OpenApiConnection"` (NOT `ApiConnection`)
3. Do NOT add `"authentication"` to action inputs (auto-injected by PA)
4. `host.connectionName` must match a key in connection references
5. `runAfter` must reference existing action names
6. No `@odata.bind` parameter suffixes

## Dynamic Parameters

Parameters may have annotations from the connector swagger:
- `dynamicValues` — valid values from calling another operation (dropdown)
- `dynamicTree` — tree browser with `open`/`browse` operations (file picker)
- `dynamicSchema` — schema determined dynamically (varies by selection)

Use `get-connector`, then `invoke-operation` or `resolve-params` to resolve these.
