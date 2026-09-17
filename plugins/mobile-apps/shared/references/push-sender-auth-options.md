# Push sender authentication options

Use this comparison before choosing how a Power Automate sender authenticates
to FCM HTTP v1. The native Firebase project and outbox contract are the same
for both options, but authentication setup and operational ownership differ.

| Option | Additional resources | Credential and security model | Plugin ownership | Best fit |
| --- | --- | --- | --- | --- |
| **Workload Identity Federation (Recommended)** | One explicitly selected same-tenant Entra registration: reuse the app registration, provide another existing client ID, or create a new dedicated registration; one confidential credential stored in Azure Key Vault; data-plane RBAC for the Power Automate Key Vault connection identity; Google Workload Identity Pool and Provider; dedicated Google sender service account; least-privilege FCM role/IAM bindings; Power Automate Dataverse, Key Vault, and HTTP connections/actions | No Google private key. Power Automate retrieves the selected Entra registration's credential from Key Vault, exchanges the Entra token through Google STS, impersonates the sender service account, and calls FCM HTTP v1. The Entra credential still requires rotation and Key Vault governance. | `/create-push-notification-flow` collects the registration choice. `/setup-push-wif` inventories, reuses, repairs, or provisions the approved identity and trust, then proves Entra -> STS -> impersonation -> FCM `validateOnly`. `/create-push-notification-flow` authors and verifies the matching action tree. | Customers that want the managed, keyless Google authentication path while choosing between registration reuse and stronger dedicated identity isolation. |
| **Create Power Automate flows; configure FCM authentication manually** | Power Automate Dataverse and HTTP connections/actions plus whichever Google credential and secret-storage approach the customer approves | The plugin creates the producer, outbox, and sender flow structure without embedding credentials. The customer configures the sender flow's FCM authentication, secure inputs/outputs, least privilege, rotation, and operational monitoring. | `/create-push-notification-flow` authors the flows stopped, identifies the exact sender action that requires authentication, and leaves it unconfigured. After the customer configures and publishes it, FlowAgent reads back only the observable non-secret sender contract. No `sender-auth.json` is created and authentication remains customer-owned and not plugin-validated. | Customers who want the Power Automate flow scaffolding but will configure FCM authentication themselves. |

Azure Function and non-Flow custom-endpoint options are not offered.

## WIF Entra registration choices

Before WIF setup, show all currently available choices and require one explicit
selection:

| Choice | Source and validation | Configuration impact |
| --- | --- | --- |
| **Reuse this app registration** | Read `msal.clientId` and `msal.tenantId` from `auth.config.json`; require the tenant to match the resolved Power Platform environment and read back the live Entra application and service principal. | Keeps one client ID for native sign-in and sender trust. WIF may add an application ID URI and Key Vault-held confidential credential, but must not alter Wrap-managed redirects or delegated Power Platform permissions. |
| **Use a different existing registration** | Ask for an Application (client) ID and validate it in the same resolved tenant. Cross-tenant IDs are unsupported. | Uses that ID only for sender authentication. Never overwrite the mobile app's `auth.config.json`. WIF may add or rotate the separately approved application ID URI/credential and Key Vault reference. |
| **Create a new dedicated registration** | `/setup-push-wif` proves the named identity is absent, presents the narrow bootstrap plan, and creates it only after explicit approval. | Provides stronger identity and credential-rotation isolation. Retains the existing staged bootstrap, fresh claim-driven plan, and second approval before Google/API/RBAC mutation and proof. |

If the app client ID is missing, only the first choice is unavailable. Explain
that `/set-app-registration-native` can configure it, but continue to offer a
different same-tenant existing client ID or new dedicated registration.

## Manual FCM authentication completion contract

Before the customer treats the manually configured Power Automate sender as
ready, it must:

1. Obtain an OAuth 2.0 access token authorized for FCM HTTP v1 without
   embedding credentials in the flow definition.
2. Send only to the Firebase project already bound to the active mobile client.
3. Send the user-approved notification title and body plus optional validated
   semantic navigation fields. Do not collect or merge arbitrary extra FCM
   data. The skill must explain that notification text can appear on a lock
   screen, navigation parameters reach the device, and topic membership is not
   authorization.
4. Protect secret-bearing inputs/outputs and never log tokens, authorization
   headers, credentials, confidential payloads, or raw provider responses.
5. Map success and bounded sanitized failures back to the outbox, preserving
   idempotency, concurrency control, and bounded retry behavior.
6. Support a non-delivery contract test or FCM `validateOnly` verification
   before publishing.
7. Be tested and approved under the customer's own operational process.

The plugin reports this state as
**customer-owned Power Automate sender / observable contract read back;
authentication not plugin-validated**. Customer confirmation alone is not
technical authentication proof.

`sender-auth.json` remains reserved for the strict, non-secret `wif` handoff.
Do not add credentials, API keys, or manual authentication metadata to that
contract.
