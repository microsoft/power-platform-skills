---
name: setup-auth
description: >
  This skill should be used when the user asks to "set up authentication",
  "add login", "add logout", "configure Entra ID", "set up Azure AD auth",
  "add Microsoft login", "enable authentication", "set up sign in",
  "add role-based access", "add authorization", "protect routes",
  "add auth to my site", "configure identity provider", "set up SAML",
  "add SAML authentication", "configure OpenID Connect", "add OIDC",
  "set up local login", "add username password login",
  "configure Facebook login", "add Facebook auth",
  "add Google sign in", "configure Google login",
  "add Microsoft Account login", "configure Microsoft login",
  "set up WS-Federation",
  "configure Entra External ID", "set up External ID auth", "add External ID login",
  "enable two-factor authentication", "add 2FA", "set up invitation login",
  or wants to set up authentication (login/logout) and role-based
  authorization for their Power Pages code site using any supported
  identity provider (Microsoft Entra ID, Entra External ID, OpenID Connect,
  SAML2, WS-Federation, local authentication, Microsoft Account, Facebook,
  or Google).
user-invocable: true
allowed-tools: Read, Write, Edit, Bash, Grep, Glob, AskUserQuestion, Task, TaskCreate, TaskUpdate, TaskList, Skill
model: opus
---

> **Plugin check**: Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/check-version.js"` — if it outputs a message, show it to the user before proceeding.

# Set Up Authentication & Authorization

Configure authentication (login/logout) and role-based authorization for a Power Pages code site. This skill supports multiple identity providers -- Microsoft Entra ID, Entra External ID (for customer-facing apps with self-service sign-up), OpenID Connect (generic), SAML2, WS-Federation, local authentication (username/password), Microsoft Account, Facebook, and Google. It also supports optional features including two-factor authentication (2FA), invitation-based registration, and "remember me" functionality. It creates an auth service, type declarations, authorization utilities, auth UI components, and role-based access control patterns appropriate to the site's framework and chosen identity provider(s).

## Core Principles

- **Client-side auth is UX only** — Power Pages authentication is server-side (session cookies). Client-side role checks control what users see, not what they can access. Server-side table permissions enforce actual security.
- **Framework-appropriate patterns** — Every auth artifact (hooks, composables, services, directives, guards) must match the detected framework's idioms and conventions.
- **Development parity** — Include mock data for local development so developers can test auth flows and role-based UI without deploying to Power Pages.

**Initial request:** $ARGUMENTS

> **Prerequisites:**
>
> - An existing Power Pages code site created via `/create-site`
> - The site must be deployed at least once (`.powerpages-site` folder must exist)
> - Web roles must be created via `/create-webroles`

## Workflow

1. **Phase 1: Check Prerequisites** — Verify site exists, detect framework, check web roles
2. **Phase 2: Plan** — Gather auth requirements and present plan for approval
3. **Phase 3: Create Auth Service** — Auth service with login/logout and type declarations
4. **Phase 4: Create Authorization Utils** — Role-checking functions and wrapper components
5. **Phase 5: Create Auth UI** — Login/logout button integrated into navigation
6. **Phase 6: Implement Role-Based UI** — Apply role-based patterns to site components
7. **Phase 7: Verify Auth Setup** — Validate all auth files exist, build succeeds, auth UI renders
8. **Phase 8: Review & Deploy** — Summary and deployment prompt

---

## Phase 1: Check Prerequisites

**Goal:** Confirm the project exists, identify the framework, verify deployment status and web roles, and check for existing auth code.

### Actions

#### 1.1 Locate Project

Look for `powerpages.config.json` in the current directory or immediate subdirectories:

```text
**/powerpages.config.json
```

**If not found**: Tell the user to create a site first with `/create-site`.

#### 1.2 Detect Framework

Read `package.json` to determine the framework (React, Vue, Angular, or Astro). See `${CLAUDE_PLUGIN_ROOT}/references/framework-conventions.md` for the full framework detection mapping.

#### 1.3 Check Deployment Status

Look for the `.powerpages-site` folder:

```text
**/.powerpages-site
```

**If not found**: Tell the user the site must be deployed first:

> "The `.powerpages-site` folder was not found. The site needs to be deployed at least once before authentication can be configured."

Use `AskUserQuestion`:

| Question | Options |
|----------|---------|
| Your site needs to be deployed first. Would you like to deploy now? | Yes, deploy now (Recommended), No, I'll do it later |

**If "Yes, deploy now"**: Invoke `/deploy-site`, then resume.

**If "No"**: Stop — the site must be deployed first.

#### 1.4 Check Web Roles

Look for web role YAML files in `.powerpages-site/web-roles/`:

```text
**/.powerpages-site/web-roles/*.yml
```

Read each file and compile a list of existing web roles (name, id, flags).

**If no web roles exist**: Warn the user that web roles are needed for authorization. Ask if they want to create them first:

| Question | Options |
|----------|---------|
| No web roles were found. Web roles are required for role-based authorization. Would you like to create them now? | Yes, create web roles first (Recommended), Skip — I'll add roles later |

**If "Yes"**: Invoke `/create-webroles`, then resume.

**If "Skip"**: Continue — auth service and login/logout will still work, but role-based authorization will need roles created later.

#### 1.5 Check for Existing Auth Code

Search for existing auth files to avoid duplicating work:

- `src/services/authService.ts` or `src/services/authService.js`
- `src/types/powerPages.d.ts`
- `src/utils/authorization.ts` or `src/utils/authorization.js`
- Auth components (e.g., `AuthButton.tsx`, `AuthButton.vue`)

If auth files already exist, present them to the user and ask whether to overwrite or skip.

### Output

- Project root path confirmed
- Framework identified (React, Vue, Angular, or Astro)
- Deployment status verified
- Web roles inventory compiled
- Existing auth code conflicts identified (if any)

---

## Phase 2: Plan

**Goal:** Gather authentication requirements from the user and present the implementation plan for approval.

### Actions

#### 2.0 Smart Auth Inference (Before Asking)

Before asking the user which providers they want, analyze the site context from Phase 1 (site name, purpose, audience type) and try to infer appropriate auth settings automatically:

**Inference rules:**

| Site Type | Inferred Auth Settings | Rationale |
|-----------|----------------------|-----------|
| Internal/employee portal (HR, dashboard, admin) | Entra ID + invitation-only registration (`OpenRegistrationEnabled=false`, `InvitationEnabled=true`) | Internal sites should restrict access to invited employees only |
| Customer-facing portal (support, self-service) | Entra External ID + open registration | Customer portals need self-service sign-up for customers |
| Partner portal (B2B, vendor) | Entra ID + invitation-only registration | Partners are pre-vetted; open registration is a security risk |
| Public site with protected features (e-commerce, community) | Entra External ID + open registration + optional Google/Facebook | Public sites benefit from social login for frictionless sign-up |
| Loan/financial/banking portal | Entra External ID + invitation-only registration | Financial sites require controlled access for compliance |

**If you can infer with confidence**, present the recommendation with rationale:

> "Based on your site purpose ({purpose}), I recommend:
> - **{provider}** for authentication
> - **{registration mode}** because {rationale}
>
> Would you like to proceed with this configuration, or choose different providers?"

| Question | Options |
|----------|---------|
| Would you like to proceed with this recommended configuration? | Yes, proceed with recommendation, No, let me choose providers |

**If "Yes"**: Skip Phase 2.1 provider selection and proceed directly to collecting provider-specific details (ClientId, tenant name, etc.) for the recommended provider(s).

**If "No"** or **if you cannot infer with confidence**: Fall back to Phase 2.1 below.

#### 2.1 Gather Requirements

**IMPORTANT: Multiple providers are supported.** The user may want more than one identity provider (e.g., Entra External ID + Google). If the user's initial prompt mentions specific providers, skip the provider selection question and proceed directly to collecting details for each mentioned provider.

> **IMPORTANT — Local Authentication:** NEVER set up local authentication by default. Do NOT include it in the provider selection list, do NOT recommend it in smart inference, and do NOT configure it unless the user explicitly and specifically asks for it (e.g., "I want username/password login", "set up local login", "add local auth"). External identity providers (Entra External ID, Entra ID, OIDC, etc.) are always preferred. If the user says something ambiguous like "add login", default to an external provider — never to local auth.

If the user has NOT specified which provider(s) they want, use `AskUserQuestion` to determine the identity provider(s). **This is a multi-select question** — the user can choose one or more:

| Question | Options |
|----------|---------|
| Which identity provider(s) do you want to use? (select all that apply) | Entra External ID (Recommended) — Customer identity with self-service sign-up (CIAM), Microsoft Entra ID — Azure AD / Entra ID for internal/employee sites, OpenID Connect (Generic) — Any OIDC-compliant provider (Okta, Auth0, Ping Identity, etc.), SAML2 — SAML 2.0 identity provider (ADFS, Shibboleth, etc.), WS-Federation — WS-Federation identity provider, Microsoft Account — Sign in with Microsoft personal/work account, Facebook — Sign in with Facebook, Google — Sign in with Google |

**Then, for EACH selected provider, ask the mandatory follow-up questions below.** Do not skip any provider — every selected provider needs its configuration collected before proceeding.

For each provider, also share the relevant Microsoft Learn documentation link so the user knows where to get the values:

**For "Microsoft Account"**:

| Question | Options |
|----------|---------|
| What is the Client ID from your Microsoft app registration? (e.g., `a1b2c3d4-e5f6-7890-abcd-ef1234567890`) | *(free text)* |

> Docs: https://learn.microsoft.com/en-us/power-pages/security/authentication/openid-settings

**For "Facebook"**:

| Question | Options |
|----------|---------|
| What is the App ID from the Facebook Developer Console? (e.g., `1234567890123456`) | *(free text)* |

> Docs: https://learn.microsoft.com/en-us/power-pages/security/authentication/facebook-settings

**For "Google"**:

| Question | Options |
|----------|---------|
| What is the Client ID from the Google Cloud Console? (e.g., `123456789-abc.apps.googleusercontent.com`) | *(free text)* |

> Docs: https://learn.microsoft.com/en-us/power-pages/security/authentication/openid-settings

**For "OpenID Connect (Generic)"**:

| Question | Options |
|----------|---------|
| What is the Authority URL for your OpenID Connect provider? (e.g., `https://dev-12345.okta.com/oauth2/default` or `https://login.microsoftonline.com/{tenant}/v2.0`) | *(free text)* |
| What is the Client ID (Application ID) from your provider's app registration? (e.g., `0oa1bcde2fGHIJklmn3o4`) | *(free text)* |
| What is the Metadata Address URL? (Only needed if your provider's metadata is NOT at `{authority}/.well-known/openid-configuration`). Leave blank to auto-derive. | *(free text, optional)* |
| What display name should the login button show? (e.g., `Sign in with Okta`) | *(free text)* |

> Docs: https://learn.microsoft.com/en-us/power-pages/security/authentication/openid-settings

**For "Entra External ID"**:

All values below come from the Microsoft Entra admin center — **App registrations → {your app} → Endpoints** blade.

| Question | Options |
|----------|---------|
| What is the Authority URL? (from the Endpoints blade — e.g., `https://contoso.ciamlogin.com/contoso.onmicrosoft.com/v2.0/` or a custom domain like `https://login.contoso.com/{tenant-id}/v2.0/`) | *(free text)* |
| What is the Client ID (Application ID)? (e.g., `a1b2c3d4-e5f6-7890-abcd-ef1234567890`) | *(free text)* |
| What is the OpenID Connect metadata document URL? (from the Endpoints blade — e.g., `https://contoso.ciamlogin.com/{tenant-id}/v2.0/.well-known/openid-configuration`) | *(free text)* |
| What display name should the login button show? (e.g., `Microsoft Entra External ID` or `Sign in with External ID`. **Do NOT use "Sign in with Microsoft"** — that conflicts with the Microsoft Account social provider.) | *(free text)* |
| Does your Entra External ID app registration use a client secret? (Entra External ID public clients typically use PKCE without a client secret. Only select Yes if your app registration has one configured.) | No (Recommended for public clients), Yes |

> Docs: https://learn.microsoft.com/en-us/power-pages/security/authentication/entra-external-id

> **Implementation note:** Power Pages server treats Entra External ID as a generic OpenID Connect provider (no special CIAM handling). All settings go under `Authentication/OpenIdConnect/{ProviderName}/`. The `provider` value posted to `/Account/Login/ExternalLogin` must match the `AuthenticationType` site setting, which by default equals the authority URL.

**For "SAML2"**:

| Question | Options |
|----------|---------|
| What is the metadata endpoint URL for your SAML2 identity provider? (e.g., `https://adfs.contoso.com/FederationMetadata/2007-06/FederationMetadata.xml`) | *(free text)* |
| What display name should the login button show? (e.g., `Sign in with ADFS`) | *(free text)* |

> Docs: https://learn.microsoft.com/en-us/power-pages/security/authentication/saml2-settings

**For "WS-Federation"**:

| Question | Options |
|----------|---------|
| What is the metadata endpoint URL for your WS-Federation provider? (e.g., `https://adfs.contoso.com/federationmetadata/2007-06/federationmetadata.xml`) | *(free text)* |
| What is the provider realm or identifier? (e.g., `https://adfs.contoso.com/adfs/services/trust`) | *(free text)* |
| What display name should the login button show? (e.g., `Sign in with ADFS`) | *(free text)* |

> Docs: https://learn.microsoft.com/en-us/power-pages/security/authentication/ws-federation-settings

**For "Local Authentication"** (only if user explicitly requested it): Ask the user how they want users to identify themselves when logging in:

| Question | Options |
|----------|---------|
| How should users log in with their local account? | Login by email (Recommended) — Users sign in with their email address, Login by username — Users sign in with a chosen username |

This choice determines the `Authentication/Registration/LocalLoginByEmail` site setting (`true` for email, `false` for username) and affects every form field in the login, registration, and auth service code. When **email** is chosen, the login and registration forms show an `Email` field (type `email`). When **username** is chosen, the forms show a `Username` field (type `text`) and `Email` becomes a separate required field on the registration form (the server needs it for the contact record). Store this choice — it will be used in Phase 3 (auth service), Phase 5 (sign-in and registration pages), and Phase 8.1 (site settings).

**For "Microsoft Entra ID"**: No additional configuration needed — configured via Power Pages admin center.

> Docs: https://learn.microsoft.com/en-us/power-pages/security/authentication/openid-settings

Then determine the scope:

| Question | Options |
|----------|---------|
| Which authentication features do you need? | Login & Logout + Role-based access control (Recommended), Login & Logout only, Role-based access control only (auth service already exists) |

Then ask about optional features:

| Question | Options |
|----------|---------|
| Would you like to enable any of these optional features? | None (Recommended), Terms and Conditions — require users to accept terms before accessing the site, Two-factor authentication (2FA) — users verify with a code after login, Invitation-based registration — only users with invitation codes can register |

> **Note:** The user can select multiple options. If they select 2FA, Phase 8.1 will create the `TwoFactorEnabled` site settings. If they select invitation-based registration, Phase 8.1 will create `InvitationEnabled`, `RequireInvitationCode`, and `OpenRegistrationEnabled` site settings. If they select Terms and Conditions, follow the Terms flow below.

**If "Terms and Conditions" is selected**, collect the terms content. The server uses 4 content snippets — the skill hardcodes these values into the SPA Terms page component. Ask the user:

| Question | Header | Options |
|----------|--------|---------|
| What terms text should be shown to users? You can provide HTML or plain text. | Terms Content | Use default terms (Recommended) — Generic terms covering data use, account responsibility, and acceptable use, I'll provide my own terms text |

If the user provides custom text, use it. Otherwise use the default terms template (see `authentication-reference.md` for the default content).

Also collect optional customizations:

| Question | Header | Options |
|----------|--------|---------|
| Would you like to customize the terms page labels? | Labels | Use defaults (Recommended) — heading: "Terms and Conditions", checkbox: "I agree to these terms and conditions.", button: "Confirm", I'll customize the labels |

Store these 4 values — they'll be hardcoded into the Terms page component in Phase 5 and created as content snippets in Phase 8.1:
- `TERMS_HEADING` (default: "Terms and Conditions")
- `TERMS_CONTENT` (default: generic terms HTML)
- `TERMS_AGREEMENT_TEXT` (default: "I agree to these terms and conditions.")
- `TERMS_BUTTON_TEXT` (default: "Confirm")

> **GDPR prerequisite**: Terms require the `msdynce_PortalPrivacyExtensions` solution installed in Dataverse. Inform the user: "Terms and Conditions requires the GDPR/Privacy Extensions solution to be installed in your Dataverse environment. Without it, the server will not enforce terms even if the setting is enabled."

Optionally ask about `TermsPublicationDate`:

| Question | Header | Options |
|----------|--------|---------|
| When should users be re-prompted to accept terms? | Re-consent | Every login (no publication date) — users accept terms every time they sign in, Set a publication date — users re-accept only when terms are updated past this date |

If "Set a publication date", collect the date. The format should be ISO: `YYYY-MM-DD` (e.g., `2026-01-01`). If "Every login", leave `TermsPublicationDate` unset.

If web roles were found in Phase 1.4, also ask:

| Question | Options |
|----------|---------|
| Which web roles should have access to protected areas of the site? | *(List discovered web role names as options)* |

#### 2.1.1 Optional Advanced Settings

After collecting the required provider details, ask if the user wants to configure advanced settings:

| Question | Options |
|----------|---------|
| Would you like to configure advanced authentication settings? (claims mapping, session timeout, scopes, etc.) | No, use defaults (Recommended), Yes, show me the options |

**If "Yes, show me the options"**, present the optional settings table relevant to the selected provider. Only show settings that apply to their provider type. For each setting the user wants to configure, collect the value.

**OpenID Connect / Entra External ID optional settings:**

| Setting | Description | Default |
|---------|-------------|---------|
| `MetadataAddress` | Explicit OIDC metadata endpoint URL (alternative to `Authority` — use when provider needs a specific metadata URL) | Derived from Authority |
| `Scope` | Space-separated OAuth scopes (e.g., `openid profile email`) | `openid` |
| `ResponseType` | OAuth response type (`code`, `id_token`, `code id_token`) | `code id_token` |
| `ResponseMode` | How the IdP returns the response (`form_post`, `query`, `fragment`) | `form_post` for code flow |
| `RedirectUri` | Override the callback URL | `{site-url}/signin-{provider}` |
| `PostLogoutRedirectUri` | URL to redirect to after external logout | Site root |
| `RPInitiatedLogout` | Use RP-initiated logout via `end_session_endpoint` with `id_token_hint`. **Mutually exclusive with `ExternalLogoutEnabled`** — when `true`, `ExternalLogoutEnabled` is forced to `false` by the server. | `false` |
| `Caption` | Display name shown on the login button | Provider name |
| `RegistrationClaimsMapping` | JSON mapping of OIDC claims to Dataverse contact fields on registration (e.g., `{"http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name": "firstname"}`) | None |
| `LoginClaimsMapping` | JSON mapping of OIDC claims to Dataverse contact fields on every login | None |
| `ExternalLogoutEnabled` | Sign out of the IdP when the user logs out (legacy — prefer `RPInitiatedLogout` for OIDC) | `true` |
| `RegistrationEnabled` | Allow new users to register via this provider | `true` |
| `AllowContactMappingWithEmail` | Map external users to existing contacts by email | `false` |
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
| `IssuerFilter` | Wildcard pattern to match issuers across tenants (e.g., `https://login.microsoftonline.com/*/v2.0`). Required for multi-tenant apps — without this, issuer validation fails for non-home tenants. | None |
| `UseUserInfoEndpointforClaims` | Fetch additional claims from the UserInfo endpoint | `false` |
| `UserInfoEndpoint` | Custom UserInfo endpoint URL (if not in metadata) | From metadata |
| `PasswordResetPolicyId` | B2C/External ID password reset user flow policy name | None |
| `ProfileEditPolicyId` | B2C/External ID profile editing user flow policy name | None |
| `DefaultPolicyId` | B2C/External ID default sign-up/sign-in policy name | None |
| `TokenEndPointAuthenticatedMethod` | Token endpoint auth method (`client_secret_post`, `client_secret_basic`, `private_key_jwt`). Use `private_key_jwt` for certificate-based auth in sovereign clouds. | `client_secret_post` |
| `AllowedDynamicAuthorizationParameters` | Comma-separated OIDC parameters allowed to pass through dynamically | None |

**SAML2 optional settings:**

| Setting | Description | Default |
|---------|-------------|---------|
| `AssertionConsumerServiceUrl` | ACS URL (typically `{site-url}/signin-{provider}`) | Derived from site URL |
| `RegistrationClaimsMapping` | JSON mapping of SAML assertions to contact fields on registration | None |
| `LoginClaimsMapping` | JSON mapping of SAML assertions to contact fields on every login | None |
| `ExternalLogoutEnabled` | Enable SAML Single Logout (SLO) | `true` |
| `RegistrationEnabled` | Allow new users to register via this provider | `true` |
| `AllowContactMappingWithEmail` | Map external users to existing contacts by email | `false` |
| `AllowCreateNameIdPolicy` | Include AllowCreate in NameIdPolicy | `true` |
| `DefaultSignatureAlgorithm` | Signature algorithm for SAML requests | Provider default |
| `SigningCertificateFindType` | X509 certificate find type for signing requests | None |
| `SigningCertificateFindValue` | Certificate find value (e.g., thumbprint) | None |
| `ExternalLogoutCertThumbprint` | Certificate thumbprint for SLO response signing | None |
| `SingleLogoutServiceRequestPath` | Custom path for SLO request | Default |
| `SingleLogoutServiceResponsePath` | Custom path for SLO response | Default |
| `Comparison` | AuthnContextComparison type (`exact`, `minimum`, `maximum`, `better`) | None |
| `BackchannelTimeout` | Timeout for metadata retrieval | `00:01:00` |
| `UseTokenLifetime` | Use IdP token lifetime for session | Not set |
| `EmailClaimIdentifier` | Custom claim type for user's email | Standard email claim |
| `IssuerFilter` | Wildcard pattern for multi-tenant issuer matching | None |

**WS-Federation optional settings:**

| Setting | Description | Default |
|---------|-------------|---------|
| `Wreply` | Reply URL for the WS-Fed response | Same as Wtrealm |
| `Whr` | Home realm discovery hint (e.g., a domain name) | None |
| `SignOutWreply` | URL for post-logout redirect | Site root |
| `RegistrationClaimsMapping` | JSON mapping of WS-Fed claims to contact fields on registration | None |
| `LoginClaimsMapping` | JSON mapping of WS-Fed claims to contact fields on every login | None |
| `ExternalLogoutEnabled` | Enable federated sign-out | `true` |
| `RegistrationEnabled` | Allow new users to register via this provider | `true` |
| `AllowContactMappingWithEmail` | Map external users to existing contacts by email | `false` |
| `BackchannelTimeout` | Timeout for metadata retrieval | `00:01:00` |
| `UseTokenLifetime` | Use IdP token lifetime for session | Not set |
| `IssuerFilter` | Wildcard pattern for multi-tenant issuer matching | None |

**Social OAuth optional settings** (Microsoft Account, Facebook, Google):

| Setting | Description | Default |
|---------|-------------|---------|
| `Caption` | Display name on the login button | Provider name |
| `Scope` | OAuth scopes to request (space-separated) | Provider defaults |
| `RegistrationClaimsMapping` | JSON mapping of social claims to contact fields on registration | None |
| `LoginClaimsMapping` | JSON mapping of social claims to contact fields on every login | None |
| `ExternalLogoutEnabled` | Sign out of social provider on logout | `true` |
| `RegistrationEnabled` | Allow new users to register via this provider | `true` |
| `AllowContactMappingWithEmail` | Map external users to existing contacts by email | `false` |
| `BackchannelTimeout` | Timeout for OAuth token exchange | `00:01:00` |

**Local Authentication optional settings:**

| Setting | Description | Default |
|---------|-------------|---------|
| `Authentication/Registration/OpenRegistrationEnabled` | Allow self-registration | `true` |
| `Authentication/Registration/EmailConfirmationEnabled` | Require email confirmation on registration | `false` |
| `Authentication/Registration/RememberMeEnabled` | Show "Remember me" checkbox on login form | `false` |
| `Authentication/Registration/ResetPasswordEnabled` | Enable forgot password flow | `true` |
| `Authentication/Registration/ResetPasswordRequiresConfirmedEmail` | Require confirmed email before allowing password reset | `false` |
| `Authentication/Registration/RequireUniqueEmail` | Enforce unique email addresses | `false` |
| `Authentication/Registration/TermsAgreementEnabled` | Require terms & conditions agreement on registration. The server redirects to a Terms page before completing registration. | `false` |
| `Authentication/Registration/IsCaptchaEnabledForRegistration` | Show CAPTCHA on registration form | `false` |
| `Authentication/Registration/TriggerLockoutOnFailedPassword` | Lock account after too many failed login attempts | `true` |
| `Authentication/Registration/DenyMinors` | Deny registration for users identified as minors | `false` |
| `Authentication/Registration/DenyMinorsWithoutParentalConsent` | Deny minors without parental consent (requires GDPR to be enabled) | `false` |

**Session / Cookie settings** (all providers):

| Setting | Description | Default |
|---------|-------------|---------|
| `Authentication/ApplicationCookie/ExpireTimeSpan` | Session timeout duration (e.g., `01:00:00` for 1 hour) | `01:00:00` |
| `Authentication/ApplicationCookie/SlidingExpiration` | Renew cookie on each request | `true` |
| `Authentication/ApplicationCookie/AbsoluteSlidingExpireTimeSpan` | Absolute maximum session lifetime regardless of activity | None |
| `Authentication/ApplicationCookie/CookieName` | Custom session cookie name | Power Pages default |
| `Authentication/ApplicationCookie/CookieDomain` | Cookie domain scope | Current domain |
| `Authentication/ApplicationCookie/CookiePath` | Cookie path scope | `/` |
| `Authentication/ApplicationCookie/CookieHttpOnly` | Prevent JavaScript access to the session cookie | `true` |
| `Authentication/ApplicationCookie/CookieSecure` | Require HTTPS for the session cookie | `true` |
| `Authentication/ApplicationCookie/LoginPath` | Custom login page path | `/Account/Login/Login` |
| `Authentication/ApplicationCookie/SecurityStampValidator/ValidateInterval` | Interval to validate the user's security stamp (e.g., `00:30:00`) | Default |

**Global auth toggles** (all providers):

| Setting | Description | Default |
|---------|-------------|---------|
| `Authentication/Registration/LoginButtonAuthenticationType` | Default provider for the login button | None (shows all) |
| `Authentication/Registration/AzureADLoginEnabled` | Enable/disable Azure AD (Entra ID) login | `true` |
| `Authentication/Registration/ExternalLoginEnabled` | Enable/disable all external identity provider login | `true` |
| `Authentication/Registration/SignOutEverywhereEnabled` | On logout, invalidate all sessions across all devices by updating the user's security stamp | `false` |

For each setting the user wants to configure, create the site setting using `create-site-setting.js` during Phase 8.1 alongside the required settings.

#### 2.2 Present Plan for Approval

Present the implementation plan inline:

- Which files will be created (auth service, types, authorization utils, components)
- How the auth UI will be integrated into the site's navigation
- Which routes/components will be protected and with which roles
- The site setting that needs to be configured (`Authentication/Registration/ProfileRedirectEnabled = false`)

Use `AskUserQuestion` to get approval:

| Question | Options |
|----------|---------|
| Here is the implementation plan for authentication and authorization. Would you like to proceed? | Approve and proceed (Recommended), I'd like to make changes |

**If "Approve and proceed"**: Continue to Phase 3.

**If "I'd like to make changes"**: Ask the user what they want to change, revise the plan, and present it again for approval.

### Output

- Authentication scope confirmed (login/logout, role-based access, or both)
- Target web roles selected
- Implementation plan approved by user

---

## Phase 3: Create Auth Service

**Goal:** Create the authentication service, type declarations, and framework-specific auth hook/composable with local development mock support.

Reference: `${CLAUDE_PLUGIN_ROOT}/skills/setup-auth/references/authentication-reference.md`

### Actions

#### 3.1 Create Type Declarations

Create `src/types/powerPages.d.ts` with type definitions for the Power Pages portal object and user:

- `PowerPagesUser` interface — `userName`, `firstName`, `lastName`, `email`, `contactId`, `userRoles[]`
- `PowerPagesPortal` interface — `User`, `version`, `type`, `id`, `geo`, `tenant`, etc.
- Global `Window` interface extension for `Microsoft.Dynamic365.Portal`

#### 3.2 Create Auth Service

Create the auth service file based on the detected framework and selected identity provider.

**All frameworks**: Create `src/services/authService.ts` with these functions:

- `getCurrentUser()` — reads from `window.Microsoft.Dynamic365.Portal.User`
- `isAuthenticated()` — checks if user exists and has `userName`
- `getAuthProvider()` — returns the configured provider type and identifier
- `fetchAntiForgeryToken()` — fetches from `/_layout/tokenhtml` and parses HTML response
- `login(returnUrl?)` — initiates login based on the configured provider (see below)
- `logout(returnUrl?)` — redirects to `/Account/Login/LogOff`
- `getAuthError()` — parses `?message=` or `?error=` query params from server-side auth error redirects and returns a user-friendly error message
- `getSessionExpiredMessage()` — checks for `?sessionExpired=true` and returns a session-expired message
- `parseServerErrors(html)` — **Required for local auth.** Parses validation errors from server HTML responses (`.validation-summary-errors li`, `.alert-danger li`, `.field-validation-error`). Used by login and register to show server errors in the SPA.
- `register(fields, returnUrl?, invitationCode?)` — **Required when local auth is configured.** POSTs registration form to `/Account/Login/Register` with anti-forgery token, email or username (based on `LocalLoginByEmail` choice from Phase 2.1), password, confirmPassword, and optional invitationCode. When `LocalLoginByEmail` is `true`, sends `Email` field. When `false`, sends `Username` field. See `authentication-reference.md` for the full implementation.
- `forgotPassword(email)` — **Required when local auth is configured.** MVC form POST to `/Account/Login/ForgotPassword` with `Email` + anti-forgery token. Server sends a password reset email. Uses `fetch()` like login.
- `TermsRequiredError` — **Required when terms are enabled.** Custom error class thrown when the server redirects to the terms page after login or registration. The login/registration page catches this and navigates to the SPA `/terms` page.
- `acceptTerms(returnUrl?)` — **Required when terms are enabled.** Fetches the server terms page (GET `/Account/Login/TermsAndConditions`) to get the anti-forgery token, then POSTs acceptance (`IsTermsAndConditionsAccepted=true`, `IsFacebook=False`, `UseExternalSignInAsync=False`, `IsInternalAADUser=False`). Uses the response URL dynamically (server may serve terms from `/Account/Login/TermsAndConditions` or `/TermsAndConditions`).
- `getUserDisplayName()` — prefers full name, falls back to userName
- `getUserInitials()` — for avatar display

**Terms detection in login and registration:** Both `loginLocal()` and `register()` must check `response.url.includes('TermsAndConditions')` after the fetch completes. The server redirects to different URLs depending on the flow:
- **Login**: redirects to `/Account/Login/TermsAndConditions`
- **Registration**: redirects to `/TermsAndConditions?ReturnUrl=%2F`

Both are caught by `response.url.includes('TermsAndConditions')`. When detected, throw `TermsRequiredError`. The server also sets a `DeferredLocalLoginCookie` — it defers the session creation until terms are accepted.

> **CRITICAL — Use `fetch()` not `form.submit()` for local login and registration.** Using `form.submit()` causes a full-page navigation — if the server returns an error, the user leaves the SPA and sees the server-rendered error page. Using `fetch()` instead keeps the user in the SPA: on success (redirect), navigate via `window.location.href`; on failure (200 with HTML), parse errors with `parseServerErrors()` and throw them so the page component can display them inline. See `authentication-reference.md` for the full implementation.

**Login flow varies by provider type:**

- **Microsoft Entra ID**: Form POST to `/Account/Login/ExternalLogin` with provider `https://login.windows.net/{tenantId}/`
- **Entra External ID**: Form POST to `/Account/Login/ExternalLogin` with provider set to the External ID `AuthenticationType` (configured via site settings `Authentication/OpenIdConnect/{provider}/AuthenticationType`). Uses OpenID Connect underneath with the External ID tenant authority URL.
- **OpenID Connect (Generic)**: Form POST to `/Account/Login/ExternalLogin` with provider set to the OIDC `AuthenticationType` (configured via site settings `Authentication/OpenIdConnect/{provider}/AuthenticationType`)
- **SAML2**: Form POST to `/Account/Login/ExternalLogin` with provider set to the SAML2 `AuthenticationType` (configured via site settings `Authentication/SAML2/{provider}/AuthenticationType`)
- **WS-Federation**: Form POST to `/Account/Login/ExternalLogin` with provider set to the WS-Federation `AuthenticationType` (configured via site settings `Authentication/WsFederation/{provider}/AuthenticationType`)
- **Local Authentication**: Form POST to `/SignIn` with `PasswordValue` (not `Password`), anti-forgery token from `/_layout/tokenhtml`, and optionally `RememberMe`. When `LocalLoginByEmail` is `true`, send the `Email` field; otherwise send the `Username` field. Note: the login endpoint uses `/SignIn` and `PasswordValue` — these differ from the registration endpoint which uses `/Account/Login/Register` and `Password`. Does NOT use the ExternalLogin endpoint.
- **Microsoft Account**: Form POST to `/Account/Login/ExternalLogin` with provider `urn:microsoft:account`
- **Facebook**: Form POST to `/Account/Login/ExternalLogin` with provider `Facebook`
- **Google**: Form POST to `/Account/Login/ExternalLogin` with provider `Google`

**CRITICAL**: Power Pages authentication is **server-side** (session cookies). External login flows post a form to the server which redirects to the identity provider. Local login posts credentials directly to the server. There is no client-side token management. The `fetchAntiForgeryToken()` call gets a CSRF token for the form POST, not a bearer token.

**SECRET MANAGEMENT**: Never include `ClientSecret`, `AppSecret`, or any credential values in the auth service code or any file committed to source control. The `providerIdentifier` field is a public identifier (URL or name), not a secret. Actual secrets must be configured through the Power Pages admin center.

**SERVER-RENDERED PAGE HANDLING**: For external login flows, the Power Pages server may redirect to server-rendered pages during certain flows (e.g., first-time registration via `ExternalLoginConfirmation`, 2FA via `SendCode`/`VerifyCode`, terms acceptance via `TermsAndConditions`). These are server-side decisions that the SPA cannot intercept. To minimize these redirects:

- Ensure `Authentication/Registration/OpenRegistrationEnabled` is configured correctly — when `true`, new external users are auto-registered without the `ExternalLoginConfirmation` page
- Ensure `TermsAgreementEnabled` is `false` unless explicitly needed — otherwise every first login shows a server-rendered terms page
- For 2FA flows, the server renders `SendCode` and `VerifyCode` pages — these cannot be replaced by SPA code
- When the user returns from a server-rendered page, the SPA should check for auth state changes (`getCurrentUser()`) and update the UI accordingly
- The auth service's `useAuth` hook should call `refresh()` on mount to pick up session changes that happened outside the SPA

For **local auth**, all error handling is client-side — the `login()` and `register()` functions use `fetch()` (not `form.submit()`) so the user stays in the SPA. Server errors are parsed from HTML responses via `parseServerErrors()` and thrown for the UI to display inline.

#### 3.3 Create Framework-Specific Auth Hook/Composable

Based on the detected framework:

- **React**: Create `src/hooks/useAuth.ts` — custom hook returning `{ user, isAuthenticated, isLoading, displayName, initials, login, logout, refresh }`
- **Vue**: Create `src/composables/useAuth.ts` — composable using `ref`, `computed`, `onMounted` returning reactive auth state
- **Angular**: Create `src/app/services/auth.service.ts` — injectable service with `BehaviorSubject` for user state
- **Astro**: Create `src/services/authService.ts` only (no framework-specific wrapper needed — use the service directly in components)

#### 3.4 Add Mock Data for Local Development

Auth only works when served from Power Pages (not during local `npm run dev`). Add a development mock pattern in the auth service:

```typescript
// In development (localhost), return mock user data for testing
const isDevelopment = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
```

The mock should return a fake user with configurable roles so developers can test role-based UI locally.

#### 3.5 Create Session KeepAlive Hook

> **SPA session expiry problem:** In SPAs, page navigation is client-side — no server requests are made. The session cookie's `SlidingExpiration` only renews when the browser sends a request to the server. Without a keepalive, the session silently expires even while the user is actively using the SPA. The default `ExpireTimeSpan` is 24 hours with renewal at the halfway point (12 hours), but this can be configured shorter.

Create a session keepalive hook that periodically pings `/_layout/tokenhtml` to renew the session cookie:

- **React**: Create `src/hooks/useSessionKeepAlive.ts`
- **Vue**: Create `src/composables/useSessionKeepAlive.ts`
- **Angular**: Create `src/app/services/session-keepalive.service.ts`

The hook must:

- Define a `SESSION_EXPIRE_MS` constant based on the session timeout:
  - If the user configured a custom `ApplicationCookie/ExpireTimeSpan` in Phase 2.1.1, convert that timespan to milliseconds
  - If using defaults, use `24 * 60 * 60 * 1000` (24 hours)
- Derive timing from the session timeout — do NOT hardcode intervals:
  - `intervalMs` = `min(SESSION_EXPIRE_MS / 3, 15 * 60 * 1000)` — ping at 1/3 of the session timeout, capped at 15min. This ensures the ping happens well before the SlidingExpiration halfway renewal point.
  - `idleTimeoutMs` = `min(SESSION_EXPIRE_MS * 0.9, 30 * 60 * 1000)` — stop pinging when idle for 90% of the session timeout, capped at 30min.
  - Example: 10min session → intervalMs=3.3min, idleTimeoutMs=9min. 24h session → intervalMs=15min, idleTimeoutMs=30min.
- Ping `/_layout/tokenhtml` via `fetchAntiForgeryToken()` at the calculated interval
- Only ping when the user is authenticated (`isAuthenticated()`)
- Only ping when the browser tab is visible (`document.visibilityState !== 'hidden'`)
- Track user activity (mouse, keyboard, touch, scroll) and stop pinging after `idleTimeoutMs` of idle — let the session expire naturally for security
- Detect session expiry: if the ping fails, call `onSessionExpired` callback so the app can redirect to login with `?sessionExpired=true`
- Skip entirely in development mode (no real session to keep alive)

Integrate the hook into the Layout component so it runs on every page. Pass an `onSessionExpired` callback that navigates to `/login?sessionExpired=true`. The login page already handles `?sessionExpired=true` via `getSessionExpiredMessage()`.

### Output

- `src/types/powerPages.d.ts` created with Power Pages type definitions
- `src/services/authService.ts` created with login/logout functions
- Framework-specific auth hook/composable created
- Session keepalive hook created and integrated into Layout
- Local development mock data included

---

## Phase 4: Create Authorization Utils

**Goal:** Create role-checking utilities and framework-specific authorization components (guards, directives, wrapper components).

Reference: `${CLAUDE_PLUGIN_ROOT}/skills/setup-auth/references/authorization-reference.md`

### Actions

#### 4.1 Create Core Authorization Utilities

Create `src/utils/authorization.ts` with:

- `getUserRoles()` — returns array of role names from current user
- `hasRole(roleName)` — case-insensitive single role check
- `hasAnyRole(roleNames)` — OR check across multiple roles
- `hasAllRoles(roleNames)` — AND check across multiple roles
- `isAuthenticated()` — re-exports from auth service
- `isAdmin()` — checks for "Administrators" role
- `hasElevatedAccess(additionalRoles)` — checks admin or specified roles

#### 4.2 Create Framework-Specific Authorization Components

Based on the detected framework:

**React:**

- `src/components/RequireAuth.tsx` — renders children only for authenticated users, optional login prompt fallback
- `src/components/RequireRole.tsx` — renders children only for users with specified roles, supports `requireAll` mode
- `src/hooks/useAuthorization.ts` — hook returning `{ roles, hasRole, hasAnyRole, hasAllRoles, isAuthenticated, isAdmin }`

**Vue:**

- `src/composables/useAuthorization.ts` — composable with computed roles and role-checking functions
- `src/directives/vRole.ts` — `v-role` directive for declarative role-based visibility

**Angular:**

- `src/app/guards/auth.guard.ts` — `CanActivateFn` with route data for required roles
- `src/app/directives/has-role.directive.ts` — structural directive `*appHasRole="'RoleName'"`

**Astro:**

- `src/utils/authorization.ts` only (use directly in component scripts)

#### 4.3 Security Reminder

Add a comment at the top of the authorization utilities:

```typescript
// IMPORTANT: Client-side authorization is for UX only, not security.
// Server-side table permissions enforce actual access control.
// Always configure table permissions via /integrate-webapi.
```

### Output

- `src/utils/authorization.ts` created with role-checking functions
- Framework-specific authorization components created (guards, directives, or wrapper components)
- Security reminder comments included

---

## Phase 5: Create Auth UI

**Goal:** Create the login/logout button component and integrate it into the site's navigation.

### Actions

#### 5.1 Create Auth Button Component

Based on the detected framework, create a login/logout button component:

- **React**: `src/components/AuthButton.tsx` + `src/components/AuthButton.css`
- **Vue**: `src/components/AuthButton.vue`
- **Angular**: `src/app/components/auth-button/auth-button.component.ts` + template + styles
- **Astro**: `src/components/AuthButton.astro`

The component should:

- Show a "Sign In" button when the user is not authenticated
- Show the user's display name, avatar (initials-based), and a "Sign Out" button when authenticated
- Include a loading state while checking auth status
- Be styled to match the site's existing design (read existing CSS variables/theme)

#### 5.1.1 Create Sign-In Page (Multi-Provider Only)

> **Route naming — avoid server conflicts:** Power Pages reserves `/SignIn`, `/Register`, and all `/Account/Login/*` paths for server-rendered auth pages. SPA routes MUST NOT collide with these. Use `/login` for the sign-in page and `/registration` for the registration page.

**If more than one auth provider is configured**, create a dedicated `/login` page that shows all provider options. This page:

- Lists all external provider buttons (e.g., "Sign in with External ID", "Sign in with Google")
- If local auth is also configured, shows a local login form (expand on click) with the appropriate credential field — an `Email` field (type `email`) when `LocalLoginByEmail` is `true`, or a `Username` field (type `text`) when `false`. Include a "Forgot password?" link pointing to `/Account/Login/ForgotPassword` and a "Create an account" link (the "Create an account" link should point to `/registration` and should only be shown when `OpenRegistrationEnabled` is `true` — omit it for invitation-only registration)
- Displays server-side auth errors parsed from `?message=` query params (via `getAuthError()`) and session-expired messages from `?sessionExpired=true` (via `getSessionExpiredMessage()`). Both should be checked on mount and displayed at the top of the page.
- Is styled to match the site's design (centered card layout with provider buttons)

See the multi-provider AuthButton component pattern in `authentication-reference.md` for the implementation.

For single-provider sites, the AuthButton component in the nav bar is sufficient — no separate page needed.

When the `/login` page exists, the "Sign In" button in the nav bar should navigate to `/login` instead of directly calling `login()`.

#### 5.1.2 Create Registration Page (Local Auth Only)

**If local authentication is configured AND `OpenRegistrationEnabled` is `true`**, create a dedicated `/registration` page for self-service user registration. This is essential — without it, users have no way to create a local account.

> **Important architectural note:** The server-side registration page (`/Account/Login/Register`) is an ASP.NET Web Forms page, NOT an MVC action. This means it requires `__VIEWSTATE` and uses fully-qualified control names (e.g., `ctl00$...$EmailTextBox`). The `register()` function in authService handles this by first fetching the server page (GET), parsing the ViewState and control names, then POSTing with the correct payload. This is different from login, which is a simple MVC form POST.

The registration page must:

- Call the `register()` function from authService, which handles the Web Forms ViewState pattern (fetch server page → parse → POST with correct control names)
- Show the correct credential field based on the `LocalLoginByEmail` choice from Phase 2.1:
  - **Email mode** (`LocalLoginByEmail = true`): Show an `Email` field (type `email`). This is both the login identifier and email address.
  - **Username mode** (`LocalLoginByEmail = false`): Show a `Username` field (type `text`) AND a separate `Email` field (type `email`). Both are required — Username is the login identifier, Email is needed for the contact record.
- Include `Password` and `Confirm Password` fields (both type `password`)
- Validate that passwords match client-side before submitting
- Display server-side registration errors parsed from `?message=` query params (via `getAuthError()`)
- Parse and pass through `invitationCode` from the URL query string (for invitation-based registration flows where the user arrives via `?invitationCode=...`)
- Include an "Already have an account? Sign in" link back to `/login`
- **Skip the auth redirect in development mode** — in dev mode the mock user is always "authenticated", which would block testing the registration form. Add: `const isDev = window.location.hostname === 'localhost'` and only redirect if `isAuthenticated && !isDev`.
- Be styled to match the site's existing sign-in page design (centered card layout)

**Framework-specific implementation:**

- **React**: Create `src/pages/Registration.tsx` and add `<Route path="/registration" element={<Registration />} />` to the router. See the `RegisterForm` component in `authentication-reference.md` for the implementation pattern — adapt it to match the site's existing styling patterns (inline styles, CSS variables, etc.)
- **Vue**: Create `src/pages/Registration.vue` and add the route to `src/router/index.ts`
- **Angular**: Create `src/app/pages/registration/registration.component.ts` and add the route to the router config
- **Astro**: Create `src/pages/registration.astro`

**If `OpenRegistrationEnabled` is `false`** (invitation-only registration), skip the registration page — users register via invitation links (`{site-url}/Account/Login/RedeemInvitation?InvitationCode={code}`) handled entirely server-side.

#### 5.1.3 Create Forgot Password Page (Local Auth Only)

**If local authentication is configured AND `ResetPasswordEnabled` is `true`**, create a `/forgot-password` page. This is a simple form that collects the user's email and POSTs to the server, which sends a password reset link via email.

> **Note:** The forgot password endpoint (`/Account/Login/ForgotPassword`) is an MVC form (like login), NOT a Web Forms page (like registration). A simple `fetch()` POST with `Email` + `__RequestVerificationToken` works. The `forgotPassword()` function in authService handles this.

The forgot password page must:

- Show an email input field
- Call `forgotPassword(email)` from authService on submit
- Display server errors inline (the `forgotPassword()` function uses fetch and throws parsed errors)
- Include a "Back to sign in" link to `/login`
- Use the same validate-on-blur pattern as login and registration (validate email format on blur, clear on change)

The login page's "Forgot password?" link should point to `/forgot-password` (SPA route), NOT `/Account/Login/ForgotPassword` (server URL).

After the server processes the request, it sends a reset email. The reset link in the email goes to the server-rendered `/Account/Login/ResetPassword` page — this step stays server-side since the user arrives from their email client, not from the SPA.

#### 5.1.4 Validation Pattern for All Auth Pages (Local Auth Only)

All local auth pages (login, registration, forgot password) must implement **validate-on-blur, clear-on-change** for real-time field validation. This is the modern UX pattern — errors appear when the user leaves a field and disappear as they correct it.

**Implementation pattern:**

1. Track `touched` state per field (which fields the user has interacted with)
2. **On blur** (`onBlur`): mark field as touched, run validation, show error immediately
3. **On change** (`onChange`): if the field was already touched, re-validate and clear the error as soon as the value becomes valid. Also clear server errors on any change.
4. **On submit**: mark ALL fields as touched, validate everything, show all errors at once
5. `showError(field)` helper: only return the error if the field has been touched

**Validation rules:**

| Page | Field | Validation |
|------|-------|-----------|
| Login | Email | Required + valid email format |
| Login | Password | Required |
| Registration | Email | Required + valid email format |
| Registration | Password | Required + min 8 chars + characters from at least 3 of 4 categories (lowercase, uppercase, digit, special character) |
| Registration | Confirm Password | Required + must match Password |
| Forgot Password | Email | Required + valid email format |

The password strength validation matches the default Power Pages password policy (`EnforcePasswordPolicy`). If the site creator customizes the password policy via `Authentication/UserManager/PasswordValidator/*` site settings, the client-side validation should match.

#### 5.1.5 Create Terms and Conditions Page (When Terms Enabled)

**If the user enabled Terms and Conditions in Phase 2**, create a `/terms` SPA page. This page is shown when the server redirects to the terms page after login or registration — the SPA intercepts the redirect and shows this page instead of the server-rendered one.

The terms page must:

- Hardcode the 4 snippet values collected in Phase 2 as constants at the top of the component:
  ```typescript
  const TERMS_HEADING = '<value from Phase 2 or default>'
  const TERMS_CONTENT = '<HTML content from Phase 2 or default>'
  const TERMS_AGREEMENT_TEXT = '<value from Phase 2 or default>'
  const TERMS_BUTTON_TEXT = '<value from Phase 2 or default>'
  ```
- Display the heading, terms content (rendered as HTML via `dangerouslySetInnerHTML`), checkbox with agreement text, and confirm button
- The confirm button calls `acceptTerms('/')` from authService — this fetches the server terms page to get the anti-forgery token, then POSTs the acceptance
- The confirm button is disabled until the checkbox is checked
- Display server errors inline if `acceptTerms()` throws
- Include a "Back to sign in" link to `/login`

**Both Login and Registration pages must catch `TermsRequiredError`:**
- In the Login page's `loginLocal()` catch block: if `err instanceof TermsRequiredError`, navigate to `/terms`
- In the Registration page's `register()` catch block: if `err instanceof TermsRequiredError`, navigate to `/terms`

**How the server triggers terms:**
- **Login flow**: Server redirects to `/Account/Login/TermsAndConditions` after auth
- **Registration flow**: Server redirects to `/TermsAndConditions?ReturnUrl=%2F` after registration (different URL!)
- Both are detected by `response.url.includes('TermsAndConditions')` in the auth service

**Framework-specific implementation:**
- **React**: Create `src/pages/Terms.tsx` and add `<Route path="/terms" element={<Terms />} />` to the router

> **Content updates**: When the site creator wants to change the terms text, they update the constants in the Terms page component and redeploy. The content snippets in Dataverse (`Account/Signin/TermsAndConditionsCopy` etc.) must also be updated to match — the server-rendered terms page reads from snippets, and the SPA reads from the hardcoded constants. Both must stay in sync.

#### 5.2 Integrate into Navigation

Find the site's navigation component and integrate the auth button:

1. Search for the nav/header component in the site's source code
2. Import the AuthButton component
3. **Replace any existing hardcoded sign-in link** (e.g., `<Link to="/login">Sign In</Link>` or `<a href="/signin">`) with the AuthButton component. The AuthButton reads `window.Microsoft.Dynamic365.Portal.User` to dynamically show either "Sign In" (when not authenticated) or the user's name + avatar + "Sign Out" button (when authenticated). A hardcoded link does not react to auth state.
4. **If multiple providers are configured**: The AuthButton's "Sign In" action should navigate to `/login` page
5. **If single provider**: The AuthButton's "Sign In" action should call `login()` directly
6. **Verify** after integration that the Navbar does NOT have both a hardcoded sign-in link AND the AuthButton — there must be exactly one auth entry point in the navigation.

#### 5.3 Git Commit

Stage and commit the auth files:

```bash
git add -A
git commit -m "Add authentication service and auth UI component"
```

### Output

- Auth button component created for the detected framework
- Auth button integrated into the site's navigation
- Registration page created (when local auth with open registration is configured)
- Changes committed to git

---

## Phase 6: Implement Role-Based UI

**Goal:** Identify protected content areas and apply role-based authorization patterns to the site's components.

### Actions

#### 6.1 Identify Protected Content

Analyze the site's components to find content that should be role-gated:

- Admin-only sections (dashboards, settings)
- Authenticated-only content (profile, data views)
- Role-specific features (edit buttons, create forms)

Present findings to the user and confirm which areas to protect.

#### 6.2 Apply Authorization Patterns

Based on the user's choices, wrap the appropriate components:

**React example:**

```tsx
<RequireAuth fallback={<p>Please sign in to view this content.</p>}>
  <Dashboard />
</RequireAuth>

<RequireRole roles={['Administrators']} fallback={<p>Access denied.</p>}>
  <AdminPanel />
</RequireRole>
```

**Vue example:**

```vue
<div v-role="'Administrators'">
  <AdminPanel />
</div>
```

**Angular example:**

```typescript
{ path: 'admin', component: AdminComponent, canActivate: [authGuard, roleGuard], data: { roles: ['Administrators'] } }
```

#### 6.3 Git Commit

Stage and commit:

```bash
git add -A
git commit -m "Add role-based access control to site components"
```

### Output

- Protected content areas identified and confirmed with user
- Role-based authorization patterns applied to components
- Changes committed to git

---

## Phase 7: Verify Auth Setup

**Goal:** Validate that all auth files exist, the project builds, and the auth UI renders correctly.

### Actions

#### 7.1 Verify File Inventory

Confirm the following files were created:

- `src/types/powerPages.d.ts` — Power Pages type declarations
- `src/services/authService.ts` — Auth service with login/logout functions
- Framework-specific auth hook/composable (e.g., `src/hooks/useAuth.ts` for React)
- `src/utils/authorization.ts` — Role-checking utilities
- Framework-specific authorization components (e.g., `RequireAuth.tsx`, `RequireRole.tsx` for React)
- Auth button component (e.g., `src/components/AuthButton.tsx` for React)
- Registration page (e.g., `src/pages/Registration.tsx` for React) — only when local auth with open registration is configured
- Forgot password page (e.g., `src/pages/ForgotPassword.tsx` for React) — only when local auth with reset password is configured
- Session keepalive hook (e.g., `src/hooks/useSessionKeepAlive.ts` for React) — integrated into Layout
- Terms page (e.g., `src/pages/Terms.tsx` for React) — only when terms are enabled

Read each file and verify it contains the expected exports and functions:

- Auth service: `login`, `logout`, `getCurrentUser`, `isAuthenticated`, `fetchAntiForgeryToken`, `parseServerErrors`, `register`, `forgotPassword` (when local auth), `TermsRequiredError`, `acceptTerms` (when terms enabled)
- Authorization utils: `hasRole`, `hasAnyRole`, `hasAllRoles`, `getUserRoles`
- Login and registration pages: validate-on-blur pattern with `touched` state, `handleBlur`, `handleChange`, `showError` helper. Both must catch `TermsRequiredError` and navigate to `/terms` (when terms enabled).
- Session keepalive: integrated in Layout, pings `/_layout/tokenhtml`, tracks activity, detects expiry

#### 7.2 Verify Build

Run the project build to catch any import errors, type errors, or missing dependencies:

```bash
npm run build
```

If the build fails, fix the issues before proceeding.

#### 7.3 Verify Auth UI Renders

Start the dev server and verify the auth button appears in the navigation:

```bash
npm run dev
```

Use Playwright to navigate to the site and take a snapshot to confirm the auth button is visible:

- Navigate to `http://localhost:<port>`
- Take a browser snapshot
- Verify the auth button (Sign In / mock user) appears in the navigation area

If the auth button is not visible or the page has rendering errors, fix the issues.

### Output

- All auth files verified (present and contain expected exports)
- Project builds successfully
- Auth UI renders correctly in the browser

---

## Phase 8: Review & Deploy

**Goal:** Create required site settings, present a summary of all work, and prompt for deployment.

### Actions

#### 8.1 Create Site Settings

The site needs provider-specific site settings. Check if `.powerpages-site/site-settings/` exists. Use the `create-site-setting.js` script for all site settings:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/create-site-setting.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --name "<Setting/Name>" \
  --value "<value>" \
  --description "<description>"
```

**`{ProviderName}` naming convention:** Replace `{ProviderName}` with the protocol followed by an incrementing number:
- OpenID Connect: `OpenIdConnect_1`, `OpenIdConnect_2`, etc.
- Entra External ID: `OpenIdConnect_1` (uses OIDC path)
- SAML2: `SAML2_1`, `SAML2_2`, etc.
- WS-Federation: `WsFederation_1`, `WsFederation_2`, etc.

**Handling re-runs:** If `create-site-setting.js` exits with code 1 because a setting already exists, skip that setting and continue. The existing setting is already configured from a previous run. Do not treat this as a fatal error. The script checks for duplicates by both setting name and filename (case-insensitive) — no overwrites happen.

**CRITICAL — Redirect URI / CallbackPath uniqueness when multiple OIDC providers are configured:**

The OWIN OpenID Connect middleware defaults `CallbackPath` to `/signin-oidc` for **every** OIDC provider. If you configure two OIDC providers (e.g., Entra External ID + Okta) without setting unique CallbackPath values, they will both claim `/signin-oidc` and authentication will silently fail for one.

**When creating site settings for a second (or later) OIDC provider:**

1. Read existing site settings in `.powerpages-site/site-settings/` matching `Authentication/OpenIdConnect/*/CallbackPath` and `Authentication/OpenIdConnect/*/RedirectUri`
2. Derive a unique suffix for the new provider (e.g., `-extid`, `-okta`, based on ProviderName)
3. Set `CallbackPath` to `/signin-oidc-<suffix>` (unique across all OIDC providers)
4. Set `RedirectUri` to `{site-url}/signin-oidc-<suffix>` (must match CallbackPath)
5. Tell the user to add this exact redirect URI to their identity provider's app registration

For the first/only OIDC provider, you can use the OWIN default `/signin-oidc` — but explicitly setting it is still recommended for clarity.

**How values are sourced:**
- **Non-secret values** (authority URL, site URL, redirect URIs, AuthenticationType) → filled automatically from information gathered during the flow. The user should NOT need to edit any files.
- **ClientId / AppId** → collected from the user in Phase 2.1 (each provider's follow-up question). Use the collected value when creating the site setting.
- **Secrets** (`ClientSecret`, `AppSecret`) → use environment variables via `create-environment-variable.js`. Never ask for or store secret values directly. See Phase 8.1.1 below.

**Always create** — these settings are required for all provider types:

> **ProfileRedirectEnabled MUST be `false` for code sites.** If `create-site-setting.js` reports this setting already exists, read the YAML file and check its value. If it is `true`, edit the file to set `value: false`. When this is `true`, the server redirects users to `/profile` after login/registration instead of respecting the `ReturnUrl` — which breaks the SPA flow.

```powershell
node "${CLAUDE_PLUGIN_ROOT}/scripts/create-site-setting.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --name "Authentication/Registration/ProfileRedirectEnabled" \
  --value "false" \
  --description "Disable profile redirect for code sites" \
  --type boolean

node "${CLAUDE_PLUGIN_ROOT}/scripts/create-site-setting.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --name "Authentication/Registration/Enabled" \
  --value "true" \
  --description "Enable user registration (global toggle)" \
  --type boolean

node "${CLAUDE_PLUGIN_ROOT}/scripts/create-site-setting.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --name "Authentication/Registration/ExternalLoginEnabled" \
  --value "true" \
  --description "Enable external identity provider login" \
  --type boolean
```

**Provider-specific settings** — create site settings for **EACH** provider selected in Phase 2.1. If the user selected multiple providers (e.g., Entra External ID + Local Authentication), create settings for ALL of them:

**Microsoft Entra ID** (no additional settings needed — configured via Power Pages admin center).

**OpenID Connect (Generic)** — create settings for the provider (ClientId was collected in Phase 2.1):

```powershell
# Authority (required — or use MetadataAddress as alternative)
node "${CLAUDE_PLUGIN_ROOT}/scripts/create-site-setting.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --name "Authentication/OpenIdConnect/{ProviderName}/Authority" \
  --value "<authority-url-from-user>" \
  --description "OIDC authority URL"

# MetadataAddress (optional — alternative to Authority for providers that need explicit metadata URL)
# Create this if the user provides a metadata URL distinct from the authority
# node "${CLAUDE_PLUGIN_ROOT}/scripts/create-site-setting.js" \
#   --projectRoot "<PROJECT_ROOT>" \
#   --name "Authentication/OpenIdConnect/{ProviderName}/MetadataAddress" \
#   --value "<metadata-url>" \
#   --description "OIDC metadata endpoint URL"

# ClientId — use value collected in Phase 2.1
node "${CLAUDE_PLUGIN_ROOT}/scripts/create-site-setting.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --name "Authentication/OpenIdConnect/{ProviderName}/ClientId" \
  --value "<client-id-from-user>" \
  --description "Application client ID"

# AuthenticationType
node "${CLAUDE_PLUGIN_ROOT}/scripts/create-site-setting.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --name "Authentication/OpenIdConnect/{ProviderName}/AuthenticationType" \
  --value "<authority-url-from-user>" \
  --description "Provider identifier for ExternalLogin"

# RedirectUri — MUST be unique across all OIDC providers (see collision note above)
node "${CLAUDE_PLUGIN_ROOT}/scripts/create-site-setting.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --name "Authentication/OpenIdConnect/{ProviderName}/RedirectUri" \
  --value "<site-url>/signin-oidc-<unique-suffix>" \
  --description "OAuth callback URL — unique per provider"

# CallbackPath — REQUIRED when multiple OIDC providers are configured
# OWIN defaults ALL OIDC providers to /signin-oidc, causing collisions
node "${CLAUDE_PLUGIN_ROOT}/scripts/create-site-setting.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --name "Authentication/OpenIdConnect/{ProviderName}/CallbackPath" \
  --value "/signin-oidc-<unique-suffix>" \
  --description "Unique callback path for this OIDC provider"

# ExternalLogoutEnabled — set to false when using RPInitiatedLogout (they are mutually exclusive)
node "${CLAUDE_PLUGIN_ROOT}/scripts/create-site-setting.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --name "Authentication/OpenIdConnect/{ProviderName}/ExternalLogoutEnabled" \
  --value "false" \
  --description "Legacy logout — disabled when RPInitiatedLogout is used" \
  --type boolean

# RPInitiatedLogout — preferred for OIDC providers with end_session_endpoint
node "${CLAUDE_PLUGIN_ROOT}/scripts/create-site-setting.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --name "Authentication/OpenIdConnect/{ProviderName}/RPInitiatedLogout" \
  --value "true" \
  --description "RP-initiated logout via end_session_endpoint with id_token_hint" \
  --type boolean
```

> **Note:** The `AuthenticationType` value is the unique provider identifier used in the `ExternalLogin` form POST. This value must match what `resolveProviderIdentifier()` returns in the auth service.

**Entra External ID** — uses the authority URL collected in Phase 2.1 (may be `ciamlogin.com` or a custom domain):

```powershell
# Authority — use the exact URL from Phase 2.1 (do NOT hardcode ciamlogin.com)
node "${CLAUDE_PLUGIN_ROOT}/scripts/create-site-setting.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --name "Authentication/OpenIdConnect/{ProviderName}/Authority" \
  --value "<authority-url-from-user>" \
  --description "Entra External ID authority URL"

# MetadataAddress — REQUIRED for Entra External ID per Microsoft Learn docs
# Collected from user in Phase 2.1 (from Endpoints blade in Entra admin center)
node "${CLAUDE_PLUGIN_ROOT}/scripts/create-site-setting.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --name "Authentication/OpenIdConnect/{ProviderName}/MetadataAddress" \
  --value "<metadata-address-from-user>" \
  --description "OIDC metadata document URL"

# ClientId — use value collected in Phase 2.1
node "${CLAUDE_PLUGIN_ROOT}/scripts/create-site-setting.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --name "Authentication/OpenIdConnect/{ProviderName}/ClientId" \
  --value "<client-id-from-user>" \
  --description "Application client ID"

# AuthenticationType — must match authority URL (used as the 'provider' form value in ExternalLogin POST)
node "${CLAUDE_PLUGIN_ROOT}/scripts/create-site-setting.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --name "Authentication/OpenIdConnect/{ProviderName}/AuthenticationType" \
  --value "<authority-url-from-user>" \
  --description "Provider identifier for ExternalLogin — must match authority URL exactly"

# RedirectUri — MUST be unique across all OIDC providers (see collision note below)
node "${CLAUDE_PLUGIN_ROOT}/scripts/create-site-setting.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --name "Authentication/OpenIdConnect/{ProviderName}/RedirectUri" \
  --value "<site-url>/signin-oidc-<unique-suffix>" \
  --description "OAuth callback URL — unique per provider"

# CallbackPath — REQUIRED when multiple OIDC providers are configured to prevent collision
# OWIN defaults ALL OIDC providers to /signin-oidc, so a unique path per provider is needed
node "${CLAUDE_PLUGIN_ROOT}/scripts/create-site-setting.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --name "Authentication/OpenIdConnect/{ProviderName}/CallbackPath" \
  --value "/signin-oidc-<unique-suffix>" \
  --description "Unique callback path for this OIDC provider"

# ExternalLogoutEnabled — set to false when using RPInitiatedLogout
node "${CLAUDE_PLUGIN_ROOT}/scripts/create-site-setting.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --name "Authentication/OpenIdConnect/{ProviderName}/ExternalLogoutEnabled" \
  --value "false" \
  --description "Legacy logout — disabled when RPInitiatedLogout is used" \
  --type boolean

# RPInitiatedLogout — preferred for Entra External ID
node "${CLAUDE_PLUGIN_ROOT}/scripts/create-site-setting.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --name "Authentication/OpenIdConnect/{ProviderName}/RPInitiatedLogout" \
  --value "true" \
  --description "RP-initiated logout via end_session_endpoint" \
  --type boolean
```

> **ClientSecret for Entra External ID:** Only needed if the user confirmed in Phase 2.1 that their app registration uses a client secret. Public clients using PKCE do NOT need a ClientSecret — skip Phase 8.1.1 for this provider entirely. If a secret is needed, use the same environment variable pattern as OIDC (see Phase 8.1.1).

**SAML2** — create settings for the provider:

```powershell
node "${CLAUDE_PLUGIN_ROOT}/scripts/create-site-setting.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --name "Authentication/SAML2/{ProviderName}/MetadataAddress" \
  --value "<metadata-url-from-user>" \
  --description "SAML IdP metadata URL"

node "${CLAUDE_PLUGIN_ROOT}/scripts/create-site-setting.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --name "Authentication/SAML2/{ProviderName}/AuthenticationType" \
  --value "<site-url>" \
  --description "Provider identifier for ExternalLogin — MUST match providerIdentifier in authService exactly"

node "${CLAUDE_PLUGIN_ROOT}/scripts/create-site-setting.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --name "Authentication/SAML2/{ProviderName}/ServiceProviderRealm" \
  --value "<site-url>" \
  --description "SP entity ID"
```

> **CRITICAL for SAML2:** The `AuthenticationType` site setting value and the `providerIdentifier` in the auth service code MUST be character-for-character identical — including protocol (`https://` vs `http://`), trailing slashes, and casing. A mismatch causes login to silently fail. Use the exact same `<site-url>` value in both places.

**WS-Federation** — create settings for the provider:

```powershell
node "${CLAUDE_PLUGIN_ROOT}/scripts/create-site-setting.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --name "Authentication/WsFederation/{ProviderName}/MetadataAddress" \
  --value "<metadata-url-from-user>" \
  --description "WS-Fed metadata URL"

node "${CLAUDE_PLUGIN_ROOT}/scripts/create-site-setting.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --name "Authentication/WsFederation/{ProviderName}/AuthenticationType" \
  --value "<provider-realm-or-identifier>" \
  --description "Provider identifier for ExternalLogin"

node "${CLAUDE_PLUGIN_ROOT}/scripts/create-site-setting.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --name "Authentication/WsFederation/{ProviderName}/Wtrealm" \
  --value "<site-url>" \
  --description "Relying party realm"
```

> **Note:** The `AuthenticationType` value must match what `resolveProviderIdentifier()` returns in the auth service.

**Local Authentication** — use the user's email-vs-username choice from Phase 2.1 for the `LocalLoginByEmail` value:

```powershell
node "${CLAUDE_PLUGIN_ROOT}/scripts/create-site-setting.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --name "Authentication/Registration/LocalLoginEnabled" \
  --value "true" \
  --description "Enable local username/password login" \
  --type boolean

# Set to "true" if the user chose email login, "false" if they chose username login (Phase 2.1)
node "${CLAUDE_PLUGIN_ROOT}/scripts/create-site-setting.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --name "Authentication/Registration/LocalLoginByEmail" \
  --value "<true-or-false-from-user-choice>" \
  --description "Login by email (true) or username (false)" \
  --type boolean

node "${CLAUDE_PLUGIN_ROOT}/scripts/create-site-setting.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --name "Authentication/Registration/OpenRegistrationEnabled" \
  --value "true" \
  --description "Allow self-registration for local accounts" \
  --type boolean

node "${CLAUDE_PLUGIN_ROOT}/scripts/create-site-setting.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --name "Authentication/Registration/ResetPasswordEnabled" \
  --value "true" \
  --description "Enable forgot password flow for local accounts" \
  --type boolean

# Disable CAPTCHA — required for code sites because the SPA registration form cannot render
# the server-side CAPTCHA widget. Without this, registration silently fails.
node "${CLAUDE_PLUGIN_ROOT}/scripts/create-site-setting.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --name "Authentication/Registration/CaptchaEnabled" \
  --value "false" \
  --description "Disable CAPTCHA for SPA registration" \
  --type boolean

node "${CLAUDE_PLUGIN_ROOT}/scripts/create-site-setting.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --name "Authentication/Registration/IsCaptchaEnabledForRegistration" \
  --value "false" \
  --description "Disable CAPTCHA for SPA registration form" \
  --type boolean
```

**Facebook** — uses `AppId` (not `ClientId`). The App ID was collected in Phase 2.1:

```powershell
node "${CLAUDE_PLUGIN_ROOT}/scripts/create-site-setting.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --name "Authentication/OpenAuth/Facebook/AppId" \
  --value "<app-id-from-user>" \
  --description "Facebook App ID"
```

**Google** — the Client ID was collected in Phase 2.1:

```powershell
node "${CLAUDE_PLUGIN_ROOT}/scripts/create-site-setting.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --name "Authentication/OpenAuth/Google/ClientId" \
  --value "<client-id-from-user>" \
  --description "Google Client ID"
```

**Microsoft Account** — the Client ID was collected in Phase 2.1:

```powershell
node "${CLAUDE_PLUGIN_ROOT}/scripts/create-site-setting.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --name "Authentication/OpenAuth/MicrosoftAccount/ClientId" \
  --value "<client-id-from-user>" \
  --description "Microsoft Account Client ID"
```

#### 8.1.1 Handle Secrets via Azure Key Vault

**Only run this phase if a provider requires a secret.** Skip entirely when none of the configured providers need one.

Providers that **may** require a secret:
- **OpenID Connect (Generic)** — usually yes (confidential client)
- **Entra External ID** — only if the user confirmed in Phase 2.1 that their app registration uses a client secret. Public clients using PKCE do NOT need a secret — skip for them.
- **Microsoft Account / Facebook / Google** — yes (social OAuth requires app secret)
- **SAML2 / WS-Federation** — no (certificate-based, not secrets)
- **Local Authentication** — no
- **Microsoft Entra ID** — no (configured via Power Pages admin center)

**If no provider requires a secret, skip this entire phase 8.1.1 and proceed to the invitation/2FA blocks.**

For secrets (`ClientSecret`, `AppSecret`), **never store them in site setting YAML files or as plain-text environment variables**. Use Azure Key Vault to store secrets, then reference them via Dataverse environment variables with `--type secret`.

**Step 1 — List available Key Vaults:**

```powershell
node "${CLAUDE_PLUGIN_ROOT}/scripts/list-azure-keyvaults.js"
```

**Step 2 — Select or create a Key Vault:**

If Key Vaults were found, ask which one to use:

| Question | Context |
|----------|---------|
| Which Azure Key Vault would you like to use for storing auth secrets? | Present the names from the script output |

If **no Key Vaults are found**:

| Question | Options |
|----------|---------|
| No Azure Key Vaults were found. Would you like to create one? | Create a new Key Vault (Recommended), Skip Key Vault — I'll configure secrets later |

**If "Create a new Key Vault"**: Ask for vault name, resource group, and location:

```powershell
node "${CLAUDE_PLUGIN_ROOT}/scripts/create-azure-keyvault.js" \
  --name "<vault-name>" \
  --resourceGroup "<resource-group>" \
  --location "<location>"
```

**If "Skip Key Vault"**: Skip to "Fallback" below.

**Step 3 — Instruct the user to store each secret in Key Vault:**

Do **not** ask for secret values — they must never pass through the conversation. Present **both** options:

**Option A — Azure CLI (recommended):**

```
For each secret, run the following command (replacing <YOUR_SECRET_VALUE> with the actual value):

1. <Provider> Client Secret:
   printf '%s' '<YOUR_SECRET_VALUE>' | node "${CLAUDE_PLUGIN_ROOT}/scripts/store-keyvault-secret.js" \
     --vaultName "<selected-vault>" \
     --secretName "<provider>-client-secret"
```

Tell the user each command outputs a JSON object with a `secretUri` and to share the output so the workflow can continue.

**Option B — Azure Portal:**

```
1. Go to https://portal.azure.com → Key vaults → <selected-vault> → Secrets
2. Click "+ Generate/Import"
3. Name: <provider>-client-secret, Value: paste your secret
4. Click "Create", then click the secret → current version → copy "Secret Identifier" URI
5. Share the URI here so the workflow can continue
```

**Step 4 — Create environment variable in Dataverse (type: secret):**

After the user shares the `secretUri`, create an environment variable that references the Key Vault secret:

```powershell
node "${CLAUDE_PLUGIN_ROOT}/scripts/create-environment-variable.js" "<ENV_URL>" \
  --schemaName "<prefix_ProviderClientSecret>" \
  --displayName "<Provider> Client Secret" \
  --type "secret" \
  --value "<secretUri-from-step-3>"
```

**Step 5 — Create site setting for the environment variable:**

```powershell
node "${CLAUDE_PLUGIN_ROOT}/scripts/create-site-setting.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --name "Authentication/OpenIdConnect/{ProviderName}/ClientSecret" \
  --envVarSchema "<prefix_ProviderClientSecret>"
```

This creates a site setting with `envvar_schema` and `source: 1`, which tells Power Pages to resolve the value from the Dataverse environment variable (backed by Key Vault).

**Repeat Steps 3-5 for each secret required by the selected providers:**

| Provider | Secret Name | Site Setting | Env Var Schema |
|----------|-------------|--------------|----------------|
| OIDC / Entra External ID | `{provider}-client-secret` | `Authentication/OpenIdConnect/{ProviderName}/ClientSecret` | `{prefix}_ProviderClientSecret` |
| Facebook | `facebook-app-secret` | `Authentication/OpenAuth/Facebook/AppSecret` | `{prefix}_FacebookAppSecret` |
| Google | `google-client-secret` | `Authentication/OpenAuth/Google/ClientSecret` | `{prefix}_GoogleClientSecret` |
| Microsoft Account | `microsoft-client-secret` | `Authentication/OpenAuth/MicrosoftAccount/ClientSecret` | `{prefix}_MicrosoftClientSecret` |

**Fallback — if user skipped Key Vault:**

If the user chose not to use Key Vault, create environment variables with placeholder values (plain string type, not secret type). The user updates them later via the Power Apps maker portal:

```powershell
node "${CLAUDE_PLUGIN_ROOT}/scripts/create-environment-variable.js" "<ENV_URL>" \
  --schemaName "<prefix_ProviderClientSecret>" \
  --displayName "<Provider> Client Secret" \
  --value "PLACEHOLDER_SET_ACTUAL_VALUE"

node "${CLAUDE_PLUGIN_ROOT}/scripts/create-site-setting.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --name "<site-setting-name-from-table-above>" \
  --envVarSchema "<prefix_ProviderClientSecret>"
```

Tell the user to update each placeholder via:
- **Power Apps maker portal** ([make.powerapps.com](https://make.powerapps.com)) → **Solutions** → **Default Solution** → **Environment variables** → find by display name → update the value

Present the list of environment variables that need updating (display name and schema name for each).

**Invitation-Based Registration** — when invitation-based registration is requested:

```powershell
node "${CLAUDE_PLUGIN_ROOT}/scripts/create-site-setting.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --name "Authentication/Registration/InvitationEnabled" \
  --value "true" \
  --description "Enable invitation-based registration" \
  --type boolean

node "${CLAUDE_PLUGIN_ROOT}/scripts/create-site-setting.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --name "Authentication/Registration/RequireInvitationCode" \
  --value "true" \
  --description "Require invitation code to register" \
  --type boolean

node "${CLAUDE_PLUGIN_ROOT}/scripts/create-site-setting.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --name "Authentication/Registration/OpenRegistrationEnabled" \
  --value "false" \
  --description "Disable open registration (invitation-only)" \
  --type boolean
```

> **Note:** Setting `RequireInvitationCode` to `true` and `OpenRegistrationEnabled` to `false` enforces invitation-only registration.

**Two-Factor Authentication** — when 2FA is requested:

```powershell
node "${CLAUDE_PLUGIN_ROOT}/scripts/create-site-setting.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --name "Authentication/Registration/TwoFactorEnabled" \
  --value "true" \
  --description "Enable two-factor authentication" \
  --type boolean

node "${CLAUDE_PLUGIN_ROOT}/scripts/create-site-setting.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --name "Authentication/Registration/RememberMeEnabled" \
  --value "true" \
  --description "Show Remember Me checkbox on login form" \
  --type boolean

node "${CLAUDE_PLUGIN_ROOT}/scripts/create-site-setting.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --name "Authentication/Registration/RememberBrowserEnabled" \
  --value "true" \
  --description "Allow remembering browser to skip 2FA" \
  --type boolean
```

**Terms and Conditions** — when terms are enabled:

> **Prerequisite**: The GDPR/Privacy Extensions solution (`msdynce_PortalPrivacyExtensions`) must be installed in the Dataverse environment. Without it, the server ignores `TermsAgreementEnabled` entirely. Remind the user of this requirement.

```powershell
node "${CLAUDE_PLUGIN_ROOT}/scripts/create-site-setting.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --name "Authentication/Registration/TermsAgreementEnabled" \
  --value "true" \
  --description "Require terms acceptance before accessing the site" \
  --type boolean
```

If the user provided a `TermsPublicationDate`:

```powershell
node "${CLAUDE_PLUGIN_ROOT}/scripts/create-site-setting.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --name "Authentication/Registration/TermsPublicationDate" \
  --value "<ISO-date-from-user>" \
  --description "Users who accepted before this date will be re-prompted"
```

**Create the required content snippet** `Account/Signin/TermsAndConditionsCopy` in `.powerpages-site/content-snippets/`. This snippet MUST exist with non-empty content — without it, the server disables terms even if the setting is `true`. The snippet content should match the `TERMS_CONTENT` constant hardcoded in the SPA Terms page.

Check if the content snippet directory exists and create the snippet YAML file. The format follows the existing snippet pattern in `.powerpages-site/content-snippets/`. If a script exists for creating content snippets, use it. Otherwise, create the YAML file manually following the pattern of existing snippets.

Optionally create the other 3 snippets for the server-rendered terms page (used when the SPA isn't loaded, e.g., deep links):
- `Account/Signin/TermsAndConditionsHeading`
- `Account/Signin/TermsAndConditionsAgreementText`
- `Account/Signin/TermsAndConditionsButtonText`

#### 8.2 Record Skill Usage

> Reference: `${CLAUDE_PLUGIN_ROOT}/references/skill-tracking-reference.md`

Follow the skill tracking instructions in the reference to record this skill's usage. Use `--skillName "SetupAuth"`.

#### 8.3 Present Summary

Present a summary of everything created:

| Component | File(s) | Status |
|-----------|---------|--------|
| Type Declarations | `src/types/powerPages.d.ts` | Created |
| Auth Service | `src/services/authService.ts` | Created |
| Auth Hook/Composable | `src/hooks/useAuth.ts` (or framework equivalent) | Created |
| Authorization Utils | `src/utils/authorization.ts` | Created |
| Auth Components | `RequireAuth`, `RequireRole` (or framework equivalent) | Created |
| Auth Button | `src/components/AuthButton.tsx` (or framework equivalent) | Created |
| Registration Page | `src/pages/Registration.tsx` (or framework equivalent) — local auth only | Created (if applicable) |
| Forgot Password Page | `src/pages/ForgotPassword.tsx` (or framework equivalent) — local auth only | Created (if applicable) |
| Session KeepAlive | `src/hooks/useSessionKeepAlive.ts` (or framework equivalent) — integrated in Layout | Created |
| Terms Page | `src/pages/Terms.tsx` (or framework equivalent) — when terms enabled | Created (if applicable) |
| Terms Snippet | `Account/Signin/TermsAndConditionsCopy` content snippet | Created (if applicable) |
| Site Setting | `ProfileRedirectEnabled = false` | Created |

#### 8.4 Ask to Deploy

Use `AskUserQuestion`:

| Question | Options |
|----------|---------|
| Authentication and authorization are configured. To make login work, the site needs to be deployed. Would you like to deploy now? | Yes, deploy now (Recommended), No, I'll deploy later |

**If "Yes, deploy now"**: Invoke `/deploy-site`.

**If "No"**: Remind the user:

> "Remember to deploy your site using `/deploy-site` when you're ready. Authentication will not work until the site is deployed with the new site settings."

#### 8.5 Post-Deploy Notes

After deployment (or if skipped), remind the user with provider-specific guidance:

- **Test on deployed site**: Auth only works on the deployed Power Pages site, not on `localhost`
- **Identity provider configuration**: Provider-specific setup is required:
  - **Entra ID**: Configure the identity provider in the Power Pages admin center
  - **OpenID Connect**: Register a client application with the OIDC provider and update the `ClientId` site setting. Set the redirect URI in the provider to `{site-url}/signin-{provider}`
  - **SAML2**: Register the site as a service provider (SP) with the SAML IdP. The `ServiceProviderRealm` and `AssertionConsumerServiceUrl` must match the site URL
  - **WS-Federation**: Register the site as a relying party with the WS-Fed provider
  - **Local Authentication**: No external provider needed — users register and log in with username/password directly on the site
  - **Microsoft Account**: Register an application in the Azure portal and update the `ClientSecret` environment variable via the Power Apps maker portal -- do not commit secrets to source control
  - **Facebook**: Register an application in the Facebook Developer Console and update the `AppSecret` environment variable via the Power Apps maker portal -- do not commit secrets to source control
  - **Google**: Register an application in the Google Cloud Console and update the `ClientSecret` environment variable via the Power Apps maker portal -- do not commit secrets to source control
  - **Entra External ID**: Register the application in the Entra External ID tenant. Update the `ClientId` site setting. Set the redirect URI to `{site-url}/signin-{provider}`. The authority URL may use `{tenant}.ciamlogin.com` or a custom domain.
- **Two-Factor Authentication**: If 2FA is enabled (`Authentication/Registration/TwoFactorEnabled = true`), users will be prompted for a verification code after primary login. 2FA is entirely server-managed -- no client-side code changes are needed. Configure 2FA providers in the Power Pages admin center
- **Invitation-based registration**: If invitations are enabled (`Authentication/Registration/InvitationEnabled = true`), share invitation links in the format `{site-url}/Account/Login/Login?invitationCode={code}&returnUrl=/`. The invitation code is threaded through the entire auth flow including 2FA
- **Assign web roles**: Users must be assigned appropriate web roles in the Power Pages admin center
- **Table permissions**: Client-side auth checks are for UX only — configure server-side table permissions via `/integrate-webapi` for actual data security
- **Local development**: The auth service includes mock data for testing on localhost — remove or disable before production

### Output

- `ProfileRedirectEnabled` site setting created
- Full summary presented to user
- Deployment prompted (or skipped with reminder)
- Post-deploy guidance provided

---

## Important Notes

### Progress Tracking

Use `TaskCreate` at the start to track each phase:

| Task | Description |
|------|-------------|
| Phase 1 | Check Prerequisites — verify site, framework, deployment, web roles |
| Phase 2 | Plan — gather requirements and get user approval |
| Phase 3 | Create Auth Service — auth service, types, framework hook/composable |
| Phase 4 | Create Authorization Utils — role-checking functions and components |
| Phase 5 | Create Auth UI — AuthButton component and navigation integration |
| Phase 6 | Implement Role-Based UI — apply authorization patterns to components |
| Phase 7 | Verify Auth Setup — validate files exist, build succeeds, auth UI renders |
| Phase 8 | Review & Deploy — site setting, summary, deployment prompt |

Update each task with `TaskUpdate` as phases are completed.

### Key Decision Points

- **Phase 1.3**: Deploy now or stop? (site must be deployed before auth setup)
- **Phase 1.4**: Create web roles now or skip? (roles needed for authorization)
- **Phase 1.5**: Overwrite or skip existing auth files?
- **Phase 2.1**: Which auth features to include? (login/logout, role-based, or both)
- **Phase 2.2**: Approve plan or request changes?
- **Phase 6.1**: Which content areas to protect with role-based access?
- **Phase 8.3**: Deploy now or later?

---

**Begin with Phase 1: Check Prerequisites**
