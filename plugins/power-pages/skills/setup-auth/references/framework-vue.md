# Vue integration

Use only this framework's wrapper, routing and authorization patterns.
Use the auth UI and optional-feature contracts selected in SKILL.md, adapting their examples to this framework.

### Vue 3: useAuth Composable

Create `src/composables/useAuth.ts`:

```typescript
import { ref, computed, onMounted, onUnmounted } from 'vue';
import type { PowerPagesUser } from '../types/powerPages';
import {
  getCurrentUser,
  getUserDisplayName,
  getUserInitials,
  getAuthProvider,
  login as authLogin,
  logout as authLogout,
} from '../services/authService';

export function useAuth() {
  const user = ref<PowerPagesUser | undefined>(undefined);
  const isLoading = ref(true);

  const isAuthenticated = computed(() => !!user.value?.userName);
  const displayName = computed(() => { void user.value; return getUserDisplayName(); });
  const initials = computed(() => { void user.value; return getUserInitials(); });
  const provider = getAuthProvider();
  const providerType = computed(() => provider.type);
  const providerDisplayName = computed(() => provider.displayName || 'Sign In');

  function loadUser() {
    // Separate composable consumers must all repaint after a profile save,
    // even though Portal.User is mutated in place.
    const current = getCurrentUser();
    user.value = current ? { ...current } : undefined;
    isLoading.value = false;
  }

  function refresh() {
    window.dispatchEvent(new Event('powerpages:auth-user-changed'));
  }

  onMounted(() => {
    loadUser();
    window.addEventListener('powerpages:auth-user-changed', loadUser);
  });
  onUnmounted(() => {
    window.removeEventListener('powerpages:auth-user-changed', loadUser);
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
