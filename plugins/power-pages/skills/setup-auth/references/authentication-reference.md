# Common authentication contract

Use the canonical provider-array service template listed in SKILL.md.
Add optional service functions only for enabled branches; the old single-provider implementation is not a second source of truth.

## How Power Pages Authentication Works

Power Pages authentication is **server-side** using session cookies. There is no client-side token management.

### External Login Flow (Entra ID, OIDC, SAML2, WS-Federation, Social OAuth)

1. Fetch an anti-forgery token from `/_layout/tokenhtml`
2. POST a form to `/Account/Login/ExternalLogin` with the token, provider identifier, and return URL
3. Power Pages redirects the user to the identity provider for authentication
4. After successful authentication, the session is established via cookies
5. User information becomes available in `window.Microsoft.Dynamic365.Portal.User`

### Logout Flow (All Providers)

1. Redirect the user to `/Account/Login/LogOff`
2. Power Pages server:
   - Clears session cookies (`ApplicationCookie`, `ExternalCookie`, `TwoFactorCookie`)
   - If `SignOutEverywhereEnabled` is true, updates the security stamp to invalidate all sessions across devices
   - Clears the `DeferredLocalLoginCookie` if present
   - Sends `Clear-Site-Data: "cache"` header
3. `window.Microsoft.Dynamic365.Portal.User` becomes `undefined`
4. If federated logout is enabled, the server redirects to the IdP's `end_session_endpoint`; otherwise it uses the `returnUrl` query parameter or site root.

Create the auth service file based on the detected framework and selected identity provider(s).

> **ALWAYS use the `AUTH_PROVIDERS` array pattern, even with one entry.** Never generate a single `AUTH_PROVIDER` constant. The array pattern means adding a second provider later (e.g., a second Entra External ID tenant, or local + an external provider) is just appending to the array - no restructuring needed. This avoids the bug class where a re-run silently drops previously-configured providers because the single-constant pattern can't represent more than one.
>
> The array MUST include:
> - Every provider in `EXISTING_PROVIDERS` from Phase 1.5 (merged in based on the user's `MERGE_MODE` choice)
> - Any new provider the user added via Phase 2.1
>
> Use a stable `id` for each provider (e.g., `entra-external-id-customer`, `entra-external-id-employee`, `local`) so React keys and switch statements remain stable across re-runs.

**All frameworks**: Create `src/services/authService.ts` with these functions and types:

- `AuthProviderType` - string union: `'local' | 'oidc' | 'entra-id' | 'saml2' | 'ws-federation' | 'social'`
- `AuthProviderConfig` - interface with `id`, `type`, `displayName`, optional `providerIdentifier` (required for `'oidc'` / `'saml2'` / `'ws-federation'` / `'social'`; **OMIT for `'entra-id'`** - resolved at runtime), optional `loginByEmail` (local-only)
- `AUTH_PROVIDERS: AuthProviderConfig[]` - the array (one entry per configured provider, in the order they should appear on the Login page)
- `LOCAL_PROVIDER` - exported helper: `AUTH_PROVIDERS.find(p => p.type === 'local')` (`undefined` if no local)
- `EXTERNAL_PROVIDERS` - exported helper: `AUTH_PROVIDERS.filter(p => p.type !== 'local')`
- `getCurrentUser()` - reads from `window.Microsoft.Dynamic365.Portal.User`
- `isAuthenticated()` - checks if user exists and has `userName`
- `getTenantId()` - reads `window.Microsoft.Dynamic365.Portal.tenant` (the site's parent tenant GUID). Returns `undefined` if not yet populated.
- `getAuthProvider()` - DEPRECATED. For backward compat, returns the first local provider or the first provider overall. Prefer reading `AUTH_PROVIDERS` directly.
- `fetchAntiForgeryToken()` - fetches from `/_layout/tokenhtml` and parses HTML response
- `resolveProviderIdentifier(provider)` - returns the value to POST as `provider` to `/Account/Login/ExternalLogin`. For `type='entra-id'`, derives `https://login.windows.net/${getTenantId()}/` at runtime. For other external types, returns `provider.providerIdentifier`. **Never hardcode tenant ID into the AUTH_PROVIDERS array for Entra ID** - this resolver handles it.
- `loginExternal(providerIdentifier, returnUrl?, invitationCode?)` - Form POST to `/Account/Login/ExternalLogin` for external providers
- `loginLocal(credential, password, rememberMe?, returnUrl?, invitationCode?)` - fetch POST to `/SignIn` for local
- `loginWithProvider(provider, { returnUrl?, invitationCode?, credentials? })` - **router**: dispatches to `loginLocal()` or `loginExternal()` based on `provider.type`. Uses `resolveProviderIdentifier()` so Entra ID's runtime resolution works transparently. This is what UI components should call.
- `logout(returnUrl?)` - redirects to `/Account/Login/LogOff`
- `getAuthError()` - parses `?message=` or `?error=` query params from server-side auth error redirects and returns a user-friendly error message
- `getSessionExpiredMessage()` - checks for `?sessionExpired=true` and returns a session-expired message
- `parseServerErrors(html)` - **Required for local auth.** Parses validation errors from server HTML responses (`.validation-summary-errors li`, `.alert-danger li`, `.field-validation-error`). Used by login and register to show server errors in the SPA.
- `register(fields, returnUrl?, invitationCode?)` - required for local registration; use the local template's GET/parse/POST Web Forms contract, including full control names rather than MVC field names.
- `forgotPassword(email)` - **Required when local auth is configured.** MVC form POST to `/Account/Login/ForgotPassword` with `Email` + anti-forgery token. Server sends a password reset email. Uses `fetch()` like login. Returns a promise - on success (`.then()`), show a "check your email" confirmation. On failure (`.catch()`), show the error.
- `resetPassword(userId, code, password, confirmPassword)` - **Required when local auth is configured.** MVC form POST to `/Account/Login/ResetPassword` with `UserId`, `Code`, `Password`, `ConfirmPassword`, `__RequestVerificationToken`. The `UserId` and `Code` come from the URL query params (set by the email reset link). On success, redirects to `/login?message=password_reset_success`.
- `TermsRequiredError` - **Required when terms are enabled.** Custom error class thrown when the server redirects to the terms page after login or registration. The login/registration page catches this and navigates to the SPA `/terms` page.
- `acceptTerms(returnUrl?)` - **Required when terms are enabled.** Fetches the server terms page (GET `/Account/Login/TermsAndConditions`) to get the anti-forgery token, then POSTs acceptance (`IsTermsAndConditionsAccepted=true`, `IsFacebook=False`, `UseExternalSignInAsync=False`, `IsInternalAADUser=False`). Uses the response URL dynamically (server may serve terms from `/Account/Login/TermsAndConditions` or `/TermsAndConditions`).
- `getUserDisplayName()` - full name, first name, last name, email, userName, then "User"
- `getUserInitials()` - for avatar display

**Terms detection in login and registration:** Both `loginLocal()` and `register()` must check `response.url.includes('TermsAndConditions')` after the fetch completes. The server redirects to different URLs depending on the flow:
- **Login**: redirects to `/Account/Login/TermsAndConditions`
- **Registration**: redirects to `/TermsAndConditions?ReturnUrl=%2F`

Both are caught by `response.url.includes('TermsAndConditions')`. When detected, throw `TermsRequiredError`. The server also sets a `DeferredLocalLoginCookie` - it defers the session creation until terms are accepted.

Use `fetch()` for local login and registration so server validation errors remain inside the SPA.
Use the local template linked in SKILL.md, parsing returned HTML and surfacing errors inline.

**Login flow varies by provider type:**

- **Microsoft Entra ID**: Form POST to `/Account/Login/ExternalLogin` with provider `https://login.windows.net/{tenantId}/`
- **Entra External ID**: Form POST to `/Account/Login/ExternalLogin` with provider set to the External ID `AuthenticationType` (configured via site settings `Authentication/OpenIdConnect/{provider}/AuthenticationType`). Uses OpenID Connect underneath with the External ID tenant authority URL.
- **OpenID Connect**: Form POST to `/Account/Login/ExternalLogin` with provider set to the OIDC `AuthenticationType` (configured via site settings `Authentication/OpenIdConnect/{provider}/AuthenticationType`)
- **SAML2**: Form POST to `/Account/Login/ExternalLogin` with provider set to the SAML2 `AuthenticationType` (configured via site settings `Authentication/SAML2/{provider}/AuthenticationType`)
- **WS-Federation**: Form POST to `/Account/Login/ExternalLogin` with provider set to the WS-Federation `AuthenticationType` (configured via site settings `Authentication/WsFederation/{provider}/AuthenticationType`)
- **Local Authentication**: Form POST to `/SignIn` with `PasswordValue` (not `Password`), anti-forgery token from `/_layout/tokenhtml`, and optionally `RememberMe`. When `LocalLoginByEmail` is `true`, send the `Email` field; otherwise send the `Username` field. Note: the login endpoint uses `/SignIn` and `PasswordValue` - these differ from the registration endpoint which uses `/Account/Login/Register` and `Password`. Does NOT use the ExternalLogin endpoint.
- **Microsoft Account**: Form POST to `/Account/Login/ExternalLogin` with provider `urn:microsoft:account`
- **Facebook**: Form POST to `/Account/Login/ExternalLogin` with provider `Facebook`
- **Google**: Form POST to `/Account/Login/ExternalLogin` with provider `Google`

**CRITICAL**: Power Pages authentication is **server-side** (session cookies). External login flows post a form to the server which redirects to the identity provider. Local login posts credentials directly to the server. There is no client-side token management. The `fetchAntiForgeryToken()` call gets a CSRF token for the form POST, not a bearer token.

**SECRET MANAGEMENT**: Never include `ClientSecret`, `AppSecret`, or any credential values in the auth service code or any file committed to source control. The `providerIdentifier` field is a public identifier (URL or name), not a secret. Actual secrets must be configured through the Power Pages admin center.

**SERVER-RENDERED PAGE HANDLING**: For external login flows, the Power Pages server may redirect to server-rendered pages during certain flows (e.g., first-time registration via `ExternalLoginConfirmation`, 2FA via `SendCode`/`VerifyCode`, terms acceptance via `TermsAndConditions`). These are server-side decisions that the SPA cannot intercept. To minimize these redirects:

- Ensure `Authentication/Registration/OpenRegistrationEnabled` is configured correctly - when `true`, new external users are auto-registered without the `ExternalLoginConfirmation` page
- Ensure `TermsAgreementEnabled` is `false` unless explicitly needed - otherwise every first login shows a server-rendered terms page
- For 2FA flows, the server renders `SendCode` and `VerifyCode` pages - these cannot be replaced by SPA code
- When the user returns from a server-rendered page, the SPA should check for auth state changes (`getCurrentUser()`) and update the UI accordingly
- The auth service's `useAuth` hook should call `refresh()` on mount to pick up session changes that happened outside the SPA

For **local auth**, all error handling is client-side - the `login()` and `register()` functions use `fetch()` (not `form.submit()`) so the user stays in the SPA. Server errors are parsed from HTML responses via `parseServerErrors()` and thrown for the UI to display inline.

### Session Expiry Re-Authentication

When a user's session expires while they are on a page:

1. The server redirects to the login page with `?sessionExpired=true`
2. The login action clears all authentication cookies
3. For OIDC providers, the server can pass `prompt=login` to force re-authentication at the IdP (bypassing SSO)

To support this in the client-side auth service, check for `sessionExpired` in the URL and show a session-expired message:

```typescript
export function getSessionExpiredMessage(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  const params = new URLSearchParams(window.location.search);
  return params.get('sessionExpired') === 'true' ? 'Your session has expired. Please sign in again.' : undefined;
}
```

### Account Management Endpoints (Server-Side)

Power Pages provides server-rendered account management pages. These are NOT part of the client-side auth service - they are server-side ASP.NET views. The client can link to these URLs:

| Endpoint | Purpose | When to use |
|----------|---------|-------------|
| `/Account/Login/ChangePassword` | Change password (local auth users) | User wants to update their password |
| `/Account/Login/SetPassword` | Add password to external-only account | External user wants to add local login |
| `/Account/Login/ChangeEmail` | Change email address | User wants to update their email |
| `/Account/Login/LinkLogin` | Link additional external login | User wants to add Google to their Entra account |
| `/Account/Login/RemoveLogin` | Remove a linked external login | User wants to unlink a social provider |
| `/Account/Login/ConfirmEmail` | Email confirmation page | After registration with `EmailConfirmationEnabled` |
| `/Account/Login/ChangeTwoFactor` | Manage 2FA settings | User wants to enable/disable 2FA |
| `/Account/Login/ForgotPassword` | Password reset request | User forgot their password |

These endpoints are available on deployed Power Pages sites. Add links to relevant pages in the site's user profile area as needed.

---

## Important Notes

- **Auth only works on deployed sites**: The `/_layout/tokenhtml` endpoint and `window.Microsoft.Dynamic365.Portal` object are only available when the site is served from Power Pages, not during local `npm run dev`.
- **Mock data for development**: The auth service includes a mock user pattern for local development. The mock user has configurable roles so developers can test role-based UI locally.
- **Security**: Always validate permissions server-side via table permissions. Client-side auth checks are for UX only -- a direct API call bypasses all client-side checks. Never commit secrets (`ClientSecret`, `AppSecret`) to source control -- use the Power Pages admin center for sensitive values.
- **Provider configuration**: Guided provisioning lets the user configure the external IdP; CLI-supported provisioning can configure it only after explicit consent.
- **Multiple providers**: Power Pages supports multiple identity providers simultaneously. Users see all configured providers on the login page. To configure multiple providers, create separate site settings for each and update the auth service to support provider selection.

---
