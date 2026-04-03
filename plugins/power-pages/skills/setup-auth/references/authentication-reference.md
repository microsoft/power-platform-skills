# Authentication Reference

This document provides the complete implementation patterns for Power Pages authentication across all supported identity providers.

## Supported Identity Providers

Power Pages supports the following authentication mechanisms:

| Provider Type | Description | Login Endpoint | Provider Identifier |
|---------------|-------------|----------------|---------------------|
| **Microsoft Entra ID** | Azure AD / Entra ID via OpenID Connect | `/Account/Login/ExternalLogin` | `https://login.windows.net/{tenantId}/` |
| **Azure AD B2C** | Azure AD B2C with user flow policies | `/Account/Login/ExternalLogin` | Site setting `Authentication/OpenIdConnect/{name}/AuthenticationType` |
| **OpenID Connect (Generic)** | Any OIDC-compliant provider (Okta, Auth0, Ping, etc.) | `/Account/Login/ExternalLogin` | Site setting `Authentication/OpenIdConnect/{name}/AuthenticationType` |
| **SAML2** | SAML 2.0 identity providers (ADFS, Shibboleth, etc.) | `/Account/Login/ExternalLogin` | Site setting `Authentication/SAML2/{name}/AuthenticationType` |
| **WS-Federation** | WS-Federation identity providers | `/Account/Login/ExternalLogin` | Site setting `Authentication/WsFederation/{name}/AuthenticationType` |
| **Local Authentication** | Username/password login without external provider | `/Account/Login/Login` | N/A (direct credential POST) |
| **Social OAuth** | Microsoft Account, Facebook, Google | `/Account/Login/ExternalLogin` | Provider-specific (e.g., `urn:microsoft:account`, `Facebook`, `Google`) |

## How Power Pages Authentication Works

Power Pages authentication is **server-side** using session cookies. There is no client-side token management.

### External Login Flow (Entra ID, OIDC, SAML2, WS-Federation, Social OAuth)

1. Fetch an anti-forgery token from `/_layout/tokenhtml`
2. POST a form to `/Account/Login/ExternalLogin` with the token, provider identifier, and return URL
3. Power Pages redirects the user to the identity provider for authentication
4. After successful authentication, the session is established via cookies
5. User information becomes available in `window.Microsoft.Dynamic365.Portal.User`

### Local Login Flow

1. Fetch an anti-forgery token from `/_layout/tokenhtml`
2. POST a form to `/Account/Login/Login` with the token, credentials, and password:
   - When `Authentication/Registration/LocalLoginByEmail` is `true`: send the `Email` field
   - When `Authentication/Registration/LocalLoginByEmail` is `false`: send the `Username` field
   - Optionally include `RememberMe` field (when `Authentication/Registration/RememberMeEnabled` is `true`)
3. Power Pages validates credentials against the contact record in Dataverse
4. If 2FA is enabled and required for the user, the server redirects to `SendCode` action instead of completing sign-in
5. On success, the session is established via cookies
6. User information becomes available in `window.Microsoft.Dynamic365.Portal.User`

### Logout Flow (All Providers)

1. Redirect the user to `/Account/Login/LogOff`
2. Power Pages clears the session cookies
3. `window.Microsoft.Dynamic365.Portal.User` becomes `undefined`
4. For providers with external logout enabled, the user may also be signed out of the identity provider

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
  | 'azure-ad-b2c';

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
  if (isDevelopment) return MOCK_USER;
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
      return `https://login.windows.net/${tenantId}/`;
    }
    case 'azure-ad-b2c':
      throw new Error(
        'providerIdentifier must be set in AUTH_PROVIDER config for Azure AD B2C. ' +
        'Use the AuthenticationType value from your B2C site settings.'
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
 * @param credentials - For local login only: { username, password }
 */
export async function login(
  returnUrl?: string,
  credentials?: { username: string; password: string; rememberMe?: boolean }
): Promise<void> {
  if (isDevelopment) {
    console.warn('[Auth] Login is not available in local development. Using mock user.');
    window.location.reload();
    return;
  }

  const token = await fetchAntiForgeryToken();

  if (AUTH_PROVIDER.type === 'local') {
    // Local login: POST credentials directly to the login endpoint
    if (!credentials) {
      throw new Error('Local login requires username and password credentials.');
    }

    const form = document.createElement('form');
    form.method = 'POST';
    form.action = '/Account/Login/Login';

    // When LocalLoginByEmail is true, send the Email field; otherwise send Username.
    // The server checks ViewBag.Settings.LocalLoginByEmail to determine which field to read.
    const credentialFieldName = AUTH_PROVIDER.loginByEmail ? 'Email' : 'Username';

    const fields: Record<string, string> = {
      __RequestVerificationToken: token,
      [credentialFieldName]: credentials.username,
      Password: credentials.password,
      ReturnUrl: returnUrl || window.location.pathname,
    };

    // Include RememberMe if enabled and requested
    if (credentials.rememberMe) {
      fields.RememberMe = 'true';
    }

    for (const [name, value] of Object.entries(fields)) {
      const input = document.createElement('input');
      input.type = 'hidden';
      input.name = name;
      input.value = value;
      form.appendChild(input);
    }

    document.body.appendChild(form);
    form.submit();
    return;
  }

  // External login: POST to ExternalLogin endpoint with provider identifier
  const provider = resolveProviderIdentifier();

  const form = document.createElement('form');
  form.method = 'POST';
  form.action = '/Account/Login/ExternalLogin';

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
    console.warn('[Auth] Logout is not available in local development.');
    window.location.reload();
    return;
  }

  const target = returnUrl || '/';
  window.location.href = `/Account/Login/LogOff?returnUrl=${encodeURIComponent(target)}`;
}

/**
 * Returns the user's display name (full name if available, otherwise userName).
 */
export function getUserDisplayName(): string {
  const user = getCurrentUser();
  if (!user) return '';
  const fullName = [user.firstName, user.lastName].filter(Boolean).join(' ');
  return fullName || user.userName;
}

/**
 * Returns the user's initials for avatar display.
 */
export function getUserInitials(): string {
  const user = getCurrentUser();
  if (!user) return '';
  if (user.firstName && user.lastName) {
    return `${user.firstName[0]}${user.lastName[0]}`.toUpperCase();
  }
  return (user.userName?.[0] || '').toUpperCase();
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
  providerIdentifier: 'https://contoso.powerappsportals.com/', // Must match AuthenticationType site setting
  displayName: 'Sign in with ADFS',
};
```

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

### Social OAuth Providers

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

### Azure AD B2C

```typescript
const AUTH_PROVIDER: AuthProviderConfig = {
  type: 'azure-ad-b2c',
  providerIdentifier: 'https://contoso.b2clogin.com/contoso.onmicrosoft.com/v2.0/', // Must match AuthenticationType site setting
  displayName: 'Sign in with Azure AD B2C',
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
  login: (returnUrl?: string, credentials?: { username: string; password: string; rememberMe?: boolean }) => Promise<void>;
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

When the provider type is `local`, also create `src/components/LocalLoginForm.tsx`:

```tsx
import { useState } from 'react';
import { login, getAuthProvider } from '../services/authService';
import './LocalLoginForm.css';

export function LocalLoginForm() {
  const [credential, setCredential] = useState('');
  const [password, setPassword] = useState('');
  const [rememberMe, setRememberMe] = useState(false);
  const [error, setError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const provider = getAuthProvider();
  const isEmailMode = provider.loginByEmail ?? true;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setIsSubmitting(true);
    try {
      await login(undefined, { username: credential, password, rememberMe });
    } catch (err) {
      setError('Login failed. Please check your credentials.');
      setIsSubmitting(false);
    }
  };

  return (
    <form className="local-login-form" onSubmit={handleSubmit}>
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
      {error && <div className="form-error">{error}</div>}
      <button type="submit" disabled={isSubmitting}>
        {isSubmitting ? 'Signing in...' : 'Sign In'}
      </button>
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

  login(returnUrl?: string, credentials?: { username: string; password: string }): Promise<void> {
    return authLogin(returnUrl, credentials);
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

### Azure AD B2C Provider Settings

B2C uses the same `Authentication/OpenIdConnect/{ProviderName}/{SettingName}` path as generic OIDC but with additional policy-related settings:

| Setting | Description |
|---------|-------------|
| `DefaultPolicyId` | The sign-up/sign-in user flow policy name (e.g., `B2C_1_signupsignin`) |
| `PasswordResetPolicyId` | The password reset user flow policy name (e.g., `B2C_1_passwordreset`) |
| `ProfileEditPolicyId` | The profile editing user flow policy name (e.g., `B2C_1_profileedit`) |

All other settings from the OpenID Connect section above also apply to B2C providers.

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

> **Security Warning:** Never commit `ClientSecret` or `AppSecret` values to source control. Use the Power Pages admin center to configure sensitive credential values. Site setting YAML files with placeholder values (e.g., `<to-be-configured>`) are acceptable for tracking which settings are needed, but actual secrets must be managed through the admin center or environment variables.

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

## Azure AD B2C Provider

Azure AD B2C is a distinct provider type that uses OpenID Connect underneath but requires additional configuration for user flow policies: sign-up/sign-in, password reset, and profile editing.

### B2C Provider Type

```typescript
export type AuthProviderType =
  | 'entra-id'
  | 'oidc'
  | 'saml2'
  | 'ws-federation'
  | 'local'
  | 'social'
  | 'azure-ad-b2c';
```

### B2C AUTH_PROVIDER Configuration

```typescript
const AUTH_PROVIDER: AuthProviderConfig = {
  type: 'azure-ad-b2c',
  providerIdentifier: 'https://{tenant}.b2clogin.com/{tenant}.onmicrosoft.com/v2.0/', // Must match AuthenticationType site setting
  displayName: 'Sign in with Azure AD B2C',
};
```

### B2C Site Settings

Pattern: `Authentication/OpenIdConnect/{ProviderName}/{SettingName}`

B2C uses the same OpenID Connect site setting path but with additional policy settings:

| Setting | Description |
|---------|-------------|
| `Authority` | B2C authority URL (e.g., `https://{tenant}.b2clogin.com/{tenant}.onmicrosoft.com/v2.0/`) |
| `ClientId` | Application (client) ID from the B2C app registration |
| `AuthenticationType` | Unique identifier for this provider (typically the authority URL) |
| `RedirectUri` | Callback URL (e.g., `{site-url}/signin-{provider}`) |
| `MetadataAddress` | B2C metadata URL including policy (e.g., `https://{tenant}.b2clogin.com/{tenant}.onmicrosoft.com/v2.0/.well-known/openid-configuration?p={sign-up-sign-in-policy}`) |
| `DefaultPolicyId` | The sign-up/sign-in user flow policy name (e.g., `B2C_1_signupsignin`) |
| `PasswordResetPolicyId` | The password reset user flow policy name (e.g., `B2C_1_passwordreset`) |
| `ProfileEditPolicyId` | The profile editing user flow policy name (e.g., `B2C_1_profileedit`) |
| `ExternalLogoutEnabled` | `true` to sign out of B2C on logout |
| `Caption` | Display name shown on the login button |

### B2C Error Handling

The server handles two specific B2C error codes in the `AuthenticationFailed` notification:

- **`AADB2C90118`** -- User clicked "Forgot password?" on the sign-in page. The server redirects to the `ExternalPasswordReset` action with the `PasswordResetPolicyId`. The client-side auth service does not need to handle this directly; it is managed by the server middleware.
- **`AADB2C90091`** -- User cancelled the sign-up, password reset, or profile edit flow. The server redirects back to the login page without error.

### B2C Password Reset Flow

1. User clicks "Forgot password?" on the B2C sign-up/sign-in policy page
2. B2C returns error code `AADB2C90118`
3. Server middleware catches the error and redirects to `/Account/Login/ExternalPasswordReset?passwordResetPolicyId={policy}&provider={provider}`
4. The `ExternalPasswordReset` action sets the policy in the OWIN context and challenges the provider with the password reset policy
5. After password reset, the user is redirected back to the login page

### B2C Profile Editing

The server exposes an `ExternalProfileEdit` action at `/Account/Login/ExternalProfileEdit` that:
1. Sets the `ProfileEditPolicyId` in the OWIN context
2. Challenges the provider to initiate the profile edit flow
3. On completion, maps updated claims back to the contact record

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

To support invitation codes in the client-side auth service, the `login()` function should accept and pass through the invitation code:

```typescript
export async function login(
  returnUrl?: string,
  credentials?: { username: string; password: string; rememberMe?: boolean },
  invitationCode?: string
): Promise<void> {
  // ... (fetch anti-forgery token)

  if (AUTH_PROVIDER.type === 'local') {
    // Include invitationCode in the form fields if present
    if (invitationCode) {
      fields.InvitationCode = invitationCode;
    }
    // ... (submit form to /Account/Login/Login)
  }

  // For external login, append invitationCode as a query parameter
  if (invitationCode) {
    form.action = `/Account/Login/ExternalLogin?InvitationCode=${encodeURIComponent(invitationCode)}`;
  }
  // ... (submit form)
}
```

---

## Secret Management

> **Security Warning:** Never commit `ClientSecret`, `AppSecret`, or any other credential values to source control.

### Best Practices

- **Site setting YAML files** created by this skill use placeholder values (e.g., `<to-be-configured>`) for secrets. These placeholders are safe to commit -- they indicate which settings need to be configured but do not contain actual credentials.
- **Configure actual secrets** through the Power Pages admin center, which stores values securely in Dataverse.
- **Never store secrets** in `authService.ts`, environment files (`.env`), or any file tracked by version control.
- **Review before committing**: Always verify that no actual `ClientSecret`, `AppSecret`, API key, or certificate values are included in your commits.
- **The `providerIdentifier` field** in `AUTH_PROVIDER` is NOT a secret -- it is a public identifier (like a URL or provider name) that identifies which identity provider to use.

---

## Important Notes

- **Auth only works on deployed sites**: The `/_layout/tokenhtml` endpoint and `window.Microsoft.Dynamic365.Portal` object are only available when the site is served from Power Pages, not during local `npm run dev`.
- **Mock data for development**: The auth service includes a mock user pattern for local development. The mock user has configurable roles so developers can test role-based UI locally.
- **Security**: Always validate permissions server-side via table permissions. Client-side auth checks are for UX only -- a direct API call bypasses all client-side checks. Never commit secrets (`ClientSecret`, `AppSecret`) to source control -- use the Power Pages admin center for sensitive values.
- **Provider configuration**: The identity provider must be configured in the Power Pages admin center (for Entra ID) or via site settings (for OIDC, SAML2, WS-Fed, Social, B2C). This skill creates the client-side code and site settings but does not configure the external identity provider itself.
- **Multiple providers**: Power Pages supports multiple identity providers simultaneously. Users see all configured providers on the login page. To configure multiple providers, create separate site settings for each and update the auth service to support provider selection.
