# Authorization Reference

This document provides the complete implementation patterns for role-based authorization in Power Pages code sites.

## Core Authorization Utilities

Create `src/utils/authorization.ts`:

```typescript
// IMPORTANT: Client-side authorization is for UX only, not security.
// Server-side table permissions enforce actual access control.
// Always configure table permissions via /integrate-webapi.

import { getCurrentUser, isAuthenticated as checkAuthenticated } from '../services/authService';

/**
 * Returns the current user's web roles as an array of strings.
 */
export function getUserRoles(): string[] {
  const user = getCurrentUser();
  return user?.userRoles ?? [];
}

/**
 * Checks if the current user has a specific role (case-insensitive).
 */
export function hasRole(roleName: string): boolean {
  return getUserRoles().some(
    (role) => role.toLowerCase() === roleName.toLowerCase()
  );
}

/**
 * Checks if the current user has ANY of the specified roles.
 */
export function hasAnyRole(roleNames: string[]): boolean {
  return roleNames.some((role) => hasRole(role));
}

/**
 * Checks if the current user has ALL of the specified roles.
 */
export function hasAllRoles(roleNames: string[]): boolean {
  return roleNames.every((role) => hasRole(role));
}

/**
 * Re-export isAuthenticated for convenience.
 */
export function isAuthenticated(): boolean {
  return checkAuthenticated();
}

/**
 * Checks if the current user has the Administrators role.
 */
export function isAdmin(): boolean {
  return hasRole('Administrators');
}

/**
 * Checks if the user has elevated access (admin or specified additional roles).
 */
export function hasElevatedAccess(additionalRoles: string[] = []): boolean {
  return isAdmin() || hasAnyRole(additionalRoles);
}
```

---

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
  if (!isAuthenticated) return <>{fallback}</> || null;
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
  if (!isAuthenticated) return <>{fallback}</> || null;

  const hasAccess = requireAll ? hasAllRoles(roles) : hasAnyRole(roles);
  if (!hasAccess) return <>{fallback}</> || null;

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

## Vue 3 Patterns

### useAuthorization Composable

Create `src/composables/useAuthorization.ts`:

```typescript
import { computed } from 'vue';
import { useAuth } from './useAuth';
import {
  getUserRoles,
  hasRole,
  hasAnyRole,
  hasAllRoles,
  isAdmin as checkAdmin,
} from '../utils/authorization';

export function useAuthorization() {
  const { isAuthenticated } = useAuth();

  const roles = computed(() => getUserRoles());
  const isAdmin = computed(() => checkAdmin());

  return {
    roles,
    isAuthenticated,
    isAdmin,
    hasRole,
    hasAnyRole,
    hasAllRoles,
  };
}
```

### v-role Directive

Create `src/directives/vRole.ts`:

```typescript
import type { Directive } from 'vue';
import { hasRole, hasAnyRole } from '../utils/authorization';

/**
 * Directive for role-based element visibility.
 *
 * Usage:
 *   <div v-role="'Administrators'">Admin only</div>
 *   <div v-role="['Administrators', 'Editors']">Admin or Editor</div>
 */
export const vRole: Directive<HTMLElement, string | string[]> = {
  mounted(el, binding) {
    const roles = binding.value;
    const visible = Array.isArray(roles) ? hasAnyRole(roles) : hasRole(roles);
    if (!visible) {
      el.style.display = 'none';
    }
  },
  updated(el, binding) {
    const roles = binding.value;
    const visible = Array.isArray(roles) ? hasAnyRole(roles) : hasRole(roles);
    el.style.display = visible ? '' : 'none';
  },
};
```

---

## Angular Patterns

### Auth Guard

Create `src/app/guards/auth.guard.ts`:

```typescript
import { inject } from '@angular/core';
import { type CanActivateFn, Router } from '@angular/router';
import { AuthService } from '../services/auth.service';
import { hasAnyRole } from '../../utils/authorization';

/**
 * Route guard that requires authentication.
 */
export const authGuard: CanActivateFn = () => {
  const authService = inject(AuthService);
  const router = inject(Router);

  if (authService.isAuthenticated) {
    return true;
  }

  sessionStorage.setItem('redirectUrl', window.location.pathname);
  router.navigate(['/']);
  return false;
};

/**
 * Route guard that requires specific roles.
 * Configure required roles in route data: { roles: ['Administrators'] }
 */
export const roleGuard: CanActivateFn = (route) => {
  const authService = inject(AuthService);
  const router = inject(Router);

  if (!authService.isAuthenticated) {
    router.navigate(['/']);
    return false;
  }

  const requiredRoles = route.data?.['roles'] as string[] | undefined;
  if (requiredRoles && !hasAnyRole(requiredRoles)) {
    router.navigate(['/']);
    return false;
  }

  return true;
};
```

### HasRole Directive

Create `src/app/directives/has-role.directive.ts`:

```typescript
import { Directive, Input, TemplateRef, ViewContainerRef } from '@angular/core';
import { hasRole } from '../../utils/authorization';

/**
 * Structural directive for role-based element visibility.
 *
 * Usage:
 *   <div *appHasRole="'Administrators'">Admin only</div>
 */
@Directive({ selector: '[appHasRole]', standalone: true })
export class HasRoleDirective {
  @Input() set appHasRole(roleName: string) {
    if (hasRole(roleName)) {
      this.viewContainer.createEmbeddedView(this.templateRef);
    } else {
      this.viewContainer.clear();
    }
  }

  constructor(
    private templateRef: TemplateRef<unknown>,
    private viewContainer: ViewContainerRef
  ) {}
}
```

---

## Common Usage Patterns

### Conditional Navigation

```tsx
{/* React example */}
<nav>
  <Link to="/">Home</Link>
  <RequireAuth>
    <Link to="/dashboard">Dashboard</Link>
  </RequireAuth>
  <RequireRole roles={['Administrators']}>
    <Link to="/admin">Admin</Link>
  </RequireRole>
</nav>
```

### Conditional Action Buttons

```tsx
<RequireRole roles={['Administrators', 'Content Editors']}>
  <button onClick={handleEdit}>Edit</button>
  <button onClick={handleDelete}>Delete</button>
</RequireRole>
```

### Content Sections by Role

```tsx
<RequireAuth fallback={<p>Please sign in to view this content.</p>}>
  <p>Welcome, {displayName}!</p>

  <RequireRole roles={['Premium Users']} fallback={<p>Upgrade for premium content.</p>}>
    <PremiumContent />
  </RequireRole>
</RequireAuth>
```

---

## Security Considerations

**Client-side authorization is for UX only, not security.**

- The `window.Microsoft.Dynamic365.Portal.User.userRoles` array is set by the server and cannot be modified by the client in a way that affects server-side checks.
- However, hiding a UI element does NOT prevent a user from calling the underlying API directly.
- **Always configure server-side table permissions** to enforce data access control. Use `/integrate-webapi` to set up proper table permissions and site settings.
- Test both: verify the UI shows/hides correctly AND verify direct API calls respect table permissions.
