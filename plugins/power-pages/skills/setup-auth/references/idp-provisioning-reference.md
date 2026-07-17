# IDP App Setup Reference

How to set up an OIDC identity-provider **app registration** for Power Pages — the provider-agnostic contract plus links to each provider's official docs.

> **Scope — app-registration settings only.** This reference covers just the IDP **app-registration** side: the Power Pages ↔ IDP contract and the app site settings it yields (`ClientId`, `Authority`, `MetadataAddress`, `AuthenticationType`, `RedirectUri`). The other auth site settings the skill writes — login-button `Caption`, claims mapping (`RegistrationClaimsMapping` / `LoginClaimsMapping`), and registration gating (`OpenRegistrationEnabled`) — are **not** app-registration settings; they live in the skill's Phase 8.1 and `authentication-reference.md`.

How the app is set up depends entirely on the provider, so **always read the provider's current documentation first** to learn the configuration steps **and** any CLI it offers for automating them (Okta, Auth0, and Entra External ID each provide one — see [Per-IDP setup docs](#per-idp-setup-docs)). The setup-auth skill's **Phase 2.1.2** drives the actual setup; this reference is the provider-agnostic contract it applies.

## Contents

- [The Power Pages ↔ IDP contract](#the-power-pages--idp-contract)
- [The no-secret code id_token flow](#the-no-secret-code-id_token-flow)
- [Per-IDP setup docs](#per-idp-setup-docs)
- [Resulting site settings](#resulting-site-settings)

## The Power Pages ↔ IDP contract

Power Pages redirects the user to the IDP, receives the response at the **Redirect URI**, validates the token, then maps the identity to a Dataverse contact. Regardless of provider, the app registration must satisfy this contract:

- **Redirect URI** = `{SITE_URL}/signin-{ProviderName-lowercased}` — lowercase the provider slug in this path; the resulting URI must then be referenced **exactly** as registered at the IDP (the `signin-` prefix and the full string must match character-for-character).
- **ID token issuance enabled** — Power Pages' default response type is `code id_token`, so the app must return an ID token from the authorize endpoint.
- **Web application, no client secret** — see below.
- **Scopes** `openid profile email` — so the token carries the claims Power Pages maps to the contact.

Everything Power Pages needs downstream (Authority, MetadataAddress, ClientId) is derived from these — see [Resulting site settings](#resulting-site-settings).

## The no-secret code id_token flow

Power Pages' default OIDC response type is **`code id_token`**, which does **not** require a client secret: the ID token is returned on the front channel and validated directly. Register the app as a **Web application** and manage **no client secret**.

This is the platform default. Do not add a client secret unless the user explicitly needs one.

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

However the app was created, Phase 8.1 writes these **app-registration** OIDC site settings (via `${PLUGIN_ROOT}/scripts/create-site-setting.js`):

| Setting | Source |
|---|---|
| `Authentication/OpenIdConnect/{ProviderName}/Authority` | provider Authority (see per-IDP format above) |
| `Authentication/OpenIdConnect/{ProviderName}/MetadataAddress` | the provider's OIDC metadata (discovery) endpoint — read from the IDP (commonly `{authority}/.well-known/openid-configuration`, but not for every provider) |
| `Authentication/OpenIdConnect/{ProviderName}/ClientId` | the app's client/application ID |
| `Authentication/OpenIdConnect/{ProviderName}/AuthenticationType` | same as Authority (must match exactly) |
| `Authentication/OpenIdConnect/{ProviderName}/RedirectUri` | `{SITE_URL}/signin-{ProviderName-lowercased}` |

**Getting the MetadataAddress:** fetch `{authority}/.well-known/openid-configuration` — if it returns OIDC metadata JSON, that's the value. Otherwise use the discovery URL the provider shows in its console.

**No `ClientSecret`** for the default no-secret `code id_token` flow — skip Phase 8.1.1 (Key Vault) entirely, same as Entra External ID. Only a confidential-client override produces a secret; then route it through the Phase 8.1.1 Key Vault / Secret env-var flow and never write it to a plain site setting.

`{ProviderName}` is the per-provider slug (default `OpenIdConnect_1`, or a custom slug for multiple instances) — same convention as Phase 8.1.
