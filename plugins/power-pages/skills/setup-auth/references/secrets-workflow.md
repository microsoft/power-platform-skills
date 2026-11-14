# Secrets and solution membership

<!-- not-a-gate: vault selection is configuration within the approved authentication plan; obtain explicit consent before cloud resource creation. -->
Read `.solution-manifest.json` before creating environment variables and pass `solution.uniqueName` through `--solutionUniqueName`.
Without a manifest or explicit solution, ask the user to select a solution or run setup-solution; never silently select Default.
After new environment variables, prompt for setup-solution in sync mode to capture newly created records.

**Only run this phase if a provider requires a secret.** Skip entirely when none of the configured providers need one.

Providers that **may** require a secret:
- **OpenID Connect** - no secret in the default Web application `code id_token` flow; only an explicit confidential-client override needs one.
- **Entra External ID** - no secret by default; an explicit confidential-client override requires verified provider instructions and approval before using this workflow.
- **Microsoft Account / Facebook / Google** - yes (social OAuth requires app secret)
- **SAML2 / WS-Federation** - no (certificate-based, not secrets)
- **Local Authentication** - no
- **Microsoft Entra ID** - no (configured via Power Pages admin center)

**If no provider requires a secret, skip this entire phase 8.1.1 and proceed to the invitation block.**

For secrets (`ClientSecret`, `AppSecret`), **never store them in site setting YAML files or as plain-text environment variables**. Use Azure Key Vault to store secrets, then reference them via Dataverse environment variables with `--type secret`.

**Step 1 - List available Key Vaults:**

```bash
node "${PLUGIN_ROOT}/scripts/list-azure-keyvaults.js"
```

**Step 2 - Select or create a Key Vault:**

If Key Vaults were found, ask which one to use:

| Question | Context |
|----------|---------|
| Which Azure Key Vault would you like to use for storing auth secrets? | Present the names from the script output |

If **no Key Vaults are found**:

| Question | Options |
|----------|---------|
| No Azure Key Vaults were found. Would you like to create one? | Create a new Key Vault (Recommended), Skip Key Vault - I'll configure secrets later |

**If "Create a new Key Vault"**: Ask for vault name, resource group, and location:

```bash
node "${PLUGIN_ROOT}/scripts/create-azure-keyvault.js" \
  --name "<vault-name>" \
  --resourceGroup "<resource-group>" \
  --location "<location>"
```

If Key Vault is skipped, leave secret-dependent configuration deferred and report that the provider is not ready.
Never replace a secret with a plain-string environment variable.

**Step 3 - Instruct the user to store each secret in Key Vault:**

Do **not** ask for secret values - they must never pass through the conversation. Present **both** options:

**Option A - Azure CLI (recommended):**

```
For each secret, run the following command (replacing <YOUR_SECRET_VALUE> with the actual value):

1. <Provider> Client Secret:
   printf '%s' '<YOUR_SECRET_VALUE>' | node "${PLUGIN_ROOT}/scripts/store-keyvault-secret.js" \
     --vaultName "<selected-vault>" \
     --secretName "<provider>-client-secret"
```

Tell the user each command outputs a JSON object with a `secretUri` and to share the output so the workflow can continue.

**Option B - Azure Portal:**

```
1. Go to https://portal.azure.com → Key vaults → <selected-vault> → Secrets
2. Click "+ Generate/Import"
3. Name: <provider>-client-secret, Value: paste your secret
4. Click "Create", then click the secret → current version → copy "Secret Identifier" URI
5. Share the URI here so the workflow can continue
```

**Step 4 - Create environment variable in Dataverse (type: secret):**

After the user shares the `secretUri`, create an environment variable that references the Key Vault secret:

```bash
node "${PLUGIN_ROOT}/scripts/create-environment-variable.js" "<ENV_URL>" \
  --schemaName "<prefix_ProviderClientSecret>" \
  --displayName "<Provider> Client Secret" \
  --type "secret" \
  --value "<secretUri-from-step-3>" \
  --solutionUniqueName "<solution.uniqueName>"
```

**Step 5 - Create site setting for the environment variable:**

```bash
node "${PLUGIN_ROOT}/scripts/create-site-setting.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --name "Authentication/OpenIdConnect/{ProviderName}/ClientSecret" \
  --envVarSchema "<prefix_ProviderClientSecret>"
```

This creates a site setting with `envvar_schema` and `source: 1`, which tells Power Pages to resolve the value from the Dataverse environment variable (backed by Key Vault).

**Repeat Steps 3-5 for each secret required by the selected providers:**

| Provider | Secret Name | Site Setting | Env Var Schema |
|----------|-------------|--------------|----------------|
| OIDC / Entra External ID | `{provider}-client-secret` | `Authentication/OpenIdConnect/{ProviderName}/ClientSecret` | `{prefix}_ProviderClientSecret` |
| Facebook | `facebook-app-secret` | `Authentication/OpenAuth/Facebook/AppSecret` | `{prefix}_FacebookAppSecret` |
| Google | `google-client-secret` | `Authentication/OpenAuth/Google/ClientSecret` | `{prefix}_GoogleClientSecret` |
| Microsoft Account | `microsoft-client-secret` | `Authentication/OpenAuth/MicrosoftAccount/ClientSecret` | `{prefix}_MicrosoftClientSecret` |

If configuration is deferred, list the provider, required setting and intended environment-variable schema in the report.
Resume only when a Key Vault secret URI is available, using secret-typed variables in the selected solution.
