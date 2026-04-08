# Server Logic Plan Data Format

Reference document for generating the HTML server logic plan using `render-serverlogic-plan.js`.

## Determine Output Location

- **If working in the context of a website** (a project root with `powerpages.config.json` exists): write the file to `<PROJECT_ROOT>/docs/serverlogic-plan.html`
- **Otherwise**: write to the system temp directory (`[System.IO.Path]::GetTempPath()`)

## Prepare Data

Write a temporary JSON data file with these keys:

```json
{
  "SITE_NAME": "The site name from powerpages.config.json or the project folder",
  "PLAN_TITLE": "A short plan title such as 'Server Logic Plan'",
  "SUMMARY": "A 1-2 sentence summary of what this endpoint will do and why",
  "WEB_ROLES_DATA": [],
  "SERVER_LOGICS_DATA": [],
  "RATIONALE_DATA": [],
  "SECRETS_DATA": null
}
```

### WEB_ROLES_DATA Format

```json
[
  {
    "id": "role-authenticated",
    "name": "Authenticated Users",
    "desc": "Built-in role for signed-in users.",
    "builtin": true,
    "isNew": false,
    "color": "#8890a4"
  }
]
```

### SERVER_LOGICS_DATA Format

```json
[
  {
    "id": "ticket-dashboard",
    "name": "ticket-dashboard",
    "displayName": "Ticket Dashboard",
    "status": "create",
    "apiUrl": "https://<site-url>/_api/serverlogics/ticket-dashboard",
    "webRoles": [
      {
        "id": "role-authenticated",
        "reasoning": "Authenticated users need access because the dashboard is part of the signed-in support workspace."
      }
    ],
    "rationale": "Keeps Dataverse queries and shaping logic off the client while enforcing role-scoped access.",
    "functions": [
      {
        "name": "get",
        "purpose": "Return dashboard metrics",
        "reasoning": "The dashboard is read-heavy, so GET keeps the endpoint simple and cache-friendly."
      }
    ]
  }
]
```

Use `status` values like `create`, `update`, or `reuse`.

Each `webRoles` entry should explain **why that specific role is assigned to that specific server logic**.

Each `functions` entry should explain **why that specific function is being implemented for that specific server logic**.

When a server logic item wraps a Dataverse custom action (mapped in Phase 2.1.2), include a `customAction` object:

```json
{
  "id": "calculate-discount",
  "name": "calculate-discount",
  "displayName": "Calculate Discount",
  "status": "create",
  "customAction": {
    "name": "new_CalculateDiscount",
    "displayName": "Calculate Discount",
    "type": "action",
    "binding": "entity",
    "boundEntity": "salesorder"
  },
  "...": "other fields as above"
}
```

| Field | Description |
|-------|-------------|
| `customAction` | *(Optional)* Present only when the server logic wraps a Dataverse custom action |
| `customAction.name` | The unique name of the custom action (used in `InvokeCustomApi`) |
| `customAction.displayName` | Human-readable display name |
| `customAction.type` | `action` (POST) or `function` (GET) |
| `customAction.binding` | `unbound`, `entity`, or `entityCollection` |
| `customAction.boundEntity` | *(Optional)* Logical name of the bound entity, if applicable |

When `customAction` is present, the plan HTML renders a badge on the server logic card indicating that it wraps an existing Dataverse custom action. When `customAction` is absent or `null`, no badge is shown.

### RATIONALE_DATA Format

```json
[
  {
    "icon": "🛡️",
    "title": "Why this structure",
    "desc": "Separate server logic files keep responsibilities focused and make role assignment clearer."
  }
]
```

The overview tab renders these rationale items in the same style as the other Power Pages plan documents.

### SECRETS_DATA Format

Set to `null` when the server logic does not require any secrets. When the user has chosen to use Azure Key Vault, provide an object:

```json
{
  "useKeyVault": true,
  "vaultName": "contoso-keyvault",
  "secrets": [
    {
      "name": "ExchangeRateApiKey",
      "purpose": "API key for the exchange rate service",
      "siteSetting": "ExternalApi/ExchangeRateApiKey",
      "serverLogicId": "exchange-rate"
    }
  ]
}
```

| Field | Description |
|-------|-------------|
| `useKeyVault` | `true` if the user chose Azure Key Vault; omit or set `false` for direct env vars |
| `vaultName` | *(Optional)* Name of the selected/created Key Vault — shown in the plan if known |
| `secrets[].name` | Descriptive name for the secret (e.g., `ExchangeRateApiKey`) |
| `secrets[].purpose` | Why the secret is needed |
| `secrets[].siteSetting` | The site setting name the server logic reads via `Server.Sitesetting.Get()` |
| `secrets[].serverLogicId` | The `id` (or `name`) of the server logic item that uses this secret — links the secret to the correct card in the plan |

When `useKeyVault` is `true`, the plan HTML renders a prominent banner in the Overview tab explaining that secrets are stored in Azure Key Vault and why it matters (centralized access control, audit logging, rotation support, secrets never in code). Each server logic card also shows the secrets it depends on.

When `SECRETS_DATA` is `null` or `useKeyVault` is `false`, the banner and per-card secrets sections are hidden.

## Render the HTML File

Do **not** write the HTML manually. Use the render script:

```powershell
node "${CLAUDE_PLUGIN_ROOT}/scripts/render-serverlogic-plan.js" --output "<OUTPUT_PATH>" --data "<DATA_JSON_PATH>"
```

The render script refuses to overwrite existing files. Before calling it, check if the default output path (`<PROJECT_ROOT>/docs/serverlogic-plan.html`) already exists. If it does, choose a new descriptive filename based on context — e.g., `serverlogic-plan-exchange-rate.html`, `serverlogic-plan-apr-2026.html`. Pass the chosen name via `--output`.

Delete the temporary data JSON file after the script succeeds.

## Open in Browser

Open the generated HTML file in the user's default browser.
