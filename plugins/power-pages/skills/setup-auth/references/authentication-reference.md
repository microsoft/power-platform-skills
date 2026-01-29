# Authentication Reference

## Login Flow

1. Fetch anti-forgery token from `/_layout/tokenhtml`
2. POST to `/Account/Login/ExternalLogin` with token, provider, returnUrl
3. User authenticates via AAD → session established
4. User info available in `window.Microsoft.Dynamic365.Portal.User`
5. Logout: redirect to `/Account/Login/LogOff`

## TypeScript Declarations

**File: `src/types/powerPages.d.ts`**

```typescript
/**
 * Power Pages Portal User Interface
 * Available at window.Microsoft.Dynamic365.Portal.User when user is logged in
 */
export interface PowerPagesUser {
  /** Login username */
  userName: string;
  /** User's first name */
  firstName: string;
  /** User's last name */
  lastName: string;
  /** User's email address */
  email: string;
  /** Dataverse Contact ID (GUID) */
  contactId: string;
  /** Array of web role names assigned to the user */
  userRoles: string[];
}

/**
 * Power Pages Portal Configuration
 * Available at window.Microsoft.Dynamic365.Portal
 */
export interface PowerPagesPortal {
  /** Current user information (populated when logged in) */
  User: PowerPagesUser;
  /** Portal version */
  version: string;
  /** Portal type */
  type: string;
  /** Portal ID */
  id: string;
  /** Geographic region */
  geo: string;
  /** Azure AD Tenant ID */
  tenant: string;
  /** Correlation ID for debugging */
  correlationId: string;
  /** Organization environment ID */
  orgEnvironmentId: string;
  /** Organization ID */
  orgId: string;
  /** Production or Trial indicator */
  portalProductionOrTrialType: string;
  /** Telemetry enabled flag */
  isTelemetryEnabled: string;
  /** Instrumentation settings */
  InstrumentationSettings: {
    instrumentationKey: string;
    collectorEndpoint: string;
  };
  /** Timer profile for batching */
  timerProfileForBatching: string;
  /** Active languages */
  activeLanguages: string[];
  /** Client API enabled flag */
  isClientApiEnabled: string;
}

/**
 * Microsoft namespace on window object
 */
export interface MicrosoftNamespace {
  Dynamic365: {
    Portal: PowerPagesPortal;
  };
}

/**
 * Extend Window interface
 */
declare global {
  interface Window {
    Microsoft?: MicrosoftNamespace;
  }
}

export {};
```

## Authentication Service

**File: `src/services/authService.ts`**

```typescript
import type { PowerPagesUser } from '../types/powerPages';

/**
 * Authentication state
 */
export interface AuthState {
  isAuthenticated: boolean;
  user: PowerPagesUser | null;
  isLoading: boolean;
}

/**
 * Get the current Power Pages portal user
 * Returns null if not authenticated or portal object not available
 */
export function getCurrentUser(): PowerPagesUser | null {
  try {
    const portalUser = window.Microsoft?.Dynamic365?.Portal?.User;

    // Check if user is actually logged in (userName will be empty if not)
    if (portalUser && portalUser.userName) {
      return {
        userName: portalUser.userName || '',
        firstName: portalUser.firstName || '',
        lastName: portalUser.lastName || '',
        email: portalUser.email || '',
        contactId: portalUser.contactId || '',
        userRoles: portalUser.userRoles || [],
      };
    }

    return null;
  } catch (error) {
    console.warn('[Auth] Failed to get current user:', error);
    return null;
  }
}

/**
 * Check if user is currently authenticated
 */
export function isAuthenticated(): boolean {
  const user = getCurrentUser();
  return user !== null && user.userName !== '';
}

/**
 * Get the tenant ID from the portal configuration
 */
export function getTenantId(): string {
  try {
    return window.Microsoft?.Dynamic365?.Portal?.tenant || '';
  } catch {
    return '';
  }
}

/**
 * Fetch the anti-forgery token required for login
 * This token prevents CSRF attacks on the login form
 */
async function fetchAntiForgeryToken(): Promise<string> {
  try {
    const tokenEndpoint = '/_layout/tokenhtml';
    const response = await fetch(tokenEndpoint);

    if (!response.ok) {
      throw new Error(`Failed to fetch token: ${response.status}`);
    }

    const tokenResponse = await response.text();

    // Parse the token from the HTML response
    // Response format: <input name="__RequestVerificationToken" type="hidden" value="TOKEN_VALUE" />
    const valueString = 'value="';
    const terminalString = '" />';
    const valueIndex = tokenResponse.indexOf(valueString);

    if (valueIndex === -1) {
      throw new Error('Token not found in response');
    }

    const token = tokenResponse.substring(
      valueIndex + valueString.length,
      tokenResponse.indexOf(terminalString, valueIndex)
    );

    return token;
  } catch (error) {
    console.error('[Auth] Failed to fetch anti-forgery token:', error);
    throw error;
  }
}

/**
 * Initiate login flow
 * Creates a form submission to the Power Pages login endpoint
 * This will redirect to Azure AD for authentication
 *
 * @param returnUrl - URL to redirect to after successful login (default: current page)
 */
export async function login(returnUrl?: string): Promise<void> {
  try {
    // Get anti-forgery token
    const token = await fetchAntiForgeryToken();

    // Get tenant ID for AAD login
    const tenantId = getTenantId();

    if (!tenantId) {
      throw new Error('Tenant ID not available. Ensure site is loaded from Power Pages.');
    }

    // Create form for submission
    const form = document.createElement('form');
    form.method = 'POST';
    form.action = '/Account/Login/ExternalLogin';

    // Anti-forgery token
    const tokenInput = document.createElement('input');
    tokenInput.type = 'hidden';
    tokenInput.name = '__RequestVerificationToken';
    tokenInput.value = token;
    form.appendChild(tokenInput);

    // Provider (Azure AD)
    const providerInput = document.createElement('input');
    providerInput.type = 'hidden';
    providerInput.name = 'provider';
    providerInput.value = `https://login.windows.net/${tenantId}/`;
    form.appendChild(providerInput);

    // Return URL
    const returnUrlInput = document.createElement('input');
    returnUrlInput.type = 'hidden';
    returnUrlInput.name = 'returnUrl';
    returnUrlInput.value = returnUrl || window.location.pathname;
    form.appendChild(returnUrlInput);

    // Submit the form
    document.body.appendChild(form);
    form.submit();
  } catch (error) {
    console.error('[Auth] Login failed:', error);
    throw error;
  }
}

/**
 * Logout the current user
 * Redirects to the Power Pages logout endpoint
 *
 * @param returnUrl - URL to redirect to after logout (default: home page)
 */
export function logout(returnUrl: string = '/'): void {
  const encodedReturnUrl = encodeURIComponent(returnUrl);
  window.location.href = `/Account/Login/LogOff?returnUrl=${encodedReturnUrl}`;
}

/**
 * Get user's display name (full name or username)
 */
export function getUserDisplayName(): string {
  const user = getCurrentUser();

  if (!user) {
    return '';
  }

  // Prefer full name, fall back to username
  const fullName = [user.firstName, user.lastName].filter(Boolean).join(' ');
  return fullName || user.userName;
}

/**
 * Get user's initials for avatar display
 */
export function getUserInitials(): string {
  const user = getCurrentUser();

  if (!user) {
    return '';
  }

  const firstName = user.firstName || '';
  const lastName = user.lastName || '';

  if (firstName && lastName) {
    return `${firstName[0]}${lastName[0]}`.toUpperCase();
  }

  if (user.userName) {
    return user.userName.substring(0, 2).toUpperCase();
  }

  return '';
}
```

## React Components

### Auth Button Component

**File: `src/components/AuthButton.tsx`**

```tsx
import { useState, useEffect } from 'react';
import {
  getCurrentUser,
  login,
  logout,
  getUserDisplayName,
  getUserInitials,
  type PowerPagesUser
} from '../services/authService';

interface AuthButtonProps {
  /** CSS class name for styling */
  className?: string;
  /** Show user avatar/initials when logged in */
  showAvatar?: boolean;
  /** Text for sign in button */
  signInText?: string;
  /** Text for sign out button */
  signOutText?: string;
}

export function AuthButton({
  className = '',
  showAvatar = true,
  signInText = 'Sign In',
  signOutText = 'Sign Out'
}: AuthButtonProps) {
  const [user, setUser] = useState<PowerPagesUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    // Check authentication state on mount
    const currentUser = getCurrentUser();
    setUser(currentUser);
    setIsLoading(false);
  }, []);

  const handleLogin = async () => {
    try {
      setIsLoading(true);
      await login();
      // Note: Page will redirect, so we don't need to handle success
    } catch (error) {
      console.error('Login error:', error);
      setIsLoading(false);
    }
  };

  const handleLogout = () => {
    logout();
  };

  if (isLoading) {
    return (
      <div className={`auth-button auth-button--loading ${className}`}>
        <span className="auth-button__spinner" />
      </div>
    );
  }

  if (user) {
    return (
      <div className={`auth-button auth-button--authenticated ${className}`}>
        {showAvatar && (
          <div className="auth-button__avatar" title={getUserDisplayName()}>
            {getUserInitials()}
          </div>
        )}
        <span className="auth-button__name">{getUserDisplayName()}</span>
        <button
          type="button"
          className="auth-button__logout"
          onClick={handleLogout}
        >
          {signOutText}
        </button>
      </div>
    );
  }

  return (
    <button
      type="button"
      className={`auth-button auth-button--login ${className}`}
      onClick={handleLogin}
    >
      {signInText}
    </button>
  );
}
```

### Auth Button Styles

**File: `src/components/AuthButton.css`**

```css
.auth-button {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
}

.auth-button--loading {
  opacity: 0.7;
}

.auth-button__spinner {
  width: 1rem;
  height: 1rem;
  border: 2px solid currentColor;
  border-top-color: transparent;
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.auth-button--authenticated {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.auth-button__avatar {
  width: 2rem;
  height: 2rem;
  border-radius: 50%;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  color: white;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.75rem;
  font-weight: 600;
}

.auth-button__name {
  font-weight: 500;
}

.auth-button__logout,
.auth-button--login {
  padding: 0.5rem 1rem;
  border: 1px solid currentColor;
  border-radius: 0.25rem;
  background: transparent;
  cursor: pointer;
  font-size: 0.875rem;
  transition: all 0.2s;
}

.auth-button__logout:hover,
.auth-button--login:hover {
  background: rgba(0, 0, 0, 0.05);
}
```

## React Hook

**File: `src/hooks/useAuth.ts`**

```typescript
import { useState, useEffect, useCallback } from 'react';
import {
  getCurrentUser,
  isAuthenticated as checkIsAuthenticated,
  login as performLogin,
  logout as performLogout,
  getUserDisplayName,
  type PowerPagesUser
} from '../services/authService';

interface UseAuthReturn {
  /** Current user or null if not authenticated */
  user: PowerPagesUser | null;
  /** Whether user is authenticated */
  isAuthenticated: boolean;
  /** Whether auth state is still loading */
  isLoading: boolean;
  /** User's display name */
  displayName: string;
  /** Initiate login flow */
  login: (returnUrl?: string) => Promise<void>;
  /** Logout user */
  logout: (returnUrl?: string) => void;
  /** Refresh auth state */
  refresh: () => void;
}

export function useAuth(): UseAuthReturn {
  const [user, setUser] = useState<PowerPagesUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const refresh = useCallback(() => {
    const currentUser = getCurrentUser();
    setUser(currentUser);
    setIsLoading(false);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const login = useCallback(async (returnUrl?: string) => {
    setIsLoading(true);
    await performLogin(returnUrl);
  }, []);

  const logout = useCallback((returnUrl?: string) => {
    performLogout(returnUrl);
  }, []);

  return {
    user,
    isAuthenticated: user !== null,
    isLoading,
    displayName: getUserDisplayName(),
    login,
    logout,
    refresh,
  };
}
```

## Vue 3 Composition API

**File: `src/composables/useAuth.ts`**

```typescript
import { ref, computed, onMounted } from 'vue';
import {
  getCurrentUser,
  login as performLogin,
  logout as performLogout,
  getUserDisplayName,
  getUserInitials,
  type PowerPagesUser
} from '../services/authService';

export function useAuth() {
  const user = ref<PowerPagesUser | null>(null);
  const isLoading = ref(true);

  const isAuthenticated = computed(() => user.value !== null);
  const displayName = computed(() => getUserDisplayName());
  const initials = computed(() => getUserInitials());

  function refresh() {
    user.value = getCurrentUser();
    isLoading.value = false;
  }

  async function login(returnUrl?: string) {
    isLoading.value = true;
    await performLogin(returnUrl);
  }

  function logout(returnUrl?: string) {
    performLogout(returnUrl);
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
    login,
    logout,
    refresh,
  };
}
```

## Angular Service

**File: `src/app/services/auth.service.ts`**

```typescript
import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';

interface PowerPagesUser {
  userName: string;
  firstName: string;
  lastName: string;
  email: string;
  contactId: string;
  userRoles: string[];
}

@Injectable({
  providedIn: 'root'
})
export class AuthService {
  private userSubject = new BehaviorSubject<PowerPagesUser | null>(null);
  private loadingSubject = new BehaviorSubject<boolean>(true);

  user$: Observable<PowerPagesUser | null> = this.userSubject.asObservable();
  isLoading$: Observable<boolean> = this.loadingSubject.asObservable();

  constructor() {
    this.refresh();
  }

  get currentUser(): PowerPagesUser | null {
    return this.userSubject.value;
  }

  get isAuthenticated(): boolean {
    return this.currentUser !== null;
  }

  refresh(): void {
    try {
      const portalUser = (window as any).Microsoft?.Dynamic365?.Portal?.User;

      if (portalUser && portalUser.userName) {
        this.userSubject.next({
          userName: portalUser.userName || '',
          firstName: portalUser.firstName || '',
          lastName: portalUser.lastName || '',
          email: portalUser.email || '',
          contactId: portalUser.contactId || '',
          userRoles: portalUser.userRoles || [],
        });
      } else {
        this.userSubject.next(null);
      }
    } catch {
      this.userSubject.next(null);
    }

    this.loadingSubject.next(false);
  }

  async login(returnUrl?: string): Promise<void> {
    this.loadingSubject.next(true);

    const token = await this.fetchAntiForgeryToken();
    const tenantId = (window as any).Microsoft?.Dynamic365?.Portal?.tenant || '';

    const form = document.createElement('form');
    form.method = 'POST';
    form.action = '/Account/Login/ExternalLogin';

    this.addHiddenField(form, '__RequestVerificationToken', token);
    this.addHiddenField(form, 'provider', `https://login.windows.net/${tenantId}/`);
    this.addHiddenField(form, 'returnUrl', returnUrl || window.location.pathname);

    document.body.appendChild(form);
    form.submit();
  }

  logout(returnUrl: string = '/'): void {
    window.location.href = `/Account/Login/LogOff?returnUrl=${encodeURIComponent(returnUrl)}`;
  }

  private async fetchAntiForgeryToken(): Promise<string> {
    const response = await fetch('/_layout/tokenhtml');
    const text = await response.text();

    const valueString = 'value="';
    const terminalString = '" />';
    const valueIndex = text.indexOf(valueString);

    return text.substring(
      valueIndex + valueString.length,
      text.indexOf(terminalString, valueIndex)
    );
  }

  private addHiddenField(form: HTMLFormElement, name: string, value: string): void {
    const input = document.createElement('input');
    input.type = 'hidden';
    input.name = name;
    input.value = value;
    form.appendChild(input);
  }
}
```

## Vanilla JavaScript

**File: `src/auth.js`**

```javascript
/**
 * Power Pages Authentication Module
 * Framework-agnostic authentication utilities
 */

/**
 * Get the current user from Power Pages portal object
 * @returns {Object|null} User object or null if not authenticated
 */
function getCurrentUser() {
  try {
    const portalUser = window.Microsoft?.Dynamic365?.Portal?.User;

    if (portalUser && portalUser.userName) {
      return {
        userName: portalUser.userName || '',
        firstName: portalUser.firstName || '',
        lastName: portalUser.lastName || '',
        email: portalUser.email || '',
        contactId: portalUser.contactId || '',
        userRoles: portalUser.userRoles || [],
      };
    }

    return null;
  } catch (error) {
    console.warn('[Auth] Failed to get current user:', error);
    return null;
  }
}

/**
 * Check if user is authenticated
 * @returns {boolean}
 */
function isAuthenticated() {
  const user = getCurrentUser();
  return user !== null && user.userName !== '';
}

/**
 * Fetch anti-forgery token
 * @returns {Promise<string>}
 */
async function fetchAntiForgeryToken() {
  const response = await fetch('/_layout/tokenhtml');
  const text = await response.text();

  const valueString = 'value="';
  const terminalString = '" />';
  const valueIndex = text.indexOf(valueString);

  return text.substring(
    valueIndex + valueString.length,
    text.indexOf(terminalString, valueIndex)
  );
}

/**
 * Initiate login flow
 * @param {string} [returnUrl] - URL to redirect to after login
 */
async function login(returnUrl) {
  const token = await fetchAntiForgeryToken();
  const tenantId = window.Microsoft?.Dynamic365?.Portal?.tenant || '';

  const form = document.createElement('form');
  form.method = 'POST';
  form.action = '/Account/Login/ExternalLogin';

  const fields = {
    '__RequestVerificationToken': token,
    'provider': `https://login.windows.net/${tenantId}/`,
    'returnUrl': returnUrl || window.location.pathname
  };

  Object.entries(fields).forEach(([name, value]) => {
    const input = document.createElement('input');
    input.type = 'hidden';
    input.name = name;
    input.value = value;
    form.appendChild(input);
  });

  document.body.appendChild(form);
  form.submit();
}

/**
 * Logout user
 * @param {string} [returnUrl='/'] - URL to redirect to after logout
 */
function logout(returnUrl = '/') {
  window.location.href = `/Account/Login/LogOff?returnUrl=${encodeURIComponent(returnUrl)}`;
}

// Export for module usage
export { getCurrentUser, isAuthenticated, login, logout };

// Also expose globally for non-module usage
window.PowerPagesAuth = { getCurrentUser, isAuthenticated, login, logout };
```

## Site Settings

When implementing authentication, configure these site settings in Power Pages to customize the login behavior.

### Disable Profile Page Redirect

**IMPORTANT**: By default, Power Pages redirects users to the built-in profile page (`/profile`) after login. For code sites (SPAs), you should disable this so users are redirected to your app's home page instead.

| Setting Name | Value | Description |
|--------------|-------|-------------|
| `Authentication/Registration/ProfileRedirectEnabled` | `false` | Disables redirect to profile page after login |

#### How to Configure

1. **Via Power Pages Admin Center**:
   - Go to **Set up** > **Site Settings**
   - Click **+ New setting**
   - Name: `Authentication/Registration/ProfileRedirectEnabled`
   - Value: `false`
   - Click **Save**

2. **Via PAC CLI**:
   ```powershell
   # Create site setting using PAC CLI
   pac paportal download --path ./portal-data --modelVersion 2
   # Add the setting to the site settings file and upload
   pac paportal upload --path ./portal-data
   ```

3. **Via Dataverse Web API**:
   ```typescript
   // Create site setting record
   await fetch(`${dataverseUrl}/api/data/v9.2/adx_sitesettings`, {
     method: 'POST',
     headers: {
       'Content-Type': 'application/json',
       'Authorization': `Bearer ${accessToken}`
     },
     body: JSON.stringify({
       'adx_name': 'Authentication/Registration/ProfileRedirectEnabled',
       'adx_value': 'false',
       'adx_websiteid@odata.bind': `/adx_websites(${websiteId})`
     })
   });
   ```

> **Note**: After setting this, users will be redirected to the `returnUrl` specified in the login form (see `login()` function in the Authentication Service section above), which defaults to the current page or home page.

### Other Useful Authentication Settings

| Setting Name | Value | Description |
|--------------|-------|-------------|
| `Authentication/Registration/Enabled` | `true` | Enable/disable registration |
| `Authentication/Registration/OpenRegistrationEnabled` | `true`/`false` | Allow open registration |
| `Authentication/Registration/InvitationEnabled` | `true`/`false` | Require invitation for registration |
| `Authentication/Registration/LocalLoginEnabled` | `true`/`false` | Enable local account login |

## Important Notes

### Local Development

- Authentication **only works** when the site is served from Power Pages
- During local development (`npm run dev`), the `window.Microsoft.Dynamic365.Portal` object will not be available
- Create mock data for local testing:

```typescript
// src/mocks/portalUser.ts (for development only)
if (import.meta.env.DEV) {
  (window as any).Microsoft = {
    Dynamic365: {
      Portal: {
        User: {
          userName: 'dev@example.com',
          firstName: 'Dev',
          lastName: 'User',
          email: 'dev@example.com',
          contactId: '00000000-0000-0000-0000-000000000000',
          userRoles: ['Authenticated Users', 'Administrators'],
        },
        tenant: 'your-tenant-id',
      },
    },
  };
}
```

### Security Considerations

1. **Server-side validation**: Always validate permissions on the server (via table permissions)
2. **Client-side is cosmetic**: Role checks in the UI are for UX only, not security
3. **Anti-forgery tokens**: Required for all POST operations to prevent CSRF attacks
4. **Session timeout**: Handle cases where session expires during usage
