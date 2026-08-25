---
name: setup-push-service-account
description: Use when validating, reusing, or provisioning the managed Function compatibility sender-auth stage for a Power Apps mobile push sender that calls an Entra-protected Azure Function and uses an existing Firebase service-account JSON stored in Azure Key Vault. Owns only this sender-auth handoff, not client integration, flows, wrapped builds, installation, or delivery. Never create or download a Firebase Admin key.
user-invocable: true
allowed-tools: Read, Edit, Write, Grep, Glob, Bash, AskUserQuestion, mcp__azure__subscription, mcp__azure__group, mcp__azure__role, mcp__azure__functionapp, mcp__azure__appservice
model: opus
---

**Shared instructions: [shared-instructions.md](${PLUGIN_ROOT}/shared/shared-instructions.md)** — read first.

**Sender-auth handoff: [sender-auth-contract.md](${PLUGIN_ROOT}/shared/references/sender-auth-contract.md)**.

**Function security and proof: [function-endpoint.md](${PLUGIN_ROOT}/skills/setup-push-service-account/references/function-endpoint.md)**.

**Official MCP readiness: [official-mcp-servers.md](${PLUGIN_ROOT}/shared/references/official-mcp-servers.md)** —
use the `/setup-push-service-account` row as a hard preflight for required
Azure MCP availability.

# Set up an FCM service-account Function endpoint

Set up the compatibility sender path:

`Power Automate invoke identity -> Entra-protected Azure Function -> managed identity -> Key Vault -> Google OAuth -> FCM HTTP v1`

## MCP readiness gate

Before any Azure MCP inventory or read-back in this workflow, verify the
official MCP surface required by `/setup-push-service-account`. If the `azure`
server is missing, disconnected, or any required tool from the shared
official-MCP readiness table is unavailable, STOP and give these Copilot CLI
steps in this exact order:

```text
/mcp
/setup
/restart
/mcp
```

Require the second `/mcp` check to show `azure` connected with the required
tools before continuing. Do not silently replace covered Azure MCP reads with
`az`; only the documented post-readiness safe gaps remain on the `az` path.

This path is for organizations that already possess a Firebase service-account
JSON and cannot yet use `/setup-push-wif`. Prefer WIF for new deployments because
this mode retains a long-lived Google private key in Key Vault.

Use Azure MCP and `az` with a narrow coverage policy:

- **Pinned versions for this workflow** — target `@azure/mcp@2.0.5`. This
  compatibility path does not adopt Azure MCP 3.x beta semantics.
- **Azure MCP covered reads/settings** — Azure MCP GA `2.0.5` runs in
  namespace mode in this plugin. Relevant namespaces here are
  `mcp__azure__subscription`, `mcp__azure__group`, `mcp__azure__role`,
  `mcp__azure__functionapp`, and `mcp__azure__appservice`. Use the namespace
  tool plus routed command/parameters:
  `mcp__azure__functionapp` for `functionapp_get`,
  `mcp__azure__appservice` for the documented
  webapp/deployment/appsettings/diagnostic read-back surfaces, and
  `mcp__azure__role` for `role_assignment_list`. Do not rely on nonexistent
  names such as `mcp__azure__azmcp_functionapp_get`,
  `mcp__azure__azmcp_role_assignment_list`, `functionapp_list`, or
  `keyvault_secret_list`.
- **Do not use secret-returning Key Vault MCP tools here** — Azure MCP GA
  `2.0.5` docs/source show only value-carrying Key Vault secret operations and
  no safe metadata-only route for this workflow. The plugin therefore does not
  expose the `keyvault` namespace; keep sender-auth Key Vault work on the
  documented secret-safe `az` path.
- **Narrow `az` exceptions only** — keep `az` for Entra
  app/service-principal/credential work, the non-echoing
  `az keyvault secret set --file` upload, metadata-only Key Vault queries, and
  proven unsupported Function edges from Azure MCP GA `2.0.5` docs/source:
  exact resource ID/identity-principal discovery, authsettingsV2 read/write,
  managed-identity enablement, Function creation/deployment, and other
  unsupported Function/App Service mutations. Do not silently fall back to `az`
  for covered Azure MCP reads/settings.

This compatibility path performs no Google Cloud resource administration. Do
not introduce `gcloud`, Firebase Admin key creation, or Google MCP operations
here.

## Non-negotiable credential boundary

- Never create, download, rotate, display, parse, validate, copy, or delete a
  Firebase Admin/service-account key.
- Never read the existing JSON file with `Read`, shell text commands, Node,
  Python, `jq`, or an editor. Do not put it in the repository, flow definition,
  environment variables, command output, `memory-bank.md`, or handoff.
- The only permitted local-key operation is a user-approved, non-echoing
  `az keyvault secret set --file "<existing-path>" --output none`. The path must
  be outside the app and Function scaffold repositories.
- The Function reads one named secret through its managed identity, parses it
  only in process memory, and uses `google-auth-library` to mint short-lived
  OAuth access tokens.

If the user does not already have the JSON, return:

```text
BLOCKED: This compatibility path requires an existing Firebase service-account
JSON. This skill will not create or download one. Use /setup-push-wif for a
keyless sender or have an authorized administrator provision the existing
credential outside this workflow.
```

## 1. Establish identity and scope

Read `memory-bank.md`, `sender-auth.json` if present, and the Function reference.
Verify the active Azure account and subscription. Collect:

- Firebase project ID;
- existing Function endpoint or proposed resource group, Function name, region,
  storage account, and deployment directory;
- Entra tenant, endpoint application ID, resource audience, and the exact
  application ID used by the Power Automate connection to invoke the endpoint;
- Key Vault URI/name and one secret name;
- Function resource ID and managed-identity principal ID;
- Power Platform connection reference name and Azure connection resource ID;
- approved deep-link prefixes and exact generic title/body pairs.

Do not infer the flow invoke identity from the maker, owner, operator, Function,
or Key Vault principal. Require its exact Entra application ID.

Offer exactly two paths:

1. **Validate/reuse** an existing endpoint without changing it.
2. **Scaffold/deploy** the bundled Function. Show the full resource, identity,
   RBAC, auth, app-setting, and deployment plan and obtain explicit confirmation
   before any Azure mutation, secret upload, or deployment.

## 2A. Validate and reuse an existing endpoint

Perform every read-back in `references/function-endpoint.md`. Require:

- HTTPS endpoint with no query, fragment, or embedded credentials;
- Entra authentication enabled, unauthenticated requests rejected with 401,
  the exact resource audience allowed, and the exact flow caller application
  allowlisted;
- a system-assigned or dedicated user-assigned Function identity;
- `Key Vault Secrets User` at the one-secret scope when supported, otherwise
  the vault scope with the wider scope explicitly reported;
- no flow/operator identity with Key Vault secret read access unless separately
  justified;
- the Firebase service account has only a role containing
  `cloudmessaging.messages.create` on the intended Firebase project;
- Function settings contain references and policy only, never JSON, private
  keys, tokens, or authorization headers.

Do not repair or broaden an existing endpoint in this path. Report mismatches
and offer the confirmed scaffold/deploy path.

## 2B. Scaffold and deploy after confirmation

After explicit confirmation, scaffold into a new project-local directory:

```bash
node "${PLUGIN_ROOT}/scripts/scaffold-push-service-account-function.js" \
  --project-root "<working_dir>" \
  --destination "<relative-function-directory>"
```

Review and set only the non-secret app settings described in the reference.
Run the scaffold's offline tests before deployment:

```bash
cd "<function-directory>"
npm install
npm test
```

Use Azure MCP for the covered inventory/read-back/settings steps and use `az`
only for the approved unsupported Function edges above. Enable managed
identity, assign only the narrow Key Vault secret-read role, configure
authsettingsV2 to return 401 and allow only the exact audience/caller
application, then deploy. Read every setting and role back after mutation; do
not substitute broad Azure CLI inventory for an available Azure MCP
read/settings operation.

### Existing-key upload

The agent must not inspect the file. After separate explicit confirmation, use
a command shaped exactly like this with shell tracing disabled:

```bash
set +x
az keyvault secret set \
  --vault-name "<vault-name>" \
  --name "<secret-name>" \
  --file "<absolute-existing-json-path-outside-repositories>" \
  --output none
unset EXISTING_FIREBASE_JSON_PATH
```

The command must emit no secret value. Verify existence with metadata only:

```bash
az keyvault secret show \
  --vault-name "<vault-name>" \
  --name "<secret-name>" \
  --query '{id:id,enabled:attributes.enabled}' \
  --output json
```

Never use `az keyvault secret show --query value`, shell substitution, stdin
echo, or a temporary file.

## 3. Prove authorization and non-delivery

Use the intended Power Automate connection/invoke identity—not merely the
signed-in deployer—to call the endpoint with:

```json
{
  "topic": "allUsers",
  "title": "You have a new notification.",
  "body": "Open the app to view it.",
  "schemaVersion": "1",
  "deepLink": "/notifications",
  "validateOnly": true
}
```

Use an approved title/body and deep link from the deployed policy. Keep the
Entra access token and authorization header out of argv, logs, files, and
captured output. Require all four proof steps:

1. the intended flow identity receives an authorized response while an
   unauthenticated request receives 401;
2. the Function managed identity reads exactly the named Key Vault secret;
3. Google OAuth token minting succeeds using the in-memory credential;
4. FCM accepts `validate_only: true`, proving permission without delivery.

Also submit safe negative probes for an uppercase OID topic, unapproved
title/body, schema version, external/traversal deep link, and unknown field.
Each must fail before FCM with a bounded sanitized error. Never use a live send
as setup proof.

## 4. Emit the handoff only after complete proof

Write `sender-auth.json` only after every read-back and proof succeeds. Use the
version 1 `function-endpoint` shape in the sender-auth reference. Set:

- `proof.verifier` to `setup-push-service-account`;
- `verifiedAt` to the proof completion time;
- `validUntil` no more than 24 hours later;
- all four Function proof steps to `true`.

Include only safe resource identifiers. Do not include Key Vault URI/secret
name, service-account email/JSON, keys, tokens, auth headers, caller secrets,
app settings, or response bodies.

Validate the handoff:

```bash
node "${PLUGIN_ROOT}/scripts/validate-sender-auth-contract.js" \
  --project-root "<working_dir>" \
  --file sender-auth.json \
  --expected-firebase-project "<firebase-project-id>"
```

Update `memory-bank.md` with only the handoff path/mode, Firebase project,
Function/connection resource IDs, proof time, and statement that no credential
was persisted. Track every local file changed and run the mandatory explicit
changed-file validator before reporting success.

## Stop conditions

Return `BLOCKED` and do not emit the handoff when any identity is ambiguous,
Entra auth is broader than the intended caller, the secret/RBAC scope cannot be
proved, the Firebase project or permission is wrong, any proof step fails, or a
credential appears in output or a local artifact.
