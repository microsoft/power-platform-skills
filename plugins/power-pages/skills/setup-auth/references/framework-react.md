# React integration

Use only this framework's wrapper, routing and authorization patterns.
Use the auth UI and optional-feature contracts selected in SKILL.md, adapting their examples to this framework.

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

  const loadUser = useCallback(() => {
    // Each hook owns state. Clone the mutable server snapshot for this consumer
    // and notify every mounted consumer when a profile save refreshes it.
    const current = getCurrentUser();
    setUser(current ? { ...current } : undefined);
    setIsLoading(false);
  }, []);

  const refresh = useCallback(() => {
    window.dispatchEvent(new Event('powerpages:auth-user-changed'));
  }, []);

  useEffect(() => {
    loadUser();
    window.addEventListener('powerpages:auth-user-changed', loadUser);
    return () => window.removeEventListener('powerpages:auth-user-changed', loadUser);
  }, [loadUser]);

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

## React Components

### RequireAuth

Create `src/components/RequireAuth.tsx`:

```tsx
import type { ReactNode } from 'react';
import { useAuth } from '../hooks/useAuth';

interface RequireAuthProps {
  children: ReactNode;
  fallback?: ReactNode;
}

/**
 * Renders children only when the user is authenticated.
 * Shows the fallback (or nothing) when not authenticated.
 */
export function RequireAuth({ children, fallback }: RequireAuthProps) {
  const { isAuthenticated, isLoading } = useAuth();

  if (isLoading) return null;
  if (!isAuthenticated) return <>{fallback ?? null}</>;
  return <>{children}</>;
}
```

### RequireRole

Create `src/components/RequireRole.tsx`:

```tsx
import type { ReactNode } from 'react';
import { useAuth } from '../hooks/useAuth';
import { hasAnyRole, hasAllRoles } from '../utils/authorization';

interface RequireRoleProps {
  roles: string[];
  requireAll?: boolean;
  children: ReactNode;
  fallback?: ReactNode;
}

/**
 * Renders children only when the user has the required role(s).
 * By default checks if the user has ANY of the listed roles.
 * Set requireAll=true to require ALL roles.
 */
export function RequireRole({ roles, requireAll = false, children, fallback }: RequireRoleProps) {
  const { isAuthenticated, isLoading } = useAuth();

  if (isLoading) return null;
  if (!isAuthenticated) return <>{fallback ?? null}</>;

  const hasAccess = requireAll ? hasAllRoles(roles) : hasAnyRole(roles);
  if (!hasAccess) return <>{fallback ?? null}</>;

  return <>{children}</>;
}
```

### useAuthorization Hook

Create `src/hooks/useAuthorization.ts`:

```typescript
import { useMemo } from 'react';
import { useAuth } from './useAuth';
import {
  getUserRoles,
  hasRole,
  hasAnyRole,
  hasAllRoles,
  isAdmin,
} from '../utils/authorization';

export function useAuthorization() {
  const { isAuthenticated } = useAuth();

  const roles = useMemo(() => getUserRoles(), [isAuthenticated]);

  return {
    roles,
    hasRole,
    hasAnyRole,
    hasAllRoles,
    isAuthenticated,
    isAdmin: isAdmin(),
  };
}
```

---
