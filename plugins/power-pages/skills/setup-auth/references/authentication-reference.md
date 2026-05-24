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
  // The calling component should handle .then() to show a "check your email" confirmation.
}

// --- Reset Password ---
// MVC form POST. The user arrives at the SPA /reset-password page via the header template
// redirect (server's /Account/Login/ResetPassword → SPA /reset-password).
// UserId and Code come from the URL query params set by the email reset link.

export async function resetPassword(
  userId: string,
  code: string,
  password: string,
  confirmPassword: string
): Promise<void> {
  if (isDevelopment) {
    alert('Dev mode: Password would be reset.');
    window.location.href = '/login';
    return;
  }

  const token = await fetchAntiForgeryToken();

  const body = new URLSearchParams();
  body.set('__RequestVerificationToken', token);
  body.set('UserId', userId);
  body.set('Code', code);
  body.set('Password', password);       // Note: Password here, NOT PasswordValue (different from login)
  body.set('ConfirmPassword', confirmPassword);

  const response = await fetch('/Account/Login/ResetPassword', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    credentials: 'same-origin',
    redirect: 'follow',
  });

  if (response.redirected) {
    window.location.href = '/login?message=password_reset_success';
    return;
  }

  const html = await response.text();
  const errors = parseServerErrors(html);
  if (errors.length > 0) {
    throw new Error(errors.join(' '));
  }

  // If no errors and not redirected, assume success
  window.location.href = '/login?message=password_reset_success';
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

### Multiple Providers — Canonical `AUTH_PROVIDERS` Array Pattern

**Always use the array pattern, even with one entry.** This is the canonical shape — single-provider sites can grow to multi-provider without restructuring.

```typescript
export type AuthProviderType =
  | 'local'
  | 'oidc'
  | 'entra-id'
  | 'saml2'
  | 'ws-federation'
  | 'social';

export interface AuthProviderConfig {
  /** Stable identifier — used as React key and to distinguish multiple instances of same type */
  id: string;
  type: AuthProviderType;
  /** Button label shown on the Login page */
  displayName: string;
  /**
   * Provider identifier the server expects in the ExternalLogin form POST.
   * For OIDC: the Authority URL (matches the AuthenticationType site setting).
   * For SAML2/WS-Fed/social: the provider identifier from the site settings.
   * Not used for local.
   */
  providerIdentifier?: string;
  /** Local-only: send Email field (true) or Username field (false) */
  loginByEmail?: boolean;
}

export const AUTH_PROVIDERS: AuthProviderConfig[] = [
  // Each provider gets a stable id — use the ProviderName slug from site settings.
  // For multiple instances of the same type (e.g., 2 Entra External ID tenants), use
  // distinct ids: 'entra-external-id-customer', 'entra-external-id-employee'.
  {
    id: 'entra-external-id',
    type: 'oidc',
    displayName: 'Sign in with Entra External ID',
    providerIdentifier: 'https://contoso.ciamlogin.com/contoso.onmicrosoft.com/v2.0/',
  },
  {
    id: 'local',
    type: 'local',
    displayName: 'Sign in with email',
    loginByEmail: true,
  },
];

if (AUTH_PROVIDERS.length === 0) {
  throw new Error('AUTH_PROVIDERS array is empty. Configure at least one authentication provider.');
}

// Exported helpers for the Login page to filter providers cleanly:
export const LOCAL_PROVIDER = AUTH_PROVIDERS.find(p => p.type === 'local');
export const EXTERNAL_PROVIDERS = AUTH_PROVIDERS.filter(p => p.type !== 'local');

// Backward-compat for any code that still imports AUTH_PROVIDER:
const AUTH_PROVIDER: AuthProviderConfig =
  AUTH_PROVIDERS.find(p => p.type === 'local') ?? AUTH_PROVIDERS[0];
```

### `loginExternal()` — external provider form POST

```typescript
export async function loginExternal(
  providerIdentifier: string,
  returnUrl?: string,
  invitationCode?: string
): Promise<void> {
  if (isDevelopment) {
    sessionStorage.removeItem(DEV_SIGNEDOUT_KEY);
    window.location.reload();
    return;
  }

  const token = await fetchAntiForgeryToken();

  const form = document.createElement('form');
  form.method = 'POST';
  form.action = invitationCode
    ? `/Account/Login/ExternalLogin?InvitationCode=${encodeURIComponent(invitationCode)}`
    : '/Account/Login/ExternalLogin';

  const fields: Record<string, string> = {
    __RequestVerificationToken: token,
    provider: providerIdentifier,
    returnUrl: returnUrl || '/',
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

### `loginWithProvider()` — router that dispatches to local or external

This is the **only function the Login UI should call**. It takes a provider config object and routes correctly based on `type`.

```typescript
export async function loginWithProvider(
  provider: AuthProviderConfig,
  options: {
    returnUrl?: string;
    invitationCode?: string;
    /** Local-only: credentials are required when provider.type === 'local' */
    credentials?: { credential: string; password: string; rememberMe?: boolean };
  } = {}
): Promise<void> {
  if (provider.type === 'local') {
    if (!options.credentials) {
      throw new Error('Local login requires credentials.');
    }
    return loginLocal(
      options.credentials.credential,
      options.credentials.password,
      options.credentials.rememberMe ?? false,
      options.returnUrl,
      options.invitationCode
    );
  }

  if (!provider.providerIdentifier) {
    throw new Error(`Provider ${provider.id} is missing providerIdentifier.`);
  }
  return loginExternal(provider.providerIdentifier, options.returnUrl, options.invitationCode);
}
```

`loginLocal()` retains its existing signature (`credential, password, rememberMe, returnUrl, invitationCode`) — see "Local Login" section above. The router just delegates.

### Login Page — Layout Patterns

The Login page renders providers from `EXTERNAL_PROVIDERS` and (optionally) the local form. The structural skeleton is shared across all 4 layouts; only the provider section differs.

**Shared skeleton (all layouts):**

```tsx
import { useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
  loginWithProvider,
  AUTH_PROVIDERS,
  LOCAL_PROVIDER,
  EXTERNAL_PROVIDERS,
  getAuthError,
  getSessionExpiredMessage,
  TermsRequiredError,
} from '../services/authService'

export default function Login() {
  const navigate = useNavigate()
  // ... state: errors, touched, serverError, successMessage, infoMessage,
  //     isSubmitting, externalSubmittingId, plus invitationCode parsing ...

  function handleExternalSignIn(providerId: string) {
    const provider = AUTH_PROVIDERS.find(p => p.id === providerId)
    if (!provider) return
    setExternalSubmittingId(providerId)
    loginWithProvider(provider, { returnUrl: '/', invitationCode })
      .catch(err => { setServerError(err.message); setExternalSubmittingId(undefined) })
  }

  function handleLocalSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (!LOCAL_PROVIDER) return
    // validate, then:
    loginWithProvider(LOCAL_PROVIDER, {
      returnUrl: '/',
      invitationCode,
      credentials: { credential: email, password, rememberMe: false },
    }).catch(err => {
      if (err instanceof TermsRequiredError) return navigate('/terms')
      setServerError(err.message)
    })
  }

  // ...render based on LOGIN_LAYOUT (see patterns below)...
}
```

#### Layout 1: Horizontal row (default)

External provider buttons in a wrapping flex row at the top. Local form below an "OR SIGN IN WITH EMAIL" divider.

```tsx
{EXTERNAL_PROVIDERS.length > 0 && (
  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginBottom: 24 }}>
    {EXTERNAL_PROVIDERS.map(p => (
      <button key={p.id} type="button"
        style={{ flex: '1 1 0', minWidth: 0, padding: '10px 16px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
        disabled={!!externalSubmittingId || isSubmitting}
        onClick={() => handleExternalSignIn(p.id)}>
        {externalSubmittingId === p.id ? 'Redirecting...' : p.displayName}
      </button>
    ))}
  </div>
)}
{EXTERNAL_PROVIDERS.length > 0 && LOCAL_PROVIDER && <Divider label="OR SIGN IN WITH EMAIL" />}
{LOCAL_PROVIDER && <LocalForm onSubmit={handleLocalSubmit} loginByEmail={LOCAL_PROVIDER.loginByEmail} />}
```

#### Layout 2: Vertical stack

External provider buttons stacked full-width vertically. Same divider + local form below.

```tsx
{EXTERNAL_PROVIDERS.length > 0 && (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 24 }}>
    {EXTERNAL_PROVIDERS.map(p => (
      <button key={p.id} type="button"
        style={{ width: '100%', padding: '12px 16px' }}
        disabled={!!externalSubmittingId || isSubmitting}
        onClick={() => handleExternalSignIn(p.id)}>
        {externalSubmittingId === p.id ? 'Redirecting...' : p.displayName}
      </button>
    ))}
  </div>
)}
{/* divider + LocalForm — same as horizontal layout */}
```

#### Layout 3: Primary spotlight

One featured provider (matching `PRIMARY_PROVIDER_ID`) shown as a large primary CTA. Other external providers tucked under a `<details>` disclosure. Local form below.

```tsx
const primary = EXTERNAL_PROVIDERS.find(p => p.id === PRIMARY_PROVIDER_ID) ?? EXTERNAL_PROVIDERS[0]
const others = EXTERNAL_PROVIDERS.filter(p => p.id !== primary?.id)

{primary && (
  <button type="button" className="btn-primary"
    style={{ width: '100%', padding: '14px 20px', fontSize: '1rem', marginBottom: 12 }}
    disabled={!!externalSubmittingId || isSubmitting}
    onClick={() => handleExternalSignIn(primary.id)}>
    {externalSubmittingId === primary.id ? 'Redirecting...' : primary.displayName}
  </button>
)}
{others.length > 0 && (
  <details style={{ marginBottom: 24 }}>
    <summary style={{ cursor: 'pointer', fontSize: '0.875rem', color: 'var(--color-text-muted)' }}>
      More sign-in options
    </summary>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
      {others.map(p => (
        <button key={p.id} type="button"
          style={{ width: '100%', padding: '10px 16px' }}
          onClick={() => handleExternalSignIn(p.id)}>
          {p.displayName}
        </button>
      ))}
    </div>
  </details>
)}
{/* divider + LocalForm — same as horizontal layout */}
```

#### Layout 4: Tabbed

Tabs across the top — one tab per external provider, plus a "Email & password" tab when local exists. The selected tab's UI renders below.

```tsx
const [activeTab, setActiveTab] = useState<string>(
  EXTERNAL_PROVIDERS[0]?.id ?? LOCAL_PROVIDER?.id ?? ''
)

const allTabs: { id: string; label: string }[] = [
  ...EXTERNAL_PROVIDERS.map(p => ({ id: p.id, label: p.displayName })),
  ...(LOCAL_PROVIDER ? [{ id: LOCAL_PROVIDER.id, label: 'Email & password' }] : []),
]

return (
  <>
    <div role="tablist" style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--color-border)', marginBottom: 24 }}>
      {allTabs.map(tab => (
        <button key={tab.id} role="tab" aria-selected={activeTab === tab.id}
          style={{
            padding: '10px 16px', border: 'none', background: 'none',
            borderBottom: activeTab === tab.id ? '2px solid var(--color-primary)' : '2px solid transparent',
            cursor: 'pointer', fontWeight: activeTab === tab.id ? 600 : 400,
          }}
          onClick={() => setActiveTab(tab.id)}>
          {tab.label}
        </button>
      ))}
    </div>

    {/* Render the active tab's UI */}
    {(() => {
      const external = EXTERNAL_PROVIDERS.find(p => p.id === activeTab)
      if (external) {
        return (
          <button type="button" className="btn-primary"
            style={{ width: '100%' }}
            disabled={!!externalSubmittingId}
            onClick={() => handleExternalSignIn(external.id)}>
            {externalSubmittingId === external.id ? 'Redirecting...' : external.displayName}
          </button>
        )
      }
      if (LOCAL_PROVIDER && activeTab === LOCAL_PROVIDER.id) {
        return <LocalForm onSubmit={handleLocalSubmit} loginByEmail={LOCAL_PROVIDER.loginByEmail} />
      }
      return null
    })()}
  </>
)
```

#### Single-provider sites

When `AUTH_PROVIDERS.length === 1`, all layouts collapse to a single button (external) or a single form (local). The layout choice doesn't visually matter — pick `horizontal-row` as the no-op default.

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
| `RegistrationClaimsMapping` | **Comma-separated `contactfield=claimtype` pairs** (NOT JSON). Applied once at first sign-in. Example: `firstname=given_name,lastname=family_name,emailaddress1=email`. |
| `LoginClaimsMapping` | Same format. Applied every login (overwrites contact fields). Use sparingly to avoid overwriting manual edits. |

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
| `Authentication/Registration/Enabled` | `true` | Master switch; must be true for any registration path |
| `Authentication/Registration/OpenRegistrationEnabled` | `true`/`false` | `false` for invitation-only, `true` for open or both |
| `Authentication/Registration/InvitationEnabled` | `true` | Required for invitation flow |

> **`Authentication/Registration/RequireInvitationCode` is NOT a real server setting.** The Power Pages server (`crm.solutions.portal/Samples/MasterPortal/Areas/Account/Models/RegistrationManager.cs`) never reads this name. The "require invitation" behavior is enforced entirely by the combination `OpenRegistrationEnabled = false` + `InvitationEnabled = true` (the server's gating rule: if `OpenRegistrationEnabled=false` AND no invitation code is provided on the registration POST, return 404).

### Invitation Flow (SPA)

The full SPA invitation flow is documented in the **"Redeem Invitation Flow for SPA Sites"** section above. Summary:

1. User receives an invitation link: `{site-url}/Account/Login/RedeemInvitation?invitation={code}`
2. Code-Site-Shell-Header script redirects to SPA `/redeem-invitation?invitation={code}`
3. SPA RedeemInvitation page calls `redeemInvitation(code, redeemByLogin)`:
   - Server returns 302 (caught as `opaqueredirect`) → SPA navigates to `/registration?invitationCode={code}`
   - Server returns 200 with Login view → SPA navigates to `/login?invitationCode={code}`
   - Server returns 200 with validation summary → throw parsed error
4. The destination page (Registration or Login) accepts `invitationCode` from URL and passes it through to the final POST
5. Server's `InvitationManager.RedeemAsync()` links the invitation to the user's contact during registration or in `RedirectOnPostAuthenticate` after login

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
- **Local login**: redirects to `/Account/Login/TermsAndConditions` (no query string for the local-auth case)
- **Local registration**: redirects to `/TermsAndConditions?ReturnUrl=%2F`
- **External login (Entra External ID, OIDC, social)**: redirects from `/Account/Login/ExternalLoginCallback` to `/Account/Login/TermsAndConditions?ReturnUrl=/&UseExternalSignInAsync=True&IsFacebook=False&IsInternalAADUser=False`. The query-string flags tell the server which sign-in completion path to take after acceptance — `UseExternalSignInAsync=True` is the critical one for external users.

The server also sets a deferred sign-in cookie (`DeferredLocalLoginCookie` for local, external sign-in deferred cookie for external) — sign-in completes only after terms are accepted.

### SPA coverage

| Auth flow | SPA detection mechanism |
|---|---|
| Local login / registration | `fetch()` response URL check → throw `TermsRequiredError` → page navigates to `/terms` |
| External login (Entra External ID, OIDC, social) | Browser navigates to `/Account/Login/TermsAndConditions` after IdP callback → Code-Site-Shell-Header redirect script catches it → forwards to `/terms` with query string preserved |

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

**`acceptTerms()` function — query-string-aware:**

The function must read flags from `window.location.search` (set by the server's redirect URL for external auth) instead of hardcoding them. Without this, external users' POST to `/Account/Login/TermsAndConditions` sends `UseExternalSignInAsync=False` and the server won't complete their sign-in.

```typescript
export async function acceptTerms(returnUrl?: string): Promise<void> {
  if (isDevelopment) {
    window.location.href = returnUrl || '/';
    return;
  }

  // Read flags from the URL the user landed at. For external auth, the server's
  // redirect URL is /Account/Login/TermsAndConditions?ReturnUrl=/&UseExternalSignInAsync=True&...
  // For local auth, the SPA navigates here directly with no query string — defaults apply.
  const params = new URLSearchParams(window.location.search);
  const useExternalSignInAsync = params.get('UseExternalSignInAsync') || 'False';
  const isFacebook = params.get('IsFacebook') || 'False';
  const isInternalAADUser = params.get('IsInternalAADUser') || 'False';
  const queryReturnUrl = params.get('ReturnUrl') || returnUrl || '/';

  // Preserve the original query string when fetching / POSTing to the server terms page.
  // The server reads the flags from the URL too, not just the body.
  const queryString = window.location.search;
  const serverTermsUrl = `/Account/Login/TermsAndConditions${queryString}`;

  const pageResponse = await fetch(serverTermsUrl, {
    credentials: 'same-origin',
    redirect: 'follow',
  });

  // Use the final URL the server responded from (may differ between login/registration flows).
  const finalTermsUrl = new URL(pageResponse.url).pathname + new URL(pageResponse.url).search;

  const pageHtml = await pageResponse.text();
  const parser = new DOMParser();
  const doc = parser.parseFromString(pageHtml, 'text/html');

  const antiForgeryToken = (doc.querySelector('input[name="__RequestVerificationToken"]') as HTMLInputElement)?.value || '';

  // Body flags match query-string flags so the server treats this as the correct sign-in flow type.
  // DO NOT hardcode UseExternalSignInAsync=False — that breaks external auth completion.
  const body = new URLSearchParams();
  body.set('__RequestVerificationToken', antiForgeryToken);
  body.set('InvitationCode', '');
  body.set('IsFacebook', isFacebook);
  body.set('UseExternalSignInAsync', useExternalSignInAsync);
  body.set('IsInternalAADUser', isInternalAADUser);
  body.set('IsTermsAndConditionsAccepted', 'true');

  const response = await fetch(finalTermsUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    credentials: 'same-origin',
    redirect: 'follow',
  });

  // Default to the ReturnUrl from the query string if no explicit one was passed —
  // that's where the server originally wanted to send the user.
  returnUrl = returnUrl ?? queryReturnUrl;

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

## Reset Password Flow for SPA Sites

### The Problem

The password reset email sends the user to `/Account/Login/ResetPassword?UserId=...&Code=...` — a server-rendered page outside the SPA. The user leaves the SPA experience.

### The Solution: Code-Site-Shell-Header Template

> **Why not use the original Header template?** The `pac pages upload-code-site` command intentionally replaces the "Header" and "Footer" web template content with `<div/>` on every upload. Any redirect script added to the Header template gets wiped. The solution is to create a separate web template and point the website record to it.

Create a new web template `Code-Site-Shell-Header` in `.powerpages-site/web-templates/code-site-shell-header/`:

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
  // Uses a separate template because pac pages upload-code-site wipes the original Header.
  (function () {
    var path = window.location.pathname.toLowerCase();
    var search = window.location.search;
    var spaBase = window.location.origin;
    var redirects = {
      '/account/login/resetpassword': '/reset-password'
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

Then update **`website.yml`** to point `headerwebtemplateid` to the new template's UUID:

```yaml
headerwebtemplateid: <new-template-uuid-from-yml>
```

The original "Header" template stays as `<div/>` — the upload command keeps wiping it, which is fine. The `Code-Site-Shell-Header` survives uploads because the command only targets templates named "Header" and "Footer".

The `redirects` object is extensible — add more server-to-SPA mappings as needed (e.g., email confirmation pages).

### React: ResetPassword Page Component

Create `src/pages/ResetPassword.tsx`:

- Read `UserId` and `Code` from URL query params
- If either is missing, show "Invalid Reset Link" with a link to `/forgot-password`
- Show new password + confirm password with validate-on-blur (same password strength rules as registration)
- Call `resetPassword(userId, code, password, confirmPassword)` on submit
- On success → redirect to `/login?message=password_reset_success`

### Login Page: Password Reset Success Message

The Login page must check for `?message=password_reset_success` on mount:

```typescript
const params = new URLSearchParams(window.location.search)
if (params.get('message') === 'password_reset_success') {
  setSuccessMessage('Your password has been reset. Please sign in with your new password.')
}
```

Display it as a green success banner above the form (distinct from the red error banner).

### Forgot Password Page: Success State

The ForgotPassword page must handle both `.then()` and `.catch()` from `forgotPassword()`:

```typescript
forgotPassword(email).then(() => {
  setIsSubmitting(false)
  setEmailSent(true)       // triggers success UI
}).catch(err => {
  setServerError(err.message)
  setIsSubmitting(false)
})
```

When `emailSent` is true, replace the form with a success confirmation: green checkmark icon, "Check your email" heading, and a "Back to sign in" link. Do NOT only handle `.catch()` — the button gets stuck in "Sending..." if `.then()` is not handled.

### Complete Password Reset Flow

1. User clicks "Forgot password?" on login → SPA `/forgot-password`
2. Enters email → `forgotPassword()` POSTs to server → success message "Check your email"
3. User opens email → clicks reset link → browser goes to `/Account/Login/ResetPassword?UserId=...&Code=...`
4. **Header template script fires** → `window.location.replace` to `/reset-password?UserId=...&Code=...`
5. SPA loads → ResetPassword page reads params → shows new password form
6. User submits → `resetPassword()` POSTs to server → redirect to `/login?message=password_reset_success`
7. Login page shows green "Password has been reset" banner

---

## Redeem Invitation Flow for SPA Sites

When `Authentication/Registration/InvitationEnabled = true`, invitation emails contain a link to `{site-url}/Account/Login/RedeemInvitation?invitation={code}`. To keep users in the SPA, we follow the same pattern as Reset Password: a header-template redirect + a dedicated SPA page + a service function that intercepts the server's 302 redirect.

### The redirect chain

```
Email link → /Account/Login/RedeemInvitation?invitation=ABC
  ↓ (Code-Site-Shell-Header script catches this URL)
/redeem-invitation?invitation=ABC           ← SPA page mounts
  ↓ (User clicks Continue)
POST /Account/Login/RedeemInvitation        ← fetch with redirect:'manual'
  ↓ (server validates, returns 302 OR 200)
  ├── 302 Location:/Account/Login/Register  → response.type === 'opaqueredirect'
  │     ↓ (SPA detects redirect, navigates)
  │     /registration?invitationCode=ABC    ← existing page (Phase 5.1.2)
  │
  ├── 200 OK with Login view markers        → server expects sign-in
  │     ↓ (SPA detects login HTML, navigates)
  │     /login?invitationCode=ABC           ← existing page (Phase 5.1.1)
  │
  └── 200 OK with validation-summary errors → throw parsed error
        (invalid / expired / already-redeemed code)
```

### Header template entry

Extend the existing `Code-Site-Shell-Header` template's redirect map:

```js
var redirects = {
  '/account/login/resetpassword': '/reset-password',
  '/account/login/redeeminvitation': '/redeem-invitation'  // ← add this
};
```

Only include the redeeminvitation entry when `REGISTRATION_MODE` is `Invitation-only` or `Both`. The path comparison is lowercased, so the script catches both `/Account/Login/RedeemInvitation` (server URL casing) and `/account/login/redeeminvitation`.

### Auth service additions

#### `redeemInvitation()` — the core function

Add to `src/services/authService.ts`:

```typescript
export interface RedeemInvitationResult {
  nextStep: 'register' | 'login';
}

export async function redeemInvitation(
  invitationCode: string,
  redeemByLogin: boolean,
  returnUrl: string = '/'
): Promise<RedeemInvitationResult> {
  if (!invitationCode) {
    throw new Error('Invitation code is required.');
  }

  if (isDevelopment) {
    return { nextStep: redeemByLogin ? 'login' : 'register' };
  }

  const token = await fetchAntiForgeryToken();

  const body = new URLSearchParams();
  body.set('__RequestVerificationToken', token);
  body.set('InvitationCode', invitationCode);
  body.set('RedeemByLogin', redeemByLogin ? 'true' : 'false');
  body.set('returnUrl', returnUrl);

  const response = await fetch('/Account/Login/RedeemInvitation', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    credentials: 'same-origin',
    redirect: 'manual',
  });

  // Branch 1: server returned a 302 redirect (caught by redirect:'manual').
  // Code is valid AND RedeemByLogin was false → server would have sent us to
  // /Account/Login/Register. We don't follow it — we navigate to our SPA /registration.
  if (response.type === 'opaqueredirect') {
    return { nextStep: 'register' };
  }

  // Branch 2: 200 OK — could be Login view (RedeemByLogin=true) or validation error.
  if (response.ok) {
    const html = await response.text();

    // 2a: Validation error (invalid/expired/already-redeemed code)
    const errors = parseServerErrors(html);
    if (errors.length > 0) {
      throw new Error(errors.join(' '));
    }

    // 2b: Login view returned — server expects user to sign in with existing account
    if (html.includes('name="PasswordValue"') || html.includes('LoginLocal')) {
      return { nextStep: 'login' };
    }

    throw new Error('Unable to process invitation. Please try again.');
  }

  throw new Error(`Failed to redeem invitation (status ${response.status}).`);
}
```

> **DevTools note**: After the POST resolves with `opaqueredirect`, Chrome's network panel will show the 302 Location target (e.g., `/Account/Login/Register`) as an aborted request with `net::ERR_ABORTED`. This is **expected** and not an actual error — it's the redirect we intentionally chose not to follow. The fast (~0.3ms) timing and the matching URL confirm it's the redirect target, not a network failure.

#### `fetchInvitationDetails()` — for email pre-fill on Registration page

Add to `src/services/authService.ts`:

```typescript
export interface InvitationDetails {
  email: string;
}

export async function fetchInvitationDetails(invitationCode: string): Promise<InvitationDetails> {
  if (!invitationCode) return { email: '' };

  if (isDevelopment) {
    return { email: 'invited.user@contoso.com' };
  }

  const regUrl = `/Account/Login/Register?invitationCode=${encodeURIComponent(invitationCode)}`;
  const response = await fetch(regUrl, { credentials: 'same-origin' });
  if (!response.ok) return { email: '' };

  const html = await response.text();
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  const emailInput = doc.getElementById('EmailTextBox') as HTMLInputElement | null;
  const email = emailInput?.getAttribute('value') || '';

  return { email };
}
```

#### `loginLocal()` update — accept invitationCode

Update the existing `loginLocal()` signature to accept an optional invitation code as the 5th parameter. Append it as `?InvitationCode={code}` on the `/SignIn` POST URL — the server's `Login(model, returnUrl, invitationCode)` reads it from the URL, not the body.

```typescript
export async function loginLocal(
  credential: string,
  password: string,
  rememberMe = false,
  returnUrl?: string,
  invitationCode?: string  // ← new
): Promise<void> {
  // ... existing dev/token setup ...

  const signInUrl = invitationCode
    ? `/SignIn?InvitationCode=${encodeURIComponent(invitationCode)}`
    : '/SignIn';

  const response = await fetch(signInUrl, {
    method: 'POST',
    // ... rest unchanged ...
  });
  // ... rest unchanged ...
}
```

After successful authentication, the server's `RedirectOnPostAuthenticate` (LoginController.cs line 3665) calls `InvitationManager.RedeemAsync(invitation, user, ...)` to link the invitation to the now-signed-in user's contact.

### React: RedeemInvitation page

Create `src/pages/RedeemInvitation.tsx`:

```typescript
import { useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { redeemInvitation } from '../services/authService'

const validateCode = (v: string) => {
  if (!v || !v.trim()) return 'Invitation code is required'
  return ''
}

export default function RedeemInvitation() {
  const navigate = useNavigate()

  const initialCode = (() => {
    const params = new URLSearchParams(window.location.search)
    return params.get('invitation') || params.get('InvitationCode') || params.get('code') || ''
  })()

  const [code, setCode] = useState(initialCode)
  const [redeemByLogin, setRedeemByLogin] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [touched, setTouched] = useState<Record<string, boolean>>({})
  const [serverError, setServerError] = useState<string | undefined>()
  const [isSubmitting, setIsSubmitting] = useState(false)

  useEffect(() => { document.title = 'Redeem Invitation' }, [])

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setTouched({ code: true })
    const error = validateCode(code)
    setErrors(error ? { code: error } : {})
    if (error) return

    setIsSubmitting(true)
    setServerError(undefined)

    redeemInvitation(code.trim(), redeemByLogin).then(result => {
      const target = result.nextStep === 'register' ? '/registration' : '/login'
      navigate(`${target}?invitationCode=${encodeURIComponent(code.trim())}`)
    }).catch(err => {
      setServerError(err instanceof Error ? err.message : 'Unable to verify invitation.')
      setIsSubmitting(false)
    })
  }

  // ... render form with invitation code input + "Sign in with an existing account
  // instead of registering" checkbox + Continue button (see contoso-portal site for
  // a complete styled example) ...
}
```

### Login page update

When `REGISTRATION_MODE` is `Invitation-only` or `Both`, update Login.tsx to:

1. Read `invitationCode` from URL on mount:
   ```typescript
   const invitationCode = new URLSearchParams(window.location.search)
     .get('invitationCode') || undefined
   ```
2. Show an info banner when present: `"Sign in to redeem invitation {code}. The invitation will be linked to your account after you sign in."`
3. Pass `invitationCode` to `loginLocal(email, password, rememberMe, '/', invitationCode)` on submit.

### Registration page update — email pre-fill + external provider buttons

When `REGISTRATION_MODE` is `Invitation-only` or `Both`, update Registration.tsx to call `fetchInvitationDetails(invitationCode)` on mount and pre-fill the email input. The input must be controlled (`value={email}`) and editable.

```typescript
useEffect(() => {
  if (!invitationCode) return
  fetchInvitationDetails(invitationCode).then(details => {
    if (details.email) setEmail(details.email)
  }).catch(() => { /* silent — user can enter email manually */ })
}, [invitationCode])
```

**Also when `EXTERNAL_PROVIDERS.length > 0`**, render external provider buttons above the local form (same layout as Login page). Each button calls `loginExternal(providerIdentifier, '/', invitationCode)` — the invitation code threads through to the IdP round-trip via `/Account/Login/ExternalLogin?InvitationCode={code}`, and the server's `ExternalLoginCallback` redeems the invitation as part of contact creation.

```tsx
{EXTERNAL_PROVIDERS.length > 0 && (
  <div style={styles.externalRow}>
    {EXTERNAL_PROVIDERS.map(provider => (
      <button key={provider.id} type="button"
        onClick={() => loginExternal(provider.providerIdentifier!, '/', invitationCode)}>
        {`Sign up with ${provider.displayName.replace(/^Sign in with /, '')}`}
      </button>
    ))}
  </div>
)}
{EXTERNAL_PROVIDERS.length > 0 && LOCAL_PROVIDER && <Divider label="OR SIGN UP WITH EMAIL" />}
{LOCAL_PROVIDER && <LocalRegistrationForm ... />}
```

### End-to-end flow summary

**Path A — User clicks invitation email link first (clean SPA entry):**
1. Admin creates an Invitation record in Dataverse (`adx_invitation` table) for an invited contact → captures `adx_invitationcode`
2. Admin sends user a link: `{site-url}/Account/Login/RedeemInvitation?invitation={code}`
3. User clicks → browser loads server page → header template script redirects to SPA `/redeem-invitation?invitation={code}`
4. SPA RedeemInvitation page mounts → code pre-filled → user picks register vs. login → submits
5. `redeemInvitation()` POSTs → server validates code → returns 302 (register) or 200 (login)
6. SPA detects branch and navigates to `/registration?invitationCode={code}` or `/login?invitationCode={code}`
7. **Register path with local auth**: Registration page pre-fills email via `fetchInvitationDetails()` → user completes form → POST creates account AND redeems invitation in one server call
8. **Register path with external auth**: User clicks external provider button on `/registration` → `loginExternal()` POSTs to `/Account/Login/ExternalLogin?InvitationCode={code}` → IdP → ExternalLoginCallback creates contact + redeems invitation
9. **Login path**: Login page shows info banner → user signs in (local or external — both thread `invitationCode` through) → server redeems invitation in `RedirectOnPostAuthenticate` after auth

**Path B — User clicks "Sign in with external provider" without invitation context (server-bounce path):**
1. User clicks external provider button on `/login` (or directly via `loginExternal()` from the Nav) — **no invitation code in URL**
2. `POST /Account/Login/ExternalLogin?Provider=...` → IdP → `/signin-{providername}` → 302 → `/Account/Login/ExternalLoginCallback?ReturnUrl=/`
3. **`GET /Account/Login/ExternalLoginCallback`**: server detects no contact + no invitation → 302 → `/Register?ReturnUrl=/` (the alias route for `LoginController.RedeemInvitation`, NOT the local Register page)
4. Code-Site-Shell-Header script catches `/register` → redirects to SPA `/redeem-invitation`
5. User enters invitation code → SPA `redeemInvitation()` → server returns 302 → `/Account/Login/Register?returnUrl=/&invitationCode={code}` (the local Register Web Forms page)
6. Header script catches `/account/login/register` → redirects to SPA `/registration?invitationCode={code}`
7. SPA Registration page mounts. External provider buttons visible at top. User clicks "Sign up with [external provider]" → `loginExternal(providerIdentifier, '/', invitationCode)`
8. `POST /Account/Login/ExternalLogin?InvitationCode={code}&Provider=...` → IdP (silent — cookies still valid from step 2) → `/signin-{providername}` → `/Account/Login/ExternalLoginCallback?InvitationCode={code}`
9. ExternalLoginCallback now has BOTH external auth + invitation → creates contact + redeems → 302 to ReturnUrl (or Terms if enabled)

> **Why the bounce?** The server's `RegistrationManager` enforces that external-authenticated users without a contact MUST either (a) have an invitation, or (b) be in a configuration where `OpenRegistrationEnabled = true` AND `AllowContactMappingWithEmail = true`. Without those, the server forces the invitation flow via the alias `/Register` route. The header redirect catches the bounce and keeps the user in the SPA throughout.

> **Verified via HAR analysis** on a live Power Pages site (smoking-burgers-inc) with Entra External ID + Terms enabled. The two new redirects (`/register` and `/account/login/register`) are critical for any site with external providers AND invitations enabled — without them, users see two server-rendered pages (RedeemInvitation form + local Register Web Forms page) in the middle of the flow.

---

## Entra External ID — Tenant and App Registration Prerequisites

Entra External ID requires three things to be set up in the Microsoft Entra admin center before Power Pages can use it: a tenant, an app registration, and a user flow. The setup-auth skill walks users through these in Phase 2.1, but here's the complete reference for the four-step process.

> Microsoft Learn: https://learn.microsoft.com/en-us/power-pages/security/authentication/entra-external-id

### Step 1 — Tenant

Entra External ID tenants are a distinct tenant type from regular workforce Entra ID tenants. **A workforce tenant cannot be used in place of an External ID tenant** — they're different products that share underlying technology.

To create an External ID tenant:

1. Open https://entra.microsoft.com/
2. Top of left navigation → **Manage tenants** → **Create**
3. Choose **External (for customers)** — not Workforce
4. Pick a domain prefix (the "tenant subdomain") — e.g., `contoso` becomes `contoso.ciamlogin.com`
5. The tenant has a 30-day free trial; attach an Azure subscription later

To verify whether an existing tenant is External or Workforce: tenant picker (top-right of entra.microsoft.com) shows an **External** badge next to External ID tenants.

**Values to capture for the skill:**
- **Tenant subdomain** — the part before `.ciamlogin.com` (e.g., `contoso`). Validate `^[a-z0-9-]+$`.
- **Tenant ID** (GUID) — from the tenant's Overview page. Validate UUID v4 regex.

### Step 2 — App registration

Register an app inside the External ID tenant:

1. **Applications → App registrations → New registration**
2. **Name** — typically `power-pages-{sitename}`
3. **Supported account types** — **single-tenant** is the recommended default. Multi-tenant configurations cause the Power Pages server to forcibly disable `AllowContactMappingWithEmail` (`BlockContactMappingSettingForMultitenantApp` feature flag in `LoginController.cs:2578-2587`).
4. **Redirect URI**:
   - Platform: **Web**
   - URI: `{SITE_URL}/signin-{ProviderName-lowercased}` — exact string matters, including the `signin-` prefix and the lowercased provider name suffix
5. **Register**
6. **Authentication** tab → check **Access tokens** + **ID tokens** under "Implicit grant and hybrid flows" → **Save**
7. **API permissions** tab → **Grant admin consent for {tenant}**

**Value to capture for the skill:**
- **Application (client) ID** — from the Overview tab. Validate UUID v4 regex.

**Do NOT create a client secret.** Entra External ID app registrations are public clients using PKCE — the OWIN OpenID Connect middleware in Power Pages performs the auth code exchange with PKCE, no secret needed. Adding one creates a confidential-client scenario that requires Azure Key Vault storage (advanced override; document but don't auto-configure).

### Step 3 — User flow

Without a user flow, sign-in fails after the IdP redirect.

1. **External Identities → User flows → New user flow**
2. **Name** — typically `{sitename}-signupsignin`. Validate `^[a-zA-Z0-9_-]+$`.
3. **Identity providers** for sign-in — **Email with password** (most common) or **Email one-time passcode** (passwordless)
4. **User attributes to collect** — these become the sign-up form fields. The skill should align this with the user's profile mapping choice from Track B:
   - "Standard" mapping → ☑ Email Address, ☑ Given Name, ☑ Surname
   - "Standard + phone" → also ☑ Phone Number
   - "Email only" → just ☑ Email Address
5. **User attributes to return as claims** — these are the values in the ID token. **Select the same attributes as in step 4** — these power the `RegistrationClaimsMapping` → Dataverse contact field flow. If a user selects an attribute to collect but NOT to return as a claim, the contact field stays empty even though the user provided the value.
6. **Create**
7. Open the user flow → **Applications** tab → **Add application** → select the app registered in Step 2

**Value to capture for the skill:**
- **User flow name** — used to confirm the user has one. Not written to a Power Pages site setting (the user flow is attached to the app, not referenced by name from Power Pages).

### Step 4 — Derived configuration

After collecting tenant subdomain, tenant ID, client ID, and user flow name, derive:

| Field | Value |
|---|---|
| Authority | `https://{subdomain}.ciamlogin.com/{tenantId}` — **no trailing `/v2.0/`** |
| MetadataAddress | `https://{subdomain}.ciamlogin.com/{tenantId}/v2.0/.well-known/openid-configuration` |
| AuthenticationType | Same as Authority (provider identifier for ExternalLogin POST must match) |
| RedirectUri | `{SITE_URL}/signin-{ProviderName-lowercased}` (same as Step 2) |

**Authority URL format quirk** — Entra External ID's Authority is the bare tenant path `https://{subdomain}.ciamlogin.com/{tenantId}`, NOT the `/v2.0/` variant. This differs from:
- **Classic Azure AD B2C** (`https://{tenant}.b2clogin.com/{tenant}.onmicrosoft.com/v2.0/{policy}` with policy in the path)
- **Generic OIDC** (often `{authority}/v2.0` or `{authority}/oauth2/default`)
- **Workforce Entra ID** (`https://login.microsoftonline.com/{tenantId}/v2.0/`)

The MetadataAddress, however, DOES include `/v2.0/` before `.well-known/openid-configuration`.

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
4. The Redirect URI in the app registration must also use the site's custom domain

The setup-auth skill walkthrough doesn't ask about custom domains in the initial flow — those configurations should be edited manually post-setup, or imported via Phase 1.5 discovery if pre-existing.

---

## External Login Confirmation Flow for SPA Sites

When a user signs in with an external provider (Entra External ID, OIDC, SAML2, etc.) for the first time and no Dataverse contact exists, the server renders `ExternalLoginConfirmation.aspx` at the OIDC callback URL (`/Account/Login/ExternalLoginCallback`). The user confirms/edits their email and the server creates the contact + signs them in. We SPA-ify this with the same pattern as Reset Password and Redeem Invitation.

### State storage that makes this work

The IdP's claims are stored in the `__External` cookie set by the OIDC middleware (see `Samples/MasterPortal/App_Start/Startup.Auth.cs:50-59`):

- `AuthenticationType = DefaultAuthenticationTypes.ExternalCookie` (`__External`)
- `ExpireTimeSpan = TimeSpan.FromMinutes(5)`
- `CookieSecure = CookieSecureOption.Always`
- `AuthenticationMode = AuthenticationMode.Passive` — auto-sent on same-origin requests
- `CookieSameSite` derived from site settings (typically `Lax`)

The SPA's fetch with `credentials: 'same-origin'` includes this cookie automatically, so the server returns the claim-populated form.

### Header template entry

Extend the `Code-Site-Shell-Header` redirect map:

```js
var redirects = {
  '/account/login/resetpassword': '/reset-password',
  '/account/login/redeeminvitation': '/redeem-invitation',
  '/account/login/externallogincallback': '/external-login-confirmation'  // ← add this
};
```

### Auth service additions

#### Types and error class

```typescript
export interface ExternalLoginDetails {
  email: string;
  firstName: string;
  lastName: string;
  username: string;
  invitationCode: string;
  returnUrl: string;
  antiForgeryToken: string;
}

export class ExternalLoginCookieExpiredError extends Error {
  constructor() {
    super('External login session expired. Please sign in again.');
    this.name = 'ExternalLoginCookieExpiredError';
  }
}
```

#### `fetchExternalLoginDetails()` — pre-fetch claim-populated form

```typescript
export async function fetchExternalLoginDetails(): Promise<ExternalLoginDetails> {
  if (isDevelopment) {
    return {
      email: 'invited.user@contoso.com',
      firstName: 'Invited',
      lastName: 'User',
      username: 'invited.user',
      invitationCode: '',
      returnUrl: '/',
      antiForgeryToken: 'dev-token',
    };
  }

  const response = await fetch('/Account/Login/ExternalLoginCallback', {
    credentials: 'same-origin',
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch external login details (status ${response.status}).`);
  }

  const html = await response.text();
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  // ExternalLoginFailure.aspx is returned when the __External cookie has expired.
  // Detect by the absence of the confirmation form.
  if (!doc.querySelector('input[name="Email"]')) {
    throw new ExternalLoginCookieExpiredError();
  }

  const getValue = (selector: string): string =>
    (doc.querySelector(selector) as HTMLInputElement | null)?.value || '';

  const formAction = doc.querySelector('form')?.getAttribute('action') || '';
  const actionParams = new URLSearchParams(formAction.split('?')[1] || '');

  return {
    email: getValue('input[name="Email"]'),
    firstName: getValue('input[name="FirstName"]'),
    lastName: getValue('input[name="LastName"]'),
    username: getValue('input[name="Username"]'),
    invitationCode: getValue('input[name="InvitationCode"]') || actionParams.get('InvitationCode') || '',
    returnUrl: actionParams.get('ReturnUrl') || '/',
    antiForgeryToken: getValue('input[name="__RequestVerificationToken"]'),
  };
}
```

#### `confirmExternalLogin()` — POST with redirect detection

```typescript
export async function confirmExternalLogin(details: ExternalLoginDetails): Promise<void> {
  if (isDevelopment) {
    window.location.href = details.returnUrl || '/';
    return;
  }

  const body = new URLSearchParams();
  body.set('__RequestVerificationToken', details.antiForgeryToken);
  body.set('Email', details.email);
  body.set('FirstName', details.firstName);
  body.set('LastName', details.lastName);
  body.set('Username', details.username);

  // Server reads ReturnUrl and InvitationCode from the form action URL query string.
  const params = new URLSearchParams();
  if (details.returnUrl) params.set('ReturnUrl', details.returnUrl);
  if (details.invitationCode) params.set('InvitationCode', details.invitationCode);
  const qs = params.toString();
  const postUrl = `/Account/Login/ExternalLoginConfirmation${qs ? `?${qs}` : ''}`;

  const response = await fetch(postUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    credentials: 'same-origin',
    redirect: 'manual',
  });

  // Server sets ApplicationCookie BEFORE returning the 302 — user is signed in.
  if (response.type === 'opaqueredirect') {
    window.location.href = details.returnUrl || '/';
    return;
  }

  if (response.ok) {
    const html = await response.text();
    const errors = parseServerErrors(html);
    if (errors.length > 0) throw new Error(errors.join(' '));

    // Server may render TermsAndConditions instead of redirecting to it.
    if (html.includes('TermsAndConditions') || html.includes('IsTermsAndConditionsAccepted')) {
      throw new TermsRequiredError();
    }

    throw new Error('Unable to complete external login. Please try again.');
  }

  throw new Error(`Failed to confirm external login (status ${response.status}).`);
}
```

### Page component (React)

```tsx
import { useEffect, useState, type FormEvent } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import {
  fetchExternalLoginDetails,
  confirmExternalLogin,
  ExternalLoginCookieExpiredError,
  TermsRequiredError,
  type ExternalLoginDetails,
} from '../services/authService'

export default function ExternalLoginConfirmation() {
  const navigate = useNavigate()
  const [details, setDetails] = useState<ExternalLoginDetails | null>(null)
  const [email, setEmail] = useState('')
  const [cookieExpired, setCookieExpired] = useState(false)
  // ... isLoading, isSubmitting, serverError state, validation, etc.

  useEffect(() => {
    fetchExternalLoginDetails()
      .then(d => { setDetails(d); setEmail(d.email) })
      .catch(err => {
        if (err instanceof ExternalLoginCookieExpiredError) setCookieExpired(true)
        // else show serverError
      })
  }, [])

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!details) return
    confirmExternalLogin({ ...details, email }).catch(err => {
      if (err instanceof TermsRequiredError) return navigate('/terms')
      if (err instanceof ExternalLoginCookieExpiredError) return setCookieExpired(true)
      // else show serverError
    })
  }

  if (cookieExpired) return <ExpiredCard />
  if (!details) return <LoadingCard />

  return (
    <form onSubmit={handleSubmit}>
      <h1>Almost done!</h1>
      {details.invitationCode && <Banner>Redeeming invitation {details.invitationCode}</Banner>}
      <ReadOnlyRow label="Name" value={`${details.firstName} ${details.lastName}`} />
      <input type="email" value={email} onChange={e => setEmail(e.target.value)} />
      <button type="submit">Create my account</button>
    </form>
  )
}
```

### Routing

Add `<Route path="/external-login-confirmation" element={<ExternalLoginConfirmation />} />` to the React Router config.

### Cookie expiry handling

The `__External` cookie has a **5-minute TTL**. If the user lingers between IdP callback and form submission, the cookie expires and the server returns `ExternalLoginFailure.aspx` instead of the confirmation form. The SPA detects this (no `input[name="Email"]` in the HTML) and shows an "expired" state with a link back to `/login`.

### Edge cases summary

| Case | Behavior |
|---|---|
| User has 2FA enabled | 2FA challenge happens AFTER `SignInAsync` completes (during the 302 navigation). SPA-ified confirmation doesn't interfere — 2FA challenge pages are server-rendered, separate flow. |
| `SameSite=Strict` cookie config | Fetch won't send `__External` cookie → `fetchExternalLoginDetails` throws `ExternalLoginCookieExpiredError` immediately. Default is `Lax` — works. |
| Invited user via external login | Invitation code captured from form action URL → preserved through POST → server redeems as part of contact creation. |
| Email mismatch with existing contact + `RequireUniqueEmail=true` | Server returns 200 with validation summary; SPA shows error inline. User can edit email and retry. |
| `AllowContactMappingWithEmail=true` and email matches existing contact | Server SKIPS the ExternalLoginConfirmation page entirely — user is signed in via the existing contact and lands at the return URL. The SPA page never mounts. |

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
