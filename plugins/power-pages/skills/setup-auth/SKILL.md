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
  "enable 2FA", "set up invitation login", or otherwise wants to set up
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

Also distinguish **Entra External ID** from generic **OIDC** by looking at the Authority URL pattern:
- `*.ciamlogin.com/*` or `login.microsoftonline.com/{guid}/*` with a `RPInitiatedLogout=true` setting → **Entra External ID**
- Any other OIDC authority → **OIDC (Generic)**

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
| What should the login button label say? Default is **`Sign in with Microsoft Entra External ID`**. Do NOT use "Sign in with Microsoft" — that conflicts with the Microsoft Account social provider. | *(free text, defaulted)* |

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
| Should profile info be updated on every login, or only once at first sign-in? | Sync frequency | Both — sync on first sign-in AND every login (Recommended for IdPs as source of truth), First sign-in only — let users edit their profile after registration without it being overwritten |

Store as `PROFILE_SYNC_FREQUENCY`. This determines whether to write `LoginClaimsMapping` (every login) in addition to `RegistrationClaimsMapping` (first sign-in only).

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
| If a user signs in with an external provider and their email matches an existing Dataverse contact, what should happen? | Contact linking | Create a new contact (Recommended for security) — always create a fresh contact, never auto-link, Link to the existing contact — auto-link by email match (single-tenant providers only — see warning below) |

Store as `CONTACT_LINKING_CHOICE`. This drives `AllowContactMappingWithEmail` (`true` for "link", `false` for "create new").

> **⚠ Multi-tenant safety**: For **multi-tenant Entra External ID** (Authority uses `/organizations/` or `/common/`, or `IssuerFilter` is a wildcard), the Power Pages server **forcibly disables** `AllowContactMappingWithEmail` regardless of the site setting (`BlockContactMappingSettingForMultitenantApp` feature flag in `LoginController.cs:2578-2587`). Reason: email claims can't be trusted across tenants. If the user selects "Link to the existing contact" but the Authority is multi-tenant, warn them that linking won't work and recommend single-tenant Authority.
>
> **⚠ Security**: When `AllowContactMappingWithEmail = true`, an attacker who can sign into the configured IdP using a victim's email can take over the victim's contact. Enable only when the IdP verifies emails (Entra External ID with single tenant verifies; arbitrary OIDC may not).

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

**For "Microsoft Entra ID"**: No additional configuration needed — configured via Power Pages admin center.

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
| Would you like to enable any of these optional features? | None (Recommended), Terms and Conditions — require users to accept terms before accessing the site, Two-factor authentication (2FA) — users verify with a code after login |

> **Note:** The user can select multiple options. If they select 2FA, Phase 8.1 will create the `TwoFactorEnabled` site settings. If they select Terms and Conditions, follow the Terms flow below.
>
> **Invitation-based registration is NOT in this list anymore** — it's controlled by the registration mode question above. Setting registration mode to `Invitation-only` or `Both` is what enables invitations.

**If "Terms and Conditions" is selected**, first surface the GDPR prerequisite **before** collecting content — terms only function if the underlying solution is installed:

> **GDPR prerequisite**: Terms require ALL THREE of these to be in place for the server to actually enforce them:
> 1. `Authentication/Registration/TermsAgreementEnabled = true` (site setting we will create)
> 2. The `msdynce_PortalPrivacyExtensions` solution must be installed in your Dataverse environment (`IsGdprEnabled` is portal-level)
> 3. The `Account/Signin/TermsAndConditionsCopy` content snippet must have non-empty text (we will create this)
>
> Without the Privacy Extensions solution, the server silently ignores `TermsAgreementEnabled`. The setup-auth skill will still write all three pieces — but unless the solution is installed in Dataverse, the terms gate won't be enforced server-side.

Use `AskUserQuestion`:

| Question | Header | Options |
|----------|--------|---------|
| Do you have the GDPR/Privacy Extensions solution installed, or are you okay with terms being a no-op until you install it? | Privacy solution | Yes — solution installed (or I'll install it), Continue anyway — set up terms; I understand they won't be enforced until I install the solution, Cancel — I don't want terms |

**If "Cancel"**: skip the Terms branch entirely, do not set `TermsAgreementEnabled`, do not create the Terms page or snippets.

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
| `RegistrationClaimsMapping` | **Comma-separated `contactfield=claimtype` pairs** (NOT JSON). Applied **once** at first sign-in, before the contact is created. Example for Entra External ID: `firstname=given_name,lastname=family_name,emailaddress1=email`. The server silently skips malformed pairs — verify in Application Insights if claims aren't populating. | None |
| `LoginClaimsMapping` | Same format as `RegistrationClaimsMapping`. Applied **every login** (overwrites contact fields). Use sparingly — it overwrites manual edits the user makes to their profile. | None |
| `ExternalLogoutEnabled` | Sign out of the IdP when the user logs out (legacy — prefer `RPInitiatedLogout` for OIDC) | `true` |
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
- `AuthProviderConfig` — interface with `id`, `type`, `displayName`, optional `providerIdentifier` (required for non-local), optional `loginByEmail` (local-only)
- `AUTH_PROVIDERS: AuthProviderConfig[]` — the array (one entry per configured provider, in the order they should appear on the Login page)
- `LOCAL_PROVIDER` — exported helper: `AUTH_PROVIDERS.find(p => p.type === 'local')` (`undefined` if no local)
- `EXTERNAL_PROVIDERS` — exported helper: `AUTH_PROVIDERS.filter(p => p.type !== 'local')`
- `getCurrentUser()` — reads from `window.Microsoft.Dynamic365.Portal.User`
- `isAuthenticated()` — checks if user exists and has `userName`
- `getAuthProvider()` — DEPRECATED. For backward compat, returns the first local provider or the first provider overall. Prefer reading `AUTH_PROVIDERS` directly.
- `fetchAntiForgeryToken()` — fetches from `/_layout/tokenhtml` and parses HTML response
- `loginExternal(providerIdentifier, returnUrl?, invitationCode?)` — Form POST to `/Account/Login/ExternalLogin` for external providers
- `loginLocal(credential, password, rememberMe?, returnUrl?, invitationCode?)` — fetch POST to `/SignIn` for local
- `loginWithProvider(provider, { returnUrl?, invitationCode?, credentials? })` — **router**: dispatches to `loginLocal()` or `loginExternal()` based on `provider.type`. This is what UI components should call.
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

#### 5.1.2 Create Registration Page (Local Auth Only)

**Always create the `/registration` page when local authentication is configured AND `REGISTRATION_MODE` is not `Registration disabled`** — regardless of whether the mode is `Open registration only`, `Invitation-only`, or `Both`. In invitation-only mode the page is reached via the `/redeem-invitation` flow (Phase 5.1.7), not direct navigation — but the SPA route must still exist so React Router can render it.

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
      '/account/login/externallogincallback': '/external-login-confirmation'
    };
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
| `'/account/login/externallogincallback': '/external-login-confirmation'` | Any external provider is configured (Phase 5.1.8) — captures first-time external sign-in into the SPA |
| `'/account/login/termsandconditions': '/terms'` | Terms & Conditions are enabled (any auth flow — see Phase 5.1.5) — captures the server's post-auth Terms redirect for external providers |

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
- Code-Site-Shell-Header template (`.powerpages-site/web-templates/code-site-shell-header/`) with redirect script — entries depend on enabled features (resetpassword, redeeminvitation)
- `website.yml` updated to point `headerwebtemplateid` to Code-Site-Shell-Header

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

# ExternalLogoutEnabled — false when using RPInitiatedLogout
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
| Registration Page | `src/pages/Registration.tsx` (or framework equivalent) — local auth, not disabled | Created (if applicable) |
| Redeem Invitation Page | `src/pages/RedeemInvitation.tsx` (or framework equivalent) — `Invitation-only` or `Both` modes | Created (if applicable) |
| Forgot Password Page | `src/pages/ForgotPassword.tsx` (or framework equivalent) — local auth only | Created (if applicable) |
| Session KeepAlive | `src/hooks/useSessionKeepAlive.ts` (or framework equivalent) — integrated in Layout | Created |
| Terms Page | `src/pages/Terms.tsx` (or framework equivalent) — when terms enabled | Created (if applicable) |
| Terms Snippet | `Account/Signin/TermsAndConditionsCopy` content snippet | Created (if applicable) |
| Reset Password Page | `src/pages/ResetPassword.tsx` (or framework equivalent) — local auth only | Created (if applicable) |
| Shell Header | `Code-Site-Shell-Header` web template — redirects server auth pages to SPA | Created (survives uploads) |
| Site Setting | `ProfileRedirectEnabled = false`, `Enabled`, `OpenRegistrationEnabled`, `InvitationEnabled` per registration mode | Created |

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
- **User profile display**: After login, the auth service's `getUserDisplayName()` falls back through `firstName + lastName` → `firstName` → `userName` → `email` → `'User'`. Power Pages populates `firstName`/`lastName`/`email` from standard OIDC claims (`given_name`, `family_name`, `email`) by default — no explicit `RegistrationClaimsMapping` is needed for these standard claims. If the IdP doesn't emit a claim, the corresponding field remains empty and the display name falls back to `userName`.
- **Two-Factor Authentication**: If 2FA is enabled (`Authentication/Registration/TwoFactorEnabled = true`), users will be prompted for a verification code after primary login. 2FA is entirely server-managed -- no client-side code changes are needed. Configure 2FA providers in the Power Pages admin center
- **Invitation-based registration**: If invitations are enabled (`REGISTRATION_MODE` is `Invitation-only` or `Both`), generate invitation codes by creating Invitation records in Dataverse (`adx_invitation` table) — the `adx_invitationcode` field is the value to use in the URL. Share invitation links in the format `{site-url}/Account/Login/RedeemInvitation?invitation={code}` — the Code-Site-Shell-Header script redirects this to the SPA `/redeem-invitation?invitation={code}` route automatically. After redemption, the invitation is linked to the user's contact (single-redemption invitations are marked redeemed; group invitations track redeemed contacts in a collection). 2FA, terms, and external login flows all preserve the invitation code through the auth flow.
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
