# Push sender authentication options

Use this comparison before choosing how a Power Automate sender authenticates
to FCM HTTP v1. The native Firebase project and privacy-safe outbox contract are
the same for every option, but the required infrastructure, credential model,
licensing, and operational ownership differ.

| Option | Additional resources | Credential and security model | Plugin ownership | Best fit |
| --- | --- | --- | --- | --- |
| **Workload Identity Federation (Recommended)** | Dedicated Entra app/service principal and credential; Azure Key Vault secret plus data-plane RBAC for the Power Automate Key Vault connection identity; Google Workload Identity Pool and Provider; dedicated Google sender service account; least-privilege FCM role/IAM bindings; Power Automate Dataverse, Key Vault, and HTTP connections/actions | No Google private key. Power Automate retrieves the Entra credential from Key Vault, exchanges the Entra token through Google STS, impersonates the sender service account, and calls FCM HTTP v1. The Entra credential still requires rotation and Key Vault governance. | `/setup-push-wif` inventories, reuses, repairs, or provisions the trust and proves Entra -> STS -> impersonation -> FCM `validateOnly`. `/create-push-notification-flow` authors and verifies the matching action tree. | New deployments and customers that want the strongest managed, keyless Google authentication path. |
| **Managed Azure Function compatibility** | An existing Firebase service-account JSON; Azure Key Vault; managed-identity-enabled Azure Function hosting/deployment resources; Entra app protection; a tested Power Automate connection or custom connector; Azure RBAC; relevant premium Power Automate licensing | A long-lived Google private key remains in Key Vault. The Function managed identity reads it, mints short-lived Google tokens, and owns FCM delivery. The key, Function runtime, Entra protection, dependencies, monitoring, and rotation remain operational responsibilities. | `/setup-push-service-account` validates/reuses or, after confirmation, deploys the supported Function path without reading or creating the key. `/create-push-notification-flow` invokes only its validated Entra-protected connection. | Existing service-account integrations that cannot yet adopt WIF. |
| **Manual/customer-owned** | Whatever the customer-selected design requires: an existing Power Automate connector, custom connector, HTTP action, or hosted endpoint; identity provider; secret store; API gateway; hosting; monitoring; network controls; and applicable Power Automate/custom-connector licensing | The customer chooses and secures authentication. Credentials must not be embedded in the flow definition, prompts, project files, or logs. The customer owns least privilege, secret rotation, endpoint availability, monitoring, and FCM HTTP v1 compliance. | No setup skill, provisioning, credential handling, or `sender-auth.json` validation is provided. The plugin may create the producer/outbox independently, but the customer configures, tests, publishes, and operates the sender authentication and delivery branch. | Customers with an established sender platform or organization-specific authentication architecture who accept full implementation and support ownership. |

## Manual/customer-owned completion contract

Manual setup is an escape hatch from plugin-managed sender authentication, not
a third plugin-provisioned mode. Before the customer treats their sender as
ready, their implementation must:

1. Obtain an OAuth 2.0 access token authorized for FCM HTTP v1 without
   embedding credentials in the flow definition.
2. Send only to the Firebase project already bound to the active mobile client.
3. Accept the approved routing and privacy-safe payload fields: topic, generic
   title/body, string `schemaVersion`, and allowlisted internal `deepLink`.
4. Protect secret-bearing inputs/outputs and never log tokens, authorization
   headers, credentials, confidential payloads, or raw provider responses.
5. Map success and bounded sanitized failures back to the outbox, preserving
   idempotency, concurrency control, and bounded retry behavior.
6. Support a non-delivery contract test or FCM `validateOnly` verification
   before publishing.
7. Be tested and approved under the customer's own operational process.

The plugin reports this state as **customer-owned / not plugin-validated**.
Customer confirmation alone is not technical proof, and the plugin must not
claim that the sender flow is validated, publish-ready, or physically verified.

`sender-auth.json` remains reserved for the strict, non-secret `wif` and
`function-endpoint` handoffs produced by the plugin-managed owner skills. Do
not add arbitrary connector schemas, endpoint credentials, API keys, or manual
authentication metadata to that contract.
