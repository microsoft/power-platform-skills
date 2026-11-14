# Authorization contract

#### 4.1 Create Core Authorization Utilities

Create `src/utils/authorization.ts` with:

- `getUserRoles()` - returns array of role names from current user
- `hasRole(roleName)` - case-insensitive single role check
- `hasAnyRole(roleNames)` - OR check across multiple roles
- `hasAllRoles(roleNames)` - AND check across multiple roles
- `isAuthenticated()` - re-exports from auth service
- `isAdmin()` - checks for "Administrators" role
- `hasElevatedAccess(additionalRoles)` - checks admin or specified roles

#### 4.3 Security Reminder

Add a comment at the top of the authorization utilities:

```typescript
// IMPORTANT: Client-side authorization is for UX only, not security.
// Server-side table permissions enforce actual access control.
// Always configure table permissions via /integrate-webapi.
```

## Security Considerations

**Client-side authorization is for UX only, not security.**

- The `window.Microsoft.Dynamic365.Portal.User.userRoles` array is set by the server and cannot be modified by the client in a way that affects server-side checks.
- However, hiding a UI element does NOT prevent a user from calling the underlying API directly.
- **Always configure server-side table permissions** to enforce data access control. Use `/integrate-webapi` to set up proper table permissions and site settings.
- Test both: verify the UI shows/hides correctly AND verify direct API calls respect table permissions.

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
