# Authentication Reference

This document provides the complete implementation patterns for Power Pages authentication across all supported identity providers.

## Supported Identity Providers

Power Pages supports the following authentication mechanisms:

| Provider Type | Description | Login Endpoint | Provider Identifier |
|---------------|-------------|----------------|---------------------|
| **Microsoft Entra ID** | Azure AD / Entra ID via OpenID Connect | `/Account/Login/ExternalLogin` | `https://login.windows.net/{tenantId}/` |
| **Entra External ID** | Customer identity (CIAM) with self-service sign-up. Uses OIDC — authority may be `ciamlogin.com` or a custom domain. **This is NOT Microsoft Account** — it is a separate OIDC provider for customer-facing apps. | `/Account/Login/ExternalLogin` | Site setting `Authentication/OpenIdConnect/{name}/AuthenticationType` |
| **OpenID Connect (Generic)** | Any OIDC-compliant provider (Okta, Auth0, Ping, etc.) | `/Account/Login/ExternalLogin` | Site setting `Authentication/OpenIdConnect/{name}/AuthenticationType` |
| **SAML2** | SAML 2.0 identity providers (ADFS, Shibboleth, etc.) | `/Account/Login/ExternalLogin` | Site setting `Authentication/SAML2/{name}/AuthenticationType` |
| **WS-Federation** | WS-Federation identity providers | `/Account/Login/ExternalLogin` | Site setting `Authentication/WsFederation/{name}/AuthenticationType` |
| **Local Authentication** | Username/password login without external provider | `/Account/Login/Login` | N/A (direct credential POST) |
| **Microsoft Account** | Microsoft personal/work account (social OAuth). **Not the same as Entra External ID.** | `/Account/Login/ExternalLogin` | `urn:microsoft:account` |
| **Facebook** | Facebook social login | `/Account/Login/ExternalLogin` | `Facebook` |
| **Google** | Google social login | `/Account/Login/ExternalLogin` | `Google` |

## How Power Pages Authentication Works

Power Pages authentication is **server-side** using session cookies. There is no client-side token management.

### External Login Flow (Entra ID, OIDC, SAML2, WS-Federation, Social OAuth)

1. Fetch an anti-forgery token from `/_layout/tokenhtml`
2. POST a form to `/Account/Login/ExternalLogin` with the token, provider identifier, and return URL
3. Power Pages redirects the user to the identity provider for authentication
4. After successful authentication, the session is established via cookies
5. User information becomes available in `window.Microsoft.Dynamic365.Portal.User`

### Local Login Flow

> **Important:** The login form field names differ from other auth endpoints. The password field is `PasswordValue` (not `Password`), and the form posts to `/SignIn` (not `/Account/Login/Login`). These names match the server-rendered login form.

1. Fetch an anti-forgery token from `/_layout/tokenhtml`
2. POST a form to `/SignIn` with the token, credentials, and password:
   - When `Authentication/Registration/LocalLoginByEmail` is `true`: send the `Email` field
   - When `Authentication/Registration/LocalLoginByEmail` is `false`: send the `Username` field
   - Password field name is `PasswordValue` (NOT `Password`)
   - Optionally include `RememberMe` field (when `Authentication/Registration/RememberMeEnabled` is `true`)
   - Include `ReturnUrl` field with the SPA path to redirect back to (e.g., `/`)
3. Power Pages validates credentials against the contact record in Dataverse
4. If 2FA is enabled and required for the user, the server redirects to `SendCode` action instead of completing sign-in
5. On success, the session is established via cookies and the server redirects to `ReturnUrl`
6. User information becomes available in `window.Microsoft.Dynamic365.Portal.User`

### Local Registration Flow

> **Important:** The registration page (`/Account/Login/Register`) is an ASP.NET Web Forms page, NOT an MVC action like login. It requires `__VIEWSTATE` and uses fully-qualified control names (e.g., `ctl00$...$EmailTextBox`). A simple form POST with flat field names will silently fail.

1. Fetch the server-rendered registration page: GET `/Account/Login/Register`
2. Parse the HTML response with `DOMParser` to extract:
   - `__VIEWSTATE`, `__VIEWSTATEGENERATOR`, `__VIEWSTATEENCRYPTED` hidden fields
   - `__RequestVerificationToken` hidden field
   - The form `action` URL (includes correlation IDs as query params)
   - Input control names by their IDs: `EmailTextBox`, `UsernameTextBox`, `PasswordTextBox`, `ConfirmPasswordTextBox`, `SubmitButton`
3. Resolve the form action URL relative to `/Account/Login/` (not relative to the SPA's current path)
4. POST a form with the parsed ViewState, anti-forgery token, and user values mapped to the correct control names
5. On success, the server creates a contact in Dataverse and either:
   - Redirects to `ReturnUrl` (if `EmailConfirmationEnabled` is `false`)
   - Redirects to email confirmation page (if `EmailConfirmationEnabled` is `true`)
6. On failure, the server returns a 200 with the registration page HTML containing validation errors

### Registration Flow (External Providers)

After external authentication, if the user does not already exist in Dataverse:

1. The server shows the `ExternalLoginConfirmation` view for the user to complete registration
2. Registration is controlled by multiple site settings: `RegistrationEnabled` (per-provider), `OpenRegistrationEnabled` (global), `InvitationEnabled`
3. Claims from the external provider are mapped to the contact record using `RegistrationClaimsMapping`
4. Email is auto-confirmed for external providers (no manual verification needed)
5. If an invitation code is present, the user is linked to the pre-created contact

No client-side code is needed — the server handles the entire registration flow.

### Password Reset Flow (Local Authentication)

Power Pages provides a server-side password reset flow for local authentication:

1. User navigates to `/Account/Login/ForgotPassword` (server-rendered form)
2. User enters their email address
3. Server generates a reset token and sends an email via the `adx_SendPasswordResetToContact` process
4. User clicks the email link → navigates to `/Account/Login/ResetPassword` with the token
5. User enters a new password → server validates the token and updates the password

This flow is entirely server-rendered — no client-side code is needed. It is controlled by:
- `Authentication/Registration/ResetPasswordEnabled` — enable/disable password reset (`true`/`false`)
- `Authentication/Registration/ResetPasswordRequiresConfirmedEmail` — require confirmed email before allowing reset

When local authentication is configured, add a "Forgot password?" link in the `LocalLoginForm` component pointing to `/Account/Login/ForgotPassword`.

### Logout Flow (All Providers)

1. Redirect the user to `/Account/Login/LogOff`
2. Power Pages server:
   - Clears session cookies (`ApplicationCookie`, `ExternalCookie`, `TwoFactorCookie`)
   - If `SignOutEverywhereEnabled` is true, updates the security stamp to invalidate all sessions across devices
   - Clears the `DeferredLocalLoginCookie` if present
   - Sends `Clear-Site-Data: "cache"` header
3. `window.Microsoft.Dynamic365.Portal.User` becomes `undefined`
4. For OIDC providers with `RPInitiatedLogout` enabled, the server redirects to the provider's `end_session_endpoint` with an `id_token_hint` for federated single sign-out
5. For other providers with `ExternalLogoutEnabled`, the server signs out of the provider's authentication type
6. Finally, redirects to the `returnUrl` or site root

> **`ExternalLogoutEnabled` vs `RPInitiatedLogout`**: These are mutually exclusive. When `RPInitiatedLogout` is `true`, the server forces `ExternalLogoutEnabled` to `false`. RP-initiated logout is the newer, preferred approach for OIDC providers — it sends an `id_token_hint` to the provider's `end_session_endpoint`. Use `ExternalLogoutEnabled` only for providers that don't support RP-initiated logout.

### Terms & Conditions Flow

If `Authentication/Registration/TermsAgreementEnabled` is `true`, after successful authentication (before the session is fully established), the server redirects new users to `/Account/Login/TermsAndConditions`. The user must accept the terms before proceeding. This is a server-rendered page — no client-side code is needed.

### External Authentication Failure (ExternalAuthenticationFailed page)

When an OIDC/SAML2/WS-Fed authentication fails (invalid token, issuer mismatch, IdX errors, user access denied, etc.), the server redirects to a hardcoded path: `/Account/Login/ExternalAuthenticationFailed`. **This path cannot be overridden via site settings or site markers** — it is baked into OWIN startup. The only query parameter ever appended is `?message=access_denied` (for user-denied errors); all other error details are logged to server telemetry only.

**SPA workaround — content snippet redirect:** To keep the user inside the SPA on auth failure, edit the Dataverse content snippets used by this page to inject a `<script>` that redirects to an SPA route with the error:

1. In the Power Pages admin center, edit these two content snippets:
   - `Account/Register/ExternalAuthenticationFailed` (generic auth failure)
   - `Account/Register/ExternalAuthenticationFailed/AccessDenied` (user-denied case)

2. Add this script to the HTML content:

   ```html
   <script>
     (function() {
       var params = new URLSearchParams(window.location.search);
       var code = params.get('message') === 'access_denied' ? 'access_denied' : 'signin_failed';
       // Redirect to SPA login page with error code
       window.location.replace('/login?message=' + code);
     })();
   </script>
   ```

3. The SPA `/login` page's `getAuthError()` will pick up the `?message=` query param and display the error inline (via the AUTH_ERROR_MESSAGES map).

**Limitations:**
- Only `access_denied` vs. generic `signin_failed` distinction is preserved — rich error codes (`AADSTS*`, `IDX*`) are not available client-side
- The server-rendered error page briefly flashes before the script redirects
- Operators must still use Kusto/telemetry to investigate actual error causes

### External Password Reset Flow (OIDC Providers with PasswordResetPolicyId)

For OIDC providers that have a `PasswordResetPolicyId` configured (e.g., Azure AD B2C):

1. User clicks "Forgot password?" on the IdP's sign-in page
2. The IdP returns an error (e.g., `AADB2C90118` for B2C)
3. Server catches the error and redirects to `/Account/Login/ExternalPasswordReset?passwordResetPolicyId={policy}&provider={provider}`
4. The server challenges the provider with the password reset policy
5. After reset, user is redirected back to the login page

This is entirely server-managed — no client-side code is needed.

### External Profile Edit Flow (OIDC Providers with ProfileEditPolicyId)

For OIDC providers that have a `ProfileEditPolicyId` configured:

1. User navigates to `/Account/Login/ExternalProfileEdit`
2. Server challenges the provider with the profile edit policy
3. Provider shows the profile edit form (e.g., B2C profile edit flow)
4. After edit completes, `LoginClaimsMapping` is applied to sync updated claims back to the contact record

This is entirely server-managed. The client can link to `/Account/Login/ExternalProfileEdit` to trigger it.

### Invitation Redemption Flow

For invitation-based registration:

1. Admin creates an invitation in the Power Pages admin center and shares the invitation link
2. Invitation link format: `{site-url}/Account/Login/RedeemInvitation?InvitationCode={code}&returnUrl=/`
3. Server validates the invitation code and redirects to the login page with the code threaded through
4. After authentication (local or external), the server links the user to the pre-created contact associated with the invitation

The client-side `login()` and `register()` functions already support passing `invitationCode` through the auth flow.

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

Power Pages provides server-rendered account management pages. These are NOT part of the client-side auth service — they are server-side ASP.NET views. The client can link to these URLs:

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

## Type Declarations

Create `src/types/powerPages.d.ts`:

```typescript
/**
 * Power Pages portal user object.
 * Available at window.Microsoft.Dynamic365.Portal.User when authenticated.
 */
export interface PowerPagesUser {
  userName: string;
  firstName: string;
  lastName: string;
  email: string;
  contactId: string;
  userRoles: string[];
}

/**
 * Power Pages portal configuration object.
 * Available at window.Microsoft.Dynamic365.Portal.
 */
export interface PowerPagesPortal {
  User: PowerPagesUser | undefined;
  version: string;
  type: string;
  id: string;
  geo: string;
  tenant: string;
  correlationId: string;
  orgEnvironmentId: string;
  orgId: string;
  portalProductionOrTrialType: string;
  isTelemetryEnabled: boolean;
  InstrumentationSettings: Record<string, unknown>;
  timerProfileForBatching: Record<string, unknown>;
  activeLanguages: unknown[];
  isClientApiEnabled: boolean;
}

interface MicrosoftNamespace {
  Dynamic365: {
    Portal: PowerPagesPortal;
  };
}

declare global {
  interface Window {
    Microsoft: MicrosoftNamespace;
  }
}
```

---

## Auth Service

Create `src/services/authService.ts`:

```typescript
import type { PowerPagesUser } from '../types/powerPages';

// --- Provider Configuration ---
// Change this to match the identity provider configured for your Power Pages site.
// See the comments above each provider type for the correct providerIdentifier.

export type AuthProviderType =
  | 'entra-id'
  | 'oidc'
  | 'saml2'
  | 'ws-federation'
  | 'local'
  | 'social'
  | 'entra-external-id';

export interface AuthProviderConfig {
  type: AuthProviderType;
  providerIdentifier?: string;
  displayName?: string;
  /** For local login: when true, sends Email field instead of Username */
  loginByEmail?: boolean;
}

// DEFAULT: Microsoft Entra ID. Change this for other providers.
const AUTH_PROVIDER: AuthProviderConfig = {
  type: 'entra-id',
  displayName: 'Sign In',
};

const isDevelopment =
  typeof window !== 'undefined' &&
  (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');

// Mock user for local development — auth only works on deployed Power Pages sites
const MOCK_USER: PowerPagesUser = {
  userName: 'dev@contoso.com',
  firstName: 'Dev',
  lastName: 'User',
  email: 'dev@contoso.com',
  contactId: '00000000-0000-0000-0000-000000000001',
  userRoles: ['Authenticated Users', 'Administrators'],
};

// Track mock sign-out state in dev mode (persists across page reloads via sessionStorage)
const DEV_SIGNEDOUT_KEY = '__pp_dev_signedout__';

/**
 * Returns the configured authentication provider.
 */
export function getAuthProvider(): AuthProviderConfig {
  return AUTH_PROVIDER;
}

/**
 * Returns the currently logged-in user, or undefined if not authenticated.
 */
export function getCurrentUser(): PowerPagesUser | undefined {
  if (typeof window === 'undefined') return undefined; // SSR guard (Astro)
  if (isDevelopment) {
    // In dev mode, respect mock sign-out state
    if (sessionStorage.getItem(DEV_SIGNEDOUT_KEY)) return undefined;
    return MOCK_USER;
  }
  return window.Microsoft?.Dynamic365?.Portal?.User;
}

/**
 * Returns true if a user is currently logged in.
 */
export function isAuthenticated(): boolean {
  const user = getCurrentUser();
  return !!user?.userName;
}

/**
 * Returns the Entra ID tenant ID from the portal configuration.
 * Only applicable for Entra ID provider type.
 */
export function getTenantId(): string | undefined {
  if (isDevelopment) return '00000000-0000-0000-0000-000000000000';
  return window.Microsoft?.Dynamic365?.Portal?.tenant;
}

/**
 * Fetches the anti-forgery token required for login form POSTs.
 * The token is embedded in an HTML response from /_layout/tokenhtml.
 */
export async function fetchAntiForgeryToken(): Promise<string> {
  const response = await fetch('/_layout/tokenhtml');
  if (!response.ok) {
    throw new Error(
      `Failed to fetch anti-forgery token: ${response.status} ${response.statusText}. ` +
      'Ensure the site is deployed and accessible.'
    );
  }
  const html = await response.text();
  const match = html.match(/value="([^"]+)"/);
  if (!match) {
    throw new Error('Failed to extract anti-forgery token from /_layout/tokenhtml');
  }
  return match[1];
}

/**
 * Resolves the provider identifier for the external login form POST.
 * Different provider types use different identifiers.
 */
function resolveProviderIdentifier(): string {
  if (AUTH_PROVIDER.providerIdentifier) {
    return AUTH_PROVIDER.providerIdentifier;
  }

  switch (AUTH_PROVIDER.type) {
    case 'entra-id': {
      const tenantId = getTenantId();
      if (!tenantId) {
        throw new Error(
          'Tenant ID not found in portal configuration. ' +
          'Ensure the site is properly deployed and window.Microsoft.Dynamic365.Portal.tenant is set.'
        );
      }
      return `https://login.windows.net/${tenantId}/`;
    }
    case 'entra-external-id':
      throw new Error(
        'providerIdentifier must be set in AUTH_PROVIDER config for Entra External ID. ' +
        'Use the AuthenticationType value from your External ID site settings.'
      );
    default:
      throw new Error(
        `providerIdentifier must be set in AUTH_PROVIDER config for type "${AUTH_PROVIDER.type}"`
      );
  }
}

/**
 * Initiates login based on the configured provider type.
 *
 * - External providers (Entra ID, OIDC, SAML2, WS-Federation, Social):
 *   Posts a form to /Account/Login/ExternalLogin which redirects to the identity provider.
 *
 * - Local authentication: Posts credentials to /Account/Login/Login.
 *   Requires username/email and password parameters.
 *
 * @param returnUrl - URL to return to after successful login (defaults to current page)
 * @param credentials - For local login only: { username, password, rememberMe }
 * @param invitationCode - Optional invitation code for invitation-based registration
 */
export async function login(
  returnUrl?: string,
  credentials?: { username: string; password: string; rememberMe?: boolean },
  invitationCode?: string
): Promise<void> {
  if (isDevelopment) {
    // Clear sign-out state so mock user comes back
    sessionStorage.removeItem(DEV_SIGNEDOUT_KEY);
    window.location.reload();
    return;
  }

  const token = await fetchAntiForgeryToken();

  if (AUTH_PROVIDER.type === 'local') {
    // Local login: use fetch() to POST credentials so we can parse server errors
    // and keep the user in the SPA. Do NOT use form.submit() — it navigates away.
    if (!credentials) {
      throw new Error('Local login requires username and password credentials.');
    }

    const credentialFieldName = AUTH_PROVIDER.loginByEmail ? 'Email' : 'Username';

    const body = new URLSearchParams();
    body.set('__RequestVerificationToken', token);
    body.set(credentialFieldName, credentials.username);
    body.set('PasswordValue', credentials.password); // Server uses PasswordValue, not Password
    body.set('ReturnUrl', returnUrl || '/');
    if (credentials.rememberMe) body.set('RememberMe', 'true');
    if (invitationCode) body.set('InvitationCode', invitationCode);

    const response = await fetch('/SignIn', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      credentials: 'same-origin',
      redirect: 'follow',
    });

    // If the fetch followed a redirect to our ReturnUrl, login succeeded — reload to pick up session
    if (response.redirected || response.url.endsWith(returnUrl || '/')) {
      window.location.href = returnUrl || '/';
      return;
    }

    // If we got a 200, the server returned the login page with errors — parse them
    const html = await response.text();
    const errors = parseServerErrors(html);
    if (errors.length > 0) {
      throw new Error(errors.join(' '));
    }

    throw new Error('Invalid email or password. Please try again.');
  }

  // External login: POST to ExternalLogin endpoint with provider identifier
  const provider = resolveProviderIdentifier();

  const form = document.createElement('form');
  form.method = 'POST';
  // Append invitation code as query parameter for external login if present
  form.action = invitationCode
    ? `/Account/Login/ExternalLogin?InvitationCode=${encodeURIComponent(invitationCode)}`
    : '/Account/Login/ExternalLogin';

  const fields: Record<string, string> = {
    __RequestVerificationToken: token,
    provider,
    returnUrl: returnUrl || window.location.pathname,
  };

  for (const [name, value] of Object.entries(fields)) {
    const input = document.createElement('input');
    input.type = 'hidden';
    input.name = name;
    input.value = value;
    form.appendChild(input);
  }

  document.body.appendChild(form);
  form.submit();
}

/**
 * Logs the user out by redirecting to the Power Pages logout endpoint.
 *
 * @param returnUrl - URL to return to after logout (defaults to site root)
 */
export function logout(returnUrl?: string): void {
  if (isDevelopment) {
    sessionStorage.setItem(DEV_SIGNEDOUT_KEY, '1');
    window.location.reload();
    return;
  }

  const target = returnUrl || '/';
  window.location.href = `/Account/Login/LogOff?returnUrl=${encodeURIComponent(target)}`;
}

// --- Auth Error Handling ---

/**
 * Error codes returned by the Power Pages server via query string parameters.
 * The server redirects back to the login page with ?message=<code> or ?error=<code>.
 */
const AUTH_ERROR_MESSAGES: Record<string, string> = {
  access_denied: 'Access was denied by the identity provider.',
  missing_license: 'Your account does not have the required license.',
  invalid_login: 'Invalid login. Please try again.',
  invalid_username_or_password: 'Invalid username or password.',
  user_locked: 'Your account has been locked due to too many failed attempts. Please try again later.',
  too_many_attempts: 'Too many failed login attempts. Please try again later.',
  invalid_invitation: 'The invitation code is invalid or has expired.',
  duplicate_login: 'This external identity is already linked to another account.',
  registration_blocked: 'Registration is not available for this provider.',
  signin_failed: 'Sign-in failed. Please try again.',
  email_required: 'An email address is required.',
  username_required: 'A username is required.',
  password_required: 'A password is required.',
  password_confirmation_failure: 'Passwords do not match.',
  invalid_two_factor_code: 'The verification code is invalid.',
  duplicate_email: 'This email address is already in use.',
  duplicate_username: 'This username is already taken.',
  deny_minors: 'Registration is not available for users under the minimum age.',
};

/**
 * Parses authentication error from the current page URL.
 * The Power Pages server passes errors via ?message= or ?error= query parameters
 * when redirecting back to the login page after a failed authentication attempt.
 *
 * @returns The user-friendly error message, or undefined if no error.
 */
export function getAuthError(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  const params = new URLSearchParams(window.location.search);
  const message = params.get('message') || params.get('error');
  if (!message) return undefined;
  return AUTH_ERROR_MESSAGES[message] || 'An authentication error occurred. Please try again.';
}

// --- Server Error Parsing ---
// When the server rejects a login/registration POST, it returns 200 with HTML containing
// validation errors. This helper parses those errors from the response HTML so they can
// be shown inline in the SPA instead of the user seeing the server-rendered error page.

function parseServerErrors(html: string): string[] {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  const errors: string[] = [];

  // MVC validation summary (login, forgot password)
  doc.querySelectorAll('.validation-summary-errors li').forEach(li => {
    const text = li.textContent?.trim();
    if (text) errors.push(text);
  });

  // Web Forms validation summary (registration)
  doc.querySelectorAll('.alert-danger li').forEach(li => {
    const text = li.textContent?.trim();
    if (text && !errors.includes(text)) errors.push(text);
  });

  // Individual field errors
  doc.querySelectorAll('.field-validation-error').forEach(el => {
    const text = el.textContent?.trim();
    if (text && !errors.includes(text)) errors.push(text);
  });

  return errors;
}

// --- Local Registration ---

/**
 * Registers a new local user via the server-rendered /Account/Login/Register page.
 *
 * IMPORTANT: The registration page is an ASP.NET Web Forms page (not MVC like login).
 * It requires __VIEWSTATE and uses fully-qualified control names (e.g., ctl00$...$EmailTextBox).
 * This function fetches the server page first, parses the ViewState and control names,
 * then POSTs back with the user's data — the same flow a browser performs when submitting the form.
 *
 * This differs from login, which is an MVC action accepting simple field names.
 */
export async function register(
  fields: { email?: string; username?: string; password: string; confirmPassword: string },
  returnUrl?: string,
  invitationCode?: string
): Promise<void> {
  if (!fields.email && !fields.username) {
    throw new Error('Registration requires either an email or username.');
  }

  if (isDevelopment) {
    sessionStorage.removeItem(DEV_SIGNEDOUT_KEY);
    window.location.reload();
    return;
  }

  // Step 1: Fetch the server-rendered registration page to get ViewState and field names
  const params = new URLSearchParams();
  if (returnUrl) params.set('returnUrl', returnUrl);
  if (invitationCode) params.set('invitationCode', invitationCode);
  const qs = params.toString();
  const regUrl = `/Account/Login/Register${qs ? `?${qs}` : ''}`;

  const pageResponse = await fetch(regUrl, { credentials: 'same-origin' });
  if (!pageResponse.ok) {
    throw new Error(`Failed to load registration page: ${pageResponse.status}`);
  }

  const pageHtml = await pageResponse.text();
  const parser = new DOMParser();
  const doc = parser.parseFromString(pageHtml, 'text/html');

  // Step 2: Extract the form element and resolve the action URL
  const serverForm = doc.getElementById('Register') as HTMLFormElement | null;
  if (!serverForm) {
    throw new Error('Registration form not found on the server page.');
  }

  // The server form has a relative action like "./Register?msCorrelationId=..."
  // Resolve it relative to /Account/Login/ (the server page's path), NOT the SPA's current URL.
  const rawAction = serverForm.getAttribute('action') || '';
  let formAction: string;
  if (rawAction.startsWith('http') || rawAction.startsWith('/')) {
    formAction = rawAction;
  } else {
    const base = new URL('/Account/Login/', window.location.origin);
    formAction = new URL(rawAction, base).pathname + new URL(rawAction, base).search;
  }

  // Step 3: Extract ViewState, anti-forgery token, and other hidden fields
  const viewState = (doc.getElementById('__VIEWSTATE') as HTMLInputElement)?.value || '';
  const viewStateGenerator = (doc.getElementById('__VIEWSTATEGENERATOR') as HTMLInputElement)?.value || '';
  const eventValidation = (doc.querySelector('input[name="__EVENTVALIDATION"]') as HTMLInputElement)?.value || '';
  const antiForgeryToken = (doc.querySelector('input[name="__RequestVerificationToken"]') as HTMLInputElement)?.value || '';

  // Step 4: Find the correct Web Forms control names by their IDs
  const emailInput = doc.getElementById('EmailTextBox') as HTMLInputElement | null;
  const usernameInput = doc.getElementById('UsernameTextBox') as HTMLInputElement | null;
  const passwordInput = doc.getElementById('PasswordTextBox') as HTMLInputElement | null;
  const confirmInput = doc.getElementById('ConfirmPasswordTextBox') as HTMLInputElement | null;
  const submitBtn = doc.getElementById('SubmitButton') as HTMLInputElement | null;

  // Step 5: Build the POST body with Web Forms field names
  const body = new URLSearchParams();
  body.set('__VIEWSTATE', viewState);
  body.set('__VIEWSTATEGENERATOR', viewStateGenerator);
  body.set('__EVENTTARGET', '');
  body.set('__EVENTARGUMENT', '');
  body.set('__VIEWSTATEENCRYPTED', '');

  if (eventValidation) body.set('__EVENTVALIDATION', eventValidation);
  if (antiForgeryToken) body.set('__RequestVerificationToken', antiForgeryToken);

  if (fields.email && emailInput) body.set(emailInput.name, fields.email);
  if (fields.username && usernameInput) body.set(usernameInput.name, fields.username);
  if (passwordInput) body.set(passwordInput.name, fields.password);
  if (confirmInput) body.set(confirmInput.name, fields.confirmPassword);
  if (submitBtn) body.set(submitBtn.name, submitBtn.value || 'Register');

  // Step 6: POST via fetch() to stay in the SPA and parse server errors
  const response = await fetch(formAction, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    credentials: 'same-origin',
    redirect: 'follow',
  });

  // If the fetch followed a redirect, registration succeeded
  if (response.redirected) {
    window.location.href = response.url;
    return;
  }

  // If we got a 200, the server returned the page with errors — parse them
  const responseHtml = await response.text();
  const errors = parseServerErrors(responseHtml);
  if (errors.length > 0) {
    throw new Error(errors.join(' '));
  }

  if (response.url !== window.location.href) {
    window.location.href = response.url;
    return;
  }

  throw new Error('Registration failed. Please try again.');
}

// --- Forgot Password ---
// MVC form POST (like login, not Web Forms like registration).
// Posts Email + anti-forgery token to /Account/Login/ForgotPassword.
// Server sends a reset email. The reset link goes to the server-rendered
// /Account/Login/ResetPassword page (stays server-side since user arrives from email).

export async function forgotPassword(email: string): Promise<void> {
  if (isDevelopment) {
    alert('Dev mode: Password reset email would be sent to ' + email);
    return;
  }

  const token = await fetchAntiForgeryToken();

  const body = new URLSearchParams();
  body.set('__RequestVerificationToken', token);
  body.set('Email', email);

  const response = await fetch('/Account/Login/ForgotPassword', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    credentials: 'same-origin',
    redirect: 'follow',
  });

  // The server always returns 200 with a confirmation page (even if the email doesn't exist,
  // for security — it doesn't reveal whether an account exists). Parse for errors just in case.
  const html = await response.text();
  const errors = parseServerErrors(html);
  if (errors.length > 0) {
    throw new Error(errors.join(' '));
  }

  // No errors = success. The server sent the email.
}

/**
 * Returns the user's display name, using the following fallback order:
 *   1. firstName + lastName (if both present)
 *   2. firstName alone (if only first name present)
 *   3. userName (NameIdentifier/sub claim — always populated after login)
 *   4. email (fallback if userName is empty for some reason)
 *   5. 'User' (final fallback)
 *
 * Why the fallbacks: Power Pages populates `firstName`, `lastName`, and `email` from standard
 * OIDC claims (`given_name`, `family_name`, `email`) by default — no explicit RegistrationClaimsMapping
 * is needed for these standard claims. However, a field can still be empty if the IdP did not emit
 * the claim. Only `contactId` and `userName` are truly guaranteed to be populated.
 */
export function getUserDisplayName(): string {
  const user = getCurrentUser();
  if (!user) return '';
  const fullName = [user.firstName, user.lastName].filter(Boolean).join(' ');
  if (fullName) return fullName;
  if (user.firstName) return user.firstName;
  if (user.userName) return user.userName;
  if (user.email) return user.email;
  return 'User';
}

/**
 * Returns the user's initials for avatar display.
 * Falls back from first+last to first alone to userName/email first character.
 */
export function getUserInitials(): string {
  const user = getCurrentUser();
  if (!user) return '';
  if (user.firstName && user.lastName) {
    return `${user.firstName[0]}${user.lastName[0]}`.toUpperCase();
  }
  if (user.firstName) return user.firstName[0].toUpperCase();
  const fallback = user.userName || user.email || '';
  return (fallback[0] || '').toUpperCase();
}
```

---

## Provider-Specific AUTH_PROVIDER Configuration Examples

When creating the auth service, set the `AUTH_PROVIDER` constant based on the user's chosen provider:

### Microsoft Entra ID (Default)

```typescript
const AUTH_PROVIDER: AuthProviderConfig = {
  type: 'entra-id',
  displayName: 'Sign in with Microsoft',
};
```

### OpenID Connect (Generic)

```typescript
const AUTH_PROVIDER: AuthProviderConfig = {
  type: 'oidc',
  providerIdentifier: 'https://your-oidc-provider.com/', // Must match AuthenticationType site setting
  displayName: 'Sign in with Okta',
};
```

### SAML2

```typescript
const AUTH_PROVIDER: AuthProviderConfig = {
  type: 'saml2',
  providerIdentifier: 'https://contoso.powerappsportals.com/', // Must match AuthenticationType site setting EXACTLY
  displayName: 'Sign in with ADFS',
};
```

> **IMPORTANT:** The `providerIdentifier` value MUST be character-for-character identical to the `Authentication/SAML2/{name}/AuthenticationType` site setting value, including the protocol (`https://` vs `http://`), trailing slashes, and casing. A mismatch causes the ExternalLogin POST to silently fail because the server cannot match the provider.

### WS-Federation

```typescript
const AUTH_PROVIDER: AuthProviderConfig = {
  type: 'ws-federation',
  providerIdentifier: 'https://adfs.contoso.com/adfs/services/trust', // Must match AuthenticationType site setting
  displayName: 'Sign in with WS-Federation',
};
```

### Local Authentication

```typescript
const AUTH_PROVIDER: AuthProviderConfig = {
  type: 'local',
  displayName: 'Sign In',
  loginByEmail: true, // Set to true when Authentication/Registration/LocalLoginByEmail is true
};
```

### Social OAuth Providers (Single Provider)

```typescript
// Microsoft Account
const AUTH_PROVIDER: AuthProviderConfig = {
  type: 'social',
  providerIdentifier: 'urn:microsoft:account',
  displayName: 'Sign in with Microsoft',
};

// Facebook
const AUTH_PROVIDER: AuthProviderConfig = {
  type: 'social',
  providerIdentifier: 'Facebook',
  displayName: 'Sign in with Facebook',
};

// Google
const AUTH_PROVIDER: AuthProviderConfig = {
  type: 'social',
  providerIdentifier: 'Google',
  displayName: 'Sign in with Google',
};
```

### Multiple Providers (Any Combination)

When the user selects multiple providers (e.g., Google + Facebook, or Entra External ID + Local Auth), use the `AUTH_PROVIDERS` array pattern. This works for **any combination** of provider types — social, external, or mixed with local.

```typescript
export interface ProviderConfig {
  type: AuthProviderType;
  providerIdentifier?: string;
  displayName: string;
  loginByEmail?: boolean; // Only for local providers
}

/**
 * Multiple providers configuration.
 * Each entry maps to a login method — external providers use ExternalLogin,
 * local providers use the credential form.
 */
export const AUTH_PROVIDERS: ProviderConfig[] = [
  { type: 'entra-external-id', providerIdentifier: 'https://contoso.ciamlogin.com/contoso.onmicrosoft.com/v2.0/', displayName: 'Sign in with External ID' },
  { type: 'local', displayName: 'Sign in with Email', loginByEmail: true },
];

// Default AUTH_PROVIDER for single-provider code paths — uses first provider
if (AUTH_PROVIDERS.length === 0) {
  throw new Error('AUTH_PROVIDERS array is empty. Configure at least one authentication provider.');
}
const AUTH_PROVIDER: AuthProviderConfig = {
  type: AUTH_PROVIDERS[0].type,
  providerIdentifier: AUTH_PROVIDERS[0].providerIdentifier,
  displayName: AUTH_PROVIDERS[0].displayName,
  loginByEmail: AUTH_PROVIDERS[0].loginByEmail,
};

/**
 * Initiates login with a specific provider from the AUTH_PROVIDERS array.
 * Handles both external providers (ExternalLogin) and local providers (Login).
 * Use this instead of login() when multiple providers are configured.
 */
export async function loginWithProvider(
  providerIdentifier: string,
  returnUrl?: string,
  credentials?: { username: string; password: string; rememberMe?: boolean },
  invitationCode?: string
): Promise<void> {
  if (isDevelopment) {
    sessionStorage.removeItem(DEV_SIGNEDOUT_KEY);
    window.location.reload();
    return;
  }

  const token = await fetchAntiForgeryToken();

  // Find the provider config to determine if it's local or external
  const providerConfig = AUTH_PROVIDERS.find(p =>
    p.type === 'local' ? providerIdentifier === 'local' : p.providerIdentifier === providerIdentifier
  );

  // Local provider: POST credentials to /Account/Login/Login
  if (providerConfig?.type === 'local') {
    if (!credentials) {
      throw new Error('Local login requires username and password credentials.');
    }
    // Use fetch() to stay in the SPA and parse server errors
    const credentialFieldName = providerConfig.loginByEmail ? 'Email' : 'Username';
    const body = new URLSearchParams();
    body.set('__RequestVerificationToken', token);
    body.set(credentialFieldName, credentials.username);
    body.set('PasswordValue', credentials.password);
    body.set('ReturnUrl', returnUrl || '/');
    if (credentials.rememberMe) body.set('RememberMe', 'true');
    if (invitationCode) body.set('InvitationCode', invitationCode);

    const response = await fetch('/SignIn', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      credentials: 'same-origin',
      redirect: 'follow',
    });

    if (response.redirected || response.url.endsWith(returnUrl || '/')) {
      window.location.href = returnUrl || '/';
      return;
    }

    const html = await response.text();
    const errors = parseServerErrors(html);
    if (errors.length > 0) throw new Error(errors.join(' '));
    throw new Error('Invalid credentials. Please try again.');
    return;
  }

  // External provider: POST to /Account/Login/ExternalLogin
  const form = document.createElement('form');
  form.method = 'POST';
  form.action = invitationCode
    ? `/Account/Login/ExternalLogin?InvitationCode=${encodeURIComponent(invitationCode)}`
    : '/Account/Login/ExternalLogin';

  const fields: Record<string, string> = {
    __RequestVerificationToken: token,
    provider: providerIdentifier,
    returnUrl: returnUrl || window.location.pathname,
  };

  for (const [name, value] of Object.entries(fields)) {
    const input = document.createElement('input');
    input.type = 'hidden';
    input.name = name;
    input.value = value;
    form.appendChild(input);
  }

  document.body.appendChild(form);
  form.submit();
}
```

**Multi-Provider Login Page Component (React):**

When multiple providers are configured (including mixed external + local), all providers appear as buttons. External providers redirect immediately on click. The local provider button expands an inline credential form for username/email and password input.

```tsx
import { useState, useEffect } from 'react';
import { AUTH_PROVIDERS, loginWithProvider, getAuthError } from '../services/authService';
import { useAuth } from '../hooks/useAuth';
import './AuthButton.css';

export function AuthButton() {
  const { isAuthenticated, isLoading, displayName, initials, logout } = useAuth();
  const [showLocalForm, setShowLocalForm] = useState(false);
  const [credential, setCredential] = useState('');
  const [password, setPassword] = useState('');
  const [rememberMe, setRememberMe] = useState(false);
  const [error, setError] = useState('');

  // Check for server-side auth errors (e.g., after failed external login redirect)
  useEffect(() => {
    const serverError = getAuthError();
    if (serverError) setError(serverError);
  }, []);

  if (isLoading) {
    return <div className="auth-button auth-loading"><span className="auth-spinner" /></div>;
  }

  if (isAuthenticated) {
    return (
      <div className="auth-button auth-signed-in">
        <span className="auth-avatar">{initials}</span>
        <span className="auth-name">{displayName}</span>
        <button className="auth-sign-out" onClick={() => logout()}>Sign Out</button>
      </div>
    );
  }

  const externalProviders = AUTH_PROVIDERS.filter(p => p.type !== 'local');
  const localProvider = AUTH_PROVIDERS.find(p => p.type === 'local');

  return (
    <div className="auth-button auth-providers">
      {/* Server-side auth error display */}
      {error && <div className="form-error" role="alert">{error}</div>}

      {/* External provider buttons — clicking redirects to the identity provider */}
      {externalProviders.map((provider) => (
        <button
          key={provider.providerIdentifier}
          className="auth-sign-in auth-external-btn"
          onClick={() => loginWithProvider(provider.providerIdentifier!)}
        >
          {provider.displayName}
        </button>
      ))}

      {/* Local login — button that expands to show credential form on click */}
      {localProvider && !showLocalForm && (
        <button
          className="auth-sign-in auth-local-btn"
          onClick={() => setShowLocalForm(true)}
        >
          {localProvider.displayName}
        </button>
      )}

      {localProvider && showLocalForm && (
        <form className="auth-local-form" onSubmit={async (e) => {
          e.preventDefault();
          await loginWithProvider('local', undefined, { username: credential, password, rememberMe });
        }}>
          <input
            type={localProvider.loginByEmail ? 'email' : 'text'}
            placeholder={localProvider.loginByEmail ? 'Email' : 'Username'}
            value={credential} onChange={(e) => setCredential(e.target.value)} required
            autoFocus
          />
          <input type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          <label><input type="checkbox" checked={rememberMe} onChange={(e) => setRememberMe(e.target.checked)} /> Remember me</label>
          <div className="auth-local-actions">
            <button type="submit">{localProvider.displayName}</button>
            <button type="button" className="auth-back-btn" onClick={() => setShowLocalForm(false)}>Back</button>
          </div>
          <a href="/Account/Login/ForgotPassword" className="auth-forgot-password">Forgot password?</a>
          {/* Only show registration link when OpenRegistrationEnabled is true */}
        </form>
      )}
    </div>
  );
}
```

### Entra External ID

```typescript
const AUTH_PROVIDER: AuthProviderConfig = {
  type: 'entra-external-id',
  providerIdentifier: 'https://contoso.ciamlogin.com/contoso.onmicrosoft.com/v2.0/', // Must match AuthenticationType site setting
  displayName: 'Sign in with External ID',
};
```

---

## Framework-Specific Patterns

### React: useAuth Hook

Create `src/hooks/useAuth.ts`:

```typescript
import { useState, useEffect, useCallback } from 'react';
import type { PowerPagesUser } from '../types/powerPages';
import {
  getCurrentUser,
  isAuthenticated as checkAuth,
  getUserDisplayName,
  getUserInitials,
  getAuthProvider,
  login as authLogin,
  logout as authLogout,
} from '../services/authService';

interface UseAuthReturn {
  user: PowerPagesUser | undefined;
  isAuthenticated: boolean;
  isLoading: boolean;
  displayName: string;
  initials: string;
  providerType: string;
  providerDisplayName: string;
  login: (returnUrl?: string, credentials?: { username: string; password: string; rememberMe?: boolean }, invitationCode?: string) => Promise<void>;
  logout: (returnUrl?: string) => void;
  refresh: () => void;
}

export function useAuth(): UseAuthReturn {
  const [user, setUser] = useState<PowerPagesUser | undefined>(undefined);
  const [isLoading, setIsLoading] = useState(true);

  const refresh = useCallback(() => {
    setUser(getCurrentUser());
    setIsLoading(false);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const provider = getAuthProvider();

  return {
    user,
    isAuthenticated: checkAuth(),
    isLoading,
    displayName: getUserDisplayName(),
    initials: getUserInitials(),
    providerType: provider.type,
    providerDisplayName: provider.displayName || 'Sign In',
    login: authLogin,
    logout: authLogout,
    refresh,
  };
}
```

### React: AuthButton Component

Create `src/components/AuthButton.tsx`:

```tsx
import { useAuth } from '../hooks/useAuth';
import './AuthButton.css';

export function AuthButton() {
  const { isAuthenticated, isLoading, displayName, initials, providerDisplayName, login, logout } = useAuth();

  if (isLoading) {
    return <div className="auth-button auth-loading"><span className="auth-spinner" /></div>;
  }

  if (!isAuthenticated) {
    return (
      <button className="auth-button auth-sign-in" onClick={() => login()}>
        {providerDisplayName}
      </button>
    );
  }

  return (
    <div className="auth-button auth-signed-in">
      <span className="auth-avatar">{initials}</span>
      <span className="auth-name">{displayName}</span>
      <button className="auth-sign-out" onClick={() => logout()}>
        Sign Out
      </button>
    </div>
  );
}
```

### React: LocalLoginForm Component (Local Auth Only)

When the provider type is `local`, also create `src/components/LocalLoginForm.tsx`. This component handles:
- Login with email or username (based on `loginByEmail` setting)
- Server-side auth error display (parsed from `?message=` query params)
- Link to forgot password page
- Link to registration page (when `OpenRegistrationEnabled` is true)

```tsx
import { useState, useEffect } from 'react';
import { login, getAuthProvider, getAuthError } from '../services/authService';
import './LocalLoginForm.css';

export function LocalLoginForm() {
  const [credential, setCredential] = useState('');
  const [password, setPassword] = useState('');
  const [rememberMe, setRememberMe] = useState(false);
  const [error, setError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const provider = getAuthProvider();
  const isEmailMode = provider.loginByEmail ?? true;

  // Check for server-side auth errors passed via URL query params
  useEffect(() => {
    const serverError = getAuthError();
    if (serverError) setError(serverError);
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setIsSubmitting(true);
    try {
      await login(undefined, { username: credential, password, rememberMe });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed. Please check your credentials.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <form className="local-login-form" onSubmit={handleSubmit}>
      {error && <div className="form-error" role="alert">{error}</div>}
      <div className="form-field">
        <label htmlFor="credential">{isEmailMode ? 'Email' : 'Username'}</label>
        <input
          id="credential"
          type={isEmailMode ? 'email' : 'text'}
          value={credential}
          onChange={(e) => setCredential(e.target.value)}
          required
          autoComplete={isEmailMode ? 'email' : 'username'}
        />
      </div>
      <div className="form-field">
        <label htmlFor="password">Password</label>
        <input
          id="password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          autoComplete="current-password"
        />
      </div>
      <div className="form-field form-checkbox">
        <label>
          <input
            type="checkbox"
            checked={rememberMe}
            onChange={(e) => setRememberMe(e.target.checked)}
          />
          Remember me
        </label>
      </div>
      <button type="submit" disabled={isSubmitting}>
        {isSubmitting ? 'Signing in...' : 'Sign In'}
      </button>
      <div className="form-links">
        <a href="/Account/Login/ForgotPassword">Forgot password?</a>
      </div>
    </form>
  );
}
```

> **Note on "Create an account" link:** Only add a registration link (`<a href="/registration">Create an account</a>`) to the login form when `OpenRegistrationEnabled` is `true`. Since this is a server-side setting, the skill should include the link when it creates the `LocalLoginForm` and the `OpenRegistrationEnabled` site setting is being set to `true`. If the user chose invitation-only registration (where `OpenRegistrationEnabled` is `false`), omit the link — users register via invitation links instead.

### React: RegisterForm Component (Local Auth Only)

When local authentication is configured, create `src/pages/Registration.tsx` and a `/registration` route (NOT `/register` — that path conflicts with the server's `/Register` route). This component handles new user registration with email/username and password. It calls the `register()` function from authService, which handles the Web Forms ViewState pattern internally.

> **Dev mode:** The registration page should skip the auth redirect when running on localhost, because the mock user is always "authenticated" and would prevent testing the form. Add: `const isDev = window.location.hostname === 'localhost'` and only redirect if `isAuthenticated && !isDev`.

```tsx
import { useState, useEffect } from 'react';
import { register, getAuthProvider, getAuthError } from '../services/authService';
import './LocalLoginForm.css';

export function RegisterForm() {
  const [credential, setCredential] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const provider = getAuthProvider();
  const isEmailMode = provider.loginByEmail ?? true;

  // Check for server-side registration errors passed via URL query params
  useEffect(() => {
    const serverError = getAuthError();
    if (serverError) setError(serverError);
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    setIsSubmitting(true);
    try {
      // Parse invitation code from URL if present
      const params = new URLSearchParams(window.location.search);
      const invitationCode = params.get('invitationCode') || undefined;

      await register(
        isEmailMode
          ? { email: credential, password, confirmPassword }
          : { username: credential, password, confirmPassword },
        '/',
        invitationCode
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Registration failed. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <form className="local-login-form" onSubmit={handleSubmit}>
      <h2>Create an Account</h2>
      {error && <div className="form-error" role="alert">{error}</div>}
      <div className="form-field">
        <label htmlFor="credential">{isEmailMode ? 'Email' : 'Username'}</label>
        <input
          id="credential"
          type={isEmailMode ? 'email' : 'text'}
          value={credential}
          onChange={(e) => setCredential(e.target.value)}
          required
          autoComplete={isEmailMode ? 'email' : 'username'}
        />
      </div>
      <div className="form-field">
        <label htmlFor="password">Password</label>
        <input
          id="password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          autoComplete="new-password"
        />
      </div>
      <div className="form-field">
        <label htmlFor="confirmPassword">Confirm Password</label>
        <input
          id="confirmPassword"
          type="password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          required
          autoComplete="new-password"
        />
      </div>
      <button type="submit" disabled={isSubmitting}>
        {isSubmitting ? 'Creating account...' : 'Create Account'}
      </button>
      <div className="form-links">
        <a href="/login">Already have an account? Sign in</a>
      </div>
    </form>
  );
}
```

Create `src/components/AuthButton.css`:

```css
.auth-button {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.auth-sign-in {
  padding: 0.5rem 1rem;
  border: 1px solid currentColor;
  border-radius: 0.375rem;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font-size: 0.875rem;
  transition: opacity 0.2s;
}

.auth-sign-in:hover {
  opacity: 0.8;
}

.auth-signed-in {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.auth-avatar {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 2rem;
  height: 2rem;
  border-radius: 50%;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  color: #fff;
  font-size: 0.75rem;
  font-weight: 600;
}

.auth-name {
  font-size: 0.875rem;
}

.auth-sign-out {
  padding: 0.25rem 0.5rem;
  border: none;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font-size: 0.75rem;
  opacity: 0.7;
  transition: opacity 0.2s;
}

.auth-sign-out:hover {
  opacity: 1;
}

.auth-spinner {
  display: inline-block;
  width: 1rem;
  height: 1rem;
  border: 2px solid currentColor;
  border-right-color: transparent;
  border-radius: 50%;
  animation: auth-spin 0.6s linear infinite;
}

@keyframes auth-spin {
  to { transform: rotate(360deg); }
}
```

### Vue 3: useAuth Composable

Create `src/composables/useAuth.ts`:

```typescript
import { ref, computed, onMounted } from 'vue';
import type { PowerPagesUser } from '../types/powerPages';
import {
  getCurrentUser,
  isAuthenticated as checkAuth,
  getUserDisplayName,
  getUserInitials,
  getAuthProvider,
  login as authLogin,
  logout as authLogout,
} from '../services/authService';

export function useAuth() {
  const user = ref<PowerPagesUser | undefined>(undefined);
  const isLoading = ref(true);

  const isAuthenticated = computed(() => checkAuth());
  const displayName = computed(() => getUserDisplayName());
  const initials = computed(() => getUserInitials());
  const provider = getAuthProvider();
  const providerType = computed(() => provider.type);
  const providerDisplayName = computed(() => provider.displayName || 'Sign In');

  function refresh() {
    user.value = getCurrentUser();
    isLoading.value = false;
  }

  onMounted(() => {
    refresh();
  });

  return {
    user,
    isAuthenticated,
    isLoading,
    displayName,
    initials,
    providerType,
    providerDisplayName,
    login: authLogin,
    logout: authLogout,
    refresh,
  };
}
```

### Angular: AuthService

Create `src/app/services/auth.service.ts`:

```typescript
import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import type { PowerPagesUser } from '../../types/powerPages';
import {
  getCurrentUser,
  isAuthenticated as checkAuth,
  getUserDisplayName,
  getUserInitials,
  getAuthProvider,
  login as authLogin,
  logout as authLogout,
  type AuthProviderConfig,
} from '../../services/authService';

@Injectable({ providedIn: 'root' })
export class AuthService {
  private userSubject = new BehaviorSubject<PowerPagesUser | undefined>(undefined);
  private loadingSubject = new BehaviorSubject<boolean>(true);

  user$ = this.userSubject.asObservable();
  isLoading$ = this.loadingSubject.asObservable();

  constructor() {
    this.refresh();
  }

  get isAuthenticated(): boolean {
    return checkAuth();
  }

  get displayName(): string {
    return getUserDisplayName();
  }

  get initials(): string {
    return getUserInitials();
  }

  get provider(): AuthProviderConfig {
    return getAuthProvider();
  }

  login(returnUrl?: string, credentials?: { username: string; password: string; rememberMe?: boolean }, invitationCode?: string): Promise<void> {
    return authLogin(returnUrl, credentials, invitationCode);
  }

  logout(returnUrl?: string): void {
    authLogout(returnUrl);
  }

  refresh(): void {
    this.userSubject.next(getCurrentUser());
    this.loadingSubject.next(false);
  }
}
```

### Vanilla JavaScript (Astro)

For Astro projects, use `src/services/authService.ts` directly in component scripts. No additional wrapper needed.

---

## Site Settings Reference

### Required: Disable Profile Redirect (All Providers)

Power Pages code sites do not have a built-in profile page. After login, Power Pages attempts to redirect to `/profile`, which returns a 404 on code sites. Disable this with a site setting:

**Site setting name:** `Authentication/Registration/ProfileRedirectEnabled`
**Value:** `false`

### General Registration Settings

| Setting | Value | Description |
|---------|-------|-------------|
| `Authentication/Registration/Enabled` | `true` | Enable user registration |
| `Authentication/Registration/ExternalLoginEnabled` | `true` | Enable external identity provider login |
| `Authentication/Registration/OpenRegistrationEnabled` | `true`/`false` | Allow self-registration |
| `Authentication/Registration/InvitationEnabled` | `true`/`false` | Allow invitation-based registration |
| `Authentication/Registration/LocalLoginEnabled` | `true`/`false` | Enable local username/password login |
| `Authentication/Registration/LocalLoginByEmail` | `true`/`false` | Allow login by email instead of username |
| `Authentication/Registration/RememberMeEnabled` | `true`/`false` | Show "Remember me" checkbox on login |
| `Authentication/Registration/TwoFactorEnabled` | `true`/`false` | Enable two-factor authentication |
| `Authentication/Registration/LoginButtonAuthenticationType` | `(provider)` | Default login button provider type |

### OpenID Connect Provider Settings

Pattern: `Authentication/OpenIdConnect/{ProviderName}/{SettingName}`

| Setting | Description |
|---------|-------------|
| `Authority` | The OIDC authority URL (metadata endpoint base) |
| `ClientId` | The registered application's client ID |
| `ClientSecret` | The registered application's client secret -- **never commit to source control** |
| `RedirectUri` | The callback URL (typically `{site-url}/signin-{provider}`) |
| `AuthenticationType` | Unique identifier for this provider (used as the `provider` value in ExternalLogin) |
| `Caption` | Display name shown on the login button |
| `ExternalLogoutEnabled` | `true` to sign out of the IdP on logout |
| `PostLogoutRedirectUri` | URL to redirect to after external logout |
| `RegistrationClaimsMapping` | JSON mapping of OIDC claims to contact fields on registration |
| `LoginClaimsMapping` | JSON mapping of OIDC claims to contact fields on login |

### Entra External ID Provider Settings

Entra External ID uses the same `Authentication/OpenIdConnect/{ProviderName}/{SettingName}` path as generic OIDC. The authority URL may use `ciamlogin.com` (default) or a custom domain configured for the tenant.

All settings from the OpenID Connect section above apply to Entra External ID providers.

### SAML2 Provider Settings

Pattern: `Authentication/SAML2/{ProviderName}/{SettingName}`

| Setting | Description |
|---------|-------------|
| `MetadataAddress` | URL of the SAML IdP metadata XML |
| `AuthenticationType` | Unique identifier for this provider |
| `ServiceProviderRealm` | The SP entity ID (typically the site URL) |
| `AssertionConsumerServiceUrl` | The ACS URL (typically `{site-url}/signin-{provider}`) |
| `Caption` | Display name shown on the login button |
| `SignAuthenticationRequests` | `true` to sign SAML authn requests |
| `ExternalLogoutEnabled` | `true` to enable SAML Single Logout (SLO) |
| `NameIdPolicy` | Format of the NameID claim (e.g., `urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress`) |
| `AuthnContextClassRef` | Authentication context class (e.g., `urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport`) |
| `ForceAuthn` | `true` to force re-authentication even if session exists at IdP |

### WS-Federation Provider Settings

Pattern: `Authentication/WsFederation/{ProviderName}/{SettingName}`

| Setting | Description |
|---------|-------------|
| `MetadataAddress` | URL of the WS-Fed metadata XML |
| `AuthenticationType` | Unique identifier for this provider |
| `Wtrealm` | The relying party realm (typically the site URL) |
| `Caption` | Display name shown on the login button |
| `ExternalLogoutEnabled` | `true` to enable federated logout |

### Local Authentication Settings

| Setting | Value | Description |
|---------|-------|-------------|
| `Authentication/Registration/LocalLoginEnabled` | `true` | Enable local login |
| `Authentication/Registration/LocalLoginByEmail` | `true` | Allow login by email instead of username |
| `Authentication/Registration/LocalLoginDeprecated` | `false` | Set to `true` to deprecate local login |
| `Authentication/Registration/RememberMeEnabled` | `true`/`false` | Show "Remember me" checkbox on login form |

### Social OAuth Provider Settings

Social providers use the `Authentication/OpenAuth/{ProviderName}/` site setting path:

| Setting Pattern | Description |
|-----------------|-------------|
| `Authentication/OpenAuth/{SocialProvider}/ClientId` | App ID from the social provider (generic) |
| `Authentication/OpenAuth/{SocialProvider}/ClientSecret` | App secret from the social provider (generic) |
| `Authentication/OpenAuth/{SocialProvider}/Caption` | Button label (e.g., "Sign in with Facebook") |

**Facebook-specific settings** -- Facebook uses `AppId` and `AppSecret` (not `ClientId`/`ClientSecret`). The server falls back to `ClientId`/`ClientSecret` if `AppId`/`AppSecret` are not set, but the canonical setting names are:

| Setting | Description |
|---------|-------------|
| `Authentication/OpenAuth/Facebook/AppId` | Facebook App ID from the Facebook Developer Console |
| `Authentication/OpenAuth/Facebook/AppSecret` | Facebook App Secret from the Facebook Developer Console |

**Google-specific settings:**

| Setting | Description |
|---------|-------------|
| `Authentication/OpenAuth/Google/ClientId` | Google Client ID from the Google Cloud Console |
| `Authentication/OpenAuth/Google/ClientSecret` | Google Client Secret from the Google Cloud Console |

> **Security Warning:** Never commit `ClientSecret` or `AppSecret` values to source control. Secrets must be stored as Dataverse environment variables using `create-environment-variable.js`, then linked to site settings via `create-site-setting.js --envVarSchema`. Do NOT create site setting YAML files with placeholder secret values — use the environment variable pattern exclusively. The user updates actual secret values through the Power Apps maker portal (make.powerapps.com).

### Two-Factor Cookie Settings

| Setting | Description |
|---------|-------------|
| `Authentication/TwoFactorCookie/AuthenticationType` | Custom authentication type for 2FA cookie (defaults to `TwoFactorCookie`) |
| `Authentication/TwoFactorCookie/ExpireTimeSpan` | 2FA cookie expiry (defaults to `00:05:00` / 5 minutes) |

### Application Cookie Settings

| Setting | Description |
|---------|-------------|
| `Authentication/ApplicationCookie/CookieName` | Custom cookie name |
| `Authentication/ApplicationCookie/CookieDomain` | Cookie domain scope |
| `Authentication/ApplicationCookie/ExpireTimeSpan` | Session timeout (e.g., `01:00:00` for 1 hour) |
| `Authentication/ApplicationCookie/SlidingExpiration` | `true` to renew cookie on each request |

---

## Entra External ID Provider

Entra External ID is Microsoft's customer identity and access management (CIAM) solution for customer-facing applications. It is a separate product from Azure AD B2C — do not conflate the two. It uses OpenID Connect underneath. The authority URL defaults to `{tenant}.ciamlogin.com` but may use a custom domain (e.g., `login.contoso.com`).

### External ID Provider Type

```typescript
export type AuthProviderType =
  | 'entra-id'
  | 'oidc'
  | 'saml2'
  | 'ws-federation'
  | 'local'
  | 'social'
  | 'entra-external-id';
```

### External ID AUTH_PROVIDER Configuration

```typescript
const AUTH_PROVIDER: AuthProviderConfig = {
  type: 'entra-external-id',
  providerIdentifier: 'https://{tenant}.ciamlogin.com/{tenant}.onmicrosoft.com/v2.0/', // Must match AuthenticationType site setting
  displayName: 'Sign in with External ID',
};
```

### External ID Site Settings

Pattern: `Authentication/OpenIdConnect/{ProviderName}/{SettingName}`

Entra External ID uses the same OpenID Connect site setting path:

| Setting | Description |
|---------|-------------|
| `Authority` | External ID authority URL (e.g., `https://{tenant}.ciamlogin.com/{tenant}.onmicrosoft.com/v2.0/` or custom domain like `https://login.contoso.com/{tenant-id}/v2.0/`) |
| `ClientId` | Application (client) ID from the External ID app registration |
| `AuthenticationType` | Unique identifier for this provider (typically the authority URL) |
| `RedirectUri` | Callback URL (e.g., `{site-url}/signin-{provider}`) |
| `ExternalLogoutEnabled` | `true` to sign out of External ID on logout |
| `Caption` | Display name shown on the login button |

---

## Two-Factor Authentication (2FA)

Two-factor authentication is an optional follow-on step that occurs after primary authentication (either local login or external login). It is controlled by the `Authentication/Registration/TwoFactorEnabled` site setting.

### 2FA Site Settings

| Setting | Value | Description |
|---------|-------|-------------|
| `Authentication/Registration/TwoFactorEnabled` | `true`/`false` | Enable two-factor authentication |
| `Authentication/Registration/RememberBrowserEnabled` | `true`/`false` | Allow "remember this browser" option to skip 2FA on subsequent logins |
| `Authentication/TwoFactorCookie/AuthenticationType` | `(string)` | Custom authentication type for the 2FA cookie (defaults to `TwoFactorCookie`) |
| `Authentication/TwoFactorCookie/ExpireTimeSpan` | `(timespan)` | 2FA cookie expiry (defaults to 5 minutes) |

### 2FA Flow (Server-Side)

The 2FA flow is entirely server-side. The client-side auth service does not need to implement 2FA logic directly -- the server handles the redirect chain:

1. User completes primary authentication (local login or external login)
2. `SignInManager.PasswordSignInAsync` (local) or `SignInManager.ExternalSignInAsync` (external) returns `SignInStatus.RequiresVerification`
3. Server redirects to `/Account/Login/SendCode` with `ReturnUrl`, `InvitationCode`, and `RememberMe` parameters
4. The `SendCode` action retrieves valid 2FA providers for the user via `UserManager.GetValidTwoFactorProvidersAsync`
5. If only one provider exists, the code is sent automatically; otherwise, the user selects a provider
6. Server sends the verification code via `SignInManager.SendTwoFactorCodeAsync`
7. Server redirects to `/Account/Login/VerifyCode` with the selected provider, return URL, and remember preferences
8. User enters the verification code
9. `SignInManager.TwoFactorSignInAsync` validates the code
10. On success, the session is fully established

### 2FA Client-Side Considerations

Since 2FA is server-managed, the client-side auth service needs only to be aware that:
- After calling `login()`, the page may redirect to a 2FA verification form instead of completing immediately
- The `window.Microsoft.Dynamic365.Portal.User` object will only be populated after 2FA is complete
- The `RememberMe` flag from the login form is threaded through the 2FA flow

No additional client-side components are needed for 2FA -- the server renders the SendCode and VerifyCode pages using its own ASP.NET views.

---

## Invitation-Based Registration

Power Pages supports invitation code-based registration where users receive an invitation code (typically via email) that grants them access to register on the site.

### Invitation Site Settings

| Setting | Value | Description |
|---------|-------|-------------|
| `Authentication/Registration/InvitationEnabled` | `true`/`false` | Enable invitation-based registration |
| `Authentication/Registration/RequireInvitationCode` | `true`/`false` | Require an invitation code to register |

### Invitation Flow

The invitation code is threaded through all authentication endpoints as a query parameter:

1. User receives an invitation link: `{site-url}/Account/Login/Login?invitationCode={code}&returnUrl={url}`
2. The `invitationCode` parameter is preserved through the entire login flow:
   - Local login: `POST /Account/Login/Login` includes `invitationCode`
   - External login: `POST /Account/Login/ExternalLogin` includes `invitationCode` as a query parameter
   - 2FA flow: `invitationCode` is threaded through `SendCode` and `VerifyCode` actions
3. After authentication, the server validates the invitation code via `InvitationManager`
4. If valid, the user is linked to the pre-created contact record associated with the invitation

### Invitation Client-Side Support

The canonical `login()` function in the auth service already supports invitation codes as the third parameter. When an `invitationCode` is provided:

- **Local login**: The invitation code is included as a hidden `InvitationCode` field in the form POST to `/Account/Login/Login`
- **External login**: The invitation code is appended as a query parameter to `/Account/Login/ExternalLogin?InvitationCode={code}`

To pass an invitation code from a URL (e.g., `?invitationCode=abc123`):

```typescript
const params = new URLSearchParams(window.location.search);
const invitationCode = params.get('invitationCode') || undefined;

// For external login with invitation
await login('/dashboard', undefined, invitationCode);

// For local login with invitation
await login('/dashboard', { username: email, password, rememberMe: true }, invitationCode);
```

---

## Secret Management

> **Security Warning:** Never commit `ClientSecret`, `AppSecret`, or any other credential values to source control.

### Best Practices

- **Use Azure Key Vault (recommended)** — store secrets in Key Vault, then create a Dataverse environment variable with `--type secret` referencing the Key Vault secret URI. Link the env var to a site setting via `create-site-setting.js --envVarSchema`. This ensures secrets are never stored in YAML files, conversation history, or Dataverse as plain text.
- **Fallback: plain environment variables** — if Key Vault is not available, create Dataverse environment variables with placeholder values and update them via the Power Apps maker portal ([make.powerapps.com](https://make.powerapps.com)) → Solutions → Default Solution → Environment variables.
- **Never ask for secret values** in the conversation — secret values must never pass through the chat. Instruct the user to store secrets via Azure CLI or the Azure Portal, then share only the Key Vault secret URI.
- **Never store secrets** in `authService.ts`, environment files (`.env`), site setting YAML files, or any file tracked by version control.
- **Review before committing**: Always verify that no actual `ClientSecret`, `AppSecret`, API key, or certificate values are included in your commits.
- **The `providerIdentifier` field** in `AUTH_PROVIDER` is NOT a secret -- it is a public identifier (like a URL or provider name) that identifies which identity provider to use.

---

## Terms and Conditions for SPA Sites

### Prerequisites

The Terms feature requires three things to work:

1. **GDPR solution installed** (`msdynce_PortalPrivacyExtensions`) — without this, `IsGdprEnabled()` returns false and terms are disabled
2. **Site setting** `Authentication/Registration/TermsAgreementEnabled = true`
3. **Content snippet** `Account/Signin/TermsAndConditionsCopy` must exist with non-empty content — if blank, terms are disabled even with the setting enabled

### How it works

After login or registration, the server checks terms (in the `LoginController` and `RegistrationManager`):

```
IsTermsAndConditionsEnabled():
  if (!TermsConsentEnabled || !IsGdprEnabled) return false
  if (snippet "Account/Signin/TermsAndConditionsCopy" is empty) return false
  return true
```

If enabled, the server redirects to the terms page instead of the ReturnUrl:
- **Login**: redirects to `/Account/Login/TermsAndConditions`
- **Registration**: redirects to `/TermsAndConditions?ReturnUrl=%2F`

The server also sets a `DeferredLocalLoginCookie` — it defers session creation until terms are accepted.

### Auth Service: TermsRequiredError and acceptTerms

Add to `authService.ts`:

```typescript
// Thrown when the server redirects to the terms page after login/registration.
export class TermsRequiredError extends Error {
  constructor() {
    super('Terms and conditions acceptance required.');
    this.name = 'TermsRequiredError';
  }
}
```

**Detection in `loginLocal()` and `register()`** — add before the redirect handling:

```typescript
// Check if the server redirected to terms (catches both URL patterns)
if (response.url.includes('TermsAndConditions')) {
  throw new TermsRequiredError();
}
```

**`acceptTerms()` function:**

```typescript
export async function acceptTerms(returnUrl?: string): Promise<void> {
  if (isDevelopment) {
    window.location.href = returnUrl || '/';
    return;
  }

  // Fetch the server terms page to get the anti-forgery token
  const pageResponse = await fetch('/Account/Login/TermsAndConditions', {
    credentials: 'same-origin',
    redirect: 'follow',
  });

  // Use the final URL the server responded from (may differ between login/registration flows)
  const termsUrl = new URL(pageResponse.url).pathname;

  const pageHtml = await pageResponse.text();
  const parser = new DOMParser();
  const doc = parser.parseFromString(pageHtml, 'text/html');

  const antiForgeryToken = (doc.querySelector('input[name="__RequestVerificationToken"]') as HTMLInputElement)?.value || '';

  const body = new URLSearchParams();
  body.set('__RequestVerificationToken', antiForgeryToken);
  body.set('InvitationCode', '');
  body.set('IsFacebook', 'False');
  body.set('UseExternalSignInAsync', 'False');
  body.set('IsInternalAADUser', 'False');
  body.set('IsTermsAndConditionsAccepted', 'true');

  const response = await fetch(termsUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    credentials: 'same-origin',
    redirect: 'follow',
  });

  if (response.redirected || response.ok) {
    window.location.href = returnUrl || '/';
    return;
  }

  const responseHtml = await response.text();
  const errors = parseServerErrors(responseHtml);
  if (errors.length > 0) throw new Error(errors.join(' '));
  throw new Error('Failed to accept terms. Please try again.');
}
```

### React: Terms Page Component

Create `src/pages/Terms.tsx`. The terms content is hardcoded from the snippet values collected during skill setup:

```tsx
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { acceptTerms } from '../services/authService'

// Content from Power Pages content snippets — hardcoded during skill setup.
// Update these values and redeploy when the site creator changes the terms.
const TERMS_HEADING = 'Terms and Conditions'
const TERMS_CONTENT = `
  <p>By using this portal, you agree to the following terms of service.</p>
  <h3>1. Acceptance of Terms</h3>
  <p>By accessing and using this portal, you accept and agree to be bound by these terms.</p>
  <h3>2. Privacy & Data</h3>
  <p>We collect and process your personal data in accordance with our privacy policy.</p>
  <h3>3. Account Responsibility</h3>
  <p>You are responsible for maintaining the confidentiality of your account credentials.</p>
  <h3>4. Changes to Terms</h3>
  <p>We reserve the right to update these terms at any time.</p>
`
const TERMS_AGREEMENT_TEXT = 'I agree to these terms and conditions.'
const TERMS_BUTTON_TEXT = 'Confirm'

export default function Terms() {
  const [accepted, setAccepted] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [serverError, setServerError] = useState<string | undefined>()

  useEffect(() => { document.title = `${TERMS_HEADING} — Site Name` }, [])

  function handleConfirm() {
    if (!accepted) return
    setIsSubmitting(true)
    setServerError(undefined)
    acceptTerms('/').catch(err => {
      setServerError(err instanceof Error ? err.message : 'Failed to accept terms.')
      setIsSubmitting(false)
    })
  }

  return (
    <section>
      <h1>{TERMS_HEADING}</h1>
      {serverError && <div role="alert">{serverError}</div>}
      <div dangerouslySetInnerHTML={{ __html: TERMS_CONTENT }} />
      <label>
        <input type="checkbox" checked={accepted} onChange={e => setAccepted(e.target.checked)} />
        {TERMS_AGREEMENT_TEXT}
      </label>
      <button onClick={handleConfirm} disabled={!accepted || isSubmitting}>
        {isSubmitting ? 'Confirming...' : TERMS_BUTTON_TEXT}
      </button>
      <p><Link to="/login">Back to sign in</Link></p>
    </section>
  )
}
```

Style the component to match the site's existing auth page design (card layout, CSS variables, etc.).

### Login and Registration: Catching TermsRequiredError

Both pages must catch `TermsRequiredError` in their submit handlers:

```typescript
// In Login.tsx
loginLocal(email, password, false, '/').catch(err => {
  if (err instanceof TermsRequiredError) {
    navigate('/terms')
    return
  }
  // ... existing error handling
})

// In Registration.tsx
register({ email, password, confirmPassword }, '/', invitationCode).catch(err => {
  if (err instanceof TermsRequiredError) {
    navigate('/terms')
    return
  }
  // ... existing error handling
})
```

### Content Snippets Used by the Server

The server-rendered terms page uses these snippets. Create the required one and optionally the others:

| Snippet | Required | Default |
|---------|----------|---------|
| `Account/Signin/TermsAndConditionsCopy` | **Yes** (feature disabled without it) | The terms HTML content |
| `Account/Signin/TermsAndConditionsHeading` | No | "Terms and Conditions" |
| `Account/Signin/TermsAndConditionsAgreementText` | No | "I agree to these terms and conditions." |
| `Account/Signin/TermsAndConditionsButtonText` | No | "Confirm" |

### Re-consent via TermsPublicationDate

The `TermsPublicationDate` site setting controls re-acceptance:
- **Not set**: users are prompted every login
- **Set to a date**: users who accepted after that date are not re-prompted. Bump the date to force everyone to re-accept when terms are updated.

The server stores acceptance on the contact record's `msdyn_portaltermsagreementdate` field.

---

## Session KeepAlive for SPA Sites

In SPAs, page navigation is client-side — no server requests are made. The session cookie's `SlidingExpiration` only renews when the browser sends a request to the server. Without a keepalive, the session silently expires even while the user is actively using the SPA.

### React: useSessionKeepAlive Hook

Create `src/hooks/useSessionKeepAlive.ts`:

```typescript
import { useEffect, useRef } from 'react';
import { isAuthenticated, fetchAntiForgeryToken } from '../services/authService';

// Set this to match your Authentication/ApplicationCookie/ExpireTimeSpan site setting.
// Default Power Pages session is 24 hours. For a 10-minute session, use 10 * 60 * 1000.
const SESSION_EXPIRE_MS = 24 * 60 * 60 * 1000;

export function useSessionKeepAlive({
  // Ping at 1/3 of session timeout, capped at 15min.
  // Must be well before the halfway point where SlidingExpiration renews.
  intervalMs = Math.min(SESSION_EXPIRE_MS / 3, 15 * 60 * 1000),
  // Stop pinging after 90% of session timeout idle, capped at 30min.
  idleTimeoutMs = Math.min(SESSION_EXPIRE_MS * 0.9, 30 * 60 * 1000),
  onSessionExpired,
}: {
  intervalMs?: number;
  idleTimeoutMs?: number;
  onSessionExpired?: () => void;
} = {}) {
  const lastActivityRef = useRef(Date.now());

  useEffect(() => {
    const isDev = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
    if (isDev) return;

    function onActivity() { lastActivityRef.current = Date.now(); }

    window.addEventListener('mousemove', onActivity, { passive: true });
    window.addEventListener('keydown', onActivity, { passive: true });
    window.addEventListener('touchstart', onActivity, { passive: true });
    window.addEventListener('scroll', onActivity, { passive: true });

    const timer = setInterval(async () => {
      if (!isAuthenticated()) return;
      if (document.visibilityState === 'hidden') return;
      if (Date.now() - lastActivityRef.current > idleTimeoutMs) return;

      try {
        await fetchAntiForgeryToken();
      } catch {
        if (onSessionExpired) onSessionExpired();
      }
    }, intervalMs);

    return () => {
      clearInterval(timer);
      window.removeEventListener('mousemove', onActivity);
      window.removeEventListener('keydown', onActivity);
      window.removeEventListener('touchstart', onActivity);
      window.removeEventListener('scroll', onActivity);
    };
  }, [intervalMs, idleTimeoutMs, onSessionExpired]);
}
```

### Integration

Add to the Layout component so it runs on every page:

```typescript
import { useSessionKeepAlive } from '../hooks/useSessionKeepAlive';
import { useNavigate } from 'react-router-dom';
import { useCallback } from 'react';

export default function Layout({ children }) {
  const navigate = useNavigate();
  const handleSessionExpired = useCallback(() => {
    navigate('/login?sessionExpired=true');
  }, [navigate]);

  useSessionKeepAlive({ onSessionExpired: handleSessionExpired });

  return (/* ... */);
}
```

The login page already handles `?sessionExpired=true` via `getSessionExpiredMessage()`.

### Why `/_layout/tokenhtml`?

This is the best endpoint for keepalive because:
- Smallest response (~200-300 bytes — just an anti-forgery token `<input>` tag)
- Low server cost (no Dataverse queries, no template rendering)
- Renews the session cookie via OWIN middleware
- Already used by the auth service for CSRF tokens
- No dedicated health/ping endpoint exists in Power Pages

---

## Important Notes

- **Auth only works on deployed sites**: The `/_layout/tokenhtml` endpoint and `window.Microsoft.Dynamic365.Portal` object are only available when the site is served from Power Pages, not during local `npm run dev`.
- **Mock data for development**: The auth service includes a mock user pattern for local development. The mock user has configurable roles so developers can test role-based UI locally.
- **Security**: Always validate permissions server-side via table permissions. Client-side auth checks are for UX only -- a direct API call bypasses all client-side checks. Never commit secrets (`ClientSecret`, `AppSecret`) to source control -- use the Power Pages admin center for sensitive values.
- **Provider configuration**: The identity provider must be configured in the Power Pages admin center (for Entra ID) or via site settings (for OIDC, SAML2, WS-Fed, Social, Entra External ID). This skill creates the client-side code and site settings but does not configure the external identity provider itself.
- **Multiple providers**: Power Pages supports multiple identity providers simultaneously. Users see all configured providers on the login page. To configure multiple providers, create separate site settings for each and update the auth service to support provider selection.
