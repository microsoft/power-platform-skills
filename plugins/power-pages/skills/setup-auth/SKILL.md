---
name: setup-auth
description: >-
  Configure login, logout, identity providers and role-based UI for Power Pages SPA sites.
  Use for sign-in setup or repair, provider app registration, protected routes, invitations,
  terms or user profiles. Supports Entra ID, Entra External ID, OIDC (Okta/Auth0), SAML2,
  WS-Federation, Google, Facebook, Microsoft Account and explicitly requested local accounts.
---

> **Plugin check**: Run `node "${PLUGIN_ROOT}/scripts/check-version.js"` — if it outputs a message, show it to the user before proceeding.

# Set up authentication and authorization

Follow the eight phases for the user's current request.
For an explanation or targeted repair, inspect the relevant existing configuration and resources; do not restart setup or expand scope without approval.
Track them in a task list with a description, an action title and an in-progress label.
Mark one phase in progress at a time and complete it only when its completion criterion holds.
Read resources only when their condition applies; templates are adaptation inputs, not dependencies to install.

## Constraints

- Power Pages authenticates on the server with session cookies.
  CSRF tokens from `/_layout/tokenhtml` are not bearer tokens.
  Client-side role checks control UI; server table permissions enforce data access.
- Preserve existing providers unless the user approves replacement.
  Always use `AUTH_PROVIDERS` arrays with stable IDs, including single-provider sites.
  External identifiers must exactly match their `AuthenticationType` settings.
- Workforce Entra resolves its identifier from `window.Microsoft.Dynamic365.Portal.tenant`; omit a hardcoded identifier.
  Entra External ID is an `oidc` provider with an explicit customer-tenant identifier.
- Configure local accounts only when explicitly requested or already configured and retained.
  Built-in Power Pages 2FA is unsupported in SPA sites; recommend IdP MFA.
  Do not scaffold `TwoFactorEnabled`, `RememberMeEnabled` or `RememberBrowserEnabled`.
- Keep secret values out of the conversation, source files and reports.
  Use Key Vault-backed environment variables when secrets are needed.
- Reserve `/SignIn`, `/Register`, `/Account/Login/*` and `/profile` for the server.
  SPA routes use `/login`, `/registration` and `/user-profile`.
- Before visible UI edits, follow [site integrity](../../references/site-modification-integrity.md) and [bidirectional design](../../references/bidirectional-design.md).
  Preserve every configured locale, validation state, accessible label and responsive layout.

## Resources

Paths are relative to this skill root.
Resolve `${PLUGIN_ROOT}` to this installed plugin's directory when running commands.
Adapt shell quoting and line continuations to the operating system; do not require a particular host tool.
Read each applicable resource directly, including its listed templates, without loading other branches.

| Condition | Resource |
|---|---|
| Detect framework or locate routes | [Shared framework conventions](../../references/framework-conventions.md) |
| Every run, including first invocation | [Existing-provider discovery](references/discovery-workflow.md) |
| Gather requirements | [Planning](references/planning-workflow.md) |
| Workforce Entra ID selected or retained | [Entra ID](references/provider-entra-id.md) |
| Entra External ID selected or retained | [External ID](references/provider-entra-external-id.md) |
| Generic OIDC, Okta or Auth0 selected or retained | [OIDC](references/provider-oidc.md) |
| Any OIDC provider's advanced settings requested, including External ID | Read only the optional settings table in [OIDC](references/provider-oidc.md); do not repeat generic provider inputs |
| OIDC app registration required | [IdP provisioning](references/idp-provisioning-workflow.md) |
| SAML2 selected or retained | [SAML2](references/provider-saml2.md) |
| WS-Federation selected or retained | [WS-Federation](references/provider-ws-federation.md) |
| Microsoft Account, Facebook or Google selected or retained | [Social providers](references/provider-social.md) |
| Implement or reuse auth service | [Common authentication](references/authentication-reference.md), [portal types](assets/powerPages.d.ts.template), [service template](assets/auth-service.ts.template) |
| Role-based UI requested | [Authorization](references/authorization-reference.md) |
| React detected | [React](references/framework-react.md) |
| Vue detected | [Vue](references/framework-vue.md) |
| Angular detected | [Angular](references/framework-angular.md) |
| Astro detected | [Astro](references/framework-astro.md) |
| Login/navigation or external confirmation UI needed | [Auth UI](references/auth-ui.md), [base button styles](assets/auth-button.css), [shell redirect template](assets/code-site-shell-header.html) |
| Login/registration provider layout needed | [Layout patterns](references/login-layouts.md) |
| Any external provider configured | [External confirmation](references/external-confirmation.md) |
| Local auth retained or explicitly requested | [Local auth](references/local-auth-workflow.md), [local service additions](assets/local-auth-service.ts.template), [login form](assets/local-auth-react-localloginform-component-local-auth-only.tsx.template), [registration form](assets/local-auth-react-registerform-component-local-auth-only.tsx.template) |
| Invitation-only or both registration modes | [Invitations](references/invitations.md) |
| Terms requested | [Terms](references/terms-workflow.md), [acceptance service addition](assets/terms-auth-service-termsrequirederror-and-acceptterms.ts.template) |
| Optional profile page enabled | [Profile](references/user-profile.md), [profile service additions](assets/user-profile-auth-service-additions.ts.template), [profile page](assets/user-profile-react-userprofile-page.tsx.template) |
| Authenticated navigation menu needed | [Dropdown example](assets/user-profile-updated-authbutton-with-dropdown.tsx.template); omit the profile item when disabled |
| Auth service integration or custom session settings | [Session and keepalive](references/session-settings.md) |
| Write site settings | [Common settings](references/site-settings.md) and only the selected provider references |
| A selected provider requires secrets | [Secrets and solution membership](references/secrets-workflow.md) |
| Verify, summarize or generate setup report | [Verification and report](references/verification-and-report.md), [report data example](assets/auth-report-data.example.json) |

## Phase 1: Check prerequisites

Locate `powerpages.config.json` in the current directory or immediate subdirectories.
If absent, stop and direct the user to the `create-site` skill.
Read `package.json` and identify React, Vue, Angular or Astro through the shared conventions.
Read `.solution-manifest.json` when present and retain `solution.uniqueName` for downstream creation helpers.

Check for `.powerpages-site`.
If absent:

<!-- gate: setup-auth:1.3.deploy-first | category=plan | cancel-leaves=nothing -->
> 🚦 **Gate (plan · setup-auth:1.3.deploy-first):** Deployment is required before auth settings can be authored; cancellation leaves no auth changes.

Ask the user: Deploy now (recommended), or deploy later?
If now, invoke the `deploy-site` skill and resume after deployment succeeds.
Otherwise stop.

Inventory `.powerpages-site/web-roles/*.yml`, including names, IDs and role flags.
If no roles exist:

<!-- gate: setup-auth:1.4.create-webroles | category=plan | cancel-leaves=nothing -->
> 🚦 **Gate (plan · setup-auth:1.4.create-webroles):** Create roles first or continue with login only; cancellation leaves no auth changes.

Ask the user: Create web roles first (recommended), or add roles later?
Invoke `create-webroles` if requested; otherwise retain the missing-role warning.

Follow discovery even if no SPA auth files exist.
Inventory server providers and SPA files; preserve `EXISTING_PROVIDERS` and the user's `MERGE_MODE`.
For `keep-only`, skip new-provider selection.
For `keep-and-add`, merge existing and new providers.
Only `replace-all` permits replacement of existing auth settings.

**Complete when:** project/framework/deployment, roles, solution context, existing providers and merge mode are known.

## Phase 2: Plan

Follow planning and load only the chosen provider references.
Infer a recommendation from site audience, then have the user confirm it; do not silently apply it.
Honor providers explicitly named in the request and collect required values for each.
Retain custom-domain settings and choose distinct provider slugs and callback paths.
Collect feature scope, roles, login layout and applicable registration choices.
Profile defaults off; local auth remains explicit opt-in.
Ask the external-provider logout question even when other advanced settings are declined; skip unsupported social logout.
Collect first-sign-in versus every-login claims sync and contact-linking choices using the common settings contract.
Use trusted, verified-email single-tenant providers for email-based linking.

For new OIDC app registration, read the provider's current official documentation first.
Follow provisioning: guided by default, or provider CLI setup with explicit consent and sequential read-back.
Default to `code id_token` with no client secret.
For External ID, confirm tenant, app and attached user flow before treating configuration as ready.

For requested terms, run the Privacy Extensions solution check before collecting terms content.
For profile, confirm the authenticated role and the fixed profile contract.
List planned source files, settings, permissions, optional features, remote actions and outstanding manual requirements.

<!-- gate: setup-auth:2.2.plan-approval | category=plan | cancel-leaves=nothing -->
> 🚦 **Gate (plan · setup-auth:2.2.plan-approval):** Approve the complete plan before writing auth files; cancellation leaves no auth files.

Ask the user: Approve and proceed (recommended), or revise the plan?
Revise and ask again when requested.

**Complete when:** all applicable inputs and the implementation plan are explicitly approved.

## Phase 3: Create auth service

Use the common service and type templates with the selected framework wrapper.
Replace example providers with the approved merged inventory; do not copy all example providers into the site.
Reuse an adequate existing service for authorization-only scope.
Preserve `getCurrentUser`, `isAuthenticated`, token fetching, provider resolution, `loginExternal`, `loginWithProvider`, `logout`, error handling and display-name/initial helpers.
Maintain the compatibility `login`/`getAuthProvider` surface needed by existing consumers.

For local auth, add the local service functions and wire `loginWithProvider` to `loginLocal`.
Use fetch for local forms, exact server field names, parsed validation errors, and Web Forms ViewState/control names for registration.
Add only enabled terms, invitation, external-confirmation and profile functions from their contracts.
Local login and registration detect terms redirects before normal success navigation.
Include localhost mocks, refresh on mount and the timeout-derived keepalive integrated in the layout.
Mocks must not apply to a deployed site.

**Complete when:** service/types/wrapper match scope, selected providers and applicable server form contracts.

## Phase 4: Create authorization utilities

Skip new authorization artifacts for login/logout-only scope.
Otherwise follow authorization and the selected framework reference.
Provide case-insensitive role checks, any/all checks, authenticated/admin checks and framework-appropriate guards or visibility wrappers.
Keep the server-permission security reminder beside the utilities.

**Complete when:** the approved role-check API and framework bindings exist, or existing ones are verified and reused.

## Phase 5: Create auth UI

Follow auth UI and only the enabled local, invitation, terms and profile branches.
Use the site's existing theme, localization and navigation patterns.
AuthButton has anonymous, loading and authenticated dropdown states; the profile menu item is conditional.
Create `/login` for multiple providers and whenever a local form or auth-error landing page is needed.
When `/login` exists, AuthButton navigates there; a single external provider may otherwise start login directly.
Render every retained/new provider and use the chosen layout consistently on login and registration.
Create registration only when the approved mode permits it, and keep invitation-only entry gating.

Create external confirmation when external auth is configured.
Use the shell template with only redirects to pages actually created; preserve query parameters.
Bind `website.yml` to `Code-Site-Shell-Header`, since uploads replace the original Header/Footer templates.
Local password reset, invitations and terms also need their corresponding shell redirects.
Profile uses exactly `/user-profile`, the specified service names, eight editable fields and read-only email.
After a profile save, call `applyContactUpdateLocally` before a refresh emitting a fresh user object.
Replace hardcoded sign-in links so navigation has exactly one auth entry.
Commit the scoped auth milestone when repository/user policy permits; leave unrelated files untouched.

**Complete when:** all enabled pages, navigation states, routes and shell bindings are connected.

## Phase 6: Implement role-based UI

For RBAC scope, identify protected routes/components, confirm the target roles and apply the approved wrappers/guards.
Keep loading, anonymous and unauthorized states explicit.
Do not treat hidden controls as server authorization.
Commit the scoped RBAC milestone when repository/user policy permits.

**Complete when:** every approved protected area has the intended role behavior, or this phase is out of scope.

## Phase 7: Verify auth setup

Follow the conditional inventory in verification and report.
Independently read generated files, imports, provider inventory, routes, wrappers, optional helpers and navigation callers.
Run the site's build; fix failures before proceeding.
Inspect the running local UI in a browser using mocks, including narrow layouts, configured locales and both directions.
Local rendering does not prove a real IdP sign-in works.
**Final site-integrity gate:** Run `node "${PLUGIN_ROOT}/scripts/validate-site-integrity.js" --projectRoot "<PROJECT_ROOT>"` and fix every blocking finding.

**Complete when:** the approved source inventory, build, local UI and integrity checks pass.

## Phase 8: Review and deploy

Follow common settings and selected provider/feature contracts.
Use `../../scripts/create-site-setting.js` for settings and existing permission/environment-variable helpers.
Require `Authentication/Registration/ProfileRedirectEnabled=false`, correcting an existing true value.
Honor the approved registration mode rather than writing contradictory global defaults.
Preserve configured providers and callback uniqueness; use the approved custom Redirect URI when supplied.
Handle secrets only when required; carry the target solution through creation helpers and surface any deferred secret configuration.
For profile, create the exact contact Web API field list and Self-scope read/write permission for the authenticated role.

Validate the new settings/permissions and independently re-read their values against the approved plan.
Rerun the build/site-integrity check after later source edits.
Present the full conditional artifact summary and relevant post-deploy guidance.
Render `docs/auth-setup-report.html` with the existing renderer and report payload example, masking all secret settings.
Use a unique suffixed report name if the renderer refuses an existing path.
Offer/open the report using the host's available browser-opening capability and provide its path even if opening fails.
Run `node "${PLUGIN_ROOT}/skills/setup-auth/scripts/validate-auth.js" --complete` explicitly from the site project after the report exists.
Resolve validation failures before completion.

> Reference: `${PLUGIN_ROOT}/references/skill-tracking-reference.md`

Record usage as `SetupAuth` according to that reference.
If new Dataverse environment-variable records may be outside the solution, prompt for `setup-solution` in sync mode.

<!-- gate: setup-auth:8.4.deploy | category=plan | cancel-leaves=nothing -->
> 🚦 **Gate (plan · setup-auth:8.4.deploy):** Deploy only after explicit approval; declining leaves local artifacts intact and makes no deployment.

Ask the user: Deploy now (recommended), or deploy later?
Invoke `deploy-site` only after approval.
Otherwise explain that real authentication remains unverified until deployed and tested with the configured provider.

**Complete when:** settings and report are independently checked, the validator passes, usage is recorded, deployment choice is honored and remaining manual/live checks are explicit.

## Progress

| Phase | Completion evidence |
|---|---|
| 1. Prerequisites | Site, deployment, roles, existing providers and solution context |
| 2. Plan | Approved scope, selected provider inputs and file/setting plan |
| 3. Service | Common and selected optional service contracts |
| 4. Authorization | Requested role API and framework bindings |
| 5. UI | Connected pages, navigation and shell redirects |
| 6. Role-based UI | Approved protected areas and role behavior |
| 7. Verification | Independent inventory, build, local browser and integrity checks |
| 8. Review/deploy | Validated settings/report, usage and explicit deployment choice |
