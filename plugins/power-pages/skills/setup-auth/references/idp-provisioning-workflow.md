# Set up an identity-provider app

#### 2.1.2 Set Up the IDP App Registration (check the provider's docs first)

Applies to **OIDC providers** (Okta, Auth0, Entra External ID, and other OIDC). For SAML2, WS-Federation, social, or local auth, use the Phase 2.1 walkthroughs.

Power Pages needs an OIDC **app registration** at the IDP, wired to this site. **How you set it up depends entirely on the identity provider**, so read the provider's own current documentation first.

Read this document's protocol contract and official documentation links before provisioning.

**Step A - check the provider's docs (always the first step).** As soon as you know which IDP the user wants, read that provider's official documentation (via the reference links; use the Microsoft Learn official documentation lookup for Microsoft IDPs) to determine two things: **(1)** the exact steps to register and configure an OIDC app, and **(2)** the CLI it offers for configuring the app (Okta, Auth0, and Entra External ID each provide one). **Do not proceed to any other step before this**, and never invent console paths or endpoints.

**Step B - choose how to set it up.** Two ways - offer both:

- **Guided** (default, recommended) - you read the provider's docs and walk the user through the steps to perform in the provider's own console. Always available.
- **Configure it for the user** - when the provider offers a CLI for app configuration. **Okta, Auth0, and Entra External ID all do, so always offer it for them.** A CLI that isn't installed yet is not a reason to withhold the offer - installing it and signing in is part of this path.

For a provider that offers no such CLI, go Guided.

<!-- not-a-gate: configuration sub-prompt - selects Guided vs configure-for-you; the load-bearing consent is the 2.1.2.provision-idp gate and the 2.2 plan gate. -->

**When the provider offers such a CLI** (always for Okta, Auth0, Entra External ID), ask (otherwise skip this question and proceed Guided):

| Question | Header | Options |
|----------|--------|---------|
| How would you like to set up the {provider} app registration? | Setup | Guided (Recommended) - I walk you through the steps in the {provider} console, Configure it for me - I set it up in your {provider} using its CLI |

**Step C - the app configuration Power Pages needs (inform, then approve).** Power Pages' default is the no-secret **`code id_token`** flow, so the app is a **Web application with no client secret**. Present the target configuration and let the user approve or adjust:

- **App type:** Web application - **no client secret**
- **Sign-in flow:** `code id_token` (the app must issue **ID tokens** at the IDP)
- **Redirect URI:** `<REDIRECT_URI>` (exact - casing + `signin-` prefix)
- **Scopes:** `openid profile email`

In **Guided**, this is the checklist the user applies in the console. When you **configure it for the user**, it is the spec you apply.

**Step D - execute sequentially and verify each step.**
Before any CLI/API write, obtain the `setup-auth:2.1.2.provision-idp` consent below.
Then do one step, read back its result, and continue; never configure everything in one unverified command.

1. Register the app → capture/verify the **Client ID**.
2. Set the Redirect URI → verify it matches `<REDIRECT_URI>` exactly.
3. Enable **ID token** issuance (`code id_token`) → verify.

- **Guided:** instruct the user to perform each step in the console, then confirm the result before moving on.
- **Configure it for the user:** run the provider's CLI/API for each step, then read the object back to verify before the next.

> **Okta:** enable **Implicit (Hybrid)** with **Allow ID Token**, **assign the app to users** (else `access_denied` "Policy evaluation failed"), and prefer the Org authorization server (`https://{domain}`). See the reference's Okta section.

<!-- gate: setup-auth:2.1.2.provision-idp | category=consent | cancel-leaves=nothing -->

> 🚦 **Gate (consent · setup-auth:2.1.2.provision-idp):** Explicit go/no-go before you configure a real app registration in the user's identity provider on the user's behalf.
>
> **Trigger:** The user chose **Configure it for me** and the provider supports it; about to make real changes at the IDP on the user's behalf.
> **Why we ask:** This creates/configures a real object in the user's IDP tenant, so it should never happen without an explicit yes. Guided setup does not reach this gate - the user makes the changes.
> **Cancel leaves:** Nothing - no app is configured; the user can switch to Guided setup instead.

| Question | Options |
|----------|---------|
| Go ahead and configure the {provider} app registration in your {provider} now? | Yes - configure it for me, No - switch to Guided setup |

**If "No"**: switch to the Guided flow.

**Step E - open registration.** External sign-ins obey the site's registration gating. Confirm the recommended default - **Open** for customer-facing providers (Auth0 / Okta / Entra External ID), **Controlled** for workforce Entra ID:

<!-- not-a-gate: configuration sub-prompt - records the OpenRegistrationEnabled value; the load-bearing plan sign-off is the 2.2 gate. -->

| Question | Header | Options |
|----------|--------|---------|
| Should anyone who signs in through {provider} get an account created automatically, or only pre-provisioned users? | Registration | Open - self-service (Recommended for customer sites) - auto-create a contact for any authenticated user, Controlled - pre-provisioned only - only admit users whose email matches an existing contact |

Store as `OPEN_REGISTRATION_CHOICE`. Phase 8.1 writes `Authentication/Registration/OpenRegistrationEnabled` (`true` for Open, `false` for Controlled). Pair this with the contact-linking (`AllowContactMappingWithEmail`) choice already collected in Phase 2.1.

**Step F - record the results for Phase 8.1.** However the app was set up, capture the values Phase 8.1 writes as site settings (identical for both flows): `ClientId`, `Authority` (and `AuthenticationType` = Authority), `MetadataAddress` (the provider's discovery endpoint - read from the IDP), `RedirectUri`. **No `ClientSecret`** - the no-secret flow needs none, so skip Phase 8.1.1 (Key Vault), same as Entra External ID. See the reference's "Resulting site settings" table.

## Contents

- [The Power Pages ↔ IDP contract](#the-power-pages--idp-contract)
- [Client secret: code id_token is the default](#client-secret-code-id_token-is-the-default)
- [Per-IDP setup docs](#per-idp-setup-docs)
- [Resulting site settings](#resulting-site-settings)

## The Power Pages ↔ IDP contract

Power Pages redirects the user to the IDP, receives the response at the **Redirect URI**, validates the token, then maps the identity to a Dataverse contact. Regardless of provider, the app registration must satisfy this contract:

- **Redirect URI** = `{SITE_URL}/signin-{ProviderName-lowercased}` - lowercase the provider slug in this path; the resulting URI must then be referenced **exactly** as registered at the IDP (the `signin-` prefix and the full string must match character-for-character).
- **ID token issuance enabled** - Power Pages' default response type is `code id_token`, so the app must return an ID token from the authorize endpoint.
- **Web application; client secret optional** - `code id_token` needs none by default. See below.
- **Scopes** `openid profile email` - so the token carries the claims Power Pages maps to the contact.

Everything Power Pages needs downstream (Authority, MetadataAddress, ClientId) is derived from these - see [Resulting site settings](#resulting-site-settings).

## Client secret: code id_token is the default

Power Pages' default OIDC response type is **`code id_token`**: the ID token returns on the front channel, so the app is a **Web application** that needs **no client secret**.

**Default to `code id_token`; configure a client secret only when the user prefers a confidential client.**

## Per-IDP setup docs

Ground each step in the provider's current docs before acting.
Register a Web application with `code id_token` and no secret by default, set the exact Redirect URI, enable ID-token issuance and request `openid profile email`.

### Okta

- Create an OIDC app / authorization code flow: <https://developer.okta.com/docs/guides/implement-grant-type/authcode/main/>
- Customize tokens (claims): <https://developer.okta.com/docs/guides/customize-tokens-returned-from-okta/main/>
- Okta CLI (create OIDC apps): <https://cli.okta.com/>
- Enable **Authorization Code** + **Implicit (Hybrid)** grant with **Allow ID Token** (required for `code id_token`) and **assign the app to users** (Assignments → Assign to Everyone or specific users). A missing grant or assignment fails sign-in with `access_denied` "Policy evaluation failed".
- Authority: prefer the **Org authorization server** `https://{yourOktaDomain}` - no access policies, so it avoids that error and covers `openid profile email`. Use `https://{yourOktaDomain}/oauth2/default` only when you need `groups`/custom claims, and then also allow Authorization Code + Implicit (Hybrid) in that server's Access Policy rule. MetadataAddress: `{authority}/.well-known/openid-configuration`.

### Auth0

- Create an application: <https://auth0.com/docs/get-started/auth0-overview/create-applications>
- Callback URLs and settings: <https://auth0.com/docs/get-started/applications/application-settings>
- Auth0 CLI (create applications): <https://auth0.github.io/auth0-cli/>
- Authority (issuer): `https://{yourAuth0Domain}/` (keep the trailing slash). MetadataAddress: `https://{yourAuth0Domain}/.well-known/openid-configuration`.

### Microsoft Entra External ID

- Use the External ID walkthrough linked directly in SKILL.md.
- Microsoft Learn (ground with the Microsoft Learn official documentation lookup): <https://learn.microsoft.com/en-us/power-pages/security/authentication/entra-external-id>
- Azure CLI app registration (`az ad app`): <https://learn.microsoft.com/en-us/cli/azure/ad/app>

### Other OIDC providers

Follow the provider's OIDC app-registration docs. Authority = the provider's issuer; MetadataAddress = `{authority}/.well-known/openid-configuration` (read the endpoints and `claims_supported` from it). OIDC spec: <https://openid.net/specs/openid-connect-core-1_0.html>.

## Resulting site settings

However the app was created, Phase 8.1 writes these **app-registration** OIDC site settings (via `${PLUGIN_ROOT}/scripts/create-site-setting.js`):

| Setting | Source |
|---|---|
| `Authentication/OpenIdConnect/{ProviderName}/Authority` | provider Authority (see per-IDP format above) |
| `Authentication/OpenIdConnect/{ProviderName}/MetadataAddress` | the provider's OIDC metadata (discovery) endpoint - read from the IDP (commonly `{authority}/.well-known/openid-configuration`, but not for every provider) |
| `Authentication/OpenIdConnect/{ProviderName}/ClientId` | the app's client/application ID |
| `Authentication/OpenIdConnect/{ProviderName}/AuthenticationType` | same as Authority (must match exactly) |
| `Authentication/OpenIdConnect/{ProviderName}/RedirectUri` | `{SITE_URL}/signin-{ProviderName-lowercased}` |

**Getting the MetadataAddress:** fetch `{authority}/.well-known/openid-configuration` - if it returns OIDC metadata JSON, that's the value. Otherwise use the discovery URL the provider shows in its console.

**No `ClientSecret`** for the default no-secret `code id_token` flow - skip Phase 8.1.1 (Key Vault) entirely, same as Entra External ID. Only a confidential-client override produces a secret; then route it through the Phase 8.1.1 Key Vault / Secret env-var flow and never write it to a plain site setting.

`{ProviderName}` is the per-provider slug (default `OpenIdConnect_1`, or a custom slug for multiple instances) - same convention as Phase 8.1.
