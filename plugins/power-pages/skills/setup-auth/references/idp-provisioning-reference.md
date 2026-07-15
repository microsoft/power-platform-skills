# IDP App Setup Reference

How to set up an OIDC identity-provider **app registration** for Power Pages — the provider-agnostic contract plus links to each provider's official docs.

How the app is set up depends entirely on the provider, so **always read the provider's current documentation first** (Step A of Phase 2.1.2) to learn the configuration steps **and** the CLI the provider offers for configuring the app. The setup-auth skill then offers both:

- **Guided** (default, recommended) — read the provider's docs and walk the user through the steps to perform in the provider's own console. Always available.
- **Configure it for the user** — when the provider offers a CLI for app configuration. **Okta, Auth0, and Entra External ID all do** (see [Per-IDP setup docs](#per-idp-setup-docs)), so always offer it for them; a CLI that isn't installed yet is not a reason to skip it — installing it and signing in is part of this path. Execute sequentially and verify each step — never one-shot.

## Contents

- [The Power Pages ↔ IDP contract](#the-power-pages--idp-contract)
- [The no-secret code id_token flow](#the-no-secret-code-id_token-flow)
- [Claims mapping](#claims-mapping)
- [Open registration vs. controlled access](#open-registration-vs-controlled-access)
- [Per-IDP setup docs](#per-idp-setup-docs)
- [Resulting site settings](#resulting-site-settings)

## The Power Pages ↔ IDP contract

Power Pages redirects the user to the IDP, receives the response at the **Redirect URI**, validates the token, then maps the identity to a Dataverse contact. Regardless of provider, the app registration must satisfy this contract:

- **Redirect URI** = `{SITE_URL}/signin-{ProviderName-lowercased}` — exact string, including casing and the `signin-` prefix.
- **ID token issuance enabled** — Power Pages' default response type is `code id_token`, so the app must return an ID token from the authorize endpoint.
- **Web application, no client secret** — see below.
- **Scopes** `openid profile email` — so the token carries the claims Power Pages maps to the contact.

Everything Power Pages needs downstream (Authority, MetadataAddress, ClientId, claims mapping) is derived from these — see [Resulting site settings](#resulting-site-settings).

## The no-secret code id_token flow

Power Pages' default OIDC response type is **`code id_token`**, which does **not** require a client secret: the ID token is returned on the front channel and validated directly. Register the app as a **Web application** and manage **no client secret**.

This is the platform default. Do not add a client secret unless the user explicitly needs one.

## Claims mapping

Without claims mapping, first sign-in creates a contact with empty `firstname`/`lastname`/`emailaddress1`. Power Pages copies IDP claims into the contact using two comma-separated `contactfield=claimtype` mappings (**not** JSON), read from the token and, if configured, the UserInfo endpoint:

- `RegistrationClaimsMapping` — applied **once** at first sign-in.
- `LoginClaimsMapping` — re-applied **every** sign-in; use only when the IDP is the source of truth (it overwrites profile edits).

Standard seed values (the user confirms via the Phase 2.1 profile-mapping question):

| IDP | Standard mapping | Notes |
|---|---|---|
| Auth0 / Okta / Entra External ID / other OIDC | `firstname=given_name,lastname=family_name,emailaddress1=email` | Request the `openid profile email` scopes so these claims appear. |
| Azure AD B2C | `firstname=given_name,lastname=family_name,emailaddress1=emails` | Email is the **plural** `emails` array claim. |
| Workforce Entra ID | `firstname=given_name,lastname=family_name,emailaddress1=upn` | v1.0 tokens omit `email`; `upn` is the reliable substitute. |

Power Pages already resolves the email from `email`, `emails`, and `upn` by default; override with `Authentication/{Provider}/{ProviderName}/EmailClaimIdentifier` when the IDP uses a custom email claim.

## Open registration vs. controlled access

External sign-ins obey the site's registration gating. Confirm this explicitly with the user:

| Choice | `Authentication/Registration/OpenRegistrationEnabled` | Effect |
|---|---|---|
| **Open** (self-service) | `true` | Any user who authenticates at the IDP gets a contact created. Typical for customer-facing sites. |
| **Controlled** (pre-provisioned) | `false` | Only users whose email matches a pre-created contact are admitted. Typical for workforce/partner portals; pair with invitation codes. |

Pair with the contact-linking (`AllowContactMappingWithEmail`) choice from Phase 2.1 — safe only during migration, then disable it.

## Per-IDP setup docs

Ground each step in the provider's **current** docs before acting. Mirror the fully worked example in `authentication-reference.md` → "Entra External ID — Tenant and App Registration Prerequisites". For every provider: register an OIDC app as a **Web application** with no secret, set the Redirect URI, enable ID-token issuance, and request `openid profile email`.

### Okta

- Create an OIDC app / authorization code flow: <https://developer.okta.com/docs/guides/implement-grant-type/authcode/main/>
- Customize tokens (claims): <https://developer.okta.com/docs/guides/customize-tokens-returned-from-okta/main/>
- Okta CLI (create OIDC apps): <https://cli.okta.com/>
- Enable **Authorization Code** + **Implicit (Hybrid)** grant with **Allow ID Token** (required for `code id_token`) and **assign the app to users** (Assignments → Assign to Everyone or specific users). A missing grant or assignment fails sign-in with `access_denied` "Policy evaluation failed".
- Authority: prefer the **Org authorization server** `https://{yourOktaDomain}` — no access policies, so it avoids that error and covers `openid profile email`. Use `https://{yourOktaDomain}/oauth2/default` only when you need `groups`/custom claims, and then also allow Authorization Code + Implicit (Hybrid) in that server's Access Policy rule. MetadataAddress: `{authority}/.well-known/openid-configuration`.

### Auth0

- Create an application: <https://auth0.com/docs/get-started/auth0-overview/create-applications>
- Callback URLs and settings: <https://auth0.com/docs/get-started/applications/application-settings>
- Auth0 CLI (create applications): <https://auth0.github.io/auth0-cli/>
- Authority (issuer): `https://{yourAuth0Domain}/` (keep the trailing slash). MetadataAddress: `https://{yourAuth0Domain}/.well-known/openid-configuration`.

### Microsoft Entra External ID

- Full prerequisites walkthrough: `authentication-reference.md` → "Entra External ID — Tenant and App Registration Prerequisites".
- Microsoft Learn (ground with the Learn MCP `microsoft_docs_search`/`microsoft_docs_fetch`): <https://learn.microsoft.com/en-us/power-pages/security/authentication/entra-external-id>
- Azure CLI app registration (`az ad app`): <https://learn.microsoft.com/en-us/cli/azure/ad/app>

### Other OIDC providers

Follow the provider's OIDC app-registration docs. Authority = the provider's issuer; MetadataAddress = `{authority}/.well-known/openid-configuration` (read the endpoints and `claims_supported` from it). OIDC spec: <https://openid.net/specs/openid-connect-core-1_0.html>.

## Resulting site settings

However the app was created, Phase 8.1 writes the same OIDC site settings (via `${PLUGIN_ROOT}/scripts/create-site-setting.js`):

| Setting | Source |
|---|---|
| `Authentication/OpenIdConnect/{ProviderName}/Caption` | login button label (display name from Phase 2.1) |
| `Authentication/OpenIdConnect/{ProviderName}/Authority` | provider Authority (see per-IDP format above) |
| `Authentication/OpenIdConnect/{ProviderName}/MetadataAddress` | `{authority}/.well-known/openid-configuration` |
| `Authentication/OpenIdConnect/{ProviderName}/ClientId` | the app's client/application ID |
| `Authentication/OpenIdConnect/{ProviderName}/AuthenticationType` | same as Authority (must match exactly) |
| `Authentication/OpenIdConnect/{ProviderName}/RedirectUri` | `{SITE_URL}/signin-{ProviderName-lowercased}` |
| `Authentication/OpenIdConnect/{ProviderName}/CallbackPath` | path portion of the Redirect URI |
| `Authentication/OpenIdConnect/{ProviderName}/RegistrationClaimsMapping` | seed value above (user-confirmed) |
| `Authentication/OpenIdConnect/{ProviderName}/LoginClaimsMapping` | seed value above (only when "sync every login") |
| `Authentication/Registration/OpenRegistrationEnabled` | open-registration choice above |

**No `ClientSecret`** for the default no-secret `code id_token` flow — skip Phase 8.1.1 (Key Vault) entirely, same as Entra External ID. Only a confidential-client override produces a secret; then route it through the Phase 8.1.1 Key Vault / Secret env-var flow and never write it to a plain site setting.

`{ProviderName}` follows the same CallbackPath-uniqueness logic as Phase 8.1 (default `OpenIdConnect_1`, or a custom slug for multi-instance).
