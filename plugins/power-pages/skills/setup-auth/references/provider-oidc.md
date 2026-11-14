# OpenID Connect

**For "OpenID Connect"** (Okta, Auth0, etc.):

**First, identify the specific OIDC provider** - setup steps and the docs to read differ per vendor:

| Question | Options |
|----------|---------|
| Which OpenID Connect provider are you using? | Okta, Auth0, Other (any OIDC-compliant provider) |

Use the answer as `{provider}` in the questions below and for Phase 2.1.2 Step A (reading the provider's docs). For **Other**, capture the provider's name from the user.

**Orient the user first - don't jump straight to inputs.** Now that they've picked {provider}, set expectations: you'll set up an app registration at {provider} for this site. The **first thing** you'll do is **read {provider}'s own documentation** - how it's set up depends on the provider. Then, depending on what {provider} supports, you'll either walk the user through the steps in the {provider} console, or - when {provider} supports it - configure it for the user. Either way you derive the metadata, Redirect URI, and claims automatically, and the app uses the no-secret `code id_token` flow - no client secret to manage.

Ask for the {provider} tenant - the sign-in domain (Okta: `your-tenant.okta.com`, Auth0: `your-tenant.us.auth0.com`):

| Question | Options |
|----------|---------|
| What's your {provider} tenant? | *(free text)* |
| What display name should the login button show? (default: `Sign in`) | *(free text, defaulted)* |
| Do you already have an app registration for this site at {provider}? | No - set one up in Phase 2.1.2 (Recommended), Yes - I already have one |

If the user answered **"Yes - I already have one"**, ask for the existing **Client ID** and **Metadata Address** now (Phase 8.1 needs them) and skip the Phase 2.1.2 app-registration setup. Otherwise the Client ID is **not** asked upfront - it comes from **Phase 2.1.2**, where you set up the app (guided, or configured for the user when the provider supports it) and derive the metadata from the provider's discovery document.

> Docs: https://learn.microsoft.com/en-us/power-pages/security/authentication/openid-settings

```bash
# Authority (required - or use MetadataAddress as alternative)
node "${PLUGIN_ROOT}/scripts/create-site-setting.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --name "Authentication/OpenIdConnect/{ProviderName}/Authority" \
  --value "<authority-url-from-user>" \
  --description "OIDC authority URL"

# MetadataAddress (optional - alternative to Authority for providers that need explicit metadata URL)
# Create this if the user provides a metadata URL distinct from the authority
# node "${PLUGIN_ROOT}/scripts/create-site-setting.js" \
#   --projectRoot "<PROJECT_ROOT>" \
#   --name "Authentication/OpenIdConnect/{ProviderName}/MetadataAddress" \
#   --value "<metadata-url>" \
#   --description "OIDC metadata endpoint URL"

# ClientId - use value collected in Phase 2.1
node "${PLUGIN_ROOT}/scripts/create-site-setting.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --name "Authentication/OpenIdConnect/{ProviderName}/ClientId" \
  --value "<client-id-from-user>" \
  --description "Application client ID"

# AuthenticationType
node "${PLUGIN_ROOT}/scripts/create-site-setting.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --name "Authentication/OpenIdConnect/{ProviderName}/AuthenticationType" \
  --value "<authority-url-from-user>" \
  --description "Provider identifier for ExternalLogin"

# Use the approved URI, including a retained custom same-host path.
node "${PLUGIN_ROOT}/scripts/create-site-setting.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --name "Authentication/OpenIdConnect/{ProviderName}/RedirectUri" \
  --value "<approved-redirect-uri>" \
  --description "OAuth callback URL - unique per provider (matches CallbackPath)"

# CallbackPath - required to prevent collision when multiple OIDC providers exist
# OWIN defaults ALL OIDC providers to /signin-oidc
node "${PLUGIN_ROOT}/scripts/create-site-setting.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --name "Authentication/OpenIdConnect/{ProviderName}/CallbackPath" \
  --value "<pathname-of-approved-redirect-uri>" \
  --description "Unique callback path derived from approved RedirectUri"

```

> **Note:** The `AuthenticationType` value is the unique provider identifier used in the `ExternalLogin` form POST. This value must match what `resolveProviderIdentifier()` returns in the auth service.

**OpenID Connect / Entra External ID optional settings:**

| Setting | Description | Default |
|---------|-------------|---------|
| `MetadataAddress` | Explicit OIDC metadata endpoint URL (alternative to `Authority` - use when provider needs a specific metadata URL) | Derived from Authority |
| `Scope` | Space-separated OAuth scopes (e.g., `openid profile email`) | `openid` |
| `ResponseType` | OAuth response type (`code`, `id_token`, `code id_token`) | `code id_token` |
| `ResponseMode` | How the IdP returns the response (`form_post`, `query`, `fragment`) | `form_post` for code flow |
| `RedirectUri` | Override the callback URL | `{site-url}/signin-{ProviderName-lowercased}` |
| `PostLogoutRedirectUri` | URL to redirect to after federated logout completes at the IdP. **Required when `RPInitiatedLogout=true`** - server has a fallback that derives from `RedirectUri` authority, but a separate flag (`PostLogoutRedirectUriEnabled`) requires the explicit site setting to be present before the fallback is used. Without an explicit value, the IdP logout URL omits the parameter and users get stranded. | Unset (server default - but use the Logout mode question above to write it correctly) |
| `RPInitiatedLogout` | Use RP-initiated logout via `end_session_endpoint` with `id_token_hint`. **Mutually exclusive with `ExternalLogoutEnabled`** - when `true`, the server forces `ExternalLogoutEnabled` to `false` regardless of that setting. **Prefer the "Logout mode" question above** instead of setting this directly - that flow pairs it with `PostLogoutRedirectUri` (required) and the Entra app-registration step. | `false` |
| `RegistrationClaimsMapping` | **Comma-separated `contactfield=claimtype` pairs** (NOT JSON). Applied **once** at first sign-in, before the contact is created. Example for Entra External ID: `firstname=given_name,lastname=family_name,emailaddress1=email`. The server silently skips malformed pairs - verify in Application Insights if claims aren't populating. | None |
| `LoginClaimsMapping` | Same format as `RegistrationClaimsMapping`. Applied **every login** (overwrites contact fields). Use sparingly - it overwrites manual edits the user makes to their profile. | None |
| `ExternalLogoutEnabled` | Sign out of the IdP when the user logs out (legacy OWIN sign-out, prefer `RPInitiatedLogout` for OIDC). Forced to `false` when `RPInitiatedLogout=true`. | `false` (server default) |
| `RegistrationEnabled` | Allow new users to register via this provider | `true` |
| `AllowContactMappingWithEmail` | **Auto-link an external sign-in to an existing Dataverse contact by matching the `email` claim against `emailaddress1`.** Default `false` (a new contact is always created). **⚠ Multi-tenant Entra External ID: the server forcibly disables this** - email claims can't be trusted across tenants. If you want contact linking, use single-tenant Authority. **⚠ Security**: When `true`, anyone who can sign into this provider with a victim's email gains access to the victim's contact. Enable only when the provider is trusted to verify emails. | `false` |
| `RequireUniqueEmail` | Enforce unique email addresses during registration | `false` |
| `UseTokenLifetime` | Use the IdP token lifetime for the session cookie | Not set |
| `BackchannelTimeout` | Timeout for backchannel HTTP calls to the IdP (e.g., `00:01:00`) | `00:01:00` |
| `RefreshOnIssuerKeyNotFound` | Refresh provider metadata when issuer key not found | Default |
| `NonceEnabled` | Enable nonce validation on OIDC tokens | `true` |
| `NonceLifetime` | Lifetime of the OIDC nonce (e.g., `00:10:00`) | `00:10:00` |
| `AcrValues` | Authentication Context Class Reference values to request from the IdP | None |
| `Prompt` | OIDC prompt parameter (`login`, `consent`, `none`). Use `login` to force re-authentication on session expiry. | None |
| `Resource` | Resource parameter for the token request | None |
| `EmailClaimIdentifier` | Custom claim type to use as the user's email | Standard email claim |
| `IssuerFilter` | Wildcard pattern to match issuers across tenants (e.g., `https://login.microsoftonline.com/*/v2.0`). Required for multi-tenant apps - without this, issuer validation fails for non-home tenants. | None |
| `UseUserInfoEndpointforClaims` | Fetch additional claims from the UserInfo endpoint | `false` |
| `UserInfoEndpoint` | Custom UserInfo endpoint URL (if not in metadata) | From metadata |
| `PasswordResetPolicyId` | B2C/External ID password reset user flow policy name | None |
| `ProfileEditPolicyId` | B2C/External ID profile editing user flow policy name | None |
| `DefaultPolicyId` | B2C/External ID default sign-up/sign-in policy name | None |
| `TokenEndPointAuthenticatedMethod` | Token endpoint auth method (`client_secret_post`, `client_secret_basic`, `private_key_jwt`). Use `private_key_jwt` for certificate-based auth in sovereign clouds. | `client_secret_post` |
| `AllowedDynamicAuthorizationParameters` | Comma-separated OIDC parameters allowed to pass through dynamically | None |
