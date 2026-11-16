# Server Logic Secrets Workflow

Read only when the approved implementation requires secrets or sensitive configuration.

## Phase 7: Manage Secrets & Environment Variables

**Goal**: Securely store any secret values (API keys, client secrets, connection strings) required by the server logic as environment variables in Dataverse, optionally backed by Azure Key Vault

**This phase only runs when the server logic requires secret or sensitive configuration values** (identified in Phase 2.3). If no secrets are needed, skip this phase and proceed to Phase 8.

**Actions**:

### 7.1 Recall Key Vault Decision

The user already chose whether to use Azure Key Vault in Phase 2.3.1 (before the plan was presented). Use that decision here - do **not** re-ask.

### 7.2a Azure Key Vault Path

If the user chose Azure Key Vault in Phase 2.3.1:

**Step 1 - List available Key Vaults:**

```bash
node "${PLUGIN_ROOT}/scripts/list-azure-keyvaults.js"
```

The script outputs a JSON array of Key Vaults (`name`, `resourceGroup`, `location`) from the user's Azure subscription.

**Step 2 - Select or create a Key Vault:**

If Key Vaults were found, present the list and ask which one to use:

<!-- not-a-gate: Key Vault selection - data-gathering for the secret-store call under the Phase 2.3.1 Key Vault branch -->

Ask the user:

| Question | Context |
|----------|---------|
| Which Azure Key Vault would you like to use for storing secrets? | Present the names from the script output |

If **no Key Vaults are found**, ask the user how to proceed:

<!-- gate: add-server-logic:7.2a.no-vaults | category=plan | cancel-leaves=nothing -->

> 🚦 **Gate (plan · add-server-logic:7.2a.no-vaults):** No Key Vaults found in the user's subscription - create one or fall back to plain env vars. Branches the secret-storage flow.
>
> **Trigger:** Phase 2.3.1 chose Key Vault but `list-azure-keyvaults.js` returned an empty list.
> **Why we ask:** Auto-creating a Key Vault provisions Azure resources without explicit consent; auto-falling-back stores secrets as plain env vars after the user explicitly opted in to Key Vault.
> **Cancel leaves:** Nothing - no Azure or Dataverse writes yet.

Ask the user:

| Question | Options |
|----------|---------|
| No Azure Key Vaults were found in your subscription. Would you like to create one, or fall back to storing secrets directly as environment variables? | Create a new Key Vault (Recommended), Store directly as environment variable |

**If "Create a new Key Vault"**: Ask for a vault name, resource group, and location, then create it:

<!-- not-a-gate: Key Vault provisioning parameters - data-gathering for the create-azure-keyvault.js call under the Phase 7.2a "Create new" path -->

Ask the user:

| Question | Context |
|----------|---------|
| What name, resource group, and Azure region would you like for the new Key Vault? | Vault names must be 3-24 characters, globally unique, start with a letter, and contain only alphanumerics and hyphens. Suggest a name based on the project/site name. |

```bash
node "${PLUGIN_ROOT}/scripts/create-azure-keyvault.js" \
  --name "<vault-name>" \
  --resourceGroup "<resource-group>" \
  --location "<location>"
```

The script outputs a JSON object with `name`, `resourceGroup`, and `location`. Use the created vault for the remaining steps.

**If "Store directly as environment variable"**: Skip the rest of Phase 7.2a and proceed to Phase 7.2b (direct environment variable path).

**Step 3 - Provide instructions for storing each secret in Key Vault:**

For each secret identified in Phase 2.3, give the user instructions to store the value themselves. Do **not** ask for the secret value - secret values must never pass through the conversation.

Present **both** methods (CLI and Azure Portal) so the user can choose whichever they prefer:

**Option A - Azure CLI (recommended for automation):**

Present the commands as a numbered list the user can copy and run. Use the stdin form so the secret value does not appear in process listings:

```
For each secret, run the following command (replacing <YOUR_SECRET_VALUE> with the actual value):

1. <secret-name>:
   printf '%s' '<YOUR_SECRET_VALUE>' | node "${PLUGIN_ROOT}/scripts/store-keyvault-secret.js" \
     --vaultName "<selected-vault>" \
     --secretName "<secret-name>"
```

Tell the user each command outputs a JSON object with a `secretUri` and to share the output (which contains only the URI, not the secret) so the workflow can continue.

**Option B - Azure Portal:**

Provide these steps for each secret:

```
1. Go to the Azure Portal (https://portal.azure.com)
2. Search for "Key vaults" in the top search bar and select it
3. Select the Key Vault: <selected-vault>
4. In the left menu under "Objects", click "Secrets"
5. Click "+ Generate/Import" at the top
6. Fill in the fields:
   - Upload options: Manual
   - Name: <secret-name>
   - Secret value: paste your secret value here
   - Leave other fields as defaults
7. Click "Create"
8. After creation, click on the secret name, then click the current version
9. Copy the "Secret Identifier" URI and share it here so the workflow can continue
```

Tell the user the Secret Identifier URI looks like `https://<vault-name>.vault.azure.net/secrets/<secret-name>/<version>` and that this URI (not the secret value) is what should be shared back.

**Step 4 - Create environment variable in Dataverse:**

After the user shares the `secretUri` output from each command, create an environment variable definition in Dataverse that references the Key Vault secret. Use the `secret` type:

```bash
node "${PLUGIN_ROOT}/scripts/create-environment-variable.js" "<ENV_URL>" \
  --schemaName "<prefix_SecretName>" \
  --displayName "<Secret Display Name>" \
  --type "secret" \
  --value "<secretUri-from-step-3>"
```

**Step 5 - Create site setting for the environment variable:**

For each environment variable, create a site setting YAML that maps to it:

```bash
node "${PLUGIN_ROOT}/scripts/create-site-setting.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --name "<SiteSetting/Name>" \
  --envVarSchema "<schemaName-from-step-4>"
```

This creates a site setting with `envvar_schema` and `source: 1`, which tells Power Pages to resolve the value from the Dataverse environment variable (backed by Key Vault).

### 7.2b Direct Environment Variable Path

If the user chose not to use Azure Key Vault:

**Step 1 - Create environment variables with placeholder values:**

For each secret identified in Phase 2.3, create the environment variable in Dataverse with a placeholder value:

```bash
node "${PLUGIN_ROOT}/scripts/create-environment-variable.js" "<ENV_URL>" \
  --schemaName "<prefix_SecretName>" \
  --displayName "<Secret Display Name>" \
  --value "PLACEHOLDER_SET_ACTUAL_VALUE"
```

**Step 2 - Create site setting for the environment variable:**

```bash
node "${PLUGIN_ROOT}/scripts/create-site-setting.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --name "<SiteSetting/Name>" \
  --envVarSchema "<schemaName-from-step-1>"
```

**Step 3 - Give the user steps to set the actual secret values:**

Do **not** ask for secret values - they must never pass through the conversation. Instead, tell the user to update each placeholder with the real value using one of these approaches:

1. **Power Apps maker portal** ([make.powerapps.com](https://make.powerapps.com)) - Go to **Solutions** → **Default Solution** → **Environment variables** → find the variable by display name → update the value

Present the list of environment variables that need updating (display name and schema name for each) so the user knows exactly which ones to set.

### 7.3 Verify Environment Variable Configuration

After creating all environment variables and site settings:

- Confirm each site setting YAML was created in `.powerpages-site/site-settings/`
- Verify each YAML contains `envvar_schema` and `source: 1`
- Confirm the server logic code references the correct site setting names via `Server.Sitesetting.Get("<SiteSetting/Name>")`

### 7.4 Git Commit

Do a git commit for the environment variable site setting changes.

**Output**: Environment variables created in Dataverse (with or without Azure Key Vault backing), site settings configured, server logic referencing correct setting names

---
