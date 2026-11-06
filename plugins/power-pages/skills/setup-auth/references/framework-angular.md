# Angular integration

Use only this framework's wrapper, routing and authorization patterns.
Use the auth UI and optional-feature contracts selected in SKILL.md, adapting their examples to this framework.

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
    // Profile saves mutate Portal.User; emit a new object for UI consumers.
    const current = getCurrentUser();
    this.userSubject.next(current ? { ...current } : undefined);
    this.loadingSubject.next(false);
  }
}
```

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
