# Setup-time authentication governance preflight

Run this gate before any IdP app-registration walkthrough or provisioning,
provider-setting changes, or adding a provider to custom login/registration UI.
It is not a visitor-side runtime filter and does not invoke or re-enable the
disabled `manage-governance` skill. Reuse only its read-only transport.

## Target and command

Confirm the portal's expected owning tenant GUID from the target environment's
metadata or explicit user input. Do not infer it from the current Azure CLI
account. Retain this confirmed `TENANT_ID` for every preflight and recheck; if the
target changes, confirm its owner again. Never switch accounts automatically.

Resolve the project's environment GUID and **Power Platform host ID** from the
target environment's normalized website inventory (`portals[].portalId`), matching the project's
Dataverse `websiteRecordId` and deployed URL. Do not select by name alone, use
the Dataverse record ID as `portalId`, or use a failed/obsolete host. If the
identity is ambiguous, stop and ask the user to confirm the target.

For inventory reads, reuse `fetchPortalsPaged(context)` exported by
`skills/manage-governance/scripts/list-portals.js`, passing the normal
`scripts/lib/power-platform-api.js` resolved context. Do not run the governance
inventory CLI with its implicit TIP configuration or trust partial/error results.
`fetchPortalsPaged(context)` returns `{ portals, error }`; match each entry's
`portalId`, `websiteRecordId`, and `websiteUrl`. Raw API `id`/`Id` fields are
normalized by the helper and are not fields on these returned entries.

Run from the project's signed-in PAC environment:

```text
node "${PLUGIN_ROOT}/scripts/check-auth-governance.js" --tenantId "<TENANT_ID>" --envId "<ENV_ID>" --portalId "<HOST_ID>" --websiteRecordId "<WEBSITE_RECORD_ID>" --providers "facebook,google"
```

The checker requires the expected owning tenant and verifies GUIDs plus
tenant/environment/cloud alignment. The optional
record ID rejects accidentally passing that ID as the host ID; it does not
replace inventory matching. It resolves the normal PAC/Azure CLI context once,
never the governance helper's implicit TIP context.

Before governance reads, the checker compares the confirmed owner with both
`context.tenantId` and the bearer token's `tid`, using the existing tenant reader.
This is a local routing guard, not token signature verification; the API still
authenticates the token. Missing ownership, an unavailable authenticated/token
tenant, or a mismatch returns `allowed: false`, `status: "unverified"`, and CLI
exit 2 with zero governance requests. Missing expected ownership also skips CLI
context resolution. Malformed/zero expected tenant GUIDs are invalid input
(exit 1). Sign in to the expected tenant and retry; no automatic account switch,
policy writes, or fallback tenant is permitted.

Map Facebook -> `facebook`, Google -> `google`, Microsoft Account -> `microsoft`,
all configured OIDC providers (including Entra External ID and workforce Entra
OIDC) -> `oidc`, SAML2 -> `saml`, WS-Federation -> `ws-federation`,
local authentication -> `local`. Microsoft Account OAuth is not workforce
Entra ID. Do not alter Power Pages' internal-only Entra fallback.

Check every provider being configured, regenerated, or newly surfaced, including
existing providers in keep-only/keep-and-add mode. Leave unrelated retained
providers and their settings untouched.

## Reads and decisions

Every unique required policy uses the existing `callGovernance` helper with
`op: 'getPortal'` and an explicit resolved context:

```http
GET {cloudApiHost}/powerpages/environments/{envId}/websites/{portalId}/governance/{policy}?api-version=2022-03-01-preview
```

The server resolves portal inclusion/exclusion. Do not call `getEnv`/`getDetails`
or interpret membership lists. All required reads start in parallel, with shared
parents read once per batch and no persistent cache.

| Provider | Required portal policies |
|---|---|
| Facebook | External Auth + OAuth + Facebook OAuth |
| Google | External Auth + OAuth + Google OAuth |
| Microsoft Account | External Auth + OAuth + Microsoft OAuth |
| OIDC | External Auth + OIDC |
| SAML | External Auth + SAML |
| WS-Federation | External Auth + WS-Federation |
| Local login | External Auth + Local Login |

All required responses must be boolean `true` (or the exact text primitive
`true`). Boolean `false`/text `false` is disabled. Other response shapes, 404,
permission failures, timeouts, or unavailable authentication are **unverifiable**,
not disabled and never allowed. The existing governance reference describes the
single-boolean contract. A commercial-cloud read-only retest on 2026-11-07,
authenticated to the confirmed owning tenant, successfully read External Auth,
OAuth, and Facebook as enabled and reconfirmed the exact host/website-record
pair through inventory. An earlier probe using a different Azure CLI tenant
returned HTTP 404 for the same routes and failed inventory discovery. Confirm
the owning tenant as well as the environment before interpreting read errors;
an environment match alone does not establish tenant alignment. Do not broaden
the parser or switch APIs to manufacture an allowed result.

Read JSON `allowed`, `status`, `providers`, and `message`; display the message
for each blocked/unverified provider. Exit 0/`allowed: true` permits the existing
consent workflow to continue. Exit 1/`blocked` lists **all and only disabled**
requirements. Exit 2/`unverified` reports verification errors separately and
includes any known disabled requirements.

### User-facing blocked message

Start every blocked preflight, including late rechecks, with this exact message:

> Your administrator has restricted the use of [authentication Protocol/Provider] for this website. Contact your administrator if you need this setting enabled.

Replace the placeholder with the disabled protocol/provider label(s), not
enabled parent options or unverified requirements. Keep the wording unchanged.
Do not append policy-state summaries, portal/environment details, admin links,
or configuration navigation unless the user explicitly asks for those details.
The structured checker result retains policy states and target IDs for
diagnostics; omitting them from the message does not change the governance gate.
When disabled policies and verification failures coexist, show the approved
restriction sentence for known disabled labels first, followed by separate
verification-error guidance; the result remains `unverified`. Denied batch
messages must omit enabled-provider success messages, regardless of provider
order. Use unique disabled labels across the batch so shared parents appear
only once, while retaining every provider's structured diagnostics.

Only if the user requests configuration guidance: for commercial cloud, link to
https://admin.powerplatform.microsoft.com/manage/portals/settings. If the deep
link redirects, the navigation is **Manage > Products > Power Pages > Settings >
Authentication**. For other clouds, use the tenant's verified admin-center URL
when available, otherwise the documented entry point https://aka.ms/ppac;
do not invent sovereign-cloud deep links.

Example when only OIDC is disabled:

> Your administrator has restricted the use of OpenID Connect protocol for this website. Contact your administrator if you need this setting enabled.
>
> No identity provider settings or custom login page changes have been made in this run.

For other providers or multiple disabled requirements, substitute **all and only**
the disabled labels into the approved message. Keep policy keys and enabled
requirements in the structured diagnostics rather than the default message.
Do not describe unknown responses as disabled. An allowed policy
permits maker configuration; it does not create or configure the IdP.

The example's no-change statement applies only when this run has made no
changes. After a late blocker, disclose earlier local artifacts and say that the
read-only recheck made no additional changes. For an `unverified` result, retain
the checker's verification diagnostics and corrective sign-in/target/network
guidance; never suggest enabling a policy as a substitute for verification.

Navigation and site-targeting behavior:
https://learn.microsoft.com/power-pages/security/external-auth-control#configure-authentication-governance-controls

Stop the entire selected batch before mutation when any provider is blocked or
unverified. Never silently remove providers, partially configure the allowed
subset, delete existing settings, enable governance, or offer an override.
The user may explicitly revise the selection; then rerun the gate. Recheck
after a pause/resume and immediately before each later mutation stage (IdP
provisioning, auth code/UI generation, site-settings creation, deployment).
If earlier stages already changed files, report those changes accurately;
the check's no-change statement applies only to the read-only checker.

## Importable functions

`scripts/check-auth-governance.js` exports `checkAuthGovernance({ tenantId, envId, portalId,
websiteRecordId?, providers, context? })` for detailed diagnostics, plus
`isFacebookOAuthEnabled`, `isGoogleOAuthEnabled`, `isMicrosoftOAuthEnabled`,
`isOidcEnabled`, `isSamlEnabled`, `isWsFederationEnabled`, and
`isLocalLoginEnabled`, each requiring the same confirmed `tenantId` target option.

Boolean wrappers return `true` only when their entire dependency chain is
enabled, `false` for a verified block, and throw
`AuthGovernanceVerificationError` on unverifiable reads. Use the detailed
checker for user-facing messages. No API bodies, tokens, or raw exceptions
are included in its output.
