# Plan authentication

Resolve the current user's requested scope before collecting optional features.
Read only the selected provider and optional-feature references from the entry's resource table.

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

<!-- gate: setup-auth:2.1.requirements | category=plan | cancel-leaves=nothing -->

> 🚦 **Gate (plan · setup-auth:2.1.requirements):** Pick which auth features to build (login+logout / RBAC / both). Covers the conditional follow-up "which roles get access" sub-prompt in the same step.
>
> **Trigger:** Phase 2.1 entry.
> **Why we ask:** Wrong feature set gets generated - e.g. building RBAC files when the user only wanted login.
> **Cancel leaves:** Nothing - no auth files written yet.

Ask the user: Which authentication features do you need: login/logout, role-based UI with an existing service, or both?
If role-based UI is requested, ask which existing roles should access each protected area.
Stop without writing auth files if the user cancels.

**Re-run handling - when Phase 1.5 detected existing providers:**

The behavior depends on the `MERGE_MODE` chosen in Phase 1.5:

- **`keep-only`** (user chose "keep all existing, no new provider this run") → Skip the new-provider selection question entirely. Proceed to the "Local Authentication" follow-ups only if local was detected. Phase 3.2 will generate `AUTH_PROVIDERS` from `EXISTING_PROVIDERS` only.
- **`keep-and-add`** (default - user wants to add one more) → Ask the user what to add. The provider selection question below should still be multi-select (the user could be adding multiple new providers in one go), but the existing providers are NOT in the list (they're already configured - the question is asking what's *new*). Common patterns:
  - User has Entra External ID and explicitly requests local auth → ask local follow-ups → Phase 3.2 merges
  - User has Entra External ID + Local, wants to add a *second* Entra External ID tenant → user selects "Entra External ID" → after collecting Authority/ClientId, ask: `"You already have an Entra External ID provider configured for tenant {existing-tenant}. This new one is a separate instance - give it a distinct ProviderName slug (used in site setting keys like Authentication/OpenIdConnect/{ProviderName}/* and in code as the provider id)."` Let the user pick a slug (default to the next incrementing number, e.g., `OpenIdConnect_2`) or pick a custom name (e.g., `EntraExternalId_Employee`).
- **`replace-all`** (user chose to wipe everything) → Run the provider selection question as on a first invocation.

**Do NOT proactively ask "do you want to configure multiple instances?"** at the start. Walk the user through configuring ONE provider at a time. When they finish configuring one and want another, they can re-run setup-auth → Phase 1.5 detects what's there → Phase 2.1 in `keep-and-add` mode asks "what do you want to add now?". This keeps the question count low for the common case (configure one provider) while still supporting the advanced case (multiple tenants).

**IMPORTANT: Multiple providers are supported.** The user may want more than one identity provider (e.g., Entra External ID + Google). If the user's initial prompt mentions specific providers, skip the provider selection question and proceed directly to collecting details for each mentioned provider.

> **IMPORTANT - Local Authentication:** NEVER set up local authentication by default. Do NOT include it in the provider selection list, do NOT recommend it in smart inference, and do NOT configure it unless the user explicitly and specifically asks for it (e.g., "I want username/password login", "set up local login", "add local auth"). External identity providers (Entra External ID, Entra ID, OIDC, etc.) are always preferred. If the user says something ambiguous like "add login", default to an external provider - never to local auth.

If the user has NOT specified which provider(s) they want, ask the user to determine the identity provider(s). **This is a multi-select question** - the user can choose one or more:

| Question | Options |
|----------|---------|
| Which identity provider(s) do you want to use? (select all that apply) | Entra External ID (Recommended) - Customer identity with self-service sign-up (CIAM), Microsoft Entra ID - Azure AD / Entra ID for internal/employee sites, OpenID Connect - Okta, Auth0, or any OIDC-compliant provider, SAML2 - SAML 2.0 identity provider (ADFS, Shibboleth, Login.gov, etc.), WS-Federation - WS-Federation identity provider, Microsoft Account - Sign in with Microsoft personal/work account, Facebook - Sign in with Facebook, Google - Sign in with Google |

For each selected provider, use its entry-linked reference to collect mandatory values and share its official documentation.
Use the entry-linked site-settings contract to derive registration mode for external-only sites.
The four local-account questions apply only when local authentication is explicitly in scope.

**Login page layout** - when more than one auth provider is configured (including local + 1 external, or 2+ providers), the Login page renders all of them. Ask the user how they want providers laid out:

| Question | Header | Options |
|----------|--------|---------|
| How should sign-in options be laid out on the Login page? | Layout | Horizontal row (Recommended) - provider buttons side-by-side in a wrapping row, local form below a divider, Vertical stack - provider buttons stacked full-width, local form below a divider, Primary spotlight - one provider featured as the primary CTA, others under a "More sign-in options" toggle, local form below, Tabbed - tabs to switch between provider modes (good for 3+ providers, feels heavy for 2) |

Store this choice as `LOGIN_LAYOUT`.
A single external provider may log in directly only when no login/error landing page is needed; a local provider still needs a credential form.

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
| Would you like to enable any of these optional features? | None (Recommended), Terms and Conditions - require users to accept terms before accessing the site |

> **Note:** If they select Terms and Conditions, follow the Terms flow below.
>
> **Invitation-based registration is NOT in this list** - it's controlled by the registration mode question above. Setting registration mode to `Invitation-only` or `Both` is what enables invitations.
>
> **Two-factor authentication (2FA) is intentionally NOT offered.** Power Pages' built-in 2FA flow is server-rendered (`/Account/Login/SendCode` → `/Account/Login/VerifyCode`) and cannot be intercepted from the SPA - there's no SPA-equivalent UI for the code entry step, and bouncing the user out to a server page mid-login breaks the SPA experience. If the user explicitly asks for 2FA, tell them: "Power Pages built-in 2FA requires the legacy server-rendered SendCode/VerifyCode pages, which we don't support in SPA-based SPA sites yet. For external providers (Entra ID, Entra External ID, OIDC), enable MFA at the identity provider instead - it's transparent to Power Pages and stays inside the IdP's branded experience. For local accounts, 2FA on SPA sites is not currently supported." Do NOT create `TwoFactorEnabled`, `RememberMeEnabled`, or `RememberBrowserEnabled` site settings.

**Profile page** - ask whether to scaffold a SPA profile page that lets signed-in users edit their own contact info via the Power Pages Web API. This is a standalone question because it has its own infrastructure implications (Web API site settings on the `contact` entity + Self-scope table permission).

| Question | Header | Options |
|----------|--------|---------|
| Add a profile page that lets signed-in users edit their contact info (name, mobile phone, address) via the Power Pages Web API? Email is shown read-only. | Profile page | No (default) - no profile page; users can't edit their info from the SPA, Yes - create a /user-profile SPA page with edit form, accessible from the header user menu |

Store as `INCLUDE_PROFILE_PAGE` (boolean). Default `false`.

> **⚠ MANDATORY route name: `/user-profile` (NOT `/profile`)**. The path `/profile` is **reserved by the Power Pages server** for the legacy server-rendered profile page - using it as a SPA route creates a conflict that breaks the page. **Always use `/user-profile`** for the SPA route. The skill executor MUST NOT rename this route. Same for the file: **`src/pages/UserProfile.tsx`** (NOT `Profile.tsx`).

When `true`, Phase 5.1.9 generates `src/pages/UserProfile.tsx` (file name mandatory), extends `authService.ts` with `getMyProfile` / `updateMyProfile` (function names mandatory), evolves the `AuthButton` from inline `[Avatar Name Sign Out]` to a dropdown menu with "My Profile" and "Sign Out", and adds the `/user-profile` route (path mandatory) to `App.tsx`. Phase 8.1 writes the Web API site settings (`Webapi/contact/enabled = true` and `Webapi/contact/fields` with the COMPLETE default field list documented in Phase 8.1 - not a subset) and a Self-scope table permission on `contact` for the Authenticated Users role. The dropdown shape becomes the new default for `AuthButton` regardless of `INCLUDE_PROFILE_PAGE` so the component is ready for future menu items.

**Profile page design - intentionally simple:**

The page has two sections:

1. **Account Details** (read-only display at the top) - shows just the user's **full name** (firstname + lastname combined) and **email**. **DO NOT** display contactId, roles, sign-in method, provider name, last-login timestamp, or any other account metadata. Keep this section minimal.
2. **Edit form** (below) - only these editable fields. Email is intentionally **NOT** editable (changing email via Web API conflicts with auth provider claim mapping behavior and is surprising for external-auth users).

**Default EDITABLE field set** (the form MUST include exactly these 8 fields - do not add email, do not add middlename, do not add a Change Password link):

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

The Web API `fields` site setting MUST include `contactid` plus the 8 editable fields above (9 total entries - lowercase). Phase 8.1 specifies the exact value verbatim.

> **Prerequisite for `Yes`**: an "Authenticated Users" web role must exist (or any role with `authenticatedusersrole: true` flag). Phase 1.4 inventoried web roles - if none qualifies, warn the user that profile editing won't work until a role is assigned and offer to invoke `/create-webroles` first.

> **Cross-provider compatibility**: the profile page works the same regardless of auth provider (local, Entra ID, Entra External ID, OIDC, social) because it operates on the contact record after sign-in - not on IdP-specific session state. Email is read-only on the page, so there's no provider-specific caveat to surface (the IdP remains the source of truth for email).
