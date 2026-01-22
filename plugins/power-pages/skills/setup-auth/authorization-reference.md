# Authorization Reference

This document provides code patterns for implementing role-based access control in Power Pages sites.

## How Power Pages Authorization Works

Power Pages provides user roles through the portal object:

```javascript
window.Microsoft.Dynamic365.Portal.User.userRoles  // Array of role names
```

Common built-in roles:
- **Anonymous Users** - Unauthenticated visitors
- **Authenticated Users** - Any logged-in user
- **Administrators** - Full admin access

Custom roles can be created in Power Pages Portal Management app.

```text
┌─────────────────────────────────────────────────────────────────┐
│                 User Roles in Power Pages                       │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  window.Microsoft.Dynamic365.Portal.User.userRoles = [         │
│    "Authenticated Users",                                       │
│    "Administrators",                                            │
│    "Premium Members"                                            │
│  ]                                                              │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

## Authorization Utilities

**File: `src/utils/authorization.ts`**

```typescript
import { getCurrentUser } from '../services/authService';

/**
 * Get all roles for the current user
 * @returns Array of role names (empty if not authenticated)
 */
export function getUserRoles(): string[] {
  const user = getCurrentUser();
  return user?.userRoles || [];
}

/**
 * Check if user has a specific role
 * @param roleName - Role name to check (case-insensitive)
 */
export function hasRole(roleName: string): boolean {
  const roles = getUserRoles();
  const normalizedRole = roleName.toLowerCase();
  return roles.some(role => role.toLowerCase() === normalizedRole);
}

/**
 * Check if user has ANY of the specified roles
 * @param roleNames - Array of role names to check
 */
export function hasAnyRole(roleNames: string[]): boolean {
  return roleNames.some(role => hasRole(role));
}

/**
 * Check if user has ALL of the specified roles
 * @param roleNames - Array of role names to check
 */
export function hasAllRoles(roleNames: string[]): boolean {
  return roleNames.every(role => hasRole(role));
}

/**
 * Check if user is authenticated (has any role other than Anonymous)
 */
export function isAuthenticated(): boolean {
  const user = getCurrentUser();
  return user !== null && user.userName !== '';
}

/**
 * Check if user is an administrator
 */
export function isAdmin(): boolean {
  return hasRole('Administrators');
}

/**
 * Check if user has elevated permissions (admin or specific roles)
 * @param additionalRoles - Additional roles that grant elevated access
 */
export function hasElevatedAccess(additionalRoles: string[] = []): boolean {
  return hasAnyRole(['Administrators', ...additionalRoles]);
}
```

## React Components for Conditional Rendering

### RequireAuth Component

Show content only to authenticated users.

**File: `src/components/RequireAuth.tsx`**

```tsx
import { ReactNode } from 'react';
import { isAuthenticated } from '../utils/authorization';

interface RequireAuthProps {
  /** Content to show when authenticated */
  children: ReactNode;
  /** Content to show when not authenticated (optional) */
  fallback?: ReactNode;
  /** Whether to show a login prompt as fallback */
  showLoginPrompt?: boolean;
}

export function RequireAuth({
  children,
  fallback = null,
  showLoginPrompt = false
}: RequireAuthProps) {
  if (isAuthenticated()) {
    return <>{children}</>;
  }

  if (showLoginPrompt) {
    return (
      <div className="auth-required">
        <p>Please sign in to access this content.</p>
        <button onClick={() => import('../services/authService').then(m => m.login())}>
          Sign In
        </button>
      </div>
    );
  }

  return <>{fallback}</>;
}
```

### RequireRole Component

Show content only to users with specific roles.

**File: `src/components/RequireRole.tsx`**

```tsx
import { ReactNode } from 'react';
import { hasAnyRole, hasAllRoles, isAuthenticated } from '../utils/authorization';

interface RequireRoleProps {
  /** Content to show when user has required roles */
  children: ReactNode;
  /** Role(s) required to view content */
  roles: string | string[];
  /** Require ALL roles (true) or ANY role (false, default) */
  requireAll?: boolean;
  /** Content to show when user lacks required roles */
  fallback?: ReactNode;
  /** Show access denied message */
  showAccessDenied?: boolean;
}

export function RequireRole({
  children,
  roles,
  requireAll = false,
  fallback = null,
  showAccessDenied = false
}: RequireRoleProps) {
  const roleArray = Array.isArray(roles) ? roles : [roles];

  // Check authentication first
  if (!isAuthenticated()) {
    if (showAccessDenied) {
      return (
        <div className="access-denied">
          <p>Please sign in to access this content.</p>
        </div>
      );
    }
    return <>{fallback}</>;
  }

  // Check roles
  const hasAccess = requireAll
    ? hasAllRoles(roleArray)
    : hasAnyRole(roleArray);

  if (hasAccess) {
    return <>{children}</>;
  }

  if (showAccessDenied) {
    return (
      <div className="access-denied">
        <p>You don't have permission to access this content.</p>
      </div>
    );
  }

  return <>{fallback}</>;
}
```

### RoleSwitch Component

Show different content based on user roles.

**File: `src/components/RoleSwitch.tsx`**

```tsx
import { ReactNode } from 'react';
import { hasAnyRole, isAuthenticated } from '../utils/authorization';

interface RoleSwitchProps {
  children: ReactNode;
}

interface RoleCaseProps {
  /** Roles that can see this content */
  roles: string | string[];
  children: ReactNode;
}

interface RoleDefaultProps {
  children: ReactNode;
}

// Context to track if a case has matched
let matched = false;

export function RoleSwitch({ children }: RoleSwitchProps) {
  matched = false;
  return <>{children}</>;
}

export function RoleCase({ roles, children }: RoleCaseProps) {
  if (matched) return null;

  const roleArray = Array.isArray(roles) ? roles : [roles];

  if (hasAnyRole(roleArray)) {
    matched = true;
    return <>{children}</>;
  }

  return null;
}

export function AuthenticatedCase({ children }: RoleDefaultProps) {
  if (matched) return null;

  if (isAuthenticated()) {
    matched = true;
    return <>{children}</>;
  }

  return null;
}

export function AnonymousCase({ children }: RoleDefaultProps) {
  if (matched) return null;

  if (!isAuthenticated()) {
    matched = true;
    return <>{children}</>;
  }

  return null;
}

export function RoleDefault({ children }: RoleDefaultProps) {
  if (matched) return null;
  return <>{children}</>;
}

// Usage example:
// <RoleSwitch>
//   <RoleCase roles="Administrators">
//     <AdminDashboard />
//   </RoleCase>
//   <RoleCase roles={["Premium Members", "VIP"]}>
//     <PremiumContent />
//   </RoleCase>
//   <AuthenticatedCase>
//     <MemberContent />
//   </AuthenticatedCase>
//   <AnonymousCase>
//     <PublicContent />
//   </AnonymousCase>
// </RoleSwitch>
```

## React Hook for Authorization

**File: `src/hooks/useAuthorization.ts`**

```typescript
import { useMemo } from 'react';
import {
  getUserRoles,
  hasRole,
  hasAnyRole,
  hasAllRoles,
  isAuthenticated,
  isAdmin
} from '../utils/authorization';

interface UseAuthorizationReturn {
  /** All roles for current user */
  roles: string[];
  /** Check if user has specific role */
  hasRole: (role: string) => boolean;
  /** Check if user has any of the roles */
  hasAnyRole: (roles: string[]) => boolean;
  /** Check if user has all of the roles */
  hasAllRoles: (roles: string[]) => boolean;
  /** Whether user is authenticated */
  isAuthenticated: boolean;
  /** Whether user is an administrator */
  isAdmin: boolean;
}

export function useAuthorization(): UseAuthorizationReturn {
  const roles = useMemo(() => getUserRoles(), []);

  return {
    roles,
    hasRole,
    hasAnyRole,
    hasAllRoles,
    isAuthenticated: isAuthenticated(),
    isAdmin: isAdmin(),
  };
}

// Usage:
// const { hasRole, isAdmin } = useAuthorization();
// if (hasRole('Premium Members')) { ... }
```

## Route Protection (React Router)

**File: `src/components/ProtectedRoute.tsx`**

```tsx
import { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { isAuthenticated, hasAnyRole } from '../utils/authorization';

interface ProtectedRouteProps {
  children: ReactNode;
  /** Roles required to access this route */
  roles?: string[];
  /** Redirect path when not authenticated */
  loginPath?: string;
  /** Redirect path when authenticated but lacking roles */
  unauthorizedPath?: string;
}

export function ProtectedRoute({
  children,
  roles,
  loginPath = '/login',
  unauthorizedPath = '/unauthorized'
}: ProtectedRouteProps) {
  const location = useLocation();

  // Check authentication
  if (!isAuthenticated()) {
    // Save intended destination for redirect after login
    return <Navigate to={loginPath} state={{ from: location }} replace />;
  }

  // Check roles if specified
  if (roles && roles.length > 0 && !hasAnyRole(roles)) {
    return <Navigate to={unauthorizedPath} replace />;
  }

  return <>{children}</>;
}

// Usage in router:
// <Route
//   path="/admin"
//   element={
//     <ProtectedRoute roles={['Administrators']}>
//       <AdminPage />
//     </ProtectedRoute>
//   }
// />
```

### Login Page with Redirect

**File: `src/pages/LoginPage.tsx`**

```tsx
import { useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { login } from '../services/authService';
import { isAuthenticated } from '../utils/authorization';

export function LoginPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const from = (location.state as any)?.from?.pathname || '/';

  useEffect(() => {
    // If already authenticated, redirect to intended destination
    if (isAuthenticated()) {
      navigate(from, { replace: true });
    }
  }, [from, navigate]);

  const handleLogin = async () => {
    // Pass the intended destination as return URL
    await login(from);
  };

  return (
    <div className="login-page">
      <h1>Sign In Required</h1>
      <p>Please sign in to access this page.</p>
      <button onClick={handleLogin}>Sign In with Azure AD</button>
    </div>
  );
}
```

## Vue 3 Authorization Composable

**File: `src/composables/useAuthorization.ts`**

```typescript
import { computed } from 'vue';
import { getCurrentUser } from '../services/authService';

export function useAuthorization() {
  const roles = computed(() => {
    const user = getCurrentUser();
    return user?.userRoles || [];
  });

  const isAuthenticated = computed(() => {
    const user = getCurrentUser();
    return user !== null && user.userName !== '';
  });

  function hasRole(roleName: string): boolean {
    const normalizedRole = roleName.toLowerCase();
    return roles.value.some(role => role.toLowerCase() === normalizedRole);
  }

  function hasAnyRole(roleNames: string[]): boolean {
    return roleNames.some(role => hasRole(role));
  }

  function hasAllRoles(roleNames: string[]): boolean {
    return roleNames.every(role => hasRole(role));
  }

  const isAdmin = computed(() => hasRole('Administrators'));

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

### Vue Directive for Role-Based Visibility

**File: `src/directives/vRole.ts`**

```typescript
import type { Directive } from 'vue';
import { getCurrentUser } from '../services/authService';

function hasRole(roleName: string): boolean {
  const user = getCurrentUser();
  const roles = user?.userRoles || [];
  return roles.some(role => role.toLowerCase() === roleName.toLowerCase());
}

function hasAnyRole(roleNames: string[]): boolean {
  return roleNames.some(role => hasRole(role));
}

/**
 * Vue directive for role-based visibility
 *
 * Usage:
 *   v-role="'Administrators'"
 *   v-role="['Administrators', 'Managers']"
 */
export const vRole: Directive<HTMLElement, string | string[]> = {
  mounted(el, binding) {
    const roles = Array.isArray(binding.value) ? binding.value : [binding.value];

    if (!hasAnyRole(roles)) {
      el.style.display = 'none';
    }
  },
  updated(el, binding) {
    const roles = Array.isArray(binding.value) ? binding.value : [binding.value];

    if (hasAnyRole(roles)) {
      el.style.display = '';
    } else {
      el.style.display = 'none';
    }
  },
};

// Register in main.ts:
// app.directive('role', vRole);
```

## Angular Authorization

### Auth Guard

**File: `src/app/guards/auth.guard.ts`**

```typescript
import { inject } from '@angular/core';
import { Router, CanActivateFn } from '@angular/router';
import { AuthService } from '../services/auth.service';

export const authGuard: CanActivateFn = (route, state) => {
  const authService = inject(AuthService);
  const router = inject(Router);

  if (!authService.isAuthenticated) {
    // Store intended URL for redirect after login
    sessionStorage.setItem('redirectUrl', state.url);
    router.navigate(['/login']);
    return false;
  }

  return true;
};

export const roleGuard: CanActivateFn = (route, state) => {
  const authService = inject(AuthService);
  const router = inject(Router);

  // First check authentication
  if (!authService.isAuthenticated) {
    sessionStorage.setItem('redirectUrl', state.url);
    router.navigate(['/login']);
    return false;
  }

  // Then check roles
  const requiredRoles = route.data['roles'] as string[];

  if (requiredRoles && requiredRoles.length > 0) {
    const userRoles = authService.currentUser?.userRoles || [];
    const hasRole = requiredRoles.some(role =>
      userRoles.some(ur => ur.toLowerCase() === role.toLowerCase())
    );

    if (!hasRole) {
      router.navigate(['/unauthorized']);
      return false;
    }
  }

  return true;
};

// Usage in routes:
// {
//   path: 'admin',
//   component: AdminComponent,
//   canActivate: [roleGuard],
//   data: { roles: ['Administrators'] }
// }
```

### Structural Directive for Role-Based Rendering

**File: `src/app/directives/has-role.directive.ts`**

```typescript
import { Directive, Input, TemplateRef, ViewContainerRef, OnInit } from '@angular/core';
import { AuthService } from '../services/auth.service';

@Directive({
  selector: '[appHasRole]',
  standalone: true
})
export class HasRoleDirective implements OnInit {
  @Input('appHasRole') roles: string | string[] = [];

  constructor(
    private templateRef: TemplateRef<any>,
    private viewContainer: ViewContainerRef,
    private authService: AuthService
  ) {}

  ngOnInit() {
    this.updateView();
  }

  private updateView() {
    const roleArray = Array.isArray(this.roles) ? this.roles : [this.roles];
    const userRoles = this.authService.currentUser?.userRoles || [];

    const hasRole = roleArray.some(role =>
      userRoles.some(ur => ur.toLowerCase() === role.toLowerCase())
    );

    this.viewContainer.clear();

    if (hasRole) {
      this.viewContainer.createEmbeddedView(this.templateRef);
    }
  }
}

// Usage in template:
// <button *appHasRole="'Administrators'">Admin Action</button>
// <div *appHasRole="['Administrators', 'Managers']">Management Section</div>
```

## Vanilla JavaScript

**File: `src/authorization.js`**

```javascript
/**
 * Power Pages Authorization Module
 * Framework-agnostic authorization utilities
 */

/**
 * Get user roles from portal object
 * @returns {string[]}
 */
function getUserRoles() {
  try {
    const user = window.Microsoft?.Dynamic365?.Portal?.User;
    return user?.userRoles || [];
  } catch {
    return [];
  }
}

/**
 * Check if user has a specific role
 * @param {string} roleName
 * @returns {boolean}
 */
function hasRole(roleName) {
  const roles = getUserRoles();
  const normalizedRole = roleName.toLowerCase();
  return roles.some(role => role.toLowerCase() === normalizedRole);
}

/**
 * Check if user has any of the specified roles
 * @param {string[]} roleNames
 * @returns {boolean}
 */
function hasAnyRole(roleNames) {
  return roleNames.some(role => hasRole(role));
}

/**
 * Check if user is authenticated
 * @returns {boolean}
 */
function isAuthenticated() {
  const user = window.Microsoft?.Dynamic365?.Portal?.User;
  return user && user.userName !== '';
}

/**
 * Show/hide element based on roles
 * @param {HTMLElement} element
 * @param {string|string[]} roles
 */
function showForRoles(element, roles) {
  const roleArray = Array.isArray(roles) ? roles : [roles];

  if (hasAnyRole(roleArray)) {
    element.style.display = '';
  } else {
    element.style.display = 'none';
  }
}

/**
 * Initialize role-based visibility for elements with data-require-role attribute
 * Usage: <div data-require-role="Administrators">Admin content</div>
 *        <div data-require-role="Admin,Manager">Multi-role content</div>
 */
function initRoleBasedVisibility() {
  document.querySelectorAll('[data-require-role]').forEach(element => {
    const rolesAttr = element.getAttribute('data-require-role');
    const roles = rolesAttr.split(',').map(r => r.trim());
    showForRoles(element, roles);
  });

  // Handle authentication-required elements
  document.querySelectorAll('[data-require-auth]').forEach(element => {
    if (!isAuthenticated()) {
      element.style.display = 'none';
    }
  });
}

// Auto-initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initRoleBasedVisibility);
} else {
  initRoleBasedVisibility();
}

// Export for module usage
export { getUserRoles, hasRole, hasAnyRole, isAuthenticated, showForRoles };

// Expose globally
window.PowerPagesAuth = {
  ...window.PowerPagesAuth,
  getUserRoles,
  hasRole,
  hasAnyRole,
  isAuthenticated,
  showForRoles,
};
```

## Common Usage Patterns

### Conditional Navigation Items

```tsx
// React example
function Navigation() {
  const { isAuthenticated, hasRole } = useAuthorization();

  return (
    <nav>
      <Link to="/">Home</Link>
      <Link to="/products">Products</Link>

      {/* Only for authenticated users */}
      {isAuthenticated && (
        <Link to="/account">My Account</Link>
      )}

      {/* Only for admins */}
      {hasRole('Administrators') && (
        <Link to="/admin">Admin Dashboard</Link>
      )}

      {/* Only for premium members */}
      {hasRole('Premium Members') && (
        <Link to="/premium">Premium Content</Link>
      )}
    </nav>
  );
}
```

### Conditional Action Buttons

```tsx
function ProductCard({ product, onEdit, onDelete }) {
  const { hasRole } = useAuthorization();

  return (
    <div className="product-card">
      <h3>{product.name}</h3>
      <p>{product.description}</p>

      {/* Edit/Delete only for admins or content managers */}
      {hasRole('Administrators') || hasRole('Content Managers') ? (
        <div className="product-actions">
          <button onClick={() => onEdit(product)}>Edit</button>
          <button onClick={() => onDelete(product)}>Delete</button>
        </div>
      ) : null}
    </div>
  );
}
```

### Content Sections by Role

```tsx
function Dashboard() {
  return (
    <div className="dashboard">
      <h1>Dashboard</h1>

      {/* Public section - everyone */}
      <section className="public-stats">
        <h2>Overview</h2>
        <PublicStats />
      </section>

      {/* Authenticated users section */}
      <RequireAuth>
        <section className="user-section">
          <h2>Your Activity</h2>
          <UserActivity />
        </section>
      </RequireAuth>

      {/* Admin-only section */}
      <RequireRole roles="Administrators">
        <section className="admin-section">
          <h2>Admin Controls</h2>
          <AdminControls />
        </section>
      </RequireRole>

      {/* Premium members section */}
      <RequireRole roles={['Premium Members', 'VIP']}>
        <section className="premium-section">
          <h2>Premium Features</h2>
          <PremiumFeatures />
        </section>
      </RequireRole>
    </div>
  );
}
```

## Security Considerations

### Client-Side Authorization is for UX Only

**IMPORTANT**: Client-side role checks are for **user experience** only, not security.

- They hide/show UI elements based on roles
- They do NOT prevent unauthorized access to data
- All data access must be protected by **table permissions** in Power Pages

### Always Enforce Server-Side

```text
┌─────────────────────────────────────────────────────────────────┐
│                    Security Layers                              │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  CLIENT-SIDE (UX only)        SERVER-SIDE (Security)           │
│  ─────────────────────        ─────────────────────             │
│  • Hide admin buttons         • Table permissions               │
│  • Show/hide nav items        • Entity permissions              │
│  • Conditional rendering      • Web roles in Power Pages        │
│  • Route guards (redirect)    • Actual data access control      │
│                                                                 │
│  If bypassed: Bad UX          If bypassed: Security breach      │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Example: Proper Security Setup

1. **Client-side** (this reference): Hide edit button for non-admins
2. **Server-side** (via `/setup-webapi`): Table permission allows only Administrators to PATCH records

If someone bypasses the UI and sends a PATCH request directly:
- **Without server-side protection**: Data gets modified (VULNERABILITY!)
- **With server-side protection**: Returns 403 Forbidden (SECURE)

### Testing Authorization

1. Test with different user accounts having different roles
2. Use browser dev tools to verify hidden elements can't be accessed
3. Test API calls directly to ensure table permissions are enforced
4. Never rely solely on client-side authorization
