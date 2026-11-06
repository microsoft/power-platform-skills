# Session lifetime and keepalive

#### 3.5 Create Session KeepAlive Hook

> **SPA session expiry problem:** In SPAs, page navigation is client-side - no server requests are made. The session cookie's `SlidingExpiration` only renews when the browser sends a request to the server. Without a keepalive, the session silently expires even while the user is actively using the SPA. The default `ExpireTimeSpan` is 24 hours with renewal at the halfway point (12 hours), but this can be configured shorter.

> **Provider-agnostic - works for local AND external auth.** Power Pages issues the same `ApplicationCookie` session cookie regardless of how the user signed in (local password, Entra External ID, generic OIDC, SAML2, social). The keepalive operates on that cookie, so the same hook covers every provider. `isAuthenticated()` reads from `window.Microsoft.Dynamic365.Portal.User` which is populated for any authenticated user. No provider-specific branches are needed.

> **External providers - two independent clocks.** For external auth, the Power Pages session cookie and the IdP token (e.g., Entra External ID's ID token / refresh token) have separate lifetimes. The Power Pages session is what the SPA needs to keep alive; the IdP token is invisible to the SPA. When the Power Pages session does expire and the user is redirected to `/login?sessionExpired=true`, clicking the external provider button kicks off the IdP round-trip - but if the IdP's SSO cookie is still valid (typical), the round-trip is silent (no credential re-entry). The user lands back in the site signed in. This is the expected UX and requires no extra handling.

Create a session keepalive hook that periodically pings `/_layout/tokenhtml` to renew the session cookie:

- **React**: Create `src/hooks/useSessionKeepAlive.ts`
- **Vue**: Create `src/composables/useSessionKeepAlive.ts`
- **Angular**: Create `src/app/services/session-keepalive.service.ts`
- **Astro**: Create a client-side session module initialized from the shared layout's script, never its server-rendered frontmatter

The hook must:

- Define a `SESSION_EXPIRE_MS` constant based on the session timeout:
  - If the user configured a custom `ApplicationCookie/ExpireTimeSpan` in Phase 2.1.1, convert that timespan to milliseconds
  - If using defaults, use `24 * 60 * 60 * 1000` (24 hours)
- Derive timing from the session timeout - do NOT hardcode intervals:
  - `intervalMs` = `min(SESSION_EXPIRE_MS / 3, 15 * 60 * 1000)` - ping at 1/3 of the session timeout, capped at 15min. This ensures the ping happens well before the SlidingExpiration halfway renewal point.
  - `idleTimeoutMs` = `min(SESSION_EXPIRE_MS * 0.9, 30 * 60 * 1000)` - stop pinging when idle for 90% of the session timeout, capped at 30min.
  - Example: 10min session → intervalMs=3.3min, idleTimeoutMs=9min. 24h session → intervalMs=15min, idleTimeoutMs=30min.
- Ping `/_layout/tokenhtml` via `fetchAntiForgeryToken()` at the calculated interval
- Only ping when the user is authenticated (`isAuthenticated()`)
- Only ping when the browser tab is visible (`document.visibilityState !== 'hidden'`)
- Track user activity (mouse, keyboard, touch, scroll) and stop pinging after `idleTimeoutMs` of idle - let the session expire naturally for security
- Detect session expiry: if the ping fails, call `onSessionExpired` callback so the app can redirect to login with `?sessionExpired=true`
- Skip entirely in development mode (no real session to keep alive)

Integrate the hook into the Layout component so it runs on every page. Pass an `onSessionExpired` callback that navigates to `/login?sessionExpired=true`. The login page already handles `?sessionExpired=true` via `getSessionExpiredMessage()`.
For Astro client-side navigation, initialize on `astro:page-load` and dispose timers/listeners on `astro:before-swap`; initialize once on ordinary full-page loads.
Make initialization idempotent and remove all activity listeners and intervals on disposal, so navigation cannot accumulate duplicate pings.
Use the same authentication, visibility, activity and localhost gates as the other frameworks.

**Session / Cookie settings** (all providers):

| Setting | Description | Default |
|---------|-------------|---------|
| `Authentication/ApplicationCookie/ExpireTimeSpan` | Session timeout duration (e.g., `01:00:00` for 1 hour); read an existing setting before deriving keepalive | `24:00:00` |
| `Authentication/ApplicationCookie/SlidingExpiration` | Renew cookie on each request | `true` |
| `Authentication/ApplicationCookie/AbsoluteSlidingExpireTimeSpan` | Absolute maximum session lifetime regardless of activity | None |
| `Authentication/ApplicationCookie/CookieName` | Custom session cookie name | Power Pages default |
| `Authentication/ApplicationCookie/CookieDomain` | Cookie domain scope | Current domain |
| `Authentication/ApplicationCookie/CookiePath` | Cookie path scope | `/` |
| `Authentication/ApplicationCookie/CookieHttpOnly` | Prevent JavaScript access to the session cookie | `true` |
| `Authentication/ApplicationCookie/CookieSecure` | Require HTTPS for the session cookie | `true` |
| `Authentication/ApplicationCookie/LoginPath` | Custom login page path | `/Account/Login/Login` |
| `Authentication/ApplicationCookie/SecurityStampValidator/ValidateInterval` | Interval to validate the user's security stamp (e.g., `00:30:00`) | Default |

**Global auth toggles** (all providers):

| Setting | Description | Default |
|---------|-------------|---------|
| `Authentication/Registration/LoginButtonAuthenticationType` | Default provider for the login button | None (shows all) |
| `Authentication/Registration/AzureADLoginEnabled` | Enable/disable Azure AD (Entra ID) login | `true` |
| `Authentication/Registration/ExternalLoginEnabled` | Enable/disable all external identity provider login | `true` |
| `Authentication/Registration/SignOutEverywhereEnabled` | On logout, invalidate all sessions across all devices by updating the user's security stamp | `false` |

For each setting the user wants to configure, create the site setting using `create-site-setting.js` during Phase 8.1 alongside the required settings.

## Session KeepAlive for SPA Sites

In SPAs, page navigation is client-side - no server requests are made. The session cookie's `SlidingExpiration` only renews when the browser sends a request to the server. Without a keepalive, the session silently expires even while the user is actively using the SPA.

### Provider-agnostic by design

The keepalive operates on the **Power Pages `ApplicationCookie`** - the same session cookie that's issued for every authenticated user regardless of provider (local password, Entra External ID, generic OIDC, SAML2, social). The hook calls `isAuthenticated()` which reads from `window.Microsoft.Dynamic365.Portal.User`, populated for any signed-in user. No provider-specific branches are needed.

| Layer | Local auth | External auth (Entra External ID, OIDC, SAML2, social) |
|---|---|---|
| Session cookie | `ApplicationCookie` set by server on `/SignIn` POST | `ApplicationCookie` set by server on `/Account/Login/ExternalLoginCallback` |
| Ping endpoint | `/_layout/tokenhtml` (refreshes the cookie via OWIN middleware) | Same |
| Activity tracking | Mouse / keyboard / touch / scroll | Same |
| On expiry | Redirect to `/login?sessionExpired=true` → user re-enters email/password | Redirect to `/login?sessionExpired=true` → user clicks external provider button → IdP round-trip (silent if IdP SSO is still valid) → back in |

### Two independent clocks for external providers

External providers add a second token lifetime to be aware of:

1. **Power Pages `ApplicationCookie`** - what this keepalive touches. Controlled by `Authentication/ApplicationCookie/ExpireTimeSpan` site setting.
2. **IdP token** (Entra External ID ID token / refresh token, etc.) - controlled entirely by the IdP. Power Pages does NOT re-verify with the IdP on every request; once the session cookie is issued post-callback, it's independent of the IdP token.

What this means in practice:
- **Power Pages session expires, IdP token still valid** (common): user redirected to `/login?sessionExpired=true` → clicks external provider button → IdP responds silently (SSO cookie still valid in browser) → new Power Pages session issued. No credential re-entry. Smooth UX.
- **IdP token expires, Power Pages session still valid**: user keeps using the site fine - Power Pages doesn't care about the IdP token after the initial sign-in.

The keepalive is responsible for the first clock only. The IdP's own session management handles the second.

### Detection limitation

`/_layout/tokenhtml` is **anonymous-accessible** by design - it's the endpoint the unauthenticated login form uses to fetch an anti-forgery token. When the Power Pages session expires server-side, the next `fetchAntiForgeryToken()` call **may still succeed** (returns an anonymous-context token), and the hook's catch block won't fire. `onSessionExpired` won't run.

In practice, this means the keepalive is **highly effective at PREVENTING expiry** (by touching the cookie before it expires) but **less reliable at DETECTING expiry** once it has happened.

Robust expiry detection in the field typically happens when:
- The user attempts a protected action (e.g., data fetch via the WebAPI client from `/integrate-webapi`) → server returns 401 → SPA catches and redirects to `/login?sessionExpired=true`
- The user reloads the page → SPA reads `window.Microsoft.Dynamic365.Portal.User` → empty → effectively logged out

If your site uses the WebAPI client from the `/integrate-webapi` skill, that client treats 401 as a session-expired signal and triggers the same redirect. The two mechanisms together (keepalive prevention + WebAPI 401 detection) give the best practical coverage.

This limitation applies equally to local and external auth - it's a property of the cookie-based session model + the choice of `/_layout/tokenhtml` as the ping endpoint, not a provider issue. Switching to an authenticated-only ping endpoint would catch expiry reliably but Power Pages doesn't expose a built-in "is my session valid?" endpoint; building one would require server-side custom code (out of scope for this skill).

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
- Smallest response (~200-300 bytes - just an anti-forgery token `<input>` tag)
- Low server cost (no Dataverse queries, no template rendering)
- Renews the session cookie via OWIN middleware
- Already used by the auth service for CSRF tokens
- No dedicated health/ping endpoint exists in Power Pages

---
