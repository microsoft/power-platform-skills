# Verify and report authentication

Run verification for the approved scope, not every possible optional feature.
Run `node "${PLUGIN_ROOT}/skills/setup-auth/scripts/validate-auth.js" --complete` from the site root after writing the setup report.
Completion mode requires a report and validates the project without host-hook JSON.
A hook invocation while loading the skill is not completion evidence.

#### 7.1 Verify File Inventory

Confirm the following files were created:

- `src/types/powerPages.d.ts` - Power Pages type declarations
- `src/services/authService.ts` - Auth service with login/logout functions
- Framework-specific auth hook/composable (e.g., `src/hooks/useAuth.ts` for React)
- `src/utils/authorization.ts` - only when role-based access control is in scope
- Framework-specific authorization components (e.g., `RequireAuth.tsx`, `RequireRole.tsx` for React) - only when role-based access control is in scope
- Auth button component (e.g., `src/components/AuthButton.tsx` for React)
- Registration page when approved registration permits it, including external-only provider selection; no local form without local auth
- Forgot password page (e.g., `src/pages/ForgotPassword.tsx` for React) - only when local auth with reset password is configured
- Session keepalive hook (e.g., `src/hooks/useSessionKeepAlive.ts` for React) - integrated into Layout
- Terms page (e.g., `src/pages/Terms.tsx` for React) - only when terms are enabled
- Reset password page (e.g., `src/pages/ResetPassword.tsx` for React) - only when local auth with reset password is configured
- **Redeem invitation page (e.g., `src/pages/RedeemInvitation.tsx` for React) - only when `REGISTRATION_MODE` is `Invitation-only` or `Both`**
- **User profile page (e.g., `src/pages/UserProfile.tsx` for React) - only when `INCLUDE_PROFILE_PAGE = true`. Plus `getMyProfile` + `updateMyProfile` functions in `authService.ts`, AuthButton evolved to dropdown shape, `/user-profile` route in `App.tsx`.**
- Code-Site-Shell-Header template (`.powerpages-site/web-templates/code-site-shell-header/`) with redirect script - entries depend on enabled features (resetpassword, redeeminvitation)
- `website.yml` updated to point `headerwebtemplateid` to Code-Site-Shell-Header
- **Web API site settings (`Webapi/contact/enabled`, `Webapi/contact/fields`) - only when `INCLUDE_PROFILE_PAGE = true`**
- **Table permission `.powerpages-site/table-permissions/My-Profile-Edit-Own-Contact.tablepermission.yml` with `scope: 756150004` (Self) - only when `INCLUDE_PROFILE_PAGE = true`**

Read each file and verify it contains the expected exports and functions:

- Auth service: `login`, `logout`, `getCurrentUser`, `isAuthenticated`, `fetchAntiForgeryToken`, `parseServerErrors`, `register`, `forgotPassword` (when local auth), `TermsRequiredError`, `acceptTerms` (when terms enabled), `redeemInvitation` and `fetchInvitationDetails` (when invitation modes), `loginLocal` accepts `invitationCode` parameter (when invitation modes)
- Authorization utils when in scope: `hasRole`, `hasAnyRole`, `hasAllRoles`, `getUserRoles`
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

Use the available browser automation capability to inspect the site and confirm the auth button is visible:

- Navigate to `http://localhost:<port>`
- Take a browser snapshot
- Verify the auth button (Sign In / mock user) appears in the navigation area

If the auth button is not visible or the page has rendering errors, fix the issues.

#### 7.4 Final site-integrity gate

After all auth source changes, the build, and browser verification are complete, run:

```bash
node "${PLUGIN_ROOT}/scripts/validate-site-integrity.js" --projectRoot "<PROJECT_ROOT>"
```

Fix every blocking error before presenting completion or asking to deploy. Inspect and report
review findings in both directions and with expanded content. Rerun this gate after any later
source change.

#### 8.3.5 Generate HTML Setup Report

After the summary, generate an HTML setup report at `<PROJECT_ROOT>/docs/auth-setup-report.html` that captures every decision and artifact from this run. The report is opened in the user's browser as a durable, shareable record they can review later.

**Why**: This skill makes many composing decisions (provider choice, registration mode, profile mapping, contact linking, profile page, terms, federated logout, etc.). A side-by-side HTML report makes it easy for the user to audit the full configuration in one place - much more scannable than the chat summary above. It also gives reviewers and teammates a single artifact to look at without re-running the skill.

**1. Build the data payload.** Construct a JSON object with the following keys and write it to a temp file:

Use `assets/auth-report-data.example.json`, linked directly in SKILL.md, as the payload shape.
Replace example alternatives with the actual decisions and booleans.

- Set `LOCAL_AUTH_DATA` to `null` if local auth was not configured.
- Include ALL site settings the skill created in `SITE_SETTINGS_DATA` (Phase 8.1) - `ProfileRedirectEnabled`, every `Authentication/{Type}/{Name}/...` block, `Webapi/contact/*` when applicable, etc. Mask any settings whose name contains `Secret` (replace value with `***` - secrets must not appear in the report).
- Include every YAML/code file the skill created or updated in `FILES_DATA`. Use action `"Created"` for new files, `"Updated"` for edits.
- `nextStepsHtml` should mirror the guidance in section 8.5 below, formatted as an `<ol>...</ol>` with `<code>` tags around commands. Only include the steps relevant to the providers actually configured.

**2. Render the report.** Run:

```bash
node "${PLUGIN_ROOT}/scripts/render-auth-report.js" \
  --output "<PROJECT_ROOT>/docs/auth-setup-report.html" \
  --data "<path-to-temp-data.json>"
```

The renderer refuses to overwrite an existing file. If a previous report already exists at that path, append a date suffix: `auth-setup-report-2026-05-27.html`.

**3. Open the report in the browser** (best-effort - never block the skill flow on this):

- Windows: `start "" "<PROJECT_ROOT>/docs/auth-setup-report.html"`
- macOS: `open "<PROJECT_ROOT>/docs/auth-setup-report.html"`
- Linux: `xdg-open "<PROJECT_ROOT>/docs/auth-setup-report.html"`

**4. Tell the user** the absolute path of the report file so they can open it manually if the browser launch failed. Phrasing example: *"I've written a full setup report to `<path>` and opened it in your browser. You can revisit this file any time to see every decision and artifact from this run."*

#### 8.5 Post-Deploy Notes

After deployment (or if skipped), remind the user with provider-specific guidance:

- **Test on deployed site**: Auth only works on the deployed Power Pages site, not on `localhost`
- **Identity provider configuration**: Provider-specific setup is required:
  - **Entra ID**: Configure the identity provider in the Power Pages admin center
  - **OpenID Connect**: Register a client application with the OIDC provider and update the `ClientId` site setting. Set the redirect URI in the provider to `{site-url}/signin-{ProviderName-lowercased}`
  - **SAML2**: Register the site as a service provider (SP) with the SAML IdP. The `ServiceProviderRealm` and `AssertionConsumerServiceUrl` must match the site URL
  - **WS-Federation**: Register the site as a relying party with the WS-Fed provider
  - **Local Authentication**: No external provider needed - users register and log in with username/password directly on the site
  - **Microsoft Account / Facebook / Google**: Register the application and configure the required secret through Key Vault-backed secret environment variables; never use a plain-string variable for a credential
  - **Entra External ID**: Register the application in the Entra External ID tenant. Update the `ClientId` site setting. Set the redirect URI to `{site-url}/signin-{ProviderName-lowercased}`. The authority URL may use `{tenant}.ciamlogin.com` or a custom domain.
- **Auth failure handling**: Enable the shell's external-auth-failure redirect to `/login`; `getAuthError()` displays the server error or generic `external_auth_failed` message.
- **User profile display**: After login, the auth service's `getUserDisplayName()` falls back through `firstName + lastName` → `firstName` → `lastName` → `email` → `userName` → `'User'`. **Email beats userName** because for external providers (Entra External ID, OIDC) the `userName` field is the OIDC subject identifier - a long opaque string like `vs25QwNe1ZAHqlWK1Naw9dVEBe-TbF5tZEpb0XjAEZQ` that's ugly and meaningless in a navigation bar. Power Pages populates `firstName`/`lastName`/`email` from standard OIDC claims (`given_name`, `family_name`, `email`). Entra External ID user flows often don't include `given_name`/`family_name` in the returned claims by default - if you want names populated, ensure the user flow has both attributes selected under "User attributes to collect" AND "Application claims" / "User attributes to return as claims" (see Phase 2.1 Entra External ID Step 3). The `email` claim is almost always emitted, so emails reliably populate even when names don't. `getUserInitials()` follows the same priority chain using the first character of each fallback source.
- **Two-Factor Authentication**: This skill does NOT scaffold Power Pages built-in 2FA - the `SendCode`/`VerifyCode` flow is server-rendered and cannot be integrated into the SPA experience. For MFA needs, configure it at the identity provider layer (Entra External ID conditional access, B2C user flow MFA, Auth0 Guardian, Okta Verify, etc.) - IdP-level MFA is transparent to Power Pages and stays inside the IdP's branded experience.
- **Invitation-based registration**: If invitations are enabled (`REGISTRATION_MODE` is `Invitation-only` or `Both`), generate invitation codes by creating Invitation records in Dataverse (`adx_invitation` table) - the `adx_invitationcode` field is the value to use in the URL. Share invitation links in the format `{site-url}/Account/Login/RedeemInvitation?invitation={code}` - the Code-Site-Shell-Header script redirects this to the SPA `/redeem-invitation?invitation={code}` route automatically. After redemption, the invitation is linked to the user's contact (single-redemption invitations are marked redeemed; group invitations track redeemed contacts in a collection). Terms acceptance and external login flows preserve the invitation code through the auth flow.
- **Assign web roles**: Users must be assigned appropriate web roles in the Power Pages admin center
- **Table permissions**: Client-side auth checks are for UX only - configure server-side table permissions via `/integrate-webapi` for actual data security
- **Local development**: Keep mocks restricted to localhost/loopback; verify that the deployed hostname uses real server state.
