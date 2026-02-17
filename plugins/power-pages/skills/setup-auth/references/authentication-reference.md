# Authentication Reference

This document provides the complete implementation patterns for Power Pages authentication using Microsoft Entra ID.

## How Power Pages Authentication Works

Power Pages authentication is **server-side** using session cookies. There is no client-side token management.

### Login Flow

1. Fetch an anti-forgery token from `/_layout/tokenhtml`
2. POST a form to `/Account/Login/ExternalLogin` with the token, provider URL, and return URL
3. Power Pages redirects the user to Microsoft Entra ID for authentication
4. After successful authentication, the session is established via cookies
5. User information becomes available in `window.Microsoft.Dynamic365.Portal.User`

### Logout Flow

1. Redirect the user to `/Account/Login/LogOff`
2. Power Pages clears the session cookies
3. `window.Microsoft.Dynamic365.Portal.User` becomes `undefined`

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
 */
export function getTenantId(): string | undefined {
  if (isDevelopment) return '00000000-0000-0000-0000-000000000000';
  return window.Microsoft?.Dynamic365?.Portal?.tenant;
}

/**
 * Fetches the anti-forgery token required for the login form POST.
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
 * Initiates login by posting a form to the Power Pages external login endpoint.
 * The browser will redirect to Microsoft Entra ID for authentication.
 *
 * @param returnUrl - URL to return to after successful login (defaults to current page)
 */
export async function login(returnUrl?: string): Promise<void> {
  if (isDevelopment) {
    console.warn('[Auth] Login is not available in local development. Using mock user.');
    window.location.reload();
    return;
  }

  const token = await fetchAntiForgeryToken();
  const tenantId = getTenantId();

  const form = document.createElement('form');
  form.method = 'POST';
  form.action = '/Account/Login/ExternalLogin';

  const fields: Record<string, string> = {
    __RequestVerificationToken: token,
    provider: `https://login.windows.net/${tenantId}/`,
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
  login as authLogin,
  logout as authLogout,
} from '../services/authService';

interface UseAuthReturn {
  user: PowerPagesUser | undefined;
  isAuthenticated: boolean;
  isLoading: boolean;
  displayName: string;
  initials: string;
  login: (returnUrl?: string) => Promise<void>;
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

  return {
    user,
    isAuthenticated: checkAuth(),
    isLoading,
    displayName: getUserDisplayName(),
    initials: getUserInitials(),
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
  const { isAuthenticated, isLoading, displayName, initials, login, logout } = useAuth();

  if (isLoading) {
    return <div className="auth-button auth-loading"><span className="auth-spinner" /></div>;
  }

  if (!isAuthenticated) {
    return (
      <button className="auth-button auth-sign-in" onClick={() => login()}>
        Sign In
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
  login as authLogin,
  logout as authLogout,
} from '../services/authService';

export function useAuth() {
  const user = ref<PowerPagesUser | undefined>(undefined);
  const isLoading = ref(true);

  const isAuthenticated = computed(() => checkAuth());
  const displayName = computed(() => getUserDisplayName());
  const initials = computed(() => getUserInitials());

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
  login as authLogin,
  logout as authLogout,
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

  login(returnUrl?: string): Promise<void> {
    return authLogin(returnUrl);
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

## Site Settings

### Required: Disable Profile Redirect

Power Pages code sites do not have a built-in profile page. After login, Power Pages attempts to redirect to `/profile`, which returns a 404 on code sites. Disable this with a site setting:

**Site setting name:** `Authentication/Registration/ProfileRedirectEnabled`
**Value:** `false`

Create as a YAML file in `.powerpages-site/site-settings/`:

```yaml
id: <generated-uuid>
name: Authentication/Registration/ProfileRedirectEnabled
value: false
```

### Other Useful Settings

| Setting | Value | Description |
|---------|-------|-------------|
| `Authentication/Registration/Enabled` | `true` | Enable user registration |
| `Authentication/Registration/OpenRegistrationEnabled` | `true`/`false` | Allow self-registration |
| `Authentication/Registration/InvitationEnabled` | `true`/`false` | Allow invitation-based registration |
| `Authentication/Registration/LocalLoginEnabled` | `false` | Disable local (username/password) login when using Entra ID only |

These can be configured via the Power Pages admin center, PAC CLI, or Dataverse Web API as needed.

---

## Important Notes

- **Auth only works on deployed sites**: The `/_layout/tokenhtml` endpoint and `window.Microsoft.Dynamic365.Portal` object are only available when the site is served from Power Pages, not during local `npm run dev`.
- **Mock data for development**: The auth service includes a mock user pattern for local development. The mock user has configurable roles so developers can test role-based UI locally.
- **Security**: Always validate permissions server-side via table permissions. Client-side auth checks are for UX only — a direct API call bypasses all client-side checks.
- **Entra ID configuration**: The identity provider must be configured in the Power Pages admin center. This skill creates the client-side code but does not configure the identity provider itself.
