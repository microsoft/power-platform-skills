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

## AI Builder Prompt Action ("Run a prompt")

Uses Copilot credits. The `recordId` points to a saved `msdyn_aiconfiguration` record (a prompt you've created in AI Builder). The connector is Dataverse (`shared_commondataserviceforapps`) with the virtual operation `aibuilderpredict_customprompt`.

```json
{
  "type": "OpenApiConnection",
  "inputs": {
    "parameters": {
      "recordId": "<msdyn_aiconfiguration GUID>",
      "item/source": "{\"consumptionSource\":\"PowerAutomate\",\"partnerSource\":\"AIBuilder\",\"consumptionSourceVersion\":\"Flow\",\"partnerSourceVersion\":\"<flow-id>\"}"
    },
    "host": {
      "apiId": "/providers/Microsoft.PowerApps/apis/shared_commondataserviceforapps",
      "operationId": "aibuilderpredict_customprompt",
      "connectionName": "shared_commondataserviceforapps"
    }
  },
  "runAfter": {},
  "metadata": {
    "flowSystemMetadata": {
      "portalOperationId": "aibuilderpredict_customprompt",
      "portalOperationGroup": "aibuilder",
      "portalOperationApiDisplayNameOverride": "AI Builder",
      "portalOperationIconOverride": "https://content.powerapps.com/resource/makerx/static/pauto/images/designeroperations/aibuilderIcon2026.8e878397.png",
      "portalOperationBrandColorOverride": "#0A76C4",
      "portalOperationApiTierOverride": "Standard"
    }
  }
}
```

**Key details:**
- `recordId` — GUID of the AI configuration (prompt), NOT the AI model. Query: `GET /api/data/v9.2/msdyn_aiconfigurations?$filter=contains(msdyn_name,'<prompt name>')&$select=msdyn_aiconfigurationid,msdyn_name`
- `item/source` — consumption tracking JSON. `partnerSourceVersion` should be the flow's own ID (set after creation via `edit_flow`).
- `metadata.flowSystemMetadata` — required for the designer to render the action correctly as "AI Builder" instead of generic Dataverse.
- Output path: `outputs('Run_a_prompt')?['body/responsev2/predictionOutput/text']`
- Uses Dataverse connection (`shared_commondataserviceforapps`), counts as **Standard** tier (credits consumed from tenant Copilot pool).

### Inline Prompt (PerformBoundActionWithOrganization / QuickTest)

Alternative pattern where the prompt text is defined inline in the flow (not saved to AI Builder). More complex but doesn't require a pre-created prompt:

```json
{
  "type": "OpenApiConnection",
  "inputs": {
    "parameters": {
      "organization": "https://<org>.crm.dynamics.com/",
      "entityName": "msdyn_aiconfigurations",
      "actionName": "Microsoft.Dynamics.CRM.QuickTest",
      "recordId": "<msdyn_aiconfiguration GUID>",
      "item/version": "2.0",
      "item/requestv2": {
        "@@odata.type": "#Microsoft.Dynamics.CRM.expando",
        "$customConfig": {
          "@@odata.type": "#Microsoft.Dynamics.CRM.expando",
          "prompt@odata.type": "#Collection(Microsoft.Dynamics.CRM.expando)",
          "prompt": [
            { "@@odata.type": "#Microsoft.Dynamics.CRM.expando", "type": "literal", "text": "Your instruction here\n\n" },
            { "@@odata.type": "#Microsoft.Dynamics.CRM.expando", "type": "dynamic", "text": "@triggerBody()['input']" }
          ],
          "definitions": {
            "@@odata.type": "#Microsoft.Dynamics.CRM.expando",
            "output": { "@@odata.type": "#Microsoft.Dynamics.CRM.expando", "formats@odata.type": "#Collection(String)", "formats": ["text"] }
          },
          "version": "GptDynamicPrompt-2",
          "modelParameters": {
            "@@odata.type": "#Microsoft.Dynamics.CRM.expando",
            "modelType": "gpt-4o-mini",
            "gptParameters": { "@@odata.type": "#Microsoft.Dynamics.CRM.expando", "temperature": 0.2 }
          },
          "settings": { "@@odata.type": "#Microsoft.Dynamics.CRM.expando", "recordRetrievalLimit": 30 }
        }
      },
      "item/source": "{ \"consumptionSource\": \"Api\", \"partnerSource\": \"PowerAutomate\", \"consumptionSourceVersion\": \"GptApiClient\"}"
    },
    "host": {
      "apiId": "/providers/Microsoft.PowerApps/apis/shared_commondataserviceforapps",
      "operationId": "PerformBoundActionWithOrganization",
      "connectionName": "shared_commondataserviceforapps"
    },
    "retryPolicy": { "type": "none" }
  },
  "runAfter": {}
}
```

**Inline prompt details:**
- `prompt` array: mix of `literal` (static text) and `dynamic` (expressions) segments
- `modelParameters.modelType`: `"gpt-4o-mini"`, `"gpt-4o"`, `"claude-3-opus"`, etc.
- `recordId` here points to the `GptPromptEngineering` model (`msdyn_aimodel`), which you can find via: `GET /api/data/v9.2/msdyn_aimodels?$filter=msdyn_name eq 'GptPromptEngineering model'`
- Requires `organization` parameter (Dataverse instance URL)

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
