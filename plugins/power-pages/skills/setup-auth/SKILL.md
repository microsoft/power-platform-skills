---
name: setup-auth
description: >
  Use when the user asks to "set up authentication", "add login",
  "add logout", "add sign in", "enable auth", "add role-based access",
  "add authorization", "protect routes", "configure identity provider",
  "configure Entra ID", "configure Entra External ID",
  "configure OpenID Connect", "add OIDC", "set up SAML",
  "set up WS-Federation", "set up local login", "add username password",
  "add Facebook login", "add Google sign in", "add Microsoft Account",
  "set up invitation login", or otherwise wants to set up
  authentication (login/logout) and role-based authorization for their
  Power Pages code site using any supported identity provider
  (Microsoft Entra ID, Entra External ID, OpenID Connect, SAML2,
  WS-Federation, local authentication, Microsoft Account, Facebook,
  or Google).
user-invocable: true
allowed-tools: Read, Write, Edit, Bash, Grep, Glob, AskUserQuestion, Task, TaskCreate, TaskUpdate, TaskList, Skill
model: opus
---

> **Plugin check**: Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/check-version.js"` — if it outputs a message, show it to the user before proceeding.

# Set Up Authentication & Authorization

Configure authentication (login/logout) and role-based authorization for a Power Pages code site. This skill supports multiple identity providers -- Microsoft Entra ID, Entra External ID (for customer-facing apps with self-service sign-up), OpenID Connect (generic), SAML2, WS-Federation, local authentication (username/password), Microsoft Account, Facebook, and Google. It also supports optional features including invitation-based registration and Terms & Conditions acceptance. Power Pages built-in 2FA is intentionally not scaffolded because the SendCode/VerifyCode pages are server-rendered and cannot be integrated into a SPA experience — use IdP-level MFA instead. It creates an auth service, type declarations, authorization utilities, auth UI components, and role-based access control patterns appropriate to the site's framework and chosen identity provider(s).

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

#### 1.5 Discover Existing Auth Configuration

**Always run this discovery step, even on a first invocation** — the site may have site settings from a prior run, or from hand-editing the YAML files, even if no SPA auth code exists yet. The goal is to make sure we never silently drop a provider that's already configured server-side.

**Step 1 — Scan `.powerpages-site/site-settings/` for already-configured providers.**

Detect existing providers by matching site-setting filenames against these patterns:

| Pattern | Maps to provider type |
|---|---|
| `Authentication-OpenIdConnect-{Name}-AuthenticationType.sitesetting.yml` | OIDC (Entra External ID, Okta, Auth0, generic OIDC, B2C — all share the OIDC path) |
| `Authentication-SAML2-{Name}-AuthenticationType.sitesetting.yml` | SAML2 |
| `Authentication-WsFederation-{Name}-AuthenticationType.sitesetting.yml` | WS-Federation |
| `Authentication-OpenAuth-{Microsoft\|Facebook\|Google}-{ClientId\|AppId}.sitesetting.yml` | Social OAuth |
| `Authentication-Registration-LocalLoginEnabled.sitesetting.yml` with value `true` | Local Authentication |

For each detected provider, read its full set of `.sitesetting.yml` files to extract: `Authority` / `MetadataAddress`, `ClientId` / `AppId`, `AuthenticationType` (the providerIdentifier), `Caption` or display name (if present), and the `{Name}` slug used in the keys (e.g., `OpenIdConnect_1`, `EntraExternalId`).

**Distinguishing Entra ID variants from OIDC** — by Authority URL pattern:

| Authority pattern | Provider type | Notes |
|---|---|---|
| `https://login.windows.net/{guid}/` (no `/v2.0/`) — site's parent tenant | **Microsoft Entra ID (workforce)** — `type: 'entra-id'` | Auto-populated by Power Pages on site creation. The `{Name}` slug is usually `AzureAD`. **Set `providerIdentifier` to undefined in AUTH_PROVIDERS** — runtime resolver derives it from `Portal.tenant`. |
| `https://{subdomain}.ciamlogin.com/{tenantId}` (no trailing `/v2.0/`) | **Entra External ID** — `type: 'oidc'` | Customer tenant. Must include explicit `providerIdentifier` matching the Authority. |
| `https://{tenant}.b2clogin.com/{tenant}.onmicrosoft.com/v2.0/{policy}` | **Azure AD B2C** (legacy) — `type: 'oidc'` | Older B2C product. Must include explicit `providerIdentifier`. |
| Any other OIDC authority (Okta, Auth0, Ping, etc.) | **OIDC (Generic)** — `type: 'oidc'` | Must include explicit `providerIdentifier`. |

**The Entra ID (workforce) case is special** — when Phase 1.5 discovery detects `Authentication/OpenIdConnect/AzureAD/*` settings on the site (which Power Pages auto-creates for the parent tenant), add a single entry to `EXISTING_PROVIDERS`:

```typescript
{
  id: 'entra-id',
  type: 'entra-id',
  displayName: existingCaption || 'Sign in with Microsoft',
  // NO providerIdentifier — resolveProviderIdentifier() derives it from Portal.tenant
}
```

Do NOT extract the tenant ID from the existing Authority site setting just to hardcode it back into AUTH_PROVIDERS — the runtime resolver handles it. This keeps the SPA code portable if the site is ever cloned to a different tenant.

**Step 2 — Scan for existing SPA auth code.**

Check for these files and read their key markers:

- `src/services/authService.ts` or `.js` — look for `AUTH_PROVIDERS` array (current pattern) vs single `AUTH_PROVIDER` constant (legacy)
- `src/types/powerPages.d.ts` — exists or not
- `src/utils/authorization.ts` — exists or not
- Auth components (`AuthButton.*`, `Login.*`, `Registration.*`, `RedeemInvitation.*`, etc.) — list which exist
- `src/pages/Login.tsx` — extract which providers it currently renders (via `AUTH_PROVIDERS` import or inline)

**Step 3 — Present findings to the user.**

If providers were detected from site settings, present them with their config:

```
I found these existing auth providers on your site:

  ✓ Entra External ID
    - ProviderName: OpenIdConnect_1
    - Tenant: ba275000-98c8-404d-a6f0-c5450f2aa668
    - ClientId: e728d63e-1190-495a-ae29-663e9cc10877
    - Configured in site settings: yes
    - Surfaced in SPA UI: NO (authService.ts has no entry for this provider)

  ✓ Local Authentication
    - LoginByEmail: true
    - Surfaced in SPA UI: yes
```

Use `AskUserQuestion`:

| Question | Header | Options |
|----------|--------|---------|
| I found existing auth providers on your site. What would you like to do? | Existing auth | Keep all existing providers and add a new one (Recommended) — preserves what's there, adds what you ask for next, Keep all existing providers (no new provider this run) — re-generates SPA code to surface what's already in site settings, Replace everything with a new configuration — wipes existing site settings and SPA code, starts fresh |

**"Keep all existing providers and add a new one"** (default path):
- Store the discovered providers as `EXISTING_PROVIDERS` — these will be merged into the `AUTH_PROVIDERS` array generated in Phase 3.2
- Phase 2.1 will prompt for the NEW provider being added; the existing ones are kept untouched
- For **local auth specifically** — if `Local Authentication` is in `EXISTING_PROVIDERS`, **always regenerate the local auth SPA code** (login flow, registration page, forgot/reset password, redeem invitation) from the user's Phase 2.1 answers. Don't try to preserve hand-edited local-auth code — the local flows are complex enough that partial updates introduce more bugs than they avoid.

**"Keep all existing providers (no new provider this run)"**:
- Skip the Phase 2.1 provider selection question entirely
- Re-derive `AUTH_PROVIDERS` from `EXISTING_PROVIDERS` only
- Useful for: fixing a site where the SPA UI is missing a provider that's already in site settings (the exact bug this branch was created to fix)

**"Replace everything with a new configuration"**:
- Set `EXISTING_PROVIDERS = []`
- Delete existing OIDC/SAML2/WsFed/OpenAuth site-setting YAMLs as part of Phase 8.1
- Run Phase 2.1 as if no providers existed

> **DO NOT** offer a "skip / no changes" option. If the user invokes setup-auth, they want auth set up — silently doing nothing is worse than asking.

### Output

- Project root path confirmed
- Framework identified (React, Vue, Angular, or Astro)
- Deployment status verified
- Web roles inventory compiled
- **`EXISTING_PROVIDERS` list compiled from site settings, with provider type, ProviderName slug, ClientId/Authority/etc. for each**
- **`MERGE_MODE` chosen: `keep-and-add` (default) | `keep-only` | `replace-all`**
- SPA auth file inventory recorded (which files exist, whether they use `AUTH_PROVIDERS` array or legacy single-provider pattern)

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

**Re-run handling — when Phase 1.5 detected existing providers:**

The behavior depends on the `MERGE_MODE` chosen in Phase 1.5:

- **`keep-only`** (user chose "keep all existing, no new provider this run") → Skip the new-provider selection question entirely. Proceed to the "Local Authentication" follow-ups only if local was detected. Phase 3.2 will generate `AUTH_PROVIDERS` from `EXISTING_PROVIDERS` only.
- **`keep-and-add`** (default — user wants to add one more) → Ask the user what to add. The provider selection question below should still be multi-select (the user could be adding multiple new providers in one go), but the existing providers are NOT in the list (they're already configured — the question is asking what's *new*). Common patterns:
  - User has Entra External ID, wants to add Local Auth → user selects "Local Authentication" → ask local follow-ups → Phase 3.2 merges
  - User has Entra External ID + Local, wants to add a *second* Entra External ID tenant → user selects "Entra External ID" → after collecting Authority/ClientId, ask: `"You already have an Entra External ID provider configured for tenant {existing-tenant}. This new one is a separate instance — give it a distinct ProviderName slug (used in site setting keys like Authentication/OpenIdConnect/{ProviderName}/* and in code as the provider id)."` Let the user pick a slug (default to the next incrementing number, e.g., `OpenIdConnect_2`) or pick a custom name (e.g., `EntraExternalId_Employee`).
- **`replace-all`** (user chose to wipe everything) → Run the provider selection question as on a first invocation.

**Do NOT proactively ask "do you want to configure multiple instances?"** at the start. Walk the user through configuring ONE provider at a time. When they finish configuring one and want another, they can re-run setup-auth → Phase 1.5 detects what's there → Phase 2.1 in `keep-and-add` mode asks "what do you want to add now?". This keeps the question count low for the common case (configure one provider) while still supporting the advanced case (multiple tenants).

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

**For "Entra External ID"** — use the 4-step walkthrough below. Do NOT just ask the user for Authority/ClientId/Metadata upfront — those values come from a tenant + app registration + user flow that the user may not have set up yet. Walk them through each prerequisite before asking for the corresponding value.

> Reference doc: https://learn.microsoft.com/en-us/power-pages/security/authentication/entra-external-id
> See also `${CLAUDE_PLUGIN_ROOT}/skills/setup-auth/references/authentication-reference.md` for the full Entra External ID prerequisites section the steps below cross-reference.

**Pre-computed values for THIS site** — before starting the walkthrough, compute:
- `SITE_URL` = the deployed site URL (e.g., `https://site-597pv.powerappsportals.com`). Read from `pac env who` + the site name, or from the site's existing settings.
- `PROVIDER_NAME` = if this is a fresh add, default to `OpenIdConnect_1` (or the next free `OpenIdConnect_N` slug per the CallbackPath uniqueness logic in Phase 8.1). The user can override to a custom slug like `EntraExternalId_Customer` for multi-instance setups.
- `REDIRECT_URI` = `{SITE_URL}/signin-{PROVIDER_NAME-lowercased}` — e.g., `https://site-597pv.powerappsportals.com/signin-openidconnect_1`. The user pastes this verbatim into the Entra app registration.
- `APP_NAME_SUGGESTION` = `power-pages-{site-shortname}` — e.g., `power-pages-savoria`
- `USER_FLOW_NAME_SUGGESTION` = `{site-shortname}-signupsignin` — e.g., `savoria-signupsignin`

Display these to the user before Step 1 so they have them handy.

##### Step 1 — Tenant

| Question | Header | Options |
|----------|--------|---------|
| Do you already have a Microsoft Entra External ID tenant? (This is a separate tenant type from a regular workforce Entra ID tenant — sometimes called CIAM.) | Tenant | Yes — I have an External ID tenant, No — help me create one (free 30-day trial), I'm not sure |

**If "No"**, show:

> Steps to create an Entra External ID tenant:
> 1. Open https://entra.microsoft.com/
> 2. Sign in with the account that should own the tenant
> 3. From the top, click **Manage tenants → Create**
> 4. Choose **External (for customers)** — NOT Workforce
> 5. Pick a domain prefix (the **tenant subdomain**) — e.g., `contoso` becomes `contoso.ciamlogin.com`. This appears in every login URL.
> 6. Free 30-day trial: no credit card required. You can attach a paid Azure subscription later.
>
> Detailed guide: https://learn.microsoft.com/en-us/entra/external-id/customers/quickstart-tenant-setup
>
> When you've created the tenant, switch to it (top-right tenant picker in entra.microsoft.com), then come back here.

**If "I'm not sure"**, show: "At https://entra.microsoft.com/ → top-right tenant picker. Tenants for customers are labeled **External**. Workforce tenants won't work — that's a different product."

Then collect the tenant identifiers:

| Question | Options |
|----------|---------|
| What is the tenant **subdomain**? (the part before `.ciamlogin.com` — e.g., `contoso`. Find it in the External ID tenant's Overview page under "Primary domain", removing `.onmicrosoft.com`.) | *(free text)* |
| What is the tenant **ID** (GUID)? (Find it in the External ID tenant's Overview page under "Tenant ID" — looks like `a1b2c3d4-e5f6-7890-abcd-ef1234567890`.) | *(free text)* |

**Validate**: subdomain matches `^[a-z0-9-]+$` (no dots, no uppercase, no `.ciamlogin.com` suffix); tenant ID matches the UUID regex. If either fails, show the expected format and re-prompt.

Store as `EXTERNAL_ID_TENANT_SUBDOMAIN` and `EXTERNAL_ID_TENANT_ID`.

##### Step 2 — App registration

**Confirm the Redirect URI first.** The skill pre-computes a default based on the site URL and `PROVIDER_NAME`, but the user may prefer a different URI:

> The Power Pages site needs a Redirect URI registered in your app registration. Based on the site URL and provider name, the default is:
>
> **`{REDIRECT_URI}`**
>
> You can keep this default, or use a different URI — for example, `{SITE_URL}/signin-entra-customer` or `{SITE_URL}/auth/external-id`. The host must be your Power Pages site; only the path can change.

| Question | Header | Options |
|----------|--------|---------|
| Use this Redirect URI? | Redirect URI | Use the default (Recommended) — `{REDIRECT_URI}`, Use a different URI |

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

> **Note**: The skill writes two site settings derived from this single `REDIRECT_URI`: the user-facing `RedirectUri` (the full URI, sent to the IdP) and the internal `CallbackPath` (just the path portion, used by the OWIN middleware to know which incoming request to handle). The maker doesn't need to think about `CallbackPath` separately — the skill derives it automatically from `REDIRECT_URI` by extracting the path portion.

| Question | Header | Options |
|----------|--------|---------|
| Have you registered an app in your Entra External ID tenant for this Power Pages site? | App reg | No — walk me through it (Recommended for first time), Yes — I have the Application (client) ID |

**If "No"**, show step-by-step with the confirmed Redirect URI verbatim:

> Steps to register the app:
> 1. At https://entra.microsoft.com/, make sure you're in your External ID tenant (top-right picker)
> 2. **Applications → App registrations → New registration**
> 3. **Name**: `{APP_NAME_SUGGESTION}` (or your own name)
> 4. **Supported account types**: select **Accounts in this organizational directory only (single tenant)** — recommended for Power Pages. Multi-tenant configurations forcibly disable contact mapping by email for security.
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
> If it's missing or different, add it now. An app registration can have multiple Web Redirect URIs registered — adding ours doesn't break any existing integrations. Sign-in will fail if the value in Power Pages doesn't match a registered URI exactly.

Then ask for the value:

| Question | Options |
|----------|---------|
| Paste the **Application (client) ID** from the Overview tab. | *(free text)* |

**Validate**: must match UUID v4 format (`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`). Re-prompt on mismatch.

Store as `EXTERNAL_ID_CLIENT_ID`.

**Do NOT ask about client secret.** Entra External ID app registrations are public clients using PKCE — no secret needed. The skill will create site settings without `ClientSecret` and skip Phase 8.1.1 (Key Vault) for this provider. If the user has a confidential-client scenario that requires a secret, they can add it manually via the Power Pages admin center after deploy — document this as an advanced override in Phase 8.5 post-deploy notes.

##### Step 3 — User flow

User flows define what attributes are collected from users and what claims appear in the ID token. Without one, sign-in fails after the IdP redirect.

| Question | Header | Options |
|----------|--------|---------|
| Have you created a sign-up/sign-in user flow in your Entra External ID tenant and attached it to your app? | User flow | No — walk me through it (Recommended for first time), Yes — I have the user flow name |

**If "No"**, the walkthrough's user-flow-attribute selection must match the `PROFILE_MAPPING_CHOICE` collected later (Track B's profile mapping question). Since this step runs BEFORE that question, ask it now (just for Entra External ID):

> The user flow needs to be told which attributes to collect from users and which claims to return in the token. The skill maps claims → Dataverse contact fields automatically — the attributes you select here determine what's available.

| Question | Header | Options |
|----------|--------|---------|
| What user profile info should the sign-up form collect and return as claims? | Profile attributes | Standard (Recommended) — Email, Given Name, Surname, Standard + phone — also Phone Number, Email only — minimal sign-up form |

Store as `PROFILE_ATTRIBUTES_CHOICE` (this also drives `PROFILE_MAPPING_CHOICE` in Track B — they should be consistent; default both to "Standard" unless the user explicitly differs).

Then show:

> Steps to create the user flow:
> 1. At https://entra.microsoft.com/, in your External ID tenant
> 2. **External Identities → User flows → New user flow**
> 3. **Name**: `{USER_FLOW_NAME_SUGGESTION}` (or your own — letters, digits, hyphens, underscores only)
> 4. **Identity providers** for sign-in: choose **Email with password** (Recommended — most familiar to customers) or **Email one-time passcode** (passwordless)
> 5. **User attributes to collect** (the sign-up form fields): based on your choice above, select:
>    - **Standard / Standard + phone**: ☑ Email Address, ☑ Given Name, ☑ Surname{`, ☑ Phone Number` if Standard + phone}
>    - **Email only**: ☑ Email Address
> 6. **User attributes to return as claims** (in the ID token): same selections as above — these power profile mapping into Dataverse contact fields
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

##### Step 4 — Display name + Confirmation

| Question | Options |
|----------|---------|
| What should the login button label say? Default: **`Sign in with Entra External ID`** (shortened from "Sign in with Microsoft Entra External ID" so it fits on one line in the horizontal-row Login page layout — see note below). Do NOT use "Sign in with Microsoft" — that conflicts with the Microsoft Account social provider. | *(free text, defaulted)* |

> **Display name length guidance**: keep labels around **28 characters or less** to display on a single line in the horizontal-row Login page layout (which is the default). Longer labels still work — buttons grow vertically to wrap text to two lines — but single-line buttons look more polished. For reference:
> - "Sign in with Entra External ID" — 30 chars (wraps on narrow cards, fits on wider)
> - "Sign in with Microsoft Entra External ID" — 40 chars (wraps to two lines in the default horizontal layout)
> - "Customer Sign In" — 16 chars (always single line, but less descriptive)
>
> If the user has multiple external providers configured (e.g., Entra External ID + Google), shorter labels matter more because each button gets less width. For a single-provider site, longer labels are fine (the button spans the full row width).

Store as `EXTERNAL_ID_DISPLAY_NAME`.

Now derive the configuration and present a summary for confirmation:

- **Authority**: `https://{EXTERNAL_ID_TENANT_SUBDOMAIN}.ciamlogin.com/{EXTERNAL_ID_TENANT_ID}` (NO trailing `/v2.0/` — Entra External ID uses the bare tenant path, NOT the B2C-style URL)
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
> | Client secret | None (public client / PKCE) |
>
> Continue to write these site settings?

| Question | Options |
|----------|---------|
| Continue? | Yes — write the site settings, No — let me adjust |

If "No", re-prompt for the specific value the user wants to change.

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

**Profile mapping (for every external provider — OIDC, Entra External ID, SAML2, WS-Federation, social)**

After collecting the provider's basic details, ask what user profile info should flow from the IdP to the Dataverse contact. **Don't skip this** — without it, contact records have empty `firstname`/`lastname` and the SPA falls back to displaying the email or username everywhere.

| Question | Header | Options |
|----------|--------|---------|
| What profile info should be copied from your identity provider into the Dataverse contact record? | Profile mapping | Standard (Recommended) — copy first name, last name, and email on first sign-in, Standard + phone — also copy mobile phone, Custom — let me pick which contact fields and claims to map, None — leave contact fields empty (the server will still populate emailaddress1 from the email claim) |

Store as `PROFILE_MAPPING_CHOICE`. Then ask:

| Question | Header | Options |
|----------|--------|---------|
| Should profile info be updated on every login, or only once at first sign-in? | Sync frequency | First sign-in only (Recommended) — copy claims once when the contact is created; let users edit their own profile afterwards without it being overwritten, Both — sync on first sign-in AND every login (use only when the IdP is the authoritative source of truth and you don't want users editing their profile in Power Pages) |

Store as `PROFILE_SYNC_FREQUENCY`. This determines whether to write `LoginClaimsMapping` (every login) in addition to `RegistrationClaimsMapping` (first sign-in only).

> **Why "First sign-in only" is now the default**: this skill optionally scaffolds a SPA profile page (`/user-profile`) where signed-in users can edit their own contact info. If `LoginClaimsMapping` is set, the server overwrites the user's edits with IdP claims on the very next login — which is confusing and silently undoes the user's work. "First sign-in only" lets the user own their profile after the contact is created. Switch to "Both" only when the IdP is the sole authoritative source for these fields (e.g., HR-managed workforce directory) and end-user edits should NOT persist.

**Claim type values** — the mapping format is comma-separated `contactfield=claimtype` (NOT JSON). For OIDC providers like Entra External ID, use OIDC short names:

| Choice | Generated mapping |
|---|---|
| Standard | `firstname=given_name,lastname=family_name,emailaddress1=email` |
| Standard + phone | `firstname=given_name,lastname=family_name,emailaddress1=email,mobilephone=phone_number` |
| Custom | Loop: ask the user for each `contactfield=claimtype` pair until they say done. Suggest OIDC short names (`given_name`, `family_name`, `email`, `phone_number`, `preferred_username`, custom claim names). Validate that `contactfield` is a known Dataverse contact column. |
| None | Don't write `RegistrationClaimsMapping` or `LoginClaimsMapping` settings. |

For **SAML2 / WS-Federation**, the claim types are URIs (e.g., `http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname`). Adjust the "Standard" generated mapping accordingly. For **social** providers, the claim types are provider-specific (Google: `given_name`, Facebook: `name`).

**Contact linking (for every external provider)**

Ask whether to auto-link external sign-ins to existing contacts by email.

| Question | Header | Options |
|----------|--------|---------|
| If a user signs in with an external provider and their email matches an existing Dataverse contact, what should happen? | Contact linking | Link to the existing contact (Recommended) — auto-link by email match so makers don't end up with duplicate contacts when admins pre-create records (single-tenant providers only — see warning below), Create a new contact — always create a fresh contact, never auto-link (safer choice when the IdP doesn't verify emails) |

Store as `CONTACT_LINKING_CHOICE`. This drives `AllowContactMappingWithEmail` (`true` for "link", `false` for "create new").

> **Why "Link to the existing contact" is the default**: the common flow is that admins pre-create contact records in Dataverse (often via invitation or import) and then expect those exact contacts to be picked up when the user signs in for the first time via the configured IdP. Without linking, the server creates a brand-new contact and the pre-created record sits orphaned — confusing for makers and easy to misdiagnose. Linking by verified email is the well-known pattern for joining IdP identity to an existing CRM record.
>
> **⚠ Multi-tenant safety**: For **multi-tenant Entra External ID** (Authority uses `/organizations/` or `/common/`, or `IssuerFilter` is a wildcard), the Power Pages server **forcibly disables** `AllowContactMappingWithEmail` regardless of the site setting (`BlockContactMappingSettingForMultitenantApp` feature flag in `LoginController.cs:2578-2587`). Reason: email claims can't be trusted across tenants. If the user selects "Link to the existing contact" but the Authority is multi-tenant, warn them that linking won't work and recommend single-tenant Authority.
>
> **⚠ Security**: When `AllowContactMappingWithEmail = true`, an attacker who can sign into the configured IdP using a victim's email can take over the victim's contact. Enable only when the IdP verifies emails (Entra External ID with single tenant verifies; arbitrary OIDC may not). Switch to "Create a new contact" if you're configuring an IdP whose email-verification stance you don't control (e.g., a generic OIDC endpoint).

**For "Local Authentication"** (only if user explicitly requested it): Ask the user how they want users to identify themselves when logging in:

| Question | Options |
|----------|---------|
| How should users log in with their local account? | Login by email (Recommended) — Users sign in with their email address, Login by username — Users sign in with a chosen username |

This choice determines the `Authentication/Registration/LocalLoginByEmail` site setting (`true` for email, `false` for username) and affects every form field in the login, registration, and auth service code. When **email** is chosen, the login and registration forms show an `Email` field (type `email`). When **username** is chosen, the forms show a `Username` field (type `text`) and `Email` becomes a separate required field on the registration form (the server needs it for the contact record). Store this choice — it will be used in Phase 3 (auth service), Phase 5 (sign-in and registration pages), and Phase 8.1 (site settings).

**For "Local Authentication"** — also ask which registration mode the site should use:

| Question | Options |
|----------|---------|
| How should users be able to register on your site? | Open registration only (Recommended) — Anyone can sign up freely with a username/password, Invitation-only — Only users with a valid invitation code can register; direct registration is blocked, Both — Users can self-register OR redeem an invitation link, Registration disabled — No new accounts can be created (only existing users can log in) |

**Why this matters** — the server enforces the following gating rules in `RegistrationManager` (see `crm.solutions.portal/Samples/MasterPortal/Areas/Account/Models/RegistrationManager.cs`):

| Mode | `Enabled` | `OpenRegistrationEnabled` | `InvitationEnabled` | Behavior |
|---|---|---|---|---|
| Open registration only | `true` | `true` | `false` | Direct `/registration` works. Invitation links return 404. |
| Invitation-only | `true` | `false` | `true` | Direct `/registration` returns 404. Users must arrive via invitation link → `/redeem-invitation` → `/registration?invitationCode=...`. |
| Both | `true` | `true` | `true` | Both paths work. Invitation pre-fills email; direct registration is fully open. |
| Registration disabled | `false` | (moot) | (moot) | All registration endpoints return 404. Existing users can still log in. |

> **Note:** The `Authentication/Registration/RequireInvitationCode` setting is NOT a real server setting — the server doesn't read it. The "require invitation" behavior is enforced solely by `OpenRegistrationEnabled = false` + `InvitationEnabled = true`. Do not create that setting.

Store this choice as `REGISTRATION_MODE` — it drives:
- Whether to create the `/registration` page (always, unless `Registration disabled`)
- Whether to create the `/redeem-invitation` page (only when `InvitationEnabled` is true, i.e., `Invitation-only` or `Both`)
- Whether the `/registration` page calls `fetchInvitationDetails()` to pre-fill the email (only when `InvitationEnabled` is true)
- The deterministic set of site settings written in Phase 8.1
- Whether to default CAPTCHA on (open / both) or off (invitation-only — invitations already filter users)

**For "Microsoft Entra ID"** (workforce / employee tenant): No tenant or client info needed. Power Pages auto-configures the OIDC site settings (`Authentication/OpenIdConnect/AzureAD/*`) for the site's parent tenant when the site is created. The SPA derives the `providerIdentifier` (`https://login.windows.net/{tenantId}/`) at runtime from `window.Microsoft.Dynamic365.Portal.tenant` — no hardcoded values.

**Claims mapping is also auto-configured silently** — Phase 8.1 always writes `Authentication/OpenIdConnect/AzureAD/RegistrationClaimsMapping` and `LoginClaimsMapping` with the value `firstname=given_name,lastname=family_name,emailaddress1=upn` for the workforce Entra provider. **No question is asked for this** — the answer is deterministic. Workforce Entra ID issues v1.0 tokens by default (issuer `sts.windows.net/{tid}/`) which omit the `email` claim, so `upn` is the only reliable claim to populate `emailaddress1`. Without this mapping, contacts created on first sign-in have `oid` linked but firstname/lastname/email all empty (the User object renders with `contactId` but blank profile fields).

Only ask one optional question — the button display name. Provide a sensible default the user can accept:

| Question | Options |
|----------|---------|
| What should the login button label say? (default: `Sign in with Microsoft`) | *(free text, defaulted)* |

Store as `ENTRA_ID_DISPLAY_NAME` (default `"Sign in with Microsoft"`). Phase 3.2 adds an entry to `AUTH_PROVIDERS` with `type: 'entra-id'`, this display name, and **no `providerIdentifier`** (runtime-resolved).

> **Why no tenant ID?** The tenant ID is essentially for SPA-button wiring (the value the SPA POSTs to `/Account/Login/ExternalLogin`). Power Pages exposes the site's parent tenant ID at runtime via `window.Microsoft.Dynamic365.Portal.tenant`, so the SPA can construct the providerIdentifier (`https://login.windows.net/{tenantId}/`) without asking the maker. The server-side OIDC settings are already in place from site creation. Compare this to **Entra External ID**, where the tenant is a SEPARATE customer tenant unrelated to the site's parent — there we DO need the maker to provide the tenant ID + subdomain because they can't be derived from `Portal.tenant`.

> Docs: https://learn.microsoft.com/en-us/power-pages/security/authentication/openid-settings

**Login page layout** — when more than one auth provider is configured (including local + 1 external, or 2+ providers), the Login page renders all of them. Ask the user how they want providers laid out:

| Question | Header | Options |
|----------|--------|---------|
| How should sign-in options be laid out on the Login page? | Layout | Horizontal row (Recommended) — provider buttons side-by-side in a wrapping row, local form below a divider, Vertical stack — provider buttons stacked full-width, local form below a divider, Primary spotlight — one provider featured as the primary CTA, others under a "More sign-in options" toggle, local form below, Tabbed — tabs to switch between provider modes (good for 3+ providers, feels heavy for 2) |

Store this choice as `LOGIN_LAYOUT` — Phase 5.1.1 renders the Login page based on it. If only one provider is configured (e.g., `Entra External ID` only with no local), `LOGIN_LAYOUT` is moot: the AuthButton's "Sign In" calls `login()` directly, no Login page is needed.

For the **Primary spotlight** layout, ask a follow-up:

| Question | Header | Options |
|----------|--------|---------|
| Which provider should be featured as the primary sign-in option? | Primary provider | *(List the configured providers as options. The first external provider is a sensible default.)* |

Store as `PRIMARY_PROVIDER_ID`.

Then determine the scope:

| Question | Options |
|----------|---------|
| Which authentication features do you need? | Login & Logout + Role-based access control (Recommended), Login & Logout only, Role-based access control only (auth service already exists) |

Then ask about optional features:

| Question | Options |
|----------|---------|
| Would you like to enable any of these optional features? | None (Recommended), Terms and Conditions — require users to accept terms before accessing the site |

> **Note:** If they select Terms and Conditions, follow the Terms flow below.
>
> **Invitation-based registration is NOT in this list** — it's controlled by the registration mode question above. Setting registration mode to `Invitation-only` or `Both` is what enables invitations.
>
> **Two-factor authentication (2FA) is intentionally NOT offered.** Power Pages' built-in 2FA flow is server-rendered (`/Account/Login/SendCode` → `/Account/Login/VerifyCode`) and cannot be intercepted from the SPA — there's no SPA-equivalent UI for the code entry step, and bouncing the user out to a server page mid-login breaks the SPA experience. If the user explicitly asks for 2FA, tell them: "Power Pages built-in 2FA requires the legacy server-rendered SendCode/VerifyCode pages, which we don't support in SPA-based code sites yet. For external providers (Entra ID, Entra External ID, OIDC), enable MFA at the identity provider instead — it's transparent to Power Pages and stays inside the IdP's branded experience. For local accounts, 2FA on SPA sites is not currently supported." Do NOT create `TwoFactorEnabled`, `RememberMeEnabled`, or `RememberBrowserEnabled` site settings.

**Profile page** — ask whether to scaffold a SPA profile page that lets signed-in users edit their own contact info via the Power Pages Web API. This is a standalone question because it has its own infrastructure implications (Web API site settings on the `contact` entity + Self-scope table permission).

| Question | Header | Options |
|----------|--------|---------|
| Add a profile page that lets signed-in users edit their contact info (name, mobile phone, address) via the Power Pages Web API? Email is shown read-only. | Profile page | No (default) — no profile page; users can't edit their info from the SPA, Yes — create a /user-profile SPA page with edit form, accessible from the header user menu |

Store as `INCLUDE_PROFILE_PAGE` (boolean). Default `false`.

> **⚠ MANDATORY route name: `/user-profile` (NOT `/profile`)**. The path `/profile` is **reserved by the Power Pages server** for the legacy server-rendered profile page — using it as a SPA route creates a conflict that breaks the page. **Always use `/user-profile`** for the SPA route. The skill executor MUST NOT rename this route. Same for the file: **`src/pages/UserProfile.tsx`** (NOT `Profile.tsx`).

When `true`, Phase 5.1.9 generates `src/pages/UserProfile.tsx` (file name mandatory), extends `authService.ts` with `getMyProfile` / `updateMyProfile` (function names mandatory), evolves the `AuthButton` from inline `[Avatar Name Sign Out]` to a dropdown menu with "My Profile" and "Sign Out", and adds the `/user-profile` route (path mandatory) to `App.tsx`. Phase 8.1 writes the Web API site settings (`Webapi/contact/enabled = true` and `Webapi/contact/fields` with the COMPLETE default field list documented in Phase 8.1 — not a subset) and a Self-scope table permission on `contact` for the Authenticated Users role. The dropdown shape becomes the new default for `AuthButton` regardless of `INCLUDE_PROFILE_PAGE` so the component is ready for future menu items.

**Profile page design — intentionally simple:**

The page has two sections:

1. **Account Details** (read-only display at the top) — shows just the user's **full name** (firstname + lastname combined) and **email**. **DO NOT** display contactId, roles, sign-in method, provider name, last-login timestamp, or any other account metadata. Keep this section minimal.
2. **Edit form** (below) — only these editable fields. Email is intentionally **NOT** editable (changing email via Web API conflicts with auth provider claim mapping behavior and is surprising for external-auth users).

**Default EDITABLE field set** (the form MUST include exactly these 8 fields — do not add email, do not add middlename, do not add a Change Password link):

- First name (`firstname`)
- Last name (`lastname`)
- Mobile phone (`mobilephone`)
- Address line 1 (`address1_line1`)
- City (`address1_city`)
- State / Province (`address1_stateorprovince`)
- Postal code (`address1_postalcode`)
- Country (`address1_country`)

All fields are optional on submit. **DO NOT** include:

- ❌ `emailaddress1` as an editable field (read-only in Account Details only)
- ❌ `middlename` (keep the form simple)
- ❌ A "Change password" link or button (password reset is handled by the existing `/forgot-password` flow, not the profile page)
- ❌ A "Sign out" button on the profile page (sign-out lives in the header AuthButton dropdown only)
- ❌ Display of contactId, userRoles, or any account metadata beyond name + email

The Web API `fields` site setting MUST include `contactid` plus the 8 editable fields above (9 total entries — lowercase). Phase 8.1 specifies the exact value verbatim.

> **Prerequisite for `Yes`**: an "Authenticated Users" web role must exist (or any role with `authenticatedusersrole: true` flag). Phase 1.4 inventoried web roles — if none qualifies, warn the user that profile editing won't work until a role is assigned and offer to invoke `/create-webroles` first.

> **Cross-provider compatibility**: the profile page works the same regardless of auth provider (local, Entra ID, Entra External ID, OIDC, social) because it operates on the contact record after sign-in — not on IdP-specific session state. Email is read-only on the page, so there's no provider-specific caveat to surface (the IdP remains the source of truth for email).

**If "Terms and Conditions" is selected**, first surface the GDPR prerequisite **before** collecting content — terms only function if the underlying solution is installed:

> **GDPR prerequisite**: Terms require ALL THREE of these to be in place for the server to actually enforce them:
> 1. `Authentication/Registration/TermsAgreementEnabled = true` (site setting we will create)
> 2. The `msdynce_PortalPrivacyExtensions` solution must be installed in your Dataverse environment (`IsGdprEnabled` is portal-level)
> 3. The `Account/Signin/TermsAndConditionsCopy` content snippet must have non-empty text (we will create this)
>
> Without the Privacy Extensions solution, the server silently ignores `TermsAgreementEnabled`. The setup-auth skill will still write all three pieces — but unless the solution is installed in Dataverse, the terms gate won't be enforced server-side.

**Auto-detect the Privacy Extensions solution before asking.** Run:

```powershell
node "${CLAUDE_PLUGIN_ROOT}/scripts/check-solution-installed.js" --solutionName "msdynce_PortalPrivacyExtensions"
```

The script prints JSON to stdout: `{ "installed": true, "version": "..." }` if found, or `{ "installed": false }` if the solution isn't in the environment. On infrastructure failure (no PAC environment, expired Azure CLI token, missing Read permission on the solutions table, network error), it exits non-zero and writes a human-readable reason to stderr.

Branch on the result:

| Script result | What to do |
|---|---|
| `installed: true` | Skip the prereq question entirely and proceed to collecting terms content (next section). Briefly tell the user: *"Confirmed `msdynce_PortalPrivacyExtensions` v{version} is installed in your environment — terms enforcement will work."* |
| `installed: false` | **Tell the user clearly that terms and conditions will NOT work**: *"The `msdynce_PortalPrivacyExtensions` solution is NOT installed in your Dataverse environment. The Terms and Conditions feature will NOT be enforced by the server until that solution is installed — `Authentication/Registration/TermsAgreementEnabled` is silently ignored without it. The site setting, Terms page, and content snippets will still be scaffolded, but the gate is a no-op until the solution is in place."* Then ask via `AskUserQuestion`: **header** "Privacy solution", **question** "Would you still like to set up Terms and Conditions now (it can be enabled later once you install the solution), or skip it?", **options**: "Continue anyway — scaffold the Terms infrastructure; I'll install the solution later", "Cancel — skip Terms and Conditions for this site". |
| Script exited non-zero (infrastructure failure) | Tell the user we couldn't auto-detect the solution (include the stderr message succinctly so they understand why — e.g., "couldn't reach Dataverse", "missing permissions on the solutions table"). Fall back to the manual prompt: **question** "We couldn't auto-detect whether `msdynce_PortalPrivacyExtensions` is installed. Do you have the GDPR/Privacy Extensions solution installed?", **options**: "Yes — solution is installed (or I'll install it)", "Continue anyway — set up terms; I understand they won't be enforced until I install the solution", "Cancel — I don't want terms". |

**If the user picks "Cancel" (in either the not-installed or fallback path)**: skip the Terms branch entirely, do not set `TermsAgreementEnabled`, do not create the Terms page or snippets.

Otherwise, collect the terms content. The server uses 4 content snippets — the skill hardcodes these values into the SPA Terms page component. Ask the user:

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
| Would you like to configure advanced authentication settings? (logout mode, claims mapping, session timeout, scopes, etc.) | No, use defaults (Recommended), Yes, show me the options |

**If "Yes, show me the options"**, present the optional settings table relevant to the selected provider. Only show settings that apply to their provider type. For each setting the user wants to configure, collect the value.

##### Logout mode (external providers only — OIDC, Entra External ID, SAML2, WS-Fed, social)

**Always offer this question to the user** when an external provider is being configured (it's the most common advanced setting and has visible UX consequences). For local-auth-only sites, skip this question.

> **Two logout modes:**
> - **Local logout** (server default, simpler) — Power Pages clears its session cookie and redirects the user to `returnUrl` (defaults to `/`). The user **remains signed in at the IdP**. Next time they click the external provider button, the IdP's SSO cookie is still warm and they re-sign-in silently with no credential re-entry. This is the default UX for most consumer / customer-facing sites.
> - **Federated logout** (RP-initiated) — Power Pages additionally calls the IdP's `end_session_endpoint` with `id_token_hint` and `post_logout_redirect_uri`. The IdP signs the user out of THEIR session too, then redirects the browser back to the site. The user is fully signed out across systems. Required for: shared-device scenarios, regulated industries with hard logout requirements, sites that explicitly want users to re-enter credentials each time.

| Question | Header | Options |
|----------|--------|---------|
| What should happen at the IdP when a user signs out? | Logout mode | Local logout only (Recommended, server default) — clear Power Pages session; user stays signed in at the IdP, Federated logout — also sign user out at the IdP so they have to re-authenticate |

**If "Local logout only"**: do nothing further. Skip writing `RPInitiatedLogout` and `PostLogoutRedirectUri` site settings in Phase 8.1 — the server defaults handle it correctly (both default to `false`/unset).

**If "Federated logout"**: this requires TWO pieces of configuration that MUST go together. Setting only `RPInitiatedLogout=true` without `PostLogoutRedirectUri` leaves users stranded on the IdP's "you have been signed out" page — confirmed via HAR analysis on a live Entra External ID site.

Step 1 — collect the post-logout redirect URI (default to the site root):

| Question | Options |
|----------|---------|
| Where should users land after they sign out at the IdP? (Defaults to the site home page. Use a different URL if you have a dedicated "signed out" page.) | *(free text, defaulted to `{SITE_URL}/`)* |

Validate the value: must be a fully-qualified URL on the same host as `SITE_URL`. Store as `POST_LOGOUT_REDIRECT_URI`.

Step 2 — for Entra External ID specifically, instruct the user to register the URL in their app registration:

> **Required app registration step** (must be done in the Microsoft Entra admin center):
>
> 1. Go to **App registrations → {your app} → Authentication**
> 2. Scroll to the **Front-channel logout URL** field (under "Advanced settings", just above "Implicit grant and hybrid flows")
> 3. Enter: **`{POST_LOGOUT_REDIRECT_URI}`** — must match the value above exactly
> 4. **Save**
>
> **Why this is needed**: Entra External ID rejects any `post_logout_redirect_uri` value that isn't pre-registered (same security model as Redirect URIs for sign-in). Without this registration, the IdP silently drops the parameter and the user is stranded after sign-out — even if Power Pages sends it correctly.
>
> For **generic OIDC providers** (Okta, Auth0, Ping, etc.), check the provider's docs for the equivalent registration. Most providers call this "Logout URL", "Post Logout Redirect URI", or "Allowed Sign-out Redirect URLs" under the app's settings.

Phase 8.1 will write BOTH `RPInitiatedLogout=true` AND `PostLogoutRedirectUri={POST_LOGOUT_REDIRECT_URI}` when this option is chosen.

**OpenID Connect / Entra External ID optional settings:**

| Setting | Description | Default |
|---------|-------------|---------|
| `MetadataAddress` | Explicit OIDC metadata endpoint URL (alternative to `Authority` — use when provider needs a specific metadata URL) | Derived from Authority |
| `Scope` | Space-separated OAuth scopes (e.g., `openid profile email`) | `openid` |
| `ResponseType` | OAuth response type (`code`, `id_token`, `code id_token`) | `code id_token` |
| `ResponseMode` | How the IdP returns the response (`form_post`, `query`, `fragment`) | `form_post` for code flow |
| `RedirectUri` | Override the callback URL | `{site-url}/signin-{provider}` |
| `PostLogoutRedirectUri` | URL to redirect to after federated logout completes at the IdP. **Required when `RPInitiatedLogout=true`** — server has a fallback that derives from `RedirectUri` authority, but a separate flag (`PostLogoutRedirectUriEnabled`) requires the explicit site setting to be present before the fallback is used. Without an explicit value, the IdP logout URL omits the parameter and users get stranded. | Unset (server default — but use the Logout mode question above to write it correctly) |
| `RPInitiatedLogout` | Use RP-initiated logout via `end_session_endpoint` with `id_token_hint`. **Mutually exclusive with `ExternalLogoutEnabled`** — when `true`, the server forces `ExternalLogoutEnabled` to `false` regardless of that setting. **Prefer the "Logout mode" question above** instead of setting this directly — that flow pairs it with `PostLogoutRedirectUri` (required) and the Entra app-registration step. | `false` |
| `Caption` | Display name shown on the login button | Provider name |
| `RegistrationClaimsMapping` | **Comma-separated `contactfield=claimtype` pairs** (NOT JSON). Applied **once** at first sign-in, before the contact is created. Example for Entra External ID: `firstname=given_name,lastname=family_name,emailaddress1=email`. The server silently skips malformed pairs — verify in Application Insights if claims aren't populating. | None |
| `LoginClaimsMapping` | Same format as `RegistrationClaimsMapping`. Applied **every login** (overwrites contact fields). Use sparingly — it overwrites manual edits the user makes to their profile. | None |
| `ExternalLogoutEnabled` | Sign out of the IdP when the user logs out (legacy OWIN sign-out, prefer `RPInitiatedLogout` for OIDC). Forced to `false` when `RPInitiatedLogout=true`. | `false` (server default) |
| `RegistrationEnabled` | Allow new users to register via this provider | `true` |
| `AllowContactMappingWithEmail` | **Auto-link an external sign-in to an existing Dataverse contact by matching the `email` claim against `emailaddress1`.** Default `false` (a new contact is always created). **⚠ Multi-tenant Entra External ID: the server forcibly disables this** (`BlockContactMappingSettingForMultitenantApp` feature flag in `LoginController.cs:2578-2587`) — email claims can't be trusted across tenants. If you want contact linking, use single-tenant Authority. **⚠ Security**: When `true`, anyone who can sign into this provider with a victim's email gains access to the victim's contact. Enable only when the provider is trusted to verify emails. | `false` |
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
| `RegistrationClaimsMapping` | **Comma-separated `contactfield=claimtype` pairs**. SAML assertion types are URIs (e.g., `firstname=http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname,lastname=http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname`). Applied once at first sign-in. | None |
| `LoginClaimsMapping` | Same format. Applied every login (overwrites contact fields). | None |
| `ExternalLogoutEnabled` | Enable SAML Single Logout (SLO) | `true` |
| `RegistrationEnabled` | Allow new users to register via this provider | `true` |
| `AllowContactMappingWithEmail` | **Auto-link an external sign-in to an existing Dataverse contact by matching the `email` claim against `emailaddress1`.** Default `false` (a new contact is always created). **⚠ Multi-tenant Entra External ID: the server forcibly disables this** (`BlockContactMappingSettingForMultitenantApp` feature flag in `LoginController.cs:2578-2587`) — email claims can't be trusted across tenants. If you want contact linking, use single-tenant Authority. **⚠ Security**: When `true`, anyone who can sign into this provider with a victim's email gains access to the victim's contact. Enable only when the provider is trusted to verify emails. | `false` |
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
| `RegistrationClaimsMapping` | **Comma-separated `contactfield=claimtype` pairs**. WS-Fed claim types are typically SAML URIs (e.g., `firstname=http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname`). Applied once at first sign-in. | None |
| `LoginClaimsMapping` | Same format. Applied every login (overwrites contact fields). | None |
| `ExternalLogoutEnabled` | Enable federated sign-out | `true` |
| `RegistrationEnabled` | Allow new users to register via this provider | `true` |
| `AllowContactMappingWithEmail` | **Auto-link an external sign-in to an existing Dataverse contact by matching the `email` claim against `emailaddress1`.** Default `false` (a new contact is always created). **⚠ Multi-tenant Entra External ID: the server forcibly disables this** (`BlockContactMappingSettingForMultitenantApp` feature flag in `LoginController.cs:2578-2587`) — email claims can't be trusted across tenants. If you want contact linking, use single-tenant Authority. **⚠ Security**: When `true`, anyone who can sign into this provider with a victim's email gains access to the victim's contact. Enable only when the provider is trusted to verify emails. | `false` |
| `BackchannelTimeout` | Timeout for metadata retrieval | `00:01:00` |
| `UseTokenLifetime` | Use IdP token lifetime for session | Not set |
| `IssuerFilter` | Wildcard pattern for multi-tenant issuer matching | None |

**Social OAuth optional settings** (Microsoft Account, Facebook, Google):

| Setting | Description | Default |
|---------|-------------|---------|
| `Caption` | Display name on the login button | Provider name |
| `Scope` | OAuth scopes to request (space-separated) | Provider defaults |
| `RegistrationClaimsMapping` | **Comma-separated `contactfield=claimtype` pairs**. Social provider claim types vary — Facebook uses `name`/`email`, Google uses `given_name`/`family_name`/`email`. Example: `firstname=given_name,emailaddress1=email`. Applied once at first sign-in. | None |
| `LoginClaimsMapping` | Same format. Applied every login (overwrites contact fields). | None |
| `ExternalLogoutEnabled` | Sign out of social provider on logout | `true` |
| `RegistrationEnabled` | Allow new users to register via this provider | `true` |
| `AllowContactMappingWithEmail` | **Auto-link an external sign-in to an existing Dataverse contact by matching the `email` claim against `emailaddress1`.** Default `false` (a new contact is always created). **⚠ Multi-tenant Entra External ID: the server forcibly disables this** (`BlockContactMappingSettingForMultitenantApp` feature flag in `LoginController.cs:2578-2587`) — email claims can't be trusted across tenants. If you want contact linking, use single-tenant Authority. **⚠ Security**: When `true`, anyone who can sign into this provider with a victim's email gains access to the victim's contact. Enable only when the provider is trusted to verify emails. | `false` |
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

Create the auth service file based on the detected framework and selected identity provider(s).

> **ALWAYS use the `AUTH_PROVIDERS` array pattern, even with one entry.** Never generate a single `AUTH_PROVIDER` constant. The array pattern means adding a second provider later (e.g., a second Entra External ID tenant, or local + an external provider) is just appending to the array — no restructuring needed. This avoids the bug class where a re-run silently drops previously-configured providers because the single-constant pattern can't represent more than one.
>
> The array MUST include:
> - Every provider in `EXISTING_PROVIDERS` from Phase 1.5 (merged in based on the user's `MERGE_MODE` choice)
> - Any new provider the user added via Phase 2.1
>
> Use a stable `id` for each provider (e.g., `entra-external-id-customer`, `entra-external-id-employee`, `local`) so React keys and switch statements remain stable across re-runs.

**All frameworks**: Create `src/services/authService.ts` with these functions and types:

- `AuthProviderType` — string union: `'local' | 'oidc' | 'entra-id' | 'saml2' | 'ws-federation' | 'social'`
- `AuthProviderConfig` — interface with `id`, `type`, `displayName`, optional `providerIdentifier` (required for `'oidc'` / `'saml2'` / `'ws-federation'` / `'social'`; **OMIT for `'entra-id'`** — resolved at runtime), optional `loginByEmail` (local-only)
- `AUTH_PROVIDERS: AuthProviderConfig[]` — the array (one entry per configured provider, in the order they should appear on the Login page)
- `LOCAL_PROVIDER` — exported helper: `AUTH_PROVIDERS.find(p => p.type === 'local')` (`undefined` if no local)
- `EXTERNAL_PROVIDERS` — exported helper: `AUTH_PROVIDERS.filter(p => p.type !== 'local')`
- `getCurrentUser()` — reads from `window.Microsoft.Dynamic365.Portal.User`
- `isAuthenticated()` — checks if user exists and has `userName`
- `getTenantId()` — reads `window.Microsoft.Dynamic365.Portal.tenant` (the site's parent tenant GUID). Returns `undefined` if not yet populated.
- `getAuthProvider()` — DEPRECATED. For backward compat, returns the first local provider or the first provider overall. Prefer reading `AUTH_PROVIDERS` directly.
- `fetchAntiForgeryToken()` — fetches from `/_layout/tokenhtml` and parses HTML response
- `resolveProviderIdentifier(provider)` — returns the value to POST as `provider` to `/Account/Login/ExternalLogin`. For `type='entra-id'`, derives `https://login.windows.net/${getTenantId()}/` at runtime. For other external types, returns `provider.providerIdentifier`. **Never hardcode tenant ID into the AUTH_PROVIDERS array for Entra ID** — this resolver handles it.
- `loginExternal(providerIdentifier, returnUrl?, invitationCode?)` — Form POST to `/Account/Login/ExternalLogin` for external providers
- `loginLocal(credential, password, rememberMe?, returnUrl?, invitationCode?)` — fetch POST to `/SignIn` for local
- `loginWithProvider(provider, { returnUrl?, invitationCode?, credentials? })` — **router**: dispatches to `loginLocal()` or `loginExternal()` based on `provider.type`. Uses `resolveProviderIdentifier()` so Entra ID's runtime resolution works transparently. This is what UI components should call.
- `logout(returnUrl?)` — redirects to `/Account/Login/LogOff`
- `getAuthError()` — parses `?message=` or `?error=` query params from server-side auth error redirects and returns a user-friendly error message
- `getSessionExpiredMessage()` — checks for `?sessionExpired=true` and returns a session-expired message
- `parseServerErrors(html)` — **Required for local auth.** Parses validation errors from server HTML responses (`.validation-summary-errors li`, `.alert-danger li`, `.field-validation-error`). Used by login and register to show server errors in the SPA.
- `register(fields, returnUrl?, invitationCode?)` — **Required when local auth is configured.** POSTs registration form to `/Account/Login/Register` with anti-forgery token, email or username (based on `LocalLoginByEmail` choice from Phase 2.1), password, confirmPassword, and optional invitationCode. When `LocalLoginByEmail` is `true`, sends `Email` field. When `false`, sends `Username` field. See `authentication-reference.md` for the full implementation.
- `forgotPassword(email)` — **Required when local auth is configured.** MVC form POST to `/Account/Login/ForgotPassword` with `Email` + anti-forgery token. Server sends a password reset email. Uses `fetch()` like login. Returns a promise — on success (`.then()`), show a "check your email" confirmation. On failure (`.catch()`), show the error.
- `resetPassword(userId, code, password, confirmPassword)` — **Required when local auth is configured.** MVC form POST to `/Account/Login/ResetPassword` with `UserId`, `Code`, `Password`, `ConfirmPassword`, `__RequestVerificationToken`. The `UserId` and `Code` come from the URL query params (set by the email reset link). On success, redirects to `/login?message=password_reset_success`.
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

> **Provider-agnostic — works for local AND external auth.** Power Pages issues the same `ApplicationCookie` session cookie regardless of how the user signed in (local password, Entra External ID, generic OIDC, SAML2, social). The keepalive operates on that cookie, so the same hook covers every provider. `isAuthenticated()` reads from `window.Microsoft.Dynamic365.Portal.User` which is populated for any authenticated user. No provider-specific branches are needed.

> **External providers — two independent clocks.** For external auth, the Power Pages session cookie and the IdP token (e.g., Entra External ID's ID token / refresh token) have separate lifetimes. The Power Pages session is what the SPA needs to keep alive; the IdP token is invisible to the SPA. When the Power Pages session does expire and the user is redirected to `/login?sessionExpired=true`, clicking the external provider button kicks off the IdP round-trip — but if the IdP's SSO cookie is still valid (typical), the round-trip is silent (no credential re-entry). The user lands back in the site signed in. This is the expected UX and requires no extra handling.

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

#### 5.1.1 Create Sign-In Page

> **Route naming — avoid server conflicts:** Power Pages reserves `/SignIn`, `/Register`, and all `/Account/Login/*` paths for server-rendered auth pages. SPA routes MUST NOT collide with these. Use `/login` for the sign-in page and `/registration` for the registration page.

**Always create the `/login` page when `AUTH_PROVIDERS.length > 1`.** When only one provider is configured (single external OR single local), the AuthButton's "Sign In" can call `login()` directly and no Login page is strictly needed — but creating one is still recommended since it gives a stable place to surface auth errors, the password reset link, the invitation banner, etc.

The Login page must:

- Import `AUTH_PROVIDERS`, `LOCAL_PROVIDER`, `EXTERNAL_PROVIDERS`, and `loginWithProvider` from authService
- Render every external provider as a button (loop `EXTERNAL_PROVIDERS`) — each button calls `loginWithProvider(provider, { returnUrl, invitationCode })`
- Render the local email/password form when `LOCAL_PROVIDER` exists. On submit, call `loginWithProvider(LOCAL_PROVIDER, { returnUrl, invitationCode, credentials: { credential, password, rememberMe } })`
- Use the credential field based on `LOCAL_PROVIDER.loginByEmail` — `Email` (type `email`) when `true`, `Username` (type `text`) when `false`
- Disable all buttons while any submission is in flight (an `isSubmitting` flag for local + `externalSubmittingId` for external)
- Catch `TermsRequiredError` from `loginWithProvider` and navigate to `/terms`
- Show the invitation banner when `invitationCode` is in the URL: "Sign in to redeem invitation {code}. The invitation will be linked to your account after you sign in."
- Show server-side auth errors parsed from `?message=` query params (via `getAuthError()`) and session-expired messages from `?sessionExpired=true` (via `getSessionExpiredMessage()`)
- Include a "Forgot password?" link to `/forgot-password` (SPA route) when `LOCAL_PROVIDER` exists and `ResetPasswordEnabled` is true
- Include a "Create an account" link to `/registration` when `REGISTRATION_MODE` is `Open registration only` or `Both` (omit for `Invitation-only` and `Registration disabled`)

**Render layout based on `LOGIN_LAYOUT` from Phase 2.1:**

| `LOGIN_LAYOUT` | Layout structure |
|---|---|
| `horizontal-row` (default) | External providers in a `flex-wrap` row at top, "OR SIGN IN WITH EMAIL" divider, local form below. Each external button has `flex: 1 1 0; min-width: 0` and ellipsis-truncates long labels. |
| `vertical-stack` | External providers stacked full-width vertically, "OR SIGN IN WITH EMAIL" divider, local form below. Each external button is full card width. |
| `primary-spotlight` | The provider matching `PRIMARY_PROVIDER_ID` rendered as a large primary CTA. Other external providers tucked under a `<details>` disclosure labeled "More sign-in options" or "Other ways to sign in". Then divider + local form. |
| `tabbed` | A tab bar with one tab per provider (`displayName`). The selected tab's UI renders below. For external providers, the tab content is just the "Sign in with X" button; for local, it's the email/password form. |

See `authentication-reference.md` for full code examples of each layout pattern in React.

When the `/login` page exists, the AuthButton's "Sign In" must navigate to `/login` (use `<Link to="/login">`) instead of calling any login function directly.

#### 5.1.2 Create Registration Page

**Always create the `/registration` page when `REGISTRATION_MODE` is not `Registration disabled`** — regardless of whether the mode is `Open registration only`, `Invitation-only`, or `Both`, and regardless of whether local or external providers (or both) are configured. The page mirrors the Login page layout when both local and external providers exist: external provider buttons in a horizontal row at the top, an "or sign up with email" divider, and the local registration form below (when local auth is configured). In invitation-only mode the page is reached via the `/redeem-invitation` flow (Phase 5.1.7) or via the server-bouncing flow (Code-Site-Shell-Header catches `/account/login/register`), not direct navigation — but the SPA route must still exist so React Router can render it.

> **Important architectural note:** The server-side registration page (`/Account/Login/Register`) is an ASP.NET Web Forms page, NOT an MVC action. The local `register()` function in authService handles this by first fetching the server page (GET), parsing the ViewState and control names, then POSTing with the correct payload. This only applies when the user submits the local registration form — external provider buttons skip this entirely and go through `loginExternal()`.

**External provider buttons (when `EXTERNAL_PROVIDERS.length > 0`):**

Render external provider sign-up buttons in a horizontal row at the top of the page — same layout pattern as the Login page (Phase 5.1.1). Each button calls `loginExternal(providerIdentifier, returnUrl, invitationCode)` from authService — when the user clicks "Sign up with Entra External ID" the SPA initiates external auth with the invitation code (if present) in the URL. The server's `ExternalLoginCallback` then either auto-links via `AllowContactMappingWithEmail`, or surfaces the SPA-ified ExternalLoginConfirmation page (Phase 5.1.8), or redeems the invitation if one was provided. **This is the same code path as the Login page external buttons** — `loginExternal()` doesn't care whether the user came from `/login` or `/registration`; the server creates the contact on first sign-in if one doesn't exist.

If `EXTERNAL_PROVIDERS.length > 0` AND `LOCAL_PROVIDER` exists, show the divider ("or sign up with email") between the external buttons and the local form. If only external providers (no local), show ONLY the external buttons with no divider and no local form — the page becomes effectively "pick a provider to sign up with".

**Local form (when `LOCAL_PROVIDER` exists):**

The local registration form must:

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

**Layout** — matches the Login page (Phase 5.1.1). When the user picks `LOGIN_LAYOUT` in Phase 2.1, that layout choice (horizontal row / vertical stack / primary spotlight / tabbed) applies to both `/login` AND `/registration` so users get a consistent experience across the two pages.

**Pre-fill email from invitation (when `InvitationEnabled` is true — i.e., Invitation-only or Both modes):**

When the user arrives at `/registration?invitationCode=X`, the email field should pre-fill with the invited contact's email (matching the server-rendered page's behavior). Implement by calling `fetchInvitationDetails(invitationCode)` on mount:

```typescript
useEffect(() => {
  if (!invitationCode) return
  fetchInvitationDetails(invitationCode).then(details => {
    if (details.email) setEmail(details.email)
  }).catch(() => { /* silent — user can enter email manually */ })
}, [invitationCode])
```

The `fetchInvitationDetails()` function (in `authService.ts`) GETs `/Account/Login/Register?invitationCode={code}` and parses the email from the rendered HTML's `#EmailTextBox` input value attribute. See `authentication-reference.md` for the implementation.

The email input must be **controlled** (`value={email}`) and editable — the user can change it if needed (this matches server behavior).

**Framework-specific implementation:**

- **React**: Create `src/pages/Registration.tsx` and add `<Route path="/registration" element={<Registration />} />` to the router. See the `RegisterForm` component in `authentication-reference.md` for the implementation pattern — adapt it to match the site's existing styling patterns (inline styles, CSS variables, etc.)
- **Vue**: Create `src/pages/Registration.vue` and add the route to `src/router/index.ts`
- **Angular**: Create `src/app/pages/registration/registration.component.ts` and add the route to the router config
- **Astro**: Create `src/pages/registration.astro`

**If `REGISTRATION_MODE` is `Registration disabled`**, skip creating the `/registration` page entirely — there's no flow that should land users there.

#### 5.1.3 Create Forgot Password Page (Local Auth Only)

**If local authentication is configured AND `ResetPasswordEnabled` is `true`**, create a `/forgot-password` page. This is a simple form that collects the user's email and POSTs to the server, which sends a password reset link via email.

> **Note:** The forgot password endpoint (`/Account/Login/ForgotPassword`) is an MVC form (like login), NOT a Web Forms page (like registration). A simple `fetch()` POST with `Email` + `__RequestVerificationToken` works. The `forgotPassword()` function in authService handles this.

The forgot password page must:

- Show an email input field
- Call `forgotPassword(email)` from authService on submit
- **Handle both success and error**: Use `.then()` for success (show "Check your email" confirmation with green checkmark, hide the form) and `.catch()` for errors (show error inline, reset button). Do NOT only handle `.catch()` — the button will get stuck in "Sending..." state if `.then()` is not handled.
- Track `emailSent` state — when true, replace the form with a success message: "We've sent a password reset link to your email address. Please check your inbox and follow the instructions." with a "Back to sign in" link
- Display server errors inline (the `forgotPassword()` function uses fetch and throws parsed errors)
- Include a "Back to sign in" link to `/login`
- Use the same validate-on-blur pattern as login and registration (validate email format on blur, clear on change)

The login page's "Forgot password?" link should point to `/forgot-password` (SPA route), NOT `/Account/Login/ForgotPassword` (server URL).

After the server processes the request, it sends a reset email. The reset link in the email points to the server's `/Account/Login/ResetPassword?UserId=...&Code=...` — but this gets intercepted by the Header template redirect script (see Phase 5.1.6) and redirected to the SPA `/reset-password` page.

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

**If the user enabled Terms and Conditions in Phase 2**, create a `/terms` SPA page. **This page works for ALL auth flows** — local sign-in, local registration, AND external providers (Entra External ID, OIDC, social) — via two complementary mechanisms:

1. **Local auth flows** (`loginLocal`, `register`): use `fetch()` so the SPA stays in-page. The auth service detects the server's `TermsAndConditions` redirect from `response.url` and throws `TermsRequiredError`. The login/registration page catches it and navigates to `/terms`.
2. **External auth flows** (`loginExternal`, `loginWithProvider` external branch): use `form.submit()` so the browser leaves the SPA during the IdP round-trip. After IdP callback, the server may redirect to `/Account/Login/TermsAndConditions?ReturnUrl=/&UseExternalSignInAsync=True&IsFacebook=False&IsInternalAADUser=False`. The Code-Site-Shell-Header script (Phase 5.1.6) catches this URL and redirects to the SPA `/terms` route, preserving the query string so `acceptTerms()` knows which sign-in completion path the server expects.

The terms page must:

- Hardcode the 4 snippet values collected in Phase 2 as constants at the top of the component:
  ```typescript
  const TERMS_HEADING = '<value from Phase 2 or default>'
  const TERMS_CONTENT = '<HTML content from Phase 2 or default>'
  const TERMS_AGREEMENT_TEXT = '<value from Phase 2 or default>'
  const TERMS_BUTTON_TEXT = '<value from Phase 2 or default>'
  ```
- Display the heading, terms content (rendered as HTML via `dangerouslySetInnerHTML`), checkbox with agreement text, and confirm button
- The confirm button calls `acceptTerms('/')` from authService — this reads the query string from `window.location.search`, fetches the server terms page (with the same query string preserved) to get the anti-forgery token, then POSTs the acceptance back to the same URL with the flags from the query string in the body
- The confirm button is disabled until the checkbox is checked
- Display server errors inline if `acceptTerms()` throws
- Include a "Back to sign in" link to `/login`

**Login and Registration pages must catch `TermsRequiredError` (local auth path):**
- In the Login page's `loginLocal()` catch block: if `err instanceof TermsRequiredError`, navigate to `/terms`
- In the Registration page's `register()` catch block: if `err instanceof TermsRequiredError`, navigate to `/terms`

**No SPA code changes needed in `loginExternal` for the external auth path** — the header-template redirect (Phase 5.1.6) handles it transparently. The external user lands at `/terms?ReturnUrl=/&UseExternalSignInAsync=True&...` after the IdP round-trip; the SPA renders the Terms page; `acceptTerms()` uses the query string to POST back with the correct `UseExternalSignInAsync` / `IsFacebook` / `IsInternalAADUser` flags.

**How the server triggers terms (for reference):**
- **Local login flow**: Server redirects to `/Account/Login/TermsAndConditions` after auth — caught via `response.url.includes('TermsAndConditions')` in `loginLocal()`
- **Local registration flow**: Server redirects to `/TermsAndConditions?ReturnUrl=%2F` after registration — caught via `response.url.includes('TermsAndConditions')` in `register()`
- **External login flow**: Server redirects from `/Account/Login/ExternalLoginCallback` to `/Account/Login/TermsAndConditions?ReturnUrl=/&UseExternalSignInAsync=True&IsFacebook=False&IsInternalAADUser=False` — caught via header-template redirect

**`acceptTerms()` must be query-string-aware** (required when external providers are configured alongside terms):

```typescript
export async function acceptTerms(returnUrl?: string): Promise<void> {
  // Parse the flags from window.location.search — set by the server's redirect URL.
  // For local-auth users (no query string), defaults apply.
  const params = new URLSearchParams(window.location.search);
  const useExternalSignInAsync = params.get('UseExternalSignInAsync') || 'False';
  const isFacebook = params.get('IsFacebook') || 'False';
  const isInternalAADUser = params.get('IsInternalAADUser') || 'False';

  // Fetch the server terms page WITH the original query string preserved
  const serverTermsUrl = `/Account/Login/TermsAndConditions${window.location.search}`;
  const pageResponse = await fetch(serverTermsUrl, { credentials: 'same-origin', redirect: 'follow' });

  // ... extract anti-forgery token from rendered HTML ...

  // POST back to the same URL with body flags matching the query-string flags.
  // DO NOT hardcode UseExternalSignInAsync=False — external users need True.
  const body = new URLSearchParams();
  body.set('__RequestVerificationToken', antiForgeryToken);
  body.set('IsTermsAndConditionsAccepted', 'true');
  body.set('UseExternalSignInAsync', useExternalSignInAsync);
  body.set('IsFacebook', isFacebook);
  body.set('IsInternalAADUser', isInternalAADUser);
  body.set('InvitationCode', '');
  // ... POST and handle response ...
}
```

See `authentication-reference.md` for the full implementation.

**Framework-specific implementation:**
- **React**: Create `src/pages/Terms.tsx` and add `<Route path="/terms" element={<Terms />} />` to the router

> **Content updates**: When the site creator wants to change the terms text, they update the constants in the Terms page component and redeploy. The content snippets in Dataverse (`Account/Signin/TermsAndConditionsCopy` etc.) must also be updated to match — the server-rendered terms page reads from snippets, and the SPA reads from the hardcoded constants. Both must stay in sync.

#### 5.1.6 Create Reset Password Page + Header Template Redirect (Local Auth Only)

**If local authentication is configured AND `ResetPasswordEnabled` is `true`**, create a full SPA reset password experience. This involves two pieces:

**1. Code-Site-Shell-Header Template**

The password reset email sends the user to `/Account/Login/ResetPassword?UserId=...&Code=...` — a server-rendered page. To keep the user in the SPA, we need a client-side redirect script that runs on server-rendered pages.

> **Why a new template?** The `pac pages upload-code-site` command intentionally replaces the original "Header" and "Footer" web template content with `<div/>` on every upload. Any script added to the Header template gets wiped. The workaround is to create a **separate** web template (`Code-Site-Shell-Header`) and point the website record to it instead.

Create a new web template in `.powerpages-site/web-templates/code-site-shell-header/`:

**`Code-Site-Shell-Header.webtemplate.yml`:**
```yaml
id: <generate-a-new-uuid>
name: Code-Site-Shell-Header
```

**`Code-Site-Shell-Header.webtemplate.source.html`:**
```html
<div/>
<script>
  // Code Site Shell Header — Server-to-SPA redirect for auth pages.
  // This template runs on server-rendered pages and redirects to SPA equivalents.
  // Uses a separate template because pac pages upload-code-site wipes the original Header.
  (function () {
    var path = window.location.pathname.toLowerCase();
    var search = window.location.search;
    var spaBase = window.location.origin;
    // Add an entry here for each server-rendered auth page that has a SPA equivalent.
    // Only include entries the site actually needs (e.g., omit /redeeminvitation when
    // InvitationEnabled is false).
    var redirects = {
      '/account/login/resetpassword': '/reset-password',
      '/account/login/redeeminvitation': '/redeem-invitation',
      '/register': '/redeem-invitation',
      '/account/login/register': '/registration',
      '/account/login/externallogincallback': '/external-login-confirmation',
      '/account/login/termsandconditions': '/terms',
      '/account/login/externalauthenticationfailed': '/login',
      '/signin': '/login'
    };
    // Special case: ExternalAuthenticationFailed may arrive with no query string
    // (generic failure) or with ?message=access_denied (user-denied at IdP).
    // Ensure the Login page always shows SOME error indication.
    if (path === '/account/login/externalauthenticationfailed' && !search) {
      window.location.replace(spaBase + '/login?message=external_auth_failed');
      return;
    }
    for (var serverPath in redirects) {
      if (path === serverPath) {
        window.location.replace(spaBase + redirects[serverPath] + search);
        return;
      }
    }
  })();
</script>
```

**Conditional entries** — only include redirect entries for pages that exist in the SPA:

| Redirect | Include when |
|---|---|
| `'/account/login/resetpassword': '/reset-password'` | Local auth + `ResetPasswordEnabled = true` (Phase 5.1.6) |
| `'/account/login/redeeminvitation': '/redeem-invitation'` | `REGISTRATION_MODE` is `Invitation-only` or `Both` (Phase 5.1.7) |
| `'/register': '/redeem-invitation'` | `REGISTRATION_MODE` is `Invitation-only` or `Both` (Phase 5.1.7). `/Register` is the **alias route for `LoginController.RedeemInvitation`** — the server redirects external users here from `ExternalLoginCallback` when they have no contact AND no invitation context (per `RegistrationManager.cs` gating logic). Catching this preserves the SPA UX for external users who initiated sign-in without an invitation link. |
| `'/account/login/register': '/registration'` | `REGISTRATION_MODE` is not `Registration disabled` (Phase 5.1.2). This is the **local Register Web Forms page**. The server redirects here after the RedeemInvitation form is submitted (from `/Register` → `/Account/Login/Register?invitationCode=...`). Catching this keeps the user in the SPA `/registration` page, which itself mirrors the Login page layout — external provider buttons above a divider, local form below — so the user can complete sign-up either way (Phase 5.1.2). |
| `'/account/login/externallogincallback': '/external-login-confirmation'` | Any external provider is configured (Phase 5.1.8) — captures first-time external sign-in into the SPA |
| `'/account/login/termsandconditions': '/terms'` | Terms & Conditions are enabled (any auth flow — see Phase 5.1.5) — captures the server's post-auth Terms redirect for external providers |
| `'/account/login/externalauthenticationfailed': '/login'` | Any external provider is configured. **The server redirects here when external auth fails** — invalid token, issuer mismatch, user-denied at IdP, IdP outage, etc. This path is hardcoded in OWIN startup and cannot be overridden via site settings (per `authentication-reference.md`). The redirect script special-cases this URL: when the server appends `?message=access_denied` (user-denied case), it carries through and `getAuthError()` shows "Access was denied." When the server appends no query string (generic failure), the script injects `?message=external_auth_failed` so the Login page shows "Sign-in with the external provider failed. Please try again." (add this code to `AUTH_ERROR_MESSAGES` in authService). |
| `'/signin': '/login'` | **Always include** (any auth flow). `/SignIn` is the server's legacy sign-in page — the server bounces unauthenticated users there whenever they hit a protected server-rendered path (e.g., `/profile`, `/Account/Manage`, any server page gated by web roles). Without this entry, the user gets dropped out of the SPA into the server-rendered sign-in UI. Any `?ReturnUrl=...` query param the server appends is carried through unchanged — the SPA `/login` page currently ignores it (always returns to `/` after sign-in), which is acceptable behavior. |

> **About the two new entries (`/register` and `/account/login/register`):** these handle a specific external-auth flow that's hard to discover otherwise. When an external user (Entra External ID, OIDC, SAML2, social) clicks the "Sign in" button WITHOUT first clicking an invitation email link, and they don't have an existing contact in Dataverse, the server forces them through a server-rendered invitation flow:
>
> 1. `POST /Account/Login/ExternalLogin` → IdP → `/signin-{provider}` → `/Account/Login/ExternalLoginCallback`
> 2. `ExternalLoginCallback` finds no contact + no invitation → redirects to `/Register?ReturnUrl=/` (the RedeemInvitation form, server-rendered)
> 3. User enters invitation code → server validates → redirects to `/Account/Login/Register?invitationCode=...` (the local Register Web Forms page, which has external provider buttons rendered on it)
> 4. User clicks an external provider button on the Register page → `/Account/Login/ExternalLogin?InvitationCode=...` → external auth round 2 with invitation in URL → contact created + invitation redeemed
>
> Without the `/register` and `/account/login/register` redirects, the user sees the server-rendered RedeemInvitation form and the Web Forms Register page — both break the SPA UX. **These redirects apply to ALL external providers, not just Entra External ID, because the server's bouncing logic is provider-agnostic.**

Then update **`website.yml`** to point `headerwebtemplateid` to the new template's ID:

```yaml
headerwebtemplateid: <new-template-uuid>
```

The original "Header" template stays as `<div/>` (the upload command will keep wiping it, which is fine). The `Code-Site-Shell-Header` template survives uploads because the command only targets the templates named "Header" and "Footer".

This is extensible — additional server-to-SPA redirects can be added to the `redirects` object (e.g., for email confirmation pages).

**2. SPA Reset Password Page**

Create a `/reset-password` page that:

- Reads `UserId` and `Code` from the URL query params (preserved by the header redirect)
- Shows "Invalid Reset Link" with a link to `/forgot-password` if either param is missing
- Shows new password + confirm password fields with validate-on-blur (password strength validation same as registration)
- Calls `resetPassword(userId, code, password, confirmPassword)` from authService on submit
- On success, redirects to `/login?message=password_reset_success`
- On error, shows server errors inline

The `resetPassword()` function is an MVC form POST (no ViewState) to `/Account/Login/ResetPassword` with fields: `__RequestVerificationToken`, `UserId`, `Code`, `Password`, `ConfirmPassword`. Note: the password field is `Password` here (NOT `PasswordValue` like login — different endpoints use different field names).

**Login page must handle the success message**: Check for `?message=password_reset_success` in the URL on mount and display a green success banner: "Your password has been reset. Please sign in with your new password."

**Framework-specific implementation:**
- **React**: Create `src/pages/ResetPassword.tsx` and add `<Route path="/reset-password" element={<ResetPassword />} />` to the router

#### 5.1.7 Create Redeem Invitation Page (Invitation Modes Only)

**If `REGISTRATION_MODE` is `Invitation-only` or `Both`**, create a `/redeem-invitation` SPA page. This is the landing page users hit when they click an invitation email link. The link format is `{site-url}/Account/Login/RedeemInvitation?invitation={code}` — the Code-Site-Shell-Header redirect (Phase 5.1.6) catches it and forwards to the SPA route.

**Two paths land users on `/redeem-invitation`:**

1. **Direct invitation link**: User clicks the email link `/Account/Login/RedeemInvitation?invitation={code}` → header script redirects to `/redeem-invitation?invitation={code}`. Clean SPA entry — invitation code in URL from the start.

2. **Server-bounce path (external auth, no contact, no invitation)**: User clicks "Sign in with [external provider]" on the Login page WITHOUT first clicking an invitation link. They complete external auth, the server's `ExternalLoginCallback` finds no contact + no invitation, and redirects them to `/Register?ReturnUrl=...` (the alias for `LoginController.RedeemInvitation`). The header script catches `/register` and redirects to `/redeem-invitation` — same SPA page, no invitation code pre-filled, user types it in. This path applies to **all external providers**, not just Entra External ID — the server-side bouncing logic is provider-agnostic. **Confirmed via HAR analysis on a live site with Entra External ID + Terms.**

**Server flow this replaces:** The server's `LoginController.RedeemInvitation` action (`crm.solutions.portal/Samples/MasterPortal/Areas/Account/Controllers/LoginController.cs` lines 3232-3310) validates the invitation code and branches:

- **RedeemByLogin = false** (new user) → 302 redirect to `/Account/Login/Register?invitationCode={code}` — server expects registration with the code
- **RedeemByLogin = true** (existing user) → 200 OK with Login view, invitation code embedded in the form action URL — server expects sign-in, then redeems invitation in `RedirectOnPostAuthenticate` after auth
- **Invalid / expired / already-redeemed code** → 200 OK with form re-rendered, error in `#redeemInvitation-validation-summary` (all three conditions surface the same `Invalid_Invitation_Code_Exception`)

**SPA design — fully replaces the server-rendered page:**

The SPA page calls `redeemInvitation(code, redeemByLogin)` from authService, which uses `fetch()` with `redirect: 'manual'` to intercept the server's 302 redirect. Based on the response:

- `response.type === 'opaqueredirect'` → server validated code + would have redirected to Register → SPA navigates to `/registration?invitationCode={code}` (existing page from Phase 5.1.2)
- 200 OK with Login form markers in HTML → user wanted login flow → SPA navigates to `/login?invitationCode={code}` (existing page — must also be updated, see below)
- 200 OK with validation summary in HTML → invalid code → throw parsed server error (use existing `parseServerErrors()` helper)

> **DevTools artifact**: After the POST, the browser's network panel will show the 302 Location target (e.g., `/Account/Login/Register`) as an aborted (`net::ERR_ABORTED`) request. This is expected — it's the redirect we intentionally chose not to follow via `redirect: 'manual'`. The flow uses `response.type === 'opaqueredirect'` to detect the redirect occurred without actually following it.

The redeem invitation page must:

- Read `invitation` or `InvitationCode` from the URL query (handle both casings — emails may use either)
- Pre-fill the invitation code input but keep it editable (in case user types it in manually with no email link)
- Show a checkbox: **"Sign in with an existing account instead of registering"** (this controls `RedeemByLogin`)
- Validate-on-blur: invitation code required and non-empty
- On submit, call `redeemInvitation()` and navigate based on the returned `nextStep`
- Display server errors inline (parsed via existing `parseServerErrors`)
- Include a "Back to sign in" link to `/login`
- Be styled to match the rest of the auth pages

**Login page update (required):**

The Login page (Phase 5.1.1) must also be updated when invitation mode is enabled:

1. Read `invitationCode` from URL query params on mount
2. If present, show an info banner: `"Sign in to redeem invitation {code}. The invitation will be linked to your account after you sign in."`
3. Pass `invitationCode` to `loginLocal()` as the new 5th parameter — the auth service appends it as `?InvitationCode={code}` on the `/SignIn` POST URL. The server's `Login(model, returnUrl, invitationCode)` handler reads this and redeems the invitation in `RedirectOnPostAuthenticate` after successful authentication.

**Framework-specific implementation:**

- **React**: Create `src/pages/RedeemInvitation.tsx` and add `<Route path="/redeem-invitation" element={<RedeemInvitation />} />` to the router. See the `RedeemInvitation` component in `authentication-reference.md` for the implementation pattern.
- **Vue / Angular / Astro**: Mirror the React pattern in the framework's idioms.

**Auth service additions** (required when invitation mode is enabled):

- `redeemInvitation(invitationCode, redeemByLogin, returnUrl)` — see Phase 3.2 for the function inventory; full code in `authentication-reference.md`
- `fetchInvitationDetails(invitationCode)` — already covered in Phase 5.1.2 for email pre-fill
- `loginLocal()` updated to accept optional `invitationCode` parameter (5th arg) — appends `?InvitationCode={code}` to the `/SignIn` URL

#### 5.1.8 Create External Login Confirmation Page (External Providers Only)

**If any external provider is configured** (OIDC, Entra External ID, SAML2, WS-Federation, social), create a `/external-login-confirmation` SPA page. This captures the first-time external sign-in flow that the server would otherwise render as `ExternalLoginConfirmation.aspx`.

**Server flow this replaces:** When a user signs in externally for the first time and no Dataverse contact exists, the server's `LoginController.ExternalLoginCallback` action (`crm.solutions.portal/Samples/MasterPortal/Areas/Account/Controllers/LoginController.cs` ~line 761) renders the `ExternalLoginConfirmation` view AT the callback URL (`/Account/Login/ExternalLoginCallback`). The view shows an editable email field plus hidden firstName/lastName/username from claims, and POSTs to `/Account/Login/ExternalLoginConfirmation`.

**Why this can be SPA-ified (same pattern as Reset Password and Redeem Invitation):**

- The `__External` cookie (5-minute TTL, `AuthenticationMode = Passive`, `Secure = Always`) stores the claims between the IdP callback and the form POST. It's auto-sent on `same-origin` fetches.
- The SPA fetches the server URL, parses the rendered HTML to extract pre-fill values + anti-forgery token, shows its own form, and POSTs back. The server processes the form unchanged.

**Skip conditions** — server skips this page entirely when:
- The user's email claim matches an existing contact AND `AllowContactMappingWithEmail = true` → server auto-signs in
- The user has an invitation code AND it resolves to an existing contact in the ESS system → server auto-signs in
- Registration is disabled or the user isn't allowed to register

In those cases the user goes straight to home after IdP callback — the SPA page never mounts.

### Redirect chain

```
Email link / "Sign in with Entra External ID" button
   ↓
POST /Account/Login/ExternalLogin → server redirects to IdP
   ↓
User authenticates at IdP → IdP callback to /signin-{providername}
   ↓
OIDC middleware processes callback (sets __External cookie with claims)
   ↓
Forward to /Account/Login/ExternalLoginCallback
   ↓
ExternalLoginCallback action: new user, no existing contact
   → returns ExternalLoginConfirmation view at the callback URL
   ↓
┌─ Code-Site-Shell-Header script catches /account/login/externallogincallback ─┐
│  → window.location.replace('/external-login-confirmation' + query)            │
└────────────────────────────────────────────────────────────────────────────────┘
   ↓
SPA /external-login-confirmation page mounts
   → calls fetchExternalLoginDetails()
     → GET /Account/Login/ExternalLoginCallback (__External cookie auto-sent)
     → server returns the same rendered HTML
     → SPA parses #Email, #FirstName, #LastName, #Username, #InvitationCode,
       __RequestVerificationToken, and the form's action URL for ReturnUrl
   ↓
SPA renders own form, email pre-filled and editable
   ↓
User clicks "Create my account"
   → confirmExternalLogin() POST /Account/Login/ExternalLoginConfirmation
     (form fields + anti-forgery token, redirect:'manual')
   ↓
   ├── response.type === 'opaqueredirect' → window.location.href = returnUrl
   │     (server sets ApplicationCookie BEFORE returning 302 — user is signed in)
   ├── 200 OK with validation-summary → throw parsed error (e.g., duplicate email
   │     when RequireUniqueEmail is true and user typed an existing email)
   └── 200 OK with TermsAndConditions markers → throw TermsRequiredError →
         SPA navigates to /terms
```

### Auth service additions (when any external provider is configured)

Add three things to `src/services/authService.ts` — full code in `authentication-reference.md`:

- `ExternalLoginCookieExpiredError` class — thrown when the `__External` cookie has expired (5-minute TTL exceeded). The page navigates to `/login` with an expired-session message.
- `fetchExternalLoginDetails()` — fetches `/Account/Login/ExternalLoginCallback`, parses HTML for pre-fill values and anti-forgery token. Throws `ExternalLoginCookieExpiredError` if the form isn't present.
- `confirmExternalLogin(details)` — POSTs to `/Account/Login/ExternalLoginConfirmation` with `redirect:'manual'`. Branches on response type to navigate or throw.

### SPA page

Create `src/pages/ExternalLoginConfirmation.tsx`:

- On mount, calls `fetchExternalLoginDetails()`. Three states: loading, cookie-expired, ready.
- When cookie expired: shows "Sign-in session expired" with a "Back to sign in" link to `/login`.
- When ready: shows the user's full name read-only (from claims), an editable email input (default = email claim), and an "invitation banner" if `invitationCode` is non-empty.
- On submit, calls `confirmExternalLogin(details)`. Handles `TermsRequiredError` → navigate to `/terms`. Handles `ExternalLoginCookieExpiredError` (mid-session expiry) → switch UI to the expired state.
- Server-side validation errors shown inline via `parseServerErrors`.

### Routing

Add `<Route path="/external-login-confirmation" element={<ExternalLoginConfirmation />} />`.

### DevTools artifact

After the POST, the network panel may show the 302 Location target (e.g., the returnUrl path) as an aborted (`net::ERR_ABORTED`) request — same as the RedeemInvitation pattern. Expected behavior from `redirect:'manual'`, not an error.

### Edge cases

- **2FA**: If the user has 2FA enabled, the challenge happens AFTER `SignInAsync` completes (during the 302 redirect). The SPA-ified flow doesn't interfere — the 2FA challenge (`SendCode`/`VerifyCode`) is its own server-rendered flow that cannot be intercepted.
- **`SameSite=Strict`**: If the `__External` cookie is configured with `SameSite=Strict`, the SPA's fetch won't include it and `fetchExternalLoginDetails` throws `ExternalLoginCookieExpiredError` immediately. Default is `Lax` (set via `SameSiteCookieHelper.GetOwinSameSiteFromSiteSettings`) — works fine.
- **Invited user via external login**: Invitation code is captured from the form action URL by `fetchExternalLoginDetails` and re-sent on the POST. The server redeems the invitation as part of contact creation.

#### 5.1.9 Create Profile Page (When INCLUDE_PROFILE_PAGE = true)

**Conditional on `INCLUDE_PROFILE_PAGE = true`** (Phase 2.1). Skip this entire phase otherwise.

Creates a `/user-profile` SPA page where signed-in users edit their contact record via the Power Pages Web API. Provider-agnostic — works for local + all external providers because it operates on the contact record after sign-in.

> **⚠ MANDATORY NAMING — do not deviate:**
>
> | Item | Required name | Wrong examples to AVOID |
> |---|---|---|
> | SPA route | `/user-profile` | ❌ `/profile` (server-reserved), `/my-profile`, `/account/profile` |
> | Page component file | `src/pages/UserProfile.tsx` | ❌ `Profile.tsx`, `MyProfile.tsx`, `UserProfilePage.tsx` |
> | Component export name | `UserProfile` (default export) | ❌ `Profile`, `ProfilePage` |
> | Service function — read | `getMyProfile(contactId)` | ❌ `getOwnContact`, `getProfile`, `fetchProfile` |
> | Service function — write | `updateMyProfile(contactId, payload)` | ❌ `patchOwnContact`, `updateProfile`, `saveProfile` |
> | Type — contact shape | `ProfileContact` | ❌ `Contact`, `UserContact` |
> | Type — patch payload | `ProfileUpdate` | ❌ `ContactUpdate`, `ProfilePatch` |
>
> Why naming matters: the file/route names are referenced by other parts of this skill (Phase 7.1 verification, Phase 8.3 summary), the auth-reference.md, and the eval scenarios. Renaming creates a broken-cross-reference cascade. The route `/profile` specifically MUST NOT be used because the Power Pages server reserves it for the legacy server-rendered profile page (`Authentication/Registration/ProfileRedirectEnabled` redirects users to `/profile` after sign-in by default — we set this to `false` to prevent the redirect, but creating a SPA route at the same path would cause conflicts).

##### 5.1.9.a Extend authService with profile functions

Add to `src/services/authService.ts` (keep all related auth/profile logic in one place; reuse the existing `fetchAntiForgeryToken()` helper for the PATCH anti-forgery token).

**Use these EXACT names** — the executor MUST NOT invent shorter or differently-styled names like `patchOwnContact`, `getOwnContact`, `updateProfile`:

| Required name | Kind | Description |
|---|---|---|
| `ProfileContact` | exported interface | Typed contact shape with `contactid` + the 8 editable fields (firstname, lastname, mobilephone, address1_line1, address1_city, address1_stateorprovince, address1_postalcode, address1_country) all typed `string \| null`. **DO NOT include emailaddress1 or middlename** — email is displayed read-only from `useAuth().user.email` (no Web API roundtrip needed for it), and middlename is intentionally excluded from the simple form. |
| `ProfileUpdate` | exported type alias | `Partial<Omit<ProfileContact, 'contactid'>>` for the PATCH payload |
| `getMyProfile` | exported async function | Signature: `(contactId: string): Promise<ProfileContact>`. GETs `/_api/contacts({contactId})?$select=contactid,firstname,lastname,mobilephone,address1_line1,address1_city,address1_stateorprovince,address1_postalcode,address1_country` (the `$select` value MUST exactly match the 9-entry list in Phase 8.1's `Webapi/contact/fields` site setting) with `credentials: 'same-origin'`. Throws on non-OK. Returns the parsed JSON. Dev-mode returns a mock object. |
| `updateMyProfile` | exported async function | Signature: `(contactId: string, payload: ProfileUpdate): Promise<void>`. PATCHes `/_api/contacts({contactId})` with body containing only DEFINED fields (skip `undefined` so partial updates don't blank-out unaffected columns — but DO send `null` for fields the user explicitly cleared). Headers: `Content-Type: application/json`, `If-Match: *`, `__RequestVerificationToken` from `fetchAntiForgeryToken()`. Throws on non-OK with parsed error message. Dev-mode is a no-op success. |
| `applyContactUpdateLocally` | exported function | Signature: `(payload: ProfileUpdate): void`. Mirrors the saved `firstname` / `lastname` from `payload` back into `window.Microsoft.Dynamic365.Portal.User` (mutating `firstName` / `lastName` properties in place — note the camelCase on the snapshot, lowercase on the payload). Returns early if `window` or `Portal.User` is unavailable. Only mirrors `firstname` and `lastname` — the other fields aren't used by the header. **Without this helper, the header keeps showing the old name after a save until the next full page reload — see the "header refresh after save" requirement in 5.1.9.b.** |

Full reference code in `authentication-reference.md` "User Profile Page" section. **Copy that code as-is** — do not rename functions or change signatures.

> **Also update `useAuth()` (`src/hooks/useAuth.ts`)** to spread the user object inside `refresh()` / `loadUser()` — `setUser(current ? { ...current } : undefined)` instead of `setUser(getCurrentUser())`. Reason: after `applyContactUpdateLocally` mutates `Portal.User` in place, the returned reference from `getCurrentUser()` is the same object instance. React's `setState` skips re-renders when the new state ref is identical to the current ref. Spreading into a new object forces React to see a fresh ref and re-run consumers, so `AuthButton` repaints with the new name. (Framework-equivalent change for Vue/Angular: ensure the user ref/Subject emits a fresh value, not the same instance.)

##### 5.1.9.b Create UserProfile.tsx

Create `src/pages/UserProfile.tsx` (filename mandatory, do NOT rename to `Profile.tsx`).

**Two sections — Account Details (read-only) at the top, then the edit form. Nothing else.**

### Account Details section (read-only, at top)

A simple display block showing exactly two pieces of info from `useAuth().user`:

| Label | Value source |
|---|---|
| Full name | `user.firstName` + ' ' + `user.lastName` (combined; show "—" if both empty) |
| Email | `user.email` |

**DO NOT** display contactId, userRoles, sign-in provider, username, last-login date, or any other field. The Account Details section's entire purpose is to remind the user which account they're signed in as — name and email suffice.

Rendering: a small card / heading "Account details" with two label-value rows. Use existing CSS variables. No edit affordance. No "edit email" button. No "edit account" link.

### Page logic

- Read `user`, `isAuthenticated`, `refresh` from `useAuth()`. If `!isAuthenticated`, redirect to `/login?returnUrl=/user-profile`.
- If `user.contactId` is empty or missing, show "Profile unavailable for this account. Your admin needs to set up the `RegistrationClaimsMapping` site setting for your auth provider so contacts get created with a valid ID." (handles the Entra workforce broken-claims-mapping edge case documented earlier in this skill)
- On mount, call `getMyProfile(user.contactId)` to fetch current values for the editable form. Show loading state.

### MANDATORY editable field set (exactly 8 fields)

The form MUST include exactly these 8 fields — no more, no less. Do NOT add email (it's read-only in Account Details). Do NOT add middlename. Do NOT add a "Change password" link. Do NOT add a "Sign out" button.

| Form label | Form field `name` attr / contact column | Type | Required on submit? |
|---|---|---|---|
| First name | `firstname` | text | No (all optional) |
| Last name | `lastname` | text | No |
| Mobile phone | `mobilephone` | tel | No |
| Address line 1 | `address1_line1` | text | No |
| City | `address1_city` | text | No |
| State / Province | `address1_stateorprovince` | text | No |
| Postal code | `address1_postalcode` | text | No |
| Country | `address1_country` | text | No |

All fields are optional. An empty string in the form is sent as `null` to the Web API (so users can clear values). The page layout groups Name fields (firstname/lastname), then Contact (mobile), then Address (all `address1_*` fields). Use a CSS grid with `grid-template-columns: repeat(auto-fit, minmax(220px, 1fr))` for responsive 1-2 column layout.

### Things NOT to include on the profile page

The executor MUST NOT add any of these — they're either redundant with existing UI or out of scope:

- ❌ "Change password" link or button — password reset goes through the existing `/forgot-password` flow (link is on the Login page)
- ❌ "Sign out" button on the profile page — sign-out lives in the header AuthButton dropdown only
- ❌ Editable email field — email is displayed read-only in the Account Details section above
- ❌ Middle name field
- ❌ ContactId, userRoles, sign-in method, provider name, last-login timestamp, or any other account metadata
- ❌ Email caveat note (the note about LoginClaimsMapping overwriting email edits is no longer relevant since email isn't editable)
- ❌ Account deletion or "Close account" button — out of scope

### Logic details

- Validate-on-blur using the existing pattern from `Login.tsx` / `Registration.tsx` (`touched` state, `validateField`, `show()` helper)
- Field-level validation: mobile phone min 6 chars if non-empty. Other 7 fields have no format validation. All fields optional — empty strings allowed and sent as `null`.
- Submit calls `updateMyProfile(contactId, payload)`. On success, in this exact order:
  1. Set `successMessage` state to "Profile updated."
  2. Update the local `profile` snapshot (so the form's diff calculation on the next save is correct)
  3. **Call `applyContactUpdateLocally(payload)`** — mirrors the saved name fields back into `window.Microsoft.Dynamic365.Portal.User`. **This is REQUIRED for the header to repaint** — without it, the header keeps showing the pre-save name until the user navigates to a route that triggers a full page load.
  4. **Call `refresh()` from `useAuth()`** — re-reads `Portal.User` (now mutated) into React state with a spread (the useAuth update above), which triggers a re-render of `AuthButton`. Without the spread, this is a no-op because `setState` with an identical reference is skipped by React.

  On error: show server error inline.
- **Set the browser tab title** — add a `useEffect` near the top of the component (matching the convention used on `Login.tsx`, `Registration.tsx`, `ForgotPassword.tsx`, `ResetPassword.tsx`, `RedeemInvitation.tsx`, `ExternalLoginConfirmation.tsx`, `Terms.tsx`, etc.):

  ```tsx
  useEffect(() => { document.title = 'My Profile — <SITE_NAME>' }, [])
  ```

  Substitute `<SITE_NAME>` with the actual site display name discovered in Phase 1 (the same value used in the other auth pages — e.g., `Contoso Portal`). Format MUST match the existing pages exactly: `<Page Title> — <Site Name>` (em-dash `—`, space on each side). Do NOT use `|`, `:`, or a hyphen.
- Use existing styles convention (CSS variables, card layout, max-width ~580)
- See `authentication-reference.md` "User Profile Page" section for the complete reference implementation

##### 5.1.9.c Evolve AuthButton to dropdown

Update `src/components/AuthButton.tsx`. **Make the dropdown shape the default for the authenticated state regardless of `INCLUDE_PROFILE_PAGE`** so the component is consistent and ready for future menu items:

- Anonymous state: unchanged — `<Link to="/login" className="btn-primary">Sign In</Link>`
- Authenticated state (NEW):
  - Trigger: `[Avatar] {displayName} ▾` — clickable
  - Menu (state-based, opened via `useState<boolean>`): renders when open
  - Menu items when `INCLUDE_PROFILE_PAGE = true`: "My Profile" (Link to `/user-profile`) + "Sign Out" (calls `logout('/')`)
  - Menu items when `INCLUDE_PROFILE_PAGE = false`: just "Sign Out"
  - `useEffect` listens for `mousedown` outside the dropdown container → close. Listens for `Escape` key → close. Cleanup on unmount.
  - "My Profile" link's `onClick` also closes the dropdown
  - ARIA: trigger has `aria-haspopup="menu"`, `aria-expanded={open}`; menu has `role="menu"`; items have `role="menuitem"`
  - Styling: menu uses existing CSS variables (`var(--color-surface)`, `var(--color-border)`, `var(--shadow-md)`, `var(--radius-sm)`)

##### 5.1.9.d Add route

Add to `src/App.tsx` — use **exactly this path** (`/user-profile`, NOT `/profile`):

```tsx
import UserProfile from './pages/UserProfile'
// ...inside <Routes>:
<Route path="/user-profile" element={<UserProfile />} />
```

> **⚠ DO NOT use `<Route path="/profile" ... />`.** The server reserves `/profile` for its legacy server-rendered page. Even though `ProfileRedirectEnabled` is set to `false` by this skill (which prevents the server from auto-redirecting users there after sign-in), creating a SPA route at the same path causes conflicts. Always use `/user-profile`.
>
> **Authentication gate**: the page itself handles the `!isAuthenticated` redirect to `/login?returnUrl=/user-profile` (see 5.1.9.b). If you have a `RequireAuth` wrapper component you prefer, you MAY use `<Route path="/user-profile" element={<RequireAuth><UserProfile /></RequireAuth>} />` — but only if the wrapper exists in the project already. Do not introduce a new `RequireAuth` component just for this page.

##### After save behavior

When `updateMyProfile` resolves successfully:
1. Set inline `successMessage` state ("Profile updated.") — green banner at top of form, dismissable
2. Call `useAuth().refresh()` — re-reads `window.Microsoft.Dynamic365.Portal.User`. Note that `Portal.User` is a snapshot from initial page load and won't have the new values until full page reload. So the right pattern is to also update local UI state (form fields stay as the user typed; header avatar may briefly show old initials until refresh propagates). Document this caveat in the reference.
3. Stay on the page — no auto-redirect.

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
- Registration page (e.g., `src/pages/Registration.tsx` for React) — when local auth AND `REGISTRATION_MODE` is not `Registration disabled` (always created in Open, Invitation-only, and Both modes)
- Forgot password page (e.g., `src/pages/ForgotPassword.tsx` for React) — only when local auth with reset password is configured
- Session keepalive hook (e.g., `src/hooks/useSessionKeepAlive.ts` for React) — integrated into Layout
- Terms page (e.g., `src/pages/Terms.tsx` for React) — only when terms are enabled
- Reset password page (e.g., `src/pages/ResetPassword.tsx` for React) — only when local auth with reset password is configured
- **Redeem invitation page (e.g., `src/pages/RedeemInvitation.tsx` for React) — only when `REGISTRATION_MODE` is `Invitation-only` or `Both`**
- **User profile page (e.g., `src/pages/UserProfile.tsx` for React) — only when `INCLUDE_PROFILE_PAGE = true`. Plus `getMyProfile` + `updateMyProfile` functions in `authService.ts`, AuthButton evolved to dropdown shape, `/user-profile` route in `App.tsx`.**
- Code-Site-Shell-Header template (`.powerpages-site/web-templates/code-site-shell-header/`) with redirect script — entries depend on enabled features (resetpassword, redeeminvitation)
- `website.yml` updated to point `headerwebtemplateid` to Code-Site-Shell-Header
- **Web API site settings (`Webapi/contact/enabled`, `Webapi/contact/fields`) — only when `INCLUDE_PROFILE_PAGE = true`**
- **Table permission `.powerpages-site/table-permissions/My-Profile-Edit-Own-Contact.tablepermission.yml` with `scope: 756150004` (Self) — only when `INCLUDE_PROFILE_PAGE = true`**

Read each file and verify it contains the expected exports and functions:

- Auth service: `login`, `logout`, `getCurrentUser`, `isAuthenticated`, `fetchAntiForgeryToken`, `parseServerErrors`, `register`, `forgotPassword` (when local auth), `TermsRequiredError`, `acceptTerms` (when terms enabled), `redeemInvitation` and `fetchInvitationDetails` (when invitation modes), `loginLocal` accepts `invitationCode` parameter (when invitation modes)
- Authorization utils: `hasRole`, `hasAnyRole`, `hasAllRoles`, `getUserRoles`
- Login and registration pages: validate-on-blur pattern with `touched` state, `handleBlur`, `handleChange`, `showError` helper. Both must catch `TermsRequiredError` and navigate to `/terms` (when terms enabled). Login page must read `invitationCode` from URL and show info banner + pass through (when invitation modes). Registration page must call `fetchInvitationDetails()` to pre-fill email (when invitation modes).
- Redeem invitation page (when invitation modes): pre-fills code from URL, has "Sign in with an existing account instead of registering" checkbox, branches to `/registration` or `/login` based on `redeemInvitation()` result
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

**Use the ProviderName directly as the CallbackPath suffix** — this is deterministic and guarantees uniqueness because ProviderName is already unique (per the `{ProviderName}` naming convention: `OpenIdConnect_1`, `OpenIdConnect_2`, `EntraExternalId`, etc.).

**For every OIDC provider** (including Entra External ID), use this exact pattern:

- `CallbackPath` = `/signin-{ProviderName-lowercased}` (e.g., `/signin-entraexternalid`, `/signin-openidconnect_1`)
- `RedirectUri` = `{site-url}/signin-{ProviderName-lowercased}` (must match CallbackPath exactly)

Example for two OIDC providers:

| ProviderName | CallbackPath | RedirectUri |
|--------------|--------------|-------------|
| `EntraExternalId` | `/signin-entraexternalid` | `https://contoso.powerappsportals.com/signin-entraexternalid` |
| `OpenIdConnect_1` (Okta) | `/signin-openidconnect_1` | `https://contoso.powerappsportals.com/signin-openidconnect_1` |

**Before creating** site settings, read existing `.powerpages-site/site-settings/` and verify no other `Authentication/OpenIdConnect/*/CallbackPath` or `RedirectUri` setting has the same value. If a collision exists (because the same ProviderName was reused), increment the numeric suffix on the ProviderName (e.g., `OpenIdConnect_1` → `OpenIdConnect_2`) and re-derive the CallbackPath.

**Tell the user to register the exact RedirectUri** in their identity provider's app registration (Microsoft Entra admin center → App registrations → Redirect URIs).

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

**Profile mapping settings** — for **every** external provider (OIDC, SAML2, WS-Federation, social), write `RegistrationClaimsMapping` based on `PROFILE_MAPPING_CHOICE` from Phase 2.1, and `LoginClaimsMapping` when `PROFILE_SYNC_FREQUENCY = "Both"`:

```powershell
# Skip if PROFILE_MAPPING_CHOICE = "None"
# Generate the value based on PROFILE_MAPPING_CHOICE:
#   "Standard"           → firstname=given_name,lastname=family_name,emailaddress1=email
#   "Standard + phone"   → firstname=given_name,lastname=family_name,emailaddress1=email,mobilephone=phone_number
#   "Custom"             → user-provided comma-separated pairs
# For SAML2/WsFed, use the claim URI form instead of OIDC short names.

node "${CLAUDE_PLUGIN_ROOT}/scripts/create-site-setting.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --name "Authentication/{Type}/{ProviderName}/RegistrationClaimsMapping" \
  --value "firstname=given_name,lastname=family_name,emailaddress1=email" \
  --description "Map IdP claims to contact fields on first sign-in"

# Only write if PROFILE_SYNC_FREQUENCY = "Both"
node "${CLAUDE_PLUGIN_ROOT}/scripts/create-site-setting.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --name "Authentication/{Type}/{ProviderName}/LoginClaimsMapping" \
  --value "firstname=given_name,lastname=family_name,emailaddress1=email" \
  --description "Map IdP claims to contact fields on every login"
```

**Contact linking setting** — write `AllowContactMappingWithEmail` based on `CONTACT_LINKING_CHOICE`:

```powershell
# CONTACT_LINKING_CHOICE = "Link to existing"  → value "true"
# CONTACT_LINKING_CHOICE = "Create new"        → value "false" (or skip — false is the server default)
node "${CLAUDE_PLUGIN_ROOT}/scripts/create-site-setting.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --name "Authentication/{Type}/{ProviderName}/AllowContactMappingWithEmail" \
  --value "<true-or-false-from-choice>" \
  --description "Auto-link external sign-in to existing contact by email match" \
  --type boolean
```

> **Multi-tenant guard**: Before writing `AllowContactMappingWithEmail=true` for an OIDC provider, check the Authority URL. If it contains `/organizations/`, `/common/`, or if `IssuerFilter` is set to a wildcard pattern, **override the user's choice to `false`** and tell the user: "Multi-tenant Entra External ID configurations cannot use contact mapping for security reasons (the server forcibly disables it). To enable contact mapping, use a single-tenant Authority URL with a specific tenant GUID."

**Per-provider `RegistrationEnabled` setting** — for **every** external provider (OIDC, SAML2, WS-Federation, social), also write:

```powershell
node "${CLAUDE_PLUGIN_ROOT}/scripts/create-site-setting.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --name "Authentication/{Type}/{ProviderName}/RegistrationEnabled" \
  --value "true" \
  --description "Allow new users to register via this specific provider" \
  --type boolean
```

Where `{Type}` is `OpenIdConnect`, `SAML2`, `WsFederation`, or `OpenAuth`. This is a **per-provider toggle** that's distinct from the global `Authentication/Registration/ExternalLoginEnabled` — set both to `true` for registration to work. Use case for setting one provider's `RegistrationEnabled=false`: temporarily block new users from a given IdP while still letting existing users sign in.

**Logout settings — conditional on Phase 2.1.1 logout mode choice**

For external providers, write logout settings only when the user picked **"Federated logout"** in Phase 2.1.1. If they picked "Local logout only" (the default), write neither setting — the server defaults (`RPInitiatedLogout=false`, `ExternalLogoutEnabled=false`) handle this correctly.

```powershell
# Only when LOGOUT_MODE = "Federated logout"
node "${CLAUDE_PLUGIN_ROOT}/scripts/create-site-setting.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --name "Authentication/OpenIdConnect/{ProviderName}/RPInitiatedLogout" \
  --value "true" \
  --description "Federated logout — call IdP end_session_endpoint with id_token_hint" \
  --type boolean

# REQUIRED when RPInitiatedLogout=true — must be paired
node "${CLAUDE_PLUGIN_ROOT}/scripts/create-site-setting.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --name "Authentication/OpenIdConnect/{ProviderName}/PostLogoutRedirectUri" \
  --value "<POST_LOGOUT_REDIRECT_URI from Phase 2.1.1>" \
  --description "URL the IdP redirects to after federated logout completes"
```

For SAML2 / WS-Federation / social providers, the equivalent settings names differ — `Authentication/{Type}/{ProviderName}/RPInitiatedLogout` and `/PostLogoutRedirectUri` follow the same naming pattern. For social providers (Microsoft Account / Facebook / Google), federated logout is usually not supported by the provider, so the question is moot — skip the logout-mode question for social and don't write either setting.

> **Server behavior reminder**: Without these settings (i.e., "Local logout only" mode), `/Account/Login/LogOff` clears the Power Pages session and redirects to the `returnUrl` query parameter (or site root if missing/invalid). The IdP session stays warm — next sign-in is silent SSO. **No app-registration changes needed in this mode.**
>
> With these settings ("Federated logout"), `/Account/Login/LogOff` 302s to the IdP's `end_session_endpoint` with `id_token_hint` and `post_logout_redirect_uri`. The IdP signs the user out and redirects to the registered post-logout URI. **The maker MUST also register that URI in the IdP app registration** (see Phase 2.1.1) — confirmed via HAR analysis that without app-registration of the front-channel logout URL, the IdP silently drops the parameter and users get stranded.

**Provider-specific settings** — create site settings for **EACH** provider selected in Phase 2.1. If the user selected multiple providers (e.g., Entra External ID + Local Authentication), create settings for ALL of them:

**Microsoft Entra ID** — Authority, ClientId, Metadata, etc. are auto-configured by Power Pages on site creation (provider name `AzureAD`). However, **always write claims mapping settings** so first-time-sign-in contacts get firstname/lastname/email populated. The auto-configured AzureAD provider does NOT have claims mapping by default — without these settings, new contacts are created with the user's `oid` linked but every other field empty (verified empirically: workforce Entra ID v1.0 tokens don't include the `email` claim, and the server doesn't auto-derive contact fields from `given_name`/`family_name` claims unless an explicit mapping is configured).

```powershell
# RegistrationClaimsMapping — applied once at first sign-in, before contact is created.
# Uses `upn` for email because workforce Entra ID v1.0 tokens don't include the `email`
# claim by default. UPN (user principal name, e.g. user@contoso.com) is the standard
# substitute and matches what the user expects in their profile.
node "${CLAUDE_PLUGIN_ROOT}/scripts/create-site-setting.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --name "Authentication/OpenIdConnect/AzureAD/RegistrationClaimsMapping" \
  --value "firstname=given_name,lastname=family_name,emailaddress1=upn" \
  --description "Map AzureAD claims to contact fields on first sign-in (UPN as email — workforce v1.0 tokens lack email claim)"

# LoginClaimsMapping — applied every sign-in. Updates contact fields if user info
# changes in Entra (e.g., name change). Same mapping as Registration; safe to write
# both for consistency.
node "${CLAUDE_PLUGIN_ROOT}/scripts/create-site-setting.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --name "Authentication/OpenIdConnect/AzureAD/LoginClaimsMapping" \
  --value "firstname=given_name,lastname=family_name,emailaddress1=upn" \
  --description "Re-apply claim mapping on every sign-in so contact fields stay in sync with Entra"
```

> **Why `upn` and not `email`?** Workforce Entra ID's OIDC endpoint defaults to v1.0 tokens (issuer `sts.windows.net/{tid}/`) which do NOT include the `email` claim by default. To get the `email` claim, the app registration would need to be configured for v2.0 tokens AND request the `email` scope AND the user must have a verified email address in their Entra profile (none of which is the default). The `upn` claim, however, is always emitted for workforce users — it's the user principal name (e.g., `user@contoso.com`) which functions as the email for most workforce scenarios. This applies ONLY to workforce Entra ID (the auto-configured `AzureAD` provider). **Entra External ID uses v2.0 tokens with proper `email` claim — its mapping should be `emailaddress1=email`, NOT `emailaddress1=upn`** (see the Profile mapping question in Phase 2.1 for External ID).

> **No question is asked for this.** Unlike other external providers where the Profile mapping question (Track B) is part of Phase 2.1, the Entra ID mapping is written silently because (a) workforce Entra IS deterministic on which claim is the right substitute for email (always `upn`), and (b) without this mapping the contact is created broken, so opting out doesn't make sense.

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

# RedirectUri — use /signin-{ProviderName-lowercased} for guaranteed uniqueness
node "${CLAUDE_PLUGIN_ROOT}/scripts/create-site-setting.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --name "Authentication/OpenIdConnect/{ProviderName}/RedirectUri" \
  --value "<site-url>/signin-{ProviderName-lowercased}" \
  --description "OAuth callback URL — unique per provider (matches CallbackPath)"

# CallbackPath — required to prevent collision when multiple OIDC providers exist
# OWIN defaults ALL OIDC providers to /signin-oidc
node "${CLAUDE_PLUGIN_ROOT}/scripts/create-site-setting.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --name "Authentication/OpenIdConnect/{ProviderName}/CallbackPath" \
  --value "/signin-{ProviderName-lowercased}" \
  --description "Unique callback path derived from ProviderName"

```

> **Note:** The `AuthenticationType` value is the unique provider identifier used in the `ExternalLogin` form POST. This value must match what `resolveProviderIdentifier()` returns in the auth service.

> **Logout settings** — do NOT auto-write `RPInitiatedLogout` or `ExternalLogoutEnabled` here. Both default to `false` server-side (per `StartupSettingsManager.cs:418,425`), which means logout clears only the Power Pages session and leaves the IdP session intact (user can silently SSO back in). This is the simpler default and what most sites want. If the user wants **federated logout** (sign out at the IdP too, with `post_logout_redirect_uri` redirecting back to the site), they configure it via the advanced settings flow in Phase 2.1.1 — which writes BOTH `RPInitiatedLogout=true` AND `PostLogoutRedirectUri={SITE_URL}/` together (one without the other leaves users stranded on the IdP's signed-out page — see Phase 2.1.1 for the full walkthrough).

**Entra External ID** — uses values from the 4-step walkthrough in Phase 2.1. Derive `Authority` and `MetadataAddress` from the tenant subdomain + tenant ID — do not ask the user to paste them:

- `Authority` = `https://{EXTERNAL_ID_TENANT_SUBDOMAIN}.ciamlogin.com/{EXTERNAL_ID_TENANT_ID}` — **NO trailing `/v2.0/`**. Entra External ID uses the bare tenant path (different from classic B2C and from generic OIDC providers like Okta which often need `/v2.0/`).
- `MetadataAddress` = `https://{EXTERNAL_ID_TENANT_SUBDOMAIN}.ciamlogin.com/{EXTERNAL_ID_TENANT_ID}/v2.0/.well-known/openid-configuration`
- `AuthenticationType` = same as `Authority` (provider identifier in ExternalLogin POST must match)
- `ClientId` = `EXTERNAL_ID_CLIENT_ID` from Step 2 of walkthrough
- `RedirectUri` = `{SITE_URL}/signin-{ProviderName-lowercased}` — same Redirect URI shown to user in Step 2

```powershell
# Authority — derived: https://{subdomain}.ciamlogin.com/{tenantId}
# (do NOT append /v2.0/ — that breaks Entra External ID)
node "${CLAUDE_PLUGIN_ROOT}/scripts/create-site-setting.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --name "Authentication/OpenIdConnect/{ProviderName}/Authority" \
  --value "https://<EXTERNAL_ID_TENANT_SUBDOMAIN>.ciamlogin.com/<EXTERNAL_ID_TENANT_ID>" \
  --description "Entra External ID authority URL (derived)"

# MetadataAddress — derived: Authority + /v2.0/.well-known/openid-configuration
node "${CLAUDE_PLUGIN_ROOT}/scripts/create-site-setting.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --name "Authentication/OpenIdConnect/{ProviderName}/MetadataAddress" \
  --value "https://<EXTERNAL_ID_TENANT_SUBDOMAIN>.ciamlogin.com/<EXTERNAL_ID_TENANT_ID>/v2.0/.well-known/openid-configuration" \
  --description "OIDC metadata document URL (derived)"

# ClientId — from walkthrough Step 2
node "${CLAUDE_PLUGIN_ROOT}/scripts/create-site-setting.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --name "Authentication/OpenIdConnect/{ProviderName}/ClientId" \
  --value "<EXTERNAL_ID_CLIENT_ID>" \
  --description "Application client ID"

# AuthenticationType — must match Authority exactly (used as the 'provider' form value in ExternalLogin POST)
node "${CLAUDE_PLUGIN_ROOT}/scripts/create-site-setting.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --name "Authentication/OpenIdConnect/{ProviderName}/AuthenticationType" \
  --value "https://<EXTERNAL_ID_TENANT_SUBDOMAIN>.ciamlogin.com/<EXTERNAL_ID_TENANT_ID>" \
  --description "Provider identifier for ExternalLogin — must match Authority exactly"

# RedirectUri — the full URI the maker registered in their Entra app.
# Confirmed/customized by user in Step 2 of walkthrough (stored as REDIRECT_URI).
node "${CLAUDE_PLUGIN_ROOT}/scripts/create-site-setting.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --name "Authentication/OpenIdConnect/{ProviderName}/RedirectUri" \
  --value "<REDIRECT_URI>" \
  --description "OAuth callback URL (must match the URI registered in the app registration)"

# CallbackPath — derived from RedirectUri (just the path portion, extracted via
# new URL(REDIRECT_URI).pathname). Required to prevent CallbackPath collision when
# multiple OIDC providers exist (OWIN defaults all OIDC to /signin-oidc otherwise).
# The maker doesn't see this separately — the skill writes it automatically.
node "${CLAUDE_PLUGIN_ROOT}/scripts/create-site-setting.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --name "Authentication/OpenIdConnect/{ProviderName}/CallbackPath" \
  --value "<path-portion-of-REDIRECT_URI>" \
  --description "OWIN callback path (derived from RedirectUri)"

```

> **Logout settings for Entra External ID** — do NOT auto-write `RPInitiatedLogout` or `ExternalLogoutEnabled` here. Both default to `false` server-side. Default behavior: logout clears the Power Pages session only; user stays signed in at the Entra External ID tenant. Next sign-in is silent SSO via the IdP's cookie. This is the simpler default and matches what most customer-facing sites want. **If the user wants federated logout** (sign out at Entra External ID too), they enable it via the advanced settings flow in Phase 2.1.1 — which writes BOTH `RPInitiatedLogout=true` AND `PostLogoutRedirectUri={SITE_URL}/` together AND adds an app-registration step for the Front-channel logout URL.

> **Custom domains**: If the user is using a custom domain for their Entra External ID tenant (e.g., `https://login.contoso.com/{tenantId}/v2.0/`) instead of `*.ciamlogin.com`, replace the derived values above with the custom domain values. The walkthrough in Phase 2.1 doesn't currently ask about custom domains — when re-running with a custom-domain Authority in existing site settings (Phase 1.5 discovery), preserve those values rather than rebuilding from `EXTERNAL_ID_TENANT_SUBDOMAIN`.

> **NO ClientSecret block for Entra External ID by default.** Public clients using PKCE don't need a client secret — the walkthrough explicitly does not ask for one. **Skip Phase 8.1.1 (Key Vault) entirely for this provider.** If a confidential-client scenario requires a secret post-deploy, document it as an advanced manual step in Phase 8.5 (add via Power Pages admin center → Authentication settings).

> **User flow name (`EXTERNAL_ID_USER_FLOW`) is NOT written as a site setting.** Entra External ID attaches the user flow to the app registration itself, so the user flow runs automatically on sign-in without Power Pages needing to reference it by name in URL/metadata (unlike classic B2C). The walkthrough captures it only to confirm the user has created one. If the user later configures separate password-reset or profile-edit user flows, they can add `PasswordResetPolicyId` / `ProfileEditPolicyId` site settings manually as advanced overrides.

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

**Local Authentication** — write these settings based on the user's choices from Phase 2.1.

**Settings always written (regardless of registration mode):**

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
  --name "Authentication/Registration/ResetPasswordEnabled" \
  --value "true" \
  --description "Enable forgot password flow for local accounts" \
  --type boolean
```

**Registration mode settings** — deterministic mapping from `REGISTRATION_MODE`:

| `REGISTRATION_MODE` | `Authentication/Registration/Enabled` | `Authentication/Registration/OpenRegistrationEnabled` | `Authentication/Registration/InvitationEnabled` |
|---|---|---|---|
| Open registration only | `true` | `true` | `false` |
| Invitation-only | `true` | `false` | `true` |
| Both | `true` | `true` | `true` |
| Registration disabled | `false` | (skip — moot) | (skip — moot) |

> **Do NOT create the `Authentication/Registration/RequireInvitationCode` setting.** It does not exist on the server (the server never reads it). The invitation-only behavior is enforced entirely by `OpenRegistrationEnabled = false` + `InvitationEnabled = true`. Earlier versions of this skill wrote this setting — if you find it in the project's site settings (`.powerpages-site/site-settings/Authentication-Registration-RequireInvitationCode.sitesetting.yml`), **delete the file** as part of the setup.

Example (write each setting that applies — skip Enabled/OpenReg/Invitation when mode is `Registration disabled` except `Enabled=false`):

```powershell
# For all modes EXCEPT "Registration disabled":
node "${CLAUDE_PLUGIN_ROOT}/scripts/create-site-setting.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --name "Authentication/Registration/Enabled" \
  --value "true" \
  --description "Master switch: registration is enabled" \
  --type boolean

node "${CLAUDE_PLUGIN_ROOT}/scripts/create-site-setting.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --name "Authentication/Registration/OpenRegistrationEnabled" \
  --value "<true-or-false-from-mode>" \
  --description "Allow self-registration without an invitation" \
  --type boolean

node "${CLAUDE_PLUGIN_ROOT}/scripts/create-site-setting.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --name "Authentication/Registration/InvitationEnabled" \
  --value "<true-or-false-from-mode>" \
  --description "Enable invitation-based registration" \
  --type boolean

# For "Registration disabled" mode ONLY:
node "${CLAUDE_PLUGIN_ROOT}/scripts/create-site-setting.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --name "Authentication/Registration/Enabled" \
  --value "false" \
  --description "Disable all registration (only existing users can sign in)" \
  --type boolean
```

**CAPTCHA settings** — conditional on mode:

| `REGISTRATION_MODE` | `CaptchaEnabled` / `IsCaptchaEnabledForRegistration` | Reason |
|---|---|---|
| Open registration only / Both | `false` (with note) | The SPA registration form cannot render the server-side CAPTCHA widget — leaving it on causes registration to silently fail. For production, the site owner should add their own client-side CAPTCHA solution and re-enable the server setting. |
| Invitation-only | `false` | Invitations already filter users — CAPTCHA adds friction without security value. |
| Registration disabled | (skip — registration is off) | — |

```powershell
node "${CLAUDE_PLUGIN_ROOT}/scripts/create-site-setting.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --name "Authentication/Registration/CaptchaEnabled" \
  --value "false" \
  --description "Disable server-rendered CAPTCHA — SPA cannot render the widget" \
  --type boolean

node "${CLAUDE_PLUGIN_ROOT}/scripts/create-site-setting.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --name "Authentication/Registration/IsCaptchaEnabledForRegistration" \
  --value "false" \
  --description "Disable server-rendered CAPTCHA on registration form" \
  --type boolean
```

**Web API for contact entity — conditional on `INCLUDE_PROFILE_PAGE = true`**

When the maker opted into the profile page (Phase 2.1), enable Web API on the `contact` entity. These settings tell the Power Pages server which entity + fields are reachable via `/_api/{entity}` so the SPA's `getMyProfile` and `updateMyProfile` can read and write the user's contact record.

> **⚠ MANDATORY value for `Webapi/contact/fields`** — use this complete string verbatim. The executor MUST NOT trim it. All 9 entries must be present so the profile form can read AND write every editable field:
>
> ```
> contactid,firstname,lastname,mobilephone,address1_line1,address1_city,address1_stateorprovince,address1_postalcode,address1_country
> ```
>
> This is `contactid` (for record identification) + the 8 editable fields listed in Phase 2.1 / Phase 5.1.9.b. **`emailaddress1` is NOT in this list** because email is displayed read-only in the Account Details section, sourced from `useAuth().user.email` — no Web API roundtrip needed for it. **`middlename` is NOT in this list** because it's intentionally excluded from the simple form. Skipping any entry from the list above causes the corresponding form input to silently fail with a 403 from the Web API.

```powershell
# Enable Web API on the contact table
node "${CLAUDE_PLUGIN_ROOT}/scripts/create-site-setting.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --name "Webapi/contact/enabled" \
  --value "true" \
  --description "Enable Web API access for contact table (profile page)" \
  --type boolean

# Allowed fields — USE THE EXACT VALUE BELOW (9 entries, all lowercase)
# Case-sensitive: PascalCase or Title Case produces 403 even if the column exists
node "${CLAUDE_PLUGIN_ROOT}/scripts/create-site-setting.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --name "Webapi/contact/fields" \
  --value "contactid,firstname,lastname,mobilephone,address1_line1,address1_city,address1_stateorprovince,address1_postalcode,address1_country" \
  --description "Fields allowed via Web API for profile page (read + write)"
```

> **Field name format**: all entries in the `fields` value MUST be lowercase Dataverse LogicalNames. The Web API does case-sensitive literal matching — `FirstName` or `Firstname` will produce a 403 Forbidden response from the server even though the column exists. The list above is correct.
>
> **Customizing the field list LATER**: if the maker has custom contact columns they want to expose on the profile page (e.g., `cr123_jobtitle`), they can extend this `fields` value AND add the matching field to the `ProfileContact` interface + form in `UserProfile.tsx` AFTER the skill finishes. The skill itself MUST ship with exactly the 9 entries above — do not add or remove entries during scaffolding.

#### 8.1.x Create Table Permission for Contact (When INCLUDE_PROFILE_PAGE = true)

**Conditional on `INCLUDE_PROFILE_PAGE = true`.** Skip otherwise.

Enabling Web API for the contact table is NOT sufficient — the Power Pages server also requires a matching `adx_entitypermission` record granting the signed-in user read/write access. Without it, all `/_api/contacts(...)` calls return 403 even when the site settings allow the entity.

For the profile-page use case, **Self scope (`756150004`)** is the correct choice — it grants access only to the user's own contact record. The `create-table-permission.js` script validates this and rejects Contact scope for the contact table itself.

**Step 1 — Discover the Authenticated Users web role UUID.**

Phase 1.4 already inventoried web roles. Find the role with `authenticatedusersrole: true` in `.powerpages-site/web-roles/*.yml`. Typical filename: `Authenticated-Users.webrole.yml`. Extract its `id` field.

If no such role exists, warn the user:

> "No 'Authenticated Users' web role found on this site. Profile editing won't work for any user until a role with `authenticatedusersrole: true` exists and is assigned to users. Run `/create-webroles` to add one, then re-run this skill."

Skip the rest of this phase if no role found.

**Step 2 — Create the table permission.**

```powershell
node "${CLAUDE_PLUGIN_ROOT}/scripts/create-table-permission.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --permissionName "My Profile - Edit Own Contact" \
  --tableName "contact" \
  --webRoleIds "<authenticated-users-role-uuid>" \
  --scope "Self" \
  --read \
  --write
```

The script will create `.powerpages-site/table-permissions/My-Profile-Edit-Own-Contact.tablepermission.yml`:

```yaml
adx_entitypermission_webrole:
- <authenticated-users-role-uuid>
append: false
appendto: false
create: false
delete: false
entitylogicalname: contact
entityname: My Profile - Edit Own Contact
id: <generated-uuid>
read: true
scope: 756150004
write: true
```

Note: `create: false` + `delete: false` — users can read and update their own contact but NOT create new contacts or delete existing ones. This is the principle-of-least-privilege default for profile editing.

**Permission boundary verification**: with Self scope, even if a user crafts a malicious request like `PATCH /_api/contacts({someone-elses-contact-id})` from DevTools, the server returns 403. Self scope enforces row-level security based on the signed-in user's `contactid` from the session cookie.

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
- **Entra External ID** — **NO by default.** The Phase 2.1 walkthrough configures Entra External ID as a public client using PKCE (no client secret). **Always skip this section for Entra External ID.** If a user later needs a confidential-client setup with a secret, they add `ClientSecret` manually via the Power Pages admin center — covered in Phase 8.5 post-deploy notes.
- **Microsoft Account / Facebook / Google** — yes (social OAuth requires app secret)
- **SAML2 / WS-Federation** — no (certificate-based, not secrets)
- **Local Authentication** — no
- **Microsoft Entra ID** — no (configured via Power Pages admin center)

**If no provider requires a secret, skip this entire phase 8.1.1 and proceed to the invitation block.**

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

**Two-Factor Authentication** — **NOT supported.** The skill must NOT create `Authentication/Registration/TwoFactorEnabled`, `Authentication/Registration/RememberMeEnabled`, or `Authentication/Registration/RememberBrowserEnabled` site settings. Power Pages' built-in 2FA flow uses server-rendered `/Account/Login/SendCode` and `/Account/Login/VerifyCode` pages — the 2FA token state lives in server-side cookies between the credential POST and the code-verification POST, and there's no SPA-equivalent UI we can ship. If 2FA is needed, recommend the user enable it at the identity provider layer (Entra External ID conditional access, B2C user flow MFA, Auth0 Guardian, Okta Verify, etc.) — IdP-level 2FA is transparent to Power Pages and keeps the entire UX inside the IdP's branded experience.

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
| Registration Page | `src/pages/Registration.tsx` (or framework equivalent) — local auth, not disabled | Created (if applicable) |
| Redeem Invitation Page | `src/pages/RedeemInvitation.tsx` (or framework equivalent) — `Invitation-only` or `Both` modes | Created (if applicable) |
| Forgot Password Page | `src/pages/ForgotPassword.tsx` (or framework equivalent) — local auth only | Created (if applicable) |
| Session KeepAlive | `src/hooks/useSessionKeepAlive.ts` (or framework equivalent) — integrated in Layout | Created |
| Terms Page | `src/pages/Terms.tsx` (or framework equivalent) — when terms enabled | Created (if applicable) |
| Terms Snippet | `Account/Signin/TermsAndConditionsCopy` content snippet | Created (if applicable) |
| Reset Password Page | `src/pages/ResetPassword.tsx` (or framework equivalent) — local auth only | Created (if applicable) |
| User Profile Page | `src/pages/UserProfile.tsx` (or framework equivalent) — when `INCLUDE_PROFILE_PAGE = true`. Plus AuthButton dropdown, `getMyProfile`/`updateMyProfile` in authService, `/user-profile` route | Created (if applicable) |
| Shell Header | `Code-Site-Shell-Header` web template — redirects server auth pages to SPA | Created (survives uploads) |
| Site Setting | `ProfileRedirectEnabled = false`, `Enabled`, `OpenRegistrationEnabled`, `InvitationEnabled` per registration mode | Created |
| Web API Site Settings | `Webapi/contact/enabled = true`, `Webapi/contact/fields = ...` — when `INCLUDE_PROFILE_PAGE = true` | Created (if applicable) |
| Table Permission | `My Profile - Edit Own Contact` (contact, Self scope, read+write, Authenticated Users role) — when `INCLUDE_PROFILE_PAGE = true` | Created (if applicable) |

#### 8.3.5 Generate HTML Setup Report

After the summary, generate an HTML setup report at `<PROJECT_ROOT>/docs/auth-setup-report.html` that captures every decision and artifact from this run. The report is opened in the user's browser as a durable, shareable record they can review later.

**Why**: This skill makes many composing decisions (provider choice, registration mode, profile mapping, contact linking, profile page, terms, federated logout, etc.). A side-by-side HTML report makes it easy for the maker to audit the full configuration in one place — much more scannable than the chat summary above. It also gives reviewers and teammates a single artifact to look at without re-running the skill.

**1. Build the data payload.** Construct a JSON object with the following keys and write it to a temp file:

```json
{
  "META_DATA": {
    "siteName": "<SITE_NAME>",
    "reportDate": "<YYYY-MM-DD>",
    "framework": "<React|Vue|Angular|Astro>",
    "nextStepsHtml": "<HTML string — the same provider-specific guidance from 8.5, formatted as an <ol>>"
  },
  "PROVIDERS_DATA": [
    {
      "type": "Entra ID | Entra External ID | OIDC | SAML2 | WS-Federation | Local | Social (Microsoft|Facebook|Google)",
      "displayName": "<friendly name shown in the login UI>",
      "name": "<ProviderName used in site setting keys>",
      "identifier": "<providerIdentifier / authority URL / issuer URI>",
      "authority": "<Authority site-setting value, if applicable>",
      "clientId": "<ClientId site-setting value, if applicable>",
      "redirectUri": "<Computed redirect URI, if applicable>",
      "scopes": "<Scopes site-setting value, if applicable>",
      "registrationClaimsMapping": "<RegistrationClaimsMapping value, if applicable>",
      "loginClaimsMapping": "<LoginClaimsMapping value, or null when sync = First sign-in only>",
      "contactLinking": "Link to existing contact by email | Create a new contact",
      "profileSync": "First sign-in only | Both",
      "federatedLogout": "Enabled | Disabled",
      "isPrimary": true | false
    }
  ],
  "LOCAL_AUTH_DATA": {
    "loginBy": "Email | Username",
    "registrationMode": "Open | Invitation-only | Both | Disabled",
    "resetPasswordEnabled": true | false,
    "emailConfirmationEnabled": true | false
  },
  "OPTIONAL_FEATURES_DATA": {
    "profilePage": true | false,
    "termsAndConditions": true | false,
    "termsEnforced": true | false,
    "federatedLogout": true | false,
    "sessionKeepAlive": true | false
  },
  "SITE_SETTINGS_DATA": [
    { "name": "Authentication/Registration/ProfileRedirectEnabled", "value": "false" }
  ],
  "TABLE_PERMISSIONS_DATA": [
    { "name": "My Profile - Edit Own Contact", "table": "contact", "scope": "Self (756150004)", "read": true, "write": true, "create": false, "delete": false }
  ],
  "FILES_DATA": [
    { "path": "src/services/authService.ts", "action": "Created | Updated", "notes": "<short description>" }
  ]
}
```

- Set `LOCAL_AUTH_DATA` to `null` if local auth was not configured.
- Include ALL site settings the skill created in `SITE_SETTINGS_DATA` (Phase 8.1) — `ProfileRedirectEnabled`, every `Authentication/{Type}/{Name}/...` block, `Webapi/contact/*` when applicable, etc. Mask any settings whose name contains `Secret` (replace value with `***` — secrets must not appear in the report).
- Include every YAML/code file the skill created or updated in `FILES_DATA`. Use action `"Created"` for new files, `"Updated"` for edits.
- `nextStepsHtml` should mirror the guidance in section 8.5 below, formatted as an `<ol>...</ol>` with `<code>` tags around commands. Only include the steps relevant to the providers actually configured.

**2. Render the report.** Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/render-auth-report.js" \
  --output "<PROJECT_ROOT>/docs/auth-setup-report.html" \
  --data "<path-to-temp-data.json>"
```

The renderer refuses to overwrite an existing file. If a previous report already exists at that path, append a date suffix: `auth-setup-report-2026-05-27.html`.

**3. Open the report in the browser** (best-effort — never block the skill flow on this):

- Windows: `start "" "<PROJECT_ROOT>/docs/auth-setup-report.html"`
- macOS: `open "<PROJECT_ROOT>/docs/auth-setup-report.html"`
- Linux: `xdg-open "<PROJECT_ROOT>/docs/auth-setup-report.html"`

**4. Tell the user** the absolute path of the report file so they can open it manually if the browser launch failed. Phrasing example: *"I've written a full setup report to `<path>` and opened it in your browser. You can revisit this file any time to see every decision and artifact from this run."*

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
- **Auth failure handling (keep users in SPA)**: When OIDC/SAML2/WS-Fed auth fails, the server redirects to `/Account/Login/ExternalAuthenticationFailed` — a server-rendered page that breaks the SPA. To keep users in the SPA on failure, edit the Dataverse content snippets `Account/Register/ExternalAuthenticationFailed` and `Account/Register/ExternalAuthenticationFailed/AccessDenied` in the Power Pages admin center to inject a `<script>` that redirects to `/login?message={error-code}`. The SPA's `getAuthError()` will then display the error inline. See authentication-reference.md for the exact script.
- **User profile display**: After login, the auth service's `getUserDisplayName()` falls back through `firstName + lastName` → `firstName` → `lastName` → `email` → `userName` → `'User'`. **Email beats userName** because for external providers (Entra External ID, OIDC) the `userName` field is the OIDC subject identifier — a long opaque string like `vs25QwNe1ZAHqlWK1Naw9dVEBe-TbF5tZEpb0XjAEZQ` that's ugly and meaningless in a navigation bar. Power Pages populates `firstName`/`lastName`/`email` from standard OIDC claims (`given_name`, `family_name`, `email`). Entra External ID user flows often don't include `given_name`/`family_name` in the returned claims by default — if you want names populated, ensure the user flow has both attributes selected under "User attributes to collect" AND "Application claims" / "User attributes to return as claims" (see Phase 2.1 Entra External ID Step 3). The `email` claim is almost always emitted, so emails reliably populate even when names don't. `getUserInitials()` follows the same priority chain using the first character of each fallback source.
- **Two-Factor Authentication**: This skill does NOT scaffold Power Pages built-in 2FA — the `SendCode`/`VerifyCode` flow is server-rendered and cannot be integrated into the SPA experience. For MFA needs, configure it at the identity provider layer (Entra External ID conditional access, B2C user flow MFA, Auth0 Guardian, Okta Verify, etc.) — IdP-level MFA is transparent to Power Pages and stays inside the IdP's branded experience.
- **Invitation-based registration**: If invitations are enabled (`REGISTRATION_MODE` is `Invitation-only` or `Both`), generate invitation codes by creating Invitation records in Dataverse (`adx_invitation` table) — the `adx_invitationcode` field is the value to use in the URL. Share invitation links in the format `{site-url}/Account/Login/RedeemInvitation?invitation={code}` — the Code-Site-Shell-Header script redirects this to the SPA `/redeem-invitation?invitation={code}` route automatically. After redemption, the invitation is linked to the user's contact (single-redemption invitations are marked redeemed; group invitations track redeemed contacts in a collection). Terms acceptance and external login flows preserve the invitation code through the auth flow.
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
