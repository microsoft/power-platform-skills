# Microsoft Entra External ID

**For "Entra External ID"** - use the 4-step walkthrough below. Do NOT just ask the user for Authority/ClientId/Metadata upfront - those values come from a tenant + app registration + user flow that the user may not have set up yet. Walk them through each prerequisite before asking for the corresponding value.

> Reference doc: https://learn.microsoft.com/en-us/power-pages/security/authentication/entra-external-id

## Contents

- [Tenant](#step-1---tenant)
- [App registration](#step-2---app-registration)
- [User flow](#step-3---user-flow)
- [Display name and confirmation](#step-4---display-name--confirmation)
- [Common pitfalls](#common-pitfalls)
- [Custom domains](#custom-domains)

**Pre-computed values for THIS site** - before starting the walkthrough, compute:
- `SITE_URL` = the deployed site URL (e.g., `https://contoso.powerappsportals.com`). Read from `pac env who` + the site name, or from the site's existing settings.
- `PROVIDER_NAME` = if this is a fresh add, default to `OpenIdConnect_1` (or the next free `OpenIdConnect_N` slug per the CallbackPath uniqueness logic in Phase 8.1). The user can override to a custom slug like `EntraExternalId_Customer` for multi-instance setups.
- `REDIRECT_URI` = `{SITE_URL}/signin-{PROVIDER_NAME-lowercased}` - e.g., `https://contoso.powerappsportals.com/signin-openidconnect_1`. The user pastes this verbatim into the Entra app registration.
- `APP_NAME_SUGGESTION` = `power-pages-{site-shortname}` - e.g., `power-pages-contoso`
- `USER_FLOW_NAME_SUGGESTION` = `{site-shortname}-signupsignin` - e.g., `contoso-signupsignin`

Display these to the user before Step 1 so they have them handy.

##### Step 1 - Tenant

| Question | Header | Options |
|----------|--------|---------|
| Do you already have a Microsoft Entra External ID tenant? (This is a separate tenant type from a regular workforce Entra ID tenant - sometimes called CIAM.) | Tenant | Yes - I have an External ID tenant, No - help me create one (free 30-day trial), I'm not sure |

**If "No"**, show:

> Steps to create an Entra External ID tenant:
> 1. Open https://entra.microsoft.com/
> 2. Sign in with the account that should own the tenant
> 3. From the top, click **Manage tenants → Create**
> 4. Choose **External (for customers)** - NOT Workforce
> 5. Pick a domain prefix (the **tenant subdomain**) - e.g., `contoso` becomes `contoso.ciamlogin.com`. This appears in every login URL.
> 6. Free 30-day trial: no credit card required. You can attach a paid Azure subscription later.
>
> Detailed guide: https://learn.microsoft.com/en-us/entra/external-id/customers/quickstart-tenant-setup
>
> When you've created the tenant, switch to it (top-right tenant picker in entra.microsoft.com), then come back here.

**If "I'm not sure"**, show: "At https://entra.microsoft.com/ → top-right tenant picker. Tenants for customers are labeled **External**. Workforce tenants won't work - that's a different product."

Then collect the tenant identifiers:

| Question | Options |
|----------|---------|
| What is the tenant **subdomain**? (the part before `.ciamlogin.com` - e.g., `contoso`. Find it in the External ID tenant's Overview page under "Primary domain", removing `.onmicrosoft.com`.) | *(free text)* |
| What is the tenant **ID** (GUID)? (Find it in the External ID tenant's Overview page under "Tenant ID" - looks like `a1b2c3d4-e5f6-7890-abcd-ef1234567890`.) | *(free text)* |

**Validate**: subdomain matches `^[a-z0-9-]+$` (no dots, no uppercase, no `.ciamlogin.com` suffix); tenant ID matches the UUID regex. If either fails, show the expected format and re-prompt.

Store as `EXTERNAL_ID_TENANT_SUBDOMAIN` and `EXTERNAL_ID_TENANT_ID`.

##### Step 2 - App registration

**Confirm the Redirect URI first.** The skill pre-computes a default based on the site URL and `PROVIDER_NAME`, but the user may prefer a different URI:

> The Power Pages site needs a Redirect URI registered in your app registration. Based on the site URL and provider name, the default is:
>
> **`{REDIRECT_URI}`**
>
> You can keep this default, or use a different URI - for example, `{SITE_URL}/signin-entra-customer` or `{SITE_URL}/auth/external-id`. The host must be your Power Pages site; only the path can change.

| Question | Header | Options |
|----------|--------|---------|
| Use this Redirect URI? | Redirect URI | Use the default (Recommended) - `{REDIRECT_URI}`, Use a different URI |

**If "Use a different URI"**, ask:

| Question | Options |
|----------|---------|
| Enter the Redirect URI (must be on `{SITE_URL}`, must start with `{SITE_URL}/`, no spaces, no query string). Example: `{SITE_URL}/signin-entra-customer`. | *(free text)* |

**Validate** the custom URI:
- Must start with `{SITE_URL}/`
- Path portion must match `^/[a-zA-Z0-9_\-/]+$` (alphanumeric, hyphen, underscore, additional slashes allowed)
- Path must NOT collide with any `Authentication/OpenIdConnect/*/CallbackPath` already in `.powerpages-site/site-settings/` (from Phase 1.5 discovery)
- Path must NOT be a reserved Power Pages server path (`/Account/...`, `/SignIn`, `/Register`, `/_layout/...`, `/api/...`)

Re-prompt on invalid input. Then store the value as `REDIRECT_URI` for the rest of the walkthrough and Phase 8.1.

> **Note**: The skill writes two site settings derived from this single `REDIRECT_URI`: the user-facing `RedirectUri` (the full URI, sent to the IdP) and the internal `CallbackPath` (just the path portion, used by the OWIN middleware to know which incoming request to handle). The maker doesn't need to think about `CallbackPath` separately - the skill derives it automatically from `REDIRECT_URI` by extracting the path portion.

| Question | Header | Options |
|----------|--------|---------|
| Have you registered an app in your Entra External ID tenant for this Power Pages site? | App reg | No - walk me through it (Recommended for first time), Yes - I have the Application (client) ID |

**If "No"**, show step-by-step with the confirmed Redirect URI verbatim:

> Steps to register the app:
> 1. At https://entra.microsoft.com/, make sure you're in your External ID tenant (top-right picker)
> 2. **Applications → App registrations → New registration**
> 3. **Name**: `{APP_NAME_SUGGESTION}` (or your own name)
> 4. **Supported account types**: select **Accounts in this organizational directory only (single tenant)** - recommended for Power Pages. Multi-tenant configurations forcibly disable contact mapping by email for security.
> 5. **Redirect URI**: select **Web**, paste exactly:
>
>    ```
>    {REDIRECT_URI}
>    ```
>
>    (Copy this verbatim. Any mismatch between this value and the `RedirectUri` site setting causes sign-in to fail with `AADSTS50011: The reply URL specified in the request does not match`.)
> 6. Click **Register**
> 7. Open the **Authentication** tab → under "Implicit grant and hybrid flows" check **Access tokens** AND **ID tokens** → **Save**
> 8. Open the **API permissions** tab → click **Grant admin consent for {your tenant}** → confirm
> 9. Go back to the **Overview** tab and copy the **Application (client) ID** (it's a GUID)
>
> Detailed guide: https://learn.microsoft.com/en-us/entra/external-id/customers/quickstart-register-app

**If "Yes" (existing app)**, before asking for the Client ID, also confirm the user has the matching Redirect URI registered:

> Before continuing, please verify that your existing app registration has the following Redirect URI registered (under **Authentication → Web** in the Entra admin center):
>
> **`{REDIRECT_URI}`**
>
> If it's missing or different, add it now. An app registration can have multiple Web Redirect URIs registered - adding ours doesn't break any existing integrations. Sign-in will fail if the value in Power Pages doesn't match a registered URI exactly.

Then ask for the value:

| Question | Options |
|----------|---------|
| Paste the **Application (client) ID** from the Overview tab. | *(free text)* |

**Validate**: must match UUID v4 format (`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`). Re-prompt on mismatch.

Store as `EXTERNAL_ID_CLIENT_ID`.

Do not ask for a client secret.
Use the no-secret Web application `code id_token` flow described in the provisioning contract, not a separate public-client/PKCE flow.
Skip Key Vault for this default.
For an explicitly requested confidential-client override, verify the current provider requirements in official documentation and obtain approval before changing the flow.
Use the entry-linked secrets workflow for Key Vault-backed storage; never request the secret value.
If the provider requirements or a required capability cannot be verified, defer that provider's readiness and give a specific manual handoff instead of claiming completion.

##### Step 3 - User flow

User flows define what attributes are collected from users and what claims appear in the ID token. Without one, sign-in fails after the IdP redirect.

| Question | Header | Options |
|----------|--------|---------|
| Have you created a sign-up/sign-in user flow in your Entra External ID tenant and attached it to your app? | User flow | No - walk me through it (Recommended for first time), Yes - I have the user flow name |

**If "No"**, the walkthrough's user-flow-attribute selection must match the `PROFILE_MAPPING_CHOICE` collected later (Track B's profile mapping question). Since this step runs BEFORE that question, ask it now (just for Entra External ID):

> The user flow needs to be told which attributes to collect from users and which claims to return in the token. The skill maps claims → Dataverse contact fields automatically - the attributes you select here determine what's available.

| Question | Header | Options |
|----------|--------|---------|
| What user profile info should the sign-up form collect and return as claims? | Profile attributes | Standard (Recommended) - Email, Given Name, Surname, Standard + phone - also Phone Number, Email only - minimal sign-up form |

Store as `PROFILE_ATTRIBUTES_CHOICE` (this also drives `PROFILE_MAPPING_CHOICE` in Track B - they should be consistent; default both to "Standard" unless the user explicitly differs).

Then show:

> Steps to create the user flow:
> 1. At https://entra.microsoft.com/, in your External ID tenant
> 2. **External Identities → User flows → New user flow**
> 3. **Name**: `{USER_FLOW_NAME_SUGGESTION}` (or your own - letters, digits, hyphens, underscores only)
> 4. **Identity providers** for sign-in: choose **Email with password** (Recommended - most familiar to customers) or **Email one-time passcode** (passwordless)
> 5. **User attributes to collect** (the sign-up form fields): based on your choice above, select:
>    - **Standard / Standard + phone**: ☑ Email Address, ☑ Given Name, ☑ Surname{`, ☑ Phone Number` if Standard + phone}
>    - **Email only**: ☑ Email Address
> 6. **User attributes to return as claims** (in the ID token): same selections as above - these power profile mapping into Dataverse contact fields
> 7. Click **Create**
> 8. Open the user flow you just created → **Applications** tab → **Add application** → select the app you registered in Step 2 → **Select**
>
> Detailed guide: https://learn.microsoft.com/en-us/entra/external-id/customers/how-to-user-flow-sign-up-sign-in-customers

Then ask:

| Question | Options |
|----------|---------|
| Paste the **user flow name** you created (e.g., `{USER_FLOW_NAME_SUGGESTION}`). | *(free text)* |

**Validate**: matches `^[a-zA-Z0-9_-]+$` (letters, digits, hyphens, underscores). Re-prompt on mismatch.

Store as `EXTERNAL_ID_USER_FLOW`.

##### Step 4 - Display name + Confirmation

| Question | Options |
|----------|---------|
| What should the login button label say? Default: **`Sign in with Entra External ID`** (shortened from "Sign in with Microsoft Entra External ID" so it fits on one line in the horizontal-row Login page layout - see note below). Do NOT use "Sign in with Microsoft" - that conflicts with the Microsoft Account social provider. | *(free text, defaulted)* |

> **Display name length guidance**: keep labels around **28 characters or less** to display on a single line in the horizontal-row Login page layout (which is the default). Longer labels still work - buttons grow vertically to wrap text to two lines - but single-line buttons look more polished. For reference:
> - "Sign in with Entra External ID" - 30 chars (wraps on narrow cards, fits on wider)
> - "Sign in with Microsoft Entra External ID" - 40 chars (wraps to two lines in the default horizontal layout)
> - "Customer Sign In" - 16 chars (always single line, but less descriptive)
>
> If the user has multiple external providers configured (e.g., Entra External ID + Google), shorter labels matter more because each button gets less width. For a single-provider site, longer labels are fine (the button spans the full row width).

Store as `EXTERNAL_ID_DISPLAY_NAME`.

Now derive the configuration and present a summary for confirmation:

- **Authority**: `https://{EXTERNAL_ID_TENANT_SUBDOMAIN}.ciamlogin.com/{EXTERNAL_ID_TENANT_ID}` (NO trailing `/v2.0/` - Entra External ID uses the bare tenant path, NOT the B2C-style URL)
- **MetadataAddress**: `https://{EXTERNAL_ID_TENANT_SUBDOMAIN}.ciamlogin.com/{EXTERNAL_ID_TENANT_ID}/v2.0/.well-known/openid-configuration`
- **AuthenticationType** (provider identifier in `AUTH_PROVIDERS` array and ExternalLogin POST): same value as Authority
- **RedirectUri**: `{REDIRECT_URI}` (computed earlier)
- **ClientId**: `{EXTERNAL_ID_CLIENT_ID}`

Present this summary inline:

> About to configure:
>
> | Field | Value |
> |---|---|
> | Provider | Microsoft Entra External ID |
> | Tenant | `{subdomain}.ciamlogin.com` (`{tenantId}`) |
> | App (Client) ID | `{clientId}` |
> | User flow | `{userFlowName}` |
> | Redirect URI | `{REDIRECT_URI}` (must already be registered in your app) |
> | Authority | `{authority}` (derived) |
> | Metadata | `{metadataAddress}` (derived) |
> | Display name | `{displayName}` |
> | Login button | "{displayName}" |
> | Client secret | None (default `code id_token` flow) |
>
> Confirm these values for the implementation plan; no files are written until final plan approval.

| Question | Options |
|----------|---------|
| Are these values correct? | Yes - include in plan, No - let me adjust |

If "No", re-prompt for the specific value the user wants to change.

> **Implementation note:** Power Pages server treats Entra External ID as a generic OpenID Connect provider (no special CIAM handling). All settings go under `Authentication/OpenIdConnect/{ProviderName}/`. The `provider` value posted to `/Account/Login/ExternalLogin` must match the `AuthenticationType` site setting, which by default equals the authority URL.

**Entra External ID** - uses values from the 4-step walkthrough in Phase 2.1. Derive `Authority` and `MetadataAddress` from the tenant subdomain + tenant ID - do not ask the user to paste them:

- `Authority` = `https://{EXTERNAL_ID_TENANT_SUBDOMAIN}.ciamlogin.com/{EXTERNAL_ID_TENANT_ID}` - **NO trailing `/v2.0/`**. Entra External ID uses the bare tenant path (different from classic B2C and from generic OIDC providers like Okta which often need `/v2.0/`).
- `MetadataAddress` = `https://{EXTERNAL_ID_TENANT_SUBDOMAIN}.ciamlogin.com/{EXTERNAL_ID_TENANT_ID}/v2.0/.well-known/openid-configuration`
- `AuthenticationType` = same as `Authority` (provider identifier in ExternalLogin POST must match)
- `ClientId` = `EXTERNAL_ID_CLIENT_ID` from Step 2 of walkthrough
- `RedirectUri` = the confirmed `REDIRECT_URI`, including any approved custom same-host path

```bash
# Authority - derived: https://{subdomain}.ciamlogin.com/{tenantId}
# (do NOT append /v2.0/ - that breaks Entra External ID)
node "${PLUGIN_ROOT}/scripts/create-site-setting.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --name "Authentication/OpenIdConnect/{ProviderName}/Authority" \
  --value "https://<EXTERNAL_ID_TENANT_SUBDOMAIN>.ciamlogin.com/<EXTERNAL_ID_TENANT_ID>" \
  --description "Entra External ID authority URL (derived)"

# MetadataAddress - derived: Authority + /v2.0/.well-known/openid-configuration
node "${PLUGIN_ROOT}/scripts/create-site-setting.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --name "Authentication/OpenIdConnect/{ProviderName}/MetadataAddress" \
  --value "https://<EXTERNAL_ID_TENANT_SUBDOMAIN>.ciamlogin.com/<EXTERNAL_ID_TENANT_ID>/v2.0/.well-known/openid-configuration" \
  --description "OIDC metadata document URL (derived)"

# ClientId - from walkthrough Step 2
node "${PLUGIN_ROOT}/scripts/create-site-setting.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --name "Authentication/OpenIdConnect/{ProviderName}/ClientId" \
  --value "<EXTERNAL_ID_CLIENT_ID>" \
  --description "Application client ID"

# AuthenticationType - must match Authority exactly (used as the 'provider' form value in ExternalLogin POST)
node "${PLUGIN_ROOT}/scripts/create-site-setting.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --name "Authentication/OpenIdConnect/{ProviderName}/AuthenticationType" \
  --value "https://<EXTERNAL_ID_TENANT_SUBDOMAIN>.ciamlogin.com/<EXTERNAL_ID_TENANT_ID>" \
  --description "Provider identifier for ExternalLogin - must match Authority exactly"

# RedirectUri - the full URI the user registered in their Entra app.
# Confirmed/customized by user in Step 2 of walkthrough (stored as REDIRECT_URI).
node "${PLUGIN_ROOT}/scripts/create-site-setting.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --name "Authentication/OpenIdConnect/{ProviderName}/RedirectUri" \
  --value "<REDIRECT_URI>" \
  --description "OAuth callback URL (must match the URI registered in the app registration)"

# CallbackPath - derived from RedirectUri (just the path portion, extracted via
# new URL(REDIRECT_URI).pathname). Required to prevent CallbackPath collision when
# multiple OIDC providers exist (OWIN defaults all OIDC to /signin-oidc otherwise).
# The user doesn't see this separately - the skill writes it automatically.
node "${PLUGIN_ROOT}/scripts/create-site-setting.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --name "Authentication/OpenIdConnect/{ProviderName}/CallbackPath" \
  --value "<path-portion-of-REDIRECT_URI>" \
  --description "OWIN callback path (derived from RedirectUri)"

```

> **Logout settings for Entra External ID** - do NOT auto-write `RPInitiatedLogout` or `ExternalLogoutEnabled` here. Both default to `false` server-side. Default behavior: logout clears the Power Pages session only; user stays signed in at the Entra External ID tenant. Next sign-in is silent SSO via the IdP's cookie. This is the simpler default and matches what most customer-facing sites want. **If the user wants federated logout** (sign out at Entra External ID too), they enable it via the advanced settings flow in Phase 2.1.1 - which writes BOTH `RPInitiatedLogout=true` AND `PostLogoutRedirectUri={SITE_URL}/` together AND adds an app-registration step for the Front-channel logout URL.

For a supplied or discovered custom identity domain, use its bare authority `https://<identity-host>/<tenantId>` and metadata URL ending `/v2.0/.well-known/openid-configuration`.
Do not rebuild it from the default tenant subdomain or append `/v2.0/` to Authority.

The default Web application `code id_token` flow has no ClientSecret block and skips Key Vault for this provider.
Only an explicitly approved confidential-client override enters the secrets workflow described above.

> **User flow name (`EXTERNAL_ID_USER_FLOW`) is NOT written as a site setting.** Entra External ID attaches the user flow to the app registration itself, so the user flow runs automatically on sign-in without Power Pages needing to reference it by name in URL/metadata (unlike classic B2C). The walkthrough captures it only to confirm the user has created one. If the user later configures separate password-reset or profile-edit user flows, they can add `PasswordResetPolicyId` / `ProfileEditPolicyId` site settings manually as advanced overrides.

### Common pitfalls

| Pitfall | Symptom | Fix |
|---|---|---|
| Wrong tenant type (workforce instead of External ID) | Sign-in works but no External ID-specific features (sign-up, user flows) | Create a separate External ID tenant |
| Multi-tenant app registration | Contact mapping silently disabled on server | Use single-tenant; or accept new contacts always (the safer default) |
| Redirect URI mismatch (casing, suffix typo) | "AADSTS50011: The reply URL specified in the request does not match" | Copy the Redirect URI from the skill output verbatim, including lowercase |
| Missing user flow / not attached to app | After IdP redirect, user sees error or nothing happens | Create user flow + add app to it |
| Selected attribute to collect but not to return as claim | Contact created with empty `firstname`/`lastname` | Re-edit user flow → check claim boxes for same attributes |
| Authority URL includes `/v2.0/` for External ID | Sign-in returns "AADSTS900144: The request body must contain..." or metadata loading fails | Remove `/v2.0/` from Authority (keep it in MetadataAddress) |

### Custom domains

External ID supports custom domains (e.g., `login.contoso.com` instead of `contoso.ciamlogin.com`). To use one:

1. Configure the custom domain in the External ID tenant (see Microsoft Learn)
2. The Authority becomes `https://{custom-domain}/{tenantId}` (same structure, custom hostname)
3. MetadataAddress becomes `https://{custom-domain}/{tenantId}/v2.0/.well-known/openid-configuration`
4. Keep Redirect URI on the actual Power Pages site host.
   A custom identity domain does not imply a custom site domain.

Capture an explicitly supplied custom identity domain during initial setup and preserve a discovered one during updates.
Ask only for missing values and confirm the exact callback URI independently.
